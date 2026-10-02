import { replayOrigin } from "../src/providers/replay-compatibility.js";
import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { assistantTextPhaseFromSignatureForTest, buildPiContextForTest, createAnthropicProvider, createLeadingThinkTextFilterForTest, createOpenAIProvider, createPiProvider, effectiveMaxTokensFromPayloadForTest, listPiProviders, listPiModels, mapContentForTest, mapProviderContentForTest, normalizeReasoningForProvider, providerTerminationCategoryForTest, resolvedResponseModelForTest, restoreOfficialReasoningDefaultsForTest, retryAfterMsFromForTest, serverFallbackReasonFromResponseIdForTest, stripLeadingThinkTextForTest, useProviderDefaultOutputLimitForTest, wrapErrorForTest } from "../src/providers/pi-provider.js";
import { AuthError, ContextOverflowError, ProviderError, RateLimitError, classifyRetryableError } from "../src/shared/errors.js";
import { createConfig } from "../src/config/loader.js";
import type { CompletionParams } from "../src/providers/base.js";
import type { Message, MessageContent, StreamEvent } from "../src/shared/types.js";
import type { Model } from "@earendil-works/pi-ai";
import { Session } from "../src/agent/session.js";
import { MIRRORED_PI_AI_SERIALIZER_VERSION, restoreHostMessageRoles } from "../src/providers/pi-provider.js";
import * as fs from "node:fs";

describe("Providers (pi-ai backed)", () => {
  it.each([
    ['complete', 'openai-completions'], ['stream', 'openai-completions'],
    ['complete', 'openai-responses'], ['stream', 'openai-responses'],
  ] as const)('retains stream rejection codes in diagnostics without changing failure delivery: %s / %s', async (method, api) => {
    const provider = createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
      id: 'fixture', name: 'fixture', provider: 'custom', api,
      baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
    const failures: any[] = [];
    try {
      for (const code of ['invalid_request_error', 'PRIVATE_CODE']) {
        const detail = { code, message: 'PRIVATE: context_length_exceeded' };
        const envelope = api === 'openai-responses' ? { type: 'error', ...detail } : { error: detail };
        const fetchStub = vi.fn(async () => new Response('data: ' + JSON.stringify(envelope) + '\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        }));
        vi.stubGlobal('fetch', fetchStub);
        const params: CompletionParams = { messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
          onRequestFailure: failure => failures.push(failure) };
        let delivered: unknown;
        if (method === 'complete') {
          try { await provider.complete(params); } catch (error) { delivered = error; }
        } else {
          const events: StreamEvent[] = [];
          for await (const event of provider.stream(params)) events.push(event);
          expect(events.filter(event => event.type === 'error')).toHaveLength(1);
          expect(events.some(event => event.type === 'message_end')).toBe(false);
          delivered = events.find(event => event.type === 'error')?.error;
        }
        expect(delivered).toBeInstanceOf(ProviderError);
        expect((delivered as Error).message).toContain(detail.message);
        expect(fetchStub).toHaveBeenCalledTimes(1);
        if (code === 'invalid_request_error') expect(classifyRetryableError(delivered)).toBeNull();
        expect(failures.at(-1)).toMatchObject({ phase: 'after_response', httpStatus: 200,
          source: 'sdk_error', code: code === 'PRIVATE_CODE' ? 'unknown' : code });
      }
      expect(failures).toHaveLength(2);
      expect(JSON.stringify(failures)).not.toContain('PRIVATE');
    } finally { vi.unstubAllGlobals(); }
  });

  it('isolates concurrent request failures and cannot lose the original error to a broken observer', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('broken logger'); });
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    const provider = createPiProvider({ provider: 'openai-codex', model: 'gpt-5.5', apiKey: `fixture.${token}.fixture` });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++calls === 1) {
        entered(); await gate;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) });
      }
      return new Response('private', { status: 503 });
    }));
    const first: any[] = [], second: any[] = [];
    const params: CompletionParams = { model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }] };
    try {
      const firstCall = provider.complete({ ...params, requestMetadata: { orkasRequestId: 'a'.repeat(32) }, onRequestFailure: failure => {
        first.push(failure); throw new Error('broken observer');
      } }).catch(error => error);
      await started;
      const secondError = await provider.complete({ ...params, requestMetadata: { orkasRequestId: 'b'.repeat(32) }, onRequestFailure: failure => second.push(failure) }).catch(error => error);
      release();
      const firstError = await firstCall;
      expect(firstError.message).toBe('fetch failed');
      expect(secondError.statusCode).toBe(503);
      expect(first).toMatchObject([{ code: 'ECONNRESET', phase: 'before_response', elapsedMs: expect.any(Number), aborted: false }]);
      expect(second).toMatchObject([{ code: 'unknown', phase: 'after_response', httpStatus: 503, elapsedMs: expect.any(Number), aborted: false }]);
      expect(first[0].requestRef).toBeUndefined();
      expect(second[0].requestRef).toBeUndefined();
      expect(calls).toBe(2);
    } finally { release?.(); vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it.each(['aborted', 'body_failure'] as const)('records %s without guessing a flattened cause or retrying', async mode => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    const provider = createPiProvider({ provider: 'openai-codex', model: 'gpt-5.5', apiKey: `fixture.${token}.fixture` });
    const controller = new AbortController();
    const fetchStub = vi.fn(async () => {
      if (mode === 'aborted') {
        controller.abort(); throw new DOMException('private-canary', 'AbortError');
      }
      return new Response(new ReadableStream({ start(stream) {
        stream.error(new TypeError('private-canary', { cause: { code: 'ECONNRESET' } }));
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchStub);
    const failures: any[] = [];
    try {
      const events: StreamEvent[] = [];
      for await (const event of provider.stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
        signal: controller.signal, onRequestFailure: failure => failures.push(failure) })) events.push(event);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
      if (mode === 'aborted') {
        const error = events.find(event => event.type === 'error');
        expect(classifyRetryableError(error?.type === 'error' ? error.error : undefined)).toBeNull();
      }
      expect(events.filter(event => event.type === 'message_end')).toHaveLength(0);
      expect(failures).toMatchObject([{ phase: mode === 'aborted' ? 'before_response' : 'after_response',
        code: 'unknown', aborted: mode === 'aborted', elapsedMs: expect.any(Number),
        ...(mode === 'body_failure' ? { httpStatus: 200 } : {}),
      }]);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-canary');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it('rejects complete() when the SDK stops with aborted instead of returning partial content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    const provider = createPiProvider({ provider: 'openai-codex', model: 'gpt-5.5', apiKey: `fixture.${token}.fixture` });
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new DOMException('private-canary', 'AbortError'); }));
    const failures: any[] = [];
    try {
      const error = await provider.complete({
        model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
        signal: controller.signal, onRequestFailure: failure => failures.push(failure),
      }).then(() => null, err => err);
      expect(error).toBeInstanceOf(Error);
      expect(classifyRetryableError(error)).toBeNull();
      expect(failures).toMatchObject([{ phase: 'before_response', code: 'unknown', aborted: true, elapsedMs: expect.any(Number) }]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-canary');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it.each(['complete', 'stream'] as const)('keeps distinct pre-response causes through the real SDK in %s diagnostics', async (method) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    const provider = createPiProvider({ provider: 'openai-codex', model: 'gpt-5.5', apiKey: `fixture.${token}.fixture` });
    const failures: any[] = [];
    try {
      for (const code of ['ECONNRESET', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'private-canary']) {
        const cause = Object.assign(new Error('private-canary'), { code });
        const fetchStub = vi.fn(async () => { throw new TypeError('fetch failed', { cause }); });
        vi.stubGlobal('fetch', fetchStub);
        const params = { model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
          onRequestFailure: (failure: any) => { failures.push(failure); } } as CompletionParams;
        let error: unknown;
        if (method === 'complete') {
          try { await provider.complete(params); } catch (err) { error = err; }
        } else {
          for await (const event of provider.stream(params)) if (event.type === 'error') error = event.error;
        }
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(classifyRetryableError(error)).toBe(code === 'ECONNRESET' ? 'connection_dropped' : 'network');
        expect(failures.at(-1)).toMatchObject({ phase: 'before_response', code: code === 'private-canary' ? 'unknown' : code, aborted: false });
        expect(failures.at(-1).elapsedMs).toBeGreaterThanOrEqual(0);
      }
      expect(failures).toHaveLength(4);
      expect(JSON.stringify(failures)).not.toContain('private-canary');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-canary');
      expect(failures.map(failure => failure.code)).toContain('ECONNRESET');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it.each([
    ['complete', undefined, 'openai-completions'], ['complete', 'low', 'openai-completions'],
    ['stream', undefined, 'openai-completions'], ['stream', 'low', 'openai-completions'],
    ['complete', undefined, 'google-generative-ai'], ['complete', 'low', 'google-generative-ai'],
    ['stream', undefined, 'google-generative-ai'], ['stream', 'low', 'google-generative-ai'],
  ] as const)('makes one SDK request on HTTP 429 for %s / reasoning=%s / %s', async (method, reasoning, api) => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'opaque fixture error',
      ...(api === 'google-generative-ai' ? { code: 429, status: 'RESOURCE_EXHAUSTED' } : {}),
    } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const provider = createPiProvider({ provider: 'custom', apiKey: 'fixture-key', customModel: {
        id: 'fixture-model', name: 'fixture', provider: 'custom', api,
        baseUrl: 'https://example.invalid/v1', reasoning: true, input: ['text', 'image'],
        contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } });
      const params: CompletionParams = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], reasoning };
      let error: unknown;
      if (method === 'complete') {
        try { await provider.complete(params); } catch (failure) { error = failure; }
      } else {
        for await (const event of provider.stream(params)) if (event.type === 'error') error = event.error;
      }
      expect(fetchStub).toHaveBeenCalledTimes(1);
      if (api === 'openai-completions') expect(error).toMatchObject({ statusCode: 429 });
      else expect((error as Error).message).toContain('429');
      expect(classifyRetryableError(error)).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ['complete', 'openai-completions'], ['stream', 'openai-completions'],
    ['complete', 'anthropic-messages'], ['stream', 'anthropic-messages'],
  ] as const)('preserves structured error types despite misleading messages in %s / %s', async (method, api) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
      id: 'fixture', name: 'fixture', provider: 'custom', api,
      baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
    try {
      for (const [type, expected] of [['upstream_error', 'service_unavailable'], ['invalid_request_error', null]] as const) {
        const fetchStub = vi.fn(async () => new Response(JSON.stringify({ error: { type, message: 'forbidden' } }), {
          status: 502, headers: { 'content-type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchStub);
        const params: CompletionParams = { messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }] };
        let failure: unknown;
        if (method === 'complete') {
          try { await provider.complete(params); } catch (error) { failure = error; }
        } else {
          for await (const event of provider.stream(params)) if (event.type === 'error') failure = event.error;
        }
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(classifyRetryableError(failure)).toBe(expected);
      }
      expect(warning.mock.calls).toHaveLength(2);
      expect(warning.mock.calls.map(call => call[2]?.code)).toEqual(['upstream_error', 'invalid_request_error']);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('forbidden');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it.each([
    { method: "complete", reasoning: undefined },
    { method: "complete", reasoning: "low" as const },
    { method: "stream", reasoning: undefined },
    { method: "stream", reasoning: "low" as const },
  ])("preserves Codex HTTP failures for host retry policy across $method / $reasoning calls", async ({ method, reasoning }) => {
    const originalFetch = globalThis.fetch;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokenPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
    })).toString("base64");
    const provider = createPiProvider({
      provider: "openai-codex", model: "gpt-5.5", apiKey: `fixture.${tokenPayload}.fixture`,
    });
    const privateBody = "request-body-private-canary";
    try {
      // Identical text with distinct HTTP statuses proves classification does
      // not infer status from words. A later transport failure must not inherit
      // an earlier permanent status from this same provider instance.
      const failures: any[] = [];
      for (const [status, retryKind] of [[400, null], [403, null], [429, null], [503, "service_unavailable"], [undefined, "network"]] as const) {
        const fetchStub = vi.fn(async () => {
          if (status === undefined) throw new Error(privateBody);
          return new Response(status === 400
            ? JSON.stringify({ error: { message: privateBody, type: "invalid_request_error", param: "tools", code: null } })
            : privateBody, { status });
        });
        globalThis.fetch = fetchStub as typeof fetch;
        const params: CompletionParams = {
          messages: [{ role: "user", content: [{ type: "text", text: "check" }] }], reasoning,
          onRequestFailure: failure => { failures.push(failure); },
        };
        let failure: unknown;
        if (method === "complete") {
          try { await provider.complete(params); } catch (error) { failure = error; }
        } else {
          const events: StreamEvent[] = [];
          for await (const event of provider.stream(params)) events.push(event);
          const errors = events.filter(event => event.type === "error");
          expect(errors).toHaveLength(1);
          expect(events.some(event => event.type === "message_end")).toBe(false);
          failure = errors[0].error;
        }
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(failure).toBeInstanceOf(ProviderError);
        expect((failure as ProviderError).statusCode).toBe(status);
        expect(classifyRetryableError(failure)).toBe(retryKind);
        expect(failures.at(-1)).toMatchObject({ code: "unknown", aborted: false,
          phase: status === undefined ? "before_response" : "after_response" });
        expect(failures.at(-1).httpStatus).toBe(status);
      }
      expect(failures).toHaveLength(5);
      expect(JSON.stringify(failures)).not.toContain(privateBody);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(privateBody);
    } finally {
      globalThis.fetch = originalFetch;
      warning.mockRestore();
    }
  });

  it("preserves stream errors without logging their private message", async () => {
    const privateMessage = "provider-private-body-canary customer draft";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = createPiProvider({
        provider: "openai", model: "gpt-5.5", apiKey: "test",
        onPayload() { throw new Error(privateMessage); },
      });
      const events: StreamEvent[] = [];
      for await (const event of provider.stream({
        model: "gpt-5.5", messages: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
      })) events.push(event);
      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toContain(privateMessage);
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toContain(privateMessage);
    } finally {
      warning.mockRestore();
    }
  });

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
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning), replayOrigin: replayOrigin({ api: "openai-responses", provider: "openai", id: "gpt-5.5", baseUrl: "https://example.test/v1" }, "test") },
        { type: "text", text: "Checking", textSignature: JSON.stringify({ v: 1, id: "msg_original", phase: "commentary" }), replayOrigin: replayOrigin({ api: "openai-responses", provider: "openai", id: "gpt-5.5", baseUrl: "https://example.test/v1" }, "test") },
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

    it("keeps local model limits for planning while omitting OpenAI-compatible auxiliary wire caps", () => {
      const model = {
        id: "qwen3.8-max",
        name: "Qwen 3.8 Max",
        api: "openai-completions" as const,
        provider: "qwen" as any,
        baseUrl: "https://example.test/v1",
        reasoning: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 32_000,
      };
      expect(useProviderDefaultOutputLimitForTest(
        { max_completion_tokens: 32_000, messages: [] },
        model,
        "provider_default",
      )).toEqual({ messages: [] });
      expect(useProviderDefaultOutputLimitForTest(
        { max_completion_tokens: 1_200, messages: [] },
        model,
        undefined,
      )).toMatchObject({ max_completion_tokens: 1_200 });
    });

    it("sends Qwen's thinking-off parameter without an auxiliary cap for complete and stream", async () => {
      const capturedPayloads: Record<string, unknown>[] = [];
      const model: Model<"openai-completions"> = {
        id: "qwen3.8-max",
        name: "Qwen 3.8 Max",
        api: "openai-completions",
        provider: "qwen" as any,
        baseUrl: "https://example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 32_000,
        compat: { thinkingFormat: "qwen" },
      };
      const provider = createPiProvider({
        provider: "qwen",
        apiKey: "test",
        customModel: model,
        onPayload: (payload) => {
          capturedPayloads.push(payload as Record<string, unknown>);
          throw new Error("payload captured before network");
        },
      });

      const params: CompletionParams = {
        model: model.id,
        messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
        reasoning: "off" as const,
        requestMetadata: { outputLimitSource: "provider_default" },
      };
      await expect(provider.complete(params)).rejects.toThrow(/payload captured before network/);
      const streamEvents: StreamEvent[] = [];
      for await (const event of provider.stream(params)) streamEvents.push(event);
      // pi-ai represents a streaming setup failure as an error event rather
      // than rejecting the iterator; the payload was still captured first.
      expect(streamEvents.some((event) => event.type === "error")).toBe(true);

      expect(capturedPayloads).toHaveLength(2);
      for (const capturedPayload of capturedPayloads) {
        expect(capturedPayload).toMatchObject({ enable_thinking: false });
        expect(capturedPayload).not.toHaveProperty("max_tokens");
        expect(capturedPayload).not.toHaveProperty("max_completion_tokens");
        expect(capturedPayload).not.toHaveProperty("max_output_tokens");
        expect(capturedPayload).not.toHaveProperty("reasoning_effort");
      }
    });

    it("creates a provider for any pi-ai supported provider", () => {
      const provider = createPiProvider({ provider: "anthropic", model: "claude-opus-4-8" });
      expect(provider.id).toBe("anthropic");
    });

    it("creates google provider", () => {
      const provider = createPiProvider({ provider: "google" });
      expect(provider.id).toBe("google");
    });

    it("merges per-call transport headers without adding metadata to the payload", async () => {
      const originalFetch = globalThis.fetch;
      const observed: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = input instanceof Request
          ? new Headers(input.headers)
          : new Headers(init?.headers);
        const rawBody = input instanceof Request ? await input.clone().text() : String(init?.body || "{}");
        observed.push({ headers, body: JSON.parse(rawBody) });
        return new Response(JSON.stringify({
          error: { message: "intentional test response", type: "invalid_request_error" },
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      try {
        const model: Model<"openai-completions"> = {
          id: "request-header-test",
          name: "Request Header Test",
          api: "openai-completions",
          provider: "custom" as any,
          baseUrl: "https://example.test/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_192,
          maxTokens: 1_024,
        };
        const provider = createPiProvider({
          provider: "custom",
          apiKey: "test",
          customModel: model,
          headers: { "x-static-test": "static" },
          requestHeaders: (metadata) => ({
            "x-request-id": String(metadata?.orkasRequestId || ""),
          }),
        });
        const events: StreamEvent[] = [];
        for await (const event of provider.stream({
          model: model.id,
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
          requestMetadata: { orkasRequestId: "0123456789abcdef0123456789abcdef" },
        })) {
          events.push(event);
        }

        expect(events.some((event) => event.type === "error")).toBe(true);
        expect(observed).toHaveLength(1);
        expect(observed[0].headers.get("x-static-test")).toBe("static");
        expect(observed[0].headers.get("x-request-id"))
          .toBe("0123456789abcdef0123456789abcdef");
        expect(observed[0].body).not.toHaveProperty("orkasRequestId");
      } finally {
        globalThis.fetch = originalFetch;
      }
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
      const errors: string[] = [];
      for await (const event of provider.stream({
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
        if (event.type === "error") errors.push(event.error.message);
      }
      const warningText = warning.mock.calls.flat().join(" ");
      warning.mockRestore();
      expect(errors).toEqual([expect.stringContaining("payload captured before network")]);
      expect(warningText).toContain("provider stream failed");
      expect(warningText).not.toContain("payload captured before network");
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
      const errors: string[] = [];
      for await (const event of provider.stream({ ...base, reasoning: "off" })) {
        // The payload hook intentionally aborts before network I/O.
        if (event.type === "error") errors.push(event.error.message);
      }
      for await (const event of provider.stream({ ...base, reasoning: "high" })) {
        // The payload hook intentionally aborts before network I/O.
        if (event.type === "error") errors.push(event.error.message);
      }
      const warningText = warning.mock.calls.map((call) => call.join(" "));
      warning.mockRestore();
      expect(errors).toEqual([
        expect.stringContaining("payload captured before network"),
        expect.stringContaining("payload captured before network"),
      ]);
      expect(warningText).toHaveLength(2);
      expect(warningText.every((line) => line.includes("provider stream failed"))).toBe(true);
      expect(warningText.join(" ")).not.toContain("payload captured before network");

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
        // Keep this on the API-key path; non-sk credentials select ChatGPT OAuth.
        apiKey: "sk-test-fixture",
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

    it("uses GPT-6 Responses tools, vision, explicit cache TTL, and supported reasoning levels", async () => {
      const payloads: Record<string, any>[] = [];
      const provider = createPiProvider({
        provider: "openai",
        model: "gpt-6-astra",
        // Keep this on the API-key path; non-sk credentials select ChatGPT OAuth.
        apiKey: "sk-test-fixture",
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
      ["openai", "gpt-6.1-sol"],
      ["openai", "gpt-6-sol"],
      ["openai", "gpt-6-luna"],
      ["openai-codex", "gpt-6.1-sol"],
      ["openai-codex", "gpt-6-sol"],
      ["openai-codex", "gpt-6-luna"],
    ])("sends %s %s through its native Responses adapter with image and tools", async (providerId, modelId) => {
      let capturedPayload: Record<string, any> | undefined;
      const codexPayload = Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
      })).toString("base64");
      const provider = createPiProvider({
        provider: providerId, model: modelId,
        apiKey: providerId === "openai-codex" ? `fixture.${codexPayload}.fixture` : "test",
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, any>;
          throw new Error("payload captured before network");
        },
      });
      await expect(provider.complete({
        model: modelId,
        messages: [{ role: "user", content: [
          { type: "text", text: "Read this" },
          { type: "image", data: "AQID", mimeType: "image/png" },
        ] }],
        tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
        reasoning: "low",
      })).rejects.toThrow(/payload captured before network/);
      expect(capturedPayload).toMatchObject({
        model: modelId,
        reasoning: { effort: "low" },
        tools: [expect.objectContaining({ type: "function", name: "read_file" })],
      });
      expect(JSON.stringify(capturedPayload?.input)).toContain("input_image");
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
      const qwen = await capture("qwen-token-plan", "qwen3.8-max");
      const together = await capture("together", "MiniMaxAI/MiniMax-M3");

      expect(openai).not.toHaveProperty("reasoning");
      expect(anthropic).not.toHaveProperty("thinking");
      expect(google.config).not.toHaveProperty("thinkingConfig");
      expect(openrouter).not.toHaveProperty("reasoning");
      expect(zai).not.toHaveProperty("thinking");
      expect(qwen).not.toHaveProperty("enable_thinking");
      expect(together).not.toHaveProperty("reasoning");
    });

    it.each([
      ["anthropic", "claude-fable-5-1", "anthropic"],
      ["anthropic", "claude-opus-5-5", "anthropic"],
      ["anthropic", "claude-sonnet-5-5", "anthropic"],
      ["openrouter", "anthropic/claude-fable-5.1", "anthropic"],
      ["openrouter", "anthropic/claude-opus-5.5", "anthropic"],
      ["openrouter", "anthropic/claude-sonnet-5.5", "anthropic"],
      ["openrouter", "openai/gpt-6.1-sol", "openai"],
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
          expect(body).toMatchObject({ model: modelId, thinking: { type: "adaptive" } });
          expect(body.tools).toContainEqual(expect.objectContaining({ name: "lookup" }));
          if (providerId === "anthropic") {
            expect(body.tools).toContainEqual(expect.objectContaining({ name: "__pi_deferred_placeholder__", defer_loading: true }));
          }
          const expectedMessages = [
            expect.objectContaining({ role: "user", content: expect.arrayContaining([{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]) }),
            expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "call_lookup", name: "lookup", input: { item: "sample" } })]) }),
            expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "call_lookup" })]) }),
          ];
          if (providerId === "anthropic") expectedMessages.push({ role: "system", content: [], output_config: { effort: "low" } });
          expect(body.messages).toEqual(expect.arrayContaining(expectedMessages));
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
        expect(warning.mock.calls).toEqual([["[pi-provider]", "provider stream failed", {
          budgetObserved: true, contextWindow: 1000000, outputLimit: 128000,
          phase: "after_response", code: "unknown", httpStatus: 200,
          source: "sdk_error", lastEvent: "text_delta",
          aborted: failure === "aborted", elapsedMs: expect.any(Number),
        }]]);

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
        compat: { supportsToolSearch: true, supportsAdditionalTools, supportsMidConvoSystemMessages: true },
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
        { role: "assistant", content: mapProviderContentForTest([{
          type: "toolCall", id: "search-1", name: "web_search",
          namespace: "web_search", arguments: {},
        }], false, undefined, replayOrigin(model, "test")) },
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
              replayOrigin: replayOrigin({ api: "google-generative-ai", provider: "google", id: "gemini-3.5-flash" }),
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

    it("removes a complete leading think block only for opted-in provider routes", () => {
      const providerText = "<think>private chain of thought</think>\n\nUser-facing result";
      const rawContent = [{
        type: "text" as const,
        text: providerText,
      }];
      const content = mapProviderContentForTest(rawContent, true);

      expect(content).toEqual([{ type: "text", text: "User-facing result" }]);
      expect(mapProviderContentForTest(rawContent)).toEqual([
        {
          type: "text" as const,
          text: providerText,
        },
      ]);
      // Replay and conversion callers remain pass-through unless the owning
      // provider route explicitly enables the wire-compatibility repair.
      expect(mapContentForTest([{ type: "text", text: providerText }]))
        .toEqual([{ type: "text", text: providerText }]);
      expect(stripLeadingThinkTextForTest(
        "  <think>private chain of thought</think>\nAnswer",
      )).toBe("Answer");
      expect(stripLeadingThinkTextForTest("<think>unfinished private reasoning"))
        .toBe("");
    });

    it("preserves official structured reasoning while normalizing opted-in text", () => {
      expect(mapProviderContentForTest([
        {
          type: "thinking",
          thinking: "structured private reasoning",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Visible result",
        },
      ], true)).toEqual([
        {
          type: "thinking",
          thinking: "structured private reasoning",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "Visible result" },
      ]);
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

    it("omits legacy foreign reasoning when history moves to an OpenAI Responses model", () => {
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

      expect(assistant).toBeUndefined();
      expect(messages[0].content[0]).toMatchObject({ thinkingSignature: "reasoning_content" });
    });

    it("preserves a Responses-compatible reasoning signature on the next model turn", () => {
      const signature = JSON.stringify({ type: "reasoning", id: "rs_123" });
      const messages: Message[] = [{
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "compatible reasoning",
          thinkingSignature: signature,
          replayOrigin: replayOrigin({ api: "openai-responses", provider: "openai", id: "gpt-5.5" }),
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

describe("pi-provider wrapError", () => {
  it.each(['complete', 'stream'] as const)('retains host budget errors before SDK flattening in %s', async method => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchStub = vi.fn(async () => { throw new Error('must not access network'); });
    vi.stubGlobal('fetch', fetchStub);
    const original = Object.assign(new Error('opaque diagnostic'), { code: 'TASK_TOKEN_LIMIT_REACHED' });
    const provider = createPiProvider({ provider: 'openai', model: 'gpt-5.5', apiKey: 'fixture',
      onPayload() { throw original; } });
    try {
      const params: CompletionParams = { messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }] };
      let failure: unknown;
      if (method === 'complete') {
        try { await provider.complete(params); } catch (error) { failure = error; }
      } else {
        for await (const event of provider.stream(params)) if (event.type === 'error') failure = event.error;
      }
      expect((failure as Error).cause).toBe(original);
      expect(classifyRetryableError(failure)).toBeNull();
      expect(fetchStub).not.toHaveBeenCalled();
      expect(warning.mock.calls).toHaveLength(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('opaque diagnostic');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it.each(["stream", "complete"] as const)("preserves structured context overflow on the %s adapter path", async (mode) => {
    const diagnostic = '400: {"message":"Request rejected","type":"invalid_request_error","code":"context_length_exceeded"}';
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let intercepted = 0;
    try {
      const provider = createPiProvider({
        provider: "openai", model: "gpt-5.5", apiKey: "test",
        onPayload() { intercepted++; throw Object.assign(new Error(diagnostic), { code: "context_length_exceeded" }); },
      });
      const params = { model: "gpt-5.5", messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "probe" }] },
      ] };
      if (mode === "complete") {
        await expect(provider.complete(params)).rejects.toBeInstanceOf(ContextOverflowError);
      } else {
        const events: StreamEvent[] = [];
        for await (const event of provider.stream(params)) events.push(event);
        const errors = events.filter((event) => event.type === "error");
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toBeInstanceOf(ContextOverflowError);
        expect(events.some((event) => event.type === "tool_use_start" || event.type === "message_end")).toBe(false);
      }
      expect(intercepted).toBe(1); // Every request stops before network access.
      expect(JSON.stringify(warning.mock.calls)).not.toContain(diagnostic);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    '{"code":"context_length_exceeded"}',
    '400 {"error":{"code":"context_length_exceeded"}}',
  ])("decodes a structured overflow code without depending on message wording: %s", (diagnostic) => {
    const original = new ProviderError(diagnostic, "openai", 400,
      Object.assign(new Error('opaque'), { code: 'context_length_exceeded' }));
    const wrapped = wrapErrorForTest(original, "openai");
    expect(wrapped).toBeInstanceOf(ContextOverflowError);
    expect(wrapped.cause).toBe(original);
  });

  it.each([
    '400: {"code":"invalid_request_error","message":"context_length_exceeded"}',
    '400: {"message":"The request context is too long"}',
    '400: {"code":"context_length_exceeded"',
    'Diagnostic example: {"code":"context_length_exceeded"}',
    '[{"code":"context_length_exceeded"}]',
  ])("preserves generic errors with missing, malformed, or quoted codes: %s", (diagnostic) => {
    const original = new ProviderError(diagnostic, "openai");
    expect(wrapErrorForTest(original, "openai")).toBe(original);
  });

  it("preserves a statusless authentication diagnostic without inventing its type", () => {
    const streamError = new ProviderError("The authentication token is expired", "openai-codex");
    const wrapped = wrapErrorForTest(streamError, "openai-codex");
    expect(wrapped).toBe(streamError);
  });

  it("preserves unrelated ProviderErrors for downstream policy classification", () => {
    const permissionError = new ProviderError("Forbidden", "openai-codex", 403);
    expect(wrapErrorForTest(permissionError, "openai-codex")).toBe(permissionError);
  });

  it.each([
    'Authentication is not the cause of this failure',
    'There is no rate limit on this request',
    'The record number is 429 and operation failed',
  ])('does not manufacture credential types from prose: %s', (message) => {
    const wrapped = wrapErrorForTest(new Error(message), 'custom');
    expect(wrapped).toBeInstanceOf(ProviderError);
    expect(wrapped.message).toBe(message);
  });

  it("parses delta-seconds retry-after from SDK error headers into retryAfterMs", () => {
    const sdkErr = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      headers: { "Retry-After": "7" },
    });
    const wrapped = wrapErrorForTest(sdkErr, "openai");
    expect(wrapped).toBeInstanceOf(RateLimitError);
    expect((wrapped as InstanceType<typeof RateLimitError>).retryAfterMs).toBe(7000);
  });

  it("absent header → retryAfterMs stays undefined (runner keeps default backoff)", () => {
    const wrapped = wrapErrorForTest(Object.assign(new Error("429 Too Many Requests"), { status: 429 }), "openai");
    expect(wrapped).toBeInstanceOf(RateLimitError);
    expect((wrapped as InstanceType<typeof RateLimitError>).retryAfterMs).toBeUndefined();
  });

  it("parses the HTTP-date retry-after form relative to now", () => {
    const target = new Date(Date.now() + 30_000).toUTCString();
    const sdkErr = Object.assign(new Error("rate limit exceeded"), {
      status: 429,
      headers: { "retry-after": target },
    });
    const wrapped = wrapErrorForTest(sdkErr, "anthropic");
    expect(wrapped).toBeInstanceOf(RateLimitError);
    const ms = (wrapped as InstanceType<typeof RateLimitError>).retryAfterMs;
    // toUTCString truncates milliseconds, so allow up to ~1s of slack below.
    expect(ms).toBeGreaterThanOrEqual(25_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("prefers retry-after-ms and supports WHATWG Headers instances", () => {
    const headers = new Headers({ "retry-after-ms": "2500", "retry-after": "9" });
    expect(retryAfterMsFromForTest(Object.assign(new Error("429"), { headers }))).toBe(2500);
  });

  it("walks the cause chain to the failing response's headers", () => {
    const inner = Object.assign(new Error("upstream 429"), {
      status: 429,
      response: { headers: { "retry-after": "3" } },
    });
    const outer = Object.assign(new Error("too many requests"), { cause: inner });
    const wrapped = wrapErrorForTest(outer, "openai");
    expect(wrapped).toBeInstanceOf(RateLimitError);
    expect((wrapped as InstanceType<typeof RateLimitError>).retryAfterMs).toBe(3000);
  });

  it("ignores unparsable retry-after values", () => {
    expect(retryAfterMsFromForTest(Object.assign(new Error("429"), {
      headers: { "retry-after": "soon-ish" },
    }))).toBeUndefined();
    expect(retryAfterMsFromForTest(Object.assign(new Error("429"), {
      headers: { "retry-after": "-5" },
    }))).toBeUndefined();
  });
});

describe("pi-provider buildPiContext › tool schema fidelity (CA-1)", () => {
  const richTool = {
    name: "todo_tasks",
    description: "manage the project task backlog",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "complete"],
          description: "The action to perform.",
        },
        filter: {
          type: "object",
          properties: { status: { type: "string", enum: ["open", "done"] } },
          required: ["status"],
        },
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      required: ["action"],
    },
  };

  function paramsOf() {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const context = buildPiContextForTest(messages, undefined, [richTool]);
    // The provider layer reads `parameters` as a plain JSON Schema; serialize
    // it the same way to assert what actually reaches the model.
    return JSON.parse(JSON.stringify(context.tools![0].parameters));
  }

  it("preserves enums instead of collapsing them to a bare string", () => {
    const p = paramsOf();
    expect(p.properties.action.type).toBe("string");
    expect(p.properties.action.enum).toEqual(["list", "create", "update", "complete"]);
    expect(p.properties.filter.properties.status.enum).toEqual(["open", "done"]);
  });

  it("preserves nested object shape and its inner required", () => {
    const p = paramsOf();
    expect(p.properties.filter.type).toBe("object");
    expect(p.properties.filter.properties.status.type).toBe("string");
    expect(p.properties.filter.required).toEqual(["status"]);
  });

  it("preserves array item schemas instead of Array(Any)", () => {
    const p = paramsOf();
    expect(p.properties.tags.type).toBe("array");
    expect(p.properties.tags.items).toEqual({ type: "string" });
  });

  it("keeps top-level required and scalar param types", () => {
    const p = paramsOf();
    expect(p.required).toEqual(["action"]);
    expect(p.properties.count.type).toBe("number");
  });
});
