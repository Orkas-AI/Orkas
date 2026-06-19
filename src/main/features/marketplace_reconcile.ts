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
  userMarketplaceAgentsDir, userMarketplaceSkillsDir,
  marketplaceReconcileStateFile,
} from '../paths';
import { sha256OfFile } from '../util/sha256';
import { clearAgentListCache } from './agents';
import { clearSkillListCache } from './skills';
import {
  readInstalls, addAgentInstall, addSkillInstall,
  removeAgentInstall, removeSkillInstall,
  type AgentInstall, type SkillInstall,
} from './marketplace_installs';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { extractBundleSafely, postJson } from './marketplace';
import { withMarketplaceInstallLock } from './marketplace_locks';
import { createLogger } from '../logger';
import { fetchWithRetry } from '../util/retry';

const log = createLogger('marketplace_reconcile');

/** Coarse-grained reconcile state for the UI banner. `idle` covers both pre-run and a finished
 *  run with nothing to pull (banner stays hidden in both cases). */
export type ReconcileState = 'idle' | 'running' | 'done';

export interface ReconcileStatus {
  state: ReconcileState;
  /** `default_seed` covers the pre-reconcile step that discovers/writes default manifest rows. */
  phase?: 'default_seed' | 'reconcile';
  /** Total entries to pull this run (set when entering `running`). */
  total: number;
  total_agents: number;
  total_skills: number;
  /** Successfully pulled (incremented in real time). */
  pulled: number;
  pulled_agents: number;
  pulled_skills: number;
  /** ids of failed pulls — only meaningful in `done`. */
  failed: string[];
  /** Wall-clock time of the last transition (ms). Banner uses this to decide whether to
   *  auto-hide after a delay. */
  updated_at: number;
}

export interface ReconcileResult {
  pulled_agents: number;
  pulled_skills: number;
  failed: string[];
  pruned_agents: number;
  pruned_skills: number;
  restored_agents: number;
  restored_skills: number;
  patched_agents: number;
  patched_skills: number;
}

export interface MarketplaceReconcileOptions {
  shouldContinue?: () => boolean;
  /** Skip network-heavy server catalog checks when a recent startup attempt already ran. */
  minIntervalMs?: number;
  /** Ignore `minIntervalMs`; used by explicit user actions and short retry loops. */
  force?: boolean;
}

interface ReconcileLocalState {
  server_check_attempted_at?: number;
  server_check_succeeded_at?: number;
}

class ReconcileCancelled extends Error {
  constructor() {
    super('reconcile cancelled');
    this.name = 'ReconcileCancelled';
  }
}

function _assertContinue(opts?: MarketplaceReconcileOptions): void {
  if (opts?.shouldContinue && !opts.shouldContinue()) throw new ReconcileCancelled();
}

function _idleStatus(): ReconcileStatus {
  return {
    state: 'idle',
    total: 0,
    total_agents: 0,
    total_skills: 0,
    pulled: 0,
    pulled_agents: 0,
    pulled_skills: 0,
    failed: [],
    updated_at: Date.now(),
  };
}

let _status: ReconcileStatus = _idleStatus();
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

export function setDefaultInstallSeedStatus(active: boolean): void {
  if (active) {
    _setStatus({
      state: 'running',
      phase: 'default_seed',
      // Exact counts are not known until the defaults endpoint returns and reconcile filters
      // pull-needed rows. Keep each page banner visible during this discovery/write phase.
      total: 2,
      total_agents: 1,
      total_skills: 1,
      pulled: 0,
      pulled_agents: 0,
      pulled_skills: 0,
      failed: [],
      updated_at: Date.now(),
    });
    return;
  }
  if (_status.phase === 'default_seed') {
    _setStatus(_idleStatus());
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
export async function checkServerUpdatesForInstalls(
  uid: string,
  opts: MarketplaceReconcileOptions = {},
): Promise<{ updated_agents: number; updated_skills: number; skipped?: boolean }> {
  try { _assertContinue(opts); } catch { return { updated_agents: 0, updated_skills: 0 }; }
  const manifest = await readInstalls(uid);
  if (manifest.agents.length === 0 && manifest.skills.length === 0) {
    return { updated_agents: 0, updated_skills: 0 };
  }
  const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? Math.max(0, Number(opts.minIntervalMs)) : 0;
  if (!opts.force && _serverCheckRecentlyAttempted(uid, minIntervalMs)) {
    log.info('server-check skipped: checked recently');
    return { updated_agents: 0, updated_skills: 0, skipped: true };
  }
  _markServerCheckAttempt(uid);

  let agentMap: Map<string, _CatalogRow>;
  let skillMap: Map<string, _CatalogRow>;
  try {
    const agentIds = manifest.agents.map((a) => a.id).filter(Boolean);
    const skillIds = manifest.skills.map((s) => s.id).filter(Boolean);
    [agentMap, skillMap] = await Promise.all([
      agentIds.length ? _fetchServerCatalogMap('agents', agentIds) : Promise.resolve(new Map()),
      skillIds.length ? _fetchServerCatalogMap('skills', skillIds) : Promise.resolve(new Map()),
    ]);
  } catch (err) {
    log.warn(`server-check fetch failed (offline?): ${(err as Error).message}`);
    return { updated_agents: 0, updated_skills: 0 };
  }
  try { _assertContinue(opts); } catch { return { updated_agents: 0, updated_skills: 0 }; }

  let updated_agents = 0;
  let updated_skills = 0;
  let pruned_agents = 0;
  let pruned_skills = 0;
  for (const a of manifest.agents) {
    const server = agentMap.get(a.id);
    if (!server) {
      if (!_agentContentExists(uid, a.id) && await removeAgentInstall(uid, a.id)) {
        pruned_agents++;
        log.warn(`server-check: pruned stale agent install ${a.id} (missing on server and local disk)`);
      }
      continue;
    }
    const contentChanged = server.version !== a.version || _freshnessAt(server) !== _freshnessAt(a);
    const defaultInstallChanged = typeof server.default_install === 'boolean'
      && a.default_install !== server.default_install;
    const currentStatus = a.status || a.state;
    const statusChanged = typeof server.status === 'string' && currentStatus !== server.status;
    if (contentChanged || defaultInstallChanged || statusChanged) {
      log.info(`server-update agent ${a.id}: v${a.version} → v${server.version} (freshness ${_freshnessAt(a)} → ${_freshnessAt(server)})`);
      try { _assertContinue(opts); } catch { return { updated_agents, updated_skills }; }
      // Replace the row in the manifest; reconcile will detect the version/freshness
      // mismatch against `_install.json` and re-pull. agent_json_url is reused (server
      // overwrites the same COS key on republish — see Server `api/marketplace.py::upload_agent`).
      await addAgentInstall(uid, {
        id: a.id, version: server.version, published_at: server.published_at,
        updated_at: server.updated_at, agent_json_url: a.agent_json_url, create_uid: a.create_uid,
        ...(typeof server.default_install === 'boolean' ? { default_install: server.default_install } : {}),
        ...(typeof server.status === 'string' ? { status: server.status } : {}),
      });
      if (!contentChanged && (defaultInstallChanged || statusChanged)) {
        await withMarketplaceInstallLock(uid, 'agent', a.id, async () => {
          await _patchInstallMeta(userMarketplaceAgentDir(uid, a.id), {
            ...(typeof server.default_install === 'boolean' ? { default_install: server.default_install } : {}),
            ...(typeof server.status === 'string' ? { status: server.status } : {}),
          });
        });
      }
      updated_agents++;
    }
  }
  for (const s of manifest.skills) {
    const server = skillMap.get(s.id);
    if (!server) {
      if (!_skillContentExists(uid, s.id) && await removeSkillInstall(uid, s.id)) {
        pruned_skills++;
        log.warn(`server-check: pruned stale skill install ${s.id} (missing on server and local disk)`);
      }
      continue;
    }
    const contentChanged = server.version !== s.version || _freshnessAt(server) !== _freshnessAt(s);
    const defaultInstallChanged = typeof server.default_install === 'boolean'
      && s.default_install !== server.default_install;
    const currentStatus = s.status || s.state;
    const statusChanged = typeof server.status === 'string' && currentStatus !== server.status;
    if (contentChanged || defaultInstallChanged || statusChanged) {
      log.info(`server-update skill ${s.id}: v${s.version} → v${server.version} (freshness ${_freshnessAt(s)} → ${_freshnessAt(server)})`);
      try { _assertContinue(opts); } catch { return { updated_agents, updated_skills }; }
      await addSkillInstall(uid, {
        id: s.id, version: server.version, published_at: server.published_at,
        updated_at: server.updated_at, bundle_url: s.bundle_url, create_uid: s.create_uid,
        ...(typeof server.default_install === 'boolean' ? { default_install: server.default_install } : {}),
        ...(typeof server.status === 'string' ? { status: server.status } : {}),
      });
      if (!contentChanged && (defaultInstallChanged || statusChanged)) {
        await withMarketplaceInstallLock(uid, 'skill', s.id, async () => {
          await _patchInstallMeta(userMarketplaceSkillDir(uid, s.id), {
            ...(typeof server.default_install === 'boolean' ? { default_install: server.default_install } : {}),
            ...(typeof server.status === 'string' ? { status: server.status } : {}),
          });
        });
      }
      updated_skills++;
    }
  }
  if (updated_agents + updated_skills > 0) {
    log.info(`server-check: ${updated_agents} agent(s) + ${updated_skills} skill(s) marked for update`);
  }
  if (pruned_agents + pruned_skills > 0) {
    log.info(`server-check: pruned ${pruned_agents} stale agent install(s) + ${pruned_skills} stale skill install(s)`);
  }
  _markServerCheckSuccess(uid);
  return { updated_agents, updated_skills };
}

function _readLocalState(uid: string): ReconcileLocalState {
  try {
    const raw = JSON.parse(fs.readFileSync(marketplaceReconcileStateFile(uid), 'utf8')) as ReconcileLocalState;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function _writeLocalState(uid: string, patch: ReconcileLocalState): void {
  try {
    const file = marketplaceReconcileStateFile(uid);
    const next = { ..._readLocalState(uid), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    log.warn(`server-check state write failed: ${(err as Error).message}`);
  }
}

function _serverCheckRecentlyAttempted(uid: string, minIntervalMs: number, now = Date.now()): boolean {
  if (minIntervalMs <= 0) return false;
  const state = _readLocalState(uid);
  const attemptedAt = Number(state.server_check_attempted_at || state.server_check_succeeded_at || 0);
  return attemptedAt > 0 && now - attemptedAt < minIntervalMs;
}

function _markServerCheckAttempt(uid: string): void {
  _writeLocalState(uid, { server_check_attempted_at: Date.now() });
}

function _markServerCheckSuccess(uid: string): void {
  _writeLocalState(uid, { server_check_succeeded_at: Date.now() });
}

interface _CatalogRow { version: string; published_at: number; updated_at?: number; default_install?: boolean; status?: string }

/** Paginate the public `/marketplace/{kind}/list` endpoint and collapse to (id → version + ts).
 *  The optional `ids` filter is supported by newer Servers. Older Servers ignore the extra body
 *  field, so we still page defensively; the client-side id set prevents unrelated rows from
 *  entering the update map. Page-size 100 × 20 pages = 2000 row cap. */
async function _fetchServerCatalogMap(kind: 'agents' | 'skills', ids: string[]): Promise<Map<string, _CatalogRow>> {
  const out = new Map<string, _CatalogRow>();
  const PAGE_SIZE = 100;
  const wanted = new Set(ids.filter(Boolean));
  for (let page = 1; page <= 20; page++) {
    const r = await postJson<{ list: Array<{ id?: string; version?: string; published_at?: number; updated_at?: number; default_install?: boolean | number; status?: string; state?: string }>; total?: number }>(
      `/marketplace/${kind}/list`, { page, size: PAGE_SIZE, ids: [...wanted] },
    );
    const list = r.list || [];
    for (const row of list) {
      if (typeof row.id !== 'string' || !wanted.has(row.id)) continue;
      if (typeof row.version === 'string' && typeof row.published_at === 'number') {
        out.set(row.id, {
          version: row.version,
          published_at: row.published_at,
          ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
          ...(typeof row.default_install === 'boolean' || typeof row.default_install === 'number'
            ? { default_install: row.default_install === true || row.default_install === 1 }
            : {}),
          ...(typeof row.status === 'string' ? { status: row.status } : (
            typeof row.state === 'string' ? { status: row.state } : {}
          )),
        });
      }
    }
    if (out.size >= wanted.size || list.length < PAGE_SIZE) break;
  }
  return out;
}

/** Read manifest + reconcile every entry in parallel. Returns counts for logging. Emits status
 *  updates through the subscribe channel so the renderer can show a "syncing" banner. */
export async function reconcileInstalls(
  uid: string,
  opts: MarketplaceReconcileOptions = {},
): Promise<ReconcileResult> {
  try { _assertContinue(opts); } catch {
    return _emptyReconcileResult();
  }
  let manifest = await readInstalls(uid);
  let localConvergence: LocalConvergenceCounts;
  try {
    localConvergence = await _reconcileLocalOnlyInstalls(uid, manifest, opts);
  } catch (err) {
    if (err instanceof ReconcileCancelled) return _emptyReconcileResult();
    throw err;
  }
  try { _assertContinue(opts); } catch {
    _setStatus(_idleStatus());
    return { ..._emptyReconcileResult(), ...localConvergence };
  }
  if (localConvergence.restored_agents > 0 || localConvergence.restored_skills > 0) {
    manifest = await readInstalls(uid);
  }
  // Filter pull-needed up front so the banner's total is meaningful (it counts work the user
  // will actually see, not entries that short-circuit).
  const agentsNeedingPull = manifest.agents.filter((r) => _agentNeedsPull(uid, r));
  const skillsNeedingPull = manifest.skills.filter((r) => _skillNeedsPull(uid, r));
  const agentPullIds = new Set(agentsNeedingPull.map((r) => r.id));
  const skillPullIds = new Set(skillsNeedingPull.map((r) => r.id));
  let metadataPatches: MetadataPatchCounts;
  try {
    metadataPatches = await _patchLocalMetadataForManifest(uid, manifest, agentPullIds, skillPullIds, opts);
  } catch (err) {
    if (err instanceof ReconcileCancelled) {
      _setStatus(_idleStatus());
      return { ..._emptyReconcileResult(), ...localConvergence };
    }
    throw err;
  }
  const total = agentsNeedingPull.length + skillsNeedingPull.length;
  if (total === 0) {
    _clearCachesAfterConvergence(localConvergence, metadataPatches);
    _setStatus(_idleStatus());
    return {
      pulled_agents: 0,
      pulled_skills: 0,
      failed: [],
      ...localConvergence,
      ...metadataPatches,
    };
  }

  _setStatus({
    state: 'running',
    phase: 'reconcile',
    total,
    total_agents: agentsNeedingPull.length,
    total_skills: skillsNeedingPull.length,
    pulled: 0,
    pulled_agents: 0,
    pulled_skills: 0,
    failed: [],
    updated_at: Date.now(),
  });

  const failed: string[] = [];
  let pulled_agents = 0;
  let pulled_skills = 0;

  const bumpProgress = (): void => {
    _setStatus({
      ..._status,
      pulled: pulled_agents + pulled_skills,
      pulled_agents,
      pulled_skills,
      updated_at: Date.now(),
    });
  };

  const agentTasks = agentsNeedingPull.map(async (row) => {
    try {
      _assertContinue(opts);
      await _pullAgent(uid, row, opts);
      pulled_agents++;
      bumpProgress();
    } catch (err) {
      if (err instanceof ReconcileCancelled) return;
      log.warn(`agent ${row.id} pull failed: ${(err as Error).message}`);
      failed.push(`agent:${row.id}`);
    }
  });
  const skillTasks = skillsNeedingPull.map(async (row) => {
    try {
      _assertContinue(opts);
      await _pullSkill(uid, row, opts);
      pulled_skills++;
      bumpProgress();
    } catch (err) {
      if (err instanceof ReconcileCancelled) return;
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
  _clearCachesAfterConvergence(localConvergence, metadataPatches);
  _setStatus({
    state: 'done',
    phase: 'reconcile',
    total,
    total_agents: agentsNeedingPull.length,
    total_skills: skillsNeedingPull.length,
    pulled: pulled_agents + pulled_skills,
    pulled_agents,
    pulled_skills,
    failed, updated_at: Date.now(),
  });
  log.info(`reconciled: pulled ${pulled_agents} agent(s) + ${pulled_skills} skill(s); failed=${failed.length}`);
  return {
    pulled_agents,
    pulled_skills,
    failed,
    ...localConvergence,
    ...metadataPatches,
  };
}

function _emptyReconcileResult(): ReconcileResult {
  return {
    pulled_agents: 0,
    pulled_skills: 0,
    failed: [],
    pruned_agents: 0,
    pruned_skills: 0,
    restored_agents: 0,
    restored_skills: 0,
    patched_agents: 0,
    patched_skills: 0,
  };
}

interface LocalConvergenceCounts {
  pruned_agents: number;
  pruned_skills: number;
  restored_agents: number;
  restored_skills: number;
}

interface MetadataPatchCounts {
  patched_agents: number;
  patched_skills: number;
}

function _clearCachesAfterConvergence(local: LocalConvergenceCounts, meta: MetadataPatchCounts): void {
  if (local.pruned_agents || local.restored_agents || meta.patched_agents) {
    try { clearAgentListCache(); } catch { /* list cache may not be loaded yet */ }
  }
  if (local.pruned_skills || local.restored_skills || meta.patched_skills) {
    try { clearSkillListCache(); } catch { /* list cache may not be loaded yet */ }
    try { invalidateCoreAgentSkills(); } catch { /* runner may not be loaded yet */ }
  }
}

async function _reconcileLocalOnlyInstalls(
  uid: string,
  manifest: Awaited<ReturnType<typeof readInstalls>>,
  opts: MarketplaceReconcileOptions = {},
): Promise<LocalConvergenceCounts> {
  const counts: LocalConvergenceCounts = {
    pruned_agents: 0,
    pruned_skills: 0,
    restored_agents: 0,
    restored_skills: 0,
  };
  const manifestAgents = new Set(manifest.agents.map((a) => a.id));
  const manifestSkills = new Set(manifest.skills.map((s) => s.id));
  for (const id of _localInstallIds(userMarketplaceAgentsDir(uid))) {
    _assertContinue(opts);
    if (manifestAgents.has(id)) continue;
    const dir = userMarketplaceAgentDir(uid, id);
    const meta = _readInstallMeta(dir);
    const tombstone = manifest._deleted_at?.agents?.[id] || 0;
    const activeAt = _localInstallActiveAt(dir, meta);
    if (tombstone > 0 && tombstone >= activeAt) {
      await fsp.rm(dir, { recursive: true, force: true });
      counts.pruned_agents++;
      log.info(`pruned local-only marketplace agent ${id} (manifest tombstone wins)`);
      continue;
    }
    if (_canRestoreAgentInstall(meta)) {
      _assertContinue(opts);
      await addAgentInstall(uid, {
        id,
        version: meta.version,
        published_at: meta.published_at,
        ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
        agent_json_url: meta.agent_json_url!,
        installed_at: meta.installed_at!,
        create_uid: meta.create_uid || '',
        ...(typeof meta.default_install === 'boolean' ? { default_install: meta.default_install } : {}),
        ...(meta.status ? { status: meta.status } : {}),
      });
      counts.restored_agents++;
      log.info(`restored local-only marketplace agent ${id} into installs manifest`);
    }
  }
  for (const id of _localInstallIds(userMarketplaceSkillsDir(uid))) {
    _assertContinue(opts);
    if (manifestSkills.has(id)) continue;
    const dir = userMarketplaceSkillDir(uid, id);
    const meta = _readInstallMeta(dir);
    const tombstone = manifest._deleted_at?.skills?.[id] || 0;
    const activeAt = _localInstallActiveAt(dir, meta);
    if (tombstone > 0 && tombstone >= activeAt) {
      await fsp.rm(dir, { recursive: true, force: true });
      counts.pruned_skills++;
      log.info(`pruned local-only marketplace skill ${id} (manifest tombstone wins)`);
      continue;
    }
    if (_canRestoreSkillInstall(meta)) {
      _assertContinue(opts);
      await addSkillInstall(uid, {
        id,
        version: meta.version,
        published_at: meta.published_at,
        ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
        bundle_url: meta.bundle_url!,
        installed_at: meta.installed_at!,
        create_uid: meta.create_uid || '',
        ...(typeof meta.default_install === 'boolean' ? { default_install: meta.default_install } : {}),
        ...(meta.status ? { status: meta.status } : {}),
      });
      counts.restored_skills++;
      log.info(`restored local-only marketplace skill ${id} into installs manifest`);
    }
  }
  return counts;
}

async function _patchLocalMetadataForManifest(
  uid: string,
  manifest: Awaited<ReturnType<typeof readInstalls>>,
  agentPullIds: Set<string>,
  skillPullIds: Set<string>,
  opts: MarketplaceReconcileOptions = {},
): Promise<MetadataPatchCounts> {
  const counts: MetadataPatchCounts = { patched_agents: 0, patched_skills: 0 };
  for (const row of manifest.agents) {
    _assertContinue(opts);
    if (agentPullIds.has(row.id) || !_agentContentExists(uid, row.id)) continue;
    const dir = userMarketplaceAgentDir(uid, row.id);
    const meta = _readInstallMeta(dir);
    if (!meta) continue;
    const patch = _installMetaFromAgentRow(row);
    if (!_installMetaMatches(meta, patch)) {
      _assertContinue(opts);
      await _writeInstallMeta(dir, { ...meta, ...patch });
      counts.patched_agents++;
    }
  }
  for (const row of manifest.skills) {
    _assertContinue(opts);
    if (skillPullIds.has(row.id) || !_skillContentExists(uid, row.id)) continue;
    const dir = userMarketplaceSkillDir(uid, row.id);
    const meta = _readInstallMeta(dir);
    if (!meta) continue;
    const patch = _installMetaFromSkillRow(row);
    if (!_installMetaMatches(meta, patch)) {
      _assertContinue(opts);
      await _writeInstallMeta(dir, { ...meta, ...patch });
      counts.patched_skills++;
    }
  }
  return counts;
}

function _localInstallIds(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

/** Need-pull check: missing dir / missing agent.json / `_install.json::version` mismatch.
 *  Mirrors the cache freshness rule from marketplace_cache.ts (version + updated_at fallback). */
function _agentNeedsPull(uid: string, row: AgentInstall): boolean {
  if (!_agentContentExists(uid, row.id)) return true;
  const dir = userMarketplaceAgentDir(uid, row.id);
  const meta = _readInstallMeta(dir);
  if (!meta) return true;
  return meta.version !== row.version || _freshnessAt(meta) !== _freshnessAt(row);
}

function _skillNeedsPull(uid: string, row: SkillInstall): boolean {
  if (!_skillContentExists(uid, row.id)) return true;
  const dir = userMarketplaceSkillDir(uid, row.id);
  const meta = _readInstallMeta(dir);
  if (!meta) return true;
  return meta.version !== row.version || _freshnessAt(meta) !== _freshnessAt(row);
}

function _agentContentExists(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceAgentDir(uid, id), 'agent.json'));
}

function _skillContentExists(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceSkillDir(uid, id), 'SKILL.md'));
}

interface InstallMeta {
  version: string;
  published_at: number;
  updated_at?: number;
  agent_json_url?: string;
  bundle_url?: string;
  installed_at?: number;
  create_uid?: string;
  default_install?: boolean;
  is_open_source?: boolean;
  status?: string;
  state?: string;
  /** sha256 (hex) of the spec's descriptive file at install / upload time —
   *  agent.json for agents, SKILL.md for skills. Used only by the dev-mode
   *  local-edit guard in `_needsPull`; absent on pre-feature installs. */
  content_sha?: string;
}

function _freshnessAt(row: { published_at: number; updated_at?: number }): number {
  return typeof row.updated_at === 'number' ? row.updated_at : row.published_at;
}

function _installStatus(row: { status?: string; state?: string }): string {
  return (row.status || row.state || '').trim();
}

function _installActiveAt(dir: string, row: InstallMeta | AgentInstall | SkillInstall | null): number {
  const installedAt = typeof row?.installed_at === 'number' ? row.installed_at : 0;
  const freshness = row ? _freshnessAt(row) : 0;
  if (installedAt > 0 || freshness > 0) return Math.max(installedAt, freshness);
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

function _localInstallActiveAt(dir: string, meta: InstallMeta | null): number {
  return _installActiveAt(dir, meta);
}

function _canRestoreAgentInstall(meta: InstallMeta | null): meta is InstallMeta & { agent_json_url: string; installed_at: number } {
  return !!meta
    && typeof meta.agent_json_url === 'string' && meta.agent_json_url.length > 0
    && typeof meta.installed_at === 'number' && meta.installed_at > 0;
}

function _canRestoreSkillInstall(meta: InstallMeta | null): meta is InstallMeta & { bundle_url: string; installed_at: number } {
  return !!meta
    && typeof meta.bundle_url === 'string' && meta.bundle_url.length > 0
    && typeof meta.installed_at === 'number' && meta.installed_at > 0;
}

function _installMetaFromAgentRow(row: AgentInstall): Partial<InstallMeta> {
  return {
    version: row.version,
    published_at: row.published_at,
    ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    agent_json_url: row.agent_json_url,
    installed_at: row.installed_at,
    create_uid: row.create_uid || '',
    ...(typeof row.default_install === 'boolean' ? { default_install: row.default_install } : {}),
    ...(_installStatus(row) ? { status: _installStatus(row) } : {}),
  };
}

function _installMetaFromSkillRow(row: SkillInstall): Partial<InstallMeta> {
  return {
    version: row.version,
    published_at: row.published_at,
    ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    bundle_url: row.bundle_url,
    installed_at: row.installed_at,
    create_uid: row.create_uid || '',
    ...(typeof row.default_install === 'boolean' ? { default_install: row.default_install } : {}),
    ...(_installStatus(row) ? { status: _installStatus(row) } : {}),
  };
}

function _installMetaMatches(meta: InstallMeta, expected: Partial<InstallMeta>): boolean {
  for (const [key, value] of Object.entries(expected) as Array<[keyof InstallMeta, unknown]>) {
    if (value === undefined) continue;
    if (meta[key] !== value) return false;
  }
  return true;
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
      agent_json_url: typeof j.agent_json_url === 'string' ? j.agent_json_url : '',
      bundle_url: typeof j.bundle_url === 'string' ? j.bundle_url : '',
      ...(typeof j.installed_at === 'number' ? { installed_at: j.installed_at } : {}),
      create_uid: typeof j.create_uid === 'string' ? j.create_uid : '',
      ...(typeof j.default_install === 'boolean' ? { default_install: j.default_install } : {}),
      ...(typeof j.is_open_source === 'boolean' ? { is_open_source: j.is_open_source } : {}),
      ...(typeof j.status === 'string' ? { status: j.status } : (
        typeof j.state === 'string' ? { status: j.state } : {}
      )),
      ...(typeof j.content_sha === 'string' ? { content_sha: j.content_sha } : {}),
    };
  } catch { return null; }
}

async function _writeInstallMeta(dir: string, meta: InstallMeta): Promise<void> {
  await fsp.writeFile(path.join(dir, '_install.json'), JSON.stringify(meta, null, 2), 'utf8');
}

async function _patchInstallMeta(dir: string, patch: Partial<InstallMeta>): Promise<void> {
  const meta = _readInstallMeta(dir);
  if (!meta) return;
  await _writeInstallMeta(dir, { ...meta, ...patch });
}

/** Fetch agent.json from the cloud URL recorded in the manifest, write to the per-machine
 *  install target. Wipe-and-replace so a previous version doesn't leave stale fields. */
async function _pullAgent(uid: string, row: AgentInstall, opts: MarketplaceReconcileOptions = {}): Promise<void> {
  return withMarketplaceInstallLock(uid, 'agent', row.id, async () => _pullAgentLocked(uid, row, opts));
}

async function _pullAgentLocked(uid: string, row: AgentInstall, opts: MarketplaceReconcileOptions = {}): Promise<void> {
  let current = row;
  _assertContinue(opts);
  let res = await fetchWithRetry(`marketplace:pull-agent:${row.id}`, current.agent_json_url);
  if (!res.ok && res.status === 404) {
    _assertContinue(opts);
    const fresh = await postJson<{
      agent_json: Record<string, unknown>;
      version: string;
      published_at: number;
      updated_at?: number;
      agent_json_url: string;
      create_uid: string;
      default_install?: boolean;
      status?: string;
      state?: string;
    }>('/marketplace/agents/detail', { id: row.id });
    current = {
      ...row,
      version: fresh.version,
      published_at: fresh.published_at,
      ...(typeof fresh.updated_at === 'number' ? { updated_at: fresh.updated_at } : {}),
      agent_json_url: fresh.agent_json_url,
      create_uid: fresh.create_uid || row.create_uid,
      ...(typeof fresh.default_install === 'boolean' ? { default_install: fresh.default_install } : {}),
      ...((fresh.status || fresh.state) ? { status: fresh.status || fresh.state } : {}),
    };
    _assertContinue(opts);
    await addAgentInstall(uid, current);
    res = await fetchWithRetry(`marketplace:pull-agent:${row.id}:fresh`, current.agent_json_url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  _assertContinue(opts);
  // Validate it parses — manifest-stored URLs come from COS, treat as untrusted.
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.agent_id !== 'string') throw new Error('agent.json missing agent_id');

  const dir = userMarketplaceAgentDir(uid, row.id);
  _assertContinue(opts);
  await fsp.rm(dir, { recursive: true, force: true });
  _assertContinue(opts);
  await fsp.mkdir(dir, { recursive: true });
  const agentJsonFile = path.join(dir, 'agent.json');
  _assertContinue(opts);
  await fsp.writeFile(agentJsonFile, text, 'utf8');
  _assertContinue(opts);
  await _writeInstallMeta(dir, {
    version: current.version, published_at: current.published_at,
    ...(typeof current.updated_at === 'number' ? { updated_at: current.updated_at } : {}),
    agent_json_url: current.agent_json_url,
    installed_at: current.installed_at,
    create_uid: current.create_uid || '',
    ...(typeof current.default_install === 'boolean' ? { default_install: current.default_install } : {}),
    ...((current.status || current.state) ? { status: current.status || current.state } : {}),
    ...(((): { content_sha?: string } => {
      const sha = sha256OfFile(agentJsonFile);
      return sha ? { content_sha: sha } : {};
    })()),
  });
}

/** Fetch the skill bundle zip from cloud URL + extract. Same wipe-and-replace semantics.
 *  `extractBundleSafely` enforces entry count + uncompressed size caps (zip-bomb defense)
 *  — shared with the marketplace install path. */
async function _pullSkill(uid: string, row: SkillInstall, opts: MarketplaceReconcileOptions = {}): Promise<void> {
  return withMarketplaceInstallLock(uid, 'skill', row.id, async () => _pullSkillLocked(uid, row, opts));
}

async function _pullSkillLocked(uid: string, row: SkillInstall, opts: MarketplaceReconcileOptions = {}): Promise<void> {
  let current = row;
  _assertContinue(opts);
  let res = await fetchWithRetry(`marketplace:pull-skill:${row.id}`, current.bundle_url);
  if (!res.ok && res.status === 404) {
    _assertContinue(opts);
    const fresh = await postJson<{
      bundle_url: string;
      version: string;
      published_at: number;
      updated_at?: number;
      create_uid: string;
      default_install?: boolean;
      status?: string;
      state?: string;
    }>('/marketplace/skills/bundle', { id: row.id });
    current = {
      ...row,
      version: fresh.version,
      published_at: fresh.published_at,
      ...(typeof fresh.updated_at === 'number' ? { updated_at: fresh.updated_at } : {}),
      bundle_url: fresh.bundle_url,
      create_uid: fresh.create_uid || row.create_uid,
      ...(typeof fresh.default_install === 'boolean' ? { default_install: fresh.default_install } : {}),
      ...((fresh.status || fresh.state) ? { status: fresh.status || fresh.state } : {}),
    };
    _assertContinue(opts);
    await addSkillInstall(uid, current);
    res = await fetchWithRetry(`marketplace:pull-skill:${row.id}:fresh`, current.bundle_url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  _assertContinue(opts);
  const zip = new AdmZip(Buffer.from(ab));

  const dir = userMarketplaceSkillDir(uid, row.id);
  _assertContinue(opts);
  await fsp.rm(dir, { recursive: true, force: true });
  _assertContinue(opts);
  await fsp.mkdir(dir, { recursive: true });

  _assertContinue(opts);
  extractBundleSafely(zip, dir);
  // Sanity: SKILL.md must end up in place (zip empty / corrupt would silently skip everything).
  const skillMdFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMdFile)) throw new Error('bundle missing SKILL.md');
  _assertContinue(opts);
  await _writeInstallMeta(dir, {
    version: current.version, published_at: current.published_at,
    ...(typeof current.updated_at === 'number' ? { updated_at: current.updated_at } : {}),
    bundle_url: current.bundle_url,
    installed_at: current.installed_at,
    create_uid: current.create_uid || '',
    ...(typeof current.default_install === 'boolean' ? { default_install: current.default_install } : {}),
    ...((current.status || current.state) ? { status: current.status || current.state } : {}),
    ...(((): { content_sha?: string } => {
      const sha = sha256OfFile(skillMdFile);
      return sha ? { content_sha: sha } : {};
    })()),
  });
}
