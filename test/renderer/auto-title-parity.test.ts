/**
 * Lock the regex/constant parity between
 *   `src/main/util/auto-title.ts`         (backend persistence path —
 *                                          imported by features/chats.ts)
 *   `src/renderer/modules/auto-title.js`  (renderer optimistic title path —
 *                                          loaded as a `<script>` and
 *                                          consumed via the `_autoTitle`
 *                                          global by agents.js /
 *                                          conversation.js / project-detail.js)
 *
 * The two copies exist because PC/CLAUDE.md §8 forbids `import` / `export`
 * in renderer files — they have to mirror by hand. This fixture is the
 * machinery that turns drift into a loud CI failure: adding a filler word
 * to one side without the other immediately fails the test.
 *
 * Also includes a functional fixture set that runs the renderer
 * `_autoTitle` on the same inputs `chats-autotitle.test.ts` pins for the
 * backend `autoTitle`, asserting both surfaces produce the same stripped
 * output. (The backend wraps the empty-result fall-through with
 * `t('chat.default_title')`; the renderer returns '' and lets the caller
 * fall back. The functional comparison runs on the pre-fallback transform
 * only — we slice the comparison to inputs whose stripped form is
 * non-empty, since the empty-input fallback is locale-dependent on the
 * backend side and out of scope for the parity check.)
 */

import { describe, it, expect } from 'vitest';

import * as mainAutoTitle from '../../src/main/util/auto-title';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rendererAutoTitle = require('../../src/renderer/modules/auto-title.js');
import { autoTitle as backendAutoTitle } from '../../src/main/features/chats';

const renderer: {
  _autoTitle: (text: string) => string;
  _AUTO_TITLE_ZH_FILLER: RegExp;
  _AUTO_TITLE_EN_FILLER: RegExp;
  _AUTO_TITLE_MAX_UNITS: number;
  _truncateTitleToWidth: (text: string) => string;
} = rendererAutoTitle;

describe('auto-title parity › regex source / flags match across main + renderer', () => {
  it('ZH_FILLER_RE.source matches', () => {
    expect(renderer._AUTO_TITLE_ZH_FILLER.source).toBe(mainAutoTitle.ZH_FILLER_RE.source);
  });

  it('ZH_FILLER_RE.flags match', () => {
    expect(renderer._AUTO_TITLE_ZH_FILLER.flags).toBe(mainAutoTitle.ZH_FILLER_RE.flags);
  });

  it('EN_FILLER_RE.source matches', () => {
    expect(renderer._AUTO_TITLE_EN_FILLER.source).toBe(mainAutoTitle.EN_FILLER_RE.source);
  });

  it('EN_FILLER_RE.flags match (case-insensitive on the EN list)', () => {
    expect(renderer._AUTO_TITLE_EN_FILLER.flags).toBe(mainAutoTitle.EN_FILLER_RE.flags);
  });

  it('the display-width budget matches', () => {
    expect(renderer._AUTO_TITLE_MAX_UNITS).toBe(mainAutoTitle.TITLE_MAX_UNITS);
  });
});

/**
 * The renderer cannot import `util/name-limit.ts`, so it carries its own copy
 * of the width table. Equal budgets prove nothing if the tables disagree about
 * which code points are double-width, and the optimistic renderer title would
 * then flicker into a different string when the backend one arrives. One
 * fixture per width class the table distinguishes.
 */
describe('auto-title parity › width table agrees on every script class', () => {
  const widthCases: Array<[string, string]> = [
    ['Han', '一'.repeat(40)],
    ['Hangul', '가'.repeat(40)],
    ['Hiragana', 'あ'.repeat(40)],
    ['fullwidth Latin', 'Ａ'.repeat(40)],
    ['halfwidth Latin', 'A'.repeat(80)],
    ['emoji', '🙂'.repeat(40)],
    ['emoji with a variation selector', '☘️'.repeat(40)],
    ['combining marks', 'e\u0301'.repeat(60)],
    ['mixed scripts at the boundary', `${'一'.repeat(20)}${'A'.repeat(12)}`],
    ['CJK punctuation', '，'.repeat(40)],
  ];

  for (const [label, input] of widthCases) {
    it(`agrees on ${label}`, () => {
      expect(renderer._truncateTitleToWidth(input)).toBe(mainAutoTitle.truncateTitleToWidth(input));
    });
  }

  it('the fixtures actually exercise truncation', () => {
    const truncated = widthCases.filter(([, input]) => renderer._truncateTitleToWidth(input).endsWith('…'));
    expect(truncated.length).toBe(widthCases.length - 1);
  });
});

describe('auto-title parity › functional equivalence on representative inputs', () => {
  // Shared inputs whose stripped form is non-empty (so the renderer ''
  // fallback and the backend `t()` fallback don't diverge by design).
  const cases = [
    '看下本地还有哪些修改没提交',
    '请帮我修复一下这个 bug',
    '想问问这个怎么实现',
    '请帮我看下数据库连接',
    'Can you help me debug this?',
    'Please review this PR',
    'I want to refactor the auth flow',
    '帮我写一段 TypeScript 来解析 csv，谢谢',
    '你根据 https://orkas.ai',
    '分析 https://x.co/a?q=one,two',
    '查看 www.orkas.ai 的内容',
    '根据 https://orkas.ai，分析首页内容',
    'Review https://orkas.ai, then summarize',
    '检查 httpsx://orkas.ai 的内容',
    '这是一个很长的对话标题，应该会被显示宽度的上限截断到刚好显示，后面这些字就看不到了',
    'Research the top five competitors in the AI coding agent space and summarize them',
    'AI，怎么样',
  ];

  for (const input of cases) {
    it(`backend autoTitle and renderer _autoTitle agree on: ${JSON.stringify(input.slice(0, 25))}`, () => {
      expect(backendAutoTitle(input)).toBe(renderer._autoTitle(input));
    });
  }
});
