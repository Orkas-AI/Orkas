/**
 * Permission gate for bridge connector calls (plan §D4 — LAUNCH BLOCKER:
 * the bridge must never forward side-effectful connector calls on
 * auto-allow).
 *
 * Every `connectors.call` arriving over the bridge socket is gated here:
 *   1. The per-agent "always allow" store grants silently when the user
 *      previously chose remember-for-this-connector.
 *   2. Otherwise a `bridge:permission` push event asks the renderer to
 *      show the allow-once / always-allow / deny dialog; the renderer
 *      answers through the `bridge.permission_response` IPC.
 *   3. No answer within the timeout (user away / window closed) → DENY.
 *      The CLI agent gets a structured error it can relay.
 *
 * Why all calls and not just "writes": classifying an arbitrary MCP tool
 * as read vs write from its name is a heuristic that fails open. One
 * confirmation per (agent, connector) with a remember option keeps the
 * friction to a single click without the misclassification risk.
 *
 * Store: `<uid>/local/config/bridge-permissions.json` — machine-private
 * (an "always allow" granted on this machine must not silently apply on
 * another device).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userLocalConfigDir } from '../../paths';
import { createLogger } from '../../logger';

const log = createLogger('bridge-permissions');

const RESPONSE_TIMEOUT_MS = 120 * 1000;

interface StoreFile {
  version: 1;
  /** agents[agent_id].connectors[connector_id] === 'allow' — the only
   *  persisted verdict; denies are never remembered (a deny should not
   *  permanently brick the connector without a UI to undo it). */
  agents: Record<string, { connectors: Record<string, 'allow'> }>;
}

function storeFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'bridge-permissions.json');
}

function readStore(uid: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(uid), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object') {
      return { version: 1, agents: parsed.agents };
    }
  } catch { /* missing / corrupt → empty */ }
  return { version: 1, agents: {} };
}

function writeStore(uid: string, store: StoreFile): void {
  const p = storeFile(uid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function hasAlwaysAllow(uid: string, agentId: string, connectorId: string): boolean {
  return readStore(uid).agents[agentId]?.connectors?.[connectorId] === 'allow';
}

export function recordAlwaysAllow(uid: string, agentId: string, connectorId: string): void {
  const store = readStore(uid);
  const agent = store.agents[agentId] || { connectors: {} };
  agent.connectors[connectorId] = 'allow';
  store.agents[agentId] = agent;
  writeStore(uid, store);
  log.info('always-allow recorded', { agentId, connectorId });
}

// ── Pending requests ─────────────────────────────────────────────────────

export interface PermissionRequestInfo {
  request_id: string;
  agent_id: string;
  agent_name: string;
  connector_id: string;
  connector_name: string;
  tool_name: string;
  cid: string;
}

interface Pending {
  info: PermissionRequestInfo;
  uid: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

const _pending = new Map<string, Pending>();

/** Lazy ipc lookup — same pattern `connectors/registry.ts` uses for
 *  `connectors:changed`; avoids a static feature→ipc import cycle and
 *  degrades cleanly in tests / OrkasOpen builds without the IPC bridge. */
function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) {
    _broadcastOverride(channel, payload);
    return true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: capture the `bridge:permission` push without loading the
 *  electron-backed ipc module. Pass null to restore the default. */
let _broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => void) | null): void {
  _broadcastOverride = fn;
}

/**
 * Gate one bridge connector call. Resolves true (allowed) / false.
 * Never throws — a broken push channel degrades to deny-after-timeout.
 */
export async function requestPermission(opts: {
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  connectorId: string;
  connectorName: string;
  toolName: string;
}): Promise<boolean> {
  if (hasAlwaysAllow(opts.uid, opts.agentId, opts.connectorId)) return true;

  const requestId = crypto.randomBytes(8).toString('hex');
  const info: PermissionRequestInfo = {
    request_id: requestId,
    agent_id: opts.agentId,
    agent_name: opts.agentName,
    connector_id: opts.connectorId,
    connector_name: opts.connectorName,
    tool_name: opts.toolName,
    cid: opts.cid,
  };

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(requestId);
      log.warn('permission request timed out → deny', { requestId, connectorId: opts.connectorId });
      resolve(false);
    }, RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _pending.set(requestId, { info, uid: opts.uid, resolve, timer });
    if (!_broadcast('bridge:permission', info)) {
      log.warn('no renderer broadcast available — permission will deny on timeout', { requestId });
    }
  });
}

/** Renderer answer (via `bridge.permission_response`). Unknown ids are
 *  ignored (stale dialog after timeout). */
export function respond(requestId: string, allow: boolean, always: boolean): boolean {
  const pending = _pending.get(requestId);
  if (!pending) return false;
  _pending.delete(requestId);
  clearTimeout(pending.timer);
  if (allow && always) {
    try { recordAlwaysAllow(pending.uid, pending.info.agent_id, pending.info.connector_id); }
    catch (err) { log.warn(`always-allow persist failed: ${(err as Error).message}`); }
  }
  pending.resolve(allow);
  return true;
}

/** Abandon every pending request for a conversation (run ended / aborted). */
export function cancelForCid(cid: string): void {
  for (const [id, pending] of _pending) {
    if (pending.info.cid !== cid) continue;
    _pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
}
