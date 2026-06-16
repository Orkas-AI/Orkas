import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// addCustomInstance + the custom branch of `_resolveTransport` (manager.ts).
// MCP connections are mocked — these tests pin the registry/consent
// contract, not the network.

const TEST_UID = 'u-connectors-custom';

let tmpDir: string;
let prevWs: string | undefined;

function mockMcpClient(behavior: { failConnect?: boolean } = {}) {
  vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
    McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
      return {
        connect: vi.fn(async () => {
          if (behavior.failConnect) throw new Error('boom: connection refused by test');
        }),
        listTools: vi.fn(async () => [{ name: 'noop', description: '', input_schema: {} }]),
        close: vi.fn(async () => {}),
        callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
        get isConnected() { return true; },
      };
    }),
  }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conn-custom-'));
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

describe('connectors/manager › addCustomInstance', () => {
  it('stores origin=custom, probes the server, and encrypts the transport at rest', async () => {
    mockMcpClient();
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = await manager.addCustomInstance(TEST_UID, {
      display_name: 'My Server',
      transport: { kind: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sk-secret' } },
    });

    expect(inst.id).toBe('custom-my-server');
    expect(inst.origin).toBe('custom');
    expect(inst.status.kind).toBe('connected');
    expect(inst.tools_cache.map((t) => t.name)).toEqual(['noop']);

    // At-rest invariant: the raw connectors.json must NOT leak the header
    // secret — the transport lives inside secrets_enc.
    const paths = await import('../../../../src/main/paths');
    const rawDisk = fs.readFileSync(paths.userConnectorsConfigFile(TEST_UID), 'utf8');
    expect(rawDisk).not.toContain('sk-secret');
    expect(rawDisk).toContain('secrets_enc');

    // Round-trip via the registry restores the decrypted transport.
    const registry = await import('../../../../src/main/features/connectors/registry');
    const loaded = registry.load(TEST_UID).connections['custom-my-server']!;
    expect(loaded.transport).toEqual(inst.transport);
    expect(loaded.origin).toBe('custom');
  });

  it('suffixes the id on display-name collisions', async () => {
    mockMcpClient();
    const manager = await import('../../../../src/main/features/connectors/manager');
    const a = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Dup', transport: { kind: 'streamable-http', url: 'https://a.example/mcp' },
    });
    const b = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Dup', transport: { kind: 'streamable-http', url: 'https://b.example/mcp' },
    });
    expect(a.id).toBe('custom-dup');
    expect(b.id).toBe('custom-dup-2');
  });

  it('keeps a failed probe as an error-status instance instead of dropping it', async () => {
    mockMcpClient({ failConnect: true });
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Dead Server', transport: { kind: 'streamable-http', url: 'https://dead.example/mcp' },
    });
    expect(inst.status.kind).toBe('error');
    const registry = await import('../../../../src/main/features/connectors/registry');
    expect(registry.load(TEST_UID).connections['custom-dead-server']).toBeTruthy();
  });

  it('rejects invalid input through the validation gate', async () => {
    mockMcpClient();
    const manager = await import('../../../../src/main/features/connectors/manager');
    await expect(manager.addCustomInstance(TEST_UID, {
      display_name: 'X', transport: { kind: 'streamable-http', url: 'http://not-local.example/mcp' },
    })).rejects.toMatchObject({ code: 'E_URL_INSECURE' });
  });

  it('callTool works on a custom instance without a catalog entry or grant', async () => {
    mockMcpClient();
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Tooly', transport: { kind: 'stdio', command: 'mcp-server', args: [] },
    });
    const result = await manager.callTool(TEST_UID, inst.id, 'noop', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });
});
