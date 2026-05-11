import { describe, it, expect } from "vitest";
import { Session } from "../src/agent/session.js";

describe("Session", () => {
  it("starts empty", () => {
    const session = new Session();
    expect(session.length).toBe(0);
    expect(session.getMessages()).toEqual([]);
  });

  it("adds user messages", () => {
    const session = new Session();
    session.addUserMessage("Hello");

    expect(session.length).toBe(1);
    expect(session.getMessages()[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  it("adds assistant messages", () => {
    const session = new Session();
    session.addAssistantMessage([{ type: "text", text: "Hi there" }]);

    expect(session.length).toBe(1);
    expect(session.getMessages()[0].role).toBe("assistant");
  });

  it("adds tool results", () => {
    const session = new Session();
    session.addToolResult("tool-123", "result text", undefined, false);

    const msgs = session.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content[0]).toEqual({
      type: "tool_result",
      toolUseId: "tool-123",
      content: "result text",
      isError: false,
    });
  });

  it("appends image user message when addToolResult carries images", () => {
    const session = new Session();
    session.addToolResult("tool-img", "Image loaded.", [
      { data: "aGVsbG8=", mediaType: "image/jpeg" },
    ]);

    const msgs = session.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "tool-img" });
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content[0]).toEqual({ type: "image", data: "aGVsbG8=", mediaType: "image/jpeg" });
  });

  it("trims history to exactly maxHistoryTurns and keeps the newest turns", () => {
    const session = new Session({ maxHistoryTurns: 2 });
    for (let i = 0; i < 4; i++) {
      session.addUserMessage(`User message ${i}`);
      session.addAssistantMessage([{ type: "text", text: `Response ${i}` }]);
    }
    // 2 turns = 4 messages exactly
    expect(session.length).toBe(4);
    const msgs = session.getMessages();
    // Newest two turns (i=2, i=3) must survive; older ones must be dropped
    expect((msgs[0].content[0] as { text: string }).text).toBe("User message 2");
    expect((msgs[3].content[0] as { text: string }).text).toBe("Response 3");
  });

  it("compacts session with summary", () => {
    const session = new Session();

    // Add several messages
    for (let i = 0; i < 6; i++) {
      session.addUserMessage(`Message ${i}`);
      session.addAssistantMessage([{ type: "text", text: `Response ${i}` }]);
    }

    const beforeLength = session.length;
    session.compact("This is a summary of the conversation.");

    expect(session.length).toBeLessThan(beforeLength);
    // First message should contain the summary
    const msgs = session.getMessages();
    const firstText = msgs[0].content[0];
    expect(firstText.type).toBe("text");
    expect((firstText as { text: string }).text).toContain("summary");
  });

  // Pairing invariant — compact's slice(-keepCount) can land its head on a
  // tool_result-only user message whose tool_use is in the about-to-be-
  // discarded older slice. Without the leading-orphan drop in compact(),
  // the next provider call sends a function_call_output with no matching
  // function_call and OpenAI / Anthropic reject with
  // "No tool call found for function call output with call_id ...".
  // Reproduced as the user-reported bug at runner.ts:374 (mid-turn
  // compaction triggered by the 60% context guard) where post-compact
  // heal hadn't run yet.
  it("compact drops leading orphan tool_result whose tool_use was sliced off", () => {
    const session = new Session();
    // Build a 6-message history: text round + 2 tool rounds + final text.
    // Slice(-4) lands head on the tool_result for call-X whose tool_use is
    // at position 1 (about to be dropped).
    session.addUserMessage("kick off");                                          // 0
    session.addAssistantMessage([{ type: "tool_use", id: "call-X", name: "a", input: {} }]); // 1
    session.addToolResult("call-X", "ok-X", undefined, false);                   // 2
    session.addAssistantMessage([{ type: "tool_use", id: "call-Y", name: "b", input: {} }]); // 3
    session.addToolResult("call-Y", "ok-Y", undefined, false);                   // 4
    session.addAssistantMessage([{ type: "text", text: "done" }]);               // 5

    session.compact("summary");

    const msgs = session.getMessages();
    // Layout: [summary, understood, ...kept (orphan tool_result-X dropped)].
    // Expected kept = [3, 4, 5] = [tool_use(Y), tool_result(Y), text].
    expect(msgs).toHaveLength(5);
    expect(msgs[0].role).toBe("user");
    expect((msgs[0].content[0] as { text: string }).text).toContain("summary");
    expect(msgs[1].role).toBe("assistant");
    // The third message must NOT be the orphan tool_result for call-X.
    expect(msgs[2].role).toBe("assistant");
    expect((msgs[2].content[0] as { type: string }).type).toBe("tool_use");
    expect((msgs[2].content[0] as { id: string }).id).toBe("call-Y");
    // No tool_result for call-X anywhere — its tool_use was sliced away.
    const allContent = msgs.flatMap((m) => m.content);
    const orphanX = allContent.find(
      (c) => (c as { type?: string }).type === "tool_result"
        && (c as { toolUseId?: string }).toolUseId === "call-X",
    );
    expect(orphanX).toBeUndefined();
  });

  it("compact preserves tool_result whose tool_use IS within kept window", () => {
    const session = new Session();
    // Slice(-4) here lands on the tool_use itself, so the pair is intact.
    session.addUserMessage("kick off");                                          // 0
    session.addAssistantMessage([{ type: "text", text: "ack" }]);                // 1
    session.addAssistantMessage([{ type: "tool_use", id: "call-Z", name: "a", input: {} }]); // 2
    session.addToolResult("call-Z", "ok-Z", undefined, false);                   // 3
    session.addAssistantMessage([{ type: "text", text: "done" }]);               // 4

    session.compact("summary");

    const msgs = session.getMessages();
    // kept = [1, 2, 3, 4] — all four tail messages survive because none
    // of them is a tool_result-only user message at the head boundary.
    expect(msgs.length).toBe(6);
    // tool_use(Z) and its tool_result(Z) both present, in order.
    const flat = msgs.flatMap((m) => m.content);
    expect(flat.some((c) => (c as { type?: string }).type === "tool_use" && (c as { id?: string }).id === "call-Z")).toBe(true);
    expect(flat.some((c) => (c as { type?: string }).type === "tool_result" && (c as { toolUseId?: string }).toolUseId === "call-Z")).toBe(true);
  });

  it("clear removes all messages", () => {
    const session = new Session();
    session.addUserMessage("test");
    expect(session.length).toBe(1);

    session.clear();
    expect(session.length).toBe(0);
  });

  // estimateTokens: CJK-aware heuristic. Anchors the fix for the latent
  // under-estimation bug that let the runner's 80% compaction guard skip
  // pure-Chinese sessions even when they were well over budget.
  it("estimateTokens: ASCII follows the ~4 chars/token rule", () => {
    const session = new Session();
    session.addUserMessage("a".repeat(4000));
    // 4000 non-CJK / 4 = 1000
    expect(session.estimateTokens()).toBe(1000);
  });

  it("estimateTokens: CJK counts ~1.5 tokens per char, not 0.25", () => {
    const session = new Session();
    // 1000 Chinese chars — old impl returned ~250, real tokenizer gives ~1000-1500
    session.addUserMessage("中".repeat(1000));
    const est = session.estimateTokens();
    expect(est).toBeGreaterThanOrEqual(1400);
    expect(est).toBeLessThanOrEqual(1600);
  });

  it("estimateTokens: mixed CJK + ASCII sums both buckets", () => {
    const session = new Session();
    // 100 CJK + 400 ASCII → 100*1.5 + 400/4 = 150 + 100 = 250
    session.addUserMessage("中".repeat(100) + "a".repeat(400));
    expect(session.estimateTokens()).toBe(250);
  });
});
