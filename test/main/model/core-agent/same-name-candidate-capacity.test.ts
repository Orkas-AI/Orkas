import { describe, expect, it } from 'vitest';
import { AgentRunner, createConfig, defineTool, ProviderRegistry, Session,
  type CompletionParams, type LLMProvider } from '#core-agent';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';

// A fallback gateway can expose the same model name with a smaller window or
// larger output reservation. Its next request must compact older work, retain
// the unread receipt, and finish without executing the tool again.
describe('same-name candidate capacity', () => {
  it.each(['stream', 'complete'] as const)('keeps prepared estimates scoped to their connection in %s', async mode => {
    const calls: CompletionParams[] = [];
    const transport: LLMProvider = {
      id: 'custom', name: 'Scope fixture',
      async complete(params) {
        calls.push(params);
        return { model: 'shared-model', content: [{ type: 'text', text: 'Finished' }],
          stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
      async *stream(params) { yield { type: 'message_end', ...await this.complete(params) }; },
      async validateAuth() { return true; },
    };
    const create = (profileId: string) => createRotatingProvider({ providerId: 'custom', candidates: [{
      profileId, providerId: 'custom', modelId: 'shared-model', contextWindow: 131072,
      maxTokens: 32768, build: async () => transport,
    }] });
    const source = create('source');
    const messages: CompletionParams['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(332000) }] }];
    const request = structuredClone({ model: 'shared-model', messages,
      requestTokenEstimate: { model: 'shared-model', messages, tokens: 60000, source: 'estimated' as const,
        budget: source.contextBudget?.() } });
    const invoke = async (provider: LLMProvider) => {
      if (mode === 'complete') return provider.complete(request);
      for await (const _ of provider.stream(request)) { /* drain */ }
    };
    const rebuilt = create('source');
    await invoke(rebuilt);
    expect(calls).toHaveLength(1);
    expect(rebuilt.contextBudget?.('served')).toMatchObject({ model: 'shared-model', contextWindow: 131072, maxOutputTokens: 32768 });
    const foreign = create('different-connection');
    await expect(invoke(foreign)).rejects.toMatchObject({ admissionChecked: true });
    expect(calls).toHaveLength(1);
    expect(foreign.contextBudget?.('served')).toBeUndefined();
  });

  it.each([
    { primaryWindow: 272000, primaryOutput: 32000, shared: true },
    { primaryWindow: 131072, primaryOutput: 8192, shared: true },
    { primaryWindow: 272000, primaryOutput: 32000, shared: false },
  ])('finishes after fallback with %j', async ({ primaryWindow, primaryOutput, shared }) => {
    const primaryId = shared ? 'shared-model' : 'primary-model';
    const fallbackId = shared ? 'shared-model' : 'fallback-model';
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'a'.repeat(40000) }]);
    for (let i = 0; i < 4; i++) {
      session.addAssistantMessage([{ type: 'tool_use', id: `old-${i}`, name: 'fetch', input: {} }]);
      session.addToolResult(`old-${i}`, 'r'.repeat(26000));
    }
    let mainCalls = 0, toolCalls = 0;
    const inlineAllowances: number[] = [];
    const main: CompletionParams[] = [];
    const receipt = 'p'.repeat(240000);
    const fallback: LLMProvider = {
      id: 'custom', name: 'Fallback fixture',
      async complete() { throw Error('Unexpected non-stream call'); },
      async *stream(params) {
        const summary = !params.requestTokenEstimate;
        const n = summary ? 100 : mainCalls++;
        if (!summary) main.push(params);
        yield { type: 'message_end', model: fallbackId, stopReason: n === 0 ? 'tool_use' : 'end_turn',
          content: n === 0 ? [{ type: 'tool_use', id: 'fetch-once', name: 'fetch', input: {} }]
            : [{ type: 'text', text: summary ? 'Summary' : 'Finished' }],
          usage: { inputTokens: 30000, outputTokens: 10, totalTokens: 30010 } };
      }, async validateAuth() { return true; },
    };
    const primary: LLMProvider = { ...fallback, name: 'Throttled fixture',
      async *stream() { throw Object.assign(new Error('Synthetic rate limit'), { status: 429 }); } };
    const rotating = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0, candidates: [
      { profileId: 'primary', providerId: 'custom', modelId: primaryId, contextWindow: primaryWindow,
        maxTokens: primaryOutput, build: async () => primary },
      { profileId: 'fallback', providerId: 'custom', modelId: fallbackId, contextWindow: 131072,
        maxTokens: 32768, build: async () => fallback },
    ] });
    const providers = new ProviderRegistry();
    providers.registerFactory('custom', () => rotating);
    const catalog: Record<string, { provider: string; model: string; contextWindow: number; maxOutputTokens: number }> = {};
    for (const [model, contextWindow, maxOutputTokens] of [
      [primaryId, primaryWindow, primaryOutput], [fallbackId, 131072, 32768],
    ] as const) {
      if (!catalog[model]) catalog[model] = { provider: 'custom', model, contextWindow, maxOutputTokens };
    }
    const runner = new AgentRunner({ session, providers, tools: [defineTool({
      name: 'fetch', description: 'Fetch a page', inputSchema: { type: 'object' },
      async execute(_input, ctx) {
        toolCalls++;
        inlineAllowances.push((ctx.state.toolResultInlineLedger as { initialTokens: number }).initialTokens);
        return { content: receipt };
      },
    })], config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: primaryId, maxRetries: 0 },
      evolution: { enabled: false }, models: { catalog } }) });
    const events: any[] = [];
    for await (const event of runner.runStream({ message: 'Resume', resumeActiveTurn: true })) events.push(event);
    const terminal = events.filter(event => event.type === 'done');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].result.meta.error).toBeUndefined();
    expect(terminal[0].result.text).toBe('Finished');
    expect(toolCalls).toBe(1);
    expect(mainCalls).toBe(2);
    expect(events.some(event => event.type === 'compaction')).toBe(true);
    expect(events.some(event => event.type === 'retry')).toBe(false);
    expect(inlineAllowances[0]).toBeGreaterThan(0);
    expect(inlineAllowances[0]).toBeLessThan(80609 - 30000);
    expect(JSON.stringify(main[1].messages)).toContain(receipt);
    expect(main[1].requestMetadata?.contextBudgetDiagnostics).toMatchObject({
      preparation_context_window: 131072, budget_context_window: 131072,
      output_reservation: 32768, input_ceiling_tokens: 80609,
    });
  });
});
