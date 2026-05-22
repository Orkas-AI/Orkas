/**
 * Marketplace business-data: category registry mirror.
 *
 * The server owns the authoritative `marketplace_categories` table; PC mirrors it locally with
 * a 24h TTL so create-agent / create-skill dialogs (and the marketplace browse page) have an
 * answer even when offline / on cold start. Per PC/CLAUDE.md §4:
 *
 *   <uid>/local/biz/marketplace.json   ← THIS module
 *
 * Distinct from `local/cache/` (user-clearable) and `local/config/` (user preferences) — biz
 * data is server-sourced reference content; losing it just triggers a refetch. Lazy refresh
 * only: callers go through `getMarketplaceCategories()` and we transparently refetch when the
 * persisted copy is older than the TTL, falling back to (a) the stale cache, then (b) a
 * hard-coded default list, so the dropdown is never empty.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { marketplaceBizFile, userLocalBizDir } from '../paths';
import { getActiveUserId } from './users';
import { apiBase } from './marketplace';
import { createLogger } from '../logger';

const log = createLogger('marketplace_biz');

const TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours

// In-memory mirror of `marketplace.json::categories`. Populated on first read from disk; refreshed
// on every successful server fetch. Skips the fs + JSON.parse round-trip when the IPC handler is
// called rapidly (renderer can hit `getMarketplaceCategories` every time it opens the marketplace
// panel; without this we'd re-read the file each time even though TTL is 24h).
let _memCache: { fetched_at: number; list: MarketplaceCategory[] } | null = null;
let _memCacheUid: string | null = null;  // invalidated on uid switch

export interface MarketplaceCategory {
  code: string;
  name_zh: string;
  name_en: string;
  name_ja?: string;
  /** Display order — lower first. Kept on the wire purely for client-side rendering. */
  sort_order: number;
}

/** Hard-coded fallback used only when both the persisted cache and the server are unreachable
 *  on a cold start. Mirrors the server category registry so the UI behaves identically when
 *  the network blip clears. Keep in sync with `Server/biz/marketplace/marketplace_mgr.py`. */
const FALLBACK_CATEGORIES: readonly MarketplaceCategory[] = [
  { code: 'education', name_zh: '教育', name_en: 'Education',  name_ja: '教育',        sort_order: 10 },
  { code: 'ecommerce', name_zh: '电商', name_en: 'E-commerce', name_ja: 'EC',          sort_order: 20 },
  { code: 'rnd',       name_zh: '产研', name_en: 'R&D',        name_ja: '研究開発',    sort_order: 30 },
  { code: 'writing',   name_zh: '写作', name_en: 'Writing',    name_ja: 'ライティング', sort_order: 40 },
  { code: 'data',      name_zh: '数据', name_en: 'Data',       name_ja: 'データ',      sort_order: 50 },
  { code: 'general',   name_zh: '通用', name_en: 'General',    name_ja: '汎用',        sort_order: 60 },
];

interface PersistedBiz {
  categories?: {
    fetched_at: number;
    list: MarketplaceCategory[];
  };
}

async function _readPersisted(): Promise<PersistedBiz> {
  const file = marketplaceBizFile(getActiveUserId());
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as PersistedBiz;
  } catch (err) {
    log.warn(`read ${file} failed: ${(err as Error).message}`);
    return {};
  }
}

async function _writePersisted(data: PersistedBiz): Promise<void> {
  const dir = userLocalBizDir(getActiveUserId());
  await fsp.mkdir(dir, { recursive: true });
  const file = marketplaceBizFile(getActiveUserId());
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function _fetchFromServer(): Promise<MarketplaceCategory[]> {
  const res = await fetch(`${apiBase()}/marketplace/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { code: number; msg?: string; list?: unknown };
  if (data.code !== 0) throw new Error(data.msg || `code=${data.code}`);
  const list = Array.isArray(data.list) ? data.list : [];
  // Normalize: keep only the fields PC needs; tolerate any drift on the server side.
  return list
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .map((row) => ({
      code: String(row.code || ''),
      name_zh: String(row.name_zh || ''),
      name_en: String(row.name_en || ''),
      name_ja: String(row.name_ja || ''),
      sort_order: typeof row.sort_order === 'number' ? row.sort_order : 0,
    }))
    .filter((c) => c.code);
}

/** Return the active category list. Reads from in-memory cache first, falls back to the
 *  persisted file, falls back to the server, falls back to the hard-coded default — so the UI
 *  always has a list to render. Sorted by sort_order ASC then code ASC for deterministic UI. */
export async function getMarketplaceCategories(): Promise<MarketplaceCategory[]> {
  const uid = getActiveUserId();
  if (_memCacheUid !== uid) { _memCache = null; _memCacheUid = uid; }   // uid switch invalidates
  const now = Date.now();

  // Fast path: in-memory hit within TTL.
  if (_memCache && (now - _memCache.fetched_at) <= TTL_MS) {
    return _sort(_memCache.list);
  }

  // Cold or expired — try persisted file first (cheap), then server.
  const persisted = await _readPersisted();
  const cached = persisted.categories;
  if (cached && (now - cached.fetched_at) <= TTL_MS) {
    _memCache = cached;
    return _sort(cached.list);
  }

  try {
    const fresh = await _fetchFromServer();
    if (fresh.length > 0) {
      const entry = { fetched_at: now, list: fresh };
      _memCache = entry;
      await _writePersisted({ ...persisted, categories: entry });
      return _sort(fresh);
    }
    log.warn('server returned empty categories; keeping cached/fallback');
  } catch (err) {
    log.warn(`fetch categories failed: ${(err as Error).message}`);
  }

  if (cached && cached.list.length > 0) { _memCache = cached; return _sort(cached.list); }
  const fallback = [...FALLBACK_CATEGORIES] as MarketplaceCategory[];
  _memCache = { fetched_at: 0, list: fallback };  // fetched_at=0 so it expires immediately
  return _sort(fallback);
}

/** Boot-time priming. Called from `main/index.ts` after user activation so the first
 *  `openMarketplace` IPC roundtrip finds the in-memory cache hot. Errors are swallowed —
 *  failure is recovered by the lazy path. */
export async function primeCategoryCache(): Promise<void> {
  try { await getMarketplaceCategories(); }
  catch { /* swallowed — lazy fallback will recover */ }
}

function _sort(list: MarketplaceCategory[]): MarketplaceCategory[] {
  return [...list].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.code.localeCompare(b.code);
  });
}
