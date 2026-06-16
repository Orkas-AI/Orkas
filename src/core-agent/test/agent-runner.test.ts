import { describe, it, expect, vi } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { defineTool } from "../src/tools/base.js";
import type { LLMProvider, CompletionParams, CompletionResult } from "../src/providers/base.js";
import type { Message } from "../src/shared/types.js";

/** Create a mock LLM provider that returns predefined responses. */
function createMockProvider(responses: CompletionResult[]): LLMProvider {
  let callIdx = 0;
  const pick = () =>
    callIdx >= responses.length ? responses[responses.length - 1] : responses[callIdx++];
  return {
    id: "mock",
    name: "Mock Provider",
    async complete(_params: CompletionParams): Promise<CompletionResult> {
      return pick();
    },
    async *stream() {
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
}

describe("AgentRunner", () => {
  it("runs a simple text-only conversation", async () => {
    const mockProvider = createMockProvider([
      {
        content: [{ type: "text", text: "Hello! How can I help?" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    const result = await runner.run({ message: "Hi" });

    expect(result.text).toBe("Hello! How can I help?");
    expect(result.meta.model).toBe("mock-model");
    expect(result.meta.provider).toBe("mock");
    expect(result.meta.stopReason).toBe("end_turn");
    expect(result.meta.usage.inputTokens).toBe(10);
    expect(result.meta.usage.outputTokens).toBe(8);
    expect(result.meta.toolLoops).toBe(0);
  });

  it("executes a tool-use loop", async () => {
    const mockProvider = createMockProvider([
      // First response: tool call
      {
        content: [
          { type: "text", text: "Let me calculate that." },
          {
            type: "tool_use",
            id: "call_1",
            name: "add",
            input: { a: 2, b: 3 },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        model: "mock-model",
      },
      // Second response: final answer after tool result
      {
        content: [{ type: "text", text: "The result is 5." }],
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const addTool = defineTool({
      name: "add",
      description: "Add two numbers",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      async execute(input) {
        return { content: String((input.a as number) + (input.b as number)) };
      },
    });

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [addTool] });
    const result = await runner.run({ message: "What is 2 + 3?" });

    expect(result.text).toBe("The result is 5.");
    expect(result.meta.toolLoops).toBe(1);
  });

  it("handles unknown tool gracefully", async () => {
    const mockProvider = createMockProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "nonexistent_tool",
            input: {},
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "Sorry, that tool is not available." }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    const result = await runner.run({ message: "Do something" });

    // Should not crash, just provide an error tool result and continue
    expect(result.text).toBe("Sorry, that tool is not available.");
  });

  it("handles tool execution errors", async () => {
    const mockProvider = createMockProvider([
      {
        content: [
          { type: "tool_use", id: "call_1", name: "failing_tool", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "The tool failed, but I handled it." }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const failingTool = defineTool({
      name: "failing_tool",
      description: "A tool that always fails",
      inputSchema: { type: "object" },
      async execute() {
        throw new Error("Intentional failure");
      },
    });

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [failingTool] });
    const result = await runner.run({ message: "Run the failing tool" });

    expect(result.text).toBe("The tool failed, but I handled it.");
  });

  it("returns error when no provider is found", async () => {
    const config = createConfig({
      agent: { defaultProvider: "nonexistent", defaultModel: "nonexistent-model" },
    });

    // Empty registry with no factories
    const registry = new ProviderRegistry();

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    const result = await runner.run({ message: "Hi" });

    expect(result.meta.error).toBeDefined();
    expect(result.meta.error?.kind).toBe("auth");
  });

  it("maintains session across multiple runs", async () => {
    let callCount = 0;
    const mockProvider: LLMProvider = {
      id: "mock",
      name: "Mock",
      async complete(params) {
        callCount++;
        const msgCount = params.messages.length;
        return {
          content: [{ type: "text", text: `Response ${callCount} (saw ${msgCount} messages)` }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          model: "mock-model",
        };
      },
      async *stream(params) {
        callCount++;
        const msgCount = params.messages.length;
        const text = `Response ${callCount} (saw ${msgCount} messages)`;
        yield { type: "message_start" as const };
        yield { type: "text_delta" as const, text };
        yield {
          type: "message_end" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          content: [{ type: "text" as const, text }],
          model: "mock-model",
        };
      },
      async validateAuth() { return true; },
    };

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });

    const result1 = await runner.run({ message: "First message" });
    expect(result1.text).toContain("Response 1");

    const result2 = await runner.run({ message: "Second message" });
    expect(result2.text).toContain("Response 2");
    // Second call should see previous messages in session
    expect(result2.text).toContain("saw 3"); // user1, assistant1, user2
  });

  it("streams events via runStream", async () => {
    const mockProvider = createMockProvider([
      {
        content: [{ type: "text", text: "Streamed response" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    const events = [];

    for await (const event of runner.runStream({ message: "Stream me" })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("runStream emits text_delta before done on plain text turn", async () => {
    const mockProvider = createMockProvider([
      {
        content: [{ type: "text", text: "hello world" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [] });
    const events: Array<{ type: string }> = [];
    for await (const ev of runner.runStream({ message: "hi" })) {
      events.push(ev as { type: string });
    }

    // Expect at least: text_delta, done
    expect(events.map((e) => e.type)).toContain("text_delta");
    expect(events[events.length - 1].type).toBe("done");
    const textDelta = events.find((e) => e.type === "text_delta") as { text: string } | undefined;
    expect(textDelta?.text).toBe("hello world");
  });

  it("runStream emits tool_start/tool_end around tool execution", async () => {
    const mockProvider = createMockProvider([
      {
        content: [
          { type: "tool_use", id: "call_1", name: "echo", input: { msg: "ping" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "done." }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    const echoTool = defineTool({
      name: "echo",
      description: "Echo input.msg",
      inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      async execute(input) {
        return { content: String(input.msg) };
      },
    });

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [echoTool] });
    const collected: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of runner.runStream({ message: "go" })) {
      collected.push(ev as { type: string; [k: string]: unknown });
    }
    const types = collected.map((e) => e.type);

    // Expect tool_start BEFORE tool_end, and BOTH before the terminal done.
    const iStart = types.indexOf("tool_start");
    const iEnd = types.indexOf("tool_end");
    const iDone = types.indexOf("done");
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iEnd).toBeGreaterThan(iStart);
    expect(iDone).toBeGreaterThan(iEnd);

    // tool_start must carry the tool's input so downstream UIs can render
    // the actual command / path / args, not just the tool name.
    const startEv = collected[iStart] as { name: string; id: string; input: unknown };
    expect(startEv.name).toBe("echo");
    expect(startEv.id).toBe("call_1");
    expect(startEv.input).toEqual({ msg: "ping" });
  });

  it("runStream forwards tool_progress while a tool is still executing", async () => {
    const mockProvider = createMockProvider([
      {
        content: [
          { type: "tool_use", id: "call_1", name: "slow_tool", input: { msg: "ping" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "done." }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);
    const slowTool = defineTool({
      name: "slow_tool",
      description: "Emits progress before returning",
      inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      async execute(_input, ctx) {
        ctx.emitProgress?.({ phase: "upload", message: "Uploading reference" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        ctx.emitProgress?.({ phase: "poll", message: "Waiting for task" });
        return { content: "ok" };
      },
    });
    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [slowTool] });
    const collected: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of runner.runStream({ message: "go" })) {
      collected.push(ev as { type: string; [k: string]: unknown });
    }

    const iStart = collected.findIndex((e) => e.type === "tool_start");
    const progress = collected.filter((e) => e.type === "tool_progress");
    const iFirstProgress = collected.findIndex((e) => e.type === "tool_progress");
    const iEnd = collected.findIndex((e) => e.type === "tool_end");
    expect(progress.map((e) => e.message)).toEqual(["Uploading reference", "Waiting for task"]);
    expect(progress.map((e) => e.name)).toEqual(["slow_tool", "slow_tool"]);
    expect(progress.map((e) => e.id)).toEqual(["call_1", "call_1"]);
    expect(iFirstProgress).toBeGreaterThan(iStart);
    expect(iEnd).toBeGreaterThan(iFirstProgress);
  });

  it("runStream forwards tool input deltas before tool execution", async () => {
    const mockProvider = createMockProvider([
      {
        content: [
          { type: "tool_use", id: "call_1", name: "echo", input: { msg: "x".repeat(1200) } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "done." }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);
    const echoTool = defineTool({
      name: "echo",
      description: "Echo input.msg",
      inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      async execute(input) {
        return { content: String(input.msg).slice(0, 4) };
      },
    });
    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });

    const runner = new AgentRunner({ config, providers: registry, tools: [echoTool] });
    const collected: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of runner.runStream({ message: "go" })) {
      collected.push(ev as { type: string; [k: string]: unknown });
    }

    const iDelta = collected.findIndex((e) => e.type === "tool_delta" && e.name === "echo");
    const iInputDelta = collected.findIndex((e) => e.type === "tool_delta" && Number(e.inputBytes) > 0);
    const iStart = collected.findIndex((e) => e.type === "tool_start");
    expect(iDelta).toBeGreaterThanOrEqual(0);
    expect(iInputDelta).toBeGreaterThan(iDelta);
    expect(iStart).toBeGreaterThan(iDelta);
    expect(collected[iInputDelta].inputBytes).toBeGreaterThan(0);
  });

  it("run() and runStream() produce the same final result", async () => {
    const sharedResponses: CompletionResult[] = [
      {
        content: [{ type: "text", text: "the answer is 42" }],
        stopReason: "end_turn",
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        model: "mock-model",
      },
    ];

    function makeRunner() {
      const p = createMockProvider([...sharedResponses]);
      const registry = new ProviderRegistry();
      registry.registerFactory("mock", () => p);
      const config = createConfig({
        agent: { defaultProvider: "mock", defaultModel: "mock-model" },
      });
      return new AgentRunner({ config, providers: registry, tools: [] });
    }

    const r1 = await makeRunner().run({ message: "q" });

    let r2: typeof r1 | null = null;
    for await (const ev of makeRunner().runStream({ message: "q" })) {
      if (ev.type === "done") r2 = ev.result;
    }

    expect(r2).not.toBeNull();
    expect(r2!.text).toBe(r1.text);
    expect(r2!.meta.stopReason).toBe(r1.meta.stopReason);
    expect(r2!.meta.toolLoops).toBe(r1.meta.toolLoops);
  });

  it("forwards AgentRunParams.sandboxEnv into ToolContext.state.sandboxEnv", async () => {
    // This is the plumbing that lets `main/model/core-agent/client.ts`
    // inject ORKAS_NODE / ORKAS_PC_DIR / ELECTRON_RUN_AS_NODE per-call.
    // If this breaks, skill bash commands silently lose their env.
    const mockProvider = createMockProvider([
      {
        content: [{ type: "tool_use", id: "c1", name: "capture_env", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    let captured: unknown = undefined;
    const captureTool = defineTool({
      name: "capture_env",
      description: "capture sandboxEnv for assertion",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, ctx) {
        captured = ctx.state.sandboxEnv;
        return { content: "ok" };
      },
    });

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });
    const runner = new AgentRunner({ config, providers: registry, tools: [captureTool] });

    await runner.run({
      message: "capture it",
      sandboxEnv: { ORKAS_NODE: "/fake/electron", ELECTRON_RUN_AS_NODE: "1" },
    });

    expect(captured).toEqual({ ORKAS_NODE: "/fake/electron", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("omits sandboxEnv from state when not provided", async () => {
    // Preserves the pre-change default: state starts as {} if caller didn't opt in.
    const mockProvider = createMockProvider([
      {
        content: [{ type: "tool_use", id: "c1", name: "capture_env", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        model: "mock-model",
      },
    ]);

    const registry = new ProviderRegistry();
    registry.registerFactory("mock", () => mockProvider);

    let captured: unknown = "sentinel";
    const captureTool = defineTool({
      name: "capture_env",
      description: "capture sandboxEnv for assertion",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, ctx) {
        captured = ctx.state.sandboxEnv;
        return { content: "ok" };
      },
    });

    const config = createConfig({
      agent: { defaultProvider: "mock", defaultModel: "mock-model" },
    });
    const runner = new AgentRunner({ config, providers: registry, tools: [captureTool] });
    await runner.run({ message: "no env" });

    expect(captured).toBeUndefined();
  });
});
