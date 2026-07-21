import { describe, it, expect } from 'vitest';
import {
  mapCoreAgentEvents,
  friendlyRetryReason,
  extractPersistedOutputPath,
  skillReadMetadataForToolStart,
  agentReadMetadataForToolStart,
} from '../../../src/main/model/core-agent/event-mapper';
import {
  userMarketplaceAgentSkillsDir,
  userMarketplaceAgentsDir,
  userMarketplaceSkillsDir,
  userSystemSkillsDir,
} from '../../../src/main/paths';
import { setCurrentLang } from '../../../src/main/i18n';

type AgentRunEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; name?: string; id: string; inputDelta: string; inputBytes?: number }
  | { type: 'tool_start'; name: string; id: string; input: unknown }
  | { type: 'tool_progress'; name: string; id: string; phase?: string; message: string; data?: Record<string, unknown> }
  | {
      type: 'tool_end';
      name: string;
      id: string;
      result: string;
      persistedOutput?: { path: string; size: number; ref: string };
      isError?: boolean;
      errorCode?: string;
      errorSeverity?: 'recoverable' | 'error';
    }
  | {
      type: 'compaction';
      tokensBefore: number;
      tokensAfter: number;
      summary?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalTokens: number;
      };
    }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'provider_fallback'; reason: 'auth'; providerId: string }
  | {
      type: 'context_status';
      phase:
        | 'history_summary_start'
        | 'history_summary_done'
        | 'active_process_compaction_start'
        | 'active_process_compaction_done';
      message: string;
      data?: Record<string, unknown>;
    }
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

  it('tool_progress → single structured progress event with message', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'generate_image', id: 'c-image', input: { output_path: 'out.png' } },
      { type: 'tool_progress', name: 'generate_image', id: 'c-image', phase: 'poll', message: 'Waiting for image task (30s)', data: { elapsedMs: 30000 } },
      { type: 'tool_end', name: 'generate_image', id: 'c-image', result: 'Image written to out.png' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const progressEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'progress');
    expect(progressEvent.event.stream).toBe('tool');
    expect(progressEvent.event.data.name).toBe('generate_image');
    expect(progressEvent.event.data.message).toBe('Waiting for image task (30s)');
    expect(progressEvent.event.data.progress_phase).toBe('poll');
    expect(progressEvent.event.data.progress_data).toEqual({ elapsedMs: 30000 });
  });

  it('compaction progress carries summary usage for archive diagnostics', async () => {
    const out = await collect([
      {
        type: 'compaction',
        tokensBefore: 20000,
        tokensAfter: 3000,
        summary: 'checkpoint summary',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, totalTokens: 120 },
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const compaction = out.find((e) => e.type === 'progress' && e.event?.stream === 'compaction');
    expect(compaction.text).toBe('compacted 20000→3000 tokens');
    expect(compaction.event.data).toMatchObject({
      tokensBefore: 20000,
      tokensAfter: 3000,
      summary: 'checkpoint summary',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, totalTokens: 120 },
    });
  });

  it('write_file tool input deltas surface a start event before execution starts', async () => {
    const content = 'x'.repeat(5200);
    const out = await collect([
      { type: 'tool_delta', name: 'write_file', id: 'c-write', inputDelta: '{"path":"notes/report.md","content":"', inputBytes: 36 },
      { type: 'tool_delta', name: 'write_file', id: 'c-write', inputDelta: content.slice(0, 600), inputBytes: 636 },
      { type: 'tool_delta', name: 'write_file', id: 'c-write', inputDelta: content.slice(600), inputBytes: 5236 },
      { type: 'tool_start', name: 'write_file', id: 'c-write', input: { path: 'notes/report.md', content } },
      { type: 'tool_end', name: 'write_file', id: 'c-write', result: 'wrote notes/report.md' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const starts = out.filter((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].event.stream).toBe('tool');
    expect(starts[0].event.data.name).toBe('write_file');
    expect(starts[0].event.data.arguments).toEqual({ path: 'notes/report.md' });
    const endIdx = out.findIndex((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    const startIdx = out.findIndex((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
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

  it('read_file of a hidden system SKILL.md carries a friendly label through tool_end', async () => {
    const uid = 'u-system-skill-event';
    const skillPath = `${userSystemSkillsDir(uid)}/agent-creator/SKILL.md`;
    const meta = skillReadMetadataForToolStart(
      'read_file',
      { path: skillPath },
      { userId: uid },
    );
    expect(meta).toEqual({
      skill_id: 'agent-creator',
      skill_name: 'agent-creator',
      skill_system: 'system',
    });

    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c-system-skill', input: { path: skillPath } },
      {
        type: 'tool_end',
        name: 'read_file',
        id: 'c-system-skill',
        result: '<persisted-output ref="read_file.deadbeef" tool="read_file" size="41420">preview</persisted-output>',
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { userId: uid });
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.skill_name).toBe('agent-creator');
    expect(endEvent.event.data.skill_system).toBe('system');
    expect(endEvent.event.data.skill_file).toBe('SKILL.md');
  });

  it('read_file of a platform agent-private SKILL.md carries its resource label', () => {
    const uid = 'u-private-skill-event';
    const skillPath = `${userMarketplaceAgentSkillsDir(uid, '79df9cc89f5f')}/stage-plan/SKILL.md`;
    expect(skillReadMetadataForToolStart(
      'read_file',
      { path: skillPath },
      { userId: uid },
    )).toEqual({
      skill_id: 'stage-plan',
      skill_name: 'stage-plan',
      skill_system: 'B',
    });
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
    expect(retryProgress.event).toEqual({
      stream: 'runtime',
      data: { phase: 'retrying', attempt: 1 },
    });
    // Raw English error sentinel must not survive into user-visible text.
    expect(retryProgress.text).not.toContain('terminated');
    expect(retryProgress.text).not.toContain('retry #');
  });

  it('context_status event → progress row plus structured context event', async () => {
    const out = await collect([
      {
        type: 'context_status',
        phase: 'history_summary_start',
        message: '正在整理历史上下文...',
        data: { turns: 13 },
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const row = out.find((e) => e.type === 'progress' && e.event?.stream === 'context');
    expect(row.text).toBe('正在整理历史上下文...');
    expect(row.event.data.phase).toBe('history_summary_start');
    expect(row.event.data.turns).toBe(13);
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

  it('retry event maps missing finish_reason to a connection drop', async () => {
    const out = await collect([
      { type: 'retry', attempt: 1, reason: 'Stream ended without finish_reason' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const retryProgress = out.find(
      (e) => e.type === 'progress' && typeof e.text === 'string' && e.text.startsWith('Retrying'),
    );
    expect(retryProgress.text).toBe('Retrying·Connection dropped');
    expect(retryProgress.text).not.toContain('finish_reason');
  });

  it('provider auth fallback is visible and does not look like a network retry', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        { type: 'provider_fallback', reason: 'auth', providerId: 'openai-codex' },
        { type: 'done', result: { text: '', meta: { error: null } } },
      ]);
      const progress = out.find((e) => e.type === 'progress');
      expect(progress.text).toContain('OpenAI Codex 模型凭证已失效');
      expect(progress.text).toContain('备用模型继续执行');
      expect(progress.text).not.toContain('网络异常');
      expect(progress.event).toEqual({
        stream: 'provider',
        data: { phase: 'fallback', reason: 'auth', provider_id: 'openai-codex' },
      });
    } finally {
      setCurrentLang('en');
    }
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

  it('recoverable compacted-history guard metadata survives mapping for the renderer', async () => {
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c4', input: { command: 'old compacted preview' } },
      {
        type: 'tool_end',
        name: 'bash',
        id: 'c4',
        result: 'Recoverable historical-placeholder input detected for bash. The bash tool is still available; this is not a tool limitation.',
        isError: true,
        errorCode: 'E_COMPACTED_HISTORY_PLACEHOLDER',
        errorSeverity: 'recoverable',
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.isError).toBe(true);
    expect(endEvent.event.data.errorCode).toBe('E_COMPACTED_HISTORY_PLACEHOLDER');
    expect(endEvent.event.data.errorSeverity).toBe('recoverable');
    expect(endEvent.event.data.result_preview).toContain('tool is still available');
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

  it('tool_end uses model-hidden persisted-output metadata for the UI path', async () => {
    const marker = '<persisted-output ref="bash.0123456789abcdef" tool="bash" size="71234">bounded preview</persisted-output>';
    const out = await collect([
      { type: 'tool_start', name: 'bash', id: 'c2-new', input: { command: 'curl big' } },
      {
        type: 'tool_end',
        name: 'bash',
        id: 'c2-new',
        result: marker,
        persistedOutput: {
          path: '/Users/x/.orkas/data/u1/local/tool-results/u1-conv-cid/bash.0123456789abcdef.txt',
          size: 71234,
          ref: 'bash.0123456789abcdef',
        },
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.result_path)
      .toBe('/Users/x/.orkas/data/u1/local/tool-results/u1-conv-cid/bash.0123456789abcdef.txt');
    expect(endEvent.event.data.result_size).toBe(71234);
    expect(endEvent.event.data.output).toBeUndefined();
  });

  it('legacy path-bearing <persisted-output> markers remain expandable', async () => {
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

  it('localizes known runner fallback text', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        { type: 'done', result: { text: '(Tool loop limit reached)', meta: { error: null } } },
      ]);
      expect(out).toEqual([{ type: 'final', text: '（工具循环轮次已达上限）' }]);
    } finally {
      setCurrentLang('en');
    }
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
