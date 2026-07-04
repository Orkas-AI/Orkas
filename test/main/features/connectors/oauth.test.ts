import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockElectron() {
  vi.doMock('electron', () => ({
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

});
