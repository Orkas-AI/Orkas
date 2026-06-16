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
  vi.doMock('../../../../src/main/features/account/server', () => ({
    accountApiBase: () => 'https://api.test',
  }));
  vi.doMock('../../../../src/main/features/account/token_store', () => ({
    getDeviceId: () => 'device-1',
    authHeaders: () => ({}),
  }));
  vi.doMock('../../../../src/main/features/config', () => ({
    getLanguage: () => 'en',
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('electron');
  vi.doUnmock('../../../../src/main/features/account/server');
  vi.doUnmock('../../../../src/main/features/account/token_store');
  vi.doUnmock('../../../../src/main/features/config');
});

describe('features/connectors/oauth', () => {
  it('rejects a Google connector grant when the user unchecked a required scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        provider: 'google',
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
    const entry = catalog.findCatalogEntry('gmail');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).rejects.toMatchObject({
      message: 'missing_required_scopes',
      code: 'missing_required_scopes',
    });
  });

  it('resolves a Google connector grant when all required scopes are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        provider: 'google',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
        account_label: 'user@example.com',
      }),
    })));

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const entry = catalog.findCatalogEntry('gmail');
    expect(entry).toBeTruthy();

    const pending = oauth.startOAuth('u1', entry!);
    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-1');

    await expect(pending).resolves.toMatchObject({
      access_token: 'access-1',
      scopes: expect.arrayContaining(['https://www.googleapis.com/auth/gmail.modify']),
    });
  });

  it('opens the Google Sheets picker and resolves picked file ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        provider: 'google',
        access_token: 'access-2',
        refresh_token: null,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.file',
        picked_file_ids: 'sheet-1,sheet-2',
      }),
    })));

    const oauth = await import('../../../../src/main/features/connectors/oauth');
    const { shell } = await import('electron');
    const pending = oauth.startGoogleSheetsPicker(['sheet-1']);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    const opened = new URL((shell.openExternal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(opened.pathname).toBe('/connectors/oauth/google/picker/start');
    expect(opened.searchParams.get('catalog_id')).toBe('gsheets');
    expect(opened.searchParams.get('file_ids')).toBe('sheet-1');

    await oauth.handleCallbackUrl('orkas://connectors/oauth/callback?exchange_code=exchange-2');

    await expect(pending).resolves.toMatchObject({
      pickedFileIds: ['sheet-1', 'sheet-2'],
      grant: {
        access_token: 'access-2',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
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
