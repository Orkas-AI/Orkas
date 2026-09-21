/**
 * Chat search index backed by SQLite.
 *
 * Replaces the single `chats.idx.json` snapshot, which had to be parsed whole
 * on first use and re-serialized whole on every flush — 947 ms and 589 ms
 * respectively on a 241 MB real-world index, with the parsed form resident at
 * 1.4 GB. Here one appended message is one transaction and a query reads only
 * the postings of the terms it asks for.
 *
 * Tables
 *   • `chat_files`    — per-conversation watermark (mtime + size + next index),
 *                       the same contiguity proof the JSON index kept
 *   • `chat_docs`     — one row per indexed message
 *   • `chat_postings` — (term, doc) → tf, i.e. the inverted index
 *   • `chat_meta`     — the source fingerprint that decides whether a search
 *                       may trust the index without a history-wide re-scan
 *
 * `chat_postings` deliberately stores `tf` rather than delegating to FTS5:
 * chat ranking is BM25 *plus* the CJK bigram anchor in `search/index.ts`, and
 * reproducing it needs the per-term frequency of each candidate, which FTS5
 * does not expose to SQL. Keeping the postings explicit lets the existing
 * scorer run unchanged (P0 spike, 2026-09-20: identical postings for 500
 * sampled terms and identical document lengths).
 *
 * Concurrency: better-sqlite3 is synchronous and every mutation here is a
 * single `db.transaction(...)`. The indexer admits exactly one writer: main
 * for live upserts, or a worker for reconciliation. WAL readers remain usable
 * during rebuilds; data_version invalidates their cached scoring aggregates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import Database from 'better-sqlite3';

import { userSearchDir } from '../../paths';
import { tokenize } from './tokenize';

function warn(message: string, error: unknown): void {
  // Electron APIs are unavailable in Node workers. In dev, the electron npm
  // package masks that boundary; packaged workers cannot import electron-log.
  // Worker failures go back through its bounded, redacted reply instead.
  if (!isMainThread) throw new Error(message);
  const { createLogger } = require('../../logger') as typeof import('../../logger');
  createLogger('search:chat_store').warn(message, { error: (error as Error).message });
}

export const CHAT_STORE_SCHEMA_VERSION = 1;

export interface ChatDocInput {
  cid: string;
  msgIndex: number;
  role: string;
  time: string;
  /** Already extracted by the caller (`readMsgText`); tokenized here. */
  text: string;
}

export interface ChatDocRow {
  id: number;
  docId: string;
  cid: string;
  msgIndex: number;
  role: string;
  time: string;
  len: number;
}

export interface ChatFileWatermark {
  mtime: number;
  size: number;
  /** Index the next appended message must carry for the file to stay proven. */
  next: number;
}

export interface Posting {
  doc: number;
  tf: number;
}

export interface ScoredPosting extends Posting {
  /** `chat_docs.len` — the document length BM25 normalizes by. */
  len: number;
}

/** Stable external id, unchanged from the JSON index so callers keep theirs. */
export function chatDocId(cid: string, msgIndex: number): string {
  return `chat:${cid}:${msgIndex}`;
}

interface Handle {
  db: Database.Database;
  dbPath: string;
  /** Aggregates the scorer needs on every query; recomputing them per query is
   *  a full table scan, so they are cached and dropped by any document write. */
  stats: { count: number; avgLen: number } | null;
  dataVersion: number;
}

const _stores = new Map<string, Handle>();

export function chatStorePath(uid: string): string {
  return path.join(userSearchDir(uid), 'chats.db');
}

function ensureSchema(db: Database.Database, dbPath: string): void {
  const hasTables = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='chat_docs'")
    .get() as { n: number };
  if (!hasTables.n) {
    db.exec(`
      CREATE TABLE chat_files (
        cid   TEXT PRIMARY KEY,
        mtime REAL    NOT NULL,
        size  INTEGER NOT NULL,
        next  INTEGER NOT NULL
      );

      CREATE TABLE chat_docs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id    TEXT    NOT NULL UNIQUE,
        cid       TEXT    NOT NULL,
        msg_index INTEGER NOT NULL,
        role      TEXT    NOT NULL,
        time      TEXT    NOT NULL,
        len       INTEGER NOT NULL
      );
      CREATE INDEX chat_docs_cid ON chat_docs(cid);

      CREATE TABLE chat_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Terms are interned. Storing the term text on every posting row makes
      -- the table larger than the JSON index it replaces, because JSON wrote
      -- each term once and listed its documents underneath; measured on a real
      -- 230 MB corpus that cost 298 MB against the snapshot's 241 MB.
      CREATE TABLE chat_terms (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE
      );

      CREATE TABLE chat_postings (
        term_id INTEGER NOT NULL,
        doc     INTEGER NOT NULL,
        tf      INTEGER NOT NULL,
        PRIMARY KEY (term_id, doc)
      ) WITHOUT ROWID;
      -- Primary key order puts a term's postings together, which is the read
      -- path; deleting one document's postings needs the other direction.
      CREATE INDEX chat_postings_doc ON chat_postings(doc);
    `);
    db.pragma(`user_version = ${CHAT_STORE_SCHEMA_VERSION}`);
    return;
  }
  const version = (db.pragma('user_version', { simple: true }) as number) || 0;
  if (version !== CHAT_STORE_SCHEMA_VERSION) {
    throw new Error(
      `chat_store schema version mismatch (${version} vs ${CHAT_STORE_SCHEMA_VERSION}) at ${dbPath}`,
    );
  }
}

function handleFor(uid: string): Handle {
  const cached = _stores.get(uid);
  if (cached) return cached;

  const dbPath = chatStorePath(uid);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    // WAL keeps a reader (a search) from blocking behind an append; DELETE
    // mode would serialize them. `synchronous = NORMAL` is the same durability
    // trade vec_store makes: a derived index that reconciles from source.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    ensureSchema(db, dbPath);
  } catch (err) {
    // Never let a failed handle reach the cache: on Windows the leaked SQLite
    // handle locks the file and blocks repair or workspace cleanup.
    try { db.close(); } catch { /* preserve the original failure */ }
    throw err;
  }
  const handle: Handle = { db, dbPath, stats: null, dataVersion: -1 };
  _stores.set(uid, handle);
  return handle;
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * Index one message, replacing whatever that document held before. A message
 * whose text tokenizes to nothing is still recorded so the file watermark can
 * advance past it — the JSON index made the same allowance.
 */
export function upsertDoc(uid: string, doc: ChatDocInput): void {
  const handle = handleFor(uid);
  const { db } = handle;
  const docId = chatDocId(doc.cid, doc.msgIndex);
  const terms = new Map<string, number>();
  for (const term of tokenize(doc.text)) terms.set(term, (terms.get(term) || 0) + 1);

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO chat_docs (doc_id, cid, msg_index, role, time, len)
      VALUES (@docId, @cid, @msgIndex, @role, @time, @len)
      ON CONFLICT(doc_id) DO UPDATE SET
        cid = excluded.cid, msg_index = excluded.msg_index,
        role = excluded.role, time = excluded.time, len = excluded.len
    `).run({
      docId, cid: doc.cid, msgIndex: doc.msgIndex,
      role: doc.role || '', time: doc.time || '', len: doc.text.length,
    });
    const id = (db.prepare('SELECT id FROM chat_docs WHERE doc_id = ?').get(docId) as { id: number }).id;
    // Re-indexing the same position must not leave the previous text's terms
    // behind; an edited or replayed message would otherwise match forever.
    db.prepare('DELETE FROM chat_postings WHERE doc = ?').run(id);
    const insert = db.prepare('INSERT INTO chat_postings (term_id, doc, tf) VALUES (?, ?, ?)');
    const intern = _internStatements(db);
    for (const [term, tf] of terms) insert.run(intern(term), id, tf);
  });
  run();
  handle.stats = null;
}

/** Drop every document and posting of one conversation, plus its watermark. */
export function deleteConversation(uid: string, cid: string): void {
  const handle = handleFor(uid);
  const { db } = handle;
  db.transaction(() => {
    db.prepare('DELETE FROM chat_postings WHERE doc IN (SELECT id FROM chat_docs WHERE cid = ?)').run(cid);
    db.prepare('DELETE FROM chat_docs WHERE cid = ?').run(cid);
    db.prepare('DELETE FROM chat_files WHERE cid = ?').run(cid);
    db.prepare('DELETE FROM chat_meta WHERE key = ?').run(`rebuild:${cid}`);
  })();
  handle.stats = null;
}

/** A restartable source-file cursor, separate from a completed file watermark. */
export function readRebuildCursor(uid: string, cid: string): ChatFileWatermark | undefined {
  const row = handleFor(uid).db.prepare('SELECT value FROM chat_meta WHERE key = ?')
    .get(`rebuild:${cid}`) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

/** Commit a bounded portion of a source file and its cursor together. Partial
 * documents may be searched, but only the final batch certifies the file. */
export function writeRebuildBatch(
  uid: string, cid: string, docs: ChatDocInput[], mark: ChatFileWatermark,
  reset: boolean, complete: boolean,
): void {
  const handle = handleFor(uid);
  const { db } = handle;
  db.transaction(() => {
    if (reset) deleteConversation(uid, cid);
    db.prepare('DELETE FROM chat_files WHERE cid = ?').run(cid);
    const insertDoc = db.prepare(`INSERT INTO chat_docs (doc_id, cid, msg_index, role, time, len)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const insertPosting = db.prepare('INSERT INTO chat_postings (term_id, doc, tf) VALUES (?, ?, ?)');
    const intern = _internStatements(db);
    for (const doc of docs) {
      const id = Number(insertDoc.run(chatDocId(cid, doc.msgIndex), cid, doc.msgIndex,
        doc.role || '', doc.time || '', doc.text.length).lastInsertRowid);
      const terms = new Map<string, number>();
      for (const term of tokenize(doc.text)) terms.set(term, (terms.get(term) || 0) + 1);
      for (const [term, tf] of terms) insertPosting.run(intern(term), id, tf);
    }
    if (complete) {
      setFileWatermark(uid, cid, mark);
      db.prepare('DELETE FROM chat_meta WHERE key = ?').run(`rebuild:${cid}`);
    } else {
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)')
        .run(`rebuild:${cid}`, JSON.stringify(mark));
    }
  })();
  handle.stats = null;
}

/** The one-time migration state survives ordinary source invalidation. Older
 * SQLite builds used source_stamp as their only completed-rebuild marker. */
export function hasCompletedRebuild(uid: string): boolean {
  return !!handleFor(uid).db.prepare(
    "SELECT 1 FROM chat_meta WHERE key IN ('migration_complete', 'source_stamp') LIMIT 1",
  ).get();
}

export function markRebuildComplete(uid: string, stamp: string): void {
  const db = handleFor(uid).db;
  db.transaction(() => {
    writeSourceStamp(uid, stamp);
    db.prepare("INSERT OR REPLACE INTO chat_meta (key, value) VALUES ('migration_complete', '1')").run();
  })();
}

/** Replace one conversation's documents wholesale — the reconcile path. */
export function replaceConversation(
  uid: string,
  cid: string,
  docs: ChatDocInput[],
  watermark: ChatFileWatermark,
): void {
  const handle = handleFor(uid);
  const { db } = handle;
  db.transaction(() => {
    db.prepare('DELETE FROM chat_postings WHERE doc IN (SELECT id FROM chat_docs WHERE cid = ?)').run(cid);
    db.prepare('DELETE FROM chat_docs WHERE cid = ?').run(cid);
    const insertDoc = db.prepare(`
      INSERT INTO chat_docs (doc_id, cid, msg_index, role, time, len)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPosting = db.prepare('INSERT INTO chat_postings (term_id, doc, tf) VALUES (?, ?, ?)');
    const intern = _internStatements(db);
    for (const doc of docs) {
      const info = insertDoc.run(
        chatDocId(cid, doc.msgIndex), cid, doc.msgIndex,
        doc.role || '', doc.time || '', doc.text.length,
      );
      const id = Number(info.lastInsertRowid);
      const terms = new Map<string, number>();
      for (const term of tokenize(doc.text)) terms.set(term, (terms.get(term) || 0) + 1);
      for (const [term, tf] of terms) insertPosting.run(intern(term), id, tf);
    }
    db.prepare(`
      INSERT INTO chat_files (cid, mtime, size, next) VALUES (?, ?, ?, ?)
      ON CONFLICT(cid) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, next = excluded.next
    `).run(cid, watermark.mtime, watermark.size, watermark.next);
  })();
  handle.stats = null;
}

export function setFileWatermark(uid: string, cid: string, mark: ChatFileWatermark): void {
  handleFor(uid).db.prepare(`
    INSERT INTO chat_files (cid, mtime, size, next) VALUES (?, ?, ?, ?)
    ON CONFLICT(cid) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, next = excluded.next
  `).run(cid, mark.mtime, mark.size, mark.next);
}

/** Forget one file's watermark so the next reconcile re-reads it in full. */
export function dropFileWatermark(uid: string, cid: string): void {
  handleFor(uid).db.prepare('DELETE FROM chat_files WHERE cid = ?').run(cid);
}

// ── Reads ────────────────────────────────────────────────────────────────

export function readFileWatermark(uid: string, cid: string): ChatFileWatermark | undefined {
  const row = handleFor(uid).db
    .prepare('SELECT mtime, size, next FROM chat_files WHERE cid = ?')
    .get(cid) as ChatFileWatermark | undefined;
  return row;
}

export function readAllWatermarks(uid: string): Map<string, ChatFileWatermark> {
  const rows = handleFor(uid).db
    .prepare('SELECT cid, mtime, size, next FROM chat_files')
    .all() as Array<{ cid: string } & ChatFileWatermark>;
  return new Map(rows.map((r) => [r.cid, { mtime: r.mtime, size: r.size, next: r.next }]));
}

/** Resolve a term to its interned id, creating it on first sight. */
function _internStatements(db: Database.Database): (term: string) => number {
  const select = db.prepare('SELECT id FROM chat_terms WHERE term = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO chat_terms (term) VALUES (?)');
  return (term: string): number => {
    const found = select.get(term) as { id: number } | undefined;
    if (found) return found.id;
    insert.run(term);
    return (select.get(term) as { id: number }).id;
  };
}

/** The inverted list for one term. Empty when the term is unknown. */
export function postingsFor(uid: string, term: string): Posting[] {
  return handleFor(uid).db.prepare(`
    SELECT p.doc AS doc, p.tf AS tf
    FROM chat_postings p JOIN chat_terms t ON t.id = p.term_id
    WHERE t.term = ?
  `).all(term) as Posting[];
}

/** Postings joined to the document length BM25 normalizes by. Scoring needs
 *  both for every candidate, and fetching lengths one row at a time turns one
 *  indexed lookup per term into one per posting. */
export function postingsWithLen(uid: string, term: string): ScoredPosting[] {
  return handleFor(uid).db.prepare(`
    SELECT p.doc AS doc, p.tf AS tf, d.len AS len
    FROM chat_terms t
    JOIN chat_postings p ON p.term_id = t.id
    JOIN chat_docs d ON d.id = p.doc
    WHERE t.term = ?
  `).all(term) as ScoredPosting[];
}

/** Document frequency without materializing the list. */
export function docFrequency(uid: string, term: string): number {
  const row = handleFor(uid).db.prepare(`
    SELECT COUNT(*) AS n FROM chat_postings p
    JOIN chat_terms t ON t.id = p.term_id WHERE t.term = ?
  `).get(term) as { n: number };
  return row.n;
}

function readRow(row: Record<string, unknown> | undefined): ChatDocRow | undefined {
  if (!row) return undefined;
  return {
    id: Number(row.id), docId: String(row.doc_id), cid: String(row.cid),
    msgIndex: Number(row.msg_index), role: String(row.role),
    time: String(row.time), len: Number(row.len),
  };
}

export function docById(uid: string, id: number): ChatDocRow | undefined {
  return readRow(handleFor(uid).db
    .prepare('SELECT id, doc_id, cid, msg_index, role, time, len FROM chat_docs WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined);
}

/** Resolve a scored candidate set in one statement instead of one per row. */
export function docsByIds(uid: string, ids: number[]): Map<number, ChatDocRow> {
  const out = new Map<number, ChatDocRow>();
  if (!ids.length) return out;
  const db = handleFor(uid).db;
  // SQLite caps a statement's parameters, so resolve in bounded batches.
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const rows = db.prepare(
      `SELECT id, doc_id, cid, msg_index, role, time, len FROM chat_docs
       WHERE id IN (${batch.map(() => '?').join(',')})`,
    ).all(...batch) as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const row = readRow(raw);
      if (row) out.set(row.id, row);
    }
  }
  return out;
}

function statsFor(uid: string): { count: number; avgLen: number } {
  const handle = handleFor(uid);
  const dataVersion = handle.db.pragma('data_version', { simple: true }) as number;
  if (dataVersion !== handle.dataVersion) {
    handle.stats = null;
    handle.dataVersion = dataVersion;
  }
  if (handle.stats) return handle.stats;
  const row = handle.db
    .prepare('SELECT COUNT(*) AS n, AVG(len) AS avg FROM chat_docs')
    .get() as { n: number; avg: number | null };
  handle.stats = { count: row.n, avgLen: row.n ? Number(row.avg) : 1 };
  return handle.stats;
}

export function docCount(uid: string): number {
  return statsFor(uid).count;
}

/** Mean document length, the BM25 length-normalization denominator. */
export function avgDocLen(uid: string): number {
  return statsFor(uid).avgLen;
}

/**
 * Fingerprint of the conversation catalog this index was last proven against.
 * `undefined` means the index may not be trusted without a reconcile — the
 * same meaning the JSON index's `sourceStamp` carried.
 */
export function readSourceStamp(uid: string): string | undefined {
  const row = handleFor(uid).db
    .prepare("SELECT value FROM chat_meta WHERE key = 'source_stamp'")
    .get() as { value: string } | undefined;
  return row?.value;
}

export function writeSourceStamp(uid: string, stamp: string | undefined): void {
  const db = handleFor(uid).db;
  if (stamp === undefined) {
    db.prepare("DELETE FROM chat_meta WHERE key = 'source_stamp'").run();
    return;
  }
  db.prepare(`
    INSERT INTO chat_meta (key, value) VALUES ('source_stamp', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(stamp);
}

/** Every conversation this index holds documents for, including any whose
 *  watermark was dropped — an orphan file must still be reachable for delete. */
export function indexedConversationIds(uid: string): Set<string> {
  const db = handleFor(uid).db;
  const rows = db.prepare(
    'SELECT cid FROM chat_files UNION SELECT DISTINCT cid FROM chat_docs',
  ).all() as Array<{ cid: string }>;
  return new Set(rows.map((r) => r.cid));
}

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Reclaim free pages after a bulk rebuild. A migration rewrites every
 * conversation, which leaves the file roughly 40% larger than the pages it
 * actually uses (measured 259 MB against 185 MB of live pages on a 230 MB
 * corpus). Only worth running after a full reconcile, never per append.
 */
export function compact(uid: string): void {
  const handle = handleFor(uid);
  try {
    handle.db.pragma('wal_checkpoint(TRUNCATE)');
    handle.db.exec('VACUUM');
  } catch (err) {
    warn('chat store vacuum failed', err);
  }
}

export function closeChatStore(uid: string): void {
  const handle = _stores.get(uid);
  if (!handle) return;
  try { handle.db.close(); }
  catch (err) { warn('close chat store failed', err); }
  _stores.delete(uid);
}

export function closeAllChatStores(): void {
  for (const uid of [..._stores.keys()]) closeChatStore(uid);
}

/**
 * Test-only: every indexed document, in insertion order. Production never
 * enumerates the corpus — queries reach documents through `postingsFor` — so
 * this exists purely so index-level cases can assert what was indexed.
 */
export function _allDocsForTests(uid: string): ChatDocRow[] {
  const rows = handleFor(uid).db
    .prepare('SELECT id, doc_id, cid, msg_index, role, time, len FROM chat_docs ORDER BY id')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => readRow(row)!).filter(Boolean);
}
