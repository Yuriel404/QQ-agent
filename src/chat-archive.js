import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readChatFile } from './chat-archive-reader.js';

const DIR = path.join(DATA_DIR, 'messages');
const PAGE_ROWS = 128;
const PAGE_BYTES = 256 * 1024;
const PAGE_NAME = /^[0-9a-f-]{36}\.json$/;

export function listArchivedChats() {
  try {
    return fs.readdirSync(DIR).flatMap((name) => {
      const match = /^(group|private)_(\d+)\.json$/.exec(name);
      return match ? [`${match[1]}:${match[2]}`] : [];
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// One synchronous operation owns an archive at a time in the bot process.
// Only the manifest and the page currently being processed live in memory.
export class ChatArchive {
  constructor(chatKey) {
    const name = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
    this.file = path.join(DIR, `${name}.json`);
    this.dir = path.join(DIR, `${name}.pages`);
    this.marker = path.join(this.dir, '.dirty');
    this.retired = [];
    this.dirty = false;
    this.meta = { version: 2, chatKey, nextLocalId: 1, total: 0, unread: 0, lastText: '', lastTs: 0, pages: [] };

    let rows = [], bytes = 2;
    const saved = readChatFile(this.file, (row) => {
      if (!this.dirty) this.startMigration();
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (rows.length && (rows.length >= PAGE_ROWS || bytes + size > PAGE_BYTES)) {
        this.replace(this.pages.length, rows);
        rows = [];
        bytes = 2;
      }
      rows.push(row);
      bytes += size;
    });
    if (saved && Array.isArray(saved.messages)) {
      if (!this.dirty) this.startMigration();
      if (rows.length) this.replace(this.pages.length, rows);
      const firstAvailable = (this.pages.at(-1)?.lastId ?? 0) + 1;
      const counter = Number(saved.nextLocalId);
      this.meta.nextLocalId = Number.isSafeInteger(counter) && counter >= firstAvailable ? counter : firstAvailable;
      this.commit();
      return;
    }
    if (saved) {
      if (saved.version !== 2 || !Array.isArray(saved.pages)) throw new Error('无法识别聊天存档格式');
      this.meta = saved;
    }
    // A killed process can leave page files on either side of the atomic rename.
    if (fs.existsSync(this.marker)) this.recover();
  }

  startMigration() {
    if (fs.existsSync(this.marker)) this.recover();
    this.begin();
  }

  get pages() { return this.meta.pages; }

  pagePath(page) {
    if (!PAGE_NAME.test(page.file)) throw new Error('无效的聊天存档分页');
    return path.join(this.dir, page.file);
  }

  read(page) {
    return JSON.parse(fs.readFileSync(this.pagePath(page), 'utf8'));
  }

  begin() {
    if (this.dirty) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.marker, '');
    this.dirty = true;
  }

  recover() {
    const live = new Set(this.pages.map((p) => p.file));
    for (const name of fs.readdirSync(this.dir)) {
      if (name === 'manifest.tmp' || (PAGE_NAME.test(name) && !live.has(name))) {
        fs.unlinkSync(path.join(this.dir, name));
      }
    }
    fs.unlinkSync(this.marker);
  }

  replace(index, rows) {
    this.begin();
    const previous = this.pages[index];
    if (previous) {
      this.meta.total -= previous.count;
      this.meta.unread -= previous.unread;
      this.retired.push(this.pagePath(previous));
    }
    if (rows.length) {
      const data = JSON.stringify(rows);
      const page = { file: `${randomUUID()}.json`, bytes: Buffer.byteLength(data), count: rows.length,
        incoming: 0, pending: 0, unread: 0, firstId: rows[0].id, lastId: rows.at(-1).id, minTs: Infinity, maxTs: -Infinity };
      for (const row of rows) {
        if (!row.read) page.pending++;
        if (!row.self) {
          page.incoming++;
          if (!row.read) page.unread++;
        }
        page.minTs = Math.min(page.minTs, row.ts);
        page.maxTs = Math.max(page.maxTs, row.ts);
      }
      fs.writeFileSync(this.pagePath(page), data, { flag: 'wx' });
      this.pages[index] = page;
      this.meta.total += page.count;
      this.meta.unread += page.unread;
      if (index === this.pages.length - 1) this.setLast(rows.at(-1));
    } else {
      this.pages.splice(index, 1);
      // Defer looking up the new last row until all removals finish.
      if (index === this.pages.length) this.lastUnknown = true;
    }
  }

  setLast(row) {
    this.meta.lastTs = row?.ts ?? 0;
    this.meta.lastText = row?.text ?? '';
    this.lastUnknown = false;
  }

  append(entry, cap) {
    entry.id = this.meta.nextLocalId++;
    const tail = this.pages.at(-1);
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (tail && tail.count < PAGE_ROWS && tail.bytes + size <= PAGE_BYTES) {
      this.replace(this.pages.length - 1, [...this.read(tail), entry]);
    } else {
      this.replace(this.pages.length, [entry]);
    }
    while (cap > 0 && this.meta.total > Math.ceil(cap)) {
      const head = this.pages[0];
      const excess = this.meta.total - Math.ceil(cap);
      this.replace(0, excess >= head.count ? [] : this.read(head).slice(excess));
    }
    this.commit();
    return entry;
  }

  commit() {
    if (!this.dirty) return;
    if (this.lastUnknown) {
      const tail = this.pages.at(-1);
      this.setLast(tail && this.read(tail).at(-1));
    }
    const tmp = path.join(this.dir, 'manifest.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.meta));
    fs.renameSync(tmp, this.file);
    // After publication the mutation succeeded. Leave the marker for recovery
    // if cleanup fails, so callers never retry an already committed append.
    try {
      for (const file of this.retired) fs.unlinkSync(file);
      fs.unlinkSync(this.marker);
    } catch { /* recovered on next open */ }
    this.dirty = false;
    this.retired = [];
  }
}
