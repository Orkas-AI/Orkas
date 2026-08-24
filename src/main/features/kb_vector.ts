/**
 * Knowledge-base vector store — thin uid-keyed adapter over the generic
 * `features/vec_store`. All heavy lifting (sqlite-vec, chunking, embedding,
 * search, VACUUM) lives in `vec_store`; this module only exists so that
 * existing KB callers keep their (uid, ...) API surface unchanged.
 *
 * New scenarios should `import * as vs from './vec_store'` and call
 * `vs.openVecStore(dbDir)` directly — no uid / `getActiveUserId` ceremony.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userKbVectorDbPath } from '../paths';
import * as vs from './vec_store';
import { ChunkableKind } from '../util/file_to_chunks';

export const KB_EMBEDDER = vs.VS_EMBEDDER;
export const KB_DIM = vs.VS_DIM;
export const KB_SCHEMA_VERSION = vs.VS_SCHEMA_VERSION;

export type KbKind = ChunkableKind;
export type KbStatus = vs.VecStatus;
export type KbFileRow = vs.VecFileRow;
export type KbChunkInput = vs.VecChunkInput;
export type KbSearchHit = vs.VecSearchHit;
export type KbSearchOpts = vs.VecSearchOpts;

function kbDbDir(uid: string): string {
  // userKbVectorDbPath returns `<uid>/local/contexts/.kb/vector.db`
  // (machine-private, NOT cloud-synced; multi-device-sync batch 2 +
  // util/migrate-kb-to-local.ts). vec_store expects the containing
  // directory so it can manage `vector.db` + `config.json` side by side.
  return path.dirname(userKbVectorDbPath(uid));
}

function storeForUid(uid: string): vs.VecStore {
  return vs.openVecStore(kbDbDir(uid));
}

/** True when this user already has an index on disk. Reads consult it first:
 *  `openVecStore` creates `vector.db`, so an unguarded read materialises a
 *  Library for someone who never made one — a model `library(search)` against
 *  an empty account did exactly that. Writes stay unguarded; creating the
 *  store is what they are for. */
function hasStore(uid: string): boolean {
  return fs.existsSync(userKbVectorDbPath(uid));
}

// ── File-level CRUD ─────────────────────────────────────────────────────

export function getFileByPath(uid: string, relPath: string): KbFileRow | null {
  return hasStore(uid) ? storeForUid(uid).getFile(relPath) : null;
}

export function findBySha1(uid: string, sha1: string): KbFileRow | null {
  return hasStore(uid) ? storeForUid(uid).findBySha1(sha1) : null;
}

export function listFiles(uid: string): KbFileRow[] {
  return hasStore(uid) ? storeForUid(uid).listFiles() : [];
}

export function upsertFile(
  uid: string,
  input: {
    relPath: string;
    kind: KbKind;
    bytes: number;
    mtime: number;
    sha1: string;
    chunks: KbChunkInput[];
  },
): Promise<{ fileId: number; chunkIds: number[] }> {
  return storeForUid(uid).upsertFile({
    id: input.relPath,
    kind: input.kind,
    bytes: input.bytes,
    mtime: input.mtime,
    sha1: input.sha1,
    chunks: input.chunks,
  });
}

export function setFileStatus(
  uid: string,
  relPath: string,
  status: KbStatus,
  opts: { kind?: KbKind; bytes?: number; mtime?: number; sha1?: string; error?: string | null } = {},
): Promise<void> {
  return storeForUid(uid).setFileStatus(relPath, status, opts);
}

export function deleteFile(uid: string, relPath: string): Promise<boolean> {
  return storeForUid(uid).deleteFile(relPath);
}

// ── Search / read ──────────────────────────────────────────────────────

export function search(uid: string, queryVec: number[] | Float32Array, opts: KbSearchOpts = {}): KbSearchHit[] {
  return hasStore(uid) ? storeForUid(uid).search(queryVec, opts) : [];
}

/** Query an already-built Library index without creating an empty vector
 * store. Interactive global search calls this on every settled query, so a
 * user with no Library must stay a read-only no-op. Index creation and source
 * reconciliation remain owned by the Library indexing lifecycle. */
export function searchExisting(uid: string, queryVec: number[] | Float32Array, opts: KbSearchOpts = {}): KbSearchHit[] {
  return search(uid, queryVec, opts);
}

export function readFileChunks(uid: string, relPath: string): Array<{ chunk_idx: number; title: string | null; content: string }> {
  return hasStore(uid) ? storeForUid(uid).readFileChunks(relPath) : [];
}

export function statusSummary(uid: string): { total: number; ready: number; processing: number; pending: number; failed: number } {
  return hasStore(uid)
    ? storeForUid(uid).statusSummary()
    : { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 };
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export function closeKb(uid: string): void {
  vs.closeVecStore(kbDbDir(uid));
}

export function closeAllKb(): void {
  vs.closeAllVecStores();
}

/** Test hook: flush any pending VACUUM and run it now. */
export async function _flushVacuumForTests(uid: string): Promise<void> {
  return storeForUid(uid).flushPendingVacuum();
}

/**
 * Test-only shim — returns a raw sqlite handle so legacy storage-layer tests
 * can keep running ad-hoc queries. Production code should use the typed
 * methods above (no openKb call in non-test code).
 */
export function openKb(uid: string): { db: unknown; dbPath: string } {
  storeForUid(uid);
  const h = vs._unsafeHandleForTests(kbDbDir(uid));
  if (!h) throw new Error(`openKb: vec_store handle missing for uid=${uid}`);
  return h;
}
