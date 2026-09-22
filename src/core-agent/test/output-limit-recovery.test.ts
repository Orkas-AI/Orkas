import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../src/agent/runner.js";
import { Session } from "../src/agent/session.js";
import { PersistentSession } from "../src/agent/persistent-session.js";
import { createConfig } from "../src/config/loader.js";
import { buildPiContextForTest } from "../src/providers/pi-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { defineTool, type AgentTool } from "../src/tools/base.js";
import type { CompletionParams, CompletionResult, LLMProvider } from "../src/providers/base.js";
import type { MessageContent } from "../src/shared/types.js";
import type { AgentRunEvent } from "../src/agent/types.js";

const text = (value: string): MessageContent => ({ type: "text", text: value });
const thinking: MessageContent = { type: "thinking", thinking: "Work remains.", thinkingSignature: "reasoning_content" };
const call = (id: string, name = "write_file", input = {}): MessageContent => ({ type: "tool_use", id, name, input });
const response = (content: MessageContent[], stopReason: CompletionResult["stopReason"] = "max_tokens"): CompletionResult => ({
  content, stopReason, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, model: "mock-model",
});

function setup(responses: CompletionResult[], tools: AgentTool[] = [], opts: {
  session?: Session;
  onRequest?: (params: CompletionParams, index: number) => void;
  isToolActive?: (name: string) => boolean;
} = {}) {
  const requests: CompletionParams[] = [];
  const provider: LLMProvider = {
    id: "mock", name: "Mock",
    async complete() { throw new Error("Unexpected auxiliary inference"); },
    async *stream(params) {
      const index = requests.length;
      requests.push(structuredClone({ ...params, signal: undefined }));
      opts.onRequest?.(params, index);
      const result = responses[index];
      if (!result) throw new Error("Unexpected extra inference");
      for (const item of result.content) {
        if (item.type === "text") yield { type: "text_delta" as const, text: item.text };
        if (item.type === "tool_use") {
          yield { type: "tool_use_start" as const, id: item.id, name: item.name };
          yield { type: "tool_use_end" as const, id: item.id };
        }
      }
      yield { type: "message_end" as const, ...result };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory("mock", () => provider);
  const session = opts.session ?? new Session();
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: "mock", defaultModel: "mock-model" } }),
    providers, session, tools, evolution: { enabled: false }, isToolActive: opts.isToolActive,
  });
  return { runner, requests, session };
}
const tool = (name: string, execute: AgentTool["execute"]) => defineTool({
  name, description: "Isolated recovery fixture", inputSchema: { type: "object" }, execute,
});

// Outcomes come from the requested file, operation receipts and persisted state,
// not a synthetic model claiming the work succeeded.
describe("output limit task recovery", () => {
  it.each([
    ["thinking", [thinking]],
    ["preamble", [text("I will build the requested page.")]],
    ["mixed text and thinking", [thinking, text("The inputs are ready.")]],
    ["empty output", []],
  ] as [string, MessageContent[]][])("continues %s into file execution without replaying completed work", async (_kind, partial) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-recovery-"));
    const file = path.join(root, "page.html");
    const transcript = path.join(root, "session.jsonl");
    let reads = 0;
    let writes = 0;
    const { runner, requests } = setup([
      response([call("read", "read_files")], "tool_use"),
      response(partial),
      response([call("write")], "tool_use"),
      response([text("Page created.")], "end_turn"),
    ], [
      tool("read_files", async () => { reads++; return { content: "requirement-receipt: offline page" }; }),
      tool("write_file", async () => { writes++; fs.writeFileSync(file, "<!doctype html><title>Workbench</title>"); return { content: "write-receipt" }; }),
    ], { session: new PersistentSession({ sessionFile: transcript }) });
    try {
      const events: AgentRunEvent[] = [];
      for await (const event of runner.runStream({ message: "Build the offline workbench page.", thinkingLevel: "high" })) events.push(event);
      expect(fs.readFileSync(file, "utf8")).toBe("<!doctype html><title>Workbench</title>");
      expect([reads, writes]).toEqual([1, 1]);
      expect(requests).toHaveLength(4);
      expect(requests[2].tools?.some(t => t.name === "write_file")).toBe(true);
      expect(requests[2].reasoning).toBe("high");
      expect(JSON.stringify(requests[2].messages)).toContain("requirement-receipt");
      expect(requests[2].messages.at(-1)?.role).toBe("developer");
      expect(requests[2].systemPrompt).toBe(requests[0].systemPrompt);
      expect(requests[2].providerTurnContext).toEqual(requests[0].providerTurnContext);
      const done = events.filter(e => e.type === "done");
      expect(done).toHaveLength(1);
      expect(done[0].result.meta.error).toBeUndefined();
      expect(done[0].result.meta.usage.totalTokens).toBe(48);
      const restored = new PersistentSession({ sessionFile: transcript });
      const saved = JSON.stringify(restored.getMessages());
      expect(saved).toContain("write-receipt");
      expect(saved).not.toContain("Internal execution control");
      expect(restored.getMessages().flatMap(m => m.content).filter(c => c.type === "tool_use")).toHaveLength(2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("discards every unexecuted call in a truncated batch, including complete-looking siblings", async () => {
    const executed: string[] = [];
    const { runner, requests, session } = setup([
      response([thinking, text("Preparing changes."), call("discard-one", "write_file", { value: "discard" }), call("discard-two")]),
      response([call("accepted", "write_file", { value: "accepted" })], "tool_use"),
      response([text("Done.")], "end_turn"),
    ], [tool("write_file", async input => { executed.push(String(input.value)); return { content: "saved" }; })]);
    expect((await runner.run({ message: "Write the requested file." })).meta.error).toBeUndefined();
    expect(executed).toEqual(["accepted"]);
    expect(JSON.stringify(requests[1].messages)).not.toContain("discard-one");
    expect(JSON.stringify(requests[1].messages)).not.toContain("reasoning_content");
    expect(JSON.stringify(session.getMessages())).not.toContain("discard-two");
  });

  it("shares three recovery attempts across thinking, text and incomplete tool transitions", async () => {
    let writes = 0;
    const { runner, requests, session } = setup([
      response([thinking]), response([text("Preserved findings.")]),
      response([call("discard")]), response([thinking]),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })]);
    const result = await runner.run({ message: "Complete the work." });
    expect(requests).toHaveLength(4);
    expect(writes).toBe(0);
    expect(result.meta.error?.code).toBe("OUTPUT_LIMIT");
    expect(result.text).toBe("Preserved findings.");
    expect(JSON.stringify(session.getMessages())).toContain("Preserved findings.");
    expect(JSON.stringify(session.getMessages())).not.toContain("discard");
    expect(session.getSerializedContextState()?.activeTurn).toBeDefined();
  });

  it("renews the bounded allowance only after a normal response returns to tool execution", async () => {
    let writes = 0;
    const { runner, requests } = setup([
      response([thinking]), response([thinking]), response([thinking]),
      response([call("write")], "tool_use"),
      response([text("A. ")]), response([text("B. ")]), response([text("C. ")]),
      response([text("D.")], "end_turn"),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })]);
    const result = await runner.run({ message: "Write the file and explain it." });
    expect(requests).toHaveLength(8);
    expect(writes).toBe(1);
    expect(result.text).toBe("A. B. C. D.");
    expect(result.meta.error).toBeUndefined();
  });

  it("does not execute a recovery proposal or request again after user cancellation", async () => {
    const abort = new AbortController();
    let writes = 0;
    const { runner, requests } = setup([
      response([thinking]), response([call("write")], "tool_use"),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })], {
      onRequest: (_params, index) => { if (index === 1) abort.abort(); },
    });
    const result = await runner.run({ message: "Write the file.", signal: abort.signal });
    expect(result.meta.aborted).toBe(true);
    expect(writes).toBe(0);
    expect(requests).toHaveLength(2);
  });

  it("skips the recovered write when a newer user instruction arrives", async () => {
    let writes = 0;
    let pending = false;
    const { runner, requests } = setup([
      response([thinking]), response([call("write")], "tool_use"), response([text("No changes made.")], "end_turn"),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })], {
      onRequest: (_params, index) => { if (index === 1) pending = true; },
    });
    const result = await runner.run({ message: "Write the file.", drainSteer: () => {
      if (!pending) return [];
      pending = false;
      return ["Leave the file unchanged."];
    } });
    expect(writes).toBe(0);
    expect(result.text).toBe("No changes made.");
    expect(JSON.stringify(requests[2].messages)).toContain("Leave the file unchanged.");
    expect(JSON.stringify(requests[2].messages)).toContain("skipped");
  });

  it("never reopens tools while explaining an authoritative user-input boundary", async () => {
    let writes = 0;
    const { runner, requests } = setup([
      response([call("preview", "preview")], "tool_use"),
      response([text("Choose the next step. ")]),
      response([call("forbidden")], "tool_use"),
    ], [
      tool("preview", async () => ({ content: "waiting for input", synthesizeAndEndTurn: true })),
      tool("write_file", async () => { writes++; return { content: "saved" }; }),
    ]);
    await runner.run({ message: "Prepare a preview." });
    expect(requests).toHaveLength(3);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[2].tools).toBeUndefined();
    expect(writes).toBe(0);
  });

  it("retains the inactive-tool gate on a recovered proposal", async () => {
    let writes = 0;
    const { runner, requests } = setup([
      response([thinking]), response([call("inactive")], "tool_use"),
      response([text("The operation is unavailable.")], "end_turn"),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })], { isToolActive: () => false });
    const result = await runner.run({ message: "Write the file." });
    expect(writes).toBe(0);
    expect(requests[1].tools).toBeUndefined();
    expect(JSON.stringify(requests[2].messages)).toContain("E_TOOL_UNAVAILABLE");
    expect(result.text).toBe("The operation is unavailable.");
  });

  it("preserves partial text and prior receipts on disk for explicit resume after exhaustion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-resume-"));
    const file = path.join(root, "session.jsonl");
    let writes = 0;
    try {
      const session = new PersistentSession({ sessionFile: file });
      const { runner } = setup([
        response([call("write")], "tool_use"), ...Array.from({ length: 4 }, () => response([text("Preserved explanation.")])),
      ], [tool("write_file", async () => { writes++; return { content: "original-write-receipt" }; })], { session });
      expect((await runner.run({ message: "Write and explain." })).meta.error?.code).toBe("OUTPUT_LIMIT");
      const restored = new PersistentSession({ sessionFile: file });
      const resumed = setup([response([text("Explanation finished.")], "end_turn")], [], { session: restored });
      const result = await resumed.runner.run({ message: "Write and explain.", resumeActiveTurn: true });
      expect(result.meta.error).toBeUndefined();
      expect(writes).toBe(1);
      const messages = JSON.stringify(resumed.requests[0].messages);
      expect(messages).toContain("original-write-receipt");
      expect(messages).toContain("Preserved explanation.");
      expect(restored.getMessages().filter(m => m.role === "user" && m.content.some(c => c.type === "text" && c.text === "Write and explain."))).toHaveLength(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["text signature", "native replay"])("preserves %s message boundaries through recovery and later tool use", async (kind) => {
    const signedText = (value: string, id: string): MessageContent => ({
      type: "text", text: value,
      ...(kind === "text signature"
        ? { textSignature: JSON.stringify({ id, phase: "commentary" }) }
        : { googleNativeReplay: { api: "google-generative-ai" as const, provider: "google", model: "mock-model", partsJson: JSON.stringify([{ text: value }]) } }),
    });
    const first = signedText("First part. ", "m1");
    const second = signedText("Second part. ", "m2");
    let writes = 0;
    const { runner, requests, session } = setup([
      response([first]), response([second]), response([call("write")], "tool_use"),
      response([text("Done.")], "end_turn"),
    ], [tool("write_file", async () => { writes++; return { content: "saved" }; })]);
    expect((await runner.run({ message: "Create the file." })).meta.error).toBeUndefined();
    expect(writes).toBe(1);
    for (const messages of [requests[2].messages, requests[3].messages, session.getMessages()]) {
      const assistants = messages.filter(m => m.role === "assistant");
      expect(assistants[0].content).toEqual([first]);
      expect(assistants[1].content).toEqual([second]);
      const projected = buildPiContextForTest(messages, undefined, undefined,
        { api: "google-generative-ai", provider: "google", id: "mock-model" });
      const replayed = projected.messages.filter(m => m.role === "assistant");
      if (kind === "native replay") {
        expect(replayed[0]).toHaveProperty("googleNativeReplay", first.googleNativeReplay);
        expect(replayed[1]).toHaveProperty("googleNativeReplay", second.googleNativeReplay);
      } else {
        expect(replayed[0].content[0]).toHaveProperty("textSignature", first.type === "text" ? first.textSignature : undefined);
      }
    }
  });

  it("returns one combined answer without rewriting signed text in persisted history", async () => {
    const first: MessageContent = { type: "text", text: "First. ", textSignature: '{"id":"m1"}' };
    const second: MessageContent = { type: "text", text: "Second.", textSignature: '{"id":"m2"}' };
    const { runner, session } = setup([response([first]), response([second], "end_turn")]);
    expect((await runner.run({ message: "Explain." })).text).toBe("First. Second.");
    expect(session.getMessages().filter(m => m.role === "assistant").map(m => m.content)).toEqual([[first], [second]]);
  });

  it("reports incomplete and preserves text when recovery ends with empty output", async () => {
    const { runner, session, requests } = setup([response([text("Partial report.")]), response([], "end_turn")]);
    const result = await runner.run({ message: "Write the report." });
    expect(requests).toHaveLength(2);
    expect(result.meta.error?.code).toBe("OUTPUT_LIMIT");
    expect(result.text).toBe("Partial report.");
    expect(JSON.stringify(session.getMessages())).toContain("Partial report.");
  });

  it("lets cancellation win over recovery exhaustion on the last response", async () => {
    const abort = new AbortController();
    const { runner, requests } = setup(Array.from({ length: 4 }, () => response([thinking])), [], {
      onRequest: (_params, index) => { if (index === 3) abort.abort(); },
    });
    const result = await runner.run({ message: "Complete the task.", signal: abort.signal });
    expect(requests).toHaveLength(4);
    expect(result.meta.aborted).toBe(true);
    expect(result.meta.error?.code).toBe("ABORT_ERR");
  });

});
