/**
 * Global search query API.
 *
 * Backed by per-kind inverted indexes maintained by `./indexer`. All idx
 * files live under data/search/ and never participate in cloud sync —
 * each device rebuilds from source.
 *
 * Every query first calls the relevant `reconcileX(...)` so out-of-band
 * changes (sync drop-in, manual edit) are picked up automatically. Cost is
 * one stat per source file plus a re-tokenize for any whose mtime/size
 * moved.
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
  WS_ROOT, userChatsDir,
  userContextsIndexPath, userChatsIndexPath,
  userSearchDir,
} from '../../paths';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';
import { t } from '../../i18n';

const log = createLogger('search');

import { tokenize } from './tokenize';
import type { Index, Doc } from './storage';
import * as indexer from './indexer';

export {
  upsertContext, dropContext,
  indexChatMessage,
  dropChatConversation,
  flushAll,
} from './indexer';

const MAX_PER_KIND = 30;
const SNIPPET_RADIUS = 60;

interface RuntimeIndex extends Index {
  _avgdl?: number | null;
  _avgdlVersion?: number;
  _version?: number;
}

interface SourceCache {
  jsonlMessage(file: string, msgIndex: number): { content?: unknown } | null;
  body(file: string): string;
}

export interface SearchResult {
  kind: 'context' | 'chat' | 'agent' | 'skill';
  score: number;
  snippet: string;
  [extra: string]: unknown;
}

// ── Source readers (per-query memoized to avoid re-reading large jsonls) ─

function _makeSourceCache(): SourceCache {
  const lines = new Map<string, string[]>();
  const bodies = new Map<string, string>();
  return {
    jsonlMessage(file, msgIndex) {
      let arr = lines.get(file);
      if (!arr) {
        try { arr = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); }
        catch { arr = []; }
        lines.set(file, arr);
      }
      const line = arr[msgIndex];
      if (!line) return null;
      try { return JSON.parse(line); } catch { return null; }
    },
    body(file) {
      let b = bodies.get(file);
      if (b === undefined) {
        try { b = fs.readFileSync(file, 'utf8'); } catch { b = ''; }
        bodies.set(file, b);
      }
      return b;
    },
  };
}

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
  for (const t of queryTokens) {
    const post = idx.postings[t];
    if (!post) continue;
    const df = post.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    for (const [docId, tf] of post) {
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

export async function searchChats(userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const entry = await indexer.getEntry(userChatsIndexPath(userId), 'chat');
  const tokens = tokenize(q);
  const scores = _scoreIndex(entry.idx as RuntimeIndex, tokens);

  // Conversation titles for display.
  const indexFile = path.join(userChatsDir(userId), '_index.json');
  const titles: Record<string, string> = {};
  try {
    if (fs.existsSync(indexFile)) {
      const items = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const arr = Array.isArray(items) ? items : (items?.items || []);
      for (const c of arr) titles[c.conversation_id] = c.title || '';
    }
  } catch { /* ignore */ }

  const cache = _makeSourceCache();
  return _topN<SearchResult>(scores, MAX_PER_KIND, (docId, score) => {
    const doc = entry.idx.docs[docId] as Doc & { cid?: string; msg_index?: number; role?: string; time?: string };
    if (!doc) return null;
    const file = path.join(userChatsDir(userId), `${doc.cid}.jsonl`);
    const msg = cache.jsonlMessage(file, Number(doc.msg_index));
    return {
      kind: 'chat',
      cid: doc.cid,
      msg_index: doc.msg_index,
      conv_title: titles[String(doc.cid)] || t('chat.default_title'),
      role: doc.role,
      time: doc.time,
      snippet: _makeSnippet(msg && typeof msg.content === 'string' ? msg.content : '', q),
      score,
    };
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

async function _currentLang(): Promise<'zh' | 'en'> {
  try {
    const { getCurrentLang } = await import('../../i18n');
    return getCurrentLang() === 'zh' ? 'zh' : 'en';
  } catch { return 'en'; }
}

function _pickDesc(item: { description_zh?: string; description_en?: string }, lang: 'zh' | 'en'): string {
  const primary = lang === 'zh' ? item.description_zh : item.description_en;
  if (primary && primary.trim()) return primary;
  const fallback = lang === 'zh' ? item.description_en : item.description_zh;
  return fallback || '';
}

export async function searchAgents(_userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const lang = await _currentLang();
  const { listAgents } = await import('../agents');
  const list = await listAgents();
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
  const lang = await _currentLang();
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

/**
 * Run every kind's reconcile once — intended for startup or post-sync hooks.
 * Walks every user dir under WS_ROOT for per-user indexes. Runs in parallel
 * and logs progress so a long first-boot build shows up in the log.
 *
 * Also unlinks legacy `skill_chats.idx.json` / `agent_chats.idx.json` files
 * left behind by older builds — those scopes were dropped from search and
 * the files would otherwise sit forever as orphaned ~MBs in local/search/.
 */
export async function reconcileAll(): Promise<void> {
  const t0 = Date.now();
  const tasks: Array<Promise<void>> = [];
  if (fs.existsSync(WS_ROOT)) {
    for (const ent of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const uid = ent.name;
      // Skip top-level non-user dirs (logs/, builtin/).
      if (uid === 'logs' || uid === 'builtin') continue;
      tasks.push(indexer.reconcileContextsIndex(uid));
      tasks.push(indexer.reconcileChatsIndex(uid));
      tasks.push(_unlinkLegacyIndexes(uid));
    }
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info(`reconcileAll done in ${Date.now() - t0}ms (${tasks.length} idx, ${failed} failed)`);
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

export interface SearchAllOptions { limit?: number; scope?: 'all' | 'context' | 'chat' | 'agent' | 'skill' }

export async function searchAll(
  userId: string, query: string, { limit = 30, scope = 'all' }: SearchAllOptions = {},
): Promise<{ results: SearchResult[]; total?: number }> {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const buckets: SearchResult[] = [];
  const tasks: Array<Promise<void>> = [];
  if (scope === 'all' || scope === 'context') tasks.push(searchContexts(q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'chat')    tasks.push(searchChats(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'agent')   tasks.push(searchAgents(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'skill')   tasks.push(searchSkills(userId, q).then((r) => { buckets.push(...r); }));
  await Promise.all(tasks);
  buckets.sort((a, b) => b.score - a.score);
  return { results: buckets.slice(0, limit), total: buckets.length };
}
