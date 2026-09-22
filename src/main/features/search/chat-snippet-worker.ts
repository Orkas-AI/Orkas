import { parentPort } from 'node:worker_threads';
import { indexedJsonlStamp, mapIndexedJsonlRecords } from '../../util/indexed-jsonl';
import { projectChatSnippet, type ChatSnippet } from './snippet';

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
parentPort!.on('message', (request: { id: number; file: string; indexes: number[]; tokens: string[] }) => {
  chain = chain.then(async () => {
    let rows: Rows = [];
    try {
      const stamp = await indexedJsonlStamp(request.file);
      const key = JSON.stringify([request.file, request.indexes, request.tokens]);
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp) {
        cache.delete(key); cache.set(key, hit);
        rows = hit.rows;
      } else {
        forget(key);
        rows = [...await mapIndexedJsonlRecords(request.file, new Set(request.indexes),
          message => projectChatSnippet(message, request.tokens))];
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
