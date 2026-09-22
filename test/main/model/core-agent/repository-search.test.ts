import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  grepRepository,
  isIgnoredByScopes,
  listRepositoryFiles,
  parseIgnoreRules,
  visitRepositoryFiles,
  createRepositorySearchBudget,
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
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(RG_AVAILABLE)('repository search streaming bounds', () => {
  it('streams every filename without retaining a bounded prefix as the search universe', async () => {
    const root = tempRepository();
    const expected = Array.from({ length: 2100 }, (_, i) => `file-${i}.txt`);
    for (const name of expected) fs.writeFileSync(path.join(root, name), 'x');
    const seen: string[] = [];
    const result = await visitRepositoryFiles(root, async file => {
      seen.push(path.basename(file));
      return false;
    });
    expect(result).toEqual({ backend: 'rg', capped: false });
    expect(seen.sort()).toEqual(expected.sort());
  });

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

describe('repository search interruption', () => {
  it.each([
    ['deadline', 'list'], ['cancel', 'list'], ['deadline', 'grep'], ['cancel', 'grep'],
  ])('keeps partial results and terminates the child on %s (%s)', async (mode, operation) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', null));
      return true;
    });
    const cp = createRequire(import.meta.url)('node:child_process');
    vi.spyOn(cp, 'spawn').mockImplementation(() => child);
    syncBuiltinESMExports();
    const controller = new AbortController();
    const budget = createRepositorySearchBudget(controller.signal, mode === 'deadline' ? 30 : 1000);
    try {
      const root = tempRepository();
      const result = operation === 'list'
        ? listRepositoryFiles(root, 200, { signal: budget.signal })
        : grepRepository(root, { pattern: 'needle', regex: false, caseSensitive: true,
          contextLines: 0, maxResults: 200, includeGlobs: [], excludeGlobs: [], signal: budget.signal });
      child.stdout.write(operation === 'list' ? 'kept.txt\0' : `${JSON.stringify({
        type: 'match', data: { path: { text: 'kept.txt' }, lines: { text: 'needle\n' },
          line_number: 1, submatches: [{ start: 0, end: 6 }] },
      })}\n`);
      if (mode === 'cancel') setTimeout(() => controller.abort(), 10);
      const value = await result;
      const files = 'files' in value ? value.files : value.hits.map(hit => hit.path);
      expect(files.map(file => path.basename(file))).toEqual(['kept.txt']);
      if ('hits' in value) {
        expect(value.error).toBeUndefined();
        expect(value.hits[0]).toMatchObject({ line: 1, column: 1, text: 'needle' });
      }
      expect(value.interrupted).toBe(true);
      expect(child.kill).toHaveBeenCalled();
      expect(budget.reason()).toBe(mode === 'deadline' ? 'time_budget' : 'cancelled');
    } finally { budget.dispose(); }
  });

  it('does not start a child for an already cancelled search', async () => {
    const cp = createRequire(import.meta.url)('node:child_process');
    const spawn = vi.spyOn(cp, 'spawn');
    syncBuiltinESMExports();
    const result = await listRepositoryFiles(tempRepository(), 10, { signal: AbortSignal.abort() });
    expect(result.interrupted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
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
