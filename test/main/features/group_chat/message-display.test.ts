import { describe, expect, it } from 'vitest';
import { classifyNativeCommentary, normalizeNativeMessageDisplay, commanderMentionDisplayText, stripReservedRoutingMentions } from '../../../../src/main/features/group_chat/message-display';

describe('native transcript classification', () => {
  it.each([{ process: [] }, { process: [{ type: 'event' as const,
    event: { stream: 'runtime', data: { phase: 'interrupted', duration_ms: 13374 } } }] }])(
    'keeps a structured interruption notice in the reply body regardless of clock availability', ({ process }) => {
      const record = { id: 'interrupted', ts: '2026-10-26T14:31:24', from: 'codex', to: ['user'],
        turn_id: 't', source_message_id: 'u', seg: 0, system_kind: 'reply_interrupted' as const,
        text: 'The previous reply was interrupted.', process };
      expect(normalizeNativeMessageDisplay(record)).toBe(record);
    });

  it('stores commentary once while preserving the original source and tool order', () => {
    const record = { id: 'm0', ts: '2026-10-14T00:00:00', from: 'claude', to: ['user'],
      turn_id: 't', source_message_id: 'u', seg: 0, text: '  ## Complete report\n原文\n',
      process: [{ type: 'progress' as const, text: 'Read files' }] };
    const original = JSON.stringify(record);
    const stored = classifyNativeCommentary(record);
    expect(stored.text).toBe(record.text);
    expect(stored.process?.map(item => item.type === 'progress' ? item.text : '')).toEqual([record.text, 'Read files']);
    expect(classifyNativeCommentary(stored)).toBe(stored);
    expect(normalizeNativeMessageDisplay(stored)).toBe(stored);
    expect(JSON.stringify(record)).toBe(original);
    expect(normalizeNativeMessageDisplay({ ...record, display_phase: 'pending' }).display_phase).toBe('pending');
  });
});

describe('Commander mention display provenance', () => {
  it.each([
    ['@指挥官 @Codex 你好', 'preserve', '@指挥官 @Codex 你好'],
    ['@commander check @commander again', 'preserve', '@commander check @commander again'],
    ['@commander first @指挥官 second', 'hide_generated_prefix', 'first @指挥官 second'],
    ['@commander\n> context\n@指挥官 continue', 'hide_generated_prefix', '> context\n@指挥官 continue'],
    ['@commanderX literal @指挥官 continue', 'hide_generated_prefix', '@commanderX literal @指挥官 continue'],
    ['@commander legacy', undefined, undefined],
    ['@commander legacy', 'invalid', undefined],
  ])('projects %s with mode %s', (text, mode, expected) => {
    expect(commanderMentionDisplayText(text, mode)).toBe(expected);
  });

  it('keeps canonical cleanup compatible for prose, code, and look-alikes', () => {
    const text = 'ok @user, ask @指挥官 now\n`@commander`\n```text\n@指挥官\n```\nemail@commander @commanderX';
    expect(stripReservedRoutingMentions(text, new Set(['user', 'commander', '指挥官'])))
      .toBe('ok, ask now\n`@commander`\n```text\n@指挥官\n```\nemail@commander @commanderX');
  });
});
