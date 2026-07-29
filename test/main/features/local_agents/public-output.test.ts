import { describe, expect, it } from 'vitest';

import { sanitizeLocalAgentPublicOutput } from '../../../../src/main/features/local_agents/public-output';

describe('local_agents/public-output', () => {
  it('publishes only the result from a real Hermes KSTAR scaffold', () => {
    const raw = [
      'K — 知识',
      '- 用户画像：PRIVATE_PROFILE_SENTINEL',
      'S — 情境',
      '- 用户只是打了个招呼。',
      'T — 任务',
      '- 回复用户。',
      'Â — 行动',
      '- 生成简短问候。',
      'R̂ — 预期结果',
      '- 不泄露内部上下文。',
      'R — 结果',
      '你好！今天想一起处理什么？',
      'ΔR — 差距',
      '- 无。',
      'AAR — 复盘',
      '- 已完成。',
    ].join('\n');

    const output = sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '你好',
    });

    expect(output).toBe('你好！今天想一起处理什么？');
    expect(output).not.toContain('PRIVATE_PROFILE_SENTINEL');
    expect(output).not.toContain('AAR');
  });

  it('accepts Markdown headings and an inline result label', () => {
    const raw = [
      '**K — Knowledge**',
      'context',
      '**S — Situation**',
      'greeting',
      '**T — Task**',
      'reply',
      '**A — Action**',
      'compose',
      '**R — Result: Ready to help.**',
      '**AAR — Retrospective**',
      'done',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Hello',
    })).toBe('Ready to help.');
  });

  it('accepts heading, separator, label, and newline variants', () => {
    const raw = [
      '### K（知识）：known context',
      '### S (Situation): greeting',
      '### T - reply',
      '### Â (Action) – compose',
      '### R̂（预期结果）：concise answer',
      '### R (Result)：结果：兼容后的公开答案',
      '### ΔR (Gap): none',
      '### AAR（复盘）：done',
    ].join('\r\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '你好',
    })).toBe('兼容后的公开答案');
  });

  it('leaves an ordinary answer with a KSTAR-like fragment unchanged', () => {
    const raw = 'A normal explanation may mention this notation:\nK — Knowledge\nThat alone is not a private scaffold.';

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Explain the notation',
    })).toBe(raw);
  });

  it('does not treat a fenced KSTAR example as an emitted scaffold', () => {
    const raw = [
      'Here is the template:',
      '```text',
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: example',
      'AAR — Retrospective',
      '```',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Show a template',
    })).toBe(raw);
  });

  it('suppresses a recognized private scaffold when no public result exists', () => {
    const raw = [
      'K — Knowledge',
      'PRIVATE_PROFILE_SENTINEL',
      'S — Situation',
      'greeting',
      'T — Task',
      'reply',
      'A — Action',
      'interrupted before result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Hello',
    })).toBe('');
  });

  it('preserves KSTAR when the user explicitly requests that format', () => {
    const raw = [
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: requested output',
      'AAR — Retrospective',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '请使用 KSTAR 格式回答',
    })).toBe(raw);
  });

  it.each([
    '请按 K、S、T、A、R 五段回答',
    'Please answer using sections K, S, T, A, and R.',
    'Use K/S/T/A/R format.',
  ])('preserves explicitly requested K/S/T/A/R sections: %s', (userTask) => {
    const raw = [
      'K — Knowledge',
      'requested knowledge',
      'S — Situation',
      'requested situation',
      'T — Task',
      'requested task',
      'A — Action',
      'requested action',
      'R — Result: requested result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask,
    })).toBe(raw);
  });

  it.each([
    'Please answer whether K, S, T, A, and R are used as variable names.',
    '请回答 K、S、T、A、R 是否只是变量名。',
    'Use K/S/A/T/R format.',
    'Use K/S/T/A format.',
    `Use K ${'context '.repeat(24)}S/T/A/R format.`,
  ])('does not preserve a scaffold without an explicit ordered section request: %s', (userTask) => {
    const raw = [
      'K — Knowledge',
      'private knowledge',
      'S — Situation',
      'private situation',
      'T — Task',
      'private task',
      'A — Action',
      'private action',
      'R — Result: public result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask,
    })).toBe('public result');
  });

  it('does not rewrite another CLI runtime', () => {
    const raw = [
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: keep all sections',
      'AAR — Retrospective',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'codex',
      text: raw,
      userTask: 'Summarize',
    })).toBe(raw);
  });
});
