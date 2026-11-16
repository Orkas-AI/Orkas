import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expectTestLog } from '../../../helpers/test-log-analysis';
import { AgentRunner } from '../../../../src/core-agent/src/agent/runner';
import { createConfig } from '../../../../src/core-agent/src/config/loader';
import { ProviderRegistry } from '../../../../src/core-agent/src/providers/registry';
import type { CompletionParams, CompletionResult, LLMProvider } from '../../../../src/core-agent/src/providers/base';
import type { AgentTool, ToolContext, ToolResult } from '../../../../src/core-agent/src/tools/base';
import type { ToolUseCall } from '../../../../src/core-agent/src/shared/types';
import { projectToolInput, appendInputReceipt } from '../../../../bin/tool-input-compat.cjs';
import { createLocalTools } from '../../../../src/main/model/core-agent/local-tools';
import { startInteractiveCliSession, closeInteractiveCliSession, readInteractiveCliSession } from '../../../../src/main/model/core-agent/interactive-cli-sessions';
import { processSessionTool } from '../../../../src/core-agent/src/tools/process-session';
import { createProjectTasksTool } from '../../../../src/core-agent/src/tools/project-tasks-tool';
import { createAutoTasksTool } from '../../../../src/main/features/auto_tasks_tool';

import { createToolResultTools } from '../../../../src/main/model/core-agent/tool-result-tools';
import { capToolResult, persistToolResult, toolResultRefForPath, estimateToolResultTokens, wrapToolWithCap } from '../../../../src/main/util/tool-result-cap';

function setup(tools: AgentTool[], calls: ToolUseCall[], programmatic = false, transformToolResult?: (name: string, result: ToolResult, ctx: ToolContext) => Promise<ToolResult>) {
  const requests: CompletionParams[] = [];
  let round = 0;
  const complete = async (params: CompletionParams): Promise<CompletionResult> => {
    requests.push(structuredClone(params));
    return { content: round++ === 0 ? calls : [{ type: 'text', text: 'done' }],
      stopReason: round === 1 ? 'tool_use' : 'end_turn', model: 'fixture',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  };
  const provider: LLMProvider = { id: 'fixture', name: 'Fixture', complete,
    async *stream(params) { const result = await complete(params); yield { type: 'message_end', ...result }; },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory('fixture', () => provider);
  const runner = new AgentRunner({ tools, providers, transformToolResult,
    config: createConfig({ agent: { defaultProvider: 'fixture', defaultModel: 'fixture' } }),
    ...(programmatic ? { programmaticToolPolicy: { isEligible: (name: string) => name === 'store', authorize: () => ({ allowed: true as const }) } } : {}),
  });
  return { runner, requests, async run() {
    const events = [];
    for await (const event of runner.runStream({ message: 'Complete the fixture operation.' })) events.push(event);
    return events.filter((e: any) => e.type === 'tool_end') as any[];
  } };
}
const call = (name: string, input: Record<string, unknown>, id = 'call'): ToolUseCall => ({ type: 'tool_use', id, name, input });
const extras = { future_option: 'PRIVATE_VALUE' };

describe('uniform model tool argument compatibility', () => {
  it('keeps a failed process stdout quotation out of parameter-error classification', async () => {
    const source = 'E_BAD_INPUT: quoted command output';
    const tool: AgentTool = { name: 'store', description: 'Fixture', inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content: source, isError: true, observations: { execution: {
        status: 'failed', exitCode: 1, durationMs: 1, timedOut: false, outputLimitExceeded: false,
        stdout: { bytes: source.length, truncated: false }, stderr: { bytes: 0, truncated: false },
      } } }) };
    const [event] = await setup([tool], [call('store', {})]).run();
    expect(event.result).toBe(source);
    expect(event.isError).toBe(true);
  });
  it.each(['sequential', 'parallel', 'programmatic', 'reflection'] as const)('formats only final parameter refusals in the %s lane without replay', async lane => {
    const execute = vi.fn(async () => ({ content: 'E_BAD_INPUT: content must be a string', isError: true }));
    const tool: AgentTool = { name: 'store', description: 'Fixture', executionMode: lane === 'parallel' ? 'parallel' : 'sequential',
      inputSchema: { type: 'object', properties: { content: {} } }, execute };
    const count = lane === 'parallel' ? 2 : 1;
    const calls = lane === 'programmatic'
      ? [call('run_program', { code: 'json(await tools.store({content: 4}));' })]
      : Array.from({ length: count }, (_, index) => call('store', { content: 4, ...extras }, `rejected-${index}`));
    const run = setup([tool], calls, lane === 'programmatic');
    if (lane === 'reflection') await run.runner.runReflection('Review fixture');
    else await run.run();
    const replies = run.requests[1].messages.flatMap(m => m.content).filter(c => c.type === 'tool_result') as any[];
    // Program output contains a serialized child result, not a second tool-error envelope.
    expect(replies).toHaveLength(count);
    for (const reply of replies) {
      expect(reply.content).toContain('invalid_arguments');
      expect(reply.content).toContain('expected');
      expect(reply.content).toContain('content must be a string');
      expect(reply.content).not.toContain('PRIVATE_VALUE');
    }
    expect(execute).toHaveBeenCalledTimes(count);
  });
  it.each(['sequential', 'parallel', 'programmatic', 'reflection'] as const)('executes exactly once per %s call with only declared arguments and reports ignored names', async lane => {
    const execute = vi.fn(async () => ({ content: '{"saved":true}', observations: { coordination: { changed: true } } }));
    const tool: AgentTool = { name: 'store', description: 'Save a fixture', executionMode: lane === 'parallel' ? 'parallel' : 'sequential',
      inputSchema: { type: 'object', properties: { content: { type: 'string' }, args: { type: 'object', additionalProperties: true } }, additionalProperties: false }, execute };
    const input = { content: 'new', args: { vendor_option: 42 }, ...extras };
    const count = lane === 'parallel' ? 2 : 1;
    const calls = lane === 'programmatic'
      ? [call('run_program', { code: `json(await tools.store(${JSON.stringify(input)}));`, ...extras })]
      : Array.from({ length: count }, (_, i) => call('store', input, `call-${i}`));
    const run = setup([tool], calls, lane === 'programmatic');
    if (lane === 'reflection') expect(await run.runner.runReflection('Review fixture')).toBe('done');
    else await run.run();
    expect(execute).toHaveBeenCalledTimes(count);
    for (const args of execute.mock.calls as any[]) expect(args[0]).toEqual({ content: 'new', args: { vendor_option: 42 } });
    const receipts = run.requests[1].messages.flatMap(m => m.content).filter(c => c.type === 'tool_result');
    expect(receipts).toHaveLength(lane === 'programmatic' ? 1 : count);
    for (const receipt of receipts as any[]) {
      expect(receipt.content).toContain('ignored_fields');
      expect(receipt.content).toContain('future_option');
      expect(receipt.content).toContain('saved');
      expect(receipt.content).not.toContain('PRIVATE_VALUE');
    }
    expect(input.future_option).toBe('PRIVATE_VALUE'); // No transcript mutation.
  });

  it('reads the real interactive session despite the sampled unsupported wait argument', async () => {
    const uid = 'input-compat-fixture';
    const started = startInteractiveCliSession({ uid, cid: 'fixture', command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], sandboxEnv: { ELECTRON_RUN_AS_NODE: '1' } });
    try {
      await expect.poll(() => readInteractiveCliSession(uid, started.session_id).output, { timeout: 5000 }).toContain('ready');
      const interactive = createLocalTools({ userId: uid, cid: 'fixture' }).find(t => t.name === 'interactive_cli')!;
      const [event] = await setup([interactive], [call('interactive_cli', { action: 'read', session_id: started.session_id, yield_time_ms: 500 })]).run();
      expect(event.isError).toBeFalsy();
      expect(JSON.parse(event.result)).toMatchObject({ session_id: started.session_id, status: 'running', output: 'ready\n', ignored_fields: ['yield_time_ms'] });
    } finally { closeInteractiveCliSession(uid, started.session_id); }
  });

  it.each(['returned', 'thrown'] as const)('preserves %s failure and discloses extras without replay', async mode => {
    // A thrown tool failure is logged by name and class only, never its message.
    if (mode === 'thrown') {
      expectTestLog({ level: 'warn', source: 'console', message: /^\[agent-runner\] Tool store failed \(transient\); details withheld$/ });
    }
    const execute = vi.fn(async () => {
      if (mode === 'thrown') throw new Error('fixture unavailable');
      return { content: '{"error":"required content"}', isError: true };
    });
    const tool: AgentTool = { name: 'store', description: 'Fixture', inputSchema: { type: 'object', properties: {} }, execute };
    const [event] = await setup([tool], [call('store', extras)]).run();
    expect(event.isError).toBe(true);
    expect(event.result).toContain('ignored_fields');
    expect(event.result).not.toContain('PRIVATE_VALUE');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retains known critical scope and action conflicts before effects', async () => {
    const mutate = vi.fn(async () => ({ ok: true }));
    const tasks = createProjectTasksTool({ list: mutate, get: mutate, create: mutate, update: mutate, complete: mutate } as any);
    const automation = createAutoTasksTool({ userId: 'fixture', projectId: 'bound' });
    const cases = [call('todo_tasks', { action: 'create', project: 'foreign', content: 'never', ...extras }, 'scope'),
      call('todo_tasks', { action: 'complete', task_id: 'id', status: 'todo', ...extras }, 'status'),
      call('auto_tasks', { action: 'update', task_id: 'at_12345678', project_id: null, title: 'never', ...extras }, 'automation')];
    const events = await setup([tasks, automation], cases).run();
    expect(events).toHaveLength(3);
    expect(events.every(e => e.isError && e.result.includes('ignored_fields'))).toBe(true);
    expect(events[0].result).toContain('project_scope_mismatch');
    expect(events[1].result).toContain('complete conflicts');
    expect(events[2].result).toContain('project_id');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('budgets the receipt with real retrieval without charging twice, spilling, or losing the source cursor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-input-retrieval-'));
    try {
      const source = '界'.repeat(15_000);
      const ref = toolResultRefForPath(persistToolResult(dir, 'fixture', source));
      const before = fs.readdirSync(dir);
      const tools = createToolResultTools({ toolResultsDir: dir, isProgrammaticToolCallContext: () => false });
      const snapshots: number[] = [];
      // Capture actual runner accounting on both sides of final admission.
      const transform = async (name: string, result: ToolResult, ctx: ToolContext) => {
        const ledger = ctx.state.toolResultInlineLedger as { remainingTokens: number };
        snapshots.push(ledger.remainingTokens);
        const final = capToolResult(name, result, ctx, { maxInlineTokens: 10_000, toolResultsDir: dir });
        snapshots.push(ledger.remainingTokens);
        return final;
      };
      const [event] = await setup(tools, [call('tool_result', { action: 'read', requests: [{ ref, cursor: 0 }], ...extras })], false, transform).run();
      expect(event.isError).toBeFalsy();
      expect(event.persistedOutput).toBeUndefined();
      expect(event.result).toContain('future_option');
      expect(event.result).not.toContain('PRIVATE_VALUE');
      expect(estimateToolResultTokens(event.result)).toBeLessThanOrEqual(10_000);
      expect(estimateToolResultTokens(event.result)).toBeGreaterThan(8_000);
      expect(snapshots[1]).toBe(snapshots[0]);
      expect(fs.readdirSync(dir)).toEqual(before);
      const cursor = Number(/next_cursor="(\d+)"/.exec(event.result)?.[1]);
      expect(cursor).toBeGreaterThan(0);
      expect(event.result).toContain(source.slice(0, cursor));
      expect(event.result).not.toContain(source.slice(0, cursor + 1));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains legacy session arguments for their owning validator', async () => {
    const execute = vi.fn(async (input) => ({ content: JSON.stringify(input) }));
    const tool = wrapToolWithCap({ ...processSessionTool, execute }, { maxInlineTokens: 1000, toolResultsDir: os.tmpdir() });
    const input = { action: 'start', command: 'fixture command', ...extras };
    const [event] = await setup([tool], [call('process_session', input)]).run();
    expect(execute.mock.calls[0][0]).toEqual({ action: 'start', command: 'fixture command' });
    expect(JSON.parse(event.result)).toMatchObject({ command: 'fixture command', ignored_fields: ['future_option'] });
  });

  it('preserves nested constraints, arbitrary maps, and opaque values exactly', () => {
    const input = { args: { future: 'data' }, operation: { unknown_constraint: 'must still validate' }, ...extras };
    const result = projectToolInput(input, ['args', 'operation']);
    expect(result.input).toEqual({ args: input.args, operation: input.operation });
    expect(result.input.args).toBe(input.args);
    expect(result.input.operation).toBe(input.operation);
    expect(projectToolInput(input).input).toBe(input);
  });

  it('bounds hostile receipts, preserves JSON and merges action-specific ignored fields', () => {
    const input = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i}_${'x'.repeat(200)}`, 'PRIVATE_VALUE']));
    const { receipt } = projectToolInput(input, []);
    const result = appendInputReceipt('{"saved":true,"ignored_fields":["unused_known"]}', receipt);
    expect(JSON.parse(result)).toMatchObject({ saved: true, ignored_fields_truncated: true, ignored_field_count: 31 });
    expect(JSON.parse(result).ignored_fields).toHaveLength(10);
    expect(result.length).toBeLessThan(1100);
    expect(result).not.toContain('PRIVATE_VALUE');
    expect(JSON.parse(appendInputReceipt('[1,2]', { ignored_fields: ['extra'] }))).toEqual({ result: [1, 2], ignored_fields: ['extra'] });
    expect(appendInputReceipt('unchanged', null)).toBe('unchanged');
    const dangerous = JSON.parse('{"__proto__":{"polluted":true},"constructor":"ignored"}');
    expect(projectToolInput(dangerous, []).input).toEqual({});
    expect(({} as any).polluted).toBeUndefined();
  });
});
