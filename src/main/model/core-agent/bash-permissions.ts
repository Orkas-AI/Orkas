/**
 * Blocking permission gate for sensitive local operations under approval
 * access modes (features/permissions.ts).
 *
 * Mirrors features/local_agents/bridge_permissions.ts (push `bash:permission`
 * → renderer dialog → `bash.permission_response` IPC → resolve), with two
 * differences:
 *
 *   1. THREE outcomes — `allow_once`, `allow_run`, `deny` — not a boolean.
 *   2. NO persistent store. "Allow for this run" is an IN-MEMORY grant keyed
 *      by (cid, agentId) → set of risk categories, cleared when the run ends
 *      (`cancelForCid`). It deliberately does NOT survive a restart or apply
 *      to another conversation: a one-time "stop asking me for the rest of
 *      this task" convenience, not a durable policy. (Durable per-pattern
 *      allow is plan option A, intentionally out of scope here.)
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
import type { RiskCategory } from './bash-risk';

const log = createLogger('bash-permissions');

export type BashDecision = 'allow_once' | 'allow_run' | 'deny';

// Keep watchdogs alive while the tool is waiting for a human to click the
// renderer dialog. This is not a safety timeout: it only drives optional
// caller progress callbacks.
const WAITING_HEARTBEAT_MS = 25_000;
/** Renderer dialog command preview cap — the user must see what will run, but
 *  an unbounded command would bloat the push payload. */
const COMMAND_PREVIEW_MAX = 800;

// ── Run-scoped "allow for this run" grants (in-memory only) ──────────────────

function runKey(cid: string, agentId: string): string {
  return `${cid} ${agentId}`;
}

const _runAllow = new Map<string, Set<RiskCategory>>();

function isCoveredByRun(cid: string, agentId: string, reasons: RiskCategory[]): boolean {
  const set = _runAllow.get(runKey(cid, agentId));
  if (!set || !set.size) return false;
  return reasons.every((r) => set.has(r));
}

function recordRunAllow(cid: string, agentId: string, reasons: RiskCategory[]): void {
  const key = runKey(cid, agentId);
  const set = _runAllow.get(key) || new Set<RiskCategory>();
  for (const r of reasons) set.add(r);
  _runAllow.set(key, set);
}

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
  cid: string;
}

interface Pending {
  cid: string;
  agentId: string;
  reasons: RiskCategory[];
  resolve: (d: BashDecision) => void;
  heartbeat?: NodeJS.Timeout;
}

const _pending = new Map<string, Pending>();

// Lazy ipc lookup — avoids a static model→ipc import cycle and degrades
// cleanly in tests / headless builds (same pattern as bridge_permissions).
let _broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => void) | null): void {
  _broadcastOverride = fn;
}
export function _resetForTest(): void {
  for (const [, p] of _pending) {
    if (p.heartbeat) clearInterval(p.heartbeat);
  }
  _pending.clear();
  _runAllow.clear();
}

function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) { _broadcastOverride(channel, payload); return true; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch { return false; }
}

/**
 * Gate one risky bash command. Resolves to the user's decision. Silent
 * `allow_run` when this run already granted every category. Deny on a broken
 * push channel; otherwise wait for the explicit renderer response.
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
  onWaiting?: (elapsedMs: number) => void;
}): Promise<BashDecision> {
  const reasons = opts.reasons.slice();
  if (isCoveredByRun(opts.cid, opts.agentId, reasons)) return 'allow_run';

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
    cid: opts.cid,
  };

  // Privacy: log categories + length only, never the command text (CLAUDE.md).
  log.info('bash permission requested', {
    request_id: maskId(requestId),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    reasons,
    command_chars: opts.command.length,
  });

  return new Promise<BashDecision>((resolve) => {
    const startedAt = Date.now();
    const notifyWaiting = () => {
      if (!opts.onWaiting) return;
      try { opts.onWaiting(Date.now() - startedAt); }
      catch (err) { log.warn('bash permission waiting callback failed', { request_id: maskId(requestId), error: (err as Error)?.message || String(err) }); }
    };
    const pending: Pending = { cid: opts.cid, agentId: opts.agentId, reasons, resolve };
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
  if (decision === 'allow_run') {
    recordRunAllow(pending.cid, pending.agentId, pending.reasons);
  }
  pending.resolve(decision);
  return true;
}

/** Abandon every pending request for a conversation AND drop its run-scoped
 *  grants (run ended / aborted). Pending requests resolve to `deny`. */
export function cancelForCid(cid: string): void {
  for (const [id, pending] of _pending) {
    if (pending.cid !== cid) continue;
    _pending.delete(id);
    if (pending.heartbeat) clearInterval(pending.heartbeat);
    pending.resolve('deny');
  }
  for (const key of [..._runAllow.keys()]) {
    if (key.startsWith(`${cid} `)) _runAllow.delete(key);
  }
}
