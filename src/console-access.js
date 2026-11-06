import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CONSOLE_USER = 'admin';
export const CONSOLE_REALM = 'QQ Agent';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export function createConsoleAccess(getServerConfig, env = process.env) {
  const config = getServerConfig();
  const host = env.QQ_AGENT_HOST || config.host || '127.0.0.1';
  const local = LOOPBACK.has(host);
  const configuredToken = () => String(env.QQ_AGENT_CONSOLE_TOKEN || getServerConfig().token || '');
  if (!local && configuredToken().trim().length < 32) {
    throw new Error('监听非回环地址需要至少 32 字符的 QQ_AGENT_CONSOLE_TOKEN 或 server.token');
  }
  const generatedToken = randomBytes(32).toString('base64url');
  const origins = new Set();
  const rawOrigins = env.QQ_AGENT_ALLOWED_ORIGINS?.split(',') ?? config.allowedOrigins ?? [];
  if (!Array.isArray(rawOrigins)) throw new Error('server.allowedOrigins 必须是来源数组');
  for (const item of rawOrigins) {
    if (!String(item).trim()) continue;
    const url = new URL(String(item).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' ||
        url.search || url.hash || url.username || url.password || url.hostname.includes('*')) {
      throw new Error('可信来源必须是完整的 HTTP(S) 来源，例如 https://bot.example.org');
    }
    origins.add(url.origin);
  }

  function token() {
    const saved = configuredToken();
    // 运行时清空令牌也不能使已发布的监听器退回匿名访问。
    if (local) return saved || generatedToken;
    return saved.trim().length >= 32 ? saved : null;
  }

  function trustedRequest(req, apiRequest) {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    // 不采信客户端可伪造的 Forwarded / X-Forwarded-*。反代必须保留外部 Host。
    if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/.test(hostHeader)) return false;
    const matchesHost = (origin) => {
      const { protocol } = new URL(origin);
      return origin === new URL(protocol + '//' + hostHeader).origin;
    };
    try {
      const loopback = LOOPBACK_HOST.test(hostHeader);
      if (!loopback && ![...origins].some(matchesHost)) return false;
      if (!apiRequest) return true;
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
      for (const source of [req.headers.origin, req.headers.referer]) {
        if (!source) continue;  // 原生 API 客户端可以没有这些头，仍须出示凭据
        const { origin, protocol } = new URL(source);
        if (!['http:', 'https:'].includes(protocol) || !matchesHost(origin) ||
            !(origins.has(origin) || (loopback && protocol === 'http:'))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function authorized(req) {
    const expected = token();
    if (!expected) return false;
    let supplied = req.headers['x-console-token'];
    if (!supplied) {
      const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
      if (!basic) return false;
      const pair = Buffer.from(basic[1], 'base64').toString('utf8');
      if (!pair.startsWith(CONSOLE_USER + ':')) return false;
      supplied = pair.slice(CONSOLE_USER.length + 1);
    }
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  return { host, token, authorized, trustedRequest, generated: !configuredToken() };
}
