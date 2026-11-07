import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { listen } from './_harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-media-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const { chatCompletionWithRetry } = await import('../src/llm.js');
const { buildToolDefs } = await import('../src/tools.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
// 七帧 8×8 GIF，帧延迟依次为 120 至 180 ms；帧索引 0、2、4、6 的颜色为红、绿、蓝、黄。
const animatedGif = Buffer.from('R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQIDAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIDQAAACwAAAAACAAIAIEUFBQAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIDgAAACwAAAAACAAIAIEA/wAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIDwAAACwAAAAACAAIAIF4FHgAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIEAAAACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIEQAAACwAAAAACAAIAIHm5uYAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIEgAAACwAAAAACAAIAIH//wAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7', 'base64');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ6sAAAAASUVORK5CYII=';
const unsupported = { message: 'Unsupported Media Type', type: 'Unsupported Media Type', code: 415 };
const success = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };

beforeEach(() => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.api, { model: 'main', visionModel: 'vision', baseUrl: 'https://gw.invalid/v1', fallbackModels: [] });
  setRuntimeConfig(cfg);
});

function messagesWithImage(url) {
  return [{ role: 'user', content: [
    { type: 'text', text: '请描述图片' },
    { type: 'image_url', image_url: { url } }
  ] }];
}

function imageUrls(messages) {
  return messages.flatMap(({ content }) => Array.isArray(content)
    ? content.filter(part => part.type === 'image_url').map(part => part.image_url.url)
    : []);
}

function recordGateway(t, reply) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'gw.invalid');
    const body = JSON.parse(options.body);
    requests.push(body);
    return reply(body);
  });
  return requests;
}

async function serveImagesAsJpeg(t, samples) {
  getConfig().security.allowPrivateImageHosts = true;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/jpeg');
    res.end(samples.get(req.url));
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + port;
}

test('QQ 图片以实际字节区分 JPEG、WebP，拒绝伪装为图片的网页', async (t) => {
  // 保留默认的只看图配置，模拟全部地址都被 QQ 标记为 JPEG。
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Kf//Z', 'base64');
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const samples = new Map([
    ['/jpeg.jpg', jpeg], ['/webp.jpg', webp],
    ['/error.jpg', Buffer.from('<html>CDN access denied</html>')]
  ]);
  const base = await serveImagesAsJpeg(t, samples);
  const getImages = buildToolDefs().find(tool => tool.id === 'get_message_images');
  const ctx = { chatKey: 'group:1', store: { findByMid: (_, name) => ({
    media: [{ kind: 'image', file: 'picture.jpg', url: base + name }]
  }) } };
  for (const format of ['jpeg', 'webp']) {
    const r = await getImages.execute(ctx, { messageId: '/' + format + '.jpg' });
    assert.ok(!r.isError, r.isError ? r.content : undefined);
    assert.equal(imageUrls([r])[0], 'data:image/' + format + ';base64,' + samples.get('/' + format + '.jpg').toString('base64'));
  }
  const denied = await getImages.execute(ctx, { messageId: '/error.jpg' });
  assert.equal(denied.isError, true);
  assert.deepEqual(imageUrls([denied]), []);
});

test('只开图片时，伪装成 JPEG 的 GIF 在消息、收藏和网图预览中以一张静态拼图呈现', async (t) => {
  const base = await serveImagesAsJpeg(t, new Map([['/animation.jpg', animatedGif]]));
  const url = base + '/animation.jpg';
  const ctx = {
    chatKey: 'group:1',
    store: { findByMid: () => ({ media: [{ kind: 'image', file: 'animation.jpg', url }] }) },
    stickers: { find: async () => ({ id: 'test', url }) },
    session: { sent: [] }, emit() {}
  };
  const tools = buildToolDefs();
  const sendImage = tools.find(tool => tool.id === 'send_image');
  const views = [
    await tools.find(tool => tool.id === 'get_message_images').execute(ctx, { messageId: 42 }),
    await tools.find(tool => tool.id === 'get_sticker_image').execute(ctx, { stickerId: 'test' }),
    await sendImage.execute(ctx, { url, preview: true })
  ];
  for (const view of views) {
    if (!hasFfmpeg) {
      assert.deepEqual(imageUrls([view]), []);
      assert.match(JSON.stringify(view.content), /GIF|画面/);
      continue;
    }
    assert.ok(!view.isError, JSON.stringify(view.content).slice(0, 150));
    assert.equal(imageUrls([view]).length, 1);
    assert.match(imageUrls([view])[0], /^data:image\/png;base64,/);
    assert.ok(view.content.every(part => part.type === 'text' || part.type === 'image_url'));
    const caption = view.content.filter(part => part.type === 'text').map(part => part.text).join(' ');
    assert.match(caption, hasFfprobe ? /4\s*帧/ : /一帧/);
  }
  if (!hasFfmpeg) return;
  const [urlPng] = imageUrls([views[0]]);
  const image = Buffer.from(urlPng.split(',')[1], 'base64');
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { input: image, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(decoded.stdout.length, width * height * 3);
  const colors = hasFfprobe ? [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]] : [[255, 0, 0]];
  const columns = hasFfprobe ? 2 : 1;
  for (const [i, color] of colors.entries()) {
    const x = Math.floor(width * (i % columns + 0.5) / columns);
    const y = Math.floor(height * (Math.floor(i / columns) + 0.5) / columns);
    const offset = 3 * (y * width + x);
    assert.ok(color.every((value, c) => Math.abs(value - decoded.stdout[offset + c]) < 20), '拼图顺序，格 ' + (i + 1));
  }

  const requests = recordGateway(t, body => {
    const parts = body.messages[0].content.filter(part => part.type !== 'text');
    if (parts.length === 1 && parts[0].type === 'image_url' && parts[0].image_url.url === urlPng) return Response.json(success);
    return Response.json(unsupported, { status: 415 });
  });
  await chatCompletionWithRetry({ messages: [{ role: 'user', content: views[0].content }] });
  assert.deepEqual(requests.map(r => r.model), ['vision']);

  // 拼图仅用于查看，机器人实际发送给 QQ 的图片仍保留原始动画。
  let attachment;
  ctx.sender = { sendImage: async (_, media) => { attachment = media; return { message_id: 123 }; } };
  const sent = await sendImage.execute(ctx, { url });
  assert.ok(!sent.isError, sent.content);
  assert.deepEqual(attachment, { url, dataUrl: 'base64://' + animatedGif.toString('base64') });
});

test('单帧 GIF 产生一张静态画面', { skip: !hasFfmpeg && 'FFmpeg 不可用' }, async () => {
  const { gifStoryboardDataUrl } = await import('../src/gif-to-video.js');
  const still = await gifStoryboardDataUrl(Buffer.from(gif.split(',')[1], 'base64'));
  assert.equal(still.frameCount, 1);
  assert.equal(still.columns, 1);
  assert.match(still.dataUrl, /^data:image\/png;base64,/);
});

test('原图优先交给备选模型，避免在兼容模型可用时丢失动画', async (t) => {
  getConfig().api.fallbackModels = [{ model: 'backup' }];
  const requests = recordGateway(t, body => body.model === 'backup' ? Response.json(success)
    : Response.json(unsupported, { status: 415 }));
  const result = await chatCompletionWithRetry({ messages: messagesWithImage(gif) });
  assert.deepEqual(requests.map(r => r.model), ['vision', 'backup']);
  assert.deepEqual(requests.map(r => imageUrls(r.messages)), [[gif], [gif]]);
  assert.equal(result._usedModel, 'backup');
});

test('GIF 遇到通用 415 时提取 PNG 首帧，下一轮沿用已经接受的媒体', async (t) => {
  if (!hasFfmpeg) {
    t.skip('FFmpeg 不可用');
    return;
  }
  const requests = recordGateway(t, body => imageUrls(body.messages).includes(gif)
    ? Response.json(unsupported, { status: 415 }) : Response.json(success));
  const result = await chatCompletionWithRetry({ messages: messagesWithImage(gif) });
  assert.equal(requests.length, 2);
  const [frame] = imageUrls(requests[1].messages);
  assert.match(frame, /^data:image\/png;base64,iVBOR/);
  assert.equal(result.degraded, true);
  assert.deepEqual(imageUrls(result._acceptedMessages), [frame]);
  await chatCompletionWithRetry({ messages: [...result._acceptedMessages, result.message, { role: 'user', content: '继续' }] });
  assert.equal(requests.length, 3);
  assert.deepEqual(imageUrls(requests[2].messages), [frame]);
});

test('无法解码的 GIF 与正常 PNG 混发，仅移除坏图并保留工具消息顺序', async (t) => {
  const damaged = 'data:image/gif;base64,' + Buffer.from('GIF89a invalid data').toString('base64');
  const history = [
    { role: 'user', content: '帮我看一下这两张图' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get_message_images', arguments: '{"messageId":1}' } }
    ] },
    { role: 'tool', name: 'get_message_images', tool_call_id: 'c1', content: '消息有两张图' }
  ];
  const [attachments] = messagesWithImage(damaged);
  attachments.content.push({ type: 'image_url', image_url: { url: png } });
  const requests = recordGateway(t, body => imageUrls(body.messages).includes(damaged)
    ? Response.json(unsupported, { status: 415 }) : Response.json(success));
  const result = await chatCompletionWithRetry({ messages: [...history, attachments] });
  assert.equal(requests.length, 2);
  assert.deepEqual(imageUrls(result._acceptedMessages), [png]);
  assert.deepEqual(result._acceptedMessages.slice(0, history.length), history);
  assert.equal(result._usedModel, 'vision');
});

test('GIF 及其首帧都被拒时以文字完成，缺少 FFmpeg 也能继续', async (t) => {
  const requests = recordGateway(t, body => imageUrls(body.messages).length
    ? Response.json(unsupported, { status: 415 }) : Response.json(success));
  const result = await chatCompletionWithRetry({ messages: messagesWithImage(gif) });
  assert.equal(requests.length, hasFfmpeg ? 3 : 2);
  assert.deepEqual(imageUrls(result._acceptedMessages), []);
  assert.equal(result._usedModel, 'main');
});

for (const [status, payload] of [[415, unsupported], [400, { message: 'This model does not support image inputs' }]]) {
  test('明确拒绝图片的 HTTP ' + status + ' 能用文字继续，对话和工具仍然可用', async (t) => {
    const requests = recordGateway(t, body => imageUrls(body.messages).length ? Response.json(payload, { status }) : Response.json(success));
    const tools = [{ type: 'function', function: { name: 'finish', parameters: { type: 'object', properties: {} } } }];
    const result = await chatCompletionWithRetry({ messages: messagesWithImage(png), tools });
    assert.deepEqual(requests.map(r => r.model), ['vision', 'main']);
    assert.deepEqual(requests[1].tools, tools);
    assert.equal(result.degraded, true);
    assert.deepEqual(imageUrls(result._acceptedMessages), []);
    const text = JSON.stringify(result._acceptedMessages);
    assert.ok(text.includes('请描述图片'));
    assert.match(text, /无法|未能|没有收到|未收到|拒绝|不支持/);
    assert.ok(!text.includes('base64,'));
  });
}

test('无媒体的 415、无效模型的 400 保留原错，只发送一次请求', async (t) => {
  const requests = recordGateway(t, body => imageUrls(body.messages).length
    ? Response.json({ message: 'Invalid model name' }, { status: 400 })
    : Response.json(unsupported, { status: 415 }));
  await assert.rejects(chatCompletionWithRetry({ messages: [{ role: 'user', content: '你好' }] }), /HTTP 415/);
  assert.equal(requests.length, 1);
  await assert.rejects(chatCompletionWithRetry({ messages: messagesWithImage(gif) }), /HTTP 400/);
  assert.equal(requests.length, 2);
});
