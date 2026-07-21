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
    broadcastOAuthConnectOutcome: undefined as any,
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
  broadcastOAuthConnectOutcome: (...args: any[]) => mocks.events.broadcastOAuthConnectOutcome(...args),
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

});
