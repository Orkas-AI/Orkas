import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ipc-connectors-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  vi.doUnmock('../../../src/main/features/connectors');
  vi.doUnmock('../../../src/main/features/component_enabled');
  vi.doUnmock('../../../src/main/features/connectors/availability');
  vi.doUnmock('../../../src/main/features/connectors/api-key');
  vi.doUnmock('../../../src/main/features/connectors/local-cli');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseInstance(transport: any): any {
  const now = '2026-06-01T12:00:00.000Z';
  return {
    id: 'custom-secret',
    display_name: 'Secret Server',
    origin: 'custom',
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected', since: 1 },
    oauth_grant: {
      account_label: 'me@example.com',
      access_token: 'oauth-access-secret',
      refresh_token: 'oauth-refresh-secret',
    },
    composio_grant: { connection_id: 'conn-1', connection_token: 'connection-private-secret', toolkit: 'gmail', auth_config_id: 'ac_public' },
    created_at: now,
    updated_at: now,
  };
}

describe('ipc/connectors renderer DTO', () => {
  it('accepts one-time and task approval responses and rejects unknown scopes', async () => {
    // IPC deliberately uses CJS for the gate; share that module instance.
    const users = require('../../../src/main/features/users') as typeof import('../../../src/main/features/users');
    users.activateUser('approval-ipc');
    const permissions = require('../../../src/main/features/permissions') as typeof import('../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const confirm = require('../../../src/main/features/connectors/action_confirm') as typeof import('../../../src/main/features/connectors/action_confirm');
    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    let info: any;
    confirm._setBroadcastForTest((_channel, payload) => { info = payload; });
    const opts = { cid: 'ipc-task', connectorId: 'feishu', displayName: 'Feishu', toolName: 'send', risk: 'H' as const, args: {} };
    const once = confirm.requestActionConfirm(opts);
    const answer = invokeHandlers['connectors.action_confirm_response'];
    await expect(answer({ request_id: info.request_id, approved: true, scope: 'forever' })).rejects.toThrow('invalid approval scope');
    await expect(answer({ request_id: info.request_id, approved: true })).resolves.toEqual({ handled: true });
    await expect(once).resolves.toBe(true);
    const task = confirm.requestActionConfirm(opts);
    await expect(answer({ request_id: info.request_id, approved: true, scope: 'task' })).resolves.toEqual({ handled: true });
    await expect(task).resolves.toBe(true);
    await expect(confirm.requestActionConfirm({ ...opts, toolName: 'delete', risk: 'D' })).resolves.toBe(true);
    confirm.cancelForCid(opts.cid);
    confirm._setBroadcastForTest(null);
  });

  it('checks permissions on page verification and explicit refresh, while ordinary listing remains passive', async () => {
    const instance = { ...baseInstance({ kind: 'stdio' }), id: 'feishu', origin: undefined };
    const entry = { id: 'feishu', auth_mode: 'local_cli' };
    const check = vi.fn(async () => undefined);
    vi.doMock('../../../src/main/features/connectors/local-cli', () => ({
      checkLocalCliPermissions: check, localCliMissingPermissions: () => ['im:message.send_as_user'],
    }));
    vi.doMock('../../../src/main/features/connectors', () => ({
      connectorCatalog: () => [entry], listInstances: () => [instance],
      verifyUsableConnectors: async () => 0, refreshTools: async () => [],
      getInstance: () => instance, isValidInstanceId: () => true,
    }));
    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    await invokeHandlers['connectors.list']({}, { userId: 'page-user' });
    expect(check).not.toHaveBeenCalled();
    const result = await invokeHandlers['connectors.verify']({}, { userId: 'page-user' });
    expect(check).toHaveBeenCalledWith('page-user', entry);
    expect(result.instances[0]).toMatchObject({ status: { kind: 'connected' }, reauthorization_required: true,
      missing_permissions: ['im:message.send_as_user'] });
    await invokeHandlers['connectors.refresh']({ id: 'feishu' }, { userId: 'page-user' });
    expect(check).toHaveBeenLastCalledWith('page-user', entry, true);
  });

  it('projects missing permissions for a usable Feishu card without exposing identity or granted permissions', async () => {
    const runtime = await import('../../../src/main/features/connectors/local-cli');
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const directory = runtime.localCliRuntimeDir('u-ipc', 'feishu');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.orkas-user-permissions.json'), JSON.stringify({
      profile: runtime.localCliProfileName('u-ipc', 'feishu'), scopes: ['im:message.send_as_user'],
    }));
    const instance = { ...baseInstance({ kind: 'stdio', command: 'node' }), id: 'feishu', origin: undefined };
    const dto = _toClientInstanceForTest(instance, true, 'u-ipc');
    expect(dto.reauthorization_required).toBe(true);
    expect(dto.status.kind).toBe('connected');
    expect(dto.missing_permissions).toEqual(['im:message.send_as_user']);
    expect(JSON.stringify(dto)).not.toContain('orkas-');
    expect(_toClientInstanceForTest(instance, true, 'another-account').reauthorization_required).toBeUndefined();
    expect(_toClientInstanceForTest({ ...instance, id: 'lark' }, true, 'u-ipc').reauthorization_required).toBeUndefined();
    expect(_toClientInstanceForTest({ ...instance, origin: 'custom' }, true, 'u-ipc').reauthorization_required).toBeUndefined();
  });

  it('accepts OAuth start without waiting for the browser callback', async () => {
    const beginOAuthConnect = vi.fn(() => ({ attempt_id: 'attempt-1' }));
    vi.doMock('../../../src/main/features/connectors', () => ({
      beginOAuthConnect,
      findCatalogEntry: () => ({ id: 'github', auth_mode: 'server_bridge' }),
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    const out = await invokeHandlers['connectors.start_oauth'](
      { catalog_id: 'github' },
      { userId: 'u-ipc' },
    );

    expect(beginOAuthConnect).toHaveBeenCalledWith('u-ipc', 'github');
    expect(out).toEqual({ started: true, attempt_id: 'attempt-1' });
  });

  it('returns a settings redirect contract before starting a paid connector without an API key', async () => {
    const beginOAuthConnect = vi.fn();
    vi.doMock('../../../src/main/features/connectors', () => ({
      beginOAuthConnect,
      findCatalogEntry: () => ({ id: 'composio-mail', auth_mode: 'composio', requires_credits: true }),
    }));
    vi.doMock('../../../src/main/features/connectors/api-key', () => ({
      requireConnectorApiKey: () => {
        throw Object.assign(new Error('Configure an Orkas API Key first.'), {
          code: 'orkas_api_key_required',
        });
      },
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    await expect(invokeHandlers['connectors.start_oauth'](
      { catalog_id: 'composio-mail' },
      { userId: 'u-ipc' },
    )).resolves.toMatchObject({
      ok: false,
      code: 'orkas_api_key_required',
      requires_api_key: true,
      settings_tab: 'credentials',
    });
    expect(beginOAuthConnect).not.toHaveBeenCalled();
  });

  it('forwards account-specific connection parameters to the main-process validator', async () => {
    const beginOAuthConnect = vi.fn(() => ({ attempt_id: 'attempt-netsuite' }));
    vi.doMock('../../../src/main/features/connectors', () => ({ beginOAuthConnect, findCatalogEntry: () => ({ id: 'netsuite', auth_mode: 'server_bridge' }) }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    const out = await invokeHandlers['connectors.start_oauth'](
      { catalog_id: 'netsuite', connection_parameters: { account_id: '123456_SB1' } },
      { userId: 'u-ipc' },
    );

    expect(beginOAuthConnect).toHaveBeenCalledWith(
      'u-ipc',
      'netsuite',
      { account_id: '123456_SB1' },
    );
    expect(out).toEqual({ started: true, attempt_id: 'attempt-netsuite' });
  });

  it('checks and installs only a catalog-pinned local CLI for the active user', async () => {
    const entry = {
      id: 'dingtalk',
      display_name: '钉钉',
      auth_mode: 'local_cli',
      local_cli: { executable: 'dws' },
    };
    const status = {
      installed: false,
      runtime_ready: true,
      package_name: 'dingtalk-workspace-cli',
      package_version: '1.0.61',
      executable: 'dws',
    };
    const localCliInstallStatus = vi.fn(() => status);
    const installLocalCli = vi.fn(async () => ({ ...status, installed: true }));
    vi.doMock('../../../src/main/features/connectors', () => ({
      findCatalogEntry: vi.fn((id) => id === 'dingtalk' ? entry : undefined),
      localCliInstallStatus,
      installLocalCli,
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    await expect(invokeHandlers['connectors.local_cli_status'](
      { catalog_id: 'dingtalk' }, { userId: 'u-cli' },
    )).resolves.toEqual({ status });
    await expect(invokeHandlers['connectors.install_local_cli'](
      { catalog_id: 'dingtalk' }, { userId: 'u-cli' },
    )).resolves.toEqual({ status: { ...status, installed: true } });
    expect(localCliInstallStatus).toHaveBeenCalledWith('u-cli', entry);
    expect(installLocalCli).toHaveBeenCalledWith('u-cli', entry);
  });

  it('rejects local CLI preparation for a non-CLI catalog entry', async () => {
    vi.doMock('../../../src/main/features/connectors', () => ({
      findCatalogEntry: vi.fn(() => ({ id: 'github', auth_mode: 'composio' })),
      localCliInstallStatus: vi.fn(),
      installLocalCli: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    await expect(invokeHandlers['connectors.install_local_cli'](
      { catalog_id: 'github' }, { userId: 'u-cli' },
    )).rejects.toThrow('not a local CLI connector');
  });

  it('routes local CLI browser opening through the connector-specific main-process boundary', async () => {
    const openLocalCliAuthorizationUrl = vi.fn(async () => undefined);
    vi.doMock('../../../src/main/features/connectors', () => ({ openLocalCliAuthorizationUrl }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    const url = 'https://open.feishu.cn/page/cli?user_code=FEISHU-42';

    await expect(invokeHandlers['connectors.open_local_cli_auth_url']({ url }))
      .resolves.toEqual({ opened: true });
    expect(openLocalCliAuthorizationUrl).toHaveBeenCalledWith(url);
  });

  it('lists local connector state without triggering Composio restore', async () => {
    const restoreComposioConnectionsFromServer = vi.fn(async () => 0);
    vi.doMock('../../../src/main/features/connectors', () => ({
      listInstances: vi.fn(() => [baseInstance({
        kind: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {},
      })]),
      restoreComposioConnectionsFromServer,
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    const out = await invokeHandlers['connectors.list']({}, { userId: 'u-ipc' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(out.instances.map((inst) => inst.id)).toEqual(['custom-secret']);
    expect(restoreComposioConnectionsFromServer).not.toHaveBeenCalled();
  });

  it('does not expose stdio argv/env secrets', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const dto = _toClientInstanceForTest(baseInstance({
      kind: 'stdio',
      command: '/usr/local/bin/node',
      args: ['server.js', '--api-key', 'sk-secret'],
      env: { ACCESS_TOKEN: 'env-secret' },
    }), true);

    const json = JSON.stringify(dto);
    expect(dto.transport).toEqual({ kind: 'stdio', summary: 'node (3 args)', command: 'node', argument_count: 3 });
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('env-secret');
    expect(json).not.toContain('oauth-access-secret');
    expect(json).not.toContain('oauth-refresh-secret');
    expect(json).not.toContain('connection-private-secret');
    expect(dto).not.toHaveProperty('composio_grant');
  });

  it('exposes only the environment enum needed to keep legacy test connections isolated', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    for (const environment of ['sandbox', 'live', 'private-unrecognized-value']) {
      const dto = _toClientInstanceForTest({
        ...baseInstance({ kind: 'stdio', command: 'node', args: [] }),
        connection_parameters: { environment, app_secret: 'metadata-secret', shop_id: 'private-shop' },
      });
      expect(dto.connection_environment).toBe(environment === 'sandbox' || environment === 'live' ? environment : undefined);
      expect(JSON.stringify(dto)).not.toMatch(/metadata-secret|private-shop|private-unrecognized-value|connection_parameters/);
    }
  });

  it('strips credentials, query, and fragment from streamable-http URLs', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const dto = _toClientInstanceForTest(baseInstance({
      kind: 'streamable-http',
      url: 'https://user:pass@example.com/mcp?token=sk-secret#frag',
      headers: { Authorization: 'Bearer header-secret' },
    }));

    const json = JSON.stringify(dto);
    expect(dto.transport).toEqual({ kind: 'streamable-http', summary: 'https://example.com/mcp' });
    expect(json).not.toContain('user:pass');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('header-secret');
  });

  it('keeps an undecryptable connector row listable without a transport', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const inst = baseInstance(undefined);
    inst.status = { kind: 'error', message: 'connector_reconnect_required', at: 1 };

    const dto = _toClientInstanceForTest(inst);

    expect(dto.transport).toBeUndefined();
    expect(dto.status).toEqual(inst.status);
  });

  it('does not expose hosted Discord webhook target metadata or secrets', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const dto = _toClientInstanceForTest({
      ...baseInstance({
        kind: 'stdio',
        command: '/usr/local/bin/node',
        args: ['discord-mcp-server.cjs'],
        env: {},
      }),
      id: 'discord',
      display_name: 'Discord',
      origin: undefined,
      discord_webhook_targets: [{
        id: 'discord-wh-1',
        webhook_id: 'webhook-1',
        webhook_token: 'webhook-token-secret',
        webhook_url: 'https://discord.com/api/webhooks/webhook-1/webhook-token-secret',
        guild_id: 'guild-1',
        guild_name: 'Orkas Lab',
        channel_id: 'channel-1',
        channel_name: 'alerts',
        created_at: '2026-06-29T00:00:00.000Z',
        updated_at: '2026-06-29T00:00:00.000Z',
      }],
    }, true);

    const json = JSON.stringify(dto);
    expect(json).not.toContain('Orkas Lab');
    expect(json).not.toContain('alerts');
    expect(json).not.toContain('webhook-token-secret');
    expect(json).not.toContain('discord.com/api/webhooks');
    expect(dto.oauth_grant).toEqual({ account_label: 'me@example.com' });
  });

  it('returns the latest connector status after refresh', async () => {
    const degraded = {
      ...baseInstance({
        kind: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {},
      }),
      status: { kind: 'degraded', message: 'fetch failed', at: 1 },
      tools_cache: [{ name: 'cached', description: '', input_schema: {} }],
    };
    const refreshTools = vi.fn(async () => degraded.tools_cache);
    vi.doMock('../../../src/main/features/connectors', () => ({
      refreshTools,
      getInstance: vi.fn(() => degraded),
      isValidInstanceId: vi.fn(() => true),
    }));
    vi.doMock('../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
      setConnectorEnabled: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/connectors/availability', () => ({
      catalogWithAvailability: vi.fn((catalog) => catalog),
      isConnectorRuntimeEnabled: vi.fn(() => true),
    }));

    const { invokeHandlers } = await import('../../../src/main/ipc/connectors');
    const out = await invokeHandlers['connectors.refresh']({ id: 'custom-secret' }, { userId: 'u-ipc' });

    expect(refreshTools).toHaveBeenCalledWith('u-ipc', 'custom-secret');
    expect(out.tools).toEqual(degraded.tools_cache);
    expect(out.instance.status).toMatchObject({ kind: 'degraded', message: 'fetch failed' });
  });
});
