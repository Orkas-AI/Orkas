import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createExecutionPlanTool, defineTool, toToolDefinition, getBuiltinTools } from "../src/tools/index.js";
import { Session, EXECUTION_PLAN_MAX_STEPS, EXECUTION_PLAN_MAX_STEP_CHARS } from "../src/agent/session.js";
import { DEFAULT_BASH_TIMEOUT_MS, normalizeBashTimeoutMs } from "../src/tools/builtin.js";
import { compactGitHubReadme } from "../src/tools/github-repository-fetch.js";
import { MAX_WEB_FETCH_RESPONSE_BYTES } from "../src/tools/web-fetch.js";
import type { AgentTool, ToolContext } from "../src/tools/index.js";

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function shellInvoke(executable: string, args: string[]): string {
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(" ");
  return process.platform === "win32" ? `& ${command}` : command;
}

describe("Tools", () => {
  describe("defineTool", () => {
    it("preserves trusted continuation inspection without exposing it to the model", () => {
      const inspectReadContinuation = vi.fn(() => ({ version: "private", waiting: true }));
      const tool = defineTool({
        name: "read_progress", description: "Read progress", inputSchema: { type: "object" },
        inspectReadContinuation,
        async execute() { return { content: "ok" }; },
      });
      expect(tool.inspectReadContinuation).toBe(inspectReadContinuation);
      expect(toToolDefinition(tool)).not.toHaveProperty("inspectReadContinuation");
      expect(JSON.stringify(toToolDefinition(tool))).not.toContain("private");
      expect(inspectReadContinuation).not.toHaveBeenCalled();
    });

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
    it("exposes one complete-snapshot contract while keeping mutation mechanics host-owned", () => {
      const session = new Session();
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });

      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(tool.description.length).toBeLessThanOrEqual(480);
      expect(tool.description).toContain("optional current-task Plan");
      expect(tool.description).toContain("complete ordered snapshot");
      expect(tool.description).toContain("few durable outcome milestones");
      expect(tool.description).toContain("complex work");
      expect(tool.description).toContain("progress state across rounds");
      expect(tool.description).toContain("at most one in_progress");
      expect(tool.description).toContain("working memory, not task completion or termination");
      expect(tool.description).toContain("todo_tasks");
      expect(tool.description).not.toContain("when a key milestone");
      expect(tool.description).not.toContain("otherwise update separately");
      expect(tool.description).not.toContain("Co-emit");
      expect(Object.keys(properties).sort()).toEqual(["explanation", "plan"]);
      expect(properties.explanation.description).toContain("reason for this Plan update");
      expect(properties.plan.description).toContain("preserves existing step text exactly");
      expect(properties.plan.description).toContain("updates statuses in one batch");
      expect(properties.plan.minItems).toBe(1);
      expect(tool.inputSchema.required).toEqual(["plan"]);
      expect(properties).not.toHaveProperty("action");
      expect(properties).not.toHaveProperty("replace_objective");
      expect(properties).not.toHaveProperty("updates");
      expect(properties).not.toHaveProperty("finish");
      expect(properties).not.toHaveProperty("step_id");
      expect(properties).not.toHaveProperty("step");
      expect(properties).not.toHaveProperty("status");
    });

    function fixture() {
      const session = new Session();
      session.beginUserTurn([{ type: 'text', text: 'Inspect and deliver the requested work' }]);
      const tool = createExecutionPlanTool({ get: () => session.getExecutionPlan(),
        update: update => session.updateExecutionPlan(update), clear: () => session.clearExecutionPlan() });
      return { session, call: (plan: unknown, extra = {}) => tool.execute({ plan, ...extra }, { state: {} }) };
    }

    it('creates and advances a complete plan snapshot, preserves IDs and makes replay a no-op', async () => {
      const { session, call } = fixture();
      expect((await call([{ step: 'Inspect', status: 'in_progress' }, { step: 'Deliver', status: 'pending' }])).isError).toBeUndefined();
      const first = session.getExecutionPlan()!;
      const next = [{ step: 'Inspect', status: 'completed' }, { step: 'Deliver', status: 'in_progress' }, { step: 'Verify', status: 'pending' }];
      expect((await call(next)).isError).toBeUndefined();
      const advanced = session.getExecutionPlan()!;
      expect(advanced.steps.slice(0, 2).map(step => step.id)).toEqual(first.steps.map(step => step.id));
      expect(advanced.steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending']);
      expect(JSON.parse((await call(next)).content)).toMatchObject({ unchanged: true, revision: advanced.revision });
    });

    it.each(['clear', 'replace', 'update', 'set_status', 'set_statuses', 'append_step'])('rejects retired action %s without changing the plan', async action => {
      const { session, call } = fixture();
      const plan = [{ step: 'Inspect', status: 'in_progress' }];
      await call(plan);
      const before = session.getExecutionPlan();
      expect((await call(plan, { action })).isError).toBe(true);
      expect(session.getExecutionPlan()).toEqual(before);
    });

    it.each(['finish', 'replace_objective', 'step_id', 'step', 'updates', 'status'])('rejects retired field %s even alongside a valid snapshot', async field => {
      const { session, call } = fixture();
      expect((await call([{ step: 'Inspect', status: 'in_progress' }], { [field]: 'old' })).isError).toBe(true);
      expect(session.getExecutionPlan()).toBeUndefined();
    });

    it.each(['working', 'todo', 'not_started', 'unknown', 'done', 'complete', 'in-progress'])('rejects the noncanonical status %s without mutation', async status => {
      const { session, call } = fixture();
      expect((await call([{ step: 'Inspect', status }])).isError).toBe(true);
      expect(session.getExecutionPlan()).toBeUndefined();
    });

    it('preserves milestones and completed work when rejecting a destructive snapshot', async () => {
      const { session, call } = fixture();
      await call([{ step: 'Inspect', status: 'completed' }, { step: 'Deliver', status: 'in_progress' }]);
      const before = session.getExecutionPlan();
      for (const plan of [[{ step: 'Renamed', status: 'completed' }], [{ step: 'Inspect', status: 'pending' }, { step: 'Deliver', status: 'in_progress' }]]) {
        expect((await call(plan)).isError).toBe(true);
        expect(session.getExecutionPlan()).toEqual(before);
      }
    });

    it('retains blocked state and normalizes concurrent active steps through the owning session', async () => {
      const { session, call } = fixture();
      expect((await call([{ step: 'Inspect', status: 'in_progress' }, { step: 'Deliver', status: 'in_progress' }])).isError).toBeUndefined();
      expect(session.getExecutionPlan()!.steps.map(step => step.status)).toEqual(['in_progress', 'pending']);
      expect((await call([{ step: 'Inspect', status: 'blocked' }, { step: 'Deliver', status: 'pending' }])).isError).toBeUndefined();
      expect(session.getExecutionPlan()!.steps[0].status).toBe('blocked');
    });

    it('preserves the full plan at capacity and rejects oversized milestone labels without mutation', async () => {
      const { session, call } = fixture();
      const invalid = await call([{ step: 'x'.repeat(EXECUTION_PLAN_MAX_STEP_CHARS + 1), status: 'pending' }]);
      expect(invalid.isError).toBe(true);
      expect(session.getExecutionPlan()).toBeUndefined();
      const full = Array.from({ length: EXECUTION_PLAN_MAX_STEPS }, (_, i) => ({ step: 'Milestone ' + i, status: 'pending' }));
      expect((await call(full)).isError).toBeUndefined();
      const before = session.getExecutionPlan();
      expect(JSON.parse((await call([...full, { step: 'Overflow', status: 'pending' }])).content)).toMatchObject({ capacity_reached: true, updated: false });
      expect(session.getExecutionPlan()).toEqual(before);
    });

    it('rejects missing, empty and malformed snapshots without creating state', async () => {
      const { session, call } = fixture();
      for (const plan of [undefined, [], [null], [{ step: 'Inspect', status: 'completed', step_id: 1 }]]) expect((await call(plan)).isError).toBe(true);
      expect(session.getExecutionPlan()).toBeUndefined();
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

    it("reuses the normalized definition for an unchanged tool identity", () => {
      let schemaReads = 0;
      const tool = defineTool({
        name: "cached_tool",
        description: "cached description",
        get inputSchema() {
          schemaReads += 1;
          return { type: "object", properties: { value: { type: "string" } } };
        },
        async execute() {
          return { content: "" };
        },
      });

      const first = toToolDefinition(tool);
      const second = toToolDefinition(tool);

      expect(second).toBe(first);
      expect(schemaReads).toBe(1);
    });

    it("refreshes dynamic descriptions while reusing unchanged definitions", () => {
      let description = "Read the current state.";
      let schemaReads = 0;
      const tool: AgentTool = {
        name: "dynamic_token_budget_probe",
        dynamicDescription: true,
        get description() { return description; },
        get inputSchema() { schemaReads++; return { type: "object" }; },
        async execute() { return { content: "" }; },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const first = toToolDefinition(tool);
        expect(toToolDefinition(tool)).toBe(first);
        expect(schemaReads).toBe(1);
        description = "界".repeat(101); // 152 estimated tokens; only 101 characters
        const second = toToolDefinition(tool);
        expect(second).not.toBe(first);
        expect(second.description).toBe(description);
        expect(toToolDefinition(tool)).toBe(second);
        expect(schemaReads).toBe(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("[tool-definitions]",
          "tool definition description exceeds soft budget; sent untruncated",
          expect.objectContaining({ estimatedTokens: 152, softBudgetTokens: 150 }));
      } finally { warn.mockRestore(); }
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
            softBudgetTokens: 150,
          }),
        );
        expect(warn).toHaveBeenCalledWith(
          "[tool-definitions]",
          "tool definition description exceeds soft budget; sent untruncated",
          expect.objectContaining({
            tool: "schema_tool",
            field: "schema description at /inputSchema/properties/mode",
            softBudgetTokens: 80,
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
      expect(names).toContain("read_files");
      expect(names).toContain("write_file");
      expect(names).toContain("apply_patch");
      expect(names).toContain("bash");
      expect(names).toContain("process_session");
      expect(names).not.toContain("process_start");
      expect(names).not.toContain("process_read");
      expect(names).not.toContain("process_write");
      expect(names).not.toContain("process_stop");
      expect(names).toContain("list_files");
    });
  });

  describe("write_file tool", () => {
    it("creates parent directories and writes UTF-8 content", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-write-file-test-"));
      try {
        const writeFile = getBuiltinTools().find((tool) => tool.name === "write_file")!;
        const result = await writeFile.execute(
          { path: "nested/output.txt", content: "Windows + macOS: 你好" },
          { workingDir: tmpDir, state: {} },
        );

        const output = path.join(tmpDir, "nested", "output.txt");
        expect(result.isError).toBeUndefined();
        expect(result.content).toContain(path.resolve(output));
        await expect(fs.readFile(output, "utf8")).resolves.toBe("Windows + macOS: 你好");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns a tool error when the target cannot be written", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-write-file-error-test-"));
      try {
        const parentFile = path.join(tmpDir, "not-a-directory");
        await fs.writeFile(parentFile, "occupied");
        const writeFile = getBuiltinTools().find((tool) => tool.name === "write_file")!;
        const result = await writeFile.execute(
          { path: path.join(parentFile, "output.txt"), content: "nope" },
          { workingDir: tmpDir, state: {} },
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Error writing file:");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("list_files tool", () => {
    it("lists files and directories using a platform-neutral result format", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-list-files-test-"));
      try {
        await fs.mkdir(path.join(tmpDir, "folder"));
        await fs.writeFile(path.join(tmpDir, "file.txt"), "content");
        const listFiles = getBuiltinTools().find((tool) => tool.name === "list_files")!;
        const result = await listFiles.execute({}, { workingDir: tmpDir, state: {} });

        expect(result.isError).toBeUndefined();
        expect(result.content.split("\n").sort()).toEqual(["d folder", "f file.txt"]);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns a tool error for a missing directory", async () => {
      const listFiles = getBuiltinTools().find((tool) => tool.name === "list_files")!;
      const result = await listFiles.execute(
        { path: path.join(os.tmpdir(), `missing-list-dir-${Date.now()}`) },
        { state: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Error listing files:");
    });
  });

  describe("web_fetch tool", () => {
    it("preserves decision-relevant README sections beyond a long prefix", () => {
      const readme = [
        "# Example",
        "Local-first desktop assistant.",
        "",
        "## Community",
        "x".repeat(12_000),
        "",
        "## Installation",
        "Install with the signed desktop package.",
        "",
        "## License",
        "Licensed under Apache-2.0.",
      ].join("\n");
      const compacted = compactGitHubReadme(readme);
      expect(compacted.length).toBeLessThanOrEqual(4_500);
      expect(compacted).toContain("Local-first desktop assistant.");
      expect(compacted).toContain("Install with the signed desktop package.");
      expect(compacted).toContain("Licensed under Apache-2.0.");
      // The receipt says the long section was shortened rather than implying
      // the README was shown whole.
      expect(compacted).toContain("[README snapshot kept 3 of 3 sections after the opening (1 shortened)");
    });

    it("keeps a long list README in reading order and ignores look-alike priority titles", () => {
      const filler = Array.from({ length: 30 }, (_, index) => (
        `## Topic ${index + 1}\n${`Topic ${index + 1} background text. `.repeat(8)}`
      ));
      const readme = [
        "# Toolkit",
        "Opening paragraph.",
        "",
        ...filler,
        "## Memory-guided manipulation\nMEMORY_FEATURE_TEXT describes an agent feature.",
        "## Programming guide\nPROGRAMMING_GUIDE_TEXT explains the API.",
        "## RAM requirements\nRAM_REQUIREMENT_TEXT: 16 GB.",
        "## License\nLICENSE_TEXT: MIT.",
      ].join("\n");
      const compacted = compactGitHubReadme(readme);
      expect(compacted.length).toBeLessThanOrEqual(4_500);
      expect(compacted).toContain("Topic 1 background text.");
      expect(compacted).not.toContain("Topic 30 background text.");
      // Hardware and license facts are still pulled forward from the end...
      expect(compacted).toContain("RAM_REQUIREMENT_TEXT");
      expect(compacted).toContain("LICENSE_TEXT");
      // ...but a feature title containing "Memory" and a word containing "ram"
      // are ordinary sections, not requirements.
      expect(compacted).not.toContain("MEMORY_FEATURE_TEXT");
      expect(compacted).not.toContain("PROGRAMMING_GUIDE_TEXT");
      // Omitted sections are named up to a bound, then counted.
      expect(compacted).toMatch(/Omitted sections: Topic \d+ \|[^\]]*\(\+\d+ more\)\.\]$/);
    });

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

    it("adds access and embedded document dates to HTML without another request", async () => {
      const fetchMock = vi.fn(async () => new Response(
        '<html><head><title>Project</title></head><body>'
        + '<relative-time datetime="2026-07-27T10:30:00Z">yesterday</relative-time>'
        + '<time datetime="2026-07-20T09:00:00Z">last week</time>'
        + "</body></html>",
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "last-modified": "Mon, 27 Jul 2026 10:30:00 GMT",
          },
        },
      ));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const result = await webFetch.execute({ url: "https://example.test/project" }, { state: {} });
        expect(result.content).toContain("Title: Project");
        expect(result.content).toMatch(/Accessed at: \d{4}-\d{2}-\d{2}T/);
        expect(result.content).toContain("HTTP Last-Modified: Mon, 27 Jul 2026 10:30:00 GMT");
        expect(result.content).toContain(
          "Embedded document dates (newest first): "
          + "2026-07-27T10:30:00.000Z, 2026-07-20T09:00:00.000Z",
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("reuses a successful identical fetch within one run state", async () => {
      const fetchMock = vi.fn(async () => new Response("stable body", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const ctx: ToolContext = { state: {} };
        const [first, second] = await Promise.all([
          webFetch.execute({ url: "https://example.test/cached", maxChars: 8_000 }, ctx),
          webFetch.execute({ url: "https://example.test/cached", maxChars: 8_000 }, ctx),
        ]);
        expect(first.content).toBe("stable body");
        expect(second.content).toBe("stable body");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("reuses the complete response when only maxChars changes", async () => {
      const fetchMock = vi.fn(async () => new Response("abcdefghij", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const ctx: ToolContext = { state: {} };
        const short = await webFetch.execute(
          { url: "https://example.test/variable-limit", maxChars: 3 },
          ctx,
        );
        const longer = await webFetch.execute(
          { url: "https://example.test/variable-limit", maxChars: 8 },
          ctx,
        );
        expect(short.content).toContain("abc");
        expect(short.content).not.toContain("defgh");
        expect(longer.content).toContain("abcdefgh");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("returns a structured GitHub repository snapshot and caches its default API aliases", async () => {
      const metadata = {
        full_name: "example/project",
        description: "Example local-first project",
        homepage: "https://example.test",
        default_branch: "main",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2026-07-27T10:00:00Z",
        pushed_at: "2026-07-27T09:30:00Z",
        archived: false,
        fork: false,
        stargazers_count: 123,
        forks_count: 7,
        open_issues_count: 4,
        topics: ["local-first", "desktop"],
        license: {
          name: "Apache License 2.0",
          spdx_id: "Apache-2.0",
          url: "https://api.github.com/licenses/apache-2.0",
        },
      };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const requestUrl = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (requestUrl.endsWith("/readme")) {
          return new Response("# Project\nRuns locally on Windows, macOS, and Linux.", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        if (requestUrl === "https://api.github.com/repos/example/project") {
          return new Response(JSON.stringify(metadata), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        throw new Error(`unexpected request: ${requestUrl}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const runScopedLedger = new Map<string, unknown>();
        const ctx: ToolContext = { state: { runScopedLedger } };
        const snapshot = await webFetch.execute(
          { url: "https://github.com/example/project", maxChars: 20_000 },
          ctx,
        );
        const readmeAlias = await webFetch.execute(
          { url: "https://api.github.com/repos/example/project/readme" },
          ctx,
        );
        const metadataAlias = await webFetch.execute(
          { url: "https://api.github.com/repos/example/project" },
          ctx,
        );

        expect(snapshot.isError).toBeUndefined();
        expect(snapshot.content).toContain("Source type: structured GitHub repository snapshot");
        expect(snapshot.content).toContain("- License SPDX ID: Apache-2.0");
        expect(snapshot.content).toContain("- Pushed at: 2026-07-27T09:30:00Z");
        expect(snapshot.content).not.toContain("Decision evidence candidates");
        expect(snapshot.content).not.toContain("field=os");
        expect(snapshot.content).toContain("Runs locally on Windows, macOS, and Linux.");
        expect(readmeAlias.content).toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
        expect(metadataAlias.content).toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalledWith(
          "https://github.com/example/project",
          expect.anything(),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("reuses a successful fetch after ToolContext state is rebuilt", async () => {
      const fetchMock = vi.fn(async () => new Response("stable across compaction", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const runScopedLedger = new Map<string, unknown>();
        const first = await webFetch.execute(
          { url: "https://example.test/compacted", maxChars: 8_000 },
          { state: { runScopedLedger } },
        );
        const second = await webFetch.execute(
          { url: "https://example.test/compacted", maxChars: 8_000 },
          { state: { runScopedLedger } },
        );
        expect(first.content).toBe("stable across compaction");
        expect(second.content).toBe("stable across compaction");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not re-inject the full cached page after context compaction", async () => {
      const body = `Title-sized recovery text\n${"page body ".repeat(1_000)}`;
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const runScopedLedger = new Map<string, unknown>();
        const first = await webFetch.execute(
          { url: "https://example.test/compacted-replay", maxChars: 20_000 },
          { state: { runScopedLedger, toolResultReadLedger: { epoch: 0 } } },
        );
        const second = await webFetch.execute(
          { url: "https://example.test/compacted-replay#after-checkpoint", maxChars: 12_000 },
          { state: { runScopedLedger, toolResultReadLedger: { epoch: 1 } } },
        );
        expect(first.content).toBe(body);
        expect(second.content).toContain("WEB_FETCH_RUN_CACHE_HIT");
        expect(second.content).toContain("normalized URL already succeeded");
        expect(second.content).toContain("full page is intentionally not re-injected");
        expect(second.content).not.toContain("page body page body");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("allows one retry for a transient failure, then suppresses the same URL", async () => {
      const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const ctx: ToolContext = { state: {} };
        const first = await webFetch.execute({ url: "https://example.test/retryable" }, ctx);
        const second = await webFetch.execute({ url: "https://example.test/retryable" }, ctx);
        const third = await webFetch.execute({ url: "https://example.test/retryable" }, ctx);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(first.content).not.toContain("E_WEB_FETCH_RETRY_LIMIT");
        expect(second.content).toContain("E_WEB_FETCH_RETRY_LIMIT");
        expect(third.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not retry a permanently missing URL but allows another URL", async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const requestUrl = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        return requestUrl.endsWith("/missing")
          ? new Response("missing", { status: 404, statusText: "Not Found" })
          : new Response("useful evidence", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const ctx: ToolContext = { state: {} };
        const missing = await webFetch.execute({ url: "https://example.test/missing" }, ctx);
        const repeated = await webFetch.execute({ url: "https://example.test/missing" }, ctx);
        const useful = await webFetch.execute({ url: "https://example.test/useful" }, ctx);
        expect(missing.isError).toBe(true);
        expect(repeated.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
        expect(useful.content).toBe("useful evidence");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("opens a run-scoped origin circuit after repeated access failures", async () => {
      const fetchMock = vi.fn(async () => new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const runScopedLedger = new Map<string, unknown>();
        const first = await webFetch.execute(
          { url: "https://blocked.example.test/one" },
          { state: { runScopedLedger } },
        );
        const second = await webFetch.execute(
          { url: "https://blocked.example.test/two" },
          { state: { runScopedLedger } },
        );
        const third = await webFetch.execute(
          { url: "https://blocked.example.test/three" },
          { state: { runScopedLedger } },
        );
        expect(first.isError).toBe(true);
        expect(first.content).not.toContain("E_WEB_FETCH_ORIGIN_AUTH_CIRCUIT_OPENED");
        expect(second.content).toContain("E_WEB_FETCH_ORIGIN_AUTH_CIRCUIT_OPENED");
        expect(third.content).toContain("E_WEB_FETCH_ORIGIN_AUTH_BLOCKED");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not impose a total-call ceiling on distinct successful sources", async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const requestUrl = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        return new Response(`evidence for ${requestUrl}`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const runScopedLedger = new Map<string, unknown>();
        const results = [];
        for (let index = 0; index < 20; index++) {
          results.push(await webFetch.execute(
            { url: `https://valuable.example.test/source-${index}` },
            { state: { runScopedLedger } },
          ));
        }
        expect(results.every((result) => !result.isError)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(20);
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

    describe("long sources", () => {
      // A release page whose decisive results sit far below a long opening, the
      // shape that a 12,000-character first read used to cut off unannounced.
      const paragraphs = Array.from(
        { length: 40 },
        (_, index) => `<p>Paragraph ${index}: ${"background evidence ".repeat(30)}end.</p>`,
      ).join("");
      const releaseHtml = "<html><head><title>Model release</title></head><body>"
        + `<h2>Overview</h2>${paragraphs}`
        + "<h2>Benchmark results</h2><p>BENCHMARK_TABLE_ROW 95.9 versus 83.3.</p>"
        + "<h2>Limitations</h2><p>Known gaps remain.</p></body></html>";

      function stubRelease() {
        const fetchMock = vi.fn(async () => new Response(releaseHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }));
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
      }

      function windowBody(content: string): { start: number; end: number; total: number; body: string } {
        const match = /^Window: characters (\d+)-(\d+) of (\d+) /m.exec(content);
        if (!match) throw new Error(`no window line in: ${content.slice(0, 200)}`);
        const [start, end, total] = match.slice(1).map(Number);
        const bodyStart = content.indexOf("\n\n", match.index) + 2;
        return { start, end, total, body: content.slice(bodyStart, bodyStart + end - start) };
      }

      it("reports the unread remainder of a truncated page and continues it from the run cache", async () => {
        const fetchMock = stubRelease();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const ctx: ToolContext = { state: { runScopedLedger: new Map<string, unknown>() } };
          const first = await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000 }, ctx);
          const full = (await webFetch.execute({ url: "https://example.test/release" }, ctx)).content;
          expect(full).toContain("BENCHMARK_TABLE_ROW");
          expect(first.isError).toBeUndefined();
          expect(first.content.startsWith(full.slice(0, 4_000))).toBe(true);
          expect(first.content).not.toContain("BENCHMARK_TABLE_ROW");
          expect(first.content).toContain("explicitly requested maxChars");
          expect(first.content).toContain(`characters 0-4000 of ${full.length} shown; ${full.length - 4_000} more characters remain`);
          expect(first.content).toContain('"offset": 4000');
          expect(first.content).toContain("Headings after this point (detected): Benchmark results | Limitations.");
          expect(first.content).not.toMatch(/detected\):[^\n]*Overview/);

          // Following the reported offsets reconstructs the page exactly, and
          // the last window carries the results the first read could not show.
          let reconstructed = first.content.slice(0, 4_000);
          let next = 4_000;
          let last = first;
          while (next < full.length) {
            last = await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000, offset: next }, ctx);
            const window = windowBody(last.content);
            expect(window.start).toBe(next);
            expect(window.total).toBe(full.length);
            expect(last.content).toContain("URL: https://example.test/release");
            expect(last.content).toContain("Title: Model release");
            reconstructed += window.body;
            next = window.end;
          }
          expect(reconstructed).toBe(full);
          expect(last.content).toContain("BENCHMARK_TABLE_ROW");
          expect(last.content).toContain(`end of the extracted content at character ${full.length}`);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("continues past what was read after compaction without re-injecting earlier text", async () => {
        const fetchMock = stubRelease();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const runScopedLedger = new Map<string, unknown>();
          const before = { state: { runScopedLedger, toolResultReadLedger: { epoch: 0 } } };
          const after = { state: { runScopedLedger, toolResultReadLedger: { epoch: 1 } } };
          await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000 }, before);

          const replay = await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000 }, after);
          const reread = await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000, offset: 1_000 }, after);
          const onward = await webFetch.execute({ url: "https://example.test/release", maxChars: 4_000, offset: 4_000 }, after);

          for (const result of [replay, reread]) {
            expect(result.content).toContain("WEB_FETCH_RUN_CACHE_HIT");
            expect(result.content).not.toContain("Paragraph 3:");
            expect(result.content).toMatch(/have not been read in order yet; to continue, call web_fetch with "offset": 4000/);
          }
          expect(onward.isError).toBeUndefined();
          expect(windowBody(onward.content).start).toBe(4_000);
          expect(onward.content).not.toContain("WEB_FETCH_RUN_CACHE_HIT");
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("starts a cold fetch at the requested window", async () => {
        const fetchMock = stubRelease();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const ctx: ToolContext = { state: {} };
          const window = await webFetch.execute({ url: "https://example.test/release", maxChars: 50, offset: 100 }, ctx);
          const full = (await webFetch.execute({ url: "https://example.test/release" }, ctx)).content;
          const parsed = windowBody(window.content);
          expect(parsed).toMatchObject({ start: 100, end: 150, total: full.length });
          expect(parsed.body).toBe(full.slice(100, 150));
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it.each([-1, 1.5, "later"])("rejects offset %p before any request", async (offset) => {
        const fetchMock = stubRelease();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const result = await webFetch.execute({ url: "https://example.test/release", offset }, { state: {} });
          expect(result.isError).toBe(true);
          expect(result.content).toContain("offset must be a non-negative integer");
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("names the content length when an offset is past the end", async () => {
        const fetchMock = stubRelease();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const ctx: ToolContext = { state: {} };
          const full = (await webFetch.execute({ url: "https://example.test/release" }, ctx)).content;
          const result = await webFetch.execute(
            { url: "https://example.test/release", maxChars: 4_000, offset: full.length + 10 },
            ctx,
          );
          expect(result.isError).toBe(true);
          expect(result.content).toContain("E_WEB_FETCH_OFFSET_OUT_OF_RANGE");
          expect(result.content).toContain(`(${full.length} characters)`);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe("binary responses", () => {
      const pdfBytes = new Uint8Array([
        ...Buffer.from("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3,
        ...Buffer.from("\n5 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), 0x78, 0x9c, 0x00, 0xff, 0x10,
      ]);

      it.each([
        ["application/pdf", "a PDF document"],
        ["application/octet-stream", "a PDF document"],
      ])("fails a PDF served as %s instead of returning decoded bytes", async (contentType, kind) => {
        const fetchMock = vi.fn(async () => new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": contentType },
        }));
        vi.stubGlobal("fetch", fetchMock);
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const ctx: ToolContext = { state: {} };
          const first = await webFetch.execute({ url: "https://example.test/card.pdf", maxChars: 12_000 }, ctx);
          const repeated = await webFetch.execute({ url: "https://example.test/card.pdf", maxChars: 12_000 }, ctx);
          expect(first.isError).toBe(true);
          expect(first.content).toContain("E_WEB_FETCH_BINARY_CONTENT");
          expect(first.content).toContain(`returned ${kind}`);
          expect(first.content).not.toContain("FlateDecode");
          expect(repeated.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("fails an image response", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), {
          status: 200,
          headers: { "content-type": "image/png" },
        })));
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const result = await webFetch.execute({ url: "https://example.test/chart.png" }, { state: {} });
          expect(result.isError).toBe(true);
          expect(result.content).toContain("a binary file (image/png)");
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it.each([
        ["an HTML page that mentions PDFs", "text/html; charset=utf-8", "<html><body><p>Download the %PDF-1.7 spec as application/pdf.</p></body></html>", "Download the %PDF-1.7 spec"],
        ["text served as an octet stream", "application/octet-stream", "# Notes\nPlain markdown served without a text type.", "Plain markdown served"],
        ["a text page whose charset was guessed wrong", "text/html", `<html><body><p>${"\uFFFD".repeat(400)} readable tail</p></body></html>`, "readable tail"],
      ])("keeps %s as readable text", async (_label, contentType, body, expected) => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        })));
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const result = await webFetch.execute({ url: "https://example.test/text" }, { state: {} });
          expect(result.isError).toBeUndefined();
          expect(result.content).toContain(expected);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    describe("GitHub list README", () => {
      const listReadme = [
        "# Awesome Robot Demos",
        "Curated robot workflows.",
        "",
        "## Contents",
        "- Zero-shot control",
        "",
        "## Zero-shot Control",
        "",
        "### Deploy in Simulation",
        "",
        ...Array.from({ length: 37 }, (_, index) => {
          const number = index + 1;
          const title = number === 23 ? "Memory-guided agentic manipulation" : `Robot demo number ${number}`;
          return `#### Case ${number}: ${title}\n\n**Source:** Lab ${number}\n\n${`Case ${number} describes its demonstration. `.repeat(14)}`;
        }),
      ].join("\n");

      function stubRepository() {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
          const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (requestUrl.endsWith("/readme")) {
            return new Response(listReadme, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
          }
          return new Response(JSON.stringify({ full_name: "example/awesome", description: "Robot demos" }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        });
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
      }

      it("keeps the first entries, names the omitted ones, and continues the README by offset", async () => {
        const fetchMock = stubRepository();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const ctx: ToolContext = { state: { runScopedLedger: new Map<string, unknown>() } };
          const view = await webFetch.execute({ url: "https://github.com/example/awesome", maxChars: 12_000 }, ctx);
          expect(view.isError).toBeUndefined();
          expect(view.content.length).toBeLessThanOrEqual(12_000);
          expect(view.content).toContain("Case 1 describes its demonstration.");
          // A list entry is not promoted just because its title says "Memory".
          expect(view.content).not.toContain("Case 23 describes");
          const receipt = /README snapshot kept (\d+) of 40 sections after the opening/.exec(view.content);
          expect(receipt).not.toBeNull();
          const omitted = /Omitted sections: Case (\d+): Robot demo number \1 \|/.exec(view.content);
          expect(omitted).not.toBeNull();
          const firstOmitted = Number(omitted![1]);
          expect(view.content).toContain(`Case ${firstOmitted - 1} describes its demonstration.`);
          const offset = Number(/Continue the README in order with "offset": (\d+)/.exec(view.content)?.[1]);

          const next = await webFetch.execute(
            { url: "https://github.com/example/awesome", maxChars: 4_000, offset },
            ctx,
          );
          const body = next.content.slice(next.content.indexOf("\n\n") + 2);
          expect(next.content).toContain("URL: https://github.com/example/awesome");
          expect(body.startsWith(`#### Case ${firstOmitted}: Robot demo number ${firstOmitted}`)).toBe(true);
          // Metadata and README requests only; windows reuse the cached snapshot.
          expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("keeps the default README budget when maxChars is omitted", async () => {
        stubRepository();
        try {
          const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
          const view = await webFetch.execute({ url: "https://github.com/example/awesome" }, { state: {} });
          const readme = view.content.slice(view.content.indexOf("Official repository README:\n") + "Official repository README:\n".length);
          expect(readme.length).toBeLessThanOrEqual(4_500);
          expect(readme).toContain("Case 1 describes its demonstration.");
          expect(readme).toContain("README snapshot kept");
        } finally {
          vi.unstubAllGlobals();
        }
      });
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
    it("uses the long default for invalid values and preserves explicit timeouts", () => {
      expect(normalizeBashTimeoutMs(undefined)).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(-1)).toBe(DEFAULT_BASH_TIMEOUT_MS);
      expect(normalizeBashTimeoutMs(30_000)).toBe(30_000);
      expect(normalizeBashTimeoutMs(300_000)).toBe(300_000);
      expect(normalizeBashTimeoutMs(5_000)).toBe(5_000);
    });

    it("executes a shell command", async () => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;

      const ctx: ToolContext = { state: {} };
      const result = await bash.execute({ command: "echo hello" }, ctx);
      expect(result.content).toContain('<command-result status="succeeded" exit_code="0"');
      expect(result.content).toContain("<stdout>\nhello");
      expect(result.observations?.execution).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        timedOut: false,
      });
    });

    it.each([1, 2])("preserves both output streams on exit %i and can execute a corrected command", async (exitCode) => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-bash-failure-"));
      const ctx: ToolContext = { workingDir: tmpDir, state: {} };
      const stdout = "progress ".repeat(40) + "stdout-tail";
      const stderr = "diagnostic ".repeat(40) + "stderr-tail";
      try {
        const script = path.join(tmpDir, "failure.cjs");
        await fs.writeFile(script, `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`);
        const result = await bash.execute({ command: shellInvoke(TEST_NODE, [script]) }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain(`<stdout>\n${stdout}\n</stdout>`);
        expect(result.content).toContain(`<stderr>\n${stderr}\n</stderr>`);
        expect(result.observations?.execution).toMatchObject({
          status: "failed", exitCode, timedOut: false, outputLimitExceeded: false,
          stdout: { bytes: Buffer.byteLength(stdout), truncated: false },
          stderr: { bytes: Buffer.byteLength(stderr), truncated: false },
        });
        await fs.writeFile(script, "process.stdout.write('recovered')");
        const recovered = await bash.execute({ command: shellInvoke(TEST_NODE, [script]) }, ctx);
        expect(recovered.isError).toBeUndefined();
        expect(recovered.content).toContain("<stdout>\nrecovered\n</stdout>");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("reports a shell start failure without escalating to a tool exception", async () => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;
      const invalidWorkingDir = `invalid\0working-dir`;

      const result = await bash.execute(
        { command: "echo must-not-run" },
        { workingDir: invalidWorkingDir, state: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('<command-result status="start_failed" exit_code="null"');
      expect(result.content).toContain("The command was not executed");
      expect(result.content).not.toContain(invalidWorkingDir);
      expect(result.observations?.execution).toMatchObject({
        status: "start_failed",
        exitCode: null,
        timedOut: false,
        outputLimitExceeded: false,
        stdout: { bytes: 0, truncated: false },
      });
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
        {
          command: shellInvoke(TEST_NODE, [
            "-e",
            "process.stdout.write(process.env.ORKAS_TEST_TOKEN || '')",
          ]),
        },
        ctx,
      );
      expect(result.content).toContain("<stdout>\npropagated-abc123\n</stdout>");
      expect(result.observations?.execution?.stdout.bytes).toBe(17);
      expect(result.isError).toBeUndefined();
    });

    it("hands large stdout to the host through a complete spool file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-bash-spool-test-"));
      const outputBytes = 1024 * 1024 + 257;
      try {
        const bash = getBuiltinTools().find((tool) => tool.name === "bash")!;
        const result = await bash.execute({
          command: shellInvoke(TEST_NODE, [
            "-e",
            `process.stdout.write('x'.repeat(${outputBytes}))`,
          ]),
        }, {
          workingDir: tmpDir,
          state: { toolResultSpoolDir: path.join(tmpDir, "results") },
        });

        expect(result.isError).toBeUndefined();
        expect(result.content).toContain("full output streamed to Result Store");
        expect(result.streamedOutput!.size).toBeGreaterThan(outputBytes);
        const persisted = await fs.readFile(result.streamedOutput!.path, "utf8");
        expect(persisted).toContain("--- stdout ---");
        expect(persisted).toContain("x".repeat(1024));
        expect(result.observations?.execution).toMatchObject({
          status: "succeeded",
          exitCode: 0,
          stdout: { bytes: outputBytes },
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
