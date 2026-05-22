/**
 * Per-conversation file attachments for main chat (`normal`).
 * Layout: `data/<uid>/cloud/chat_attachments/<cid>/`.
 *
 * Supported kinds — mirrors `contexts` upload whitelist:
 *   text   — .md / .markdown / .txt / .csv / .tsv / .json / .yaml / .yml / .log
 *   pdf    — .pdf
 *   docx   — .docx
 *   image  — .png / .jpg / .jpeg / .webp / .gif
 *   video  — .mp4 / .webm / .mov / .m4v / .ogv (display-only, not sent to
 *            the model; bytes streamed to the renderer via the
 *            `chat-media://` protocol)
 *
 * Lifecycle:
 *   uploadAttachment   — write original to disk; NO preprocessing. PDF/DOCX
 *                        extract + image grayscale happen lazily on read via
 *                        features/file_indexer (which caches under
 *                        <uid>/local/file_cache/<hash>/). Video is kept raw
 *                        and never cached.
 *   deleteAttachment   — remove original + invalidate its file_cache entry
 *   purgeByCid         — wipe the whole <cid>/ dir + drop all cache entries
 *                        tagged with this cid (called from
 *                        chats.deleteConversation)
 *   buildAttachmentManifest — produce (manifest XML + images) tuple for the
 *                              model; images are compressed in real time on
 *                              every turn (no cached preview sibling); video
 *                              entries are skipped entirely (model can't see
 *                              them — display-only).
 *   resolveAttachmentAbsPath — pure helper used by the `chat-media://`
 *                              protocol handler; validates inputs and
 *                              enforces "abs path stays inside <cid>/"
 *
 * Size caps and extension whitelists align with `features/contexts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { chatAttachmentDir, userChatAttachmentsDir, userChatsDir } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { toCompressedGrayJpeg } from '../util/image-transform';
import {
  invalidateFileCache,
  purgeFileCacheByCid,
  statFile,
  getCachedMeta,
} from './file_indexer';

const log = createLogger('chat_attachments');

// ── Whitelists & caps (aligned with features/contexts) ────────────────────

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const PDF_EXT = '.pdf';
const DOCX_EXT = '.docx';
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS, PDF_EXT, DOCX_EXT, ...IMAGE_EXTS, ...VIDEO_EXTS,
]);

const MAX_BYTES_TEXT  = 5   * 1024 * 1024;
const MAX_BYTES_DOCX  = 20  * 1024 * 1024;
const MAX_BYTES_IMAGE = 20  * 1024 * 1024;
const MAX_BYTES_PDF   = 100 * 1024 * 1024;
const MAX_BYTES_VIDEO = 200 * 1024 * 1024;

const MAX_FILENAME_LEN = 200;

// ── Types ────────────────────────────────────────────────────────────────

export type AttachmentKind = 'text' | 'pdf' | 'docx' | 'image' | 'video';
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface AttachmentInfo {
  name: string;
  bytes: number;
  kind: AttachmentKind;
  mtime: number;      // epoch seconds
}

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

// ── Helpers ──────────────────────────────────────────────────────────────

function safeAttachmentName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('filename required');
  const s = name.trim();
  if (!s || s === '.' || s === '..') throw new Error('invalid filename');
  if (s.includes('/') || s.includes('\\') || s.includes('\x00')) {
    throw new Error('filename must not contain path separators');
  }
  if (s.startsWith('.')) throw new Error("filename must not start with '.'");
  if (s.length > MAX_FILENAME_LEN) throw new Error('filename too long');
  const ext = path.extname(s).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(t('errors.unsupported_file_ext', { ext: ext || t('errors.unsupported_file_no_ext') }));
  }
  return s;
}

function safeCid(cid: unknown): string {
  if (typeof cid !== 'string' || !cid) throw new Error('cid required');
  if (cid.includes('/') || cid.includes('\\') || cid.includes('\x00') || cid === '.' || cid === '..') {
    throw new Error('invalid cid');
  }
  return cid;
}

function kindOf(ext: string): AttachmentKind {
  const e = ext.toLowerCase();
  if (e === PDF_EXT) return 'pdf';
  if (e === DOCX_EXT) return 'docx';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  return 'text';
}

function maxBytesFor(ext: string): number {
  const e = ext.toLowerCase();
  if (e === PDF_EXT) return MAX_BYTES_PDF;
  if (e === DOCX_EXT) return MAX_BYTES_DOCX;
  if (IMAGE_EXTS.has(e)) return MAX_BYTES_IMAGE;
  if (VIDEO_EXTS.has(e)) return MAX_BYTES_VIDEO;
  return MAX_BYTES_TEXT;
}

function ensureDir(userId: string, cid: string): string {
  const dir = chatAttachmentDir(userId, cid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueTarget(dir: string, name: string): string {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.join(dir, `${stem}-${stamp}${ext}`);
}

const attachmentWriteLocks = new Map<string, Promise<void>>();

async function withAttachmentWriteLock<T>(
  userId: string,
  cid: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = JSON.stringify([userId, cid]);
  const prev = attachmentWriteLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  attachmentWriteLocks.set(key, current);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (attachmentWriteLocks.get(key) === current) {
      attachmentWriteLocks.delete(key);
    }
  }
}

function attachmentInfoForPath(absPath: string, name = path.basename(absPath)): AttachmentInfo | null {
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return null; }
  if (!st.isFile()) return null;
  return {
    name,
    bytes: st.size,
    kind: kindOf(ext),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('data', (chunk) => h.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function findDuplicateByHash(
  dir: string,
  bytes: number,
  sha256: string,
): Promise<AttachmentInfo | null> {
  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const e of items) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    const abs = path.join(dir, e.name);
    let st: fs.Stats;
    try { st = fs.statSync(abs); }
    catch { continue; }
    if (st.size !== bytes) continue;
    try {
      if (await hashFile(abs) === sha256) {
        return attachmentInfoForPath(abs, e.name);
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function uploadAttachment(
  userId: string,
  cid: string,
  name: string,
  raw: Buffer | Uint8Array | null | undefined,
): Promise<Result<{ info: AttachmentInfo; reused?: boolean }>> {
  let safeName: string;
  let safeConvId: string;
  try {
    safeName = safeAttachmentName(name);
    safeConvId = safeCid(cid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  const ext = path.extname(safeName).toLowerCase();
  const cap = maxBytesFor(ext);
  if (buf.length > cap) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(cap / 1024 / 1024) }) };
  }
  if (TEXT_EXTS.has(ext)) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').length !== buf.length) {
      return { ok: false, error: t('errors.not_utf8') };
    }
  }

  const dir = ensureDir(userId, safeConvId);
  const incomingHash = hashBuffer(buf);
  return withAttachmentWriteLock(userId, safeConvId, async () => {
    const duplicate = await findDuplicateByHash(dir, buf.length, incomingHash);
    if (duplicate) {
      log.info(`upload dedupe user=${userId} cid=${safeConvId} reuse=${duplicate.name} bytes=${duplicate.bytes}`);
      return { ok: true, info: duplicate, reused: true };
    }

    const target = uniqueTarget(dir, safeName);
    const finalName = path.basename(target);
    try { fs.writeFileSync(target, buf); }
    catch (err) {
      // Roll back the mkdir from `ensureDir` if the directory ended up empty
      // (i.e., this was the first attachment for the cid and the write failed
      // before producing anything). Best-effort: a non-empty dir means a
      // previous successful upload owns it and must not be touched.
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* best-effort */ }
      return { ok: false, error: (err as Error).message };
    }

    // No upload-time preprocessing: extract / grayscale happen lazily in
    // features/file_indexer when the model's tools first touch this file.
    // Video is display-only and never preprocessed.

    const st = fs.statSync(target);
    const kind = kindOf(ext);
    log.info(`upload user=${userId} cid=${safeConvId} name=${finalName} kind=${kind} bytes=${st.size}`);
    return {
      ok: true,
      info: {
        name: finalName,
        bytes: st.size,
        kind,
        mtime: Math.floor(st.mtimeMs / 1000),
      },
    };
  });
}

export async function importAttachmentFromPath(
  userId: string,
  cid: string,
  sourcePath: string,
  name?: string,
): Promise<Result<{ info: AttachmentInfo; reused?: boolean }>> {
  let safeName: string;
  let safeConvId: string;
  try {
    safeName = safeAttachmentName(name || path.basename(sourcePath || ''));
    safeConvId = safeCid(cid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const absSource = path.resolve(String(sourcePath || ''));
  let sourceStat: fs.Stats;
  try { sourceStat = fs.statSync(absSource); }
  catch { return { ok: false, error: 'file not found' }; }
  if (!sourceStat.isFile()) return { ok: false, error: 'file not found' };

  const ext = path.extname(safeName).toLowerCase();
  const cap = maxBytesFor(ext);
  if (sourceStat.size > cap) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(cap / 1024 / 1024) }) };
  }
  if (TEXT_EXTS.has(ext)) {
    let buf: Buffer;
    try { buf = fs.readFileSync(absSource); }
    catch (err) { return { ok: false, error: (err as Error).message }; }
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').length !== buf.length) {
      return { ok: false, error: t('errors.not_utf8') };
    }
  }

  const dir = ensureDir(userId, safeConvId);
  let incomingHash: string;
  try { incomingHash = await hashFile(absSource); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  return withAttachmentWriteLock(userId, safeConvId, async () => {
    const duplicate = await findDuplicateByHash(dir, sourceStat.size, incomingHash);
    if (duplicate) {
      log.info(`import dedupe user=${userId} cid=${safeConvId} reuse=${duplicate.name} bytes=${duplicate.bytes}`);
      return { ok: true, info: duplicate, reused: true };
    }

    const target = uniqueTarget(dir, safeName);
    const finalName = path.basename(target);
    try { fs.copyFileSync(absSource, target); }
    catch (err) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* best-effort */ }
      return { ok: false, error: (err as Error).message };
    }

    const st = fs.statSync(target);
    const kind = kindOf(ext);
    log.info(`import user=${userId} cid=${safeConvId} name=${finalName} kind=${kind} bytes=${st.size}`);
    return {
      ok: true,
      info: {
        name: finalName,
        bytes: st.size,
        kind,
        mtime: Math.floor(st.mtimeMs / 1000),
      },
    };
  });
}

export function listAttachments(userId: string, cid: string): AttachmentInfo[] {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch { return []; }
  const dir = chatAttachmentDir(userId, safeConvId);
  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const out: AttachmentInfo[] = [];
  for (const e of items) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;  // skip any lingering legacy sibling
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      out.push({
        name: e.name,
        bytes: st.size,
        kind: kindOf(ext),
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Same as listAttachments, minus files that are already referenced by any
 * user message in the conversation's jsonl. Used by the chip area
 * (`/api/conversations/:cid/attachments`) to restore only the "uploaded but
 * not yet sent" pool on app restart — without also re-chiping files that
 * already belong to prior messages.
 */
export function listPendingAttachments(userId: string, cid: string): AttachmentInfo[] {
  const all = listAttachments(userId, cid);
  if (!all.length) return all;

  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch { return all; }

  const committed = new Set<string>();
  const jsonlPath = path.join(userChatsDir(userId), `${safeConvId}.jsonl`);
  let raw: string;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); }
  catch { return all; }  // new conv, no messages yet → everything is pending

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s) as { attachments?: unknown };
      if (Array.isArray(rec.attachments)) {
        for (const name of rec.attachments) {
          if (typeof name === 'string') committed.add(name);
        }
      }
    } catch { /* skip malformed line */ }
  }

  return all.filter((a) => !committed.has(a.name));
}

export function deleteAttachment(userId: string, cid: string, name: string): Result {
  let safeName: string;
  let safeConvId: string;
  try {
    safeName = safeAttachmentName(name);
    safeConvId = safeCid(cid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  const dir = chatAttachmentDir(userId, safeConvId);
  const p = path.join(dir, safeName);
  if (!fs.existsSync(p)) return { ok: false, error: 'not found' };
  try { fs.unlinkSync(p); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  // Drop the lazy file_cache entry for this source (if any was materialised).
  try { invalidateFileCache(userId, p); }
  catch (err) { log.warn(`invalidate cache ${p}: ${(err as Error).message}`); }
  // Remove the per-cid directory if this was the last attachment — leaving
  // empty `chat_attachments/<cid>/` shells around violates the "no payload,
  // no directory" expectation, and the user has no UI to clean them up.
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
  return { ok: true };
}

/**
 * Resolve (uid, cid, name) → absolute on-disk path, with every guard rail the
 * `chat-media://` protocol handler needs:
 *   - safeCid / safeAttachmentName reject path separators, traversal names,
 *     empty strings, non-whitelisted extensions
 *   - After `path.resolve` the final abs path MUST still live under the cid
 *     dir (belt-and-braces anti-traversal; the name checks above already
 *     block `..` but a defensive `path.relative` check survives future edits)
 *   - File must exist and be a regular file
 *
 * Returns `{ok:true, absPath, kind}` on success. Errors use codes suitable
 * for HTTP status mapping by the protocol handler:
 *   'bad_input' → 400, 'forbidden' → 403, 'not_found' → 404
 */
export function resolveAttachmentAbsPath(
  userId: string,
  cid: string,
  name: string,
): Result<{ absPath: string; kind: AttachmentKind }> | { ok: false; code: 'bad_input' | 'forbidden' | 'not_found'; error: string } {
  let safeName: string;
  let safeConvId: string;
  try {
    safeName = safeAttachmentName(name);
    safeConvId = safeCid(cid);
  } catch (err) {
    return { ok: false, code: 'bad_input', error: (err as Error).message };
  }
  const root = path.resolve(chatAttachmentDir(userId, safeConvId));
  const abs = path.resolve(root, safeName);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'forbidden', error: 'path traversal blocked' };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch { return { ok: false, code: 'not_found', error: 'not found' }; }
  if (!stat.isFile()) return { ok: false, code: 'not_found', error: 'not a file' };
  const ext = path.extname(safeName).toLowerCase();
  return { ok: true, absPath: abs, kind: kindOf(ext) };
}

/**
 * Resolve an arbitrary absolute local path → streamable media file, for the
 * `chat-media://local/<abs-path>` protocol route. Unlike per-cid attachments
 * this serves files from anywhere on the user's machine — but only when they
 * look like media (image or video extension) and aren't obscenely large.
 *
 * Threat model: the user runs the LLM on their own machine; worst case is
 * the LLM asks the renderer to display one of the user's own files. Not
 * exfiltration. No dir whitelist; the extension + size checks are the only
 * gates.
 *
 * Accepts: absolute path (caller has already decoded URL + OS-normalized)
 * Rejects: relative paths, non-existent targets, non-file targets,
 *          non-media extensions, files over the per-kind cap.
 */
export function resolveLocalMediaPath(
  absPath: string,
): { ok: true; absPath: string; kind: 'image' | 'video' } | { ok: false; code: 'bad_input' | 'not_found' | 'too_large'; error: string } {
  if (typeof absPath !== 'string' || !absPath) {
    return { ok: false, code: 'bad_input', error: 'path required' };
  }
  if (!path.isAbsolute(absPath)) {
    return { ok: false, code: 'bad_input', error: 'path must be absolute' };
  }
  const normalized = path.resolve(absPath);
  const ext = path.extname(normalized).toLowerCase();
  if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
    return { ok: false, code: 'bad_input', error: `unsupported extension: ${ext || '(none)'}` };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(normalized); }
  catch { return { ok: false, code: 'not_found', error: 'not found' }; }
  if (!stat.isFile()) return { ok: false, code: 'not_found', error: 'not a file' };
  const cap = maxBytesFor(ext);
  if (stat.size > cap) {
    const mb = Math.round(cap / 1024 / 1024);
    return { ok: false, code: 'too_large', error: `file exceeds ${mb}MB cap` };
  }
  return { ok: true, absPath: normalized, kind: VIDEO_EXTS.has(ext) ? 'video' : 'image' };
}

/**
 * Sibling of `resolveLocalMediaPath` for files that aren't media but still
 * need to be streamed through `chat-media://local/<abs>` so the renderer can
 * preview them in-app (PDF via Chromium's PDFium, HTML via a sandboxed
 * iframe). Same threat model: extension allow-list, no directory allow-list.
 *
 * No size cap — these are served via `serveFileRange`, so Chromium streams
 * the bytes directly into the iframe (or PDF viewer) without ever touching
 * the JS heap. Worst case of a huge file is a few seconds of busy GPU
 * process while the user dismisses the overlay.
 */
const PREVIEW_DOC_EXTS: ReadonlySet<string> = new Set(['.pdf', '.html', '.htm']);

export function resolveLocalPreviewPath(
  absPath: string,
): { ok: true; absPath: string; kind: 'pdf' | 'html' } | { ok: false; code: 'bad_input' | 'not_found'; error: string } {
  if (typeof absPath !== 'string' || !absPath) {
    return { ok: false, code: 'bad_input', error: 'path required' };
  }
  if (!path.isAbsolute(absPath)) {
    return { ok: false, code: 'bad_input', error: 'path must be absolute' };
  }
  const normalized = path.resolve(absPath);
  const ext = path.extname(normalized).toLowerCase();
  if (!PREVIEW_DOC_EXTS.has(ext)) {
    return { ok: false, code: 'bad_input', error: `unsupported extension: ${ext || '(none)'}` };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(normalized); }
  catch { return { ok: false, code: 'not_found', error: 'not found' }; }
  if (!stat.isFile()) return { ok: false, code: 'not_found', error: 'not a file' };
  return { ok: true, absPath: normalized, kind: ext === '.pdf' ? 'pdf' : 'html' };
}

/** MIME lookup for the chat-media:// protocol handler. Covers images, videos,
 *  and the in-app preview docs served via `resolveLocalPreviewPath` (pdf /
 *  html). Text/markdown go through the `produced.readText` IPC instead. */
export function mediaMimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.ogv') return 'video/ogg';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  return 'application/octet-stream';
}

function imageMimeFromExt(ext: string): ImageMimeType {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg'; // .jpg / .jpeg / fallback
}

/**
 * Move an entire draft attachment dir (e.g. `main_chat/`, used by the
 * commander tab
 * before a conversation exists) into a freshly-minted `<cid>/`. No caches
 * need to follow — cache entries are keyed by absolute path and will simply
 * point at the old draft location until next access, at which point
 * ensureFresh rebuilds for the new path. pruneOrphans sweeps the stale
 * draft-path cache at startup.
 */
export function adoptDraftAttachments(
  userId: string,
  fromCid: string,
  toCid: string,
): Result<{ count: number }> {
  let srcSafe: string;
  let dstSafe: string;
  try { srcSafe = safeCid(fromCid); dstSafe = safeCid(toCid); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (srcSafe === dstSafe) return { ok: false, error: 'same cid' };

  const src = chatAttachmentDir(userId, srcSafe);
  if (!fs.existsSync(src)) return { ok: true, count: 0 };
  const dst = chatAttachmentDir(userId, dstSafe);

  try {
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } else {
      for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dst, name);
        try { fs.renameSync(from, to); }
        catch {
          // Cross-device or already-exists → fall back to copy+unlink.
          fs.copyFileSync(from, to);
          try { fs.unlinkSync(from); } catch { /* best-effort */ }
        }
      }
      try { fs.rmdirSync(src); } catch { /* best-effort */ }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  let count = 0;
  try { count = fs.readdirSync(dst).filter((n) => !n.startsWith('.')).length; }
  catch { /* ignore */ }
  log.info(`adopt user=${userId} ${srcSafe} → ${dstSafe} count=${count}`);
  return { ok: true, count };
}

/** Remove the entire `<cid>/` attachment dir + drop all file_cache entries
 *  tagged with this cid. Returns count of attachment files deleted. */
export async function purgeByCid(userId: string, cid: string): Promise<number> {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch { return 0; }
  const dir = chatAttachmentDir(userId, safeConvId);
  let count = 0;
  try {
    if (fs.existsSync(dir)) {
      for (const n of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, n)); count++; } catch { /* best-effort */ }
      }
      try { fs.rmdirSync(dir); } catch { /* best-effort */ }
    }
  } catch (err) { log.warn(`purgeByCid(${cid}): ${(err as Error).message}`); }
  try { await purgeFileCacheByCid(userId, safeConvId); }
  catch (err) { log.warn(`purge file_cache cid=${safeConvId}: ${(err as Error).message}`); }
  return count;
}

// ── Prompt injection (manifest + images) ─────────────────────────────────

export interface AttachmentManifest {
  /** `<attachments>…</attachments>` XML listing text/pdf/docx attachments
   *  with absolute paths + kind + byte count. Empty string when no text-ish
   *  attachments are attached. The model uses this as a directory listing
   *  and calls the on-demand file tools for content. */
  manifest: string;
  /** Compressed gray JPEG images formatted for `ChatOptions.images` (pi-ai
   *  ImageContent). Produced in real time on each call — no cache. */
  images: Array<{ data: string; mediaType: ImageMimeType }>;
  /** Names of attachments we couldn't pack (missing / too big / load error). */
  skipped: Array<{ name: string; reason: string }>;
}

export interface BuildManifestOpts {
  /** Max number of images attached to a single message. Default 5. */
  maxImages?: number;
}

/**
 * Produce the model-facing view of the attachments for one turn:
 *   - text            → listed with `total_chars` (cheap: one fs.readFileSync
 *                       + .length via file_indexer.statFile). Model can go
 *                       straight to read_file.
 *   - pdf / docx      → listed with `total_chars` ONLY if the cache already
 *                       has it (i.e. someone has read/stated this file
 *                       before). Otherwise `total_chars` is omitted and the
 *                       model must call stat_file before read_file.
 *                       Never eagerly extract here — upload stays zero-cost.
 *   - image           → compressed grayscale JPEG via real-time
 *                       toCompressedGrayJpeg on the raw source → images[]
 *                       for pi-ai vision.
 *   - video           → skipped entirely (display-only).
 */
export async function buildAttachmentManifest(
  userId: string,
  cid: string,
  names: string[],
  opts: BuildManifestOpts = {},
): Promise<AttachmentManifest> {
  const maxImages = opts.maxImages ?? 5;
  const skipped: Array<{ name: string; reason: string }> = [];
  const entries: string[] = [];
  const images: Array<{ data: string; mediaType: ImageMimeType }> = [];

  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch (err) { return { manifest: '', images: [], skipped: [{ name: '', reason: (err as Error).message }] }; }
  const dir = chatAttachmentDir(userId, safeConvId);

  for (const rawName of names) {
    let nm: string;
    try { nm = safeAttachmentName(rawName); }
    catch (err) { skipped.push({ name: String(rawName), reason: (err as Error).message }); continue; }
    const abs = path.join(dir, nm);
    if (!fs.existsSync(abs)) { skipped.push({ name: nm, reason: t('attachments.skipped.missing') }); continue; }
    const ext = path.extname(nm).toLowerCase();
    const kind = kindOf(ext);

    if (kind === 'image') {
      if (images.length >= maxImages) { skipped.push({ name: nm, reason: t('attachments.skipped.too_many_images', { max: maxImages }) }); continue; }
      try {
        const buf = fs.readFileSync(abs);
        const compressed = await toCompressedGrayJpeg(buf, { maxDim: 1024, quality: 70, grayscale: true });
        images.push({ data: compressed.buf.toString('base64'), mediaType: 'image/jpeg' });
        // Also list the image in the manifest so the LLM has a text-side
        // hint (filename + abs path) tying its inline-attached vision input
        // to the user's intent ("this image is 证书.jpg"). `attached="inline"`
        // tells the LLM bytes are already on this turn — see chat_commander.md
        // attachments section — so it doesn't waste a read_file round-trip.
        entries.push(`<file name="${escapeAttr(nm)}" path="${escapeAttr(abs)}" kind="image" attached="inline"/>`);
      } catch (err) {
        skipped.push({ name: nm, reason: t('attachments.skipped.compress_failed', { message: (err as Error).message }) });
      }
      continue;
    }

    if (kind === 'video') {
      // Videos are display-only: no vision support + no text extraction. The
      // renderer streams bytes through the `chat-media://` protocol directly;
      // nothing to surface to the model.
      skipped.push({ name: nm, reason: t('attachments.skipped.video_for_display') });
      continue;
    }

    // text / pdf / docx → manifest entry (path + kind + total_chars if known).
    let totalChars: number | undefined;
    if (kind === 'text') {
      // Text is cheap to stat (one fs.readFileSync). Always include total_chars
      // so the first read_file can land on the right range without a stat round-trip.
      try {
        const meta = await statFile(userId, abs);
        totalChars = meta.totalChars;
      } catch (err) {
        log.warn(`manifest statFile text failed name=${nm}: ${(err as Error).message}`);
      }
    } else {
      // pdf / docx: peek only — no extract. total_chars appears only when a
      // prior read/stat already materialised the cache.
      const cached = getCachedMeta(userId, abs);
      if (cached?.totalChars !== undefined) totalChars = cached.totalChars;
    }

    const attrs = [
      `name="${escapeAttr(nm)}"`,
      `path="${escapeAttr(abs)}"`,
      `kind="${kind}"`,
    ];
    if (totalChars !== undefined) attrs.push(`total_chars="${totalChars}"`);
    entries.push(`<file ${attrs.join(' ')}/>`);
  }

  const manifest = entries.length
    ? `<attachments>\n${entries.join('\n')}\n</attachments>`
    : '';
  return { manifest, images, skipped };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Exported for ipc handlers that list by user.
export { userChatAttachmentsDir };
