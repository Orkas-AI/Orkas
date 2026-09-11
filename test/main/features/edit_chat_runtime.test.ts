import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendEditChatCommentaryProcessItem,
  ensureEditChatRuntimeProcessItem,
  normalizeEditChatRuntimeEvent,
  sanitizeEditChatCommentaryProcessItems,
} from '../../../src/main/features/edit_chat_runtime';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edit chat runtime normalization', () => {
  it('coalesces only adjacent commentary and preserves process chronology', () => {
    const items: any[] = [];
    appendEditChatCommentaryProcessItem(items, 'Inspect ', 10);
    appendEditChatCommentaryProcessItem(items, 'the skill.', 10);
    items.push({ type: 'progress', text: '▶ Read SKILL.md' });
    appendEditChatCommentaryProcessItem(items, 'Verify.', 10);

    expect(items).toEqual([
      {
        type: 'progress',
        text: 'Inspect the skill.',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
      { type: 'progress', text: '▶ Read SKILL.md' },
      {
        type: 'progress',
        text: 'Verify.',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
    ]);
  });

  it('sanitizes restored commentary without changing other process events', () => {
    const tool = { type: 'event', event: { stream: 'tool', data: { phase: 'end' } } };
    const items = [
      {
        type: 'progress',
        text: 'safe <<<skill-file path=SKILL.md\nsecret\n>>>',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
      tool,
    ];

    expect(sanitizeEditChatCommentaryProcessItems(
      items,
      (text) => text.replace(/<<<skill-file[\s\S]*>>>/, '').trim(),
    )).toEqual([
      {
        type: 'progress',
        text: 'safe',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
      tool,
    ]);
  });

  it('leaves unrelated stream events untouched', () => {
    const event = { type: 'event', event: { stream: 'tool', data: { phase: 'end' } } };

    expect(normalizeEditChatRuntimeEvent(event)).toBe(event);
  });

  it.each(['completed', 'waiting_input'])('maps a %s receipt to the main-chat runtime shape', (terminalStatus) => {
    const normalized = normalizeEditChatRuntimeEvent({
      type: 'event',
      event: {
        stream: 'agent_run_result',
        data: {
          result: 'success',
          terminal_status: terminalStatus,
          duration_ms: 42_000.4,
          provider_ms: 40_000,
          tool_ms: 2_000,
        },
      },
    });

    expect(normalized).toEqual({
      type: 'event',
      event: {
        stream: 'runtime',
        data: {
          result: 'success',
          terminal_status: terminalStatus,
          phase: 'end',
          duration_ms: 42_000,
          provider_ms: 40_000,
          tool_ms: 2_000,
          status: terminalStatus === 'waiting_input' ? 'waiting_input' : 'success',
          aborted: false,
          errored: false,
        },
      },
    });
  });

  it.each([
    ['aborted', 'aborted', true, false],
    ['failure', 'error', false, true],
    ['failure', 'waiting_input', false, true],
  ])('preserves %s terminal state', (result, terminalStatus, aborted, errored) => {
    const normalized = normalizeEditChatRuntimeEvent({
      type: 'event',
      event: {
        stream: 'agent_run_result',
        data: { result, terminal_status: terminalStatus, duration_ms: 9_000 },
      },
    });

    expect(normalized.event.data).toMatchObject({
      phase: 'end',
      duration_ms: 9_000,
      status: 'error',
      aborted,
      errored,
    });
  });

  it('uses measured fallback time when the terminal receipt has no valid duration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_000);
    const normalized = normalizeEditChatRuntimeEvent({
      type: 'event',
      event: {
        stream: 'agent_run_result',
        data: { result: 'success', terminal_status: 'completed', duration_ms: 'invalid' },
      },
    });
    const items = [{ type: 'event', event: normalized.event }];

    ensureEditChatRuntimeProcessItem(items, 3_000);

    expect(items).toHaveLength(2);
    expect(items.at(-1)?.event).toEqual({
      stream: 'runtime',
      data: {
        phase: 'end',
        duration_ms: 12_000,
        status: 'success',
        aborted: false,
        errored: false,
      },
    });
  });

  it('does not append a second runtime item when an authoritative duration exists', () => {
    const items = [{
      type: 'event',
      event: { stream: 'runtime', data: { phase: 'end', duration_ms: 8_000 } },
    }];

    ensureEditChatRuntimeProcessItem(items, 1_000, { errored: true });

    expect(items).toHaveLength(1);
  });
});
