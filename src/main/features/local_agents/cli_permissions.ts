/**
 * Blocking human approval bridge for external CLI permission requests.
 *
 * Backends translate native protocol approvals into one bounded request here;
 * the Orkas bridge routes connected-service actions through the same state
 * machine. Main pushes it to the renderer, waits for allow-once / allow-run /
 * deny, and fails closed when no renderer can receive the prompt. Task grants
 * are memory-only and owned by Orkas, so a resumed native CLI session cannot
 * carry an old approval into a later task.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger.js';
import { logErrorSummary, maskId } from '../../util/log-redact.js';
import { registerUserSwitchHook } from '../user-switch-hooks.js';
import type {
  LocalCliPermissionDecision,
  LocalCliPermissionRequest,
} from './backends/base.js';
import {
  localCliDefaultPermissionPolicy,
  localCliPermissionPolicies,
  type LocalCliPermissionPolicy,
  type LocalCliType,
} from './registry.js';

const log = createLogger('local-agents:permissions');
const WAITING_HEARTBEAT_MS = 25_000;
/** An unanswered prompt denies itself after this long. The wait is bounded
 *  by the host, not by whichever client asked: a CLI-side timeout that fires
 *  first must cancel the request (see `signal`), otherwise the user's late
 *  "allow" would run a side effect the model was already told had failed.
 *  Ten minutes matches the bridge's previous deny-on-timeout; two minutes was
 *  too easy to hit when the user stepped away. Tests shrink it through env. */
const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
export function permissionResponseTimeoutMs(): number {
  const raw = Number(process.env.ORKAS_LOCAL_AGENT_PERMISSION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESPONSE_TIMEOUT_MS;
}
const PREVIEW_MAX = 800;
const LABEL_MAX = 160;

interface Pending {
  uid: string;
  cid: string;
  runId: string;
  agentId: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
  kind: 'native' | 'connector';
  resolve: (decision: LocalCliPermissionDecision) => void;
  heartbeat?: NodeJS.Timeout;
  deadline?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
  responding?: boolean;
}

/** Detach the timers and abort listener of an entry that is leaving the
 *  pending map, whichever path retires it. */
function detach(entry: Pending): void {
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  if (entry.deadline) clearTimeout(entry.deadline);
  entry.heartbeat = undefined;
  entry.deadline = undefined;
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  entry.onAbort = undefined;
}

interface ActiveRun {
  uid: string;
  agentId: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
}

const pending = new Map<string, Pending>();
const allowedRuns = new Map<string, string>();
const activeRuns = new Map<string, ActiveRun>();
type BroadcastOverride = (channel: string, payload: unknown) => void | boolean;
let broadcastOverride: BroadcastOverride | null = null;

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function broadcast(channel: string, payload: unknown): boolean {
  try {
    if (broadcastOverride) return broadcastOverride(channel, payload) !== false;
    // Avoid a static features -> ipc cycle; the renderer channel is optional
    // in headless/test environments and a missing channel must deny.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (name: string, body: unknown) => boolean };
    return ipc.broadcastToRenderer?.(channel, payload) === true;
  } catch {
    return false;
  }
}

export async function requestPermission(opts: {
  uid: string;
  cid: string;
  runId: string;
  agentId: string;
  agentName: string;
  conversationTitle?: string;
  cli: LocalCliType;
  permissionPolicy?: LocalCliPermissionPolicy;
  permissionKind?: 'native' | 'connector';
  request: LocalCliPermissionRequest;
  onWaiting?: (elapsedMs: number) => void;
  /** Caller gave up (client-side timeout or MCP cancellation). The pending
   *  prompt is withdrawn and denied so the side effect can never run late. */
  signal?: AbortSignal;
}): Promise<LocalCliPermissionDecision> {
  if (opts.signal?.aborted) return 'deny';
  if (allowedRuns.get(opts.runId) === opts.uid) return 'allow_once';
  const activeRun = activeRuns.get(opts.runId);
  const permissionPolicy = activeRun
    && activeRun.uid === opts.uid
    && activeRun.agentId === opts.agentId
    && activeRun.cli === opts.cli
    ? activeRun.permissionPolicy
    : opts.permissionPolicy || localCliDefaultPermissionPolicy(opts.cli);
  const kind = opts.permissionKind === 'connector' ? 'connector' : 'native';
  // Full access is intentionally non-interactive for the CLI's own native
  // operations (files, shell, project scope). Backends normally handle this
  // before calling the host bridge; keep the bridge defensive so an adapter
  // regression cannot surface a misleading prompt or deadlock. Connector
  // actions reach the user's external accounts through Orkas and are never
  // auto-allowed by a policy level: only an explicit task grant or a fresh
  // answer approves them.
  if (permissionPolicy === 'full_access' && kind !== 'connector') return 'allow_once';
  const requestId = crypto.randomBytes(8).toString('hex');
  const payload = {
    request_id: requestId,
    cid: opts.cid,
    agent_id: opts.agentId,
    agent_name: bounded(opts.agentName || opts.agentId, LABEL_MAX),
    conversation_title: bounded(opts.conversationTitle, LABEL_MAX),
    cli: opts.cli,
    tool: bounded(opts.request.tool, LABEL_MAX),
    description: bounded(opts.request.description, PREVIEW_MAX),
    command: bounded(opts.request.command, PREVIEW_MAX),
    subject: bounded(opts.request.subject, PREVIEW_MAX),
    can_allow_run: true,
    permission_policy: permissionPolicy,
    permission_policies: [...localCliPermissionPolicies(opts.cli)],
    ...(opts.permissionKind === 'connector' ? { permission_kind: 'connector' } : {}),
  };

  log.info('external CLI permission requested', {
    request_id: maskId(requestId),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    cli: opts.cli,
    has_command: !!payload.command,
    has_subject: !!payload.subject,
  });

  return new Promise<LocalCliPermissionDecision>((resolve) => {
    const startedAt = Date.now();
    const notifyWaiting = () => {
      try { opts.onWaiting?.(Date.now() - startedAt); }
      catch (error) {
        log.warn('external CLI permission waiting callback failed', {
          request_id: maskId(requestId),
          error: logErrorSummary(error),
        });
      }
    };
    const entry: Pending = {
      uid: opts.uid,
      cid: opts.cid,
      runId: opts.runId,
      agentId: opts.agentId,
      cli: opts.cli,
      permissionPolicy,
      kind,
      resolve,
    };
    pending.set(requestId, entry);
    if (!broadcast('local-agent:permission', payload)) {
      pending.delete(requestId);
      log.warn('no renderer available — external CLI permission denied', {
        request_id: maskId(requestId),
        cli: opts.cli,
      });
      resolve('deny');
      return;
    }
    notifyWaiting();
    if (opts.onWaiting) {
      entry.heartbeat = setInterval(notifyWaiting, WAITING_HEARTBEAT_MS);
      entry.heartbeat.unref?.();
    }
    const withdraw = (reason: 'timeout' | 'cancelled') => {
      // A response already claimed by IPC finishes through that response.
      if (pending.get(requestId) !== entry || entry.responding) return;
      pending.delete(requestId);
      detach(entry);
      log.warn(`external CLI permission ${reason} → deny`, {
        request_id: maskId(requestId),
        cli: opts.cli,
        waited_ms: Date.now() - startedAt,
      });
      broadcast('local-agent:permission_cancelled', { request_ids: [requestId] });
      resolve('deny');
    };
    entry.deadline = setTimeout(() => withdraw('timeout'), permissionResponseTimeoutMs());
    entry.deadline.unref?.();
    if (opts.signal) {
      entry.signal = opts.signal;
      entry.onAbort = () => withdraw('cancelled');
      opts.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
  });
}

/** Register the effective policy snapshot owned by a live CLI task. Persisted
 * Agent permission changes can then update every already-running task without
 * widening the grant to another Agent, account, or CLI. */
export function registerRun(opts: {
  uid: string;
  runId: string;
  agentId: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
}): void {
  activeRuns.set(opts.runId, {
    uid: opts.uid,
    agentId: opts.agentId,
    cli: opts.cli,
    permissionPolicy: opts.permissionPolicy,
  });
}

/** Apply a successfully persisted Agent permission policy to its live tasks.
 * A full-access upgrade also resolves prompts that became obsolete while the
 * renderer serialized concurrent permission dialogs. Entries already claimed
 * by an IPC response finish through that response so two decisions cannot race. */
export function updateActiveAgentPermissionPolicy(opts: {
  uid: string;
  agentId: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
}): void {
  for (const run of activeRuns.values()) {
    if (run.uid !== opts.uid || run.agentId !== opts.agentId || run.cli !== opts.cli) continue;
    run.permissionPolicy = opts.permissionPolicy;
  }
  if (opts.permissionPolicy !== 'full_access') return;

  const coveredRequestIds: string[] = [];
  for (const [requestId, entry] of pending) {
    if (entry.uid !== opts.uid
      || entry.agentId !== opts.agentId
      || entry.cli !== opts.cli
      || entry.kind === 'connector'
      || entry.responding) continue;
    pending.delete(requestId);
    detach(entry);
    coveredRequestIds.push(requestId);
    entry.resolve('allow_once');
  }
  if (coveredRequestIds.length) {
    broadcast('local-agent:permission_cancelled', { request_ids: coveredRequestIds });
  }
}

/** Bounded ownership context used by IPC to persist a permission-level change
 * before resolving the native CLI request. */
export function beginResponse(requestId: string, uid: string): {
  uid: string;
  agentId: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
} | null {
  const entry = pending.get(requestId);
  if (!entry || entry.uid !== uid || entry.responding) return null;
  entry.responding = true;
  // The user has answered; persistence of a policy change may take a moment
  // and must not be overtaken by the deadline or a late client cancel.
  detach(entry);
  return {
    uid: entry.uid,
    agentId: entry.agentId,
    cli: entry.cli,
    permissionPolicy: entry.permissionPolicy,
  };
}

export function respond(
  requestId: string,
  decision: LocalCliPermissionDecision,
): { handled: boolean; decision?: LocalCliPermissionDecision } {
  const entry = pending.get(requestId);
  if (!entry) return { handled: false };
  pending.delete(requestId);
  detach(entry);
  if (decision === 'allow_run') {
    allowedRuns.set(entry.runId, entry.uid);
    // A backend can issue multiple approval requests before Renderer answers
    // the first one. Once the user grants the task, cover those already-
    // queued requests too; otherwise an obsolete second dialog would appear
    // even though the task is now trusted. Native CLIs still receive only a
    // one-operation decision for every request.
    const coveredRequestIds: string[] = [];
    for (const [pendingId, queued] of pending) {
      if (queued.runId !== entry.runId || queued.uid !== entry.uid) continue;
      pending.delete(pendingId);
      detach(queued);
      coveredRequestIds.push(pendingId);
      queued.resolve('allow_once');
    }
    if (coveredRequestIds.length) {
      broadcast('local-agent:permission_cancelled', { request_ids: coveredRequestIds });
    }
  }
  // Orkas owns task scope. Native CLIs receive only a one-operation grant so
  // their persisted session cannot retain authority after this task ends.
  entry.resolve(decision === 'deny' ? 'deny' : 'allow_once');
  return { handled: true, decision };
}

export function cancelForRun(runId: string): void {
  activeRuns.delete(runId);
  allowedRuns.delete(runId);
  const requestIds: string[] = [];
  for (const [requestId, entry] of pending) {
    if (entry.runId !== runId) continue;
    pending.delete(requestId);
    detach(entry);
    requestIds.push(requestId);
    entry.resolve('deny');
  }
  if (requestIds.length) {
    broadcast('local-agent:permission_cancelled', { request_ids: requestIds });
  }
}

function cancelForUid(uid: string): void {
  for (const [runId, grantedUid] of allowedRuns) {
    if (grantedUid === uid) allowedRuns.delete(runId);
  }
  const runIds = new Set<string>();
  for (const [runId, entry] of activeRuns) {
    if (entry.uid === uid) runIds.add(runId);
  }
  for (const entry of pending.values()) {
    if (entry.uid === uid) runIds.add(entry.runId);
  }
  for (const runId of runIds) cancelForRun(runId);
}

registerUserSwitchHook('local-agent-permissions', (previousUid) => {
  cancelForUid(previousUid);
});

export function _setBroadcastForTest(fn: BroadcastOverride | null): void {
  broadcastOverride = fn;
}

export function _resetForTest(): void {
  for (const entry of pending.values()) {
    detach(entry);
    entry.resolve('deny');
  }
  pending.clear();
  allowedRuns.clear();
  activeRuns.clear();
  broadcastOverride = null;
}
