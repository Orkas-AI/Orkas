import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthProgress = vi.fn();
const logInfo = vi.fn();

function mockElectron() {
  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getVersion: () => '1.5.1',
      getAppPath: () => process.cwd(),
    },
    shell: { openExternal: vi.fn(async () => {}) },
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockElectron();
  vi.doMock('../../../../src/main/features/connectors/_server_bridge', () => ({
    accountApiBase: () => 'https://api.test',
    tokenStore: {
      getDeviceId: () => 'device-1',
      authHeaders: () => ({}),
    },
  }));
  vi.doMock('../../../../src/main/features/config', () => ({
    getLanguage: () => 'en',
  }));
  vi.doMock('../../../../src/main/features/connectors/oauth-events', () => ({
    broadcastOAuthConnectProgress: oauthProgress,
  }));
  vi.doMock('../../../../src/main/features/connectors/api-key', () => ({
    connectorApiKeyHeaders: () => ({ Authorization: 'Bearer orkas-connector-key' }),
  }));
  vi.doMock('../../../../src/main/logger', () => ({
    createLogger: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: logInfo,
      debug: vi.fn(),
    }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('electron');
  vi.doUnmock('../../../../src/main/features/connectors/_server_bridge');
  vi.doUnmock('../../../../src/main/features/config');
  vi.doUnmock('../../../../src/main/features/connectors/oauth-events');
  vi.doUnmock('../../../../src/main/features/connectors/api-key');
});

describe('features/connectors/oauth', () => {
  it('uses Bearer auth for the existing Composio start and exchange routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        redirect_url: 'https://provider.example/connect',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        connection_id: 'conn-1',
        connection_token: 'a'.repeat(43),
        toolkit: 'gmail',
        auth_config_id: 'auth-config-public-id',
        account_label: 'user@example.com',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({
      id: 'gmail',
      display_name: 'Gmail',
      auth_mode: 'composio',
      composio: { toolkit: 'gmail', auth_config_id: 'auth-config-public-id', tools: [] },
    } as any);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith('https://provider.example/connect'));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({
      connection_id: 'conn-1',
      connection_token: 'a'.repeat(43),
      toolkit: 'gmail',
      auth_config_id: 'auth-config-public-id',
      account_label: 'user@example.com',
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer orkas-connector-key' });
    }
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain('a'.repeat(43));
  });

  it.each([
    ['missing', undefined], ['empty', ''], ['short', 'a'.repeat(42)], ['long', 'a'.repeat(44)],
    ['whitespace', 'a'.repeat(42) + ' '], ['non-ASCII', 'a'.repeat(42) + '中'], ['non-string', { token: 'a'.repeat(43) }],
  ])('requires reconnect when a consumed exchange credential is %s', async (_kind, connectionToken) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, connection_id: 'legacy', toolkit: 'gmail', auth_config_id: 'ac_public', connection_token: connectionToken })));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({ id: 'gmail', auth_mode: 'composio' } as any);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'connector_reconnect_required' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalled());
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=consumed-code');
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oauth.cancelInFlightOAuth()).toBe(false);
  });

  it.each(['http_503', 'truncated_body'])('requires fresh authorization after %s without retrying the consumed exchange', async (failure) => {
    const start = () => new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' }));
    const broken = failure === 'http_503'
      ? new Response(JSON.stringify({ code: 1, msg: 'Temporarily unavailable' }), { status: 503 })
      : { ok: true, status: 200, text: async () => { throw new Error('response body interrupted'); } };
    const fetchMock = vi.fn()
      .mockImplementationOnce(start)
      .mockResolvedValueOnce(broken)
      .mockImplementationOnce(start)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, connection_id: 'replacement', connection_token: 'b'.repeat(43), toolkit: 'gmail', auth_config_id: 'ac_public',
      })));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const entry = { id: 'gmail', auth_mode: 'composio' } as any;
    const first = oauth.startComposioConnect(entry);
    const failed = expect(first).rejects.toMatchObject({ code: failure === 'http_503' ? 'exchange_http_5xx' : 'exchange_failed' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=consumed');
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oauth.cancelInFlightOAuth()).toBe(false);
    const replacement = oauth.startComposioConnect(entry);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=fresh');
    await expect(replacement).resolves.toMatchObject({ connection_id: 'replacement', connection_token: 'b'.repeat(43) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/connectors/composio/start', '/connectors/composio/exchange',
      '/connectors/composio/start', '/connectors/composio/exchange',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).exchange_code).toBe('fresh');
  });

  it('does not retry a lost credential exchange response or duplicate callback', async () => {
    let failExchange!: (error: Error) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' })))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failExchange = reject; }));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startComposioConnect({ id: 'gmail', auth_mode: 'composio' } as any);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'exchange_failed' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalled());
    const callback = oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=lost-response');
    await vi.waitFor(() => expect(failExchange).toBeTypeOf('function'));
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=lost-response');
    failExchange(new Error('response lost'));
    await callback;
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])('ignores a cancelled exchange completing with %s while reconnecting', async (outcome) => {
    let finishOld!: (value: Response) => void;
    let failOld!: (error: Error) => void;
    const startResponse = () => new Response(JSON.stringify({ code: 0, redirect_url: 'https://provider.example/connect' }));
    const grantResponse = (token: string) => new Response(JSON.stringify({
      code: 0, connection_id: 'conn-1', connection_token: token, toolkit: 'gmail', auth_config_id: 'ac_public',
    }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(startResponse)
      .mockImplementationOnce(() => new Promise<Response>((resolve, reject) => { finishOld = resolve; failOld = reject; }))
      .mockImplementationOnce(startResponse)
      .mockImplementationOnce(() => grantResponse('b'.repeat(43)));
    vi.stubGlobal('fetch', fetchMock);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const entry = { id: 'gmail', auth_mode: 'composio' } as any;
    const first = oauth.startComposioConnect(entry);
    const cancelled = expect(first).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
    const oldCallback = oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=old');
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
    expect(oauth.cancelInFlightOAuth()).toBe(true);
    await cancelled;
    const replacement = oauth.startComposioConnect(entry);
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));
    if (outcome === 'success') finishOld(grantResponse('a'.repeat(43)));
    else failOld(new Error('old response lost'));
    await oldCallback;
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=new');
    await expect(replacement).resolves.toMatchObject({ connection_token: 'b'.repeat(43) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects a server-bridge connector grant when the user unchecked a required scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        provider: 'bing',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email',
        account_label: 'user@example.com',
      }),
    })));

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).rejects.toMatchObject({
      message: 'missing_required_scopes',
      code: 'missing_required_scopes',
    });
  });

  it('resolves a server-bridge connector grant when all required scopes are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        provider: 'bing',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email webmaster.read',
        account_label: 'user@example.com',
      }),
    })));

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({
      access_token: 'access-1',
      scopes: expect.arrayContaining(['webmaster.read']),
    });
  });

  it('rejects and preserves the server reason when the callback reports a non-scope OAuth error', async () => {
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('github');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl(
      'orkas://connectors/oauth/callback?status=error&reason=github_app_not_installed',
    );

    await expect(pending).rejects.toThrow(/server error: github_app_not_installed/);
  });

  // The exchange redeems a one-time code AFTER the user already granted consent at the provider.
  // A structured session-store 503 is emitted by the auth dependency before the exchange handler
  // runs, so the code is definitely still present and the retry must recover transparently.
  it('retries the token exchange on a pre-handler session-store 503 and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 1,
        msg: '系统繁忙',
        error_code: 'session_store_unavailable',
        retryable: true,
      }), { status: 503 }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          provider: 'bing',
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email webmaster.read',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({ access_token: 'access-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces exchange_http_5xx only after exhausting retries when the server stays busy', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 1,
      msg: '系统繁忙',
      error_code: 'session_store_unavailable',
      retryable: true,
    }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).rejects.toMatchObject({ code: 'exchange_http_5xx' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a token exchange when the first network attempt does not get through', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          provider: 'bing',
          access_token: 'access-after-retry',
          refresh_token: 'refresh-after-retry',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email webmaster.read',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({ access_token: 'access-after-retry' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 4xx means the code itself was rejected (expired / device mismatch / already consumed).
  // Replaying it cannot help and would just delay the error the user needs to see.
  it('does not retry the token exchange on a 4xx', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"code":1,"msg":"oauth_code_invalid"}',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).rejects.toMatchObject({ code: 'exchange_http_4xx' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The renderer keys `result:'cancelled'` off these codes now, not off English substrings.
  it('tags a provider-side cancel as user_cancelled', async () => {
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?status=cancelled');

    await expect(pending).rejects.toMatchObject({ code: 'user_cancelled' });
  });

  it('tags a callback with no exchange_code as missing_exchange_code', async () => {
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback');

    await expect(pending).rejects.toMatchObject({ code: 'missing_exchange_code' });
  });

  it('tags a superseding connect as superseded', async () => {
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('bing-webmaster');
    expect(entry).toBeTruthy();

    const first = oauth.startOAuth('u1', entry!);
    const second = oauth.startOAuth('u1', entry!);

    await expect(first).rejects.toMatchObject({ code: 'superseded' });
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?status=cancelled');
    await expect(second).rejects.toMatchObject({ code: 'user_cancelled' });
  });

  // The two halves of the root-cause fix have to meet here: Server now sends
  // `{error_code, retryable}` on the auth layer's 503 (Server/utils/auth.py::check_login), and the
  // non-OK path must read them instead of stringifying the body into a message that downstream then
  // has to regex — in four languages — to guess intent.
  it('reads error_code/retryable off a structured 503 instead of stringifying the body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({
        code: 1,
        msg: '系统繁忙，请稍后重试',
        error_code: 'session_store_unavailable',
        retryable: true,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('gsearch-console');
    expect(entry).toBeTruthy();

    const grant = {
      access_token: 'stale',
      refresh_token: 'rt-1',
      expires_at: Date.now() - 1,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      token_type: 'Bearer',
    };

    const err = await oauth.refreshIfStale('u1', entry!, grant as never).catch((e) => e);

    // Structured verdict, carried on the Error — this is what manager.ts::_isTransientConnectorFailure
    // branches on (`retryable === true`) instead of pattern-matching a localized string.
    expect(err.code).toBe('session_store_unavailable');
    expect(err.retryable).toBe(true);
    // Status stays in the message for diagnosis + the log.
    expect(err.message).toContain('503');
  });

  it('still classifies a 5xx as retryable when the server predates the structured fields', async () => {
    // PC ships independently of Server, so a new client can talk to an old one. A bare legacy 503
    // must not silently become "not retryable" — that would turn a backend blip into a dead card.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => '{"code":1,"msg":"系统繁忙"}',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('gsearch-console');

    const grant = {
      access_token: 'stale',
      refresh_token: 'rt-1',
      expires_at: Date.now() - 1,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      token_type: 'Bearer',
    };

    const err = await oauth.refreshIfStale('u1', entry!, grant as never).catch((e) => e);
    // No structured fields to read → falls back to the legacy shape, which manager.ts still
    // classifies transient via its `refresh HTTP 5xx` regex.
    expect(err.message).toMatch(/refresh HTTP 503/);
  });
});

describe('server-managed Bing grants', () => {
  it('refreshes an expired grant by its server id without a local refresh token', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, access_token: 'new-access', grant_id: 'bing-grant', expires_in: 3600 }) }));
    vi.stubGlobal('fetch', request);
    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const result = await oauth.refreshIfStale('u1', catalog.findCatalogEntry('bing-webmaster')!, {
      access_token: 'expired', refresh_token: null, server_managed: true, server_grant_id: 'bing-grant', expires_at: 1,
      scopes: ['webmaster.read'], token_type: 'Bearer',
    });
    expect(result).toMatchObject({ access_token: 'new-access', refresh_token: null, server_grant_id: 'bing-grant' });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ provider: 'bing', grant_id: 'bing-grant', device_id: 'device-1' });
  });
});
