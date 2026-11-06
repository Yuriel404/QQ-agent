import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-search-pool-'));
process.env.QQ_AGENT_DATA_DIR = directory;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const { getSearchPool, runSearchPool, updateSearchPool } = await import('../src/search-pool.js');
const file = path.join(directory, 'search-pool.json');
beforeEach(() => {
  fs.rmSync(file, { force: true });
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
});
after(() => {
  fs.rmSync(file, { force: true });
  fs.rmdirSync(directory);
});

const add = (provider, apiKey, options = {}) => updateSearchPool({ action: 'add', provider, apiKey, ...options }).keys.at(-1);
const configure = (options = {}) => updateSearchPool({ action: 'configure', enabled: true, ...options });
const search = (dispatch) => runSearchPool('query', dispatch, 'metaso');
const dispatchKey = async (provider, query, apiKey) => apiKey || provider;

async function expectNoDispatch() {
  let calls = 0;
  await assert.rejects(search(() => { calls += 1; }), /没有可用凭据/);
  assert.equal(calls, 0);
}

test('关闭搜索池沿用单服务，开启后只使用明确添加的凭据', async () => {
  let args;
  assert.equal(await search((...values) => { args = values; return 'single'; }), 'single');
  assert.deepEqual(args, ['metaso', 'query', undefined, undefined]);
  assert.equal(fs.existsSync(file), false);
  configure({ chain: ['tavily'] });
  await expectNoDispatch();
  const entry = add('tavily', '');
  assert.equal(entry.hasApiKey, false);
  assert.throws(() => add('tavily', ''), /默认凭据/);
  assert.throws(() => add('bing', 'not-used'), /默认凭据/);
  assert.equal(await search(dispatchKey), 'tavily');
  assert.equal(getSearchPool().keys[0].used, 1);
});

test('过期窗口不能覆盖新服务，已删除的自定义服务可逐一移出', () => {
  getConfig().webSearch.providers = ['one', 'two'].map((id) => ({ id, baseUrl: 'https://example.org/' + id }));
  configure({ chain: ['custom:one', 'custom:two'] });
  const old = getSearchPool().chain;
  add('bing', '');
  assert.throws(() => configure({ expectedChain: old, chain: old.slice().reverse() }), /刷新/);
  getConfig().webSearch.providers = [];
  const current = getSearchPool().chain;
  assert.deepEqual(configure({ expectedChain: current, chain: current.slice(1) }).chain, ['custom:two', 'bing']);
  assert.throws(() => configure({ chain: ['custom:missing'] }), /不存在/);
});

test('轮换游标重启后保留，同一请求内逐个尝试后回退到下一服务', async () => {
  add('tavily', 'first-key');
  add('tavily', 'second-key');
  add('bocha', 'last-key');
  configure();
  assert.equal(await search(dispatchKey), 'first-key');
  const reloaded = await import('../src/search-pool.js?restarted');
  assert.equal(await reloaded.runSearchPool('query', dispatchKey, 'metaso'), 'second-key');
  const tried = [];
  const answer = await search(async (provider, query, key) => {
    tried.push(key);
    if (provider === 'tavily') throw new Error(key);
    return { results: [] };
  });
  assert.deepEqual(tried, ['first-key', 'second-key', 'last-key']);
  assert.deepEqual(answer, { results: [] });
  const pool = getSearchPool();
  assert.deepEqual(pool.keys.map((k) => k.used), [2, 2, 1]);
  assert.ok(!JSON.stringify(pool).includes('first-key'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('默认凭据和显式凭据解析到同一密钥时，只能使用显式凭据的额度', async () => {
  const service = getConfig().webSearch.tavily;
  service.apiKey = 'settings-key';
  const item = add('tavily', '');
  assert.throws(() => add('tavily', 'settings-key'), /相同密钥/);
  const explicit = add('tavily', 'another-key', { quota: 1 });
  assert.throws(() => updateSearchPool({ action: 'edit', id: explicit.id, apiKey: 'settings-key' }), /相同密钥/);
  service.apiKey = 'another-key';
  configure();
  assert.equal(getSearchPool().keys[0].duplicateDefault, true);
  assert.equal(await search(dispatchKey), 'another-key');
  await expectNoDispatch();
  assert.deepEqual(getSearchPool().keys.map((k) => [k.status, k.used]), [['disabled', 0], ['exhausted', 1]]);
  updateSearchPool({ action: 'edit', id: explicit.id, enabled: false });
  await expectNoDispatch();
  updateSearchPool({ action: 'remove', id: item.id });
  assert.throws(() => add('tavily', ''), /相同密钥/);
  service.apiKey = 'rotated';
  add('tavily', '');
  assert.equal(await search(dispatchKey), 'tavily');
});

test('预占时的文件写入和清理异常不会将路径传给调用方', async (t) => {
  add('tavily', 'key');
  configure();
  const fail = () => { throw new Error('private-data-path-and-operating-system-error'); };
  t.mock.method(fs, 'writeFileSync', fail);
  t.mock.method(fs, 'rmSync', fail);
  let called = false;
  await assert.rejects(search(() => { called = true; }), { message: '无法保存搜索池配置' });
  assert.equal(called, false);
  assert.equal(getSearchPool().keys[0].used, 0);
});

test('并发预占额度，失败照计；重置状态与重置用量独立', async () => {
  const entry = add('tavily', 'key', { quota: 1, period: 'total' });
  configure();
  let failFirst;
  const pending = search(() => new Promise((resolve, reject) => { failFirst = reject; }));
  await expectNoDispatch();
  failFirst(new Error('private-upstream-message'));
  await assert.rejects(pending, (err) => !err.message.includes('private-upstream-message'));
  let key = updateSearchPool({ action: 'reset', id: entry.id }).keys[0];
  assert.equal(key.used, 1);
  assert.equal(key.status, 'exhausted');
  key = updateSearchPool({ action: 'resetUsage', id: entry.id }).keys[0];
  assert.equal(key.used, 0);
  assert.equal(key.status, 'ready');
});

test('临时错误到阈值关闭，鉴权失败立即关闭；已禁用的密钥不参与兜底', async () => {
  const a = add('tavily', 'a');
  const b = add('tavily', 'b');
  configure({ failureThreshold: 2 });
  const failed = async (provider, query, key) => {
    if (key === 'a') throw Object.assign(new Error(), { status: 401 });
    throw Object.assign(new Error(), { status: 429 });
  };
  await assert.rejects(search(failed));
  assert.deepEqual(getSearchPool().keys.map((k) => k.status), ['failed', 'ready']);
  await assert.rejects(search(failed));
  assert.deepEqual(getSearchPool().keys.map((k) => k.status), ['failed', 'failed']);
  updateSearchPool({ action: 'reset', id: b.id });
  assert.equal(await search(dispatchKey), 'b');
  updateSearchPool({ action: 'edit', id: b.id, enabled: false });
  updateSearchPool({ action: 'remove', id: a.id });
  await expectNoDispatch();
});

test('中途取消只计已经发起的一次请求，不罚分或轮换下一凭据', async () => {
  add('tavily', 'first');
  add('tavily', 'second');
  configure({ failureThreshold: 1 });
  const controller = new AbortController();
  const calls = [];
  const pending = runSearchPool('query', (provider, query, key, signal) => {
    calls.push(key);
    assert.equal(signal, controller.signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, 'bing', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(runSearchPool('query', dispatchKey, 'bing', controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(getSearchPool().keys.map((k) => [k.used, k.failures, k.status]), [
    [1, 0, 'ready'], [0, 0, 'ready']
  ]);
});

test('上游耗尽后的恢复遵循本地周期，跨日、跨月不解除鉴权封禁', async () => {
  for (const period of ['day', 'month', 'total']) add('tavily', period, { period, quota: 0 });
  add('tavily', 'auth', { period: 'day' });
  configure();
  await assert.rejects(search(async (provider, query, key) => {
    throw Object.assign(new Error(), key === 'auth' ? { status: 403 } : { quotaExhausted: true });
  }));
  assert.deepEqual(getSearchPool().keys.map((k) => k.status), ['exhausted', 'exhausted', 'exhausted', 'failed']);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of disk.keys) if (k.period !== 'total') k.window = '2000-01';
  fs.writeFileSync(file, JSON.stringify(disk));
  assert.deepEqual(getSearchPool().keys.map((k) => [k.status, k.used]), [
    ['ready', 0], ['ready', 0], ['exhausted', 1], ['failed', 0]
  ]);
});

test('端点变更跳过旧密钥，提交新凭据才授权当前端点；自定义服务删除后同样跳过', async () => {
  getConfig().webSearch.providers = [{ id: 'local', type: 'openai', baseUrl: 'https://example.com/search' }];
  const key = add('custom:local', 'old-key');
  configure();
  getConfig().webSearch.providers[0].baseUrl += '/';
  assert.equal(await search(dispatchKey), 'old-key');
  getConfig().webSearch.providers[0].baseUrl = 'https://example.com/new-search';
  assert.equal(getSearchPool().keys[0].endpointChanged, true);
  updateSearchPool({ action: 'edit', id: key.id, label: '重命名' });
  await expectNoDispatch();
  updateSearchPool({ action: 'edit', id: key.id, apiKey: 'new-key' });
  assert.equal(await search(dispatchKey), 'new-key');
  getConfig().webSearch.providers[0].baseUrl += '?tenant=a/';
  updateSearchPool({ action: 'edit', id: key.id, apiKey: 'tenant-key' });
  getConfig().webSearch.providers[0].baseUrl = 'https://example.com/new-search?tenant=a';
  await expectNoDispatch();
  getConfig().webSearch.providers = [];
  await expectNoDispatch();
});

test('并发完成不会更改已替换、已删除或重置的凭据，也不会复活已封禁的项', async () => {
  const entry = add('tavily', 'old');
  configure();
  let complete;
  let fail;
  const first = search(() => new Promise((resolve) => { complete = resolve; }));
  await assert.rejects(search(async () => { throw Object.assign(new Error(), { status: 401 }); }));
  complete('ok');
  assert.equal(await first, 'ok');
  assert.equal(getSearchPool().keys[0].status, 'failed');
  updateSearchPool({ action: 'reset', id: entry.id });
  const second = search(() => new Promise((resolve, reject) => { fail = reject; }));
  updateSearchPool({ action: 'edit', id: entry.id, apiKey: 'new' });
  fail(Object.assign(new Error(), { status: 401 }));
  await assert.rejects(second);
  assert.equal(getSearchPool().keys[0].status, 'ready');
  const removed = search(() => new Promise((resolve) => { complete = resolve; }));
  fs.unlinkSync(file); // 模拟 /api/reset-data 将文件移到备份目录
  complete('ok');
  await removed;
  assert.deepEqual(getSearchPool().keys, []);
  assert.equal(fs.existsSync(file), false);
});
