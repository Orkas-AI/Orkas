/**
 * Blocking permission gate for sensitive local operations under approval
 * access modes (features/permissions.ts).
 *
 * Uses the same push → renderer dialog → IPC response pattern as the
 * external-CLI permission gate, with two differences:
 *
 *   1. THREE outcomes — `allow_once`, `allow_run`, `deny` — not a boolean.
 *   2. NO persistent store. A task-scoped grant is memory-only and bounded to
 *      one (user, conversation, agent) plus the risk categories the user saw.
 *      Privilege/security weakening and external-system mutations always stay
 *      exact-command decisions.
 *
 * Never throws: a broken push channel degrades to deny, so a risky command can
 * never silently run because the dialog failed to show. Once the prompt is
 * delivered, waiting for user action is intentionally not auto-timed-out here;
 * callers can emit progress heartbeats so model/tool idle watchdogs do not
 * count human approval time as tool inactivity.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';
import { maskId } from '../../util/log-redact';
import { registerUserSwitchHook } from '../../features/user-switch-hooks';
import type { IrreversibleAction, RiskCategory } from './bash-risk';
import type { ExternalMutationFinding } from './external-mutation-risk';

const log = createLogger('bash-permissions');

export type BashDecision = 'allow_once' | 'allow_run' | 'deny';

const TASK_GRANTABLE_REASONS = new Set<RiskCategory>([
  'network_egress',
  'destructive',
  'sensitive_path',
  'system_package_change',
]);

// Keep watchdogs alive while the tool is waiting for a human to click the
// renderer dialog. This is not a safety timeout: it only drives optional
// caller progress callbacks.
const WAITING_HEARTBEAT_MS = 25_000;
/** Renderer dialog command preview cap — the user must see what will run, but
 *  an unbounded command would bloat the push payload. */
const COMMAND_PREVIEW_MAX = 800;
// ── Pending requests ─────────────────────────────────────────────────────────

export interface BashPermissionInfo {
  request_id: string;
  agent_id: string;
  agent_name: string;
  /** Truncated for display; the user sees what is about to run. */
  command: string;
  /** Optional non-shell operation name, e.g. read_file/list_files. */
  operation?: string;
  /** Optional subject for non-shell operations, typically a path. */
  subject?: string;
  reasons: RiskCategory[];
  /** A path could not be determined before execution; approval is one-time. */
  unresolved_paths?: boolean;
  /** Why this is being asked at all in a mode that otherwise skips prompts:
   *  the step cannot be reviewed or undone once it runs. Empty/absent for an
   *  ordinary sensitive operation. */
  irreversible?: IrreversibleAction[];
  /** Main-process eligibility decision; stale renderers cannot widen it. */
  can_allow_run: boolean;
  /** Structured, bounded external actions detected inside the command/script. */
  external_mutations?: ExternalMutationFinding[];
  cid: string;
}

interface Pending {
  uid: string;
  cid: string;
  agentId: string;
  reasons: RiskCategory[];
  canAllowRun: boolean;
  resolve: (d: BashDecision) => void;
  heartbeat?: NodeJS.Timeout;
}

const _pending = new Map<string, Pending>();
type RunGrant = { uid: string; cid: string; agentId: string; reasons: Set<RiskCategory> };
const _runGrants = new Map<string, RunGrant>();

function runGrantKey(uid: string, cid: string, agentId: string): string {
  return JSON.stringify([uid, cid, agentId]);
}

const COMMANDER_GRANT_ACTOR = '__orkas_commander__';

function grantActorId(agentId: string, agentName: string): string {
  const explicit = String(agentId || '').trim();
  if (explicit) return explicit;
  const name = String(agentName || '').trim().toLowerCase();
  // The top-level Commander is represented by an empty agent_id in the real
  // chat pipeline. Give only that known actor a stable internal scope key;
  // arbitrary anonymous agents remain ineligible for task-wide grants.
  if (name === 'commander' || name === 'orkas_chat') return COMMANDER_GRANT_ACTOR;
  return '';
}

function canAllowRun(uid: string, cid: string, agentId: string, reasons: readonly RiskCategory[]): boolean {
  return !!uid && !!cid && !!agentId && reasons.length > 0
    && reasons.every((reason) => TASK_GRANTABLE_REASONS.has(reason));
}

function isCoveredByRunGrant(uid: string, cid: string, agentId: string, reasons: readonly RiskCategory[]): boolean {
  if (!canAllowRun(uid, cid, agentId, reasons)) return false;
  const grant = _runGrants.get(runGrantKey(uid, cid, agentId));
  return !!grant && reasons.every((reason) => grant.reasons.has(reason));
}

// Lazy ipc lookup — avoids a static model→ipc import cycle and degrades
// cleanly in tests / headless builds.
type BroadcastOverride = (channel: string, payload: unknown) => void | boolean;
let _broadcastOverride: BroadcastOverride | null = null;
export function _setBroadcastForTest(fn: BroadcastOverride | null): void {
  _broadcastOverride = fn;
}
export function _resetForTest(): void {
  for (const [, p] of _pending) {
    if (p.heartbeat) clearInterval(p.heartbeat);
  }
  _pending.clear();
  _runGrants.clear();
}

function _broadcast(channel: string, payload: unknown): boolean {
  try {
    // A test override may explicitly return false to emulate a headless build
    // with no renderer. Treat override failures exactly like production IPC
    // failures: the permission request must fail closed instead of rejecting.
    if (_broadcastOverride) return _broadcastOverride(channel, payload) !== false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => boolean };
    if (!ipc.broadcastToRenderer) return false;
    return ipc.broadcastToRenderer(channel, payload);
  } catch { return false; }
}

/**
 * Gate one risky local operation. A matching task grant resolves immediately;
 * otherwise wait for the explicit renderer response. Deny on a broken push
 * channel.
 */
export async function requestBashDecision(opts: {
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  command: string;
  operation?: string;
  subject?: string;
  reasons: RiskCategory[];
  irreversible?: IrreversibleAction[];
  unresolvedPaths?: boolean;
  externalMutations?: ExternalMutationFinding[];
  onWaiting?: (elapsedMs: number) => void;
}): Promise<BashDecision> {
  const reasons = [...new Set(opts.reasons)];
  const actorId = grantActorId(opts.agentId, opts.agentName);
  if (!opts.unresolvedPaths && isCoveredByRunGrant(opts.uid, opts.cid, actorId, reasons)) {
    log.info('bash permission covered by task grant', {
      cid: maskId(opts.cid),
      agent_id: maskId(opts.agentId),
      reasons,
      command_chars: opts.command.length,
    });
    return 'allow_run';
  }
  const taskGrantEligible = !opts.unresolvedPaths && canAllowRun(opts.uid, opts.cid, actorId, reasons);
  const requestId = crypto.randomBytes(8).toString('hex');
  const command = opts.command.length > COMMAND_PREVIEW_MAX
    ? `${opts.command.slice(0, COMMAND_PREVIEW_MAX)}…`
    : opts.command;
  const info: BashPermissionInfo = {
    request_id: requestId,
    agent_id: opts.agentId,
    agent_name: opts.agentName || opts.agentId,
    command,
    ...(opts.operation ? { operation: opts.operation } : {}),
    ...(opts.subject ? { subject: opts.subject } : {}),
    reasons,
    ...(opts.unresolvedPaths ? { unresolved_paths: true } : {}),
    ...(opts.irreversible?.length ? { irreversible: [...new Set(opts.irreversible)] } : {}),
    can_allow_run: taskGrantEligible,
    ...(opts.externalMutations?.length ? { external_mutations: opts.externalMutations.slice(0, 8) } : {}),
    cid: opts.cid,
  };

  // Privacy: log bounded risk facts + length, never command/path text (CLAUDE.md).
  log.info('bash permission requested', {
    request_id: maskId(requestId),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    reasons,
    unresolved_paths: opts.unresolvedPaths === true,
    command_chars: opts.command.length,
  });

  return new Promise<BashDecision>((resolve) => {
    const startedAt = Date.now();
    const notifyWaiting = () => {
      if (!opts.onWaiting) return;
      try { opts.onWaiting(Date.now() - startedAt); }
      catch (err) { log.warn('bash permission waiting callback failed', { request_id: maskId(requestId), error: (err as Error)?.message || String(err) }); }
    };
    const pending: Pending = {
      uid: opts.uid,
      cid: opts.cid,
      agentId: actorId,
      reasons,
      canAllowRun: taskGrantEligible,
      resolve,
    };
    _pending.set(requestId, pending);
    if (!_broadcast('bash:permission', info)) {
      _pending.delete(requestId);
      log.warn('no renderer broadcast available — bash permission denied', { request_id: maskId(requestId) });
      resolve('deny');
      return;
    }
    notifyWaiting();
    if (opts.onWaiting) {
      const heartbeat = setInterval(notifyWaiting, WAITING_HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      pending.heartbeat = heartbeat;
    }
  });
}

/** Renderer answer (via `bash.permission_response`). Unknown ids are ignored
 *  (stale dialog after timeout). Returns true when a pending request was
 *  resolved. */
export function respond(requestId: string, decision: BashDecision): boolean {
  const pending = _pending.get(requestId);
  if (!pending) return false;
  _pending.delete(requestId);
  if (pending.heartbeat) clearInterval(pending.heartbeat);
  let effectiveDecision = decision;
  if (decision === 'allow_run') {
    if (!pending.canAllowRun) {
      effectiveDecision = 'allow_once';
    } else {
      const key = runGrantKey(pending.uid, pending.cid, pending.agentId);
      const grant = _runGrants.get(key) ?? {
        uid: pending.uid,
        cid: pending.cid,
        agentId: pending.agentId,
        reasons: new Set<RiskCategory>(),
      };
      for (const reason of pending.reasons) grant.reasons.add(reason);
      _runGrants.set(key, grant);
    }
  }
  pending.resolve(effectiveDecision);
  return true;
}

/** Abandon every pending request and task grant for a conversation. Pending
 *  requests resolve to `deny`. */
export function cancelForCid(cid: string): void {
  const requestIds: string[] = [];
  for (const [id, pending] of _pending) {
    if (pending.cid !== cid) continue;
    _pending.delete(id);
    if (pending.heartbeat) clearInterval(pending.heartbeat);
    requestIds.push(id);
    pending.resolve('deny');
  }
  if (requestIds.length) {
    _broadcast('bash:permission_cancelled', { request_ids: requestIds, cid });
  }
  for (const [key, grant] of _runGrants) {
    if (grant.cid === cid) _runGrants.delete(key);
  }
}

/** Account-switch boundary: pending dialogs and task grants owned by the
 * previous user must not survive into the next active account. */
export function cancelForUid(uid: string): void {
  const requestIds: string[] = [];
  for (const [id, pending] of _pending) {
    if (pending.uid !== uid) continue;
    _pending.delete(id);
    if (pending.heartbeat) clearInterval(pending.heartbeat);
    requestIds.push(id);
    pending.resolve('deny');
  }
  if (requestIds.length) {
    _broadcast('bash:permission_cancelled', { request_ids: requestIds, uid });
  }
  for (const [key, grant] of _runGrants) {
    if (grant.uid === uid) _runGrants.delete(key);
  }
}

registerUserSwitchHook('bash-permissions', (previousUid) => {
  cancelForUid(previousUid);
});
