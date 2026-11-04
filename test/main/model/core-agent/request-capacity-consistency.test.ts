import { describe, expect, it } from 'vitest';
import {
  AgentRunner, createConfig, defineTool, ProviderRegistry, Session,
  estimateCompletionRequestInputTokens,
  type CompletionParams, type CompletionResult, type LLMProvider, type StreamEvent,
} from '#core-agent';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';

const window = 131072;
const output = 32768;
const ceiling = 80609;
const done: CompletionResult = {
  model: 'fixture', content: [{ type: 'text', text: 'Finished' }], stopReason: 'end_turn',
  usage: { inputTokens: 50000, outputTokens: 1, totalTokens: 50001 },
};
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function harness(session: Session, backend: LLMProvider, tools: ConstructorParameters<typeof AgentRunner>[0]['tools'] = []) {
  const prepared: CompletionParams[] = [];
  const failures: any[] = [];
  const rotating = createRotatingProvider({
    providerId: 'fixture', networkRetryAttempts: 0,
    candidates: [{ profileId: 'fixture', providerId: 'fixture', modelId: 'fixture',
      contextWindow: window, maxTokens: output, build: async () => backend }],
    onRequestFailure: failure => failures.push(failure),
  });
  const providers = new ProviderRegistry();
  providers.registerFactory('fixture', () => ({
    ...rotating,
    async *stream(params: CompletionParams) {
      prepared.push(params);
      yield* rotating.stream(params);
    },
  }));
  const runner = new AgentRunner({
    session, providers, tools,
    config: createConfig({
      agent: { defaultProvider: 'fixture', defaultModel: 'fixture', maxRetries: 0 },
      evolution: { enabled: false },
      models: { catalog: { fixture: { provider: 'fixture', model: 'fixture',
        contextWindow: window, maxOutputTokens: output } } },
    }),
  });
  return { runner, prepared, failures };
}
function backend(calls: CompletionParams[]): LLMProvider {
  return {
    id: 'fixture', name: 'Fixture',
    async complete(params) { calls.push(params); return done; },
    async *stream(params) {
      calls.push(params);
      yield { type: 'text_delta', text: 'Finished' };
      yield { type: 'message_end', ...done };
    },
    async validateAuth() { return true; },
  };
}

// A fitting task must survive preparation and public provider forwarding
// without losing receipts or adding compaction/retry calls. Release-side
// candidate capacity rejection is not enabled by the public provider policy.
describe('request capacity consistency', () => {
  it('remeasures changed thinking even when the request and block objects are reused', () => {
    const thinking = { type: 'thinking' as const, thinking: 't'.repeat(80000) };
    const request: CompletionParams = { model: 'fixture', messages: [{ role: 'assistant', content: [thinking] }] };
    const before = estimateCompletionRequestInputTokens(request);
    expect(before).toBeLessThan(ceiling);
    expect(estimateCompletionRequestInputTokens(request)).toBe(before);
    thinking.thinking = 't'.repeat(400000);
    expect(estimateCompletionRequestInputTokens(request)).toBeGreaterThan(ceiling);
  });

  it('sends a calibrated fitting request instead of rejecting the same prepared input', async () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'a'.repeat(332000) }]);
    session.setEstimatorCalibration(3, 4);
    const calls: CompletionParams[] = [];
    const { runner, prepared, failures } = harness(session, backend(calls));
    const events = await drain(runner.runStream({ message: 'Resume', resumeActiveTurn: true }));
    expect(prepared[0].requestMetadata?.contextBudgetDiagnostics).toMatchObject({ emergency_result: 'not_needed' });
    expect(events.find(event => event.type === 'done')?.result.meta.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(JSON.stringify(calls[0].messages)).toContain('a'.repeat(332000));
    expect(events.some(event => event.type === 'retry' || event.type === 'compaction')).toBe(false);
    expect((calls[0].requestMetadata!.contextBudgetDiagnostics as any).estimated_input_tokens)
      .toBe((prepared[0].requestMetadata!.contextBudgetDiagnostics as any).estimated_input_tokens);
  });

  it('uses reported usage after a tool round while retaining original thinking and the tool receipt', async () => {
    const calls: CompletionParams[] = [];
    const receipt = 'r'.repeat(14000);
    const thinking = 't'.repeat(60000);
    const realBackend = backend(calls);
    realBackend.stream = async function* (params): AsyncIterable<StreamEvent> {
      calls.push(params);
      if (calls.length === 1) {
        yield { type: 'message_end', model: 'fixture', stopReason: 'tool_use',
          usage: { inputTokens: 50000, outputTokens: 15000, totalTokens: 65000 },
          content: [{ type: 'thinking', thinking },
            { type: 'tool_use', id: 'read-once', name: 'inspect', input: {} }] };
      } else {
        yield { type: 'text_delta', text: 'Finished' };
        yield { type: 'message_end', ...done };
      }
    };
    let executions = 0;
    const tool = defineTool({ name: 'inspect', description: 'Read the next record', inputSchema: { type: 'object' },
      async execute() { executions++; return { content: receipt }; } });
    const { runner, prepared, failures } = harness(new Session(), realBackend, [tool]);
    const result = await runner.run({ message: 'a'.repeat(280000) });
    expect(result.meta.error).toBeUndefined();
    expect(result.text).toBe('Finished');
    expect(calls).toHaveLength(2);
    expect(executions).toBe(1);
    expect(failures).toEqual([]);
    expect(calls[1].messages.some(message => message.content.some(block => block.type === 'thinking' && block.thinking === thinking))).toBe(true);
    expect(JSON.stringify(calls[1].messages)).toContain(receipt);
    const preparedBudget = prepared[1].requestMetadata!.contextBudgetDiagnostics as any;
    const sentBudget = calls[1].requestMetadata!.contextBudgetDiagnostics as any;
    expect(preparedBudget.estimated_input_tokens).toBeLessThan(ceiling);
    expect(sentBudget.estimated_input_tokens).toBe(preparedBudget.estimated_input_tokens);
    expect(sentBudget.estimate_source).toBe('anchored');
  });

  it('includes retained thinking in preparation when no measured usage is available', async () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'a'.repeat(248000) }]);
    session.addAssistantMessage([{ type: 'thinking', thinking: 'b'.repeat(84000) }]);
    const calls: CompletionParams[] = [];
    const { runner, prepared, failures } = harness(session, backend(calls));
    const result = await runner.run({ message: 'Resume', resumeActiveTurn: true });
    expect(result.meta.error?.code).toBe('CONTEXT_CAPACITY_INSUFFICIENT');
    expect(calls).toHaveLength(0);
    expect(failures).toHaveLength(1);
    const preparation = prepared[0].requestMetadata!.contextBudgetDiagnostics as any;
    expect(preparation.estimated_input_tokens).toBeGreaterThan(ceiling);
    expect(preparation.emergency_result).toBe('nothing_to_drop');
    expect(failures[0].contextBudget.estimated_input_tokens).toBe(preparation.estimated_input_tokens);
  });

  it('prices the tools-off boundary control before deciding whether to reduce context', async () => {
    const calls: CompletionParams[] = [];
    const transport = backend(calls);
    transport.stream = async function* (params) {
      calls.push(params);
      yield calls.length === 1
        ? { type: 'message_end', model: 'fixture', stopReason: 'tool_use',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            content: [{ type: 'tool_use', id: 'boundary', name: 'check', input: {} }] }
        : { type: 'message_end', ...done };
    };
    const check = defineTool({ name: 'check', description: 'Check required input', inputSchema: { type: 'object' },
      async execute() { return { content: 'Awaiting required user input.', synthesizeAndEndTurn: true }; } });
    const { runner, prepared } = harness(new Session(), transport, [check]);
    expect((await runner.run({ message: 'Check and report the result', turnEphemeral: 'Current task constraints' })).meta.error).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1].tools).toBeUndefined();
    expect(calls[1].messages.some(message => message.role === 'developer')).toBe(true);
    const budget = prepared[1].requestMetadata!.contextBudgetDiagnostics as any;
    expect(budget.emergency_before_tokens).toBe(Math.round(estimateCompletionRequestInputTokens(calls[1])));
    expect(budget.estimated_input_tokens).toBe(budget.emergency_before_tokens);
  });

  it('recomputes the measured request after a checkpoint and preserves the latest tool receipt', async () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'a'.repeat(140000) }]);
    for (let i = 0; i < 8; i++) {
      session.addAssistantMessage([{ type: 'tool_use', id: `old-${i}`, name: 'inspect', input: {} }]);
      session.addToolResult(`old-${i}`, 'r'.repeat(30000));
    }
    session.setEstimatorCalibration(3, 4);
    const calls: CompletionParams[] = [];
    const { runner, prepared, failures } = harness(session, backend(calls));
    const result = await runner.run({ message: 'Resume', resumeActiveTurn: true });
    expect(result.meta.error).toBeUndefined();
    const main = prepared.filter(request => request.requestMetadata?.contextBudgetDiagnostics);
    expect(main).toHaveLength(1);
    const before = main[0].requestMetadata!.contextBudgetDiagnostics as any;
    expect(before.compaction_attempts).toBeGreaterThan(0);
    expect(before.compaction_after_tokens).toBeLessThan(before.compaction_before_tokens);
    // The final call is the main inference after the checkpoint completed;
    // compare its prepared budget and retained receipt.
    const sent = calls.at(-1)!;
    expect((sent.requestMetadata!.contextBudgetDiagnostics as any).estimated_input_tokens).toBe(before.emergency_after_tokens);
    expect(JSON.stringify(sent.messages)).toContain('old-7');
    expect(failures).toEqual([]);
  });

  it.each(['stream', 'complete'] as const)('preserves unchanged cloned prepared request calibration in %s', async mode => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'a'.repeat(332000) }]);
    session.setEstimatorCalibration(3, 4);
    const calls: CompletionParams[] = [];
    const { runner } = harness(session, backend(calls));
    expect((await runner.run({ message: 'Resume', resumeActiveTurn: true })).meta.error).toBeUndefined();
    const request = calls[0];
    // A request snapshot is data, so request-recording providers can clone it.
    // Both public APIs must still forward this unchanged, calibrated request.
    const { signal: _signal, onRequestFailure: _observer, ...cloneable } = request;
    const cloned = structuredClone(cloneable);
    const unchangedCalls: CompletionParams[] = [];
    const unchanged = createRotatingProvider({ providerId: 'fixture', candidates: [{
      profileId: 'fixture', providerId: 'fixture', modelId: 'fixture',
      contextWindow: window, maxTokens: output, build: async () => backend(unchangedCalls),
    }] });
    await (mode === 'stream' ? drain(unchanged.stream(cloned)) : unchanged.complete(cloned));
    expect(unchangedCalls).toHaveLength(1);
    expect((unchangedCalls[0].requestMetadata!.contextBudgetDiagnostics as any).estimated_input_tokens)
      .toBe((request.requestMetadata!.contextBudgetDiagnostics as any).estimated_input_tokens);
    for (const change of ['model', 'provider', 'output', 'messages', 'system', 'tools', 'image_projection']) {
      const downstream: CompletionParams[] = [];
      // The first available candidate is the one preparation priced, whatever
      // its provider; a foreign provider behind it still estimates afresh.
      const priced = change === 'provider' ? [{ profileId: 'priced', providerId: 'fixture', modelId: 'smaller',
        contextWindow: 32000, maxTokens: 8192, build: async () => backend(downstream) }] : [];
      const provider = createRotatingProvider({ providerId: 'fixture', candidates: [...priced, {
        profileId: 'other', providerId: change === 'provider' ? 'foreign' : 'fixture',
        modelId: change === 'model' ? 'smaller' : 'fixture',
        contextWindow: change === 'model' ? 32000 : window,
        maxTokens: change === 'output' ? 110000 : change === 'model' ? 8192 : output,
        ...(change === 'image_projection' ? { maxInputImages: 0 } : {}),
        build: async () => backend(downstream),
      }] });
      const changed = { ...request };
      if (change === 'messages') changed.messages = [...request.messages, { role: 'user', content: [{ type: 'text', text: 'x'.repeat(200000) }] }];
      if (change === 'system') changed.systemPrompt = (request.systemPrompt || '') + 'x'.repeat(200000);
      if (change === 'tools') changed.tools = [{ name: 'large', description: 'x'.repeat(200000), inputSchema: {} }];
      if (change === 'image_projection') changed.messages = [...request.messages, { role: 'user', content: [{ type: 'image', data: 'synthetic', mediaType: 'image/png' }] }];
      const invoke = () => mode === 'stream' ? drain(provider.stream(changed)) : provider.complete(changed);
      await expect(invoke()).rejects.toMatchObject({ code: 'CONTEXT_OVERFLOW' });
      expect(downstream).toEqual([]);
    }
  });
});
