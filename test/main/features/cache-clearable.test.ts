import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


let root: string;

beforeEach(() => {
  vi.resetModules();
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
  return { feature, cacheRoot: paths.userLocalCacheDir(uid) };
}

describe('clearable cache', () => {
  it('returns an empty list when the cache root is absent', async () => {
    const { feature } = await loadForUser('empty');
    expect(await feature.listClearableBuckets()).toEqual([]);
  });

  it('lists visible top-level directories with recursive sizes and newest mtime', async () => {
    const { feature, cacheRoot } = await loadForUser('list');
    fs.mkdirSync(path.join(cacheRoot, 'zeta', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'zeta', 'a.bin'), Buffer.alloc(3));
    fs.writeFileSync(path.join(cacheRoot, 'zeta', 'nested', 'b.bin'), Buffer.alloc(5));
    fs.writeFileSync(path.join(cacheRoot, 'alpha', 'c.bin'), Buffer.alloc(2));
    fs.writeFileSync(path.join(cacheRoot, 'root-file'), 'ignored');

    const buckets = await feature.listClearableBuckets();

    expect(buckets.map((item) => item.name)).toEqual(['alpha', 'zeta']);
    expect(buckets.map((item) => item.bytes)).toEqual([2, 8]);
    expect(buckets.every((item) => item.last_modified > 0)).toBe(true);
  });

  it.each(['', '.', '..', '../outside', 'a/b', 'a\\b'])(
    'rejects unsafe bucket name %j',
    async (name) => {
      const { feature } = await loadForUser('invalid');
      await expect(feature.clearBucket(name)).rejects.toThrow('invalid bucket name');
    },
  );

  it('returns bytes freed, removes the bucket, and is idempotent', async () => {
    const { feature, cacheRoot } = await loadForUser('clear');
    const bucket = path.join(cacheRoot, 'marketplace');
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, 'content'), Buffer.alloc(7));

    await expect(feature.clearBucket('marketplace')).resolves.toBe(7);
    expect(fs.existsSync(bucket)).toBe(false);
    await expect(feature.clearBucket('marketplace')).resolves.toBe(0);
  });

  it('clears every visible bucket and reports the total', async () => {
    const { feature, cacheRoot } = await loadForUser('all');
    for (const [name, size] of [['a', 2], ['b', 4]] as const) {
      fs.mkdirSync(path.join(cacheRoot, name), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, name, 'data'), Buffer.alloc(size));
    }

    await expect(feature.clearAllClearable()).resolves.toBe(6);
    await expect(feature.listClearableBuckets()).resolves.toEqual([]);
  });
});
