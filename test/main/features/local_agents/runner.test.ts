import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mocks must be declared at top-level for vi to hoist them. The
// registry mock keeps real exports but swaps `detectOne`; the claude
// backend is fully replaced by a controllable stub.
const mockDetect = vi.fn<[string], Promise<any>>();
vi.mock('../../../../src/main/features/local_agents/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/local_agents/registry')>();
  return {
    ...actual,
    detectOne: (type: string) => mockDetect(type),
  };
});

let mockBackendImpl: ((opts: any) => Promise<void>) | null = null;
vi.mock('../../../../src/main/features/local_agents/backends/claude', () => ({
  claudeBackend: {
    run: (opts: any) => (mockBackendImpl ? mockBackendImpl(opts) : Promise.resolve()),
  },
}));

let mockOpenclawBackendImpl: ((opts: any) => Promise<void>) | null = null;
vi.mock('../../../../src/main/features/local_agents/backends/openclaw', () => ({
  openclawBackend: {
    run: (opts: any) => (mockOpenclawBackendImpl ? mockOpenclawBackendImpl(opts) : Promise.resolve()),
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runner-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  mockDetect.mockReset();
  mockBackendImpl = null;
  mockOpenclawBackendImpl = null;
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRunner() {
  return import('../../../../src/main/features/local_agents/runner');
}

describe('local_agents/runner', () => {
  it('builds local agent log context without raw prompts, args, resume ids, or paths', async () => {
    const runner = await loadRunner();
    const ctx = runner.localAgentRunContextForLog({
      uid: 'user-secret-123456789',
      cid: 'conversation-private-abcdef',
      agentId: 'agent-private-abcdef',
      projectId: 'project-private-abcdef',
      cli: 'claude',
      model: 'claude-test',
      customArgs: ['--token', 'super-secret-token'],
      resumeSessionId: 'resume-private-session-id',
      prompt: 'private prompt body',
      cwd: '/Users/test/Secret Workspace',
      runId: 'abcdef123456',
      cliAvailable: true,
      cliVersion: '2.0.0',
      bridgeSupported: true,
      timeoutMs: 1000,
      idleKillMs: 500,
      idleMs: 100,
    });

    expect(ctx.prompt_chars).toBe('private prompt body'.length);
    expect(ctx.custom_arg_count).toBe(2);
    expect(ctx.has_resume_session).toBe(true);
    expect(ctx.has_cwd).toBe(true);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('private prompt body');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('resume-private-session-id');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('Secret Workspace');
    expect(serialized).not.toContain('conversation-private');
    expect(serialized).not.toContain('agent-private');
  });

  it('summarizes local agent events without raw stdout, stderr, tool output, or file paths', async () => {
    const runner = await loadRunner();
    const stats = runner.createLocalAgentRunLogDiagnostics(1000);

    runner.recordLocalAgentEventForLog(stats, {
      type: 'process-info',
      pid: 42,
      cwd: '/Users/test/Secret Workspace',
      cmd: 'claude',
      args: ['--api-key', 'super-secret-token'],
    }, 1010);
    runner.recordLocalAgentEventForLog(stats, { type: 'text-delta', text: 'private answer text' }, 1100);
    runner.recordLocalAgentEventForLog(stats, { type: 'thinking', text: 'private chain text' }, 1110);
    runner.recordLocalAgentEventForLog(stats, { type: 'stderr-line', line: 'stderr with private path /Users/test/x' }, 1120);
    runner.recordLocalAgentEventForLog(stats, { type: 'raw-line', line: 'raw private protocol body' }, 1130);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'tool-event',
      tool: 'bash',
      callId: 'local-secret-123456',
      phase: 'use',
      input: { command: 'cat /Users/test/private.txt' },
    }, 1140);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'tool-event',
      tool: 'bash',
      callId: 'local-secret-123456',
      phase: 'result',
      isError: true,
      output: 'private tool output',
      outputPath: '/Users/test/private-output.txt',
    }, 1150);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'tool-event',
      tool: 'read_file',
      callId: 'local-secret-abcdef',
      phase: 'use',
      input: { path: '/Users/test/other.txt' },
    }, 1155);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'tool-event',
      tool: 'read_file',
      callId: 'local-secret-abcdef',
      phase: 'result',
      output: 'second private tool output',
    }, 1158);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'permission-request',
      tool: 'bash',
      input: { command: 'rm private.txt' },
      autoDecided: 'deny',
    }, 1160);
    runner.recordLocalAgentEventForLog(stats, {
      type: 'file-change',
      paths: ['/Users/test/private.txt', '/Users/test/other.txt'],
    }, 1170);
    runner.recordLocalAgentEventForLog(stats, { type: 'status', status: 'usage', usage: { input: 5, output: 7, secretText: 'nope' } }, 1180);
    runner.recordLocalAgentEventForLog(stats, { type: 'done', status: 'completed', output: 'private final', usage: { input: 5, output: 8 } }, 1200);

    const summary = runner.summarizeLocalAgentRunForLog(stats, 1300);
    expect(summary.eventCount).toBe(13);
    expect(summary.textDeltaChars).toBe('private answer text'.length);
    expect(summary.stderrLines).toBe(1);
    expect(summary.rawLines).toBe(1);
    expect(summary.toolEvents).toBe(4);
    expect(summary.toolResultEvents).toBe(2);
    expect(summary.spilledToolResults).toBe(1);
    expect(summary.fileChangePathCount).toBe(2);
    expect(summary.permissionAutoDeny).toBe(1);
    expect(summary.usage).toMatchObject({ input: 5, output: 8 });
    expect(summary.toolTimeline).toEqual([
      '#1 +140ms bash use call=loca...3456',
      `#2 +150ms bash result call=loca...3456 error=true output_chars=${'private tool output'.length} spilled=true`,
      '#3 +155ms read_file use call=loca...cdef',
      `#4 +158ms read_file result call=loca...cdef output_chars=${'second private tool output'.length} spilled=false`,
    ]);
    expect(summary.toolTimelineTruncated).toBe(0);
    expect(summary.eventTimeline).toEqual([
      '#1 +10ms process_info pid=42',
      `#2 +100ms text_delta chars=${'private answer text'.length}`,
      `#3 +110ms thinking chars=${'private chain text'.length}`,
      `#4 +120ms stderr_line chars=${'stderr with private path /Users/test/x'.length}`,
      `#5 +130ms raw_line chars=${'raw private protocol body'.length}`,
      '#6 +140ms tool_event tool=bash phase=use',
      '#7 +150ms tool_event tool=bash phase=result',
      '#8 +155ms tool_event tool=read_file phase=use',
      '#9 +158ms tool_event tool=read_file phase=result',
      '#10 +160ms permission_request tool=bash auto=deny',
      '#11 +170ms file_change paths=2',
      '#12 +180ms status status=usage',
      '#13 +200ms done status=completed error=false',
    ]);
    expect(summary.eventTimelineTruncated).toBe(0);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('private answer text');
    expect(serialized).not.toContain('private chain text');
    expect(serialized).not.toContain('stderr with private path');
    expect(serialized).not.toContain('raw private protocol body');
    expect(serialized).not.toContain('cat /Users');
    expect(serialized).not.toContain('private tool output');
    expect(serialized).not.toContain('second private tool output');
    expect(serialized).not.toContain('private final');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('secretText');
    expect(serialized).not.toContain('local-secret-123456');
    expect(serialized).not.toContain('local-secret-abcdef');
  });

  it('emits missing_cli when registry reports unavailable', async () => {
    mockDetect.mockResolvedValue({
      type: 'claude', available: false, path: null, version: null,
      error: 'not_found', errorDetail: 'no claude on PATH',
    });
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'hi', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('missing_cli');
    const done = events.find(e => e.type === 'done');
    expect(done?.status).toBe('missing_cli');
    expect(done?.error).toMatch(/no claude on PATH/);
    expect(done?.cliError).toBe('not_found');
    expect(result.cliError).toBe('not_found');
    expect(result.runId).toBe(''); // no persistence for missing
  });

  it('preserves recognition details when the CLI exists but its version cannot be read', async () => {
    mockDetect.mockResolvedValue({
      type: 'claude', available: false, path: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd', version: null,
      error: 'version_unknown', errorDetail: 'version output could not be parsed',
    });
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'hi', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(result).toMatchObject({
      status: 'missing_cli',
      cliError: 'version_unknown',
      cliPath: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      cliError: 'version_unknown',
      cliPath: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
    });
  });

  it('persists prompt + events.jsonl + meta.json on a completed run', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({ type: 'process-info', pid: 42, cwd: '/x', cmd: 'claude', args: [] });
      onEvent({ type: 'text-delta', text: 'hello ' });
      onEvent({ type: 'text-delta', text: 'world' });
      onEvent({ type: 'done', status: 'completed', output: 'hello world', durationMs: 12 });
    };
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'agent-x',
      cli: 'claude', prompt: 'do work', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello world');
    expect(result.runId).toMatch(/^[0-9a-f]{12}$/);

    const dir = path.join(tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8')).toBe('do work');
    const eventLines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(eventLines.length).toBe(4);
    expect(JSON.parse(eventLines[0]).type).toBe('process-info');
    expect(JSON.parse(eventLines[3]).type).toBe('done');
    expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('hello world');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.status).toBe('completed');
    expect(meta.cli).toBe('claude');
    expect(meta.cliPath).toBe('/fake/claude');
    expect(meta.endedAt).toBeTruthy();
  });

  it('reports backend exception as a failed done event', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async () => { throw new Error('spawn went sideways'); };
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('failed');
    const done = events.find(e => e.type === 'done');
    expect(done?.error).toMatch(/spawn went sideways/);
  });

  it('falls back to a synthetic failed done when backend exits without one', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async () => { /* no events at all */ };
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('failed');
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('forwards AbortSignal — backend reports cancelled, runner relays', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ signal, onEvent }) => {
      onEvent({ type: 'process-info', pid: 1, cwd: '/x', cmd: 'claude', args: [] });
      // Simulate abort midway: when the signal fires, emit done(cancelled).
      await new Promise<void>(resolve => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      onEvent({ type: 'done', status: 'cancelled', durationMs: 5 });
    };
    const ac = new AbortController();
    const events: any[] = [];
    const promise = (await import('../../../../src/main/features/local_agents/runner')).run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: ac.signal,
      onEvent: e => events.push(e),
    });
    setTimeout(() => ac.abort(), 10);
    const result = await promise;
    expect(result.status).toBe('cancelled');
    const meta = JSON.parse(fs.readFileSync(path.join(
      tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId, 'meta.json',
    ), 'utf8'));
    expect(meta.status).toBe('cancelled');
  });

  it('records timeout terminal status when backend reports it', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent, timeoutMs }) => {
      // Backend honors timeoutMs internally; here we simulate it firing.
      expect(timeoutMs).toBeGreaterThan(0);
      onEvent({ type: 'done', status: 'timeout', error: 'cli exceeded timeout', durationMs: timeoutMs });
    };
    const events: any[] = [];
    const result = await (await import('../../../../src/main/features/local_agents/runner')).run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('timeout');
    expect(result.error).toMatch(/timeout/);
  });

  it('uses a long wall cap and no idle kill for OpenClaw no-stream runs', async () => {
    mockDetect.mockResolvedValue({ type: 'openclaw', available: true, path: '/fake/openclaw', version: '2026.4.11' });
    let captured: any = null;
    mockOpenclawBackendImpl = async (opts) => {
      captured = opts;
      opts.onEvent({ type: 'done', status: 'completed', output: '', durationMs: 0 });
    };

    const events: any[] = [];
    const result = await (await import('../../../../src/main/features/local_agents/runner')).run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'openclaw', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(result.status).toBe('completed');
    expect(captured?.timeoutMs).toBe(60 * 60 * 1000);
    expect(captured?.idleKillMs).toBeUndefined();
    expect(captured?.idleMs).toBe(90 * 1000);
  });

  it('emits idle events when the backend goes quiet beyond the threshold', async () => {
    // Use real timers but shrink the threshold via env vars. The
    // ORKAS_LOCAL_AGENT_IDLE_MIN_MS escape hatch exists exactly so
    // unit tests can exercise the heartbeat at ~100ms rather than
    // the 30s production floor.
    const prevIdleMs = process.env.ORKAS_LOCAL_AGENT_IDLE_MS;
    const prevIdleMin = process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS;
    process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS = '50';
    process.env.ORKAS_LOCAL_AGENT_IDLE_MS = '120';   // threshold 120ms
    try {
      mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
      let onEventCb: ((e: any) => void) | null = null;
      let resolveBackend!: () => void;
      mockBackendImpl = async ({ onEvent }) => {
        onEventCb = onEvent;
        onEvent({ type: 'process-info', pid: 42, cwd: '/x', cmd: 'claude', args: [] });
        await new Promise<void>(resolve => { resolveBackend = resolve; });
        onEvent({ type: 'done', status: 'completed', output: '', durationMs: 0 });
      };

      const runner = await loadRunner();
      const events: any[] = [];
      const promise = runner.run({
        uid: TEST_UID, cid: 'c', agentId: 'a',
        cli: 'claude', prompt: 'p', cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: e => events.push(e),
      });

      // Threshold=120ms, tick = max(50, 120/3=40) → 50ms. Wait ~250ms:
      // at least 2 idle pulses should fire after the 120ms quiet period.
      await new Promise(r => setTimeout(r, 250));
      const idleCount1 = events.filter(e => e.type === 'idle').length;
      expect(idleCount1).toBeGreaterThanOrEqual(1);

      // Continue waiting → steady drumbeat (more idle events).
      await new Promise(r => setTimeout(r, 150));
      const idleCount2 = events.filter(e => e.type === 'idle').length;
      expect(idleCount2).toBeGreaterThan(idleCount1);

      // Backend emits a real event — deadline should reset, so no new
      // idle pulse during the next sub-threshold window.
      onEventCb!({ type: 'text-delta', text: 'still here' });
      const beforeReset = events.filter(e => e.type === 'idle').length;
      await new Promise(r => setTimeout(r, 80));  // less than 120ms threshold
      const afterReset = events.filter(e => e.type === 'idle').length;
      expect(afterReset).toBe(beforeReset);  // no new idle fired

      resolveBackend();
      await promise;
    } finally {
      if (prevIdleMs === undefined) delete process.env.ORKAS_LOCAL_AGENT_IDLE_MS;
      else process.env.ORKAS_LOCAL_AGENT_IDLE_MS = prevIdleMs;
      if (prevIdleMin === undefined) delete process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS;
      else process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS = prevIdleMin;
    }
  });

  it('spills oversized tool-event results to disk and rewrites output + outputPath', async () => {
    const { PERSIST_THRESHOLD } = await import('../../../../src/main/util/tool-result-cap');
    const big = 'X'.repeat(PERSIST_THRESHOLD + 200);
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({ type: 'process-info', pid: 1, cwd: '/x', cmd: 'claude', args: [] });
      // Tool-event with massive output — the runner must intercept and
      // spill this before it lands in events.jsonl or reaches the caller.
      onEvent({
        type: 'tool-event', tool: 'bash', callId: 'c1', phase: 'result', output: big,
      });
      onEvent({ type: 'done', status: 'completed', output: '', durationMs: 0 });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('completed');

    const toolEvent = events.find(e => e.type === 'tool-event' && e.phase === 'result');
    expect(toolEvent).toBeDefined();
    expect(toolEvent.outputPath).toBeTruthy();
    expect(typeof toolEvent.output).toBe('string');
    // Output is now the preview marker, not the full payload.
    expect(toolEvent.output.length).toBeLessThan(big.length);
    expect(toolEvent.output).toMatch(/<persisted-output/);
    // The full content is on disk at the reported path.
    expect(fs.existsSync(toolEvent.outputPath)).toBe(true);
    expect(fs.readFileSync(toolEvent.outputPath, 'utf8')).toBe(big);
    // Spill landed under the expected per-session directory shape:
    // <uid>/local/tool-results/cli-claude-<runId>/bash.<id>.txt (CLAUDE.md §5 — session_id
    // dropped uid prefix; user scoping comes from path root, not the filename)
    expect(toolEvent.outputPath).toContain(`cli-claude-${result.runId}`);
    expect(toolEvent.outputPath).toMatch(/bash\.[0-9a-f]+\.txt$/);
  });

  it('does not spill small tool-event outputs', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({ type: 'tool-event', tool: 'bash', callId: 'c1', phase: 'result', output: 'small output' });
      onEvent({ type: 'done', status: 'completed', output: '', durationMs: 0 });
    };
    const runner = await loadRunner();
    const events: any[] = [];
    await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    const toolEvent = events.find(e => e.type === 'tool-event' && e.phase === 'result');
    expect(toolEvent.output).toBe('small output');
    expect(toolEvent.outputPath).toBeUndefined();
  });

  it('rejects unregistered CLI types cleanly', async () => {
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      // 'kimi' is a known type name but not registered yet (kept out of
      // v1 backends on purpose). Any future addition needs the test
      // pointed at a fresher placeholder.
      cli: 'kimi' as any, prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/not implemented/);
  });
});
