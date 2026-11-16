import { describe, expect, it } from 'vitest';

import {
  NAME_DISPLAY_MAX_UNITS,
  limitNameDisplayText,
  nameDisplayWidth,
} from '../../../src/main/util/name-limit';

describe('name limit util', () => {
  it('counts ASCII as 1 and CJK/Japanese as 2', () => {
    expect(NAME_DISPLAY_MAX_UNITS).toBe(60);
    expect(nameDisplayWidth('a'.repeat(60))).toBe(60);
    expect(nameDisplayWidth('中'.repeat(30))).toBe(60);
    expect(nameDisplayWidth('あ'.repeat(30))).toBe(60);
  });

  it('truncates to the final display-width limit', () => {
    expect(limitNameDisplayText('a'.repeat(61))).toBe('a'.repeat(60));
    expect(limitNameDisplayText('中'.repeat(31))).toBe('中'.repeat(30));
    expect(limitNameDisplayText('あ'.repeat(31))).toBe('あ'.repeat(30));
  });

  it('counts CJK Extension B and later ideographs as 2', () => {
    // U+20BB7 and U+2A6A5 sit outside the BMP (Extension B), U+30000 is Extension G.
    expect(nameDisplayWidth('\u{20BB7}')).toBe(2);
    expect(nameDisplayWidth('\u{2A6A5}\u{30000}')).toBe(4);
    expect(limitNameDisplayText('\u{20BB7}'.repeat(31))).toBe('\u{20BB7}'.repeat(30));
  });
});
