import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: [] as Array<Record<string, any>>,
  userId: 'user-1',
  runBuiltinWebSearch: vi.fn(),
  runSearchAdapter: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: () => h.userId }));
vi.mock('#core-agent', () => ({
  defineTool: (definition: Record<string, unknown>) => definition,
  runBuiltinWebSearch: (...args: unknown[]) => h.runBuiltinWebSearch(...args),
}));
vi.mock('../../../../src/main/features/search_auth', () => ({
  listSearchProfiles: () => h.candidates,
}));
vi.mock('../../../../src/main/model/core-agent/search-adapters', () => {
  class SearchAccountError extends Error {}
  return {
    SearchAccountError,
    SEARCH_PROVIDER_LABEL: {
      tavily: 'Tavily',
      serper: 'Serper',
      brave: 'Brave',
      baidu: 'Baidu AI Search',
    },
    runSearchAdapter: (...args: unknown[]) => h.runSearchAdapter(...args),
  };
});
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error }),
}));
vi.mock('../../../../src/main/util/log-redact', async importOriginal => ({
  ...await importOriginal<any>(),
}));

async function createTool(agentId = 'agent-1') {
  const { createWebSearchOverrideTool } = await import('../../../../src/main/model/core-agent/search-tools');
  return createWebSearchOverrideTool({
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    agentId,
    agentName: 'Search Agent',
  });
}

describe('web_search override tool', () => {
  beforeEach(() => {
    vi.resetModules();
    h.candidates = [];
    h.userId = 'user-1';
    h.runBuiltinWebSearch.mockReset();
    h.runSearchAdapter.mockReset();
    h.warn.mockReset(); h.error.mockReset();
    h.runBuiltinWebSearch.mockResolvedValue({ content: 'free results', displayName: 'Brave' });
  });

  afterEach(() => { expect(h.error).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

  it('keeps the parallel execution contract and validates query before provider access', async () => {
    const tool = await createTool();

    expect(tool.executionMode).toBe('parallel');
    const result = await tool.execute({ query: '   ' }, { state: {} } as any);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('query is required');
    expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
    expect(h.runSearchAdapter).not.toHaveBeenCalled();
  });

  it('uses keyless search without paid profiles and clamps result count on both boundaries', async () => {
    const tool = await createTool();

    await tool.execute({ query: 'windows shell', count: 999 }, { state: {} } as any);
    await tool.execute({ query: 'mac sandbox', count: -5 }, { state: {} } as any);

    expect(h.runBuiltinWebSearch).toHaveBeenNthCalledWith(1, 'windows shell', 20);
    expect(h.runBuiltinWebSearch).toHaveBeenNthCalledWith(2, 'mac sandbox', 1);
    expect(h.runSearchAdapter).not.toHaveBeenCalled();
  });

  it.each([undefined, 'tavily', 'serper', 'brave-search', 'baidu-ai-search', 'deepseek', 'metaso', 'orkas-api'] as const)(
    'counts each admitted web_search call independently of its provider (%s)', async provider => {
      h.candidates = provider ? [{ provider, apiKey: 'synthetic' }] : [];
      h.runSearchAdapter.mockResolvedValue({ results: [{ title: 'Evidence', url: 'https://example.test/source', snippet: 'Kept result' }] });
      const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
      const turn = createTavilySearchTurn('user-1', 'conversation-1');
      await withTavilySearchTurn(turn, async () => {
        const tool = await createTool();
        const observed: number[] = [];
        for (let n = 1; n <= 16; n++) {
          const result = await tool.execute({ query: `bounded evidence ${n}` }, {} as any);
          expect(result.isError).not.toBe(true);
          expect(result.content).toContain(provider ? 'Kept result' : 'free results');
          if (result.content.includes('This turn:')) {
            observed.push(n);
            expect(result.content).toContain(`This turn: ${n} web searches. Prioritize completing the task with existing evidence; search further if necessary.`);
          }
        }
        expect(observed).toEqual([10, 15]);
        expect(turn.requests).toBe(16);
      });
      expect(provider ? h.runSearchAdapter : h.runBuiltinWebSearch).toHaveBeenCalledTimes(16);
      expect(h.warn).not.toHaveBeenCalled();
    });

  it('counts a failed keyless call but never counts rejected tool input', async () => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    const turn = createTavilySearchTurn('user-1', 'conversation-1');
    await withTavilySearchTurn(turn, async () => {
      const tool = await createTool();
      for (let n = 0; n < 9; n++) await tool.execute({ query: 'existing evidence' }, {} as any);
      expect((await tool.execute({ query: '  ' }, {} as any)).isError).toBe(true);
      expect(turn.requests).toBe(9);
      h.runBuiltinWebSearch.mockResolvedValue({ content: 'Search failed without a new result', isError: true });
      const result = await tool.execute({ query: 'last source' }, {} as any);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Search failed without a new result');
      expect(result.content).toContain('This turn: 10 web searches.');
      expect(turn.requests).toBe(10);
      expect(h.runBuiltinWebSearch).toHaveBeenCalledTimes(10);
    });
  });

  it('reminds at 10 searches and every 5 thereafter while continuing to return results', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (_profile, _query, _count) => {
      return { results: [{ title: 'Evidence', url: 'https://example.test/source', snippet: 'Source text' }] };
    });
    const tool = await createTool();
    const reminders: number[] = [];
    for (let count = 1; count <= 26; count++) {
      const result = await tool.execute({ query: `question ${count}` }, { state: {} } as any);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Source text');
      if (result.content.includes('This turn:')) {
        reminders.push(count);
        expect(result.content).toContain(`This turn: ${count} web searches. Prioritize completing the task with existing evidence; search further if necessary.`);
      }
    }
    expect(reminders).toEqual([10, 15, 20, 25]);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(26);
  });

  it('keeps the reminder visible when a large search result is retained behind a bounded preview', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (_profile, _query, _count) => {
      return { results: [{ title: 'Evidence', url: 'https://example.test/source', snippet: 'Source evidence. '.repeat(12_000) }] };
    });
    const tool = await createTool();
    for (let i = 0; i < 9; i++) await tool.execute({ query: 'evidence' }, {} as any);
    const result = await tool.execute({ query: 'last source' }, {} as any);
    const { capToolResult } = await import('../../../../src/main/util/tool-result-cap');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-reminder-'));
    try {
      const capped = capToolResult('web_search', result, { state: {} } as any, { toolResultsDir: dir, maxInlineTokens: 256 });
      expect(capped.persistedOutput).toBeTruthy();
      expect(capped.content).toContain('This turn: 10 web searches.');
      expect(capped.content).toContain('search further if necessary.');
      expect(fs.readFileSync(capped.persistedOutput!.path, 'utf8')).toContain('Source evidence.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });


  it('shares one search count across providers, parallel actors and rebuilt tools', async () => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    h.runSearchAdapter.mockImplementation(async (profile, _query, _count) => {
      await Promise.resolve();
      return { results: [{ title: 'Evidence', url: 'https://example.test/source', snippet: 'Source text' }] };
    });
    const scope = createTavilySearchTurn('user-1', 'conversation-1');
    const all: string[] = [];
    await withTavilySearchTurn(scope, async () => {
      h.candidates = [{ provider: 'serper', apiKey: 'synthetic' }];
      const parent = await createTool('commander');
      for (let i = 0; i < 12; i++) {
        all.push((await parent.execute({ query: `other provider ${i}` }, {} as any)).content);
      }
      h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
      const child = await createTool('agent-2');
      const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        (index % 2 ? parent : child).execute({ query: `evidence ${index}` }, {} as any)));
      all.push(...results.map(result => result.content));
      // Rebuilding an actor after compaction or a model change keeps this scope.
      const rebuilt = await createTool('agent-2');
      for (let i = 0; i < 5; i++) all.push((await rebuilt.execute({ query: `more evidence ${i}` }, {} as any)).content);
    });
    expect(all.filter(content => content.includes('This turn:')).map(content => content.match(/This turn: (\d+)/)?.[1]))
      .toEqual(['10', '15', '20', '25', '30']);
    const next = createTavilySearchTurn('user-1', 'conversation-1');
    await withTavilySearchTurn(next, async () => {
      expect((await (await createTool()).execute({ query: 'new user request' }, {} as any)).content).not.toContain('This turn:');
    });
  });

  it.each([false, true])('counts dispatched failures and preserves the fallback result (fallback fails: %s)', async failedFallback => {
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (_profile, query, _count) => {
      if (query === 'failed request') throw new Error('Tavily 500: temporary outage');
      return { results: [] };
    });
    h.runBuiltinWebSearch.mockResolvedValue({ content: 'fallback receipt', displayName: 'Brave', ...(failedFallback ? { isError: true } : {}) });
    const tool = await createTool();
    for (let i = 0; i < 9; i++) await tool.execute({ query: 'empty but dispatched' }, {} as any);
    const result = await tool.execute({ query: 'failed request' }, {} as any);
    expect(result.content).toContain('This turn: 10 web searches.');
    expect(result.content).toContain('fallback receipt');
    expect(result.isError === true).toBe(failedFallback);
    expect((await tool.execute({ query: 'continued request' }, {} as any)).content).not.toContain('This turn:');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(11);
  });

  it.each(['absent', 'previous turn'])('retains the owning turn when a worker callback has %s async context', async context => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (_profile, _query, _count) => {
      return { results: [{ title: 'Evidence', url: 'https://example.test', snippet: 'Source' }] };
    });
    const previous = createTavilySearchTurn('user-1', 'conversation-1');
    previous.requests = 9;
    const owning = createTavilySearchTurn('user-1', 'conversation-1');
    const tool = await withTavilySearchTurn(owning, () => createTool());
    const run = async () => {
      for (let i = 1; i <= 10; i++) {
        const result = await tool.execute({ query: `source ${i}` }, {} as any);
        expect(result.content.includes('This turn:')).toBe(i === 10);
      }
    };
    if (context === 'previous turn') await withTavilySearchTurn(previous, run);
    else await run();
    expect(owning.requests).toBe(10);
    expect(previous.requests).toBe(9);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('does not increment the bound turn after the active account changes', async () => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (_profile, _query, _count) => {
      return { results: [] };
    });
    const first = createTavilySearchTurn('user-1', 'conversation-1');
    first.requests = 9;
    const tool = await withTavilySearchTurn(first, () => createTool());
    h.userId = 'user-2';
    const second = createTavilySearchTurn('user-2', 'conversation-1');
    await withTavilySearchTurn(second, async () => {
      expect((await tool.execute({ query: 'another account' }, {} as any)).content).not.toContain('This turn:');
    });
    expect(first.requests).toBe(9);
    expect(second.requests).toBe(1);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('counts cooldown fallback, keyless and changed providers once while rejecting invalid input', async () => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    h.candidates = [{ id: 'paid', provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (profile, query, _count) => {
      if (query === 'account rejected') throw new Error('Tavily 401: rejected');
      return { results: [{ title: 'Evidence', url: 'https://example.test', snippet: '' }] };
    });
    const scope = createTavilySearchTurn('user-1', 'conversation-1');
    await withTavilySearchTurn(scope, async () => {
      const tool = await createTool();
      for (let i = 0; i < 8; i++) await tool.execute({ query: 'source' }, {} as any);
      expect((await tool.execute({ query: 'account rejected' }, {} as any)).content).not.toContain('This turn:');
      expect(scope.requests).toBe(9);
      expect((await tool.execute({ query: '   ' }, {} as any)).isError).toBe(true);
      expect(scope.requests).toBe(9);
      expect((await tool.execute({ query: 'cooldown skipped' }, {} as any)).content).toContain('This turn: 10 web searches.');
      h.candidates = [];
      expect((await tool.execute({ query: 'free source' }, {} as any)).content).not.toContain('This turn:');
      h.candidates = [{ provider: 'serper', apiKey: 'synthetic' }];
      expect((await tool.execute({ query: 'other provider' }, {} as any)).content).not.toContain('This turn:');
      expect(scope.requests).toBe(12);
      h.candidates = [{ id: 'paid', provider: 'tavily', apiKey: 'new credential' }];
      const result = await tool.execute({ query: 'recovered source' }, {} as any);
      expect(result.content).not.toContain('This turn:');
      expect(result.content).toContain('Evidence');
      expect(scope.requests).toBe(13);
    });
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(11);
    expect(h.runBuiltinWebSearch).toHaveBeenCalledTimes(3);
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('paid search failed; trying next provider',
      expect.objectContaining({ provider: 'tavily', account_error: true }));
  });

  it('preserves the threshold reminder when the dispatched Tavily request fails over to another paid provider', async () => {
    const { createTavilySearchTurn, withTavilySearchTurn } = await import('../../../../src/main/util/tavily-search-turn');
    const scope = createTavilySearchTurn('user-1', 'conversation-1');
    scope.requests = 9;
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }, { provider: 'serper', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockImplementation(async (profile, _query, _count) => {
      if (profile.provider === 'tavily') { throw new Error('Tavily 500: unavailable'); }
      return { results: [{ title: 'Recovered source', url: 'https://example.test', snippet: '' }] };
    });
    const tool = await withTavilySearchTurn(scope, () => createTool());
    const result = await withTavilySearchTurn(scope, () => tool.execute({ query: 'source' }, {} as any));
    expect(result.isError).not.toBe(true);
    expect(result.displayName).toBe('Serper');
    expect(result.content).toContain('Recovered source');
    expect(result.content.match(/This turn: 10 web searches\./g)).toHaveLength(1);
    expect(scope.requests).toBe(10);
    expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('paid search failed; trying next provider',
      expect.objectContaining({ provider: 'tavily', account_error: false }));
  });

  it('attaches each threshold to its dispatched request when parallel responses finish in reverse order', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    const pending: Array<() => void> = [];
    h.runSearchAdapter.mockImplementation((_profile, query, _count) => {
      return new Promise(resolve => pending.push(() => resolve({
        results: [{ title: query, url: 'https://example.test', snippet: '' }],
      })));
    });
    const tool = await createTool();
    const completed: number[] = [];
    const work = Array.from({ length: 16 }, (_, index) => tool.execute({ query: `request ${index + 1}` }, {} as any)
      .then(result => { completed.push(index + 1); return result; }));
    expect(pending).toHaveLength(16);
    pending.reverse().forEach(resolve => resolve());
    const results = await Promise.all(work);
    expect(completed).toEqual(Array.from({ length: 16 }, (_, index) => 16 - index));
    expect(results.flatMap((result, index) => result.content.includes('This turn:') ? [index + 1] : [])).toEqual([10, 15]);
    expect(results[9].content).toContain('This turn: 10 web searches.');
    expect(results[14].content).toContain('This turn: 15 web searches.');
    expect(h.warn).not.toHaveBeenCalled();
  });


  it('keeps search capability generic instead of branching on an Agent ID', async () => {
    const tool = await createTool('173d4235a431');
    const results = await Promise.all([
      tool.execute({ query: 'salary' }, { state: {} } as any),
      tool.execute({ query: 'job volume' }, { state: {} } as any),
      tool.execute({ query: 'policy' }, { state: {} } as any),
      tool.execute({ query: 'repeat after compaction' }, { state: {} } as any),
    ]);

    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(h.runBuiltinWebSearch).toHaveBeenCalledTimes(4);
    expect((tool.inputSchema as any).properties).not.toHaveProperty('extendedResearchApproved');
  });

  it('prefers the first successful BYO provider and formats bounded result data', async () => {
    const profile = { provider: 'tavily', apiKey: 'secret' };
    h.candidates = [profile];
    h.runSearchAdapter.mockResolvedValue({
      results: [
        { title: 'PowerShell docs', url: 'https://example.test/powershell', snippet: 'Windows shell' },
        { title: 'macOS docs', url: 'https://example.test/macos', snippet: '' },
      ],
    });
    const tool = await createTool();
    const result = await tool.execute({ query: 'cross platform commands', count: 2 }, { state: {} } as any);

    expect(result.isError).toBeUndefined();
    expect(result.displayName).toBe('Tavily');
    expect(result.content).toContain('via Tavily');
    expect(result.content).toContain('PowerShell docs');
    expect(result.content).toContain('macOS docs');
    expect(result.content).toContain('Use the web_fetch tool');
    expect(h.runSearchAdapter).toHaveBeenCalledWith(
      profile,
      'cross platform commands',
      2,
      {
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        agentName: 'Search Agent',
      },
    );
    expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
  });

  it('tries the next BYO profile after a provider failure', async () => {
    h.candidates = [
      { provider: 'tavily', apiKey: 'first' },
      { provider: 'serper', apiKey: 'second' },
    ];
    h.runSearchAdapter
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce({
        results: [{ title: 'Recovered', url: 'https://example.test/recovered', snippet: 'ok' }],
      });
    const tool = await createTool();
    const result = await tool.execute({ query: 'retry providers' }, { state: {} } as any);

    expect(result.isError).toBeUndefined();
    expect(result.displayName).toBe('Serper');
    expect(result.content).toContain('via Serper');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(2);
    expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
  });

  it('falls back to free search after ordinary BYO failures and preserves diagnostics', async () => {
    h.candidates = [{ provider: 'brave', apiKey: 'secret' }];
    h.runSearchAdapter.mockRejectedValue(new Error('HTTP 500'));
    h.runBuiltinWebSearch.mockResolvedValue({ content: 'free fallback results', displayName: 'DuckDuckGo' });
    const tool = await createTool();
    const result = await tool.execute({ query: 'fallback query' }, { state: {} } as any);

    expect(result.isError).toBeUndefined();
    expect(result.displayName).toBe('DuckDuckGo');
    expect(result.content).toContain('configured search providers failed');
    expect(result.content).toContain('Brave: HTTP 500');
    expect(result.content).toContain('free fallback results');
  });

  it('puts BYO search on cooldown after an account failure and avoids a repeated provider charge', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'secret' }];
    h.runSearchAdapter.mockRejectedValue(new Error('Tavily 402: credits exhausted'));
    const tool = await createTool();

    const first = await tool.execute({ query: 'first' }, { state: {} } as any);
    const second = await tool.execute({ query: 'second' }, { state: {} } as any);

    expect(first.content).toContain('automatically using free search');
    expect(second.content).toContain('paid search unavailable');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
    expect(h.runBuiltinWebSearch).toHaveBeenNthCalledWith(1, 'first', 8);
    expect(h.runBuiltinWebSearch).toHaveBeenNthCalledWith(2, 'second', 8);
  });

  it('returns an error when BYO and free search both fail', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'secret' }];
    h.runSearchAdapter.mockRejectedValue(new Error('HTTP 500'));
    h.runBuiltinWebSearch.mockResolvedValue({ content: 'network unavailable', isError: true });
    const tool = await createTool();
    const result = await tool.execute({ query: 'unreachable' }, { state: {} } as any);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('Keyless fallback also failed');
    expect(result.content).toContain('network unavailable');
  });

  it.each([
    'Search failed on all providers. Brave: HTTP 429; DuckDuckGo: request timed out',
    'Search failed on all providers. Brave: no parseable search results',
  ])('preserves the free-search failure after a paid account error: %s', async content => {
    h.candidates = [{ id: 'paid', provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockRejectedValue(new Error('Tavily 402: credits exhausted'));
    h.runBuiltinWebSearch.mockResolvedValue({ isError: true, content, displayName: 'Brave' });
    const tool = await createTool();
    for (let i = 0; i < 2; i++) {
      const result = await tool.execute({ query: 'research query' }, { state: {} } as any);
      expect(result).toMatchObject({ isError: true, displayName: 'Brave' });
      expect(result.content).toContain(content);
      expect(result.content).not.toContain('returned no results');
      expect(result.content).not.toContain('Try a broader/different query');
    }
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it.each(['credentials', 'provider', 'account'])(
    'uses a working configuration immediately after changing %s', async change => {
      h.candidates = [{ id: 'profile', provider: 'tavily', apiKey: 'synthetic-old' }];
      h.runSearchAdapter.mockRejectedValueOnce(new Error('Search 402: credits exhausted'));
      const tool = await createTool();
      await tool.execute({ query: 'first' }, { state: {} } as any);
      if (change === 'credentials') h.candidates[0] = { ...h.candidates[0], apiKey: 'synthetic-new' };
      if (change === 'provider') h.candidates[0] = { ...h.candidates[0], provider: 'serper' };
      if (change === 'account') h.userId = 'user-2';
      h.runSearchAdapter.mockResolvedValueOnce({ results: [{ title: 'Recovered source', url: 'https://example.test/source', snippet: '' }] });
      const result = await tool.execute({ query: 'second' }, { state: {} } as any);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Recovered source');
      expect(h.runSearchAdapter).toHaveBeenCalledTimes(2);
    },
  );

  it('cools only the rejected profile even when another provider succeeds or has a transient outage', async () => {
    h.candidates = [{ id: 'a', provider: 'tavily', apiKey: 'a' }, { id: 'b', provider: 'serper', apiKey: 'b' }];
    h.runSearchAdapter
      .mockRejectedValueOnce(new Error('Tavily 402: exhausted'))
      .mockResolvedValueOnce({ results: [{ title: 'Source', url: 'https://example.test', snippet: '' }] })
      .mockRejectedValueOnce(new Error('Serper 500: temporary outage'))
      .mockResolvedValueOnce({ results: [{ title: 'Recovered', url: 'https://example.test', snippet: '' }] });
    const tool = await createTool();
    expect((await tool.execute({ query: 'one' }, { state: {} } as any)).content).toContain('Source');
    expect((await tool.execute({ query: 'two' }, { state: {} } as any)).content).toContain('free results');
    expect((await tool.execute({ query: 'three' }, { state: {} } as any)).content).toContain('Recovered');
    expect(h.runSearchAdapter.mock.calls.map(call => call[0].id)).toEqual(['a', 'b', 'b', 'b']);
  });

  it('retries an unchanged configuration at cooldown expiry without extending it on skipped calls', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    h.candidates = [{ id: 'profile', provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockRejectedValueOnce(new Error('Tavily 401: rejected'));
    const tool = await createTool();
    await tool.execute({ query: 'one' }, { state: {} } as any);
    now.mockReturnValue(600_999);
    await tool.execute({ query: 'two' }, { state: {} } as any);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
    now.mockReturnValue(601_000);
    h.runSearchAdapter.mockResolvedValueOnce({ results: [{ title: 'Recovered', url: 'https://example.test', snippet: '' }] });
    expect((await tool.execute({ query: 'three' }, { state: {} } as any)).content).toContain('Recovered');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(2);
  });

  it('shares cooldown across tools but keeps label edits and credential order out of its identity', async () => {
    h.candidates = [{ id: 'profile', provider: 'tavily', apiKey: 'synthetic', extras: { region: 'global', mode: 'basic' } }];
    h.runSearchAdapter.mockRejectedValue(new Error('Tavily 403: rejected'));
    await (await createTool()).execute({ query: 'one' }, { state: {} } as any);
    h.candidates[0] = { ...h.candidates[0], label: 'renamed', extras: { mode: 'basic', region: 'global' } };
    await (await createTool('agent-2')).execute({ query: 'two' }, { state: {} } as any);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it('does not attach stale account failures after all paid profiles are removed', async () => {
    h.candidates = [{ provider: 'tavily', apiKey: 'synthetic' }];
    h.runSearchAdapter.mockRejectedValue(new Error('Tavily 402: exhausted'));
    const tool = await createTool();
    await tool.execute({ query: 'one' }, { state: {} } as any);
    h.candidates = [];
    const result = await tool.execute({ query: 'two' }, { state: {} } as any);
    expect(result.content).toBe('free results');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it.each(['credentials', 'account'])('a late failure cannot cool replacement %s', async change => {
    h.candidates = [{ id: 'profile', provider: 'tavily', apiKey: 'synthetic-old' }];
    let rejectOld!: (error: Error) => void;
    h.runSearchAdapter.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const tool = await createTool();
    const old = tool.execute({ query: 'old' }, { state: {} } as any);
    if (change === 'credentials') h.candidates[0] = { ...h.candidates[0], apiKey: 'synthetic-new' };
    else h.userId = 'user-2';
    h.runSearchAdapter.mockResolvedValue({ results: [{ title: 'Current source', url: 'https://example.test', snippet: '' }] });
    expect((await tool.execute({ query: 'current' }, { state: {} } as any)).content).toContain('Current source');
    rejectOld(new Error('Tavily 402: old credentials exhausted'));
    await old;
    expect((await tool.execute({ query: 'after late failure' }, { state: {} } as any)).content).toContain('Current source');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(3);
  });

  it('bounds retained failures and evicts the oldest configuration without blocking a new one', async () => {
    h.runSearchAdapter.mockRejectedValue(new Error('Tavily 402: exhausted'));
    const tool = await createTool();
    for (let i = 0; i < 129; i++) {
      h.candidates = [{ id: `profile-${i}`, provider: 'tavily', apiKey: `synthetic-${i}` }];
      await tool.execute({ query: 'one' }, { state: {} } as any);
    }
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(129);
    h.candidates = [{ id: 'profile-128', provider: 'tavily', apiKey: 'synthetic-128' }];
    await tool.execute({ query: 'retained' }, { state: {} } as any);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(129);
    h.candidates = [{ id: 'profile-0', provider: 'tavily', apiKey: 'synthetic-0' }];
    await tool.execute({ query: 'evicted' }, { state: {} } as any);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(130);
  });

  it.each([['deepseek',128], ['orkas-api',128], ['serper',128], ['tavily',400]] as const)('advertises and enforces the first provider Unicode bound (%s)', async(provider,limit)=>{
    h.candidates=[{provider,apiKey:'fixture'}];
    h.runSearchAdapter.mockResolvedValue({results:[{title:'Source',url:'https://example.test',snippet:'Evidence'}]});
    const tool=await createTool();
    expect((tool.inputSchema as any).properties.query.maxLength).toBe(limit);
    const result=await tool.execute({query:'🌏'.repeat(limit+1)},{} as any);
    expect(result.isError).toBe(true);expect(result.content).toContain(String(limit));
    expect(h.runSearchAdapter).not.toHaveBeenCalled();expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
    for (const length of [limit-1,limit]) {
      const accepted=await tool.execute({query:'🌏'.repeat(length)},{} as any);
      expect(accepted.isError).not.toBe(true);
      expect(h.runSearchAdapter.mock.lastCall?.[1]).toBe('🌏'.repeat(length));
    }
  });
  it('lets a changed first provider tighten but never widen an existing run schema',async()=>{
    h.candidates=[{provider:'tavily',apiKey:'fixture'}]; const wide=await createTool();
    h.candidates=[{provider:'deepseek',apiKey:'fixture'}];
    expect((await wide.execute({query:'🌏'.repeat(129)},{} as any)).isError).toBe(true);
    const narrow=await createTool();h.candidates=[{provider:'tavily',apiKey:'fixture'}];
    expect((await narrow.execute({query:'🌏'.repeat(129)},{} as any)).isError).toBe(true);
    expect(h.runSearchAdapter).not.toHaveBeenCalled();expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
    const recreated=await createTool();
    expect((recreated.inputSchema as any).properties.query.maxLength).toBe(400);
  });
  it.each(['deepseek','orkas-api'])('stops an incompatible fallback without dispatching it (%s)',async backup=>{
    h.candidates=[{provider:'tavily',apiKey:'fixture'},...(backup?[{provider:backup,apiKey:'fixture'}]:[])];
    h.runSearchAdapter.mockRejectedValueOnce(new Error('Tavily 503: request failed'));
    const result=await(await createTool()).execute({query:'🌏'.repeat(200)},{} as any);
    expect(result.isError).toBe(true);expect(result.content).toContain('128');
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
    expect(h.runSearchAdapter.mock.calls[0][1]).toBe('🌏'.repeat(200));
  });
  it('keeps the existing tool guidance and adds only the approved threshold reminder',async()=>{
    h.candidates=[{provider:'tavily',apiKey:'fixture'}];
    h.runSearchAdapter.mockResolvedValue({results:[{title:'Source',url:'https://example.org',snippet:'Evidence'}]});
    const tool=await createTool();
    expect(tool.description).toBe('Search the web for information. Returns a list of search results with titles, URLs, and snippets. Use this when you need to find current information, news, documentation, or any web content. After searching, use web_fetch to read the full content of relevant result URLs.');
    for(let i=0;i<15;i++){
      const result=await tool.execute({query:'public query'},{} as any);
      expect(result.content).toContain('Evidence');
      expect(result.content.includes('This turn:')).toBe(i === 9 || i === 14);
      expect(result.content).not.toContain('paid web searches');
    }
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(15);
  });

  it('preserves the existing unbounded keyless query without advertising a configured-service limit',async()=>{
    const tool=await createTool();const query='🌏'.repeat(1024);
    expect((tool.inputSchema as any).properties.query).not.toHaveProperty('maxLength');
    expect((await tool.execute({query},{} as any)).isError).not.toBe(true);
    expect(h.runBuiltinWebSearch).toHaveBeenCalledExactlyOnceWith(query,8);expect(h.runSearchAdapter).not.toHaveBeenCalled();
  });
  it('preserves keyless recovery after a valid long Tavily query fails',async()=>{
    h.candidates=[{provider:'tavily',apiKey:'fixture'}];
    h.runSearchAdapter.mockRejectedValueOnce(new Error('Tavily 503: request failed'));
    const query='🌏'.repeat(400);const result=await(await createTool()).execute({query},{} as any);
    expect(result.isError).not.toBe(true);expect(result.content).toContain('free results');
    expect(h.runBuiltinWebSearch).toHaveBeenCalledExactlyOnceWith(query,8);
    expect(h.runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it.each(['required', 'invalid_value'] as const)('returns the established structured query %s error before dispatch', async reason => {
    h.candidates = [{provider: 'tavily', apiKey: 'fixture'}];
    const result = await (await createTool()).execute({query: reason === 'required' ? '  ' : '🌏'.repeat(401)}, {} as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({code: 'E_BAD_INPUT', issues: [{field: 'query', reason}]});
    expect(h.runSearchAdapter).not.toHaveBeenCalled();
    expect(h.runBuiltinWebSearch).not.toHaveBeenCalled();
  });

});
