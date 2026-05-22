/**
 * Project-scoped files.
 *
 * Storage: `<uid>/cloud/projects/<pid>/files/<name>`.
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

const log = createLogger('project_files');

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const PDF_EXT = '.pdf';
const DOCX_EXT = '.docx';
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS, PDF_EXT, DOCX_EXT, ...IMAGE_EXTS, ...VIDEO_EXTS,
]);

const MAX_BYTES_TEXT = 5 * 1024 * 1024;
const MAX_BYTES_DOCX = 20 * 1024 * 1024;
const MAX_BYTES_IMAGE = 20 * 1024 * 1024;
const MAX_BYTES_PDF = 100 * 1024 * 1024;
const MAX_BYTES_VIDEO = 200 * 1024 * 1024;
const MAX_FILENAME_LEN = 200;

export type ProjectFileKind = 'text' | 'pdf' | 'docx' | 'image' | 'video';

export interface ProjectFileInfo {
  name: string;
  path: string;
  bytes: number;
  kind: ProjectFileKind;
  mtime: number;
}

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

function safeProjectId(projectId: unknown): string {
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId required');
  if (projectId.includes('/') || projectId.includes('\\') || projectId.includes('\x00') || projectId === '.' || projectId === '..') {
    throw new Error('invalid projectId');
  }
  return projectId;
}

function safeFileName(name: unknown): string {
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = require('./sync') as { markDirty?: (domain: string, relPath: string) => void };
    sync.markDirty?.('projects', `cloud/projects/${projectId}/files`);
  } catch { /* features/sync stripped */ }
}

function infoFor(absPath: string): ProjectFileInfo | null {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return null; }
  if (!st.isFile()) return null;
  const name = path.basename(absPath);
  return {
    name,
    path: absPath,
    bytes: st.size,
    kind: kindOfName(name),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

export async function listProjectFiles(userId: string, projectId: string): Promise<ProjectFileInfo[]> {
  let dir: string;
  try {
    const pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return [];
    dir = projectFilesDir(userId, pid);
  } catch { return []; }

  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const out: ProjectFileInfo[] = [];
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const e of items) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    const info = infoFor(path.join(dir, e.name));
    if (info) out.push(info);
  }
  return out;
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

  const target = uniqueTarget(dir, safeName);
  try { fs.writeFileSync(target, buf); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const info = infoFor(target);
  if (!info) return { ok: false, error: 'write failed' };
  _notifyDirty(pid);
  log.info(`upload user=${userId} pid=${pid} name=${info.name} kind=${info.kind} bytes=${info.bytes}`);
  return { ok: true, info };
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
  const abs = path.resolve(dir, safeName);
  if (path.relative(path.resolve(dir), abs).startsWith('..')) return { ok: false, error: 'forbidden' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
  try { fs.unlinkSync(abs); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  try { invalidateFileCache(userId, abs); }
  catch (err) { log.warn(`invalidate cache ${abs}: ${(err as Error).message}`); }
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
  _notifyDirty(pid);
  return { ok: true };
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
  const abs = path.resolve(root, safeName);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'forbidden' };
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_found' };
  return { ok: true, absPath: abs, kind: kindOfName(safeName) };
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function listProjectFilePathsForPrompt(userId: string, projectId: string): Promise<string[]> {
  let dir: string;
  try {
    const pid = safeProjectId(projectId);
    if (!await projectExists(userId, pid)) return [];
    dir = projectFilesDir(userId, pid);
  } catch { return []; }

  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  return items
    .filter(e => e.isFile() && !e.name.startsWith('.') && ALLOWED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map(e => path.join(dir, e.name));
}

export async function buildProjectFilesManifest(userId: string, projectId: string): Promise<string> {
  const files = await listProjectFilePathsForPrompt(userId, projectId);
  if (!files.length) return '';
  const entries = files.map((p) => `<file path="${escapeAttr(p)}"/>`);
  return [
    '<project-files>',
    'These files are available to every conversation in this project. Use read_file with the listed path when the task needs content; use stat_file first only when metadata or extraction is needed.',
    ...entries,
    '</project-files>',
  ].join('\n');
}

export async function buildProjectFilesCliBlock(userId: string, projectId: string): Promise<string> {
  const files = await listProjectFilePathsForPrompt(userId, projectId);
  if (!files.length) return '';
  const lines = files.map(p => `- ${p}`);
  return `## Project files\n${lines.join('\n')}`;
}
