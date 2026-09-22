import { describe, expect, it } from 'vitest';
import { formatGrepFileResults, type GrepHit } from '../../../../src/main/model/core-agent/grep-file-result';

// Independent consumer: each row must still identify its exact source and position.
function rows(output: string) {
  let file: string | undefined;
  return output.split('\n').flatMap(line => {
    if (line.startsWith('file: ')) {
      file = JSON.parse(line.slice(6));
      return [];
    }
    if (!line) return [];
    const match = /^  (:\d+:\d+|-\d+-|\+\d+\+)  (.*)$/.exec(line);
    if (!file || !match) throw new Error('Invalid search row');
    return [{ file, position: match[1], text: match[2] }];
  });
}

describe('grep_files content formatting', () => {
  it.each([
    '/workspace/项目/notes.ts',
    'C:\\workspace\\项目\\notes.ts',
    '\\\\server\\share\\notes.ts',
    '@skill/bundle/references/notes.md',
    '/workspace/quote" tab\t line\n slash\\.ts',
  ])('preserves exact addresses, columns and overlapping context: %s', file => {
    const hits: GrepHit[] = [
      { path: file, line: 2, column: 4, snippet: '   needle one',
        before: [{ line: 1, text: 'before' }], after: [{ line: 3, text: '' }] },
      { path: file, line: 4, column: 1, snippet: 'needle two',
        before: [{ line: 3, text: '' }], after: [{ line: 5, text: 'file: "data, not a heading"' }] },
    ];
    const output = formatGrepFileResults(hits);
    expect(output.split('\n').filter(line => line.startsWith('file: '))).toHaveLength(1);
    expect(rows(output)).toEqual([
      { file, position: '-1-', text: 'before' },
      { file, position: ':2:4', text: '   needle one' },
      { file, position: '+3+', text: '' },
      { file, position: '-3-', text: '' },
      { file, position: ':4:1', text: 'needle two' },
      { file, position: '+5+', text: 'file: "data, not a heading"' },
    ]);
  });

  it('preserves hit order across interleaved roots and duplicate basenames', () => {
    const files = ['/workspace/a.ts', '/attachments/a.ts', '/workspace/a.ts'];
    const output = formatGrepFileResults(files.map((file, index) => ({
      path: file, line: index + 1, column: 1, snippet: 'needle', before: [], after: [],
    })));
    expect(rows(output)).toEqual(files.map((file, index) => ({ file, position: `:${index + 1}:1`, text: 'needle' })));
    expect(formatGrepFileResults([])).toBe('');
  });
});
