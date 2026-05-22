/**
 * Marketplace install reconciler.
 *
 * Read the cloud-synced manifest at `<uid>/cloud/marketplace/installs.json` and ensure every
 * entry has a corresponding local copy under `<uid>/local/marketplace/{agents,skills}/<id>/`.
 * Anything in the manifest but missing on disk gets fetched (in parallel) from the COS URL
 * recorded in the manifest. Anything on disk but not in the manifest is left alone (might be
 * a partial uninstall or external state we don't own).
 *
 * Called once at boot from `main/index.ts`, fire-and-forget. Failures are logged but never
 * propagated — a missed install just means the user has to revisit the marketplace and
 * reinstall (or the next boot retries automatically).
 */

import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  userMarketplaceAgentDir, userMarketplaceSkillDir,
} from '../paths';
import { clearAgentListCache } from './agents';
import { clearSkillListCache } from './skills';
import {
  readInstalls, addAgentInstall, addSkillInstall,
  type AgentInstall, type SkillInstall,
} from './marketplace_installs';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { extractBundleSafely, postJson } from './marketplace';
import { createLogger } from '../logger';

const log = createLogger('marketplace_reconcile');

/** Coarse-grained reconcile state for the UI banner. `idle` covers both pre-run and a finished
 *  run with nothing to pull (banner stays hidden in both cases). */
export type ReconcileState = 'idle' | 'running' | 'done';

export interface ReconcileStatus {
  state: ReconcileState;
  /** Total entries to pull this run (set when entering `running`). */
  total: number;
  /** Successfully pulled (incremented in real time). */
  pulled: number;
  /** ids of failed pulls — only meaningful in `done`. */
  failed: string[];
  /** Wall-clock time of the last transition (ms). Banner uses this to decide whether to
   *  auto-hide after a delay. */
  updated_at: number;
}

let _status: ReconcileStatus = { state: 'idle', total: 0, pulled: 0, failed: [], updated_at: Date.now() };
type StatusListener = (s: ReconcileStatus) => void;
const _listeners = new Set<StatusListener>();

/** Snapshot of the current state. Renderer calls this once at startup via IPC, then subscribes
 *  to push-events for further changes (see `main/index.ts::wireReconcileBroadcast`). */
export function getReconcileStatus(): ReconcileStatus { return _status; }

/** Subscribe to reconcile-status transitions. Returns an unsubscribe function. The listener
 *  fires for every state mutation (including in-flight `running.pulled` increments — the UI
 *  banner re-renders progress without polling). */
export function subscribeReconcileStatus(listener: StatusListener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _setStatus(next: ReconcileStatus): void {
  _status = next;
  for (const fn of _listeners) {
    try { fn(_status); } catch { /* listener errors must not break reconcile */ }
  }
}

/** Pre-reconcile step: sync the local cloud manifest against the server catalog. For every
 *  installed item, look up the server's current (version, updated_at/published_at). When the server has
 *  newer values, write them back into the manifest — the subsequent `reconcileInstalls` pass
 *  then detects the mismatch against per-machine `_install.json` and re-pulls the blob.
 *
 *  Side effects: at most one `addAgentInstall` / `addSkillInstall` write per changed row,
 *  each going through the same per-uid lock as user-initiated installs. Items absent from the
 *  server catalog (e.g. admin-deleted) are left untouched — auto-uninstall stays user-explicit.
 *
 *  Network failures are swallowed (offline boot must not block the rest of startup); the next
 *  launch retries.
 */
export async function checkServerUpdatesForInstalls(uid: string): Promise<{ updated_agents: number; updated_skills: number }> {
  const manifest = await readInstalls(uid);
  if (manifest.agents.length === 0 && manifest.skills.length === 0) {
    return { updated_agents: 0, updated_skills: 0 };
  }

  let agentMap: Map<string, _CatalogRow>;
  let skillMap: Map<string, _CatalogRow>;
  try {
    [agentMap, skillMap] = await Promise.all([
      _fetchServerCatalogMap('agents'),
      _fetchServerCatalogMap('skills'),
    ]);
  } catch (err) {
    log.warn(`server-check fetch failed (offline?): ${(err as Error).message}`);
    return { updated_agents: 0, updated_skills: 0 };
  }

  let updated_agents = 0;
  let updated_skills = 0;
  for (const a of manifest.agents) {
    const server = agentMap.get(a.id);
    if (!server) continue;
    if (server.version !== a.version || _freshnessAt(server) !== _freshnessAt(a)) {
      log.info(`server-update agent ${a.id}: v${a.version} → v${server.version} (freshness ${_freshnessAt(a)} → ${_freshnessAt(server)})`);
      // Replace the row in the manifest; reconcile will detect the version/freshness
      // mismatch against `_install.json` and re-pull. agent_json_url is reused (server
      // overwrites the same COS key on republish — see Server `api/marketplace.py::upload_agent`).
      await addAgentInstall(uid, {
        id: a.id, version: server.version, published_at: server.published_at,
        updated_at: server.updated_at, agent_json_url: a.agent_json_url, create_uid: a.create_uid,
      });
      updated_agents++;
    }
  }
  for (const s of manifest.skills) {
    const server = skillMap.get(s.id);
    if (!server) continue;
    if (server.version !== s.version || _freshnessAt(server) !== _freshnessAt(s)) {
      log.info(`server-update skill ${s.id}: v${s.version} → v${server.version} (freshness ${_freshnessAt(s)} → ${_freshnessAt(server)})`);
      await addSkillInstall(uid, {
        id: s.id, version: server.version, published_at: server.published_at,
        updated_at: server.updated_at, bundle_url: s.bundle_url, create_uid: s.create_uid,
      });
      updated_skills++;
    }
  }
  if (updated_agents + updated_skills > 0) {
    log.info(`server-check: ${updated_agents} agent(s) + ${updated_skills} skill(s) marked for update`);
  }
  return { updated_agents, updated_skills };
}

interface _CatalogRow { version: string; published_at: number; updated_at?: number }

/** Paginate the public `/marketplace/{kind}/list` endpoint and collapse to (id → version + ts).
 *  Page-size 100 × 20 pages = 2000 row cap (well above current catalog scale). */
async function _fetchServerCatalogMap(kind: 'agents' | 'skills'): Promise<Map<string, _CatalogRow>> {
  const out = new Map<string, _CatalogRow>();
  const PAGE_SIZE = 100;
  for (let page = 1; page <= 20; page++) {
    const r = await postJson<{ list: Array<{ id?: string; version?: string; published_at?: number; updated_at?: number }>; total?: number }>(
      `/marketplace/${kind}/list`, { page, size: PAGE_SIZE },
    );
    const list = r.list || [];
    for (const row of list) {
      if (typeof row.id === 'string' && typeof row.version === 'string' && typeof row.published_at === 'number') {
        out.set(row.id, {
          version: row.version,
          published_at: row.published_at,
          ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
        });
      }
    }
    if (list.length < PAGE_SIZE) break;
  }
  return out;
}

/** Read manifest + reconcile every entry in parallel. Returns counts for logging. Emits status
 *  updates through the subscribe channel so the renderer can show a "syncing" banner. */
export async function reconcileInstalls(uid: string): Promise<{ pulled_agents: number; pulled_skills: number; failed: string[] }> {
  const manifest = await readInstalls(uid);
  // Filter pull-needed up front so the banner's total is meaningful (it counts work the user
  // will actually see, not entries that short-circuit).
  const agentsNeedingPull = manifest.agents.filter((r) => _agentNeedsPull(uid, r));
  const skillsNeedingPull = manifest.skills.filter((r) => _skillNeedsPull(uid, r));
  const total = agentsNeedingPull.length + skillsNeedingPull.length;
  if (total === 0) {
    _setStatus({ state: 'idle', total: 0, pulled: 0, failed: [], updated_at: Date.now() });
    return { pulled_agents: 0, pulled_skills: 0, failed: [] };
  }

  _setStatus({ state: 'running', total, pulled: 0, failed: [], updated_at: Date.now() });

  const failed: string[] = [];
  let pulled_agents = 0;
  let pulled_skills = 0;

  const bumpProgress = (): void => {
    _setStatus({ ..._status, pulled: pulled_agents + pulled_skills, updated_at: Date.now() });
  };

  const agentTasks = agentsNeedingPull.map(async (row) => {
    try {
      await _pullAgent(uid, row);
      pulled_agents++;
      bumpProgress();
    } catch (err) {
      log.warn(`agent ${row.id} pull failed: ${(err as Error).message}`);
      failed.push(`agent:${row.id}`);
    }
  });
  const skillTasks = skillsNeedingPull.map(async (row) => {
    try {
      await _pullSkill(uid, row);
      pulled_skills++;
      bumpProgress();
    } catch (err) {
      log.warn(`skill ${row.id} pull failed: ${(err as Error).message}`);
      failed.push(`skill:${row.id}`);
    }
  });

  await Promise.all([...agentTasks, ...skillTasks]);

  if (pulled_skills > 0) {
    try { clearSkillListCache(); } catch { /* list cache may not be loaded yet */ }
    try { invalidateCoreAgentSkills(); } catch { /* runner may not be loaded yet */ }
  }
  if (pulled_agents > 0) {
    try { clearAgentListCache(); } catch { /* list cache may not be loaded yet */ }
  }
  _setStatus({
    state: 'done', total, pulled: pulled_agents + pulled_skills,
    failed, updated_at: Date.now(),
  });
  log.info(`reconciled: pulled ${pulled_agents} agent(s) + ${pulled_skills} skill(s); failed=${failed.length}`);
  return { pulled_agents, pulled_skills, failed };
}

/** Need-pull check: missing dir / missing agent.json / `_install.json::version` mismatch.
 *  Mirrors the cache freshness rule from marketplace_cache.ts (version + updated_at fallback). */
function _agentNeedsPull(uid: string, row: AgentInstall): boolean {
  const dir = userMarketplaceAgentDir(uid, row.id);
  const agentJsonFile = path.join(dir, 'agent.json');
  if (!fs.existsSync(agentJsonFile)) return true;
  const meta = _readInstallMeta(dir);
  if (!meta) return true;
  return meta.version !== row.version || _freshnessAt(meta) !== _freshnessAt(row);
}

function _skillNeedsPull(uid: string, row: SkillInstall): boolean {
  const dir = userMarketplaceSkillDir(uid, row.id);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return true;
  const meta = _readInstallMeta(dir);
  if (!meta) return true;
  return meta.version !== row.version || _freshnessAt(meta) !== _freshnessAt(row);
}

interface InstallMeta { version: string; published_at: number; updated_at?: number; create_uid?: string }

function _freshnessAt(row: { published_at: number; updated_at?: number }): number {
  return typeof row.updated_at === 'number' ? row.updated_at : row.published_at;
}

function _readInstallMeta(dir: string): InstallMeta | null {
  const f = path.join(dir, '_install.json');
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<InstallMeta>;
    if (typeof j.version !== 'string' || typeof j.published_at !== 'number') return null;
    return {
      version: j.version,
      published_at: j.published_at,
      ...(typeof j.updated_at === 'number' ? { updated_at: j.updated_at } : {}),
      create_uid: typeof j.create_uid === 'string' ? j.create_uid : '',
    };
  } catch { return null; }
}

async function _writeInstallMeta(dir: string, meta: InstallMeta): Promise<void> {
  await fsp.writeFile(path.join(dir, '_install.json'), JSON.stringify(meta, null, 2), 'utf8');
}

/** Fetch agent.json from the cloud URL recorded in the manifest, write to the per-machine
 *  install target. Wipe-and-replace so a previous version doesn't leave stale fields. */
async function _pullAgent(uid: string, row: AgentInstall): Promise<void> {
  const res = await fetch(row.agent_json_url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // Validate it parses — manifest-stored URLs come from COS, treat as untrusted.
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.agent_id !== 'string') throw new Error('agent.json missing agent_id');

  const dir = userMarketplaceAgentDir(uid, row.id);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'agent.json'), text, 'utf8');
  await _writeInstallMeta(dir, {
    version: row.version, published_at: row.published_at,
    ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    create_uid: row.create_uid || '',
  });
}

/** Fetch the skill bundle zip from cloud URL + extract. Same wipe-and-replace semantics.
 *  `extractBundleSafely` enforces entry count + uncompressed size caps (zip-bomb defense)
 *  — shared with the marketplace install path. */
async function _pullSkill(uid: string, row: SkillInstall): Promise<void> {
  const res = await fetch(row.bundle_url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const zip = new AdmZip(Buffer.from(ab));

  const dir = userMarketplaceSkillDir(uid, row.id);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  extractBundleSafely(zip, dir);
  // Sanity: SKILL.md must end up in place (zip empty / corrupt would silently skip everything).
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('bundle missing SKILL.md');
  await _writeInstallMeta(dir, {
    version: row.version, published_at: row.published_at,
    ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    create_uid: row.create_uid || '',
  });
}
