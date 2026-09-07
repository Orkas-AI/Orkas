/**
 * A Library corpus: one source root, one derived vector index, one indexing
 * queue. The global Library is a corpus; each project Library is a corpus.
 *
 * This module owns everything that is corpus-independent — admission and
 * dedup, the two-stage extract/embed pipeline, reconcile diffing with crash
 * recovery, status events, and the vectorize analytics batch — so a fix lands
 * once instead of in two indexers that had drifted into different
 * capabilities (pipelining and cancellable reconcile on one side, deletion
 * epochs and name safety on the other).
 *
 * What differs between corpora is data, not code: see `CorpusSpec`.
 *
 * Concurrency: one worker per corpus. Embedding is deliberately NOT gated
 * process-wide: `kb_embed` holds one ONNX session, but a hung native call
 * never releases a mutex, so a gate would let one stuck file drag every later
 * one into its own timeout — the opposite of what the timeout exists for.
 * Cross-corpus embed serialisation, if it is ever wanted, belongs in
 * `kb_embed` with its own evidence, not as a side effect of consolidation.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { createLogger } from '../logger';
import { fileToChunks, type ChunkableKind } from '../util/file_to_chunks';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import {
  envTimeoutMs,
  OperationTimeoutError,
  operationErrorCode,
  withOperationTimeout,
} from '../util/operation-timeout';
import { describeLibraryImage } from './library_image_describer';
import * as vs from './vec_store';
import * as kbEmbed from './kb_embed';

const log = createLogger('library_corpus');

interface LibraryVectorizeBatch {
  startedAt: number;
  fileCount: number;
  succeededCount: number;
  failedCount: number;
  recoveredCount: number;
  retryCount: number;
  timeoutCount: number;
  maxQueueWaitMs: number;
}

function createLibraryVectorizeBatch(_scope: 'global' | 'project', _uid: string): LibraryVectorizeBatch {
  return {
    startedAt: Date.now(), fileCount: 0, succeededCount: 0, failedCount: 0,
    recoveredCount: 0, retryCount: 0, timeoutCount: 0, maxQueueWaitMs: 0,
  };
}

function recordLibraryVectorizeOutcome(
  batch: LibraryVectorizeBatch,
  outcome: {
    result: 'success' | 'failure';
    stage?: 'extract' | 'embed' | 'persist';
    reason: 'mutation' | 'reconcile' | 'crash_recovery' | 'late_recovery' | 'manual';
    durationMs: number;
    queueWaitMs: number;
    attempt: number;
    chunks?: number;
    errorCode?: string;
  },
): void {
  batch.fileCount += 1;
  batch.maxQueueWaitMs = Math.max(batch.maxQueueWaitMs, Math.max(0, Math.round(outcome.queueWaitMs)));
  batch.retryCount += Math.max(0, Math.round(outcome.attempt) - 1);
  if (outcome.reason === 'crash_recovery' || outcome.reason === 'late_recovery') batch.recoveredCount += 1;
  if (outcome.result === 'success') batch.succeededCount += 1;
  else batch.failedCount += 1;
  if (/timeout/i.test(String(outcome.errorCode || ''))) batch.timeoutCount += 1;
}

function flushLibraryVectorizeBatch(batch: LibraryVectorizeBatch): Record<string, number | string> | null {
  if (batch.fileCount <= 0) return null;
  return {
    result: batch.failedCount <= 0 ? 'success' : batch.succeededCount > 0 ? 'partial_failure' : 'failure',
    file_count: batch.fileCount,
    succeeded_count: batch.succeededCount,
    failed_count: batch.failedCount,
    timeout_count: batch.timeoutCount,
    recovered_count: batch.recoveredCount,
    retry_count: batch.retryCount,
    duration_ms: Math.max(0, Date.now() - batch.startedAt),
    max_queue_wait_ms: batch.maxQueueWaitMs,
  };
}

/** Embedding chunk budget. Kept well under bge-small-zh-v1.5's 512-token
 *  window so the embedder sees whole chunks instead of silently truncating,
 *  and small chunks sharpen retrieval — one idea per vector. Callers wanting
 *  wider context read neighbouring chunks back at answer time. */
export const EMBED_MAX_CHARS = 400;
/** Overlap applied only when a single paragraph has to be split at sentence
 *  boundaries. Separate paragraphs do not overlap — different topics should
 *  not bleed into one vector. */
export const EMBED_OVERLAP = 50;

const EXTRACT_TIMEOUT_MS = envTimeoutMs('ORKAS_LIBRARY_EXTRACT_TIMEOUT_MS', 5 * 60 * 1000);
const EMBED_TIMEOUT_MS = envTimeoutMs('ORKAS_LIBRARY_EMBED_TIMEOUT_MS', 5 * 60 * 1000);
const RECONCILE_FILE_CONCURRENCY = 4;
const MAX_PATH_SEGMENT_LEN = 200;

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Files a corpus knows how to vectorize. Anything else is skipped silently by
 *  the walk and refused by admission. */
export function libraryKindFor(name: string): ChunkableKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

/** Normalise an admission id to a corpus-relative path, or null when it could
 *  escape the source root. Both corpora take ids from IPC callers, so this is
 *  an admission gate rather than a project-only concern: a rejected id must
 *  never reach the queue, because failing it later would broadcast a path
 *  outside the corpus to every status listener. */
export function safeCorpusRelPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.includes('\x00') || normalized.startsWith('/') || path.isAbsolute(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => (
    !part || part === '.' || part === '..' || part.startsWith('.') || part.length > MAX_PATH_SEGMENT_LEN
  ))) return null;
  return parts.join('/');
}

export type CorpusEventStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';
export type CorpusStage = 'queue' | 'extract' | 'embed' | 'persist' | 'reconcile';

export interface CorpusStatusEvent {
  relPath: string;
  status: CorpusEventStatus;
  chunks?: number;
  error?: string;
  kind?: ChunkableKind;
  stage?: CorpusStage;
  errorCode?: string;
}

export type CorpusJobReason = 'mutation' | 'reconcile' | 'crash_recovery' | 'late_recovery' | 'manual';

export interface CorpusSpec {
  /** Owner, for log redaction and analytics attribution only. */
  uid: string;
  /** Analytics label. */
  scope: 'global' | 'project';
  /** Absolute source root walked by reconcile. */
  sourceRoot: string;
  /** Absolute directory holding `vector.db` + `config.json`. */
  dbDir: string;
  /** Session prefix for the image-description one-shots. */
  imageSessionPrefix: string;
  /** Status sink. Callers map this to their own event shape. */
  emit(event: CorpusStatusEvent): void;
  /** Extra exclusion beyond dot-entries and unsupported kinds. */
  skipRelPath?(relPath: string): boolean;
  /** Monotonic generation. A job stamped with an older value is dropped —
   *  this is how a deleted project cancels in-flight and late work. */
  epoch?(): number;
  /** True once the corpus is discarded; nothing may run or be created. */
  discarded?(): boolean;
  /** Guard evaluated at the start of reconcile; false → no-op. */
  exists?(): Promise<boolean>;
  /** Emit a terminal `ready` when an unchanged file is re-admitted. The two
   *  corpora diverged here before consolidation — the global Library stays
   *  silent (nothing changed, and its row is already ready) while the project
   *  Library answers every admission with a terminal event. Preserved as a
   *  choice rather than unified, because both renderers already depend on
   *  what they get today. */
  emitReadyOnCacheHit?: boolean;
}

export interface CorpusReconcileResult {
  enqueuedUpsert: number;
  enqueuedDelete: number;
  unchanged: number;
  reusedHashes?: number;
  recoveredProcessing?: number;
  cancelled?: boolean;
  incomplete?: boolean;
}

export interface LibraryCorpus {
  readonly dbDir: string;
  enqueue(relPath: string, op?: 'upsert' | 'delete', opts?: { force?: boolean; reason?: CorpusJobReason; attempt?: number }): void;
  reconcile(signal?: AbortSignal): Promise<CorpusReconcileResult>;
  drain(): Promise<void>;
  /** Read-only retrieval; never reconciles. Returns [] when no index exists. */
  search(queryVec: number[] | Float32Array, opts?: vs.VecSearchOpts): vs.VecSearchHit[];
  getFile(relPath: string): vs.VecFileRow | null;
  listFiles(): vs.VecFileRow[];
  readFileChunks(relPath: string): Array<{ chunk_idx: number; title: string | null; content: string }>;
  statusSummary(): { total: number; ready: number; processing: number; pending: number; failed: number };
  /** Drop queued work for this corpus. The store itself is the caller's. */
  cancelQueued(): void;
}

interface Job {
  relPath: string;
  op: 'upsert' | 'delete';
  epoch: number;
  force: boolean;
  enqueuedAt: number;
  reason: CorpusJobReason;
  attempt: number;
}

interface Queue {
  jobs: Job[];
  running: boolean;
  scheduled: boolean;
  activePaths: Map<string, number>;
}

interface ExtractResult {
  relPath: string;
  kind: ChunkableKind;
  bytes: number;
  mtime: number;
  sha1: string;
  chunks: Array<{ title: string; content: string }>;
  job: Job;
  startedAt: number;
}

interface ReconcileFileMeta {
  kind: ChunkableKind;
  sha1: string;
  bytes: number;
  mtime: number;
}

const _corpora = new Map<string, LibraryCorpus>();

/** Open (or retrieve) the corpus for a dbDir. Corpora are cached so every
 *  caller shares one queue per index — two queues over one `vector.db` would
 *  interleave writes to the same rows. */
export function openLibraryCorpus(spec: CorpusSpec): LibraryCorpus {
  const cached = _corpora.get(spec.dbDir);
  if (cached) return cached;
  const corpus = createCorpus(spec);
  _corpora.set(spec.dbDir, corpus);
  return corpus;
}

/** Forget a corpus (deleted project, tests). Queued work is dropped; the
 *  vector store lifecycle belongs to the caller. */
export function closeLibraryCorpus(dbDir: string): void {
  const corpus = _corpora.get(dbDir);
  if (corpus) corpus.cancelQueued();
  _corpora.delete(dbDir);
}

export function _resetLibraryCorporaForTests(): void {
  for (const corpus of _corpora.values()) corpus.cancelQueued();
  _corpora.clear();
}

function createCorpus(spec: CorpusSpec): LibraryCorpus {
  const queue: Queue = { jobs: [], running: false, scheduled: false, activePaths: new Map() };
  const epochOf = (): number => (spec.epoch ? spec.epoch() : 0);
  const discarded = (): boolean => spec.discarded?.() === true;
  const storeExists = (): boolean => fs.existsSync(path.join(spec.dbDir, 'vector.db'));
  const store = (): vs.VecStore => vs.openVecStore(spec.dbDir);
  const jobIsCurrent = (job: Job): boolean => !discarded() && job.epoch === epochOf();

  function retain(relPath: string): void {
    queue.activePaths.set(relPath, (queue.activePaths.get(relPath) || 0) + 1);
  }
  function release(relPath: string): void {
    const count = queue.activePaths.get(relPath) || 0;
    if (count <= 1) queue.activePaths.delete(relPath);
    else queue.activePaths.set(relPath, count - 1);
  }

  function enqueue(
    relPath: string,
    op: 'upsert' | 'delete' = 'upsert',
    opts: { force?: boolean; reason?: CorpusJobReason; attempt?: number } = {},
  ): void {
    if (discarded()) return;
    const safe = safeCorpusRelPath(relPath);
    if (!safe) return;
    // Skipped paths are never indexed, but a row indexed before the skip rule
    // (or under an older rule) must still be deletable, or reconcile keeps a
    // stale searchable row forever.
    if (op === 'upsert' && spec.skipRelPath?.(safe)) return;
    if (op === 'upsert' && !libraryKindFor(safe)) return;
    const existing = queue.jobs.find((job) => job.relPath === safe && job.op === op);
    if (existing) {
      if (opts.force) existing.force = true;
      return;
    }
    queue.jobs.push({
      relPath: safe,
      op,
      epoch: epochOf(),
      force: opts.force === true,
      enqueuedAt: Date.now(),
      reason: opts.reason || (opts.force ? 'manual' : 'mutation'),
      attempt: Math.max(1, Math.round(opts.attempt || 1)),
    });
    if (op === 'upsert') {
      spec.emit({ relPath: safe, status: 'pending', ...(libraryKindFor(safe) ? { kind: libraryKindFor(safe)! } : {}) });
    }
    scheduleRun();
  }

  function scheduleRun(): void {
    if (queue.running || queue.scheduled) return;
    queue.scheduled = true;
    setImmediate(() => {
      queue.scheduled = false;
      void runQueue();
    });
  }

  /**
   * Pipelined two-stage worker: extraction runs in the foreground one file at
   * a time and hands off to embed+persist on a background chain, so a large
   * PDF no longer stalls the small files queued behind it. Embeds stay serial
   * on that chain (and behind the process-wide gate) because the ONNX session
   * is single-threaded — the win is overlapping extract with embed.
   */
  async function runQueue(): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    const batch = createLibraryVectorizeBatch(spec.scope, spec.uid);
    let chain: Promise<void> = Promise.resolve();
    try {
      while (true) {
        while (queue.jobs.length) {
          const job = queue.jobs.shift()!;
          if (!jobIsCurrent(job)) continue;
          if (job.op === 'delete') {
            // Serialise deletes behind pending upserts to keep FS ↔ DB order.
            chain = chain.then(() => processDelete(job)).catch((err) => log.warn('library delete failed', {
              user_id: maskId(spec.uid),
              scope: spec.scope,
              path: logPathRef(job.relPath),
              error: logErrorSummary(err),
            }));
            continue;
          }
          retain(job.relPath);
          let extract: ExtractResult | null = null;
          try { extract = await prepareAndExtract(job, batch); }
          catch (err) {
            log.warn('library extract failed', {
              user_id: maskId(spec.uid),
              scope: spec.scope,
              path: logPathRef(job.relPath),
              error: logErrorSummary(err),
            });
            await failUnexpectedJob(job, err, batch);
            release(job.relPath);
            continue;
          }
          if (!extract) {
            release(job.relPath);
            continue;
          }
          const ready = extract;
          chain = chain.then(() => embedAndUpsert(ready, batch))
            .catch((err) => log.warn('library embed failed', {
              user_id: maskId(spec.uid),
              scope: spec.scope,
              path: logPathRef(ready.relPath),
              error: logErrorSummary(err),
            }))
            .finally(() => { release(ready.relPath); });
        }
        await chain;
        chain = Promise.resolve();
        if (!queue.jobs.length) break;
      }
    } finally {
      queue.running = false;
      const summary = flushLibraryVectorizeBatch(batch);
      if (summary) {
        log.info('library vectorization batch complete', {
          user_id: maskId(spec.uid),
          scope: spec.scope,
          result: summary.result,
          files: summary.file_count,
          succeeded: summary.succeeded_count,
          failed: summary.failed_count,
          timeouts: summary.timeout_count,
          recovered: summary.recovered_count,
          retries: summary.retry_count,
          duration_ms: summary.duration_ms,
          max_queue_wait_ms: summary.max_queue_wait_ms,
        });
      }
    }
  }

  /** Foreground stage: stat + hash + cache check + extract. Null means the
   *  file needs no embedding (gone, cache hit, unsupported, or already
   *  reported as failed). */
  async function prepareAndExtract(job: Job, batch: LibraryVectorizeBatch): Promise<ExtractResult | null> {
    const { relPath } = job;
    const startedAt = Date.now();
    const abs = path.join(spec.sourceRoot, relPath);
    const kind = libraryKindFor(relPath);
    if (!kind) return null;

    let stat: fs.Stats;
    try { stat = await fsp.stat(abs); }
    catch {
      // Disk removed it between admission and processing — treat as a delete.
      if (!jobIsCurrent(job)) return null;
      if (storeExists()) await store().deleteFile(relPath);
      if (!jobIsCurrent(job)) return null;
      spec.emit({ relPath, status: 'deleted', kind });
      return null;
    }
    if (!stat.isFile()) {
      if (!jobIsCurrent(job)) return null;
      if (storeExists()) await store().deleteFile(relPath);
      if (!jobIsCurrent(job)) return null;
      spec.emit({ relPath, status: 'deleted', kind });
      return null;
    }

    const buf = await fsp.readFile(abs);
    if (!jobIsCurrent(job)) return null;
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');

    const existing = storeExists() ? store().getFile(relPath) : null;
    if (!job.force && existing && existing.sha1 === sha1 && existing.status === 'ready') {
      if (spec.emitReadyOnCacheHit) spec.emit({ relPath, status: 'ready', kind, chunks: existing.chunks });
      return null;
    }

    // Empty content: embedding nothing produces a useless vector and can hang
    // the embedder. Mark it ready with zero chunks so the UI settles; adding
    // content changes the sha1 and re-admits it.
    const isEmpty = stat.size === 0 || (kind === 'text' && buf.toString('utf8').trim() === '');
    if (isEmpty) {
      if (!jobIsCurrent(job)) return null;
      await store().upsertFile({
        id: relPath, kind, bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1, chunks: [],
      });
      if (!jobIsCurrent(job)) return null;
      spec.emit({ relPath, status: 'ready', kind, chunks: 0, stage: 'persist' });
      recordOutcome(batch, job, startedAt, { result: 'success', stage: 'persist', chunks: 0 });
      return null;
    }

    if (!jobIsCurrent(job)) return null;
    await store().setFileStatus(relPath, 'processing', {
      kind, bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1,
    });
    spec.emit({ relPath, status: 'processing', kind, stage: 'extract' });

    try {
      const operation = fileToChunks({
        kind,
        buf,
        maxChars: EMBED_MAX_CHARS,
        overlap: EMBED_OVERLAP,
        imageTitle: path.basename(relPath),
        ...(kind === 'image'
          ? { imageDescriber: (b: Buffer) => describeLibraryImage(spec.uid, path.basename(relPath), b, { sessionPrefix: spec.imageSessionPrefix }) }
          : {}),
      });
      const chunks = await withOperationTimeout(operation, {
        timeoutMs: EXTRACT_TIMEOUT_MS,
        code: 'E_LIBRARY_EXTRACT_TIMEOUT',
        stage: 'extract',
        onLateSettlement: (late) => scheduleLateRecovery(job, sha1, late, 'extract'),
      });
      if (!jobIsCurrent(job)) return null;
      if (!chunks.length) throw new Error('extraction returned zero chunks');
      return { relPath, kind, bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1, chunks, job, startedAt };
    } catch (err) {
      if (!jobIsCurrent(job)) return null;
      await reportFailure(job, err, startedAt, 'extract', 'E_LIBRARY_EXTRACT_FAILED', kind, batch);
      return null;
    }
  }

  /** Background stage: embed + atomic upsert, one at a time process-wide. */
  async function embedAndUpsert(ready: ExtractResult, batch: LibraryVectorizeBatch): Promise<void> {
    let stage: 'embed' | 'persist' = 'embed';
    try {
      if (!jobIsCurrent(ready.job)) return;
      spec.emit({ relPath: ready.relPath, status: 'processing', kind: ready.kind, stage: 'embed' });
      const operation = kbEmbed.embedTexts(ready.chunks.map((c) => c.content));
      const vectors = await withOperationTimeout(operation, {
        timeoutMs: EMBED_TIMEOUT_MS,
        code: 'E_LIBRARY_EMBED_TIMEOUT',
        stage: 'embed',
        onLateSettlement: (late) => scheduleLateRecovery(ready.job, ready.sha1, late, 'embed'),
      });
      if (!jobIsCurrent(ready.job)) return;
      stage = 'persist';
      await store().upsertFile({
        id: ready.relPath,
        kind: ready.kind,
        bytes: ready.bytes,
        mtime: ready.mtime,
        sha1: ready.sha1,
        chunks: ready.chunks.map((c, i) => ({ title: c.title, content: c.content, embedding: vectors[i] })),
      });
      if (!jobIsCurrent(ready.job)) return;
      spec.emit({ relPath: ready.relPath, status: 'ready', kind: ready.kind, chunks: ready.chunks.length, stage: 'persist' });
      recordOutcome(batch, ready.job, ready.startedAt, {
        result: 'success', stage: 'persist', chunks: ready.chunks.length,
      });
    } catch (err) {
      if (!jobIsCurrent(ready.job)) return;
      const resolved = err instanceof OperationTimeoutError && err.stage === 'embed' ? 'embed' : stage;
      await reportFailure(
        ready.job, err, ready.startedAt, resolved,
        resolved === 'embed' ? 'E_LIBRARY_EMBED_FAILED' : 'E_LIBRARY_PERSIST_FAILED',
        ready.kind, batch,
      );
    }
  }

  async function reportFailure(
    job: Job,
    err: unknown,
    startedAt: number,
    stage: 'extract' | 'embed' | 'persist',
    fallbackCode: string,
    kind: ChunkableKind | undefined,
    batch: LibraryVectorizeBatch,
  ): Promise<void> {
    const message = (err as Error).message || String(err);
    const errorCode = operationErrorCode(err, fallbackCode);
    log.warn('library vectorization failed', {
      user_id: maskId(spec.uid),
      scope: spec.scope,
      path: logPathRef(job.relPath),
      kind,
      stage,
      error_code: errorCode,
      duration_ms: Date.now() - startedAt,
      queue_wait_ms: startedAt - job.enqueuedAt,
      attempt: job.attempt,
      error: logErrorSummary(err),
    });
    try { await store().setFileStatus(job.relPath, 'failed', { error: message }); }
    catch { /* the primary log already records the storage failure */ }
    spec.emit({ relPath: job.relPath, status: 'failed', error: message, ...(kind ? { kind } : {}), stage, errorCode });
    recordOutcome(batch, job, startedAt, { result: 'failure', stage, errorCode });
  }

  function recordOutcome(
    batch: LibraryVectorizeBatch,
    job: Job,
    startedAt: number,
    terminal: { result: 'success' | 'failure'; stage: 'extract' | 'embed' | 'persist'; chunks?: number; errorCode?: string },
  ): void {
    recordLibraryVectorizeOutcome(batch, {
      result: terminal.result,
      stage: terminal.stage,
      reason: job.reason,
      chunks: terminal.chunks || 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      queueWaitMs: Math.max(0, startedAt - job.enqueuedAt),
      errorCode: terminal.errorCode || '',
      attempt: job.attempt,
    });
  }

  /** A timeout releases the queue but cannot stop native PDF/model work. Hold
   *  a second ownership reference until it really settles so reconcile cannot
   *  start the same path concurrently, then allow exactly one retry. */
  function scheduleLateRecovery<T>(job: Job, expectedSha1: string, late: Promise<T>, stage: 'extract' | 'embed'): void {
    retain(job.relPath);
    void late.then(() => {
      if (!jobIsCurrent(job) || job.attempt >= 2) return;
      const row = storeExists() ? store().getFile(job.relPath) : null;
      if (!row || row.status !== 'failed' || row.sha1 !== expectedSha1) return;
      log.info('timed-out library operation settled; scheduling one recovery attempt', {
        user_id: maskId(spec.uid),
        scope: spec.scope,
        path: logPathRef(job.relPath),
        stage,
        attempt: job.attempt + 1,
      });
      enqueue(job.relPath, 'upsert', { reason: 'late_recovery', attempt: job.attempt + 1 });
    }).catch((err) => {
      log.info('timed-out library operation eventually failed', {
        user_id: maskId(spec.uid),
        scope: spec.scope,
        path: logPathRef(job.relPath),
        stage,
        error: logErrorSummary(err),
      });
    }).finally(() => { release(job.relPath); });
  }

  async function failUnexpectedJob(job: Job, err: unknown, batch: LibraryVectorizeBatch): Promise<void> {
    if (job.op !== 'upsert' || !jobIsCurrent(job)) return;
    const row = storeExists() ? store().getFile(job.relPath) : null;
    const kind = libraryKindFor(job.relPath) || row?.kind;
    const message = (err as Error)?.message || String(err);
    const errorCode = operationErrorCode(err, 'E_LIBRARY_JOB_FAILED');
    try { await store().setFileStatus(job.relPath, 'failed', { error: message }); }
    catch { /* already logged by the caller */ }
    spec.emit({
      relPath: job.relPath, status: 'failed', error: message,
      ...(kind ? { kind } : {}), stage: 'queue', errorCode,
    });
    if (kind) recordOutcome(batch, job, Date.now(), { result: 'failure', stage: 'persist', errorCode });
  }

  async function processDelete(job: Job): Promise<void> {
    if (!jobIsCurrent(job)) return;
    if (storeExists()) await store().deleteFile(job.relPath);
    if (!jobIsCurrent(job)) return;
    spec.emit({ relPath: job.relPath, status: 'deleted' });
  }

  // ── Reconcile ─────────────────────────────────────────────────────────

  async function reconcile(signal?: AbortSignal): Promise<CorpusReconcileResult> {
    const startedAt = Date.now();
    if (discarded()) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };
    if (spec.exists && !(await spec.exists())) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };

    // Opening the store creates `vector.db`. Boot maintenance reconciles every
    // corpus, so one with nothing to index must not gain derived state just by
    // being looked at.
    const hadStore = storeExists();
    const indexedRows = hadStore ? store().listFiles() : [];
    const indexedByPath = new Map(indexedRows.map((row) => [row.rel_path, row]));
    const scan = await walk(spec.sourceRoot, indexedByPath, signal);

    if (!scan.complete) {
      const cancelled = !!signal?.aborted;
      log.warn('library reconcile snapshot incomplete; leaving persisted rows untouched', {
        user_id: maskId(spec.uid),
        scope: spec.scope,
        discovered: scan.files.size,
        cancelled,
        ms: Date.now() - startedAt,
      });
      return {
        enqueuedUpsert: 0,
        enqueuedDelete: 0,
        unchanged: 0,
        ...(cancelled ? { cancelled: true } : { incomplete: true }),
      };
    }

    const onDisk = scan.files;
    if (!hadStore && onDisk.size === 0) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };

    let enqueuedUpsert = 0;
    let enqueuedDelete = 0;
    let unchanged = 0;
    let recoveredProcessing = 0;

    for (const [relPath, meta] of onDisk) {
      const snapshotExisting = indexedByPath.get(relPath);
      // A processing job may settle while the filesystem walk is in flight.
      // Re-read that one transient state before deciding ownership: otherwise
      // the stale snapshot looks orphaned as soon as the worker releases the
      // path, and reconcile schedules a duplicate job that can overwrite the
      // just-persisted chunks (most visibly, an image model description).
      const existing = snapshotExisting?.status === 'processing'
        ? store().getFile(relPath)
        : snapshotExisting;
      const ownedByQueue = queue.activePaths.has(relPath)
        || queue.jobs.some((job) => job.relPath === relPath);
      const orphanedProcessing = existing?.status === 'processing' && !ownedByQueue;
      const needsWork = !existing
        || existing.sha1 !== meta.sha1
        || (!ownedByQueue && (existing.status === 'failed' || existing.status === 'pending'))
        || orphanedProcessing;
      if (!needsWork) {
        unchanged += 1;
        continue;
      }
      if (orphanedProcessing && existing) {
        recoveredProcessing += 1;
        await store().setFileStatus(relPath, 'pending', { error: null });
        log.warn('recovered orphaned processing library row', {
          user_id: maskId(spec.uid),
          scope: spec.scope,
          path: logPathRef(relPath),
          stale_ms: Math.max(0, Date.now() - existing.updated_at * 1000),
        });
      }
      enqueue(relPath, 'upsert', { reason: orphanedProcessing ? 'crash_recovery' : 'reconcile' });
      enqueuedUpsert += 1;
    }

    for (const row of indexedRows) {
      if (!onDisk.has(row.rel_path)) {
        enqueue(row.rel_path, 'delete', { reason: 'reconcile' });
        enqueuedDelete += 1;
      }
    }

    if (enqueuedUpsert || enqueuedDelete) {
      log.info('library reconcile queued work', {
        user_id: maskId(spec.uid),
        scope: spec.scope,
        upsert: enqueuedUpsert,
        delete: enqueuedDelete,
        unchanged,
        recovered_processing: recoveredProcessing,
      });
    }
    log.info('library reconcile scan complete', {
      user_id: maskId(spec.uid),
      scope: spec.scope,
      files: onDisk.size,
      reused_hashes: scan.reusedHashes,
      hashed_files: onDisk.size - scan.reusedHashes,
      ms: Date.now() - startedAt,
      recovered_processing: recoveredProcessing,
    });
    return { enqueuedUpsert, enqueuedDelete, unchanged, reusedHashes: scan.reusedHashes, recoveredProcessing };
  }

  async function hashFile(
    full: string,
    kind: ChunkableKind,
    existing: vs.VecFileRow | undefined,
    signal?: AbortSignal,
  ): Promise<{ meta: ReconcileFileMeta | null; reliable: boolean; reusedHash: boolean }> {
    if (signal?.aborted) return { meta: null, reliable: false, reusedHash: false };
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) return { meta: null, reliable: true, reusedHash: false };
      if (signal?.aborted) return { meta: null, reliable: false, reusedHash: false };
      const mtime = st.mtimeMs / 1000;
      if (existing?.sha1 && existing.bytes === st.size && Math.abs(existing.mtime - mtime) < 0.001) {
        return { meta: { kind, sha1: existing.sha1, bytes: st.size, mtime }, reliable: true, reusedHash: true };
      }
      const hash = crypto.createHash('sha1');
      const stream = fs.createReadStream(full, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.destroy();
          return { meta: null, reliable: false, reusedHash: false };
        }
        hash.update(chunk as Buffer);
      }
      return {
        meta: { kind, sha1: hash.digest('hex'), bytes: st.size, mtime: st.mtimeMs / 1000 },
        reliable: true,
        reusedHash: false,
      };
    } catch (err) {
      if (signal?.aborted || (err as NodeJS.ErrnoException).name === 'AbortError') {
        return { meta: null, reliable: false, reusedHash: false };
      }
      // A file disappearing mid-snapshot is a valid absence; permission or
      // transient I/O failures make the snapshot unsafe for delete decisions.
      return { meta: null, reliable: (err as NodeJS.ErrnoException).code === 'ENOENT', reusedHash: false };
    }
  }

  async function walk(
    root: string,
    indexedByPath: ReadonlyMap<string, vs.VecFileRow>,
    signal?: AbortSignal,
  ): Promise<{ files: Map<string, ReconcileFileMeta>; complete: boolean; reusedHashes: number }> {
    const out = new Map<string, ReconcileFileMeta>();
    const candidates: Array<{ relPath: string; full: string; kind: ChunkableKind }> = [];
    let reliable = true;
    let reusedHashes = 0;
    const stack: string[] = [''];
    while (stack.length) {
      if (signal?.aborted) return { files: out, complete: false, reusedHashes };
      const cur = stack.pop()!;
      const abs = cur ? path.join(root, cur) : root;
      let items: fs.Dirent[];
      try { items = await fsp.readdir(abs, { withFileTypes: true }); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reliable = false;
        continue;
      }
      for (const entry of items) {
        if (signal?.aborted) return { files: out, complete: false, reusedHashes };
        // Dot entries hold derived state (`.kb/`, snapshots, DS_Store).
        if (entry.name.startsWith('.')) continue;
        const relPath = cur ? `${cur}/${entry.name}` : entry.name;
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) { stack.push(relPath); continue; }
        if (!entry.isFile()) continue;
        if (spec.skipRelPath?.(relPath)) continue;
        const kind = libraryKindFor(entry.name);
        if (!kind) continue;
        candidates.push({ relPath, full, kind });
      }
    }

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(RECONCILE_FILE_CONCURRENCY, candidates.length) },
      async () => {
        while (!signal?.aborted) {
          const index = cursor++;
          if (index >= candidates.length) return;
          const candidate = candidates[index];
          const result = await hashFile(candidate.full, candidate.kind, indexedByPath.get(candidate.relPath), signal);
          if (!result.reliable) reliable = false;
          if (result.reusedHash) reusedHashes += 1;
          if (result.meta) out.set(candidate.relPath, result.meta);
        }
      },
    );
    await Promise.all(workers);
    return { files: out, complete: reliable && !signal?.aborted, reusedHashes };
  }

  return {
    dbDir: spec.dbDir,
    enqueue,
    reconcile,
    async drain(): Promise<void> {
      while (queue.scheduled || queue.running || queue.jobs.length) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    search(queryVec, opts = {}) {
      if (!storeExists()) return [];
      return store().search(queryVec, opts);
    },
    getFile(relPath) { return storeExists() ? store().getFile(relPath) : null; },
    listFiles() { return storeExists() ? store().listFiles() : []; },
    readFileChunks(relPath) { return storeExists() ? store().readFileChunks(relPath) : []; },
    statusSummary() {
      return storeExists()
        ? store().statusSummary()
        : { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 };
    },
    cancelQueued() { queue.jobs = []; },
  };
}
