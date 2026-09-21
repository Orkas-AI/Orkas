/** Read-only JSONL offset indexes. Cache metadata, never full transcript bodies.
 * Known atomic appends extend the index. Rewrites, sync and external changes
 * invalidate it by source identity. Bounded reads seek directly to records. */
import * as fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';

export type IndexedJsonlEntry<T> = { index: number; offset: number; bytes: number; metadata: T };
export type IndexedJsonl<T> = { stamp: string; entries: IndexedJsonlEntry<T>[] };
type Cache = IndexedJsonl<unknown> & { project: (record: any) => unknown; terminated: boolean; size: number; complete: boolean };
const cache = new Map<string, Cache>();
const pending = new Map<string, Promise<Cache>>();
// A search can hit 200 conversations. A 32-file cache evicts its own working
// set before the next query. Bound lightweight offsets by files AND entries.
const MAX_CACHED_FILES = 512;
const MAX_CACHED_ENTRIES = 50_000;
let cachedEntries = 0;
function forget(file: string): void {
  cachedEntries -= cache.get(file)?.entries.length || 0;
  cache.delete(file);
}
function remember(file: string, value: Cache): void {
  forget(file);
  if (value.entries.length > MAX_CACHED_ENTRIES) return;
  while (cache.size && (cache.size >= MAX_CACHED_FILES || cachedEntries + value.entries.length > MAX_CACHED_ENTRIES)) {
    forget(cache.keys().next().value!);
  }
  cache.set(file, value);
  cachedEntries += value.entries.length;
}
function stampOf(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
export async function indexedJsonlStamp(file: string): Promise<string> {
  try { return stampOf(await fs.stat(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export async function getIndexedJsonl<T>(file: string, project: (record: any) => T, options: {
  throughIndex?: number;
  visit?: (record: any, index: number) => void;
} = {}): Promise<IndexedJsonl<T>> {
  const through = options.throughIndex ?? Infinity;
  const stamp = await indexedJsonlStamp(file);
  const hit = cache.get(file);
  const reusable = hit?.stamp === stamp && hit.project === project;
  if (reusable && (hit.complete || hit.entries.length > through)) {
    cache.delete(file); cache.set(file, hit);
    return hit as IndexedJsonl<T>;
  }
  if (pending.has(file)) { await pending.get(file); return getIndexedJsonl(file, project, options); }
  const task = (async (): Promise<Cache> => {
    const entries = reusable ? hit.entries.slice() as IndexedJsonlEntry<T>[] : [];
    let offset = reusable ? hit.size : 0;
    let pendingBytes = 0;
    let pieces: Buffer[] = [];
    const acceptLine = (line: Buffer) => {
      let record: any;
      try {
        record = JSON.parse(line.toString('utf8'));
        entries.push({ index: entries.length, offset, bytes: line.length, metadata: project(record) });
      } catch { return; } // Same valid-record numbering as storage.readJsonlWindow.
      options.visit?.(record, entries.length - 1);
    };
    let complete = true;
    if (stamp) {
      const stream = createReadStream(file, { start: offset });
      const closed = new Promise<void>(resolve => stream.once('close', resolve));
      try {
        scan: for await (const raw of stream) {
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
            if (entries.length > through) { complete = false; break scan; }
          }
          if (start < chunk.length) {
            pieces.push(chunk.subarray(start));
            pendingBytes += chunk.length - start;
          }
        }
      } finally {
        // Breaking async iteration destroys the stream but does not await its
        // descriptor closing. Callers may immediately replace/delete history.
        stream.destroy();
        await closed;
      }
    }
    const terminated = pendingBytes === 0;
    if (pendingBytes) acceptLine(Buffer.concat(pieces, pendingBytes));
    if (await indexedJsonlStamp(file) !== stamp) throw new Error('Conversation changed during history indexing; retry the read.');
    const result = { stamp, entries, project, terminated, size: offset + pendingBytes, complete };
    remember(file, result);
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
  try { valid = prior.complete && prior.terminated && prior.stamp === await indexedJsonlStamp(file); } catch { forget(file); }
  return async (record, bytes) => {
    try {
      if (!valid || cache.get(file) !== prior) { forget(file); return; }
      const stat = await fs.stat(file);
      if (stat.size !== prior.size + bytes) { forget(file); return; }
      const entry = { index: prior.entries.length, offset: prior.size, bytes: bytes - 1, metadata: prior.project(record) };
      forget(file);
      prior.entries.push(entry);
      remember(file, { ...prior, size: stat.size, stamp: stampOf(stat) });
    } catch { forget(file); } // Cache failure must never turn a committed append into a retry.
  };
}

export async function readIndexedJsonlRecords<T>(file: string, index: IndexedJsonl<unknown>, entries: readonly IndexedJsonlEntry<unknown>[], project: (record: any, index: number) => T = record => record): Promise<T[]> {
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
      records.push(project(JSON.parse(bytes.toString('utf8')), entry.index));
    }
    if (await indexedJsonlStamp(file) !== index.stamp) throw new Error('Conversation changed; retry the history lookup.');
    return records;
  } finally { await handle.close(); }
}

const offsetOnly = () => undefined;

/** Project selected records during a cold prefix scan, or seek them directly
 * from cached offsets. Never parse the requested rows a second time on cold
 * search, nor retain their large source bodies after projection. */
export async function mapIndexedJsonlRecords<T>(file: string, indexes: ReadonlySet<number>, project: (record: any, index: number) => T): Promise<Map<number, T>> {
  const wanted = [...indexes].filter(index => Number.isInteger(index) && index >= 0);
  const out = new Map<number, T>();
  if (!wanted.length) return out;
  const index = await getIndexedJsonl(file, offsetOnly, {
    throughIndex: Math.max(...wanted),
    visit: (record, position) => { if (indexes.has(position)) out.set(position, project(record, position)); },
  });
  const remaining = wanted.filter(position => !out.has(position)).map(position => index.entries[position]).filter(Boolean);
  await readIndexedJsonlRecords(file, index, remaining, (record, position) => { out.set(position, project(record, position)); });
  return out;
}
