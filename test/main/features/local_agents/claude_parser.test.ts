import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, mapClaudeEvent, extractClaudeUsage } from '../../../../src/main/features/local_agents/backends/claude';

describe('local_agents/backends/claude › mapClaudeEvent', () => {
  it('captures session id AND emits status:running on system/init (parity with multica)', () => {
    const r = mapClaudeEvent({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/x' }, undefined);
    expect(r?.captureSession).toBe(true);
    expect(r?.event).toEqual({ type: 'status', status: 'running' });
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

  it('drops stream_event content_block_start tool_use (input arrives empty there; assistant block re-emits with full input)', () => {
    // claude streams tool input via input_json_delta after content_block_start;
    // emitting at start produced a duplicate `■ tool · 开始 · {}` row visually.
    // The assistant block (test below) is the single source of truth for
    // tool-use events.
    const r = mapClaudeEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
    }, undefined);
    expect(r).toBeUndefined();
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

  it('emits log event for {type:"log"} records (verbose mode)', () => {
    const r = mapClaudeEvent({ type: 'log', log: { level: 'warn', message: 'mcp slow' } }, 'sess');
    expect(r?.event).toMatchObject({
      type: 'log',
      level: 'warn',
      message: 'mcp slow',
      source: 'claude',
    });
  });

  it('folds an unknown log level to info', () => {
    const r = mapClaudeEvent({ type: 'log', log: { level: 'banana', message: 'huh' } }, 'sess');
    expect(r?.event).toMatchObject({ type: 'log', level: 'info', message: 'huh' });
  });

  it('drops log records with no message body', () => {
    const r = mapClaudeEvent({ type: 'log', log: { level: 'info' } }, 'sess');
    expect(r).toBeUndefined();
  });

  it('attaches usage to BOTH the terminal record AND the status event so the rail can render tokens', () => {
    const r = mapClaudeEvent({
      type: 'result',
      subtype: 'success',
      result: 'final',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 12,
      },
      message: { model: 'claude-opus-4-7' },
    }, 'sess');
    const expected = {
      input: 1234,
      output: 567,
      cacheRead: 800,
      cacheCreate: 12,
      model: 'claude-opus-4-7',
    };
    expect(r?.terminal?.usage).toEqual(expected);
    // Status event also carries usage so the rail renders
    // "● result · in=1234 out=567 cache=800" — without this the
    // last row is a bare `● result` with no token signal.
    expect((r?.event as any)?.usage).toEqual(expected);
  });

  it('omits usage from the status event when result has no usage block', () => {
    const r = mapClaudeEvent({ type: 'result', subtype: 'success', result: 'final' }, 'sess');
    expect((r?.event as any)?.usage).toBeUndefined();
  });

  it('omits terminal.usage when the result record carries no usage block (older claude)', () => {
    const r = mapClaudeEvent({ type: 'result', subtype: 'success', result: 'final' }, 'sess');
    expect(r?.terminal?.usage).toBeUndefined();
  });

  it('extractClaudeUsage tolerates partial usage records (only some keys present)', () => {
    const u = extractClaudeUsage({ usage: { input_tokens: 10 } });
    expect(u).toEqual({ input: 10 });
  });

  it('extractClaudeUsage returns undefined when nothing recognizable is present', () => {
    expect(extractClaudeUsage({})).toBeUndefined();
    expect(extractClaudeUsage({ usage: { foo: 'bar' } })).toBeUndefined();
  });

  it('extractClaudeUsage pulls cost from total_cost_usd', () => {
    const u = extractClaudeUsage({
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0.0234,
    });
    expect(u).toMatchObject({ input: 1, output: 2, cost: 0.0234 });
  });

  it('extractClaudeUsage still returns a record when only cost is present (no token block)', () => {
    // Defensive: future claude versions might drop the usage block when
    // the user opted out of token reporting; cost alone is still useful.
    const u = extractClaudeUsage({ total_cost_usd: 0.5 });
    expect(u).toEqual({ cost: 0.5 });
  });

  it('returns undefined for control_request (handled out-of-band by backend)', () => {
    // The mapper is a pure translator; the stdin write-back for
    // control_request lives in claude.ts so the mapper stays
    // side-effect-free. The backend short-circuits before calling
    // mapClaudeEvent for this type, so it MUST NOT also produce an
    // event here — that would double-emit or hide a bug if the
    // short-circuit ever regresses.
    const r = mapClaudeEvent({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
    }, 'sess');
    expect(r).toBeUndefined();
  });
});

describe('local_agents/backends/claude › trusted local permissions', () => {
  it('starts Claude Code in non-interactive full-permission mode', () => {
    const args = buildClaudeArgs({});
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--dangerously-skip-permissions');
  });
});
