/** 入站消息、跨会话工具和控制台试发使用相同的会话权限。 */
export function isChatAllowed(kind, id, cfg) {
  if (!['private', 'group'].includes(kind) || !/^\d+$/.test(String(id))) return false;
  const deny = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  const allow = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (!Array.isArray(deny) || !Array.isArray(allow)) return false;
  const matches = (entry) => String(entry) === String(id);
  if (deny.some(matches)) return false;
  return allow.length ? allow.some(matches) : cfg.allowAllWhenEmpty === true;
}
