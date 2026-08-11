import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  grepRepository,
  isIgnoredByScopes,
  listRepositoryFiles,
  parseIgnoreRules,
} from '../../../../src/main/model/core-agent/repository-search';

const RG_AVAILABLE = spawnSync('rg', ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).status === 0;
const tempDirs: string[] = [];

function tempRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-repository-search-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(RG_AVAILABLE)('repository search streaming bounds', () => {
  it('stops high-cardinality grep after the requested result cap', async () => {
    const root = tempRepository();
    fs.writeFileSync(
      path.join(root, 'many.txt'),
      'needle repeated value\n'.repeat(160_000),
    );

    const result = await grepRepository(root, {
      pattern: 'needle',
      regex: false,
      caseSensitive: true,
      contextLines: 0,
      maxResults: 5,
      includeGlobs: [],
      excludeGlobs: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.available).toBe(true);
    expect(result.capped).toBe(true);
    expect(result.hits).toHaveLength(5);
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops repository file listing after one bounded overflow record', async () => {
    const root = tempRepository();
    for (let index = 0; index < 50; index++) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), String(index));
    }

    const result = await listRepositoryFiles(root, 7);

    expect(result.backend).toBe('rg');
    expect(result.capped).toBe(true);
    expect(result.files).toHaveLength(7);
  });
});

// `rg --files` honours ignore files for free; the walk fallback (machines
// without ripgrep) has to implement the same contract, and it is that
// implementation these cases pin. A miss here means `search_files` starts
// surfacing build output, logs and local config that the project ignored —
// the model's context fills with noise nobody asked for.
describe('repository-search › ignore rules', () => {
  function scope(dir: string, content: string) {
    return [{ dir, rules: parseIgnoreRules(content) }];
  }
  const ROOT = path.sep === '\\' ? 'C:\\repo' : '/repo';
  const at = (...parts: string[]) => path.join(ROOT, ...parts);

  it('ignores a directory rule and everything under it', () => {
    const rules = scope(ROOT, 'ignored/\n');
    expect(isIgnoredByScopes(at('ignored'), true, rules)).toBe(true);
    expect(isIgnoredByScopes(at('kept'), true, rules)).toBe(false);
    // A directory-only rule must not swallow a same-named file.
    expect(isIgnoredByScopes(at('ignored'), false, rules)).toBe(false);
  });

  it('matches a bare name at any depth but an anchored path only at its root', () => {
    const bare = scope(ROOT, 'notes.md\n');
    expect(isIgnoredByScopes(at('notes.md'), false, bare)).toBe(true);
    expect(isIgnoredByScopes(at('deep', 'notes.md'), false, bare)).toBe(true);

    const anchored = scope(ROOT, '/notes.md\n');
    expect(isIgnoredByScopes(at('notes.md'), false, anchored)).toBe(true);
    expect(isIgnoredByScopes(at('deep', 'notes.md'), false, anchored)).toBe(false);
  });

  it('lets a later negation re-include a file, as git does', () => {
    const rules = scope(ROOT, '*.log\n!keep.log\n');
    expect(isIgnoredByScopes(at('debug.log'), false, rules)).toBe(true);
    expect(isIgnoredByScopes(at('keep.log'), false, rules)).toBe(false);
  });

  it('keeps `*` inside one path segment and lets `**` span segments', () => {
    const single = scope(ROOT, 'src/*.ts\n');
    expect(isIgnoredByScopes(at('src', 'a.ts'), false, single)).toBe(true);
    expect(isIgnoredByScopes(at('src', 'nested', 'a.ts'), false, single)).toBe(false);

    const deep = scope(ROOT, 'src/**/*.ts\n');
    expect(isIgnoredByScopes(at('src', 'nested', 'a.ts'), false, deep)).toBe(true);
    expect(isIgnoredByScopes(at('src', 'a.ts'), false, deep)).toBe(true);
  });

  it('scopes a nested ignore file to its own subtree', () => {
    const nested = [{ dir: at('pkg'), rules: parseIgnoreRules('dist/\n') }];
    expect(isIgnoredByScopes(at('pkg', 'dist'), true, nested)).toBe(true);
    // A sibling tree is governed by its own file, not this one.
    expect(isIgnoredByScopes(at('other', 'dist'), true, nested)).toBe(false);
  });

  it('skips comments and blank lines instead of treating them as patterns', () => {
    const rules = parseIgnoreRules('# comment\n\n   \nreal\n');
    expect(rules).toHaveLength(1);
    expect(isIgnoredByScopes(at('real'), false, [{ dir: ROOT, rules }])).toBe(true);
    expect(isIgnoredByScopes(at('# comment'), false, [{ dir: ROOT, rules }])).toBe(false);
  });

  it('drops an unparseable pattern rather than failing the whole walk', () => {
    // A lone `[` is an invalid character class; the walk must keep working.
    const rules = parseIgnoreRules('[\nreal\n');
    expect(isIgnoredByScopes(at('real'), false, [{ dir: ROOT, rules }])).toBe(true);
  });

  it('never applies rules to paths outside the declaring directory', () => {
    const rules = scope(at('pkg'), 'secret\n');
    expect(isIgnoredByScopes(at('pkg', 'secret'), false, rules)).toBe(true);
    expect(isIgnoredByScopes(at('secret'), false, rules)).toBe(false);
  });
});
