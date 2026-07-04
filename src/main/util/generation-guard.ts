/**
 * generation-guard — a SOFT, conversation-scoped guard against silently
 * re-billing the same generated deliverable.
 *
 * Billable generators call `noteGeneration()` with the conversation id + the
 * REQUESTED output path. Once the same deliverable has been (re)generated past
 * a threshold, the tool appends a one-line warning to its result so the agent
 * — and the user reading along — notice the repeated spend instead of looping
 * unseen (the failure mode that re-synthesized one narration 11× and re-billed
 * every time).
 *
 * It NEVER blocks. The agent keeps full control (including its bash/coding
 * abilities); this is awareness, not a cap. Keyed on the requested path so it
 * tracks "you keep regenerating THIS deliverable", which is the precise shape
 * of the runaway loop; switching to a fresh path each time is a deliberate act
 * and legitimately resets the count.
 */

/** count keyed by `${cid}\0${requestedPath}` — process-lifetime, conversation
 *  scoped (cost awareness spans the whole conversation, not just one turn). */
const counts = new Map<string, number>();

/** Bound the map so a long-lived process can't leak one entry per (cid, path). */
const MAX_KEYS = 2000;

/** Warn from the Nth (re)generation of the same deliverable onward. Two writes
 *  to one path is a normal one-shot fix; three+ is an iterating loop. */
export const REGEN_WARN_AT = 3;

function keyFor(scope: string | undefined, outputPath: string): string {
  return `${scope || 'no-cid'}\0${outputPath}`;
}

/** Record one (re)generation of `outputPath` within `scope` (the conversation
 *  id) and return how many times it has now been generated in this process. */
export function noteGeneration(scope: string | undefined, outputPath: string): number {
  const key = keyFor(scope, outputPath);
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (counts.size > MAX_KEYS) {
    // Drop the oldest-inserted key — a bounded cache, exactness not needed.
    const oldest = counts.keys().next().value;
    if (oldest !== undefined && oldest !== key) counts.delete(oldest);
  }
  return n;
}

/** A one-line soft warning when a deliverable has been regenerated repeatedly,
 *  else null. `kind` is the user-facing noun ("video" / "image"). Pure. */
export function regenerationWarning(count: number, kind: string): string | null {
  if (count < REGEN_WARN_AT) return null;
  return `⚠️ This is generation #${count} of this ${kind} in the conversation — each call is billable and re-runs the full generation. `
    + `Reuse the existing file unless the request changed materially; if you are iterating toward a target, change one thing deliberately rather than re-rolling, or ask the user before spending another generation.`;
}

/** Test-only: reset the in-process counters. */
export function __resetGenerationGuard(): void { counts.clear(); }
