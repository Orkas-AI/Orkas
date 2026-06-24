/**
 * Project-scoped Library vector index.
 *
 * Project Library source files live under `<uid>/cloud/projects/<pid>/files/`.
 * The derived vector store is machine-local under `<uid>/local/projects/<pid>/`
 * so project assets can sync independently from embeddings, mirroring the
 * global Library/KB design.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { projectFilesDir, projectLibraryVectorDbPath } from '../paths';
import { createLogger } from '../logger';
import type { ChunkableKind } from '../util/file_to_chunks';
import { describeLibraryImage } from './library_image_describer';

import * as vs from './vec_store';
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
}

export interface ProjectLibraryReconcileResult {
  enqueuedUpsert: number;
  enqueuedDelete: number;
  unchanged: number;
}

interface Job {
  projectId: string;
  name: string;
  op: 'upsert' | 'delete';
  force?: boolean;
}

interface Queue {
  jobs: Job[];
  running: boolean;
  scheduled: boolean;
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
    q = { jobs: [], running: false, scheduled: false };
    _queues.set(uid, q);
  }
  return q;
}

export function enqueue(
  uid: string,
  projectId: string,
  name: string,
  op: 'upsert' | 'delete' = 'upsert',
  opts: { force?: boolean } = {},
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
  q.jobs.push({ projectId: pid, name: safeName, op, force: opts.force === true });
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
  try {
    while (q.jobs.length) {
      const job = q.jobs.shift()!;
      try {
        if (job.op === 'delete') await processDelete(uid, job.projectId, job.name);
        else await processUpsert(uid, job.projectId, job.name, job.force === true);
      } catch (err) {
        log.warn(`job uid=${uid} pid=${job.projectId} name=${job.name}: ${(err as Error).message}`);
      }
    }
  } finally {
    q.running = false;
  }
}

async function processDelete(uid: string, projectId: string, name: string): Promise<void> {
  await storeFor(uid, projectId).deleteFile(name);
  emit({ userId: uid, projectId, name, relPath: name, status: 'deleted' });
}

async function processUpsert(uid: string, projectId: string, name: string, force = false): Promise<void> {
  const kind = kindFor(name);
  if (!kind) return;

  const store = storeFor(uid, projectId);
  const abs = resolveProjectFilePath(uid, projectId, name);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
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

  const buf = fs.readFileSync(abs);
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
    emit({ userId: uid, projectId, name, relPath: name, status: 'ready', kind, chunks: 0 });
    log.info(`skipped empty uid=${uid} pid=${projectId} name=${name}`);
    return;
  }

  await store.setFileStatus(name, 'processing', {
    kind,
    bytes: stat.size,
    mtime: stat.mtimeMs / 1000,
    sha1,
  });
  emit({ userId: uid, projectId, name, relPath: name, status: 'processing', kind });

  try {
    const chunks = await store.vectorize(name, {
      kind,
      buf,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      imageTitle: name,
      ...(kind === 'image' ? { imageDescriber: (b: Buffer) => describeImage(uid, name, b) } : {}),
    });
    emit({ userId: uid, projectId, name, relPath: name, status: 'ready', kind, chunks });
    log.info(`vectorized uid=${uid} pid=${projectId} name=${name} kind=${kind} chunks=${chunks}`);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    await store.setFileStatus(name, 'failed', { error: msg });
    emit({ userId: uid, projectId, name, relPath: name, status: 'failed', kind, error: msg });
    log.warn(`vectorize uid=${uid} pid=${projectId} name=${name}: ${msg}`);
  }
}

async function describeImage(userId: string, sourceName: string, raw: Buffer): Promise<string> {
  return describeLibraryImage(userId, sourceName, raw, { sessionPrefix: 'extract-img-project' });
}

export async function reconcile(uid: string, projectId: string): Promise<ProjectLibraryReconcileResult> {
  const pid = safeProjectId(projectId);
  if (!await projectExists(uid, pid)) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };

  const root = projectFilesDir(uid, pid);
  const onDisk = new Map<string, { sha1: string }>();
  const walk = (dir: string): void => {
    let items: fs.Dirent[] = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of items) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!kindFor(rel)) continue;
      let buf: Buffer;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      onDisk.set(rel, { sha1: crypto.createHash('sha1').update(buf).digest('hex') });
    }
  };
  walk(root);

  const store = storeFor(uid, pid);
  let enqueuedUpsert = 0;
  let enqueuedDelete = 0;
  let unchanged = 0;

  for (const [name, meta] of onDisk) {
    const existing = store.getFile(name);
    if (!existing || existing.sha1 !== meta.sha1 || existing.status === 'failed' || existing.status === 'pending') {
      enqueue(uid, pid, name, 'upsert');
      enqueuedUpsert += 1;
    } else {
      unchanged += 1;
    }
  }

  for (const row of store.listFiles()) {
    if (!onDisk.has(row.rel_path)) {
      enqueue(uid, pid, row.rel_path, 'delete');
      enqueuedDelete += 1;
    }
  }

  if (enqueuedUpsert || enqueuedDelete) {
    log.info(`reconcile uid=${uid} pid=${pid} upsert=${enqueuedUpsert} delete=${enqueuedDelete} unchanged=${unchanged}`);
  }
  return { enqueuedUpsert, enqueuedDelete, unchanged };
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
