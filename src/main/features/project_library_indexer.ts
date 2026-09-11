/**
 * Project-scoped Library: a corpus registration plus the project lifecycle
 * that is not corpus-generic.
 *
 * Sources live under `<uid>/cloud/projects/<pid>/contexts/`; the derived vector
 * store is machine-local under `<uid>/local/projects/<pid>/` so project assets
 * sync independently from embeddings, mirroring the global Library.
 *
 * Queue mechanics, the extract/embed pipeline, reconcile diffing, crash
 * recovery and analytics live in `library_corpus`. What stays here is what is
 * genuinely project-shaped: the (projectId, name) surface callers use, the
 * deletion epoch that stops late work from resurrecting a dropped project,
 * and the event shape the renderer already consumes.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import { projectFilesDir, projectLibraryVectorDbPath, projectLocalDir } from '../paths';
import { createLogger } from '../logger';
import type { ChunkableKind } from '../util/file_to_chunks';
import * as vs from './vec_store';
import { projectExists } from './projects';
import {
  closeLibraryCorpus,
  openLibraryCorpus,
  safeCorpusRelPath,
  type CorpusJobReason,
  type CorpusReconcileResult,
  type CorpusStatusEvent,
  type LibraryCorpus,
} from './library_corpus';

const log = createLogger('project_library_indexer');

type ProjectLibraryKind = ChunkableKind;
export type ProjectLibraryEventType = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';

export interface ProjectLibraryStatusEvent {
  userId: string;
  projectId: string;
  name: string;
  relPath: string;
  status: ProjectLibraryEventType;
  chunks?: number;
  error?: string;
  kind?: ProjectLibraryKind;
  stage?: 'queue' | 'extract' | 'embed' | 'persist' | 'reconcile';
  errorCode?: string;
}

export type ProjectLibraryReconcileResult = CorpusReconcileResult;

export const projectLibraryEvents = new EventEmitter();
projectLibraryEvents.setMaxListeners(50);

const _projectEpochs = new Map<string, number>();
const _deletedProjects = new Set<string>();
/** Every (uid, pid) this process opened a corpus for — the uid-wide drain and
 *  the test reset need to reach them, and the generic layer keys by dbDir. */
const _known = new Set<string>();

function safeProjectId(projectId: string): string {
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId required');
  if (
    projectId.includes('/') || projectId.includes('\\') || projectId.includes('\x00')
    || projectId === '.' || projectId === '..'
  ) {
    throw new Error('invalid projectId');
  }
  return projectId;
}

function projectKey(uid: string, projectId: string): string {
  return `${uid}\x00${projectId}`;
}

function projectEpoch(uid: string, projectId: string): number {
  return _projectEpochs.get(projectKey(uid, projectId)) || 0;
}

function corpusFor(uid: string, projectId: string): LibraryCorpus {
  const pid = safeProjectId(projectId);
  _known.add(projectKey(uid, pid));
  return openLibraryCorpus({
    uid,
    scope: 'project',
    sourceRoot: projectFilesDir(uid, pid),
    dbDir: path.dirname(projectLibraryVectorDbPath(uid, pid)),
    imageSessionPrefix: 'extract-img-project',
    // The project files panel treats every admission as having a terminal
    // event; the global Library does not. Preserved per corpus.
    emitReadyOnCacheHit: true,
    epoch: () => projectEpoch(uid, pid),
    discarded: () => _deletedProjects.has(projectKey(uid, pid)),
    exists: () => projectExists(uid, pid),
    emit: (event: CorpusStatusEvent) => {
      const out: ProjectLibraryStatusEvent = {
        userId: uid,
        projectId: pid,
        name: event.relPath,
        relPath: event.relPath,
        status: event.status,
        ...(event.chunks !== undefined ? { chunks: event.chunks } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      };
      projectLibraryEvents.emit('status', out);
    },
  });
}

/** Admission for one project file. Invalid ids are dropped silently: callers
 *  pass user-supplied names, and admitting one only to fail later would
 *  broadcast a path outside the project to every status listener. */
export function enqueue(
  uid: string,
  projectId: string,
  name: string,
  op: 'upsert' | 'delete' = 'upsert',
  opts: { force?: boolean; reason?: CorpusJobReason; attempt?: number } = {},
): void {
  let pid: string;
  try { pid = safeProjectId(projectId); }
  catch { return; }
  if (!safeCorpusRelPath(name)) return;
  if (_deletedProjects.has(projectKey(uid, pid))) return;
  corpusFor(uid, pid).enqueue(name, op, opts);
}

export async function reconcile(
  uid: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectLibraryReconcileResult> {
  const pid = safeProjectId(projectId);
  if (signal?.aborted) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };
  if (!await projectExists(uid, pid)) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };
  // A sync restore can legitimately bring back the same project id after a
  // local deletion. Reconcile is the authoritative resurrection boundary.
  _deletedProjects.delete(projectKey(uid, pid));
  return corpusFor(uid, pid).reconcile(signal);
}

/** Read-only retrieval over an existing project vector store. Index
 *  freshness belongs to source mutations, sync drop-in, and boot
 *  maintenance — never to a query: reconciling here made every model search
 *  stat and hash the whole project tree, serially and uncancellably.
 *  Query only an existing project vector store. Global typeahead must not
 *  create derived state for every project on each keystroke. */
export function search(
  uid: string,
  projectId: string,
  queryVec: number[] | Float32Array,
  opts: vs.VecSearchOpts = {},
): vs.VecSearchHit[] {
  const pid = safeProjectId(projectId);
  if (!fs.existsSync(projectLibraryVectorDbPath(uid, pid))) return [];
  return corpusFor(uid, pid).search(queryVec, opts);
}

export function getFileByPath(uid: string, projectId: string, relPath: string): vs.VecFileRow | null {
  return corpusFor(uid, projectId).getFile(relPath);
}

export function listFiles(uid: string, projectId: string): vs.VecFileRow[] {
  return corpusFor(uid, projectId).listFiles();
}

export function readFileChunks(
  uid: string,
  projectId: string,
  relPath: string,
): Array<{ chunk_idx: number; title: string | null; content: string }> {
  return corpusFor(uid, projectId).readFileChunks(relPath);
}

export function statusSummary(
  uid: string,
  projectId: string,
): { total: number; ready: number; processing: number; pending: number; failed: number } {
  return corpusFor(uid, projectId).statusSummary();
}

/** Await queued work. One queue served every project before corpora existed,
 *  so the uid-wide form is preserved for callers that drain "this user". */
export async function drain(uid: string, projectId?: string): Promise<void> {
  if (projectId) {
    await corpusFor(uid, projectId).drain();
    return;
  }
  const prefix = `${uid}\x00`;
  for (const key of [..._known]) {
    if (!key.startsWith(prefix)) continue;
    const pid = key.slice(prefix.length);
    if (pid) await corpusFor(uid, pid).drain();
  }
}

/** Cancel queued/in-flight work and remove all machine-derived data for a
 *  deleted project. The epoch bump prevents late extraction/embedding
 *  settlements from recreating the vector store after this returns. */
export async function dropProjectIndex(uid: string, projectId: string): Promise<void> {
  const pid = safeProjectId(projectId);
  const key = projectKey(uid, pid);
  _deletedProjects.add(key);
  _projectEpochs.set(key, projectEpoch(uid, pid) + 1);

  const dbDir = path.dirname(projectLibraryVectorDbPath(uid, pid));
  closeLibraryCorpus(dbDir);
  vs.closeVecStore(dbDir);
  try { await fsp.rm(projectLocalDir(uid, pid), { recursive: true, force: true }); }
  catch (err) { log.warn(`dropProjectIndex: ${(err as Error).message}`); }
}

export function _resetQueuesForTests(): void {
  _projectEpochs.clear();
  _deletedProjects.clear();
  _known.clear();
  projectLibraryEvents.removeAllListeners();
  projectLibraryEvents.setMaxListeners(50);
}
