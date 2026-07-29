import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  activeUid: 'marketplace-biz-a',
  fetchWithRetry: vi.fn(),
}));

vi.mock('../../../src/main/features/users', () => ({
  getActiveUserId: () => runtime.activeUid,
}));
vi.mock('../../../src/main/features/marketplace', () => ({
  apiBase: () => 'https://marketplace.test/api',
}));
vi.mock('../../../src/main/features/api_common', () => ({
  withCommonHeaders: (headers: Record<string, string>) => headers,
}));
vi.mock('../../../src/main/util/retry', () => ({
  fetchWithRetry: (...args: unknown[]) => runtime.fetchWithRetry(...args),
}));

const ACCOUNT_A = 'marketplace-biz-a';
const ACCOUNT_B = 'marketplace-biz-b';
let tempRoot = '';
let priorWorkspaceRoot: string | undefined;

function response(list: unknown[], ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    json: vi.fn(async () => ({ code: ok ? 0 : 503, list })),
  };
}

async function loadModule() {
  return import('../../../src/main/features/marketplace_biz');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-biz-'));
  priorWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tempRoot;
  runtime.activeUid = ACCOUNT_A;
  runtime.fetchWithRetry.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (priorWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = priorWorkspaceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('marketplace category cache', () => {
  it('returns a non-empty sorted fallback on a cold local-only read', async () => {
    const marketplaceBiz = await loadModule();
    const list = await marketplaceBiz.getMarketplaceCategories({ localOnly: true });

    expect(list.length).toBeGreaterThan(0);
    expect(list.map((entry) => entry.sort_order)).toEqual(
      [...list].map((entry) => entry.sort_order).sort((a, b) => a - b),
    );
    expect(runtime.fetchWithRetry).not.toHaveBeenCalled();
  });

  it('ignores an empty persisted category list instead of exposing an empty UI', async () => {
    const { marketplaceBizFile } = await import('../../../src/main/paths');
    const file = marketplaceBizFile(ACCOUNT_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      categories: {
        fetched_at: Date.now(),
        list: [],
      },
    }));

    const marketplaceBiz = await loadModule();
    const list = await marketplaceBiz.getMarketplaceCategories({ localOnly: true });

    expect(list.length).toBeGreaterThan(0);
    expect(list.some((entry) => entry.code === 'general')).toBe(true);
  });

  it('recovers when the persisted category list has the wrong shape', async () => {
    const { marketplaceBizFile } = await import('../../../src/main/paths');
    const file = marketplaceBizFile(ACCOUNT_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      categories: {
        fetched_at: Date.now(),
        list: { code: 'not-an-array' },
      },
    }));

    const marketplaceBiz = await loadModule();
    await expect(marketplaceBiz.getMarketplaceCategories({ localOnly: true }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'general' }),
      ]));
  });

  it('does not let a future cache timestamp suppress an online refresh indefinitely', async () => {
    const { marketplaceBizFile } = await import('../../../src/main/paths');
    const file = marketplaceBizFile(ACCOUNT_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      categories: {
        fetched_at: Date.now() + (7 * 24 * 60 * 60 * 1000),
        list: [{
          code: 'data',
          name_zh: '未来缓存',
          name_en: 'Future cache',
          sort_order: 1,
        }],
      },
    }));
    runtime.fetchWithRetry.mockResolvedValue(response([{
      code: 'general',
      name_zh: '通用',
      name_en: 'General',
      sort_order: 10,
    }]));
    const marketplaceBiz = await loadModule();

    const list = await marketplaceBiz.getMarketplaceCategories();

    expect(runtime.fetchWithRetry).toHaveBeenCalledOnce();
    expect(list).toMatchObject([{ code: 'general' }]);
  });

  it('normalizes unsafe and duplicate server rows before caching them', async () => {
    runtime.fetchWithRetry.mockResolvedValue(response([
      {
        code: 'Writing',
        name_zh: '创作',
        name_en: 'Creation',
        sort_order: 40,
      },
      {
        code: 'creation',
        name_zh: '重复',
        name_en: 'Duplicate',
        sort_order: 99,
      },
      {
        code: '../../escape',
        name_en: 'Unsafe',
        sort_order: 1,
      },
      {
        code: 'data',
        name_en: 'Data',
        sort_order: 20,
      },
    ]));
    const marketplaceBiz = await loadModule();

    const list = await marketplaceBiz.getMarketplaceCategories({ forceRefresh: true });

    expect(list.map((entry) => entry.code)).toEqual(['data', 'creation']);
    expect(list.filter((entry) => entry.code === 'creation')).toHaveLength(1);
  });

  it('returns fresh server categories even when the disposable cache cannot be written', async () => {
    const { userLocalRoot } = await import('../../../src/main/paths');
    const localRoot = userLocalRoot(ACCOUNT_A);
    fs.mkdirSync(localRoot, { recursive: true });
    fs.writeFileSync(path.join(localRoot, 'biz'), 'path conflict');
    runtime.fetchWithRetry.mockResolvedValue(response([{
      code: 'general',
      name_zh: '通用',
      name_en: 'General',
      sort_order: 1,
    }]));
    const marketplaceBiz = await loadModule();

    await expect(marketplaceBiz.getMarketplaceCategories({ forceRefresh: true }))
      .resolves.toMatchObject([{ code: 'general' }]);
  });

  it('keeps an in-flight account A refresh out of account B disk and memory caches', async () => {
    let resolveFetch: ((value: ReturnType<typeof response>) => void) | undefined;
    runtime.fetchWithRetry.mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const paths = await import('../../../src/main/paths');
    const marketplaceBiz = await loadModule();
    const refreshA = marketplaceBiz.getMarketplaceCategories({ forceRefresh: true });
    await vi.waitFor(() => expect(runtime.fetchWithRetry).toHaveBeenCalledOnce());

    const bFile = paths.marketplaceBizFile(ACCOUNT_B);
    fs.mkdirSync(path.dirname(bFile), { recursive: true });
    const bEntry = {
      fetched_at: Date.now(),
      list: [{
        code: 'education',
        name_zh: '教育 B',
        name_en: 'Education B',
        sort_order: 5,
      }],
    };
    fs.writeFileSync(bFile, JSON.stringify({ categories: bEntry }, null, 2));
    runtime.activeUid = ACCOUNT_B;
    resolveFetch?.(response([{
      code: 'data',
      name_zh: '数据 A',
      name_en: 'Data A',
      sort_order: 10,
    }]));

    await expect(refreshA).resolves.toMatchObject([{ code: 'data' }]);
    const aPersisted = JSON.parse(fs.readFileSync(paths.marketplaceBizFile(ACCOUNT_A), 'utf8'));
    expect(aPersisted.categories.list).toMatchObject([{ code: 'data' }]);
    expect(JSON.parse(fs.readFileSync(bFile, 'utf8'))).toEqual({ categories: bEntry });

    const listB = await marketplaceBiz.getMarketplaceCategories({ localOnly: true });
    expect(listB).toMatchObject([{ code: 'education', name_en: 'Education B' }]);
  });
});
