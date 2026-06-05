import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electronMock = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: electronMock.openExternal },
}));

vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({
  accountApiBase: () => 'http://account.example/api',
  tokenStore: {
    getDeviceId: () => 'dev-1',
    authHeaders: () => ({}),
  },
}));

vi.mock('../../../../src/main/features/config', () => ({
  getLanguage: () => 'zh',
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevApi: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-github-oauth-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevApi = process.env.ORKAS_API_BASE_URL;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_API_BASE_URL = 'http://account.example/api';
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  process.env.ORKAS_API_BASE_URL = prevApi;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function githubEntry() {
  return {
    id: 'github',
    display_name: 'GitHub',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'github' },
    transport_template: null,
  } as any;
}

describe('connector OAuth GitHub server-managed grants', () => {
  it('can open a normal install URL when explicitly requested', async () => {
    const { startOAuth, cancelInFlightOAuth } = await import('../../../../src/main/features/connectors/oauth');

    void startOAuth('uid-1', githubEntry()).catch(() => {});
    await Promise.resolve();
    cancelInFlightOAuth();

    expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    const url = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/connectors/oauth/github/start');
    expect(url.searchParams.get('catalog_id')).toBe('github');
    expect(url.searchParams.get('mode')).toBeNull();
  });

  it('passes reauthorize mode when repairing an existing GitHub installation', async () => {
    const { startOAuth, cancelInFlightOAuth } = await import('../../../../src/main/features/connectors/oauth');

    void startOAuth('uid-1', githubEntry(), { reauthorize: true }).catch(() => {});
    await Promise.resolve();
    cancelInFlightOAuth();

    expect(electronMock.openExternal).toHaveBeenCalledTimes(1);
    const url = new URL(String(electronMock.openExternal.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/connectors/oauth/github/start');
    expect(url.searchParams.get('catalog_id')).toBe('github');
    expect(url.searchParams.get('mode')).toBe('reauthorize');
  });

  it('adopts a legacy GitHub refresh token into a server grant', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        code: 0,
        access_token: 'ghu-new',
        refresh_token: null,
        grant_id: 'grant-1',
        server_managed: true,
        expires_in: 28800,
        token_type: 'Bearer',
        scope: 'repo',
        account_label: 'octo',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshIfStale } = await import('../../../../src/main/features/connectors/oauth');
    const next = await refreshIfStale('uid-1', githubEntry(), {
      access_token: 'ghu-old',
      refresh_token: 'ghr-old',
      expires_at: Date.now() + 60 * 60 * 1000,
      scopes: ['repo'],
      token_type: 'Bearer',
      account_label: 'octo',
    });

    expect(next.refresh_token).toBeNull();
    expect(next.server_managed).toBe(true);
    expect(next.server_grant_id).toBe('grant-1');
    expect(next.access_token).toBe('ghu-new');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.provider).toBe('github');
    expect(body.refresh_token).toBe('ghr-old');
    expect(body.access_token).toBe('ghu-old');
    expect(body.grant_id).toBeUndefined();
    expect((init.headers as Record<string, string>).user_id).toBeUndefined();
  });

  it('does not call the server when an existing server-managed GitHub token is fresh', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const grant = {
      access_token: 'ghu-fresh',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
      scopes: [],
      token_type: 'Bearer',
    };
    const { refreshIfStale } = await import('../../../../src/main/features/connectors/oauth');
    const next = await refreshIfStale('uid-1', githubEntry(), grant);

    expect(next).toBe(grant);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('force refreshes an existing server-managed GitHub token even when fresh', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        code: 0,
        access_token: 'ghu-forced',
        refresh_token: null,
        grant_id: 'grant-1',
        server_managed: true,
        expires_in: 28800,
        token_type: 'Bearer',
        scope: '',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshIfStale } = await import('../../../../src/main/features/connectors/oauth');
    const next = await refreshIfStale('uid-1', githubEntry(), {
      access_token: 'ghu-rejected',
      refresh_token: null,
      server_managed: true,
      server_grant_id: 'grant-1',
      expires_at: Date.now() + 60 * 60 * 1000,
      scopes: [],
      token_type: 'Bearer',
    }, { force: true });

    expect(next.access_token).toBe('ghu-forced');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.grant_id).toBe('grant-1');
    expect(body.force_refresh).toBe(true);
  });
});
