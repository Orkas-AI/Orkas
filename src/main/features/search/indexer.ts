import { historyRecordText } from '../chat-history-records';
/**
 * Context snapshot and restartable SQLite chat index manager.
 *
 * Lifecycle per idx file:
 *   1. lazy load on first touch (cached in `_cache`)
 *   2. mutations mark the entry dirty + schedule a 1s debounced flush
 *   3. `reconcileX(...)` is cheap — for each source file it compares the
 *      stored mtime+size against current stat; only changed/added files get
 *      re-tokenized, missing files have their docs dropped
 *   4. `flushAll()` is called from app quit
 *
 * Chat rebuilds run in an independent worker. Live messages remain in
 * their durable JSONL until catch-up; source revisions guard the ready handoff.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import * as chatStore from './chat_store';
import { ChatRebuildWorker } from './chat-rebuild';

import {
  userContextsDir, userChatsDir, projectChatsDir,
  projectChatIndexFile, userContextsIndexPath, userChatsIndexPath,
} from '../../paths';
import { conversationMessageReadFile, listProjectIds } from '../../util/project-layout';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';
import { closeChatSnippetReader } from './chat-snippets';
import { logErrorSummary, logPathRef } from '../../util/log-redact';
import { isBootAdmissionIdle, scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';

const log = createLogger('search');

import { termFrequencies } from './tokenize';
import { loadIndex, saveIndex, type Index, type IndexKind, type Doc } from './storage';

const FLUSH_DELAY_MS = 1000;
const CTX_IGNORE = new Set(['_INDEX.md', '.DS_Store', '__pycache__', '.git', 'node_modules']);
const CONTEXT_STAT_CONCURRENCY = 32;
const CHAT_STAT_CONCURRENCY = 32;
const CPU_YIELD_EVERY = 250;

// Runtime-extended index: indexer caches BM25 avgdl on the object; storage
// schema doesn't persist these, so they live as optional extras.
interface RuntimeIndex extends Index {
  _avgdl?: number | null;
  _avgdlVersion?: number;
  _version?: number;
}

interface CacheEntry {
  idx: RuntimeIndex;
  dirty: boolean;
  kind: IndexKind;
}

interface ChatFileInfo {
  fileKey: string;
  file: string;
  mtime: number;
  size: number;
}

// Persisted chat message can take two shapes:
//   - **Legacy single-actor**: `{ role, content, time }` (pre-bus refactor;
//     still on disk in older conversations).
//   - **Group chat (current)**: `{ id, ts, from, to, mentions, text, ... }`
//     — the `GroupMessage` shape persisted by `features/group_chat/visibility.ts`
//     since the bus rewrite. Field names differ (`text` ↔ `content`,
//     `from` ↔ `role`, `ts` ↔ `time`).
//
// `_msgText` / `_msgRole` / `_msgTime` read whichever pair is present so the
// index covers both old and new conversations. Without this fallback the
// new-format jsonl reads `content === undefined` → `_reindexChatFile`
// skips every message → user reports "conversation messages can't be
// searched" (only old conversations would still surface).
interface ChatMessage {
  // Legacy fields
  role?: string;
  time?: string;
  content?: unknown;
  // Group-chat fields (current persistence format)
  from?: string;
  ts?: string;
  text?: unknown;
}

// ── In-memory state ──────────────────────────────────────────────────────

const _cache = new Map<string, CacheEntry>();
const _flushTimers = new Map<string, NodeJS.Timeout>();
const _locks = new Map<string, Mutex>();
const _currentContextIndexes = new Set<string>();
const _currentChatIndexes = new Set<string>();
const _chatReconcileRuns = new Map<string, Promise<SearchReconcileResult>>();
const _chatRepairTasks = new Map<string, ScheduledBootBackgroundTask>();
const _chatRevisions = new Map<string, number>();
const _dirtyChats = new Map<string, Set<string>>();
const _migratingChats = new Set<string>();
const _migrationChecked = new Set<string>();
let _closing = false;

function _noteChatChange(uid: string, cid?: string): void {
  _chatRevisions.set(uid, (_chatRevisions.get(uid) || 0) + 1);
  if (cid) {
    let dirty = _dirtyChats.get(uid);
    if (!dirty) { dirty = new Set(); _dirtyChats.set(uid, dirty); }
    dirty.add(cid);
  }
}

function _isMigrating(uid: string): boolean {
  if (!_migrationChecked.has(uid)) {
    if (!chatStore.hasCompletedRebuild(uid) && fs.existsSync(userChatsIndexPath(uid))) {
      _migratingChats.add(uid);
    }
    _migrationChecked.add(uid);
  }
  return _migratingChats.has(uid);
}

export function cancelChatIndexRepair(uid: string): void {
  const task = _chatRepairTasks.get(uid);
  _chatRepairTasks.delete(uid);
  task?.cancel();
}

export function hasPendingChatRepair(uid: string): boolean { return _chatRepairTasks.has(uid); }

/** One idle disk job per account. A partial pass releases its slot before
 * scheduling the next slice; failures back off instead of spinning. */
export function scheduleChatIndexRepair(uid: string, delayMs = 250): void {
  if (_closing || _chatRepairTasks.has(uid)) return;
  let retry = false;
  let retryDelay = 1_000;
  const task = scheduleBootBackground('search:chat-repair', async (signal) => {
    try {
      const result = await reconcileChatsIndex(uid, signal, true);
      retry = !result.complete;
    } catch (err) {
      retry = true;
      retryDelay = 30_000;
      log.warn('chat repair failed', { error: logErrorSummary(err) });
    }
  }, delayMs, { resourceClass: 'disk', preferIdle: true, maxSliceMs: 15_000 });
  _chatRepairTasks.set(uid, task);
  void task.promise.finally(() => {
    if (_chatRepairTasks.get(uid) !== task) return;
    _chatRepairTasks.delete(uid);
    if (retry) scheduleChatIndexRepair(uid, retryDelay);
  });
}

export async function cleanupLegacyChatIndex(uid: string): Promise<void> {
  if (!chatStore.hasCompletedRebuild(uid)) return;
  for (const file of [userChatsIndexPath(uid), `${userChatsIndexPath(uid)}.tmp`]) {
    try { await fsp.unlink(file); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('legacy chat index cleanup failed', { error: logErrorSummary(err) });
      }
    }
  }
}

function _getLock(idxPath: string): Mutex {
  let m = _locks.get(idxPath);
  if (!m) { m = new Mutex(); _locks.set(idxPath, m); }
  return m;
}

async function _getEntry(idxPath: string, kind: IndexKind): Promise<CacheEntry> {
  let entry = _cache.get(idxPath);
  if (!entry) {
    const idx = await loadIndex(idxPath, kind);
    entry = { idx: idx as RuntimeIndex, dirty: false, kind };
    _cache.set(idxPath, entry);
  }
  return entry;
}

function _markDirty(idxPath: string): void {
  const entry = _cache.get(idxPath);
  if (!entry) return;
  entry.dirty = true;
  const existing = _flushTimers.get(idxPath);
  if (existing) clearTimeout(existing);
  _flushTimers.set(idxPath, setTimeout(() => {
    flushOne(idxPath).catch((err) => log.warn('flush failed', { error: logErrorSummary(err) }));
  }, FLUSH_DELAY_MS));
}

const _FLUSH_SIZE_WARN = 50 * 1024 * 1024;  // warn if a single idx > 50MB

export async function flushOne(idxPath: string): Promise<void> {
  const t = _flushTimers.get(idxPath);
  if (t) { clearTimeout(t); _flushTimers.delete(idxPath); }
  const entry = _cache.get(idxPath);
  if (!entry || !entry.dirty) return;
  const lock = _getLock(idxPath);
  await lock.runExclusive(async () => {
    if (!entry.dirty) return;
    entry.dirty = false;
    try {
      await saveIndex(idxPath, entry.idx);
      try {
        const { size } = fs.statSync(idxPath);
        if (size > _FLUSH_SIZE_WARN) {
          log.warn('index exceeds size warning threshold', { path: logPathRef(idxPath), size_bytes: size });
        }
      } catch { /* ignore */ }
    } catch (err) {
      entry.dirty = true;
      // Retry with exponential-ish backoff so a transient disk error doesn't
      // strand the unflushed work forever.
      setTimeout(() => {
        flushOne(idxPath).catch((err) => {
          log.warn('retry flush failed', { error: logErrorSummary(err) });
        });
      }, FLUSH_DELAY_MS * 5);
      throw err;
    }
  });
}

export async function flushAll(): Promise<void> {
  _closing = true;
  await closeChatSnippetReader();
  for (const uid of _chatRepairTasks.keys()) cancelChatIndexRepair(uid);
  await Promise.allSettled([..._chatReconcileRuns.values()]);
  await drainDeferredChatWrites();
  await Promise.all(Array.from(_cache.keys()).map((p) => flushOne(p).catch((err) => {
    log.warn('flushAll entry failed', { error: logErrorSummary(err) });
  })));
  // The chat index is a SQLite file now. Its handle has to be released here
  // too: Windows refuses to unlink an open database, which blocks both a
  // per-test workspace teardown and an in-place repair.
  chatStore.closeAllChatStores();
  _closing = false;
}

/** Deferred chat upserts, chained per user so the watermark check keeps
 *  seeing appends in order. The stat + lock inside an upsert means two
 *  concurrently started writes can reach the index out of order, and a
 *  non-contiguous index hands the whole file back to the reconciler. */
const _deferredChatWrites = new Map<string, Promise<void>>();

/**
 * Index one appended message without holding up its caller.
 *
 * The conversation record is durable before this runs, and the index is
 * derived state that already fails soft and is repaired by
 * `reconcileChatsIndex`. Awaiting it put a whole-index load (a 241MB
 * snapshot measured ~950ms to parse on a real profile) in front of the
 * user's own chat bubble, which is not painted until the append returns.
 * Outside migration, readers drain the incremental writes queued before them.
 * During migration the JSONL remains authoritative and search reports partial coverage.
 */
export function indexChatMessageDeferred(
  userId: string,
  cid: string,
  msgIndex: number,
  msg: ChatMessage,
): void {
  if (_chatReconcileRuns.has(userId) || _migratingChats.has(userId)) {
    _noteChatChange(userId, cid);
    _currentChatIndexes.delete(userId);
    scheduleChatIndexRepair(userId, 1_000);
    return;
  }
  const key = _chatIdxPath(userId);
  const previous = _deferredChatWrites.get(key) ?? Promise.resolve();
  // `indexChatMessage` already absorbs its own failures, so the chain cannot
  // reject and one bad append cannot strand later ones.
  const next = previous.then(() => indexChatMessage(userId, cid, msgIndex, msg));
  _deferredChatWrites.set(key, next);
  void next.finally(() => {
    if (_deferredChatWrites.get(key) === next) _deferredChatWrites.delete(key);
  });
}

/** Readers settle their account's existing live writes; shutdown drains all.
 * Migration changes are represented by source files, never waiting promises. */
export async function drainDeferredChatWrites(userId?: string): Promise<void> {
  if (userId) {
    await _deferredChatWrites.get(_chatIdxPath(userId));
    return;
  }
  while (_deferredChatWrites.size) {
    await Promise.allSettled(Array.from(_deferredChatWrites.values()));
  }
}

// ── Index ops (callers must hold the per-idx lock) ───────────────────────

function _addPosting(idx: RuntimeIndex, token: string, docId: string, tf: number): void {
  const list = idx.postings[token] || (idx.postings[token] = []);
  list.push([docId, tf]);
}

function _dropDoc(idx: RuntimeIndex, docId: string): void {
  const doc = idx.docs[docId];
  if (!doc) return;
  delete idx.docs[docId];
  const tokens = (doc as Doc & { _tokens?: string[] })._tokens || [];
  for (const t of tokens) {
    const list = idx.postings[t];
    if (!list) continue;
    const kept: Array<[string, number]> = [];
    for (const entry of list) if (entry[0] !== docId) kept.push(entry);
    if (kept.length === 0) delete idx.postings[t];
    else if (kept.length !== list.length) idx.postings[t] = kept;
  }
  idx._avgdl = null;
}

function _dropDocsByFileKey(idx: RuntimeIndex, fileKey: string): void {
  const toDrop: string[] = [];
  for (const docId of Object.keys(idx.docs)) {
    if (idx.docs[docId].fileKey === fileKey) toDrop.push(docId);
  }
  for (const id of toDrop) _dropDoc(idx, id);
  delete idx.files[fileKey];
}

function _putDoc(idx: RuntimeIndex, docId: string, doc: Doc, text: string): void {
  _dropDoc(idx, docId);
  const tf = termFrequencies(text);
  // Record the unique token list on the doc so future drops don't have to
  // walk the whole postings table.
  (doc as Doc & { _tokens?: string[] })._tokens = Object.keys(tf);
  idx.docs[docId] = doc;
  for (const [token, count] of Object.entries(tf)) _addPosting(idx, token, docId, count);
  idx._avgdl = null;  // invalidate BM25 avgdl cache
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _msgText(msg: ChatMessage | null | undefined): string {
  return msg ? historyRecordText(msg, true) : '';
}

function _msgRole(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  return msg.from || msg.role || '';
}

function _msgTime(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  return msg.ts || msg.time || '';
}

// Exported so `search/index.ts::searchChats` can use the same field-shape
// fallback when extracting the snippet from the live jsonl record.
export { _msgText as readMsgText };

// ── Contexts (shared knowledge base) ─────────────────────────────────────
// Content is NOT indexed — only the relPath (directory segments + filename)
// is tokenized. Full-text content lookup goes through the vector KB
// (`library` search action); BM25 here is for path/name navigation only.

interface ContextFileInfo { rel: string; mtime: number; size: number }

async function _scanContexts(
  root: string,
  signal?: AbortSignal,
): Promise<{ files: ContextFileInfo[]; complete: boolean }> {
  const candidates: Array<{ rel: string; full: string }> = [];
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }];
  let reliable = true;
  while (stack.length) {
    if (signal?.aborted) return { files: [], complete: false };
    const current = stack.pop()!;
    let items: fs.Dirent[];
    try { items = await fsp.readdir(current.dir, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reliable = false;
      continue;
    }
    for (const entry of items) {
      if (CTX_IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: full, rel });
      else if (entry.isFile()) candidates.push({ rel, full });
    }
  }
  const results = await _mapBounded(candidates, CONTEXT_STAT_CONCURRENCY, async (candidate) => {
    if (signal?.aborted) return { file: null, reliable: false };
    try {
      const st = await fsp.stat(candidate.full);
      return {
        file: { rel: candidate.rel, mtime: st.mtimeMs, size: st.size } satisfies ContextFileInfo,
        reliable: true,
      };
    } catch (err) {
      return {
        file: null,
        reliable: (err as NodeJS.ErrnoException).code === 'ENOENT',
      };
    }
  }, signal);
  const files: ContextFileInfo[] = [];
  for (const result of results) {
    if (!result) continue;
    if (!result.reliable) reliable = false;
    if (result.file) files.push(result.file);
  }
  return { files, complete: reliable && !signal?.aborted };
}

function _putContextDoc(idx: RuntimeIndex, f: ContextFileInfo): void {
  _dropDocsByFileKey(idx, f.rel);
  const doc: Doc = {
    fileKey: f.rel, kind: 'context', path: f.rel,
    title: path.basename(f.rel), len: f.rel.length,
  };
  _putDoc(idx, f.rel, doc, f.rel);
  idx.files[f.rel] = { mtime: f.mtime, size: f.size };
}

export interface SearchReconcileResult {
  scanned: number;
  updated: number;
  deleted: number;
  cancelled?: boolean;
  complete?: boolean;
}

export async function reconcileContextsIndex(
  userId?: string,
  signal?: AbortSignal,
): Promise<SearchReconcileResult> {
  const startedAt = Date.now();
  const uid = userId || getActiveUserId();
  const idxPath = userContextsIndexPath(uid);
  const scan = await _scanContexts(userContextsDir(uid), signal);
  if (!scan.complete) {
    log.info(`context reconcile cancelled scanned=${scan.files.length} ms=${Date.now() - startedAt}`);
    return { scanned: scan.files.length, updated: 0, deleted: 0, cancelled: true };
  }
  let updated = 0;
  let deleted = 0;
  await _getLock(idxPath).runExclusive(async () => {
    if (signal?.aborted) return;
    const entry = await _getEntry(idxPath, 'context');
    const seen = new Set<string>();
    let dirty = false;
    for (let i = 0; i < scan.files.length; i++) {
      const f = scan.files[i];
      seen.add(f.rel);
      const known = entry.idx.files[f.rel];
      if (known && known.mtime === f.mtime && known.size === f.size) continue;
      _putContextDoc(entry.idx, f);
      updated += 1;
      dirty = true;
      if (i > 0 && i % CPU_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    for (const fk of Object.keys(entry.idx.files)) {
      if (!seen.has(fk)) {
        _dropDocsByFileKey(entry.idx, fk);
        deleted += 1;
        dirty = true;
      }
    }
    if (dirty) { entry.dirty = true; _markDirty(idxPath); }
    _currentContextIndexes.add(uid);
  });
  if (signal?.aborted && !_currentContextIndexes.has(uid)) {
    return { scanned: scan.files.length, updated: 0, deleted: 0, cancelled: true };
  }
  log.info(`context reconcile complete scanned=${scan.files.length} updated=${updated} deleted=${deleted} ms=${Date.now() - startedAt}`);
  return { scanned: scan.files.length, updated, deleted };
}

export function isContextsIndexCurrent(userId: string): boolean {
  return _currentContextIndexes.has(userId);
}

export function invalidateContextsIndex(userId: string): void {
  _currentContextIndexes.delete(userId);
}

export function upsertContext(userId: string, relPath: string): void {
  (async () => {
    const full = path.join(userContextsDir(userId), relPath);
    let st;
    try { st = await fsp.stat(full); } catch { return; }
    const idxPath = userContextsIndexPath(userId);
    await _getLock(idxPath).runExclusive(async () => {
      const entry = await _getEntry(idxPath, 'context');
      _putContextDoc(entry.idx, { rel: relPath, mtime: st.mtimeMs, size: st.size });
      entry.dirty = true;
    });
    _markDirty(idxPath);
  })().catch((err) => log.warn(`upsertContext failed: ${err.message}`));
}

export function dropContext(userId: string, relPath: string): void {
  (async () => {
    const idxPath = userContextsIndexPath(userId);
    await _getLock(idxPath).runExclusive(async () => {
      const entry = await _getEntry(idxPath, 'context');
      if (!entry.idx.files[relPath] && !Object.values(entry.idx.docs).some((d) => d.fileKey === relPath)) return;
      _dropDocsByFileKey(entry.idx, relPath);
      entry.dirty = true;
    });
    _markDirty(idxPath);
  })().catch((err) => log.warn(`dropContext failed: ${err.message}`));
}

// ── Chat index (main conversations only) ────────────────────────────────
// Each jsonl line is a doc; fileKey is the conversation id (cid). Skill /
// agent edit conversations used to share this code path through a
// `_CHAT_KINDS` registry; that was removed when those scopes were dropped
// from search — agent / skill bodies are now queried in-memory at request
// time via `listAgents` / `listSkills` (see features/search/index.ts).

type ChatStyleKind = 'chat';

async function _mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return out;
}

async function _listUserChats(
  userId: string,
  statFile: (file: string) => Promise<Pick<fs.Stats, 'mtimeMs' | 'size'>> = fsp.stat,
  signal?: AbortSignal,
): Promise<{ files: ChatFileInfo[]; complete: boolean }> {
  const roots = [userChatsDir(userId), ...listProjectIds(userId).map((pid) => projectChatsDir(userId, pid))];
  const candidates: Array<{ fileKey: string; file: string }> = [];
  let reliable = true;
  for (const root of roots) {
    if (signal?.aborted) return { files: [], complete: false };
    let items;
    try { items = await fsp.readdir(root, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reliable = false;
      continue;
    }
    for (const e of items) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(root, e.name);
      const fileKey = e.name.replace(/\.jsonl$/i, '');
      candidates.push({ fileKey, file });
    }
  }
  const found = await _mapBounded(candidates, CHAT_STAT_CONCURRENCY, async ({ fileKey, file }) => {
    try {
      const st = await statFile(file);
      return {
        info: { fileKey, file, mtime: st.mtimeMs, size: st.size } satisfies ChatFileInfo,
        reliable: true,
      };
    } catch (err) {
      return { info: null, reliable: (err as NodeJS.ErrnoException).code === 'ENOENT' };
    }
  }, signal);
  const files: ChatFileInfo[] = [];
  for (const result of found) {
    if (!result) continue;
    if (!result.reliable) reliable = false;
    if (result.info) files.push(result.info);
  }
  return { files, complete: reliable && !signal?.aborted };
}

async function _statStamp(file: string): Promise<string> {
  try {
    const st = await fsp.stat(file);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * The aggregate conversation indexes change for normal app writes and sync
 * pulls. Comparing this small catalog (plus the handful of chat roots) is
 * much cheaper than statting every historical JSONL before every search.
 *
 * Direct edits to an existing JSONL bypass this marker, so the scheduled
 * full reconcile remains the eventual repair path. New/deleted files still
 * change a chat-root mtime and immediately invalidate the snapshot.
 */
async function _chatSourceStamp(userId: string): Promise<string> {
  const projectIds = listProjectIds(userId);
  const paths = [
    userChatsDir(userId),
    path.join(userChatsDir(userId), '_index.json'),
    ...projectIds.flatMap((pid) => [projectChatsDir(userId, pid), projectChatIndexFile(userId, pid)]),
  ];
  const stats = await Promise.all(paths.map(_statStamp));
  return `v1|projects=${projectIds.join(',')}|${stats.join('|')}`;
}

export const __searchIndexerTestHooks = {
  listUserChats: async (
    userId: string,
    statFile?: (file: string) => Promise<Pick<fs.Stats, 'mtimeMs' | 'size'>>,
  ) => (await _listUserChats(userId, statFile)).files,
  chatSourceStamp: _chatSourceStamp,
  chatStatConcurrency: CHAT_STAT_CONCURRENCY,
  contextStatConcurrency: CONTEXT_STAT_CONCURRENCY,
};

/** Lock key for the chat index. The chat index is `chat_store` now, not a
 *  file; this only has to be a stable per-user string, and reusing the retired
 *  path keeps every chat critical section on the one lock it always used. */
function _chatIdxPath(uid: string): string { return userChatsIndexPath(uid); }
function _chatJsonlFile(uid: string, cid: string): string {
  return conversationMessageReadFile(uid, cid);
}

function _docId(kind: IndexKind, fileKey: string, msgIndex: number): string {
  return `${kind}:${fileKey}:${msgIndex}`;
}

async function _reindexChatFile(
  userId: string, f: ChatFileInfo, shouldStop: () => boolean, worker: ChatRebuildWorker,
): Promise<boolean> {
  const revision = _chatRevisions.get(userId) || 0;
  while (true) {
    if (shouldStop() || revision !== (_chatRevisions.get(userId) || 0)) return false;
    const batch = await worker.rebuildBatch(f);
    if (!batch.valid) return false;
    if (batch.complete) break;
  }
  // Sync can replace the file before its completion callback invalidates the
  // index. Recheck the source after the final yielded batch as well as before it.
  const finalStat = await fsp.stat(f.file).catch(() => undefined);
  if (!finalStat || finalStat.mtimeMs !== f.mtime || finalStat.size !== f.size
      || revision !== (_chatRevisions.get(userId) || 0)) {
    chatStore.dropFileWatermark(userId, f.fileKey);
    return false;
  }
  _dirtyChats.get(userId)?.delete(f.fileKey);
  return true;
}

/** Coalesce boot, query and sync repairs. Interactive writes never wait on
 * this promise: while it runs their durable JSONL is the catch-up queue. */
export function reconcileChatsIndex(
  userId: string, signal?: AbortSignal, preferIdle = false,
): Promise<SearchReconcileResult> {
  const existing = _chatReconcileRuns.get(userId);
  if (existing) return existing;
  const run = _reconcileChatsPass(userId, signal, preferIdle);
  _chatReconcileRuns.set(userId, run);
  void run.finally(() => {
    if (_chatReconcileRuns.get(userId) === run) _chatReconcileRuns.delete(userId);
  }).catch(() => undefined);
  return run;
}

async function _reconcileChatsPass(
  userId: string, signal?: AbortSignal, preferIdle = false,
): Promise<SearchReconcileResult> {
  const startedAt = Date.now();
  const shouldStop = (): boolean => _closing || !!signal?.aborted || (preferIdle && !isBootAdmissionIdle());
  if (shouldStop()) return { scanned: 0, updated: 0, deleted: 0, cancelled: true, complete: false };
  if (!chatStore.hasCompletedRebuild(userId)) _migratingChats.add(userId);
  _currentChatIndexes.delete(userId);
  // Persist invalidation before any partial batches; a restart must not trust
  // an old catalog stamp left by an interrupted repair.
  chatStore.writeSourceStamp(userId, undefined);
  const revision = _chatRevisions.get(userId) || 0;
  const [sourceStampBefore, scan] = await Promise.all([
    _chatSourceStamp(userId), _listUserChats(userId, fsp.stat, signal),
  ]);
  if (!scan.complete || shouldStop()) {
    return { scanned: scan.files.length, updated: 0, deleted: 0, cancelled: true, complete: false };
  }
  let updated = 0;
  let deleted = 0;
  let cancelled = false;
  const seen = new Set(scan.files.map(f => f.fileKey));
  // The pass owns the writer until the worker is closed. Invalidation and
  // live appends only mark durable source work meanwhile; a main-thread SQL
  // write here would block behind the worker's transaction via busy_timeout.
  let worker: ChatRebuildWorker | undefined;
  try {
    for (const f of scan.files) {
      if (shouldStop() || revision !== (_chatRevisions.get(userId) || 0)) { cancelled = true; break; }
      const known = chatStore.readFileWatermark(userId, f.fileKey);
      if (!_dirtyChats.get(userId)?.has(f.fileKey)
          && known && known.mtime === f.mtime && known.size === f.size) continue;
      worker ??= new ChatRebuildWorker(userId);
      if (!await _reindexChatFile(userId, f, shouldStop, worker)) { cancelled = true; break; }
      updated++;
    }
    if (!cancelled && !shouldStop() && revision === (_chatRevisions.get(userId) || 0)) {
      const missing = [...chatStore.indexedConversationIds(userId)].some(cid => !seen.has(cid));
      if (missing) {
        worker ??= new ChatRebuildWorker(userId);
        deleted = await worker.deleteMissing([...seen]);
      }
    }
  } finally {
    await worker?.close();
  }
  const sourceStampAfter = cancelled ? undefined : await _chatSourceStamp(userId);
  const complete = !cancelled && !shouldStop()
    && revision === (_chatRevisions.get(userId) || 0) && sourceStampBefore === sourceStampAfter;
  if (complete) {
    // The worker is closed. No append/invalidation can interleave between
    // this final revision check and the synchronous ready handoff.
    _dirtyChats.delete(userId);
    // Rebuilds replace or delete rows and leave free SQLite pages behind.
    // Reclaim them once while the index is still marked as migrating, never
    // on the latency-sensitive incremental append path.
    if (updated > 0 || deleted > 0) chatStore.compact(userId);
    chatStore.markRebuildComplete(userId, sourceStampAfter!);
    _migratingChats.delete(userId);
    _currentChatIndexes.add(userId);
    _chatReconcileRuns.delete(userId);
    cancelChatIndexRepair(userId);
    await cleanupLegacyChatIndex(userId);
  }
  log.info(`chat reconcile complete=${complete} scanned=${scan.files.length} updated=${updated} deleted=${deleted} ms=${Date.now() - startedAt}`);
  return { scanned: scan.files.length, updated, deleted, complete, ...(!complete ? { cancelled: true } : {}) };
}

/** Return true when the persisted/in-memory chat index agrees with the small
 * conversation catalog. A true result intentionally avoids a full history
 * directory walk on the query path. */
export async function isChatsIndexCurrent(userId: string): Promise<boolean> {
  if (_chatReconcileRuns.has(userId) || _isMigrating(userId)) return false;
  const revision = _chatRevisions.get(userId) || 0;
  const stamp = chatStore.readSourceStamp(userId);
  if (!stamp) {
    _currentChatIndexes.delete(userId);
    return false;
  }
  const sourceStamp = await _chatSourceStamp(userId);
  // The async catalog read can overlap sync invalidation or a new repair.
  // An old read must not resurrect trust after either has cleared it.
  const current = stamp === sourceStamp && !_chatReconcileRuns.has(userId)
    && !_isMigrating(userId) && revision === (_chatRevisions.get(userId) || 0)
    && stamp === chatStore.readSourceStamp(userId);
  if (current) _currentChatIndexes.add(userId);
  else _currentChatIndexes.delete(userId);
  return current;
}

/** Fast query-path gate. This is deliberately separate from
 * isChatsIndexCurrent(), whose public/test contract is an explicit source
 * fingerprint check. */
export function isChatsIndexTrusted(userId: string): boolean {
  return _currentChatIndexes.has(userId);
}

/** Sync is the only normal path that can replace source JSONLs without also
 * applying the incremental search-index mutations. Normal app writes keep a
 * verified process snapshot current through indexChatMessage/dropChatConversation
 * and must not trigger a redundant history scan on the next query. */
export function invalidateChatsIndex(userId: string): void {
  _noteChatChange(userId);
  _currentChatIndexes.delete(userId);
  // A running pass persisted invalidation before opening its writer.
  if (!_chatReconcileRuns.has(userId)) chatStore.writeSourceStamp(userId, undefined);
  scheduleChatIndexRepair(userId, 1_000);
}

/**
 * Upsert a single chat message doc — the hot path on every appended message.
 *
 * Caller passes `msgIndex` (from `appendJsonlAtomic`) so we don't have to
 * re-scan the jsonl. Complexity is O(tokens in this message) for both write
 * and posting update — independent of conversation length.
 */
async function _upsertChatMessageDoc(
  userId: string, fileKey: string, msgIndex: number, msg: ChatMessage,
): Promise<void> {
  const text = _msgText(msg);
  const idxPath = _chatIdxPath(userId);
  const file = _chatJsonlFile(userId, fileKey);
  let st: fs.Stats | undefined;
  try { st = await fsp.stat(file); } catch { /* file may have been deleted */ }
  await _getLock(idxPath).runExclusive(async () => {
    // A repair may have started while stat was in flight.
    if (_chatReconcileRuns.has(userId) || _isMigrating(userId)) {
      _noteChatChange(userId, fileKey);
      _currentChatIndexes.delete(userId);
      scheduleChatIndexRepair(userId);
      return;
    }
    const known = chatStore.readFileWatermark(userId, fileKey);
    // One appended message only proves the index is complete for the whole
    // file when it lands exactly on the watermark. Re-stamping mtime+size
    // without that proof certifies history this index never read, and
    // `reconcileChatsIndex` then skips the file for good — the conversation
    // keeps only its indexed tail and the rest silently stops being
    // searchable. A fresh file legitimately starts at position 0.
    const contiguous = (known ? known.next : 0) === msgIndex;
    if (text) {
      chatStore.upsertDoc(userId, {
        cid: fileKey, msgIndex, role: _msgRole(msg), time: _msgTime(msg), text,
      });
    }
    if (contiguous && st) {
      // A body-less row still advances the watermark: it produces no doc, so
      // the next real message is still a contiguous continuation.
      chatStore.setFileWatermark(userId, fileKey, {
        mtime: st.mtimeMs, size: st.size, next: msgIndex + 1,
      });
    } else {
      _releaseChatFileToReconciler(userId, fileKey);
    }
  });
}

/** Hand one conversation file back to the reconciler. Dropping the entry is
 * what makes the next reconcile re-read it; clearing the snapshot fingerprint
 * and the trusted flag is what makes that reconcile actually happen, because
 * appending to an existing JSONL leaves the chat-root stat unchanged. */
function _releaseChatFileToReconciler(userId: string, fileKey: string): void {
  chatStore.dropFileWatermark(userId, fileKey);
  chatStore.writeSourceStamp(userId, undefined);
  _currentChatIndexes.delete(userId);
}

export function indexChatMessage(
  userId: string, cid: string, msgIndex: number, msg: ChatMessage,
): Promise<void> {
  return (async () => {
    if (_chatReconcileRuns.has(userId) || _isMigrating(userId)) {
      _noteChatChange(userId, cid);
      _currentChatIndexes.delete(userId);
      scheduleChatIndexRepair(userId, 1_000);
      return;
    }
    await _upsertChatMessageDoc(userId, cid, msgIndex, msg);
  })().catch((err) => {
    _currentChatIndexes.delete(userId);
    log.warn('index chat message failed', { error: logErrorSummary(err) });
  });
}

async function _dropChatFile(userId: string, fileKey: string): Promise<void> {
  _noteChatChange(userId, fileKey);
  await _getLock(_chatIdxPath(userId)).runExclusive(async () => {
    if (_chatReconcileRuns.has(userId)) {
      _currentChatIndexes.delete(userId);
      scheduleChatIndexRepair(userId, 1_000);
      return;
    }
    chatStore.deleteConversation(userId, fileKey);
  });
}

export function dropChatConversation(userId: string, cid: string): Promise<void> {
  return _dropChatFile(userId, cid).catch((err) => {
    _currentChatIndexes.delete(userId);
    log.warn('drop chat conversation from index failed', { error: logErrorSummary(err) });
  });
}

// ── Internal handle for query-side reads ─────────────────────────────────

export async function getEntry(idxPath: string, kind: IndexKind): Promise<CacheEntry> {
  return _getEntry(idxPath, kind);
}
