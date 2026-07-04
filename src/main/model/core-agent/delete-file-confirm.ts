/**
 * Per-call UI confirmation state for the `delete_file` local tool.
 *
 * Async token model — the `delete_file` tool does NOT block on the user's
 * click. The flow is:
 *
 *   1. LLM calls `delete_file({ path })` (no token).
 *      Tool calls `requestConfirmation(absPath, ctx)` → gets a fresh
 *      `confirmation_token` synchronously, returns it to the LLM along
 *      with `requires_user_confirmation: true`. The renderer renders it in
 *      an inline card; multiple pending tokens from the same turn may be
 *      grouped into one card.
 *   2. LLM sees the token-bearing result; per skill-creator's SKILL.md
 *      rule, it MUST end the turn with a prose ask, NOT immediately
 *      re-call delete_file in the same turn. The token is in `pending`
 *      state until the user clicks the card.
 *   3. User clicks Confirm / Cancel → renderer invokes
 *      `delete_file.respond` for each token in that card →
 *      `resolveConfirmation(token, granted)` flips each state to
 *      `granted` / `denied`.
 *   4. LLM (in a later turn, after the user has replied) calls
 *      `delete_file({ path, confirmation_token })` → tool calls
 *      `consumeGrantedConfirmation(token, absPath)`:
 *        - `granted` + path matches → consume the token (one-shot) and
 *          return true so the tool proceeds with `fs.unlink`.
 *        - `pending` → return false, tool reports "still pending; wait
 *          for the user to click before retrying".
 *        - `denied` → tool reports user declined.
 *        - unknown / expired / path mismatch → tool reports invalid.
 *
 * The "must end turn before retrying with token" rule is enforced by
 * `pending` rejecting same-turn retries, AND by SKILL.md authoring rules
 * that tell the LLM to stop, ask the user, and wait. Server-side that
 * suffices — there is no per-turn-id check; if the LLM tries to re-call
 * in the same turn, `consumeGrantedConfirmation` returns false because
 * the user hasn't clicked yet.
 *
 * Tokens auto-expire after `CONFIRM_TTL_MS` so a forgotten / abandoned
 * card doesn't leave the path stuck in pending forever. After expiry the
 * LLM must call `delete_file({ path })` again without a token to mint a
 * fresh card.
 */

import * as crypto from 'node:crypto';
import { broadcastToRenderer } from '../../ipc';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';

const log = createLogger('delete_file_confirm');

/** Pending tokens older than this are GC'd. 30 minutes balances "user
 *  walked away from the laptop" against "stale token clutter". */
const CONFIRM_TTL_MS = 30 * 60_000;
const _GC_INTERVAL_MS = 5 * 60_000;

type ConfirmState = 'pending' | 'granted' | 'denied';
interface Entry {
  path: string;
  state: ConfirmState;
  created_at_ms: number;
}

const _entries = new Map<string, Entry>();

// One periodic GC pass — drops any entry past TTL regardless of state, so
// `granted` tokens that the LLM never came back to consume don't sit
// indefinitely either.
setInterval(() => {
  const now = Date.now();
  for (const [token, e] of _entries) {
    if (now - e.created_at_ms > CONFIRM_TTL_MS) _entries.delete(token);
  }
}, _GC_INTERVAL_MS).unref?.();

export interface DeleteConfirmContext {
  /** The path the LLM gave the tool, before any abs resolution — used by
   *  the renderer card so the user sees the relative form they're
   *  actually being asked about. */
  display_path: string;
  /** Active conv id; lets the renderer optionally scope its UI hint. */
  cid?: string;
  /** Stable id for the current visible actor turn. Used by the renderer to
   *  batch only confirmations produced by the same model turn. */
  turn_id?: string;
}

/** Mint a fresh confirmation token, emit the inline card to the renderer,
 *  and return synchronously. Caller's tool execution should NOT await
 *  anything from this module — see the file header for why. */
export function requestConfirmation(absPath: string, ctx: DeleteConfirmContext): string {
  const token = crypto.randomBytes(12).toString('hex');
  _entries.set(token, { path: absPath, state: 'pending', created_at_ms: Date.now() });
  try {
    broadcastToRenderer('delete_file.confirmation_required', {
      confirm_id: token,
      path: ctx.display_path,
      abs_path: absPath,
      cid: ctx.cid ?? '',
      turn_id: ctx.turn_id ?? '',
    });
  } catch (err) {
    log.warn('emit confirmation_required failed', {
      confirmation_id: maskId(token),
      path: logPathRef(absPath),
      cid: maskId(ctx.cid),
      turn_id: maskId(ctx.turn_id),
      error: logErrorRef(err),
    });
  }
  return token;
}

/** IPC handler entry point — called by `delete_file.respond`. Returns
 *  `true` when the token existed (state transition happened), `false`
 *  on unknown / expired token (no-op, idempotent). */
export function resolveConfirmation(token: string, granted: boolean): boolean {
  const entry = _entries.get(token);
  if (!entry) {
    log.warn('resolveConfirmation unknown token', { confirmation_id: maskId(token), pending_count: _entries.size });
    return false;
  }
  if (entry.state !== 'pending') {
    log.warn('resolveConfirmation duplicate state', { confirmation_id: maskId(token), state: entry.state });
    return false;
  }
  entry.state = granted ? 'granted' : 'denied';
  log.info('resolveConfirmation completed', { confirmation_id: maskId(token), state: entry.state });
  return true;
}

export type ConsumeOutcome =
  | { outcome: 'granted'; path: string }
  | { outcome: 'pending' }
  | { outcome: 'denied' }
  | { outcome: 'invalid' };

/** Tool-side: look up a token + verify the path matches, then transition
 *  granted → consumed (one-shot). Outcomes:
 *  - `granted`: token exists, state=granted, path matches → caller may
 *    proceed with `fs.unlink`. The entry is removed from the map (no
 *    replay protection beyond that — the file is gone anyway).
 *  - `pending`: token exists, user hasn't clicked yet → caller should
 *    tell the LLM to wait for the user's reply.
 *  - `denied`: user explicitly clicked Cancel.
 *  - `invalid`: unknown token / expired / wrong path. */
export function consumeGrantedConfirmation(token: string, absPath: string): ConsumeOutcome {
  const entry = _entries.get(token);
  if (!entry) {
    log.warn('consumeGrantedConfirmation unknown token', { confirmation_id: maskId(token), pending_count: _entries.size });
    return { outcome: 'invalid' };
  }
  if (entry.path !== absPath) {
    log.warn('consumeGrantedConfirmation path mismatch', {
      confirmation_id: maskId(token),
      expected: logPathRef(entry.path),
      actual: logPathRef(absPath),
    });
    return { outcome: 'invalid' };
  }
  log.info('consumeGrantedConfirmation state', { confirmation_id: maskId(token), path: logPathRef(absPath), state: entry.state });
  if (entry.state === 'pending') return { outcome: 'pending' };
  if (entry.state === 'denied') {
    _entries.delete(token);
    return { outcome: 'denied' };
  }
  _entries.delete(token);
  return { outcome: 'granted', path: entry.path };
}
