/**
 * Unit coverage for the MiniMax Portal OAuth adapter.
 *
 * Scope:
 *   - PKCE bundle shape (URL-safe base64, correct SHA-256 challenge).
 *   - `resolveExpiresAt` disambiguation between TTL seconds and unix ms.
 *   - `loginMiniMaxPortal` state machine under injected fetch — covers the
 *     happy path (code → pending → success), early error, and timeout.
 *   - `refreshToken` happy path + failure path.
 *   - Provider factory: id/name/usesCallbackServer/getApiKey wiring.
 *
 * Network: all HTTP is stubbed via a `fetch` override so no external calls
 * escape the suite. A fake clock + fake sleep keeps the polling loop
 * synchronous and deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  generatePkce,
  resolveExpiresAt,
  loginMiniMaxPortal,
  buildMinimaxPortalProvider,
} from '../../../src/main/features/oauth-minimax';

// ── fetch stub helper ────────────────────────────────────────────────────

type RouteHandler = (body: URLSearchParams) => Promise<{
  status: number;
  body: unknown;
}>;

interface RouteBook {
  '/oauth/code'?: RouteHandler[];
  '/oauth/token'?: RouteHandler[];
}

function installFetch(book: RouteBook): { calls: Array<{ path: string; body: URLSearchParams }> } {
  const calls: Array<{ path: string; body: URLSearchParams }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = new URLSearchParams(bodyText);
    calls.push({ path, body });
    const queue = (book as any)[path] as RouteHandler[] | undefined;
    if (!queue || queue.length === 0) throw new Error(`unexpected route: ${path}`);
    const handler = queue.shift()!;
    const out = await handler(body);
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
      status: out.status,
      headers: { 'Content-Type': 'application/json' },
    }) as any;
  }) as any;
  // Restore on afterEach via a global pointer.
  (installFetch as any)._restore = () => { globalThis.fetch = originalFetch; };
  return { calls };
}

afterEach(() => {
  const restore = (installFetch as any)._restore as (() => void) | undefined;
  if (restore) restore();
});

// ── generatePkce ─────────────────────────────────────────────────────────

describe('oauth-minimax › generatePkce', () => {
  it('emits a URL-safe base64 verifier + SHA-256 challenge + random state', () => {
    const { verifier, challenge, state } = generatePkce();
    // RFC 7636: verifier is 43-128 chars; 32 random bytes → base64url = 43 chars.
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    // challenge = base64url(sha256(verifier)) — verify the hash matches.
    const expected = createHash('sha256').update(verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('produces different output on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

// ── resolveExpiresAt ─────────────────────────────────────────────────────

describe('oauth-minimax › resolveExpiresAt', () => {
  it('treats a small number as a TTL in seconds relative to now', () => {
    const now = 1_700_000_000_000;
    expect(resolveExpiresAt(3600, now)).toBe(now + 3600 * 1000);
  });

  it('treats a large number (post-year-2000 ms) as an absolute unix ms timestamp', () => {
    const abs = 1_900_000_000_000;
    expect(resolveExpiresAt(abs)).toBe(abs);
  });

  it('returns a safe default when the input is invalid', () => {
    const now = 1_700_000_000_000;
    expect(resolveExpiresAt(0, now)).toBe(now + 3600_000);
    expect(resolveExpiresAt(-1, now)).toBe(now + 3600_000);
    expect(resolveExpiresAt(Number.NaN, now)).toBe(now + 3600_000);
  });
});

// ── loginMiniMaxPortal state machine ─────────────────────────────────────

describe('oauth-minimax › loginMiniMaxPortal', () => {
  it('completes the happy path: authorization → pending → success', async () => {
    const expireAt = 1_700_000_000_000 + 60_000;
    const book: RouteBook = {
      '/oauth/code': [
        async (body) => {
          expect(body.get('response_type')).toBe('code');
          expect(body.get('code_challenge_method')).toBe('S256');
          expect(body.get('state')).toBeTruthy();
          return {
            status: 200,
            body: {
              user_code: 'ABCD-1234',
              verification_uri: 'https://example.com/activate',
              expired_in: expireAt,
              interval: 2000,
              state: body.get('state'),
            },
          };
        },
      ],
      '/oauth/token': [
        async () => ({ status: 200, body: { status: 'pending' } }),
        async (body) => {
          expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:user_code');
          expect(body.get('user_code')).toBe('ABCD-1234');
          return {
            status: 200,
            body: {
              status: 'success',
              access_token:  'tok-access',
              refresh_token: 'tok-refresh',
              expired_in:    3600,
              resource_url:  'https://api.minimaxi.com/anthropic',
              notification_message: '授权成功',
            },
          };
        },
      ],
    };
    const { calls } = installFetch(book);

    const authSeen: Array<{ url: string; instructions?: string }> = [];
    const nowMock = vi.fn(() => 1_700_000_000_000);
    const sleepMock = vi.fn(async () => { /* no-op */ });

    const creds = await loginMiniMaxPortal({
      region: 'cn',
      callbacks: {
        onAuth: (info) => authSeen.push(info),
        onPrompt: async () => '',
        onProgress: () => { /* noop */ },
      },
      _now: nowMock,
      _sleep: sleepMock,
    });

    expect(authSeen).toHaveLength(1);
    expect(authSeen[0].url).toBe('https://example.com/activate');
    expect(authSeen[0].instructions).toContain('ABCD-1234');

    expect(creds.access).toBe('tok-access');
    expect(creds.refresh).toBe('tok-refresh');
    expect(creds.expires).toBe(1_700_000_000_000 + 3600 * 1000);
    expect((creds as any).region).toBe('cn');
    expect((creds as any).resourceUrl).toBe('https://api.minimaxi.com/anthropic');

    // One call to /oauth/code + two calls to /oauth/token (pending → success).
    const paths = calls.map((c) => c.path);
    expect(paths).toEqual(['/oauth/code', '/oauth/token', '/oauth/token']);
    // Pending → sleep called once before the successful poll.
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on an error status from the token endpoint', async () => {
    const book: RouteBook = {
      '/oauth/code': [
        async (body) => ({
          status: 200,
          body: {
            user_code: 'XX-99',
            verification_uri: 'https://example.com/activate',
            expired_in: 1_700_000_000_000 + 60_000,
            state: body.get('state'),
          },
        }),
      ],
      '/oauth/token': [
        async () => ({
          status: 200,
          body: { status: 'error', base_resp: { status_msg: '用户已拒绝授权' } },
        }),
      ],
    };
    installFetch(book);

    await expect(
      loginMiniMaxPortal({
        region: 'global',
        callbacks: { onAuth: () => {}, onPrompt: async () => '' },
        _now:   () => 1_700_000_000_000,
        _sleep: async () => { /* noop */ },
      }),
    ).rejects.toThrow(/用户已拒绝授权/);
  });

  it('throws a CSRF-shaped error when the state echo mismatches', async () => {
    const book: RouteBook = {
      '/oauth/code': [
        async () => ({
          status: 200,
          body: {
            user_code: 'AB-12',
            verification_uri: 'https://example.com/x',
            expired_in: 1_700_000_000_000 + 60_000,
            state: 'totally-different',
          },
        }),
      ],
    };
    installFetch(book);

    await expect(
      loginMiniMaxPortal({
        region: 'global',
        callbacks: { onAuth: () => {}, onPrompt: async () => '' },
        _now:   () => 1_700_000_000_000,
        _sleep: async () => { /* noop */ },
      }),
    ).rejects.toThrow(/state/i);
  });

  it('throws a timeout error once the authorization window has expired', async () => {
    let tick = 1_700_000_000_000;
    const book: RouteBook = {
      '/oauth/code': [
        async (body) => ({
          status: 200,
          body: {
            user_code: 'YY-88',
            verification_uri: 'https://example.com/x',
            expired_in: tick + 5_000, // tight 5 s window
            state: body.get('state'),
          },
        }),
      ],
      // Two "pending" responses before the clock advances past expiry.
      '/oauth/token': [
        async () => ({ status: 200, body: { status: 'pending' } }),
        async () => ({ status: 200, body: { status: 'pending' } }),
      ],
    };
    installFetch(book);

    const sleepMock = vi.fn(async () => { tick += 3_000; /* advance clock */ });
    await expect(
      loginMiniMaxPortal({
        region: 'global',
        callbacks: { onAuth: () => {}, onPrompt: async () => '' },
        _now:   () => tick,
        _sleep: sleepMock,
      }),
    ).rejects.toThrow(/超时/);
    expect(sleepMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── refreshToken ─────────────────────────────────────────────────────────

describe('oauth-minimax › provider.refreshToken', () => {
  it('trades a refresh token for a fresh access token', async () => {
    const book: RouteBook = {
      '/oauth/token': [
        async (body) => {
          expect(body.get('grant_type')).toBe('refresh_token');
          expect(body.get('refresh_token')).toBe('old-refresh');
          return {
            status: 200,
            body: {
              status: 'success',
              access_token:  'new-access',
              refresh_token: 'new-refresh',
              expired_in:    7200,
            },
          };
        },
      ],
    };
    installFetch(book);

    const provider = buildMinimaxPortalProvider('global');
    const now = Date.now();
    const creds = await provider.refreshToken({
      access:  'old-access',
      refresh: 'old-refresh',
      expires: now - 1000,
    });
    expect(creds.access).toBe('new-access');
    expect(creds.refresh).toBe('new-refresh');
    // expected: resolveExpiresAt(7200, now) = now + 7200_000 (roughly)
    expect(creds.expires).toBeGreaterThan(now);
  });

  it('throws a clear error when the refresh endpoint returns non-success', async () => {
    const book: RouteBook = {
      '/oauth/token': [
        async () => ({ status: 400, body: { status: 'error', base_resp: { status_msg: 'refresh expired' } } }),
      ],
    };
    installFetch(book);

    const provider = buildMinimaxPortalProvider('cn');
    await expect(
      provider.refreshToken({ access: 'x', refresh: 'y', expires: 0 }),
    ).rejects.toThrow(/refresh[_ ]token 失败/);
  });
});

// ── buildMinimaxPortalProvider ──────────────────────────────────────────

describe('oauth-minimax › buildMinimaxPortalProvider', () => {
  it('exposes distinct ids per region, with device-code semantics', () => {
    const global = buildMinimaxPortalProvider('global');
    const cn     = buildMinimaxPortalProvider('cn');
    expect(global.id).toBe('minimax-portal');
    expect(cn.id).toBe('minimax-portal-cn');
    expect(global.usesCallbackServer).toBe(false);
    expect(cn.usesCallbackServer).toBe(false);
  });

  it('getApiKey returns the access token unchanged', () => {
    const p = buildMinimaxPortalProvider('global');
    expect(p.getApiKey({ access: 'k', refresh: 'r', expires: 1 })).toBe('k');
  });
});
