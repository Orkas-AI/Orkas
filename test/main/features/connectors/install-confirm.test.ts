import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Commander-driven custom MCP install: confirm gate + the add_custom_connector
// tool. The actual MCP connection is mocked; these pin the consent flow
// (the LLM cannot install without the user's dialog approval).

const TEST_UID = 'u-install-confirm';
let tmpDir: string;
let prevWs: string | undefined;

function mockMcpClient() {
  vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
    McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
      return {
        connect: vi.fn(async () => {}),
        listTools: vi.fn(async () => [{ name: 'noop', description: '', input_schema: {} }]),
        close: vi.fn(async () => {}),
        callTool: vi.fn(async () => ({})),
        get isConnected() { return true; },
      };
    }),
  }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-install-confirm-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connectors/install_confirm', () => {
  it('pushes a confirm request and resolves with the user verdict', async () => {
    const ic = await import('../../../../src/main/features/connectors/install_confirm');
    const pushed: any[] = [];
    ic._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = ic.requestInstallConfirm({
        cid: 'c1',
        displayName: 'My Server',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'srv'] },
      });
      expect(pushed).toHaveLength(1);
      expect(pushed[0].summary).toContain('npx -y srv');
      expect(pushed[0].kind).toBe('stdio');
      expect(ic.respond(pushed[0].request_id, true)).toBe(true);
      await expect(p).resolves.toBe(true);
    } finally {
      ic._setBroadcastForTest(null);
    }
  });

  it('stale / unknown respond ids are ignored, cancelForCid declines pending', async () => {
    const ic = await import('../../../../src/main/features/connectors/install_confirm');
    ic._setBroadcastForTest(() => {});
    try {
      expect(ic.respond('nope', true)).toBe(false);
      const p = ic.requestInstallConfirm({
        cid: 'c9', displayName: 'X', transport: { kind: 'streamable-http', url: 'https://x.example/mcp' },
      });
      ic.cancelForCid('c9');
      await expect(p).resolves.toBe(false);
    } finally {
      ic._setBroadcastForTest(null);
    }
  });
});

describe('add_custom_connector tool', () => {
  async function buildTool() {
    const ic = await import('../../../../src/main/features/connectors/install_confirm');
    const metaMod = await import('../../../../src/main/model/core-agent/connector-meta-tools');
    const tools = await metaMod.createConnectorMetaTools({ userId: TEST_UID, cid: 'c1' }, 'full');
    const tool = tools.find((t) => t.name === 'add_custom_connector');
    return { ic, tool };
  }

  it('is exposed to the commander even with zero connectors installed', async () => {
    mockMcpClient();
    const { tool } = await buildTool();
    expect(tool).toBeTruthy();
  });

  it('is NOT exposed in discover (agent-edit) mode', async () => {
    mockMcpClient();
    const metaMod = await import('../../../../src/main/model/core-agent/connector-meta-tools');
    const tools = await metaMod.createConnectorMetaTools({ userId: TEST_UID, cid: 'c1' }, 'discover');
    expect(tools.find((t) => t.name === 'add_custom_connector')).toBeUndefined();
  });

  it('installs only after the user approves the confirm dialog', async () => {
    mockMcpClient();
    const { ic, tool } = await buildTool();
    const pushed: any[] = [];
    ic._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const exec = tool!.execute(
        { name: 'My Server', transport: { kind: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
        { state: {} } as never,
      );
      // The tool is blocked on the confirm push; approve it.
      await vi.waitFor(() => expect(pushed).toHaveLength(1));
      ic.respond(pushed[0].request_id, true);
      const result = await exec;
      expect(result.isError).toBeFalsy();
      expect(String(result.content)).toContain('Connected');

      const registry = await import('../../../../src/main/features/connectors/registry');
      const conns = registry.load(TEST_UID).connections;
      const custom = Object.values(conns).find((c) => c.origin === 'custom');
      expect(custom).toBeTruthy();
    } finally {
      ic._setBroadcastForTest(null);
    }
  });

  it('does not install when the user declines', async () => {
    mockMcpClient();
    const { ic, tool } = await buildTool();
    const pushed: any[] = [];
    ic._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const exec = tool!.execute(
        { name: 'Nope', transport: { kind: 'stdio', command: 'evil', args: [] } },
        { state: {} } as never,
      );
      await vi.waitFor(() => expect(pushed).toHaveLength(1));
      ic.respond(pushed[0].request_id, false);
      const result = await exec;
      expect(String(result.content)).toContain('declined');

      const registry = await import('../../../../src/main/features/connectors/registry');
      expect(Object.keys(registry.load(TEST_UID).connections)).toHaveLength(0);
    } finally {
      ic._setBroadcastForTest(null);
    }
  });

  it('rejects invalid transport before any confirm push', async () => {
    mockMcpClient();
    const { ic, tool } = await buildTool();
    const pushed: any[] = [];
    ic._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const result = await tool!.execute(
        { name: 'Bad', transport: { kind: 'streamable-http', url: 'http://not-local.example/mcp' } },
        { state: {} } as never,
      );
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain('E_URL_INSECURE');
      expect(pushed).toHaveLength(0);
    } finally {
      ic._setBroadcastForTest(null);
    }
  });
});
