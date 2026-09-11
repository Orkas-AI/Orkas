import { createHash } from "node:crypto";

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
 *    observed outcomes. Failed/plan-only rounds get an advisory nudge only:
 *    that coarse classification cannot prove the task is stuck. Extended
 *    read/search-only drift retains its separate bounded window.
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

/** Progress-governor budgets. Failed/plan-only rounds nudge at 2 but never
 *  terminate the run: exact-repeat/failure guards plus the global tool-loop and
 *  timeout budgets own forced termination. Read/search-only exploration keeps
 *  a longer bounded window (nudge at 8, stop at 20). */
export const RUN_NO_PROGRESS_NUDGE_ROUNDS = 2;
export const RUN_DISCOVERY_NUDGE_ROUNDS = 8;
export const RUN_DISCOVERY_STOP_ROUNDS = 20;

/** Repeated tool failures use a separate run-scoped episode tracker. The
 * second matching diagnostic produces one tool-agnostic model control. An
 * exact operation may be blocked before a third execution only when the first
 * two failures had no successful tool outcome between them; any intervening
 * success can have changed a prerequisite, so fuzzy/cross-progress matches
 * remain warning-only. */
export const REPEATED_TOOL_FAILURE_NUDGE_ATTEMPTS = 2;
export const REPEATED_TOOL_FAILURE_BLOCK_PRIOR_ATTEMPTS = 2;
const MAX_TRACKED_FAILURE_EPISODES = 64;

type FailureExecutionObservation = {
  status?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
};

export type ToolFailureResultLike = {
  content: string;
  observations?: { execution?: FailureExecutionObservation };
  failureContext?: {
    kind?: string;
    scope?: string;
    complete?: boolean;
    issueCount?: number;
    issueCodes?: string[];
  };
};

export type RepeatedToolFailureObservation = {
  fingerprint: string;
  failures: number;
  exactFailuresSinceSuccess: number;
};

export type RepeatedToolFailureBlock = {
  fingerprint: string;
  failures: number;
  message: string;
};

type ExactFailureEpisode = {
  fingerprint: string;
  fuzzyKey: string;
  failures: number;
  failuresSinceSuccess: number;
  successEpoch: number;
};

type FuzzyFailureEpisode = {
  operationCounts: Map<string, number>;
  totalFailures: number;
  nudged: boolean;
  kind: "diagnostic" | "deterministic_validation";
};

function deterministicValidationScope(result: ToolFailureResultLike): string | null {
  const context = result.failureContext;
  if (
    context?.kind !== "deterministic_validation"
    || context.complete !== true
    || typeof context.scope !== "string"
  ) return null;
  const scope = context.scope.trim().toLowerCase();
  return scope ? scope.slice(0, 256) : null;
}

function normalizedFailureDiagnostic(content: string): string {
  const raw = String(content || "");
  const stderr = raw.match(/<stderr>\s*([\s\S]*?)\s*<\/stderr>/i)?.[1];
  const code = raw.match(/\bcode=["']([^"']+)["']/i)?.[1];
  let diagnostic = stderr || raw;
  diagnostic = diagnostic
    .replace(/<command-result\b[^>]*>/gi, " ")
    .replace(/<\/command-result>/gi, " ")
    .replace(/<\/?(?:stdout|stderr)>/gi, " ")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s<>"']+[\\/])*[^\s<>"']*/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${code ? `code:${code.toLowerCase()} ` : ""}${diagnostic}`.slice(0, 2_048);
}

function failureFingerprint(
  result: ToolFailureResultLike,
  groupDeterministicValidationScope: boolean,
): string {
  const execution = result.observations?.execution;
  const validationScope = groupDeterministicValidationScope
    ? deterministicValidationScope(result)
    : null;
  const basis = [
    execution?.status || "error",
    execution?.exitCode ?? "",
    execution?.timedOut ? "timed_out" : "",
    execution?.outputLimitExceeded ? "output_limit" : "",
    validationScope
      ? `deterministic_validation:${validationScope}`
      : normalizedFailureDiagnostic(result.content),
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(basis).digest("hex")}`;
}

/** Stable, non-reversible grouping identity for a failed result. Complete
 * deterministic validators deliberately group changing blocker diagnostics by
 * scope so one convergence warning covers the whole validation episode. Raw
 * tool output is never retained in the episode tracker or emitted to logs or
 * model controls. */
export function toolFailureFingerprint(result: ToolFailureResultLike): string {
  return failureFingerprint(result, true);
}

/** Exact-operation blocking remains diagnostic-sensitive. A stable validation
 * scope may group changing blockers for a warning, but must not turn a newly
 * observed blocker set (including one caused by an out-of-band state change)
 * into a hard repeat. */
function exactToolFailureFingerprint(result: ToolFailureResultLike): string {
  return failureFingerprint(result, false);
}

/** What a whole tool round amounted to, judged from observed outcomes.
 * `neutral` is successful coordination that neither advances the user's
 * artifact nor demonstrates a failed attempt (for example, loading tools or
 * recording a plan). */
export type ToolRoundProgress = "neutral" | "none" | "discovery" | "productive";

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
  if (current === "none" || next === "none") return "none";
  return "neutral";
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
  /** Stop the run only when the bounded discovery-only window is exhausted.
   *  Coarse no-progress classification is advisory and cannot terminate. */
  stop: { kind: "discovery"; stalledRounds: number } | null;
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

  // ── Repeated failure episodes ──
  // These host-only records survive context compaction because LoopGuards is
  // run-scoped. Exact operation state supports a conservative execution block;
  // matching diagnostics across changed inputs remain warning-only.
  private successEpoch = 0;
  private exactFailureEpisodes = new Map<string, ExactFailureEpisode>();
  private fuzzyFailureEpisodes = new Map<string, FuzzyFailureEpisode>();
  private pendingFailureNudge: string | null = null;

  /** Unsuccessful tool rounds since the last productive result, for
   *  request-metadata telemetry. Discovery and successful coordination do not
   *  reset or increment it; only a productive round or user steer resets it. */
  get consecutiveNoProgressRounds(): number {
    return this.noProgressRounds;
  }

  // ── Convergence-signal flags (read by the loop's result meta). Set at the
  //    same moments the loop used to set its locals: repeat on delivery or
  //    hard stop, the others when their nudge/stop actually fires. ──
  repetitiveToolCallsDetected = false;
  noProgressNudgeSent = false;
  discoveryStallNudgeSent = false;
  discoveryStallStopped = false;
  repeatedToolFailureNudgeSent = false;
  repeatedToolFailureBlocked = false;

  private removeExactFailureEpisode(exactSignature: string): void {
    const exact = this.exactFailureEpisodes.get(exactSignature);
    if (!exact) return;
    this.exactFailureEpisodes.delete(exactSignature);
    const fuzzy = this.fuzzyFailureEpisodes.get(exact.fuzzyKey);
    if (!fuzzy) return;
    const contribution = fuzzy.operationCounts.get(exactSignature) || 0;
    fuzzy.operationCounts.delete(exactSignature);
    fuzzy.totalFailures = Math.max(0, fuzzy.totalFailures - contribution);
    if (fuzzy.totalFailures === 0) this.fuzzyFailureEpisodes.delete(exact.fuzzyKey);
  }

  private trimFailureEpisodes(): void {
    while (this.exactFailureEpisodes.size > MAX_TRACKED_FAILURE_EPISODES) {
      const oldest = this.exactFailureEpisodes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeExactFailureEpisode(oldest);
    }
    while (this.fuzzyFailureEpisodes.size > MAX_TRACKED_FAILURE_EPISODES) {
      const oldest = this.fuzzyFailureEpisodes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.fuzzyFailureEpisodes.delete(oldest);
    }
  }

  /** Record one real failed execution. Matching diagnostics — or one declared
   * complete deterministic-validation scope — produce a warning. Only an exact
   * operation with the same diagnostic twice since the last successful tool
   * outcome becomes blockable. */
  observeToolFailure(
    call: { name: string; input: unknown },
    result: ToolFailureResultLike,
  ): RepeatedToolFailureObservation {
    const exactSignature = toolCallSignature(call);
    const groupingFingerprint = toolFailureFingerprint(result);
    const fingerprint = exactToolFailureFingerprint(result);
    const failureKind = deterministicValidationScope(result)
      ? "deterministic_validation" as const
      : "diagnostic" as const;
    const fuzzyKey = `${call.name}\u0000${groupingFingerprint}`;
    const prior = this.exactFailureEpisodes.get(exactSignature);
    if (prior && prior.fingerprint !== fingerprint) {
      // A deterministic validator can report a different blocker set for the
      // same call and still belong to the same warning episode. Preserve that
      // episode's history while resetting only the diagnostic-sensitive hard
      // block counter. A genuinely different grouping key keeps the existing
      // removal behavior.
      if (prior.fuzzyKey === fuzzyKey) this.exactFailureEpisodes.delete(exactSignature);
      else this.removeExactFailureEpisode(exactSignature);
    }

    const current = this.exactFailureEpisodes.get(exactSignature);
    const sameSuccessEpoch = current?.successEpoch === this.successEpoch;
    const exact: ExactFailureEpisode = current
      ? {
          ...current,
          failures: current.failures + 1,
          failuresSinceSuccess: sameSuccessEpoch ? current.failuresSinceSuccess + 1 : 1,
          successEpoch: this.successEpoch,
        }
      : {
          fingerprint,
          fuzzyKey,
          failures: 1,
          failuresSinceSuccess: 1,
          successEpoch: this.successEpoch,
        };
    this.exactFailureEpisodes.delete(exactSignature);
    this.exactFailureEpisodes.set(exactSignature, exact);

    let fuzzy = this.fuzzyFailureEpisodes.get(fuzzyKey);
    if (!fuzzy) {
      fuzzy = {
        operationCounts: new Map<string, number>(),
        totalFailures: 0,
        nudged: false,
        kind: failureKind,
      };
      this.fuzzyFailureEpisodes.set(fuzzyKey, fuzzy);
    }
    fuzzy.operationCounts.set(exactSignature, (fuzzy.operationCounts.get(exactSignature) || 0) + 1);
    fuzzy.totalFailures++;
    if (
      fuzzy.totalFailures >= REPEATED_TOOL_FAILURE_NUDGE_ATTEMPTS
      && !fuzzy.nudged
    ) {
      fuzzy.nudged = true;
      this.pendingFailureNudge = fuzzy.kind === "deterministic_validation"
        ? `The same deterministic validation scope has failed ${fuzzy.totalFailures} times, even if the individual blocker codes changed. `
          + "Treat the latest tool result as the complete current blocker set and repair all listed blockers together before validating again. "
          + "If the result was persisted, read its result ref first; do not retry unchanged input."
        : `The same tool failure has occurred ${fuzzy.totalFailures} times. `
          + "Do not submit an equivalent attempt again. Re-check the input or prerequisites, "
          + "choose a materially different approach, or stop and report the blocker and completed work.";
    }
    this.trimFailureEpisodes();
    return {
      fingerprint,
      failures: fuzzy.totalFailures,
      exactFailuresSinceSuccess: exact.failuresSinceSuccess,
    };
  }

  /** A successful tool can have changed a prerequisite, so it re-opens exact
   * execution. It does NOT erase unrelated failure episodes. A success of the
   * same exact operation additionally resolves that operation's episode. */
  observeToolSuccess(call: { name: string; input: unknown }): void {
    this.successEpoch++;
    this.removeExactFailureEpisode(toolCallSignature(call));
  }

  /** Called immediately before execution, after any earlier sequential tools
   * in the same model response had a chance to repair prerequisites. */
  repeatedFailureBlockForCall(
    call: { name: string; input: unknown },
  ): RepeatedToolFailureBlock | null {
    const exact = this.exactFailureEpisodes.get(toolCallSignature(call));
    if (
      !exact
      || exact.failuresSinceSuccess < REPEATED_TOOL_FAILURE_BLOCK_PRIOR_ATTEMPTS
      || exact.successEpoch !== this.successEpoch
    ) return null;
    this.repeatedToolFailureBlocked = true;
    return {
      fingerprint: exact.fingerprint,
      failures: exact.failuresSinceSuccess,
      message:
        `This equivalent operation was not executed because it already failed ${exact.failuresSinceSuccess} times with the same error. `
        + "Re-check the input or prerequisites, choose a materially different approach, "
        + "or stop and report the blocker and completed work.",
    };
  }

  takePendingFailureNudge(): string | null {
    const nudge = this.pendingFailureNudge;
    if (nudge) {
      this.pendingFailureNudge = null;
      this.repeatedToolFailureNudgeSent = true;
    }
    return nudge;
  }

  discardPendingFailureNudge(): void {
    this.pendingFailureNudge = null;
  }

  /** A specialized repeated-failure result already tells the model why the
   * exact operation was blocked, so suppress the older generic repeat prompt. */
  discardPendingRepeatNudge(): void {
    this.pendingRepeatNudge = null;
  }

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
    suppressNoProgressNudge?: boolean;
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
    } else if (input.progress === "none") {
      this.noProgressRounds++;
    }

    let nudge: ProgressGovernorOutcome["nudge"] = null;
    if (!input.freshEpisode
        && input.progress === "none"
        && this.noProgressRounds >= RUN_NO_PROGRESS_NUDGE_ROUNDS
        && !this.noProgressEpisodeNudged) {
      this.noProgressEpisodeNudged = true;
      if (!input.suppressNoProgressNudge) {
        this.noProgressNudgeSent = true;
        nudge = { kind: "no_progress", rounds: this.noProgressRounds };
      }
    } else if (!input.freshEpisode
        && input.progress === "discovery"
        && this.discoveryOnlyRounds >= RUN_DISCOVERY_NUDGE_ROUNDS
        && !this.discoveryEpisodeNudged) {
      this.discoveryEpisodeNudged = true;
      this.discoveryStallNudgeSent = true;
      nudge = { kind: "discovery", rounds: this.discoveryOnlyRounds };
    }

    let stop: ProgressGovernorOutcome["stop"] = null;
    if (this.discoveryOnlyRounds >= RUN_DISCOVERY_STOP_ROUNDS) {
      this.discoveryStallStopped = true;
      stop = { kind: "discovery", stalledRounds: this.discoveryOnlyRounds };
    }

    return { nudge, stop };
  }
}
