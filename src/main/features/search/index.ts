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

import {
  WS_ROOT,
  userContextsIndexPath, userChatsIndexPath,
  userSearchDir,
  userKbVectorDbPath, projectLibraryVectorDbPath,
} from '../../paths';
import { conversationMessageReadFile } from '../../util/project-layout';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';
import { logErrorSummary, logPathRef, maskId } from '../../util/log-redact';
import { t } from '../../i18n';

const log = createLogger('search');

import { tokenize, isCJK } from './tokenize';
import { scorePostings, type ScoredDoc } from './bm25';
import { SCHEMA_VERSION, type Index, type Doc } from './storage';
import * as indexer from './indexer';
import * as chatStore from './chat_store';
import type { ChatSnippet } from './snippet';
import { readChatSnippets } from './chat-snippets';
import { chatEligibility } from './chat-eligibility';
import {
  isRelevantLibraryContentHit,
  libraryContentDisplayScore,
} from './library_content_ranking';

export {
  upsertContext, dropContext,
  indexChatMessage,
  dropChatConversation,
  reindexChatConversation,
  reconcileContextsIndex,
  invalidateContextsIndex,
  flushAll,
} from './indexer';

const DEFAULT_PER_KIND = 30;
const MAX_PER_KIND = 200;
const SNIPPET_RADIUS = 60;
const LIBRARY_EMBED_CACHE_MAX = 32;
let _slowSearchLoggedAt = Number.NEGATIVE_INFINITY;
const _progressWarnings = new Map<SearchResult['kind'], number>();
const RESERVED_RECONCILE_DIRS = new Set([
  // Current machine-global data roots.
  'logs', 'venv',
  // Legacy/shared layouts that may remain after upgrades or manual repair.
  'users', 'shared', 'search', 'openclaw', 'local',
]);

interface ChatDisplayCatalog {
  excluded: Set<string>;
  ownershipComplete: boolean;
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
      chats.listConversationDisplayRows(userId, { includeDeleted: true }),
      projects.listProjectNameRows(userId),
    ]);
    const eligibility = await chatEligibility(userId, conversationRows);
    const catalog: ChatDisplayCatalog = {
      excluded: eligibility.excluded,
      ownershipComplete: eligibility.complete,
      titles: new Map(),
      cidToPid: new Map(),
      pidToName: new Map(projectRows.map((row) => [row.project_id, row.name])),
    };
    for (const row of conversationRows) {
      if (catalog.excluded.has(row.conversation_id)) continue;
      catalog.titles.set(row.conversation_id, row.title);
      if (row.project_id) catalog.cidToPid.set(row.conversation_id, row.project_id);
    }
    if ((_chatDisplayCatalogGeneration.get(userId) || 0) === generation) {
      _chatDisplayCatalogCache.set(userId, catalog);
    }
    return catalog;
  })();
  _chatDisplayCatalogInFlight.set(userId, run);
  try {
    const catalog = await run;
    // A delete/restore may finish while this snapshot is being read.
    return (_chatDisplayCatalogGeneration.get(userId) || 0) === generation
      ? catalog : _getChatDisplayCatalog(userId);
  }
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
  kind: 'context' | 'chat' | 'agent' | 'skill' | 'automation' | 'todo' | 'connector';
  score: number;
  snippet: string;
  [extra: string]: unknown;
}

interface LibraryVectorHit {
  rel_path: string;
  chunk_idx: number;
  title?: string | null;
  content: string;
  score: number;
}

interface LibraryContentSearchProvider {
  hasSources?(userId: string, projectId?: string): Promise<boolean>;
  embedQuery(query: string): Promise<number[]>;
  searchGlobal(userId: string, queryVec: number[], limit: number): LibraryVectorHit[];
  listProjects(userId: string): Promise<Array<{ project_id: string; name: string }>>;
  searchProject(userId: string, projectId: string, queryVec: number[], limit: number): LibraryVectorHit[];
}

export type SearchDegradationCode =
  | 'library_content_embedding_unavailable'
  | 'library_global_content_unavailable'
  | 'library_project_catalog_unavailable'
  | 'library_project_content_unavailable';

interface SearchLibraryContentsOptions {
  projectId?: string;
  limit?: number;
  onDegraded?: (code: SearchDegradationCode) => void;
  /** A cancelled caller discards the results, so stop reading indexes for it. */
  signal?: AbortSignal;
}

let _libraryContentSearchProviderForTests: LibraryContentSearchProvider | null = null;
const _libraryQueryEmbeddingCache = new Map<string, Promise<number[]>>();

function _boundedSearchLimit(limit: unknown, fallback = DEFAULT_PER_KIND): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PER_KIND, Math.max(1, Math.floor(parsed)));
}

async function _libraryContentSearchProvider(): Promise<LibraryContentSearchProvider> {
  if (_libraryContentSearchProviderForTests) return _libraryContentSearchProviderForTests;
  const [kbEmbed, kbVector, projectLibrary, projects] = await Promise.all([
    import('../kb_embed'),
    import('../kb_vector'),
    import('../project_library_indexer'),
    import('../projects'),
  ]);
  let projectRows: ReturnType<typeof projects.listProjectNameRows> | undefined;
  const listProjects = (userId: string) => projectRows ||= projects.listProjectNameRows(userId);
  return {
    hasSources: async (userId, projectId) => {
      if (fs.existsSync(userKbVectorDbPath(userId))) return true;
      if (projectId) return fs.existsSync(projectLibraryVectorDbPath(userId, projectId));
      try { return (await listProjects(userId)).some(row => fs.existsSync(projectLibraryVectorDbPath(userId, row.project_id))); }
      catch { return true; } // Preserve the existing catalog-failure degradation path.
    },
    embedQuery: (query) => kbEmbed.embedQuery(query),
    searchGlobal: (userId, queryVec, limit) => kbVector.search(userId, queryVec, { k: limit }),
    listProjects,
    searchProject: (userId, projectId, queryVec, limit) => (
      projectLibrary.search(userId, projectId, queryVec, { k: limit })
    ),
  };
}

function _queryEmbedding(
  query: string,
  provider: LibraryContentSearchProvider,
): Promise<number[]> {
  const key = query.trim().toLocaleLowerCase();
  const cached = _libraryQueryEmbeddingCache.get(key);
  if (cached) return cached;
  const pending = provider.embedQuery(query);
  _libraryQueryEmbeddingCache.set(key, pending);
  while (_libraryQueryEmbeddingCache.size > LIBRARY_EMBED_CACHE_MAX) {
    const oldest = _libraryQueryEmbeddingCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    _libraryQueryEmbeddingCache.delete(oldest);
  }
  void pending.catch(() => {
    if (_libraryQueryEmbeddingCache.get(key) === pending) {
      _libraryQueryEmbeddingCache.delete(key);
    }
  });
  return pending;
}

// ── Source readers ──────────────────────────────────────────────────────

export function invalidateChatsIndex(userId: string): void {
  indexer.invalidateChatsIndex(userId);
}

export const __searchTestHooks = {
  hasPendingChatRepair: indexer.hasPendingChatRepair,
  cancelChatRepair: indexer.cancelChatIndexRepair,
  setLibraryContentSearchProvider: (provider: LibraryContentSearchProvider | null): void => {
    _libraryContentSearchProviderForTests = provider;
    _libraryQueryEmbeddingCache.clear();
  },
  limitSearchResults: (
    results: SearchResult[],
    limit: number,
    scope: SearchAllOptions['scope'] = 'all',
  ): SearchResult[] => _limitSearchResults(results, _boundedSearchLimit(limit), scope),
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

/** Score an in-memory index (contexts, agents, skills, and the legacy chat
 *  snapshot) through the shared arithmetic above. */
function _scoreIndex(idx: RuntimeIndex, queryTokens: string[]): Map<string, ScoredDoc> {
  const avgdl = _avgDocLen(idx);
  return scorePostings<string>(
    Object.keys(idx.docs).length,
    avgdl,
    queryTokens,
    (term) => (idx.postings[term] || []).map(([docId, tf]) => ({
      key: docId,
      tf,
      len: typeof idx.docs[docId]?.len === 'number' ? (idx.docs[docId].len as number) : avgdl,
    })),
  );
}

function _topN<R extends { score: number }, K = string>(
  scores: Map<K, ScoredDoc>,
  n: number,
  mapDoc: (docId: K, scored: ScoredDoc) => R | null,
  // Rank docs that carry more of the query above docs that carry less, and
  // only then by BM25. A pure OR sum lets one common-but-strong term outrank
  // a doc that actually contains every word the user typed, which is how a
  // two-word search returns pages of half-matches and never the real hit.
  // CJK queries already get the bigram anchor above; this is the general form.
  tierByCoverage = false,
): R[] {
  const arr: Array<{ row: R; coverage: number }> = [];
  for (const [docId, scored] of scores) {
    const r = mapDoc(docId, scored);
    if (r) arr.push({ row: r, coverage: scored.coverage });
  }
  arr.sort((a, b) => (tierByCoverage ? b.coverage - a.coverage : 0) || (b.row.score - a.row.score));
  return arr.slice(0, n).map((entry) => entry.row);
}

// ── Per-kind queries ─────────────────────────────────────────────────────

export async function searchContexts(
  query: string,
  userId?: string,
  limit = DEFAULT_PER_KIND,
): Promise<SearchResult[]> {
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
  return _topN<SearchResult>(scores, _boundedSearchLimit(limit), (docId, scored) => {
    const doc = entry.idx.docs[docId] as Doc & { path?: string; title?: string };
    if (!doc) return null;
    const rel = String(doc.path || '');
    const relLower = rel.toLowerCase();
    const qLower = q.toLowerCase();
    let rankedScore = scored.score;
    if (relLower === qLower) rankedScore = Math.max(rankedScore, 95);
    else if (relLower.startsWith(qLower)) rankedScore = Math.max(rankedScore, 60);
    else if (relLower.includes(qLower)) rankedScore = Math.max(rankedScore, 35);
    return {
      kind: 'context',
      path: doc.path,
      title: doc.title || rel,
      snippet: rel,
      score: rankedScore,
    };
  });
}

export async function searchProjectContexts(
  userId: string,
  projectId: string,
  query: string,
  limit = DEFAULT_PER_KIND,
  projectName?: string,
): Promise<SearchResult[]> {
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
      projectName === undefined ? projects.getProject(userId, pid).catch(() => null) : Promise.resolve({ name: projectName }),
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
    return scored.slice(0, _boundedSearchLimit(limit));
  } catch (err) {
    log.warn('project contexts search failed', {
      user_id: maskId(userId), project_id: maskId(pid), error: logErrorSummary(err),
    });
    return [];
  }
}

async function _searchAllProjectContextPaths(
  userId: string,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  try {
    const { listProjectNameRows } = await import('../projects');
    const projects = await listProjectNameRows(userId);
    const rows = await Promise.all(projects.map((project) => (
      searchProjectContexts(userId, project.project_id, query, limit, project.name)
    )));
    return rows.flat().sort((a, b) => b.score - a.score).slice(0, limit);
  } catch {
    log.warn('all-project path search unavailable');
    return [];
  }
}

function _libraryContentResult(
  hit: LibraryVectorHit,
  query: string,
  project?: { project_id: string; name: string },
): SearchResult | null {
  const relPath = String(hit.rel_path || '').trim();
  const content = String(hit.content || '').trim();
  if (!relPath || !content || !isRelevantLibraryContentHit(query, {
    score: hit.score,
    path: relPath,
    title: hit.title,
    content,
  })) return null;
  const title = String(hit.title || '').trim() || path.basename(relPath);
  return {
    kind: 'context',
    path: relPath,
    title,
    snippet: _makeSnippet(content, query),
    score: libraryContentDisplayScore(hit.score),
    match_source: 'content',
    chunk_idx: hit.chunk_idx,
    library_scope: project ? 'project' : 'global',
    ...(project ? {
      project_id: project.project_id,
      project_name: project.name,
    } : {}),
  };
}

/** Search the extracted Library bodies already stored in the vector indexes.
 * This never parses source files, creates missing project stores, or performs
 * a source reconcile on the typeahead path. */
export async function searchLibraryContents(
  userId: string,
  query: string,
  options: SearchLibraryContentsOptions = {},
): Promise<SearchResult[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = _boundedSearchLimit(options.limit);
  let provider: LibraryContentSearchProvider;
  let queryVec: number[];
  try {
    provider = await _libraryContentSearchProvider();
    if (provider.hasSources && !await provider.hasSources(userId, options.projectId)) return [];
    if (options.signal?.aborted) return [];
    queryVec = await _queryEmbedding(q, provider);
  } catch {
    log.warn('library content query embedding unavailable', { query_chars: q.length });
    options.onDegraded?.('library_content_embedding_unavailable');
    return [];
  }
  if (options.signal?.aborted) return [];

  const byFile = new Map<string, SearchResult>();
  const keepBest = (result: SearchResult | null): void => {
    if (!result) return;
    const key = result.library_scope === 'project'
      ? `project:${String(result.project_id || '')}:${String(result.path || '')}`
      : `global:${String(result.path || '')}`;
    const current = byFile.get(key);
    if (!current || result.score > current.score) byFile.set(key, result);
  };

  try {
    for (const hit of provider.searchGlobal(userId, queryVec, limit)) {
      keepBest(_libraryContentResult(hit, q));
    }
  } catch {
    log.warn('global Library content search unavailable');
    options.onDegraded?.('library_global_content_unavailable');
  }

  let projects: Array<{ project_id: string; name: string }> = [];
  try {
    projects = await provider.listProjects(userId);
  } catch {
    log.warn('project catalog unavailable for Library content search');
    options.onDegraded?.('library_project_catalog_unavailable');
  }
  const selectedProjects = options.projectId
    ? projects.filter((project) => project.project_id === options.projectId)
    : projects;
  // Keep an explicitly selected valid project searchable even if its display
  // catalog is momentarily stale; the storage helper still refuses a missing
  // vector store and the result simply omits a project name until refresh.
  if (options.projectId && !selectedProjects.length) {
    selectedProjects.push({ project_id: options.projectId, name: '' });
  }
  for (const [position, project] of selectedProjects.entries()) {
    // Each vector query is synchronous. Across many projects, yield so IPC,
    // stream events and a cancellation can run between them.
    if (position > 0) await new Promise<void>(resolve => setImmediate(resolve));
    if (options.signal?.aborted) return [];
    try {
      for (const hit of provider.searchProject(userId, project.project_id, queryVec, limit)) {
        keepBest(_libraryContentResult(hit, q, project));
      }
    } catch {
      log.warn('one project Library content search unavailable');
      options.onDegraded?.('library_project_content_unavailable');
    }
  }

  return Array.from(byFile.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface SearchChatsOptions {
  /** Desktop hydration selects only references already present in this query's candidates. */
  snippetRefs?: Array<{ cid: string; msg_index: number }>;
  onProgress?: (results: SearchResult[]) => void;
  signal?: AbortSignal;
  /** Restrict candidates to this project only. Ignored unless scope=project. */
  projectId?: string;
  /** Project scope is opt-in at this feature layer; model tools choose it by default in projects. */
  scope?: 'project' | 'all';
  /** Restrict candidates to one exact conversation before loading source rows. */
  conversationId?: string;
  /** Restrict candidates to raw JSONL indexes strictly before this boundary. */
  beforeMsgIndex?: number;
  /** Return only user-visible message bodies, excluding tombstones and hidden dispatch rows. */
  userVisibleOnly?: boolean;
  /** Exclude a conversation whose history is already present in the caller's context. */
  excludeCid?: string;
  /** Maximum candidate rows returned to the caller. */
  limit?: number;
  /** Desktop preview only; ordinary/history callers retain source snippets. */
  includeSnippets?: boolean;
}

export async function searchChats(
  userId: string,
  query: string,
  options: SearchChatsOptions = {},
): Promise<SearchResult[]> {
  return (await searchChatsWithStatus(userId, query, options)).results;
}

/** Cheap coverage-only IPC path: no source bodies, embeddings or rebuild.
 * An unverified index schedules its idle repair here, so opening search starts
 * the catch-up instead of waiting for a typed query. `chat_index_building` is
 * true only until the account's first full build completes: after that an
 * unverified index can lack at most the catch-up work, which the search UI
 * does not announce. `chat_index_complete` keeps its verified meaning for the
 * history tools that report coverage. */
export async function searchIndexStatus(
  userId: string,
): Promise<{ chat_index_complete: boolean; chat_index_building: boolean }> {
  if (indexer.isChatsIndexTrusted(userId) || await indexer.isChatsIndexCurrent(userId)) {
    return { chat_index_complete: true, chat_index_building: false };
  }
  indexer.scheduleChatIndexRepair(userId);
  return { chat_index_complete: false, chat_index_building: !chatStore.hasCompletedRebuild(userId) };
}

/** Query-local index status: a scheduled repair must not turn a partial miss
 * into proof that history contains no matches. Existing UI callers keep arrays. */
export async function searchChatsWithStatus(
  userId: string,
  query: string,
  options: SearchChatsOptions = {},
): Promise<{ results: SearchResult[]; indexComplete: boolean; indexBuilding: boolean; snippetsPending?: boolean }> {
  if (options.signal?.aborted) return { results: [], indexComplete: false, indexBuilding: false };
  const q = (query || '').trim();
  if (!q) return { results: [], indexComplete: true, indexBuilding: false };
  // Ordinary readers settle live writes to include the latest message. The
  // desktop preview uses already committed matches and explicitly reports
  // pending enrichment rather than waiting behind a large live transaction.
  const metadataPreview = options.includeSnippets === false && !options.userVisibleOnly;
  if (!metadataPreview) await indexer.drainDeferredChatWrites(userId);

  // Cold and partial indexes use the same background path (the status check
  // schedules it). Searching must never inherit a history-wide rebuild,
  // including during first migration.
  const status = await searchIndexStatus(userId);
  let indexComplete = status.chat_index_complete;
  const tokens = tokenize(q);
  // Normalize BM25 against the currently available corpus, including a
  // partially rebuilt index.
  const docCount = chatStore.docCount(userId);
  const avgLen = chatStore.avgDocLen(userId);
  const scores = scorePostings<number>(docCount, avgLen, tokens, (term) => (
    chatStore.postingsWithLen(userId, term)
      .map((row) => ({ key: row.doc, tf: row.tf, len: row.len }))
  ));
  const displayCatalog = await _getChatDisplayCatalog(userId);
  indexComplete = indexComplete && displayCatalog.ownershipComplete;

  interface ChatCandidate extends SearchResult {
    sourceFile: string;
    sourceIndex: number;
  }
  // Rank lightweight scores first; a frequent term can match the entire
  // history. Hydrate bounded windows until enough eligible rows survive,
  // preserving scoped/legacy filters and the existing stable coverage order.
  const limit = _boundedSearchLimit(options.limit);
  const ranked = [...scores].sort(([, a], [, b]) => b.coverage - a.coverage || b.score - a.score);
  const batchSize = Math.max(64, limit);
  const candidates: ChatCandidate[] = [];
  const filesByCid = new Map<string, string>();
  const availableCids = new Set<string>();
  for (let offset = 0; offset < ranked.length && candidates.length < limit; offset += batchSize) {
    const batch = ranked.slice(offset, offset + batchSize);
    const docsById = chatStore.docsByIds(userId, batch.map(([id]) => id));
    const eligible = batch.flatMap(([docKey, scored]) => {
      const doc = docsById.get(docKey);
      if (!doc) return [];
      const cid = doc.cid;
      const msgIndex = doc.msgIndex;
      if (!cid || !Number.isInteger(msgIndex) || msgIndex < 0 || displayCatalog.excluded.has(cid)) return [];
      const pid = displayCatalog.cidToPid.get(cid) || '';
      if (options.conversationId && cid !== options.conversationId) return [];
      if (Number.isInteger(options.beforeMsgIndex) && msgIndex >= Number(options.beforeMsgIndex)) return [];
      if (options.excludeCid && cid === options.excludeCid) return [];
      if (options.scope === 'project' && (!options.projectId || pid !== options.projectId)) return [];
      return [{ doc, scored, cid, msgIndex, pid }];
    });
    const unresolved = [...new Set(eligible.map(row => row.cid))].filter(cid => !filesByCid.has(cid));
    // Check only ranked, eligible sources, once per conversation. Metadata
    // preview still reads no history bodies and never scans the whole corpus.
    // Bounded async stats also avoid blocking main on missing network files.
    for (let start = 0; start < unresolved.length; start += 32) {
      await Promise.all(unresolved.slice(start, start + 32).map(async cid => {
        const pid = displayCatalog.cidToPid.get(cid);
        const file = conversationMessageReadFile(userId, cid, pid || (displayCatalog.titles.has(cid) ? null : undefined));
        filesByCid.set(cid, file);
        try {
          if ((await fsp.stat(file)).isFile()) availableCids.add(cid);
          else indexComplete = false;
        } catch { indexComplete = false; }
      }));
    }
    for (const { doc, scored, cid, msgIndex, pid } of eligible) {
      if (!availableCids.has(cid)) continue;
      const result: ChatCandidate = {
        kind: 'chat',
        cid: doc.cid,
        msg_index: doc.msgIndex,
        conv_title: displayCatalog.titles.get(cid) || t('chat.default_title'),
        role: doc.role,
        time: doc.time,
        snippet: '',
        score: scored.score,
        // Carried to the caller so the merge quota and the renderer keep
        // ranking full-query matches first; the row list they cut down to is
        // otherwise re-sorted by raw score and loses the tier.
        term_coverage: scored.coverage,
        sourceFile: filesByCid.get(cid)!,
        sourceIndex: msgIndex,
      };
      if (pid) {
        (result as any).project_id = pid;
        const name = displayCatalog.pidToName.get(pid);
        if (name) (result as any).project_name = name;
      }
      candidates.push(result);
      if (candidates.length >= limit) break;
    }
  }

  // A cold query can otherwise parse hundreds of megabytes across up to 200
  // histories before any category is displayed. Ranked metadata already has
  // the exact message position needed for navigation; enrich it afterwards.
  // Visibility-filtered history tools must still inspect their source rows.
  if (metadataPreview) {
    const pendingWrites = indexer.hasDeferredChatWrites(userId);
    const currentCatalog = await _getChatDisplayCatalog(userId);
    return {
      results: candidates.filter(row => !currentCatalog.excluded.has(String(row.cid))).map(({ sourceFile, sourceIndex, ...result }) => result),
      indexComplete: indexComplete && currentCatalog.ownershipComplete && !pendingWrites,
      indexBuilding: status.chat_index_building,
      snippetsPending: candidates.length > 0 || pendingWrites,
    };
  }

  const byFile = new Map<string, Set<number>>();
  const sourceCids = new Map<string, string>();
  const requested = options.snippetRefs && new Set(options.snippetRefs.slice(0, 32).map(ref => `${ref.cid}:${ref.msg_index}`));
  for (const candidate of candidates) {
    if (requested && !requested.has(`${candidate.cid}:${candidate.msg_index}`)) continue;
    const indexes = byFile.get(candidate.sourceFile) || new Set<number>();
    indexes.add(candidate.sourceIndex);
    byFile.set(candidate.sourceFile, indexes);
    sourceCids.set(candidate.sourceFile, String(candidate.cid));
  }
  const sourceRows = new Map<string, Map<number, ChatSnippet | undefined>>();
  let lastPublication = -Infinity, publications = 0;
  await Promise.all(Array.from(byFile, async ([file, indexes]) => {
    try { sourceRows.set(file, await readChatSnippets(file, indexes, tokens, options.signal, { userId, cid: sourceCids.get(file)! })); }
    catch { sourceRows.set(file, new Map()); } // Source changes/missing files are repaired by reconciliation.
    if (options.onProgress && !options.signal?.aborted && publications < 10 && Date.now() - lastPublication >= 50) {
      lastPublication = Date.now(); publications++;
      options.onProgress(candidates.map(({ sourceFile, sourceIndex, ...row }) => {
        const { visible: _visible, ...snippet } = sourceRows.get(sourceFile)?.get(sourceIndex) || { visible: false };
        return { ...row, ...snippet, ...(requested && sourceRows.has(sourceFile) && requested.has(`${row.cid}:${row.msg_index}`) ? { snippet_loaded: true } : {}) };
      }));
    }
  }));
  if (options.signal?.aborted) return { results: [], indexComplete: false, indexBuilding: false };
  // Missing projections can also mean a temporarily unavailable snippet worker.
  // Keep usable metadata for existing sources; never turn an unlinked history
  // into an empty-snippet ghost. Recheck only affected files, once per source.
  const unresolvedFiles = [...byFile.keys()].filter(file => {
    const rows = sourceRows.get(file);
    return [...byFile.get(file)!].some(index => !rows?.get(index));
  });
  const missingFiles = new Set<string>();
  for (let start = 0; start < unresolvedFiles.length; start += 32) {
    await Promise.all(unresolvedFiles.slice(start, start + 32).map(async file => {
      try { if (!(await fsp.stat(file)).isFile()) missingFiles.add(file); }
      catch { missingFiles.add(file); }
    }));
  }
  const currentCatalog = await _getChatDisplayCatalog(userId);
  indexComplete = indexComplete && currentCatalog.ownershipComplete;
  const results = candidates.flatMap(({ sourceFile, sourceIndex, ...result }) => {
    if (currentCatalog.excluded.has(String(result.cid))) return [];
    if (requested && !requested.has(`${result.cid}:${result.msg_index}`)) return [result];
    const projected = sourceRows.get(sourceFile)?.get(sourceIndex);
    if (!projected) indexComplete = false;
    if (missingFiles.has(sourceFile) || (options.userVisibleOnly && !projected?.visible)) return [];
    const { visible: _visible, ...snippet } = projected || { visible: false, snippet: '' };
    return [{ ...result, ...snippet, ...(requested ? { snippet_loaded: true } : {}) }];
  });
  return { results, indexComplete, indexBuilding: status.chat_index_building };
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

export async function searchAgents(
  _userId: string,
  query: string,
  limit = DEFAULT_PER_KIND,
): Promise<SearchResult[]> {
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
  return scored.slice(0, _boundedSearchLimit(limit));
}

export async function searchSkills(
  _userId: string,
  query: string,
  limit = DEFAULT_PER_KIND,
): Promise<SearchResult[]> {
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
  return scored.slice(0, _boundedSearchLimit(limit));
}

/** Return one hit per visible catalog card, plus this account's custom names.
 * Transport, grants, account labels and tool schemas never enter search text or results. */
export async function searchConnectors(userId: string, query: string, limit = DEFAULT_PER_KIND): Promise<SearchResult[]> {
  const qLower = query.trim().toLowerCase();
  if (!qLower) return [];
  const [{ connectorCatalog }, { listCustomSearchNames }, { catalogWithAvailability }, config, i18n] = await Promise.all([
    import('../connectors/catalog'), import('../connectors/search-listings'),
    import('../connectors/availability'), import('../config'), import('../../i18n'),
  ]);
  const lang = config.resolveLanguageForUser(userId);
  const table = i18n.getRendererTable(lang);
  const catalog = catalogWithAvailability(connectorCatalog());
  const byId = new Map(catalog.map(entry => [entry.id, entry]));
  const children = new Map<string, typeof catalog>();
  const bundled = new Set<string>();
  for (const entry of catalog) {
    if (entry.catalog_parent_id) {
      const rows = children.get(entry.catalog_parent_id) || [];
      rows.push(entry);
      children.set(entry.catalog_parent_id, rows);
    }
    for (const id of entry.bundle_member_ids || []) bundled.add(id);
  }
  const nameFor = (entry: (typeof catalog)[number]): string => lang.startsWith('zh')
    ? entry.display_name_zh || entry.display_name || entry.id
    : entry.display_name_en || entry.display_name || entry.id;
  const descriptionFor = (entry: (typeof catalog)[number]): string =>
    table[`connectors.catalog.${entry.id}.description`]
    || entry[`description_${lang}`] || entry.description_en || entry.description_zh || '';
  const results: SearchResult[] = [];
  for (const entry of catalog) {
    if (entry.catalog_parent_id || bundled.has(entry.id)) continue;
    const name = nameFor(entry);
    const description = descriptionFor(entry);
    const variants = [
      entry, ...(children.get(entry.id) || []),
      ...(entry.bundle_member_ids || []).flatMap(id => byId.get(id) || []),
      ...(entry.connection_variants || []).flatMap(variant => byId.get(variant.catalog_id) || []),
    ];
    let score = 0;
    let snippet = '';
    for (const variant of variants) {
      const desc = descriptionFor(variant);
      const match = Math.max(_matchScore(nameFor(variant), desc, qLower), _matchScore(variant.id, '', qLower));
      if (match <= score) continue;
      score = match;
      snippet = _descSnippet(desc, qLower);
    }
    if (score) results.push({ kind: 'connector', id: entry.id, name, description, snippet, source: 'builtin', score });
  }
  for (const instance of await listCustomSearchNames(userId)) {
    const score = _matchScore(instance.display_name, '', qLower);
    if (score) results.push({
      kind: 'connector', id: instance.id, name: instance.display_name,
      description: '', snippet: '', source: 'custom', score,
    });
  }
  return results.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, _boundedSearchLimit(limit));
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
  // Context path indexes are comparatively small and used by interactive
  // typeahead. Reconcile them in the idle startup cohort so the first query
  // never inherits a full directory walk.
  if (reusePersisted && await _hasPersistedIndex(contextIndex)) reused++;
  operations.push(async () => {
    const result = await indexer.reconcileContextsIndex(uid, signal);
    if (result.cancelled) cancelled += 1;
  });
  // The chat index is `chat_store`, not the retired `chats.idx.json` snapshot.
  // Every existing profile still has that file on disk, so asking the file
  // system whether it exists would report a usable index while the store is
  // empty — chat search would then return nothing until some later reconcile.
  // A source stamp is what "this index was completed at least once" means.
  if (reusePersisted && chatStore.readSourceStamp(uid)) reused++;
  else operations.push(async () => {
    try {
      const result = await indexer.reconcileChatsIndex(uid, signal, !!signal);
      if (!result.complete) {
        cancelled += 1;
        indexer.scheduleChatIndexRepair(uid, 1_000);
      }
    } catch (err) {
      indexer.scheduleChatIndexRepair(uid, 30_000);
      throw err;
    }
  });
  operations.push(() => _unlinkLegacyIndexes(uid));
  operations.push(() => indexer.cleanupLegacyChatIndex(uid));
  let failed = 0;
  // Keep context and chat scans serial inside the shared disk resource slot.
  // Missing both indexes must not create a second internal disk storm.
  for (const operation of operations) {
    try { await operation(); }
    catch { failed += 1; }
  }
  if (failed) log.warn('reconcile user failed', {
    user_id: maskId(uid), failed, tasks: operations.length,
  });
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
  log.info('reconcileActive done', {
    user_id: maskId(uid), duration_ms: Date.now() - t0,
    tasks: result.tasks, reused: result.reused, cancelled: result.cancelled,
  });
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
      if (RESERVED_RECONCILE_DIRS.has(uid)) continue;
      tasks.push(_reconcileUser(uid, false).then(() => undefined));
    }
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info(`reconcileAll done in ${Date.now() - t0}ms (${tasks.length} users, ${failed} failed)`);
}

/** Retired non-chat indexes are independent of the SQLite migration.
 * Chat snapshots are cleaned by the indexer only after its durable ready marker. */
async function _unlinkLegacyIndexes(uid: string): Promise<void> {
  for (const name of [
    'skill_chats.idx.json', 'agent_chats.idx.json',
  ]) {
    const p = path.join(userSearchDir(uid), name);
    try { await fsp.unlink(p); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn('legacy idx unlink failed', {
        path: logPathRef(p), error: logErrorSummary(err),
      });
    }
  }
}

export interface SearchAllOptions {
  chatSnippetRefs?: Array<{ cid: string; msg_index: number }>;
  signal?: AbortSignal;
  limit?: number;
  scope?: 'all' | SearchResult['kind'];
  projectId?: string;
  includeLibraryContent?: boolean;
  includeChatSnippets?: boolean;
}

/** Read the same account-local snapshots as the Automation and To-do pages,
 * including inactive/completed work. */
async function _searchTaskResources(
  userId: string, query: string, limit: number, scope: SearchAllOptions['scope'], signal?: AbortSignal,
): Promise<SearchResult[]> {
  const { listProjectNameRows } = await import('../projects');
  const projects = await listProjectNameRows(userId);
  if (signal?.aborted) return [];
  const projectNames = new Map(projects.map(project => [project.project_id, project.name]));
  const qLower = query.toLowerCase();
  const results: SearchResult[][] = [];
  const operations: Promise<void>[] = [];
  const keep = (rows: SearchResult[], position: number): void => {
    rows.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    results[position] = rows.slice(0, limit);
  };
  if (scope === 'all' || scope === 'automation') {
    operations.push((async () => {
      const { listTaskSearchRows } = await import('../auto_tasks');
      const rows: SearchResult[] = [];
      for (const task of await listTaskSearchRows(userId)) {
        const name = task.title || task.content.slice(0, SNIPPET_RADIUS * 2);
        const score = _matchScore(name, task.content, qLower);
        if (!score) continue;
        rows.push({
          kind: 'automation', id: task.id, name, score,
          snippet: _descSnippet(task.content, qLower), enabled: task.enabled,
          project_id: task.project_id || '', project_name: projectNames.get(task.project_id || '') || '',
        });
      }
      keep(rows, 0);
    })());
  }
  if (scope === 'all' || scope === 'todo') {
    operations.push((async () => {
      const { listTaskSearchRows } = await import('../project_tasks');
      const rows: SearchResult[] = [];
      // Independent snapshots overlap, with four scopes at most. Retain the
      // canonical shared-project resolver and deterministic scope ordering.
      const scopes = [{ project_id: '', name: '' }, ...projects];
      const snapshots: Awaited<ReturnType<typeof listTaskSearchRows>>[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, scopes.length) }, async () => {
        while (next < scopes.length && !signal?.aborted) {
          const index = next++;
          const project = scopes[index];
          snapshots[index] = await listTaskSearchRows(userId, project.project_id, project);
        }
      }));
      for (const [index, project] of scopes.entries()) {
        for (const task of snapshots[index] || []) {
          const name = task.content.slice(0, SNIPPET_RADIUS * 2);
          const score = _matchScore(name, task.content, qLower);
          if (!score) continue;
          rows.push({
            kind: 'todo', id: task.id, name, score,
            snippet: _descSnippet(task.content, qLower), status: task.status,
            project_id: project.project_id, project_name: project.name,
          });
        }
      }
      keep(rows, 1);
    })());
  }
  await Promise.all(operations);
  return results.flat();
}

function _dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  const contextBySource = new Map<string, number>();
  for (const result of results) {
    if (result.kind !== 'context') {
      out.push(result);
      continue;
    }
    const key = result.library_scope === 'project'
      ? `project:${String(result.project_id || '')}:${String(result.path || '')}`
      : `global:${String(result.path || '')}`;
    const existingIndex = contextBySource.get(key);
    if (existingIndex === undefined) {
      contextBySource.set(key, out.length);
      out.push(result);
      continue;
    }
    if (result.score > out[existingIndex].score) out[existingIndex] = result;
  }
  return out;
}

function _chatCoverage(row: SearchResult): number {
  const value = (row as { term_coverage?: unknown }).term_coverage;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function _byChatRank(a: SearchResult, b: SearchResult): number {
  return (_chatCoverage(b) - _chatCoverage(a)) || (b.score - a.score);
}

function _limitSearchResults(
  results: SearchResult[],
  limit: number,
  scope: SearchAllOptions['scope'],
): SearchResult[] {
  const ranked = results.slice().sort((a, b) => b.score - a.score);
  if (scope !== 'all') return ranked.slice(0, limit);

  // A single large Library or chat bucket must not erase every other result
  // kind before the renderer can build its tabs. Reserve an equal first pass,
  // then fill unused capacity by relevance from all remaining rows.
  const kinds: SearchResult['kind'][] = ['chat', 'agent', 'skill', 'context', 'automation', 'todo', 'connector'];
  const quota = Math.max(1, Math.floor(limit / kinds.length));
  const selected = new Set<SearchResult>();
  const out: SearchResult[] = [];
  if (quota > 0) {
    for (const kind of kinds) {
      // Chat rows carry query coverage, so their quota keeps full-query
      // matches ahead of higher-scoring half-matches; every other kind is
      // ordered by score exactly as before.
      const contenders = kind === 'chat'
        ? results.filter((row) => row.kind === 'chat').sort(_byChatRank)
        : ranked.filter((row) => row.kind === kind);
      for (const result of contenders.slice(0, quota)) {
        if (out.length >= limit) break;
        selected.add(result);
        out.push(result);
      }
    }
  }
  for (const result of ranked) {
    if (out.length >= limit) break;
    if (selected.has(result)) continue;
    selected.add(result);
    out.push(result);
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function searchAll(
  userId: string, query: string, {
    limit = 30, scope = 'all', projectId, includeLibraryContent = true, includeChatSnippets = true, signal,
  }: SearchAllOptions = {},
): Promise<{
  results: SearchResult[];
  total?: number;
  degradation_code?: SearchDegradationCode | 'multiple';
  chat_index_complete?: boolean;
  chat_index_building?: boolean;
  library_content_pending?: boolean;
  chat_snippets_pending?: boolean;
}> {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const startedAt = Date.now();
  const phaseMs: Record<string, number> = {};
  const timed = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try { return await operation(); }
    finally { phaseMs[phase] = Math.max(0, Date.now() - start); }
  };
  const requestedLimit = _boundedSearchLimit(limit);
  const buckets: SearchResult[] = [];
  const degradations = new Set<SearchDegradationCode>();
  let chatIndexComplete: boolean | undefined;
  let chatIndexBuilding: boolean | undefined;
  let libraryContentPending = false;
  let chatSnippetsPending = false;
  const tasks: Array<Promise<void>> = [];
  if (scope === 'all' || scope === 'context') {
    tasks.push(timed('library_paths_ms', () => searchContexts(q, userId, requestedLimit)).then((r) => { buckets.push(...r); }));
    tasks.push(timed('project_paths_ms', () => (
      projectId
        ? searchProjectContexts(userId, projectId, q, requestedLimit)
        : _searchAllProjectContextPaths(userId, q, requestedLimit)
    )).then((r) => { buckets.push(...r); }));
    if (includeLibraryContent) tasks.push(timed('library_body_ms', () => searchLibraryContents(userId, q, {
      ...(projectId ? { projectId } : {}),
      limit: requestedLimit,
      onDegraded: (code) => degradations.add(code),
      signal,
    })).then((r) => { buckets.push(...r); }));
    else tasks.push(timed('library_preflight_ms', () => _libraryContentSearchProvider().then(async provider => {
      libraryContentPending = provider.hasSources ? await provider.hasSources(userId, projectId) : true;
    }).catch(() => {
      // An optional preflight must not erase healthy local results. The
      // complete query owns the established semantic degradation contract.
      libraryContentPending = true;
    })));
  }
  if (scope === 'all' || scope === 'chat') {
    tasks.push(timed('chat_ms', () => searchChatsWithStatus(userId, q, {
      limit: requestedLimit, includeSnippets: includeChatSnippets, signal,
    })).then((page) => {
      buckets.push(...page.results);
      chatIndexComplete = page.indexComplete;
      chatIndexBuilding = page.indexBuilding;
      chatSnippetsPending = page.snippetsPending === true;
    }));
  }
  if (scope === 'all' || scope === 'agent') {
    tasks.push(timed('agents_ms', () => searchAgents(userId, q, requestedLimit)).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'skill') {
    tasks.push(timed('skills_ms', () => searchSkills(userId, q, requestedLimit)).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'automation' || scope === 'todo') {
    tasks.push(timed('tasks_ms', () => _searchTaskResources(userId, q, requestedLimit, scope, signal)).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'connector') {
    tasks.push(timed('connectors_ms', () => searchConnectors(userId, q, requestedLimit)).then((r) => { buckets.push(...r); }));
  }
  await Promise.all(tasks);
  // Other categories (especially semantic Library retrieval) may finish long
  // after chat search. A deletion in that interval must also win at the final
  // merge boundary, before quotas and counts are calculated.
  const chatCatalog = buckets.some(row => row.kind === 'chat') ? await _getChatDisplayCatalog(userId) : undefined;
  if (chatCatalog && !chatCatalog.ownershipComplete) chatIndexComplete = false;
  const merged = _dedupeSearchResults(buckets.filter(row => row.kind !== 'chat' || !chatCatalog?.excluded.has(String(row.cid))));
  const finishedAt = Date.now();
  // Local diagnostics only: one record per minute, fixed phase names and no
  // query, account, path or resource identity. Phase wall times overlap.
  if (finishedAt - startedAt >= 500 && finishedAt - _slowSearchLoggedAt >= 60_000) {
    _slowSearchLoggedAt = finishedAt;
    log.info('slow global search', {
      mode: includeChatSnippets && includeLibraryContent ? 'complete' : 'preview',
      scope: ['all', 'chat', 'context', 'agent', 'skill', 'automation', 'todo', 'connector'].includes(scope) ? scope : 'unknown',
      duration_ms: finishedAt - startedAt, result_count: merged.length, ...phaseMs,
    });
  }
  const degradationCode = degradations.size > 1
    ? 'multiple'
    : degradations.values().next().value;
  return {
    results: _limitSearchResults(merged, requestedLimit, scope),
    total: merged.length,
    ...(chatIndexComplete !== undefined ? { chat_index_complete: chatIndexComplete } : {}),
    ...(chatIndexBuilding !== undefined ? { chat_index_building: chatIndexBuilding } : {}),
    ...(degradationCode ? { degradation_code: degradationCode } : {}),
    ...(!includeLibraryContent ? { library_content_pending: libraryContentPending } : {}),
    ...(!includeChatSnippets ? { chat_snippets_pending: chatSnippetsPending } : {}),
  };
}

export interface SearchProgress {
  results: SearchResult[];
  pending_kinds: SearchResult['kind'][];
  failed_kinds: SearchResult['kind'][];
  chat_index_building?: boolean;
  chat_index_complete?: boolean;
}

/** Desktop-only progressive retrieval. Each module publishes independently;
 * complete invoke/history callers retain searchAll's existing settlement contract.
 * Metadata and enrichment publish bounded snapshots; chat files can publish up
 * to ten intermediate completions while slower sources remain pending. */
export async function* streamSearch(
  userId: string, query: string, options: SearchAllOptions = {}, signal?: AbortSignal,
): AsyncGenerator<SearchProgress> {
  const kinds: SearchResult['kind'][] = ['chat', 'todo', 'automation', 'agent', 'skill', 'connector', 'context'];
  const selected = options.scope && options.scope !== 'all' ? kinds.filter(kind => kind === options.scope) : kinds;
  const controller = new AbortController();
  const abort = () => { controller.abort(); wake?.(); };
  let wake: (() => void) | undefined;
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const pending = new Set(selected), failed = new Set<SearchResult['kind']>();
  const buckets = new Map<SearchResult['kind'], SearchResult[]>();
  const startedAt = Date.now(), phaseMs: Record<string, number> = {};
  let chatIndexComplete: boolean | undefined, chatIndexBuilding: boolean | undefined;
  let dirty = 0, published = 0;
  const changed = () => { dirty++; wake?.(); wake = undefined; };
  const detailsAt = Date.now() + (options.chatSnippetRefs ? 0 : 200);
  const quiet = async () => {
    const { setTimeout } = await import('node:timers/promises');
    await setTimeout(Math.max(0, detailsAt - Date.now()), undefined, { signal: controller.signal });
  };
  const readChatDetails = async () => {
    const detailStarted = Date.now();
    const full = await searchChatsWithStatus(userId, query, { limit: options.limit, signal: controller.signal,
      snippetRefs: options.chatSnippetRefs,
      onProgress: results => { buckets.set('chat', results); changed(); },
    });
    phaseMs.chat_snippets_ms = Date.now() - detailStarted;
    if (controller.signal.aborted) return;
    buckets.set('chat', full.results); chatIndexComplete = full.indexComplete; chatIndexBuilding = full.indexBuilding;
  };
  for (const kind of selected) void (async () => {
    const moduleStarted = Date.now();
    try {
      if (controller.signal.aborted) return;
      // A summary batch fills rows the renderer already shows. A metadata
      // preview here would only rank the corpus again on the main thread.
      if (kind === 'chat' && options.chatSnippetRefs?.length) { await readChatDetails(); return; }
      const preview = async () => {
        const page = await searchAll(userId, query, { ...options, scope: kind,
          includeLibraryContent: false, includeChatSnippets: false, signal: controller.signal });
        if (controller.signal.aborted) return page;
        buckets.set(kind, page.results);
        if (kind === 'chat') { chatIndexComplete = page.chat_index_complete; chatIndexBuilding = page.chat_index_building; }
        return page;
      };
      // Sampled before ranking: a message queued ahead of this submit may match
      // but be invisible to the preview, and the first page has no follow-up
      // query to correct a false "no results". Later writes are not waited for.
      const settleWrites = kind === 'chat' && options.chatSnippetRefs?.length === 0 && indexer.hasDeferredChatWrites(userId);
      const page = await preview();
      phaseMs[`${kind}_preview_ms`] = Date.now() - moduleStarted;
      if (controller.signal.aborted) return;
      if (settleWrites) {
        changed();
        await indexer.drainDeferredChatWrites(userId);
        if (!controller.signal.aborted) await preview();
        return;
      }
      const enrich = (page.chat_snippets_pending && !options.chatSnippetRefs) || page.library_content_pending;
      if (enrich) {
        changed();
        await quiet();
        if (controller.signal.aborted) return;
        if (kind === 'chat') await readChatDetails();
        else {
          const detailStarted = Date.now();
          const bodies = await searchLibraryContents(userId, query, { limit: options.limit, projectId: options.projectId,
            onDegraded: () => failed.add(kind), signal: controller.signal });
          phaseMs.library_body_ms = Date.now() - detailStarted;
          if (controller.signal.aborted) return;
          buckets.set(kind, _dedupeSearchResults([...page.results, ...bodies]));
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        failed.add(kind);
        const now = Date.now(), previous = _progressWarnings.get(kind);
        if (previous === undefined || now < previous || now - previous >= 60_000) {
          _progressWarnings.set(kind, now);
          log.warn('progressive search module unavailable', { kind });
        }
      }
    } finally { phaseMs[`${kind}_ms`] = Date.now() - moduleStarted; pending.delete(kind); changed(); }
  })();
  try {
    while (!controller.signal.aborted) {
      if (dirty !== published) {
        published = dirty;
        let results = [...buckets.values()].flat();
        // A task can be deleted while a different module is still running.
        // Revalidate every publication, including already computed snippets.
        if (results.some(row => row.kind === 'chat')) {
          const catalog = await _getChatDisplayCatalog(userId);
          results = results.filter(row => row.kind !== 'chat' || !catalog.excluded.has(String(row.cid)));
          if (!catalog.ownershipComplete) chatIndexComplete = false;
        }
        if (controller.signal.aborted) break;
        if (dirty !== published) continue;
        const finishedAt = Date.now();
        if (!pending.size && finishedAt - startedAt >= 500 && finishedAt - _slowSearchLoggedAt >= 60_000) {
          _slowSearchLoggedAt = finishedAt;
          log.info('slow global search', { mode: 'progressive', scope: options.scope || 'all',
            duration_ms: finishedAt - startedAt, result_count: results.length, ...phaseMs });
        }
        yield { results: _limitSearchResults(_dedupeSearchResults(results), _boundedSearchLimit(options.limit), options.scope || 'all'),
          pending_kinds: selected.filter(kind => pending.has(kind)), failed_kinds: selected.filter(kind => failed.has(kind)),
          chat_index_complete: chatIndexComplete, chat_index_building: chatIndexBuilding };
      }
      if (dirty !== published) continue;
      // An abort delivered while the consumer held this generator at its yield
      // has no pending wake; a module behind a live write may not finish soon.
      if (controller.signal.aborted || !pending.size) break;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    controller.abort();
    buckets.clear();
    signal?.removeEventListener('abort', abort);
  }
}
