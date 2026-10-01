import { describe, it, expect } from 'vitest';
import { autoTitle } from '../../../src/main/features/chats';

// Heuristic autoTitle ladder: trim → filler strip (zh+en, longest-first, loop
// ≤ 5) → display-width truncate → fallback to original input → fallback to
// default-title key. Per CLAUDE.md text-munging rule: pin set A (must produce
// a clean title) AND set B (must NOT over-strip / must NOT crash).

/**
 * Independent width oracle. States the rule the titles must satisfy —
 * CJK, Hangul, fullwidth forms and emoji occupy two half-width cells —
 * rather than calling the production width table.
 */
function renderedWidth(text: string): number {
  let units = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const wide = (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x1f300 && cp <= 0x1faff);
    units += wide ? 2 : 1;
  }
  return units;
}

describe('autoTitle — set A (produces clean title)', () => {
  it('strips Chinese filler "看下" prefix', () => {
    expect(autoTitle('看下本地还有哪些修改没提交')).toBe('本地还有哪些修改没提交');
  });

  it('strips Chinese filler "请帮我" prefix', () => {
    expect(autoTitle('请帮我修复一下这个 bug')).toBe('修复一下这个 bug');
  });

  it('strips Chinese filler "想问问" prefix', () => {
    expect(autoTitle('想问问这个怎么实现')).toBe('这个怎么实现');
  });

  it('strips stacked Chinese fillers ("请帮我看下...")', () => {
    expect(autoTitle('请帮我看下数据库连接')).toBe('数据库连接');
  });

  it('strips English filler "Can you " case-insensitively', () => {
    expect(autoTitle('Can you help me debug this?')).toBe('debug this?');
  });

  it('strips stacked English fillers ("Could you please ...")', () => {
    expect(autoTitle('Could you please review my PR')).toBe('review my PR');
  });

  // These three cases pin punctuation handling, not length. Their expectations
  // used to end in an ellipsis only because the character cap happened to land
  // mid-string; the width budget lets the whole clause through, so the
  // preserved punctuation is now visible in the expected value itself.
  it('preserves punctuation and the clauses after it', () => {
    expect(autoTitle('本地修改，顺便看下提交')).toBe('本地修改，顺便看下提交');
    expect(autoTitle('Please review this PR, then push it.')).toBe('review this PR, then push it.');
  });

  it('preserves URL punctuation', () => {
    expect(autoTitle('你根据 https://orkas.ai')).toBe('你根据 https://orkas.ai');
    expect(autoTitle('分析 https://x.co/a?q=one,two')).toBe('分析 https://x.co/a?q=one,two');
    expect(autoTitle('查看 www.orkas.ai 的内容')).toBe('查看 www.orkas.ai 的内容');
  });

  it('preserves punctuation and text immediately after a URL', () => {
    expect(autoTitle('根据 https://orkas.ai，分析首页内容')).toBe('根据 https://orkas.ai，分析首页内容');
    expect(autoTitle('Review https://orkas.ai, then summarize')).toBe('Review https://orkas.ai, then summarize');
  });

  it('keeps full text when input lacks any filler', () => {
    expect(autoTitle('搜索下最新一个月的ai圈的主要事件'))
      .toBe('搜索下最新一个月的ai圈的主要事件');
  });

  it('collapses internal whitespace + newlines to single space', () => {
    expect(autoTitle('看下\n本地\n  修改')).toBe('本地 修改');
  });

  // A conversation list is scanned by eye, so two truncated titles must end at
  // the same place whatever script they are written in. Counting characters
  // did not: 25 Chinese characters render twice as wide as 25 Latin ones, so
  // rows ended raggedly and Latin titles were cut at half the useful length.
  it('ends a Chinese and a Latin title at the same rendered width', () => {
    const zh = autoTitle('一'.repeat(40));
    const en = autoTitle('A'.repeat(80));
    expect(zh.endsWith('…')).toBe(true);
    expect(en.endsWith('…')).toBe(true);
    expect(renderedWidth(zh)).toBe(renderedWidth(en));
  });

  it('keeps a Chinese title exactly as long as the character cap did', () => {
    // 25 full-width characters was the previous cap's output. Nothing may get
    // shorter for users who already have titles at that length.
    expect(autoTitle('一'.repeat(40))).toBe(`${'一'.repeat(25)}…`);
  });

  it('gives a Latin title the full width instead of half of it', () => {
    expect(autoTitle('A'.repeat(80))).toBe(`${'A'.repeat(50)}…`);
  });

  it('leaves a title that fits the budget untouched, and marks the one past it', () => {
    expect(autoTitle('A'.repeat(50))).toBe('A'.repeat(50));
    expect(autoTitle('A'.repeat(51))).toBe(`${'A'.repeat(50)}…`);
    expect(autoTitle('一'.repeat(25))).toBe('一'.repeat(25));
    expect(autoTitle('一'.repeat(26))).toBe(`${'一'.repeat(25)}…`);
  });

  it('never cuts a grapheme cluster in half', () => {
    const out = autoTitle('🙂'.repeat(40));
    expect(out).toBe(`${'🙂'.repeat(25)}…`);
    // A lone surrogate would survive a character slice but not a cluster walk.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('measures a mixed-script title by what it renders, not by character count', () => {
    // 20 full-width (40 units) + 10 half-width (10 units) exactly fills 50.
    const mixed = `${'一'.repeat(20)}${'A'.repeat(10)}`;
    expect(autoTitle(mixed)).toBe(mixed);
    expect(autoTitle(`${mixed}B`)).toBe(`${mixed}…`);
  });
});

describe('autoTitle — set B (must NOT over-strip / must NOT crash)', () => {
  it('pure-filler input falls back to original (not empty)', () => {
    expect(autoTitle('看下')).toBe('看下');
  });

  it('whitespace-only input falls back to default title key (non-empty)', () => {
    const out = autoTitle('   \n  \t  ');
    expect(out.length).toBeGreaterThan(0);
  });

  it('empty input falls back to default title key (non-empty)', () => {
    const out = autoTitle('');
    expect(out.length).toBeGreaterThan(0);
  });

  it('filler mid-text is NOT stripped (only leading)', () => {
    expect(autoTitle('本地的看下逻辑对吗')).toBe('本地的看下逻辑对吗');
  });

  it('preserves punctuation after a short first clause', () => {
    expect(autoTitle('AI，请说说看')).toBe('AI，请说说看');
  });

  it('null/undefined input does not throw', () => {
    expect(() => autoTitle(null as unknown as string)).not.toThrow();
    expect(() => autoTitle(undefined as unknown as string)).not.toThrow();
  });

  it('does not strip single-character "请" alone (would clip "请教...")', () => {
    expect(autoTitle('请教这个问题怎么解决')).toBe('请教这个问题怎么解决');
  });

  it('preserves non-filler English starting words', () => {
    expect(autoTitle('Search the latest AI news')).toBe('Search the latest AI news');
  });

  it('preserves punctuation in a look-alike URL scheme too', () => {
    expect(autoTitle('检查 httpsx://orkas.ai 的内容')).toBe('检查 httpsx://orkas.ai 的内容');
  });
});
