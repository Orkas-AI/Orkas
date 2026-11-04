import { describe, expect, it } from 'vitest';
import {
  AgentRunner, createConfig, defineTool, ProviderCandidateChangedError, ProviderRegistry, Session,
  type CompletionParams, type LLMProvider, type StreamEvent,
} from '#core-agent';
import { createRotatingProvider, type RotatingCandidate } from '../../../../src/main/model/core-agent/rotating-provider';

// A user's own model with a smaller window than the fallback fallback. When
// the request could fit after compaction, the run compacts and stays on the
// user's model instead of moving onto the larger fallback.
type Call = { who: 'own' | 'fallback'; params: CompletionParams };
type Script = (n: number) => StreamEvent[] | Error;

const finished = (model: string): StreamEvent[] => [{ type: 'message_end', model, stopReason: 'end_turn',
  content: [{ type: 'text', text: 'Finished' }], usage: { inputTokens: 1000, outputTokens: 1, totalTokens: 1001 } }];
const fetchRound = (model: string, id: string, inputTokens = 0): StreamEvent[] => [{ type: 'message_end', model,
  stopReason: 'tool_use', usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
  content: [{ type: 'tool_use', id, name: 'fetch', input: {} }] }];
const creditsExhausted = () => Object.assign(new Error('fixture candidate changed'), { status: 402, code: 'fixture_candidate_changed' });

function backend(who: Call['who'], calls: Call[], script: Script): LLMProvider {
  let n = 0;
  return {
    id: who, name: who,
    async complete(params) {
      calls.push({ who, params });
      return { model: who, content: [{ type: 'text', text: 'Summary' }], stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    async *stream(params) {
      calls.push({ who, params });
      const out = script(n++);
      if (out instanceof Error) throw out;
      yield* out;
    },
    async validateAuth() { return true; },
  };
}

function candidates(own: LLMProvider, fallback: LLMProvider): Record<Call['who'], RotatingCandidate> {
  return {
    own: { profileId: 'own', providerId: 'custom', modelId: 'own-model',
      contextWindow: 131072, maxTokens: 32768, build: async () => own },
    fallback: { profileId: 'fallback', providerId: 'openai', modelId: 'fallback-model',
      contextWindow: 272000, maxTokens: 32000, build: async () => fallback },
  };
}

function harness(session: Session, own: LLMProvider, fallback: LLMProvider,
  order: Call['who'][] = ['own', 'fallback'], tools: Parameters<typeof defineTool>[0][] = []) {
  const byName = candidates(own, fallback);
  const primary = byName[order[0]];
  const rotating = createRotatingProvider({
    providerId: primary.providerId, networkRetryAttempts: 0,
    candidates: order.map(name => byName[name]),
  });
  const providers = new ProviderRegistry();
  providers.registerFactory(primary.providerId, () => rotating);
  const runner = new AgentRunner({
    session, providers, tools: tools.map(tool => defineTool(tool)),
    config: createConfig({
      agent: { defaultProvider: primary.providerId, defaultModel: primary.modelId, maxRetries: 0 },
      evolution: { enabled: false },
      models: { catalog: {
        'own-model': { provider: 'custom', model: 'own-model', contextWindow: 131072, maxOutputTokens: 32768 },
        'fallback-model': { provider: 'openai', model: 'fallback-model', contextWindow: 272000, maxOutputTokens: 32000 },
      } },
    }),
  });
  return { runner };
}

async function drain(runner: AgentRunner, message = 'Resume') {
  const events: any[] = [];
  for await (const event of runner.runStream({ message, resumeActiveTurn: true })) events.push(event);
  return { events, error: events.find(event => event.type === 'done')?.result.meta.error };
}

const mainCalls = (calls: Call[]) => calls.filter(call => call.params.tools?.length);

function seed(session: Session, groups: number, groupChars: number, userChars: number) {
  session.beginUserTurn([{ type: 'text', text: 'a'.repeat(userChars) }]);
  for (let i = 0; i < groups; i++) {
    session.addAssistantMessage([{ type: 'tool_use', id: `old-${i}`, name: 'fetch', input: {} }]);
    session.addToolResult(`old-${i}`, 'r'.repeat(groupChars));
  }
}

describe('own model capacity preference', () => {
  it('names the first available candidate as the budget model', async () => {
    const calls: Call[] = [];
    const own = backend('own', calls, () => finished('own-model'));
    const fallback = backend('fallback', calls, () => creditsExhausted());
    const byName = candidates(own, fallback);
    const rotating = createRotatingProvider({ providerId: 'openai', networkRetryAttempts: 0,
      candidates: [byName.fallback, byName.own] });
    expect(rotating.contextBudgetModel?.()).toBe('fallback-model');
    for await (const _event of rotating.stream({ model: 'fallback-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })) { /* drain */ }
    expect(calls.map(call => call.who)).toEqual(['fallback', 'own']);
    expect(rotating.contextBudgetModel?.()).toBe('own-model');
    // The desktop runner hands core this wrapper, not the rotating provider.

    const unknownWindow = createRotatingProvider({ providerId: 'custom', candidates: [
      { ...byName.own, contextWindow: undefined }, byName.fallback] });
    expect(unknownWindow.contextBudgetModel?.()).toBeUndefined();
  });

  it('compacts back onto the user model after one oversized round used the fallback model', async () => {
    const calls: Call[] = [];
    const session = new Session();
    seed(session, 4, 20000, 40000);
    let fetches = 0;
    const inlineAllowance: number[] = [];
    const fetch = { name: 'fetch', description: 'Fetch a page', inputSchema: { type: 'object' },
      async execute(_input: unknown, ctx: any) {
        inlineAllowance.push(ctx.state.toolResultInlineLedger.initialTokens);
        fetches++;
        return { content: (fetches === 1 ? 'h' : 'p').repeat(fetches === 1 ? 300000 : 8000) };
      } };
    const own = backend('own', calls, n => n < 3 ? fetchRound('own-model', `own-${n}`) : finished('own-model'));
    const fallback = backend('fallback', calls, n => n < 3 ? fetchRound('fallback-model', `fallback-${n}`) : finished('fallback-model'));
    const { runner } = harness(session, own, fallback, ['own', 'fallback'], [fetch]);
    const { events, error } = await drain(runner);
    expect(error).toBeUndefined();
    const main = mainCalls(calls);
    // The oversized latest round cannot be folded, so that one request moves.
    expect(main.map(call => call.who).slice(0, 2)).toEqual(['own', 'fallback']);
    // Once it is an older round, the next request is priced for the user's
    // window, compacted, and sent there.
    expect(main.filter(call => call.who === 'fallback')).toHaveLength(1);
    expect(main.at(-1)!.who).toBe('own');
    const afterOfficial = main[2];
    expect(afterOfficial.who).toBe('own');
    expect(JSON.stringify(afterOfficial.params.messages)).not.toContain('h'.repeat(300000));
    const budget = afterOfficial.params.requestMetadata!.contextBudgetDiagnostics as Record<string, unknown>;
    expect(budget.preparation_context_window).toBe(131072);
    // Result allowance still follows the model that answered; only the next
    // request's preparation moves back to the user's window.
    expect(inlineAllowance[1]).toBeGreaterThan(0);
  });

  it('keeps the user model when its responses report a different model id', async () => {
    const calls: Call[] = [];
    const session = new Session();
    seed(session, 6, 26000, 60000);
    session.setEstimatorCalibration(3, 4);
    const fetch = { name: 'fetch', description: 'Fetch a page', inputSchema: { type: 'object' },
      async execute() { return { content: 'p'.repeat(100000) }; } };
    const own = backend('own', calls, n => n === 0 ? fetchRound('own-model-2025-10', 'own-0', 30000) : finished('own-model-2025-10'));
    const fallback = backend('fallback', calls, () => finished('fallback-model'));
    const { runner } = harness(session, own, fallback, ['own', 'fallback'], [fetch]);
    const { events, error } = await drain(runner);
    expect(error).toBeUndefined();
    expect(calls.some(call => call.who === 'fallback')).toBe(false);
    expect(events.some(event => event.type === 'provider_fallback')).toBe(false);
  });

  it('prices the fallback window when the user model is out for this run', async () => {
    const calls: Call[] = [];
    const session = new Session();
    seed(session, 4, 26000, 40000);
    const fetch = { name: 'fetch', description: 'Fetch a page', inputSchema: { type: 'object' },
      async execute() { return { content: 'p'.repeat(150000) }; } };
    const throttled = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    const own = backend('own', calls, () => throttled());
    const fallback = backend('fallback', calls, n => n === 0 ? fetchRound('fallback-model', 'fallback-0') : finished('fallback-model'));
    const { runner } = harness(session, own, fallback, ['own', 'fallback'], [fetch]);
    const { events, error } = await drain(runner);
    expect(error).toBeUndefined();
    expect(mainCalls(calls).map(call => call.who)).toEqual(['own', 'fallback', 'fallback']);
    const budget = mainCalls(calls)[2].params.requestMetadata!.contextBudgetDiagnostics as Record<string, unknown>;
    expect(budget.preparation_context_window).toBe(272000);
    expect(budget.compaction_attempts ?? 0).toBe(0);
    expect(events.some(event => event.type === 'compaction')).toBe(false);
  });
  it('prepares again only once and then surfaces the original failure', async () => {
    let streams = 0;
    const repeating: LLMProvider = {
      id: 'repeat', name: 'repeat',
      async complete() { throw new Error('unused'); },
      async *stream() {
        streams++;
        throw new ProviderCandidateChangedError('fixture candidate changed', creditsExhausted());
      },
      async validateAuth() { return true; },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory('repeat', () => repeating);
    const runner = new AgentRunner({ session: new Session(), providers, tools: [],
      config: createConfig({ agent: { defaultProvider: 'repeat', defaultModel: 'repeat', maxRetries: 0 },
        evolution: { enabled: false } }) });
    const result = await runner.run({ message: 'Hello' });
    expect(streams).toBe(2);
    expect(result.meta.error?.code).toBe('fixture_candidate_changed');
  });
});

describe('summary first-event window through the real runner', () => {
  function silentForSummaries(who: Call['who'], calls: Call[]): LLMProvider {
    return {
      id: who, name: who,
      async complete() { throw new Error('unused'); },
      async *stream(params) {
        calls.push({ who, params });
        if (params.requestTokenEstimate) { yield* finished('own-model'); return; }
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => reject(params.signal?.reason), { once: true });
        });
      },
      async validateAuth() { return true; },
    };
  }

  async function run(withOfficial: boolean) {
    const calls: Call[] = [];
    const byName = candidates(silentForSummaries('own', calls),
      backend('fallback', calls, () => [{ type: 'text_delta', text: 'Summary' }, ...finished('fallback-model')]));
    const rotating = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: withOfficial ? [byName.own, byName.fallback] : [byName.own] });
    // Same runner path, with the 60s summary window shortened for the test.
    const provider: LLMProvider = { ...rotating, stream: params => rotating.stream(
      params.firstEventTimeoutMs ? { ...params, firstEventTimeoutMs: 20 } : params) };
    const providers = new ProviderRegistry();
    providers.registerFactory('custom', () => provider);
    const session = new Session();
    seed(session, 7, 40000, 2000);
    const runner = new AgentRunner({ session, providers, tools: [],
      config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'own-model' }, evolution: { enabled: false },
        models: { catalog: {
          'own-model': { provider: 'custom', model: 'own-model', contextWindow: 131072, maxOutputTokens: 32768 },
          'fallback-model': { provider: 'openai', model: 'fallback-model', contextWindow: 272000, maxOutputTokens: 32000 },
        } } }) });
    const { events, error } = await drain(runner);
    return { calls, events, error, main: calls.filter(call => call.params.requestTokenEstimate) };
  }

  it('answers on the only configured model after its summary misses the window', async () => {
    const { calls, events, error, main } = await run(false);
    expect(error).toBeUndefined();
    expect(events.find(event => event.type === 'done')?.result.text).toBe('Finished');
    expect(main.map(call => call.who)).toEqual(['own']);
    expect(events.some(event => event.type === 'context_status' && event.phase === 'active_process_compaction_failed')).toBe(true);
    expect(events.some(event => event.type === 'retry')).toBe(false);
    // Bounded by the runner's consecutive-failure limit, not by a latch.
    expect(calls.length - main.length).toBeLessThanOrEqual(3);
  });

  it('keeps the main request on the user model while the fallback model covers the summary', async () => {
    const { calls, events, error, main } = await run(true);
    expect(error).toBeUndefined();
    expect(calls.filter(call => !call.params.requestTokenEstimate).map(call => call.who).slice(0, 2)).toEqual(['own', 'fallback']);
    expect(main.map(call => call.who)).toEqual(['own']);
    // Public BYO candidates do not emit the commercial credits-purchase notice.
    // The real call history above proves the summary moved while the main call stayed.
    expect(events.filter(event => event.type === 'provider_fallback')).toEqual([]);
  });
});

