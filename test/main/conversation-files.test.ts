import { describe, it, expect, afterEach } from 'vitest';
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
  it('returns a relative tree snapshot from the current workspace on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      fs.mkdirSync(path.join(dir, 'agent_skill_review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '处理索引.md'), 'index');
      fs.writeFileSync(path.join(dir, 'agent_skill_review', 'skill_batch.md'), 'skill');
      fs.writeFileSync(path.join(dir, '.hidden.md'), 'hidden');

      const result = listWorkspaceFiles(dir);

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

  it('reports truncation instead of walking forever on huge workspaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.md'), 'a');
      fs.writeFileSync(path.join(dir, 'b.md'), 'b');

      const result = listWorkspaceFiles(dir, { maxFiles: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.truncated).toBe(true);
      expect(result.count).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a skipped scan for macOS privacy-protected workspace roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-files-'));
    try {
      const home = path.join(dir, 'home');
      const downloads = path.join(home, 'Downloads');
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, 'private.txt'), 'do not scan');
      process.env.HOME = home;
      process.env.ORKAS_TCC_GUARD_FORCE = '1';

      const result = listWorkspaceFiles(downloads);

      expect(result.root).toBe(path.resolve(downloads));
      expect(result.rootExists).toBe(true);
      expect(result.scanSkipped).toBe(true);
      expect(result.items).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
