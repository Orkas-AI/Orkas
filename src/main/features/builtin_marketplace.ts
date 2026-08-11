/**
 * Builtin marketplace seed.
 *
 * `resources/builtin/marketplace/` is a packaged fallback for important
 * platform agents/skills. It is not a third source tier at runtime: this module
 * copies missing packaged content into the normal per-user marketplace install
 * tree, writes ordinary installs.json rows, and lets marketplace reconcile take
 * over once the server is reachable. A newer packaged builtin can also overlay
 * the same-id marketplace install while preserving install metadata; this keeps
 * git-managed builtin changes runnable before they are published upstream.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  packagedBuiltinMarketplaceAgentsDir,
  packagedBuiltinMarketplaceSkillsDir,
  userMarketplaceAgentDir,
  userMarketplaceSkillDir,
} from '../paths';
import { createLogger } from '../logger';
import { safeId } from '../storage';
import { compareVersions, minAppVersionFrom } from '../util/app-version-compat';
import { logErrorSummary } from '../util/log-redact';
import { sha256OfFile } from '../util/sha256';
import { replaceDirectoryAtomically } from '../util/atomic-directory-replace';
import {
  MARKETPLACE_RESOURCE_MANIFEST_NAME,
  MARKETPLACE_TREE_HASH_SKIP_NAMES,
  marketplaceContentTreeFiles,
  marketplaceContentTreeHash,
} from '../util/marketplace-tree-hash';
import {
  DEFAULT_MARKETPLACE_VERSION,
  normalizeInstallVersion,
  readInstalls,
  writeInstalls,
  type AgentInstall,
  type SkillInstall,
} from './marketplace_installs';
import { postJson } from './marketplace';
import { migrateComponentEnabledId } from './component_enabled';

const log = createLogger('builtin-marketplace');
const BUILTIN_CREATE_UID = '0';

export interface BuiltinMarketplaceSeedOptions {
  shouldContinue?: () => boolean;
  /** Wrap only staged-directory activation, manifest-local cache commit, and rollback. */
  activationGuard?: <T>(activate: () => Promise<T>) => Promise<T>;
}

export interface BuiltinMarketplaceSeedResult {
  seeded_agents: number;
  seeded_skills: number;
  manifest_agents: number;
  manifest_skills: number;
}

export interface BuiltinMarketplaceResolveResult {
  resolved_agents: number;
  resolved_skills: number;
  migrated_agents: number;
  migrated_skills: number;
  failed: string[];
}

function _canContinue(opts?: BuiltinMarketplaceSeedOptions): boolean {
  return opts?.shouldContinue ? opts.shouldContinue() : true;
}

function _safeDirEntries(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && safeId(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function _readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function _readPackagedJsonObject(file: string): {
  value: Record<string, unknown> | null;
  error: string;
} {
  const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { value: null, error: `missing/unreadable ${file}: ${errorMessage(err)}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: `invalid JSON object root in ${file}` };
    }
    return { value: parsed as Record<string, unknown>, error: '' };
  } catch (err) {
    return { value: null, error: `invalid JSON in ${file}: ${errorMessage(err)}` };
  }
}

function _agentNameFromJson(agentJson: Record<string, unknown>, fallback: string): string {
  const name = typeof agentJson.name === 'string' ? agentJson.name.trim() : '';
  return name || fallback;
}

function _agentInstallId(dirName: string, agentJson: Record<string, unknown>): string {
  const declared = typeof agentJson.agent_id === 'string' ? agentJson.agent_id.trim() : '';
  return declared === dirName && /^[0-9a-f]{12}$/.test(declared) ? declared : '';
}

function _timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function _builtinAgentVersion(agentJson: Record<string, unknown>): string {
  return normalizeInstallVersion(agentJson.version);
}

function _builtinAgentUpdatedAt(agentJson: Record<string, unknown>): number {
  return _timestampMs(agentJson.updated_at);
}

function _builtinAgentMinAppVersion(agentJson: Record<string, unknown>): string {
  return minAppVersionFrom(agentJson);
}

function _builtinAgentReseedIfDeletedBefore(srcDir: string, agentJson: Record<string, unknown>): number {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return _timestampMs(meta?.reseed_if_deleted_before)
    || _timestampMs(agentJson.reseed_if_deleted_before);
}

function _builtinSkillVersion(srcDir: string): string {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return normalizeInstallVersion(meta?.version);
}

function _builtinSkillUpdatedAt(srcDir: string): number {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return _timestampMs(meta?.updated_at);
}

function _builtinSkillMinAppVersion(srcDir: string): string {
  return minAppVersionFrom(_readJsonObject(path.join(srcDir, '_meta.json')) || {});
}

function _builtinSkillReseedIfDeletedBefore(srcDir: string): number {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return _timestampMs(meta?.reseed_if_deleted_before);
}

function _emptyUrl(value: unknown): boolean {
  return !(typeof value === 'string' && value.trim());
}

function _isLegacyBuiltinSeedMeta(meta: Record<string, unknown> | null, urlKey: 'agent_json_url' | 'bundle_url'): boolean {
  if (!meta || !_emptyUrl(meta[urlKey])) return false;
  return meta.seed_source === 'builtin'
    || meta.create_uid === BUILTIN_CREATE_UID
    || meta.published_at === 0;
}

function _isBuiltinSeedAgentRow(row: AgentInstall | null | undefined): row is AgentInstall {
  return !!row && _emptyUrl(row.agent_json_url) && (
    row.seed_source === 'builtin'
    || row.create_uid === BUILTIN_CREATE_UID
    || row.published_at === 0
  );
}

function _readInstallMetaObject(dir: string): Record<string, unknown> | null {
  return _readJsonObject(path.join(dir, '_install.json'));
}

function _rawVersion(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function _localInstallVersion(
  meta: Record<string, unknown> | null,
  manifestRow: { version?: string; updated_at?: number } | null | undefined,
): { missing: boolean; version: string } {
  const metaVersion = _rawVersion(meta?.version);
  if (meta && !metaVersion) return { missing: true, version: '' };
  const rowVersion = _rawVersion(manifestRow?.version);
  const version = metaVersion || rowVersion;
  return version
    ? { missing: false, version }
    : { missing: true, version: '' };
}

function _shouldSyncBuiltinInstall(
  packagedVersion: string,
  meta: Record<string, unknown> | null,
  manifestRow: { version?: string; published_at?: number; updated_at?: number } | null | undefined,
): boolean {
  const local = _localInstallVersion(meta, manifestRow);
  if (local.missing) return true;
  return compareVersions(packagedVersion, local.version) === 1;
}

function _isLocalBuiltinSeedMeta(meta: Record<string, unknown> | null): boolean {
  return _isLegacyBuiltinSeedMeta(meta, 'agent_json_url');
}

function _isBuiltinSeedSkillRow(row: SkillInstall | null | undefined): row is SkillInstall {
  return !!row && _emptyUrl(row.bundle_url) && (
    row.seed_source === 'builtin'
    || row.create_uid === BUILTIN_CREATE_UID
    || row.published_at === 0
  );
}

function _isLocalBuiltinSeedSkillMeta(meta: Record<string, unknown> | null): boolean {
  return _isLegacyBuiltinSeedMeta(meta, 'bundle_url');
}

function _isLocalResourceSeedMeta(meta: Record<string, unknown> | null): boolean {
  return !!meta && meta.seed_source === 'resource';
}

function _shouldTakeOverResourceSeedFromBuiltin(
  uid: string,
  kind: 'agent' | 'skill',
  id: string,
  packagedVersion: string,
  manifestRow: { version?: string; published_at?: number; updated_at?: number } | null,
): boolean {
  const target = kind === 'agent' ? userMarketplaceAgentDir(uid, id) : userMarketplaceSkillDir(uid, id);
  const meta = _readInstallMetaObject(target);
  if (!_isLocalResourceSeedMeta(meta)) return false;
  return _shouldSyncBuiltinInstall(packagedVersion, meta, manifestRow);
}

async function _removeResourceSeedManifest(target: string): Promise<void> {
  await fsp.rm(path.join(target, MARKETPLACE_RESOURCE_MANIFEST_NAME), { force: true });
}

function _deletedAt(map: Record<string, number> | undefined, id: string): number {
  const value = Number(map?.[id]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function _clearDeletedAt(
  manifest: { _deleted_at?: { agents?: Record<string, number>; skills?: Record<string, number> } },
  kind: 'agents' | 'skills',
  id: string,
): boolean {
  const bucket = manifest._deleted_at?.[kind];
  if (!bucket || !(id in bucket)) return false;
  delete bucket[id];
  if (Object.keys(bucket).length === 0) delete manifest._deleted_at?.[kind];
  if (manifest._deleted_at && Object.keys(manifest._deleted_at).length === 0) delete manifest._deleted_at;
  return true;
}

function _shouldBypassBuiltinSkillTombstone(srcDir: string, deletedAt: number): boolean {
  const cutoff = _builtinSkillReseedIfDeletedBefore(srcDir);
  return cutoff > 0 && deletedAt > 0 && deletedAt < cutoff;
}

function _shouldBypassBuiltinAgentTombstone(
  srcDir: string,
  agentJson: Record<string, unknown>,
  deletedAt: number,
): boolean {
  const cutoff = _builtinAgentReseedIfDeletedBefore(srcDir, agentJson);
  return cutoff > 0 && deletedAt > 0 && deletedAt < cutoff;
}

function _shouldRefreshBuiltinAgent(
  uid: string,
  installId: string,
  agentJson: Record<string, unknown>,
  manifestRow: AgentInstall | null,
): boolean {
  const target = userMarketplaceAgentDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  const canRefresh = _isBuiltinSeedAgentRow(manifestRow) || (!manifestRow && _isLocalBuiltinSeedMeta(meta));
  if (!canRefresh) return false;

  const packagedVersion = _builtinAgentVersion(agentJson);
  return _shouldSyncBuiltinInstall(packagedVersion, meta, manifestRow);
}

function _shouldRefreshBuiltinSkill(
  uid: string,
  installId: string,
  srcDir: string,
  manifestRow: SkillInstall | null,
): boolean {
  const target = userMarketplaceSkillDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  const canRefresh = _isBuiltinSeedSkillRow(manifestRow) || (!manifestRow && _isLocalBuiltinSeedSkillMeta(meta));
  if (!canRefresh) return false;

  const packagedVersion = _builtinSkillVersion(srcDir);
  return _shouldSyncBuiltinInstall(packagedVersion, meta, manifestRow);
}

function _shouldOverlayMarketplaceAgentFromBuiltin(
  uid: string,
  installId: string,
  agentJson: Record<string, unknown>,
  manifestRow: AgentInstall | null,
): boolean {
  if (!manifestRow?.agent_json_url) return false;
  const target = userMarketplaceAgentDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  if (_isLocalResourceSeedMeta(meta)) return false;

  const packagedVersion = _builtinAgentVersion(agentJson);
  return _shouldSyncBuiltinInstall(packagedVersion, meta, manifestRow);
}

function _shouldOverlayMarketplaceSkillFromBuiltin(
  uid: string,
  installId: string,
  srcDir: string,
  manifestRow: SkillInstall | null,
): boolean {
  if (!manifestRow?.bundle_url) return false;
  const target = userMarketplaceSkillDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  if (_isLocalResourceSeedMeta(meta)) return false;

  const packagedVersion = _builtinSkillVersion(srcDir);
  return _shouldSyncBuiltinInstall(packagedVersion, meta, manifestRow);
}

function _agentSeedInstallRow(installId: string, agentJson: Record<string, unknown>, installedAt: number): AgentInstall {
  const updatedAt = _builtinAgentUpdatedAt(agentJson);
  const minAppVersion = _builtinAgentMinAppVersion(agentJson);
  return {
    id: installId,
    version: _builtinAgentVersion(agentJson),
    published_at: 0,
    ...(updatedAt > 0 ? { updated_at: updatedAt } : {}),
    agent_json_url: '',
    agent_skills_bundle_url: '',
    installed_at: installedAt,
    create_uid: BUILTIN_CREATE_UID,
    default_install: true,
    seed_source: 'builtin',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

function _skillSeedInstallRow(
  installId: string,
  installedAt: number,
  version = DEFAULT_MARKETPLACE_VERSION,
  updatedAt = 0,
  minAppVersion = '',
): SkillInstall {
  return {
    id: installId,
    version: normalizeInstallVersion(version),
    published_at: 0,
    ...(updatedAt > 0 ? { updated_at: updatedAt } : {}),
    bundle_url: '',
    installed_at: installedAt,
    create_uid: BUILTIN_CREATE_UID,
    default_install: true,
    seed_source: 'builtin',
    ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
  };
}

async function _replaceBuiltinInstallDirectory(
  target: string,
  kind: 'agent' | 'skill',
  installId: string,
  opts: BuiltinMarketplaceSeedOptions,
  prepare: (staged: string) => Promise<void>,
): Promise<void> {
  await replaceDirectoryAtomically(target, async (staged) => {
    await _copyExistingDirectoryContents(target, staged);
    await prepare(staged);
  }, _invalidateMarketplaceListings, {
    activationGuard: opts.activationGuard,
    assertReady: () => {
      if (!_canContinue(opts)) throw new Error(`builtin ${kind} ${installId} publish context changed`);
    },
  });
}

async function _writeAgentSeed(
  uid: string,
  installId: string,
  srcDir: string,
  agentJson: Record<string, unknown>,
  installedAt = Date.now(),
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<void> {
  const target = userMarketplaceAgentDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _previousManagedFiles(target, existing, 'agent', installId);
  const files = marketplaceContentTreeFiles(srcDir);
  await _replaceBuiltinInstallDirectory(target, 'agent', installId, opts, async (staged) => {
    await _removeStaleManagedFiles(staged, previousFiles, files);
    await _copyManagedFiles(srcDir, staged, files);
    await fsp.writeFile(
      path.join(staged, 'agent.json'),
      `${JSON.stringify({ ...agentJson, agent_id: installId }, null, 2)}\n`,
      'utf8',
    );
    const contentSha = sha256OfFile(path.join(staged, 'agent.json'));
    const contentTreeHash = marketplaceContentTreeHash(srcDir);
    const updatedAt = _builtinAgentUpdatedAt(agentJson);
    const minAppVersion = _builtinAgentMinAppVersion(agentJson);
    await fsp.writeFile(
      path.join(staged, '_install.json'),
      `${JSON.stringify({
        ...existing,
        version: _builtinAgentVersion(agentJson),
        published_at: typeof existing.published_at === 'number' ? existing.published_at : 0,
        ...(updatedAt > 0
          ? { updated_at: updatedAt }
          : (typeof existing.updated_at === 'number' ? { updated_at: existing.updated_at } : {})),
        installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : installedAt,
        create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : BUILTIN_CREATE_UID,
        default_install: typeof existing.default_install === 'boolean' ? existing.default_install : true,
        seed_source: 'builtin',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        agent_json_url: typeof existing.agent_json_url === 'string' ? existing.agent_json_url : '',
        agent_skills_bundle_url: typeof existing.agent_skills_bundle_url === 'string' ? existing.agent_skills_bundle_url : '',
        ...(contentSha ? { content_sha: contentSha } : {}),
        ...(contentTreeHash ? { content_tree_hash: contentTreeHash } : {}),
        builtin_files: files,
      }, null, 2)}\n`,
      'utf8',
    );
    await _removeResourceSeedManifest(staged);
  });
}

async function _writeAgentMarketplaceOverlay(
  uid: string,
  installId: string,
  srcDir: string,
  agentJson: Record<string, unknown>,
  manifestRow: AgentInstall,
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<void> {
  const target = userMarketplaceAgentDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _previousManagedFiles(target, existing, 'agent', installId);
  const files = marketplaceContentTreeFiles(srcDir);
  await _replaceBuiltinInstallDirectory(target, 'agent', installId, opts, async (staged) => {
    await _removeStaleManagedFiles(staged, previousFiles, files);
    await _copyManagedFiles(srcDir, staged, files);
    await fsp.writeFile(
      path.join(staged, 'agent.json'),
      `${JSON.stringify({ ...agentJson, agent_id: installId }, null, 2)}\n`,
      'utf8',
    );

    const contentSha = sha256OfFile(path.join(staged, 'agent.json'));
    const contentTreeHash = marketplaceContentTreeHash(srcDir);
    const updatedAt = _builtinAgentUpdatedAt(agentJson);
    const minAppVersion = _builtinAgentMinAppVersion(agentJson);
    await fsp.writeFile(
      path.join(staged, '_install.json'),
      `${JSON.stringify({
        ...existing,
        version: _builtinAgentVersion(agentJson),
        published_at: typeof existing.published_at === 'number' ? existing.published_at : manifestRow.published_at,
        ...(updatedAt > 0
          ? { updated_at: updatedAt }
          : (typeof existing.updated_at === 'number'
            ? { updated_at: existing.updated_at }
            : (typeof manifestRow.updated_at === 'number' ? { updated_at: manifestRow.updated_at } : {}))),
        installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : manifestRow.installed_at,
        create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : (manifestRow.create_uid || BUILTIN_CREATE_UID),
        default_install: typeof existing.default_install === 'boolean'
          ? existing.default_install
          : manifestRow.default_install === true,
        seed_source: 'builtin',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        agent_json_url: typeof existing.agent_json_url === 'string' ? existing.agent_json_url : manifestRow.agent_json_url,
        agent_skills_bundle_url: typeof existing.agent_skills_bundle_url === 'string'
          ? existing.agent_skills_bundle_url
          : (manifestRow.agent_skills_bundle_url || ''),
        ...((existing.status || existing.state || manifestRow.status || manifestRow.state)
          ? { status: existing.status || existing.state || manifestRow.status || manifestRow.state }
          : {}),
        ...(contentSha ? { content_sha: contentSha } : {}),
        ...(contentTreeHash ? { content_tree_hash: contentTreeHash } : {}),
        builtin_files: files,
      }, null, 2)}\n`,
      'utf8',
    );
    await _removeResourceSeedManifest(staged);
  });
}

function _normalizeManagedRel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\\/g, '/').trim();
  if (!text || path.isAbsolute(text)) return null;
  const parts = text.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  if (parts.some((part) => MARKETPLACE_TREE_HASH_SKIP_NAMES.has(part) || part.startsWith('.'))) return null;
  return parts.join('/');
}

function _safeManagedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((rel) => _normalizeManagedRel(rel))
    .filter((rel): rel is string => !!rel)))
    .sort((a, b) => a.localeCompare(b));
}

function _resourceSeedManagedFiles(target: string, kind: 'agent' | 'skill', id: string): string[] {
  const manifest = _readJsonObject(path.join(target, MARKETPLACE_RESOURCE_MANIFEST_NAME));
  if (!manifest || manifest.kind !== kind || manifest.id !== id) return [];
  return _safeManagedFiles(manifest.files);
}

function _previousManagedFiles(
  target: string,
  existing: Record<string, unknown>,
  kind: 'agent' | 'skill',
  id: string,
): string[] {
  return Array.from(new Set([
    ..._safeManagedFiles(existing.builtin_files),
    ..._resourceSeedManagedFiles(target, kind, id),
  ])).sort((a, b) => a.localeCompare(b));
}

async function _copyExistingDirectoryContents(src: string, dst: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    await fsp.cp(path.join(src, entry.name), path.join(dst, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function _copyManagedFiles(src: string, dst: string, files: string[]): Promise<void> {
  for (const rel of files) {
    const safeRel = _normalizeManagedRel(rel);
    if (!safeRel) continue;
    const from = path.join(src, safeRel);
    const to = path.join(dst, safeRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }
}

async function _removeStaleManagedFiles(dst: string, previousFiles: string[], currentFiles: string[]): Promise<void> {
  const current = new Set(currentFiles);
  for (const rel of previousFiles) {
    if (current.has(rel)) continue;
    const safeRel = _normalizeManagedRel(rel);
    if (!safeRel) continue;
    const target = path.join(dst, safeRel);
    try {
      const stat = await fsp.lstat(target);
      if (stat.isFile() || stat.isSymbolicLink()) {
        await fsp.unlink(target);
        await _pruneEmptyParents(dst, path.dirname(target));
      }
    } catch {
      // Already gone or not a regular managed file.
    }
  }
}

async function _pruneEmptyParents(root: string, startDir: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let dir = path.resolve(startDir);
  while (dir !== resolvedRoot && dir.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

async function _writeSkillSeed(
  uid: string,
  installId: string,
  srcDir: string,
  installedAt = Date.now(),
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<void> {
  const target = userMarketplaceSkillDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _previousManagedFiles(target, existing, 'skill', installId);
  const files = marketplaceContentTreeFiles(srcDir);
  await _replaceBuiltinInstallDirectory(target, 'skill', installId, opts, async (staged) => {
    await _removeStaleManagedFiles(staged, previousFiles, files);
    await _copyManagedFiles(srcDir, staged, files);
    const contentSha = sha256OfFile(path.join(staged, 'SKILL.md'));
    const contentTreeHash = marketplaceContentTreeHash(srcDir);
    const version = _builtinSkillVersion(srcDir);
    const updatedAt = _builtinSkillUpdatedAt(srcDir);
    const minAppVersion = _builtinSkillMinAppVersion(srcDir);
    await fsp.writeFile(
      path.join(staged, '_install.json'),
      `${JSON.stringify({
        ...existing,
        version,
        published_at: typeof existing.published_at === 'number' ? existing.published_at : 0,
        ...(updatedAt > 0
          ? { updated_at: updatedAt }
          : (typeof existing.updated_at === 'number' ? { updated_at: existing.updated_at } : {})),
        installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : installedAt,
        create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : BUILTIN_CREATE_UID,
        default_install: typeof existing.default_install === 'boolean' ? existing.default_install : true,
        seed_source: 'builtin',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        bundle_url: typeof existing.bundle_url === 'string' ? existing.bundle_url : '',
        ...(contentSha ? { content_sha: contentSha } : {}),
        ...(contentTreeHash ? { content_tree_hash: contentTreeHash } : {}),
        builtin_files: files,
      }, null, 2)}\n`,
      'utf8',
    );
    await _removeResourceSeedManifest(staged);
  });
}

async function _writeSkillMarketplaceOverlay(
  uid: string,
  installId: string,
  srcDir: string,
  manifestRow: SkillInstall,
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<void> {
  const target = userMarketplaceSkillDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _previousManagedFiles(target, existing, 'skill', installId);
  const files = marketplaceContentTreeFiles(srcDir);
  await _replaceBuiltinInstallDirectory(target, 'skill', installId, opts, async (staged) => {
    await _removeStaleManagedFiles(staged, previousFiles, files);
    await _copyManagedFiles(srcDir, staged, files);
    const contentSha = sha256OfFile(path.join(staged, 'SKILL.md'));
    const contentTreeHash = marketplaceContentTreeHash(srcDir);
    const version = _builtinSkillVersion(srcDir);
    const updatedAt = _builtinSkillUpdatedAt(srcDir);
    const minAppVersion = _builtinSkillMinAppVersion(srcDir);
    await fsp.writeFile(
      path.join(staged, '_install.json'),
      `${JSON.stringify({
        ...existing,
        version,
        published_at: typeof existing.published_at === 'number' ? existing.published_at : manifestRow.published_at,
        ...(updatedAt > 0
          ? { updated_at: updatedAt }
          : (typeof existing.updated_at === 'number'
            ? { updated_at: existing.updated_at }
            : (typeof manifestRow.updated_at === 'number' ? { updated_at: manifestRow.updated_at } : {}))),
        installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : manifestRow.installed_at,
        create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : (manifestRow.create_uid || BUILTIN_CREATE_UID),
        default_install: typeof existing.default_install === 'boolean'
          ? existing.default_install
          : manifestRow.default_install === true,
        seed_source: 'builtin',
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        bundle_url: typeof existing.bundle_url === 'string' ? existing.bundle_url : manifestRow.bundle_url,
        ...((existing.status || existing.state || manifestRow.status || manifestRow.state)
          ? { status: existing.status || existing.state || manifestRow.status || manifestRow.state }
          : {}),
        ...(contentSha ? { content_sha: contentSha } : {}),
        ...(contentTreeHash ? { content_tree_hash: contentTreeHash } : {}),
        builtin_files: files,
      }, null, 2)}\n`,
      'utf8',
    );
    await _removeResourceSeedManifest(staged);
  });
}

export async function seedBuiltinMarketplaceForUser(
  uid: string,
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<BuiltinMarketplaceSeedResult> {
  const result: BuiltinMarketplaceSeedResult = {
    seeded_agents: 0,
    seeded_skills: 0,
    manifest_agents: 0,
    manifest_skills: 0,
  };
  if (!safeId(uid) || !_canContinue(opts)) return result;

  const manifest = await readInstalls(uid);
  const installedAgents = new Set(manifest.agents.map((a) => a.id));
  const installedSkills = new Set(manifest.skills.map((s) => s.id));
  let manifestChanged = false;

  for (const entry of _safeDirEntries(packagedBuiltinMarketplaceAgentsDir())) {
    if (!_canContinue(opts)) return result;
    const srcDir = path.join(packagedBuiltinMarketplaceAgentsDir(), entry.name);
    const packagedAgent = _readPackagedJsonObject(path.join(srcDir, 'agent.json'));
    const agentJson = packagedAgent.value;
    if (!agentJson) {
      log.warn(`skip builtin agent ${entry.name}: ${packagedAgent.error}`);
      continue;
    }
    const installId = _agentInstallId(entry.name, agentJson);
    if (!installId) {
      log.warn(`skip builtin agent ${entry.name}: directory name must equal 12-hex agent_id`);
      continue;
    }
    const agentDeletedAt = _deletedAt(manifest._deleted_at?.agents, installId);
    if (agentDeletedAt > 0) {
      if (!_shouldBypassBuiltinAgentTombstone(srcDir, agentJson, agentDeletedAt)) continue;
      if (_clearDeletedAt(manifest, 'agents', installId)) manifestChanged = true;
      log.info(`reseed builtin agent ${installId}: packaged content supersedes old uninstall tombstone`);
    }
    const manifestAgentIndex = manifest.agents.findIndex((a) => a.id === installId);
    const manifestAgent = manifestAgentIndex >= 0 ? manifest.agents[manifestAgentIndex] : null;
    const targetAgentJson = path.join(userMarketplaceAgentDir(uid, installId), 'agent.json');
    if (!fs.existsSync(targetAgentJson)) {
      const installedAt = manifestAgent?.installed_at || Date.now();
      await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt, opts);
      result.seeded_agents++;
    } else if (_shouldTakeOverResourceSeedFromBuiltin(
      uid,
      'agent',
      installId,
      _builtinAgentVersion(agentJson),
      manifestAgent,
    )) {
      if (manifestAgent?.agent_json_url) {
        await _writeAgentMarketplaceOverlay(uid, installId, srcDir, agentJson, manifestAgent, opts);
      } else {
        const installedAt = manifestAgent?.installed_at || Date.now();
        await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt, opts);
        if (manifestAgentIndex >= 0) {
          manifest.agents[manifestAgentIndex] = _agentSeedInstallRow(installId, agentJson, installedAt);
          manifestChanged = true;
        }
      }
      result.seeded_agents++;
    } else if (_shouldRefreshBuiltinAgent(uid, installId, agentJson, manifestAgent)) {
      const installedAt = manifestAgent?.installed_at || Date.now();
      await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt, opts);
      result.seeded_agents++;
      if (manifestAgentIndex >= 0) {
        manifest.agents[manifestAgentIndex] = _agentSeedInstallRow(installId, agentJson, installedAt);
        manifestChanged = true;
      }
    } else if (manifestAgent && _shouldOverlayMarketplaceAgentFromBuiltin(uid, installId, agentJson, manifestAgent)) {
      await _writeAgentMarketplaceOverlay(uid, installId, srcDir, agentJson, manifestAgent, opts);
      result.seeded_agents++;
    }
    if (!installedAgents.has(installId)) {
      manifest.agents.push(_agentSeedInstallRow(installId, agentJson, Date.now()));
      installedAgents.add(installId);
      result.manifest_agents++;
      manifestChanged = true;
    }
  }

  for (const entry of _safeDirEntries(packagedBuiltinMarketplaceSkillsDir())) {
    if (!_canContinue(opts)) return result;
    const srcDir = path.join(packagedBuiltinMarketplaceSkillsDir(), entry.name);
    if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
      log.warn(`skip builtin skill ${entry.name}: missing SKILL.md`);
      continue;
    }
    const installId = entry.name;
    const skillDeletedAt = _deletedAt(manifest._deleted_at?.skills, installId);
    if (skillDeletedAt > 0) {
      if (!_shouldBypassBuiltinSkillTombstone(srcDir, skillDeletedAt)) continue;
      if (_clearDeletedAt(manifest, 'skills', installId)) manifestChanged = true;
      log.info(`reseed builtin skill ${installId}: packaged content supersedes old uninstall tombstone`);
    }
    const packagedVersion = _builtinSkillVersion(srcDir);
    const packagedUpdatedAt = _builtinSkillUpdatedAt(srcDir);
    const packagedMinAppVersion = _builtinSkillMinAppVersion(srcDir);
    const manifestSkillIndex = manifest.skills.findIndex((s) => s.id === installId);
    const manifestSkill = manifestSkillIndex >= 0 ? manifest.skills[manifestSkillIndex] : null;
    const targetSkillMd = path.join(userMarketplaceSkillDir(uid, installId), 'SKILL.md');
    if (!fs.existsSync(targetSkillMd)) {
      const installedAt = manifestSkill?.installed_at || Date.now();
      await _writeSkillSeed(uid, installId, srcDir, installedAt, opts);
      result.seeded_skills++;
    } else if (_shouldTakeOverResourceSeedFromBuiltin(
      uid,
      'skill',
      installId,
      packagedVersion,
      manifestSkill,
    )) {
      if (manifestSkill?.bundle_url) {
        await _writeSkillMarketplaceOverlay(uid, installId, srcDir, manifestSkill, opts);
      } else {
        const installedAt = manifestSkill?.installed_at || Date.now();
        await _writeSkillSeed(uid, installId, srcDir, installedAt, opts);
        if (manifestSkillIndex >= 0) {
          manifest.skills[manifestSkillIndex] = _skillSeedInstallRow(
            installId,
            installedAt,
            packagedVersion,
            packagedUpdatedAt,
            packagedMinAppVersion,
          );
          manifestChanged = true;
        }
      }
      result.seeded_skills++;
    } else if (_shouldRefreshBuiltinSkill(uid, installId, srcDir, manifestSkill)) {
      const installedAt = manifestSkill?.installed_at || Date.now();
      await _writeSkillSeed(uid, installId, srcDir, installedAt, opts);
      result.seeded_skills++;
      if (manifestSkillIndex >= 0) {
        manifest.skills[manifestSkillIndex] = _skillSeedInstallRow(
          installId,
          installedAt,
          packagedVersion,
          packagedUpdatedAt,
          packagedMinAppVersion,
        );
        manifestChanged = true;
      }
    } else if (manifestSkill && _shouldOverlayMarketplaceSkillFromBuiltin(uid, installId, srcDir, manifestSkill)) {
      await _writeSkillMarketplaceOverlay(uid, installId, srcDir, manifestSkill, opts);
      result.seeded_skills++;
    }
    if (!installedSkills.has(installId)) {
      manifest.skills.push(_skillSeedInstallRow(
        installId,
        Date.now(),
        packagedVersion,
        packagedUpdatedAt,
        packagedMinAppVersion,
      ));
      installedSkills.add(installId);
      result.manifest_skills++;
    }
  }

  if (manifestChanged || result.manifest_agents || result.manifest_skills) {
    await writeInstalls(uid, manifest);
  }
  return result;
}

type CatalogRow = {
  id?: string;
  name?: string;
  version?: string;
  published_at?: number;
  updated_at?: number;
  create_uid?: string;
  default_install?: boolean | number;
  status?: string;
  state?: string;
};

function _isResolvedOfficialRow(row: CatalogRow | undefined, name?: string): row is Required<Pick<CatalogRow, 'id'>> & CatalogRow {
  if (!row || !row.id || !safeId(row.id)) return false;
  if ((row.create_uid || BUILTIN_CREATE_UID) !== BUILTIN_CREATE_UID) return false;
  if (!name) return true;
  return String(row.name || '').trim() === name.trim();
}

async function _findCatalogRow(kind: 'agents' | 'skills', id: string, name: string): Promise<CatalogRow | null> {
  if (safeId(id)) {
    const byId = await postJson<{ list?: CatalogRow[] }>(
      `/marketplace/${kind}/list`,
      { page: 1, size: 100, ids: [id] },
    );
    const hit = (byId.list || []).find((row) => _isResolvedOfficialRow(row));
    if (hit) return hit;
  }
  if (!name) return null;
  const byName = await postJson<{ list?: CatalogRow[] }>(
    `/marketplace/${kind}/list`,
    { page: 1, size: 100, q: name },
  );
  return (byName.list || []).find((row) => _isResolvedOfficialRow(row, name)) || null;
}

async function _resolveAgentInstall(uid: string, row: AgentInstall): Promise<AgentInstall | null> {
  const dir = userMarketplaceAgentDir(uid, row.id);
  const localJson = _readJsonObject(path.join(dir, 'agent.json')) || {};
  const localName = _agentNameFromJson(localJson, row.id);
  const declaredId = typeof localJson.agent_id === 'string' && safeId(localJson.agent_id)
    ? localJson.agent_id
    : row.id;
  const catalog = await _findCatalogRow('agents', declaredId, localName);
  if (!catalog?.id) return null;
  const detail = await postJson<{
    version?: string;
    published_at?: number;
    updated_at?: number;
    agent_json_url?: string;
    agent_skills_bundle_url?: string;
    create_uid?: string;
    default_install?: boolean;
    status?: string;
    state?: string;
  }>('/marketplace/agents/detail', { id: catalog.id });
  return {
    id: catalog.id,
    version: normalizeInstallVersion(detail.version || catalog.version),
    published_at: typeof detail.published_at === 'number'
      ? detail.published_at
      : (typeof catalog.published_at === 'number' ? catalog.published_at : 0),
    ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : (
      typeof catalog.updated_at === 'number' ? { updated_at: catalog.updated_at } : {}
    )),
    agent_json_url: detail.agent_json_url || '',
    agent_skills_bundle_url: detail.agent_skills_bundle_url || '',
    installed_at: row.installed_at || Date.now(),
    create_uid: detail.create_uid || catalog.create_uid || BUILTIN_CREATE_UID,
    default_install: detail.default_install === true || catalog.default_install === true || catalog.default_install === 1,
    ...((detail.status || detail.state || catalog.status || catalog.state)
      ? { status: detail.status || detail.state || catalog.status || catalog.state }
      : {}),
  };
}

async function _resolveSkillInstall(uid: string, row: SkillInstall): Promise<SkillInstall | null> {
  const catalog = await _findCatalogRow('skills', row.id, '');
  if (!catalog?.id) return null;
  const detail = await postJson<{
    bundle_url?: string;
    version?: string;
    published_at?: number;
    updated_at?: number;
    create_uid?: string;
    default_install?: boolean;
    status?: string;
    state?: string;
  }>('/marketplace/skills/bundle', { id: catalog.id });
  return {
    id: catalog.id,
    version: normalizeInstallVersion(detail.version || catalog.version),
    published_at: typeof detail.published_at === 'number'
      ? detail.published_at
      : (typeof catalog.published_at === 'number' ? catalog.published_at : 0),
    ...(typeof detail.updated_at === 'number' ? { updated_at: detail.updated_at } : (
      typeof catalog.updated_at === 'number' ? { updated_at: catalog.updated_at } : {}
    )),
    bundle_url: detail.bundle_url || '',
    installed_at: row.installed_at || Date.now(),
    create_uid: detail.create_uid || catalog.create_uid || BUILTIN_CREATE_UID,
    default_install: detail.default_install === true || catalog.default_install === true || catalog.default_install === 1,
    ...((detail.status || detail.state || catalog.status || catalog.state)
      ? { status: detail.status || detail.state || catalog.status || catalog.state }
      : {}),
  };
}

type MigrateDirResult = 'moved' | 'noop' | 'blocked';

async function _migrateDir(kind: 'agent' | 'skill', uid: string, fromId: string, toId: string): Promise<MigrateDirResult> {
  if (fromId === toId) return 'noop';
  const from = kind === 'agent' ? userMarketplaceAgentDir(uid, fromId) : userMarketplaceSkillDir(uid, fromId);
  const to = kind === 'agent' ? userMarketplaceAgentDir(uid, toId) : userMarketplaceSkillDir(uid, toId);
  if (!fs.existsSync(from)) return 'noop';
  if (fs.existsSync(to)) {
    log.warn(`skip builtin ${kind} id migration ${fromId} -> ${toId}: destination already exists`);
    return 'blocked';
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  if (kind === 'agent') await _rewriteAgentSeedId(to, toId);
  return 'moved';
}

async function _rewriteAgentSeedId(dir: string, id: string): Promise<void> {
  const file = path.join(dir, 'agent.json');
  const data = _readJsonObject(file);
  if (!data || data.agent_id === id) return;
  await fsp.writeFile(file, `${JSON.stringify({ ...data, agent_id: id }, null, 2)}\n`, 'utf8');
}

export async function resolveBuiltinMarketplaceInstalls(
  uid: string,
  opts: BuiltinMarketplaceSeedOptions = {},
): Promise<BuiltinMarketplaceResolveResult> {
  const result: BuiltinMarketplaceResolveResult = {
    resolved_agents: 0,
    resolved_skills: 0,
    migrated_agents: 0,
    migrated_skills: 0,
    failed: [],
  };
  if (!safeId(uid) || !_canContinue(opts)) return result;

  const manifest = await readInstalls(uid);
  let changed = false;
  const enabledIdMigrations: Array<{ kind: 'agent' | 'skill'; fromId: string; toId: string }> = [];
  for (const row of [...manifest.agents]) {
    if (!_canContinue(opts)) return result;
    if (row.seed_source !== 'builtin' || row.agent_json_url) continue;
    try {
      const resolved = await _resolveAgentInstall(uid, row);
      if (!resolved) continue;
      const migrated = await _migrateDir('agent', uid, row.id, resolved.id);
      if (migrated === 'blocked') {
        result.failed.push(`agent:${row.id}`);
        continue;
      }
      if (migrated === 'moved') result.migrated_agents++;
      manifest.agents = manifest.agents.filter((a) => a.id !== row.id && a.id !== resolved.id);
      manifest.agents.push(resolved);
      if (row.id !== resolved.id) enabledIdMigrations.push({ kind: 'agent', fromId: row.id, toId: resolved.id });
      result.resolved_agents++;
      changed = true;
    } catch (err) {
      result.failed.push(`agent:${row.id}`);
      log.warn(`resolve builtin agent ${row.id} failed: ${(err as Error).message}`);
    }
  }
  for (const row of [...manifest.skills]) {
    if (!_canContinue(opts)) return result;
    if (row.seed_source !== 'builtin' || row.bundle_url) continue;
    try {
      const resolved = await _resolveSkillInstall(uid, row);
      if (!resolved) continue;
      const migrated = await _migrateDir('skill', uid, row.id, resolved.id);
      if (migrated === 'blocked') {
        result.failed.push(`skill:${row.id}`);
        continue;
      }
      if (migrated === 'moved') result.migrated_skills++;
      manifest.skills = manifest.skills.filter((s) => s.id !== row.id && s.id !== resolved.id);
      manifest.skills.push(resolved);
      if (row.id !== resolved.id) enabledIdMigrations.push({ kind: 'skill', fromId: row.id, toId: resolved.id });
      result.resolved_skills++;
      changed = true;
    } catch (err) {
      result.failed.push(`skill:${row.id}`);
      log.warn(`resolve builtin skill ${row.id} failed: ${(err as Error).message}`);
    }
  }

  if (changed) {
    await writeInstalls(uid, manifest);
    for (const migration of enabledIdMigrations) {
      try {
        migrateComponentEnabledId(uid, migration.kind, migration.fromId, migration.toId);
      } catch (err) {
        log.warn('builtin enabled-state migration failed', {
          kind: migration.kind,
          error: logErrorSummary(err),
        });
      }
    }
    await _invalidateMarketplaceListings();
  }
  return result;
}

async function _invalidateMarketplaceListings(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    (require('./agents') as { clearAgentListCache?: () => void }).clearAgentListCache?.();
  } catch { /* optional */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    (require('./skills') as { clearSkillListCache?: () => void }).clearSkillListCache?.();
  } catch { /* optional */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const registry = require('../model/core-agent/skill-registry') as { invalidateSkills?: () => Promise<void> };
    await registry.invalidateSkills?.();
  } catch (err) {
    log.warn(`builtin marketplace Skill index invalidation failed: ${(err as Error).message}`);
    throw err;
  }
}
