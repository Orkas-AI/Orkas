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
    startComposioConnect: undefined as any,
    startOAuth: undefined as any,
    refreshIfStale: undefined as any,
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
  startComposioConnect: (...args: any[]) => mocks.oauth.startComposioConnect(...args),
  startOAuth: (...args: any[]) => mocks.oauth.startOAuth(...args),
  refreshIfStale: (...args: any[]) => mocks.oauth.refreshIfStale(...args),
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
  mocks.oauth.startComposioConnect = vi.fn();
  mocks.oauth.startOAuth = vi.fn();
  mocks.oauth.refreshIfStale = vi.fn(async (_uid: string, _entry: unknown, grant: unknown) => grant);
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

function bingWebmasterInstance(scopes: string[]) {
  const now = new Date().toISOString();
  return {
    id: 'bing-webmaster',
    display_name: 'Bing Webmaster Tools',
    transport: {
      kind: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
      env: { BING_ACCESS_TOKEN: 'access-token' },
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
      account_label: 'webmaster@example.com',
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

function githubInstance() {
  const now = new Date().toISOString();
  return {
    id: 'github',
    display_name: 'GitHub',
    transport: {
      kind: 'streamable-http' as const,
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ghu-token' },
    },
    enabled_subtools: null,
    tools_cache: [{ name: 'github_search_repositories', description: '', input_schema: {} }],
    tools_cached_at: Date.now(),
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: githubGrant(),
    created_at: now,
    updated_at: now,
  };
}

function discordGrant() {
  return {
    access_token: 'discord-user-access-token',
    refresh_token: null,
    expires_at: Date.now() + 60 * 60 * 1000,
    scopes: ['identify', 'guilds', 'bot', 'applications.commands'],
    token_type: 'Bearer',
    account_label: 'Orkas',
    server_managed: true,
    server_grant_id: 'discord-grant-1',
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

function sentryInstance() {
  const now = new Date().toISOString();
  return {
    id: 'sentry',
    display_name: 'Sentry',
    transport: {
      kind: 'streamable-http' as const,
      url: 'https://mcp.sentry.dev/mcp',
      headers: { Authorization: 'Bearer access-token' },
    },
    enabled_subtools: null,
    tools_cache: [{ name: 'list_organizations', description: '', input_schema: {} }],
    tools_cached_at: Date.now(),
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-token',
      refresh_token: null,
      expires_at: null,
      scopes: [],
      token_type: 'Bearer',
      server_grant_id: 'grant-1',
      server_managed: true,
    },
    created_at: now,
    updated_at: now,
  };
}

function futureCatalogInstance() {
  const now = new Date().toISOString();
  return {
    id: 'future-dcr',
    display_name: 'Future DCR',
    transport: {
      kind: 'streamable-http' as const,
      url: 'https://mcp.future.example/mcp',
      headers: { Authorization: 'Bearer access-token' },
    },
    enabled_subtools: null,
    tools_cache: [{ name: 'future_tool', description: '', input_schema: {} }],
    tools_cached_at: Date.now(),
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-token',
      refresh_token: null,
      expires_at: null,
      scopes: [],
      token_type: 'Bearer',
      server_grant_id: 'grant-1',
      server_managed: true,
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
  it('keeps persisted server-bridge auth error rows visible for reconnect', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = bingWebmasterInstance(['webmaster.read']);
    (inst as any).status = { kind: 'error', message: 'fetch failed', at: Date.now() };

    await registry.upsert(TEST_UID, inst);

    const row = manager.listInstances(TEST_UID).find((item) => item.id === 'bing-webmaster');
    expect(row?.status).toMatchObject({ kind: 'error', message: 'fetch failed' });
    expect(registry.load(TEST_UID).connections['bing-webmaster']).toBeTruthy();
  });

  it('clears the previous connector row when reauthorization returns missing required scopes', async () => {
    mocks.oauth.startOAuth = vi.fn(async () => {
      const err = new Error('missing_required_scopes') as Error & { code?: string };
      err.code = 'missing_required_scopes';
      throw err;
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, bingWebmasterInstance(['webmaster.read']));

    await expect(manager.connectViaOAuth(TEST_UID, 'bing-webmaster')).rejects.toMatchObject({
      message: 'missing_required_scopes',
      code: 'missing_required_scopes',
    });
    expect(registry.load(TEST_UID).connections['bing-webmaster']).toBeUndefined();
  });

  it('keeps the previous connector row connected when server-bridge reauthorization hits a transient fetch failure', async () => {
    mocks.oauth.startOAuth = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, bingWebmasterInstance(['webmaster.read']));

    await expect(manager.connectViaOAuth(TEST_UID, 'bing-webmaster')).rejects.toThrow(/fetch failed/);
    expect(registry.load(TEST_UID).connections['bing-webmaster'].status).toMatchObject({ kind: 'connected' });
  });

  it('preserves established server-bridge connectors when refresh_failed is localized by Server', async () => {
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      throw new Error('刷新授权失败');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const bing = bingWebmasterInstance(['webmaster.read']);
    bing.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, bing);
    await manager.refreshTools(TEST_UID, 'bing-webmaster');
    expect(registry.load(TEST_UID).connections['bing-webmaster'].status).toMatchObject({ kind: 'connected' });

    const github = githubInstance();
    github.oauth_grant.expires_at = Date.now() - 1;
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      const err = new Error('Failed to refresh authorization') as Error & { code?: string; retryable?: boolean };
      err.code = 'connector_refresh_failed';
      err.retryable = true;
      throw err;
    });
    await registry.upsert(TEST_UID, github);
    await manager.refreshTools(TEST_UID, 'github');
    expect(registry.load(TEST_UID).connections.github.status).toMatchObject({ kind: 'connected' });
  });

  it('preserves established DCR connectors when server-managed refresh returns generic refresh_failed', async () => {
    mocks.dcr.refreshDcrServerManaged = vi.fn(async () => {
      const err = new Error('Failed to refresh authorization') as Error & { code?: string; retryable?: boolean };
      err.code = 'connector_refresh_failed';
      err.retryable = true;
      throw err;
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

    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('keeps structured DCR reconnect-required rows visible for reconnect', async () => {
    mocks.dcr.refreshDcrServerManaged = vi.fn(async () => {
      const err = new Error('Authorization expired. Please reconnect') as Error & { code?: string; retryable?: boolean };
      err.code = 'connector_reconnect_required';
      err.retryable = false;
      throw err;
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
      message: expect.stringContaining('Authorization expired'),
    });
  });

  it('removes the connector row if a refresh response no longer includes required scopes', async () => {
    mocks.oauth.refreshIfStale = vi.fn(async (_uid, _entry, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-access-token',
      scopes: ['openid', 'email'],
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = bingWebmasterInstance(['webmaster.read']);
    inst.oauth_grant.expires_at = Date.now() - 1;

    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'bing-webmaster');

    expect(registry.load(TEST_UID).connections['bing-webmaster']).toBeUndefined();
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
    // Despite every connect failing, this is still a network problem, not an
    // auth rejection. Keep the established state and do not force-refresh the
    // server-managed grant just because the MCP endpoint was unreachable.
    expect(connectMock).toHaveBeenCalled();
    expect(refreshDcrServerManaged).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('preserves established GitHub state when transient MCP failures continue after retry', async () => {
    const connectMock = vi.fn(async () => { throw new Error('fetch failed'); });
    mocks.mcp.connect = connectMock;
    mocks.mcp.close = vi.fn(async () => {});
    mocks.oauth.refreshIfStale = vi.fn(async (_uid: string, _entry: unknown, grant: unknown) => ({
      ...(grant as object),
      access_token: 'forced-ghu-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, githubInstance());
    const tools = await manager.refreshTools(TEST_UID, 'github');

    expect(tools).toEqual([{ name: 'github_search_repositories', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalled();
    expect(mocks.oauth.refreshIfStale).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.github.status).toMatchObject({ kind: 'connected' });
    expect(registry.load(TEST_UID).connections.github.oauth_grant?.access_token).toBe('ghu-token');
  });

  it('heals stale GitHub reconnect errors when the latest failure is transient', async () => {
    const connectMock = vi.fn(async () => { throw new Error('fetch failed'); });
    mocks.mcp.connect = connectMock;
    mocks.mcp.close = vi.fn(async () => {});

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = githubInstance();
    (inst as any).status = { kind: 'error', message: 'Authorization expired, reconnect required', at: Date.now() };
    await registry.upsert(TEST_UID, inst);

    const tools = await manager.refreshTools(TEST_UID, 'github');

    expect(tools).toEqual([{ name: 'github_search_repositories', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.github.status).toMatchObject({ kind: 'connected' });
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

});
