import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { defineTool, toToolDefinition, getBuiltinTools } from "../src/tools/index.js";
import { DEFAULT_BASH_TIMEOUT_MS, normalizeBashTimeoutMs } from "../src/tools/builtin.js";
import type { ToolContext } from "../src/tools/index.js";

describe("Tools", () => {
  describe("defineTool", () => {
    it("creates a tool with all required fields", () => {
      const tool = defineTool({
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return { content: "ok" };
        },
      });

      expect(tool.name).toBe("test_tool");
      expect(tool.description).toBe("A test tool");
      expect(typeof tool.execute).toBe("function");
    });

    it("executes and returns result", async () => {
      const tool = defineTool({
        name: "echo",
        description: "Echo input",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        async execute(input) {
          return { content: input.text as string };
        },
      });

      const ctx: ToolContext = { state: {} };
      const result = await tool.execute({ text: "hello" }, ctx);
      expect(result.content).toBe("hello");
      expect(result.isError).toBeUndefined();
    });
  });

  describe("toToolDefinition", () => {
    it("converts AgentTool to ToolDefinition", () => {
      const tool = defineTool({
        name: "my_tool",
        description: "desc",
        inputSchema: { type: "object" },
        async execute() {
          return { content: "" };
        },
      });

      const def = toToolDefinition(tool);
      expect(def).toEqual({
        name: "my_tool",
        description: "desc",
        inputSchema: { type: "object" },
      });
    });

    it("keeps descriptions intact while warning on soft-budget overruns", () => {
      const longDescription = "Use this tool carefully. " + "detail ".repeat(120);
      const modeDescription = "Choose execution mode. " + "extra ".repeat(80);
      const tool = defineTool({
        name: "schema_tool",
        description: longDescription,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["mode"],
          properties: {
            mode: {
              type: "string",
              enum: ["fast", "safe"],
              description: modeDescription,
              examples: ["fast"],
            },
            count: { type: "number", minimum: 1, maximum: 10 },
          },
          examples: [{ mode: "fast" }],
        },
        async execute() {
          return { content: "" };
        },
      });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const def = toToolDefinition(tool);
        expect(def.description).toBe(longDescription.trim());
        expect(def.inputSchema).toMatchObject({
          type: "object",
          required: ["mode"],
          properties: {
            mode: { type: "string", enum: ["fast", "safe"] },
            count: { type: "number", minimum: 1, maximum: 10 },
          },
        });
        expect(def.inputSchema).not.toHaveProperty("$schema");
        expect(def.inputSchema).not.toHaveProperty("examples");
        const modeSchema = (def.inputSchema.properties as Record<string, Record<string, unknown>>).mode;
        expect(modeSchema.description).toBe(modeDescription.trim());
        expect(modeSchema).not.toHaveProperty("examples");
        expect(warn).toHaveBeenCalledWith(
          "[tool-definitions]",
          "tool definition description exceeds soft budget; sent untruncated",
          expect.objectContaining({
            tool: "schema_tool",
            field: "tool description",
            softBudget: 480,
          }),
        );
        expect(warn).toHaveBeenCalledWith(
          "[tool-definitions]",
          "tool definition description exceeds soft budget; sent untruncated",
          expect.objectContaining({
            tool: "schema_tool",
            field: "schema description at /inputSchema/properties/mode",
            softBudget: 220,
          }),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("getBuiltinTools", () => {
    it("returns an array of tools", () => {
      const tools = getBuiltinTools();
      expect(tools.length).toBeGreaterThan(0);

      const names = tools.map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("write_file");
      expect(names).toContain("bash");
      expect(names).toContain("list_files");
    });
  });

  describe("read_file tool", () => {
    it("reads an existing file", async () => {
      const tools = getBuiltinTools();
      const readFile = tools.find((t) => t.name === "read_file")!;

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-test-"));
      const testFile = path.join(tmpDir, "test.txt");
      await fs.writeFile(testFile, "line1\nline2\nline3\n");

      const ctx: ToolContext = { workingDir: tmpDir, state: {} };
      const result = await readFile.execute({ path: testFile }, ctx);
      expect(result.content).toContain("line1");
      expect(result.isError).toBeUndefined();

      await fs.rm(tmpDir, { recursive: true });
    });

    it("returns error for non-existent file", async () => {
      const tools = getBuiltinTools();
      const readFile = tools.find((t) => t.name === "read_file")!;

      const ctx: ToolContext = { state: {} };
      const result = await readFile.execute({ path: "/tmp/nonexistent-file-xyz.txt" }, ctx);
      expect(result.isError).toBe(true);
    });

    it("supports maxLines parameter", async () => {
      const tools = getBuiltinTools();
      const readFile = tools.find((t) => t.name === "read_file")!;

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-test-"));
      const testFile = path.join(tmpDir, "test.txt");
      await fs.writeFile(testFile, "line1\nline2\nline3\nline4\nline5\n");

      const ctx: ToolContext = { workingDir: tmpDir, state: {} };
      const result = await readFile.execute({ path: testFile, maxLines: 2 }, ctx);
      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
      expect(result.content).not.toContain("line3");

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("bash tool", () => {
    it("uses the long default only for missing or legacy-synthetic timeout values", () => {
      expect(normalizeBashTimeoutMs(undefined)).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(-1)).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(30_000)).toBe(30_000);
      expect(normalizeBashTimeoutMs(300_000)).toBe(300_000);
      expect(normalizeBashTimeoutMs(30_000, { legacyDefault: true })).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(300_000, { legacyDefault: true })).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(5_000)).toBe(5_000);
    });

    it("executes a shell command", async () => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;

      const ctx: ToolContext = { state: {} };
      const result = await bash.execute({ command: "echo hello" }, ctx);
      expect(result.content.trim()).toBe("hello");
    });

    it("returns error for failing command", async () => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;

      const ctx: ToolContext = { state: {} };
      const result = await bash.execute({ command: "false" }, ctx);
      expect(result.isError).toBe(true);
    });

    it("forwards ctx.state.sandboxEnv to the child process", async () => {
      // Locks in the contract that skill scripts rely on:
      // `ctx.state.sandboxEnv` must reach the spawned shell as real env vars.
      // Without this, `$ORKAS_NODE` / `$ORKAS_PC_DIR` in SKILL.md commands
      // expand to empty and skills silently no-op.
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;

      const ctx: ToolContext = {
        state: { sandboxEnv: { ORKAS_TEST_TOKEN: "propagated-abc123" } },
      };
      const result = await bash.execute(
        { command: "echo $ORKAS_TEST_TOKEN" },
        ctx,
      );
      expect(result.content.trim()).toBe("propagated-abc123");
      expect(result.isError).toBeUndefined();
    });
  });
});
