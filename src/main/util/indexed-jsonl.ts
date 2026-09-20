/** Read-only JSONL offset indexes. Cache metadata, never full transcript bodies.
 * Known atomic appends extend the index. Rewrites, sync and external changes
 * invalidate it by source identity. Bounded reads seek directly to records. */
import * as fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';

export type IndexedJsonlEntry<T> = { index: number; offset: number; bytes: number; metadata: T };
export type IndexedJsonl<T> = { stamp: string; entries: IndexedJsonlEntry<T>[] };
type Cache = IndexedJsonl<unknown> & { project: (record: any) => unknown; terminated: boolean; size: number };
const cache = new Map<string, Cache>();
const pending = new Map<string, Promise<Cache>>();
const MAX_CACHED_FILES = 32;
function stampOf(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
export async function indexedJsonlStamp(file: string): Promise<string> {
  try { return stampOf(await fs.stat(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export async function getIndexedJsonl<T>(file: string, project: (record: any) => T): Promise<IndexedJsonl<T>> {
  const stamp = await indexedJsonlStamp(file);
  const hit = cache.get(file);
  if (hit?.stamp === stamp && hit.project === project) return hit as IndexedJsonl<T>;
  if (pending.has(file)) { await pending.get(file); return getIndexedJsonl(file, project); }
  const task = (async (): Promise<Cache> => {
    const entries: IndexedJsonlEntry<T>[] = [];
    let offset = 0;
    let pendingBytes = 0;
    let pieces: Buffer[] = [];
    const acceptLine = (line: Buffer) => {
      try {
        const record = JSON.parse(line.toString('utf8'));
        entries.push({ index: entries.length, offset, bytes: line.length, metadata: project(record) });
      } catch { /* Same valid-record numbering as storage.readJsonlWindow. */ }
    };
    if (stamp) for await (const raw of createReadStream(file)) {
      const chunk = raw as Buffer;
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        const fragment = chunk.subarray(start, end);
        const lineBytes = pendingBytes + fragment.length;
        // Join a long JSONL record once, not once per incoming chunk.
        acceptLine(pieces.length ? Buffer.concat([...pieces, fragment], lineBytes) : fragment);
        offset += lineBytes + 1;
        pendingBytes = 0;
        pieces = [];
        start = end + 1;
      }
      if (start < chunk.length) {
        pieces.push(chunk.subarray(start));
        pendingBytes += chunk.length - start;
      }
    }
    const terminated = pendingBytes === 0;
    if (pendingBytes) acceptLine(Buffer.concat(pieces, pendingBytes));
    if (await indexedJsonlStamp(file) !== stamp) throw new Error('Conversation changed during history indexing; retry the read.');
    const result = { stamp, entries, project, terminated, size: offset + pendingBytes };
    cache.delete(file);
    if (cache.size >= MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
    cache.set(file, result);
    return result;
  })();
  pending.set(file, task);
  try { return await task as IndexedJsonl<T>; } finally { pending.delete(file); }
}

/** Called under storage's append lock. A verified pre-append stamp is required;
 * never infer append-only behavior merely because a rewritten file grew. */
export async function prepareIndexedJsonlAppend(file: string): Promise<(record: unknown, bytes: number) => Promise<void>> {
  const prior = cache.get(file);
  if (!prior) return async () => {};
  let valid = false;
  try { valid = prior.terminated && prior.stamp === await indexedJsonlStamp(file); } catch { cache.delete(file); }
  return async (record, bytes) => {
    try {
      if (!valid || cache.get(file) !== prior) { cache.delete(file); return; }
      const stat = await fs.stat(file);
      if (stat.size !== prior.size + bytes) { cache.delete(file); return; }
      const entry = { index: prior.entries.length, offset: prior.size, bytes: bytes - 1, metadata: prior.project(record) };
      prior.entries.push(entry);
      cache.set(file, { ...prior, size: stat.size, stamp: stampOf(stat) });
    } catch { cache.delete(file); } // Cache failure must never turn a committed append into a retry.
  };
}

export async function readIndexedJsonlRecords<T>(file: string, index: IndexedJsonl<unknown>, entries: readonly IndexedJsonlEntry<unknown>[]): Promise<T[]> {
  if (!entries.length) return [];
  if (await indexedJsonlStamp(file) !== index.stamp) throw new Error('Conversation changed; retry the history lookup.');
  const handle = await fs.open(file, 'r');
  try {
    const records: T[] = [];
    for (const entry of entries) {
      const bytes = Buffer.allocUnsafe(entry.bytes);
      let read = 0;
      while (read < bytes.length) {
        const result = await handle.read(bytes, read, bytes.length - read, entry.offset + read);
        if (!result.bytesRead) throw new Error('Conversation record is incomplete; retry the history lookup.');
        read += result.bytesRead;
      }
      records.push(JSON.parse(bytes.toString('utf8')));
    }
    if (await indexedJsonlStamp(file) !== index.stamp) throw new Error('Conversation changed; retry the history lookup.');
    return records;
  } finally { await handle.close(); }
}
