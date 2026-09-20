import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileReadObservation } from "../src/tools/base.js";
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

  it("does not re-read an unchanged tracked file on the next reconcile, but re-hashes once it changes", () => {
    // Reconcile runs before every model call; re-reading and re-hashing every
    // tracked file each time was the per-turn cost (H-6). Size+mtime decide
    // whether the remembered hash is still current.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-workspace-memo-"));
    try {
      const filePath = path.join(dir, "tracked.ts");
      const observed = "export const value = 1;\n";
      const external = "export const value = 2;\n";
      fs.writeFileSync(filePath, observed);
      const hash = (body: string) =>
        `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "keep the file" }]);
      session.recordToolObservations({
        tool: "edit_file",
        observations: {
          fileChanges: [{
            operation: "update", sourcePath: filePath, beforeExists: true, afterExists: true,
            beforeHash: hash("x"), afterHash: hash(observed),
            beforeBytes: 1, afterBytes: Buffer.byteLength(observed),
            beforeContent: "x", afterContent: observed, coverage: "exact",
          }],
        },
      });

      expect(session.reconcileWorkspaceObservations()).toBeUndefined();
      const readSpy = vi.spyOn(fs, "readFileSync");
      try {
        expect(session.reconcileWorkspaceObservations()).toBeUndefined();
        expect(readSpy.mock.calls.filter(([target]) => String(target) === filePath)).toHaveLength(0);

        // A content change with a new mtime/size is read and hashed again.
        const later = new Date(Date.now() + 2_000);
        fs.writeFileSync(filePath, external);
        fs.utimesSync(filePath, later, later);
        const reconciled = session.reconcileWorkspaceObservations();
        expect(reconciled?.fileChanges?.[0]).toMatchObject({ afterHash: hash(external) });
        expect(readSpy.mock.calls.filter(([target]) => String(target) === filePath)).toHaveLength(1);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["overwrite", "replace"])("reconciles a same-size external %s that preserves mtime", async (operation) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-workspace-preserved-time-"));
    try {
      const filePath = path.join(dir, "tracked.txt");
      const observed = "version one\n";
      const external = "version two\n";
      const fixedTime = new Date("2026-01-01T00:00:00Z");
      const hash = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;
      fs.writeFileSync(filePath, observed);
      fs.utimesSync(filePath, fixedTime, fixedTime);
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "inspect the file" }]);
      session.recordToolObservations({
        tool: "read_file", observations: { fileReads: [{ path: filePath, hash: hash(observed) }] },
      });
      expect(session.reconcileWorkspaceObservations()).toBeUndefined();
      // Separate metadata changes even on filesystems with coarse timestamp precision.
      await new Promise(resolve => setTimeout(resolve, 20));
      const target = operation === "replace" ? path.join(dir, "replacement.txt") : filePath;
      fs.writeFileSync(target, external);
      fs.utimesSync(target, fixedTime, fixedTime);
      if (operation === "replace") fs.renameSync(target, filePath);
      expect(fs.statSync(filePath).size).toBe(Buffer.byteLength(observed));
      expect(fs.statSync(filePath).mtimeMs).toBe(fixedTime.getTime());
      expect(session.reconcileWorkspaceObservations()?.fileChanges?.[0]).toMatchObject({
        beforeHash: hash(observed), afterHash: hash(external), afterContent: external, coverage: "exact",
      });
      const read = vi.spyOn(fs, "readFileSync");
      try {
        expect(session.reconcileWorkspaceObservations()).toBeUndefined();
        expect(read.mock.calls.filter(([target]) => String(target) === filePath)).toHaveLength(0);
      } finally {
        read.mockRestore();
      }
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

  // Source coverage helps investigate compaction costs, but does not establish
  // causation or whether a verification read was necessary.
  const read = (session: Session, callId: string, filePath: string, content: string) => {
    session.addAssistantMessage([{ type: "tool_use", id: callId, name: "read_file", input: { path: filePath } }]);
    session.addToolResult(callId, content, undefined, false);
    session.recordToolObservations({
      toolCallId: callId,
      tool: "read_file",
      observations: { fileReads: [{ path: filePath, hash: hash(content), charRange: [0, content.length] }] },
    });
  };

  it("counts only reads that repeat what was already read before the boundary", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "task" }]);

    read(session, "r1", "/w/a.ts", "alpha");
    read(session, "r2", "/w/b.ts", "beta");
    const cursor = session.workspaceObservationCursor();

    // Same source range and version. This measures coverage, not whether the read was useful.
    read(session, "r3", "/w/a.ts", "alpha");
    // Changed versions do not establish which source ranges still overlap.
    read(session, "r4", "/w/b.ts", "beta-v2");
    // A path never seen before the boundary is not a re-read at all.
    read(session, "r5", "/w/c.ts", "gamma");

    const repetition = session.readRepetitionSince(cursor);
    expect(repetition.readsAfter).toBe(3);
    expect(repetition.repeatedPaths).toBe(2);
    expect(repetition.repeatedIdenticalContent).toBe(1);
    expect(repetition.newRangeReads).toBe(1);
    expect(repetition.unknownRangeReads).toBe(1);
  });

  // Full-file hashes are deliberately identical across different excerpts.
  // Expected classifications describe source coverage, independently of selection logic.
  type ReadShape = Omit<FileReadObservation, "path">;
  const chars = (start: number, end: number): ReadShape => ({ hash: "v1", charRange: [start, end] });
  const lines = (start: number, end: number): ReadShape => ({ hash: "v1", lineRange: [start, end] });
  it.each<{ name: string; before: ReadShape[]; after: ReadShape; category: string }>([
    { name: "same excerpt", before: [chars(0, 100)], after: chars(0, 100), category: "repeatedIdenticalContent" },
    { name: "subset", before: [chars(0, 100)], after: chars(20, 40), category: "repeatedIdenticalContent" },
    { name: "adjacent prior excerpts cover the request", before: [chars(50, 100), chars(0, 50)], after: chars(0, 100), category: "repeatedIdenticalContent" },
    { name: "overlapping excerpts with a gap", before: [chars(0, 40), chars(20, 50), chars(60, 100)], after: chars(0, 100), category: "repeatedPartialContent" },
    { name: "extended range", before: [chars(0, 100)], after: chars(50, 150), category: "repeatedPartialContent" },
    { name: "adjacent character ranges do not overlap", before: [chars(0, 100)], after: chars(100, 200), category: "newRangeReads" },
    { name: "disjoint lines", before: [lines(1, 100)], after: lines(101, 200), category: "newRangeReads" },
    { name: "line endpoints are inclusive", before: [lines(1, 100)], after: lines(100, 200), category: "repeatedPartialContent" },
    { name: "single line", before: [lines(1, 100)], after: lines(100, 100), category: "repeatedIdenticalContent" },
    { name: "changed version", before: [chars(0, 100)], after: { ...chars(0, 100), hash: "v2" }, category: "unknownRangeReads" },
    { name: "missing version", before: [chars(0, 100)], after: { charRange: [0, 100] }, category: "unknownRangeReads" },
    { name: "legacy prior read lacks range", before: [{ hash: "v1" }], after: chars(0, 100), category: "unknownRangeReads" },
    { name: "current read lacks range", before: [chars(0, 100)], after: { hash: "v1" }, category: "unknownRangeReads" },
    { name: "incomparable coordinates", before: [lines(1, 100)], after: chars(0, 100), category: "unknownRangeReads" },
    { name: "character coverage overrides coarse line metadata", before: [{ ...chars(0, 10), lineRange: [1, 1] }], after: { ...chars(10, 20), lineRange: [1, 1] }, category: "newRangeReads" },
    { name: "empty result", before: [chars(0, 100)], after: chars(100, 100), category: "emptyReads" },
    { name: "reversed range", before: [chars(0, 100)], after: chars(100, 0), category: "unknownRangeReads" },
    { name: "fractional range", before: [chars(0, 100)], after: chars(0.5, 10), category: "unknownRangeReads" },
    { name: "known coverage despite an unknown prior range", before: [{ hash: "v1" }, chars(0, 100)], after: chars(0, 100), category: "repeatedIdenticalContent" },
    { name: "unknown prior range prevents a claim of new content", before: [{ hash: "v1" }, chars(0, 10)], after: chars(20, 30), category: "unknownRangeReads" },
  ])("classifies $name without equating a file version with an excerpt", ({ before, after, category }) => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect the relevant code" }]);
    const observe = (read: ReadShape) => session.recordToolObservations({
      tool: "read_files", observations: { fileReads: [{ path: "/w/source.ts", ...read }] },
    });
    before.forEach(observe);
    const boundary = session.workspaceObservationCursor();
    observe(after);
    const expected = {
      readsAfter: 1, repeatedPaths: 1, repeatedIdenticalContent: 0,
      repeatedPartialContent: 0, newRangeReads: 0, unknownRangeReads: 0, emptyReads: 0,
      [category]: 1,
    };
    const actual = session.readRepetitionSince(boundary);
    expect(actual.repeatedIdenticalContent).toBe(category === "repeatedIdenticalContent" ? 1 : 0);
    expect(actual).toEqual(expected);
  });

  it("keeps range classifications across session state restoration", () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Inspect code" }]);
    session.recordToolObservations({ tool: "read_files", observations: {
      fileReads: [{ path: "/w/a.ts", hash: "v1", charRange: [0, 100] }],
    } });
    const cursor = session.workspaceObservationCursor();
    session.recordToolObservations({ tool: "read_files", observations: {
      fileReads: [{ path: "/w/a.ts", hash: "v1", charRange: [100, 200] }],
    } });
    const restored = new Session();
    for (const message of session.getMessages()) restored.addMessage(message.role, message.content, message.turnId);
    restored.restoreContextState(session.getSerializedContextState());
    expect(restored.readRepetitionSince(cursor)).toMatchObject({
      readsAfter: 1, repeatedPaths: 1, repeatedIdenticalContent: 0, newRangeReads: 1,
    });
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
      repeatedPartialContent: 0,
      newRangeReads: 0,
      unknownRangeReads: 0,
      emptyReads: 0,
    });
  });
});
