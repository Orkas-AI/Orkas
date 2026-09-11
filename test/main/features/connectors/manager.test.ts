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
  },
  events: {
    broadcastOAuthConnectProgress: undefined as any,
    broadcastOAuthConnectOutcome: undefined as any,
  },
  metering: {
    preflightConnectorCredits: undefined as any,
  },
  localCli: {
    authorize: undefined as any,
    transport: undefined as any,
    remove: undefined as any,
  },
  localApi: {
    authorize: undefined as any,
    hasAuthorization: undefined as any,
    storedTransport: undefined as any,
    transport: undefined as any,
    remove: undefined as any,
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
}));

vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({
  broadcastOAuthConnectProgress: (...args: any[]) => mocks.events.broadcastOAuthConnectProgress(...args),
  broadcastOAuthConnectOutcome: (...args: any[]) => mocks.events.broadcastOAuthConnectOutcome(...args),
}));

vi.mock('../../../../src/main/features/connectors/local-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors/local-cli')>();
  return {
    ...actual,
    authorizeLocalCli: (...args: any[]) => mocks.localCli.authorize(...args),
    localCliTransport: (...args: any[]) => mocks.localCli.transport(...args),
    removeLocalCliAuthorization: (...args: any[]) => mocks.localCli.remove(...args),
  };
});

vi.mock('../../../../src/main/features/connectors/local-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors/local-api')>();
  return {
    ...actual,
    authorizeLocalApi: (...args: any[]) => mocks.localApi.authorize(...args),
    hasLocalApiAuthorization: (...args: any[]) => mocks.localApi.hasAuthorization(...args),
    localApiStoredTransport: (...args: any[]) => mocks.localApi.storedTransport(...args),
    localApiTransport: (...args: any[]) => mocks.localApi.transport(...args),
    removeLocalApiAuthorization: (...args: any[]) => mocks.localApi.remove(...args),
  };
});

vi.mock('../../../../src/main/features/connectors/usage-metering', () => ({
  preflightConnectorCredits: (...args: any[]) => mocks.metering.preflightConnectorCredits(...args),
}));

vi.mock('../../../../src/main/features/connectors/api-key', () => ({
  connectorApiKeyHeaders: () => ({ Authorization: 'Bearer orkas-connector-key' }),
}));

vi.mock('../../../../src/main/util/bundled-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/util/bundled-runtime')>();
  return {
    ...actual,
    bundledNodeExecutable: () => '/opt/orkas/runtime/node',
  };
});

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
  mocks.events.broadcastOAuthConnectProgress = vi.fn();
  mocks.events.broadcastOAuthConnectOutcome = vi.fn();
  mocks.localCli.authorize = vi.fn(async () => {});
  mocks.localCli.transport = vi.fn((_uid: string, entry: { id: string }) => ({
    kind: 'stdio',
    command: '/opt/orkas/runtime/node',
    args: ['/app/bin/local-cli-mcp-server.cjs'],
    env: { ORKAS_LOCAL_CLI_PROVIDER: entry.id === 'wecom' ? 'wecom' : entry.id },
  }));
  mocks.localCli.remove = vi.fn();
  mocks.localApi.authorize = vi.fn(async () => ({ shop_domain: 'merchant.myshopify.com' }));
  mocks.localApi.hasAuthorization = vi.fn(() => true);
  mocks.localApi.storedTransport = vi.fn(() => ({
    kind: 'stdio', command: '/opt/orkas/runtime/node',
    args: ['/app/bin/direct-commerce-mcp-server.cjs'],
    cwd: '/device-local/shopify-admin',
  }));
  mocks.localApi.transport = vi.fn((_uid: string, entry: { local_api: { provider: string } }, metadata: unknown) => ({
    kind: 'stdio', command: '/opt/orkas/runtime/node',
    args: ['/app/bin/direct-commerce-mcp-server.cjs'],
    cwd: '/device-local/shopify-admin',
    env: {
      ORKAS_LOCAL_API_PROVIDER: entry.local_api.provider,
      ORKAS_LOCAL_API_CREDENTIAL_FILE: '/device-local/shopify-admin/credentials.enc',
      ORKAS_LOCAL_API_CREDENTIAL_KEY: 'device-only-key',
      ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata || {}),
    },
  }));
  mocks.localApi.remove = vi.fn();
  mocks.metering.preflightConnectorCredits = vi.fn(async () => null);
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

async function writeComposioCatalog(): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  const paths = await import('../../../../src/main/paths');
  const storage = await import('../../../../src/main/storage');
  users.activateUser(TEST_UID);
  storage.writeJsonSync(paths.userRemoteConfigFile(TEST_UID), {
    version: 1,
    active: {
      immediate: {
        'connectors.catalog': [{
          id: 'composio-mail',
          display_name: 'Mail',
          icon_svg: '<svg viewBox="0 0 24 24"></svg>',
          category: 'productivity',
          description_zh: '邮件',
          description_en: 'Mail',
          auth_mode: 'composio',
          toolkit: 'gmail',
          auth_config_id: 'ac_public_123',
          tools: [{ slug: 'GMAIL_FETCH_EMAILS' }],
        }],
      },
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
    },
    dcr_client: {
      client_id: 'sentry-client-id',
      client_secret: 'sentry-client-secret',
      authorization_endpoint: 'https://mcp.sentry.dev/oauth/authorize',
      token_endpoint: 'https://mcp.sentry.dev/oauth/token',
      registration_endpoint: 'https://mcp.sentry.dev/oauth/register',
      resource: 'https://mcp.sentry.dev/mcp',
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

function customAccountInstance(owner: string) {
  const now = new Date().toISOString();
  return {
    id: 'custom-shared',
    display_name: 'Shared Custom MCP',
    origin: 'custom' as const,
    transport: {
      kind: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
      env: { TEST_CONNECTOR_OWNER: owner },
    },
    enabled_subtools: null,
    tools_cache: [{ name: 'read_owner', description: '', input_schema: {} }],
    tools_cached_at: Date.now(),
    status: { kind: 'connected' as const, since: Date.now() },
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
  it.each([
    ['storefront_request_failed', 'failure', 'E_TOOL_CALL_UPSTREAM', 'upstream', 'warn'],
    ['E_TOOL_CALL_CANCELLED', 'cancelled', 'E_TOOL_CALL_CANCELLED', 'cancelled', 'info'],
  ])('preserves structured MCP reason %s without additional provider calls', async (code, result, error_code, error_type, level) => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const { default: electronLog } = await import('electron-log/main');
    const records: Array<{ level: string; data: unknown[] }> = [];
    const capture = (message: any, transport: unknown) => {
      // electron-log runs hooks separately for file/console/IPC. Observe one
      // actual output transport, not three copies of the same log invocation.
      if (transport === electronLog.transports.console && message.data[0] === 'connector request completed') {
        records.push({ level: message.level, data: message.data });
      }
      return message;
    };
    await registry.upsert(TEST_UID, githubInstance());
    const wire = { isError: true, _meta: { orkas: { errorCode: code } }, content: [{ type: 'text', text: 'Check permissions; private-payload-canary' }] };
    mocks.mcp.callTool = vi.fn(async () => wire);
    electronLog.hooks.push(capture);
    try {
      await expect(manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'private-payload-canary' })).resolves.toBe(wire);
      expect(mocks.mcp.callTool).toHaveBeenCalledOnce();
    } finally { electronLog.hooks.splice(electronLog.hooks.indexOf(capture), 1); }
  });

  it('keeps a localized merchant setup failure actionable in its single authorization terminal', async () => {
    const manager = await import('../../../../src/main/features/connectors/manager');
    mocks.localApi.authorize = vi.fn(async () => { throw Object.assign(new Error('请检查应用权限 private-payload-canary'), { code: 'storefront_network_failed' }); });
    manager.beginOAuthConnect(TEST_UID, 'bigcommerce', { store_hash: 'fixture', access_token: 'private-token-canary' });
    await vi.waitFor(() => expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledOnce());
    expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledOnce();
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
  });

  it('counts one real request after reconnect recovery and reports MCP business failure without private data', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    mocks.mcp.connect = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(undefined);
    const wireResult = { isError: true, content: [{ type: 'text', text: 'HTTP 429 private_customer_canary' }] };
    mocks.mcp.callTool = vi.fn(async () => wireResult);

    await expect(manager.callTool(TEST_UID, 'github', 'github_search_repositories', {
      query: 'private_customer_canary',
    })).resolves.toBe(wireResult);

    expect(mocks.mcp.connect).toHaveBeenCalledTimes(2);
    expect(mocks.mcp.callTool).toHaveBeenCalledOnce();
  });

  it('excludes a pre-dispatch cancellation from attempted platform calls and never invokes MCP', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    const controller = new AbortController();
    controller.abort('private cancellation reason');
    await expect(manager.callTool(TEST_UID, 'github', 'github_search_repositories', {}, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' });
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
  });

  it('records direct local-API success and legacy sandbox usage without exposing shop credentials', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'execute_read', description: '', input_schema: {} }]);
    const now = new Date().toISOString();
    await registry.upsert(TEST_UID, {
      id: 'shopee', display_name: 'Shopee', transport: { kind: 'stdio', command: 'node', args: [] },
      enabled_subtools: null, tools_cache: [{ name: 'execute_read', description: '', input_schema: {} }],
      tools_cached_at: Date.now(), status: { kind: 'connected', since: Date.now() },
      connection_parameters: { environment: 'sandbox', shop_id: 'private_shop_canary' },
      created_at: now, updated_at: now,
    });
    await manager.callTool(TEST_UID, 'shopee', 'execute_read', {});
  });

  it('requires reconnect for legacy Google Gmail and replaces it with an API-key Composio grant', async () => {
    await writeGoogleConnectorsConfig({ google: 'disabled', gmail: 'disabled' });
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, googleInstance('gmail', ['https://www.googleapis.com/auth/gmail.modify']));

    await manager.bootstrap(TEST_UID);
    expect(manager.getInstance(TEST_UID, 'gmail')?.status).toMatchObject({
      kind: 'error', message: 'connector_reconnect_required',
    });
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.oauth.refreshIfStale).not.toHaveBeenCalled();
    expect(mocks.oauth.startOAuth).not.toHaveBeenCalled();

    mocks.oauth.startComposioConnect.mockResolvedValue({
      connection_id: 'gmail-connection', connection_token: 'a'.repeat(43), toolkit: 'gmail',
    });
    mocks.mcp.listTools.mockResolvedValue([
      { name: 'GMAIL_FETCH_EMAILS', description: 'Fetch email', input_schema: {} },
    ]);
    await expect(manager.connectViaOAuth(TEST_UID, 'gmail')).resolves.toMatchObject({
      id: 'gmail', status: { kind: 'connected' },
      transport: { env: {
        ORKAS_API_KEY: 'orkas-connector-key', COMPOSIO_CONNECTION_ID: 'gmail-connection',
        COMPOSIO_CONNECTION_TOKEN: 'a'.repeat(43),
      } },
    });
    expect(mocks.oauth.startOAuth).not.toHaveBeenCalled();
    expect(mocks.metering.preflightConnectorCredits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gmail', auth_mode: 'composio', requires_credits: true }), 'connect',
    );
    const saved = registry.load(TEST_UID).connections.gmail;
    expect(saved.oauth_grant).toBeUndefined();
    expect(saved.composio_grant?.connection_token).toBe('a'.repeat(43));
    expect(saved.transport.kind === 'stdio' && saved.transport.env?.GOOGLE_ACCESS_TOKEN).toBeUndefined();
  });

  it('connects a server-catalog Composio connector through the API-key adapter', async () => {
    await writeComposioCatalog();
    mocks.oauth.startComposioConnect.mockResolvedValue({
      connection_id: 'connection-1',
      connection_token: 'a'.repeat(43),
      toolkit: 'gmail',
      auth_config_id: 'ac_public_123',
      account_label: 'user@example.com',
    });
    mocks.mcp.listTools.mockResolvedValue([
      { name: 'GMAIL_FETCH_EMAILS', description: 'Fetch email', input_schema: {} },
    ]);
    const manager = await import('../../../../src/main/features/connectors/manager');

    await expect(manager.connectViaOAuth(TEST_UID, 'composio-mail')).resolves.toMatchObject({
      id: 'composio-mail',
      composio_grant: { connection_id: 'connection-1', toolkit: 'gmail' },
      status: { kind: 'connected' },
      transport: {
        kind: 'stdio',
        env: {
          ORKAS_API_KEY: 'orkas-connector-key',
          COMPOSIO_CONNECTION_ID: 'connection-1',
          COMPOSIO_CONNECTION_TOKEN: 'a'.repeat(43),
          COMPOSIO_CONNECTOR_ID: 'composio-mail',
        },
      },
    });
    expect(mocks.metering.preflightConnectorCredits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'composio-mail', auth_mode: 'composio' }),
      'connect',
    );
    expect(mocks.oauth.startComposioConnect).toHaveBeenCalledOnce();
  });

  it('marks a legacy paid connection for reconnect without fetching a replacement credential', async () => {
    await writeComposioCatalog();
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const now = new Date().toISOString();
    await registry.upsert(TEST_UID, {
      id: 'composio-mail', display_name: 'Mail',
      transport: { kind: 'stdio', command: 'node', args: [] },
      composio_grant: { connection_id: 'legacy', toolkit: 'gmail', auth_config_id: 'ac_public_123' },
      enabled_subtools: null, tools_cache: [], tools_cached_at: Date.now(),
      status: { kind: 'connected', since: Date.now() }, created_at: now, updated_at: now,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(manager.listInstances(TEST_UID)[0].status).toMatchObject({ kind: 'error', message: 'connector_reconnect_required' });
      await manager.bootstrap(TEST_UID);
      expect(mocks.mcp.connect).not.toHaveBeenCalled();
      expect(mocks.oauth.startComposioConnect).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      await manager.removeInstance(TEST_UID, 'composio-mail');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('sends the connection credential on explicit remote disconnect', async () => {
    await writeComposioCatalog();
    mocks.oauth.startComposioConnect.mockResolvedValue({
      connection_id: 'connection-1', connection_token: 'a'.repeat(43), toolkit: 'gmail', auth_config_id: 'ac_public_123',
    });
    const manager = await import('../../../../src/main/features/connectors/manager');
    await manager.connectViaOAuth(TEST_UID, 'composio-mail');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, removed: true })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await manager.removeInstance(TEST_UID, 'composio-mail')).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/composio/disconnect'), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer orkas-connector-key', 'X-Orkas-Connection-Token': 'a'.repeat(43) }),
      }));
      expect(manager.listInstances(TEST_UID)).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not start a connector or recover the credential remotely when local persistence fails', async () => {
    await writeComposioCatalog();
    mocks.oauth.startComposioConnect.mockResolvedValue({
      connection_id: 'connection-1', connection_token: 'a'.repeat(43), toolkit: 'gmail', auth_config_id: 'ac_public_123',
    });
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const save = vi.spyOn(registry, 'upsert').mockRejectedValueOnce(new Error('local write failed'));
    try {
      await expect(manager.connectViaOAuth(TEST_UID, 'composio-mail')).rejects.toThrow('local write failed');
      expect(mocks.mcp.connect).not.toHaveBeenCalled();
      expect(manager.listInstances(TEST_UID)).toEqual([]);
      expect(mocks.oauth.startComposioConnect).toHaveBeenCalledOnce();
    } finally { save.mockRestore(); }
  });

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

  it('projects stale transport-unresolved rows as degraded on list, without mutating them', async () => {
    // Two invariants, both new. The row must surface as recoverable (`degraded`) so it stays
    // routable and the next use repairs it — but listing must NOT write. This used to rewrite the
    // row to `connected` and fire-and-forget persist that, so merely enumerating connectors (which
    // happens on every agent turn via resolveVisibleConnectors) laundered a real failure into a
    // green card that nothing had verified.
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = sentryInstance();
    (inst as any).status = { kind: 'error', message: 'transport unresolved', at: Date.now() };

    await registry.upsert(TEST_UID, inst);

    const row = manager.listInstances(TEST_UID).find((item) => item.id === 'sentry');
    expect(row?.status.kind).toBe('degraded');
    expect((row?.status as any).retry_after).toBeUndefined();

    // The read is pure: disk still holds the original row, untouched.
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.load(TEST_UID).connections.sentry.status).toMatchObject({
      kind: 'error',
      message: 'transport unresolved',
    });
  });

  it('ignores synced connectors unknown to this app version without mutating them', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, futureCatalogInstance());

    expect(manager.listInstances(TEST_UID).map((item) => item.id)).not.toContain('future-dcr');
    expect(manager.getInstance(TEST_UID, 'future-dcr')).toBeNull();

    await manager.bootstrap(TEST_UID);

    expect(registry.load(TEST_UID).connections['future-dcr'].status).toMatchObject({
      kind: 'connected',
    });
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
  });

  it('reuses a healthy persisted tool cache at bootstrap and connects only on first tool call', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());

    await manager.bootstrap(TEST_UID);

    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.mcp.listTools).not.toHaveBeenCalled();
    expect(manager.listInstances(TEST_UID)[0]?.tools_cache).toEqual([
      expect.objectContaining({ name: 'github_search_repositories' }),
    ]);

    await manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'orkas' });

    expect(mocks.mcp.connect).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.callTool).toHaveBeenCalledWith(
      'github_search_repositories',
      { query: 'orkas' },
    );
  });

  it('revokes the previous account connection before the same connector id is used by another account', async () => {
    const secondUid = 'u-connectors-second';
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const users = await import('../../../../src/main/features/users');
    await registry.upsert(TEST_UID, customAccountInstance('account-a'));
    await registry.upsert(secondUid, customAccountInstance('account-b'));
    mocks.mcp.callTool = vi.fn(async function ownerResult(this: any) {
      return { owner: this.__transport.env.TEST_CONNECTOR_OWNER };
    });

    await expect(manager.callTool(TEST_UID, 'custom-shared', 'read_owner', {}))
      .resolves.toEqual({ owner: 'account-a' });

    users.activateUser(secondUid);
    await vi.waitFor(() => expect(mocks.mcp.close).toHaveBeenCalledTimes(1));

    await expect(manager.callTool(secondUid, 'custom-shared', 'read_owner', {}))
      .resolves.toEqual({ owner: 'account-b' });
    expect(mocks.mcp.connect).toHaveBeenCalledTimes(2);
  });

  it('discards a previous account connection that finishes after the account switch', async () => {
    const secondUid = 'u-connectors-race';
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const users = await import('../../../../src/main/features/users');
    await registry.upsert(TEST_UID, customAccountInstance('account-a'));
    await registry.upsert(secondUid, customAccountInstance('account-b'));
    let releaseFirstConnect!: () => void;
    const firstConnect = new Promise<void>((resolve) => { releaseFirstConnect = resolve; });
    mocks.mcp.connect = vi.fn(async function connectByOwner(this: any) {
      if (this.__transport.env.TEST_CONNECTOR_OWNER === 'account-a') {
        await firstConnect;
      }
    });
    mocks.mcp.callTool = vi.fn(async function ownerResult(this: any) {
      return { owner: this.__transport.env.TEST_CONNECTOR_OWNER };
    });

    const staleCall = manager.callTool(TEST_UID, 'custom-shared', 'read_owner', {});
    await vi.waitFor(() => expect(mocks.mcp.connect).toHaveBeenCalledTimes(1));
    users.activateUser(secondUid);
    releaseFirstConnect();

    await expect(staleCall).rejects.toMatchObject({
      code: 'E_CONNECTOR_ACCOUNT_CHANGED',
    });
    await expect(manager.callTool(secondUid, 'custom-shared', 'read_owner', {}))
      .resolves.toEqual({ owner: 'account-b' });
    expect(mocks.mcp.callTool).toHaveBeenCalledTimes(1);
  });

  

  it('does not disconnect the next account after waiting for the old local connection to close', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const users = await import('../../../../src/main/features/users');
    await registry.upsert(TEST_UID, ({
      id: 'gmail', origin: 'catalog', enabled: true, transport: { kind: 'streamable-http', url: 'https://orkas.ai/api/connectors/composio/mcp' },
      composio_grant: { connection_id: 'gmail-connection', connection_token: 'a'.repeat(43), toolkit: 'gmail' },
      tools_cache: [], status: { kind: 'connected', since: Date.now() }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as any));
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'GMAIL_FETCH_EMAILS', description: '', input_schema: {} }]);
    await manager.bootstrap(TEST_UID);
    let releaseClose!: () => void;
    mocks.mcp.close = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":0}', { status: 200 }));
    try {
      const removal = manager.removeInstance(TEST_UID, 'gmail');
      await vi.waitFor(() => expect(mocks.mcp.close).toHaveBeenCalledOnce());
      const finishRemovalClose = releaseClose;
      users.activateUser('u-connectors-disconnect-second');
      releaseClose();
      finishRemovalClose();

      await expect(removal).rejects.toMatchObject({ code: 'E_CONNECTOR_ACCOUNT_CHANGED' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(registry.load(TEST_UID).connections.gmail).toBeTruthy();
    } finally {
      releaseClose?.();
      fetchSpy.mockRestore();
    }
  });

  it('does not dispatch old-account tools after a delayed credits preflight', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const users = await import('../../../../src/main/features/users');
    await registry.upsert(TEST_UID, githubInstance());
    let releasePreflight!: () => void;
    mocks.metering.preflightConnectorCredits.mockImplementationOnce(
      () => new Promise((resolve) => { releasePreflight = () => resolve(null); }),
    );
    const pending = manager.callTool(TEST_UID, 'github', 'github_search_repositories', {});
    await vi.waitFor(() => expect(releasePreflight).toBeTypeOf('function'));
    users.activateUser('u-connectors-preflight-second');
    releasePreflight();

    await expect(pending).rejects.toMatchObject({ code: 'E_CONNECTOR_ACCOUNT_CHANGED' });
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
  });

  it.each(['feishu', 'shopify-admin'])(
    'does not publish a late %s authorization after the account switch',
    async (id) => {
      const registry = await import('../../../../src/main/features/connectors/registry');
      const manager = await import('../../../../src/main/features/connectors/manager');
      const users = await import('../../../../src/main/features/users');
      let releaseAuthorization!: () => void;
      const authorization = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
      const authorize = vi.fn(async () => {
        await authorization;
        return { shop_domain: 'merchant.myshopify.com' };
      });
      if (id === 'feishu') mocks.localCli.authorize = authorize;
      else mocks.localApi.authorize = authorize;
      const pending = manager.connectViaOAuth(TEST_UID, id);
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      users.activateUser('u-connectors-authorization-second');
      releaseAuthorization();

      await expect(pending).rejects.toMatchObject({ code: 'E_CONNECTOR_ACCOUNT_CHANGED' });
      expect(registry.load(TEST_UID).connections[id]).toBeUndefined();
      expect(mocks.mcp.connect).not.toHaveBeenCalled();
      expect(mocks.localApi.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['bootstrap', 'verifyUsableConnectors'] as const)(
    'stops queued %s work when the account changes during the first batch',
    async (operation) => {
      const registry = await import('../../../../src/main/features/connectors/registry');
      const manager = await import('../../../../src/main/features/connectors/manager');
      const users = await import('../../../../src/main/features/users');
      for (let i = 0; i < 4; i++) {
        await registry.upsert(TEST_UID, {
          ...customAccountInstance('account-a'),
          id: `custom-batch-${i}`,
          status: operation === 'bootstrap' ? { kind: 'connecting' } : { kind: 'connected', since: 1 },
        });
      }
      let releaseConnections!: () => void;
      const gate = new Promise<void>((resolve) => { releaseConnections = resolve; });
      mocks.mcp.connect = vi.fn(() => gate);
      const pending = manager[operation](TEST_UID);
      await vi.waitFor(() => expect(mocks.mcp.connect).toHaveBeenCalledTimes(3));
      users.activateUser('u-connectors-batch-second');
      releaseConnections();

      await expect(pending).rejects.toMatchObject({ code: 'E_CONNECTOR_ACCOUNT_CHANGED' });
      expect(mocks.mcp.connect).toHaveBeenCalledTimes(3);
      expect(mocks.mcp.listTools).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.mcp.close).toHaveBeenCalledTimes(3));
    },
  );

  it('persists an already-issued rotated grant to its original account without starting a stale transport', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const users = await import('../../../../src/main/features/users');
    const original = githubInstance();
    original.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, original);
    let releaseRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      await refresh;
      return { ...original.oauth_grant, access_token: 'rotated-access-fixture', refresh_token: 'rotated-refresh-fixture' };
    });
    const pending = manager.callTool(TEST_UID, 'github', 'github_search_repositories', {});
    await vi.waitFor(() => expect(mocks.oauth.refreshIfStale).toHaveBeenCalledOnce());
    users.activateUser('u-connectors-refresh-second');
    releaseRefresh();

    await expect(pending).rejects.toMatchObject({ code: 'E_CONNECTOR_ACCOUNT_CHANGED' });
    expect(registry.load(TEST_UID).connections.github.oauth_grant?.refresh_token).toBe('rotated-refresh-fixture');
    expect(registry.load('u-connectors-refresh-second').connections.github).toBeUndefined();
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
  });

  it('closes every connection created by overlapping panel verification and a tool call', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, {
      ...customAccountInstance('account-a'),
      status: { kind: 'connected', since: 1 },
    });
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    mocks.mcp.connect = vi.fn(() => gate);
    const verifying = manager.verifyUsableConnectors(TEST_UID);
    await vi.waitFor(() => expect(mocks.mcp.connect).toHaveBeenCalledOnce());
    const calling = manager.callTool(TEST_UID, 'custom-shared', 'read_owner', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseConnect();
    await Promise.all([verifying, calling]);
    await manager.shutdownAll();

    const opened = new Set(mocks.mcp.connect.mock.contexts);
    const closed = new Set(mocks.mcp.close.mock.contexts);
    expect(closed).toEqual(opened);
    expect(mocks.mcp.callTool).toHaveBeenCalledOnce();
  });

  it.each(['refreshTools', 'removeInstance'] as const)(
    'settles pending discovery before %s replaces or removes its connection',
    async (operation) => {
      const registry = await import('../../../../src/main/features/connectors/registry');
      const manager = await import('../../../../src/main/features/connectors/manager');
      await registry.upsert(TEST_UID, {
        ...customAccountInstance('account-a'), status: { kind: 'connected', since: 1 },
      });
      let releaseTools!: () => void;
      const gate = new Promise<void>((resolve) => { releaseTools = resolve; });
      mocks.mcp.listTools.mockImplementationOnce(async () => {
        await gate;
        return [{ name: 'read_owner', description: '', input_schema: {} }];
      });
      mocks.mcp.close = vi.fn(async function close(this: any) { this.__closed = true; });
      mocks.mcp.callTool = vi.fn(async function call(this: any) {
        if (this.__closed) throw new Error('fixture connection was closed');
        return { ok: true };
      });
      const verifying = manager.verifyUsableConnectors(TEST_UID);
      await vi.waitFor(() => expect(mocks.mcp.listTools).toHaveBeenCalledOnce());
      const changing = manager[operation](TEST_UID, 'custom-shared');
      releaseTools();
      await Promise.all([verifying, changing]);
      if (operation === 'refreshTools') {
        await expect(manager.callTool(TEST_UID, 'custom-shared', 'read_owner', {})).resolves.toEqual({ ok: true });
      } else {
        expect(manager.getInstance(TEST_UID, 'custom-shared')).toBeNull();
        expect(new Set(mocks.mcp.close.mock.contexts)).toEqual(new Set(mocks.mcp.connect.mock.contexts));
      }
      await manager.shutdownAll();
      expect(new Set(mocks.mcp.close.mock.contexts)).toEqual(new Set(mocks.mcp.connect.mock.contexts));
    },
  );

  it('cancels a tool waiter without waiting for or disrupting shared panel discovery', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, {
      ...customAccountInstance('account-a'), status: { kind: 'connected', since: 1 },
    });
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    mocks.mcp.connect = vi.fn(() => gate);
    const verifying = manager.verifyUsableConnectors(TEST_UID);
    await vi.waitFor(() => expect(mocks.mcp.connect).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const calling = manager.callTool(TEST_UID, 'custom-shared', 'read_owner', {}, { signal: controller.signal });
    controller.abort();
    try {
      await expect(calling).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' });
      expect(mocks.mcp.callTool).not.toHaveBeenCalled();
      expect(mocks.mcp.connect).toHaveBeenCalledOnce();
    } finally {
      releaseConnect();
      await verifying;
      await manager.shutdownAll();
    }
  });

  it('invalidates and degrades a live connection after a tool-call timeout', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    await manager.bootstrap(TEST_UID);
    mocks.mcp.callTool = vi.fn(async () => { throw new Error('Request timed out'); });

    await expect(
      manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'slow' }),
    ).rejects.toThrow(/timed out/i);

    expect(mocks.mcp.close).toHaveBeenCalledTimes(1);
    expect(registry.load(TEST_UID).connections.github.status).toMatchObject({
      kind: 'degraded',
      failures: 1,
    });
    await expect(
      manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'again' }),
    ).rejects.toThrow(/not retrying/i);
    expect(mocks.mcp.callTool).toHaveBeenCalledTimes(1);
  });

  it('closes an in-flight connector on task cancellation without opening the failure circuit', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    await manager.bootstrap(TEST_UID);
    mocks.mcp.callTool = vi.fn((_name: string, _args: unknown, opts: { signal?: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })
    ));
    const controller = new AbortController();
    const pending = manager.callTool(
      TEST_UID,
      'github',
      'github_search_repositories',
      { query: 'cancel' },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mocks.mcp.callTool).toHaveBeenCalledTimes(1));
    controller.abort('user stopped task');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'E_TOOL_CALL_CANCELLED' });
    expect(mocks.mcp.close).toHaveBeenCalledTimes(1);
    expect(registry.load(TEST_UID).connections.github.status).toMatchObject({ kind: 'connected' });
  });

  it('reports the real reason when an on-demand connect fails transiently, not "connector unavailable"', async () => {
    // Regression: the exact production failure. The Server's session store went away, so
    // `/connectors/oauth/refresh` answered 503 系统繁忙 for every connector. The refresh error was
    // classified transient (correctly — 5xx is not an auth failure), the row was therefore NOT
    // marked `status:error`, and `callTool` keyed its message off `kind === 'error'` alone — so it
    // threw a bare `connector unavailable`, dropping the one string that explained everything. The
    // agent surfaced that to the user, who had no way to tell a backend outage from a dead grant.
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      throw new Error('refresh HTTP 503: {"code":1,"msg":"系统繁忙，请稍后重试"}');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = bingWebmasterInstance(['webmaster.read']);
    inst.oauth_grant.expires_at = Date.now() - 1; // stale → forces the refresh, which 503s
    await registry.upsert(TEST_UID, inst);

    await expect(
      manager.callTool(TEST_UID, 'bing-webmaster', 'list_sites', {}),
    ).rejects.toThrow(/503.*系统繁忙/);
    // …and it names which connector failed, so a multi-connector agent turn is attributable.
    await expect(
      manager.callTool(TEST_UID, 'bing-webmaster', 'list_sites', {}),
    ).rejects.toThrow(/bing-webmaster/);
  });

  it('opens a circuit breaker after repeated transient failures instead of retrying every call', async () => {
    // Each connect attempt is bounded on its own (3 tries in postConnectorBridgeJson), but nothing
    // bounded them ACROSS calls: a degraded connector stays routed to the model, so every tool call
    // re-ran the full refresh — 3 requests each, forever, against a backend already known to be
    // down. An agent turn could fire dozens. This pins the ceiling.
    const refresh = vi.fn(async () => {
      throw new Error('refresh HTTP 503: {"code":1,"msg":"系统繁忙，请稍后重试"}');
    });
    mocks.oauth.refreshIfStale = refresh;

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = bingWebmasterInstance(['webmaster.read']);
    inst.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, inst);

    // First call: pays the refresh, fails, opens the circuit.
    await expect(manager.callTool(TEST_UID, 'bing-webmaster', 'list_sites', {})).rejects.toThrow(/503/);
    expect(refresh).toHaveBeenCalledTimes(1);
    const opened = registry.load(TEST_UID).connections['bing-webmaster'].status as any;
    expect(opened.failures).toBe(1);
    expect(opened.retry_after).toBeGreaterThan(Date.now());

    // Every subsequent call inside the cooldown must touch NO network at all…
    for (let i = 0; i < 5; i += 1) {
      await expect(manager.callTool(TEST_UID, 'bing-webmaster', 'list_sites', {})).rejects.toThrow(/not retrying/);
    }
    expect(refresh).toHaveBeenCalledTimes(1);  // ← still 1: the ceiling held across 5 more calls

    // …while still telling the caller the real reason, not just "wait".
    await expect(manager.callTool(TEST_UID, 'bing-webmaster', 'list_sites', {})).rejects.toThrow(/503.*系统繁忙/);
  });

  it('backs off further on each consecutive failure and resets the breaker on success', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    mocks.oauth.refreshIfStale = vi.fn(async () => {
      throw new Error('refresh HTTP 503: {"code":1,"msg":"系统繁忙"}');
    });

    const inst = bingWebmasterInstance(['webmaster.read']);
    inst.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, inst);

    // refreshTools is the user pressing 重试 — it deliberately ignores the cooldown, so it is also
    // the lever this test uses to drive consecutive failures.
    await manager.refreshTools(TEST_UID, 'bing-webmaster').catch(() => {});
    const first = registry.load(TEST_UID).connections['bing-webmaster'].status as any;
    await manager.refreshTools(TEST_UID, 'bing-webmaster').catch(() => {});
    const second = registry.load(TEST_UID).connections['bing-webmaster'].status as any;

    expect(first.failures).toBe(1);
    expect(second.failures).toBe(2);
    // Ladder grows (30s → 1m). Jitter is ±20%, so compare windows rather than exact values.
    expect(second.retry_after - Date.now()).toBeGreaterThan(first.retry_after - Date.now());

    // A success clears the breaker entirely — no lingering failure count.
    mocks.oauth.refreshIfStale = vi.fn(async (_uid: string, _entry: unknown, grant: unknown) => ({
      ...(grant as object),
      access_token: 'fresh',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    await manager.refreshTools(TEST_UID, 'bing-webmaster');
    const healed = registry.load(TEST_UID).connections['bing-webmaster'].status as any;
    expect(healed.kind).toBe('connected');
    expect(healed.failures).toBeUndefined();
    expect(healed.retry_after).toBeUndefined();
  });

  it('skips bootstrap connects for connectors still in cooldown, so a restart cannot re-stampede', async () => {
    // The cooldown is persisted rather than in-memory precisely for this: quitting and reopening
    // the app during an outage used to start the retry storm over from zero on every launch.
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = githubInstance();
    (inst as any).status = {
      kind: 'degraded',
      message: 'refresh HTTP 503: {"code":1,"msg":"系统繁忙"}',
      at: Date.now(),
      failures: 4,
      retry_after: Date.now() + 10 * 60 * 1000,
    };
    await registry.upsert(TEST_UID, inst);

    await manager.bootstrap(TEST_UID);

    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    // Panel entry must not be an end-run around the ceiling either.
    expect(await manager.verifyUsableConnectors(TEST_UID, 'test')).toBe(0);
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
  });

  it('verifies only connectors whose last successful connect aged out, and skips the rest', async () => {
    // Cost guard for `verifyUsableConnectors`: the Connectors panel calls this on entry, and each
    // verification is an OAuth refresh + process spawn + list_tools. (Verification stops before any tool invocation.) A recently-verified row must still cost nothing, or opening the panel would stampede every
    // connector — and hammer a backend that is already failing.
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const fresh = githubInstance();
    (fresh as any).status = { kind: 'connected', since: Date.now() };  // verified just now
    await registry.upsert(TEST_UID, fresh);

    expect(await manager.verifyUsableConnectors(TEST_UID, 'test')).toBe(0);
    expect(mocks.mcp.connect).not.toHaveBeenCalled();

    // Same row, but last verified 6h ago → now due.
    const stale = githubInstance();
    (stale as any).status = { kind: 'connected', since: Date.now() - 6 * 60 * 60 * 1000 };
    await registry.upsert(TEST_UID, stale);

    expect(await manager.verifyUsableConnectors(TEST_UID, 'test')).toBe(1);
    expect(mocks.mcp.connect).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first tool calls onto one on-demand connection', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    await manager.bootstrap(TEST_UID);
    let releaseConnect!: () => void;
    mocks.mcp.connect = vi.fn(() => new Promise<void>((resolve) => { releaseConnect = resolve; }));

    const first = manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'one' });
    const second = manager.callTool(TEST_UID, 'github', 'github_search_repositories', { query: 'two' });
    await vi.waitFor(() => expect(mocks.mcp.connect).toHaveBeenCalledTimes(1));
    releaseConnect();
    await Promise.all([first, second]);

    expect(mocks.mcp.connect).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.callTool).toHaveBeenCalledTimes(2);
  });

  it('still repairs an unfinished connector row even when it has cached tools', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = sentryInstance();
    inst.status = { kind: 'connecting' };
    await registry.upsert(TEST_UID, inst);

    await manager.bootstrap(TEST_UID);

    expect(mocks.mcp.connect).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.listTools).toHaveBeenCalledTimes(1);
    expect(registry.load(TEST_UID).connections.sentry.status).toMatchObject({ kind: 'connected' });
  });

  it('caps bootstrap connection concurrency and batches final status persistence', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    for (let i = 0; i < 7; i++) {
      const now = new Date().toISOString();
      await registry.upsert(TEST_UID, {
        id: `custom-startup-${i}`,
        display_name: `Custom startup ${i}`,
        origin: 'custom',
        transport: { kind: 'stdio', command: 'node', args: ['server.js'] },
        enabled_subtools: null,
        tools_cache: [],
        tools_cached_at: 0,
        status: { kind: 'connecting' },
        created_at: now,
        updated_at: now,
      });
    }
    let active = 0;
    let maxActive = 0;
    mocks.mcp.connect = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
    });
    const updateManySpy = vi.spyOn(registry, 'updateMany');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await manager.bootstrap(TEST_UID);

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect((updateManySpy.mock.calls[0][1] as Map<string, unknown>).size).toBe(7);
    expect(Object.values(registry.load(TEST_UID).connections).every(
      (inst) => inst.status.kind === 'connected' && inst.tools_cache.length === 1,
    )).toBe(true);
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

  it('degrades (not errors, not "connected") an established connector when the refresh bridge replies 5xx', async () => {
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      throw new Error('refresh HTTP 503: {"code":1,"msg":"系统繁忙，请稍后重试"}');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = bingWebmasterInstance(['webmaster.read']);
    inst.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, inst);

    await manager.refreshTools(TEST_UID, 'bing-webmaster');
    const row = registry.load(TEST_UID).connections['bing-webmaster'];
    expect(row.status.kind).toBe('degraded');
    expect((row.status as { message: string }).message).toContain('503');
    expect(row.oauth_grant).toBeTruthy();
    expect(row.oauth_grant?.refresh_token).toBe(inst.oauth_grant.refresh_token);
  });

  it('degrades established server-bridge connectors when refresh_failed is localized by Server', async () => {
    mocks.oauth.refreshIfStale = vi.fn(async () => {
      throw new Error('刷新授权失败');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const bing = bingWebmasterInstance(['webmaster.read']);
    bing.oauth_grant.expires_at = Date.now() - 1;
    await registry.upsert(TEST_UID, bing);
    await manager.refreshTools(TEST_UID, 'bing-webmaster');
    expect(registry.load(TEST_UID).connections['bing-webmaster'].status.kind).toBe('degraded');
    expect(registry.load(TEST_UID).connections['bing-webmaster'].oauth_grant).toBeTruthy();

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
    expect(registry.load(TEST_UID).connections.github.status.kind).toBe('degraded');
    expect(registry.load(TEST_UID).connections.github.oauth_grant).toBeTruthy();
  });

  it('degrades established DCR connectors when local provider refresh returns a transient failure', async () => {
    mocks.dcr.refreshDcrIfStale = vi.fn(async () => {
      const err = new Error('Failed to refresh authorization') as Error & { code?: string; retryable?: boolean };
      err.code = 'connector_refresh_failed';
      err.retryable = true;
      throw err;
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'notion');

    const row = registry.load(TEST_UID).connections.notion;
    expect(row.status.kind).toBe('degraded');
    expect(row.oauth_grant).toBeTruthy();
  });

  it('keeps structured DCR reconnect-required rows visible for reconnect', async () => {
    mocks.dcr.refreshDcrIfStale = vi.fn(async () => {
      const err = new Error('Authorization expired. Please reconnect') as Error & { code?: string; retryable?: boolean };
      err.code = 'connector_reconnect_required';
      err.retryable = false;
      throw err;
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'notion');

    const row = manager.listInstances(TEST_UID).find((inst) => inst.id === 'notion');
    expect(row?.status).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Authorization expired'),
    });
    expect(registry.load(TEST_UID).connections.notion.auth_error).toMatchObject({
      code: 'connector_reconnect_required',
      message: expect.stringContaining('Authorization expired'),
    });
  });

  it('does not retry persisted DCR reconnect-required rows on bootstrap', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    inst.oauth_grant.refresh_token = null;
    (inst.oauth_grant as any).server_managed = true;
    (inst.oauth_grant as any).server_grant_id = 'grant-1';
    inst.status = {
      kind: 'error',
      message: 'connector_reconnect_required: 授权已失效，请重新连接',
      at: Date.now(),
    };
    delete (inst as any).dcr_client;
    await registry.upsert(TEST_UID, inst);

    await manager.bootstrap(TEST_UID);

    expect(mocks.dcr.refreshDcrIfStale).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.notion.auth_error).toMatchObject({
      code: 'connector_reconnect_required',
      message: expect.stringContaining('授权已失效'),
    });
  });

  it('repairs the legacy bootstrap auth marker caused by a device-local decrypt failure', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    (inst as any).status = {
      kind: 'error',
      message: 'connector_reconnect_required',
      at: Date.now(),
    };
    (inst as any).auth_error = {
      code: 'connector_reconnect_required',
      message: 'connector_reconnect_required',
      reason: 'bootstrap_dcr_auth_error',
      at: Date.now(),
    };
    await registry.upsert(TEST_UID, inst);

    await manager.bootstrap(TEST_UID);

    const repaired = registry.load(TEST_UID).connections.notion;
    expect(repaired.auth_error).toBeUndefined();
    expect(repaired.status.kind).toBe('connected');
    expect(mocks.mcp.connect).toHaveBeenCalled();
  });

  it('replaces a repaired legacy marker with the real provider auth failure when validation fails', async () => {
    mocks.dcr.refreshDcrIfStale = vi.fn(async () => {
      const err = new Error('Authorization expired at provider. Please reconnect') as Error & {
        code?: string;
        retryable?: boolean;
      };
      err.code = 'connector_reconnect_required';
      err.retryable = false;
      throw err;
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    inst.oauth_grant.expires_at = Date.now() - 1;
    (inst as any).status = {
      kind: 'error',
      message: 'connector_reconnect_required',
      at: Date.now(),
    };
    (inst as any).auth_error = {
      code: 'connector_reconnect_required',
      message: 'connector_reconnect_required',
      reason: 'bootstrap_dcr_auth_error',
      at: Date.now(),
    };
    await registry.upsert(TEST_UID, inst);

    await manager.bootstrap(TEST_UID);

    expect(mocks.dcr.refreshDcrIfStale).toHaveBeenCalledTimes(1);
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    const failed = registry.load(TEST_UID).connections.notion;
    expect(failed.status).toMatchObject({
      kind: 'error',
      message: 'Authorization expired at provider. Please reconnect',
    });
    expect(failed.auth_error).toMatchObject({
      code: 'connector_reconnect_required',
      message: 'Authorization expired at provider. Please reconnect',
      reason: 'dcr_auth_refresh_failed',
    });
  });

  it('does not persist or reconnect a connector whose secrets are unavailable on this device', async () => {
    const connectorPaths = await import('../../../../src/main/paths');
    const file = connectorPaths.userConnectorsConfigFile(TEST_UID);
    const source = notionInstance();
    const metadata: Record<string, unknown> = { ...source };
    delete metadata.oauth_grant;
    delete metadata.dcr_client;
    delete metadata.transport;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      connections: {
        notion: {
          ...metadata,
          status: { kind: 'connected', since: 1 },
          secrets_enc: 'ORKLSEC1.unavailable-on-this-device',
        },
      },
      oauth_hints: {},
      _deleted_at: {},
    }, null, 2));

    const manager = await import('../../../../src/main/features/connectors/manager');
    const listed = manager.getInstance(TEST_UID, 'notion');
    expect(listed?.status).toMatchObject({
      kind: 'error',
      message: 'connector_secrets_unavailable',
    });

    await expect(manager.refreshTools(TEST_UID, 'notion')).rejects.toMatchObject({
      code: 'connector_secrets_unavailable',
      retryable: false,
    });
    await expect(manager.callTool(TEST_UID, 'notion', 'search', {})).rejects.toMatchObject({
      code: 'connector_secrets_unavailable',
      retryable: false,
    });
    await manager.setEnabledSubtools(TEST_UID, 'notion', ['search']);
    await manager.bootstrap(TEST_UID);

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.connections.notion.status).toEqual({ kind: 'connected', since: 1 });
    expect(persisted.connections.notion.enabled_subtools).toEqual(['search']);
    expect(persisted.connections.notion.auth_error).toBeUndefined();
    expect(persisted.connections.notion.secrets_enc).toBe('ORKLSEC1.unavailable-on-this-device');
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
    expect(mocks.dcr.refreshDcrIfStale).not.toHaveBeenCalled();
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
    mocks.dcr.refreshDcrIfStale = vi.fn(async () => {
      throw new Error('DCR refresh HTTP 400: {"error":"invalid_grant","error_description":"Grant not found"}');
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    await registry.upsert(TEST_UID, inst);
    await manager.refreshTools(TEST_UID, 'notion');

    const row = manager.listInstances(TEST_UID).find((inst) => inst.id === 'notion');
    expect(row?.status).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('invalid_grant'),
    });
    expect(registry.load(TEST_UID).connections.notion).toBeTruthy();
    expect(registry.load(TEST_UID).connections.notion.auth_error).toMatchObject({
      code: 'connector_reconnect_required',
      message: expect.stringContaining('invalid_grant'),
    });

    mocks.dcr.refreshDcrIfStale.mockClear();
    await manager.bootstrap(TEST_UID);
    expect(mocks.dcr.refreshDcrIfStale).not.toHaveBeenCalled();
  });

  it('persists rotated local DCR grants without dropping the local client credentials', async () => {
    mocks.dcr.refreshDcrIfStale = vi.fn(async (_client, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await registry.upsert(TEST_UID, notionInstance());
    await manager.refreshTools(TEST_UID, 'notion');

    const stored = registry.load(TEST_UID).connections.notion;
    const grant = stored.oauth_grant;
    expect(mocks.dcr.refreshDcrIfStale).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'client-id' }),
      expect.objectContaining({ refresh_token: 'refresh-token' }),
      {},
    );
    expect(grant?.access_token).toBe('refreshed-access-token');
    expect(grant?.refresh_token).toBe('rotated-refresh-token');
    expect(stored.dcr_client).toMatchObject({ client_id: 'client-id' });
  });

  it('force refreshes local Notion grants when the MCP endpoint rejects the access token', async () => {
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
    const refreshDcrIfStale = vi.fn(async (_client, grant) => ({
      ...(grant as object),
      access_token: 'refreshed-notion-access',
      refresh_token: 'rotated-notion-refresh',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;
    mocks.dcr.refreshDcrIfStale = refreshDcrIfStale;

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    const inst = notionInstance();
    inst.oauth_grant = {
      ...inst.oauth_grant,
      access_token: 'stale-notion-access',
      refresh_token: 'stale-notion-refresh',
      expires_at: Date.now() + 60 * 60 * 1000,
    } as any;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    expect(connectMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(refreshDcrIfStale).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'client-id' }),
      expect.objectContaining({ access_token: 'stale-notion-access', refresh_token: 'stale-notion-refresh' }),
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
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.oauth_grant.expires_at = Date.now() + 60 * 60 * 1000;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    // A transient failure is retried (not force-refreshed) and the connector ends
    // connected; the `not force-refreshed` + connected status are the meaningful
    // invariant (exact connect counts are brittle implementation detail).
    expect(connectMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(mocks.dcr.refreshDcrIfStale).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({ kind: 'connected' });
  });

  it('degrades but keeps Notion tools/grant when transient MCP failures continue after retry', async () => {
    // The scenario is "transient failures CONTINUE" — every connect fails.
    const connectMock = vi.fn(async () => { throw new Error('fetch failed'); });
    const closeMock = vi.fn(async () => {});
    mocks.mcp.connect = connectMock;
    mocks.mcp.listTools = vi.fn(async () => [{ name: 'notion_search', description: '', input_schema: {} }]);
    mocks.mcp.close = closeMock;

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.tools_cache = [{ name: 'notion_search', description: '', input_schema: {} }];
    inst.oauth_grant.expires_at = Date.now() + 60 * 60 * 1000;

    await registry.upsert(TEST_UID, inst);
    const tools = await manager.refreshTools(TEST_UID, 'notion');

    expect(tools).toEqual([{ name: 'notion_search', description: '', input_schema: {} }]);
    // Despite every connect failing, this is still a network problem, not an
    // auth rejection. Keep the established state and do not force-refresh the
    // local grant just because the MCP endpoint was unreachable.
    expect(connectMock).toHaveBeenCalled();
    expect(mocks.dcr.refreshDcrIfStale).not.toHaveBeenCalled();
    // Established state kept (cached tools still served above) — but recorded as unverified, with
    // the real reason, rather than asserting a connection that never succeeded.
    const notionRow = registry.load(TEST_UID).connections.notion;
    expect(notionRow.status.kind).toBe('degraded');
    expect((notionRow.status as { message: string }).message).toContain('fetch failed');
    expect(notionRow.tools_cache.length).toBeGreaterThan(0);
  });

  it('degrades but keeps GitHub grant when transient MCP failures continue after retry', async () => {
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
    expect(registry.load(TEST_UID).connections.github.status.kind).toBe('degraded');
    // The un-rotated grant must survive the degrade — that is the whole point of not hard-erroring.
    expect(registry.load(TEST_UID).connections.github.oauth_grant?.access_token).toBe('ghu-token');
  });

  it('degrades stale GitHub reconnect errors when the latest failure is transient', async () => {
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
    // The sticky reconnect wording is cleared (the latest failure was transient, so the grant is
    // not proven dead), but the row lands on `degraded` — not a fabricated `connected`.
    expect(registry.load(TEST_UID).connections.github.status.kind).toBe('degraded');
  });

  it('projects persisted transient Notion errors with cached tools as degraded on list', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const inst = notionInstance();
    inst.tools_cache = [{ name: 'notion_search', description: '', input_schema: {} }];
    inst.status = { kind: 'error', message: 'fetch failed', at: Date.now() };

    await registry.upsert(TEST_UID, inst);

    const row = manager.listInstances(TEST_UID).find((item) => item.id === 'notion');
    expect(row?.status.kind).toBe('degraded');
    // The reason is carried onto the projection, so the card can show it.
    expect((row?.status as { message: string }).message).toContain('fetch failed');

    // Repeated reads are temporally pure: compatibility projection must not keep opening a fresh
    // cooldown that prevents this legacy row from ever being repaired automatically.
    const again = manager.listInstances(TEST_UID).find((item) => item.id === 'notion');
    expect(again?.status).toEqual(row?.status);
    expect((again?.status as any).retry_after).toBeUndefined();
    expect((again?.status as any).failures).toBeUndefined();

    // …and listing left disk alone.
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.load(TEST_UID).connections.notion.status).toMatchObject({
      kind: 'error',
      message: 'fetch failed',
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

  it('returns from beginOAuthConnect before callback completion and pushes the eventual result', async () => {
    let resolveGrant!: (grant: ReturnType<typeof githubGrant>) => void;
    mocks.oauth.startOAuth = vi.fn(() => new Promise((resolve) => { resolveGrant = resolve; }));
    const manager = await import('../../../../src/main/features/connectors/manager');

    const started = manager.beginOAuthConnect(TEST_UID, 'github');

    expect(started.attempt_id).toBeTruthy();
    await vi.waitFor(() => expect(mocks.oauth.startOAuth).toHaveBeenCalledTimes(1));
    expect(mocks.oauth.startOAuth).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'github' }),
      expect.objectContaining({ attemptId: started.attempt_id }),
    );
    expect(mocks.events.broadcastOAuthConnectOutcome).not.toHaveBeenCalled();

    resolveGrant(githubGrant());
    await vi.waitFor(() => {
      expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          catalog_id: 'github',
          result: 'success',
        }),
      );
    });
  });

  it('does not count an authorized but degraded MCP connection as a successful installation', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await registry.upsert(TEST_UID, githubInstance());
    mocks.oauth.startOAuth = vi.fn(async () => githubGrant());
    mocks.mcp.connect = vi.fn(async () => { throw new Error('fetch failed'); });
    manager.beginOAuthConnect(TEST_UID, 'github');
    await vi.waitFor(() => expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledOnce(), { timeout: 2000 });
  });

  it('reuses one local-CLI attempt and reports connecting until authorized tool discovery finishes', async () => {
    let finishAuthorization!: () => void;
    let finishDiscovery!: () => void;
    mocks.localCli.authorize = vi.fn(() => new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    }));
    const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve; });
    mocks.mcp.listTools = vi.fn(async () => {
      await discovery;
      return [{ name: 'execute_read', description: 'Read an official action.', input_schema: {} }];
    });
    const manager = await import('../../../../src/main/features/connectors/manager');

    const first = manager.beginOAuthConnect(TEST_UID, 'feishu');
    const repeated = manager.beginOAuthConnect(TEST_UID, 'feishu');

    expect(repeated.attempt_id).toBe(first.attempt_id);
    await vi.waitFor(() => expect(mocks.localCli.authorize).toHaveBeenCalledTimes(1));
    expect(mocks.events.broadcastOAuthConnectProgress).not.toHaveBeenCalled();
    expect(mocks.events.broadcastOAuthConnectOutcome).not.toHaveBeenCalled();

    finishAuthorization();
    try {
      await vi.waitFor(() => expect(mocks.mcp.listTools).toHaveBeenCalledOnce());
      expect(mocks.events.broadcastOAuthConnectProgress).toHaveBeenCalledExactlyOnceWith({
        attempt_id: first.attempt_id, catalog_id: 'feishu',
      });
      expect(manager.listInstances(TEST_UID).find((item) => item.id === 'feishu')?.status.kind).toBe('connecting');
      expect(mocks.events.broadcastOAuthConnectOutcome).not.toHaveBeenCalled();
      expect(manager.beginOAuthConnect(TEST_UID, 'feishu').attempt_id).toBe(first.attempt_id);
    } finally {
      finishDiscovery();
    }
    await vi.waitFor(() => {
      expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt_id: first.attempt_id,
          catalog_id: 'feishu',
          result: 'success',
        }),
      );
    });
    expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledTimes(1);
    expect(manager.listInstances(TEST_UID).find((item) => item.id === 'feishu')?.status.kind).toBe('connected');
  });

  it('delivers a local CLI denial detail without provisioning or including it in analytics', async () => {
    const reason = 'Organization CLI access is disabled. Contact your administrator.';
    mocks.localCli.authorize = vi.fn(async () => {
      throw Object.assign(new Error('local_cli_authorization_failed:dingtalk'), {
        code: 'local_cli_authorization_failed', authorization_detail: reason,
      });
    });
    const manager = await import('../../../../src/main/features/connectors/manager');
    const registry = await import('../../../../src/main/features/connectors/registry');
    const started = manager.beginOAuthConnect(TEST_UID, 'dingtalk');
    await vi.waitFor(() => expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledOnce());
    expect(mocks.events.broadcastOAuthConnectOutcome).toHaveBeenCalledWith(expect.objectContaining({
      attempt_id: started.attempt_id, result: 'failure', code: 'local_cli_authorization_failed',
      authorization_detail: reason,
    }));
    expect(registry.load(TEST_UID).connections.dingtalk).toBeUndefined();
    expect(mocks.events.broadcastOAuthConnectProgress).not.toHaveBeenCalled();
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
  });

});

describe('OAuth refresh ownership', () => {
  it('serializes overlapping discovery and refresh around one rotating grant', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const instance = notionInstance();
    instance.oauth_grant.expires_at = Date.now() + 3_600_000;
    instance.dcr_client = { client_id: 'local-client', token_endpoint: 'https://example.test/token' } as any;
    await registry.upsert(TEST_UID, instance);
    let rejectFirstConnect!: (error: Error) => void;
    let firstConnectStarted!: () => void;
    const firstConnect = new Promise<void>((resolve) => { firstConnectStarted = resolve; });
    mocks.mcp.connect = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectFirstConnect = reject;
      firstConnectStarted();
    })).mockResolvedValue(undefined);
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshing = new Promise<void>((resolve) => { refreshStarted = resolve; });
    mocks.dcr.refreshDcrIfStale = vi.fn(async (_client, grant) => {
      refreshStarted();
      await refreshGate;
      return { ...grant, access_token: 'rotated-access', refresh_token: 'rotated-once', expires_at: Date.now() + 3_600_000 };
    });
    const first = manager.refreshTools(TEST_UID, 'notion');
    await firstConnect;
    await registry.update(TEST_UID, 'notion', (current) => ({ ...current, oauth_grant: { ...current.oauth_grant!, expires_at: 1 } }));
    const second = manager.refreshTools(TEST_UID, 'notion');
    // The second refresh waits for the in-flight discovery. Rejecting that
    // discovery starts the forced grant refresh while the second caller is queued.
    rejectFirstConnect(new Error('401 Unauthorized'));
    await refreshing;
    // Allow the rejected connect to enter its forced-refresh path while the
    // ordinary remote request remains held at the explicit fixture gate.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRefresh();
    await Promise.all([first, second]);
    expect(mocks.dcr.refreshDcrIfStale).toHaveBeenCalledTimes(1);
    expect(registry.load(TEST_UID).connections.notion.oauth_grant?.refresh_token).toBe('rotated-once');
    expect(registry.load(TEST_UID).connections.notion.status.kind).toBe('connected');
  });

  it('does not count a Google grant rejected during verification as connected', async () => {
    await writeGoogleConnectorsConfig(true);
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const instance = googleInstance('gsheets', ['https://www.googleapis.com/auth/drive.file']);
    instance.oauth_grant.expires_at = 1;
    instance.tools_cache = [{ name: 'search', description: '', input_schema: {} }] as any;
    await registry.upsert(TEST_UID, instance);
    mocks.oauth.refreshIfStale = vi.fn(async () => { throw Object.assign(new Error('connector_reconnect_required'), { code: 'connector_reconnect_required' }); });
    expect(await manager.verifyUsableConnectors(TEST_UID)).toBe(0);
    expect(registry.load(TEST_UID).connections.gsheets.status.kind).toBe('error');
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
  });

  it('filters remote commerce tools at discovery and denies direct calls outside catalog policy', async () => {
    mocks.dcr.startMcpDcrOAuth = vi.fn(async () => ({
      grant: {
        access_token: 'paypal-access-token',
        refresh_token: null,
        expires_at: Date.now() + 60 * 60 * 1000,
        scopes: [],
        token_type: 'Bearer',
        server_grant_id: 'paypal-grant-1',
        server_managed: true,
      },
      client: {
        client_id: 'paypal-client-1',
        authorization_endpoint: 'https://mcp.paypal.com/authorize',
        token_endpoint: 'https://mcp.paypal.com/token',
      },
    }));
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'create_invoice', description: 'Create an invoice.', input_schema: {} },
      { name: 'create_refund', description: 'Refund a payment.', input_schema: {} },
      { name: 'unreviewed_future_admin_action', description: 'Must stay hidden.', input_schema: {} },
    ]);

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await manager.connectViaOAuth(TEST_UID, 'paypal');

    expect(registry.load(TEST_UID).connections.paypal.tools_cache).toEqual([
      expect.objectContaining({
        name: 'create_invoice',
        orkas_action_policy: expect.objectContaining({ risk: 'W', confirmation: 'preview' }),
      }),
      expect.objectContaining({
        name: 'create_refund',
        orkas_action_policy: expect.objectContaining({ risk: 'H', confirmation: 'fresh' }),
      }),
    ]);
    await expect(
      manager.callTool(TEST_UID, 'paypal', 'unreviewed_future_admin_action', {}),
    ).rejects.toThrow('connector_tool_not_allowed');
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();

    await expect(manager.callTool(TEST_UID, 'paypal', 'create_invoice', {})).resolves.toEqual({});
    expect(mocks.mcp.callTool).toHaveBeenCalledWith('create_invoice', {});
  });

  it('removes prohibited actions from fresh discovery before caching or exposing them', async () => {
    mocks.oauth.startOAuth = vi.fn(async () => githubGrant());
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'search_repositories', description: 'Search repositories.', input_schema: {} },
      { name: 'delete_organization', description: 'Delete organization.', input_schema: {} },
    ]);
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await manager.connectViaOAuth(TEST_UID, 'github');
    expect(registry.load(TEST_UID).connections.github.tools_cache.map((tool) => tool.name))
      .toEqual(['search_repositories']);
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
  });

  it('rejects forbidden account actions before connecting or sending to the provider even in trusted mode', async () => {
    const manager = await import('../../../../src/main/features/connectors/manager');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_auto');
    await expect(manager.callTool(TEST_UID, 'gmail', 'GMAIL_BATCH_DELETE_MESSAGES', {}))
      .rejects.toThrow('E_CONNECTOR_ACTION_UNAVAILABLE');
    expect(mocks.mcp.connect).not.toHaveBeenCalled();
    expect(mocks.mcp.callTool).not.toHaveBeenCalled();
  });

  it('binds NetSuite OAuth and reconnects to the validated account-specific standard SuiteApp', async () => {
    mocks.dcr.startMcpDcrOAuth = vi.fn(async () => ({
      grant: {
        access_token: 'netsuite-access-token',
        refresh_token: null,
        expires_at: Date.now() + 60 * 60 * 1000,
        scopes: [],
        token_type: 'Bearer',
        server_grant_id: 'netsuite-grant-1',
        server_managed: true,
      },
      client: {
        client_id: 'netsuite-client-1',
        authorization_endpoint: 'https://123456-sb1.app.netsuite.com/app/login/oauth2/authorize.nl',
        token_endpoint: 'https://123456-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      },
    }));
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'ns_getRecord', description: 'Get a record.', input_schema: {} },
      { name: 'ns_updateRecord', description: 'Update a record.', input_schema: {} },
      { name: 'tenant_custom_tool', description: 'Must stay hidden.', input_schema: {} },
    ]);
    const transports: any[] = [];
    mocks.mcp.connect = vi.fn(function (this: any) {
      transports.push(this.__transport);
      return Promise.resolve();
    });

    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    await manager.connectViaOAuth(TEST_UID, 'netsuite', {
      connectionParameters: { account_id: '123456_SB1' },
    });

    expect(mocks.dcr.startMcpDcrOAuth).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({
        id: 'netsuite',
        transport_template: expect.objectContaining({
          url: 'https://123456-sb1.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
        }),
      }),
      {},
    );
    const stored = registry.load(TEST_UID).connections.netsuite;
    expect(stored.connection_parameters).toEqual({ account_id: '123456_SB1' });
    expect(stored.tools_cache.map((tool) => tool.name)).toEqual(['ns_getRecord', 'ns_updateRecord']);
    expect(stored.tools_cache.find((tool) => tool.name === 'ns_updateRecord')?.orkas_action_policy)
      .toMatchObject({ risk: 'H', confirmation: 'fresh', sensitive_operation: 'business_record' });
    expect(transports.at(-1)?.url).toBe(
      'https://123456-sb1.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
    );

    await manager.refreshTools(TEST_UID, 'netsuite');
    expect(transports.at(-1)?.url).toBe(
      'https://123456-sb1.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
    );
  });

  it('rejects NetSuite endpoint injection synchronously before accepting an OAuth launch', async () => {
    const manager = await import('../../../../src/main/features/connectors/manager');

    expect(() => manager.beginOAuthConnect(TEST_UID, 'netsuite', {
      account_id: 'tenant.evil.example',
    })).toThrow('invalid NetSuite account ID');
    expect(mocks.dcr.startMcpDcrOAuth).not.toHaveBeenCalled();
    expect(mocks.events.broadcastOAuthConnectOutcome).not.toHaveBeenCalled();
  });

  it('keeps an existing PayPal Sandbox grant on its endpoint but rejects new sandbox installs', async () => {
    mocks.dcr.startMcpDcrOAuth = vi.fn(async () => ({
      grant: {
        access_token: 'paypal-sandbox-token',
        refresh_token: null,
        expires_at: Date.now() + 60 * 60 * 1000,
        scopes: [],
        token_type: 'Bearer',
        server_grant_id: 'paypal-sandbox-grant',
        server_managed: true,
      },
      client: {
        client_id: 'paypal-sandbox-client',
        authorization_endpoint: 'https://mcp.sandbox.paypal.com/authorize',
        token_endpoint: 'https://mcp.sandbox.paypal.com/token',
      },
    }));
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'list_transactions', description: 'List transactions.', input_schema: {} },
    ]);

    const manager = await import('../../../../src/main/features/connectors/manager');
    const registry = await import('../../../../src/main/features/connectors/registry');
    expect(() => manager.beginOAuthConnect(TEST_UID, 'paypal-sandbox'))
      .toThrow('New PayPal connections use production only');
    await expect(manager.connectViaOAuth(TEST_UID, 'paypal-sandbox'))
      .rejects.toThrow('New PayPal connections use production only');
    expect(mocks.dcr.startMcpDcrOAuth).not.toHaveBeenCalled();
    expect(registry.load(TEST_UID).connections['paypal-sandbox']).toBeUndefined();
    await registry.upsert(TEST_UID, {
      id: 'paypal-sandbox', display_name: 'PayPal Sandbox',
      transport: { kind: 'streamable-http', url: 'https://mcp.sandbox.paypal.com/http' },
      enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
      status: { kind: 'error', message: 'connector_reconnect_required', at: 1 },
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    });
    await manager.connectViaOAuth(TEST_UID, 'paypal-sandbox');

    expect(mocks.dcr.startMcpDcrOAuth).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({
        id: 'paypal-sandbox',
        transport_template: expect.objectContaining({ url: 'https://mcp.sandbox.paypal.com/http' }),
      }),
      {},
    );
    await expect(manager.connectViaOAuth(TEST_UID, 'paypal')).rejects.toThrow(
      'connector_variant_already_installed:paypal-sandbox',
    );
    await manager.refreshTools(TEST_UID, 'paypal-sandbox');
    expect(registry.load(TEST_UID).connections['paypal-sandbox'].transport)
      .toMatchObject({ url: 'https://mcp.sandbox.paypal.com/http' });
  });

  it.each(['square', 'instacart-shopping', 'reloadly', 'walmart-marketplace', 'ebay-seller', 'amazon-seller-central', 'shopee'])(
    'preserves the installed %s sandbox during refresh and rejects a production overwrite before cleanup', async (id) => {
      const manager = await import('../../../../src/main/features/connectors/manager');
      const registry = await import('../../../../src/main/features/connectors/registry');
      mocks.mcp.listTools = vi.fn(async () => [
        { name: 'list_capabilities', description: 'Reviewed actions.', input_schema: {} },
      ]);
      await registry.upsert(TEST_UID, {
        id, display_name: id,
        transport: { kind: 'stdio', command: 'node', args: ['direct-commerce-mcp-server.cjs'] },
        enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
        connection_parameters: { environment: 'sandbox', market: 'us' },
        status: { kind: 'error', message: 'connector_reconnect_required', at: 1 },
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
      });
      await manager.refreshTools(TEST_UID, id);
      expect(mocks.localApi.transport).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ id }),
        expect.objectContaining({ environment: 'sandbox' }));
      const before = registry.load(TEST_UID).connections[id];
      expect(() => manager.beginOAuthConnect(TEST_UID, id, {}))
        .toThrow('Disconnect the existing test connection');
      await expect(manager.connectViaOAuth(TEST_UID, id, { connectionParameters: {} }))
        .rejects.toThrow('Disconnect the existing test connection');
      expect(registry.load(TEST_UID).connections[id]).toEqual(before);
      expect(mocks.localApi.authorize).not.toHaveBeenCalled();
      expect(mocks.localApi.remove).not.toHaveBeenCalled();
      // Explicit disconnect is the recovery boundary; a later installation can use production.
      await manager.removeInstance(TEST_UID, id);
      mocks.localApi.authorize.mockResolvedValue({ environment: 'live' });
      await manager.connectViaOAuth(TEST_UID, id, { connectionParameters: {} });
      expect(registry.load(TEST_UID).connections[id].connection_parameters).toEqual({ environment: 'live' });
    },
  );

  it('keeps legacy standalone Lark installs mutually exclusive with the unified Feishu entry', async () => {
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'execute_read', description: 'Read an official action.', input_schema: {} },
    ]);
    const manager = await import('../../../../src/main/features/connectors/manager');

    await manager.connectViaOAuth(TEST_UID, 'lark');

    await expect(manager.connectViaOAuth(TEST_UID, 'feishu')).rejects.toThrow(
      'connector_variant_already_installed:lark',
    );
    expect(mocks.localCli.authorize).toHaveBeenCalledTimes(1);
  });

  it('authorizes, provisions, reconnects and removes an official local-CLI connector without an OAuth grant', async () => {
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'execute_read', description: 'Read an official action.', input_schema: {} },
      { name: 'execute_write', description: 'Write an official action.', input_schema: {} },
      { name: 'raw_cli', description: 'Must stay hidden.', input_schema: {} },
    ]);
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');

    await manager.connectViaOAuth(TEST_UID, 'wecom');

    expect(mocks.localCli.authorize).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'wecom', auth_mode: 'local_cli' }),
    );
    const stored = registry.load(TEST_UID).connections.wecom;
    expect(stored.oauth_grant).toBeUndefined();
    expect(stored.tools_cache).toEqual([
      expect.objectContaining({
        name: 'execute_read',
        orkas_action_policy: expect.objectContaining({ risk: 'R', confirmation: 'none' }),
      }),
      expect.objectContaining({
        name: 'execute_write',
        orkas_action_policy: expect.objectContaining({ risk: 'W', confirmation: 'preview' }),
      }),
    ]);

    await manager.refreshTools(TEST_UID, 'wecom');
    expect(mocks.localCli.transport).toHaveBeenCalledTimes(3);
    let releaseLogout!: () => void;
    mocks.localCli.remove = vi.fn(() => new Promise<void>((resolve) => { releaseLogout = resolve; }));
    const removal = manager.removeInstance(TEST_UID, 'wecom');
    try {
      await vi.waitFor(() => expect(mocks.localCli.remove).toHaveBeenCalledOnce());
      expect(registry.load(TEST_UID).connections.wecom).toBeDefined();
    } finally {
      releaseLogout();
      await removal;
    }
    expect(registry.load(TEST_UID).connections.wecom).toBeUndefined();
    expect(mocks.localCli.remove).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'wecom' }),
    );
  });

  it('keeps direct-commerce credentials device-local across connect, refresh, list, and removal', async () => {
    const liveTransports: any[] = [];
    mocks.mcp.connect = vi.fn(function (this: any) {
      liveTransports.push(this.__transport);
      return Promise.resolve();
    });
    mocks.mcp.listTools = vi.fn(async () => [
      { name: 'list_capabilities', description: 'Reviewed actions.', input_schema: {} },
      { name: 'execute_read', description: 'Read.', input_schema: {} },
      { name: 'execute_high_impact', description: 'Financial.', input_schema: {} },
      { name: 'unreviewed_raw_request', description: 'Must stay hidden.', input_schema: {} },
    ]);
    const registry = await import('../../../../src/main/features/connectors/registry');
    const manager = await import('../../../../src/main/features/connectors/manager');
    const raw = {
      shop_domain: 'merchant.myshopify.com',
      client_id: 'shopify-client',
      client_secret: 'shopify-client-secret',
    };

    await manager.connectViaOAuth(TEST_UID, 'shopify-admin', { connectionParameters: raw, attemptId: 'direct-api-attempt' });

    expect(mocks.localApi.authorize).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'shopify-admin', auth_mode: 'local_api' }),
      raw,
      { attemptId: 'direct-api-attempt' },
    );
    const stored = registry.load(TEST_UID).connections['shopify-admin'];
    expect(stored.oauth_grant).toBeUndefined();
    expect(stored.connection_parameters).toEqual({ shop_domain: 'merchant.myshopify.com' });
    expect(JSON.stringify(stored)).not.toContain('shopify-client');
    expect(JSON.stringify(stored)).not.toContain('shopify-client-secret');
    expect(stored.transport.kind === 'stdio' ? stored.transport.env : undefined).toBeUndefined();
    expect(stored.tools_cache.map((tool) => tool.name)).toEqual([
      'list_capabilities', 'execute_read', 'execute_high_impact',
    ]);
    expect(stored.tools_cache.find((tool) => tool.name === 'execute_high_impact')?.orkas_action_policy)
      .toMatchObject({ risk: 'H', confirmation: 'fresh' });
    expect(liveTransports.at(-1)?.env).toMatchObject({
      ORKAS_LOCAL_API_CREDENTIAL_KEY: 'device-only-key',
      ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ shop_domain: 'merchant.myshopify.com' }),
    });

    await manager.refreshTools(TEST_UID, 'shopify-admin');
    const refreshed = registry.load(TEST_UID).connections['shopify-admin'];
    expect(refreshed.transport.kind === 'stdio' ? refreshed.transport.env : undefined).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain('device-only-key');

    mocks.localApi.hasAuthorization.mockReturnValue(false);
    expect(manager.listInstances(TEST_UID).find((item) => item.id === 'shopify-admin')?.status)
      .toMatchObject({ kind: 'error', message: 'local_api_credentials_missing:shopify-admin' });
    expect(registry.load(TEST_UID).connections['shopify-admin'].status.kind).toBe('connected');

    await manager.removeInstance(TEST_UID, 'shopify-admin');
    expect(mocks.localApi.remove).toHaveBeenCalledWith(
      TEST_UID,
      expect.objectContaining({ id: 'shopify-admin' }),
    );
  });

});
