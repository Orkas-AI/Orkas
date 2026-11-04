import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSnapshotCache, mapFileSnapshots } from '../../../src/main/util/file-snapshot';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-snapshot-'));
  roots.push(root);
  const file = path.join(root, 'source.json');
  fs.writeFileSync(file, 'first');
  return file;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('source-validated derived file snapshots', () => {
  it('shares concurrent reads, bounds retained data, and rereads after eviction', async () => {
    const file = fixture();
    const cache = new FileSnapshotCache<string>(value => value.length, 1, 8);
    const load = vi.fn(async () => fs.readFileSync(file, 'utf8'));
    expect(await Promise.all([cache.read(file, load), cache.read(file, load)])).toEqual(['first', 'first']);
    expect(load).toHaveBeenCalledTimes(1);
    const other = fixture();
    await cache.read(other, async () => 'second');
    await cache.read(file, load);
    expect(load).toHaveBeenCalledTimes(2);
    fs.writeFileSync(file, 'oversized');
    await cache.read(file, load); await cache.read(file, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('does not let an old in-flight read replace a synced newer snapshot', async () => {
    const file = fixture();
    const cache = new FileSnapshotCache<string>(value => value.length);
    let release!: (value: string) => void;
    const old = cache.read(file, () => new Promise<string>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const replacement = file + '.tmp';
    fs.writeFileSync(replacement, 'newer'); fs.renameSync(replacement, file);
    expect(await cache.read(file, async () => 'newer')).toBe('newer');
    release('first'); await old;
    const reread = vi.fn(async () => 'wrong');
    expect(await cache.read(file, reread)).toBe('newer');
    expect(reread).not.toHaveBeenCalled();
  });

  it('retries after failures and removes deleted source values', async () => {
    const file = fixture();
    const cache = new FileSnapshotCache<string>(value => value.length);
    await expect(cache.read(file, async () => { throw new Error('controlled read failure'); })).rejects.toThrow('controlled');
    expect(await cache.read(file, async () => 'first')).toBe('first');
    fs.rmSync(file);
    expect(await cache.read(file, async () => null)).toBeNull();
    fs.writeFileSync(file, 'again');
    expect(await cache.read(file, async () => 'again')).toBe('again');
  });

  it('keeps cold source reads bounded without losing input order', async () => {
    let active = 0, peak = 0;
    const values = await mapFileSnapshots(Array.from({ length: 40 }, (_, index) => index), async index => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return index;
    });
    expect(values).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(peak).toBeLessThanOrEqual(8);
  });
});
