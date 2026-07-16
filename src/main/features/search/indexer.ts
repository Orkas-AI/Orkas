/**
 * In-memory inverted index manager.
 *
 * Lifecycle per idx file:
 *   1. lazy load on first touch (cached in `_cache`)
 *   2. mutations mark the entry dirty + schedule a 1s debounced flush
 *   3. `reconcileX(...)` is cheap — for each source file it compares the
 *      stored mtime+size against current stat; only changed/added files get
 *      re-tokenized, missing files have their docs dropped
 *   4. `flushAll()` is called from app quit
 *
 * Concurrency: per-idx Mutex serializes write paths so two appends to the
 * same conversation can't race the line-count read. Reconciliation also
 * holds the lock so it doesn't see a half-applied upsert.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import {
  userContextsDir, userChatsDir, projectChatsDir,
  projectChatIndexFile, userContextsIndexPath, userChatsIndexPath,
} from '../../paths';
import { conversationMessageReadFile, listProjectIds } from '../../util/project-layout';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';

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
    flushOne(idxPath).catch((err) => log.warn(`flush failed: ${err.message}`));
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
          log.warn(`idx ${idxPath} is ${(size / 1024 / 1024).toFixed(1)}MB — consider sharding`);
        }
      } catch { /* ignore */ }
    } catch (err) {
      entry.dirty = true;
      // Retry with exponential-ish backoff so a transient disk error doesn't
      // strand the unflushed work forever.
      setTimeout(() => {
        flushOne(idxPath).catch(() => {});
      }, FLUSH_DELAY_MS * 5);
      throw err;
    }
  });
}

export async function flushAll(): Promise<void> {
  await Promise.all(Array.from(_cache.keys()).map((p) => flushOne(p).catch(() => {})));
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

async function _readJsonl(file: string, signal?: AbortSignal): Promise<ChatMessage[] | null> {
  let text: string;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch { return null; }
  const out: ChatMessage[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % CPU_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return null;
    }
    const line = lines[i];
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function _msgText(msg: ChatMessage | null | undefined): string {
  if (!msg) return '';
  // Group-chat shape (current) wins when present; legacy `content` is the
  // fallback for older jsonl that predates the bus refactor.
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  return '';
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
// (kb_search tool); BM25 here is for path/name navigation only.

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

function _chatIdxPath(uid: string): string { return userChatsIndexPath(uid); }
function _chatJsonlFile(uid: string, cid: string): string {
  return conversationMessageReadFile(uid, cid);
}

function _docId(kind: IndexKind, fileKey: string, msgIndex: number): string {
  return `${kind}:${fileKey}:${msgIndex}`;
}

async function _reindexChatFile(
  idx: RuntimeIndex, fileKey: string, file: string, mtimeMs: number, size: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const msgs = await _readJsonl(file, signal);
  if (!msgs || signal?.aborted) return false;
  _dropDocsByFileKey(idx, fileKey);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = _msgText(m);
    if (!text) continue;
    const doc: Doc = {
      fileKey, kind: 'chat', msg_index: i, cid: fileKey,
      role: _msgRole(m), time: _msgTime(m), len: text.length,
    };
    _putDoc(idx, _docId('chat', fileKey, i), doc, text);
    if (i > 0 && i % CPU_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  idx.files[fileKey] = { mtime: mtimeMs, size };
  return true;
}

export async function reconcileChatsIndex(
  userId: string,
  signal?: AbortSignal,
): Promise<SearchReconcileResult> {
  const startedAt = Date.now();
  const idxPath = _chatIdxPath(userId);
  const [sourceStampBefore, scan] = await Promise.all([
    _chatSourceStamp(userId),
    _listUserChats(userId, fsp.stat, signal),
  ]);
  if (!scan.complete || signal?.aborted) {
    log.info(`chat reconcile cancelled scanned=${scan.files.length} ms=${Date.now() - startedAt}`);
    return { scanned: scan.files.length, updated: 0, deleted: 0, cancelled: true };
  }
  let updated = 0;
  let deleted = 0;
  let cancelled = false;
  let completed = false;
  await _getLock(idxPath).runExclusive(async () => {
    if (signal?.aborted) { cancelled = true; return; }
    const entry = await _getEntry(idxPath, 'chat');
    const seen = new Set<string>();
    let dirty = false;
    const toUpdate: ChatFileInfo[] = [];
    for (const f of scan.files) {
      seen.add(f.fileKey);
      const known = entry.idx.files[f.fileKey];
      if (known && known.mtime === f.mtime && known.size === f.size) continue;
      toUpdate.push(f);
    }
    for (const f of toUpdate) {
      if (signal?.aborted) { cancelled = true; break; }
      if (!await _reindexChatFile(entry.idx, f.fileKey, f.file, f.mtime, f.size, signal)) {
        cancelled = true;
        break;
      }
      updated += 1;
      dirty = true;
    }
    if (!cancelled) {
      for (const fk of Object.keys(entry.idx.files)) {
        if (!seen.has(fk)) {
          _dropDocsByFileKey(entry.idx, fk);
          deleted += 1;
          dirty = true;
        }
      }
    }
    // If the catalog moved while the potentially long JSONL pass was
    // running, do not bless a mixed snapshot. The next search will retry.
    const sourceStampAfter = cancelled ? undefined : await _chatSourceStamp(userId);
    const completedSourceStamp = !cancelled && sourceStampBefore === sourceStampAfter ? sourceStampAfter : undefined;
    completed = Boolean(completedSourceStamp);
    if (entry.idx.sourceStamp !== completedSourceStamp) {
      entry.idx.sourceStamp = completedSourceStamp;
      dirty = true;
    }
    if (dirty) { entry.dirty = true; _markDirty(idxPath); }
  });
  const result = {
    scanned: scan.files.length,
    updated,
    deleted,
    ...(cancelled ? { cancelled: true } : {}),
  };
  if (completed) _currentChatIndexes.add(userId);
  log.info(`chat reconcile ${cancelled ? 'cancelled' : 'complete'} scanned=${result.scanned} updated=${updated} deleted=${deleted} ms=${Date.now() - startedAt}`);
  return result;
}

/** Return true when the persisted/in-memory chat index agrees with the small
 * conversation catalog. A true result intentionally avoids a full history
 * directory walk on the query path. */
export async function isChatsIndexCurrent(userId: string): Promise<boolean> {
  const entry = await _getEntry(_chatIdxPath(userId), 'chat');
  if (!entry.idx.sourceStamp) {
    _currentChatIndexes.delete(userId);
    return false;
  }
  const current = entry.idx.sourceStamp === await _chatSourceStamp(userId);
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
  _currentChatIndexes.delete(userId);
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
  if (!text) return;
  const idxPath = _chatIdxPath(userId);
  const file = _chatJsonlFile(userId, fileKey);
  let st: fs.Stats | undefined;
  try { st = await fsp.stat(file); } catch { /* file may have been deleted */ }
  await _getLock(idxPath).runExclusive(async () => {
    const entry = await _getEntry(idxPath, 'chat');
    const doc: Doc = {
      fileKey, kind: 'chat', msg_index: msgIndex, cid: fileKey,
      role: _msgRole(msg), time: _msgTime(msg), len: text.length,
    };
    _putDoc(entry.idx, _docId('chat', fileKey, msgIndex), doc, text);
    if (st) entry.idx.files[fileKey] = { mtime: st.mtimeMs, size: st.size };
    entry.dirty = true;
  });
  _markDirty(idxPath);
}

export function indexChatMessage(userId: string, cid: string, msgIndex: number, msg: ChatMessage): void {
  _upsertChatMessageDoc(userId, cid, msgIndex, msg)
    .catch((err) => log.warn(`index chat msg failed: ${err.message}`));
}

async function _dropChatFile(userId: string, fileKey: string): Promise<void> {
  const idxPath = _chatIdxPath(userId);
  await _getLock(idxPath).runExclusive(async () => {
    const entry = await _getEntry(idxPath, 'chat');
    if (!entry.idx.files[fileKey]) return;
    _dropDocsByFileKey(entry.idx, fileKey);
    entry.dirty = true;
  });
  _markDirty(idxPath);
}

export function dropChatConversation(userId: string, cid: string): void {
  _dropChatFile(userId, cid).catch(() => {});
}

// ── Internal handle for query-side reads ─────────────────────────────────

export async function getEntry(idxPath: string, kind: IndexKind): Promise<CacheEntry> {
  return _getEntry(idxPath, kind);
}
