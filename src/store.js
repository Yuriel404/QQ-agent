// 每个会话（group:xxx / private:xxx）采用分页 JSON 存档。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import { ChatArchive, listArchivedChats } from './chat-archive.js';

function isUnread(row) { return !row.self && !row.read; }

function findEntry(archive, predicate, localId) {
  for (const [index, page] of archive.pages.entries()) {
    if (localId !== undefined && (localId < page.firstId || localId > page.lastId)) continue;
    const rows = archive.read(page);
    const entry = rows.find(predicate);
    if (entry) return { index, rows, entry };
  }
  return null;
}

function findMid(archive, mid) {
  const target = String(mid);
  return findEntry(archive, (row) => String(row.mid) === target);
}

function updateReadState(archive, selectPage, change) {
  let changed = 0;
  for (const [index, page] of archive.pages.entries()) {
    if (!selectPage(page)) continue;
    const rows = archive.read(page);
    let modified = false;
    for (const row of rows) {
      if (change(row)) { changed++; modified = true; }
    }
    if (modified) archive.replace(index, rows);
  }
  archive.commit();
  return changed;
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.setMaxPerChat(maxPerChat);
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  listChats() { return listArchivedChats(); }

  getChatMeta(chatKey) {
    const { total, unread, lastTs, lastText } = new ChatArchive(chatKey).meta;
    return { chatKey, total, unread, lastTs, lastText };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [] }) {
    const entry = {
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标，判定层回落文本匹配。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
      // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
    };
    return new ChatArchive(chatKey).append(entry, this.maxPerChat);
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const entry = {
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    return new ChatArchive(chatKey).append(entry, this.maxPerChat);
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    return this.drainUnreadFrom(chatKey, -Infinity).batch;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const batch = [];
    let archived = 0;
    updateReadState(new ChatArchive(chatKey), (page) => page.pending > 0, (row) => {
      if (row.read) return false;
      if (!row.self) {
        if (row.ts >= fromTs) batch.push(row);
        else archived++;
      }
      row.read = true;
      return true;
    });
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    return updateReadState(new ChatArchive(chatKey), (page) => page.unread > 0, (row) => {
      if (!isUnread(row)) return false;
      row.read = true;
      return true;
    });
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  markEntryRead(chatKey, id) {
    const archive = new ChatArchive(chatKey);
    const hit = findEntry(archive, (row) => row.id === id, id);
    if (!hit || !isUnread(hit.entry)) return false;
    hit.entry.read = true;
    archive.replace(hit.index, hit.rows);
    archive.commit();
    return true;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const start = Number(startedAt) - 5 * 60 * 1000;
    const end = Number(endedAt || startedAt) + 1000;
    return updateReadState(new ChatArchive(chatKey), (p) => p.maxTs >= start && p.minTs <= end, (row) => {
      if (row.self || !row.read || !(row.ts >= start && row.ts <= end)) return false;
      row.read = false;
      return true;
    });
  }

  unreadCount(chatKey) { return new ChatArchive(chatKey).meta.unread; }

  peekUnread(chatKey, limit = 3) {
    const archive = new ChatArchive(chatKey);
    const max = Math.floor(Math.max(1, Number(limit) || 3));
    const result = [];
    for (const page of archive.pages) {
      if (!page.unread) continue;
      for (const row of archive.read(page)) {
        if (isUnread(row)) result.push(row);
        if (result.length >= max) return result;
      }
    }
    return result;
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const archive = new ChatArchive(chatKey);
    let skip = Math.ceil(Math.max(0, Number(offset) || 0));
    const max = Math.floor(Math.max(1, Number(limit) || 1));
    const result = [];
    for (let i = archive.pages.length - 1; i >= 0; i--) {
      const page = archive.pages[i];
      const count = includeSelf ? page.count : page.incoming;
      if (skip >= count) { skip -= count; continue; }
      const rows = archive.read(page);
      for (let j = rows.length - 1; j >= 0; j--) {
        if (!includeSelf && rows[j].self) continue;
        if (skip) { skip--; continue; }
        result.push(rows[j]);
        if (result.length >= max) return result.reverse();
      }
    }
    return result.reverse();
  }

  findByMid(chatKey, mid) {
    return findMid(new ChatArchive(chatKey), mid)?.entry ?? null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const archive = new ChatArchive(chatKey);
    const hit = findMid(archive, mid);
    if (!hit) return false;
    hit.entry.recalled = true;
    hit.entry.read = true;
    archive.replace(hit.index, hit.rows);
    archive.commit();
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * 模型和存档页都能直接读取展开内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const archive = new ChatArchive(chatKey);
    const hit = findMid(archive, mid);
    if (!hit) return false;
    const m = hit.entry;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    archive.replace(hit.index, hit.rows);
    archive.commit();
    return true;
  }

  findByLocalId(chatKey, localId) {
    const id = Number(localId);
    return findEntry(new ChatArchive(chatKey), (row) => row.id === id, id)?.entry ?? null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const ids = (Array.isArray(localIds) ? localIds : [localIds]).map(Number).filter(Number.isFinite);
    if (!ids.length) return 0;
    ids.sort((a, b) => b - a);
    const archive = new ChatArchive(chatKey);
    let cursor = 0, removed = 0;
    for (let i = archive.pages.length - 1; i >= 0 && cursor < ids.length; i--) {
      const page = archive.pages[i];
      while (cursor < ids.length && ids[cursor] > page.lastId) cursor++;
      const matching = new Set();
      while (cursor < ids.length && ids[cursor] >= page.firstId) matching.add(ids[cursor++]);
      if (!matching.size) continue;
      const remaining = archive.read(page).filter((row) => !matching.has(row.id));
      if (remaining.length !== page.count) {
        removed += page.count - remaining.length;
        archive.replace(i, remaining);
      }
    }
    archive.commit();
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const archive = new ChatArchive(chatKey);
    const removed = archive.meta.total;
    while (archive.pages.length) archive.replace(archive.pages.length - 1, []);
    archive.commit();
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const archive = new ChatArchive(chatKey);
    const map = new Map();
    for (const page of archive.pages) {
      if (!page.incoming) continue;
      for (const m of archive.read(page)) {
        if (m.self) continue;
        const prev = map.get(m.senderId);
        if (!prev || prev.lastTs < m.ts) {
          map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
        } else {
          prev.count += 1;
        }
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }
}
