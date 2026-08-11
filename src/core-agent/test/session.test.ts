import { describe, it, expect } from "vitest";
import {
  Session,
  ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING,
  ACTIVE_CHECKPOINT_BODY_MAX_CHARS,
  ACTIVE_CHECKPOINT_META_MAX_CHARS,
  ACTIVE_PROCESS_TRIGGER_TOKENS,
  ACTIVE_RETAIN_TOKEN_BUDGET,
  ARCHIVED_TOOL_RESULT_MARKER,
  COMPLETED_WORK_MAX_ENTRIES,
  COMPLETED_WORK_MODEL_MAX_CHARS,
  COMPLETED_WORK_MODEL_MAX_ENTRIES,
  EXECUTION_PLAN_AUDIT_MAX_ENTRIES,
  HISTORY_EXACT_FACTS_HEADING,
  HISTORY_EXACT_FACTS_MAX_ITEMS,
  HISTORY_RAW_RETAIN_TOKEN_BUDGET,
  DEFAULT_CONTEXT_BUDGET,
  contextBudget,
} from "../src/agent/session.js";

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
      { data: "aGVsbG8=", mediaType: "image/jpeg", analysisMode: "quality_review" },
    ]);

    const msgs = session.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "tool-img" });
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content[0]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mediaType: "image/jpeg",
      analysisMode: "quality_review",
    });
  });

  it("shows ordered desktop/mobile preview images for exactly the next model call", () => {
    const session = new Session();
    session.beginUserTurn([{
      type: "text",
      text: "Build a responsive poster and verify it visually.",
    }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-preview",
      name: "html_preview",
      input: { path: "poster.html" },
    }]);
    session.addToolResult(
      "call-preview",
      JSON.stringify({
        ok: false,
        blockers: ["mobile: horizontal overflow is 28px"],
        viewports: [{ name: "desktop" }, { name: "mobile" }],
      }),
      [
        { data: "desktop-preview", mediaType: "image/png" },
        { data: "mobile-preview", mediaType: "image/png" },
      ],
      true,
    );

    let modelMessages = session.getMessagesForModel();
    expect(modelMessages[2].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-preview",
      isError: true,
      content: expect.stringContaining("horizontal overflow"),
    });
    expect(modelMessages[3].content).toEqual([
      { type: "image", data: "desktop-preview", mediaType: "image/png" },
      { type: "image", data: "mobile-preview", mediaType: "image/png" },
    ]);

    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-fix",
      name: "edit_file",
      input: { path: "poster.html" },
    }]);
    modelMessages = session.getMessagesForModel();

    expect(modelMessages.flatMap((message) => message.content))
      .not.toContainEqual(expect.objectContaining({ type: "image" }));
    expect(modelMessages.flatMap((message) => message.content))
      .toContainEqual(expect.objectContaining({
        type: "tool_result",
        toolUseId: "call-preview",
        isError: true,
      }));
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

  it("history archive candidate triggers by structured size and retains the newest two raw turns", () => {
    const session = new Session();
    for (let i = 0; i < 15; i++) {
      session.beginUserTurn([{ type: "text", text: `User ${i} ${"large ".repeat(400)}` }]);
      session.addAssistantMessage([{ type: "text", text: `Answer ${i} ${"body ".repeat(400)}` }]);
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

  it("does not use completed-turn count as a history compaction trigger", () => {
    const session = new Session();
    for (let i = 0; i < 50; i++) {
      session.beginUserTurn([{ type: "text", text: `User ${i}` }]);
      session.addAssistantMessage([{ type: "text", text: `Answer ${i}` }]);
      session.completeActiveTurn();
    }

    expect(session.getPendingHistoryArchive()).toBeNull();
  });

  it("includes the existing rolling summary in the 12K history high-water mark", () => {
    const session = new Session();
    for (let i = 0; i < 15; i++) {
      session.beginUserTurn([{ type: "text", text: `Seed ${i} ${"large ".repeat(400)}` }]);
      session.addAssistantMessage([{ type: "text", text: `Seed answer ${i} ${"body ".repeat(400)}` }]);
      session.completeActiveTurn();
    }
    const initial = session.getPendingHistoryArchive()!;
    session.applyHistorySummary("s".repeat(8_000), initial.turnIds);

    let next = session.getPendingHistoryArchive();
    for (let i = 0; !next && i < 30; i++) {
      session.beginUserTurn([{ type: "text", text: `New ${i} ${"request ".repeat(200)}` }]);
      session.addAssistantMessage([{ type: "text", text: `New answer ${i} ${"response ".repeat(200)}` }]);
      session.completeActiveTurn();
      next = session.getPendingHistoryArchive();
    }

    expect(next).toBeTruthy();
    expect(next!.summaryTokens).toBeGreaterThan(0);
    expect(next!.rawTokens).toBeLessThan(12_000);
    expect(next!.rawTokens + next!.summaryTokens).toBeGreaterThanOrEqual(12_000);
  });

  it("previews a history summary without mutating turn state", () => {
    const session = new Session();
    for (let i = 0; i < 15; i++) {
      session.beginUserTurn([{ type: "text", text: `User ${i} ${"large ".repeat(400)}` }]);
      session.addAssistantMessage([{ type: "text", text: `Answer ${i} ${"body ".repeat(400)}` }]);
      session.completeActiveTurn();
    }
    const candidate = session.getPendingHistoryArchive()!;
    const before = JSON.stringify(session.getSerializedContextState());
    const projected = session.previewHistorySummaryTokens("Projected summary", candidate.turnIds);

    expect(projected).toBeLessThan(session.estimateModelTokens());
    expect(JSON.stringify(session.getSerializedContextState())).toBe(before);
    expect(session.getPendingHistoryArchive()?.turnIds).toEqual(candidate.turnIds);
  });

  it("builds shared history input from canonical turns without private session context", () => {
    const session = new Session();
    for (let i = 0; i < 3; i++) {
      session.beginUserTurn([{ type: "text", text: `Canonical user ${i}` }]);
      session.addAssistantMessage([{ type: "text", text: `Canonical answer ${i}` }]);
      session.completeActiveTurn();
    }
    session.applyHistorySummary(
      `PRIVATE_SESSION_SUMMARY\n\n${HISTORY_EXACT_FACTS_HEADING}\n- private_nonce=secret`,
      [1],
      "canonical-message-1",
    );
    session.addHistoryResource({
      kind: "final_output",
      path: "/private/agent/output.txt",
      name: "PRIVATE_RESOURCE",
    });

    const input = JSON.stringify(session.buildSharedHistoryArchiveMessages(0, 2));
    expect(input).toContain("Canonical user 0");
    expect(input).toContain("Canonical answer 1");
    expect(input).not.toContain("PRIVATE_SESSION_SUMMARY");
    expect(input).not.toContain("private_nonce=secret");
    expect(input).not.toContain("PRIVATE_RESOURCE");

    session.applyHistorySummary("Shared canonical summary", [1, 2], "canonical-message-2");
    const state = session.getSerializedContextState()!;
    expect(state.summaryThroughTurnId).toBe(2);
    expect(state.summaryThroughMessageId).toBe("canonical-message-2");

    const restored = new Session();
    restored.restoreContextState(state);
    expect(restored.getSerializedContextState()?.summaryThroughMessageId)
      .toBe("canonical-message-2");
  });

  it("accumulates exact history facts outside probabilistic rolling summaries", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Remember the deployment facts" }]);
    session.addAssistantMessage([{ type: "text", text: "Recorded." }]);
    session.completeActiveTurn();

    session.applyHistorySummary(
      `First semantic summary\n\n${HISTORY_EXACT_FACTS_HEADING}\n- release_id=rel-123`,
      [1],
    );
    session.applyHistorySummary(
      `Replacement semantic summary\n\n${HISTORY_EXACT_FACTS_HEADING}\n- checksum=sha256:abc`,
      [1],
    );

    const state = session.getSerializedContextState()!;
    expect(state.historySummary).toBe("Replacement semantic summary");
    expect(state.historyExactFacts).toEqual([
      "release_id=rel-123",
      "checksum=sha256:abc",
    ]);

    const restored = new Session();
    restored.restoreContextState(state);
    restored.beginUserTurn([{ type: "text", text: "What next?" }]);
    const view = JSON.stringify(restored.getMessagesForModel());
    expect(view).toContain("History retained facts");
    expect(view).toContain("Private runtime context for task continuation only.");
    expect(view).toContain("release_id=rel-123");
    expect(view).toContain("checksum=sha256:abc");
  });

  it("replaces stale keyed exact facts while retaining cumulative audit facts", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Run narrated production" }]);
    session.applyActiveCheckpointSummary(
      `Initial\n\n${ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING}\n- text_sha256=old-hash\n- provider charged request req-1`,
      0,
    );
    session.applyActiveCheckpointSummary(
      `Revised\n\n${ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING}\n- text_sha256=new-hash\n- provider charged request req-2`,
      0,
    );

    const activeView = JSON.stringify(session.getMessagesForModel());
    expect(activeView).not.toContain("text_sha256=old-hash");
    expect(activeView).toContain("text_sha256=new-hash");
    expect(activeView).toContain("provider charged request req-1");
    expect(activeView).toContain("provider charged request req-2");

    session.addAssistantMessage([{ type: "text", text: "Paused." }]);
    session.completeActiveTurn();
    session.applyHistorySummary(
      `First\n\n${HISTORY_EXACT_FACTS_HEADING}\n- text_sha256=history-old`,
      [1],
    );
    session.applyHistorySummary(
      `Second\n\n${HISTORY_EXACT_FACTS_HEADING}\n- text_sha256=history-new`,
      [1],
    );

    expect(session.getSerializedContextState()!.historyExactFacts).toEqual([
      "provider charged request req-1",
      "provider charged request req-2",
      "text_sha256=history-new",
    ]);
  });

  it("retains the newest facts when the bounded history ledger is full", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Remember a bounded fact set" }]);
    session.addAssistantMessage([{ type: "text", text: "Recorded." }]);
    session.completeActiveTurn();
    const state = session.getSerializedContextState()!;
    state.historyExactFacts = Array.from(
      { length: HISTORY_EXACT_FACTS_MAX_ITEMS },
      (_, index) => `fact-${index}`,
    );
    session.restoreContextState(state);

    session.applyHistorySummary(
      `Updated summary\n\n${HISTORY_EXACT_FACTS_HEADING}\n- newest-fact`,
      [1],
    );

    const facts = session.getSerializedContextState()!.historyExactFacts!;
    expect(facts).toHaveLength(HISTORY_EXACT_FACTS_MAX_ITEMS);
    expect(facts).not.toContain("fact-0");
    expect(facts.at(-1)).toBe("newest-fact");
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("host-persisted model extraction");
    expect(view).not.toContain("deterministic host state, not a summary");
  });

  it("migrates an older sidecar whose history exact facts were embedded in summary prose", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "seed" }]);
    const state = session.getSerializedContextState()!;
    state.historySummary =
      `Legacy semantic summary\n\n${HISTORY_EXACT_FACTS_HEADING}\n- legacy_id=legacy-456`;
    delete state.historyExactFacts;

    const restored = new Session();
    restored.beginUserTurn([{ type: "text", text: "placeholder" }]);
    restored.restoreContextState(state);
    const migrated = restored.getSerializedContextState()!;
    expect(migrated.historySummary).toBe("Legacy semantic summary");
    expect(migrated.historyExactFacts).toEqual(["legacy_id=legacy-456"]);
  });

  it("promotes active-checkpoint exact facts into cross-turn host state", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Run the build" }]);
    session.applyActiveCheckpointSummary(
      `Build observation\n\n${ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING}\n- build_id=build-789`,
      0,
    );
    session.addAssistantMessage([{ type: "text", text: "Build complete." }]);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: "text", text: "Continue" }]);

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("History retained facts");
    expect(view).toContain("build_id=build-789");
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
    expect(serialized).toContain("Never quote, summarize, acknowledge, or mention this block");
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

  it("preserves a mid-turn interrupt steer that an active checkpoint archives past", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Render the explainer video" }]);
    // Three tool-step groups, then the user steers mid-run, then three more.
    for (let i = 0; i < 3; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `pre-${i}`, name: "bash", input: { command: `pre-${i}` } }]);
      session.addToolResult(`pre-${i}`, `pre-result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }
    session.addMessage("user", [{ type: "text", text: "STEER: switch the output to 720p" }]);
    for (let i = 0; i < 3; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `post-${i}`, name: "bash", input: { command: `post-${i}` } }]);
      session.addToolResult(`post-${i}`, `post-result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }

    // Checkpoint retains the newest two groups and archives the rest — including
    // a group AFTER the steer, so checkpointThroughMessageIndex covers the steer.
    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).toBeTruthy();
    expect(candidate!.checkpointThroughMessageIndex).toBeGreaterThan(0);
    session.applyActiveCheckpointSummary("Earlier render steps summarized", candidate!.checkpointThroughMessageIndex);

    const serialized = JSON.stringify(session.getMessagesForModel());
    // The steer survives verbatim (the bug dropped it entirely).
    expect(serialized).toContain("STEER: switch the output to 720p");
    // Sanity: the checkpoint really did archive a group past the steer.
    expect(serialized).not.toContain("pre-result-0");
    // Recent tail is still raw.
    expect(serialized).toContain("post-result-2");
    // The steer must remain the latest user directive, not a stale echo.
    expect(session.getMessagesForModel().filter((m) => m.role === "user"
      && m.content.some((c) => c.type === "text" && c.text.includes("STEER: switch the output to 720p"))))
      .toHaveLength(1);
  });

  it("builds active checkpoint input from bounded projections without mutating raw tool data", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current projection task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{
        type: "tool_use",
        id: `projection-${i}`,
        name: "large_tool",
        input: { command: `INPUT_HEAD_${i}${"i".repeat(6_000)}INPUT_TAIL_${i}` },
      }]);
      const isError = i === 1;
      session.addToolResult(
        `projection-${i}`,
        `${isError ? "ERROR" : "RESULT"}_HEAD_${i}${isError ? "e".repeat(15_000) : "r".repeat(15_000)}${isError ? "ERROR" : "RESULT"}_TAIL_${i}`,
        undefined,
        isError,
      );
    }

    const rawBefore = JSON.stringify(session.getMessages());
    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate?.groups.length).toBeGreaterThanOrEqual(3);
    const projection = JSON.stringify(candidate?.messages || []);

    expect(projection).toContain("INPUT_HEAD_0");
    expect(projection).toContain("INPUT_TAIL_0");
    expect(projection).toContain("RESULT_HEAD_0");
    expect(projection).toContain("RESULT_TAIL_0");
    expect(projection).toContain("ERROR_HEAD_1");
    expect(projection).toContain("ERROR_TAIL_1");
    expect(projection).toContain("chars omitted]");
    // Tool input and error output are metadata-shaped and cut at the shorter
    // cap; successful tool output keeps the body cap.
    expect(projection).not.toContain("i".repeat(ACTIVE_CHECKPOINT_META_MAX_CHARS + 1));
    expect(projection).not.toContain("r".repeat(ACTIVE_CHECKPOINT_BODY_MAX_CHARS + 1));
    expect(projection).not.toContain("e".repeat(ACTIVE_CHECKPOINT_META_MAX_CHARS + 1));
    expect(rawBefore).toContain("i".repeat(5_000));
    expect(rawBefore).toContain("r".repeat(10_000));
    expect(rawBefore).toContain("e".repeat(10_000));
    expect(JSON.stringify(session.getMessages())).toBe(rawBefore);
  });

  it("keeps exact-fact bullets cumulative when later checkpoints omit prior epochs", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Retain every exact fact" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "fact-1", name: "probe", input: {} }]);
    session.addToolResult("fact-1", "FACT-1=amber", undefined, false);

    const first = session.applyActiveCheckpointSummary(
      `${ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING}\n- FACT-1=amber\n\nNext steps:\n- continue`,
      2,
    );
    expect(first).toContain("- FACT-1=amber");

    session.addAssistantMessage([{ type: "tool_use", id: "fact-2", name: "probe", input: {} }]);
    session.addToolResult("fact-2", "FACT-2=birch", undefined, false);
    const second = session.applyActiveCheckpointSummary(
      `**${ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING}**\n- FACT-2=birch\n\nNext steps:\n- continue`,
      4,
    );
    expect(second.indexOf("- FACT-1=amber")).toBeLessThan(second.indexOf("- FACT-2=birch"));

    session.addAssistantMessage([{ type: "tool_use", id: "fact-3", name: "probe", input: {} }]);
    session.addToolResult("fact-3", "FACT-3=cobalt", undefined, false);
    const third = session.applyActiveCheckpointSummary("Completed newer work but omitted the ledger.", 6);
    expect(third).toContain(ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING);
    expect(third).toContain("- FACT-1=amber");
    expect(third).toContain("- FACT-2=birch");
    expect(third.match(/FACT-1=amber/g)).toHaveLength(1);

    const modelView = JSON.stringify(session.getMessagesForModel());
    expect(modelView).toContain("FACT-1=amber");
    expect(modelView).toContain("FACT-2=birch");
    expect(modelView).not.toContain("FACT-3=cobalt");
  });

  it("previews an active checkpoint without pruning or mutating metadata", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current large task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `preview-${i}`, name: "bash", input: { command: `cmd-${i}` } }]);
      session.addToolResult(`preview-${i}`, `result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }
    const candidate = session.getPendingActiveCheckpoint()!;
    const beforeState = JSON.stringify(session.getSerializedContextState());
    const beforeRaw = JSON.stringify(session.getMessages());
    const projected = session.previewActiveCheckpointTokens("Projected active summary", candidate.checkpointThroughMessageIndex);

    expect(projected).toBeLessThan(session.estimateModelTokens());
    expect(JSON.stringify(session.getSerializedContextState())).toBe(beforeState);
    expect(JSON.stringify(session.getMessages())).toBe(beforeRaw);
  });

  // Retention used to carry a fixed step cap alongside the token budget. With
  // small steps the cap always bound first — measured at 2 kept while the
  // budget had room for 16 — so it discarded exactly the recent raw output the
  // model would otherwise still have, and then had to re-read.
  it("keeps recent tool steps up to the token budget rather than a fixed count", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Many small steps" }]);
    const STEP_CHARS = 2_000;
    const TOTAL_STEPS = 40;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `s-${i}`, name: "grep", input: { pattern: `p-${i}` } }]);
      session.addToolResult(`s-${i}`, `hit-${i}\n${"x".repeat(STEP_CHARS)}`, undefined, false);
    }

    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).toBeTruthy();
    const retainedSteps = TOTAL_STEPS - candidate!.groups.length;

    // Well past the old fixed cap of 2, and bounded by the token budget: each
    // step is ~STEP_CHARS/4 tokens, so the budget cannot hold more than this.
    expect(retainedSteps).toBeGreaterThan(2);
    expect(retainedSteps).toBeLessThanOrEqual(Math.ceil(ACTIVE_RETAIN_TOKEN_BUDGET / (STEP_CHARS / 4)));

    // The budget bound still holds where it matters: applying the checkpoint
    // must drop the live tail below the trigger so it cannot immediately refire.
    session.applyActiveCheckpointSummary("Older small steps summarized", candidate!.checkpointThroughMessageIndex);
    expect(session.estimateActiveProcessTokens()).toBeLessThan(ACTIVE_PROCESS_TRIGGER_TOKENS);
    expect(session.getPendingActiveCheckpoint()).toBeNull();
  });

  it("keeps recent completed turns up to the token budget rather than a fixed count", () => {
    const session = new Session();
    const REPLY_CHARS = 2_000;
    const TOTAL_TURNS = 30;
    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      session.beginUserTurn([{ type: "text", text: `question ${turn}` }]);
      session.addAssistantMessage([{ type: "text", text: `answer ${turn}\n${"y".repeat(REPLY_CHARS)}` }]);
      session.completeActiveTurn();
    }

    const candidate = session.getPendingHistoryArchive();
    expect(candidate).toBeTruthy();
    const retainedTurns = TOTAL_TURNS - candidate!.turnIds.length;

    expect(retainedTurns).toBeGreaterThan(2);
    expect(retainedTurns).toBeLessThanOrEqual(Math.ceil(HISTORY_RAW_RETAIN_TOKEN_BUDGET / (REPLY_CHARS / 4)));
  });

  // The parameterized path must not change anything for callers that have no
  // model in scope (reflection, summarization, every test above).
  it("uses the historical thresholds when no budget is supplied", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Default budget task" }]);
    for (let i = 0; i < 6; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `d-${i}`, name: "bash", input: { command: `c-${i}` } }]);
      session.addToolResult(`d-${i}`, `out-${i}\n${"x".repeat(12_000)}`, undefined, false);
    }
    expect(JSON.stringify(session.getPendingActiveCheckpoint()))
      .toBe(JSON.stringify(session.getPendingActiveCheckpoint(DEFAULT_CONTEXT_BUDGET)));
  });

  it("compacts later on a wide window and earlier on a narrow one", () => {
    const build = () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Window-sensitive task" }]);
      for (let i = 0; i < 10; i++) {
        session.addAssistantMessage([{ type: "tool_use", id: `w-${i}`, name: "bash", input: { command: `c-${i}` } }]);
        session.addToolResult(`w-${i}`, `out-${i}\n${"x".repeat(8_000)}`, undefined, false);
      }
      return session;
    };
    const overhead = { fixedOverheadTokens: 30_000 };
    const wide = contextBudget({ usableInputTokens: 1_000_000, ...overhead });
    const narrow = contextBudget({ usableInputTokens: 21_760, ...overhead });

    // ~20K tokens of live tool traffic: past the narrow window's trigger, well
    // inside the wide one's.
    expect(build().getPendingActiveCheckpoint(wide)).toBeNull();
    expect(build().getPendingActiveCheckpoint(narrow)).toBeTruthy();
  });

  // Used by the emergency path, which runs when summarization is unavailable
  // and space matters more than the verbatim tail.
  it("offers every foldable tool step, retaining none, on group boundaries", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Emergency task" }]);
    expect(session.getFoldableActiveProcess()).toBeNull();

    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `e-${i}`, name: "bash", input: { cmd: `c-${i}` } }]);
      session.addToolResult(`e-${i}`, `out-${i}\n${"y".repeat(3_000)}`, undefined, false);
    }

    const foldable = session.getFoldableActiveProcess()!;
    // Nothing is held back, unlike the normal checkpoint which keeps a tail.
    expect(foldable.groups).toHaveLength(5);
    const normal = session.getPendingActiveCheckpoint();
    expect(foldable.groups.length).toBeGreaterThan(normal?.groups.length ?? 0);

    session.applyActiveCheckpointSummary("[reduced without summarization]", foldable.checkpointThroughMessageIndex);

    // A cut between a tool_use and its tool_result would leave the request
    // malformed for the provider, so every remaining pair must still match.
    const view = session.getMessagesForModel();
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const message of view) {
      for (const part of message.content as Array<{ type: string; id?: string; toolUseId?: string }>) {
        if (part.type === "tool_use" && part.id) useIds.add(part.id);
        if (part.type === "tool_result" && part.toolUseId) resultIds.add(part.toolUseId);
      }
    }
    expect([...resultIds].every((id) => useIds.has(id))).toBe(true);
    expect([...useIds].every((id) => resultIds.has(id))).toBe(true);

    // Raw payloads are gone and the notice took their place.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("y".repeat(500));
    expect(serialized).toContain("reduced without summarization");

    // Everything foldable is folded, so a second pass has nothing to offer.
    expect(session.getFoldableActiveProcess()).toBeNull();
  });

  // The merge machinery keeps only the exact-facts section of a replaced
  // summary. The normal path survives that because the summarizer receives the
  // prior prose as input and rewrites it forward; the emergency path bypasses
  // the summarizer, so without explicit embedding an emergency fold would
  // silently erase every earlier checkpoint's prose — far more than the "N
  // steps dropped" its notice admits to.
  it("emergency fold keeps prior checkpoint prose and records the drop durably", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Long build task" }]);
    for (let i = 0; i < 3; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `pre-${i}`, name: "bash", input: { cmd: `c-${i}` } }]);
      session.addToolResult(`pre-${i}`, `out-${i}\n${"x".repeat(2_000)}`, undefined, false);
    }
    // A successful LLM checkpoint earlier in the turn, with prose and a fact.
    const llmCheckpoint = [
      "Important observations and decisions:",
      "- API returns timestamps in UTC; downstream must not localize.",
      "",
      "Exact facts and identifiers required for continuation/final output (cumulative):",
      "- deploy_token=tok_9f2a",
    ].join("\n");
    const first = session.getPendingActiveCheckpoint()!;
    session.applyActiveCheckpointSummary(llmCheckpoint, first?.checkpointThroughMessageIndex ?? 4);

    for (let i = 3; i < 6; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `post-${i}`, name: "bash", input: { cmd: `c-${i}` } }]);
      session.addToolResult(`post-${i}`, `out-${i}\n${"y".repeat(2_000)}`, undefined, false);
    }

    const foldable = session.getFoldableActiveProcess()!;
    const notice = [
      "[Context reduced without summarization]",
      "Raw output dropped.",
      "",
      "Exact facts and identifiers required for continuation/final output (cumulative):",
      "- context_reduction: raw output of 3 tool step(s) in this turn was dropped without a summary",
    ].join("\n");
    session.applyEmergencyActiveFold(notice, foldable.checkpointThroughMessageIndex);

    const afterEmergency = JSON.stringify(session.getMessagesForModel());
    // The notice, the prior prose, and BOTH facts must all still be visible.
    expect(afterEmergency).toContain("Context reduced without summarization");
    expect(afterEmergency).toContain("Prior checkpoint retained verbatim");
    expect(afterEmergency).toContain("timestamps in UTC");
    expect(afterEmergency).toContain("deploy_token=tok_9f2a");
    expect(afterEmergency).toContain("context_reduction: raw output of 3 tool step(s)");
    // The embedded prose was stripped of its facts section, so the merged
    // summary carries each fact exactly once.
    expect(afterEmergency.split("deploy_token=tok_9f2a").length - 1).toBe(1);

    // Summarization recovers: a later normal checkpoint replaces prose, but
    // the drop record must survive as a fact — the hole does not close just
    // because the service came back.
    for (let i = 6; i < 9; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `late-${i}`, name: "bash", input: { cmd: `c-${i}` } }]);
      session.addToolResult(`late-${i}`, `out-${i}\n${"z".repeat(2_000)}`, undefined, false);
    }
    const recovered = session.getFoldableActiveProcess()!;
    session.applyActiveCheckpointSummary("Fresh summary after recovery.", recovered.checkpointThroughMessageIndex);
    const afterRecovery = JSON.stringify(session.getMessagesForModel());
    expect(afterRecovery).toContain("Fresh summary after recovery.");
    expect(afterRecovery).toContain("context_reduction: raw output of 3 tool step(s)");
    expect(afterRecovery).toContain("deploy_token=tok_9f2a");
  });

  it("emergency history fold keeps the prior rolling summary verbatim", () => {
    const session = new Session();
    for (let turn = 0; turn < 3; turn++) {
      session.beginUserTurn([{ type: "text", text: `question ${turn}` }]);
      session.addAssistantMessage([{ type: "text", text: `answer ${turn}` }]);
      session.completeActiveTurn();
    }
    session.applyHistorySummary(
      "User is migrating the billing stack; prefers Stripe test-mode fixtures.",
      session.getArchivableHistoryTurns(),
    );
    for (let turn = 3; turn < 5; turn++) {
      session.beginUserTurn([{ type: "text", text: `question ${turn}` }]);
      session.addAssistantMessage([{ type: "text", text: `answer ${turn}` }]);
      session.completeActiveTurn();
    }

    session.applyEmergencyHistoryFold(
      "[Earlier turns dropped without summarization]",
      session.getArchivableHistoryTurns(),
    );

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Earlier turns dropped without summarization");
    expect(view).toContain("Prior history summary retained verbatim");
    expect(view).toContain("prefers Stripe test-mode fixtures");
  });

  it("offers every unarchived completed turn for emergency archiving", () => {
    const session = new Session();
    expect(session.getArchivableHistoryTurns()).toEqual([]);

    for (let turn = 0; turn < 3; turn++) {
      session.beginUserTurn([{ type: "text", text: `question ${turn}` }]);
      session.addAssistantMessage([{ type: "text", text: `answer ${turn}` }]);
      session.completeActiveTurn();
    }

    const archivable = session.getArchivableHistoryTurns();
    expect(archivable).toHaveLength(3);

    session.applyHistorySummary("[earlier turns dropped]", archivable);
    expect(session.getArchivableHistoryTurns()).toEqual([]);
  });

  it("active checkpoint trigger tracks only the live tail, not cumulative raw", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current large task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: `cmd-${i}` } }]);
      session.addToolResult(`call-${i}`, `result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }
    // Before any checkpoint the whole raw process is counted → trigger is hot.
    const rawBefore = session.estimateActiveProcessTokens();
    expect(rawBefore).toBeGreaterThan(ACTIVE_PROCESS_TRIGGER_TOKENS);

    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).toBeTruthy();
    session.applyActiveCheckpointSummary("Older tool work summarized", candidate!.checkpointThroughMessageIndex);

    // After the older groups are folded into the summary the estimate reflects
    // only the retained tail (+summary), so it drops well below the trigger and
    // the checkpoint does not immediately re-fire (this is the fix: previously the
    // estimate stayed at the cumulative raw size and kept the trigger hot).
    const liveAfter = session.estimateActiveProcessTokens();
    expect(liveAfter).toBeLessThan(rawBefore);
    expect(liveAfter).toBeLessThan(ACTIVE_PROCESS_TRIGGER_TOKENS);
    expect(session.getPendingActiveCheckpoint()).toBeNull();
  });

  it("physical pruning frees archived tool_result bytes while preserving structure and indices", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current large task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: `cmd-${i}` } }]);
      session.addToolResult(`call-${i}`, `result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }
    const lengthBefore = session.length;
    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate?.groups).toHaveLength(3);
    session.applyActiveCheckpointSummary("Older tool work summarized", candidate!.checkpointThroughMessageIndex);

    // Array length (hence every absolute message index) is unchanged.
    expect(session.length).toBe(lengthBefore);

    const raw = session.getMessages();
    const findResult = (id: string) =>
      raw
        .flatMap((m) => m.content)
        .find((c) => (c as { type?: string }).type === "tool_result" && (c as { toolUseId?: string }).toolUseId === id) as
        | { type: string; toolUseId: string; content: string }
        | undefined;

    // Archived tool_results (0,1,2) keep their type/toolUseId (so pairing and
    // turn-boundary detection stay valid) but drop the heavy payload.
    for (const id of ["call-0", "call-1", "call-2"]) {
      const r = findResult(id);
      expect(r).toBeTruthy();
      expect(r!.type).toBe("tool_result");
      expect(r!.content).toBe(ARCHIVED_TOOL_RESULT_MARKER);
      expect(r!.content).not.toContain("xxxxx");
    }
    // Retained tail (3,4) keeps full content.
    for (const id of ["call-3", "call-4"]) {
      expect(findResult(id)!.content).toContain("x".repeat(1_000));
    }

    // The projected model view is unchanged: archived work excluded, summary +
    // retained tail included.
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Older tool work summarized");
    expect(view).not.toContain("result-0");
    expect(view).toContain("result-4");

    // Turn tracking survives pruning — a fresh turn starts cleanly, proving the
    // pruned tool_results did NOT become spurious turn starters.
    session.beginUserTurn([{ type: "text", text: "Next task" }]);
    expect(JSON.stringify(session.getMessagesForModel())).toContain("Next task");
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
  // compaction triggered by the 82% context guard) where post-compact
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
  // under-estimation bug that let the runner's 82% compaction guard skip
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

describe("Session getMessagesForModel turnContext (P2 per-turn ephemeral)", () => {
  const textOf = (msg: { content: Array<{ type: string; text?: string }> }) =>
    msg.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

  it("injects turnContext into the active turn's user message, view-only, never persisted", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "do the task" }]);

    const view = session.getMessagesForModel({ turnContext: "ORCH-LEDGER-XYZ" });
    const active = view[view.length - 1];
    expect(active.role).toBe("user");
    const t = textOf(active);
    // Ephemeral block is prepended before the real user text.
    expect(t).toContain("ORCH-LEDGER-XYZ");
    expect(t).toContain("do the task");
    expect(t).toContain("Private runtime context for task continuation only.");
    expect(t.indexOf("ORCH-LEDGER-XYZ")).toBeLessThan(t.indexOf("do the task"));

    // No turnContext → no injection anywhere in the view.
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("ORCH-LEDGER-XYZ");
    // Raw / persisted messages NEVER carry the ephemeral block.
    expect(JSON.stringify(session.getMessages())).not.toContain("ORCH-LEDGER-XYZ");
  });

  it("does not inject when turnContext is blank/whitespace", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "hi" }]);
    expect(JSON.stringify(session.getMessagesForModel({ turnContext: "   " })))
      .toBe(JSON.stringify(session.getMessagesForModel()));
  });

  it("appends turnContext for legacy (no turn-tracking) sessions, still view-only", () => {
    const session = new Session();
    session.addUserMessage("hello"); // no beginUserTurn → turnState stays null
    const view = session.getMessagesForModel({ turnContext: "CTX-LEGACY" });
    expect(JSON.stringify(view)).toContain("CTX-LEGACY");
    expect(JSON.stringify(session.getMessages())).not.toContain("CTX-LEGACY");
  });
});

describe("Session execution plan anchor", () => {
  it("keeps objective and steps outside raw history and injects them at the model tail", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Implement the long-running import safely" }]);
    const plan = session.updateExecutionPlan({
      explanation: "Initial milestones",
      steps: [
        { step: "Inspect the importer", status: "completed" },
        { step: "Implement bounded streaming", status: "in_progress" },
        { step: "Run regression tests", status: "pending" },
      ],
    });
    session.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "import.ts" } }]);
    session.addToolResult("call-1", "source bytes", undefined, false);

    const view = session.getMessagesForModel();
    const tail = JSON.stringify(view[view.length - 1]);
    expect(tail).toContain("Execution plan anchor");
    expect(tail).toContain("Never quote, summarize, acknowledge, or mention this block");
    expect(tail).toContain("Implement the long-running import safely");
    expect(tail).toContain("Implement bounded streaming");
    expect(tail).toContain("in_progress");
    expect(plan.objective).toBe("Implement the long-running import safely");

    expect(JSON.stringify(session.getMessages())).not.toContain("Execution plan anchor");
    expect(JSON.stringify(session.getMessagesForSummary())).not.toContain("Execution plan anchor");
  });

  it("survives an active checkpoint even when the checkpoint omits the goal", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Do not lose this exact original objective" }]);
    session.updateExecutionPlan({
      steps: [
        { step: "Collect evidence", status: "completed" },
        { step: "Apply the change", status: "in_progress" },
      ],
    });
    session.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "bash", input: { command: "inspect" } }]);
    session.addToolResult("call-1", "x".repeat(2_000), undefined, false);
    session.applyActiveCheckpointSummary("Only process progress, deliberately no objective.", 2);

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Current turn checkpoint");
    expect(view).toContain("Only process progress");
    expect(view).toContain("Execution plan anchor");
    expect(view).toContain("Do not lose this exact original objective");
  });

  it("durably appends a newer user instruction before an optional explicit objective replacement", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Original task" }]);
    session.updateExecutionPlan({ steps: [{ step: "First step", status: "in_progress" }] });
    session.addAssistantMessage([{ type: "text", text: "Partial result" }]);
    session.completeActiveTurn();

    session.beginUserTurn([{ type: "text", text: "Actually switch to the replacement task" }]);
    let view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Reconciliation required");
    expect(session.getExecutionPlan()?.objective).toBe("Original task");

    session.updateExecutionPlan({
      steps: [{ step: "Replacement step", status: "in_progress" }],
    });
    expect(session.getExecutionPlan()?.objective).toContain("Original task");
    expect(session.getExecutionPlan()?.objective).toContain("Actually switch to the replacement task");
    expect(session.getExecutionPlan()?.objective).toMatch(
      /^\[Latest user instruction — authoritative; replaces conflicting earlier requirements\]\n\nActually switch to the replacement task/,
    );
    expect(session.getExecutionPlan()?.objective).toContain(
      "[Earlier objective — retain only non-conflicting requirements]",
    );

    session.updateExecutionPlan({
      replaceObjective: true,
      steps: [{ step: "Replacement step", status: "in_progress" }],
    });
    view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Reconciliation: current");
    expect(session.getExecutionPlan()?.objective).toBe("Actually switch to the replacement task");
  });

  it("detects an interrupt-steer inside the same active turn", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Initial in-flight goal" }]);
    session.updateExecutionPlan({ steps: [{ step: "Work", status: "in_progress" }] });

    session.addMessage("user", [{ type: "text", text: "Pause that and account for this new constraint" }]);
    expect(JSON.stringify(session.getMessagesForModel())).toContain("Reconciliation required");

    session.updateExecutionPlan({ steps: [{ step: "Account for constraint", status: "in_progress" }] });
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Reconciliation: current");
    expect(session.getExecutionPlan()?.objective).toContain("Initial in-flight goal");
    expect(session.getExecutionPlan()?.objective).toContain("Pause that and account for this new constraint");
    expect(session.getExecutionPlan()?.objective).toContain(
      "Latest user instruction — authoritative; replaces conflicting earlier requirements",
    );
  });

  it("rejects milestone removal or renaming under the same user instruction", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the full investigation and final report" }]);
    session.updateExecutionPlan({
      steps: [
        { step: "Collect all required evidence", status: "in_progress" },
        { step: "Validate findings and deliver the final report", status: "pending" },
      ],
    });

    expect(() => session.updateExecutionPlan({
      explanation: "Narrow the scope and claim completion",
      steps: [
        { step: "Collect initial evidence", status: "completed" },
        { step: "Summarize preliminary findings", status: "completed" },
      ],
    })).toThrow("cannot remove or rename existing milestones");

    expect(session.getExecutionPlan()).toMatchObject({
      revision: 1,
      steps: [
        { id: 1, step: "Collect all required evidence", status: "in_progress" },
        { id: 2, step: "Validate findings and deliver the final report", status: "pending" },
      ],
    });
  });

  it("keeps stable step ids while updating statuses and appending discovered work", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the migration" }]);
    const initial = session.updateExecutionPlan({
      steps: [
        { step: "Inspect callers", status: "in_progress" },
        { step: "Migrate storage", status: "pending" },
      ],
    });

    const updated = session.updateExecutionPlan({
      steps: [
        { step: "Inspect callers", status: "completed" },
        { step: "Migrate storage", status: "in_progress" },
        { step: "Verify restart recovery", status: "pending" },
      ],
    });

    expect(initial.steps.map((step) => step.id)).toEqual([1, 2]);
    expect(updated.steps).toEqual([
      { id: 1, step: "Inspect callers", status: "completed" },
      { id: 2, step: "Migrate storage", status: "in_progress" },
      { id: 3, step: "Verify restart recovery", status: "pending" },
    ]);
    expect(updated.nextStepId).toBe(4);
  });

  // The anchor used to append "observed work #12,#13" to completed steps, from a
  // window-level scan that shared one id list across every step marked complete
  // in that window and counted read-only calls. Window data cannot answer a
  // step-level question, so the claim was removed rather than re-derived: the
  // workspace and completed-work ledgers already state the same facts without
  // asserting which step they belong to.
  it("states plan step status without claiming completion evidence", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Ship the migration" }]);
    session.recordCompletedWork({
      tool: "read_file",
      inputDigest: "r:1",
      inputSummary: "read src/a.ts",
      status: "succeeded",
    });
    session.updateExecutionPlan({
      steps: [
        { step: "Inspect callers", status: "completed" },
        { step: "Migrate storage", status: "in_progress" },
      ],
    });

    const anchor = JSON.stringify(session.getMessagesForModel());
    expect(anchor).toContain("Execution plan anchor");
    expect(anchor).toContain("[completed] Inspect callers");
    expect(anchor).not.toContain("observed work");
    expect(anchor).not.toContain("unverified");
    expect(anchor).not.toContain("Tool-ledger evidence");
    // The deterministic ledgers still carry what actually ran.
    expect(anchor).toContain("Completed work ledger");
  });

  it("does not regress completed milestones under the same user instruction", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Finish the release" }]);
    session.updateExecutionPlan({
      steps: [
        { step: "Run compatibility tests", status: "completed" },
        { step: "Publish artifacts", status: "in_progress" },
      ],
    });

    expect(() => session.updateExecutionPlan({
      steps: [
        { step: "Run compatibility tests", status: "pending" },
        { step: "Publish artifacts", status: "in_progress" },
      ],
    })).toThrow("cannot regress completed milestone 1");
  });

  it("retains an explicit all-completed plan after the active turn completes", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Produce the verified report" }]);
    session.updateExecutionPlan({
      steps: [
        { step: "Collect evidence", status: "completed" },
        { step: "Produce the verified report", status: "completed" },
      ],
    });
    session.addAssistantMessage([{ type: "text", text: "Finished." }]);

    session.completeActiveTurn();

    expect(session.getExecutionPlan()).toMatchObject({
      revision: 1,
      steps: [
        { id: 1, step: "Collect evidence", status: "completed" },
        { id: 2, step: "Produce the verified report", status: "completed" },
      ],
    });
  });

  it("requires a newer real user instruction to clear or replace an explicit plan", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the original task" }]);
    session.updateExecutionPlan({
      steps: [{ step: "Complete every success criterion", status: "in_progress" }],
    });

    expect(() => session.clearExecutionPlan()).toThrow("cannot clear an explicit plan");
    expect(() => session.updateExecutionPlan({
      replaceObjective: true,
      steps: [{ step: "Do less work", status: "completed" }],
    })).toThrow("replace_objective requires a newer real user instruction");

    session.addMessage("user", [{ type: "text", text: "Cancel the original task" }]);
    session.clearExecutionPlan();
    expect(session.getExecutionPlan()).toBeUndefined();
  });

  it("keeps a bounded deterministic work ledger and collapses exact repeats", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Research the issue without repeating calls" }]);
    const first = session.recordCompletedWork({
      toolCallId: "call-1",
      tool: "skill_manage",
      inputDigest: "10:abc",
      inputSummary: '{"action":"read","id":"research"}',
      status: "succeeded",
      resultSummary: "skill loaded",
      checkpointEpoch: 0,
    });
    session.recordCompletedWork({
      toolCallId: "call-2",
      tool: "skill_manage",
      inputDigest: "10:abc",
      inputSummary: '{"action":"read","id":"research"}',
      status: "succeeded",
      resultSummary: "skill loaded again",
      checkpointEpoch: 1,
    });

    expect(first?.id).toBe(1);
    expect(session.getCompletedWorkLedger()).toEqual([expect.objectContaining({
      id: 1,
      lastObservationId: 2,
      repeatCount: 2,
      checkpointEpoch: 1,
      resultSummary: "skill loaded again",
    })]);
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Completed work ledger");
    expect(view).toContain("Private runtime context for task continuation only.");
    expect(view).toContain("skill_manage");
    expect(view).toContain("x2");
    expect(JSON.stringify(session.getMessages())).not.toContain("Completed work ledger");
  });

  it("marks workspace observations as private model-only runtime context", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Update the workspace file" }]);
    session.recordToolObservations({
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/example.ts",
          beforeExists: true,
          afterExists: true,
          beforeHash: "sha256:before",
          afterHash: "sha256:after",
          coverage: "hash",
        }],
      },
    });

    const workspaceContext = session.getMessagesForModel()
      .flatMap((message) => message.content)
      .find((content) => content.type === "text" && content.text.startsWith("[Workspace changes"));
    expect(workspaceContext?.type).toBe("text");
    if (workspaceContext?.type !== "text") throw new Error("missing workspace projection");
    expect(workspaceContext.text).toContain("Private runtime context for task continuation only.");
    expect(JSON.stringify(session.getMessages())).not.toContain("[Workspace changes");
  });

  it("bounds the sidecar ledger and its model projection independently", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Run a long bounded investigation" }]);
    for (let index = 1; index <= COMPLETED_WORK_MAX_ENTRIES + 14; index++) {
      session.recordCompletedWork({
        tool: "probe",
        inputDigest: `digest-${index}`,
        inputSummary: JSON.stringify({ index, query: "q".repeat(80) }),
        status: "succeeded",
        resultSummary: `result-${index}-${"r".repeat(200)}`,
      });
    }

    const ledger = session.getCompletedWorkLedger();
    expect(ledger).toHaveLength(COMPLETED_WORK_MAX_ENTRIES);
    expect(ledger[0].id).toBe(15);
    expect(ledger.at(-1)?.id).toBe(COMPLETED_WORK_MAX_ENTRIES + 14);

    const ledgerText = session.getMessagesForModel()
      .flatMap((message) => message.content)
      .find((content) => content.type === "text" && content.text.startsWith("[Completed work ledger"));
    expect(ledgerText?.type).toBe("text");
    if (ledgerText?.type !== "text") throw new Error("missing completed-work projection");
    expect(ledgerText.text.length).toBeLessThanOrEqual(COMPLETED_WORK_MODEL_MAX_CHARS);
    expect(ledgerText.text.match(/^#\d+ /gm)?.length ?? 0)
      .toBeLessThanOrEqual(COMPLETED_WORK_MODEL_MAX_ENTRIES);
    expect(ledgerText.text).toContain(`#${COMPLETED_WORK_MAX_ENTRIES + 14}`);
    expect(ledgerText.text).not.toContain("#14 ");
  });

  it("retains bounded plan revisions and a clear tombstone", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the auditable task" }]);
    session.updateExecutionPlan({
      steps: [{ step: "Do the work", status: "in_progress" }],
    });
    session.updateExecutionPlan({
      steps: [{ step: "Do the work", status: "completed" }],
    });
    session.addMessage("user", [{ type: "text", text: "The result is accepted; clear the plan" }]);
    session.clearExecutionPlan();

    expect(session.getExecutionPlan()).toBeUndefined();
    expect(session.getExecutionPlanAudit().map((record) => record.action))
      .toEqual(["update", "update", "clear"]);
    expect(session.getExecutionPlanAudit().at(-1)).toMatchObject({
      action: "clear",
      objective: "Complete the auditable task",
      steps: [{ id: 1, step: "Do the work", status: "completed" }],
    });
  });

  it("caps retained plan audit history", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Keep a bounded plan audit" }]);
    for (let index = 0; index < EXECUTION_PLAN_AUDIT_MAX_ENTRIES + 4; index++) {
      session.updateExecutionPlan({
        explanation: `revision ${index}`,
        steps: [{ step: "Complete the bounded audit", status: "in_progress" }],
      });
    }
    const audit = session.getExecutionPlanAudit();
    expect(audit).toHaveLength(EXECUTION_PLAN_AUDIT_MAX_ENTRIES);
    expect(audit[0].revision).toBe(5);
    expect(audit.at(-1)?.revision).toBe(EXECUTION_PLAN_AUDIT_MAX_ENTRIES + 4);
  });

  it("normalizes ambiguous concurrent in-progress milestones in plan order", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Long task" }]);
    const plan = session.updateExecutionPlan({
      steps: [
        { step: "A", status: "in_progress" },
        { step: "B", status: "in_progress" },
      ],
    });
    expect(plan.steps.map((step) => step.status)).toEqual(["in_progress", "pending"]);
  });
});
