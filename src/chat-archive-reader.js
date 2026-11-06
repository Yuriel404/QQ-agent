import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// The old writer placed chatKey and nextLocalId before the message array.
// Accept them in any order and validate the remaining metadata after the array.
const LEGACY_HEADER = /^\s*\{(?:\s*"(?:chatKey|nextLocalId)"\s*:\s*(?:"(?:\\.|[^"\\])*"|\d+)\s*,)*\s*"messages"\s*:\s*\[/;

function* readChunks(fd) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let size;
  while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
    yield decoder.write(buffer.subarray(0, size));
  }
  yield decoder.end();
}

// The delimiter scan only finds the end of each outer object. JSON.parse
// validates each complete row (including nested reply/media and escapes).
function* readLegacyRows(header, first, chunks) {
  let state = 'first', depth = 0, quoted = false, escaped = false;
  let parts = [], trailer = '';
  let chunk = first;
  while (true) {
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (state === 'done') { trailer += chunk.slice(i); break; }
      if (!depth) {
        if (' \t\r\n'.includes(ch)) continue;
        if ((state === 'first' || state === 'after') && ch === ']') { state = 'done'; continue; }
        if (state === 'after' && ch === ',') { state = 'next'; continue; }
        if (state === 'after' || ch !== '{') throw new SyntaxError('聊天存档包含无效的消息数组');
        start = i;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}' && --depth === 0) {
        parts.push(chunk.slice(start, i + 1));
        yield JSON.parse(parts.join(''));
        parts = [];
        start = -1;
        state = 'after';
      }
    }
    if (start !== -1) parts.push(chunk.slice(start));
    const next = chunks.next();
    if (next.done) break;
    chunk = next.value;
  }
  if (state !== 'done') throw new SyntaxError('聊天存档的消息数组不完整');
  return JSON.parse(header + ']' + trailer);
}

// Returns the manifest, or the legacy metadata after writing its rows through
// onLegacy. A malformed or truncated file never reaches manifest publication.
export function readChatFile(file, onLegacy) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const chunks = readChunks(fd);
    const first = chunks.next().value.replace(/^\uFEFF/, '');
    const header = LEGACY_HEADER.exec(first)?.[0];
    if (header) {
      const rows = readLegacyRows(header, first.slice(header.length), chunks);
      let next = rows.next();
      while (!next.done) { onLegacy(next.value); next = rows.next(); }
      return next.value;
    }
    // Manifests and externally reformatted legacy files with extra header keys.
    const saved = JSON.parse(first + Array.from(chunks).join(''));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('无法识别聊天存档格式');
    if (Array.isArray(saved.messages)) {
      for (const row of saved.messages) onLegacy(row);
      saved.messages = [];
    }
    return saved;
  } finally {
    fs.closeSync(fd);
  }
}
