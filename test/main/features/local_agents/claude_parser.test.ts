import { describe, it, expect } from 'vitest';
import { mapClaudeEvent } from '../../../../src/main/features/local_agents/backends/claude';

describe('local_agents/backends/claude › mapClaudeEvent', () => {
  it('captures session id from system/init', () => {
    const r = mapClaudeEvent({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/x' }, undefined);
    expect(r?.captureSession).toBe(true);
    expect(r?.event).toBeUndefined();
  });

  it('emits text-delta for assistant text content (fallback when no stream_event)', () => {
    const r = mapClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 'sess');
    expect(r?.event).toEqual({ type: 'text-delta', text: 'hi' });
  });

  it('skips assistant text when stream_event already streamed it', () => {
    const state = { sawTextStreamEvent: true };
    const r = mapClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 'sess', state);
    expect(r).toBeUndefined();
  });

  it('emits text-delta from stream_event content_block_delta', () => {
    const state = { sawTextStreamEvent: false };
    const r = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tok' } },
    }, undefined, state);
    expect(r?.event).toEqual({ type: 'text-delta', text: 'tok' });
    expect(state.sawTextStreamEvent).toBe(true);
  });

  it('emits thinking from stream_event content_block_delta', () => {
    const r = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } },
    }, undefined);
    expect(r?.event).toEqual({ type: 'thinking', text: 'why' });
  });

  it('emits thinking for assistant thinking block (fallback)', () => {
    const r = mapClaudeEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } }, 'sess');
    expect(r?.event).toEqual({ type: 'thinking', text: 'pondering' });
  });

  it('emits tool-event(use) from stream_event content_block_start', () => {
    const r = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'x.md' } } },
    }, undefined);
    expect(r?.event).toMatchObject({ type: 'tool-event', tool: 'Read', callId: 't1', phase: 'use' });
  });

  it('emits tool-event(use) for assistant tool_use block', () => {
    const r = mapClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'x.md' } }] },
    }, 'sess');
    expect(r?.event).toMatchObject({ type: 'tool-event', tool: 'Read', callId: 't1', phase: 'use' });
    expect((r?.event as any).input).toEqual({ file: 'x.md' });
  });

  it('emits tool-event(result) for user tool_result block', () => {
    const r = mapClaudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    }, 'sess');
    expect(r?.event).toMatchObject({ type: 'tool-event', tool: 'tool_result', callId: 't1', phase: 'result', output: 'ok' });
  });

  it('joins text parts when tool_result content is an array', () => {
    const r = mapClaudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ] }] },
    }, 'sess');
    expect((r?.event as any).output).toBe('line1\nline2');
  });

  it('marks result(success) as terminal completed with body', () => {
    const r = mapClaudeEvent({ type: 'result', subtype: 'success', result: 'final body' }, 'sess');
    expect(r?.terminal).toEqual({ status: 'completed', text: 'final body', error: undefined });
  });

  it('marks result(error_*) as terminal failed', () => {
    const r = mapClaudeEvent({ type: 'result', subtype: 'error_max_turns', error: 'too many turns' }, 'sess');
    expect(r?.terminal).toEqual({ status: 'failed', text: '', error: 'too many turns' });
  });

  it('returns undefined for unknown / null records', () => {
    expect(mapClaudeEvent(null, undefined)).toBeUndefined();
    expect(mapClaudeEvent({ type: 'unknown' }, undefined)).toBeUndefined();
    expect(mapClaudeEvent({ type: 'assistant', message: { content: [] } }, undefined)).toBeUndefined();
  });
});
