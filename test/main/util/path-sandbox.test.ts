import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathAllowed, resolveSandboxRoot } from '../../../src/main/util/path-sandbox';

let tmpRoot: string;
let workspace: string;
let attachments: string;
let workspaceFile: string;
let attachmentFile: string;
let outsideFile: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sandbox-'));
  workspace = path.join(tmpRoot, 'ws');
  attachments = path.join(tmpRoot, 'attach');
  const outside = path.join(tmpRoot, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  workspaceFile = path.join(workspace, 'doc.md');
  attachmentFile = path.join(attachments, 'a.pdf');
  outsideFile = path.join(outside, 'secret.md');
  fs.writeFileSync(workspaceFile, 'hello');
  fs.writeFileSync(attachmentFile, 'pdf bytes');
  fs.writeFileSync(outsideFile, 'secret');
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('path-sandbox › isPathAllowed', () => {
  it('distinguishes deleting a directory entry from accessing its target', () => {
    const link = path.join(workspace, 'entry-link');
    fs.symlinkSync(path.dirname(outsideFile), link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(isPathAllowed(link, [workspace])).toBe(false);
      expect(isPathAllowed(link, [workspace], { followFinalSymlink: false })).toBe(true);
      expect(isPathAllowed(path.join(link, 'secret.md'), [workspace], { followFinalSymlink: false })).toBe(false);
      expect(isPathAllowed(link + path.sep, [workspace], { followFinalSymlink: false })).toBe(false);
    } finally { fs.unlinkSync(link); }
  });

  it('does not authorize deleting an outside entry just because its target is inside', () => {
    const link = path.join(path.dirname(outsideFile), 'entry-back');
    fs.symlinkSync(workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(isPathAllowed(link, [workspace])).toBe(true);
      expect(isPathAllowed(link, [workspace], { followFinalSymlink: false })).toBe(false);
    } finally { fs.unlinkSync(link); }
  });

  it('accepts files inside a root', () => {
    expect(isPathAllowed(workspaceFile, [workspace, attachments])).toBe(true);
    expect(isPathAllowed(attachmentFile, [workspace, attachments])).toBe(true);
  });

  it('accepts the root dir itself', () => {
    expect(isPathAllowed(workspace, [workspace])).toBe(true);
  });

  it('rejects files outside all roots', () => {
    expect(isPathAllowed(outsideFile, [workspace, attachments])).toBe(false);
  });

  it('rejects ../ traversal back into a sibling dir', () => {
    const escape = path.join(workspace, '..', 'outside', 'secret.md');
    expect(isPathAllowed(escape, [workspace])).toBe(false);
  });

  it('rejects sibling prefixes (no false-positive on startsWith)', () => {
    // /tmp/.../ws vs /tmp/.../ws_other — must NOT match.
    const sibling = path.join(tmpRoot, 'ws_other');
    fs.mkdirSync(sibling, { recursive: true });
    const siblingFile = path.join(sibling, 'x.md');
    fs.writeFileSync(siblingFile, 'x');
    try { expect(isPathAllowed(siblingFile, [workspace])).toBe(false); }
    finally { fs.rmSync(sibling, { recursive: true, force: true }); }
  });

  it('resolves symlinks on both sides (block escape)', () => {
    // Plant a symlink inside workspace that points at outsideFile.
    const link = path.join(workspace, 'link-to-secret.md');
    try { fs.symlinkSync(outsideFile, link); }
    catch { return; /* platform without symlink perms — skip */ }
    try {
      // Realpath resolves to outside, so this must be rejected.
      expect(isPathAllowed(link, [workspace])).toBe(false);
    } finally {
      try { fs.unlinkSync(link); } catch { /* best-effort */ }
    }
  });

  it('rejects a nonexistent child reached through a symlink that escapes the root', () => {
    const outsideDir = path.dirname(outsideFile);
    const linkDir = path.join(workspace, 'outside-alias');
    if (process.platform === 'win32') {
      // Directory junctions do not require Developer Mode/admin privileges,
      // so this security probe must stay active on ordinary Windows CI hosts.
      fs.symlinkSync(outsideDir, linkDir, 'junction');
    } else {
      try { fs.symlinkSync(outsideDir, linkDir, 'dir'); }
      catch { return; /* platform without symlink support — covered by Windows junction CI */ }
    }
    try {
      expect(isPathAllowed(path.join(linkDir, 'not-created-yet.txt'), [workspace])).toBe(false);
    } finally {
      try { fs.unlinkSync(linkDir); } catch { /* best-effort */ }
    }
  });

  it('accepts an allowed root addressed through a symlink alias', () => {
    const rootAlias = path.join(tmpRoot, 'workspace-alias');
    if (process.platform === 'win32') {
      fs.symlinkSync(workspace, rootAlias, 'junction');
    } else {
      try { fs.symlinkSync(workspace, rootAlias, 'dir'); }
      catch { return; /* platform without symlink support — covered by Windows junction CI */ }
    }
    try {
      expect(isPathAllowed(path.join(rootAlias, 'doc.md'), [rootAlias])).toBe(true);
    } finally {
      try { fs.unlinkSync(rootAlias); } catch { /* best-effort */ }
    }
  });

  it('trusts a pre-resolved root only after resolveSandboxRoot, so a hot loop resolves it once', () => {
    // A sync pass checks thousands of candidates against one root; the
    // resolved form must reach the same verdicts as the per-call walk while
    // candidates keep resolving (a planted symlink is still rejected).
    const resolvedRoot = resolveSandboxRoot(workspace);
    expect(isPathAllowed(workspaceFile, [resolvedRoot], { rootsResolved: true })).toBe(true);
    expect(isPathAllowed(path.join(workspace, 'not-yet.md'), [resolvedRoot], { rootsResolved: true }))
      .toBe(true);
    expect(isPathAllowed(outsideFile, [resolvedRoot], { rootsResolved: true })).toBe(false);
    const link = path.join(workspace, 'link-to-secret-resolved.md');
    try { fs.symlinkSync(outsideFile, link); }
    catch { return; /* platform without symlink perms — skip */ }
    try {
      expect(isPathAllowed(link, [resolvedRoot], { rootsResolved: true })).toBe(false);
    } finally {
      try { fs.unlinkSync(link); } catch { /* best-effort */ }
    }
  });

  it('fails closed when a caller claims an unresolved symlinked root is resolved (negative control)', () => {
    const rootAlias = path.join(tmpRoot, 'workspace-alias-unresolved');
    if (process.platform === 'win32') {
      fs.symlinkSync(workspace, rootAlias, 'junction');
    } else {
      try { fs.symlinkSync(workspace, rootAlias, 'dir'); }
      catch { return; /* platform without symlink support — covered by Windows junction CI */ }
    }
    try {
      // The per-call walk follows the alias; the resolved-root contract skips
      // that walk, so the same call is rejected instead of silently trusted.
      expect(isPathAllowed(path.join(rootAlias, 'doc.md'), [rootAlias])).toBe(true);
      expect(isPathAllowed(path.join(rootAlias, 'doc.md'), [rootAlias], { rootsResolved: true }))
        .toBe(false);
      expect(isPathAllowed(path.join(rootAlias, 'doc.md'), [resolveSandboxRoot(rootAlias)], { rootsResolved: true }))
        .toBe(true);
    } finally {
      try { fs.unlinkSync(rootAlias); } catch { /* best-effort */ }
    }
  });

  it.runIf(process.platform === 'win32')('uses native case-insensitive containment without prefix confusion', () => {
    const upperCaseFile = workspaceFile.toUpperCase();
    expect(isPathAllowed(upperCaseFile, [workspace.toLowerCase()])).toBe(true);

    const sibling = path.join(tmpRoot, 'WS-SIBLING');
    fs.mkdirSync(sibling);
    const siblingFile = path.join(sibling, 'DOC.MD');
    fs.writeFileSync(siblingFile, 'outside');
    try {
      expect(isPathAllowed(siblingFile.toLowerCase(), [workspace.toUpperCase()])).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('rejects relative paths', () => {
    expect(isPathAllowed('relative/path.md', [workspace])).toBe(false);
  });

  it('ignores relative and empty allowed roots', () => {
    expect(isPathAllowed(workspaceFile, ['', 'relative/root'])).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isPathAllowed('', [workspace])).toBe(false);
    expect(isPathAllowed(workspaceFile, [])).toBe(false);
  });

  it('treats missing candidate as lexical resolve (still honors roots)', () => {
    const ghost = path.join(workspace, 'does-not-exist.md');
    expect(isPathAllowed(ghost, [workspace])).toBe(true);
    const ghostOutside = path.join(tmpRoot, 'outside', 'never.md');
    expect(isPathAllowed(ghostOutside, [workspace])).toBe(false);
  });

  it('switching allowed roots enforces isolation between workspaces', () => {
    const wsB = path.join(tmpRoot, 'ws-b');
    fs.mkdirSync(wsB, { recursive: true });
    const fileB = path.join(wsB, 'b.md');
    fs.writeFileSync(fileB, 'b');
    try {
      // Under ws-a's scope, ws-b is invisible
      expect(isPathAllowed(fileB, [workspace, attachments])).toBe(false);
      // Under ws-b's scope, ws-a is invisible
      expect(isPathAllowed(workspaceFile, [wsB])).toBe(false);
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});


describe('path-sandbox › unresolved existing entries', () => {
  it('refuses a missing descendant behind a dangling directory link while allowing unlink of the link itself', () => {
    const target = path.join(tmpRoot, 'outside', 'not-created');
    const link = path.join(workspace, 'dangling-directory');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(isPathAllowed(path.join(link, 'future.md'), [workspace])).toBe(false);
      expect(isPathAllowed(link, [workspace])).toBe(false);
      expect(isPathAllowed(link, [workspace], { followFinalSymlink: false })).toBe(true);
      expect(isPathAllowed(path.join(link, 'future.md'), [workspace], { followFinalSymlink: false })).toBe(false);
      const resolved = resolveSandboxRoot(workspace);
      expect(isPathAllowed(path.join(link, 'future.md'), [resolved], { rootsResolved: true })).toBe(false);
      expect(isPathAllowed(path.join(workspace, 'ordinary-new', 'future.md'), [resolved], { rootsResolved: true })).toBe(true);
    } finally { fs.unlinkSync(link); }
  });

  it('preserves a known root alias when its ordinary target directory has not been created yet', () => {
    const link = path.join(tmpRoot, 'future-root-alias');
    const target = path.join(tmpRoot, 'future-workspace');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      for (const candidate of [path.join(link, 'future.md'), path.join(target, 'future.md')]) {
        expect(isPathAllowed(candidate, [link])).toBe(true);
        expect(isPathAllowed(candidate, [resolveSandboxRoot(link)], { rootsResolved: true })).toBe(true);
      }
      expect(fs.existsSync(target)).toBe(false);
    } finally { fs.unlinkSync(link); }
  });

  it.runIf(process.platform !== 'win32')('preserves a known internal file alias whose target has not been created yet', () => {
    const link = path.join(workspace, 'future-file-alias.md');
    const target = path.join(workspace, 'future-file.md');
    fs.symlinkSync(target, link, 'file');
    try {
      expect(isPathAllowed(link, [workspace])).toBe(true);
      expect(isPathAllowed(link, [resolveSandboxRoot(workspace)], { rootsResolved: true })).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally { fs.unlinkSync(link); }
  });

  it.runIf(process.platform !== 'win32')('refuses dangling file links and symlink cycles without changing their targets', () => {
    const dangling = path.join(workspace, 'dangling-file.md');
    const first = path.join(workspace, 'cycle-a');
    const second = path.join(workspace, 'cycle-b');
    const target = path.join(tmpRoot, 'outside', 'not-created.md');
    fs.symlinkSync(target, dangling, 'file');
    fs.symlinkSync(second, first, 'dir'); fs.symlinkSync(first, second, 'dir');
    try {
      expect(isPathAllowed(dangling, [workspace])).toBe(false);
      expect(isPathAllowed(path.join(first, 'future.md'), [workspace])).toBe(false);
      expect(isPathAllowed(path.join(first, 'future.md'), [first])).toBe(false);
      expect(isPathAllowed(path.join(first, 'future.md'), [resolveSandboxRoot(first)], { rootsResolved: true })).toBe(false);
      expect(isPathAllowed(dangling, [workspace], { followFinalSymlink: false })).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally { fs.unlinkSync(dangling); fs.unlinkSync(first); fs.unlinkSync(second); }
  });
});


describe('path-sandbox › resolution budget and metadata recovery', () => {
  it.runIf(process.platform !== 'win32').each([39, 40, 41])('bounds unresolved symlink resolution for a chain of %i links', count => {
    const directory = path.join(workspace, `chain-${count}`);
    fs.mkdirSync(directory);
    let target = path.join(directory, 'future-target.md');
    for (let index = count - 1; index >= 0; index--) {
      const link = path.join(directory, `link-${index}.md`);
      fs.symlinkSync(target, link, 'file'); target = link;
    }
    expect(isPathAllowed(target, [workspace])).toBe(count <= 40);
    expect(isPathAllowed(target, [resolveSandboxRoot(workspace)], { rootsResolved: true })).toBe(count <= 40);
    expect(fs.existsSync(path.join(directory, 'future-target.md'))).toBe(false);
  });

  it.each(['EACCES', 'EIO'])('denies unknown metadata after %s and recovers after the filesystem is readable', async code => {
    const nodeFs = (await import('node:fs')).default;
    const realpath = nodeFs.realpathSync, lstat = nodeFs.lstatSync;
    const failure = Object.assign(new Error('Private metadata failure'), { code });
    const realpathSpy = vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (String(filename) === workspaceFile) throw failure;
      return (realpath as any)(filename, ...args);
    }) as any);
    const lstatSpy = vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (String(filename) === workspaceFile) throw failure;
      return (lstat as any)(filename, ...args);
    }) as any);
    syncBuiltinESMExports();
    try { expect(isPathAllowed(workspaceFile, [workspace])).toBe(false); }
    finally { realpathSpy.mockRestore(); lstatSpy.mockRestore(); syncBuiltinESMExports(); }
    expect(isPathAllowed(workspaceFile, [workspace])).toBe(true);
    expect(fs.readFileSync(workspaceFile, 'utf8')).toBe('hello');
  });
});


describe('path-sandbox › explicitly allowed volume roots', () => {
  it.each([false, true])('contains native temporary fixtures under the filesystem root, resolved=%s', rootsResolved => {
    const root = path.parse(fs.realpathSync(workspaceFile)).root;
    const allowed = rootsResolved ? resolveSandboxRoot(root) : root;
    expect(isPathAllowed(root, [allowed], { rootsResolved })).toBe(true);
    expect(isPathAllowed(workspaceFile, [allowed], { rootsResolved })).toBe(true);
    expect(isPathAllowed(workspaceFile, [allowed], { rootsResolved, followFinalSymlink: false })).toBe(true);
    // An unrelated narrow root still cannot grant the same file.
    expect(isPathAllowed(workspaceFile, [attachments], { rootsResolved })).toBe(false);
  });

  it.each([
    ['C:\\', 'C:\\allowed\\note.txt', 'D:\\outside.txt'],
    ['\\\\fixture-host\\share\\', '\\\\fixture-host\\share\\allowed\\note.txt', '\\\\fixture-host\\share-other\\outside.txt'],
  ])('keeps Windows path-engine root containment without a sibling grant: %s', async (root, candidate, outside) => {
    vi.resetModules();
    // Pure path-engine simulation, not native Windows/filesystem acceptance.
    vi.doMock('node:path', () => ({ ...path.win32, default: path.win32 }));
    vi.doMock('node:fs', () => ({ realpathSync: (value: string) => path.win32.resolve(value) }));
    try {
      const module = await import('../../../src/main/util/path-sandbox');
      for (const rootsResolved of [false, true]) {
        const allowed = rootsResolved ? module.resolveSandboxRoot(root) : root;
        expect(module.isPathAllowed(root, [allowed], { rootsResolved })).toBe(true);
        expect(module.isPathAllowed(candidate, [allowed], { rootsResolved })).toBe(true);
        expect(module.isPathAllowed(candidate, [allowed], { rootsResolved, followFinalSymlink: false })).toBe(true);
        expect(module.isPathAllowed(outside, [allowed], { rootsResolved })).toBe(false);
      }
    } finally {
      vi.doUnmock('node:path'); vi.doUnmock('node:fs'); vi.resetModules();
    }
  });
});
