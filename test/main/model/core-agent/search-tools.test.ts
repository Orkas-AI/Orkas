import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: [] as Array<Record<string, any>>,
  userId: 'user-1',
  sessionId: 'session-1',
  apiBase: 'https://search-account.test/api',
  runBuiltinWebSearch: vi.fn(),
  runSearchAdapter: vi.fn(),
}));

vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: () => h.userId }));
vi.mock('../../../../src/main/features/account/token_store', () => ({
  authHeaders: () => ({ user_id: h.userId, session_id: h.sessionId }),
}));
vi.mock('../../../../src/main/features/account/server', () => ({ accountApiBase: () => h.apiBase }));

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
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/util/log-redact', () => ({
  logErrorSummary: (error: unknown) => String(error),
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
    h.sessionId = 'session-1';
    h.apiBase = 'https://search-account.test/api';
    h.runBuiltinWebSearch.mockReset();
    h.runSearchAdapter.mockReset();
    h.runBuiltinWebSearch.mockResolvedValue({ content: 'free results', displayName: 'Brave' });
  });

  afterEach(() => { vi.restoreAllMocks(); });

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
});
