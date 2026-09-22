/**
 * Active-process compaction budgets derived from usable request room after
 * measured prompt/tool overhead and resident state. Completed conversation
 * history independently uses five turns and min(30K tokens, 20% of turn-start room).
 *
 * Reserve one sixth of room for growth between checks; this is planning room,
 * not a tool-result admission cap. Preserve the active checkpoint's existing
 * 60% sizing share and allow its trigger to borrow unused room from the other
 * 40% after subtracting measured history occupancy. There is no historical
 * compression trigger. Retained-tail and summary sizes use the base active
 * share, so borrowing does not enlarge an individual fold without a bound.
 *
 * Pure arithmetic — no Session, runner or I/O.
 */

/** Historical compaction reserve floor, reduced on small windows. This is
 * not a per-round result-admission ceiling. */
export const TOOL_RESULT_RESERVE_FLOOR_TOKENS = 16_000;

/** Prompt-level target for one compaction summary at the smallest budget
 *  (also the floor the derived target never goes below). It is deliberately
 *  not sent as a provider output limit: reasoning-capable models must be
 *  allowed to finish reasoning and produce final text before the Host bounds
 *  storage. */
export const CONTEXT_COMPACTION_SUMMARY_PREFERRED_MAX_TOKENS = 1_200;
/** Host-side storage ceiling for one summary at the floor target. */
export const CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS = 2_000;
/** The summary target grows with the active trigger: a fixed 1,200-token
 *  summary standing in for 270K of folded process gives each fact a fifth of
 *  the room it had at 60K, and every lost fact is a re-read. Two percent of
 *  the trigger keeps the floor on every window the old constants served
 *  (a 45K trigger still yields 1,200) and rises to the ceiling on 1M windows;
 *  the storage bound keeps its historical 5:3 ratio to the target. */
const SUMMARY_TARGET_SHARE_OF_ACTIVE = 0.02;
const SUMMARY_TARGET_MAX_TOKENS = 6_000;
const SUMMARY_HARD_MULTIPLE = CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS / CONTEXT_COMPACTION_SUMMARY_PREFERRED_MAX_TOKENS;

/** Compatibility anchor for unknown-model active-process budgeting. */
const DEFAULT_BUDGET_ROOM_TOKENS = 36_000;

/** Below this much room the layered triggers cannot do useful work: the
 *  active trigger would hold fewer than four summaries' worth, so a checkpoint
 *  has little room for a useful retained tail. Such a window runs on the
 *  emergency layer alone (triggers parked at the window, see
 *  `windowTooSmall`) instead of thrashing summarization calls. */
const MIN_LAYERED_ROOM_TOKENS = CONTEXT_COMPACTION_SUMMARY_PREFERRED_MAX_TOKENS * 8;

/** Leave growth room between compaction checks without capping a batch at
 * this share. Small-window reserve floors reduce compaction planning room. */
const INLINE_ROOM_SHARE = 1 / 6;
const ACTIVE_TRIGGER_SHARE_OF_REST = 0.6;
const HISTORY_ROOM_SHARE_OF_REST = 0.4;

/** Derived from the trigger, preserving the historical proportions. */
const ACTIVE_RETAIN_SHARE = 0.45;
const ACTIVE_SINGLE_STEP_SHARE = 0.5;
/** Fixed payload limit for one active checkpoint, including the existing
 *  summary. The runner also clamps it to the compactor's framed capacity.
 *  Complete groups that do not fit remain raw for a later batch. */
export const MAX_ACTIVE_CHECKPOINT_INPUT_TOKENS = 150_000;

/** Fixed per-result admission limits, independent of model window and raw-tail
 *  retention. The round ledger still enforces available request headroom.
 *  The ordinary limit matches the synchronous host policy's default;
 *  Skill documents get room for a complete read without admitting large dumps. */
export const MAX_PER_RESULT_INLINE_TOKENS = 10_000;
export const MAX_VERBATIM_DOCUMENT_INLINE_TOKENS = 25_000;

export type ContextBudget = {
  /** Effective active-turn trigger: the fixed share plus the room the history
   *  layer is not occupying (`activeBorrowedTokens`). */
  activeProcessTrigger: number;
  /** Part of `activeProcessTrigger` borrowed from the history layer's unused
   *  room; zero when history occupancy is unknown or the layer is full. */
  activeBorrowedTokens: number;
  activeRetainTokens: number;
  activeSingleStepMaxTokens: number;
  /** Planning reserve for compaction triggers, never a result admission cap. */
  toolResultReserveTokens: number;
  /** Prompt-level size one compaction summary is asked to stay under. */
  summaryTargetTokens: number;
  /** Host-side storage ceiling for one summary produced under this budget. */
  summaryHardTokens: number;
  /** Ceiling minus measured fixed overhead and resident state: what the
   *  three layered allowances were divided out of. Logged. */
  layeredRoomTokens: number;
  /** The measured non-foldable state this budget accounted for. Logged. */
  residentStateTokens: number;
  /** The room is too small for layered compaction to do useful work; the
   *  triggers are parked at the window so only the emergency layer acts. */
  windowTooSmall: boolean;
};

function deriveContextBudget(
  room: number,
  usable: number,
  residentState: number,
  historyOccupancy?: number,
): ContextBudget {
  const windowTooSmall = room < MIN_LAYERED_ROOM_TOKENS;
  const inlineFloor = Math.min(TOOL_RESULT_RESERVE_FLOOR_TOKENS, Math.floor(usable * 0.1));
  const toolResultReserveTokens = Math.max(inlineFloor, windowTooSmall ? 0 : Math.round(room * INLINE_ROOM_SHARE));
  const rest = Math.max(0, room - toolResultReserveTokens);
  const activeShare = Math.round(rest * ACTIVE_TRIGGER_SHARE_OF_REST);
  const historyRoom = windowTooSmall ? usable : Math.round(rest * HISTORY_ROOM_SHARE_OF_REST);
  // The history layer's unused room goes to the active turn. Occupancy is in
  // the trigger comparison's units (already calibrated by the caller); an
  // unknown occupancy borrows nothing, so budgets built without a session keep
  // the fixed split.
  const occupancy = historyOccupancy === undefined ? undefined : Math.max(0, Math.trunc(historyOccupancy) || 0);
  const activeBorrowedTokens = windowTooSmall || occupancy === undefined ? 0 : Math.max(0, historyRoom - occupancy);
  const activeProcessTrigger = windowTooSmall ? usable : activeShare + activeBorrowedTokens;
  // Everything below describes one fold and stays on the fixed share.
  const activeRetainTokens = Math.round(activeShare * ACTIVE_RETAIN_SHARE);
  const summaryTargetTokens = Math.min(
    SUMMARY_TARGET_MAX_TOKENS,
    Math.max(CONTEXT_COMPACTION_SUMMARY_PREFERRED_MAX_TOKENS, Math.round(activeShare * SUMMARY_TARGET_SHARE_OF_ACTIVE)),
  );
  return {
    activeProcessTrigger,
    activeBorrowedTokens,
    activeRetainTokens,
    activeSingleStepMaxTokens: Math.floor(activeRetainTokens * ACTIVE_SINGLE_STEP_SHARE),
    toolResultReserveTokens,
    summaryTargetTokens,
    summaryHardTokens: Math.round(summaryTargetTokens * SUMMARY_HARD_MULTIPLE),
    layeredRoomTokens: room,
    residentStateTokens: residentState,
    windowTooSmall,
  };
}

/** Unknown-model compaction keeps the 18K active trigger
 * and 16K planning reserve. These are compatibility values, not a second
 * request-capacity limit; the runner derives admission from its resolved (or
 * fallback) usable window and measured/estimated current request size. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  ...deriveContextBudget(DEFAULT_BUDGET_ROOM_TOKENS, 60_000, 0),
  toolResultReserveTokens: TOOL_RESULT_RESERVE_FLOOR_TOKENS,
});

/**
 * Derive every compaction threshold from the room the request has.
 *
 * Returns the anchor defaults when the window is unknown or unusable, so a
 * caller that cannot resolve a model never silently gets a degenerate budget.
 */
export function contextBudget(input: {
  usableInputTokens: number;
  /** The request ceiling the runtime enforces (usable input after the
   *  estimator margin); the runner owns that margin. */
  requestCeilingTokens: number;
  fixedOverheadTokens: number;
  /** Measured non-foldable state already in the request: the active user
   *  message, injected ledgers, plan anchor and existing summaries. */
  residentStateTokens?: number;
  /** Completed history occupancy in calibrated estimated tokens. Used only
   *  to derive active-process borrowing, never to trigger history compression. */
  historyOccupancyTokens?: number;
}): ContextBudget {
  const usable = Math.trunc(input.usableInputTokens) || 0;
  if (!Number.isFinite(usable) || usable <= 0) return DEFAULT_CONTEXT_BUDGET;
  const ceiling = Math.max(0, Math.trunc(input.requestCeilingTokens) || 0);
  const overhead = Math.max(0, Math.trunc(input.fixedOverheadTokens) || 0);
  const resident = Math.max(0, Math.trunc(input.residentStateTokens ?? 0) || 0);
  const room = Math.max(0, ceiling - overhead - resident);
  const occupancy = Number.isFinite(input.historyOccupancyTokens as number) ? (input.historyOccupancyTokens as number) : undefined;
  return deriveContextBudget(room, usable, resident, occupancy);
}
