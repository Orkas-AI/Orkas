/**
 * "My Apps" — user-kept copies of `create_artifact` interactive web apps.
 *
 * An artifact created in chat lives in `<uid>/cloud/chat_artifacts/<cid>/<id>/`
 * and is purged when the conversation is deleted. The artifact card's `⋯` →
 * "Save" copies the bundle into a new persistent pool here:
 *   `<uid>/cloud/saved_apps/<appId>/{entry.html, ...siblings, __orkas-meta.json}`
 * Device-local and conversation-independent; never auto-purged (only the user's
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

import { userSavedAppsDir, savedAppDir, userAppEditsDir,webAppSandboxRoot,userLocalRoot,userAppDeletesDir, userCloudRoot } from '../paths';
import { metadataAppType, normalizeAppType, type AppType } from './web_apps/data-contract';
import { storedAppType } from './web_apps/commercial-entry';
import * as chatArtifacts from './chat_artifacts';
import * as chats from './chats';
import { conversationLayout } from '../util/project-layout';
import * as chatAttachments from './chat_attachments';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { renameWithRetrySync, writeTextAtomicSync } from '../storage';

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

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string; code?: string; feature?: string; message?: string };
type ResolveCode = 'bad_input' | 'forbidden' | 'not_found';

export interface SavedAppMeta {
  sourcePathKey?: string;
  browserStorage?: 'isolated-v1';
  appType?: AppType;
  description?: string;
  title: string;
  sourceCid: string;
  sourceArtifactId: string;
  entry?: string;
  savedAt: string; // ISO
}

export interface SavedAppListItem {
  appType?: AppType;
  description?: string;
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
  writeTextAtomicSync(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2));
}

// `<appId>.tmp-<8 hex>` staging folders (save copies and delete staging) are
// never apps. Ones registered here belong to an operation in this process;
// any other match is an interrupted leftover and is swept from the list path.
const STAGING_DIR_RE = /^[A-Za-z0-9_-]{1,64}\.tmp-[a-f0-9]{8}$/;
const activeStagingDirs = new Set<string>();
function stagingDir(destDir: string): string {
  const dir = `${destDir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  activeStagingDirs.add(dir);
  return dir;
}
function sweepStagingDirs(root: string, names: readonly string[], retained?: ReadonlySet<string>): void {
  for (const name of names) {
    if (!STAGING_DIR_RE.test(name)) continue;
    const dir = path.join(root, name);
    if (activeStagingDirs.has(dir) || retained?.has(dir)) continue;
    try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) continue; }
    catch { continue; }
    activeStagingDirs.add(dir);
    void fsp.rm(dir, { recursive: true, force: true })
      .catch((error) => log.warn('saved app staging sweep deferred', { error: logErrorSummary(error) }))
      .finally(() => activeStagingDirs.delete(dir));
  }
}
/** Stable caller-visible failure: known `app_*` codes pass through, anything
 *  else (errno text, absolute paths) collapses to `fallback`. */
function failureCode(err: unknown, fallback: string): string {
  const message = (err as Error)?.message;
  return typeof message === 'string' && /^app_[a-z_]+$/.test(message) ? message : fallback;
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

/** The absence of this additive marker preserves legacy browser storage. */
export function hasIsolatedBrowserStorage(uid: string, appId: string): boolean {
  try {
    const dir = savedAppDir(uid, safeAppId(appId));
    return isRealSavedAppDirectory(dir) && readMeta(dir).browserStorage === 'isolated-v1';
  } catch { return false; }
}

/** Read only bounded local metadata, including legacy app types. */
export function declaredSavedAppType(uid: string, appId: string): AppType | undefined {
  const dir = savedAppDir(uid, safeAppId(appId));
  if (!isRealSavedAppDirectory(dir)) throw new Error('app not found');
  return storedAppType(dir);
}
export async function resolveSavedAppType(uid: string, appId: string): Promise<AppType> {
  const id = safeAppId(appId), dir = savedAppDir(uid, id);
  if (!isRealSavedAppDirectory(dir)) throw new Error('app not found');
  return storedAppType(dir) ?? 'local';
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

function sanitiseDescription(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
}

/** Read optional display copy once on save; gallery reads never scan app sources. */
async function readHtmlDescription(entryPath: string): Promise<string> {
  let file: fsp.FileHandle | undefined;
  try {
    file = await fsp.open(entryPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const html = buffer.toString('utf8', 0, bytesRead)
      .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
    for (const tag of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const attrs: Record<string, string> = {};
      for (const attr of tag[0].matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
      }
      if (attrs.name?.toLowerCase() !== 'description') continue;
      const decoded = (attrs.content || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
        const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
        const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
      });
      return sanitiseDescription(decoded);
    }
  } catch { /* Optional metadata must not prevent saving an app. */ }
  finally { await file?.close().catch(() => {}); }
  return '';
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

async function inspectBundle(targetPath: string, opts: BundleInspectOptions): Promise<BundleInspection & { files?: string[]; realRoot?:string }> {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: 'path required' };
  const found = await findBundleRoot(targetPath, opts);
  if (!found.ok) return { ok: true, canSave: false, reason: (found as { ok: false; reason: string }).reason };
  const rootDir = found.rootDir;
  if (opts.fenceRoots?.length && !isInsideAnyRoot(rootDir, opts.fenceRoots)) {
    return { ok: true, canSave: false, reason: 'bundle is outside allowed workspace' };
  }
  // A sandbox root can contain unrelated user files; it is never an implicit app bundle.
  const realRoot = await fsp.realpath(rootDir);
  for (const root of opts.fenceRoots || []) {
    const realFence = await fsp.realpath(root).catch(() => path.resolve(root));
    if (path.relative(realFence, realRoot) === '') {
      return { ok: true, canSave: false, reason: 'app_bundle_root' };
    }
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
    realRoot,
    entry,
    title: await inferTitleFromHtml(entryAbs, rootDir),
    files: scanned.files,
    fileCount: scanned.files.length,
    totalBytes: scanned.totalBytes,
  };
}

export async function inspectBundleFromPath(targetPath: string, opts: BundleInspectOptions = {}): Promise<BundleInspection> {
  const { files: _files, realRoot: _realRoot, ...inspection } = await inspectBundle(targetPath, opts);
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

function localDatabase(uid:string,appId:string){const key=crypto.createHash('sha256').update(JSON.stringify(['saved',appId])).digest('hex');return {key,file:path.join(webAppSandboxRoot(uid,key,'local'),'data.sqlite')};}
async function appDefinition(dir:string){try{const {manifestSchema}=await import('./web_apps/catalog');const file=path.join(dir,'orkas-app.json');if((await fsp.stat(file)).size>65536)throw new Error('app_edit_data_migration');const definition=manifestSchema.parse(JSON.parse(await fsp.readFile(file,'utf8'))).data;if(!definition)throw new Error('app_edit_data_migration');return definition;}catch{throw new Error('app_edit_data_migration');}}
type DataSource = string | {rootDir:string};
export type SaveRecovery = {appId?:string;clearVersion:number;clearFingerprint:string};
async function dataTarget(uid:string,cid:string,source:DataSource) {
  if(typeof source==='string'&&!chatArtifacts.resolveArtifactDir(uid,cid,source).ok)return null;
  return getSaveTarget(uid,cid,typeof source==='string'?{artifactId:source}:source);
}
/** Author-only recovery facts; records never enter model context. */
export async function appDataImpact(uid:string,cid:string,source:DataSource):Promise<Result<{appId:string;records:number;version:number;fingerprint:string;tables:Array<{name:string;fields:string[];count:number}>}>>{
  const context=await dataTarget(uid,cid,source);if(!context)return {ok:false,error:'app_edit_target_missing'};
  let release:(()=>void)|undefined;
  try{const dir=savedAppDir(uid,context.appId);const fingerprint=fingerprintApp(dir);const {key,file}=localDatabase(uid,context.appId);const runtime=await import('./web_apps/runtime');release=runtime.holdAppData(uid,key);await runtime.closeAppData(uid,key);const {LocalAppData}=await import('./web_apps/data');const database=new LocalAppData(file,userLocalRoot(uid),await appDefinition(dir));try{const info:any=await database.call('internal.inspect',{});return {ok:true,appId:context.appId,records:info.records,version:info.version,fingerprint,tables:info.tables};}finally{await database.close();}}
  catch{return {ok:false,error:'app_edit_conflict'};}finally{release?.();}
}
/** Consistent private SQLite export, create-only at the user-selected destination. */
async function removeAppDataBackup(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    try { await fsp.rm(file + suffix, { force: true }); }
    catch (error) { log.warn('edited app data backup cleanup deferred', { error: logErrorSummary(error) }); }
  }
}

export async function exportAppData(uid:string,cid:string,source:DataSource,destination:string,expectedAppId?:string):Promise<Result>{
  const context=await dataTarget(uid,cid,source);if(!context)return {ok:false,error:'app_edit_target_missing'};
  if(expectedAppId!==undefined&&context.appId!==expectedAppId)return {ok:false,error:'app_edit_conflict'};
  let release:(()=>void)|undefined,temporary='';
  try{const {key,file}=localDatabase(uid,context.appId),runtime=await import('./web_apps/runtime');release=runtime.holdAppData(uid,key);await runtime.closeAppData(uid,key);temporary=file+'.backup-'+crypto.randomBytes(8).toString('hex');const {LocalAppData}=await import('./web_apps/data');const database=new LocalAppData(file,userLocalRoot(uid),await appDefinition(savedAppDir(uid,context.appId)));try{await database.call('internal.backup',{file:temporary});}finally{await database.close();}const users=await import('./users');if(users.getActiveUserId()!==uid)throw new Error('app_edit_conflict');await fsp.copyFile(temporary,destination,fs.constants.COPYFILE_EXCL);return {ok:true};}
  catch{return {ok:false,error:'app_edit_data_export_failed'};}
  finally {
    try { if (temporary) await removeAppDataBackup(temporary); }
    finally { release?.(); }
  }
}

/** Copy a chat artifact bundle into a new `saved_apps/<appId>/`. */
const activeEditSaves = new Map<string, number>();
const deferredEditCleanup = new Set<string>();
type SaveMode = 'new' | 'update' | 'auto';
type PathSource = { rootDir: string; bindingRoot: string; entry: string; explicitEntry: boolean; explicitTitle: boolean; title: string; files: string[]; appType: AppType; sourceCid: string };
const saveQueues = new Map<string, Promise<unknown>>();
const legacyPathSourceKey = (root: string) => crypto.createHash('sha256').update(path.resolve(root)).digest('hex');
const pathSourceKey = (root: string) => legacyPathSourceKey(fs.realpathSync(root));
const pathBindingFile = (uid: string, key: string) => path.join(userAppEditsDir(uid), `source-${key}.json`);
function readPathBinding(uid:string,key:string):{version:1|2;appId:string}|null {
  try {
    const binding=JSON.parse(fs.readFileSync(pathBindingFile(uid,key),'utf8'));
    if(!binding||![1,2].includes(binding.version))throw new Error('invalid save binding');
    return {version:binding.version,appId:safeAppId(binding.appId)};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw new Error('app_save_binding_unavailable');
  }
}

/** A source owns its current save destination; conversation-wide edit bindings are only a fallback. */
export async function getSaveTarget(uid: string, cid: string, source: {artifactId?: string; rootDir?: string; legacyRoot?: string}) {
  let id: string | undefined;
  if (source.artifactId) id = chatArtifacts.readArtifactMeta(uid, cid, source.artifactId, { strictSaveBinding: true })?.savedAppId;
  else if (source.rootDir) {
    const canonicalKey=pathSourceKey(source.rootDir),legacyKey=legacyPathSourceKey(source.legacyRoot??source.rootDir);
    const canonical=readPathBinding(uid,canonicalKey);
    // Version 2 explicitly owns every spelling, including a later Save as new.
    // Version 1 aliases are migrated lazily; ambiguous old copies need a choice.
    if(canonical?.version===2)id=canonical.appId;
    else {
      const legacy=legacyKey===canonicalKey?canonical:readPathBinding(uid,legacyKey);
      if(canonical&&legacy&&canonical.appId!==legacy.appId)throw new Error('app_save_binding_unavailable');
      id=canonical?.appId??legacy?.appId;
    }
  }
  // A deleted explicit destination must not fall back to an unrelated original.
  if (id) {
    const dir = savedAppDir(uid, safeAppId(id));
    if (!isRealSavedAppDirectory(dir)) return null;
    const meta = readMeta(dir);
    return { appId: id, title: sanitiseTitle(meta.title), appType: metadataAppType(meta.appType) ?? await resolveSavedAppType(uid, id) };
  }
  const edit = cid ? await getEditTarget(uid, cid) : null;
  if (edit) return isRealSavedAppDirectory(savedAppDir(uid, edit.appId)) ? edit : null;
  // Recover only unique historical provenance; duplicate copies are not a choice.
  const sourceKeys=source.rootDir?[pathSourceKey(source.rootDir),legacyPathSourceKey(source.legacyRoot??source.rootDir)]:[];
  const candidates = listSavedApps(uid).filter(app => {
    let meta: Partial<SavedAppMeta>;
    try { meta = readMeta(savedAppDir(uid, app.id)); } catch { return false; }
    return source.artifactId ? meta.sourceCid === cid && meta.sourceArtifactId === source.artifactId
      : sourceKeys.includes(meta.sourcePathKey!);
  });
  return candidates.length === 1 ? { appId: candidates[0].id, title: candidates[0].title,
    appType: candidates[0].appType ?? await resolveSavedAppType(uid, candidates[0].id) } : null;
}

function bindSave(uid: string, cid: string, artifactId: string, appId: string, source?: PathSource) {
  if (!source) return chatArtifacts.bindSavedApp(uid, cid, artifactId, appId);
  fs.mkdirSync(userAppEditsDir(uid), {recursive:true});
  writeTextAtomicSync(pathBindingFile(uid, pathSourceKey(source.rootDir)), JSON.stringify({version:2,appId}));
}

export async function saveFromArtifact(userId: string, cid: string, artifactId: string, mode: SaveMode = 'new', recovery?:SaveRecovery, source?: PathSource): Promise<Result<{ id: string; title: string; entry?:string }>> {
  const key = JSON.stringify([userId, cid]);
  activeEditSaves.set(key, (activeEditSaves.get(key) || 0) + 1);
  // Keep each conversation's recovery journal exclusive, and share the source
  // queue when different conversations save the same workspace bundle.
  const queueKeys = source ? [key, JSON.stringify([userId, 'source', pathSourceKey(source.rootDir)])] : [key];
  const previous = queueKeys.map(queueKey => saveQueues.get(queueKey)?.catch(() => {}));
  const saving = Promise.all(previous).then(() => saveArtifact(userId, cid, artifactId, mode, recovery, source));
  for (const queueKey of queueKeys) saveQueues.set(queueKey, saving);
  try { return await saving; }
  finally {
    for (const queueKey of queueKeys) if (saveQueues.get(queueKey) === saving) saveQueues.delete(queueKey);
    const remaining = activeEditSaves.get(key)! - 1;
    if (remaining) activeEditSaves.set(key, remaining);
    else {
      activeEditSaves.delete(key);
      if (deferredEditCleanup.delete(key)) await cleanupEditSnapshots(userId);
    }
  }
}

async function saveArtifact(userId: string, cid: string, artifactId: string, mode: SaveMode, recovery?:SaveRecovery, source?: PathSource): Promise<Result<{ id: string; title: string; entry?:string }>> {
  recoverEditedSaves(userId);
  const resolved = source ? {ok:true as const,dirPath:source.rootDir} : chatArtifacts.resolveArtifactDir(userId, cid, artifactId);
  if (!resolved.ok) return { ok: false, error: (resolved as { error?: string }).error || 'artifact not found' };
  const srcDir = (resolved as { dirPath: string }).dirPath;

  const srcMeta = chatArtifacts.readArtifactMeta(userId, cid, artifactId);
  let title = sanitiseTitle(source?.title ?? srcMeta?.title);
  const editContext = readEditContext(userId, cid);
  let context: EditContext | null = null;
  // Legacy type metadata remains readable; saving never changes application identity based on type.
  let appType: AppType;
  try {
    appType = source?.appType ?? await resolveArtifactAppType(userId, cid, artifactId, srcMeta);
    if (mode !== 'new') {
      const target = await getSaveTarget(userId, cid, source ? {rootDir:source.rootDir,legacyRoot:source.bindingRoot} : {artifactId});
      if (target) {
        // Updating a durable destination preserves its capability identity;
        // another task's creation defaults belong only to new applications.
        appType = target.appType;
        context = {version:1,...target,fingerprint:fingerprintApp(savedAppDir(userId,target.appId))};
      }
    }
  } catch (err) {
    log.warn('saveFromArtifact edit binding unavailable', { error: logErrorSummary(err) });
    return { ok: false, error: 'app_edit_target_missing' };
  }
  if(recovery&&(!context||(source&&!recovery.appId)||(recovery.appId!==undefined&&recovery.appId!==context.appId)
    ||!Number.isInteger(recovery.clearVersion)||typeof recovery.clearFingerprint!=='string'
    ||recovery.clearFingerprint!==context.fingerprint))return {ok:false,error:'app_edit_conflict'};
  mode = context ? 'update' : 'new';
  const entry = source && context && !source.explicitEntry
    ? normaliseEntryRel(readMeta(savedAppDir(userId,context.appId)).entry) : source?.entry ?? 'index.html';
  if(source&&context&&!source.explicitEntry&&!source.explicitTitle)title=context.title;

  let appId = '';
  let destDir = '';
  try {
    const minted = mode === 'update' && context
      ? { appId: context.appId, destDir: savedAppDir(userId, context.appId) }
      : mintAppId(userId);
    appId = minted.appId;
    destDir = minted.destDir;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const tmpDir = stagingDir(destDir);
  let release:(()=>void)|undefined,dataFile='',candidate='';
  try {
    // Copy everything except the source `__orkas-meta.json` (we write a fresh
    // one stamped with the source provenance).
    if (source) {
      await fsp.mkdir(tmpDir,{recursive:true});
      await copyBundleFiles(srcDir,tmpDir,source.files);
    } else await fsp.cp(srcDir, tmpDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== META_FILENAME,
    });
    // Binary placeholders in the editing attachment are not replacement bytes.
    // Omitted binary resources survive; explicit artifact files take precedence.
    if (editContext && !source) {
      // Updates retain assets from their remembered destination, which can be
      // an independently edited copy rather than the task's original snapshot.
      const snapshot = mode === 'update' && context
        ? savedAppDir(userId, context.appId)
        : path.join(editContextDir(userId, cid), 'snapshot');
      for (const rel of listAppFilesRel(snapshot)) {
        if (rel === META_FILENAME || TEXT_LIKE_EXTS.has(path.extname(rel).toLowerCase())) continue;
        const target = path.join(tmpDir, rel);
        if (!fs.existsSync(target)) {
          const source = path.join(snapshot, rel);
          if (!isPathAllowed(source, [snapshot])) throw new Error('app_edit_snapshot_invalid');
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(source, target);
        }
      }
    }
    if (!fs.existsSync(path.join(tmpDir, entry))) {
      throw new Error('source artifact is missing index.html');
    }
    if (source && appType === 'web') {
      const {manifestSchema} = await import('./web_apps/catalog');
      const file = path.join(tmpDir,'orkas-app.json');
      const manifest = manifestSchema.parse(fs.existsSync(file) ? JSON.parse(await fsp.readFile(file,'utf8')) : {sdkVersion:1,capabilities:[]});
      if (manifest.capabilities.some(capability => capability !== 'data') || (manifest.capabilities.includes('data') && !manifest.data)) throw new Error('app_web_interfaces_required');
      await fsp.writeFile(file,JSON.stringify({...manifest,minimumClient:'1.9.0'}));
    }
    const meta: SavedAppMeta = {
      ...(mode === 'new' || hasIsolatedBrowserStorage(userId, appId) ? { browserStorage: 'isolated-v1' as const } : {}),
      appType,
      ...(source ? {sourcePathKey:pathSourceKey(source.rootDir),entry} : {}),
      description: await readHtmlDescription(path.join(tmpDir, entry)),
      title,
      sourceCid: source ? source.sourceCid : cid,
      sourceArtifactId: typeof artifactId === 'string' ? artifactId : '',
      savedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(tmpDir, META_FILENAME), JSON.stringify(meta, null, 2));
    await fsp.mkdir(path.dirname(destDir), { recursive: true });
    if (mode === 'update' && context) {
      const local=localDatabase(userId,appId);dataFile=local.file;
      if(fs.existsSync(dataFile)){
        const runtime=await import('./web_apps/runtime');release=runtime.holdAppData(userId,local.key);await runtime.closeAppData(userId,local.key);
        const {LocalAppData}=await import('./web_apps/data');candidate=dataFile+'.backup-'+crypto.randomBytes(8).toString('hex');
        const oldDefinition=await appDefinition(destDir),definition=await appDefinition(tmpDir);
        const original=new LocalAppData(dataFile,userLocalRoot(userId),oldDefinition);
        try{const info:any=await original.call('internal.inspect',{});if(recovery&&(recovery.clearVersion!==info.version||recovery.clearFingerprint!==context.fingerprint))throw new Error('app_edit_conflict');await original.call('internal.backup',{file:candidate});}finally{await original.close();}
        if(recovery){const staged=new LocalAppData(candidate,userLocalRoot(userId),oldDefinition);try{await staged.call('internal.reset',{version:recovery.clearVersion});}finally{await staged.close();}}
        const database=new LocalAppData(candidate,userLocalRoot(userId),definition,200*1024*1024,true);
        try{await database.call('internal.check',{});}catch{throw new Error('app_edit_data_migration');}finally{await database.close();}
      }
      // No await between the comparison and swap: other main-process actions
      // cannot silently overwrite a newer save, rename or deletion.
      if((await import('./users')).getActiveUserId()!==userId)throw new Error('app_edit_conflict');
      if (!isRealSavedAppDirectory(destDir)) throw new Error('app_edit_target_missing');
      if (fingerprintApp(destDir) !== context.fingerprint) throw new Error('app_edit_conflict');
      const backup = `${tmpDir}.previous`;
      const journal = {version:1,appId,temporary:path.basename(tmpDir),before:context.fingerprint,after:fingerprintApp(tmpDir),...(candidate?{dataCandidate:path.basename(candidate)}:{})};
      const journalPath=path.join(editContextDir(userId,cid),'save-journal.json');
      fs.mkdirSync(path.dirname(journalPath),{recursive:true});
      const journalFd=fs.openSync(journalPath,'w',0o600);
      try { fs.writeFileSync(journalFd,JSON.stringify(journal));fs.fsyncSync(journalFd); } finally {fs.closeSync(journalFd);}
      fs.renameSync(destDir, backup);
      try {
        fs.renameSync(tmpDir, destDir);
        if(candidate){fs.renameSync(dataFile,dataFile+'.previous');try{fs.renameSync(candidate,dataFile);}catch(error){fs.renameSync(dataFile+'.previous',dataFile);throw error;}}
      } catch (err) { if(fs.existsSync(destDir))fs.rmSync(destDir,{recursive:true,force:true});fs.renameSync(backup, destDir);throw err; }
      try {
        if (editContext?.appId === appId) refreshEditSnapshot(userId,cid,context,destDir);
        fs.rmSync(backup, { recursive: true, force: true });
        if(candidate)fs.rmSync(dataFile+'.previous',{force:true});
        fs.rmSync(journalPath,{force:true});
        if(candidate){const {key}=localDatabase(userId,appId);await (await import('./web_apps/runtime')).checkpointAppData(userId,key,dataFile,await appDefinition(destDir));}
      } catch (err) {
        // The save boundary already completed. Cleanup/presentation cannot
        // turn it into a failed save or remove the newly written application.
        log.warn('edited app post-save cleanup deferred', { error: logErrorSummary(err) });
      }
    } else {
      await fsp.rename(tmpDir, destDir);
      // Do not report a successful copy if its source association could not be persisted.
      bindSave(userId,cid,artifactId,appId,source);
    }
  } catch (err) {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (mode !== 'update') {
      try { await fsp.rm(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    log.warn('saveFromArtifact failed', {
      user_id: maskId(userId),
      conversation_id: maskId(cid),
      artifact_id: maskId(artifactId),
      error: logErrorSummary(err),
    });
    return { ok: false, error: failureCode(err, 'app_save_failed') };
  }
  finally {
    activeStagingDirs.delete(tmpDir);
    try { if (candidate) await removeAppDataBackup(candidate); }
    finally { release?.(); }
  }
  if (mode === 'update') {
    try { bindSave(userId,cid,artifactId,appId,source); }
    catch (error) { log.warn('saved app association recovery deferred',{error:logErrorSummary(error)}); }
  }
  log.info('saveFromArtifact completed', {
    user_id: maskId(userId),
    app_id: maskId(appId),
    conversation_id: maskId(cid),
    artifact_id: maskId(artifactId),
    save_mode: mode,
  });
  return { ok: true, id: appId, title, ...(source?{entry}:{}) };
}

/** Copy a workspace/file-tab-discovered HTML app bundle into saved_apps. */
export async function saveFromPath(
  userId: string,
  targetPath: string,
  opts: BundleInspectOptions & { title?: unknown; sourceCid?: unknown; mode?: SaveMode; recovery?:SaveRecovery } = {},
): Promise<Result<{ id: string; title: string; rootDir: string; entry: string; fileCount: number; totalBytes: number }>> {
  const inspected = await inspectBundle(targetPath, opts);
  if (!inspected.ok) return { ok: false, error: (inspected as { ok: false; error: string }).error };
  if (!inspected.canSave) return { ok: false, error: (inspected as { ok: true; canSave: false; reason: string }).reason };
  try { storedAppType(inspected.rootDir); }
  catch { return { ok: false, error: 'app_edit_target_missing' }; }

  const title = sanitiseTitle(opts.title || inspected.title);
  const sourceCid=typeof opts.sourceCid==='string'?opts.sourceCid:'';
  const assistance=sourceCid?(await chats.getConversationMetadata(userId,sourceCid))?.assistance:undefined;
  let editType:AppType|undefined;
  try{editType=sourceCid?(await getEditTarget(userId,sourceCid))?.appType:undefined;}
  catch(err){log.warn('saveFromPath edit binding unavailable',{error:logErrorSummary(err)});return {ok:false,error:'app_edit_target_missing'};}
  const appType:AppType=editType??(assistance?.kind==='app_creation'?assistance.appType??'local':storedAppType(inspected.rootDir)??'local');
  const realRoot=inspected.realRoot!;
  const operationCid = sourceCid || `file-${pathSourceKey(realRoot)}`;
  const result = await saveFromArtifact(userId,operationCid,'',opts.mode ?? 'new',opts.recovery,{
    rootDir:realRoot,bindingRoot:inspected.rootDir,entry:inspected.entry,
    explicitEntry:/\.html?$/i.test(targetPath)&&fs.statSync(targetPath).isFile(),
    explicitTitle:!!opts.title,title,files:inspected.files!.map(file=>path.join(realRoot,path.relative(inspected.rootDir,file))),appType,sourceCid,
  });
  if (result.ok === false) return result;
  return {...result,rootDir:inspected.rootDir,entry:result.entry!,fileCount:inspected.fileCount,totalBytes:inspected.totalBytes};
}

/** List the user's saved apps, newest save first. */
export function listSavedApps(userId: string): SavedAppListItem[] {
  const retained = recoverEditedSaves(userId);
  void recoverInterruptedDeletes(userId);
  void cleanupEditSnapshots(userId, true);
  const root = userSavedAppsDir(userId);
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch { return []; } // pool dir not created yet
  sweepStagingDirs(root, names, retained);
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
        error: logErrorSummary(err),
      });
    }
    items.push({
      appType: metadataAppType(meta.appType),
      description: sanitiseDescription(meta.description),
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

/** Listing never contacts an account or publication service. */
export async function listResolvedSavedApps(uid: string): Promise<SavedAppListItem[]> {
  const items = listSavedApps(uid);
  for (const item of items) {
    try { item.appType = storedAppType(savedAppDir(uid, item.id)) ?? 'local'; }
    catch { item.appType = undefined; }
  }
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
): { ok: true; absPath: string; mime: string; entry: string; appType: AppType } | { ok: false; code: ResolveCode; error: string } {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  const root = path.resolve(savedAppDir(userId, safeId));
  if (!isRealSavedAppDirectory(root)) {
    return { ok: false, code: 'not_found', error: 'not found' };
  }
  let entry = 'index.html';
  let appType: AppType = 'local';
  try {
    const meta = readMeta(root);
    appType = normalizeAppType(meta.appType);
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
  return { ok: true, absPath: abs, mime: savedAppMimeFor(rel), entry, appType };
}

/** Rename a saved app (rewrites `__orkas-meta.json`). */
export function renameSavedApp(userId: string, appId: string, title: unknown): Result<{ title: string }> {
  recoverEditedSaves(userId);
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title required' };
  const dir = savedAppDir(userId, safeId);
  if (!isRealSavedAppDirectory(dir)) return { ok: false, error: 'app not found' };
  let meta: SavedAppMeta;
  try { meta = readMeta(dir) as SavedAppMeta; }
  catch { return { ok: false, error: 'app not found' }; }
  meta.title = sanitiseTitle(title);
  try { writeMeta(dir, meta); }
  catch (err) {
    log.warn('renameSavedApp failed', { user_id: maskId(userId), app_id: maskId(safeId), error: logErrorSummary(err) });
    return { ok: false, error: 'app_rename_failed' };
  }
  log.info('renameSavedApp completed', { user_id: maskId(userId), app_id: maskId(safeId) });
  return { ok: true, title: meta.title };
}

/** Delete a saved app (`rm -rf saved_apps/<appId>/`). */
export async function deleteSavedApp(userId: string, appId: string): Promise<Result> {
  recoverEditedSaves(userId);
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  await deleteRecoveries.get(userId);
  return deleteLocalSavedApp(userId, safeId);
}

async function deleteLocalSavedApp(userId: string, safeId: string): Promise<Result> {
  const dir = savedAppDir(userId, safeId);
  let exists = false;
  try {
    const st = fs.lstatSync(dir);
    exists = true;
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, error: 'app not found' };
  } catch { /* idempotent missing delete */ }
  let deleted: string[];
  try { deleted = exists ? listAppFilesRel(dir) : []; }
  catch (err) {
    log.warn('deleteSavedApp inventory unavailable', { user_id: maskId(userId), app_id: maskId(safeId), error: logErrorSummary(err) });
    return { ok: false, error: 'app_delete_failed' };
  }
  // The app folder moves aside atomically first and returns if its data cannot
  // be removed, so a failed delete leaves the app listed and sync untouched.
  // A durable intent recorded before anything moves lets a stopped delete finish.
  const staged = exists ? stagingDir(dir) : '', intent = deleteIntentPath(userId, safeId);
  activeDeleteIntents.add(intent);
  try {
    let release:(()=>void)|undefined,key='',cloudFiles:string[]=[];
    try {
      key=appDataKey(safeId);
      const runtime=await import('./web_apps/runtime');release=runtime.holdAppData(userId,key);
      await runtime.closeAppData(userId,key);
      cloudFiles=listAppDataCloudFiles(userId,key);
      writeDeleteIntent(userId,{version:1,appId:safeId,files:deleted,cloudFiles});
      if (exists) renameWithRetrySync(dir, staged);
      try { await removeAppData(userId,key); }
      catch (err) { if (exists) renameWithRetrySync(staged, dir); throw err; }
    } catch (err) {
      log.warn('deleteSavedApp failed', { user_id: maskId(userId), app_id: maskId(safeId), error: logErrorSummary(err) });
      // A restored (or never moved) app voids the intent; a missing one keeps it for recovery.
      if (!exists || isRealSavedAppDirectory(dir)) clearDeleteIntent(intent);
      activeStagingDirs.delete(staged);
      release?.();
      return { ok: false, error: 'app_delete_failed' };
    }
    release?.();
    // Committed: the app and its data are gone. Cleanup or sync notification
    // failures cannot turn this into a failed delete; leftovers are swept later.
    if (staged) {
      try { await fsp.rm(staged, { recursive: true, force: true }); }
      catch (err) { log.warn('deleteSavedApp staging cleanup deferred', { error: logErrorSummary(err) }); }
      finally { activeStagingDirs.delete(staged); }
    }
    log.info('deleteSavedApp completed', { user_id: maskId(userId), app_id: maskId(safeId) });
    clearDeleteIntent(intent);
    return { ok: true };
  } finally { activeDeleteIntents.delete(intent); }
}

const appDataKey = (appId: string) => crypto.createHash('sha256').update(JSON.stringify(['saved', appId])).digest('hex');
function listAppDataCloudFiles(uid: string, key: string): string[] {
  const local=webAppSandboxRoot(uid,key,'local'),cloud=webAppSandboxRoot(uid,key,'cloud');
  for(const root of [local,cloud])if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())throw new Error('app data unavailable');
  return fs.existsSync(cloud)?listAppFilesRel(cloud):[];
}
async function removeAppData(uid: string, key: string): Promise<void> {
  await fsp.rm(webAppSandboxRoot(uid,key,'local'),{recursive:true,force:true});
  await fsp.rm(webAppSandboxRoot(uid,key,'cloud'),{recursive:true,force:true});
}

// ── Interrupted delete recovery ──────────────────────────────────────────
// Only a recorded intent proves the user deleted an app. Data without a local
// app folder may belong to an app still arriving through personal sync, so it
// is never removed on its own. Intents live in the machine-private domain.
interface DeleteIntent { version: 1; appId: string; files: string[]; cloudFiles: string[] }
const activeDeleteIntents = new Set<string>();
const deleteRecoveries = new Map<string, Promise<void>>();
const DELETE_INTENT_RE = /^([A-Za-z0-9_-]{1,64})\.json$/;
const deleteIntentPath = (uid: string, appId: string) => path.join(userAppDeletesDir(uid), `${appId}.json`);
function writeDeleteIntent(uid: string, intent: DeleteIntent): void {
  const file = deleteIntentPath(uid, intent.appId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A torn write is harmless: it can only precede the app-folder move, and a
  // present app folder voids the intent without reading it.
  const fd = fs.openSync(file, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function clearDeleteIntent(file: string): void {
  try { fs.rmSync(file, { force: true }); }
  catch (err) { log.warn('saved app delete intent cleanup deferred', { error: logErrorSummary(err) }); }
}
function isIntentRel(rel: unknown): rel is string {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 1024 && !/[\\\0]/.test(rel)
    && rel.split('/').every(seg => !!seg && seg !== '.' && seg !== '..');
}
function readDeleteIntent(file: string, appId: string): DeleteIntent {
  if (!fs.lstatSync(file).isFile()) throw new Error('invalid delete intent');
  const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (intent?.version !== 1 || intent.appId !== appId || !Array.isArray(intent.files) || !Array.isArray(intent.cloudFiles)
    || !intent.files.every(isIntentRel) || !intent.cloudFiles.every(isIntentRel)) throw new Error('invalid delete intent');
  return intent;
}
function recoverInterruptedDeletes(uid: string): Promise<void> {
  const running = deleteRecoveries.get(uid);
  if (running) return running;
  let appIds: string[];
  try { appIds = fs.readdirSync(userAppDeletesDir(uid)).map(name => DELETE_INTENT_RE.exec(name)?.[1]).filter((id): id is string => !!id); }
  catch { return Promise.resolve(); } // no intents recorded
  if (!appIds.length) return Promise.resolve();
  const work = (async () => { for (const appId of appIds) await recoverDelete(uid, appId); })()
    .finally(() => deleteRecoveries.delete(uid));
  deleteRecoveries.set(uid, work);
  return work;
}
async function recoverDelete(uid: string, appId: string): Promise<void> {
  const file = deleteIntentPath(uid, appId);
  if (activeDeleteIntents.has(file)) return;
  try {
    // A present app folder means the delete never committed or was rolled back.
    if (fs.existsSync(savedAppDir(uid, appId)) || isSymlink(savedAppDir(uid, appId))) {
      clearDeleteIntent(file);
      log.info('saved app delete intent voided', { app_id: maskId(appId) });
      return;
    }
    // Tombstones go to the active account's personal sync; another account waits for its own session.
    const users = await import('./users');
    if (users.getActiveUserId() !== uid) return;
    const intent = readDeleteIntent(file, appId), key = appDataKey(appId);
    const runtime = await import('./web_apps/runtime'), release = runtime.holdAppData(uid, key);
    try { await runtime.closeAppData(uid, key); listAppDataCloudFiles(uid, key); await removeAppData(uid, key); }
    finally { release(); }
    clearDeleteIntent(file);
    log.info('saved app delete recovery completed', { app_id: maskId(appId), files: intent.files.length, data_files: intent.cloudFiles.length });
  } catch (error) { log.warn('saved app delete recovery deferred', { app_id: maskId(appId), error: logErrorSummary(error) }); }
}
function isSymlink(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

// ── "Edit in a new conversation" ─────────────────────────────────────────

/** Integrity and deletion inventories must never turn unreadable data into
 * an empty subtree. Callers own rollback or post-commit recovery. */
function listAppFilesRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
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

interface EditContext { appType?: AppType; version: 1; appId: string; title: string; fingerprint: string }

function refreshEditSnapshot(uid: string,cid: string,context: EditContext,source: string) {
  const root=editContextDir(uid,cid),snapshot=path.join(root,'snapshot'),next=path.join(root,'snapshot-next'),previous=path.join(root,'snapshot-previous');
  fs.rmSync(next,{recursive:true,force:true});fs.cpSync(source,next,{recursive:true,dereference:false});
  fs.rmSync(previous,{recursive:true,force:true});
  if(fs.existsSync(snapshot))fs.renameSync(snapshot,previous);
  try {fs.renameSync(next,snapshot);} catch(error) {if(fs.existsSync(previous))fs.renameSync(previous,snapshot);throw error;}
  context.fingerprint=fingerprintApp(source);
  writeTextAtomicSync(path.join(root,'context.json'),JSON.stringify(context));
  fs.rmSync(previous,{recursive:true,force:true});
}

function recoverEditedSaves(uid: string) {
  const retained = new Set<string>();
  const edits=userAppEditsDir(uid);
  if(!fs.existsSync(edits))return retained;
  for(const cid of fs.readdirSync(edits)) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(cid))continue;
    const root=editContextDir(uid,cid),journalPath=path.join(root,'save-journal.json');
    if(!fs.existsSync(journalPath)||fs.lstatSync(root).isSymbolicLink()||fs.lstatSync(journalPath).isSymbolicLink())continue;
    try {
      const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
      const appId=safeAppId(journal.appId);
      if(journal.version!==1||!new RegExp('^'+appId+'\\.tmp-[a-f0-9]{8}$').test(journal.temporary)
        || !/^[a-f0-9]{64}$/.test(journal.before)||!/^[a-f0-9]{64}$/.test(journal.after))throw new Error('invalid edit save journal');
      const destination=savedAppDir(uid,appId),temporary=path.join(userSavedAppsDir(uid),journal.temporary),backup=temporary+'.previous';
      retained.add(temporary); retained.add(backup);
      const current = isRealSavedAppDirectory(destination) ? fingerprintApp(destination) : null;
      const rollback = isRealSavedAppDirectory(backup) ? fingerprintApp(backup) : null;
      if (current !== journal.before && current !== journal.after && (current !== null || rollback !== journal.before)) throw new Error('app_edit_conflict');
      if(journal.dataCandidate){
        if(!/^data\.sqlite\.backup-[a-f0-9]{16}$/.test(journal.dataCandidate))throw new Error('invalid data save journal');
        const {file}=localDatabase(uid,appId),candidate=path.join(path.dirname(file),journal.dataCandidate);
        if(fs.existsSync(candidate)){
          if(isRealSavedAppDirectory(backup)){if(fs.existsSync(destination))fs.rmSync(destination,{recursive:true,force:true});fs.renameSync(backup,destination);}
          if(fs.existsSync(file+'.previous')){fs.rmSync(file,{force:true});fs.renameSync(file+'.previous',file);}
          for(const suffix of ['', '-wal','-shm'])fs.rmSync(candidate+suffix,{force:true});
        }else if(fs.existsSync(file+'.previous'))fs.rmSync(file+'.previous',{force:true});
      }
      if(!fs.existsSync(destination)&&isRealSavedAppDirectory(backup)&&fingerprintApp(backup)===journal.before)fs.renameSync(backup,destination);
      if(isRealSavedAppDirectory(destination)&&fingerprintApp(destination)===journal.after){
        const context=readEditContext(uid,cid);if(context&&context.appId===appId)refreshEditSnapshot(uid,cid,context,destination);
      }
      fs.rmSync(temporary,{recursive:true,force:true});fs.rmSync(backup,{recursive:true,force:true});fs.rmSync(journalPath,{force:true});
      retained.delete(temporary); retained.delete(backup);
      log.info('edited app save recovery completed');
    } catch(error) {log.warn('edited app save recovery deferred',{error:logErrorSummary(error)});}
  }
  return retained;
}
const editCleanupRunning = new Map<string, Promise<void>>();
const editCleanupLast = new Map<string, number>();

/** Snapshot ownership follows the edit conversation, including recycle recovery. */
export function cleanupEditSnapshots(uid: string, background = false, cid?: string): Promise<void> {
  const running = editCleanupRunning.get(uid);
  if (running) return background ? running : running.then(() => cleanupEditSnapshots(uid, false, cid));
  if (background && Date.now() - (editCleanupLast.get(uid) || 0) < 60_000) return Promise.resolve();
  editCleanupLast.set(uid, Date.now());
  const run = (async () => {
    const root = userAppEditsDir(uid);
    try {
      if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error('unsafe edit root');
      // Capture candidates before ownership so a concurrently created edit is never swept.
      const candidates = (await fsp.readdir(root, { withFileTypes: true })).filter(entry => !cid || entry.name === cid);
      if (!candidates.length) return;
      const recycle = await import('./recycle_bin');
      await recycle.withEditSnapshotRetention(uid, async () => {
        const retained = await chats.retainedConversationIdsForEditCleanup(uid);
        for (const cid of await recycle.retainedEditConversationIds(uid)) retained.add(cid);
        for (const entry of candidates) {
          if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name) || retained.has(entry.name)) continue;
          const dir = editContextDir(uid, entry.name);
          const activeKey = JSON.stringify([uid, entry.name]);
          if (activeEditSaves.has(activeKey)) { deferredEditCleanup.add(activeKey); continue; }
          try { await fsp.lstat(path.join(dir, 'save-journal.json')); continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await fsp.rm(dir, { recursive: true, force: true });
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('edit snapshot cleanup deferred', { error: logErrorSummary(error) });
    }
  })().finally(() => { editCleanupRunning.delete(uid); });
  editCleanupRunning.set(uid, run);
  return run;
}

function editContextDir(userId: string, cid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cid)) throw new Error('invalid cid');
  return path.join(userAppEditsDir(userId), cid);
}
function fingerprintApp(dir: string): string {
  const digest = crypto.createHash('sha256');
  for (const rel of listAppFilesRel(dir)) {
    const target = path.join(dir, rel);
    if (!isPathAllowed(target, [dir])) throw new Error('app_edit_snapshot_invalid');
    digest.update(JSON.stringify(rel)).update('\0').update(fs.readFileSync(target)).update('\0');
  }
  return digest.digest('hex');
}
/** Same fingerprint spelling as save/recovery, without reading large source
 * files synchronously while a user is opening the editor. */
async function fingerprintAppAsync(dir: string): Promise<string> {
  const digest = crypto.createHash('sha256');
  for (const rel of listAppFilesRel(dir)) {
    const target = path.join(dir, rel);
    if (!isPathAllowed(target, [dir])) throw new Error('app_edit_snapshot_invalid');
    digest.update(JSON.stringify(rel)).update('\0');
    for await (const chunk of fs.createReadStream(target)) digest.update(chunk as Buffer);
    digest.update('\0');
  }
  return digest.digest('hex');
}
function readEditContext(userId: string, cid: string): EditContext | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(editContextDir(userId, cid), 'context.json'), 'utf8'));
    if (data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.fingerprint)) return null;
    safeAppId(data.appId);
    if (Object.hasOwn(data, 'appType') && !metadataAppType(data.appType)) return null;
    return {...data, appType: metadataAppType(data.appType)};
  } catch { return null; }
}
export async function getEditTarget(userId: string, cid: string): Promise<{ appId: string; title: string; appType: AppType } | null> {
  const context = readEditContext(userId, cid);
  if (!context && (fs.existsSync(path.join(editContextDir(userId, cid),'context.json')) || fs.existsSync(path.join(editContextDir(userId, cid),'snapshot')))) throw Object.assign(new Error(t('web_apps.error_E_CLOSED')), { code: 'app_edit_context_unavailable' });
  if (!context) return null;
  const dir = savedAppDir(userId, context.appId);
  const persisted = isRealSavedAppDirectory(dir) ? storedAppType(dir) : undefined;
  const appType = context.appType === 'web' || persisted === 'web' ? 'web' : context.appType ?? persisted ?? 'local';
  return { appId: context.appId, title: context.title, appType };
}

/** Read the structured task/edit binding without any publication lookup. */
export async function boundAppType(userId: string, cid: string): Promise<AppType | undefined> {
  const target = await getEditTarget(userId, cid); if (target) return target.appType;
  const conversation = await chats.getConversationMetadata(userId, cid);
  // The sidebar's normalizing reader is deliberately tolerant. Its recovery
  // record cannot grant a local capability when that binding is unreadable.
  const file = conversationLayout(userId, cid, conversation?.project_id).metaFile;
  let stat: fs.Stats | undefined;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Application task binding unavailable');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Application task binding unavailable');
    if (raw.assistance?.kind === 'app_creation') {
      const value = raw.assistance.appType;
      const stored = metadataAppType(value);
      if (value !== undefined && !stored) throw new Error('Application task binding unavailable');
      if (stored === 'web') return 'web';
    }
  }
  const assistance = conversation?.assistance;
  return assistance?.kind === 'app_creation' ? assistance.appType ?? 'local' : undefined;
}

/** The one fallback order for an artifact on every surface (label, runtime,
 *  save, share): stored metadata, then the structured task binding, then
 *  local. A damaged binding throws so each caller can fail closed. */
export async function resolveArtifactAppType(userId:string,cid:string,artifactId:string,meta=chatArtifacts.readArtifactMeta(userId,cid,artifactId)):Promise<AppType>{
  const resolved = chatArtifacts.resolveArtifactDir(userId, cid, artifactId);
  if (!resolved.ok) throw new Error('artifact not found');
  const bound = await boundAppType(userId, cid);
  if (bound === 'web') return bound;
  return storedAppType(resolved.dirPath) ?? bound ?? 'local';
}

/** Resolve only canonical managed pools; HTML content and manifest capabilities
 * never decide whether an app is commercial. No directory inventory is needed. */
export async function managedPathAppType(userId: string, file: string): Promise<AppType | undefined> {
  const relative = path.relative(userCloudRoot(userId), path.resolve(file));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) return undefined;
  const segments = relative.split(path.sep);
  if (segments[0] === 'saved_apps' && segments[1]) return resolveSavedAppType(userId, segments[1]);
  const start = segments[0] === 'chat_artifacts' ? 1
    : segments[0] === 'projects' && segments[2] === 'chat_artifacts' ? 3 : -1;
  if (start < 0 || !segments[start] || !segments[start + 1]) return undefined;
  const resolved = chatArtifacts.resolveArtifactDir(userId, segments[start], segments[start + 1]);
  if (!resolved.ok || !isPathAllowed(file, [resolved.dirPath])) throw new Error('Invalid app source');
  return resolveArtifactAppType(userId, segments[start], segments[start + 1]);
}

/** Opening needs only local identity. An unresolved/damaged edit binding
 *  can render, but must not inherit the ordinary new-artifact local authority. */
export async function declaredArtifactAppType(userId:string,cid:string,artifactId:string):Promise<AppType|undefined>{
  const meta=chatArtifacts.readArtifactMeta(userId,cid,artifactId);
  if(meta?.appType)return meta.appType;
  const context=readEditContext(userId,cid);
  if(context)return context.appType??storedAppType(savedAppDir(userId,context.appId))??'local';
  if(fs.existsSync(path.join(editContextDir(userId,cid),'context.json')) || fs.existsSync(path.join(editContextDir(userId,cid),'snapshot')))return undefined;
  return await boundAppType(userId,cid)??'local';
}

/** Build the single-`.md` source bundle handed to the editing conversation as
 *  an attachment. Plain `FILE:` rules (not fenced code blocks) so the app's own
 *  source — which may contain ``` — can't break the bundle. Binary assets are
 *  represented as placeholder lines (a text bundle can't carry their bytes). */
async function buildSourceBundle(dir: string, title: string): Promise<string> {
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
      lines.push(await fsp.readFile(abs, 'utf8'));
    } else {
      let kb = 1;
      try { kb = Math.max(1, Math.round((await fsp.stat(abs)).size / 1024)); } catch { /* ignore */ }
      lines.push(`[binary asset: ${rel} — ~${kb} KB; kept from the original app. To change it, re-supply it via create_artifact with "encoding":"base64".]`);
    }
    lines.push('');
  }
  lines.push('========== END ==========');
  lines.push('');
  return lines.join('\n');
}

/** Best-effort removal of a half-built edit conversation; failures are logged
 *  redacted so the caller still reports the original edit failure. */
async function rollbackEditConversation(
  userId: string,
  appId: string,
  editingDir: string,
  conv: { conversation_id: string; project_id?: string | null },
): Promise<void> {
  try { await fsp.rm(editingDir, { recursive: true, force: true }); }
  catch (err) { log.warn('openForEditing rollback context cleanup failed', { error: logErrorSummary(err) }); }
  try { await chats.deleteConversation(userId, conv.conversation_id, conv.project_id || null); }
  catch (err) {
    log.warn('openForEditing rollback deleteConversation failed', {
      user_id: maskId(userId),
      app_id: maskId(appId),
      conversation_id: maskId(conv.conversation_id),
      error: logErrorSummary(err),
    });
  }
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
  let appType: AppType = 'local';
  try {
    const m = readMeta(dir);
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title;
  } catch { /* fallback */ }
  try { appType = await resolveSavedAppType(userId, safeId); }
  catch (error) {
    log.warn('saved app type recovery unavailable', { error: logErrorSummary(error) });
    return { ok: false, error: t('web_apps.error_E_FAILED') };
  }
  const resolvedEntry = resolveSavedAppIndex(userId, safeId);
  if (!resolvedEntry.ok) return { ok: false, error: 'app is missing its HTML entry' };

  let originalFingerprint: string;
  try { originalFingerprint = await fingerprintAppAsync(dir); }
  catch (err) {
    log.warn('openForEditing snapshot failed', { error: logErrorSummary(err) });
    return { ok: false, error: 'app_edit_snapshot_failed' };
  }

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
      error: logErrorSummary(err),
    });
    return { ok: false, error: 'app_edit_open_failed' };
  }

  const editingDir = editContextDir(userId, conv.conversation_id);
  let bundle: string;
  let up: Awaited<ReturnType<typeof chatAttachments.uploadAttachment>>;
  try {
    const snapshot = path.join(editingDir, 'snapshot');
    await fsp.cp(dir, snapshot, { recursive: true, dereference: false });
    if (await fingerprintAppAsync(snapshot) !== originalFingerprint || await fingerprintAppAsync(dir) !== originalFingerprint) {
      throw new Error('app_edit_conflict');
    }
    const context: EditContext = { version: 1, appId: safeId, title, appType, fingerprint: originalFingerprint };
    await fsp.writeFile(path.join(editingDir, 'context.json'), JSON.stringify(context));
    bundle = await buildSourceBundle(snapshot, title);
    up = await chatAttachments.uploadAttachment(userId, conv.conversation_id, SOURCE_BUNDLE_NAME, Buffer.from(bundle, 'utf8'));
  } catch (err) {
    log.warn('openForEditing snapshot failed', { error: logErrorSummary(err) });
    await rollbackEditConversation(userId, safeId, editingDir, conv);
    return { ok: false, error: 'app_edit_snapshot_failed' };
  }
  if (!up.ok) {
    // Roll back the conversation we just created so no empty conv is orphaned.
    await rollbackEditConversation(userId, safeId, editingDir, conv);
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
