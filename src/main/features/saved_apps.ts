/**
 * "My Apps" — user-kept copies of `create_artifact` interactive web apps.
 *
 * An artifact created in chat lives in `<uid>/cloud/chat_artifacts/<cid>/<id>/`
 * and is purged when the conversation is deleted. The artifact card's `⋯` →
 * "Save" copies the bundle into a new persistent pool here:
 *   `<uid>/cloud/saved_apps/<appId>/{entry.html, ...siblings, __orkas-meta.json}`
 * Cloud-synced; conversation-independent; never auto-purged (only the user's
 * explicit delete from the My Apps tab removes one). The files are served
 * read-only inside the app via `chat-app://saved/<appId>/...`; the explicit
 * external-open IPC still uses `shell.openPath` for callers that want the OS
 * browser.
 *
 * Guard rails: `safeAppId` rejects separators / traversal names; the source
 * dir is resolved through `chatArtifacts.resolveArtifactDir` (which reuses the
 * artifact pool's safe-cid / safe-artifactId checks); `resolveSavedAppIndex`
 * runs a `path.relative` traversal guard before handing a path to the IPC
 * layer for `shell.openPath`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userSavedAppsDir, savedAppDir } from '../paths';
import * as chatArtifacts from './chat_artifacts';
import * as chats from './chats';
import * as chatAttachments from './chat_attachments';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { logErrorRef, logPathRef, maskId } from '../util/log-redact';

const log = createLogger('saved_apps');

const META_FILENAME = '__orkas-meta.json';
const MAX_TITLE_LEN = 120;
const DEFAULT_TITLE = 'Interactive app';

// Source files that go into the editing bundle verbatim (everything in an
// artifact's served-extension set that is text). Anything else (png / woff /
// wasm / …) becomes a one-line `[binary asset …]` placeholder — it can't be
// represented in a text `.md` bundle, and changing it means re-supplying it
// via `create_artifact` with `"encoding":"base64"` anyway.
const TEXT_LIKE_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt', '.csv',
]);
const BUNDLE_RESOURCE_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp',
  '.gif', '.avif', '.bmp', '.ico', '.webmanifest', '.woff', '.woff2', '.ttf', '.wasm',
  '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.glb', '.gltf', '.txt', '.md', '.csv', '.xml',
]);
const HTML_ENTRY_EXTS: ReadonlySet<string> = new Set(['.html', '.htm']);
const BUNDLE_TRIGGER_EXTS: ReadonlySet<string> = new Set(BUNDLE_RESOURCE_EXTS);
const BUNDLE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.vite', 'coverage',
]);
const SOURCE_BUNDLE_NAME = 'app-source.md';
const MAX_BUNDLE_FILES = 300;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_BUNDLE_ANCESTORS = 8;

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };
type ResolveCode = 'bad_input' | 'forbidden' | 'not_found';

export interface SavedAppMeta {
  title: string;
  sourceCid: string;
  sourceArtifactId: string;
  sourcePath?: string;
  entry?: string;
  savedAt: string; // ISO
}

export interface SavedAppListItem {
  id: string;
  title: string;
  savedAt: string;
  sourceCid: string;
}

export type BundleInspection =
  | {
      ok: true;
      canSave: true;
      rootDir: string;
      entry: string;
      title: string;
      fileCount: number;
      totalBytes: number;
    }
  | { ok: true; canSave: false; reason: string }
  | { ok: false; error: string };

interface BundleInspectOptions {
  fenceRoots?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeAppId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('appId required');
  // Generated ids are base64url (alphanumerics + `-` + `_`); never allow
  // separators / dots / NUL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid appId');
  return id;
}

function sanitiseTitle(t: unknown): string {
  if (typeof t === 'string') {
    const s = t.trim();
    if (s) return s.slice(0, MAX_TITLE_LEN);
  }
  return DEFAULT_TITLE;
}

function writeMeta(dir: string, meta: SavedAppMeta): void {
  fs.writeFileSync(path.join(dir, META_FILENAME), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
}

function savedAppRelPath(appId: string, rel = ''): string {
  return ['cloud/saved_apps', appId, rel].filter(Boolean).join('/');
}

function notifySavedAppDirty(appId: string, rel = ''): void {
  void appId;
  void rel;
}

function notifySavedAppDeleted(appId: string, rel: string): void {
  void appId;
  void rel;
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  if (!roots.length) return true;
  const c = path.resolve(candidate);
  return roots.some((r) => {
    const root = path.resolve(r);
    const rel = path.relative(root, c);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function nearestFenceRoot(candidate: string, roots: string[]): string {
  const c = path.resolve(candidate);
  let best = '';
  for (const r of roots || []) {
    const root = path.resolve(r);
    const rel = path.relative(root, c);
    if (rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

function inferTitleFromHtml(entryPath: string, rootDir: string): string {
  try {
    const html = fs.readFileSync(entryPath, 'utf8');
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
      || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
      || '';
    const clean = title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (clean) return sanitiseTitle(clean);
  } catch { /* fallback */ }
  return sanitiseTitle(path.basename(rootDir));
}

function isHtmlEntryName(name: string): boolean {
  return HTML_ENTRY_EXTS.has(path.extname(name).toLowerCase());
}

function normaliseEntryRel(entry: unknown): string {
  if (typeof entry !== 'string' || !entry.trim()) return 'index.html';
  const rel = entry.replace(/\\/g, '/').trim();
  if (rel.startsWith('/') || rel.includes('\0')) return 'index.html';
  const norm = path.posix.normalize(rel);
  if (!norm || norm === '.' || norm.startsWith('../') || norm.includes('/../')) return 'index.html';
  return isHtmlEntryName(norm) ? norm : 'index.html';
}

function safeSavedRelPath(rel: unknown): string {
  if (typeof rel !== 'string') throw new Error('relpath required');
  let s = rel.trim();
  if (s.startsWith('/')) s = s.slice(1);
  if (!s) throw new Error('empty relpath');
  if (s.length > 240) throw new Error('relpath too long');
  if (s.includes('\0') || s.includes('\\')) throw new Error('invalid relpath');
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new Error('invalid relpath segment');
    if (seg.startsWith('.')) throw new Error('relpath segment must not start with "."');
  }
  return segs.join('/');
}

function savedAppMimeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.js': case '.mjs':   return 'text/javascript; charset=utf-8';
    case '.css':               return 'text/css; charset=utf-8';
    case '.json': case '.map': case '.webmanifest': return 'application/json; charset=utf-8';
    case '.svg':               return 'image/svg+xml';
    case '.xml':               return 'application/xml; charset=utf-8';
    case '.txt': case '.md': case '.csv': return 'text/plain; charset=utf-8';
    case '.png':               return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif':               return 'image/gif';
    case '.webp':              return 'image/webp';
    case '.avif':              return 'image/avif';
    case '.bmp':               return 'image/bmp';
    case '.ico':               return 'image/x-icon';
    case '.wasm':              return 'application/wasm';
    case '.woff':              return 'font/woff';
    case '.woff2':             return 'font/woff2';
    case '.ttf':               return 'font/ttf';
    case '.mp3':               return 'audio/mpeg';
    case '.wav':               return 'audio/wav';
    case '.ogg':               return 'audio/ogg';
    case '.mp4':               return 'video/mp4';
    case '.webm':              return 'video/webm';
    case '.glb':               return 'model/gltf-binary';
    case '.gltf':              return 'model/gltf+json';
    default:                   return 'application/octet-stream';
  }
}

function chooseHtmlEntryInDir(dir: string): string {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return ''; }
  const html = entries
    .filter((e) => e.isFile() && isHtmlEntryName(e.name) && shouldIncludeBundleFile(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  if (!html.length) return '';
  const preferred = html.find((name) => /^index\.html?$/i.test(name));
  return preferred || html[0];
}

function shouldSkipBundleDir(name: string): boolean {
  return BUNDLE_EXCLUDED_DIRS.has(name) || name === META_FILENAME;
}

function shouldIncludeBundleFile(name: string): boolean {
  if (!name || name === META_FILENAME || name === '.DS_Store') return false;
  if (name.startsWith('.')) return false;
  return BUNDLE_RESOURCE_EXTS.has(path.extname(name).toLowerCase());
}

function collectBundleFiles(rootDir: string): { ok: true; files: string[]; totalBytes: number } | { ok: false; reason: string } {
  const files: string[] = [];
  let totalBytes = 0;
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!shouldSkipBundleDir(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile() || !shouldIncludeBundleFile(e.name)) continue;
      const st = fs.statSync(abs);
      files.push(abs);
      totalBytes += st.size;
      if (files.length > MAX_BUNDLE_FILES) throw new Error(`too many files (>${MAX_BUNDLE_FILES})`);
      if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`bundle is too large (>${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MB)`);
    }
  };
  try { walk(rootDir); }
  catch (err) { return { ok: false, reason: (err as Error).message || 'could not scan bundle' }; }
  return { ok: true, files, totalBytes };
}

function findBundleRoot(target: string, opts: BundleInspectOptions = {}): { ok: true; rootDir: string; entry: string } | { ok: false; reason: string } {
  const abs = path.resolve(target);
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, reason: 'file not found' }; }

  const roots = (opts.fenceRoots || []).filter(Boolean).map((r) => path.resolve(r));
  if (roots.length && !isInsideAnyRoot(abs, roots)) return { ok: false, reason: 'outside allowed workspace' };

  if (st.isDirectory()) {
    const entry = chooseHtmlEntryInDir(abs);
    if (!entry) return { ok: false, reason: 'folder has no HTML entry' };
    return { ok: true, rootDir: abs, entry };
  }
  if (!st.isFile()) return { ok: false, reason: 'unsupported file type' };

  const ext = path.extname(abs).toLowerCase();
  if (!BUNDLE_TRIGGER_EXTS.has(ext)) return { ok: false, reason: 'unsupported file type' };
  if (HTML_ENTRY_EXTS.has(ext)) return { ok: true, rootDir: path.dirname(abs), entry: path.basename(abs) };

  const fence = nearestFenceRoot(abs, roots);
  let dir = path.dirname(abs);
  for (let i = 0; i <= MAX_BUNDLE_ANCESTORS; i++) {
    const entry = chooseHtmlEntryInDir(dir);
    if (entry) return { ok: true, rootDir: dir, entry };
    if (fence && path.resolve(dir) === fence) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { ok: false, reason: 'no HTML entry found for this file' };
}

export function inspectBundleFromPath(targetPath: string, opts: BundleInspectOptions = {}): BundleInspection {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: 'path required' };
  const found = findBundleRoot(targetPath, opts);
  if (!found.ok) return { ok: true, canSave: false, reason: (found as { ok: false; reason: string }).reason };
  const rootDir = found.rootDir;
  if (opts.fenceRoots?.length && !isInsideAnyRoot(rootDir, opts.fenceRoots)) {
    return { ok: true, canSave: false, reason: 'bundle is outside allowed workspace' };
  }
  const entry = found.entry;
  const entryAbs = path.join(rootDir, entry);
  let entryStat: fs.Stats;
  try { entryStat = fs.statSync(entryAbs); }
  catch { return { ok: true, canSave: false, reason: 'bundle is missing its HTML entry' }; }
  if (!entryStat.isFile()) return { ok: true, canSave: false, reason: 'HTML entry is not a file' };
  const scanned = collectBundleFiles(rootDir);
  if (!scanned.ok) return { ok: true, canSave: false, reason: (scanned as { ok: false; reason: string }).reason };
  const includesEntry = scanned.files.some((p) => path.resolve(p) === path.resolve(entryAbs));
  if (!includesEntry) return { ok: true, canSave: false, reason: 'HTML entry is not a supported app file' };
  return {
    ok: true,
    canSave: true,
    rootDir,
    entry,
    title: inferTitleFromHtml(entryAbs, rootDir),
    fileCount: scanned.files.length,
    totalBytes: scanned.totalBytes,
  };
}

function copyBundleFiles(srcRoot: string, destRoot: string): { fileCount: number; totalBytes: number } {
  const scanned = collectBundleFiles(srcRoot);
  if (!scanned.ok) throw new Error((scanned as { ok: false; reason: string }).reason);
  for (const src of scanned.files) {
    const rel = path.relative(srcRoot, src);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path traversal blocked');
    const dst = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return { fileCount: scanned.files.length, totalBytes: scanned.totalBytes };
}

function mintAppId(userId: string): { appId: string; destDir: string } {
  for (let i = 0; i < 5; i++) {
    const appId = crypto.randomBytes(9).toString('base64url');
    const destDir = savedAppDir(userId, appId);
    if (!fs.existsSync(destDir)) return { appId, destDir };
  }
  throw new Error('could not allocate an app id');
}

// ── Public API ───────────────────────────────────────────────────────────

/** Copy a chat artifact bundle into a new `saved_apps/<appId>/`. */
export function saveFromArtifact(userId: string, cid: string, artifactId: string): Result<{ id: string; title: string }> {
  const resolved = chatArtifacts.resolveArtifactDir(userId, cid, artifactId);
  if (!resolved.ok) return { ok: false, error: (resolved as { error?: string }).error || 'artifact not found' };
  const srcDir = (resolved as { dirPath: string }).dirPath;

  const srcMeta = chatArtifacts.readArtifactMeta(userId, cid, artifactId);
  const title = sanitiseTitle(srcMeta?.title);

  let appId = '';
  let destDir = '';
  try {
    const minted = mintAppId(userId);
    appId = minted.appId;
    destDir = minted.destDir;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const tmpDir = `${destDir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    // Copy everything except the source `__orkas-meta.json` (we write a fresh
    // one stamped with the source provenance).
    fs.cpSync(srcDir, tmpDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== META_FILENAME,
    });
    if (!fs.existsSync(path.join(tmpDir, 'index.html'))) {
      throw new Error('source artifact is missing index.html');
    }
    const meta: SavedAppMeta = {
      title,
      sourceCid: typeof cid === 'string' ? cid : '',
      sourceArtifactId: typeof artifactId === 'string' ? artifactId : '',
      savedAt: new Date().toISOString(),
    };
    writeMeta(tmpDir, meta);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(tmpDir, destDir);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    log.warn('saveFromArtifact failed', {
      user_id: maskId(userId),
      conversation_id: maskId(cid),
      artifact_id: maskId(artifactId),
      error: logErrorRef(err),
    });
    return { ok: false, error: `failed to save app: ${(err as Error).message}` };
  }
  log.info('saveFromArtifact completed', {
    user_id: maskId(userId),
    app_id: maskId(appId),
    conversation_id: maskId(cid),
    artifact_id: maskId(artifactId),
  });
  notifySavedAppDirty(appId);
  return { ok: true, id: appId, title };
}

/** Copy a workspace/file-tab-discovered HTML app bundle into saved_apps. */
export function saveFromPath(
  userId: string,
  targetPath: string,
  opts: BundleInspectOptions & { title?: unknown; sourceCid?: unknown } = {},
): Result<{ id: string; title: string; rootDir: string; entry: string; fileCount: number; totalBytes: number }> {
  const inspected = inspectBundleFromPath(targetPath, opts);
  if (!inspected.ok) return { ok: false, error: (inspected as { ok: false; error: string }).error };
  if (!inspected.canSave) return { ok: false, error: (inspected as { ok: true; canSave: false; reason: string }).reason };

  const title = sanitiseTitle(opts.title || inspected.title);
  let appId = '';
  let destDir = '';
  try {
    const minted = mintAppId(userId);
    appId = minted.appId;
    destDir = minted.destDir;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const tmpDir = `${destDir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const copied = copyBundleFiles(inspected.rootDir, tmpDir);
    if (!fs.existsSync(path.join(tmpDir, inspected.entry))) throw new Error('bundle is missing its HTML entry');
    const meta: SavedAppMeta = {
      title,
      sourceCid: typeof opts.sourceCid === 'string' ? opts.sourceCid : '',
      sourceArtifactId: '',
      entry: inspected.entry,
      savedAt: new Date().toISOString(),
    };
    writeMeta(tmpDir, { ...meta, sourcePath: inspected.rootDir });
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(tmpDir, destDir);
    log.info('saveFromPath completed', {
      user_id: maskId(userId),
      app_id: maskId(appId),
      root: logPathRef(inspected.rootDir),
      entry: logPathRef(inspected.entry),
      file_count: copied.fileCount,
      total_bytes: copied.totalBytes,
    });
    notifySavedAppDirty(appId);
    return { ok: true, id: appId, title, rootDir: inspected.rootDir, entry: inspected.entry, ...copied };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    log.warn('saveFromPath failed', {
      user_id: maskId(userId),
      target: logPathRef(targetPath),
      error: logErrorRef(err),
    });
    return { ok: false, error: `failed to save app: ${(err as Error).message}` };
  }
}

/** List the user's saved apps, sorted A→Z by title (CLAUDE.md §8 inventory rule). */
export function listSavedApps(userId: string): SavedAppListItem[] {
  const root = userSavedAppsDir(userId);
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch { return []; } // pool dir not created yet
  const items: SavedAppListItem[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let appId: string;
    try { appId = safeAppId(name); } catch { continue; }
    const dir = savedAppDir(userId, appId);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    let meta: Partial<SavedAppMeta> = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8')) || {}; }
    catch (err) {
      log.warn('listSavedApps bad meta skipped', {
        user_id: maskId(userId),
        app_id: maskId(appId),
        error: logErrorRef(err),
      });
    }
    items.push({
      id: appId,
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : DEFAULT_TITLE,
      savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
      sourceCid: typeof meta.sourceCid === 'string' ? meta.sourceCid : '',
    });
  }
  items.sort((a, b) =>
    (a.title || a.id).localeCompare(b.title || b.id, undefined, { sensitivity: 'base', numeric: true }));
  return items;
}

/** Resolve a saved app's entry HTML absolute path (for `shell.openPath`).
 *  `code` maps to HTTP the same way the artifact resolvers' does. */
export function resolveSavedAppIndex(
  userId: string,
  appId: string,
): { ok: true; absPath: string } | { ok: false; code: 'bad_input' | 'not_found'; error: string } {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  const root = path.resolve(savedAppDir(userId, safeId));
  let entry = 'index.html';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, META_FILENAME), 'utf8')) || {};
    entry = normaliseEntryRel(meta.entry);
  } catch { /* old apps or corrupt meta fall back to index.html */ }
  const abs = path.resolve(root, entry);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'bad_input', error: 'path traversal blocked' };
  }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, code: 'not_found', error: 'app not found' }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'app not found' };
  return { ok: true, absPath: abs };
}

/** Resolve a saved app file for the `chat-app://saved/<appId>/...` protocol.
 *  Empty relpath resolves to the app's configured entry. */
export function resolveSavedAppFilePath(
  userId: string,
  appId: string,
  relPath: string,
): { ok: true; absPath: string; mime: string; entry: string } | { ok: false; code: ResolveCode; error: string } {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  const root = path.resolve(savedAppDir(userId, safeId));
  let entry = 'index.html';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, META_FILENAME), 'utf8')) || {};
    entry = normaliseEntryRel(meta.entry);
  } catch { /* old apps or corrupt meta fall back to index.html */ }

  let rel: string;
  const trimmed = typeof relPath === 'string' ? relPath.replace(/^\/+/, '').trim() : '';
  if (!trimmed) rel = entry;
  else {
    try { rel = safeSavedRelPath(trimmed); }
    catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  }
  if (rel === META_FILENAME || rel.startsWith(chatArtifacts.RESERVED_PREFIX)) {
    return { ok: false, code: 'not_found', error: 'not found' };
  }
  const ext = path.extname(rel).toLowerCase();
  if (!BUNDLE_RESOURCE_EXTS.has(ext)) {
    return { ok: false, code: 'forbidden', error: `extension not served: ${ext || '(none)'}` };
  }

  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { ok: false, code: 'forbidden', error: 'path traversal blocked' };
  }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, code: 'not_found', error: 'not found' }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'not a file' };
  return { ok: true, absPath: abs, mime: savedAppMimeFor(rel), entry };
}

/** Rename a saved app (rewrites `__orkas-meta.json`). */
export function renameSavedApp(userId: string, appId: string, title: unknown): Result<{ title: string }> {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title required' };
  const dir = savedAppDir(userId, safeId);
  let meta: SavedAppMeta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8')); }
  catch (err) { return { ok: false, error: `app not found: ${(err as Error).message}` }; }
  meta.title = sanitiseTitle(title);
  try { writeMeta(dir, meta); }
  catch (err) { return { ok: false, error: `failed to rename: ${(err as Error).message}` }; }
  log.info('renameSavedApp completed', { user_id: maskId(userId), app_id: maskId(safeId) });
  notifySavedAppDirty(safeId, META_FILENAME);
  return { ok: true, title: meta.title };
}

/** Delete a saved app (`rm -rf saved_apps/<appId>/`). */
export function deleteSavedApp(userId: string, appId: string): Result {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const dir = savedAppDir(userId, safeId);
  const deleted = fs.existsSync(dir) ? listAppFilesRel(dir) : [];
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('deleteSavedApp failed', { user_id: maskId(userId), app_id: maskId(safeId), error: logErrorRef(err) });
    return { ok: false, error: `failed to delete: ${(err as Error).message}` };
  }
  log.info('deleteSavedApp completed', { user_id: maskId(userId), app_id: maskId(safeId) });
  for (const rel of deleted) notifySavedAppDeleted(safeId, rel);
  return { ok: true };
}

// ── "Edit in a new conversation" ─────────────────────────────────────────

/** Recursively list a saved app's file paths (relative to its dir), sorted. */
function listAppFilesRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk('');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Build the single-`.md` source bundle handed to the editing conversation as
 *  an attachment. Plain `FILE:` rules (not fenced code blocks) so the app's own
 *  source — which may contain ``` — can't break the bundle. Binary assets are
 *  represented as placeholder lines (a text bundle can't carry their bytes). */
function buildSourceBundle(dir: string, title: string): string {
  const files = listAppFilesRel(dir).filter((rel) => rel !== META_FILENAME);
  let entry = 'index.html';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8')) || {};
    entry = normaliseEntryRel(meta.entry);
  } catch { /* old apps */ }
  const lines: string[] = [
    `# Interactive app source — "${title}"`,
    '',
    `This is the current source of a self-contained interactive web app. Its current entry HTML is \`${entry}\`. To modify it: read the files below, then call \`create_artifact\` again with the updated \`files\` array — include a top-level HTML entry, keep the app offline (inline your CSS/JS or reference sibling files by relative URL), and the result is embedded in a sandboxed iframe.`,
    '',
  ];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    lines.push(`========== FILE: ${rel} ==========`);
    if (TEXT_LIKE_EXTS.has(path.extname(rel).toLowerCase())) {
      let content = '<could not read this file>';
      try { content = fs.readFileSync(abs, 'utf8'); } catch { /* keep placeholder */ }
      lines.push(content);
    } else {
      let kb = 1;
      try { kb = Math.max(1, Math.round(fs.statSync(abs).size / 1024)); } catch { /* ignore */ }
      lines.push(`[binary asset: ${rel} — ~${kb} KB; kept from the original app. To change it, re-supply it via create_artifact with "encoding":"base64".]`);
    }
    lines.push('');
  }
  lines.push('========== END ==========');
  lines.push('');
  return lines.join('\n');
}

/**
 * Open a saved app for editing: create a fresh normal conversation, drop the
 * app's source in as a single `app-source.md` attachment, and return the conv
 * so the renderer can navigate to it + pre-fill a draft. On any failure after
 * the conversation is created, the half-built conversation is deleted so no
 * orphan is left behind. "Edit" is a fork-and-modify flow — the conversation's
 * `create_artifact` produces a new artifact; the original saved app is
 * untouched.
 */
export async function openForEditing(
  userId: string,
  appId: string,
): Promise<Result<{ conversation: unknown; title: string; sourceFileName: string }>> {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const dir = savedAppDir(userId, safeId);
  try { if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory'); }
  catch { return { ok: false, error: 'app not found' }; }
  let title = DEFAULT_TITLE;
  let entry = 'index.html';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8'));
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title;
    entry = normaliseEntryRel(m?.entry);
  } catch { /* fallback */ }
  if (!fs.existsSync(path.join(dir, entry))) return { ok: false, error: 'app is missing its HTML entry' };

  const bundle = buildSourceBundle(dir, title);

  let conv: Awaited<ReturnType<typeof chats.createConversation>>;
  try {
    conv = await chats.createConversation(userId, {
      kind: 'normal',
      title: t('apps.edit_conv_title', { name: title }),
    });
  } catch (err) {
    log.warn('openForEditing createConversation failed', {
      user_id: maskId(userId),
      app_id: maskId(safeId),
      error: logErrorRef(err),
    });
    return { ok: false, error: `failed to create a conversation: ${(err as Error).message}` };
  }

  const up = await chatAttachments.uploadAttachment(userId, conv.conversation_id, SOURCE_BUNDLE_NAME, Buffer.from(bundle, 'utf8'));
  if (!up.ok) {
    // Roll back the conversation we just created so no empty conv is orphaned.
    try { await chats.deleteConversation(userId, conv.conversation_id); }
    catch (err) {
      log.warn('openForEditing rollback deleteConversation failed', {
        user_id: maskId(userId),
        app_id: maskId(safeId),
        conversation_id: maskId(conv.conversation_id),
        error: logErrorRef(err),
      });
    }
    return { ok: false, error: (up as { error?: string }).error || 'failed to attach the app source' };
  }
  const sourceFileName = ((up as { info?: { name?: string } }).info?.name) || SOURCE_BUNDLE_NAME;
  log.info('openForEditing completed', {
    user_id: maskId(userId),
    app_id: maskId(safeId),
    conversation_id: maskId(conv.conversation_id),
    source: logPathRef(sourceFileName),
  });
  return { ok: true, conversation: conv, title, sourceFileName };
}
