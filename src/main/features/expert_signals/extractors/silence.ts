/**
 * T0 silence extractor: agent message followed by N minutes of no user
 * response → emit `silence` signal.
 *
 * Implementation: per-conv `setTimeout` registered at agent-turn-end,
 * cancelled when the user sends the next message. NOT a global poller
 * (plan §11 reject #8 — `setInterval` over all convs is O(N) waste).
 *
 * Restart semantics: timers live in process memory only — app restart
 * drops pending checks. Phase 0 accepts the gap; phase 1+ can add a
 * boot-time backfill (scan `<cid>.jsonl` for trailing agent msgs older
 * than threshold) when there's a consumer that needs it.
 *
 * This module is also the **phase-1 LLM session-end pass mount point**
 * (plan §5): the same timer's fire is "session inactive > N min", so a
 * future LLM pass hook can register here without changing scheduling.
 */

import { emitSignal } from '../index';
import { EXTRACTOR_VERSION, type SignalInput } from '../types';
import { createLogger } from '../../../logger';

const log = createLogger('expert-signals:silence');

/** Default: 30 minutes of inactivity = "the user accepted silently".
 *  Tunable per call; tests pass a tiny value. */
export const SILENCE_THRESHOLD_MS = 30 * 60 * 1000;

interface PendingCheck {
  timer: NodeJS.Timeout;
  /** Captured at schedule time so the fire callback has all the context
   *  it needs without re-reading conv state. */
  uid: string;
  cid: string;
  aid: string | null;
  turn_id: string;
  msg_ids: string[];
}

const _pending = new Map<string, PendingCheck>();

function _key(uid: string, cid: string): string { return `${uid}:${cid}`; }

/**
 * Register a silence check after an agent turn ends. Cancels any prior
 * check for this conv (a new agent message resets the silence window).
 *
 * Calling with `thresholdMs <= 0` cancels the check without scheduling
 * a new one — useful when caller wants "explicit cancel" semantics.
 */
export function scheduleSilenceCheck(args: {
  uid: string;
  cid: string;
  aid: string | null;
  turn_id: string;
  msg_ids: string[];
  thresholdMs?: number;
}): void {
  cancelSilenceCheck(args.uid, args.cid);
  const ms = args.thresholdMs ?? SILENCE_THRESHOLD_MS;
  if (ms <= 0) return;
  const key = _key(args.uid, args.cid);
  const timer = setTimeout(() => {
    _pending.delete(key);
    try {
      emitSignal(args.uid, _buildSilenceSignal(args));
    } catch (err) {
      log.warn(`silence emit threw uid=${args.uid} cid=${args.cid}: ${(err as Error).message}`);
    }
  }, ms);
  // Don't keep the event loop alive just for silence checks — if the app
  // is otherwise idle, it should be allowed to exit.
  if (typeof (timer as { unref?: () => unknown }).unref === 'function') {
    (timer as { unref: () => unknown }).unref();
  }
  _pending.set(key, { ...args, timer });
}

/** Cancel a pending silence check (user just sent a message). Idempotent. */
export function cancelSilenceCheck(uid: string, cid: string): void {
  const key = _key(uid, cid);
  const p = _pending.get(key);
  if (p) {
    clearTimeout(p.timer);
    _pending.delete(key);
  }
}

/** Test seam: drop all pending timers. Tests should call this in
 *  afterEach to avoid leaked timers across cases. */
export function _clearAllPending(): void {
  for (const p of _pending.values()) clearTimeout(p.timer);
  _pending.clear();
}

function _buildSilenceSignal(args: {
  cid: string;
  aid: string | null;
  turn_id: string;
  msg_ids: string[];
}): SignalInput {
  return {
    type: 'silence',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids },
    extractor_version: EXTRACTOR_VERSION.silence,
  };
}
