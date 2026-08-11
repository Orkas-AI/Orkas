import { describe, it, expect } from 'vitest';
import { autoTitle } from '../../../src/main/features/chats';

// Heuristic autoTitle ladder: trim → filler strip (zh+en, longest-first, loop
// ≤ 5) → 25 char truncate → fallback to original input → fallback to
// default-title key. Per CLAUDE.md text-munging rule: pin set A (must produce
// a clean title) AND set B (must NOT over-strip / must NOT crash).

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

  it('preserves punctuation and the clauses after it', () => {
    expect(autoTitle('本地修改，顺便看下提交')).toBe('本地修改，顺便看下提交');
    expect(autoTitle('Please review this PR, then push it.')).toBe('review this PR, then push…');
  });

  it('preserves URL punctuation', () => {
    expect(autoTitle('你根据 https://orkas.ai')).toBe('你根据 https://orkas.ai');
    expect(autoTitle('分析 https://x.co/a?q=one,two')).toBe('分析 https://x.co/a?q=one,t…');
    expect(autoTitle('查看 www.orkas.ai 的内容')).toBe('查看 www.orkas.ai 的内容');
  });

  it('preserves punctuation and text immediately after a URL', () => {
    expect(autoTitle('根据 https://orkas.ai，分析首页内容')).toBe('根据 https://orkas.ai，分析首页内…');
    expect(autoTitle('Review https://orkas.ai, then summarize')).toBe('Review https://orkas.ai, …');
  });

  it('keeps full text when input lacks any filler', () => {
    expect(autoTitle('搜索下最新一个月的ai圈的主要事件'))
      .toBe('搜索下最新一个月的ai圈的主要事件');
  });

  it('collapses internal whitespace + newlines to single space', () => {
    expect(autoTitle('看下\n本地\n  修改')).toBe('本地 修改');
  });

  it('truncates at 25 chars with ellipsis', () => {
    const atLimit = 'A'.repeat(25);
    const out = autoTitle('A'.repeat(26));
    expect(autoTitle(atLimit)).toBe(atLimit);
    expect(out.length).toBe(26);              // 25 + …
    expect(out).toBe(`${atLimit}…`);
    expect(out.endsWith('…')).toBe(true);
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
