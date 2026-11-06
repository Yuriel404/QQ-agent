import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-archive-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { ChatStore } = await import('../src/store.js');
const chat = 'group:123', messageDir = path.join(dir, 'messages');
const manifest = path.join(messageDir, 'group_123.json'), pages = path.join(messageDir, 'group_123.pages');
const store = new ChatStore();

try {
  fs.mkdirSync(messageDir);
  const previous = Array.from({ length: 310 }, (_, i) => ({
    id: i + 1, mid: -i - 1, ts: i + 100, self: i % 5 === 0, read: i % 3 === 0,
    senderId: String(i % 4), senderName: 'QQ', text: '长消息😀{}\\"'.repeat(50) + i,
    reply: { sender: '成员', text: '], [{"' }, media: [{ url: 'https://example.test' }]
  }));
  const old = '\uFEFF' + JSON.stringify({ chatKey: chat, nextLocalId: 401, messages: previous }, null, 1);
  fs.writeFileSync(manifest, old);
  const rename = fs.renameSync;
  function failCommit(operation) {
    fs.renameSync = (...args) => {
      if (args[1] === manifest) throw new Error('injected commit failure');
      return rename(...args);
    };
    try { assert.throws(operation, /injected commit failure/); }
    finally { fs.renameSync = rename; }
  }

  // An interrupted upgrade leaves the byte-for-byte original as the authority.
  failCommit(() => store.getChatMeta(chat));
  assert.equal(fs.readFileSync(manifest, 'utf8'), old);
  assert.equal(store.getChatMeta(chat).total, previous.length);
  assert.deepEqual(store.recent(chat, { limit: Infinity }), previous);
  const readManifest = () => JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const before = readManifest();
  assert.ok(before.pages.length >= 3);
  assert.deepEqual(fs.readdirSync(pages).sort(), before.pages.map((p) => p.file).sort());

  // Metadata and a normal append do not read the bodies of older pages.
  const read = fs.readFileSync, payloadReads = [];
  fs.readFileSync = (file, ...args) => {
    if (path.dirname(String(file)) === pages) payloadReads.push(path.basename(file));
    return read(file, ...args);
  };
  try {
    assert.deepEqual(store.listChats(), [chat]);
    assert.equal(store.unreadCount(chat), previous.filter((m) => !m.self && !m.read).length);
    assert.equal(store.getChatMeta(chat).lastText, previous.at(-1).text);
    assert.deepEqual(payloadReads, []);
    assert.equal(store.appendSelf(chat, { ts: 500, text: 'tail' }).id, 401);
    assert.ok(payloadReads.every((file) => file === before.pages.at(-1).file));
  } finally { fs.readFileSync = read; }
  const incoming = previous.filter((row) => !row.self);
  assert.deepEqual(store.recent(chat, { limit: 40, offset: 100, includeSelf: false }), incoming.slice(-140, -100));
  assert.deepEqual(store.peekUnread(chat, 150), incoming.filter((m) => !m.read).slice(0, 150));

  // An interrupted multi-page mutation exposes none of its partial updates.
  failCommit(() => store.markAllRead(chat));
  assert.deepEqual(new ChatStore().peekUnread(chat, Infinity), incoming.filter((m) => !m.read));
  assert.deepEqual(fs.readdirSync(pages).sort(), readManifest().pages.map((p) => p.file).sort());
  const drained = store.drainUnreadFrom(chat, 320);
  const fresh = incoming.filter((m) => !m.read && m.ts >= 320);
  assert.deepEqual(drained.batch.map((m) => m.id), fresh.map((m) => m.id));
  assert.ok(drained.batch.every((row) => row.read));
  assert.equal(drained.archived, incoming.filter((m) => !m.read && m.ts < 320).length);
  assert.equal(store.unreadCount(chat), 0);

  assert.equal(store.updateByMid(chat, '-1', { text: 'updated' }), true);
  assert.equal(store.findByLocalId(chat, 1).text, 'updated');
  assert.equal(store.markRecalled(chat, -250), true);
  assert.equal(store.findByMid(chat, '-250').recalled, true);
  assert.equal(store.removeByLocalIds(chat, [1, 1, 128, 201, 401]), 4);
  assert.equal(store.getChatMeta(chat).lastTs, previous.at(-1).ts);
  store.setMaxPerChat(8);
  assert.equal(store.appendIncoming(chat, { text: 'trim' }).id, 402);
  assert.deepEqual(store.recent(chat).map((m) => m.id), [304, 305, 306, 307, 308, 309, 310, 402]);
  assert.equal(store.clearChat(chat), 8);
  assert.deepEqual(fs.readdirSync(pages), []);
  assert.equal(new ChatStore().appendSelf(chat, { text: 'continued' }).id, 403);

  const broken = path.join(messageDir, 'group_456.json');
  fs.writeFileSync(broken, old.slice(0, -10));
  assert.throws(() => store.getChatMeta('group:456'), SyntaxError);
  assert.equal(fs.readFileSync(broken, 'utf8'), old.slice(0, -10));
  for (const nextLocalId of [undefined, 0, 2, 'bad']) {
    fs.writeFileSync(broken, JSON.stringify({ messages: previous.slice(0, 3), nextLocalId }));
    assert.equal(store.appendSelf('group:456', { text: 'continued' }).id, 4);
  }
  fs.writeFileSync(broken, 'null');
  assert.throws(() => store.appendSelf('group:456', { text: 'damaged' }), /格式/);
  assert.equal(fs.readFileSync(broken, 'utf8'), 'null');
  console.log('分页存档、旧档迁移、原子恢复及跨页查询通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
