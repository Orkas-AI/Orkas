import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CompletionParams, LLMProvider } from "../src/providers/base.js";
import type { AgentTool, ToolResult } from "../src/tools/base.js";
import { ProviderError } from "../src/shared/errors.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const unchanged = (): ToolResult => ({ content: "Already saved", observations: {
  stateMutation: { scope: "fixture-store", version: "v1", changed: false },
} });
type Call = { name: string; input?: Record<string, unknown> };
const call = (): Call => ({ name: "work", input: { target: "result" } });
function fixture(rounds: Call[][], tool: AgentTool, summary: "success" | "empty" | "error" = "success") {
  const requests: CompletionParams[] = [];
  const summaries: CompletionParams[] = [];
  let next = 0;
  const provider: LLMProvider = {
    id: "repeat-test", name: "Repeat test", async validateAuth() { return true; },
    async complete(params) {
      summaries.push(params);
      if (summary === "error") throw new Error("fixture summary unavailable");
      return { model: "test", stopReason: "end_turn", usage,
        content: [{ type: "text", text: summary === "empty" ? "" : "Saved work retained; stopped repeating." }] };
    },
    async *stream(params) {
      requests.push(structuredClone(params));
      const index = next++;
      const calls = rounds[index];
      const content = calls ? calls.map((c, i) => ({ type: "tool_use" as const,
        id: `${index}-${i}`, name: c.name, input: c.input ?? {},
      })) : [{ type: "text" as const, text: "Delivered" }];
      for (const c of content) if (c.type === "tool_use") {
        yield { type: "tool_use_start", id: c.id, name: c.name };
        yield { type: "tool_use_delta", id: c.id, input: JSON.stringify(c.input) };
      }
      yield { type: "message_end", model: "test", usage, content, stopReason: calls ? "tool_use" : "end_turn" };
    },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory(provider.id, () => provider);
  const runner = new AgentRunner({ config: createConfig({ agent: {
    defaultProvider: provider.id, defaultModel: "test", maxRetries: 1, maxToolLoops: 30,
  } }), providers, tools: [tool], evolution: { enabled: false } });
  return { runner, requests, summaries, provider };
}
function work(execute: AgentTool["execute"], executionMode: AgentTool["executionMode"] = "sequential"): AgentTool {
  return { name: "work", description: "Perform fixture work", inputSchema: { type: "object" }, executionMode, execute };
}
const repeatControl = (p: CompletionParams) => JSON.stringify(p.messages.filter(m => m.role === "developer"))
  .includes("consecutive completed rounds");

describe("completed-evidence repeat protection", () => {
  it("a failed feedback request is retried with the same control without replaying tools", async () => {
    let executed = 0;
    const f = fixture(Array.from({ length: 8 }, () => [call()]), work(async () => { executed++; return unchanged(); }));
    const original = f.provider.stream.bind(f.provider);
    const controls: boolean[] = [];
    let failed = false;
    f.provider.stream = async function* (params) {
      controls.push(repeatControl(params));
      if (repeatControl(params) && !failed) {
        failed = true;
        throw new ProviderError("fixture service unavailable", f.provider.id, 503);
      }
      yield* original(params);
    };
    const result = await f.runner.run({ message: "Finish the saved work" });
    expect(executed).toBe(5);
    expect(controls).toEqual([false, false, false, true, true, false]);
    expect(result.meta.termination?.reason).toBe("repetitive_tool_calls");
  });

  it("new user direction discards the old episode and its pending warning", async () => {
    let executed = 0;
    let steered = false;
    const f = fixture(Array.from({ length: 7 }, () => [call()]), work(async () => { executed++; return unchanged(); }));
    const result = await f.runner.run({ message: "Save the first requirement", drainSteer: async () => {
      if (executed !== 3 || steered) return [];
      steered = true;
      return [{ id: "new-requirement", content: [{ type: "text", text: "Recheck under the new requirement." }] }];
    } });
    expect(executed).toBe(7);
    expect(result.text).toBe("Delivered");
    expect(f.requests[3].messages.some(m => JSON.stringify(m).includes("new requirement"))).toBe(true);
    expect(repeatControl(f.requests[3])).toBe(false);
  });

  it("cancellation during final synthesis cannot turn a stopped task into a successful reply", async () => {
    const controller = new AbortController();
    const f = fixture(Array.from({ length: 8 }, () => [call()]), work(async () => unchanged()));
    f.provider.complete = async () => {
      controller.abort();
      return { model: "test", stopReason: "end_turn", usage, content: [{ type: "text", text: "must not be accepted" }] };
    };
    const result = await f.runner.run({ message: "Save work", signal: controller.signal });
    expect(result.meta.aborted).toBe(true);
    expect(result.text).not.toContain("must not be accepted");
    expect(f.requests).toHaveLength(5);
  });

  it("a real context checkpoint invalidates delivered-evidence and warning state", async () => {
    let executed = 0;
    let checkpointed = false;
    const f = fixture(Array.from({ length: 7 }, () => [call()]), work(async () => { executed++; return unchanged(); }));
    const result = await f.runner.run({ message: "Save and verify", drainSteer: async () => {
      if (executed === 3 && !checkpointed) {
        checkpointed = true;
        const session = f.runner.getSession();
        session.applyActiveCheckpointSummary('Earlier writes have been summarized.', session.getMessages().length - 1);
      }
      return [];
    } });
    expect(checkpointed).toBe(true);
    expect(executed).toBe(7);
    expect(result.text).toBe("Delivered");
    expect(result.meta.termination).toBeUndefined();
  });

  it("the independent budget closes every unexecuted proposal explicitly", async () => {
    let executed = 0;
    const f = fixture(Array.from({ length: 32 }, () => [call()]), work(async () => { executed++; return { content: "unknown" }; }));
    const events = [];
    for await (const event of f.runner.runStream({ message: "Complete bounded work" })) events.push(event);
    expect(executed).toBe(30);
    const ends = events.filter(e => e.type === "tool_end");
    expect(ends).toHaveLength(31);
    expect(ends.at(-1)).toMatchObject({ skipped: true, durationMs: 0 });
    expect(events.at(-1)).toMatchObject({ type: "done", result: { meta: { termination: { reason: "tool_loop_limit" } } } });
  });
  it.each(["success", "empty", "error"] as const)("stops only after feedback and two more unchanged rounds; summary %s", async summary => {
    let executed = 0;
    const f = fixture(Array.from({ length: 8 }, () => [call()]), work(async () => { executed++; return unchanged(); }), summary);
    const events = [];
    for await (const event of f.runner.runStream({ message: "Save the result and finish" })) events.push(event);
    const done = events.find(e => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("missing terminal result");
    expect(executed).toBe(5);
    expect(f.requests.map(repeatControl)).toEqual([false, false, false, true, false]);
    expect(f.summaries).toHaveLength(1);
    expect(f.summaries[0].tools ?? []).toEqual([]);
    expect(done.result.meta.termination).toEqual({ status: "stopped", reason: "repetitive_tool_calls" });
    expect(done.result.text).toMatch(/stopped/i);
    expect(events.filter(e => e.type === "tool_start")).toHaveLength(5);
    expect(events.filter(e => e.type === "tool_end")).toHaveLength(5);
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
    const history = JSON.stringify(f.runner.getSession().getMessages());
    expect(history).not.toContain("consecutive completed rounds");
    expect(history).not.toContain("This tool call was not executed");
  });

  it.each(["sequential", "parallel"] as const)("a single %s batch of five identical calls receives feedback before any stop", async mode => {
    let executed = 0;
    const f = fixture([Array.from({ length: 5 }, call)], work(async () => { executed++; return unchanged(); }, mode));
    const result = await f.runner.run({ message: "Save these items" });
    expect(executed).toBe(5);
    expect(result.text).toBe("Delivered");
    expect(result.meta.termination).toBeUndefined();
    expect(f.summaries).toHaveLength(0);
  });

  it.each(["unknown", "failure", "productive", "partial"] as const)("identical calls with %s outcomes may complete", async kind => {
    let writes = 0;
    const f = fixture(Array.from({ length: 9 }, () => [call()]), work(async () => {
      writes++;
      if (kind === "productive") return { content: "ok", observations: { stateMutation: {
        scope: "fixture-store", version: String(writes), changed: true,
      } } };
      if (kind === "partial") return { content: "ok", observations: { fileChanges: [{
        operation: "update", sourcePath: "/virtual/file", beforeExists: true, afterExists: true,
        beforeHash: "same", afterHash: "same", coverage: "partial",
      }] } };
      return { content: "ok", isError: kind === "failure" };
    }));
    const result = await f.runner.run({ message: "Process all records" });
    expect(writes).toBe(9);
    expect(result.text).toBe("Delivered");
    expect(result.meta.termination).toBeUndefined();
    expect(f.requests.some(repeatControl)).toBe(false);
  });

  it.each(["unknown", "productive", "version", "target", "wait"] as const)("%s interrupts the evidence streak after a reminder", async kind => {
    let executed = 0;
    const tool = work(async () => {
      executed++;
      if (executed === 4) {
        if (kind === "unknown" || kind === "wait") return { content: "pending" };
        if (kind === "productive") return { content: "ok", observations: { stateMutation: {
          scope: "fixture-store", version: "v2", changed: true,
        } } };
      }
      const result = unchanged();
      if (kind === "version" && executed >= 4) result.observations!.stateMutation!.version = "v2";
      return result;
    });
    if (kind === "wait") tool.inspectReadContinuation = () => ({ version: "tail", waiting: executed === 3 });
    const rounds = Array.from({ length: 7 }, (_, i) => [{ ...call(),
      ...(kind === "target" && i >= 3 ? { input: { target: "other" } } : {}),
    }]);
    const f = fixture(rounds, tool);
    const result = await f.runner.run({ message: "Continue while useful work remains" });
    expect(executed).toBe(7);
    expect(result.text).toBe("Delivered");
    expect(result.meta.termination).toBeUndefined();
  });

  it("an unknown sibling prevents a batch from proving a stall", async () => {
    const f = fixture(Array.from({ length: 8 }, () => [call(), { name: "work", input: { inspect: true } }]),
      work(async input => input.inspect ? { content: "additional diagnostics" } : unchanged(), "parallel"));
    expect((await f.runner.run({ message: "Investigate and save" })).text).toBe("Delivered");
    expect(f.requests.some(repeatControl)).toBe(false);
  });
});
