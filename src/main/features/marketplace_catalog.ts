import { postJson } from './marketplace';

export type MarketplaceCatalogKind = 'agents' | 'skills';
export interface MarketplaceCatalogRow {
  id: string;
  name?: string;
  version?: string;
  published_at?: number;
  updated_at?: number;
  create_uid?: string;
  default_install?: boolean | number;
  status?: string;
  state?: string;
  min_app_version?: string;
  minAppVersion?: string;
  agent_json_url?: string;
  agent_skills_bundle_url?: string;
  bundle_url?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_IDS = 2000;

export interface MarketplaceCatalogReader {
  read(kind: MarketplaceCatalogKind, ids: string[]): Promise<Map<string, MarketplaceCatalogRow>>;
  readAgentNames(names: string[]): Promise<Map<string, MarketplaceCatalogRow>>;
}

/** One startup/update pass owns this reader. Never share it across accounts or
 * runs: both positive and missing results are snapshots, not durable caches. */
export function createMarketplaceCatalogReader(shouldContinue: () => boolean = () => true): MarketplaceCatalogReader {
  const cache = {
    agents: new Map<string, Promise<Map<string, MarketplaceCatalogRow>>>(),
    skills: new Map<string, Promise<Map<string, MarketplaceCatalogRow>>>(),
  };
  const assertActive = (): void => {
    if (!shouldContinue()) throw new Error('marketplace catalog cancelled');
  };
  async function fetchBatch(kind: MarketplaceCatalogKind, ids: string[], byName = false): Promise<Map<string, MarketplaceCatalogRow>> {
    const wanted = new Set(ids);
    const rows = new Map<string, MarketplaceCatalogRow>();
    // Old Servers ignore ids. Keep bounded pagination and exact client-side
    // filtering; unrelated catalog rows must never resolve an installation.
    for (let page = 1; page <= MAX_PAGES; page++) {
      assertActive();
      const response = await postJson<{ list: MarketplaceCatalogRow[]; total?: number }>(
        `/marketplace/${kind}/list`, { page, size: PAGE_SIZE, ...(byName ? { names: ids } : { ids }) },
      );
      assertActive();
      if (!Array.isArray(response?.list)) throw new Error('invalid marketplace catalog response');
      for (const row of response.list) {
        if (!row) continue;
        const key = byName ? String(row.name || '').trim() : row.id;
        if (byName && (!row.id || (row.create_uid || '0') !== '0')) continue;
        if (wanted.has(key) && !rows.has(key)) rows.set(key, row);
      }
      if (rows.size === wanted.size || response.list.length < PAGE_SIZE
          || (typeof response.total === 'number' && page * PAGE_SIZE >= response.total)) return rows;
    }
    // A truncated catalog cannot establish absence (callers may prune missing
    // installs). Leave the manifest untouched and retry on a later pass.
    throw new Error('marketplace catalog pagination limit reached');
  }
  return {
    async readAgentNames(names) {
      assertActive();
      const wanted = [...new Set(names.map(name => name.trim()).filter(Boolean))];
      const rows = new Map<string, MarketplaceCatalogRow>();
      for (let offset = 0; offset < wanted.length; offset += MAX_IDS) {
        for (const [name, row] of await fetchBatch('agents', wanted.slice(offset, offset + MAX_IDS), true)) rows.set(name, row);
      }
      const byId = Promise.resolve(new Map([...rows.values()].map(row => [row.id, row])));
      for (const row of rows.values()) cache.agents.set(row.id, byId);
      return rows;
    },
    async read(kind, ids) {
      assertActive();
      const wanted = [...new Set(ids.filter(Boolean))];
      const missing = wanted.filter(id => !cache[kind].has(id));
      for (let offset = 0; offset < missing.length; offset += MAX_IDS) {
        const batch = missing.slice(offset, offset + MAX_IDS);
        const pending = fetchBatch(kind, batch);
        for (const id of batch) {
          // Share the batch promise so concurrent consumers see failures too.
          cache[kind].set(id, pending);
        }
        try { await pending; } catch (error) {
          for (const id of batch) cache[kind].delete(id);
          throw error;
        }
      }
      const rows = new Map<string, MarketplaceCatalogRow>();
      for (const id of wanted) {
        const row = (await cache[kind].get(id))?.get(id);
        if (row) rows.set(id, row);
      }
      assertActive();
      return rows;
    },
  };
}
