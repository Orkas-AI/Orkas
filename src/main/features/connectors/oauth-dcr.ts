/**
 * MCP-spec OAuth (Dynamic Client Registration) client.
 *
 * For providers that host their own OAuth authorization server per the MCP authorization spec
 * (Notion, Atlassian, Cloudflare suite, …). Orkas has no pre-registered OAuth App at the
 * provider — PC self-registers at first connect via DCR (RFC 7591) and drives the initial
 * OAuth handshake from the PC side.
 *
 * The Server-bridge in `oauth.ts` handles a different class of providers (GitHub Copilot MCP
 * today) where Orkas registered an OAuth App and Server holds the secret. The two flows live
 * side-by-side and `manager.ts::connectViaOAuth` dispatches by `catalog.auth_mode`.
 *
 * Server serves `/api/connectors/oauth/dcr-callback` as a stable HTTPS redirect_uri (DCR
 * clients must declare one at registration), stashes the {code, state} pair under a one-time
 * exchange_code, and deep-links back to PC. PC then does the first token POST against the
 * provider's `token_endpoint` using the DCR-issued credentials. The public build then keeps the
 * DCR client credentials and rotating refresh grant in its local encrypted connector registry.
 * Server is only the short-lived HTTPS callback intermediary; it never receives those secrets.
 *
 * The public build never starts a loopback callback listener. Its bridge base is pinned to the
 * global production HTTPS origin, and the landing page returns through the connector-only OS
 * protocol receiver.
 */
import * as crypto from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { shell } from 'electron';

import { accountApiBase, tokenStore } from './_server_bridge';
import { withCommonHeaders } from '../api_common';
import { getLanguage } from '../config';
import { normalizeLang } from '../../i18n';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { fetchWithTimeout } from '../../util/abort';
import { broadcastOAuthConnectProgress } from './oauth-events';
import { LOCAL_API_REDIRECT_URI } from './oauth-redirect';
export { LOCAL_API_REDIRECT_URI } from './oauth-redirect';
import type { CatalogEntry, DcrClientCredentials, OAuthGrant, Transport } from './types';

const log = createLogger('connectors:oauth-dcr');

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

// Presentation-only locale envelope. The relay never treats it as authorization;
// PC still validates the entire opaque state. Keep the registered redirect URI unchanged.
function _localizedState(): string {
  return `orkas1_${normalizeLang(getLanguage()) || 'en'}_${_b64url(crypto.randomBytes(32))}`;
}
const DCR_HTTP_TIMEOUT_MS = 60_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CLIENT_NAME = 'Orkas';

interface PendingDcrFlow {
  kind: 'dcr';
  callbackStarted?: boolean;
  catalogId: string;
  attemptId?: string;
  state: string;            // CSRF token — match incoming deep link
  codeVerifier: string;     // PKCE
  redirectUri: string;
  resource: string;         // RFC 8707 canonical resource URI
  client: DcrClientCredentials;
  resolve: (out: { grant: OAuthGrant; client: DcrClientCredentials }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingLocalApiFlow {
  kind: 'local_api';
  callbackStarted?: boolean;
  catalogId: string;
  state: string;
  relayBase: string;
  attemptId?: string;
  exchange: (code: string) => Promise<Record<string, unknown>>;
  resolve: (credentials: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let _pending: PendingDcrFlow | PendingLocalApiFlow | null = null;
let _startGeneration = 0;

export function cancelDcrOAuth(): boolean {
  _startGeneration++;
  if (!_pending) return false;
  const pending = _pending;
  _pending = null;
  clearTimeout(pending.timer);
  pending.reject(Object.assign(new Error('Authorization cancelled'), { code: 'user_cancelled' }));
  return true;
}

export function startLocalApiBrowserOAuth(
  catalogId: string,
  buildAuthorizeUrl: (state: string, redirectUri: string) => string,
  exchange: (code: string) => Promise<Record<string, unknown>>,
  opts: { attemptId?: string } = {},
): Promise<Record<string, unknown>> {
  return _startLocalApiAuthorization(catalogId, exchange, opts, buildAuthorizeUrl);
}

/** Self-use grants share cancellation/late-result protection without opening a browser. */
export function startLocalApiCredentialAuthorization(
  catalogId: string,
  authorize: () => Promise<Record<string, unknown>>,
  opts: { attemptId?: string } = {},
): Promise<Record<string, unknown>> {
  return _startLocalApiAuthorization(catalogId, authorize, opts);
}

function _startLocalApiAuthorization(
  catalogId: string,
  exchange: (code: string) => Promise<Record<string, unknown>>,
  opts: { attemptId?: string },
  buildAuthorizeUrl?: (state: string, redirectUri: string) => string,
): Promise<Record<string, unknown>> {
  cancelDcrOAuth();
  const state = _localizedState();
  const authorizeUrl = buildAuthorizeUrl?.(state, LOCAL_API_REDIRECT_URI);
  return new Promise((resolve, reject) => {
    const pending: PendingLocalApiFlow = {
      kind: 'local_api', catalogId, state, relayBase: 'https://orkas.ai/api', exchange, resolve, reject,
      ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
      timer: setTimeout(() => {
        if (_pending === pending) _cancelPending('Authorization timed out; connect again');
      }, FLOW_TIMEOUT_MS),
    };
    pending.timer.unref?.();
    _pending = pending;
    if (!authorizeUrl) {
      pending.callbackStarted = true;
      if (opts.attemptId) broadcastOAuthConnectProgress({ attempt_id: opts.attemptId, catalog_id: catalogId });
      Promise.resolve().then(() => {
        if (_pending !== pending) throw new Error('Authorization cancelled');
        return exchange('');
      }).then((credentials) => {
        if (_pending !== pending) return;
        _pending = null;
        clearTimeout(pending.timer);
        resolve(credentials);
      }, (error) => {
        if (_pending !== pending) return;
        _pending = null;
        clearTimeout(pending.timer);
        reject(error);
      });
      return;
    }
    shell.openExternal(authorizeUrl).catch(() => {
      if (_pending === pending) _cancelPending('Could not open the authorization page; connect again');
    });
  });
}

function _cancelPending(reason: string): void {
  if (!_pending) return;
  const p = _pending;
  _pending = null;
  clearTimeout(p.timer);
  p.reject(new Error(reason));
}

// ── Discovery + DCR ─────────────────────────────────────────────────────

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
  resource?: string | string[];
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** Format `fetch` errors without copying provider URLs or response content into diagnostics.
 *  Account-scoped MCP providers can embed a tenant id in the host, while provider errors can
 *  contain OAuth material. Keep only bounded transport metadata that is safe to surface. */
function _fmtFetchErr(label: string, err: unknown): Error {
  const e = err as Error & { cause?: unknown };
  const cause = e?.cause as { code?: string; errno?: string } | undefined;
  const parts: string[] = [];
  if (label) parts.push(label);
  if (e?.name) parts.push(`name=${e.name}`);
  if (cause) {
    if (cause.code) parts.push(`code=${cause.code}`);
    if (cause.errno) parts.push(`errno=${cause.errno}`);
  }
  return new Error(parts.join(' | ') || 'DCR request failed');
}

function _fetchDcr(label: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(
    url,
    init,
    DCR_HTTP_TIMEOUT_MS,
    undefined,
    `${label} timed out after ${Math.round(DCR_HTTP_TIMEOUT_MS / 1000)}s`,
  );
}

/** Fetch `<base>/.well-known/<name>`, falling back to root-level discovery if path-suffixed
 *  fails (per MCP authorization spec — providers can serve discovery at either location). */
async function _fetchWellKnown<T>(mcpUrl: string, wellKnownName: string): Promise<T> {
  const url = new URL(mcpUrl);
  // Path-suffixed first (e.g. https://mcp.notion.com/mcp/.well-known/oauth-protected-resource),
  // then root well-known with the MCP path appended (e.g. Atlassian's
  // https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2).
  const candidates: string[] = [];
  const trimmed = url.pathname.replace(/\/+$/, '');
  if (trimmed) candidates.push(`${url.origin}${trimmed}/.well-known/${wellKnownName}`);
  if (trimmed) candidates.push(`${url.origin}/.well-known/${wellKnownName}${trimmed}`);
  candidates.push(`${url.origin}/.well-known/${wellKnownName}`);
  let lastErr: Error | null = null;
  for (const cand of Array.from(new Set(candidates))) {
    try {
      const r = await _fetchDcr(`DCR ${wellKnownName}`, cand);
      if (r.ok) return await r.json() as T;
      lastErr = new Error(`DCR ${wellKnownName} metadata HTTP ${r.status}`);
    } catch (err) {
      lastErr = _fmtFetchErr(`DCR ${wellKnownName} metadata fetch failed`, err);
    }
  }
  throw lastErr || new Error(`failed to fetch ${wellKnownName}`);
}

async function _fetchAuthServerMetadata(authServer: string, mcpUrl: string): Promise<AuthServerMetadata> {
  const url = new URL(authServer);
  const trimmed = url.pathname.replace(/\/+$/, '');
  const mcp = new URL(mcpUrl);
  const candidates = Array.from(new Set([
    ...(trimmed ? [`${url.origin}${trimmed}/.well-known/oauth-authorization-server`] : []),
    `${url.origin}/.well-known/oauth-authorization-server`,
    `${mcp.origin}/.well-known/oauth-authorization-server`,
  ]));
  let lastErr: Error | null = null;
  for (const cand of candidates) {
    let r: Response;
    try {
      r = await _fetchDcr('DCR auth server metadata', cand);
    } catch (err) {
      lastErr = _fmtFetchErr('DCR auth server metadata fetch failed', err);
      continue;
    }
    if (r.ok) return await r.json() as AuthServerMetadata;
    lastErr = new Error(`auth server metadata HTTP ${r.status}`);
  }
  throw lastErr || new Error('failed to fetch auth server metadata');
}

async function _discoverAuthServer(mcpUrl: string): Promise<{ meta: AuthServerMetadata; resource: string }> {
  const prm = await _fetchWellKnown<ProtectedResourceMetadata>(mcpUrl, 'oauth-protected-resource');
  const authServer = prm.authorization_servers?.[0];
  if (!authServer) throw new Error('protected resource metadata missing authorization_servers');
  // RFC 8707 resource indicator — the canonical resource URI from PRM. Required by the MCP
  // authorization spec on every authorize / token / refresh request, otherwise the issued
  // access_token isn't audience-bound to this MCP server and the server rejects it with
  // `invalid_token` at the first protected request. PRM is authoritative; fall back to
  // mcpUrl origin only when PRM omits the field (shouldn't happen per spec).
  const resource = Array.isArray(prm.resource) ? prm.resource[0] : prm.resource;
  const meta = await _fetchAuthServerMetadata(authServer, mcpUrl);
  return { meta, resource: resource || new URL(mcpUrl).origin };
}

type DcrTokenAuthMethod = NonNullable<DcrClientCredentials['token_endpoint_auth_method']>;

function _chooseTokenAuthMethod(meta: AuthServerMetadata): DcrTokenAuthMethod {
  const supported = Array.isArray(meta.token_endpoint_auth_methods_supported)
    ? meta.token_endpoint_auth_methods_supported
    : ['client_secret_post'];
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('none')) return 'none';
  throw new Error(`provider does not support a compatible token_endpoint_auth_method: ${supported.join(',')}`);
}

function _basicAuthValue(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function _tokenAuthMethod(client: DcrClientCredentials): DcrTokenAuthMethod {
  return client.token_endpoint_auth_method || 'client_secret_post';
}

function _buildTokenRequest(
  client: DcrClientCredentials,
  params: Record<string, string>,
): { body: URLSearchParams; headers: Record<string, string> } {
  const method = _tokenAuthMethod(client);
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (method === 'client_secret_basic') {
    if (!client.client_secret) throw new Error('client_secret_basic requires client_secret');
    headers.Authorization = _basicAuthValue(client.client_id, client.client_secret);
  } else {
    body.set('client_id', client.client_id);
    if (method === 'client_secret_post' && client.client_secret) {
      body.set('client_secret', client.client_secret);
    }
  }
  return { body, headers };
}

async function _registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  tokenEndpointAuthMethod: DcrTokenAuthMethod,
): Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method?: string }> {
  let r: Response;
  try {
    r = await _fetchDcr('DCR client registration', registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      }),
    });
  } catch (err) {
    throw _fmtFetchErr('DCR client registration fetch failed', err);
  }
  if (!r.ok) {
    throw new Error(`DCR registration failed: HTTP ${r.status}`);
  }
  return await r.json() as { client_id: string; client_secret?: string; token_endpoint_auth_method?: string };
}

// ── PKCE ───────────────────────────────────────────────────────────────

function _b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function _genPkce(): { verifier: string; challenge: string } {
  const verifier = _b64url(crypto.randomBytes(32));
  const challenge = _b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── Public API ─────────────────────────────────────────────────────────

/** Run the full DCR + OAuth flow. Returns the resulting grant **and** the DCR client
 *  credentials (caller must persist these — refresh uses them). */
export async function startMcpDcrOAuth(
  _uid: string,
  entry: CatalogEntry,
  opts: { attemptId?: string } = {},
): Promise<{ grant: OAuthGrant; client: DcrClientCredentials }> {
  if (!entry.transport_template || entry.transport_template.kind !== 'streamable-http') {
    throw new Error('DCR flow only supports streamable-http transports');
  }
  _cancelPending('superseded by a new DCR start');
  const generation = ++_startGeneration;

  const mcpUrl = entry.transport_template.url;
  log.info('DCR flow starting', { catalog_id: entry.id });

  // Discover endpoints.
  const { meta, resource } = await _discoverAuthServer(mcpUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`provider ${entry.id} does not advertise registration_endpoint — DCR unsupported`);
  }
  const tokenEndpointAuthMethod = _chooseTokenAuthMethod(meta);
  log.info('DCR endpoints discovered', {
    catalog_id: entry.id,
    has_registration_endpoint: true,
    has_resource: !!resource,
    token_auth: tokenEndpointAuthMethod,
  });

  // Register with the same Server environment that will exchange the callback.
  // Source and packaged builds both use the production bridge.
  const redirectUri = `${accountApiBase().replace(/\/+$/, '')}/connectors/oauth/dcr-callback`;
  const registered = await _registerClient(meta.registration_endpoint, redirectUri, tokenEndpointAuthMethod);
  if (generation !== _startGeneration) throw Object.assign(new Error('Authorization superseded'), { code: 'user_cancelled' });
  log.info('DCR registration done', { catalog_id: entry.id });

  const registeredTokenAuthMethod = registered.token_endpoint_auth_method === 'client_secret_basic'
    || registered.token_endpoint_auth_method === 'client_secret_post'
    || registered.token_endpoint_auth_method === 'none'
    ? registered.token_endpoint_auth_method
    : tokenEndpointAuthMethod;
  const dcrClient: DcrClientCredentials = {
    client_id: registered.client_id,
    ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
    token_endpoint_auth_method: registeredTokenAuthMethod,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
    resource,
  };

  // Build authorize URL.
  const state = _localizedState();
  const pkce = _genPkce();
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', registered.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', resource);

  log.info('opening DCR authorize URL', { catalog_id: entry.id });

  return new Promise<{ grant: OAuthGrant; client: DcrClientCredentials }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (_pending === pending) _cancelPending('DCR flow timed out');
    }, FLOW_TIMEOUT_MS);
    timer.unref?.();
    const pending: PendingDcrFlow = {
      kind: 'dcr',
      catalogId: entry.id,
      ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
      state,
      codeVerifier: pkce.verifier,
      redirectUri,
      resource,
      client: dcrClient,
      resolve,
      reject,
      timer,
    };
    _pending = pending;
    shell.openExternal(authUrl.toString()).catch((err) => {
      if (_pending === pending) _cancelPending(`failed to open browser: ${(err as Error).message}`);
    });
  });
}

/** Called by the protocol handler when `orkas://connectors/oauth/dcr-callback?...` arrives. */
export async function handleDcrCallbackUrl(rawUrl: string): Promise<void> {
  log.info('DCR callback received');
  if (!_pending) {
    log.warn('DCR callback arrived with no pending flow');
    return;
  }
  const pending = _pending;
  if (pending.callbackStarted) return;
  let url: URL;
  try { url = new URL(rawUrl); } catch (err) {
    _cancelPending(`malformed DCR callback: ${(err as Error).message}`);
    return;
  }
  const status = url.searchParams.get('status');
  const reason = url.searchParams.get('reason') || '';
  if (status === 'cancelled') { cancelDcrOAuth(); return; }
  if (status === 'error') { _cancelPending(`server error: ${reason || 'unknown'}`); return; }
  const exchangeCode = url.searchParams.get('exchange_code');
  if (!exchangeCode) { _cancelPending('missing exchange_code'); return; }
  pending.callbackStarted = true;
  if (pending.attemptId) {
    broadcastOAuthConnectProgress({
      attempt_id: pending.attemptId,
      catalog_id: pending.catalogId,
    });
  }

  // Pull {oauth_code, oauth_state} from Server. Server uses the namespaced keys (not bare
  // `code`/`state`) because `json_response` spreads data flat — a bare `code` key would
  // collide with the response status `code` field. See Server `api/connectors.py` comment.
  let payload: { code: string; state: string };
  try {
    const relayBase = pending.kind === 'local_api' ? pending.relayBase : accountApiBase();
    const res = await _fetchDcr('DCR exchange', `${relayBase}/connectors/oauth/dcr-exchange`, {
      method: 'POST',
      headers: withCommonHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify({ exchange_code: exchangeCode, device_id: tokenStore.getDeviceId() }),
    });
    if (!res.ok) throw new Error(`/dcr-exchange HTTP ${res.status}`);
    const body = await res.json() as {
      code: number;       // status — 0 = ok
      msg?: string;
      oauth_code?: string;
      oauth_state?: string;
    };
    if (body.code !== 0 || !body.oauth_code || !body.oauth_state) {
      throw new Error(body.msg || 'dcr exchange response invalid');
    }
    payload = { code: body.oauth_code, state: body.oauth_state };
  } catch (err) {
    if (_pending === pending) _cancelPending(`dcr exchange failed: ${_fmtFetchErr('', err).message}`);
    return;
  }

  if (_pending !== pending) return;

  // Validate state.
  if (payload.state !== pending.state) {
    _cancelPending('state mismatch (CSRF guard)');
    return;
  }

  if (pending.kind === 'local_api') {
    try {
      const credentials = await pending.exchange(payload.code);
      if (_pending !== pending) return;
      _pending = null;
      clearTimeout(pending.timer);
      pending.resolve(credentials);
    } catch (error) {
      if (_pending !== pending) return;
      _pending = null;
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error('Shop authorization failed'));
    }
    return;
  }

  // Exchange code for tokens against provider's token endpoint.
  try {
    const tokenReq = _buildTokenRequest(pending.client, {
      grant_type: 'authorization_code',
      code: payload.code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
      resource: pending.resource,
    });
    const res = await _fetchDcr('DCR token exchange', pending.client.token_endpoint, {
      method: 'POST',
      headers: tokenReq.headers,
      body: tokenReq.body.toString(),
    });
    if (!res.ok) {
      throw new Error(`token endpoint HTTP ${res.status}`);
    }
    const tokens = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    if (_pending !== pending) return;
    if (!tokens.access_token) throw new Error('token response missing access_token');
    const expires_at = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null;
    const localGrant: OAuthGrant = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at,
      scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : [],
      token_type: tokens.token_type || 'Bearer',
    };
    if (_pending !== pending) return;
    _pending = null;
    clearTimeout(pending.timer);
    log.info('DCR grant resolved', {
      catalog_id: pending.catalogId,
      has_refresh: !!localGrant.refresh_token,
      expires_in: tokens.expires_in ?? null,
    });
    pending.resolve({ grant: localGrant, client: pending.client });
  } catch (err) {
    if (_pending === pending) _cancelPending(`token exchange failed: ${_fmtFetchErr('', err).message}`);
  }
}

/** Refresh a DCR-issued access_token. Called by manager before reconnect when expires_at is
 *  near. */
export async function refreshDcrIfStale(
  client: DcrClientCredentials,
  grant: OAuthGrant,
  opts: { force?: boolean } = {},
): Promise<OAuthGrant> {
  if (!opts.force && !grant.expires_at) return grant;
  if (!opts.force && grant.expires_at - Date.now() > REFRESH_BUFFER_MS) return grant;
  if (!grant.refresh_token) {
    throw new Error('access_token expired and no refresh_token available; reconnect required');
  }
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: grant.refresh_token,
  };
  if (client.resource) params.resource = client.resource;
  const tokenReq = _buildTokenRequest(client, params);
  let res: Response;
  try {
    res = await _fetchDcr('DCR token refresh', client.token_endpoint, {
      method: 'POST',
      headers: tokenReq.headers,
      body: tokenReq.body.toString(),
    });
  } catch (err) {
    throw _fmtFetchErr('DCR token refresh fetch failed', err);
  }
  if (!res.ok) {
    throw new Error(`DCR refresh HTTP ${res.status}`);
  }
  const tokens = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (!tokens.access_token) throw new Error('DCR refresh response missing access_token');
  const expires_at = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null;
  return {
    access_token: tokens.access_token,
    // Notion (and others) rotate refresh_token on every refresh — using the old one again
    // invalidates the new. Replace if the response carries a new one; fall back to the prior
    // only when the server omitted it (some providers do that for non-rotating refresh).
    refresh_token: tokens.refresh_token || grant.refresh_token,
    expires_at,
    scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : grant.scopes,
    token_type: tokens.token_type || grant.token_type || 'Bearer',
    ...(grant.account_label ? { account_label: grant.account_label } : {}),
  };
}
