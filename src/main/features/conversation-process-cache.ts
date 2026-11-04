/** Worker-owned, clearable process pages. Canonical history remains lossless;
 * the transcript carries opaque account/conversation-scoped references only. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GroupMessage } from './group_chat/visibility';

export type HistoryProcessPart = { ref: string; count: number; message_id?: string } | { items: NonNullable<GroupMessage['process']> };
export const PROCESS_PAGE_ITEMS = 200;
export const DEFER_PROCESS_ITEMS = 1000;
export const PROCESS_PAGE_BYTES = 1024 * 1024;
// Legacy cursors name 200-event groups. New cursors name byte-bounded pages.
// A separate numeric range preserves an already-mounted legacy disclosure.
const BYTE_CURSOR_BASE = 1_000_000;
export const PROCESS_PAGE_REBUILD = 'E_PROCESS_PAGE_REBUILD';
type Index = { offsets: number[]; bytes: number; count: number; version?: 2; legacyPages?: number[] };
type ProcessItems = NonNullable<GroupMessage['process']>;

/** Amortize tiny hash updates without retaining a whole record. The byte
 * budget covers pending UTF-8 payload, not JS heap; long existing chunks pass
 * through directly. Also cap fragment overhead for punctuation-heavy data. */
function processHash() {
  const hash = createHash('sha256');
  let chunks: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (chunks.length) hash.update(chunks.join(''));
    chunks = []; bytes = 0;
  };
  return {
    update(chunk: string): void {
      const size = Buffer.byteLength(chunk);
      if (!size) return;
      if (size > 16 * 1024) { flush(); hash.update(chunk); return; }
      if (bytes + size > 16 * 1024 || chunks.length >= 256) flush();
      chunks.push(chunk); bytes += size;
    },
    digest(): string { flush(); return hash.digest('hex'); },
  };
}

/** Slice text without bisecting a surrogate pair; each UTF-8 buffer is small. */
export function* processTextChunks(text: string): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 16 * 1024, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    yield text.slice(start, end); start = end;
  }
}

/** Canonical process records are JSON data. Stream their native JSON spelling
 * rather than constructing a 200-output string just to hash/cache it. */
function* jsonChunks(value: any, key = '', seen = new Set<object>(), prepared = false): Generator<string> {
  if (!prepared && value && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (typeof value === 'string') {
    // At most 12290 UTF-8 bytes even if every code unit needs JSON escaping.
    if (value.length <= 2048) { yield JSON.stringify(value); return; }
    yield '"';
    for (const chunk of processTextChunks(value)) yield JSON.stringify(chunk).slice(1, -1);
    yield '"'; return;
  }
  if (!value || typeof value !== 'object') { yield JSON.stringify(value) ?? 'null'; return; }
  if (seen.has(value)) throw new TypeError('Circular process data');
  seen.add(value);
  try {
    const array = Array.isArray(value);
    yield array ? '[' : '{';
    let separator = '';
    const keys = array ? (function* () { for (let n = 0; n < value.length; n++) yield String(n); })() : Object.keys(value);
    for (const name of keys) {
      let child = value[name];
      if (child && typeof child.toJSON === 'function') child = child.toJSON(name);
      if (!array && (child === undefined || typeof child === 'function' || typeof child === 'symbol')) continue;
      yield separator; separator = ',';
      if (!array) { yield* jsonChunks(name); yield ':'; }
      yield* jsonChunks(child, name, seen, true);
    }
    yield array ? ']' : '}';
  } finally { seen.delete(value); }
}

function boundedJson(value: unknown): string {
  const chunks: string[] = [];
  let bytes = 0;
  for (const chunk of jsonChunks(value)) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > PROCESS_PAGE_BYTES - 3) throw new Error('Process item requires bounded projection');
    chunks.push(chunk);
  }
  return chunks.join('');
}

/** Preserve the structural receipts the renderer uses for terminal identity,
 * routing-only visibility and commentary-only segments. Details stay in pages. */
export function processSummary(items: NonNullable<GroupMessage['process']>): NonNullable<GroupMessage['process']> {
  const summary: NonNullable<GroupMessage['process']> = [];
  const seen = new Set<string>();
  const runtime = new Map<string, { index: number; item: any }>();
  let commentary = false;
  for (const [index, item] of (items as any[]).entries()) {
    const event = item?.event;
    const data = event?.data;
    if (event?.stream === 'runtime') {
      runtime.set('latest', { index, item });
      if (data?.phase === 'end') runtime.set('terminal', { index, item });
      const duration = data?.bubble_duration_ms ?? data?.duration_ms ?? data?.durationMs ?? data?.elapsedMs;
      if (duration != null && Number.isFinite(Number(duration))) runtime.set('duration', { index, item });
      continue;
    }
    if (!commentary && item?.type === 'progress' && event?.stream === 'assistant' && data?.phase === 'commentary') {
      commentary = true;
      summary.push(item);
    }
    if (!data || (event?.stream !== 'tool' && !(event?.stream === 'cli' && data.type === 'tool-event'))) continue;
    const receipt = { type: data.type, phase: data.phase, status: data.status,
      name: data.name, tool: data.tool, toolName: data.toolName, isError: data.isError };
    const key = event.stream + JSON.stringify(receipt);
    if (seen.has(key)) continue;
    seen.add(key);
    summary.push({ type: 'event', event: { stream: event.stream, data: receipt } });
  }
  const receipts = new Map([...runtime.values()].map(value => [value.index, value.item]));
  for (const [, item] of [...receipts].sort((a, b) => a[0] - b[0])) summary.push(item);
  return summary;
}

export function processCacheDirectory(entryDir: string): string {
  return path.join(entryDir, 'process-records');
}

/** Allows a compact transcript to survive unavailable cache storage. Once
 * storage recovers, the same content address can be rebuilt on disclosure. */
export function processPageReference(items: NonNullable<GroupMessage['process']>): string {
  const hash = processHash();
  for (let n = 0; n < items.length; n++) {
    hash.update(n % PROCESS_PAGE_ITEMS === 0 ? '[' : ',');
    for (const chunk of jsonChunks(items[n], String(n % PROCESS_PAGE_ITEMS))) hash.update(chunk);
    if ((n + 1) % PROCESS_PAGE_ITEMS === 0 || n + 1 === items.length) hash.update(']\n');
  }
  return hash.digest();
}

/** One pass, bounded serialization buffers and sparse page offsets. Raw
 * outputs are projected only when the corresponding process page is opened. */
export function storeProcessPages(entryDir: string, items: ProcessItems,
  projectLargeItem?: (item: ProcessItems[number]) => Iterable<ProcessItems[number]>): HistoryProcessPart {
  const directory = processCacheDirectory(entryDir);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  const hash = processHash();
  const offsets: number[] = [];
  const legacyPages: number[] = [];
  let bytes = 0;
  let page: string[] = [];
  let pageBytes = 3;
  const flush = (force = false) => {
    if (!page.length && !force) return;
    offsets.push(bytes);
    const buffer = Buffer.from('[' + page.join(',') + ']\n');
    let written = 0;
    while (written < buffer.length) {
      const count = fs.writeSync(fd, buffer, written, buffer.length - written);
      if (count <= 0) throw new Error('Process cache write did not advance');
      written += count;
    }
    bytes += buffer.length; page = []; pageBytes = 3;
  };
  const append = (json: string) => {
    const size = Buffer.byteLength(json);
    if (page.length && (page.length === PROCESS_PAGE_ITEMS || pageBytes + size + 1 > PROCESS_PAGE_BYTES)) flush();
    pageBytes += size + (page.length ? 1 : 0); page.push(json);
  };
  try {
    for (let n = 0; n < items.length; n++) {
      if (n % PROCESS_PAGE_ITEMS === 0) {
        if (n) flush(offsets.length === legacyPages.at(-1));
        legacyPages.push(offsets.length); hash.update('[');
      }
      else hash.update(',');
      let size = 0;
      let chunks: string[] = [];
      for (const chunk of jsonChunks(items[n], String(n % PROCESS_PAGE_ITEMS))) {
        hash.update(chunk); size += Buffer.byteLength(chunk);
        if (size <= PROCESS_PAGE_BYTES - 3) chunks.push(chunk);
        else chunks = [];
      }
      if (size <= PROCESS_PAGE_BYTES - 3) append(chunks.join(''));
      else {
        if (!projectLargeItem) throw new Error('Process item requires bounded projection');
        for (const item of projectLargeItem(items[n])) append(boundedJson(item));
      }
      if ((n + 1) % PROCESS_PAGE_ITEMS === 0 || n + 1 === items.length) hash.update(']\n');
    }
    flush(items.length > 0 && offsets.length === legacyPages.at(-1));
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  const ref = hash.digest();
  const destination = path.join(directory, ref + '.v2.jsonl');
  try {
    if (!fs.existsSync(destination)) fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
  const indexFile = path.join(directory, ref + '.v2.json');
  if (!fs.existsSync(indexFile)) {
    const indexTemporary = indexFile + '.' + randomUUID() + '.tmp';
    try {
      const index = JSON.stringify({ version: 2, offsets, legacyPages, bytes, count: items.length });
      if (Buffer.byteLength(index) > 4 * 1024 * 1024) throw new Error('Process index too large');
      fs.writeFileSync(indexTemporary, index, { mode: 0o600 });
      fs.renameSync(indexTemporary, indexFile);
    } finally { fs.rmSync(indexTemporary, { force: true }); }
  }
  return { ref, count: items.length };
}

export async function readProcessPage(entryDir: string, ref: string, cursor = 0): Promise<{
  items: NonNullable<GroupMessage['process']>; nextCursor: number | null;
}> {
  if (!/^[a-f0-9]{64}$/.test(ref) || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('Invalid process page');
  }
  const directory = processCacheDirectory(entryDir);
  let indexFile = path.join(directory, ref + '.v2.json');
  let stat;
  try { stat = await fsp.lstat(indexFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    indexFile = path.join(directory, ref + '.json'); stat = await fsp.lstat(indexFile);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid process index');
  const index: Index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  const version2 = index.version === 2;
  if (indexFile.endsWith('.v2.json') && (!version2 || !Array.isArray(index.legacyPages))) throw new Error('Invalid process index');
  const pageCursor = version2 ? (cursor >= BYTE_CURSOR_BASE ? cursor - BYTE_CURSOR_BASE : index.legacyPages?.[cursor]) : cursor;
  if (!Array.isArray(index.offsets) || !Number.isSafeInteger(pageCursor) || pageCursor! < 0 || pageCursor! >= index.offsets.length
      || !Number.isSafeInteger(index.bytes) || index.bytes < 0) throw new Error('Invalid process cursor');
  const start = index.offsets[pageCursor!];
  const end = index.offsets[pageCursor! + 1] ?? index.bytes;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('Invalid process range');
  }
  if (end - start > PROCESS_PAGE_BYTES) {
    if (!version2) throw Object.assign(new Error('Process cache rebuild required'), { code: PROCESS_PAGE_REBUILD });
    throw new Error('Invalid process range');
  }
  const dataFile = path.join(directory, ref + (version2 ? '.v2.jsonl' : '.jsonl'));
  const dataStat = await fsp.lstat(dataFile);
  if (!dataStat.isFile() || dataStat.isSymbolicLink()) throw new Error('Invalid process data');
  const file = await fsp.open(dataFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const openedStat = await file.stat();
    if (!openedStat.isFile() || end > openedStat.size) throw new Error('Process page unavailable');
    const buffer = Buffer.allocUnsafe(end - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) throw new Error('Process page unavailable');
      read += bytesRead;
    }
    const items = JSON.parse(buffer.toString('utf8'));
    if (!Array.isArray(items) || items.length > PROCESS_PAGE_ITEMS) throw new Error('Invalid process page');
    return { items, nextCursor: pageCursor! + 1 < index.offsets.length ? (version2 ? BYTE_CURSOR_BASE : 0) + pageCursor! + 1 : null };
  } finally {
    await file.close();
  }
}
