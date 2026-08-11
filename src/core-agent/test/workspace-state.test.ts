import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Session } from "../src/agent/session.js";
import { getBuiltinTools } from "../src/tools/builtin.js";
import {
  WORKSPACE_DIFF_PROVIDER_STATE_KEY,
  type WorkspaceDiffProvider,
} from "../src/tools/workspace-diff.js";

describe("workspace_diff", () => {
  it("delegates its read-only request to the runner-provided ledger", async () => {
    const tool = getBuiltinTools().find((candidate) => candidate.name === "workspace_diff")!;
    const provider: WorkspaceDiffProvider = (request) => ({
      content: `scope=${request.scope ?? "turn"}`,
    });
    const result = await tool.execute({ scope: "session" }, {
      state: { [WORKSPACE_DIFF_PROVIDER_STATE_KEY]: provider },
    });
    expect(result).toEqual({ content: "scope=session" });
  });

  it("renders and persists a net text diff from structured tool observations", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "update the greeting" }]);
    session.recordToolObservations({
      toolCallId: "call-1",
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/greeting.ts",
          beforeExists: true,
          afterExists: true,
          beforeHash: "sha256:before",
          afterHash: "sha256:after",
          beforeContent: "export const greeting = 'hello';\n",
          afterContent: "export const greeting = 'hi';\n",
          beforeBytes: 33,
          afterBytes: 30,
          coverage: "exact",
        }],
      },
    });

    const diff = session.renderWorkspaceDiff({ scope: "turn", format: "unified" }, "/workspace");
    expect(diff).toContain('files_changed="1"');
    expect(diff).toContain("M greeting.ts");
    expect(diff).toContain("-export const greeting = 'hello';");
    expect(diff).toContain("+export const greeting = 'hi';");

    const serialized = session.getSerializedContextState();
    const restored = new Session();
    restored.beginUserTurn([{ type: "text", text: "placeholder" }]);
    restored.restoreContextState(serialized);
    expect(restored.getWorkspaceObservations().entries).toHaveLength(1);
  });

  it("collapses repeated changes to the same file into one current-turn diff", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "edit twice" }]);
    session.recordToolObservations({
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/a.ts",
          beforeExists: true,
          afterExists: true,
          beforeContent: "one\n",
          afterContent: "two\n",
          beforeHash: "sha256:one",
          afterHash: "sha256:two",
          coverage: "exact",
        }],
      },
    });
    session.recordToolObservations({
      tool: "edit_file",
      observations: {
        fileChanges: [{
          operation: "update",
          sourcePath: "/workspace/a.ts",
          beforeExists: true,
          afterExists: true,
          beforeContent: "two\n",
          afterContent: "three\n",
          beforeHash: "sha256:two",
          afterHash: "sha256:three",
          coverage: "exact",
        }],
      },
    });
    const diff = session.renderWorkspaceDiff({ format: "unified" }, "/workspace");
    expect(diff).toContain('files_changed="1"');
    expect(diff).toContain("-one");
    expect(diff).toContain("+three");
    expect(diff).not.toContain("+two");
  });

  it("preserves the original baseline after the raw observation window compacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-workspace-compact-"));
    try {
      const filePath = path.join(dir, "long-task.ts");
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "perform a long edit sequence" }]);
      session.recordToolObservations({
        tool: "write_file",
        observations: {
          fileChanges: [{
            operation: "create",
            sourcePath: filePath,
            beforeExists: false,
            afterExists: true,
            afterContent: "value=0\n",
            afterHash: "sha256:0",
            coverage: "exact",
          }],
        },
      });
      for (let index = 1; index <= 256; index++) {
        session.recordToolObservations({
          tool: "edit_file",
          observations: {
            fileChanges: [{
              operation: "update",
              sourcePath: filePath,
              beforeExists: true,
              afterExists: true,
              beforeContent: `value=${index - 1}\n`,
              afterContent: `value=${index}\n`,
              beforeHash: `sha256:${index - 1}`,
              afterHash: `sha256:${index}`,
              coverage: "exact",
            }],
          },
        });
      }
      fs.writeFileSync(filePath, "value=256\n");

      const observations = session.getWorkspaceObservations();
      expect(observations.entries).toHaveLength(256);
      expect(observations.compacted?.sessionFileChanges).toHaveLength(1);
      const diff = session.renderWorkspaceDiff(
        { scope: "session", format: "unified" },
        dir,
      );
      expect(diff).toContain("A long-task.ts");
      expect(diff).toContain("--- /dev/null");
      expect(diff).toContain("+value=256");
      expect(diff).not.toContain("-value=0");

      const restored = new Session();
      restored.restoreContextState(session.getSerializedContextState());
      const restoredDiff = restored.renderWorkspaceDiff(
        { scope: "session", format: "summary" },
        dir,
      );
      expect(restoredDiff).toContain("A long-task.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles an external edit to an already tracked file before the next model call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-workspace-state-"));
    try {
      const filePath = path.join(dir, "tracked.ts");
      const original = "export const value = 0;\n";
      const observed = "export const value = 1;\n";
      const external = "export const value = 2;\n";
      fs.writeFileSync(filePath, observed);
      const hash = (body: string) =>
        `sha256:${createHash("sha256").update(body).digest("hex")}`;

      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "update the value" }]);
      session.recordToolObservations({
        tool: "edit_file",
        observations: {
          fileChanges: [{
            operation: "update",
            sourcePath: filePath,
            beforeExists: true,
            afterExists: true,
            beforeHash: hash(original),
            afterHash: hash(observed),
            beforeBytes: Buffer.byteLength(original),
            afterBytes: Buffer.byteLength(observed),
            beforeContent: original,
            afterContent: observed,
            coverage: "exact",
          }],
        },
      });

      fs.writeFileSync(filePath, external);
      const reconciled = session.reconcileWorkspaceObservations();
      expect(reconciled?.tool).toBe("workspace_reconcile");
      expect(reconciled?.fileChanges?.[0]).toMatchObject({
        operation: "update",
        beforeHash: hash(observed),
        afterHash: hash(external),
        beforeContent: observed,
        afterContent: external,
        coverage: "exact",
      });

      const diff = session.renderWorkspaceDiff(
        { scope: "turn", format: "unified" },
        dir,
      );
      expect(diff).toContain("-export const value = 0;");
      expect(diff).toContain("+export const value = 2;");
      expect(diff).toContain('stale="0"');
      expect(session.reconcileWorkspaceObservations()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects an external edit to a file that was observed only by a read tool", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-workspace-read-"));
    try {
      const filePath = path.join(dir, "read-only.ts");
      const before = "export const mode = 'before';\n";
      const after = "export const mode = 'after';\n";
      const hash = (body: string) =>
        `sha256:${createHash("sha256").update(body).digest("hex")}`;
      fs.writeFileSync(filePath, before);

      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "inspect then continue" }]);
      session.recordToolObservations({
        tool: "read_file",
        observations: {
          fileReads: [{ path: filePath, hash: hash(before) }],
        },
      });
      fs.writeFileSync(filePath, after);

      const reconciled = session.reconcileWorkspaceObservations();
      expect(reconciled?.fileChanges?.[0]).toMatchObject({
        operation: "update",
        sourcePath: filePath,
        beforeHash: hash(before),
        afterHash: hash(after),
        coverage: "exact",
      });
      const context = JSON.stringify(session.getMessagesForModel());
      expect(session.getWorkspaceObservations().entries.at(-1)?.tool).toBe("workspace_reconcile");
      expect(context).toContain("read-only.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("read repetition after a compaction boundary", () => {
  const hash = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

  // Compaction trades context size against re-reading: whatever the checkpoint
  // fails to carry, the model fetches again. The budget ratios and ceilings in
  // context-budget.ts were set conservatively and are meant to be calibrated
  // against this number rather than by argument, so it has to separate a
  // genuine re-read from a first read and from a read of changed content.
  const read = (session: Session, callId: string, filePath: string, content: string) => {
    session.addAssistantMessage([{ type: "tool_use", id: callId, name: "read_file", input: { path: filePath } }]);
    session.addToolResult(callId, content, undefined, false);
    session.recordToolObservations({
      toolCallId: callId,
      tool: "read_file",
      observations: { fileReads: [{ path: filePath, hash: hash(content) }] },
    });
  };

  it("counts only reads that repeat what was already read before the boundary", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "task" }]);

    read(session, "r1", "/w/a.ts", "alpha");
    read(session, "r2", "/w/b.ts", "beta");
    const cursor = session.workspaceObservationCursor();

    // Same path, same content — the re-read recovered nothing.
    read(session, "r3", "/w/a.ts", "alpha");
    // Same path, different content — the file genuinely changed, so re-reading
    // it was necessary, not waste.
    read(session, "r4", "/w/b.ts", "beta-v2");
    // A path never seen before the boundary is not a re-read at all.
    read(session, "r5", "/w/c.ts", "gamma");

    const repetition = session.readRepetitionSince(cursor);
    expect(repetition.readsAfter).toBe(3);
    expect(repetition.repeatedPaths).toBe(2);
    expect(repetition.repeatedIdenticalContent).toBe(1);
  });

  it("reports nothing before any boundary has been recorded", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "task" }]);
    read(session, "r1", "/w/a.ts", "alpha");
    // Cursor taken after every read: nothing falls after it.
    expect(session.readRepetitionSince(session.workspaceObservationCursor())).toEqual({
      readsAfter: 0,
      repeatedPaths: 0,
      repeatedIdenticalContent: 0,
    });
  });
});
