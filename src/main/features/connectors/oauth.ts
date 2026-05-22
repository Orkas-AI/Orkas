/**
 * Connector OAuth — Server-bridge flow (mirror of `features/account/oauth_flow.ts`).
 *
 * Flow:
 *   1. PC `startOAuth(catalog_id)` → opens system browser to
 *      `<accountApiBase>/connectors/oauth/<provider>/start?d=<device_id>&lang=<lang>`
 *   2. Server picks `client_id` / `client_secret` (Orkas-registered OAuth App; **NOT** in PC
 *      binary), redirects browser through the provider consent screen.
 *   3. Provider callback lands on the Server's `<base>/connectors/oauth/<provider>/callback`,
 *      Server runs the token exchange, stores `{provider, tokens}` against a one-time
 *      `exchange_code` (short TTL, `device_id`-bound), 302s the browser through a landing page
 *      that deep-links `orkas://connectors/oauth/callback?exchange_code=...`.
 *   4. PC's protocol handler routes the deep link here → POST
 *      `<base>/connectors/oauth/exchange` → gets `{provider, access_token, refresh_token,
 *      expires_in, scopes, account_label}` → persists locally (encrypted via crypto-vault) →
 *      brings the MCP connection up.
 *
 * Token data NEVER persists on Server beyond `EXCHANGE_TTL`. Refresh is handled client-side
 * via the provider's standard refresh_token grant (`refreshIfStale`).
 *
 * **No localhost HTTP listener** — §1 hard rule. The earlier draft of this file bound an
 * ephemeral 127.0.0.1 port; that approach was scrapped in favor of the existing `orkas://`
 * deep-link infrastructure (same as account login). Don't bring the listener back.
 */
import { shell } from 'electron';

import { getLanguage } from '../config';
import { createLogger } from '../../logger';
import type { CatalogEntry, OAuthGrant } from './types';

const log = createLogger('connectors:oauth');

// 10 minutes — comfortably covers a slow provider consent screen + 2FA. The Server side enforces
// its own short TTLs on state / exchange_code (see Server/biz/connectors/oauth_flow_mgr.py).
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface PendingFlow {
  catalogId: string;
  resolve: (grant: OAuthGrant) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// At most one connector OAuth flow in flight per app instance. The protocol handler reads from
// this to fulfill the right Promise when the deep link arrives.
let _pending: PendingFlow | null = null;

function _cancelPending(reason: string): void {
  if (!_pending) return;
  const p = _pending;
  _pending = null;
  clearTimeout(p.timer);
  p.reject(new Error(reason));
}

/** Externally callable cancel — wired to the renderer's "取消" link so a user who closed the
 *  browser without completing OAuth can unfreeze the card without waiting for the timeout. */
export function cancelInFlightOAuth(): boolean {
  if (!_pending) return false;
  _cancelPending('cancelled by user');
  return true;
}

/** Drive the full OAuth flow for a catalog entry. Resolves with the OAuthGrant or rejects. */
export async function startOAuth(_uid: string, entry: CatalogEntry): Promise<OAuthGrant> {
  if (!entry.oauth) throw new Error(`catalog entry ${entry.id} has no oauth config`);
  // Pre-empt any prior in-flight flow — the user clicking another card while one is open is a
  // legitimate UX path (cancel the old one and start over).
  _cancelPending('superseded by a new OAuth start');

  const providerId = entry.oauth.provider_id;
  const startUrl = new URL(`${accountApiBase()}/connectors/oauth/${encodeURIComponent(providerId)}/start`);
  startUrl.searchParams.set('d', tokenStore.getDeviceId());
  startUrl.searchParams.set('lang', getLanguage());
  startUrl.searchParams.set('catalog_id', entry.id);

  log.info('opening connector OAuth start url', { provider: providerId, catalog_id: entry.id });
  return new Promise<OAuthGrant>((resolve, reject) => {
    const timer = setTimeout(() => {
      _cancelPending('OAuth flow timed out');
    }, FLOW_TIMEOUT_MS);
    timer.unref?.();
    _pending = { catalogId: entry.id, resolve, reject, timer };
    shell.openExternal(startUrl.toString()).catch((err) => {
      _cancelPending(`failed to open browser: ${(err as Error).message}`);
    });
  });
}

/** Called by the protocol handler when `orkas://connectors/oauth/callback?...` arrives. */
export async function handleCallbackUrl(rawUrl: string): Promise<void> {
  log.info('connector callback url received', { path: rawUrl.split('?')[0] });
  if (!_pending) {
    log.warn('connector callback arrived with no pending flow', { url: rawUrl.split('?')[0] });
    return;
  }
  const pending = _pending;
  let url: URL;
  try { url = new URL(rawUrl); }
  catch (err) {
    _cancelPending(`malformed callback URL: ${(err as Error).message}`);
    return;
  }
  void pending;
  const status = url.searchParams.get('status');
  const reason = url.searchParams.get('reason') || '';
  if (status === 'cancelled') { _cancelPending('user cancelled at provider'); return; }
  if (status === 'error') { _cancelPending(`server error: ${reason || 'unknown'}`); return; }
  const exchangeCode = url.searchParams.get('exchange_code');
  if (!exchangeCode) { _cancelPending('missing exchange_code'); return; }

  try {
    const res = await fetch(`${accountApiBase()}/connectors/oauth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...tokenStore.authHeaders(),
      },
      body: JSON.stringify({
        exchange_code: exchangeCode,
        device_id: tokenStore.getDeviceId(),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`exchange HTTP ${res.status}: ${text}`);
    }
    // Server's `api/response.py::json_response(code, msg, data)` **spreads** the data dict into
    // the top-level body (see Web/CLAUDE.md §3 "Read res.code, not res.data.code"); the payload
    // fields hang directly off the body, NOT under a nested `data` key.
    const body = await res.json() as {
      code: number;
      msg?: string;
      provider?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      account_label?: string;
    };
    if (body.code !== 0 || !body.access_token) {
      throw new Error(body.msg || 'invalid exchange response');
    }
    const expires_at = typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null;
    const scopes = body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : [];
    const grant: OAuthGrant = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || null,
      expires_at,
      scopes,
      token_type: body.token_type || 'Bearer',
      ...(body.account_label ? { account_label: body.account_label } : {}),
    };
    _pending = null;
    clearTimeout(pending.timer);
    log.info('connector OAuth grant resolved', {
      catalog_id: pending.catalogId,
      has_refresh: !!grant.refresh_token,
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : null,
      account_label: grant.account_label || null,
    });
    pending.resolve(grant);
  } catch (err) {
    log.warn('connector OAuth exchange failed', { error: (err as Error).message });
    _cancelPending(`exchange failed: ${(err as Error).message}`);
  }
}

/** Refresh the access_token if it's expired or about to expire. Calls the provider directly
 *  through the Server's refresh proxy. */
export async function refreshIfStale(uid: string, entry: CatalogEntry, grant: OAuthGrant): Promise<OAuthGrant> {
  if (!grant.expires_at) return grant;
  if (grant.expires_at - Date.now() > REFRESH_BUFFER_MS) return grant;
  if (!grant.refresh_token) {
    throw new Error('access_token expired and no refresh_token available; reconnect required');
  }
  if (!entry.oauth) throw new Error('no oauth config');
  const res = await fetch(`${accountApiBase()}/connectors/oauth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...tokenStore.authHeaders(),
    },
    body: JSON.stringify({
      provider: entry.oauth.provider_id,
      refresh_token: grant.refresh_token,
      device_id: tokenStore.getDeviceId(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh HTTP ${res.status}: ${text}`);
  }
  // Same flat shape as the exchange endpoint — see comment above.
  const body = await res.json() as {
    code: number;
    msg?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (body.code !== 0 || !body.access_token) {
    throw new Error(body.msg || 'invalid refresh response');
  }
  const expires_at = typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null;
  const scopes = body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : grant.scopes;
  void uid;
  const next: OAuthGrant = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || grant.refresh_token,
    expires_at,
    scopes,
    token_type: body.token_type || 'Bearer',
    ...(grant.account_label ? { account_label: grant.account_label } : {}),
  };
  return next;
}
