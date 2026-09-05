import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  runSearchAdapter,
  SEARCH_PROVIDER_LABEL,
  searchAdaptersByProvider,
} from '../../../../src/main/model/core-agent/search-adapters';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('open-source BYO search adapters', () => {
  it('labels the official provider with its concrete service', () => {
    expect(SEARCH_PROVIDER_LABEL['orkas-api']).toBe('Orkas · Search');
  });

  it('uses the public Orkas search contract without a capabilities request', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Orkas', url: 'https://orkas.ai/docs', snippet: 'Official result' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'orkas-a',
      provider: 'orkas-api',
      apiKey: 'orkas-user-key',
      label: 'Orkas',
      createdAt: 0,
    }, 'public api', 4, {
      conversationId: 'conv_123',
      turnId: 'turn-456',
    });

    expect(result.results).toEqual([
      { title: 'Orkas', url: 'https://orkas.ai/docs', snippet: 'Official result' },
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(
      'https://orkas.ai/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer orkas-user-key',
          'X-Orkas-Conversation-Id': 'conv_123',
          'X-Orkas-Turn-Id': 'turn-456',
        }),
      }),
    );
    expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'public api',
      max_results: 4,
    });
  });

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
      'orkas-api',
      'serper',
      'tavily',
    ]);
  });
});

describe('search transfer deadlines', () => {
  it.each(['orkas-api', 'tavily', 'serper', 'brave-search', 'baidu-ai-search', 'metaso'])('keeps the %s deadline active while reading the response body', async (provider) => {
    vi.useFakeTimers();
    try {
      let responseSignal: AbortSignal | undefined;
      const readBody = () => new Promise<string>((_resolve, reject) => {
        responseSignal!.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
      });
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        responseSignal = init.signal;
        return { ok: true, status: 200, text: readBody, json: readBody };
      }));
      const pending = runSearchAdapter({ id: 'test', provider, apiKey: 'fixture', label: '', createdAt: 0 } as any, 'query', 1);
      const outcome = pending.then(() => 'success', () => 'failed');
      await vi.advanceTimersByTimeAsync(30_001);
      expect(responseSignal?.aborted).toBe(true);
      expect(await outcome).toBe('failed');
    } finally { vi.useRealTimers(); }
  });
});
