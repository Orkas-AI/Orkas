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
  BUILTIN_SKILLS_DIR, BUILTIN_SKILLS_SOURCE,
  userSkillsDir, userSkillChatDir, userSessionFile, WS_ROOT,
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
import * as search from './search';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { readDisabledSets, setSkillEnabled } from './component_enabled';

const SKILL_TREE_IGNORE: ReadonlySet<string> = new Set(['.DS_Store', '__pycache__', '.git', 'node_modules']);
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
  /** **Computed at load time, not persisted.** Filled by `listSkills` from
   *  `features/component_enabled.ts`. Defaults to true unless the user has
   *  explicitly disabled the skill. */
  enabled: boolean;
}

export interface CustomSkill {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  source: 'custom';
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
  [key: string]: string | string[] | undefined;
}

export interface SkillChatMeta { session_id?: string; [k: string]: unknown }

// ═══════════════════════════════════════════════════════════════════════
// 1. Builtin skill sync (startup)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Stable content hash of every file under `root`. Mirrors the Python
 * `_hash_tree`: relative posix paths + NUL + bytes + newline per file,
 * folded into a sha256. Empty / missing tree → ''.
 */
export function hashTree(root: string): string {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return '';
  const h = crypto.createHash('sha256');

  function walk(dir: string, relBase = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const parts = rel.split('/');
      if (parts.some((p) => SKILL_TREE_IGNORE.has(p) || p.startsWith('.'))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        h.update(rel, 'utf8');
        h.update(Buffer.from([0]));
        try { h.update(fs.readFileSync(full)); } catch { /* skip */ }
        h.update(Buffer.from([0x0a]));
      }
    }
  }
  walk(root);
  return h.digest('hex');
}

/**
 * Refresh `data/shared/skills/builtin/` from `PC/builtin/skills/`.
 * Returns true if any change was made (caller should re-register + invalidate).
 */
export function syncBuiltinSkills(): boolean {
  fs.mkdirSync(BUILTIN_SKILLS_DIR, { recursive: true });
  if (!fs.existsSync(BUILTIN_SKILLS_SOURCE)) {
    log.info(`source dir missing: ${BUILTIN_SKILLS_SOURCE}; skipping`);
    return false;
  }

  const srcNames = new Set(fs.readdirSync(BUILTIN_SKILLS_SOURCE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name));
  const dstNames = new Set(fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name));

  let changed = false;

  // Removed upstream → drop local copy
  for (const stale of [...dstNames].filter((n) => !srcNames.has(n)).sort()) {
    try {
      fs.rmSync(path.join(BUILTIN_SKILLS_DIR, stale), { recursive: true, force: true });
      log.info(`removed stale ${stale}`);
      changed = true;
    } catch (err) {
      log.warn(`rm ${stale} failed: ${(err as Error).message}`);
    }
  }

  // Content-diff sync
  for (const name of [...srcNames].sort()) {
    const src = path.join(BUILTIN_SKILLS_SOURCE, name);
    const dst = path.join(BUILTIN_SKILLS_DIR, name);
    const srcHash = hashTree(src);
    const dstHash = fs.existsSync(dst) && fs.statSync(dst).isDirectory() ? hashTree(dst) : '';
    if (srcHash === dstHash) continue;
    if (fs.existsSync(dst)) {
      try { fs.rmSync(dst, { recursive: true, force: true }); }
      catch (err) { log.warn(`rm ${dst} failed: ${(err as Error).message}`); continue; }
    }
    try {
      fs.cpSync(src, dst, { recursive: true });
      log.info(`synced ${name}`);
      changed = true;
    } catch (err) {
      log.warn(`copy ${name} failed: ${(err as Error).message}`);
    }
  }

  return changed;
}

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
  return source === 'custom' ? CUSTOM_SKILLS_DIR() : BUILTIN_SKILLS_DIR;
}

// Module-level cache for `listSkills`.
interface SkillListCache { stamp: string; data: SkillListing[] }
let _skillListCache: SkillListCache | null = null;

function _invalidateSkillListCache(): void { _skillListCache = null; }

function _skillDirStamp(): string {
  let stamp = '';
  for (const d of [CUSTOM_SKILLS_DIR(), BUILTIN_SKILLS_DIR]) {
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
  const sources: Array<[SkillSource, string]> = [['custom', CUSTOM_SKILLS_DIR()], ['builtin', BUILTIN_SKILLS_DIR]];
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
      if (fs.existsSync(skillMd)) {
        try {
          const meta = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf8'));
          descPair = migrateDescriptionPair(meta as any);
          displayName = meta.name as string || name;
        } catch { /* ignore */ }
      }
      out.push({ id: name, name: displayName, source, ...descPair, enabled: true });
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

// Skill-id shape check used by IPC handlers. Accepts the same alphabet as
// validateSkillName (spaces between words OK) so space-named skills can be
// opened / updated.
export function isValidSkillId(id: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && SKILL_NAME_RE.test(id);
}

function customSkillDir(skillId: string): string {
  return path.join(CUSTOM_SKILLS_DIR(), skillId);
}

export function skillMdContent(
  name: string,
  description: string | { zh?: string; en?: string },
  body = '',
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
  const trimmedBody = body.replace(/^\n+/, '');
  return `---\nname: "${cleanName}"\ndescription_zh: "${cleanZh}"\ndescription_en: "${cleanEn}"\n---\n\n${trimmedBody}`;
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
  if (fs.existsSync(md)) {
    try {
      const { meta } = splitSkillMd(fs.readFileSync(md, 'utf8'));
      name = meta.name || skillId;
      descPair = migrateDescriptionPair(meta as any);
    } catch { /* ignore */ }
  }
  return { id: skillId, name, ...descPair, source: 'custom', dir: d };
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

export async function createCustomSkill(name: string, description: string): Promise<CustomSkill | null> {
  const err = validateSkillName(name);
  if (err) throw new Error(err);
  const d = customSkillDir(name);
  if (fs.existsSync(d)) throw new Error(t('skills.errors.skill_exists', { name }));
  // Custom skills would silently shadow a same-named builtin in the
  // skill-registry first-wins resolution. Reject the create so the user
  // renames up front.
  if (fs.existsSync(path.join(BUILTIN_SKILLS_DIR, name))) {
    throw new Error(t('skills.errors.builtin_conflict', { name }));
  }
  fs.mkdirSync(d, { recursive: true });
  writeTextAtomicSync(path.join(d, 'SKILL.md'), skillMdContent(name, description));
  log.info(`created name=${name}`);
  _invalidateSkillListCache();
  invalidateCoreAgentSkills().catch(() => { /* runner may not be loaded yet */ });
  return getCustomSkill(name);
}

export async function updateCustomSkill(
  skillId: string,
  updates: { name?: string; description?: string; description_zh?: string; description_en?: string },
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

  let currentId = skillId;
  if (newName !== skillId) {
    const err = validateSkillName(newName);
    if (err) throw new Error(err);
    const target = customSkillDir(newName);
    if (fs.existsSync(target)) throw new Error(t('skills.errors.skill_exists', { name: newName }));
    if (fs.existsSync(path.join(BUILTIN_SKILLS_DIR, newName))) {
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
            m.session_id = defaultSkillSessionId(uid, newName);
            await saveSkillChatMeta(uid, newName, m);
            search.dropSkillChat(uid, skillId);
            search.reindexSkillChatFile(uid, newName);
          } catch (err) {
            log.warn(`rename user=${uid} ${oldChatDir} -> ${newChatDir} failed: ${(err as Error).message}`);
          }
        }
        const oldSid = defaultSkillSessionId(uid, skillId);
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
  log.info(`updated name=${currentId}`);
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
        search.dropSkillChat(uid, skillId);
      }
      const sessionId = defaultSkillSessionId(uid, skillId);
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
  for (const root of [path.resolve(BUILTIN_SKILLS_SOURCE, '..', '..'), WS_ROOT]) {
    if (root && (dir === root || dir.startsWith(root + path.sep))) {
      return { blocked: true, reason: 'Orkas 自身目录' };
    }
  }

  // Home-dir root exactly — would trigger the 50 MiB cap only after
  // hoovering plenty of sensitive files.
  const home = os.homedir();
  if (home && dir === home) return { blocked: true, reason: '用户家目录根' };

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
      return { blocked: true, reason: '系统目录' };
    }
  }
  if (process.platform === 'win32') {
    if (hitsPrefix(win)) return { blocked: true, reason: '系统目录' };
  }

  // User-sensitive subdirs (SSH / GPG / AWS creds).
  const sensitive = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
  ];
  if (hitsPrefix(sensitive)) return { blocked: true, reason: '用户凭证目录' };

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
  if (fs.existsSync(path.join(BUILTIN_SKILLS_DIR, intended))) return null;
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

/**
 * Safely write content to `<skill_dir>/<relpath>`. Rejects path-escape attempts.
 * Skills are self-contained — only writes within `skillId`'s own dir.
 */
export function writeCustomSkillFile(
  skillId: string,
  relpath: string,
  content: string,
): boolean {
  const d = path.resolve(customSkillDir(skillId));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return false;
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

function defaultSkillSessionId(userId: string, skillId: string): string {
  return `${userId}-skill-${skillId}`;
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
  const { msgIndex } = await appendJsonlAtomic(file, record);
  search.indexSkillChatMessage(userId, skillId, msgIndex, record);
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
  search.dropSkillChat(userId, skillId);
  // Also evict + drop the core-agent persistent session jsonl. Without this
  // the LLM retains its full prior context (tool calls, paths, file contents)
  // even though the UI history is empty — visible as the LLM "remembering"
  // pre-clear state, e.g. trying to read paths that no longer exist after a
  // promote-to-builtin. Session id is id-keyed so it survives source changes.
  const sessionId = defaultSkillSessionId(userId, skillId);
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
}

export async function sendToSkillChat(userId: string, skillId: string, content: string): Promise<SkillChatResult> {
  const skill = await getCustomSkill(skillId);
  if (!skill) return { ok: false, error: 'skill not found' };

  const meta = await loadSkillChatMeta(userId, skillId);
  const sessionId = meta.session_id || defaultSkillSessionId(userId, skillId);

  const systemPrompt = await buildSkillEditSystemPrompt(skill);

  await _appendSkillChatMessage(userId, skillId,
    { time: nowIso(), role: 'user', content });

  const { chatWithModel } = require('../model/client');
  const result = await chatWithModel({
    userId, message: content, sessionId, systemPrompt,
    agentName: 'orkas_chat', timeout: 300,
    ...(skill.dir ? { extraRoots: [skill.dir] } : {}),
  });

  if (!result.ok) {
    const errMsg = `模型响应失败: ${result.error || 'unknown'}`;
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
  const sessionId = meta.session_id || defaultSkillSessionId(userId, skillId);

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
      ...(skill.dir ? { extraRoots: [skill.dir] } : {}),
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
        errMsg = `模型响应失败: ${event.text || 'unknown'}`;
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
    errMsg = `模型响应失败: ${msg}`;
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
          ? `${streamingText}\n\n（回复已中断）`
          : '（回复已中断）';
        await _appendSkillChatMessage(userId, skillId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      }
    } catch (e) {
      log.warn(`persist skill chat assistant failed skill=${skillId}: ${(e as Error).message}`);
    }
  }
}
