import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentSession } from "../src/agent/persistent-session.js";
import type { Message, MessageContent } from "../src/shared/types.js";

// Mirrors the constant in persistent-session.ts; kept inline (not exported)
// so the heal contract is testable without leaking an internal sentinel.
const INTERRUPTED_TOOL_RESULT =
  "[interrupted: previous run aborted before this tool produced a result]";

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `core-agent-psession-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe("PersistentSession", () => {
  let file: string;

  beforeEach(() => {
    file = tmpFile("t.jsonl");
  });

  afterEach(() => {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    try { fs.unlinkSync(`${file}.tmp`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${file}.context.json`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${file}.context.json.tmp`); } catch { /* ignore */ }
  });

  it("starts empty when backing file does not exist", () => {
    const s = new PersistentSession({ sessionFile: file });
    expect(s.length).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reloads host observations and native tool images without creating a user turn", () => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "Inspect the preview" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "image", name: "read_files", input: {} }]);
    session.addToolResult("image", "preview", [{ data: "pixels", mediaType: "image/png" }]);
    session.addMessage("developer", [{ type: "text", text: "Runtime observation: externally changed." }]);
    const before = session.getMessagesForModel();
    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getMessagesForModel()).toEqual(before);
    expect(restored.activeTurnHasUserMessage([{ type: "text", text: "Inspect the preview" }])).toBe(true);
    expect(restored.activeTurnHasUserMessage([{ type: "text", text: "Runtime observation: externally changed." }])).toBe(false);
    restored.addUserMessage("A genuine correction");
    const again = new PersistentSession({ sessionFile: file });
    expect(again.getMessagesForModel().at(-1)).toMatchObject({ role: "user",
      content: [{ type: "text", text: "A genuine correction" }] });
  });

  it("migrates legacy tool image trailers but not a later user's image-only message", () => {
    const rows: Message[] = [
      { role: "user", turnId: 1, content: [{ type: "text", text: "Inspect" }] },
      { role: "assistant", turnId: 1, content: [{ type: "tool_use", id: "image", name: "read_files", input: {} }] },
      { role: "user", turnId: 1, content: [{ type: "tool_result", toolUseId: "image", content: "preview" }] },
      { role: "user", turnId: 1, content: [{ type: "image", data: "old-tool-image", mediaType: "image/png" }] },
      { role: "user", turnId: 2, content: [{ type: "image", data: "real-user-image", mediaType: "image/png" }] },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const restored = new PersistentSession({ sessionFile: file });
    const messages = restored.getMessages();
    expect(messages[2].content[0]).toMatchObject({ type: "tool_result", images: [{ data: "old-tool-image" }] });
    expect(messages[3]).toMatchObject({ role: "user", turnId: 2, content: [{ type: "image", data: "real-user-image" }] });
    expect(new PersistentSession({ sessionFile: file }).getMessages()).toEqual(messages);
  });

  it.each([false, true])("preserves a same-turn user image after a new receipt (tool image: %s)", (hasToolImage) => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "Inspect" }]);
    session.addAssistantMessage([{ type: "tool_use", id: "read", name: "read_files", input: {} }]);
    session.addToolResult("read", "result", hasToolImage ? [{ data: "tool-pixels", mediaType: "image/png" }] : undefined);
    session.addMessage("user", [{ type: "image", data: "real-user-correction", mediaType: "image/png" }]);
    const before = session.getMessagesForModel();
    expect(session.healAndPersist()).toBe(false);
    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getMessagesForModel()).toEqual(before);
    expect(restored.getMessagesForModel().at(-1)).toMatchObject({ role: "user",
      content: [{ type: "image", data: "real-user-correction" }] });
    restored.applyActiveCheckpointSummary("Inspected the earlier report.", restored.length - 1);
    expect(restored.getMessagesForModel().at(-1)).toMatchObject({ role: "user",
      content: [{ type: "image", data: "real-user-correction" }] });
  });

  it("keeps a mid-turn correction's frozen plan anchor across restart", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Finish the migration" }]);
    s1.updateExecutionPlan({ steps: [{ step: "Apply migration", status: "in_progress" }] });
    s1.addAssistantMessage([{ type: "tool_use", id: "read", name: "read_file", input: {} }]);
    s1.addToolResult("read", "bytes");
    s1.addMessage("user", [{ type: "text", text: "Pause and report" }]);
    const before = s1.getMessagesForModel();
    expect(JSON.stringify(before.at(-1))).toContain("Reconciliation required");

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.getMessagesForModel()).toEqual(before);
    // A later plan change after restart appends; the restored anchor stays put.
    s2.updateExecutionPlan({ steps: [{ step: "Report", status: "in_progress" }] });
    expect(s2.getMessagesForModel()).toEqual(before);
  });

  it("persists messages to disk on add", () => {
    const s = new PersistentSession({ sessionFile: file });
    s.addUserMessage("hello");
    s.addAssistantMessage([{ type: "text", text: "hi back" }]);

    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.role).toBe("user");
    expect(first.content[0]).toEqual({ type: "text", text: "hello" });
    expect(typeof first.ts).toBe("number");
  });

  it("resumes prior messages from disk", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.addUserMessage("msg A");
    s1.addAssistantMessage([{ type: "text", text: "reply A" }]);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(2);
    const msgs = s2.getMessages();
    expect(msgs[0].role).toBe("user");
    expect((msgs[0].content[0] as { text: string }).text).toBe("msg A");
    expect(msgs[1].role).toBe("assistant");
  });

  it("persists the v3 tool-surface marker without dynamic groups", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.setToolSurfaceState({
      version: 3,
      mode: "scoped",
      loadedGroups: [],
      catalogRevision: "6",
    });

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.getToolSurfaceState()).toEqual({
      version: 3,
      mode: "scoped",
      loadedGroups: [],
      catalogRevision: "6",
    });

    // A full history rewrite must not disturb the tool-surface sidecar.
    // (This step used the legacy whole-session compact() before its removal;
    // canonical history replacement is the surviving rewrite operation.)
    s2.replaceConversationHistory([
      { role: "user", turnId: 1, content: [{ type: "text", text: "old turn" }] },
      { role: "assistant", turnId: 1, content: [{ type: "text", text: "old reply" }] },
    ], "group-main-v1:tool-surface-test");
    const s3 = new PersistentSession({ sessionFile: file });
    expect(s3.getToolSurfaceState()?.loadedGroups).toEqual([]);

    s3.clear();
    expect(s3.getToolSurfaceState()).toBeUndefined();
  });

  it("persists one rich steer durability batch with its resource sidecar", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.withContextMutationBatch(() => {
      s1.beginUserTurn([
        { type: "text", text: "inspect this chart" },
        { type: "image", data: "aW1hZ2U=", mediaType: "image/png" },
      ]);
      s1.addHistoryResource({
        kind: "attachment",
        path: "/workspace/chart.png",
        name: "chart.png",
        mediaType: "image/png",
      });
    });

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.getMessages()[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "inspect this chart" },
        { type: "image", data: "aW1hZ2U=", mediaType: "image/png" },
      ],
    });
    expect(s2.getSerializedContextState()?.resources).toContainEqual(expect.objectContaining({
      kind: "attachment",
      path: "/workspace/chart.png",
      name: "chart.png",
    }));
  });

  it("rebases semantic dialogue from a canonical source while preserving compatible compaction", () => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "PRIVATE_TOOL_TRANSCRIPT" }]);
    session.addAssistantMessage([{ type: "text", text: "private reply" }]);
    session.completeActiveTurn();
    session.addHistoryResource({
      kind: "final_output",
      path: "/workspace/video.mp4",
      name: "video.mp4",
    });

    const canonical: Message[] = [
      { role: "user", turnId: 1, content: [{ type: "text", text: "Make the video" }] },
      { role: "assistant", turnId: 1, content: [{ type: "text", text: "Commander delegated to VideoStudio" }] },
      { role: "user", turnId: 2, content: [{ type: "text", text: "Continue the video task" }] },
      {
        role: "assistant",
        turnId: 2,
        content: [{
          type: "text",
          text: "VideoStudio: E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED",
        }],
      },
    ];
    session.replaceConversationHistory(canonical, "group-main-v1:cid-1");

    let model = JSON.stringify(session.getMessagesForModel());
    expect(model).toContain("VideoStudio");
    expect(model).toContain("E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED");
    expect(model).not.toContain("PRIVATE_TOOL_TRANSCRIPT");
    expect(session.getSerializedContextState()).toMatchObject({
      conversationHistorySource: "group-main-v1:cid-1",
      resources: [expect.objectContaining({ name: "video.mp4" })],
    });

    session.applyHistorySummary(
      "Summary of the first canonical turn",
      [1],
    );
    session.replaceConversationHistory([
      ...canonical,
      { role: "user", turnId: 3, content: [{ type: "text", text: "Third exact request" }] },
      { role: "assistant", turnId: 3, content: [{ type: "text", text: "Third exact response" }] },
    ], "group-main-v1:cid-1");
    expect(session.beginUserTurn([{ type: "text", text: "Fix that blocker." }])).toBe(4);

    model = JSON.stringify(session.getMessagesForModel());
    expect(model).toContain("Summary of the first canonical turn");
    expect(model).not.toContain("Make the video");
    expect(model).toContain("E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED");
    expect(model).toContain("Third exact request");
    expect(model).toContain("Fix that blocker.");

    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getSerializedContextState()?.conversationHistorySource)
      .toBe("group-main-v1:cid-1");
    expect(JSON.stringify(restored.getMessages())).toContain("Third exact response");

    restored.replaceConversationHistory(canonical, "group-main-v2:cid-1");
    expect(restored.getSerializedContextState()?.historySummary).toBeUndefined();
    expect(JSON.stringify(restored.getMessagesForModel())).toContain("Make the video");
  });

  it("rewrites only the canonical tail and preserves rolling-compaction state", () => {
    const session = new PersistentSession({ sessionFile: file });
    const source = "group-main-v1:cid-incremental";
    const canonical: Message[] = [
      { role: "user", turnId: 1, content: [{ type: "text", text: "old one" }] },
      { role: "assistant", turnId: 1, content: [{ type: "text", text: "answer one" }] },
      { role: "user", turnId: 2, content: [{ type: "text", text: "old two" }] },
      { role: "assistant", turnId: 2, content: [{ type: "text", text: "answer two" }] },
      { role: "user", turnId: 3, content: [{ type: "text", text: "old three" }] },
      { role: "assistant", turnId: 3, content: [{ type: "text", text: "stale answer" }] },
    ];
    session.replaceConversationHistory(canonical, source, { checkpoint: "cursor-1" });
    session.applyHistorySummary("summary stays byte-for-byte", [1]);
    const prefixBefore = fs.readFileSync(file, "utf-8").split("\n").slice(0, 4);
    const fullSessionRewrite = vi.spyOn(fs, "writeFileSync");

    session.replaceConversationHistory([
      { role: "user", turnId: 3, content: [{ type: "text", text: "old three" }] },
      { role: "assistant", turnId: 3, content: [{ type: "text", text: "VideoStudio: E_BLOCKER" }] },
      { role: "user", turnId: 4, content: [{ type: "text", text: "new four" }] },
      { role: "assistant", turnId: 4, content: [{ type: "text", text: "answer four" }] },
    ], source, {
      replaceFromTurnId: 3,
      checkpoint: "cursor-2",
    });

    const prefixAfter = fs.readFileSync(file, "utf-8").split("\n").slice(0, 4);
    expect(prefixAfter).toEqual(prefixBefore);
    expect(fullSessionRewrite.mock.calls.some(([target]) => target === `${file}.tmp`)).toBe(false);
    expect(session.getSerializedContextState()).toMatchObject({
      conversationHistorySource: source,
      conversationHistoryCheckpoint: "cursor-2",
      historySummary: "summary stays byte-for-byte",
      summaryThroughTurnId: 1,
    });
    expect(JSON.stringify(session.getMessagesForModel())).toContain("E_BLOCKER");

    fullSessionRewrite.mockRestore();
    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getConversationHistoryCheckpoint(source)).toBe("cursor-2");
    expect(restored.getSerializedContextState()?.historySummary)
      .toBe("summary stays byte-for-byte");
    expect(JSON.stringify(restored.getMessagesForModel())).toContain("E_BLOCKER");
    expect(JSON.stringify(restored.getMessagesForModel())).toContain("new four");
  });

  it("rejects an incremental tail that would rewrite an already summarized turn", () => {
    const session = new PersistentSession({ sessionFile: file });
    const source = "group-main-v1:cid-summary-boundary";
    session.replaceConversationHistory([
      { role: "user", turnId: 1, content: [{ type: "text", text: "one" }] },
      { role: "assistant", turnId: 1, content: [{ type: "text", text: "answer" }] },
      { role: "user", turnId: 2, content: [{ type: "text", text: "two" }] },
      { role: "assistant", turnId: 2, content: [{ type: "text", text: "answer two" }] },
    ], source);
    session.applyHistorySummary("existing summary", [1]);

    expect(() => session.replaceConversationHistory([
      { role: "user", turnId: 1, content: [{ type: "text", text: "changed" }] },
      { role: "assistant", turnId: 1, content: [{ type: "text", text: "changed answer" }] },
    ], source, { replaceFromTurnId: 1 })).toThrow("already summarized");
    expect(session.getSerializedContextState()?.historySummary).toBe("existing summary");
  });

  it("invalidates only the sync cursor when restart repair trims raw history", () => {
    const source = "group-main-v1:cid-restart-fallback";
    const session = new PersistentSession({ sessionFile: file });
    const canonical: Message[] = [];
    for (let turnId = 1; turnId <= 60; turnId++) {
      canonical.push(
        { role: "user", turnId, content: [{ type: "text", text: `user ${turnId}` }] },
        { role: "assistant", turnId, content: [{ type: "text", text: `answer ${turnId}` }] },
      );
    }
    session.replaceConversationHistory(canonical, source, { checkpoint: "stale-after-trim" });
    session.applyHistorySummary("retained rolling summary", Array.from({ length: 10 }, (_, i) => i + 1));

    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getConversationHistoryCheckpoint(source)).toBeUndefined();
    expect(restored.getSerializedContextState()?.historySummary)
      .toBe("retained rolling summary");
    expect(restored.getSerializedContextState()?.summaryThroughTurnId).toBe(10);
  });

  it("persists turn context sidecar without rewriting raw tool history", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "inspect" }]);
    s1.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "bash", input: { command: "echo hidden" } }]);
    s1.addToolResult("call-1", "hidden output", undefined, false);
    s1.addAssistantMessage([{ type: "text", text: "visible final" }]);
    s1.completeActiveTurn();

    expect(fs.existsSync(`${file}.context.json`)).toBe(true);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).toContain("hidden output");

    const s2 = new PersistentSession({ sessionFile: file });
    s2.beginUserTurn([{ type: "text", text: "next" }]);
    const model = JSON.stringify(s2.getMessagesForModel());
    expect(model).toContain("inspect");
    expect(model).toContain("visible final");
    expect(model).toContain("next");
    expect(model).not.toContain("hidden output");
    expect(model).not.toContain("call-1");
  });

  it("persists workspace observations immediately in the context sidecar", () => {
    const filePath = path.join(os.tmpdir(), "persisted-workspace.ts");
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "track the file" }]);
    session.recordToolObservations({
      toolCallId: "read-1",
      tool: "read_file",
      observations: {
        fileReads: [{ path: filePath, hash: "sha256:known" }],
      },
    });

    const context = JSON.parse(fs.readFileSync(`${file}.context.json`, "utf8"));
    expect(context.workspaceObservations.entries).toHaveLength(1);
    expect(context.workspaceObservations.entries[0]).toMatchObject({
      toolCallId: "read-1",
      tool: "read_file",
    });

    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getWorkspaceObservations().entries).toHaveLength(1);
  });

  it("preserves the exact active tool history and workspace ledger across restart", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Update the persistent file and inspect it" }]);
    s1.addAssistantMessage([{
      type: "tool_use",
      id: "persistent-change",
      name: "edit_file",
      input: { path: "/workspace/persistent.ts" },
    }]);
    s1.recordToolObservations({
      toolCallId: "persistent-change",
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/persistent.ts",
          beforeExists: true,
          afterExists: true,
          beforeHash: "sha256:persistent-before",
          afterHash: "sha256:persistent-after",
          coverage: "exact",
        }],
      },
    });
    s1.addToolResult("persistent-change", "PERSISTENT_CHANGE_RESULT", undefined, false);
    s1.addAssistantMessage([{
      type: "tool_use",
      id: "persistent-read",
      name: "read_file",
      input: { path: "/workspace/persistent.ts" },
    }]);
    s1.addToolResult("persistent-read", "PERSISTENT_READ_RESULT", undefined, false);
    const beforeRestart = s1.getMessagesForModel();

    const s2 = new PersistentSession({ sessionFile: file });
    const modelView = s2.getMessagesForModel();
    expect(modelView).toEqual(beforeRestart);
    expect(JSON.stringify(modelView)).toContain("PERSISTENT_READ_RESULT");
    expect(s2.getWorkspaceObservations().entries).toHaveLength(1);
  });

  it("coalesces one logical tool completion into one context sidecar rewrite", () => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "run one durable tool" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-batch",
      name: "bash",
      input: { command: "npm test" },
    }]);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      session.withContextMutationBatch(() => {
        session.recordToolObservations({
          toolCallId: "call-batch",
          tool: "bash",
          observations: {
            execution: {
              status: "succeeded",
              exitCode: 0,
              durationMs: 10,
              timedOut: false,
              outputLimitExceeded: false,
              stdout: { bytes: 2, truncated: false },
              stderr: { bytes: 0, truncated: false },
            },
          },
        });
        session.addToolResult("call-batch", "ok", undefined, false);
        session.recordCompletedWork({
          toolCallId: "call-batch",
          tool: "bash",
          inputDigest: "8:npm-test",
          inputSummary: '{"command":"npm test"}',
          status: "succeeded",
          resultSummary: "ok",
          checkpointEpoch: 0,
        });
      });

      const contextWrites = writeSpy.mock.calls.filter(
        ([target]) => target === `${file}.context.json.tmp`,
      );
      expect(contextWrites).toHaveLength(1);
      const serialized = fs.readFileSync(`${file}.context.json`, "utf8");
      expect(serialized).not.toContain("\n  ");
      expect(JSON.parse(serialized).completedWork).toHaveLength(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("flushes a context mutation batch before propagating a synchronous interruption", () => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "persist before interruption" }]);
    session.addAssistantMessage([{
      type: "tool_use",
      id: "call-interrupted-commit",
      name: "read_file",
      input: { path: "/workspace/input.txt" },
    }]);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      expect(() => session.withContextMutationBatch(() => {
        session.recordToolObservations({
          toolCallId: "call-interrupted-commit",
          tool: "read_file",
          observations: {
            fileReads: [{ path: "/workspace/input.txt", hash: "sha256:stable" }],
          },
        });
        session.addToolResult("call-interrupted-commit", "read ok", undefined, false);
        session.recordCompletedWork({
          toolCallId: "call-interrupted-commit",
          tool: "read_file",
          inputDigest: "8:input-txt",
          inputSummary: '{"path":"/workspace/input.txt"}',
          status: "succeeded",
          resultSummary: "read ok",
          checkpointEpoch: 0,
        });
        throw new Error("injected synchronous interruption");
      })).toThrow("injected synchronous interruption");

      const contextWrites = writeSpy.mock.calls.filter(
        ([target]) => target === `${file}.context.json.tmp`,
      );
      expect(contextWrites).toHaveLength(1);

      const restored = new PersistentSession({ sessionFile: file });
      expect(restored.getSerializedContextState()?.completedWork)
        .toHaveLength(1);
      expect(restored.getWorkspaceObservations().entries)
        .toHaveLength(1);
      expect(JSON.stringify(restored.getMessages()))
        .toContain("call-interrupted-commit");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("keeps one stable turn across parallel-result healing, same-turn steer, and restart", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    const turnId = s1.beginUserTurn([{ type: "text", text: "Original long-running task" }]);
    s1.addAssistantMessage([
      { type: "tool_use", id: "call-a", name: "search", input: { q: "a" } },
      { type: "tool_use", id: "call-b", name: "search", input: { q: "b" } },
    ]);
    s1.addToolResult("call-a", "hidden result a", undefined, false);
    s1.addToolResult("call-b", "hidden result b", undefined, false);
    s1.addMessage("user", [{ type: "text", text: "Also include the same-turn user steer" }]);
    s1.addAssistantMessage([{ type: "text", text: "Final answer for the original task" }]);
    s1.completeActiveTurn();

    expect(turnId).toBe(1);
    expect(s1.getMessages().every((message) => message.turnId === turnId)).toBe(true);
    expect(s1.healAndPersist()).toBe(true);
    expect(s1.getSerializedContextState()?.completedTurns).toHaveLength(1);

    const s2 = new PersistentSession({ sessionFile: file });
    const restored = s2.getSerializedContextState();
    expect(restored?.completedTurns).toHaveLength(1);
    expect(restored?.completedTurns[0]).toMatchObject({
      id: turnId,
      userMessageIndex: 0,
      finalAssistantMessageIndex: 4,
      startIndex: 0,
      endIndex: 4,
    });

    s2.beginUserTurn([{ type: "text", text: "Follow-up task" }]);
    const model = JSON.stringify(s2.getMessagesForModel());
    expect(model).toContain("Original long-running task");
    expect(model).toContain("Also include the same-turn user steer");
    expect(model).toContain("Final answer for the original task");
    expect(model).not.toContain("hidden result a");
    expect(model).not.toContain("hidden result b");
    expect(s2.getMessagesForModel().some((message) => "turnId" in message)).toBe(false);
  });

  it("repairs a legacy internal convergence nudge that was persisted as a false user turn", () => {
    const legacyNudge = [
      "You are approaching the tool loop round limit (8/18; 10 round(s) left).",
      "Stop exploratory/retry tool calls now unless one final tool call is strictly necessary.",
    ].join("\n\n");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: [{ type: "text", text: "Original research task" }] }),
        JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: "legacy-call", name: "search", input: {} }] }),
        JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "legacy-call", content: "legacy hidden output" }] }),
        JSON.stringify({ role: "user", content: [{ type: "text", text: legacyNudge }] }),
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Legacy final answer" }] }),
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      `${file}.context.json`,
      JSON.stringify({
        version: 1,
        nextTurnId: 3,
        completedTurns: [
          { id: 1, userMessageIndex: 0, finalAssistantMessageIndex: 1, startIndex: 0, endIndex: 2 },
          { id: 2, userMessageIndex: 3, finalAssistantMessageIndex: 4, startIndex: 3, endIndex: 4 },
        ],
        resources: [],
      }),
      "utf-8",
    );

    const session = new PersistentSession({ sessionFile: file });
    const repaired = session.getSerializedContextState();
    expect(repaired?.completedTurns).toHaveLength(1);
    expect(repaired?.completedTurns[0]).toMatchObject({
      id: 1,
      userMessageIndex: 0,
      finalAssistantMessageIndex: 4,
      startIndex: 0,
      endIndex: 4,
    });

    session.beginUserTurn([{ type: "text", text: "Next real user task" }]);
    const model = JSON.stringify(session.getMessagesForModel());
    expect(model).toContain("Original research task");
    expect(model).toContain("Legacy final answer");
    expect(model).not.toContain("approaching the tool loop round limit");
    expect(model).not.toContain("legacy hidden output");
    // Raw audit history remains intact; compatibility changes only the model
    // projection and repaired context sidecar.
    const rawMessages = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rawMessages.some((message) => message.content?.some(
      (content: { type?: string; text?: string }) => content.type === "text" && content.text === legacyNudge,
    ))).toBe(true);
  });

  it("persists the execution plan and its frozen checkpoint context across restart", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Finish the multi-hour migration" }]);
    s1.updateExecutionPlan({
      steps: [
        { step: "Inventory callers", status: "completed" },
        { step: "Migrate storage", status: "in_progress" },
        { step: "Verify restart behavior", status: "pending" },
      ],
    });
    s1.addAssistantMessage([{ type: "tool_use", id: "call-plan", name: "bash", input: { command: "inspect" } }]);
    s1.addToolResult("call-plan", "inspection complete", undefined, false);
    s1.applyActiveCheckpointSummary("Inspection complete.", 2);

    const rawHistory = fs.readFileSync(file, "utf-8");
    const sidecar = fs.readFileSync(`${file}.context.json`, "utf-8");
    expect(rawHistory).not.toContain("executionPlan");
    expect(sidecar).toContain("executionPlan");
    expect(sidecar).toContain("Finish the multi-hour migration");

    const s2 = new PersistentSession({ sessionFile: file });
    const view = JSON.stringify(s2.getMessagesForModel());
    expect(view).toContain("Execution plan anchor");
    expect(view).toContain("Finish the multi-hour migration");
    expect(view).toContain("Migrate storage");
    expect(s2.getExecutionPlan()?.revision).toBe(1);
    expect(s2.getExecutionPlan()?.steps.map((step) => step.id)).toEqual([1, 2, 3]);
    expect(s2.getExecutionPlan()?.nextStepId).toBe(4);
  });

  it("does not rewrite the sidecar for an unchanged complete Plan snapshot", () => {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: "text", text: "Finish the durable migration" }]);
    const steps = [
      { step: "Inventory callers", status: "completed" as const },
      { step: "Migrate storage", status: "in_progress" as const },
    ];
    session.updateExecutionPlan({ explanation: "Initial transition", steps });
    const writeSpy = vi.spyOn(fs, "writeFileSync");

    const replay = session.updateExecutionPlan({
      explanation: "A paraphrased explanation is not new progress",
      steps,
    });

    expect(replay.revision).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("migrates persisted plans without step ids and keeps assigned ids stable", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Complete the durable migration" }]);
    s1.updateExecutionPlan({
      steps: [
        { step: "Inspect existing state", status: "in_progress" },
        { step: "Migrate durable state", status: "pending" },
      ],
    });

    const legacySidecar = JSON.parse(fs.readFileSync(`${file}.context.json`, "utf-8"));
    for (const step of legacySidecar.executionPlan.steps) delete step.id;
    delete legacySidecar.executionPlan.nextStepId;
    fs.writeFileSync(`${file}.context.json`, JSON.stringify(legacySidecar), "utf-8");

    const restored = new PersistentSession({ sessionFile: file });
    expect(restored.getExecutionPlan()?.steps.map((step) => step.id)).toEqual([1, 2]);
    const updated = restored.updateExecutionPlan({
      steps: [
        { step: "Inspect existing state", status: "completed" },
        { step: "Migrate durable state", status: "in_progress" },
        { step: "Verify restored state", status: "pending" },
      ],
    });
    expect(updated.steps.map((step) => step.id)).toEqual([1, 2, 3]);
    expect(updated.nextStepId).toBe(4);
  });

  it("persists completed-work evidence and plan audit tombstones across restart", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Complete the evidenced migration" }]);
    s1.updateExecutionPlan({
      steps: [{ step: "Run migration verification", status: "in_progress" }],
    });
    s1.recordCompletedWork({
      toolCallId: "verify-1",
      tool: "bash",
      inputDigest: "18:verify",
      inputSummary: '{"command":"npm test"}',
      status: "succeeded",
      resultSummary: "121 tests passed",
      checkpointEpoch: 1,
    });
    s1.updateExecutionPlan({
      steps: [{ step: "Run migration verification", status: "completed" }],
    });
    s1.applyActiveCheckpointSummary("Verification complete.", s1.length - 1);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.getCompletedWorkLedger()).toEqual([expect.objectContaining({
      id: 1,
      tool: "bash",
      status: "succeeded",
    })]);
    // The plan itself survives the reload; the ledger above is what records
    // which calls actually ran.
    expect(s2.getExecutionPlan()?.steps[0]).toMatchObject({ status: "completed" });
    expect(s2.getExecutionPlanAudit()).toHaveLength(2);
    expect(JSON.stringify(s2.getMessagesForModel())).toContain("Completed work ledger");

    s2.addMessage("user", [{ type: "text", text: "Verification accepted; clear the plan" }]);
    s2.clearExecutionPlan();
    const s3 = new PersistentSession({ sessionFile: file });
    expect(s3.getExecutionPlan()).toBeUndefined();
    expect(s3.getExecutionPlanAudit().at(-1)?.action).toBe("clear");
    expect(s3.getCompletedWorkLedger()).toHaveLength(1);
  });

  it("recomputes completed-work visibility after restart and checkpoint recovery", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Continue from the durable tool result" }]);
    s1.addAssistantMessage([{
      type: "tool_use",
      id: "call-durable",
      name: "bash",
      input: { command: "npm test" },
    }]);
    s1.addToolResult("call-durable", "DURABLE_RAW_RESULT", undefined, false);
    s1.recordCompletedWork({
      toolCallId: "call-durable",
      tool: "bash",
      inputDigest: "durable:1",
      inputSummary: "run npm test",
      status: "succeeded",
      resultSummary: "DURABLE_LEDGER_RESULT",
    });

    const s2 = new PersistentSession({ sessionFile: file });
    let modelView = JSON.stringify(s2.getMessagesForModel());
    expect(modelView).toContain("DURABLE_RAW_RESULT");
    expect(modelView).not.toContain("DURABLE_LEDGER_RESULT");
    expect(s2.getCompletedWorkLedger()).toHaveLength(1);

    s2.applyActiveCheckpointSummary("The durable command completed successfully.", 2);
    const s3 = new PersistentSession({ sessionFile: file });
    modelView = JSON.stringify(s3.getMessagesForModel());
    expect(modelView).not.toContain("DURABLE_RAW_RESULT");
    expect(modelView).toContain("DURABLE_LEDGER_RESULT");
    expect(s3.getCompletedWorkLedger()).toHaveLength(1);
  });

  it("applies the checkpoint summary hard bound at storage, not only in the preview", () => {
    // The runner passes CONTEXT_COMPACTION_SUMMARY_HARD_TOKENS to the
    // production session class. An override that drops the bound stores the
    // model's unbounded summary and the savings gate is fooled by the bounded
    // preview (2026-08-28 review B1-1).
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Long task with an oversized checkpoint" }]);
    s1.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }]);
    s1.addToolResult("call-1", "listing", undefined, false);
    const oversized = Array.from({ length: 400 }, (_, i) => `- fact ${i}: ${"x".repeat(40)}`).join("\n");
    const bound = 200;
    const preview = s1.previewActiveCheckpointTokens(oversized, 2, bound);
    const stored = s1.applyActiveCheckpointSummary(oversized, 2, bound);
    expect(stored.length).toBeLessThan(oversized.length);
    const reloaded = new PersistentSession({ sessionFile: file });
    const modelView = JSON.stringify(reloaded.getMessagesForModel());
    expect(modelView).not.toContain("fact 399");
    expect(reloaded.estimateModelTokens()).toBeLessThanOrEqual(preview + 50);
  });

  it("repairs restored turn context when indexes point at tool process rows", () => {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: [{ type: "text", text: "First task" }] }),
        JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: "call-old", name: "bash", input: { command: "echo hidden" } }] }),
        JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "call-old", content: "old hidden output", isError: false }] }),
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "First final answer" }] }),
        JSON.stringify({ role: "user", content: [{ type: "text", text: "Current task" }] }),
        JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: "call-current", name: "bash", input: { command: "echo current" } }] }),
        JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "call-current", content: "current output", isError: false }] }),
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      `${file}.context.json`,
      JSON.stringify({
        version: 1,
        nextTurnId: 99,
        historySummary: "older summary",
        summaryVersion: 2,
        completedTurns: [{
          id: 1,
          userMessageIndex: 1,
          finalAssistantMessageIndex: 3,
          startIndex: 1,
          endIndex: 3,
          archived: false,
        }],
        activeTurn: {
          id: 2,
          userMessageIndex: 5,
          startIndex: 5,
        },
        resources: [{ kind: "final_output", path: "/tmp/resource.mov", name: "resource.mov" }],
      }),
      "utf-8",
    );

    const s = new PersistentSession({ sessionFile: file });
    const model = JSON.stringify(s.getMessagesForModel());

    expect(model).toContain("older summary");
    expect(model).toContain("resource.mov");
    expect(model).toContain("First task");
    expect(model).toContain("First final answer");
    expect(model).toContain("Current task");
    expect(model).toContain("call-current");
    expect(model).toContain("current output");
    expect(model).not.toContain("call-old");
    expect(model).not.toContain("old hidden output");

    const repaired = JSON.parse(fs.readFileSync(`${file}.context.json`, "utf-8"));
    expect(repaired.completedTurns[0].userMessageIndex).toBe(0);
    expect(repaired.activeTurn.userMessageIndex).toBe(4);
  });

  it("tolerates corrupt + schema-invalid lines and keeps the valid ones", () => {
    // Mix of failure modes that show up in the wild: a half-written line
    // (process killed mid-append), an unknown role (older schema /
    // tampering), a non-array content (manual edit), plus blank tail.
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: [{ type: "text", text: "good 1" }] }),
        "{not valid json",
        JSON.stringify({ role: "robot", content: [{ type: "text", text: "wrong role" }] }),
        JSON.stringify({ role: "user", content: "string not array" }),
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "good 2" }] }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const s = new PersistentSession({ sessionFile: file });
    expect(s.length).toBe(2);
    expect(s.getMessages()[0].role).toBe("user");
    expect((s.getMessages()[0].content[0] as { text: string }).text).toBe("good 1");
    expect(s.getMessages()[1].role).toBe("assistant");
  });

  it("persistent-block shrink survives a restart via the sidecar", () => {
    const s = new PersistentSession({ sessionFile: file });
    s.beginUserTurn([{ type: "text", text: "long project" }]);
    s.addAssistantMessage([{ type: "text", text: "ack" }]);
    s.completeActiveTurn();
    s.applyHistorySummary("Original prose before the shrink.", [1]);

    s.applyPersistentBlockShrink("Shrunk prose after overflow recovery.");

    const reloaded = new PersistentSession({ sessionFile: file });
    const restored = reloaded.getSerializedContextState();
    expect(restored?.historySummary).toContain("Shrunk prose");
    expect(restored?.historySummary).not.toContain("Original prose");
  });

  it("clear truncates backing file", () => {
    const s = new PersistentSession({ sessionFile: file });
    s.addUserMessage("x");
    expect(fs.statSync(file).size).toBeGreaterThan(0);

    s.clear();
    expect(s.length).toBe(0);
    expect(fs.statSync(file).size).toBe(0);
  });

  it.each([undefined, "documents"])("paired tool calls preserve optional namespace %s through reload and active-turn projection", (namespace) => {
    // A resumed turn must replay the original call identity and result,
    // including legacy calls that predate namespace persistence.
    const s1 = new PersistentSession({ sessionFile: file });
    s1.beginUserTurn([{ type: "text", text: "Read the selected document" }]);
    const call = {
      type: "tool_use" as const, id: "call-123", name: "test_tool", input: {},
      ...(namespace !== undefined ? { namespace } : {}),
    };
    s1.addAssistantMessage([call]);
    s1.addToolResult("call-123", "tool output", undefined, false);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(3);
    expect(s2.getMessages()[1].content).toEqual([call]);
    expect(s2.getMessagesForModel()).toEqual(s1.getMessagesForModel());
    expect(s2.getMessagesForModel()[1].content).toEqual([call]);
    const toolResultMsg = s2.getMessages()[2];
    expect(toolResultMsg.role).toBe("user");
    const c = toolResultMsg.content[0];
    expect(c.type).toBe("tool_result");
    expect((c as { toolUseId: string }).toolUseId).toBe("call-123");
  });

  it("orphan tool_result (no preceding tool_use) is dropped at load", () => {
    // 锁住 `4773be73` 修的不变量:孤儿 tool_result 在 load 时被
    // healOrphanToolUses 丢弃。否则下一次 provider 调用会被拒
    // ("No tool call found for function call output with call_id ...")。
    // 之前生产报这个错频繁,fix 是在 load 时主动清理;这条测试守住"清"
    // 这个动作不能被未来的重构撤回。
    const s1 = new PersistentSession({ sessionFile: file });
    s1.addToolResult("call-orphan", "tool output", undefined, false);
    expect(s1.length).toBe(1); // 写入时不拦,刚 add 还在内存里

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(0); // load 时 healOrphanToolUses 把它丢了
  });

  it("orphan tool_result mixed with valid pair: orphan dropped, pair kept", () => {
    // 一条 user 消息可以同时携带多个 tool_result block——只丢孤儿那个,
    // 不要把整条 message 全删掉(否则会误伤同 message 里的合法 result)。
    const s1 = new PersistentSession({ sessionFile: file });
    s1.addAssistantMessage([
      { type: "tool_use", id: "call-good", name: "t1", input: {} } as MessageContent,
    ]);
    // 手工拼一条同时包含合法 + 孤儿两个 tool_result 的 user 消息
    s1.addMessage("user", [
      { type: "tool_result", toolUseId: "call-good",   content: "ok",     isError: false } as MessageContent,
      { type: "tool_result", toolUseId: "call-orphan", content: "stray",  isError: false } as MessageContent,
    ]);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(2);
    const blocks = s2.getMessages()[1].content;
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { toolUseId: string }).toolUseId).toBe("call-good");
  });

  it("creates parent directories if missing", () => {
    const nested = path.join(os.tmpdir(), `core-agent-psess-${Date.now()}`, "sub", "dir", "chat.jsonl");
    try {
      const s = new PersistentSession({ sessionFile: nested });
      s.addUserMessage("hi");
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(path.dirname(path.dirname(nested))), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Heal pass for orphan tool_use ────────────────────────────────────────
  // Background: when a prior run aborted (app killed, watchdog, user stop)
  // after the provider emitted an assistant `tool_use` but before the runner
  // persisted the matching `tool_result`, the session jsonl is left in a
  // state the OpenAI/Anthropic API rejects (tool_use must be followed by
  // tool_result for that id). The next turn then silently hangs waiting on
  // a response the server never produces. loadFromDisk heals these.

  describe("orphan tool_use heal on load", () => {
    it("synthesizes tool_result for a trailing orphan tool_use", () => {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "run social" }] }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-A", name: "some_tool", input: {} }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3); // user + assistant(tool_use) + synthetic user(tool_result)
      const last = msgs[2];
      expect(last.role).toBe("user");
      expect(last.content[0].type).toBe("tool_result");
      expect((last.content[0] as { toolUseId: string }).toolUseId).toBe("call-A");
      expect((last.content[0] as { isError: boolean }).isError).toBe(true);
      expect((last.content[0] as { content: string }).content).toMatch(/interrupted/i);
      expect(s.getLastToolProtocolRepairReport()).toMatchObject({
        changed: true,
        synthesizedOrphanResults: 1,
        droppedUnmatchedResults: 0,
        mergedParallelResultMessages: 0,
      });

      // Disk was rewritten — a fresh load produces the same state without
      // re-healing (idempotent).
      const s2 = new PersistentSession({ sessionFile: file });
      expect(s2.length).toBe(3);
      expect(s2.getMessages()[2].content[0].type).toBe("tool_result");
    });

    it("heals an orphan tool_use followed by an unrelated user text", () => {
      // This is the production bug: a long-running tool_use at index N
      // (e.g. abort/restart mid-execution), then the user typed a new
      // message at N+1 without any tool_result in between. The heal must
      // insert the synthetic result *before* the user's text, preserving
      // conversational order.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 1" }] }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-X", name: "some_tool", input: {} }],
          }),
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 2" }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
      // Synthetic tool_result sits between the tool_use and the user text.
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content[0].type).toBe("tool_result");
      expect((msgs[2].content[0] as { toolUseId: string }).toolUseId).toBe("call-X");
      expect(msgs[3].role).toBe("user");
      expect(msgs[3].content[0].type).toBe("text");
      expect((msgs[3].content[0] as { text: string }).text).toBe("round 2");
    });

    it("drops delayed tool_result after unrelated user text", () => {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 1" }] }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-late", name: "some_tool", input: {} }],
          }),
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 2" }] }),
          JSON.stringify({
            role: "user",
            content: [{ type: "tool_result", toolUseId: "call-late", content: "late result", isError: false }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content[0].type).toBe("tool_result");
      expect((msgs[2].content[0] as { isError: boolean }).isError).toBe(true);
      expect(msgs[3].role).toBe("user");
      expect(msgs[3].content).toEqual([{ type: "text", text: "round 2" }]);
    });

    it("removes misplaced tool_result blocks while preserving real user content", () => {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
          JSON.stringify({
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call-missing", content: "stray", isError: false },
              { type: "text", text: "keep me" },
            ],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(2);
      expect(msgs[1].content).toEqual([{ type: "text", text: "keep me" }]);
    });

    it("heals multiple orphan tool_uses in the same assistant message", () => {
      // Some providers emit parallel tool calls in one assistant turn. A
      // mid-flight abort orphans all of them at once; each needs its own
      // tool_result entry in the next message.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-1", name: "a", input: {} },
              { type: "tool_use", id: "call-2", name: "b", input: {} },
            ],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(2);
      const results = msgs[1].content;
      expect(results).toHaveLength(2);
      const ids = results.map((c) => (c as { toolUseId?: string }).toolUseId);
      expect(ids.sort()).toEqual(["call-1", "call-2"]);
    });

    it("heals a partial result set (some ids resolved, others orphaned)", () => {
      // Assistant called two tools; only one tool_result came back before
      // the crash. Heal must fill in the missing id and leave the existing
      // result in place.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-ok", name: "a", input: {} },
              { type: "tool_use", id: "call-orphan", name: "b", input: {} },
            ],
          }),
          JSON.stringify({
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call-ok", content: "ok", isError: false },
            ],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(2);
      const results = msgs[1].content;
      expect(results).toHaveLength(2);
      const byId = new Map(results.map((c) => [(c as { toolUseId: string }).toolUseId, c]));
      expect((byId.get("call-ok") as { isError: boolean }).isError).toBe(false);
      expect((byId.get("call-orphan") as { isError: boolean }).isError).toBe(true);
    });

    it("healAndPersist fixes a cached session mid-lifetime", () => {
      // Scenario: PersistentSession is cached (session-store.ts reuses the
      // same instance across turns). A turn aborts mid-tool-execution and
      // leaves an orphan tool_use in the in-memory Session. Constructor
      // heal doesn't re-fire. healAndPersist() must fix both in-memory
      // and on-disk state so the *next* turn sees a valid history.
      const s = new PersistentSession({ sessionFile: file });
      s.addUserMessage("run tool");
      s.addAssistantMessage([
        { type: "tool_use", id: "call-mid", name: "some_tool", input: {} },
      ]);
      // Simulate abort: tool_result never written. Session is now in a
      // broken state but still cached in memory.
      expect(s.length).toBe(2);
      expect(s.getMessages()[1].content[0].type).toBe("tool_use");

      // Post-turn heal hook runs in the `finally` block of client.ts.
      const healed = s.healAndPersist();
      expect(healed).toBe(true);
      expect(s.length).toBe(3);
      expect(s.getMessages()[2].content[0].type).toBe("tool_result");

      // Re-run is idempotent — second call shouldn't re-heal.
      expect(s.healAndPersist()).toBe(false);

      // Disk was persisted → a fresh construction of the same file reads
      // back the healed state.
      const fresh = new PersistentSession({ sessionFile: file });
      expect(fresh.length).toBe(3);
      expect(fresh.getMessages()[2].content[0].type).toBe("tool_result");
    });

    it("heals memory without rewriting the append-only jsonl (P0-1 no truncation)", () => {
      // A benign multi-tool turn (2 parallel tool_results) makes heal consolidate
      // the two tool_result messages in memory. healAndPersist must NOT flush that
      // shorter view over the append-only log — doing so would drop any history
      // older than the trimmed in-memory window.
      const s = new PersistentSession({ sessionFile: file });
      s.beginUserTurn([{ type: "text", text: "go" }]);
      s.addAssistantMessage([
        { type: "tool_use", id: "a", name: "a", input: {} },
        { type: "tool_use", id: "b", name: "b", input: {} },
      ]);
      s.addToolResult("a", "ra", undefined, false);
      s.addToolResult("b", "rb", undefined, false);

      const diskBefore = fs.readFileSync(file, "utf-8").trim().split("\n").length;
      expect(diskBefore).toBe(4); // user, assistant, tool_result(a), tool_result(b)

      expect(s.healAndPersist()).toBe(true); // merges the two tool_result messages
      const mem = s.getMessages();
      expect(mem).toHaveLength(3);
      expect(
        mem[2].content.filter((c) => (c as { type?: string }).type === "tool_result"),
      ).toHaveLength(2);

      // Append log is intact — not rewritten to the merged/trimmed view.
      const diskAfter = fs.readFileSync(file, "utf-8").trim().split("\n").length;
      expect(diskAfter).toBe(diskBefore);
    });

    it("preserves the history summary + resource ledger across a multi-tool heal (P0-1)", () => {
      const s = new PersistentSession({ sessionFile: file });
      // Turn 1, then roll it into a summary + record a produced resource.
      s.beginUserTurn([{ type: "text", text: "turn one" }]);
      s.addAssistantMessage([{ type: "tool_use", id: "t1", name: "a", input: {} }]);
      s.addToolResult("t1", "r1", undefined, false);
      s.completeActiveTurn();
      s.applyHistorySummary("rolling summary", [1]);
      s.addHistoryResource({ kind: "final_output", path: "/w/report.mov", name: "report.mov" });

      // Turn 2: two parallel tool_results — the benign heal trigger that used to
      // clear() and wipe turnState (summary + resources) on the next turn.
      s.beginUserTurn([{ type: "text", text: "turn two" }]);
      s.addAssistantMessage([
        { type: "tool_use", id: "t2a", name: "a", input: {} },
        { type: "tool_use", id: "t2b", name: "b", input: {} },
      ]);
      s.addToolResult("t2a", "r2a", undefined, false);
      s.addToolResult("t2b", "r2b", undefined, false);

      expect(s.getSerializedContextState()?.historySummary).toBe("rolling summary");
      expect(s.getSerializedContextState()?.resources).toHaveLength(1);

      expect(s.healAndPersist()).toBe(true);

      const after = s.getSerializedContextState();
      expect(after?.historySummary).toBe("rolling summary");
      expect(after?.resources).toHaveLength(1);
      expect(after?.resources[0].name).toBe("report.mov");
      expect(JSON.stringify(s.getMessagesForModel())).toContain("rolling summary");
    });

    it("merges parallel tool_results split across adjacent user messages", () => {
      // The runner's `addToolResult` writes one user message per tool_use_id.
      // So an assistant turn with 3 parallel tool_calls produces 3 adjacent
      // user messages on disk. Heal must NOT mistake the latter two for
      // orphans (the original i+1-only scan did) — it must scan the whole
      // contiguous tool_result cluster and consolidate.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "go" }] }),
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "p-0", name: "a", input: {} },
              { type: "tool_use", id: "p-1", name: "b", input: {} },
              { type: "tool_use", id: "p-2", name: "c", input: {} },
            ],
          }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-0", content: "r0", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-1", content: "r1", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-2", content: "r2", isError: false }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3); // user + assistant + ONE merged tool_result message
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content).toHaveLength(3);
      const ids = msgs[2].content.map((c) => (c as { toolUseId: string }).toolUseId);
      expect(ids).toEqual(["p-0", "p-1", "p-2"]); // order matches assistant's tool_uses
      // None of the results are interrupted — all are the real ones.
      expect(msgs[2].content.every((c) => (c as { content: string }).content !== INTERRUPTED_TOOL_RESULT)).toBe(true);
      expect(s.getLastToolProtocolRepairReport()).toMatchObject({
        changed: true,
        synthesizedOrphanResults: 0,
        droppedUnmatchedResults: 0,
        mergedParallelResultMessages: 2,
        deduplicatedResults: 0,
      });
    });

    it("dedupes a tool_call_id that appears as both interrupted and real", () => {
      // Reproduces the corruption that an earlier heal-with-i+1-only logic
      // could produce: assistant has 3 parallel tool_uses, the first user
      // message after assistant carried only the first real result, then
      // heal mistakenly synthesized "interrupted" markers for the other two
      // (because it didn't see the real results in subsequent user
      // messages). The corrupt jsonl ended up with each tool_call_id
      // having both an interrupted and a real result. DeepSeek 400s on
      // duplicate tool_call_id. Heal must dedupe and prefer the real one.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "go" }] }),
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "c-0", name: "a", input: {} },
              { type: "tool_use", id: "c-1", name: "b", input: {} },
              { type: "tool_use", id: "c-2", name: "c", input: {} },
            ],
          }),
          JSON.stringify({
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "c-0", content: "r0", isError: false },
              { type: "tool_result", toolUseId: "c-1", content: INTERRUPTED_TOOL_RESULT, isError: true },
              { type: "tool_result", toolUseId: "c-2", content: INTERRUPTED_TOOL_RESULT, isError: true },
            ],
          }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "c-1", content: "r1", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "c-2", content: "r2", isError: false }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3);
      const results = msgs[2].content as Array<{ toolUseId: string; content: string; isError: boolean }>;
      expect(results).toHaveLength(3);
      const byId = new Map(results.map((r) => [r.toolUseId, r]));
      // Real results win over earlier-seen interrupted markers.
      expect(byId.get("c-0")!.content).toBe("r0");
      expect(byId.get("c-1")!.content).toBe("r1");
      expect(byId.get("c-2")!.content).toBe("r2");
      expect(results.every((r) => !r.content.includes("interrupted"))).toBe(true);
      expect(s.getLastToolProtocolRepairReport().deduplicatedResults).toBe(2);
    });

    it("leaves a well-formed history untouched", () => {
      // Regression guard: tool_use followed by tool_result = healthy.
      // Heal pass must be a no-op; flush must NOT rewrite the file.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-OK", name: "a", input: {} }],
          }),
          JSON.stringify({
            role: "user",
            content: [{ type: "tool_result", toolUseId: "call-OK", content: "done", isError: false }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const mtimeBefore = fs.statSync(file).mtimeMs;

      // Sleep a tick so any write would leave a detectable mtime delta.
      const s = new PersistentSession({ sessionFile: file });
      expect(s.length).toBe(2);
      expect(s.getMessages()[1].content).toHaveLength(1);

      // No heal fired → no flushToDisk → mtime unchanged within the
      // resolution of fs.statSync (ms). We accept equality OR tiny drift.
      const mtimeAfter = fs.statSync(file).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });
});
