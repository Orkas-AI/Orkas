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
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'sent' }] })),
}));
vi.mock('../../../../src/main/features/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors')>();
  return {
    ...actual,
    resolveVisibleConnectors: bridgeConnectorMock.resolveVisibleConnectors,
    callTool: bridgeConnectorMock.callTool,
  };
});

const browserHost = vi.hoisted(() => ({
  openModelWebAssist: vi.fn(async () => ({ ok: true, active_tab_id: '0123456789ab' })),
  observeModelWebAssist: vi.fn(async () => ({ ok: true, page_id: 'page-1', untrusted_content: true, text: 'Settings' })),
  actOnModelWebAssist: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../../../src/main/features/web_assist', () => browserHost);

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
  bridgeConnectorMock.callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  const corpus = await import('../../../../src/main/features/library_corpus');
  const stores = await import('../../../../src/main/features/vec_store');
  corpus._resetLibraryCorporaForTests();
  stores.closeAllVecStores();
  vi.doUnmock('../../../../src/main/features/project_library_indexer');
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
      // Publish readiness only after both PIDs are completely written; the
      // reader runs in another process and may observe an empty open file.
      `  fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      `  fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});`,
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

async function startLifecycleBridge(label: string, projectId?: string, cli: 'claude' | 'codex' | 'opencode' = 'codex') {
  const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
  return startBridge({
    uid: TEST_UID,
    cid: `c-${label}`,
    projectId,
    agentId: `a-${label}`,
    agentName: 'Lifecycle Agent',
    cli,
    permissionPolicy: 'ask',
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
  it.each(['claude', 'codex', 'opencode'] as const)('lets %s use the task browser over MCP with the native contract and recovery receipts', async (cli) => {
    const life = await import('../../../../src/main/features/web_assist_lifecycle');
    const label = `browser-${cli}`;
    const cid = `c-${label}`;
    life.beginBrowserTaskRun(TEST_UID, cid, label);
    browserHost.openModelWebAssist.mockClear();
    browserHost.observeModelWebAssist.mockClear();
    browserHost.actOnModelWebAssist.mockClear();
    const bridge = await startLifecycleBridge(label, undefined, cli);
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      await client.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
      client.notify('notifications/initialized');
      const listed = await client.request(2, 'tools/list', {});
      const definition = listed.result.tools.find((tool: any) => tool.name === 'browser');
      expect(definition).toBeTruthy();
      const { buildConversationBrowserTool } = await import('../../../../src/main/features/group_chat/browser_tool');
      const native = buildConversationBrowserTool(TEST_UID, cid);
      expect(definition.description).toBe(native.description);
      expect(definition.inputSchema.properties).toEqual(native.inputSchema.properties);
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(bridgeDescriptionBudgetProblems([definition])).toEqual([]);
      if (cli === 'opencode') expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(['browser']);
      let id = 3;
      const call = async (args: Record<string, unknown>) => (await client.request(id++, 'tools/call', { name: 'browser', arguments: args })).result;
      const opened = await call({ operation: 'open', url: 'https://example.com/settings' });
      expect(JSON.parse(opened.content[0].text)).toEqual({ ok: true, active_tab_id: '0123456789ab' });
      expect(browserHost.openModelWebAssist).toHaveBeenCalledWith(TEST_UID, cid, { url: 'https://example.com/settings' });
      const observed = await call({ operation: 'observe', tab_id: '0123456789ab' });
      expect(JSON.parse(observed.content[0].text)).toMatchObject({ page_id: 'page-1', untrusted_content: true });
      // The host owns safety and stale-page decisions; MCP must preserve both
      // the error status and the actionable receipt instead of hiding its code.
      for (const code of ['stale_page', 'user_action_required', 'unknown_tab']) {
        browserHost.actOnModelWebAssist.mockResolvedValueOnce({ ok: false, code, error: 'Observe the task page or complete the protected action yourself.' } as any);
        const result = await call({ operation: 'act', tab_id: '0123456789ab', page_id: 'page-1', element_ref: 'e1', page_action: 'click' });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, code });
      }
      const forged = await call({ operation: 'open', url: 'https://example.com/forged', cid: 'other-task' });
      expect(forged.isError).toBe(true);
      expect(browserHost.openModelWebAssist).toHaveBeenCalledTimes(1);
      life.finishBrowserTaskRun(TEST_UID, cid, label);
      life.beginBrowserTaskRun(TEST_UID, cid, `${label}-replacement`);
      const stale = await call({ operation: 'open', url: 'https://example.com/stale' });
      expect(stale.isError).toBe(true);
      expect(JSON.parse(stale.content[0].text).code).toBe('task_run_ended');
      expect(browserHost.openModelWebAssist).toHaveBeenCalledTimes(1);
    } finally {
      client.kill();
      await client.waitForExit();
      client.assertCleanOutput();
      await bridge.close();
      life.finishBrowserTaskRun(TEST_UID, cid, `${label}-replacement`);
      life.finishBrowserTaskRun(TEST_UID, cid, label);
    }
  });

  it('lets the OpenCode backend read tasks through its runtime MCP config without adding them to the prompt', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const { opencodeBackend } = await import('../../../../src/main/features/local_agents/backends/opencode');
    const project = await projects.createProject(TEST_UID, 'OpenCode MCP');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    const task = await tasks.createTask(TEST_UID, pid, { title: 'Only visible through the tool' });
    if (!task.ok) throw new Error('task fixture failed');
    const bridge = await startLifecycleBridge('opencode-mcp', pid, 'opencode');
    const config = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8'));
    const sdkRoot = path.join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
    // A deterministic OpenCode protocol consumer, not a model call: real
    // backend -> subprocess env -> MCP stdio -> host socket -> project store.
    fs.writeFileSync(path.join(tmpDir, 'run'), `
      const assert = require('node:assert/strict');
      const { Client } = require(${JSON.stringify(path.join(sdkRoot, 'index.js'))});
      const { StdioClientTransport } = require(${JSON.stringify(path.join(sdkRoot, 'stdio.js'))});
      (async () => {
        assert(!process.argv.join(' ').includes('Only visible through the tool'));
        const server = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.orkas;
        const client = new Client({ name: 'fake-opencode', version: '1' });
        const transport = new StdioClientTransport({
          command: server.command[0], args: server.command.slice(1),
          env: { ...process.env, ...server.environment }, stderr: 'pipe',
        });
        transport.stderr?.on('data', chunk => process.stderr.write(chunk));
        try {
          await client.connect(transport);
          assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['auto_tasks', 'todo_tasks']);
          const result = await client.callTool({ name: 'todo_tasks', arguments: { action: 'list' } });
          assert(!result.isError);
          const tasks = JSON.parse(result.content[0].text).tasks;
          assert.equal(tasks[0].title, 'Only visible through the tool');
          process.stdout.write(JSON.stringify({ type: 'text', part: { text: tasks[0].status } }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: 'opencode-test-session', part: { reason: 'stop' } }) + '\\n');
        } finally { await client.close(); }
      })().catch(() => { process.stderr.write('MCP contract probe failed\\n'); process.exitCode = 1; });
    `);
    try {
      for (const [status, resumeSessionId] of [['todo', undefined], ['review', 'opencode-test-session']] as const) {
        await tasks.updateTask(TEST_UID, pid, task.task.id, { status });
        const events: any[] = [];
        await opencodeBackend.run({
          binPath: TEST_NODE, prompt: 'Read the current backlog', cwd: tmpDir,
          resumeSessionId, signal: new AbortController().signal, timeoutMs: 10_000,
          bridge: { mcpConfigPath: bridge.mcpConfigPath, server: config.mcpServers.orkas },
          onEvent: event => events.push(event),
        });
        expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
        expect(events.find(event => event.type === 'done')).toMatchObject({ status: 'completed', output: status });
        expect(events.find(event => event.type === 'process-info').args).not.toContain('Only visible through the tool');
      }
    } finally { await bridge.close(); }
    expect(fs.existsSync(bridge.serverEnv.ORKAS_BRIDGE_ENV_FILE)).toBe(false);
  });

  it.each(['claude', 'codex', 'opencode'] as const)('exposes scoped task lifecycle operations over the %s MCP bridge', async (cli) => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const created = await projects.createProject(TEST_UID, 'CLI backlog');
    if (!created.ok) throw new Error('project fixture failed');
    const pid = created.project.project_id;
    for (const bound of [false, true]) {
      const bridge = await startLifecycleBridge(`tasks-${bound}`, bound ? pid : undefined, cli);
      const client = new McpStdioClient(bridge.serverEnv);
      try {
        await client.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
        client.notify('notifications/initialized');
        const listed = await client.request(2, 'tools/list', {});
        if (!bound && cli === 'opencode') {
          // With no granted category MCP advertises no tools capability.
          expect(listed.error?.code).toBe(-32601);
          continue;
        }
        const tool = listed.result.tools.find((t: any) => t.name === 'todo_tasks');
        expect(listed.result.tools.map((t: any) => t.name)).not.toContain('project_tasks');
        expect(!!tool).toBe(bound);
        if (!bound) continue;
        const stale = await client.request(22, 'tools/call', { name: 'project_tasks', arguments: { action: 'create', title: 'Stale tool must not write' } });
        expect(stale.result?.isError || stale.error).toBeTruthy();
        expect(bridgeDescriptionBudgetProblems([tool])).toEqual([]);
        expect(tool.inputSchema.properties).not.toHaveProperty('project');
        expect(tool.inputSchema.properties.status.enum).toEqual(['todo', 'progress', 'review', 'done']);
        const { createProjectTasksTool } = await import('../../../../src/core-agent/src/tools/project-tasks-tool');
        const { createProjectTasksHandler } = await import('../../../../src/main/features/project_tasks_tool_handler');
        const native = createProjectTasksTool(createProjectTasksHandler(TEST_UID, pid, 'c-tasks-true', new Map()));
        for (const field of ['offset', 'limit', 'status', 'task_id']) {
          expect(tool.inputSchema.properties[field]).toEqual((native.inputSchema as any).properties[field]);
        }
        const autoTasks = await import('../../../../src/main/features/auto_tasks');
        const automation = await client.request(20, 'tools/call', { name: 'auto_tasks', arguments: { action: 'create', content: 'Daily report', schedule: { type: 'daily', hour: 9, minute: 0 }, enabled: false } });
        expect(automation.result.isError).toBeFalsy();
        const automationId = JSON.parse(automation.result.content[0].text).taskId;
        expect(await autoTasks.getTask(TEST_UID, automationId)).toMatchObject({ project_id: pid, enabled: false });
        const { createAutoTasksTool } = await import('../../../../src/main/features/auto_tasks_tool');
        const nativeAuto = createAutoTasksTool({ userId: TEST_UID, projectId: pid });
        const queryAuto = { action: 'list', enabled: false, offset: 0, limit: 1 };
        const autoPage = await client.request(90, 'tools/call', { name: 'auto_tasks', arguments: queryAuto });
        const nativeAutoPage = JSON.parse((await nativeAuto.execute(queryAuto, { state: {} })).content);
        expect(JSON.parse(autoPage.result.content[0].text)).toEqual(nativeAutoPage);
        expect(nativeAutoPage).toMatchObject({ total: 1, next_offset: null });
        expect(nativeAutoPage.tasks[0]).not.toHaveProperty('content');
        const autoDetail = await client.request(91, 'tools/call', { name: 'auto_tasks', arguments: { action: 'get', task_id: automationId } });
        expect(JSON.parse(autoDetail.result.content[0].text).task.content).toBe('Daily report');
        const enabled = await client.request(21, 'tools/call', { name: 'auto_tasks', arguments: { action: 'enable', task_id: automationId } });
        expect(enabled.result.isError).toBeFalsy();
        expect((await autoTasks.getTask(TEST_UID, automationId))?.enabled).toBe(true);
        const editSchedule = await client.request(23, 'tools/call', { name: 'auto_tasks', arguments: { action: 'update', task_id: automationId, schedule: { type: 'daily', hour: 10, minute: 15 } } });
        expect(editSchedule.result.isError).toBeFalsy();
        expect(await autoTasks.getTask(TEST_UID, automationId)).toMatchObject({ content: 'Daily report', project_id: pid, enabled: true, schedule: { type: 'daily', hour: 10, minute: 15 } });
        const global = await autoTasks.createTask(TEST_UID, { content: 'Foreign schedule', enabled: false, schedule: { type: 'daily', hour: 8, minute: 0 } });
        if (!global.ok) throw new Error('global fixture failed');
        const forbidden = await client.request(24, 'tools/call', { name: 'auto_tasks', arguments: { action: 'enable', task_id: global.task.id } });
        expect(forbidden.result?.isError || forbidden.error).toBeTruthy();
        expect((await autoTasks.getTask(TEST_UID, global.task.id))?.enabled).toBe(false);
        const foreignDetail = await client.request(92, 'tools/call', { name: 'auto_tasks', arguments: { action: 'get', task_id: global.task.id } });
        expect(foreignDetail.result?.isError || foreignDetail.error).toBeTruthy();
        const override = await client.request(25, 'tools/call', { name: 'auto_tasks', arguments: { action: 'update', task_id: automationId, project_id: null } });
        expect(override.result?.isError || override.error).toBeTruthy();
        const disabled = await client.request(26, 'tools/call', { name: 'auto_tasks', arguments: { action: 'disable', task_id: automationId } });
        expect(disabled.result.isError).toBeFalsy();
        expect(await autoTasks.getTask(TEST_UID, automationId)).toMatchObject({ enabled: false, project_id: pid });
        expect(await autoTasks.getTask(TEST_UID, automationId)).not.toHaveProperty('last_run_at');
        const removed = await client.request(27, 'tools/call', { name: 'auto_tasks', arguments: { action: 'delete', task_id: automationId } });
        expect(removed.result.isError).toBeFalsy();
        expect(await autoTasks.getTask(TEST_UID, automationId)).toBeNull();

        const empty = await client.request(3, 'tools/call', { name: 'todo_tasks', arguments: { action: 'list' } });
        expect(JSON.parse(empty.result.content[0].text)).toMatchObject({ ok: true, tasks: [], next_offset: null });
        const creation = await client.request(8, 'tools/call', { name: 'todo_tasks', arguments: { action: 'create', title: 'Read only when requested' } });
        expect(creation.result.isError).toBeFalsy();
        const fresh = await client.request(4, 'tools/call', { name: 'todo_tasks', arguments: { action: 'list' } });
        expect(JSON.parse(fresh.result.content[0].text).tasks).toContainEqual(expect.objectContaining({ title: 'Read only when requested' }));
        const denied = await client.request(5, 'tools/call', { name: 'todo_tasks', arguments: { action: 'complete', task_id: 'forged' } });
        expect(denied.result?.isError || denied.error).toBeTruthy();
        const task = (await tasks.listTasks(TEST_UID, pid))[0];
        expect(task.status).toBe('todo');
        expect(task.origin_cid).toBe('c-tasks-true');
        let invalidStatusId = 29;
        for (const status of ['blocked', 'cancelled', 'in_progress', 'in_review']) {
          for (const args of [
            { action: 'create', title: 'Removed state', status },
            { action: 'update', task_id: task.id, status },
          ]) {
            const rejected = await client.request(invalidStatusId++, 'tools/call', { name: 'todo_tasks', arguments: args });
            expect(rejected.result?.isError || rejected.error).toBeTruthy();
            expect(await tasks.listTasks(TEST_UID, pid)).toEqual([task]);
          }
        }
        const update = await client.request(6, 'tools/call', { name: 'todo_tasks', arguments: { action: 'update', task_id: task.id, status: 'review', result_ref: 'artifact-1', title: 'Edited through MCP', detail: 'Retained requirement' } });
        expect(update.result.isError).toBeFalsy();
        expect(await tasks.getTask(TEST_UID, pid, task.id)).toMatchObject({ status: 'review', result_ref: 'artifact-1', title: 'Edited through MCP', detail: 'Retained requirement' });
        const complete = await client.request(7, 'tools/call', { name: 'todo_tasks', arguments: { action: 'complete', task_id: task.id, result_ref: 'verified-1' } });
        expect(complete.result.isError).toBeFalsy();
        expect(await tasks.getTask(TEST_UID, pid, task.id)).toMatchObject({ status: 'done', result_ref: 'verified-1', origin_cid: 'c-tasks-true' });
        const reopened = await createProjectTasksHandler(TEST_UID, pid, 'new-native-chat', new Map()).update(task.id, { status: 'todo' });
        expect(reopened.task).toMatchObject({ status: 'todo', origin_cid: 'c-tasks-true', result_ref: 'verified-1' });
        const reread = await client.request(28, 'tools/call', { name: 'todo_tasks', arguments: { action: 'list' } });
        expect(JSON.parse(reread.result.content[0].text).tasks).toContainEqual(expect.objectContaining({ id: task.id, status: 'todo' }));
        const queryTodo = { action: 'list', offset: 0, limit: 50, status: 'todo' };
        const page = await client.request(93, 'tools/call', { name: 'todo_tasks', arguments: queryTodo });
        expect(JSON.parse(page.result.content[0].text)).toEqual(JSON.parse((await native.execute(queryTodo, { state: {} })).content));
        expect(JSON.parse(page.result.content[0].text).tasks[0]).not.toHaveProperty('detail');
        const detail = await client.request(94, 'tools/call', { name: 'todo_tasks', arguments: { action: 'get', task_id: task.id } });
        expect(JSON.parse(detail.result.content[0].text).task).toMatchObject({ detail: 'Retained requirement', result_ref: 'verified-1' });
      } finally {
        client.kill();
        await client.waitForExit();
        await bridge.close();
        client.assertCleanOutput();
      }
    }
  });

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
      cli: 'codex',
      permissionPolicy: 'ask',
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
        'library', 'chat_history', 'cross_session_memory',
        'orkas_handoff_to_commander',
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        'orkas_kb_list', 'orkas_kb_search', 'orkas_kb_read',
        'chat_search', 'chat_read',
      ]));
      expect(names).not.toContain('browser');
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

  it.each(['claude', 'codex'] as const)('exposes scoped project writes over the %s MCP bridge', async (cli) => {
    const projects = await import('../../../../src/main/features/projects');
    const workspace = await import('../../../../src/main/features/user_workspace');
    const files = await import('../../../../src/main/features/project_files');
    const memory = await import('../../../../src/main/features/memory');
    const created = await projects.createProject(TEST_UID, 'MCP project context');
    if (!created.ok) throw new Error('fixture failed');
    const pid = created.project.project_id;
    workspace.setWorkspacePath(TEST_UID, tmpDir, pid);
    fs.writeFileSync(path.join(tmpDir, 'deliverable.md'), 'MCP deliverable');
    const bridge = await startLifecycleBridge(`project-write-${cli}`, pid, cli);
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      await client.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
      client.notify('notifications/initialized', {});
      const listed = await client.request(2, 'tools/list', {});
      expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['project_instructions', 'library_save']));
      expect(listed.result.tools.find((tool: any) => tool.name === 'cross_session_memory').inputSchema.properties.target.enum)
        .toEqual(['agent', 'project']);
      expect(bridgeDescriptionBudgetProblems(listed.result.tools)).toEqual([]);
      let id = 2;
      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await client.request(++id, 'tools/call', { name, arguments: args });
        expect(reply.error).toBeUndefined();
        return reply.result;
      };
      expect((await call('project_instructions', { instructions: 'Keep delivery accessible.' })).isError).toBeFalsy();
      expect(await projects.readProjectInstructions(TEST_UID, pid)).toMatchObject({ content: 'Keep delivery accessible.' });
      expect((await call('cross_session_memory', { action: 'add', target: 'project', content: 'The audience uses keyboards.' })).isError).toBeFalsy();
      expect(memory.listEntries(TEST_UID, { project: pid }).entries).toEqual(['The audience uses keyboards.']);
      expect((await call('library_save', { source_path: 'deliverable.md' })).isError).toBeFalsy();
      const checkout = await call('library_save', { action: 'checkout', name: 'deliverable.md', source_path: 'revision.md' });
      expect(checkout.isError).toBeFalsy();
      const receipt = JSON.parse(checkout.content[0].text);
      fs.writeFileSync(path.join(tmpDir, 'revision.md'), 'MCP revision');
      expect((await call('library_save', { name: 'deliverable.md', source_path: 'revision.md', expected_revision: receipt.revision })).isError).toBeFalsy();
      expect(await files.readProjectTextFile(TEST_UID, pid, 'deliverable.md')).toMatchObject({ content: 'MCP revision' });
      expect((await call('library_save', { source_path: 'deliverable.md' })).isError).toBe(true);
      expect((await call('todo_tasks', { action: 'complete', task_id: 'forged' })).isError).toBe(true);
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
    }
    client.assertCleanOutput();
  });

  it.each(['claude', 'codex'] as const)('lets %s edit a native Agent deliverable and makes the changes visible to a fresh native turn', async (cli) => {
    // Exercise real MCP, role gates and disk IO without starting a model-backed
    // indexer. Independently verify each committed version requests an upsert.
    const indexUpdates: unknown[][] = [];
    vi.doMock('../../../../src/main/features/project_library_indexer', () => ({
      enqueue: (...args: unknown[]) => { indexUpdates.push(args); },
    }));
    const projects = await import('../../../../src/main/features/projects');
    const workspace = await import('../../../../src/main/features/user_workspace');
    const memory = await import('../../../../src/main/features/memory');
    const files = await import('../../../../src/main/features/project_files');
    const auth = await import('../../../../src/main/features/auth');
    const profile = await auth.addApiKey('anthropic', 'fixture-only-no-model-calls', 'Test');
    await auth.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: profile.profileId });
    const project = await projects.createProject(TEST_UID, 'Cross-runtime editing');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    expect(workspace.setWorkspacePath(TEST_UID, tmpDir, pid).ok).toBe(true);
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const nativeTurn = async (turn: string) => {
      const built = await buildRunner({
        sessionId: `gmember-cross-runtime-${turn}`, userId: TEST_UID, projectId: pid,
        agentId: 'native-author', toolList: ['workspace.write.output'],
      });
      const runner = built.runner as unknown as {
        activeTools(): Array<{ name: string; execute(input: Record<string, unknown>, ctx: unknown): Promise<{ content: string; isError?: boolean }> }>;
      };
      return async (name: string, input: Record<string, unknown>) => {
        const tool = runner.activeTools().find((entry) => entry.name === name);
        expect(tool, `native turn must expose ${name}`).toBeDefined();
        const result = await tool!.execute(input, { workingDir: tmpDir, state: {} });
        expect(result.isError, result.content).toBeFalsy();
        return JSON.parse(result.content);
      };
    };
    const native = await nativeTurn('before');
    const initialRules = 'Preserve keyboard access.';
    const initialFact = 'The supported locale is English.';
    await native('project_instructions', { instructions: initialRules });
    await native('cross_session_memory', { action: 'add', target: 'project', content: initialFact });
    await native('cross_session_memory', { action: 'add', target: 'agent', content: 'Native private note.' });
    fs.writeFileSync(path.join(tmpDir, 'shared.md'), 'Native draft.');
    await native('library_save', { source_path: 'shared.md' });

    const label = `cross-runtime-${cli}`;
    const bridge = await startLifecycleBridge(label, pid, cli);
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      await client.request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
      client.notify('notifications/initialized');
      let id = 1;
      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await client.request(++id, 'tools/call', { name, arguments: args });
        expect(reply.error).toBeUndefined();
        expect(reply.result.isError, JSON.stringify(reply.result)).toBeFalsy();
        return JSON.parse(reply.result.content[0].text);
      };
      expect((await call('cross_session_memory', { action: 'list', target: 'project' })).entries).toEqual([initialFact]);
      expect((await call('cross_session_memory', { action: 'list', target: 'agent' })).entries).toEqual([]);
      const revisedFact = 'The supported locales are English and Chinese.';
      await call('cross_session_memory', { action: 'replace', target: 'project', old_text: initialFact, content: revisedFact });
      await call('cross_session_memory', { action: 'add', target: 'agent', content: 'CLI private note.' });
      const revisedRules = `${initialRules}\nTranslate visible controls.`;
      await call('project_instructions', { instructions: revisedRules });
      const checkout = await call('library_save', { action: 'checkout', name: 'shared.md', source_path: 'cli-edit.md' });
      expect(fs.readFileSync(path.join(tmpDir, 'cli-edit.md'), 'utf8')).toBe('Native draft.');
      fs.writeFileSync(path.join(tmpDir, 'cli-edit.md'), 'Native draft.\nCLI revision.');
      await call('library_save', { name: 'shared.md', source_path: 'cli-edit.md', expected_revision: checkout.revision });
      expect(await projects.readProjectInstructions(TEST_UID, pid)).toMatchObject({ content: revisedRules });
      expect(memory.listEntries(TEST_UID, { project: pid }).entries).toEqual([revisedFact]);
      expect(await files.readProjectTextFile(TEST_UID, pid, 'shared.md')).toMatchObject({ content: 'Native draft.\nCLI revision.' });

      // A rebuilt native runner reads CLI changes and may continue editing;
      // neither runtime gets ownership of the other Agent's private memory.
      const nextNative = await nativeTurn('after');
      expect((await nextNative('cross_session_memory', { action: 'list', target: 'project' })).entries).toEqual([revisedFact]);
      expect((await nextNative('cross_session_memory', { action: 'list', target: 'agent' })).entries).toEqual(['Native private note.']);
      const nextCopy = await nextNative('library_save', { action: 'checkout', name: 'shared.md', source_path: 'native-again.md' });
      expect(fs.readFileSync(path.join(tmpDir, 'native-again.md'), 'utf8')).toBe('Native draft.\nCLI revision.');
      fs.writeFileSync(path.join(tmpDir, 'native-again.md'), 'Native draft.\nCLI revision.\nNative follow-up.');
      await nextNative('library_save', { name: 'shared.md', source_path: 'native-again.md', expected_revision: nextCopy.revision });
      await nextNative('project_instructions', { instructions: `${revisedRules}\nReview focus order.` });
      await nextNative('cross_session_memory', { action: 'remove', target: 'project', old_text: revisedFact });
      expect((await call('cross_session_memory', { action: 'list', target: 'project' })).entries).toEqual([]);
      expect((await call('cross_session_memory', { action: 'list', target: 'agent' })).entries).toEqual(['CLI private note.']);
      expect(await projects.readProjectInstructions(TEST_UID, pid)).toMatchObject({ content: `${revisedRules}\nReview focus order.` });
      expect(await files.readProjectTextFile(TEST_UID, pid, 'shared.md')).toMatchObject({ content: 'Native draft.\nCLI revision.\nNative follow-up.' });
      expect(indexUpdates).toEqual([
        [TEST_UID, pid, 'shared.md', 'upsert'],
        [TEST_UID, pid, 'shared.md', 'upsert'],
        [TEST_UID, pid, 'shared.md', 'upsert'],
      ]);
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
    }
    client.assertCleanOutput();
  });

  it('exposes caller-bound Agent memory and persists it through the CLI bridge', async () => {
    const bridge = await startLifecycleBridge('memory');
    const client = new McpStdioClient(bridge.serverEnv);
    try {
      await client.request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized');

      const tools = await client.request(2, 'tools/list', {});
      expect(tools.result.tools.map((tool: any) => tool.name)).not.toContain('project_instructions');
      expect(tools.result.tools.map((tool: any) => tool.name)).not.toContain('library_save');
      const memoryTool = tools.result.tools.find(
        (tool: any) => tool.name === 'cross_session_memory',
      );
      expect(memoryTool).toBeTruthy();
      expect(memoryTool.description).toContain('Decide from meaning, not trigger words');
      expect(memoryTool.description).toContain('stable, reusable information');
      expect(memoryTool.description).toContain('future conversations');
      expect(memoryTool.description).toContain('replace a correction');
      expect(memoryTool.description).toContain('Do not store current-task progress');
      expect(memoryTool.inputSchema.properties.target.enum).toContain('agent');
      expect(memoryTool.inputSchema.properties).not.toHaveProperty('agent_id');

      const added = await client.request(3, 'tools/call', {
        name: 'cross_session_memory',
        arguments: {
          action: 'add',
          target: 'agent',
          content: 'CLI memory survives future runs',
        },
      });
      expect(added.result.isError).not.toBe(true);

      const memoryFile = path.join(
        tmpDir,
        TEST_UID,
        'cloud',
        'memory',
        'agents',
        'a-memory',
        'MEMORY.md',
      );
      expect(fs.readFileSync(memoryFile, 'utf8')).toBe('CLI memory survives future runs');

      const listed = await client.request(4, 'tools/call', {
        name: 'cross_session_memory',
        arguments: { action: 'list' },
      });
      expect(JSON.parse(listed.result.content[0].text)).toMatchObject({
        ok: true,
        entries: ['CLI memory survives future runs'],
      });

      const replaced = await client.request(5, 'tools/call', {
        name: 'cross_session_memory',
        arguments: {
          action: 'replace',
          target: 'agent',
          old_text: 'CLI memory survives future runs',
          content: 'CLI memory was corrected',
        },
      });
      expect(replaced.result.isError).not.toBe(true);
      expect(fs.readFileSync(memoryFile, 'utf8')).toBe('CLI memory was corrected');

      const invalid = await client.request(6, 'tools/call', {
        name: 'cross_session_memory',
        arguments: { action: 'add', target: 'agent' },
      });
      expect(invalid.result.isError).toBe(true);
      expect(JSON.parse(invalid.result.content[0].text).error).toContain('empty content');
      expect(fs.readFileSync(memoryFile, 'utf8')).toBe('CLI memory was corrected');

      const removed = await client.request(7, 'tools/call', {
        name: 'cross_session_memory',
        arguments: {
          action: 'remove',
          old_text: 'CLI memory was corrected',
        },
      });
      expect(removed.result.isError).not.toBe(true);
      expect(fs.readFileSync(memoryFile, 'utf8')).toBe('');
      expect(fs.existsSync(path.join(
        tmpDir,
        TEST_UID,
        'cloud',
        'memory',
        'agents',
        'another-agent',
        'MEMORY.md',
      ))).toBe(false);
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
    }
    client.assertCleanOutput();
  }, 20000);

  it('discovers connector tools and follows operation-mode changes in the same live CLI process', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [
        { name: 'GMAIL_FETCH_EMAILS', description: 'Read mail', input_schema: {} },
        { name: 'GMAIL_SEND_EMAIL', description: 'Send mail', input_schema: {} },
      ],
    }] as any);
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const actionConfirm = await import('../../../../src/main/features/connectors/action_confirm');
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    const prompts: string[] = [];
    actionConfirm._setBroadcastForTest((channel, payload: any) => {
      prompts.push(channel);
      if (channel === 'connectors:action-confirm') queueMicrotask(() => actionConfirm.respond(payload.request_id, false));
    });
    cliPermissions._setBroadcastForTest((channel, payload: any) => {
      prompts.push(channel);
      if (channel === 'local-agent:permission') queueMicrotask(() => cliPermissions.respond(payload.request_id, 'deny'));
    });
    const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
    const bridge = await startBridge({
      uid: TEST_UID,
      cid: 'c2',
      agentId: 'a2',
      agentName: 'Connector Agent',
      cli: 'codex',
      permissionPolicy: 'ask',
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
      bridgeConnectorMock.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'messages found: 2' }] });
      const read = await client.request(3, 'tools/call', {
        name: 'orkas_call_connector_tool',
        arguments: { connector_id: 'gmail', tool_name: 'GMAIL_FETCH_EMAILS', args: { max_results: 2 } },
      });
      expect(read.result.isError).not.toBe(true);
      expect(read.result.content[0].text).toContain('messages found: 2');
      expect(prompts).toEqual([]);

      // A changed account setting must take effect without restarting the CLI.
      permissions.setLocalExecMode('all_files_auto');
      bridgeConnectorMock.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'sent: message-3' }] });
      const sendArgs = { recipient_email: 'reader@example.com', subject: 'Update', body: 'Ready.' };
      const sent = await client.request(4, 'tools/call', {
        name: 'orkas_call_connector_tool',
        arguments: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: sendArgs },
      });
      expect(sent.result.isError).not.toBe(true);
      expect(sent.result.content[0].text).toContain('sent: message-3');
      expect(prompts).toEqual([]);
      expect(bridgeConnectorMock.callTool).toHaveBeenCalledTimes(2);
      expect(bridgeConnectorMock.callTool).toHaveBeenLastCalledWith(
        TEST_UID, 'gmail', 'GMAIL_SEND_EMAIL', sendArgs, expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
      actionConfirm._setBroadcastForTest(null);
      cliPermissions._setBroadcastForTest(null);
    }
    client.assertCleanOutput();
  }, 20000);

  it('withdraws the host approval when the real bridge client times out first', async () => {
    // Production shape: the CLI's MCP call gives up before the user answers.
    // The client must tell the host, the prompt must be withdrawn, and a late
    // "allow" must not run the connector action the model already reported as
    // failed. The client timeout is shortened through env for this test.
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
    }] as any);
    const actionConfirm = await import('../../../../src/main/features/connectors/action_confirm');
    const deliveries: Array<{ channel: string; payload: any }> = [];
    actionConfirm._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
    const bridge = await startBridge({
      uid: TEST_UID,
      cid: 'c3',
      agentId: 'a3',
      agentName: 'Connector Agent',
      cli: 'codex',
      permissionPolicy: 'ask',
      currentMessageId: 'current-message',
      runId: `e2e-connector-timeout-${Date.now().toString(36)}`,
      configDir: path.join(tmpDir, 'connector-timeout-rundir'),
      sandboxEnv: {
        ORKAS_NODE: TEST_NODE,
        ORKAS_BUNDLED_NODE: TEST_NODE,
        ORKAS_PC_DIR: process.cwd(),
        ORKAS_WORKSPACE_ROOT: tmpDir,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    const client = new McpStdioClient({ ...bridge.serverEnv, ORKAS_BRIDGE_RPC_SLOW_TIMEOUT_MS: '600' });
    try {
      await client.request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized');
      const call = await client.request(2, 'tools/call', {
        name: 'orkas_call_connector_tool',
        arguments: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: { to: 'test@example.com' } },
      });
      expect(call.result.isError).toBe(true);
      expect(JSON.stringify(call.result.content)).toContain('timed out');

      const prompt = deliveries.find((entry) => entry.channel === 'connectors:action-confirm');
      expect(prompt).toBeTruthy();
      await waitFor(() => deliveries.some((entry) => entry.channel === 'connectors:action-confirm-cancelled'));
      expect(deliveries).toContainEqual({
        channel: 'connectors:action-confirm-cancelled',
        payload: { request_ids: [prompt!.payload.request_id], cid: 'c3' },
      });
      expect(actionConfirm.respond(prompt!.payload.request_id, true)).toBe(false);
      expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
    } finally {
      client.kill();
      await client.waitForExit();
      await bridge.close();
      actionConfirm._setBroadcastForTest(null);
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
