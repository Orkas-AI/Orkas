/**
 * Builtin marketplace seed.
 *
 * `resources/builtin/marketplace/` is a packaged fallback for important
 * platform agents/skills. It is not a third source tier at runtime: this module
 * copies missing packaged content into the normal per-user marketplace install
 * tree, writes ordinary installs.json rows, and lets marketplace reconcile take
 * over once the server is reachable. In dev, a newer packaged builtin can also
 * overlay the same-id marketplace install while preserving install metadata; this
 * keeps git-managed builtin changes runnable before they are published upstream.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  packagedBuiltinMarketplaceAgentsDir,
  packagedBuiltinMarketplaceSkillsDir,
  userMarketplaceAgentDir,
  userMarketplaceAgentSkillsDir,
  userMarketplaceSkillDir,
} from '../paths';
import { createLogger } from '../logger';
import { safeId } from '../storage';
import { sha256OfFile } from '../util/sha256';
import {
  MARKETPLACE_RESOURCE_MANIFEST_NAME,
  MARKETPLACE_TREE_HASH_ALGORITHM,
  MARKETPLACE_TREE_HASH_SKIP_NAMES,
  marketplaceContentTreeFiles,
  marketplaceContentTreeHash,
  marketplaceContentTreeHashForFiles,
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

const log = createLogger('builtin-marketplace');
const BUILTIN_CREATE_UID = '0';
const ENABLE_BUILTIN_DEV_OVERLAY = false;

export interface BuiltinMarketplaceSeedOptions {
  shouldContinue?: () => boolean;
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

async function _copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..' || entry.name === '_install.json') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await _copyDir(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
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

function _agentNameFromJson(agentJson: Record<string, unknown>, fallback: string): string {
  const name = typeof agentJson.name === 'string' ? agentJson.name.trim() : '';
  return name || fallback;
}

function _agentInstallId(dirName: string, agentJson: Record<string, unknown>): string {
  const declared = typeof agentJson.agent_id === 'string' ? agentJson.agent_id.trim() : '';
  return declared === dirName && /^[0-9a-f]{12}$/.test(declared) ? declared : '';
}

function _versionTokens(value: unknown): Array<number | string> {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  return text
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function _compareVersions(a: unknown, b: unknown): number {
  const aa = _versionTokens(a);
  const bb = _versionTokens(b);
  if (!aa.length || !bb.length) return 0;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
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

function _builtinSkillVersion(srcDir: string): string {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return normalizeInstallVersion(meta?.version);
}

function _builtinSkillReseedIfDeletedBefore(srcDir: string): number {
  const meta = _readJsonObject(path.join(srcDir, '_meta.json'));
  return _timestampMs(meta?.reseed_if_deleted_before);
}

function _freshnessAt(row: { published_at?: number; updated_at?: number } | null | undefined): number {
  if (!row) return 0;
  return typeof row.updated_at === 'number' ? row.updated_at : (typeof row.published_at === 'number' ? row.published_at : 0);
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

type ResourceSeedManifest = {
  resource_hash: string;
  files: string[];
};

function _readResourceSeedManifest(
  target: string,
  kind: 'agent' | 'skill',
  id: string,
): ResourceSeedManifest | null {
  const manifest = _readJsonObject(path.join(target, MARKETPLACE_RESOURCE_MANIFEST_NAME));
  if (!manifest) return null;
  if (manifest.kind !== kind || manifest.id !== id) return null;
  if (manifest.hashAlgorithm && manifest.hashAlgorithm !== MARKETPLACE_TREE_HASH_ALGORITHM) return null;
  const resourceHash = typeof manifest.resource_hash === 'string' ? manifest.resource_hash.trim() : '';
  const files = _safeManagedFiles(manifest.files);
  return resourceHash && files.length ? { resource_hash: resourceHash, files } : null;
}

function _legacyLocaleContentTreeHashForFiles(root: string, files: Iterable<string>): string {
  const normalized = Array.from(new Set(Array.from(files)
    .map((rel) => _normalizeManagedRel(rel))
    .filter((rel): rel is string => !!rel)))
    .sort((a, b) => a.localeCompare(b));
  if (!normalized.length) return '';

  const h = crypto.createHash('sha256');
  h.update(`${MARKETPLACE_TREE_HASH_ALGORITHM}\0`);
  for (const rel of normalized) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(root, rel));
    } catch {
      return '';
    }
    h.update(rel.replace(/\\/g, '/'));
    h.update('\0');
    h.update(String(bytes.length));
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

function _resourceSeedLocallyModified(target: string, kind: 'agent' | 'skill', id: string): boolean {
  const manifest = _readResourceSeedManifest(target, kind, id);
  if (!manifest) return true;
  const currentHash = marketplaceContentTreeHashForFiles(target, manifest.files);
  if (
    currentHash !== manifest.resource_hash
    && _legacyLocaleContentTreeHashForFiles(target, manifest.files) !== manifest.resource_hash
  ) {
    return true;
  }

  const managed = new Set(manifest.files);
  return marketplaceContentTreeFiles(target).some((rel) => !managed.has(rel));
}

function _shouldTakeOverResourceSeedFromBuiltin(uid: string, kind: 'agent' | 'skill', id: string): boolean {
  if (!ENABLE_BUILTIN_DEV_OVERLAY) return false;
  const target = kind === 'agent' ? userMarketplaceAgentDir(uid, id) : userMarketplaceSkillDir(uid, id);
  const meta = _readInstallMetaObject(target);
  if (!_isLocalResourceSeedMeta(meta)) return false;
  if (_resourceSeedLocallyModified(target, kind, id)) {
    log.warn(`skip builtin ${kind} resource handoff ${id}: local install was modified`);
    return false;
  }
  return true;
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
  const localVersion = normalizeInstallVersion(meta.version || manifestRow?.version);
  const versionCmp = _compareVersions(packagedVersion, localVersion);
  if (versionCmp > 0) return true;
  if (versionCmp < 0) return false;

  const packagedFresh = _builtinAgentUpdatedAt(agentJson);
  const localFresh = _freshnessAt({
    published_at: typeof meta.published_at === 'number' ? meta.published_at : manifestRow?.published_at,
    updated_at: typeof meta.updated_at === 'number' ? meta.updated_at : manifestRow?.updated_at,
  });
  return packagedFresh > localFresh;
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

  const packagedTreeHash = marketplaceContentTreeHash(srcDir);
  if (!packagedTreeHash) return false;

  if (_builtinSkillLocallyModified(target, meta)) {
    log.warn(`skip builtin skill refresh ${installId}: local install was modified`);
    return false;
  }

  return meta.content_tree_hash !== packagedTreeHash;
}

function _shouldOverlayMarketplaceAgentFromBuiltin(
  uid: string,
  installId: string,
  agentJson: Record<string, unknown>,
  manifestRow: AgentInstall | null,
): boolean {
  if (!ENABLE_BUILTIN_DEV_OVERLAY || !manifestRow?.agent_json_url) return false;
  const target = userMarketplaceAgentDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  if (_isLocalResourceSeedMeta(meta)) return false;

  const packagedVersion = _builtinAgentVersion(agentJson);
  const localVersion = normalizeInstallVersion(meta.version || manifestRow.version);
  if (_compareVersions(packagedVersion, localVersion) <= 0) return false;

  if (_agentLocallyModified(target, meta)) {
    log.warn(`skip builtin agent overlay ${installId}: local install was modified`);
    return false;
  }
  return true;
}

function _shouldOverlayMarketplaceSkillFromBuiltin(
  uid: string,
  installId: string,
  srcDir: string,
  manifestRow: SkillInstall | null,
): boolean {
  if (!ENABLE_BUILTIN_DEV_OVERLAY || !manifestRow?.bundle_url) return false;
  const target = userMarketplaceSkillDir(uid, installId);
  const meta = _readInstallMetaObject(target) || {};
  if (_isLocalResourceSeedMeta(meta)) return false;

  const packagedVersion = _builtinSkillVersion(srcDir);
  const localVersion = normalizeInstallVersion(meta.version || manifestRow.version);
  if (_compareVersions(packagedVersion, localVersion) <= 0) return false;

  if (_builtinSkillLocallyModified(target, meta)) {
    log.warn(`skip builtin skill overlay ${installId}: local install was modified`);
    return false;
  }
  return true;
}

function _agentLocallyModified(target: string, meta: Record<string, unknown>): boolean {
  const agentJsonFile = path.join(target, 'agent.json');
  if (typeof meta.content_sha === 'string' && meta.content_sha) {
    const diskSha = sha256OfFile(agentJsonFile);
    if (diskSha && diskSha !== meta.content_sha) return true;
  }
  if (typeof meta.content_tree_hash === 'string' && meta.content_tree_hash) {
    const managedFiles = _safeManagedFiles(meta.builtin_files);
    const currentTreeHash = managedFiles.length
      ? marketplaceContentTreeHashForFiles(target, managedFiles)
      : marketplaceContentTreeHash(target);
    return !!currentTreeHash && currentTreeHash !== meta.content_tree_hash;
  }
  return false;
}

function _builtinSkillLocallyModified(target: string, meta: Record<string, unknown>): boolean {
  const skillMdFile = path.join(target, 'SKILL.md');
  if (typeof meta.content_sha === 'string' && meta.content_sha) {
    const diskSha = sha256OfFile(skillMdFile);
    if (diskSha && diskSha !== meta.content_sha) return true;
  }
  if (typeof meta.content_tree_hash === 'string' && meta.content_tree_hash) {
    const managedFiles = _safeManagedFiles(meta.builtin_files);
    const currentTreeHash = managedFiles.length
      ? marketplaceContentTreeHashForFiles(target, managedFiles)
      : marketplaceContentTreeHash(target);
    return !!currentTreeHash && currentTreeHash !== meta.content_tree_hash;
  }
  return false;
}

function _installMetaBase(
  installedAt: number,
  contentSha: string | null,
  opts: { version?: string; updated_at?: number } = {},
): Record<string, unknown> {
  return {
    version: normalizeInstallVersion(opts.version),
    published_at: 0,
    ...(typeof opts.updated_at === 'number' && opts.updated_at > 0 ? { updated_at: opts.updated_at } : {}),
    installed_at: installedAt,
    create_uid: BUILTIN_CREATE_UID,
    default_install: true,
    seed_source: 'builtin',
    ...(contentSha ? { content_sha: contentSha } : {}),
  };
}

function _agentSeedInstallRow(installId: string, agentJson: Record<string, unknown>, installedAt: number): AgentInstall {
  const updatedAt = _builtinAgentUpdatedAt(agentJson);
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
  };
}

function _skillSeedInstallRow(installId: string, installedAt: number, version = DEFAULT_MARKETPLACE_VERSION): SkillInstall {
  return {
    id: installId,
    version: normalizeInstallVersion(version),
    published_at: 0,
    bundle_url: '',
    installed_at: installedAt,
    create_uid: BUILTIN_CREATE_UID,
    default_install: true,
    seed_source: 'builtin',
  };
}

async function _writeAgentSeed(
  uid: string,
  installId: string,
  srcDir: string,
  agentJson: Record<string, unknown>,
  installedAt = Date.now(),
): Promise<void> {
  const target = userMarketplaceAgentDir(uid, installId);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(
    path.join(target, 'agent.json'),
    `${JSON.stringify({ ...agentJson, agent_id: installId }, null, 2)}\n`,
    'utf8',
  );
  const srcSkills = path.join(srcDir, 'skills');
  try {
    if (fs.statSync(srcSkills).isDirectory()) {
      await _copyDir(srcSkills, userMarketplaceAgentSkillsDir(uid, installId));
    }
  } catch { /* agent has no bundled private skills */ }
  const contentSha = sha256OfFile(path.join(target, 'agent.json'));
  await fsp.writeFile(
    path.join(target, '_install.json'),
    `${JSON.stringify({
      ..._installMetaBase(installedAt, contentSha || null, {
        version: _builtinAgentVersion(agentJson),
        updated_at: _builtinAgentUpdatedAt(agentJson),
      }),
      agent_json_url: '',
      agent_skills_bundle_url: '',
    }, null, 2)}\n`,
    'utf8',
  );
  await _removeResourceSeedManifest(target);
}

async function _writeAgentMarketplaceOverlay(
  uid: string,
  installId: string,
  srcDir: string,
  agentJson: Record<string, unknown>,
  manifestRow: AgentInstall,
): Promise<void> {
  const target = userMarketplaceAgentDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _safeManagedFiles(existing.builtin_files);
  const files = marketplaceContentTreeFiles(srcDir);
  await fsp.mkdir(target, { recursive: true });
  await _removeStaleManagedFiles(target, previousFiles, files);
  await _copyManagedFiles(srcDir, target, files);
  await fsp.writeFile(
    path.join(target, 'agent.json'),
    `${JSON.stringify({ ...agentJson, agent_id: installId }, null, 2)}\n`,
    'utf8',
  );

  const contentSha = sha256OfFile(path.join(target, 'agent.json'));
  const contentTreeHash = marketplaceContentTreeHash(srcDir);
  await fsp.writeFile(
    path.join(target, '_install.json'),
    `${JSON.stringify({
      ...existing,
      version: _builtinAgentVersion(agentJson),
      published_at: typeof existing.published_at === 'number' ? existing.published_at : manifestRow.published_at,
      ...(typeof existing.updated_at === 'number'
        ? { updated_at: existing.updated_at }
        : (typeof manifestRow.updated_at === 'number' ? { updated_at: manifestRow.updated_at } : {})),
      installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : manifestRow.installed_at,
      create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : (manifestRow.create_uid || BUILTIN_CREATE_UID),
      default_install: typeof existing.default_install === 'boolean'
        ? existing.default_install
        : manifestRow.default_install === true,
      seed_source: 'builtin',
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
  await _removeResourceSeedManifest(target);
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
): Promise<void> {
  const target = userMarketplaceSkillDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _safeManagedFiles(existing.builtin_files);
  const files = marketplaceContentTreeFiles(srcDir);
  await fsp.mkdir(target, { recursive: true });
  await _removeStaleManagedFiles(target, previousFiles, files);
  await _copyManagedFiles(srcDir, target, files);
  const contentSha = sha256OfFile(path.join(target, 'SKILL.md'));
  const contentTreeHash = marketplaceContentTreeHash(srcDir);
  const version = _builtinSkillVersion(srcDir);
  await fsp.writeFile(
    path.join(target, '_install.json'),
    `${JSON.stringify({
      ..._installMetaBase(installedAt, contentSha || null, { version }),
      bundle_url: '',
      ...(contentTreeHash ? { content_tree_hash: contentTreeHash } : {}),
      builtin_files: files,
    }, null, 2)}\n`,
    'utf8',
  );
  await _removeResourceSeedManifest(target);
}

async function _writeSkillMarketplaceOverlay(
  uid: string,
  installId: string,
  srcDir: string,
  manifestRow: SkillInstall,
): Promise<void> {
  const target = userMarketplaceSkillDir(uid, installId);
  const existing = _readInstallMetaObject(target) || {};
  const previousFiles = _safeManagedFiles(existing.builtin_files);
  const files = marketplaceContentTreeFiles(srcDir);
  await fsp.mkdir(target, { recursive: true });
  await _removeStaleManagedFiles(target, previousFiles, files);
  await _copyManagedFiles(srcDir, target, files);
  const contentSha = sha256OfFile(path.join(target, 'SKILL.md'));
  const contentTreeHash = marketplaceContentTreeHash(srcDir);
  const version = _builtinSkillVersion(srcDir);
  await fsp.writeFile(
    path.join(target, '_install.json'),
    `${JSON.stringify({
      ...existing,
      version,
      published_at: typeof existing.published_at === 'number' ? existing.published_at : manifestRow.published_at,
      ...(typeof existing.updated_at === 'number'
        ? { updated_at: existing.updated_at }
        : (typeof manifestRow.updated_at === 'number' ? { updated_at: manifestRow.updated_at } : {})),
      installed_at: typeof existing.installed_at === 'number' ? existing.installed_at : manifestRow.installed_at,
      create_uid: typeof existing.create_uid === 'string' ? existing.create_uid : (manifestRow.create_uid || BUILTIN_CREATE_UID),
      default_install: typeof existing.default_install === 'boolean'
        ? existing.default_install
        : manifestRow.default_install === true,
      seed_source: 'builtin',
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
  await _removeResourceSeedManifest(target);
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
  const deletedAgents = new Set(Object.keys(manifest._deleted_at?.agents || {}));
  let manifestChanged = false;

  for (const entry of _safeDirEntries(packagedBuiltinMarketplaceAgentsDir())) {
    if (!_canContinue(opts)) return result;
    const srcDir = path.join(packagedBuiltinMarketplaceAgentsDir(), entry.name);
    const agentJson = _readJsonObject(path.join(srcDir, 'agent.json'));
    if (!agentJson) {
      log.warn(`skip builtin agent ${entry.name}: missing/invalid agent.json`);
      continue;
    }
    const installId = _agentInstallId(entry.name, agentJson);
    if (!installId) {
      log.warn(`skip builtin agent ${entry.name}: directory name must equal 12-hex agent_id`);
      continue;
    }
    if (deletedAgents.has(installId)) continue;
    const manifestAgentIndex = manifest.agents.findIndex((a) => a.id === installId);
    const manifestAgent = manifestAgentIndex >= 0 ? manifest.agents[manifestAgentIndex] : null;
    const targetAgentJson = path.join(userMarketplaceAgentDir(uid, installId), 'agent.json');
    if (!fs.existsSync(targetAgentJson)) {
      const installedAt = manifestAgent?.installed_at || Date.now();
      await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt);
      result.seeded_agents++;
    } else if (_shouldTakeOverResourceSeedFromBuiltin(uid, 'agent', installId)) {
      if (manifestAgent?.agent_json_url) {
        await _writeAgentMarketplaceOverlay(uid, installId, srcDir, agentJson, manifestAgent);
      } else {
        const installedAt = manifestAgent?.installed_at || Date.now();
        await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt);
        if (manifestAgentIndex >= 0) {
          manifest.agents[manifestAgentIndex] = _agentSeedInstallRow(installId, agentJson, installedAt);
          manifestChanged = true;
        }
      }
      result.seeded_agents++;
    } else if (_shouldRefreshBuiltinAgent(uid, installId, agentJson, manifestAgent)) {
      const installedAt = manifestAgent?.installed_at || Date.now();
      await _writeAgentSeed(uid, installId, srcDir, agentJson, installedAt);
      result.seeded_agents++;
      if (manifestAgentIndex >= 0) {
        manifest.agents[manifestAgentIndex] = _agentSeedInstallRow(installId, agentJson, installedAt);
        manifestChanged = true;
      }
    } else if (manifestAgent && _shouldOverlayMarketplaceAgentFromBuiltin(uid, installId, agentJson, manifestAgent)) {
      await _writeAgentMarketplaceOverlay(uid, installId, srcDir, agentJson, manifestAgent);
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
    const manifestSkillIndex = manifest.skills.findIndex((s) => s.id === installId);
    const manifestSkill = manifestSkillIndex >= 0 ? manifest.skills[manifestSkillIndex] : null;
    const targetSkillMd = path.join(userMarketplaceSkillDir(uid, installId), 'SKILL.md');
    if (!fs.existsSync(targetSkillMd)) {
      const installedAt = manifestSkill?.installed_at || Date.now();
      await _writeSkillSeed(uid, installId, srcDir, installedAt);
      result.seeded_skills++;
    } else if (_shouldTakeOverResourceSeedFromBuiltin(uid, 'skill', installId)) {
      if (manifestSkill?.bundle_url) {
        await _writeSkillMarketplaceOverlay(uid, installId, srcDir, manifestSkill);
      } else {
        const installedAt = manifestSkill?.installed_at || Date.now();
        await _writeSkillSeed(uid, installId, srcDir, installedAt);
        if (manifestSkillIndex >= 0) {
          manifest.skills[manifestSkillIndex] = _skillSeedInstallRow(installId, installedAt, packagedVersion);
          manifestChanged = true;
        }
      }
      result.seeded_skills++;
    } else if (_shouldRefreshBuiltinSkill(uid, installId, srcDir, manifestSkill)) {
      const installedAt = manifestSkill?.installed_at || Date.now();
      await _writeSkillSeed(uid, installId, srcDir, installedAt);
      result.seeded_skills++;
      if (manifestSkillIndex >= 0) {
        manifest.skills[manifestSkillIndex] = _skillSeedInstallRow(installId, installedAt, packagedVersion);
        manifestChanged = true;
      }
    } else if (manifestSkill && _shouldOverlayMarketplaceSkillFromBuiltin(uid, installId, srcDir, manifestSkill)) {
      await _writeSkillMarketplaceOverlay(uid, installId, srcDir, manifestSkill);
      result.seeded_skills++;
    }
    if (!installedSkills.has(installId)) {
      manifest.skills.push(_skillSeedInstallRow(installId, Date.now(), packagedVersion));
      installedSkills.add(installId);
      result.manifest_skills++;
    }
  }

  if (manifestChanged || result.manifest_agents || result.manifest_skills) {
    await writeInstalls(uid, manifest);
  }
  if (result.seeded_agents || result.seeded_skills) {
    _invalidateMarketplaceListings();
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
      result.resolved_skills++;
      changed = true;
    } catch (err) {
      result.failed.push(`skill:${row.id}`);
      log.warn(`resolve builtin skill ${row.id} failed: ${(err as Error).message}`);
    }
  }

  if (changed) {
    await writeInstalls(uid, manifest);
    _invalidateMarketplaceListings();
  }
  return result;
}

function _invalidateMarketplaceListings(): void {
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
    registry.invalidateSkills?.().catch?.(() => undefined);
  } catch { /* optional */ }
}
