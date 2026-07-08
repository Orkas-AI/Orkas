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

  it("keeps pending images in the model view until the assistant has seen them", () => {
    const session = new Session();
    session.addMessage("user", [
      { type: "text", text: "please inspect this image" },
      { type: "image", data: "pending-image", mediaType: "image/png" },
    ]);

    expect(session.getMessagesForModel()[0].content).toEqual([
      { type: "text", text: "please inspect this image" },
      { type: "image", data: "pending-image", mediaType: "image/png" },
    ]);

    session.addAssistantMessage([{ type: "text", text: "I inspected it." }]);

    expect(session.getMessages()[0].content).toHaveLength(2);
    expect(session.getMessagesForModel()[0].content).toEqual([
      { type: "text", text: "please inspect this image" },
    ]);
  });

  it("drops old read_file image trailers from later model calls while keeping the file reference", () => {
    const session = new Session();
    session.addAssistantMessage([{ type: "tool_use", id: "call-read", name: "read_file", input: { path: "/tmp/frame.png" } }]);
    session.addToolResult("call-read", '<file path="/tmp/frame.png" kind="image"/> Image loaded.', [
      { data: "frame-bytes", mediaType: "image/jpeg" },
    ]);

    let modelMessages = session.getMessagesForModel();
    expect(modelMessages).toHaveLength(3);
    expect(modelMessages[2].content[0]).toEqual({ type: "image", data: "frame-bytes", mediaType: "image/jpeg" });

    session.addAssistantMessage([{ type: "tool_use", id: "call-next", name: "bash", input: { command: "echo ok" } }]);
    modelMessages = session.getMessagesForModel();

    expect(session.getMessages()).toHaveLength(4);
    expect(session.getMessages()[2].content[0]).toEqual({ type: "image", data: "frame-bytes", mediaType: "image/jpeg" });
    expect(modelMessages).toHaveLength(3);
    expect(modelMessages.flatMap((m) => m.content).some((c) => c.type === "image")).toBe(false);
    expect(modelMessages[1].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-read",
      content: expect.stringContaining("/tmp/frame.png"),
    });
  });

  it("keeps old large tool results verbatim in model and summary views", () => {
    const session = new Session();
    const raw = "0123456789" + "x".repeat(2_000) + "TAIL!";

    session.addAssistantMessage([{ type: "tool_use", id: "call-old", name: "bash", input: { command: "big" } }]);
    session.addToolResult("call-old", raw, undefined, false);
    session.addAssistantMessage([{ type: "text", text: "I saw the output." }]);

    const modelResult = session.getMessagesForModel()[1].content[0];
    expect(modelResult.type).toBe("tool_result");
    expect((modelResult as { content: string }).content).toBe(raw);
    expect((modelResult as { content: string }).content).not.toContain("<compacted-tool-result");

    const summaryResult = session.getMessagesForSummary()[1].content[0];
    expect(summaryResult.type).toBe("tool_result");
    expect((summaryResult as { content: string }).content).toBe(raw);
  });

  it("keeps old tool_use inputs verbatim in model and summary views", () => {
    const session = new Session();
    const fileContent = "START-" + "x".repeat(900) + "-END";
    const command = "printf " + "y".repeat(900);

    session.addAssistantMessage([{ type: "tool_use", id: "call-write", name: "write_file", input: { path: "/tmp/a.txt", content: fileContent } }]);
    session.addToolResult("call-write", "ok", undefined, false);
    session.addAssistantMessage([{ type: "tool_use", id: "call-bash", name: "bash", input: { command } }]);
    session.addToolResult("call-bash", "ok", undefined, false);
    session.addAssistantMessage([{ type: "text", text: "seen" }]);

    const toolUses = session.getMessagesForModel()
      .flatMap((m) => m.content)
      .filter((c) => c.type === "tool_use") as Array<{ input: Record<string, unknown> }>;

    expect(toolUses).toHaveLength(2);
    expect(toolUses[0].input).toEqual({ path: "/tmp/a.txt", content: fileContent });
    expect(toolUses[1].input).toEqual({ command });

    const summaryToolUses = session.getMessagesForSummary()
      .flatMap((m) => m.content)
      .filter((c) => c.type === "tool_use") as Array<{ input: Record<string, unknown> }>;
    expect(summaryToolUses[0].input).toEqual({ path: "/tmp/a.txt", content: fileContent });
    expect(summaryToolUses[1].input).toEqual({ command });

    const serialized = JSON.stringify(summaryToolUses.map((u) => u.input));
    expect(serialized).not.toContain("__orkas_compacted_tool_use");
    expect(serialized).not.toContain("old tool input string compacted");
  });

  it("estimateModelTokens uses the provider view without tool result compaction", () => {
    const session = new Session();
    session.addAssistantMessage([{ type: "tool_use", id: "call-big", name: "bash", input: {} }]);
    session.addToolResult("call-big", "a".repeat(20_000), undefined, false);
    session.addAssistantMessage([{ type: "text", text: "seen" }]);

    expect(session.estimateTokens()).toBeGreaterThan(4_000);
    expect(session.estimateModelTokens()).toBeGreaterThan(4_000);
  });

  it("tracked completed history keeps only user input and final assistant output in the model view", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "First task" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "call-old", name: "bash", input: { command: "echo secret process" } }]);
    session.addToolResult("call-old", "secret process output", undefined, false);
    session.addAssistantMessage([{ type: "text", text: "First final answer" }]);
    session.completeActiveTurn();

    session.beginUserTurn([{ type: "text", text: "Second task" }]);
    const view = session.getMessagesForModel();
    const flat = view.flatMap((m) => m.content);

    expect(view.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(flat.some((c) => c.type === "tool_use")).toBe(false);
    expect(flat.some((c) => c.type === "tool_result")).toBe(false);
    expect(JSON.stringify(view)).toContain("First task");
    expect(JSON.stringify(view)).toContain("First final answer");
    expect(JSON.stringify(view)).toContain("Second task");
  });

  it("history archive candidate triggers at 15 turns and retains the newest two raw turns", () => {
    const session = new Session();
    for (let i = 0; i < 15; i++) {
      session.beginUserTurn([{ type: "text", text: `User ${i}` }]);
      session.addAssistantMessage([{ type: "text", text: `Answer ${i}` }]);
      session.completeActiveTurn();
    }

    const candidate = session.getPendingHistoryArchive();
    expect(candidate).toBeTruthy();
    expect(candidate?.turnIds).toHaveLength(13);
    session.applyHistorySummary("Summary through turn 12", candidate!.turnIds);

    session.beginUserTurn([{ type: "text", text: "Fresh task" }]);
    const serialized = JSON.stringify(session.getMessagesForModel());
    expect(serialized).toContain("Older completed conversation turns have been summarized and omitted");
    expect(serialized).toContain("re-read the relevant path/range with tools");
    expect(serialized).toContain("Summary through turn 12");
    expect(serialized).not.toContain("User 0");
    expect(serialized).not.toContain("Answer 0");
    expect(serialized).toContain("User 13");
    expect(serialized).toContain("Answer 13");
    expect(serialized).toContain("User 14");
    expect(serialized).toContain("Answer 14");
    expect(serialized).toContain("Fresh task");
  });

  it("active checkpoint candidate archives older complete tool step groups and keeps the recent tail", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current large task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: `cmd-${i}` } }]);
      session.addToolResult(`call-${i}`, `result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }

    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).toBeTruthy();
    expect(candidate?.groups).toHaveLength(3);
    session.applyActiveCheckpointSummary("Older tool work summarized", candidate!.checkpointThroughMessageIndex);

    const view = session.getMessagesForModel();
    const serialized = JSON.stringify(view);
    expect(serialized).toContain("Earlier tool calls/results in this same user turn have been summarized");
    expect(serialized).toContain("Do not re-read files, logs, screenshots, or skill documents merely to regain omitted context");
    expect(serialized).toContain("prefer narrow ranges, grep/search/stat, or the existing artifact path over full-file reads");
    expect(serialized).toContain("Older tool work summarized");
    expect(serialized).not.toContain("call-0");
    expect(serialized).not.toContain("result-0");
    expect(serialized).toContain("call-3");
    expect(serialized).toContain("result-3");
    expect(serialized).toContain("call-4");
    expect(serialized).toContain("result-4");
  });

  it("starting a new turn closes a prior interrupted active turn instead of dropping it", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Interrupted task" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "call-open", name: "bash", input: { command: "sleep" } }]);

    session.beginUserTurn([{ type: "text", text: "Next task" }]);
    const serialized = JSON.stringify(session.getMessagesForModel());

    expect(serialized).toContain("Interrupted task");
    expect(serialized).toContain("Previous run ended before a normal final response.");
    expect(serialized).toContain("Next task");
    expect(serialized).not.toContain("call-open");
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

  it("trims at a provider-safe boundary when the cut lands on a tool_result", () => {
    const session = new Session({ maxHistoryTurns: 2 });
    session.addUserMessage("start");
    session.addAssistantMessage([{ type: "tool_use", id: "call-old", name: "bash", input: {} }]);
    session.addToolResult("call-old", "ok", undefined, false);
    session.addAssistantMessage([{ type: "text", text: "tool done" }]);
    session.addUserMessage("next");
    session.addAssistantMessage([{ type: "text", text: "next response" }]);

    const msgs = session.getMessages();
    expect(msgs[0].content[0].type).not.toBe("tool_result");
    expect(msgs.flatMap((m) => m.content).some(
      (c) => c.type === "tool_result" && c.toolUseId === "call-old",
    )).toBe(false);
    expect((msgs.at(-1)?.content[0] as { text: string }).text).toBe("next response");
  });

  it("defaults to keeping the newest 50 internal turns", () => {
    const session = new Session();
    for (let i = 0; i < 55; i++) {
      session.addUserMessage(`User message ${i}`);
      session.addAssistantMessage([{ type: "text", text: `Response ${i}` }]);
    }

    expect(session.length).toBe(100);
    const msgs = session.getMessages();
    expect((msgs[0].content[0] as { text: string }).text).toBe("User message 5");
    expect((msgs[99].content[0] as { text: string }).text).toBe("Response 54");
  });

  it("does not let the legacy trim wipe the active turn on a long tool-heavy turn", () => {
    // Regression: message-count trim (maxHistoryTurns) is independent of the
    // turn-based context policy. A single active turn with many tool loops can
    // exceed the message cap; the old trim dropped the active turn's start,
    // shiftTurnMetadata cleared activeTurn, and getMessagesForModel then
    // returned an EMPTY array — the model saw no history at all mid-run.
    const session = new Session({ maxHistoryTurns: 5 }); // trims past 10 messages
    session.beginUserTurn([{ type: "text", text: "TASK: build the whole thing" }]);
    for (let i = 0; i < 40; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `t${i}`, name: "read_file", input: { path: `/f${i}` } }]);
      session.addToolResult(`t${i}`, `result ${i}`);
    }
    const view = session.getMessagesForModel();
    expect(view.length).toBeGreaterThan(0);
    const hasTask = view.some(
      (m) => m.role === "user" && m.content.some((c) => c.type === "text" && (c as { text: string }).text.includes("TASK: build the whole thing")),
    );
    expect(hasTask).toBe(true);
  });

  it("rebuilds a restored active turn when a terminal assistant answer was followed by a new user turn", () => {
    const session = new Session();
    session.addMessage("user", [{ type: "text", text: "do the task" }]);
    session.addMessage("assistant", [{ type: "tool_use", id: "c1", name: "noop", input: {} }]);
    session.addMessage("user", [{ type: "tool_result", toolUseId: "c1", content: "ok", isError: false }]);
    session.addMessage("assistant", [{ type: "text", text: "first final" }]);
    session.addMessage("user", [{ type: "text", text: "new requirement" }]);

    const rebuilt = session.restoreContextState({
      version: 1,
      nextTurnId: 2,
      completedTurns: [],
      activeTurn: { id: 1, userMessageIndex: 0, startIndex: 0 },
      resources: [],
    });

    expect(rebuilt).toBe(true);
    const context = session.getSerializedContextState();
    expect(context?.completedTurns).toHaveLength(1);
    expect(context?.completedTurns[0]).toMatchObject({
      id: 1,
      userMessageIndex: 0,
      finalAssistantMessageIndex: 3,
      startIndex: 0,
      endIndex: 3,
    });
    expect(context?.activeTurn).toMatchObject({
      id: 2,
      userMessageIndex: 4,
      startIndex: 4,
    });
  });

  it("keeps a restored active turn when steer happens before a terminal answer", () => {
    const session = new Session();
    session.addMessage("user", [{ type: "text", text: "do the task" }]);
    session.addMessage("assistant", [{ type: "tool_use", id: "c1", name: "noop", input: {} }]);
    session.addMessage("user", [{ type: "tool_result", toolUseId: "c1", content: "ok", isError: false }]);
    session.addMessage("user", [{ type: "text", text: "adjust the plan" }]);

    const rebuilt = session.restoreContextState({
      version: 1,
      nextTurnId: 2,
      completedTurns: [],
      activeTurn: { id: 1, userMessageIndex: 0, startIndex: 0 },
      resources: [],
    });

    expect(rebuilt).toBe(false);
    const context = session.getSerializedContextState();
    expect(context?.completedTurns).toHaveLength(0);
    expect(context?.activeTurn).toMatchObject({
      id: 1,
      userMessageIndex: 0,
      startIndex: 0,
    });
  });

  it("does not drop completed turns still awaiting rolling-summary archival", () => {
    // The trim must not silently lose a completed turn's raw I/O before the
    // history summary has folded it in — those unarchived turns are the model
    // view's raw buffer.
    const session = new Session({ maxHistoryTurns: 3 }); // trims past 6 messages
    for (let i = 0; i < 8; i++) {
      session.beginUserTurn([{ type: "text", text: `Q${i}` }]);
      session.addAssistantMessage([{ type: "text", text: `A${i}` }]);
      session.completeActiveTurn();
    }
    const view = session.getMessagesForModel();
    for (let i = 0; i < 8; i++) {
      expect(view.some((m) => m.role === "user" && m.content.some((c) => (c as { text?: string }).text === `Q${i}`))).toBe(true);
      expect(view.some((m) => m.role === "assistant" && m.content.some((c) => (c as { text?: string }).text === `A${i}`))).toBe(true);
    }
  });

  it("still trims archived turns (no unbounded in-memory growth once summarized)", () => {
    // Once a completed turn is archived into the rolling summary, its raw
    // messages are no longer model-facing and remain eligible for the trim.
    const session = new Session({ maxHistoryTurns: 2 });
    const archived: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = session.beginUserTurn([{ type: "text", text: `Q${i}` }]);
      session.addAssistantMessage([{ type: "text", text: `A${i}` }]);
      session.completeActiveTurn();
      archived.push(id);
    }
    // Archive the four oldest turns into the summary.
    session.applyHistorySummary("summary of Q0..Q3", archived.slice(0, 4));
    // Adding another turn triggers trimHistory; archived turns' raw messages
    // are now droppable, so in-memory length is bounded well below 12.
    session.beginUserTurn([{ type: "text", text: "Q6" }]);
    session.addAssistantMessage([{ type: "text", text: "A6" }]);
    session.completeActiveTurn();
    expect(session.length).toBeLessThan(12);
    // The summary + the newest (non-archived) turns still project to the model.
    const view = session.getMessagesForModel();
    expect(view.some((m) => m.content.some((c) => (c as { text?: string }).text?.includes("summary of Q0..Q3")))).toBe(true);
    expect(view.some((m) => m.content.some((c) => (c as { text?: string }).text === "Q6"))).toBe(true);
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
  // compaction triggered by the 80% context guard) where post-compact
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

  // estimateKeptTailTokens powers the runner's "skip a no-progress compaction"
  // guard: it must report the tokens of exactly the tail compact() preserves.
  it("estimateKeptTailTokens counts only the tail compact() would keep", () => {
    const session = new Session();
    for (let i = 0; i < 8; i++) {
      session.addUserMessage(`older message number ${i} with several words`);
      session.addAssistantMessage([{ type: "text", text: `older response ${i}` }]);
    }
    const tail = session.estimateKeptTailTokens();
    const all = session.estimateTokens();
    // The kept tail is at most the last 4 messages — a strict subset of 16.
    expect(tail).toBeGreaterThan(0);
    expect(tail).toBeLessThan(all);
  });

  it("estimateKeptTailTokens ~= total when a huge result dominates the kept tail", () => {
    const session = new Session();
    session.addUserMessage("kick off");                                              // 0 (older)
    session.addAssistantMessage([{ type: "text", text: "starting" }]);               // 1
    session.addAssistantMessage([{ type: "tool_use", id: "call-read", name: "read_file", input: { path: "big.txt" } }]); // 2
    session.addToolResult("call-read", "x".repeat(400_000), undefined, false);       // 3 (huge, cap-exempt)
    session.addAssistantMessage([{ type: "text", text: "read it" }]);                // 4

    const tail = session.estimateKeptTailTokens();
    const all = session.estimateTokens();
    // The huge read_file result sits in the kept tail (last 4), so a compaction
    // would free almost nothing (only message 0). The runner's guard reads this
    // as "no progress" and skips the wasteful summary pass.
    expect(all - tail).toBeLessThan(all * 0.05);
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
