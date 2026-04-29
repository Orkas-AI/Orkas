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
 * Contexts (KB) are indexed by relPath only — directory + filename, not
 * body. Full-text content lookup goes through the vector KB (kb_search
 * tool). Chat-style kinds still tokenize message bodies and generate
 * snippets lazily at query time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  WS_ROOT, userChatsDir, userSkillChatDir, userAgentChatDir,
  userContextsIndexPath, userChatsIndexPath,
  userSkillChatsIndexPath, userAgentChatsIndexPath,
} from '../../paths';
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';

const log = createLogger('search');

import { tokenize } from './tokenize';
import type { Index, Doc } from './storage';
import * as indexer from './indexer';

export {
  upsertContext, dropContext,
  indexChatMessage, indexSkillChatMessage, indexAgentChatMessage,
  reindexSkillChatFile,
  dropChatConversation, dropSkillChat, dropAgentChat,
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
  kind: 'context' | 'chat' | 'skill_chat' | 'agent_chat';
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
      conv_title: titles[String(doc.cid)] || '新对话',
      role: doc.role,
      time: doc.time,
      snippet: _makeSnippet(msg && typeof msg.content === 'string' ? msg.content : '', q),
      score,
    };
  });
}

export async function searchSkillChats(userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const entry = await indexer.getEntry(userSkillChatsIndexPath(userId), 'skill_chat');
  const tokens = tokenize(q);
  const scores = _scoreIndex(entry.idx as RuntimeIndex, tokens);
  const cache = _makeSourceCache();
  return _topN<SearchResult>(scores, MAX_PER_KIND, (docId, score) => {
    const doc = entry.idx.docs[docId] as Doc & { skill_id?: string; msg_index?: number; role?: string; time?: string };
    if (!doc) return null;
    const file = path.join(userSkillChatDir(userId, String(doc.skill_id)), 'chat.jsonl');
    const msg = cache.jsonlMessage(file, Number(doc.msg_index));
    return {
      kind: 'skill_chat',
      skill_id: doc.skill_id,
      msg_index: doc.msg_index,
      role: doc.role,
      time: doc.time,
      snippet: _makeSnippet(msg && typeof msg.content === 'string' ? msg.content : '', q),
      score,
    };
  });
}

export async function searchAgentChats(userId: string, query: string): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const entry = await indexer.getEntry(userAgentChatsIndexPath(userId), 'agent_chat');
  const tokens = tokenize(q);
  const scores = _scoreIndex(entry.idx as RuntimeIndex, tokens);
  const cache = _makeSourceCache();
  return _topN<SearchResult>(scores, MAX_PER_KIND, (docId, score) => {
    const doc = entry.idx.docs[docId] as Doc & { agent_id?: string; msg_index?: number; role?: string; time?: string };
    if (!doc) return null;
    const file = path.join(userAgentChatDir(userId, String(doc.agent_id)), 'chat.jsonl');
    const msg = cache.jsonlMessage(file, Number(doc.msg_index));
    return {
      kind: 'agent_chat',
      agent_id: doc.agent_id,
      msg_index: doc.msg_index,
      role: doc.role,
      time: doc.time,
      snippet: _makeSnippet(msg && typeof msg.content === 'string' ? msg.content : '', q),
      score,
    };
  });
}

/**
 * Run every kind's reconcile once — intended for startup or post-sync hooks.
 * Walks every user dir under WS_ROOT for per-user indexes. Runs in parallel
 * and logs progress so a long first-boot build shows up in the log.
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
      tasks.push(indexer.reconcileSkillChatsIndex(uid));
      tasks.push(indexer.reconcileAgentChatsIndex(uid));
    }
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info(`reconcileAll done in ${Date.now() - t0}ms (${tasks.length} idx, ${failed} failed)`);
}

export interface SearchAllOptions { limit?: number; scope?: 'all' | 'context' | 'chat' | 'skill' | 'agent' }

export async function searchAll(
  userId: string, query: string, { limit = 30, scope = 'all' }: SearchAllOptions = {},
): Promise<{ results: SearchResult[]; total?: number }> {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const buckets: SearchResult[] = [];
  const tasks: Array<Promise<void>> = [];
  if (scope === 'all' || scope === 'context') tasks.push(searchContexts(q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'chat')    tasks.push(searchChats(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'skill')   tasks.push(searchSkillChats(userId, q).then((r) => { buckets.push(...r); }));
  if (scope === 'all' || scope === 'agent')   tasks.push(searchAgentChats(userId, q).then((r) => { buckets.push(...r); }));
  await Promise.all(tasks);
  buckets.sort((a, b) => b.score - a.score);
  return { results: buckets.slice(0, limit), total: buckets.length };
}
