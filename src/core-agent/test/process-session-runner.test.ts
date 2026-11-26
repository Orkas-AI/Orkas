import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AgentRunner } from "../src/agent/runner.js";
import { createConfig } from "../src/config/loader.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CompletionResult } from "../src/providers/base.js";
import type { StreamEvent } from "../src/shared/types.js";
import { bashTool } from "../src/tools/builtin.js";
import { _resetProcessSessionsForTest, processSessionTool } from "../src/tools/process-session.js";

async function* streamCompletionResult(result: CompletionResult): AsyncIterable<StreamEvent> {
  yield { type: "message_start" };
  yield { type: "message_end", ...result };
}

it("does not request a model decision for ordinary logs during one explicit completion wait", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-wait-runner-"));
  const quote = (s: string) => "'" + s.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
  const script = "require('fs').appendFileSync('starts','1');console.log('ready');"
    + "process.stdin.on('data',d=>{if(d.toString().includes('finish'))process.exit(0);else console.log('progress')})";
  const command = `${process.platform === "win32" ? "& " : ""}${quote(process.env.ORKAS_TEST_NODE || process.execPath)} -e ${quote(script)}`;
  let sessionId = "";
  let requests = 0;
  let enterWait!: () => void;
  const waiting = new Promise<void>(resolve => { enterWait = resolve; });
  const providers = new ProviderRegistry();
  providers.registerFactory("mock", () => ({
    id: "mock", name: "Mock",
    async complete() { throw new Error("unexpected auxiliary inference"); },
    async *stream() {
      requests++;
      const content = requests === 1
        ? [{ type: "tool_use" as const, id: "start", name: "bash", input: { command, yield_time_ms: 0 } }]
        : requests === 2
          ? [{ type: "tool_use" as const, id: "wait", name: "process_session",
            input: { action: "read", session_id: sessionId, wait_for: "exit", yield_time_ms: 600000 } }]
          : [{ type: "text" as const, text: "Verification completed." }];
      yield* streamCompletionResult({ content, model: "mock-model", stopReason: requests < 3 ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    },
    async validateAuth() { return true; },
  }));
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }), providers,
    evolution: { enabled: false }, tools: [
      { ...bashTool, async execute(input, ctx) {
        const result = await bashTool.execute(input, ctx);
        sessionId = JSON.parse(result.content).session_id;
        return result;
      } },
      { ...processSessionTool, async execute(input, ctx) {
        const pending = processSessionTool.execute(input, ctx);
        enterWait();
        return pending;
      } },
    ],
  });
  const controller = new AbortController();
  const context = { workingDir: root, state: {} };
  const task = runner.run({ message: "Run verification and report its final result.", workingDir: root, signal: controller.signal });
  try {
    await waiting;
    await processSessionTool.execute({ action: "write", session_id: sessionId, chars: "more\n" }, context);
    await expect.poll(async () => {
      const read = await processSessionTool.execute({ action: "read", session_id: sessionId, yield_time_ms: 0 }, context);
      return JSON.parse(read.content).output;
    }).toContain("progress");
    expect(requests).toBe(2);
    await processSessionTool.execute({ action: "write", session_id: sessionId, chars: "finish\n" }, context);
    const result = await task;
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.termination).toBeUndefined();
    expect(result.text).toBe("Verification completed.");
    expect(requests).toBe(3);
    expect(await fs.readFile(path.join(root, "starts"), "utf8")).toBe("1");
  } finally {
    controller.abort();
    await task.catch(() => undefined);
    await _resetProcessSessionsForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("compares progress and completion waits on the same noisy command without real inference", async () => {
  const measurements = [];
  for (const mode of ["output", "exit"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-wait-comparison-"));
    const quote = (s: string) => "'" + s.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
    const script = "require('fs').appendFileSync('starts','1');let n=0;"
      + "const timer=setInterval(()=>{console.log(++n);if(n===20){clearInterval(timer);process.exit(0)}},50)";
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.env.ORKAS_TEST_NODE || process.execPath)} -e ${quote(script)}`;
    let requests = 0, sessionId = "", cursor = 0, terminal = false;
    const providers = new ProviderRegistry();
    providers.registerFactory("mock", () => ({
      id: "mock", name: "Mock", async complete() { throw new Error("unexpected auxiliary inference"); },
      async *stream() {
        requests++;
        const content = terminal ? [{ type: "text" as const, text: "Completed." }]
          : !sessionId ? [{ type: "tool_use" as const, id: `start-${requests}`, name: "bash", input: { command, yield_time_ms: 0 } }]
            : [{ type: "tool_use" as const, id: `read-${requests}`, name: "process_session",
              input: { action: "read", session_id: sessionId, cursor, wait_for: mode, yield_time_ms: 30000 } }];
        yield* streamCompletionResult({ content, model: "mock-model", stopReason: terminal ? "end_turn" : "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      }, async validateAuth() { return true; },
    }));
    const observe = (result: { content: string }) => {
      const payload = JSON.parse(result.content);
      sessionId = payload.session_id; cursor = payload.next_cursor; terminal = payload.status !== "running";
    };
    const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model", maxToolLoops: 100 } }),
      providers, evolution: { enabled: false }, tools: [
        { ...bashTool, async execute(input, ctx) { const result = await bashTool.execute(input, ctx); observe(result); return result; } },
        { ...processSessionTool, async execute(input, ctx) { const result = await processSessionTool.execute(input, ctx); observe(result); return result; } },
      ] });
    const startedAt = performance.now(), cpu = process.cpuUsage();
    const controller = new AbortController();
    try {
      const result = await runner.run({ message: "Run verification and await completion.", workingDir: root, signal: controller.signal });
      expect(result.meta.error).toBeUndefined(); expect(result.meta.termination).toBeUndefined();
      expect(terminal).toBe(true);
      expect(await fs.readFile(path.join(root, "starts"), "utf8")).toBe("1");
      if (mode === "exit") expect(requests).toBe(3);
      const used = process.cpuUsage(cpu);
      measurements.push({ mode, modelRequests: requests, elapsedMs: performance.now() - startedAt,
        processCpuMs: (used.user + used.system) / 1000, processRssBytes: process.memoryUsage().rss });
    } finally { controller.abort(); await _resetProcessSessionsForTest(); await fs.rm(root, { recursive: true, force: true }); }
  }
  if (process.env.ORKAS_WAIT_MEASUREMENT) await fs.writeFile(process.env.ORKAS_WAIT_MEASUREMENT, JSON.stringify({
    boundary: "AgentRunner with synthetic provider; 20 output chunks over one second; parent-process CPU/RSS, not isolated feature memory or billing",
    measurements,
  }));
});
