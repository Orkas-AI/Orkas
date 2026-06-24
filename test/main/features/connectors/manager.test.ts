import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_UID = 'u-connectors-manager';

let tmpDir: string;
let prevWs: string | undefined;

// ── Mock binding: ONE hoisted controller, mocked ONCE at top level ──────────
// Previously each test re-mocked mcp-client / oauth / oauth-dcr with per-test
// `vi.doMock` + `vi.resetModules()` + `await import('manager')`. Under event-
// loop starvation that sequence raced the manager's un-awaited background
// reconciliation from prior tests, so `import('manager')` occasionally bound to
// the WRONG mock and the test's own spies were never called (flake: refreshTools
// returned [] / connect spy "never called"). Mocking the three modules ONCE at
// the top level removes that race entirely: the manager always binds to these
// factories, which dereference the mutable `mocks` slots at CALL time. Each test
// overrides only the slots it cares about; `resetMockBehaviors()` restores fresh
// default spies before every test so nothing leaks. `vi.resetModules()` is still
// needed (manager caches `_conns`/`_bootedFor`/`_refreshLocks`); the top-level
// mock survives it and is re-applied on re-import.
const mocks = vi.hoisted(() => ({
  mcp: {
    connect: undefined as any,
    listTools: undefined as any,
    close: undefined as any,
    callTool: undefined as any,
  },
  oauth: {
    startOAuth: undefined as any,
    refreshIfStale: undefined as any,
    startGoogleSheetsPicker: undefined as any,
  },
  dcr: {
    startMcpDcrOAuth: undefined as any,
    refreshDcrIfStale: undefined as any,
    refreshDcrServerManaged: undefined as any,
    storeDcrServerManaged: undefined as any,
  },
}));

vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({
  McpConnection: vi.fn().mockImplementation(function MockMcpConnection(_id: string, transport: any) {
    // Methods delegate to the current `mocks.mcp.*` slot at call time (`this` is
    // the connection, so condition-based spies can read `this.__transport`).
    return {
      __transport: transport,
      connect(...args: any[]) { return mocks.mcp.connect.apply(this, args); },
      listTools(...args: any[]) { return mocks.mcp.listTools.apply(this, args); },
      close(...args: any[]) { return mocks.mcp.close.apply(this, args); },
      callTool(...args: any[]) { return mocks.mcp.callTool.apply(this, args); },
      get isConnected() { return true; },
    };
  }),
}));

vi.mock('../../../../src/main/features/connectors/oauth', () => ({
  startOAuth: (...args: any[]) => mocks.oauth.startOAuth(...args),
  refreshIfStale: (...args: any[]) => mocks.oauth.refreshIfStale(...args),
  startGoogleSheetsPicker: (...args: any[]) => mocks.oauth.startGoogleSheetsPicker(...args),
}));

vi.mock('../../../../src/main/features/connectors/oauth-dcr', () => ({
  startMcpDcrOAuth: (...args: any[]) => mocks.dcr.startMcpDcrOAuth(...args),
  refreshDcrIfStale: (...args: any[]) => mocks.dcr.refreshDcrIfStale(...args),
  refreshDcrServerManaged: (...args: any[]) => mocks.dcr.refreshDcrServerManaged(...args),
  storeDcrServerManaged: (...args: any[]) => mocks.dcr.storeDcrServerManaged(...args),
}));

/** Restore default (passthrough) behavior for every mock slot. Fresh spies each
 *  test so call history / queued implementations never leak across tests. */
function resetMockBehaviors() {
  mocks.mcp.connect = vi.fn(async () => {});
  mocks.mcp.listTools = vi.fn(async () => [{ name: 'noop', description: '', input_schema: {} }]);
  mocks.mcp.close = vi.fn(async () => {});
  mocks.mcp.callTool = vi.fn(async () => ({}));
  mocks.oauth.startOAuth = vi.fn();
  mocks.oauth.refreshIfStale = vi.fn(async (_uid: string, _entry: unknown, grant: unknown) => grant);
  mocks.oauth.startGoogleSheetsPicker = vi.fn();
  mocks.dcr.startMcpDcrOAuth = vi.fn();
  mocks.dcr.refreshDcrIfStale = vi.fn(async (_client: unknown, grant: unknown) => grant);
  mocks.dcr.refreshDcrServerManaged = vi.fn(async (_provider: unknown, grant: unknown) => grant);
  mocks.dcr.storeDcrServerManaged = vi.fn(async (_provider: unknown, _client: unknown, grant: unknown) => grant);
}

async function writeGoogleConnectorsConfig(value: unknown): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  const paths = await import('../../../../src/main/paths');
  const storage = await import('../../../../src/main/storage');
  users.activateUser(TEST_UID);
  storage.writeJsonSync(paths.userRemoteConfigFile(TEST_UID), {
    version: 1,
    active: {
      immediate: { google_connectors: value },
      restart: {},
    },
  });
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-connectors-manager-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBehaviors();
  await writeGoogleConnectorsConfig({ google: 'enabled', gmail: 'enabled' });
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
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
    mocks.oauth.startOAuth = vi.fn(async () => {
      const err = new Error('missing_required_scopes') as Error & { code?: string };
      err.code = 'missing_required_scopes';
      throw err;
    });

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
    mocks.oauth.startOAuth = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, googleInstance('gsheets', ['https://www.googleapis.com/auth/drive.file']));

    await expect(manager.connectViaOAuth(TEST_UID, 'gsheets')).rejects.toThrow(/fetch failed/);
    expect(registry.load(TEST_UID).connections.gsheets.status).toMatchObject({ kind: 'connected' });
  });

  it('removes the connector row if a refresh response no longer includes required scopes', async () => {
    mocks.oauth.refreshIfStale = vi.fn(async (_uid, _entry, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-access-token',
      scopes: ['openid', 'email'],
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
    mocks.dcr.refreshDcrServerManaged = vi.fn(async () => {
      throw new Error('DCR refresh HTTP 400: {"error":"invalid_grant","error_description":"Grant not found"}');
    });

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
    mocks.dcr.storeDcrServerManaged = vi.fn(async (_provider, _client, grant) => ({
      ...(grant as object),
      access_token: 'server-access-token',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, notionInstance());
    await manager.refreshTools(TEST_UID, 'notion');

    const stored = registry.load(TEST_UID).connections.notion;
    const grant = stored.oauth_grant;
    expect(mocks.dcr.storeDcrServerManaged).toHaveBeenCalledWith(
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
    // Condition-based connect (reject the STALE token, accept the force-refreshed
    // one) so the assertion holds regardless of how many times / in what order
    // connect is invoked.
    const connectMock = vi.fn(async function (this: { __transport?: { headers?: Record<string, string> } }) {
      const auth = this?.__transport?.headers?.Authorization || '';
      if (auth.includes('stale-notion-access')) {
        throw new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}');
      }
    });
    const closeMock = vi.fn(async () => {});
    const refreshDcrServerManaged = vi.fn(async (_provider, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-notion-access',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;
    mocks.dcr.refreshDcrServerManaged = refreshDcrServerManaged;

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
    expect(connectMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
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
    // One transient failure then success. A shared flag (not call-ordinal) drives
    // it so an extra connect can't desync the mock.
    let failedOnce = false;
    const connectMock = vi.fn(async () => {
      if (!failedOnce) { failedOnce = true; throw new Error('fetch failed'); }
    });
    const closeMock = vi.fn(async () => {});
    const refreshDcrServerManaged = vi.fn(async (_provider, grant) => grant);
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;
    mocks.dcr.refreshDcrServerManaged = refreshDcrServerManaged;

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
    // A transient failure is retried (not force-refreshed) and the connector ends
    // connected; the `not force-refreshed` + connected status are the meaningful
    // invariant (exact connect counts are brittle implementation detail).
    expect(connectMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(refreshDcrServerManaged).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('preserves established Notion state when transient MCP failures continue after retry', async () => {
    // The scenario is "transient failures CONTINUE" — every connect fails.
    const connectMock = vi.fn(async () => { throw new Error('fetch failed'); });
    const closeMock = vi.fn(async () => {});
    const refreshDcrServerManaged = vi.fn(async (_provider, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-notion-access',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;
    mocks.dcr.refreshDcrServerManaged = refreshDcrServerManaged;

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
    // Despite every connect failing, the forced refresh ran and the established
    // (connected, cached-tools) state is preserved rather than downgraded.
    expect(connectMock).toHaveBeenCalled();
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
    mocks.oauth.startOAuth = startOAuth;

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
    mocks.oauth.startGoogleSheetsPicker = vi.fn(async () => ({
      grant: {
        access_token: 'picker-access-token',
        refresh_token: null,
        expires_at: Date.now() + 60 * 60 * 1000,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        token_type: 'Bearer',
      },
      pickedFileIds: ['sheet-1', 'sheet-2'],
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
