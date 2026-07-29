/**
 * Clearable-cache umbrella.
 *
 * `<uid>/local/cache/<bucket>/` is the convention for caches the user is allowed to wipe via
 * a "clear cache" UI button. Whatever drops into `cache/` is fair game — losing it just
 * triggers a refetch / rebuild. Distinct from:
 *
 *   - `local/config/`  — machine-private preferences (auth-profiles, device-local prefs, …) ← NEVER clear
 *   - `local/biz/`     — server-sourced reference data (marketplace categories, …) ← refresh-on-need
 *   - `local/search/`  — derived indexes, but self-healing via reconcile          ← currently outside this umbrella
 *
 * Main exposes the utility through account-scoped IPC. This branch has no Renderer settings
 * entry for it. The actual files/subdirs inside a bucket are the owning feature's business;
 * this module only knows top-level dir names.
 *
 * Currently inhabited by:
 *   - `marketplace/`  — marketplace content cache (features/marketplace_cache.ts)
 *   - `catalogs/`     — versioned Agent/Skill list snapshots (features/agents.ts + skills.ts)
 *
 * Future migration candidates (NOT yet moved — would need each owner to update its path
 * helpers): `file_cache/` → `cache/file_cache/`, `tool-results/` → `cache/tool-results/`.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalCacheDir } from '../paths';
import { createLogger } from '../logger';
import { logErrorSummary } from '../util/log-redact';

const log = createLogger('cache_clearable');

export interface ClearableBucket {
  name: string;
  bytes: number;
  /** Newest mtime under the bucket, ms. 0 when bucket is empty / unreadable. */
  last_modified: number;
}

function _cacheClearFailed(): Error & { code: string } {
  return Object.assign(new Error('cache_clear_failed'), { code: 'E_CACHE_CLEAR_FAILED' });
}

function _isSafeBucketName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** Enumerate top-level subdirs of `<uid>/local/cache/`. Each is a bucket. Missing dir → []. */
export async function listClearableBuckets(userId: string): Promise<ClearableBucket[]> {
  const root = userLocalCacheDir(userId);
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('clearable cache list failed', { error: logErrorSummary(err) });
    throw _cacheClearFailed();
  }
  const out: ClearableBucket[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only expose names that the single-bucket API can safely accept. A
    // corrupt/foreign directory must not make "clear all" fail before valid
    // product-owned buckets are reclaimed.
    if (!_isSafeBucketName(entry.name)) continue;
    const dir = path.join(root, entry.name);
    out.push({ name: entry.name, bytes: _dirSize(dir), last_modified: _newestMtime(dir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Wipe one bucket (`<uid>/local/cache/<name>/`). Returns bytes freed. No-op when missing. */
export async function clearBucket(userId: string, name: string): Promise<number> {
  if (!_isSafeBucketName(name)) {
    throw new Error('invalid bucket name');
  }
  const dir = path.join(userLocalCacheDir(userId), name);
  if (!fs.existsSync(dir)) return 0;
  const bytes = _dirSize(dir);
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (err) {
    log.warn('clearable cache bucket removal failed', {
      bucket: name,
      error: logErrorSummary(err),
    });
    throw _cacheClearFailed();
  }
  log.info(`cleared bucket=${name} freed=${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return bytes;
}

/** Wipe every bucket under `<uid>/local/cache/`. Returns total bytes freed. Safe on empty
 *  cache root. */
export async function clearAllClearable(userId: string): Promise<number> {
  const buckets = await listClearableBuckets(userId);
  let total = 0;
  for (const b of buckets) total += await clearBucket(userId, b.name);
  return total;
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

function _newestMtime(dir: string): number {
  let newest = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      try {
        const stat = fs.statSync(full);
        if (e.isDirectory()) {
          const sub = _newestMtime(full);
          if (sub > newest) newest = sub;
        } else {
          if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return newest;
}
