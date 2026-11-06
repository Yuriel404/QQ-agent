// 对已经产生背压的连接限制后续排队量。空闲连接仍能收到单个大型会话快照。
const MAX_QUEUED_BYTES = 256 * 1024;

export class EventStreams {
  clients = new Map();

  add(res, isAuthorized) {
    this.clients.set(res, isAuthorized);
    const heartbeat = setInterval(() => {
      if (res.writableNeedDrain) res.destroy();
      else this.write(res, ': ping\n\n');
    }, 15000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    res.once('close', cleanup);
    res.once('error', () => { cleanup(); res.destroy(); });
    this.write(res, 'event: hello\ndata: {}\n\n');
  }

  write(res, frame, bytes = Buffer.byteLength(frame)) {
    if (res.destroyed || res.writableEnded) return;
    if (this.clients.get(res)?.() === false) {
      res.destroy();
      return;
    }
    if (res.writableNeedDrain && res.writableLength + bytes > MAX_QUEUED_BYTES) {
      res.destroy();
      return;
    }
    try { res.write(frame); } catch { res.destroy(); }
  }

  broadcast(frame) {
    const bytes = Buffer.byteLength(frame);
    for (const res of this.clients.keys()) this.write(res, frame, bytes);
  }

  close() {
    for (const res of this.clients.keys()) res.destroy();
    this.clients.clear();
  }
}
