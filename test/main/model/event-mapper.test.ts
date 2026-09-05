import { describe, it, expect } from 'vitest';
import {
  mapCoreAgentEvents,
  friendlyRetryReason,
  extractPersistedOutputPath,
  skillReadMetadataForToolStart,
  agentReadMetadataForToolStart,
  sanitizePublicReasoningSummary,
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
  | { type: 'thinking'; phase: 'start' | 'progress' | 'end'; chars: number; text?: string }
  | { type: 'tool_delta'; name?: string; id: string; inputDelta: string; inputBytes?: number }
  | { type: 'tool_start'; name: string; id: string; input: unknown }
  | { type: 'tool_progress'; name: string; id: string; phase?: string; message: string; data?: Record<string, unknown> }
  | {
      type: 'tool_end';
      name: string;
      id: string;
      result: string;
      displayName?: string;
      persistedOutput?: { path: string; size: number; ref: string };
      isError?: boolean;
      errorCode?: string;
      errorSeverity?: 'recoverable' | 'error';
      durationMs?: number;
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
  | {
      type: 'provider_fallback';
      reason: 'auth' | 'server_model_fallback';
      providerId: string;
      candidateIndex?: number;
      candidateCount?: number;
      fromModel?: string;
      toModel?: string;
      serverFallbackReason?: 'transport_error';
    }
  | {
      type: 'context_status';
      phase:
        | 'history_summary_start'
        | 'history_summary_done'
        | 'history_summary_failed'
        | 'active_process_compaction_start'
        | 'active_process_compaction_done'
        | 'active_process_compaction_failed';
      data?: Record<string, unknown>;
    }
  | {
      type: 'provider_call';
      durationMs: number;
      outcome: 'completed' | 'failed';
      model: string;
    }
  | {
      type: 'done';
      result: {
        text: string;
        meta: {
          provider?: string;
          error: null | {
            kind?: 'auth' | 'rate_limit' | 'context_overflow' | 'timeout' | 'provider_error';
            message: string;
            code?: string;
            statusCode?: number;
          };
          convergenceSignals?: string[];
        };
      };
    };

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(
  events: AgentRunEvent[],
  opts: Partial<Parameters<typeof mapCoreAgentEvents>[1]> = {},
) {
  const out: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = mapCoreAgentEvents(toAsync(events) as any, {
    failureTrackingScope: opts.failureTrackingScope ?? {},
    ...opts,
  });
  for await (const ev of gen) out.push(ev);
  return out;
}

function reconstructReasoningSummaries(events: any[]): string[] {
  let summary = '';
  const snapshots: string[] = [];
  for (const event of events) {
    const data = event?.event?.data;
    if (event?.type !== 'event' || event?.event?.stream !== 'reasoning' || !data) continue;
    if (typeof data.summary === 'string') {
      summary = data.summary;
    } else if (Number.isInteger(data.summary_from) && typeof data.summary_delta === 'string') {
      summary = summary.slice(0, data.summary_from) + data.summary_delta;
    } else {
      continue;
    }
    snapshots.push(summary);
  }
  return snapshots;
}

it('keeps provider-call diagnostics internal', async () => {
  const out = await collect([
    { type: 'provider_call', durationMs: 70_000, outcome: 'completed', model: 'private-model-id' },
    { type: 'text_delta', text: 'visible' },
    { type: 'done', result: { text: 'visible', meta: { error: null } } },
  ]);

  expect(out).toEqual([
    { type: 'delta', text: 'visible' },
    { type: 'final', text: 'visible' },
  ]);
});

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

  it('marks only a list of the run root as the current task workspace', async () => {
    const workingDir = '/tmp/workspace/chat-2026-08-08-1';
    const out = await collect([
      { type: 'tool_start', name: 'list_files', id: 'c-root', input: { path: workingDir } },
      {
        type: 'tool_start', name: 'list_files', id: 'c-child',
        input: { path: `${workingDir}/evidence` },
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { workingDir });

    const starts = out.filter((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(starts[0].event.data).toMatchObject({
      name: 'list_files',
      arguments: { path: workingDir },
      resource_scope: 'current_workspace',
    });
    expect(starts[1].event.data).toMatchObject({
      name: 'list_files',
      arguments: { path: `${workingDir}/evidence` },
    });
    expect(starts[1].event.data.resource_scope).toBeUndefined();
  });

  it('tool_end forwards a provider display name for process rendering', async () => {
    const out = await collect([
      {
        type: 'tool_end',
        name: 'web_search',
        id: 'c-search',
        result: 'Search results for: "query"',
        displayName: 'External Search',
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.name).toBe('web_search');
    expect(endEvent.event.data.display_name).toBe('External Search');
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

  it('marks a preserved max_tokens draft as incomplete in the selected UI language', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([{
        type: 'done',
        result: {
          text: '已生成的报告内容',
          meta: {
            error: null,
            convergenceSignals: ['output_limit_continuation', 'output_limit_unrecovered'],
          },
        },
      }]);

      expect(out).toEqual([{
        type: 'final',
        text: '已生成的报告内容\n\n内容达到模型单次输出上限，以上结果可能不完整。你可以继续生成剩余内容。',
      }]);
    } finally {
      setCurrentLang('en');
    }
  });

  it('surfaces a named tool call immediately and enriches it at execution without another start', async () => {
    const content = 'x'.repeat(5200);
    const out = await collect([
      { type: 'tool_delta', name: 'write_file', id: 'c-write', inputDelta: '', inputBytes: 0 },
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
    expect(starts[0].event.data.arguments).toBeUndefined();
    const executionUpdate = out.find((e) => (
      e.type === 'event'
      && e.event?.stream === 'tool'
      && e.event?.data?.phase === 'progress'
      && e.event?.data?.id === 'c-write'
    ));
    expect(executionUpdate?.event.data.arguments).toEqual({ path: 'notes/report.md', content });
    const endIdx = out.findIndex((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    const startIdx = out.findIndex((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it('uses the same early lifecycle contract for non-file tools', async () => {
    const out = await collect([
      { type: 'tool_delta', name: 'web_fetch', id: 'c-web', inputDelta: '', inputBytes: 0 },
      { type: 'tool_start', name: 'web_fetch', id: 'c-web', input: { url: 'https://example.com/docs' } },
      { type: 'tool_end', name: 'web_fetch', id: 'c-web', result: 'ok' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const lifecycle = out
      .filter((e) => e.type === 'event' && e.event?.stream === 'tool')
      .map((e) => ({ phase: e.event.data.phase, id: e.event.data.id }));
    expect(lifecycle).toEqual([
      { phase: 'start', id: 'c-web' },
      { phase: 'progress', id: 'c-web' },
      { phase: 'end', id: 'c-web' },
    ]);
  });

  it('does not surface an uncorrelatable early call when its id is absent', async () => {
    const out = await collect([
      { type: 'tool_delta', name: 'write_file', id: '', inputDelta: '', inputBytes: 0 },
      { type: 'tool_start', name: 'write_file', id: 'c-late-id', input: { path: 'report.md', content: 'body' } },
      { type: 'tool_end', name: 'write_file', id: 'c-late-id', result: 'written' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const starts = out.filter((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].event.data.id).toBe('c-late-id');
    expect(starts[0].event.data.arguments).toEqual({ path: 'report.md', content: 'body' });
  });

  it('persists tool end-to-end duration from the first streamed call event', async () => {
    const ticks = [1_000, 1_640];
    const out = await collect([
      { type: 'tool_delta', name: 'write_file', id: 'c-e2e', inputDelta: '', inputBytes: 0 },
      { type: 'tool_delta', name: 'write_file', id: 'c-e2e', inputDelta: '{"path":"report.html"', inputBytes: 21 },
      { type: 'tool_start', name: 'write_file', id: 'c-e2e', input: { path: 'report.html', content: 'body' } },
      { type: 'tool_end', name: 'write_file', id: 'c-e2e', result: 'written', durationMs: 9 },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { nowMs: () => ticks.shift() ?? 1_640 });

    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.duration_ms).toBe(9);
    expect(endEvent.event.data.end_to_end_duration_ms).toBe(640);
  });

  it('falls back to the execution boundary when the provider emits no tool deltas', async () => {
    const ticks = [5_000, 5_025];
    const out = await collect([
      { type: 'tool_start', name: 'read_file', id: 'c-exec-only', input: { path: 'notes.md' } },
      { type: 'tool_end', name: 'read_file', id: 'c-exec-only', result: 'notes', durationMs: 31 },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { nowMs: () => ticks.shift() ?? 5_025 });

    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');
    expect(endEvent.event.data.duration_ms).toBe(31);
    expect(endEvent.event.data.end_to_end_duration_ms).toBe(31);
  });

  it('does not wait for a fragmented path before surfacing a write_file start event', async () => {
    const content = 'body';
    const out = await collect([
      { type: 'tool_delta', name: 'write_file', id: 'c-fragmented-path', inputDelta: '{"path":"sn', inputBytes: 11 },
      { type: 'tool_delta', name: 'write_file', id: 'c-fragmented-path', inputDelta: 'ake-game.html', inputBytes: 24 },
      { type: 'tool_delta', name: 'write_file', id: 'c-fragmented-path', inputDelta: '","content":"body"}', inputBytes: 42 },
      { type: 'tool_start', name: 'write_file', id: 'c-fragmented-path', input: { path: 'snake-game.html', content } },
      { type: 'tool_end', name: 'write_file', id: 'c-fragmented-path', result: 'wrote snake-game.html' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);

    const starts = out.filter((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].event.data.arguments).toBeUndefined();
    const executionUpdate = out.find((e) => (
      e.type === 'event' && e.event?.data?.phase === 'progress'
    ));
    expect(executionUpdate?.event.data.arguments).toEqual({ path: 'snake-game.html', content });
  });

  it('read_files with one paths item carries the Skill display name without another scan', async () => {
    const uid = 'u-skill-event';
    const skillId = '16e1bfcb3426';
    const skillPath = `${userMarketplaceSkillsDir(uid)}/${skillId}/SKILL.md`;
    const skillDisplayNameById = new Map([[skillId, 'agent-creator']]);
    const meta = skillReadMetadataForToolStart(
      'read_files',
      { paths: [{ path: skillPath }] },
      { userId: uid, skillDisplayNameById },
    );
    expect(meta).toEqual({
      skill_id: skillId,
      skill_name: 'agent-creator',
      skill_system: 'A.platform',
      skill_file: 'SKILL.md',
    });

    const out = await collect([
      { type: 'tool_start', name: 'read_files', id: 'c-skill', input: { paths: [{ path: skillPath }] } },
      { type: 'tool_end', name: 'read_files', id: 'c-skill', result: '<file>body</file>' },
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
      skill_file: 'SKILL.md',
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
      skill_file: 'SKILL.md',
    });
  });

  it('labels run-scoped Skill entry and reference reads without exposing the read ref', async () => {
    const skillMetadataByReadRef = new Map([
      ['5aa5286f3aee', {
        id: 'release-decision',
        name: 'Release Decision',
        source: 'custom',
      }],
    ]);

    expect(skillReadMetadataForToolStart(
      'read_file',
      { path: '@skill/5aa5286f3aee' },
      { userId: 'u-runtime-skill', skillMetadataByReadRef },
    )).toEqual({
      skill_id: 'release-decision',
      skill_name: 'Release Decision',
      skill_system: 'A.custom',
      skill_file: 'SKILL.md',
    });

    const out = await collect([
      {
        type: 'tool_start',
        name: 'read_file',
        id: 'c-skill-reference',
        input: { path: '@skill/5aa5286f3aee/references/release-decision.md' },
      },
      {
        type: 'tool_end',
        name: 'read_file',
        id: 'c-skill-reference',
        result: '<file>reference body</file>',
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { userId: 'u-runtime-skill', skillMetadataByReadRef });
    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');

    expect(startEvent.event.data).toMatchObject({
      skill_id: 'release-decision',
      skill_name: 'Release Decision',
      skill_file: 'references/release-decision.md',
    });
    expect(endEvent.event.data).toMatchObject({
      skill_id: 'release-decision',
      skill_name: 'Release Decision',
      skill_file: 'references/release-decision.md',
    });
    expect(JSON.stringify([startEvent, endEvent])).not.toContain('skill_name":"5aa5286f3aee');
  });

  it.each([
    ['system', 'system'],
    ['builtin', 'A.platform'],
    ['platform', 'A.platform'],
    ['external', 'B'],
    ['global', 'B'],
    ['unknown', 'B'],
  ] as const)('maps run-scoped %s Skill reads to the %s event system', (source, skillSystem) => {
    const skillMetadataByReadRef = new Map([
      ['runtime-ref', { id: `${source}-skill`, name: `${source} Skill`, source }],
    ]);

    expect(skillReadMetadataForToolStart(
      'read_file',
      { path: '@skill/runtime-ref/references/guide.md' },
      { skillMetadataByReadRef },
    )).toEqual({
      skill_id: `${source}-skill`,
      skill_name: `${source} Skill`,
      skill_system: skillSystem,
      skill_file: 'references/guide.md',
    });
  });

  it.each([
    ['unknown ref', '@skill/not-listed/references/guide.md'],
    ['parent traversal', '@skill/runtime-ref/../secret.md'],
    ['dot segment', '@skill/runtime-ref/./guide.md'],
    ['empty segment', '@skill/runtime-ref/references//guide.md'],
    ['backslash separator', '@skill/runtime-ref\\references\\guide.md'],
    ['lookalike prefix', 'notes/@skill/runtime-ref'],
  ])('does not attribute a %s as a trusted run-scoped Skill read', (_scenario, requestedPath) => {
    const skillMetadataByReadRef = new Map([
      ['runtime-ref', { id: 'trusted-skill', name: 'Trusted Skill', source: 'custom' }],
    ]);

    expect(skillReadMetadataForToolStart(
      'read_file',
      { path: requestedPath },
      { skillMetadataByReadRef },
    )).toBeNull();
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

  it.each(['dispatch_to', 'hand_off_to'])(
    '%s persists the delegated Agent identity after an early tool announcement', async (name) => {
      const agentId = 'd76b91de8c7b';
      const out = await collect([
        { type: 'tool_delta', id: 'delegate-1', name, inputDelta: '' } as AgentRunEvent,
        { type: 'tool_start', id: 'delegate-1', name, input: { to: agentId, message: 'Build a game' } },
        { type: 'tool_progress', id: 'delegate-1', name, message: 'Agent running' },
        { type: 'tool_end', id: 'delegate-1', name, result: 'done' },
      ], { agentDisplayNameById: new Map([[agentId, 'ProductDemoBuilder']]) });
      const events = out.filter((event) => event.type === 'event').map((event) => event.event.data);
      expect(events.map((event) => event.phase)).toEqual(['start', 'progress', 'progress', 'end']);
      for (const event of events.slice(1)) {
        expect(event).toMatchObject({ agent_id: agentId, agent_name: 'ProductDemoBuilder' });
        expect(event).not.toHaveProperty('agent_file');
      }
    },
  );

  it.each([
    ['list_connector_tools', { connector_id: 'connector-instance-91f0' }],
    ['call_connector_tool', {
      connector_id: 'connector-instance-91f0',
      tool_name: 'search',
      args: { query: 'release plan' },
    }],
  ])('%s carries the visible Connector name through tool_end', async (name, input) => {
    const connectorDisplayNameById = new Map([
      ['connector-instance-91f0', 'Notion Workspace'],
    ]);
    const out = await collect([
      { type: 'tool_start', name, id: 'c-connector', input },
      { type: 'tool_end', name, id: 'c-connector', result: 'ok' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { connectorDisplayNameById });
    const startEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'start');
    const endEvent = out.find((e) => e.type === 'event' && e.event?.data?.phase === 'end');

    expect(startEvent.event.data).toMatchObject({
      connector_id: 'connector-instance-91f0',
      connector_name: 'Notion Workspace',
    });
    expect(endEvent.event.data).toMatchObject({
      connector_id: 'connector-instance-91f0',
      connector_name: 'Notion Workspace',
    });
  });

  it('does not invent Connector metadata outside the visible snapshot', async () => {
    const out = await collect([
      {
        type: 'tool_start',
        name: 'call_connector_tool',
        id: 'c-hidden-connector',
        input: { connector_id: 'hidden-instance', tool_name: 'search', args: {} },
      },
      { type: 'tool_end', name: 'call_connector_tool', id: 'c-hidden-connector', result: 'denied' },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ], { connectorDisplayNameById: new Map() });
    const toolEvents = out.filter((e) => e.type === 'event' && e.event?.stream === 'tool');

    expect(toolEvents.every((e) => e.event.data.connector_name === undefined)).toBe(true);
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

  it('context_status event → semantic context event without language-specific text', async () => {
    const out = await collect([
      {
        type: 'context_status',
        phase: 'history_summary_start',
        data: { turns: 13 },
      },
      { type: 'done', result: { text: '', meta: { error: null } } },
    ]);
    const row = out.find((e) => e.type === 'event' && e.event?.stream === 'context');
    expect(row).toBeDefined();
    expect(row.event.data.phase).toBe('history_summary_start');
    expect(row.event.data.turns).toBe(13);
    expect(JSON.stringify(row)).not.toContain('上下文');
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

  it('user-configured provider auth fallback stays visible in production and does not look like a network retry', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'provider_fallback',
          reason: 'auth',
          providerId: 'openai-codex',
          candidateIndex: 1,
          candidateCount: 3,
        },
        { type: 'done', result: { text: '', meta: { error: null } } },
      ], { isDev: false });
      const progress = out.find((e) => e.type === 'progress');
      expect(progress.text).toContain('OpenAI Codex 模型凭证已失效');
      expect(progress.text).toContain('备用模型继续执行');
      expect(progress.text).not.toContain('网络异常');
      expect(progress.event).toEqual({
        stream: 'provider',
        data: {
          phase: 'fallback',
          reason: 'auth',
          provider_id: 'openai-codex',
          candidate_index: 1,
          candidate_count: 3,
        },
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

  it('localizes storage exhaustion and emits a stable failure code', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              error: {
                kind: 'provider_error',
                message: 'ENOSPC: no space left on device, write',
                // Legacy/provider adapters may preserve only the generic code;
                // the exact ENOSPC message must still map to storage_full.
                code: 'PROVIDER_ERROR',
              },
            },
          },
        },
      ]);
      expect(out).toEqual([{
        type: 'error',
        text: '存储空间不足，请释放空间后重试。',
        failureKind: 'model',
        failureCode: 'storage_full',
        failurePhase: 'provider_wait',
      }]);
    } finally {
      setCurrentLang('en');
    }
  });

  it('treats an Orkas-looking quota code from a BYO provider as provider balance', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              provider: 'deepseek',
              error: {
                kind: 'provider_error',
                message: 'payment required',
                code: 'orkas_llm_quota_exceeded',
              },
            },
          },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'error',
        failureCode: 'provider_balance',
        failurePhase: 'provider_wait',
      });
      expect(String(out[0].text || '')).toContain('DeepSeek');
      expect(String(out[0].text || '')).toContain('余额不足');
      expect(String(out[0].text || '')).not.toContain('积分不足');
    } finally {
      setCurrentLang('en');
    }
  });

  it('treats an Orkas-looking quota code from a BYO provider as provider balance', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              provider: 'deepseek',
              error: {
                kind: 'provider_error',
                message: 'payment required',
                code: 'orkas_llm_quota_exceeded',
              },
            },
          },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'error',
        failureCode: 'provider_balance',
        failurePhase: 'provider_wait',
      });
      expect(String(out[0].text || '')).toContain('DeepSeek');
      expect(String(out[0].text || '')).toContain('余额不足');
      expect(String(out[0].text || '')).not.toContain('积分不足');
    } finally {
      setCurrentLang('en');
    }
  });

  it.each([
    ['PROVIDER_EMPTY_NORMAL', 'empty_response_normal'],
    ['PROVIDER_EMPTY_SAFETY', 'empty_response_safety'],
    ['PROVIDER_EMPTY_UNKNOWN', 'empty_response_unknown'],
    ['PROVIDER_EMPTY_RESPONSE', 'empty_response_unknown'],
    ['PROVIDER_EMPTY_TRANSPORT', 'provider_network'],
  ] as const)('maps %s to a bounded empty-response failure code', async (code, failureCode) => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              error: {
                kind: 'provider_error',
                message: 'empty response',
                code,
              },
            },
          },
        },
      ]);
      expect(out).toEqual([{
        type: 'error',
        text: '模型未返回内容',
        failureKind: 'model',
        failureCode,
        failurePhase: 'provider_wait',
      }]);
    } finally {
      setCurrentLang('en');
    }
  });

  it('names the user-configured provider on a third-party balance failure, never Orkas credits', async () => {
    // W4-3: BYOK balance exhaustion used the same "credits" wording as Orkas
    // billing, sending users to the wrong top-up page. The two must stay
    // visually distinct: third-party balance names the provider account,
    // Orkas billing keeps the credits wording (previous case).
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              provider: 'deepseek',
              error: {
                kind: 'provider_error',
                message: 'insufficient_balance: your account balance is not enough',
                code: 'INSUFFICIENT_BALANCE',
              },
            },
          },
        },
      ]);
      expect(out).toHaveLength(1);
      const text = String(out[0].text || '');
      expect(text).toContain('DeepSeek');
      expect(text).toContain('余额不足');
      expect(text).not.toContain('积分不足');
      expect(out[0]).toMatchObject({ type: 'error', failureCode: 'provider_balance' });
    } finally {
      setCurrentLang('en');
    }
  });

  it('names the user-configured provider on a third-party balance failure, never Orkas credits', async () => {
    // W4-3: BYOK balance exhaustion used the same "credits" wording as Orkas
    // billing, sending users to the wrong top-up page. The two must stay
    // visually distinct: third-party balance names the provider account,
    // Orkas billing keeps the credits wording (previous case).
    setCurrentLang('zh');
    try {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              provider: 'deepseek',
              error: {
                kind: 'provider_error',
                message: 'insufficient_balance: your account balance is not enough',
                code: 'INSUFFICIENT_BALANCE',
              },
            },
          },
        },
      ]);
      expect(out).toHaveLength(1);
      const text = String(out[0].text || '');
      expect(text).toContain('DeepSeek');
      expect(text).toContain('余额不足');
      expect(text).not.toContain('积分不足');
      expect(out[0]).toMatchObject({ type: 'error', failureCode: 'provider_balance' });
    } finally {
      setCurrentLang('en');
    }
  });

  it('localizes a mid-stream cutoff and classifies it as provider_network', async () => {
    setCurrentLang('zh');
    try {
      const out = await collect([
        { type: 'text_delta', text: '已完成一部分' },
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              error: {
                kind: 'provider_error',
                message: 'terminated',
                code: 'PROVIDER_ERROR',
              },
            },
          },
        },
      ]);
      expect(out).toEqual([
        { type: 'delta', text: '已完成一部分' },
        {
          type: 'error',
          text: '模型连接不稳定，请稍后再试。',
          failureKind: 'model',
          failureCode: 'provider_network',
          failurePhase: 'model_text',
        },
      ]);
    } finally {
      setCurrentLang('en');
    }
  });

  it('keeps an explicit request timeout in the provider_timeout category', async () => {
    for (const error of [
      {
        kind: 'timeout' as const,
        message: 'Request timed out',
        code: 'PROVIDER_ERROR',
      },
      {
        kind: 'provider_error' as const,
        message: 'socket request failed',
        code: 'ETIMEDOUT',
      },
    ]) {
      const out = await collect([
        {
          type: 'done',
          result: {
            text: '',
            meta: {
              error,
            },
          },
        },
      ]);
      expect(out).toEqual([{
        type: 'error',
        text: 'The model connection is unstable. Try again later.',
        failureKind: 'model',
        failureCode: 'provider_timeout',
        failurePhase: 'provider_wait',
      }]);
    }
  });

  // W0 remediation: the provider_error fallback once absorbed max_tokens
  // truncation, endpoint-level HTTP rejections, and exhausted retries — a
  // third of hard failures were unclassifiable in weekly conversation
  // sampling. Each named class must map to its own stable code.
  it('classifies a max_tokens truncation as provider_max_tokens', async () => {
    const out = await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error',
              message: 'Model output reached max_tokens (16384) before completing the turn; the partial response was discarded because it contained non-recoverable content and could include an incomplete tool call.',
              code: 'OUTPUT_LIMIT',
            },
          },
        },
      },
    ]);
    expect(out).toEqual([expect.objectContaining({
      type: 'error',
      failureKind: 'model',
      failureCode: 'provider_max_tokens',
      failurePhase: 'provider_wait',
    })]);
  });

  it('classifies exhausted runner retries as provider_retries_exhausted', async () => {
    const out = await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error',
              message: 'Max retries exceeded',
              code: 'PROVIDER_RETRIES_EXHAUSTED',
            },
          },
        },
      },
    ]);
    expect(out).toEqual([expect.objectContaining({
      type: 'error',
      failureKind: 'model',
      failureCode: 'provider_retries_exhausted',
      failurePhase: 'provider_wait',
    })]);
  });

  it('classifies an endpoint-level HTTP 4xx by status without leaking a raw code', async () => {
    const out = await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error',
              message: '410 status code (no body)',
              code: 'PROVIDER_ERROR',
              statusCode: 410,
            },
          },
        },
      },
    ]);
    expect(out).toEqual([expect.objectContaining({
      type: 'error',
      failureKind: 'model',
      failureCode: 'provider_http_410',
    })]);
    expect(out[0].failureRawCode).toBeUndefined();
  });

  it('diagnoses a repeatedly failing custom endpoint on the second consecutive 4xx', async () => {
    // W4-1 replay: a custom provider answered `410 (no body)` three runs in a
    // row; the user only ever saw "模型调用失败：410" and left with nothing.
    // From the second consecutive endpoint-level failure the visible error
    // must say the endpoint itself is suspect and point at Settings; a
    // successful run clears the suspicion again.
    const mapper = await import('../../../../src/main/model/core-agent/event-mapper');
    mapper.resetCustomEndpointFailureTracking();
    const failureTrackingScope = {};
    const failedRun = () => collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            provider: 'custom',
            error: {
              kind: 'provider_error' as const,
              message: '410 status code (no body)',
              code: 'PROVIDER_ERROR',
              statusCode: 410,
            },
          },
        },
      },
    ], { failureTrackingScope });

    const first = await failedRun();
    expect(String(first[0].text || '')).not.toContain('endpoint');

    const second = await failedRun();
    expect(String(second[0].text || '')).toContain('endpoint');
    expect(String(second[0].text || '')).toContain('410');
    expect(second[0]).toMatchObject({ type: 'error', failureCode: 'provider_http_410' });

    // A successful run resets the streak: the next single failure is quiet.
    await collect([
      { type: 'text_delta', text: 'recovered output' },
      {
        type: 'done',
        result: { text: 'recovered output', meta: { provider: 'custom', error: null } },
      },
    ], { failureTrackingScope });
    const afterRecovery = await failedRun();
    expect(String(afterRecovery[0].text || '')).not.toContain('endpoint');

    // An unrelated terminal failure also breaks the endpoint-specific streak.
    await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            provider: 'custom',
            error: {
              kind: 'rate_limit' as const,
              message: 'Too many requests',
              code: 'RATE_LIMIT',
            },
          },
        },
      },
    ], { failureTrackingScope });
    const afterUnrelatedFailure = await failedRun();
    expect(String(afterUnrelatedFailure[0].text || '')).not.toContain('endpoint');
    mapper.resetCustomEndpointFailureTracking();
  });

  it('keeps repeated custom-endpoint guidance isolated between model sessions', async () => {
    // A user opening another conversation must not inherit endpoint suspicion
    // from the first one, and recovery elsewhere must not erase the first
    // conversation's own streak. The visible guidance is the independent
    // oracle: each session must reach the threshold using only its own runs.
    const mapper = await import('../../../../src/main/model/core-agent/event-mapper');
    mapper.resetCustomEndpointFailureTracking();
    const sessionA = {};
    const sessionB = {};
    const freshSession = {};
    const failedRun = (failureTrackingScope: object) => collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            provider: 'custom',
            error: {
              kind: 'provider_error' as const,
              message: '410 status code (no body)',
              code: 'PROVIDER_ERROR',
              statusCode: 410,
            },
          },
        },
      },
    ], { failureTrackingScope });
    const successfulRun = (failureTrackingScope: object) => collect([
      { type: 'text_delta', text: 'recovered output' },
      {
        type: 'done',
        result: { text: 'recovered output', meta: { provider: 'custom', error: null } },
      },
    ], { failureTrackingScope });

    const firstA = await failedRun(sessionA);
    const firstB = await failedRun(sessionB);
    expect(String(firstA[0].text || '')).not.toContain('endpoint');
    expect(String(firstB[0].text || '')).not.toContain('endpoint');

    await successfulRun(sessionB);
    const secondA = await failedRun(sessionA);
    expect(String(secondA[0].text || '')).toContain('endpoint');

    const firstFresh = await failedRun(freshSession);
    expect(String(firstFresh[0].text || '')).not.toContain('endpoint');

    const afterRecoveryB = await failedRun(sessionB);
    expect(String(afterRecoveryB[0].text || '')).not.toContain('endpoint');
    mapper.resetCustomEndpointFailureTracking();
  });

  it('tells the user when a text-only model dropped their image attachments', async () => {
    // W4-2: without this row the only symptom is the model itself claiming
    // it cannot see the attachment, which sampled users debugged as their
    // own mistake for whole conversations.
    const out = await collect([
      { type: 'images_omitted', count: 2, providerId: 'custom' },
      { type: 'text_delta', text: 'answering without the screenshots' },
      { type: 'done', result: { text: 'answering without the screenshots', meta: { error: null } } },
    ] as never);
    expect(out[0]).toMatchObject({
      type: 'progress',
      event: { stream: 'provider', data: { phase: 'images_omitted', count: 2 } },
    });
    expect(String(out[0].text || '')).toContain('2');
    expect(String(out[0].text || '')).toContain('vision-capable');
  });

  it('advises switching models after the second consecutive output-cap overrun', async () => {
    // W4-2: an 8B model with an 8192 cap truncated six replies in a row and
    // nothing ever said the model was the problem. One overrun stays quiet
    // (long answers legitimately overrun once); the second names the cap.
    const mapper = await import('../../../../src/main/model/core-agent/event-mapper');
    mapper.resetCustomEndpointFailureTracking();
    const failureTrackingScope = {};
    const overrun = () => collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error' as const,
              message: 'Model output reached max_tokens (8192) before completing the turn; the partial response was discarded because it contained non-recoverable content and could include an incomplete tool call.',
              code: 'OUTPUT_LIMIT',
            },
          },
        },
      },
    ], { failureTrackingScope });
    const first = await overrun();
    expect(String(first[0].text || '')).not.toContain('output limit');
    const second = await overrun();
    expect(String(second[0].text || '')).toContain('larger output limit');
    expect(second[0]).toMatchObject({ type: 'error', failureCode: 'provider_max_tokens' });

    // A different terminal error interrupts the output-cap streak.
    await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'timeout' as const,
              message: 'Request timed out',
              code: 'ETIMEDOUT',
            },
          },
        },
      },
    ], { failureTrackingScope });
    const afterUnrelatedFailure = await overrun();
    expect(String(afterUnrelatedFailure[0].text || '')).not.toContain('larger output limit');
    mapper.resetCustomEndpointFailureTracking();
  });

  it('keeps repeated output-cap guidance isolated between model sessions', async () => {
    // Two conversations can hit the same small-model limit concurrently.
    // Neither user's first failure should be mislabeled as a repeated failure
    // because the other conversation failed or recovered.
    const mapper = await import('../../../../src/main/model/core-agent/event-mapper');
    mapper.resetCustomEndpointFailureTracking();
    const sessionA = {};
    const sessionB = {};
    const freshSession = {};
    const overrun = (failureTrackingScope: object) => collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error' as const,
              message: 'Model output reached max_tokens before completing the turn.',
              code: 'OUTPUT_LIMIT',
            },
          },
        },
      },
    ], { failureTrackingScope });
    const successfulRun = (failureTrackingScope: object) => collect([
      { type: 'text_delta', text: 'completed' },
      { type: 'done', result: { text: 'completed', meta: { error: null } } },
    ], { failureTrackingScope });

    const firstA = await overrun(sessionA);
    const firstB = await overrun(sessionB);
    expect(String(firstA[0].text || '')).not.toContain('larger output limit');
    expect(String(firstB[0].text || '')).not.toContain('larger output limit');

    await successfulRun(sessionB);
    const secondA = await overrun(sessionA);
    expect(String(secondA[0].text || '')).toContain('larger output limit');

    const firstFresh = await overrun(freshSession);
    expect(String(firstFresh[0].text || '')).not.toContain('larger output limit');

    const afterRecoveryB = await overrun(sessionB);
    expect(String(afterRecoveryB[0].text || '')).not.toContain('larger output limit');
    mapper.resetCustomEndpointFailureTracking();
  });

  it('keeps the residual provider_error fallback but carries the original code', async () => {
    const out = await collect([
      {
        type: 'done',
        result: {
          text: '',
          meta: {
            error: {
              kind: 'provider_error',
              message: 'upstream rejected the request',
              code: 'SOME_VENDOR_SPECIFIC_CODE',
            },
          },
        },
      },
    ]);
    expect(out).toEqual([expect.objectContaining({
      type: 'error',
      failureKind: 'model',
      failureCode: 'provider_error',
      failureRawCode: 'SOME_VENDOR_SPECIFIC_CODE',
    })]);
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
