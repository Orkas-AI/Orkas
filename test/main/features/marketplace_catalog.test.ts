import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarketplaceCatalogReader } from '../../../src/main/features/marketplace_catalog';

const postJson = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/features/marketplace', () => ({ postJson }));
beforeEach(() => { postJson.mockReset(); });

describe('marketplace catalog batch reads', () => {
  it.each(['agents', 'skills'] as const)('bounds %s requests, reuses results and fetches only new ids', async (kind) => {
    const ids = Array.from({ length: 2005 }, (_, i) => `item-${i}`);
    postJson.mockImplementation(async (_path, body) => ({
      list: body.ids.slice((body.page - 1) * body.size, body.page * body.size)
        .map((id: string) => ({ id, version: '2.0.0' })), total: body.ids.length,
    }));
    const reader = createMarketplaceCatalogReader();
    const rows = await reader.read(kind, [...ids, ids[0]]);
    expect([...rows.keys()]).toEqual(ids);
    expect(postJson.mock.calls.map(([, body]) => body.ids.length)).toEqual([...Array(20).fill(2000), 5]);
    expect(postJson.mock.calls.every(([endpoint]) => endpoint === `/marketplace/${kind}/list`)).toBe(true);
    await reader.read(kind, ids.slice(50));
    expect(postJson).toHaveBeenCalledTimes(21);
    await reader.read(kind, [ids[0], 'new-install']);
    expect(postJson).toHaveBeenLastCalledWith(`/marketplace/${kind}/list`, { page: 1, size: 100, ids: ['new-install'] });
  });

  it('paginates an old Server that ignores ids and excludes unrelated rows', async () => {
    postJson.mockResolvedValueOnce({ list: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}` })), total: 102 })
      .mockResolvedValueOnce({ list: [{ id: 'wanted', version: '2.0.0' }, { id: 'other-last' }], total: 102 });
    const reader = createMarketplaceCatalogReader();
    expect([...(await reader.read('skills', ['wanted', 'missing'])).keys()]).toEqual(['wanted']);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls[1][1].page).toBe(2);
    expect(await reader.read('skills', ['missing'])).toEqual(new Map());
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it('does not treat a malformed or truncated catalog as proof of missing installs', async () => {
    const reader = createMarketplaceCatalogReader();
    postJson.mockResolvedValueOnce({});
    await expect(reader.read('agents', ['wanted'])).rejects.toThrow('invalid marketplace catalog');
    postJson.mockResolvedValue({ list: Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}` })), total: 3000 });
    await expect(reader.read('agents', ['wanted'])).rejects.toThrow('pagination limit');
    expect(postJson).toHaveBeenCalledTimes(21);
    postJson.mockResolvedValue({ list: [{ id: 'wanted' }], total: 1 });
    expect((await reader.read('agents', ['wanted'])).has('wanted')).toBe(true);
  });

  it('batches legacy Agent names, rejects community and near-name matches, and shares resolved ids', async () => {
    postJson.mockResolvedValue({ list: [
      { id: 'community', name: 'Writer', create_uid: 'another-user' },
      { id: 'near-match', name: 'Writer Plus', create_uid: '0' },
      { id: 'official', name: 'Writer', create_uid: '0' },
      { id: 'researcher', name: 'Researcher', create_uid: '0' },
    ], total: 4 });
    const reader = createMarketplaceCatalogReader();
    const rows = await reader.readAgentNames(['Writer', 'Researcher', 'Missing']);
    expect([...rows.values()].map(row => row.id)).toEqual(['official', 'researcher']);
    expect(postJson).toHaveBeenCalledExactlyOnceWith('/marketplace/agents/list', {
      page: 1, size: 100, names: ['Writer', 'Researcher', 'Missing'],
    });
    expect((await reader.read('agents', ['official', 'researcher'])).size).toBe(2);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('shares pending lookups without turning a failed request into a missing row', async () => {
    let reject!: (err: Error) => void;
    postJson.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const reader = createMarketplaceCatalogReader();
    const first = reader.read('skills', ['wanted']);
    const second = reader.read('skills', ['wanted']);
    const result = Promise.allSettled([first, second]);
    reject(new Error('fixture offline'));
    expect((await result).map(row => row.status)).toEqual(['rejected', 'rejected']);
    expect(postJson).toHaveBeenCalledTimes(1);
    postJson.mockResolvedValue({ list: [{ id: 'wanted' }], total: 1 });
    expect((await reader.read('skills', ['wanted'])).has('wanted')).toBe(true);
  });

  it('stops after account cancellation and does not reuse snapshots in the next pass', async () => {
    let active = true;
    postJson.mockImplementationOnce(async () => { active = false; return { list: [], total: 0 }; });
    await expect(createMarketplaceCatalogReader(() => active).read('agents', ['wanted'])).rejects.toThrow('cancelled');
    postJson.mockResolvedValue({ list: [{ id: 'wanted', version: '2.0.0' }], total: 1 });
    expect((await createMarketplaceCatalogReader().read('agents', ['wanted'])).get('wanted')?.version).toBe('2.0.0');
    expect(postJson).toHaveBeenCalledTimes(2);
  });
});
