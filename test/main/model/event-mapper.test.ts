import { describe, it, expect } from 'vitest';
import {
  mapCoreAgentEvents,
  friendlyRetryReason,
} from '../../../src/main/model/core-agent/event-mapper';

type AgentRunEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; id: string; input: unknown }
  | { type: 'tool_end'; name: string; id: string; result: string; isError?: boolean }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'done'; result: { text: string; meta: { error: null | { message: string } } } };

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(events: AgentRunEvent[]) {
  const out: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = mapCoreAgentEvents(toAsync(events) as any);
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('event-mapper › tool_start forwards input + summarizes progress', () => {
  it('bash tool → progress shows the command, event carries full arguments', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c1', input: { command: 'curl -sSL https://example.com/article' } },
      { type: 'tool_end', name: 'bash', id: 'c1', result: 'HTTP/1.1 200 OK\n\n<html>…</html>' },
      {
        type: 'done',
        result: { text: '', meta: { error: null } },
      },
    ]);

    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(startEvent.event.stream).toBe('tool');
    expect(startEvent.event.data.name).toBe('bash');
    expect(startEvent.event.data.arguments).toEqual({ command: 'curl -sSL https://example.com/article' });

    const startProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('▶ bash'),
    );
    expect(startProgress).toBeDefined();
    expect(startProgress.text).toContain('curl -sSL https://example.com/article');

    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.result_preview).toContain('HTTP/1.1 200 OK');
    expect(endEvent.event.data.isError).toBe(false);

    const endProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('✓ bash'),
    );
    expect(endProgress.text).toContain('HTTP/1.1 200 OK');
  });

  it('read_file tool → progress shows the path', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c2', input: { path: '/tmp/foo.md' } },
      { type: 'tool_end', name: 'read_file', id: 'c2', result: 'hello' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const startProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('▶ read_file'),
    );
    expect(startProgress.text).toContain('/tmp/foo.md');
  });

  it('retry event → friendly Chinese progress, raw reason not leaked', async () => {
    const out = await collect([
      { type: 'retry', attempt: 1, reason: 'terminated' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const retryProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('Retrying'),
    );
    expect(retryProgress).toBeDefined();
    expect(retryProgress.text).toBe('Retrying·Connection dropped');
    // Raw English error sentinel must not survive into user-visible text.
    expect(retryProgress.text).not.toContain('terminated');
    expect(retryProgress.text).not.toContain('retry #');
  });

  it('retry event with attempt>=2 → shows the attempt number', async () => {
    const out = await collect([
      { type: 'retry', attempt: 2, reason: 'fetch failed' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const retryProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.includes('Retry attempt'),
    );
    expect(retryProgress.text).toBe('Retry attempt 2·Connection dropped');
  });

  it('tool_end with isError → progress uses ✗ marker and carries preview', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c3', input: { command: 'false' } },
      { type: 'tool_end', name: 'bash', id: 'c3', result: 'exit 1: command failed', isError: true },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('✗ bash'),
    );
    expect(endProgress).toBeDefined();
    expect(endProgress.text).toContain('exit 1');
  });
});

describe('event-mapper › friendlyRetryReason', () => {
  it('maps undici mid-stream cutoff to "Connection dropped"', () => {
    expect(friendlyRetryReason('terminated')).toBe('Connection dropped');
    expect(friendlyRetryReason('socket hang up')).toBe('Connection dropped');
    expect(friendlyRetryReason('fetch failed')).toBe('Connection dropped');
    expect(friendlyRetryReason('ECONNRESET')).toBe('Connection dropped');
  });

  it('maps timeouts to "Response timed out"', () => {
    expect(friendlyRetryReason('Request timeout')).toBe('Response timed out');
    expect(friendlyRetryReason('ETIMEDOUT')).toBe('Response timed out');
    expect(friendlyRetryReason('UND_ERR_HEADERS_TIMEOUT')).toBe('Response timed out');
  });

  it('maps rate limiting to "Service rate-limited"', () => {
    expect(friendlyRetryReason('429 Too Many Requests')).toBe('Service rate-limited');
    expect(friendlyRetryReason('Rate limit exceeded')).toBe('Service rate-limited');
  });

  it('maps 5xx gateway errors to "Service temporarily unavailable"', () => {
    expect(friendlyRetryReason('502 Bad Gateway')).toBe('Service temporarily unavailable');
    expect(friendlyRetryReason('503 Service Unavailable')).toBe('Service temporarily unavailable');
    expect(friendlyRetryReason('504 Gateway Timeout')).toBe('Service temporarily unavailable');
  });

  it('empty or unknown reason → generic "Network error"', () => {
    expect(friendlyRetryReason('')).toBe('Network error');
    expect(friendlyRetryReason('some brand-new SDK error we have not seen')).toBe('Network error');
  });
});
