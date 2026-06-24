/**
 * Read-before-edit + optimistic concurrency control (OCC) for the file tools.
 *
 * `read_file` / `write_file` stamp the file's `{ mtimeMs, size }` into a
 * run-scoped map; `edit_file` checks that stamp before it writes:
 *   - read-before-edit — refuse to edit a file the model has not read this run
 *     (its `old_string` would be a guess), and
 *   - OCC — refuse to edit a file that changed on disk since the model read it
 *     (a parallel worker, a bash command, or an external process moved it),
 *     forcing a fresh `read_file` so the edit lands on the real current bytes.
 *
 * The map lives on `ctx.state[READ_FILE_STATE_KEY]`, injected once per run by
 * core-agent's runner (so it survives across LLM rounds — read and edit are
 * always different rounds). Enforcement is gated on the map's PRESENCE: when a
 * host doesn't inject it (older runner, a unit test with `state: {}`) the file
 * tools degrade to their pre-OCC behaviour rather than blocking every edit. The
 * real runner always injects it, so production always enforces.
 *
 * Stamping from `read_file` is concurrency-safe even though `read_file` is
 * `executionMode:'parallel'`: a keyed `Map.set(abs, …)` is atomic in JS, the
 * key is the absolute path (concurrent reads of different files never collide),
 * and same-file reads write an equivalent value. Each worker run has its OWN
 * ctx.state, so cross-worker safety rests on the filesystem lock + OCC, not on
 * this map.
 */

import * as fs from 'node:fs';
import type { ToolContext } from '#core-agent';

/** ctx.state key the runner injects the run-scoped read-state map under.
 *  Mirrored as the literal `'readFileState'` in core-agent's runner — keep the
 *  two in sync (same contract as `'sandboxEnv'`). */
export const READ_FILE_STATE_KEY = 'readFileState';

/** Baseline captured when a file is read; compared on edit. */
export type ReadStamp = { mtimeMs: number; size: number };

/** Return the run-scoped read-state map, or null when the host didn't inject
 *  one (→ callers skip read-before-edit/OCC enforcement). */
export function getReadState(ctx: ToolContext): Map<string, ReadStamp> | null {
  // `state` is required by the type, but tolerate its absence: some call sites
  // (older hosts, direct unit tests) pass a ctx without it. No state → no map.
  const state = ctx.state as Record<string, unknown> | undefined;
  const m = state?.[READ_FILE_STATE_KEY];
  return m instanceof Map ? (m as Map<string, ReadStamp>) : null;
}

function stampFromStats(st: fs.Stats): ReadStamp {
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** Record that `abs` was read (or written) at its current on-disk state, so a
 *  later `edit_file` accepts an edit built on these bytes. Best-effort: a stat
 *  failure is swallowed (the edit path re-stats and will reject if needed).
 *  Pass `st` to reuse a stat the caller already took. No-op when no map. */
export function recordRead(ctx: ToolContext, abs: string, st?: fs.Stats): void {
  const rs = getReadState(ctx);
  if (!rs) return;
  try {
    const stat = st ?? fs.statSync(abs);
    rs.set(abs, stampFromStats(stat));
  } catch {
    // File vanished between read and stamp — leave it unstamped; the edit
    // path will surface E_NOT_FOUND on its own.
  }
}

/** A reason an edit is blocked; the model-facing error code + message. */
export type EditBlock = { code: 'E_NOT_READ' | 'E_STALE'; msg: string };

/**
 * Decide whether `edit_file` may proceed on `abs`, given its current stat.
 * Returns null when the edit is allowed (or when the run-scoped map is absent,
 * i.e. the host opted out — see module header), otherwise the block reason:
 *   - never read this run            → E_NOT_READ (read it first)
 *   - read, but mtime/size changed   → E_STALE   (re-read; it moved under you)
 */
export function checkEditFreshness(ctx: ToolContext, abs: string, st: fs.Stats): EditBlock | null {
  const rs = getReadState(ctx);
  if (!rs) return null; // host opted out of enforcement
  const seen = rs.get(abs);
  if (!seen) {
    return {
      code: 'E_NOT_READ',
      msg: `${abs}: read the file with read_file before editing it, so old_string matches the real current contents.`,
    };
  }
  if (seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) {
    return {
      code: 'E_STALE',
      msg: `${abs}: file changed on disk since you read it (another worker, a command, or an external edit). Call read_file again, then redo the edit against the current contents.`,
    };
  }
  return null;
}
