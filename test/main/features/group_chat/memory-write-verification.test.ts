import { describe, expect, it } from 'vitest';

import {
  claimsCompletedDurableMemoryWrite,
  DurableMemoryWriteEvidence,
  scrubCompletedDurableMemoryWriteClaims,
} from '../../../../src/main/features/group_chat/memory-write-verification';

function toolEvent(data: Record<string, unknown>) {
  return { type: 'event', event: { stream: 'tool', data } };
}

describe('durable-memory write evidence', () => {
  it('accepts a successful memory-write lifecycle', () => {
    const evidence = new DurableMemoryWriteEvidence();
    evidence.observe(toolEvent({
      phase: 'start', id: 'mem-1', name: 'cross_session_memory',
      arguments: { action: 'add', target: 'project', content: 'stable preference' },
    }));
    evidence.observe(toolEvent({
      phase: 'end', id: 'mem-1', name: 'cross_session_memory', isError: false,
      output: '{"ok":true}',
    }));

    expect(evidence.hasSuccessfulWrite()).toBe(true);
  });

  it('does not accept reads, failed writes, or unrelated successful tools', () => {
    const evidence = new DurableMemoryWriteEvidence();
    for (const [id, name, action, isError] of [
      ['list-1', 'cross_session_memory', 'list', false],
      ['write-1', 'cross_session_memory', 'replace', true],
      ['remove-1', 'cross_session_memory', 'remove', false],
      ['other-1', 'write_file', 'add', false],
    ] as const) {
      evidence.observe(toolEvent({ phase: 'start', id, name, arguments: { action } }));
      evidence.observe(toolEvent({ phase: 'end', id, name, isError }));
    }

    expect(evidence.hasSuccessfulWrite()).toBe(false);
  });

  it('joins an early start with the later validated arguments', () => {
    const evidence = new DurableMemoryWriteEvidence();
    evidence.observe(toolEvent({ phase: 'start', id: 'mem-2', name: 'cross_session_memory' }));
    evidence.observe(toolEvent({
      phase: 'progress', id: 'mem-2', name: 'cross_session_memory',
      arguments: { action: 'replace', target: 'project', old_text: 'old', content: 'new' },
    }));
    evidence.observe(toolEvent({
      phase: 'end', id: 'mem-2', name: 'cross_session_memory', isError: false,
    }));

    expect(evidence.hasSuccessfulWrite()).toBe(true);
  });
});

describe('unsupported durable-memory success claims', () => {
  it('recognizes the sampled Chinese failure and English equivalents', () => {
    expect(claimsCompletedDurableMemoryWrite(
      '记下了，六条全部写入项目长期笔记，写代码时会逐条对照。',
    )).toBe(true);
    expect(claimsCompletedDurableMemoryWrite(
      "I've saved all six rules to the project's persistent memory.",
    )).toBe(true);
  });

  it('recognizes localized Japanese and Portuguese completion shapes', () => {
    expect(claimsCompletedDurableMemoryWrite(
      'プロジェクトの長期メモリに保存しました。',
    )).toBe(true);
    expect(claimsCompletedDurableMemoryWrite(
      'Salvei as regras na memória persistente do projeto.',
    )).toBe(true);
  });

  it('rejects future, negated, historical, and turn-local look-alikes', () => {
    const rejected = [
      '我会把这六条写入项目长期笔记。',
      '这些内容尚未保存到项目长期记忆，请重试。',
      '此前已经保存到项目长期记忆，本轮没有改动。',
      '我记下当前讨论，供本轮回答使用。',
      'I will save this to persistent project memory after you confirm.',
      'I have not saved this to long-term memory.',
      'This was previously stored in project memory.',
    ];
    for (const text of rejected) {
      expect(claimsCompletedDurableMemoryWrite(text), text).toBe(false);
    }
  });

  it('does not treat ordinary profile, preference, or notes files as durable memory', () => {
    const fileDeliveries = [
      "I've saved the project profile to report.json.",
      'I saved the user preferences to settings.json.',
      'The project notes were successfully saved to NOTES.md.',
      '项目档案已保存到 report.json。',
      '项目笔记已经写入 NOTES.md。',
      'プロジェクトのメモを report.md に保存しました。',
      'O perfil do projeto foi salvo no arquivo report.json.',
    ];
    for (const text of fileDeliveries) {
      expect(claimsCompletedDurableMemoryWrite(text), text).toBe(false);
    }
  });

  it('still recognizes explicitly durable profile, preference, and notes claims', () => {
    const durableClaims = [
      '这些规则已保存到长期项目档案。',
      "I've saved this to the persistent user profile.",
      'プロジェクトの長期メモに保存しました。',
      'Salvei no perfil persistente do projeto.',
    ];
    for (const text of durableClaims) {
      expect(claimsCompletedDurableMemoryWrite(text), text).toBe(true);
    }
  });

  it('removes only unsupported claim sentences and preserves useful delivery', () => {
    const result = scrubCompletedDurableMemoryWriteClaims([
      '记下了，六条全部写入项目长期笔记，写代码时会逐条对照。',
      '',
      '关于这套模拟器，我建议先固定状态转移规则，再实现界面。',
    ].join('\n'));

    expect(result.removedClaims).toBe(1);
    expect(result.text).toBe('关于这套模拟器，我建议先固定状态转移规则，再实现界面。');
  });

  it('preserves quoted and code-fenced examples verbatim', () => {
    const text = [
      '> 错误示例：我已保存到项目长期记忆。',
      '```text',
      'I have saved it to persistent project memory.',
      '```',
      '不要声称“已保存到项目长期记忆”。',
    ].join('\n');

    expect(scrubCompletedDurableMemoryWriteClaims(text)).toEqual({
      text,
      removedClaims: 0,
    });
  });
});
