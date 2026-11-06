function realKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key === '******' ? '' : key;
}

// 路径和查询串可能区分租户；仅将路径的末尾斜线视为等价。
export function normalizeProviderEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return '';
  }
}

export function sameProviderEndpoint(left, right) {
  const endpoint = normalizeProviderEndpoint(left);
  return Boolean(endpoint) && endpoint === normalizeProviderEndpoint(right);
}

export function providerKeyValue(provider, cfg) {
  if (!provider) return '';
  const owner = cfg.providers?.find((entry) => entry.id === provider.id);
  const mapped = owner && sameProviderEndpoint(owner.baseURL, provider.baseURL)
    ? realKey(cfg.dshProviderKeys?.[provider.id]) : '';
  return mapped || realKey(provider.apiKey);
}

/** 表单中显式输入的 Key 属于本次请求；保存的 Key 必须属于目标提供商和端点。 */
export function resolveProviderRequest(cfg, { providerId, baseUrl, apiKey } = {}) {
  const id = String(providerId || cfg.api?.provider || '').trim();
  const provider = id ? cfg.providers?.find((entry) => entry.id === id) : null;
  const savedUrl = id ? provider?.baseURL : cfg.api?.baseUrl;
  const target = String(baseUrl || savedUrl || '').trim();
  const savedKey = sameProviderEndpoint(target, savedUrl)
    ? (id ? providerKeyValue(provider, cfg) : realKey(cfg.api?.apiKey))
    : '';
  return { baseUrl: target, apiKey: realKey(apiKey) || savedKey };
}
