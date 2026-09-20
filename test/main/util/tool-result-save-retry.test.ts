import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
import os from 'node:os';
import path from 'node:path';
import { capToolResultWithRetry, ToolResultPersistenceError, wrapToolWithCap } from '../../../src/main/util/tool-result-cap';
import { AgentRunner } from '../../../src/core-agent/src/agent/runner';
import { PersistentSession } from '../../../src/core-agent/src/agent/persistent-session';
import { createConfig } from '../../../src/core-agent/src/config/loader';
import { ProviderRegistry } from '../../../src/core-agent/src/providers/registry';
import { isRetryableError } from '../../../src/core-agent/src/shared/errors';
import type { AgentTool, ToolResult } from '../../../src/core-agent/src/tools/base';
import type { CompletionResult } from '../../../src/core-agent/src/providers/base';
import type { AgentRunEvent } from '../../../src/core-agent/src/agent/types';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-result-retry-')); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const body = 'full result 界\n'.repeat(10_000);
const fault = () => Object.assign(new Error('/private/path: disk failure'), { code: 'ENOSPC' });
function saveFaults(store: string, failCount: number) {
  const mkdir = fs.mkdirSync;
  let attempts = 0;
  const times: number[] = [];
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options: any) => {
    if (String(target) === store) {
      attempts++; times.push(Date.now());
      if (attempts <= failCount) throw fault();
    }
    return mkdir(target, options);
  }) as typeof fs.mkdirSync);
  return { attempts: () => attempts, times };
}
function tool(name: string, execute: AgentTool['execute'], parallel = false): AgentTool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} },
    ...(parallel ? { executionMode: 'parallel' as const } : {}), execute };
}

describe('tool result storage retries', () => {
  it.each([false, true])('saves exact original output after transient failure without re-executing (streamed=%s)', async streamed => {
    const store = path.join(root, 'results'); fs.mkdirSync(store);
    const spool = path.join(store, '.spool');
    if (streamed) fs.writeFileSync(spool, body);
    const save = saveFaults(store, 3);
    vi.useFakeTimers();
    const original: ToolResult = { content: streamed ? 'preview' : body, isError: true,
      ...(streamed ? { streamedOutput: { path: spool, size: Buffer.byteLength(body) } } : {}) };
    const execute = vi.fn(async () => original);
    const wrapped = wrapToolWithCap(tool('read', execute), { toolResultsDir: store, maxInlineTokens: 10_000 });
    const pending = wrapped.execute({}, { state: {} });
    await vi.advanceTimersByTimeAsync(0); expect(save.attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(199); expect(save.attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(save.attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); expect(save.attempts()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    expect(save.attempts()).toBe(4);
    expect(save.times.map(time => time - save.times[0])).toEqual([0, 200, 1_200, 4_200]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.streamedOutput).toBeUndefined();
    expect(fs.readFileSync(result.persistedOutput!.path, 'utf8')).toBe(body);
    expect(original.content).toBe(streamed ? 'preview' : body);
  });

  it.each([false, true])('fails closed after four storage attempts (streamed=%s)', async streamed => {
    const store = path.join(root, 'results'); fs.mkdirSync(store);
    const spool = path.join(store, '.spool');
    if (streamed) fs.writeFileSync(spool, body);
    const save = saveFaults(store, Infinity);
    vi.useFakeTimers();
    const pending = capToolResultWithRetry('read', { content: body,
      ...(streamed ? { streamedOutput: { path: spool, size: Buffer.byteLength(body) } } : {}) },
    { state: {} }, { toolResultsDir: store, maxInlineTokens: 10_000 }).catch(err => err);
    await vi.advanceTimersByTimeAsync(4_200);
    const error = await pending;
    expect(error).toBeInstanceOf(ToolResultPersistenceError);
    expect(save.attempts()).toBe(4);
    expect(String(error)).not.toContain('/private/path');
    expect(isRetryableError(error)).toBe(false);
    if (streamed) expect(fs.readFileSync(spool, 'utf8')).toBe(body);
  });

  it('cancels backoff promptly without another write or timer', async () => {
    const store = path.join(root, 'results');
    const save = saveFaults(store, Infinity);
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = capToolResultWithRetry('read', { content: body }, { state: {}, signal: abort.signal },
      { toolResultsDir: store, maxInlineTokens: 10_000 }).catch(err => err);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    expect((await pending).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save.attempts()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never adopts a partial destination left by a failed cross-device copy', async () => {
    const store = path.join(root, 'results'); fs.mkdirSync(store);
    const spool = path.join(store, '.spool'); fs.writeFileSync(spool, body);
    const rename = fs.renameSync; const copy = fs.copyFileSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === fs.realpathSync(spool)) throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
      rename(from, to);
    });
    let copies = 0;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      if (++copies === 1) { fs.writeFileSync(to, 'partial'); throw fault(); }
      copy(from, to, mode);
    });
    vi.useFakeTimers();
    const pending = capToolResultWithRetry('read', { content: 'preview', streamedOutput: { path: spool, size: Buffer.byteLength(body) } },
      { state: {} }, { toolResultsDir: store, maxInlineTokens: 10_000 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(fs.readFileSync(result.persistedOutput!.path, 'utf8')).toBe(body);
    expect(copies).toBe(2);
    expect(fs.existsSync(spool)).toBe(false);
    expect(fs.readdirSync(store)).toEqual([path.basename(result.persistedOutput!.path)]);
  });

  it('adds no retry timers to the normal inline or persisted path', async () => {
    vi.useFakeTimers();
    const opts = { toolResultsDir: path.join(root, 'results'), maxInlineTokens: 10_000 };
    const small = { content: 'small' };
    expect(await capToolResultWithRetry('read', small, { state: {} }, opts)).toBe(small);
    expect((await capToolResultWithRetry('read', { content: body }, { state: {} }, opts)).persistedOutput).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function buildRunner(tools: AgentTool[], calls: string[], store: string, session: PersistentSession) {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  let requests = 0;
  const responses: CompletionResult[] = [
    { model: 'mock-model', usage, stopReason: 'tool_use', content: calls.map((name, i) => ({ type: 'tool_use', id: `call-${i}`, name, input: {} })) },
    { model: 'mock-model', usage, stopReason: 'end_turn', content: [{ type: 'text', text: 'finished' }] },
  ];
  const registry = new ProviderRegistry();
  registry.registerFactory('mock', () => ({ id: 'mock', name: 'Mock',
    async complete() { return responses[Math.min(requests++, 1)]; }, async validateAuth() { return true; },
    async *stream() {
      const result = responses[Math.min(requests++, 1)];
      yield { type: 'message_start' as const };
      yield { type: 'message_end' as const, ...result };
    },
  }));
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model' } }),
    providers: registry, session, tools, evolution: { enabled: false },
    transformToolResult: (name, result, ctx) => capToolResultWithRetry(name, result, ctx, { toolResultsDir: store, maxInlineTokens: 10_000 }),
  });
  return { runner, requests: () => requests };
}
async function collect(runner: AgentRunner, signal?: AbortSignal) {
  const events: AgentRunEvent[] = [];
  for await (const event of runner.runStream({ message: 'perform the operations', signal })) events.push(event);
  return events;
}

describe('result storage failure through the runner', () => {
  it.each([false, true])('stops queued work, preserves executed facts and protocol across reload (parallel=%s)', async parallel => {
    vi.stubEnv('ORKAS_MAX_TOOL_CONCURRENCY', '2');
    const store = path.join(root, 'results');
    const sessionFile = path.join(root, 'session.jsonl');
    const session = new PersistentSession({ sessionFile });
    const observedPath = path.join(root, 'effect.txt');
    const executed: string[] = [];
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>(resolve => { releaseSibling = resolve; });
    const tools = [
      tool('first', async () => {
        executed.push('first'); fs.writeFileSync(observedPath, 'created once');
        return { content: body, observations: { fileChanges: [{ operation: 'create', sourcePath: observedPath, beforeExists: false, afterExists: true, afterHash: 'created', coverage: 'exact' }] } };
      }, parallel),
      tool('sibling', async () => { executed.push('sibling'); await siblingGate; return { content: 'sibling complete' }; }, parallel),
      tool('queued', async () => { executed.push('queued'); return { content: 'queued complete' }; }, parallel),
      tool('barrier', async () => { executed.push('barrier'); return { content: 'barrier complete' }; }),
    ];
    const run = buildRunner(tools, tools.map(t => t.name), store, session);
    const saves = saveFaults(store, Infinity);
    vi.useFakeTimers();
    const pending = collect(run.runner);
    await vi.waitFor(() => expect(executed.length).toBe(parallel ? 2 : 1), { interval: 1 });
    expect(executed).toEqual(parallel ? ['first', 'sibling'] : ['first']);
    // Another task can finish while the failed task is sleeping in backoff.
    const otherSession = new PersistentSession({ sessionFile: path.join(root, 'other.jsonl') });
    const other = buildRunner([tool('other', async () => ({ content: 'okay' }))], ['other'], path.join(root, 'other-store'), otherSession);
    expect((await other.runner.run({ message: 'other task' })).text).toBe('finished');
    await vi.advanceTimersByTimeAsync(4_200);
    expect(executed).toEqual(parallel ? ['first', 'sibling'] : ['first']);
    releaseSibling();
    const events = await pending;
    expect(saves.attempts()).toBe(4);
    expect(run.requests()).toBe(1);
    expect(events.filter(e => e.type === 'retry')).toHaveLength(0);
    const done = events.filter(e => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0].result.meta.error).toMatchObject({ kind: 'storage', code: 'TOOL_RESULT_PERSISTENCE_FAILED' });
    const ends = events.filter(e => e.type === 'tool_end');
    expect(ends).toHaveLength(4);
    expect(ends.find(e => e.name === 'first')?.result).toContain('tool executed');
    expect(ends.find(e => e.name === 'first')?.result).not.toContain(body);
    const reloaded = new PersistentSession({ sessionFile });
    const ledger = reloaded.getCompletedWorkLedger();
    expect(ledger.map(e => e.status)).toEqual(parallel ? ['failed', 'succeeded', 'skipped', 'skipped'] : ['failed', 'skipped', 'skipped', 'skipped']);
    expect(fs.readFileSync(observedPath, 'utf8')).toBe('created once');
    const state = JSON.stringify(reloaded.getSerializedContextState());
    expect(state).toContain(JSON.stringify(observedPath));
    const transcript = reloaded.getMessages();
    const results = transcript.flatMap(m => typeof m.content === 'string' ? [] : m.content).filter(c => c.type === 'tool_result');
    expect(results.map(r => r.toolUseId)).toEqual(['call-0', 'call-1', 'call-2', 'call-3']);
  });

  it('ends reflection on exhausted result saving without another model call', async () => {
    const store = path.join(root, 'results');
    const session = new PersistentSession({ sessionFile: path.join(root, 'session.jsonl') });
    const execute = vi.fn(async () => ({ content: body }));
    const run = buildRunner([tool('first', execute)], ['first'], store, session);
    const save = saveFaults(store, Infinity); vi.useFakeTimers();
    const onFailure = vi.fn();
    const pending = run.runner.runReflection('review', undefined, undefined, undefined, undefined, onFailure);
    await vi.waitFor(() => expect(save.attempts()).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(4_200);
    expect(await pending).toBe('');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.requests()).toBe(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('stops promptly when cancelled during result saving and retains executed observations', async () => {
    const store = path.join(root, 'results');
    const session = new PersistentSession({ sessionFile: path.join(root, 'session.jsonl') });
    const execute = vi.fn(async () => ({ content: body, observations: { fileChanges: [{
      operation: 'create' as const, sourcePath: path.join(root, 'effect.txt'), beforeExists: false, afterExists: true,
    }] } }));
    const run = buildRunner([tool('first', execute)], ['first'], store, session);
    const save = saveFaults(store, Infinity); vi.useFakeTimers();
    const abort = new AbortController();
    const pending = collect(run.runner, abort.signal);
    await vi.waitFor(() => expect(save.attempts()).toBe(1), { interval: 1 });
    abort.abort();
    const events = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.type === 'done')[0].result.meta.error?.code).toBe('ABORT_ERR');
    expect(session.getWorkspaceObservations().entries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save.attempts()).toBe(1);
  });

  it('continues after transient storage failure with no repeated operation or model error', async () => {
    const store = path.join(root, 'results');
    const session = new PersistentSession({ sessionFile: path.join(root, 'session.jsonl') });
    const execute = vi.fn(async () => ({ content: body }));
    const run = buildRunner([tool('first', execute)], ['first'], store, session);
    const save = saveFaults(store, 1); vi.useFakeTimers();
    const pending = collect(run.runner);
    await vi.waitFor(() => expect(save.attempts()).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(200);
    const events = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.requests()).toBe(2);
    expect(events.filter(e => e.type === 'done')[0].result.meta.error).toBeUndefined();
    expect(session.getCompletedWorkLedger()[0].resultRef).toMatch(/^first\./);
  });
});
