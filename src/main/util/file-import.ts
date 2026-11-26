import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileSystemForPath } from './user-file-fs';

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
      // Publish the completed inode without replacing a path that appeared
      // after the caller allocated the name. `rename` overwrites silently on
      // POSIX and the old Windows fallback explicitly deleted the winner.
      await fsp.link(temp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw Object.assign(new Error('import target already exists'), {
          code: 'E_IMPORT_TARGET_EXISTS',
        });
      }
      throw err;
    }
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}


/** Copy a validated entry into a create-only destination. Namespace and source
 * validation belong to the feature caller. Only a directory root claimed by
 * this operation may be rolled back; native exclusive file copies own theirs. */
export function copyLocalEntryExclusiveSync(source: string, target: string, directory: boolean): void {
  if (!directory) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return;
  }
  const sourceMode = fs.statSync(source).mode;
  fs.mkdirSync(target);
  let owned: fs.BigIntStats | undefined;
  try {
    owned = fs.lstatSync(target, { bigint: true });
    fs.cpSync(source, target, {
      recursive: true, errorOnExist: true, force: false,
      dereference: false, mode: fs.constants.COPYFILE_EXCL,
    });
    fs.chmodSync(target, sourceMode);
  } catch (error) {
    try {
      const current = fs.lstatSync(target, { bigint: true });
      if (owned && current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch { /* best-effort rollback of an owned partial copy */ }
    throw error;
  }
}

export interface LocalEntryRevision {
  root: string;
  entries: Array<{ relative: string; stamp: string; digest?: string }>;
}

export type BeforeLocalEntryDelete = () => boolean | Promise<() => boolean>;

const MAX_REVISION_ENTRIES = 10_000;
const MAX_REVISION_PATH_BYTES = 1024 * 1024;
const REVISION_READ_BYTES = 128 * 1024;

function revisionStamp(stat: fs.BigIntStats): string | undefined {
  if (!stat.isFile() && !stat.isDirectory()) return undefined;
  return [stat.isDirectory() ? 'dir' : 'file', stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function revisionDigest(absolute: string, stat: fs.BigIntStats, stamp: string,
  buffer: Buffer, deadline: number): Promise<string> {
  const handle = await fsp.open(absolute, 'r');
  try {
    if (revisionStamp(await handle.stat({ bigint: true })) !== stamp) throw new Error('revision changed');
    const hash = crypto.createHash('sha256');
    const size = Number(stat.size);
    for (let offset = 0; offset < size;) {
      if (performance.now() > deadline) throw new Error('revision budget exceeded');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new Error('revision changed');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (performance.now() > deadline || revisionStamp(await fsp.lstat(absolute, { bigint: true })) !== stamp) {
      throw new Error('revision changed');
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function revisionDigestSync(absolute: string, stat: fs.BigIntStats, stamp: string,
  buffer: Buffer, deadline: number): string {
  const fd = fs.openSync(absolute, 'r');
  try {
    if (revisionStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) throw new Error('revision changed');
    const hash = crypto.createHash('sha256');
    const size = Number(stat.size);
    for (let offset = 0; offset < size;) {
      if (performance.now() > deadline) throw new Error('revision budget exceeded');
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new Error('revision changed');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (performance.now() > deadline || revisionStamp(fs.lstatSync(absolute, { bigint: true })) !== stamp) {
      throw new Error('revision changed');
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Same-size writes can leave the entire stat stamp unchanged. Capture file
 * contents and every directory so a move can also detect those edits. */
export async function captureLocalEntryRevision(root: string): Promise<LocalEntryRevision | undefined> {
  const entries: LocalEntryRevision['entries'] = [];
  const deadline = performance.now() + 5000;
  const buffer = Buffer.allocUnsafe(REVISION_READ_BYTES);
  let pathBytes = 0;
  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    pathBytes += Buffer.byteLength(relative);
    if (depth > 64 || entries.length >= MAX_REVISION_ENTRIES
      || pathBytes > MAX_REVISION_PATH_BYTES || performance.now() > deadline) throw new Error('revision budget exceeded');
    const stat = await fsp.lstat(absolute, { bigint: true });
    const stamp = revisionStamp(stat);
    if (!stamp) throw new Error('unsupported revision source');
    if (stat.isFile()) {
      entries.push({ relative, stamp, digest: await revisionDigest(absolute, stat, stamp, buffer, deadline) });
    } else {
      entries.push({ relative, stamp });
      const directory = await fsp.opendir(absolute);
      for await (const child of directory) {
        await visit(path.join(absolute, child.name), relative ? path.join(relative, child.name) : child.name, depth + 1);
      }
    }
  }
  try { await visit(root, '', 0); return { root, entries }; }
  catch { return undefined; }
}

/** Capture the owned copy before indexing can yield to another edit. A copy's
 * bytes must match the original evidence when the removal guard reads them. */
export function captureLocalEntryRevisionSync(root: string, copiedFrom?: LocalEntryRevision): LocalEntryRevision | undefined {
  const entries: LocalEntryRevision['entries'] = [];
  const deadline = performance.now() + 100;
  const expected = copiedFrom && new Map(copiedFrom.entries.map(entry => [entry.relative, entry]));
  let buffer: Buffer | undefined;
  let pathBytes = 0;
  function visit(absolute: string, relative: string, depth: number): void {
    pathBytes += Buffer.byteLength(relative);
    if (depth > 64 || entries.length >= MAX_REVISION_ENTRIES
      || pathBytes > MAX_REVISION_PATH_BYTES || performance.now() > deadline) throw new Error('revision budget exceeded');
    const stat = fs.lstatSync(absolute, { bigint: true });
    const stamp = revisionStamp(stat);
    if (!stamp) throw new Error('unsupported revision source');
    const original = expected?.get(relative);
    if (expected && (!original || (original.digest !== undefined) !== stat.isFile())) throw new Error('copy changed');
    if (stat.isFile()) {
      const digest = original?.digest ?? revisionDigestSync(absolute, stat, stamp,
        buffer ??= Buffer.allocUnsafe(REVISION_READ_BYTES), deadline);
      entries.push({ relative, stamp, digest });
    } else {
      entries.push({ relative, stamp });
      const directory = fs.opendirSync(absolute);
      try {
        let child: fs.Dirent | null;
        while ((child = directory.readSync())) {
          visit(path.join(absolute, child.name), relative ? path.join(relative, child.name) : child.name, depth + 1);
        }
      } finally { directory.closeSync(); }
    }
  }
  try {
    visit(root, '', 0);
    return !expected || expected.size === entries.length ? { root, entries } : undefined;
  }
  catch { return undefined; }
}

/** Called at the actual synchronous removal boundary, after async validation.
 * Bound main-thread work; uncertain state must retain both recoverable copies. */
export function localEntryRevisionMatches(
  revision: LocalEntryRevision | undefined, deadline = performance.now() + 100, verifyContents = true,
): boolean {
  if (!revision?.entries.length || revision.entries.length > MAX_REVISION_ENTRIES) return false;
  try {
    let buffer: Buffer | undefined;
    return revision.entries.every(({ relative, stamp, digest }) => {
      if (performance.now() > deadline) return false;
      const absolute = path.join(revision.root, relative);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (revisionStamp(stat) !== stamp) return false;
      return !verifyContents || stat.isDirectory() || (digest !== undefined && revisionDigestSync(absolute, stat, stamp,
        buffer ??= Buffer.allocUnsafe(REVISION_READ_BYTES), deadline) === digest);
    });
  } catch { return false; }
}

/** Finish disk reads asynchronously for large moves, then let the owning
 * delete path recheck both path stamps immediately before removal. */
export async function prepareLocalEntryDelete(
  revisions: readonly (LocalEntryRevision | undefined)[],
): Promise<() => boolean> {
  const deadline = performance.now() + 5000;
  const buffer = Buffer.allocUnsafe(REVISION_READ_BYTES);
  try {
    for (const revision of revisions) {
      if (!revision?.entries.length || revision.entries.length > MAX_REVISION_ENTRIES) return () => false;
      for (const { relative, stamp, digest } of revision.entries) {
        if (performance.now() > deadline) return () => false;
        const absolute = path.join(revision.root, relative);
        const stat = await fsp.lstat(absolute, { bigint: true });
        if (revisionStamp(stat) !== stamp) return () => false;
        if (stat.isFile() && (!digest || await revisionDigest(absolute, stat, stamp, buffer, deadline) !== digest)) {
          return () => false;
        }
      }
    }
    return () => {
      const stampDeadline = performance.now() + 100;
      return revisions.every(revision => localEntryRevisionMatches(revision, stampDeadline, false));
    };
  } catch { return () => false; }
}

export async function isUtf8File(absPath: string): Promise<boolean> {
  const fs = fileSystemForPath(absPath);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const stream = fs.createReadStream(absPath);
  try {
    for await (const chunk of stream) {
      decoder.decode(chunk as Buffer, { stream: true });
    }
    decoder.decode();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
      return false;
    }
    throw err;
  } finally {
    // An invalid chunk ends iteration before the asynchronous handle close.
    // Callers must be able to remove or replace the rejected source at once.
    if (!stream.closed) {
      await new Promise<void>((resolve) => {
        stream.once('close', resolve);
        stream.destroy();
      });
    }
  }
}
