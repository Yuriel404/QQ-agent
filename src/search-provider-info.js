import { DEFAULT_CONFIG, getConfig } from './config.js';
import { normalizeProviderEndpoint, sameProviderEndpoint } from './provider-credentials.js';

const names = {
  bing: 'Bing 网页解析',
  tavily: 'Tavily Search',
  deepseek: 'DeepSeek 原生搜索',
  zhipu: '智谱 Web Search',
  bocha: '博查 AI Search',
  baidu: '百度千帆 AI Search',
  metaso: '秘塔 AI 搜索'
};

const keyEnv = {
  deepseek: 'DEEPSEEK_API_KEY', zhipu: 'ZHIPU_API_KEY', bocha: 'BOCHA_API_KEY',
  baidu: 'BAIDU_SEARCH_API_KEY', metaso: 'METASO_API_KEY', tavily: 'TAVILY_API_KEY'
};

function customProvider(provider, search) {
  if (provider === 'custom') return search.custom;
  if (typeof provider !== 'string' || !provider.startsWith('custom:')) return undefined;
  const id = provider.slice(7);
  return Array.isArray(search.providers) ? search.providers.find((entry) => String(entry?.id) === id) : undefined;
}

// 搜索适配器和池内去重共用此解析逻辑。环境密钥仅用于该服务的官方端点。
export function searchProviderDefaultKey(provider, config = getConfig()) {
  const search = config.webSearch || {};
  if (!Object.hasOwn(keyEnv, provider)) {
    const entry = customProvider(provider, search);
    return entry && String(entry.type || 'openai').toLowerCase() !== 'bing' ? String(entry.apiKey || '').trim() : '';
  }
  const cfg = search[provider] || {};
  if (cfg.apiKey) return String(cfg.apiKey).trim();
  const official = DEFAULT_CONFIG.webSearch[provider].baseUrl;
  return sameProviderEndpoint(cfg.baseUrl || official, official) ? String(process.env[keyEnv[provider]] || '').trim() : '';
}

// 绑定完整请求地址，避免改域名或同域下的租户路径后仍携带原 Key。
export function searchProviderEndpoint(provider, config = getConfig()) {
  const search = config.webSearch || {};
  let endpoint;
  if (provider === 'bing') {
    endpoint = search.searchUrl || DEFAULT_CONFIG.webSearch.searchUrl;
  } else if (Object.hasOwn(names, provider)) {
    endpoint = search[provider]?.baseUrl || DEFAULT_CONFIG.webSearch[provider].baseUrl;
  } else {
    endpoint = customProvider(provider, search)?.baseUrl;
  }
  return normalizeProviderEndpoint(endpoint);
}

export function searchProviderSupportsKeys(provider, config = getConfig()) {
  if (Object.hasOwn(names, provider)) return provider !== 'bing';
  const entry = customProvider(provider, config.webSearch || {});
  return Boolean(entry) && String(entry.type || 'openai').toLowerCase() !== 'bing';
}

export function listSearchPoolProviders(config = getConfig()) {
  const search = config.webSearch || {};
  const items = Object.entries(names).map(([id, name]) => ({ id, name }));
  if (search.custom?.baseUrl) items.push({ id: 'custom', name: search.custom.name || '自定义搜索' });
  for (const entry of Array.isArray(search.providers) ? search.providers : []) {
    if (entry?.id) items.push({ id: 'custom:' + entry.id, name: entry.name || String(entry.id) });
  }
  return items.map((item) => ({ ...item, supportsKeys: searchProviderSupportsKeys(item.id, config) }));
}
