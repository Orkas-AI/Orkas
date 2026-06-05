/**
 * SkillRegistry — a single `SkillLoader` over Orkas's two skill roots,
 * shared by every core-agent chat request.
 *
 * Resolution order (see CLAUDE.md §6):
 *   1. <uid>/cloud/skills/                (user-custom; same id overrides platform install)
 *   2. <uid>/local/marketplace/skills/    (platform-installed; per-machine copy reconciled
 *                                          from the cloud-synced installs.json manifest)
 *
 * The loader caches by per-dir mtime, so `list()` is effectively free
 * between CRUD events. `features/skills.ts` can call `invalidateSkills()`
 * after a create/update/delete to force a re-scan before the next chat.
 *
 * The `Source` label is computed in this layer (`skillSourceLabel`), not
 * by the loader's basename inference — both roots end in `/skills`, so
 * basename is no longer distinguishing. 'builtin' is preserved as the
 * label string for backwards compatibility with the rest of the codebase;
 * UI renders it as "Platform".
 */

import * as path from 'node:path';

import { userMarketplaceSkillsDir, userSkillsDir } from '../../paths';
import { getActiveUserId } from '../../features/users';
import { descriptionLang, getCurrentLang } from '../../i18n';
// `pickDescription` is loaded lazily — see CLAUDE.md §3: any static import
// from `#core-agent` at module load would pull in pi-ai before
// `sdk-timeout-patch` has had a chance to monkey-patch it. The cached fn is
// hydrated on first render call, after the loader is already initialized.
type PickDescription = (s: { description_zh?: string; description_en?: string }, lang: string) => string;
let _pickDescription: PickDescription | null = null;
async function getPickDescription(): Promise<PickDescription> {
  if (_pickDescription) return _pickDescription;
  const m = await import('#core-agent');
  _pickDescription = m.pickDescription as PickDescription;
  return _pickDescription;
}

// `Source` is decided by root path, not by `path.basename(source)` — both skill roots end
// in `/skills`, so basename is non-discriminating (see CLAUDE.md §4). Marketplace-installed
// dir = 'builtin'; everything else (= cloud custom) = 'custom'. Resolved per-call because
// the marketplace dir is per-uid; can't pre-resolve to a module-level constant.
function skillSourceLabel(source: string): 'builtin' | 'custom' {
  try {
    const platformRoot = path.resolve(userMarketplaceSkillsDir(getActiveUserId()));
    return path.resolve(source) === platformRoot ? 'builtin' : 'custom';
  } catch { return 'custom'; }
}

export function compactPromptDescription(description: string): string {
  const text = String(description || '').trim();
  if (!text) return '';

  const markerPatterns: Array<{ re: RegExp; keepDelimiter?: boolean }> = [
    { re: /[；;]\s*适合/u },
    { re: /[；;]\s*适用/u },
    { re: /[；;]\s*触发词/u },
    { re: /[；;]\s*触发/u },
    { re: /[；;]\s*关键词/u },
    { re: /[;；]\s*(?:suitable for|use when|use for|best for|ideal for|triggers?|keywords?)\b/i },
    { re: /\.\s+(?:suitable for|use when|use for|best for|ideal for|triggers?|keywords?)\b/i, keepDelimiter: true },
  ];
  const markerIndexes = markerPatterns
    .map(({ re, keepDelimiter }) => {
      const match = re.exec(text);
      return match ? match.index + (keepDelimiter ? 1 : 0) : -1;
    })
    .filter((idx) => idx >= 0);
  if (markerIndexes.length) {
    const idx = Math.min(...markerIndexes);
    return text.slice(0, idx).trim();
  }

  const sentenceEnd = text.indexOf('。');
  if (sentenceEnd >= 0 && sentenceEnd < text.length - 1) {
    return text.slice(0, sentenceEnd + 1).trim();
  }

  const zhSemicolon = text.indexOf('；');
  if (zhSemicolon >= 0) {
    return text.slice(0, zhSemicolon).trim();
  }

  return text;
}

function dedupeSkillsByDisplayName<T extends SkillAllowlistRef>(specs: T[]): T[] {
  if (specs.length < 2) return specs;
  const byName = new Map<string, T[]>();
  for (const s of specs) {
    const displayName = (s.name || s.id || '').trim();
    if (!displayName) continue;
    const list = byName.get(displayName) || [];
    list.push(s);
    byName.set(displayName, list);
  }

  const shadowed = new Set<T>();
  for (const list of byName.values()) {
    const hasCustom = list.some((s) => _skillRefRank(s) === 0);
    if (!hasCustom) continue;
    for (const s of list) {
      if (_skillRefRank(s) !== 0) shadowed.add(s);
    }
  }
  return specs.filter((s) => !shadowed.has(s));
}

// Render the system-prompt block listing every skill the LLM can use.
//
// Format:
//   `## Available skills (skills)\n\n` +
//   `\`read_file(<ROOT>/<id>/SKILL.md)\` — ROOT by Source:\n` +
//   `- custom:  <abs path>\n` +
//   `- builtin: <abs path>\n` +
//   `Use these ROOT values verbatim.\n\n` +
//   per-entry lines `- **<display name>** (Source: custom|builtin; internal read id: <id>) — desc`
//
// Why the inline ROOT header (added 2026-05): putting only `(Source: ...)` on
// each entry and listing the path constants in a separate `## Resource locations`
// section let the LLM ignore the resolved absolute paths and pattern-match its
// training prior to fabricate `/data/custom/skills/<id>/SKILL.md` (a Claude Code
// layout that doesn't exist here), which then trips E_PATH_OUT_OF_SCOPE on
// `read_file`. The roots-in-block form puts the actual values right next to the
// entry list so the LLM can't miss them.
//
// 2026-05-09 follow-up: the warning line previously read
// `do NOT use training-prior layouts (e.g. /data/custom/skills/)` — the negative
// example string itself primed the model and we observed retries hitting exactly
// `/data/custom/skills/<id>/SKILL.md` verbatim. Removed the negative example so
// the warning is just `Use these ROOT values verbatim.` (matches the agents-index
// block in `bus.ts::buildAgentsIndexBlock`, which has no example string and does
// not see this failure). Do NOT re-add the negative example.
async function renderSkillLines(
  specs: SkillSpec[],
  customRoot: string,
  builtinRoot: string,
): Promise<string> {
  if (!specs.length) return '';
  const lang = descriptionLang(getCurrentLang());
  const pick = await getPickDescription();
  // Each entry shows the human `name` (what the model uses to decide *whether* to reach
  // for the skill) plus the raw `id` (what goes into the read_file path). They DIVERGE for
  // marketplace installs whose dir name = 12-hex server id but whose authored name is a
  // readable string — see core-agent loader.ts comment on the dir-id ≠ name split.
  const lines: string[] = [
    '## Available skills (skills)',
    '',
    '`read_file(<ROOT>/<id>/SKILL.md)` — ROOT by Source:',
    `- custom:  ${customRoot}`,
    `- builtin: ${builtinRoot}`,
    'Use these ROOT values verbatim. `<id>` is the internal read id for read_file paths only, even when it differs from display name.',
    'These entries are skills, not tool names: read SKILL.md and follow it; never call the display name or id as a tool. Never mention skill ids in plans, workflows, progress, or final replies.',
    '',
  ];
  for (const s of specs) {
    const source = skillSourceLabel(s.source);
    const description = compactPromptDescription(pick(s, lang));
    const desc = description ? ` — ${description}` : '';
    // When name == id (custom skills authored locally), collapse the redundancy; when they
    // differ (marketplace installs), keep the id explicitly internal so the model can read by
    // path without being primed to repeat the id in user-facing prose.
    const displayName = s.name || s.id;
    const internal = displayName !== s.id ? `; internal read id: ${s.id}` : '';
    lines.push(`- **${displayName}** (Source: ${source}${internal})${desc}`);
  }
  return lines.join('\n');
}

type CoreAgent = typeof import('#core-agent');
type SkillLoaderCtor = CoreAgent['SkillLoader'];
type SkillLoaderInstance = InstanceType<SkillLoaderCtor>;
type SkillSpec = ReturnType<SkillLoaderInstance['list']>[number];
export interface SkillAllowlistRef {
  id: string;
  name?: string;
  source?: string;
}

function _skillRefRank(s: SkillAllowlistRef): number {
  if (!s.source) return 1;
  return skillSourceLabel(s.source) === 'custom' ? 0 : 1;
}

export function resolveSkillAllowlistRefs(
  specs: SkillAllowlistRef[],
  refs: string[],
): { ids: string[]; unknown: string[] } {
  const byId = new Map<string, SkillAllowlistRef>();
  const byName = new Map<string, SkillAllowlistRef[]>();
  for (const s of specs) {
    if (!s || !s.id) continue;
    byId.set(s.id, s);
    const name = typeof s.name === 'string' ? s.name : '';
    if (name) {
      const list = byName.get(name) || [];
      list.push(s);
      byName.set(name, list);
    }
  }
  for (const list of byName.values()) {
    list.sort((a, b) => {
      const byRank = _skillRefRank(a) - _skillRefRank(b);
      return byRank || a.id.localeCompare(b.id);
    });
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length === 0) continue;
    const resolved = byId.get(ref) || byName.get(ref)?.[0] || null;
    if (!resolved) {
      unknown.push(ref);
      continue;
    }
    if (!seen.has(resolved.id)) {
      seen.add(resolved.id);
      ids.push(resolved.id);
    }
  }
  return { ids, unknown };
}

function _buildDisplayNameByInternalId(specs: SkillAllowlistRef[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of specs || []) {
    const id = typeof s?.id === 'string' ? s.id.trim() : '';
    const name = typeof s?.name === 'string' ? s.name.trim() : '';
    if (!id || !name || id === name) continue;
    out.set(id.toLowerCase(), name);
  }
  return out;
}

function _buildDisplayNameByRef(specs: SkillAllowlistRef[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of specs || []) {
    const id = typeof s?.id === 'string' ? s.id.trim() : '';
    const name = typeof s?.name === 'string' ? s.name.trim() : '';
    const display = name || id;
    if (!display) continue;
    if (id) out.set(id.toLowerCase(), display);
    if (name) out.set(name.toLowerCase(), display);
  }
  return out;
}

export function replaceKnownSkillIdsForDisplay(text: string, specs: SkillAllowlistRef[]): string {
  if (!text) return text;
  const byId = _buildDisplayNameByInternalId(specs);
  if (!byId.size) return text;
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
  const alt = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${alt})(?=$|[^A-Za-z0-9_])`, 'gi');
  return String(text).replace(re, (_m, prefix: string, id: string) => {
    return `${prefix}${byId.get(id.toLowerCase()) || id}`;
  });
}

export function simplifyKnownSkillFollowPhrasesForDisplay(text: string, specs: SkillAllowlistRef[]): string {
  if (!text) return text;
  const byRef = _buildDisplayNameByRef(specs);
  if (!byRef.size) return text;
  const replaceRef = (full: string, ref: string) => {
    const display = byRef.get(String(ref || '').trim().toLowerCase());
    return display ? `\`${display}\` skill` : full;
  };
  let out = String(text).replace(/`skill:\s*follow\s+the\s+([A-Za-z0-9_.-]+)\s+skill`/gi, replaceRef);
  out = out.replace(/skill:\s*follow\s+the\s+`?([A-Za-z0-9_.-]+)`?\s+skill/gi, replaceRef);
  return out;
}

export function normalizeKnownSkillRefsForDisplay(text: string, specs: SkillAllowlistRef[]): string {
  return simplifyKnownSkillFollowPhrasesForDisplay(
    replaceKnownSkillIdsForDisplay(text, specs),
    specs,
  );
}

// Skill loader is rebuilt on uid switch — `invalidateSkills()` clears it so
// the next `getLoader()` call re-reads the new user's custom skills dir.
let _loaderPromise: Promise<SkillLoaderInstance> | null = null;

async function getLoader(): Promise<SkillLoaderInstance> {
  if (!_loaderPromise) {
    _loaderPromise = import('#core-agent').then((m) => {
      return new m.SkillLoader({
        // custom (cloud, per-uid) listed first → user overrides of same-id builtins.
        dirs: [userSkillsDir(getActiveUserId()), userMarketplaceSkillsDir(getActiveUserId())],
      });
    });
  }
  return _loaderPromise;
}

export interface SystemPromptBlockOptions {
  /**
   * Restrict the skills listing to a subset. When undefined, every skill
   * discovered by the loader is rendered (legacy behavior). When an empty
   * array is passed, renders an empty block — used when an agent declares
   * `skill_list: []` to opt out of all skills.
   *
   * Unknown ids/names are silently dropped (skill may have been deleted
   * since the agent was configured). Display-name matching preserves legacy
   * agents authored before marketplace installs decoupled id from name.
   */
  allowlist?: string[];
  /**
   * Skill ids the user has explicitly disabled (per-user override from
   * `<uid>/cloud/config/component-enabled.json`). Filtered before render
   * so the disabled skill never reaches the LLM. Caller
   * (`runner.ts::buildRunner`) reads the per-user map and passes the set
   * in — this module stays free of `features/*` imports.
   */
  disabledIds?: Iterable<string>;
  /**
   * Fires once per skill id rendered, with its source system (`A.custom`
   * for `<uid>/cloud/skills/` or `A.platform` for the marketplace install
   * dir). Caller (`runner.ts::buildRunner`) bridges this to ChatOptions
   * so `features/group_chat/bus.ts` collects per turn for the
   * `skill_advertised` signal. Pure callback — no FS, no IO, no awaits.
   * See `Common/docs/plans/expert-signals-skill-attribution.md` §4.1.
   */
  onSkillAdvertised?: (skill_id: string, system: 'A.custom' | 'A.platform') => void;
  /**
   * UI-only display-name collector. `getSystemPromptBlock` already has the
   * filtered SkillSpec list in hand; callers can pass a Map here to reuse
   * that metadata for local process-log rendering without rescanning skills
   * or adding anything to the model prompt.
   */
  displayNameById?: Map<string, string>;
}

/**
 * Markdown block describing available skills — splice this into a
 * system prompt so the LLM knows what's available. Empty string when
 * no skills are found (core-agent treats `""` as "skip the section").
 *
 * When `opts.allowlist` is provided, only skills whose `id` is in the
 * allowlist are rendered. Rendering always goes through
 * `renderSkillLines` so the `Source` label is derived from the exact root
 * path rather than basename.
 */
export async function getSystemPromptBlock(opts: SystemPromptBlockOptions = {}): Promise<string> {
  const loader = await getLoader();
  const specs = loader.list();
  const disabled = opts.disabledIds ? new Set(opts.disabledIds) : null;
  const filterDisabled = (list: typeof specs) =>
    disabled && disabled.size ? list.filter((s) => !disabled.has(s.id)) : list;
  // Resolve roots once per call — `getActiveUserId` may have rotated since
  // `getLoader` (cached) was first instantiated; users.ts switches uid via
  // `activateUser` which calls `invalidateSkills` to drop the loader cache,
  // but the ROOT values must reflect the CURRENT uid regardless of cache age.
  const customRoot = path.resolve(userSkillsDir(getActiveUserId()));
  const builtinRoot = path.resolve(userMarketplaceSkillsDir(getActiveUserId()));

  let rendered: typeof specs;
  if (opts.allowlist === undefined) {
    rendered = filterDisabled(specs);
  } else {
    const rawAllow = opts.allowlist.filter((id) => typeof id === 'string' && id.length > 0);
    if (rawAllow.length === 0) return '';
    const { ids } = resolveSkillAllowlistRefs(specs, rawAllow);
    const allow = new Set(ids);
    rendered = filterDisabled(specs.filter((s) => allow.has(s.id)));
  }

  rendered = dedupeSkillsByDisplayName(rendered);

  if (opts.onSkillAdvertised && rendered.length) {
    for (const s of rendered) {
      try {
        opts.onSkillAdvertised(s.id, skillSourceLabel(s.source) === 'custom' ? 'A.custom' : 'A.platform');
      } catch { /* callback throws are non-fatal; signal emission is best-effort */ }
    }
  }

  if (opts.displayNameById) {
    for (const s of rendered) {
      if (s.id) opts.displayNameById.set(s.id, s.name || s.id);
    }
  }

  return renderSkillLines(rendered, customRoot, builtinRoot);
}

/** Drop the internal mtime cache so the next `list()` rescans. */
export async function invalidateSkills(): Promise<void> {
  if (!_loaderPromise) return;
  const loader = await _loaderPromise;
  loader.invalidate();
}

/** For diagnostics: return the skill list. Picks a description per the active UI language. */
export async function listSkills(): Promise<Array<{ id: string; name: string; description: string }>> {
  const loader = await getLoader();
  const lang = descriptionLang(getCurrentLang());
  const pick = await getPickDescription();
  return loader.list().map((s) => ({ id: s.id, name: s.name, description: pick(s, lang) }));
}

/**
 * Full `SkillSpec[]` snapshot — used by `features/agents.ts` to filter
 * unknown ids out of `agent.skill_list` writes. Goes through the registry
 * singleton so loader caching is shared with `getSystemPromptBlock`.
 */
export async function listSkillSpecs(): Promise<SkillSpec[]> {
  const loader = await getLoader();
  return loader.list();
}
