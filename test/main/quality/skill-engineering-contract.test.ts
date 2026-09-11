import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Task tool project scope', () => {
  it('scopes the task tool Library save instruction to Project conversations', () => {
    // Both native and CLI descriptions must condition this project-only tool.
    const scoped = /In a Project conversation[^\n]+library_save[^\n]+outside one/;
    for (const file of ['src/core-agent/src/tools/project-tasks-tool.ts', 'bin/orkas-bridge.cjs']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toMatch(scoped);
    }
    expect('Save a produced project file with library_save.').not.toMatch(scoped);
  });
});
