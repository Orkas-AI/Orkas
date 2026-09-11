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

/** Local-time ISO8601 down to seconds, no TZ suffix (matches Python `now_iso`). */
export function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

/** Read a JSON file. Returns {} on any error (missing, invalid, etc.). */
export async function readJson<T = Record<string, any>>(filePath: string): Promise<T> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/** Synchronous variant — used in startup paths before the event loop is hot. */
export function readJsonSync<T = Record<string, any>>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
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

function renameWithRetry(tmp: string, filePath: string, shouldCommit?: () => boolean): Promise<boolean> {
  // A guarded publication must not yield between the ownership check and
  // rename. Retry delays stay asynchronous so file locks do not block main.
  return renameWithRetryUsing(tmp, filePath, shouldCommit ? fs.renameSync : fsp.rename, shouldCommit);
}

function renameWithRetrySyncUsing(
  tmp: string,
  filePath: string,
  renameFn: (oldPath: string, newPath: string) => void,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameFn(tmp, filePath);
      return;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Rename with retry on Windows AV/backup-tool lock errors. */
export function renameWithRetrySync(tmp: string, filePath: string): void {
  return renameWithRetrySyncUsing(tmp, filePath, fs.renameSync);
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
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  // Mode is applied to the tmp file; rename carries it onto the target — used
  // by secret-bearing writers (connectors.json, auth profiles) that need 0600.
  fs.writeFileSync(tmp, text, { encoding, ...(opts && opts.mode !== undefined ? { mode: opts.mode } : {}) });
  try {
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
}

/**
 * Append one JSON record and return its zero-based line index atomically.
 *
 * Two concurrent callers on the same file see serialized msgIndex values —
 * no "count after append" race. Used by chat/skill/agent message writers so
 * the search indexer can be told the exact position without re-scanning.
 */
export async function appendJsonlAtomic<T>(filePath: string, record: T): Promise<AtomicAppendResult<T>> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lock = _getLineLock(filePath);
  return lock.runExclusive(async () => {
    let count = _lineCounts.get(filePath);
    if (count === undefined) {
      count = await _loadLineCount(filePath);
      _lineCounts.set(filePath, count);
    }
    await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    _lineCounts.set(filePath, count + 1);
    return { record, msgIndex: count };
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

function _parseJsonlRecord<T>(line: string): T | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as T; } catch { return undefined; }
}

function _appendJsonlRecord<T>(out: T[], line: string): void {
  const record = _parseJsonlRecord<T>(line);
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
): Promise<JsonlPage<T>> {
  const page = await readJsonlPageWithOffsets<T>(filePath, limit, before);
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
): Promise<JsonlPageWithOffsets<T>> {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
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
      if (bytesRead <= 0) break;

      let end = bytesRead;
      for (let i = bytesRead - 1; i >= 0 && newestFirst.length < wanted; i -= 1) {
        if (block[i] !== 0x0a) continue; // '\n'
        const current = block.subarray(i + 1, end);
        const line = suffixSegments.length
          ? _concatJsonlSegments([current, ...suffixSegments.reverse()])
          : current;
        const record = _parseJsonlRecord<T>(line.toString('utf8'));
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
): Promise<JsonlWindow<T>> {
  const first = Math.max(0, Math.floor(Number(startIndex) || 0));
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return { records: [], previousCursor: null };
  }

  try {
    const size = (await handle.stat()).size;
    const records: T[] = [];
    let recordIndex = 0;
    let position = 0;
    let lineSegments: Buffer[] = [];
    let currentRecordStart = 0;
    let firstRecordStart = -1;
    let done = false;

    const consumeLine = (line: Buffer, recordStart: number): boolean => {
      const record = _parseJsonlRecord<T>(line.toString('utf8'));
      if (record === undefined) return false;
      if (recordIndex >= first && records.length < wanted) {
        if (firstRecordStart < 0) firstRecordStart = recordStart;
        records.push(record);
      }
      recordIndex += 1;
      return records.length >= wanted;
    };

    while (position < size && !done) {
      const bytes = Math.min(JSONL_TAIL_CHUNK_BYTES, size - position);
      const block = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(block, 0, bytes, position);
      if (bytesRead <= 0) break;
      let lineStart = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (block[i] !== 0x0a) continue;
        const current = block.subarray(lineStart, i);
        const line = lineSegments.length
          ? _concatJsonlSegments([...lineSegments, current])
          : current;
        done = consumeLine(line, currentRecordStart);
        lineSegments = [];
        lineStart = i + 1;
        currentRecordStart = position + lineStart;
        if (done) break;
      }
      position += bytesRead;
      if (!done && lineStart < bytesRead) lineSegments.push(block.subarray(lineStart, bytesRead));
    }
    if (!done && lineSegments.length) {
      consumeLine(_concatJsonlSegments(lineSegments), currentRecordStart);
    }

    return {
      records,
      previousCursor: firstRecordStart > 0 ? firstRecordStart : null,
    };
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
 * lines are silently skipped, matching the previous Python-compatible read.
 */
export async function readJsonl<T = Record<string, any>>(filePath: string, limit = 200): Promise<T[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    let text: string;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of text.split('\n')) _appendJsonlRecord(out, line);
    return out.slice(-limit);
  }

  return (await readJsonlPage<T>(filePath, limit)).records;
}
