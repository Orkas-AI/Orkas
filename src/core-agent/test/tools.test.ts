import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createExecutionPlanTool, defineTool, toToolDefinition, getBuiltinTools } from "../src/tools/index.js";
import { Session } from "../src/agent/session.js";
import { DEFAULT_BASH_TIMEOUT_MS, normalizeBashTimeoutMs } from "../src/tools/builtin.js";
import { compactGitHubReadme } from "../src/tools/github-repository-fetch.js";
import { MAX_WEB_FETCH_RESPONSE_BYTES } from "../src/tools/web-fetch.js";
import type { ToolContext } from "../src/tools/index.js";

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
    it("exposes outcome-based creation and material-transition guidance", () => {
      const session = new Session();
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });

      expect(tool.description).toContain("durable outcome milestones");
      expect(tool.description).toContain("tool/file count and linear plumbing do not qualify");
      expect(tool.description).toContain("Prefer set_statuses for known transitions");
      expect(tool.description).toContain("complete before evidence");
    });

    it("repairs a missing update action when a complete plan is present", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the task" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const inferred = await tool.execute({
        plan: [{ step: "Complete the work", status: "working" }],
      }, context);

      expect(inferred.isError).toBeUndefined();
      expect(JSON.parse(inferred.content)).toMatchObject({
        action: "update",
        action_inferred: true,
      });
      expect(session.getExecutionPlan()?.steps[0].status).toBe("in_progress");
    });

    it("repairs a complete guarded plan mislabeled as set_status", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [
          { step: "Inspect the project", status: "completed" },
          { step: "Summarize the structure", status: "in_progress" },
        ],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const repaired = await tool.execute({
        action: "set_status",
        plan: [
          { step: "Inspect the project", status: "completed" },
          { step: "Summarize the structure", status: "completed" },
        ],
      }, context);

      expect(repaired.isError).toBeUndefined();
      expect(JSON.parse(repaired.content)).toMatchObject({
        action: "update",
        action_inferred: true,
      });
      expect(session.getExecutionPlan()?.steps.map((step) => step.status))
        .toEqual(["completed", "completed"]);
    });

    it("does not repair ambiguous set_status payloads with one narrow field present", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [{ step: "Complete the work", status: "in_progress" }],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };
      const plan = [{ step: "Complete the work", status: "completed" }];

      const missingStatus = await tool.execute({
        action: "set_status",
        step_id: 1,
        plan,
      }, context);
      const missingStepId = await tool.execute({
        action: "set_status",
        status: "completed",
        plan,
      }, context);

      expect(missingStatus).toMatchObject({ isError: true });
      expect(JSON.parse(missingStatus.content)).toMatchObject({
        ok: false,
        error_code: "PLAN_STATUS_INVALID",
        message: "manage_execution_plan set_status requires a valid status",
        current_revision: 1,
        current_steps: [{ id: 1, step: "Complete the work", status: "in_progress" }],
      });
      expect(missingStepId).toMatchObject({ isError: true });
      expect(JSON.parse(missingStepId.content)).toMatchObject({
        ok: false,
        error_code: "PLAN_STEP_ID_INVALID",
        message: "manage_execution_plan set_status requires a positive integer step_id",
        current_revision: 1,
      });
      expect(session.getExecutionPlan()?.steps[0].status).toBe("in_progress");
    });

    it("accepts replace as a legacy alias without bypassing plan guards", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the task" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const result = await tool.execute({
        action: "replace",
        plan: [{ step: "Complete the work", status: "in_progress" }],
      }, context);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject({ action: "update", action_inferred: false });
      expect(session.getExecutionPlan()?.steps[0].step).toBe("Complete the work");
    });

    it("downgrades a redundant replace_objective replay to a guarded status update", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the original task" }]);
      session.updateExecutionPlan({
        steps: [{ step: "Complete the work", status: "in_progress" }],
      });
      session.addMessage("user", [{ type: "text", text: "Also include the revised requirement" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
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

    it("updates and appends by stable step id without replaying unchanged steps", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const initial = await tool.execute({
        action: "update",
        plan: [
          { step: "Inspect the inputs", status: "in_progress" },
          { step: "Verify the result", status: "pending" },
        ],
      }, context);
      expect(JSON.parse(initial.content).steps).toEqual([
        { id: 1, step: "Inspect the inputs", status: "in_progress" },
        { id: 2, step: "Verify the result", status: "pending" },
      ]);

      const status = await tool.execute({ action: "set_status", step_id: 1, status: "completed" }, context);
      expect(status.isError).toBeUndefined();
      expect(JSON.parse(status.content).steps[0]).toEqual({
        id: 1,
        step: "Inspect the inputs",
        status: "completed",
      });

      const appended = await tool.execute({
        action: "append_step",
        step: "Publish the result",
        status: "in_progress",
      }, context);
      expect(appended.isError).toBeUndefined();
      expect(JSON.parse(appended.content)).toMatchObject({ appended_step_id: 3, step_count: 3 });
      expect(session.getExecutionPlan()?.steps.map((item) => item.id)).toEqual([1, 2, 3]);
      expect(session.getExecutionPlan()?.steps.map((item) => item.step)).toEqual([
        "Inspect the inputs",
        "Verify the result",
        "Publish the result",
      ]);
    });

    it("atomically updates several known statuses while preserving stable step ids", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [
          { step: "Inspect the inputs", status: "in_progress" },
          { step: "Verify the evidence", status: "pending" },
          { step: "Publish the result", status: "pending" },
        ],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const result = await tool.execute({
        action: "set_statuses",
        updates: [
          { step_id: 1, status: "completed" },
          { step_id: "step_2", status: "in_progress" },
          { step_id: 3, status: "completed" },
        ],
      }, context);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject({
        action: "set_statuses",
        revision: 2,
        requested_step_ids: [1, 2, 3],
        updated_step_ids: [1, 2, 3],
        unchanged_step_ids: [],
      });
      expect(session.getExecutionPlan()?.steps).toEqual([
        { id: 1, step: "Inspect the inputs", status: "completed" },
        { id: 2, step: "Verify the evidence", status: "in_progress" },
        { id: 3, step: "Publish the result", status: "completed" },
      ]);
    });

    it("infers unambiguous narrow actions without weakening payload validation", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [
          { step: "Inspect the inputs", status: "in_progress" },
          { step: "Verify the result", status: "pending" },
        ],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const batch = await tool.execute({
        updates: [
          { step_id: 1, status: "completed" },
          { step_id: 2, status: "in_progress" },
        ],
      }, context);
      expect(batch.isError).toBeUndefined();
      expect(JSON.parse(batch.content)).toMatchObject({
        action: "set_statuses",
        updated_step_ids: [1, 2],
      });

      const status = await tool.execute({ step_id: 2, status: "completed" }, context);
      expect(status.isError).toBeUndefined();
      expect(JSON.parse(status.content)).toMatchObject({
        action: "set_status",
        step_id: 2,
      });

      const appended = await tool.execute({ step: "Publish the result" }, context);
      expect(appended.isError).toBeUndefined();
      expect(JSON.parse(appended.content)).toMatchObject({
        action: "append_step",
        appended_step_id: 3,
      });

      const ambiguous = await tool.execute({
        updates: [{ step_id: 1, status: "blocked" }],
        step_id: 1,
        status: "blocked",
      }, context);
      expect(ambiguous.isError).toBe(true);
      expect(JSON.parse(ambiguous.content)).toMatchObject({
        error_code: "PLAN_ACTION_INVALID",
      });
      expect(session.getExecutionPlan()?.steps[0].status).toBe("completed");
    });

    it("rejects an invalid status batch without partially changing the plan", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [
          { step: "Inspect the inputs", status: "in_progress" },
          { step: "Verify the evidence", status: "pending" },
          { step: "Publish the result", status: "pending" },
        ],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };
      const original = session.getExecutionPlan();
      const invalidBatches = [
        {
          updates: [
            { step_id: 1, status: "completed" },
            { step_id: "step_1", status: "blocked" },
          ],
          errorCode: "PLAN_STEP_ID_DUPLICATE",
        },
        {
          updates: [
            { step_id: 2, status: "in_progress" },
            { step_id: 3, status: "in_progress" },
          ],
          errorCode: "PLAN_MULTIPLE_IN_PROGRESS",
        },
        {
          updates: [
            { step_id: 1, status: "completed" },
            { step_id: 99, status: "blocked" },
          ],
          errorCode: "PLAN_STEP_NOT_FOUND",
        },
        {
          updates: [
            { step_id: 1, status: "completed" },
            { step_id: 2, status: "later" },
          ],
          errorCode: "PLAN_STATUS_INVALID",
        },
      ];

      for (const invalid of invalidBatches) {
        const result = await tool.execute({
          action: "set_statuses",
          updates: invalid.updates,
        }, context);
        expect(result).toMatchObject({ isError: true });
        expect(JSON.parse(result.content)).toMatchObject({
          ok: false,
          error_code: invalid.errorCode,
          current_revision: original?.revision,
        });
        expect(session.getExecutionPlan()).toEqual(original);
      }
    });

    it("acknowledges capacity without failing or rewriting the durable plan", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the long staged task" }]);
      const initialSteps = Array.from({ length: 12 }, (_, index) => ({
        step: `Milestone ${index + 1}`,
        status: index === 11 ? "in_progress" as const : "completed" as const,
      }));
      session.updateExecutionPlan({ steps: initialSteps });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const appended = await tool.execute({
        action: "append_step",
        step: "Thirteenth bookkeeping milestone",
        status: "pending",
      }, context);

      expect(appended.isError).toBeUndefined();
      expect(JSON.parse(appended.content)).toMatchObject({
        ok: true,
        action: "append_step",
        step_count: 12,
        appended: false,
        capacity_reached: true,
        max_steps: 12,
        do_not_retry: true,
        next_action: "continue_task_and_use_set_status_for_existing_steps",
      });
      expect(session.getExecutionPlan()?.steps.map((item) => item.step))
        .toEqual(initialSteps.map((item) => item.step));

      const replayedFullPlan = await tool.execute({
        action: "update",
        plan: [
          ...initialSteps,
          { step: "Thirteenth bookkeeping milestone", status: "pending" },
        ],
      }, context);

      expect(replayedFullPlan.isError).toBeUndefined();
      expect(JSON.parse(replayedFullPlan.content)).toMatchObject({
        ok: true,
        action: "update",
        step_count: 12,
        updated: false,
        capacity_reached: true,
        requested_step_count: 13,
        do_not_retry: true,
      });
      expect(session.getExecutionPlan()?.steps.map((item) => item.step))
        .toEqual(initialSteps.map((item) => item.step));

      session.addMessage("user", [{ type: "text", text: "Replace this with a new objective" }]);
      const oversizedNewObjective = await tool.execute({
        action: "update",
        replace_objective: true,
        plan: [
          ...initialSteps,
          { step: "Thirteenth bookkeeping milestone", status: "pending" },
        ],
      }, context);

      expect(oversizedNewObjective.isError).toBe(true);
      expect(JSON.parse(oversizedNewObjective.content)).toMatchObject({
        ok: false,
        error_code: "PLAN_UPDATE_REJECTED",
      });
      expect(oversizedNewObjective.content).toContain("accepts at most 12 steps");
      expect(session.getExecutionPlan()?.steps.map((item) => item.step))
        .toEqual(initialSteps.map((item) => item.step));
    });

    it("normalizes multiple in-progress milestones without spending a retry round", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const result = await tool.execute({
        action: "update",
        plan: [
          { step: "Inspect the inputs", status: "in_progress" },
          { step: "Verify the result", status: "in_progress" },
        ],
      }, context);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toMatchObject({
        normalized_statuses: [{ step_id: 2, from: "in_progress", to: "pending" }],
      });
      expect(session.getExecutionPlan()?.steps.map((step) => step.status))
        .toEqual(["in_progress", "pending"]);

      const switched = await tool.execute({
        action: "set_status",
        step_id: 2,
        status: "in_progress",
      }, context);

      expect(switched.isError).toBeUndefined();
      expect(JSON.parse(switched.content)).toMatchObject({
        normalized_statuses: [{ step_id: 1, from: "in_progress", to: "pending" }],
      });
      expect(session.getExecutionPlan()?.steps.map((step) => step.status))
        .toEqual(["pending", "in_progress"]);
    });

    it("accepts detailed milestone labels beyond the model-facing anchor budget", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the detailed task" }]);
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };
      const longStep = `Inspect the production evidence and preserve every accepted constraint ${"detail ".repeat(30)}`.trim();
      expect(longStep.length).toBeGreaterThan(180);

      const result = await tool.execute({
        action: "update",
        plan: [{ step: longStep, status: "in_progress" }],
      }, context);

      expect(result.isError).toBeUndefined();
      expect(session.getExecutionPlan()?.steps[0].step).toBe(longStep);
      const modelView = JSON.stringify(session.getMessagesForModel());
      expect(modelView).toContain("chars omitted");
      expect(modelView.length).toBeLessThan(longStep.length + 2_000);
    });

    it("accepts canonical step_<id> aliases without accepting lookalike labels", async () => {
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Complete the staged task" }]);
      session.updateExecutionPlan({
        steps: [{ step: "Complete the work", status: "in_progress" }],
      });
      const tool = createExecutionPlanTool({
        get: () => session.getExecutionPlan(),
        update: (update) => session.updateExecutionPlan(update),
        clear: () => session.clearExecutionPlan(),
      });
      const context: ToolContext = { state: {} };

      const accepted = await tool.execute({
        action: "set_status",
        step_id: "step_1",
        status: "completed",
      }, context);

      expect(accepted.isError).toBeUndefined();
      expect(JSON.parse(accepted.content)).toMatchObject({
        action: "set_status",
        step_id: 1,
      });
      expect(session.getExecutionPlan()?.steps[0].status).toBe("completed");

      for (const stepId of ["step_0", "step_1_extra", "phase_1"]) {
        const rejected = await tool.execute({
          action: "set_status",
          step_id: stepId,
          status: "in_progress",
        }, context);
        expect(rejected).toMatchObject({ isError: true });
        expect(rejected.content).toContain("requires a positive integer step_id");
      }
      expect(session.getExecutionPlan()?.steps[0].status).toBe("completed");
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
      expect(names).toContain("read_files");
      expect(names).toContain("write_file");
      expect(names).toContain("apply_patch");
      expect(names).toContain("bash");
      expect(names).toContain("process_start");
      expect(names).toContain("process_read");
      expect(names).toContain("process_write");
      expect(names).toContain("process_stop");
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
      expect(compacted.length).toBeLessThan(readme.length);
      expect(compacted).toContain("Local-first desktop assistant.");
      expect(compacted).toContain("Install with the signed desktop package.");
      expect(compacted).toContain("Licensed under Apache-2.0.");
      expect(compacted).toContain("other sections omitted");
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

    it("returns a structured GitHub repository snapshot and caches its URL aliases", async () => {
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
          { url: "https://raw.githubusercontent.com/example/project/main/README.md" },
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

    it("does not cache failed fetches", async () => {
      const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
        const ctx: ToolContext = { state: {} };
        await webFetch.execute({ url: "https://example.test/retryable" }, ctx);
        await webFetch.execute({ url: "https://example.test/retryable" }, ctx);
        expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expect(result.content).toContain('<command-result status="succeeded" exit_code="0"');
      expect(result.content).toContain("<stdout>\nhello");
      expect(result.observations?.execution).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        timedOut: false,
      });
    });

    it("returns error for failing command", async () => {
      const tools = getBuiltinTools();
      const bash = tools.find((t) => t.name === "bash")!;

      const ctx: ToolContext = { state: {} };
      const result = await bash.execute({ command: "false" }, ctx);
      expect(result.isError).toBe(true);
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
