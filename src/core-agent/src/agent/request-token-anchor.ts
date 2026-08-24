/**
 * Request-token anchor.
 *
 * Request-level context decisions (per-round inline result ledger, the 0.82
 * budget line, emergency reduction) used to measure the whole request with the
 * local estimator, whose absolute error scales with request size — CJK text is
 * weighed at 1.5 tokens/char against real tokenizers' ~0.6-1.0, and image
 * blocks at a flat per-block figure regardless of their real dimension-scaled
 * cost. The provider already reports what the
 * previous request actually cost, so the anchor ties those decisions to that
 * real measurement and applies the estimator only to what changed since:
 *
 *   anchored = realTokens + (estimateNow − estimateAtAnchor)
 *
 * The differential cancels the estimator's absolute error; only the delta —
 * typically this round's tool results — is estimated. Folding, archiving, and
 * other rewrites of already-anchored content cannot be attributed by the
 * differential, so any such rewrite bumps `Session.contentEpoch()` and the
 * anchor is discarded until the next completed call re-anchors. Segment-level
 * triggers (active-process / history) measure *which part* of the context can
 * fold, which a single real total cannot attribute — they stay estimator-based
 * on purpose.
 *
 * Pure arithmetic — no Session, no runner, no I/O.
 */

import type { Usage } from "../shared/types.js";

export type RequestTokenAnchor = {
  /** Real request+response footprint of the anchored call. */
  realTokens: number;
  /** Full-request estimate captured at the same instant, same request shape. */
  estimatedTokens: number;
  /** `Session.contentEpoch()` at the anchor point. */
  contentEpoch: number;
};

export type AnchoredRequestTokens = {
  tokens: number;
  /** Which measurement produced `tokens`; logged so refusals and compaction
   *  decisions can be attributed to the estimator or to provider truth. */
  source: "anchored" | "estimated";
};

/**
 * Full request+response footprint of one completed call.
 *
 * pi-ai normalizes usage for every adapter so `input` excludes the cache
 * components (verified for anthropic-messages and openai-completions: OpenAI's
 * `prompt_tokens` has `cached_tokens` subtracted back out), so the four fields
 * sum to the whole context the provider actually processed. Returns 0 when the
 * prompt side is unreported — a zero anchor would misprice every later
 * decision, so callers must not anchor on it.
 */
export function usageRequestFootprintTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  const input = Math.max(0, usage.inputTokens || 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens || 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens || 0);
  const promptSide = input + cacheRead + cacheWrite;
  if (promptSide <= 0) return 0;
  return promptSide + Math.max(0, usage.outputTokens || 0);
}

/** Resolve the request size for a decision: anchored when the anchor is still
 *  valid for the session's current content epoch, estimator otherwise. */
export function anchoredRequestTokens(
  anchor: RequestTokenAnchor | null,
  estimatedNow: number,
  contentEpochNow: number,
): AnchoredRequestTokens {
  if (
    !anchor
    || anchor.realTokens <= 0
    || anchor.contentEpoch !== contentEpochNow
  ) {
    return { tokens: estimatedNow, source: "estimated" };
  }
  return {
    tokens: Math.max(0, anchor.realTokens + (estimatedNow - anchor.estimatedTokens)),
    source: "anchored",
  };
}
