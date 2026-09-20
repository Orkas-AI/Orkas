import { describe, expect, it } from "vitest";
import { LoopGuards } from "../src/agent/loop-guards.js";
import { ProgressEvidence } from "../src/agent/progress-evidence.js";
import { completedRepeatKey } from "../src/agent/repeat-evidence.js";
import type { ToolResult } from "../src/tools/base.js";

describe("repeat stop evidence", () => {
  it("a queued reminder has no termination authority until acknowledged; reset revokes it", () => {
    const guard = new LoopGuards();
    for (let round = 0; round < 10; round++) expect(guard.observeCompletedRound(["same"])).toBe(false);
    expect(guard.pendingCompletedRepeatNudge()).toBeTruthy();
    guard.acknowledgeCompletedRepeatNudge();
    expect(guard.observeCompletedRound(["same"])).toBe(false);
    expect(guard.observeCompletedRound(["same"])).toBe(true);
    guard.resetCompletedRepeats();
    expect(guard.pendingCompletedRepeatNudge()).toBeNull();
    expect(guard.observeCompletedRound(["same"])).toBe(false);
    expect(guard.completedRepeatDiagnostics().feedbackDelivered).toBe(false);
  });

  it.each([[], [undefined], ["same", undefined], Array(257).fill("same")].map(keys => ({ keys })))("inconclusive round breaks strong evidence: $keys", ({ keys }) => {
    const guard = new LoopGuards();
    for (let i = 0; i < 3; i++) guard.observeCompletedRound(["same"]);
    guard.acknowledgeCompletedRepeatNudge();
    expect(guard.observeCompletedRound(keys)).toBe(false);
    expect(guard.observeCompletedRound(["same"])).toBe(false);
    expect(guard.completedRepeatDiagnostics()).toEqual({ rounds: 1, afterFeedbackRounds: 0, feedbackDelivered: false });
  });

  it("only already-delivered exact source ranges qualify; context reset and new versions permit rereads", () => {
    const evidence = new ProgressEvidence();
    const call = { name: "read_files", input: { file: "reference" } };
    const result: ToolResult = { content: "facts", observations: { fileReads: [{ path: "/virtual/reference", hash: "v1", charRange: [0, 5] }] } };
    const key = () => completedRepeatKey(call, { result }, evidence.observe(call.name, { result }));
    expect(key()).toBeUndefined();
    const repeated = key();
    expect(repeated).toMatch(/^[a-f0-9]{64}$/);
    evidence.reset();
    expect(key()).toBeUndefined();
    expect(key()).toBe(repeated);
    result.observations!.fileReads![0].hash = "v2";
    expect(key()).toBeUndefined();
    expect(key()).not.toBe(repeated);
  });

  it.each(["unknown", "partial", "failed", "spilled", "image", "subprocess", "partial-batch", "oversized", "waiting", "racing"])(
    "cannot turn %s evidence into a stop", kind => {
      const call = { name: "custom", input: {} };
      const result: ToolResult = { content: "ok", observations: { fileChanges: [{
        operation: "update", sourcePath: "/virtual/file", beforeExists: true, afterExists: true,
        beforeHash: "v1", afterHash: "v1", coverage: "exact",
      }] } };
      if (kind === "unknown") result.observations = undefined;
      if (kind === "partial") result.observations!.fileChanges![0].coverage = "partial";
      if (kind === "failed") result.isError = true;
      if (kind === "spilled") result.persistedOutput = { path: "/virtual/result", ref: "opaque", size: 10 };
      if (kind === "image") result.images = [{ data: "opaque", mediaType: "image/png" }];
      if (kind === "subprocess") result.observations!.programExecution = {
        sourceKind: "inline", sourceSha256: "opaque", childCalls: { attempted: 1, succeeded: 1, failed: 0, failedTools: [] },
      };
      if (kind === "partial-batch") result.observations!.fileReadBatch = { attempted: 2, succeeded: 1, failed: 1, failures: [{ index: 1, code: "unavailable" }] };
      if (kind === "oversized") result.observations!.fileChanges![0].sourcePath = "x".repeat(40_000);
      const before = kind === "waiting" || kind === "racing" ? { waiting: kind === "waiting", version: "v1" } : undefined;
      const after = before ? { waiting: false, version: "v2" } : undefined;
      const evidence = new ProgressEvidence();
      const progress = evidence.observe(call.name, { result }, after, before);
      expect(completedRepeatKey(call, { result }, progress, before, after)).toBeUndefined();
    },
  );
});
