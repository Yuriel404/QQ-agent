import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { after, beforeEach, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-search-adapters-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const { webSearch } = await import('../src/web-search.js');
const { getSearchPool, updateSearchPool } = await import('../src/search-pool.js');
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const endpoint = 'https://api.tavily.com/search';

beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'search-pool.json'), { force: true });
  delete process.env.TAVILY_API_KEY;
  const config = structuredClone(DEFAULT_CONFIG);
  config.webSearch.provider = 'tavily';
  setRuntimeConfig(config);
});

test('通过 web_search 免密搜索，清洗查询并映射结果', async (t) => {
  getConfig().webSearch.maxResults = 1;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, endpoint);
    assert.equal(opts.method, 'POST');
    const headers = new Headers(opts.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-tavily-access-mode'), 'keyless');
    assert.equal(headers.has('authorization'), false);
    assert.deepEqual(JSON.parse(opts.body), { query: 'QQ 搜索', search_depth: 'basic', max_results: 1 });
    return Response.json({ results: [
      { url: 'file:///private', content: '跳过' },
      { title: ' 一 ', url: 'https://example.com/a', content: ' 摘要 ', raw_content: '全文' },
      { title: '二', url: 'https://example.com/b', content: '摘要二' }
    ] });
  });
  assert.deepEqual(await webSearch('[CQ:at,qq=123] QQ\n搜索'), {
    query: 'QQ 搜索',
    results: [{ title: '一', url: 'https://example.com/a', snippet: '摘要' }]
  });
});

test('官方端点接受环境密钥，配置中的密钥优先，自定义地址仅使用显式密钥', async (t) => {
  const search = getConfig().webSearch;
  process.env.TAVILY_API_KEY = 'env-test-key';
  search.maxResults = 100;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(opts.redirect, 'error');
    const body = JSON.parse(opts.body);
    assert.equal(body.max_results, 20);
    const headers = new Headers(opts.headers);
    calls.push([url, headers.get('authorization'), headers.get('x-tavily-access-mode')]);
    return Response.json({ results: [] });
  });
  assert.deepEqual(await webSearch('测试'), { query: '测试', results: [] });
  search.tavily.apiKey = 'stored-test-key';
  await webSearch('测试');
  const custom = 'https://example.com/tavily/search';
  search.tavily.baseUrl = custom;
  search.tavily.apiKey = '';
  await webSearch('测试');
  search.tavily.apiKey = 'proxy-test-key';
  await webSearch('测试');
  assert.deepEqual(calls, [
    [endpoint, 'Bearer env-test-key', null],
    [endpoint, 'Bearer stored-test-key', null],
    [custom, null, 'keyless'],
    [custom, 'Bearer proxy-test-key', null]
  ]);
});

test('限流、鉴权错误和无效响应有独立错误，不回显上游凭据', async (t) => {
  const responses = [
    new Response('upstream-secret', { status: 429 }),
    new Response('upstream-secret', { status: 401 }),
    new Response('bad json'),
    Response.json({ detail: 'unexpected' })
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(webSearch('测试'), /HTTP 429.*免密/);
  getConfig().webSearch.tavily.apiKey = 'mock-key';
  await assert.rejects(webSearch('测试'), { message: 'Tavily 搜索 HTTP 401' });
  await assert.rejects(webSearch('测试'), /JSON/);
  await assert.rejects(webSearch('测试'), /results 数组/);
  assert.equal(responses.length, 0);
});

const resultUrl = 'https://example.com/result';
const adapterResponses = {
  tavily: { results: [{ url: resultUrl }] },
  deepseek: { output_text: '回答' },
  zhipu: { search_result: [{ link: resultUrl }] },
  bocha: { code: 200, data: { webPages: { value: [{ url: resultUrl }] } } },
  baidu: { references: [{ url: resultUrl }] },
  metaso: { results: [{ url: resultUrl }] },
  custom: { results: [{ url: resultUrl }] },
  'custom:MixedCase': { results: [{ url: resultUrl }] }
};

for (const [provider, payload] of Object.entries(adapterResponses)) {
  test(`${provider} 使用池内 Key 并保留原配置`, async (t) => {
    const search = getConfig().webSearch;
    search.custom.baseUrl = 'https://legacy.example/search';
    const named = { id: 'MixedCase', baseUrl: 'https://named.example/search', type: 'openai' };
    search.providers = [named];
    const config = provider === 'custom:MixedCase' ? named : search[provider];
    config.apiKey = 'original-test-key';
    updateSearchPool({ action: 'add', provider, apiKey: 'pool-test-key' });
    updateSearchPool({ action: 'configure', enabled: true, chain: [provider] });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      calls.push([url, new Headers(opts.headers).get('authorization'), opts.redirect]);
      return Response.json(payload);
    });
    const response = await webSearch('查询');
    assert.equal(response.results.length, 1);
    assert.deepEqual(calls, [[config.baseUrl, 'Bearer pool-test-key', 'error']]);
    assert.equal(config.apiKey, 'original-test-key');
  });
}

test('池内 Key 发往绑定的自定义接口，查询参数末尾的斜杠保留', async (t) => {
  const search = getConfig().webSearch;
  const provider = 'custom:Tenant';
  search.providers = [{ id: 'Tenant', baseUrl: 'https://named.example/search/?tenant=a/' }];
  updateSearchPool({ action: 'add', provider, apiKey: 'tenant-test-key' });
  updateSearchPool({ action: 'configure', enabled: true, chain: [provider] });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push([url, new Headers(opts.headers).get('authorization')]);
    return Response.json({ results: [{ url: resultUrl }] });
  });
  await webSearch('查询');
  assert.deepEqual(calls, [['https://named.example/search?tenant=a/', 'Bearer tenant-test-key']]);
});

test('单服务沿用旧 custom 槽位及不区分前缀大小写的历史选择，保留自定义 ID 大小写', async (t) => {
  const search = getConfig().webSearch;
  search.providers = [{ id: 'DemoAPI', baseUrl: 'https://new.example/search' }];
  search.custom.baseUrl = 'https://old.example/search';
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return Response.json({ results: [{ url: resultUrl }] });
  });
  for (const selected of ['CUSTOM:DemoAPI', 'custom', 'custom:removed']) {
    search.provider = selected;
    await webSearch('查');
  }
  assert.deepEqual(urls, ['https://new.example/search', 'https://old.example/search', 'https://old.example/search']);
});

test('上游错误有结构化 HTTP 状态，限速与确切配额错误分别处理', async (t) => {
  let status, body;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }));
  for (const [provider, httpStatus, detail, quota] of [
    ['tavily', 429, {}, false], ['tavily', 432, {}, true], ['tavily', 433, {}, true], ['tavily', 434, {}, false],
    ['deepseek', 402, {}, true], ['zhipu', 429, { error: { code: '1302' } }, false],
    ['zhipu', 429, { error: { code: '1113' } }, true], ['bing', 403, {}, false],
    ['bocha', 401, {}, false], ['baidu', 503, {}, false], ['metaso', 503, {}, false], ['custom', 401, {}, false]
  ]) {
    status = httpStatus;
    body = { ...detail, message: 'secret-echo' };
    const search = getConfig().webSearch;
    search.provider = provider;
    search.custom.baseUrl = 'https://custom.example/search';
    if (provider !== 'bing') search[provider].apiKey = 'secret-echo';
    await assert.rejects(webSearch('查询'), (err) => {
      assert.equal(err.status, status);
      assert.equal(err.quotaExhausted, quota);
      assert.doesNotMatch(err.message, /secret-echo/);
      return true;
    });
  }
});

test('运行中中止请求，停止使用后续 Key 并解绑监听器', async (t) => {
  for (const apiKey of ['first-test-key', 'second-test-key']) {
    updateSearchPool({ action: 'add', provider: 'tavily', apiKey });
  }
  updateSearchPool({ action: 'configure', enabled: true });
  const controller = new AbortController();
  const reason = new Error('用户已中止');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort(reason));
    });
  });
  await assert.rejects(webSearch('测试', controller.signal), err => err === reason);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(getSearchPool().keys.map(k => k.failures), [0, 0]);
});
