import { describe, it, expect } from "vitest";
import { AgentRunner, partitionToolBatches } from "../src/agent/runner.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { defineTool } from "../src/tools/base.js";
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

function toolUseResponse(blocks: Array<{ id: string; name: string }>): CompletionResult {
  return {
    content: blocks.map((b) => ({ type: "tool_use" as const, id: b.id, name: b.name, input: {} })),
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

async function runCollect(tools: ReturnType<typeof defineTool>[], provider: LLMProvider) {
  const registry = new ProviderRegistry();
  registry.registerFactory("mock", () => provider);
  const config = createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } });
  const runner = new AgentRunner({ config, providers: registry, tools });
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of runner.runStream({ message: "go" })) {
    events.push(ev as { type: string; [k: string]: unknown });
  }
  return events;
}

describe("AgentRunner — parallel tool execution (G4)", () => {
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
