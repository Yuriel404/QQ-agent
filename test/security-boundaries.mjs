import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { readAppPart } from './_ui-load.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-security-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const a = 'https://gateway.invalid/tenant-a';
const b = 'https://gateway.invalid/tenant-b';
const catalog = [
  { id: 'a', baseURL: a, models: ['model-a'], apiKey: 'legacy-a' },
  { id: 'b', baseURL: b, models: ['model-b'] }
];
const originalFetch = globalThis.fetch;

try {
  const { getConfig, updateConfig } = await import('../src/config.js');
  const { createRoutes } = await import('../src/routes.js');
  const { chatCompletion, resolveApiKey } = await import('../src/llm.js');
  const { currentProviders, setProviderKey } = await import('../src/providers.js');
  const { buildToolDefs } = await import('../src/tools.js');
  updateConfig({
    api: { provider: 'a', baseUrl: a, apiKey: 'old-manual-key', model: 'model-a' },
    providers: catalog, dshProviderKeys: { a: 'key-a', b: 'key-b' },
    allow: { groups: [1, 2, 3], private: [4] }, deny: { groups: [3] }
  });
  const routes = createRoutes({
    readBody: async (req) => req,
    snowlumaDir: () => dir,
    snowlumaWebuiUrl: () => 'http://localhost'
  });
  const json = (_, status, data) => ({ status, data });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    for (const pattern of ['/api/open-data-dir', '/api/snowluma/open-folder', '/api/snowluma/open-webui']) {
      const route = routes.find((r) => r.pattern === pattern);
      assert.equal((await route.handler({ json })).status, 501);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const key = new Headers(options.headers).get('authorization');
    if (key) assert.equal(options.redirect, 'error');
    requests.push({ url, key });
    return Response.json({ data: [], choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  };
  for (const endpoint of ['fetch-models', 'test-chat', 'test-one']) {
    const route = routes.find((entry) => entry.pattern === '/api/providers/' + endpoint);
    const probe = async (body, expectedKey) => {
      const before = requests.length;
      const result = await route.handler({ req: { ...body, model: 'm' }, json });
      assert.equal(result.status, 200);
      assert.equal(requests.length, before + 1);
      assert.ok(requests.at(-1).url.startsWith(body.baseUrl.replace(/\/+$/, '') + '/'));
      assert.equal(requests.at(-1).key, expectedKey, endpoint);
    };
    await probe({ providerId: 'a', baseUrl: a + '/' }, 'Bearer key-a');
    await probe({ providerId: 'b', baseUrl: b }, 'Bearer key-b');
    await probe({ providerId: 'a', baseUrl: b }, null);
    await probe({ providerId: 'missing', baseUrl: a }, null);
    await probe({ baseUrl: 'https://other.invalid' }, null);
    await probe({ providerId: 'a', baseUrl: b, apiKey: 'typed-for-this-request' }, 'Bearer typed-for-this-request');
  }

  const signal = new AbortController().signal;
  const chat = () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], signal });
  for (let i = 0; i < 15; i++) await chat();
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  updateConfig({ providers: [...catalog, { id: 'a', baseURL: b, models: [] }] });
  assert.equal(currentProviders().at(-1).apiKey, '');
  updateConfig({ providers: catalog.map(({ apiKey, ...rest }) => rest) });
  assert.equal(getConfig().providers[0].apiKey, 'legacy-a');
  assert.equal(requests.at(-1).key, 'Bearer key-a');
  globalThis.fetch = async () => { throw Error('offline'); };
  await assert.rejects(chat, /offline/);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  updateConfig({ api: { baseUrl: b } });
  assert.equal(resolveApiKey(getConfig()), '');
  assert.equal(getConfig().api.apiKey, '');
  updateConfig({ providers: [catalog[0], { ...catalog[1], baseURL: a }] });
  assert.equal(getConfig().dshProviderKeys.b, undefined);
  setProviderKey('a', '');
  assert.equal(getConfig().dshProviderKeys.a, undefined);
  assert.equal(getConfig().providers[0].apiKey, '');
  updateConfig({ api: { provider: '', baseUrl: a, apiKey: 'manual' } });
  updateConfig({ api: { baseUrl: a + '/' } });
  assert.equal(resolveApiKey(getConfig()), 'manual');
  updateConfig({ api: { baseUrl: b } });
  assert.equal(resolveApiKey(getConfig()), '');
  updateConfig({ api: { baseUrl: a, apiKey: 'replacement' } });
  assert.equal(resolveApiKey(getConfig()), 'replacement');


  const defs = buildToolDefs();
  const list = defs.find((t) => t.id === 'get_chats');
  const send = defs.find((t) => t.id === 'send_to');
  const ctx = { chatKey: 'group:1', session: { sent: [] }, emit() {} };
  assert.deepEqual(JSON.parse((await list.execute(ctx, {})).content).chats, [{ chatKey: 'group:1' }]);
  updateConfig({ tools: { crossChatSend: true } });
  ctx.store = { listChats: () => ['group:3', 'private:99', 'group:2', 'private:4'] };
  assert.deepEqual(JSON.parse((await list.execute(ctx, { limit: 2 })).content).chats, [
    { chatKey: 'group:2' }, { chatKey: 'private:4' }
  ]);
  let sent = 0;
  ctx.sender = { sendTextBatch: async () => { sent++; return { sent: [], failed: [] }; } };
  for (const targetChatKey of ['group:3', 'private:99']) {
    assert.ok((await send.execute(ctx, { targetChatKey, messages: 'hello' })).isError);
  }
  assert.equal(sent, 0);
  await send.execute(ctx, { targetChatKey: 'group:2', messages: 'ok' });
  assert.equal(sent, 1);
  const { ReminderStore } = await import('../src/reminders.js');
  ctx.reminders = new ReminderStore();
  const reminder = ctx.reminders.add({ chatKey: 'private:4', text: 'private', dueAt: Date.now() + 10000 });
  const cancel = defs.find((t) => t.id === 'cancel_reminder');
  assert.ok((await cancel.execute(ctx, { id: reminder.id })).isError);
  assert.equal(ctx.reminders.pending('private:4').length, 1);
  assert.ok(!(await cancel.execute({ ...ctx, chatKey: 'private:4' }, { id: reminder.id })).isError);
  const blockedUrl = '/api/chats/group_3/test-send';
  const testSend = routes.find((r) => r.pattern instanceof RegExp && r.pattern.test(blockedUrl));
  assert.equal((await testSend.handler({ req: { text: 'hi' }, json, match: testSend.pattern.exec(blockedUrl) })).status, 403);

  // 密钥显示请求尚未返回时切换供应商，迟到的响应也不能污染新表单。
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  try {
    const w = dom.window;
    let reveal;
    let payload;
    Object.assign(w, {
      state: { config: { api: { provider: 'a', baseUrl: a, model: 'model-a' } },
        providers: catalog.map((p) => ({ ...p, apiKey: '', hasKey: true })) },
      esc: String, visionBadge: () => '', loadSettings: () => {},
      api: async (url, options) => {
        if (url.includes('/key?')) return new Promise((resolve) => { reveal = resolve; });
        payload = JSON.parse(options.body);
        return { result: { ok: true } };
      }
    });
    w.eval(readAppPart('08-modals.js') + '\nopenModelConfigModal();');
    const field = (sel) => w.document.querySelector(sel);
    field('#mc-apikey-toggle').click();
    field('#mc-model-pick').click();
    field('#mcp-left [data-pid="b"]').click();
    field('#mcp-right [data-model="model-b"]').click();
    reveal({ apiKey: 'revealed-a' });
    await new Promise((r) => setImmediate(r));
    assert.equal(field('#mc-apikey').value, '******');
    field('#mc-test-btn').click();
    assert.deepEqual(payload, { providerId: 'b', baseUrl: b, apiKey: '', model: 'model-b' });
    field('#mc-apikey').value = 'typed-b';
    field('#mc-apikey').dispatchEvent(new w.Event('input'));
    field('#mc-save').click();
    assert.deepEqual(payload.dshProviderKeys, { b: 'typed-b' });
    assert.equal(payload.api.apiKey, undefined);
    await new Promise((r) => setImmediate(r));
  } finally { dom.window.close(); }
  console.log('通过：模型与搜索密钥隔离、会话权限、请求取消监听清理和前端密钥切换。');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
