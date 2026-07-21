/**
 * Generic vector store over sqlite-vec + fastembed. Key the store by its
 * `dbDir` (directory containing `vector.db` + `config.json`) — zero knowledge
 * of users, knowledge bases, or the Orkas domain. Callers provide a dbDir
 * and strings; the store handles chunking, embedding, persistence, search.
 *
 * Two usage tiers:
 *   • High-level — `vectorize(id, {kind, buf})` + `searchByQuery(q)`: one call
 *     per scenario, no manual extract/embed/upsert plumbing. Right for new
 *     consumers ("I just want a RAG over these files").
 *   • Low-level — `setFileStatus` / `upsertFile(chunks + vectors)` / `search`
 *     (with precomputed vector): lets callers drive the pipeline themselves
 *     when they need per-phase events (e.g. KB indexer's status broadcast +
 *     cross-file extract/embed pipelining).
 *
 * The embedding model is fixed: `bge-small-zh-v1.5`, 512-dim. Switching
 * models would require a full rebuild — `config.json` enforces this per-dir.
 *
 * Schema (unchanged from the pre-refactor kb_vector module — existing KB
 * databases on disk just keep working when KB now routes through here):
 *   • `kb_files`  — one row per source file (id + sha1 + status + chunks)
 *   • `kb_chunks` — one row per chunk (file_id FK + chunk_idx + title/content)
 *   • `kb_vec`    — vec0 virtual table, rowid = kb_chunks.id, FLOAT[512]
 *
 * Concurrency: better-sqlite3 is synchronous + single-writer. One Mutex per
 * store gates writes so parallel callers can't interleave mid-transaction.
 * Reads are lock-free (SQLite snapshot isolation).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { Mutex } from 'async-mutex';

import { createLogger } from '../logger';
import { fileToChunks, ChunkableKind, ExtractedChunk } from '../util/file_to_chunks';
import * as embed from './kb_embed';

const log = createLogger('vec_store');

export const VS_EMBEDDER = 'bge-small-zh-v1.5';
export const VS_DIM = 512;
export const VS_SCHEMA_VERSION = 1;

export type VecKind = ChunkableKind;
export type VecStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface VecFileRow {
  id: number;
  rel_path: string;   // column name preserved for schema compat; semantically "external id"
  kind: VecKind;
  bytes: number;
  mtime: number;
  sha1: string;
  status: VecStatus;
  error: string | null;
  chunks: number;
  created_at: number;
  updated_at: number;
}

export interface VecChunkInput {
  title: string;
  content: string;
  embedding: number[] | Float32Array;
}

export interface VecSearchHit {
  file_id: number;
  rel_path: string;
  kind: VecKind;
  chunk_idx: number;
  title: string;
  content: string;
  score: number;
  distance: number;
}

export interface VecSearchOpts {
  k?: number;
  dir?: string;
  path?: string;
  kind?: VecKind;
}

export interface VectorizeInput {
  kind: VecKind;
  buf: Buffer;
  bytes?: number;   // defaults to buf.length
  mtime?: number;   // defaults to Date.now() / 1000
  sha1?: string;    // defaults to computed from buf
  imageDescriber?: (buf: Buffer) => Promise<string>;
  imageTitle?: string;
}

export interface VecStore {
  readonly dbDir: string;
  readonly dbPath: string;

  // High-level ─────────────────────────────────────────────────────────
  /** One-call vectorisation: chunk + embed + upsert. Returns chunk count. */
  vectorize(id: string, input: VectorizeInput): Promise<number>;
  /** One-call semantic search: embeds `query` then searches. */
  searchByQuery(query: string, opts?: VecSearchOpts): Promise<VecSearchHit[]>;

  // Low-level ──────────────────────────────────────────────────────────
  upsertFile(input: {
    id: string;
    kind: VecKind;
    bytes: number;
    mtime: number;
    sha1: string;
    chunks: VecChunkInput[];
  }): Promise<{ fileId: number; chunkIds: number[] }>;
  setFileStatus(
    id: string,
    status: VecStatus,
    opts?: { kind?: VecKind; bytes?: number; mtime?: number; sha1?: string; error?: string | null },
  ): Promise<void>;
  deleteFile(id: string): Promise<boolean>;

  // Queries ────────────────────────────────────────────────────────────
  getFile(id: string): VecFileRow | null;
  findBySha1(sha1: string): VecFileRow | null;
  listFiles(): VecFileRow[];
  readFileChunks(id: string): Array<{ chunk_idx: number; title: string | null; content: string }>;
  statusSummary(): { total: number; ready: number; processing: number; pending: number; failed: number };
  search(queryVec: number[] | Float32Array, opts?: VecSearchOpts): VecSearchHit[];

  // Lifecycle ──────────────────────────────────────────────────────────
  close(): void;
  flushPendingVacuum(): Promise<void>;
}

// ── Per-dbDir cache ─────────────────────────────────────────────────────

interface Handle {
  db: Database.Database;
  dbDir: string;
  dbPath: string;
  writeLock: Mutex;
}

const _cache = new Map<string, Handle>();
const _vacuumTimers = new Map<string, NodeJS.Timeout>();

function handleFor(dbDir: string): Handle {
  const cached = _cache.get(dbDir);
  if (cached) return cached;

  const dbPath = path.join(dbDir, 'vector.db');
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  try { loadSqliteVec(db); }
  catch (err) {
    db.close();
    throw new Error(`sqlite-vec load failed: ${(err as Error).message}`);
  }

  try {
    ensureSchema(db, dbPath);
    ensureConfig(dbDir);
  } catch (err) {
    // A mismatched/corrupt config or schema fails before the handle reaches
    // _cache, so closeAllVecStores() cannot discover it later. This matters
    // especially on Windows, where the leaked SQLite handle permanently
    // locks vector.db and prevents repair or temp-workspace cleanup.
    try { db.close(); } catch { /* preserve the validation error */ }
    throw err;
  }

  const h: Handle = { db, dbDir, dbPath, writeLock: new Mutex() };
  _cache.set(dbDir, h);
  return h;
}

function resolveSqliteVecLoadablePath(loadablePath: string, exists: (p: string) => boolean = fs.existsSync): string {
  const unpacked = loadablePath.replace(/([\\/])app\.asar([\\/])/g, '$1app.asar.unpacked$2');
  return unpacked !== loadablePath && exists(unpacked) ? unpacked : loadablePath;
}

function loadSqliteVec(db: Database.Database): void {
  if (typeof sqliteVec.getLoadablePath === 'function') {
    db.loadExtension(resolveSqliteVecLoadablePath(sqliteVec.getLoadablePath()));
    return;
  }
  sqliteVec.load(db);
}

export function _resolveSqliteVecLoadablePathForTests(loadablePath: string): string {
  return resolveSqliteVecLoadablePath(loadablePath);
}

function ensureSchema(db: Database.Database, dbPath: string): void {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='kb_files'`,
  ).get() as { name?: string } | undefined;

  if (!row) {
    log.info(`initializing fresh vector.db at ${dbPath}`);
    db.exec(`
      CREATE TABLE kb_files (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path   TEXT UNIQUE NOT NULL,
        kind       TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        mtime      REAL NOT NULL,
        sha1       TEXT NOT NULL,
        status     TEXT NOT NULL,
        error      TEXT,
        chunks     INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX kb_files_status ON kb_files(status);
      CREATE INDEX kb_files_kind   ON kb_files(kind);

      CREATE TABLE kb_chunks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id    INTEGER NOT NULL,
        chunk_idx  INTEGER NOT NULL,
        title      TEXT,
        content    TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        FOREIGN KEY (file_id) REFERENCES kb_files(id) ON DELETE CASCADE
      );
      CREATE INDEX kb_chunks_file ON kb_chunks(file_id);
    `);
    db.exec(`CREATE VIRTUAL TABLE kb_vec USING vec0(embedding FLOAT[${VS_DIM}])`);
    db.pragma(`user_version = ${VS_SCHEMA_VERSION}`);
  } else {
    const ver = (db.pragma('user_version', { simple: true }) as number) || 0;
    if (ver !== VS_SCHEMA_VERSION) {
      throw new Error(
        `vec_store vector.db schema version mismatch (${ver} vs ${VS_SCHEMA_VERSION}) at ${dbPath}; aborting`,
      );
    }
  }
}

function ensureConfig(dbDir: string): void {
  const p = path.join(dbDir, 'config.json');
  if (fs.existsSync(p)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.embedder !== VS_EMBEDDER || cfg.dim !== VS_DIM) {
        throw new Error(
          `vec_store config mismatch at ${p}: expected ${VS_EMBEDDER}/${VS_DIM}, got ${cfg.embedder}/${cfg.dim}`,
        );
      }
    } catch (err) {
      throw new Error(`bad vec_store config at ${p}: ${(err as Error).message}`);
    }
    return;
  }
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ embedder: VS_EMBEDDER, dim: VS_DIM, schema: VS_SCHEMA_VERSION }, null, 2),
    'utf8',
  );
}

// ── Vector encoding ─────────────────────────────────────────────────────

function encodeVector(v: number[] | Float32Array): Uint8Array {
  if (v.length !== VS_DIM) {
    throw new Error(`embedding dim mismatch: expected ${VS_DIM}, got ${v.length}`);
  }
  const f32 = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

// ── VACUUM ──────────────────────────────────────────────────────────────

function scheduleVacuum(dbDir: string): void {
  const existing = _vacuumTimers.get(dbDir);
  if (existing) clearTimeout(existing);
  _vacuumTimers.set(dbDir, setTimeout(() => {
    _vacuumTimers.delete(dbDir);
    runVacuum(dbDir).catch((err) => log.warn(`vacuum ${dbDir}: ${(err as Error).message}`));
  }, 2000));
}

async function runVacuum(dbDir: string): Promise<void> {
  const h = _cache.get(dbDir);
  if (!h) return;
  return h.writeLock.runExclusive(() => {
    const before = dbSize(h.dbPath);
    const started = Date.now();
    h.db.exec('VACUUM');
    const after = dbSize(h.dbPath);
    log.info(`vacuum ${dbDir} ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB in ${Date.now() - started}ms`);
  });
}

function dbSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Open (or retrieve cached) vector store at `dbDir`. Multiple calls with the
 * same dbDir return the same instance — safe to call freely; the backing
 * DB + mutex are deduped.
 */
export function openVecStore(dbDir: string): VecStore {
  const h = handleFor(dbDir);

  async function upsertFile(input: {
    id: string;
    kind: VecKind;
    bytes: number;
    mtime: number;
    sha1: string;
    chunks: VecChunkInput[];
  }): Promise<{ fileId: number; chunkIds: number[] }> {
    return h.writeLock.runExclusive(() => {
      const { db } = h;
      const now = Date.now() / 1000;
      const tx = db.transaction(() => {
        const existing = db.prepare(`SELECT id FROM kb_files WHERE rel_path = ?`).get(input.id) as { id: number } | undefined;

        let fileId: number;
        if (existing) {
          fileId = existing.id;
          db.prepare(`
            UPDATE kb_files
               SET kind=?, bytes=?, mtime=?, sha1=?, status='ready', error=NULL,
                   chunks=?, updated_at=?
             WHERE id=?
          `).run(input.kind, input.bytes, input.mtime, input.sha1, input.chunks.length, now, fileId);
          const oldChunkIds = db.prepare(`SELECT id FROM kb_chunks WHERE file_id = ?`).all(fileId) as { id: number }[];
          if (oldChunkIds.length) {
            const delVec = db.prepare(`DELETE FROM kb_vec WHERE rowid = ?`);
            for (const { id } of oldChunkIds) delVec.run(BigInt(id));
            db.prepare(`DELETE FROM kb_chunks WHERE file_id = ?`).run(fileId);
          }
        } else {
          const r = db.prepare(`
            INSERT INTO kb_files(rel_path, kind, bytes, mtime, sha1, status, chunks, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
          `).run(input.id, input.kind, input.bytes, input.mtime, input.sha1, input.chunks.length, now, now);
          fileId = Number(r.lastInsertRowid);
        }

        const insChunk = db.prepare(`
          INSERT INTO kb_chunks(file_id, chunk_idx, title, content, bytes)
          VALUES (?, ?, ?, ?, ?)
        `);
        const insVec = db.prepare(`INSERT INTO kb_vec(rowid, embedding) VALUES (?, ?)`);
        const chunkIds: number[] = [];
        input.chunks.forEach((c, i) => {
          const r = insChunk.run(fileId, i + 1, c.title, c.content, Buffer.byteLength(c.content, 'utf8'));
          const chunkId = Number(r.lastInsertRowid);
          insVec.run(BigInt(chunkId), encodeVector(c.embedding));
          chunkIds.push(chunkId);
        });
        return { fileId, chunkIds };
      });
      return tx();
    });
  }

  async function setFileStatus(
    id: string,
    status: VecStatus,
    opts: { kind?: VecKind; bytes?: number; mtime?: number; sha1?: string; error?: string | null } = {},
  ): Promise<void> {
    return h.writeLock.runExclusive(() => {
      const { db } = h;
      const now = Date.now() / 1000;
      const existing = db.prepare(`SELECT id FROM kb_files WHERE rel_path = ?`).get(id) as { id: number } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE kb_files
             SET status=?, error=?,
                 kind    = COALESCE(?, kind),
                 bytes   = COALESCE(?, bytes),
                 mtime   = COALESCE(?, mtime),
                 sha1    = COALESCE(?, sha1),
                 updated_at=?
           WHERE id=?
        `).run(
          status, opts.error ?? null,
          opts.kind ?? null, opts.bytes ?? null, opts.mtime ?? null, opts.sha1 ?? null,
          now, existing.id,
        );
      } else {
        if (opts.kind == null || opts.bytes == null || opts.mtime == null || opts.sha1 == null) {
          throw new Error(`setFileStatus for new id requires kind/bytes/mtime/sha1: ${id}`);
        }
        db.prepare(`
          INSERT INTO kb_files(rel_path, kind, bytes, mtime, sha1, status, error, chunks, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(id, opts.kind, opts.bytes, opts.mtime, opts.sha1, status, opts.error ?? null, now, now);
      }
    });
  }

  async function deleteFile(id: string): Promise<boolean> {
    const deleted = await h.writeLock.runExclusive(() => {
      const { db } = h;
      const tx = db.transaction(() => {
        const row = db.prepare(`SELECT id FROM kb_files WHERE rel_path = ?`).get(id) as { id: number } | undefined;
        if (!row) return false;
        const oldChunkIds = db.prepare(`SELECT id FROM kb_chunks WHERE file_id = ?`).all(row.id) as { id: number }[];
        if (oldChunkIds.length) {
          const delVec = db.prepare(`DELETE FROM kb_vec WHERE rowid = ?`);
          for (const { id } of oldChunkIds) delVec.run(BigInt(id));
        }
        db.prepare(`DELETE FROM kb_files WHERE id = ?`).run(row.id);
        return true;
      });
      return tx();
    });
    if (deleted) scheduleVacuum(h.dbDir);
    return deleted;
  }

  function getFile(id: string): VecFileRow | null {
    const row = h.db.prepare(`SELECT * FROM kb_files WHERE rel_path = ?`).get(id) as VecFileRow | undefined;
    return row ?? null;
  }

  function findBySha1(sha1: string): VecFileRow | null {
    const row = h.db.prepare(`SELECT * FROM kb_files WHERE sha1 = ? LIMIT 1`).get(sha1) as VecFileRow | undefined;
    return row ?? null;
  }

  function listFiles(): VecFileRow[] {
    return h.db.prepare(`SELECT * FROM kb_files ORDER BY rel_path`).all() as VecFileRow[];
  }

  function readFileChunks(id: string): Array<{ chunk_idx: number; title: string | null; content: string }> {
    const f = getFile(id);
    if (!f) return [];
    return h.db.prepare(`
      SELECT chunk_idx, title, content FROM kb_chunks WHERE file_id = ? ORDER BY chunk_idx
    `).all(f.id) as Array<{ chunk_idx: number; title: string | null; content: string }>;
  }

  function statusSummary(): { total: number; ready: number; processing: number; pending: number; failed: number } {
    const rows = h.db.prepare(`SELECT status, COUNT(*) AS n FROM kb_files GROUP BY status`).all() as Array<{ status: VecStatus; n: number }>;
    const out = { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 };
    for (const r of rows) {
      out.total += r.n;
      out[r.status] = r.n;
    }
    return out;
  }

  function search(queryVec: number[] | Float32Array, opts: VecSearchOpts = {}): VecSearchHit[] {
    const k = Math.min(Math.max(1, opts.k ?? 8), 50);
    const fetch = opts.path
      ? 4096
      : opts.dir
        ? Math.max(k * 10, 500)
        : Math.min(k * 4, 200);
    const qBytes = encodeVector(queryVec);
    const params: (string | number | Buffer | Uint8Array)[] = [qBytes, fetch];
    let sql = `
      SELECT c.file_id AS file_id,
             c.chunk_idx AS chunk_idx,
             c.title AS title,
             c.content AS content,
             f.rel_path AS rel_path,
             f.kind AS kind,
             v.distance AS distance
        FROM kb_vec v
        JOIN kb_chunks c ON c.id = v.rowid
        JOIN kb_files  f ON f.id = c.file_id
       WHERE v.embedding MATCH ? AND k = ?
         AND f.status = 'ready'
    `;
    if (opts.dir) {
      const dir = opts.dir.replace(/\/+$/, '');
      sql += ` AND (f.rel_path = ? OR f.rel_path LIKE ?)`;
      params.push(dir, dir + '/%');
    }
    if (opts.path) {
      sql += ` AND f.rel_path = ?`;
      params.push(opts.path.replace(/^\/+/, ''));
    }
    if (opts.kind) {
      sql += ` AND f.kind = ?`;
      params.push(opts.kind);
    }
    sql += ` ORDER BY v.distance LIMIT ?`;
    params.push(k);
    const rows = h.db.prepare(sql).all(...params) as Array<Omit<VecSearchHit, 'score'>>;
    return rows.map((r) => ({
      ...r,
      score: Math.max(-1, Math.min(1, 1 - (r.distance * r.distance) / 2)),
    }));
  }

  async function vectorize(id: string, input: VectorizeInput): Promise<number> {
    const crypto = await import('node:crypto');
    const bytes = input.bytes ?? input.buf.length;
    const mtime = input.mtime ?? Date.now() / 1000;
    const sha1 = input.sha1 ?? crypto.createHash('sha1').update(input.buf).digest('hex');

    const chunks: ExtractedChunk[] = await fileToChunks({
      kind: input.kind,
      buf: input.buf,
      imageDescriber: input.imageDescriber,
      imageTitle: input.imageTitle,
    });
    if (!chunks.length) throw new Error('fileToChunks returned zero chunks');

    const vectors = await embed.embedTexts(chunks.map((c) => c.content));
    await upsertFile({
      id, kind: input.kind, bytes, mtime, sha1,
      chunks: chunks.map((c, i) => ({ title: c.title, content: c.content, embedding: vectors[i] })),
    });
    return chunks.length;
  }

  async function searchByQuery(query: string, opts?: VecSearchOpts): Promise<VecSearchHit[]> {
    const vec = await embed.embedQuery(query);
    return search(vec, opts);
  }

  async function flushPendingVacuum(): Promise<void> {
    const t = _vacuumTimers.get(h.dbDir);
    if (t) {
      clearTimeout(t);
      _vacuumTimers.delete(h.dbDir);
      await runVacuum(h.dbDir);
    }
  }

  function close(): void {
    closeVecStore(dbDir);
  }

  return {
    dbDir, dbPath: h.dbPath,
    vectorize, searchByQuery,
    upsertFile, setFileStatus, deleteFile,
    getFile, findBySha1, listFiles, readFileChunks, statusSummary, search,
    close, flushPendingVacuum,
  };
}

/** Close and evict a specific store. Fires any pending VACUUM first. */
export function closeVecStore(dbDir: string): void {
  const h = _cache.get(dbDir);
  if (!h) return;
  const pending = _vacuumTimers.get(dbDir);
  if (pending) {
    clearTimeout(pending);
    _vacuumTimers.delete(dbDir);
    try { h.db.exec('VACUUM'); }
    catch (err) { log.warn(`vacuum-on-close ${dbDir}: ${(err as Error).message}`); }
  }
  try { h.db.close(); }
  catch (err) { log.warn(`close ${dbDir}: ${(err as Error).message}`); }
  _cache.delete(dbDir);
}

/** Close all cached stores (used on app shutdown). */
export function closeAllVecStores(): void {
  for (const dbDir of [..._cache.keys()]) closeVecStore(dbDir);
}

/**
 * Test-only: reach into the cache for a raw DB handle so storage-layer tests
 * can run ad-hoc SQL for verification. Not called by production code — the
 * public API covers every runtime need. Returns `undefined` if the store
 * isn't open for this dbDir yet.
 */
export function _unsafeHandleForTests(dbDir: string): { db: Database.Database; dbPath: string } | undefined {
  const h = _cache.get(dbDir);
  return h ? { db: h.db, dbPath: h.dbPath } : undefined;
}
