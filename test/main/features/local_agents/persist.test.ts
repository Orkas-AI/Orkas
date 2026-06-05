import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-persist';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-agent-persist-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPersist() {
  return import('../../../../src/main/features/local_agents/persist');
}

describe('local_agents/persist', () => {
  it('creates run files, appends events/output, and finalizes meta', async () => {
    const persist = await loadPersist();

    const handle = await persist.start(TEST_UID, {
      agentId: 'agent-1',
      cid: 'conv-1',
      cli: 'claude',
      cliPath: '/fake/claude',
      model: 'claude-opus-4-7',
      prompt: 'write tests',
    });

    expect(handle.runId).toMatch(/^[0-9a-f]{12}$/);
    expect(fs.readFileSync(handle.promptPath, 'utf8')).toBe('write tests');
    expect(fs.readFileSync(handle.eventsPath, 'utf8')).toBe('');
    expect(fs.readFileSync(handle.outputPath, 'utf8')).toBe('');

    persist.append(handle, { type: 'process-info', pid: 123, cwd: '/tmp', cmd: 'claude', args: [] });
    persist.append(handle, { type: 'text-delta', text: 'hello ' });
    persist.appendOutput(handle, 'hello ');
    persist.appendOutput(handle, 'world');
    await persist.finalize(handle, {
      status: 'completed',
      durationMs: 42,
      output: 'complete body',
      sessionId: 'sess-1',
    });

    const events = fs.readFileSync(handle.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'process-info', pid: 123 });
    expect(events[1]).toMatchObject({ type: 'text-delta', text: 'hello ' });
    expect(fs.readFileSync(handle.outputPath, 'utf8')).toBe('hello world');

    const meta = JSON.parse(fs.readFileSync(handle.metaPath, 'utf8'));
    expect(meta).toMatchObject({
      runId: handle.runId,
      agentId: 'agent-1',
      cid: 'conv-1',
      cli: 'claude',
      cliPath: '/fake/claude',
      model: 'claude-opus-4-7',
      status: 'completed',
      durationMs: 42,
      output: 'complete body',
      sessionId: 'sess-1',
    });
    expect(meta.startedAt).toBeTruthy();
    expect(meta.endedAt).toBeTruthy();
  });

  it('writes final output when no streamed output exists', async () => {
    const persist = await loadPersist();
    const handle = await persist.start(TEST_UID, {
      agentId: 'agent-1',
      cid: 'conv-1',
      cli: 'codex',
      prompt: 'summarize',
    });

    await persist.finalize(handle, {
      status: 'failed',
      error: 'backend exited',
      output: 'final-only body',
    });

    expect(fs.readFileSync(handle.outputPath, 'utf8')).toBe('final-only body');
    const meta = JSON.parse(fs.readFileSync(handle.metaPath, 'utf8'));
    expect(meta.status).toBe('failed');
    expect(meta.error).toBe('backend exited');
  });
});
