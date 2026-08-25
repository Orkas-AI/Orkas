import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';

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

const runnerConnectorMock = vi.hoisted(() => ({
  resolveVisibleConnectors: vi.fn(async () => [] as any[]),
}));
vi.mock('../../../../src/main/features/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors')>();
  return {
    ...actual,
    resolveVisibleConnectors: runnerConnectorMock.resolveVisibleConnectors,
  };
});

const remoteMediaDownloadMock = vi.hoisted(() => ({
  download: vi.fn(),
}));
vi.mock('../../../../src/main/util/proxy-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/util/proxy-dispatcher')>();
  return {
    ...actual,
    downloadBinaryWithProxyPolicy: (...args: any[]) => remoteMediaDownloadMock.download(...args),
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

let mockCodexBackendImpl: ((opts: any) => Promise<void>) | null = null;
vi.mock('../../../../src/main/features/local_agents/backends/codex', () => ({
  codexBackend: {
    run: (opts: any) => (mockCodexBackendImpl ? mockCodexBackendImpl(opts) : Promise.resolve()),
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKsAAAAASUVORK5CYII=';
const MP4_FTYP = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runner-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  mockDetect.mockReset();
  runnerConnectorMock.resolveVisibleConnectors.mockReset();
  runnerConnectorMock.resolveVisibleConnectors.mockResolvedValue([]);
  remoteMediaDownloadMock.download.mockReset();
  remoteMediaDownloadMock.download.mockRejectedValue(new Error('remote media unavailable in this test'));
  mockBackendImpl = null;
  mockOpenclawBackendImpl = null;
  mockCodexBackendImpl = null;
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRunner() {
  return import('../../../../src/main/features/local_agents/runner');
}

async function callRunnerBridge(
  bridge: { server: { env: Record<string, string> } },
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const envFile = bridge.server.env.ORKAS_BRIDGE_ENV_FILE;
  const secret = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(secret.ORKAS_BRIDGE_SOCKET);
    socket.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('bridge test RPC timed out'));
    }, 4000);
    socket.on('connect', () => socket.write(`${JSON.stringify({
      id: 1,
      token: secret.ORKAS_BRIDGE_TOKEN,
      method,
      params,
    })}\n`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buf.slice(0, idx)));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('local_agents/runner', () => {
  it('advertises only granted bridge categories and directs Commander-only work to handoff', async () => {
    const runner = await loadRunner();
    const restricted = runner.buildBridgeSystemPrompt([
      'skills.read', 'skills.run', 'kb.read', 'chat.read', 'commander.handoff',
    ]);
    expect(restricted).toContain('orkas_handoff_to_commander');
    expect(restricted).toContain('Do not emit Commander-only <auto-task>');
    expect(restricted).not.toContain('orkas_list_connector_tools');

    const connectorGranted = runner.buildBridgeSystemPrompt(['connectors', 'commander.handoff']);
    expect(connectorGranted).toContain('ordinary Orkas group-chat Agent');
    expect(connectorGranted).toContain('orkas_call_connector_tool');

    const openOnly = runner.buildBridgeSystemPrompt(['skills.read', 'skills.run']);
    expect(openOnly).toContain('orkas_run_skill');
    expect(openOnly).not.toContain('orkas_handoff_to_commander');
    expect(openOnly).not.toContain('<auto-task>');
  });

  it('builds local agent log context without raw prompts, args, resume ids, or paths', async () => {
    const runner = await loadRunner();
    const ctx = runner.localAgentRunContextForLog({
      uid: 'user-secret-123456789',
      cid: 'conversation-private-abcdef',
      agentId: 'agent-private-abcdef',
      projectId: 'project-private-abcdef',
      cli: 'claude',
      customArgs: ['--token', 'super-secret-token'],
      resumeSessionId: 'resume-private-session-id',
      prompt: 'private prompt body',
      systemPrompt: 'private durable instructions',
      resumeFallbackPrompt: 'private recovered transcript',
      reuseSessionInstructions: true,
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
    expect(ctx.system_prompt_chars).toBe('private durable instructions'.length);
    expect(ctx.resume_fallback_chars).toBe('private recovered transcript'.length);
    expect(ctx.reuse_session_instructions).toBe(true);
    expect(ctx.custom_arg_count).toBe(2);
    expect(ctx.has_resume_session).toBe(true);
    expect(ctx.has_cwd).toBe(true);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('private prompt body');
    expect(serialized).not.toContain('private durable instructions');
    expect(serialized).not.toContain('private recovered transcript');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('resume-private-session-id');
    expect(serialized).not.toContain('/Users/test');
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
    expect(serialized).not.toContain('/Users/test');
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

  it('preserves a distinct version timeout when the installed CLI probe exceeds its deadline', async () => {
    mockDetect.mockResolvedValue({
      type: 'claude', available: false, path: '/usr/local/bin/claude', version: null,
      error: 'version_timeout', errorDetail: 'version probe timed out',
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
      cliError: 'version_timeout',
      cliPath: '/usr/local/bin/claude',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      cliError: 'version_timeout',
      cliPath: '/usr/local/bin/claude',
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

  it('adds and persists a duration for each correlated CLI tool result', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'tool-event', tool: 'web_fetch', callId: 'web-1', phase: 'use',
        input: { url: 'https://example.com/docs' },
      });
      onEvent({
        type: 'tool-event', tool: 'tool_result', callId: 'web-1', phase: 'result',
        output: 'ok',
      });
      onEvent({
        type: 'tool-event', tool: 'read_file', callId: 'read-1', phase: 'use',
        input: { path: 'README.md' },
      });
      onEvent({
        type: 'tool-event', tool: 'tool_result', callId: 'read-1', phase: 'result',
        durationMs: 41, output: 'read',
      });
      onEvent({ type: 'done', status: 'completed', output: 'done', durationMs: 1 });
    };
    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c-tool-duration', agentId: 'agent-x',
      cli: 'claude', prompt: 'read docs', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    const resultEvent = events.find((event) => event.type === 'tool-event' && event.phase === 'result');
    expect(resultEvent.durationMs).toBeGreaterThanOrEqual(0);
    expect(events.find((event) => event.type === 'tool-event'
      && event.callId === 'web-1' && event.phase === 'use'))
      .toMatchObject({ input: { url: 'https://example.com/docs' } });
    expect(events.find((event) => event.type === 'tool-event'
      && event.callId === 'read-1' && event.phase === 'result'))
      .toMatchObject({ phase: 'result', durationMs: 41 });

    const eventPath = path.join(
      tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId, 'events.jsonl',
    );
    const persisted = fs.readFileSync(eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(persisted.find((event) => event.type === 'tool-event' && event.phase === 'result'))
      .toMatchObject({ callId: 'web-1', durationMs: resultEvent.durationMs });
    expect(persisted.find((event) => event.type === 'tool-event'
      && event.callId === 'read-1' && event.phase === 'result'))
      .toMatchObject({ phase: 'result', durationMs: 41 });
  });

  it.each([
    {
      label: 'after a fresh-run Skill listing',
      resumeSessionId: '',
      listFirst: true,
      tool: 'mcp__orkas__orkas_read_skill',
      input: { id: 'efb0fe5d9664' },
    },
    {
      label: 'on the first call of a resumed CLI session',
      resumeSessionId: 'prior-cli-session',
      listFirst: false,
      tool: 'orkas.orkas_read_skill',
      input: { id: 'efb0fe5d9664' },
    },
    {
      label: 'while running one of its scripts',
      resumeSessionId: '',
      listFirst: true,
      tool: 'mcp__orkas__orkas_run_skill',
      input: { skill: 'efb0fe5d9664', script: 'scripts/check-release.js' },
    },
  ])('persists a Bridge Skill display name $label', async ({
    resumeSessionId, listFirst, tool, input,
  }) => {
    const skillId = 'efb0fe5d9664';
    const skillDir = path.join(tmpDir, TEST_UID, 'cloud', 'skills', skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: Release Decision',
      'description: Decide whether a release is ready.',
      '---',
      'Review the release evidence.',
    ].join('\n'));
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ bridge, onEvent }) => {
      if (listFirst) {
        const listed = await callRunnerBridge(bridge, 'skills.list', {});
        expect(listed).toMatchObject({ ok: true });
      }
      onEvent({
        type: 'tool-event',
        tool,
        callId: 'read-skill-1',
        phase: 'use',
        input,
      });
      onEvent({
        type: 'tool-event',
        tool: 'tool_result',
        callId: 'read-skill-1',
        phase: 'result',
        output: 'skill body',
      });
      onEvent({ type: 'done', status: 'completed', output: 'done' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-skill-display-name',
      agentId: 'agent-x',
      currentMessageId: 'message-x',
      cli: 'claude',
      ...(resumeSessionId ? { resumeSessionId } : {}),
      prompt: 'review the release',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    expect(events.find(event => event.type === 'tool-event' && event.phase === 'use'))
      .toMatchObject({ skill_name: 'Release Decision', input });
    const eventPath = path.join(
      tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId, 'events.jsonl',
    );
    const persisted = fs.readFileSync(eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(persisted.find(event => event.type === 'tool-event' && event.phase === 'use'))
      .toMatchObject({ skill_name: 'Release Decision', input });
  });

  it('persists a Bridge Connector display name instead of its internal id', async () => {
    runnerConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'connector-instance-91f0', display_name: 'Notion Workspace' },
      tools: [{ name: 'search', description: 'Search pages', input_schema: {} }],
    }] as any);
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'tool-event',
        tool: 'mcp__orkas__orkas_call_connector_tool',
        callId: 'connector-call-1',
        phase: 'use',
        input: {
          connector_id: 'connector-instance-91f0',
          tool_name: 'search',
          args: { query: 'release plan' },
        },
      });
      onEvent({ type: 'done', status: 'completed', output: 'done' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    await runner.run({
      uid: TEST_UID,
      cid: 'c-connector-display-name',
      agentId: 'agent-x',
      currentMessageId: 'message-x',
      cli: 'claude',
      prompt: 'search the release plan',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    expect(events.find(event => event.type === 'tool-event'))
      .toMatchObject({ connector_name: 'Notion Workspace' });
  });

  it('forwards the backend active-run ingress and always clears it after the attempt', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const ingress = {
      submit: vi.fn(async (input: any) => ({ mode: 'steered', acceptedId: input.id })),
    };
    mockBackendImpl = async ({ onActiveRunIngress, onEvent }) => {
      onActiveRunIngress?.(ingress);
      onEvent({ type: 'done', status: 'completed', output: 'ok' });
      // Deliberately omit the backend-side null callback: runner must fail
      // closed even for an adapter that throws or forgets terminal cleanup.
    };
    const runner = await loadRunner();
    const states: any[] = [];

    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-ingress',
      agentId: 'agent-x',
      currentMessageId: 'message-x',
      cli: 'claude',
      prompt: 'do work',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
      onActiveRunIngress: value => states.push(value),
    });

    expect(result.status).toBe('completed');
    expect(states).toEqual([ingress, null]);
  });

  it('returns a structured Commander handoff recorded through the live run bridge', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ bridge, onEvent }) => {
      const reply = await callRunnerBridge(bridge, 'commander.handoff', {
        reason: 'Automation creation belongs to Commander.',
        context: 'Create a daily task at 08:00.',
      });
      expect(reply).toMatchObject({ ok: true, result: { accepted: true } });
      onEvent({ type: 'done', status: 'completed', output: 'Transferred with requirements intact.' });
    };

    const runner = await loadRunner();
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-commander-handoff',
      agentId: 'agent-x',
      agentName: 'CLI Agent',
      currentMessageId: 'message-x',
      cli: 'claude',
      prompt: 'create an automation',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result).toMatchObject({
      status: 'completed',
      commanderHandoff: {
        reason: 'Automation creation belongs to Commander.',
        context: 'Create a daily task at 08:00.',
      },
    });
  });

  it('keeps a bounded reasoning summary while removing raw thinking text', async () => {
    const privateThought = 'PRIVATE_THOUGHT_SENTINEL: recall the user profile';
    const publicSummary = 'Reviewing the relevant project files';
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'thinking',
        text: privateThought,
        summary: publicSummary,
        itemId: 'reasoning-1',
        heartbeat: true,
      });
      onEvent({ type: 'done', status: 'completed', output: 'Public answer' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c-private-thinking', agentId: 'agent-x',
      cli: 'claude', prompt: 'answer publicly', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(events[0]).toEqual({
      type: 'thinking',
      chars: privateThought.length,
      summary: publicSummary,
      itemId: 'reasoning-1',
      heartbeat: true,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_THOUGHT_SENTINEL');

    const eventsPath = path.join(
      tmpDir,
      TEST_UID,
      'local',
      'file_cache',
      'local-agent-runs',
      result.runId,
      'events.jsonl',
    );
    const persisted = fs.readFileSync(eventsPath, 'utf8');
    expect(persisted).not.toContain('PRIVATE_THOUGHT_SENTINEL');
    expect(JSON.parse(persisted.trim().split('\n')[0])).toEqual({
      type: 'thinking',
      chars: privateThought.length,
      summary: publicSummary,
      itemId: 'reasoning-1',
      heartbeat: true,
    });
  });

  it('redacts and bounds public reasoning summaries', async () => {
    const runner = await loadRunner();
    const raw = [
      // The semicolon is a realistic prose boundary and ensures this one case
      // independently exercises path hashing, secret masking, and truncation.
      'Reviewing /Users/test/private/customer-plan.md;',
      'token=sk-proj-local-agent-secret-123456789',
      'x'.repeat(3_000),
    ].join(' ');
    const summary = runner.sanitizePublicThinkingSummary(raw);

    expect(summary).not.toContain('/Users/test');
    expect(summary).not.toContain('sk-proj-local-agent-secret-123456789');
    expect(summary).toMatch(/^Reviewing <abs-path:[a-f0-9]{12}>; token=\*\*\*/);
    expect(summary.length).toBeLessThanOrEqual(2_049);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('redacts private CLI diagnostics before forwarding or persistence', async () => {
    const privatePath = '/Users/test/private/customer-plan.md';
    const privateToken = 'sk-proj-local-agent-secret-123456789';
    mockDetect.mockResolvedValue({
      type: 'claude',
      available: true,
      path: '/fake/claude',
      version: '2.0.0',
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'process-info',
        pid: 42,
        cwd: privatePath,
        cmd: '/Users/test/bin/claude',
        args: ['--api-key', privateToken],
      });
      onEvent({ type: 'stderr-line', line: `failed ${privatePath} api_key=${privateToken}` });
      onEvent({ type: 'raw-line', line: `Authorization: Bearer ${privateToken}` });
      onEvent({
        type: 'log',
        level: 'warn',
        message: `owner=alice@example.com file=${privatePath}`,
      });
      onEvent({
        type: 'done',
        status: 'failed',
        error: `CLI failed at ${privatePath}`,
        stderrTail: `api_key=${privateToken}`,
      });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-private-diagnostics',
      agentId: 'agent-x',
      cli: 'claude',
      prompt: 'run',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    expect(events[0]).toMatchObject({
      type: 'process-info',
      pid: 42,
      cmd: 'claude',
      argCount: 2,
    });
    expect(events[0]).not.toHaveProperty('cwd');
    expect(events[0]).not.toHaveProperty('args');
    expect(result.error).toContain('<abs-path:');
    expect(JSON.stringify(events)).toContain('***');

    const eventsPath = path.join(
      tmpDir,
      TEST_UID,
      'local',
      'file_cache',
      'local-agent-runs',
      result.runId,
      'events.jsonl',
    );
    const publicDiagnostics = `${JSON.stringify(events)}\n${fs.readFileSync(eventsPath, 'utf8')}`;
    for (const privateValue of [privatePath, privateToken, 'alice@example.com']) {
      expect(publicDiagnostics).not.toContain(privateValue);
    }
  });

  it('keeps useful tool metadata while stripping private command, path, and body data before forwarding and persistence', async () => {
    const privateToken = 'sk-proj-local-agent-secret-123456789';
    const opaqueToken = 'opaque-secret-value';
    const opaqueSession = 'opaque-session-value';
    const opaqueShortPassword = 'opaque-short-password';
    const opaqueHeader = 'opaque-header-value';
    const opaqueAuth = 'opaque-auth-value';
    const outsidePath = '/Users/test/private/customer-plan.md';
    const ownedAbsolutePath = path.join(tmpDir, 'project', 'nested', 'result.ts');
    const unchangedOutput = 'unchanged tool output\nsecond line';
    mockDetect.mockResolvedValue({
      type: 'claude',
      available: true,
      path: '/fake/claude',
      version: '2.0.0',
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'tool-event',
        tool: 'write',
        callId: 'private-tool-input',
        phase: 'result',
        input: {
          command: `run ${outsidePath} --token=${privateToken} --token ${opaqueToken} --session-id ${opaqueSession} -ualice:${opaqueShortPassword} -H"X-Api-Key: ${opaqueHeader}" --auth ${opaqueAuth}\nPRIVATE_COMMAND_BODY`,
          filePath: ownedAbsolutePath,
          path: outsidePath,
          content: 'PRIVATE_WRITE_BODY',
          description: 'PRIVATE_DESCRIPTION',
          token: privateToken,
          files: [
            { path: outsidePath, content: 'PRIVATE_NESTED_BODY' },
            { path: 'nested/../../outside/traversal.ts' },
            { file: ownedAbsolutePath, token: privateToken },
            { file_path: 'relative/nested/file-path.ts' },
            { filePath: 'relative/nested/filePath.ts' },
            { filename: 'notes.txt' },
          ],
        },
        error: `failed ${outsidePath} token=${privateToken}`,
        isError: true,
        output: unchangedOutput,
      });
      onEvent({ type: 'done', status: 'completed', output: 'done' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-private-tool-input',
      agentId: 'agent-x',
      cli: 'claude',
      prompt: 'run',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    const liveToolEvent = events.find(event => event.type === 'tool-event');
    expect(liveToolEvent.input).toEqual({
      command: expect.stringMatching(/^run\s+\S+/),
      filePath: 'project/nested/result.ts',
      displayPath: 'customer-plan.md',
      files: [
        { displayPath: 'customer-plan.md' },
        { displayPath: 'traversal.ts' },
        { file: 'project/nested/result.ts' },
        { file_path: 'relative/nested/file-path.ts' },
        { filePath: 'relative/nested/filePath.ts' },
        { filename: 'notes.txt' },
      ],
    });
    expect(liveToolEvent.input.command).not.toContain('\n');
    expect(liveToolEvent.input.command).not.toContain(privateToken);
    expect(liveToolEvent.input.command).not.toContain(opaqueToken);
    expect(liveToolEvent.input.command).not.toContain(opaqueSession);
    expect(liveToolEvent.input.command).not.toContain(opaqueShortPassword);
    expect(liveToolEvent.input.command).not.toContain(opaqueHeader);
    expect(liveToolEvent.input.command).not.toContain(opaqueAuth);
    expect(liveToolEvent.input.command).toContain('customer-plan.md');
    expect(liveToolEvent.input.command).not.toContain('<path>');
    expect(liveToolEvent.error).toMatch(/^failed <(?:abs-)?path:/);
    expect(liveToolEvent.output).toBe(unchangedOutput);

    const eventsPath = path.join(
      tmpDir,
      TEST_UID,
      'local',
      'file_cache',
      'local-agent-runs',
      result.runId,
      'events.jsonl',
    );
    const persistedEvents = fs.readFileSync(eventsPath, 'utf8').trim()
      .split('\n').map(line => JSON.parse(line));
    const persistedToolEvent = persistedEvents.find(event => event.type === 'tool-event');
    expect(persistedToolEvent).toEqual(liveToolEvent);
    expect(persistedToolEvent.output).toBe(unchangedOutput);

    const publicMetadata = JSON.stringify({
      input: liveToolEvent.input,
      error: liveToolEvent.error,
      persistedInput: persistedToolEvent.input,
      persistedError: persistedToolEvent.error,
    });
    for (const privateValue of [
      privateToken,
      opaqueToken,
      opaqueSession,
      opaqueShortPassword,
      opaqueHeader,
      opaqueAuth,
      outsidePath,
      ownedAbsolutePath,
      'PRIVATE_COMMAND_BODY',
      'PRIVATE_WRITE_BODY',
      'PRIVATE_DESCRIPTION',
      'PRIVATE_NESTED_BODY',
    ]) {
      expect(publicMetadata).not.toContain(privateValue);
    }
  });

  it('marks nested Windows traversal as display-only metadata', async () => {
    const runner = await loadRunner();
    const event = runner.redactPrivateLocalAgentEvent({
      type: 'tool-event',
      tool: 'write',
      callId: 'windows-traversal',
      phase: 'result',
      input: { filePath: 'nested\\..\\..\\outside\\secret.ts' },
      output: 'created',
    }, 'C:\\project');

    expect((event as any).input).toEqual({ displayPath: 'secret.ts' });
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

  it('retries a pre-execution stale resume once with bounded recovery', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const attempts: any[] = [];
    mockBackendImpl = async (opts) => {
      attempts.push(opts);
      if (attempts.length === 1) {
        opts.onEvent({ type: 'stderr-line', line: 'No conversation found with session ID old-session' });
        opts.onEvent({ type: 'done', status: 'failed', error: 'claude exited with code 1' });
        return;
      }
      opts.onEvent({
        type: 'done',
        status: 'completed',
        output: 'Recovered answer',
        sessionId: 'new-session',
      });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-stale-resume',
      agentId: 'agent-x',
      cli: 'claude',
      prompt: '继续',
      systemPrompt: 'durable instructions',
      resumeFallbackPrompt: 'bounded history\n\n继续',
      reuseSessionInstructions: true,
      resumeSessionId: 'old-session',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      prompt: '继续',
      resumeSessionId: 'old-session',
      reuseSessionInstructions: true,
    });
    expect(attempts[1]).toMatchObject({
      prompt: 'bounded history\n\n继续',
      reuseSessionInstructions: false,
    });
    expect(attempts[1].resumeSessionId).toBeUndefined();
    expect(events.filter((event) => event.type === 'done')).toEqual([
      expect.objectContaining({ status: 'completed', sessionId: 'new-session' }),
    ]);
    expect(result).toMatchObject({
      status: 'completed',
      output: 'Recovered answer',
    });
  });

  it('does not fresh-retry after a resumed session has begun executing', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    let attempts = 0;
    mockBackendImpl = async (opts) => {
      attempts += 1;
      opts.onEvent({ type: 'status', status: 'running' });
      opts.onEvent({ type: 'stderr-line', line: 'session expired after execution began' });
      opts.onEvent({ type: 'done', status: 'failed', error: 'failed after execution' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID,
      cid: 'c-executed-resume',
      agentId: 'agent-x',
      cli: 'claude',
      prompt: '继续',
      resumeFallbackPrompt: 'bounded history\n\n继续',
      resumeSessionId: 'old-session',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(attempts).toBe(1);
    expect(result.status).toBe('failed');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
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

  it('preserves the background timeout phase for localized caller recovery', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent, timeoutMs }) => {
      // Backend honors timeoutMs internally; here we simulate it firing.
      expect(timeoutMs).toBeGreaterThan(0);
      onEvent({
        type: 'done',
        status: 'timeout',
        timeoutPhase: 'background',
        error: 'cli exceeded timeout',
        durationMs: timeoutMs,
      });
    };
    const events: any[] = [];
    const result = await (await import('../../../../src/main/features/local_agents/runner')).run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });
    expect(result.status).toBe('timeout');
    expect(result.timeoutPhase).toBe('background');
    expect(result.error).toMatch(/timeout/);
  });

  it('registers a background process for bounded app-shutdown cleanup', async () => {
    mockDetect.mockResolvedValue({
      type: 'claude', available: true, path: '/fake/claude', version: '2.0.0',
    });
    let resolveProcessExit!: () => void;
    const untilProcessExit = new Promise<void>(resolve => { resolveProcessExit = resolve; });
    const stop = vi.fn(() => resolveProcessExit());
    mockBackendImpl = async ({ onBackgroundRun, onEvent }) => {
      onBackgroundRun({ untilProcessExit, liveTasks: () => 1, stop });
      onEvent({ type: 'done', status: 'completed', output: 'queued cleanup' });
    };

    const runner = await import('../../../../src/main/features/local_agents/runner');
    const result = await runner.run({
      uid: TEST_UID, cid: 'c', agentId: 'a',
      cli: 'claude', prompt: 'p', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.status).toBe('completed');

    await expect(runner.stopBackgroundRuns('the app is quitting', 1_000)).resolves.toBe(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith('the app is quitting');
    await Promise.resolve();
    await expect(runner.stopBackgroundRuns('already drained', 10)).resolves.toBe(0);
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
    vi.useFakeTimers();
    try {
      mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
      let onEventCb: ((e: any) => void) | null = null;
      let backendLastEventAt: (() => number) | null = null;
      let resolveBackend!: () => void;
      let markBackendReady!: () => void;
      const backendReady = new Promise<void>((resolve) => { markBackendReady = resolve; });
      mockBackendImpl = async ({ onEvent, lastEventAt }) => {
        onEventCb = onEvent;
        backendLastEventAt = lastEventAt;
        onEvent({ type: 'process-info', pid: 42, cwd: '/x', cmd: 'claude', args: [] });
        markBackendReady();
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

      await backendReady;
      expect(onEventCb).not.toBeNull();
      expect(backendLastEventAt).not.toBeNull();

      // Threshold=120ms, tick = max(50, 120/3=40) → 50ms. Wait ~250ms:
      // at least 2 idle pulses should fire after the 120ms quiet period.
      await vi.advanceTimersByTimeAsync(250);
      const idleCount1 = events.filter(e => e.type === 'idle').length;
      expect(idleCount1).toBeGreaterThanOrEqual(1);

      // Continue waiting → steady drumbeat (more idle events).
      await vi.advanceTimersByTimeAsync(150);
      const idleCount2 = events.filter(e => e.type === 'idle').length;
      expect(idleCount2).toBeGreaterThan(idleCount1);

      // A content-free Codex reasoning heartbeat is UI liveness. While those
      // pulses continue, the user must not be told that the active reasoning
      // item is unresponsive.
      const watchdogClock = backendLastEventAt!;
      const realActivityBeforeHeartbeat = watchdogClock();
      onEventCb!({ type: 'thinking', chars: 0, itemId: 'reasoning-1', heartbeat: true, synthetic: true });
      const beforeHeartbeat = events.filter(e => e.type === 'idle').length;
      await vi.advanceTimersByTimeAsync(80);  // less than 120ms threshold
      expect(events.filter(e => e.type === 'idle')).toHaveLength(beforeHeartbeat);
      // UI liveness must remain separate from the backend kill watchdog.
      expect(watchdogClock()).toBe(realActivityBeforeHeartbeat);
      expect(events).toContainEqual({
        type: 'thinking',
        chars: 0,
        itemId: 'reasoning-1',
        heartbeat: true,
        synthetic: true,
      });

      // If heartbeats stop, the ordinary visible-idle state still recovers.
      await vi.advanceTimersByTimeAsync(80);
      expect(events.filter(e => e.type === 'idle').length).toBeGreaterThan(beforeHeartbeat);

      // A real protocol event resets both visible-idle reporting and the
      // backend watchdog activity clock.
      onEventCb!({ type: 'status', status: 'running' });
      expect(watchdogClock()).toBeGreaterThan(realActivityBeforeHeartbeat);
      const beforeRealReset = events.filter(e => e.type === 'idle').length;
      await vi.advanceTimersByTimeAsync(80);
      expect(events.filter(e => e.type === 'idle')).toHaveLength(beforeRealReset);

      resolveBackend();
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    } finally {
      vi.useRealTimers();
      if (prevIdleMs === undefined) delete process.env.ORKAS_LOCAL_AGENT_IDLE_MS;
      else process.env.ORKAS_LOCAL_AGENT_IDLE_MS = prevIdleMs;
      if (prevIdleMin === undefined) delete process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS;
      else process.env.ORKAS_LOCAL_AGENT_IDLE_MIN_MS = prevIdleMin;
    }
  });

  it('spills oversized tool-event results and exposes only an opaque output ref', async () => {
    const { DEFAULT_INLINE_RESULT_TOKENS } = await import('../../../../src/main/util/tool-result-cap');
    // ASCII length past the token-aware spill budget (~4 chars per token).
    const big = 'X'.repeat(DEFAULT_INLINE_RESULT_TOKENS * 4 + 200);
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
    expect(toolEvent.outputRef).toMatch(/^bash\.[0-9a-f]+$/);
    expect(toolEvent.outputPath).toBeUndefined();
    expect(typeof toolEvent.output).toBe('string');
    // Output is now the preview marker, not the full payload.
    expect(toolEvent.output.length).toBeLessThan(big.length);
    expect(toolEvent.output).toMatch(/<persisted-output/);
    // The full content remains machine-local; the cloud-safe event exposes no
    // absolute path and resolves through the content-addressed ref.
    const spillPath = path.join(
      tmpDir,
      TEST_UID,
      'local',
      'tool-results',
      `cli-claude-${result.runId}`,
      `${toolEvent.outputRef}.txt`,
    );
    expect(fs.existsSync(spillPath)).toBe(true);
    expect(fs.readFileSync(spillPath, 'utf8')).toBe(big);
    // Spill landed under the expected per-session directory shape:
    // <uid>/local/tool-results/cli-claude-<runId>/bash.<id>.txt (CLAUDE.md §5 — session_id
    // dropped uid prefix; user scoping comes from path root, not the filename)
    expect(JSON.stringify(toolEvent)).not.toContain(`cli-claude-${result.runId}`);
    expect(JSON.stringify(toolEvent)).not.toContain(tmpDir);
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
    expect(toolEvent.outputRef).toBeUndefined();
  });

  it('materializes a real Codex Base64 image result before generic tool-result spill', async () => {
    mockDetect.mockResolvedValue({ type: 'codex', available: true, path: '/fake/codex', version: '1.2.3' });
    mockCodexBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'tool-event', tool: 'image_generation', callId: 'image-1', phase: 'use', input: {},
      });
      onEvent({
        type: 'tool-event', tool: 'image_generation', callId: 'image-1', phase: 'result', output: PNG_1X1_BASE64,
      });
      onEvent({ type: 'done', status: 'completed', output: 'Image generated.', durationMs: 1 });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c-codex-image', agentId: 'a',
      cli: 'codex', prompt: 'generate an image', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
    });

    expect(result.status).toBe('completed');
    const toolResultIndex = events.findIndex((event) => (
      event.type === 'tool-event' && event.tool === 'image_generation' && event.phase === 'result'
    ));
    const fileEventIndex = events.findIndex((event) => event.type === 'file-change');
    const doneIndex = events.findIndex((event) => event.type === 'done');
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(fileEventIndex).toBeGreaterThan(toolResultIndex);
    expect(doneIndex).toBeGreaterThan(fileEventIndex);
    expect(events[toolResultIndex]).toMatchObject({
      output: 'Generated PNG image (1×1, 68 bytes).',
    });
    expect(events[toolResultIndex].outputRef).toBeUndefined();
    expect(events[fileEventIndex]).toMatchObject({
      scope: 'conversation-media',
      source: 'image_generation',
      synthetic: true,
    });

    const generatedPath = events[fileEventIndex].paths[0];
    const layout = await import('../../../../src/main/util/project-layout');
    expect(path.dirname(generatedPath)).toBe(layout.chatAttachmentDirForConversation(TEST_UID, 'c-codex-image'));
    expect(path.basename(generatedPath)).toMatch(/^codex-generated-image(?:-.+)?\.png$/);
    expect(fs.readFileSync(generatedPath)).toEqual(Buffer.from(PNG_1X1_BASE64, 'base64'));

    const eventPath = path.join(
      tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId, 'events.jsonl',
    );
    const persistedText = fs.readFileSync(eventPath, 'utf8');
    const persisted = persistedText.trim().split('\n').map(line => JSON.parse(line));
    expect(persisted.find((event) => event.type === 'file-change')).toMatchObject({
      paths: [generatedPath],
      scope: 'conversation-media',
      source: 'image_generation',
    });
    expect(persistedText).not.toContain(PNG_1X1_BASE64);
    expect(fs.existsSync(path.join(
      tmpDir, TEST_UID, 'local', 'tool-results', `cli-codex-${result.runId}`,
    ))).toBe(false);
  });

  it('materializes CLI media privately, keeps safe remote images, and rejects paths outside cwd', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const outsidePath = path.join(path.dirname(tmpDir), `orkas-outside-${path.basename(tmpDir)}.png`);
    fs.writeFileSync(outsidePath, Buffer.from(PNG_1X1_BASE64, 'base64'));
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        callId: 'image-2',
        items: [
          { data: PNG_1X1_BASE64, mediaType: 'image/png', name: '../result.png' },
          { uri: 'https://cdn.example/generated.webp?token=signed', mediaType: 'image/webp' },
          { uri: outsidePath, mediaType: 'image/png' },
          { uri: 'javascript:alert(1)' },
        ],
      });
      onEvent({ type: 'done', status: 'completed', output: '', durationMs: 1 });
    };

    try {
      const runner = await loadRunner();
      const events: any[] = [];
      const result = await runner.run({
        uid: TEST_UID, cid: 'c-claude-image', agentId: 'a',
        cli: 'claude', prompt: 'generate an image', cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: e => events.push(e),
      });

      expect(result.status).toBe('completed');
      expect(events.find(event => event.type === 'media-output')).toEqual({
        type: 'media-output',
        source: 'claude',
        callId: 'image-2',
        items: [{
          uri: 'https://cdn.example/generated.webp?token=signed',
          mediaType: 'image/webp',
          localName: 'cli-remote-06c6a1b1220c68fd1dc1c9a1.webp',
        }],
        materializedCount: 1,
        scheduledCount: 1,
        rejectedCount: 2,
      });
      const fileEvent = events.find(event => event.type === 'file-change');
      expect(fileEvent).toMatchObject({
        scope: 'conversation-media', source: 'cli_media_output', synthetic: true,
      });
      expect(path.basename(fileEvent.paths[0])).toMatch(/^result(?:-.+)?\.png$/);
      expect(fs.readFileSync(fileEvent.paths[0])).toEqual(Buffer.from(PNG_1X1_BASE64, 'base64'));

      const eventPath = path.join(
        tmpDir, TEST_UID, 'local', 'file_cache', 'local-agent-runs', result.runId, 'events.jsonl',
      );
      const persistedText = fs.readFileSync(eventPath, 'utf8');
      expect(persistedText).not.toContain(PNG_1X1_BASE64);
      expect(persistedText).not.toContain(outsidePath);
      expect(persistedText).not.toContain('javascript:');
      expect(persistedText).toContain('https://cdn.example/generated.webp?token=signed');
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('finishes the turn before serial background image/video downloads materialize stable conversation media', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const imageBytes = Buffer.from(PNG_1X1_BASE64, 'base64');
    const releases = new Map<string, () => void>();
    remoteMediaDownloadMock.download.mockImplementation(async (url: string, options: any) => {
      await new Promise<void>((resolve) => { releases.set(url, resolve); });
      const body = url.includes('/clip.mp4') ? MP4_FTYP : imageBytes;
      options.validate?.(body);
      return { status: 200, body };
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        callId: 'media-remote',
        items: [
          { uri: 'https://8.8.8.8/generated.png?token=signed', mediaType: 'image/png' },
          { uri: 'https://8.8.4.4/clip.mp4?token=signed', mediaType: 'video/mp4' },
          { uri: 'http://127.0.0.1/private.png', mediaType: 'image/png' },
        ],
      });
      onEvent({ type: 'done', status: 'completed', output: '', durationMs: 1 });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    const messageFile = layout.conversationMessageReadFile(TEST_UID, 'c-remote-media');
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    fs.writeFileSync(messageFile, '{}\n');
    const events: any[] = [];
    const result = await runner.run({
      uid: TEST_UID, cid: 'c-remote-media', agentId: 'a',
      cli: 'claude', prompt: 'generate media', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    await vi.waitFor(() => expect(remoteMediaDownloadMock.download).toHaveBeenCalledTimes(1));
    const mediaEvent = events.find(event => event.type === 'media-output');
    expect(mediaEvent).toMatchObject({
      source: 'claude',
      callId: 'media-remote',
      materializedCount: 0,
      scheduledCount: 2,
      rejectedCount: 0,
      backgroundSkippedCount: 1,
    });
    expect(mediaEvent.items).toEqual([
      expect.objectContaining({
        uri: 'https://8.8.8.8/generated.png?token=signed',
        mediaType: 'image/png',
        localName: expect.stringMatching(/^cli-remote-[a-f0-9]{24}\.png$/),
      }),
      expect.objectContaining({
        uri: 'https://8.8.4.4/clip.mp4?token=signed',
        mediaType: 'video/mp4',
        localName: expect.stringMatching(/^cli-remote-[a-f0-9]{24}\.mp4$/),
      }),
      { uri: 'http://127.0.0.1/private.png', mediaType: 'image/png' },
    ]);
    expect(events.filter(event => event.type === 'file-change')).toHaveLength(0);

    releases.get('https://8.8.8.8/generated.png?token=signed')?.();
    await vi.waitFor(() => expect(remoteMediaDownloadMock.download).toHaveBeenCalledTimes(2));
    releases.get('https://8.8.4.4/clip.mp4?token=signed')?.();
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, 'c-remote-media');
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(attachmentDir, mediaEvent.items[0].localName))).toBe(true);
      expect(fs.existsSync(path.join(attachmentDir, mediaEvent.items[1].localName))).toBe(true);
    });
    expect(fs.readFileSync(path.join(attachmentDir, mediaEvent.items[0].localName))).toEqual(imageBytes);
    expect(fs.readFileSync(path.join(attachmentDir, mediaEvent.items[1].localName))).toEqual(MP4_FTYP);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    await expect(runner.stopBackgroundRuns('already drained', 10)).resolves.toBe(0);
  });

  it('does not let a late background download recreate media after its conversation is deleted', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const imageBytes = Buffer.from(PNG_1X1_BASE64, 'base64');
    let release!: () => void;
    remoteMediaDownloadMock.download.mockImplementation(async (_url: string, options: any) => {
      await new Promise<void>((resolve) => { release = resolve; });
      options.validate?.(imageBytes);
      return { status: 200, body: imageBytes };
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        items: [{ uri: 'https://8.8.8.8/deleted.png', mediaType: 'image/png' }],
      });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    const attachments = await import('../../../../src/main/features/chat_attachments');
    const cid = 'c-deleted-background-media';
    const messageFile = layout.conversationMessageReadFile(TEST_UID, cid);
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, cid);
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    fs.writeFileSync(messageFile, '{}\n');

    const events: any[] = [];
    await runner.run({
      uid: TEST_UID, cid, agentId: 'a',
      cli: 'claude', prompt: 'generate image', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });
    await vi.waitFor(() => expect(remoteMediaDownloadMock.download).toHaveBeenCalledOnce());
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });

    fs.unlinkSync(messageFile);
    await attachments.purgeByCid(TEST_UID, cid);
    release();
    await new Promise<void>(resolve => { setImmediate(resolve); });

    expect(fs.existsSync(attachmentDir)).toBe(false);
    await expect(runner.stopBackgroundRuns('already drained', 10)).resolves.toBe(0);
  });

  it('cancels background media for one deleted conversation without touching another', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    const signals = new Map<string, AbortSignal>();
    remoteMediaDownloadMock.download.mockImplementation(async (url: string, options: any) => {
      signals.set(url, options.signal);
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        items: [{ uri: `https://8.8.8.8/${currentCid}.png`, mediaType: 'image/png' }],
      });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    let currentCid = 'c-delete-cancel-one';
    for (const cid of [currentCid, 'c-delete-cancel-two']) {
      currentCid = cid;
      const messageFile = layout.conversationMessageReadFile(TEST_UID, cid);
      fs.mkdirSync(path.dirname(messageFile), { recursive: true });
      fs.writeFileSync(messageFile, '{}\n');
      await runner.run({
        uid: TEST_UID, cid, agentId: 'a',
        cli: 'claude', prompt: 'generate image', cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
    }
    await vi.waitFor(() => expect(signals.size).toBe(2));

    expect(runner.cancelBackgroundMediaForConversation(TEST_UID, 'c-delete-cancel-one')).toBe(1);
    expect(signals.get('https://8.8.8.8/c-delete-cancel-one.png')?.aborted).toBe(true);
    expect(signals.get('https://8.8.8.8/c-delete-cancel-two.png')?.aborted).toBe(false);

    await runner.stopBackgroundRuns('test cleanup', 1_000);
  });

  it('aborts old-user media downloads synchronously when the active account changes', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    let downloadSignal: AbortSignal | undefined;
    remoteMediaDownloadMock.download.mockImplementation(async (_url: string, options: any) => {
      downloadSignal = options.signal;
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        items: [{ uri: 'https://8.8.8.8/account.png', mediaType: 'image/png' }],
      });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    const users = await import('../../../../src/main/features/users');
    const cid = 'c-account-background-media';
    const messageFile = layout.conversationMessageReadFile(TEST_UID, cid);
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    fs.writeFileSync(messageFile, '{}\n');
    await runner.run({
      uid: TEST_UID, cid, agentId: 'a',
      cli: 'claude', prompt: 'generate image', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await vi.waitFor(() => expect(downloadSignal).toBeDefined());

    users.activateUser('u2');

    expect(downloadSignal?.aborted).toBe(true);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    await expect(runner.stopBackgroundRuns('already drained', 10)).resolves.toBe(0);
    expect(fs.existsSync(layout.chatAttachmentDirForConversation(TEST_UID, cid))).toBe(false);
    users.activateUser(TEST_UID);
  });

  it('cancels and drains background media work during bounded app shutdown cleanup', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    let downloadSignal: AbortSignal | undefined;
    remoteMediaDownloadMock.download.mockImplementation(async (_url: string, options: any) => {
      downloadSignal = options.signal;
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        items: [{ uri: 'https://8.8.8.8/shutdown.png', mediaType: 'image/png' }],
      });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    const cid = 'c-shutdown-background-media';
    const messageFile = layout.conversationMessageReadFile(TEST_UID, cid);
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    fs.writeFileSync(messageFile, '{}\n');
    await runner.run({
      uid: TEST_UID, cid, agentId: 'a',
      cli: 'claude', prompt: 'generate image', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await vi.waitFor(() => expect(downloadSignal).toBeDefined());

    await expect(runner.stopBackgroundRuns('the app is quitting', 1_000)).resolves.toBe(1);

    expect(downloadSignal?.aborted).toBe(true);
    expect(fs.existsSync(layout.chatAttachmentDirForConversation(TEST_UID, cid))).toBe(false);
    await expect(runner.stopBackgroundRuns('already drained', 10)).resolves.toBe(0);
  });

  it('bounds one turn to four background media downloads', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({
        type: 'media-output',
        source: 'claude',
        items: Array.from({ length: 5 }, (_, index) => ({
          uri: `https://8.8.8.${index + 1}/generated-${index}.png`,
          mediaType: 'image/png',
        })),
      });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const events: any[] = [];
    await runner.run({
      uid: TEST_UID, cid: 'c-bounded-background-media', agentId: 'a',
      cli: 'claude', prompt: 'generate images', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    });

    expect(events.find(event => event.type === 'media-output')).toMatchObject({
      scheduledCount: 4,
      backgroundSkippedCount: 1,
    });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    await runner.stopBackgroundRuns('test cleanup', 100);
  });

  it('shares one 128 MiB reservation budget across concurrent background media runs', async () => {
    mockDetect.mockResolvedValue({ type: 'claude', available: true, path: '/fake/claude', version: '2.0.0' });
    remoteMediaDownloadMock.download.mockImplementation(async (_url: string, options: any) => {
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    let pendingItems: Array<{ uri: string; mediaType: string }> = [];
    mockBackendImpl = async ({ onEvent }) => {
      onEvent({ type: 'media-output', source: 'claude', items: pendingItems });
      onEvent({ type: 'done', status: 'completed', output: '' });
    };

    const runner = await loadRunner();
    const layout = await import('../../../../src/main/util/project-layout');
    const runWith = async (cid: string, items: typeof pendingItems) => {
      pendingItems = items;
      const messageFile = layout.conversationMessageReadFile(TEST_UID, cid);
      fs.mkdirSync(path.dirname(messageFile), { recursive: true });
      fs.writeFileSync(messageFile, '{}\n');
      const events: any[] = [];
      await runner.run({
        uid: TEST_UID, cid, agentId: 'a',
        cli: 'claude', prompt: 'generate media', cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => events.push(event),
      });
      return events.find(event => event.type === 'media-output');
    };

    const first = await runWith('c-global-budget-one', [
      { uri: 'https://8.8.8.8/one.mp4', mediaType: 'video/mp4' },
      { uri: 'https://8.8.4.4/two.mp4', mediaType: 'video/mp4' },
    ]);
    const second = await runWith('c-global-budget-two', [
      { uri: 'https://1.1.1.1/three.png', mediaType: 'image/png' },
    ]);

    expect(first).toMatchObject({ scheduledCount: 2 });
    expect(first).not.toHaveProperty('backgroundSkippedCount');
    expect(second).toMatchObject({ scheduledCount: 0, backgroundSkippedCount: 1 });
    await expect(runner.stopBackgroundRuns('test cleanup', 1_000)).resolves.toBe(2);
  });

  it('rejects malformed, unsupported, oversized, and unsafe-dimension Codex image payloads', async () => {
    const runner = await loadRunner();
    expect(runner.decodeCodexGeneratedImageResult('completed')).toEqual({ ok: false, reason: 'not_image' });
    expect(runner.decodeCodexGeneratedImageResult('iVBORw0KGgo!!!')).toEqual({ ok: false, reason: 'malformed' });
    expect(runner.decodeCodexGeneratedImageResult('data:image/jpeg;base64,/9j/2Q==')).toEqual({
      ok: false, reason: 'unsupported_format',
    });
    expect(runner.decodeCodexGeneratedImageResult(PNG_1X1_BASE64, 16)).toEqual({
      ok: false, reason: 'too_large',
    });
    const unsafeDimensions = Buffer.from(PNG_1X1_BASE64, 'base64');
    unsafeDimensions.writeUInt32BE(20_000, 16);
    expect(runner.decodeCodexGeneratedImageResult(unsafeDimensions.toString('base64'))).toEqual({
      ok: false, reason: 'invalid_dimensions',
    });
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
