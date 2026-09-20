import { describe, it, expect } from "vitest";
import {
  Session,
  ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING,
  ARCHIVED_TOOL_RESULT_MARKER,
  COMPLETED_WORK_MAX_ENTRIES,
  COMPLETED_WORK_MODEL_MAX_TOKENS,
  COMPLETED_WORK_MODEL_MAX_ENTRIES,
  EXECUTION_PLAN_AUDIT_MAX_ENTRIES,
  HISTORY_EXACT_FACTS_HEADING,
  HISTORY_EXACT_FACTS_MAX_TOKENS,
  estimateTextTokens,
  IMAGE_BLOCK_ESTIMATE_TOKENS,
  DEFAULT_CONTEXT_BUDGET,
  CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS,
  boundStructuredSummaryTokens,
  contextBudget,
  ACTIVE_TURN_IMAGE_OMITTED_MARKER,
} from "../src/agent/session.js";

describe("Session", () => {
  it("keeps transport identity through active work but not completion, reset or persistence reload", () => {
    const session = new Session();
    expect(session.getProviderTurnContext()).toBeUndefined();
    session.beginUserTurn([{ type: "text", text: "Process the report" }]);
    const first = session.getProviderTurnContext();
    expect(first).toBeDefined();
    session.addAssistantMessage([{ type: "tool_use", id: "read", name: "read_files", input: {} }]);
    session.addToolResult("read", "source report");
    session.applyActiveCheckpointSummary("Source report inspected", session.length - 1);
    expect(session.getProviderTurnContext()).toBe(first);
    const serialized = session.getSerializedContextState();
    expect(JSON.stringify(serialized)).not.toContain("providerTurnContext");
    const restored = new Session();
    for (const message of session.getMessages()) restored.addMessage(message.role, message.content, message.turnId);
    // PersistentSession loads messages before the sidecar. False means the
    // supplied context was valid and needed no reconstruction, not a failure.
    expect(restored.restoreContextState(serialized)).toBe(false);
    expect(restored.getProviderTurnContext()).toBeDefined();
    expect(restored.getProviderTurnContext()).not.toBe(first);
    session.completeActiveTurn("Report ready");
    expect(session.getProviderTurnContext()).toBeUndefined();
    session.beginUserTurn([{ type: "text", text: "Process another report" }]);
    expect(session.getProviderTurnContext()).not.toBe(first);
    const second = session.getProviderTurnContext();
    session.clear();
    session.beginUserTurn([{ type: "text", text: "Restart" }]);
    expect(session.getProviderTurnContext()).not.toBe(second);
    expect(session.getProviderTurnContext()).not.toBe(first);
  });

  it("keeps a read/write turn append-only without manufacturing a new user boundary", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Update the file and check the result" }]);
    session.addAssistantMessage([
      { type: "thinking", thinking: "opaque", thinkingSignature: "signed-state" },
      { type: "tool_use", id: "write-1", name: "write_file", input: {} },
    ]);
    session.recordToolObservations({
      toolCallId: "write-1", tool: "write_file",
      observations: { fileChanges: [{ operation: "create", sourcePath: "/workspace/report.txt",
        beforeExists: false, afterExists: true, afterHash: "sha256:first", coverage: "exact" }] },
    });
    session.addToolResult("write-1", "Created report.txt sha256:first");
    const first = session.getMessagesForModel();
    session.addAssistantMessage([{ type: "tool_use", id: "read-2", name: "read_file", input: {} }]);
    session.addToolResult("read-2", "Verified report.txt");
    const second = session.getMessagesForModel();
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.filter((message) => message.role === "user"
      && !message.content.some((part) => part.type === "tool_result"))).toHaveLength(1);
    expect(JSON.stringify(second)).toContain("sha256:first");
    // A real correction must still be a new user boundary.
    session.addUserMessage("Use the corrected totals");
    expect(session.getMessagesForModel().at(-1)).toMatchObject({ role: "user" });
  });

  it("starts empty", () => {
    const session = new Session();
    expect(session.length).toBe(0);
    expect(session.getMessages()).toEqual([]);
  });

  it("keeps a real image-only steer through compaction instead of treating it as a tool trailer", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect this report" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "read", name: "read_files", input: {} }]);
    session.addToolResult("read", "report");
    session.addMessage("user", [{ type: "image", data: "user-correction", mediaType: "image/png" }]);
    session.applyActiveCheckpointSummary("Earlier report inspected.", session.length - 1);
    expect(session.getMessagesForModel().at(-1)).toEqual({ role: "user",
      content: [{ type: "image", data: "user-correction", mediaType: "image/png" }] });
  });

  it("freezes checkpoint recovery facts while later writes append newer evidence", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Revise a report" }]);
    const write = (revision: number) => {
      const id = `revision-${revision}`;
      session.addAssistantMessage([{ type: "tool_use", id, name: "write_file", input: {} }]);
      session.recordToolObservations({ toolCallId: id, tool: "write_file", observations: { fileChanges: [{
        operation: "update", sourcePath: "/workspace/report.txt", beforeExists: true, afterExists: true,
        beforeHash: `sha256:${revision - 1}`, afterHash: `sha256:${revision}`, coverage: "exact",
      }] } });
      session.addToolResult(id, `Saved sha256:${revision}`);
    };
    write(1);
    session.applyActiveCheckpointSummary("The report was saved.", 2);
    const checkpointView = session.getMessagesForModel();
    write(2);
    const view = session.getMessagesForModel();
    expect(view.slice(0, checkpointView.length)).toEqual(checkpointView);
    expect(JSON.stringify(checkpointView)).toContain("sha256:1");
    expect(JSON.stringify(view.at(-1))).toContain("sha256:2");
    expect(session.getWorkspaceObservations().entries.at(-1)?.fileChanges?.[0].afterHash).toBe("sha256:2");
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
      images: [],
    });
  });

  it("attaches returned images to their actual tool result", () => {
    const session = new Session();
    session.addToolResult("tool-img", "Image loaded.", [
      { data: "aGVsbG8=", mediaType: "image/jpeg", analysisMode: "quality_review" },
    ]);

    const msgs = session.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "tool-img" });
    const receipt = msgs[0].content[0];
    expect(receipt.type === "tool_result" ? receipt.images?.[0] : undefined).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mediaType: "image/jpeg",
      analysisMode: "quality_review",
    });
  });

  it("retains ordered tool images unchanged within the active turn until compaction", () => {
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
    const receipt = modelMessages[2].content[0];
    expect(receipt.type === "tool_result" ? receipt.images : undefined).toEqual([
      { type: "image", data: "desktop-preview", mediaType: "image/png" },
      { type: "image", data: "mobile-preview", mediaType: "image/png" },
    ]);

    const firstView = modelMessages;
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-fix",
      name: "edit_file",
      input: { path: "poster.html" },
    }]);
    modelMessages = session.getMessagesForModel();

    expect(modelMessages.slice(0, firstView.length)).toEqual(firstView);
    expect(modelMessages.flatMap((message) => message.content))
      .toContainEqual(expect.objectContaining({
        type: "tool_result",
        toolUseId: "call-preview",
        isError: true,
      }));
    session.addToolResult("call-fix", "fixed");
    session.applyActiveCheckpointSummary("Preview found mobile overflow; it was fixed.", 2);
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("desktop-preview");
  });

  it("elides active-turn tool images after two assistant rounds with a stable marker", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Iterate on the poster until it renders cleanly" }]);
    const capture = (round: number) => {
      session.addAssistantMessage([{ type: "tool_use", id: `shot-${round}`, name: "html_preview", input: { round } }]);
      session.addToolResult(`shot-${round}`, `capture ${round}`, [{ data: `img-${round}`, mediaType: "image/png" }]);
    };
    const imagesIn = (view: Message[]) => view.flatMap((m) => m.content).flatMap((c) => (
      c.type === "tool_result" ? (c.images ?? []).map((img) => img.data) : c.type === "image" ? [c.data] : []
    ));
    capture(1);
    capture(2);
    const twoRounds = session.getMessagesForModel();
    expect(imagesIn(twoRounds)).toEqual(["img-1", "img-2"]);
    const requestTokens = session.estimateModelTokens();
    const activeTokens = session.estimateActiveProcessTokens();

    capture(3);
    const threeRounds = session.getMessagesForModel();
    expect(imagesIn(threeRounds)).toEqual(["img-2", "img-3"]);
    // [user, A1, R1, A2, R2, A3, R3]: R1 has two assistant rounds after it.
    expect(threeRounds[2].content[0]).toEqual({
      type: "tool_result", toolUseId: "shot-1", images: [],
      content: `capture 1\n\n${ACTIVE_TURN_IMAGE_OMITTED_MARKER}`,
    });
    // Everything else the previous request carried is byte-identical.
    expect(threeRounds.slice(0, 2)).toEqual(twoRounds.slice(0, 2));
    expect(threeRounds.slice(3, twoRounds.length)).toEqual(twoRounds.slice(3));
    // One image entered, one left: the estimators do not grow by an image.
    expect(session.estimateModelTokens()).toBeLessThan(requestTokens + IMAGE_BLOCK_ESTIMATE_TOKENS);
    expect(session.estimateActiveProcessTokens()).toBeLessThan(activeTokens + IMAGE_BLOCK_ESTIMATE_TOKENS);

    // The elided receipt never changes again; the next round elides the next one.
    capture(4);
    const fourRounds = session.getMessagesForModel();
    expect(fourRounds[2]).toEqual(threeRounds[2]);
    expect(imagesIn(fourRounds)).toEqual(["img-3", "img-4"]);
    const changed = threeRounds.filter((message, index) => JSON.stringify(message) !== JSON.stringify(fourRounds[index]));
    expect(changed).toHaveLength(1);
    expect(changed[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "shot-2" });
  });

  it("keeps only the latest authoring references through intervening tools and checkpoints, then releases them", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Build from this reference" }]);
    const capture = (id: string, retention?: "active_turn", count = 1) => {
      session.addAssistantMessage([{ type: "tool_use", id, name: "fixture", input: {} }]);
      session.addToolResult(id, id, Array.from({ length: count }, (_, i) => ({ data: `${id}-pixel-${i}`, mediaType: "image/png" })), false, undefined, retention);
    };
    const images = () => session.getMessagesForModel().flatMap(m => m.content).flatMap(c =>
      c.type === "tool_result" ? c.images ?? [] : c.type === "image" ? [c] : []);
    capture("reference", "active_turn");
    capture("ordinary");
    for (const id of ["read", "list", "write"]) {
      session.addAssistantMessage([{ type: "tool_use", id, name: "fixture", input: {} }]);
      session.addToolResult(id, "Read source metadata. ".repeat(500));
    }
    expect(images().map(i => i.data)).toEqual(["reference-pixel-0"]);
    const tokens = session.estimateModelTokens();
    session.applyActiveCheckpointSummary("Ready to author", 8);
    expect(images().map(i => i.data)).toEqual(["reference-pixel-0"]);
    expect(session.estimateModelTokens()).toBeGreaterThan(IMAGE_BLOCK_ESTIMATE_TOKENS);
    expect(session.estimateModelTokens()).toBeLessThan(tokens);
    expect(session.estimateActiveProcessTokens()).toBeGreaterThan(IMAGE_BLOCK_ESTIMATE_TOKENS);
    capture("replacement", "active_turn", 8);
    expect(images().map(i => i.data)).toEqual(Array.from({ length: 6 }, (_, i) => `replacement-pixel-${i}`));
    capture("clear", "active_turn", 0);
    expect(images()).toEqual([]);
    capture("last-reference", "active_turn");
    session.completeActiveTurn();
    session.beginUserTurn([{ type: "text", text: "New task" }]);
    expect(images()).toEqual([]);
  });

  it("marks elided JSON receipts structurally and keeps tagged user images as input", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Compare viewports" }]);
    session.addAssistantMessage([
      { type: "tool_use", id: "desk", name: "html_preview", input: {} },
      { type: "tool_use", id: "mob", name: "html_preview", input: {} },
    ]);
    session.addToolResult("desk", JSON.stringify({ ok: true, viewport: "desktop" }), [{ data: "desk-1", mediaType: "image/png" }]);
    session.addToolResult("mob", JSON.stringify({ ok: true, viewport: "mobile" }), [{ data: "mob-1", mediaType: "image/png" }]);
    // A real mid-turn user image (tagged with the turn) is input, not a capture.
    session.addMessage("user", [{ type: "image", data: "user-reference", mediaType: "image/png" }]);
    for (const round of [2, 3]) {
      session.addAssistantMessage([{ type: "tool_use", id: `fix-${round}`, name: "edit_file", input: {} }]);
      session.addToolResult(`fix-${round}`, "edited");
    }
    const view = session.getMessagesForModel();
    const receipts = view.flatMap((m) => m.content).filter((c) => c.type === "tool_result" && c.toolUseId !== "fix-2" && c.toolUseId !== "fix-3");
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.type === "tool_result" ? receipt.images : undefined).toEqual([]);
      const parsed = JSON.parse(receipt.type === "tool_result" ? receipt.content : "{}") as Record<string, unknown>;
      expect(parsed.ok).toBe(true);
      expect(parsed._images_omitted).toBe(ACTIVE_TURN_IMAGE_OMITTED_MARKER);
    }
    expect(view.flatMap((m) => m.content)).toContainEqual({ type: "image", data: "user-reference", mediaType: "image/png" });
    // History is untouched: the raw receipts still own their images.
    expect(JSON.stringify(session.getMessages())).toContain("desk-1");
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

  it("keeps a legacy untracked tool image with its receipt", () => {
    const session = new Session();
    session.addAssistantMessage([{ type: "tool_use", id: "call-read", name: "read_file", input: { path: "/tmp/frame.png" } }]);
    session.addToolResult("call-read", '<file path="/tmp/frame.png" kind="image"/> Image loaded.', [
      { data: "frame-bytes", mediaType: "image/jpeg" },
    ]);

    let modelMessages = session.getMessagesForModel();
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[1].content[0]).toMatchObject({ images: [
      { type: "image", data: "frame-bytes", mediaType: "image/jpeg" },
    ] });

    session.addAssistantMessage([{ type: "tool_use", id: "call-next", name: "bash", input: { command: "echo ok" } }]);
    modelMessages = session.getMessagesForModel();

    expect(session.getMessages()).toHaveLength(3);
    expect(JSON.stringify(modelMessages[1])).toContain("frame-bytes");
    expect(modelMessages).toHaveLength(3);
    expect(modelMessages.flatMap((m) => m.content).some((c) => c.type === "image")).toBe(false);
    expect(modelMessages[1].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-read",
      content: expect.stringContaining("/tmp/frame.png"),
    });
  });

  it("keeps old large tool results verbatim in the model view", () => {
    const session = new Session();
    const raw = "0123456789" + "x".repeat(2_000) + "TAIL!";

    session.addAssistantMessage([{ type: "tool_use", id: "call-old", name: "bash", input: { command: "big" } }]);
    session.addToolResult("call-old", raw, undefined, false);
    session.addAssistantMessage([{ type: "text", text: "I saw the output." }]);

    const modelResult = session.getMessagesForModel()[1].content[0];
    expect(modelResult.type).toBe("tool_result");
    expect((modelResult as { content: string }).content).toBe(raw);
    expect((modelResult as { content: string }).content).not.toContain("<compacted-tool-result");
  });

  it("keeps old tool_use inputs verbatim in the model view", () => {
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

    const serialized = JSON.stringify(toolUses.map((u) => u.input));
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

    expect(JSON.stringify(view[0])).toContain("not a full execution transcript");
    expect(view.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(flat.some((c) => c.type === "tool_use")).toBe(false);
    expect(flat.some((c) => c.type === "tool_result")).toBe(false);
    expect(JSON.stringify(view)).toContain("First task");
    expect(JSON.stringify(view)).toContain("First final answer");
    expect(JSON.stringify(view)).toContain("Second task");
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
    expect(view).not.toContain("History retained facts");
    expect(view).not.toContain("Private runtime context for task continuation only.");
    expect(view).not.toContain("release_id=rel-123");
    expect(view).not.toContain("checksum=sha256:abc");
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

    expect(session.getSerializedContextState()!.historyExactFacts).toEqual(["text_sha256=history-new"]);
  });

  it("retains the newest facts when the token budget is full", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Remember a bounded fact set" }]);
    session.addAssistantMessage([{ type: "text", text: "Recorded." }]);
    session.completeActiveTurn();
    // ~10 estimated tokens per fact; 700 of them overshoot the 6,000-token
    // budget by ~17%, so the oldest hundred-odd must go while everything
    // newer survives — including far more than the old 128-item cap allowed.
    const factOf = (index: number) => `fact-${String(index).padStart(4, "0")}-${"x".repeat(28)}`;
    const state = session.getSerializedContextState()!;
    state.historyExactFacts = Array.from({ length: 700 }, (_, index) => factOf(index));
    session.restoreContextState(state);

    session.applyHistorySummary(
      `Updated summary\n\n${HISTORY_EXACT_FACTS_HEADING}\n- newest-fact`,
      [1],
    );

    const facts = session.getSerializedContextState()!.historyExactFacts!;
    const totalTokens = facts.reduce((sum, item) => sum + estimateTextTokens(item), 0);
    expect(totalTokens).toBeLessThanOrEqual(HISTORY_EXACT_FACTS_MAX_TOKENS);
    // The count cap is gone: short facts retain well past the old 128 line.
    expect(facts.length).toBeGreaterThan(128);
    expect(facts.length).toBeLessThan(700);
    expect(facts).not.toContain(factOf(0));
    expect(facts.at(-1)).toBe("newest-fact");
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).not.toContain("host-persisted model extraction");
    expect(view).not.toContain("deterministic host state, not a summary");
  });

  // The budget is denominated in tokens, not characters, so languages pay the
  // same price: a CJK pool retains fewer ITEMS than an ASCII pool of equal
  // per-item character length, but both stop at the same token spend. Under
  // the old char budget the same two pools were priced 2-4x apart.
  it("prices the facts budget equally across languages", () => {
    const fill = (item: (index: number) => string) => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "fairness" }]);
      session.addAssistantMessage([{ type: "text", text: "ok" }]);
      session.completeActiveTurn();
      const state = session.getSerializedContextState()!;
      state.historyExactFacts = Array.from({ length: 900 }, (_, index) => item(index));
      session.restoreContextState(state);
      session.applyHistorySummary(
        `S\n\n${HISTORY_EXACT_FACTS_HEADING}\n- probe`,
        [1],
      );
      const facts = session.getSerializedContextState()!.historyExactFacts!;
      return {
        count: facts.length,
        tokens: facts.reduce((sum, f) => sum + estimateTextTokens(f), 0),
      };
    };
    const ascii = fill((index) => `a${String(index).padStart(4, "0")}-${"x".repeat(25)}`);
    const cjk = fill((index) => `汉${String(index).padStart(4, "0")}-${"字".repeat(25)}`);
    expect(ascii.tokens).toBeLessThanOrEqual(HISTORY_EXACT_FACTS_MAX_TOKENS);
    expect(cjk.tokens).toBeLessThanOrEqual(HISTORY_EXACT_FACTS_MAX_TOKENS);
    // Equal token spend, different item counts — that asymmetry is the point.
    expect(cjk.count).toBeLessThan(ascii.count);
    expect(ascii.tokens).toBeGreaterThan(HISTORY_EXACT_FACTS_MAX_TOKENS * 0.8);
    expect(cjk.tokens).toBeGreaterThan(HISTORY_EXACT_FACTS_MAX_TOKENS * 0.8);
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

  it("does not promote active checkpoint facts into default history", () => {
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
    expect(view).not.toContain("History retained facts");
    expect(view).not.toContain("build_id=build-789");
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

  it.each([
    { shape: "oversized latest result", sizes: [100_000, 80, 168_000] },
    { shape: "oversized result before a small tail", sizes: [100_000, 80, 168_000, 800] },
    { shape: "combined tail exceeds retention budget", sizes: [100_000, 80, 24_000, 24_000, 24_000] },
  ])("accounts for every tool result across compaction: $shape", ({ sizes }) => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Use the inspected evidence to finish the repair" }]);
    const receipts: Array<{ id: string; marker: string }> = [];
    sizes.forEach((size, group) => {
      // The small middle group includes parallel success/error receipts. Losing
      // either can hide a prerequisite or failed verification from the next step.
      const calls = Array.from({ length: group === 1 ? 2 : 1 }, (_, part) => ({
        id: `read-${group}-${part}`, marker: `EVIDENCE_${group}_${part}`,
      }));
      receipts.push(...calls);
      session.addAssistantMessage(calls.map(({ id }) => ({
        type: "tool_use" as const, id, name: "read_files", input: {},
      })));
      for (const { id, marker } of calls) {
        session.addToolResult(id, `${marker}\n${"x".repeat(size)}`, undefined, id.endsWith("-1"));
      }
    });

    // A budget whose active trigger is ~37K and retention ~16.7K: the three
    // 6K-token tail results of the last shape together exceed retention, which
    // is the accounting case under test. Room is 2 × trigger by derivation.
    const candidate = session.getPendingActiveCheckpoint(contextBudget({
      usableInputTokens: 141_952, requestCeilingTokens: 74_200 + 18_286, fixedOverheadTokens: 18_286,
    }));
    expect(candidate).not.toBeNull();
    const summaryInput = JSON.stringify(candidate!.messages);
    session.applyActiveCheckpointSummary("Earlier observations summarized", candidate!.checkpointThroughMessageIndex);
    const parts = session.getMessagesForModel().flatMap((message) => message.content);
    const results = parts.filter((part) => part.type === "tool_result");
    const uses = parts.filter((part) => part.type === "tool_use");

    // Independent coverage oracle: each unique source fact has exactly one
    // route forward, regardless of which groups the selection algorithm chose.
    for (const { id, marker } of receipts) {
      const raw = results.find((part) => part.toolUseId === id);
      const routes = Number(summaryInput.includes(marker)) + Number(raw?.content.includes(marker) ?? false);
      expect(routes, `${marker} must be summarized or retained, never lost or duplicated`).toBe(1);
    }
    expect(results.map((part) => part.toolUseId).sort()).toEqual(uses.map((part) => part.id).sort());
    if (sizes.at(-1)! <= 24_000) {
      expect(results.some((part) => part.toolUseId === `read-${sizes.length - 1}-0`)).toBe(true);
    }
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

  // A round of parallel tool calls is one tool step group. The single-step
  // retention cap used to apply to the whole group, so a batch of ten
  // ordinary reads — each small enough for the admission ceiling to inline —
  // could never be kept verbatim: the checkpoint archived all of them and the
  // model continued from a summary alone (seen on every probe run with a
  // model that batches reads). The cap is per result, like admission.
  it("retains a parallel tool round whose results each fit the single-step cap", () => {
    const budget = {
      ...DEFAULT_CONTEXT_BUDGET,
      activeProcessTrigger: 50_000,
      activeRetainTokens: 45_000,
      activeSingleStepMaxTokens: 8_000,
    };
    const build = (largestParallelResultChars: number) => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "survey the service documents" }]);
      // An older, oversized single result: never retainable, always archived.
      session.addAssistantMessage([{ type: "tool_use", id: "old", name: "read_doc", input: { name: "old" } }]);
      session.addToolResult("old", `OLD ${"o".repeat(80_000)}`, undefined, false);
      // A parallel round of ten reads, ~4K tokens each, ~40K as a group.
      const ids = Array.from({ length: 10 }, (_, i) => `par-${i}`);
      session.addAssistantMessage(ids.map((id) => ({ type: "tool_use" as const, id, name: "read_doc", input: { name: id } })));
      ids.forEach((id, i) => session.addToolResult(id, `${id} ${"p".repeat(i === 0 ? largestParallelResultChars : 16_000)}`, undefined, false));
      return session;
    };

    const parallel = build(16_000);
    const candidate = parallel.getPendingActiveCheckpoint(budget);
    expect(candidate).not.toBeNull();
    // Only the oversized old step is archived; the round survives verbatim.
    expect(candidate!.groups).toHaveLength(1);
    expect(candidate!.groups[0].largestResultTokens).toBeGreaterThan(budget.activeSingleStepMaxTokens);
    parallel.applyActiveCheckpointSummary("old result summarized", candidate!.checkpointThroughMessageIndex);
    const view = JSON.stringify(parallel.getMessagesForModel());
    for (let i = 0; i < 10; i++) expect(view).toContain(`par-${i} pppp`);
    expect(view).not.toContain("OLD oooo");

    // The newest round stays raw even when a sibling exceeds the cap. Once a
    // later round exists, ordinary size-based selection may archive it whole.
    const oversized = build(48_000);
    expect(oversized.getPendingActiveCheckpoint(budget)!.groups).toHaveLength(1);
    oversized.addAssistantMessage([{ type: "tool_use", id: "next", name: "read_doc", input: {} }]);
    oversized.addToolResult("next", "latest observation");
    const both = oversized.getPendingActiveCheckpoint(budget);
    expect(both).not.toBeNull();
    expect(both!.groups).toHaveLength(2);
  });

  it("keeps middle facts in complete checkpoint groups without mutating raw tool data", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Implement the requirements from the inspected files" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{
        type: "tool_use",
        id: `projection-${i}`,
        name: "read_files",
        input: { paths: [`/workspace/source-${i}.txt`], note: `INPUT_${"i".repeat(6_000)}_${i}` },
      }]);
      const isError = i === 1;
      session.addToolResult(
        `projection-${i}`,
        [
          `${isError ? "ERROR" : "RESULT"}_HEAD_${i}`,
          (isError ? "e" : "r").repeat(7_000),
          `REQUIRED_MIDDLE_FACT_${i}=present`,
          (isError ? "e" : "r").repeat(7_000),
          `${isError ? "ERROR" : "RESULT"}_TAIL_${i}`,
        ].join("\n"),
        undefined,
        isError,
      );
    }

    const rawBefore = JSON.stringify(session.getMessages());
    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate?.groups.length).toBeGreaterThanOrEqual(3);
    const checkpointInput = JSON.stringify(candidate?.messages || []);

    expect(checkpointInput).toContain("/workspace/source-0.txt");
    expect(checkpointInput).toContain("i".repeat(5_000));
    expect(checkpointInput).toContain("RESULT_HEAD_0");
    expect(checkpointInput).toContain("REQUIRED_MIDDLE_FACT_0=present");
    expect(checkpointInput).toContain("RESULT_TAIL_0");
    expect(checkpointInput).toContain("ERROR_HEAD_1");
    expect(checkpointInput).toContain("REQUIRED_MIDDLE_FACT_1=present");
    expect(checkpointInput).toContain("ERROR_TAIL_1");
    expect(checkpointInput).not.toContain("chars omitted]");
    expect(rawBefore).toContain("i".repeat(5_000));
    expect(rawBefore).toContain("r".repeat(6_000));
    expect(rawBefore).toContain("e".repeat(6_000));
    expect(JSON.stringify(session.getMessages())).toBe(rawBefore);
  });

  it("fits the largest oldest prefix of complete groups within checkpoint input capacity", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Use every complete observation" }]);
    for (let i = 0; i < 6; i++) {
      session.addAssistantMessage([{
        type: "tool_use",
        id: `capacity-${i}`,
        name: "read_files",
        input: { paths: [`/workspace/capacity-${i}.txt`] },
      }]);
      session.addToolResult(
        `capacity-${i}`,
        `HEAD_${i}\n${"x".repeat(20_000)}\nMIDDLE_${i}=kept\n${"y".repeat(20_000)}\nTAIL_${i}`,
      );
    }

    const unbounded = session.getPendingActiveCheckpoint()!;
    expect(unbounded.groups).toHaveLength(5);
    expect(JSON.stringify(unbounded.messages)).not.toContain("MIDDLE_5=kept");
    const selection = session.selectPendingActiveCheckpoint(undefined, 22_000);
    const bounded = selection.candidate!;
    const input = JSON.stringify(bounded.messages);

    expect(selection.capacityIssue).toBeUndefined();
    expect(bounded.capacityLimited).toBe(true);
    expect(bounded.inputTokenBudget).toBe(22_000);
    expect(bounded.inputTokens).toBeLessThanOrEqual(22_000);
    expect(bounded.groups).toHaveLength(2);
    for (const i of [0, 1]) {
      expect(input).toContain(`HEAD_${i}`);
      expect(input).toContain(`MIDDLE_${i}=kept`);
      expect(input).toContain(`TAIL_${i}`);
    }
    expect(input).not.toContain("MIDDLE_2=kept");

    session.applyActiveCheckpointSummary("First two groups summarized", bounded.checkpointThroughMessageIndex);
    const retained = JSON.stringify(session.getMessagesForModel());
    expect(retained).toContain("MIDDLE_2=kept");
    expect(retained).not.toContain("MIDDLE_0=kept");
  });

  it("admits complete bounded checkpoint groups after the trigger without a minimum savings gate", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Preserve every source decision" }]);
    const usable = 1_048_576 - 8_192;
    const budget = contextBudget({ usableInputTokens: usable, requestCeilingTokens: Math.floor(usable * 0.82), fixedOverheadTokens: 30_000, historyOccupancyTokens: 0 });
    const addGroup = (i: number) => {
      session.addAssistantMessage([{ type: "tool_use", id: `bounded-${i}`, name: "read_files", input: {} }]);
      session.addToolResult(`bounded-${i}`, `FACT_${i}=kept\n${"x".repeat(180_000)}`);
    };
    for (let i = 0; i < 10; i++) addGroup(i);
    expect(session.selectPendingActiveCheckpoint(budget, 150_000).candidate).toBeNull();
    for (let i = 10; i < 18; i++) addGroup(i);
    const selection = session.selectPendingActiveCheckpoint(budget, 150_000);
    expect(selection.capacityIssue).toBeUndefined();
    expect(selection.candidate).not.toBeNull();
    const candidate = selection.candidate!;
    expect(candidate.capacityLimited).toBe(true);
    expect(candidate.groups).toHaveLength(3);
    expect(candidate.inputTokens).toBeLessThanOrEqual(150_000);
    expect(candidate.tokensBefore - candidate.estimatedTokensAfter).toBeLessThan(135_000);
    session.applyActiveCheckpointSummary("FACT_0=kept\nFACT_1=kept\nFACT_2=kept", candidate.checkpointThroughMessageIndex);
    const view = JSON.stringify(session.getMessagesForModel());
    for (let i = 0; i < 18; i++) expect(view).toContain(`FACT_${i}=kept`);
    expect(view).toContain("x".repeat(10_000));
  });

  it("clips only an oversized first group's summary input without mutating raw data", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Preserve the complete source" }]);
    for (let i = 0; i < 3; i++) {
      session.addAssistantMessage([{
        type: "tool_use", id: `blocked-${i}`, name: "read_files", input: { paths: [`source-${i}`] },
      }]);
      session.addToolResult(
        `blocked-${i}`,
        `HEAD_${i}\n${"x".repeat(30_000)}\nMIDDLE_${i}=required\n${"y".repeat(30_000)}\nTAIL_${i}`,
      );
    }
    const rawBefore = JSON.stringify(session.getMessages());
    const selection = session.selectPendingActiveCheckpoint(undefined, 1_000);

    expect(selection.capacityIssue).toBeUndefined();
    const candidate = selection.candidate!;
    expect(candidate.groups).toHaveLength(1);
    expect(candidate.capacityLimited).toBe(true);
    expect(candidate.inputTokens).toBeLessThanOrEqual(1_000);
    const text = JSON.stringify(candidate.messages);
    expect(text).toContain("HEAD_0");
    expect(text).toContain("TAIL_0");
    expect(text).toContain("chars omitted");
    expect(text).not.toContain("MIDDLE_0=required");
    expect(JSON.stringify(session.getMessages())).toBe(rawBefore);
    expect(JSON.stringify(session.getMessagesForModel())).toContain("MIDDLE_0=required");

    // Even identifiers, status and omission markers cannot fit: fail closed.
    const impossible = session.selectPendingActiveCheckpoint(undefined, 1);
    expect(impossible.candidate).toBeNull();
    expect(impossible.capacityIssue).toMatchObject({
      reason: "no_complete_group_fits",
      inputTokenBudget: 1,
      eligibleGroups: 2,
      selectedGroups: 0,
    });
    expect(impossible.capacityIssue!.firstGroupInputTokens).toBeGreaterThan(1_000);
    expect(JSON.stringify(session.getMessages())).toBe(rawBefore);
    expect(JSON.stringify(session.getMessagesForModel())).toContain("MIDDLE_0=required");
  });

  it.each(["ascii", "cjk", "digits"])("fits a 200K parallel group with its prior checkpoint (%s)", (shape) => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Compare all parallel observations" }]);
    session.applyActiveCheckpointSummary("PRIOR_DECISION\n" + "p".repeat(40_000), 0);
    const ids = Array.from({ length: 8 }, (_, i) => `parallel-${i}`);
    session.addAssistantMessage(ids.map((id) => ({ type: "tool_use" as const, id,
      name: "read_files", input: { path: `/workspace/${id}.md` } })));
    const body = shape === "cjk" ? "中".repeat(16_666)
      : shape === "digits" ? "123456789".repeat(8_333) : "x".repeat(100_000);
    for (const id of ids) session.addToolResult(id, `HEAD_${id}\n${body}\nTAIL_${id}`, undefined, id === ids[3]);
    // A newer group is outside this checkpoint and must remain raw.
    session.addAssistantMessage([{ type: "tool_use", id: "newer", name: "read_files", input: {} }]);
    session.addToolResult("newer", "NEWER_RAW");
    const rawBefore = JSON.stringify(session.getMessages());
    const candidate = session.selectPendingActiveCheckpoint(undefined, 150_000).candidate!;
    expect(candidate.groups).toHaveLength(1);
    expect(candidate.capacityLimited).toBe(true);
    const text = candidate.messages.flatMap(m => m.content).map(c => c.type === "text" ? c.text : "").join("");
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(150_000);
    expect(text).toContain("PRIOR_DECISION\n" + "p".repeat(40_000));
    for (const id of ids) {
      expect(text).toContain(`tool_use read_files id=${id}`);
      expect(text).toContain(`/workspace/${id}.md`);
      expect(text).toContain(`HEAD_${id}`);
      expect(text).toContain(`TAIL_${id}`);
    }
    expect(text).toContain("tool_result id=parallel-3 error=true");
    expect(text).toContain("chars omitted");
    expect(JSON.stringify(session.getMessages())).toBe(rawBefore);
    session.applyActiveCheckpointSummary("CHECKPOINT_OK", candidate.checkpointThroughMessageIndex);
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("CHECKPOINT_OK");
    expect(view).toContain("NEWER_RAW");
    expect(view).not.toContain("HEAD_parallel-");
  });

  it("preserves small sibling results and host result refs when giant arguments also need clipping", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Continue every inspected operation" }]);
    session.addAssistantMessage([
      { type: "tool_use", id: "giant", name: "transform", input: { source: "ARG_HEAD" + "a".repeat(800_000) + "ARG_TAIL" } },
      { type: "tool_use", id: "small", name: "inspect", input: { path: "/workspace/small" } },
    ]);
    session.addToolResult("giant", "RESULT_HEAD" + "x".repeat(800_000) + "RESULT_TAIL");
    session.addToolResult("small", "SMALL_COMPLETE: exact failure", undefined, true);
    session.recordCompletedWork({ toolCallId: "giant", tool: "transform", inputDigest: "digest", inputSummary: "large source",
      status: "succeeded", resultRef: "result-trusted-ref" });
    session.addAssistantMessage([{ type: "tool_use", id: "next", name: "inspect", input: {} }]);
    session.addToolResult("next", "LATEST_RAW");
    const rawBefore = JSON.stringify(session.getMessages());
    const candidate = session.selectPendingActiveCheckpoint(undefined, 150_000).candidate!;
    const text = candidate.messages.flatMap(m => m.content).map(c => c.type === "text" ? c.text : "").join("");
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(150_000);
    for (const fact of ["ARG_HEAD", "ARG_TAIL", "RESULT_HEAD", "RESULT_TAIL", "SMALL_COMPLETE: exact failure", "/workspace/small", "tool_result id=small error=true", "Full content is stored under result ref result-trusted-ref"]) expect(text).toContain(fact);
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

  it("keeps a completed structured summary unchanged below the Host ceiling", () => {
    const summary = [
      "Important observations and decisions:",
      "- keep the chosen architecture",
      "",
      ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING,
      "- release_id=rel-7",
      "",
      "Open issues and next actions:",
      "- run the focused tests",
    ].join("\n");

    expect(boundStructuredSummaryTokens(
      summary,
      CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS,
    )).toBe(summary);
  });

  it("bounds an oversized completed summary by whole entries and preserves critical sections", () => {
    const summary = [
      "Important observations and decisions:",
      ...Array.from({ length: 80 }, (_, index) => `- observation-${index} ${"o".repeat(120)}`),
      ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING,
      "- release_id=rel-critical",
      "- checksum=sha256:critical",
      "External source/result takeaways still needed:",
      ...Array.from({ length: 60 }, (_, index) => `- source-${index} ${"s".repeat(120)}`),
      "Open issues and next actions:",
      "- deploy only after the approval gate",
      "Exact data that must be re-read before editing/quoting:",
      "- /workspace/report.log lines 20-40",
    ].join("\n");

    const bounded = boundStructuredSummaryTokens(
      summary,
      CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS,
    );

    expect(estimateTextTokens(summary)).toBeGreaterThan(CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS);
    expect(estimateTextTokens(bounded)).toBeLessThanOrEqual(CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS);
    expect(bounded).toContain(ACTIVE_CHECKPOINT_EXACT_FACTS_HEADING);
    expect(bounded).toContain("release_id=rel-critical");
    expect(bounded).toContain("deploy only after the approval gate");
    expect(bounded).toContain("/workspace/report.log lines 20-40");
    expect(bounded).toContain("additional entries omitted by Host storage bound");
    expect(bounded).not.toMatch(/observation-\d+\s+o{1,119}$/m);
  });

  it("never turns oversized unstructured provider text into an empty checkpoint", () => {
    const summary = "unstructured evidence ".repeat(12_000);
    const bounded = boundStructuredSummaryTokens(
      summary,
      CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS,
    );

    expect(bounded).not.toBe("");
    expect(estimateTextTokens(bounded)).toBeLessThanOrEqual(CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS);
    expect(bounded).toMatch(/^unstructured evidence/);
    expect(bounded).toContain("Summary truncated by Host storage bound");
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
    expect(retainedSteps).toBeLessThanOrEqual(Math.ceil(DEFAULT_CONTEXT_BUDGET.activeRetainTokens / (STEP_CHARS / 4)));

    // The budget bound still holds where it matters: applying the checkpoint
    // must drop the live tail below the trigger so it cannot immediately refire.
    session.applyActiveCheckpointSummary("Older small steps summarized", candidate!.checkpointThroughMessageIndex);
    expect(session.estimateActiveProcessTokens()).toBeLessThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);
    expect(session.getPendingActiveCheckpoint()).toBeNull();
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
    const at = (usableInputTokens: number) => contextBudget({
      usableInputTokens, requestCeilingTokens: Math.floor(usableInputTokens * 0.82), fixedOverheadTokens: 30_000,
    });
    const wide = at(1_000_000);
    const narrow = at(60_000);
    const tooSmall = at(21_760);

    // ~20K tokens of live tool traffic: past the narrow window's trigger, well
    // inside the wide one's.
    expect(build().getPendingActiveCheckpoint(wide)).toBeNull();
    expect(build().getPendingActiveCheckpoint(narrow)).toBeTruthy();
    // A window with no room for a layered budget behind a 30K prompt does not
    // fire a summarization call it cannot benefit from; the emergency layer
    // owns that window.
    expect(tooSmall.windowTooSmall).toBe(true);
    expect(build().getPendingActiveCheckpoint(tooSmall)).toBeNull();
  });

  // 2026-08-16 latency review P1-5: the estimator weighs CJK at 1.5 tok/char
  // against real tokenizers' ~0.6-1.0, so Chinese-heavy sessions crossed the
  // segment triggers 1.5-2.5x early — each early fire is one extra 29-105s
  // summarization call. Anchored calls observe the real/estimated ratio of the
  // previous request; the trigger comparisons scale by it.
  it("reports history occupancy in the units the history trigger is compared in", () => {
    const session = new Session();
    for (let i = 0; i < 4; i++) {
      session.beginUserTurn([{ type: "text", text: `question ${i} ${"detail ".repeat(200)}` }]);
      session.addAssistantMessage([{ type: "text", text: `answer ${i} ${"detail ".repeat(200)}` }]);
      session.completeActiveTurn();
    }
    const raw = session.estimateHistoryTokens();
    expect(raw).toBeGreaterThan(0);
    expect(session.estimateCalibratedHistoryTokens()).toBe(raw);
    session.setEstimatorCalibration(1_000, 2_000);
    expect(session.estimateCalibratedHistoryTokens()).toBe(raw * 0.5);
  });

  it("anchored calibration defers the active-checkpoint trigger, and heavier traffic still fires it", () => {
    const build = (steps: number) => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Calibrated task" }]);
      for (let i = 0; i < steps; i++) {
        session.addAssistantMessage([{ type: "tool_use", id: `k-${i}`, name: "bash", input: { command: `c-${i}` } }]);
        session.addToolResult(`k-${i}`, `out-${i}\n${"x".repeat(8_000)}`, undefined, false);
      }
      return session;
    };

    // Baseline: ~20K estimated tokens of live tool traffic crosses the 18K
    // default trigger.
    expect(build(10).getPendingActiveCheckpoint()).toBeTruthy();

    // Provider truth says the estimate runs 2x hot: the same traffic defers...
    const calibrated = build(10);
    calibrated.setEstimatorCalibration(1_000, 2_000);
    expect(calibrated.getEstimatorCalibration()).toBe(0.5);
    expect(calibrated.getPendingActiveCheckpoint()).toBeNull();

    // ...but calibration only defers — heavier traffic fires even at 0.5.
    const heavier = build(22);
    heavier.setEstimatorCalibration(1_000, 2_000);
    expect(heavier.getPendingActiveCheckpoint()).toBeTruthy();
  });

  it("clamps calibration to [0.5, 1], ignores unusable observations, and resets on clear", () => {
    const session = new Session();
    expect(session.getEstimatorCalibration()).toBe(1);

    session.setEstimatorCalibration(7, 10);
    expect(session.getEstimatorCalibration()).toBe(0.7);

    // Unusable observations keep the last known ratio rather than resetting it.
    session.setEstimatorCalibration(0, 10);
    session.setEstimatorCalibration(10, 0);
    session.setEstimatorCalibration(Number.NaN, 10);
    expect(session.getEstimatorCalibration()).toBe(0.7);

    // Correction is capped at 2x…
    session.setEstimatorCalibration(1, 10);
    expect(session.getEstimatorCalibration()).toBe(0.5);
    // …and under-estimation is never "corrected" into earlier firing.
    session.setEstimatorCalibration(30, 10);
    expect(session.getEstimatorCalibration()).toBe(1);

    session.setEstimatorCalibration(6, 10);
    session.clear();
    expect(session.getEstimatorCalibration()).toBe(1);
  });

  it.each(["checkpoint", "emergency"] as const)("protects the latest parallel tool round during %s reduction regardless of size", (mode) => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect all returned evidence before proceeding" }]);
    const newest = ["fresh-success", "fresh-error"];
    session.addAssistantMessage(newest.map(id => ({ type: "tool_use" as const, id, name: "inspect", input: {} })));
    newest.forEach((id, i) => session.addToolResult(id, `${id}\n${"x".repeat(16_000)}`, undefined, i === 1));
    const budget = { ...DEFAULT_CONTEXT_BUDGET, activeProcessTrigger: 1_000,
      activeRetainTokens: 1_000, activeSingleStepMaxTokens: 1_000 };
    const select = () => mode === "checkpoint"
      ? session.getPendingActiveCheckpoint(budget) : session.getFoldableActiveProcess();
    // Neither a repeated preparation nor a later assistant text proves another
    // tool round exists. A single returned batch must never be reduced.
    expect(select()).toBeNull();
    session.addAssistantMessage([{ type: "text", text: "Inspecting the returned batch" }]);
    expect(select()).toBeNull();
    const protectedResults = session.getMessagesForModel().flatMap(m => m.content).filter(c => c.type === "tool_result");
    expect(protectedResults.map(c => c.toolUseId)).toEqual(newest);

    // A subsequent round makes the older batch eligible while protecting the
    // new oversized result even though it exceeds the entire retain budget.
    session.addAssistantMessage([{ type: "tool_use", id: "newest", name: "inspect", input: {} }]);
    session.addToolResult("newest", `LATEST_EXACT\n${"y".repeat(20_000)}`);
    const candidate = select()!;
    expect(candidate).not.toBeNull();
    if (mode === "checkpoint") expect(JSON.stringify(session.getPendingActiveCheckpoint(budget)!.messages)).not.toContain("LATEST_EXACT");
    session.applyEmergencyActiveFold("Earlier evidence reduced", candidate.checkpointThroughMessageIndex);
    const visible = session.getMessagesForModel().flatMap(m => m.content);
    expect(visible.filter(c => c.type === "tool_use").map(c => c.id)).toEqual(["newest"]);
    expect(visible.filter(c => c.type === "tool_result")).toEqual([
      expect.objectContaining({ toolUseId: "newest", content: `LATEST_EXACT\n${"y".repeat(20_000)}` }),
    ]);
    expect(select()).toBeNull();
  });

  // Used by the emergency path, which runs when summarization is unavailable
  // while the latest round still needs its first delivery to the main model.
  it("offers older tool steps for emergency folding while protecting the latest whole round", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Emergency task" }]);
    expect(session.getFoldableActiveProcess()).toBeNull();

    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `e-${i}`, name: "bash", input: { cmd: `c-${i}` } }]);
      session.addToolResult(`e-${i}`, `out-${i}\n${"y".repeat(3_000)}`, undefined, false);
    }

    const foldable = session.getFoldableActiveProcess()!;
    // Older rounds can be dropped; the latest round remains protected.
    expect(foldable.groups).toHaveLength(4);
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

    // Older payloads are gone; the latest result stays raw beside the notice.
    const serialized = JSON.stringify(view);
    for (let i = 0; i < 4; i++) expect(serialized).not.toContain(`out-${i}`);
    expect(serialized).toContain("out-4");
    expect(serialized).toContain("y".repeat(3_000));
    expect(serialized).toContain("reduced without summarization");

    // Repeated pressure cannot remove the protected round either.
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

  it("active checkpoint trigger tracks only the live tail, not cumulative raw", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Current large task" }]);
    for (let i = 0; i < 5; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: `cmd-${i}` } }]);
      session.addToolResult(`call-${i}`, `result-${i}\n${"x".repeat(15_000)}`, undefined, false);
    }
    // Before any checkpoint the whole raw process is counted → trigger is hot.
    const rawBefore = session.estimateActiveProcessTokens();
    expect(rawBefore).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);

    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).toBeTruthy();
    session.applyActiveCheckpointSummary("Older tool work summarized", candidate!.checkpointThroughMessageIndex);

    // After the older groups are folded into the summary the estimate reflects
    // only the retained tail (+summary), so it drops well below the trigger and
    // the checkpoint does not immediately re-fire (this is the fix: previously the
    // estimate stayed at the cumulative raw size and kept the trigger hot).
    const liveAfter = session.estimateActiveProcessTokens();
    expect(liveAfter).toBeLessThan(rawBefore);
    expect(liveAfter).toBeLessThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);
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

  // Image blocks cost real tokens (provider caps sit around 1,600 per image)
  // but the estimator priced them at zero, so image-heavy turns — frame
  // screenshots from browser/video tools — were invisible to every derived
  // trigger and budget until the provider refused the request.
  it("prices image blocks instead of estimating them at zero", () => {
    const textOnly = new Session();
    textOnly.addUserMessage("inspect the frames");
    const withImages = new Session();
    withImages.addMessage("user", [
      { type: "text", text: "inspect the frames" },
      { type: "image", data: "aW1n", mediaType: "image/png" },
      { type: "image", data: "aW1n", mediaType: "image/png" },
    ]);
    expect(withImages.estimateTokens() - textOnly.estimateTokens())
      .toBe(2 * IMAGE_BLOCK_ESTIMATE_TOKENS);
  });

  it("image-heavy tool steps reach the active checkpoint trigger while their images are resident", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "render the video frames" }]);
    // 14 captures in one round: ~22K estimated tokens of images against the
    // 18K default trigger. With images priced at zero this turn estimated as a
    // few hundred tokens and never produced a checkpoint candidate while the
    // real request kept growing.
    session.addAssistantMessage(Array.from({ length: 14 }, (_, i) => (
      { type: "tool_use" as const, id: `frame-${i}`, name: "screenshot", input: { frame: i } }
    )));
    for (let i = 0; i < 14; i++) {
      session.addToolResult(`frame-${i}`, `frame ${i} captured`, [{ data: "aW1n", mediaType: "image/png" }]);
    }
    expect(session.estimateActiveProcessTokens()).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);
    expect(session.getPendingActiveCheckpoint()).toBeNull();
    // The image batch contributes pressure immediately but becomes eligible
    // only when a subsequent tool round exists, before image aging elides it.
    session.addAssistantMessage([{ type: "tool_use", id: "next", name: "inspect", input: {} }]);
    session.addToolResult("next", "LATEST_RAW");
    const candidate = session.getPendingActiveCheckpoint();
    expect(candidate).not.toBeNull();
    expect(candidate!.tokensBefore).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET.activeProcessTrigger);
  });

  it("does not let elided captures from earlier rounds inflate the checkpoint trigger", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "render the video frames" }]);
    // The same 14 captures one round at a time: only the newest two rounds keep
    // their image bytes, so the trigger tracks what the request actually carries.
    for (let i = 0; i < 14; i++) {
      session.addAssistantMessage([{ type: "tool_use", id: `frame-${i}`, name: "screenshot", input: { frame: i } }]);
      session.addToolResult(`frame-${i}`, `frame ${i} captured`, [{ data: "aW1n", mediaType: "image/png" }]);
    }
    expect(session.estimateActiveProcessTokens()).toBeLessThan(3 * IMAGE_BLOCK_ESTIMATE_TOKENS);
    expect(session.getPendingActiveCheckpoint()).toBeNull();
  });

  // Persistent-block shrink: the overflow-recovery lever for the one part of
  // the projection no compaction layer can reduce. REPLACE semantics are the
  // point — a merge would keep every prior fact and re-grow what the shrink
  // removed.
  // A hot history trigger admits eligible turns even when the retained tail
  // leaves only one small turn to archive.

  it("persistent-block shrink declines small blocks and empty rewrites", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "short project" }]);
    session.addAssistantMessage([{ type: "text", text: "ack" }]);
    session.completeActiveTurn();
    session.applyHistorySummary(`Small summary.\n${HISTORY_EXACT_FACTS_HEADING}\n- one_fact: ok`, [1]);

    // Well under the threshold: not worth a rewrite call.
    expect(session.getPersistentBlockShrinkCandidate()).toBeNull();

    // An empty rewrite must not wipe the blocks.
    const epochBefore = session.contentEpoch();
    session.applyPersistentBlockShrink("   ");
    expect(session.contentEpoch()).toBe(epochBefore);
    expect(session.getSerializedContextState()?.historySummary).toContain("Small summary");
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
  it("keeps an objective-only compatibility anchor out of model context", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect the current value" }]);

    const plan = session.ensureExecutionPlanAnchor();
    const view = JSON.stringify(session.getMessagesForModel());

    expect(plan).toMatchObject({ revision: 0, steps: [] });
    expect(view).toContain("Inspect the current value");
    expect(view).not.toContain("Execution plan anchor");
    expect(view).not.toContain("no explicit milestones");
  });

  it("does not duplicate a successful current full snapshot that remains visible", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    const snapshot = [
      { step: "Inspect inputs", status: "completed" as const },
      { step: "Apply migration", status: "in_progress" as const },
    ];
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-1",
      name: "manage_execution_plan",
      input: { plan: snapshot },
    }]);
    const plan = session.updateExecutionPlan({ steps: snapshot });
    session.addToolResult("plan-1", JSON.stringify({
      ok: true,
      action: "update",
      revision: plan.revision,
      step_count: plan.steps.length,
      updated_step_ids: plan.steps.map((step) => step.id),
    }));

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Complete the staged migration");
    expect(view).toContain("Apply migration");
    expect(view).not.toContain("Execution plan anchor");
  });

  it("restores the durable anchor after checkpointing hides the full snapshot", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    const snapshot = [
      { step: "Inspect inputs", status: "completed" as const },
      { step: "Apply migration", status: "in_progress" as const },
    ];
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-1",
      name: "manage_execution_plan",
      input: { plan: snapshot },
    }]);
    const plan = session.updateExecutionPlan({ steps: snapshot });
    session.addToolResult("plan-1", JSON.stringify({
      ok: true,
      action: "update",
      revision: plan.revision,
      step_count: plan.steps.length,
      updated_step_ids: plan.steps.map((step) => step.id),
    }));
    session.applyActiveCheckpointSummary("The Plan was created and inspection completed.", 2);

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Current turn checkpoint");
    expect(view).toContain("Execution plan anchor");
    expect(view).toContain("Complete the staged migration");
    expect(view).toContain("step_2 [in_progress] Apply migration");
  });

  it("restores the last valid plan after checkpointing a rejected update", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    session.updateExecutionPlan({
      steps: [{ step: "Apply migration", status: "in_progress" }],
    });
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-failed",
      name: "manage_execution_plan",
      input: { plan: [{ step: "Different milestone", status: "in_progress" }] },
    }]);
    session.addToolResult("plan-failed", JSON.stringify({
      ok: false,
      error_code: "PLAN_UPDATE_REJECTED",
    }), undefined, true);
    session.applyActiveCheckpointSummary("The attempted change was rejected.", 2);

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Execution plan anchor");
    expect(view).toContain("step_1 [in_progress] Apply migration");
  });

  it("restores a legacy incremental plan at a checkpoint", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    const snapshot = [{ step: "Apply migration", status: "in_progress" as const }];
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-create",
      name: "manage_execution_plan",
      input: { plan: snapshot },
    }]);
    const created = session.updateExecutionPlan({ steps: snapshot });
    session.addToolResult("plan-create", JSON.stringify({
      ok: true,
      action: "update",
      revision: created.revision,
      step_count: 1,
      updated_step_ids: [1],
    }));
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-status",
      name: "manage_execution_plan",
      input: { action: "set_status", step_id: 1, status: "completed" },
    }]);
    const completed = session.updateExecutionPlan({
      steps: [{ step: "Apply migration", status: "completed" }],
    });
    session.addToolResult("plan-status", JSON.stringify({
      ok: true,
      action: "set_status",
      revision: completed.revision,
      step_count: 1,
      updated_step_ids: [1],
    }));
    session.applyActiveCheckpointSummary("Plan updated.", 4);

    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Execution plan anchor");
    expect(view).toContain("step_1 [completed] Apply migration");
  });

  it("preserves real user correction without adding a second synthetic user turn", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    const snapshot = [{ step: "Apply migration", status: "in_progress" as const }];
    session.addAssistantMessage([{
      type: "tool_use",
      id: "plan-1",
      name: "manage_execution_plan",
      input: { plan: snapshot },
    }]);
    const plan = session.updateExecutionPlan({ steps: snapshot });
    session.addToolResult("plan-1", JSON.stringify({
      ok: true,
      action: "update",
      revision: plan.revision,
      step_count: plan.steps.length,
      updated_step_ids: [1],
    }));
    session.addMessage("user", [{ type: "text", text: "Pause migration and only report findings" }]);

    // The correction stays the only new user boundary; the refreshed plan
    // anchor rides inside it instead of a synthetic tail message.
    const modelView = session.getMessagesForModel();
    const tail = modelView.at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.content[0]).toEqual({ type: "text", text: "Pause migration and only report findings" });
    expect(JSON.stringify(tail)).toContain("Reconciliation required");
    expect(modelView.filter((message) => message.role === "user"
      && !message.content.some((part) => part.type === "tool_result"))).toHaveLength(2);
  });

  it("freezes the plan anchor on a mid-turn correction and keeps later requests append-only", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the staged migration" }]);
    session.updateExecutionPlan({ steps: [{ step: "Apply migration", status: "in_progress" }] });
    session.addAssistantMessage([{ type: "tool_use", id: "read-1", name: "read_file", input: {} }]);
    session.addToolResult("read-1", "source bytes");
    session.addMessage("user", [{ type: "text", text: "Pause migration and only report findings" }]);
    const steerView = session.getMessagesForModel();
    const steer = JSON.stringify(steerView.at(-1));
    expect(steer).toContain("Reconciliation required");
    expect(steer).toContain("step_1 [in_progress] Apply migration");
    expect(steer.indexOf("Pause migration and only report findings")).toBeLessThan(steer.indexOf("Execution plan anchor"));

    // Later plan and tool activity append after the frozen anchor.
    session.updateExecutionPlan({ steps: [{ step: "Report findings", status: "in_progress" }] });
    session.addAssistantMessage([{ type: "tool_use", id: "read-2", name: "read_file", input: {} }]);
    session.addToolResult("read-2", "more bytes");
    const later = session.getMessagesForModel();
    expect(later.slice(0, steerView.length)).toEqual(steerView);
    expect(JSON.stringify(later)).not.toContain("Report findings");

    // A checkpoint covering the correction carries the refreshed anchor exactly once.
    session.applyActiveCheckpointSummary("Migration paused; findings pending.", session.length - 1);
    const afterCheckpoint = JSON.stringify(session.getMessagesForModel());
    expect(afterCheckpoint.match(/Execution plan anchor/g)).toHaveLength(1);
    expect(afterCheckpoint).toContain("Report findings");
    expect(afterCheckpoint).toContain("Pause migration and only report findings");
  });

  it("attaches no anchor to tool results, host observations, or a correction without a plan", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect the report" }]);
    session.addMessage("user", [{ type: "text", text: "Also check the logs" }]);
    expect(session.getMessagesForModel().at(-1)).toEqual({
      role: "user", content: [{ type: "text", text: "Also check the logs" }],
    });
    session.updateExecutionPlan({ steps: [{ step: "Work", status: "in_progress" }] });
    session.addAssistantMessage([{ type: "tool_use", id: "t1", name: "bash", input: {} }]);
    session.addToolResult("t1", "ok");
    session.addMessage("developer", [{ type: "text", text: "Runtime observation." }]);
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("Execution plan anchor");
  });

  it("keeps objective and steps in durable recovery context, not a repeated model tail", () => {
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
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("Execution plan anchor");
    session.applyActiveCheckpointSummary("Inspected the importer.", 2);

    const view = session.getMessagesForModel();
    const tail = JSON.stringify(view[view.length - 1]);
    expect(tail).toContain("Execution plan anchor");
    expect(tail).toContain("Never quote, summarize, acknowledge, or mention this block");
    expect(tail).toContain("Implement the long-running import safely");
    expect(tail).toContain("Implement bounded streaming");
    expect(tail).toContain("in_progress");
    expect(tail).toContain("step_2 [in_progress]");
    expect(tail).not.toContain("For the same user instruction, preserve every existing milestone");
    expect(plan.objective).toBe("Implement the long-running import safely");

    expect(JSON.stringify(session.getMessages())).not.toContain("Execution plan anchor");
    // History projection never invokes a separate summarizer.
    expect(session.getPendingHistoryArchive(DEFAULT_CONTEXT_BUDGET)).toBeNull();

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
    const stalePlanTail = JSON.stringify(session.getMessagesForModel().at(-1));
    expect(stalePlanTail).toContain(
      "Latest user instruction — authoritative; replaces conflicting earlier requirements",
    );
    expect(stalePlanTail).toContain("Actually switch to the replacement task");
    expect(stalePlanTail.indexOf("Actually switch to the replacement task"))
      .toBeLessThan(stalePlanTail.indexOf("Objective"));
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
    session.applyActiveCheckpointSummary("The objective was explicitly replaced.", session.length - 1);
    view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Reconciliation: current");
    expect(session.getExecutionPlan()?.objective).toBe("Actually switch to the replacement task");
  });

  it("detects an interrupt-steer inside the same active turn", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Initial in-flight goal" }]);
    session.updateExecutionPlan({ steps: [{ step: "Work", status: "in_progress" }] });

    session.addMessage("user", [{ type: "text", text: "Pause that and account for this new constraint" }]);
    const stalePlanTail = JSON.stringify(session.getMessagesForModel().at(-1));
    expect(session.getMessagesForModel().at(-1)?.role).toBe("user");
    expect(stalePlanTail).toContain("Pause that and account for this new constraint");
    expect(stalePlanTail).toContain("Reconciliation required");
    expect(stalePlanTail.indexOf("Pause that and account for this new constraint"))
      .toBeLessThan(stalePlanTail.indexOf("Reconciliation required"));

    session.updateExecutionPlan({ steps: [{ step: "Account for constraint", status: "in_progress" }] });
    session.applyActiveCheckpointSummary("The user corrected the task.", session.length - 1);
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

  it("does not create a revision or audit record for an unchanged complete snapshot", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the migration" }]);
    const steps = [
      { step: "Inspect callers", status: "completed" as const },
      { step: "Migrate storage", status: "in_progress" as const },
      { step: "Verify restart recovery", status: "pending" as const },
    ];
    const initial = session.updateExecutionPlan({
      explanation: "Initial transition",
      steps,
    });

    const replay = session.updateExecutionPlan({
      explanation: "Paraphrasing the reason is not execution progress",
      steps,
    });

    expect(replay).toEqual(initial);
    expect(replay.revision).toBe(1);
    expect(replay.explanation).toBe("Initial transition");
    expect(session.getExecutionPlanAudit()).toHaveLength(1);
  });

  it("still reconciles a newer user instruction when the milestone snapshot is unchanged", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Complete the migration" }]);
    const steps = [
      { step: "Inspect callers", status: "completed" as const },
      { step: "Migrate storage", status: "in_progress" as const },
    ];
    session.updateExecutionPlan({ steps });
    session.addMessage("user", [{ type: "text", text: "Also preserve rollback evidence" }]);

    const reconciled = session.updateExecutionPlan({ steps });

    expect(reconciled.revision).toBe(2);
    expect(reconciled.objective).toContain("Also preserve rollback evidence");
    expect(reconciled.objective).toContain("Complete the migration");
    expect(session.getExecutionPlanAudit()).toHaveLength(2);
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

    session.applyActiveCheckpointSummary("Inspection completed.", session.length - 1);
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
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("Completed work ledger");
    session.applyActiveCheckpointSummary("Skill reads completed.", session.length - 1);
    const view = JSON.stringify(session.getMessagesForModel());
    expect(view).toContain("Completed work ledger");
    expect(view).toContain("Private runtime context for task continuation only.");
    expect(view).toContain("skill_manage");
    expect(view).toContain("x2");
    expect(JSON.stringify(session.getMessages())).not.toContain("Completed work ledger");
  });

  it("does not duplicate a completed-work entry while its raw tool result is model-visible", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect the source and continue from the result" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-visible",
      name: "read_file",
      input: { path: "src/example.ts" },
    }]);
    session.addToolResult("call-visible", "VISIBLE_RESULT_SENTINEL", undefined, false);
    const tokensWithRawResultOnly = session.estimateModelTokens();

    session.recordCompletedWork({
      toolCallId: "call-visible",
      tool: "read_file",
      inputDigest: "visible:1",
      inputSummary: "read src/example.ts",
      status: "succeeded",
      resultSummary: "VISIBLE_RESULT_SENTINEL",
    });

    const modelView = JSON.stringify(session.getMessagesForModel());
    expect(modelView.match(/VISIBLE_RESULT_SENTINEL/g)).toHaveLength(1);
    expect(modelView).not.toContain("Completed work ledger");
    expect(session.estimateModelTokens()).toBe(tokensWithRawResultOnly);
    expect(session.getCompletedWorkLedger()).toHaveLength(1);
  });

  it("projects only completed work whose raw result is hidden by a partial checkpoint", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Process both sources without losing earlier outcomes" }]);

    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-hidden",
      name: "read_file",
      input: { path: "src/old.ts" },
    }]);
    session.addToolResult("call-hidden", "HIDDEN_RAW_RESULT", undefined, false);
    session.recordCompletedWork({
      toolCallId: "call-hidden",
      tool: "read_file",
      inputDigest: "hidden:1",
      inputSummary: "read src/old.ts",
      status: "succeeded",
      resultSummary: "HIDDEN_LEDGER_RESULT",
    });

    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-recent",
      name: "read_file",
      input: { path: "src/recent.ts" },
    }]);
    session.addToolResult("call-recent", "RECENT_RAW_RESULT", undefined, false);
    session.recordCompletedWork({
      toolCallId: "call-recent",
      tool: "read_file",
      inputDigest: "recent:1",
      inputSummary: "read src/recent.ts",
      status: "succeeded",
      resultSummary: "RECENT_LEDGER_RESULT",
    });

    session.applyActiveCheckpointSummary("The first source was processed.", 2);

    const modelView = JSON.stringify(session.getMessagesForModel());
    expect(modelView).not.toContain("HIDDEN_RAW_RESULT");
    expect(modelView).toContain("HIDDEN_LEDGER_RESULT");
    expect(modelView).toContain("RECENT_RAW_RESULT");
    expect(modelView).not.toContain("RECENT_LEDGER_RESULT");
    expect(modelView).toContain("Completed work ledger");
  });

  it("restores a failed completed-work entry after its raw error is checkpointed", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Diagnose the failing command" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-failed",
      name: "bash",
      input: { command: "npm test" },
    }]);
    session.addToolResult("call-failed", "RAW_FAILURE_DETAIL", undefined, true);
    session.recordCompletedWork({
      toolCallId: "call-failed",
      tool: "bash",
      inputDigest: "failed:1",
      inputSummary: "run npm test",
      status: "failed",
      resultSummary: "LEDGER_FAILURE_DETAIL",
    });

    const visibleView = JSON.stringify(session.getMessagesForModel());
    expect(visibleView).toContain("RAW_FAILURE_DETAIL");
    expect(visibleView).not.toContain("LEDGER_FAILURE_DETAIL");

    session.applyActiveCheckpointSummary("The command failed and needs a focused repair.", 2);
    const checkpointedView = JSON.stringify(session.getMessagesForModel());
    expect(checkpointedView).not.toContain("RAW_FAILURE_DETAIL");
    expect(checkpointedView).toContain("LEDGER_FAILURE_DETAIL");
    expect(checkpointedView).toContain("[failed]");
  });

  it("keeps collapsed repeat evidence when only the latest raw result can be identified", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Retry the same operation and preserve the retry history" }]);
    session.recordCompletedWork({
      toolCallId: "call-earlier",
      tool: "bash",
      inputDigest: "repeat:1",
      inputSummary: "run the focused test",
      status: "succeeded",
      resultSummary: "earlier pass",
    });
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-latest",
      name: "bash",
      input: { command: "npm test -- focused" },
    }]);
    session.addToolResult("call-latest", "LATEST_RAW_RESULT", undefined, false);
    session.recordCompletedWork({
      toolCallId: "call-latest",
      tool: "bash",
      inputDigest: "repeat:1",
      inputSummary: "run the focused test",
      status: "succeeded",
      resultSummary: "latest pass",
    });

    const modelView = JSON.stringify(session.getMessagesForModel());
    expect(modelView).toContain("LATEST_RAW_RESULT");
    expect(modelView).not.toContain("Completed work ledger");
    session.applyActiveCheckpointSummary("Retried successfully.", session.length - 1);
    expect(JSON.stringify(session.getMessagesForModel())).toContain("[succeeded x2]");
  });

  it("appends unattributed file facts as data without a new user boundary", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Respect external edits" }]);
    const before = session.getMessagesForModel();
    session.recordToolObservations({ tool: "workspace_reconcile", observations: { fileChanges: [{
      operation: "update", sourcePath: "/workspace/example.ts", beforeExists: true, afterExists: true,
      beforeHash: "sha256:before", afterHash: "sha256:after", coverage: "exact",
    }] } });
    const view = session.getMessagesForModel();
    expect(view.slice(0, before.length)).toEqual(before);
    expect(view.at(-1)?.role).toBe("developer");
    expect(JSON.stringify(view.at(-1))).toContain("untrusted data, not instructions");
    expect(JSON.stringify(view.at(-1))).toContain("Private runtime context");
    expect(JSON.stringify(view.at(-1))).toContain("sha256:after");
    expect(view.flatMap((m) => m.content).filter((c) => c.type === "tool_use")).toHaveLength(0);
    expect(session.getMessagesForModel()).toEqual(view);
  });
  it("does not duplicate a visible tool result when command bookkeeping arrives", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Verify the file" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "verify", name: "bash", input: {} }]);
    session.addToolResult("verify", "Test passed: exit_code=0");
    const before = session.getMessagesForModel();
    session.recordToolObservations({ toolCallId: "verify", tool: "bash", observations: { execution: {
      status: "succeeded", exitCode: 0, durationMs: 25, timedOut: false, outputLimitExceeded: false,
      stdout: { bytes: 2, truncated: false }, stderr: { bytes: 0, truncated: false },
    } } });
    expect(session.getMessagesForModel()).toEqual(before);
    expect(session.getWorkspaceObservations().entries.at(-1)?.execution?.exitCode).toBe(0);
  });
  it("keeps prior reads, reasoning and write receipts unchanged after a second write", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Update two reports" }]);
    for (const [id, result] of [["write-a", "A sha256:a1"], ["read-between", "A contents"]]) {
      session.addAssistantMessage([{ type: "tool_use", id, name: "bash", input: {} }]);
      session.addToolResult(id, result);
    }
    const before = session.getMessagesForModel();
    session.addAssistantMessage([{ type: "tool_use", id: "write-b", name: "bash", input: {} }]);
    session.recordToolObservations({ toolCallId: "write-b", tool: "bash", observations: { fileChanges: [{
      operation: "update", sourcePath: "/workspace/b.txt", beforeExists: true, afterExists: true,
      beforeHash: "sha256:b0", afterHash: "sha256:b1", coverage: "partial",
    }] } });
    session.addToolResult("write-b", "B sha256:b1");
    expect(session.getMessagesForModel().slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("[Workspace changes");
  });
  it("restores only net workspace changes at a checkpoint without rewriting the audit receipts", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Create a draft then discard it" }]);
    for (const operation of ["create", "delete"] as const) {
      session.addAssistantMessage([{ type: "tool_use", id: operation, name: "bash", input: {} }]);
      session.recordToolObservations({ toolCallId: operation, tool: "bash", observations: { fileChanges: [{
        operation, sourcePath: "/workspace/draft.txt", beforeExists: operation === "delete",
        afterExists: operation === "create", beforeHash: operation === "delete" ? "sha256:draft" : undefined,
        afterHash: operation === "create" ? "sha256:draft" : undefined, coverage: "exact",
      }] } });
      session.addToolResult(operation, operation + " draft.txt");
    }
    const raw = session.getMessages();
    session.applyActiveCheckpointSummary("The temporary draft was discarded.", session.length - 1);
    expect(JSON.stringify(session.getMessagesForModel())).not.toContain("[Workspace changes");
    expect(session.getMessages()).toEqual(raw);
    expect(session.renderWorkspaceDiff({ format: "summary" })).toContain('files_changed="0"');
  });
  it("restores hidden command evidence in the workspace state after a checkpoint", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Update and verify the checkpointed file" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "change-hidden",
      name: "edit_file",
      input: { path: "/workspace/checkpointed.ts" },
    }]);
    session.recordToolObservations({
      toolCallId: "change-hidden",
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "create",
          sourcePath: "/workspace/checkpointed.ts",
          beforeExists: false,
          afterExists: true,
          afterHash: "sha256:checkpointed",
          coverage: "exact",
        }],
      },
    });
    session.addToolResult("change-hidden", "HIDDEN_FILE_CHANGE_RESULT", undefined, false);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "command-hidden",
      name: "bash",
      input: { command: "npm test" },
    }]);
    session.recordToolObservations({
      toolCallId: "command-hidden",
      tool: "bash",
      observations: {
        execution: {
          status: "succeeded",
          exitCode: 0,
          durationMs: 40,
          timedOut: false,
          outputLimitExceeded: false,
          stdout: { bytes: 2, truncated: false },
          stderr: { bytes: 0, truncated: false },
        },
      },
    });
    session.addToolResult("command-hidden", "HIDDEN_COMMAND_RESULT", undefined, false);
    session.applyActiveCheckpointSummary("The file was updated and its tests passed.", 4);

    const modelView = session.getMessagesForModel();
    const checkpointIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "text" && content.text.startsWith("[Current turn checkpoint]")
    )));
    const workspaceIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "text" && content.text.includes("[Workspace changes")
    )));
    const workspaceText = modelView[workspaceIndex]?.content
      .find((content) => content.type === "text")?.text ?? "";

    expect(workspaceIndex).toBe(checkpointIndex);
    expect(workspaceIndex).toBe(modelView.length - 1);
    expect(workspaceText).toContain("checkpointed.ts");
    expect(workspaceText).toContain("Commands after latest observed change");
    expect(workspaceText).toContain("bash: status=succeeded exit_code=0");
    expect(JSON.stringify(modelView)).not.toContain("HIDDEN_FILE_CHANGE_RESULT");
    expect(JSON.stringify(modelView)).not.toContain("HIDDEN_COMMAND_RESULT");
  });

  it("does not duplicate a still-visible command after a partial checkpoint", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Continue after the earlier edit" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "change-checkpointed",
      name: "edit_file",
      input: { path: "/workspace/partial.ts" },
    }]);
    session.recordToolObservations({
      toolCallId: "change-checkpointed",
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/partial.ts",
          beforeExists: true,
          afterExists: true,
          beforeHash: "sha256:old",
          afterHash: "sha256:new",
          coverage: "exact",
        }],
      },
    });
    session.addToolResult("change-checkpointed", "CHECKPOINTED_CHANGE_RESULT", undefined, false);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "command-recent",
      name: "bash",
      input: { command: "npm test" },
    }]);
    session.recordToolObservations({
      toolCallId: "command-recent",
      tool: "bash",
      observations: {
        execution: {
          status: "succeeded",
          exitCode: 0,
          durationMs: 15,
          timedOut: false,
          outputLimitExceeded: false,
          stdout: { bytes: 2, truncated: false },
          stderr: { bytes: 0, truncated: false },
        },
      },
    });
    session.addToolResult("command-recent", "RECENT_COMMAND_RESULT", undefined, false);
    session.applyActiveCheckpointSummary("The file edit is complete.", 2);

    const modelView = session.getMessagesForModel();
    const checkpointIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "text" && content.text.startsWith("[Current turn checkpoint]")
    )));
    const workspaceIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "text" && content.text.includes("[Workspace changes")
    )));
    const commandUseIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "tool_use" && content.id === "command-recent"
    )));
    const workspaceText = modelView[workspaceIndex]?.content
      .find((content) => content.type === "text")?.text ?? "";

    expect(workspaceIndex).toBe(checkpointIndex);
    expect(workspaceIndex).toBeLessThan(commandUseIndex);
    expect(workspaceText).not.toContain("Commands after latest observed change");
    expect(JSON.stringify(modelView)).toContain("RECENT_COMMAND_RESULT");
  });

  it("reports a volatile external file once per turn until the model reads it again", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Watch the build while editing" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "write-log", name: "bash", input: {} }]);
    session.recordToolObservations({ toolCallId: "write-log", tool: "bash", observations: { fileChanges: [{
      operation: "create", sourcePath: "/workspace/build.log", beforeExists: false, afterExists: true,
      afterHash: "sha256:log-1", coverage: "exact",
    }] } });
    session.addToolResult("write-log", "started");
    const reconcile = (afterHash: string, filePath = "/workspace/build.log") => session.recordToolObservations({
      tool: "workspace_reconcile", observations: { fileChanges: [{
        operation: "update", sourcePath: filePath, beforeExists: true, afterExists: true,
        beforeHash: "sha256:previous", afterHash, coverage: "exact",
      }] },
    });
    const observationRows = () => session.getMessages().filter((message) => message.role === "developer"
      && message.content.some((part) => part.type === "text" && part.text.startsWith("Runtime observation."))).length;

    reconcile("sha256:log-2");
    expect(observationRows()).toBe(1);
    session.addAssistantMessage([{ type: "tool_use", id: "edit-1", name: "edit_file", input: {} }]);
    session.addToolResult("edit-1", "edited");
    // The same volatile path changed again: no second row while unread.
    reconcile("sha256:log-3");
    expect(observationRows()).toBe(1);
    expect(session.getWorkspaceObservations().entries.filter((entry) => entry.tool === "workspace_reconcile")).toHaveLength(2);
    // Negative control: a different externally changed path is still reported.
    reconcile("sha256:cfg-2", "/workspace/config.json");
    expect(observationRows()).toBe(2);
    expect(JSON.stringify(session.getMessages().at(-1))).toContain("config.json");
    expect(JSON.stringify(session.getMessages().at(-1))).not.toContain("build.log");

    // After the model reads the file again, the next change is news again.
    session.addAssistantMessage([{ type: "tool_use", id: "read-log", name: "read_file", input: {} }]);
    session.recordToolObservations({ toolCallId: "read-log", tool: "read_file", observations: { fileReads: [{
      path: "/workspace/build.log", hash: "sha256:log-3",
    }] } });
    session.addToolResult("read-log", "log contents");
    reconcile("sha256:log-4");
    expect(observationRows()).toBe(3);
    expect(JSON.stringify(session.getMessages().at(-1))).toContain("build.log");
  });

  it("appends a host reconciliation after the old receipt without moving prior context", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Respect an externally changed file" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "read-before-reconcile",
      name: "read_file",
      input: { path: "/workspace/external.ts" },
    }]);
    session.addToolResult("read-before-reconcile", "VISIBLE_READ_RESULT", undefined, false);
    session.recordToolObservations({
      tool: "workspace_reconcile",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/external.ts",
          beforeExists: true,
          afterExists: true,
          beforeHash: "sha256:observed",
          afterHash: "sha256:external",
          coverage: "exact",
        }],
      },
    });

    const modelView = session.getMessagesForModel();
    const rawResultIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "tool_result" && content.toolUseId === "read-before-reconcile"
    )));
    const workspaceIndex = modelView.findIndex((message) => message.content.some((content) => (
      content.type === "text" && content.text.startsWith("Runtime observation.")
    )));

    expect(workspaceIndex).toBeGreaterThan(rawResultIndex);
    expect(workspaceIndex).toBe(modelView.length - 1);
    expect(modelView[workspaceIndex].role).toBe("developer");
  });

  it("retains an unattributed command summary that cannot be safely matched to a raw result", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Preserve legacy command evidence" }]);
    session.recordToolObservations({
      toolCallId: "legacy-change",
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "create",
          sourcePath: "/workspace/legacy.ts",
          beforeExists: false,
          afterExists: true,
          afterHash: "sha256:legacy",
          coverage: "exact",
        }],
      },
    });
    session.recordToolObservations({
      tool: "legacy_bash",
      observations: {
        execution: {
          status: "failed",
          exitCode: 2,
          durationMs: 12,
          timedOut: false,
          outputLimitExceeded: false,
          stdout: { bytes: 0, truncated: false },
          stderr: { bytes: 5, truncated: false },
        },
      },
    });

    const modelView = JSON.stringify(session.getMessagesForModel());
    expect(modelView).toContain("legacy_bash");
    expect(modelView).toContain("failed");
    expect(session.getWorkspaceObservations().entries.at(-1)?.execution?.exitCode).toBe(2);
    expect(session.getMessagesForModel().at(-1)?.role).toBe("developer");
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

    session.applyActiveCheckpointSummary("Investigation progressed.", session.length - 1);
    const ledgerText = session.getMessagesForModel()
      .flatMap((message) => message.content)
      .find((content) => content.type === "text" && content.text.includes("[Completed work ledger"));
    expect(ledgerText?.type).toBe("text");
    if (ledgerText?.type !== "text") throw new Error("missing completed-work projection");
    expect(estimateTextTokens(ledgerText.text))
      .toBeLessThanOrEqual(COMPLETED_WORK_MODEL_MAX_TOKENS);
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
        steps: [{
          step: "Complete the bounded audit",
          status: index % 2 === 0 ? "in_progress" : "blocked",
        }],
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

describe('token budgets for deterministic continuation state', () => {
  it.each(['界', 'a', '123,', '😀界'])('bounds plan excerpts for %s while retaining the durable plan', (unit) => {
    const session = new Session();
    const objective = 'START ' + unit.repeat(3_000) + ' END';
    const step = 'FIRST ' + unit.repeat(100) + ' LAST';
    session.beginUserTurn([{ type: 'text', text: objective }]);
    session.updateExecutionPlan({ steps: [{ step, status: 'in_progress' }] });
    const stored = session.getExecutionPlan();
    session.applyActiveCheckpointSummary('Made progress.', session.length - 1);
    const projected = session.getMessagesForModel().flatMap(m => m.content)
      .filter(c => c.type === 'text').map(c => c.text).join('\n');
    const anchor = projected.slice(projected.indexOf('[Execution plan anchor'));
    const objectiveText = anchor.slice(anchor.indexOf(':\n') + 2, anchor.indexOf('\nRevision:'));
    expect(estimateTextTokens(objectiveText)).toBeLessThanOrEqual(600);
    expect(objectiveText).toContain('START');
    expect(objectiveText).toContain('END');
    expect(objectiveText).toContain('chars omitted');
    const stepText = anchor.slice(anchor.indexOf('[in_progress] ') + '[in_progress] '.length);
    expect(estimateTextTokens(stepText)).toBeLessThanOrEqual(100);
    expect(stepText).toContain('FIRST');
    expect(stepText).toContain('LAST');
    expect(stepText.isWellFormed()).toBe(true);
    expect(session.getExecutionPlan()).toEqual(stored);
    expect(session.getExecutionPlan()?.steps[0].step).toBe(step);
  });

  it('bounds dense completed records as whole entries, including runtime framing', () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Inspect all results' }]);
    for (let i = 1; i <= 24; i++) session.recordCompletedWork({
      tool: 'probe', inputDigest: `entry-${i}`, inputSummary: '界'.repeat(70),
      status: 'succeeded', resultSummary: '界'.repeat(180), resultRef: `result-${i}`,
    });
    session.applyActiveCheckpointSummary('Progress.', session.length - 1);
    const projected = session.getMessagesForModel().flatMap(m => m.content)
      .filter(c => c.type === 'text').map(c => c.text).find(t => t.includes('[Completed work ledger'))!;
    const ledgerText = projected.slice(projected.indexOf('[Completed work ledger'));
    const privacyNotice = projected.split('\n').find(line => line.startsWith('Private runtime context'))!;
    expect(estimateTextTokens(privacyNotice + '\n' + ledgerText)).toBeLessThanOrEqual(3_000);
    expect(projected).toContain('result-24');
    expect(projected).not.toContain('ref=result-1;');
    expect(projected).toContain('Private runtime context');
    expect(session.getCompletedWorkLedger()).toHaveLength(24);
    expect(session.getCompletedWorkLedger()[0].resultSummary).toBe('界'.repeat(180));
  });
});
