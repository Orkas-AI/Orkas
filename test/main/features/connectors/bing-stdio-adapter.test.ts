import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

type Adapter = {
  TOOLS: Array<{ name: string; inputSchema: { required?: string[] } }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
};

// The adapter captures `const TOKEN = process.env.BING_ACCESS_TOKEN` at module load, so each test
// re-requires with the cache cleared (after beforeEach sets the token) to pick it up.
function loadAdapter(): Adapter {
  const full = path.join(process.cwd(), 'bin', 'bing-webmaster-mcp-server.cjs');
  delete requireCjs.cache[full];
  return requireCjs(full) as Adapter;
}

function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function mockFetchOnce(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Bing Webmaster stdio REST adapter', () => {
  beforeEach(() => {
    process.env.BING_ACCESS_TOKEN = 'test-access-token';
  });

  afterEach(() => {
    delete process.env.BING_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it('exports the 4 read-only tools without starting the stdio server', () => {
    const adapter = loadAdapter();
    const names = adapter.TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['list_sites', 'query_keyword_stats', 'query_page_stats', 'query_traffic_stats']);
    expect(typeof adapter.callTool).toBe('function');
    for (const t of adapter.TOOLS) {
      // Only list_sites takes no args; the three stat tools require siteUrl.
      if (t.name === 'list_sites') expect(t.inputSchema.required ?? []).toEqual([]);
      else expect(t.inputSchema.required).toContain('siteUrl');
    }
  });

  it('list_sites maps Url -> siteUrl, strips __type, and sends the bearer token (no siteUrl query)', async () => {
    const fetchMock = mockFetchOnce({ d: [{ __type: 'Site:#Bing', Url: 'https://orkas.ai/', IsVerified: true }] });
    const adapter = loadAdapter();

    await expect(adapter.callTool('list_sites', {})).resolves.toEqual({
      sites: [{ siteUrl: 'https://orkas.ai/', raw: { Url: 'https://orkas.ai/', IsVerified: true } }],
      rowCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.bing.com/webmaster/api.svc/json/GetUserSites',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );
  });

  it('normalizes WCF /Date(ms)/ to YYYY-MM-DD and encodes siteUrl in the query', async () => {
    const fetchMock = mockFetchOnce({
      d: [{ __type: 'TrafficStat', Date: '/Date(1700000000000)/', Clicks: 10, Impressions: 100 }],
    });
    const adapter = loadAdapter();

    const res = await adapter.callTool('query_traffic_stats', { siteUrl: 'https://orkas.ai/' });
    expect(res).toEqual({
      siteUrl: 'https://orkas.ai/',
      rowCount: 1,
      rows: [{ Date: '2023-11-14', Clicks: 10, Impressions: 100 }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?siteUrl=https%3A%2F%2Forkas.ai%2F',
    );
  });

  it('unwraps a nested { d: { <X>: [...] } } envelope', async () => {
    mockFetchOnce({ d: { Stats: [{ Query: 'ai agent', Clicks: 3 }] } });
    const adapter = loadAdapter();

    await expect(adapter.callTool('query_keyword_stats', { siteUrl: 'https://orkas.ai/' })).resolves.toEqual({
      siteUrl: 'https://orkas.ai/',
      rowCount: 1,
      rows: [{ Query: 'ai agent', Clicks: 3 }],
    });
  });

  it('tolerates a bare array with no d envelope', async () => {
    mockFetchOnce([{ Page: 'https://orkas.ai/x', Clicks: 1 }]);
    const adapter = loadAdapter();

    await expect(adapter.callTool('query_page_stats', { siteUrl: 'https://orkas.ai/' })).resolves.toEqual({
      siteUrl: 'https://orkas.ai/',
      rowCount: 1,
      rows: [{ Page: 'https://orkas.ai/x', Clicks: 1 }],
    });
  });

  it('rejects a stat tool called without siteUrl', async () => {
    mockFetchOnce({ d: [] });
    const adapter = loadAdapter();
    await expect(adapter.callTool('query_keyword_stats', {})).rejects.toThrow(/siteUrl is required/);
  });

  it('surfaces the Bing error Message with method and status', async () => {
    mockFetchOnce({ ErrorCode: 18, Message: 'not a verified owner' }, 403);
    const adapter = loadAdapter();
    await expect(adapter.callTool('list_sites', {})).rejects.toThrow('Bing Webmaster API GetUserSites 403: not a verified owner');
  });
});
