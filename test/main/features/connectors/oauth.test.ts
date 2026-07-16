import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('electron');
  vi.doUnmock('../../../../src/main/features/connectors/_server_bridge');
  vi.doUnmock('../../../../src/main/features/config');
});

describe('features/connectors/oauth', () => {
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
