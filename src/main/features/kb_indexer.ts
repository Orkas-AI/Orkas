/**
 * Knowledge-base indexer: processing queue + reconcile + status broadcast.
 *
 * Responsibilities:
 *   1. Watch for user-triggered mutations (upload / delete / rename) via
 *      explicit `enqueue()` calls from `contexts.ts` IPC handlers.
 *   2. For each queued file: extract text → embed → upsert into `kb_vector`.
 *   3. Reconcile on startup / after sync-driven vector.db replacements: diff
 *      disk vs `kb_files` table, enqueue missing / changed / orphaned.
 *   4. Emit `status` events via `kbEvents` so IPC → renderer can update UI
 *      chips without polling.
 *
 * Concurrency: one worker per uid (serial processing). Embedding calls are
 * CPU-bound + the ONNX session is single-threaded, so parallelism here would
 * thrash cache without speedup. Cross-uid parallelism is allowed (future
 * multi-uid) but not relied upon.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { userContextsDir } from '../paths';
import { createLogger } from '../logger';
import { fileToChunks } from '../util/file_to_chunks';
import { logErrorRef, logPathRef, maskId } from '../util/log-redact';
import { describeLibraryImage } from './library_image_describer';

import * as kb from './kb_vector';
import * as kbEmbed from './kb_embed';

const log = createLogger('kb_indexer');

/**
 * Embedding chunk budget. Kept well under bge-small-zh-v1.5's 512-token window
 * (roughly 1 token per Chinese char + subword expansion for Latin), so the
 * embedder actually sees the full chunk content rather than silently truncating.
 * Small chunks also sharpen retrieval — the produced vector represents one idea,
 * not a diluted average. Callers wanting wider LLM context should `kb_read(path,
 * chunk, window)` to pull neighbouring chunks back together at answer time.
 */
export const EMBED_MAX_CHARS = 400;
/** Char overlap applied only within a single paragraph when we have to split it
 *  at sentence boundaries — preserves local context across the cut. Cross-
 *  paragraph chunks don't overlap (different topics shouldn't bleed). */
export const EMBED_OVERLAP = 50;

/** Files this indexer knows how to vectorize. Filenames not in this list are
 *  silently skipped by reconcile (e.g. `_INDEX.md` stays outside KB). */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log']);
for (const ext of [
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]) TEXT_EXTS.add(ext);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function kindFor(name: string): kb.KbKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

// ── Events ──────────────────────────────────────────────────────────────

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
}

/** Listeners subscribe via `kbEvents.on('status', fn)`. IPC layer bridges to
 *  renderer via a stream channel. */
export const kbEvents = new EventEmitter();
// A single indexer can fan out to many renderer windows + internal listeners;
// Node's default maxListeners=10 triggers spurious warnings.
kbEvents.setMaxListeners(50);

function emit(ev: KbStatusEvent): void {
  kbEvents.emit('status', ev);
}

// ── Queue ───────────────────────────────────────────────────────────────

interface Job {
  relPath: string;
  op: 'upsert' | 'delete';
}

interface Queue {
  jobs: Job[];
  running: boolean;
  scheduled: boolean;
}

const _queues = new Map<string, Queue>();

function getQueue(uid: string): Queue {
  let q = _queues.get(uid);
  if (!q) {
    q = { jobs: [], running: false, scheduled: false };
    _queues.set(uid, q);
  }
  return q;
}

/** Enqueue a single file for processing. `op='delete'` drops the row from
 *  `kb_files` + cascades its chunks/vectors; `op='upsert'` reads from disk
 *  and (re-)vectorizes. Safe to call multiple times — dedup is by (path, op). */
export function enqueue(uid: string, relPath: string, op: 'upsert' | 'delete' = 'upsert'): void {
  const q = getQueue(uid);
  // Dedup: if same (path, op) already pending, skip. If a deletion is queued
  // and an upsert arrives (or vice-versa), keep both in order — the later op
  // wins naturally.
  if (q.jobs.some((j) => j.relPath === relPath && j.op === op)) return;
  q.jobs.push({ relPath, op });
  if (op === 'upsert') emit({ userId: uid, relPath, status: 'pending' });
  scheduleRunQueue(uid);
}

function scheduleRunQueue(uid: string): void {
  const q = getQueue(uid);
  if (q.running || q.scheduled) return;
  q.scheduled = true;
  setImmediate(() => {
    q.scheduled = false;
    void runQueue(uid);
  });
}

/**
 * Pipelined two-stage worker: extract (foreground, one file at a time) hands
 * off to embed+upsert (background chain). Next file's extraction can overlap
 * the previous file's embedding — so a big PDF no longer stalls small text
 * files queued behind it. ONNX is single-threaded, so embeds themselves stay
 * serial on the chain; that's fine — the win is extract/embed overlap.
 */
async function runQueue(uid: string): Promise<void> {
  const q = getQueue(uid);
  if (q.running) return;
  q.running = true;
  let chain: Promise<void> = Promise.resolve();
  try {
    while (true) {
      while (q.jobs.length) {
        const job = q.jobs.shift()!;
        if (job.op === 'delete') {
          // Serialise deletes behind any pending upsert to preserve FS ↔ DB order.
          chain = chain.then(() => processDelete(uid, job.relPath))
            .catch((err) => log.warn('delete failed', {
              user_id: maskId(uid),
              path: logPathRef(job.relPath),
              error: logErrorRef(err),
            }));
          continue;
        }
        let extract: ExtractResult | null = null;
        try { extract = await prepareAndExtract(uid, job.relPath); }
        catch (err) {
          log.warn('extract failed', {
            user_id: maskId(uid),
            path: logPathRef(job.relPath),
            error: logErrorRef(err),
          });
          continue;
        }
        if (!extract) continue;
        const ex = extract;
        chain = chain.then(() => embedAndUpsert(uid, ex))
          .catch((err) => log.warn('embed failed', {
            user_id: maskId(uid),
            path: logPathRef(ex.relPath),
            error: logErrorRef(err),
          }));
      }
      // Drain the in-flight chain; new jobs may land during the drain (user
      // upload, reconcile enqueue), so re-check q.jobs after and loop back.
      await chain;
      chain = Promise.resolve();
      if (!q.jobs.length) break;
    }
  } finally {
    q.running = false;
  }
}

// ── Job processing ──────────────────────────────────────────────────────

interface ExtractResult {
  relPath: string;
  kind: kb.KbKind;
  bytes: number;
  mtime: number;
  sha1: string;
  chunks: PreChunk[];
}

/** Foreground stage: stat + hash + cache check + extract chunks. Returns null
 *  when embedding should be skipped (delete-on-gone, cache hit, unsupported,
 *  or extract failure — each handled with appropriate emit + status write). */
async function prepareAndExtract(uid: string, relPath: string): Promise<ExtractResult | null> {
  const root = userContextsDir(uid);
  const abs = path.join(root, relPath);

  const kind = kindFor(relPath);
  if (!kind) {
    log.warn('skipping unsupported library file', { user_id: maskId(uid), path: logPathRef(relPath) });
    return null;
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch {
    // Disk deleted it between enqueue and processing — treat as delete.
    await kb.deleteFile(uid, relPath);
    emit({ userId: uid, relPath, status: 'deleted' });
    return null;
  }

  const buf = fs.readFileSync(abs);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');

  // Cache-hit: identical content, already marked ready → skip re-embed.
  const existing = kb.getFileByPath(uid, relPath);
  if (existing && existing.sha1 === sha1 && existing.status === 'ready') return null;

  // Empty content short-circuit: no point embedding nothing (the embedder can
  // hang or produce a useless zero-content vector). Mark the file ready with
  // zero chunks so the UI shows "done" rather than a permanent spinner; it'll
  // be picked up normally once the user adds content (sha1 changes → enqueue).
  const isEmpty = stat.size === 0
    || (kind === 'text' && buf.toString('utf8').trim() === '');
  if (isEmpty) {
    await kb.upsertFile(uid, {
      relPath,
      kind,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      chunks: [],
    });
    emit({ userId: uid, relPath, status: 'ready', kind, chunks: 0 });
    log.info('skipped empty library file', { user_id: maskId(uid), path: logPathRef(relPath), kind });
    return null;
  }

  await kb.setFileStatus(uid, relPath, 'processing', {
    kind, bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1,
  });
  emit({ userId: uid, relPath, status: 'processing', kind });

  try {
    const chunks = await extractChunks(uid, relPath, buf, kind);
    if (!chunks.length) throw new Error('extraction returned zero chunks');
    return { relPath, kind, bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1, chunks };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn('extract failed', { user_id: maskId(uid), path: logPathRef(relPath), kind, error: logErrorRef(err) });
    await kb.setFileStatus(uid, relPath, 'failed', { error: msg });
    emit({ userId: uid, relPath, status: 'failed', error: msg, kind });
    return null;
  }
}

/** Background stage: embed chunks + atomic upsert. Runs on the chain so only
 *  one embed is in flight at a time (ONNX session is single-threaded). */
async function embedAndUpsert(uid: string, ex: ExtractResult): Promise<void> {
  try {
    const vectors = await kbEmbed.embedTexts(ex.chunks.map((c) => c.content));
    await kb.upsertFile(uid, {
      relPath: ex.relPath,
      kind: ex.kind,
      bytes: ex.bytes,
      mtime: ex.mtime,
      sha1: ex.sha1,
      chunks: ex.chunks.map((c, i) => ({
        title: c.title, content: c.content, embedding: vectors[i],
      })),
    });
    emit({ userId: uid, relPath: ex.relPath, status: 'ready', kind: ex.kind, chunks: ex.chunks.length });
    log.info('vectorized library file', {
      user_id: maskId(uid),
      path: logPathRef(ex.relPath),
      kind: ex.kind,
      chunks: ex.chunks.length,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn('embed failed', { user_id: maskId(uid), path: logPathRef(ex.relPath), kind: ex.kind, error: logErrorRef(err) });
    await kb.setFileStatus(uid, ex.relPath, 'failed', { error: msg });
    emit({ userId: uid, relPath: ex.relPath, status: 'failed', error: msg, kind: ex.kind });
  }
}

async function processDelete(uid: string, relPath: string): Promise<void> {
  await kb.deleteFile(uid, relPath);
  emit({ userId: uid, relPath, status: 'deleted' });
}

// ── Extraction (per-kind) ────────────────────────────────────────────────

interface PreChunk { title: string; content: string }

async function extractChunks(uid: string, relPath: string, buf: Buffer, kind: kb.KbKind): Promise<PreChunk[]> {
  // Delegate to the generic chunker; inject the KB-specific image describer
  // so vision calls flow through this user's chatWithModel session.
  return fileToChunks({
    kind,
    buf,
    maxChars: EMBED_MAX_CHARS,
    overlap: EMBED_OVERLAP,
    imageTitle: path.basename(relPath),
    imageDescriber: (b) => describeImage(uid, path.basename(relPath), b),
  });
}

async function describeImage(userId: string, sourceName: string, raw: Buffer): Promise<string> {
  return describeLibraryImage(userId, sourceName, raw, { sessionPrefix: 'extract-img' });
}

// ── Reconcile ───────────────────────────────────────────────────────────

export interface ReconcileResult {
  enqueuedUpsert: number;
  enqueuedDelete: number;
  unchanged: number;
}

/**
 * Walk `<uid>/cloud/contexts/**` and diff against `kb_files`. Enqueue upsert
 * for new / changed / previously-failed files; enqueue delete for rows whose
 * source has disappeared from disk. Safe to call anytime — idempotent.
 *
 * Skipped from the walk: dot-prefixed entries (e.g. `.kb/`), the root-level
 * `_INDEX.md`, and any filename whose extension is not in the supported set.
 */
export async function reconcile(uid: string): Promise<ReconcileResult> {
  const root = userContextsDir(uid);
  fs.mkdirSync(root, { recursive: true });

  const onDisk = walk(root, '');
  let enqueuedUpsert = 0;
  let enqueuedDelete = 0;
  let unchanged = 0;

  for (const [relPath, meta] of onDisk) {
    const existing = kb.getFileByPath(uid, relPath);
    const needsWork =
      !existing ||
      existing.sha1 !== meta.sha1 ||
      existing.status === 'failed' ||
      existing.status === 'pending';
    if (needsWork) {
      enqueue(uid, relPath, 'upsert');
      enqueuedUpsert += 1;
    } else {
      unchanged += 1;
    }
  }

  for (const row of kb.listFiles(uid)) {
    if (!onDisk.has(row.rel_path)) {
      enqueue(uid, row.rel_path, 'delete');
      enqueuedDelete += 1;
    }
  }

  if (enqueuedUpsert || enqueuedDelete) {
    log.info('library reconcile queued work', {
      user_id: maskId(uid),
      upsert: enqueuedUpsert,
      delete: enqueuedDelete,
      unchanged,
    });
  }
  return { enqueuedUpsert, enqueuedDelete, unchanged };
}

function walk(root: string, rel: string): Map<string, { kind: kb.KbKind; sha1: string; bytes: number; mtime: number }> {
  const out = new Map<string, { kind: kb.KbKind; sha1: string; bytes: number; mtime: number }>();
  const stack: string[] = [rel];
  while (stack.length) {
    const cur = stack.pop()!;
    const abs = cur ? path.join(root, cur) : root;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { continue; }
    for (const e of items) {
      // `.kb/` (vector DB), `.organize-snapshots/`, `.organize-state.json`, DS_Store — all hidden.
      if (e.name.startsWith('.')) continue;
      // Root-level `_INDEX.md` is generated for human browsing, not KB content.
      // Subdir `_INDEX.md` files are legacy (pre-kb-vector) — also skip.
      if (e.name === '_INDEX.md') continue;
      const r = cur ? `${cur}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) { stack.push(r); continue; }
      if (!e.isFile()) continue;
      const kind = kindFor(e.name);
      if (!kind) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      // Read + hash — for typical KB sizes (≤ 100s of MB total) this is fast
      // and avoids the "mtime only" false-negative when a file is touched but
      // content is unchanged.
      let buf: Buffer;
      try { buf = fs.readFileSync(full); } catch { continue; }
      const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
      out.set(r, { kind, sha1, bytes: st.size, mtime: st.mtimeMs / 1000 });
    }
  }
  return out;
}

// ── Test hooks ──────────────────────────────────────────────────────────

/** Await all queued work for a uid. Used in tests to serialize "enqueue then
 *  assert". Returns once the queue is empty AND the worker is idle. */
export async function drain(uid: string): Promise<void> {
  const q = getQueue(uid);
  // Poll every 10ms; jobs resolve fast in tests (mocked embed).
  while (q.scheduled || q.running || q.jobs.length) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Reset all in-memory queue state. Tests use this between runs. */
export function _resetQueuesForTests(): void {
  _queues.clear();
  kbEvents.removeAllListeners();
  kbEvents.setMaxListeners(50);
}
