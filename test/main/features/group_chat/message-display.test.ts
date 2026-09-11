import { describe, expect, it } from 'vitest';
import { commanderMentionDisplayText, stripReservedRoutingMentions } from '../../../../src/main/features/group_chat/message-display';

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
