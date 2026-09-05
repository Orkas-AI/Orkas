import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildPiContextForTest, createAnthropicProvider, createLeadingThinkTextFilterForTest, createOpenAIProvider, createPiProvider, effectiveMaxTokensFromPayloadForTest, listPiProviders, listPiModels, mapContentForTest, mapProviderContentForTest, normalizeReasoningForProvider, providerTerminationCategoryForTest, resolvedResponseModelForTest, restoreOfficialReasoningDefaultsForTest, serverFallbackReasonFromResponseIdForTest, stripLeadingThinkTextForTest } from "../src/providers/pi-provider.js";
import { createConfig } from "../src/config/loader.js";
import type { Message, MessageContent } from "../src/shared/types.js";
import type { Model } from "@earendil-works/pi-ai";

describe("Providers (pi-ai backed)", () => {
  describe("createAnthropicProvider", () => {
    it("creates a provider with correct id and name", () => {
      const provider = createAnthropicProvider({ apiKey: "test" });
      expect(provider.id).toBe("anthropic");
      expect(provider.name).toBe("Anthropic");
    });

    it("has complete, stream, and validateAuth methods", () => {
      const provider = createAnthropicProvider({ apiKey: "test" });
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.stream).toBe("function");
      expect(typeof provider.validateAuth).toBe("function");
    });
  });

  describe("createOpenAIProvider", () => {
    it("creates a provider with correct id and name", () => {
      const provider = createOpenAIProvider({ apiKey: "test" });
      expect(provider.id).toBe("openai");
      expect(provider.name).toBe("Openai");
    });

    it("has complete, stream, and validateAuth methods", () => {
      const provider = createOpenAIProvider({ apiKey: "test" });
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.stream).toBe("function");
      expect(typeof provider.validateAuth).toBe("function");
    });
  });

  describe("createPiProvider", () => {
    it("reads the effective max-token ceiling from provider wire payloads", () => {
      expect(effectiveMaxTokensFromPayloadForTest({ max_tokens: 8_192 })).toBe(8_192);
      expect(effectiveMaxTokensFromPayloadForTest({ max_completion_tokens: 16_384 })).toBe(16_384);
      expect(effectiveMaxTokensFromPayloadForTest({ max_output_tokens: 32_000 })).toBe(32_000);
      expect(effectiveMaxTokensFromPayloadForTest({ generationConfig: { maxOutputTokens: 4_096 } })).toBe(4_096);
      expect(effectiveMaxTokensFromPayloadForTest({ inferenceConfig: { maxTokens: 2_048 } })).toBe(2_048);
      expect(effectiveMaxTokensFromPayloadForTest({ options: { maxTokens: 1_024 } })).toBe(1_024);
      expect(effectiveMaxTokensFromPayloadForTest({ max_tokens: 8_192, max_completion_tokens: 4_096 })).toBe(4_096);
      expect(effectiveMaxTokensFromPayloadForTest({ model: "server-owned-limit" })).toBeUndefined();
      expect(effectiveMaxTokensFromPayloadForTest({ max_tokens: 0 })).toBeUndefined();
      expect(effectiveMaxTokensFromPayloadForTest({ max_tokens: -1 })).toBeUndefined();
      expect(effectiveMaxTokensFromPayloadForTest({ max_tokens: "invalid" })).toBeUndefined();
    });

    it("clamps unsupported compaction reasoning to the nearest provider level", () => {
      expect(normalizeReasoningForProvider("minimal", ["low", "medium", "high"])).toBe("low");
      expect(normalizeReasoningForProvider("high", ["low", "medium", "high"])).toBe("high");
    });

    it("creates a provider for any pi-ai supported provider", () => {
      const provider = createPiProvider({ provider: "anthropic", model: "claude-opus-4-8" });
      expect(provider.id).toBe("anthropic");
    });

    it("creates google provider", () => {
      const provider = createPiProvider({ provider: "google" });
      expect(provider.id).toBe("google");
    });

    it("leaves DeepSeek thinking and effort at their official defaults", async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const model: Model<"openai-completions"> = {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        provider: "deepseek" as any,
        baseUrl: "https://api.deepseek.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 16_384,
      };
      const provider = createPiProvider({
        provider: "deepseek",
        apiKey: "test",
        customModel: model,
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("payload captured before network");
        },
      });

      await expect(provider.complete({
        model: model.id,
        messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
        tools: [{
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      })).rejects.toThrow(/payload captured before network/);

      expect(capturedPayload).toMatchObject({
        tools: [{
          type: "function",
          function: { name: "read_file" },
        }],
      });
      expect(capturedPayload).not.toHaveProperty("thinking");
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");

      capturedPayload = undefined;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      for await (const _event of provider.stream({
        model: model.id,
        messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
        tools: [{
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      })) {
        // The payload hook intentionally aborts before network I/O.
      }
      const warningText = warning.mock.calls.flat().join(" ");
      warning.mockRestore();
      expect(warningText).toContain("payload captured before network");
      expect(capturedPayload).toMatchObject({
        tools: [{ type: "function", function: { name: "read_file" } }],
      });
      expect(capturedPayload).not.toHaveProperty("thinking");
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");
    });

    it("preserves explicit DeepSeek off and effort choices on complete and stream", async () => {
      const model: Model<"openai-completions"> = {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        provider: "deepseek" as any,
        baseUrl: "https://api.deepseek.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 16_384,
      };
      const payloads: Record<string, unknown>[] = [];
      const provider = createPiProvider({
        provider: "deepseek",
        apiKey: "test",
        customModel: model,
        onPayload: (payload) => {
          payloads.push(payload as Record<string, unknown>);
          throw new Error("payload captured before network");
        },
      });
      const base = {
        model: model.id,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "answer" }] }],
      };

      await expect(provider.complete({ ...base, reasoning: "off" }))
        .rejects.toThrow(/payload captured before network/);
      await expect(provider.complete({ ...base, reasoning: "high" }))
        .rejects.toThrow(/payload captured before network/);

      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      for await (const _event of provider.stream({ ...base, reasoning: "off" })) {
        // The payload hook intentionally aborts before network I/O.
      }
      for await (const _event of provider.stream({ ...base, reasoning: "high" })) {
        // The payload hook intentionally aborts before network I/O.
      }
      const warningText = warning.mock.calls.map((call) => call.join(" "));
      warning.mockRestore();
      expect(warningText).toHaveLength(2);
      expect(warningText.every((line) => line.includes("payload captured before network"))).toBe(true);

      expect(payloads[0]).toMatchObject({ thinking: { type: "disabled" } });
      expect(payloads[1]).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      });
      expect(payloads[2]).toMatchObject({ thinking: { type: "disabled" } });
      expect(payloads[3]).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      });
    });

    it("removes only adapter-synthesized off controls across reasoning protocols", () => {
      const baseModel = {
        id: "reasoner",
        name: "Reasoner",
        api: "openai-completions" as const,
        provider: "test" as any,
        baseUrl: "https://example.test/v1",
        reasoning: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 10_000,
      };

      expect(restoreOfficialReasoningDefaultsForTest(
        { thinking: { type: "disabled" }, messages: [] },
        { ...baseModel, compat: { thinkingFormat: "deepseek" } },
      )).toEqual({ messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        { enable_thinking: false, messages: [] },
        { ...baseModel, compat: { thinkingFormat: "qwen" } },
      )).toEqual({ messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        { reasoning: { effort: "none", summary: "auto" }, messages: [] },
        { ...baseModel, compat: { thinkingFormat: "openrouter" } },
      )).toEqual({ reasoning: { summary: "auto" }, messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        { reasoning: { effort: "none", summary: "auto" }, messages: [] },
        { ...baseModel, api: "openai-responses" },
      )).toEqual({ reasoning: { summary: "auto" }, messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        { reasoning: { enabled: false, max_tokens: 512 }, messages: [] },
        { ...baseModel, compat: { thinkingFormat: "together" } },
      )).toEqual({ reasoning: { max_tokens: 512 }, messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        {
          chat_template_kwargs: { enable_reasoning: false, retain_context: true },
          messages: [],
        },
        {
          ...baseModel,
          compat: {
            thinkingFormat: "chat-template",
            chatTemplateKwargs: {
              enable_reasoning: { $var: "thinking.enabled" },
              retain_context: true,
            },
          },
        },
      )).toEqual({ chat_template_kwargs: { retain_context: true }, messages: [] });
      expect(restoreOfficialReasoningDefaultsForTest(
        { thinking: { type: "enabled" }, reasoning_effort: "high" },
        { ...baseModel, compat: { thinkingFormat: "deepseek" } },
      )).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });

      const nonReasoningPayload = { thinking: { type: "disabled" }, messages: [] };
      expect(restoreOfficialReasoningDefaultsForTest(
        nonReasoningPayload,
        { ...baseModel, reasoning: false, compat: { thinkingFormat: "deepseek" } },
      )).toBe(nonReasoningPayload);
    });

    it("does not rewrite payload controls for non-reasoning models", async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const provider = createPiProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "test",
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("payload captured before network");
        },
      });

      await expect(provider.complete({
        model: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
        temperature: 0.25,
      })).rejects.toThrow(/payload captured before network/);

      expect(capturedPayload).toMatchObject({ temperature: 0.25 });
      expect(capturedPayload).not.toHaveProperty("thinking");
      expect(capturedPayload).not.toHaveProperty("reasoning");
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");
    });

    it("preserves official default toggles for built-in reasoning providers", async () => {
      async function capture(providerId: string, modelId: string): Promise<Record<string, any>> {
        let payload: Record<string, any> | undefined;
        const provider = createPiProvider({
          provider: providerId,
          model: modelId,
          apiKey: "test",
          onPayload: (value) => {
            payload = value as Record<string, any>;
            throw new Error("payload captured before network");
          },
        });
        await expect(provider.complete({
          model: modelId,
          messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
        })).rejects.toThrow(/payload captured before network/);
        return payload!;
      }

      const openai = await capture("openai", "gpt-5.1");
      const anthropic = await capture("anthropic", "claude-haiku-4-5");
      const google = await capture("google", "gemini-2.5-flash");
      const openrouter = await capture("openrouter", "aion-labs/aion-2.0");
      const zai = await capture("zai", "glm-4.7");
      const qwen = await capture("qwen-token-plan", "deepseek-v4-flash");
      const together = await capture("together", "MiniMaxAI/MiniMax-M3");

      expect(openai).not.toHaveProperty("reasoning");
      expect(anthropic).not.toHaveProperty("thinking");
      expect(google.config).not.toHaveProperty("thinkingConfig");
      expect(openrouter).not.toHaveProperty("reasoning");
      expect(zai).not.toHaveProperty("thinking");
      expect(qwen).not.toHaveProperty("enable_thinking");
      expect(together).not.toHaveProperty("reasoning");
    });

    it("prefers the actual upstream response model over the logical request model", () => {
      expect(resolvedResponseModelForTest(
        { model: "orkas-llm-1.0", responseModel: "deepseek-v4-pro" },
        "orkas-llm-1.0",
      )).toBe("deepseek-v4-pro");
      expect(resolvedResponseModelForTest(
        { model: "orkas-llm-1.0" },
        "fallback",
      )).toBe("orkas-llm-1.0");
    });

    it("decodes only bounded Orkas Server fallback response markers", () => {
      const cases = {
        pro_rate_limited: "rate_limited",
        pro_transport_error: "transport_error",
        pro_configuration_error: "configuration_error",
        pro_not_configured: "not_configured",
        pro_upstream_error: "upstream_error",
        pro_empty_response: "empty_response",
        pro_unavailable: "unavailable",
      } as const;
      for (const [marker, expected] of Object.entries(cases)) {
        expect(serverFallbackReasonFromResponseIdForTest(`orkas-fallback:${marker}`))
          .toBe(expected);
      }
      expect(serverFallbackReasonFromResponseIdForTest("orkas-fallback:future_reason"))
        .toBe("unknown");
      expect(serverFallbackReasonFromResponseIdForTest("chatcmpl-normal-id"))
        .toBeUndefined();
    });

    it("classifies native provider termination markers without leaking raw values", () => {
      expect(providerTerminationCategoryForTest("STOP", "stop")).toBe("normal");
      expect(providerTerminationCategoryForTest("completed", "stop")).toBe("normal");
      expect(providerTerminationCategoryForTest("MAX_TOKENS", "length")).toBe("length");
      expect(providerTerminationCategoryForTest("content_filter", "stop")).toBe("safety");
      expect(providerTerminationCategoryForTest("SAFETY", "stop")).toBe("safety");
      expect(providerTerminationCategoryForTest("sensitive", "stop")).toBe("safety");
      expect(providerTerminationCategoryForTest("future_provider_reason", "stop")).toBe("unknown");
      expect(providerTerminationCategoryForTest(undefined, "stop")).toBe("normal");
      expect(providerTerminationCategoryForTest(undefined, "length")).toBe("length");
    });

    it("does not silently fall back when an explicit model id is unknown", async () => {
      const provider = createPiProvider({ provider: "kimi-coding", apiKey: "test" });
      await expect(async () => {
        for await (const _ of provider.stream({
          model: "not-in-pi-ai-catalog",
          messages: [],
        })) {
          // resolveModel fails before any provider request is made.
        }
      }).rejects.toThrow(/No model found for provider: kimi-coding, model: not-in-pi-ai-catalog/);
    });

    it("replays tool results with the original tool name for Gemini function responses", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "list files" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "list_files", input: { path: "." } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_1", content: "E_LIST_FAILED", isError: true }],
        },
      ];

      const context = buildPiContextForTest(messages);
      const toolResult = context.messages.find((message) => message.role === "toolResult") as
        | { role: "toolResult"; toolCallId: string; toolName: string; isError?: boolean }
        | undefined;

      expect(toolResult).toMatchObject({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "list_files",
        isError: true,
      });
    });

    it("passes runtime tool additions to native deferred-tool providers", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "load-1", name: "tool_load", input: { groups: ["web"] } }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            toolUseId: "load-1",
            content: "loaded",
            addedToolNames: ["web_search"],
          }],
        },
      ];

      const context = buildPiContextForTest(messages);
      const toolResult = context.messages.find((message) => message.role === "toolResult");

      expect(toolResult).toMatchObject({
        role: "toolResult",
        toolCallId: "load-1",
        toolName: "tool_load",
        addedToolNames: ["web_search"],
      });
    });

    it("serializes a loaded GPT tool at the native transcript insertion point", async () => {
      let capturedPayload: Record<string, any> | undefined;
      const model: Model<"openai-responses"> = {
        id: "gpt-5.6",
        name: "GPT-5.6",
        api: "openai-responses",
        provider: "openai" as any,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        compat: { supportsToolSearch: true },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      };
      const provider = createPiProvider({
        provider: "openai",
        apiKey: "test",
        customModel: model,
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, any>;
          throw new Error("payload captured before network");
        },
      });

      await expect(provider.complete({
        model: model.id,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "load-1", name: "tool_load", input: { groups: ["web"] } }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              toolUseId: "load-1",
              content: "loaded",
              addedToolNames: ["web_search"],
            }],
          },
        ],
        tools: [
          { name: "tool_load", description: "Load tools", inputSchema: { type: "object" } },
          { name: "web_search", description: "Search", inputSchema: { type: "object" } },
        ],
      })).rejects.toThrow(/payload captured before network/);

      expect(capturedPayload?.tools).toEqual([
        expect.objectContaining({ type: "function", name: "tool_load" }),
      ]);
      const searchOutput = capturedPayload?.input?.find((item: any) => item.type === "tool_search_output");
      expect(searchOutput).toMatchObject({
        execution: "client",
        status: "completed",
        tools: [expect.objectContaining({
          type: "function",
          name: "web_search",
          defer_loading: true,
        })],
      });
    });

    it("preserves structured tool schemas when adapting them to pi-ai", () => {
      const inputSchema = {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["update", "set_status"],
          },
          decision_evidence: {
            type: "object",
            properties: {
              source: { type: "string", enum: ["user_message"] },
              decision: { type: "string", enum: ["approve", "revise", "reject"] },
            },
            required: ["source", "decision"],
          },
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["step", "status"],
            },
          },
          value: {
            description: "A string or numeric value.",
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
        required: ["action", "decision_evidence", "plan"],
      };

      const context = buildPiContextForTest([], undefined, [{
        name: "structured_tool",
        description: "Exercise nested tool inputs.",
        inputSchema,
      }]);
      const parameters = context.tools?.[0]?.parameters as Record<string, any>;

      expect(parameters).toMatchObject(inputSchema);
      expect(parameters.properties.decision_evidence).toMatchObject({
        type: "object",
        required: ["source", "decision"],
      });
      expect(parameters.properties.plan.items).toMatchObject({
        type: "object",
        required: ["step", "status"],
      });
    });

    it("round-trips Gemini tool call thought signatures for replay", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "list_files",
              input: { path: "." },
              thoughtSignature: "QUJDRA==",
            },
          ],
        },
      ];

      const context = buildPiContextForTest(
        messages,
        undefined,
        undefined,
        { api: "google-generative-ai", provider: "google", id: "gemini-3.5-flash" },
      );
      const assistant = context.messages.find((message) => message.role === "assistant") as
        | { role: "assistant"; content: Array<{ type: string; thoughtSignature?: string }> }
        | undefined;

      expect(assistant?.content[0]).toMatchObject({
        type: "toolCall",
        thoughtSignature: "QUJDRA==",
      });
    });

    it("preserves Gemini tool call thought signatures from provider responses", () => {
      const content = mapContentForTest([
        {
          type: "toolCall",
          id: "call_1",
          name: "list_files",
          arguments: { path: "." },
          thoughtSignature: "QUJDRA==",
        },
      ]);

      expect(content[0]).toMatchObject({
        type: "tool_use",
        id: "call_1",
        name: "list_files",
        thoughtSignature: "QUJDRA==",
      });
    });

    it("removes a complete leading think block at every provider boundary", () => {
      const providerText = "<think>private chain of thought</think>\n\nUser-facing result";
      const content = mapProviderContentForTest([
        {
          type: "text",
          text: providerText,
        },
      ]);

      expect(content).toEqual([{ type: "text", text: "User-facing result" }]);
      // The low-level mapper remains opt-in for replay and conversion callers;
      // only provider output crosses the mandatory privacy boundary.
      expect(mapContentForTest([{ type: "text", text: providerText }]))
        .toEqual([{ type: "text", text: providerText }]);
      expect(stripLeadingThinkTextForTest(
        "  <think>private chain of thought</think>\nAnswer",
      )).toBe("Answer");
      expect(stripLeadingThinkTextForTest("<think>unfinished private reasoning"))
        .toBe("");
    });

    it("suppresses a leading think block split across streaming deltas", () => {
      const filter = createLeadingThinkTextFilterForTest();

      expect(filter.push("\n<th")).toBe("");
      expect(filter.push("ink>private reasoning")).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: true,
        chars: "private reasoning".length,
        text: "private reasoning",
        ended: false,
      });
      expect(filter.push(" continues</thi")).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: false,
        chars: " continues".length,
        text: " continues",
        ended: false,
      });
      expect(filter.push("nk>\n\nVisible")).toBe("Visible");
      expect(filter.takeThinkingActivity()).toEqual({
        started: false,
        chars: 0,
        text: "",
        ended: true,
      });
      expect(filter.push(" answer")).toBe(" answer");
      expect(filter.finish()).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: false,
        chars: 0,
        text: "",
        ended: false,
      });
    });

    it("suppresses consecutive leading think blocks, including a split second opening tag", () => {
      expect(stripLeadingThinkTextForTest(
        "<think>first private thought</think>\n<think>second private thought</think>\nVisible result",
      )).toBe("Visible result");

      const filter = createLeadingThinkTextFilterForTest();
      expect(filter.push("<think>first private thought</think>\n<th")).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: true,
        chars: "first private thought".length,
        text: "first private thought",
        ended: true,
      });
      expect(filter.push("ink>second private thought</thi")).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: true,
        chars: "second private thought".length,
        text: "second private thought",
        ended: false,
      });
      expect(filter.push("nk>\nVisible result")).toBe("Visible result");
      expect(filter.takeThinkingActivity()).toEqual({
        started: false,
        chars: 0,
        text: "",
        ended: true,
      });
      expect(filter.finish()).toBe("");
    });

    it("preserves a second-tag lookalike after suppressing a real leading think block", () => {
      expect(stripLeadingThinkTextForTest(
        "<think>private thought</think>\n<thinker>visible element</thinker>",
      )).toBe("<thinker>visible element</thinker>");

      const filter = createLeadingThinkTextFilterForTest();
      expect(filter.push("<think>private thought</think>\n<thin")).toBe("");
      expect(filter.finish()).toBe("<thin");
    });

    it("reports an unterminated leading think block through EOF without exposing answer text", () => {
      const filter = createLeadingThinkTextFilterForTest();

      expect(filter.push("<think>unfinished private reasoning")).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: true,
        chars: "unfinished private reasoning".length,
        text: "unfinished private reasoning",
        ended: false,
      });
      expect(filter.finish()).toBe("");
      expect(filter.takeThinkingActivity()).toEqual({
        started: false,
        chars: 0,
        text: "",
        ended: true,
      });
    });

    it("preserves inline, fenced, similar, and partial think-tag lookalikes", () => {
      const lookalikes = [
        "Answer with an inline <think> example",
        "```xml\n<think>example</think>\n```",
        "<thinker>visible element</thinker>",
        "\n<thin",
      ];

      for (const text of lookalikes) {
        expect(stripLeadingThinkTextForTest(text)).toBe(text);
      }
    });

    it("drops a non-JSON reasoning signature when history moves to an OpenAI Responses model", () => {
      const messages: Message[] = [{
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "private prior-model reasoning",
          thinkingSignature: "reasoning_content",
        }],
      }];

      const context = buildPiContextForTest(
        messages,
        undefined,
        undefined,
        { api: "openai-responses", provider: "openai", id: "gpt-5.5" },
      );
      const assistant = context.messages.find((message) => message.role === "assistant") as
        | { role: "assistant"; content: Array<{ type: string; thinking?: string; thinkingSignature?: string }> }
        | undefined;

      expect(assistant?.content[0]).toMatchObject({
        type: "thinking",
        thinking: "private prior-model reasoning",
      });
      expect(assistant?.content[0]).not.toHaveProperty("thinkingSignature");
    });

    it("preserves a Responses-compatible reasoning signature on the next model turn", () => {
      const signature = JSON.stringify({ type: "reasoning", id: "rs_123" });
      const messages: Message[] = [{
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "compatible reasoning",
          thinkingSignature: signature,
        }],
      }];

      const context = buildPiContextForTest(
        messages,
        undefined,
        undefined,
        { api: "openai-responses", provider: "openai", id: "gpt-5.5" },
      );
      const assistant = context.messages.find((message) => message.role === "assistant") as
        | { role: "assistant"; content: Array<{ type: string; thinkingSignature?: string }> }
        | undefined;

      expect(assistant?.content[0]).toMatchObject({
        type: "thinking",
        thinkingSignature: signature,
      });
    });

    it("does not emit provider tool results when the matching tool_use is absent", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "missing_call", content: "orphan", isError: true }],
        },
      ];

      const context = buildPiContextForTest(messages);

      expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
    });

    it("serializes generic visual-analysis intent immediately before each image", () => {
      const messages: Message[] = [{
        role: "user",
        content: [
          { type: "image", data: "page-one", mediaType: "image/png", analysisMode: "quality_review" },
          { type: "image", data: "page-two", mediaType: "image/png", analysisMode: "understand" },
        ],
      }];

      const context = buildPiContextForTest(messages);
      const user = context.messages[0] as {
        role: "user";
        content: Array<{ type: string; text?: string; data?: string }>;
      };

      expect(user.content).toEqual([
        { type: "text", text: '<orkas_visual_analysis mode="quality_review"/>' },
        { type: "image", data: "page-one", mimeType: "image/png" },
        { type: "text", text: '<orkas_visual_analysis mode="understand"/>' },
        { type: "image", data: "page-two", mimeType: "image/png" },
      ]);
    });

    it("omits malformed empty-name tool calls and their tool results", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "", input: { path: "." } } as MessageContent],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_1", content: "E_LIST_FAILED", isError: true }],
        },
      ];

      const context = buildPiContextForTest(messages);

      expect(context.messages.some((message) => message.role === "assistant")).toBe(false);
      expect(context.messages.some((message) => {
        return message.role === "assistant" && message.content.some((part) => part.type === "toolCall");
      })).toBe(false);
      expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
    });
  });

  describe("listPiProviders / listPiModels", () => {
    it("lists available providers", () => {
      const providers = listPiProviders();
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
      expect(providers).toContain("google");
      expect(providers.length).toBeGreaterThan(5);
    });

    it("lists models for a provider", () => {
      const models = listPiModels("anthropic");
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id.includes("claude"))).toBe(true);
    });

    it("returns empty array for unknown provider", () => {
      const models = listPiModels("nonexistent");
      expect(models).toEqual([]);
    });
  });

  describe("ProviderRegistry", () => {
    it("creates registry with built-in factories", () => {
      const registry = new ProviderRegistry();
      const list = registry.list();
      expect(list).toContain("anthropic");
      expect(list).toContain("openai");
    });

    it("lists all pi-ai providers", () => {
      const registry = new ProviderRegistry();
      const list = registry.list();
      expect(list).toContain("google");
      expect(list).toContain("mistral");
      expect(list.length).toBeGreaterThan(10);
    });

    it("gets provider by id, creating from factory", () => {
      const registry = new ProviderRegistry();
      const provider = registry.get("anthropic");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("anthropic");
    });

    it("gets pi-ai provider by id even without explicit factory", () => {
      const registry = new ProviderRegistry();
      const provider = registry.get("google");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("google");
    });

    it("returns undefined for unknown provider", () => {
      const registry = new ProviderRegistry();
      expect(registry.get("unknown-provider-xyz")).toBeUndefined();
    });

    it("resolves provider from model string with slash", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("anthropic/claude-opus-4-8");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("anthropic");
      expect(resolved?.modelId).toBe("claude-opus-4-8");
    });

    it("resolves anthropic provider for claude- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("claude-opus-4-8");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("anthropic");
    });

    it("resolves openai provider for gpt- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("gpt-4o");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("openai");
    });

    it("resolves google provider for gemini- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("gemini-2.0-flash");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("google");
    });

    it("creates providers from config", () => {
      const config = createConfig({
        models: {
          providers: {
            anthropic: { apiKey: "my-key" },
          },
        },
      });
      const registry = new ProviderRegistry(config);
      const provider = registry.get("anthropic");
      expect(provider).toBeDefined();
    });

    it("allows registering custom factories", () => {
      const registry = new ProviderRegistry();
      registry.registerFactory("custom", () => ({
        id: "custom",
        name: "Custom",
        complete: async () => { throw new Error("not implemented"); },
        stream: async function* () {},
        validateAuth: async () => true,
      }));

      const provider = registry.get("custom");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("custom");
    });
  });
});
