import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { buildChatProjection } from './chat-projection';
import { indexedJsonlStampFromStat } from '../../util/indexed-jsonl';
import * as store from './chat_store';
import type { ChatRebuildFile, ChatRebuildBatch, ChatLiveMessage } from './chat-rebuild';
import type { JsonlAppendSource } from '../../storage';

const uid: string = workerData.userId;
// Bound ordinary transactions by both record count and extracted characters.
// One oversized record stays atomic and searchable in full, on this worker.
const MAX_BATCH_CHARS = 256 * 1024;
let current: { file: ChatRebuildFile; messages: any[]; next: number; reset: boolean; stamp: string } | undefined;

function unchanged(file: ChatRebuildFile, stamp?: string): boolean {
  try {
    const stat = fs.statSync(file.file);
    return stat.mtimeMs === file.mtime && stat.size === file.size
      && (!stamp || indexedJsonlStampFromStat(stat) === stamp);
  } catch { return false; }
}

function rebuildBatch(file: ChatRebuildFile): ChatRebuildBatch {
  if (!unchanged(file, current?.file.file === file.file ? current.stamp : undefined)) { current = undefined; return { valid: false, complete: false, next: 0 }; }
  if (!current || current.file.file !== file.file || current.file.mtime !== file.mtime || current.file.size !== file.size) {
    const stamp = indexedJsonlStampFromStat(fs.statSync(file.file));
    const lines = fs.readFileSync(file.file, 'utf8').split('\n');
    const messages: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* preserve legacy malformed-row handling */ }
    }
    if (!unchanged(file, stamp)) return { valid: false, complete: false, next: 0 };
    const cursor = store.readRebuildCursor(uid, file.fileKey);
    const resume = cursor && cursor.mtime === file.mtime && cursor.size === file.size
      && (!cursor.projectionStamp || cursor.projectionStamp === stamp)
      && !!cursor.projectionOnly === !!file.projectionOnly
      && Number.isInteger(cursor.next) && cursor.next >= 0 && cursor.next <= messages.length;
    current = { file, messages, next: resume ? cursor.next : 0, reset: !resume, stamp };
  }
  const docs: store.ChatDocInput[] = [];
  let chars = 0;
  const start = current.next;
  while (current.next < current.messages.length && current.next - start < 16 && chars < MAX_BATCH_CHARS) {
    const i = current.next++;
    const msg = current.messages[i];
    const { text, payload } = buildChatProjection(msg);
    if (text) {
      docs.push({ cid: file.fileKey, msgIndex: i, text, projection: payload,
        role: msg.from || msg.role || '', time: msg.ts || msg.time || '' });
      chars += text.length;
    }
  }
  const next = current.next;
  const complete = next === current.messages.length;
  store.writeRebuildBatch(uid, file.fileKey, docs,
    { mtime: file.mtime, size: file.size, next }, current.reset, complete, current.stamp, !!file.projectionOnly);
  current.reset = false;
  const valid = unchanged(file, current.stamp);
  if (!valid) store.dropFileWatermark(uid, file.fileKey);
  if (complete || !valid) current = undefined;
  return { valid, complete, next };
}

function validSource(source: JsonlAppendSource): boolean {
  try {
    const stat = fs.statSync(source.file);
    return stat.dev === source.dev && stat.ino === source.ino && stat.size >= source.size
      && (stat.size > source.size || (stat.mtimeMs === source.mtime
        && (!source.stamp || indexedJsonlStampFromStat(stat) === source.stamp)))
      && source.offset + source.bytes === source.size;
  } catch { return false; }
}

function indexMessage(command: ChatLiveMessage): boolean {
  const source = command.source;
  const invalidate = () => {
    store.dropFileWatermark(uid, command.cid);
    store.writeSourceStamp(uid, undefined);
    return false;
  };
  let msg: any = command.message;
  if (source) {
    if (!validSource(source)) return invalidate();
    const fd = fs.openSync(source.file, 'r');
    try {
      const bytes = Buffer.allocUnsafe(source.bytes);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, source.offset + read);
        if (!count) return invalidate();
        read += count;
      }
      msg = JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
    if (!validSource(source)) return invalidate();
  }
  const { text, payload } = buildChatProjection(msg);
  const complete = store.writeLiveMessage(uid, command.cid, command.msgIndex,
    text ? { cid: command.cid, msgIndex: command.msgIndex, text, projection: payload,
      role: msg.from || msg.role || '', time: msg.ts || msg.time || '' } : undefined,
    source ? { mtime: source.mtime, size: source.size, next: command.msgIndex + 1 } : command.mark,
    source ? { size: source.offset, mtime: source.beforeMtime } : undefined,
    source?.stamp ? { beforeStamp: source.beforeStamp, stamp: source.stamp } : undefined);
  return source && !validSource(source) ? invalidate() : complete;
}

parentPort!.on('message', (command) => {
  try {
    let value: unknown;
    if (command.kind === 'batch') value = rebuildBatch(command.file);
    else if (command.kind === 'live') value = indexMessage(command);
    else if (command.kind === 'invalidate') {
      if (command.cid) store.dropFileWatermark(uid, command.cid);
      store.writeSourceStamp(uid, undefined);
    } else if (command.kind === 'delete') store.deleteConversation(uid, command.cid);
    else if (command.kind === 'compact') store.compact(uid);
    else if (command.kind === 'complete') store.markRebuildComplete(uid, command.stamp);
    else if (command.kind === 'prune') {
      const seen = new Set<string>(command.seen);
      let deleted = 0;
      for (const cid of store.indexedConversationIds(uid)) {
        if (!seen.has(cid)) { store.deleteConversation(uid, cid); deleted++; }
      }
      value = deleted;
    } else if (command.kind === 'close') {
      current = undefined;
      store.closeAllChatStores();
    } else throw new Error('Unknown chat rebuild command');
    parentPort!.postMessage({ ok: true, value });
  } catch {
    // The host retries from the committed cursor with a new worker. Never
    // forward source records or paths embedded in parser/native exceptions.
    parentPort!.postMessage({ ok: false });
  }
});
