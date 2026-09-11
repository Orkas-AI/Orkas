import { Session } from "../src/agent/session.js";
import type { CompletionParams } from "../src/providers/base.js";
import * as fs from "node:fs";
import { MIRRORED_PI_AI_SERIALIZER_VERSION, restoreHostMessageRoles, assistantTextPhaseFromSignatureForTest } from "../src/providers/pi-provider.js";
import type { StreamEvent } from "../src/shared/types.js";
import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildPiContextForTest, createAnthropicProvider, createLeadingThinkTextFilterForTest, createOpenAIProvider, createPiProvider, effectiveMaxTokensFromPayloadForTest, listPiProviders, listPiModels, mapContentForTest, mapProviderContentForTest, normalizeReasoningForProvider, providerTerminationCategoryForTest, resolvedResponseModelForTest, restoreOfficialReasoningDefaultsForTest, serverFallbackReasonFromResponseIdForTest, stripLeadingThinkTextForTest } from "../src/providers/pi-provider.js";
import { createConfig } from "../src/config/loader.js";
import type { Message, MessageContent } from "../src/shared/types.js";
import type { Model } from "@earendil-works/pi-ai";

describe("Providers (pi-ai backed)", () => {
it("keeps tool-image compatibility trailers below host instruction authority in Chat Completions", async () => {
    let captured: any;
    const provider = createPiProvider({ provider: "openai", apiKey: "test", customModel: {
      api: "openai-completions", provider: "openai", id: "gpt-test", name: "test",
      baseUrl: "https://example.test/v1", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
      compat: { supportsDeveloperRole: false },
    }, onPayload(payload) { captured = payload; throw new Error("chat roles captured before network"); } });
    await expect(provider.complete({ model: "gpt-test", messages: [
      { role: "user", content: [{ type: "text", text: "Inspect" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "image", name: "read_files", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "image", content: "Preview",
        images: [{ type: "image", data: "pixels", mediaType: "image/png" }] }] },
      { role: "developer", content: [{ type: "text", text: "Continue" }] },
    ] })).rejects.toThrow("chat roles captured before network");
    // Without declared developer support the host row stays `user`; no mid-history `system`.
    expect(captured.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "tool", "user", "user"]);
    expect(captured.messages[3].content.some((part: any) => part.type === "image_url")).toBe(true);
    expect(captured.messages[4].content).toEqual([{ type: "text", text: "Continue" }]);
  });

it("keeps portable roles on native serializer drift instead of failing or guessing", () => {
    const context = buildPiContextForTest([
      { role: "user", content: [{ type: "text", text: "real user" }] },
      { role: "developer", content: [{ type: "text", text: "host control" }] },
    ]);
    const model = { api: "openai-responses" } as Model<any>;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const drifted = { input: [{ role: "user", content: "real user" }] };
      expect(restoreHostMessageRoles(drifted, context, model)).toBe(drifted);
      expect(drifted.input[0].role).toBe("user");
      const missing = {};
      expect(restoreHostMessageRoles(missing, context, model)).toBe(missing);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).toContain("native serializer drift");
      // Positive control: matching counts still promote exactly the host row.
      const aligned = { input: [{ role: "user", content: "real user" }, { role: "user", content: "host control" }] };
      const restored = restoreHostMessageRoles(aligned, context, model) as { input: Array<{ role: string }> };
      expect(restored.input.map((item) => item.role)).toEqual(["user", "developer"]);
    } finally {
      warn.mockRestore();
    }
  });

it("promotes Chat Completions host rows only when developer support is declared", () => {
    const context = buildPiContextForTest([
      { role: "user", content: [{ type: "text", text: "real user" }] },
      { role: "developer", content: [{ type: "text", text: "host control" }] },
    ]);
    const payload = () => ({ messages: [{ role: "user", content: "real user" }, { role: "user", content: "host control" }] });
    const roles = (result: unknown) => (result as { messages: Array<{ role: string }> }).messages.map((item) => item.role);
    const chat = (compat: Record<string, unknown> | undefined) => ({ api: "openai-completions", input: ["text"], compat }) as Model<any>;
    expect(roles(restoreHostMessageRoles(payload(), context, chat({ supportsDeveloperRole: true })))).toEqual(["user", "developer"]);
    expect(roles(restoreHostMessageRoles(payload(), context, chat({ supportsDeveloperRole: false })))).toEqual(["user", "user"]);
    expect(roles(restoreHostMessageRoles(payload(), context, chat(undefined)))).toEqual(["user", "user"]);
  });

it("pins the mirrored serializer rules to the installed pi-ai release", () => {
    const installed = JSON.parse(fs.readFileSync(
      new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8",
    )) as { version: string };
    // A bump means someone re-read transform-messages and the Chat Completions
    // image-trailer rule against the new release before updating the constant.
    expect(installed.version).toBe(MIRRORED_PI_AI_SERIALIZER_VERSION);
  });

it("preserves Responses reasoning and phase across host controls and native tool images", async () => {
    const payloads: any[] = [];
    const provider = createPiProvider({
      provider: "openai", apiKey: "test",
      customModel: { api: "openai-responses", provider: "openai", id: "gpt-5.5", name: "GPT-5.5",
        baseUrl: "https://example.test/v1", reasoning: true, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
      onPayload(payload) { payloads.push(payload); throw new Error("host-role payload captured before network"); },
    });
    const reasoning = { type: "reasoning", id: "rs_replay", summary: [], encrypted_content: "opaque" };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "[Internal execution control] quoted by a real user" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
        { type: "text", text: "Checking", textSignature: JSON.stringify({ v: 1, id: "msg_original", phase: "commentary" }) },
        { type: "tool_use", id: "call_image", name: "read_files", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_image", content: "image loaded",
        images: [{ type: "image", data: "aGVsbG8=", mediaType: "image/png" }] }] },
      { role: "developer", content: [{ type: "text", text: "Continue the existing task." }] },
      { role: "user", content: [{ type: "text", text: "A real correction" }] },
    ];
    const params = { model: "gpt-5.5", messages, systemPrompt: "Stable system", sessionId: "host-role-test" };
    await expect(provider.complete(params)).rejects.toThrow("host-role payload captured before network");
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(params)) events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      const input = payload.input;
      expect(input).toContainEqual(reasoning);
      expect(input).toContainEqual(expect.objectContaining({ id: "msg_original", phase: "commentary" }));
      expect(input.filter((item: any) => item.role === "user")).toHaveLength(2);
      expect(input).toContainEqual(expect.objectContaining({ role: "developer",
        content: [{ type: "input_text", text: "Continue the existing task." }] }));
      expect(input.find((item: any) => item.type === "function_call_output")).toMatchObject({
        call_id: "call_image", output: [
          { type: "input_text", text: "image loaded" },
          { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      });
      expect(payload.prompt_cache_key).toBe("host-role-test");
    }
    expect(messages[0].role).toBe("user");
  });

it("reads Responses text phase only from structured signature metadata", () => {
    expect(assistantTextPhaseFromSignatureForTest(
      JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
    )).toBe("commentary");
    expect(assistantTextPhaseFromSignatureForTest(
      JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
    )).toBe("final_answer");
    expect(assistantTextPhaseFromSignatureForTest("commentary in ordinary text"))
      .toBeUndefined();
    expect(assistantTextPhaseFromSignatureForTest(
      JSON.stringify({ v: 1, id: "msg_3", phase: "unsupported" }),
    )).toBeUndefined();
  });
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
        { model: "custom-model-alias", responseModel: "deepseek-v4-pro" },
        "custom-model-alias",
      )).toBe("deepseek-v4-pro");
      expect(resolvedResponseModelForTest(
        { model: "custom-model-alias" },
        "fallback",
      )).toBe("custom-model-alias");
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

    it.each([
      { insertionType: "tool_search_output", supportsAdditionalTools: false },
      { insertionType: "additional_tools", supportsAdditionalTools: true },
    ])("keeps native GPT namespaces and the prefix stable across loading, use, retry, and repeated loading ($insertionType)", async ({ insertionType, supportsAdditionalTools }) => {
      let capturedPayload: Record<string, any> | undefined;
      const model: Model<"openai-responses"> = {
        id: "gpt-5.6",
        name: "GPT-5.6",
        api: "openai-responses",
        provider: "openai" as any,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        compat: { supportsToolSearch: true, supportsAdditionalTools },
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

      const tools = [
        { name: "tool_load", description: "Load tools", inputSchema: { type: "object" } },
        { name: "web_search", description: "Search", inputSchema: { type: "object" } },
      ];
      const start: Message[] = [
        { role: "system", content: [{ type: "text", text: "Stable tool directory." }] },
        { role: "user", content: [{ type: "text", text: "Find the release notes." }] },
      ];
      const capture = async (messages: Message[], definitions = tools) => {
        await expect(provider.complete({ model: model.id, messages, tools: definitions }))
          .rejects.toThrow(/payload captured before network/);
        return structuredClone(capturedPayload!);
      };
      const initial = await capture(start, tools.slice(0, 1));
      const loadedMessages: Message[] = [
        ...start,
        { role: "assistant", content: [{ type: "tool_use", id: "load-1", name: "tool_load", input: { groups: ["web"] } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "load-1", content: "loaded", addedToolNames: ["web_search"] }] },
      ];
      const loaded = await capture(loadedMessages);
      expect(loaded.tools).toEqual(initial.tools);
      expect(loaded.instructions).toEqual(initial.instructions);
      expect(loaded.input.slice(0, initial.input.length)).toEqual(initial.input);
      expect(await capture(loadedMessages)).toEqual(loaded);
      const steadyMessages: Message[] = [
        ...loadedMessages,
        { role: "assistant", content: mapContentForTest([{
          type: "toolCall", id: "search-1", name: "web_search",
          namespace: "web_search", arguments: {},
        }]) },
        { role: "user", content: [{ type: "tool_result", toolUseId: "search-1", content: "release notes" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "load-2", name: "tool_load", input: { groups: ["web"] } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "load-2", content: "already loaded" }] },
      ];
      const steady = await capture(steadyMessages);
      expect(steady.tools).toEqual(initial.tools);
      expect(steady.input.slice(0, loaded.input.length)).toEqual(loaded.input);
      expect(steady.input.filter((item: any) => item.type === insertionType)).toHaveLength(1);
      expect(steady.input.find((item: any) => item.type === "function_call" && item.name === "web_search"))
        .toMatchObject({ call_id: "search-1", namespace: "web_search", arguments: "{}" });
      expect(steady.input.find((item: any) => item.type === "function_call" && item.name === "tool_load"))
        .not.toHaveProperty("namespace");
      expect(await capture(steadyMessages)).toEqual(steady);

      const searchOutput = loaded.input.find((item: any) => item.type === insertionType);
      expect(searchOutput).toMatchObject({
        ...(supportsAdditionalTools ? { role: "developer" } : { execution: "client", status: "completed" }),
        tools: [expect.objectContaining({
          type: "function",
          name: "web_search",
          ...(supportsAdditionalTools ? {} : { defer_loading: true }),
        })],
      });

      // Compaction may remove the transcript insertion point. The current
      // active definitions must then move into the prefix, never disappear.
      const session = new Session();
      session.beginUserTurn([{ type: "text", text: "Find release notes" }]);
      session.addAssistantMessage(loadedMessages[2].content);
      session.addToolResult("load-1", "loaded", undefined, false, ["web_search"]);
      for (let index = 0; index < 5; index++) {
        session.addAssistantMessage([{ type: "tool_use", id: `search-${index}`, name: "web_search", input: {} }]);
        session.addToolResult(`search-${index}`, "x".repeat(15_000));
      }
      const candidate = session.getPendingActiveCheckpoint()!;
      expect(candidate).toBeTruthy();
      session.applyActiveCheckpointSummary("Earlier searches are complete.", candidate.checkpointThroughMessageIndex);
      const compactedMessages = session.getMessagesForModel();
      expect(JSON.stringify(compactedMessages)).not.toContain("addedToolNames");
      const compacted = await capture(compactedMessages);
      expect(compacted.tools.map((tool: any) => tool.name)).toEqual(["tool_load", "web_search"]);
      expect(compacted.input.some((item: any) => item.type === insertionType)).toBe(false);

      // Providers without native deferred schemas advertise the expanded list
      // up front. Do not claim their load round preserves the same prefix.
      const compatibility = createPiProvider({
        provider: "openai", apiKey: "test",
        customModel: { ...model, compat: { supportsToolSearch: false } },
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, any>;
          throw new Error("payload captured before network");
        },
      });
      await expect(compatibility.complete({ model: model.id, messages: loadedMessages, tools }))
        .rejects.toThrow(/payload captured before network/);
      expect(capturedPayload?.tools.map((tool: any) => tool.name)).toEqual(["tool_load", "web_search"]);
      expect(capturedPayload?.input.some((item: any) => item.type === "tool_search_output")).toBe(false);
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

it("uses GPT-6 Responses tools, vision, explicit cache TTL, and supported reasoning levels", async () => {
      const payloads: Record<string, any>[] = [];
      const provider = createPiProvider({
        provider: "openai",
        model: "gpt-6-astra",
        apiKey: "test",
        onPayload: (payload) => {
          payloads.push(payload as Record<string, any>);
          throw new Error("payload captured before network");
        },
      });
      const base = {
        model: "gpt-6-astra",
        messages: [{
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Read the diagram." },
            { type: "image" as const, data: "AQID", mimeType: "image/png" },
          ],
        }],
        tools: [{
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
        sessionId: "gpt6-payload-contract",
      };

      await expect(provider.complete({
        ...base,
        reasoning: "low",
        cacheRetention: "long",
      })).rejects.toThrow(/payload captured before network/);
      await expect(provider.complete({
        ...base,
        reasoning: "off",
        cacheRetention: "none",
      })).rejects.toThrow(/payload captured before network/);

      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({
        model: "gpt-6-astra",
        stream: true,
        prompt_cache_key: "gpt6-payload-contract",
        prompt_cache_options: { ttl: "30m" },
        reasoning: { effort: "low", summary: "auto" },
        tools: [{ type: "function", name: "read_file" }],
      });
      expect(payloads[0].prompt_cache_retention).toBeUndefined();
      expect(JSON.stringify(payloads[0].input)).toContain("input_image");

      expect(payloads[1]).toMatchObject({
        model: "gpt-6-astra",
        stream: true,
        prompt_cache_options: { mode: "explicit" },
      });
      expect(payloads[1].prompt_cache_key).toBeUndefined();
      expect(payloads[1].prompt_cache_retention).toBeUndefined();
      expect(payloads[1]).not.toHaveProperty("reasoning");
      expect(payloads[1]).not.toHaveProperty("include");
    });

it.each([
      ["anthropic", "claude-fable-5-1", "anthropic"],
      ["openrouter", "anthropic/claude-fable-5.1", "anthropic"],
      ["openrouter", "anthropic/claude-opus-5", "anthropic"],
      ["google", "gemini-3.8-flash", "google"],
      ["openrouter", "google/gemini-3.8-flash", "openai"],
    ])("round-trips %s %s through a fragmented tool stream and its follow-up result", async (providerId, modelId, protocol) => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; body: any }> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const raw = input instanceof Request ? await input.clone().text() : String(init?.body);
        requests.push({ url, body: JSON.parse(raw) });
        const toolReply = requests.length === 1;
        let data: unknown[];
        if (protocol === "anthropic") {
          data = [
            { type: "message_start", message: { id: "msg-compat", type: "message", role: "assistant", model: modelId, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: toolReply ? { type: "tool_use", id: "call_next", name: "lookup", input: {} } : { type: "text", text: "" } },
            ...(toolReply ? [
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"item":' } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"follow-up"}' } },
            ] : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "verified" } }]),
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: toolReply ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ];
        } else if (protocol === "google") {
          const parts = toolReply ? [{ functionCall: { id: "call_next", name: "lookup", args: { item: "follow-up" } } }] : [{ text: "verified" }];
          data = [{ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }], modelVersion: modelId, usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 } }];
        } else {
          data = toolReply ? [
            { id: "chatcmpl-compat", model: modelId, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: '{"item":' } }] }, finish_reason: null }] },
            { id: "chatcmpl-compat", model: modelId, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"follow-up"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
          ] : [{ id: "chatcmpl-compat", model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: "verified" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }];
        }
        const sse = data.map((event: any) => `${protocol === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
        const bytes = new TextEncoder().encode(sse + (protocol === "openai" ? "data: [DONE]\n\n" : ""));
        // Split inside SSE fields and JSON tokens, independently of event boundaries.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      try {
        const provider = createPiProvider({ provider: providerId, model: modelId, apiKey: "test" });
        const params: CompletionParams = {
          model: modelId,
          reasoning: "low",
          tools: [{ name: "lookup", description: "Look up an item", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } }],
          messages: [
            { role: "user", content: [{ type: "text", text: "Check this image" }, { type: "image", data: "aGVsbG8=", mediaType: "image/png" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "call_lookup", name: "lookup", input: { item: "sample" } }] },
            { role: "user", content: [{ type: "tool_result", toolUseId: "call_lookup", content: "item found" }] },
          ],
        };
        const events: StreamEvent[] = [];
        for await (const event of provider.stream(params)) events.push(event);
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
        const terminals = events.filter((event) => event.type === "message_end");
        expect(terminals).toHaveLength(1);
        const terminal = terminals[0];
        expect(terminal).toMatchObject({ model: modelId, stopReason: "tool_use", usage: { inputTokens: 12, outputTokens: 2 } });
        expect(terminal.content).toEqual([expect.objectContaining({ type: "tool_use", name: "lookup", input: { item: "follow-up" } })]);
        const tool = terminal.content![0];
        if (tool.type !== "tool_use") throw new Error("Expected a replayable tool call");
        expect(tool.id).toBeTruthy();
        expect(events.filter((event) => event.type === "tool_use_start")).toEqual([{ type: "tool_use_start", id: tool.id, name: "lookup" }]);
        expect(events.filter((event) => event.type === "tool_use_end")).toEqual([{ type: "tool_use_end", id: tool.id }]);
        const streamedArguments = events.filter((event) => event.type === "tool_use_delta").map((event) => event.input).join("");
        expect(JSON.parse(streamedArguments)).toEqual({ item: "follow-up" });
        const result = await provider.complete({
          ...params,
          messages: [
            ...params.messages,
            { role: "assistant", content: terminal.content! },
            { role: "user", content: [{ type: "tool_result", toolUseId: tool.id, content: "follow-up found" }] },
          ],
        });
        expect(result).toMatchObject({ model: modelId, stopReason: "end_turn", content: [{ type: "text", text: "verified" }], usage: { inputTokens: 12, outputTokens: 2 } });
        expect(requests).toHaveLength(2);
        const { url, body } = requests[0];
        if (protocol === "anthropic") {
          expect(url).toBe(providerId === "anthropic" ? "https://api.anthropic.com/v1/messages?beta=true" : "https://openrouter.ai/api/v1/messages?beta=true");
          expect(body).toMatchObject({ model: modelId, thinking: { type: "adaptive" }, tools: [expect.objectContaining({ name: "lookup" })] });
          expect(body.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "user", content: expect.arrayContaining([{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]) }),
            expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "call_lookup", name: "lookup", input: { item: "sample" } })]) }),
            expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "call_lookup" })]) }),
            { role: "system", content: [], output_config: { effort: "low" } },
          ]));
          const replayed = requests[1].body.messages.filter((message: any) => message.role === "user").at(-1).content
            .find((block: any) => block.type === "tool_result");
          expect(replayed).toMatchObject({ tool_use_id: tool.id });
          // Anthropic accepts tool-result text as either a string or text blocks.
          expect(typeof replayed.content === "string" ? replayed.content : replayed.content.map((block: any) => block.text).join(""))
            .toBe("follow-up found");
        } else if (protocol === "google") {
          expect(url).toContain(`/models/${modelId}:streamGenerateContent`);
          expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
          expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
          expect(body.contents[1].parts).toEqual(expect.arrayContaining([expect.objectContaining({ functionCall: expect.objectContaining({ name: "lookup", args: { item: "sample" } }) })]));
          expect(body.contents[2].parts).toEqual(expect.arrayContaining([expect.objectContaining({ functionResponse: expect.objectContaining({ name: "lookup" }) })]));
          expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: "lookup" });
          expect(requests[1].body.contents.at(-1).parts).toEqual(expect.arrayContaining([
            expect.objectContaining({ functionResponse: expect.objectContaining({ name: "lookup", response: { output: "follow-up found" } }) }),
          ]));
        } else {
          expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
          expect(body).toMatchObject({ model: modelId, reasoning: { effort: "low" } });
          expect(body.messages[0].content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } });
          expect(body.messages[1].tool_calls[0]).toMatchObject({ id: "call_lookup", function: { name: "lookup", arguments: '{"item":"sample"}' } });
          expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_lookup", content: "item found" });
          expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "lookup" } });
          expect(requests[1].body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: tool.id, content: "follow-up found" });
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

it.each(["truncated", "aborted"] as const)("does not complete a %s OpenRouter Claude stream and accepts a fresh retry", async (failure) => {
      const originalFetch = globalThis.fetch;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const abort = new AbortController();
      const modelId = "anthropic/claude-fable-5.1";
      let requestCount = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestCount += 1;
        const recovered = requestCount === 2;
        const signal = input instanceof Request ? input.signal : init?.signal;
        const events = [
          { type: "message_start", message: { id: "msg-interrupted", type: "message", role: "assistant", model: modelId, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: recovered ? "verified" : "partial" } },
          ...(recovered ? [
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ] : []),
        ];
        const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            if (recovered || failure === "truncated") controller.close();
            else signal?.addEventListener("abort", () => controller.error(new DOMException("Request aborted", "AbortError")), { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      try {
        const provider = createPiProvider({ provider: "openrouter", model: modelId, apiKey: "test" });
        const params: CompletionParams = { model: modelId, messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }] };
        const events: StreamEvent[] = [];
        for await (const event of provider.stream({ ...params, signal: abort.signal })) {
          events.push(event);
          if (failure === "aborted" && event.type === "text_delta") abort.abort();
        }
        expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "partial" }]);
        expect(events.filter((event) => event.type === "message_end")).toEqual([]);
        expect(events.filter((event) => event.type === "tool_use_start")).toEqual([]);
        const errors = events.filter((event) => event.type === "error");
        expect(errors).toHaveLength(1);
        const errorPattern = failure === "aborted" ? /abort/i : /stream ended/i;
        expect(errors[0].error.message).toMatch(errorPattern);
        expect(requestCount).toBe(1);
        expect(warning.mock.calls).toEqual([["[pi-provider]", expect.stringMatching(errorPattern)]]);

        warning.mockClear();
        const retryEvents: StreamEvent[] = [];
        for await (const event of provider.stream(params)) retryEvents.push(event);
        expect(retryEvents.filter((event) => event.type === "error")).toEqual([]);
        expect(retryEvents.filter((event) => event.type === "message_end")).toEqual([
          expect.objectContaining({ stopReason: "end_turn", content: [{ type: "text", text: "verified" }], model: modelId }),
        ]);
        expect(requestCount).toBe(2);
        expect(warning).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
        warning.mockRestore();
      }
    });
