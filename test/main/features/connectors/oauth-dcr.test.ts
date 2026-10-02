import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));
const oauthEventMock = vi.hoisted(() => ({
  progress: vi.fn(),
}));
const localeMock = vi.hoisted(() => ({ lang: 'en' }));
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.5.1',
    getAppPath: () => process.cwd(),
  },
  shell: { openExternal: electronMock.openExternal },
}));

vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({
  accountApiBase: () => 'https://account.example/api',
  tokenStore: {
    getDeviceId: () => 'device-1',
    authHeaders: () => ({ user_id: 'uid-1', session_id: 'sid-1' }),
  },
}));

vi.mock('../../../../src/main/features/config', () => ({
  getLanguage: () => localeMock.lang,
}));

vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({
  broadcastOAuthConnectProgress: oauthEventMock.progress,
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => loggerMock,
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

function atlassianEntry() {
  return {
    id: 'atlassian',
    display_name: 'Atlassian',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.atlassian.example/v1/mcp/authv2',
      oauth_header_key: 'Authorization',
    },
  } as any;
}

function airtableEntry() {
  return {
    id: 'airtable',
    display_name: 'Airtable',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.airtable.example/mcp',
      oauth_header_key: 'Authorization',
    },
  } as any;
}

function stripeEntry() {
  return {
    id: 'stripe',
    display_name: 'Stripe',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.stripe.example',
      oauth_header_key: 'Authorization',
    },
  } as any;
}

function netSuiteEntry(accountId = 'TENANTSECRET123') {
  return {
    id: 'netsuite',
    display_name: 'Oracle NetSuite',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: `https://${accountId.toLowerCase()}.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools`,
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
  localeMock.lang = 'en';
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('features/connectors/oauth-dcr', () => {
  it('authorizes a custom MCP server with PKCE and keeps its rotating grant local', async () => {
    const fetchMock = vi.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw);
      if (url.pathname.includes('oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['https://login.example.com'], resource: 'https://mcp.example.com/mcp',
      });
      if (url.pathname.includes('oauth-authorization-server')) return jsonResponse({
        issuer: 'https://login.example.com',
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
        registration_endpoint: 'https://login.example.com/register',
      });
      if (url.pathname === '/register') return jsonResponse({ client_id: 'dynamic-client' });
      if (url.pathname.endsWith('/dcr-exchange')) return jsonResponse({ code: 0, oauth_code: 'auth-code',
        oauth_state: new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('state') });
      if (url.pathname === '/token') {
        expect(String(init?.body)).toContain('code_verifier=');
        return jsonResponse({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
      }
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const flow = oauth.startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp');
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    expect(opened.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=receipt');
    await expect(flow).resolves.toMatchObject({ grant: { access_token: 'private-access', refresh_token: 'private-refresh' },
      client: { client_id: 'dynamic-client' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/dcr-store'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/dcr-exchange'))
      .every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it('rejects a custom OAuth authorization server that advertises an insecure URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      if (String(raw).includes('oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['http://private.example'], resource: 'https://mcp.example.com/mcp',
      });
      throw new Error('Authorization-server discovery must not be called');
    }));
    const { startCustomMcpOAuth } = await import('../../../../src/main/features/connectors/oauth-dcr');
    await expect(startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp'))
      .rejects.toThrow('insecure endpoint');
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it('discovers custom OAuth through a 401 resource challenge and path-based OIDC issuer', async () => {
    const fetchMock = vi.fn(async (raw: string, init?: RequestInit) => {
      const url = String(raw);
      if (url.includes('oauth-protected-resource')) return jsonResponse({}, false, 404);
      if (url === 'https://mcp.example.com/mcp') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body)).method).toBe('initialize');
        return new Response(null, { status: 401, headers: {
          'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/auth/resource-metadata"',
        } });
      }
      if (url === 'https://mcp.example.com/auth/resource-metadata') return jsonResponse({
        resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://login.example.com/tenant'],
      });
      if (url === 'https://login.example.com/.well-known/oauth-authorization-server') return jsonResponse({
        authorization_endpoint: 'https://login.example.com/wrong-tenant',
        token_endpoint: 'https://login.example.com/wrong-token',
      });
      if (url.includes('oauth-authorization-server') || url === 'https://login.example.com/.well-known/openid-configuration/tenant') {
        if (url.includes('oauth-authorization-server')) return jsonResponse({}, false, 404);
        return jsonResponse({
          issuer: 'https://login.example.com/tenant',
          authorization_endpoint: 'https://login.example.com/authorize',
          token_endpoint: 'https://login.example.com/token',
          registration_endpoint: 'https://login.example.com/register',
        });
      }
      if (url === 'https://login.example.com/register') return jsonResponse({ client_id: 'client-1' });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const pending = oauth.startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp');
    const outcome = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    expect(new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('resource'))
      .toBe('https://mcp.example.com/mcp');
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=cancelled');
    await outcome;
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'https://login.example.com/.well-known/openid-configuration/tenant'))
      .toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'https://login.example.com/.well-known/oauth-authorization-server'))
      .toBe(false);
  });

  it('rejects root metadata for a different tenant when custom issuer discovery falls back', async () => {
    const fetchMock = vi.fn(async (raw: string) => {
      const url = String(raw);
      if (url.includes('oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['https://login.example.com/tenant'],
        resource: 'https://mcp.example.com/mcp',
      });
      if (url === 'https://login.example.com/.well-known/oauth-authorization-server') return jsonResponse({
        issuer: 'https://login.example.com',
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
        registration_endpoint: 'https://login.example.com/register',
      });
      return jsonResponse({}, false, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { startCustomMcpOAuth } = await import('../../../../src/main/features/connectors/oauth-dcr');
    await expect(startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp'))
      .rejects.toThrow('issuer mismatch');
    expect(electronMock.openExternal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'https://login.example.com/register'))
      .toBe(false);
  });

  it('rejects a challenge pointing at an insecure resource-metadata URL before fetching it', async () => {
    const fetchMock = vi.fn(async (raw: string) => {
      if (String(raw).includes('oauth-protected-resource')) return jsonResponse({}, false, 404);
      if (String(raw) === 'https://mcp.example.com/mcp') return new Response(null, { status: 401, headers: {
        'WWW-Authenticate': 'Bearer resource_metadata="http://other.example/private"',
      } });
      throw new Error('untrusted metadata URL must not be fetched');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { startCustomMcpOAuth } = await import('../../../../src/main/features/connectors/oauth-dcr');
    await expect(startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp'))
      .rejects.toThrow('insecure endpoint');
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it('prefers CIMD when advertised and rejects an issuer mismatch before token exchange', async () => {
    const fetchMock = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.includes('oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['https://login.example.com'], resource: 'https://mcp.example.com/mcp',
      });
      if (url.pathname.includes('oauth-authorization-server')) return jsonResponse({
        issuer: 'https://login.example.com', authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
      });
      if (url.pathname.endsWith('/dcr-exchange')) return jsonResponse({ code: 0, oauth_code: 'auth-code',
        oauth_state: new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('state'),
        oauth_issuer: 'https://other.example.com' });
      throw new Error('CIMD must not register or exchange a mismatched issuer');
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const flow = oauth.startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp');
    const outcome = expect(flow).rejects.toThrow('issuer mismatch');
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.searchParams.get('client_id')).toBe('https://account.example/api/connectors/oauth/client-metadata');
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=receipt');
    await outcome;
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/register'))).toBe(false);
  });

  it('completes a CIMD authorization without dynamic registration', async () => {
    const fetchMock = vi.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw);
      if (url.pathname.includes('oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['https://login.example.com'], resource: 'https://mcp.example.com/mcp',
      });
      if (url.pathname.includes('oauth-authorization-server')) return jsonResponse({
        issuer: 'https://login.example.com', authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
      });
      if (url.pathname.endsWith('/dcr-exchange')) return jsonResponse({ code: 0, oauth_code: 'auth-code',
        oauth_state: new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('state'),
        oauth_issuer: 'https://login.example.com' });
      if (url.pathname === '/token') {
        expect(new URLSearchParams(String(init?.body)).get('client_id'))
          .toBe('https://account.example/api/connectors/oauth/client-metadata');
        return jsonResponse({ access_token: 'cimd-access', refresh_token: 'cimd-refresh', expires_in: 3600 });
      }
      throw new Error('CIMD must not register a dynamic client');
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const flow = oauth.startCustomMcpOAuth('custom-example', 'https://mcp.example.com/mcp');
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=receipt');
    await expect(flow).resolves.toMatchObject({ grant: { access_token: 'cimd-access', refresh_token: 'cimd-refresh' },
      client: { client_id: 'https://account.example/api/connectors/oauth/client-metadata', token_endpoint_auth_method: 'none' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/register'))).toBe(false);
  });

  it.each(['complete', 'omitted', 'reduced'])('Color Me Shop requests pinned scopes and handles a %s grant before storage', async mode => {
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const entry = findCatalogEntry('colorme-shop')!;
    const scope = entry.required_oauth_scopes!.join(' ');
    const fetchMock = vi.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw);
      if (url.pathname.includes('oauth-protected-resource')) return jsonResponse({ authorization_servers: ['https://agent.colorme.app'], resource: 'https://agent.colorme.app/api/mcp' });
      if (url.pathname.includes('oauth-authorization-server')) return jsonResponse({ authorization_endpoint: 'https://agent.colorme.app/api/auth/oauth2/authorize', token_endpoint: 'https://agent.colorme.app/api/auth/oauth2/token', registration_endpoint: 'https://agent.colorme.app/api/auth/oauth2/register', token_endpoint_auth_methods_supported: ['client_secret_post'] });
      if (url.pathname.endsWith('/register')) return jsonResponse({ client_id: 'fixture-client', client_secret: 'fixture-secret' });
      if (url.pathname.endsWith('/dcr-exchange')) return jsonResponse({ code: 0, oauth_code: 'one-use-code', oauth_state: new URL(String(electronMock.openExternal.mock.calls.at(-1)![0])).searchParams.get('state') });
      if (url.pathname.endsWith('/token')) return jsonResponse({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 3600,
        ...(mode !== 'omitted' ? { scope: mode === 'complete' ? scope : 'openid read_products' } : {}) });
      if (url.pathname.endsWith('/dcr-store')) {
        expect(JSON.parse(init?.body as string)).toMatchObject({ provider: 'colorme-shop', scope,
          dcr_client: { token_endpoint: 'https://agent.colorme.app/api/auth/oauth2/token', resource: 'https://agent.colorme.app/api/mcp' } });
        return jsonResponse({ code: 0, access_token: 'fixture-token', grant_id: 'fixture-grant', server_managed: true, expires_in: 3600 });
      }
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const flow = oauth.startMcpDcrOAuth('uid-1', entry);
    const outcome = mode === 'reduced' ? expect(flow).rejects.toMatchObject({ code: 'missing_required_scopes' })
      : expect(flow).resolves.toMatchObject({ grant: { scopes: entry.required_oauth_scopes } });
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    const auth = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(auth.searchParams.get('scope')).toBe(scope);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('resource')).toBe('https://agent.colorme.app/api/mcp');
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=receipt');
    await outcome;
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/dcr-store'))).toHaveLength(0);
  });

  it.each(['zh', 'en', 'ja', 'pt'])('carries %s in fresh opaque states without changing registered callback URLs', async (lang) => {
    localeMock.lang = lang;
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const states: string[] = [];
    const local = oauth.startLocalApiBrowserOAuth('shopee', (state, redirect) => {
      states.push(state);
      expect(redirect).toBe('https://orkas.ai/api/connectors/oauth/dcr-callback');
      return `https://open.shopee.com/auth?state=${state}`;
    }, vi.fn());
    const cancelledLocal = expect(local).rejects.toMatchObject({ code: 'user_cancelled' });
    oauth.cancelDcrOAuth();
    await cancelledLocal;
    electronMock.openExternal.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.includes('oauth-protected-resource')) return jsonResponse({ authorization_servers: ['https://auth.notion.example'], resource: 'https://mcp.notion.example/mcp' });
      if (url.pathname.includes('oauth-authorization-server')) return jsonResponse({ authorization_endpoint: 'https://auth.notion.example/authorize', token_endpoint: 'https://auth.notion.example/token', registration_endpoint: 'https://auth.notion.example/register' });
      if (url.pathname === '/register') return jsonResponse({ client_id: 'client-1' });
      throw new Error('unexpected request');
    }));
    const dcr = oauth.startMcpDcrOAuth('uid-1', notionEntry());
    const cancelledDcr = expect(dcr).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    const url = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    states.push(url.searchParams.get('state')!);
    expect(url.searchParams.get('redirect_uri')).toBe('https://account.example/api/connectors/oauth/dcr-callback');
    expect(url.searchParams.has('lang')).toBe(false);
    expect(states[0]).not.toBe(states[1]);
    for (const state of states) expect(state).toMatch(new RegExp(`^orkas1_${lang}_[A-Za-z0-9_-]{43}$`));
    oauth.cancelDcrOAuth();
    await cancelledDcr;
  });

  it.each([true, false])('does not let a cancelled DCR token response (success=%s) replace a new seller flow', async (success) => {
    let finishToken!: (response: ReturnType<typeof jsonResponse>) => void;
    const delayedToken = new Promise<ReturnType<typeof jsonResponse>>((resolve) => { finishToken = resolve; });
    const fetchMock = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/.well-known/oauth-protected-resource')) return jsonResponse({
        authorization_servers: ['https://auth.notion.example'], resource: 'https://mcp.notion.example/mcp',
      });
      if (url.pathname.endsWith('/.well-known/oauth-authorization-server')) return jsonResponse({
        authorization_endpoint: 'https://auth.notion.example/authorize',
        token_endpoint: 'https://auth.notion.example/token', registration_endpoint: 'https://auth.notion.example/register',
      });
      if (url.pathname === '/register') return jsonResponse({ client_id: 'client-1', client_secret: 'secret-1' });
      if (url.pathname.endsWith('/dcr-exchange')) return jsonResponse({ code: 0, oauth_code: 'one-use-code',
        oauth_state: new URL(String(electronMock.openExternal.mock.calls.at(-1)![0])).searchParams.get('state') });
      if (url.pathname === '/token') return delayedToken;
      throw new Error('Unexpected request after cancellation');
    });
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth-dcr');
    const oldFlow = oauth.startMcpDcrOAuth('uid-1', notionEntry());
    const cancelled = expect(oldFlow).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    const oldCallback = oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=old');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/token'))).toBe(true));
    const sellerExchange = vi.fn(async () => ({ access_token: 'seller-grant' }));
    const next = oauth.startLocalApiBrowserOAuth('shopee', (state) => `https://open.shopee.com/auth?state=${state}`, sellerExchange);
    await cancelled;
    finishToken(jsonResponse({ access_token: 'old-grant', refresh_token: 'old-refresh' }, success, success ? 200 : 400));
    await oldCallback;
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/dcr-store'))).toBe(false);
    await oauth.handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=new');
    await expect(next).resolves.toEqual({ access_token: 'seller-grant' });
    expect(sellerExchange).toHaveBeenCalledTimes(1);
  });

  it('keeps account-scoped endpoints and provider response bodies out of diagnostics', async () => {
    const accountSentinel = 'tenantsecret123';
    const providerSentinel = 'provider-secret-response';
    const discoveryFetch = vi.fn(async () => jsonResponse({ error: 'not_found' }, false, 404));
    vi.stubGlobal('fetch', discoveryFetch);

    const { startMcpDcrOAuth } = await import('../../../../src/main/features/connectors/oauth-dcr');
    let discoveryError = '';
    try {
      await startMcpDcrOAuth('uid-1', netSuiteEntry(accountSentinel));
    } catch (err) {
      discoveryError = String((err as Error).message || err);
    }
    const discoveryEvidence = JSON.stringify({
      error: discoveryError,
      info: loggerMock.info.mock.calls,
      warn: loggerMock.warn.mock.calls,
      errorLogs: loggerMock.error.mock.calls,
    }).toLowerCase();
    expect(discoveryError).toContain('HTTP 404');
    expect(discoveryEvidence).not.toContain(accountSentinel);

    vi.clearAllMocks();
    vi.resetModules();
    const tokenFetch = vi.fn(async (url: string) => {
      const rawUrl = String(url);
      if (rawUrl.endsWith('/mcp/.well-known/oauth-protected-resource')) {
        return jsonResponse({
          authorization_servers: ['https://auth.notion.example'],
          resource: 'https://mcp.notion.example/mcp',
        });
      }
      if (rawUrl === 'https://auth.notion.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://auth.notion.example/authorize',
          token_endpoint: 'https://auth.notion.example/token',
          registration_endpoint: 'https://auth.notion.example/register',
        });
      }
      if (rawUrl === 'https://auth.notion.example/register') {
        return jsonResponse({ client_id: 'client-1', client_secret: 'secret-1' });
      }
      if (rawUrl === 'https://account.example/api/connectors/oauth/dcr-exchange') {
        const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
        return jsonResponse({
          code: 0,
          oauth_code: 'provider-code',
          oauth_state: opened.searchParams.get('state'),
        });
      }
      if (rawUrl === 'https://auth.notion.example/token') {
        return jsonResponse({ error: 'invalid_grant', detail: providerSentinel }, false, 400);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', tokenFetch);
    const oauthDcr = await import('../../../../src/main/features/connectors/oauth-dcr');
    const pending = oauthDcr.startMcpDcrOAuth('uid-1', notionEntry());
    await vi.waitFor(() => expect(electronMock.openExternal).toHaveBeenCalledTimes(1));
    await oauthDcr.handleDcrCallbackUrl(
      'orkas://connectors/oauth/dcr-callback?exchange_code=exchange-1',
    );
    let tokenError = '';
    try {
      await pending;
    } catch (err) {
      tokenError = String((err as Error).message || err);
    }
    expect(tokenError).toContain('token exchange failed');
    const tokenEvidence = JSON.stringify({
      error: tokenError,
      info: loggerMock.info.mock.calls,
      warn: loggerMock.warn.mock.calls,
      errorLogs: loggerMock.error.mock.calls,
    });
    expect(tokenEvidence).not.toContain(providerSentinel);
  });

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

  it('discovers providers that publish path-based protected-resource and auth-server metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl === 'https://mcp.atlassian.example/v1/mcp/authv2/.well-known/oauth-protected-resource') {
        return jsonResponse({ error: 'not_found' }, false, 404);
      }
      if (rawUrl === 'https://mcp.atlassian.example/.well-known/oauth-protected-resource/v1/mcp/authv2') {
        return jsonResponse({
          authorization_servers: ['https://auth.atlassian.example/as-1'],
          resource: 'https://mcp.atlassian.example/v1/mcp/authv2',
        });
      }
      if (rawUrl === 'https://auth.atlassian.example/as-1/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://auth.atlassian.example/authorize',
          token_endpoint: 'https://auth.atlassian.example/oauth/token',
          registration_endpoint: 'https://auth.atlassian.example/as-1/dcr/register',
        });
      }
      if (rawUrl === 'https://auth.atlassian.example/as-1/dcr/register') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.redirect_uris).toEqual(['https://account.example/api/connectors/oauth/dcr-callback']);
        expect(body.token_endpoint_auth_method).toBe('client_secret_post');
        return jsonResponse({ client_id: 'atl-client-1', client_secret: 'atl-secret-1' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    void startMcpDcrOAuth('uid-1', atlassianEntry()).catch(() => {});
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });

    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.href.startsWith('https://auth.atlassian.example/authorize?')).toBe(true);
    expect(opened.searchParams.get('client_id')).toBe('atl-client-1');
    expect(opened.searchParams.get('resource')).toBe('https://mcp.atlassian.example/v1/mcp/authv2');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'https://auth.atlassian.example/.well-known/oauth-authorization-server')).toBe(false);
    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=cancelled');
  });

  it('falls back to MCP-host authorization metadata when the advertised auth-server host omits it', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl === 'https://mcp.stripe.example/.well-known/oauth-protected-resource') {
        return jsonResponse({
          authorization_servers: ['https://access.stripe.example/mcp'],
          resource: 'https://mcp.stripe.example',
        });
      }
      if (rawUrl === 'https://access.stripe.example/mcp/.well-known/oauth-authorization-server'
        || rawUrl === 'https://access.stripe.example/.well-known/oauth-authorization-server') {
        return jsonResponse({ error: 'not_found' }, false, 404);
      }
      if (rawUrl === 'https://mcp.stripe.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          issuer: 'https://access.stripe.example/mcp',
          authorization_endpoint: 'https://access.stripe.example/mcp/oauth2/authorize',
          token_endpoint: 'https://access.stripe.example/mcp/oauth2/token',
          registration_endpoint: 'https://access.stripe.example/mcp/oauth2/register',
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (rawUrl === 'https://access.stripe.example/mcp/oauth2/register') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.token_endpoint_auth_method).toBe('none');
        return jsonResponse({ client_id: 'stripe-client-1' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    void startMcpDcrOAuth('uid-1', stripeEntry()).catch(() => {});
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });

    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.href.startsWith('https://access.stripe.example/mcp/oauth2/authorize?')).toBe(true);
    expect(opened.searchParams.get('client_id')).toBe('stripe-client-1');
    expect(opened.searchParams.get('resource')).toBe('https://mcp.stripe.example');
    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=cancelled');
  });

  it('uses client_secret_basic when the provider does not support client_secret_post', async () => {
    let openedState = '';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl === 'https://mcp.airtable.example/mcp/.well-known/oauth-protected-resource') {
        return jsonResponse({ error: 'not_found' }, false, 404);
      }
      if (rawUrl === 'https://mcp.airtable.example/.well-known/oauth-protected-resource/mcp') {
        return jsonResponse({
          authorization_servers: ['https://airtable.example/oauth2/v1'],
          resource: 'https://mcp.airtable.example',
        });
      }
      if (rawUrl === 'https://airtable.example/oauth2/v1/.well-known/oauth-authorization-server') {
        return jsonResponse({ error: 'not_found' }, false, 404);
      }
      if (rawUrl === 'https://airtable.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://airtable.example/oauth2/v1/authorize',
          token_endpoint: 'https://airtable.example/oauth2/v1/token',
          registration_endpoint: 'https://airtable.example/oauth2/v1/register',
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
        });
      }
      if (rawUrl === 'https://airtable.example/oauth2/v1/register') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
        return jsonResponse({
          client_id: 'airtable-client-1',
          client_secret: 'airtable-secret-1',
          token_endpoint_auth_method: 'client_secret_basic',
        });
      }
      if (rawUrl === 'https://account.example/api/connectors/oauth/dcr-exchange') {
        return jsonResponse({ code: 0, oauth_code: 'provider-code', oauth_state: openedState });
      }
      if (rawUrl === 'https://airtable.example/oauth2/v1/token') {
        const headers = init?.headers as Record<string, string>;
        const body = new URLSearchParams(String(init?.body || ''));
        expect(headers.Authorization).toBe(`Basic ${Buffer.from('airtable-client-1:airtable-secret-1').toString('base64')}`);
        expect(body.get('client_id')).toBeNull();
        expect(body.get('client_secret')).toBeNull();
        expect(body.get('resource')).toBe('https://mcp.airtable.example');
        return jsonResponse({
          access_token: 'airtable-access-local',
          refresh_token: 'airtable-refresh-local',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'data.records:read',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    const pending = startMcpDcrOAuth('uid-1', airtableEntry(), { attemptId: 'attempt-dcr-return' });
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });
    openedState = new URL(String(electronMock.openExternal.mock.calls[0][0])).searchParams.get('state') || '';

    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=exchange-1');
    const result = await pending;
    expect(result.grant).toMatchObject({
      access_token: 'airtable-access-local',
      refresh_token: 'airtable-refresh-local',
      scopes: ['data.records:read'],
    });
    expect(result.client).toMatchObject({
      client_id: 'airtable-client-1',
      client_secret: 'airtable-secret-1',
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/dcr-store'))).toBe(false);
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

  it('keeps a completed DCR grant and client credentials local', async () => {
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
      access_token: 'access-local',
      refresh_token: 'refresh-local',
      scopes: ['read', 'write'],
    });
    expect(result.client).toMatchObject({ client_id: 'client-1', client_secret: 'secret-1' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/dcr-store'))).toBe(false);
  });

  it('uses the first resource when protected-resource metadata returns a resource array', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/v4/mcp/.well-known/oauth-protected-resource')) {
        return jsonResponse({ error: 'not_found' }, false, 404);
      }
      if (String(url) === 'https://gitlab.example/.well-known/oauth-protected-resource/api/v4/mcp') {
        return jsonResponse({
          authorization_servers: ['https://gitlab.example'],
          resource: ['https://gitlab.example/api/v4/mcp'],
        });
      }
      if (String(url) === 'https://gitlab.example/.well-known/oauth-authorization-server') {
        return jsonResponse({
          authorization_endpoint: 'https://gitlab.example/oauth/authorize',
          token_endpoint: 'https://gitlab.example/oauth/token',
          registration_endpoint: 'https://gitlab.example/oauth/register',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (String(url) === 'https://gitlab.example/oauth/register') {
        return jsonResponse({ client_id: 'gitlab-client-1', client_secret: 'gitlab-secret-1' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { startMcpDcrOAuth, handleDcrCallbackUrl } = await import('../../../../src/main/features/connectors/oauth-dcr');
    void startMcpDcrOAuth('uid-1', {
      id: 'gitlab',
      display_name: 'GitLab',
      auth_mode: 'mcp_dcr',
      transport_template: {
        kind: 'streamable-http',
        url: 'https://gitlab.example/api/v4/mcp',
        oauth_header_key: 'Authorization',
      },
    } as any).catch(() => {});
    await vi.waitFor(() => {
      expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    });

    const opened = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(opened.searchParams.get('resource')).toBe('https://gitlab.example/api/v4/mcp');
    await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=cancelled');
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

  it('force refreshes a still-unexpired local DCR grant directly at the provider', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://auth.notion.example/token');
      const body = new URLSearchParams(String(init.body));
      expect(body.get('refresh_token')).toBe('old-refresh');
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
    }, {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: Date.now() + 60 * 60 * 1000,
      scopes: ['old'],
      token_type: 'Bearer',
    }, { force: true });

    expect(next).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      scopes: ['read', 'write'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
