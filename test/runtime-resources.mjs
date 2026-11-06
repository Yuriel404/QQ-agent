import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventStreams } from '../src/sse.js';
import { bootApp, waitFor } from './_harness.mjs';

// 模拟一个始终不读取数据的连接，以及同一广播上的正常连接。
class Client extends EventEmitter {
  constructor(slow) {
    super();
    this.slow = slow;
    this.writableLength = 0;
    this.writes = 0;
  }
  write(frame) {
    this.writes++;
    if (this.slow) {
      this.writableLength += Buffer.byteLength(frame);
      this.writableNeedDrain = true;
    }
    return !this.slow;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}
const streams = new EventStreams();
const slow = new Client(true);
const fast = new Client(false);
streams.add(slow);
streams.add(fast);
const frame = '汉'.repeat(32000);
for (let i = 0; i < 20; i++) streams.broadcast(frame);
assert.ok(slow.destroyed && !streams.clients.has(slow));
assert.ok(slow.writableLength <= 256 * 1024);
assert.equal(fast.writes, 21);
streams.close();
assert.equal(streams.clients.size, 0);

const env = await bootApp({
  config: { maxConcurrentRuns: 1, sessionRetryAttempts: 0 },
  script: [{ content: '完成', delayMs: 4000 }]
});
const { app, llm } = env;
const orch = app.orchestrator;
function enqueue(id) {
  const key = 'private:' + id;
  app.store.appendIncoming(key, { mid: id, ts: Date.now(), senderId: id, text: '排队回归' });
  orch.scheduleWake(key, 0, { verified: true });
  return orch.pendingSessions.get(key);
}
try {
  enqueue(7000);
  await waitFor(() => llm.state.requests.length > 0, 5000, '第一条请求占用并发名额');
  const queued = enqueue(7001);
  const cancelled = enqueue(7002);
  await waitFor(() => app.sessions.current.get(queued)?.waitUntil > Date.now() + 1500, 1500, '队满延后');
  assert.equal(orch.abortSession(cancelled).ok, true);
  const count = () => app.sessions.listSummaries(30).filter(s => s.chatKey === 'private:7001').length;
  await waitFor(() => !app.sessions.current.has(queued), 10000, '同一等待会话取得名额并完成');
  assert.equal(count(), 1);
  assert.equal(app.sessions.get(cancelled), null);
  assert.equal(orch.wakeTimers.size, 0);
  assert.equal(orch.pendingSessions.size, 0);

  llm.state.forceStatus.push(401);
  const failed = enqueue(7003);
  await waitFor(() => app.sessions.get(failed)?.status === 'error', 5000, '模型拒绝请求');
  assert.equal(orch.sessionAbortControllers.size, 0);
  assert.equal(orch.sessionAbortMarks.size, 0);
  assert.equal(orch.inFlight.size, 0);
} finally {
  await env.teardown();
}
console.log('通过：慢连接背压、排队复用、取消等待、失败请求资源释放');
