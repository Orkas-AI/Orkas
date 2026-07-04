/**
 * Marketplace content cache.
 *
 * Lives under `<uid>/local/cache/marketplace/{agents,skills}/<id>/` — the user-clearable cache
 * umbrella defined in `paths.ts`. Two responsibilities:
 *
 *   1. Cache reads/writes for agent.json + skill bundles (PC fetches once into here, both detail
 *      page render and install copy from the cache).
 *   2. `sweepIfNeeded()` — entry-time GC: when total cache > 100 MB OR any entry's
 *      `last_used_at` > 7d ago, evict expired then LRU-trim until size ≤ 80 MB.
 *
 * Cache hit rule (`isCacheFresh`): persisted `_cache.json` must carry `version` + freshness
 * timestamp matching the server-list row for this id. Any mismatch (uploader republished) ⇒ miss,
 * caller refetches. The install target lives separately at `<uid>/local/marketplace/{agents,
 * skills}/<id>/` with its own `_install.json` version pin (read by `marketplace_reconcile.ts`).
 * The cache is a strictly local staging area and may be cleared by the user without touching
 * installs.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  marketplaceCacheAgentDir,
  marketplaceCacheAgentsDir,
  marketplaceCacheDir,
  marketplaceCacheSkillDir,
  marketplaceCacheSkillsDir,
  marketplaceListingsCacheFile,
} from '../paths';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { withMarketplaceCacheLock } from './marketplace_locks';

const log = createLogger('marketplace_cache');

// Sweep thresholds — both per PC/CLAUDE.md §4 marketplace-cache rule.
const SWEEP_MAX_BYTES = 100 * 1024 * 1024;   // 100 MB hard cap (triggers LRU eviction)
const SWEEP_TARGET_BYTES = 80 * 1024 * 1024; // evict down to this after a sweep
const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days idle = expired

export interface CacheMeta {
  /** Server agent_id / skill_id this directory caches. */
  server_id: string;
  /** `marketplace_<kind>s.version` at fetch time — used for staleness check. */
  version: string;
  /** `marketplace_<kind>s.published_at` (ms) at fetch time — staleness check. */
  published_at: number;
  /** `marketplace_<kind>s.updated_at` (ms) at fetch time. Preferred staleness key because
   *  republishing keeps `published_at` stable. Optional for older cache entries. */
  updated_at?: number;
  /** When the bytes landed on disk (ms). */
  fetched_at: number;
  /** Bumped on every detail-page read or install. Drives LRU eviction. */
  last_used_at: number;
}

function _metaFile(dir: string): string { return path.join(dir, '_cache.json'); }

async function _readMeta(dir: string): Promise<CacheMeta | null> {
  const f = _metaFile(dir);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(await fsp.readFile(f, 'utf8')) as CacheMeta; }
  catch { return null; }
}

async function _writeMeta(dir: string, meta: CacheMeta): Promise<void> {
  await fsp.writeFile(_metaFile(dir), JSON.stringify(meta, null, 2), 'utf8');
}

function _freshnessAt(row: { published_at: number; updated_at?: number }): number {
  return typeof row.updated_at === 'number' ? row.updated_at : row.published_at;
}

/** Hit check. Caller passes the server-list row's `version` + freshness timestamp; both must match
 *  the cached values. The cache dir itself existing is necessary but not sufficient — a
 *  half-written dir would also exist, hence the field comparison. */
export async function isCacheFresh(kind: 'agent' | 'skill', id: string, expect: { version: string; published_at: number; updated_at?: number }): Promise<boolean> {
  const dir = _cacheDir(kind, id);
  if (!fs.existsSync(dir)) return false;
  const meta = await _readMeta(dir);
  if (!meta) return false;
  if (meta.version !== expect.version) return false;
  if (_freshnessAt(meta) !== _freshnessAt(expect)) return false;
  return true;
}

function _cacheDir(kind: 'agent' | 'skill', id: string): string {
  const uid = getActiveUserId();
  return kind === 'agent' ? marketplaceCacheAgentDir(uid, id) : marketplaceCacheSkillDir(uid, id);
}

/** Touch `last_used_at` to now — call after a successful detail-page render OR install copy. */
export async function touchCacheEntry(kind: 'agent' | 'skill', id: string): Promise<void> {
  const dir = _cacheDir(kind, id);
  const meta = await _readMeta(dir);
  if (!meta) return;
  meta.last_used_at = Date.now();
  try { await _writeMeta(dir, meta); }
  catch (err) { log.warn(`touch ${kind}:${id} failed: ${(err as Error).message}`); }
}

/** Write a fresh agent.json cache. Replaces the directory wholesale (prevents stale files from
 *  a previous version surviving). Sentinel-style atomic write: meta is written last so a
 *  half-written entry fails `isCacheFresh`. */
export async function writeAgentCache(
  id: string, agentJson: Record<string, unknown>, meta: { version: string; published_at: number; updated_at?: number },
): Promise<void> {
  const uid = getActiveUserId();
  await withMarketplaceCacheLock(uid, 'agent', id, async () => {
    const dir = marketplaceCacheAgentDir(uid, id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf8');
    const now = Date.now();
    await _writeMeta(dir, {
      server_id: id, version: meta.version, published_at: meta.published_at,
      ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
      fetched_at: now, last_used_at: now,
    });
  });
}

/** Read cached agent.json content. Returns null if missing / unreadable. */
export async function readAgentCache(id: string): Promise<Record<string, unknown> | null> {
  const dir = _cacheDir('agent', id);
  const file = path.join(dir, 'agent.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

/** Write a fresh skill bundle cache. `extract` is called with the cache dir to actually unpack
 *  (e.g. adm-zip extractAllTo) — kept generic so the cache layer doesn't import adm-zip. */
export async function writeSkillCache(
  id: string,
  extract: (dir: string) => Promise<void> | void,
  meta: { version: string; published_at: number; updated_at?: number },
): Promise<void> {
  const uid = getActiveUserId();
  await withMarketplaceCacheLock(uid, 'skill', id, async () => {
    const dir = marketplaceCacheSkillDir(uid, id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await extract(dir);
    const now = Date.now();
    await _writeMeta(dir, {
      server_id: id, version: meta.version, published_at: meta.published_at,
      ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
      fetched_at: now, last_used_at: now,
    });
  });
}

/** Skill cache dir (caller copies its contents into the marketplace install dir, OR reads files
 *  directly for detail-page rendering). The `_cache.json` sentinel must NOT propagate to the
 *  install target — `installFromSkillCache` in `marketplace.ts` strips it on copy. */
export function getSkillCacheDir(id: string): string {
  return _cacheDir('skill', id);
}

/** Read a single file from the cached skill dir. Used by the detail-page file viewer. The
 *  caller-supplied `relFile` is path-sanitized so a tampered renderer payload can't escape
 *  the cache dir. Returns null on miss / unsafe path / I/O error. Reads up to 256 KB; bigger
 *  files are truncated with a marker so the detail view always renders within reasonable size. */
export async function readSkillCacheFile(id: string, relFile: string): Promise<string | null> {
  if (!relFile || relFile === '_cache.json') return null;
  const safe = _safeRel(relFile);
  if (!safe) return null;
  const dir = _cacheDir('skill', id);
  const target = path.resolve(dir, safe);
  if (!target.startsWith(path.resolve(dir) + path.sep) && target !== path.resolve(dir)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const MAX_BYTES = 256 * 1024;
  try {
    const buf = await fsp.readFile(target);
    if (buf.length > MAX_BYTES) {
      return buf.subarray(0, MAX_BYTES).toString('utf8') + '\n\n[…truncated]';
    }
    return buf.toString('utf8');
  } catch { return null; }
}

function _safeRel(rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../') || norm === '.' || norm === '') return null;
  if (norm.startsWith('/')) return null;
  return norm;
}

/** Return cached skill file list (relative paths, byte sizes). Used by the detail page's file
 *  tree. Skips _cache.json. */
export async function listSkillCacheFiles(id: string): Promise<{ path: string; bytes: number }[]> {
  const dir = _cacheDir('skill', id);
  if (!fs.existsSync(dir)) return [];
  const out: { path: string; bytes: number }[] = [];
  function walk(d: string, rel = ''): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '_cache.json' || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, childRel);
      else if (e.isFile()) {
        let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({ path: childRel, bytes: size });
      }
    }
  }
  walk(dir);
  return out;
}

// ── Listing-grid cache (cross-process) ────────────────────────────────────
// Persists the renderer's session-level `_mpListingsCache` so cold starts don't pay a full
// /list round-trip before the grid is populated. The renderer hydrates this on
// `openMarketplace` then immediately renders cached items + fires a background refresh.

export interface ListingsCacheEntry {
  items: unknown[];
  ts: number;
  categories?: unknown[];
  total?: number;
}
export interface ListingsCacheFile {
  version: 4;
  entries: Record<string, ListingsCacheEntry>;
}
const LISTINGS_VERSION = 4;

export async function getListingsCache(): Promise<ListingsCacheFile> {
  const file = marketplaceListingsCacheFile(getActiveUserId());
  return _readListingsCacheFile(file);
}

async function _readListingsCacheFile(file: string): Promise<ListingsCacheFile> {
  if (!fs.existsSync(file)) return { version: LISTINGS_VERSION, entries: {} };
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<ListingsCacheFile>;
    if (parsed.version !== LISTINGS_VERSION) {
      return { version: LISTINGS_VERSION, entries: {} };
    }
    const entries = (parsed && typeof parsed.entries === 'object' && parsed.entries)
      ? (parsed.entries as Record<string, ListingsCacheEntry>) : {};
    return { version: LISTINGS_VERSION, entries };
  } catch (err) {
    log.warn(`read listings cache failed: ${(err as Error).message}`);
    return { version: LISTINGS_VERSION, entries: {} };
  }
}

async function _writeListingsCacheFile(uid: string, entries: Record<string, ListingsCacheEntry>): Promise<void> {
  const file = marketplaceListingsCacheFile(uid);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const data: ListingsCacheFile = { version: LISTINGS_VERSION, entries };
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, file);
}

// Serialize writes so renderer-burst saves (multiple fresh listings landing back-to-back)
// don't trample each other. Atomic via temp + rename — partial writes never publish.
let _listingsWriteQueue: Promise<void> = Promise.resolve();
export function setListingsCache(entries: Record<string, ListingsCacheEntry>): Promise<void> {
  const uid = getActiveUserId();
  _listingsWriteQueue = _listingsWriteQueue.then(async () => {
    await _writeListingsCacheFile(uid, entries);
  }).catch((err) => {
    log.warn(`write listings cache failed: ${(err as Error).message}`);
  });
  return _listingsWriteQueue;
}

export function mergeListingsCache(entries: Record<string, ListingsCacheEntry>): Promise<void> {
  const uid = getActiveUserId();
  _listingsWriteQueue = _listingsWriteQueue.then(async () => {
    const file = marketplaceListingsCacheFile(uid);
    const current = await _readListingsCacheFile(file);
    await _writeListingsCacheFile(uid, {
      ...(current.entries || {}),
      ...entries,
    });
  }).catch((err) => {
    log.warn(`merge listings cache failed: ${(err as Error).message}`);
  });
  return _listingsWriteQueue;
}

// ── Sweep ─────────────────────────────────────────────────────────────────

/** Entry-point sweep: triggered once on each openMarketplace call. Cheap (O(N entries) stat).
 *  Returns bytes freed (0 when nothing to do). Idempotent / safe to no-op when cache is empty. */
export async function sweepIfNeeded(): Promise<number> {
  const root = marketplaceCacheDir(getActiveUserId());
  if (!fs.existsSync(root)) return 0;

  const entries = await _listAllEntries(root);
  if (entries.length === 0) return 0;

  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const now = Date.now();
  const hasExpired = entries.some((e) => (now - e.lastUsedAt) > SWEEP_MAX_AGE_MS);

  if (totalBytes <= SWEEP_MAX_BYTES && !hasExpired) return 0;  // nothing to do

  let freed = 0;
  // 1. Expire by age (always — even if we're under the size cap, stale entries should go).
  for (const entry of entries.filter((e) => (now - e.lastUsedAt) > SWEEP_MAX_AGE_MS)) {
    try { await fsp.rm(entry.dir, { recursive: true, force: true }); freed += entry.bytes; entry.dropped = true; }
    catch (err) { log.warn(`rm ${entry.dir} failed: ${(err as Error).message}`); }
  }

  // 2. If still over the cap, LRU-evict oldest until we hit the soft target.
  let remaining = totalBytes - freed;
  if (remaining > SWEEP_TARGET_BYTES) {
    const survivors = entries.filter((e) => !e.dropped).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of survivors) {
      if (remaining <= SWEEP_TARGET_BYTES) break;
      try {
        await fsp.rm(entry.dir, { recursive: true, force: true });
        freed += entry.bytes;
        remaining -= entry.bytes;
      } catch (err) {
        log.warn(`rm ${entry.dir} failed: ${(err as Error).message}`);
      }
    }
  }

  log.info(`sweep: freed ${(freed / 1024 / 1024).toFixed(1)} MB`);
  return freed;
}

interface SweepEntry { dir: string; bytes: number; lastUsedAt: number; dropped?: boolean }

async function _listAllEntries(root: string): Promise<SweepEntry[]> {
  const out: SweepEntry[] = [];
  for (const kindDir of [marketplaceCacheAgentsDir(getActiveUserId()), marketplaceCacheSkillsDir(getActiveUserId())]) {
    if (!fs.existsSync(kindDir)) continue;
    for (const sub of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const dir = path.join(kindDir, sub.name);
      const meta = await _readMeta(dir);
      if (!meta) {
        // Half-written / no-meta dir is fair game for sweep (treat as immediately expired).
        out.push({ dir, bytes: _dirSize(dir), lastUsedAt: 0 });
        continue;
      }
      out.push({ dir, bytes: _dirSize(dir), lastUsedAt: meta.last_used_at });
    }
  }
  return out;
}

function _dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += _dirSize(full);
      else if (e.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}
