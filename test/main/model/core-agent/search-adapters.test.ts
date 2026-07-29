import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  runSearchAdapter,
  searchAdaptersByProvider,
} from '../../../../src/main/model/core-agent/search-adapters';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('open-source BYO search adapters', () => {
  it('normalizes Tavily results and bounds the requested count', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: 'One', url: 'https://example.test/one', content: 'First result' },
        { title: 'No URL', content: 'ignored' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'tavily-a',
      provider: 'tavily',
      apiKey: 'user-owned-key',
      label: 'Tavily',
      createdAt: 0,
    }, 'query', 100);

    expect(result).toEqual({
      provider: 'tavily',
      results: [{ title: 'One', url: 'https://example.test/one', snippet: 'First result' }],
    });
    expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body))).toMatchObject({
      query: 'query',
      max_results: 20,
    });
  });

  it('uses the user-owned Serper key only in the provider request header', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      organic: [{ title: 'Result', link: 'https://example.test', snippet: 'Snippet' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    await runSearchAdapter({
      id: 'serper-a',
      provider: 'serper',
      apiKey: 'user-owned-key',
      label: 'Serper',
      createdAt: 0,
    }, 'query', 3);

    expect(fetchStub).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-KEY': 'user-owned-key' }),
      }),
    );
  });

  it('fails closed for an unknown provider without making a network request', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(runSearchAdapter({
      id: 'unknown-a',
      provider: 'unknown',
      apiKey: 'user-owned-key',
      label: 'Unknown',
      createdAt: 0,
    }, 'query', 1)).rejects.toThrow('no search adapter registered');
    expect(fetchStub).not.toHaveBeenCalled();
    expect(Object.keys(searchAdaptersByProvider).sort()).toEqual([
      'baidu-ai-search',
      'brave-search',
      'metaso',
      'serper',
      'tavily',
    ]);
  });
});
