/**
 * Global Library (KB): the corpus registration for `<uid>/cloud/contexts/`.
 *
 * Queue mechanics, the two-stage extract/embed pipeline, cancellable
 * reconcile, crash recovery and vectorize analytics live in `library_corpus`;
 * this module owns what is global-Library-shaped — the uid-keyed API its
 * callers already use, the `_INDEX.md` exclusion, and the `kbEvents` shape the
 * IPC bridge forwards to the renderer.
 */

import { EventEmitter } from 'node:events';

import { userContextsDir, userKbVectorDbPath } from '../paths';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type * as kb from './kb_vector';
import {
  openLibraryCorpus,
  type CorpusJobReason,
  type CorpusReconcileResult,
  type CorpusStatusEvent,
  type LibraryCorpus,
} from './library_corpus';


export type KbEventType = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';

export interface KbStatusEvent {
  userId: string;
  relPath: string;
  status: KbEventType;
  /** Populated on `ready`. */
  chunks?: number;
  /** Populated on `failed`. */
  error?: string;
  /** Echoed on every event once detected — UI uses it for icon routing. */
  kind?: kb.KbKind;
  stage?: 'queue' | 'extract' | 'embed' | 'persist' | 'reconcile';
  errorCode?: string;
}

export type ReconcileResult = CorpusReconcileResult;

/** Listeners subscribe via `kbEvents.on('status', fn)`. The IPC layer bridges
 *  to the renderer over a stream channel. */
export const kbEvents = new EventEmitter();
// A single indexer fans out to many renderer windows plus internal listeners;
// Node's default maxListeners=10 would emit spurious warnings.
kbEvents.setMaxListeners(50);

const _known = new Set<string>();

function corpusFor(uid: string): LibraryCorpus {
  _known.add(uid);
  return openLibraryCorpus({
    uid,
    scope: 'global',
    sourceRoot: userContextsDir(uid),
    dbDir: path.dirname(userKbVectorDbPath(uid)),
    imageSessionPrefix: 'extract-img',
    // Root-level `_INDEX.md` is generated for Finder browsing, and subdirectory
    // copies are pre-vector-store legacy — neither is KB content.
    skipRelPath: (relPath) => path.posix.basename(relPath) === '_INDEX.md',
    emit: (event: CorpusStatusEvent) => {
      const out: KbStatusEvent = {
        userId: uid,
        relPath: event.relPath,
        status: event.status,
        ...(event.chunks !== undefined ? { chunks: event.chunks } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.kind ? { kind: event.kind as kb.KbKind } : {}),
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      };
      kbEvents.emit('status', out);
    },
  });
}

/** Enqueue one file. `op='delete'` drops the row and cascades its chunks and
 *  vectors; `op='upsert'` reads from disk and (re-)vectorizes. Safe to call
 *  repeatedly — admission dedups by (path, op). */
export function enqueue(
  uid: string,
  relPath: string,
  op: 'upsert' | 'delete' = 'upsert',
  opts: { reason?: CorpusJobReason; attempt?: number } = {},
): void {
  corpusFor(uid).enqueue(relPath, op, opts);
}

/**
 * Walk `<uid>/cloud/contexts/**` and diff against the persisted index: enqueue
 * upserts for new / changed / previously-failed files, deletes for rows whose
 * source disappeared. Idempotent, and safe to call anytime.
 *
 * Skipped: dot-prefixed entries (`.kb/` and friends), `_INDEX.md`, and any
 * extension outside the supported set.
 */
export async function reconcile(uid: string, signal?: AbortSignal): Promise<ReconcileResult> {
  // The global Library root is created on demand — a first run must not fail
  // just because the user has never opened the Library.
  await fsp.mkdir(userContextsDir(uid), { recursive: true });
  return corpusFor(uid).reconcile(signal);
}

/** Await all queued work for a uid — tests use it to serialize "enqueue then
 *  assert"; returns once the queue is empty and the worker idle. */
export async function drain(uid: string): Promise<void> {
  await corpusFor(uid).drain();
}

/** Reset in-memory queue state. Tests use this between runs. */
export function _resetQueuesForTests(): void {
  _known.clear();
  kbEvents.removeAllListeners();
  kbEvents.setMaxListeners(50);
}
