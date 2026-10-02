import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  activeUid: 'marketplace-biz-a',
  fetchWithRetry: vi.fn(),
  warn: vi.fn(),
  writeHook: null as null | ((file: string, data: string | Uint8Array, options: any) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) =>
    runtime.writeHook
      ? runtime.writeHook(String(args[0]), args[1] as string | Uint8Array, args[2])
      : actual.writeFile(...args) };
});
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ warn: runtime.warn }),
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
  runtime.warn.mockReset();
  runtime.writeHook = null;
  vi.resetModules();
});

afterEach(() => {
  runtime.writeHook = null;
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
    for (const entry of list) {
      for (const lang of ['ar', 'hi', 'th', 'tr', 'vi', 'zh-tw', 'pt-pt', 'es-419']) {
        expect(entry[`name_${lang}` as keyof typeof entry], `${entry.code}/${lang}`).toBeTruthy();
      }
    }
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
        name_es: 'Creación', name_fr: 'Création', name_ko: '창작',
        name_de: 'Kreation', name_ru: 'Творчество', name_it: 'Creazione',
        name_ar: 'إبداع', name_hi: 'रचना', name_th: 'การสร้างสรรค์', name_tr: 'Yaratıcılık',
        name_vi: 'Sáng tạo', 'name_zh-tw': '創作', 'name_pt-pt': 'Criação', 'name_es-419': 'Creación',
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
    expect(list.find(entry => entry.code === 'creation')).toMatchObject({
      name_es: 'Creación', name_fr: 'Création', name_ko: '창작',
      name_de: 'Kreation', name_ru: 'Творчество', name_it: 'Creazione',
        name_ar: 'إبداع', name_hi: 'रचना', name_th: 'การสร้างสรรค์', name_tr: 'Yaratıcılık',
        name_vi: 'Sáng tạo', 'name_zh-tw': '創作', 'name_pt-pt': 'Criação', 'name_es-419': 'Creación',
    });
    expect(await marketplaceBiz.getMarketplaceCategories({ localOnly: true })).toEqual(list);
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
    expect(runtime.warn.mock.calls).toEqual([['persisted categories write failed code=EEXIST']]);
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
  it.each(['complete', 'fail'] as const)('keeps the previous offline registry readable while a refresh write will %s', async (outcome) => {
    const { marketplaceBizFile } = await import('../../../src/main/paths');
    const file = marketplaceBizFile(ACCOUNT_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const previous = { categories: { fetched_at: Date.now() - 90_000_000,
      list: [{ code: 'custom', name_en: 'Saved category', name_zh: '缓存分类', sort_order: 1 }] } };
    fs.writeFileSync(file, JSON.stringify(previous));
    runtime.fetchWithRetry.mockResolvedValueOnce(response([
      { code: 'updated', name_en: 'Updated category', name_zh: '新分类', sort_order: 2 },
    ])).mockRejectedValueOnce(Object.assign(new Error('fixture offline'), { code: 'OFFLINE' }));
    let entered!: () => void;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Control only the filesystem scheduling/failure boundary. The production
    // module and storage helper choose the destination and publication method.
    runtime.writeHook = async (destination, data, options) => {
      const handle = await fsp.open(destination, 'w', typeof options === 'object' ? options?.mode : undefined);
      try {
        entered();
        await gate;
        if (outcome === 'fail') throw Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' });
        await handle.writeFile(data, typeof options === 'string' ? options as BufferEncoding : undefined);
      } finally { await handle.close(); }
    };
    const marketplaceBiz = await loadModule();
    const refreshing = marketplaceBiz.getMarketplaceCategories({ forceRefresh: true });
    try {
      await opened;
      // Force refresh exercises an independent reader instead of the fresh
      // memory shortcut. Offline recovery must use the valid disk snapshot.
      const concurrent = await marketplaceBiz.getMarketplaceCategories({ forceRefresh: true });
      expect(concurrent).toMatchObject([{ code: 'custom', name_en: 'Saved category' }]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(previous);
      expect(runtime.warn.mock.calls).toEqual([['fetch categories failed code=OFFLINE']]);
    } finally {
      release();
      await refreshing;
      runtime.writeHook = null;
    }
    await expect(refreshing).resolves.toMatchObject([{ code: 'updated' }]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (outcome === 'complete') {
      expect(saved.categories.list).toMatchObject([{ code: 'updated', name_en: 'Updated category' }]);
      expect(runtime.warn.mock.calls).toEqual([['fetch categories failed code=OFFLINE']]);
    } else {
      expect(saved).toEqual(previous);
      expect(runtime.warn.mock.calls).toEqual([
        ['fetch categories failed code=OFFLINE'], ['persisted categories write failed code=ENOSPC'],
      ]);
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

});
