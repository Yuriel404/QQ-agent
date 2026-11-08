import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-media-providers-'));
process.env.QQ_AGENT_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, getConfig, loadConfig, setRuntimeConfig, updateConfig } = await import('../src/config.js');
const { chatCompletion, chatCompletionWithRetry } = await import('../src/llm.js');
const { canUseImageTools } = await import('../src/vision-scan.js');
const { skillManager } = await import('../src/skills/manager.js');

const image = { type: 'image_url', image_url: { url: 'https://fixture.invalid/picture.png' } };
const video = { type: 'video_url', video_url: { url: 'https://fixture.invalid/movie.mp4' } };
const text = { type: 'text', text: '描述内容' };
const channels = ['main', 'image', 'video', 'backup'];
const endpoint = id => `https://${id}.example.invalid/v1`;
const keyFor = id => 'fixture-' + id;
const messages = (...parts) => [{ role: 'user', content: parts }];
const send = (...parts) => chatCompletionWithRetry({ messages: messages(...parts) }, 0);

beforeEach(() => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.providers = channels.map(id => ({ id, baseURL: endpoint(id), models: ['shared'] }));
  cfg.dshProviderKeys = Object.fromEntries(channels.map(id => [id, keyFor(id)]));
  Object.assign(cfg.api, {
    provider: 'main', baseUrl: endpoint('main'), apiKey: keyFor('main'), model: 'shared',
    visionProvider: 'image', visionModel: 'shared', videoProvider: 'video', videoModel: 'shared', fallbackModels: []
  });
  setRuntimeConfig(cfg);
});

function recordGateways(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url: String(url), authorization: new Headers(init.headers).get('authorization'), model: body.model };
    calls.push(call);
    return respond?.(call, body) ?? Response.json({ model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  return calls;
}

function expected(id, model = 'shared') {
  return { url: endpoint(id) + '/chat/completions', authorization: 'Bearer ' + keyFor(id), model };
}

test('同名的主模型、图片模型、视频模型各自使用对应地址与密钥，计费渠道与实际请求一致', async t => {
  const calls = recordGateways(t);
  for (const [id, parts] of [['main', [text]], ['image', [text, image]], ['video', [video, image]]]) {
    const response = await send(...parts);
    assert.deepEqual(calls.at(-1), expected(id));
    assert.equal(response._usedApi.provider, id);
    assert.equal(response._usedApi.baseUrl, endpoint(id));
    assert.equal(Object.hasOwn(response._usedApi, 'apiKey'), false);
  }
  assert.equal(calls.length, 3);
});

test('图片与视频的渠道选择在重启后生效，单独清空模型会清除其渠道', async t => {
  const calls = recordGateways(t);
  updateConfig({ api: { visionModel: '', videoModel: '' } });
  updateConfig({ api: {
    visionModel: 'shared', visionProvider: 'image',
    videoModel: 'shared', videoProvider: 'video'
  } });
  setRuntimeConfig(loadConfig());
  await send(image);
  await send(video);

  updateConfig({ api: { visionModel: '' } });
  setRuntimeConfig(loadConfig());
  assert.equal(getConfig().api.visionProvider, '');
  assert.equal(getConfig().api.videoProvider, 'video');
  await send(image);
  await send(video);

  updateConfig({ api: { videoModel: '' } });
  setRuntimeConfig(loadConfig());
  assert.equal(getConfig().api.videoProvider, '');
  await send(video);
  assert.deepEqual(calls, [expected('image'), expected('video'), expected('main'), expected('video'), expected('main')]);
});

test('不同渠道使用各自配置的完整模型 ID', async t => {
  const calls = recordGateways(t);
  const cfg = getConfig();
  cfg.api.visionModel = 'images/specific';
  cfg.api.videoModel = 'movies/specific';
  await send(image);
  await send(video);
  assert.deepEqual(calls, [expected('image', 'images/specific'), expected('video', 'movies/specific')]);
});

test('视频专用模型留空时使用图片模型及其渠道，两个模型都留空时使用主渠道', async t => {
  const calls = recordGateways(t);
  getConfig().api.videoModel = '';
  await send(video);
  getConfig().api.visionModel = '';
  await send(video);
  assert.deepEqual(calls, [expected('image'), expected('main')]);
});

test('旧格式只保存了专用模型名时沿用主渠道和凭据', async t => {
  const calls = recordGateways(t);
  const api = getConfig().api;
  delete api.visionProvider;
  delete api.videoProvider;
  api.visionModel = 'legacy-img';
  api.videoModel = 'legacy-vid';
  await send(image);
  await send(video);
  assert.deepEqual(calls, [expected('main', 'legacy-img'), expected('main', 'legacy-vid')]);
});

test('主模型可使用端点池，媒体专用渠道及调用方指定的渠道均独立发送', async t => {
  const calls = recordGateways(t);
  t.mock.method(skillManager, 'getCapabilityProviders', name => name === 'llm.endpoint-pick'
    ? [{ fn: () => ({ baseUrl: endpoint('pool'), apiKey: keyFor('pool') }) }]
    : []);
  await send(text);
  await send(image);
  await chatCompletion({
    messages: messages(image),
    overrides: { provider: 'backup', baseUrl: endpoint('backup'), apiKey: keyFor('backup'), model: 'explicit' }
  });
  assert.deepEqual(calls, [expected('pool'), expected('image'), expected('backup', 'explicit')]);
});

test('图片渠道认证失败后，同一张图片由显式备选渠道及其密钥接收', async t => {
  const calls = recordGateways(t, (call, body) => {
    assert.deepEqual(body.messages, messages(image));
    if (call.url === expected('image').url) return Response.json({ error: 'unauthorized' }, { status: 401 });
  });
  getConfig().api.fallbackModels = [{ provider: 'backup', model: 'shared' }];
  const result = await send(image);
  assert.deepEqual(calls, [expected('image'), expected('backup')]);
  assert.equal(result._usedApi.provider, 'backup');
  assert.equal(Object.hasOwn(result._usedApi, 'apiKey'), false);
});

test('专用渠道缺失或地址无效时停止发送，缺少密钥时只向该渠道发送无认证请求', async t => {
  const cfg = getConfig();
  const calls = recordGateways(t);
  cfg.api.visionProvider = 'removed';
  await assert.rejects(send(image));
  cfg.api.visionProvider = 'image';
  const provider = cfg.providers.find(entry => entry.id === 'image');
  provider.baseURL = '地址无效';
  await assert.rejects(send(image));
  assert.deepEqual(calls, []);
  provider.baseURL = endpoint('image');
  delete cfg.dshProviderKeys.image;
  await send(image);
  assert.deepEqual(calls, [{ ...expected('image'), authorization: null }]);
});

test('网关拒绝 PNG 并降为文字时，改走主渠道', async t => {
  const calls = recordGateways(t, (call) => {
    if (call.url === expected('image').url) return Response.json({ message: 'Unsupported Media Type' }, { status: 415 });
  });
  const result = await send(text, image);
  assert.deepEqual(calls, [expected('image'), expected('main')]);
  assert.equal(result._usedApi.provider, 'main');
  assert.equal(result.degraded, true);
});

test('视频网关拒收 MP4 后，PNG 首帧由图片渠道接收', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg 不可用');
  const mp4 = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=24x24:d=0.2',
    '-frames:v', '1', '-c:v', 'mpeg4', '-movflags', 'empty_moov+frag_keyframe', '-f', 'mp4', 'pipe:1'
  ]);
  const calls = recordGateways(t, (call, body) => {
    if (call.url === expected('video').url) return Response.json({ message: 'Unsupported Media Type' }, { status: 415 });
    assert.ok(body.messages[0].content.some(part => part.image_url?.url.startsWith('data:image/png;base64,')));
  });
  const result = await send({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,' + mp4.toString('base64') } });
  assert.deepEqual(calls, [expected('video'), expected('image')]);
  assert.equal(result._usedApi.provider, 'image');
});

test('视觉门控查询当前图片渠道的扫描结果，主渠道与图片渠道使用同名模型也能区分', () => {
  const cfg = getConfig();
  cfg.modelVision = { 'main|||shared': { verdict: 'no-vision' }, 'image|||shared': { verdict: 'vision' } };
  assert.equal(canUseImageTools(cfg.api), true);
  cfg.modelVision['main|||shared'].verdict = 'vision';
  cfg.modelVision['image|||shared'].verdict = 'no-vision';
  assert.equal(canUseImageTools(cfg.api), false);
  cfg.api.visionModel = '';
  assert.equal(canUseImageTools(cfg.api), true);
});
