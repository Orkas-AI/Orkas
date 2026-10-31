import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertLocalImportTarget,
  copyLocalFileAtomic,
  copyLocalEntryExclusiveSync,
  captureLocalEntryRevision,
  localEntryRevisionMatches,
  inspectLocalImportSource,
  withLocalImportLock,
} from '../../../src/main/util/file-import';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-file-import-'));
});

describe('Library move revisions', () => {
  it('accepts unchanged descendants and rejects added and removed children', async () => {
    fs.writeFileSync(path.join(root, 'first.md'), 'First document');
    const before = await captureLocalEntryRevision(root);
    expect(localEntryRevisionMatches(before)).toBe(true);

    fs.writeFileSync(path.join(root, 'second.md'), 'Second document');
    expect(localEntryRevisionMatches(before)).toBe(false);
    const afterAddition = await captureLocalEntryRevision(root);
    fs.unlinkSync(path.join(root, 'second.md'));
    expect(localEntryRevisionMatches(afterAddition)).toBe(false);
  });

  it('rejects missing and unreadable revision evidence', async () => {
    const file = path.join(root, 'source.md');
    fs.writeFileSync(file, 'Source document');
    const revision = await captureLocalEntryRevision(file);
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const lstat = nodeFs.lstatSync;
    const spy = vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (String(filename) === file) throw Object.assign(new Error('Injected metadata read failure'), { code: 'EIO' });
      return (lstat as any)(filename, ...args);
    }) as any);
    syncBuiltinESMExports();
    try { expect(localEntryRevisionMatches(revision)).toBe(false); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(localEntryRevisionMatches(undefined)).toBe(false);
    expect(await captureLocalEntryRevision(path.join(root, 'missing.md'))).toBeUndefined();
  });

  it('accepts depth 64 and refuses a deeper source', async () => {
    let directory = root;
    for (let depth = 1; depth <= 64; depth++) {
      directory = path.join(directory, 'd'); fs.mkdirSync(directory);
    }
    const revision = await captureLocalEntryRevision(root);
    expect(revision).toBeDefined();
    fs.mkdirSync(path.join(directory, 'too-deep'));
    expect(await captureLocalEntryRevision(root)).toBeUndefined();
  });

  it('refuses deletion when the synchronous verification budget expires', async () => {
    fs.writeFileSync(path.join(root, 'source.md'), 'Source document');
    const revision = await captureLocalEntryRevision(root);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(101);
    let matches: boolean;
    try { matches = localEntryRevisionMatches(revision); }
    finally { clock.mockRestore(); }
    expect(matches).toBe(false);
  });

  it('refuses a snapshot after the collection budget expires', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5001);
    let revision: Awaited<ReturnType<typeof captureLocalEntryRevision>>;
    try { revision = await captureLocalEntryRevision(root); }
    finally { clock.mockRestore(); }
    expect(revision).toBeUndefined();
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local file import source inspection', () => {
  it('returns stable metadata for a regular absolute file', async () => {
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'import body', 'utf8');

    await expect(inspectLocalImportSource(source, 1024)).resolves.toMatchObject({
      absPath: source,
      bytes: Buffer.byteLength('import body'),
      sha1: crypto.createHash('sha1').update('import body').digest('hex'),
      mtimeMs: expect.any(Number),
    });
  });

  it('rejects relative paths, directories, symlinks, and oversized files', async () => {
    const source = path.join(root, 'source.md');
    const linkedTarget = path.join(root, 'linked-target');
    const linked = path.join(root, 'linked');
    fs.writeFileSync(source, '12345', 'utf8');
    fs.mkdirSync(linkedTarget);
    fs.symlinkSync(
      process.platform === 'win32' ? linkedTarget : source,
      linked,
      process.platform === 'win32' ? 'junction' : 'file',
    );

    await expect(inspectLocalImportSource('source.md', 1024))
      .rejects.toMatchObject({ code: 'E_IMPORT_SOURCE' });
    await expect(inspectLocalImportSource(root, 1024))
      .rejects.toMatchObject({ code: 'E_IMPORT_SOURCE' });
    await expect(inspectLocalImportSource(linked, 1024))
      .rejects.toMatchObject({ code: 'E_IMPORT_SOURCE' });
    await expect(inspectLocalImportSource(source, 4))
      .rejects.toMatchObject({ code: 'E_FILE_TOO_LARGE', bytes: 5 });
  });
});

describe('local file import target and publication', () => {
  it('rejects the root, traversal, and a symlink anywhere below the owned root', async () => {
    const library = path.join(root, 'library');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(library);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(library, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(assertLocalImportTarget(library, library))
      .rejects.toMatchObject({ code: 'E_IMPORT_TARGET' });
    await expect(assertLocalImportTarget(library, path.join(root, 'escaped.md')))
      .rejects.toMatchObject({ code: 'E_IMPORT_TARGET' });
    await expect(assertLocalImportTarget(library, path.join(library, 'linked', 'escaped.md')))
      .rejects.toMatchObject({ code: 'E_IMPORT_TARGET_SYMLINK' });
  });

  it('publishes complete bytes and removes the sibling temporary file', async () => {
    const source = path.join(root, 'source.bin');
    const target = path.join(root, 'library', 'nested', 'target.bin');
    fs.writeFileSync(source, Buffer.from([0, 1, 2, 3, 255]));
    const inspected = await inspectLocalImportSource(source, 1024);

    await copyLocalFileAtomic(source, target, inspected);

    expect(fs.readFileSync(target)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    expect(fs.readdirSync(path.dirname(target))).toEqual(['target.bin']);
  });

  it('rejects a changed source without publishing partial bytes', async () => {
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'library', 'target.md');
    fs.writeFileSync(source, 'before', 'utf8');
    const inspected = await inspectLocalImportSource(source, 1024);
    fs.writeFileSync(source, 'after-with-a-different-size', 'utf8');

    await expect(copyLocalFileAtomic(source, target, inspected))
      .rejects.toMatchObject({ code: 'E_IMPORT_SOURCE_CHANGED' });

    expect(fs.existsSync(target)).toBe(false);
    expect(
      fs.existsSync(path.dirname(target)) ? fs.readdirSync(path.dirname(target)) : [],
    ).toEqual([]);
  });

  it('preserves a target that wins the publication race', async () => {
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'library', 'target.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, 'new import', 'utf8');
    fs.writeFileSync(target, 'existing user file', 'utf8');
    const inspected = await inspectLocalImportSource(source, 1024);

    await expect(copyLocalFileAtomic(source, target, inspected))
      .rejects.toMatchObject({ code: 'E_IMPORT_TARGET_EXISTS' });

    expect(fs.readFileSync(source, 'utf8')).toBe('new import');
    expect(fs.readFileSync(target, 'utf8')).toBe('existing user file');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['target.md']);
  });
});

describe('local file import locking', () => {
  it('serializes one Library, allows another key to progress, and recovers after rejection', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withLocalImportLock('library-a', async () => {
      order.push('a:first:start');
      await gate;
      order.push('a:first:end');
    });
    const second = withLocalImportLock('library-a', async () => {
      order.push('a:second');
    });
    await withLocalImportLock('library-b', async () => {
      order.push('b:independent');
    });

    expect(order).toEqual(['a:first:start', 'b:independent']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'a:first:start',
      'b:independent',
      'a:first:end',
      'a:second',
    ]);

    await expect(withLocalImportLock('library-a', async () => {
      throw new Error('worker failed');
    })).rejects.toThrow('worker failed');
    await expect(withLocalImportLock('library-a', async () => 'recovered'))
      .resolves.toBe('recovered');
  });
});


describe('create-only entry copy failure recovery', () => {
  it('removes only its claimed partial directory and can retry after an I/O failure', async () => {
    const source = path.join(root, 'source'); const target = path.join(root, 'target');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'note.md'), 'Original directory source');
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const error = Object.assign(new Error('Injected copy I/O failure'), { code: 'EIO' });
    const spy = vi.spyOn(nodeFs, 'cpSync').mockImplementation(() => {
      fs.writeFileSync(path.join(target, 'partial.md'), 'Incomplete copy'); throw error;
    }); syncBuiltinESMExports();
    try { expect(() => copyLocalEntryExclusiveSync(source, target, true)).toThrow(error); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(source, 'note.md'), 'utf8')).toBe('Original directory source');
    copyLocalEntryExclusiveSync(source, target, true);
    expect(fs.readdirSync(target)).toEqual(['note.md']);
    expect(fs.readFileSync(path.join(target, 'note.md'), 'utf8')).toBe('Original directory source');
  });

  it('leaves no target or source mutation when native file copying fails, then retries exact binary bytes', async () => {
    const source = path.join(root, 'source.bin'); const target = path.join(root, 'target.bin');
    const bytes = Buffer.from([0, 1, 255, 0, 200]); fs.writeFileSync(source, bytes);
    const nodeFs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const error = Object.assign(new Error('Injected native copy failure'), { code: 'EIO' });
    const spy = vi.spyOn(nodeFs, 'copyFileSync').mockImplementation(() => { throw error; });
    syncBuiltinESMExports();
    try { expect(() => copyLocalEntryExclusiveSync(source, target, false)).toThrow(error); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.existsSync(target)).toBe(false); expect(fs.readFileSync(source)).toEqual(bytes);
    copyLocalEntryExclusiveSync(source, target, false);
    expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.readFileSync(source)).toEqual(bytes);
  });
});


it.runIf(process.platform !== 'win32')('keeps private directory and nested file modes during a create-only copy', () => {
  const source = path.join(root, 'private-source'), target = path.join(root, 'private-copy');
  fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(path.join(source, 'note.md'), 'Private mode fixture', { mode: 0o600 });
  copyLocalEntryExclusiveSync(source, target, true);
  expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(target, 'note.md')).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(path.join(target, 'note.md'), 'utf8')).toBe('Private mode fixture');
});


it('preserves a replacement destination root when partial-directory cleanup observes a different inode', async () => {
  const source = path.join(root, 'source'), target = path.join(root, 'target'), displaced = path.join(root, 'displaced');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'note.md'), 'Original source');
  const nodeFs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const error = Object.assign(new Error('Injected copy interruption'), { code: 'EIO' });
  const spy = vi.spyOn(nodeFs, 'cpSync').mockImplementation(() => {
    fs.renameSync(target, displaced); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'winner.md'), 'Replacement root winner'); throw error;
  }); syncBuiltinESMExports();
  try { expect(() => copyLocalEntryExclusiveSync(source, target, true)).toThrow(error); }
  finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect(fs.readdirSync(target)).toEqual(['winner.md']);
  expect(fs.readFileSync(path.join(target, 'winner.md'), 'utf8')).toBe('Replacement root winner');
  expect(fs.readFileSync(path.join(source, 'note.md'), 'utf8')).toBe('Original source');
});
