import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMarketplace() {
  const users = await import('../../../src/main/features/users');
  users.activateUser('u_marketplace_projects');
  return import('../../../src/main/features/marketplace');
}

describe('marketplace projects catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.ORKAS_API_BASE_URL;
  });

  it('falls back to bundled projects when the Server catalog is unavailable', async () => {
    process.env.ORKAS_API_BASE_URL = 'https://marketplace.test/api';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));

    const marketplace = await loadMarketplace();
    const home = await marketplace.listMarketplaceProjects({ home_only: true });

    expect(home.list.map((p) => p.id)).toEqual(['hyperframes', 'ppt-master', 'crawl4ai']);
    expect(home.categories.map((c) => c.code)).toEqual(['anim', 'browser', 'slides']);
    expect(home.source).toBe('bundled');
    expect(home.stale).toBe(true);
  });

  it('applies category, search, and pagination to the bundled fallback', async () => {
    process.env.ORKAS_API_BASE_URL = 'https://marketplace.test/api';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));

    const marketplace = await loadMarketplace();
    const browser = await marketplace.listMarketplaceProjects({ category: 'browser', q: '结构化', size: 1 });

    expect(browser.total).toBe(1);
    expect(browser.list).toHaveLength(1);
    expect(browser.list[0].id).toBe('crawl4ai');
  });

  it('uses Server results when the catalog request succeeds', async () => {
    process.env.ORKAS_API_BASE_URL = 'https://marketplace.test/api';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      list: [{ id: 'server-project', name: 'Server Project' }],
      total: 1,
      categories: [{ code: 'server', name_zh: '服务端', name_en: 'Server', sort_order: 1 }],
    })));
    vi.stubGlobal('fetch', fetchMock);

    const marketplace = await loadMarketplace();
    const data = await marketplace.listMarketplaceProjects({ home_only: true });

    expect(data.list.map((p) => p.id)).toEqual(['server-project']);
    expect(data.source).toBe('server');
    expect(data.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
