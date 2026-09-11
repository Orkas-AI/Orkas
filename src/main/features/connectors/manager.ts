/**
 * Connector manager — process-level singleton holding live MCP client connections.
 *
 * On boot: read the registry and reuse persisted tool schemas for healthy instances. Only rows
 * that need first-time discovery, catalog-cache refresh, or state repair are connected. A real
 * tool call reconnects its one instance on demand. On shutdown: close live connections cleanly
 * so stdio subprocesses exit instead of leaking. Tool calls route here from the AgentRunner's
 * meta-tools via `tools-adapter.ts`.
 *
 * Device-local CLI/API credentials, provider OAuth grants and API-key-backed Composio grants share `connectViaOAuth`. The manager
 * persists only opaque grants, applies the catalog transport, and brings the live MCP connection
 * up. Tokens are lazily refreshed at boot / refresh-tools / reconnect; mid-call expiry surfaces
 * as a tool error and the user re-clicks "刷新工具".
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { app } from 'electron';

import * as registry from './registry';
import * as paths from '../../paths';
import { McpConnection } from './mcp-client';
import { connectorCatalog, findCatalogEntry } from './catalog';
import { applyTemplate } from './apply-template';
import { resolveCatalogConnection } from './connection-parameters';
import { assertConnectorRuntimeEnabled, isConnectorRuntimeEnabled } from './availability';
import { startComposioConnect, startOAuth, refreshIfStale, startGoogleSheetsPicker } from './oauth';
import { startMcpDcrOAuth, refreshDcrIfStale } from './oauth-dcr';
import { createLogger } from '../../logger';
import { isConnectorActionBlocked } from './action_policy';
import { logErrorSummary } from '../../util/log-redact';
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';
import { fetchWithTimeout } from '../../util/abort';
import { commonHeaders, withCommonHeaders } from '../api_common';
import { accountApiBase } from './_server_bridge';
import { connectorApiKeyHeaders } from './api-key';
import { preflightConnectorCredits } from './usage-metering';
import { registerUserSwitchHook } from '../user-switch-hooks';
import { broadcastOAuthConnectOutcome, broadcastOAuthConnectProgress, type OAuthConnectOutcome } from './oauth-events';
import { sanitizeAuthorizationDetail } from './local-cli-auth-error';
import { deriveCustomId, validateCustomTransport, validateDisplayName, type CustomConnectorInput } from './custom-transport';
import {
  authorizeLocalCli,
  localCliTransport,
  removeLocalCliAuthorization,
} from './local-cli';
import {
  authorizeLocalApi,
  hasLocalApiAuthorization,
  localApiStoredTransport,
  localApiTransport,
  normalizeLocalApiConnectionInput,
  PRODUCTION_ONLY_LOCAL_API_PROVIDERS,
  removeLocalApiAuthorization,
} from './local-api';
import { isConnectorUsable } from './types';
import type { CatalogEntry, ComposioGrant, ConnectorInstance, OAuthGrant, ToolSchema, Transport } from './types';

const log = createLogger('connectors:manager');

function _runtimeKey(uid: string, id: string): string {
  return `${uid}\u0000${id}`;
}

const _conns = new Map<string, McpConnection>();
const _verifyLocks = new Map<string, Promise<number>>();
const _toolsCacheRefreshLocks = new Map<string, Promise<number>>();
const _connectLocks = new Map<string, Promise<ConnectorInstance>>();
const _localCliConnectAttempts = new Map<string, string>();
let _bootedFor: string | null = null;
let _runtimeEpoch = 0;

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
interface RefreshLock {
  promise: Promise<OAuthGrant>;
  force: boolean;
  attemptedRemote: boolean;
}
const _refreshLocks = new Map<string, RefreshLock>();

function _accountChangedError(): Error & { code: string } {
  return Object.assign(new Error('connector account changed'), {
    code: 'E_CONNECTOR_ACCOUNT_CHANGED',
  });
}

function _isAccountChangedError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'E_CONNECTOR_ACCOUNT_CHANGED';
}

function _assertRuntimeEpoch(epoch: number): void {
  if (epoch !== _runtimeEpoch) throw _accountChangedError();
}

async function _publishConnection(
  uid: string,
  id: string,
  conn: McpConnection,
  epoch: number,
): Promise<void> {
  _assertRuntimeEpoch(epoch);
  _conns.set(_runtimeKey(uid, id), conn);
}

function _detachConnectorRuntime(): McpConnection[] {
  _runtimeEpoch += 1;
  const all = Array.from(new Set(_conns.values()));
  _conns.clear();
  _verifyLocks.clear();
  _toolsCacheRefreshLocks.clear();
  _connectLocks.clear();
  _localCliConnectAttempts.clear();
  _refreshLocks.clear();
  _bootedFor = null;
  return all;
}

registerUserSwitchHook('connectors', () => {
  // The hook itself must revoke access synchronously before ACTIVE_UID moves.
  // Closing stdio/HTTP transports is asynchronous, so detach first and finish
  // the physical cleanup in the background. `_runtimeEpoch` prevents a
  // pre-switch connect that resolves late from publishing itself afterwards.
  const detached = _detachConnectorRuntime();
  void Promise.all(detached.map((conn) => conn.close().catch(() => {})));
});

export interface OAuthConnectStart {
  attempt_id: string;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CONNECT_RETRY_DELAY_MS = 500;
const BOOTSTRAP_CONNECT_CONCURRENCY = 3;
const VERIFY_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 30 * 60 * 1000;
const COMPOSIO_CALL_TOOL_TIMEOUT_MS = 110 * 1000;

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

function _stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(_stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${_stableJson(obj[key])}`).join(',')}}`;
}

function _catalogToolsCacheKey(id: string): string {
  const entry = findCatalogEntry(id);
  if (!entry || (entry.auth_mode !== 'composio' && !entry.allowed_tools?.length)) return '';
  return crypto.createHash('sha256').update(_stableJson({
    auth_mode: entry.auth_mode,
    toolkit: entry.composio?.toolkit || '',
    auth_config_id: entry.composio?.auth_config_id || '',
    tools: entry.composio?.tools || [],
    allowed_tools: entry.allowed_tools || [],
    tool_policies: entry.tool_policies || {},
  })).digest('hex').slice(0, 16);
}

/** Runtime local-API transports contain a device credential key. Never project that transport
 * back into the synced registry; retain the credential-free launch template already on the row. */
function _transportForPersistence(
  entry: CatalogEntry | null,
  current: Transport,
  resolved: Transport,
): Transport {
  return entry?.auth_mode === 'local_api' ? current : resolved;
}

/** Apply the catalog's reviewed MCP action boundary before schemas reach persistence or the LLM.
 *  This is separate from the user's `enabled_subtools`: the catalog list is the hard product
 *  policy, while the per-user list can only narrow it further. */
function _applyCatalogToolPolicy(id: string, tools: ToolSchema[]): ToolSchema[] {
  tools = tools.filter((tool) => !isConnectorActionBlocked(id, tool.name));
  const entry = findCatalogEntry(id);
  const configured = entry?.allowed_tools;
  if (!configured?.length) return tools;
  const allowed = new Set(configured);
  const policies = entry?.tool_policies;
  if (policies) {
    const policyNames = Object.keys(policies);
    if (policyNames.length !== configured.length
      || configured.some((name) => !policies[name])
      || policyNames.some((name) => !allowed.has(name))) {
      throw new Error(`connector_tool_policy_invalid: ${id} policy keys must match allowed_tools`);
    }
  }
  const filtered = tools.filter((tool) => allowed.has(tool.name));
  if (!filtered.length) {
    throw new Error(`connector_tool_policy_empty: ${id} returned no reviewed tools`);
  }
  if (filtered.length !== tools.length) {
    log.info('connector tool policy filtered unreviewed provider actions', {
      id,
      reported_count: tools.length,
      allowed_count: filtered.length,
    });
  }
  return policies
    ? filtered.map((tool) => ({ ...tool, orkas_action_policy: policies[tool.name] }))
    : filtered;
}

function _isToolsCacheStale(inst: ConnectorInstance): boolean {
  if (inst.origin === 'custom') return false;
  const key = _catalogToolsCacheKey(inst.id);
  return !!key && inst.tools_cache_key !== key;
}

function _pcDirForChild(): string {
  return app?.isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
}

function _composioTransport(inst: ConnectorInstance): Transport {
  if (!inst.composio_grant?.connection_id) throw new Error('no composio_grant');
  if (!inst.composio_grant.connection_token) {
    throw Object.assign(new Error('connector_reconnect_required'), { code: 'connector_reconnect_required' });
  }
  const nodeRuntime = resolveBackgroundNodeRuntime();
  return {
    kind: 'stdio',
    command: nodeRuntime.executable,
    args: [path.join(_pcDirForChild(), 'bin/composio-mcp-server.cjs')],
    proxyTargetUrl: accountApiBase(),
    env: withBackgroundNodeEnv({
      ORKAS_API_BASE: accountApiBase(),
      ORKAS_API_KEY: connectorApiKeyHeaders().Authorization.slice('Bearer '.length),
      ORKAS_CLIENT_HEADERS_JSON: JSON.stringify(commonHeaders()),
      COMPOSIO_CONNECTION_ID: inst.composio_grant.connection_id,
      COMPOSIO_CONNECTION_TOKEN: inst.composio_grant.connection_token,
      COMPOSIO_CONNECTOR_ID: inst.id,
    }, nodeRuntime),
  };
}

function _composioInstanceDraft(entry: CatalogEntry, grant: ComposioGrant): ConnectorInstance {
  const nodeRuntime = resolveBackgroundNodeRuntime();
  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport: {
      kind: 'stdio',
      command: nodeRuntime.executable,
      args: [path.join(_pcDirForChild(), 'bin/composio-mcp-server.cjs')],
      env: {},
    },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    composio_grant: grant,
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  draft.transport = _composioTransport(draft);
  return draft;
}

async function _deleteComposioConnectionOnServer(id: string, grant?: ComposioGrant): Promise<void> {
  if (findCatalogEntry(id)?.auth_mode !== 'composio') return;
  // Legacy/lost credentials can only be removed locally; reconnect obtains a new one.
  if (!grant?.connection_token) return;
  try {
    const response = await fetchWithTimeout(`${accountApiBase()}/connectors/composio/disconnect`, {
      method: 'POST',
      headers: withCommonHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...connectorApiKeyHeaders(),
        'X-Orkas-Connection-Token': grant.connection_token,
      }),
      body: JSON.stringify({ connector_id: id }),
    }, 60_000, undefined, 'Composio disconnect timed out after 60s');
    if (!response.ok) log.warn('Composio disconnect failed', { id, status: response.status });
  } catch (err) {
    log.warn('Composio disconnect failed', { id, error: logErrorSummary(err) });
  }
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
  if (entry.auth_mode === 'composio' && !inst.composio_grant?.connection_token) {
    return { message: 'connector_reconnect_required', reason: 'missing_connection_credential' };
  }
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

const LEGACY_LOCAL_SECRET_POISON_REASON = 'bootstrap_dcr_auth_error';

/** Older builds projected a device-local decrypt failure as a bare reconnect-required status.
 * Bootstrap then persisted that projection as an auth_error and cloud sync spread it to every
 * device. This exact marker is safe to retry when this device can decrypt the row: a genuinely
 * revoked grant will fail the validation attempt and be written back with the real provider error. */
function _isLegacyLocalSecretAuthPoison(inst: ConnectorInstance): boolean {
  const entry = findCatalogEntry(inst.id);
  return entry?.auth_mode === 'mcp_dcr'
    && !registry.hasUnavailableSecrets(inst)
    && inst.auth_error?.reason === LEGACY_LOCAL_SECRET_POISON_REASON
    && inst.auth_error.message.trim() === 'connector_reconnect_required';
}

async function _clearLegacyLocalSecretAuthPoison(
  uid: string,
  inst: ConnectorInstance,
): Promise<ConnectorInstance> {
  const repaired = await registry.update(uid, inst.id, (cur) => {
    if (!_isLegacyLocalSecretAuthPoison(cur)) return cur;
    return {
      ...cur,
      auth_error: undefined,
      status: { kind: 'connecting' },
      updated_at: _nowIso(),
    };
  });
  if (repaired) {
    log.warn('cleared legacy device-local secret failure misclassified as authorization error', {
      id: inst.origin === 'custom' ? 'custom' : inst.id,
    });
  }
  return repaired || inst;
}

function _secretsUnavailableError(id: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(`connector ${id}: ${registry.SECRETS_UNAVAILABLE_MESSAGE}`), {
    code: registry.SECRETS_UNAVAILABLE_MESSAGE,
    retryable: false,
  });
}

function _isSecretsUnavailableError(err: unknown): boolean {
  return _connectorErrorCode(err) === registry.SECRETS_UNAVAILABLE_MESSAGE;
}

function _isLocalApiCredentialsMissingError(err: unknown): boolean {
  return _connectorErrorCode(err) === 'local_api_credentials_missing';
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
  log.warn('connector degraded after transient failure; keeping grant + cached tools for retry', {
    id: inst.origin === 'custom' ? 'custom' : inst.id,
    reason,
    error: logErrorSummary(err),
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
  const runtimeKey = _runtimeKey(uid, id);
  const conn = _conns.get(runtimeKey);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(runtimeKey);
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
    id: inst.origin === 'custom' ? 'custom' : inst.id,
    missing_count: missing.length,
    reason,
  });
  await _removeStoredInstance(uid, inst.id, reason);
  return true;
}

function _dropMissingScopeInstanceSoon(uid: string, inst: ConnectorInstance, reason: string): void {
  void _dropMissingScopeInstance(uid, inst, reason).catch((err) => {
    log.warn('failed to remove missing-scope connector instance', { id: inst.origin === 'custom' ? 'custom' : inst.id, error: logErrorSummary(err) });
  });
}

async function _markAuthorizationError(uid: string, id: string, message: string, reason: string): Promise<void> {
  const runtimeKey = _runtimeKey(uid, id);
  const conn = _conns.get(runtimeKey);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(runtimeKey);
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
    log.warn('failed to mark connector authorization error', { id, error: logErrorSummary(err) });
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
  const runtimeEpoch = _runtimeEpoch;
  const lockKey = _runtimeKey(uid, instId);
  const existing = _refreshLocks.get(lockKey);
  if (existing) {
    log.info('refresh dedupe hit', { id: instId, force: !!opts.force, existing_force: existing.force });
    const grant = await existing.promise;
    _assertRuntimeEpoch(runtimeEpoch);
    if (opts.force && !existing.force && !existing.attemptedRemote) {
      return _refreshGrantIfStale(uid, entry, instId, opts);
    }
    return grant;
  }
  const lock: RefreshLock = {
    promise: Promise.resolve(null as never),
    force: !!opts.force,
    attemptedRemote: false,
  };
  let p: Promise<OAuthGrant>;
  p = Promise.resolve().then(async () => {
    try {
      _assertRuntimeEpoch(runtimeEpoch);
      const inst = registry.load(uid).connections[instId];
      if (!inst) throw new Error('instance not found');
      if (registry.hasUnavailableSecrets(inst)) throw _secretsUnavailableError(inst.id);
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
      lock.attemptedRemote = true;
      const oldRt = inst.oauth_grant.refresh_token;
      _assertRuntimeEpoch(runtimeEpoch);
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
          error: logErrorSummary(err),
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
            error: logErrorSummary(err),
          });
          throw err;
        }
      }
      return next;
    } finally {
      if (_refreshLocks.get(lockKey) === lock) {
        _refreshLocks.delete(lockKey);
      }
    }
  });
  lock.promise = p;
  _refreshLocks.set(lockKey, lock);
  return p;
}

async function _resolveTransport(uid: string, inst: ConnectorInstance): Promise<{ transport: Transport; grant: OAuthGrant | null } | null> {
  // Custom instances use their stored transport verbatim — no catalog
  // template, no OAuth grant, no refresh cycle. The transport (incl. any
  // API-key headers/env) lives inside secrets_enc like every other one.
  if (inst.origin === 'custom') {
    if (!inst.transport) {
      log.warn('custom instance has no transport', { id: inst.origin === 'custom' ? 'custom' : inst.id });
      return null;
    }
    return { transport: inst.transport, grant: null };
  }
  const entry = findCatalogEntry(inst.id);
  if (!entry) {
    log.warn('catalog entry missing for instance', { id: inst.id });
    return null;
  }
  if (entry.auth_mode === 'composio') {
    return { transport: _composioTransport(inst), grant: null };
  }
  if (entry.auth_mode === 'local_cli') {
    return { transport: localCliTransport(uid, entry), grant: null };
  }
  if (entry.auth_mode === 'local_api') {
    return { transport: await localApiTransport(uid, entry, inst.connection_parameters), grant: null };
  }
  if (!inst.oauth_grant) {
    log.warn('instance has no oauth_grant', { id: inst.id });
    return null;
  }
  let grant: OAuthGrant;
  try {
    grant = await _refreshGrantIfStale(uid, entry, inst.id);
  } catch (err) {
    log.warn('refresh failed', { id: inst.id, error: logErrorSummary(err) });
    throw err;
  }
  const resolvedEntry = resolveCatalogConnection(entry, inst.connection_parameters).entry;
  const transport = applyTemplate(resolvedEntry, grant);
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

/** Share discovery across bootstrap, panel verification, refresh and tool calls. */
async function _connectAndCacheTools(
  uid: string,
  inst: ConnectorInstance,
  statusPatches: StatusPatchCollector | undefined,
  runtimeEpoch: number,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  const key = _runtimeKey(uid, inst.id);
  const existing = _connectLocks.get(key);
  if (existing) return existing;
  const pending = _connectAndCacheToolsOnce(uid, inst, statusPatches, runtimeEpoch);
  _connectLocks.set(key, pending);
  try { return await pending; }
  finally { if (_connectLocks.get(key) === pending) _connectLocks.delete(key); }
}

/** Explicit replacement/removal waits for discovery before closing its published connection. */
async function _closeDiscoveredConnection(
  uid: string, id: string, runtimeEpoch: number, signal?: AbortSignal,
): Promise<void> {
  const key = _runtimeKey(uid, id);
  const pending = _connectLocks.get(key);
  if (pending) {
    try { await _waitForConnectorOrAbort(pending, signal); }
    catch { /* a failed discovery also releases the slot */ }
  }
  _assertRuntimeEpoch(runtimeEpoch);
  if (signal?.aborted) throw _connectorCancelledError(signal.reason);
  const conn = _conns.get(key);
  if (!conn) return;
  _conns.delete(key);
  try { await conn.close(); } catch { /* close already logs */ }
  _assertRuntimeEpoch(runtimeEpoch);
}

async function _connectAndCacheToolsOnce(
  uid: string,
  inst: ConnectorInstance,
  statusPatches: StatusPatchCollector | undefined,
  runtimeEpoch: number,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  // A decrypt failure is local to this device. Never turn it into a metadata patch: doing so
  // syncs a false authorization failure to devices that can still open and use the same grant.
  if (registry.hasUnavailableSecrets(inst)) {
    log.warn('skipping connector connect because encrypted secrets are unavailable on this device', {
      id: inst.origin === 'custom' ? 'custom' : inst.id,
    });
    return inst;
  }
  const runtimeKey = _runtimeKey(uid, inst.id);
  const entry = findCatalogEntry(inst.id);
  let transport: Transport;
  try {
    const resolved = await _resolveTransport(uid, inst);
    _assertRuntimeEpoch(runtimeEpoch);
    if (!resolved) {
      if (_isUnknownCatalogInstance(inst)) {
        log.warn('skipping synced connector unsupported by this app version', { id: inst.origin === 'custom' ? 'custom' : inst.id });
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
    _assertRuntimeEpoch(runtimeEpoch);
    if (_isSecretsUnavailableError(err) || _isLocalApiCredentialsMissingError(err)) {
      return registry.load(uid).connections[inst.id] || inst;
    }
    const entry = findCatalogEntry(inst.id);
    if (_isMissingRequiredScopesError(err) || (entry && !_isTransientConnectorFailure(err) && _isGoogleAuthFailure(entry, err))) {
      return registry.load(uid).connections[inst.id] || inst;
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
    _assertRuntimeEpoch(runtimeEpoch);
    const tools = _applyCatalogToolPolicy(inst.id, await conn.listTools());
    const toolsCacheKey = _catalogToolsCacheKey(inst.id);
    await _publishConnection(uid, inst.id, conn, runtimeEpoch);
    return _patchStatus(uid, inst, (cur) => ({
      ...cur,
      transport: _transportForPersistence(entry, cur.transport, transport),
      tools_cache: tools,
      tools_cached_at: _now(),
      tools_cache_key: toolsCacheKey,
      auth_error: undefined,
      status: { kind: 'connected', since: _now() },
      updated_at: _nowIso(),
    }), statusPatches);
  } catch (err) {
    log.warn('connect+list failed', { id: inst.origin === 'custom' ? 'custom' : inst.id, error: logErrorSummary(err) });
    try { await conn.close(); } catch { /* swallow */ }
    _assertRuntimeEpoch(runtimeEpoch);
    if (_isAccountChangedError(err)) throw err;
    let statusErr = err;
    if (_isTransientConnectorFailure(statusErr)) {
      log.info('connect+list hit transient network failure; retrying once', { id: inst.origin === 'custom' ? 'custom' : inst.id });
      await _sleep(CONNECT_RETRY_DELAY_MS);
      _assertRuntimeEpoch(runtimeEpoch);
      let retryConn: McpConnection | undefined;
      try {
        retryConn = new McpConnection(inst.id, transport);
        await retryConn.connect();
        _assertRuntimeEpoch(runtimeEpoch);
        const tools = _applyCatalogToolPolicy(inst.id, await retryConn.listTools());
        const toolsCacheKey = _catalogToolsCacheKey(inst.id);
        await _publishConnection(uid, inst.id, retryConn, runtimeEpoch);
        return _patchStatus(uid, inst, (cur) => ({
          ...cur,
          transport: _transportForPersistence(entry, cur.transport, transport),
          tools_cache: tools,
          tools_cached_at: _now(),
      tools_cache_key: toolsCacheKey,
          auth_error: undefined,
          status: { kind: 'connected', since: _now() },
          updated_at: _nowIso(),
        }), statusPatches);
      } catch (retryErr) {
        if (retryConn && _conns.get(runtimeKey) !== retryConn) {
          try { await retryConn.close(); } catch { /* ignore */ }
        }
        statusErr = retryErr;
        log.warn('connect+list transient retry failed', { id: inst.origin === 'custom' ? 'custom' : inst.id, error: logErrorSummary(retryErr) });
      }
    }
    _assertRuntimeEpoch(runtimeEpoch);
    if (_isAccountChangedError(statusErr)) throw statusErr;
    if (_shouldForceRefreshAfterConnectFailure(entry, inst, statusErr)) {
      log.info('MCP endpoint rejected OAuth token; forcing grant refresh and retrying', { id: inst.origin === 'custom' ? 'custom' : inst.id });
      let retryConn: McpConnection | undefined;
      try {
        const grant = await _refreshGrantIfStale(uid, entry!, inst.id, { force: true });
        _assertRuntimeEpoch(runtimeEpoch);
        const resolvedEntry = resolveCatalogConnection(entry!, inst.connection_parameters).entry;
        const retryTransport = applyTemplate(resolvedEntry, grant);
        retryConn = new McpConnection(inst.id, retryTransport);
        await retryConn.connect();
        _assertRuntimeEpoch(runtimeEpoch);
        const tools = _applyCatalogToolPolicy(inst.id, await retryConn.listTools());
        const toolsCacheKey = _catalogToolsCacheKey(inst.id);
        await _publishConnection(uid, inst.id, retryConn, runtimeEpoch);
        return _patchStatus(uid, inst, (cur) => ({
          ...cur,
          transport: retryTransport,
          tools_cache: tools,
          tools_cached_at: _now(),
      tools_cache_key: toolsCacheKey,
          auth_error: undefined,
          status: { kind: 'connected', since: _now() },
          updated_at: _nowIso(),
        }), statusPatches);
      } catch (retryErr) {
        if (retryConn && _conns.get(runtimeKey) !== retryConn) {
          try { await retryConn.close(); } catch { /* ignore */ }
        }
        statusErr = retryErr;
        log.warn('forced OAuth refresh retry failed', { id: inst.origin === 'custom' ? 'custom' : inst.id, error: logErrorSummary(retryErr) });
      }
    }
    _assertRuntimeEpoch(runtimeEpoch);
    if (_isAccountChangedError(statusErr)) throw statusErr;
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

export async function refreshStaleToolCaches(uid: string, reason = 'manual'): Promise<number> {
  if (!uid) return 0;
  const existingLock = _toolsCacheRefreshLocks.get(uid);
  if (existingLock) return existingLock;
  const runtimeEpoch = _runtimeEpoch;

  const run = (async () => {
    const file = registry.load(uid);
    const stale = Object.values(file.connections).filter((inst) => {
      if (_isUnknownCatalogInstance(inst)) return false;
      if (registry.hasUnavailableSecrets(inst)) return false;
      if (!isConnectorRuntimeEnabled(inst.id)) return false;
      // Respect the circuit breaker. This runs automatically (catalog signature change, and from
      // `callTool` *before* its own cooldown check), and reconnects every stale row — so without
      // this it is a way straight through the ceiling. A connector that cannot connect cannot
      // refresh its schemas anyway; it re-caches on the attempt that succeeds.
      if (_isInRetryCooldown(inst)) return false;
      return _isToolsCacheStale(inst);
    });
    if (!stale.length) return 0;
    let refreshed = 0;
    for (const inst of stale) {
      _assertRuntimeEpoch(runtimeEpoch);
      await _closeDiscoveredConnection(uid, inst.id, runtimeEpoch);
      _assertRuntimeEpoch(runtimeEpoch);
      log.info('connector tool cache stale; refreshing', {
        id: inst.origin === 'custom' ? 'custom' : inst.id,
        reason,
        old_key: inst.tools_cache_key || '',
        new_key: _catalogToolsCacheKey(inst.id),
      });
      await _connectAndCacheTools(uid, inst, undefined, runtimeEpoch);
      refreshed += 1;
    }
    return refreshed;
  })();

  _toolsCacheRefreshLocks.set(uid, run);
  try {
    return await run;
  } finally {
    if (_toolsCacheRefreshLocks.get(uid) === run) _toolsCacheRefreshLocks.delete(uid);
  }
}

/** Re-verify installed connectors whose last successful connect is older than `VERIFY_TTL_MS`.
 *
 *  **Why this exists.** Bootstrap deliberately skips any row that is already `connected` with a
 *  fresh tools cache (it would otherwise spend 10s+ warming every MCP process at startup). That
 *  optimization is what let a connector sit on a green card for six days after its backend became
 *  unreachable: nothing re-checked it, because nothing *used* it. Lazy verification on tool call is
 *  right for the model's path, but the Connectors panel needs an answer before any tool call
 *  happens — the user opening that panel is precisely the moment "does this actually work?" is
 *  being asked.
 *
 *  **Cost model — why this is event-driven and not a timer.** One verification = one OAuth refresh
 *  (an HTTP round-trip to Orkas Server) + one stdio spawn / socket + one `list_tools`, per
 *  connector. It does NOT touch credits: `preflightConnectorCredits` is called only from
 *  `connectViaOAuth` (first install) and `callTool`, never from `_connectAndCacheTools` — and even
 *  there it is a `require_available` balance check, not a charge, and only for Composio-metered
 *  entries. So the cost here is server load + local processes, not the user's money. That is still
 *  worth bounding: a background poll would pay it for every connector forever, mostly to re-learn
 *  what the next tool call would have told us for free, and would keep hammering a backend that is
 *  already down. So there is no timer anywhere. We spend the cost only when all of these hold:
 *    - the user opened the Connectors panel (the status is actually being read), and
 *    - the row has no live connection already (a live conn IS the verification — free), and
 *    - the last verified connect is older than `VERIFY_TTL_MS` (repeat opens are free).
 *  A user who never opens the panel pays nothing; the model's path is unchanged and still lazy. */
export async function verifyUsableConnectors(uid: string, reason = 'manual'): Promise<number> {
  if (!uid) return 0;
  const existingLock = _verifyLocks.get(uid);
  if (existingLock) return existingLock;
  const runtimeEpoch = _runtimeEpoch;

  const run = (async () => {
    const now = Date.now();
    const due = listInstances(uid).filter((inst) => {
      if (!isConnectorUsable(inst.status) || !isConnectorRuntimeEnabled(inst.id)) return false;
      if (_conns.get(_runtimeKey(uid, inst.id))?.isConnected || _isInRetryCooldown(inst)) return false;
      return now - (_lastVerifiedAt(inst) || 0) >= VERIFY_TTL_MS;
    });
    if (!due.length) return 0;
    log.info('verifying connectors with stale verification', { reason, due: due.length });
    let verified = 0;
    for (let i = 0; i < due.length; i += BOOTSTRAP_CONNECT_CONCURRENCY) {
      _assertRuntimeEpoch(runtimeEpoch);
      const batch = due.slice(i, i + BOOTSTRAP_CONNECT_CONCURRENCY);
      await Promise.all(batch.map(async (inst) => {
        // `_connectAndCacheTools` records the outcome itself — `connected` on success, `degraded`
        // with the real reason on a transient failure, `error` on a hard one. We only count.
        const updated = await _connectAndCacheTools(uid, inst, undefined, runtimeEpoch).catch((err) => {
          if (_isAccountChangedError(err)) throw err;
          log.warn('connector verification threw', { id: inst.origin === 'custom' ? 'custom' : inst.id, error: logErrorSummary(err) });
          return null;
        });
        if (updated?.status?.kind === 'connected') verified += 1;
      }));
    }
    log.info('connector verification done', { reason, due: due.length, verified });
    return verified;
  })();
  _verifyLocks.set(uid, run);
  try {
    return await run;
  } finally {
    if (_verifyLocks.get(uid) === run) _verifyLocks.delete(uid);
  }
}

export async function bootstrap(uid: string): Promise<void> {
  if (!uid || _bootedFor === uid) return;
  let runtimeEpoch = _runtimeEpoch;
  if (_bootedFor && _bootedFor !== uid) {
    const closing = shutdownAll();
    runtimeEpoch = _runtimeEpoch;
    await closing;
    _assertRuntimeEpoch(runtimeEpoch);
  }
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
    _assertRuntimeEpoch(runtimeEpoch);
    let inst = file.connections[id];
    if (_isUnknownCatalogInstance(inst)) {
      log.warn('skipping synced connector unsupported by this app version', { id });
      continue;
    }
    if (registry.hasUnavailableSecrets(inst)) {
      log.warn('skipping connector bootstrap because encrypted secrets are unavailable on this device', { id });
      continue;
    }
    if (_isLegacyLocalSecretAuthPoison(inst)) {
      try {
        inst = await _clearLegacyLocalSecretAuthPoison(uid, inst);
      } catch (err) {
        log.warn('failed to clear legacy connector authorization misclassification', {
          id,
          error: logErrorSummary(err),
        });
        continue;
      }
    }
    try {
      if (await _dropMissingScopeInstance(uid, inst, 'missing_required_scopes_bootstrap')) continue;
    } catch (err) {
      log.warn('failed to remove missing-scope connector during bootstrap', { id, error: logErrorSummary(err) });
      continue;
    }
    const problem = _storedAuthorizationProblem(inst);
    if (problem) {
      if (!inst.auth_error?.message || !_hasStatusError(inst, problem.message)) {
        try {
          await _markAuthorizationError(uid, inst.id, problem.message, `bootstrap_${problem.reason}`);
        } catch (err) {
          log.warn('failed to mark authorization error during bootstrap', { id, error: logErrorSummary(err) });
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
      && !_isToolsCacheStale(inst)
    ) {
      reusedCached += 1;
      continue;
    }
    if (_isInRetryCooldown(inst)) continue;
    connectCandidates.push(inst);
  }
  const statusPatches: StatusPatchCollector = new Map();
  _assertRuntimeEpoch(runtimeEpoch);
  await _runBounded(connectCandidates, BOOTSTRAP_CONNECT_CONCURRENCY, async (inst) => {
    await _connectAndCacheTools(uid, inst, statusPatches, runtimeEpoch).catch(() => {});
  });
  _assertRuntimeEpoch(runtimeEpoch);
  await registry.updateMany(uid, statusPatches);
  const runtimePrefix = `${uid}\u0000`;
  const connected = Array.from(_conns.entries())
    .filter(([key, conn]) => key.startsWith(runtimePrefix) && conn.isConnected)
    .length;
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
    if (registry.hasUnavailableSecrets(inst)) return true;
    if (_hasMissingRequiredScopes(inst)) {
      _dropMissingScopeInstanceSoon(uid, inst, 'missing_required_scopes_list');
      return false;
    }
    return true;
  }).map((inst) => {
    if (registry.hasUnavailableSecrets(inst)) return inst;
    const entry = findCatalogEntry(inst.id);
    if (entry?.auth_mode === 'local_api' && !hasLocalApiAuthorization(uid, entry)) {
      return {
        ...inst,
        status: {
          kind: 'error' as const,
          message: `local_api_credentials_missing:${inst.id}`,
          at: _now(),
        },
      };
    }
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
    if (registry.hasUnavailableSecrets(inst)) return inst;
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

/** Drive the catalog entry's interactive authorization flow and bring the resulting MCP connection up.
 *  This is the only public install path: catalog-declared fields may include device-only API
 *  credentials, but callers cannot supply a free-form transport. Dispatches according to the
 *  catalog entry's server-bridge, DCR, Composio, local-CLI, or local-API auth mode. */
function _assertNoInstalledSiblingVariant(uid: string, entry: CatalogEntry): void {
  const parent = entry.catalog_parent_id ? findCatalogEntry(entry.catalog_parent_id) : entry;
  const catalog = connectorCatalog();
  const variantIds = [
    ...(parent ? [parent.id] : []),
    ...(parent?.connection_variants?.map((variant) => variant.catalog_id) || []),
    ...catalog.filter((candidate) => candidate.catalog_parent_id === parent?.id).map((candidate) => candidate.id),
  ].filter((id, index, values) => values.indexOf(id) === index);
  if (variantIds.length <= 1) return;
  const installed = registry.load(uid).connections;
  const installedSibling = variantIds.find((id) => id !== entry.id && installed[id]);
  if (installedSibling) {
    throw new Error(`connector_variant_already_installed:${installedSibling}`);
  }
}

function _assertProductionInstallBoundary(uid: string, entry: CatalogEntry): void {
  const existing = registry.load(uid).connections[entry.id];
  if (entry.id === 'paypal-sandbox' && !existing) {
    throw Object.assign(new Error('New PayPal connections use production only.'), {
      code: 'connector_production_only',
    });
  }
  if (entry.auth_mode === 'local_api' && PRODUCTION_ONLY_LOCAL_API_PROVIDERS.has(entry.local_api!.provider)
      && existing?.connection_parameters?.environment === 'sandbox') {
    // Before authorization/cleanup: a reconnect must not overwrite or delete the sandbox grant.
    throw Object.assign(new Error('Disconnect the existing test connection before connecting production.'), {
      code: 'connector_sandbox_disconnect_required',
    });
  }
}

export async function connectViaOAuth(
  uid: string,
  catalogId: string,
  opts: { attemptId?: string; connectionParameters?: unknown } = {},
): Promise<ConnectorInstance> {
  if (!uid) throw new Error('uid required');
  const runtimeEpoch = _runtimeEpoch;
  const catalogEntry = findCatalogEntry(catalogId);
  if (!catalogEntry) throw new Error('unknown catalog id');
  _assertProductionInstallBoundary(uid, catalogEntry);
  if (catalogEntry.auth_mode === 'local_api') {
    _assertNoInstalledSiblingVariant(uid, catalogEntry);
    assertConnectorRuntimeEnabled(catalogId);
    await preflightConnectorCredits(catalogEntry, 'connect');
    _assertRuntimeEpoch(runtimeEpoch);
    try {
      const metadata = await authorizeLocalApi(uid, catalogEntry, opts.connectionParameters, { attemptId: opts.attemptId });
      _assertRuntimeEpoch(runtimeEpoch);
      const instance = await _provisionLocalApiInstance(uid, catalogEntry, metadata, runtimeEpoch);
      if (instance.status.kind === 'error') {
        throw new Error(instance.status.message || 'local API account verification failed');
      }
      return instance;
    } catch (error) {
      _assertRuntimeEpoch(runtimeEpoch);
      removeLocalApiAuthorization(uid, catalogEntry);
      await registry.remove(uid, catalogEntry.id);
      throw error;
    }
  }
  const resolved = resolveCatalogConnection(catalogEntry, opts.connectionParameters);
  const entry = resolved.entry;
  _assertNoInstalledSiblingVariant(uid, entry);
  assertConnectorRuntimeEnabled(catalogId);
  await preflightConnectorCredits(entry, 'connect');
  _assertRuntimeEpoch(runtimeEpoch);

  log.info('connectViaOAuth: starting OAuth', { catalog_id: catalogId, auth_mode: entry.auth_mode });
  if (entry.auth_mode === 'composio') {
    const composioGrant = await startComposioConnect(
      entry,
      opts.attemptId ? { attemptId: opts.attemptId } : {},
    );
    _assertRuntimeEpoch(runtimeEpoch);
    return _provisionComposioInstance(uid, entry, composioGrant, runtimeEpoch);
  }
  if (entry.auth_mode === 'local_cli') {
    await authorizeLocalCli(uid, entry);
    _assertRuntimeEpoch(runtimeEpoch);
    // Official CLIs complete authorization without the desktop OAuth deep-link callback.
    // Keep the card busy while the authorized runtime connects and discovers its tools.
    if (opts.attemptId) {
      broadcastOAuthConnectProgress({ attempt_id: opts.attemptId, catalog_id: catalogId });
    }
    return _provisionLocalCliInstance(uid, entry, runtimeEpoch);
  }
  let grant: OAuthGrant;
  let dcrClient: ConnectorInstance['dcr_client'];
  if (entry.auth_mode === 'mcp_dcr') {
    try {
      const result = await startMcpDcrOAuth(
        uid,
        entry,
        opts.attemptId ? { attemptId: opts.attemptId } : {},
      );
      grant = result.grant;
      dcrClient = result.client;
    } catch (err) {
      _assertRuntimeEpoch(runtimeEpoch);
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
      grant = await startOAuth(uid, entry, {
        reauthorize,
        ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
      });
    } catch (err) {
      _assertRuntimeEpoch(runtimeEpoch);
      if (_isMissingRequiredScopesError(err)) {
        await _removeInstancesForCatalog(uid, entry, 'missing_required_scopes_oauth');
      } else if (_isGoogleAuthFailure(entry, err)) {
        await _markInstancesForCatalogError(uid, entry, (err as Error).message, 'oauth_authorization_failed');
      }
      throw err;
    }
  }

  _assertRuntimeEpoch(runtimeEpoch);
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
      const member = await _provisionMemberInstance(uid, memberEntry, memberGrant, dcrClient, runtimeEpoch);
      if (!firstMember) firstMember = member;
    }
    if (!firstMember) throw new Error('bundle produced no member instances');
    return firstMember;  // renderer reloads the full list after; the return value is informational
  }

  if (!entry.transport_template) {
    throw new Error(`'${catalogId}' is not installable yet (${entry.unavailable_reason || 'unavailable'})`);
  }
  log.info('connectViaOAuth: OAuth done; spawning MCP server', { catalog_id: catalogId });
  return _provisionMemberInstance(uid, entry, grant, dcrClient, runtimeEpoch, resolved.parameters);
}

function _oauthConnectErrorCode(err: unknown): string {
  const explicit = (err as { code?: unknown } | null)?.code;
  if (typeof explicit === 'string' && explicit) return explicit;
  const message = String((err as Error | null)?.message || err || '').toLowerCase();
  if (message.includes('superseded')) return 'superseded';
  if (/cancelled|canceled/.test(message)) return 'user_cancelled';
  if (message.includes('flow timed out')) return 'flow_timeout';
  if (message.includes('failed to open browser')) return 'browser_open_failed';
  if (message.includes('exchange')) return 'exchange_failed';
  if (message.includes('local_cli_authorization_failed')) return 'authorization_failed';
  if (message.includes('local_api_authorization_failed')) return 'authorization_failed';
  return 'oauth_failed';
}

/** Accept a connector OAuth request without holding the renderer IPC open while the user is in
 *  their browser. `connectViaOAuth` still owns the short-lived callback state and completes the
 *  exchange/provisioning work when the custom-scheme callback arrives; this wrapper only detaches
 *  that lifecycle from the click request and sends the real terminal result back as a push event.
 *
 *  A flow that receives no callback before its OAuth state expires is abandonment, not a product
 *  failure, so `flow_timeout` deliberately produces no terminal failure event or user alert. */
export function beginOAuthConnect(
  uid: string,
  catalogId: string,
  connectionParameters?: unknown,
): OAuthConnectStart {
  if (!uid) throw new Error('uid required');
  const entry = findCatalogEntry(catalogId);
  if (!entry) throw new Error('unknown catalog id');
  _assertProductionInstallBoundary(uid, entry);
  assertConnectorRuntimeEnabled(catalogId);
  _assertNoInstalledSiblingVariant(uid, entry);
  // Validate before accepting the detached browser flow so malformed tenant data returns through
  // the initiating IPC instead of becoming a delayed OAuth failure notification.
  let normalized = connectionParameters;
  if (entry.auth_mode === 'local_api') {
    normalizeLocalApiConnectionInput(entry, connectionParameters);
  } else {
    normalized = resolveCatalogConnection(entry, connectionParameters).parameters;
  }

  const localCliAttemptKey = entry.auth_mode === 'local_cli'
    ? _runtimeKey(uid, catalogId)
    : '';
  if (localCliAttemptKey) {
    const activeAttemptId = _localCliConnectAttempts.get(localCliAttemptKey);
    if (activeAttemptId) return { attempt_id: activeAttemptId };
  }

  const attemptId = crypto.randomUUID();
  const startedAt = Date.now();
  const runtimeEpoch = _runtimeEpoch;
  const reportOutcome = (outcome: OAuthConnectOutcome) => {
    if (runtimeEpoch !== _runtimeEpoch) return;
    broadcastOAuthConnectOutcome(outcome);
  };
  if (localCliAttemptKey) _localCliConnectAttempts.set(localCliAttemptKey, attemptId);
  void connectViaOAuth(uid, catalogId, {
    attemptId,
    ...(normalized ? { connectionParameters: normalized } : {}),
  }).then((instance) => {
    const failureMessage = instance.status.kind === 'error' || instance.status.kind === 'degraded'
      ? (instance.status.message || 'connector transport error')
      : '';
      reportOutcome({
      attempt_id: attemptId,
      catalog_id: catalogId,
      result: failureMessage ? 'failure' : 'success',
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(failureMessage ? { code: 'mcp_connect_failed', error: failureMessage } : {}),
    });
  }).catch((err) => {
    const code = _oauthConnectErrorCode(err);
    if (code === 'flow_timeout') {
      log.info('connector authorization expired without callback', { catalog_id: catalogId });
      return;
    }
    const cancelled = code === 'user_cancelled' || code === 'superseded';
    const authorizationDetail = entry.auth_mode === 'local_cli' && code === 'local_cli_authorization_failed'
      ? sanitizeAuthorizationDetail((err as { authorization_detail?: unknown } | null)?.authorization_detail)
      : '';
    reportOutcome({
      attempt_id: attemptId,
      catalog_id: catalogId,
      result: cancelled ? 'cancelled' : 'failure',
      duration_ms: Math.max(0, Date.now() - startedAt),
      code,
      error: String((err as Error | null)?.message || err || 'connector authorization failed'),
      ...(authorizationDetail ? { authorization_detail: authorizationDetail } : {}),
    });
  }).finally(() => {
    if (localCliAttemptKey && _localCliConnectAttempts.get(localCliAttemptKey) === attemptId) {
      _localCliConnectAttempts.delete(localCliAttemptKey);
    }
  });
  return { attempt_id: attemptId };
}

async function _provisionComposioInstance(
  uid: string,
  entry: CatalogEntry,
  composioGrant: ComposioGrant,
  runtimeEpoch: number,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  await _closeDiscoveredConnection(uid, entry.id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);
  const draft: ConnectorInstance = {
    ..._composioInstanceDraft(entry, composioGrant),
  };
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft, undefined, runtimeEpoch);
}

/** Provision (or replace) a single instance for a non-bundle catalog entry. Pulled out of
 *  `connectViaOAuth` so the bundle branch can loop over members. Caller has already obtained
 *  the OAuth grant. */
async function _provisionMemberInstance(
  uid: string,
  entry: CatalogEntry,
  grant: OAuthGrant,
  dcrClient: ConnectorInstance['dcr_client'],
  runtimeEpoch: number,
  connectionParameters?: Record<string, string>,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  const transport = applyTemplate(entry, grant);

  // Tear down any prior live connection for the same id before re-using the slot.
  await _closeDiscoveredConnection(uid, entry.id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);

  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    oauth_grant: grant,
    ...(connectionParameters ? { connection_parameters: connectionParameters } : {}),
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
  _assertRuntimeEpoch(runtimeEpoch);
  if (_isGitHubEntry(entry)) {
    await registry.setReauthorizeHint(uid, entry.id, true);
  }
  return _connectAndCacheTools(uid, draft, undefined, runtimeEpoch);
}

async function _provisionLocalCliInstance(
  uid: string,
  entry: CatalogEntry,
  runtimeEpoch: number,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  await _closeDiscoveredConnection(uid, entry.id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);
  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport: localCliTransport(uid, entry),
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft, undefined, runtimeEpoch);
}

async function _provisionLocalApiInstance(
  uid: string,
  entry: CatalogEntry,
  connectionParameters: Record<string, string>,
  runtimeEpoch: number,
): Promise<ConnectorInstance> {
  _assertRuntimeEpoch(runtimeEpoch);
  await _closeDiscoveredConnection(uid, entry.id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);
  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport: localApiStoredTransport(uid, entry),
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    connection_parameters: connectionParameters,
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft, undefined, runtimeEpoch);
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
  const runtimeEpoch = _runtimeEpoch;
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
  log.info('custom connector add', { id: 'custom', kind: transport.kind });
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft, undefined, runtimeEpoch);
}

export async function removeInstance(
  uid: string, id: string, options: { disconnectRemote?: boolean } = {},
): Promise<boolean> {
  if (!uid) return false;
  const runtimeEpoch = _runtimeEpoch;
  const entry = findCatalogEntry(id);
  _assertRuntimeEpoch(runtimeEpoch);
  await _closeDiscoveredConnection(uid, id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);
  if (entry?.auth_mode === 'local_cli') await removeLocalCliAuthorization(uid, entry);
  _assertRuntimeEpoch(runtimeEpoch);
  if (entry?.auth_mode === 'local_api') removeLocalApiAuthorization(uid, entry);
  if (options.disconnectRemote !== false) {
    await _deleteComposioConnectionOnServer(id, registry.load(uid).connections[id]?.composio_grant);
  }
  _assertRuntimeEpoch(runtimeEpoch);
  return registry.remove(uid, id);
}

/** Clear local API-key connections without network access when changing credentials. */
export async function removeApiKeyConnectors(uid: string): Promise<number> {
  if (!uid) return 0;
  const ids = Object.values(registry.load(uid).connections)
    .filter((instance) => findCatalogEntry(instance.id)?.auth_mode === 'composio')
    .map((instance) => instance.id);
  let removed = 0;
  for (const id of ids) {
    if (await removeInstance(uid, id, { disconnectRemote: false })) removed += 1;
  }
  return removed;
}

export async function refreshTools(uid: string, id: string): Promise<ToolSchema[]> {
  if (!uid) throw new Error('uid required');
  const runtimeEpoch = _runtimeEpoch;
  assertConnectorRuntimeEnabled(id);
  const inst = getInstance(uid, id);
  if (!inst) throw new Error('instance not found');
  if (registry.hasUnavailableSecrets(inst)) throw _secretsUnavailableError(id);
  const entry = findCatalogEntry(id);
  if (entry) await preflightConnectorCredits(entry, 'tool_call');
  // Force refresh-token check by tearing the live conn down and reconnecting through
  // _connectAndCacheTools (which re-resolves transport with a fresh access_token).
  await _closeDiscoveredConnection(uid, id, runtimeEpoch);
  _assertRuntimeEpoch(runtimeEpoch);
  const updated = await _connectAndCacheTools(uid, inst, undefined, runtimeEpoch);
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
  const runtimeKey = _runtimeKey(uid, 'gsheets');
  const conn = _conns.get(runtimeKey);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(runtimeKey);
  }
  return picked.pickedFileIds;
}

export async function callTool(
  uid: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<unknown> {
  if (!uid) throw new Error('uid required');
  if (isConnectorActionBlocked(id, name)) throw new Error('E_CONNECTOR_ACTION_UNAVAILABLE: this action is not available in Orkas');
  const runtimeEpoch = _runtimeEpoch;
  if (opts.signal?.aborted) throw _connectorCancelledError(opts.signal.reason);
  assertConnectorRuntimeEnabled(id);
  let inst = getInstance(uid, id);
  if (!inst) throw new Error('instance not found');
  if (registry.hasUnavailableSecrets(inst)) throw _secretsUnavailableError(id);
  const toolsCacheStale = _isToolsCacheStale(inst);
  // Circuit breaker. Each connect attempt is bounded on its own (3 tries in
  // `postConnectorBridgeJson`), but nothing bounded them *across* calls: a degraded connector is
  // still routed to the model, so every tool call re-ran the full refresh — 3 requests each, with
  // no ceiling — against a backend already known to be failing. An agent turn could fire dozens,
  // and a restart reset the count. While the circuit is open we fail fast here: no credits
  // preflight, no refresh, no spawn, zero network. It is also the better answer for the caller —
  // an instant honest error beats ~1.6s of doomed retries.
  //
  // A live connection wins over the cooldown: the circuit governs *reconnecting*, not a socket
  // that is already up and working.
  const runtimeKey = _runtimeKey(uid, id);
  const liveConn = _conns.get(runtimeKey);
  const grantForCooldown = inst.oauth_grant;
  const grantStale = !!(grantForCooldown?.expires_at
    && grantForCooldown.expires_at - Date.now() <= REFRESH_BUFFER_MS);
  if ((toolsCacheStale || !liveConn?.isConnected || grantStale) && _isInRetryCooldown(inst)) {
    log.info('connector in retry cooldown; failing fast without touching the network', {
      id,
      failures: _consecutiveFailures(inst),
    });
    throw new Error(_cooldownMessage(id, inst));
  }
  const entry = findCatalogEntry(id);
  if (entry?.allowed_tools?.length && !entry.allowed_tools.includes(name)) {
    throw new Error(`connector_tool_not_allowed: ${id}/${name}`);
  }
  if (entry?.tool_policies && !entry.tool_policies[name]) {
    throw new Error(`connector_tool_policy_missing: ${id}/${name}`);
  }
  if (entry) await preflightConnectorCredits(entry, 'tool_call');
  _assertRuntimeEpoch(runtimeEpoch);
  if (opts.signal?.aborted) throw _connectorCancelledError(opts.signal.reason);
  // Stale-token guard: the transport snapshots the bearer at connect time (for streamable-http)
  // or injects it into env at spawn time (for stdio). A long-lived connection past the
  // `expires_at` deadline will keep using the dead token on every request — fine for short-lived
  // chats (1h Gmail TTL is rarely exceeded inside one conversation) but breaks "leave PC open
  // overnight" use cases. Detect staleness, tear down + reconnect; `_resolveTransport` calls
  // `_refreshGrantIfStale` which rotates the token before applyTemplate rebuilds the transport
  // with the fresh one. Same `REFRESH_BUFFER_MS` window the refresh path uses.
  const grant = inst.oauth_grant;
  const stale = !!(grant && grant.expires_at && grant.expires_at - Date.now() <= REFRESH_BUFFER_MS);
  let conn = _conns.get(runtimeKey);
  if ((stale || toolsCacheStale) && conn) {
    log.info('connector state stale; tearing down only this instance before reconnect', {
      id,
      stale_grant: stale,
      stale_tools: toolsCacheStale,
    });
    await _closeDiscoveredConnection(uid, id, runtimeEpoch, opts.signal);
    _assertRuntimeEpoch(runtimeEpoch);
    conn = undefined;
  }
  if (!conn || !conn.isConnected) {
    const updated = await _waitForConnectorOrAbort(
      _connectAndCacheTools(uid, inst, undefined, runtimeEpoch), opts.signal,
    );
    conn = _conns.get(runtimeKey);
    if (!conn?.isConnected) throw new Error(_connectFailureMessage(id, updated));
  }
  _assertRuntimeEpoch(runtimeEpoch);
  try {
    const requestOpts = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(inst.composio_grant ? { timeoutMs: COMPOSIO_CALL_TOOL_TIMEOUT_MS } : {}),
    };
    const result = Object.keys(requestOpts).length
      ? await conn.callTool(name, args, requestOpts)
      : await conn.callTool(name, args);
    _assertRuntimeEpoch(runtimeEpoch);
    return result;
  } catch (err) {
    _assertRuntimeEpoch(runtimeEpoch);
    const cancelled = opts.signal?.aborted || (err as Error)?.name === 'AbortError';
    const transient = !cancelled && _isTransientConnectorFailure(err);
    const hardAuth = !cancelled && !!entry
      && (_isGoogleAuthFailure(entry, err) || _isDcrAuthFailure(entry, err));
    const invalidate = cancelled || transient || hardAuth;
    if (invalidate) {
      const current = _conns.get(runtimeKey);
      if (current === conn) {
        _conns.delete(runtimeKey);
        try { await current.close(); } catch { /* close already logs */ }
      }
    }
    if (transient) {
      try {
        const current = registry.load(uid).connections[id] || inst;
        await _markDegradedOnTransientFailure(uid, current, err, 'tool_call');
      } catch (statusErr) {
        log.warn('failed to persist connector tool-call degradation', {
          id,
          error: logErrorSummary(statusErr),
        });
      }
    } else if (hardAuth) {
      try { await _markAuthorizationError(uid, id, (err as Error).message, 'tool_call_auth_failed'); }
      catch { /* primary tool error still wins */ }
    }
    if (cancelled) throw _connectorCancelledError(opts.signal?.reason || err);
    throw err;
  }
}

function _connectorCancelledError(_reason: unknown): Error & { code: string } {
  const error = new Error('connector tool call cancelled') as Error & { code: string };
  error.name = 'AbortError';
  error.code = 'E_TOOL_CALL_CANCELLED';
  return error;
}

async function _waitForConnectorOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw _connectorCancelledError(signal.reason);
  let listener: (() => void) | null = null;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(_connectorCancelledError(signal.reason));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
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
  const all = _detachConnectorRuntime();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
}
