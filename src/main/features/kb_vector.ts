/**
 * Knowledge-base vector store — thin uid-keyed adapter over the generic
 * `features/vec_store`. All heavy lifting (sqlite-vec, chunking, embedding,
 * search, VACUUM) lives in `vec_store`; this module only exists so that
 * existing KB callers keep their (uid, ...) API surface unchanged.
 *
 * New scenarios should `import * as vs from './vec_store'` and call
 * `vs.openVecStore(dbDir)` directly — no uid / `getActiveUserId` ceremony.
 */

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
  // userKbVectorDbPath returns `<uid>/cloud/contexts/.kb/vector.db`; vec_store
  // expects the containing directory so it can manage `vector.db` +
  // `config.json` side by side. `path.dirname` handles `/` and `\` correctly
  // on every platform.
  return path.dirname(userKbVectorDbPath(uid));
}

function storeForUid(uid: string): vs.VecStore {
  return vs.openVecStore(kbDbDir(uid));
}

// ── File-level CRUD ─────────────────────────────────────────────────────

export function getFileByPath(uid: string, relPath: string): KbFileRow | null {
  return storeForUid(uid).getFile(relPath);
}

export function findBySha1(uid: string, sha1: string): KbFileRow | null {
  return storeForUid(uid).findBySha1(sha1);
}

export function listFiles(uid: string): KbFileRow[] {
  return storeForUid(uid).listFiles();
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
  return storeForUid(uid).search(queryVec, opts);
}

export function readFileChunks(uid: string, relPath: string): Array<{ chunk_idx: number; title: string | null; content: string }> {
  return storeForUid(uid).readFileChunks(relPath);
}

export function statusSummary(uid: string): { total: number; ready: number; processing: number; pending: number; failed: number } {
  return storeForUid(uid).statusSummary();
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
