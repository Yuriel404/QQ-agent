import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-message-search-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { listAvailableTools } = await import('../src/tool-registry.js');
const config = structuredClone(DEFAULT_CONFIG);
config.allow = { groups: [100, 101, 102], private: [200] };
setRuntimeConfig(config);
const store = new ChatStore();
const defs = buildToolDefs();
const group = 'group:100';
const peer = 'private:200';
const dayStart = new Date(2026, 0, 15).getTime();
const dayEnd = new Date(2026, 0, 16).getTime() - 1;

function incoming(chatKey, mid, ts, senderId, text) {
  store.appendIncoming(chatKey, { mid, ts, senderId, senderName: '成员' + senderId, text });
}

function call(chatKey, args, tool = 'search_messages') {
  return executeTool(defs, { chatKey, store, session: {} }, tool, JSON.stringify(args));
}

async function search(chatKey, args) {
  const result = await call(chatKey, args);
  assert.ok(!result.isError, result.content);
  return JSON.parse(result.content);
}

function mids(page) {
  return page.messages.map(row => row.messageId);
}

function configureFor(t) {
  const cfg = structuredClone(config);
  setRuntimeConfig(cfg);
  t.after(() => setRuntimeConfig(config));
  return cfg;
}

test('检索当前会话的原文，关键词按字面匹配且忽略大小写，排除撤回消息', async () => {
  incoming(group, -1, dayStart - 1, '301', '昨晚提到 Docker.*');
  incoming(group, 2, dayStart, '301', '安排 DOCKER.* 部署');
  incoming(group, 3, dayStart + 1, '302', 'Docker 日志');
  incoming(group, 4, dayEnd, '302', '今天处理 docker.*');
  incoming(group, 5, dayEnd + 1, '301', '明天操作 Docker.*');
  incoming(group, 6, dayEnd + 2, '301', '已撤回 Docker.*');
  store.markRecalled(group, 6);
  store.appendSelf(group, { mid: 7, ts: dayStart + 2, text: '我来部署' });
  incoming(group, 8, dayEnd, '302', '日志在 C:\\[cache]\\app');
  incoming(peer, 1000, dayStart, '301', '私聊 Docker.*');
  const unread = store.unreadCount(group);

  const result = await search(group, { query: 'docker.*' });
  assert.deepEqual(mids(result), [5, 4, 2, -1]);
  assert.equal(result.nextCursor, null);
  const message = result.messages.find(row => row.messageId === 2);
  assert.equal(message.senderId, '301');
  assert.ok(message.sender.includes('成员301'));
  assert.ok(message.time);
  assert.equal(message.text, '安排 DOCKER.* 部署');
  assert.deepEqual(mids(await search(peer, { query: 'docker.*' })), [1000]);
  assert.deepEqual(mids(await search(group, { query: '私聊' })), []);
  assert.deepEqual(mids(await search(group, { query: '\\[cache]\\' })), [8]);
  assert.equal(store.unreadCount(group), unread);

  const date = { startTime: '2026-01-15', endTime: '2026-01-15' };
  assert.deepEqual(mids(await search(group, { query: 'Docker', ...date })), [4, 3, 2]);
  assert.deepEqual(mids(await search(group, { query: 'Docker', senderId: '301', ...date })), [2]);
  assert.deepEqual(mids(await search(group, { senderId: 'self' })), [7]);
  const instant = new Date(dayEnd).toISOString();
  assert.deepEqual(mids(await search(group, { startTime: instant, endTime: instant })), [8, 4]);
});

test('分页搜索旧单文件存档，新增消息或删除上一页末条后仍可继续查找', async () => {
  const oldChat = 'group:101';
  const messages = Array.from({ length: 270 }, (_, index) => ({
    id: index + 1, mid: -index - 1, ts: dayStart + index, senderId: '201', senderName: '成员',
    text: [0, 129, 268].includes(index) ? '匹配到的记录' : '普通记录', self: false, read: true
  }));
  fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'messages', 'group_101.json'), JSON.stringify({ chatKey: oldChat, messages }));
  const filter = { query: '匹配', limit: 1 };
  const first = await search(oldChat, filter);
  assert.deepEqual(mids(first), [-269]);
  assert.ok(Number.isSafeInteger(first.nextCursor) && first.nextCursor > 0);
  incoming(oldChat, -271, dayEnd, '201', '刚到的新匹配');
  assert.equal(store.removeByLocalIds(oldChat, [269]), 1);
  const second = await search(oldChat, { ...filter, cursor: first.nextCursor });
  assert.deepEqual(mids(second), [-130]);
  const last = await search(oldChat, { ...filter, cursor: second.nextCursor });
  assert.deepEqual(mids(last), [-1]);
  assert.equal(last.nextCursor, null);
});

test('拒绝空条件、无效时间、分页参数和格式错误的会话标识', async () => {
  for (const args of [
    {}, { query: '   ' }, { limit: 5 }, { query: 'a'.repeat(201) },
    { senderId: '小明' }, { startTime: '昨天' }, { endTime: '2026-02-30' },
    { startTime: '2026-01-16', endTime: '2026-01-15' },
    { query: 'a', limit: 0 }, { query: 'a', limit: 31 }, { query: 'a', limit: 1.5 },
    { query: 'a', cursor: -3 }, { query: 'a', cursor: 1.5 },
    { query: 'a', chatKey: '200' }, { query: 'a', chatKey: 'private:200/../../other' },
    { query: 'a', chatKey: 200 }, { query: 'a', targetChatKey: peer }
  ]) {
    const result = await call(group, args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
});

test('群聊与私聊互查，按目标翻页和回读原文，相同 QQ 消息 ID 不串会话', async t => {
  const cfg = configureFor(t);
  cfg.tools.crossChatSend = false;
  cfg.skills['cross-chat-memory'] = { enabled: false };
  const query = '异地查档';
  incoming(group, 7001, dayStart, '303', query + '：群里发的');
  incoming(peer, 7001, dayStart, '200', query + '：私聊发的');
  incoming(peer, 7002, dayEnd, '200', query + '：私聊第二条');

  const local = await search(group, { query });
  assert.equal(local.chatKey, group);
  assert.deepEqual(mids(local), [7001]);
  const filter = { query, chatKey: peer, limit: 1 };
  const page = await search(group, filter);
  assert.equal(page.chatKey, peer);
  assert.deepEqual(mids(page), [7002]);
  assert.ok(Number.isSafeInteger(page.nextCursor) && page.nextCursor > 0);
  const more = await search(group, { ...filter, cursor: page.nextCursor });
  assert.equal(more.chatKey, peer);
  assert.deepEqual(mids(more), [7001]);
  assert.deepEqual(mids(await search(peer, { query, chatKey: group })), [7001]);
  const detail = await call(group, { chatKey: peer, messageId: 7001 }, 'get_message_detail');
  assert.ok(!detail.isError, detail.content);
  assert.equal(JSON.parse(detail.content).text, query + '：私聊发的');
  const own = await call(group, { messageId: 7001 }, 'get_message_detail');
  assert.equal(JSON.parse(own.content).text, query + '：群里发的');

  cfg.tools.overrides.search_messages = false;
  assert.equal((await call(group, filter)).isError, true);
  assert.equal((await call(group, { chatKey: peer, messageId: 7001 }, 'get_message_detail')).isError, true);
  assert.ok(!(await call(group, { messageId: 7001 }, 'get_message_detail')).isError);
});

test('目录和读取权限按当前白名单、拒绝名单及全局屏蔽名单生效', async t => {
  const cfg = configureFor(t);
  cfg.allow = { groups: [801, 802], private: [810, 811, 812] };
  cfg.deny = { groups: [802], private: [811] };
  cfg.globalBlocklist = ['812'];
  cfg.tools.crossChatSend = false;
  cfg.skills['cross-chat-memory'] = { enabled: false };
  const source = 'private:810';
  const target = 'group:801';
  const excluded = ['group:802', 'group:803', 'private:811', 'private:812', 'private:813'];
  for (const key of [source, target, ...excluded]) incoming(key, 8000, dayStart, '800', '查找目录');
  const directory = async () => {
    const result = await call(source, {}, 'get_chats');
    assert.ok(!result.isError, result.content);
    return JSON.parse(result.content).chats.map(chat => chat.chatKey).sort();
  };
  assert.deepEqual(await directory(), [target, source].sort());
  for (const chatKey of excluded) {
    assert.equal((await call(source, { query: '查找目录', chatKey })).isError, true, chatKey);
    assert.equal((await call(source, { messageId: 8000, chatKey }, 'get_message_detail')).isError, true, chatKey);
    assert.equal((await call(chatKey, { query: '查找目录', chatKey: target })).isError, true, chatKey);
  }
  cfg.tools.overrides.search_messages = false;
  assert.deepEqual(await directory(), [source]);
  cfg.tools.overrides.search_messages = true;
  cfg.allow.groups = [];
  cfg.allowAllWhenEmpty = false;
  assert.equal((await call(source, { chatKey: target, query: '查找目录' })).isError, true);
  cfg.allowAllWhenEmpty = true;
  assert.deepEqual(mids(await search(source, { chatKey: target, query: '查找目录' })), [8000]);
  assert.equal((await call(source, { chatKey: excluded[0], query: '查找目录' })).isError, true);
});

test('检索与指定 ID 读原文都遵守当前群、来源群及全局发送者屏蔽和撤回状态', async t => {
  const cfg = configureFor(t);
  const source = 'group:901';
  const target = 'group:902';
  cfg.allow.groups = [901, 902];
  const query = '发言人过滤';
  for (const id of [911, 912, 913, 914, 915]) incoming(target, id, dayStart, String(id), query);
  store.markRecalled(target, 915);
  cfg.blocklist = { 901: ['911'], 902: ['912'] };
  cfg.globalBlocklist = ['913'];
  store.appendSelf(target, { mid: 916, ts: dayEnd, text: query });
  assert.deepEqual(mids(await search(source, { query, chatKey: target })), [916, 914]);
  for (const messageId of [911, 912, 913, 915]) {
    const denied = await call(source, { chatKey: target, messageId }, 'get_message_detail');
    assert.ok(denied.isError, String(messageId));
    assert.ok(!denied.content.includes(query));
  }
  const bot = await call(source, { chatKey: target, messageId: 916 }, 'get_message_detail');
  assert.equal(JSON.parse(bot.content).text, query);
});

test('长存档在扫描预算耗尽时返回可续查的空页，命中片段保留关键词', async () => {
  const chatKey = 'group:102';
  // 每页最多 128 条；唯一的命中位于最早一页。
  // İ 转小写会展开为两个码点，片段须按原文位置截取。
  const longText = 'İ'.repeat(900) + '待定位的关键词' + '后文'.repeat(500);
  const messages = Array.from({ length: 128 * 33 }, (_, n) => ({
    id: n + 1, mid: n + 501, ts: dayStart + n, senderId: '302', senderName: '成员',
    text: n === 0 ? longText : '普通消息', self: false, read: true
  }));
  fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'messages', 'group_102.json'), JSON.stringify({ chatKey, messages }));
  const query = '待定位的关键词';
  const first = await search(chatKey, { query });
  assert.deepEqual(first.messages, []);
  assert.ok(Number.isSafeInteger(first.nextCursor) && first.nextCursor > 0);
  const last = await search(chatKey, { query, cursor: first.nextCursor });
  assert.deepEqual(mids(last), [501]);
  assert.equal(last.nextCursor, null);
  assert.ok(last.messages[0].text.includes(query));
  assert.ok(last.messages[0].text.length < longText.length);
  const detail = await executeTool(defs, { chatKey, store }, 'get_message_detail', JSON.stringify({ messageId: 501 }));
  assert.equal(JSON.parse(detail.content).text, longText);
});

test('消息检索随消息查询分类及单工具开关生效，关闭联网搜索仍可用', () => {
  const exposed = toolsCfg => listAvailableTools({ toolsCfg, searchEnabled: false })
    .some(tool => tool.id === 'search_messages');
  assert.equal(exposed(config.tools), true);
  assert.equal(exposed({ ...config.tools, categories: { query: false } }), false);
  assert.equal(exposed({ ...config.tools, overrides: { search_messages: false } }), false);
});
