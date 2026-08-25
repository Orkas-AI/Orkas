import { describe, expect, it } from 'vitest';

import {
  contentDeliveryCheck,
  resolveDeliveryChecks,
  TERMINAL_CHECKS,
} from '../../../../src/main/features/group_chat/terminal-checks';

// Fixture pairs per PC/CLAUDE.md's text-processing rule: accepted real shapes
// AND rejected look-alikes. These three cases predate the registry (they were
// written against the 2026-08-08 ContentWriter failure) and must survive any
// refactor of how checks are selected.
describe('content-delivery terminal check', () => {
  it('requests one soft repair for a completion summary with no delivered draft', () => {
    const correction = contentDeliveryCheck(
      '卡片已全部完成。以上是面向小红书职场人群的 AI 办公助手社媒文章，按 SKILL 规范包含了两个场景示例、一条可复制提示模板、备选标题/CTA/话题标签，以及互动引导。如需调整角度，随时告诉我。',
    );

    expect(correction).toContain('一次性的软修复提示');
    expect(correction).toContain('完整成稿');
    expect(correction).toContain('不是长度门槛');
  });

  it('accepts complete copy even when it is intentionally short', () => {
    expect(contentDeliveryCheck([
      '别让会议纪要停在“记过了”',
      '',
      '会后把零散记录交给 AI 整理成决定、负责人和截止时间，再逐项核对原话。',
      '今天挑一场会试一次，并把需要判断的部分留给自己。',
    ].join('\n'))).toBeNull();
  });

  it('does not turn plans, audits, or normal closing notes into a draft gate', () => {
    expect(contentDeliveryCheck(
      '发布决定：HOLD。原文缺少剂量依据，须由专业医生审核。',
    )).toBeNull();
    expect(contentDeliveryCheck(
      '写作计划已完成：第一节解释问题，第二节给出方法，第三节总结行动。',
    )).toBeNull();
  });
});

describe('resolveDeliveryChecks (spec-driven selection)', () => {
  it('resolves a declared check to the registry function', () => {
    expect(resolveDeliveryChecks(['content-delivery'])).toBe(contentDeliveryCheck);
    expect(TERMINAL_CHECKS['content-delivery']).toBe(contentDeliveryCheck);
  });

  it('returns undefined when nothing is declared or nothing resolves', () => {
    expect(resolveDeliveryChecks(undefined)).toBeUndefined();
    expect(resolveDeliveryChecks([])).toBeUndefined();
    // Unknown names are skipped with a warning, never a throw: a typo in a
    // spec must degrade to "no guard", not break the agent's turn.
    expect(resolveDeliveryChecks(['no-such-check'])).toBeUndefined();
  });

  it('skips unknown names but keeps the resolvable remainder', () => {
    expect(resolveDeliveryChecks(['no-such-check', 'content-delivery'])).toBe(contentDeliveryCheck);
  });

  it('composes multiple resolved checks: declared order, first correction wins', () => {
    // The registry currently holds one check, so exercise the composition
    // branch by declaring it twice — two resolved entries, same semantics.
    const composed = resolveDeliveryChecks(['content-delivery', 'content-delivery']);
    expect(composed).toBeTypeOf('function');
    expect(composed).not.toBe(contentDeliveryCheck);
    expect(composed!('任务已完成。以上是文章，包含了标题、CTA。')).toContain('完整成稿');
    expect(composed!('正文如下：这是一段实际交付的完整内容。')).toBeNull();
  });
});
