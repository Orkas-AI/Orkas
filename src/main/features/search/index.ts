import { hasHistoryProcess, historyMessagesAtFile, historyProcessTexts } from '../chat-history-records';
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

const log = createLogger('search');

import { tokenize, isCJK } from './tokenize';
import { SCHEMA_VERSION, type Index, type Doc } from './storage';
import * as indexer from './indexer';
import * as chatStore from './chat_store';
import {
  isRelevantLibraryContentHit,
  libraryContentDisplayScore,
} from './library_content_ranking';

export {
  upsertContext, dropContext,
  indexChatMessage,
  dropChatConversation,
  reconcileContextsIndex,
  invalidateContextsIndex,
  flushAll,
} from './indexer';

const DEFAULT_PER_KIND = 30;
const MAX_PER_KIND = 200;
const SNIPPET_RADIUS = 60;
const LIBRARY_EMBED_CACHE_MAX = 32;
const RESERVED_RECONCILE_DIRS = new Set([
  // Current machine-global data roots.
  'logs', 'venv',
  // Legacy/shared layouts that may remain after upgrades or manual repair.
  'users', 'shared', 'search', 'openclaw', 'local',
]);

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

interface LibraryVectorHit {
  rel_path: string;
  chunk_idx: number;
  title?: string | null;
  content: string;
  score: number;
}

interface LibraryContentSearchProvider {
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
  return {
    embedQuery: (query) => kbEmbed.embedQuery(query),
    searchGlobal: (userId, queryVec, limit) => kbVector.search(userId, queryVec, { k: limit }),
    listProjects: (userId) => projects.listProjectNameRows(userId),
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

interface ChatSourceMessage {
  id?: unknown;
  content?: unknown;
  text?: unknown;
  process?: unknown;
  deleted_at?: unknown;
  dispatch?: unknown;
}

// Bound concurrent exact source reads, including cold index construction.
const _chatSnippetIo = new Semaphore(4);

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

/** BM25 relevance plus how much of the query the doc actually covers.
 * `coverage` counts distinct query tokens present in the doc; repeating a
 * token in the query still weights the score but cannot inflate coverage. */
interface ScoredDoc { score: number; coverage: number }

/** One posting as the scorer needs it, whatever storage produced it. */
interface PostingRow<K> { key: K; tf: number; len: number }

/**
 * BM25 with the CJK bigram anchor, over any postings source.
 *
 * Kept generic so the in-memory context/agent/skill indexes and the SQLite
 * chat store run the *same* arithmetic: two copies would drift, and ranking
 * drift is invisible until someone notices their search got worse.
 */
function _scorePostings<K>(
  docCount: number,
  avgdl: number,
  queryTokens: string[],
  readPostings: (term: string) => PostingRow<K>[],
): Map<K, ScoredDoc> {
  const scores = new Map<K, ScoredDoc>();
  if (!docCount) return scores;
  // A bigram is read for the anchor and again for scoring; one lookup each.
  const cache = new Map<string, PostingRow<K>[]>();
  const postings = (term: string): PostingRow<K>[] => {
    let rows = cache.get(term);
    if (!rows) { rows = readPostings(term); cache.set(term, rows); }
    return rows;
  };

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
  let anchored: Set<K> | null = null;
  if (cjkBigrams.length) {
    anchored = new Set<K>();
    for (const t of cjkBigrams) for (const row of postings(t)) anchored.add(row.key);
    // No anchor bigram hit any doc — the query's full CJK shape doesn't
    // appear in this index. Returning empty here keeps the noise-doc list
    // from showing up; without it, the single-char unigram contributions
    // would still surface unrelated docs.
    if (anchored.size === 0) return scores;
  }

  const counted = new Set<string>();
  for (const t of queryTokens) {
    const rows = postings(t);
    if (!rows.length) continue;
    const df = rows.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const firstSighting = !counted.has(t);
    counted.add(t);
    for (const row of rows) {
      if (anchored && !anchored.has(row.key)) continue;
      const dl = typeof row.len === 'number' ? row.len : avgdl;
      const norm = 1 - BM25_B + BM25_B * (dl / avgdl);
      const contribution = idf * (row.tf * (BM25_K1 + 1)) / (row.tf + BM25_K1 * norm);
      const scored = scores.get(row.key);
      if (scored) {
        scored.score += contribution;
        if (firstSighting) scored.coverage += 1;
      } else {
        scores.set(row.key, { score: contribution, coverage: firstSighting ? 1 : 0 });
      }
    }
  }
  return scores;
}

/** Score an in-memory index (contexts, agents, skills, and the legacy chat
 *  snapshot) through the shared arithmetic above. */
function _scoreIndex(idx: RuntimeIndex, queryTokens: string[]): Map<string, ScoredDoc> {
  const avgdl = _avgDocLen(idx);
  return _scorePostings<string>(
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
    return scored.slice(0, _boundedSearchLimit(limit));
  } catch (err) {
    log.warn(`project contexts search failed user=${userId} pid=${pid}: ${(err as Error).message}`);
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
      searchProjectContexts(userId, project.project_id, query, limit)
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
    queryVec = await _queryEmbedding(q, provider);
  } catch {
    log.warn('library content query embedding unavailable', { query_chars: q.length });
    options.onDegraded?.('library_content_embedding_unavailable');
    return [];
  }

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
  for (const project of selectedProjects) {
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
}

export async function searchChats(
  userId: string,
  query: string,
  options: SearchChatsOptions = {},
): Promise<SearchResult[]> {
  return (await searchChatsWithStatus(userId, query, options)).results;
}

/** Query-local index status: a scheduled repair must not turn a partial miss
 * into proof that history contains no matches. Existing UI callers keep arrays. */
export async function searchChatsWithStatus(
  userId: string,
  query: string,
  options: SearchChatsOptions = {},
): Promise<{ results: SearchResult[]; indexComplete: boolean }> {
  const q = (query || '').trim();
  if (!q) return { results: [], indexComplete: true };
  // Appends hand their upsert to a deferred chain so a send is not held up by
  // the index; a reader pays that cost instead, and only when it searches.
  await indexer.drainDeferredChatWrites(userId);

  // Cold and partial indexes use the same background path. Searching must
  // never inherit a history-wide rebuild, including during first migration.
  let indexComplete = indexer.isChatsIndexTrusted(userId) || await indexer.isChatsIndexCurrent(userId);
  if (!indexComplete) indexer.scheduleChatIndexRepair(userId);
  const tokens = tokenize(q);
  // Normalize BM25 against the currently available corpus, including a
  // partially rebuilt index.
  const docCount = chatStore.docCount(userId);
  const avgLen = chatStore.avgDocLen(userId);
  const scores = _scorePostings<number>(docCount, avgLen, tokens, (term) => (
    chatStore.postingsWithLen(userId, term)
      .map((row) => ({ key: row.doc, tf: row.tf, len: row.len }))
  ));
  // Resolve every surviving candidate in one statement. Reading metadata from
  // inside the ranking callback would be one query per scored document.
  const docsById = chatStore.docsByIds(userId, [...scores.keys()]);

  const displayCatalog = await _getChatDisplayCatalog(userId);

  interface ChatCandidate extends SearchResult {
    sourceFile: string;
    sourceIndex: number;
  }
  const candidates = _topN<ChatCandidate, number>(
    scores,
    _boundedSearchLimit(options.limit),
    (docKey, scored) => {
      const doc = docsById.get(docKey);
      if (!doc) return null;
      const cid = doc.cid;
      const msgIndex = doc.msgIndex;
      if (!cid || !Number.isInteger(msgIndex) || msgIndex < 0) return null;
      const pid = displayCatalog.cidToPid.get(cid) || '';
      if (options.conversationId && cid !== options.conversationId) return null;
      if (Number.isInteger(options.beforeMsgIndex) && msgIndex >= Number(options.beforeMsgIndex)) return null;
      if (options.excludeCid && cid === options.excludeCid) return null;
      if (options.scope === 'project' && (!options.projectId || pid !== options.projectId)) return null;
      // The catalog above already resolved project membership. Supplying it
      // avoids `conversationMessageReadFile` re-scanning every project index
      // once per search result.
      const file = conversationMessageReadFile(userId, cid, pid || undefined);
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
        sourceFile: file,
        sourceIndex: msgIndex,
      };
      if (pid) {
        (result as any).project_id = pid;
        const name = displayCatalog.pidToName.get(pid);
        if (name) (result as any).project_name = name;
      }
      return result;
    },
    true,
  );

  const byFile = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const indexes = byFile.get(candidate.sourceFile) || new Set<number>();
    indexes.add(candidate.sourceIndex);
    byFile.set(candidate.sourceFile, indexes);
  }
  const sourceRows = new Map<string, Map<number, ChatSourceMessage>>();
  await Promise.all(Array.from(byFile, async ([file, indexes]) => {
    sourceRows.set(file, await _chatSnippetIo.runExclusive(async () => {
      try { return await historyMessagesAtFile(file, indexes); }
      catch { return new Map(); } // Source changes/missing files are repaired by reconciliation.
    }));
  }));
  const results = candidates.flatMap(({ sourceFile, sourceIndex, ...result }) => {
    const msg = sourceRows.get(sourceFile)?.get(sourceIndex);
    if (!msg) indexComplete = false;
    if (
      options.userVisibleOnly
      && (
        !msg
        || !!msg.deleted_at
        || !!msg.dispatch
        || !indexer.readMsgText(msg).trim()
      )
    ) {
      return [];
    }
    result.snippet = _makeSnippet(indexer.readMsgText(msg), q);
    if (msg && hasHistoryProcess(msg)) {
      result.has_process = true;
      // Compare public execution entries separately so a leading dialogue
      // acknowledgement or call input cannot hide a more relevant result.
      let best = '', coverage = 0;
      const terms = [...new Set(tokens)];
      for (const text of historyProcessTexts(msg, true)) {
        const lower = text.toLowerCase();
        const matched = terms.reduce((count, term) => count + Number(lower.includes(term)), 0);
        if (matched > coverage) { best = text; coverage = matched; }
      }
      if (best) result.process_snippet = _makeSnippet(best, q);
    }
    if (typeof msg?.id === 'string' && msg.id) result.msg_id = msg.id;
    return [result];
  });
  return { results, indexComplete };
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
      if (code !== 'ENOENT') log.warn(`legacy idx unlink ${p}: ${(err as Error).message}`);
    }
  }
}

export interface SearchAllOptions { limit?: number; scope?: 'all' | 'context' | 'chat' | 'agent' | 'skill'; projectId?: string }

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
  const kinds: SearchResult['kind'][] = ['chat', 'agent', 'skill', 'context'];
  const quota = Math.floor(limit / kinds.length);
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
  userId: string, query: string, { limit = 30, scope = 'all', projectId }: SearchAllOptions = {},
): Promise<{
  results: SearchResult[];
  total?: number;
  degradation_code?: SearchDegradationCode | 'multiple';
  chat_index_complete?: boolean;
}> {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const requestedLimit = _boundedSearchLimit(limit);
  const buckets: SearchResult[] = [];
  const degradations = new Set<SearchDegradationCode>();
  let chatIndexComplete: boolean | undefined;
  const tasks: Array<Promise<void>> = [];
  if (scope === 'all' || scope === 'context') {
    tasks.push(searchContexts(q, userId, requestedLimit).then((r) => { buckets.push(...r); }));
    tasks.push((
      projectId
        ? searchProjectContexts(userId, projectId, q, requestedLimit)
        : _searchAllProjectContextPaths(userId, q, requestedLimit)
    ).then((r) => { buckets.push(...r); }));
    tasks.push(searchLibraryContents(userId, q, {
      ...(projectId ? { projectId } : {}),
      limit: requestedLimit,
      onDegraded: (code) => degradations.add(code),
    }).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'chat') {
    tasks.push(searchChatsWithStatus(userId, q, { limit: requestedLimit }).then((page) => {
      buckets.push(...page.results);
      chatIndexComplete = page.indexComplete;
    }));
  }
  if (scope === 'all' || scope === 'agent') {
    tasks.push(searchAgents(userId, q, requestedLimit).then((r) => { buckets.push(...r); }));
  }
  if (scope === 'all' || scope === 'skill') {
    tasks.push(searchSkills(userId, q, requestedLimit).then((r) => { buckets.push(...r); }));
  }
  await Promise.all(tasks);
  const merged = _dedupeSearchResults(buckets);
  const degradationCode = degradations.size > 1
    ? 'multiple'
    : degradations.values().next().value;
  return {
    results: _limitSearchResults(merged, requestedLimit, scope),
    total: merged.length,
    ...(chatIndexComplete !== undefined ? { chat_index_complete: chatIndexComplete } : {}),
    ...(degradationCode ? { degradation_code: degradationCode } : {}),
  };
}
