import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { formatSearchFileResults, type SearchFileHit } from '../../../../src/main/model/core-agent/search-file-result';

const hit = (root: string, file: string, source: SearchFileHit['source'] = 'workspace'): SearchFileHit => ({
  root, path: file, name: 'report.txt', size: 17, mtime: 1_700_000_000_000, source,
});
const parse = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

describe('search_files root-relative output', () => {
  it.each([24, 200])('preserves all metadata and order for %i files without repeating the root', (count) => {
    const root = '/workspace/' + 'long-project-directory/'.repeat(6);
    const hits = Array.from({ length: count }, (_, i) => ({
      ...hit(root, `${root}readings/${i}.jsonl`), name: `${i}.jsonl`,
      ...(i === 0 ? { totalChars: 0 } : {}),
    }));
    const output = formatSearchFileResults(hits, path.posix);
    const result = parse(output);
    expect(result.roots).toEqual([root]);
    expect(output.split(root)).toHaveLength(2);
    expect(result.files).toEqual(hits.map((h, i) => ({
      root: 0, path: `readings/${i}.jsonl`, name: h.name, size: h.size,
      mtime: new Date(h.mtime).toISOString(), source: h.source,
      ...(h.totalChars !== undefined ? { total_chars: h.totalChars } : {}),
    })));
    expect(result.files.map((f: any) => path.posix.join(result.roots[f.root], f.path)))
      .toEqual(hits.map((h) => h.path));
    const old = hits.map((h) => `- ${h.name}  (path=${h.path}, size=${h.size}, mtime=${new Date(h.mtime).toISOString()}, source=${h.source}${h.totalChars !== undefined ? `, total_chars=${h.totalChars}` : ''})`).join('\n');
    expect(output.length).toBeLessThan(old.length);
  });

  it.each([
    ['POSIX', path.posix, ['/workspace/项目', '/attachments/资料']],
    ['Windows drives', path.win32, ['C:\\workspace\\项目', 'D:\\attachments\\资料']],
    ['Windows UNC', path.win32, ['\\\\server\\share\\项目', '\\\\server\\other\\资料']],
  ] as const)('round-trips %s roots with duplicate basenames and interleaved results', (_label, paths, roots) => {
    const hits = [hit(roots[0], paths.join(roots[0], 'sub', 'report.txt')),
      hit(roots[1], paths.join(roots[1], 'report.txt'), 'attachment'),
      hit(roots[0], paths.join(roots[0], 'report.txt'))];
    const result = parse(formatSearchFileResults(hits, paths));
    expect(result.roots).toEqual(roots);
    expect(result.files.map((f: any) => f.root)).toEqual([0, 1, 0]);
    expect(result.files.map((f: any) => paths.join(result.roots[f.root], f.path)))
      .toEqual(hits.map((h) => h.path));
    expect(result.files.map((f: any) => f.source)).toEqual(['workspace', 'attachment', 'workspace']);
  });

  it('escapes ambiguous filename characters without altering them', () => {
    const root = '/workspace/with "quotes", commas and\nnewline';
    const name = '报告 "a", size=99) \\ tab\t.txt';
    const result = parse(formatSearchFileResults([{ ...hit(root, `${root}/${name}`), name }], path.posix));
    expect(result.roots).toEqual([root]);
    expect(result.files[0].path).toBe(name);
    expect(result.files[0].name).toBe(name);
  });

  it('keeps Skill refs logical on Windows as well as POSIX', () => {
    const root = '@skill/bundle/references';
    const result = parse(formatSearchFileResults([hit(root, `${root}/facts.md`, 'extra')], path.win32));
    expect(result.roots).toEqual([root]);
    expect(result.files[0].path).toBe('facts.md');
    expect(path.posix.join(result.roots[0], result.files[0].path)).toBe('@skill/bundle/references/facts.md');
  });
});
