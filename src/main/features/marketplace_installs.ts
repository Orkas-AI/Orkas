/**
 * Marketplace install manifest — `<uid>/cloud/marketplace/installs.json`.
 *
 * The ONLY marketplace state that crosses devices. Records what the user has installed (id +
 * version + freshness timestamp + COS URL); the actual content lives at `<uid>/local/marketplace/`
 * on each machine and is reconciled on startup by `features/marketplace_reconcile.ts`
 * (fetches whatever's listed in the manifest but missing locally).
 *
 * Manifest format:
 *
 *   {
 *     "version": 1,
 *     "agents": [
 *       { "id": "abc123def456", "version": "1.0.0", "published_at": 1747066800000,
 *         "updated_at": 1747067800000,
 *         "agent_json_url": "https://orkas-1367889399.cos.../agent.json",
 *         "agent_skills_bundle_url": "https://orkas-1367889399.cos.../skills.zip",
 *         "installed_at": 1747066800100 }
 *     ],
 *     "skills": [
 *       { "id": "xyz789...", "version": "1.0.0", "published_at": 1747066800000,
 *         "updated_at": 1747067800000,
 *         "bundle_url": "https://orkas-1367889399.cos.../xyz789.zip",
 *         "installed_at": 1747066800100 }
 *     ]
 *   }
 *
 * Single-writer rule: all mutations go through this module. Per-uid `Mutex` serializes the
 * read-modify-write cycle (writeInstalls is atomic via temp + rename, but the surrounding
 * `readInstalls → push → writeInstalls` sequence is not — concurrent `addSkillInstall` calls
 * during cascade install would otherwise lose rows). Read paths skip the lock; reading
 * mid-write is fine because we never publish a half-written manifest.
 *
 * **Schema versioning**: `CURRENT_VERSION` is bumped only on a breaking change (field
 * removed / required-shape changed). Additive changes (new optional field on AgentInstall /
 * SkillInstall) do NOT bump — `_isAgentRow` / `_isSkillRow` already tolerate unknown extra
 * fields. When a bump is needed:
 *   1. Bump `CURRENT_VERSION`.
 *   2. Add a migration branch in `readInstalls` that runs on `parsed.version < CURRENT_VERSION`
 *      and rewrites rows in place.
 *   3. Older PC versions reading a newer manifest fall through to the warn-only path below;
 *      they may drop rows they can't parse — that's the documented forward-compat cost.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { Mutex } from 'async-mutex';

import { userMarketplaceInstallsFile, userMarketplaceDirCloud } from '../paths';
import { createLogger } from '../logger';
import { isExpiredMsTombstone } from '../util/tombstone_retention';

const log = createLogger('marketplace_installs');

function _markInstallsDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('marketplace', 'cloud/marketplace/installs.json');
  } catch { /* sync feature may be stripped or not initialized yet */ }
}

// Per-uid mutex covering the RMW cycle of add*/remove* (read manifest → mutate → write).
// Concurrent cascade install (Promise.all over skill_list) used to lose rows because each
// task read the same baseline manifest and the last writeInstalls won. Read paths intentionally
// skip the lock — writeInstalls is atomic via temp+rename, so a reader sees either the full
// pre-state or full post-state.
const _writeLocks = new Map<string, Mutex>();
function _getWriteLock(uid: string): Mutex {
  let m = _writeLocks.get(uid);
  if (!m) { m = new Mutex(); _writeLocks.set(uid, m); }
  return m;
}

export interface AgentInstall {
  id: string;
  version: string;
  published_at: number;
  /** Server row update timestamp. Preferred freshness key because republish updates this
   *  while `published_at` remains the original first-publish time. Optional so old manifest
   *  rows still parse and fall back to `published_at`. */
  updated_at?: number;
  agent_json_url: string;
  /** Optional zip containing agent-private skills. The zip root is the agent's `skills/`
   *  directory, so entries look like `<skill_id>/SKILL.md`. Empty string means the server
   *  explicitly has no private skills; undefined means an old manifest row has not learned
   *  the field yet and reconcile may resolve it through `/agents/detail`. */
  agent_skills_bundle_url?: string;
  installed_at: number;
  /** Author uid as recorded on the server. `"0"` is the official-platform marker (label
   *  `marketplace.author_platform`); everything else is a community uploader. Optional
   *  in the type so old manifest rows (pre-2026-05-13) still parse —
   *  reconcile fills it in next time the row is re-pulled. UI uses this to render the
   *  author badge on the agent detail page. */
  create_uid?: string;
  /** Server-side fresh-install seed flag. Optional for old manifest rows. */
  default_install?: boolean;
  /** Marketplace review lifecycle status mirrored from the server row. */
  status?: string;
  /** Legacy local metadata name, read for compatibility during the status merge. */
  state?: string;
  /** Internal marker for install rows seeded from `resources/builtin/marketplace/`.
   *  These rows may start without server URLs; online resolution patches them
   *  into ordinary marketplace rows. */
  seed_source?: 'builtin' | string;
}

export interface SkillInstall {
  id: string;
  version: string;
  published_at: number;
  /** Same freshness semantics as `AgentInstall.updated_at`. */
  updated_at?: number;
  bundle_url: string;
  installed_at: number;
  /** Same as `AgentInstall.create_uid` — see comment there. */
  create_uid?: string;
  /** Same as `AgentInstall.default_install`. */
  default_install?: boolean;
  /** Same as `AgentInstall.status`. */
  status?: string;
  /** Legacy local metadata name, read for compatibility during the status merge. */
  state?: string;
  /** Same as `AgentInstall.seed_source`. */
  seed_source?: 'builtin' | string;
}

export const CURRENT_VERSION = 1;

export interface InstallsManifest {
  version: typeof CURRENT_VERSION;
  agents: AgentInstall[];
  skills: SkillInstall[];
  _deleted_at?: {
    agents?: Record<string, number>;
    skills?: Record<string, number>;
  };
}

const EMPTY: InstallsManifest = { version: CURRENT_VERSION, agents: [], skills: [] };

export const DEFAULT_MARKETPLACE_VERSION = '1.0.0';

export function normalizeInstallVersion(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || DEFAULT_MARKETPLACE_VERSION;
}

export async function readInstalls(uid: string): Promise<InstallsManifest> {
  const file = userMarketplaceInstallsFile(uid);
  if (!fs.existsSync(file)) return { ...EMPTY };
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<InstallsManifest> & { version?: unknown };
    const parsedVersion = typeof parsed.version === 'number' ? parsed.version : CURRENT_VERSION;
    if (parsedVersion > CURRENT_VERSION) {
      // Newer PC wrote this manifest. Best-effort: read every row that still matches our
      // schema, drop the rest. User loses some installs locally but the canonical state is
      // still in the manifest (next write by the newer PC will restore them).
      log.warn(`installs.json schema v${parsedVersion} > supported v${CURRENT_VERSION}; reading best-effort`);
    } else if (parsedVersion < CURRENT_VERSION) {
      // Older manifest. When a future bump introduces a real migration, dispatch here on
      // parsedVersion. For now there's no v0, so this branch is documentation-only.
      log.info(`installs.json schema v${parsedVersion} < v${CURRENT_VERSION}; no migration needed yet`);
    }
    return {
      version: CURRENT_VERSION,
      agents: Array.isArray(parsed.agents) ? parsed.agents.filter(_isAgentRow).map(_normalizeAgentRow) : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills.filter(_isSkillRow).map(_normalizeSkillRow) : [],
      ...(_readDeletedAt(parsed) ? { _deleted_at: _readDeletedAt(parsed) } : {}),
    };
  } catch (err) {
    log.warn(`read ${file} failed: ${(err as Error).message}`);
    return { ...EMPTY };
  }
}

/** Atomic write: temp file + rename. Caller is the single writer in this process.
 *  Always stamps `version: CURRENT_VERSION` regardless of the passed-in manifest's `version`
 *  field — guarantees forward-only schema progression even if a reader passes a stale value. */
export async function writeInstalls(uid: string, manifest: InstallsManifest): Promise<void> {
  await fsp.mkdir(userMarketplaceDirCloud(uid), { recursive: true });
  const file = userMarketplaceInstallsFile(uid);
  const tmp = `${file}.tmp`;
  const stamped = { ...manifest, version: CURRENT_VERSION };
  await fsp.writeFile(tmp, JSON.stringify(stamped, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  _markInstallsDirty();
}

export async function addAgentInstall(uid: string, row: Omit<AgentInstall, 'installed_at'> & { installed_at?: number }): Promise<void> {
  await _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const idx = manifest.agents.findIndex((a) => a.id === row.id);
    const previous = idx >= 0 ? manifest.agents[idx] : null;
    const entry: AgentInstall = {
      ...(previous || {}),
      ...row,
      version: normalizeInstallVersion(row.version || previous?.version),
      installed_at: row.installed_at || previous?.installed_at || Date.now(),
    };
    if (idx >= 0) manifest.agents[idx] = entry;
    else manifest.agents.push(entry);
    delete manifest._deleted_at?.agents?.[row.id];
    _pruneDeletedAt(manifest);
    await writeInstalls(uid, manifest);
    log.info(`agent installed id=${row.id} v${entry.version}`);
  });
}

export async function addSkillInstall(uid: string, row: Omit<SkillInstall, 'installed_at'> & { installed_at?: number }): Promise<void> {
  await _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const idx = manifest.skills.findIndex((s) => s.id === row.id);
    const previous = idx >= 0 ? manifest.skills[idx] : null;
    const entry: SkillInstall = {
      ...(previous || {}),
      ...row,
      version: normalizeInstallVersion(row.version || previous?.version),
      installed_at: row.installed_at || previous?.installed_at || Date.now(),
    };
    if (idx >= 0) manifest.skills[idx] = entry;
    else manifest.skills.push(entry);
    delete manifest._deleted_at?.skills?.[row.id];
    _pruneDeletedAt(manifest);
    await writeInstalls(uid, manifest);
    log.info(`skill installed id=${row.id} v${entry.version}`);
  });
}

export async function removeAgentInstall(uid: string, id: string): Promise<boolean> {
  return _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const before = manifest.agents.length;
    manifest.agents = manifest.agents.filter((a) => a.id !== id);
    if (manifest.agents.length === before) return false;
    _markDeleted(manifest, 'agents', id);
    await writeInstalls(uid, manifest);
    log.info(`agent uninstalled id=${id}`);
    return true;
  });
}

export async function removeSkillInstall(uid: string, id: string): Promise<boolean> {
  return _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const before = manifest.skills.length;
    manifest.skills = manifest.skills.filter((s) => s.id !== id);
    if (manifest.skills.length === before) return false;
    _markDeleted(manifest, 'skills', id);
    await writeInstalls(uid, manifest);
    log.info(`skill uninstalled id=${id}`);
    return true;
  });
}

export async function findAgentInstall(uid: string, id: string): Promise<AgentInstall | null> {
  const m = await readInstalls(uid);
  return m.agents.find((a) => a.id === id) || null;
}

export async function findSkillInstall(uid: string, id: string): Promise<SkillInstall | null> {
  const m = await readInstalls(uid);
  return m.skills.find((s) => s.id === id) || null;
}

function _isAgentRow(x: unknown): x is AgentInstall {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  // `create_uid` is intentionally not required — older rows pre-date the field.
  return typeof r.id === 'string' && typeof r.version === 'string'
    && typeof r.published_at === 'number' && typeof r.agent_json_url === 'string'
    && typeof r.installed_at === 'number';
}

function _isSkillRow(x: unknown): x is SkillInstall {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.version === 'string'
    && typeof r.published_at === 'number' && typeof r.bundle_url === 'string'
    && typeof r.installed_at === 'number';
}

function _normalizeAgentRow(row: AgentInstall): AgentInstall {
  return { ...row, version: normalizeInstallVersion(row.version) };
}

function _normalizeSkillRow(row: SkillInstall): SkillInstall {
  return { ...row, version: normalizeInstallVersion(row.version) };
}

function _readDeletedAt(parsed: Partial<InstallsManifest> & { version?: unknown }): InstallsManifest['_deleted_at'] | null {
  const raw = (parsed as any)._deleted_at;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: NonNullable<InstallsManifest['_deleted_at']> = {};
  for (const kind of ['agents', 'skills'] as const) {
    const bucket = raw[kind];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    const clean: Record<string, number> = {};
    for (const [id, value] of Object.entries(bucket as Record<string, unknown>)) {
      const n = Number(value);
      if (isExpiredMsTombstone(n)) continue;
      if (id && Number.isFinite(n) && n > 0) clean[id] = n;
    }
    if (Object.keys(clean).length > 0) out[kind] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function _markDeleted(manifest: InstallsManifest, kind: 'agents' | 'skills', id: string): void {
  manifest._deleted_at = manifest._deleted_at || {};
  manifest._deleted_at[kind] = manifest._deleted_at[kind] || {};
  manifest._deleted_at[kind]![id] = Date.now();
}

function _pruneDeletedAt(manifest: InstallsManifest): void {
  if (!manifest._deleted_at) return;
  for (const kind of ['agents', 'skills'] as const) {
    if (manifest._deleted_at[kind] && Object.keys(manifest._deleted_at[kind]!).length === 0) {
      delete manifest._deleted_at[kind];
    }
  }
  if (Object.keys(manifest._deleted_at).length === 0) delete manifest._deleted_at;
}
