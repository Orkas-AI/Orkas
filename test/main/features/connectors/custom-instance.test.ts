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

function mockMcpClient(behavior: { failConnect?: boolean; onTransport?: (transport: unknown) => void } = {}) {
  vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
    McpConnection: vi.fn().mockImplementation(function MockMcpConnection(_id: string, transport: unknown) {
      behavior.onTransport?.(transport);
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
  vi.doUnmock('../../../../src/main/features/connectors/oauth-dcr');
  vi.doUnmock('../../../../src/main/features/connectors/oauth-events');
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

  it('rejects OAuth on stdio and conflicting Authorization headers', async () => {
    mockMcpClient();
    const manager = await import('../../../../src/main/features/connectors/manager');
    await expect(manager.addCustomInstance(TEST_UID, {
      display_name: 'Bad stdio OAuth', auth_mode: 'oauth',
      transport: { kind: 'stdio', command: 'mcp-server' },
    })).rejects.toMatchObject({ code: 'E_AUTH_MODE' });
    await expect(manager.addCustomInstance(TEST_UID, {
      display_name: 'Bad header OAuth', auth_mode: 'oauth',
      transport: { kind: 'streamable-http', url: 'https://mcp.example/mcp', headers: { authorization: 'Bearer old' } },
    })).rejects.toMatchObject({ code: 'E_AUTH_MODE' });
  });

  it('authorizes custom HTTP MCP, refreshes a rotating grant, and never persists a bearer header', async () => {
    const transports: Array<{ headers?: Record<string, string> }> = [];
    mockMcpClient({ onTransport: (transport) => transports.push(transport as { headers?: Record<string, string> }) });
    const refresh = vi.fn(async (_client, grant) => grant.expires_at > Date.now()
      ? grant
      : { ...grant, access_token: 'new-access-secret', refresh_token: 'new-refresh-secret',
        expires_at: Date.now() + 3600_000 });
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../../../src/main/features/connectors/oauth-dcr')>(),
      startCustomMcpOAuth: vi.fn(async () => ({
        grant: { access_token: 'old-access-secret', refresh_token: 'old-refresh-secret',
          expires_at: Date.now() + 3600_000, scopes: [], token_type: 'Bearer' },
        client: { client_id: 'custom-client', token_endpoint: 'https://auth.example/token',
          authorization_endpoint: 'https://auth.example/authorize', resource: 'https://mcp.example/mcp' },
      })),
      refreshDcrIfStale: refresh,
    }));
    const manager = await import('../../../../src/main/features/connectors/manager');
    const instance = await manager.addCustomInstance(TEST_UID, {
      display_name: 'OAuth MCP', auth_mode: 'oauth',
      transport: { kind: 'streamable-http', url: 'https://mcp.example/mcp', headers: { 'X-Custom': 'ok' } },
    });
    expect(instance.status.kind).toBe('connected');
    expect(instance.custom_auth_mode).toBe('oauth');
    expect(transports[0]?.headers).toMatchObject({ Authorization: 'Bearer old-access-secret', 'X-Custom': 'ok' });
    const registry = await import('../../../../src/main/features/connectors/registry');
    const stored = registry.load(TEST_UID).connections[instance.id]!;
    expect(stored.transport).toEqual(instance.transport);
    expect((stored.transport as { headers?: Record<string, string> }).headers?.Authorization).toBeUndefined();
    await registry.update(TEST_UID, instance.id, (current) => ({ ...current,
      oauth_grant: { ...current.oauth_grant!, expires_at: Date.now() - 1 },
    }));
    await manager.refreshTools(TEST_UID, instance.id);
    expect(transports.at(-1)?.headers?.Authorization).toBe('Bearer new-access-secret');
    expect(registry.load(TEST_UID).connections[instance.id]?.oauth_grant?.refresh_token).toBe('new-refresh-secret');
    const paths = await import('../../../../src/main/paths');
    const rawDisk = fs.readFileSync(paths.userConnectorsConfigFile(TEST_UID), 'utf8');
    expect(rawDisk).not.toMatch(/old-access-secret|old-refresh-secret|new-access-secret|new-refresh-secret/);
  });

  it('retains a failed OAuth registration as a reconnectable custom instance', async () => {
    mockMcpClient();
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../../../src/main/features/connectors/oauth-dcr')>(),
      startCustomMcpOAuth: vi.fn(async () => { throw new Error('DCR registration failed: HTTP 403'); }),
    }));
    const manager = await import('../../../../src/main/features/connectors/manager');
    const instance = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Restricted MCP', auth_mode: 'oauth',
      transport: { kind: 'streamable-http', url: 'https://mcp.example/mcp' },
    });
    expect(instance).toMatchObject({ origin: 'custom', custom_auth_mode: 'oauth',
      status: { kind: 'error', message: 'DCR registration failed: HTTP 403' } });
    const registry = await import('../../../../src/main/features/connectors/registry');
    expect(registry.load(TEST_UID).connections[instance.id]?.custom_auth_mode).toBe('oauth');
    await expect(manager.authorizeCustomInstance(TEST_UID, instance.id)).rejects.toThrow('HTTP 403');
  });

  it('starts browser authorization after the add request returns and reports completion', async () => {
    mockMcpClient();
    let finish!: (result: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const outcome = vi.fn();
    vi.doMock('../../../../src/main/features/connectors/oauth-events', () => ({
      broadcastOAuthConnectOutcome: outcome, broadcastOAuthConnectProgress: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../../../src/main/features/connectors/oauth-dcr')>(),
      startCustomMcpOAuth: vi.fn(() => pending),
    }));
    const manager = await import('../../../../src/main/features/connectors/manager');
    const draft = await manager.addCustomInstance(TEST_UID, {
      display_name: 'Async OAuth MCP', auth_mode: 'oauth',
      transport: { kind: 'streamable-http', url: 'https://mcp.example/mcp' },
    }, { deferOAuth: true });
    expect(draft.status.kind).toBe('connecting');
    const started = manager.beginCustomOAuthConnect(TEST_UID, draft.id);
    expect(started.attempt_id).toBeTruthy();
    expect(outcome).not.toHaveBeenCalled();
    finish({ grant: { access_token: 'access-secret', refresh_token: null, expires_at: null,
      scopes: [], token_type: 'Bearer' }, client: { client_id: 'client', token_endpoint: 'https://login.example/token',
      authorization_endpoint: 'https://login.example/authorize' } });
    await vi.waitFor(() => expect(outcome).toHaveBeenCalledWith(expect.objectContaining({
      attempt_id: started.attempt_id, catalog_id: draft.id, result: 'success',
    })));
    const registry = await import('../../../../src/main/features/connectors/registry');
    expect(registry.load(TEST_UID).connections[draft.id]?.status.kind).toBe('connected');
  });
});
