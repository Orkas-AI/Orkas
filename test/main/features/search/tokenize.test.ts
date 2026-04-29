import { describe, it, expect } from 'vitest';
import { tokenize, termFrequencies, isCJK, STOP_TOKENS } from '../../../../src/main/features/search/tokenize';

describe('tokenize › isCJK', () => {
  it.each(['中', '文', '日', '한', 'あ', 'カ'])('detects CJK char %s', (ch) => {
    expect(isCJK(ch)).toBe(true);
  });

  it.each(['a', '1', '_', ' ', '!', 'é'])('rejects non-CJK char %s', (ch) => {
    expect(isCJK(ch)).toBe(false);
  });
});

describe('tokenize › edge cases', () => {
  it('returns [] for empty / null / non-string', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize(123)).toEqual([]);
    expect(tokenize({})).toEqual([]);
  });

  it('returns [] for whitespace-only / punctuation-only', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
    expect(tokenize('---___')).toEqual(['___']); // _ counts as ASCII word char
  });
});

describe('tokenize › ASCII words', () => {
  it('lowercases and emits word runs of length ≥ 2', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('drops single-char ASCII runs', () => {
    expect(tokenize('a b c hello')).toEqual(['hello']);
  });

  it('treats _ and digits as part of words', () => {
    expect(tokenize('var_name 12 abc123')).toEqual(['var_name', '12', 'abc123']);
  });

  it('skips stop words', () => {
    // 'the', 'is' are stop tokens; 'fox' is not
    expect(tokenize('the quick fox is brown')).toEqual(['quick', 'fox', 'brown']);
  });
});

describe('tokenize › CJK', () => {
  it('emits unigram + 2-gram for adjacent CJK chars (bigram between unigrams)', () => {
    // For each CJK char i: push unigram(i), push bigram(i,i+1) if both non-stop.
    // So '中文' → '中', '中文', '文'.
    expect(tokenize('中文')).toEqual(['中', '中文', '文']);
  });

  it('emits only unigram for isolated CJK char', () => {
    expect(tokenize('中')).toEqual(['中']);
  });

  it('breaks 2-gram across non-CJK boundary', () => {
    expect(tokenize('中a文')).toEqual(['中', '文']);
  });

  it('skips stop CJK chars from unigrams', () => {
    // '的' and '是' are stop tokens. Body chars 中, 文 emit normally.
    expect(tokenize('中是文')).toEqual(['中', '文']);
  });

  it('does not form 2-gram if either side is a stop char', () => {
    // 中 is non-stop, 的 is stop → no 2-gram
    expect(tokenize('中的')).toEqual(['中']);
    // 的 stop, 文 non-stop → no 2-gram
    expect(tokenize('的文')).toEqual(['文']);
  });
});

describe('tokenize › mixed text', () => {
  it('handles English + CJK + numbers + punctuation in one shot', () => {
    const tokens = tokenize('Hello 中文 world! v2.0');
    // ASCII: 'hello', 'world', 'v2', '0'(too short, dropped)
    // CJK: '中', '文', '中文'
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('v2');
    expect(tokens).toContain('中');
    expect(tokens).toContain('文');
    expect(tokens).toContain('中文');
  });

  it('respects insertion order', () => {
    expect(tokenize('foo 中文 bar')).toEqual(['foo', '中', '中文', '文', 'bar']);
  });
});

describe('termFrequencies', () => {
  it('counts repeated tokens', () => {
    const tf = termFrequencies('foo bar foo baz foo');
    expect(tf.foo).toBe(3);
    expect(tf.bar).toBe(1);
    expect(tf.baz).toBe(1);
  });

  it('returns object with null prototype to avoid pollution', () => {
    const tf = termFrequencies('foo');
    expect(Object.getPrototypeOf(tf)).toBeNull();
  });

  it('returns empty object for empty input', () => {
    expect(termFrequencies('')).toEqual({});
  });
});

describe('STOP_TOKENS', () => {
  it('includes common Chinese stop chars', () => {
    expect(STOP_TOKENS.has('的')).toBe(true);
    expect(STOP_TOKENS.has('是')).toBe(true);
  });

  it('includes common English stop words', () => {
    expect(STOP_TOKENS.has('the')).toBe(true);
    expect(STOP_TOKENS.has('and')).toBe(true);
  });

  it('does not include content words', () => {
    expect(STOP_TOKENS.has('hello')).toBe(false);
    expect(STOP_TOKENS.has('中')).toBe(false);
  });
});
