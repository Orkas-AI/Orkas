import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET,
  TOOL_RESULT_RESERVE_FLOOR_TOKENS,
  contextBudget,
  type ContextBudget,
} from "../src/agent/context-budget.js";

/** Windows spanning the models the catalog actually carries, plus the extremes
 *  on either side of them. */
const WINDOWS = [8_000, 32_000, 64_000, 128_000, 200_000, 400_000, 1_048_576, 2_000_000];
/** Fixed overhead ranges from a bare tool set to one that would swallow a small
 *  window whole. */
const OVERHEADS = [0, 5_000, 20_000, 30_000, 60_000, 200_000];
/** The runner's estimator margin; the budget takes the resulting ceiling. */
const CEILING_RATIO = 0.82;

function budgetFor(window: number, overhead: number, residentState = 0): { budget: ContextBudget; usable: number; ceiling: number } {
  const usable = window - 8_192;
  const ceiling = Math.floor(usable * CEILING_RATIO);
  return {
    budget: contextBudget({ usableInputTokens: usable, requestCeilingTokens: ceiling, fixedOverheadTokens: overhead, residentStateTokens: residentState }),
    usable,
    ceiling,
  };
}

describe("contextBudget", () => {
  // These are what keep compaction from either thrashing or arriving too late.
  // A ratio change that breaks any of them is a silent regression: the
  // thresholds still look reasonable in isolation.
  it("holds its invariants across every window and overhead combination", () => {
    for (const window of WINDOWS) {
      for (const overhead of OVERHEADS) {
        const { budget, ceiling, usable } = budgetFor(window, overhead);
        // A window no larger than its output reservation has no usable input
        // at all and resolves to the anchor defaults, covered below.
        if (usable <= 0) continue;
        const where = `window=${window} overhead=${overhead}`;

        // Retention below the trigger: otherwise a pass ends above the line it
        // just crossed and fires again immediately.
        expect(budget.activeRetainTokens, where).toBeLessThan(budget.activeProcessTrigger);

        // At least two steps can be kept verbatim within the retention budget.
        expect(budget.activeSingleStepMaxTokens, where)
          .toBeLessThanOrEqual(budget.activeRetainTokens / 2);

        if (budget.windowTooSmall) continue;
        // Both layers full plus the planning reserve and measured fixed
        // costs must still fit under the ceiling; actual batch admission is
        // separately bounded by the remaining request capacity.
        expect(
          overhead + budget.activeProcessTrigger + Math.round((budget.layeredRoomTokens - budget.toolResultReserveTokens) * 0.4) + budget.toolResultReserveTokens,
          where,
        ).toBeLessThanOrEqual(ceiling + 2);
      }
    }
  });

  it("returns the anchor defaults when the window is unknown or unusable", () => {
    for (const usableInputTokens of [0, -1, Number.NaN]) {
      expect(contextBudget({ usableInputTokens, requestCeilingTokens: 0, fixedOverheadTokens: 0 })).toEqual(DEFAULT_CONTEXT_BUDGET);
    }
  });

  // The defaults used to be hand-written constants that drifted from the
  // formula. A caller with no model in scope must get the same policy as a
  // caller with one — the formula at the room the constants were tuned at.
  it("makes the defaults the formula evaluated at its anchor, not a second policy", () => {
    const atAnchor = contextBudget({ usableInputTokens: 60_000, requestCeilingTokens: 36_000, fixedOverheadTokens: 0 });
    const { toolResultReserveTokens: _inline, ...anchorTriggers } = atAnchor;
    const { toolResultReserveTokens: defaultInline, ...defaultTriggers } = DEFAULT_CONTEXT_BUDGET;
    expect(defaultTriggers).toEqual(anchorTriggers);
    // Unknown-model compaction keeps its historical reserve; the runner
    // no longer uses it to limit the aggregate tool result size.
    expect(defaultInline).toBe(TOOL_RESULT_RESERVE_FLOOR_TOKENS);
    // Compatibility anchor: the two triggers logs and docs quote for an
    // unknown model are unchanged.
    expect(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger).toBe(18_000);
    expect(DEFAULT_CONTEXT_BUDGET.windowTooSmall).toBe(false);
  });

  it("scales with the window instead of pinning the historical constants", () => {
    const small = budgetFor(64_000, 20_000).budget;
    const mid = budgetFor(200_000, 30_000).budget;
    const large = budgetFor(1_048_576, 30_000).budget;
    const huge = budgetFor(2_000_000, 30_000).budget;

    // A 200K model gets materially more room than the fixed 18K it used to.
    expect(mid.activeProcessTrigger).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);
    // A 64K model with a 20K prompt tightens below the old constants instead.
    expect(small.activeProcessTrigger).toBeLessThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);

    expect(small.activeProcessTrigger).toBeLessThan(mid.activeProcessTrigger);
    expect(mid.activeProcessTrigger).toBeLessThan(large.activeProcessTrigger);
    // No absolute ceiling any more: a larger window keeps buying room.
    expect(huge.activeProcessTrigger).toBeGreaterThan(large.activeProcessTrigger);
  });

  // The two layers are one design: the history layer is sized as two thirds
  // of the active layer so that dialogue is archived before execution detail
  // is. That has to hold on every window, or no threshold looks wrong in
  // isolation while the layers drift apart.
  it("preserves the active checkpoint sizing share on every window", () => {
    for (const window of WINDOWS) {
      for (const overhead of OVERHEADS) {
        const { budget, usable } = budgetFor(window, overhead);
        if (usable <= 0 || budget.windowTooSmall) continue;
        const where = `window=${window} overhead=${overhead}`;
        expect(Math.abs(budget.activeProcessTrigger - 1.5 * Math.round((budget.layeredRoomTokens - budget.toolResultReserveTokens) * 0.4)), where).toBeLessThanOrEqual(2);
      }
    }
  });

  // The round allowance is the tolerated overshoot past the active trigger
  // (one round of results lands between two checkpoint checks). It is one
  // third of the trigger by design; a share edited on its own would silently
  // let a single round push the active process further past the trigger.
  it("keeps the round inline allowance at one third of the active trigger", () => {
    for (const window of WINDOWS) {
      for (const overhead of OVERHEADS) {
        const { budget, usable } = budgetFor(window, overhead);
        if (usable <= 0 || budget.windowTooSmall) continue;
        // Below the small-window floor the floor speaks, not the share.
        if (budget.toolResultReserveTokens <= Math.min(TOOL_RESULT_RESERVE_FLOOR_TOKENS, Math.floor(usable * 0.1))) continue;
        const where = `window=${window} overhead=${overhead}`;
        expect(Math.abs(budget.toolResultReserveTokens - budget.activeProcessTrigger / 3), where).toBeLessThanOrEqual(1);
      }
    }
  });

  // Fixed shares of the window could not be tuned because the costs that do
  // not scale with the window (prompt, ledgers, summaries) make the safe fill
  // window-dependent. Deriving from the room measured per request means
  // resident state directly shrinks the allowances, never the margin.
  it("shrinks the allowances by exactly the resident state it is told about", () => {
    const bare = budgetFor(1_048_576, 30_000, 0).budget;
    const loaded = budgetFor(1_048_576, 30_000, 120_000).budget;
    expect(loaded.layeredRoomTokens).toBe(bare.layeredRoomTokens - 120_000);
    expect(loaded.residentStateTokens).toBe(120_000);
    expect(loaded.activeProcessTrigger).toBeLessThan(bare.activeProcessTrigger);
    // The shape is unchanged: only the size moved.
    expect(Math.abs(loaded.activeProcessTrigger - 1.5 * Math.round((loaded.layeredRoomTokens - loaded.toolResultReserveTokens) * 0.4))).toBeLessThanOrEqual(2);
  });

  // A window that cannot hold a useful layered budget must not pretend it
  // can: a trigger of a few hundred tokens would fire a summarization call
  // on every step and free nothing. Such a window parks the triggers at the
  // window and leaves the emergency layer to act.
  it("parks the layered triggers when the room is too small for them to work", () => {
    const { budget, usable } = budgetFor(32_000, 20_000);
    expect(budget.windowTooSmall).toBe(true);
    expect(budget.activeProcessTrigger).toBe(usable);
    // Fixed overhead above the ceiling is the same situation, not a crash.
    const swallowed = budgetFor(128_000, 200_000).budget;
    expect(swallowed.windowTooSmall).toBe(true);
    expect(swallowed.layeredRoomTokens).toBe(0);
    // A merely narrow window still gets a working layered budget.
    expect(budgetFor(64_000, 20_000).budget.windowTooSmall).toBe(false);
  });

  // A fixed 1,200-token summary standing in for 270K of folded process gives
  // each fact a fifth of the room it had at 60K, and every fact the summary
  // drops is a later re-read. The target follows the active trigger, keeps
  // today's size on every window the old constants served, and is bounded.
  it("sizes the compaction summary with the active trigger", () => {
    const smallish = budgetFor(128_000, 30_000).budget;   // active trigger ~34K: 2% is under the floor
    const large = budgetFor(1_048_576, 30_000).budget;
    expect(smallish.summaryTargetTokens).toBe(1_200);
    expect(smallish.summaryHardTokens).toBe(2_000);
    expect(large.summaryTargetTokens).toBeGreaterThan(smallish.summaryTargetTokens);
    expect(large.summaryTargetTokens).toBeLessThanOrEqual(6_000);
    // Storage keeps its 5:3 ratio to the target on every budget.
    for (const b of [smallish, large, DEFAULT_CONTEXT_BUDGET]) {
      expect(Math.abs(b.summaryHardTokens - b.summaryTargetTokens * 5 / 3)).toBeLessThanOrEqual(1);
      // The summary must stay a small part of what the checkpoint may keep.
      expect(b.summaryTargetTokens).toBeLessThan(b.activeRetainTokens);
    }
    expect(DEFAULT_CONTEXT_BUDGET.summaryTargetTokens).toBe(1_200);
    expect(DEFAULT_CONTEXT_BUDGET.summaryHardTokens).toBe(2_000);
  });

  it("reserves room for tool results when deriving compaction triggers", () => {
    const mid = budgetFor(200_000, 30_000).budget;
    const large = budgetFor(1_048_576, 30_000).budget;
    const small = budgetFor(64_000, 20_000).budget;

    expect(mid.toolResultReserveTokens).toBeGreaterThanOrEqual(TOOL_RESULT_RESERVE_FLOOR_TOKENS);
    expect(large.toolResultReserveTokens).toBeGreaterThan(mid.toolResultReserveTokens);
    expect(small.toolResultReserveTokens).toBeLessThan(TOOL_RESULT_RESERVE_FLOOR_TOKENS);
    expect(small.toolResultReserveTokens).toBeGreaterThan(0);
  });
});

describe("history-room borrowing", () => {
  // A fresh turn has no completed history, so the history share is idle; the
  // active trigger takes it until turns complete. Everything that describes
  // one fold (retention, summary size) stays on the fixed
  // share — a bigger held process does not mean a bigger fold.
  const occupied = (occupancy: number | undefined) => {
    const usable = 1_048_576 - 8_192;
    return contextBudget({
      usableInputTokens: usable,
      requestCeilingTokens: Math.floor(usable * CEILING_RATIO),
      fixedOverheadTokens: 20_000,
      residentStateTokens: 3_000,
      ...(occupancy === undefined ? {} : { historyOccupancyTokens: occupancy }),
    });
  };
  const fixed = occupied(undefined);

  it("keeps the fixed split when history occupancy is unknown", () => {
    expect(fixed.activeBorrowedTokens).toBe(0);
    expect(fixed.activeProcessTrigger + Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4) + fixed.toolResultReserveTokens).toBeLessThanOrEqual(fixed.layeredRoomTokens + 2);
  });

  it("lets an empty history's whole share go to the active turn", () => {
    const empty = occupied(0);
    expect(empty.activeBorrowedTokens).toBe(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4));
    expect(empty.activeProcessTrigger).toBe(fixed.activeProcessTrigger + Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4));
    // The trigger leaves the planning reserve below the ceiling.
    expect(empty.activeProcessTrigger + empty.toolResultReserveTokens).toBeLessThanOrEqual(empty.layeredRoomTokens + 2);
  });

  it("recedes as history fills and stops at the fixed share once the layer is full", () => {
    const half = occupied(Math.floor(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4) / 2));
    expect(half.activeBorrowedTokens).toBe(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4) - Math.floor(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4) / 2));
    expect(occupied(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4)).activeProcessTrigger).toBe(fixed.activeProcessTrigger);
    // History above its trigger (compaction failing) takes nothing away from
    // the active layer's own share.
    expect(occupied(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4) * 3).activeProcessTrigger).toBe(fixed.activeProcessTrigger);
    expect(occupied(-5).activeBorrowedTokens).toBe(Math.round((fixed.layeredRoomTokens - fixed.toolResultReserveTokens) * 0.4));
  });

  it("leaves the per-fold quantities on the fixed share", () => {
    const empty = occupied(0);
    for (const key of ["activeRetainTokens", "activeSingleStepMaxTokens", "summaryTargetTokens", "summaryHardTokens", "toolResultReserveTokens"] as const) {
      expect(empty[key], key).toBe(fixed[key]);
    }
    expect(empty.activeRetainTokens).toBeLessThan(empty.activeProcessTrigger);
  });

  it("does not borrow on a window too small for layered compaction", () => {
    const tiny = contextBudget({ usableInputTokens: 12_000, requestCeilingTokens: 9_840, fixedOverheadTokens: 4_000, historyOccupancyTokens: 0 });
    expect(tiny.windowTooSmall).toBe(true);
    expect(tiny.activeBorrowedTokens).toBe(0);
    expect(tiny.activeProcessTrigger).toBe(12_000);
  });
});
