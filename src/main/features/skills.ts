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
 *   builtin — data/shared/skills/builtin/<id>/ (seeded from PC/builtin/skills/)
 *   custom  — data/shared/skills/custom/<id>/  (user-created, editable)
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
  userMarketplaceSkillsDir,
} from '../paths';
import { evictSession } from '../model/core-agent/session-store';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { t, buildLanguageDirective } from '../i18n';

// Custom skills live per-user at `<uid>/cloud/skills/`. Resolved lazily
// from the active uid.
function CUSTOM_SKILLS_DIR(): string {
  return userSkillsDir(getActiveUserId());
}

const log = createLogger('skills');
import { prompts } from '../prompts/loader';
import {
  nowIso, readJson, writeJson, writeTextAtomicSync,
  appendJsonlAtomic, invalidateLineCount, readJsonl,
} from '../storage';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { readDisabledSets, setSkillEnabled } from './component_enabled';
import { findOuterTagRanges } from '../util/markdown-prose-code';
import {
  validateSkillFile,
  ValidationReport as QualityReport,
} from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';

// Names hidden from the in-app skill source-tree view. `_install.json` (marketplace install
// version pin) and `_cache.json` (marketplace cache LRU bookkeeping) are tooling sidecars,
// not authored content — surfacing them confuses users and looks like noise in the file list.
const SKILL_TREE_IGNORE: ReadonlySet<string> = new Set([
  '.DS_Store', '__pycache__', '.git', 'node_modules',
  '_install.json', '_cache.json',
]);
// Starts with a letter, then letters/digits/_/-; single spaces are allowed
// between word groups (no leading/trailing/consecutive spaces).
const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+)*$/;
// Block syntax: `<<<skill-file path=<rel> ... >>>`. Cross-skill writes (the
// old `skill=<id>` attribute) are no longer supported — every skill is
// self-contained. Attribute order is flexible.
const SKILL_FILE_BLOCK_RE = /<<<skill-file((?:\s+\w+=\S+)+)\s*\n(.*?)\n>>>/gs;

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

export type SkillSource = 'builtin' | 'custom';

export interface SkillListing {
  id: string;
  name: string;
  source: SkillSource;
  description_zh: string;
  description_en: string;
  /** Marketplace category code (`education` / `ecommerce` / `rnd` / …). Empty string when
   *  the SKILL.md frontmatter doesn't set one — UI treats that as "uncategorized". */
  category: string;
  /** **Computed at load time, not persisted.** Filled by `listSkills` from
   *  `features/component_enabled.ts`. Defaults to true unless the user has
   *  explicitly disabled the skill. */
  enabled: boolean;
  /** Author uid for `source==='builtin'` (marketplace-installed) skills — read from
   *  `_install.json`. `"0"` = official-platform marker; empty for `source==='custom'`. Renderer
   *  uses this to show the author badge (label `marketplace.author_platform` / `_user`). */
  create_uid?: string;
  /** Marketplace install version for `source==='builtin'`. Read from `_install.json` so the
   *  skills-tab card can render a `v1.0.0` chip. Undefined for custom skills. */
  version?: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
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
  source: SkillSource;
  dir: string;
}

/** Migrate legacy single-`description` frontmatter into the bilingual pair.
 *  Mirrors the logic in core-agent's SkillLoader and main's normalizeAgent —
 *  CJK ideograph in legacy → `_zh`, otherwise → `_en`. Explicit fields win. */
function migrateDescriptionPair(meta: { description?: string; description_zh?: string; description_en?: string }):
  { description_zh: string; description_en: string } {
  const legacy = (meta.description || '').trim();
  const zh = (meta.description_zh || '').trim();
  const en = (meta.description_en || '').trim();
  const hasChinese = /[一-鿿]/.test(legacy);
  return {
    description_zh: zh || (legacy && hasChinese ? legacy : ''),
    description_en: en || (legacy && !hasChinese ? legacy : ''),
  };
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
  /** Marketplace category code; required for skills published to the marketplace, optional for
   *  user-created skills (defaults to empty string / "uncategorized" in `listSkills` output). */
  category?: string;
  [key: string]: string | string[] | undefined;
}

export interface SkillChatMeta { session_id?: string; [k: string]: unknown }

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

function skillBaseDir(source: SkillSource): string {
  return source === 'custom' ? CUSTOM_SKILLS_DIR() : userMarketplaceSkillsDir(getActiveUserId());
}

// Module-level cache for `listSkills`.
interface SkillListCache { stamp: string; data: SkillListing[] }
let _skillListCache: SkillListCache | null = null;

function _invalidateSkillListCache(): void {
  _skillListCache = null;
  // Sync engine dirty signal (lazy-require — stripped in OrkasOpen). Mirrors the pattern in
  // `agents.ts::_invalidateAgentListCache`: every cache-invalidate is also a disk-mutation
  // point, co-locating keeps wiring tight.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = require('./sync') as { markDirty?: (domain: string, relPath: string) => void };
    sync.markDirty?.('skills', 'cloud/skills');
  } catch { /* features/sync stripped */ }
}

/** Internal cache invalidator + core-agent registry invalidator. Exported for
 *  the dev-only `skills_dev` module so its dual-write path goes through the
 *  same cache-busting chain as `writeCustomSkillFile`. */
export function invalidateSkillCachesForEdit(): void {
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
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
 *  was found. Custom is checked first (matches the loader precedence). */
export async function getSkillForEdit(skillId: string): Promise<SkillForEdit | null> {
  if (!skillId) return null;
  const sources: Array<[SkillSource, string]> = [
    ['custom', CUSTOM_SKILLS_DIR()],
    ['builtin', userMarketplaceSkillsDir(getActiveUserId())],
  ];
  for (const [source, base] of sources) {
    const d = path.join(base, skillId);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    let name = skillId;
    let descPair = { description_zh: '', description_en: '' };
    let category = '';
    const md = path.join(d, 'SKILL.md');
    if (fs.existsSync(md)) {
      try {
        const { meta } = splitSkillMd(fs.readFileSync(md, 'utf8'));
        name = meta.name || skillId;
        descPair = migrateDescriptionPair(meta as any);
        category = (meta.category as string) || '';
      } catch { /* ignore */ }
    }
    return { id: skillId, name, ...descPair, category, source, dir: d };
  }
  return null;
}

function _skillDirStamp(): string {
  let stamp = '';
  for (const d of [CUSTOM_SKILLS_DIR(), userMarketplaceSkillsDir(getActiveUserId())]) {
    try { stamp += `${d}:${fs.statSync(d).mtimeMs};`; }
    catch { stamp += `${d}:0;`; }
  }
  return stamp;
}

export async function listSkills(): Promise<SkillListing[]> {
  const stamp = _skillDirStamp();
  if (_skillListCache && _skillListCache.stamp === stamp) return _skillListCache.data;

  const out: SkillListing[] = [];
  const seen = new Set<string>();
  // Custom first so it wins on id collision (matches openclaw symlink rule).
  const sources: Array<[SkillSource, string]> = [['custom', CUSTOM_SKILLS_DIR()], ['builtin', userMarketplaceSkillsDir(getActiveUserId())]];
  for (const [source, baseDir] of sources) {
    if (!fs.existsSync(baseDir)) continue;
    const names = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      if (seen.has(name)) {
        if (source === 'builtin') {
          log.warn(`id conflict: custom and builtin both define "${name}" — custom wins, rename one`);
        }
        continue;
      }
      seen.add(name);
      const skillMd = path.join(baseDir, name, 'SKILL.md');
      let displayName = name;
      let descPair = { description_zh: '', description_en: '' };
      let category = '';
      let createUid: string | undefined;
      let version: string | undefined;
      if (fs.existsSync(skillMd)) {
        try {
          const meta = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf8'));
          descPair = migrateDescriptionPair(meta as any);
          displayName = meta.name as string || name;
          category = (meta.category as string) || '';
        } catch { /* ignore */ }
      }
      // Marketplace-installed skills carry `_install.json` with `create_uid` + `version` —
      // read it so the UI can show the author badge + version chips without an extra IPC. Custom skills skip.
      if (source === 'builtin') {
        try {
          const metaFile = path.join(baseDir, name, '_install.json');
          if (fs.existsSync(metaFile)) {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (meta && typeof meta.create_uid === 'string') createUid = meta.create_uid;
            if (meta && typeof meta.version === 'string') version = meta.version;
          }
        } catch { /* corrupt _install.json — leave fields undefined */ }
      }
      out.push({ id: name, name: displayName, source, ...descPair, category, enabled: true, create_uid: createUid, version });
    }
  }
  _skillListCache = { stamp, data: out };
  // Overlay per-user enabled overrides outside the cache (same pattern as
  // listAgents). Cheap per-call read so a toggle takes effect immediately
  // without having to bump dir mtime.
  const { skills: disabledSkillIds } = readDisabledSets(getActiveUserId());
  return out.map((s) => ({ ...s, enabled: !disabledSkillIds.has(s.id) }));
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
  source: SkillSource, skillId: string, filepath = 'SKILL.md',
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
  source: SkillSource, skillId: string,
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
      if (e.name.endsWith('.pyc')) continue;
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
  if (name.length > 64) return t('skills.errors.name_too_long');
  if (!SKILL_NAME_RE.test(name)) {
    return t('skills.errors.name_invalid');
  }
  return '';
}

// Skill-id shape check used by IPC handlers. Accepts EITHER a user-typed skill name
// (SKILL_NAME_RE — letter-led, spaces between words) for custom skills, OR a 12-hex
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
): string {
  const cleanName = (name || '').replace(/\n/g, ' ').replace(/"/g, '\\"');
  const sanitize = (s: string) => (s || '').replace(/\n/g, ' ').replace(/"/g, '\\"');
  // Accept either a legacy single string (auto-routed by Chinese-character
  // heuristic) or an explicit `{zh, en}` pair. Always emit both fields so
  // SKILL.md frontmatter is canonical bilingual after this function runs.
  let zh = '', en = '';
  if (typeof description === 'string') {
    const trimmed = (description || '').trim();
    const isChinese = /[一-鿿]/.test(trimmed);
    if (trimmed && isChinese) zh = trimmed; else if (trimmed) en = trimmed;
  } else if (description && typeof description === 'object') {
    zh = (description.zh || '').trim();
    en = (description.en || '').trim();
  }
  const cleanZh = sanitize(zh);
  const cleanEn = sanitize(en);
  const cleanCategory = sanitize(category || '');
  const trimmedBody = body.replace(/^\n+/, '');
  // Emit `category` only when explicitly provided — user-created skills without a category yet
  // are perfectly valid; the field becomes mandatory only at marketplace upload time.
  const categoryLine = cleanCategory ? `\ncategory: "${cleanCategory}"` : '';
  return `---\nname: "${cleanName}"\ndescription_zh: "${cleanZh}"\ndescription_en: "${cleanEn}"${categoryLine}\n---\n\n${trimmedBody}`;
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

export async function getCustomSkill(skillId: string): Promise<CustomSkill | null> {
  const d = customSkillDir(skillId);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return null;
  const md = path.join(d, 'SKILL.md');
  let name = skillId;
  let descPair = { description_zh: '', description_en: '' };
  let category = '';
  if (fs.existsSync(md)) {
    try {
      const { meta } = splitSkillMd(fs.readFileSync(md, 'utf8'));
      name = meta.name || skillId;
      descPair = migrateDescriptionPair(meta as any);
      category = (meta.category as string) || '';
    } catch { /* ignore */ }
  }
  return { id: skillId, name, ...descPair, category, source: 'custom', dir: d };
}

export async function listCustomSkillFiles(skillId: string): Promise<SkillFileInfo[]> {
  const d = path.resolve(customSkillDir(skillId));
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
  writeTextAtomicSync(path.join(d, 'SKILL.md'), skillMdContent(name, description, '', category));
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
  // Resolve new bilingual description: explicit `description_zh` /
  // `description_en` updates win; legacy `description` routes via heuristic;
  // otherwise carry over the persisted pair (re-parsed from frontmatter).
  const persisted = migrateDescriptionPair(meta as any);
  const explicitZh = Object.prototype.hasOwnProperty.call(updates, 'description_zh');
  const explicitEn = Object.prototype.hasOwnProperty.call(updates, 'description_en');
  const explicitLegacy = Object.prototype.hasOwnProperty.call(updates, 'description');
  let newZh = explicitZh ? String(updates.description_zh || '') : persisted.description_zh;
  let newEn = explicitEn ? String(updates.description_en || '') : persisted.description_en;
  if (explicitLegacy) {
    const legacy = String(updates.description || '').trim();
    const isChinese = /[一-鿿]/.test(legacy);
    if (legacy && isChinese && !explicitZh) newZh = legacy;
    if (legacy && !isChinese && !explicitEn) newEn = legacy;
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

  writeTextAtomicSync(md, skillMdContent(newName, { zh: newZh, en: newEn }, body, newCategory));
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
  // Foreign skill-platform metadata (clawhub/etc. publish manifests with
  // ownerId/slug/version/publishedAt — irrelevant to this app and shows
  // up as "header noise" in the UI).
  '_meta.json',
  // Marketplace sidecars: `_install.json` (version pin written by install / reconcile —
  // meaningless once a platform skill is imported as custom) and `_cache.json` (LRU bookkeeping
  // for the detail-page cache). Both are tooling internal — must never propagate when a user
  // imports a skill dir or when dev re-uploads a platform skill (see also marketplace_dev::
  // SKIP_NAMES).
  '_install.json', '_cache.json',
  // npm packaging artefacts — skill dirs are forbidden from carrying their
  // own node_modules or package.json (see core conventions); strip the
  // sidecars too so partial copies don't linger.
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

const IMPORT_MAX_FILES = 100;
const IMPORT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

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

  // Home-dir root exactly — would trigger the 50 MiB cap only after
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

function _walkImportSource(root: string): { files: { src: string; rel: string; size: number }[]; totalBytes: number } {
  const files: { src: string; rel: string; size: number }[] = [];
  let totalBytes = 0;

  function walk(dir: string, relBase: string): void {
    if (files.length > IMPORT_MAX_FILES) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IMPORT_FILTER_NAMES.has(e.name)) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // skip symlinks defensively
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        files.push({ src: full, rel, size });
        totalBytes += size;
        if (files.length > IMPORT_MAX_FILES || totalBytes > IMPORT_MAX_BYTES) return;
      }
    }
  }
  walk(root, '');
  return { files, totalBytes };
}

export interface ImportResult {
  ok: boolean;
  skill?: CustomSkill;
  seedMessage?: string;
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

/** Create a skill from a URL. Orkas just seeds the skill + seed message;
 *  the LLM (in skill edit chat) does the actual fetching/parsing. */
export async function createFromUrl(
  name: string | null,
  description: string | null,
  url: string,
): Promise<ImportResult> {
  const trimmedUrl = (url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return { ok: false, error: t('skills.errors.url_scheme') };
  }

  const effectiveName = (name || '').trim() || _defaultSkillNameFromUrl(trimmedUrl);
  const effectiveDesc = (description || '').trim() || t('skills.import.default_desc_url', { url: trimmedUrl });

  const created = await createCustomSkill(effectiveName, effectiveDesc);
  if (!created) return { ok: false, error: t('skills.errors.create_failed') };

  return {
    ok: true,
    skill: created,
    seedMessage: t('skills.import.seed_url', { url: trimmedUrl }),
  };
}

/** Create a skill from a local folder. Copies files into the skill dir,
 *  then seeds the edit chat so the LLM normalises to Orkas's conventions. */
export async function createFromDir(
  name: string | null,
  description: string | null,
  srcDir: string,
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
  const { files, totalBytes } = _walkImportSource(realSrc);
  if (files.length === 0) return { ok: false, error: t('skills.errors.dir_empty') };
  if (files.length > IMPORT_MAX_FILES) {
    return { ok: false, error: t('skills.errors.too_many_files', { count: files.length, max: IMPORT_MAX_FILES }) };
  }
  if (totalBytes > IMPORT_MAX_BYTES) {
    return { ok: false, error: t('skills.errors.too_large', { mb: (totalBytes / 1024 / 1024).toFixed(1) }) };
  }

  const effectiveName = (name || '').trim() || _defaultSkillNameFromDir(realSrc);
  const effectiveDesc = (description || '').trim() || t('skills.import.default_desc_dir');

  const created = await createCustomSkill(effectiveName, effectiveDesc);
  if (!created) return { ok: false, error: t('skills.errors.create_failed') };

  const skillDir = customSkillDir(created.id);
  try {
    for (const { src, rel } of files) {
      // Skip the SKILL.md we just wrote — the LLM should rewrite it, but if
      // the imported dir also has one, prefer the imported one (overwrite is
      // fine since createCustomSkill's SKILL.md is boilerplate).
      const dst = path.join(skillDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  } catch (err) {
    log.warn(`import-dir copy failed skill=${created.id}: ${(err as Error).message}`);
    // Best-effort rollback: delete partially-copied skill
    try { await deleteCustomSkill(created.id); } catch { /* ignore */ }
    return { ok: false, error: t('skills.errors.copy_failed', { message: (err as Error).message }) };
  }

  // SKILL.md may have been overwritten by the import; drop cache either way.
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });

  log.info(`created-from-dir name=${created.id} files=${files.length} bytes=${totalBytes}`);

  return {
    ok: true,
    skill: created,
    seedMessage: t('skills.import.seed_dir', { path: realSrc }),
  };
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
  const report = validateSkillFile({ relpath, content });
  // Persist best-effort regardless of outcome — the report's also the input
  // for the future evolution / reflection signal stream.
  void persistQualityReport({
    uid: getActiveUserId(), kind: 'skill', id: skillId, report,
  });
  if (!report.ok) {
    return { ok: false, report };
  }
  const written = _writeSkillFileAt(d, relpath, content, /* invalidateOnSkillMd */ true);
  if (!written) return { ok: false, report, reason: 'invalid_path' };
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
  const d = path.resolve(customSkillDir(skillId));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return false;
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
  const target = path.resolve(d, rel);
  try {
    const relative = path.relative(d, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  } catch { return false; }
  writeTextAtomicSync(target, content);
  // SKILL.md change → drop list cache + core-agent skill registry cache.
  // SkillLoader's mtime-keyed cache uses the parent dir's mtime, but POSIX
  // doesn't bump dir mtime on file content changes — so without explicit
  // invalidation the system prompt keeps showing stale skill descriptions
  // until the next app restart.
  if (rel.toUpperCase() === 'SKILL.MD') {
    _invalidateSkillListCache();
    invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
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
  const customDir = customSkillDir(skillId);
  if (fs.existsSync(customDir) && fs.statSync(customDir).isDirectory()) {
    return writeCustomSkillFileChecked(skillId, relpath, content);
  }
  if (isBuiltinSkill(skillId) && false) {
    // Built-in (platform-installed) skill edit. Validate first; defer the
    // actual write to skills_dev (which knows the target install dir).
    const report = validateSkillFile({ relpath, content });
    void persistQualityReport({
      uid: getActiveUserId(), kind: 'skill', id: skillId, report,
    });
    if (!report.ok) return { ok: false, report };
    try {
      const dev = await import('./skills_dev');
      const written = await dev.writeBuiltinSkillFile(skillId, relpath, content);
      return written ? { ok: true, report } : { ok: false, report, reason: 'invalid_path' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
        log.warn(`skills_dev load failed: ${(err as Error).message}`);
      }
      return { ok: false };
    }
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

export async function getSkillChatMessages(userId: string, skillId: string, limit = 500): Promise<any[]> {
  return readJsonl(skillChatMsgsPath(userId, skillId), limit);
}

async function _appendSkillChatMessage(userId: string, skillId: string, record: any): Promise<void> {
  const file = skillChatMsgsPath(userId, skillId);
  await appendJsonlAtomic(file, record);
}

export async function clearSkillChat(userId: string, skillId: string): Promise<boolean> {
  if (!fs.existsSync(customSkillDir(skillId))) return false;
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
}

function _parseSkillContainer(inner: string): SkillContainerExtracted {
  const idM = inner.match(SKILL_ID_RE);
  const skillId = idM ? idM[1].trim() : '';
  const { files } = extractSkillFileBlocks(inner);
  return { ...(skillId ? { skillId } : {}), files };
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

/** Apply a parsed `<skill>` container from commander. Routes to create vs
 *  edit by `container.skillId`. Built-in skills are read-only here — same
 *  policy as the per-skill edit chat outside dev mode. Best-effort writes
 *  per-file: a single rejected path doesn't roll back earlier successes
 *  (matches `streamSendToSkillChat`'s file-by-file outcome). */
export async function applySkillContainerFromCommander(
  container: SkillContainerExtracted,
): Promise<SkillContainerResult> {
  if (!container.files.length && !container.skillId) {
    return { ok: false, error: t('skills.errors.container_empty') };
  }
  if (container.skillId) {
    return _applySkillContainerEdit(container.skillId, container.files);
  }
  return _applySkillContainerCreate(container.files);
}

async function _applySkillContainerCreate(files: SkillFileBlock[]): Promise<SkillContainerResult> {
  // SKILL.md is mandatory in the create branch — that's where the skill id
  // (frontmatter `name`) and bilingual descriptions are sourced from.
  const skillMd = files.find((f) => f.path.toUpperCase() === 'SKILL.MD');
  if (!skillMd) return { ok: false, error: t('skills.errors.create_missing_skill_md') };
  const { meta } = splitSkillMd(skillMd.content || '');
  const name = (meta.name || '').trim();
  if (!name) return { ok: false, error: t('skills.errors.create_missing_name') };
  const validateErr = validateSkillName(name);
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
  const created = await createCustomSkill(name, seedDescription);
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

async function _applySkillContainerEdit(skillId: string, files: SkillFileBlock[]): Promise<SkillContainerResult> {
  const skill = await getSkillForEdit(skillId);
  if (!skill) return { ok: false, error: t('skills.errors.skill_not_found', { id: skillId }) };
  // Built-in skills are dev-mode-only via the detail-panel edit chat; the
  // commander flow always rejects regardless of dev mode (mirrors the agent
  // edit policy at `bus.ts` post-stream parsing).
  if (skill.source !== 'custom') {
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
  // Auto-rename when SKILL.md frontmatter `name` differs from the dir id —
  // same hook as the per-skill edit chat (`streamSendToSkillChat`).
  let resolvedId = skillId;
  if (touchedSkillMd) {
    const newId = await _renameSkillByFrontmatterIfNeeded(skillId);
    if (newId && newId !== skillId) resolvedId = newId;
  }
  const post = await getSkillForEdit(resolvedId);
  if (written.length) log.info(`commander updated skill=${skillId}${resolvedId !== skillId ? ` -> ${resolvedId}` : ''} files=${written.length}`);
  return {
    ok: true,
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
  dir?: string;
}): Promise<string> {
  const files = await listCustomSkillFiles(skill.id || '');
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
  return `${body}\n\n---\n\n${buildLanguageDirective()}`;
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

export async function sendToSkillChat(userId: string, skillId: string, content: string): Promise<SkillChatResult> {
  const skill = await getCustomSkill(skillId);
  if (!skill) return { ok: false, error: 'skill not found' };

  const meta = await loadSkillChatMeta(userId, skillId);
  const sessionId = meta.session_id || defaultSkillSessionId(skillId);

  const systemPrompt = await buildSkillEditSystemPrompt(skill);

  await _appendSkillChatMessage(userId, skillId,
    { time: nowIso(), role: 'user', content });

  const { chatWithModel } = require('../model/client');
  const result = await chatWithModel({
    userId, message: content, sessionId, systemPrompt,
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
    ],
  });

  if (!result.ok) {
    const errMsg = `Model response failed: ${result.error || 'unknown'}`;
    await _appendSkillChatMessage(userId, skillId,
      { time: nowIso(), role: 'assistant', content: errMsg });
    return { ok: false, message: errMsg, error: result.error || '' };
  }

  const { cleanText, files: fileBlocks } = extractSkillFileBlocks(result.text);
  const written: string[] = [];
  const skillsTouchingMd = new Set<string>();
  for (const fb of fileBlocks) {
    if (writeCustomSkillFile(skillId, fb.path, fb.content)) {
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
  // Non-streaming caller has no event channel; the rename is silent — the
  // returned `renamed` array surfaces it for the caller to log / inform.
  const renamed: Array<{ oldId: string; newId: string }> = [];
  for (const sid of skillsTouchingMd) {
    const newId = await _renameSkillByFrontmatterIfNeeded(sid);
    if (newId && newId !== sid) renamed.push({ oldId: sid, newId });
  }

  await _appendSkillChatMessage(userId, skillId,
    { time: nowIso(), role: 'assistant', content: cleanText });

  await saveSkillChatMeta(userId, skillId, { session_id: sessionId });

  return { ok: true, message: cleanText, written, renamed };
}

const MAX_SKILL_PROCESS_ITEMS = 300;

/**
 * Streaming variant of `sendToSkillChat`. Mirrors the event protocol of
 * chats.streamSendToConversation so the renderer can reuse the same event
 * handler for skill edit chats.
 */
export async function* streamSendToSkillChat(
  userId: string, skillId: string, content: string,
  opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<any, void, unknown> {
  const skill = await getCustomSkill(skillId);
  if (!skill) {
    yield { type: 'error', text: 'skill not found' };
    yield { type: 'done' };
    return;
  }

  const meta = await loadSkillChatMeta(userId, skillId);
  const sessionId = meta.session_id || defaultSkillSessionId(skillId);

  const systemPrompt = await buildSkillEditSystemPrompt(skill);

  await _appendSkillChatMessage(userId, skillId,
    { time: nowIso(), role: 'user', content });

  const { streamChatWithModel } = await import('../model/client');
  let finalText: string | null = null;
  let errMsg: string | null = null;
  // Running assistant delta buffer. When the user aborts mid-stream the IPC
  // layer's `break` triggers `return()` on this generator, which skips the
  // post-loop append — finally has to salvage what's been rendered.
  let streamingText = '';
  const processItems: any[] = [];
  const written: string[] = [];

  try {
    for await (let event of streamChatWithModel({
      userId, message: content, sessionId, systemPrompt,
      agentName: 'orkas_chat',
      cacheRetention: 'short',
      readOnlyExtraRoots: [
      ...(skill.dir ? [skill.dir] : []),
      userMarketplaceSkillsDir(getActiveUserId()),
      userSkillsDir(userId),
    ],
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    }) as AsyncIterable<any>) {
      const etype = event.type;
      if (etype === 'delta' && typeof event.text === 'string') {
        streamingText += event.text;
      }
      // Domain events: each `<<<skill-file path=...>>>` block the LLM wrote
      // (or got rejected on) gets a dedicated progress line, so the process
      // rail surfaces these otherwise-invisible disk mutations.
      const synthesizedProgress: string[] = [];
      if (etype === 'final') {
        const raw = event.text || '';
        const { cleanText, files: fileBlocks } = extractSkillFileBlocks(raw);
        // Track which skill ids had their SKILL.md (re)written this turn —
        // those are the ones we should auto-rename to match the new
        // frontmatter `name` field.
        const skillsTouchingMd = new Set<string>();
        for (const fb of fileBlocks) {
          if (writeCustomSkillFile(skillId, fb.path, fb.content)) {
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
        if (written.length) log.info(`skill=${skillId} wrote ${written.length} file(s): ${JSON.stringify(written)}`);
        // Auto-rename any skill whose SKILL.md `name:` differs from its
        // current dir-id. Yields `skill_renamed` events so the renderer
        // can switch the active edit chat to the new id transparently.
        for (const sid of skillsTouchingMd) {
          const newId = await _renameSkillByFrontmatterIfNeeded(sid);
          if (newId && newId !== sid) {
            const evt = {
              type: 'event',
              event: { stream: 'skill_renamed', data: { oldId: sid, newId } },
            };
            processItems.push({ type: 'event', event: evt.event });
            yield evt;
          }
        }
        finalText = cleanText;
        event = { type: 'final', text: cleanText, written };
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
      if (finalText !== null) {
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content: finalText, ...(saved ? { process: saved } : {}) });
        await saveSkillChatMeta(userId, skillId, { session_id: sessionId });
      } else if (errMsg) {
        const partial = streamingText.trim();
        const content = partial ? `${streamingText}\n\n${errMsg}` : errMsg;
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      } else if (streamingText.trim() || processItems.length) {
        const content = streamingText.trim()
          ? `${streamingText}\n\n(reply interrupted)`
          : '(reply interrupted)';
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      }
    } catch (e) {
      log.warn(`persist skill chat assistant failed skill=${skillId}: ${(e as Error).message}`);
    }
  }
}
