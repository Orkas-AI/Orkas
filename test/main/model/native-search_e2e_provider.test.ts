import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ enabled: true, configured: false }));
vi.mock('../../../src/main/features/devtools', () => ({ isNativeSearchEnabled: () => policy.enabled }));
vi.mock('../../../src/main/features/search_auth', () => ({ hasAnySearchProfile: () => policy.configured }));

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-search-contract-'));
  vi.stubEnv('ORKAS_WORKSPACE_ROOT', root);
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('native search through the production payload hook and real SDK', () => {
  it.each([
    ['openai', 'openai-responses', false],
    ['openai', 'openai-responses', true],
    ['openai-codex', 'openai-codex-responses', false],
  ] as const)('preserves loading, replay, and fallback for %s / %s / additional=%s', async (providerId, api, supportsAdditionalTools) => {
    const { createPiProvider, Session } = await import('#core-agent');
    const { buildNativeSearchOnPayload } = await import('../../../src/main/model/core-agent/runner');
    const injected = vi.fn();
    const hook = buildNativeSearchOnPayload(providerId, 'gpt-5.5', injected);
    let raw: any;
    let sent: any;
    const capture = async (messages: any[], tools: any[], id = 'gpt-5.5') => {
      const fakeToken = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.test`;
      const provider = createPiProvider({ provider: providerId, apiKey: fakeToken,
        customModel: { id, name: id, api, provider: providerId, baseUrl: 'https://example.invalid',
          reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272000, maxTokens: 128000, compat: { supportsToolSearch: true, supportsAdditionalTools } },
        onPayload: (payload, model) => {
          raw = structuredClone(payload);
          sent = hook(payload, model);
          expect(payload).toEqual(raw);
          // The SDK has serialized the request; stop before all network access.
          throw new Error('captured-request');
        },
      });
      await expect(provider.complete({ model: id, messages, tools })).rejects.toThrow('captured-request');
      return structuredClone(sent);
    };
    const definitions = ['tool_load', 'web_search', 'web_fetch'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
    const start = [{ role: 'user', content: [{ type: 'text', text: 'Find the release notes.' }] }];
    const session = new Session();
    session.beginUserTurn(start[0].content as any);
    session.addAssistantMessage([{ type: 'tool_use', id: 'load-1', name: 'tool_load', input: { groups: ['web'] } }]);
    session.addToolResult('load-1', 'loaded', undefined, false, ['web_search', 'web_fetch']);
    // Reconstructing these messages also models replay after session reload.
    const loaded = JSON.parse(JSON.stringify(session.getMessagesForModel()));
    const insertionType = supportsAdditionalTools ? 'additional_tools' : 'tool_search_output';
    policy.enabled = true; policy.configured = false;
    const initial = await capture(start, definitions.slice(0, 1));
    expect(initial.tools.some((tool: any) => tool.type === 'web_search')).toBe(false);
    expect(injected).not.toHaveBeenCalled();
    const activated = await capture(loaded, definitions);
    expect(activated.tools.filter((tool: any) => tool.type === 'web_search')).toHaveLength(1);
    expect(activated.input.find((item: any) => item.type === insertionType).tools.map((tool: any) => tool.name)).toEqual(['web_fetch']);
    expect(activated.input.slice(0, initial.input.length)).toEqual(initial.input);
    expect(injected).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gpt-5.5', tool: 'web_search' }));
    expect(await capture(loaded, definitions)).toEqual(activated);

    // Native search does not erase the original function schema. A changed
    // preference or unsupported candidate must reconstruct the ordinary route.
    for (const state of [
      { configured: true, model: 'gpt-5.5' },
      { configured: false, model: 'unreviewed-model' },
    ]) {
      policy.configured = state.configured;
      injected.mockClear();
      const fallback = await capture(loaded, definitions, state.model);
      expect(fallback).toEqual(raw);
      expect(fallback.input.find((item: any) => item.type === insertionType).tools.map((tool: any) => tool.name)).toEqual(['web_search', 'web_fetch']);
      expect(injected).not.toHaveBeenCalled();
    }
    policy.enabled = true; policy.configured = false;
    // Compaction removes the insertion; active search still works in the prefix.
    const compacted = await capture(start, definitions);
    expect(compacted.tools.map((tool: any) => tool.name || tool.type)).toEqual(['tool_load', 'web_fetch', 'web_search']);
    // A later user turn without the activation must not inherit native search.
    const inactive = await capture(loaded, definitions.slice(0, 1));
    expect(inactive.tools.some((tool: any) => tool.type === 'web_search')).toBe(false);
    expect(inactive.input.some((item: any) => item.type === insertionType)).toBe(false);
  });
});


describe('Google native search payload compatibility', () => {
  it.each(['google-generative-ai', 'google-vertex'])('routes the real nested %s SDK payload without changing unrelated configuration', async (api) => {
    const { createPiProvider } = await import('#core-agent');
    const { buildNativeSearchOnPayload } = await import('../../../src/main/model/core-agent/runner');
    const providerId = api === 'google-vertex' ? 'google-vertex' : 'google';
    const injected = vi.fn();
    let sent: any;
    let raw: any;
    policy.enabled = true; policy.configured = false;
    const provider = createPiProvider({ provider: providerId, apiKey: 'fixture-key',
      customModel: { id: 'gemini-3.8-flash', name: 'fixture', api, provider: providerId,
        baseUrl: 'https://example.invalid/v1beta', reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192 },
      onPayload: (payload, model) => {
        raw = structuredClone(payload);
        sent = buildNativeSearchOnPayload(providerId, model.id, injected)(payload, model);
        expect(payload).toEqual(raw);
        throw new Error('captured-request');
      },
    });
    await expect(provider.complete({ model: 'gemini-3.8-flash', maxTokens: 777,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Check the release notes.' }] }],
      tools: ['web_search', 'web_fetch'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
    })).rejects.toThrow('captured-request');
    if (api === 'google-vertex') {
      expect(sent).toEqual(raw);
      expect(injected).not.toHaveBeenCalled();
      return;
    }
    expect(sent).not.toHaveProperty('tools');
    expect(sent.config.tools).toEqual([
      { functionDeclarations: [expect.objectContaining({ name: 'web_fetch' })] }, { googleSearch: {} },
    ]);
    expect(sent.config.toolConfig).toMatchObject({ includeServerSideToolInvocations: true, functionCallingConfig: { mode: 'VALIDATED' } });
    expect(sent.config.maxOutputTokens).toBe(777);
    expect(sent.contents).toEqual(raw.contents);
    expect(injected).toHaveBeenCalledOnce();
  });
});

describe('Google server tool context through the SDK and durable session', () => {
  const definitions = ['web_search', 'lookup'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const nativeParts = [
    { toolCall: { id: 'search-1', toolType: 'GOOGLE_SEARCH', args: { query: 'release notes' } }, thoughtSignature: 'c2VhcmNo' },
    { toolResponse: { id: 'search-1', toolType: 'GOOGLE_SEARCH', response: { sources: [{ uri: 'https://example.org/release', title: 'Release notes' }] } } },
    { text: 'Checking the release.', thought: true, thoughtSignature: 'dGhvdWdodA==' },
    { functionCall: { id: 'lookup:1', name: 'lookup', args: { revision: 'v1' } }, thoughtSignature: 'Y2FsbA==' },
  ];
  function sse(parts: any[], finishReason: string | null = 'STOP') {
    const chunks = parts.map(part => ({ candidates: [{ content: { role: 'model', parts: [part] } }] }));
    if (finishReason) chunks.push({ candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, cachedContentTokenCount: 3, totalTokenCount: 25 } } as any);
    const bytes = new TextEncoder().encode(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join(''));
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  async function factory(providerId: string, modelId = 'gemini-3.8-flash') {
    const { createPiProvider } = await import('#core-agent');
    const { buildNativeSearchOnPayload, shouldUseGoogleNativeSearch } = await import('../../../src/main/model/core-agent/runner');
    return createPiProvider({ provider: providerId, apiKey: 'fixture-key',
      customModel: { id: modelId, name: 'fixture', api: providerId === 'google' ? 'google-generative-ai' : 'google-vertex',
        provider: providerId, baseUrl: 'https://example.invalid/v1beta', reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192 },
      googleNativeSearch: shouldUseGoogleNativeSearch,
      onPayload: buildNativeSearchOnPayload(providerId, modelId),
    });
  }

  it('preserves signed search/function order through reload, retry, and preference changes', async () => {
    const providerId = 'google';
    const { PersistentSession } = await import('#core-agent');
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? sse(nativeParts) : sse([{ text: 'Verified.' }]);
    });
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory(providerId);
      const sessionFile = path.join(root, `google-replay-${providerId}.jsonl`);
      const session = new PersistentSession({ sessionFile });
      session.beginUserTurn([{ type: 'text', text: 'Verify the release and look up its revision.' }]);
      const events: any[] = [];
      for await (const event of provider.stream({ model: 'gemini-3.8-flash', tools: definitions, messages: session.getMessagesForModel(), reasoning: 'low' })) events.push(event);
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      const terminals = events.filter(e => e.type === 'message_end');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ stopReason: 'tool_use', usage: { inputTokens: 17, outputTokens: 5, cacheReadTokens: 3, totalTokens: 25 } });
      expect(events.filter(e => e.type === 'tool_use_start').map(e => e.name)).toEqual(['lookup']);
      expect(JSON.parse(terminals[0].content[0].googleNativeReplay.partsJson)).toEqual(nativeParts);
      session.addAssistantMessage(terminals[0].content);
      session.addToolResult('lookup:1', 'Revision v1 exists.');
      const restored = new PersistentSession({ sessionFile });
      const messages = restored.getMessagesForModel();
      expect(messages).toEqual(session.getMessagesForModel());
      expect(restored.estimateTokens()).toBeGreaterThan(100);
      const snapshot = JSON.stringify(messages);
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await provider.complete({ model: 'gemini-3.8-flash', tools: definitions, messages });
        expect(result.content).toEqual([{ type: 'text', text: 'Verified.' }]);
      }
      expect(bodies).toHaveLength(4);
      expect(bodies[1]).toEqual(bodies[2]);
      for (const body of bodies.slice(1)) {
        expect(body.contents.find((c: any) => c.role === 'model').parts).toEqual(nativeParts);
        expect(body.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: 'lookup:1', name: 'lookup', response: { output: 'Revision v1 exists.' } });
        expect(body.toolConfig.includeServerSideToolInvocations).toBe(true);
        expect(body.toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
      }
      expect(bodies[1].tools).toContainEqual({ googleSearch: {} });
      expect(bodies[3].tools).toContainEqual({ googleSearch: {} });
      expect(bodies[3].tools[0].functionDeclarations.map((t: any) => t.name)).toEqual(['lookup']);
      expect(JSON.stringify(messages)).toBe(snapshot);
      // A different model must not receive opaque search responses/signatures.
      policy.enabled = true;
      const legacy = await factory(providerId, 'gemini-2.5-flash');
      await legacy.complete({ model: 'gemini-2.5-flash', tools: definitions, messages });
      expect(bodies.at(-1).tools).not.toContainEqual({ googleSearch: {} });
      expect(JSON.stringify(bodies.at(-1))).not.toContain('search-1');
      const projected = structuredClone(messages);
      for (const message of projected) {
        message.content = message.content.filter(c => c.type !== 'tool_use' && c.type !== 'tool_result');
      }
      await provider.complete({ model: 'gemini-3.8-flash', tools: definitions, messages: projected.filter(m => m.content.length) });
      expect(JSON.stringify(bodies.at(-1))).not.toContain('search-1');
      expect(JSON.stringify(bodies.at(-1))).not.toContain('lookup:1');
    } finally { globalThis.fetch = originalFetch; policy.enabled = true; }
  });

  it.each(['SAFETY', 'BLOCKLIST', 'SPII', 'prompt-block'] as const)('preserves a structured Google refusal through complete and stream: %s', async (reason) => {
    const { isProviderSafetyError } = await import('../../../src/core-agent/src/shared/errors');
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(async () => reason === 'prompt-block'
      ? new Response('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : sse([], reason));
    globalThis.fetch = fetch;
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory('google');
      const params = { model: 'gemini-3.8-flash', tools: definitions, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Fixture request.' }] }] };
      const completeError = await provider.complete(params).then(() => null, error => error);
      expect(isProviderSafetyError(completeError)).toBe(true);
      const events: any[] = [];
      let streamError: unknown;
      try { for await (const event of provider.stream(params)) events.push(event); }
      catch (error) { streamError = error; }
      expect(isProviderSafetyError(streamError ?? events.find(event => event.type === 'error')?.error)).toBe(true);
      expect(events.some(event => event.type === 'message_end')).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('does not retry a failed or unterminated native request and cancellation sends no request', async () => {
    const originalFetch = globalThis.fetch;
    const mock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    globalThis.fetch = mock;
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory('google');
      const params = { model: 'gemini-3.8-flash', tools: definitions, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Verify the release.' }] }] };
      await expect(provider.complete(params)).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(1);
      mock.mockImplementation(async () => sse(nativeParts, null));
      // An absent finish marker must not make a signed partial tool call executable.
      const events: any[] = [];
      await expect((async () => {
        for await (const event of provider.stream(params)) events.push(event);
      })()).rejects.toThrow('without a finish reason');
      expect(events.filter(e => e.type === 'message_end')).toEqual([]);
      expect(mock).toHaveBeenCalledTimes(2);
      const abort = new AbortController(); abort.abort();
      await expect(provider.complete({ ...params, signal: abort.signal })).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it.each(['complete', 'unterminated', 'cancelled'] as const)('runs only complete local function calls after hosted search: %s', async (outcome) => {
    const { AgentRunner, ProviderRegistry, createConfig, Session } = await import('#core-agent');
    const { defineTool } = await import('../../../src/core-agent/src/tools/base');
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? sse(nativeParts, outcome === 'unterminated' ? null : 'STOP') : sse([{ text: 'Verified.' }]);
    });
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory('google');
      const providers = new ProviderRegistry();
      providers.registerFactory('google', () => provider);
      const lookup = vi.fn(async () => ({ content: 'Revision v1 exists.' }));
      const search = vi.fn(async () => ({ content: 'ordinary search' }));
      const session = new Session();
      const runner = new AgentRunner({ providers, session, evolution: { enabled: false },
        config: createConfig({ agent: { defaultProvider: 'google', defaultModel: 'gemini-3.8-flash', maxRetries: 0 } }),
        tools: definitions.map(d => defineTool({ ...d, execute: d.name === 'lookup' ? lookup : search })),
      });
      const abort = new AbortController();
      const events: any[] = [];
      for await (const event of runner.runStream({ message: 'Verify the release and look up its revision.', signal: abort.signal })) {
        events.push(event);
        if (outcome === 'cancelled' && event.type === 'tool_delta') abort.abort();
      }
      expect(search).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
      expect(bodies).toHaveLength(outcome === 'complete' ? 2 : 1);
      if (outcome === 'complete') {
        expect(bodies[1].contents.find((c: any) => c.role === 'model').parts).toEqual(nativeParts);
        expect(events.some(e => e.type === 'text_delta' && e.text === 'Verified.')).toBe(true);
      } else {
        expect(session.getMessages().flatMap(m => m.content).some(c => c.googleNativeReplay)).toBe(false);
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  it('counts hidden search context, preserves complete sources for checkpointing, and rejects corrupt or oversized replay before networking', async () => {
    const { Session } = await import('#core-agent');
    const originalFetch = globalThis.fetch;
    const mock = vi.fn(async () => sse([{ text: 'Verified.' }]));
    globalThis.fetch = mock;
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory('google');
      const session = new Session();
      session.beginUserTurn([{ type: 'text', text: 'Keep the source evidence.' }]);
      const parts = structuredClone(nativeParts) as any[];
      parts[1].toolResponse.response.excerpt = 'source-evidence '.repeat(12000);
      session.addAssistantMessage([{ type: 'tool_use', id: 'lookup:1', name: 'lookup', input: { revision: 'v1' },
        googleNativeReplay: { api: 'google-generative-ai', provider: 'google', model: 'gemini-3.8-flash', partsJson: JSON.stringify(parts) } }]);
      session.addToolResult('lookup:1', 'Revision v1 exists.');
      expect(session.estimateActiveProcessTokens()).toBeGreaterThan(30000);
      expect(session.getPendingActiveCheckpoint()).toBeNull();
      session.addAssistantMessage([{ type: 'tool_use', id: 'lookup:2', name: 'lookup', input: { revision: 'v2' } }]);
      session.addToolResult('lookup:2', 'LATEST_RAW');
      const checkpoint = session.getPendingActiveCheckpoint();
      expect(checkpoint).not.toBeNull();
      const summaryInput = JSON.stringify(checkpoint!.messages);
      expect(summaryInput).toContain('https://example.org/release');
      expect(summaryInput).toContain('source-evidence '.repeat(1_000));
      expect(summaryInput).not.toContain('Y2FsbA==');
      expect(summaryInput).not.toContain('chars omitted]');
      expect(summaryInput).not.toContain('LATEST_RAW');
      const constrained = session.selectPendingActiveCheckpoint(undefined, 20_000);
      expect(constrained.capacityIssue).toBeUndefined();
      expect(constrained.candidate?.capacityLimited).toBe(true);
      expect(constrained.candidate!.inputTokens).toBeLessThanOrEqual(20_000);
      const boundedInput = JSON.stringify(constrained.candidate!.messages);
      expect(boundedInput).toContain('chars omitted]');
      expect(boundedInput).toContain('https://example.org/release');
      expect(boundedInput).toContain('tool_use lookup id=lookup:1');
      expect(boundedInput).toContain('Revision v1 exists.');
      expect(boundedInput).not.toContain('Y2FsbA==');
      expect(JSON.stringify(session.getMessages())).toContain('source-evidence '.repeat(12000));
      session.applyActiveCheckpointSummary('Release source: https://example.org/release; revision v1 exists.', constrained.candidate!.checkpointThroughMessageIndex);
      await provider.complete({ model: 'gemini-3.8-flash', tools: definitions, messages: session.getMessagesForModel() });
      const body = JSON.parse(String(mock.mock.calls[0][1]?.body));
      expect(JSON.stringify(body)).not.toContain('search-1');
      expect(JSON.stringify(body)).toContain('https://example.org/release');
      for (const partsJson of ['invalid-json', 'x'.repeat(2000001)]) {
        const messages: any[] = [{ role: 'assistant', content: [{ type: 'text', text: 'Previous answer',
          googleNativeReplay: { api: 'google-generative-ai', provider: 'google', model: 'gemini-3.8-flash', partsJson } }] }];
        await expect(provider.complete({ model: 'gemini-3.8-flash', tools: definitions, messages })).rejects.toThrow('Invalid Google tool context');
      }
      expect(mock).toHaveBeenCalledTimes(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('bounds incoming hosted context without committing a partial result', async () => {
    const originalFetch = globalThis.fetch;
    try {
      policy.enabled = true; policy.configured = false;
      const provider = await factory('google');
      const params = { model: 'gemini-3.8-flash', tools: definitions, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Search.' }] }] };
      for (const count of [1024, 4096, 16385]) {
        const parts = Array.from({ length: count }, () => ({ text: 'x' }));
        const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
        globalThis.fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
        const started = performance.now();
        if (count <= 16384) {
          const result = await provider.complete(params);
          expect(result.content).toHaveLength(count);
        } else await expect(provider.complete(params)).rejects.toThrow('exceeds replay limit');
        console.info('Google native SDK fixture cost', { parts: count, elapsedMs: Math.round((performance.now() - started) * 100) / 100 });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      }
      const oversized = { candidates: [{ content: { role: 'model', parts: [{ toolResponse: { id: 'search-1', response: { excerpt: 'x'.repeat(2000001) } } }] }, finishReason: 'STOP' }] };
      globalThis.fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(oversized)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      await expect(provider.complete(params)).rejects.toThrow('exceeds replay limit');
    } finally { globalThis.fetch = originalFetch; }
  });
});
