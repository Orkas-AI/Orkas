/**
 * MCP-spec OAuth (Dynamic Client Registration) client.
 *
 * For providers that host their own OAuth authorization server per the MCP authorization spec
 * (Notion, Atlassian, Cloudflare suite, …). Orkas has no pre-registered OAuth App at the
 * provider — PC self-registers at first connect via DCR (RFC 7591), holds its own client_id /
 * client_secret per-instance, drives the full OAuth handshake from the PC side.
 *
 * The Server-bridge in `oauth.ts` handles a different class of providers (GitHub Copilot MCP
 * today) where Orkas registered an OAuth App and Server holds the secret. The two flows live
 * side-by-side and `manager.ts::connectViaOAuth` dispatches by `catalog.auth_mode`.
 *
 * Server's only role in the DCR path: serve `/api/connectors/oauth/dcr-callback` as a stable
 * HTTPS redirect_uri (DCR clients must declare one at registration), stash the {code, state}
 * pair under a one-time exchange_code, deep-link back to PC. The token POST is done from PC
 * directly against the provider's `token_endpoint` using the DCR-issued credentials.
 *
 * **Why not localhost listener (RFC 8252 native-app pattern)**: PC/CLAUDE.md §1 bans HTTP
 * server in main process. Server-bridge callback gets us a stable, registered HTTPS URI
 * (`orkas.ai/...`) at the cost of one additional KV roundtrip — fair trade.
 */
import * as crypto from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { shell } from 'electron';

import { getLanguage } from '../config';
import { createLogger } from '../../logger';
import { accountApiBase, tokenStore } from './_server_bridge';
import type { CatalogEntry, DcrClientCredentials, OAuthGrant, Transport } from './types';

const log = createLogger('connectors:oauth-dcr');

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CLIENT_NAME = 'Orkas';

interface PendingDcrFlow {
  catalogId: string;
  state: string;            // CSRF token — match incoming deep link
  codeVerifier: string;     // PKCE
  redirectUri: string;
  resource: string;         // RFC 8707 canonical resource URI
  client: DcrClientCredentials;
  resolve: (out: { grant: OAuthGrant; client: DcrClientCredentials }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let _pending: PendingDcrFlow | null = null;

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
  resource?: string;
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  // others not relevant here
}

/** Format `fetch` errors so the underlying cause (DNS / TLS / refused / …) surfaces in logs.
 *  Node undici flattens every transport-level failure to `TypeError: fetch failed` with the
 *  real reason hung off `err.cause`; logging just `err.message` loses the diagnostic. */
function _fmtFetchErr(label: string, err: unknown): Error {
  const e = err as Error & { cause?: unknown };
  const cause = e?.cause as { code?: string; errno?: string; message?: string } | undefined;
  const parts: string[] = [];
  if (label) parts.push(label);
  parts.push(e?.message || String(err));
  if (cause) {
    if (cause.code) parts.push(`code=${cause.code}`);
    if (cause.errno) parts.push(`errno=${cause.errno}`);
    if (cause.message && cause.message !== e?.message) parts.push(`cause=${cause.message}`);
  }
  return new Error(parts.join(' | '));
}

/** Fetch `<base>/.well-known/<name>`, falling back to root-level discovery if path-suffixed
 *  fails (per MCP authorization spec — providers can serve discovery at either location). */
async function _fetchWellKnown<T>(mcpUrl: string, wellKnownName: string): Promise<T> {
  const url = new URL(mcpUrl);
  // Path-suffixed first (e.g. https://mcp.notion.com/mcp/.well-known/oauth-protected-resource).
  const candidates: string[] = [];
  const trimmed = url.pathname.replace(/\/+$/, '');
  if (trimmed) candidates.push(`${url.origin}${trimmed}/.well-known/${wellKnownName}`);
  candidates.push(`${url.origin}/.well-known/${wellKnownName}`);
  let lastErr: Error | null = null;
  for (const cand of candidates) {
    try {
      const r = await fetch(cand);
      if (r.ok) return await r.json() as T;
      lastErr = new Error(`${cand} → HTTP ${r.status}`);
    } catch (err) {
      lastErr = _fmtFetchErr(`${cand} fetch failed`, err);
    }
  }
  throw lastErr || new Error(`failed to fetch ${wellKnownName}`);
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
  const resource = prm.resource || new URL(mcpUrl).origin;
  const asUrl = new URL('/.well-known/oauth-authorization-server', authServer).toString();
  let r: Response;
  try {
    r = await fetch(asUrl);
  } catch (err) {
    throw _fmtFetchErr(`${asUrl} fetch failed`, err);
  }
  if (!r.ok) throw new Error(`auth server metadata HTTP ${r.status}`);
  const meta = await r.json() as AuthServerMetadata;
  return { meta, resource };
}

async function _registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string }> {
  let r: Response;
  try {
    r = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
  } catch (err) {
    throw _fmtFetchErr(`${registrationEndpoint} fetch failed`, err);
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`DCR registration failed: ${r.status} ${text}`);
  }
  return await r.json() as { client_id: string; client_secret?: string };
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
): Promise<{ grant: OAuthGrant; client: DcrClientCredentials }> {
  if (!entry.transport_template || entry.transport_template.kind !== 'streamable-http') {
    throw new Error('DCR flow only supports streamable-http transports');
  }
  _cancelPending('superseded by a new DCR start');

  const mcpUrl = entry.transport_template.url;
  log.info('DCR flow starting', { catalog_id: entry.id, mcp_url: mcpUrl });

  // Discover endpoints.
  const { meta, resource } = await _discoverAuthServer(mcpUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`provider ${entry.id} does not advertise registration_endpoint — DCR unsupported`);
  }
  log.info('DCR endpoints discovered', {
    auth_url: meta.authorization_endpoint,
    token_url: meta.token_endpoint,
    reg_url: meta.registration_endpoint,
    resource,
  });

  // Register client. The redirect_uri must point at our Server's `/connectors/oauth/dcr-callback`
  // endpoint, which is environment-dependent (`accountApiBase()` resolves to the dev or prod
  // Server URL per `OAUTH_REDIRECT_BASE` / debug-mode rules). DCR registers whichever URL we
  // declare with the provider, so dev (127.0.0.1) and prod (orkas.ai) just work side-by-side
  // — each ConnectorInstance carries its own dcr_client tied to whichever env it was installed
  // under. (A dev-mode install does NOT migrate to prod automatically; the user would
  // reconnect.)
  const redirectUri = `${accountApiBase().replace(/\/+$/, '')}/connectors/oauth/dcr-callback`;
  const registered = await _registerClient(meta.registration_endpoint, redirectUri);
  log.info('DCR registration done', { client_id_tail: registered.client_id.slice(-6) });

  const dcrClient: DcrClientCredentials = {
    client_id: registered.client_id,
    ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
    resource,
  };

  // Build authorize URL.
  const state = _b64url(crypto.randomBytes(16));
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
    const timer = setTimeout(() => _cancelPending('DCR flow timed out'), FLOW_TIMEOUT_MS);
    timer.unref?.();
    _pending = {
      catalogId: entry.id,
      state,
      codeVerifier: pkce.verifier,
      redirectUri,
      resource,
      client: dcrClient,
      resolve,
      reject,
      timer,
    };
    shell.openExternal(authUrl.toString()).catch((err) => {
      _cancelPending(`failed to open browser: ${(err as Error).message}`);
    });
  });
}

/** Called by the protocol handler when `orkas://connectors/oauth/dcr-callback?...` arrives. */
export async function handleDcrCallbackUrl(rawUrl: string): Promise<void> {
  log.info('DCR callback url received', { path: rawUrl.split('?')[0] });
  if (!_pending) {
    log.warn('DCR callback arrived with no pending flow');
    return;
  }
  const pending = _pending;
  let url: URL;
  try { url = new URL(rawUrl); } catch (err) {
    _cancelPending(`malformed DCR callback: ${(err as Error).message}`);
    return;
  }
  const status = url.searchParams.get('status');
  const reason = url.searchParams.get('reason') || '';
  if (status === 'cancelled') { _cancelPending('user cancelled at provider'); return; }
  if (status === 'error') { _cancelPending(`server error: ${reason || 'unknown'}`); return; }
  const exchangeCode = url.searchParams.get('exchange_code');
  if (!exchangeCode) { _cancelPending('missing exchange_code'); return; }

  // Pull {oauth_code, oauth_state} from Server. Server uses the namespaced keys (not bare
  // `code`/`state`) because `json_response` spreads data flat — a bare `code` key would
  // collide with the response status `code` field. See Server `api/connectors.py` comment.
  let payload: { code: string; state: string };
  try {
    const res = await fetch(`${accountApiBase()}/connectors/oauth/dcr-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
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
    _cancelPending(`dcr exchange failed: ${_fmtFetchErr('', err).message}`);
    return;
  }

  // Validate state.
  if (payload.state !== pending.state) {
    _cancelPending('state mismatch (CSRF guard)');
    return;
  }

  // Exchange code for tokens against provider's token endpoint.
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: payload.code,
      redirect_uri: pending.redirectUri,
      client_id: pending.client.client_id,
      code_verifier: pending.codeVerifier,
      resource: pending.resource,
    });
    if (pending.client.client_secret) body.set('client_secret', pending.client.client_secret);
    const res = await fetch(pending.client.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`token endpoint HTTP ${res.status}: ${text}`);
    }
    const tokens = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    if (!tokens.access_token) throw new Error('token response missing access_token');
    const expires_at = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null;
    const grant: OAuthGrant = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at,
      scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : [],
      token_type: tokens.token_type || 'Bearer',
    };
    _pending = null;
    clearTimeout(pending.timer);
    log.info('DCR grant resolved', {
      catalog_id: pending.catalogId,
      has_refresh: !!grant.refresh_token,
      expires_in: tokens.expires_in ?? null,
    });
    pending.resolve({ grant, client: pending.client });
  } catch (err) {
    _cancelPending(`token exchange failed: ${_fmtFetchErr('', err).message}`);
  }
}

/** Refresh a DCR-issued access_token. Called by manager before reconnect when expires_at is
 *  near. */
export async function refreshDcrIfStale(
  client: DcrClientCredentials,
  grant: OAuthGrant,
): Promise<OAuthGrant> {
  if (!grant.expires_at) return grant;
  if (grant.expires_at - Date.now() > REFRESH_BUFFER_MS) return grant;
  if (!grant.refresh_token) {
    throw new Error('access_token expired and no refresh_token available; reconnect required');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: grant.refresh_token,
    client_id: client.client_id,
  });
  if (client.resource) body.set('resource', client.resource);
  if (client.client_secret) body.set('client_secret', client.client_secret);
  let res: Response;
  try {
    res = await fetch(client.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw _fmtFetchErr(`${client.token_endpoint} fetch failed`, err);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DCR refresh HTTP ${res.status}: ${text}`);
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
