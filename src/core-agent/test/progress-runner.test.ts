import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CompletionParams, LLMProvider } from "../src/providers/base.js";
import { defineTool, type AgentTool, type ToolResult } from "../src/tools/base.js";

type Call = { name: string; input?: Record<string, unknown> };
function setup(rounds: Call[][], tools: AgentTool[]) {
  const requests: CompletionParams[] = [];
  let index = 0;
  const provider: LLMProvider = {
    id: "progress-test", name: "Progress test",
    async complete() { throw new Error("Unexpected auxiliary model request"); },
    async *stream(params) {
      requests.push(structuredClone(params));
      const round = index++;
      const calls = rounds[round];
      yield { type: "message_start" };
      yield { type: "message_end", model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: calls ? "tool_use" : "end_turn",
        content: calls ? calls.map((call, i) => ({
          type: "tool_use" as const, id: `${round}-${i}`, name: call.name,
          input: { step: round, ...call.input },
        })) : [{ type: "text", text: "Task delivered" }],
      };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory("progress-test", () => provider);
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: "progress-test", defaultModel: "test-model", maxToolLoops: 40 } }),
    providers, tools, evolution: { enabled: false },
  });
  return { runner, requests };
}
const unchanged: ToolResult = { content: "unchanged", observations: { fileChanges: [{
  operation: "update", sourcePath: "/virtual/result", beforeExists: true, afterExists: true,
  beforeHash: "same", afterHash: "same", coverage: "exact",
}] } };
const changed: ToolResult = { content: "changed", observations: { fileChanges: [{
  operation: "update", sourcePath: "/virtual/result", beforeExists: true, afterExists: true,
  beforeHash: "old", afterHash: "new", coverage: "exact",
}] } };
const discovered: ToolResult = { content: "new source", observations: { fileReads: [{
  path: "/virtual/source", hash: "version", charRange: [0, 10],
}] } };
function controls(request: CompletionParams): string {
  return JSON.stringify(request.messages.filter(message => message.role === "developer"));
}

describe("evidence-based progress through the real runner", () => {
  it("a user steer before execution resets the window without executing stale work", async () => {
    let executed = 0;
    const tool = defineTool({ name: "noop", description: "No-op", inputSchema: { type: "object" },
      async execute() { executed++; return unchanged; },
    });
    const { runner, requests } = setup(Array.from({ length: 4 }, () => [{ name: "noop" }]), [tool]);
    let steered = false;
    const result = await runner.run({ message: "Work on the original request", requestMetadata: { routeContext: {} },
      drainSteer: async () => {
        if (requests.length !== 2 || steered) return [];
        steered = true;
        return [{ id: "new-direction", content: [{ type: "text", text: "Use the new requirement instead." }] }];
      },
    });
    expect(executed).toBe(3);
    expect(result.text).toBe("Task delivered");
    expect(requests.map(request => (request.requestMetadata?.routeContext as Record<string, unknown>).noProgressRounds))
      .toEqual([0, 1, 0, 1, 2]);
  });

  it("an unavailable sibling is unknown even across a sequential barrier", async () => {
    const tool = defineTool({ name: "noop", description: "No-op", inputSchema: { type: "object" },
      async execute() { return unchanged; },
    });
    const { runner, requests } = setup([
      [{ name: "noop" }], [{ name: "noop" }, { name: "unavailable" }], [{ name: "noop" }],
    ], [tool]);
    const result = await runner.run({ message: "Complete the task", requestMetadata: { routeContext: {} } });
    expect(result.text).toBe("Task delivered");
    expect(requests.map(request => (request.requestMetadata?.routeContext as Record<string, unknown>).noProgressRounds))
      .toEqual([0, 1, 1, 2]);
    expect(controls(requests[2])).not.toContain("Since the last observed progress");
    expect(controls(requests[3])).toContain("Since the last observed progress");
  });

  it.each(["parallel", "sequential"] as const)("%s results preserve skip, reset and one-per-episode delivery", async (executionMode) => {
    const tools = [
      ["noop", unchanged], ["opaque", { content: "activity without verified state" }],
      ["read_files", discovered], ["write", changed],
    ].map(([name, result]) => defineTool({ name: name as string, description: "Fixture operation",
      inputSchema: { type: "object" }, executionMode,
      async execute() { return result as ToolResult; },
    }));
    tools.push(defineTool({ name: "wait", description: "Bounded live wait", inputSchema: { type: "object" },
      inspectReadContinuation: () => ({ version: "live-tail", waiting: true }),
      async execute() { return { content: "running" }; },
    }));
    const rounds = [
      ["noop"], ["opaque"], ["wait"], ["noop", "opaque"], ["noop", "read_files"],
      ["noop", "noop"], ["noop", "write"], ["noop"], ["noop"], ["noop"],
    ].map(names => names.map((name, i) => ({ name, input: { sibling: i } })));
    const { runner, requests } = setup(rounds, tools);
    const result = await runner.run({ message: "Complete the task", requestMetadata: { routeContext: {} } });
    expect(result.text).toBe("Task delivered");
    expect(result.meta.termination).toBeUndefined();
    expect(requests).toHaveLength(rounds.length + 1);
    expect(requests.map(request => (request.requestMetadata?.routeContext as Record<string, unknown>).noProgressRounds))
      .toEqual([0, 1, 1, 1, 1, 0, 1, 0, 1, 2, 3]);
    expect(requests.filter(request => controls(request).includes("Since the last observed progress"))).toHaveLength(1);
    expect(controls(requests[9])).toContain("this reminder does not require ending the task");
    expect(JSON.stringify(runner.getSession().getMessages())).not.toContain("Since the last observed progress");
  });

  it.each(["none", "productive", "unknown", "discovery", "waiting"] as const)(
    "elapsed time does not diagnose stalling: %s", async (kind) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const name = kind === "discovery" ? "read_files" : "step";
        const step = defineTool({ name, description: "Long task step", inputSchema: { type: "object" },
          ...(kind === "waiting" ? { inspectReadContinuation: () => ({ version: "live", waiting: true }) } : {}),
          async execute(input) {
            now += 90_000;
            if (kind === "none") return unchanged;
            if (kind === "productive") return changed;
            if (kind === "discovery") return { content: "new source", observations: { fileReads: [{
              path: `/virtual/source-${input.step}`, hash: "version", charRange: [0, 10] as [number, number],
            }] } };
            return { content: "running" };
          },
        });
        const { runner, requests } = setup(Array.from({ length: 9 }, () => [{ name }]), [step]);
        const result = await runner.run({ message: "Complete the long task" });
        expect(result.text).toBe("Task delivered");
        expect(result.meta.termination).toBeUndefined();
        expect(result.meta.toolLoops).toBe(9);
        const reminders = requests.filter(request => controls(request).includes("This turn has run for about"));
        expect(reminders).toHaveLength(kind === "none" ? 1 : 0);
        expect(JSON.stringify(runner.getSession().getMessages())).not.toContain("This turn has run for about");
      } finally { clock.mockRestore(); }
    },
  );

  it("fresh diagnostics are delivered without equating a failure with stagnation", async () => {
    const diagnose = defineTool({ name: "diagnose", description: "Inspect a failing test", inputSchema: { type: "object" },
      async execute(input) { return { content: `Diagnostic for case ${input.step}`, isError: true }; },
    });
    const { runner, requests } = setup([[{ name: "diagnose" }], [{ name: "diagnose" }]], [diagnose]);
    const result = await runner.run({ message: "Investigate the failures" });
    expect(result.text).toBe("Task delivered");
    expect(result.meta.convergenceSignals ?? []).not.toContain("no_progress_nudge");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Diagnostic for case 0");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Diagnostic for case 1");
  });
});
