import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));
const fsPromiseMocks = vi.hoisted(() => ({
  rm: vi.fn(),
}));

let root: string;

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsPromiseMocks.rm.mockImplementation(actual.rm);
  return { ...actual, rm: fsPromiseMocks.rm };
});

beforeEach(() => {
  vi.resetModules();
  loggerMocks.warn.mockReset();
  fsPromiseMocks.rm.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cache-clearable-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function loadForUser(uid: string) {
  const users = await import('../../../src/main/features/users');
  users.activateUser(uid);
  const paths = await import('../../../src/main/paths');
  const feature = await import('../../../src/main/features/cache_clearable');
  return { feature, cacheRoot: paths.userLocalCacheDir(uid), uid };
}

describe('clearable cache', () => {
  it('returns an empty list when the cache root is absent', async () => {
    const { feature, uid } = await loadForUser('empty');
    expect(await feature.listClearableBuckets(uid)).toEqual([]);
  });

  it('lists visible top-level directories with recursive sizes and newest mtime', async () => {
    const { feature, cacheRoot, uid } = await loadForUser('list');
    fs.mkdirSync(path.join(cacheRoot, 'zeta', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'zeta', 'a.bin'), Buffer.alloc(3));
    fs.writeFileSync(path.join(cacheRoot, 'zeta', 'nested', 'b.bin'), Buffer.alloc(5));
    fs.writeFileSync(path.join(cacheRoot, 'alpha', 'c.bin'), Buffer.alloc(2));
    fs.writeFileSync(path.join(cacheRoot, 'root-file'), 'ignored');

    const buckets = await feature.listClearableBuckets(uid);

    expect(buckets.map((item) => item.name)).toEqual(['alpha', 'zeta']);
    expect(buckets.map((item) => item.bytes)).toEqual([2, 8]);
    expect(buckets.every((item) => item.last_modified > 0)).toBe(true);
  });

  it('ignores malformed on-disk names without blocking clear-all for valid buckets', async () => {
    const { feature, cacheRoot, uid } = await loadForUser('corrupt-name');
    const valid = path.join(cacheRoot, 'marketplace');
    const malformed = path.join(cacheRoot, 'bad name');
    fs.mkdirSync(valid, { recursive: true });
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(valid, 'reclaim.bin'), Buffer.alloc(7));
    fs.writeFileSync(path.join(malformed, 'foreign.bin'), Buffer.alloc(11));

    await expect(feature.listClearableBuckets(uid)).resolves.toMatchObject([
      { name: 'marketplace', bytes: 7 },
    ]);
    await expect(feature.clearAllClearable(uid)).resolves.toBe(7);
    expect(fs.existsSync(valid)).toBe(false);
    expect(fs.readFileSync(path.join(malformed, 'foreign.bin'))).toHaveLength(11);
  });

  it.each(['', '.', '..', '.hidden', '../outside', 'a/b', 'a\\b'])(
    'rejects unsafe bucket name %j',
    async (name) => {
      const { feature, uid } = await loadForUser('invalid');
      await expect(feature.clearBucket(uid, name)).rejects.toThrow('invalid bucket name');
    },
  );

  it('returns bytes freed, removes the bucket, and is idempotent', async () => {
    const { feature, cacheRoot, uid } = await loadForUser('clear');
    const bucket = path.join(cacheRoot, 'marketplace');
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, 'content'), Buffer.alloc(7));

    await expect(feature.clearBucket(uid, 'marketplace')).resolves.toBe(7);
    expect(fs.existsSync(bucket)).toBe(false);
    await expect(feature.clearBucket(uid, 'marketplace')).resolves.toBe(0);
  });

  it('clears every visible bucket and reports the total', async () => {
    const { feature, cacheRoot, uid } = await loadForUser('all');
    for (const [name, size] of [['a', 2], ['b', 4]] as const) {
      fs.mkdirSync(path.join(cacheRoot, name), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, name, 'data'), Buffer.alloc(size));
    }

    await expect(feature.clearAllClearable(uid)).resolves.toBe(6);
    await expect(feature.listClearableBuckets(uid)).resolves.toEqual([]);
  });

  it('pins clear-all to the starting account when the active account changes', async () => {
    const { feature, cacheRoot: firstRoot } = await loadForUser('account-a');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secondRoot = paths.userLocalCacheDir('account-b');
    for (const cacheRoot of [firstRoot, secondRoot]) {
      fs.mkdirSync(path.join(cacheRoot, 'marketplace'), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, 'marketplace', 'data'), Buffer.alloc(5));
    }

    users.activateUser('account-a');
    const clearing = feature.clearAllClearable('account-a');
    users.activateUser('account-b');

    await expect(clearing).resolves.toBe(5);
    expect(fs.existsSync(path.join(firstRoot, 'marketplace'))).toBe(false);
    expect(fs.existsSync(path.join(secondRoot, 'marketplace', 'data'))).toBe(true);
  });

  it('never removes config, business data, search indexes, installs, or cloud sources', async () => {
    const uid = 'preserve';
    const { feature, cacheRoot } = await loadForUser(uid);
    const paths = await import('../../../src/main/paths');
    const protectedFiles = [
      path.join(paths.userLocalConfigDir(uid), 'preferences.json'),
      path.join(paths.userLocalBizDir(uid), 'marketplace.json'),
      path.join(paths.userSearchDir(uid), 'chats.idx.json'),
      path.join(paths.userMarketplaceDir(uid), 'agents', 'installed', 'agent.json'),
      path.join(root, uid, 'cloud', 'contexts', 'source.md'),
    ];
    fs.mkdirSync(path.join(cacheRoot, 'marketplace'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'marketplace', 'disposable'), 'cache');
    for (const file of protectedFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'keep');
    }

    await expect(feature.clearAllClearable(uid)).resolves.toBe(5);
    expect(fs.existsSync(path.join(cacheRoot, 'marketplace'))).toBe(false);
    expect(protectedFiles.every((file) => fs.readFileSync(file, 'utf8') === 'keep')).toBe(true);
  });

  it('turns the next Marketplace detail open into a refetch and rebuilds the cleared cache', async () => {
    const uid = 'rebuild';
    const { feature } = await loadForUser(uid);
    const cache = await import('../../../src/main/features/marketplace_cache');
    const marketplace = await import('../../../src/main/features/marketplace');
    const freshness = { version: '1.2.3', published_at: 123 };
    await cache.writeAgentCache('writer', { name: 'stale local copy' }, freshness, uid);

    await feature.clearBucket(uid, 'marketplace');
    expect(await cache.readAgentCache('writer', uid)).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      agent_json: { name: 'fresh server copy' },
      version: freshness.version,
      category: 'writing',
      published_at: freshness.published_at,
      agent_json_url: 'https://cdn.example.test/writer.json',
      create_uid: 'publisher',
      status: 'approved',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      await expect(marketplace.getAgentDetail('writer', freshness, uid)).resolves.toMatchObject({
        agent_json: { name: 'fresh server copy' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expect(cache.readAgentCache('writer', uid)).resolves.toEqual({
        name: 'fresh server copy',
      });
      await expect(cache.isCacheFresh('agent', 'writer', freshness, uid)).resolves.toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rebuilds Agent and Skill catalogs from their source data after clearing catalogs', async () => {
    const uid = 'catalog-rebuild';
    const { feature } = await loadForUser(uid);
    const paths = await import('../../../src/main/paths');
    const agentDir = path.join(root, uid, 'cloud', 'agents', 'cache-agent');
    const skillDir = path.join(root, uid, 'cloud', 'skills', 'cache-skill');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      agent_id: 'cache-agent',
      name: 'Cache Agent',
      description: 'catalog rebuild agent',
      category: 'general',
      workflow: '',
      created_at: '2026-07-26T00:00:00.000Z',
      updated_at: '2026-07-26T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: Cache Skill',
      'description: catalog rebuild skill',
      '---',
      '',
      '# Cache Skill',
    ].join('\n'));

    const agents = await import('../../../src/main/features/agents');
    const skills = await import('../../../src/main/features/skills');
    expect((await agents.listAgents()).map((item) => item.name)).toContain('Cache Agent');
    expect((await skills.listSkills()).map((item) => item.name)).toContain('Cache Skill');

    const agentCache = paths.userAgentCatalogCacheFile(uid);
    const skillCache = paths.userSkillCatalogCacheFile(uid);
    expect(fs.existsSync(agentCache)).toBe(true);
    expect(fs.existsSync(skillCache)).toBe(true);

    await expect(feature.clearBucket(uid, 'catalogs')).resolves.toBeGreaterThan(0);
    expect(fs.existsSync(agentCache)).toBe(false);
    expect(fs.existsSync(skillCache)).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);

    vi.resetModules();
    const restartedUsers = await import('../../../src/main/features/users');
    restartedUsers.activateUser(uid);
    const restartedAgents = await import('../../../src/main/features/agents');
    const restartedSkills = await import('../../../src/main/features/skills');
    expect((await restartedAgents.listAgents()).map((item) => item.name)).toContain('Cache Agent');
    expect((await restartedSkills.listSkills()).map((item) => item.name)).toContain('Cache Skill');
    expect(fs.existsSync(agentCache)).toBe(true);
    expect(fs.existsSync(skillCache)).toBe(true);
  });

  it('surfaces a stable failure without logging a private filesystem path', async () => {
    const { feature, cacheRoot, uid } = await loadForUser('failure');
    const bucket = path.join(cacheRoot, 'marketplace');
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, 'content'), 'secret');
    fsPromiseMocks.rm.mockRejectedValueOnce(
      Object.assign(new Error(`EPERM removing ${bucket}`), { code: 'EPERM' }),
    );

    await expect(feature.clearBucket(uid, 'marketplace')).rejects.toMatchObject({
      message: 'cache_clear_failed',
    });
    expect(fs.existsSync(bucket)).toBe(true);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(root);
  });
});
