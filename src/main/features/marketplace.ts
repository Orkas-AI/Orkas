/**
 * Marketplace — browse + install official agents / skills from the Orkas Server.
 *
 * Three-layer storage model:
 *
 *   1. **Server** owns the catalog (marketplace_agents / marketplace_skills tables) and the
 *      blob URLs (agent.json on COS, skill bundle .zip on COS).
 *   2. **Cloud-synced install manifest** (`<uid>/cloud/marketplace/installs.json`) — the only
 *      multi-device state. Records what the user has installed: id / version / published_at /
 *      COS URL / installed_at. See `marketplace_installs.ts`.
 *   3. **Per-machine install target** (`<uid>/local/marketplace/{agents,skills}/<id>/`) — the
 *      actual content. Reconciled from (2) on startup by `marketplace_reconcile.ts`: any entry
 *      in the manifest without local content gets fetched in parallel. Listed alongside
 *      `cloud/{agents,skills}/` by `features/{agents,skills}.ts::list*` under the "Platform" group.
 *
 * Detail-page cache (`<uid>/local/cache/marketplace/{agents,skills}/<id>/`) is independent —
 * it's a working copy for the detail viewer, populated whenever the user views an item, and
 * subject to LRU sweep. Install copies cache→install-target to materialize.
 *
 * Install flow: cache-first. `installMarketplaceAgent/Skill` ensures cache hot via the same
 * fetch+cache path the detail page uses, copies cache → `<uid>/local/marketplace/<kind>/<id>/`,
 * then records the entry in the cloud manifest.
 *
 * **Skill bundle = real zip.** Earlier revisions used a JSON envelope `{files:[...]}` (no zip
 * dep needed); switched to adm-zip to avoid base64 expansion on binary files + get deflate
 * compression on text. PC/CLAUDE.md §1 allow-list updated accordingly.
 *
 * **Agent install installs skill_list dependencies FIRST, then the agent body.** When agent.json
 * declares `skill_list: [sid1, sid2, ...]` (three-state: undefined = no filter, [] = zero,
 * non-empty = strict subset), the install runs every missing sid in parallel BEFORE writing the
 * agent's own files / manifest entry. If ANY skill install throws, the whole agent install fails;
 * the agent never gets recorded. **Why:** prevents "agent installed but its skills are missing"
 * inconsistency that would survive across devices via the cloud manifest. Previously-installed
 * skills from a partial retry are no-ops (`_skillAlreadyOnDisk` check), so retry-on-failure is
 * cheap. The user just re-clicks Install.
 *
 * Upload + delete (publishing custom items to the Server) are dev-only and live in
 * `marketplace_dev.ts` — excluded from packaged builds via `package.json::build.files`.
 */

import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  userSkillsDir,
  userMarketplaceAgentDir, userMarketplaceSkillDir,
  marketplaceCacheAgentDir, marketplaceCacheSkillDir,
  userMarketplaceInstallsFile, marketplaceDefaultsSeededFile,
  userMarketplaceDirCloud,
} from '../paths';
import { getActiveUserId } from './users';
import { getCurrentLang } from '../i18n';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import {
  getSkillCacheDir, isCacheFresh, readAgentCache, touchCacheEntry,
  writeAgentCache, writeSkillCache,
} from './marketplace_cache';
import {
  addAgentInstall, addSkillInstall, removeAgentInstall, removeSkillInstall,
} from './marketplace_installs';
import { createLogger } from '../logger';
import {
  validateAgentSpec, validateSkillDir,
  ValidationReport as QualityReport,
} from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';

const log = createLogger('marketplace');

// ── server URL ────────────────────────────────────────────────────────────
// Profile-driven (mirrors Server `env/start/{dev_,}api_start.sh` — see PC/CLAUDE.md §1 +
// Server CLAUDE.md §7): `ORKAS_PROFILE=global` (default) routes to overseas (`orkas.ai`),
// `ORKAS_PROFILE=cn` routes to China (`orkas.work`). `run.sh` exports the env from its
// positional arg (`./run.sh cn`). An explicit `ORKAS_API_BASE_URL` always wins.
//
// **No build-mode branch in this file on purpose** — OrkasOpen contract (per
// `OpenSource/SyncCode/strip-rules.json`) bans `app.isPackaged` checks outside the two
// whitelisted infra files. The "dev → local Server" default is set ONCE in `index.ts`
// (which IS whitelisted) by pinning `process.env.ORKAS_API_BASE_URL=http://127.0.0.1:8888/api`
// when `!app.isPackaged`, so every API base resolver picks it up uniformly — no scattered
// build-mode logic in feature modules.
const PROFILE_BASES: Record<string, string> = {
  global: 'https://www.orkas.ai/api',
  cn:     'https://www.orkas.work/api',
};

export function apiBase(): string {
  if (process.env.ORKAS_API_BASE_URL) return process.env.ORKAS_API_BASE_URL.replace(/\/+$/, '');
  const profile = process.env.ORKAS_PROFILE || 'global';
  return PROFILE_BASES[profile] || PROFILE_BASES.global;
}

// ── envelope ──────────────────────────────────────────────────────────────
interface Envelope { code: number; msg?: string; [k: string]: unknown }

export async function postJson<T>(p: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${p}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getCurrentLang(),
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data: Envelope;
  try { data = JSON.parse(text); } catch { throw new Error(`bad response (${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(data.msg || `marketplace ${p} failed (code=${data.code})`);
  return data as unknown as T;
}

// ── types ─────────────────────────────────────────────────────────────────
export interface MarketplaceCategory {
  code: string;
  name_zh: string;
  name_en: string;
  sort_order: number;
}

export interface MarketplaceAgent {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  icon: string;
  color: string;
  version: string;
  /** Author uid. `"0"` is the official-platform marker (UI label `marketplace.author_platform`);
   *  everything else is a community uploader. Dedup is on (name, create_uid), so same name from
   *  different authors yields distinct rows — the UI shows the author badge to tell them apart. */
  create_uid: string;
  download_count: number;
  published_at: number;
  updated_at: number;
  default_install?: boolean | number;
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  version: string;
  create_uid: string;
  download_count: number;
  published_at: number;
  updated_at: number;
  default_install?: boolean | number;
}

export interface AgentDetail {
  id: string;
  version: string;
  category: string;
  published_at: number;
  /** Full agent.json content (already merged from cache or freshly fetched). */
  agent_json: Record<string, unknown>;
  /** COS URL of the agent.json blob — recorded in installs.json so reconcile on other
   *  devices can fetch directly. May be empty on a cache-hit code path; install resolves
   *  via the detail endpoint when missing. */
  agent_json_url: string;
  /** Author uid from the server row. Recorded in `_install.json` so the in-app detail can
   *  render the author badge without a marketplace round-trip. May be `''` on cache-hit. */
  create_uid: string;
  default_install?: boolean;
}

export interface SkillDetail {
  id: string;
  version: string;
  category: string;
  published_at: number;
  /** Local filesystem path to the cache directory (caller can walk it to render the file tree
   *  + read SKILL.md). The cache may also be wiped between calls — re-fetch via this function. */
  cache_dir: string;
  /** COS URL of the skill bundle zip — recorded in installs.json for reconcile. */
  bundle_url: string;
  /** Same as `AgentDetail.create_uid`. */
  create_uid: string;
  default_install?: boolean;
}

// ── listing ───────────────────────────────────────────────────────────────
export async function listMarketplaceAgents(
  opts: { category?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceAgent[]; total: number }> {
  return await postJson('/marketplace/agents/list', {
    category: opts.category || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

export async function listMarketplaceSkills(
  opts: { category?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceSkill[]; total: number }> {
  return await postJson('/marketplace/skills/list', {
    category: opts.category || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

// ── detail (cache-aware) ──────────────────────────────────────────────────
// Detail-page entry. Caller provides the list-row's freshness pair so we can short-circuit
// when cache is hot; we still fetch + repopulate cache on miss / stale.
export async function getAgentDetail(
  agentId: string, expect: { version: string; published_at: number },
): Promise<AgentDetail> {
  if (!agentId) throw new Error('agentId required');
  if (await isCacheFresh('agent', agentId, expect)) {
    const cached = await readAgentCache(agentId);
    if (cached) {
      await touchCacheEntry('agent', agentId);
      // Cache hit path: agent_json_url / create_uid are unknown (not stored in cache meta).
      // Install path re-fetches via /detail to get them; detail render doesn't need them.
      return { id: agentId, version: expect.version, category: '', published_at: expect.published_at, agent_json: cached, agent_json_url: '', create_uid: '' };
    }
  }
  // Miss → fetch + repopulate.
  const data = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; agent_json_url: string; create_uid: string; default_install?: boolean }>(
    '/marketplace/agents/detail', { id: agentId },
  );
  await writeAgentCache(agentId, data.agent_json, { version: data.version, published_at: data.published_at });
  return { id: agentId, version: data.version, category: data.category, published_at: data.published_at, agent_json: data.agent_json, agent_json_url: data.agent_json_url || '', create_uid: data.create_uid || '', default_install: data.default_install === true };
}

export async function getSkillDetail(
  skillId: string, expect: { version: string; published_at: number },
): Promise<SkillDetail> {
  if (!skillId) throw new Error('skillId required');
  if (await isCacheFresh('skill', skillId, expect)) {
    await touchCacheEntry('skill', skillId);
    return { id: skillId, version: expect.version, category: '', published_at: expect.published_at, cache_dir: getSkillCacheDir(skillId), bundle_url: '', create_uid: '' };
  }
  // Miss → fetch + write.
  const meta = await postJson<{ bundle_url: string; version: string; category: string; published_at: number; create_uid: string; default_install?: boolean }>(
    '/marketplace/skills/bundle', { id: skillId },
  );
  await _fetchAndCacheSkill(skillId, meta);
  return { id: skillId, version: meta.version, category: meta.category, published_at: meta.published_at, cache_dir: getSkillCacheDir(skillId), bundle_url: meta.bundle_url, create_uid: meta.create_uid || '', default_install: meta.default_install === true };
}

/** Fetch a skill .zip from COS and extract into the local cache (idempotent: wipe-and-replace). */
async function _fetchAndCacheSkill(
  skillId: string, meta: { bundle_url: string; version: string; published_at: number },
): Promise<void> {
  const res = await fetch(meta.bundle_url);
  if (!res.ok) throw new Error(`download bundle failed (${res.status})`);
  const ab = await res.arrayBuffer();
  const zipBuf = Buffer.from(ab);
  await writeSkillCache(skillId, async (dir) => {
    extractBundleSafely(new AdmZip(zipBuf), dir);
  }, { version: meta.version, published_at: meta.published_at });
}

// zip-bomb defense, mirrored at server (see `api/marketplace.py::_validate_skill_bundle`).
// Server already enforces these caps on upload, but a corrupted COS blob or downgrade attack
// could deliver a different payload to the client — re-check on the unpack side too.
const MAX_BUNDLE_ENTRIES = 500;
const MAX_BUNDLE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;  // 64 MB

/** Walk a zip, validate every entry's path + per-entry / total uncompressed size, then write
 *  out. Throws on any limit breach (caller wraps the write in a fresh dir so a thrown error
 *  doesn't leave a half-extracted state). Exported so `marketplace_reconcile.ts` reuses
 *  exactly the same caps. */
export function extractBundleSafely(zip: AdmZip, dst: string): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`zip entry count ${entries.length} exceeds limit ${MAX_BUNDLE_ENTRIES}`);
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const safe = safeRelPath(entry.entryName);
    if (!safe) { log.warn(`skip unsafe zip entry: ${entry.entryName}`); continue; }
    // entry.header.size = uncompressed bytes (adm-zip per-entry field).
    total += entry.header.size;
    if (total > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
      throw new Error(`zip uncompressed total exceeds ${MAX_BUNDLE_UNCOMPRESSED_BYTES} bytes`);
    }
    const out = path.join(dst, safe);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.getData());
  }
}

// ── install ───────────────────────────────────────────────────────────────
export async function installMarketplaceAgent(
  agentId: string, expect: { version: string; published_at: number },
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  // Ensure cache is hot (and pick up agent_json_url for the manifest).
  let detail = await getAgentDetail(agentId, expect);
  if (!detail.agent_json_url) {
    // Cache-hit path returns url='' (and create_uid=''); re-fetch via detail endpoint to
    // capture both — needed for manifest + `_install.json` author badge.
    const fresh = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; agent_json_url: string; create_uid: string; default_install?: boolean }>(
      '/marketplace/agents/detail', { id: agentId },
    );
    detail = {
      id: agentId, version: fresh.version, category: fresh.category, published_at: fresh.published_at,
      agent_json: fresh.agent_json, agent_json_url: fresh.agent_json_url || '',
      create_uid: fresh.create_uid || '',
      default_install: fresh.default_install === true,
    };
  }

  // 1. Install dependent skills FIRST, in parallel. Any failure throws — the agent body
  //    and manifest entry are never touched, so retry is a clean re-run (previously-installed
  //    skills short-circuit via `_skillAlreadyOnDisk`). This is the atomicity guarantee called
  //    out in the file header.
  const skillList = Array.isArray((detail.agent_json as Record<string, unknown>).skill_list)
    ? ((detail.agent_json as Record<string, unknown>).skill_list as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const missingSkillIds = skillList.filter((sid) => !_skillAlreadyOnDisk(sid));
  if (missingSkillIds.length > 0) {
    await Promise.all(missingSkillIds.map(async (sid) => {
      // Direct hit on /skills/bundle for meta — avoids paging /skills/list (O(catalog) lookup
      // that breaks once the catalog grows past 500 skills).
      const meta = await postJson<{ bundle_url: string; version: string; category: string; published_at: number }>(
        '/marketplace/skills/bundle', { id: sid },
      );
      await installMarketplaceSkill(sid, { version: meta.version, published_at: meta.published_at });
      log.info(`  dep-installed skill ${sid}`);
    }));
  }

  // 2. Quality gate. Reject the install if `detail.agent_json` itself trips
  //    a red flag — content already on the catalog can still be malicious
  //    on a fresh user account, and the validator is the choke point that
  //    catches it before write. EXTREME → abort + persist report; MEDIUM
  //    only persists the report and lets the install proceed.
  const preReport = validateAgentSpec({ agentJson: detail.agent_json });
  await persistQualityReport({
    uid: getActiveUserId(), kind: 'agent', id: agentId, report: preReport,
  });
  if (!preReport.ok) {
    throw _qualityInstallError('agent', agentId, preReport);
  }

  // 3. Now materialize the agent: cache content → `<uid>/local/marketplace/agents/<id>/`.
  //    `_install.json` is a version pin read by `marketplace_reconcile.ts::_agentNeedsPull`
  //    on other devices to skip a re-pull when their local copy already matches the manifest's
  //    (version, published_at).
  const target = userMarketplaceAgentDir(getActiveUserId(), agentId);
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, 'agent.json'), JSON.stringify(detail.agent_json, null, 2), 'utf8');
  // `_install.json` stores everything the in-app UI needs without re-hitting the network:
  // version/published_at for reconcile freshness; create_uid for the author badge on the
  // agent detail page.
  await fsp.writeFile(path.join(target, '_install.json'),
    JSON.stringify({
      version: detail.version,
      published_at: detail.published_at,
      create_uid: detail.create_uid || '',
    }, null, 2), 'utf8');
  await touchCacheEntry('agent', agentId);

  // 4. Record in the cloud-synced manifest so other devices reconcile this install.
  await addAgentInstall(getActiveUserId(), {
    id: agentId, version: detail.version, published_at: detail.published_at,
    agent_json_url: detail.agent_json_url, create_uid: detail.create_uid || '',
  });
  log.info(`installed marketplace agent ${agentId} v${detail.version} → ${target}`);

  return { ok: true, id: agentId };
}

export async function installMarketplaceSkill(
  skillId: string, expect: { version: string; published_at: number },
): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  let detail = await getSkillDetail(skillId, expect);
  if (!detail.bundle_url) {
    const fresh = await postJson<{ bundle_url: string; version: string; category: string; published_at: number; create_uid: string; default_install?: boolean }>(
      '/marketplace/skills/bundle', { id: skillId },
    );
    detail = { ...detail, bundle_url: fresh.bundle_url, create_uid: fresh.create_uid || '', default_install: fresh.default_install === true };
  }

  const cacheDir = getSkillCacheDir(skillId);
  const target = userMarketplaceSkillDir(getActiveUserId(), skillId);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  await _copyDirSkippingCacheMeta(cacheDir, target);

  // Quality gate on the materialized dir (rule scope = SKILL.md +
  // scripts/*). EXTREME violations → roll back the install dir + persist
  // the failed report + throw. MEDIUM passes through but the report is
  // persisted so the UI advisory chip shows.
  const skillReport = validateSkillDir(target);
  await persistQualityReport({
    uid: getActiveUserId(), kind: 'skill', id: skillId, report: skillReport,
  });
  if (!skillReport.ok) {
    await fsp.rm(target, { recursive: true, force: true });
    throw _qualityInstallError('skill', skillId, skillReport);
  }

  await fsp.writeFile(path.join(target, '_install.json'),
    JSON.stringify({
      version: detail.version,
      published_at: detail.published_at,
      create_uid: detail.create_uid || '',
    }, null, 2), 'utf8');
  await touchCacheEntry('skill', skillId);
  invalidateCoreAgentSkills();

  await addSkillInstall(getActiveUserId(), {
    id: skillId, version: detail.version, published_at: detail.published_at,
    bundle_url: detail.bundle_url, create_uid: detail.create_uid || '',
  });
  log.info(`installed marketplace skill ${skillId} v${detail.version} → ${target}`);
  return { ok: true, id: skillId };
}

/** Check if a skill is already present in any local source — either as a custom skill under
 *  `<uid>/cloud/skills/<id>/` OR a marketplace install under `<uid>/local/marketplace/skills/<id>/`.
 *  Both are valid; cascade install only triggers when missing. */
function _skillAlreadyOnDisk(skillId: string): boolean {
  try {
    const customRoot = userSkillsDir(getActiveUserId());
    if (fs.existsSync(path.join(customRoot, skillId, 'SKILL.md'))) return true;
    const installedDir = userMarketplaceSkillDir(getActiveUserId(), skillId);
    if (fs.existsSync(path.join(installedDir, 'SKILL.md'))) return true;
  } catch { /* getActiveUserId throws when no active uid */ }
  return false;
}

/** Build a single-line error message for a quality-rejected install. The
 *  full report is already persisted under `<uid>/local/quality_reports/`;
 *  the renderer reads it via the `quality.readReport` IPC to display the
 *  detailed violation list. The throw here is just the propagation path. */
function _qualityInstallError(
  kind: 'agent' | 'skill', id: string, report: QualityReport,
): Error {
  const top = report.violations.find((v) => v.level === 'EXTREME');
  const reason = top ? `${top.rule}: ${top.suggested_fix}` : 'validation failed';
  const e = new Error(`Quality validation rejected ${kind} ${id} (${reason})`);
  (e as { qualityKind?: string }).qualityKind = kind;
  (e as { qualityId?: string }).qualityId = id;
  (e as { qualityReport?: QualityReport }).qualityReport = report;
  return e;
}

async function _copyDirSkippingCacheMeta(src: string, dst: string): Promise<void> {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '_cache.json') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fsp.mkdir(d, { recursive: true });
      await _copyDirSkippingCacheMeta(s, d);
    } else if (e.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

// ── default install seed (fresh launch) ───────────────────────────────────
// Goal: on the very first launch a user sees a curated baseline of official agents / skills
// without lifting a finger. The server `POST /marketplace/defaults` returns the recommended
// set (rows with `default_install=1`); we add a manifest row per item and let the standard
// `marketplace_reconcile` pass fetch the actual content at boot.
//
// **Why a separate marker (not manifest existence)**: manifest gets mutated row-by-row
// during seed via `add*Install`. If the process crashes mid-loop, the manifest exists but is
// incomplete — using it as the "already seeded" signal would skip seed forever, dropping
// the remaining items. Instead we drop a marker file `.default-seeded.json` only AFTER every
// row has been persisted. Failures (fetch / mid-loop crash / reconcile network error) leave
// the marker absent → next launch retries; `add*Install` is upsert so previously-written
// rows update in place. Once written, the marker is the permanent "don't pester" signal —
// later uninstall of a default item does NOT cause it to reappear.
export async function ensureDefaultInstalls(uid: string): Promise<{ seeded_agents: number; seeded_skills: number }> {
  const markerFile = marketplaceDefaultsSeededFile(uid);
  if (fs.existsSync(markerFile)) {
    return { seeded_agents: 0, seeded_skills: 0 };
  }
  try {
    const data = await postJson<{
      agents: { id: string; version: string; published_at: number; agent_json_url: string; create_uid?: string }[];
      skills: { id: string; version: string; published_at: number; bundle_url: string; create_uid?: string }[];
    }>('/marketplace/defaults', {});
    let seededAgents = 0;
    let seededSkills = 0;
    for (const a of data.agents || []) {
      if (!a || !a.id) continue;
      await addAgentInstall(uid, {
        id: a.id, version: a.version || '1.0.0',
        published_at: a.published_at || 0,
        agent_json_url: a.agent_json_url || '',
        create_uid: a.create_uid || '',
      });
      seededAgents++;
    }
    for (const s of data.skills || []) {
      if (!s || !s.id) continue;
      await addSkillInstall(uid, {
        id: s.id, version: s.version || '1.0.0',
        published_at: s.published_at || 0,
        bundle_url: s.bundle_url || '',
        create_uid: s.create_uid || '',
      });
      seededSkills++;
    }
    // Marker is written LAST so any crash above leaves a partially-seeded manifest + no
    // marker → next launch retries the whole loop, and add*Install upserts the rows that
    // were already there. Failure here (rare disk issue) likewise → retry next launch.
    await fsp.mkdir(userMarketplaceDirCloud(uid), { recursive: true });
    await fsp.writeFile(markerFile, JSON.stringify({
      seeded_at: Date.now(),
      version: 1,
      agent_ids: (data.agents || []).map((a) => a.id),
      skill_ids: (data.skills || []).map((s) => s.id),
    }, null, 2), 'utf8');
    log.info(`seeded default installs: ${seededAgents} agent(s) + ${seededSkills} skill(s)`);
    return { seeded_agents: seededAgents, seeded_skills: seededSkills };
  } catch (err) {
    // No marker written → next launch retries. Manifest may be partially populated; that's
    // fine because `reconcileInstalls` will pick up the rows that are there and the next
    // ensure pass will finish the rest.
    log.warn(`default installs seed failed (will retry on next launch): ${(err as Error).message}`);
    return { seeded_agents: 0, seeded_skills: 0 };
  }
}

// ── uninstall (user-facing; non-dev) ──────────────────────────────────────
// Removes the per-machine install copy + manifest entry. **Does NOT touch the server row**
// (different from `marketplace_dev.deleteMarketplace*` which wipes COS + DB). After this runs:
//   - listAgents / listSkills stops including this id under the "Platform" group
//   - cloud sync propagates the missing manifest entry to other devices, where startup
//     `marketplace_reconcile` notices nothing to pull and the install disappears there too
//   - the marketplace catalog still lists the item; the user can re-install at any time
// Dependent skills (for an agent) are **not** cascade-uninstalled — other agents may share them.

export async function uninstallMarketplaceAgent(agentId: string): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  const uid = getActiveUserId();
  await fsp.rm(userMarketplaceAgentDir(uid, agentId), { recursive: true, force: true });
  await fsp.rm(marketplaceCacheAgentDir(uid, agentId), { recursive: true, force: true });
  await removeAgentInstall(uid, agentId);
  log.info(`uninstalled marketplace agent ${agentId} (local + cache + manifest)`);
  return { ok: true, id: agentId };
}

export async function uninstallMarketplaceSkill(skillId: string): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  const uid = getActiveUserId();
  await fsp.rm(userMarketplaceSkillDir(uid, skillId), { recursive: true, force: true });
  await fsp.rm(marketplaceCacheSkillDir(uid, skillId), { recursive: true, force: true });
  await removeSkillInstall(uid, skillId);
  invalidateCoreAgentSkills();
  log.info(`uninstalled marketplace skill ${skillId} (local + cache + manifest)`);
  return { ok: true, id: skillId };
}

// ── helpers (exported for marketplace_dev.ts) ─────────────────────────────

/** A path is safe if it's a relative POSIX-style path inside the target dir — no absolute,
 *  no `..` segments, no empty / dot paths. Used both when materializing a marketplace skill
 *  bundle and when packing one (defense in depth — bundles travel through COS, which is
 *  outside our trust boundary). */
export function safeRelPath(rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null;
  if (path.isAbsolute(rel)) return null;
  // `path.posix.normalize` collapses any internal `a/../b` to `b`, so `/../` literally cannot
  // survive normalization — only a leading `..` (escape attempt) or pure-dot / empty paths
  // remain to be rejected.
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm === '.' || norm === '') return null;
  if (norm.startsWith('/')) return null;
  return norm;
}
