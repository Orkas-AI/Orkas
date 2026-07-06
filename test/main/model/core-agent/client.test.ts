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

    expect(client.buildSkillSandboxEnv()).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      ORKAS_PC_DIR: process.cwd(),
      ORKAS_WORKSPACE_ROOT: path.resolve(tmpDir),
      ORKAS_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv'),
      ORKAS_PYTHON_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv', 'python'),
      UV_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'uv'),
      PIP_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'pip'),
    });
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

  it('builds model turn log context without raw prompts, ids, or paths', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');

    const ctx = client.modelTurnContextForLog({
      userId: 'user-secret-123456789',
      sessionId: 'gconv-secret-session-id-12345',
      cid: 'conversation-private-abcdef',
      agentId: 'agent-private-abcdef',
      projectId: 'project-private-abcdef',
      message: 'please analyze my private launch plan',
      systemPrompt: 'private system rules',
      workingDir: '/Users/test/Secret Project',
      extraRoots: ['/Users/test/Extra Private Root'],
      readOnlyExtraRoots: ['/Users/test/Readonly Private Root'],
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
    expect(ctx.extra_root_count).toBe(1);
    expect(ctx.read_only_extra_root_count).toBe(1);
    expect(ctx.tool_count).toBe(2);
    expect(ctx.tool_names).toEqual(['dispatch_to', 'read_file']);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('private launch plan');
    expect(serialized).not.toContain('private system rules');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('Secret Project');
    expect(serialized).not.toContain('secret-session-id');
    expect(serialized).not.toContain('conversation-private');
    expect(serialized).not.toContain('profile-secret');
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
      '#5 +200ms tool_end tool=bash call=call...3456 error=true',
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
});
