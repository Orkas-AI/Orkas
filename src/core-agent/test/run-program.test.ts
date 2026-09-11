import { describe, expect, it } from "vitest";

import {
  createRunProgramTool,
  type ProgrammaticToolInvokeOutcome,
  type ProgramSourceLoader,
  type RunProgramLimits,
} from "../src/tools/run-program.js";
import { toToolDefinition, type ToolContext } from "../src/tools/base.js";

const ctx = (signal?: AbortSignal): ToolContext => ({
  workingDir: "/tmp/orkas-run-program-test",
  state: {},
  ...(signal ? { signal } : {}),
});

function tool(options: {
  names?: string[];
  invoke?: (
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ProgrammaticToolInvokeOutcome>;
  loadSourceFile?: ProgramSourceLoader;
  limits?: Partial<RunProgramLimits>;
} = {}) {
  return createRunProgramTool({
    listToolNames: () => options.names ?? [],
    invokeTool: options.invoke ?? (async () => ({
      status: "completed",
      result: { content: "unused" },
    })),
    ...(options.loadSourceFile ? { loadSourceFile: options.loadSourceFile } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

function incomplete(result: { content: string }) {
  return JSON.parse(result.content) as {
    status: string;
    reason: string;
    message: string;
    attempted_calls: number;
    completed_calls: number;
    direct_call_allowed?: boolean;
    execution?: {
      source_kind: "inline" | "file";
      source_sha256: string;
      attempted_calls: number;
      completed_calls: number;
      failed_calls: number;
      changed_files: {
        total: number;
        items: Array<{ path: string; operation: string; bytes?: number; hash?: string }>;
        truncated?: boolean;
      };
      failed_tool?: { tool: string; call: number; code?: string; message: string };
      error?: {
        line?: number;
        column?: number;
        frames?: Array<{ line: number; column: number }>;
        sourceExcerpt?: Array<{ line: number; text: string }>;
      };
    };
  };
}

function receipt(result: { content: string }) {
  const line = result.content.split("\n").find((item) => item.startsWith("Execution receipt: "));
  if (!line) throw new Error("missing execution receipt");
  return JSON.parse(line.slice("Execution receipt: ".length)) as NonNullable<ReturnType<typeof incomplete>["execution"]>;
}

describe("run_program", () => {
  it("advertises string child content and conditional JSON parsing at the code parameter", () => {
    const definition = toToolDefinition(tool());
    const code = (definition.inputSchema.properties as Record<string, { description: string }>).code.description;
    expect(code).toContain("{ok,content} (boolean,string)");
    expect(code).toContain("Check ok");
    expect(code).toContain("JSON only: JSON.parse(content)");
  });

  it.each([
    { content: '{"records":[{"value":7}]}', isError: false },
    { content: 'plain text', isError: false },
    { content: '', isError: false },
    { content: '{not JSON}', isError: false },
    { content: 'unavailable', isError: true },
    { content: '{"records":[],"error":"unavailable"}', isError: true },
  ])("preserves child content and error status without coercion or replay: $content", async ({ content, isError }) => {
    let calls = 0;
    const runProgram = tool({
      names: ["read"],
      invoke: async () => {
        calls++;
        return { status: "completed", result: { content, isError } };
      },
    });
    const result = await runProgram.execute({
      code: "const res = await tools.read({}); json({ok: res.ok, type: typeof res.content, content: res.content});",
    }, ctx());
    expect(result.isError).not.toBe(true);
    expect(result.content.split("\n\n").slice(1).join("\n\n"))
      .toBe(JSON.stringify({ ok: !isError, type: "string", content }));
    expect(calls).toBe(1);
    expect(receipt(result).failed_calls).toBe(isError ? 1 : 0);
  });

  it("reports a raw-string pagination mistake without parsing or replaying the successful child", async () => {
    let calls = 0;
    const runProgram = tool({
      names: ["list_sales_page"],
      invoke: async () => {
        calls++;
        return { status: "completed", result: { content: '{"records":[{"value":7}],"next_cursor":null}' } };
      },
    });
    // Preserve the failing boundary from the live pagination trace: the child
    // succeeds, but the program treats its serialized content as a record.
    const result = await runProgram.execute({ code: `const res = await tools.list_sales_page({});
if (!res.ok) throw new Error(res.content);
const page = res.content;
for (const row of page.records) text(row.value);` }, ctx());
    expect(result.isError).toBe(true);
    expect(incomplete(result)).toMatchObject({
      reason: "E_PROGRAM_RUNTIME",
      execution: { completed_calls: 1, failed_calls: 0, error: { line: 4 } },
    });
    expect(calls).toBe(1);
  });

  it("exposes the exact runtime boundary and computes without tool calls", async () => {
    const runProgram = tool();
    expect(runProgram.description).toContain("Bounded QuickJS for in-memory logic");
    expect(runProgram.description).toContain("100 calls/8 concurrent/10m/8MB each/32MB total");
    expect(runProgram.description).toContain("combine/branch/batch/reduce Host-tool results");
    expect(runProgram.description).toContain("Call one Host operation directly");
    expect(runProgram.description).toContain("Use bash for local files, shell/CLI, Python, Node");
    expect(runProgram.description).toContain("native dependencies/scripts");
    expect(runProgram.description).toContain("tools.<exact_snake_case_name>(direct args)");
    expect(runProgram.description).toContain("tool_load reveals schemas, not permission");
    expect(runProgram.description).toContain("child policy/concurrency apply");
    expect(runProgram.description).toContain("Emit a compact result");
    expect(runProgram.description).not.toContain("deterministic compute/data work");
    expect(runProgram.description).not.toContain("Object.keys");
    expect(runProgram.inputSchema).toEqual({
      type: "object",
      properties: {
        code: expect.objectContaining({
          type: "string",
          description: expect.stringContaining("no Node APIs or direct filesystem/network"),
        }),
      },
      required: ["code"],
      additionalProperties: false,
    });
    const codeDescription = (runProgram.inputSchema.properties as Record<string, { description: string }>).code.description;
    expect(codeDescription).toContain("QuickJS with top-level await");
    expect(codeDescription).toContain("tools.<exact_snake_case_name>(direct args)");
    expect(codeDescription).toContain("{ok,content}");
    expect(codeDescription).toContain("text(value) or json(value)");
    expect(codeDescription).toContain("no Node APIs or direct filesystem/network");

    const result = await runProgram.execute({
      code: "const values = [1, 2, 3, 4]; json({ sum: values.reduce((a, b) => a + b, 0) });",
    }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Program completed after 0 tool calls");
    expect(result.content).toContain('{"sum":10}');
    expect(receipt(result)).toMatchObject({
      source_kind: "inline",
      attempted_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      changed_files: { total: 0, items: [] },
    });
  });

  it("keeps its provider definition fixed while the runtime callable set changes", async () => {
    const names = ["read_files", "run_program", "read_files"];
    const runProgram = createRunProgramTool({
      listToolNames: () => names,
      invokeTool: async () => ({ status: "completed", result: { content: "unused" } }),
    });

    expect(runProgram.description).not.toContain("read_files raw_text:true");
    const initialDefinition = toToolDefinition(runProgram);
    expect(toToolDefinition(runProgram)).toBe(initialDefinition);
    const initialDescription = runProgram.description;
    names.push("bash", "write_file");
    const refreshedDefinition = toToolDefinition(runProgram);
    expect(runProgram.description).toBe(initialDescription);
    expect(refreshedDefinition).toBe(initialDefinition);

    const result = await runProgram.execute({ code: "json(Object.keys(tools));" }, ctx());
    expect(result.content).toContain('["bash","read_files","write_file"]');
    expect(result.content).not.toContain('"run_program"');
  });

  it("executes an authorized saved script exactly and records its source identity", async () => {
    const source = "const values = [2, 3, 5]; json({ sum: values.reduce((a, b) => a + b, 0) });";
    const resolvedPath = "/tmp/orkas-run-program-test/consolidate-corrections.js";
    const runProgram = tool({
      loadSourceFile: async (requestedPath) => ({
        status: "completed",
        source,
        resolvedPath: requestedPath === "consolidate-corrections.js"
          ? resolvedPath
          : requestedPath,
      }),
    });

    expect(runProgram.inputSchema).toMatchObject({
      properties: {
        code: { type: "string" },
        path: { type: "string" },
      },
      oneOf: [{ required: ["code"] }, { required: ["path"] }],
    });
    const pathDescription = (runProgram.inputSchema.properties as Record<string, { description: string }>).path.description;
    expect(pathDescription).toContain("Workspace-visible UTF-8 QuickJS source");
    expect(pathDescription).toContain("Use instead of code, not together");
    const result = await runProgram.execute({ path: "consolidate-corrections.js" }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('{"sum":10}');
    expect(result.observations).toEqual({
      programExecution: {
        sourceKind: "file",
        sourceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        childCalls: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          failedTools: [],
        },
      },
      fileReads: [{
        path: resolvedPath,
        hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }],
    });
    expect(result.observations?.fileReads?.[0]?.hash)
      .toBe(result.observations?.programExecution?.sourceSha256);
    expect(receipt(result)).toMatchObject({
      source_kind: "file",
      source_sha256: result.observations?.programExecution?.sourceSha256,
    });
  });

  it("requires exactly one source and preserves host path denials", async () => {
    const runProgram = tool({
      loadSourceFile: async () => ({
        status: "denied",
        code: "E_PROGRAM_SOURCE_DENIED",
        reason: "E_PATH_OUT_OF_SCOPE: outside workspace",
      }),
    });

    expect(incomplete(await runProgram.execute({}, ctx())).reason).toBe("E_PROGRAM_BAD_INPUT");
    expect(incomplete(await runProgram.execute({ code: "text('x')", path: "x.js" }, ctx())).reason)
      .toBe("E_PROGRAM_BAD_INPUT");
    const denied = incomplete(await runProgram.execute({ path: "../x.js" }, ctx()));
    expect(denied).toMatchObject({
      status: "incomplete",
      reason: "E_PROGRAM_SOURCE_DENIED",
    });
  });

  it("retains saved-source identity when the program itself fails", async () => {
    const runProgram = tool({
      loadSourceFile: async () => ({
        status: "completed",
        source: "const prepared = true;\nthrow new Error('broken saved script');\ntext(prepared);",
        resolvedPath: "/tmp/orkas-run-program-test/broken.js",
      }),
    });

    const result = await runProgram.execute({ path: "broken.js" }, ctx());
    expect(result.isError).toBe(true);
    expect(incomplete(result)).toMatchObject({
      reason: "E_PROGRAM_RUNTIME",
      execution: {
        source_kind: "file",
        error: {
          line: 2,
          sourceExcerpt: [
            { line: 1, text: "const prepared = true;" },
            { line: 2, text: "throw new Error('broken saved script');" },
            { line: 3, text: "text(prepared);" },
          ],
        },
      },
    });
    expect(result.observations).toMatchObject({
      programExecution: {
        sourceKind: "file",
        sourceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it("keeps fixed capability guidance within definition budgets when many tools are active", () => {
    const names = Array.from({ length: 40 }, (_, index) => `workspace_operation_${index}`);
    const runProgram = tool({ names });
    const codeDescription = (runProgram.inputSchema.properties as Record<string, { description: string }>).code.description;

    expect(runProgram.description.length).toBeLessThanOrEqual(480);
    expect(runProgram.description).toBe(tool({ names: [] }).description);
    expect(runProgram.description).not.toContain("workspace_operation_");
    expect(codeDescription.length).toBeLessThanOrEqual(220);
  });

  it("does not expose Node, module loading, or ambient network APIs", async () => {
    const runProgram = tool();
    const result = await runProgram.execute({
      code: `json({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        XMLHttpRequest: typeof XMLHttpRequest,
      });`,
    }, ctx());

    expect(result.content).toContain(
      '{"process":"undefined","require":"undefined","fetch":"undefined","XMLHttpRequest":"undefined"}',
    );
  });

  it("suggests the nearest canonical tool name after an unknown method", async () => {
    const runProgram = tool({ names: ["list_files", "read_files"] });

    const result = await runProgram.execute({
      code: "const result = await tools.listFiles({ path: '.' }); json(result);",
    }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tools.listFiles");
    expect(result.content).toContain("Did you mean tools.list_files?");
  });

  it("explains that text and json are output functions, not helper libraries", async () => {
    const runProgram = tool();

    const result = await runProgram.execute({
      code: "text.encodeBase64('payload');",
    }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("text(value) is an output function");
    expect(result.content).toContain("no .encodeBase64 method");
  });

  it("never injects run_program recursively", async () => {
    const runProgram = tool({ names: ["run_program", "read"] });
    const result = await runProgram.execute({ code: "json(Object.keys(tools));" }, ctx());
    expect(result.content).toContain('["read"]');
    expect(result.content).not.toContain('["read","run_program"]');
  });

  it("supports bounded concurrent fan-out and keeps raw child results inside the program", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const runProgram = tool({
      names: ["lookup"],
      limits: { maxConcurrentToolCalls: 2 },
      invoke: async (_name, input) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        const id = Number(input.id);
        seen.push(id);
        return { status: "completed", result: { content: JSON.stringify({ id, value: id * 2 }) } };
      },
    });

    const result = await runProgram.execute({
      code: `const rows = await Promise.all([1,2,3,4].map((id) => tools.lookup({ id })));
        json(rows.map((row) => JSON.parse(row.content).value));`,
    }, ctx());

    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(result.content).toContain("Program completed after 4 tool calls");
    expect(result.content).toContain("[2,4,6,8]");
    expect(result.content).not.toContain('"id":1');
  });

  it("lets program code handle ordinary child-tool failures", async () => {
    const runProgram = tool({
      names: ["read"],
      invoke: async (_name, input) => ({
        status: "completed",
        result: Number(input.id) === 2
          ? { content: "not found", isError: true }
          : { content: `row-${input.id}` },
      }),
    });

    const result = await runProgram.execute({
      code: `const kept = [];
        for (const id of [1,2,3]) {
          const result = await tools.read({ id });
          if (result.ok) kept.push(result.content);
        }
        json(kept);`,
    }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('["row-1","row-3"]');
    expect(receipt(result)).toMatchObject({
      attempted_calls: 3,
      completed_calls: 3,
      failed_calls: 1,
      failed_tool: { tool: "read", call: 2, message: "not found" },
    });
    expect(result.observations?.programExecution?.childCalls).toEqual({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      failedTools: [{ name: "read", count: 1 }],
    });
  });

  it("keeps a handled all-failed batch successful while exposing its child outcomes", async () => {
    const runProgram = tool({
      names: ["lookup"],
      invoke: async () => ({
        status: "completed",
        result: { content: "record unavailable", isError: true },
      }),
    });

    const result = await runProgram.execute({
      code: `const rows = await Promise.all([1, 2].map((id) => tools.lookup({ id })));
        json({ unavailable: rows.filter((row) => !row.ok).length });`,
    }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('{"unavailable":2}');
    expect(result.observations?.programExecution?.childCalls).toEqual({
      attempted: 2,
      succeeded: 0,
      failed: 2,
      failedTools: [{ name: "lookup", count: 2 }],
    });
  });

  it("ties a runtime failure to the failed child tool and actionable source lines", async () => {
    const runProgram = tool({
      names: ["write"],
      invoke: async () => ({
        status: "completed",
        result: {
          content: JSON.stringify({
            status: "incomplete",
            reason: "E_WRITE_CONFLICT",
            message: "target changed since it was read",
          }),
          isError: true,
        },
      }),
    });
    const result = await runProgram.execute({
      code: `const saved = await tools.write({ path: "out.json" });
if (!saved.ok) {
  throw new Error("write did not complete");
}`,
    }, ctx());

    expect(incomplete(result)).toMatchObject({
      reason: "E_PROGRAM_RUNTIME",
      execution: {
        attempted_calls: 1,
        completed_calls: 1,
        failed_calls: 1,
        failed_tool: {
          tool: "write",
          call: 1,
          code: "E_WRITE_CONFLICT",
          message: "target changed since it was read",
        },
        error: {
          line: 3,
          sourceExcerpt: [
            { line: 2, text: "if (!saved.ok) {" },
            { line: 3, text: "  throw new Error(\"write did not complete\");" },
            { line: 4, text: "}" },
          ],
        },
      },
    });
  });

  it("stops on a Host policy refusal and reports a model-recoverable incomplete result", async () => {
    let calls = 0;
    const runProgram = tool({
      names: ["read", "write"],
      invoke: async (name) => {
        calls += 1;
        if (name === "write") {
          return {
            status: "denied",
            code: "E_PROGRAM_CALLER_NOT_ALLOWED",
            reason: "write requires a direct call",
            directCallAllowed: true,
          };
        }
        return { status: "completed", result: { content: "ok" } };
      },
    });

    const result = await runProgram.execute({
      code: "await tools.write({ value: 1 }); await tools.read({}); text('unreachable');",
    }, ctx());

    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
    expect(incomplete(result)).toEqual(expect.objectContaining({
      status: "incomplete",
      reason: "E_PROGRAM_CALLER_NOT_ALLOWED",
      attempted_calls: 1,
      completed_calls: 0,
      direct_call_allowed: true,
    }));
  });

  it("enforces tool-call, per-result, aggregate-result, and final-output limits", async () => {
    const outcomes: Array<[Partial<RunProgramLimits>, string, string]> = [
      [{ maxToolCalls: 1 }, "await tools.read({}); await tools.read({}); text('x');", "E_PROGRAM_TOOL_CALL_LIMIT"],
      [{ maxToolResultBytes: 3 }, "await tools.read({}); text('x');", "E_PROGRAM_TOOL_RESULT_LIMIT"],
      [{ maxToolResultBytes: 8, maxAggregateToolResultBytes: 5 }, "await tools.read({}); await tools.read({}); text('x');", "E_PROGRAM_AGGREGATE_RESULT_LIMIT"],
      [{ maxOutputBytes: 3 }, "text('four');", "E_PROGRAM_OUTPUT_LIMIT"],
    ];
    for (const [limits, code, expected] of outcomes) {
      const runProgram = tool({
        names: ["read"],
        limits,
        invoke: async () => ({ status: "completed", result: { content: "four" } }),
      });
      const result = await runProgram.execute({ code }, ctx());
      expect(incomplete(result).reason).toBe(expected);
    }
  });

  it("enforces source, wall-clock, and cancellation limits", async () => {
    const sourceLimited = tool({ limits: { maxSourceChars: 4 } });
    expect(incomplete(await sourceLimited.execute({ code: "text('too long')" }, ctx())).reason)
      .toBe("E_PROGRAM_SOURCE_LIMIT");

    const timed = tool({ limits: { maxWallMs: 30 } });
    expect(incomplete(await timed.execute({ code: "while (true) {}" }, ctx())).reason)
      .toBe("E_PROGRAM_TIMEOUT");

    const controller = new AbortController();
    controller.abort();
    const cancelled = tool();
    expect(incomplete(await cancelled.execute({ code: "while (true) {}" }, ctx(controller.signal))).reason)
      .toBe("E_PROGRAM_ABORTED");
  });

  it("bounds a synchronous stretch separately from the wall clock", async () => {
    // QuickJS runs on the host thread: a hot loop freezes every window until
    // the interrupt fires, so a program may not run synchronously for longer
    // than the slice even though the wall-clock budget is minutes.
    const sliced = tool({ limits: { maxSyncSliceMs: 40, maxWallMs: 5_000 } });
    const startedAt = Date.now();
    const spun = await sliced.execute({ code: "while (true) {}" }, ctx());
    expect(incomplete(spun).reason).toBe("E_PROGRAM_CPU_SLICE");
    expect(incomplete(spun).message).toContain("40ms of synchronous code");
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    // Awaiting a tool call hands control back to the host and starts a fresh
    // slice, so cumulative CPU across awaits is governed by the wall clock only.
    const yielding = tool({
      names: ["probe"],
      limits: { maxSyncSliceMs: 40, maxWallMs: 5_000 },
      invoke: async () => ({ status: "completed", result: { content: "ok" } }),
    });
    const spin = "const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };";
    const yielded = await yielding.execute({
      code: `${spin} spin(25); await tools.probe({}); spin(25); await tools.probe({}); spin(25); text('done');`,
    }, ctx());
    expect(yielded.content).toContain("done");
    expect(yielded.content).not.toContain("E_PROGRAM_CPU_SLICE");

    // The wall clock still wins when it is the tighter bound.
    const walled = tool({ limits: { maxSyncSliceMs: 5_000, maxWallMs: 30 } });
    expect(incomplete(await walled.execute({ code: "while (true) {}" }, ctx())).reason)
      .toBe("E_PROGRAM_TIMEOUT");
  });

  it("enforces isolated heap and stack limits", async () => {
    const memoryLimited = tool({ limits: { maxMemoryBytes: 2 * 1024 * 1024, maxWallMs: 2_000 } });
    const memory = await memoryLimited.execute({
      code: "const rows = []; for (let i = 0; i < 1_000_000; i++) rows.push({ i, a: i + 1, b: i + 2 }); text(rows.length);",
    }, ctx());
    expect(incomplete(memory).reason).toBe("E_PROGRAM_MEMORY_LIMIT");

    const stackLimited = tool({ limits: { maxStackBytes: 64 * 1024 } });
    const stack = await stackLimited.execute({
      code: "function recurse() { return recurse(); } recurse();",
    }, ctx());
    expect(incomplete(stack).reason).toBe("E_PROGRAM_STACK_LIMIT");
  });

  it("cancels an in-flight child call through the linked signal", async () => {
    const controller = new AbortController();
    let childObservedAbort = false;
    const runProgram = tool({
      names: ["slow_read"],
      invoke: async (_name, _input, childCtx) => new Promise((resolve) => {
        childCtx.signal?.addEventListener("abort", () => {
          childObservedAbort = true;
          resolve({ status: "aborted", code: "E_PROGRAM_ABORTED", reason: "cancelled" });
        }, { once: true });
      }),
    });
    const pending = runProgram.execute({
      code: "await tools.slow_read({}); text('unreachable');",
    }, ctx(controller.signal));
    setTimeout(() => controller.abort(), 10);

    const result = await pending;
    expect(incomplete(result).reason).toBe("E_PROGRAM_ABORTED");
    expect(childObservedAbort).toBe(true);
  });

  it("cancels a child call the program left un-awaited once the program finishes", async () => {
    // A completed program used to leave a fire-and-forget child running with
    // a live signal (2026-08-28 review C-1).
    let childObservedAbort = false;
    const runProgram = tool({
      names: ["slow_read"],
      invoke: async (_name, _input, childCtx) => new Promise((resolve) => {
        childCtx.signal?.addEventListener("abort", () => {
          childObservedAbort = true;
          resolve({ status: "aborted", code: "E_PROGRAM_ABORTED", reason: "cancelled" });
        }, { once: true });
      }),
    });
    const result = await runProgram.execute({
      code: "tools.slow_read({}); text('returned early');",
    }, ctx());
    expect(result.content).toContain("returned early");
    expect(childObservedAbort).toBe(true);
  });

  it("preserves child file observations and returns a bounded changed-file receipt", async () => {
    const runProgram = tool({
      names: ["read"],
      invoke: async () => ({
        status: "completed",
        result: {
          content: "contents",
          observations: {
            fileReads: [{ path: "/tmp/a.txt", hash: "abc" }],
            fileChanges: [{
              operation: "create",
              sourcePath: "/tmp/orkas-run-program-test/out.json",
              beforeExists: false,
              afterExists: true,
              afterBytes: 12,
              afterHash: "sha256:after",
              coverage: "exact",
            }],
          },
        },
      }),
    });
    const result = await runProgram.execute({
      code: "const result = await tools.read({}); json({ contentLength: result.content.length, artifacts: result.artifacts });",
    }, ctx());

    expect(result.observations?.fileReads).toEqual([{ path: "/tmp/a.txt", hash: "abc" }]);
    expect(result.content).toContain(JSON.stringify({
      contentLength: 8,
      artifacts: [{
        path: "out.json",
        operation: "create",
        exists: true,
        bytes: 12,
        hash: "sha256:after",
      }],
    }));
    expect(receipt(result).changed_files).toEqual({
      total: 1,
      items: [{
        path: "out.json",
        operation: "create",
        bytes: 12,
        hash: "sha256:after",
      }],
    });
  });

  it("charges program-visible artifact identities to the aggregate result limit", async () => {
    const runProgram = tool({
      names: ["write"],
      limits: { maxAggregateToolResultBytes: 80 },
      invoke: async () => ({
        status: "completed",
        result: {
          content: "ok",
          observations: {
            fileChanges: [{
              operation: "create",
              sourcePath: `/tmp/orkas-run-program-test/${"nested/".repeat(12)}out.json`,
              beforeExists: false,
              afterExists: true,
              afterBytes: 2,
              afterHash: "sha256:after",
            }],
          },
        },
      }),
    });

    const result = await runProgram.execute({
      code: "await tools.write({}); text('unreachable');",
    }, ctx());

    expect(incomplete(result).reason).toBe("E_PROGRAM_AGGREGATE_RESULT_LIMIT");
  });

  it("bounds large changed-file receipts while preserving the exact total", async () => {
    const runProgram = tool({
      names: ["write"],
      invoke: async (_name, input) => {
        const path = String(input.path);
        return {
          status: "completed",
          result: {
            content: "saved",
            observations: {
              fileChanges: [{
                operation: "create",
                sourcePath: `/tmp/orkas-run-program-test/${path}`,
                beforeExists: false,
                afterExists: true,
                afterBytes: 4,
                afterHash: `hash:${path}`,
              }],
            },
          },
        };
      },
    });
    const result = await runProgram.execute({
      code: `await Promise.all(Array.from({ length: 12 }, (_, index) => (
        tools.write({ path: \`result-\${index}.json\` })
      )));
      json({ verified: true });`,
    }, ctx());

    expect(receipt(result).changed_files).toMatchObject({
      total: 12,
      truncated: true,
    });
    expect(receipt(result).changed_files.items).toHaveLength(8);
    expect(receipt(result).changed_files.items.every((item) => !item.path.startsWith("/")))
      .toBe(true);
  });

  it("emits auditable progress around each child-tool execution", async () => {
    const events: Array<{ phase: string; data?: Record<string, unknown> }> = [];
    const runProgram = tool({
      names: ["read"],
      invoke: async () => ({ status: "completed", result: { content: "ok" } }),
    });
    const result = await runProgram.execute({
      code: "await tools.read({ path: 'a.txt' }); text('done');",
    }, {
      ...ctx(),
      emitProgress: (event) => events.push(event),
    });

    expect(result.isError).not.toBe(true);
    expect(events.map((event) => event.phase)).toEqual([
      "program_tool",
      "program_tool_complete",
    ]);
    expect(events[0]?.data).toMatchObject({ programmatic: true, tool: "read", completedCalls: 0 });
    expect(events[1]?.data).toMatchObject({ programmatic: true, tool: "read", ok: true });
  });

  it("accepts successful child-tool side effects without requiring synthetic stdout", async () => {
    const runProgram = tool({ names: ["write"] });
    const result = await runProgram.execute({ code: "await tools.write({ path: 'out.txt' });" }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Program completed after 1 tool call with no emitted output.");
    expect(receipt(result)).toMatchObject({
      attempted_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
    });
  });

  it("returns deterministic errors for syntax failures, inert programs, and silent child errors", async () => {
    const runProgram = tool();
    const syntax = await runProgram.execute({ code: "const = nope" }, ctx());
    expect(incomplete(syntax).reason).toBe("E_PROGRAM_SYNTAX");

    const empty = await runProgram.execute({ code: "const answer = 42;" }, ctx());
    expect(incomplete(empty).reason).toBe("E_PROGRAM_NO_OUTPUT");

    const failedChild = tool({
      names: ["write"],
      invoke: async () => ({
        status: "completed",
        result: { content: "write failed", isError: true },
      }),
    });
    const silentFailure = await failedChild.execute({ code: "await tools.write({ path: 'out.txt' });" }, ctx());
    expect(incomplete(silentFailure).reason).toBe("E_PROGRAM_NO_OUTPUT");
  });
});
