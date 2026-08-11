import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  private waiters = new Map<number, (msg: any) => void>();
  constructor(env: Record<string, string>) {
    this.child = spawn(TEST_NODE, [path.join(process.cwd(), 'bin', 'orkas-bridge.cjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = this.waiters.get(msg.id);
        if (waiter) { this.waiters.delete(msg.id); waiter(msg); }
      }
    });
  }
  request(id: number, method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`mcp timeout: ${method}`)); }, timeoutMs);
      this.waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  kill(): void {
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

describe('orkas-bridge.cjs › MCP stdio e2e', () => {
  it('initializes, lists tools, and proxies orkas_list_skills through the socket', async () => {
    // Fixture skill in the trusted custom root.
    const skillDir = path.join(tmpDir, TEST_UID, 'cloud', 'skills', 'demo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nbody');

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
        'orkas_kb_list', 'orkas_kb_search', 'orkas_kb_read',
        'chat_search', 'chat_read',
        'orkas_handoff_to_commander',
      ]));
      expect(names).not.toContain('orkas_list_connector_tools');
      expect(names).not.toContain('orkas_call_connector_tool');
      const chatRead = tools.result.tools.find((tool: any) => tool.name === 'chat_read');
      expect(chatRead.inputSchema.properties.before_msg_index.type).toBe('integer');

      const call = await client.request(3, 'tools/call', { name: 'orkas_list_skills', arguments: {} });
      const text = call.result.content[0].text as string;
      expect(text).toContain('demo-skill');

      const read = await client.request(4, 'tools/call', { name: 'orkas_read_skill', arguments: { id: 'demo-skill' } });
      expect(read.result.content[0].text).toContain('body');

      const handoff = await client.request(5, 'tools/call', {
        name: 'orkas_handoff_to_commander',
        arguments: { reason: 'Needs Commander automation.', context: 'Daily at 08:00.' },
      });
      expect(handoff.result.content[0].text).toContain('Handoff recorded');
      expect(bridge.getCommanderHandoff()).toEqual({
        reason: 'Needs Commander automation.',
        context: 'Daily at 08:00.',
      });
    } finally {
      client.kill();
      await bridge.close();
    }
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
      const connectorTools = tools.result.tools.filter((tool: any) => (
        tool.name === 'orkas_list_connector_tools' || tool.name === 'orkas_call_connector_tool'
      ));
      expect(connectorTools.every((tool: any) => (
        String(tool.description || '').includes('ordinary Orkas group-chat Agent')
      ))).toBe(true);
      expect(connectorTools.some((tool: any) => (
        String(tool.description || '').includes('explicitly enabled for this CLI Agent')
      ))).toBe(false);
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID, undefined);
    } finally {
      client.kill();
      await bridge.close();
    }
  }, 20000);
});
