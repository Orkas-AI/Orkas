/**
 * Project-scoped Library vector index.
 *
 * Project Library source files live under `<uid>/cloud/projects/<pid>/contexts/`.
 * The derived vector store is machine-local under `<uid>/local/projects/<pid>/`
 * so project assets can sync independently from embeddings, mirroring the
 * global Library/KB design.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { projectFilesDir, projectLibraryVectorDbPath } from '../paths';
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
import { projectExists } from './projects';

const log = createLogger('project_library_indexer');

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
const MAX_PATH_SEGMENT_LEN = 200;
const EXTRACT_TIMEOUT_MS = envTimeoutMs('ORKAS_LIBRARY_EXTRACT_TIMEOUT_MS', 5 * 60 * 1000);
const EMBED_TIMEOUT_MS = envTimeoutMs('ORKAS_LIBRARY_EMBED_TIMEOUT_MS', 5 * 60 * 1000);

type LibraryVectorizeBatch = Record<string, never>;
interface LibraryVectorizeSummary {
  result: string;
  file_count: number;
  succeeded_count: number;
  failed_count: number;
  timeout_count: number;
  recovered_count: number;
  retry_count: number;
  duration_ms: number;
  max_queue_wait_ms: number;
}

function createLibraryVectorizeBatch(_scope: 'project'): LibraryVectorizeBatch {
  return {};
}

function flushLibraryVectorizeBatch(_batch: LibraryVectorizeBatch): LibraryVectorizeSummary | null {
  return null;
}

function recordLibraryVectorizeOutcome(
  _batch: LibraryVectorizeBatch,
  _outcome: Record<string, string | number>,
): void {}

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
  recovered?: boolean;
}

export interface ProjectLibraryReconcileResult {
  enqueuedUpsert: number;
  enqueuedDelete: number;
  unchanged: number;
  recoveredProcessing?: number;
  incomplete?: boolean;
}

interface Job {
  projectId: string;
  name: string;
  op: 'upsert' | 'delete';
  force?: boolean;
  enqueuedAt: number;
  reason: 'mutation' | 'reconcile' | 'crash_recovery' | 'late_recovery' | 'manual';
  attempt: number;
}

interface Queue {
  jobs: Job[];
  running: boolean;
  scheduled: boolean;
  activeKeys: Map<string, number>;
}

const _queues = new Map<string, Queue>();

export const projectLibraryEvents = new EventEmitter();
projectLibraryEvents.setMaxListeners(50);

function emit(ev: ProjectLibraryStatusEvent): void {
  projectLibraryEvents.emit('status', ev);
}

function safeProjectId(projectId: string): string {
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId required');
  if (projectId.includes('/') || projectId.includes('\\') || projectId.includes('\x00') || projectId === '.' || projectId === '..') {
    throw new Error('invalid projectId');
  }
  return projectId;
}

function safeFileName(name: string): string {
  if (typeof name !== 'string') throw new Error('filename required');
  const s = name.trim().replace(/\\/g, '/');
  if (!s || s === '.' || s === '..') throw new Error('invalid filename');
  if (s.includes('\x00') || s.startsWith('/') || path.isAbsolute(s)) {
    throw new Error('invalid filename');
  }
  const parts = s.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || part.length > MAX_PATH_SEGMENT_LEN)) {
    throw new Error('invalid filename');
  }
  return parts.join('/');
}

function resolveProjectFilePath(uid: string, projectId: string, relPath: string): string {
  const root = path.resolve(projectFilesDir(uid, projectId));
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
  return abs;
}

function kindFor(name: string): ProjectLibraryKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function storeFor(uid: string, projectId: string): vs.VecStore {
  const pid = safeProjectId(projectId);
  return vs.openVecStore(path.dirname(projectLibraryVectorDbPath(uid, pid)));
}

function queueFor(uid: string): Queue {
  let q = _queues.get(uid);
  if (!q) {
    q = { jobs: [], running: false, scheduled: false, activeKeys: new Map() };
    _queues.set(uid, q);
  }
  return q;
}

function retainActiveKey(q: Queue, key: string): void {
  q.activeKeys.set(key, (q.activeKeys.get(key) || 0) + 1);
}

function releaseActiveKey(q: Queue, key: string): void {
  const count = q.activeKeys.get(key) || 0;
  if (count <= 1) q.activeKeys.delete(key);
  else q.activeKeys.set(key, count - 1);
}

export function enqueue(
  uid: string,
  projectId: string,
  name: string,
  op: 'upsert' | 'delete' = 'upsert',
  opts: { force?: boolean; reason?: Job['reason']; attempt?: number } = {},
): void {
  let pid: string;
  let safeName: string;
  try {
    pid = safeProjectId(projectId);
    safeName = safeFileName(name);
  } catch { return; }
  if (op === 'upsert' && !kindFor(safeName)) return;
  const q = queueFor(uid);
  const existing = q.jobs.find((j) => j.projectId === pid && j.name === safeName && j.op === op);
  if (existing) {
    if (opts.force) existing.force = true;
    return;
  }
  q.jobs.push({
    projectId: pid,
    name: safeName,
    op,
    force: opts.force === true,
    enqueuedAt: Date.now(),
    reason: opts.reason || (opts.force ? 'manual' : 'mutation'),
    attempt: Math.max(1, Math.round(opts.attempt || 1)),
  });
  if (op === 'upsert') {
    const kind = kindFor(safeName);
    if (kind) emit({ userId: uid, projectId: pid, name: safeName, relPath: safeName, status: 'pending', kind });
  }
  scheduleRunQueue(uid);
}

function scheduleRunQueue(uid: string): void {
  const q = queueFor(uid);
  if (q.running || q.scheduled) return;
  q.scheduled = true;
  setImmediate(() => {
    q.scheduled = false;
    void runQueue(uid);
  });
}

async function runQueue(uid: string): Promise<void> {
  const q = queueFor(uid);
  if (q.running) return;
  q.running = true;
  const batch = createLibraryVectorizeBatch('project');
  try {
    while (q.jobs.length) {
      const job = q.jobs.shift()!;
      const key = jobKey(job.projectId, job.name);
      retainActiveKey(q, key);
      try {
        if (job.op === 'delete') await processDelete(uid, job.projectId, job.name);
        else await processUpsert(uid, job, batch);
      } catch (err) {
        log.warn('project library job failed unexpectedly', {
          user_id: maskId(uid),
          project_id: maskId(job.projectId),
          path: logPathRef(job.name),
          error: logErrorSummary(err),
        });
        await failUnexpectedJob(uid, job, err, batch);
      } finally {
        releaseActiveKey(q, key);
      }
    }
  } finally {
    q.running = false;
    const summary = flushLibraryVectorizeBatch(batch);
    if (summary) {
      log.info('project library vectorization batch complete', {
        user_id: maskId(uid),
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

function jobKey(projectId: string, name: string): string {
  return `${projectId}\x00${name}`;
}

async function processDelete(uid: string, projectId: string, name: string): Promise<void> {
  await storeFor(uid, projectId).deleteFile(name);
  emit({ userId: uid, projectId, name, relPath: name, status: 'deleted' });
}

async function processUpsert(
  uid: string,
  job: Job,
  batch: LibraryVectorizeBatch,
): Promise<void> {
  const { projectId, name } = job;
  const force = job.force === true;
  const startedAt = Date.now();
  const kind = kindFor(name);
  if (!kind) return;

  const store = storeFor(uid, projectId);
  const abs = resolveProjectFilePath(uid, projectId, name);
  let stat: fs.Stats;
  try { stat = await fsp.stat(abs); }
  catch {
    await store.deleteFile(name);
    emit({ userId: uid, projectId, name, relPath: name, status: 'deleted', kind });
    return;
  }
  if (!stat.isFile()) {
    await store.deleteFile(name);
    emit({ userId: uid, projectId, name, relPath: name, status: 'deleted', kind });
    return;
  }

  const buf = await fsp.readFile(abs);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const existing = store.getFile(name);
  if (!force && existing && existing.sha1 === sha1 && existing.status === 'ready') {
    emit({ userId: uid, projectId, name, relPath: name, status: 'ready', kind, chunks: existing.chunks });
    return;
  }

  const isEmpty = stat.size === 0 || (kind === 'text' && buf.toString('utf8').trim() === '');
  if (isEmpty) {
    await store.upsertFile({
      id: name,
      kind,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      chunks: [],
    });
    emit({ userId: uid, projectId, name, relPath: name, status: 'ready', kind, chunks: 0, stage: 'persist' });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'success', stage: 'persist', chunks: 0,
    });
    log.debug('skipped empty project library file', {
      user_id: maskId(uid),
      project_id: maskId(projectId),
      path: logPathRef(name),
      kind,
    });
    return;
  }

  await store.setFileStatus(name, 'processing', {
    kind,
    bytes: stat.size,
    mtime: stat.mtimeMs / 1000,
    sha1,
  });
  emit({ userId: uid, projectId, name, relPath: name, status: 'processing', kind, stage: 'extract' });

  let currentStage: 'extract' | 'embed' | 'persist' = 'extract';
  try {
    const extractOperation = fileToChunks({
      kind,
      buf,
      imageTitle: name,
      ...(kind === 'image' ? { imageDescriber: (b: Buffer) => describeImage(uid, name, b) } : {}),
    });
    const chunks = await withOperationTimeout(extractOperation, {
      timeoutMs: EXTRACT_TIMEOUT_MS,
      code: 'E_LIBRARY_EXTRACT_TIMEOUT',
      stage: 'extract',
      onLateSettlement: (late) => scheduleLateRecovery(uid, job, sha1, late, 'extract'),
    });
    if (!chunks.length) throw Object.assign(new Error('fileToChunks returned zero chunks'), { stage: 'extract' });

    currentStage = 'embed';
    emit({ userId: uid, projectId, name, relPath: name, status: 'processing', kind, stage: 'embed' });
    const embedOperation = kbEmbed.embedTexts(chunks.map((chunk) => chunk.content));
    const vectors = await withOperationTimeout(embedOperation, {
      timeoutMs: EMBED_TIMEOUT_MS,
      code: 'E_LIBRARY_EMBED_TIMEOUT',
      stage: 'embed',
      onLateSettlement: (late) => scheduleLateRecovery(uid, job, sha1, late, 'embed'),
    });
    currentStage = 'persist';
    await store.upsertFile({
      id: name,
      kind,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      chunks: chunks.map((chunk, index) => ({
        title: chunk.title,
        content: chunk.content,
        embedding: vectors[index],
      })),
    });
    emit({ userId: uid, projectId, name, relPath: name, status: 'ready', kind, chunks: chunks.length, stage: 'persist' });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'success', stage: 'persist', chunks: chunks.length,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const stage = err instanceof OperationTimeoutError
      ? (err.stage as 'extract' | 'embed')
      : currentStage;
    const errorCode = operationErrorCode(
      err,
      stage === 'extract'
        ? 'E_LIBRARY_EXTRACT_FAILED'
        : stage === 'embed'
          ? 'E_LIBRARY_EMBED_FAILED'
          : 'E_LIBRARY_PERSIST_FAILED',
    );
    await store.setFileStatus(name, 'failed', { error: msg });
    emit({ userId: uid, projectId, name, relPath: name, status: 'failed', kind, error: msg, stage, errorCode });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'failure', stage, errorCode,
    });
    log.warn('project library vectorization failed', {
      user_id: maskId(uid),
      project_id: maskId(projectId),
      path: logPathRef(name),
      kind,
      stage,
      error_code: errorCode,
      error: logErrorSummary(err),
      duration_ms: Date.now() - startedAt,
      queue_wait_ms: startedAt - job.enqueuedAt,
      attempt: job.attempt,
    });
  }
}

function recordVectorizeResult(
  batch: LibraryVectorizeBatch,
  job: Job,
  startedAt: number,
  terminal: {
    result: 'success' | 'failure';
    stage: 'extract' | 'embed' | 'persist';
    chunks?: number;
    errorCode?: string;
  },
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

function scheduleLateRecovery<T>(
  uid: string,
  job: Job,
  expectedSha1: string,
  late: Promise<T>,
  stage: 'extract' | 'embed',
): void {
  const queue = queueFor(uid);
  const key = jobKey(job.projectId, job.name);
  retainActiveKey(queue, key);
  void late.then(() => {
    if (job.attempt >= 2) return;
    const row = storeFor(uid, job.projectId).getFile(job.name);
    if (!row || row.status !== 'failed' || row.sha1 !== expectedSha1) return;
    log.info('timed-out project library operation settled; scheduling one recovery attempt', {
      user_id: maskId(uid),
      project_id: maskId(job.projectId),
      path: logPathRef(job.name),
      stage,
      attempt: job.attempt + 1,
    });
    enqueue(uid, job.projectId, job.name, 'upsert', {
      reason: 'late_recovery',
      attempt: job.attempt + 1,
    });
  }).catch((err) => {
    log.info('timed-out project library operation eventually failed', {
      user_id: maskId(uid),
      project_id: maskId(job.projectId),
      path: logPathRef(job.name),
      stage,
      error: logErrorSummary(err),
    });
  }).finally(() => {
    releaseActiveKey(queue, key);
  });
}

async function failUnexpectedJob(
  uid: string,
  job: Job,
  err: unknown,
  batch: LibraryVectorizeBatch,
): Promise<void> {
  if (job.op !== 'upsert') return;
  const store = storeFor(uid, job.projectId);
  const row = store.getFile(job.name);
  const kind = kindFor(job.name) || row?.kind;
  const msg = (err as Error)?.message || String(err);
  const errorCode = operationErrorCode(err, 'E_LIBRARY_JOB_FAILED');
  try { await store.setFileStatus(job.name, 'failed', { error: msg }); }
  catch { /* primary log already records the storage failure */ }
  emit({
    userId: uid,
    projectId: job.projectId,
    name: job.name,
    relPath: job.name,
    status: 'failed',
    error: msg,
    ...(kind ? { kind } : {}),
    stage: 'queue',
    errorCode,
  });
  if (kind) {
    recordVectorizeResult(batch, job, Date.now(), {
      result: 'failure', stage: 'persist', errorCode,
    });
  }
}

async function describeImage(userId: string, sourceName: string, raw: Buffer): Promise<string> {
  return describeLibraryImage(userId, sourceName, raw, { sessionPrefix: 'extract-img-project' });
}

export async function reconcile(uid: string, projectId: string): Promise<ProjectLibraryReconcileResult> {
  const startedAt = Date.now();
  const pid = safeProjectId(projectId);
  if (!await projectExists(uid, pid)) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };

  const root = projectFilesDir(uid, pid);
  const store = storeFor(uid, pid);
  const indexedRows = store.listFiles();
  const indexedByPath = new Map(indexedRows.map((row) => [row.rel_path, row]));
  const scan = await scanProjectFiles(root, indexedByPath);
  const onDisk = scan.files;
  let enqueuedUpsert = 0;
  let enqueuedDelete = 0;
  let unchanged = 0;
  let recoveredProcessing = 0;
  const queue = queueFor(uid);

  for (const [name, meta] of onDisk) {
    const existing = indexedByPath.get(name);
    const key = jobKey(pid, name);
    const ownedByQueue = queue.activeKeys.has(key)
      || queue.jobs.some((job) => jobKey(job.projectId, job.name) === key);
    const orphanedProcessing = existing?.status === 'processing'
      && !ownedByQueue;
    if (
      !existing
      || existing.sha1 !== meta.sha1
      || (!ownedByQueue && (existing.status === 'failed' || existing.status === 'pending'))
      || orphanedProcessing
    ) {
      if (orphanedProcessing && existing) {
        recoveredProcessing += 1;
        await store.setFileStatus(name, 'pending', { error: null });
        log.warn('recovered orphaned processing project library row', {
          user_id: maskId(uid),
          project_id: maskId(pid),
          path: logPathRef(name),
          stale_ms: Math.max(0, Date.now() - existing.updated_at * 1000),
        });
      }
      enqueue(uid, pid, name, 'upsert', {
        reason: orphanedProcessing ? 'crash_recovery' : 'reconcile',
      });
      enqueuedUpsert += 1;
    } else {
      unchanged += 1;
    }
  }

  if (scan.complete) {
    for (const row of indexedRows) {
      if (!onDisk.has(row.rel_path)) {
        enqueue(uid, pid, row.rel_path, 'delete');
        enqueuedDelete += 1;
      }
    }
  } else {
    log.warn('project library reconcile snapshot incomplete; skipped destructive deletes', {
      user_id: maskId(uid),
      project_id: maskId(pid),
      discovered: onDisk.size,
      duration_ms: Date.now() - startedAt,
    });
  }

  if (enqueuedUpsert || enqueuedDelete) {
    log.info('project library reconcile queued work', {
      user_id: maskId(uid),
      project_id: maskId(pid),
      upsert: enqueuedUpsert,
      delete: enqueuedDelete,
      unchanged,
      recovered_processing: recoveredProcessing,
      duration_ms: Date.now() - startedAt,
    });
  }
  return {
    enqueuedUpsert,
    enqueuedDelete,
    unchanged,
    recoveredProcessing,
    ...(!scan.complete ? { incomplete: true } : {}),
  };
}

async function scanProjectFiles(
  root: string,
  indexedByPath: ReadonlyMap<string, vs.VecFileRow>,
): Promise<{
  files: Map<string, { sha1: string; bytes: number; mtime: number }>;
  complete: boolean;
}> {
  const out = new Map<string, { sha1: string; bytes: number; mtime: number }>();
  const stack = [root];
  let complete = true;
  while (stack.length) {
    const dir = stack.pop()!;
    let items: fs.Dirent[];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      continue;
    }
    for (const entry of items) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!kindFor(rel)) continue;
      try {
        const stat = await fsp.stat(abs);
        const mtime = stat.mtimeMs / 1000;
        const existing = indexedByPath.get(rel);
        if (
          existing?.sha1
          && existing.bytes === stat.size
          && Math.abs(existing.mtime - mtime) < 0.001
        ) {
          out.set(rel, { sha1: existing.sha1, bytes: stat.size, mtime });
          continue;
        }
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(abs);
        for await (const chunk of stream) hash.update(chunk as Buffer);
        out.set(rel, { sha1: hash.digest('hex'), bytes: stat.size, mtime });
      } catch (err) {
        // A disappearing file is a valid absence. Permission and transient I/O
        // failures make the snapshot unsafe for delete decisions.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      }
    }
  }
  return { files: out, complete };
}

export async function search(
  uid: string,
  projectId: string,
  queryVec: number[] | Float32Array,
  opts: vs.VecSearchOpts = {},
): Promise<vs.VecSearchHit[]> {
  await reconcile(uid, projectId);
  return storeFor(uid, projectId).search(queryVec, opts);
}

export function getFileByPath(uid: string, projectId: string, relPath: string): vs.VecFileRow | null {
  return storeFor(uid, projectId).getFile(relPath);
}

export function listFiles(uid: string, projectId: string): vs.VecFileRow[] {
  return storeFor(uid, projectId).listFiles();
}

export function readFileChunks(uid: string, projectId: string, relPath: string): Array<{ chunk_idx: number; title: string | null; content: string }> {
  return storeFor(uid, projectId).readFileChunks(relPath);
}

export function statusSummary(uid: string, projectId: string): { total: number; ready: number; processing: number; pending: number; failed: number } {
  return storeFor(uid, projectId).statusSummary();
}

export async function drain(uid: string): Promise<void> {
  const q = queueFor(uid);
  while (q.scheduled || q.running || q.jobs.length) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function _resetQueuesForTests(): void {
  _queues.clear();
  projectLibraryEvents.removeAllListeners();
  projectLibraryEvents.setMaxListeners(50);
}
