import { prepareIndexedJsonlAppend } from './util/indexed-jsonl';
/**
 * Timestamps, ID generation, and JSON/JSONL IO helpers.
 *
 * 1:1 port of `biz/storage.py`, with one upgrade:
 *   - writeJson() is atomic (tmp + rename). Python version wasn't.
 *
 * No business logic — safe to require from any module.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Mutex, type MutexInterface } from 'async-mutex';

// ── Timestamps / IDs ─────────────────────────────────────────────────────

/** Local-time ISO8601 down to seconds, no TZ suffix (matches Python `now_iso`),
 *  for an explicit instant. Records that describe something that happened
 *  earlier than their write (a streamed message flushed at the next boundary)
 *  stamp the moment it happened, not the moment it was persisted. */
export function localIsoAt(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local-time ISO8601 down to seconds, no TZ suffix (matches Python `now_iso`). */
export function nowIso(): string {
  return localIsoAt(new Date());
}

/** UUID v4 local user id: 32 lowercase hexadecimal characters without hyphens. */
export function genUserId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 12-hex-char id (agents + conversations). */
export function genId12(): string {
  return crypto.randomBytes(6).toString('hex');
}

export const genAgentId = genId12;
export const genConversationId = genId12;

/**
 * Path-traversal / shell-injection guard for URL-supplied IDs.
 * Only alphanumeric plus `-` and `_` pass.
 */
export function safeId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

// ── JSON / JSONL IO ──────────────────────────────────────────────────────

/** Tolerant by default. Authoritative lookups opt into strict reads so an
 * unavailable source cannot be mistaken for an empty collection. */
export async function readJson<T = Record<string, any>>(
  filePath: string,
  opts?: { strict?: boolean },
): Promise<T> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    // A single leading UTF-8 BOM is an encoding marker, not JSON content.
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) as T;
  } catch (error) {
    if (opts?.strict) throw error;
    return {} as T;
  }
}

/** Synchronous variant — used in startup paths before the event loop is hot. */
export function readJsonSync<T = Record<string, any>>(filePath: string): T {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) as T;
  } catch {
    return {} as T;
  }
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ATOMIC_TMP_PATH_RE = /\.[1-9]\d*\.\d{13}\.[0-9a-f]{8}\.tmp$/;

/** Whether a path is an unpublished sibling created by this module's atomic writers. */
export function isAtomicWriteTempPath(filePath: string): boolean {
  return ATOMIC_TMP_PATH_RE.test(path.basename(filePath));
}

function atomicTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

async function renameWithRetryUsing(
  tmp: string,
  filePath: string,
  renameFn: (oldPath: string, newPath: string) => Promise<void> | void,
  shouldCommit?: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (shouldCommit && !shouldCommit()) return false;
    try {
      await renameFn(tmp, filePath);
      return true;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Async rename using the atomic writers' bounded Windows file-lock retries. */
export function renameWithRetry(tmp: string, filePath: string, shouldCommit?: () => boolean): Promise<boolean> {
  // A guarded publication must not yield between the ownership check and
  // rename. Retry delays stay asynchronous so file locks do not block main.
  return renameWithRetryUsing(tmp, filePath, shouldCommit ? fs.renameSync : fsp.rename, shouldCommit);
}

/** Publish a completed same-filesystem inode without replacing an existing
 * destination, retaining the bounded asynchronous Windows lock retries. */
export async function linkWithRetry(source: string, target: string): Promise<void> {
  await renameWithRetryUsing(source, target, fsp.link);
}

function renameWithRetrySyncUsing(
  tmp: string,
  filePath: string,
  renameFn: (oldPath: string, newPath: string) => void,
  shouldCommit?: () => boolean,
): boolean {
  for (let attempt = 0; ; attempt++) {
    if (shouldCommit && !shouldCommit()) return false;
    try {
      renameFn(tmp, filePath);
      return true;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Guarded small-text publication. Check and rename share one main-process
 * critical section, including Windows retries; no event-loop yield between them. */
export function writeTextAtomicGuardedSync(filePath: string, text: string, shouldCommit: () => boolean): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    return renameWithRetrySyncUsing(tmp, filePath, fs.renameSync, shouldCommit);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Rename with retry on Windows AV/backup-tool lock errors (EPERM/EACCES/
 *  EBUSY). Exported for writers that hand-roll tmp+rename with a non-default
 *  serialization (e.g. sync's compact-JSON index files) — everything else
 *  should use writeJson/writeJsonSync/writeTextAtomicSync directly. */
export function renameWithRetrySync(tmp: string, filePath: string): void {
  renameWithRetrySyncUsing(tmp, filePath, fs.renameSync);
}

export const __storageTestHooks = {
  renameWithRetryUsing,
  renameWithRetrySyncUsing,
};

/**
 * Atomically write JSON with UTF-8 and 2-space indent.
 * Writes to a same-directory temp file then renames over the target to
 * prevent torn reads. An optional synchronous ownership guard can discard
 * a superseded snapshot before publication, including after rename retries.
 */
export async function writeJson(
  filePath: string,
  data: unknown,
  opts?: { shouldCommit?: () => boolean },
): Promise<void> {
  return writeBytesAtomic(filePath, Buffer.from(JSON.stringify(data, null, 2)), opts);
}

/** Atomic bounded-payload callers use the same guarded publication as JSON. */
export async function writeBytesAtomic(filePath: string, data: Uint8Array, opts?: { shouldCommit?: () => boolean }): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    if (!await renameWithRetry(tmp, filePath, opts?.shouldCommit)) {
      await fsp.rm(tmp, { force: true });
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function writeJsonSync(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/**
 * Atomic text write (tmp + rename). Same guarantee as writeJson but for
 * arbitrary file content — used by places that write user-edited text
 * (e.g. SKILL.md, custom skill files) where a torn write would lose the
 * definition entirely.
 */
export function writeTextAtomicSync(
  filePath: string,
  text: string,
  encoding: BufferEncoding = 'utf8',
  opts?: { mode?: number },
): void {
  writeFileAtomicSync(filePath, text, encoding, opts);
}

/** Publish binary bytes with the same bounded rename and cleanup as text. */
export function writeBytesAtomicSync(filePath: string, bytes: Uint8Array, opts?: { mode?: number }): void {
  writeFileAtomicSync(filePath, bytes, 'utf8', opts);
}

function writeFileAtomicSync(
  filePath: string,
  data: string | Uint8Array,
  encoding: BufferEncoding,
  opts?: { mode?: number },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  // Mode is applied to the tmp file; rename carries it onto the target — used
  // by secret-bearing writers (connectors.json, auth profiles) that need 0600.
  try {
    // A failed (e.g. disk-full) write must not leave a partial sibling behind.
    fs.writeFileSync(tmp, data, { encoding, ...(opts && opts.mode !== undefined ? { mode: opts.mode } : {}) });
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/** Append one JSON record as a single line. */
export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
}

// ── Atomic append + msgIndex ─────────────────────────────────────────────
// Per-file Mutex + cached line count so the caller can get a correct
// monotonic index for the just-appended record without a race. First touch
// cold-reads the file once; subsequent appends are O(1).

const _lineLocks = new Map<string, MutexInterface>();
const _lineCounts = new Map<string, number>();

function _getLineLock(filePath: string): MutexInterface {
  let m = _lineLocks.get(filePath);
  if (!m) { m = new Mutex(); _lineLocks.set(filePath, m); }
  return m;
}

async function _loadLineCount(filePath: string): Promise<number> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) if (line.trim()) n++;
    return n;
  } catch { return 0; }
}

export interface AtomicAppendResult<T = unknown> {
  record: T;
  msgIndex: number;
  source?: JsonlAppendSource;
}

/** Small durable locator for consumers that must not clone a large record. */
export interface JsonlAppendSource {
  kind: 'jsonl-append';
  file: string;
  offset: number;
  bytes: number;
  dev: number;
  ino: number;
  beforeMtime: number;
  mtime: number;
  size: number;
}

/**
 * Append one JSON record and return its zero-based line index atomically.
 *
 * Two concurrent callers on the same file see serialized msgIndex values —
 * no "count after append" race. Used by chat/skill/agent message writers so
 * the search indexer can be told the exact position without re-scanning.
 */
export async function appendJsonlAtomic<T>(filePath: string, record: T, withSource = false): Promise<AtomicAppendResult<T>> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lock = _getLineLock(filePath);
  return lock.runExclusive(async () => {
    let count = _lineCounts.get(filePath);
    if (count === undefined) {
      count = await _loadLineCount(filePath);
      _lineCounts.set(filePath, count);
    }
    const finishIndex = await prepareIndexedJsonlAppend(filePath);
    const line = JSON.stringify(record) + '\n';
    let source: JsonlAppendSource | undefined;
    if (withSource) {
      const handle = await fsp.open(filePath, 'a');
      try {
        const before = await handle.stat();
        await handle.writeFile(line, 'utf8');
        const after = await handle.stat();
        source = { kind: 'jsonl-append', file: filePath, offset: before.size,
          bytes: Buffer.byteLength(line), dev: after.dev, ino: after.ino,
          beforeMtime: before.mtimeMs, mtime: after.mtimeMs, size: after.size };
      } finally { await handle.close(); }
    } else await fsp.appendFile(filePath, line, 'utf8');
    await finishIndex(record, Buffer.byteLength(line));
    _lineCounts.set(filePath, count + 1);
    return { record, msgIndex: count, ...(source ? { source } : {}) };
  });
}

/**
 * Drop cached line count for a file (call after the file is removed or
 * renamed, so the next appendJsonlAtomic recounts instead of reusing stale).
 */
export function invalidateLineCount(filePath: string): void {
  _lineCounts.delete(filePath);
  _lineLocks.delete(filePath);
}

/**
 * Atomic read-modify-write of a single JSONL line.
 *
 * Reads every line under the same line-lock that `appendJsonlAtomic` uses,
 * calls `mutate(record)` on the line at `msgIndex` (receives the parsed
 * record, returns the replacement record OR null to abort), and writes the
 * file back in one shot. Because both operations share the lock, no
 * interleaving append can clobber the edit.
 *
 * Returns `{ ok: true, record }` on success (record = the written replacement),
 * or `{ ok: false, error }` if the index is out of range or mutate aborted.
 */
export type RewriteJsonlResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

export async function rewriteJsonlLine<T extends object>(
  filePath: string, msgIndex: number,
  mutate: (current: T) => T | null,
): Promise<RewriteJsonlResult<T>> {
  const lock = _getLineLock(filePath);
  return lock.runExclusive<RewriteJsonlResult<T>>(async () => {
    let text: string;
    try { text = await fsp.readFile(filePath, 'utf8'); }
    catch (err) { return { ok: false, error: `read failed: ${(err as Error).message}` }; }

    const lines = text.split('\n');
    // Preserve the trailing-newline convention: split on \n always leaves an
    // empty last element for files that end with \n; we rejoin with \n + ''.
    const hasTrailing = lines.length > 0 && lines[lines.length - 1] === '';
    const body = hasTrailing ? lines.slice(0, -1) : lines;

    if (msgIndex < 0 || msgIndex >= body.length) {
      return { ok: false, error: `index out of range (${msgIndex}/${body.length})` };
    }

    let current: T;
    try { current = JSON.parse(body[msgIndex]) as T; }
    catch (err) { return { ok: false, error: `line ${msgIndex} not JSON: ${(err as Error).message}` }; }

    const next = mutate(current);
    if (next === null) return { ok: false, error: 'mutate aborted' };

    body[msgIndex] = JSON.stringify(next);
    const out = body.join('\n') + '\n';
    // Write to tmp + rename — rewrite is a "full file" op; we can't use
    // append here. Line count stays the same.
    const tmp = atomicTmpPath(filePath);
    await fsp.writeFile(tmp, out, 'utf8');
    try {
      await renameWithRetry(tmp, filePath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return { ok: true, record: next };
  });
}

const JSONL_TAIL_CHUNK_BYTES = 64 * 1024;

function _concatJsonlSegments(segments: Buffer[]): Buffer {
  if (segments.length === 0) return Buffer.alloc(0);
  if (segments.length === 1) return segments[0];
  return Buffer.concat(segments);
}

function _parseJsonlRecord<T>(line: string, strict = false): T | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as T; } catch {
    if (strict) throw new Error('JSONL record is invalid');
    return undefined;
  }
}

function _appendJsonlRecord<T>(out: T[], line: string, strict = false): void {
  const record = _parseJsonlRecord<T>(line, strict);
  if (record !== undefined) out.push(record);
}

export interface JsonlPage<T> {
  records: T[];
  /** Byte offset at which an older page ends; null means the file start. */
  nextCursor: number | null;
}

export interface JsonlRecordWithOffset<T> {
  record: T;
  /** Byte offset of the record's first byte in the source JSONL. */
  start: number;
}

export interface JsonlPageWithOffsets<T> {
  entries: JsonlRecordWithOffset<T>[];
  /** Byte offset at which an older page ends; null means the file start. */
  nextCursor: number | null;
}

export interface JsonlWindow<T> {
  records: T[];
  /** Byte offset immediately before this window; compatible with readJsonlPage. */
  previousCursor: number | null;
  /** Exclusive byte offset for continuing forward; null at the current EOF. */
  followingCursor: number | null;
}

/**
 * Return one newest-first-selected JSONL page in chronological order.
 *
 * `before` is an exclusive byte cursor emitted by a previous call. It keeps
 * pagination on the file tail: loading an older page never rereads or parses
 * the newer records already mounted in the conversation view.
 */
export async function readJsonlPage<T = Record<string, any>>(
  filePath: string,
  limit = 200,
  before?: number | null,
  opts?: { strict?: boolean },
): Promise<JsonlPage<T>> {
  const page = await readJsonlPageWithOffsets<T>(filePath, limit, before, opts);
  return {
    records: page.entries.map(({ record }) => record),
    nextCursor: page.nextCursor,
  };
}

/** Offset-preserving variant used by sparse derived page caches. */
export async function readJsonlPageWithOffsets<T = Record<string, any>>(
  filePath: string,
  limit = 200,
  before?: number | null,
  opts?: { strict?: boolean },
): Promise<JsonlPageWithOffsets<T>> {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (error) {
    if (opts?.strict) throw error;
    return { entries: [], nextCursor: null };
  }

  try {
    const size = (await handle.stat()).size;
    const requestedEnd = before === null || before === undefined ? Number.NaN : Number(before);
    let position = Number.isSafeInteger(requestedEnd)
      ? Math.max(0, Math.min(requestedEnd, size))
      : size;
    // Keep chunk slices until a newline completes the record. Re-concatenating
    // an ever-growing carry buffer on every 64 KiB read makes a multi-megabyte
    // JSONL row quadratic (and made a 24 MiB tail take seconds to open).
    let suffixSegments: Buffer[] = [];
    const newestFirst: JsonlRecordWithOffset<T>[] = [];
    let oldestRecordStart = -1;

    while (position > 0 && newestFirst.length < wanted) {
      const bytes = Math.min(JSONL_TAIL_CHUNK_BYTES, position);
      position -= bytes;
      const block = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(block, 0, bytes, position);
      if (opts?.strict && bytesRead !== bytes) throw new Error('JSONL read is incomplete');
      if (bytesRead <= 0) break;

      let end = bytesRead;
      for (let i = block.lastIndexOf(0x0a, bytesRead - 1); i >= 0 && newestFirst.length < wanted;
        i = i > 0 ? block.lastIndexOf(0x0a, i - 1) : -1) {
        const current = block.subarray(i + 1, end);
        const line = suffixSegments.length
          ? _concatJsonlSegments([current, ...suffixSegments.reverse()])
          : current;
        const record = _parseJsonlRecord<T>(line.toString('utf8'), opts?.strict);
        if (record !== undefined) {
          const start = position + i + 1;
          newestFirst.push({ record, start });
          oldestRecordStart = start;
        }
        end = i;
        suffixSegments = [];
      }
      if (newestFirst.length < wanted && end > 0) {
        // Reverse traversal discovers later segments first. Keep that order
        // with O(1) pushes, then reverse once when the record is complete.
        suffixSegments.push(block.subarray(0, end));
      }
    }

    if (newestFirst.length < wanted && suffixSegments.length) {
      const record = _parseJsonlRecord<T>(
        _concatJsonlSegments(suffixSegments.reverse()).toString('utf8'),
        opts?.strict,
      );
      if (record !== undefined) {
        newestFirst.push({ record, start: 0 });
        oldestRecordStart = 0;
      }
    }

    return {
      entries: newestFirst.reverse(),
      nextCursor: oldestRecordStart > 0 ? oldestRecordStart : null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a bounded chronological window by parsed-record index.
 *
 * This is the direct-window companion to tail pagination: search already owns a
 * stable JSONL record index, so opening a hit can stream forward once to that
 * window instead of fetching every intervening tail page through IPC. The
 * returned byte cursor lets the existing older-page reader continue upward.
 */
export async function readJsonlWindow<T = Record<string, any>>(
  filePath: string,
  startIndex: number,
  limit = 10,
  projectRecord?: (record: T) => T,
  after = 0,
): Promise<JsonlWindow<T>> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return { records: [], previousCursor: null, followingCursor: null };
  }
  try {
    return await _readJsonlWindowFrom(handle, (await handle.stat()).size, startIndex, limit, projectRecord, after);
  } finally {
    await handle.close();
  }
}

/** Hand each newline-delimited line from `position` to `consume` with its
 * byte start until it returns true. Lines are assembled from whole chunks
 * before decoding, so UTF-8 split across reads stays intact. Returns the byte
 * offset after the last consumed line (`size` after a final unterminated one). */
async function _scanJsonlLines(
  handle: fs.promises.FileHandle,
  size: number,
  position: number,
  consume: (line: Buffer, lineStart: number) => boolean,
): Promise<number> {
  let lineSegments: Buffer[] = [];
  let currentRecordStart = position;
  let done = false;
  while (position < size && !done) {
    const bytes = Math.min(JSONL_TAIL_CHUNK_BYTES, size - position);
    const block = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(block, 0, bytes, position);
    if (bytesRead <= 0) break;
    let lineStart = 0;
    for (let i = block.indexOf(0x0a); i >= 0 && i < bytesRead; i = block.indexOf(0x0a, i + 1)) {
      const current = block.subarray(lineStart, i);
      const line = lineSegments.length
        ? _concatJsonlSegments([...lineSegments, current])
        : current;
      done = consume(line, currentRecordStart);
      lineSegments = [];
      lineStart = i + 1;
      currentRecordStart = position + lineStart;
      if (done) break;
    }
    position += bytesRead;
    if (!done && lineStart < bytesRead) lineSegments.push(block.subarray(lineStart, bytesRead));
  }
  if (!done && lineSegments.length) {
    consume(_concatJsonlSegments(lineSegments), currentRecordStart);
    currentRecordStart = size;
  }
  return currentRecordStart;
}

async function _readJsonlWindowFrom<T>(
  handle: fs.promises.FileHandle,
  size: number,
  startIndex: number,
  limit: number,
  projectRecord: ((record: T) => T) | undefined,
  after: number,
): Promise<JsonlWindow<T>> {
  const first = Math.max(0, Math.floor(Number(startIndex) || 0));
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  const records: T[] = [];
  let recordIndex = 0;
  let firstRecordStart = -1;
  const position = Number.isSafeInteger(after) && after >= 0 ? Math.min(after, size) : 0;
  const end = await _scanJsonlLines(handle, size, position, (line, recordStart) => {
    const record = _parseJsonlRecord<T>(line.toString('utf8'));
    if (record === undefined) return false;
    if (recordIndex >= first && records.length < wanted) {
      if (firstRecordStart < 0) firstRecordStart = recordStart;
      // Project on consumption so a long search window retains only the
      // display payload, never every raw execution trail at once.
      records.push(projectRecord ? projectRecord(record) : record);
    }
    recordIndex += 1;
    return records.length >= wanted;
  });
  return {
    records,
    previousCursor: firstRecordStart > 0 ? firstRecordStart : null,
    followingCursor: end < size ? end : null,
  };
}

/**
 * Read the `limit`-aligned record page (the same page readJsonlWindow returns
 * for `floor(index / limit) * limit`) holding the first record `matches`
 * accepts. One forward pass parses records up to the match and keeps only
 * the page start; the page itself is then read and projected from that byte
 * offset on the same handle. Null when no record matches.
 */
export async function readJsonlWindowAtMatch<T = Record<string, any>>(
  filePath: string,
  matches: (record: T) => boolean,
  limit = 10,
  projectRecord?: (record: T) => T,
): Promise<(JsonlWindow<T> & { start: number; index: number }) | null> {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    let recordIndex = 0;
    let index = -1;
    let pageStart = 0;
    let pageStartByte = 0;
    await _scanJsonlLines(handle, size, 0, (line, recordStart) => {
      const record = _parseJsonlRecord<T>(line.toString('utf8'));
      if (record === undefined) return false;
      if (recordIndex % wanted === 0) {
        pageStart = recordIndex;
        pageStartByte = recordStart;
      }
      if (matches(record)) index = recordIndex;
      recordIndex += 1;
      return index >= 0;
    });
    if (index < 0) return null;
    const window = await _readJsonlWindowFrom(handle, size, 0, wanted, projectRecord, pageStartByte);
    return { ...window, start: pageStart, index };
  } finally {
    await handle.close();
  }
}

/**
 * Read a JSONL file, returning the last `limit` valid records.
 *
 * History consumers normally need only a bounded tail. Reading from the end
 * keeps a years-long conversation log from being fully loaded, split and
 * parsed merely to display its newest messages. Each candidate line is
 * decoded only after its complete byte range has been assembled, so UTF-8
 * characters that straddle a disk-read boundary remain intact.
 *
 * Non-positive limits retain the historical full-file behavior. Malformed
 * lines are silently skipped by default, matching the previous Python-compatible read.
 * Durable projections can opt into strict reads to distinguish missing, corrupt or incomplete IO.
 */
export async function readJsonl<T = Record<string, any>>(filePath: string, limit = 200, opts?: { strict?: boolean }): Promise<T[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    let text: string;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (opts?.strict) throw error;
      return [];
    }
    const out: T[] = [];
    for (const line of text.split('\n')) _appendJsonlRecord(out, line, opts?.strict);
    return out.slice(-limit);
  }

  return (await readJsonlPage<T>(filePath, limit, undefined, opts)).records;
}

/** Read one immutable append receipt without scanning the conversation. */
export async function readJsonlAppendRecord<T>(source: JsonlAppendSource): Promise<T> {
  const handle = await fsp.open(source.file, 'r');
  try {
    const valid = (stat: import('node:fs').Stats) => stat.dev === source.dev && stat.ino === source.ino
      && stat.size >= source.size && (stat.size > source.size || stat.mtimeMs === source.mtime)
      && Number.isSafeInteger(source.offset) && Number.isSafeInteger(source.bytes)
      && source.offset >= 0 && source.bytes > 0 && source.offset + source.bytes === source.size;
    if (!valid(await handle.stat())) throw new Error('History receipt unavailable');
    const buffer = Buffer.allocUnsafe(source.bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, source.offset + offset);
      if (!bytesRead) throw new Error('History receipt incomplete');
      offset += bytesRead;
    }
    if (!valid(await handle.stat())) throw new Error('History receipt changed');
    return JSON.parse(buffer.toString('utf8')) as T;
  } finally { await handle.close(); }
}
