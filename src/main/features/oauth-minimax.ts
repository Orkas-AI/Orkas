/**
 * MiniMax Portal OAuth — custom pi-ai `OAuthProviderInterface`.
 *
 * ## Why custom
 * pi-ai's built-in OAuth registry only ships Anthropic / OpenAI-Codex /
 * Google-CLI / Antigravity / GitHub-Copilot. None of the Chinese providers
 * are included upstream. MiniMax is the only mainland provider whose
 * subscription flow is a straightforward **device-code + PKCE** OAuth 2.0
 * flow, making it a clean candidate to implement ourselves.
 *
 * ## Flow
 *
 *   1. Client generates PKCE verifier + SHA-256 challenge + random state.
 *   2. POST `/oauth/code` with `response_type=code`, `client_id`,
 *      `code_challenge`, `code_challenge_method=S256`, `state`, and the
 *      desired `scope`. Response carries a `user_code`, a
 *      `verification_uri` to open in the browser, a `state` echo (verified
 *      against our generated one), and an `expired_in` wall-clock unix
 *      timestamp after which polling must stop.
 *   3. The user opens the verification URL (we fire the system browser),
 *      enters the user_code, and approves.
 *   4. Client polls `/oauth/token` with
 *      `grant_type=urn:ietf:params:oauth:grant-type:user_code`,
 *      `client_id`, `user_code`, `code_verifier`. Response `status` cycles
 *      through `pending` → `success|error`. On `success`, `access_token` /
 *      `refresh_token` / `expired_in` are returned.
 *   5. Refresh uses the standard `grant_type=refresh_token` endpoint.
 *
 * ## Port source
 * Translated from `openclaw/extensions/minimax/oauth.ts` (main branch,
 * checked 2026-04-19). Shared client_id is intentionally a public constant
 * — the minimax.io spec treats it as non-secret.
 *
 * ## Region
 * Two endpoints:
 *   - `global` → https://api.minimax.io
 *   - `cn`     → https://api.minimaxi.com
 * Region is baked into the provider id (`minimax-portal` for global;
 * `minimax-portal-cn` for the mainland endpoint) so that pi-ai stores
 * separate credentials per region.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { t } from '../i18n';
import { fetchWithTimeout } from '../util/abort';

// ── Endpoint config ──────────────────────────────────────────────────────

export type MiniMaxRegion = 'global' | 'cn';

// Shared across regions; treated as non-secret (matches openclaw upstream).
const MINIMAX_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113';
const MINIMAX_SCOPE = 'group_id profile model.completion';
const MINIMAX_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code';

const MINIMAX_BASE_URL: Record<MiniMaxRegion, string> = {
  global: 'https://api.minimax.io',
  cn:     'https://api.minimaxi.com',
};

// Default polling interval when server doesn't specify one.
const MIN_POLL_INTERVAL_MS = 2000;
const MINIMAX_OAUTH_HTTP_TIMEOUT_MS = 60_000;
const MINIMAX_TOKEN_POLL_HTTP_TIMEOUT_MS = 30_000;

// ── Token payload shapes (server contract) ───────────────────────────────

interface AuthorizationResponse {
  user_code: string;
  verification_uri: string;
  expired_in: number;        // unix ms — wall clock, not TTL
  interval?: number;         // recommended polling interval in ms
  state: string;
  error?: string;
}

interface TokenSuccessPayload {
  status: 'success';
  access_token: string;
  refresh_token: string;
  expired_in: number;         // TTL seconds (see resolveExpiresAt below)
  token_type?: string;
  resource_url?: string;
  notification_message?: string;
}

interface TokenPendingPayload {
  status: 'pending';
  base_resp?: { status_code?: number; status_msg?: string };
}

interface TokenErrorPayload {
  status: 'error' | string;
  base_resp?: { status_code?: number; status_msg?: string };
}

type TokenPayload = TokenSuccessPayload | TokenPendingPayload | TokenErrorPayload;

// ── PKCE ────────────────────────────────────────────────────────────────

export interface PkceBundle {
  verifier: string;
  challenge: string;
  state: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** RFC 7636 PKCE pair + CSRF-style state token. */
export function generatePkce(): PkceBundle {
  const verifierBytes = randomBytes(32);
  const verifier  = base64UrlEncode(verifierBytes);
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  const state     = base64UrlEncode(randomBytes(16));
  return { verifier, challenge, state };
}

function toFormBody(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function fetchMiniMax(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithTimeout(
    url,
    init,
    timeoutMs,
    signal,
    `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

function isMiniMaxPollTimeout(err: unknown): boolean {
  return err instanceof Error && /MiniMax token poll timed out after/.test(err.message);
}

// ── HTTP: request device code ────────────────────────────────────────────

async function requestAuthorization(opts: {
  region: MiniMaxRegion;
  challenge: string;
  state: string;
  signal?: AbortSignal;
}): Promise<AuthorizationResponse> {
  const base = MINIMAX_BASE_URL[opts.region];
  const res = await fetchMiniMax('MiniMax authorization request', `${base}/oauth/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':       'application/json',
    },
    body: toFormBody({
      response_type:         'code',
      client_id:             MINIMAX_CLIENT_ID,
      scope:                 MINIMAX_SCOPE,
      code_challenge:        opts.challenge,
      code_challenge_method: 'S256',
      state:                 opts.state,
    }),
  }, MINIMAX_OAUTH_HTTP_TIMEOUT_MS, opts.signal);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(t('oauth.minimax.auth_request_failed', { status: res.status, body: body || res.statusText }));
  }

  const payload = (await res.json()) as AuthorizationResponse;
  if (!payload?.user_code || !payload?.verification_uri) {
    throw new Error(payload?.error || t('oauth.minimax.response_missing_fields'));
  }
  if (payload.state !== opts.state) {
    throw new Error(t('oauth.minimax.state_mismatch'));
  }
  return payload;
}

// ── HTTP: poll token ─────────────────────────────────────────────────────

async function pollToken(opts: {
  region: MiniMaxRegion;
  userCode: string;
  verifier: string;
  signal?: AbortSignal;
}): Promise<TokenPayload> {
  const base = MINIMAX_BASE_URL[opts.region];
  let res: Response;
  try {
    res = await fetchMiniMax('MiniMax token poll', `${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
      body: toFormBody({
        grant_type:    MINIMAX_GRANT_TYPE,
        client_id:     MINIMAX_CLIENT_ID,
        user_code:     opts.userCode,
        code_verifier: opts.verifier,
      }),
    }, MINIMAX_TOKEN_POLL_HTTP_TIMEOUT_MS, opts.signal);
  } catch (err) {
    if (isMiniMaxPollTimeout(err)) {
      return { status: 'pending', base_resp: { status_msg: (err as Error).message } };
    }
    throw err;
  }

  const text = await res.text();
  let parsed: TokenPayload | undefined;
  if (text) {
    try { parsed = JSON.parse(text) as TokenPayload; } catch { /* leave undefined */ }
  }

  if (!res.ok) {
    const msg = (parsed as any)?.base_resp?.status_msg || text || res.statusText;
    return { status: 'error', base_resp: { status_msg: msg } };
  }
  if (!parsed) {
    return { status: 'error', base_resp: { status_msg: t('oauth.minimax.unparseable_response') } };
  }
  return parsed;
}

// ── HTTP: refresh token ──────────────────────────────────────────────────

async function refreshTokenCall(opts: {
  region: MiniMaxRegion;
  refresh: string;
  signal?: AbortSignal;
}): Promise<TokenSuccessPayload> {
  const base = MINIMAX_BASE_URL[opts.region];
  const res = await fetchMiniMax('MiniMax token refresh', `${base}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':       'application/json',
    },
    body: toFormBody({
      grant_type:    'refresh_token',
      client_id:     MINIMAX_CLIENT_ID,
      refresh_token: opts.refresh,
    }),
  }, MINIMAX_OAUTH_HTTP_TIMEOUT_MS, opts.signal);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(t('oauth.minimax.refresh_failed_status', { status: res.status, body: body || res.statusText }));
  }
  const payload = (await res.json()) as TokenPayload;
  if (payload.status !== 'success') {
    const msg = (payload as any)?.base_resp?.status_msg || t('oauth.minimax.refresh_failed_default');
    throw new Error(t('oauth.minimax.refresh_failed', { message: msg }));
  }
  const ok = payload as TokenSuccessPayload;
  if (!ok.access_token || !ok.refresh_token || typeof ok.expired_in !== 'number') {
    throw new Error(t('oauth.minimax.refresh_missing_fields'));
  }
  return ok;
}

// ── Expiry normalization ────────────────────────────────────────────────

/**
 * `expired_in` from MiniMax is sometimes a TTL in seconds and sometimes a
 * wall-clock unix timestamp (ms). Disambiguate by magnitude: values above
 * Year-2000 epoch (946684800000 ms) are treated as absolute; otherwise as
 * a seconds-TTL added to now.
 */
export function resolveExpiresAt(raw: number, now: number = Date.now()): number {
  if (!Number.isFinite(raw) || raw <= 0) return now + 3600_000; // safe default
  // Unix wall clock in ms (>= year 2000) → return as-is.
  if (raw >= 946684800000) return raw;
  // Otherwise TTL seconds.
  return now + raw * 1000;
}

// ── Device-code login orchestration ──────────────────────────────────────

export interface LoginOptions {
  region: MiniMaxRegion;
  callbacks: OAuthLoginCallbacks;
  /** Override poll interval (ms). Clamped to >= MIN_POLL_INTERVAL_MS. */
  minPollIntervalMs?: number;
  /** Injected fetch/timer for tests. */
  _now?: () => number;
  _sleep?: (ms: number) => Promise<void>;
}

export async function loginMiniMaxPortal(opts: LoginOptions): Promise<OAuthCredentials> {
  const now    = opts._now   || (() => Date.now());
  const sleep  = opts._sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { region, callbacks } = opts;

  const { verifier, challenge, state } = generatePkce();
  callbacks.onProgress?.(t('oauth.minimax.requesting'));
  const auth = await requestAuthorization({ region, challenge, state, signal: callbacks.signal });

  const instructions = t('oauth.minimax.instructions', { code: auth.user_code });

  callbacks.onAuth({ url: auth.verification_uri, instructions });

  const expireAt = auth.expired_in;
  const pollIntervalMs = Math.max(
    opts.minPollIntervalMs ?? auth.interval ?? MIN_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );

  while (now() < expireAt) {
    if (callbacks.signal?.aborted) throw new Error('cancelled');

    callbacks.onProgress?.(t('oauth.minimax.waiting'));
    const result = await pollToken({
      region,
      userCode: auth.user_code,
      verifier,
      signal: callbacks.signal,
    });

    if (result.status === 'success') {
      const ok = result as TokenSuccessPayload;
      const creds: OAuthCredentials = {
        access:  ok.access_token,
        refresh: ok.refresh_token,
        expires: resolveExpiresAt(ok.expired_in, now()),
      };
      if (ok.resource_url)          (creds as any).resourceUrl         = ok.resource_url;
      if (ok.notification_message)  (creds as any).notificationMessage = ok.notification_message;
      (creds as any).region = region;
      return creds;
    }

    if (result.status === 'error') {
      const msg = (result as any)?.base_resp?.status_msg || t('oauth.minimax.failed_default');
      throw new Error(t('oauth.minimax.failed', { message: msg }));
    }

    // status === 'pending' → keep polling
    await sleep(pollIntervalMs);
  }

  throw new Error(t('oauth.minimax.timeout'));
}

// ── pi-ai OAuthProviderInterface factory ─────────────────────────────────

/** Build a provider for one region. Exposed for testing. */
export function buildMinimaxPortalProvider(region: MiniMaxRegion): OAuthProviderInterface {
  const id   = region === 'cn' ? 'minimax-portal-cn' : 'minimax-portal';
  const name = region === 'cn' ? 'MiniMax Portal (CN)' : 'MiniMax Portal (Global)';
  return {
    id,
    name,
    // Device-code flow — no local callback server is used, so the UI
    // should NOT show a manual-paste input box.
    usesCallbackServer: false,

    async login(callbacks) {
      return loginMiniMaxPortal({ region, callbacks });
    },

    async refreshToken(credentials) {
      const storedRegion = ((credentials as any).region as MiniMaxRegion) || region;
      const refreshed = await refreshTokenCall({
        region: storedRegion,
        refresh: credentials.refresh,
      });
      return {
        ...credentials,
        access:  refreshed.access_token,
        refresh: refreshed.refresh_token,
        expires: resolveExpiresAt(refreshed.expired_in),
      };
    },

    getApiKey(credentials) {
      return credentials.access;
    },
  };
}

/**
 * Register both region variants with pi-ai. Idempotent — safe to call
 * multiple times (pi-ai's registry uses id as key).
 *
 * **Registry consistency**: pi-ai is an ESM-only package, but the
 * Orkas main process is transpiled at runtime via `tsx/cjs`. We've
 * previously hit weird behavior where `register` succeeded yet
 * `getOAuthProvider` returned undefined (likely an ESM/CJS interop
 * issue producing two registry instances). After registering, we
 * immediately read back to self-verify and throw on mismatch so the
 * cause is locatable.
 */
export async function registerMinimaxOAuthProviders(): Promise<void> {
  const oauth = await import('@earendil-works/pi-ai/oauth');
  const providers = [buildMinimaxPortalProvider('global'), buildMinimaxPortalProvider('cn')];
  for (const p of providers) {
    oauth.registerOAuthProvider(p);
    const readback = oauth.getOAuthProvider(p.id as any);
    if (!readback) {
      throw new Error(`pi-ai oauth registry self-check failed: registerOAuthProvider('${p.id}') was not readable afterwards — the ESM/CJS registry may be split`);
    }
  }
}
