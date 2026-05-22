import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listWorkspaceFiles } from '../../src/main/features/conversation_files';

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
      expect(result.items.map((f) => f.relPath)).toEqual([
        'agent_skill_review/skill_batch.md',
        '处理索引.md',
      ]);
      expect(result.items[0].path).toBe(path.join(dir, 'agent_skill_review', 'skill_batch.md'));
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
});
