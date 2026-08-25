import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS,
  TOOL_DESCRIPTION_SOFT_BUDGET_CHARS,
} from '../../../../src/core-agent/src/tools';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const bridgeConnectorMock = vi.hoisted(() => ({
  resolveVisibleConnectors: vi.fn(async () => [] as any[]),
}));
vi.mock('../../../../src/main/features/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors')>();
  return {
    ...actual,
    resolveVisibleConnectors: bridgeConnectorMock.resolveVisibleConnectors,
  };
});

// End-to-end: a real `bin/orkas-bridge.cjs` process (the MCP server a CLI
// agent spawns) speaking MCP JSON-RPC over stdio, proxying to a live
// bridge host. Pins the riskiest seam: SDK absolute-path requires + zod
// schemas + the socket RPC roundtrip.

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

const TEST_UID = 'u-bridge-e2e';
let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bridge-e2e-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
  vi.resetModules();
  bridgeConnectorMock.resolveVisibleConnectors.mockReset();
  bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([]);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private stderrBuf = '';
  private protocolProblems: string[] = [];
  private waiters = new Map<number, {
    resolve: (msg: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(env: Record<string, string>) {
    this.child = spawn(TEST_NODE, [path.join(process.cwd(), 'bin', 'orkas-bridge.cjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderrBuf += chunk; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); }
        catch {
          this.protocolProblems.push('non-JSON stdout line');
          continue;
        }
        const waiter = this.waiters.get(msg.id);
        if (waiter) {
          this.waiters.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        if (this.buf.trim()) this.protocolProblems.push('incomplete stdout line');
        const error = new Error('MCP bridge exited before the response completed');
        for (const waiter of this.waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.waiters.clear();
        resolve({ code, signal });
      });
    });
  }
  request(id: number, method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`mcp timeout: ${method}`)); }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }
  closeInput(): void {
    this.child.stdin.end();
  }
  async waitForExit(timeoutMs = 4000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('MCP bridge did not exit before timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  assertCleanOutput(): void {
    if (this.stderrBuf.length) {
      throw new Error(`MCP bridge emitted ${Buffer.byteLength(this.stderrBuf)} unexpected stderr bytes`);
    }
    if (this.protocolProblems.length) {
      throw new Error(`MCP bridge emitted ${this.protocolProblems.length} malformed protocol frame(s)`);
    }
  }
  kill(): void {
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SkillProcessTree {
  parent: number;
  child: number;
}

function installLongRunningSkill(skillName: string): string {
  const skillDir = path.join(tmpDir, TEST_UID, 'cloud', 'skills', skillName);
  const scriptsDir = path.join(skillDir, 'scripts');
  const pidFile = path.join(tmpDir, `${skillName}-pids.json`);
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: long-running fixture\n---\nbody`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, 'wait.js'),
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = ${JSON.stringify(grandchild)};`,
      'module.exports = async () => {',
      "  const child = spawn(process.execPath, ['-e', grandchild], { stdio: 'ignore' });",
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      "  process.on('SIGTERM', () => {});",
      '  setInterval(() => {}, 1000);',
      '  await new Promise(() => {});',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return pidFile;
}

async function startLifecycleBridge(label: string) {
  const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
  return startBridge({
    uid: TEST_UID,
    cid: `c-${label}`,
    agentId: `a-${label}`,
    agentName: 'Lifecycle Agent',
    currentMessageId: 'current-message',
    runId: `e2e-${label}-${Date.now().toString(36)}`,
    configDir: path.join(tmpDir, `${label}-rundir`),
    sandboxEnv: {
      ORKAS_NODE: TEST_NODE,
      ORKAS_BUNDLED_NODE: TEST_NODE,
      ORKAS_PC_DIR: process.cwd(),
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
}

async function startLongRunningSkill(
  client: McpStdioClient,
  skillName: string,
  pidFile: string,
): Promise<{ pendingCall: Promise<any>; processTree: SkillProcessTree }> {
  await client.request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  });
  client.notify('notifications/initialized');
  const pendingCall = client.request(2, 'tools/call', {
    name: 'orkas_run_skill',
    arguments: { skill: skillName, script: 'wait' },
  }, 8000).then(
    (response) => response,
    (error) => error,
  );
  await waitFor(() => fs.existsSync(pidFile));
  const processTree = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as SkillProcessTree;
  expect(Number.isInteger(processTree.parent) && processTree.parent > 0).toBe(true);
  expect(Number.isInteger(processTree.child) && processTree.child > 0).toBe(true);
  expect(processIsAlive(processTree.parent)).toBe(true);
  expect(processIsAlive(processTree.child)).toBe(true);
  return { pendingCall, processTree };
}

async function expectProcessTreeStopped(processTree: SkillProcessTree): Promise<void> {
  await waitFor(() => (
    !processIsAlive(processTree.parent) && !processIsAlive(processTree.child)
  ));
}

function forceStopProcessTree(processTree: SkillProcessTree | null): void {
  if (!processTree) return;
  for (const pid of [processTree.parent, processTree.child]) {
    if (processIsAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

function bridgeDescriptionBudgetProblems(tools: any[]): string[] {
  const problems: string[] = [];
  const walk = (toolName: string, value: unknown, pointer: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(toolName, item, `${pointer}/${index}`));
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.description === 'string'
      && object.description.replace(/\s+/g, ' ').trim().length > SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS) {
      problems.push(`${toolName}:${pointer}/description`);
    }
    for (const [key, child] of Object.entries(object)) {
      if (key !== 'description') walk(toolName, child, `${pointer}/${key}`);
    }
  };
  for (const tool of tools) {
    const description = String(tool.description || '').replace(/\s+/g, ' ').trim();
    if (description.length > TOOL_DESCRIPTION_SOFT_BUDGET_CHARS) {
      problems.push(`${tool.name}:description`);
    }
    walk(String(tool.name), tool.inputSchema, 'inputSchema');
  }
  return problems;
}

describe('orkas-bridge.cjs › MCP stdio e2e', () => {
  it('initializes, lists tools, and proxies orkas_list_skills through the socket', async () => {
    // Fixture skill in the trusted custom root.
    const skillDir = path.join(tmpDir, TEST_UID, 'cloud', 'skills', 'demo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nbody');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'large.js'),
      "module.exports = async () => { process.stdout.write('A'.repeat(80000)); return { tail: 'done' }; };\n",
      'utf8',
    );

    const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
    const bridge = await startBridge({
      uid: TEST_UID,
      cid: 'c1',
      agentId: 'a1',
      agentName: 'Agent',
      currentMessageId: 'current-message',
      runId: `e2e${Date.now().toString(36)}`,
      configDir: path.join(tmpDir, 'rundir'),
      sandboxEnv: {
        ORKAS_NODE: TEST_NODE,
        ORKAS_BUNDLED_NODE: TEST_NODE,
        ORKAS_PC_DIR: process.cwd(),
        ORKAS_WORKSPACE_ROOT: tmpDir,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      const init = await client.request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      expect(init.result?.serverInfo?.name).toBe('orkas');
      client.notify('notifications/initialized');

      const tools = await client.request(2, 'tools/list', {});
      const names = tools.result.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining([
        'orkas_list_skills', 'orkas_read_skill', 'orkas_run_skill',
        'library', 'chat_history',
        'orkas_handoff_to_commander',
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        'orkas_kb_list', 'orkas_kb_search', 'orkas_kb_read',
        'chat_search', 'chat_read',
      ]));
      expect(names).not.toContain('orkas_list_connector_tools');
      expect(names).not.toContain('orkas_call_connector_tool');
      expect(bridgeDescriptionBudgetProblems(tools.result.tools)).toEqual([]);
      const library = tools.result.tools.find((tool: any) => tool.name === 'library');
      const chatHistory = tools.result.tools.find((tool: any) => tool.name === 'chat_history');
      const readSkill = tools.result.tools.find((tool: any) => tool.name === 'orkas_read_skill');
      const runSkill = tools.result.tools.find((tool: any) => tool.name === 'orkas_run_skill');
      const commanderHandoff = tools.result.tools.find(
        (tool: any) => tool.name === 'orkas_handoff_to_commander',
      );
      expect(library.inputSchema.properties.action.enum).toEqual(['list', 'search', 'read']);
      expect(chatHistory.inputSchema.properties.action.enum).toEqual(['search', 'read']);
      expect(chatHistory.inputSchema.properties.page.properties.mode.enum)
        .toEqual(['latest', 'around', 'before']);
      expect(readSkill.description).toContain('return one available Orkas Skill');
      expect(readSkill.description).not.toContain('Follow');
      expect(runSkill.inputSchema.properties.action.enum).toEqual(['run', 'read']);
      expect(runSkill.description).toContain('page oversized stdout or stderr');
      expect(commanderHandoff.description).not.toContain('then stop this turn');

      const call = await client.request(3, 'tools/call', { name: 'orkas_list_skills', arguments: {} });
      const text = call.result.content[0].text as string;
      expect(text).toContain('demo-skill');

      const read = await client.request(4, 'tools/call', { name: 'orkas_read_skill', arguments: { id: 'demo-skill' } });
      expect(read.result.content[0].text).toContain('body');

      const libraryCall = await client.request(5, 'tools/call', {
        name: 'library', arguments: { action: 'list' },
      });
      expect(libraryCall.result.content[0].text).toContain('Library files');

      const historyCall = await client.request(6, 'tools/call', {
        name: 'chat_history',
        arguments: { action: 'search', query: 'missing', scope: 'current' },
      });
      expect(historyCall.result.content[0].text).toContain('No conversation-history results');

      const handoff = await client.request(7, 'tools/call', {
        name: 'orkas_handoff_to_commander',
        arguments: { reason: 'Needs Commander automation.', context: 'Daily at 08:00.' },
      });
      expect(handoff.result.content[0].text).toContain('Handoff recorded');
      expect(bridge.getCommanderHandoff()).toEqual({
        reason: 'Needs Commander automation.',
        context: 'Daily at 08:00.',
      });

      // Omitting action preserves the original run-call contract. The inline
      // threshold bounds context only; the same tool can read every remaining
      // byte through the opaque run-scoped ref.
      const run = await client.request(8, 'tools/call', {
        name: 'orkas_run_skill',
        arguments: { skill: 'demo-skill', script: 'large' },
      }, 15000);
      expect(run.result.isError).not.toBe(true);
      const runResult = JSON.parse(run.result.content[0].text);
      expect(runResult).toMatchObject({
        status: 'succeeded',
        timedOut: false,
        outputLimitExceeded: false,
        stdoutBytes: 80016,
        stdoutTruncated: true,
        stdoutNextOffset: 60000,
      });
      expect(runResult.outputRef).toMatch(/^[a-f0-9]{32}$/);
      expect(run.result.content[0].text).not.toContain(tmpDir);

      const continued = await client.request(9, 'tools/call', {
        name: 'orkas_run_skill',
        arguments: {
          action: 'read',
          output_ref: runResult.outputRef,
          stream: 'stdout',
          offset: runResult.stdoutNextOffset,
          limit: 30000,
        },
      });
      const continuedResult = JSON.parse(continued.result.content[0].text);
      expect(continuedResult).toMatchObject({
        offset: 60000,
        nextOffset: 80016,
        bytes: 80016,
        done: true,
      });
      expect(runResult.stdout + continuedResult.text)
        .toBe(`${'A'.repeat(80000)}{"tail":"done"}\n`);

      const missingRef = await client.request(10, 'tools/call', {
        name: 'orkas_run_skill',
        arguments: {
          action: 'read',
          output_ref: '0'.repeat(32),
          stream: 'stdout',
        },
      });
      expect(missingRef.result.isError).toBe(true);
      expect(missingRef.result.content[0].text).toContain('unavailable or expired');
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
    }
    client.assertCleanOutput();
    expect(fs.existsSync(path.join(tmpDir, 'rundir', '.orkas-bridge-skill-output'))).toBe(false);
  }, 20000);

  it('registers connector tools from ordinary group-chat Agent visibility', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'slack', display_name: 'Slack' },
      tools: [{ name: 'search', description: 'Search', input_schema: {} }],
    }] as any);
    const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
    const bridge = await startBridge({
      uid: TEST_UID,
      cid: 'c2',
      agentId: 'a2',
      agentName: 'Connector Agent',
      currentMessageId: 'current-message',
      runId: `e2e-connectors-${Date.now().toString(36)}`,
      configDir: path.join(tmpDir, 'connector-rundir'),
      sandboxEnv: {
        ORKAS_NODE: TEST_NODE,
        ORKAS_BUNDLED_NODE: TEST_NODE,
        ORKAS_PC_DIR: process.cwd(),
        ORKAS_WORKSPACE_ROOT: tmpDir,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      await client.request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized');
      const tools = await client.request(2, 'tools/list', {});
      const names = tools.result.tools.map((tool: any) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'orkas_list_connector_tools',
        'orkas_call_connector_tool',
      ]));
      expect(bridgeDescriptionBudgetProblems(tools.result.tools)).toEqual([]);
      const connectorTools = tools.result.tools.filter((tool: any) => (
        tool.name === 'orkas_list_connector_tools' || tool.name === 'orkas_call_connector_tool'
      ));
      expect(connectorTools.every((tool: any) => String(tool.description || '').length > 0)).toBe(true);
      const callTool = connectorTools.find((tool: any) => tool.name === 'orkas_call_connector_tool');
      expect(callTool?.description).toContain('orkas_list_connector_tools');
      expect(callTool?.description).not.toContain('relay a denial');
      expect(callTool?.inputSchema?.properties?.connector_id?.description)
        .toContain('Connector id returned');
      expect(callTool?.inputSchema?.properties?.tool_name?.description)
        .toContain('Action name returned');
      expect(callTool?.inputSchema?.properties?.args?.description)
        .toContain('input schema');
      expect(connectorTools.some((tool: any) => (
        String(tool.description || '').includes('explicitly enabled for this CLI Agent')
      ))).toBe(false);
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID);
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
    }
    client.assertCleanOutput();
  }, 20000);

  it.skipIf(process.platform === 'win32')(
    'terminates the active Skill tree before exiting on SIGTERM',
    async () => {
      const skillName = 'signal-skill';
      const pidFile = installLongRunningSkill(skillName);
      const bridge = await startLifecycleBridge('signal-stop');
      const client = new McpStdioClient(bridge.serverEnv);
      let processTree: SkillProcessTree | null = null;
      try {
        const started = await startLongRunningSkill(client, skillName, pidFile);
        processTree = started.processTree;

        client.signal('SIGTERM');
        const exit = await client.waitForExit();
        await started.pendingCall;
        await expectProcessTreeStopped(processTree);

        expect(exit).toEqual({ code: 143, signal: null });
        client.assertCleanOutput();
      } finally {
        client.kill();
        await client.waitForExit();
        await bridge.close();
        forceStopProcessTree(processTree);
      }
    },
    20000,
  );

  it('terminates the active Skill tree when the Orkas host socket closes', async () => {
    const skillName = 'host-close-skill';
    const pidFile = installLongRunningSkill(skillName);
    const bridge = await startLifecycleBridge('host-close');
    const client = new McpStdioClient(bridge.serverEnv);
    let processTree: SkillProcessTree | null = null;
    let bridgeClosed = false;
    try {
      const started = await startLongRunningSkill(client, skillName, pidFile);
      processTree = started.processTree;

      await bridge.close();
      bridgeClosed = true;
      await expectProcessTreeStopped(processTree);
      const response = await started.pendingCall;

      expect(response.result?.isError).toBe(true);
      expect(JSON.parse(response.result.content[0].text)).toMatchObject({
        status: 'aborted',
        outputLimitExceeded: false,
      });
      client.assertCleanOutput();
      expect(fs.existsSync(path.join(tmpDir, 'host-close-rundir', '.orkas-bridge-skill-output')))
        .toBe(false);
    } finally {
      client.kill();
      await client.waitForExit();
      if (!bridgeClosed) await bridge.close();
      forceStopProcessTree(processTree);
    }
  }, 20000);

  it('terminates the active Skill tree and exits when MCP stdin closes', async () => {
    const skillName = 'stdin-close-skill';
    const pidFile = installLongRunningSkill(skillName);
    const bridge = await startLifecycleBridge('stdin-close');
    const client = new McpStdioClient(bridge.serverEnv);
    let processTree: SkillProcessTree | null = null;
    try {
      const started = await startLongRunningSkill(client, skillName, pidFile);
      processTree = started.processTree;

      client.closeInput();
      const exit = await client.waitForExit();
      await started.pendingCall;
      await expectProcessTreeStopped(processTree);

      expect(exit).toEqual({ code: 0, signal: null });
      client.assertCleanOutput();
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
      forceStopProcessTree(processTree);
    }
  }, 20000);
});
