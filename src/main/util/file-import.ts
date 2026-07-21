import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface LocalImportSource {
  absPath: string;
  bytes: number;
  mtimeMs: number;
  sha1: string;
}

const _importLocks = new Map<string, Promise<void>>();

/**
 * Serialize the small check-name/copy/publish critical section for one Library.
 * Hashing stays outside the lock, while duplicate checks and unique-name
 * allocation cannot race with another renderer window or native picker.
 */
export async function withLocalImportLock<T>(key: string, worker: () => Promise<T>): Promise<T> {
  const previous = _importLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  _importLocks.set(key, tail);
  await previous.catch(() => {});
  try {
    return await worker();
  } finally {
    release();
    if (_importLocks.get(key) === tail) _importLocks.delete(key);
  }
}

export async function inspectLocalImportSource(absPath: string, maxBytes: number): Promise<LocalImportSource> {
  if (!path.isAbsolute(absPath)) throw Object.assign(new Error('source path must be absolute'), { code: 'E_IMPORT_SOURCE' });
  const lst = await fsp.lstat(absPath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw Object.assign(new Error('source must be a regular file'), { code: 'E_IMPORT_SOURCE' });
  }
  if (lst.size > maxBytes) {
    throw Object.assign(new Error(`file exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`), {
      code: 'E_FILE_TOO_LARGE',
      bytes: lst.size,
    });
  }
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(absPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return { absPath, bytes: lst.size, mtimeMs: lst.mtimeMs, sha1: hash.digest('hex') };
}

/** Reject an existing symlink anywhere below an owned Library root. */
export async function assertLocalImportTarget(root: string, target: string): Promise<void> {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('invalid import target'), { code: 'E_IMPORT_TARGET' });
  }
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error('symbolic links are not supported for Library imports'), {
          code: 'E_IMPORT_TARGET_SYMLINK',
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
}

/** Copy without loading file bytes into the Electron main-process heap. */
export async function copyLocalFileAtomic(
  source: string,
  target: string,
  expected?: Pick<LocalImportSource, 'bytes' | 'mtimeMs'>,
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.orkas-import-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fsp.copyFile(source, temp);
    if (expected) {
      const [sourceAfter, tempAfter] = await Promise.all([fsp.stat(source), fsp.stat(temp)]);
      if (
        !sourceAfter.isFile()
        || tempAfter.size !== expected.bytes
        || sourceAfter.size !== expected.bytes
        || Math.abs(sourceAfter.mtimeMs - expected.mtimeMs) > 1
      ) {
        throw Object.assign(new Error('source file changed during import; retry the upload'), {
          code: 'E_IMPORT_SOURCE_CHANGED',
        });
      }
    }
    try {
      await fsp.rename(temp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      await fsp.rm(target, { force: true });
      await fsp.rename(temp, target);
    }
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}
