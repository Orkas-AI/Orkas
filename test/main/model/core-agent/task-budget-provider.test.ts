import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, ProviderRegistry, createConfig, defineTool } from '#core-agent';
import type { LLMProvider, CompletionParams, StreamEvent } from '#core-agent';
import { withTaskBudget } from '../../../../src/main/model/core-agent/task-budget-provider';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';
import { taskTokens, resetTaskTokens } from '../../../../src/main/util/conversation-cost-meter';
import { mapCoreAgentEvents } from '../../../../src/main/model/core-agent/event-mapper';
import { t } from '../../../../src/main/i18n';

const cid = 'budget-fixture';
const request: CompletionParams = { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }] };
const usage = { inputTokens: 400, outputTokens: 100, totalTokens: 900, cacheReadTokens: 400 };
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function provider(events?: StreamEvent[]): LLMProvider {
  return {
    id: 'fixture', name: 'Fixture', validateAuth: async () => true,
    complete: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], model: 'fixture', stopReason: 'end_turn' as const, usage })),
    stream: vi.fn(async function* () {
      yield* events ?? [{ type: 'text_delta', text: 'done' }, { type: 'message_end', stopReason: 'end_turn', model: 'fixture', usage }];
    }),
  };
}
beforeEach(() => { vi.stubEnv('ORKAS_MAX_TASK_TOKENS', '500'); resetTaskTokens(cid); resetTaskTokens('other'); });
afterEach(() => { vi.unstubAllEnvs(); resetTaskTokens(cid); resetTaskTokens('other'); });

describe('per-request task token backstop', () => {
  it('counts only input/output once, blocks the next request and permits a fresh user allowance', async () => {
    const raw = provider();
    const guarded = withTaskBudget(raw, cid);
    expect(await collect(guarded.stream(request))).toHaveLength(2);
    expect(taskTokens(cid)).toBe(500);
    await expect(guarded.complete(request)).rejects.toMatchObject({ code: 'TASK_TOKEN_LIMIT_REACHED' });
    await expect(collect(guarded.stream(request))).rejects.toMatchObject({ code: 'TASK_TOKEN_LIMIT_REACHED' });
    expect(raw.stream).toHaveBeenCalledTimes(1);
    expect(raw.complete).not.toHaveBeenCalled();
    await withTaskBudget(raw, 'other').complete(request);
    resetTaskTokens(cid);
    await guarded.complete(request);
    expect(taskTokens(cid)).toBe(500);
    expect(taskTokens('other')).toBe(500);
  });

  it('keeps the final usage snapshot even if a stream fails after reporting it', async () => {
    const raw = provider();
    raw.stream = async function* () {
      yield { type: 'message_end', model: 'fixture', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      yield { type: 'message_end', model: 'fixture', stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 } };
      throw new Error('fixture disconnect');
    };
    await expect(collect(withTaskBudget(raw, cid).stream(request))).rejects.toThrow('fixture disconnect');
    expect(taskTokens(cid)).toBe(230);
  });

  it('allows both already-issued parallel calls to settle and refuses later work', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const raw = provider();
    const complete = raw.complete;
    raw.complete = vi.fn(async params => { await ready; expect(params.signal?.aborted).not.toBe(true); return complete(params); });
    const guarded = withTaskBudget(raw, cid);
    const pending = [guarded.complete(request), guarded.complete(request)];
    expect(raw.complete).toHaveBeenCalledTimes(2);
    release();
    expect(await Promise.all(pending)).toHaveLength(2);
    expect(taskTokens(cid)).toBe(1000);
    await expect(guarded.complete(request)).rejects.toMatchObject({ code: 'TASK_TOKEN_LIMIT_REACHED' });
    expect(raw.complete).toHaveBeenCalledTimes(2);
  });

  it('retains disabled and unscoped behavior', async () => {
    const raw = provider();
    expect(withTaskBudget(raw)).toBe(raw);
    vi.stubEnv('ORKAS_MAX_TASK_TOKENS', '0');
    const guarded = withTaskBudget(raw, cid);
    await guarded.complete(request);
    await guarded.complete(request);
    expect(raw.complete).toHaveBeenCalledTimes(2);
  });

  it('counts terminal empty usage before rotation can issue an automatic retry', async () => {
    const raw = provider([{ type: 'message_end', model: 'fixture', stopReason: 'end_turn', providerTermination: { category: 'normal' }, usage }]);
    const fallback = vi.fn(async () => provider());
    const rotated = createRotatingProvider({ providerId: 'fixture', candidates: [
      { profileId: 'first', providerId: 'fixture', modelId: 'fixture', build: async () => withTaskBudget(raw, cid) },
      { profileId: 'second', providerId: 'fixture', modelId: 'fixture', build: fallback },
    ] });
    await expect(collect(rotated.stream(request))).rejects.toMatchObject({ code: 'TASK_TOKEN_LIMIT_REACHED' });
    expect(raw.stream).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(taskTokens(cid)).toBe(500);
  });

  it('ends a real tool loop with the existing user notice, without another provider request', async () => {
    const raw = provider([{ type: 'message_end', model: 'fixture', stopReason: 'tool_use', usage,
      content: [{ type: 'tool_use', id: 'read-1', name: 'read_fixture', input: {} }] }]);
    const registry = new ProviderRegistry();
    registry.registerFactory('fixture', () => withTaskBudget(raw, cid));
    const execute = vi.fn(async () => ({ content: 'inspected' }));
    const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'fixture', defaultModel: 'fixture' } }),
      providers: registry, tools: [defineTool({ name: 'read_fixture', description: 'Read a fixture', inputSchema: { type: 'object' }, execute })] });
    const events = await collect(mapCoreAgentEvents(runner.runStream({ message: 'Inspect the fixture and explain it' }), { failureTrackingScope: {} }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(raw.stream).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'retry')).toEqual([]);
    expect(events.find(event => event.type === 'error')).toMatchObject({ text: t('chat.cost_limit_reached'),
      failureKind: 'model', failureCode: 'task_token_limit_reached', retryExhausted: true });
    expect(taskTokens(cid)).toBe(500);
  });
});
