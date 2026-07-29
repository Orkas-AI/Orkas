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
import { withCommonHeaders } from './api_common';
import { apiBase } from './marketplace';
import { createLogger } from '../logger';
import { fetchWithRetry } from '../util/retry';

const log = createLogger('marketplace_biz');

const TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const MARKETPLACE_CATEGORIES_TIMEOUT_MS = 60_000;
export const DEFAULT_MARKETPLACE_CATEGORY_CODE = 'general';

export interface MarketplaceCategory {
  code: string;
  name_zh: string;
  name_en: string;
  name_ja?: string;
  name_pt?: string;
  /** Display order — lower first. Kept on the wire purely for client-side rendering. */
  sort_order: number;
}

export function isSafeMarketplaceCategoryCode(code: string): boolean {
  return /^[a-z][a-z0-9_-]{0,79}$/.test(String(code || '').trim().toLowerCase());
}

export function normalizeMarketplaceCategoryCode(
  code: string,
  fallback = DEFAULT_MARKETPLACE_CATEGORY_CODE,
): string {
  const normalized = String(code || '').trim().toLowerCase();
  const canonical = normalized === 'writing' ? 'creation' : normalized;
  return isSafeMarketplaceCategoryCode(canonical) ? canonical : fallback;
}

/** Hard-coded fallback used only when both the persisted cache and the server are unreachable
 *  on a cold start. Mirrors the server category registry so the UI behaves identically when
 *  the network blip clears. Keep in sync with `Server/biz/marketplace/marketplace_mgr.py`. */
const FALLBACK_CATEGORIES: readonly MarketplaceCategory[] = [
  { code: 'education', name_zh: '教育', name_en: 'Education',  name_ja: '教育',        name_pt: 'Educação',    sort_order: 10 },
  { code: 'ecommerce', name_zh: '电商', name_en: 'E-commerce', name_ja: 'EC',          name_pt: 'E-commerce',  sort_order: 20 },
  { code: 'rnd',       name_zh: '产研', name_en: 'R&D',        name_ja: '研究開発',    name_pt: 'P&D',         sort_order: 30 },
  { code: 'creation',  name_zh: '创作', name_en: 'Creation',   name_ja: '創作',        name_pt: 'Criação',     sort_order: 40 },
  { code: 'data',      name_zh: '数据', name_en: 'Data',       name_ja: 'データ',      name_pt: 'Dados',       sort_order: 50 },
  { code: 'office',    name_zh: '办公', name_en: 'Office',     name_ja: 'オフィス',    name_pt: 'Escritório',  sort_order: 60 },
  { code: 'general',   name_zh: '通用', name_en: 'General',    name_ja: '汎用',        name_pt: 'Geral',       sort_order: 70 },
];

interface PersistedBiz {
  categories?: {
    fetched_at: number;
    list: MarketplaceCategory[];
  };
}

type CategoryCacheEntry = NonNullable<PersistedBiz['categories']>;
type CategoryMemCache = CategoryCacheEntry & { uid: string };

// Keep the uid and payload in one object so overlapping account requests
// cannot leave a new uid paired with an old uid's list.
let _memCache: CategoryMemCache | null = null;

function _errorCode(err: unknown): string {
  return String((err as NodeJS.ErrnoException)?.code || 'unknown');
}

function _normalizeCategoryList(value: unknown): MarketplaceCategory[] {
  if (!Array.isArray(value)) return [];
  const byCode = new Map<string, MarketplaceCategory>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const code = normalizeMarketplaceCategoryCode(String(row.code || ''), '');
    if (!code || byCode.has(code)) continue;
    const sortOrder = typeof row.sort_order === 'number' && Number.isFinite(row.sort_order)
      ? row.sort_order
      : 0;
    byCode.set(code, {
      code,
      name_zh: String(row.name_zh || '').trim() || code,
      name_en: String(row.name_en || '').trim() || code,
      name_ja: String(row.name_ja || '').trim(),
      name_pt: String(row.name_pt || '').trim(),
      sort_order: sortOrder,
    });
  }
  return Array.from(byCode.values());
}

function _isFresh(entry: CategoryCacheEntry, now: number): boolean {
  return Number.isFinite(entry.fetched_at)
    && entry.fetched_at > 0
    && entry.fetched_at <= now
    && (now - entry.fetched_at) <= TTL_MS;
}

function _cacheForActiveUser(uid: string, entry: CategoryCacheEntry): void {
  try {
    if (getActiveUserId() !== uid) return;
  } catch {
    return;
  }
  _memCache = { uid, fetched_at: entry.fetched_at, list: entry.list };
}

async function _readPersisted(uid: string): Promise<PersistedBiz> {
  const file = marketplaceBizFile(uid);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    const parsed = raw && typeof raw === 'object' ? raw as PersistedBiz : {};
    const list = _normalizeCategoryList(parsed.categories?.list);
    if (!list.length) return { ...parsed, categories: undefined };
    const fetchedAt = Number(parsed.categories?.fetched_at);
    return {
      ...parsed,
      categories: {
        fetched_at: Number.isFinite(fetchedAt) ? fetchedAt : 0,
        list,
      },
    };
  } catch (err) {
    log.warn(`persisted categories read failed code=${_errorCode(err)}`);
    return {};
  }
}

async function _writePersisted(uid: string, data: PersistedBiz): Promise<void> {
  const dir = userLocalBizDir(uid);
  await fsp.mkdir(dir, { recursive: true });
  const file = marketplaceBizFile(uid);
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function _fetchFromServer(): Promise<MarketplaceCategory[]> {
  const res = await fetchWithRetry('marketplace:categories', `${apiBase()}/marketplace/categories`, {
    method: 'POST',
    headers: withCommonHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  }, {
    timeoutMs: MARKETPLACE_CATEGORIES_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { code: number; msg?: string; list?: unknown };
  if (data.code !== 0) throw new Error(data.msg || `code=${data.code}`);
  // Keep only safe, canonical fields. A malformed registry row must not create
  // duplicate/unsafe filter values in the renderer or poison the disk cache.
  return _normalizeCategoryList(data.list);
}

/** Return the active category list. Reads from in-memory cache first, falls back to the
 *  persisted file, falls back to the server, falls back to the hard-coded default — so the UI
 *  always has a list to render. `localOnly` returns cache/fallback immediately for UI surfaces
 *  that must not block their first paint on the network. Sorted by sort_order ASC then code ASC. */
export async function getMarketplaceCategories(
  opts: { localOnly?: boolean; forceRefresh?: boolean } = {},
): Promise<MarketplaceCategory[]> {
  const uid = getActiveUserId();
  const now = Date.now();
  const forceRefresh = opts.forceRefresh && !opts.localOnly;

  // Fast path: in-memory hit within TTL. Local-only callers also accept stale data because the
  // category registry is config-like and they are optimizing for immediate dialog paint.
  if (!forceRefresh
      && _memCache?.uid === uid
      && _memCache.list.length > 0
      && (opts.localOnly || _isFresh(_memCache, now))) {
    return _sort(_memCache.list);
  }

  // Cold or expired — try persisted file first (cheap), then server.
  const persisted = await _readPersisted(uid);
  const cached = persisted.categories;
  if (!forceRefresh && cached && (opts.localOnly || _isFresh(cached, now))) {
    _cacheForActiveUser(uid, cached);
    return _sort(cached.list);
  }

  if (opts.localOnly) {
    const fallback = [...FALLBACK_CATEGORIES] as MarketplaceCategory[];
    _cacheForActiveUser(uid, { fetched_at: 0, list: fallback });
    return _sort(fallback);
  }

  try {
    const fresh = await _fetchFromServer();
    if (fresh.length > 0) {
      const entry = { fetched_at: now, list: fresh };
      _cacheForActiveUser(uid, entry);
      try {
        await _writePersisted(uid, { ...persisted, categories: entry });
      } catch (err) {
        // This is a disposable offline cache. A read-only/full local disk must
        // not hide a valid Server registry from the current Marketplace view.
        log.warn(`persisted categories write failed code=${_errorCode(err)}`);
      }
      return _sort(fresh);
    }
    log.warn('server returned empty categories; keeping cached/fallback');
  } catch (err) {
    log.warn(`fetch categories failed code=${_errorCode(err)}`);
  }

  if (cached && cached.list.length > 0) {
    _cacheForActiveUser(uid, cached);
    return _sort(cached.list);
  }
  const fallback = [...FALLBACK_CATEGORIES] as MarketplaceCategory[];
  // fetched_at=0 means the next non-local call retries the Server immediately.
  _cacheForActiveUser(uid, { fetched_at: 0, list: fallback });
  return _sort(fallback);
}

/** Boot-time priming. Called from `main/index.ts` after user activation so the first
 *  `openMarketplace` IPC roundtrip finds the in-memory cache hot. Startup callers pass
 *  `localOnly` to avoid spending first-paint bandwidth on reference data; the normal lazy
 *  path still refreshes from Server when the marketplace UI needs fresh data. */
export async function primeCategoryCache(opts: { localOnly?: boolean } = {}): Promise<void> {
  try { await getMarketplaceCategories({ localOnly: opts.localOnly }); }
  catch { /* swallowed — lazy fallback will recover */ }
}

function _sort(list: MarketplaceCategory[]): MarketplaceCategory[] {
  return [...list].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.code.localeCompare(b.code);
  });
}
