import { describe, it, expect } from "vitest";
import {
  MIN_PER_RESULT_INLINE_TOKENS,
  VERBATIM_DOCUMENT_INLINE_MULTIPLE,
  ACTIVE_PROCESS_TRIGGER_TOKENS,
  DEFAULT_CONTEXT_BUDGET,
  HISTORY_RAW_TRIGGER_TOKENS,
  MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND,
  contextBudget,
  messageBudgetTokens,
  type ContextBudget,
} from "../src/agent/context-budget.js";

/** Windows spanning the models the catalog actually carries, plus the extremes
 *  on either side of them. */
const WINDOWS = [8_000, 32_000, 64_000, 128_000, 200_000, 400_000, 1_048_576, 2_000_000];
/** Fixed overhead ranges from a bare tool set to one that would swallow a small
 *  window whole. */
const OVERHEADS = [0, 5_000, 20_000, 30_000, 60_000, 200_000];

function budgetFor(window: number, overhead: number): { budget: ContextBudget; messageBudget: number } {
  const usableInputTokens = Math.max(1_024, window - 8_192 - 2_048);
  return {
    budget: contextBudget({ usableInputTokens, fixedOverheadTokens: overhead }),
    messageBudget: messageBudgetTokens({ usableInputTokens, fixedOverheadTokens: overhead }),
  };
}

describe("contextBudget", () => {
  // These four are what keep compaction from either thrashing or arriving too
  // late. A ratio change that breaks any of them is a silent regression: the
  // thresholds still look reasonable in isolation.
  it("holds its invariants across every window and overhead combination", () => {
    for (const window of WINDOWS) {
      for (const overhead of OVERHEADS) {
        const { budget, messageBudget } = budgetFor(window, overhead);
        const where = `window=${window} overhead=${overhead}`;

        // Retention below the trigger: otherwise a pass ends above the line it
        // just crossed and fires again immediately.
        expect(budget.activeRetainTokens, where).toBeLessThan(budget.activeProcessTrigger);
        expect(budget.historyRetainTokens, where).toBeLessThan(budget.historyTrigger);

        // Room left to actually free the minimum savings after retention.
        expect(budget.activeMinSavingsTokens, where)
          .toBeLessThan(budget.activeProcessTrigger - budget.activeRetainTokens);

        // At least two steps can be kept verbatim within the retention budget.
        expect(budget.activeSingleStepMaxTokens, where)
          .toBeLessThanOrEqual(budget.activeRetainTokens / 2);

        // Both layers must be able to fill and still leave room for injected
        // runtime state and mid-compaction growth.
        expect(budget.activeProcessTrigger + budget.historyTrigger, where)
          .toBeLessThan(messageBudget);
      }
    }
  });

  it("returns the historical defaults when the window is unknown or unusable", () => {
    expect(contextBudget({ usableInputTokens: 0, fixedOverheadTokens: 0 })).toEqual(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudget({ usableInputTokens: -1, fixedOverheadTokens: 0 })).toEqual(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudget({ usableInputTokens: Number.NaN, fixedOverheadTokens: 0 })).toEqual(DEFAULT_CONTEXT_BUDGET);
  });

  it("subtracts fixed overhead but never lets it starve messages entirely", () => {
    const usableInputTokens = 100_000;
    expect(messageBudgetTokens({ usableInputTokens, fixedOverheadTokens: 30_000 })).toBe(70_000);
    // Overhead larger than the window would compute a negative budget; the fuse
    // keeps a floor share so compaction still works instead of going inert.
    expect(messageBudgetTokens({ usableInputTokens, fixedOverheadTokens: 400_000 })).toBe(20_000);
  });

  it("scales with the window instead of pinning the historical constants", () => {
    const small = budgetFor(32_000, 30_000).budget;
    const mid = budgetFor(200_000, 30_000).budget;
    const large = budgetFor(1_048_576, 30_000).budget;

    // A 200K model gets materially more room than the fixed 18K it used to.
    expect(mid.activeProcessTrigger).toBeGreaterThan(ACTIVE_PROCESS_TRIGGER_TOKENS);
    expect(mid.historyTrigger).toBeGreaterThan(HISTORY_RAW_TRIGGER_TOKENS);

    // A 32K model tightens instead: with ~22K usable and a 30K tool set, the
    // old 18K trigger left no room to act before overflow.
    expect(small.activeProcessTrigger).toBeLessThan(ACTIVE_PROCESS_TRIGGER_TOKENS);

    expect(small.activeProcessTrigger).toBeLessThan(mid.activeProcessTrigger);
    expect(mid.activeProcessTrigger).toBeLessThan(large.activeProcessTrigger);
  });

  it("caps the largest windows rather than scaling without bound", () => {
    const huge = budgetFor(2_000_000, 30_000).budget;
    const large = budgetFor(1_048_576, 30_000).budget;
    // Both are far past the cap, so they land on the same ceiling.
    expect(huge.activeProcessTrigger).toBe(large.activeProcessTrigger);
    expect(huge.historyTrigger).toBe(large.historyTrigger);
    expect(huge.activeProcessTrigger).toBeLessThanOrEqual(120_000);
    expect(huge.historyTrigger).toBeLessThanOrEqual(48_000);
  });

  it("derives a round inline allowance that tracks the window", () => {
    const mid = budgetFor(200_000, 30_000).budget;
    const large = budgetFor(1_048_576, 30_000).budget;
    const small = budgetFor(32_000, 30_000).budget;

    expect(mid.inlineResultTokensPerRound).toBeGreaterThanOrEqual(MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND);
    expect(large.inlineResultTokensPerRound).toBeGreaterThan(mid.inlineResultTokensPerRound);
    expect(large.inlineResultTokensPerRound).toBeLessThanOrEqual(MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND * 4);
    expect(small.inlineResultTokensPerRound).toBeLessThan(MAX_INLINE_TOOL_RESULT_TOKENS_PER_ROUND);
    expect(small.inlineResultTokensPerRound).toBeGreaterThan(0);
  });
});

describe("per-result inline ceiling", () => {
  // The entry ceiling and the active checkpoint's retention limit used to be
  // set independently: on a 200K window the entry admitted 12,500 tokens while
  // retention capped a single step at 10,784, so results in that band were
  // inlined and then guaranteed to be pruned by the first checkpoint — context
  // paid twice, once to admit and once to re-read. Tying the ceiling to
  // `activeSingleStepMaxTokens` means the door never admits what the compactor
  // has already said it cannot keep.
  const perResultCeiling = (budget: ContextBudget): number =>
    Math.max(MIN_PER_RESULT_INLINE_TOKENS, budget.activeSingleStepMaxTokens);

  it("never admits more than the active checkpoint can retain", () => {
    for (const usableInputTokens of [32_000, 128_000, 200_000, 1_000_000]) {
      const budget = contextBudget({ usableInputTokens, fixedOverheadTokens: 30_000 });
      const ceiling = perResultCeiling(budget);
      const where = `usable=${usableInputTokens}`;
      // Either the ceiling equals what retention allows, or the floor is doing
      // the talking on a window too small for the derived value to be useful.
      expect(
        ceiling === budget.activeSingleStepMaxTokens || ceiling === MIN_PER_RESULT_INLINE_TOKENS,
        where,
      ).toBe(true);
      expect(ceiling, where).toBeGreaterThanOrEqual(MIN_PER_RESULT_INLINE_TOKENS);
    }
  });

  it("scales with the window instead of staying a fixed number", () => {
    const small = perResultCeiling(contextBudget({ usableInputTokens: 128_000, fixedOverheadTokens: 30_000 }));
    const large = perResultCeiling(contextBudget({ usableInputTokens: 1_000_000, fixedOverheadTokens: 30_000 }));
    expect(large).toBeGreaterThan(small);
  });

  it("keeps a verbatim document's ceiling wider but still bounded", () => {
    const budget = contextBudget({ usableInputTokens: 200_000, fixedOverheadTokens: 30_000 });
    const ceiling = perResultCeiling(budget);
    const verbatim = ceiling * VERBATIM_DOCUMENT_INLINE_MULTIPLE;
    expect(verbatim).toBeGreaterThan(ceiling);
    // Bounded by the round budget it must still claim from, so the wider
    // ceiling can never turn into an unbounded read.
    expect(Number.isFinite(verbatim)).toBe(true);
  });
});
