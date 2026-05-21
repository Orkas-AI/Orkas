/**
 * Marketplace install manifest — `<uid>/cloud/marketplace/installs.json`.
 *
 * The ONLY marketplace state that crosses devices. Records what the user has installed (id +
 * version + published_at + COS URL); the actual content lives at `<uid>/local/marketplace/`
 * on each machine and is reconciled on startup by `features/marketplace_reconcile.ts`
 * (fetches whatever's listed in the manifest but missing locally).
 *
 * Manifest format:
 *
 *   {
 *     "version": 1,
 *     "agents": [
 *       { "id": "abc123def456", "version": "1.0.0", "published_at": 1747066800000,
 *         "agent_json_url": "https://orkas-1367889399.cos.../agent.json",
 *         "installed_at": 1747066800100 }
 *     ],
 *     "skills": [
 *       { "id": "xyz789...", "version": "1.0.0", "published_at": 1747066800000,
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

const log = createLogger('marketplace_installs');

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
  agent_json_url: string;
  installed_at: number;
  /** Author uid as recorded on the server. `"0"` = "官方"; everything else = community
   *  uploader. Optional in the type so old manifest rows (pre-2026-05-13) still parse —
   *  reconcile fills it in next time the row is re-pulled. UI uses this to render the
   *  author badge on the agent detail page. */
  create_uid?: string;
}

export interface SkillInstall {
  id: string;
  version: string;
  published_at: number;
  bundle_url: string;
  installed_at: number;
  /** Same as `AgentInstall.create_uid` — see comment there. */
  create_uid?: string;
}

export const CURRENT_VERSION = 1;

export interface InstallsManifest {
  version: typeof CURRENT_VERSION;
  agents: AgentInstall[];
  skills: SkillInstall[];
}

const EMPTY: InstallsManifest = { version: CURRENT_VERSION, agents: [], skills: [] };

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
      agents: Array.isArray(parsed.agents) ? parsed.agents.filter(_isAgentRow) : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills.filter(_isSkillRow) : [],
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
}

export async function addAgentInstall(uid: string, row: Omit<AgentInstall, 'installed_at'> & { installed_at?: number }): Promise<void> {
  await _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const idx = manifest.agents.findIndex((a) => a.id === row.id);
    const entry: AgentInstall = { ...row, installed_at: row.installed_at || Date.now() };
    if (idx >= 0) manifest.agents[idx] = entry;
    else manifest.agents.push(entry);
    await writeInstalls(uid, manifest);
    log.info(`agent installed id=${row.id} v${row.version}`);
  });
}

export async function addSkillInstall(uid: string, row: Omit<SkillInstall, 'installed_at'> & { installed_at?: number }): Promise<void> {
  await _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const idx = manifest.skills.findIndex((s) => s.id === row.id);
    const entry: SkillInstall = { ...row, installed_at: row.installed_at || Date.now() };
    if (idx >= 0) manifest.skills[idx] = entry;
    else manifest.skills.push(entry);
    await writeInstalls(uid, manifest);
    log.info(`skill installed id=${row.id} v${row.version}`);
  });
}

export async function removeAgentInstall(uid: string, id: string): Promise<boolean> {
  return _getWriteLock(uid).runExclusive(async () => {
    const manifest = await readInstalls(uid);
    const before = manifest.agents.length;
    manifest.agents = manifest.agents.filter((a) => a.id !== id);
    if (manifest.agents.length === before) return false;
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
