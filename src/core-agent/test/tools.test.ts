import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createExecutionPlanTool, defineTool, toToolDefinition, getBuiltinTools } from "../src/tools/index.js";
import { Session } from "../src/agent/session.js";
import { DEFAULT_BASH_TIMEOUT_MS, normalizeBashTimeoutMs } from "../src/tools/builtin.js";
import { MAX_WEB_FETCH_RESPONSE_BYTES } from "../src/tools/web-fetch.js";
import type { ToolContext } from "../src/tools/index.js";

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

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

  describe("manage_execution_plan tool", () => {
    it("downgrades a redundant replace_objective replay to a guarded status update", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the original task" }]);
      session.updateExecutionPlan({
        steps: [{ step: "Complete the work", status: "in_progress" }],
      });
      session.addMessage("user", [{ type: "text", text: "Also include the revised requirement" }]);
      const tool = createExecutionPlanTool({
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };
      const revisedPlan = [
        { step: "Complete the work", status: "completed" },
        { step: "Include the revised requirement", status: "in_progress" },
      ];

      const first = await tool.execute({
        action: "update",
        replace_objective: true,
        plan: revisedPlan,
      }, context);
      const replay = await tool.execute({
        action: "update",
        replace_objective: true,
        plan: revisedPlan,
      }, context);

      expect(first.isError).toBeUndefined();
      expect(JSON.parse(first.content)).toMatchObject({ replace_objective_applied: true });
      expect(replay.isError).toBeUndefined();
      expect(JSON.parse(replay.content)).toMatchObject({ replace_objective_applied: false });
      expect(session.getExecutionPlan()?.objective).toBe("Also include the revised requirement");

      const unsafeReplay = await tool.execute({
        action: "update",
        replace_objective: true,
        plan: [{ step: "Do less work", status: "completed" }],
      }, context);
      expect(unsafeReplay.isError).toBe(true);
      expect(unsafeReplay.content).toContain("cannot remove or rename existing milestones");
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

  describe("web_fetch tool", () => {
    it("does not apply the former 50K default truncation before Result Store handling", async () => {
      const body = "x".repeat(60_000);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })));
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute({ url: "https://example.test/large.txt" }, { state: {} });
        expect(result.content).toBe(body);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("still honors an explicit maxChars request", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("abcdef", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })));
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute(
          { url: "https://example.test/limited.txt", maxChars: 3 },
          { state: {} },
        );
        expect(result.content).toContain("abc");
        expect(result.content).toContain("explicitly requested maxChars");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("returns a complete body beyond the former 2MB transport cap", async () => {
      const body = "x".repeat(2_100_000);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })));
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute({ url: "https://example.test/large-body.txt" }, { state: {} });
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe(body);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("rejects a declared body above the hard response limit without a partial page", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("UNIQUE_RESPONSE_FRAGMENT", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(MAX_WEB_FETCH_RESPONSE_BYTES + 1),
        },
      })));
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute({ url: "https://example.test/too-large.txt" }, { state: {} });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("E_FETCH_RESPONSE_TOO_LARGE");
        expect(result.content).toContain("No partial page was returned");
        expect(result.content).not.toContain("UNIQUE_RESPONSE_FRAGMENT");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("rejects an undeclared streaming body that crosses the hard response limit", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024 * 1024));
          controller.close();
        },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })));
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute({ url: "https://example.test/stream-too-large.txt" }, { state: {} });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("E_FETCH_RESPONSE_TOO_LARGE");
        expect(result.content).toContain("while streaming");
        expect(result.content).toContain("No partial page was returned");
      } finally {
        vi.unstubAllGlobals();
      }
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

    it("hands large stdout to the host through a complete spool file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-bash-spool-test-"));
      const outputBytes = 1024 * 1024 + 257;
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      try {
        const bash = getBuiltinTools().find((tool) => tool.name === "bash")!;
        const result = await bash.execute({
          command: `${quote(TEST_NODE)} -e ${quote(`process.stdout.write('x'.repeat(${outputBytes}))`)}`,
        }, {
          workingDir: tmpDir,
          state: { toolResultSpoolDir: path.join(tmpDir, "results") },
        });

        expect(result.isError).toBeUndefined();
        expect(result.content).toContain("full output streamed to Result Store");
        expect(result.streamedOutput).toMatchObject({ size: outputBytes });
        await expect(fs.stat(result.streamedOutput!.path)).resolves.toMatchObject({ size: outputBytes });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
