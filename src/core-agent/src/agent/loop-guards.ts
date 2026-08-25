/**
 * Run-scoped spin guards for the agent loop, extracted from `runWithProvider`
 * so the counters, thresholds, and verdicts live in one place and can be
 * exercised without a provider. Two deliberately different mechanisms:
 *
 * 1) Repeat detection — a runaway agent proposes the SAME call over and over.
 *    Exact tier (byte-identical name+args): nudge once at LOOP_WARN
 *    consecutive repeats, force-stop at LOOP_HARD. Near-duplicate tier
 *    (identical modulo volatile request-tracking keys): WARN-only by design —
 *    normalized matching is fuzzier, so a false positive must stay a benign
 *    one-time nudge, never a stop (71d4552bf; the silently added hard stop was
 *    removed 2026-08-12 and is pinned WARN-only by agent-runner tests).
 *
 * 2) Progress governor — a model can spin without ever repeating itself by
 *    varying filenames, cursors, or search terms. Each round is classified by
 *    observed outcomes; failed/plan-only rounds and read/search-only drift get
 *    separate, deliberately different budgets (productive work is unbounded).
 *
 * The class owns counting and verdicts ONLY. The loop keeps ownership of
 * everything with wider context: round classification (it needs execution
 * observations), nudge delivery and logging, and terminal-result construction.
 */

/** loop_detection thresholds: nudge the model once after this many CONSECUTIVE
 *  identical tool calls, force-stop the run after this many. */
export const LOOP_WARN = 3;
export const LOOP_HARD = 5;

/** Near-duplicate loop_detection: nudge after this many CONSECUTIVE calls that
 *  are identical except for volatile id/timestamp
 *  fields. Strictly above LOOP_HARD so the exact detector always acts first on
 *  byte-identical repeats; this tier catches the "same call, fresh
 *  request-id/uuid each time" spin that exact matching misses. WARN-only by
 *  design: normalized matching is fuzzier than the exact tier, so a false
 *  positive must stay a benign one-time nudge, never a stop. An ignored nudge
 *  is bounded by the tool-round cap like any other unproductive work. */
export const NEAR_DUP_LOOP_WARN = 6;

/** Progress-governor budgets. Failed/plan-only rounds stall fast (nudge at 2,
 *  stop at 4); read/search-only exploration is legitimate work that just needs
 *  a longer leash (nudge at 8, stop at 20). Only a productive round resets
 *  either window, so alternating bookkeeping and discovery cannot evade both. */
export const RUN_NO_PROGRESS_NUDGE_ROUNDS = 2;
export const RUN_NO_PROGRESS_STOP_ROUNDS = 4;
export const RUN_DISCOVERY_NUDGE_ROUNDS = 8;
export const RUN_DISCOVERY_STOP_ROUNDS = 20;

/** What a whole tool round amounted to, judged from observed outcomes. */
export type ToolRoundProgress = "none" | "discovery" | "productive";

/** Tools that only LOOK at state. A round made purely of these is exploration:
 *  legitimate, but bounded separately from productive work. */
export const DISCOVERY_ONLY_TOOLS = new Set([
  "find",
  "grep_files",
  "list_files",
  "read_files",
  "search_files",
  "tool_result",
  "web_fetch",
  "web_search",
  "workspace_diff",
]);

export function mergeToolRoundProgress(
  current: ToolRoundProgress,
  next: ToolRoundProgress,
): ToolRoundProgress {
  if (current === "productive" || next === "productive") return "productive";
  if (current === "discovery" || next === "discovery") return "discovery";
  return "none";
}

/** Stable signature of a tool call for loop detection: name + canonical args.
 *  Only EXACT repeats (same tool, same input) share a signature, so legitimate
 *  varied calls never collide. */
export function toolCallSignature(call: { name: string; input: unknown }): string {
  const args = stableToolInputJson(call.input);
  return `${call.name}\u0000${args}`;
}

export function stableToolInputJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== "object") return entry;
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
      out[key] = visit((entry as Record<string, unknown>)[key]);
    }
    return out;
  };
  try { return JSON.stringify(visit(value ?? {})); }
  catch { return String(value); }
}

/** Argument keys that change on every call by nature (request-tracking ids,
 *  timestamps) and never define what the call DOES. Conservative on purpose: it
 *  excludes ambiguous keys like `id`, `seed`, `token`, `offset`, `page` that can
 *  be structural — so pagination and distinct targets never collapse. */
const VOLATILE_ARG_KEY_RE =
  /^(?:request_?id|req_?id|correlation_?id|idempotency_?key|trace_?id|span_?id|nonce|timestamp|created_?at|updated_?at)$/i;

/** Strip only by KEY NAME, not by value: a UUID/timestamp VALUE under a
 *  meaningful key (e.g. `record_id`, `ref`) is a real target and must stay, so
 *  fetching two different records never looks like a near-duplicate. Only keys
 *  that are request-tracking by nature (and change every call) are dropped. */
function stripVolatileArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileArgs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_ARG_KEY_RE.test(key)) continue;
      out[key] = stripVolatileArgs(val);
    }
    return out;
  }
  return value;
}

/** Near-duplicate signature: `toolCallSignature` with volatile id/timestamp fields
 *  removed, so calls that differ ONLY in such fields share a signature. Structural
 *  args (path/url/query/offset/page/target) are preserved, so legitimate
 *  pagination and distinct targets stay distinct. Pure; unit-tested with matching
 *  and look-alike (must-not-match) fixtures. */
export function normalizedToolCallSignature(call: { name: string; input: unknown }): string {
  let args: string;
  try { args = JSON.stringify(stripVolatileArgs(call.input ?? {})); }
  catch { args = String(call.input); }
  return `${call.name}\u0000${args}`;
}

export type ProgressGovernorOutcome = {
  /** Fire this nudge through the request-control channel (the caller owns
   *  wording, delivery, and logging). At most one per stalled episode. */
  nudge: { kind: "no_progress" | "discovery"; rounds: number } | null;
  /** Stop the run: the bounded stall window is exhausted. The caller builds
   *  the fallback result; `stalledRounds` feeds its wording and logs. */
  stop: { kind: "no_progress" | "discovery"; stalledRounds: number } | null;
};

export class LoopGuards {
  // ── Repeat detection (consecutive across the run; any differing call
  //    resets its streak, so distinct/parallel calls never trip). ──
  private exactSig: string | null = null;
  private exactRepeat = 0;
  private exactWarnedForStreak = false;
  private normSig: string | null = null;
  private normRepeat = 0;
  private normWarnedForStreak = false;
  private pendingRepeatNudge: string | null = null;

  // ── Progress governor ──
  private noProgressRounds = 0;
  private discoveryOnlyRounds = 0;
  private noProgressEpisodeNudged = false;
  private discoveryEpisodeNudged = false;

  /** Unsuccessful (failed/plan-only) tool rounds since the last productive
   *  result, for request-metadata telemetry. Discovery does not reset it; only
   *  a productive round or user steer does. */
  get consecutiveNoProgressRounds(): number {
    return this.noProgressRounds;
  }

  // ── Convergence-signal flags (read by the loop's result meta). Set at the
  //    same moments the loop used to set its locals: repeat on delivery or
  //    hard stop, the others when their nudge/stop actually fires. ──
  repetitiveToolCallsDetected = false;
  noProgressNudgeSent = false;
  discoveryStallNudgeSent = false;
  noProgressStopped = false;
  discoveryStallStopped = false;

  /**
   * Feed one round's PROPOSED calls (afterModel, before execution) through
   * both repeat tiers, in call order. Returns true when the next call would be
   * the LOOP_HARD-th byte-identical repeat: the caller must stop the run
   * WITHOUT executing it. Arms at most one pending nudge (exact tier wins).
   */
  observeProposedCalls(calls: ReadonlyArray<{ name: string; input: unknown }>): boolean {
    for (const call of calls) {
      const sig = toolCallSignature(call);
      if (sig === this.exactSig) {
        this.exactRepeat += 1;
      } else {
        this.exactSig = sig;
        this.exactRepeat = 1;
        this.exactWarnedForStreak = false;
      }
      if (this.exactRepeat >= LOOP_HARD) {
        this.repetitiveToolCallsDetected = true;
        return true;
      }
      if (this.exactRepeat >= LOOP_WARN && !this.exactWarnedForStreak) {
        this.exactWarnedForStreak = true;
        this.pendingRepeatNudge =
          `You have called the same tool with the same arguments ${LOOP_WARN} times in a row. `
          + `This is not making progress. Change your approach (different arguments or a different tool), `
          + `or stop and report what you have so far. Repeating the identical call again will end the run.`;
      }

      const nsig = normalizedToolCallSignature(call);
      if (nsig === this.normSig) {
        this.normRepeat += 1;
      } else {
        this.normSig = nsig;
        this.normRepeat = 1;
        this.normWarnedForStreak = false;
      }
      if (this.normRepeat >= NEAR_DUP_LOOP_WARN && !this.normWarnedForStreak && !this.pendingRepeatNudge) {
        this.normWarnedForStreak = true;
        this.pendingRepeatNudge =
          `You have called ${call.name} ${this.normRepeat} times in a row with effectively the same arguments `
          + `(only volatile fields such as ids or timestamps differ). This is likely not making progress. `
          + `Change the target or your approach, or stop and report what you have so far.`;
      }
    }
    return false;
  }

  /**
   * Take (and clear) the armed repeat nudge at the delivery boundary. Taking
   * it marks the repetitive-calls signal, mirroring the loop's old semantics:
   * the flag records a DELIVERED intervention, not an armed one.
   */
  takePendingRepeatNudge(): string | null {
    const nudge = this.pendingRepeatNudge;
    if (nudge) {
      this.pendingRepeatNudge = null;
      this.repetitiveToolCallsDetected = true;
    }
    return nudge;
  }

  /**
   * Feed one completed round's classification. `freshEpisode` means the user
   * steered mid-run or a terminal tool boundary is pending — either way the
   * stall windows restart, because "progress" was just redefined (or the one
   * remaining inference has no tools and cannot benefit from a nudge).
   */
  observeRoundOutcome(input: {
    progress: ToolRoundProgress;
    freshEpisode: boolean;
  }): ProgressGovernorOutcome {
    if (input.freshEpisode) {
      this.noProgressRounds = 0;
      this.discoveryOnlyRounds = 0;
      this.noProgressEpisodeNudged = false;
      this.discoveryEpisodeNudged = false;
    } else if (input.progress === "productive") {
      this.noProgressRounds = 0;
      this.discoveryOnlyRounds = 0;
      this.noProgressEpisodeNudged = false;
      this.discoveryEpisodeNudged = false;
    } else if (input.progress === "discovery") {
      this.discoveryOnlyRounds++;
    } else {
      this.noProgressRounds++;
    }

    let nudge: ProgressGovernorOutcome["nudge"] = null;
    if (!input.freshEpisode
        && input.progress === "none"
        && this.noProgressRounds >= RUN_NO_PROGRESS_NUDGE_ROUNDS
        && !this.noProgressEpisodeNudged) {
      this.noProgressEpisodeNudged = true;
      this.noProgressNudgeSent = true;
      nudge = { kind: "no_progress", rounds: this.noProgressRounds };
    } else if (!input.freshEpisode
        && input.progress === "discovery"
        && this.discoveryOnlyRounds >= RUN_DISCOVERY_NUDGE_ROUNDS
        && !this.discoveryEpisodeNudged) {
      this.discoveryEpisodeNudged = true;
      this.discoveryStallNudgeSent = true;
      nudge = { kind: "discovery", rounds: this.discoveryOnlyRounds };
    }

    let stop: ProgressGovernorOutcome["stop"] = null;
    if (this.noProgressRounds >= RUN_NO_PROGRESS_STOP_ROUNDS) {
      this.noProgressStopped = true;
      stop = { kind: "no_progress", stalledRounds: this.noProgressRounds };
    } else if (this.discoveryOnlyRounds >= RUN_DISCOVERY_STOP_ROUNDS) {
      this.discoveryStallStopped = true;
      stop = { kind: "discovery", stalledRounds: this.discoveryOnlyRounds };
    }

    return { nudge, stop };
  }
}
