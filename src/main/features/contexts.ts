/**
 * Knowledge base — single-region model (user-owned directory tree).
 *
 * Per Phase 2 of the kb-vector plan, the two-region model has been retired:
 * there is no more `contexts_tmp/` staging + organizer pipeline. Users now
 * directly manage `<uid>/cloud/contexts/`:
 *   - `createContextDir` — new subdirectory
 *   - `writeContextFile`  — new / overwrite a text file
 *   - `updateContextFile` — edit an existing text file
 *   - `uploadContextFile` — save a binary upload (pdf / docx / image)
 *   - `renameContextEntry` — rename a file or directory
 *   - `deleteContextTarget` — delete a file or directory (recursive)
 *   - `listContextsTree`  — browse
 *   - `readContextFile`   — read a single file's text
 *
 * Each mutation triggers a `search.*` idx update and a `kb_indexer.enqueue`
 * call so the vector store reconciles with disk in the background.
 *
 * `_INDEX.md` is still written, but only at the root: it's a human-readable
 * overview for Finder browsing, not a model routing input (the model uses
 * `kb_search` / `kb_read` tools). Sub-directory index files are no longer
 * generated.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { shell } from 'electron';

import { userContextsDir } from '../paths';
import * as search from './search';
import * as kbIndexer from './kb_indexer';
import * as kbVector from './kb_vector';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { getActiveUserId } from './users';

const log = createLogger('contexts');

function contextsRoot(): string {
  return userContextsDir(getActiveUserId());
}

export const CONTEXTS_INDEX_FILENAME = '_INDEX.md';

// Anything dot-prefixed is hidden from listings (includes `.kb/` where the
// vector DB lives, `.DS_Store`, any user-created hidden file).
const CONTEXTS_IGNORE: ReadonlySet<string> = new Set([
  '.DS_Store', '__pycache__', '.git', 'node_modules',
  CONTEXTS_INDEX_FILENAME,
]);

// Single file-name whitelist now shared with kb_indexer's `kindFor`. Text
// files must be UTF-8 (enforced by `writeContextFile` / `updateContextFile`);
// binaries bypass UTF-8 and go through `uploadContextFile` which writes byte-
// for-byte. Size cap defensive only — content gets chunked before hitting
// the LLM so no practical ceiling on "how big a file can the KB take".
const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);
const BINARY_EXTS: ReadonlySet<string> = new Set([
  '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);
const ALLOWED_EXTS: ReadonlySet<string> = new Set([...TEXT_EXTS, ...BINARY_EXTS]);
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200MB — defensive cap per plan §3.3

/** Max basename / dirname length in **weighted code points**: CJK / Hangul /
 *  Kana count as 2, everything else (ASCII, Latin-extended, Cyrillic, emoji…)
 *  counts as 1. The split prevents a single uniform cap from either
 *  squashing English to a few words OR letting Chinese filenames balloon
 *  past readable. Budget 100:
 *    - pure Chinese: ~50 chars (a long sentence)
 *    - pure English: ~100 chars (descriptive long filename)
 *    - mixed:        weights add up
 *  Real FS basename limits (HFS+ / NTFS = 255 UTF-16 units) are far higher;
 *  this is a UX bound, not a FS bound. Applied to every path segment in
 *  `resolvePath`, so it covers writes / uploads / mkdir / rename through
 *  one chokepoint. */
const MAX_BASENAME_WEIGHT = 100;

/** Char-class regex for the "double-width" group: CJK Unified Ideographs
 *  (incl. extension A), Hangul, Hiragana, Katakana. Tested per code point. */
const DOUBLE_WIDTH_CHAR = /[㐀-鿿가-힯぀-ゟ゠-ヿ]/;

function _filenameWeight(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += DOUBLE_WIDTH_CHAR.test(ch) ? 2 : 1;
  }
  return w;
}

export type Result<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

export interface ContextNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: ContextNode[];
  bytes?: number;
  mtime?: number;
}

export interface ContextIndexEntry {
  path: string;
  title: string;
}

interface IndexCache {
  mtime: number;
  rootMarkdown: string;
  flatMarkdown: string;
  entries: ContextIndexEntry[];
}

// ── Path safety ──────────────────────────────────────────────────────────

interface ResolveOpts { mustExist?: boolean }

/**
 * Resolve a user-supplied relative path safely under contextsRoot().
 * Returns absolute path; throws on traversal, absolute inputs, empty
 * segments, or (when mustExist) missing files.
 */
function resolvePath(relpath: string, { mustExist = false }: ResolveOpts = {}): string {
  if (typeof relpath !== 'string') throw new Error('path required');
  const s = relpath.trim().replace(/^\/+|\/+$/g, '');
  if (!s) return path.resolve(contextsRoot());
  const parts = s.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('invalid path segment');
  if (parts.some((p) => p.includes('\x00'))) throw new Error('invalid character');
  // Reject any segment starting with '.' — keeps `.kb/` (vector db) and other
  // hidden dirs off-limits to user mutations.
  if (parts.some((p) => p.startsWith('.'))) throw new Error('hidden entries are reserved');
  // Length cap (per-segment, weighted — see MAX_BASENAME_WEIGHT).
  // The first offending segment is surfaced verbatim so the user knows which
  // part of the path is too long (file basename vs. some parent dir).
  for (const p of parts) {
    if (_filenameWeight(p) > MAX_BASENAME_WEIGHT) {
      throw new Error(t('errors.kb_name_too_long', { name: p }));
    }
  }
  const root = path.resolve(contextsRoot());
  const target = path.resolve(root, s);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes contexts root');
  if (mustExist && !fs.existsSync(target)) {
    const err = new Error(`not found: ${s}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  return target;
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function isAllowedName(name: string): boolean {
  return ALLOWED_EXTS.has(extOf(name));
}

// ── Listing / Reading ────────────────────────────────────────────────────

export function listContextsTree(): ContextNode[] {
  fs.mkdirSync(contextsRoot(), { recursive: true });

  function walk(d: string, rel = ''): ContextNode[] {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
    } catch { return []; }

    const out: ContextNode[] = [];
    for (const e of items) {
      if (CONTEXTS_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push({ name: e.name, path: relPath, type: 'dir', children: walk(full, relPath) });
      } else if (e.isFile()) {
        // Show every supported KB file kind in the tree — text + binary both
        // get vectorized, both deserve to be visible.
        if (!isAllowedName(e.name)) continue;
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs / 1000; }
        catch { /* ignore */ }
        out.push({ name: e.name, path: relPath, type: 'file', bytes: size, mtime });
      }
    }
    return out;
  }
  return walk(contextsRoot());
}

export function readContextFile(relpath: string): Result<{ content: string; path: string }> {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
  const ext = extOf(p);
  if (!TEXT_EXTS.has(ext)) {
    return { ok: false, error: `binary file cannot be read as text: ${ext}` };
  }
  try { return { ok: true, content: fs.readFileSync(p, 'utf8'), path: relpath }; }
  catch (err) { return { ok: false, error: (err as Error).message }; }
}

/** Convert a .docx file to HTML for inline preview (via mammoth). Refuses
 *  anything outside .docx — this is a "render" endpoint, not a generic
 *  binary reader. Caller decides how to style / sanitize the output. */
export async function readContextDocxHtml(relpath: string): Promise<Result<{ html: string }>> {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
  if (extOf(p) !== '.docx') return { ok: false, error: 'not a docx file' };
  try {
    const { docxBufferToHtml } = await import('../util/extract-docx');
    const buf = fs.readFileSync(p);
    const html = await docxBufferToHtml(buf);
    return { ok: true, html };
  } catch (err) {
    log.warn(`docx→html ${relpath}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/** Read an image (png/jpg/jpeg/webp/gif) back as base64 for inline viewer
 *  display. Refuses anything outside the image extension set so callers
 *  can't use it as a generic binary exfil. */
export function readContextImage(relpath: string): Result<{ base64: string; mediaType: string; bytes: number }> {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
  const ext = extOf(p);
  const mediaType = IMAGE_MEDIA_TYPE[ext];
  if (!mediaType) return { ok: false, error: `not a supported image format: ${ext}` };
  try {
    const buf = fs.readFileSync(p);
    return { ok: true, base64: buf.toString('base64'), mediaType, bytes: buf.length };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

/** Reveal a Library file in the OS file manager.
 *  The path is validated against the Library root first, so a caller can't
 *  escape the contexts tree. */
export async function showContextFileInSystem(relpath: string): Promise<Result> {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
  try {
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (err) {
    log.warn(`showItemInFolder ${relpath}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// ── Mutations (user-facing) ──────────────────────────────────────────────

/**
 * Create or overwrite a text file at `relpath`. Accepts any supported text
 * extension. Triggers KB reindex of the new content.
 */
/**
 * Reject any write/upload whose content sha1 is already tracked anywhere in
 * the KB — including the same path. Policy is "no duplicate bytes, period":
 * user either edits the existing file (via `updateContextFile` which isn't
 * gated here) or picks a different source. A same-path re-upload of
 * identical content is treated as a duplicate too so the user gets explicit
 * feedback rather than a silent no-op.
 *
 * Race note: `kb_files` rows are created when the indexer picks up a job
 * (not at enqueue time), so there's a ~ms window where two parallel uploads
 * with identical content could both slip through. Desktop single-user flow
 * makes that window irrelevant in practice.
 */
function checkDuplicateContent(sha1: string): Result<null> | null {
  let existing: kbVector.KbFileRow | null;
  try {
    existing = kbVector.findBySha1(getActiveUserId(), sha1);
  } catch (err) {
    log.warn(`duplicate content check skipped: ${(err as Error).message}`);
    return null;
  }
  if (!existing) return null;
  return {
    ok: false,
    error: t('errors.kb_duplicate_sha1', { existingPath: existing.rel_path }),
  };
}

function notifyDeletedContext(relPath: string): void {
  void relPath;
}

function notifyDirtyContext(relPath: string): void {
  void relPath;
}

export function writeContextFile(relpath: string, content: string): Result<{ path: string }> {
  let p: string;
  try { p = resolvePath(relpath); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const ext = extOf(p);
  if (!TEXT_EXTS.has(ext)) {
    return { ok: false, error: `unsupported text extension: ${ext || '(none)'}` };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && !fs.statSync(p).isFile()) {
    return { ok: false, error: 'path is a directory' };
  }
  const body = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }
  // Content-level dedup: reject if the same bytes are already tracked at a
  // different path. Skips the root-index file (never vectorised) and empty
  // content (sha1 of an empty string is meaningless for dedup).
  if (path.basename(p) !== CONTEXTS_INDEX_FILENAME && body.length > 0) {
    const sha1 = crypto.createHash('sha1').update(body, 'utf8').digest('hex');
    const dup = checkDuplicateContent(sha1);
    if (dup) return dup;
  }
  try { fs.writeFileSync(p, body, 'utf8'); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  if (path.basename(p) !== CONTEXTS_INDEX_FILENAME) {
    const uid = getActiveUserId();
    search.upsertContext(uid, relpath);
    kbIndexer.enqueue(uid, relpath, 'upsert');
    notifyDirtyContext(relpath);
  }
  return { ok: true, path: relpath };
}

/**
 * Edit an existing text file — refuses to create new files and refuses to
 * touch the root `_INDEX.md` (auto-generated).
 */
export function updateContextFile(relpath: string, content: string): Result<{ path: string }> {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
  const ext = extOf(p);
  if (!TEXT_EXTS.has(ext)) {
    return { ok: false, error: `binary file cannot be edited as text: ${ext}` };
  }
  if (path.basename(p) === CONTEXTS_INDEX_FILENAME) {
    return { ok: false, error: t('errors.cant_edit_index') };
  }
  const body = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }
  try { fs.writeFileSync(p, body, 'utf8'); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  const uid = getActiveUserId();
  search.upsertContext(uid, relpath);
  kbIndexer.enqueue(uid, relpath, 'upsert');
  notifyDirtyContext(relpath);
  return { ok: true, path: relpath };
}

/**
 * Save an uploaded binary (pdf / docx / image) at `relpath`. Text types are
 * accepted too — the buffer is written byte-for-byte; UTF-8 validation is
 * the caller's job (text uploads usually go through `writeContextFile`
 * after the renderer reads the file as string).
 */
export function uploadContextFile(relpath: string, raw: Buffer | Uint8Array | null | undefined): Result<{ path: string; bytes: number }> {
  let p: string;
  try { p = resolvePath(relpath); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const ext = extOf(p);
  if (!ALLOWED_EXTS.has(ext)) {
    const allowed = [...ALLOWED_EXTS].sort().join(', ');
    return { ok: false, error: t('errors.contexts.formats_only', { allowed }) };
  }
  if (path.basename(p) === CONTEXTS_INDEX_FILENAME) {
    return { ok: false, error: t('errors.cant_edit_index') };
  }
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  if (buf.length > MAX_FILE_BYTES) {
    return { ok: false, error: `file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit` };
  }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    return { ok: false, error: 'path is a directory' };
  }
  // Content-level dedup: reject identical content already tracked at a
  // different path. Empty uploads skip (no signal).
  if (buf.length > 0) {
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const dup = checkDuplicateContent(sha1);
    if (dup) return dup;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.writeFileSync(p, buf); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  const uid = getActiveUserId();
  search.upsertContext(uid, relpath);
  kbIndexer.enqueue(uid, relpath, 'upsert');
  notifyDirtyContext(relpath);
  return { ok: true, path: relpath, bytes: buf.length };
}

/** User-facing delete — files or dirs (recursive), refuses to touch the root index. */
export function deleteContextTarget(relpath: string): Result {
  let p: string;
  try { p = resolvePath(relpath, { mustExist: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (path.basename(p) === CONTEXTS_INDEX_FILENAME) {
    return { ok: false, error: t('errors.cant_delete_index') };
  }
  const droppedRels = _collectRelsUnder(p, relpath);
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  const uid = getActiveUserId();
  for (const r of droppedRels) {
    search.dropContext(uid, r);
    kbIndexer.enqueue(uid, r, 'delete');
    notifyDeletedContext(r);
  }
  return { ok: true };
}

/** Walk a path that's about to be deleted; collect every KB-supported doc-id we hold. */
function _collectRelsUnder(absPath: string, rel: string): string[] {
  const out: string[] = [];
  let st: fs.Stats;
  try { st = fs.statSync(absPath); } catch { return out; }
  if (st.isFile()) {
    if (isAllowedName(path.basename(absPath))) out.push(rel);
    return out;
  }
  const stack: Array<{ abs: string; rel: string }> = [{ abs: absPath, rel }];
  while (stack.length) {
    const cur = stack.pop()!;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of items) {
      if (CONTEXTS_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const childAbs = path.join(cur.abs, e.name);
      if (e.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
      else if (e.isFile() && isAllowedName(e.name)) out.push(childRel);
    }
  }
  return out;
}

export function createContextDir(relpath: string): Result<{ path: string; existed?: boolean }> {
  let p: string;
  try { p = resolvePath(relpath); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(p)) {
    if (fs.statSync(p).isDirectory()) return { ok: true, path: relpath, existed: true };
    return { ok: false, error: 'path exists and is not a directory' };
  }
  try { fs.mkdirSync(p, { recursive: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  return { ok: true, path: relpath };
}

export function renameContextEntry(srcRel: string, dstRel: string): Result<{ src: string; dst: string }> {
  let src: string; let dst: string;
  try { src = resolvePath(srcRel, { mustExist: true }); dst = resolvePath(dstRel); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(dst)) return { ok: false, error: 'destination already exists' };
  const srcIsFile = fs.statSync(src).isFile();
  if (srcIsFile && !isAllowedName(path.basename(dst))) {
    return { ok: false, error: 'destination has unsupported extension' };
  }
  const oldRels = _collectRelsUnder(src, srcRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  invalidateIndex();
  const uid = getActiveUserId();
  for (const r of oldRels) {
    search.dropContext(uid, r);
    kbIndexer.enqueue(uid, r, 'delete');
    notifyDeletedContext(r);
  }
  for (const r of _collectRelsUnder(dst, dstRel)) {
    search.upsertContext(uid, r);
    kbIndexer.enqueue(uid, r, 'upsert');
    notifyDirtyContext(r);
  }
  return { ok: true, src: srcRel, dst: dstRel };
}

// ── Body helpers ────────────────────────────────────────────────────────
// No frontmatter. Files are plain markdown/text; `_INDEX.md` + first heading
// is enough for human browsing, `kb_search` covers model routing. Anything
// legacy organizer emitted as frontmatter is stripped on read.

export function stripLegacyFrontmatter(text: string): string {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return text || '';
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length) : text;
}

export function firstHeading(text: string, maxChars = 100): string {
  const body = stripLegacyFrontmatter(text);
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) return s.replace(/^#+/, '').trim().slice(0, maxChars);
    return s.slice(0, maxChars);
  }
  return '';
}

// ── Index ────────────────────────────────────────────────────────────────
// Single root `_INDEX.md` for human browsing. No subdirectory index files.
// Rebuilt after any mutation; slim/flat views derived for the chat prompt
// and the organizer-view backward-compat caller.

const indexCache: IndexCache = {
  mtime: 0, rootMarkdown: '', flatMarkdown: '', entries: [],
};

export function invalidateIndex(): void {
  indexCache.mtime = 0;
  try { rebuildIndex(); }
  catch (err) { log.warn(`index rebuild failed: ${(err as Error).message}`); }
}

interface WalkNode { name: string; rel: string; full: string }

function walkContextNodes(root: string, relBase = ''): { dirs: WalkNode[]; files: WalkNode[] } {
  const dirs: WalkNode[] = [];
  const files: WalkNode[] = [];
  let items: fs.Dirent[];
  try { items = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { return { dirs, files }; }
  for (const e of items) {
    if (CONTEXTS_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const full = path.join(root, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, rel, full });
    else if (e.isFile() && isAllowedName(e.name)) files.push({ name: e.name, rel, full });
  }
  return { dirs, files };
}

function collectAllEntries(root: string, relBase = ''): ContextIndexEntry[] {
  const out: ContextIndexEntry[] = [];
  const { dirs, files } = walkContextNodes(root, relBase);
  for (const f of files) {
    let title = '';
    if (TEXT_EXTS.has(extOf(f.name))) {
      try { title = firstHeading(fs.readFileSync(f.full, 'utf8')); }
      catch { /* ignore */ }
    }
    out.push({ path: f.rel, title });
  }
  for (const d of dirs) out.push(...collectAllEntries(d.full, d.rel));
  return out;
}

export function rebuildIndex(): IndexCache {
  fs.mkdirSync(contextsRoot(), { recursive: true });
  const allEntries = collectAllEntries(contextsRoot(), '');

  // Root-level view: subdirs with counts + root-level files with titles.
  const { dirs: rootDirs, files: rootFiles } = walkContextNodes(contextsRoot(), '');
  const dirCounts = new Map<string, number>();
  for (const e of allEntries) {
    const top = e.path.includes('/') ? e.path.split('/')[0] : '';
    if (top) dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
  }

  // Root _INDEX.md (human-readable overview).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const lines: string[] = [];
  lines.push(`# ${t('contexts.index.heading')}`, '');
  lines.push(`_${t('contexts.index.maintained_note', { stamp })}_`, '');
  lines.push(`> ${t('contexts.index.model_access_note')}`, '');
  if (!rootDirs.length && !rootFiles.length) {
    lines.push(t('contexts.index.empty_section'));
  } else {
    if (rootDirs.length) {
      lines.push(`## ${t('contexts.index.dirs_heading')}`);
      for (const d of rootDirs) {
        const n = dirCounts.get(d.name) || 0;
        lines.push(`- 📁 \`${d.name}/\` — ${t('contexts.index.file_count', { count: n })}`);
      }
      lines.push('');
    }
    if (rootFiles.length) {
      lines.push(`## ${t('contexts.index.root_files_heading')}`);
      for (const f of rootFiles) {
        const entry = allEntries.find((e) => e.path === f.name);
        lines.push(`- \`${f.name}\`${entry?.title ? ` — ${entry.title}` : ''}`);
      }
      lines.push('');
    }
  }
  try {
    fs.writeFileSync(
      path.join(contextsRoot(), CONTEXTS_INDEX_FILENAME),
      lines.join('\n').trimEnd() + '\n',
      'utf8',
    );
  } catch (err) { log.warn(`failed to write root _INDEX.md: ${(err as Error).message}`); }

  // Full root markdown — re-read what we just wrote, for getContextIndexMarkdown.
  let rootMd = '';
  try { rootMd = fs.readFileSync(path.join(contextsRoot(), CONTEXTS_INDEX_FILENAME), 'utf8'); }
  catch { rootMd = t('contexts.index.empty_kb'); }

  const flatLines = allEntries.length
    ? allEntries.map((e) => `- \`${e.path}\`${e.title ? ` — ${e.title}` : ''}`).join('\n')
    : t('contexts.index.empty_kb');

  indexCache.mtime = Date.now();
  indexCache.rootMarkdown = rootMd;
  indexCache.flatMarkdown = flatLines;
  indexCache.entries = allEntries;
  return indexCache;
}

export async function getContextIndexMarkdown(): Promise<string> {
  if (indexCache.mtime === 0) rebuildIndex();
  return indexCache.rootMarkdown;
}

export async function getContextIndexEntries(): Promise<ContextIndexEntry[]> {
  if (indexCache.mtime === 0) rebuildIndex();
  return [...indexCache.entries];
}
