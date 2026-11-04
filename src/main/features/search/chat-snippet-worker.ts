import { parentPort } from 'node:worker_threads';
import { indexedJsonlStamp, mapIndexedJsonlRecords } from '../../util/indexed-jsonl';
import { projectChatSnippet, type ChatSnippet } from './snippet';
import { readChatProjection } from './chat_store';
import { projectEncodedChatSnippet } from './chat-projection';

type Rows = Array<[number, ChatSnippet | undefined]>;
const cache = new Map<string, { stamp: string; rows: Rows; bytes: number }>();
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
let cacheBytes = 0;
let chain = Promise.resolve();

function forget(key: string): void {
  cacheBytes -= cache.get(key)?.bytes || 0;
  cache.delete(key);
}

// Serialized source reads bound raw-record memory. Cache only small rendered
// projections, never full execution trails, and validate source identity on
// every use so append, sync replacement and deletion cannot serve stale text.
parentPort!.on('message', (request: { id: number; file: string; indexes: number[]; tokens: string[]; source?: { userId: string; cid: string }; cancellation?: SharedArrayBuffer }) => {
  chain = chain.then(async () => {
    let rows: Rows = [];
    const flag = request.cancellation && new Int32Array(request.cancellation);
    const signal = { get aborted() { return !!flag && Atomics.load(flag, 0) !== 0; } };
    try {
      if (signal.aborted) return;
      const stamp = await indexedJsonlStamp(request.file);
      const key = JSON.stringify([request.source?.userId, request.file, request.indexes, request.tokens]);
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp) {
        cache.delete(key); cache.set(key, hit);
        rows = hit.rows;
      } else {
        forget(key);
        const projected = new Map<number, ChatSnippet | undefined>();
        if (stamp && request.source) {
          for (const index of request.indexes) {
            if (signal.aborted) return;
            try {
              const payload = readChatProjection(request.source.userId, request.source.cid, index, stamp);
              const snippet = payload && projectEncodedChatSnippet(payload, request.tokens);
              if (snippet) projected.set(index, snippet);
            } catch { /* A cache failure must preserve source retrieval. */ }
          }
        }
        const missing = new Set(request.indexes.filter(index => !projected.has(index)));
        for (const [index, snippet] of await mapIndexedJsonlRecords(request.file, missing,
          message => projectChatSnippet(message, request.tokens), signal)) projected.set(index, snippet);
        rows = [...projected];
        if (stamp !== await indexedJsonlStamp(request.file)) rows = [];
        else if (stamp && rows.length) {
          const bytes = 2 * (key.length + JSON.stringify(rows).length);
          if (bytes <= MAX_CACHE_BYTES) {
            while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES)) {
              forget(cache.keys().next().value!);
            }
            cache.set(key, { stamp, rows, bytes }); cacheBytes += bytes;
          }
        }
      }
    } catch {
      // Missing/changing sources retain the existing partial-coverage result.
      rows = [];
    }
    parentPort!.postMessage({ id: request.id, rows });
  });
});
