import { describe, it, expect, afterEach, vi } from 'vitest';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listWorkspaceFiles } from '../../src/main/features/conversation_files';

const prevHome = process.env.HOME;
const prevGuard = process.env.ORKAS_TCC_GUARD_FORCE;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevGuard === undefined) delete process.env.ORKAS_TCC_GUARD_FORCE;
  else process.env.ORKAS_TCC_GUARD_FORCE = prevGuard;
});

describe('conversation workspace file listing', () => {
  it('returns a relative tree snapshot from the current workspace on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      fs.mkdirSync(path.join(dir, 'agent_skill_review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '处理索引.md'), 'index');
      fs.writeFileSync(path.join(dir, 'agent_skill_review', 'skill_batch.md'), 'skill');
      fs.writeFileSync(path.join(dir, '.hidden.md'), 'hidden');

      const result = await listWorkspaceFiles(dir);

      expect(result.root).toBe(path.resolve(dir));
      expect(result.rootExists).toBe(true);
      expect(result.truncated).toBe(false);
      // Source sort is locale-aware (Intl.Collator default); intra-script
      // order is stable but Latin-vs-CJK interleaving depends on the runner's
      // ICU locale. The renderer rebuilds the tree from relPath, so order is
      // not part of the snapshot contract — only membership + per-item shape.
      expect(result.items.map((f) => f.relPath).sort()).toEqual([
        'agent_skill_review/skill_batch.md',
        '处理索引.md',
      ].sort());
      const treeFile = result.items.find((f) => f.relPath === 'agent_skill_review/skill_batch.md');
      expect(treeFile?.path).toBe(path.join(dir, 'agent_skill_review', 'skill_batch.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports truncation instead of walking forever on huge workspaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.md'), 'a');
      fs.writeFileSync(path.join(dir, 'b.md'), 'b');

      const result = await listWorkspaceFiles(dir, { maxFiles: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.truncated).toBe(true);
      expect(result.count).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps sorted selection and complete membership without synchronous traversal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'z.txt'), 'z');
    fs.writeFileSync(path.join(dir, 'a', 'first.txt'), 'first');
    const read = nativeFs.readdirSync;
    let blocking = 0;
    const spy = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(((p: any, ...args: any[]) => {
      if (String(p).startsWith(dir)) blocking++;
      return (read as any)(p, ...args);
    }) as any);
    syncBuiltinESMExports();
    try {
      const all = await listWorkspaceFiles(dir);
      const limited = await listWorkspaceFiles(dir, { maxFiles: 1 });
      expect(all.items.map(f => f.relPath)).toEqual(['a/first.txt', 'z.txt']);
      expect(all.truncated).toBe(false);
      expect(limited.items.map(f => f.relPath)).toEqual(['a/first.txt']);
      expect(limited.truncated).toBe(true);
      expect(blocking).toBe(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not hide a visible file behind a new traversal-node cutoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    fs.writeFileSync(path.join(dir, 'z-visible.txt'), 'visible');
    const [visible] = await nativeFs.promises.readdir(dir, { withFileTypes: true });
    const hidden = Array.from({ length: 20_000 }, (_, i) => ({ name: `.hidden-${i}`,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }));
    const spy = vi.spyOn(nativeFs.promises, 'readdir').mockResolvedValueOnce([...hidden, visible] as any);
    try {
      const result = await listWorkspaceFiles(dir);
      expect(result.items.map(file => file.relPath)).toEqual(['z-visible.txt']);
      expect(result.truncated).toBe(false);
    } finally { spy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'darwin')('reports a skipped scan for macOS privacy-protected workspace roots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      const home = path.join(dir, 'home');
      const downloads = path.join(home, 'Downloads');
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, 'private.txt'), 'do not scan');
      process.env.HOME = home;
      process.env.ORKAS_TCC_GUARD_FORCE = '1';

      const result = await listWorkspaceFiles(downloads);

      expect(result.root).toBe(path.resolve(downloads));
      expect(result.rootExists).toBe(true);
      expect(result.scanSkipped).toBe(true);
      expect(result.items).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
