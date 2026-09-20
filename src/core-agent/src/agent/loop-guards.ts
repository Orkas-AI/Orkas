import { createHash } from "node:crypto";
import type { ToolReadContinuation } from "../tools/base.js";

/**
 * Run-scoped spin guards for the agent loop, extracted from `runWithProvider`
 * so the counters, thresholds, and verdicts live in one place and can be
 * exercised without a provider. Two deliberately different mechanisms:
 *
 * 1) Repeat detection — a runaway agent proposes the SAME call over and over.
 *    Exact completed-evidence tier: nudge after LOOP_WARN unchanged rounds,
 *    then stop after two further unchanged rounds following delivered feedback. Near-duplicate tier
 *    (identical modulo volatile request-tracking keys): WARN-only by design —
 *    normalized matching is fuzzier, so a false positive must stay a benign
 *    one-time nudge, never a stop (71d4552bf; the silently added hard stop was
 *    removed 2026-08-12 and is pinned WARN-only by agent-runner tests).
 *
 * 2) Progress governor — a model can spin without ever repeating itself by
 *    varying filenames, cursors, or search terms. Each round is classified by
 *    observed outcomes. Proven unchanged results get a stalled-work advisory;
 *    extended exploration gets a separate investigation reminder. Unknown
 *    outcomes and coordination skip the stall counter. Neither advisory
 *    proves that the task is stuck or gains termination authority.
 *
 * The class owns counting and verdicts ONLY. The loop keeps ownership of
 * everything with wider context: round classification (it needs execution
 * observations), nudge delivery and logging, and terminal-result construction.
 */

/** Completed unchanged rounds before feedback and earliest stop. */
export const LOOP_WARN = 3;
export const LOOP_HARD = 5;

/** Near-duplicate loop_detection: nudge after this many CONSECUTIVE calls that
 *  are identical except for volatile id/timestamp
 *  fields. This tier catches "same call, fresh request-id/uuid each time"
 *  proposals without giving normalized matching stop authority. WARN-only by
 *  design: normalized matching is fuzzier than the exact tier, so a false
 *  positive must stay a benign one-time nudge, never a stop. An ignored nudge
 *  is bounded by the tool-round cap like any other unproductive work. */
export const NEAR_DUP_LOOP_WARN = 6;

/** Advisory thresholds only. Successful investigation can require many rounds;
 *  the global tool-loop budget and independent repeat guards still apply. */
export const RUN_NO_PROGRESS_NUDGE_ROUNDS = 2;
export const RUN_DISCOVERY_NUDGE_ROUNDS = 8;

/** What a tool round demonstrably added: productive effects, discovery of new
 * information, or none. Unknown outcomes and neutral coordination/waits skip
 * the counter. A successful tool return alone is not progress evidence. */
export type ToolRoundProgress = "neutral" | "unknown" | "none" | "discovery" | "productive";

/** Tools that only LOOK at state. A round made purely of these is exploration:
 *  eligible for an advisory reminder, not a separate execution limit. */
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
  if (current === "unknown" || next === "unknown") return "unknown";
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
  /** Compatibility field: coarse progress classifications never terminate. */
  stop: null;
};

export class LoopGuards {
  // Completed-round evidence and the separate proposal-only advisory.
  private completedSignature: string | null = null;
  private completedRounds = 0;
  private feedbackDelivered = false;
  private afterFeedbackRounds = 0;
  private evidenceNudgePending = false;
  private normSig: string | null = null;
  private normRepeat = 0;
  private normWarnedForStreak = false;
  private pendingRepeatNudge: string | null = null;

  // ── Progress governor ──
  private noProgressRounds = 0;
  private discoveryOnlyRounds = 0;
  private noProgressEpisodeNudged = false;
  private discoveryEpisodeNudged = false;

  /** Proven no-new-result rounds since observed progress. Unknown outcomes,
   *  successful coordination and bounded waits neither reset nor increment it. */
  get consecutiveNoProgressRounds(): number {
    return this.noProgressRounds;
  }

  // ── Convergence-signal flags (read by the loop's result meta). Set at the
  //    same moments the loop used to set its locals: repeat on delivery or
  //    hard stop, the others when their nudge/stop actually fires. ──
  repetitiveToolCallsDetected = false;
  noProgressNudgeSent = false;
  discoveryStallNudgeSent = false;

  /** Proposal similarity can advise, but never proves that execution stalled. */
  observeProposedCalls(
    calls: ReadonlyArray<{ name: string; input: unknown }>,
    inspectRead?: (call: { name: string; input: unknown }) => ToolReadContinuation | undefined,
  ): void {
    for (const call of calls) {
      const read = inspectRead?.(call);
      if (read?.waiting) {
        // Waiting on a live operation is not re-executing it. Its executor
        // owns the bounded wait/deadline; the global run budget still applies.
        this.normSig = null;
        this.normRepeat = 0;
        this.normWarnedForStreak = false;
        continue;
      }
      const nsig = read ? JSON.stringify([normalizedToolCallSignature(call), read.version]) : normalizedToolCallSignature(call);
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
  }

  resetCompletedRepeats(): void {
    this.completedSignature = null;
    this.completedRounds = this.afterFeedbackRounds = 0;
    this.feedbackDelivered = this.evidenceNudgePending = false;
  }

  /** Every executed sibling needs complete evidence. One batch is one feedback
   * round, regardless of repeated proposals inside it. Bounded digests retain
   * neither arguments nor results; overflow is inconclusive, never a stop. */
  observeCompletedRound(keys: readonly (string | undefined)[]): boolean {
    if (!keys.length || keys.length > 256 || keys.some(key => !key)) {
      this.resetCompletedRepeats();
      return false;
    }
    const signature = createHash("sha256").update(JSON.stringify([...new Set(keys)].sort())).digest("hex");
    if (signature !== this.completedSignature) {
      this.resetCompletedRepeats();
      this.completedSignature = signature;
    }
    this.completedRounds++;
    if (this.feedbackDelivered) this.afterFeedbackRounds++;
    else if (this.completedRounds >= LOOP_WARN) this.evidenceNudgePending = true;
    return this.feedbackDelivered && this.afterFeedbackRounds >= LOOP_HARD - LOOP_WARN;
  }

  pendingCompletedRepeatNudge(): string | null {
    return this.evidenceNudgePending
      ? `The same operations produced no new effect or information in ${this.completedRounds} consecutive completed rounds. `
        + "Use the committed results and choose a different useful next step. Two further consecutive unchanged rounds after this feedback will stop this run."
      : null;
  }

  /** Called only after a provider response completes for the request carrying
   * this control. Failed requests leave it pending; context resets discard it. */
  acknowledgeCompletedRepeatNudge(): void {
    if (!this.evidenceNudgePending) return;
    this.evidenceNudgePending = false;
    this.feedbackDelivered = true;
    this.repetitiveToolCallsDetected = true;
  }

  completedRepeatDiagnostics(): { rounds: number; afterFeedbackRounds: number; feedbackDelivered: boolean } {
    return { rounds: this.completedRounds, afterFeedbackRounds: this.afterFeedbackRounds, feedbackDelivered: this.feedbackDelivered };
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
    /** Exploration is a separate advisory, not evidence of stalled work. */
    discoveryOnly?: boolean;
  }): ProgressGovernorOutcome {
    const discoveryOnly = input.progress !== "unknown" && input.progress !== "neutral"
      && (input.discoveryOnly ?? input.progress === "discovery");
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
    } else {
      if (input.progress === "discovery") {
        this.noProgressRounds = 0;
        this.noProgressEpisodeNudged = false;
      } else if (input.progress === "none") {
        this.noProgressRounds++;
      }
      if (discoveryOnly) this.discoveryOnlyRounds++;
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
        && discoveryOnly
        && this.discoveryOnlyRounds >= RUN_DISCOVERY_NUDGE_ROUNDS
        && !this.discoveryEpisodeNudged) {
      this.discoveryEpisodeNudged = true;
      this.discoveryStallNudgeSent = true;
      nudge = { kind: "discovery", rounds: this.discoveryOnlyRounds };
    }

    return { nudge, stop: null };
  }
}
