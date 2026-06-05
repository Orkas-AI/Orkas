import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_UID = 'u-connectors-manager';

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

function googleInstance(id: 'gmail' | 'gsheets', scopes: string[]) {
  const now = new Date().toISOString();
  return {
    id,
    display_name: id === 'gmail' ? 'Gmail' : 'Google Sheets',
    transport: {
      kind: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
      env: { GOOGLE_ACCESS_TOKEN: 'access-token' },
    },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
      scopes,
      token_type: 'Bearer',
      account_label: 'user@example.com',
    },
    created_at: now,
    updated_at: now,
  };
}

function githubGrant() {
  return {
    access_token: 'ghu-token',
    refresh_token: null,
    expires_at: Date.now() + 60 * 60 * 1000,
    scopes: [],
    token_type: 'Bearer',
    account_label: 'octo',
    server_grant_id: 'grant-1',
    server_managed: true,
  };
}

function notionInstance() {
  const now = new Date().toISOString();
  return {
    id: 'notion',
    display_name: 'Notion',
    transport: {
      kind: 'streamable-http' as const,
      url: 'https://mcp.notion.com/mcp',
      headers: { Authorization: 'Bearer access-token' },
    },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 1,
      scopes: [],
      token_type: 'Bearer',
    },
    dcr_client: {
      client_id: 'client-id',
      client_secret: 'client-secret',
      authorization_endpoint: 'https://auth.notion.example/authorize',
      token_endpoint: 'https://auth.notion.example/token',
      registration_endpoint: 'https://auth.notion.example/register',
      resource: 'https://mcp.notion.com/mcp',
    },
    created_at: now,
    updated_at: now,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-connectors-manager-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  mockMcpClient();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
  vi.doUnmock('../../../../src/main/features/connectors/oauth');
  vi.doUnmock('../../../../src/main/features/connectors/oauth-dcr');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('features/connectors/manager authorization recovery', () => {
  it('hides and removes persisted Google grants that lack required scopes', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, googleInstance('gsheets', ['openid', 'email']));

    expect(manager.listInstances(TEST_UID).map((inst) => inst.id)).not.toContain('gsheets');
    await vi.waitFor(() => {
      expect(registry.load(TEST_UID).connections.gsheets).toBeUndefined();
    });
  });

  it('keeps persisted Google auth error rows visible for reconnect', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = googleInstance('gsheets', ['https://www.googleapis.com/auth/drive.file']);
    (inst as any).status = { kind: 'error', message: 'fetch failed', at: Date.now() };

    await registry.upsert(TEST_UID, inst);

    const row = manager.listInstances(TEST_UID).find((item) => item.id === 'gsheets');
    expect(row?.status).toMatchObject({ kind: 'error', message: 'fetch failed' });
    expect(registry.load(TEST_UID).connections.gsheets).toBeTruthy();
  });

  it('removes stale missing-scope grants during bootstrap instead of marking refresh error', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, googleInstance('gmail', ['openid', 'email']));

    await manager.bootstrap(TEST_UID);

    await vi.waitFor(() => {
      expect(registry.load(TEST_UID).connections.gmail).toBeUndefined();
    });
  });

  it('clears the previous connector row when reauthorization returns missing required scopes', async () => {
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(async () => {
        const err = new Error('missing_required_scopes') as Error & { code?: string };
        err.code = 'missing_required_scopes';
        throw err;
      }),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, googleInstance('gmail', ['https://www.googleapis.com/auth/gmail.modify']));

    await expect(manager.connectViaOAuth(TEST_UID, 'gmail')).rejects.toMatchObject({
      message: 'missing_required_scopes',
      code: 'missing_required_scopes',
    });
    expect(registry.load(TEST_UID).connections.gmail).toBeUndefined();
  });

  it('keeps the previous connector row connected when Google reauthorization hits a transient fetch failure', async () => {
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, googleInstance('gsheets', ['https://www.googleapis.com/auth/drive.file']));

    await expect(manager.connectViaOAuth(TEST_UID, 'gsheets')).rejects.toThrow(/fetch failed/);
    expect(registry.load(TEST_UID).connections.gsheets.status).toMatchObject({ kind: 'connected' });
  });

  it('removes the connector row if a refresh response no longer includes required scopes', async () => {
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => ({
        ...grant,
        access_token: 'refreshed-access-token',
        scopes: ['openid', 'email'],
      })),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = googleInstance('gmail', ['https://www.googleapis.com/auth/gmail.modify']);
    inst.oauth_grant.expires_at = Date.now() - 1;

    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'gmail');

    expect(registry.load(TEST_UID).connections.gmail).toBeUndefined();
  });

  it('keeps DCR refresh invalid_grant rows visible for reconnect', async () => {
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async () => {
        throw new Error('DCR refresh HTTP 400: {"error":"invalid_grant","error_description":"Grant not found"}');
      }),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    inst.oauth_grant.refresh_token = null;
    (inst.oauth_grant as any).server_managed = true;
    (inst.oauth_grant as any).server_grant_id = 'grant-1';
    delete (inst as any).dcr_client;
    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'notion');

    const row = manager.listInstances(TEST_UID).find((inst) => inst.id === 'notion');
    expect(row?.status).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('invalid_grant'),
    });
    expect(registry.load(TEST_UID).connections.notion).toBeTruthy();
  });

  it('adopts legacy DCR refresh tokens into server-managed grants', async () => {
    const storeDcrServerManaged = vi.fn(async (_provider, _client, grant) => ({
      ...grant,
      access_token: 'server-access-token',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged,
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, notionInstance());
    await manager.refreshTools(TEST_UID, 'notion');

    const stored = registry.load(TEST_UID).connections.notion;
    const grant = stored.oauth_grant;
    expect(storeDcrServerManaged).toHaveBeenCalledWith(
      'notion',
      expect.objectContaining({ client_id: 'client-id' }),
      expect.objectContaining({ refresh_token: 'refresh-token' }),
      { force: true },
    );
    expect(grant?.refresh_token).toBeNull();
    expect(grant?.server_managed).toBe(true);
    expect(grant?.server_grant_id).toBe('grant-1');
    expect(stored.dcr_client).toBeUndefined();
  });

  it('force refreshes server-managed Notion grants when the MCP endpoint rejects the access token', async () => {
    const connectMock = vi.fn()
      .mockRejectedValueOnce(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}'))
      .mockResolvedValue(undefined);
    const listToolsMock = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    const closeMock = vi.fn(async () => {});
    vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
    vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
      McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
        return {
          connect: connectMock,
          listTools: listToolsMock,
          close: closeMock,
          callTool: vi.fn(async () => ({})),
          get isConnected() { return true; },
        };
      }),
    }));

    const refreshDcrServerManaged = vi.fn(async (_provider, grant, opts) => ({
      ...grant,
      access_token: 'refreshed-notion-access',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged,
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    inst.oauth_grant = {
      ...inst.oauth_grant,
      access_token: 'stale-notion-access',
      refresh_token: null,
      expires_at: Date.now() + 60 * 60 * 1000,
      server_managed: true,
      server_grant_id: 'grant-1',
    } as any;
    delete (inst as any).dcr_client;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(refreshDcrServerManaged).toHaveBeenCalledWith(
      'notion',
      expect.objectContaining({ server_grant_id: 'grant-1', access_token: 'stale-notion-access' }),
      { force: true },
    );
    const stored = registry.load(TEST_UID).connections.notion;
    expect(stored.oauth_grant?.access_token).toBe('refreshed-notion-access');
    expect(stored.transport).toMatchObject({
      kind: 'streamable-http',
      headers: { Authorization: 'Bearer refreshed-notion-access' },
    });
    expect(stored.status).toMatchObject({ kind: 'connected' });
  });

  it('retries transient Notion MCP fetch failures before marking the connector errored', async () => {
    const connectMock = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(undefined);
    const listToolsMock = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    const closeMock = vi.fn(async () => {});
    const refreshDcrServerManaged = vi.fn(async (_provider, grant) => grant);

    vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
    vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
      McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
        return {
          connect: connectMock,
          listTools: listToolsMock,
          close: closeMock,
          callTool: vi.fn(async () => ({})),
          get isConnected() { return true; },
        };
      }),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged,
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.oauth_grant = {
      ...inst.oauth_grant,
      access_token: 'notion-access',
      refresh_token: null,
      expires_at: Date.now() + 60 * 60 * 1000,
      server_managed: true,
      server_grant_id: 'grant-1',
    } as any;
    delete (inst as any).dcr_client;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(refreshDcrServerManaged).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('preserves established Notion state when transient MCP failures continue after retry', async () => {
    const connectMock = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'));
    const closeMock = vi.fn(async () => {});
    const refreshDcrServerManaged = vi.fn(async (_provider, grant) => ({
      ...grant,
      access_token: 'refreshed-notion-access',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));

    vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
    vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
      McpConnection: vi.fn().mockImplementation(function MockMcpConnection() {
        return {
          connect: connectMock,
          listTools: vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]),
          close: closeMock,
          callTool: vi.fn(async () => ({})),
          get isConnected() { return true; },
        };
      }),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged,
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.tools_cache = [{ name: 'notion_search', description: '', input_schema: {} }];
    inst.oauth_grant = {
      ...inst.oauth_grant,
      access_token: 'notion-access',
      refresh_token: null,
      expires_at: Date.now() + 60 * 60 * 1000,
      server_managed: true,
      server_grant_id: 'grant-1',
    } as any;
    delete (inst as any).dcr_client;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(refreshDcrServerManaged).toHaveBeenCalledWith(
      'notion',
      expect.objectContaining({ server_grant_id: 'grant-1' }),
      { force: true },
    );
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('heals persisted transient Notion errors with cached tools on list', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.tools_cache = [{ name: 'notion_search', description: '', input_schema: {} }];
    inst.status = { kind: 'error', message: 'fetch failed', at: Date.now() };

    await registry.upsert(TEST_UID, inst);

    const row = manager.listInstances(TEST_UID).find((item) => item.id === 'notion');
    expect(row?.status).toMatchObject({ kind: 'connected' });
    await vi.waitFor(() => {
      expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
    });
  });

  it('uses GitHub install first and clears reauthorize hints after a local disconnect', async () => {
    const startOAuth = vi.fn(async () => githubGrant());
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth,
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await manager.connectViaOAuth(TEST_UID, 'github');
    expect(startOAuth).toHaveBeenLastCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'github' }),
      { reauthorize: false },
    );
    expect(registry.shouldReauthorize(TEST_UID, 'github')).toBe(true);

    await manager.removeInstance(TEST_UID, 'github');
    expect(registry.shouldReauthorize(TEST_UID, 'github')).toBe(false);
    await manager.connectViaOAuth(TEST_UID, 'github');
    expect(startOAuth).toHaveBeenLastCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'github' }),
      { reauthorize: false },
    );
  });

  it('merges Google Sheets picker grant without dropping the existing refresh token or account label', async () => {
    vi.doMock('../../../../src/main/features/connectors/oauth', () => ({
      startOAuth: vi.fn(),
      refreshIfStale: vi.fn(async (_uid, _entry, grant) => grant),
      startGoogleSheetsPicker: vi.fn(async () => ({
        grant: {
          access_token: 'picker-access-token',
          refresh_token: null,
          expires_at: Date.now() + 60 * 60 * 1000,
          scopes: ['https://www.googleapis.com/auth/drive.file'],
          token_type: 'Bearer',
        },
        pickedFileIds: ['sheet-1', 'sheet-2'],
      })),
    }));
    vi.doMock('../../../../src/main/features/connectors/oauth-dcr', () => ({
      startMcpDcrOAuth: vi.fn(),
      refreshDcrIfStale: vi.fn(async (_client, grant) => grant),
      refreshDcrServerManaged: vi.fn(async (_provider, grant) => grant),
      storeDcrServerManaged: vi.fn(async (_provider, _client, grant) => grant),
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, googleInstance('gsheets', ['https://www.googleapis.com/auth/drive.file']));

    const picked = await manager.authorizeGoogleSheetsFiles(TEST_UID, ['sheet-1']);
    expect(picked).toEqual(['sheet-1', 'sheet-2']);

    const grant = registry.load(TEST_UID).connections.gsheets.oauth_grant;
    expect(grant?.access_token).toBe('picker-access-token');
    expect(grant?.refresh_token).toBe('refresh-token');
    expect(grant?.account_label).toBe('user@example.com');
    expect(grant?.scopes).toEqual(['https://www.googleapis.com/auth/drive.file']);
  });
});
