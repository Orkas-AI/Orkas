import { describe, expect, it } from 'vitest';

import {
  findOuterTagRanges,
  splitMarkdownProseCode,
} from '../../../src/main/util/markdown-prose-code';

// Renderer intentionally cannot import Main code. This test is the executable
// sync contract for the two small parser copies.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require('../../../src/renderer/modules/strip-structural-blocks.js') as {
  _splitMarkdownProseCode: typeof splitMarkdownProseCode;
  _findOuterTagRanges: typeof findOuterTagRanges;
};

const PARITY_INPUTS = [
  '',
  'ordinary prose',
  'before `inline <agent>x</agent>` after',
  'before ``inline ` ticks <agent>x</agent>`` after',
  '```\n<agent>example</agent>\n```',
  '~~~json\n<agent>example</agent>\n~~~~',
  '```xml\n<agent>real</agent>\n```',
  '```\n<agent>example</agent>\n``` trailing\n<agent>still code</agent>\n```\n<agent>real</agent>',
  '<agent data-label="1 > 0">body `code`</agent>\ntail',
  '<agent data-label="1 > 0" />\ntail',
  '请原样显示 “<agent>示例</agent>”',
  '<agent-input-form>\n[]\n</agent-input-form>',
  '````\n```xml\n<agent>example</agent>\n```\n````',
] as const;

describe('Main/Renderer structural markdown parser parity', () => {
  it.each(PARITY_INPUTS)('keeps both layer copies identical for %j', (input) => {
    expect(splitMarkdownProseCode(input))
      .toEqual(renderer._splitMarkdownProseCode(input));
    for (const tag of ['agent', 'agent-input-form', 'skill']) {
      expect(findOuterTagRanges(input, tag))
        .toEqual(renderer._findOuterTagRanges(input, tag));
    }
  });

  it('keeps the split lossless across deterministic delimiter mutations', () => {
    const fences = ['```', '````', '~~~'];
    const infos = ['', 'json', 'xml', 'XML title=sample'];
    const bodies = [
      '<agent>x</agent>',
      '`inline` and <skill>x</skill>',
      '“<agent>quoted</agent>”',
    ];
    for (const fence of fences) {
      for (const info of infos) {
        for (const body of bodies) {
          const input = `lead\n${fence}${info}\n${body}\n${fence}\ntail`;
          const main = splitMarkdownProseCode(input);
          expect(main.map((segment) => segment.text).join('')).toBe(input);
          expect(main).toEqual(renderer._splitMarkdownProseCode(input));
          expect(findOuterTagRanges(input, 'agent'))
            .toEqual(renderer._findOuterTagRanges(input, 'agent'));
        }
      }
    }
  });
});

describe('structural markdown expected results', () => {
  it('does not treat a fence marker with trailing text as a Markdown close', () => {
    const input = [
      '```',
      '<agent>example</agent>',
      '``` trailing text',
      '<agent>still code</agent>',
      '```',
      '<agent>real</agent>',
    ].join('\n');
    const ranges = findOuterTagRanges(input, 'agent');

    expect(ranges).toHaveLength(1);
    expect(input.slice(...ranges[0])).toBe('<agent>real</agent>');
  });

  it('removes only a self-closing structural tag instead of truncating later user-visible prose', () => {
    const input = 'before\n<agent data-state="empty" />\nafter';
    const ranges = findOuterTagRanges(input, 'agent');

    expect(ranges).toHaveLength(1);
    expect(input.slice(...ranges[0])).toBe('<agent data-state="empty" />');
    expect(input.slice(ranges[0][1])).toBe('\nafter');
  });

  it('finds the real end of an opening tag whose quoted attribute contains >', () => {
    const input = '<agent data-note="use > here" />\nvisible result';
    const ranges = findOuterTagRanges(input, 'agent');

    expect(ranges).toHaveLength(1);
    expect(input.slice(...ranges[0])).toBe('<agent data-note="use > here" />');
    expect(input.slice(ranges[0][1])).toBe('\nvisible result');
  });
});
