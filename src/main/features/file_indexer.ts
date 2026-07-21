/**
 * On-demand file indexer — lazy cache + unified char-offset reader behind the
 * file tools (read_file / stat_file / search_files / grep_files). The model
 * drives reading via explicit `charStart` / `charEnd` regardless of file
 * kind; nothing is pre-split.
 *
 * Cache layout (attachment + workspace unified):
 *
 *   <uid>/local/file_cache/<sha1(absPath).slice(0,16)>/
 *     meta.json   { absPath, mtime, size, kind, source: 'attachment'|'workspace',
 *                   cid?, totalChars?, pageMap?, cacheVersion, lastAccessed }
 *     text.md     (pdf / docx / xlsx / pptx) — full extracted text; enables
 *                 range reads without re-parsing. text files read directly
 *                 from source; images never cached (realtime compress+grayscale).
 *
 * Scope is recorded in `meta.source` / `meta.cid` for cleanup routing only —
 * the cache location does NOT depend on scope. Tool-layer path-sandbox is
 * the mechanism that decides which files a given conversation may touch.
 *
 * Responsibility split:
 *   - `getCachedMeta` / `peekMeta`  — pure read-only; never materialises. Used
 *     by manifest + search_files so "list a file" doesn't pay extract cost.
 *   - `statFile`                    — `ensureFresh` + return FileMeta. Triggers
 *     extract when needed. For rich documents this is the only path that runs
 *     pdfjs / mammoth / OOXML parsers.
 *   - `readRange`                   — pure slice by char offsets. For rich docs
 *     throws `NeedStatError` when cache is missing so the caller decides
 *     whether to extract first.
 *
 * Eviction:
 *   - source mtime/size changed        → lazy rebuild on next access
 *   - cacheVersion != EXTRACT_CACHE_VERSION → lazy rebuild on next access
 *   - source file missing              → drop on access + pruneOrphans sweep
 *   - conversation deleted             → purgeByCid() drops entries for its cid
 *   - attachment deleted               → invalidateFileCache(absPath) explicit
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userChatAttachmentsDir, userFileCacheDir, projectChatAttachmentsDir } from '../paths';
import { listProjectIds } from '../util/project-layout';
import { createLogger } from '../logger';
import { macosTccSensitivePath } from '../util/macos-tcc';
import { pdfBufferToPages, EXTRACT_CACHE_VERSION } from '../util/extract-pdf';
import { docxBufferToMarkdown } from '../util/extract-docx';
import { xlsxBufferToMarkdown, pptxBufferToMarkdown } from '../util/extract-office';
import { toCompressedGrayJpeg } from '../util/image-transform';

const log = createLogger('file_indexer');

export { EXTRACT_CACHE_VERSION };

/** Thrown by `readRange` when the target is rich-document kind and no cache exists yet.
 *  Caller decides whether to `statFile` (which triggers extract) or surface
 *  an error to the model. */
export class NeedStatError extends Error {
  constructor(public readonly absPath: string, public readonly kind: FileKind) {
    super(`cache missing — call stat_file first: ${absPath}`);
    this.name = 'NeedStatError';
  }
}

/** Thrown by `readRange` / `statFile` when the target is image kind. Image
 *  has no text representation; callers must use `readImageAsGrayJpeg`. */
export class NoTextError extends Error {
  constructor(public readonly absPath: string) {
    super(`image kind has no text representation: ${absPath}`);
    this.name = 'NoTextError';
  }
}

/** Thrown when the file extension is uploadable/listable but cannot be
 *  converted to text by the current model-side extractor. */
export class UnsupportedFileKindError extends Error {
  constructor(public readonly absPath: string, public readonly kind: FileKind) {
    super(`${kind} is not readable by the model: ${absPath}`);
    this.name = 'UnsupportedFileKindError';
  }
}

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const PDF_EXT = '.pdf';
const DOCX_EXTS: ReadonlySet<string> = new Set(['.docx', '.docm']);
const SPREADSHEET_EXTS: ReadonlySet<string> = new Set(['.xlsx', '.xlsm']);
const PRESENTATION_EXTS: ReadonlySet<string> = new Set(['.pptx', '.pptm']);
const LEGACY_OFFICE_EXTS: ReadonlySet<string> = new Set(['.doc', '.xls', '.ppt']);

// ── Types ────────────────────────────────────────────────────────────────

export type FileKind = 'text' | 'pdf' | 'docx' | 'spreadsheet' | 'presentation' | 'legacy_office' | 'image';
export type SourceScope = 'attachment' | 'workspace';

export interface FileMeta {
  kind: FileKind;
  absPath: string;
  bytes: number;
  mtime: number;
  source: SourceScope;
  cid?: string;
  /** Total character length of the text representation. Populated after
   *  materialisation for text / rich documents; undefined for image (no text). */
  totalChars?: number;
  /** pdf only: the extractor (pdfjs) produced empty text on EVERY page —
   *  almost always a font-mapping failure (embedded / subset / CJK cmap
   *  gaps), not a genuinely blank document. `totalChars` is still non-zero
   *  because the page delimiters count. The file tools surface this so the
   *  model can retry with a different reader (bash + PyMuPDF). Absent = at
   *  least one page yielded text. */
  extractionEmpty?: boolean;
}

export interface TextReadResult {
  content: string;
  meta: FileMeta;
  /** Hash of the complete source bytes for editable plain-text files. This is
   *  intentionally absent for extracted rich-document text, which cannot be
   *  edited in place. */
  sourceHash?: string;
  /** Echo of the applied range (what was actually returned, clamped to
   *  `[0, totalChars)`). */
  range: { charStart: number; charEnd: number };
  /** 1-based line number of the first returned character (the line `charStart`
   *  falls on). Lets `read_file` show absolute line numbers even for a slice
   *  that begins mid-file. Always 1 for a whole-file read. */
  startLine: number;
}

export interface ImageReadResult {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  /** Original file size on disk (not the compressed preview size). */
  bytes: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function kindOf(absPath: string): FileKind {
  const e = path.extname(absPath).toLowerCase();
  if (e === PDF_EXT) return 'pdf';
  if (DOCX_EXTS.has(e)) return 'docx';
  if (SPREADSHEET_EXTS.has(e)) return 'spreadsheet';
  if (PRESENTATION_EXTS.has(e)) return 'presentation';
  if (LEGACY_OFFICE_EXTS.has(e)) return 'legacy_office';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (TEXT_EXTS.has(e)) return 'text';
  // Unknown extension: treat as text so the model can still peek at it.
  return 'text';
}

function cacheHashFor(absPath: string): string {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

function cacheDirFor(userId: string, absPath: string): string {
  return path.join(userFileCacheDir(userId), cacheHashFor(absPath));
}

function deriveScope(userId: string, absPath: string): { source: SourceScope; cid?: string } {
  const attachmentRoots = [
    userChatAttachmentsDir(userId),
    ...listProjectIds(userId).map((pid) => projectChatAttachmentsDir(userId, pid)),
  ];
  for (const attachmentsRoot of attachmentRoots) {
    if (!absPath.startsWith(attachmentsRoot + path.sep)) continue;
    // layout: <attachmentsRoot>/<cid>/<file>  — cid is the first dir segment
    const rest = absPath.slice(attachmentsRoot.length + 1);
    const segs = rest.split(path.sep).filter(Boolean);
    return segs.length >= 2 ? { source: 'attachment', cid: segs[0] } : { source: 'attachment' };
  }
  return { source: 'workspace' };
}

// ── On-disk meta ────────────────────────────────────────────────────────

interface OnDiskMeta {
  absPath: string;
  mtime: number;
  size: number;
  kind: FileKind;
  source: SourceScope;
  cid?: string;
  totalChars?: number;
  /** pdf only — see FileMeta.extractionEmpty. */
  extractionEmpty?: boolean;
  /** Per-page [charStart, charEnd) offsets into text.md. Populated for pdf only.
   *  Kept as a materialise by-product so grep / future per-page features don't
   *  have to re-scan; the file tools never expose it to the model. */
  pageMap?: Array<{ page: number; charStart: number; charEnd: number }>;
  cacheVersion: number;
  lastAccessed: number;
}

function readMeta(dir: string): OnDiskMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj as OnDiskMeta;
  } catch { return null; }
}

function writeMeta(dir: string, meta: OnDiskMeta): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'meta.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta), 'utf8');
  fs.renameSync(tmp, p);
}

function touchMeta(dir: string, patch?: Partial<OnDiskMeta>): void {
  const meta = readMeta(dir);
  if (!meta) return;
  meta.lastAccessed = Date.now();
  if (patch) Object.assign(meta, patch);
  try { writeMeta(dir, meta); } catch { /* best-effort */ }
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (err) { log.warn(`rmdir ${dir}: ${(err as Error).message}`); }
}

function metaToPublic(meta: OnDiskMeta): FileMeta {
  const out: FileMeta = {
    kind: meta.kind,
    absPath: meta.absPath,
    bytes: meta.size,
    mtime: meta.mtime,
    source: meta.source,
  };
  if (meta.cid) out.cid = meta.cid;
  if (meta.totalChars !== undefined) out.totalChars = meta.totalChars;
  if (meta.extractionEmpty) out.extractionEmpty = true;
  return out;
}

// ── Source validation / cache freshness ─────────────────────────────────

function isFresh(meta: OnDiskMeta, stat: fs.Stats): boolean {
  return meta.cacheVersion === EXTRACT_CACHE_VERSION
      && meta.size === stat.size
      && meta.mtime === Math.floor(stat.mtimeMs);
}

/** Stat the source; throw if missing/not a file. Normalises mtime to ms-int. */
function statSource(absPath: string): { size: number; mtime: number; stat: fs.Stats } {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error(`not a file: ${absPath}`);
  return { size: stat.size, mtime: Math.floor(stat.mtimeMs), stat };
}

// ── Materialisation (rich docs build text.md + pdf pageMap) ─────────────

async function materialise(
  userId: string,
  absPath: string,
  kind: FileKind,
  stat: { size: number; mtime: number },
): Promise<OnDiskMeta> {
  const t0 = Date.now();
  const dir = cacheDirFor(userId, absPath);
  fs.mkdirSync(dir, { recursive: true });
  const { source, cid } = deriveScope(userId, absPath);
  const base: OnDiskMeta = {
    absPath,
    mtime: stat.mtime,
    size: stat.size,
    kind,
    source,
    ...(cid ? { cid } : {}),
    cacheVersion: EXTRACT_CACHE_VERSION,
    lastAccessed: Date.now(),
  };

  if (kind === 'pdf') {
    const buf = fs.readFileSync(absPath);
    const pages = await pdfBufferToPages(buf);
    // Build text.md with page delimiters + pageMap [charStart, charEnd).
    const pageMap: Array<{ page: number; charStart: number; charEnd: number }> = [];
    let acc = '';
    for (let i = 0; i < pages.length; i++) {
      const header = `--- page ${i + 1} ---\n`;
      const charStart = acc.length;
      acc += header + pages[i] + (i < pages.length - 1 ? '\n\n' : '');
      pageMap.push({ page: i + 1, charStart, charEnd: acc.length });
    }
    fs.writeFileSync(path.join(dir, 'text.md'), acc, 'utf8');
    base.totalChars = acc.length;
    base.pageMap = pageMap;
    // Every page came back blank → pdfjs almost certainly failed to map the
    // fonts (vs a genuinely blank doc). Flag it so the file tools can steer
    // the model to a different reader. Guard pages.length so a 0-page parse
    // doesn't trip `[].every() === true`.
    if (pages.length > 0 && pages.every((p) => p.trim().length === 0)) {
      base.extractionEmpty = true;
    }
  } else if (kind === 'docx') {
    const buf = fs.readFileSync(absPath);
    const md = await docxBufferToMarkdown(buf);
    fs.writeFileSync(path.join(dir, 'text.md'), md, 'utf8');
    base.totalChars = md.length;
  } else if (kind === 'spreadsheet') {
    const buf = fs.readFileSync(absPath);
    const md = xlsxBufferToMarkdown(buf);
    fs.writeFileSync(path.join(dir, 'text.md'), md, 'utf8');
    base.totalChars = md.length;
  } else if (kind === 'presentation') {
    const buf = fs.readFileSync(absPath);
    const md = pptxBufferToMarkdown(buf);
    fs.writeFileSync(path.join(dir, 'text.md'), md, 'utf8');
    base.totalChars = md.length;
  } else if (kind === 'legacy_office') {
    throw new UnsupportedFileKindError(absPath, kind);
  } else if (kind === 'text') {
    // No text.md for text kind — source IS the text.
    try {
      base.totalChars = fs.readFileSync(absPath, 'utf8').length;
    } catch {
      base.totalChars = 0;
    }
  }
  // image: no cache payload at all.

  writeMeta(dir, base);
  log.info(
    `materialise user=${userId} kind=${kind} chars=${base.totalChars ?? 0}`
    + (kind === 'pdf' ? ` pages=${base.pageMap?.length ?? 0}` : '')
    + (base.extractionEmpty ? ' extraction=empty_pages' : '')
    + ` ms=${Date.now() - t0} path=${absPath}`,
  );
  return base;
}

async function ensureFresh(userId: string, absPath: string): Promise<OnDiskMeta> {
  const src = statSource(absPath);
  const dir = cacheDirFor(userId, absPath);
  const kind = kindOf(absPath);

  // Image kind: don't cache. Return an ephemeral meta.
  if (kind === 'image') {
    const { source, cid } = deriveScope(userId, absPath);
    return {
      absPath,
      mtime: src.mtime,
      size: src.size,
      kind,
      source,
      ...(cid ? { cid } : {}),
      cacheVersion: EXTRACT_CACHE_VERSION,
      lastAccessed: Date.now(),
    };
  }

  const existing = readMeta(dir);
  if (existing && existing.absPath === absPath && isFresh(existing, src.stat)) {
    // Touch lastAccessed but don't rewrite the (expensive) pageMap.
    touchMeta(dir);
    return existing;
  }
  if (existing) removeDir(dir);
  return materialise(userId, absPath, kind, src);
}

// ── Public API ──────────────────────────────────────────────────────────

/** Read-only cache probe — returns the existing fresh meta if one is on disk,
 *  otherwise null. Never triggers extract. Used by the manifest builder and
 *  search_files so "list a file" doesn't pay extract cost.
 *
 *  `null` covers: source missing, kind=image (never cached), no meta.json,
 *  or meta present but stale (mtime/size/version mismatch). */
function peekMeta(userId: string, absPath: string): OnDiskMeta | null {
  let src: { size: number; mtime: number; stat: fs.Stats };
  try { src = statSource(absPath); } catch { return null; }
  if (kindOf(absPath) === 'image') return null;
  const dir = cacheDirFor(userId, absPath);
  const existing = readMeta(dir);
  if (existing && existing.absPath === absPath && isFresh(existing, src.stat)) {
    return existing;
  }
  return null;
}

/** Public view of `peekMeta`. Returns `null` rather than throwing so callers
 *  can simply omit `total_chars` when the cache isn't ready. */
export function getCachedMeta(userId: string, absPath: string): FileMeta | null {
  const m = peekMeta(userId, absPath);
  return m ? metaToPublic(m) : null;
}

/** Force-fresh meta — triggers text extraction if cache is missing or stale.
 *  For image kind throws `NoTextError` since image has no text
 *  representation (use `readImageAsGrayJpeg` instead). */
export async function statFile(userId: string, absPath: string): Promise<FileMeta> {
  if (kindOf(absPath) === 'image') throw new NoTextError(absPath);
  if (kindOf(absPath) === 'legacy_office') throw new UnsupportedFileKindError(absPath, 'legacy_office');
  const meta = await ensureFresh(userId, absPath);
  return metaToPublic(meta);
}

/** Unified text-slice reader. `charStart` defaults to 0, `charEnd` defaults
 *  to `totalChars`. The returned `range` echoes the clamped values.
 *
 *  Contract by kind:
 *   - text        → always works (materialise is cheap: fs.read + .length)
 *   - rich docs   → throws `NeedStatError` when no cache exists. Callers
 *                   must `statFile` first (which extracts) and then retry.
 *                   This keeps extract side-effects out of read_file.
 *   - image       → throws `NoTextError`. Caller must branch to
 *                   `readImageAsGrayJpeg`. */
export async function readRange(
  userId: string,
  absPath: string,
  opts: { charStart?: number; charEnd?: number } = {},
): Promise<TextReadResult> {
  const kind = kindOf(absPath);
  if (kind === 'image') throw new NoTextError(absPath);
  if (kind === 'legacy_office') throw new UnsupportedFileKindError(absPath, kind);

  let meta: OnDiskMeta;
  if (kind === 'text') {
    // Text materialisation is a single fs.readFileSync — safe to trigger on
    // every read. Keeps the "first read_file on a plain .md" path to one tool
    // call instead of forcing the model through stat_file first.
    meta = await ensureFresh(userId, absPath);
  } else {
    // Rich documents require an existing fresh cache. Do NOT extract here — the
    // model is expected to call stat_file first when the manifest / search
    // result didn't include total_chars.
    const peeked = peekMeta(userId, absPath);
    if (!peeked) throw new NeedStatError(absPath, kind);
    meta = peeked;
    // Touch lastAccessed on successful peek (ensureFresh would have done this).
    try { touchMeta(cacheDirFor(userId, absPath)); } catch { /* best-effort */ }
  }

  const total = meta.totalChars ?? 0;
  const csRaw = typeof opts.charStart === 'number' ? Math.floor(opts.charStart) : 0;
  const ceRaw = typeof opts.charEnd === 'number' ? Math.floor(opts.charEnd) : total;
  const start = Math.max(0, Math.min(csRaw, total));
  const end = Math.max(start, Math.min(ceRaw, total));

  const body = kind === 'text'
    ? fs.readFileSync(absPath, 'utf8')
    : fs.readFileSync(path.join(cacheDirFor(userId, absPath), 'text.md'), 'utf8');

  // 1-based line of the slice's first char: count newlines in [0, start).
  let startLine = 1;
  for (let i = 0; i < start; i++) if (body.charCodeAt(i) === 10) startLine++;

  return {
    content: body.slice(start, end),
    meta: metaToPublic(meta),
    ...(kind === 'text'
      ? { sourceHash: `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}` }
      : {}),
    range: { charStart: start, charEnd: end },
    startLine,
  };
}

export async function readImageAsGrayJpeg(
  userId: string,
  absPath: string,
): Promise<ImageReadResult> {
  void userId; // image kind bypasses cache; userId only used for future per-user policy
  const kind = kindOf(absPath);
  if (kind !== 'image') throw new Error(`readImageAsGrayJpeg: not an image: ${absPath}`);
  const buf = fs.readFileSync(absPath);
  const out = await toCompressedGrayJpeg(buf, { maxDim: 1024, quality: 70, grayscale: true });
  return {
    base64: out.buf.toString('base64'),
    mediaType: 'image/jpeg',
    width: out.width,
    height: out.height,
    bytes: buf.length,
  };
}

/** Full extracted text + meta — used by grep_files to scan many files. Text
 *  kind reads source directly; rich docs return cached text.md. Image throws. */
export async function getExtractedText(
  userId: string,
  absPath: string,
): Promise<{ text: string; meta: FileMeta }> {
  const meta = await ensureFresh(userId, absPath);
  if (meta.kind === 'image') throw new Error(`getExtractedText: image not supported: ${absPath}`);
  if (meta.kind === 'legacy_office') throw new UnsupportedFileKindError(absPath, meta.kind);
  const text = meta.kind === 'text'
    ? fs.readFileSync(absPath, 'utf8')
    : fs.readFileSync(path.join(cacheDirFor(userId, absPath), 'text.md'), 'utf8');
  return { text, meta: metaToPublic(meta) };
}

/** Drop the cache entry for a single absolute path. Safe to call even when
 *  no entry exists. Called on attachment delete / workspace file invalidate. */
export function invalidateFileCache(userId: string, absPath: string): void {
  removeDir(cacheDirFor(userId, absPath));
}

/** Startup sweep: drop cache dirs whose source is gone, whose version is
 *  obsolete, or whose meta is malformed. Cheap (stat per dir), no network.
 *
 *  Optional `workspacePath`: when supplied, additionally drops
 *  `source==='workspace'` entries whose `absPath` is no longer inside the
 *  current workspace (e.g. user switched workspace dir, or moved the file
 *  out of it). Attachment-source entries are NOT subject to this check —
 *  they live in `<uid>/cloud/chat_attachments/`, separate from workspace.
 *  Without `workspacePath` the call behaves exactly as before. */
export async function pruneOrphans(
  userId: string,
  opts?: { workspacePath?: string },
): Promise<{ deleted: number }> {
  const root = userFileCacheDir(userId);
  let deleted = 0;
  let items: fs.Dirent[];
  try { items = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return { deleted: 0 }; }

  const wsRoot = opts?.workspacePath ? path.resolve(opts.workspacePath) : '';

  for (const e of items) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const meta = readMeta(dir);
    const reason =
      !meta ? 'no-meta' :
      meta.cacheVersion !== EXTRACT_CACHE_VERSION ? 'version' :
      macosTccSensitivePath(path.resolve(meta.absPath), { recursive: false }) ? 'tcc-protected-source' :
      !safeExistsSync(meta.absPath) ? 'orphan' :
      (wsRoot && meta.source === 'workspace' && !_isUnder(meta.absPath, wsRoot)) ? 'out-of-workspace' :
      null;
    if (reason) {
      removeDir(dir);
      deleted++;
      log.debug(`pruneOrphans: drop ${e.name} (${reason})`);
    }
  }
  if (deleted) log.info(`pruneOrphans user=${userId} deleted=${deleted}`);
  return { deleted };
}

/** True iff `abs` is `root` itself or any descendant of it. Uses
 *  `path.relative` so it's robust against trailing slashes and `..`. */
function _isUnder(abs: string, root: string): boolean {
  const rel = path.relative(root, path.resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Drop all cache entries tagged with the given cid. Called from
 *  chat_attachments.purgeByCid when a conversation is deleted. */
export async function purgeFileCacheByCid(
  userId: string,
  cid: string,
): Promise<{ deleted: number }> {
  const root = userFileCacheDir(userId);
  let deleted = 0;
  let items: fs.Dirent[];
  try { items = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return { deleted: 0 }; }

  for (const e of items) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const meta = readMeta(dir);
    if (meta && meta.source === 'attachment' && meta.cid === cid) {
      removeDir(dir);
      deleted++;
    }
  }
  if (deleted) log.info(`purgeFileCacheByCid user=${userId} cid=${cid} deleted=${deleted}`);
  return { deleted };
}

function safeExistsSync(p: string): boolean {
  try { fs.statSync(p); return true; }
  catch { return false; }
}
