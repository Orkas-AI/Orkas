import { describe, it, expect } from "vitest";
import {
  shouldNudgeSpinConvergence,
  SPIN_CONVERGENCE_MIN_COMPACTIONS,
  SPIN_CONVERGENCE_TOOL_LOOP_RATIO,
} from "../src/agent/runner.js";

// The compound "spinning after context loss" signal must require BOTH repeated
// compaction AND heavy tool use — never either alone — and must not fire at/after
// the hard round limit (where the cap + near-limit nudge take over).
describe("shouldNudgeSpinConvergence", () => {
  it("pins the thresholds", () => {
    expect(SPIN_CONVERGENCE_MIN_COMPACTIONS).toBe(2);
    expect(SPIN_CONVERGENCE_TOOL_LOOP_RATIO).toBe(0.75);
  });

  it("fires only when both signals cross the threshold (max=80 → 0.75 ratio = 60 rounds)", () => {
    expect(shouldNudgeSpinConvergence(2, 60, 80)).toBe(true); // at both thresholds
    expect(shouldNudgeSpinConvergence(3, 72, 80)).toBe(true);
  });

  it("does not fire on tool loops alone (compaction below the minimum)", () => {
    expect(shouldNudgeSpinConvergence(1, 79, 80)).toBe(false);
    expect(shouldNudgeSpinConvergence(0, 80, 80)).toBe(false);
  });

  it("does not fire on compaction alone (tool loops below the ratio)", () => {
    expect(shouldNudgeSpinConvergence(2, 59, 80)).toBe(false); // one round short of 60
    expect(shouldNudgeSpinConvergence(5, 10, 80)).toBe(false);
  });

  it("stops firing at/after the hard round limit (cap + near-limit nudge own that zone)", () => {
    expect(shouldNudgeSpinConvergence(2, 80, 80)).toBe(false);
    expect(shouldNudgeSpinConvergence(4, 81, 80)).toBe(false);
  });

  it("scales the ratio with the actual budget (max=18 → 0.75 ratio = 13 rounds)", () => {
    expect(shouldNudgeSpinConvergence(2, 13, 18)).toBe(true);
    expect(shouldNudgeSpinConvergence(2, 12, 18)).toBe(false);
  });
});
