import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertLocalImportTarget,
  copyLocalFileAtomic,
  inspectLocalImportSource,
  withLocalImportLock,
} from '../../../src/main/util/file-import';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-file-import-'));
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
