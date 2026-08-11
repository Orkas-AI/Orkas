/**
 * Context budget derivation.
 *
 * Compaction used to run on fixed token counts (18K active / 12K history) that
 * had no relationship to the model's context window. They were tuned when 200K
 * was the ceiling, so a 1M-window model compacted at the same absolute size as
 * a 32K one — and, less obviously, a 32K model was the dangerous side: its
 * ~25K of usable input never reached an 18K trigger with room to act, so the
 * layered triggers effectively did not defend it at all.
 *
 * The budget is derived top-down instead:
 *
 *   usableInputTokens = contextWindow − maxOutputTokens − safety   (caller)
 *   fixedOverhead     = systemPrompt + toolDefs + ephemeral        (caller)
 *   messageBudget     = max(usable × MIN_MESSAGE_SHARE, usable − fixedOverhead)
 *
 * The `max` is a fuse: when the tool set grows large enough to consume the
 * window, messages still get a floor share so compaction keeps working rather
 * than computing a negative budget.
 *
 * Triggers take a share of `messageBudget` and everything else derives from the
 * trigger, so the ratios below are the only tunable surface. Their sum is well
 * under 1: the remainder covers injected runtime state (workspace ledger,
 * completed-work ledger, plan anchor), the active user message, and the growth
 * that keeps happening between the moment a trigger fires and the moment its
 * async summary lands.
 *
 * Pure arithmetic — no Session, no runner, no I/O.
 */

/** Defaults, kept exactly at the historical values so an un-parameterized call
 *  (tests, reflection, summarization — anything with no model in scope)
 *  behaves byte-for-byte as before. */
export const HISTORY_RAW_TRIGGER_TOKENS = 12_000;
export const HISTORY_RAW_RETAIN_TOKEN_BUDGET = 3_000;
export const HISTORY_RAW_RETAIN_SINGLE_TURN_MAX_TOKENS = 2_000;
export const ACTIVE_PROCESS_TRIGGER_TOKENS = 18_000;
export const ACTIVE_RETAIN_TOKEN_BUDGET = 8_000;
export const ACTIVE_SINGLE_STEP_RAW_MAX_TOKENS = 4_000;
export const ACTIVE_COMPACTION_MIN_SAVINGS_TOKENS = 6_000;
export const MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND = 16_000;

/** Share of usable input that messages keep even when fixed overhead would
 *  otherwise swallow the window. */
const MIN_MESSAGE_SHARE = 0.2;

/** Chosen to preserve the historical 1.5:1 ratio between the two layers, and
 *  calibrated so a 60,000-token message budget derives exactly the constants
 *  above — the defaults are therefore not a separate policy, they are this
 *  formula evaluated at the window size the fixed values were tuned for. */
const ACTIVE_TRIGGER_SHARE = 0.3;
const HISTORY_TRIGGER_SHARE = 0.2;
const INLINE_ROUND_SHARE = 0.1;

/** Derived from the trigger, preserving the historical proportions. */
const ACTIVE_RETAIN_SHARE = 0.45;
const ACTIVE_SINGLE_STEP_SHARE = 0.5;
const ACTIVE_MIN_SAVINGS_SHARE = 0.33;
const HISTORY_RETAIN_SHARE = 0.25;
const HISTORY_SINGLE_TURN_SHARE = 0.15;

/** Ceilings. Not derived from anything — deliberately conservative pending the
 *  re-read instrumentation (see docs/plans/context-budget-consolidation.md).
 *  Rationale, none of it quantified yet: the token estimator is a heuristic
 *  whose absolute error scales with the number; a summarization call has to
 *  read everything it compacts, so a very large trigger makes that call slow
 *  and expensive; and recall degrades in the middle of very long contexts. */
const ACTIVE_TRIGGER_CAP = 120_000;
const HISTORY_TRIGGER_CAP = 48_000;
const INLINE_ROUND_CAP = MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND * 4;

/** No lower bound on purpose. An absolute floor was tried and removed: on a
 *  window small enough to need one, the floor pushed the two triggers' sum past
 *  the whole message budget, which is the one thing that must never happen. A
 *  tiny window genuinely has to compact early; that is a property of the model,
 *  not a misconfiguration to paper over. */
const MIN_TRIGGER = 0;

/** Floor for the per-result inline ceiling. Small windows genuinely have to
 *  spill early, but a ceiling derived straight from a tiny window would reject
 *  results the round ledger would still have admitted, which is churn rather
 *  than protection. Unlike the trigger floors removed in batch 2, this one
 *  cannot break the trigger-sum invariant: it is not part of that sum. */
export const MIN_PER_RESULT_INLINE_TOKENS = 2_000;

/** How much more a document the model was told to read whole may inline than
 *  an ordinary tool result. A skill body is requested, bounded by what an
 *  author wrote, and useless in fragments; a search or command dump is none of
 *  those. It is headroom, not a target — `skill-inline-budget.test.ts` holds
 *  authored skills to the ordinary budget — and the per-round ledger still
 *  applies either way. */
export const VERBATIM_DOCUMENT_INLINE_MULTIPLE = 2;

export type ContextBudget = {
  activeProcessTrigger: number;
  activeRetainTokens: number;
  activeSingleStepMaxTokens: number;
  activeMinSavingsTokens: number;
  historyTrigger: number;
  historyRetainTokens: number;
  historySingleTurnMaxTokens: number;
  inlineResultTokensPerRound: number;
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  activeProcessTrigger: ACTIVE_PROCESS_TRIGGER_TOKENS,
  activeRetainTokens: ACTIVE_RETAIN_TOKEN_BUDGET,
  activeSingleStepMaxTokens: ACTIVE_SINGLE_STEP_RAW_MAX_TOKENS,
  activeMinSavingsTokens: ACTIVE_COMPACTION_MIN_SAVINGS_TOKENS,
  historyTrigger: HISTORY_RAW_TRIGGER_TOKENS,
  historyRetainTokens: HISTORY_RAW_RETAIN_TOKEN_BUDGET,
  historySingleTurnMaxTokens: HISTORY_RAW_RETAIN_SINGLE_TURN_MAX_TOKENS,
  inlineResultTokensPerRound: MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND,
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Message-facing token budget after fixed request overhead. Exported so the
 *  caller can log it: `fixedOverheadTokens` is otherwise invisible, and every
 *  derived threshold moves with it. */
export function messageBudgetTokens(input: {
  usableInputTokens: number;
  fixedOverheadTokens: number;
}): number {
  const usable = Math.max(0, Math.trunc(input.usableInputTokens) || 0);
  const overhead = Math.max(0, Math.trunc(input.fixedOverheadTokens) || 0);
  return Math.max(Math.floor(usable * MIN_MESSAGE_SHARE), usable - overhead);
}

/**
 * Derive every compaction threshold from the model's real window.
 *
 * Returns the historical defaults when the window is unknown or unusable, so a
 * caller that cannot resolve a model never silently gets a degenerate budget.
 */
export function contextBudget(input: {
  usableInputTokens: number;
  fixedOverheadTokens: number;
}): ContextBudget {
  const usable = Math.trunc(input.usableInputTokens) || 0;
  if (!Number.isFinite(usable) || usable <= 0) return DEFAULT_CONTEXT_BUDGET;

  const messageBudget = messageBudgetTokens(input);
  const activeProcessTrigger = clamp(
    messageBudget * ACTIVE_TRIGGER_SHARE,
    MIN_TRIGGER,
    ACTIVE_TRIGGER_CAP,
  );
  const historyTrigger = clamp(
    messageBudget * HISTORY_TRIGGER_SHARE,
    MIN_TRIGGER,
    HISTORY_TRIGGER_CAP,
  );
  const activeRetainTokens = Math.round(activeProcessTrigger * ACTIVE_RETAIN_SHARE);

  return {
    activeProcessTrigger,
    activeRetainTokens,
    activeSingleStepMaxTokens: Math.floor(activeRetainTokens * ACTIVE_SINGLE_STEP_SHARE),
    activeMinSavingsTokens: Math.round(activeProcessTrigger * ACTIVE_MIN_SAVINGS_SHARE),
    historyTrigger,
    historyRetainTokens: Math.round(historyTrigger * HISTORY_RETAIN_SHARE),
    historySingleTurnMaxTokens: Math.round(historyTrigger * HISTORY_SINGLE_TURN_SHARE),
    inlineResultTokensPerRound: clamp(
      messageBudget * INLINE_ROUND_SHARE,
      Math.min(MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND, Math.floor(usable * INLINE_ROUND_SHARE)),
      INLINE_ROUND_CAP,
    ),
  };
}
