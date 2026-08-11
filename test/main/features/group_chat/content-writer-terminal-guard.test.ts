import { describe, expect, it } from 'vitest';

import {
  contentWriterTerminalTextGuard,
  terminalTextGuardForAgent,
} from '../../../../src/main/features/group_chat/content-writer-terminal-guard';

describe('ContentWriter terminal text guard', () => {
  it('requests one soft repair for a completion summary with no delivered draft', () => {
    const correction = contentWriterTerminalTextGuard(
      '卡片已全部完成。以上是面向小红书职场人群的 AI 办公助手社媒文章，按 SKILL 规范包含了两个场景示例、一条可复制提示模板、备选标题/CTA/话题标签，以及互动引导。如需调整角度，随时告诉我。',
    );

    expect(correction).toContain('一次性的软修复提示');
    expect(correction).toContain('完整成稿');
    expect(correction).toContain('不是长度门槛');
  });

  it('accepts complete copy even when it is intentionally short', () => {
    expect(contentWriterTerminalTextGuard([
      '别让会议纪要停在“记过了”',
      '',
      '会后把零散记录交给 AI 整理成决定、负责人和截止时间，再逐项核对原话。',
      '今天挑一场会试一次，并把需要判断的部分留给自己。',
    ].join('\n'))).toBeNull();
  });

  it('does not turn plans, audits, or normal closing notes into a draft gate', () => {
    expect(contentWriterTerminalTextGuard(
      '发布决定：HOLD。原文缺少剂量依据，须由专业医生审核。',
    )).toBeNull();
    expect(contentWriterTerminalTextGuard(
      '写作计划已完成：第一节解释问题，第二节给出方法，第三节总结行动。',
    )).toBeNull();
  });

  it('is attached only to the bundled ContentWriter agent', () => {
    expect(terminalTextGuardForAgent('173d4235a431')).toBe(contentWriterTerminalTextGuard);
    expect(terminalTextGuardForAgent('7e91cb9ec9e9')).toBeUndefined();
    expect(terminalTextGuardForAgent(undefined)).toBeUndefined();
  });
});
