import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureEditChatRuntimeProcessItem,
  normalizeEditChatRuntimeEvent,
} from '../../../src/main/features/edit_chat_runtime';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edit chat runtime normalization', () => {
  it('leaves unrelated stream events untouched', () => {
    const event = { type: 'event', event: { stream: 'tool', data: { phase: 'end' } } };

    expect(normalizeEditChatRuntimeEvent(event)).toBe(event);
  });

  it('maps a successful terminal receipt to the main-chat runtime shape', () => {
    const normalized = normalizeEditChatRuntimeEvent({
      type: 'event',
      event: {
        stream: 'agent_run_result',
        data: {
          result: 'success',
          terminal_status: 'completed',
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
          terminal_status: 'completed',
          phase: 'end',
          duration_ms: 42_000,
          provider_ms: 40_000,
          tool_ms: 2_000,
          status: 'success',
          aborted: false,
          errored: false,
        },
      },
    });
  });

  it.each([
    ['aborted', 'aborted', true, false],
    ['failure', 'error', false, true],
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
