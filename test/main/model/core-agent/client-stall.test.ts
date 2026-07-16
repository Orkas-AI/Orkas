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

async function drain(opts: Record<string, unknown>): Promise<{ events: Array<{ type: string; text?: string }>; ms: number }> {
  const client = await import('../../../../src/main/model/core-agent/client');
  const events: Array<{ type: string; text?: string }> = [];
  const start = Date.now();
  for await (const ev of client.streamChatWithModel({
    userId: 'u1',
    message: 'hi',
    sessionId: 'gconv-stalltest',
    ...opts,
  } as Parameters<typeof client.streamChatWithModel>[0])) {
    events.push(ev as { type: string; text?: string });
  }
  return { events, ms: Date.now() - start };
}

describe('streamChatWithModel — phase-aware idle watchdog (Phase 1)', () => {
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
    expect(events.find((e) => e.type === 'error')?.text || '').toMatch(/no response|exceeded/i);
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
});
