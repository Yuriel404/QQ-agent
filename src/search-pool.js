import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { searchProviderDefaultKey, searchProviderEndpoint, searchProviderSupportsKeys } from './search-provider-info.js';
import { todayKey } from './util.js';

const file = path.join(DATA_DIR, 'search-pool.json');
const periods = ['day', 'month', 'total'];
const maxEntries = 256;

function windowFor(period) {
  if (period === 'total') return 'total';
  const day = todayKey();
  return period === 'month' ? day.slice(0, 7) : day;
}

function readPool() {
  let raw;
  try {
    const stat = fs.statSync(file);
    if (process.platform !== 'win32' && (stat.mode & 0o077)) fs.chmodSync(file, 0o600);
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: false, chain: [], failureThreshold: 3, keys: [], cursors: {} };
    throw new Error('无法读取搜索池配置');
  }
  try {
    const pool = JSON.parse(raw);
    if (typeof pool.enabled !== 'boolean' || !Array.isArray(pool.chain) || !Array.isArray(pool.keys)
        || !pool.cursors || !Number.isInteger(pool.failureThreshold)) throw new Error();
    for (const key of pool.keys) {
      if (!periods.includes(key.period) || !Number.isSafeInteger(key.used) || !key.endpoint) throw new Error();
      const window = windowFor(key.period);
      if (key.window !== window) {
        key.window = window;
        key.used = 0;
        key.remoteExhausted = false;
      }
    }
    return pool;
  } catch {
    // JSON 解析错误可能包含密钥片段，不能回显原始错误，也不能覆盖损坏的账本。
    throw new Error('搜索池配置损坏，请从备份恢复');
  }
}

function save(pool) {
  const tmp = path.join(DATA_DIR, `search-pool.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(pool), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理错误同样不得回显本地路径。 */ }
    throw new Error('无法保存搜索池配置');
  }
}

function bindingChanged(key) {
  return key.endpoint !== searchProviderEndpoint(key.provider)
    || Boolean(key.apiKey && !searchProviderSupportsKeys(key.provider));
}

function duplicateDefault(key, keys) {
  if (key.apiKey) return false;
  const token = searchProviderDefaultKey(key.provider);
  return Boolean(token && keys.some((item) => item.provider === key.provider && item.apiKey === token));
}

function status(key, changed, duplicate) {
  if (!key.enabled || changed || duplicate) return 'disabled';
  if (key.blocked) return 'failed';
  if (key.remoteExhausted || (key.quota > 0 && key.used >= key.quota)) return 'exhausted';
  return 'ready';
}

function publicView({ enabled, chain, failureThreshold, keys }) {
  return {
    enabled, chain, failureThreshold,
    keys: keys.map((key) => {
      const { id, provider, label, enabled, quota, period, used, failures } = key;
      const endpointChanged = bindingChanged(key);
      const duplicate = duplicateDefault(key, keys);
      return {
        id, provider, label, enabled, quota, period, used, failures,
        hasApiKey: Boolean(key.apiKey), endpointChanged, duplicateDefault: duplicate,
        status: status(key, endpointChanged, duplicate)
      };
    })
  };
}

export function getSearchPool() {
  return publicView(readPool());
}

function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field}超出范围`);
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new Error('启用状态必须为布尔值');
  return value;
}

function endpointFor(provider) {
  const endpoint = typeof provider === 'string' && searchProviderEndpoint(provider);
  if (!endpoint) throw new Error('搜索服务不存在或尚未配置接口地址');
  return endpoint;
}

function editKey(pool, key, patch) {
  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || patch.label.length > 120) throw new Error('名称最长 120 字符');
    key.label = patch.label.trim();
  }
  if (patch.quota !== undefined) key.quota = integer(patch.quota, 0, Number.MAX_SAFE_INTEGER, '额度');
  if (patch.period !== undefined && patch.period !== key.period) {
    if (!periods.includes(patch.period)) throw new Error('额度周期必须是 day、month 或 total');
    key.period = patch.period;
    // 换周期保留已用量，直到下一周期或管理员明确重置。
    key.window = windowFor(key.period);
  }
  if (patch.enabled !== undefined) key.enabled = boolean(patch.enabled);
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 8192 || /[\r\n]/.test(patch.apiKey)) {
      throw new Error('搜索密钥无效');
    }
    const secret = patch.apiKey.trim();
    if (secret && !searchProviderSupportsKeys(key.provider)) throw new Error('该服务仅支持默认凭据');
    const others = pool.keys.filter((k) => k.id !== key.id && k.provider === key.provider);
    if (!secret && others.some((k) => !k.apiKey)) throw new Error('该服务已添加默认凭据');
    const defaultKey = searchProviderDefaultKey(key.provider);
    if (others.some((k) => (k.apiKey || defaultKey) === (secret || defaultKey))) {
      throw new Error('该服务已添加相同密钥');
    }
    const endpoint = endpointFor(key.provider);
    if (secret !== key.apiKey || endpoint !== key.endpoint) {
      key.apiKey = secret;
      key.endpoint = endpoint;
      key.generation = randomUUID();
      key.failures = 0;
      key.blocked = false;
      key.remoteExhausted = false;
    }
  }
}

export function updateSearchPool(command) {
  const pool = readPool();
  if (command?.action === 'configure') {
    if (command.enabled !== undefined) pool.enabled = boolean(command.enabled);
    if (command.chain !== undefined) {
      const chain = command.chain;
      if (command.expectedChain !== undefined && JSON.stringify(command.expectedChain) !== JSON.stringify(pool.chain)) {
        throw new Error('服务顺序已在其他窗口更改，请刷新状态后重试');
      }
      if (!Array.isArray(chain) || chain.length > maxEntries || new Set(chain).size !== chain.length) {
        throw new Error('服务顺序必须为不重复的服务列表');
      }
      // 已删除的自定义服务仍可从旧顺序中逐一移出。
      for (const provider of chain) if (!pool.chain.includes(provider)) endpointFor(provider);
      pool.chain = [...chain];
    }
    if (command.failureThreshold !== undefined) pool.failureThreshold = integer(command.failureThreshold, 1, 100, '失败阈值');
  } else if (command?.action === 'add') {
    if (pool.keys.length >= maxEntries) throw new Error('搜索池最多支持 256 项');
    const provider = command.provider;
    if (!pool.chain.includes(provider) && pool.chain.length >= maxEntries) throw new Error('服务顺序已满');
    const key = {
      id: randomUUID(), generation: randomUUID(), provider, endpoint: endpointFor(provider),
      apiKey: '', label: '', enabled: true, quota: 0, period: 'month', window: windowFor('month'),
      used: 0, failures: 0, blocked: false, remoteExhausted: false
    };
    editKey(pool, key, { ...command, apiKey: command.apiKey ?? '' });
    pool.keys.push(key);
    if (!pool.chain.includes(provider)) pool.chain.push(provider);
  } else {
    const key = pool.keys.find((item) => item.id === command?.id);
    if (!key) throw new Error('找不到搜索池记录');
    switch (command.action) {
      case 'edit':
        editKey(pool, key, command);
        break;
      case 'remove':
        pool.keys = pool.keys.filter((k) => k.id !== key.id);
        if (pool.cursors[key.provider] === key.id) delete pool.cursors[key.provider];
        break;
      case 'reset':
        key.generation = randomUUID();
        key.enabled = true;
        key.blocked = false;
        key.failures = 0;
        break;
      case 'resetUsage':
        key.generation = randomUUID();
        key.used = 0;
        key.remoteExhausted = false;
        break;
      default:
        throw new Error('未知的搜索池操作');
    }
  }
  save(pool);
  return publicView(pool);
}

// 单实例中，同步读取、选择和落盘之间没有 await。先记一次请求再访问上游，
// 并发请求和崩溃后的重试都不能重复消费最后一个额度。
function reserve(provider, candidates) {
  const pool = readPool();
  if (!pool.enabled || !pool.chain.includes(provider)) return null;
  const keys = pool.keys.filter((key) => key.provider === provider);
  const start = keys.findIndex((key) => key.id === pool.cursors[provider]) + 1;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length];
    if (!candidates.has(key.id) || status(key, bindingChanged(key), duplicateDefault(key, keys)) !== 'ready') continue;
    key.used += 1;
    pool.cursors[provider] = key.id;
    save(pool);
    return key;
  }
  return null;
}

function finish(lease, outcome) {
  const pool = readPool();
  const key = pool.keys.find((item) => item.id === lease.id && item.generation === lease.generation);
  if (!key || key.blocked) return;
  if (outcome === 'success') {
    if (!key.failures) return;
    key.failures = 0;
  } else if (outcome === 'quota') {
    if (key.window !== lease.window) return;
    key.remoteExhausted = true;
  } else {
    key.failures += 1;
    if (outcome === 'auth' || key.failures >= pool.failureThreshold) key.blocked = true;
  }
  save(pool);
}

export async function runSearchPool(query, dispatch, fallbackProvider, signal) {
  signal?.throwIfAborted();
  const pool = readPool();
  if (!pool.enabled) return dispatch(fallbackProvider, query, undefined, signal);
  const candidates = new Set(pool.keys.map((key) => key.id));
  for (const provider of pool.chain) {
    while (candidates.size) {
      signal?.throwIfAborted();
      const lease = reserve(provider, candidates);
      if (!lease) break;
      candidates.delete(lease.id);
      let result;
      try {
        result = await dispatch(provider, query, lease.apiKey || undefined, signal);
      } catch (error) {
        signal?.throwIfAborted();
        let outcome = 'temporary';
        if (error?.quotaExhausted === true) outcome = 'quota';
        else if (error?.status === 401 || error?.status === 403) outcome = 'auth';
        finish(lease, outcome);
        continue;
      }
      signal?.throwIfAborted();
      finish(lease, 'success');
      return result;
    }
  }
  throw new Error('搜索池没有可用凭据或本轮请求均失败，请检查服务顺序、额度和凭据状态');
}
