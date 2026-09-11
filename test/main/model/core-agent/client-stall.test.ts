import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Phase 1 (long-task-streaming-reliability): the model-stream idle watchdog is
// phase-aware. While the MODEL is actively streaming text (no tool in flight)
// it uses the SHORT `streamIdleTimeout` so a stream that started then went
// silent recovers fast. Provider waits and incomplete tool input use separate
// middle windows, while a TOOL execution uses the long `idleTimeout`-derived
// watchdog so downloads are not false-killed. Either way the turn must
// terminate cleanly (yield error/final + done and RETURN — no wedge), so the
// bus worker can run its finally and accept the next message.

const h = vi.hoisted(() => ({
  makeStream: null as null | (() => AsyncGenerator),
  lastBuildRunnerParams: null as null | Record<string, unknown>,
  runStreamCalls: 0,
  sessionStoreCalls: [] as string[],
  logEntries: [] as Array<{ level: string; message: string; data?: Record<string, unknown> }>,
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    info: (message: string, data?: Record<string, unknown>) => h.logEntries.push({ level: 'info', message, data }),
    warn: (message: string, data?: Record<string, unknown>) => h.logEntries.push({ level: 'warn', message, data }),
    error: (message: string, data?: Record<string, unknown>) => h.logEntries.push({ level: 'error', message, data }),
  }),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: {},
  shell: {},
}));

// The runner's "provider stream" is whatever the current test installs in
// `h.makeStream` — read at runStream() call time, so no module reset is needed.
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: async (params: Record<string, unknown>) => ({
    runner: { runStream: (runParams: Record<string, unknown>) => {
      h.runStreamCalls += 1;
      h.lastBuildRunnerParams = params;
      h.lastRunStreamParams = runParams;
      return h.makeStream!();
    } },
    failureTrackingScope: {},
    resolvedSystemPrompt: 'sys',
    entryId: 'e1',
    profileId: 'p1',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    toolDefs: [],
    toolSurfaceTelemetry: () => ({
      mode: 'fixed',
      peakToolCount: 0,
      loadCallCount: 0,
      loadedGroupCount: 0,
      loadedSchemaChars: 0,
      loadedUnusedGroupCount: 0,
      webToolUsed: false,
    }),
    skillDisplayNameById: new Map(),
    agentDisplayNameById: new Map(),
  }),
}));

vi.mock('../../../../src/main/model/core-agent/session-store', () => ({
  getSession: async (id: string) => {
    h.sessionStoreCalls.push(`getSession:${id}`);
    return null;
  },
  getSessionForUser: async (userId: string, id: string) => {
    h.sessionStoreCalls.push(`getSessionForUser:${userId}:${id}`);
    return null;
  },
  evictEphemeralSession: (userId: string, id: string) => {
    h.sessionStoreCalls.push(`evictEphemeral:${userId}:${id}`);
  },
  // client.ts logs the session kind on every stream; without this export the
  // whole suite dies on an unmocked call rather than on anything it tests.
  sessionKindOf: (sessionId: string) => String(sessionId || '').split('-')[0] || '',
}));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function completedEvent(text: string) {
  return {
    type: 'done',
    result: {
      text,
      content: text ? [{ type: 'text', text }] : [],
      meta: {
        durationMs: 1,
        model: 'mock-model',
        provider: 'mock-provider',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: text ? 1 : 0, totalTokens: text ? 2 : 1 },
        toolLoops: 0,
        compactionCount: 0,
      },
    },
  };
}

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-client-stall-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  h.runStreamCalls = 0;
  h.sessionStoreCalls = [];
  h.lastRunStreamParams = null;
  h.logEntries = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type DrainedEvent = {
  type: string;
  text?: string;
  failureKind?: 'model' | 'config';
  failureCode?: string;
  failurePhase?: string;
  telemetry?: Record<string, unknown>;
  event?: { stream?: string; data?: Record<string, unknown> };
};

async function drain(opts: Record<string, unknown>): Promise<{ events: DrainedEvent[]; ms: number }> {
  const client = await import('../../../../src/main/model/core-agent/client');
  const events: DrainedEvent[] = [];
  const start = Date.now();
  for await (const ev of client.streamChatWithModel({
    userId: 'u1',
    message: 'hi',
    sessionId: 'gconv-stalltest',
    ...opts,
  } as Parameters<typeof client.streamChatWithModel>[0])) {
    events.push(ev as DrainedEvent);
  }
  return { events, ms: Date.now() - start };
}

describe('streamChatWithModel — phase-aware idle watchdog (Phase 1)', () => {
  it.each(['provider', 'text'] as const)('uses the shared 30-minute default for a stalled %s stream', async (phase) => {
    await import('../../../../src/main/model/core-agent/client');
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    h.makeStream = () => (async function* () {
      if (phase === 'text') yield { type: 'text_delta', text: 'partial' };
      started();
      await new Promise(() => {});
    })();
    const result = drain({});
    await ready;
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect((h.lastRunStreamParams?.signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    const { events } = await result;
    expect(events.filter(e => e.type === 'error')).toEqual([
      expect.objectContaining({ failureCode: 'idle_timeout' }),
    ]);
    expect(events.at(-1)?.type).toBe('done');
    expect((h.lastRunStreamParams?.signal as AbortSignal).aborted).toBe(true);
  });

  it('allows active work beyond two hours, stops at 24 hours, and permits a fresh user continuation', async () => {
    await import('../../../../src/main/model/core-agent/client');
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    h.makeStream = () => (async function* () {
      const signal = h.lastRunStreamParams?.signal as AbortSignal;
      started();
      while (!signal.aborted) {
        yield { type: 'thinking', text: 'working' };
        await delay(20 * 60_000);
      }
    })();
    const result = drain({});
    await ready;
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect((h.lastRunStreamParams?.signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(21 * 60 * 60_000);
    const { events } = await result;
    expect(events.filter(e => e.type === 'error')).toEqual([
      expect.objectContaining({ failureCode: 'execution_wall_timeout' }),
    ]);
    expect(events.at(-1)?.type).toBe('done');
    h.makeStream = () => (async function* () { yield completedEvent('continued'); })();
    const next = await drain({});
    expect(next.events.filter(e => e.type === 'error')).toEqual([]);
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'final', text: 'continued' }));
  });

  it('ignores UI-only tool heartbeats but suspends idle detection while user action is pending', async () => {
    await import('../../../../src/main/model/core-agent/client');
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    h.makeStream = () => (async function* () {
      yield { type: 'tool_start', id: 'approval-1', name: 'bash', input: {} };
      yield { type: 'tool_progress', id: 'approval-1', name: 'bash', message: 'Waiting', data: { heartbeat: true, userAction: true } };
      started();
      await delay(2_000);
      yield { type: 'tool_progress', id: 'approval-1', name: 'bash', message: 'Running', data: { heartbeat: true } };
      const signal = h.lastRunStreamParams?.signal as AbortSignal;
      while (!signal.aborted) {
        await delay(100);
        yield { type: 'tool_progress', id: 'approval-1', name: 'bash', message: 'Running', data: { heartbeat: true } };
      }
    })();
    const result = drain({ idleTimeout: 1 });
    await ready;
    await vi.advanceTimersByTimeAsync(1_900);
    expect((h.lastRunStreamParams?.signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_400);
    const { events } = await result;
    expect(events.filter(e => e.type === 'error')).toEqual([
      expect.objectContaining({ failureCode: 'idle_timeout', failurePhase: 'tool' }),
    ]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('writes one terminal timing breakdown for a completed reply', async () => {
    h.makeStream = () => (async function* () {
      yield {
        type: 'done',
        result: {
          text: 'ok',
          content: [{ type: 'text', text: 'ok' }],
          meta: {
            durationMs: 20,
            model: 'mock-model',
            provider: 'mock-provider',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            timings: {
              providerMs: 12,
              toolMs: 3,
              compactionMs: 1,
              retryWaitMs: 2,
              otherMs: 2,
            },
          },
        },
      };
    })();

    await drain({});

    const finishes = h.logEntries.filter((entry) => entry.message === 'model turn finish');
    expect(finishes).toHaveLength(1);
    const timings = finishes[0]?.data?.timings as Record<string, number>;
    expect(timings).toMatchObject({
      provider_ms: 12,
      tool_ms: 3,
      compaction_ms: 1,
      retry_wait_ms: 2,
    });
    expect(timings.total_ms).toBe(
      timings.provider_ms
      + timings.tool_ms
      + timings.compaction_ms
      + timings.retry_wait_ms
      + timings.other_ms,
    );
  });

  it('leaves provider reasoning controls unset unless the caller explicitly selects one', async () => {
    h.makeStream = () => (async function* () {
      yield {
        type: 'done',
        result: {
          text: 'ok',
          content: [{ type: 'text', text: 'ok' }],
          meta: {
            durationMs: 1,
            model: 'mock-model',
            provider: 'mock-provider',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      };
    })();

    await drain({});
    expect(h.lastRunStreamParams).not.toHaveProperty('thinkingLevel');

    for (const thinkingLevel of ['off', 'low', 'high'] as const) {
      await drain({ thinkingLevel });
      expect(h.lastRunStreamParams).toMatchObject({ thinkingLevel });
    }
  });

  it('keeps partial blocking-call text after a provider network interruption', async () => {
    h.makeStream = () => (async function* () {
      yield { type: 'text_delta', text: '正文和产物说明已经生成。' };
      yield {
        type: 'done',
        result: {
          text: '',
          content: [],
          meta: {
            durationMs: 25,
            model: 'mock-model',
            provider: 'mock-provider',
            stopReason: 'error',
            usage: { inputTokens: 1, outputTokens: 8, totalTokens: 9 },
            error: { kind: 'provider_error', message: 'fetch failed', code: 'PROVIDER_NETWORK' },
          },
        },
      };
    })();

    const client = await import('../../../../src/main/model/core-agent/client');
    const result = await client.chatWithModel({
      userId: 'u1',
      message: 'hi',
      sessionId: 'gconv-partial-provider-network',
    });

    expect(result).toMatchObject({
      ok: false,
      text: '正文和产物说明已经生成。',
      aborted: false,
    });
    expect(result.error).not.toBe('');
  });

  it('SHORT model-stream window catches a stream that started then stalled (no long wait)', async () => {
    // Stream emits one delta, then goes silent. After the first text event, the
    // model-stream phase uses streamIdleTimeout (0.3s), NOT idleTimeout (10s).
    h.makeStream = () =>
      (async function* () {
        yield { type: 'text_delta', text: 'partial answer' };
        yield { type: 'text_phase', phase: 'final_answer' };
        await new Promise(() => {}); // silent stall
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.3, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    const failure = events.find((e) => e.type === 'error');
    expect(failure?.text || '').toMatch(/no progress/i);
    expect(failure).toMatchObject({
      failureKind: 'model',
      failureCode: 'idle_timeout',
    });
    // Fired on the 0.3s short window, not the 10s long one.
    expect(ms).toBeLessThan(3000);
  }, 8000);

  it('TOOL phase is NOT false-killed by the short window (long/silent tool survives)', async () => {
    // A tool runs 0.6s with NO heartbeat — longer than the 0.2s short window but
    // under the 10s long window. toolDepth>0 must keep the long window in force.
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_start', id: 't1', name: 'bash', input: {} };
        await delay(600);
        yield { type: 'tool_end', id: 't1', name: 'bash', result: 'downloaded', isError: false };
        yield { type: 'text_delta', text: 'done downloading' };
        yield { type: 'text_phase', phase: 'final_answer' };
        yield completedEvent('done downloading');
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('final');
    expect(events.find((e) => e.type === 'final')?.text || '').toContain('done downloading');
    // No idle timeout fired — the tool outlived the short window unharmed.
    expect(events.some((e) => e.type === 'error' && /no response|exceeded/i.test(e.text || ''))).toBe(false);
    expect(types[types.length - 1]).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(550);
  }, 8000);

  it('tool-phase backstop stays behind the recoverable per-tool watchdog it configures', async () => {
    // Production regression: both watchdogs shared the same 1800s deadline, so
    // the session timer won and killed the whole turn instead of letting the
    // per-tool watchdog return one recoverable tool error. The host must pass
    // the base timeout to the runtime and keep its own backstop strictly later.
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_start', id: 't1', name: 'video_studio', input: {} };
        await new Promise(() => {}); // tool never returns and never heartbeats
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 2 });
    expect(h.lastBuildRunnerParams?.toolIdleTimeoutMs).toBe(2000);
    const failure = events.find((event) => event.type === 'error');
    expect(failure).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool',
    });
    // The mocked runner cannot emit its own tool-stall result, so the host
    // fallback fires at 2.3s (2s x 1.15), not at the shared 2s deadline.
    expect(failure?.text || '').toContain('2.3');
    expect(ms).toBeGreaterThanOrEqual(2200);
    expect(events.map((event) => event.type).at(-1)).toBe('done');
  }, 10000);

  it('keeps the tool-phase backstop strictly later at a sub-centisecond boundary', async () => {
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_start', id: 't1', name: 'video_studio', input: {} };
        await new Promise(() => {});
      })();

    const { events } = await drain({ streamIdleTimeout: 0.001, idleTimeout: 0.01 });
    expect(h.lastBuildRunnerParams?.toolIdleTimeoutMs).toBe(10);
    const failure = events.find((event) => event.type === 'error');
    expect(failure).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool',
    });
    // A 10 ms runtime watchdog gets a 12 ms host backstop. The previous
    // centisecond rounding collapsed both deadlines to the same 10 ms value.
    expect(failure?.text || '').toContain('0.012');
    expect(events.map((event) => event.type).at(-1)).toBe('done');
  });

  it('does not stack a Commander watchdog on an executor-owned delegation', async () => {
    h.makeStream = () =>
      (async function* () {
        yield {
          type: 'tool_start',
          id: 'delegated-1',
          name: 'dispatch_to',
          input: {},
          executionTimeoutOwner: 'executor',
        };
        await delay(80);
        yield { type: 'tool_end', id: 'delegated-1', name: 'dispatch_to', result: 'agent done', isError: false };
        yield { type: 'text_delta', text: 'continued after agent result' };
        yield { type: 'text_phase', phase: 'final_answer' };
        yield completedEvent('continued after agent result');
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.01, idleTimeout: 0.03 });
    expect(events.find((event) => event.type === 'final')?.text || '')
      .toContain('continued after agent result');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(70);
  });

  it('re-arms the provider watchdog after an executor-owned delegation returns', async () => {
    h.makeStream = () =>
      (async function* () {
        yield {
          type: 'tool_start',
          id: 'delegated-1',
          name: 'run_worker',
          input: {},
          executionTimeoutOwner: 'executor',
        };
        yield { type: 'tool_end', id: 'delegated-1', name: 'run_worker', result: 'worker done', isError: false };
        await new Promise(() => {});
      })();

    const { events } = await drain({ streamIdleTimeout: 0.01, idleTimeout: 0.03 });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'provider_wait',
    });
  });

  it('keeps the Commander backstop when an ordinary tool runs beside a delegation', async () => {
    h.makeStream = () =>
      (async function* () {
        yield {
          type: 'tool_start',
          id: 'delegated-1',
          name: 'dispatch_to',
          input: {},
          executionTimeoutOwner: 'executor',
        };
        yield { type: 'tool_start', id: 'ordinary-1', name: 'bash', input: {} };
        await new Promise(() => {});
      })();

    const { events } = await drain({ streamIdleTimeout: 0.01, idleTimeout: 0.03 });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool',
    });
  });

  it('post-tool model thinking is NOT false-killed by the short window', async () => {
    // Once a tool finishes, the next provider call can legitimately spend a
    // while thinking before the first text token. That post-tool cold-start
    // gap should use the long idle window until text starts streaming again.
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_start', id: 't1', name: 'bash', input: {} };
        yield { type: 'tool_end', id: 't1', name: 'bash', result: 'downloaded', isError: false };
        await delay(600);
        yield { type: 'text_delta', text: 'final answer after thinking' };
        yield { type: 'text_phase', phase: 'final_answer' };
        yield completedEvent('final answer after thinking');
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('final');
    expect(events.find((e) => e.type === 'final')?.text || '').toContain('final answer after thinking');
    expect(events.some((e) => e.type === 'error' && /no response|exceeded/i.test(e.text || ''))).toBe(false);
    expect(types[types.length - 1]).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(550);
  }, 8000);

  it('tool-call argument assembly is NOT false-killed by the short model window', async () => {
    // A large write_file call can emit tool input before core-agent has the
    // complete JSON needed for tool_start. That raw tool_delta may not map to a
    // visible UI event yet, but it is still provider activity and should switch
    // the watchdog to the long window.
    h.makeStream = () =>
      (async function* () {
        yield { type: 'text_delta', text: 'drafting file' };
        yield { type: 'tool_delta', id: 't1', name: 'write_file', inputDelta: '', inputBytes: 0 };
        await delay(600);
        yield {
          type: 'tool_start',
          id: 't1',
          name: 'write_file',
          input: { path: 'composition/index.html', content: '<html></html>' },
        };
        yield { type: 'tool_end', id: 't1', name: 'write_file', result: 'ok', isError: false };
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'text_phase', phase: 'final_answer' };
        yield completedEvent('done');
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('final');
    expect(events.find((e) => e.type === 'final')?.text || '').toContain('done');
    expect(events.some((e) => e.type === 'error' && /no response|exceeded/i.test(e.text || ''))).toBe(false);
    expect(types[types.length - 1]).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(550);
  }, 8000);

  it('clamps the tool-input deadline to the caller\'s smaller global idle bound', async () => {
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_delta', id: 't1', name: 'write_file', inputDelta: '{', inputBytes: 1 };
        await new Promise(() => {});
      })();

    const { events } = await drain({ streamIdleTimeout: 0.01, idleTimeout: 0.1 });
    const failure = events.find((event) => event.type === 'error');
    expect(failure).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool_input',
    });
    // The independent default is 600s, but the caller's 100ms outer bound wins.
    expect(failure?.text || '').toContain('0.1s');
    expect(events.map((event) => event.type).at(-1)).toBe('done');
  });

  it('uses the independent tool-input deadline and renews it on each argument delta', async () => {
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_delta', id: 't1', name: 'write_file', inputDelta: '{', inputBytes: 1 };
        await delay(60);
        yield { type: 'tool_delta', id: 't1', name: 'write_file', inputDelta: '"path"', inputBytes: 6 };
        await new Promise(() => {});
      })();

    const { events, ms } = await drain({
      streamIdleTimeout: 0.01,
      idleTimeout: 1,
      toolInputIdleTimeout: 0.1,
    });
    const failure = events.find((event) => event.type === 'error');
    expect(failure).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool_input',
    });
    expect(failure?.text || '').toContain('0.1s');
    // Total duration exceeds one window because the second delta renewed it.
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(800);
    expect(events.map((event) => event.type).at(-1)).toBe('done');
  });

  it('does not renew the tool-input deadline for unrelated provider events', async () => {
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_delta', id: 't1', name: 'write_file', inputDelta: '{', inputBytes: 1 };
        await delay(200);
        yield { type: 'thinking', text: 'unrelated reasoning event' };
        await new Promise(() => {});
      })();

    const { events, ms } = await drain({
      streamIdleTimeout: 0.01,
      idleTimeout: 2,
      toolInputIdleTimeout: 0.4,
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool_input',
    });
    // The thinking event at 200ms must not push a 400ms no-delta deadline to
    // roughly 600ms. Keep enough scheduling margin for loaded CI hosts.
    expect(ms).toBeGreaterThanOrEqual(340);
    expect(ms).toBeLessThan(550);
  });

  it('a fully silent (cold-start) stall still terminates cleanly — no wedge', async () => {
    // Regression guard for the main-side wedge: even with ZERO events the turn
    // must yield a terminal error + done and the generator must RETURN.
    h.makeStream = () =>
      (async function* () {
        await new Promise(() => {});
        yield { type: 'done' }; // unreachable
      })();

    const { events } = await drain({ streamIdleTimeout: 5, idleTimeout: 0.3 });
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
  }, 8000);

  it('tool-phase backstop widens beyond the per-tool watchdog it forwards', async () => {
    // 2026-08-22 turn kill: the session watchdog and core-agent's per-tool
    // stall watchdog shared the exact same 1800s window, and the session one
    // won the race — one stalled video render killed the whole turn instead
    // of failing as a recoverable tool error. The session tool tier must
    // (a) forward the per-tool window derived from the same idleTimeout and
    // (b) itself fire strictly later, so the per-tool watchdog always owns
    // first detection.
    h.makeStream = () =>
      (async function* () {
        yield { type: 'tool_start', id: 't1', name: 'video_studio', input: {} };
        await new Promise(() => {}); // tool never returns and never heartbeats
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 2 });
    expect(h.lastBuildRunnerParams?.toolIdleTimeoutMs).toBe(2000);
    const failure = events.find((event) => event.type === 'error');
    expect(failure).toMatchObject({
      failureCode: 'idle_timeout',
      failurePhase: 'tool',
    });
    // Fired on the widened 2.3s backstop (2s × 1.15), not the base 2s window.
    expect(failure?.text || '').toContain('2.3');
    expect(ms).toBeGreaterThanOrEqual(2200);
    expect(events.map((event) => event.type).at(-1)).toBe('done');
  }, 10000);

  it('the provider-wait middle tier fires long before the tool backstop window', async () => {
    // A dead stream in the provider-wait phase (zero events) must be detected
    // by the middle tier, not sit out the long tool-phase backstop.
    h.makeStream = () =>
      (async function* () {
        await new Promise(() => {});
        yield { type: 'done' }; // unreachable
      })();

    const { events, ms } = await drain({
      streamIdleTimeout: 5,
      idleTimeout: 10,
      providerWaitIdleTimeout: 0.3,
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    expect(ms).toBeLessThan(5000);
  }, 8000);

  it('thinking heartbeats keep the provider-wait middle window alive', async () => {
    // Total silent-reasoning time far exceeds the middle window, but every
    // thinking delta resets the watchdog — slow reasoning must complete, only
    // a stream with ZERO events for the whole window is treated as dead.
    h.makeStream = () =>
      (async function* () {
        for (let i = 0; i < 6; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          yield { type: 'thinking', text: `step ${i}` };
        }
        yield { type: 'text_delta', text: 'done thinking' };
        yield {
          type: 'done',
          result: {
            text: 'done thinking',
            content: [{ type: 'text', text: 'done thinking' }],
            meta: {
              durationMs: 1,
              model: 'mock-model',
              provider: 'mock-provider',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
        };
      })();

    const { events } = await drain({
      streamIdleTimeout: 5,
      idleTimeout: 10,
      providerWaitIdleTimeout: 0.4,
    });
    const types = events.map((e) => e.type);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(types).toContain('final');
    expect(types[types.length - 1]).toBe('done');
  }, 8000);

  it('reports a live phase snapshot when the user aborts before runner done metadata', async () => {
    const controller = new AbortController();
    h.makeStream = () =>
      (async function* () {
        yield {
          type: 'tool_start',
          id: 't1',
          name: 'dispatch_to',
          input: {},
          executionTimeoutOwner: 'executor',
        };
        await new Promise(() => {});
      })();
    setTimeout(() => controller.abort(), 80);

    const { events } = await drain({ abortSignal: controller.signal, idleTimeout: 10 });
    const result = events.find((event) => event.event?.stream === 'agent_run_result')?.event?.data;
    expect(result).toMatchObject({
      result: 'aborted',
      failure_phase: 'tool',
      provider_ms: expect.any(Number),
      tool_ms: expect.any(Number),
      compaction_ms: expect.any(Number),
      retry_wait_ms: expect.any(Number),
      other_ms: expect.any(Number),
    });
    expect(Number(result?.tool_ms)).toBeGreaterThan(0);
  }, 8000);

  it('forwards maxToolLoops to buildRunner when set (commander policy), omits it otherwise', async () => {
    const quick = () => (async function* () { yield { type: 'text_delta', text: 'ok' }; })();

    h.makeStream = quick;
    h.lastBuildRunnerParams = null;
    await drain({ maxToolLoops: 120 });
    expect(h.lastBuildRunnerParams?.maxToolLoops).toBe(120);

    h.makeStream = quick;
    h.lastBuildRunnerParams = null;
    await drain({});
    expect(h.lastBuildRunnerParams?.maxToolLoops).toBeUndefined();
  }, 8000);

  it('forwards attachment metadata used by conditional OCR tool exposure', async () => {
    h.makeStream = () => (async function* () { yield { type: 'text_delta', text: 'ok' }; })();
    h.lastBuildRunnerParams = null;

    await drain({
      attachmentMetadata: {
        hasAttachments: true,
        attachmentTypes: ['image'],
      },
    });

    expect(h.lastBuildRunnerParams?.attachmentMetadata).toEqual({
      hasAttachments: true,
      attachmentTypes: ['image'],
    });
  }, 8000);

  it('forwards the host-owned system skill allowlist to buildRunner', async () => {
    h.makeStream = () => (async function* () { yield { type: 'text_delta', text: 'ok' }; })();
    h.lastBuildRunnerParams = null;

    await drain({ systemSkillList: ['skill-creator', 'package-installer'] });

    expect(h.lastBuildRunnerParams?.systemSkillList).toEqual([
      'skill-creator',
      'package-installer',
    ]);
  }, 8000);

  it('does not serialize identical session ids that belong to different accounts', async () => {
    const bothStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let starts = 0;
    h.makeStream = () =>
      (async function* () {
        starts += 1;
        if (starts === 2) bothStarted.resolve();
        await release.promise;
        yield { type: 'text_delta', text: 'ok' };
      })();

    const first = drain({ userId: 'account-a', sessionId: 'gconv-shared-lock' });
    const second = drain({ userId: 'account-b', sessionId: 'gconv-shared-lock' });
    let startError: Error | null = null;
    try {
      await Promise.race([
        bothStarted.promise,
        delay(500).then(() => { throw new Error('second account was blocked by the first account session lock'); }),
      ]);
    } catch (error) {
      startError = error as Error;
    } finally {
      release.resolve();
    }
    await Promise.all([first, second]);

    if (startError) throw startError;
    expect(starts).toBe(2);
  }, 8000);

  it('aborts only the requested account when two accounts have the same conversation id', async () => {
    const bothStarted = Promise.withResolvers<void>();
    let starts = 0;
    h.makeStream = () =>
      (async function* () {
        starts += 1;
        if (starts === 2) bothStarted.resolve();
        await new Promise(() => {});
      })();

    const first = drain({ userId: 'account-a', sessionId: 'gconv-shared-abort', cid: 'shared-abort' });
    let secondSettled = false;
    const second = drain({ userId: 'account-b', sessionId: 'gconv-shared-abort', cid: 'shared-abort' })
      .finally(() => { secondSettled = true; });
    await bothStarted.promise;

    const client = await import('../../../../src/main/model/core-agent/client');
    const firstAbortCount = client.abortActiveSessionsForConversation('shared-abort', 'account-a');
    await first;
    await delay(20);
    const secondWasStillRunning = !secondSettled;
    const secondAbortCount = client.abortActiveSessionsForConversation('shared-abort', 'account-b');
    await second;

    expect(firstAbortCount).toBe(1);
    expect(secondWasStillRunning).toBe(true);
    expect(secondAbortCount).toBe(1);
  }, 8000);
});

describe('streamChatWithModel — post-run ephemeral session eviction', () => {
  it('evicts the run session after the post-turn heal lookup', async () => {
    h.makeStream = () => (async function* () { yield { type: 'text_delta', text: 'ok' }; })();

    await drain({ sessionId: 'anon-evictwire1' });

    const healIdx = h.sessionStoreCalls.indexOf('getSessionForUser:u1:anon-evictwire1');
    const evictIdx = h.sessionStoreCalls.indexOf('evictEphemeral:u1:anon-evictwire1');
    expect(evictIdx, `calls: ${JSON.stringify(h.sessionStoreCalls)}`).toBeGreaterThanOrEqual(0);
    expect(healIdx).toBeGreaterThanOrEqual(0);
    expect(evictIdx).toBeGreaterThan(healIdx);
  }, 8000);
});
