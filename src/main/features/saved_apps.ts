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
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userSavedAppsDir, savedAppDir } from '../paths';
import * as chatArtifacts from './chat_artifacts';
import * as chats from './chats';
import * as chatAttachments from './chat_attachments';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { logErrorRef, logPathRef, maskId } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';

const log = createLogger('saved_apps');

const META_FILENAME = '__orkas-meta.json';
const MAX_TITLE_LEN = 120;
const DEFAULT_TITLE = 'Interactive app';

// Source files that go into the editing bundle verbatim (everything in an
// artifact's served-extension set that is text). Anything else (png / woff /
// wasm / …) becomes a one-line `[binary asset …]` placeholder — it can't be
// represented in a text `.md` bundle, and changing it means re-supplying it
// via `create_artifact` with `"encoding":"base64"` anyway.
const TEXT_LIKE_EXTS = chatArtifacts.TEXT_EXTS;
const BUNDLE_RESOURCE_EXTS = chatArtifacts.SERVED_EXTS;
const HTML_ENTRY_EXTS: ReadonlySet<string> = new Set(['.html', '.htm']);
// Only application source files express an intent to save the surrounding
// HTML bundle. Images, media, fonts, manifests, data, and models remain valid
// copied resources but never advertise "Save as app" on their own.
const BUNDLE_TRIGGER_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.css', '.js', '.mjs',
]);
const BUNDLE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.next', '.vite', 'coverage',
]);
const SOURCE_BUNDLE_NAME = 'app-source.md';

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };
type ResolveCode = 'bad_input' | 'forbidden' | 'not_found';

export interface SavedAppMeta {
  title: string;
  sourceCid: string;
  sourceArtifactId: string;
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

function isRealSavedAppDirectory(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function readMeta(dir: string): Partial<SavedAppMeta> {
  const metaPath = path.join(dir, META_FILENAME);
  const st = fs.lstatSync(metaPath);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('invalid app metadata');
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
}

function savedAppRelPath(appId: string, rel = ''): string {
  return ['cloud/saved_apps', appId, rel].filter(Boolean).join('/');
}

function notifySavedAppDirty(appId: string, rel = ''): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('saved_apps', savedAppRelPath(appId, rel));
  } catch { /* features/sync stripped */ }
}

function notifySavedAppDeleted(appId: string, rel: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDeleted?: (relPath: string) => Promise<void> | void };
    void sync?.markDeleted?.(savedAppRelPath(appId, rel));
  } catch { /* features/sync stripped */ }
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

async function inferTitleFromHtml(entryPath: string, rootDir: string): Promise<string> {
  try {
    const html = await fsp.readFile(entryPath, 'utf8');
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

async function chooseHtmlEntryInDir(dir: string): Promise<string> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
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

async function collectBundleFiles(rootDir: string): Promise<{ ok: true; files: string[]; totalBytes: number } | { ok: false; reason: string }> {
  const files: string[] = [];
  let totalBytes = 0;
  const pending = [rootDir];
  try {
    while (pending.length) {
      const dir = pending.pop()!;
      if (!isPathAllowed(dir, [rootDir])) throw new Error('path traversal blocked');
      const directory = await fsp.opendir(dir);
      for await (const e of directory) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!shouldSkipBundleDir(e.name)) pending.push(abs);
        } else if (e.isFile() && shouldIncludeBundleFile(e.name)) {
          const st = await fsp.lstat(abs);
          if (!st.isFile() || !isPathAllowed(abs, [rootDir])) throw new Error('source file changed');
          files.push(abs);
          totalBytes += st.size;
        }
      }
    }
  } catch (err) { return { ok: false, reason: (err as Error).message || 'could not scan bundle' }; }
  return { ok: true, files, totalBytes };
}

async function findBundleRoot(target: string, opts: BundleInspectOptions = {}): Promise<{ ok: true; rootDir: string; entry: string } | { ok: false; reason: string }> {
  const abs = path.resolve(target);
  let st: fs.Stats;
  try { st = await fsp.stat(abs); }
  catch { return { ok: false, reason: 'file not found' }; }

  const roots = (opts.fenceRoots || []).filter(Boolean).map((r) => path.resolve(r));
  if (roots.length && !isInsideAnyRoot(abs, roots)) return { ok: false, reason: 'outside allowed workspace' };

  if (st.isDirectory()) {
    const entry = await chooseHtmlEntryInDir(abs);
    if (!entry) return { ok: false, reason: 'folder has no HTML entry' };
    return { ok: true, rootDir: abs, entry };
  }
  if (!st.isFile()) return { ok: false, reason: 'unsupported file type' };

  const ext = path.extname(abs).toLowerCase();
  if (!BUNDLE_TRIGGER_EXTS.has(ext)) return { ok: false, reason: 'unsupported file type' };
  if (HTML_ENTRY_EXTS.has(ext)) return { ok: true, rootDir: path.dirname(abs), entry: path.basename(abs) };

  const fence = nearestFenceRoot(abs, roots);
  let dir = path.dirname(abs);
  while (true) {
    const entry = await chooseHtmlEntryInDir(dir);
    if (entry) return { ok: true, rootDir: dir, entry };
    if (fence && path.resolve(dir) === fence) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { ok: false, reason: 'no HTML entry found for this file' };
}

async function inspectBundle(targetPath: string, opts: BundleInspectOptions): Promise<BundleInspection & { files?: string[] }> {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: 'path required' };
  const found = await findBundleRoot(targetPath, opts);
  if (!found.ok) return { ok: true, canSave: false, reason: (found as { ok: false; reason: string }).reason };
  const rootDir = found.rootDir;
  if (opts.fenceRoots?.length && !isInsideAnyRoot(rootDir, opts.fenceRoots)) {
    return { ok: true, canSave: false, reason: 'bundle is outside allowed workspace' };
  }
  const entry = found.entry;
  const entryAbs = path.join(rootDir, entry);
  let entryStat: fs.Stats;
  try { entryStat = await fsp.stat(entryAbs); }
  catch { return { ok: true, canSave: false, reason: 'bundle is missing its HTML entry' }; }
  if (!entryStat.isFile()) return { ok: true, canSave: false, reason: 'HTML entry is not a file' };
  const scanned = await collectBundleFiles(rootDir);
  if (!scanned.ok) return { ok: true, canSave: false, reason: (scanned as { ok: false; reason: string }).reason };
  const includesEntry = scanned.files.some((p) => path.resolve(p) === path.resolve(entryAbs));
  if (!includesEntry) return { ok: true, canSave: false, reason: 'HTML entry is not a supported app file' };
  return {
    ok: true,
    canSave: true,
    rootDir,
    entry,
    title: await inferTitleFromHtml(entryAbs, rootDir),
    files: scanned.files,
    fileCount: scanned.files.length,
    totalBytes: scanned.totalBytes,
  };
}

export async function inspectBundleFromPath(targetPath: string, opts: BundleInspectOptions = {}): Promise<BundleInspection> {
  const { files: _files, ...inspection } = await inspectBundle(targetPath, opts);
  return inspection;
}

async function copyBundleFiles(srcRoot: string, destRoot: string, files: string[]): Promise<{ fileCount: number; totalBytes: number }> {
  let totalBytes = 0;
  for (const src of files) {
    const rel = path.relative(srcRoot, src);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path traversal blocked');
    const dst = path.join(destRoot, rel);
    if (!(await fsp.lstat(src)).isFile() || !isPathAllowed(src, [srcRoot])) throw new Error('source file changed');
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    totalBytes += (await fsp.stat(dst)).size;
  }
  return { fileCount: files.length, totalBytes };
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
export async function saveFromArtifact(userId: string, cid: string, artifactId: string): Promise<Result<{ id: string; title: string }>> {
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
    await fsp.cp(srcDir, tmpDir, {
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
    await fsp.writeFile(path.join(tmpDir, META_FILENAME), JSON.stringify(meta, null, 2));
    await fsp.mkdir(path.dirname(destDir), { recursive: true });
    await fsp.rename(tmpDir, destDir);
  } catch (err) {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { await fsp.rm(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
export async function saveFromPath(
  userId: string,
  targetPath: string,
  opts: BundleInspectOptions & { title?: unknown; sourceCid?: unknown } = {},
): Promise<Result<{ id: string; title: string; rootDir: string; entry: string; fileCount: number; totalBytes: number }>> {
  const inspected = await inspectBundle(targetPath, opts);
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
    await fsp.mkdir(tmpDir, { recursive: true });
    const copied = await copyBundleFiles(inspected.rootDir, tmpDir, inspected.files!);
    if (!fs.existsSync(path.join(tmpDir, inspected.entry))) throw new Error('bundle is missing its HTML entry');
    const meta: SavedAppMeta = {
      title,
      sourceCid: typeof opts.sourceCid === 'string' ? opts.sourceCid : '',
      sourceArtifactId: '',
      entry: inspected.entry,
      savedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(tmpDir, META_FILENAME), JSON.stringify(meta, null, 2));
    await fsp.mkdir(path.dirname(destDir), { recursive: true });
    await fsp.rename(tmpDir, destDir);
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
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { await fsp.rm(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    log.warn('saveFromPath failed', {
      user_id: maskId(userId),
      target: logPathRef(targetPath),
      error: logErrorRef(err),
    });
    return { ok: false, error: `failed to save app: ${(err as Error).message}` };
  }
}

/** List the user's saved apps, newest save first. */
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
    if (!isRealSavedAppDirectory(dir)) continue;
    let meta: Partial<SavedAppMeta> = {};
    try { meta = readMeta(dir); }
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
  items.sort((a, b) => {
    const aSavedAt = Date.parse(a.savedAt);
    const bSavedAt = Date.parse(b.savedAt);
    const aHasSavedAt = Number.isFinite(aSavedAt);
    const bHasSavedAt = Number.isFinite(bSavedAt);
    if (aHasSavedAt !== bHasSavedAt) return aHasSavedAt ? -1 : 1;
    if (aHasSavedAt && bHasSavedAt && aSavedAt !== bSavedAt) return bSavedAt - aSavedAt;

    const byTitle = (a.title || a.id).localeCompare(b.title || b.id, undefined, {
      sensitivity: 'base',
      numeric: true,
    });
    return byTitle || a.id.localeCompare(b.id);
  });
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
  if (!isRealSavedAppDirectory(root)) {
    return { ok: false, code: 'not_found', error: 'app not found' };
  }
  let entry = 'index.html';
  try {
    const meta = readMeta(root);
    entry = normaliseEntryRel(meta.entry);
  } catch { /* old apps or corrupt meta fall back to index.html */ }
  const abs = path.resolve(root, entry);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'bad_input', error: 'path traversal blocked' };
  }
  if (!isPathAllowed(abs, [root])) {
    return { ok: false, code: 'not_found', error: 'app not found' };
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
  if (!isRealSavedAppDirectory(root)) {
    return { ok: false, code: 'not_found', error: 'not found' };
  }
  let entry = 'index.html';
  try {
    const meta = readMeta(root);
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
  if (!isPathAllowed(abs, [root])) {
    return { ok: false, code: 'forbidden', error: 'symlink escape blocked' };
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
  if (!isRealSavedAppDirectory(dir)) return { ok: false, error: 'app not found' };
  let meta: SavedAppMeta;
  try { meta = readMeta(dir) as SavedAppMeta; }
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
  let exists = false;
  try {
    const st = fs.lstatSync(dir);
    exists = true;
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, error: 'app not found' };
  } catch { /* idempotent missing delete */ }
  const deleted = exists ? listAppFilesRel(dir) : [];
  try {
    if (exists) fs.rmSync(dir, { recursive: true, force: true });
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
    const meta = readMeta(dir);
    entry = normaliseEntryRel(meta.entry);
  } catch { /* old apps */ }
  const lines: string[] = [
    `# Interactive app source — "${title}"`,
    '',
    `This is the current source of a self-contained interactive web app. Its current entry HTML is \`${entry}\`. To modify it: read the files below, then call \`create_artifact\` again with the updated \`files\` array — include a top-level HTML entry, use relative URLs for bundled files or HTTP(S) URLs for external resources, and the result is embedded in a sandboxed iframe.`,
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
  if (!isRealSavedAppDirectory(dir)) return { ok: false, error: 'app not found' };
  let title = DEFAULT_TITLE;
  try {
    const m = readMeta(dir);
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title;
  } catch { /* fallback */ }
  const resolvedEntry = resolveSavedAppIndex(userId, safeId);
  if (!resolvedEntry.ok) return { ok: false, error: 'app is missing its HTML entry' };

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
    try { await chats.deleteConversation(userId, conv.conversation_id, conv.project_id || null); }
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
