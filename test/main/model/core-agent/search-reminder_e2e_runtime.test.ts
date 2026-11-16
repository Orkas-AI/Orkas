import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner, createConfig, ProviderRegistry, Session } from '../../../../src/core-agent/src/index';
import type { CompletionParams, LLMProvider } from '../../../../src/core-agent/src/providers/base';
import type { MessageContent } from '../../../../src/core-agent/src/shared/types';
import { createRunProgramTool } from '../../../../src/core-agent/src/tools/run-program';
import { ProgramWorkerPool, programWorkerPool } from '../../../../src/core-agent/src/tools/run-program-worker-pool';
import { createWebSearchOverrideTool } from '../../../../src/main/model/core-agent/search-tools';
import { capToolResult } from '../../../../src/main/util/tool-result-cap';
import { createTavilySearchTurn, withTavilySearchTurn } from '../../../../src/main/util/tavily-search-turn';

const h = vi.hoisted(() => ({ provider: 'tavily', warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: () => 'reminder-user' }));
vi.mock('../../../../src/main/features/search_auth', () => ({
  listSearchProfiles: () => [{ id: 'fixture-search', provider: h.provider, apiKey: 'fixture-key' }],
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error }),
}));

const search = (count: number): MessageContent => ({
  type: 'tool_use', id: `source-${count}`, name: 'web_search', input: { query: `source ${count}` },
});
const reminder = 'This turn: 10 web searches. Prioritize completing the task with existing evidence; search further if necessary.';

describe('search reminder delivery through the real execution loop', () => {
  let root: string;
  let dispatched: string[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-reminder-runtime-'));
    dispatched = [];
    h.provider = 'tavily';
    h.warn.mockClear(); h.error.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe(h.provider === 'tavily' ? 'https://api.tavily.com/search' : 'https://api.deepseek.com/v1/tools/search');
      const { query } = JSON.parse(String(init.body));
      dispatched.push(query);
      const evidence = query === 'source 10' ? 'Evidence from source ten. '.repeat(400) : `Evidence for ${query}.`;
      return new Response(JSON.stringify({ code: 0, results: Array.from({ length: query === 'source 10' ? 5 : 1 }, (_, index) => ({ title: query, url: `https://source.test/evidence/${index}`, content: evidence, snippet: evidence })) }));
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });
  afterAll(() => programWorkerPool.dispose());

  async function execute(script: MessageContent[][], programmatic = false) {
    const requests: CompletionParams[] = [];
    const registry = new ProviderRegistry();
    const provider: LLMProvider = {
      id: 'fixture', name: 'Fixture', validateAuth: async () => true,
      async complete() { throw new Error('No auxiliary model calls expected'); },
      async *stream(params) {
        requests.push(structuredClone(params));
        const content = script.shift();
        if (!content) throw new Error('Unexpected additional model request');
        yield { type: 'message_start' as const };
        for (const part of content) if (part.type === 'text') yield { type: 'text_delta' as const, text: part.text };
        yield { type: 'message_end' as const, content, model: 'fixture-model',
          stopReason: content.some(part => part.type === 'tool_use') ? 'tool_use' as const : 'end_turn' as const };
      },
    };
    registry.registerFactory('fixture', () => provider);
    const scope = createTavilySearchTurn('reminder-user', 'reminder-conversation');
    return withTavilySearchTurn(scope, async () => {
      const tool = await createWebSearchOverrideTool({ conversationId: 'reminder-conversation', turnId: 'fixture-turn' });
      const runner = new AgentRunner({
        providers: registry, session: new Session(), tools: [tool],
        config: createConfig({
          agent: { defaultProvider: 'fixture', defaultModel: 'fixture-model' },
          models: { catalog: { 'fixture-model': { provider: 'fixture', model: 'fixture-model', contextWindow: 272_000, maxOutputTokens: 4_096 } } },
          evolution: { enabled: false },
        }),
        transformToolResult: (name, result, ctx) => capToolResult(name, result, ctx, {
          toolResultsDir: path.join(root, 'results'), maxInlineTokens: 512,
        }),
        ...(programmatic ? { programmaticToolPolicy: {
          isEligible: (name: string) => name === 'web_search', authorize: () => ({ allowed: true as const }),
        } } : {}),
      });
      const result = await runner.run({ message: 'Research the sources and deliver the findings.', workingDir: root });
      return { requests, result, scope };
    });
  }

  it.each(['tavily', 'deepseek'])('delivers provider-specific query bounds and outcomes through the real runner (%s)', async provider => {
    h.provider = provider;
    const query = '🌏'.repeat(129);
    const { requests, scope } = await execute([
      [{type:'tool_use', id:'long-query', name:'web_search', input:{query}}],
      [{type:'text', text:'Boundary observed.'}],
    ]);
    const definition = requests[0].tools?.find(tool => tool.name === 'web_search');
    expect((definition?.inputSchema as any).properties.query.maxLength).toBe(provider === 'tavily' ? 400 : 128);
    const receipt = requests[1].messages.flatMap(message => message.content)
      .find(part => part.type === 'tool_result' && part.toolUseId === 'long-query');
    expect(receipt).toBeDefined();
    if (receipt?.type !== 'tool_result') throw new Error('Missing search receipt');
    expect(Boolean(receipt.isError)).toBe(provider !== 'tavily');
    expect(dispatched).toEqual(provider === 'tavily' ? [query] : []);
    expect(scope.requests).toBe(provider === 'tavily' ? 1 : 0);
  });

  it.each(['tavily', 'deepseek'])('delivers one reminder after parallel search and result spilling, then permits another search (%s)', async provider => {
    h.provider = provider;
    const { requests, result, scope } = await execute([
      Array.from({ length: 9 }, (_, index) => search(index + 1)), [search(10)], [search(11)],
      [{ type: 'text', text: 'Research delivered.' }],
    ]);
    expect(result.text).toBe('Research delivered.');
    expect(dispatched).toHaveLength(11);
    expect(scope.requests).toBe(11);
    expect(requests).toHaveLength(4);
    const receipts = requests[2].messages.flatMap(message => message.content).filter(part => part.type === 'tool_result');
    expect(receipts.filter(part => part.content.includes(reminder))).toHaveLength(1);
    const last = receipts.find(part => part.toolUseId === 'source-10');
    expect(last?.content).toContain('<persisted-output');
    expect(last?.content).toContain(reminder);
    expect(requests.every(request => !(request.systemPrompt || '').includes('web searches.'))).toBe(true);
  });

  it('shares the parent counter with a programmatic search when a previously created worker handles the call', async () => {
    // Warm the reusable worker outside this conversation, so callback execution
    // cannot accidentally inherit the first user's async context forever.
    const warm = createRunProgramTool({ listToolNames: () => [], invokeTool: async () => { throw new Error('No child calls expected'); } });
    expect((await warm.execute({ code: "text('ready')" }, { workingDir: root, state: {} })).isError).not.toBe(true);
    const { requests, result, scope } = await execute([
      Array.from({ length: 9 }, (_, index) => search(index + 1)),
      [{ type: 'tool_use', id: 'program-source-10', name: 'run_program', input: {
        code: "const result = await tools.web_search({query:'source 10'}); if (!result.ok) throw new Error(result.content); text(result.content);",
      } }],
      [{ type: 'text', text: 'Research delivered.' }],
    ], true);
    expect(result.text).toBe('Research delivered.');
    expect(dispatched).toHaveLength(10);
    expect(scope.requests).toBe(10);
    const receipts = requests[2].messages.flatMap(message => message.content).filter(part => part.type === 'tool_result');
    expect(receipts.find(part => part.toolUseId === 'program-source-10')?.content).toContain(reminder);
  });

  it.each(['tavily', 'deepseek'])('starts a fresh counter in the same conversation while reusing a previous turn worker (%s)', async provider => {
    h.provider = provider;
    // A dedicated real pool guarantees reuse of the worker created under the
    // first turn, regardless of test order or other workers' async contexts.
    const pool = new ProgramWorkerPool(1);
    const executeWorker = vi.spyOn(programWorkerPool, 'execute').mockImplementation(options => pool.execute(options));
    const programSearch = (index: number): MessageContent => ({
      type: 'tool_use', id: `program-source-${index}`, name: 'run_program', input: {
        code: `const result = await tools.web_search({query:'source ${index}'}); if (!result.ok) throw new Error(result.content); text(result.content);`,
      },
    });
    try {
      const first = await execute([
        [programSearch(1)], Array.from({ length: 8 }, (_, index) => search(index + 2)),
        [{ type: 'text', text: 'Research delivered.' }],
      ], true);
      expect(first.result.text).toBe('Research delivered.');
      expect(first.scope.requests).toBe(9);
      const second = await execute([
        [programSearch(1)], Array.from({ length: 8 }, (_, index) => search(index + 2)), [programSearch(10)],
        [{ type: 'text', text: 'Research delivered.' }],
      ], true);
      expect(second.result.text).toBe('Research delivered.');
      expect(second.requests).toHaveLength(4);
      for (const request of second.requests.slice(0, 3)) {
        expect(request.messages.flatMap(message => message.content)
          .some(part => part.type === 'tool_result' && part.content.includes('This turn:'))).toBe(false);
      }
      const receipts = second.requests[3].messages.flatMap(message => message.content).filter(part => part.type === 'tool_result');
      expect(receipts.filter(part => part.content.includes(reminder))).toHaveLength(1);
      expect(receipts.find(part => part.toolUseId === 'program-source-10')?.content).toContain(reminder);
      expect(first.scope.requests).toBe(9);
      expect(second.scope.requests).toBe(10);
      expect(dispatched).toHaveLength(19);
      expect(executeWorker).toHaveBeenCalledTimes(3);
    } finally {
      executeWorker.mockRestore();
      await pool.dispose();
    }
  });

  it('keeps counting private programmatic results and delivers the next reminder on a direct search', async () => {
    const { requests, result, scope } = await execute([
      Array.from({ length: 9 }, (_, index) => search(index + 1)),
      [{ type: 'tool_use', id: 'filtered-source-10', name: 'run_program', input: {
        code: "const result = await tools.web_search({query:'source 10'}); if (!result.ok) throw new Error(result.content); text('Selected one relevant source.');",
      } }],
      Array.from({ length: 5 }, (_, index) => search(index + 11)),
      [{ type: 'text', text: 'Research delivered.' }],
    ], true);
    expect(result.text).toBe('Research delivered.');
    expect(dispatched).toHaveLength(15);
    expect(scope.requests).toBe(15);
    expect(requests).toHaveLength(4);
    const filtered = requests[2].messages.flatMap(message => message.content)
      .find(part => part.type === 'tool_result' && part.toolUseId === 'filtered-source-10');
    // Existing program privacy: only explicit program output enters context.
    // This also documents why child-result reminders alone cannot guarantee delivery.
    expect(filtered?.type === 'tool_result' && filtered.content).toContain('Selected one relevant source.');
    expect(filtered?.type === 'tool_result' && filtered.content).not.toContain(reminder);
    const receipts = requests[3].messages.flatMap(message => message.content).filter(part => part.type === 'tool_result');
    expect(receipts.filter(part => part.content.includes('This turn: 15 web searches.'))).toHaveLength(1);
    expect(receipts.find(part => part.toolUseId === 'source-15')?.content).toContain('This turn: 15 web searches.');
  });
});
