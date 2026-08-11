import { describe, expect, it } from 'vitest';
import {
  getOAuthProvider,
  getOAuthProviders,
  registerOAuthProvider,
  unregisterOAuthProvider,
} from '../../../../src/core-agent/src/auth/oauth-compat';

describe('pi-ai OAuth compatibility bridge', () => {
  it('exposes provider-owned OAuth flows from pi-ai 0.80.10', async () => {
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
});
