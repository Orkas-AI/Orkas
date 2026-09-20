import { describe, expect, it } from "vitest";
import { ProgressEvidence } from "../src/agent/progress-evidence.js";
import { LoopGuards, mergeToolRoundProgress, type ToolRoundProgress } from "../src/agent/loop-guards.js";
import type { FileChangeObservation, FileReadObservation, ToolResult } from "../src/tools/base.js";

const source = (overrides: Partial<FileReadObservation> = {}): FileReadObservation => ({
  path: "/workspace/source.ts", hash: "version-1", charRange: [0, 100], ...overrides,
});
const read = (tracker: ProgressEvidence, item = source()) => tracker.observe("read_files", {
  result: { content: "source excerpt", observations: { fileReads: [item] } },
});
const unchanged = (overrides: Partial<FileChangeObservation> = {}): FileChangeObservation => ({
  operation: "update", sourcePath: "/workspace/result", beforeExists: true, afterExists: true,
  beforeHash: "same", afterHash: "same", coverage: "exact", ...overrides,
});
const effect = (tracker: ProgressEvidence, change: FileChangeObservation) => tracker.observe("write_file", {
  result: { content: "saved", observations: { fileChanges: [change] } },
});

describe("progress evidence: information available to the executor", () => {
  it("distinguishes a new source, exact reread, partial overlap, and changed version", () => {
    const tracker = new ProgressEvidence();
    expect(read(tracker)).toBe("discovery");
    expect(read(tracker)).toBe("none");
    expect(read(tracker, source({ charRange: [50, 150] }))).toBe("discovery");
    expect(read(tracker, source({ charRange: [0, 150] }))).toBe("none");
    expect(read(tracker, source({ hash: "version-2" }))).toBe("discovery");
    expect(read(tracker, source({ path: "/workspace/other.ts" }))).toBe("discovery");
  });

  it("does not hide unread gaps between previously read ranges", () => {
    const tracker = new ProgressEvidence();
    read(tracker, source({ charRange: [0, 10] }));
    read(tracker, source({ charRange: [20, 30] }));
    expect(read(tracker, source({ charRange: [0, 30] }))).toBe("discovery");
    expect(read(tracker, source({ charRange: [10, 20] }))).toBe("none");
  });

  it("treats single-line reads as nonempty and incompatible units as unknown", () => {
    const tracker = new ProgressEvidence();
    expect(read(tracker, source({ charRange: undefined, lineRange: [1, 1] }))).toBe("discovery");
    expect(read(tracker, source({ charRange: undefined, lineRange: [1, 1] }))).toBe("none");
    expect(read(tracker)).toBe("unknown");
    expect(read(tracker)).toBe("none");
  });

  it.each([
    { hash: undefined }, { charRange: undefined }, { charRange: [-1, 5] },
    { charRange: [10, 5] }, { charRange: [0, 0] }, { charRange: [0, Infinity] },
    { charRange: [0, 1.5] }, { path: "" },
  ] as Partial<FileReadObservation>[])('missing or invalid read facts stay unknown: %j', (overrides) => {
    const tracker = new ProgressEvidence();
    expect(read(tracker, source(overrides))).toBe("unknown");
    expect(read(tracker, source(overrides))).toBe("unknown");
    expect(read(tracker)).toBe("discovery");
  });

  it("does not credit withheld source bytes as delivered information", () => {
    const tracker = new ProgressEvidence();
    expect(tracker.observe("read_files", { result: {
      content: "result stored", persistedOutput: { path: "private", ref: "ref", size: 1000 },
      observations: { fileReads: [source()] },
    } })).toBe("unknown");
    expect(read(tracker)).toBe("discovery");
  });

  it("allows rereading after context reduction and isolates fresh runs", () => {
    const tracker = new ProgressEvidence();
    read(tracker);
    expect(read(tracker)).toBe("none");
    tracker.reset();
    expect(read(tracker)).toBe("discovery");
    expect(read(new ProgressEvidence())).toBe("discovery");
  });

  it("bounds sources without falsely proving novelty after saturation", () => {
    const tracker = new ProgressEvidence();
    for (let i = 0; i < 512; i++) expect(read(tracker, source({ path: `source-${i}` }))).toBe("discovery");
    expect(read(tracker, source({ path: "source-512" }))).toBe("unknown");
    expect(read(tracker, source({ path: "source-0" }))).toBe("none");
    expect(read(tracker, source({ path: "x".repeat(9000) }))).toBe("unknown");
  });

  it("bounds fragmented coverage without claiming that an untracked range was delivered", () => {
    const tracker = new ProgressEvidence();
    for (let i = 0; i < 128; i++) read(tracker, source({ charRange: [i * 3, i * 3 + 1] }));
    expect(read(tracker, source({ charRange: [900, 901] }))).toBe("unknown");
    expect(read(tracker, source({ charRange: [900, 901] }))).toBe("unknown");
    expect(read(tracker, source({ charRange: [0, 1] }))).toBe("none");
  });
});

describe("progress evidence: effects, errors, and opaque executors", () => {
  it.each([
    ["identical write", {}, "none"],
    ["changed content", { afterHash: "changed" }, "productive"],
    ["empty file creation", { operation: "create", beforeExists: false, afterHash: "empty", afterBytes: 0 }, "productive"],
    ["deletion", { operation: "delete", afterExists: false }, "productive"],
    ["rename", { operation: "rename", destinationPath: "/workspace/renamed" }, "productive"],
    ["missing size/hash", { beforeHash: undefined, afterHash: undefined }, "unknown"],
    ["same nonzero size", { beforeHash: undefined, afterHash: undefined, beforeBytes: 10, afterBytes: 10 }, "unknown"],
    ["different sizes", { beforeHash: undefined, afterHash: undefined, beforeBytes: 10, afterBytes: 20 }, "productive"],
    ["empty unchanged file", { beforeHash: undefined, afterHash: undefined, beforeBytes: 0, afterBytes: 0 }, "none"],
    ["partial no-op snapshot", { coverage: "partial" }, "unknown"],
    ["partial changed snapshot", { coverage: "partial", afterHash: "changed" }, "productive"],
  ] as [string, Partial<FileChangeObservation>, ToolRoundProgress][])('%s', (_label, changes, expected) => {
    expect(effect(new ProgressEvidence(), unchanged(changes))).toBe(expected);
  });

  it.each(["bash", "web_search", "video_studio", "external_cli", "run_program"])(
    "%s success and failure prose cannot certify progress or lack of it", (name) => {
      const tracker = new ProgressEvidence();
      for (const isError of [false, true]) {
        for (let i = 0; i < 3; i++) {
          expect(tracker.observe(name, { result: { content: `Completed step ${i}; new diagnostic`, isError } })).toBe("unknown");
        }
      }
    },
  );

  it.each(["manage_execution_plan", "tool_load"])("successful %s is neutral, failed coordination is unknown", (name) => {
    const tracker = new ProgressEvidence();
    expect(tracker.observe(name, { result: { content: "done" } })).toBe("neutral");
    expect(tracker.observe(name, { result: { content: "unavailable", isError: true } })).toBe("unknown");
  });

  it("keeps real partial effects and new diagnostic reads even when the outer tool fails", () => {
    const tracker = new ProgressEvidence();
    expect(tracker.observe("diagnose", { result: {
      content: "failed but returned new diagnostic source", isError: true,
      observations: { fileReads: [source()] },
    } })).toBe("discovery");
    expect(tracker.observe("patch", { result: {
      content: "second edit failed", isError: true,
      observations: { fileChanges: [unchanged({ afterHash: "new" })] },
    } })).toBe("productive");
    expect(tracker.observe("patch", { result: {
      content: "failed with unknown diagnostics", isError: true,
      observations: { fileChanges: [unchanged()] },
    } })).toBe("unknown");
  });

  it("does not interpret command exit codes or program child counts as advancement", () => {
    const tracker = new ProgressEvidence();
    const result: ToolResult = { content: "done", observations: {
      execution: { status: "succeeded", exitCode: 0, durationMs: 1, timedOut: false, outputLimitExceeded: false,
        stdout: { bytes: 12, truncated: false }, stderr: { bytes: 0, truncated: false } },
    } };
    expect(tracker.observe("bash", { result })).toBe("unknown");
    for (const succeeded of [0, 1, 2]) {
      expect(tracker.observe("run_program", { result: { content: "batch done", observations: {
        fileReads: [source()],
        programExecution: { sourceKind: "file", sourceSha256: "source", childCalls: {
          attempted: 2, succeeded, failed: 2 - succeeded, failedTools: [],
        } },
      } } })).toBe("unknown");
    }
    expect(read(tracker)).toBe("discovery");
  });
});

describe("progress evidence: live waits and continuation receipts", () => {
  it("does not credit output that arrived after a read as if it had been delivered", () => {
    const tracker = new ProgressEvidence();
    const outcome = { result: { content: "older receipt" } };
    const old = { version: "old", waiting: false };
    const newer = { version: "new", waiting: false };
    expect(tracker.observe("process_session", outcome, newer, old)).toBe("unknown");
    expect(tracker.observe("process_session", outcome, newer, newer)).toBe("discovery");
    expect(tracker.observe("process_session", outcome, newer, { ...old, waiting: true })).toBe("neutral");
  });
  it("pauses on live waits, credits first/new receipts, and detects stale receipts", () => {
    const tracker = new ProgressEvidence();
    const outcome = { result: { content: "receipt" } };
    for (let i = 0; i < 10; i++) {
      expect(tracker.observe("process_session", outcome, { version: "live", waiting: true })).toBe("neutral");
    }
    expect(tracker.observe("process_session", outcome, { version: "chunk-1", waiting: false })).toBe("discovery");
    expect(tracker.observe("process_session", outcome, { version: "chunk-1", waiting: false })).toBe("none");
    expect(tracker.observe("process_session", outcome, { version: "terminal", waiting: false })).toBe("discovery");
    expect(tracker.observe("process_session", outcome, { version: "terminal", waiting: false })).toBe("none");
    expect(tracker.observe("process_session", { result: { content: "read failed", isError: true } },
      { version: "terminal", waiting: true })).toBe("unknown");
  });
});

describe("progress counters: the requester's skip and recovery rules", () => {
  const observe = (guard: LoopGuards, progress: ToolRoundProgress) => guard.observeRoundOutcome({ progress, freshEpisode: false });
  it("unknown and neutral rounds skip without increasing, clearing, or rearming a stalled episode", () => {
    const guard = new LoopGuards();
    observe(guard, "none");
    for (const progress of ["unknown", "neutral", "unknown"] as const) {
      expect(observe(guard, progress).nudge).toBeNull();
      expect(guard.consecutiveNoProgressRounds).toBe(1);
    }
    expect(observe(guard, "none").nudge?.kind).toBe("no_progress");
    observe(guard, "unknown");
    expect(observe(guard, "none").nudge).toBeNull();
  });

  it("unknown exploration cannot accumulate a progress advisory through the tool name", () => {
    const guard = new LoopGuards();
    observe(guard, "none");
    for (let i = 0; i < 20; i++) {
      expect(guard.observeRoundOutcome({ progress: "unknown", freshEpisode: false, discoveryOnly: true }))
        .toEqual({ nudge: null, stop: null });
    }
    expect(guard.consecutiveNoProgressRounds).toBe(1);
    expect(observe(guard, "none").nudge?.kind).toBe("no_progress");
  });

  it.each(["discovery", "productive"] as const)("%s resets and rearms the next episode", (progress) => {
    const guard = new LoopGuards();
    observe(guard, "none");
    observe(guard, "none");
    observe(guard, progress);
    expect(guard.consecutiveNoProgressRounds).toBe(0);
    expect(observe(guard, "none").nudge).toBeNull();
    expect(observe(guard, "none").nudge?.kind).toBe("no_progress");
  });

  it("new information can trigger exploration advice without declaring a stall", () => {
    const guard = new LoopGuards();
    for (let i = 0; i < 7; i++) expect(observe(guard, "discovery").nudge).toBeNull();
    expect(observe(guard, "discovery").nudge?.kind).toBe("discovery");
    expect(guard.consecutiveNoProgressRounds).toBe(0);
    for (let i = 0; i < 20; i++) expect(observe(guard, "discovery")).toEqual({ nudge: null, stop: null });
  });

  it("a new user direction clears both windows even if the last tool had no effect", () => {
    const guard = new LoopGuards();
    observe(guard, "none");
    expect(guard.observeRoundOutcome({ progress: "none", freshEpisode: true }).nudge).toBeNull();
    expect(guard.consecutiveNoProgressRounds).toBe(0);
    expect(observe(guard, "none").nudge).toBeNull();
  });

  it("mixed-result aggregation is order independent, and unknown siblings cannot prove a stalled round", () => {
    const states: ToolRoundProgress[] = ["neutral", "none", "unknown", "discovery", "productive"];
    for (const a of states) for (const b of states) {
      expect(mergeToolRoundProgress(a, b)).toBe(mergeToolRoundProgress(b, a));
      for (const c of states) expect(mergeToolRoundProgress(mergeToolRoundProgress(a, b), c))
        .toBe(mergeToolRoundProgress(a, mergeToolRoundProgress(b, c)));
    }
    expect(mergeToolRoundProgress("none", "unknown")).toBe("unknown");
    expect(mergeToolRoundProgress("none", "neutral")).toBe("none");
    expect(mergeToolRoundProgress("unknown", "discovery")).toBe("discovery");
    expect(mergeToolRoundProgress("unknown", "productive")).toBe("productive");
  });
});
