import { describe, it, expect } from "vitest";
import {
  anchoredRequestTokens,
  usageRequestFootprintTokens,
  type RequestTokenAnchor,
} from "../src/agent/request-token-anchor.js";
import { Session } from "../src/agent/session.js";

describe("usageRequestFootprintTokens", () => {
  it("sums prompt-side components plus output (pi-ai normalized fields)", () => {
    expect(usageRequestFootprintTokens({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 3_000,
      totalTokens: 54_200,
    })).toBe(54_200);
  });

  it("works without cache fields", () => {
    expect(usageRequestFootprintTokens({
      inputTokens: 700,
      outputTokens: 40,
      totalTokens: 740,
    })).toBe(740);
  });

  // A provider that reports no prompt accounting must not produce an anchor:
  // a zero base would price every later request as nearly free and disable
  // the very protections the anchor feeds.
  it("returns 0 when the prompt side is unreported", () => {
    expect(usageRequestFootprintTokens({ inputTokens: 0, outputTokens: 900, totalTokens: 900 })).toBe(0);
    expect(usageRequestFootprintTokens(undefined)).toBe(0);
  });
});

describe("anchoredRequestTokens", () => {
  const anchor: RequestTokenAnchor = {
    realTokens: 40_000,
    estimatedTokens: 90_000, // estimator over-weighed CJK 2.25x
    contentEpoch: 3,
  };

  it("applies the estimator only to the delta since the anchor", () => {
    // 5K tokens of new tool results by the estimator's own measure.
    const resolved = anchoredRequestTokens(anchor, 95_000, 3);
    expect(resolved).toEqual({ tokens: 45_000, source: "anchored" });
  });

  it("carries a shrinking delta too (ledger rewritten smaller)", () => {
    expect(anchoredRequestTokens(anchor, 89_000, 3).tokens).toBe(39_000);
  });

  it("falls back to the estimate after a content rewrite (epoch mismatch)", () => {
    const resolved = anchoredRequestTokens(anchor, 30_000, 4);
    expect(resolved).toEqual({ tokens: 30_000, source: "estimated" });
  });

  it("falls back without an anchor or with an empty one", () => {
    expect(anchoredRequestTokens(null, 12_345, 0)).toEqual({ tokens: 12_345, source: "estimated" });
    expect(anchoredRequestTokens({ realTokens: 0, estimatedTokens: 10, contentEpoch: 0 }, 12_345, 0).source)
      .toBe("estimated");
  });

  it("never goes negative", () => {
    expect(anchoredRequestTokens({ realTokens: 100, estimatedTokens: 50_000, contentEpoch: 1 }, 10, 1).tokens).toBe(0);
  });
});

describe("Session content epoch", () => {
  // The anchor differential prices growth; a rewrite changes content whose
  // real cost was already measured, so growth must NOT bump and rewrites MUST.
  it("does not change on append-only growth", () => {
    const session = new Session();
    const before = session.contentEpoch();
    session.beginUserTurn([{ type: "text", text: "hello" }]);
    session.addAssistantMessage([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "echo", input: { a: 1 } },
    ]);
    session.addToolResult("t1", "result body");
    expect(session.contentEpoch()).toBe(before);
  });

  it("bumps on checkpoint, history archive, turn completion, shrink and clear", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "q1" }]);
    session.addAssistantMessage([{ type: "text", text: "a1" }]);

    let epoch = session.contentEpoch();
    session.applyActiveCheckpointSummary("checkpoint", 1);
    expect(session.contentEpoch()).toBeGreaterThan(epoch);

    epoch = session.contentEpoch();
    session.completeActiveTurn();
    expect(session.contentEpoch()).toBeGreaterThan(epoch);

    epoch = session.contentEpoch();
    session.applyHistorySummary("history summary", [1]);
    expect(session.contentEpoch()).toBeGreaterThan(epoch);

    epoch = session.contentEpoch();
    session.applyPersistentBlockShrink("shrunk history summary");
    expect(session.contentEpoch()).toBeGreaterThan(epoch);

    epoch = session.contentEpoch();
    session.clear();
    expect(session.contentEpoch()).toBeGreaterThan(epoch);
  });

  it("bumps when canonical conversation history is replaced", () => {
    const session = new Session();
    const epoch = session.contentEpoch();
    session.replaceConversationHistory(
      [
        { role: "user", turnId: 1, content: [{ type: "text", text: "u1" }] },
        { role: "assistant", turnId: 1, content: [{ type: "text", text: "a1" }] },
      ],
      "group-main-v1:test",
    );
    expect(session.contentEpoch()).toBeGreaterThan(epoch);
  });
});
