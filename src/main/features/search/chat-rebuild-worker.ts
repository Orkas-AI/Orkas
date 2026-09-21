import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { historyRecordText } from '../chat-history-records';
import * as store from './chat_store';
import type { ChatRebuildFile, ChatRebuildBatch } from './chat-rebuild';

const uid: string = workerData.userId;
// Bound ordinary transactions by both record count and extracted characters.
// One oversized record stays atomic and searchable in full, on this worker.
const MAX_BATCH_CHARS = 256 * 1024;
let current: { file: ChatRebuildFile; messages: any[]; next: number; reset: boolean } | undefined;

function unchanged(file: ChatRebuildFile): boolean {
  try {
    const stat = fs.statSync(file.file);
    return stat.mtimeMs === file.mtime && stat.size === file.size;
  } catch { return false; }
}

function rebuildBatch(file: ChatRebuildFile): ChatRebuildBatch {
  if (!unchanged(file)) { current = undefined; return { valid: false, complete: false, next: 0 }; }
  if (!current || current.file.file !== file.file || current.file.mtime !== file.mtime || current.file.size !== file.size) {
    const lines = fs.readFileSync(file.file, 'utf8').split('\n');
    const messages: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* preserve legacy malformed-row handling */ }
    }
    if (!unchanged(file)) return { valid: false, complete: false, next: 0 };
    const cursor = store.readRebuildCursor(uid, file.fileKey);
    const resume = cursor && cursor.mtime === file.mtime && cursor.size === file.size
      && Number.isInteger(cursor.next) && cursor.next >= 0 && cursor.next <= messages.length;
    current = { file, messages, next: resume ? cursor.next : 0, reset: !resume };
  }
  const docs: store.ChatDocInput[] = [];
  let chars = 0;
  const start = current.next;
  while (current.next < current.messages.length && current.next - start < 16 && chars < MAX_BATCH_CHARS) {
    const i = current.next++;
    const msg = current.messages[i];
    const text = msg ? historyRecordText(msg, true) : '';
    if (text) {
      docs.push({ cid: file.fileKey, msgIndex: i, text,
        role: msg.from || msg.role || '', time: msg.ts || msg.time || '' });
      chars += text.length;
    }
  }
  const next = current.next;
  const complete = next === current.messages.length;
  store.writeRebuildBatch(uid, file.fileKey, docs,
    { mtime: file.mtime, size: file.size, next }, current.reset, complete);
  current.reset = false;
  const valid = unchanged(file);
  if (!valid) store.dropFileWatermark(uid, file.fileKey);
  if (complete || !valid) current = undefined;
  return { valid, complete, next };
}

parentPort!.on('message', (command) => {
  try {
    let value: unknown;
    if (command.kind === 'batch') value = rebuildBatch(command.file);
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
