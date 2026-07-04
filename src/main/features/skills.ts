/**
 * Skills — listing, custom CRUD, inline edit chat.
 *
 * Four sections:
 *   1. Builtin skill sync (startup)
 *   2. Skill reading / listing (frontmatter, tree, file content)
 *   3. Custom skill CRUD (create/update/delete/write-file)
 *   4. Skill inline edit chat (per user × skill, prefix injection, file-block extraction)
 *
 * Two skill sources:
 *   marketplace — <uid>/local/marketplace/skills/<id>/
 *   custom      — <uid>/cloud/skills/<id>/
 *
 * core-agent integration: after any custom-skill mutation we call
 * `invalidateSkills()` from `model/core-agent/skill-registry` so the next
 * chat turn picks up the new / updated / removed skill.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  userSkillsDir, userSkillChatDir, userSessionFile, WS_ROOT, SRC_ROOT,
  userMarketplaceSkillsDir, userSystemSkillsDir, chatAttachmentDir,
} from '../paths';
import { evictSession } from '../model/core-agent/session-store';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { t, buildLanguageDirective, descriptionLang } from '../i18n';
import { buildAttachmentManifest } from './chat_attachments';
import { getLanguage } from './config';

// Custom skills live per-user at `<uid>/cloud/skills/`. Resolved lazily
// from the active uid.
function CUSTOM_SKILLS_DIR(): string {
  return userSkillsDir(getActiveUserId());
}

const log = createLogger('skills');
import { prompts } from '../prompts/loader';
import { buildRuntimeDatetimeBlock } from '../prompts/runtime_context';
import {
  nowIso, readJson, writeJson, writeJsonSync, writeTextAtomicSync,
  appendJsonlAtomic, invalidateLineCount, readJsonl,
} from '../storage';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { readDisabledSets, setSkillEnabled } from './component_enabled';
import { findOuterTagRanges } from '../util/markdown-prose-code';
import {
  validateSkillFile,
  validateSkillDir,
  ValidationReport as QualityReport,
} from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';
import {
  DEFAULT_MARKETPLACE_CATEGORY_CODE,
  normalizeMarketplaceCategoryCode,
} from './marketplace_biz';
import { normalizeInstallVersion } from './marketplace_installs';
import { NAME_DISPLAY_MAX_UNITS, nameDisplayWidth } from '../util/name-limit';

// Names hidden from the in-app skill source-tree view. Marketplace sidecars are tooling
// metadata, not authored content — surfacing them confuses users and looks like noise.
const SKILL_TREE_IGNORE: ReadonlySet<string> = new Set([
  '.DS_Store', '__pycache__', '.git', 'node_modules',
  '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.uv-cache',
  '.tox', '.nox', '.nyc_output', 'htmlcov',
  'dist', 'build', 'out', 'target', 'coverage',
  '.cache', '.parcel-cache', '.next', '.nuxt', '.turbo',
  '.npm', '.pnpm-store', '.yarn', '.vite', '.svelte-kit',
  'tmp', 'temp', '.tmp', 'logs', 'log',
  '_install.json', '_cache.json', '_resource_manifest.json', '_meta.json',
]);

function _isGeneratedSkillSidecarName(name: string): boolean {
  if (/\.(pyc|pyo|log|tmp|temp|tsbuildinfo)$/.test(name)) return true;
  if (name === '.coverage' || name === '.eslintcache') return true;
  if (name.includes('.bak-')) return true;
  return false;
}
// Starts with a letter, then letters/digits/_/-. Spaces are not allowed.
const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CATEGORY_LINE_RE = /(^|\n)category\s*:\s*(.*?)(?=\n|$)/;
// Block syntax: `<<<skill-file path=<rel> ... >>>`. Cross-skill writes (the
// old `skill=<id>` attribute) are no longer supported — every skill is
// self-contained. Attribute order is flexible. File deletion is NOT done
// through this block — use the `delete_file` tool (per-call UI confirm).
const SKILL_FILE_BLOCK_RE = /<<<skill-file((?:\s+\w+=\S+)+)\s*\n(.*?)\n>>>/gs;
const SKILL_REPLY_TAG = 'skill-reply';
const SKILL_EDIT_PROTOCOL_LEADERS = ['<<<skill-file', '<skill-meta', '<skill-as-package', '<skill'];

function _parseSkillFileAttrs(raw: string): { path?: string } {
  const out: { path?: string } = {};
  const re = /\s+(\w+)=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const [, k, v] = m;
    if (k === 'path') out[k] = v;
  }
  return out;
}

export type SkillSource = 'marketplace' | 'custom';
type SkillSourceInput = SkillSource | 'builtin';

export interface SkillListing {
  id: string;
  name: string;
  source: SkillSource;
  description_zh: string;
  description_en: string;
  /** Marketplace category code. Empty string when the SKILL.md frontmatter doesn't set one —
   *  UI treats that as "uncategorized". */
  category: string;
  /** **Computed at load time, not persisted.** Filled by `listSkills` from
   *  `features/component_enabled.ts`. Defaults to true unless the user has
   *  explicitly disabled the skill. */
  enabled: boolean;
  /** Marketplace install version for `source==='marketplace'`. Read from `_install.json` so the
   *  skills-tab card can render a `v1.0.0` chip. Undefined for custom skills. */
  version?: string;
  /** Marketplace install freshness read from `_install.json`. Renderer marketplace uses this
   *  to decide whether the server listing is newer than the local install. */
  marketplace_published_at?: number;
  marketplace_updated_at?: number;
  /** Server-side fresh-install seed flag mirrored from marketplace metadata. */
  default_install?: boolean;
  /** Dev-only publishing metadata mirrored from marketplace metadata. */
  is_open_source?: boolean;
  /** Marketplace review lifecycle status. Custom skills read it from SKILL.md, marketplace skills from `_install.json`. */
  status?: string;
  /** Owning agent's `agent_id` when the skill is agent-private (SKILL.md
   *  frontmatter `ownerAgent`). Set only on entries returned by
   *  `listAgentPrivateSkills`; `listSkills` filters these out entirely. */
  ownerAgent?: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  status?: string;
  source: 'custom';
  dir: string;
}

/** Like `CustomSkill` but `source` is open — used by edit-chat resolution
 *  which has to handle built-ins in dev mode. */
export interface SkillForEdit {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  status?: string;
  source: SkillSource;
  dir: string;
}

/** Migrate legacy single-`description` frontmatter into the bilingual pair.
 *  Mirrors the logic in core-agent's SkillLoader and main's normalizeAgent —
 *  CJK ideograph in legacy → `_zh`, otherwise → `_en`. Explicit fields win. */
function migrateDescriptionPair(meta: { description?: string; description_zh?: string; description_en?: string }):
  { description_zh: string; description_en: string } {
  const legacy = _normalizeDisplayDescription(meta.description || '');
  const zh = _normalizeDisplayDescription(meta.description_zh || '');
  const en = _normalizeDisplayDescription(meta.description_en || '');
  const hasChinese = /[一-鿿]/.test(legacy);
  return {
    description_zh: zh || (legacy && hasChinese ? legacy : ''),
    description_en: en || (legacy && !hasChinese ? legacy : ''),
  };
}

function _normalizeDisplayDescription(value: string): string {
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function _sidecarBilingualDescriptions(sidecar: SkillOrkasMeta): { description_zh: string; description_en: string } {
  const descriptions = sidecar.descriptions && typeof sidecar.descriptions === 'object'
    ? sidecar.descriptions
    : {};
  const zh = _normalizeDisplayDescription(descriptions.zh || sidecar.description_zh || '');
  const en = _normalizeDisplayDescription(descriptions.en || sidecar.description_en || '');
  return zh && en ? { description_zh: zh, description_en: en } : { description_zh: '', description_en: '' };
}

function _resolveSkillDescriptions(meta: SkillFrontmatter, sidecar: SkillOrkasMeta): { description_zh: string; description_en: string } {
  const pair = migrateDescriptionPair(meta as any);
  const sidecarPair = _sidecarBilingualDescriptions(sidecar);
  return {
    description_zh: _normalizeDisplayDescription(
      sidecarPair.description_zh || pair.description_zh || '',
    ),
    description_en: _normalizeDisplayDescription(
      sidecarPair.description_en || pair.description_en || '',
    ),
  };
}

function _resolveSkillCategory(meta: SkillFrontmatter, sidecar: SkillOrkasMeta): string {
  const fromSidecar = typeof sidecar.category === 'string' ? sidecar.category.trim() : '';
  if (fromSidecar) return normalizeMarketplaceCategoryCode(fromSidecar);
  const fromFrontmatter = typeof meta.category === 'string' ? meta.category.trim() : '';
  return fromFrontmatter ? normalizeMarketplaceCategoryCode(fromFrontmatter) : '';
}

function _resolveSkillStatus(meta: SkillFrontmatter, sidecar: SkillOrkasMeta): string {
  const status = typeof sidecar.status === 'string' ? sidecar.status : (
    typeof sidecar.state === 'string' ? sidecar.state : (
      typeof meta.status === 'string' ? meta.status : (
        typeof meta.state === 'string' ? meta.state : ''
      )
    )
  );
  return status.trim();
}

function _skillSidecarPatchFromFrontmatter(meta: SkillFrontmatter): SkillOrkasMeta {
  const patch: SkillOrkasMeta = {};
  const desc: { zh?: string; en?: string } = {};
  if (typeof meta.description_zh === 'string' && meta.description_zh.trim()) desc.zh = meta.description_zh;
  if (typeof meta.description_en === 'string' && meta.description_en.trim()) desc.en = meta.description_en;
  if (desc.zh && desc.en) patch.descriptions = desc;
  if (typeof meta.category === 'string' && meta.category.trim()) patch.category = meta.category;
  if (typeof meta.status === 'string' && meta.status.trim()) patch.status = meta.status;
  else if (typeof meta.state === 'string' && meta.state.trim()) patch.status = meta.state;
  return patch;
}

function _hasSkillSidecarPatch(patch: SkillOrkasMeta): boolean {
  return !!(
    patch.category
    || patch.status
    || patch.state
    || (patch.descriptions && Object.keys(patch.descriptions).length)
    || patch.description_zh
    || patch.description_en
    || patch.routing
  );
}

export interface SkillTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: SkillTreeNode[];
  ext?: string;
}

export interface SkillFileInfo { path: string; bytes: number }

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
  /** Marketplace category code. Model-authored SKILL.md writes must choose one of the known
   *  category codes; legacy/manual entries without one still list as "uncategorized". */
  category?: string;
  [key: string]: string | string[] | undefined;
}

export interface SkillChatMeta { session_id?: string; [k: string]: unknown }

export interface SkillOrkasMeta {
  category?: string;
  descriptions?: { zh?: string; en?: string; [lang: string]: string | undefined };
  description_zh?: string;
  description_en?: string;
  routing?: {
    negative_examples?: string[];
    applicable_domain?: string | string[];
    prerequisites?: string[];
    [key: string]: unknown;
  };
  status?: string;
  state?: string;
  [key: string]: unknown;
}

// `syncBuiltinSkills` / `hashTree` / `_isMarketplaceInstalled` removed — there is no longer a
// shipped-builtin tree (`PC/src/builtin/skills/` is gone). Marketplace installs land directly
// in `<uid>/local/marketplace/skills/<id>/` via `features/marketplace.ts::installMarketplaceSkill`
// and are reconciled across devices through the cloud-synced installs.json manifest. Source
// 'builtin' is a legacy enum name; on disk it now resolves to `userMarketplaceSkillsDir(uid)`.

// ═══════════════════════════════════════════════════════════════════════
// 2. Skill reading / listing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Minimal YAML-subset parser for SKILL.md frontmatter. Only extracts
 * top-level scalar keys (name/description/allowed-tools/…); list blocks and
 * nested maps are skipped. Handles:
 *   - unquoted scalars: `name: agent-browser`
 *   - double-quoted with C-style escapes: `description: "foo \"bar\""`
 *   - single-quoted with '' escape: `description: 'it''s fine'`
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const meta: SkillFrontmatter = {};
  if (!text.startsWith('---')) return meta;
  const end = text.indexOf('---', 3);
  if (end === -1) return meta;
  const lines = text.slice(3, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (/^\s/.test(line) || line.trim().startsWith('-')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (!raw) continue;
    meta[key] = _parseFrontmatterScalar(raw);
  }
  return meta;
}

function _parseFrontmatterScalar(raw: string): string {
  if (raw[0] === '"') {
    const end = _findQuoteEnd(raw, 1, '"');
    return end < 0 ? raw : _unescapeDoubleQuoted(raw.slice(1, end));
  }
  if (raw[0] === "'") {
    const end = _findQuoteEnd(raw, 1, "'");
    return end < 0 ? raw : raw.slice(1, end).replace(/''/g, "'");
  }
  return raw;
}

function _findQuoteEnd(s: string, from: number, quote: string): number {
  if (quote === '"') {
    for (let i = from; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '"') return i;
    }
    return -1;
  }
  for (let i = from; i < s.length; i++) {
    if (s[i] === "'" && s[i + 1] === "'") { i++; continue; }
    if (s[i] === "'") return i;
  }
  return -1;
}

function _unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return ch;
    }
  });
}

function normalizeSkillSource(source: SkillSourceInput): SkillSource {
  return source === 'builtin' ? 'marketplace' : source;
}

function isMarketplaceSource(source: SkillSourceInput): boolean {
  return normalizeSkillSource(source) === 'marketplace';
}

function skillBaseDir(source: SkillSourceInput): string {
  return normalizeSkillSource(source) === 'custom' ? CUSTOM_SKILLS_DIR() : userMarketplaceSkillsDir(getActiveUserId());
}

function skillMdFile(dir: string): string {
  return path.join(dir, 'SKILL.md');
}

function skillMetaFile(dir: string): string {
  return path.join(dir, '_meta.json');
}

function hasSkillMd(dir: string): boolean {
  try { return fs.statSync(skillMdFile(dir)).isFile(); }
  catch { return false; }
}

function readSkillOrkasMetaSync(dir: string): SkillOrkasMeta {
  const file = skillMetaFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as SkillOrkasMeta : {};
  } catch {
    return {};
  }
}

function writeSkillOrkasMetaSync(dir: string, patch: SkillOrkasMeta): void {
  const current = readSkillOrkasMetaSync(dir);
  const next: SkillOrkasMeta = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, 'category')) {
    const raw = typeof patch.category === 'string' ? patch.category.trim() : '';
    if (raw) next.category = normalizeMarketplaceCategoryCode(raw);
    else delete next.category;
  }
  if (patch.descriptions && typeof patch.descriptions === 'object') {
    const descriptions = { ...(next.descriptions || {}) };
    for (const [lang, value] of Object.entries(patch.descriptions)) {
      const clean = typeof value === 'string' ? _normalizeDisplayDescription(value) : '';
      if (clean) descriptions[lang] = clean;
      else delete descriptions[lang];
    }
    if (Object.keys(descriptions).length) next.descriptions = descriptions;
    else delete next.descriptions;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description_zh')) {
    const clean = _normalizeDisplayDescription(String(patch.description_zh || ''));
    if (clean) next.description_zh = clean;
    else delete next.description_zh;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description_en')) {
    const clean = _normalizeDisplayDescription(String(patch.description_en || ''));
    if (clean) next.description_en = clean;
    else delete next.description_en;
  }
  if (patch.routing && typeof patch.routing === 'object') {
    next.routing = { ...(next.routing || {}), ...patch.routing };
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const clean = typeof patch.status === 'string' ? patch.status.trim() : '';
    if (clean) next.status = clean;
    else delete next.status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
    const clean = typeof patch.state === 'string' ? patch.state.trim() : '';
    if (clean) next.state = clean;
    else delete next.state;
  }
  writeJsonSync(skillMetaFile(dir), next);
}

function _stripSkillSidecarDescriptions(meta: SkillOrkasMeta): SkillOrkasMeta {
  const next: SkillOrkasMeta = { ...meta };
  delete next.descriptions;
  delete next.description_zh;
  delete next.description_en;
  return next;
}

function writeSkillOrkasMetaFullSync(dir: string, meta: SkillOrkasMeta): void {
  writeJsonSync(skillMetaFile(dir), _stripSkillSidecarDescriptions(meta));
}

function markSkillImportDraftSync(dir: string, source: 'url' | 'dir'): void {
  const current = readSkillOrkasMetaSync(dir);
  writeJsonSync(skillMetaFile(dir), {
    ...current,
    _import: {
      draft: true,
      source,
      created_at: nowIso(),
    },
  });
}

function isMarkedImportDraftDirSync(dir: string): boolean {
  const marker = readSkillOrkasMetaSync(dir)._import;
  return !!marker
    && typeof marker === 'object'
    && !Array.isArray(marker)
    && (marker as Record<string, unknown>).draft === true;
}

function clearSkillImportDraftMarkerSync(skillId: string): void {
  const dir = customSkillDir(skillId);
  const current = readSkillOrkasMetaSync(dir);
  if (!current._import) return;
  const next = { ...current };
  delete next._import;
  writeJsonSync(skillMetaFile(dir), next);
}

function removeSkillSidecarDescriptionsSync(dir: string): void {
  const current = readSkillOrkasMetaSync(dir);
  if (!current.descriptions && !current.description_zh && !current.description_en) return;
  writeJsonSync(skillMetaFile(dir), _stripSkillSidecarDescriptions(current));
}

// Module-level cache for `listSkills`.
interface SkillListCache { stamp: string; data: SkillListing[] }
let _skillListCache: SkillListCache | null = null;

function _invalidateSkillListCache(opts: { markDirty?: boolean } = {}): void {
  _skillListCache = null;
  if (opts.markDirty === false) return;
  // Sync engine dirty signal (lazy-require — stripped in the open-source build). Mirrors the pattern in
  // `agents.ts::_invalidateAgentListCache`: every cache-invalidate is also a disk-mutation
  // point, co-locating keeps wiring tight.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('skills', 'cloud/skills');
  } catch { /* features/sync stripped */ }
}

/** Internal cache invalidator + core-agent registry invalidator. Exported for
 *  the dev-only `skills_dev` module so its dual-write path goes through the
 *  same cache-busting chain as `writeCustomSkillFile`. */
export function invalidateSkillCachesForEdit(): void {
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
}

/** Drop only the renderer-facing list cache. Marketplace reconcile writes local marketplace
 *  installs, not cloud/custom skill files, so it should not mark the sync domain dirty. */
export function clearSkillListCache(): void {
  _invalidateSkillListCache({ markDirty: false });
}

/** A skill id resolves to a built-in iff there's a directory with that name
 *  under the runtime built-in tree. The src tree may be missing in packaged
 *  builds, so the runtime tree is the authoritative check. */
export function isBuiltinSkill(skillId: string): boolean {
  if (!skillId) return false;
  const d = path.join(userMarketplaceSkillsDir(getActiveUserId()), skillId);
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

/** Resolve a skill id for edit-chat use, regardless of source. Returns the
 *  same shape as `getCustomSkill` but with `source` reflecting where the dir
 *  was found. Platform/builtin is checked first to match runtime conflict
 *  precedence. */
export async function getSkillForEdit(skillId: string): Promise<SkillForEdit | null> {
  if (!skillId) return null;
  const sources: Array<[SkillSource, string]> = [
    ['marketplace', userMarketplaceSkillsDir(getActiveUserId())],
    ['custom', CUSTOM_SKILLS_DIR()],
  ];
  for (const [source, base] of sources) {
    const d = path.join(base, skillId);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    if (!hasSkillMd(d)) continue;
    let name = skillId;
    let descPair = { description_zh: '', description_en: '' };
    let category = '';
    let status = '';
    const md = skillMdFile(d);
    if (fs.existsSync(md)) {
      try {
        const { meta } = splitSkillMd(fs.readFileSync(md, 'utf8'));
        name = meta.name || skillId;
        const sidecar = readSkillOrkasMetaSync(d);
        descPair = _resolveSkillDescriptions(meta, sidecar);
        category = _resolveSkillCategory(meta, sidecar);
        status = _resolveSkillStatus(meta, sidecar);
      } catch { /* ignore */ }
    }
    return { id: skillId, name, ...descPair, category, ...(status ? { status } : {}), source, dir: d };
  }
  return null;
}

function _skillDirStamp(): string {
  let stamp = '';
  for (const d of [CUSTOM_SKILLS_DIR(), userMarketplaceSkillsDir(getActiveUserId())]) {
    try {
      const root = fs.statSync(d);
      stamp += `${d}:${root.mtimeMs};`;
      const children = fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const child of children) {
        const childDir = path.join(d, child);
        let childMtime = 0;
        try { childMtime = fs.statSync(childDir).mtimeMs; } catch { /* ignore */ }
        stamp += `${child}:${childMtime}:${hasSkillMd(childDir) ? 1 : 0};`;
      }
    }
    catch { stamp += `${d}:0;`; }
  }
  return stamp;
}

/** Full on-disk scan (custom + marketplace), INCLUDING agent-private
 *  (`ownerAgent`) skills, cached by per-dir mtime. The two public listers
 *  below filter this: `listSkills` drops owner-private entries (the user
 *  panel), `listAgentPrivateSkills` keeps only them (dev inspection). */
async function _allSkillListingsCached(): Promise<SkillListing[]> {
  const stamp = _skillDirStamp();
  let out: SkillListing[];
  if (_skillListCache && _skillListCache.stamp === stamp) {
    out = _skillListCache.data;
  } else {
    out = [];
    const seen = new Set<string>();
    // Platform/builtin first so product-owned skills win id conflicts.
    const sources: Array<[SkillSource, string]> = [['marketplace', userMarketplaceSkillsDir(getActiveUserId())], ['custom', CUSTOM_SKILLS_DIR()]];
    for (const [source, baseDir] of sources) {
      if (!fs.existsSync(baseDir)) continue;
      const names = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const name of names) {
        if (seen.has(name)) {
          if (normalizeSkillSource(source) === 'custom') {
            log.warn(`id conflict: marketplace and custom both define "${name}" — marketplace wins, rename one`);
          }
          continue;
        }
        const skillDir = path.join(baseDir, name);
        const skillMd = skillMdFile(skillDir);
        if (!hasSkillMd(skillDir)) continue;
        seen.add(name);
        let displayName = name;
        let descPair = { description_zh: '', description_en: '' };
        let category = '';
        let status: string | undefined;
        let version: string | undefined;
        let marketplacePublishedAt: number | undefined;
        let marketplaceUpdatedAt: number | undefined;
        let defaultInstall: boolean | undefined;
        let isOpenSource: boolean | undefined;
        let ownerAgent = '';
        if (fs.existsSync(skillMd)) {
          try {
            const meta = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf8'));
            const sidecar = readSkillOrkasMetaSync(skillDir);
            descPair = _resolveSkillDescriptions(meta, sidecar);
            displayName = meta.name as string || name;
            category = _resolveSkillCategory(meta, sidecar);
            status = _resolveSkillStatus(meta, sidecar) || undefined;
            ownerAgent = typeof meta.ownerAgent === 'string' ? meta.ownerAgent.trim() : '';
          } catch { /* ignore */ }
        }
        // Marketplace-installed skills carry `_install.json` with `version`. Author uid may also
        // be present for install/reconcile compatibility, but the global UI intentionally does
        // not surface it.
        if (isMarketplaceSource(source)) {
          try {
            const metaFile = path.join(baseDir, name, '_install.json');
            if (fs.existsSync(metaFile)) {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
              if (meta) version = normalizeInstallVersion(meta.version);
              if (meta && typeof meta.published_at === 'number') marketplacePublishedAt = meta.published_at;
              if (meta && typeof meta.updated_at === 'number') marketplaceUpdatedAt = meta.updated_at;
              if (meta && typeof meta.default_install === 'boolean') defaultInstall = meta.default_install;
              if (meta && typeof meta.is_open_source === 'boolean') isOpenSource = meta.is_open_source;
              if (meta && typeof meta.status === 'string') status = meta.status;
              else if (meta && typeof meta.state === 'string') status = meta.state;
            }
          } catch (err) {
            log.warn(`marketplace skill install metadata unreadable id=${name}: ${(err as Error).message}`);
          }
        }
        out.push({
          id: name, name: displayName, source: normalizeSkillSource(source), ...descPair,
          category, enabled: true, version,
          ...(typeof status === 'string' ? { status } : {}),
          ...(typeof marketplacePublishedAt === 'number' ? { marketplace_published_at: marketplacePublishedAt } : {}),
          ...(typeof marketplaceUpdatedAt === 'number' ? { marketplace_updated_at: marketplaceUpdatedAt } : {}),
          ...(typeof defaultInstall === 'boolean' ? { default_install: defaultInstall } : {}),
          ...(typeof isOpenSource === 'boolean' ? { is_open_source: isOpenSource } : {}),
          ...(ownerAgent ? { ownerAgent } : {}),
        });
      }
    }
    _skillListCache = { stamp, data: out };
  }
  return out;
}

/** Overlay per-user enabled overrides outside the cache (same pattern as
 *  listAgents). Cheap per-call read so a toggle takes effect immediately
 *  without having to bump dir mtime. */
function _overlaySkillEnabled(list: SkillListing[]): SkillListing[] {
  const { skills: disabledSkillIds } = readDisabledSets(getActiveUserId());
  return list.map((s) => ({ ...s, enabled: !disabledSkillIds.has(s.id) }));
}

/** User-facing skill list — custom + marketplace, EXCLUDING agent-private
 *  (`ownerAgent`) skills (those belong to one agent's internal pipeline and
 *  must not appear in the panel; see PC CLAUDE.md §Skills). */
export async function listSkills(): Promise<SkillListing[]> {
  return _overlaySkillEnabled((await _allSkillListingsCached()).filter((s) => !s.ownerAgent));
}

/** Dev-only: the agent-private (`ownerAgent`) skills hidden from `listSkills`.
 *  Surfaced behind a dev-gated IPC so the skill panel can show an inspection
 *  section in development; gated off in production. */
export async function listAgentPrivateSkills(): Promise<SkillListing[]> {
  return _overlaySkillEnabled((await _allSkillListingsCached()).filter((s) => !!s.ownerAgent));
}

/** Toggle the active user's enabled override for a skill. Triggers the
 *  same invalidation chain as a custom-skill mutation so the next runner
 *  build re-renders the skills system-prompt block. */
export function setSkillEnabledForActiveUser(skillId: string, enabled: boolean): void {
  setSkillEnabled(getActiveUserId(), skillId, enabled);
  _invalidateSkillListCache();
  invalidateCoreAgentSkills();
}

export type Result<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

export async function readSkillFile(
  source: SkillSourceInput, skillId: string, filepath = 'SKILL.md',
): Promise<Result<{ content: string; ext: string; path: string }>> {
  const base = skillBaseDir(source);
  const skillDir = path.resolve(base, skillId);
  const target = path.resolve(skillDir, filepath);
  if (target !== skillDir && !target.startsWith(skillDir + path.sep)) {
    return { ok: false, error: 'invalid path' };
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return { ok: false, error: 'file not found' };
  }
  try {
    const content = fs.readFileSync(target, 'utf8');
    const ext = path.extname(target).toLowerCase().replace(/^\./, '');
    return { ok: true, content, ext, path: filepath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function listSkillTree(
  source: SkillSourceInput, skillId: string,
): Promise<Result<{ tree: SkillTreeNode[] }>> {
  const base = skillBaseDir(source);
  const skillDir = path.resolve(base, skillId);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return { ok: false, error: 'skill not found' };
  }

  function walk(dir: string, rel = ''): SkillTreeNode[] {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
    } catch { return []; }

    const out: SkillTreeNode[] = [];
    for (const e of items) {
      if (SKILL_TREE_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      if (_isGeneratedSkillSidecarName(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ name: e.name, path: relPath, type: 'dir', children: walk(full, relPath) });
      } else if (e.isFile()) {
        out.push({
          name: e.name,
          path: relPath,
          type: 'file',
          ext: path.extname(e.name).toLowerCase().replace(/^\./, ''),
        });
      }
    }
    return out;
  }

  return { ok: true, tree: walk(skillDir) };
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Custom skill CRUD
// ═══════════════════════════════════════════════════════════════════════

export function validateSkillName(name: string): string {
  if (!name) return t('skills.errors.name_required');
  if (nameDisplayWidth(name) > NAME_DISPLAY_MAX_UNITS) return t('skills.errors.name_too_long');
  if (!SKILL_NAME_RE.test(name)) {
    return t('skills.errors.name_invalid');
  }
  return '';
}

// Skill-id shape check used by IPC handlers. Accepts EITHER a user-typed skill name
// (SKILL_NAME_RE — letter-led, no spaces) for custom skills, OR a 12-hex
// server-assigned id for marketplace-installed skills (which can begin with a digit).
// Without the hex branch, dev uploading a platform-installed skill whose id starts with a
// digit (e.g. `9720e1e263fd` Word/DOCX) bounced as "invalid skill id" — root cause of the
// "skill upload error" event seen in main log.
const SKILL_HEX_ID_RE = /^[a-f0-9]{12}$/;
export function isValidSkillId(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  return SKILL_HEX_ID_RE.test(id) || SKILL_NAME_RE.test(id);
}

function customSkillDir(skillId: string): string {
  return path.join(CUSTOM_SKILLS_DIR(), skillId);
}

export function skillMdContent(
  name: string,
  description: string | { zh?: string; en?: string },
  body = '',
  category = '',
  status = '',
): string {
  const cleanName = (name || '').replace(/\n/g, ' ').replace(/"/g, '\\"');
  const sanitize = (s: string) => _normalizeDisplayDescription(s).replace(/\n/g, ' ').replace(/"/g, '\\"');
  // SKILL.md stays host-generic: only `name` + a single dispatch
  // `description`. Orkas-only metadata (category / localized descriptions /
  // routing hints) lives in _meta.json next to the file.
  let desc = '';
  if (typeof description === 'string') {
    desc = description;
  } else if (description && typeof description === 'object') {
    const lang = descriptionLang(getLanguage());
    desc = lang === 'zh'
      ? (description.zh || description.en || '')
      : (description.en || description.zh || '');
  }
  const cleanDesc = sanitize(desc);
  const trimmedBody = body.replace(/^\n+/, '');
  void category;
  void status;
  return `---\nname: "${cleanName}"\ndescription: "${cleanDesc}"\n---\n\n${trimmedBody}`;
}

export function splitSkillMd(text: string): { meta: SkillFrontmatter; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('---', 3);
  if (end === -1) return { meta: {}, body: text };
  return {
    meta: parseSkillFrontmatter(text),
    body: text.slice(end + 3).replace(/^\n+/, ''),
  };
}

function ensureSkillMdCategoryForWrite(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end === -1) return content;
  const meta = parseSkillFrontmatter(content);
  const current = String(meta.category || '').trim();
  const repaired = current
    ? normalizeMarketplaceCategoryCode(current)
    : DEFAULT_MARKETPLACE_CATEGORY_CODE;
  if (current && repaired === current) {
    return content;
  }
  const line = `category: "${repaired}"`;
  let fm = content.slice(3, end);
  if (CATEGORY_LINE_RE.test(fm)) {
    fm = fm.replace(CATEGORY_LINE_RE, (m, prefix) => `${prefix}${line}`);
  } else {
    fm = `${fm}${fm.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  return `---${fm}${content.slice(end)}`;
}

function normalizeSkillMdForWrite(content: string, fallbackName = ''): string {
  if (!content.startsWith('---')) return content;
  const { meta, body } = splitSkillMd(content);
  const name = String(meta.name || fallbackName || '').trim();
  const descPair = migrateDescriptionPair(meta as any);
  return skillMdContent(name, { zh: descPair.description_zh, en: descPair.description_en }, body);
}

export async function getCustomSkill(skillId: string): Promise<CustomSkill | null> {
  const d = customSkillDir(skillId);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return null;
  if (!hasSkillMd(d)) return null;
  const md = skillMdFile(d);
  let name = skillId;
  let descPair = { description_zh: '', description_en: '' };
  let category = '';
  let status = '';
  if (fs.existsSync(md)) {
    try {
      const { meta } = splitSkillMd(fs.readFileSync(md, 'utf8'));
      name = meta.name || skillId;
      const sidecar = readSkillOrkasMetaSync(d);
      descPair = _resolveSkillDescriptions(meta, sidecar);
      category = _resolveSkillCategory(meta, sidecar);
      status = _resolveSkillStatus(meta, sidecar);
    } catch { /* ignore */ }
  }
  return { id: skillId, name, ...descPair, category, status, source: 'custom', dir: d };
}

export async function listCustomSkillFiles(skillId: string): Promise<SkillFileInfo[]> {
  return _listSkillFilesAt(customSkillDir(skillId));
}

/** Internal: walk a skill directory (custom or built-in) and return its file
 *  manifest. Same ignore-set as the dir-tree walker. */
async function _listSkillFilesAt(skillDir: string): Promise<SkillFileInfo[]> {
  const d = path.resolve(skillDir);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return [];
  const out: SkillFileInfo[] = [];

  function walk(dir: string, relBase = ''): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const parts = rel.split('/');
      if (parts.some((p) => p.startsWith('.') || SKILL_TREE_IGNORE.has(p))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({ path: rel, bytes: size });
      }
    }
  }
  walk(d);
  return out;
}

export async function createCustomSkill(
  name: string, description: string, category = '',
): Promise<CustomSkill | null> {
  const err = validateSkillName(name);
  if (err) throw new Error(err);
  const d = customSkillDir(name);
  if (fs.existsSync(d)) throw new Error(t('skills.errors.skill_exists', { name }));
  // Custom skills would silently shadow a same-named builtin in the
  // skill-registry first-wins resolution. Reject the create so the user
  // renames up front.
  if (fs.existsSync(path.join(userMarketplaceSkillsDir(getActiveUserId()), name))) {
    throw new Error(t('skills.errors.builtin_conflict', { name }));
  }
  fs.mkdirSync(d, { recursive: true });
  const skillMdPath = path.join(d, 'SKILL.md');
  writeTextAtomicSync(skillMdPath, skillMdContent(name, description, '', category, 'approved'));
  const metaPatch: SkillOrkasMeta = {
    ...(category && String(category).trim() ? { category } : {}),
    status: 'approved',
  };
  if (_hasSkillSidecarPatch(metaPatch)) writeSkillOrkasMetaSync(d, metaPatch);
  // Force-stamp mtime to "now" so the sync engine's tombstone resurrection
  // guard (`engine.ts` step 3 — `df.mtime_ms > tombMs`) treats this file as
  // unambiguously fresh. Without this, atomic rename can leave the final
  // mtime pinned to the .tmp creation moment (slightly older than the
  // current Date.now()), and if a recent in-UI delete left a tombstone with
  // deleted_at_ms close to now, the guard fails — the next sync pass
  // re-deletes the file. Documented occurrence: skill recreated right after
  // its delete-tombstone propagated to server (`evidence-deep-research`,
  // 2026-05-22 17:14 sync pass deleted_local=4).
  try { fs.utimesSync(skillMdPath, new Date(), new Date()); } catch { /* best effort */ }
  log.info(`created name=${name} category=${category || '(none)'}`);
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
  return getCustomSkill(name);
}

export async function updateCustomSkill(
  skillId: string,
  updates: {
    name?: string;
    description?: string;
    description_zh?: string;
    description_en?: string;
    category?: string;
  },
  options: { skipRename?: boolean } = {},
): Promise<CustomSkill | null> {
  let d = customSkillDir(skillId);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return null;
  let md = path.join(d, 'SKILL.md');
  let meta: SkillFrontmatter = {}; let body = '';
  if (fs.existsSync(md)) {
    try { ({ meta, body } = splitSkillMd(fs.readFileSync(md, 'utf8'))); }
    catch { /* ignore */ }
  }
  const newName = Object.prototype.hasOwnProperty.call(updates, 'name') ? (updates.name as string) : (meta.name || skillId);
  // Resolve descriptions: explicit localized updates win; a single
  // `description` update belongs to the current UI language; otherwise carry
  // over the persisted pair (re-parsed from frontmatter).
  const persisted = migrateDescriptionPair(meta as any);
  const explicitZh = Object.prototype.hasOwnProperty.call(updates, 'description_zh');
  const explicitEn = Object.prototype.hasOwnProperty.call(updates, 'description_en');
  const explicitLegacy = Object.prototype.hasOwnProperty.call(updates, 'description');
  let newZh = explicitZh ? String(updates.description_zh || '') : persisted.description_zh;
  let newEn = explicitEn ? String(updates.description_en || '') : persisted.description_en;
  if (explicitLegacy) {
    const legacy = String(updates.description || '').trim();
    const lang = descriptionLang(getLanguage());
    if (legacy && lang === 'zh' && !explicitZh) newZh = legacy;
    if (legacy && lang !== 'zh' && !explicitEn) newEn = legacy;
  }
  // category: explicit update wins, otherwise carry over persisted value.
  const newCategory = Object.prototype.hasOwnProperty.call(updates, 'category')
    ? String(updates.category || '')
    : ((meta.category as string) || '');

  let currentId = skillId;
  // `skipRename` is the in-progress-edit hook used by the skill detail name
  // editor: while the user is typing, write the new `name:` into SKILL.md
  // frontmatter but DO NOT rename the directory yet. The Done click fires a
  // second update with `skipRename: false` to commit the rename. Same write
  // path takes care of both passes — no separate IPC. Auto-heal on next
  // listSkills (`_renameSkillByFrontmatterIfNeeded`) is the safety net for
  // the edge case where the user crashes mid-edit before clicking Done.
  if (newName !== skillId && !options.skipRename) {
    const err = validateSkillName(newName);
    if (err) throw new Error(err);
    const target = customSkillDir(newName);
    if (fs.existsSync(target)) throw new Error(t('skills.errors.skill_exists', { name: newName }));
    if (fs.existsSync(path.join(userMarketplaceSkillsDir(getActiveUserId()), newName))) {
      throw new Error(t('skills.errors.builtin_conflict', { name: newName }));
    }
    fs.renameSync(d, target);
    d = target;
    md = path.join(d, 'SKILL.md');

    // Rename each user's per-skill edit chat dir and reset its session.
    // The chat.json session_id is bumped to the new id so future turns open
    // a fresh jsonl; the old session jsonl + cache entry are dropped here
    // so the next "create skill named OLDID" doesn't inherit its memory.
    if (fs.existsSync(WS_ROOT)) {
      for (const uidEntry of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
        if (!uidEntry.isDirectory()) continue;
        const uid = uidEntry.name;
        const oldChatDir = userSkillChatDir(uid, skillId);
        const newChatDir = userSkillChatDir(uid, newName);
        if (fs.existsSync(oldChatDir) && !fs.existsSync(newChatDir)) {
          try {
            fs.renameSync(oldChatDir, newChatDir);
            invalidateLineCount(path.join(oldChatDir, 'chat.jsonl'));
            invalidateLineCount(path.join(newChatDir, 'chat.jsonl'));
            const m = await loadSkillChatMeta(uid, newName);
            m.session_id = defaultSkillSessionId(newName);
            await saveSkillChatMeta(uid, newName, m);
          } catch (err) {
            log.warn(`rename user=${uid} ${oldChatDir} -> ${newChatDir} failed: ${(err as Error).message}`);
          }
        }
        const oldSid = defaultSkillSessionId(skillId);
        try { evictSession(oldSid); } catch { /* not in cache */ }
        const oldSessionJsonl = userSessionFile(uid, oldSid);
        try { fs.unlinkSync(oldSessionJsonl); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(`session unlink user=${uid} skill=${skillId} (rename): ${(err as Error).message}`);
          }
        }
      }
    }
    log.info(`renamed ${skillId} -> ${newName}`);
    currentId = newName;
  }

  writeTextAtomicSync(md, skillMdContent(newName, { zh: newZh, en: newEn }, body));
  writeSkillOrkasMetaSync(d, {
    ...(newCategory ? { category: newCategory } : { category: '' }),
    status: String(meta.status || meta.state || readSkillOrkasMetaSync(d).status || 'approved'),
  });
  removeSkillSidecarDescriptionsSync(d);
  clearSkillImportDraftMarkerSync(currentId);
  log.info(`updated name=${currentId} category=${newCategory || '(none)'}`);
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
  return getCustomSkill(currentId);
}

export async function deleteCustomSkill(skillId: string): Promise<boolean> {
  const d = customSkillDir(skillId);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return false;
  try { fs.rmSync(d, { recursive: true, force: true }); }
  catch (err) { log.warn(`rmtree failed for ${skillId}: ${(err as Error).message}`); return false; }

  // Drop each user's per-skill edit chat directory + the matching
  // core-agent session jsonl. Without the session purge, recreating a
  // skill with the same name would reload the deleted skill's transcript
  // and the LLM would appear to "remember" the previous attempt.
  if (fs.existsSync(WS_ROOT)) {
    for (const uidEntry of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
      if (!uidEntry.isDirectory()) continue;
      const uid = uidEntry.name;
      const chatDir = userSkillChatDir(uid, skillId);
      if (fs.existsSync(chatDir)) {
        try { fs.rmSync(chatDir, { recursive: true, force: true }); }
        catch (err) { log.warn(`rm failed user=${uid} skill=${skillId}: ${(err as Error).message}`); }
        invalidateLineCount(path.join(chatDir, 'chat.jsonl'));
      }
      const sessionId = defaultSkillSessionId(skillId);
      try { evictSession(sessionId); } catch { /* cache may not hold it */ }
      const sessionJsonl = userSessionFile(uid, sessionId);
      try { fs.unlinkSync(sessionJsonl); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`session unlink user=${uid} skill=${skillId}: ${(err as Error).message}`);
        }
      }
    }
  }

  log.info(`deleted id=${skillId}`);
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
  return true;
}

// ── Import-from-URL / Import-from-Dir ─────────────────────────────────────

const IMPORT_FILTER_NAMES: ReadonlySet<string> = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.DS_Store', 'Thumbs.db',
  '__pycache__', '.vscode', '.idea', '.pytest_cache',
  '.venv', 'venv', '.mypy_cache', '.ruff_cache', '.uv-cache',
  '.tox', '.nox', '.nyc_output', 'htmlcov',
  'dist', 'build', 'out', 'target', 'coverage',
  '.cache', '.parcel-cache', '.next', '.nuxt', '.turbo',
  '.npm', '.pnpm-store', '.yarn', '.vite', '.svelte-kit',
  'tmp', 'temp', '.tmp', 'logs', 'log',
  // Foreign skill-platform metadata (clawhub/etc. publish manifests with
  // ownerId/slug/version/publishedAt — irrelevant to this app and shows
  // up as "header noise" in the UI).
  // Orkas `_meta.json` is intentionally kept: source-backed imports should
  // restore an existing Orkas skill as faithfully as possible.
  // Marketplace sidecars: `_install.json` (version pin written by install / reconcile),
  // `_cache.json` (detail-page cache), and `_resource_manifest.json` (Resource dev-sync
  // ownership map). These are tooling internal — must never propagate when a user imports
  // a skill dir or when dev re-uploads a platform skill (see also marketplace_dev::SKIP_NAMES).
  '_install.json', '_cache.json', '_resource_manifest.json',
  // npm packaging artefacts — skill dirs are forbidden from carrying their
  // own node_modules or package.json (see core conventions); strip the
  // sidecars too so partial copies don't linger.
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

const IMPORT_MAX_FILES = 200;
const IMPORT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Paths that must never be selected as the source of a folder import.
 *  Check the *realpath* of the chosen dir against this list so symlinks
 *  can't dodge the guard. */
function _isBlacklistedImportSource(realDir: string): { blocked: true; reason: string } | { blocked: false } {
  const dir = realDir;

  // Orkas's own trees — pulling these in would recursion-bomb and/or leak
  // the source/data.
  for (const root of [SRC_ROOT, WS_ROOT]) {
    if (root && (dir === root || dir.startsWith(root + path.sep))) {
      return { blocked: true, reason: t('skills.import_block.self_dir') };
    }
  }

  // Home-dir root exactly — would trigger the import byte cap only after
  // hoovering plenty of sensitive files.
  const home = os.homedir();
  if (home && dir === home) return { blocked: true, reason: t('skills.import_block.home_root') };

  // Platform blacklists (absolute or prefix match).
  const mac = ['/System', '/private', '/etc', '/var', '/usr'];
  const macExcept = ['/usr/local', '/private/tmp'];
  const win = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];

  const hitsPrefix = (roots: string[]): boolean =>
    roots.some((r) => dir === r || dir.startsWith(r + path.sep));
  const hitsException = (roots: string[]): boolean =>
    roots.some((r) => dir === r || dir.startsWith(r + path.sep));

  if (process.platform === 'darwin' || process.platform === 'linux') {
    if (hitsPrefix(mac) && !hitsException(macExcept)) {
      return { blocked: true, reason: t('skills.import_block.system_dir') };
    }
  }
  if (process.platform === 'win32') {
    if (hitsPrefix(win)) return { blocked: true, reason: t('skills.import_block.system_dir') };
  }

  // User-sensitive subdirs (SSH / GPG / AWS creds).
  const sensitive = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
  ];
  if (hitsPrefix(sensitive)) return { blocked: true, reason: t('skills.import_block.credentials_dir') };

  return { blocked: false };
}

function _walkImportSource(root: string): {
  files: { src: string; rel: string; size: number }[];
  fileCount: number;
  totalBytes: number;
} {
  const files: { src: string; rel: string; size: number }[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  function walk(dir: string, relBase: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IMPORT_FILTER_NAMES.has(e.name)) continue;
      if (_isGeneratedSkillSidecarName(e.name)) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // skip symlinks defensively
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        fileCount += 1;
        totalBytes += size;
        // Count the whole import accurately, but keep the copy manifest bounded.
        // Once fileCount exceeds the cap, createFromDir rejects before copying.
        if (fileCount <= IMPORT_MAX_FILES) {
          files.push({ src: full, rel, size });
        }
      }
    }
  }
  walk(root, '');
  return { files, fileCount, totalBytes };
}

export interface ImportResult {
  ok: boolean;
  skill?: CustomSkill;
  skills?: CustomSkill[];
  seedModelText?: string;
  // Deprecated compatibility alias. Import flows should treat this as model
  // text, not as visible UI copy.
  seedMessage?: string | false;
  report?: QualityReport;
  skillId?: string;
  error?: string;
}

function _defaultSkillNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || 'imported-skill';
    const base = last.replace(/\.(md|txt|json|zip|tar|gz)$/i, '');
    const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    return safe && SKILL_NAME_RE.test(safe) ? safe : `imported-${Date.now().toString(36)}`;
  } catch {
    return `imported-${Date.now().toString(36)}`;
  }
}

function _defaultSkillNameFromDir(dir: string): string {
  const base = path.basename(dir);
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return safe && SKILL_NAME_RE.test(safe) ? safe : `imported-${Date.now().toString(36)}`;
}

function _isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'github.com' || host === 'www.github.com';
}

function _urlImportSourceType(rawUrl: string): 'raw_skill' | 'archive' | 'github_repo' | 'web' {
  let u: URL;
  try { u = new URL(rawUrl); }
  catch { return 'web'; }
  const pathname = u.pathname || '';
  const last = pathname.split('/').filter(Boolean).pop() || '';
  if (last.toUpperCase() === 'SKILL.MD') return 'raw_skill';
  if (/\.zip(?:$|[?#])/i.test(pathname)) return 'archive';
  if (_isGitHubHost(u.hostname) && pathname.split('/').filter(Boolean).length >= 2) return 'github_repo';
  return 'web';
}

function _skillNameFromSourceSkillMd(skillMdPath: string, fallbackDir: string): string {
  try {
    const meta = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8'));
    const declared = String(meta.name || '').trim();
    if (declared && SKILL_NAME_RE.test(declared)) return declared;
  } catch { /* fall back below */ }
  return _defaultSkillNameFromDir(fallbackDir);
}

function _dedupeImportName(baseName: string, reserved: Set<string>): string {
  let name = baseName;
  let i = 2;
  while (
    reserved.has(name)
    || fs.existsSync(customSkillDir(name))
    || fs.existsSync(path.join(userMarketplaceSkillsDir(getActiveUserId()), name))
  ) {
    const suffix = `-${i}`;
    const stem = baseName.slice(0, Math.max(1, NAME_DISPLAY_MAX_UNITS - suffix.length));
    name = `${stem}${suffix}`;
    i += 1;
  }
  reserved.add(name);
  return name;
}

function _findSourceSkillRoots(
  realSrc: string,
  files: { src: string; rel: string; size: number }[],
): string[] {
  const roots = files
    .filter((f) => path.basename(f.rel).toUpperCase() === 'SKILL.MD')
    .map((f) => path.dirname(f.src))
    .sort((a, b) => {
      const ar = path.relative(realSrc, a);
      const br = path.relative(realSrc, b);
      const ad = ar ? ar.split(path.sep).length : 0;
      const bd = br ? br.split(path.sep).length : 0;
      return ad - bd || ar.localeCompare(br);
    });
  const unique = [...new Set(roots)];
  return unique.filter((root) => !_isEmptyWrapperSourceSkillRoot(root, unique));
}

function _isEmptyWrapperSourceSkillRoot(root: string, allRoots: string[]): boolean {
  const resolvedRoot = path.resolve(root);
  const hasNestedSkillRoots = allRoots.some((other) => {
    const resolvedOther = path.resolve(other);
    return resolvedOther !== resolvedRoot && resolvedOther.startsWith(resolvedRoot + path.sep);
  });
  if (!hasNestedSkillRoots) return false;
  try {
    const body = splitSkillMd(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).body.trim();
    return body.length === 0;
  } catch {
    return false;
  }
}

function _filesForSourceSkillRoot(
  root: string,
  files: { src: string; rel: string; size: number }[],
  allRoots: string[],
): { src: string; rel: string; size: number }[] {
  const resolvedRoot = path.resolve(root);
  const nestedRoots = allRoots
    .map((r) => path.resolve(r))
    .filter((r) => r !== resolvedRoot && r.startsWith(resolvedRoot + path.sep));
  return files
    .filter((f) => {
      const resolved = path.resolve(f.src);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return false;
      for (const nested of nestedRoots) {
        if (resolved === nested || resolved.startsWith(nested + path.sep)) return false;
      }
      return true;
    })
    .map((f) => ({ ...f, rel: path.relative(resolvedRoot, f.src).replace(/\\/g, '/') }))
    .filter((f) => f.rel && !f.rel.startsWith('..') && f.rel !== '.');
}

function _copyImportedSkillFilesPreservingSource(skillDir: string, files: { src: string; rel: string; size: number }[]): void {
  for (const { src, rel } of files) {
    const dst = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (rel.toUpperCase() === 'SKILL.MD') {
      const raw = fs.readFileSync(src, 'utf8');
      writeTextAtomicSync(dst, normalizeSkillMdForWrite(raw, path.basename(skillDir)));
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function _copyImportedDraftFiles(skillDir: string, files: { src: string; rel: string; size: number }[]): void {
  for (const { src, rel } of files) {
    if (path.basename(rel).toLowerCase() === '_meta.json') continue;
    const dst = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (rel.toUpperCase() === 'SKILL.MD') {
      const raw = fs.readFileSync(src, 'utf8');
      writeTextAtomicSync(dst, normalizeSkillMdForWrite(raw, path.basename(skillDir)));
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function _dropSourceMetaFiles(files: { src: string; rel: string; size: number }[]): { src: string; rel: string; size: number }[] {
  return files.filter((f) => path.basename(f.rel).toLowerCase() !== '_meta.json');
}

function _sourceSkillImportDescription(sourceSkillMd: string, fallback: string): string {
  try {
    const meta = parseSkillFrontmatter(fs.readFileSync(sourceSkillMd, 'utf8'));
    const sidecar = readSkillOrkasMetaSync(path.dirname(sourceSkillMd));
    const desc = _resolveSkillDescriptions(meta, sidecar);
    const lang = descriptionLang(getLanguage());
    return lang === 'zh'
      ? (desc.description_zh || desc.description_en || fallback)
      : (desc.description_en || desc.description_zh || fallback);
  } catch {
    return fallback;
  }
}

function _sourceSkillInstallMeta(sourceRoot: string, sourceSkillMd: string): SkillOrkasMeta {
  let filePatch: SkillOrkasMeta = {};
  try {
    filePatch = _skillSidecarPatchFromFrontmatter(splitSkillMd(fs.readFileSync(sourceSkillMd, 'utf8')).meta);
  } catch { /* best effort */ }
  const sourceMeta = readSkillOrkasMetaSync(sourceRoot);
  const category = normalizeMarketplaceCategoryCode(
    typeof filePatch.category === 'string' ? filePatch.category : (
      typeof sourceMeta.category === 'string' ? sourceMeta.category : ''
    ),
    DEFAULT_MARKETPLACE_CATEGORY_CODE,
  );
  const status = String(filePatch.status || sourceMeta.status || sourceMeta.state || 'approved').trim() || 'approved';
  // Bootstrap only. The visible metadata-check chat rewrites _meta.json with
  // model-authored category/routing, so source bookkeeping or legacy fields
  // must not leak into the installed skill.
  return { category, status };
}

function _sourceSkillMetadataSeed(createdSkills: CustomSkill[]): string {
  const ids = createdSkills.map((skill) => skill.id).filter(Boolean).join(', ');
  return t('skills.import.seed_existing_meta', { skills: ids });
}

async function _markSourceSkillMetadataSession(firstSkillId: string, targetSkillIds: string[]): Promise<void> {
  if (!firstSkillId || targetSkillIds.length === 0) return;
  const uid = getActiveUserId();
  const current = await loadSkillChatMeta(uid, firstSkillId);
  await saveSkillChatMeta(uid, firstSkillId, {
    ...current,
    import_meta_targets: targetSkillIds,
    import_meta_created_at: nowIso(),
  });
}

async function _installSourceSkillRoots(
  name: string | null,
  description: string | null,
  realSrc: string,
  files: { src: string; rel: string; size: number }[],
  sourceRoots: string[],
  totalBytes: number,
  opts: { force?: boolean } = {},
): Promise<ImportResult> {
  const reserved = new Set<string>();
  const createdIds: string[] = [];
  const createdSkills: CustomSkill[] = [];
  const single = sourceRoots.length === 1;

  try {
    for (const sourceRoot of sourceRoots) {
      const sourceSkillMd = path.join(sourceRoot, 'SKILL.md');
      const baseName = single && (name || '').trim()
        ? (name || '').trim()
        : _skillNameFromSourceSkillMd(sourceSkillMd, sourceRoot);
      const effectiveName = _dedupeImportName(baseName, reserved);
      const effectiveDesc = single && (description || '').trim()
        ? (description || '').trim()
        : _sourceSkillImportDescription(sourceSkillMd, t('skills.import.default_desc_dir'));
      const created = await createCustomSkill(effectiveName, effectiveDesc);
      if (!created) throw new Error(t('skills.errors.create_failed'));
      createdIds.push(created.id);

      const skillDir = customSkillDir(created.id);
      const rootFiles = _dropSourceMetaFiles(_filesForSourceSkillRoot(sourceRoot, files, sourceRoots));
      fs.rmSync(skillMetaFile(skillDir), { force: true });
      _copyImportedSkillFilesPreservingSource(skillDir, rootFiles);
      writeSkillOrkasMetaFullSync(skillDir, _sourceSkillInstallMeta(sourceRoot, sourceSkillMd));

      const fresh = await getCustomSkill(created.id);
      if (fresh) createdSkills.push(fresh);
    }
  } catch (err) {
    log.warn('import-dir direct install failed', {
      source_type: 'skill_roots',
      created_count: createdIds.length,
      error_message: (err as Error).message,
    });
    for (const id of createdIds) {
      try { await deleteCustomSkill(id); } catch { /* best-effort rollback */ }
    }
    return { ok: false, error: t('skills.errors.copy_failed', { message: (err as Error).message }) };
  }

  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });

  let firstReport: QualityReport | undefined;
  let firstReportSkillId = '';
  for (const skill of createdSkills) {
    const report = validateSkillDir(customSkillDir(skill.id));
    void persistQualityReport({
      uid: getActiveUserId(), kind: 'skill', id: skill.id, report,
    });
    if (!firstReport && !report.ok) {
      firstReport = report;
      firstReportSkillId = skill.id;
    }
  }
  if (firstReport && opts.force !== true) {
    for (const id of createdIds) {
      try { await deleteCustomSkill(id); } catch { /* best-effort rollback */ }
    }
    return {
      ok: false,
      error: t('skills.errors.validation_blocked'),
      report: firstReport,
      skillId: firstReportSkillId,
    };
  }
  await _markSourceSkillMetadataSession(createdSkills[0]?.id || '', createdSkills.map((skill) => skill.id));

  log.info('created-from-dir direct skill install', {
    skill_count: createdSkills.length,
    files: files.length,
    bytes: totalBytes,
    source_root: realSrc,
  });
  const seedModelText = _sourceSkillMetadataSeed(createdSkills);
  return {
    ok: true,
    skill: createdSkills[0],
    skills: createdSkills,
    seedModelText,
    seedMessage: seedModelText,
  };
}

async function _createEditableDraftFromImportDir(
  name: string | null,
  description: string | null,
  realSrc: string,
  files: { src: string; rel: string; size: number }[],
  totalBytes: number,
  opts: { force?: boolean } = {},
): Promise<ImportResult> {
  const effectiveName = (name || '').trim() || _defaultSkillNameFromDir(realSrc);
  const effectiveDesc = (description || '').trim() || t('skills.import.default_desc_dir');
  const created = await createCustomSkill(effectiveName, effectiveDesc);
  if (!created) return { ok: false, error: t('skills.errors.create_failed') };

  const skillDir = customSkillDir(created.id);
  try {
    _copyImportedDraftFiles(skillDir, files);
    markSkillImportDraftSync(skillDir, 'dir');
  } catch (err) {
    log.warn(`import-dir draft copy failed skill=${created.id}: ${(err as Error).message}`);
    try { await deleteCustomSkill(created.id); } catch { /* ignore */ }
    return { ok: false, error: t('skills.errors.copy_failed', { message: (err as Error).message }) };
  }

  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });

  const report = validateSkillDir(skillDir);
  void persistQualityReport({
    uid: getActiveUserId(), kind: 'skill', id: created.id, report,
  });
  if (!report.ok && opts.force !== true) {
    try { await deleteCustomSkill(created.id); } catch { /* best-effort rollback */ }
    return {
      ok: false,
      error: t('skills.errors.validation_blocked'),
      report,
      skillId: created.id,
    };
  }

  const fresh = await getCustomSkill(created.id) || created;
  log.info('created-from-dir import draft', {
    skill_id: fresh.id,
    files: files.length,
    bytes: totalBytes,
  });
  const seedModelText = t('skills.import.seed_dir');
  return {
    ok: true,
    skill: fresh,
    skills: [fresh],
    seedModelText,
    seedMessage: seedModelText,
  };
}

/** Create an editable URL-import draft. The actual URL inspection/import runs
 *  in the visible skill edit chat so the user sees progress and the model can
 *  decide whether to restore SKILL.md, split multiple skills, or use the
 *  external-package route. */
export async function createFromUrl(
  name: string | null,
  description: string | null,
  url: string,
): Promise<ImportResult> {
  const trimmedUrl = (url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return { ok: false, error: t('skills.errors.url_scheme') };
  }
  const startedAt = Date.now();
  const sourceType = _urlImportSourceType(trimmedUrl);

  const effectiveName = (name || '').trim() || _defaultSkillNameFromUrl(trimmedUrl);
  const effectiveDesc = (description || '').trim() || t('skills.import.default_desc_url', { url: trimmedUrl });

  const created = await createCustomSkill(effectiveName, effectiveDesc);
  if (!created) {
    log.warn('url import placeholder create failed', {
      source_type: sourceType,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, error: t('skills.errors.create_failed') };
  }
  markSkillImportDraftSync(customSkillDir(created.id), 'url');

  log.info('url import seeded edit chat', {
    source_type: sourceType,
    skill_id: created.id,
    duration_ms: Date.now() - startedAt,
  });

  const seedModelText = t('skills.import.seed_url', { url: trimmedUrl });
  return {
    ok: true,
    skill: created,
    seedModelText,
    seedMessage: seedModelText,
  };
}

/** Delete a URL-import placeholder skill iff it was never authored — i.e. it
 *  still holds only the boilerplate SKILL.md (empty body, plus the metadata
 *  sidecar that `createCustomSkill` writes). Called when the user leaves an import edit chat
 *  that produced no custom skill (the source was installed as an external
 *  package, the install failed/was not installable, or the import was
 *  abandoned) so an empty draft does not linger in the skill list. The
 *  pristine check makes this safe to call on any id: an authored skill (real
 *  body or extra files) is never deleted. Returns true when a draft was removed. */
export async function discardImportDraftIfPristine(skillId: string): Promise<boolean> {
  if (!_isPristineImportDraftSkillSync(skillId)) return false;
  const ok = await deleteCustomSkill(skillId);
  if (ok) log.info(`discarded pristine import draft id=${skillId}`);
  return ok;
}

function _isPristineImportDraftSkillSync(skillId: string): boolean {
  const dir = customSkillDir(skillId);
  try { if (!fs.statSync(dir).isDirectory()) return false; }
  catch { return false; }
  // Pristine = nothing but SKILL.md plus the generated Orkas sidecar on disk...
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return false; }
  if (entries.some((e) => {
    const upper = e.toUpperCase();
    return upper !== 'SKILL.MD' && upper !== '_META.JSON';
  })) return false;
  // ...and an empty body (createCustomSkill writes body '').
  let raw: string;
  try { raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); }
  catch { return false; }
  if (splitSkillMd(raw).body.trim().length > 0) return false;
  return true;
}

function _isImportDraftForExternalSkillContainersSync(skillId: string): boolean {
  const dir = customSkillDir(skillId);
  try { if (!fs.statSync(dir).isDirectory()) return false; }
  catch { return false; }
  return isMarkedImportDraftDirSync(dir) || _isPristineImportDraftSkillSync(skillId);
}

/** Create skills from a local folder. Existing source SKILL.md roots are
 *  installed directly as one-or-more skills; folders without a SKILL.md become
 *  editable drafts that the visible inline skill chat can organize. */
export async function createFromDir(
  name: string | null,
  description: string | null,
  srcDir: string,
  opts: { force?: boolean } = {},
): Promise<ImportResult> {
  if (!srcDir || !path.isAbsolute(srcDir)) {
    return { ok: false, error: t('skills.errors.path_not_absolute') };
  }
  let realSrc: string;
  try { realSrc = fs.realpathSync(srcDir); }
  catch { return { ok: false, error: t('errors.dir_not_exists') }; }

  let st: fs.Stats;
  try { st = fs.statSync(realSrc); }
  catch { return { ok: false, error: t('skills.errors.dir_inaccessible') }; }
  if (!st.isDirectory()) return { ok: false, error: t('skills.errors.path_not_dir') };

  const black = _isBlacklistedImportSource(realSrc);
  if (black.blocked) return { ok: false, error: t('skills.errors.import_refused', { reason: black.reason || '' }) };

  // Stats walk first so we fail fast before any copy.
  const { files, fileCount, totalBytes } = _walkImportSource(realSrc);
  if (fileCount === 0) return { ok: false, error: t('skills.errors.dir_empty') };
  if (fileCount > IMPORT_MAX_FILES) {
    return { ok: false, error: t('skills.errors.too_many_files', { count: fileCount, max: IMPORT_MAX_FILES }) };
  }
  if (totalBytes > IMPORT_MAX_BYTES) {
    return { ok: false, error: t('skills.errors.too_large', { mb: (totalBytes / 1024 / 1024).toFixed(1) }) };
  }

  const sourceRoots = _findSourceSkillRoots(realSrc, files);
  if (sourceRoots.length > 0) {
    return _installSourceSkillRoots(
      name, description, realSrc, files, sourceRoots, totalBytes, { force: opts.force },
    );
  }

  return _createEditableDraftFromImportDir(
    name, description, realSrc, files, totalBytes, { force: opts.force },
  );
}

// ── target skill write guard ─────────────────────────────────────────────

/**
 * After SKILL.md is written, the `name:` in its frontmatter may not match
 * the dir-id we used to create the skill (especially in URL / Dir import
 * mode where the LLM picks a more meaningful name). Auto-rename to keep
 * the dir id and `name:` in sync.
 *
 * Returns the new id if renamed, null otherwise.
 */
async function _renameSkillByFrontmatterIfNeeded(currentId: string): Promise<string | null> {
  const md = path.join(customSkillDir(currentId), 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  let meta: SkillFrontmatter;
  try { meta = parseSkillFrontmatter(fs.readFileSync(md, 'utf8')); }
  catch { return null; }
  const intended = (meta.name || '').trim();
  if (!intended || intended === currentId) return null;
  if (validateSkillName(intended) !== '') return null;
  // Don't clobber an existing skill (custom or builtin) at the new id
  if (fs.existsSync(customSkillDir(intended))) return null;
  if (fs.existsSync(path.join(userMarketplaceSkillsDir(getActiveUserId()), intended))) return null;
  try {
    const updated = await updateCustomSkill(currentId, { name: intended });
    if (updated) {
      log.info(`auto-renamed skill ${currentId} -> ${intended} (from SKILL.md frontmatter)`);
      return intended;
    }
  } catch (err) {
    log.warn(`auto-rename failed ${currentId} -> ${intended}: ${(err as Error).message}`);
  }
  return null;
}

export interface WriteSkillFileResult {
  ok: boolean;
  /** Quality report from the file scan. `undefined` only when the call
   *  rejected on a non-quality reason (missing dir, path-escape). */
  report?: QualityReport;
  /** Non-quality rejection reason: 'missing_dir' | 'invalid_path'. */
  reason?: 'missing_dir' | 'invalid_path';
}

/**
 * Safely write content to `<skill_dir>/<relpath>` after running the quality
 * validator. Rejects:
 *   - path-escape attempts (`reason: 'invalid_path'`)
 *   - missing skill dir (`reason: 'missing_dir'`)
 *   - quality EXTREME violations (`report.ok === false`)
 *
 * MEDIUM / LOW violations don't block the write — the report is still
 * persisted so the UI / reflection layer can surface advice.
 *
 * Used by authoring flows that want the structured report back (commander
 * `<<<skill-file>>>` apply path; future inline edit chat). Callers that
 * only need a yes/no go through the legacy `writeCustomSkillFile()` wrapper.
 */
export function writeCustomSkillFileChecked(
  skillId: string,
  relpath: string,
  content: string,
): WriteSkillFileResult {
  const d = path.resolve(customSkillDir(skillId));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    return { ok: false, reason: 'missing_dir' };
  }
  const isSkillMdWrite = relpath.toUpperCase() === 'SKILL.MD';
  let sidecarPatch: SkillOrkasMeta = {};
  if (isSkillMdWrite) {
    sidecarPatch = _skillSidecarPatchFromFrontmatter(splitSkillMd(content).meta);
  }
  const contentForWrite = relpath.toUpperCase() === 'SKILL.MD'
    ? normalizeSkillMdForWrite(content, skillId)
    : content;
  const report = validateSkillFile({ relpath, content: contentForWrite });
  // Persist best-effort regardless of outcome — the report's also the input
  // for the future evolution / reflection signal stream.
  void persistQualityReport({
    uid: getActiveUserId(), kind: 'skill', id: skillId, report,
  });
  if (!report.ok) {
    return { ok: false, report };
  }
  const written = _writeSkillFileAt(d, relpath, contentForWrite, /* invalidateOnSkillMd */ true);
  if (!written) return { ok: false, report, reason: 'invalid_path' };
  if (isSkillMdWrite && _hasSkillSidecarPatch(sidecarPatch)) {
    writeSkillOrkasMetaSync(d, sidecarPatch);
  }
  clearSkillImportDraftMarkerSync(skillId);
  return { ok: true, report };
}

/**
 * Boolean-returning wrapper for callers that don't consume the quality
 * report. Internally delegates to `writeCustomSkillFileChecked`.
 */
export function writeCustomSkillFile(
  skillId: string,
  relpath: string,
  content: string,
): boolean {
  return writeCustomSkillFileChecked(skillId, relpath, content).ok;
}

/** Path-validated write into a resolved skill directory. Returns false on
 *  any path-escape attempt or missing dir. SKILL.md writes also bust the
 *  shared list cache + core-agent skill registry cache when requested. */
export function _writeSkillFileAt(
  resolvedDir: string,
  relpath: string,
  content: string,
  invalidateOnSkillMd = true,
): boolean {
  if (!relpath) return false;
  const rel = relpath.trim().replace(/^\/+/, '');
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const target = path.resolve(resolvedDir, rel);
  try {
    const relative = path.relative(resolvedDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  } catch { return false; }
  writeTextAtomicSync(target, content);
  // SKILL.md change → drop list cache + core-agent skill registry cache.
  // SkillLoader's mtime-keyed cache uses the parent dir's mtime, but POSIX
  // doesn't bump dir mtime on file content changes — so without explicit
  // invalidation the system prompt keeps showing stale skill descriptions
  // until the next app restart.
  if (invalidateOnSkillMd && rel.toUpperCase() === 'SKILL.MD') {
    invalidateSkillCachesForEdit();
  }
  return true;
}

/** Edit-chat dispatcher (with validation report). Routes to custom write for
 *  custom ids, and to the dev-only built-in dual-write for built-in ids in
 *  dev mode. Validation runs on both branches — platform installs are not
 *  exempt; if a dev edit introduces an EXTREME pattern it's still rejected.
 *
 *  Returns `{ ok: false }` (no report) for missing-id / built-in-outside-dev. */
export async function writeSkillFileForEditChecked(
  skillId: string,
  relpath: string,
  content: string,
): Promise<WriteSkillFileResult> {
  const isSkillMdWrite = relpath.toUpperCase() === 'SKILL.MD';
  const sidecarPatch = isSkillMdWrite
    ? _skillSidecarPatchFromFrontmatter(splitSkillMd(content).meta)
    : {};
  const contentForWrite = isSkillMdWrite ? normalizeSkillMdForWrite(content, skillId) : content;
  const customDir = customSkillDir(skillId);
  if (fs.existsSync(customDir) && fs.statSync(customDir).isDirectory()) {
    return writeCustomSkillFileChecked(skillId, relpath, content);
  }
  if (isBuiltinSkill(skillId)) {
    return { ok: false };
  }
  return { ok: false };
}

/** Boolean wrapper around `writeSkillFileForEditChecked` for callers that
 *  don't consume the quality report. */
export async function writeSkillFileForEdit(
  skillId: string,
  relpath: string,
  content: string,
): Promise<boolean> {
  return (await writeSkillFileForEditChecked(skillId, relpath, content)).ok;
}

interface SkillMetadataApplyResult {
  ok: boolean;
  skillId: string;
  name?: string;
  written: boolean;
  report?: QualityReport;
  reason?: WriteSkillFileResult['reason'];
}

export async function applySkillMetadataForEdit(
  skillId: string,
  updates: SkillMetadataUpdate,
  opts: { replaceSidecar?: boolean } = {},
): Promise<SkillMetadataApplyResult> {
  const skill = await getSkillForEdit(skillId);
  if (!skill) return { ok: false, skillId, written: false, reason: 'missing_dir' };
  const mdPath = path.join(skill.dir, 'SKILL.md');
  const current = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  const next = _applyMetadataToSkillMdContent(current, updates, skill.id);
  let report: QualityReport | undefined;
  let wrote = false;

  if (next !== current) {
    const res = await writeSkillFileForEditChecked(skillId, 'SKILL.md', next);
    if (!res.ok) {
      return { ok: false, skillId, written: false, report: res.report, reason: res.reason };
    }
    report = res.report;
    wrote = true;
  }

  const sidecarPatch = _skillSidecarPatchFromMetadataUpdate(updates);
  if (_hasSkillSidecarPatch(sidecarPatch)) {
    if (opts.replaceSidecar) {
      writeSkillOrkasMetaFullSync(
        skill.dir,
        _skillSidecarReplacementFromMetadataUpdate(updates, readSkillOrkasMetaSync(skill.dir)),
      );
    } else {
      writeSkillOrkasMetaSync(skill.dir, sidecarPatch);
    }
    wrote = true;
    _invalidateSkillListCache();
    invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
  }

  let resolvedId = skillId;
  if (skill.source === 'custom') {
    const newId = await _renameSkillByFrontmatterIfNeeded(skillId);
    if (newId && newId !== skillId) resolvedId = newId;
    if (wrote) clearSkillImportDraftMarkerSync(resolvedId);
  }
  const post = await getSkillForEdit(resolvedId);
  log.info(`skill=${skillId}${resolvedId !== skillId ? ` -> ${resolvedId}` : ''} metadata updated`);
  return { ok: true, skillId: resolvedId, name: post?.name || resolvedId, written: wrote, report };
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Skill inline edit chat (per user × skill)
// ═══════════════════════════════════════════════════════════════════════

function skillChatDir(userId: string, skillId: string): string {
  const d = userSkillChatDir(userId, skillId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function skillChatMsgsPath(userId: string, skillId: string): string {
  return path.join(skillChatDir(userId, skillId), 'chat.jsonl');
}

function skillChatMetaPath(userId: string, skillId: string): string {
  return path.join(skillChatDir(userId, skillId), 'chat.json');
}

function defaultSkillSessionId(skillId: string): string {
  return `skill-${skillId}`;
}

async function loadSkillChatMeta(userId: string, skillId: string): Promise<SkillChatMeta> {
  const p = skillChatMetaPath(userId, skillId);
  if (!fs.existsSync(p)) return {};
  const data: any = await readJson(p);
  return (data && typeof data === 'object') ? (data as SkillChatMeta) : {};
}

async function saveSkillChatMeta(userId: string, skillId: string, meta: SkillChatMeta): Promise<void> {
  await writeJson(skillChatMetaPath(userId, skillId), meta);
}

function _skillChatImportMetaTargets(meta: SkillChatMeta): Set<string> {
  const raw = Array.isArray(meta.import_meta_targets) ? meta.import_meta_targets : [];
  return new Set(raw.map((id) => String(id || '').trim()).filter(Boolean));
}

async function _clearSkillChatImportMetaTargets(userId: string, skillId: string, sessionId: string): Promise<void> {
  const current = await loadSkillChatMeta(userId, skillId);
  if (!current.import_meta_targets && !current.import_meta_created_at) return;
  const next: SkillChatMeta = { ...current, session_id: sessionId };
  delete next.import_meta_targets;
  delete next.import_meta_created_at;
  await saveSkillChatMeta(userId, skillId, next);
}

export async function getSkillChatMessages(userId: string, skillId: string, limit = 500): Promise<any[]> {
  return readJsonl(skillChatMsgsPath(userId, skillId), limit);
}

async function _appendSkillChatMessage(userId: string, skillId: string, record: any): Promise<void> {
  const file = skillChatMsgsPath(userId, skillId);
  await appendJsonlAtomic(file, record);
}

export async function clearSkillChat(userId: string, skillId: string): Promise<boolean> {
  // Allow clearing for either custom or built-in (dev mode reaches built-in
  // edit chats). Path is id-keyed regardless of source.
  if (!fs.existsSync(customSkillDir(skillId)) && !isBuiltinSkill(skillId)) return false;
  for (const p of [skillChatMsgsPath(userId, skillId), skillChatMetaPath(userId, skillId)]) {
    if (fs.existsSync(p)) {
      try { await fsp.unlink(p); }
      catch (err) { log.warn(`rm failed ${p}: ${(err as Error).message}`); }
    }
  }
  invalidateLineCount(skillChatMsgsPath(userId, skillId));
  // Also evict + drop the core-agent persistent session jsonl. Without this
  // the LLM retains its full prior context (tool calls, paths, file contents)
  // even though the UI history is empty — visible as the LLM "remembering"
  // pre-clear state, e.g. trying to read paths that no longer exist after a
  // promote-to-builtin. Session id is id-keyed so it survives source changes.
  const sessionId = defaultSkillSessionId(skillId);
  try { evictSession(sessionId); } catch { /* not in cache */ }
  try { await fsp.unlink(userSessionFile(userId, sessionId)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`session unlink user=${userId} skill=${skillId}: ${(err as Error).message}`);
    }
  }
  log.info(`cleared user=${userId} skill=${skillId}`);
  return true;
}

export interface SkillFileBlock {
  path: string;
  content: string;
}

const SKILL_METADATA_TAGS = ['name', 'description', 'description_zh', 'description_en', 'category'] as const;
const SKILL_ROUTING_METADATA_TAGS = ['negative_examples', 'applicable_domain', 'prerequisites'] as const;
type SkillMetadataKey = typeof SKILL_METADATA_TAGS[number];

export type SkillMetadataUpdate = Partial<Record<SkillMetadataKey, string>> & {
  routing?: {
    negative_examples?: string[];
    applicable_domain?: string | string[];
    prerequisites?: string[];
  };
};

function _extractSimpleXmlTag(inner: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`);
  const m = inner.match(re);
  return m ? m[1].trim() : undefined;
}

function _parseSkillMetadataUpdate(inner: string): SkillMetadataUpdate {
  const out: SkillMetadataUpdate = {};
  for (const tag of SKILL_METADATA_TAGS) {
    const value = _extractSimpleXmlTag(inner, tag);
    if (value !== undefined) out[tag] = value;
  }
  const routing = _parseSkillRoutingMetadata(inner);
  if (routing) out.routing = routing;
  return out;
}

function _hasSkillMetadataUpdate(updates?: SkillMetadataUpdate): boolean {
  return !!updates && (
    SKILL_METADATA_TAGS.some((k) => Object.prototype.hasOwnProperty.call(updates, k))
    || !!updates.routing
  );
}

function _mergeSkillMetadataUpdates(updates: SkillMetadataUpdate[]): SkillMetadataUpdate {
  const merged: SkillMetadataUpdate = {};
  for (const update of updates) {
    for (const tag of SKILL_METADATA_TAGS) {
      if (Object.prototype.hasOwnProperty.call(update, tag)) {
        merged[tag] = String(update[tag] || '');
      }
    }
    if (update.routing) {
      merged.routing = { ...(merged.routing || {}), ...update.routing };
    }
  }
  return merged;
}

function _parseMetadataListValue(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || '').trim()).filter(Boolean);
    }
  } catch { /* fall through to line parsing */ }
  return text
    .split(/\r?\n|[；;]/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function _parseSkillRoutingMetadata(inner: string): SkillMetadataUpdate['routing'] | undefined {
  const blocks = [inner];
  const routingInner = _extractSimpleXmlTag(inner, 'routing');
  if (routingInner !== undefined) blocks.unshift(routingInner);
  const routing: NonNullable<SkillMetadataUpdate['routing']> = {};
  for (const block of blocks) {
    for (const tag of SKILL_ROUTING_METADATA_TAGS) {
      const value = _extractSimpleXmlTag(block, tag);
      if (value === undefined) continue;
      if (tag === 'applicable_domain') {
        const list = _parseMetadataListValue(value);
        routing.applicable_domain = list.length > 1 ? list : (list[0] || value.trim());
      } else {
        routing[tag] = _parseMetadataListValue(value);
      }
    }
  }
  return Object.keys(routing).length ? routing : undefined;
}

function _importSidecarOnlyMetadata(updates?: SkillMetadataUpdate): SkillMetadataUpdate {
  const next: SkillMetadataUpdate = {};
  if (!updates) return next;
  if (Object.prototype.hasOwnProperty.call(updates, 'category')) {
    next.category = String(updates.category || '');
  }
  if (updates.routing) next.routing = updates.routing;
  return next;
}

function _applyMetadataToSkillMdContent(
  content: string,
  updates: SkillMetadataUpdate,
  fallbackName = '',
): string {
  if (!_hasSkillMetadataUpdate(updates)) return content;
  const touchesSkillMd = ['name', 'description', 'description_zh', 'description_en']
    .some((k) => Object.prototype.hasOwnProperty.call(updates, k));
  if (!touchesSkillMd) return content;
  const { meta, body } = splitSkillMd(content || '');
  const persisted = migrateDescriptionPair(meta as any);
  const name = Object.prototype.hasOwnProperty.call(updates, 'name')
    ? String(updates.name || '')
    : String(meta.name || fallbackName || '');
  const legacyDescription = Object.prototype.hasOwnProperty.call(updates, 'description')
    ? String(updates.description || '')
    : String(meta.description || '');
  const descriptionZh = Object.prototype.hasOwnProperty.call(updates, 'description_zh')
    ? String(updates.description_zh || '')
    : persisted.description_zh;
  const descriptionEn = Object.prototype.hasOwnProperty.call(updates, 'description_en')
    ? String(updates.description_en || '')
    : persisted.description_en;
  return skillMdContent(name, legacyDescription || { zh: descriptionZh, en: descriptionEn }, body);
}

function _skillSidecarPatchFromMetadataUpdate(updates: SkillMetadataUpdate): SkillOrkasMeta {
  const patch: SkillOrkasMeta = {};
  if (Object.prototype.hasOwnProperty.call(updates, 'category')) {
    patch.category = String(updates.category || '');
  }
  const descriptions: { zh?: string; en?: string } = {};
  if (Object.prototype.hasOwnProperty.call(updates, 'description_zh')) {
    descriptions.zh = String(updates.description_zh || '');
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'description_en')) {
    descriptions.en = String(updates.description_en || '');
  }
  if (descriptions.zh && descriptions.en) patch.descriptions = descriptions;
  if (updates.routing) patch.routing = updates.routing;
  return patch;
}

function _cleanSkillMetaList(values: unknown): string[] {
  const arr = Array.isArray(values) ? values : (typeof values === 'string' ? [values] : []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of arr) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function _sanitizedRoutingForSidecar(routing: SkillMetadataUpdate['routing']): SkillOrkasMeta['routing'] | undefined {
  if (!routing || typeof routing !== 'object') return undefined;
  const next: NonNullable<SkillOrkasMeta['routing']> = {};
  const negative = _cleanSkillMetaList(routing.negative_examples);
  const prereq = _cleanSkillMetaList(routing.prerequisites);
  const domain = Array.isArray(routing.applicable_domain)
    ? _cleanSkillMetaList(routing.applicable_domain)
    : String(routing.applicable_domain || '').replace(/\s+/g, ' ').trim();
  if (negative.length) next.negative_examples = negative;
  if (prereq.length) next.prerequisites = prereq;
  if (Array.isArray(domain)) {
    if (domain.length === 1) next.applicable_domain = domain[0];
    else if (domain.length > 1) next.applicable_domain = domain;
  } else if (domain) {
    next.applicable_domain = domain;
  }
  return Object.keys(next).length ? next : undefined;
}

function _skillSidecarReplacementFromMetadataUpdate(
  updates: SkillMetadataUpdate,
  current: SkillOrkasMeta,
): SkillOrkasMeta {
  const category = normalizeMarketplaceCategoryCode(
    typeof updates.category === 'string' ? updates.category : '',
    DEFAULT_MARKETPLACE_CATEGORY_CODE,
  );
  const next: SkillOrkasMeta = { category };
  const routing = _sanitizedRoutingForSidecar(updates.routing);
  if (routing) next.routing = routing;
  const status = typeof current.status === 'string' ? current.status.trim() : '';
  if (status) next.status = status;
  return next;
}

/** Strip `<skill-meta>...</skill-meta>` blocks from per-skill edit chat output.
 *  Commander metadata lives inside the outer `<skill>` container and is parsed
 *  by `_parseSkillContainer` below. */
export function extractSkillMetadataBlocks(text: string): { cleanText: string; updates: SkillMetadataUpdate[] } {
  if (!text || text.indexOf('<skill-meta') < 0) return { cleanText: text, updates: [] };
  const ranges = findOuterTagRanges(text, 'skill-meta');
  if (!ranges.length) return { cleanText: text, updates: [] };
  const updates: SkillMetadataUpdate[] = [];
  let cleaned = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    cleaned += text.slice(cursor, s);
    const block = text.slice(s, e);
    if (block.endsWith('</skill-meta>')) {
      const tagEnd = block.indexOf('>');
      const inner = tagEnd >= 0
        ? block.slice(tagEnd + 1, block.length - '</skill-meta>'.length)
        : '';
      const parsed = _parseSkillMetadataUpdate(inner);
      if (_hasSkillMetadataUpdate(parsed)) updates.push(parsed);
    }
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, updates };
}

/** Strip <<<skill-file path=X … >>> blocks. Returns { cleanText, files }. */
export function extractSkillFileBlocks(text: string): { cleanText: string; files: SkillFileBlock[] } {
  if (!text || !text.includes('<<<skill-file')) return { cleanText: text, files: [] };
  const files: SkillFileBlock[] = [];
  const cleaned = text.replace(SKILL_FILE_BLOCK_RE, (_m, attrsRaw, content) => {
    const attrs = _parseSkillFileAttrs(attrsRaw || '');
    const trimmedPath = (attrs.path || '').trim();
    if (trimmedPath) {
      files.push({ path: trimmedPath, content: content || '' });
    }
    return '';
  });
  const compact = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: compact, files };
}

/** Self-closing marker the URL-import edit chat emits AFTER it has already
 *  installed the source as an external package (via `orkas-pkg` over bash).
 *  It is a finalize signal — drop the placeholder skill, switch the view —
 *  not an install instruction; install itself stays on the bash/CLI path. */
// Require an actual self-closing marker (`.../>`) or a paired close tag —
// a bare `<skill-as-package>` mention in prose must NOT fire, because firing
// deletes the placeholder skill (a high-cost, irreversible finalize).
const SKILL_AS_PACKAGE_RE = /<skill-as-package\b([^>]*?)\/>|<skill-as-package\b([^>]*?)>\s*<\/skill-as-package>/i;

/** Detect + strip the `<skill-as-package name="..."/>` marker. Returns null
 *  when absent so callers fall through to normal file/metadata handling. */
export function extractSkillAsPackageMarker(text: string): { cleanText: string; name: string | null } | null {
  if (!text || text.toLowerCase().indexOf('<skill-as-package') < 0) return null;
  const m = SKILL_AS_PACKAGE_RE.exec(text);
  if (!m) return null;
  const attrs = m[1] ?? m[2] ?? '';
  const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(attrs) || /name\s*=\s*'([^']*)'/i.exec(attrs);
  const name = nameMatch ? nameMatch[1].trim() : null;
  const cleanText = text.replace(SKILL_AS_PACKAGE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, name: name || null };
}

/** Optional user-visible reply channel for skill edit outputs that also carry
 *  machine-write protocol. Raw prose around write blocks is treated as
 *  protocol-adjacent and is not trusted as the final chat message. */
export function extractSkillReplyBlocks(text: string): { cleanText: string; replies: string[] } {
  if (!text || text.indexOf(`<${SKILL_REPLY_TAG}`) < 0) return { cleanText: text, replies: [] };
  const ranges = findOuterTagRanges(text, SKILL_REPLY_TAG);
  if (!ranges.length) return { cleanText: text, replies: [] };
  const replies: string[] = [];
  let cleaned = '';
  let cursor = 0;
  const closeLiteral = `</${SKILL_REPLY_TAG}>`;
  for (const [s, e] of ranges) {
    cleaned += text.slice(cursor, s);
    const block = text.slice(s, e);
    if (block.endsWith(closeLiteral)) {
      const tagEnd = block.indexOf('>');
      const inner = tagEnd >= 0
        ? block.slice(tagEnd + 1, block.length - closeLiteral.length)
        : '';
      const reply = inner.replace(/\n{3,}/g, '\n\n').trim();
      if (reply) replies.push(reply);
    }
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, replies };
}

// ── Commander `<skill>` container ────────────────────────────────────────
// Outer container the commander emits to create / patch a skill mid-turn
// (parallel to `extractAgentFieldBlocks`). Only the inner `<<<skill-file>>>`
// blocks are processed; stray blocks outside the container stay visible as
// prose so the LLM gets feedback on its own malformed output rather than
// silently writing files.
//
// **Prose/code guard**: `findOuterTagRanges` skips `<skill>` mentions that
// fall inside fenced ``` code blocks or inline backtick spans, so an LLM
// teaching the user the protocol (e.g. "the format is `<skill>...</skill>`"
// or showing it in a fenced example) doesn't accidentally trigger a real
// skill write. Same guard the renderer uses (`strip-structural-blocks.js`).
const OPEN_TAG = '<skill>';
const CLOSE_TAG = '</skill>';
const SKILL_ID_RE = /<skill_id>\s*([\s\S]*?)\s*<\/skill_id>/;

export interface SkillContainerExtracted {
  /** Empty/undefined → create flow; non-empty → edit flow targeting this id. */
  skillId?: string;
  /** All `<<<skill-file>>>` blocks parsed from inside the container. */
  files: SkillFileBlock[];
  /** Optional field-level metadata updates, used for cheap category/description edits. */
  metadata?: SkillMetadataUpdate;
}

function _parseSkillContainer(inner: string): SkillContainerExtracted {
  const idM = inner.match(SKILL_ID_RE);
  const skillId = idM ? idM[1].trim() : '';
  const { cleanText, files } = extractSkillFileBlocks(inner);
  const metadata = _parseSkillMetadataUpdate(cleanText);
  return {
    ...(skillId ? { skillId } : {}),
    files,
    ...(_hasSkillMetadataUpdate(metadata) ? { metadata } : {}),
  };
}

/**
 * Extract every `<skill>...</skill>` container in emission order. Each
 * container is parsed independently. Returns `containers: []` when none
 * is present.
 *
 * Containers inside fenced code blocks / inline backtick spans are
 * NOT extracted (prose/code guard); unclosed containers (no `</skill>`
 * before EOF — should not happen on final-event text but guarded
 * defensively) are skipped from `containers` but stripped from
 * `cleanText` so half-baked tokens don't leak into the bubble.
 */
export function extractSkillContainers(
  text: string,
): { cleanText: string; containers: SkillContainerExtracted[] } {
  if (!text || text.indexOf(OPEN_TAG) < 0) return { cleanText: text, containers: [] };
  const ranges = findOuterTagRanges(text, 'skill');
  if (!ranges.length) return { cleanText: text, containers: [] };
  const containers: SkillContainerExtracted[] = [];
  let cleaned = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    cleaned += text.slice(cursor, s);
    const block = text.slice(s, e);
    if (block.startsWith(OPEN_TAG) && block.endsWith(CLOSE_TAG)) {
      const inner = block.slice(OPEN_TAG.length, block.length - CLOSE_TAG.length);
      containers.push(_parseSkillContainer(inner));
    }
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, containers };
}

interface InlineSkillEditExtraction {
  cleanText: string;
  visibleReply: string;
  files: SkillFileBlock[];
  metadataUpdate: SkillMetadataUpdate;
  externalContainers: SkillContainerExtracted[];
  rejectedContainerCount: number;
}

function _extractInlineSkillEditMutations(text: string, currentSkillId: string): InlineSkillEditExtraction {
  const replyExtract = extractSkillReplyBlocks(text);
  const containerExtract = extractSkillContainers(replyExtract.cleanText);
  const fileExtract = extractSkillFileBlocks(containerExtract.cleanText);
  const metaExtract = extractSkillMetadataBlocks(fileExtract.cleanText);
  const files: SkillFileBlock[] = [...fileExtract.files];
  const metadataUpdates: SkillMetadataUpdate[] = [...metaExtract.updates];
  const externalContainers: SkillContainerExtracted[] = [];
  let rejectedContainerCount = 0;

  for (const container of containerExtract.containers) {
    const target = String(container.skillId || '').trim();
    const metadataOnlyCurrentFallback = !target
      && !container.files.length
      && _hasSkillMetadataUpdate(container.metadata);
    if (target === currentSkillId || metadataOnlyCurrentFallback) {
      files.push(...container.files);
      if (_hasSkillMetadataUpdate(container.metadata)) metadataUpdates.push(container.metadata || {});
      continue;
    }
    externalContainers.push(container);
  }
  return {
    cleanText: metaExtract.cleanText,
    visibleReply: replyExtract.replies.join('\n\n').trim(),
    files,
    metadataUpdate: _mergeSkillMetadataUpdates(metadataUpdates),
    externalContainers,
    rejectedContainerCount,
  };
}

function _skillEditMutationFinalText(args: {
  extracted: InlineSkillEditExtraction;
  wroteFiles: boolean;
  updatedMetadata: boolean;
  createdSkills: Array<{ skill_id: string; name: string; kind?: 'created' | 'updated' }>;
  sawMutationProtocol: boolean;
}): string {
  const explicit = (args.extracted.visibleReply || '').trim();
  if (explicit) return explicit;
  if (args.createdSkills.some((skill) => skill.kind === 'created')) {
    return t('process.skill.final_imported', { count: args.createdSkills.length });
  }
  if (args.wroteFiles || args.updatedMetadata || args.createdSkills.length) {
    return t('process.skill.final_updated');
  }
  if (args.sawMutationProtocol) {
    return t('process.skill.final_no_changes');
  }
  return args.extracted.cleanText;
}

function _stripIncompleteSkillEditProtocolTail(text: string): string {
  let cleaned = text || '';
  for (const [open, close] of [
    ['<<<skill-file', '>>>'],
    ['<skill-meta', '</skill-meta>'],
    ['<skill-as-package', '>'],
    ['<skill', '</skill>'],
  ] as const) {
    const start = cleaned.lastIndexOf(open);
    if (start >= 0 && cleaned.indexOf(close, start + open.length) < 0) {
      cleaned = cleaned.slice(0, start);
    }
  }

  const scanStart = Math.max(0, cleaned.length - 32);
  for (let i = scanStart; i < cleaned.length; i++) {
    const tail = cleaned.slice(i);
    if (tail.length >= 2 && SKILL_EDIT_PROTOCOL_LEADERS.some((leader) => leader.startsWith(tail))) {
      cleaned = cleaned.slice(0, i);
      break;
    }
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function _visibleInlineSkillEditText(text: string, currentSkillId: string): string {
  const withoutPackageMarker = extractSkillAsPackageMarker(text)?.cleanText ?? text;
  const extracted = _extractInlineSkillEditMutations(withoutPackageMarker, currentSkillId);
  if (extracted.visibleReply) return extracted.visibleReply;
  if (SKILL_EDIT_PROTOCOL_LEADERS.some((leader) => withoutPackageMarker.includes(leader))) return '';
  return _stripIncompleteSkillEditProtocolTail(extracted.cleanText);
}

export interface SkillContainerResult {
  ok: boolean;
  /** 'created' for the no-skill-id branch; 'updated' for the edit branch.
   *  Undefined on `ok: false`. */
  kind?: 'created' | 'updated';
  /** Resolved skill id after the operation — for `created`: the id we
   *  allocated; for `updated`: the post-rename id when SKILL.md frontmatter
   *  changed `name`, otherwise the original id. */
  skillId?: string;
  /** Display name from SKILL.md frontmatter (post-write). */
  name?: string;
  /** Paths successfully written, in container order. */
  written?: string[];
  /** Paths whose write was rejected (path-escape, missing dir, etc.). Never
   *  causes total failure — best-effort policy mirrors the skill-edit chat. */
  rejected?: string[];
  /** Quality-validator rejections. Each entry pairs the rejected path with
   *  the report (EXTREME violations only land here — MEDIUM passes through).
   *  Surfaced to the LLM as structured retry feedback. */
  validation_failed?: { path: string; report: QualityReport }[];
  /** Quality-validator advisories. Files that wrote successfully but have
   *  MEDIUM-level findings the LLM / UI should display. */
  validation_warnings?: { path: string; report: QualityReport }[];
  /** Total-failure cause when `ok: false`. Already localized via `t()`. */
  error?: string;
}

/** Apply a parsed `<skill>` container from commander. Routes to edit when
 *  `container.skillId` resolves to an existing skill; otherwise a full
 *  SKILL.md payload is treated as create. This makes the commander path
 *  resilient to LLMs that mistakenly include `<skill_id>` while creating a
 *  brand-new skill. Built-in skills are read-only here — same policy as the
 *  per-skill edit chat outside dev mode. Best-effort writes per-file: a
 *  single rejected path doesn't roll back earlier successes (matches
 *  `streamSendToSkillChat`'s file-by-file outcome). */
export async function applySkillContainerFromCommander(
  container: SkillContainerExtracted,
  opts: { replaceSidecar?: boolean } = {},
): Promise<SkillContainerResult> {
  const hasMetadata = _hasSkillMetadataUpdate(container.metadata);
  if (!container.files.length && !hasMetadata) {
    return { ok: false, error: t('skills.errors.container_empty') };
  }
  if (container.skillId) {
    return _applySkillContainerEdit(container.skillId, container.files, container.metadata, opts);
  }
  return _applySkillContainerCreate(container.files, container.metadata);
}

async function _applySkillContainerCreate(
  files: SkillFileBlock[],
  metadata?: SkillMetadataUpdate,
): Promise<SkillContainerResult> {
  files = files.map((f) => (
    f.path.toUpperCase() === 'SKILL.MD'
      ? {
        ...f,
        content: _applyMetadataToSkillMdContent(f.content || '', metadata || {}),
      }
      : f
  ));
  // SKILL.md is mandatory in the create branch — that's where the skill id
  // (frontmatter `name`) and bilingual descriptions are sourced from.
  const skillMd = files.find((f) => f.path.toUpperCase() === 'SKILL.MD');
  if (!skillMd) return { ok: false, error: t('skills.errors.create_missing_skill_md') };
  const { meta } = splitSkillMd(skillMd.content || '');
  const rawName = (meta.name || '');
  const name = rawName.trim();
  if (!name) return { ok: false, error: t('skills.errors.create_missing_name') };
  const validateErr = validateSkillName(rawName);
  if (validateErr) return { ok: false, error: validateErr };
  // Collision checks — same gates as the IPC create path so commander and
  // detail panel produce identical failure modes.
  if (fs.existsSync(customSkillDir(name))) {
    return { ok: false, error: t('skills.errors.skill_exists', { name }) };
  }
  if (fs.existsSync(path.join(userMarketplaceSkillsDir(getActiveUserId()), name))) {
    return { ok: false, error: t('skills.errors.builtin_conflict', { name }) };
  }
  // Pre-validate every file BEFORE any FS mutation. Without this, the path
  // is "create dir + write boilerplate SKILL.md" → "write LLM files (each
  // gated by validator)" → if every file gets rejected by EXTREME, the
  // boilerplate SKILL.md remains and `listSkills` still shows the
  // half-created skill. Pre-validation moves the EXTREME gate to a single
  // decision point: any EXTREME → abort the whole create, no dir touched.
  const validationFailed: { path: string; report: QualityReport }[] = [];
  const validationWarnings: { path: string; report: QualityReport }[] = [];
  for (const fb of files) {
    const report = validateSkillFile({ relpath: fb.path, content: fb.content });
    if (!report.ok) {
      validationFailed.push({ path: fb.path, report });
    } else if (report.violations.length > 0) {
      validationWarnings.push({ path: fb.path, report });
    }
  }
  if (validationFailed.length > 0) {
    log.info(`commander create skill=${name} aborted by validator (files=${validationFailed.map((v) => v.path).join(',')})`);
    return {
      ok: false,
      error: t('skills.errors.validation_blocked'),
      validation_failed: validationFailed,
    };
  }

  // All files passed EXTREME — proceed with the actual create.
  const desc = migrateDescriptionPair(meta as any);
  const seedDescription = desc.description_zh || desc.description_en || '';
  const metadataSidecar = metadata ? _skillSidecarPatchFromMetadataUpdate(metadata) : {};
  const fileSidecar = _skillSidecarPatchFromFrontmatter(meta);
  const seedCategory = String(metadataSidecar.category || fileSidecar.category || '');
  const created = await createCustomSkill(name, seedDescription, seedCategory);
  if (!created) return { ok: false, error: t('skills.errors.create_failed') };

  const written: string[] = [];
  const rejected: string[] = [];
  for (const fb of files) {
    // After pre-validation passed, the only remaining reason to reject is
    // a path-escape attempt (handled inside `writeCustomSkillFileChecked`).
    const res = writeCustomSkillFileChecked(name, fb.path, fb.content);
    if (res.ok) {
      written.push(fb.path);
    } else {
      rejected.push(fb.path);
    }
  }
  // Force-stamp mtime on every freshly-written file so the sync engine's
  // tombstone resurrection guard treats them as fresh (see the matching
  // comment in `createCustomSkill`). Atomic rename can otherwise leave the
  // final mtime pinned to the .tmp creation moment, falling below a recent
  // delete tombstone's deleted_at_ms and triggering re-deletion next pass.
  const stampNow = new Date();
  for (const w of written) {
    try { fs.utimesSync(path.join(customSkillDir(name), w), stampNow, stampNow); }
    catch { /* best effort */ }
  }
  if (_hasSkillSidecarPatch(metadataSidecar)) {
    writeSkillOrkasMetaSync(customSkillDir(name), metadataSidecar);
  }
  if (written.length) log.info(`commander created skill=${name} files=${written.length}`);
  return {
    ok: true,
    kind: 'created',
    skillId: name,
    name,
    written,
    ...(rejected.length ? { rejected } : {}),
    ...(validationWarnings.length ? { validation_warnings: validationWarnings } : {}),
  };
}

async function _applySkillContainerEdit(
  skillId: string,
  files: SkillFileBlock[],
  metadata?: SkillMetadataUpdate,
  opts: { replaceSidecar?: boolean } = {},
): Promise<SkillContainerResult> {
  const hasMetadata = _hasSkillMetadataUpdate(metadata);
  if (!files.length && !hasMetadata) {
    return { ok: false, error: t('skills.errors.container_empty') };
  }
  const skill = await getSkillForEdit(skillId);
  if (!skill) {
    const hasSkillMd = files.some((f) => f.path.toUpperCase() === 'SKILL.MD');
    if (hasSkillMd) {
      log.info(`commander target skill=${skillId} missing; treating SKILL.md payload as create`);
      return _applySkillContainerCreate(files);
    }
    return { ok: false, error: t('skills.errors.skill_not_found', { id: skillId }) };
  }
  // Marketplace skills are dev-mode-only from any write path (commander
  // here + inline edit chat at sendToSkillChat). Mirrors the agent edit
  // policy at `bus.ts` post-stream parsing. Downstream
  // `writeSkillFileForEditChecked` routes the dev branch through
  // `skills_dev.writeBuiltinSkillFile`, which writes the local marketplace
  // install dir.
  if (skill.source !== 'custom' && !false) {
    return { ok: false, error: t('errors.builtin_skill_not_editable') };
  }
  const written: string[] = [];
  const rejected: string[] = [];
  const validationFailed: { path: string; report: QualityReport }[] = [];
  const validationWarnings: { path: string; report: QualityReport }[] = [];
  let touchedSkillMd = false;
  for (const fb of files) {
    const res = await writeSkillFileForEditChecked(skillId, fb.path, fb.content);
    if (res.ok) {
      written.push(fb.path);
      if (fb.path.toUpperCase() === 'SKILL.MD') touchedSkillMd = true;
      if (res.report && res.report.violations.length > 0) {
        validationWarnings.push({ path: fb.path, report: res.report });
      }
    } else {
      rejected.push(fb.path);
      if (res.report) validationFailed.push({ path: fb.path, report: res.report });
    }
  }
  // Force-stamp mtime on every freshly-written file so the sync engine's
  // tombstone resurrection guard treats them as fresh (see the matching
  // comment in `createCustomSkill`). Edit path matters when a user deletes
  // a skill and immediately re-edits the same id — without this stamp the
  // atomic rename's mtime can fall under the lingering tombstone's
  // deleted_at_ms and the next sync pass wipes the new bytes.
  const editStampNow = new Date();
  for (const w of written) {
    try { fs.utimesSync(path.join(skill.dir, w), editStampNow, editStampNow); }
    catch { /* best effort */ }
  }
  // Auto-rename when SKILL.md frontmatter `name` differs from the dir id —
  // same hook as the per-skill edit chat (`streamSendToSkillChat`).
  let resolvedId = skillId;
  if (touchedSkillMd) {
    const newId = await _renameSkillByFrontmatterIfNeeded(skillId);
    if (newId && newId !== skillId) resolvedId = newId;
  }

  let metadataOk = !hasMetadata;
  if (hasMetadata) {
    const metaRes = await applySkillMetadataForEdit(resolvedId, metadata || {}, opts);
    if (metaRes.ok) {
      metadataOk = true;
      resolvedId = metaRes.skillId;
      if (metaRes.written) {
        if (!written.includes('SKILL.md')) written.push('SKILL.md');
        if (metaRes.report && metaRes.report.violations.length > 0) {
          validationWarnings.push({ path: 'SKILL.md', report: metaRes.report });
        }
      }
    } else if (metaRes.report) {
      validationFailed.push({ path: 'SKILL.md', report: metaRes.report });
    } else {
      rejected.push('SKILL.md');
    }
  }
  const post = await getSkillForEdit(resolvedId);
  if (written.length) log.info(`commander updated skill=${skillId}${resolvedId !== skillId ? ` -> ${resolvedId}` : ''} files=${written.length}`);
  const ok = files.length > 0 || metadataOk;
  return {
    ok,
    kind: 'updated',
    skillId: resolvedId,
    name: post?.name || resolvedId,
    written,
    ...(rejected.length ? { rejected } : {}),
    ...(validationFailed.length ? { validation_failed: validationFailed } : {}),
    ...(validationWarnings.length ? { validation_warnings: validationWarnings } : {}),
  };
}

function skillFilesBlock(files: SkillFileInfo[]): string {
  if (!files.length) return '  (empty)';
  return files.map((f) => `  - ${f.path}  (${f.bytes || 0} B)`).join('\n');
}

/**
 * Build the system prompt for the skill-edit chat. Includes the current
 * skill metadata + file listing so the LLM always sees up-to-date state —
 * re-run every turn.
 */
export async function buildSkillEditSystemPrompt(skill: {
  id?: string;
  name?: string;
  /** Legacy single-language seed; auto-routed via Chinese-character heuristic. */
  description?: string;
  description_zh?: string;
  description_en?: string;
  category?: string;
  dir?: string;
  /** Picks the file-listing path: `marketplace` reads files from `dir`
   *  directly (per-machine install root), `custom` resolves via id under
   *  the user's custom skills dir. */
  source?: SkillSource;
}): Promise<string> {
  const files = isMarketplaceSource(skill.source || 'custom') && skill.dir
    ? await _listSkillFilesAt(skill.dir)
    : await listCustomSkillFiles(skill.id || '');
  // Resolve all three forms into a single legacy `$skill_description` for the
  // current template, plus the bilingual pair for forward-compat. Phase 2
  // splits the template; this keeps existing prompt rendering working.
  const legacy = (skill.description || '').trim();
  const isChinese = /[一-鿿]/.test(legacy);
  const zh = (skill.description_zh || '').trim() || (legacy && isChinese ? legacy : '');
  const en = (skill.description_en || '').trim() || (legacy && !isChinese ? legacy : '');
  const display = legacy || zh || en;
  const body = prompts.load('chat_skill_setup', {
    skill_name: skill.name || '',
    skill_description: display || '(not provided)',
    skill_description_zh: zh || '(not provided)',
    skill_description_en: en || '(not provided)',
    skill_dir: skill.dir || '',
    skill_files: skillFilesBlock(files),
  });
  const tail = buildLanguageDirective(getLanguage());
  return `${body}\n\n---\n\n${tail}\n\n---\n\n${buildRuntimeDatetimeBlock()}`;
}

export interface SkillChatResult {
  ok: boolean;
  message?: string;
  error?: string;
  written?: string[];
  /** Frontmatter `name` edits trigger a rename of the skill dir; this list surfaces
   *  every (oldId → newId) pair so the renderer can re-anchor open tabs. */
  renamed?: Array<{ oldId: string; newId: string }>;
}

function skillEditAttachmentCid(skillId: string): string {
  return `skill-edit-${skillId}`;
}

async function buildSkillEditMessageWithAttachments(
  userId: string,
  skillId: string,
  content: string,
  attachments?: string[],
): Promise<{
  message: string;
  images: Array<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }>;
  attachmentNames: string[];
  attachmentCid: string;
  attachmentMetadata: { hasAttachments: boolean; attachmentTypes: string[] };
}> {
  const attachmentNames = Array.isArray(attachments)
    ? attachments.filter((n): n is string => typeof n === 'string' && !!n.trim())
    : [];
  const attachmentCid = skillEditAttachmentCid(skillId);
  if (!attachmentNames.length) {
    return {
      message: content,
      images: [],
      attachmentNames,
      attachmentCid,
      attachmentMetadata: { hasAttachments: false, attachmentTypes: [] },
    };
  }
  const { manifest, images, metadata } = await buildAttachmentManifest(userId, attachmentCid, attachmentNames);
  return {
    message: manifest ? `${manifest}\n${content}` : content,
    images,
    attachmentNames,
    attachmentCid,
    attachmentMetadata: metadata,
  };
}

export async function sendToSkillChat(
  userId: string,
  skillId: string,
  content: string,
  opts: { attachments?: string[]; modelText?: string } = {},
): Promise<SkillChatResult> {
  const skill = await getSkillForEdit(skillId);
  if (!skill) return { ok: false, error: 'skill not found' };
  if (isMarketplaceSource(skill.source) && !false) {
    return { ok: false, error: t('errors.builtin_skill_not_editable') };
  }

  const meta = await loadSkillChatMeta(userId, skillId);
  const sessionId = meta.session_id || defaultSkillSessionId(skillId);

  const systemPrompt = await buildSkillEditSystemPrompt(skill);
  const modelText = typeof opts.modelText === 'string' ? opts.modelText.trim() : '';
  const modelContent = modelText || content;
  const attachmentCtx = await buildSkillEditMessageWithAttachments(userId, skillId, modelContent, opts.attachments);

  await _appendSkillChatMessage(userId, skillId,
    {
      time: nowIso(), role: 'user', content,
      ...(modelText ? { model_text: modelText } : {}),
      ...(attachmentCtx.attachmentNames.length ? { attachments: attachmentCtx.attachmentNames, attachment_cid: attachmentCtx.attachmentCid } : {}),
    });

  const { chatWithModel } = require('../model/client');
  const result = await chatWithModel({
    userId, message: attachmentCtx.message, sessionId, systemPrompt,
    agentName: 'orkas_chat', timeout: 300,
    // Read-only: the LLM in per-skill edit chat sees the skill dir for
    // inspection (read_file / search_files / grep_files / stat_file), but
    // every mutation goes through `<<<skill-file>>>` blocks parsed
    // post-stream (which routes through `writeSkillFileForEdit` →
    // rename-by-frontmatter / registry invalidation / progress events).
    // Direct edit_file / write_file / bash on this dir would skip all
    // that, so it's blocked at the sandbox level.
    readOnlyExtraRoots: [
      ...(skill.dir ? [skill.dir] : []),
      userMarketplaceSkillsDir(getActiveUserId()),
      userSkillsDir(userId),
      // System skills root so a URL-import chat can read `package-installer`
      // before driving `orkas-pkg`; ordinary SkillRegistry no longer loads
      // repo-shipped builtin skills.
      userSystemSkillsDir(userId),
      ...(attachmentCtx.attachmentNames.length ? [chatAttachmentDir(userId, attachmentCtx.attachmentCid)] : []),
    ],
    attachmentMetadata: attachmentCtx.attachmentMetadata,
    ...(attachmentCtx.images.length ? { images: attachmentCtx.images } : {}),
  });

  if (!result.ok) {
    const errMsg = `Model response failed: ${result.error || 'unknown'}`;
    await _appendSkillChatMessage(userId, skillId,
      { time: nowIso(), role: 'assistant', content: errMsg });
    return { ok: false, message: errMsg, error: result.error || '' };
  }

  const extracted = _extractInlineSkillEditMutations(result.text, skillId);
  const fileBlocks = extracted.files;
  const metadataUpdate = extracted.metadataUpdate;
  const sawMutationProtocol = fileBlocks.length > 0
    || _hasSkillMetadataUpdate(metadataUpdate)
    || extracted.externalContainers.length > 0;
  const written: string[] = [];
  const skillsTouchingMd = new Set<string>();
  for (const fb of fileBlocks) {
    if (await writeSkillFileForEdit(skillId, fb.path, fb.content)) {
      written.push(fb.path);
      if (fb.path.toUpperCase() === 'SKILL.MD') {
        skillsTouchingMd.add(skillId);
      }
    } else {
      log.warn(`rejected write skill=${skillId} path=${JSON.stringify(fb.path)}`);
    }
  }
  if (written.length) log.info(`skill=${skillId} wrote ${written.length} file(s): ${JSON.stringify(written)}`);

  // Auto-rename any skill whose SKILL.md `name:` differs from its dir id.
  // Built-in dirs are tracked in git; renaming would orphan history and
  // miss the dual-write — skip for built-ins entirely.
  const renamed: Array<{ oldId: string; newId: string }> = [];
  let currentSkillId = skillId;
  if (skill.source === 'custom') {
    for (const sid of skillsTouchingMd) {
      const newId = await _renameSkillByFrontmatterIfNeeded(sid);
      if (newId && newId !== sid) {
        renamed.push({ oldId: sid, newId });
        if (sid === currentSkillId) currentSkillId = newId;
      }
    }
  }

  let updatedMetadata = false;
  if (_hasSkillMetadataUpdate(metadataUpdate)) {
    const metaRes = await applySkillMetadataForEdit(currentSkillId, metadataUpdate);
    if (metaRes.ok) {
      updatedMetadata = true;
      if (metaRes.written && !written.includes('SKILL.md')) written.push('SKILL.md');
      if (metaRes.skillId !== currentSkillId) {
        renamed.push({ oldId: currentSkillId, newId: metaRes.skillId });
        currentSkillId = metaRes.skillId;
      }
    } else {
      log.warn(`rejected metadata update skill=${currentSkillId}`);
    }
  }
  if (skill.source === 'custom' && (written.length > 0 || updatedMetadata)) {
    clearSkillImportDraftMarkerSync(currentSkillId);
  }

  const assistantText = _skillEditMutationFinalText({
    extracted,
    wroteFiles: written.length > 0,
    updatedMetadata,
    createdSkills: [],
    sawMutationProtocol,
  });

  await _appendSkillChatMessage(userId, skillId,
    { time: nowIso(), role: 'assistant', content: assistantText });

  await saveSkillChatMeta(userId, skillId, { session_id: sessionId });

  return { ok: true, message: assistantText, written, renamed };
}

const MAX_SKILL_PROCESS_ITEMS = 300;

/**
 * Streaming variant of `sendToSkillChat`. Mirrors the event protocol of
 * chats.streamSendToConversation so the renderer can reuse the same event
 * handler for skill edit chats.
 */
export async function* streamSendToSkillChat(
  userId: string, skillId: string, content: string,
  opts: { abortSignal?: AbortSignal; attachments?: string[]; modelText?: string } = {},
): AsyncGenerator<any, void, unknown> {
  const skill = await getSkillForEdit(skillId);
  if (!skill) {
    yield { type: 'error', text: 'skill not found' };
    yield { type: 'done' };
    return;
  }
  if (isMarketplaceSource(skill.source) && !false) {
    yield { type: 'error', text: t('errors.builtin_skill_not_editable') };
    yield { type: 'done' };
    return;
  }

  const meta = await loadSkillChatMeta(userId, skillId);
  const sessionId = meta.session_id || defaultSkillSessionId(skillId);
  const importMetaTargets = _skillChatImportMetaTargets(meta);

  const systemPrompt = await buildSkillEditSystemPrompt(skill);
  const modelText = typeof opts.modelText === 'string' ? opts.modelText.trim() : '';
  const modelContent = modelText || content;
  const attachmentCtx = await buildSkillEditMessageWithAttachments(userId, skillId, modelContent, opts.attachments);

  await _appendSkillChatMessage(userId, skillId,
    {
      time: nowIso(), role: 'user', content,
      ...(modelText ? { model_text: modelText } : {}),
      ...(attachmentCtx.attachmentNames.length ? { attachments: attachmentCtx.attachmentNames, attachment_cid: attachmentCtx.attachmentCid } : {}),
    });

  const { streamChatWithModel } = await import('../model/client');
  let finalText: string | null = null;
  let errMsg: string | null = null;
  // Running assistant delta buffer. When the user aborts mid-stream the IPC
  // layer's `break` triggers `return()` on this generator, which skips the
  // post-loop append — finally has to salvage what's been rendered.
  let streamingText = '';
  const processItems: any[] = [];
  const written: string[] = [];
  // Set when the URL-import chat finalized as an external-package install: the
  // placeholder skill is deleted, so the post-loop persist must be skipped (it
  // would recreate the just-purged chat dir for a skill that no longer exists).
  let installedAsPkg = false;

  try {
    for await (let event of streamChatWithModel({
      userId, message: attachmentCtx.message, sessionId, systemPrompt,
      agentName: 'orkas_chat',
      cacheRetention: 'short',
      readOnlyExtraRoots: [
      ...(skill.dir ? [skill.dir] : []),
      userMarketplaceSkillsDir(getActiveUserId()),
      userSkillsDir(userId),
      // System skills root so a URL-import chat can read `package-installer`
      // before driving `orkas-pkg`; ordinary SkillRegistry no longer loads
      // repo-shipped builtin skills.
      userSystemSkillsDir(userId),
      ...(attachmentCtx.attachmentNames.length ? [chatAttachmentDir(userId, attachmentCtx.attachmentCid)] : []),
    ],
      attachmentMetadata: attachmentCtx.attachmentMetadata,
      ...(attachmentCtx.images.length ? { images: attachmentCtx.images } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    }) as AsyncIterable<any>) {
      const etype = event.type;
      if (etype === 'delta' && typeof event.text === 'string') {
        streamingText += event.text;
        // Skill edit replies are a mixed channel: raw model deltas can contain
        // write protocol before final parsing knows which parts are user prose.
        // Keep mutation output out of the bubble while the turn streams; the
        // final event below repaints a canonical user-visible message.
        continue;
      }
      // Domain events: each `<<<skill-file path=...>>>` block the LLM wrote
      // (or got rejected on) gets a dedicated progress line, so the process
      // rail surfaces these otherwise-invisible disk mutations.
      const synthesizedProgress: string[] = [];
      if (etype === 'final') {
        const raw = event.text || '';
        // External-package import: the LLM already cloned/installed the source
        // via `orkas-pkg` (bash) this turn and emitted the finalize marker.
        // Drop the placeholder custom skill opened for this URL and tell the
        // renderer to switch to the installed package. Install itself never
        // runs here — only this bookkeeping does.
        const pkgMarker = skill.source === 'custom' ? extractSkillAsPackageMarker(raw) : null;
        if (pkgMarker) {
          let placeholderDeleted = false;
          try {
            placeholderDeleted = await deleteCustomSkill(skillId);
          }
          catch (e) { log.warn(`drop placeholder skill failed skill=${skillId}: ${(e as Error).message}`); }
          log.info('url import finalized as external package', {
            skill_id: skillId,
            package_name: pkgMarker.name || '',
            placeholder_deleted: placeholderDeleted,
          });
          installedAsPkg = true;
          const inner = { stream: 'skill_as_package', data: { name: pkgMarker.name || '' } };
          processItems.push({ type: 'event', event: inner });
          yield { type: 'event', event: inner };
          finalText = pkgMarker.cleanText;
          yield { type: 'final', text: pkgMarker.cleanText, written };
          continue;
        }
        const extracted = _extractInlineSkillEditMutations(raw, skillId);
        const directImportMetadataOnly = importMetaTargets.size > 0;
        const fileBlocks = directImportMetadataOnly ? [] : extracted.files;
        const metadataUpdate = directImportMetadataOnly
          ? _importSidecarOnlyMetadata(extracted.metadataUpdate)
          : extracted.metadataUpdate;
        const externalContainers = extracted.externalContainers;
        const sawMutationProtocol = fileBlocks.length > 0
          || extracted.files.length > 0
          || _hasSkillMetadataUpdate(metadataUpdate)
          || externalContainers.length > 0;
        if (extracted.rejectedContainerCount > 0) {
          synthesizedProgress.push(t('process.skill.metadata_rejected'));
        }
        if (directImportMetadataOnly && extracted.files.length > 0) {
          for (const fb of extracted.files) {
            synthesizedProgress.push(t('process.skill.file_rejected', { path: fb.path }));
          }
        }
        // Track which skill ids had their SKILL.md (re)written this turn —
        // those are the ones we should auto-rename to match the new
        // frontmatter `name` field.
        const skillsTouchingMd = new Set<string>();
        let currentSkillId = skillId;
        let updatedMetadata = false;
        let usedImportDraftAsSkill = false;
        for (const fb of fileBlocks) {
          if (await writeSkillFileForEdit(skillId, fb.path, fb.content)) {
            written.push(fb.path);
            synthesizedProgress.push(t('process.skill.file_written', { path: fb.path }));
            if (fb.path.toUpperCase() === 'SKILL.MD') {
              skillsTouchingMd.add(skillId);
            }
          } else {
            log.warn(`rejected write skill=${skillId} path=${JSON.stringify(fb.path)}`);
            synthesizedProgress.push(t('process.skill.file_rejected', { path: fb.path }));
          }
        }
        const createdSkills: Array<{ skill_id: string; name: string; kind?: 'created' | 'updated' }> = [];
        let processedExternalContainers = false;
        if (externalContainers.length) {
          const allowExternalImportDraft = skill.source === 'custom'
            && _isImportDraftForExternalSkillContainersSync(skillId);
          const allowExternalMetadataTargets = skill.source === 'custom' && directImportMetadataOnly;
          if (allowExternalImportDraft) {
            for (const container of externalContainers) {
              const useCurrentDraft = !usedImportDraftAsSkill
                && container.files.some((f) => f.path.toUpperCase() === 'SKILL.MD');
              const targetBefore = currentSkillId;
              const res = useCurrentDraft
                ? await _applySkillContainerEdit(currentSkillId, container.files, container.metadata)
                : await applySkillContainerFromCommander(container);
              if (res.ok && res.skillId) {
                if (useCurrentDraft) {
                  usedImportDraftAsSkill = true;
                  currentSkillId = res.skillId;
                  clearSkillImportDraftMarkerSync(currentSkillId);
                  if (res.skillId !== targetBefore) {
                    const evt = {
                      type: 'event',
                      event: { stream: 'skill_renamed', data: { oldId: targetBefore, newId: res.skillId } },
                    };
                    processItems.push({ type: 'event', event: evt.event });
                    yield evt;
                  }
                }
                createdSkills.push({
                  skill_id: res.skillId,
                  name: res.name || res.skillId,
                  kind: res.kind,
                });
                processedExternalContainers = true;
                if (res.kind === 'updated') clearSkillImportDraftMarkerSync(res.skillId);
                synthesizedProgress.push(t(
                  res.kind === 'updated' ? 'process.skill.import_updated' : 'process.skill.import_created',
                  { name: res.name || res.skillId },
                ));
              } else {
                log.warn(`rejected inline import skill container skill=${skillId}: ${res.error || 'unknown'}`);
                synthesizedProgress.push(t('process.skill.metadata_rejected'));
              }
            }
          } else if (allowExternalMetadataTargets) {
            for (const container of externalContainers) {
              for (const fb of container.files) {
                synthesizedProgress.push(t('process.skill.file_rejected', { path: fb.path }));
              }
              const metadataOnly = _importSidecarOnlyMetadata(container.metadata);
              if (!container.skillId || !importMetaTargets.has(container.skillId) || !_hasSkillMetadataUpdate(metadataOnly)) {
                log.warn(`rejected inline import metadata container skill=${skillId}`);
                synthesizedProgress.push(t('process.skill.metadata_rejected'));
                continue;
              }
              const res = await _applySkillContainerEdit(
                container.skillId,
                [],
                metadataOnly,
                { replaceSidecar: true },
              );
              if (res.ok && res.skillId) {
                createdSkills.push({
                  skill_id: res.skillId,
                  name: res.name || res.skillId,
                  kind: res.kind,
                });
                processedExternalContainers = true;
                clearSkillImportDraftMarkerSync(res.skillId);
                synthesizedProgress.push(t('process.skill.import_updated', { name: res.name || res.skillId }));
              } else {
                log.warn(`rejected inline import metadata update skill=${container.skillId}: ${res.error || 'unknown'}`);
                synthesizedProgress.push(t('process.skill.metadata_rejected'));
              }
            }
          } else {
            log.warn(`rejected ${externalContainers.length} cross-skill container(s) in non-import skill chat skill=${skillId}`);
            synthesizedProgress.push(t('process.skill.metadata_rejected'));
          }
        }
        if (written.length) log.info(`skill=${skillId} wrote ${written.length} file(s): ${JSON.stringify(written)}`);
        // Auto-rename any skill whose SKILL.md `name:` differs from its
        // current dir-id. Yields `skill_renamed` events so the renderer
        // can switch the active edit chat to the new id transparently.
        // Built-in renames are skipped — git-tracked dir, dual-write would
        // also need to rename src and data trees plus migrate user chat dirs.
        if (skill.source === 'custom') {
          for (const sid of skillsTouchingMd) {
            const newId = await _renameSkillByFrontmatterIfNeeded(sid);
            if (newId && newId !== sid) {
              if (sid === currentSkillId) currentSkillId = newId;
              const evt = {
                type: 'event',
                event: { stream: 'skill_renamed', data: { oldId: sid, newId } },
              };
              processItems.push({ type: 'event', event: evt.event });
              yield evt;
            }
          }
        }
        if (_hasSkillMetadataUpdate(metadataUpdate)) {
          const metaRes = await applySkillMetadataForEdit(
            currentSkillId,
            metadataUpdate,
            { replaceSidecar: directImportMetadataOnly },
          );
          if (metaRes.ok) {
            updatedMetadata = true;
            if (metaRes.written && !written.includes('SKILL.md')) {
              written.push('SKILL.md');
              synthesizedProgress.push(t('process.skill.metadata_updated'));
            }
            if (metaRes.skillId !== currentSkillId) {
              const evt = {
                type: 'event',
                event: { stream: 'skill_renamed', data: { oldId: currentSkillId, newId: metaRes.skillId } },
              };
              processItems.push({ type: 'event', event: evt.event });
              yield evt;
              currentSkillId = metaRes.skillId;
            }
          } else {
            log.warn(`rejected metadata update skill=${currentSkillId}`);
            synthesizedProgress.push(t('process.skill.metadata_rejected'));
          }
        }
        if (skill.source === 'custom' && (
          written.length > 0
          || updatedMetadata
          || usedImportDraftAsSkill
          || processedExternalContainers
        )) {
          clearSkillImportDraftMarkerSync(currentSkillId);
        }
        finalText = _skillEditMutationFinalText({
          extracted,
          wroteFiles: written.length > 0,
          updatedMetadata,
          createdSkills,
          sawMutationProtocol,
        });
        event = { type: 'final', text: finalText, written, ...(createdSkills.length ? { created: createdSkills } : {}) };
      } else if (etype === 'error') {
        errMsg = `Model response failed: ${event.text || 'unknown'}`;
      }

      for (const text of synthesizedProgress) {
        if (processItems.length < MAX_SKILL_PROCESS_ITEMS) {
          processItems.push({ type: 'progress', text });
        }
        yield { type: 'progress', text };
      }

      if (processItems.length < MAX_SKILL_PROCESS_ITEMS) {
        if (etype === 'progress' && event.text) {
          processItems.push({ type: 'progress', text: event.text });
        } else if (etype === 'event') {
          const inner = event.event || {};
          if (inner.stream && inner.stream !== 'assistant') {
            processItems.push({ type: 'event', event: inner });
          }
        }
      }
      yield event;
    }

  } catch (err) {
    log.error('stream failed:', err);
    const msg = (err as Error).message || String(err);
    errMsg = `Model response failed: ${msg}`;
    yield { type: 'error', text: msg };
  } finally {
    // Must live in finally: on user abort the IPC layer breaks out of the
    // for-await, which triggers `return()` on this generator — bypassing any
    // append placed after the loop. Keeping it here covers normal finish,
    // caught errors, and abort-driven returns alike.
    const saved = processItems.length ? processItems : null;
    try {
      if (installedAsPkg) {
        // Placeholder skill (and its chat dir) was deleted after resolving the
        // import as a package. Persisting here would recreate an orphan chat;
        // the live stream already rendered the reply and the renderer switches
        // to the package result state.
      } else if (finalText !== null) {
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content: finalText, ...(saved ? { process: saved } : {}) });
        await saveSkillChatMeta(userId, skillId, { session_id: sessionId });
      } else if (errMsg) {
        const partial = _visibleInlineSkillEditText(streamingText, skillId).trim();
        const content = partial ? `${partial}\n\n${errMsg}` : errMsg;
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      } else if (streamingText.trim() || processItems.length) {
        const partial = _visibleInlineSkillEditText(streamingText, skillId).trim();
        const content = partial
          ? `${partial}\n\n(reply interrupted)`
          : '(reply interrupted)';
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      }
    } catch (e) {
      log.warn(`persist skill chat assistant failed skill=${skillId}: ${(e as Error).message}`);
    }
    if (importMetaTargets.size > 0 && !installedAsPkg) {
      try {
        await _clearSkillChatImportMetaTargets(userId, skillId, sessionId);
      } catch (e) {
        log.warn(`clear import metadata targets failed skill=${skillId}: ${(e as Error).message}`);
      }
    }
  }
}
