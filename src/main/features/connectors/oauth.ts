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
 *      expires_in, scopes, account_label}`. For GitHub, Server keeps the rotating refresh grant
 *      and returns `{refresh_token:null, grant_id, server_managed:true}`. PC persists only the
 *      local grant handle + current access token (encrypted via local-secret-store) → brings the
 *      MCP connection up.
 *
 * Token data normally does not persist on Server beyond `EXCHANGE_TTL`; GitHub is the exception
 * because GitHub App refresh tokens rotate and multiple synced devices can invalidate each other.
 * GitHub refresh is therefore serialized by Server, while other server-bridge providers still
 * refresh through the generic proxy path.
 *
 * **No localhost HTTP listener** — §1 hard rule. The earlier draft of this file bound an
 * ephemeral 127.0.0.1 port; that approach was scrapped in favor of the existing `orkas://`
 * deep-link infrastructure (same as account login). Don't bring the listener back.
 */
import { shell } from 'electron';

import { accountApiBase, tokenStore } from './_server_bridge';
import { getLanguage } from '../config';
import { createLogger } from '../../logger';
import type { CatalogEntry, OAuthGrant } from './types';

const log = createLogger('connectors:oauth');

// 10 minutes — comfortably covers a slow provider consent screen + 2FA. The Server side enforces
// its own short TTLs on state / exchange_code (see Server/biz/connectors/oauth_flow_mgr.py).
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_REFRESH_RETRY_DELAY_MS = 400;

interface PendingFlow {
  kind: 'connector_oauth' | 'google_picker';
  catalogId: string;
  requiredScopes: string[];
  resolve: (result: OAuthGrant | GooglePickerResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ConnectorRefreshErrorBody {
  msg?: string;
  error_code?: string;
  retryable?: boolean;
}

export interface GooglePickerResult {
  grant: OAuthGrant;
  pickedFileIds: string[];
}

// At most one connector OAuth flow in flight per app instance. The protocol handler reads from
// this to fulfill the right Promise when the deep link arrives.
let _pending: PendingFlow | null = null;

function _flowError(reason: string, code?: string): Error {
  const err = new Error(reason);
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

function _cancelPending(reason: string, code?: string): void {
  if (!_pending) return;
  const p = _pending;
  _pending = null;
  clearTimeout(p.timer);
  p.reject(_flowError(reason, code));
}

function _missingRequiredScopes(requiredScopes: string[] | undefined, grantedScopes: string[]): string[] {
  if (!Array.isArray(requiredScopes) || !requiredScopes.length) return [];
  const granted = new Set((grantedScopes || []).filter(Boolean));
  return requiredScopes.filter((scope) => !granted.has(scope));
}

function _refreshErrorFromBody(body: ConnectorRefreshErrorBody, fallback: string): Error {
  const errorCode = typeof body.error_code === 'string' ? body.error_code : '';
  const message = body.msg || fallback;
  const err = new Error(errorCode ? `${errorCode}: ${message}` : message) as Error & {
    code?: string;
    retryable?: boolean;
  };
  if (errorCode) err.code = errorCode;
  if (typeof body.retryable === 'boolean') err.retryable = body.retryable;
  return err;
}

/** Externally callable cancel — wired to the renderer's "取消" link so a user who closed the
 *  browser without completing OAuth can unfreeze the card without waiting for the timeout. */
export function cancelInFlightOAuth(): boolean {
  if (!_pending) return false;
  _cancelPending('cancelled by user');
  return true;
}

/** Drive the full OAuth flow for a catalog entry. Resolves with the OAuthGrant or rejects. */
export async function startOAuth(
  _uid: string,
  entry: CatalogEntry,
  opts: { reauthorize?: boolean } = {},
): Promise<OAuthGrant> {
  if (!entry.oauth) throw new Error(`catalog entry ${entry.id} has no oauth config`);
  // Pre-empt any prior in-flight flow — the user clicking another card while one is open is a
  // legitimate UX path (cancel the old one and start over).
  _cancelPending('superseded by a new OAuth start');

  const providerId = entry.oauth.provider_id;
  const startUrl = new URL(`${accountApiBase()}/connectors/oauth/${encodeURIComponent(providerId)}/start`);
  startUrl.searchParams.set('d', tokenStore.getDeviceId());
  startUrl.searchParams.set('lang', getLanguage());
  startUrl.searchParams.set('catalog_id', entry.id);
  if (opts.reauthorize) {
    startUrl.searchParams.set('mode', 'reauthorize');
  }

  log.info('opening connector OAuth start url', {
    provider: providerId,
    catalog_id: entry.id,
    mode: opts.reauthorize ? 'reauthorize' : 'install',
  });
  return new Promise<OAuthGrant>((resolve, reject) => {
    const timer = setTimeout(() => {
      _cancelPending('OAuth flow timed out');
    }, FLOW_TIMEOUT_MS);
    timer.unref?.();
    _pending = {
      kind: 'connector_oauth',
      catalogId: entry.id,
      requiredScopes: Array.isArray(entry.required_oauth_scopes) ? entry.required_oauth_scopes.slice() : [],
      resolve: resolve as PendingFlow['resolve'],
      reject,
      timer,
    };
    shell.openExternal(startUrl.toString()).catch((err) => {
      _cancelPending(`failed to open browser: ${(err as Error).message}`);
    });
  });
}

/** Open Google's desktop Picker so the user can explicitly grant Orkas access to an existing
 *  spreadsheet under the narrow `drive.file` scope. Google requires this Picker flow to request
 *  `drive.file` by itself (`trigger_onepick=true`), so it is separate from the normal connector
 *  sign-in flow that also asks for `openid email` for account labeling. */
export async function startGoogleSheetsPicker(fileIds?: string[]): Promise<GooglePickerResult> {
  _cancelPending('superseded by a new OAuth start');

  const startUrl = new URL(`${accountApiBase()}/connectors/oauth/google/picker/start`);
  startUrl.searchParams.set('d', tokenStore.getDeviceId());
  startUrl.searchParams.set('lang', getLanguage());
  startUrl.searchParams.set('catalog_id', 'gsheets');
  const cleanFileIds = (fileIds || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (cleanFileIds.length) startUrl.searchParams.set('file_ids', cleanFileIds.join(','));

  log.info('opening Google Sheets picker url', { file_id_count: cleanFileIds.length });
  return new Promise<GooglePickerResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      _cancelPending('OAuth flow timed out');
    }, FLOW_TIMEOUT_MS);
    timer.unref?.();
    _pending = {
      kind: 'google_picker',
      catalogId: 'gsheets',
      requiredScopes: ['https://www.googleapis.com/auth/drive.file'],
      resolve: resolve as PendingFlow['resolve'],
      reject,
      timer,
    };
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
  if (status === 'error') {
    const code = reason === 'missing_required_scopes' ? 'missing_required_scopes' : undefined;
    const message = reason === 'missing_required_scopes' ? reason : `server error: ${reason || 'unknown'}`;
    _cancelPending(message, code);
    return;
  }
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
      grant_id?: string;
      server_managed?: boolean;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      account_label?: string;
      picked_file_ids?: string;
    };
    if (body.code !== 0 || !body.access_token) {
      throw new Error(body.msg || 'invalid exchange response');
    }
    const expires_at = typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null;
    const scopes = body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : [];
    const missingScopes = _missingRequiredScopes(pending.requiredScopes, scopes);
    if (missingScopes.length) {
      _pending = null;
      clearTimeout(pending.timer);
      log.warn('connector OAuth missing required scopes', {
        catalog_id: pending.catalogId,
        missing_count: missingScopes.length,
      });
      pending.reject(_flowError('missing_required_scopes', 'missing_required_scopes'));
      return;
    }
    const grant: OAuthGrant = {
      access_token: body.access_token,
      refresh_token: body.server_managed ? null : (body.refresh_token || null),
      expires_at,
      scopes,
      token_type: body.token_type || 'Bearer',
      ...(body.server_managed ? { server_managed: true } : {}),
      ...(body.grant_id ? { server_grant_id: body.grant_id } : {}),
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
    if (pending.kind === 'google_picker') {
      const pickedFileIds = String(body.picked_file_ids || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      pending.resolve({ grant, pickedFileIds });
    } else {
      pending.resolve(grant);
    }
  } catch (err) {
    log.warn('connector OAuth exchange failed', { error: (err as Error).message });
    const code = (err as { code?: unknown }).code;
    _cancelPending(`exchange failed: ${(err as Error).message}`, typeof code === 'string' ? code : undefined);
  }
}

/** Refresh the access_token if it's expired or about to expire. Calls the provider directly
 *  through the Server's refresh proxy. */
export async function refreshIfStale(
  uid: string,
  entry: CatalogEntry,
  grant: OAuthGrant,
  opts: { force?: boolean } = {},
): Promise<OAuthGrant> {
  if (entry.oauth?.provider_id === 'github') {
    return refreshGithubServerManaged(entry, grant, opts);
  }
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
    error_code?: string;
    retryable?: boolean;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (body.code !== 0) throw _refreshErrorFromBody(body, 'invalid refresh response');
  if (!body.access_token) throw new Error('invalid refresh response');
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function fetchGithubRefresh(body: Record<string, unknown>): Promise<Response> {
  const url = `${accountApiBase()}/connectors/oauth/refresh`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...tokenStore.authHeaders(),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        log.warn('GitHub server-managed refresh fetch failed; retrying once', { error: (err as Error).message });
        await sleep(GITHUB_REFRESH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

async function refreshGithubServerManaged(
  entry: CatalogEntry,
  grant: OAuthGrant,
  opts: { force?: boolean } = {},
): Promise<OAuthGrant> {
  const hasServerGrant = !!grant.server_grant_id;
  const hasLegacyRefresh = !!grant.refresh_token;
  const stale = !!(grant.expires_at && grant.expires_at - Date.now() <= REFRESH_BUFFER_MS);

  // Existing installations may still have the old cloud-synced GitHub refresh_token. Adopt it
  // into Server immediately, even if the current access_token is still fresh, so future devices
  // stop racing on GitHub's rotating refresh token.
  if (!hasServerGrant && !hasLegacyRefresh) {
    if (!grant.expires_at || !stale) return grant;
    throw new Error('github grant expired and has no server grant; reconnect required');
  }
  if (hasServerGrant && !stale && !opts.force) return grant;

  if (!entry.oauth) throw new Error('no oauth config');
  const res = await fetchGithubRefresh({
    provider: entry.oauth.provider_id,
    device_id: tokenStore.getDeviceId(),
    ...(opts.force ? { force_refresh: true } : {}),
    ...(grant.server_grant_id ? { grant_id: grant.server_grant_id } : {}),
    ...(!grant.server_grant_id && grant.refresh_token ? {
      refresh_token: grant.refresh_token,
      access_token: grant.access_token,
      expires_at_ms: grant.expires_at || 0,
      token_type: grant.token_type || 'Bearer',
      scope: grant.scopes.join(' '),
      account_label: grant.account_label || '',
    } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh HTTP ${res.status}: ${text}`);
  }
  const body = await res.json() as {
    code: number;
    msg?: string;
    error_code?: string;
    retryable?: boolean;
    access_token?: string;
    grant_id?: string;
    server_managed?: boolean;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    account_label?: string;
  };
  if (body.code !== 0) throw _refreshErrorFromBody(body, 'invalid github refresh response');
  if (!body.access_token || !body.grant_id) throw new Error('invalid github refresh response');
  const expires_at = typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null;
  return {
    access_token: body.access_token,
    refresh_token: null,
    server_managed: true,
    server_grant_id: body.grant_id,
    expires_at,
    scopes: body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : grant.scopes,
    token_type: body.token_type || grant.token_type || 'Bearer',
    ...(body.account_label || grant.account_label ? { account_label: body.account_label || grant.account_label } : {}),
  };
}
