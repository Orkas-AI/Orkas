/**
 * Project-scoped files.
 *
 * Storage: `<uid>/cloud/projects/<pid>/files/<relative/path>`.
 * These files belong to the project, not a single conversation, so every
 * conversation inside the project receives a lightweight file-list prompt and
 * file tools get read-only access to this directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectFilesDir } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { invalidateFileCache } from './file_indexer';
import { projectExists } from './projects';
import * as projectLibraryIndexer from './project_library_indexer';

const log = createLogger('project_files');

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const PDF_EXT = '.pdf';
const DOCX_EXT = '.docx';
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS, PDF_EXT, DOCX_EXT, ...IMAGE_EXTS, ...VIDEO_EXTS,
]);
const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const MAX_BYTES_TEXT = 5 * 1024 * 1024;
const MAX_BYTES_DOCX = 20 * 1024 * 1024;
const MAX_BYTES_IMAGE = 20 * 1024 * 1024;
const MAX_BYTES_PDF = 100 * 1024 * 1024;
const MAX_BYTES_VIDEO = 200 * 1024 * 1024;
const MAX_FILENAME_LEN = 200;

export type ProjectFileKind = 'text' | 'pdf' | 'docx' | 'image' | 'video';

export interface ProjectFileInfo {
  name: string;
  relPath: string;
  type: 'file';
  path: string;
  bytes: number;
  kind: ProjectFileKind;
  mtime: number;
}

export interface ProjectDirInfo {
  name: string;
  relPath: string;
  type: 'dir';
  path: string;
  mtime: number;
  children: ProjectLibraryNode[];
}

export type ProjectLibraryNode = ProjectFileInfo | ProjectDirInfo;

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

function safeProjectId(projectId: unknown): string {
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId required');
  if (projectId.includes('/') || projectId.includes('\\') || projectId.includes('\x00') || projectId === '.' || projectId === '..') {
    throw new Error('invalid projectId');
  }
  return projectId;
}

function normaliseProjectRelPath(input: unknown, kind: 'file' | 'dir', allowEmpty = false): string {
  if (typeof input !== 'string') throw new Error(kind === 'file' ? 'filename required' : 'folder required');
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  if (raw.includes('\x00') || raw.startsWith('/') || path.isAbsolute(raw)) {
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  if (parts.some((part) => part.length > MAX_FILENAME_LEN)) {
    throw new Error(kind === 'file' ? 'filename too long' : 'folder name too long');
  }
  const rel = parts.join('/');
  if (kind === 'dir') return rel;
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(t('errors.unsupported_file_ext', { ext: ext || t('errors.unsupported_file_no_ext') }));
  }
  return rel;
}

function safeFileName(name: unknown): string {
  return normaliseProjectRelPath(name, 'file');
}

function safeDirPath(name: unknown, allowEmpty = false): string {
  return normaliseProjectRelPath(name, 'dir', allowEmpty);
}

function relPathFor(root: string, absPath: string): string {
  return path.relative(path.resolve(root), path.resolve(absPath)).split(path.sep).join('/');
}

function resolveUnder(root: string, relPath: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, relPath);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
  return abs;
}

function kindOfName(name: string): ProjectFileKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === PDF_EXT) return 'pdf';
  if (ext === DOCX_EXT) return 'docx';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'text';
}

function maxBytesFor(name: string): number {
  const ext = path.extname(name).toLowerCase();
  if (ext === PDF_EXT) return MAX_BYTES_PDF;
  if (ext === DOCX_EXT) return MAX_BYTES_DOCX;
  if (IMAGE_EXTS.has(ext)) return MAX_BYTES_IMAGE;
  if (VIDEO_EXTS.has(ext)) return MAX_BYTES_VIDEO;
  return MAX_BYTES_TEXT;
}

function uniqueTarget(dir: string, name: string): string {
  const original = path.join(dir, name);
  if (!fs.existsSync(original)) return original;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? stamp : `${stamp}-${i}`;
    const target = path.join(dir, `${stem}-${suffix}${ext}`);
    if (!fs.existsSync(target)) return target;
  }
  return path.join(dir, `${stem}-${stamp}-${Date.now()}${ext}`);
}

async function ensureProjectFilesDir(userId: string, projectId: string): Promise<string> {
  const pid = safeProjectId(projectId);
  if (!await projectExists(userId, pid)) throw new Error('not_found');
  const dir = projectFilesDir(userId, pid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _notifyDirty(projectId: string): void {
  void projectId;
}

function _notifyDeleted(projectId: string, relPath: string): void {
  void projectId;
  void relPath;
}

function infoFor(absPath: string, root?: string): ProjectFileInfo | null {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return null; }
  if (!st.isFile()) return null;
  const name = path.basename(absPath);
  const relPath = root ? relPathFor(root, absPath) : name;
  return {
    name,
    relPath,
    type: 'file',
    path: absPath,
    bytes: st.size,
    kind: kindOfName(name),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function dirInfoFor(absPath: string, root: string, children: ProjectLibraryNode[]): ProjectDirInfo | null {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return null; }
  if (!st.isDirectory()) return null;
  return {
    name: path.basename(absPath),
    relPath: relPathFor(root, absPath),
    type: 'dir',
    path: absPath,
    mtime: Math.floor(st.mtimeMs / 1000),
    children,
  };
}

function sortDirents(items: fs.Dirent[]): fs.Dirent[] {
  return items.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
  });
}

function walkProjectTree(absDir: string, root: string): ProjectLibraryNode[] {
  let items: fs.Dirent[];
  try { items = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return []; }
  const out: ProjectLibraryNode[] = [];
  for (const e of sortDirents(items)) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      const info = dirInfoFor(abs, root, walkProjectTree(abs, root));
      if (info) out.push(info);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    const info = infoFor(abs, root);
    if (info) out.push(info);
  }
  return out;
}

function flattenFiles(nodes: ProjectLibraryNode[]): ProjectFileInfo[] {
  const out: ProjectFileInfo[] = [];
  for (const node of nodes) {
    if (node.type === 'file') out.push(node);
    else out.push(...flattenFiles(node.children || []));
  }
  return out;
}

function filesUnderEntry(absPath: string, root: string): ProjectFileInfo[] {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return []; }
  if (st.isFile()) {
    const info = infoFor(absPath, root);
    return info ? [info] : [];
  }
  if (st.isDirectory()) return flattenFiles(walkProjectTree(absPath, root));
  return [];
}

export async function listProjectFileTree(userId: string, projectId: string): Promise<ProjectLibraryNode[]> {
  let dir: string;
  try {
    const pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return [];
    dir = projectFilesDir(userId, pid);
  } catch { return []; }
  return walkProjectTree(dir, dir);
}

export async function listProjectFiles(userId: string, projectId: string): Promise<ProjectFileInfo[]> {
  return flattenFiles(await listProjectFileTree(userId, projectId));
}

export async function uploadProjectFile(
  userId: string,
  projectId: string,
  name: string,
  raw: Buffer | Uint8Array | null | undefined,
): Promise<Result<{ info: ProjectFileInfo }>> {
  let safeName: string;
  let pid: string;
  let dir: string;
  try {
    safeName = safeFileName(name);
    pid = safeProjectId(projectId);
    dir = await ensureProjectFilesDir(userId, pid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  const cap = maxBytesFor(safeName);
  if (buf.length > cap) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(cap / 1024 / 1024) }) };
  }
  if (TEXT_EXTS.has(path.extname(safeName).toLowerCase())) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').length !== buf.length) {
      return { ok: false, error: t('errors.not_utf8') };
    }
  }

  const parent = path.dirname(safeName);
  const targetDir = parent === '.' ? dir : resolveUnder(dir, parent);
  try { fs.mkdirSync(targetDir, { recursive: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const target = uniqueTarget(targetDir, path.basename(safeName));
  try { fs.writeFileSync(target, buf); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const info = infoFor(target, dir);
  if (!info) return { ok: false, error: 'write failed' };
  projectLibraryIndexer.enqueue(userId, pid, info.relPath, 'upsert');
  _notifyDirty(pid);
  log.info(`upload user=${userId} pid=${pid} name=${info.relPath} kind=${info.kind} bytes=${info.bytes}`);
  return { ok: true, info };
}

export async function createProjectDir(
  userId: string,
  projectId: string,
  relPath: string,
): Promise<Result<{ path: string }>> {
  let safePath: string;
  let pid: string;
  let root: string;
  try {
    safePath = safeDirPath(relPath);
    pid = safeProjectId(projectId);
    root = await ensureProjectFilesDir(userId, pid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  let abs: string;
  try { abs = resolveUnder(root, safePath); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(abs)) {
    try {
      if (fs.statSync(abs).isDirectory()) return { ok: true, path: safePath };
      return { ok: false, error: 'target_exists' };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  }
  try { fs.mkdirSync(abs, { recursive: false }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  _notifyDirty(pid);
  return { ok: true, path: safePath };
}

export async function deleteProjectFile(userId: string, projectId: string, name: string): Promise<Result> {
  let safeName: string;
  let pid: string;
  try {
    safeName = safeFileName(name);
    pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const dir = projectFilesDir(userId, pid);
  let abs: string;
  try { abs = resolveUnder(dir, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, error: 'not_found' };
  } catch { return { ok: false, error: 'not_found' }; }
  try { fs.unlinkSync(abs); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  projectLibraryIndexer.enqueue(userId, pid, safeName, 'delete');
  _notifyDeleted(pid, safeName);
  try { invalidateFileCache(userId, abs); }
  catch (err) { log.warn(`invalidate cache ${abs}: ${(err as Error).message}`); }
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
  _notifyDirty(pid);
  return { ok: true };
}

export async function deleteProjectEntry(userId: string, projectId: string, name: string): Promise<Result> {
  let safeName: string;
  let pid: string;
  try {
    safeName = safeDirPath(name);
    pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const root = path.resolve(projectFilesDir(userId, pid));
  let abs: string;
  try { abs = resolveUnder(root, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_found' };

  const files = filesUnderEntry(abs, root);
  try {
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: false });
    else fs.unlinkSync(abs);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  for (const file of files) {
    projectLibraryIndexer.enqueue(userId, pid, file.relPath, 'delete');
    _notifyDeleted(pid, file.relPath);
    try { invalidateFileCache(userId, file.path); }
    catch (err) { log.warn(`invalidate cache ${file.path}: ${(err as Error).message}`); }
  }
  _notifyDirty(pid);
  return { ok: true };
}

export async function createProjectTextFile(
  userId: string,
  projectId: string,
  name: string,
): Promise<Result<{ info: ProjectFileInfo }>> {
  let safeName: string;
  try {
    safeName = safeFileName(name);
    if (!TEXT_EXTS.has(path.extname(safeName).toLowerCase())) {
      return { ok: false, error: 'not a text file' };
    }
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  return uploadProjectFile(userId, projectId, safeName, Buffer.from('', 'utf8'));
}

export async function resolveProjectFileAbsPath(
  userId: string,
  projectId: string,
  name: string,
): Promise<Result<{ absPath: string; kind: ProjectFileKind }>> {
  let safeName: string;
  let pid: string;
  try {
    safeName = safeFileName(name);
    pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const root = path.resolve(projectFilesDir(userId, pid));
  let abs: string;
  try { abs = resolveUnder(root, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_found' };
  return { ok: true, absPath: abs, kind: kindOfName(safeName) };
}

export async function readProjectTextFile(
  userId: string,
  projectId: string,
  name: string,
): Promise<Result<{ content: string; name: string }>> {
  const r = await resolveProjectFileAbsPath(userId, projectId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'text') return { ok: false, error: 'binary file cannot be read as text' };
  let st: fs.Stats;
  try { st = fs.statSync(r.absPath); }
  catch { return { ok: false, error: 'not_found' }; }
  if (st.size > MAX_BYTES_TEXT) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(MAX_BYTES_TEXT / 1024 / 1024) }) };
  }
  try {
    let content = fs.readFileSync(r.absPath, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return { ok: true, content, name };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

export async function updateProjectTextFile(
  userId: string,
  projectId: string,
  name: string,
  content: string,
): Promise<Result<{ name: string }>> {
  const r = await resolveProjectFileAbsPath(userId, projectId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'text') return { ok: false, error: 'binary file cannot be edited as text' };
  const body = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BYTES_TEXT) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(MAX_BYTES_TEXT / 1024 / 1024) }) };
  }
  try { fs.writeFileSync(r.absPath, body, 'utf8'); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  try { invalidateFileCache(userId, r.absPath); }
  catch (err) { log.warn(`invalidate cache ${r.absPath}: ${(err as Error).message}`); }
  projectLibraryIndexer.enqueue(userId, projectId, name, 'upsert');
  _notifyDirty(projectId);
  return { ok: true, name };
}

export async function renameProjectFile(
  userId: string,
  projectId: string,
  oldName: string,
  nextName: string,
): Promise<Result<{ oldName: string; name: string; type: 'file' | 'dir'; info?: ProjectFileInfo }>> {
  let safeOld: string;
  let pid: string;
  try {
    safeOld = safeDirPath(oldName);
    pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  const root = path.resolve(projectFilesDir(userId, pid));
  let src: string;
  try { src = resolveUnder(root, safeOld); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(src); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_found' };

  const type: 'file' | 'dir' = st.isDirectory() ? 'dir' : 'file';
  let safeNext: string;
  try {
    safeNext = type === 'dir' ? safeDirPath(nextName) : safeFileName(nextName);
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  if (safeOld === safeNext) {
    if (type === 'dir') return { ok: true, oldName: safeOld, name: safeNext, type };
    const current = infoFor(src, root);
    return current ? { ok: true, oldName: safeOld, name: safeNext, type, info: current } : { ok: false, error: 'not_found' };
  }
  if (type === 'dir' && safeNext.startsWith(`${safeOld}/`)) return { ok: false, error: 'forbidden' };

  let dst: string;
  try { dst = resolveUnder(root, safeNext); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(dst)) return { ok: false, error: 'target_exists' };
  if (!fs.existsSync(path.dirname(dst))) return { ok: false, error: 'not_found' };
  const movedFiles = filesUnderEntry(src, root);
  try { fs.renameSync(src, dst); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  for (const file of movedFiles) {
    const nextRel = type === 'dir'
      ? `${safeNext}${file.relPath.slice(safeOld.length)}`
      : safeNext;
    const nextAbs = resolveUnder(root, nextRel);
    try { invalidateFileCache(userId, file.path); invalidateFileCache(userId, nextAbs); }
    catch (err) { log.warn(`invalidate cache rename ${file.relPath}: ${(err as Error).message}`); }
    projectLibraryIndexer.enqueue(userId, pid, file.relPath, 'delete');
    projectLibraryIndexer.enqueue(userId, pid, nextRel, 'upsert');
    _notifyDeleted(pid, file.relPath);
  }
  _notifyDirty(pid);
  if (type === 'dir') return { ok: true, oldName: safeOld, name: safeNext, type };
  const info = infoFor(dst, root);
  if (!info) return { ok: false, error: 'rename failed' };
  return { ok: true, oldName: safeOld, name: info.relPath, type, info };
}

export async function readProjectImage(
  userId: string,
  projectId: string,
  name: string,
): Promise<Result<{ base64: string; mediaType: string; bytes: number }>> {
  const r = await resolveProjectFileAbsPath(userId, projectId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'image') return { ok: false, error: 'not an image' };
  const mediaType = IMAGE_MEDIA_TYPE[path.extname(r.absPath).toLowerCase()];
  if (!mediaType) return { ok: false, error: 'not an image' };
  try {
    const buf = fs.readFileSync(r.absPath);
    return { ok: true, base64: buf.toString('base64'), mediaType, bytes: buf.length };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

export async function readProjectDocxHtml(
  userId: string,
  projectId: string,
  name: string,
): Promise<Result<{ html: string }>> {
  const r = await resolveProjectFileAbsPath(userId, projectId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'docx') return { ok: false, error: 'not a docx file' };
  try {
    const { docxBufferToHtml } = await import('../util/extract-docx');
    const buf = fs.readFileSync(r.absPath);
    const html = await docxBufferToHtml(buf);
    return { ok: true, html };
  } catch (err) {
    log.warn(`project docx→html ${projectId}/${name}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function getProjectFilesRoot(userId: string, projectId: string): Promise<string | null> {
  try {
    const pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return null;
    return projectFilesDir(userId, pid);
  } catch { return null; }
}

export async function isProjectFilePath(userId: string, projectId: string, absPath: string): Promise<boolean> {
  const root = await getProjectFilesRoot(userId, projectId);
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
