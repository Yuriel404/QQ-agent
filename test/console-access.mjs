import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createConsoleAccess } from '../src/console-access.js';

const basic = (password, user = 'admin') =>
  'Basic ' + Buffer.from(user + ':' + password).toString('base64');

test('公开监听要求强令牌，配置轮换和环境变量优先级生效', () => {
  const config = { host: '0.0.0.0', token: '' };
  assert.throws(() => createConsoleAccess(() => config, {}), /32/);
  config.token = 'a'.repeat(32);
  const access = createConsoleAccess(() => config, {});
  const accepts = (a, t) => a.authorized({ headers: { 'x-console-token': t } });
  assert.ok(accepts(access, config.token));
  const envToken = 'b'.repeat(32);
  const overridden = createConsoleAccess(() => config, { QQ_AGENT_CONSOLE_TOKEN: envToken });
  config.token = '短令牌';
  assert.equal(accepts(access, config.token), false);
  assert.equal(accepts(access, 'a'.repeat(32)), false);
  assert.equal(accepts(overridden, config.token), false);
  assert.ok(accepts(overridden, envToken));
  assert.throws(() => createConsoleAccess(() => ({}), {
    QQ_AGENT_ALLOWED_ORIGINS: 'https://*.example.org',
  }), /来源/);
});

test('真实 HTTP 控制台、密钥与事件流要求登录并验证来源', { timeout: 10000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-console-test-'));
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  let app;
  t.after(async () => {
    try { await app?.stop(); } finally { fs.rmSync(tmp, { force: true, recursive: true }); }
  });
  process.env.QQ_AGENT_DATA_DIR = tmp;
  process.env.QQ_AGENT_HOST = '127.0.0.1';
  process.env.QQ_AGENT_ALLOWED_ORIGINS = 'https://bot.example.org:8443';
  delete process.env.QQ_AGENT_CONSOLE_TOKEN;
  const { createApp } = await import('../src/app.js');
  let generated;
  app = createApp({ log() {}, onGeneratedConsoleToken(value) { generated = value; } });
  assert.equal(generated, app.getConsoleToken());
  assert.ok(generated.length >= 32);
  app.updateConfig({ api: { apiKey: 'secret-model-key' } });
  const saved = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
  assert.ok(!saved.includes(generated));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(tmp, 'config.json')).mode & 0o077, 0);

  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('测试：磁盘写入失败'); };
    assert.throws(() => app.updateConfig({ server: { token: 'uncommitted' } }), /磁盘写入失败/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(app.getConsoleToken(), generated);
  assert.equal(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'), saved);

  const listening = once(app.server, 'listening');
  app.server.listen(0, '127.0.0.1');
  await listening;
  const { port } = app.server.address();
  const origin = 'http://127.0.0.1:' + port;
  const admin = { authorization: basic(generated) };
  const call = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(origin + p, { headers }, async (res) => {
      if (res.headers['content-type'] === 'text/event-stream') {
        const [first] = await once(res, 'data');
        res.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: first.toString() });
        return;
      }
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
    });
    req.on('error', reject);
  });

  for (const p of ['/', '/api/config', '/api/api-key', '/api/events', '/api/events?token=' + generated]) {
    const denied = await call(p);
    assert.equal(denied.status, 401, p);
    assert.match(denied.headers['www-authenticate'], /^Basic realm="QQ Agent"/);
    assert.ok(!denied.body.includes(generated) && !denied.body.includes('secret-model-key'));
  }
  assert.equal((await call('/api/api-key', { 'x-console-token': 'qq-agent-console' })).status, 401);
  assert.equal((await call('/api/api-key', { authorization: basic(generated, 'nobody') })).status, 401);
  assert.equal((await call('/', admin)).status, 200);
  assert.equal(JSON.parse((await call('/api/api-key', { 'x-console-token': generated })).body).apiKey, 'secret-model-key');
  assert.match((await call('/api/events', { ...admin, origin, 'sec-fetch-site': 'same-origin' })).body, /event: hello/);

  for (const headers of [
    { host: 'evil.example.org', 'x-forwarded-host': '127.0.0.1:' + port },
    { origin: 'http://localhost:1234' }, { referer: 'https://evil.example.org/' },
    { origin: 'null' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    { host: 'bot.example.org:8443', origin: 'http://bot.example.org:8443' },
    { host: 'bot.example.org:8443', origin }, { host: 'bot.example.org' },
  ]) {
    assert.equal((await call('/api/api-key', { ...admin, ...headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await call('/api/api-key', {
    ...admin, host: 'bot.example.org:8443', origin: 'https://bot.example.org:8443',
    referer: 'https://bot.example.org:8443/settings',
  })).status, 200);

  // 已打开的 SSE 也必须在令牌轮换后停止投递。
  const stream = await new Promise((resolve, reject) =>
    http.get(origin + '/api/events', { headers: admin }, resolve).on('error', reject));
  await once(stream, 'data');
  let furtherBytes = 0;
  stream.on('data', chunk => { furtherBytes += chunk.length; });
  stream.on('error', () => {}); // 服务端主动销毁长连接
  const closed = new Promise(resolve => stream.once('close', resolve));
  app.updateConfig({ server: { token: 'rotated-console-token' } });
  app.emit('status', { privateUpdate: true });
  await closed;
  assert.equal(furtherBytes, 0);
  assert.equal((await call('/api/api-key', admin)).status, 401);
});
