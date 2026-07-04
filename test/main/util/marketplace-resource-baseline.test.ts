import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function repoRoot(): string {
  return path.basename(process.cwd()) === 'PC'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function dirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function idSet(root: string): Set<string> {
  return new Set(dirs(root));
}

describe('official marketplace Resource registry', () => {
  it('keeps Resource and builtin marketplace ids disjoint per kind', () => {
    const root = repoRoot();
    for (const kind of ['agents', 'skills'] as const) {
      const resourceIds = idSet(path.join(root, 'Resource', kind));
      const builtinIds = idSet(path.join(root, 'PC', 'resources', 'builtin', 'marketplace', kind));
      const overlap = [...resourceIds].filter((id) => builtinIds.has(id)).sort();
      expect(overlap, `${kind} ids exist in both Resource and builtin trees`).toEqual([]);
    }
  });
});
