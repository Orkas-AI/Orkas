/** Host-owned confirmation gate for one sensitive connector action.
 *
 * Sensitive actions use the account's operation permission mode. Approval
 * modes accept a one-time or task-scoped connector-account decision; trusted
 * mode executes without a dialog. Connector availability and prohibited actions
 * are separate gates.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';
import { getLocalExecMode } from '../permissions';
import { getActiveUserId } from '../users';
import { registerUserSwitchHook } from '../user-switch-hooks';
import { findCatalogEntry } from './catalog';
import type { ConnectorInstance } from './types';

const log = createLogger('connector-action-confirm');
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PREVIEW_CHARS = 8_000;
const MAX_PREVIEW_DEPTH = 6;
const MAX_PREVIEW_ITEMS = 25;
const SECRET_KEY_RE = /(?:^|_)(?:access_?token|api_?key|authorization|client_?secret|password|refresh_?token|secret)(?:$|_)/i;

export interface ActionConfirmInfo {
  request_id: string;
  connector_id: string;
  display_name: string;
  account_label: string;
  tool_name: string;
  action_name: string;
  risk: 'H' | 'D';
  sensitive_operation: string;
  arguments_preview: string;
  cid: string;
  can_allow_run: boolean;
}

interface GrantScope {
  uid: string;
  cid: string;
  connectorId: string;
  accountLabel: string;
  accountKey: string;
}

interface Pending extends GrantScope {
  heartbeat?: NodeJS.Timeout;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

const _pending = new Map<string, Pending>();
// One connection slot owns one account. Registry replacement/removal invalidates
// these grants, including local CLI accounts with no display label or OAuth id.
const _taskGrants = new Map<string, GrantScope>();

function grantKey(scope: GrantScope): string {
  return JSON.stringify([scope.uid, scope.cid, scope.connectorId, scope.accountLabel, scope.accountKey]);
}

/** Stable host-owned identity, unaffected by token refresh or tool-cache updates.
 * Registry replacement additionally revokes local CLI grants without account ids.
 */
export function connectorAccountKey(instance: ConnectorInstance): string {
  return JSON.stringify([instance.created_at, instance.composio_grant?.connection_id,
    instance.oauth_grant?.server_grant_id, instance.connection_parameters]);
}

let _broadcastOverride: ((channel: string, payload: unknown) => void | boolean) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => void | boolean) | null): void {
  _broadcastOverride = fn;
}

function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) {
    return _broadcastOverride(channel, payload) !== false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (name: string, value: unknown) => boolean };
    if (!ipc.broadcastToRenderer) return false;
    return ipc.broadcastToRenderer(channel, payload) === true;
  } catch {
    return false;
  }
}

function _previewValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_PREVIEW_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_PREVIEW_ITEMS).map((item) => _previewValue(item, depth + 1));
    if (value.length > MAX_PREVIEW_ITEMS) out.push(`[+${value.length - MAX_PREVIEW_ITEMS} more]`);
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_PREVIEW_ITEMS)) {
      out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : _previewValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return value;
}

export function previewArguments(argumentsValue: Record<string, unknown>): string {
  let preview = '{}';
  try {
    preview = JSON.stringify(_previewValue(argumentsValue), null, 2) || '{}';
  } catch {
    preview = '{\n  "preview": "unavailable"\n}';
  }
  return preview.length > MAX_PREVIEW_CHARS
    ? `${preview.slice(0, MAX_PREVIEW_CHARS)}\n…`
    : preview;
}

function actionName(connectorId: string, toolName: string, args: Record<string, unknown>): string {
  const entry = findCatalogEntry(connectorId);
  // First-party CLI and direct API adapters dispatch these lanes by `action`.
  // Other MCP tools may have unrelated action/actions parameters: keep their tool name.
  if ((entry?.auth_mode === 'local_cli' || entry?.auth_mode === 'local_api')
    && ['execute_high_impact', 'execute_destructive'].includes(toolName)
    && typeof args.action === 'string' && args.action.trim()) {
    return _previewValue(args.action.trim()) as string;
  }
  return toolName;
}

function _settle(requestId: string, approved: boolean): boolean {
  const pending = _pending.get(requestId);
  if (!pending) return false;
  _pending.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.heartbeat) clearInterval(pending.heartbeat);
  pending.removeAbortListener?.();
  pending.resolve(approved);
  return true;
}

export async function requestActionConfirm(opts: {
  userId?: string;
  onWaiting?: (elapsedMs: number) => void;
  cid?: string;
  connectorId: string;
  displayName: string;
  accountLabel?: string;
  accountKey?: string;
  toolName: string;
  risk: 'H' | 'D';
  sensitiveOperation?: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (opts.signal?.aborted) return false;
  const uid = opts.userId || getActiveUserId();
  if (uid !== getActiveUserId()) return false;
  if (getLocalExecMode() === 'all_files_auto') return true;
  const scope: GrantScope = {
    uid, cid: opts.cid || '', connectorId: opts.connectorId, accountLabel: opts.accountLabel || '',
    accountKey: opts.accountKey || '',
  };
  if (scope.cid && _taskGrants.has(grantKey(scope))) return true;
  const requestId = crypto.randomBytes(12).toString('hex');
  const info: ActionConfirmInfo = {
    request_id: requestId,
    connector_id: opts.connectorId,
    display_name: opts.displayName,
    account_label: opts.accountLabel || '',
    tool_name: opts.toolName,
    action_name: actionName(opts.connectorId, opts.toolName, opts.args),
    risk: opts.risk,
    sensitive_operation: opts.sensitiveOperation || '',
    arguments_preview: previewArguments(opts.args),
    cid: scope.cid,
    can_allow_run: !!scope.cid,
  };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!_settle(requestId, false)) return;
      log.warn('sensitive connector confirmation timed out', {
        connector_id: opts.connectorId,
        tool: opts.toolName,
      });
      _broadcast('connectors:action-confirm-cancelled', { request_ids: [requestId], cid: info.cid });
    }, RESPONSE_TIMEOUT_MS);
    timer.unref?.();
    const pending: Pending = { ...scope, resolve, timer };
    if (opts.signal) {
      const abort = () => {
        if (!_settle(requestId, false)) return;
        _broadcast('connectors:action-confirm-cancelled', { request_ids: [requestId], cid: info.cid });
      };
      opts.signal.addEventListener('abort', abort, { once: true });
      pending.removeAbortListener = () => opts.signal?.removeEventListener('abort', abort);
    }
    _pending.set(requestId, pending);
    if (!_broadcast('connectors:action-confirm', info)) {
      log.warn('no renderer available for sensitive connector confirmation', {
        connector_id: opts.connectorId,
        tool: opts.toolName,
      });
      _settle(requestId, false);
      return;
    }
    if (opts.onWaiting && _pending.has(requestId)) {
      const startedAt = Date.now();
      const notify = () => {
        try { opts.onWaiting?.(Date.now() - startedAt); }
        catch { log.warn('connector confirmation waiting callback failed'); }
      };
      notify();
      if (!_pending.has(requestId)) return;
      pending.heartbeat = setInterval(notify, 25_000);
      pending.heartbeat.unref?.();
    }
  });
}

export function respond(requestId: string, approved: boolean, scope: 'once' | 'task' = 'once'): boolean {
  const pending = _pending.get(requestId);
  if (!pending || pending.uid !== getActiveUserId()) return false;
  if (!approved || scope === 'once') return _settle(requestId, approved);
  if (scope !== 'task' || !pending.cid) return false;
  const key = grantKey(pending);
  _taskGrants.set(key, {
    uid: pending.uid, cid: pending.cid, connectorId: pending.connectorId,
    accountLabel: pending.accountLabel, accountKey: pending.accountKey,
  });
  _settle(requestId, true);
  // Concurrent callers may already be waiting in the renderer queue. Resolve
  // them under the same grant and dismiss their stale dialogs as approved.
  const requestIds: string[] = [];
  for (const [id, other] of _pending) {
    if (grantKey(other) !== key) continue;
    requestIds.push(id);
    _settle(id, true);
  }
  if (requestIds.length) {
    _broadcast('connectors:action-confirm-cancelled', { request_ids: requestIds, cid: pending.cid, approved: true });
  }
  return true;
}

function cancelMatching(matches: (scope: GrantScope) => boolean, context: { cid?: string } = {}): void {
  for (const [key, grant] of _taskGrants) {
    if (matches(grant)) _taskGrants.delete(key);
  }
  const requestIds: string[] = [];
  for (const [requestId, pending] of _pending) {
    if (!matches(pending)) continue;
    requestIds.push(requestId);
    _settle(requestId, false);
  }
  if (requestIds.length) {
    _broadcast('connectors:action-confirm-cancelled', { request_ids: requestIds, ...context });
  }
}

export function cancelForCid(cid: string): void {
  cancelMatching((scope) => scope.cid === cid, { cid });
}

export function cancelForConnector(uid: string, connectorId: string): void {
  cancelMatching((scope) => scope.uid === uid && scope.connectorId === connectorId);
}

registerUserSwitchHook('connector-action-confirm', (previousUid) => {
  cancelMatching((scope) => scope.uid === previousUid);
});
