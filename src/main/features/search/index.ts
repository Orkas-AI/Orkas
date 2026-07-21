/**
 * Global search query API.
 *
 * Backed by per-kind inverted indexes maintained by `./indexer`. All idx
 * files live under data/search/ and never participate in cloud sync —
 * each device rebuilds from source.
 *
 * Queries use the persisted index when its lightweight source catalog is
 * unchanged. A catalog mismatch triggers `reconcileX(...)`, which picks up
 * out-of-band changes (sync drop-in, manual edit) with one stat per source
 * file plus a re-tokenize for any whose mtime/size moved.
 *
 * Indexed kinds:
 *   - `context` — KB tree, by relPath only (directory + filename, not
 *     body). Full-text content goes through the vector KB.
 *   - `chat`    — main-conversation jsonl message bodies.
 *
 * Agents and skills are NOT indexed — `searchAgents` / `searchSkills`
 * call the existing list APIs and run an in-memory substring match at
 * query time. The list cardinality is small (typically < 50) so a token
 * inverted index would be over-engineered, and it sidesteps i18n
 * invalidation (description picks per current UI lang at query time).
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Semaphore } from 'async-mutex';

import {
  WS_ROOT,
  userContextsIndexPath, userChatsIndexPath,
  userSearchDir,
} from '../../paths';
import { conversationMessageReadFile } from '../../util/project-layout';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import {
  scheduleBootBackground,
  type ScheduledBootBackgroundTask,
} from '../../util/boot_init';

const log = createLogger('search');

import { tokenize, isCJK } from './tokenize';
import type { Index, Doc } from './storage';
import * as indexer from './indexer';

export {
  upsertContext, dropContext,
  indexChatMessage,
  dropChatConversation,
  reconcileContextsIndex,
  invalidateContextsIndex,
  flushAll,
} from './indexer';

const MAX_PER_KIND = 30;
const SNIPPET_RADIUS = 60;

interface ChatDisplayCatalog {
  titles: Map<string, string>;
  cidToPid: Map<string, string>;
  pidToName: Map<string, string>;
}

const _chatDisplayCatalogCache = new Map<string, ChatDisplayCatalog>();
const _chatDisplayCatalogInFlight = new Map<string, Promise<ChatDisplayCatalog>>();
const _chatDisplayCatalogGeneration = new Map<string, number>();

export function invalidateChatDisplayCatalog(userId: string): void {
  _chatDisplayCatalogCache.delete(userId);
  _chatDisplayCatalogInFlight.delete(userId);
  _chatDisplayCatalogGeneration.set(
    userId,
    (_chatDisplayCatalogGeneration.get(userId) || 0) + 1,
  );
}

async function _getChatDisplayCatalog(userId: string): Promise<ChatDisplayCatalog> {
  const cached = _chatDisplayCatalogCache.get(userId);
  if (cached) return cached;
  const existing = _chatDisplayCatalogInFlight.get(userId);
  if (existing) return existing;
  const generation = _chatDisplayCatalogGeneration.get(userId) || 0;
  const run = (async () => {
    const [chats, projects] = await Promise.all([
      import('../chats'),
      import('../projects'),
    ]);
    const [conversationRows, projectRows] = await Promise.all([
      chats.listConversationDisplayRows(userId),
      projects.listProjectNameRows(userId),
    ]);
    const catalog: ChatDisplayCatalog = {
      titles: new Map(),
      cidToPid: new Map(),
      pidToName: new Map(projectRows.map((row) => [row.project_id, row.name])),
    };
    for (const row of conversationRows) {
      catalog.titles.set(row.conversation_id, row.title);
      if (row.project_id) catalog.cidToPid.set(row.conversation_id, row.project_id);
    }
    if ((_chatDisplayCatalogGeneration.get(userId) || 0) === generation) {
      _chatDisplayCatalogCache.set(userId, catalog);
    }
    return catalog;
  })();
  _chatDisplayCatalogInFlight.set(userId, run);
  try { return await run; }
  finally {
    if (_chatDisplayCatalogInFlight.get(userId) === run) {
      _chatDisplayCatalogInFlight.delete(userId);
    }
  }
}

interface RuntimeIndex extends Index {
  _avgdl?: number | null;
  _avgdlVersion?: number;
  _version?: number;
}

export interface SearchResult {
  kind: 'context' | 'chat' | 'agent' | 'skill';
  score: number;
  snippet: string;
  [extra: string]: unknown;
}

// ── Source readers ──────────────────────────────────────────────────────

interface ChatSourceMessage { id?: unknown; content?: unknown; text?: unknown }

// Search returns at most 30 chat hits. Read only their source records, group
// hits by conversation, and cap the number of simultaneously-open JSONLs so a
// broad query cannot turn into a disk burst. readline's async iterator yields
// between chunks instead of synchronously reading/splitting an entire long
// history on Electron's main event loop.
const _chatSnippetIo = new Semaphore(4);

async function _readJsonlMessagesAt(
  file: string,
  indexes: ReadonlySet<number>,
): Promise<Map<number, ChatSourceMessage>> {
  const found = new Map<number, ChatSourceMessage>();
  if (!indexes.size) return found;
  const maxIndex = Math.max(...indexes);
  return _chatSnippetIo.runExclusive(async () => {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let parsedIndex = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let msg: ChatSourceMessage;
        try { msg = JSON.parse(line) as ChatSourceMessage; }
        catch { continue; }
        if (indexes.has(parsedIndex)) found.set(parsedIndex, msg);
        if (parsedIndex >= maxIndex || found.size >= indexes.size) break;
        parsedIndex += 1;
      }
    } catch {
      // Missing/replaced source files are repaired by the index reconciler.
    } finally {
      lines.close();
      input.destroy();
    }
    return found;
  });
}

const _chatRepairTasks = new Map<string, ScheduledBootBackgroundTask>();

function _scheduleChatIndexRepair(userId: string): void {
  if (_chatRepairTasks.has(userId)) return;
  const task = scheduleBootBackground(
    `search:chat-query-repair:${userId}`,
    (signal) => indexer.reconcileChatsIndex(userId, signal),
    250,
    { resourceClass: 'disk', preferIdle: true, maxSliceMs: 15_000 },
  );
  _chatRepairTasks.set(userId, task);
  void task.promise.finally(() => {
    if (_chatRepairTasks.get(userId) === task) _chatRepairTasks.delete(userId);
  });
}

export function invalidateChatsIndex(userId: string): void {
  indexer.invalidateChatsIndex(userId);
  const pending = _chatRepairTasks.get(userId);
  if (pending) {
    pending.cancel();
    _chatRepairTasks.delete(userId);
  }
}

export const __searchTestHooks = {
  hasPendingChatRepair: (userId: string): boolean => _chatRepairTasks.has(userId),
  cancelChatRepair: (userId: string): void => {
    _chatRepairTasks.get(userId)?.cancel();
    _chatRepairTasks.delete(userId);
  },
};

function _makeSnippet(text: string, query: string): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const tokens = tokenize(query);
  let bestIdx = -1, bestLen = 0;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) { bestIdx = idx; bestLen = t.length; }
  }
  if (bestIdx < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, bestIdx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, bestIdx + bestLen + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// ── Scoring (BM25 with length normalization) ─────────────────────────────
// score(d, q) = Σ idf(t) · (tf·(k1+1)) / (tf + k1·(1 − b + b·|d|/avgdl))

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

function _avgDocLen(idx: RuntimeIndex): number {
  // Memoize per-idx — the idx object is stable in memory until drop/put,
  // at which point we invalidate by stamping a version counter.
  const v = idx._version || 0;
  if (idx._avgdlVersion === v && idx._avgdl != null) return idx._avgdl;
  let total = 0, n = 0;
  for (const docId in idx.docs) {
    const d = idx.docs[docId];
    if (d && typeof d.len === 'number') { total += d.len; n++; }
  }
  idx._avgdl = n ? total / n : 1;
  idx._avgdlVersion = v;
  return idx._avgdl;
}

function _scoreIndex(idx: RuntimeIndex, queryTokens: string[]): Map<string, number> {
  const docCount = Object.keys(idx.docs).length;
  const scores = new Map<string, number>();
  if (!docCount) return scores;
  const avgdl = _avgDocLen(idx);

  // CJK bigram anchor filter — tokenize emits both unigrams (`苏`) and
  // bigrams (`苏格`) per CJK char. Single CJK chars match millions of
  // irrelevant docs (`拉`, `底` are everywhere) and overwhelm BM25; without
  // an anchor, searching `苏格拉底` ranks docs that only happen to contain
  // `拉` or `底` because their unigram contributions accumulate. Whenever
  // the query carries at least one CJK bigram, restrict the candidate set
  // to docs that hit at least one of those bigrams; unigram contributions
  // still adjust ranking within that set. Queries that contain ONLY single
  // CJK chars (e.g. one-char `水`) fall through to the legacy unigram path
  // so short / single-char searches still work.
  const cjkBigrams = queryTokens.filter(
    (t) => t.length === 2 && isCJK(t[0]) && isCJK(t[1]),
  );
  let anchored: Set<string> | null = null;
  if (cjkBigrams.length) {
    anchored = new Set<string>();
    for (const t of cjkBigrams) {
      const post = idx.postings[t];
      if (!post) continue;
      for (const [docId] of post) anchored.add(docId);
    }
    // No anchor bigram hit any doc — the query's full CJK shape doesn't
    // appear in this index. Returning empty here keeps the noise-doc list
    // from showing up; without it, the single-char unigram contributions
    // would still surface unrelated docs.
    if (anchored.size === 0) return scores;
  }

  for (const t of queryTokens) {
    const post = idx.postings[t];
    if (!post) continue;
    const df = post.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    for (const [docId, tf] of post) {
      if (anchored && !anchored.has(docId)) continue;
      const doc = idx.docs[docId];
      const dl = (doc && typeof doc.len === 'number') ? doc.len : avgdl;
      const norm = 1 - BM25_B + BM25_B * (dl / avgdl);
      const contribution = idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
      scores.set(docId, (scores.get(docId) || 0) + contribution);
    }
  }
  return scores;
}

function _topN<R extends { score: number }>(
  scores: Map<string, number>,
  n: number,
  mapDoc: (docId: string, score: number) => R | null,
): R[] {
  const arr: R[] = [];
  for (const [docId, score] of scores) {
    const r = mapDoc(docId, score);
    if (r) arr.push(r);
  }
  arr.sort((a, b) => b.score - a.score);
  return arr.slice(0, n);
}

// ── Per-kind queries ─────────────────────────────────────────────────────

export async function searchContexts(query: string, userId?: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const uid = userId || getActiveUserId();
  // Startup/sync reconciliation establishes a complete in-process snapshot.
  // Normal context mutations patch that snapshot directly, so repeated query
  // keystrokes do not need to re-walk the entire library tree.
  if (!indexer.isContextsIndexCurrent(uid)) {
    await indexer.reconcileContextsIndex(uid);
  }
  const entry = await indexer.getEntry(userContextsIndexPath(uid), 'context');
  const tokens = tokenize(q);
  const scores = _scoreIndex(entry.idx as RuntimeIndex, tokens);
  return _topN<SearchResult>(scores, MAX_PER_KIND, (docId, score) => {
    const doc = entry.idx.docs[docId] as Doc & { path?: string; title?: string };
    if (!doc) return null;
    const rel = String(doc.path || '');
    return {
      kind: 'context',
      path: doc.path,
      title: doc.title || rel,
      snippet: rel,
      score,
    };
  });
}

export async function searchProjectContexts(userId: string, projectId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  const pid = (projectId || '').trim();
  if (!q || !pid) return [];
  const qLower = q.toLowerCase();
  const tokens = tokenize(q).filter((t) => t.length > 1 || !isCJK(t));
  try {
    const [projectFiles, projects] = await Promise.all([
      import('../project_files'),
      import('../projects'),
    ]);
    const [files, project] = await Promise.all([
      projectFiles.listProjectFiles(userId, pid),
      projects.getProject(userId, pid).catch(() => null),
    ]);
    const scored: SearchResult[] = [];
    for (const f of files) {
      const name = f.relPath || f.name || '';
      const lower = name.toLowerCase();
      let score = 0;
      if (lower === qLower) score = 95;
      else if (lower.startsWith(qLower)) score = 60;
      else if (lower.includes(qLower)) score = 35;
      else if (tokens.length && tokens.every((t) => lower.includes(t))) score = 18;
      if (score <= 0) continue;
      scored.push({
        kind: 'context',
        path: name,
        title: name,
        snippet: name,
        score,
        library_scope: 'project',
        project_id: pid,
        project_name: project?.name || '',
      });
    }
    scored.sort((a, b) => b.score - a.score || String(a.path || '').localeCompare(String(b.path || '')));
    return scored.slice(0, MAX_PER_KIND);
  } catch (err) {
    log.warn(`project contexts search failed user=${userId} pid=${pid}: ${(err as Error).message}`);
    return [];
  }
}

export interface SearchChatsOptions {
  /** Restrict candidates to this project only. Ignored unless scope=project. */
  projectId?: string;
  /** Project scope is opt-in at this feature layer; model tools choose it by default in projects. */
  scope?: 'project' | 'all';
  /** Exclude a conversation whose history is already present in the caller's context. */
  excludeCid?: string;
}

export async function searchChats(
  userId: string,
  query: string,
  options: SearchChatsOptions = {},
): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const entry = await indexer.getEntry(userChatsIndexPath(userId), 'chat');
  // A usable persisted snapshot is preferable to making the first query wait
  // for a history-wide repair. Normal writes patch the index incrementally;
  // this stale-snapshot path primarily covers sync/manual edits and repairs in
  // the same idle, serialized disk queue used by startup maintenance. An empty
  // or corrupt snapshot still reconciles synchronously because it cannot
  // return any useful result.
  if (!indexer.isChatsIndexTrusted(userId) && !await indexer.isChatsIndexCurrent(userId)) {
    if (Object.keys(entry.idx.docs).length > 0) _scheduleChatIndexRepair(userId);
    else await indexer.reconcileChatsIndex(userId);
  }
  const tokens = tokenize(q);
  const scores = _scoreIndex(entry.idx as RuntimeIndex, tokens);

  const displayCatalog = await _getChatDisplayCatalog(userId);

  interface ChatCandidate extends SearchResult {
    sourceFile: string;
    sourceIndex: number;
  }
  const candidates = _topN<ChatCandidate>(scores, MAX_PER_KIND, (docId, score) => {
    const doc = entry.idx.docs[docId] as Doc & { cid?: string; msg_index?: number; role?: string; time?: string };
    if (!doc) return null;
    const cid = String(doc.cid);
    const msgIndex = Number(doc.msg_index);
    if (!cid || !Number.isInteger(msgIndex) || msgIndex < 0) return null;
    const pid = displayCatalog.cidToPid.get(cid) || '';
    if (options.excludeCid && cid === options.excludeCid) return null;
    if (options.scope === 'project' && (!options.projectId || pid !== options.projectId)) return null;
    // The catalog above already resolved project membership. Supplying it
    // avoids `conversationMessageReadFile` re-scanning every project index
    // once per search result.
    const file = conversationMessageReadFile(userId, cid, pid || undefined);
    const result: ChatCandidate = {
      kind: 'chat',
      cid: doc.cid,
      msg_index: doc.msg_index,
      conv_title: displayCatalog.titles.get(cid) || t('chat.default_title'),
      role: doc.role,
      time: doc.time,
      snippet: '',
      score,
      sourceFile: file,
      sourceIndex: msgIndex,
    };
    if (pid) {
      (result as any).project_id = pid;
      const name = displayCatalog.pidToName.get(pid);
      if (name) (result as any).project_name = name;
    }
    return result;
  });

  const byFile = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const indexes = byFile.get(candidate.sourceFile) || new Set<number>();
    indexes.add(candidate.sourceIndex);
    byFile.set(candidate.sourceFile, indexes);
  }
  const sourceRows = new Map<string, Map<number, ChatSourceMessage>>();
  await Promise.all(Array.from(byFile, async ([file, indexes]) => {
    sourceRows.set(file, await _readJsonlMessagesAt(file, indexes));
  }));
  return candidates.map(({ sourceFile, sourceIndex, ...result }) => {
    const msg = sourceRows.get(sourceFile)?.get(sourceIndex);
    result.snippet = _makeSnippet(indexer.readMsgText(msg), q);
    if (typeof msg?.id === 'string' && msg.id) result.msg_id = msg.id;
    return result;
  });
}

// ── Agent / skill body search (in-memory, no persistent index) ──────────
//
// Score scheme (shared across both):
//   name === q                  : 100
//   name startsWith q           : 50
//   name includes q             : 30
//   description includes q      : 10
//   else                        : 0   (filtered out)
//
// All comparisons are case-insensitive. Description picks the current UI
// language via the renderer-side `pickDescription` resolver — we do the
// same lookup here against the bilingual fields directly to avoid a
// circular dep into core-agent.

function _matchScore(name: string, description: string, qLower: string): number {
  const n = (name || '').toLowerCase();
  const d = (description || '').toLowerCase();
  if (!qLower) return 0;
  if (n === qLower)         return 100;
  if (n.startsWith(qLower)) return 50;
  if (n.includes(qLower))   return 30;
  if (d.includes(qLower))   return 10;
  return 0;
}

function _descSnippet(description: string, qLower: string): string {
  if (!description) return '';
  const flat = description.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const idx = qLower ? lower.indexOf(qLower) : -1;
  if (idx < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + qLower.length + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

async function _currentDescriptionLang(): Promise<'zh' | 'en'> {
  try {
    const { descriptionLang } = await import('../../i18n');
    const { getLanguage } = await import('../config');
    return descriptionLang(getLanguage());
  } catch { return 'en'; }
}

function _pickDesc(item: { description_zh?: string; description_en?: string }, lang: 'zh' | 'en'): string {
  const primary = item[`description_${lang}`];
  if (primary && primary.trim()) return primary;
  const fallbackLang = ({ zh: 'en', en: 'zh' } as const)[lang];
  const fallback = item[`description_${fallbackLang}`];
  return fallback || '';
}

export async function searchAgents(_userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const lang = await _currentDescriptionLang();
  const { listAgentSearchListings } = await import('../agents');
  const list = await listAgentSearchListings();
  const scored: SearchResult[] = [];
  for (const a of list) {
    const desc = _pickDesc(a, lang);
    const score = _matchScore(a.name || '', desc, qLower);
    if (score <= 0) continue;
    scored.push({
      kind: 'agent',
      id: a.agent_id,
      name: a.name || a.agent_id,
      description: desc,
      source: a.source,
      snippet: _descSnippet(desc, qLower) || (a.name || ''),
      score,
    });
  }
  scored.sort((a, b) =>
    b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, MAX_PER_KIND);
}

export async function searchSkills(_userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const lang = await _currentDescriptionLang();
  const { listSkills } = await import('../skills');
  const list = await listSkills();
  const scored: SearchResult[] = [];
  for (const s of list) {
    const desc = _pickDesc(s, lang);
    const score = _matchScore(s.name || s.id, desc, qLower);
    if (score <= 0) continue;
    scored.push({
      kind: 'skill',
      id: s.id,
      name: s.name || s.id,
      description: desc,
      source: s.source,
      snippet: _descSnippet(desc, qLower) || (s.name || s.id),
      score,
    });
  }
  scored.sort((a, b) =>
    b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, MAX_PER_KIND);
}

async function _hasPersistedIndex(file: string): Promise<boolean> {
  try {
    const st = await fsp.stat(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function _reconcileUser(
  uid: string,
  reusePersisted: boolean,
  signal?: AbortSignal,
): Promise<{ tasks: number; reused: number; cancelled: number }> {
  const operations: Array<() => Promise<void>> = [];
  let reused = 0;
  let cancelled = 0;
  const contextIndex = userContextsIndexPath(uid);
  const chatIndex = userChatsIndexPath(uid);
  // Context path indexes are comparatively small and used by interactive
  // typeahead. Reconcile them in the idle startup cohort so the first query
  // never inherits a full directory walk.
  if (reusePersisted && await _hasPersistedIndex(contextIndex)) reused++;
  operations.push(async () => {
    const result = await indexer.reconcileContextsIndex(uid, signal);
    if (result.cancelled) cancelled += 1;
  });
  if (reusePersisted && await _hasPersistedIndex(chatIndex)) reused++;
  else operations.push(async () => {
    const result = await indexer.reconcileChatsIndex(uid, signal);
    if (result.cancelled) cancelled += 1;
  });
  operations.push(() => _unlinkLegacyIndexes(uid));
  let failed = 0;
  // Keep context and chat scans serial inside the shared disk resource slot.
  // Missing both indexes must not create a second internal disk storm.
  for (const operation of operations) {
    try { await operation(); }
    catch { failed += 1; }
  }
  if (failed) log.warn(`reconcile user=${uid} failed=${failed}/${operations.length}`);
  return { tasks: operations.length, reused, cancelled };
}

/** Startup-only reconcile. It scopes work to the active uid, fully refreshes
 * the smaller context path index, and treats an existing chat index as a
 * usable snapshot without parsing multi-megabyte postings. Chat query-time
 * validation uses the compact conversation catalog before any history scan. */
export async function reconcileActive(signal?: AbortSignal): Promise<void> {
  const t0 = Date.now();
  const uid = getActiveUserId();
  const result = await _reconcileUser(uid, true, signal);
  log.info(`reconcileActive done in ${Date.now() - t0}ms (user=${uid}, tasks=${result.tasks}, reused=${result.reused}, cancelled=${result.cancelled})`);
}

/** Full all-user repair hook. Startup uses `reconcileActive`; this broader
 * variant remains available for explicit maintenance and regression repair. */
export async function reconcileAll(): Promise<void> {
  const t0 = Date.now();
  const tasks: Array<Promise<void>> = [];
  if (fs.existsSync(WS_ROOT)) {
    for (const ent of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const uid = ent.name;
      // Skip top-level non-user dirs.
      if (uid === 'logs') continue;
      tasks.push(_reconcileUser(uid, false).then(() => undefined));
    }
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info(`reconcileAll done in ${Date.now() - t0}ms (${tasks.length} users, ${failed} failed)`);
}

async function _unlinkLegacyIndexes(uid: string): Promise<void> {
  for (const name of ['skill_chats.idx.json', 'agent_chats.idx.json']) {
    const p = path.join(userSearchDir(uid), name);
    try { await fsp.unlink(p); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn(`legacy idx unlink ${p}: ${(err as Error).message}`);
    }
  }
}

export interface SearchAllOptions { limit?: number; scope?: 'all' | 'context' | 'chat' | 'agent' | 'skill'; projectId?: string }

export async function searchAll(
  userId: string, query: string, { limit = 30, scope = 'all', projectId }: SearchAllOptions = {},
): Promise<{ results: SearchResult[]; total?: number }> {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const buckets: SearchResult[] = [];
  const tasks: Array<Promise<void>> = [];
  if (scope === 'all' || scope === 'context') {
    tasks.push(searchContexts(q).then((r) => { buckets.push(...r); }));
    if (projectId) tasks.push(searchProjectContexts(userId, projectId, q).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'chat')    tasks.push(searchChats(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'agent')   tasks.push(searchAgents(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'skill')   tasks.push(searchSkills(userId, q).then((r) => { buckets.push(...r); }));
  await Promise.all(tasks);
  buckets.sort((a, b) => b.score - a.score);
  return { results: buckets.slice(0, limit), total: buckets.length };
}
