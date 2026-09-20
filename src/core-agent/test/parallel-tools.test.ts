import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner, partitionToolBatches } from "../src/agent/runner.js";
import { PersistentSession } from "../src/agent/persistent-session.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { defineTool, toolCallIsParallel } from "../src/tools/base.js";
import { bashTool } from "../src/tools/builtin.js";
import type { LLMProvider, CompletionParams, CompletionResult } from "../src/providers/base.js";

// ── partitionToolBatches (pure) ────────────────────────────────────────────

describe("partitionToolBatches", () => {
  const part = (calls: string[], parallel: string[]) =>
    partitionToolBatches(calls, (c) => parallel.includes(c));

  it("groups all-parallel into one batch", () => {
    expect(part(["a", "b", "c"], ["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("keeps all-sequential as singleton batches", () => {
    expect(part(["a", "b", "c"], [])).toEqual([["a"], ["b"], ["c"]]);
  });

  it("a sequential call is a barrier between parallel runs", () => {
    // [read, read, write, read] -> (read,read) | (write) | (read)
    expect(part(["r1", "r2", "w", "r3"], ["r1", "r2", "r3"])).toEqual([
      ["r1", "r2"],
      ["w"],
      ["r3"],
    ]);
  });

  it("alternating parallel/sequential never merges across a barrier", () => {
    expect(part(["p", "s", "p"], ["p"])).toEqual([["p"], ["s"], ["p"]]);
  });

  it("preserves declared order and treats unknown (non-parallel) as a barrier", () => {
    // 'x' not in the parallel set -> its own singleton, splitting the reads.
    expect(part(["r1", "x", "r2"], ["r1", "r2"])).toEqual([["r1"], ["x"], ["r2"]]);
  });
});

describe("defineTool executionMode plumbing", () => {
  it("carries executionMode through, defaults to undefined (= sequential)", () => {
    const par = defineTool({
      name: "p", description: "p", inputSchema: { type: "object" },
      executionMode: "parallel", async execute() { return { content: "" }; },
    });
    expect(par.executionMode).toBe("parallel");
    const def = defineTool({
      name: "d", description: "d", inputSchema: { type: "object" },
      async execute() { return { content: "" }; },
    });
    expect(def.executionMode).toBeUndefined();
  });
});

// ── runner integration (concurrency + ordered commit + barriers) ───────────

function recordingProvider(responses: CompletionResult[]): {
  provider: LLMProvider;
  calls: CompletionParams[];
} {
  let idx = 0;
  const calls: CompletionParams[] = [];
  const pick = () => (idx >= responses.length ? responses[responses.length - 1] : responses[idx++]);
  const provider: LLMProvider = {
    id: "mock",
    name: "Mock",
    async complete(p: CompletionParams) {
      calls.push(p);
      return pick();
    },
    async *stream(p: CompletionParams) {
      calls.push(p);
      const r = pick();
      yield { type: "message_start" as const };
      for (const c of r.content) {
        if (c.type === "text") {
          yield { type: "text_delta" as const, text: c.text };
        } else if (c.type === "tool_use") {
          yield { type: "tool_use_start" as const, id: c.id, name: c.name };
          yield { type: "tool_use_delta" as const, id: c.id, input: JSON.stringify(c.input) };
          yield { type: "tool_use_end" as const, id: c.id };
        }
      }
      yield {
        type: "message_end" as const,
        stopReason: r.stopReason,
        usage: r.usage,
        content: r.content,
        model: r.model,
      };
    },
    async validateAuth() {
      return true;
    },
  };
  return { provider, calls };
}

/** Shared concurrency tracker so a test can assert tools overlapped. */
function tracker() {
  let active = 0;
  let max = 0;
  const log: string[] = [];
  function tool(
    name: string,
    mode: "parallel" | "sequential" | undefined,
    opts: { delayMs?: number; fail?: boolean } = {},
  ) {
    return defineTool({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      ...(mode ? { executionMode: mode } : {}),
      async execute() {
        active++;
        max = Math.max(max, active);
        log.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 10));
        active--;
        log.push(`end:${name}`);
        if (opts.fail) throw new Error(`${name} failed`);
        return { content: `${name}-ok` };
      },
    });
  }
  return { tool, log, get max() { return max; } };
}

function toolUseResponse(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>): CompletionResult {
  return {
    content: blocks.map((b) => ({ type: "tool_use" as const, id: b.id, name: b.name, input: b.input ?? {} })),
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    model: "mock-model",
  };
}
const finalResponse: CompletionResult = {
  content: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  model: "mock-model",
};

async function runCollect(
  tools: ReturnType<typeof defineTool>[],
  provider: LLMProvider,
  session?: PersistentSession,
) {
  const registry = new ProviderRegistry();
  registry.registerFactory("mock", () => provider);
  const config = createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } });
  const runner = new AgentRunner({ config, providers: registry, tools, session });
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of runner.runStream({ message: "go" })) {
    events.push(ev as { type: string; [k: string]: unknown });
  }
  return events;
}

describe("AgentRunner — parallel tool execution (G4)", () => {
  it("keeps queued calls proposed until an execution slot is available", async () => {
    vi.stubEnv("ORKAS_MAX_TOOL_CONCURRENCY", "1");
    try {
      const t = tracker();
      const { provider } = recordingProvider([
        toolUseResponse([{ id: "a", name: "first" }, { id: "b", name: "second" }]), finalResponse,
      ]);
      const events = await runCollect([t.tool("first", "parallel"), t.tool("second", "parallel")], provider);
      expect(events.filter(e => e.type === "tool_start" || e.type === "tool_end")
        .map(e => `${e.type}:${e.id}`)).toEqual(["tool_start:a", "tool_end:a", "tool_start:b", "tool_end:b"]);
      expect(t.max).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  // The two rendezvous commands below can only both succeed when they run at
  // the same time. The scheduler side is exercised with a tool that admits
  // every call; whether a real command is admitted (provably read-only) is
  // the host's decision, pinned in test/main/model/local-tools.test.ts.
  it.each([false, true])("overlaps independent real shell commands the tool admits (programmatic=%s)", async (programmatic) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-overlap-"));
    const quote = (s: string) => "'" + s.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
    const inputs = [0, 1].map((id) => {
      // Neither command can succeed unless the other starts before it finishes.
      const script = `const fs=require('fs'); fs.writeFileSync('${id}.ready','');
        const deadline=Date.now()+2500; const timer=setInterval(()=>{
          if(fs.existsSync('${1 - id}.ready')) {clearInterval(timer); console.log('shell-${id}-ok');}
          else if(Date.now()>deadline) {clearInterval(timer); process.exitCode=1;}
        },10);`;
      return { command: `${process.platform === "win32" ? "& " : ""}${quote(process.env.ORKAS_TEST_NODE || process.execPath)} -e ${quote(script)}`, timeoutMs: 5000 };
    });
    const { provider, calls } = recordingProvider([
      toolUseResponse(programmatic
        ? [{ id: "program", name: "run_program", input: { code: `const results=await Promise.all(${JSON.stringify(inputs)}.map(input=>tools.bash(input))); results.forEach(text);` } }]
        : inputs.map((input, id) => ({ id: `shell-${id}`, name: "bash", input }))),
      finalResponse,
    ]);
    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => provider);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }),
      providers: registry, tools: [{ ...bashTool, executionMode: "parallel", parallelWhen: () => true }],
      ...(programmatic ? { programmaticToolPolicy: {
        isEligible: () => true, authorize: () => ({ allowed: true as const }),
      } } : {}),
    });
    try {
      for await (const _event of runner.runStream({ message: "go", workingDir: cwd })) { /* drain */ }
      const results = calls[1].messages.flatMap(m => m.content)
        .filter(c => c.type === "tool_result");
      expect(results.every(r => !r.isError)).toBe(true);
      const content = results.map(r => r.content).join("\n");
      expect(content).toContain("shell-0-ok");
      expect(content).toContain("shell-1-ok");
      if (!programmatic) expect(results.map(r => r.toolUseId)).toEqual(["shell-0", "shell-1"]);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("serializes shell calls the tool cannot prove read-only", async () => {
    // Same rendezvous pair, but the core bash tool carries no read-only proof,
    // so the second call must not start before the first finishes: the first
    // waits out its deadline alone, the second then finds the ready file.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-serial-"));
    const quote = (s: string) => "'" + s.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
    const inputs = [0, 1].map((id) => {
      const script = `const fs=require('fs'); fs.writeFileSync('${id}.ready','');
        const deadline=Date.now()+1200; const timer=setInterval(()=>{
          if(fs.existsSync('${1 - id}.ready')) {clearInterval(timer); console.log('shell-${id}-ok');}
          else if(Date.now()>deadline) {clearInterval(timer); console.log('shell-${id}-alone'); process.exitCode=1;}
        },10);`;
      return { command: `${process.platform === "win32" ? "& " : ""}${quote(process.env.ORKAS_TEST_NODE || process.execPath)} -e ${quote(script)}`, timeoutMs: 5000 };
    });
    const { provider, calls } = recordingProvider([
      toolUseResponse(inputs.map((input, id) => ({ id: `shell-${id}`, name: "bash", input }))),
      finalResponse,
    ]);
    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => provider);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }),
      providers: registry, tools: [bashTool],
    });
    try {
      for await (const _event of runner.runStream({ message: "go", workingDir: cwd })) { /* drain */ }
      const results = calls[1].messages.flatMap(m => m.content).filter(c => c.type === "tool_result");
      expect(results.map(r => r.toolUseId)).toEqual(["shell-0", "shell-1"]);
      expect(results[0].content).toContain("shell-0-alone");
      expect(results[0].content).not.toContain("shell-0-ok");
      expect(results[1].content).toContain("shell-1-ok");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("admits per call: refined parallel tools overlap only for admitted inputs", async () => {
    // [ro, ro, write, ro]: the two leading read-only calls overlap, the write
    // is a barrier on its own, the trailing read-only call runs after it.
    let active = 0;
    let max = 0;
    const order: string[] = [];
    const tool = defineTool({
      name: "shell_like",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
      executionMode: "parallel",
      parallelWhen: (input) => input.ro === true,
      async execute(input) {
        active++; max = Math.max(max, active); order.push(String(input.id));
        await new Promise(r => setTimeout(r, 25));
        active--;
        return { content: `${String(input.id)}-ok` };
      },
    });
    const { provider, calls } = recordingProvider([
      toolUseResponse([
        { id: "a", name: "shell_like", input: { id: "a", ro: true } },
        { id: "b", name: "shell_like", input: { id: "b", ro: true } },
        { id: "c", name: "shell_like", input: { id: "c", ro: false } },
        { id: "d", name: "shell_like", input: { id: "d", ro: true } },
      ]),
      finalResponse,
    ]);
    await runCollect([tool], provider);
    expect(max).toBe(2);
    expect(order).toEqual(["a", "b", "c", "d"]);
    const msgs = JSON.stringify(calls[1].messages);
    for (const [first, second] of [["a-ok", "b-ok"], ["b-ok", "c-ok"], ["c-ok", "d-ok"]]) {
      expect(msgs.indexOf(first)).toBeLessThan(msgs.indexOf(second));
    }
  });

  it("bounds an opted-in shell batch and never executes queued calls after cancellation", async () => {
    vi.stubEnv("ORKAS_MAX_TOOL_CONCURRENCY", "2");
    const abort = new AbortController();
    const started: number[] = [];
    const { provider } = recordingProvider([
      toolUseResponse([0, 1, 2, 3].map(id => ({ id: String(id), name: "bash", input: { id } }))), finalResponse,
    ]);
    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => provider);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }), providers: registry,
      tools: [{ ...bashTool, executionMode: "parallel", async execute(input, ctx) {
        started.push(Number(input.id));
        return new Promise(resolve => ctx.signal!.addEventListener("abort", () => resolve({ content: "cancelled", isError: true }), { once: true }));
      } }],
    });
    const run = (async () => { for await (const _event of runner.runStream({ message: "go", signal: abort.signal })) { /* drain */ } })();
    try {
      await expect.poll(() => started.length).toBe(2);
      abort.abort();
      await run;
      expect(started).toEqual([0, 1]);
    } finally { abort.abort(); await run; vi.unstubAllEnvs(); }
  });

  it("runs an adjacent parallel batch concurrently and commits results in declared order", async () => {
    const { provider, calls } = recordingProvider([
      toolUseResponse([
        { id: "a", name: "read_a" },
        { id: "b", name: "read_b" },
        { id: "c", name: "read_c" },
      ]),
      finalResponse,
    ]);
    const tr = tracker();
    // Different delays so completion order (b, c, a) != declared order (a, b, c):
    // a regression to completion-order commit would reorder the tool_results.
    const tools = [
      tr.tool("read_a", "parallel", { delayMs: 30 }),
      tr.tool("read_b", "parallel", { delayMs: 10 }),
      tr.tool("read_c", "parallel", { delayMs: 20 }),
    ];

    const events = await runCollect(tools, provider);

    // All three executed concurrently.
    expect(tr.max).toBe(3);
    // Every tool produced a tool_end (interleaved order is fine — routed by id).
    const endIds = events.filter((e) => e.type === "tool_end").map((e) => e.id).sort();
    expect(endIds).toEqual(["a", "b", "c"]);
    // tool_results reach the model on call 2 in DECLARED order (a, b, c),
    // not completion order (b, c, a).
    const msgs = JSON.stringify(calls[1].messages);
    expect(msgs.indexOf("read_a-ok")).toBeGreaterThanOrEqual(0);
    expect(msgs.indexOf("read_a-ok")).toBeLessThan(msgs.indexOf("read_b-ok"));
    expect(msgs.indexOf("read_b-ok")).toBeLessThan(msgs.indexOf("read_c-ok"));
  });

  it("persists a settled parallel result batch with one context sidecar rewrite", async () => {
    const sessionFile = path.join(
      os.tmpdir(),
      `core-agent-parallel-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const contextFile = `${sessionFile}.context.json`;
    const session = new PersistentSession({ sessionFile });
    const { provider } = recordingProvider([
      toolUseResponse([
        { id: "persist-a", name: "read_a" },
        { id: "persist-b", name: "read_b" },
        { id: "persist-c", name: "read_c" },
      ]),
      finalResponse,
    ]);
    const tr = tracker();
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      await runCollect([
        tr.tool("read_a", "parallel"),
        tr.tool("read_b", "parallel"),
        tr.tool("read_c", "parallel"),
      ], provider, session);

      const contextWrites = writeSpy.mock.calls.filter(
        ([target]) => target === `${contextFile}.tmp`,
      );
      // The full run has five durability boundaries. Regressing to one sidecar
      // rewrite per parallel result raises this from five to seven.
      expect(contextWrites).toHaveLength(5);
      expect(session.getExecutionPlan()).toBeUndefined();

      const transcript = fs.readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const persistedResultIds = transcript.flatMap((message) => message.content)
        .filter((item) => item.type === "tool_result")
        .map((item) => item.toolUseId);
      expect(persistedResultIds).toEqual(["persist-a", "persist-b", "persist-c"]);
      expect(JSON.parse(fs.readFileSync(contextFile, "utf8")).completedWork)
        .toHaveLength(3);

      const restored = new PersistentSession({ sessionFile });
      const restoredResultIds = restored.getMessages()
        .flatMap((message) => message.content)
        .filter((item) => item.type === "tool_result")
        .map((item) => item.toolUseId);
      expect(restoredResultIds).toEqual(["persist-a", "persist-b", "persist-c"]);
      expect(restored.getSerializedContextState()?.completedWork)
        .toHaveLength(3);
    } finally {
      writeSpy.mockRestore();
      for (const target of [sessionFile, `${sessionFile}.tmp`, contextFile, `${contextFile}.tmp`]) {
        try { fs.unlinkSync(target); } catch { /* ignore */ }
      }
    }
  });

  it("a failing tool in a parallel batch does not cancel its siblings", async () => {
    const { provider } = recordingProvider([
      toolUseResponse([
        { id: "a", name: "read_a" },
        { id: "b", name: "read_b" },
        { id: "c", name: "read_c" },
      ]),
      finalResponse,
    ]);
    const tr = tracker();
    const tools = [
      tr.tool("read_a", "parallel", { delayMs: 15 }),
      tr.tool("read_b", "parallel", { delayMs: 5, fail: true }),
      tr.tool("read_c", "parallel", { delayMs: 15 }),
    ];

    const events = await runCollect(tools, provider);

    expect(tr.max).toBe(3); // all three still started despite b failing
    const ends = events.filter((e) => e.type === "tool_end");
    expect(ends.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    const bEnd = ends.find((e) => e.id === "b");
    expect(bEnd?.isError).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
    expect((events[events.length - 1] as any).result.text).toBe("done");
  });

  it("a sequential (default) batch runs serially — no concurrency", async () => {
    const { provider } = recordingProvider([
      toolUseResponse([
        { id: "a", name: "seq_a" },
        { id: "b", name: "seq_b" },
      ]),
      finalResponse,
    ]);
    const tr = tracker();
    // No executionMode -> default sequential.
    const tools = [tr.tool("seq_a", undefined, { delayMs: 10 }), tr.tool("seq_b", undefined, { delayMs: 10 })];

    await runCollect(tools, provider);

    expect(tr.max).toBe(1); // never overlapped
    expect(tr.log).toEqual(["start:seq_a", "end:seq_a", "start:seq_b", "end:seq_b"]);
  });

  it("a sequential tool is a barrier: (read,read) -> write -> read", async () => {
    const { provider } = recordingProvider([
      toolUseResponse([
        { id: "1", name: "read_a" },
        { id: "2", name: "read_b" },
        { id: "3", name: "write_x" },
        { id: "4", name: "read_c" },
      ]),
      finalResponse,
    ]);
    const tr = tracker();
    const tools = [
      tr.tool("read_a", "parallel", { delayMs: 25 }),
      tr.tool("read_b", "parallel", { delayMs: 5 }),
      tr.tool("write_x", "sequential", { delayMs: 5 }),
      tr.tool("read_c", "parallel", { delayMs: 5 }),
    ];

    await runCollect(tools, provider);
    const at = (s: string) => tr.log.indexOf(s);

    // read_a and read_b overlap (b starts before a ends).
    expect(at("start:read_b")).toBeLessThan(at("end:read_a"));
    // write_x is a barrier: it starts only after BOTH reads finished.
    expect(at("start:write_x")).toBeGreaterThan(at("end:read_a"));
    expect(at("start:write_x")).toBeGreaterThan(at("end:read_b"));
    // read_c starts only after write_x finished.
    expect(at("start:read_c")).toBeGreaterThan(at("end:write_x"));
  });
});

describe("toolCallIsParallel", () => {
  const base = { name: "t", description: "d", inputSchema: {}, async execute() { return { content: "" }; } };
  it("treats undeclared and sequential tools as barriers", () => {
    expect(toolCallIsParallel(undefined, {})).toBe(false);
    expect(toolCallIsParallel(base, {})).toBe(false);
    expect(toolCallIsParallel({ ...base, executionMode: "sequential" }, {})).toBe(false);
  });
  it("admits an unrefined parallel tool for every input", () => {
    expect(toolCallIsParallel({ ...base, executionMode: "parallel" }, { any: 1 })).toBe(true);
  });
  it("lets the refinement decide per input and fails closed on a throw or non-object input", () => {
    const tool = { ...base, executionMode: "parallel" as const, parallelWhen: (i: Record<string, unknown>) => i.ro === true };
    expect(toolCallIsParallel(tool, { ro: true })).toBe(true);
    expect(toolCallIsParallel(tool, { ro: false })).toBe(false);
    expect(toolCallIsParallel(tool, undefined)).toBe(false);
    expect(toolCallIsParallel(tool, ["ro"])).toBe(false);
    expect(toolCallIsParallel({ ...tool, parallelWhen: () => { throw new Error("boom"); } }, { ro: true })).toBe(false);
    // Only a literal true admits; a truthy non-boolean is not a proof.
    expect(toolCallIsParallel({ ...tool, parallelWhen: (() => "yes") as unknown as (i: Record<string, unknown>) => boolean }, { ro: true })).toBe(false);
  });
});
