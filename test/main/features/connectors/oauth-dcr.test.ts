import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  shell: { openExternal: electronMock.openExternal },
}));

vi.mock('../../../../src/main/features/account/server', () => ({
  accountApiBase: () => 'https://account.example/api',
}));

vi.mock('../../../../src/main/features/account/token_store', () => ({
  getDeviceId: () => 'device-1',
  authHeaders: () => ({ user_id: 'uid-1', session_id: 'sid-1' }),
}));

vi.mock('../../../../src/main/features/config', () => ({
  getLanguage: () => 'en',
}));

function notionEntry() {
  return {
    id: 'notion',
    display_name: 'Notion',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.notion.example/mcp',
      oauth_header_key: 'Authorization',
    },
  } as any;
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('features/connectors/oauth-dcr', () => {
  it('discovers DCR endpoints, registers a client, and opens an authorize URL with PKCE + resource', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/mcp/.well-known/oauth-protected-resource')) {
        return jsonResponse({
          authorization_servers: ['https://auth.notion.example'],
          resource: 'https://mcp.notion.example/mcp',
        });
      }
      if (String(url) === 'https://auth.notion.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://auth.notion.example/authorize',
          token_endpoint: 'https://auth.notion.example/token',
          registration_endpoint: 'https://auth.notion.example/register',
        });
      }
      if (String(url) === 'https://auth.notion.example/register') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.redirect_uris).toEqual(['https://account.example/api/connectors/oauth/dcr-callback']);
        expect(body.grant_types).toContain('authorization_code');
        return jsonResponse({ client_id: 'client-1', client_secret: 'secret-1' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    void startMcpDcrOAuth('uid-1', notionEntry()).catch(() => {});
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });

    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.href.startsWith('https://auth.notion.example/authorize?')).toBe(true);
    expect(opened.searchParams.get('response_type')).toBe('code');
    expect(opened.searchParams.get('client_id')).toBe('client-1');
    expect(opened.searchParams.get('redirect_uri')).toBe('https://account.example/api/connectors/oauth/dcr-callback');
    expect(opened.searchParams.get('resource')).toBe('https://mcp.notion.example/mcp');
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    expect(opened.searchParams.get('code_challenge')).toBeTruthy();
    expect(opened.searchParams.get('state')).toBeTruthy();
    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=cancelled');
  });

  it('rejects a DCR callback with mismatched state before calling the provider token endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/mcp/.well-known/oauth-protected-resource')) {
        return jsonResponse({
          authorization_servers: ['https://auth.notion.example'],
          resource: 'https://mcp.notion.example/mcp',
        });
      }
      if (String(url) === 'https://auth.notion.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://auth.notion.example/authorize',
          token_endpoint: 'https://auth.notion.example/token',
          registration_endpoint: 'https://auth.notion.example/register',
        });
      }
      if (String(url) === 'https://auth.notion.example/register') {
        return jsonResponse({ client_id: 'client-1', client_secret: 'secret-1' });
      }
      if (String(url) === 'https://account.example/api/connectors/oauth/dcr-exchange') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.exchange_code).toBe('exchange-1');
        return jsonResponse({ code: 0, oauth_code: 'provider-code', oauth_state: 'wrong-state' });
      }
      if (String(url) === 'https://auth.notion.example/token') {
        throw new Error('token endpoint must not be called after state mismatch');
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    const pending = startMcpDcrOAuth('uid-1', notionEntry());
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });

    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=exchange-1');
    await expect(pending).rejects.toThrow(/state mismatch/);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'https://auth.notion.example/token')).toBe(false);
  });

  it('stores a completed DCR grant on Server and returns only a server grant handle', async () => {
    let openedState = '';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/mcp/.well-known/oauth-protected-resource')) {
        return jsonResponse({
          authorization_servers: ['https://auth.notion.example'],
          resource: 'https://mcp.notion.example/mcp',
        });
      }
      if (String(url) === 'https://auth.notion.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://auth.notion.example/authorize',
          token_endpoint: 'https://auth.notion.example/token',
          registration_endpoint: 'https://auth.notion.example/register',
        });
      }
      if (String(url) === 'https://auth.notion.example/register') {
        return jsonResponse({ client_id: 'client-1', client_secret: 'secret-1' });
      }
      if (String(url) === 'https://account.example/api/connectors/oauth/dcr-exchange') {
        return jsonResponse({ code: 0, oauth_code: 'provider-code', oauth_state: openedState });
      }
      if (String(url) === 'https://auth.notion.example/token') {
        const body = new URLSearchParams(String(init?.body || ''));
        expect(body.get('code')).toBe('provider-code');
        expect(body.get('client_id')).toBe('client-1');
        return jsonResponse({
          access_token: 'access-local',
          refresh_token: 'refresh-local',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read write',
        });
      }
      if (String(url) === 'https://account.example/api/connectors/oauth/dcr-store') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.provider).toBe('notion');
        expect(body.refresh_token).toBe('refresh-local');
        expect(body.dcr_client.client_id).toBe('client-1');
        expect(body.dcr_client.client_secret).toBe('secret-1');
        expect((init?.headers as Record<string, string>).user_id).toBe('uid-1');
        return jsonResponse({
          code: 0,
          access_token: 'access-server',
          refresh_token: null,
          grant_id: 'grant-1',
          server_managed: true,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read write',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    const pending = startMcpDcrOAuth('uid-1', notionEntry());
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });
    openedState = new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('state') || '';

    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=exchange-1');
    const result = await pending;

    expect(result.grant).toMatchObject({
      access_token: 'access-server',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      scopes: ['read', 'write'],
    });
  });

  it('refreshes stale DCR grants with resource and persists rotated refresh_token fields', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh');
      expect(body.get('client_id')).toBe('client-1');
      expect(body.get('client_secret')).toBe('secret-1');
      expect(body.get('resource')).toBe('https://mcp.notion.example/mcp');
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read write',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { refreshDcrIfStale } = await import('../../../../src/main/features/connectors/oauth-dcr');
    const next = await refreshDcrIfStale({
      client_id: 'client-1',
      client_secret: 'secret-1',
      authorization_endpoint: 'https://auth.notion.example/authorize',
      token_endpoint: 'https://auth.notion.example/token',
      registration_endpoint: 'https://auth.notion.example/register',
      resource: 'https://mcp.notion.example/mcp',
    }, {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: Date.now() - 1,
      scopes: ['old'],
      token_type: 'Bearer',
      account_label: 'workspace',
    });

    expect(next).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      scopes: ['read', 'write'],
      token_type: 'Bearer',
      account_label: 'workspace',
    });
    expect(next.expires_at).toBeGreaterThan(Date.now());
  });

  it('retries and refreshes server-managed DCR grants by grant_id', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        throw new TypeError('fetch failed');
      }
      expect(String(url)).toBe('https://account.example/api/connectors/oauth/refresh');
      const body = JSON.parse(String(init.body));
      expect(body.provider).toBe('notion');
      expect(body.grant_id).toBe('grant-1');
      expect(body.refresh_token).toBeUndefined();
      return jsonResponse({
        code: 0,
        access_token: 'new-access',
        refresh_token: null,
        grant_id: 'grant-1',
        server_managed: true,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read write',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { refreshDcrServerManaged } = await import('../../../../src/main/features/connectors/oauth-dcr');
    const next = await refreshDcrServerManaged('notion', {
      access_token: 'old-access',
      refresh_token: null,
      server_grant_id: 'grant-1',
      server_managed: true,
      expires_at: Date.now() - 1,
      scopes: ['old'],
      token_type: 'Bearer',
    });

    expect(next).toMatchObject({
      access_token: 'new-access',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      scopes: ['read', 'write'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
