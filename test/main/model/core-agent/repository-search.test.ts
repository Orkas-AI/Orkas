import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  grepRepository,
  listRepositoryFiles,
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
