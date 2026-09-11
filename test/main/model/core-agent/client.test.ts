import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(),
  },
}));

vi.mock('../../../../src/main/util/bundled-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/util/bundled-runtime')>();
  return {
    ...actual,
    bundledNodeExecutable: () => '/opt/orkas/runtime/node',
    bundledRuntimeEnv: () => ({
      ...actual.bundledRuntimeEnv(),
      ORKAS_BUNDLED_NODE: '/opt/orkas/runtime/node',
    }),
  };
});

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-core-client-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('core-agent client skill sandbox env', () => {
  it('passes the canonical workspace root through to bash skill invocations', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const env = client.buildSkillSandboxEnv();

    expect(env).toMatchObject({
      ORKAS_PC_DIR: process.cwd(),
      ORKAS_WORKSPACE_ROOT: path.resolve(tmpDir),
      ORKAS_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv'),
      ORKAS_PYTHON_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv', 'python'),
      UV_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'uv'),
      PIP_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'pip'),
    });
    expect(env.ORKAS_NODE).toBe(env.ORKAS_BUNDLED_NODE);
    expect(env.ORKAS_NODE).not.toBe(process.execPath);
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('adds the current agent id to bash skill invocations when provided', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    expect(client.buildSkillSandboxEnv('u1', 'agent-a')).toMatchObject({
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-a',
    });
    expect(client.buildSkillSandboxEnv('u1', '../agent-a')).not.toHaveProperty('ORKAS_AGENT_ID');
  });

  it('stops waiting for a wedged event stream when the abort signal fires', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const controller = new AbortController();

    async function* stuckStream() {
      yield { type: 'delta', text: 'started' };
      await new Promise(() => { /* never resolves */ });
    }

    const iterator = client.stopStreamOnAbort(stuckStream(), controller.signal, 'test')[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: 'delta', text: 'started' }, done: false });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it('flushes pending mapped state before stopping an aborted stream', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const controller = new AbortController();

    async function* stuckStream() {
      yield { type: 'event', event: { stream: 'reasoning', data: { phase: 'start' } } };
      await new Promise(() => { /* never resolves */ });
    }

    const flushed = {
      type: 'event',
      event: { stream: 'reasoning', data: { phase: 'end', summary: 'complete' } },
    };
    const iterator = client.stopStreamOnAbort(
      stuckStream(),
      controller.signal,
      'reasoning-test',
      () => flushed,
    )[Symbol.asyncIterator]();
    expect((await iterator.next()).value.event.data.phase).toBe('start');
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ value: flushed, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('keeps a non-overlapping live timing snapshot when a run aborts before done metadata', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const timings = client.createLiveRunTimings(1_000);

    client.transitionLiveRunTimings(timings, 'provider', 1_100);
    client.transitionLiveRunTimings(timings, 'tool', 1_500);
    client.transitionLiveRunTimings(timings, 'provider', 1_700);
    client.transitionLiveRunTimings(timings, 'compaction', 1_900);
    client.transitionLiveRunTimings(timings, 'provider', 2_200);
    client.transitionLiveRunTimings(timings, 'retry_wait', 2_300);

    expect(client.snapshotLiveRunTimings(timings, 2_500)).toEqual({
      providerMs: 700,
      toolMs: 200,
      compactionMs: 300,
      retryWaitMs: 200,
      otherMs: 100,
    });
  });

  it('builds model turn log context without raw prompts, ids, or paths', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    const ctx = client.modelTurnContextForLog({
      userId: 'user-secret-123456789',
      sessionId: 'gconv-secret-session-id-12345',
      cid: 'conversation-private-abcdef',
      turnId: 'turn-private-abcdef',
      agentId: 'agent-private-abcdef',
      projectId: 'project-private-abcdef',
      message: 'please analyze my private launch plan',
      systemPrompt: 'private system rules',
      resolvedSystemPrompt: 'private system rules with private skill catalog',
      turnEphemeral: 'private live task board',
      workingDir: '/Users/test/Secret Project',
      extraRoots: ['/Users/test/Extra Private Root'],
      readOnlyExtraRoots: ['/Users/test/Readonly Private Root'],
      toolList: ['workspace.read', 'web'],
      toolSurfaceMode: 'scoped',
      toolDefs: [
        { name: 'read_file', description: 'reads files', inputSchema: {}, source: 'core-agent' },
        { name: 'dispatch_to', description: 'dispatches', inputSchema: {}, source: 'extra' },
      ],
      providerId: 'openai',
      modelId: 'gpt-test',
      profileId: 'profile-secret-123456',
      entryId: 'entry-secret-123456',
      buildDurationMs: 42,
    });

    expect(ctx.message_chars).toBe('please analyze my private launch plan'.length);
    expect(ctx.system_prompt_chars).toBe('private system rules'.length);
    expect(ctx.resolved_system_prompt_chars)
      .toBe('private system rules with private skill catalog'.length);
    expect(ctx.turn_ephemeral_chars).toBe('private live task board'.length);
    expect(ctx.extra_root_count).toBe(1);
    expect(ctx.read_only_extra_root_count).toBe(1);
    expect(ctx.tool_count).toBe(2);
    expect(ctx.tool_definition_chars).toBe(
      JSON.stringify({ name: 'read_file', description: 'reads files', inputSchema: {} }).length
      + JSON.stringify({ name: 'dispatch_to', description: 'dispatches', inputSchema: {} }).length,
    );
    expect(ctx.tool_names).toEqual(['dispatch_to', 'read_file']);
    expect(ctx.tool_list_mode).toBe('scoped');
    expect(ctx.tool_list_count).toBe(2);
    expect(ctx.tool_surface_mode).toBe('scoped');
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('private launch plan');
    expect(serialized).not.toContain('private system rules');
    expect(serialized).not.toContain('private skill catalog');
    expect(serialized).not.toContain('private live task board');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('Secret Project');
    expect(serialized).not.toContain('secret-session-id');
    expect(serialized).not.toContain('conversation-private');
    expect(serialized).not.toContain('turn-private');
    expect(serialized).not.toContain('profile-secret');
  });

  it('logs the actual scoped surface even when Commander has no Agent tool_list', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const ctx = client.modelTurnContextForLog({
      sessionId: 'gconv-new-scoped-session',
      toolSurfaceMode: 'scoped',
    });

    expect(ctx.tool_list_mode).toBe('legacy');
    expect(ctx.tool_surface_mode).toBe('scoped');
  });

  it('logs missing named-Agent skill_list metadata as lazy agent defaults instead of all skills', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const missing = client.modelTurnContextForLog({
      sessionId: 'gmember-conversation-agent',
    });
    const explicitEmpty = client.modelTurnContextForLog({
      sessionId: 'gmember-conversation-agent',
      skillList: [],
    });

    expect(missing.skill_list_mode).toBe('agent_defaults');
    expect(missing.skill_list_count).toBeUndefined();
    expect(explicitEmpty.skill_list_mode).toBe('allowlist');
    expect(explicitEmpty.skill_list_count).toBe(0);
  });

  it('reconciles one reply timing summary without requiring a full call timeline', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    expect(client.modelRunTimingSummaryForLog(1_200, {
      providerMs: 800,
      toolMs: 100,
      compactionMs: 50,
      retryWaitMs: 25,
      otherMs: 75,
    })).toEqual({
      total_ms: 1_200,
      provider_ms: 800,
      tool_ms: 100,
      compaction_ms: 50,
      retry_wait_ms: 25,
      other_ms: 225,
    });
  });

  it('preserves compound session kinds instead of truncating them at the first dash', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    expect(client.modelTurnContextForLog({ sessionId: 'extract-img-private-tail' }).session_kind)
      .toBe('extract-img');
    expect(client.modelTurnContextForLog({ sessionId: 'memory-extract-private-tail' }).session_kind)
      .toBe('unknown');
    expect(client.modelTurnContextForLog({ sessionId: 'private-prefix-tail' }).session_kind)
      .toBe('unknown');
  });

  it('uses the response provider and model for external-provider fallbacks', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    expect(client.modelRunIdsForTelemetry(
      'openrouter',
      'openai/gpt-5.6-sol',
      'anthropic',
      'claude-opus-4-8',
    )).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });

  it('summarizes model events without tool arguments, tool results, or final text', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);

    client.recordModelRawEventForLog(stats, { type: 'text_delta', text: 'private lead text' }, 1050);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_delta',
      id: 'call-secret-123456',
      name: 'bash',
      inputDelta: 'private command fragment',
      inputBytes: 24,
    }, 1075);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'call-secret-123456',
      name: 'bash',
      input: { command: 'cat /Users/test/private.txt' },
    }, 1100);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_progress',
      id: 'call-secret-123456',
      name: 'bash',
      message: 'private progress with /Users/test/private.txt',
    }, 1150);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end',
      id: 'call-secret-123456',
      name: 'bash',
      isError: true,
      result: 'private command output',
      errorCode: 'tool_execution_exception',
      errorSeverity: 'error',
    }, 1200);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'call-secret-abcdef',
      name: 'read_file',
      input: { path: '/Users/test/private.txt' },
    }, 1225);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end',
      id: 'call-secret-abcdef',
      name: 'read_file',
      isError: false,
      result: 'second private output',
    }, 1240);
    client.recordModelRawEventForLog(stats, { type: 'retry', reason: 'fetch failed with secret body', attempt: 1 }, 1250);
    client.recordModelRawEventForLog(stats, { type: 'compaction', summary: 'private summary', tokensBefore: 100, tokensAfter: 40 }, 1300);
    client.recordModelRawEventForLog(stats, {
      type: 'done',
      result: {
        meta: {
          provider: 'openai',
          model: 'gpt-test',
          durationMs: 500,
          stopReason: 'end_turn',
          toolLoops: 2,
          skillsLoaded: ['private-skill-id'],
          transientToolErrors: 1,
          permanentToolErrors: 2,
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
          error: { kind: 'tool_error', message: 'private error' },
        },
        text: 'private raw final',
        content: [{ type: 'text', text: 'private raw final' }],
      },
    }, 1500);
    client.recordModelStreamEventForLog(stats, { type: 'final', text: 'private final answer' }, 1510);
    client.recordModelStreamEventForLog(stats, { type: 'error', text: 'private stream error', aborted: true }, 1520);

    const summary = client.summarizeModelRunForLog(stats, 1600);
    expect(summary.toolStarts).toBe(2);
    expect(summary.toolEnds).toBe(2);
    expect(summary.toolErrors).toBe(1);
    expect(summary.retryCount).toBe(1);
    expect(summary.compactionCount).toBe(1);
    expect(summary.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    expect(summary.retryKinds).toMatchObject({ network: 1 });
    expect(summary.stopReason).toBe('end_turn');
    expect(summary.resultTextChars).toBe('private raw final'.length);
    expect(summary.resultContentBlocks).toBe(1);
    expect(summary.toolLoops).toBe(2);
    expect(summary.skillsLoadedCount).toBe(1);
    expect(summary.transientToolErrors).toBe(1);
    expect(summary.permanentToolErrors).toBe(2);
    expect(summary.lastCompactionTokensBefore).toBe(100);
    expect(summary.lastCompactionTokensAfter).toBe(40);
    expect(summary.toolNames).toEqual(['bash', 'read_file']);
    expect(summary.toolTimeline).toEqual([
      '#1 +100ms bash start call=call...3456',
      '#2 +150ms bash progress call=call...3456',
      `#3 +200ms bash end call=call...3456 error=true result_chars=${'private command output'.length}`,
      '#4 +225ms read_file start call=call...cdef',
      `#5 +240ms read_file end call=call...cdef error=false result_chars=${'second private output'.length}`,
    ]);
    expect(summary.toolTimelineTruncated).toBe(0);
    expect(summary.runTimeline).toEqual([
      '#1 +50ms raw_text_delta chars=17',
      '#2 +75ms tool_input_delta tool=bash call=call...3456 input_bytes=24',
      '#3 +100ms tool_start tool=bash call=call...3456',
      '#4 +150ms tool_progress tool=bash call=call...3456',
      '#5 +200ms tool_end tool=bash call=call...3456 error=true severity=error',
      '#6 +225ms tool_start tool=read_file call=call...cdef',
      '#7 +240ms tool_end tool=read_file call=call...cdef error=false',
      '#8 +250ms retry kind=network attempt=1',
      '#9 +300ms compaction before=100 after=40',
      '#10 +500ms raw_done stop=end_turn text_chars=17 error_kind=tool_error',
      '#11 +510ms client_final chars=20',
      '#12 +520ms client_error chars=20 aborted=true',
    ]);
    expect(summary.runTimelineTruncated).toBe(0);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('private lead text');
    expect(serialized).not.toContain('private command fragment');
    expect(serialized).not.toContain('cat /Users');
    expect(serialized).not.toContain('private command output');
    expect(serialized).not.toContain('second private output');
    expect(serialized).not.toContain('private final answer');
    expect(serialized).not.toContain('private raw final');
    expect(serialized).not.toContain('private stream error');
    expect(serialized).not.toContain('private summary');
    expect(serialized).not.toContain('private error');
    expect(serialized).not.toContain('private-skill-id');
    expect(serialized).not.toContain('call-secret-123456');
    expect(serialized).not.toContain('private progress');
  });

  it('counts reasoning as model liveness without treating it as visible content', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1_000);

    client.recordModelRawEventForLog(stats, {
      type: 'thinking', phase: 'start', chars: 0,
    }, 1_050);
    client.recordModelRawEventForLog(stats, {
      type: 'thinking', phase: 'progress', chars: 128,
    }, 1_150);
    client.recordModelRawEventForLog(stats, {
      type: 'thinking', phase: 'end', chars: 128,
    }, 1_250);

    expect(stats.firstModelEventMs).toBe(50);
    expect(stats.firstContentMs).toBeUndefined();
    expect(client.summarizeModelRunForLog(stats, 1_300).runTimeline).toEqual([
      '#1 +50ms thinking_start chars=0',
      '#2 +150ms thinking_progress chars=128',
      '#3 +250ms thinking_end chars=128',
    ]);
  });

  it('tracks corrective same-operation tool calls separately from runtime exceptions and parallel siblings', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);

    // These two calls were already running together. The successful sibling
    // cannot be evidence that the later-arriving error was corrected.
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'read-failed', name: 'read_file', input: { path: 'missing.txt' },
    }, 1010);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'read-sibling', name: 'read_file', input: { path: 'other.txt' },
    }, 1011);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'read-failed', name: 'read_file', isError: true, result: 'not found',
    }, 1020);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'read-sibling', name: 'read_file', isError: false, result: 'other file',
    }, 1021);
    expect(stats.toolResultErrorsRecovered).toBe(0);

    // A newly started call to the same operation after observing the failure
    // is a real recovery signal, even though its corrected path differs.
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'read-corrected', name: 'read_file', input: { path: 'correct.txt' },
    }, 1030);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'read-corrected', name: 'read_file', isError: false, result: 'correct file',
    }, 1040);

    // A different operation exposed behind the same generic tool name is not
    // a recovery for the failed operation.
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'state-read-failed', name: 'state_tool', input: { op: 'read' },
    }, 1041);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'state-read-failed', name: 'state_tool', isError: true, result: 'bad locator',
    }, 1042);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'state-write-ok', name: 'state_tool', input: { op: 'write' },
    }, 1043);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'state-write-ok', name: 'state_tool', isError: false, result: 'saved',
    }, 1044);

    // A runner exception is a separate incident class and must not inflate the
    // returned-error or recovery counters.
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'bash-crash', name: 'bash', isError: true,
      errorCode: 'tool_execution_exception', errorSeverity: 'error', result: 'spawn failed',
    }, 1050);

    expect(stats.toolResultErrors).toBe(2);
    expect(stats.toolResultErrorsRecovered).toBe(1);
    expect(client.summarizeModelRunForLog(stats, 1060)).toMatchObject({
      toolResultErrors: 2,
      toolResultErrorsRecovered: 1,
      toolResultErrorsWithoutObservedRecovery: 1,
      toolResultErrorsUnresolved: 1,
    });
  });

  it('recovers an invalid selector-less call only from a later retry with the same argument shape', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);

    // The model omitted `action`, so the tool rejected the otherwise
    // recognisable batch update. A corrected retry adds the selector.
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'plan-invalid', name: 'manage_execution_plan',
      input: { updates: [{ step_id: 'step-1', status: 'completed' }] },
    }, 1010);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'plan-invalid', name: 'manage_execution_plan',
      isError: true, result: 'action is required',
    }, 1020);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'plan-corrected', name: 'manage_execution_plan',
      input: { action: 'set_statuses', updates: [{ step_id: 'step-1', status: 'completed' }] },
    }, 1030);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'plan-corrected', name: 'manage_execution_plan',
      isError: false, result: 'updated',
    }, 1040);

    expect(stats.toolResultErrors).toBe(1);
    expect(stats.toolResultErrorsRecovered).toBe(1);
    expect(client.summarizeModelRunForLog(stats, 1050)).toMatchObject({
      toolResultErrors: 1,
      toolResultErrorsRecovered: 1,
      toolResultErrorsWithoutObservedRecovery: 0,
      toolResultErrorsUnresolved: 0,
    });
  });

  it('does not treat a different selector-less argument shape as recovery', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);

    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'plan-invalid', name: 'manage_execution_plan',
      input: { updates: [{ step_id: 'step-1', status: 'completed' }] },
    }, 1010);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'plan-invalid', name: 'manage_execution_plan',
      isError: true, result: 'action is required',
    }, 1020);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start', id: 'different-call', name: 'manage_execution_plan',
      input: { action: 'set_status', step_id: 'step-1', status: 'completed' },
    }, 1030);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end', id: 'different-call', name: 'manage_execution_plan',
      isError: false, result: 'updated',
    }, 1040);

    expect(stats.toolResultErrors).toBe(1);
    expect(stats.toolResultErrorsRecovered).toBe(0);
    expect(client.summarizeModelRunForLog(stats, 1050)).toMatchObject({
      toolResultErrorsWithoutObservedRecovery: 1,
      toolResultErrorsUnresolved: 1,
    });
  });

  it('reports compaction attempts and failures separately from successful compactions', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status',
      phase: 'active_process_compaction_start',
      data: { groups: 3 },
    }, 1010);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status',
      phase: 'active_process_compaction_failed',
      data: { disabledReason: 'unsupported_reasoning_parameter', error: 'private provider body' },
    }, 1020);
    const summary = client.summarizeModelRunForLog(stats, 1030);
    expect(summary).toMatchObject({
      compactionCount: 0,
      compactionAttemptCount: 1,
      compactionFailureCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain('private provider body');
  });

  it('counts context-gate interventions and compaction-span re-reads for run telemetry', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1000);

    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'overflow_recovery',
      data: { result: 'retried', foldedGroups: 2 },
    }, 1010);
    // A recovery that found nothing terminates the run with a context_overflow
    // error code; counting it here would double-report the same failure.
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'overflow_recovery',
      data: { result: 'nothing_to_recover' },
    }, 1015);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'emergency_reduction',
      data: { result: 'applied', foldedGroups: 1 },
    }, 1020);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'emergency_reduction',
      data: { result: 'nothing_to_drop' },
    }, 1025);
    // A run's first compaction has no measured span yet: no re-read fields.
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'active_process_compaction_start',
      data: { groups: 2 },
    }, 1030);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'active_process_compaction_start',
      data: { groups: 1, readsSinceLastCompaction: 5, rereadPaths: 3, rereadIdenticalContent: 2 },
    }, 1040);
    client.recordModelRawEventForLog(stats, {
      type: 'context_status', phase: 'history_summary_start',
      data: { turns: 4, readsSinceLastCompaction: 4, rereadPaths: 1, rereadIdenticalContent: 0 },
    }, 1050);

    expect(client.summarizeModelRunForLog(stats, 1060)).toMatchObject({
      overflowRecoveryCount: 1,
      emergencyFoldCount: 1,
      emergencyNoDropCount: 1,
      rereadReads: 9,
      rereadPaths: 4,
      rereadIdentical: 2,
    });
  });

  it('separates host fallback activity from first model event and first usable content', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1_000);

    client.recordModelRawEventForLog(stats, {
      type: 'provider_fallback',
      reason: 'no_first_event_timeout',
      providerId: 'private-provider-id',
      candidateIndex: 1,
      candidateCount: 3,
    }, 1_180);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_fallback',
      reason: 'auth',
      providerId: 'another-private-provider',
      candidateIndex: 2,
      candidateCount: 3,
    }, 1_220);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_empty',
      kind: 'normal_end_empty',
      providerId: 'private-provider-id',
      candidateIndex: 1,
      candidateCount: 3,
      terminalEventSeen: true,
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    }, 1_230);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_call',
      outcome: 'completed',
      model: 'private-model-id',
      durationMs: 70_000,
      reasoningBoundary: { structured: true, literalLeadingText: false },
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 5,
        totalTokens: 1_109,
      },
    }, 1_240);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_call',
      outcome: 'completed',
      model: 'private-model-id',
      durationMs: 500,
      stopReason: 'tool_use',
      textChars: 37,
      reasoningBoundary: { structured: false, literalLeadingText: true },
      usage: {
        inputTokens: 120,
        outputTokens: 5,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 6,
        totalTokens: 1_131,
      },
    }, 1_250);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'private-call-id',
      name: 'read_file',
      input: { path: '/private/workspace/.agents/skills/research/SKILL.md' },
    }, 1_300);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_delta',
      id: 'private-call-id',
      name: 'read_file',
      inputBytes: 10,
    }, 1_400);

    const summary = client.summarizeModelRunForLog(stats, 1_500);
    expect(summary).toMatchObject({
      firstRawEventMs: 180,
      firstModelEventMs: 300,
      firstContentMs: 300,
      providerFallbackCount: 2,
      providerFallbackAuthCount: 1,
      providerFallbackTimeoutCount: 1,
      providerCallCount: 2,
      providerCallMaxMs: 70_000,
      providerSlowCallCount: 1,
      structuredReasoningCallCount: 1,
      literalThinkContentCallCount: 1,
      providerUsage: {
        observedCalls: 2,
        inputTokens: 220,
        outputTokens: 9,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 11,
        totalTokens: 2_240,
      },
      providerCandidateCount: 3,
      providerEmptyCount: 1,
      providerEmptyNormalCount: 1,
      providerEmptyTerminalCount: 1,
      providerEmptyOutputTokens: 2,
      lastFallbackCandidateIndex: 2,
    });
    expect(JSON.stringify(summary)).not.toContain('private-provider-id');
    expect(JSON.stringify(summary)).not.toContain('another-private-provider');
    expect(JSON.stringify(summary)).not.toContain('private-call-id');
    expect(JSON.stringify(summary)).not.toContain('/private/workspace');

  });

  it('keeps an unbounded Token aggregate when provider-round details are capped', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1_000);
    for (let index = 0; index < 70; index++) {
      client.recordModelRawEventForLog(stats, {
        type: 'provider_call',
        outcome: 'completed',
        durationMs: 100,
        usage: {
          inputTokens: 5,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          totalTokens: 10,
        },
      }, 1_100 + index);
    }

    expect(stats.providerRounds).toHaveLength(64);
    expect(stats.providerRoundsTruncated).toBe(6);
    expect(stats.providerUsage).toEqual({
      observedCalls: 70,
      inputTokens: 350,
      outputTokens: 70,
      cacheReadTokens: 210,
      cacheWriteTokens: 70,
      totalTokens: 700,
    });
  });

  it('records successful Plan mutation shape without retaining Plan content', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1_000);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_call',
      outcome: 'completed',
      model: 'private-model-id',
      durationMs: 500,
      stopReason: 'tool_use',
    }, 1_500);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'private-plan-call',
      name: 'manage_execution_plan',
      input: {
        action: 'update',
        plan: [{ step: 'private milestone text', status: 'in_progress' }],
      },
    }, 1_510);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end',
      id: 'private-plan-call',
      name: 'manage_execution_plan',
      result: JSON.stringify({
        ok: true,
        action: 'update',
        revision: 1,
        step_count: 3,
        step_ids: [1, 2, 3],
        updated_step_ids: [1, 2, 3],
      }),
    }, 1_520);

    client.recordModelRawEventForLog(stats, {
      type: 'provider_call',
      outcome: 'completed',
      model: 'private-model-id',
      durationMs: 400,
      stopReason: 'tool_use',
    }, 1_900);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'failed-plan-call',
      name: 'manage_execution_plan',
      input: { action: 'set_statuses', updates: [{ step_id: 1, status: 'completed' }] },
    }, 1_910);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end',
      id: 'failed-plan-call',
      name: 'manage_execution_plan',
      result: JSON.stringify({
        ok: false,
        current_steps: [{ id: 1, step: 'another private milestone', status: 'in_progress' }],
      }),
      isError: true,
    }, 1_920);

  });

  it('does not misclassify a revision-one no-op replay as initial Plan creation', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const stats = client.createModelRunLogDiagnostics(1_000);
    client.recordModelRawEventForLog(stats, {
      type: 'provider_call',
      outcome: 'completed',
      model: 'private-model-id',
      durationMs: 250,
      stopReason: 'tool_use',
    }, 1_250);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_start',
      id: 'replayed-plan-call',
      name: 'manage_execution_plan',
      input: { plan: [{ step: 'private milestone text', status: 'in_progress' }] },
    }, 1_260);
    client.recordModelRawEventForLog(stats, {
      type: 'tool_end',
      id: 'replayed-plan-call',
      name: 'manage_execution_plan',
      result: JSON.stringify({
        ok: true,
        action: 'update',
        revision: 1,
        step_count: 1,
        updated_step_ids: [],
        unchanged: true,
      }),
    }, 1_270);

    expect(stats.providerRounds[0]?.planMutations).toEqual([{
      action: 'update',
      initialExplicitPlan: false,
      stepCount: 1,
      changedStepCount: 0,
      noOp: true,
    }]);
  });
});
