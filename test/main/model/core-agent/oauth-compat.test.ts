import { describe, expect, it, vi } from 'vitest';
import {
  getOAuthProvider,
  getOAuthProviders,
  refreshOAuthProviderWithTimeout,
  registerOAuthProvider,
  unregisterOAuthProvider,
} from '../../../../src/core-agent/src/auth/oauth-compat';

describe('pi-ai OAuth compatibility bridge', () => {
  it('exposes provider-owned OAuth flows from the installed pi-ai runtime', async () => {
    const providers = await getOAuthProviders();
    expect(providers.map((provider) => provider.id)).toEqual(expect.arrayContaining([
      'anthropic',
      'github-copilot',
      'openai-codex',
    ]));

    const codex = await getOAuthProvider('openai-codex');
    expect(codex).toMatchObject({
      id: 'openai-codex',
      usesCallbackServer: true,
    });
    expect(typeof codex?.login).toBe('function');
    expect(typeof codex?.refreshToken).toBe('function');
    expect(codex?.getApiKey({ access: 'token', refresh: 'refresh', expires: 1 })).toBe('token');
  });

  it('keeps Orkas custom OAuth providers in the same lookup path', async () => {
    const custom = {
      id: 'test-oauth-provider',
      name: 'Test OAuth',
      async login() {
        return { access: 'a', refresh: 'r', expires: 1 };
      },
      async refreshToken(credentials: { access: string; refresh: string; expires: number }) {
        return credentials;
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    registerOAuthProvider(custom);
    try {
      expect(await getOAuthProvider(custom.id)).toBe(custom);
    } finally {
      unregisterOAuthProvider(custom.id);
    }
  });

  it('aborts a provider refresh at the shared 60-second OAuth boundary', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const provider = {
        id: 'timeout-oauth-provider',
        name: 'Timeout OAuth',
        async login() {
          return { access: 'a', refresh: 'r', expires: 1 };
        },
        refreshToken(
          _credentials: { access: string; refresh: string; expires: number },
          signal?: AbortSignal,
        ): Promise<{ access: string; refresh: string; expires: number }> {
          observedSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        getApiKey(credentials: { access: string }) {
          return credentials.access;
        },
      };

      const refreshing = refreshOAuthProviderWithTimeout(provider, {
        access: 'stale-access',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      });
      const rejected = expect(refreshing).rejects.toMatchObject({
        code: 'OAUTH_REFRESH_TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['before-call', 'before-dispatch'])('does not start a legacy provider refresh cancelled %s', async (when) => {
    const credentials = { access: 'stale-fixture', refresh: 'refresh-fixture', expires: 1 };
    const refreshToken = vi.fn(async () => credentials);
    const provider = {
      id: 'cancel-oauth-provider', name: 'Cancel OAuth',
      login: async () => credentials, refreshToken,
      getApiKey: () => credentials.access,
    };
    const controller = new AbortController();
    const reason = new Error('cancelled fixture');
    if (when === 'before-call') controller.abort(reason);
    const pending = refreshOAuthProviderWithTimeout(provider, credentials, { signal: controller.signal });
    if (when === 'before-dispatch') controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(refreshToken).not.toHaveBeenCalled();
  });
});
