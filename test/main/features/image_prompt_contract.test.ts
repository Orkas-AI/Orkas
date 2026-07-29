import { describe, expect, it } from 'vitest';

import {
  compileImagePromptContract,
  normalizeImageReferenceBindings,
  normalizeImageStringList,
} from '../../../src/main/features/image_prompt_contract';

describe('image prompt contract', () => {
  it('normalizes semantic reference bindings and compiles a stable provider fallback', () => {
    const bindings = normalizeImageReferenceBindings([
      {
        index: 1,
        role: 'identity',
        strength: 0.875,
        preserve: [' face ', 'red jacket'],
        may_change: ['background'],
        region: ' hero ',
      },
      {
        index: 0,
        role: 'composition',
        preserve: ['diagonal reading order'],
      },
    ], 2);

    expect(bindings).toEqual([
      {
        index: 1,
        role: 'identity',
        strength: 0.875,
        preserve: ['face', 'red jacket'],
        mayChange: ['background'],
        region: 'hero',
      },
      {
        index: 0,
        role: 'composition',
        strength: 1,
        preserve: ['diagonal reading order'],
        mayChange: [],
      },
    ]);
    expect(compileImagePromptContract('Editorial portrait', bindings, ['garbled text', 'extra fingers'])).toBe([
      'Editorial portrait',
      [
        'Reference contract (reference numbers follow local paths first, then URLs):',
        '- Reference 2: role=identity; strength=0.88; target region=hero; preserve=face, red jacket; may change=background.',
        '- Reference 1: role=composition; strength=1.00; preserve=diagonal reading order.',
      ].join('\n'),
      'Avoid: garbled text; extra fingers.',
    ].join('\n\n'));
  });

  it('accepts camel-case mayChange for internal callers', () => {
    expect(normalizeImageReferenceBindings([{
      index: 0,
      role: 'style',
      mayChange: ['subject'],
    }], 1)[0]?.mayChange).toEqual(['subject']);
  });

  it('rejects duplicate, out-of-range, invalid-role, and invalid-strength bindings', () => {
    expect(() => normalizeImageReferenceBindings([{ index: 0, role: 'style' }, { index: 0, role: 'content' }], 2)).toThrow('repeats reference index 0');
    expect(() => normalizeImageReferenceBindings([{ index: 2, role: 'style' }], 2)).toThrow('outside the reference list');
    expect(() => normalizeImageReferenceBindings([{ index: 0, role: 'artist' }], 1)).toThrow('role is invalid');
    expect(() => normalizeImageReferenceBindings([{ index: 0, role: 'style', strength: 1.1 }], 1)).toThrow('must be from 0 to 1');
  });

  it('requires non-empty prompt and string-list values', () => {
    expect(() => normalizeImageStringList(['ok', ' '], 'negative_prompt')).toThrow('array of non-empty strings');
    expect(() => compileImagePromptContract(' ', [], [])).toThrow('prompt is required');
  });
});
