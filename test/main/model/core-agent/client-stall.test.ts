import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Phase 1 (long-task-streaming-reliability): the model-stream idle watchdog is
// phase-aware. While the MODEL is actively streaming text (no tool in flight)
// it uses the SHORT `streamIdleTimeout` so a stream that started then went
// silent recovers fast; while a TOOL is executing, on cold start, and after a
// tool has finished but before the next text delta, it uses the long
// `idleTimeout` so long/silent thinking and downloads are not
// false-killed. Either way the turn must terminate cleanly (yield error/final +
// done and RETURN — no wedge), so the bus worker can run its finally and accept
// the next message.

const h = vi.hoisted(() => ({
  makeStream: null as null | (() => AsyncGenerator),
  lastBuildRunnerParams: null as null | Record<string, unknown>,
  runStreamCalls: 0,
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
    runner: { runStream: () => {
      h.runStreamCalls += 1;
      h.lastBuildRunnerParams = params;
      return h.makeStream!();
    } },
    resolvedSystemPrompt: 'sys',
    entryId: 'e1',
    profileId: 'p1',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    toolDefs: [],
    skillDisplayNameById: {},
    agentDisplayNameById: {},
  }),
}));

vi.mock('../../../../src/main/model/core-agent/session-store', () => ({
  getSession: async () => null,
  getSessionForUser: async () => null,
  // client.ts logs the session kind on every stream; without this export the
  // whole suite dies on an unmocked call rather than on anything it tests.
  sessionKindOf: (sessionId: string) => String(sessionId || '').split('-')[0] || '',
}));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-client-stall-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  h.runStreamCalls = 0;
});

afterEach(() => {
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
        await new Promise(() => {}); // silent stall
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.3, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    const failure = events.find((e) => e.type === 'error');
    expect(failure?.text || '').toMatch(/no response|exceeded/i);
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
      })();

    const { events, ms } = await drain({ streamIdleTimeout: 0.2, idleTimeout: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain('final');
    expect(events.find((e) => e.type === 'final')?.text || '').toContain('done');
    expect(events.some((e) => e.type === 'error' && /no response|exceeded/i.test(e.text || ''))).toBe(false);
    expect(types[types.length - 1]).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(550);
  }, 8000);

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
