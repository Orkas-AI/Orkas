import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  key: 'orkas-test-key',
  status: {
    configured: true,
    scopes: ['connectors'],
    connectorAccess: true,
  },
}));

vi.mock('../../../../src/main/features/auth', () => ({
  getOrkasApiKey: () => state.key,
  getOrkasApiCredentialStatus: () => state.status,
}));

vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({
  accountApiBase: () => 'https://api.example.test/api',
}));

vi.mock('../../../../src/main/features/api_common', () => ({
  withCommonHeaders: (headers: Record<string, string>) => ({
    'X-Orkas-Client-Channel': 'open',
    ...headers,
  }),
}));

describe('connector API-key metering', () => {
  beforeEach(() => {
    state.key = 'orkas-test-key';
    state.status = {
      configured: true,
      scopes: ['connectors'],
      connectorAccess: true,
    };
    vi.unstubAllGlobals();
  });

  it('blocks a paid connector before any request when no API key is configured', async () => {
    state.key = '';
    state.status = { configured: false, scopes: [], connectorAccess: false };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { preflightConnectorCredits } = await import(
      '../../../../src/main/features/connectors/usage-metering'
    );

    await expect(preflightConnectorCredits({
      id: 'gmail',
      usage_metering: { provider: 'composio', credits_milli_per_call: 250 },
    } as any, 'connect')).rejects.toMatchObject({ code: 'orkas_api_key_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a locally saved key and reports revocation from the service', async () => {
    state.status = { configured: true, scopes: [], connectorAccess: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Invalid API key' },
    }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { preflightConnectorCredits } = await import(
      '../../../../src/main/features/connectors/usage-metering'
    );

    await expect(preflightConnectorCredits({
      id: 'gmail',
      usage_metering: { provider: 'composio', credits_milli_per_call: 250 },
    } as any, 'connect')).rejects.toMatchObject({ code: 'invalid_api_key' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reuses the connector preflight route with Bearer auth and open client headers', async () => {
    state.status = { configured: true, scopes: [], connectorAccess: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      credits_milli_per_call: 250,
      available_credits_milli: 5_000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { preflightConnectorCredits } = await import(
      '../../../../src/main/features/connectors/usage-metering'
    );

    await expect(preflightConnectorCredits({
      id: 'gmail',
      usage_metering: { provider: 'composio', credits_milli_per_call: 250 },
    } as any, 'tool_call')).resolves.toMatchObject({ code: 0 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/connectors/usage/preflight',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer orkas-test-key',
          'X-Orkas-Client-Channel': 'open',
        }),
      }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: 'composio',
      connector_id: 'gmail',
      stage: 'tool_call',
      calls: 1,
    });
  });
});
