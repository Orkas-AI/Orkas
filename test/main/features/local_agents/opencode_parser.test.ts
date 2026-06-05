import { describe, it, expect } from 'vitest';
import {
  buildOpencodeArgs,
  mapOpencodeEvent,
  extractOpencodeUsage,
} from '../../../../src/main/features/local_agents/backends/opencode';

describe('local_agents/backends/opencode › mapOpencodeEvent', () => {
  it('captures sessionID at the top level', () => {
    const r = mapOpencodeEvent({ type: 'step_start', sessionID: 's1' });
    expect(r?.captureSessionId).toBe('s1');
    expect((r?.event as any)?.status).toBe('running');
  });

  it('captures sessionID nested under .part', () => {
    const r = mapOpencodeEvent({ type: 'text', part: { sessionID: 's2', text: 'hi' } });
    expect(r?.captureSessionId).toBe('s2');
    expect(r?.event).toEqual({ type: 'text-delta', text: 'hi' });
  });

  it('maps tool_use in-progress to phase:use with input', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: { tool: 'read_file', callID: 'c1', state: { status: 'pending', input: { path: 'x.md' } } },
    });
    expect(r?.event).toMatchObject({ type: 'tool-event', tool: 'read_file', phase: 'use', callId: 'c1' });
    expect((r?.event as any).input).toEqual({ path: 'x.md' });
  });

  it('maps tool_use completed to phase:result with output', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: { tool: 'read_file', callID: 'c1', state: { status: 'completed', output: 'file body' } },
    });
    expect(r?.event).toMatchObject({ type: 'tool-event', phase: 'result', output: 'file body' });
  });

  it('stringifies non-string tool outputs', () => {
    const r = mapOpencodeEvent({
      type: 'tool_use',
      part: { tool: 'kb_search', callID: 'c1', state: { status: 'completed', output: { hits: 4 } } },
    });
    expect((r?.event as any).output).toBe('{"hits":4}');
  });

  it('error type produces a terminal failed status with message', () => {
    const r = mapOpencodeEvent({ type: 'error', error: { data: { message: 'auth fail' } } });
    expect(r?.terminal).toEqual({ status: 'failed', error: 'auth fail' });
  });

  it('step_finish with extractable usage produces status:usage (not log)', () => {
    const r = mapOpencodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 100, output: 50, cache: 25 }, model: 'gpt-5' },
    });
    expect(r?.event).toEqual({
      type: 'status',
      status: 'usage',
      usage: { input: 100, output: 50, cacheRead: 25, model: 'gpt-5' },
    });
  });

  it('step_finish without usage falls back to a debug log so the row is still visible', () => {
    const r = mapOpencodeEvent({ type: 'step_finish', part: { foo: 'bar' } });
    expect((r?.event as any).type).toBe('log');
    expect((r?.event as any).level).toBe('debug');
    expect((r?.event as any).message).toContain('step_finish');
  });

  it('unknown event type becomes an info log so wire-format drift is visible', () => {
    const r = mapOpencodeEvent({ type: 'mystery_new_event', payload: 1 });
    expect((r?.event as any).type).toBe('log');
    expect((r?.event as any).level).toBe('info');
    expect((r?.event as any).message).toContain('mystery_new_event');
  });
});

describe('local_agents/backends/opencode › extractOpencodeUsage', () => {
  it('reads from part.tokens nested block (canonical shape)', () => {
    const u = extractOpencodeUsage({ tokens: { input: 10, output: 20, cache: 5 } });
    expect(u).toEqual({ input: 10, output: 20, cacheRead: 5 });
  });

  it('also accepts a flat shape with snake_case keys', () => {
    const u = extractOpencodeUsage({ input_tokens: 10, output_tokens: 20 });
    expect(u).toEqual({ input: 10, output: 20 });
  });

  it('attaches model when present', () => {
    const u = extractOpencodeUsage({ tokens: { input: 1, output: 1 }, model: 'gpt-5' });
    expect(u?.model).toBe('gpt-5');
  });

  it('returns undefined when no numeric counter is present', () => {
    expect(extractOpencodeUsage({})).toBeUndefined();
    expect(extractOpencodeUsage({ tokens: {} })).toBeUndefined();
    expect(extractOpencodeUsage(null)).toBeUndefined();
  });
});

describe('local_agents/backends/opencode › trusted local permissions', () => {
  it('runs OpenCode with non-interactive permission auto-approval', () => {
    expect(buildOpencodeArgs({ prompt: 'hi' })).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      'hi',
    ]);
  });
});
