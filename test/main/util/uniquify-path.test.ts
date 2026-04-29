import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uniquifyPath, renderRenameSignal } from '../../../src/main/util/uniquify-path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-uniquify-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NEVER_MINE = () => false;

describe('uniquifyPath › passthrough', () => {
  it('returns the input unchanged when the target does not exist', async () => {
    const target = path.join(tmpDir, 'fresh.py');
    const r = await uniquifyPath(target, NEVER_MINE);
    expect(r).toEqual({ finalPath: target, renamed: false });
  });

  it('returns the input unchanged when isMine(input) is true (refinement)', async () => {
    const target = path.join(tmpDir, 'draft.md');
    fs.writeFileSync(target, 'v1');
    const r = await uniquifyPath(target, (p) => p === target);
    expect(r).toEqual({ finalPath: target, renamed: false });
  });
});

describe('uniquifyPath › collision', () => {
  it('inserts -2 before the extension on first collision', async () => {
    const target = path.join(tmpDir, 'app.py');
    fs.writeFileSync(target, 'someone else');
    const r = await uniquifyPath(target, NEVER_MINE);
    expect(r).toEqual({ finalPath: path.join(tmpDir, 'app-2.py'), renamed: true });
  });

  it('walks past existing -2 / -3 to find the next free slot', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'app-2.py'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'app-3.py'), 'c');
    const r = await uniquifyPath(path.join(tmpDir, 'app.py'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'app-4.py'));
    expect(r.renamed).toBe(true);
  });

  it('returns a candidate as soon as isMine claims it (overwrite-own)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'foreign');
    fs.writeFileSync(path.join(tmpDir, 'app-2.py'), 'mine v1');
    const mine = path.join(tmpDir, 'app-2.py');
    const r = await uniquifyPath(path.join(tmpDir, 'app.py'), (p) => p === mine);
    expect(r).toEqual({ finalPath: mine, renamed: true });
  });
});

describe('uniquifyPath › extension handling', () => {
  it('preserves single extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'note.md'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'note.md'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'note-2.md'));
  });

  it('handles ext-less basenames (Makefile)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Makefile'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'Makefile'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'Makefile-2'));
  });

  it('treats dotfiles as ext-less (path.parse semantics for .env)', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '');
    const r = await uniquifyPath(path.join(tmpDir, '.env'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, '.env-2'));
  });

  it('only splits on the last dot — app.tar.gz becomes app.tar-2.gz (cosmetic)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bundle.tar.gz'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'bundle.tar.gz'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'bundle.tar-2.gz'));
  });
});

describe('renderRenameSignal', () => {
  it('emits a basename-only <file-renamed> block', () => {
    const out = renderRenameSignal('/abs/dir/app.py', '/abs/dir/app-2.py');
    expect(out).toContain('<file-renamed>');
    expect(out).toContain('</file-renamed>');
    expect(out).toContain('You requested: app.py');
    expect(out).toContain('Saved as:      app-2.py');
    expect(out).not.toContain('/abs/dir/');
  });
});
