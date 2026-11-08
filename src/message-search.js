import { getConfig } from './config.js';
import { isAccessibleChat } from './chat-access.js';
import { getToolAvailability } from './tool-registry.js';
const maxQueryLength = 200;
const maxResults = 30;
const defaultLimit = 10;
const timeFormat = 'YYYY-MM-DD、本地时间 YYYY-MM-DD HH:mm 或带时区的 ISO 时间';

export const archiveChatKeyParameter = {
  type: 'string',
  description: '要读取的会话，使用 get_chats 返回的 chatKey，例如 group:123456 或 private:789012。省略时使用当前会话。'
};

export const messageSearchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chatKey: archiveChatKeyParameter,
    query: { type: 'string', maxLength: maxQueryLength, description: '正文中连续出现的文字，忽略大小写，按字面匹配。' },
    senderId: { type: ['string', 'integer'], description: '发送者的 QQ 号；填 self 查询机器人发出的消息。' },
    startTime: { type: 'string', description: `含起点。支持${timeFormat}；单填日期从当天零点开始。` },
    endTime: { type: 'string', description: `含终点。支持${timeFormat}；单填日期包含当天整天。` },
    limit: { type: 'integer', minimum: 1, maximum: maxResults, description: `每次最多返回几条，默认 ${defaultLimit}。` },
    cursor: { type: 'integer', minimum: 1, description: '翻页时保留相同的 chatKey 和筛选条件，传入上次的 nextCursor。' }
  }
};

// 每次读取（包括翻页）都使用最新权限。单会话详情即使在搜索关闭时也可独立使用。
export function archiveReadScope(ctx, chatKey = ctx.chatKey, toolId = 'search_messages') {
  const cfg = getConfig();
  if (!isAccessibleChat(ctx.chatKey, cfg) || !isAccessibleChat(chatKey, cfg)) {
    throw new Error('当前会话或目标会话不可访问，请使用 get_chats 返回的 group:群号 或 private:QQ号。');
  }
  const options = { toolsCfg: cfg.tools, runtimeContext: ctx };
  const access = getToolAvailability(toolId, options);
  if (!access.enabled) throw new Error(access.reason);
  if (chatKey !== ctx.chatKey && toolId !== 'search_messages' && !getToolAvailability('search_messages', options).enabled) {
    throw new Error('跨会话读取消息需要启用「检索消息」。');
  }
  const blockedSenders = new Set((cfg.globalBlocklist || []).map(String));
  for (const key of new Set([ctx.chatKey, chatKey])) {
    if (key.startsWith('group:')) {
      for (const id of cfg.blocklist?.[key.slice(6)] || []) blockedSenders.add(String(id));
    }
  }
  return { chatKey, blockedSenders };
}

function timeBoundary(value, endOfDay) {
  if (value === undefined) return undefined;
  const parts = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
  if (parts) {
    const [, day, clock, zone = ''] = parts;
    // Date.parse 会把 2 月 30 日自动进位，须额外验证日历日期。
    const calendar = new Date(day + 'T00:00:00Z');
    const time = clock ?? (endOfDay ? '23:59:59.999' : '00:00:00');
    const ts = Date.parse(`${day}T${time}${zone}`);
    if (Number.isFinite(ts) && !time.startsWith('24:') && calendar.toISOString().slice(0, 10) === day) return ts;
  }
  throw new Error(`${endOfDay ? 'endTime' : 'startTime'} 无效，请使用${timeFormat}。`);
}

export function searchArchivedMessages(ctx, args) {
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(messageSearchParameters.properties, key)) throw new Error(`消息检索不支持参数 ${key}。`);
  }
  const { query = '', senderId, startTime, endTime, limit = defaultLimit, cursor } = args;
  if (typeof query !== 'string' || query.length > maxQueryLength * 2 || [...query].length > maxQueryLength) {
    throw new Error(`query 必须是最多 ${maxQueryLength} 个字符的文字。`);
  }
  const needle = query.trim();
  if (senderId !== undefined && senderId !== 'self' &&
      (!(typeof senderId === 'string' || Number.isSafeInteger(senderId)) || !/^\d{1,12}$/.test(String(senderId)))) {
    throw new Error('senderId 请填数字 QQ 号，或填 self 查询机器人。');
  }
  const fromTs = timeBoundary(startTime, false);
  const toTs = timeBoundary(endTime, true);
  if (!needle && senderId === undefined && fromTs === undefined && toTs === undefined) {
    throw new Error('至少提供关键词 query、发送者 senderId、开始时间 startTime 或结束时间 endTime 之一。');
  }
  if (fromTs > toTs) throw new Error('startTime 必须早于或等于 endTime。');
  if (!Number.isInteger(limit) || limit < 1 || limit > maxResults) throw new Error(`limit 必须是 1 到 ${maxResults} 之间的整数。`);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new Error('cursor 请使用上次返回的正整数 nextCursor。');

  const { chatKey, blockedSenders } = archiveReadScope(ctx, args.chatKey);
  const { messages, nextCursor } = ctx.store.searchMessages(chatKey, {
    query: needle, senderId: senderId === undefined ? undefined : String(senderId), fromTs, toTs, limit, beforeId: cursor, blockedSenders
  });
  return {
    chatKey,
    messages: messages.map(m => ({
      messageId: m.mid ?? null,
      time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false }),
      sender: m.self ? '我' : m.senderName,
      senderId: m.self ? 'self' : m.senderId,
      text: m.text
    })),
    nextCursor
  };
}
