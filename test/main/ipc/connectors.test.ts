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
    created_at: now,
    updated_at: now,
  };
}

describe('ipc/connectors renderer DTO', () => {
  it('accepts OAuth start without waiting for the browser callback', async () => {
    const beginOAuthConnect = vi.fn(() => ({ attempt_id: 'attempt-1' }));
    vi.doMock('../../../src/main/features/connectors', () => ({ beginOAuthConnect }));
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
    expect(dto.transport).toEqual({ kind: 'stdio', summary: 'node (3 args)' });
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('env-secret');
    expect(json).not.toContain('oauth-access-secret');
    expect(json).not.toContain('oauth-refresh-secret');
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
