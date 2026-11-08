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

/** 会话目录、共享记忆和定时唤醒统一排除被拒的会话及全局屏蔽的私聊对象。 */
export function isAccessibleChat(chatKey, cfg) {
  if (typeof chatKey !== 'string') return false;
  const match = /^(group|private):([1-9]\d{0,14})$/.exec(chatKey);
  if (!match || !isChatAllowed(match[1], match[2], cfg)) return false;
  return match[1] !== 'private' || !cfg.globalBlocklist?.some((id) => String(id) === match[2]);
}

/** 存档搜索和原文回读采用相同的撤回、发送者屏蔽规则。 */
export function isVisibleArchiveMessage(entry, blockedSenders) {
  return Boolean(entry && !entry.recalled && (entry.self || !blockedSenders?.has(String(entry.senderId))));
}
