/**
 * Connector manager — process-level singleton holding live MCP client connections.
 *
 * On boot: read the registry and reuse persisted tool schemas for healthy instances. Only rows
 * that need first-time discovery, catalog-cache refresh, or state repair are connected. A real
 * tool call reconnects its one instance on demand. On shutdown: close live connections cleanly
 * so stdio subprocesses exit instead of leaking. Tool calls route here from the AgentRunner's
 * meta-tools via `tools-adapter.ts`.
 *
 * Every instance uses OAuth — there is no API-key path. The `connectViaOAuth` entry point runs
 * the full PKCE/browser/code-exchange flow, persists the grant, applies the catalog's transport
 * template (which substitutes the fresh access_token into env / headers), and brings the live
 * MCP connection up. Tokens are lazily refreshed at boot / refresh-tools / reconnect; mid-call
 * expiry surfaces as a tool error and the user re-clicks "刷新工具".
 */
import * as crypto from 'node:crypto';

import * as registry from './registry';
import { McpConnection } from './mcp-client';
import { findCatalogEntry } from './catalog';
import { applyTemplate } from './apply-template';
import { assertConnectorRuntimeEnabled, isConnectorRuntimeEnabled } from './availability';
import { startOAuth, refreshIfStale, startGoogleSheetsPicker } from './oauth';
import { startMcpDcrOAuth, refreshDcrIfStale } from './oauth-dcr';
import { createLogger } from '../../logger';
import { deriveCustomId, validateCustomTransport, validateDisplayName, type CustomConnectorInput } from './custom-transport';
import { isConnectorUsable } from './types';
import type { CatalogEntry, ConnectorInstance, OAuthGrant, ToolSchema, Transport } from './types';

const log = createLogger('connectors:manager');

const _conns = new Map<string, McpConnection>();
const _verifyLocks = new Map<string, Promise<number>>();
const _onDemandConnectLocks = new Map<string, Promise<McpConnection>>();
let _bootedFor: string | null = null;

/** Per-instance in-flight refresh dedupe. **Why:** OAuth refresh_tokens (GitHub App `ghr_*`,
 *  Notion DCR, etc.) ROTATE on every successful exchange — the old token is invalidated the
 *  moment the provider issues a new one. Two concurrent `_resolveTransport` calls (e.g. two
 *  parallel `call_connector_tool` invocations from one model turn, or `bootstrap` racing with
 *  a user-triggered tool call) would both POST the SAME stale refresh_token; the first wins
 *  and rotates → the second hits `bad_refresh_token` → its catch branch writes
 *  `status:error` → the connector is permanently broken until the user re-authorizes. The
 *  Map<instanceId, Promise<OAuthGrant>> coalesces concurrent callers onto a single in-flight
 *  request; subsequent calls await the same Promise, get the same new grant, and proceed
 *  identically. Lock entries auto-clear in the `finally` block so a failed refresh doesn't
 *  jam the slot. */
const _refreshLocks = new Map<string, Promise<OAuthGrant>>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CONNECT_RETRY_DELAY_MS = 500;
const BOOTSTRAP_CONNECT_CONCURRENCY = 3;
const VERIFY_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 30 * 60 * 1000;

type StatusPatchCollector = Map<string, registry.ConnectorInstancePatch[]>;

async function _runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function _now(): number { return Date.now(); }
function _nowIso(): string { return new Date().toISOString(); }
function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Non-reversible token fingerprint for diagnostic logs. Twelve SHA-256 hex chars are enough
 *  to correlate PC + Server events without leaking a usable token prefix. */
function _tokPrefix(t: string | null | undefined): string {
  if (!t) return 'none';
  return crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
}

function _missingRequiredScopes(entry: CatalogEntry, grant: OAuthGrant | undefined): string[] {
  const required = Array.isArray(entry.required_oauth_scopes) ? entry.required_oauth_scopes : [];
  if (!required.length || !grant) return [];
  if (!Array.isArray(grant.scopes)) return required.slice();
  const granted = new Set(grant.scopes.filter(Boolean));
  return required.filter((scope) => !granted.has(scope));
}

function _storedAuthorizationProblem(inst: ConnectorInstance): { message: string; reason: string } | null {
  const entry = findCatalogEntry(inst.id);
  if (!entry) return null;
  if (inst.auth_error?.message) {
    return {
      message: inst.auth_error.message,
      reason: inst.auth_error.reason || inst.auth_error.code || 'authorization_error',
    };
  }
  const statusError = inst.status?.kind === 'error' ? inst.status.message : '';
  if (statusError && _isGoogleAuthFailure(entry, statusError)) {
    return { message: statusError, reason: 'google_auth_error' };
  }
  if (statusError && _isStickyDcrAuthStatus(entry, statusError)) {
    return { message: statusError, reason: 'dcr_auth_error' };
  }
  return null;
}

function _hasStatusError(inst: ConnectorInstance, message: string): boolean {
  return inst.status?.kind === 'error' && inst.status.message === message;
}

function _hasMissingRequiredScopes(inst: ConnectorInstance): boolean {
  const entry = findCatalogEntry(inst.id);
  return !!entry && _missingRequiredScopes(entry, inst.oauth_grant).length > 0;
}

function _isMissingRequiredScopesError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const msg = (err as Error | null)?.message || String(err || '');
  return code === 'missing_required_scopes' || /missing_required_scopes|missing required scopes/i.test(msg);
}

function _connectorErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function _connectorRetryable(err: unknown): boolean | null {
  const retryable = (err as { retryable?: unknown } | null)?.retryable;
  return typeof retryable === 'boolean' ? retryable : null;
}

function _isGoogleEntry(entry: CatalogEntry): boolean {
  return entry.oauth?.provider_id === 'google';
}

function _isGitHubEntry(entry: CatalogEntry): boolean {
  return entry.oauth?.provider_id === 'github';
}

function _isGoogleAuthFailure(entry: CatalogEntry, err: unknown): boolean {
  if (!_isGoogleEntry(entry)) return false;
  if (_isMissingRequiredScopesError(err)) return true;
  const code = _connectorErrorCode(err);
  if (code === 'connector_reconnect_required') return true;
  if (code === 'connector_refresh_failed') return false;
  const msg = (err as Error | null)?.message || String(err || '');
  return /refresh HTTP\s+4\d\d|invalid refresh response|access_token expired|no oauth_grant|transport unresolved|connector_unauthorized/i.test(msg);
}

function _isDcrAuthFailure(entry: CatalogEntry, err: unknown): boolean {
  if (entry.auth_mode !== 'mcp_dcr') return false;
  const code = _connectorErrorCode(err);
  if (code === 'connector_reconnect_required') return true;
  if (code === 'connector_refresh_failed') return false;
  const msg = (err as Error | null)?.message || String(err || '');
  return /DCR refresh HTTP\s+4\d\d|invalid_grant|connector_reconnect_required|access_token expired|no oauth_grant|transport unresolved/i.test(msg);
}

function _isStickyDcrAuthStatus(entry: CatalogEntry, err: unknown): boolean {
  if (entry.auth_mode !== 'mcp_dcr') return false;
  const code = _connectorErrorCode(err);
  if (code === 'connector_reconnect_required') return true;
  if (code === 'connector_refresh_failed') return false;
  const msg = (err as Error | null)?.message || String(err || '');
  return /DCR refresh HTTP\s+4\d\d|invalid_grant|connector_reconnect_required|access_token expired|no oauth_grant|reconnect required|授权已失效|Authorization expired/i.test(msg);
}

function _isTransientConnectorFailure(err: unknown): boolean {
  const code = _connectorErrorCode(err);
  const retryable = _connectorRetryable(err);
  if (code === 'connector_reconnect_required') return false;
  if (code === 'connector_refresh_failed') return retryable !== false;
  if (retryable === true) return true;
  if (retryable === false) return false;
  const msg = (err as Error | null)?.message || String(err || '');
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound|socket|connection (closed|reset|dropped)|terminated/i.test(msg)) {
    return true;
  }
  // Generic bridge refresh failures are not proof that the user's grant is dead;
  // explicit reconnect signals use connector_reconnect_required / invalid_grant wording.
  if (/\brefresh_failed\b|刷新授权失败|failed to refresh authorization|認証の更新に失敗|Falha ao atualizar a autorização/i.test(msg)) {
    return true;
  }
  // A 5xx from the connector OAuth bridge is a temporary service failure,
  // not evidence that the user's provider grant is invalid.
  return /refresh HTTP\s+5\d\d\b/i.test(msg);
}

function _hasEstablishedConnectorState(inst: ConnectorInstance): boolean {
  return inst.status?.kind === 'connected'
    || inst.status?.kind === 'degraded'
    || (Array.isArray(inst.tools_cache) && inst.tools_cache.length > 0);
}

function _isTransientStatusError(inst: ConnectorInstance): boolean {
  return inst.status?.kind === 'error' && _isTransientConnectorFailure(inst.status.message);
}

function _isUnknownCatalogInstance(inst: ConnectorInstance): boolean {
  return inst.origin !== 'custom' && !findCatalogEntry(inst.id);
}

function _isRecoverableTransportUnresolved(inst: ConnectorInstance): boolean {
  if (inst.status?.kind !== 'error' || !/transport unresolved/i.test(inst.status.message)) return false;
  if (inst.origin === 'custom') return false;
  const entry = findCatalogEntry(inst.id);
  return !!entry?.transport_template && !!inst.oauth_grant && _hasEstablishedConnectorState(inst);
}

function _lastVerifiedAt(inst: ConnectorInstance): number | undefined {
  if (inst.status?.kind === 'connected') return inst.status.since;
  if (inst.status?.kind === 'degraded') return inst.status.last_verified_at;
  return undefined;
}

function _consecutiveFailures(inst: ConnectorInstance): number {
  return inst.status?.kind === 'degraded' ? (inst.status.failures || 0) : 0;
}

function _retryAfterFor(failures: number): number {
  const step = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_BACKOFF_MAX_MS);
  const jitter = step * 0.2 * (Math.random() * 2 - 1);
  return _now() + Math.round(step + jitter);
}

function _asDegradedFromCache(inst: ConnectorInstance, message: string): ConnectorInstance {
  const failures = _consecutiveFailures(inst) + 1;
  return {
    ...inst,
    status: {
      kind: 'degraded',
      message,
      at: _now(),
      last_verified_at: _lastVerifiedAt(inst),
      failures,
      retry_after: _retryAfterFor(failures),
    },
  };
}

function _isInRetryCooldown(inst: ConnectorInstance): boolean {
  return inst.status?.kind === 'degraded' && (inst.status.retry_after || 0) > _now();
}

function _cooldownMessage(id: string, inst: ConnectorInstance): string {
  const status = inst.status?.kind === 'degraded' ? inst.status : null;
  const waitS = Math.ceil(Math.max(0, (status?.retry_after || 0) - _now()) / 1000);
  return `connector ${id} unavailable: ${status?.message || 'not verified'}`
    + ` (${status?.failures || 0} consecutive failures; not retrying for another ${waitS}s)`;
}

async function _markDegradedOnTransientFailure(
  uid: string,
  inst: ConnectorInstance,
  err: unknown,
  reason: string,
  statusPatches?: StatusPatchCollector,
): Promise<ConnectorInstance | null> {
  if (!_isTransientConnectorFailure(err) || !_hasEstablishedConnectorState(inst)) return null;
  const message = (err as Error).message;
  log.warn('connector degraded after transient failure; keeping grant and cached tools for retry', {
    id: inst.id,
    reason,
    error: message,
  });
  const current = registry.load(uid).connections[inst.id] || inst;
  return _patchStatus(uid, current, (cur) => ({
    ..._asDegradedFromCache(cur, message),
    updated_at: _nowIso(),
  }), statusPatches);
}

function _normalizeTransientStatusForList(inst: ConnectorInstance): ConnectorInstance {
  if (inst.status?.kind !== 'error') return inst;
  const recoverable = _isTransientStatusError(inst) || _isRecoverableTransportUnresolved(inst);
  if (!recoverable || !_hasEstablishedConnectorState(inst)) return inst;
  return {
    ...inst,
    status: {
      kind: 'degraded',
      message: inst.status.message,
      at: inst.status.at,
      last_verified_at: _lastVerifiedAt(inst),
    },
  };
}

async function _removeStoredInstance(uid: string, id: string, reason: string): Promise<void> {
  const conn = _conns.get(id);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  const removed = await registry.remove(uid, id);
  if (removed) log.info('removed connector instance', { id, reason });
}

async function _removeInstancesForCatalog(uid: string, entry: CatalogEntry, reason: string): Promise<void> {
  const ids = entry.bundle_member_ids?.length ? entry.bundle_member_ids : [entry.id];
  await Promise.all(ids.map((id) => _removeStoredInstance(uid, id, reason)));
}

async function _dropMissingScopeInstance(uid: string, inst: ConnectorInstance, reason: string): Promise<boolean> {
  const entry = findCatalogEntry(inst.id);
  if (!entry) return false;
  const missing = _missingRequiredScopes(entry, inst.oauth_grant);
  if (!missing.length) return false;
  log.warn('connector authorization missing required scopes; treating as uninstalled', {
    id: inst.id,
    missing_count: missing.length,
    reason,
  });
  await _removeStoredInstance(uid, inst.id, reason);
  return true;
}

function _dropMissingScopeInstanceSoon(uid: string, inst: ConnectorInstance, reason: string): void {
  void _dropMissingScopeInstance(uid, inst, reason).catch((err) => {
    log.warn('failed to remove missing-scope connector instance', { id: inst.id, error: (err as Error).message });
  });
}

async function _markAuthorizationError(uid: string, id: string, message: string, reason: string): Promise<void> {
  const conn = _conns.get(id);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  const at = _now();
  const updated = await registry.update(uid, id, (cur) => ({
    ...cur,
    auth_error: {
      code: _connectorErrorCode(message) || 'connector_reconnect_required',
      message,
      reason,
      at,
    },
    status: { kind: 'error', message, at },
    updated_at: _nowIso(),
  }));
  if (updated) log.warn('connector authorization requires reconnect', { id, reason });
}

async function _markInstancesForCatalogError(uid: string, entry: CatalogEntry, message: string, reason: string): Promise<void> {
  const ids = entry.bundle_member_ids?.length ? entry.bundle_member_ids : [entry.id];
  await Promise.all(ids.map((id) => _markAuthorizationError(uid, id, message, reason)));
}

function _markAuthorizationErrorSoon(uid: string, id: string, message: string, reason: string): void {
  void _markAuthorizationError(uid, id, message, reason).catch((err) => {
    log.warn('failed to mark connector authorization error', { id, error: (err as Error).message });
  });
}

/** Refresh the access_token if stale, dedupe concurrent callers, and persist the rotated grant
 *  atomically before returning. After taking the lock we re-READ the instance from disk —
 *  another caller that just released the lock may have written a new grant; using the caller's
 *  in-memory `inst` snapshot would re-trigger an unnecessary (and stale-token-using!) refresh.
 *
 *  Diagnostic logging: every refresh attempt prints the RT fingerprint being sent so a future
 *  `bad_refresh_token` failure can be correlated with the exchange/refresh that originally
 *  issued that RT. Rotation (old → new RT fingerprint) is also logged so we can verify the new
 *  RT actually made it onto disk via the post-write read-back in `registry._writeSync`. */
async function _refreshGrantIfStale(
  uid: string,
  entry: CatalogEntry,
  instId: string,
  opts: { force?: boolean } = {},
): Promise<OAuthGrant> {
  const lockKey = opts.force ? `${instId}:force` : instId;
  const existing = _refreshLocks.get(lockKey);
  if (existing) {
    log.info('refresh dedupe hit', { id: instId });
    return existing;
  }
  let p: Promise<OAuthGrant>;
  p = Promise.resolve().then(async () => {
    try {
      const inst = registry.load(uid).connections[instId];
      if (!inst) throw new Error('instance not found');
      if (!inst.oauth_grant) throw new Error('no oauth_grant');
      if (await _dropMissingScopeInstance(uid, inst, 'missing_required_scopes_refresh')) {
        const err = new Error('missing_required_scopes') as Error & { code?: string };
        err.code = 'missing_required_scopes';
        throw err;
      }
      const storedProblem = _storedAuthorizationProblem(inst);
      if (storedProblem) {
        await _markAuthorizationError(uid, inst.id, storedProblem.message, `refresh_${storedProblem.reason}`);
        const err = new Error(storedProblem.message) as Error & { code?: string };
        err.code = storedProblem.reason;
        throw err;
      }
      // Already fresh? Skip the remote call entirely.
      const needsGithubServerAdoption = entry.oauth?.provider_id === 'github'
        && !!inst.oauth_grant.refresh_token
        && !inst.oauth_grant.server_grant_id;
      if (!opts.force
        && !needsGithubServerAdoption
        && inst.oauth_grant.expires_at
        && inst.oauth_grant.expires_at - Date.now() > REFRESH_BUFFER_MS) {
        return inst.oauth_grant;
      }
      const oldRt = inst.oauth_grant.refresh_token;
      log.info('refresh attempt', {
        id: instId,
        auth_mode: entry.auth_mode,
        rt_prefix: _tokPrefix(oldRt),
        at_prefix: _tokPrefix(inst.oauth_grant.access_token),
        expires_at_ms: inst.oauth_grant.expires_at,
        ms_until_expiry: inst.oauth_grant.expires_at ? inst.oauth_grant.expires_at - Date.now() : null,
      });
      let next: OAuthGrant;
      try {
        if (entry.auth_mode === 'mcp_dcr') {
          if (!inst.dcr_client) {
            const err = new Error('connector_reconnect_required: DCR client credentials are not available locally; reconnect required') as Error & { code?: string };
            err.code = 'connector_reconnect_required';
            throw err;
          }
          next = await refreshDcrIfStale(inst.dcr_client, inst.oauth_grant, opts);
        } else {
          next = await refreshIfStale(uid, entry, inst.oauth_grant, opts);
        }
      } catch (err) {
        if (!_isTransientConnectorFailure(err) && _isGoogleAuthFailure(entry, err)) {
          await _markAuthorizationError(uid, inst.id, (err as Error).message, 'google_auth_refresh_failed');
        } else if (!_isTransientConnectorFailure(err) && _isDcrAuthFailure(entry, err)) {
          await _markAuthorizationError(uid, inst.id, (err as Error).message, 'dcr_auth_refresh_failed');
        }
        log.warn('refresh upstream failed', {
          id: instId,
          rt_sent: _tokPrefix(oldRt),
          error: (err as Error).message,
        });
        throw err;
      }
      const missingAfterRefresh = _missingRequiredScopes(entry, next);
      if (missingAfterRefresh.length) {
        log.warn('refreshed connector grant missing required scopes; treating as uninstalled', {
          id: instId,
          missing_count: missingAfterRefresh.length,
        });
        await _removeStoredInstance(uid, inst.id, 'missing_required_scopes_refresh_result');
        const err = new Error('missing_required_scopes') as Error & { code?: string };
        err.code = 'missing_required_scopes';
        throw err;
      }
      const rotated = oldRt !== next.refresh_token;
      log.info('refresh ok', {
        id: instId,
        old_rt: _tokPrefix(oldRt),
        new_rt: _tokPrefix(next.refresh_token),
        new_at: _tokPrefix(next.access_token),
        rotated,
        new_expires_at_ms: next.expires_at,
      });
      // Persist the rotated grant inside the lock so the next caller's re-read sees it. Use
      // `update(patch)` not `upsert(snapshot)` — concurrent writers (status updates from a
      // different code path) must not be clobbered by a stale field-set spread.
      if (next !== inst.oauth_grant) {
        try {
          await registry.update(uid, instId, (cur) => {
            return {
              ...cur,
              oauth_grant: next,
              updated_at: _nowIso(),
            };
          });
          log.info('refresh grant persisted', {
            id: instId,
            new_rt: _tokPrefix(next.refresh_token),
          });
        } catch (err) {
          log.error('refresh grant persist FAILED — disk RT now diverged from server', {
            id: instId,
            new_rt_on_server: _tokPrefix(next.refresh_token),
            error: (err as Error).message,
          });
          throw err;
        }
      }
      return next;
    } finally {
      if (_refreshLocks.get(lockKey) === p) {
        _refreshLocks.delete(lockKey);
      }
    }
  });
  _refreshLocks.set(lockKey, p);
  return p;
}

async function _resolveTransport(uid: string, inst: ConnectorInstance): Promise<{ transport: Transport; grant: OAuthGrant | null } | null> {
  // Custom instances use their stored transport verbatim — no catalog
  // template, no OAuth grant, no refresh cycle. The transport (incl. any
  // API-key headers/env) lives inside secrets_enc like every other one.
  if (inst.origin === 'custom') {
    if (!inst.transport) {
      log.warn('custom instance has no transport', { id: inst.id });
      return null;
    }
    return { transport: inst.transport, grant: null };
  }
  const entry = findCatalogEntry(inst.id);
  if (!entry) {
    log.warn('catalog entry missing for instance', { id: inst.id });
    return null;
  }
  if (!inst.oauth_grant) {
    log.warn('instance has no oauth_grant', { id: inst.id });
    return null;
  }
  let grant: OAuthGrant;
  try {
    grant = await _refreshGrantIfStale(uid, entry, inst.id);
  } catch (err) {
    log.warn('refresh failed', { id: inst.id, error: (err as Error).message });
    throw err;
  }
  const transport = applyTemplate(entry, grant);
  return { transport, grant };
}

/** Patch the per-instance status/tools fields. Normal calls persist atomically;
 *  bootstrap supplies a collector and flushes all discovered patches once via
 *  `registry.updateMany`. Both forms apply patches to the latest registry row,
 *  so a concurrently refreshed `oauth_grant` is never clobbered. */
async function _patchStatus(
  uid: string,
  inst: ConnectorInstance,
  patch: (cur: ConnectorInstance) => ConnectorInstance,
  statusPatches?: StatusPatchCollector,
): Promise<ConnectorInstance> {
  if (statusPatches) {
    const pending = statusPatches.get(inst.id) || [];
    let current = inst;
    for (const apply of pending) current = apply(current);
    pending.push(patch);
    statusPatches.set(inst.id, pending);
    return patch(current);
  }
  const updated = await registry.update(uid, inst.id, patch);
  return updated ?? inst;
}

async function _connectAndCacheTools(
  uid: string,
  inst: ConnectorInstance,
  statusPatches?: StatusPatchCollector,
): Promise<ConnectorInstance> {
  const entry = findCatalogEntry(inst.id);
  let transport: Transport;
  try {
    const resolved = await _resolveTransport(uid, inst);
    if (!resolved) {
      if (_isUnknownCatalogInstance(inst)) {
        log.warn('skipping synced connector unsupported by this app version', { id: inst.id });
        return inst;
      }
      return _patchStatus(uid, inst, (cur) => ({
        ...cur,
        status: { kind: 'error', message: 'transport unresolved', at: _now() },
        updated_at: _nowIso(),
      }), statusPatches);
    }
    transport = resolved.transport;
  } catch (err) {
    const entry = findCatalogEntry(inst.id);
    if (_isMissingRequiredScopesError(err) || (entry && !_isTransientConnectorFailure(err) && _isGoogleAuthFailure(entry, err))) {
      return inst;
    }
    const degraded = await _markDegradedOnTransientFailure(
      uid, inst, err, 'resolve_transport', statusPatches,
    );
    if (degraded) return degraded;
    return _patchStatus(uid, inst, (cur) => ({
      ...cur,
      status: { kind: 'error', message: (err as Error).message, at: _now() },
      updated_at: _nowIso(),
    }), statusPatches);
  }
  const conn = new McpConnection(inst.id, transport);
  try {
    await conn.connect();
    const tools = await conn.listTools();
    _conns.set(inst.id, conn);
    return _patchStatus(uid, inst, (cur) => ({
      ...cur,
      transport,
      tools_cache: tools,
      tools_cached_at: _now(),
      auth_error: undefined,
      status: { kind: 'connected', since: _now() },
      updated_at: _nowIso(),
    }), statusPatches);
  } catch (err) {
    log.warn('connect+list failed', { id: inst.id, error: (err as Error).message });
    try { await conn.close(); } catch { /* swallow */ }
    let statusErr = err;
    if (_isTransientConnectorFailure(statusErr)) {
      log.info('connect+list hit transient network failure; retrying once', { id: inst.id });
      await _sleep(CONNECT_RETRY_DELAY_MS);
      try {
        const retryConn = new McpConnection(inst.id, transport);
        await retryConn.connect();
        const tools = await retryConn.listTools();
        _conns.set(inst.id, retryConn);
        return _patchStatus(uid, inst, (cur) => ({
          ...cur,
          transport,
          tools_cache: tools,
          tools_cached_at: _now(),
          auth_error: undefined,
          status: { kind: 'connected', since: _now() },
          updated_at: _nowIso(),
        }), statusPatches);
      } catch (retryErr) {
        statusErr = retryErr;
        log.warn('connect+list transient retry failed', { id: inst.id, error: (retryErr as Error).message });
      }
    }
    if (_shouldForceRefreshAfterConnectFailure(entry, inst, statusErr)) {
      log.info('MCP endpoint rejected OAuth token; forcing grant refresh and retrying', { id: inst.id });
      try {
        const grant = await _refreshGrantIfStale(uid, entry!, inst.id, { force: true });
        const retryTransport = applyTemplate(entry!, grant);
        const retryConn = new McpConnection(inst.id, retryTransport);
        await retryConn.connect();
        const tools = await retryConn.listTools();
        _conns.set(inst.id, retryConn);
        return _patchStatus(uid, inst, (cur) => ({
          ...cur,
          transport: retryTransport,
          tools_cache: tools,
          tools_cached_at: _now(),
          auth_error: undefined,
          status: { kind: 'connected', since: _now() },
          updated_at: _nowIso(),
        }), statusPatches);
      } catch (retryErr) {
        statusErr = retryErr;
        log.warn('forced OAuth refresh retry failed', { id: inst.id, error: (retryErr as Error).message });
      }
    }
    const degraded = await _markDegradedOnTransientFailure(
      uid, inst, statusErr, 'connect_list', statusPatches,
    );
    if (degraded) return degraded;
    return _patchStatus(uid, inst, (cur) => ({
      ...cur,
      status: { kind: 'error', message: (statusErr as Error).message, at: _now() },
      updated_at: _nowIso(),
    }), statusPatches);
  }
}

function _shouldForceRefreshAfterConnectFailure(
  entry: CatalogEntry | null,
  inst: ConnectorInstance,
  err: unknown,
): boolean {
  if (!entry) return false;
  const canRefresh = entry.auth_mode === 'mcp_dcr'
    ? !!inst.dcr_client && !!inst.oauth_grant?.refresh_token
    : !!inst.oauth_grant?.server_grant_id && !!inst.oauth_grant.server_managed;
  if (!canRefresh) return false;
  const msg = (err as Error).message || '';
  return /\b(401|403|unauthorized|AuthenticateToken|authentication failed|invalid_token|invalid access token|missing_token)\b/i.test(msg);
}

export async function verifyUsableConnectors(uid: string, reason = 'manual'): Promise<number> {
  if (!uid) return 0;
  const existing = _verifyLocks.get(uid);
  if (existing) return existing;
  const run = (async () => {
    const now = Date.now();
    const due = listInstances(uid).filter((inst) => {
      if (!isConnectorUsable(inst.status) || !isConnectorRuntimeEnabled(inst.id)) return false;
      if (_conns.get(inst.id)?.isConnected || _isInRetryCooldown(inst)) return false;
      return now - (_lastVerifiedAt(inst) || 0) >= VERIFY_TTL_MS;
    });
    if (!due.length) return 0;
    log.info('verifying connectors with stale verification', { reason, due: due.length });
    let verified = 0;
    await _runBounded(due, BOOTSTRAP_CONNECT_CONCURRENCY, async (inst) => {
      const updated = await _connectAndCacheTools(uid, inst).catch((err) => {
        log.warn('connector verification threw', { id: inst.id, error: (err as Error).message });
        return null;
      });
      if (updated?.status?.kind === 'connected') verified += 1;
    });
    return verified;
  })();
  _verifyLocks.set(uid, run);
  try { return await run; }
  finally { _verifyLocks.delete(uid); }
}

export async function bootstrap(uid: string): Promise<void> {
  if (!uid || _bootedFor === uid) return;
  _bootedFor = uid;
  const file = registry.load(uid);
  const ids = Object.keys(file.connections);
  if (!ids.length) {
    log.info('no connectors to bootstrap');
    return;
  }
  const connectCandidates: ConnectorInstance[] = [];
  let reusedCached = 0;
  for (const id of ids) {
    const inst = file.connections[id];
    if (_isUnknownCatalogInstance(inst)) {
      log.warn('skipping synced connector unsupported by this app version', { id });
      continue;
    }
    try {
      if (await _dropMissingScopeInstance(uid, inst, 'missing_required_scopes_bootstrap')) continue;
    } catch (err) {
      log.warn('failed to remove missing-scope connector during bootstrap', { id, error: (err as Error).message });
      continue;
    }
    const problem = _storedAuthorizationProblem(inst);
    if (problem) {
      if (!inst.auth_error?.message || !_hasStatusError(inst, problem.message)) {
        try {
          await _markAuthorizationError(uid, inst.id, problem.message, `bootstrap_${problem.reason}`);
        } catch (err) {
          log.warn('failed to mark authorization error during bootstrap', { id, error: (err as Error).message });
        }
      }
      continue;
    }
    if (!isConnectorRuntimeEnabled(inst.id)) continue;
    // A healthy persisted row already has everything needed to expose the connector to the
    // model. Keeping every MCP process/socket warm made the deferred bootstrap take 10s+ for a
    // typical multi-connector setup and merely moved startup contention into the first minute.
    // `callTool` establishes this one connection on first use (and refreshes stale OAuth grants),
    // so do network/process work here only when local discovery or state repair is actually due.
    if (
      inst.status?.kind === 'connected'
      && inst.tools_cache.length > 0
    ) {
      reusedCached += 1;
      continue;
    }
    if (_isInRetryCooldown(inst)) continue;
    connectCandidates.push(inst);
  }
  const statusPatches: StatusPatchCollector = new Map();
  await _runBounded(connectCandidates, BOOTSTRAP_CONNECT_CONCURRENCY, async (inst) => {
    await _connectAndCacheTools(uid, inst, statusPatches).catch(() => {});
  });
  await registry.updateMany(uid, statusPatches);
  const connected = Array.from(_conns.values()).filter((c) => c.isConnected).length;
  log.info('connectors bootstrap done', {
    total: ids.length,
    reused_cached: reusedCached,
    connect_candidates: connectCandidates.length,
    connected,
    concurrency: BOOTSTRAP_CONNECT_CONCURRENCY,
    persisted_statuses: statusPatches.size,
  });
}

export function listInstances(uid: string): ConnectorInstance[] {
  if (!uid) return [];
  const file = registry.load(uid);
  return Object.values(file.connections).filter((inst) => {
    if (_isUnknownCatalogInstance(inst)) return false;
    if (_hasMissingRequiredScopes(inst)) {
      _dropMissingScopeInstanceSoon(uid, inst, 'missing_required_scopes_list');
      return false;
    }
    return true;
  }).map((inst) => {
    const problem = _storedAuthorizationProblem(inst);
    if (problem) {
      if (!inst.auth_error?.message || !_hasStatusError(inst, problem.message)) {
        _markAuthorizationErrorSoon(uid, inst.id, problem.message, `list_${problem.reason}`);
      }
      return {
        ...inst,
        status: { kind: 'error' as const, message: problem.message, at: _now() },
      };
    }
    return _normalizeTransientStatusForList(inst);
  }).sort((a, b) =>
    (a.display_name || a.id).localeCompare(b.display_name || b.id, undefined, {
      sensitivity: 'base',
      numeric: true,
    }),
  );
}

export function getInstance(uid: string, id: string): ConnectorInstance | null {
  if (!uid) return null;
  const file = registry.load(uid);
  const inst = file.connections[id] || null;
  if (inst) {
    if (_isUnknownCatalogInstance(inst)) return null;
    if (_hasMissingRequiredScopes(inst)) {
      _dropMissingScopeInstanceSoon(uid, inst, 'missing_required_scopes_get');
      return null;
    }
    const problem = _storedAuthorizationProblem(inst);
    if (problem) {
      if (!inst.auth_error?.message || !_hasStatusError(inst, problem.message)) {
        _markAuthorizationErrorSoon(uid, inst.id, problem.message, `get_${problem.reason}`);
      }
      return {
        ...inst,
        status: { kind: 'error', message: problem.message, at: _now() },
      };
    }
    return _normalizeTransientStatusForList(inst);
  }
  return inst;
}

/** Drive the full OAuth flow for a catalog entry and bring the resulting MCP connection up.
 *  This is the **only** public install path — there is no free-form / API-key entry point.
 *  Dispatches to server-bridge or DCR depending on `entry.auth_mode`. */
export async function connectViaOAuth(uid: string, catalogId: string): Promise<ConnectorInstance> {
  if (!uid) throw new Error('uid required');
  const entry = findCatalogEntry(catalogId);
  if (!entry) throw new Error('unknown catalog id');
  assertConnectorRuntimeEnabled(catalogId);

  log.info('connectViaOAuth: starting OAuth', { catalog_id: catalogId, auth_mode: entry.auth_mode });
  let grant: OAuthGrant;
  let dcrClient: ConnectorInstance['dcr_client'];
  if (entry.auth_mode === 'mcp_dcr') {
    try {
      const result = await startMcpDcrOAuth(uid, entry);
      grant = result.grant;
      dcrClient = result.client;
    } catch (err) {
      if (_isMissingRequiredScopesError(err)) {
        await _removeInstancesForCatalog(uid, entry, 'missing_required_scopes_oauth');
      } else if (_isGoogleAuthFailure(entry, err)) {
        await _markInstancesForCatalogError(uid, entry, (err as Error).message, 'oauth_authorization_failed');
      }
      throw err;
    }
  } else {
    if (!entry.oauth) throw new Error(`'${catalogId}' has no oauth config`);
    // GitHub App installation and user authorization are separate flows. First-time connects must
    // start at the App install URL so the user picks repositories. Once this catalog has ever been
    // authorized on this device, follow-up connects use the user-authorization URL; if the remote
    // App was later uninstalled, Server detects that and bounces the browser back to install.
    const existing = registry.load(uid).connections[catalogId] || null;
    const reauthorize = _isGitHubEntry(entry) && (!!existing || registry.shouldReauthorize(uid, catalogId));
    try {
      grant = await startOAuth(uid, entry, { reauthorize });
    } catch (err) {
      if (_isMissingRequiredScopesError(err)) {
        await _removeInstancesForCatalog(uid, entry, 'missing_required_scopes_oauth');
      } else if (_isGoogleAuthFailure(entry, err)) {
        await _markInstancesForCatalogError(uid, entry, (err as Error).message, 'oauth_authorization_failed');
      }
      throw err;
    }
  }

  // Bundle entry: one OAuth flow (the Server returns a grant with union scopes) → provision N
  // member instances, each with its own transport and a deep-cloned grant. The bundle entry
  // itself has `transport_template: null` and never becomes an instance — see CatalogEntry's
  // `bundle_member_ids` doc.
  if (entry.bundle_member_ids?.length) {
    log.info('connectViaOAuth: bundle — provisioning members', {
      bundle: catalogId,
      members: entry.bundle_member_ids,
    });
    let firstMember: ConnectorInstance | null = null;
    for (const memberId of entry.bundle_member_ids) {
      const memberEntry = findCatalogEntry(memberId);
      if (!memberEntry) { log.warn('bundle member missing from catalog', { memberId }); continue; }
      if (!memberEntry.transport_template) { log.warn('bundle member has no transport template', { memberId }); continue; }
      // Deep-clone so each member's `_refreshGrantIfStale` mutates its own copy when the token
      // rotates. They independently re-hit the refresh endpoint (slight waste, ~5 refreshes/h
      // per user — acceptable); the alternative is a shared refresh lock keyed by `refresh_token`
      // which is a bigger lifecycle change.
      const memberGrant: OAuthGrant = JSON.parse(JSON.stringify(grant));
      const member = await _provisionMemberInstance(uid, memberEntry, memberGrant, dcrClient);
      if (!firstMember) firstMember = member;
    }
    if (!firstMember) throw new Error('bundle produced no member instances');
    return firstMember;  // renderer reloads the full list after; the return value is informational
  }

  if (!entry.transport_template) {
    throw new Error(`'${catalogId}' is not installable yet (${entry.unavailable_reason || 'unavailable'})`);
  }
  log.info('connectViaOAuth: OAuth done; spawning MCP server', { catalog_id: catalogId });
  return _provisionMemberInstance(uid, entry, grant, dcrClient);
}

/** Provision (or replace) a single instance for a non-bundle catalog entry. Pulled out of
 *  `connectViaOAuth` so the bundle branch can loop over members. Caller has already obtained
 *  the OAuth grant. */
async function _provisionMemberInstance(
  uid: string,
  entry: CatalogEntry,
  grant: OAuthGrant,
  dcrClient: ConnectorInstance['dcr_client'],
): Promise<ConnectorInstance> {
  const transport = applyTemplate(entry, grant);

  // Tear down any prior live connection for the same id before re-using the slot.
  const prior = _conns.get(entry.id);
  if (prior) {
    try { await prior.close(); } catch { /* swallow */ }
    _conns.delete(entry.id);
  }

  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    oauth_grant: grant,
    ...(dcrClient ? { dcr_client: dcrClient } : {}),
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  // Diagnostic: capture which RT just got issued by the provider so a later refresh failure
  // can be matched against this exchange (the `_refreshGrantIfStale` logs print the same
  // _tokPrefix fingerprint — `bad_refresh_token` mid-day means the on-disk RT no longer matches
  // what the provider has on record; correlating fingerprints pinpoints whether the write here
  // didn't land or got overwritten by another path).
  log.info('provision: fresh grant from exchange', {
    id: entry.id,
    rt_prefix: _tokPrefix(grant.refresh_token),
    at_prefix: _tokPrefix(grant.access_token),
    expires_at_ms: grant.expires_at,
    has_dcr_client: !!dcrClient,
  });
  await registry.upsert(uid, draft);
  if (_isGitHubEntry(entry)) {
    await registry.setReauthorizeHint(uid, entry.id, true);
  }
  return _connectAndCacheTools(uid, draft);
}

/**
 * Add a user-supplied MCP server (plan §C — the single validated install
 * route for custom connectors; both the settings form and any future
 * commander-driven flow call this through `connectors.add_custom`).
 *
 * The renderer form is the consent surface: the user typed (and sees) the
 * exact command/url that will be used, so no second confirmation dialog is
 * required here. Probes the server immediately — a failed probe keeps the
 * instance in `error` status (visible in the UI, fixable by remove+re-add)
 * instead of silently discarding the user's input.
 */
export async function addCustomInstance(uid: string, input: CustomConnectorInput): Promise<ConnectorInstance> {
  if (!uid) throw new Error('uid required');
  const displayName = validateDisplayName(input?.display_name);
  const transport = validateCustomTransport(input?.transport);

  // Unique id derived from the name; suffix on collision with an existing
  // row. The `custom-` prefix guarantees catalog ids can never be shadowed.
  const base = deriveCustomId(displayName);
  const existing = registry.load(uid).connections;
  let id = base;
  for (let n = 2; existing[id]; n++) id = `${base}-${n}`;

  const draft: ConnectorInstance = {
    id,
    display_name: displayName,
    origin: 'custom',
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  log.info('custom connector add', { id, kind: transport.kind });
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft);
}

export async function removeInstance(uid: string, id: string): Promise<boolean> {
  if (!uid) return false;
  const conn = _conns.get(id);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  return registry.remove(uid, id);
}

export async function refreshTools(uid: string, id: string): Promise<ToolSchema[]> {
  if (!uid) throw new Error('uid required');
  assertConnectorRuntimeEnabled(id);
  const inst = getInstance(uid, id);
  if (!inst) throw new Error('instance not found');
  // Force refresh-token check by tearing the live conn down and reconnecting through
  // _connectAndCacheTools (which re-resolves transport with a fresh access_token).
  const prior = _conns.get(id);
  if (prior) {
    try { await prior.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  const updated = await _connectAndCacheTools(uid, inst);
  return updated.tools_cache;
}

export async function setEnabledSubtools(
  uid: string,
  id: string,
  subset: string[] | null,
): Promise<ConnectorInstance | null> {
  if (!uid) return null;
  return registry.update(uid, id, (cur) => ({
    ...cur,
    enabled_subtools: subset,
    updated_at: _nowIso(),
  }));
}

export async function authorizeGoogleSheetsFiles(uid: string, fileIds?: string[]): Promise<string[]> {
  if (!uid) throw new Error('uid required');
  assertConnectorRuntimeEnabled('gsheets');
  const inst = getInstance(uid, 'gsheets');
  if (!inst || !inst.oauth_grant) throw new Error('connect Google Sheets first');

  const picked = await startGoogleSheetsPicker(fileIds);
  const prev = inst.oauth_grant;
  const nextGrant: OAuthGrant = {
    ...picked.grant,
    refresh_token: picked.grant.refresh_token || prev.refresh_token,
    account_label: picked.grant.account_label || prev.account_label,
  };
  await registry.update(uid, 'gsheets', (cur) => ({
    ...cur,
    oauth_grant: nextGrant,
    updated_at: _nowIso(),
  }));
  const conn = _conns.get('gsheets');
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete('gsheets');
  }
  return picked.pickedFileIds;
}

export async function callTool(
  uid: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!uid) throw new Error('uid required');
  assertConnectorRuntimeEnabled(id);
  const inst = getInstance(uid, id);
  if (!inst) throw new Error('instance not found');
  const liveConn = _conns.get(id);
  const grantForCooldown = inst.oauth_grant;
  const grantStaleForCooldown = !!(grantForCooldown?.expires_at
    && grantForCooldown.expires_at - Date.now() <= REFRESH_BUFFER_MS);
  if ((!liveConn?.isConnected || grantStaleForCooldown) && _isInRetryCooldown(inst)) {
    throw new Error(_cooldownMessage(id, inst));
  }
  // Stale-token guard: the transport snapshots the bearer at connect time (for streamable-http)
  // or injects it into env at spawn time (for stdio). A long-lived connection past the
  // `expires_at` deadline will keep using the dead token on every request — fine for short-lived
  // chats (1h Gmail TTL is rarely exceeded inside one conversation) but breaks "leave PC open
  // overnight" use cases. Detect staleness, tear down + reconnect; `_resolveTransport` calls
  // `_refreshGrantIfStale` which rotates the token before applyTemplate rebuilds the transport
  // with the fresh one. Same `REFRESH_BUFFER_MS` window the refresh path uses.
  const grant = inst.oauth_grant;
  const stale = !!(grant && grant.expires_at && grant.expires_at - Date.now() <= REFRESH_BUFFER_MS);
  let conn = _conns.get(id);
  if (stale && conn) {
    log.info('grant stale → tearing down to refresh on reconnect', { id });
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(id);
    conn = undefined;
  }
  if (!conn || !conn.isConnected) {
    // Reuse the full connect/list/retry/auth-repair path that bootstrap used
    // before healthy cached connectors became lazy. This keeps the optimization
    // from weakening first-call recovery, refreshes the target's schemas, and
    // persists a real failure for the Connectors UI. Coalesce concurrent model
    // calls so only one stdio child/socket is created for this instance.
    let pending = _onDemandConnectLocks.get(id);
    if (!pending) {
      pending = (async () => {
        const current = _conns.get(id);
        if (current?.isConnected) return current;
        const updated = await _connectAndCacheTools(uid, inst!);
        const connected = _conns.get(id);
        if (!connected?.isConnected) {
          throw new Error(_connectFailureMessage(id, updated));
        }
        return connected;
      })();
      _onDemandConnectLocks.set(id, pending);
      void pending.finally(() => {
        if (_onDemandConnectLocks.get(id) === pending) _onDemandConnectLocks.delete(id);
      }).catch(() => {});
    }
    conn = await pending;
  }
  return conn.callTool(name, args);
}

function _connectFailureMessage(id: string, updated: ConnectorInstance): string {
  const status = updated.status;
  if (status?.kind === 'error' || status?.kind === 'degraded') {
    return `connector ${id} unavailable: ${status.message}`;
  }
  if (updated.auth_error?.message) {
    return `connector ${id} unavailable: ${updated.auth_error.message}`;
  }
  return `connector ${id} unavailable: connect failed with status ${status?.kind ?? 'unknown'}`;
}

export async function shutdownAll(): Promise<void> {
  const all = Array.from(_conns.values());
  _conns.clear();
  _onDemandConnectLocks.clear();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
  _bootedFor = null;
}
