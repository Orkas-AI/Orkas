import { describe, expect, it } from 'vitest';

import { slugifyConvTitle } from '../../../../src/main/features/group_chat/conv_workspace';


describe('conversation workspace slug', () => {
  it.each([
    [null, ''],
    ['', ''],
    ['   ', ''],
    ['New conversation', ''],
    ['新对话', ''],
    ['CON', ''],
    ['lPt9', ''],
  ])('falls back for unusable or reserved title %j', (input, expected) => {
    expect(slugifyConvTitle(input)).toBe(expected);
  });

  it('preserves unicode letters and numbers while normalizing ASCII', () => {
    expect(slugifyConvTitle('  Project 你好 １２ Test  ')).toBe('project-你好-１２-test');
  });

  it('replaces illegal path punctuation and drops emoji/control punctuation', () => {
    expect(slugifyConvTitle('A/B:C*D? E🔥F')).toBe('a-b-c-d-ef');
  });

  it('collapses whitespace and hyphens and trims edges', () => {
    expect(slugifyConvTitle('--Hello \n\t--- World--')).toBe('hello-world');
  });

  it('caps names at 32 code units without leaving a trailing hyphen', () => {
    expect(slugifyConvTitle('a'.repeat(31) + '-' + 'tail')).toBe('a'.repeat(31));
    expect(slugifyConvTitle('b'.repeat(40))).toBe('b'.repeat(32));
  });
});
