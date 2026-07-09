/**
 * Marketplace — browse + install official agents / skills from the Orkas Server.
 *
 * Three-layer storage model:
 *
 *   1. **Server** owns the catalog (marketplace_agents / marketplace_skills tables) and the
 *      blob URLs (agent.json on COS, skill bundle .zip on COS).
 *   2. **Cloud-synced install manifest** (`<uid>/cloud/marketplace/installs.json`) — the only
 *      multi-device state. Records what the user has installed: id / version / freshness
 *      timestamp / COS URL / installed_at. See `marketplace_installs.ts`.
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
import { app } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { sha256OfFile } from '../util/sha256';
import { marketplaceContentTreeHash } from '../util/marketplace-tree-hash';
import { logPathRef } from '../util/log-redact';
import { fetchWithRetry } from '../util/retry';
import {
  minAppVersionFrom,
  normalizeMinAppVersion,
  satisfiesMinAppVersion,
  type MinAppVersionSource,
} from '../util/app-version-compat';

import {
  userSkillsDir,
  userMarketplaceAgentDir, userMarketplaceAgentSkillsDir, userMarketplaceSkillDir,
  userMarketplaceAgentsDir, userMarketplaceSkillsDir,
  marketplaceCacheAgentDir, marketplaceCacheSkillDir,
  userMarketplaceInstallsFile, marketplaceDefaultsSeededFile,
  userMarketplaceDirCloud,
} from '../paths';
import { getActiveUserId, isAnonymousLocalId } from './users';
import { withCommonHeaders } from './api_common';
import { getLanguage } from './config';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import {
  getSkillCacheDir, isCacheFresh, readAgentCache, touchCacheEntry,
  writeAgentCache, writeSkillCache,
} from './marketplace_cache';
import {
  addAgentInstall, addSkillInstall, readInstalls, removeAgentInstall, removeSkillInstall,
} from './marketplace_installs';
import { withMarketplaceCacheLock, withMarketplaceInstallLock } from './marketplace_locks';
import { createLogger } from '../logger';
import {
  validateAgentSpec, validateSkillDir,
  ValidationReport as QualityReport,
} from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';

const log = createLogger('marketplace');
const MARKETPLACE_JSON_TIMEOUT_MS = 60_000;
const MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// ── server URL ────────────────────────────────────────────────────────────
// The open-source build has exactly one server environment: global prod. Use the apex host
// directly so marketplace POST calls do not first hit a www -> apex 301 redirect.
const GLOBAL_PROD_API_BASE = 'https://orkas.ai' + '/api';

export function apiBase(): string {
  return GLOBAL_PROD_API_BASE;
}

// ── envelope ──────────────────────────────────────────────────────────────
interface Envelope { code: number; msg?: string; [k: string]: unknown }

export async function postJson<T>(p: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`marketplace:${p}`, `${apiBase()}${p}`, {
    method: 'POST',
    headers: withCommonHeaders({
      'Content-Type': 'application/json',
      'Accept-Language': getLanguage(),
    }),
    body: JSON.stringify(body || {}),
  }, {
    timeoutMs: MARKETPLACE_JSON_TIMEOUT_MS,
    timeoutMessage: `marketplace:${p} timed out after ${Math.round(MARKETPLACE_JSON_TIMEOUT_MS / 1000)}s`,
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
  name_ja?: string;
  name_pt?: string;
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
  agent_skills_bundle_url?: string;
  /** Author uid. `"0"` is the official-platform marker (UI label `marketplace.author_platform`);
   *  everything else is a community uploader. Dedup is on (name, create_uid), so same name from
   *  different authors yields distinct rows — the UI shows the author badge to tell them apart. */
  create_uid: string;
  download_count: number;
  published_at: number;
  updated_at: number;
  default_install?: boolean | number;
  is_open_source?: boolean | number;
  status?: string;
  min_app_version?: string;
  minAppVersion?: string;
  min_version?: string;
  minVersion?: string;
  min_pc_version?: string;
  minPcVersion?: string;
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
  is_open_source?: boolean | number;
  status?: string;
  min_app_version?: string;
  minAppVersion?: string;
  min_version?: string;
  minVersion?: string;
  min_pc_version?: string;
  minPcVersion?: string;
}

export interface AgentDetail {
  id: string;
  version: string;
  category: string;
  published_at: number;
  updated_at?: number;
  /** Full agent.json content (already merged from cache or freshly fetched). */
  agent_json: Record<string, unknown>;
  /** COS URL of the agent.json blob — recorded in installs.json so reconcile on other
   *  devices can fetch directly. May be empty on a cache-hit code path; install resolves
   *  via the detail endpoint when missing. */
  agent_json_url: string;
  /** Optional zip containing this agent's private skills. Empty means none. */
  agent_skills_bundle_url?: string;
  /** Author uid from the server row. Recorded in `_install.json` so the in-app detail can
   *  render the author badge without a marketplace round-trip. May be `''` on cache-hit. */
  create_uid: string;
  default_install?: boolean;
  is_open_source?: boolean;
  status?: string;
  min_app_version?: string;
}

export interface SkillDetail {
  id: string;
  name?: string;
  version: string;
  category: string;
  published_at: number;
  updated_at?: number;
  /** Local filesystem path to the cache directory (caller can walk it to render the file tree
   *  + read SKILL.md). The cache may also be wiped between calls — re-fetch via this function. */
  cache_dir: string;
  /** COS URL of the skill bundle zip — recorded in installs.json for reconcile. */
  bundle_url: string;
  /** Same as `AgentDetail.create_uid`. */
  create_uid: string;
  default_install?: boolean;
  is_open_source?: boolean;
  status?: string;
  min_app_version?: string;
}

// ── listing ───────────────────────────────────────────────────────────────
export async function listMarketplaceAgents(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceAgent[]; total: number }> {
  return await postJson('/marketplace/agents/list', {
    category: opts.category || null,
    status: opts.status || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

export async function listMarketplaceSkills(
  opts: { category?: string; status?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceSkill[]; total: number }> {
  return await postJson('/marketplace/skills/list', {
    category: opts.category || null,
    status: opts.status || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

// Open-source projects专区 — a curated, read-only catalog (config-as-code on
// the Server; no upload path). Unlike agents/skills it carries `driver`
// (install/cli/mcp — the existing mechanism that runs it, not a new system),
// `repo`, and a user-language `task_*` one-liner used to prefill the
// Commander composer when a card is clicked. The list endpoint also returns
// the OSS-specific `categories` so the client renders the chip row in one
// round-trip.
export type ProjectDriver = 'install' | 'cli' | 'mcp';
export interface MarketplaceProject {
  id: string;
  name: string;
  repo: string;
  category: string;
  driver: ProjectDriver;
  glyph: string;
  color: string;
  by: string;
  description_zh: string;
  description_en: string;
  task_zh: string;
  task_en: string;
  home?: boolean;
}
export interface MarketplaceProjectsListResult {
  list: MarketplaceProject[];
  total: number;
  categories: MarketplaceCategory[];
  source?: 'server' | 'bundled';
  stale?: boolean;
}

interface MarketplaceProjectsCatalog {
  categories: MarketplaceCategory[];
  projects: MarketplaceProject[];
}

let _localProjectsCatalog: MarketplaceProjectsCatalog | null = null;

function _loadLocalProjectsCatalog(): MarketplaceProjectsCatalog {
  if (_localProjectsCatalog) return _localProjectsCatalog;
  // Bundled mirror of Server/biz/marketplace/marketplace_mgr.py::_OSS_* for offline dev.
  const file = path.join(__dirname, '..', 'data', 'oss-projects.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<MarketplaceProjectsCatalog>;
  _localProjectsCatalog = {
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
  return _localProjectsCatalog;
}

function _normProjectListOpts(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): { category: string; q: string; page: number; size?: number; homeOnly: boolean } {
  const page = Number(opts.page);
  const size = Number(opts.size);
  return {
    category: String(opts.category || '').trim().toLowerCase(),
    q: String(opts.q || '').trim().toLowerCase(),
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
    ...(Number.isFinite(size) ? { size: Math.max(1, Math.min(100, Math.floor(size))) } : {}),
    homeOnly: opts.home_only === true,
  };
}

function _listLocalMarketplaceProjects(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): MarketplaceProjectsListResult {
  const catalog = _loadLocalProjectsCatalog();
  const normalized = _normProjectListOpts(opts);
  const categoryCodes = new Set(catalog.categories.map((c) => c.code));
  let rows = catalog.projects;
  if (normalized.homeOnly) rows = rows.filter((p) => p.home);
  if (normalized.category && categoryCodes.has(normalized.category)) {
    rows = rows.filter((p) => p.category === normalized.category);
  } else if (normalized.category) {
    rows = [];
  }
  if (normalized.q) {
    rows = rows.filter((p) => [
      p.name,
      p.repo,
      p.by,
      p.description_zh,
      p.description_en,
      p.task_zh,
      p.task_en,
    ].join(' ').toLowerCase().includes(normalized.q));
  }

  const total = rows.length;
  const size = normalized.size || (normalized.homeOnly ? total || 1 : 20);
  const start = (normalized.page - 1) * size;
  const categories = catalog.categories
    .slice()
    .sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code));

  return {
    list: rows.slice(start, start + size).map((p) => ({ ...p })),
    total,
    categories: categories.map((c) => ({ ...c })),
    source: 'bundled',
    stale: true,
  };
}

// Main-process conditional cache for the OSS projects list: store the last
// ETag + parsed body per query so PC's per-launch home-strip revalidation costs
// a 304 instead of re-downloading the (small) catalog. In-memory only — a fresh
// process re-establishes the ETag on its first call; bounded so ad-hoc searches
// can't grow it without limit.
// INVARIANT: the cache key is the request body ONLY. This is correct because the
// OSS projects list is public / account-independent and `apiBase()` is pinned for
// the process lifetime. If either ever becomes user/profile-scoped at runtime,
// fold the account/profile (and apiBase) into the key or a 304 could replay
// another scope's body.
const _projectsConditional = new Map<string, { etag: string; result: MarketplaceProjectsListResult }>();
const _PROJECTS_CONDITIONAL_MAX = 64;

async function _fetchProjectsListConditional(body: Record<string, unknown>): Promise<MarketplaceProjectsListResult> {
  const key = JSON.stringify(body);
  const prior = _projectsConditional.get(key);
  const headers: Record<string, string> = withCommonHeaders({
    'Content-Type': 'application/json',
    'Accept-Language': getLanguage(),
  });
  if (prior) headers['If-None-Match'] = prior.etag;
  const res = await fetchWithRetry(
    'marketplace:/marketplace/projects/list',
    `${apiBase()}/marketplace/projects/list`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      timeoutMs: MARKETPLACE_JSON_TIMEOUT_MS,
      timeoutMessage: `marketplace:/marketplace/projects/list timed out after ${Math.round(MARKETPLACE_JSON_TIMEOUT_MS / 1000)}s`,
    },
  );
  if (res.status === 304 && prior) return prior.result;
  const text = await res.text();
  let data: Envelope;
  try { data = JSON.parse(text); } catch { throw new Error(`bad response (${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(data.msg || `marketplace /marketplace/projects/list failed (code=${data.code})`);
  const result = data as unknown as MarketplaceProjectsListResult;
  const etag = res.headers.get('etag');
  if (etag) {
    if (_projectsConditional.size >= _PROJECTS_CONDITIONAL_MAX) _projectsConditional.clear();
    _projectsConditional.set(key, { etag, result });
  }
  return result;
}

export async function listMarketplaceProjects(
  opts: { category?: string; q?: string; page?: number; size?: number; home_only?: boolean; local_only?: boolean } = {},
): Promise<MarketplaceProjectsListResult> {
  if (opts.local_only === true) return _listLocalMarketplaceProjects(opts);
  try {
    const fresh = await _fetchProjectsListConditional({
      category: opts.category || null,
      q: opts.q || null,
      page: opts.page || 1,
      ...(typeof opts.size === 'number' ? { size: opts.size } : {}),
      home_only: opts.home_only === true,
    });
    return { ...fresh, source: fresh.source || 'server', stale: false };
  } catch (err) {
    log.warn('marketplace projects server list failed; using bundled catalog', {
      error: (err as Error)?.message || String(err),
    });
    return _listLocalMarketplaceProjects(opts);
  }
}

// ── detail (cache-aware) ──────────────────────────────────────────────────
// Detail-page entry. Caller provides the list-row's freshness pair so we can short-circuit
// when cache is hot; we still fetch + repopulate cache on miss / stale.
type MarketplaceFreshness = {
  version: string;
  published_at: number;
  updated_at?: number;
} & MinAppVersionSource;
type MarketplaceInstallKind = 'agent' | 'skill';
type MarketplaceInstallOpts = { force?: boolean; name?: string };

function _currentAppVersion(): string {
  try { return app.getVersion(); } catch { return ''; }
}

function _normalizeMarketplaceMinAppVersion(...sources: Array<MinAppVersionSource | null | undefined>): string {
  return minAppVersionFrom(...sources);
}

function _assertMarketplaceAppCompatible(kind: MarketplaceInstallKind, id: string, name: string | undefined, minAppVersion: string): void {
  const min = normalizeMinAppVersion(minAppVersion);
  if (!min) return;
  const current = _currentAppVersion();
  if (satisfiesMinAppVersion(current, min)) return;
  throw new MarketplaceInstallError(
    kind,
    id,
    name,
    `requires Orkas >= ${min}; current ${current || 'unknown'}`,
    { appUpdateRequired: true, minAppVersion: min, currentAppVersion: current || '' },
  );
}

function _isMarketplaceAppCompatible(minAppVersion: string): boolean {
  return satisfiesMinAppVersion(_currentAppVersion(), minAppVersion);
}

export class MarketplaceInstallError extends Error {
  code = 'MARKETPLACE_INSTALL_FAILED';
  marketplaceKind: MarketplaceInstallKind;
  marketplaceId: string;
  marketplaceName: string;
  marketplaceReason: string;
  /** Set when the install was blocked because the client app is older than
   *  the item's min_app_version. The renderer can then show localized copy. */
  appUpdateRequired = false;
  minAppVersion = '';
  currentAppVersion = '';

  constructor(
    kind: MarketplaceInstallKind,
    id: string,
    name: string | undefined,
    reason: string,
    extra?: { appUpdateRequired?: boolean; minAppVersion?: string; currentAppVersion?: string },
  ) {
    const label = kind === 'agent' ? 'agent' : 'skill';
    const cleanName = String(name || '').trim();
    const displayName = cleanName || (id || '').trim();
    super(`${label} ${displayName}: ${reason}`);
    this.name = 'MarketplaceInstallError';
    this.marketplaceKind = kind;
    this.marketplaceId = id;
    this.marketplaceName = cleanName;
    this.marketplaceReason = reason;
    if (extra?.appUpdateRequired) this.appUpdateRequired = true;
    if (extra?.minAppVersion) this.minAppVersion = extra.minAppVersion;
    if (extra?.currentAppVersion) this.currentAppVersion = extra.currentAppVersion;
  }
}

export function getMarketplaceInstallErrorInfo(err: unknown): {
  kind?: MarketplaceInstallKind;
  id?: string;
  name?: string;
  reason: string;
  qualityReport?: QualityReport;
  appUpdateRequired?: boolean;
  minAppVersion?: string;
  currentAppVersion?: string;
} {
  const e = err as Partial<MarketplaceInstallError> & { message?: string; qualityReport?: QualityReport };
  return {
    kind: e.marketplaceKind,
    id: e.marketplaceId,
    name: e.marketplaceName,
    reason: e.marketplaceReason || e.message || String(err),
    qualityReport: e.qualityReport,
    ...(e.appUpdateRequired ? {
      appUpdateRequired: true,
      minAppVersion: e.minAppVersion || '',
      currentAppVersion: e.currentAppVersion || '',
    } : {}),
  };
}

function _wrapMarketplaceInstallError(
  kind: MarketplaceInstallKind,
  id: string,
  name: string | undefined,
  err: unknown,
): MarketplaceInstallError {
  if (err instanceof MarketplaceInstallError) return err;
  const reason = (err as Error)?.message || String(err);
  const wrapped = new MarketplaceInstallError(kind, id, name, reason);
  const qualityReport = (err as { qualityReport?: QualityReport })?.qualityReport;
  if (qualityReport) (wrapped as { qualityReport?: QualityReport }).qualityReport = qualityReport;
  return wrapped;
}

function _agentJsonName(agentJson: Record<string, unknown>): string {
  const raw = agentJson?.name;
  return typeof raw === 'string' ? raw.trim() : '';
}

const SKILL_DISPLAY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BUILTIN_WORKFLOW_REFS = new Set([
  'read_file', 'write_file', 'bash', 'kb_search', 'kb_read',
  'markdown_to_pdf', 'html_to_pdf', 'generate_image', 'web_search', 'web_fetch',
]);

function _agentSkillDependencyDisplayNames(
  agentJson: Record<string, unknown>,
  skillList: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const workflow = typeof agentJson.workflow === 'string' ? agentJson.workflow : '';
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = raw.trim();
    if (!SKILL_DISPLAY_REF_RE.test(name) || seen.has(name)) return;
    if (BUILTIN_WORKFLOW_REFS.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  // Marketplace-installed agents store dependency ids in skill_list, while older
  // authored workflows often still mention the readable skill names. Pair by order
  // so a stale id can still produce a useful user-facing failure.
  const useRe = /\buse\s+`([^`]+)`/gi;
  for (let m = useRe.exec(workflow); m; m = useRe.exec(workflow)) add(m[1]);
  if (names.length < skillList.length) {
    const skillRe = /`([^`]+)`\s+skill\b/gi;
    for (let m = skillRe.exec(workflow); m; m = skillRe.exec(workflow)) add(m[1]);
  }

  skillList.forEach((sid, idx) => {
    const display = names[idx] || (SKILL_DISPLAY_REF_RE.test(sid) && !/^[0-9a-f]{12}$/i.test(sid) ? sid : '');
    if (display) out.set(sid, display);
  });
  return out;
}

function _marketplaceStatus(row: { status?: string; state?: string }): string {
  return String(row.status || row.state || '').trim().toLowerCase();
}

function _assertApprovedDependencySkill(
  skillId: string,
  displayName: string,
  row: { status?: string; state?: string },
): void {
  const status = _marketplaceStatus(row);
  if (status !== 'approved') {
    throw new MarketplaceInstallError(
      'skill',
      skillId,
      displayName || skillId,
      status ? `status_not_approved:${status}` : 'status_not_approved',
    );
  }
}

export async function getAgentDetail(
  agentId: string, expect: MarketplaceFreshness,
): Promise<AgentDetail> {
  if (!agentId) throw new Error('agentId required');
  if (await isCacheFresh('agent', agentId, expect)) {
    const cached = await readAgentCache(agentId);
    if (cached) {
      await touchCacheEntry('agent', agentId);
      // Cache hit path: agent_json_url / create_uid are unknown (not stored in cache meta).
      // Install path re-fetches via /detail to get them; detail render doesn't need them.
      return {
        id: agentId, version: expect.version, category: '',
        published_at: expect.published_at, updated_at: expect.updated_at,
        agent_json: cached, agent_json_url: '', create_uid: '',
        ...(_normalizeMarketplaceMinAppVersion(expect, cached) ? { min_app_version: _normalizeMarketplaceMinAppVersion(expect, cached) } : {}),
      };
    }
  }
  // Miss → fetch + repopulate.
  const data = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
    '/marketplace/agents/detail', { id: agentId },
  );
  await writeAgentCache(agentId, data.agent_json, {
    version: data.version, published_at: data.published_at, updated_at: data.updated_at,
  });
  const minAppVersion = _normalizeMarketplaceMinAppVersion(data, data.agent_json);
  return {
    id: agentId, version: data.version, category: data.category,
    published_at: data.published_at, updated_at: data.updated_at,
    agent_json: data.agent_json, agent_json_url: data.agent_json_url || '',
    agent_skills_bundle_url: data.agent_skills_bundle_url || '',
    create_uid: data.create_uid || '', default_install: data.default_install === true,
    is_open_source: data.is_open_source === true, status: data.status || data.state || '',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

export async function getSkillDetail(
  skillId: string, expect: MarketplaceFreshness,
): Promise<SkillDetail> {
  if (!skillId) throw new Error('skillId required');
  if (await isCacheFresh('skill', skillId, expect)) {
    await touchCacheEntry('skill', skillId);
    return {
      id: skillId, version: expect.version, category: '',
      published_at: expect.published_at, updated_at: expect.updated_at,
      cache_dir: getSkillCacheDir(skillId), bundle_url: '', create_uid: '',
      ...(_normalizeMarketplaceMinAppVersion(expect) ? { min_app_version: _normalizeMarketplaceMinAppVersion(expect) } : {}),
    };
  }
  // Miss → fetch + write.
  const meta = await postJson<{ bundle_url: string; version: string; category: string; published_at: number; updated_at?: number; create_uid: string; default_install?: boolean; is_open_source?: boolean; name?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
    '/marketplace/skills/bundle', { id: skillId },
  );
  await _fetchAndCacheSkill(skillId, meta);
  const minAppVersion = _normalizeMarketplaceMinAppVersion(meta);
  return {
    id: skillId, name: meta.name || '', version: meta.version, category: meta.category,
    published_at: meta.published_at, updated_at: meta.updated_at,
    cache_dir: getSkillCacheDir(skillId), bundle_url: meta.bundle_url,
    create_uid: meta.create_uid || '', default_install: meta.default_install === true,
    is_open_source: meta.is_open_source === true, status: meta.status || meta.state || '',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

/** Fetch a skill .zip from COS and extract into the local cache (idempotent: wipe-and-replace). */
async function _fetchAndCacheSkill(
  skillId: string, meta: { bundle_url: string; version: string; published_at: number; updated_at?: number },
): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithRetry(`marketplace:skill-bundle:${skillId}`, meta.bundle_url, undefined, {
      timeoutMs: MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS,
      timeoutMessage: `marketplace:skill-bundle:${skillId} timed out after ${Math.round(MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS / 1000)}s`,
    });
  } catch (err) {
    throw new Error(`download bundle failed from ${_bundleHost(meta.bundle_url)}: ${(err as Error)?.message || String(err)}`);
  }
  if (!res.ok) throw new Error(`download bundle failed from ${_bundleHost(meta.bundle_url)} (${res.status})`);
  const ab = await res.arrayBuffer();
  const zipBuf = Buffer.from(ab);
  await writeSkillCache(skillId, async (dir) => {
    extractBundleSafely(new AdmZip(zipBuf), dir);
  }, { version: meta.version, published_at: meta.published_at, updated_at: meta.updated_at });
}

async function _fetchAgentPrivateSkillsBundle(agentId: string, bundleUrl: string): Promise<Buffer | null> {
  if (!bundleUrl) return null;
  let res: Response;
  try {
    res = await fetchWithRetry(`marketplace:agent-private-skills:${agentId}`, bundleUrl, undefined, {
      timeoutMs: MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS,
      timeoutMessage: `marketplace:agent-private-skills:${agentId} timed out after ${Math.round(MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS / 1000)}s`,
    });
  } catch (err) {
    throw new Error(`download agent private skills failed from ${_bundleHost(bundleUrl)}: ${(err as Error)?.message || String(err)}`);
  }
  if (!res.ok) throw new Error(`download agent private skills failed from ${_bundleHost(bundleUrl)} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function _bundleHost(bundleUrl: string): string {
  try {
    return new URL(bundleUrl).host || 'bundle host';
  } catch {
    return 'bundle host';
  }
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
  agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  return withMarketplaceInstallLock(
    getActiveUserId(),
    'agent',
    agentId,
    () => _installMarketplaceAgentLocked(agentId, expect, opts),
  );
}

async function _installMarketplaceAgentLocked(
  agentId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  let agentName = opts.name || '';
  try {
    // Ensure cache is hot (and pick up agent_json_url for the manifest).
    let detail = await getAgentDetail(agentId, expect);
    agentName = agentName || _agentJsonName(detail.agent_json);
    if (!detail.agent_json_url) {
      // Cache-hit path returns url='' (and create_uid=''); re-fetch via detail endpoint to
      // capture both — needed for manifest + `_install.json` author badge.
      const fresh = await postJson<{ agent_json: Record<string, unknown>; version: string; category: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid: string; default_install?: boolean; is_open_source?: boolean; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
        '/marketplace/agents/detail', { id: agentId },
      );
      const minAppVersion = _normalizeMarketplaceMinAppVersion(fresh, fresh.agent_json);
      detail = {
        id: agentId, version: fresh.version, category: fresh.category,
        published_at: fresh.published_at, updated_at: fresh.updated_at,
        agent_json: fresh.agent_json, agent_json_url: fresh.agent_json_url || '',
        agent_skills_bundle_url: fresh.agent_skills_bundle_url || '',
        create_uid: fresh.create_uid || '',
        default_install: fresh.default_install === true,
        is_open_source: fresh.is_open_source === true,
        status: fresh.status || fresh.state || '',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
      };
      agentName = agentName || _agentJsonName(detail.agent_json);
    }
    _assertMarketplaceAppCompatible('agent', agentId, agentName, detail.min_app_version || '');

    // 1. Install dependent skills FIRST, in parallel. Any failure throws — the agent body
    //    and manifest entry are never touched, so retry is a clean re-run (previously-installed
    //    skills short-circuit via `_skillAlreadyOnDisk`). This is the atomicity guarantee called
    //    out in the file header.
    const skillList = Array.isArray((detail.agent_json as Record<string, unknown>).skill_list)
      ? ((detail.agent_json as Record<string, unknown>).skill_list as unknown[])
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x): x is string => x.length > 0)
      : [];
    const depSkillNames = _agentSkillDependencyDisplayNames(detail.agent_json, skillList);
    const missingSkillIds = skillList.filter((sid) => !_skillAlreadyOnDisk(sid));
    if (missingSkillIds.length > 0) {
      await Promise.all(missingSkillIds.map(async (sid) => {
        let depSkillName = depSkillNames.get(sid) || '';
        try {
          // Direct hit on /skills/bundle for meta — avoids paging /skills/list (O(catalog) lookup
          // that breaks once the catalog grows past 500 skills).
          const meta = await postJson<{ bundle_url: string; version: string; category: string; published_at: number; updated_at?: number; name?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
            '/marketplace/skills/bundle', { id: sid },
          );
          depSkillName = meta.name || depSkillName;
          _assertApprovedDependencySkill(sid, depSkillName, meta);
          await installMarketplaceSkill(sid, {
            version: meta.version,
            published_at: meta.published_at,
            updated_at: meta.updated_at,
            ...(_normalizeMarketplaceMinAppVersion(meta) ? { min_app_version: _normalizeMarketplaceMinAppVersion(meta) } : {}),
          }, { force: opts.force === true, name: depSkillName });
          log.info(`  dep-installed skill ${sid}`);
        } catch (err) {
          throw _wrapMarketplaceInstallError('skill', sid, depSkillName || sid, err);
        }
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
    if (!preReport.ok && opts.force !== true) {
      throw _qualityInstallError('agent', agentId, preReport);
    }
    const privateSkillsZip = await _fetchAgentPrivateSkillsBundle(agentId, detail.agent_skills_bundle_url || '');

    // 3. Now materialize the agent: cache content → `<uid>/local/marketplace/agents/<id>/`.
    //    `_install.json` is a version pin read by `marketplace_reconcile.ts::_agentNeedsPull`
    //    on other devices to skip a re-pull when their local copy already matches the manifest's
    //    (version, freshness timestamp).
    const target = userMarketplaceAgentDir(getActiveUserId(), agentId);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    const agentJsonFile = path.join(target, 'agent.json');
    await fsp.writeFile(agentJsonFile, JSON.stringify(detail.agent_json, null, 2), 'utf8');
    if (privateSkillsZip) {
      const privateSkillsDir = userMarketplaceAgentSkillsDir(getActiveUserId(), agentId);
      await fsp.mkdir(privateSkillsDir, { recursive: true });
      extractBundleSafely(new AdmZip(privateSkillsZip), privateSkillsDir);
    }
    // `_install.json` stores everything the in-app UI needs without re-hitting the network:
    // version/freshness timestamp for reconcile; create_uid for the author badge on the
    // agent detail page; `content_sha` for the dev-mode local-edit guard in
    // `marketplace_reconcile._agentNeedsPull` (see that function's header).
    const installContentSha = sha256OfFile(agentJsonFile);
    const installTreeHash = marketplaceContentTreeHash(target);
    const installedAt = Date.now();
    await fsp.writeFile(path.join(target, '_install.json'),
      JSON.stringify({
        version: detail.version,
        published_at: detail.published_at,
        ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
        agent_json_url: detail.agent_json_url,
        agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
        installed_at: installedAt,
        create_uid: detail.create_uid || '',
        ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
        ...(typeof detail.is_open_source === 'boolean' ? { is_open_source: detail.is_open_source } : {}),
        ...(detail.status ? { status: detail.status } : {}),
        ...(detail.min_app_version ? { min_app_version: detail.min_app_version } : {}),
        ...(installContentSha ? { content_sha: installContentSha } : {}),
        ...(installTreeHash ? { content_tree_hash: installTreeHash } : {}),
      }, null, 2), 'utf8');
    await touchCacheEntry('agent', agentId);

    // 4. Record in the cloud-synced manifest so other devices reconcile this install.
    await addAgentInstall(getActiveUserId(), {
      id: agentId, version: detail.version, published_at: detail.published_at,
      ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
      agent_json_url: detail.agent_json_url, create_uid: detail.create_uid || '',
      agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
      installed_at: installedAt,
      ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      min_app_version: detail.min_app_version || '',
    });
    invalidateCoreAgentSkills();
    log.info('installed marketplace agent', { agentId, version: detail.version, target: logPathRef(target) });

    return { ok: true, id: agentId };
  } catch (err) {
    throw _wrapMarketplaceInstallError('agent', agentId, agentName, err);
  }
}

export async function installMarketplaceSkill(
  skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  return withMarketplaceInstallLock(
    getActiveUserId(),
    'skill',
    skillId,
    () => _installMarketplaceSkillLocked(skillId, expect, opts),
  );
}

async function _installMarketplaceSkillLocked(
  skillId: string, expect: MarketplaceFreshness, opts: MarketplaceInstallOpts = {},
): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  let skillName = opts.name || '';
  try {
    let detail = await getSkillDetail(skillId, expect);
    skillName = skillName || detail.name || '';
    if (!detail.bundle_url) {
      const fresh = await postJson<{ bundle_url: string; version: string; category: string; published_at: number; updated_at?: number; create_uid: string; default_install?: boolean; is_open_source?: boolean; name?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }>(
        '/marketplace/skills/bundle', { id: skillId },
      );
      skillName = skillName || fresh.name || '';
      const minAppVersion = _normalizeMarketplaceMinAppVersion(fresh);
      detail = {
        ...detail,
        name: fresh.name || detail.name,
        published_at: fresh.published_at,
        updated_at: fresh.updated_at,
        bundle_url: fresh.bundle_url,
        create_uid: fresh.create_uid || '',
        default_install: fresh.default_install === true,
        is_open_source: fresh.is_open_source === true,
        status: fresh.status || fresh.state || '',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
      };
    }
    _assertMarketplaceAppCompatible('skill', skillId, skillName, detail.min_app_version || '');

    const cacheDir = getSkillCacheDir(skillId);
    const uid = getActiveUserId();
    const target = userMarketplaceSkillDir(uid, skillId);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    await withMarketplaceCacheLock(uid, 'skill', skillId, async () => {
      await _copyDirSkippingCacheMeta(cacheDir, target);
    });

    // Quality gate on the materialized dir (rule scope = SKILL.md +
    // scripts/*). EXTREME violations → roll back the install dir + persist
    // the failed report + throw. MEDIUM passes through but the report is
    // persisted so the UI advisory chip shows.
    const skillReport = validateSkillDir(target);
    await persistQualityReport({
      uid: getActiveUserId(), kind: 'skill', id: skillId, report: skillReport,
    });
    if (!skillReport.ok && opts.force !== true) {
      await fsp.rm(target, { recursive: true, force: true });
      throw _qualityInstallError('skill', skillId, skillReport);
    }

    const skillContentSha = sha256OfFile(path.join(target, 'SKILL.md'));
    const skillTreeHash = marketplaceContentTreeHash(target);
    const installedAt = Date.now();
    await fsp.writeFile(path.join(target, '_install.json'),
      JSON.stringify({
        version: detail.version,
        published_at: detail.published_at,
        ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
        bundle_url: detail.bundle_url,
        installed_at: installedAt,
        create_uid: detail.create_uid || '',
        ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
        ...(typeof detail.is_open_source === 'boolean' ? { is_open_source: detail.is_open_source } : {}),
        ...(detail.status ? { status: detail.status } : {}),
        ...(detail.min_app_version ? { min_app_version: detail.min_app_version } : {}),
        ...(skillContentSha ? { content_sha: skillContentSha } : {}),
        ...(skillTreeHash ? { content_tree_hash: skillTreeHash } : {}),
      }, null, 2), 'utf8');
    await touchCacheEntry('skill', skillId);
    invalidateCoreAgentSkills();

    await addSkillInstall(getActiveUserId(), {
      id: skillId, version: detail.version, published_at: detail.published_at,
      ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : {}),
      bundle_url: detail.bundle_url, create_uid: detail.create_uid || '',
      installed_at: installedAt,
      ...(typeof detail.default_install === 'boolean' ? { default_install: detail.default_install } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      min_app_version: detail.min_app_version || '',
    });
    log.info('installed marketplace skill', { skillId, version: detail.version, target: logPathRef(target) });
    return { ok: true, id: skillId };
  } catch (err) {
    throw _wrapMarketplaceInstallError('skill', skillId, skillName, err);
  }
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
  const blockingViolations = report.violations.filter((v) => v.level === 'EXTREME');
  const top = blockingViolations[0];
  const reason = top ? `${top.rule}: ${top.suggested_fix}` : 'validation failed';
  const e = new Error(`Quality validation rejected ${kind} ${id} (${reason})`);
  (e as { qualityKind?: string }).qualityKind = kind;
  (e as { qualityId?: string }).qualityId = id;
  (e as { qualityReport?: QualityReport }).qualityReport = {
    ...report,
    ok: false,
    violations: blockingViolations,
  };
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

async function _seedAgentSkillDependencies(
  uid: string,
  agentId: string,
  installedSkills: Set<string>,
  deletedSkills: Set<string>,
  shouldContinue: () => boolean = () => true,
): Promise<{ seeded: number; blocked: boolean }> {
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  const detail = await postJson<{ agent_json: Record<string, unknown> }>(
    '/marketplace/agents/detail', { id: agentId },
  );
  if (!shouldContinue()) return { seeded: 0, blocked: true };
  const skillList = Array.isArray(detail.agent_json?.skill_list)
    ? (detail.agent_json.skill_list as unknown[])
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x): x is string => x.length > 0)
    : [];
  let seeded = 0;
  for (const sid of skillList) {
    if (!shouldContinue()) return { seeded, blocked: true };
    if (installedSkills.has(sid)) continue;
    if (deletedSkills.has(sid)) {
      log.info(`skip default agent ${agentId}; dependency skill ${sid} was previously uninstalled`);
      return { seeded, blocked: true };
    }
    try {
      const meta = await postJson<{ bundle_url: string; version: string; published_at: number; updated_at?: number; create_uid?: string; default_install?: boolean; status?: string; state?: string; name?: string; min_app_version?: string; minAppVersion?: string }>(
        '/marketplace/skills/bundle', { id: sid },
      );
      _assertApprovedDependencySkill(sid, meta.name || sid, meta);
      const minAppVersion = _normalizeMarketplaceMinAppVersion(meta);
      if (!_isMarketplaceAppCompatible(minAppVersion)) {
        throw new Error(`requires Orkas >= ${minAppVersion}; current ${_currentAppVersion() || 'unknown'}`);
      }
      if (!shouldContinue()) return { seeded, blocked: true };
      await addSkillInstall(uid, {
        id: sid,
        version: meta.version || '1.0.0',
        published_at: meta.published_at || 0,
        ...(typeof meta.updated_at === 'number' ? { updated_at: meta.updated_at } : {}),
        bundle_url: meta.bundle_url || '',
        create_uid: meta.create_uid || '',
        ...((meta.status || meta.state) ? { status: meta.status || meta.state } : {}),
        default_install: meta.default_install === true,
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
      });
      seeded++;
      installedSkills.add(sid);
    } catch (err) {
      log.warn(`skip default agent ${agentId}; dependency skill ${sid} seed failed: ${(err as Error).message}`);
      return { seeded, blocked: true };
    }
  }
  return { seeded, blocked: false };
}

// ── default install seed (fresh launch + incremental additions) ───────────
// Goal: users see a curated baseline of official agents / skills without lifting a finger.
// The server `POST /marketplace/defaults` returns the current recommended set (rows with
// `default_install=1`); we add a manifest row per missing item and let the standard
// `marketplace_reconcile` pass fetch the actual content at boot. Default agents mirror the
// manual install path's dependency rule: read `agent_json.skill_list` and seed missing skills
// first, so the reconciled agent never lands without its required skills.
//
// This is intentionally incremental, not one-shot: if the team marks a new marketplace item
// as default later, existing users who have never installed/uninstalled that id should get it
// on their next boot. User intent still wins: uninstall records a tombstone in
// `installs.json::_deleted_at`, and tombstoned ids are never re-seeded automatically. If a
// default agent depends on a tombstoned skill, the agent is skipped too rather than installed
// in a broken state.
//
// The marker file records the last observed default id set for diagnostics and crash recovery.
// It is written only AFTER every eligible row is persisted. If the process crashes mid-loop,
// `add*Install` upserts make the next boot safe to retry.
export type DefaultInstallsSeedResult = {
  seeded_agents: number;
  seeded_skills: number;
  skipped?: boolean;
  failed?: boolean;
  error?: string;
};

interface DefaultInstallMarker {
  seeded_at?: number;
  checked_at?: number;
  version?: number;
  agent_ids?: unknown;
  skill_ids?: unknown;
}

function _stringIdSet(ids: unknown): Set<string> {
  return new Set((Array.isArray(ids) ? ids : [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
}

async function _readDefaultInstallMarker(uid: string): Promise<DefaultInstallMarker | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(marketplaceDefaultsSeededFile(uid), 'utf8')) as DefaultInstallMarker;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function _markerRecentlyChecked(marker: DefaultInstallMarker | null, minIntervalMs: number, now = Date.now()): boolean {
  if (!marker || minIntervalMs <= 0) return false;
  const checkedAt = Number(marker.checked_at || marker.seeded_at || 0);
  return checkedAt > 0 && now - checkedAt < minIntervalMs;
}

function _hasLocalMarketplaceAgent(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceAgentDir(uid, id), 'agent.json'));
}

function _hasLocalMarketplaceSkill(uid: string, id: string): boolean {
  return fs.existsSync(path.join(userMarketplaceSkillDir(uid, id), 'SKILL.md'));
}

function _hasAnyLocalMarketplaceInstall(uid: string): boolean {
  const hasEntries = (dir: string): boolean => {
    try { return fs.readdirSync(dir).some((name) => !!name && !name.startsWith('.')); }
    catch { return false; }
  };
  return hasEntries(userMarketplaceAgentsDir(uid)) || hasEntries(userMarketplaceSkillsDir(uid));
}

export async function hasKnownDefaultInstallWork(uid: string): Promise<boolean> {
  if (!uid || isAnonymousLocalId(uid)) return false;
  try {
    const manifest = await readInstalls(uid);
    const installedAgents = new Set(manifest.agents.map((a) => a.id));
    const installedSkills = new Set(manifest.skills.map((s) => s.id));
    const deletedAgents = new Set(Object.keys(manifest._deleted_at?.agents || {}));
    const deletedSkills = new Set(Object.keys(manifest._deleted_at?.skills || {}));

    const marker = await _readDefaultInstallMarker(uid);

    if (marker) {
      for (const id of _stringIdSet(marker.agent_ids)) {
        if (deletedAgents.has(id)) continue;
        if (!installedAgents.has(id) || !_hasLocalMarketplaceAgent(uid, id)) return true;
      }
      for (const id of _stringIdSet(marker.skill_ids)) {
        if (deletedSkills.has(id)) continue;
        if (!installedSkills.has(id) || !_hasLocalMarketplaceSkill(uid, id)) return true;
      }
      return false;
    }

    const defaultAgents = manifest.agents.filter((a) => a.default_install === true);
    const defaultSkills = manifest.skills.filter((s) => s.default_install === true);
    if (defaultAgents.some((a) => !_hasLocalMarketplaceAgent(uid, a.id))) return true;
    if (defaultSkills.some((s) => !_hasLocalMarketplaceSkill(uid, s.id))) return true;

    // Fresh logged-in account: no marker, no manifest rows, no local marketplace installs.
    // Existing installs without an old marker should not flash the default-install banner.
    return manifest.agents.length === 0
      && manifest.skills.length === 0
      && !_hasAnyLocalMarketplaceInstall(uid);
  } catch {
    return false;
  }
}

export async function ensureDefaultInstalls(
  uid: string,
  opts: { shouldContinue?: () => boolean; minIntervalMs?: number; force?: boolean } = {},
): Promise<DefaultInstallsSeedResult> {
  const canContinue = (): boolean => !isAnonymousLocalId(uid) && (opts.shouldContinue ? opts.shouldContinue() : true);
  if (!canContinue()) {
    log.info('skip default installs seed: login required');
    return { seeded_agents: 0, seeded_skills: 0 };
  }
  const markerFile = marketplaceDefaultsSeededFile(uid);
  try {
    const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? Math.max(0, Number(opts.minIntervalMs)) : 0;
    const marker = await _readDefaultInstallMarker(uid);
    if (!opts.force && _markerRecentlyChecked(marker, minIntervalMs) && !(await hasKnownDefaultInstallWork(uid))) {
      log.info('skip default installs seed: checked recently');
      return { seeded_agents: 0, seeded_skills: 0, skipped: true };
    }
    const data = await postJson<{
      agents: { id: string; version: string; published_at: number; updated_at?: number; agent_json_url: string; agent_skills_bundle_url?: string; create_uid?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }[];
      skills: { id: string; version: string; published_at: number; updated_at?: number; bundle_url: string; create_uid?: string; status?: string; state?: string; min_app_version?: string; minAppVersion?: string }[];
    }>('/marketplace/defaults', {});
    if (!canContinue()) return { seeded_agents: 0, seeded_skills: 0 };
    const manifest = await readInstalls(uid);
    const installedAgents = new Set(manifest.agents.map((a) => a.id));
    const installedSkills = new Set(manifest.skills.map((s) => s.id));
    const deletedAgents = new Set(Object.keys(manifest._deleted_at?.agents || {}));
    const deletedSkills = new Set(Object.keys(manifest._deleted_at?.skills || {}));
    let seededAgents = 0;
    let seededSkills = 0;
    for (const a of data.agents || []) {
      if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
      if (!a || !a.id) continue;
      if (deletedAgents.has(a.id)) continue;
      try {
        const minAppVersion = _normalizeMarketplaceMinAppVersion(a);
        if (!_isMarketplaceAppCompatible(minAppVersion)) {
          log.info(`skip default agent ${a.id}; requires Orkas >= ${minAppVersion}`);
          continue;
        }
        const depSeed = await _seedAgentSkillDependencies(uid, a.id, installedSkills, deletedSkills, canContinue);
        if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
        seededSkills += depSeed.seeded;
        if (installedAgents.has(a.id) || depSeed.blocked) continue;
        await addAgentInstall(uid, {
          id: a.id, version: a.version || '1.0.0',
          published_at: a.published_at || 0,
          ...(typeof a.updated_at === 'number' ? { updated_at: a.updated_at } : {}),
          agent_json_url: a.agent_json_url || '',
          agent_skills_bundle_url: a.agent_skills_bundle_url || '',
          create_uid: a.create_uid || '',
          ...((a.status || a.state) ? { status: a.status || a.state } : {}),
          default_install: true,
          ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        });
        seededAgents++;
        installedAgents.add(a.id);
      } catch (err) {
        log.warn(`skip default agent ${a.id}; seed failed: ${(err as Error).message}`);
      }
    }
    for (const s of data.skills || []) {
      if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
      if (!s || !s.id) continue;
      if (installedSkills.has(s.id) || deletedSkills.has(s.id)) continue;
      try {
        const minAppVersion = _normalizeMarketplaceMinAppVersion(s);
        if (!_isMarketplaceAppCompatible(minAppVersion)) {
          log.info(`skip default skill ${s.id}; requires Orkas >= ${minAppVersion}`);
          continue;
        }
        await addSkillInstall(uid, {
          id: s.id, version: s.version || '1.0.0',
          published_at: s.published_at || 0,
          ...(typeof s.updated_at === 'number' ? { updated_at: s.updated_at } : {}),
          bundle_url: s.bundle_url || '',
          create_uid: s.create_uid || '',
          ...((s.status || s.state) ? { status: s.status || s.state } : {}),
          default_install: true,
          ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        });
        seededSkills++;
        installedSkills.add(s.id);
      } catch (err) {
        log.warn(`skip default skill ${s.id}; seed failed: ${(err as Error).message}`);
      }
    }
    // Marker is written LAST so any crash above leaves a partially-seeded manifest + stale/no
    // marker → next launch retries the whole loop, and add*Install upserts rows already there.
    // Failure here (rare disk issue) likewise → retry next launch.
    if (!canContinue()) return { seeded_agents: seededAgents, seeded_skills: seededSkills };
    await fsp.mkdir(userMarketplaceDirCloud(uid), { recursive: true });
    await fsp.writeFile(markerFile, JSON.stringify({
      seeded_at: Date.now(),
      checked_at: Date.now(),
      version: 1,
      agent_ids: (data.agents || [])
        .filter((a) => _isMarketplaceAppCompatible(_normalizeMarketplaceMinAppVersion(a)))
        .map((a) => a.id),
      skill_ids: (data.skills || [])
        .filter((s) => _isMarketplaceAppCompatible(_normalizeMarketplaceMinAppVersion(s)))
        .map((s) => s.id),
    }, null, 2), 'utf8');
    log.info(`seeded default installs: ${seededAgents} agent(s) + ${seededSkills} skill(s)`);
    return { seeded_agents: seededAgents, seeded_skills: seededSkills };
  } catch (err) {
    // Stale/no marker → next launch retries. Manifest may be partially populated; that's fine
    // because `reconcileInstalls` will pick up rows that are there and the next ensure pass
    // will finish the rest.
    if (!canContinue()) return { seeded_agents: 0, seeded_skills: 0 };
    const message = (err as Error).message;
    log.warn(`default installs incremental seed failed (will retry): ${message}`);
    return { seeded_agents: 0, seeded_skills: 0, failed: true, error: message };
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
  return withMarketplaceInstallLock(uid, 'agent', agentId, async () => {
    await fsp.rm(userMarketplaceAgentDir(uid, agentId), { recursive: true, force: true });
    await withMarketplaceCacheLock(uid, 'agent', agentId, async () => {
      await fsp.rm(marketplaceCacheAgentDir(uid, agentId), { recursive: true, force: true });
    });
    await removeAgentInstall(uid, agentId);
    log.info(`uninstalled marketplace agent ${agentId} (local + cache + manifest)`);
    return { ok: true, id: agentId };
  });
}

export async function uninstallMarketplaceSkill(skillId: string): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  const uid = getActiveUserId();
  return withMarketplaceInstallLock(uid, 'skill', skillId, async () => {
    await fsp.rm(userMarketplaceSkillDir(uid, skillId), { recursive: true, force: true });
    await withMarketplaceCacheLock(uid, 'skill', skillId, async () => {
      await fsp.rm(marketplaceCacheSkillDir(uid, skillId), { recursive: true, force: true });
    });
    await removeSkillInstall(uid, skillId);
    invalidateCoreAgentSkills();
    log.info(`uninstalled marketplace skill ${skillId} (local + cache + manifest)`);
    return { ok: true, id: skillId };
  });
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
