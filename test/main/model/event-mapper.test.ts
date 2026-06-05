import { describe, it, expect } from 'vitest';
import {
  mapCoreAgentEvents,
  friendlyRetryReason,
  extractPersistedOutputPath,
  skillReadMetadataForToolStart,
  agentReadMetadataForToolStart,
} from '../../../src/main/model/core-agent/event-mapper';
import { userMarketplaceAgentsDir, userMarketplaceSkillsDir } from '../../../src/main/paths';

type AgentRunEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; id: string; input: unknown }
  | { type: 'tool_end'; name: string; id: string; result: string; isError?: boolean }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'done'; result: { text: string; meta: { error: null | { message: string } } } };

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(events: AgentRunEvent[], opts?: Parameters<typeof mapCoreAgentEvents>[1]) {
  const out: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = mapCoreAgentEvents(toAsync(events) as any, opts);
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('event-mapper › tool_start / tool_end emit a single structured event', () => {
  // The mapper used to yield both a `progress` text (▶ name · arg / ✓ name ·
  // preview) AND a structured `event` with the same info; the renderer
  // formatted both, producing duplicate rows in the process pane (one ■ from
  // the event branch, one ▶ or ✓ from the progress branch). The contract is
  // now: `tool_start` / `tool_end` yield ONE `event` only — formatting is the
  // renderer's job (`_formatEventLine`'s `tool` branch).

  it('bash tool → single event carries the full input + result preview', async () => {
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

    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.result_preview).toContain('HTTP/1.1 200 OK');
    expect(endEvent.event.data.isError).toBe(false);

    // No parallel `progress` rows for tool_start / tool_end. (Other yields
    // like `retry` still produce progress text — they're tested below.)
    const toolProgress = out.filter(
      (e) => e.type === 'progress' && typeof e.text === 'string'
        && (e.text.startsWith('▶ bash') || e.text.startsWith('✓ bash') || e.text.startsWith('✗ bash')),
    );
    expect(toolProgress).toEqual([]);
  });

  it('read_file tool → start event carries the path on `arguments`', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c2', input: { path: '/tmp/foo.md' } },
      { type: 'tool_end', name: 'read_file', id: 'c2', result: 'hello' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(startEvent.event.data.name).toBe('read_file');
    expect(startEvent.event.data.arguments).toEqual({ path: '/tmp/foo.md' });
  });

  it('read_file of marketplace SKILL.md carries the display name without another skill scan', async () => {
    const uid = 'u-skill-event';
    const skillId = '16e1bfcb3426';
    const skillPath = `${userMarketplaceSkillsDir(uid)}/${skillId}/SKILL.md`;
    const skillDisplayNameById = new Map([[skillId, 'agent-creator']]);
    const meta = skillReadMetadataForToolStart(
      'read_file',
      { path: skillPath },
      { userId: uid, skillDisplayNameById },
    );
    expect(meta).toEqual({
      skill_id: skillId,
      skill_name: 'agent-creator',
      skill_system: 'A.platform',
    });

    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c-skill', input: { path: skillPath } },
      { type: 'tool_end', name: 'read_file', id: 'c-skill', result: '<file>body</file>' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { userId: uid, skillDisplayNameById });
    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(startEvent.event.data.skill_name).toBe('agent-creator');
    expect(startEvent.event.data.skill_id).toBe(skillId);
    expect(endEvent.event.data.skill_name).toBe('agent-creator');
    expect(endEvent.event.data.skill_file).toBe('SKILL.md');
  });

  it('read_file of marketplace agent.json carries the agent display name', async () => {
    const uid = 'u-agent-event';
    const agentId = '4430ca181349';
    const agentPath = `${userMarketplaceAgentsDir(uid)}/${agentId}/agent.json`;
    const agentDisplayNameById = new Map([[agentId, '学习路径设计师']]);
    const meta = agentReadMetadataForToolStart(
      'read_file',
      { path: agentPath },
      { userId: uid, agentDisplayNameById },
    );
    expect(meta).toEqual({
      agent_id: agentId,
      agent_name: '学习路径设计师',
      agent_system: 'marketplace',
    });

    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c-agent', input: { path: agentPath } },
      { type: 'tool_end', name: 'read_file', id: 'c-agent', result: '{"name":"学习路径设计师"}' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { userId: uid, agentDisplayNameById });
    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(startEvent.event.data.agent_name).toBe('学习路径设计师');
    expect(startEvent.event.data.agent_id).toBe(agentId);
    expect(endEvent.event.data.agent_name).toBe('学习路径设计师');
    expect(endEvent.event.data.agent_file).toBe('agent.json');
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

  it('tool_end with isError → end event flags isError + carries preview', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c3', input: { command: 'false' } },
      { type: 'tool_end', name: 'bash', id: 'c3', result: 'exit 1: command failed', isError: true },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.isError).toBe(true);
    expect(endEvent.event.data.result_preview).toContain('exit 1');
  });

  it('tool_end with small raw result → end event carries `output` (in-memory expand path)', async () => {
    const body = 'line A\nline B\nline C';
    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c1', input: { path: 'x.md' } },
      { type: 'tool_end', name: 'read_file', id: 'c1', result: body },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.output).toBe(body);
    expect(endEvent.event.data.result_path).toBeUndefined();
  });

  it('tool_end with spilled <persisted-output> result → end event carries `result_path`', async () => {
    // tool-result-cap.ts rewrites oversized tool results into this
    // marker shape; the model + the event mapper both consume it. The
    // renderer's click-to-expand uses `result_path` to IPC-read the
    // full body off disk.
    const marker =
      `<persisted-output tool="bash" size="71234" path="/Users/x/.orkas/data/u1/local/tool-results/u1-conv-cid/bash.abc123.txt">\n` +
      `first 2000 chars …\n\n... [69234 chars omitted] ...\n\nlast 500 chars\n` +
      `[Full content saved to: /Users/x/.orkas/data/u1/local/tool-results/u1-conv-cid/bash.abc123.txt. Use read_file(path) to retrieve verbatim.]\n` +
      `</persisted-output>`;
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c2', input: { command: 'curl big' } },
      { type: 'tool_end', name: 'bash', id: 'c2', result: marker },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.result_path)
      .toBe('/Users/x/.orkas/data/u1/local/tool-results/u1-conv-cid/bash.abc123.txt');
    expect(endEvent.event.data.result_size).toBe(71234);
    // When spilled, we do NOT also stuff `output` — the renderer's
    // click handler exclusively goes through the IPC path. Avoids
    // duplicating the (potentially large) marker text on the wire.
    expect(endEvent.event.data.output).toBeUndefined();
  });
});

describe('event-mapper › extractPersistedOutputPath', () => {
  it('pulls path + size from a tool-result-cap marker', () => {
    const r = extractPersistedOutputPath(
      '<persisted-output tool="bash" size="123" path="/a/b/c.txt">\npreview\n</persisted-output>'
    );
    expect(r).toEqual({ path: '/a/b/c.txt', size: 123 });
  });

  it('returns null when the result is not a marker (small tool output)', () => {
    expect(extractPersistedOutputPath('plain bash output')).toBeNull();
    expect(extractPersistedOutputPath('')).toBeNull();
    expect(extractPersistedOutputPath(null as unknown as string)).toBeNull();
  });

  it('returns null for malformed markers (defensive parse)', () => {
    // Missing size attr — we require BOTH to parse, otherwise the
    // renderer's expand IPC would have no `size` to report.
    expect(extractPersistedOutputPath('<persisted-output path="/a/b.txt">x</persisted-output>')).toBeNull();
  });
});

describe('event-mapper › friendlyRetryReason', () => {
  it('maps undici mid-stream cutoff to "Connection dropped"', () => {
    expect(friendlyRetryReason('terminated')).toBe('Connection dropped');
    expect(friendlyRetryReason('socket hang up')).toBe('Connection dropped');
    expect(friendlyRetryReason('fetch failed')).toBe('Connection dropped');
    expect(friendlyRetryReason('WebSocket error')).toBe('Connection dropped');
    expect(friendlyRetryReason('Connection closed')).toBe('Connection dropped');
    expect(friendlyRetryReason('stream disconnected before completion')).toBe('Connection dropped');
    expect(friendlyRetryReason('ERR_STREAM_PREMATURE_CLOSE')).toBe('Connection dropped');
    expect(friendlyRetryReason('ECONNRESET')).toBe('Connection dropped');
  });

  it('maps timeouts to "Response timed out"', () => {
    expect(friendlyRetryReason('Request timeout')).toBe('Response timed out');
    expect(friendlyRetryReason('ETIMEDOUT')).toBe('Response timed out');
    expect(friendlyRetryReason('UND_ERR_HEADERS_TIMEOUT')).toBe('Response timed out');
    expect(friendlyRetryReason('Codex SSE response headers timed out after 10000ms')).toBe('Response timed out');
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
