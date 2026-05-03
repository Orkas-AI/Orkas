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
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRunner() {
  return import('../../../../src/main/features/local_agents/runner');
}

describe('local_agents/runner', () => {
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
    expect(result.runId).toBe(''); // no persistence for missing
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
