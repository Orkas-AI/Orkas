/**
 * SkillRegistry — `SkillLoader`s over Orkas's skill roots, shared by every
 * core-agent chat request.
 *
 * Two loader tiers (see CLAUDE.md §6 and
 * docs/plans/open-ecosystem-architecture.md §A3/§B1):
 *
 * TRUSTED tier (one loader; specs flow into agent `skill_list`
 * resolution, advertise signals, and every session kind):
 *   1. <uid>/cloud/skills/                (user-custom; same id overrides platform install)
 *   2. <uid>/local/marketplace/skills/    (platform-installed; per-machine copy reconciled
 *                                          from the cloud-synced installs.json manifest)
 *
 * OPEN tier (separate loader; commander sessions only, per `includeOpenSources`):
 *   3. enabled external-package skill roots (<uid>/local/packages/, registry-driven)
 *      — INLINED into `## Available skills` (registry-bounded, quality source;
 *        so the model uses an installed package instead of re-installing it).
 *   4. global skill roots (~/.claude/skills, ~/.codex/skills; interop, preference-gated)
 *      — NOT inlined; reached on demand via the `skill_search` tool (unbounded
 *        user content kept out of the cache-prefix). `searchOpenTierSkills`
 *        returns this global tier only.
 * Open-tier specs never enter `resolveSkillAllowlistRefs` /
 * `listSkillSpecs`, so agent-edit cannot adopt them into skill_list.
 * Open-tier SKILL.md is read leniently and NEVER normalized or written.
 *
 * The loaders cache by per-dir mtime, so `list()` is effectively free
 * between CRUD events. `features/skills.ts` can call `invalidateSkills()`
 * after a create/update/delete to force a re-scan before the next chat.
 * The open loader is additionally rebuilt whenever its computed dir-set
 * changes (package installs happen out-of-process via bin/orkas-pkg.cjs,
 * so the dir list is recomputed — cheap registry JSON read — per call).
 *
 * The `Source` label is computed in this layer (root-path comparison), not
 * by the loader's basename inference — several roots end in `/skills`, so
 * basename is non-discriminating. 'builtin' is preserved as the label
 * string for marketplace installs for backwards compatibility; UI renders
 * it as "Platform".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userMarketplaceSkillsDir, userPackageDir, userSkillsDir, userSystemSkillsDir, globalSkillRoots } from '../../paths';
import { enabledPackageSkillRoots, packageSkillRoots, readPackagesRegistry } from '../../features/packages';
import { companionSkillsRootIfPopulated, companionPackageForDir } from '../../features/package_skills';
import { getActiveUserId } from '../../features/users';
import { getLanguage, getGlobalSkillRootsEnabled } from '../../features/config';
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

export type SkillSourceLabel = 'custom' | 'builtin' | 'external' | 'global' | 'unknown';

// `Source` is decided by root path, not by `path.basename(source)` — several skill roots
// end in `/skills`, so basename is non-discriminating (see CLAUDE.md §4). Resolved per-call
// because the marketplace dir is per-uid; can't pre-resolve to a module-level constant.
// Open-tier roots (external packages / global dirs) are matched by the caller-supplied
// label map in `renderSkillLines`; this fast path only distinguishes the trusted tier and
// is what allowlist ranking + advertise signals rely on.
function skillSourceLabel(source: string): 'builtin' | 'custom' | 'unknown' {
  try {
    const resolved = path.resolve(source);
    if (resolved === path.resolve(userSkillsDir(getActiveUserId()))) return 'custom';
    if (resolved === path.resolve(userMarketplaceSkillsDir(getActiveUserId()))) return 'builtin';
    // Catch-all. custom is now matched EXPLICITLY above, so an unrecognized
    // root falls here as `unknown` (lowest dedupe priority) instead of being
    // silently treated as `custom` (highest). Open-tier roots are ranked via
    // `rankByRoot` before this is ever reached; this guards a future/
    // mis-registered trusted-side root from shadowing a real custom/platform
    // skill by display name.
    return 'unknown';
  } catch { return 'unknown'; }
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

// Shadowing rank for display-name dedupe. Lower wins; ties all stay —
// custom shadows platform (legacy behavior), any trusted entry shadows a
// same-name open-tier entry, but platform-platform (and external-external,
// global-global) duplicates are NOT globally deduped (CLAUDE.md §6).
// `unknown` is the catch-all for an unrecognized source root: it sits at the
// LOWEST priority so a mis-classified/future source can never shadow a real
// tier by display name (fail toward least trust, not most).
const SOURCE_DEDUPE_RANK: Record<SkillSourceLabel, number> = {
  custom: 0,
  builtin: 1,
  external: 2,
  global: 3,
  unknown: 99,
};

function dedupeSkillsByDisplayName<T extends SkillAllowlistRef>(
  specs: T[],
  rankOf: (s: T) => number = (s) => SOURCE_DEDUPE_RANK[skillSourceLabel(s.source || '')],
): T[] {
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
    if (list.length < 2) continue;
    const minRank = Math.min(...list.map(rankOf));
    for (const s of list) {
      if (rankOf(s) !== minRank) shadowed.add(s);
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
/** One prompt-block ROOT row: a label the entries reference + the resolved
 *  absolute dir. Open-tier roots get numbered labels (`external`,
 *  `external2`, …) because a tier can span several dirs. */
interface PromptRootEntry { label: string; root: string }

async function renderSkillLines(
  specs: SkillSpec[],
  rootEntries: PromptRootEntry[],
): Promise<string> {
  if (!specs.length) return '';
  const lang = descriptionLang(getLanguage());
  const pick = await getPickDescription();
  const labelByRoot = new Map<string, string>();
  for (const r of rootEntries) labelByRoot.set(path.resolve(r.root), r.label);
  // Only print ROOT rows the entry list actually references — open-tier
  // roots with zero surviving entries would be prompt noise.
  const usedLabels = new Set<string>();
  const labelOf = (s: SkillSpec): string =>
    labelByRoot.get(path.resolve(s.source)) || skillSourceLabel(s.source);
  for (const s of specs) usedLabels.add(labelOf(s));

  // Each entry shows the human `name` (what the model uses to decide *whether* to reach
  // for the skill) plus the raw `id` (what goes into the read_file path). They DIVERGE for
  // marketplace installs whose dir name = 12-hex server id but whose authored name is a
  // readable string — see core-agent loader.ts comment on the dir-id ≠ name split.
  const lines: string[] = [
    '## Available skills (skills)',
    '',
    '`read_file(<ROOT>/<id>/SKILL.md)` — ROOT by Source:',
  ];
  for (const r of rootEntries) {
    // custom + builtin rows always render (stable prompt prefix); other
    // tiers render only when referenced. `custom:` keeps its historical
    // two-space alignment so the legacy two-root block stays byte-identical
    // (KV-cache prefix stability).
    if (r.label === 'custom' || r.label === 'builtin' || usedLabels.has(r.label)) {
      lines.push(`- ${r.label}:${r.label === 'custom' ? '  ' : ' '}${r.root}`);
    }
  }
  lines.push(
    'Use these ROOT values verbatim. `<id>` is the internal read id for read_file paths only, even when it differs from display name.',
    'These entries are skills, not tool names: read SKILL.md and follow it; never call the display name or id as a tool. Never mention skill ids in plans, workflows, progress, or final replies.',
    '',
  );
  for (const s of specs) {
    const source = labelOf(s);
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
        // custom (cloud, per-uid) listed first → user overrides same-id platform installs.
        dirs: [userSkillsDir(getActiveUserId()), userMarketplaceSkillsDir(getActiveUserId())],
      });
    });
  }
  return _loaderPromise;
}

// OPEN-tier loader (external packages + global roots). Rebuilt whenever the
// computed dir-set changes — package installs happen out-of-process
// (bin/orkas-pkg.cjs), so the dir list is recomputed per call; the registry
// JSON read behind `enabledPackageSkillRoots` is tiny. Per-dir mtime
// caching inside SkillLoader still avoids re-scanning unchanged dirs.
let _openLoader: { signature: string; loader: SkillLoaderInstance } | null = null;

interface OpenTierDirs { external: string[]; global: string[] }

type PackageSkillMeta = {
  package_name?: string;
  package_kind?: 'skill' | 'cli' | 'both';
  package_enabled?: boolean;
};

function packageMetaForSkillDir(uid: string, skillDir: string): PackageSkillMeta {
  const resolved = path.resolve(skillDir);
  const registry = readPackagesRegistry(uid);
  for (const pkg of registry.packages) {
    const pkgRoot = path.resolve(userPackageDir(uid, pkg.name));
    if (resolved === pkgRoot || resolved.startsWith(pkgRoot + path.sep)) {
      return { package_name: pkg.name, package_kind: pkg.kind, package_enabled: pkg.enabled !== false };
    }
  }
  // Companion usage skills live OUTSIDE the package tree (in
  // `local/package_skills/<pkg>/`), so map them back to their registry entry
  // by dir name. Registry-joined: a companion whose package was removed
  // resolves to {} (no package_name) and is dropped by the open-tier filters.
  const companionPkg = companionPackageForDir(uid, resolved);
  if (companionPkg) {
    const pkg = registry.packages.find((p) => p.name === companionPkg);
    if (pkg) return { package_name: pkg.name, package_kind: pkg.kind, package_enabled: pkg.enabled !== false };
  }
  return {};
}

function _computeOpenTierDirs(uid: string): OpenTierDirs {
  let external: string[] = [];
  try { external = enabledPackageSkillRoots(uid); }
  catch { /* registry unreadable → no external roots this turn */ }
  // CLI-package companion skills are treated as an extra external root: same
  // inlining/read-scope/dedupe path as package skills. The parent dir is one
  // root (each child = one skill, id == package name); per-package enable +
  // orphan gating happens in the consumers via packageMetaForSkillDir.
  try {
    const companionRoot = companionSkillsRootIfPopulated(uid);
    if (companionRoot) external = [...external, companionRoot];
  } catch { /* fs error → no companion root this turn */ }
  // Existence-filter global dirs here (external roots are already filtered
  // by enabledPackageSkillRoots) — absent dirs would pollute the numbered
  // ROOT labels (`global` / `global2`) and the read-scope list.
  const global = getGlobalSkillRootsEnabled()
    ? globalSkillRoots().filter((g) => {
      try { return fs.statSync(g).isDirectory(); } catch { return false; }
    })
    : [];
  return { external, global };
}

async function getOpenLoader(dirs: OpenTierDirs): Promise<SkillLoaderInstance | null> {
  const all = [...dirs.external, ...dirs.global];
  if (!all.length) return null;
  const signature = all.join('|');
  if (_openLoader && _openLoader.signature === signature) return _openLoader.loader;
  const m = await import('#core-agent');
  const loader = new m.SkillLoader({ dirs: all });
  _openLoader = { signature, loader };
  return loader;
}

/** OPEN-tier dirs the commander's read scope must cover so the rendered
 *  `read_file(<ROOT>/<id>/SKILL.md)` paths actually resolve. Existing dirs
 *  only. Callers (bus.ts) pass these as `readOnlyExtraRoots` for commander
 *  turns — same mechanism as the custom/marketplace roots. */
export function openSkillReadRoots(uid: string): string[] {
  const dirs = _computeOpenTierDirs(uid);
  return [...dirs.external, ...dirs.global];
}

/** Static commander hint appended to the skills block. External-package skills
 *  are now INLINED above (a quality, registry-bounded source). Only the GLOBAL
 *  skill folders stay behind `skill_search` — they are unbounded user content,
 *  and keeping them search-only with no count keeps the cache prefix stable. */
const OPEN_TIER_SKILL_HINT =
  'More skills may be available from your global skill folders — these are NOT listed '
  + 'above. Call the `skill_search` tool with a capability query to find them, then '
  + '`read_file` the returned SKILL.md path before invoking.';

const OPEN_SEARCH_DEFAULT_LIMIT = 8;
const OPEN_SEARCH_MAX_LIMIT = 20;

export interface OpenSkillSearchRow {
  name: string;
  id: string;
  source: 'external' | 'global';
  /** Absolute `<root>/<id>/SKILL.md` — commander reads this before invoking. */
  read_path: string;
  description: string;
}

export interface OpenSkillSearchResult {
  rows: OpenSkillSearchRow[];
  total_matched: number;
  returned: number;
}

/**
 * Search OPEN-tier skills (enabled external packages + global roots) by
 * capability. Backs the commander's `skill_search` tool — the on-demand
 * replacement for inlining open-tier into the system prompt. Trusted-tier ids
 * win id collisions (dropped here) so a result never points at an ambiguous
 * read path. Ranking is lexical token overlap on name + description; an empty
 * query returns a bounded list ordered by name. Results are capped to `limit`
 * (default 8, max 20); `total_matched` lets the caller know more exist.
 * `disabledIds` (the user's component-disable set, passed in by the feature
 * caller so this model-layer module stays free of `features/*`) is filtered
 * out — a disabled skill never surfaces in search.
 */
export async function searchOpenTierSkills(
  uid: string, query: string, limit?: number, disabledIds?: Iterable<string>,
): Promise<OpenSkillSearchResult> {
  const dirs = _computeOpenTierDirs(uid);
  const loader = await getOpenLoader(dirs);
  if (!loader) return { rows: [], total_matched: 0, returned: 0 };

  // External-package skills are now inlined into the commander prompt, so
  // search returns ONLY global-folder skills (the still-lazy tier). The open
  // loader still loads both (cache shared with the prompt/bridge); we filter
  // external out of the results here.
  const externalSet = new Set(dirs.external.map((d) => path.resolve(d)));
  const trustedIds = new Set((await getLoader()).list().map((s) => s.id));
  const disabled = disabledIds ? new Set(disabledIds) : null;
  const specs = loader.list().filter((s) =>
    !trustedIds.has(s.id)
    && !(disabled && disabled.has(s.id))
    && !externalSet.has(path.resolve(s.source)));

  const lang = descriptionLang(getLanguage());
  const pick = await getPickDescription();
  const q = String(query || '').toLowerCase().trim();
  const tokens = q ? q.split(/[\s,，、;；]+/u).filter(Boolean) : [];

  const scored = specs.map((s) => {
    const name = s.name || s.id;
    const fullDesc = pick(s, lang) || '';
    const nameLc = name.toLowerCase();
    const hay = `${nameLc}\n${fullDesc.toLowerCase()}`;
    let score = 0;
    for (const t of tokens) {
      if (nameLc.includes(t)) score += t.length * 2; // name hits weigh more
      else if (hay.includes(t)) score += t.length;
    }
    return { s, name, fullDesc, score };
  });

  const matched = tokens.length ? scored.filter((x) => x.score > 0) : scored;
  matched.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

  const cap = Math.max(1, Math.min(OPEN_SEARCH_MAX_LIMIT, Math.floor(limit || OPEN_SEARCH_DEFAULT_LIMIT)));
  const rows: OpenSkillSearchRow[] = matched.slice(0, cap).map(({ s, name, fullDesc }) => {
    const resolved = path.resolve(s.source);
    return {
      name,
      id: s.id,
      source: externalSet.has(resolved) ? 'external' : 'global',
      read_path: path.join(resolved, s.id, 'SKILL.md'),
      description: compactPromptDescription(fullDesc),
    };
  });
  return { rows, total_matched: matched.length, returned: rows.length };
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
  /**
   * Commander (`gconv`) sessions only. Inlines enabled EXTERNAL-package skills
   * into the block (registry-bounded, quality source — so the model sees what's
   * installed and won't re-install it), and appends a static one-line hint
   * pointing at `skill_search` (-> `searchOpenTierSkills`) for the still-lazy
   * GLOBAL-folder tier (unbounded user content). Ignored under an allowlist
   * (project pinning / agent skill_list stay trusted-tier-only) — open-tier
   * never enters agent workers or skill_list.
   */
  includeOpenSources?: boolean;
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
  const uid = getActiveUserId();
  const rootEntries: PromptRootEntry[] = [
    { label: 'custom', root: path.resolve(userSkillsDir(uid)) },
    { label: 'builtin', root: path.resolve(userMarketplaceSkillsDir(uid)) },
  ];

  let rendered: typeof specs;
  let allowlisted = false;
  if (opts.allowlist === undefined) {
    rendered = filterDisabled(specs);
  } else {
    allowlisted = true;
    const rawAllow = opts.allowlist.filter((id) => typeof id === 'string' && id.length > 0);
    if (rawAllow.length === 0) return '';
    const { ids } = resolveSkillAllowlistRefs(specs, rawAllow);
    const allow = new Set(ids);
    rendered = filterDisabled(specs.filter((s) => allow.has(s.id)));
  }

  // EXTERNAL-package skills are inlined for the commander (registry-bounded,
  // quality source). GLOBAL-folder skills stay behind `skill_search` (unbounded
  // user content; the hint below points there). Inlining external means a
  // package install/enable busts the commander cache prefix — an accepted
  // trade for the model directly seeing installed packages (so it won't try to
  // re-install something already present). Allowlist / non-commander paths are
  // unchanged (trusted-only — open-tier never enters agent skill_list).
  const externalRootSet = new Set<string>();
  let externalRankByRoot: Map<string, number> | null = null;
  if (opts.includeOpenSources && !allowlisted) {
    const openDirs = _computeOpenTierDirs(uid);
    if (openDirs.external.length) {
      const openLoader = await getOpenLoader(openDirs);
      if (openLoader) {
        externalRankByRoot = new Map();
        openDirs.external.forEach((dir, i) => {
          const resolved = path.resolve(dir);
          externalRootSet.add(resolved);
          externalRankByRoot!.set(resolved, SOURCE_DEDUPE_RANK.external);
          rootEntries.push({ label: i === 0 ? 'external' : `external${i + 1}`, root: resolved });
        });
        const trustedIds = new Set(rendered.map((s) => s.id));
        const externalSpecs = openLoader.list().filter((s) => {
          if (!externalRootSet.has(path.resolve(s.source))) return false;
          if (trustedIds.has(s.id)) return false;
          if (disabled && disabled.has(s.id)) return false;
          // Registry-backed only: drops a companion whose package was removed
          // but whose dir lingers (package_name absent), and disabled packages.
          const meta = packageMetaForSkillDir(uid, s.dir);
          return !!meta.package_name && meta.package_enabled !== false;
        });
        rendered = [...rendered, ...externalSpecs];
      }
    }
  }

  // Dedupe by display name; trusted shadows external (rank custom 0 > builtin 1
  // > external 2). When external is merged we pass a root-aware rank so the
  // external roots map to their tier rank; otherwise the default rank applies.
  rendered = externalRankByRoot
    ? dedupeSkillsByDisplayName(rendered, (s) => {
      const r = externalRankByRoot!.get(path.resolve(s.source || ''));
      return r !== undefined ? r : SOURCE_DEDUPE_RANK[skillSourceLabel(s.source || '')];
    })
    : dedupeSkillsByDisplayName(rendered);

  // Advertise signal stays trusted-only (`A.custom` / `A.platform`); external
  // entries are rendered but not advertised — their invocation is still
  // attributed downstream via `onSkillInvoked` (B tier).
  if (opts.onSkillAdvertised && rendered.length) {
    for (const s of rendered) {
      if (externalRootSet.has(path.resolve(s.source || ''))) continue;
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

  const block = await renderSkillLines(rendered, rootEntries);
  // Commander-only hint that GLOBAL-folder skills exist behind `skill_search`
  // (external packages are inlined above). Constant (no count) so global-folder
  // changes don't churn the cache prefix. Skipped under an allowlist —
  // pinned/agent skill_list stays trusted-only.
  if (opts.includeOpenSources && !allowlisted) {
    return block ? `${block}\n\n${OPEN_TIER_SKILL_HINT}` : OPEN_TIER_SKILL_HINT;
  }
  return block;
}

export async function getSystemSkillsPromptBlock(uid?: string): Promise<string> {
  const resolvedUid = uid || getActiveUserId();
  const root = path.resolve(userSystemSkillsDir(resolvedUid));
  const loaderMod = await import('#core-agent');
  const loader = new loaderMod.SkillLoader({ dirs: [root] });
  const specs = loader.list();
  if (!specs.length) return '';
  const lang = descriptionLang(getCurrentLang());
  const pick = await getPickDescription();
  const lines = [
    '## System skills',
    '',
    'System skills are product protocols. They are not marketplace or custom skills.',
    '',
    'Read with:',
    '`read_file(<SYSTEM_SKILLS_ROOT>/<id>/SKILL.md)`',
    '',
    'SYSTEM_SKILLS_ROOT:',
    root,
    '',
  ];
  for (const s of specs) {
    const displayName = s.name || s.id;
    const description = compactPromptDescription(pick(s, lang));
    const desc = description ? ` — ${description}` : '';
    lines.push(`- **${displayName}**${desc}`);
  }
  return lines.join('\n');
}

export interface BridgeSkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  dir: string;
  skillFile: string;
  package_name?: string;
  package_kind?: 'skill' | 'cli' | 'both';
  package_enabled?: boolean;
}

/**
 * Trusted + external-package listing for the orkas-bridge (external CLI
 * agents calling back into Orkas — plan §D). The CLI gets the trusted tier
 * (custom / marketplace) plus enabled external packages — but
 * NEVER global roots (`~/.claude/skills`, `~/.codex/skills`). claude / codex
 * read their own global skill dirs natively, so re-exposing those through the
 * bridge would double every global skill (one native entry + one bridge
 * entry). External packages live under the Orkas data dir, which no CLI
 * scans — they are the bridge's actual value-add. Display-name dedupe
 * matches `getSystemPromptBlock` (trusted shadows external). The disabled-id
 * filter is the caller's job (bridge.ts passes the component-enabled set).
 */
export async function listSkillsForBridge(uid: string): Promise<BridgeSkillRow[]> {
  const loader = await getLoader();
  const lang = descriptionLang(getLanguage());
  const pick = await getPickDescription();
  let specs: SkillSpec[] = loader.list();
  const rankByRoot = new Map<string, number>();
  const openDirs = _computeOpenTierDirs(uid);
  const openLoader = await getOpenLoader(openDirs);
  if (openLoader) {
    const externalSet = new Set(openDirs.external.map((d) => path.resolve(d)));
    for (const dir of openDirs.external) rankByRoot.set(path.resolve(dir), SOURCE_DEDUPE_RANK.external);
    const trustedIds = new Set(specs.map((s) => s.id));
    // External packages only — a spec sourced from a global root is dropped
    // here so the CLI never sees it twice (native + bridge).
    specs = [...specs, ...openLoader.list().filter((s) => {
      if (!externalSet.has(path.resolve(s.source))) return false;
      if (trustedIds.has(s.id)) return false;
      const meta = packageMetaForSkillDir(uid, s.dir);
      return !!meta.package_name && meta.package_enabled !== false;
    })];
  }
  specs = dedupeSkillsByDisplayName(specs, (s) => {
    const openRank = s.source ? rankByRoot.get(path.resolve(s.source)) : undefined;
    return openRank !== undefined ? openRank : SOURCE_DEDUPE_RANK[skillSourceLabel(s.source || '')];
  });
  return specs.map((s) => {
    const openRank = rankByRoot.get(path.resolve(s.source));
    const source = openRank === SOURCE_DEDUPE_RANK.external ? 'external' : skillSourceLabel(s.source);
    return {
      id: s.id,
      name: s.name || s.id,
      description: compactPromptDescription(pick(s, lang)),
      source,
      dir: s.dir,
      skillFile: s.skillFile,
    };
  });
}

export interface OpenTierListing {
  external: BridgeSkillRow[];
  global: BridgeSkillRow[];
}

/**
 * UI-facing open-tier listing for the skills panel. Unlike
 * `listSkillsForBridge` (which folds open-tier into one display-name-deduped
 * surface for the CLI bridge), this returns external packages and global
 * folders as TWO independent groups and does NOT dedupe a global skill away
 * just because an external package ships the same id/name — the panel shows
 * both so the user can see each provenance. Each group is built from its own
 * loader, so within-group id collisions still resolve first-dir-wins (the
 * SkillLoader's own behavior); only the cross-tier shadow is dropped.
 */
export async function listOpenSkillsByTier(uid: string): Promise<OpenTierListing> {
  const dirs = _computeOpenTierDirs(uid);
  let uiExternal: string[] = [];
  try {
    uiExternal = packageSkillRoots(uid, { includeDisabled: true });
    // Companion usage skills surface like external-package skills (play button
    // via the `external` source); include them for disabled packages too so the
    // panel can show their state. Per-package gating is in `build()` below
    // (orphans dropped by missing package_name; disabled flagged not removed).
    const companionRoot = companionSkillsRootIfPopulated(uid);
    if (companionRoot) uiExternal = [...uiExternal, companionRoot];
  } catch { uiExternal = dirs.external; }
  const lang = descriptionLang(getLanguage());
  const pick = await getPickDescription();
  const m = await import('#core-agent');
  const build = (dirList: string[], source: 'external' | 'global'): BridgeSkillRow[] => {
    if (!dirList.length) return [];
    const loader = new m.SkillLoader({ dirs: dirList });
    const rows: BridgeSkillRow[] = [];
    for (const s of loader.list()) {
      const packageMeta = source === 'external' ? packageMetaForSkillDir(uid, s.dir) : {};
      // When "." roots map to the packages dir, SkillLoader can see sibling
      // package dirs too. Keep the UI listing registry-backed only.
      if (source === 'external' && !packageMeta.package_name) continue;
      rows.push({
        id: s.id,
        name: s.name || s.id,
        description: compactPromptDescription(pick(s, lang)),
        source,
        dir: s.dir,
        skillFile: s.skillFile,
        ...packageMeta,
      });
    }
    return rows;
  };
  return {
    external: build(uiExternal, 'external'),
    global: build(dirs.global, 'global'),
  };
}

/** Drop the internal mtime caches so the next `list()` rescans. Also used
 *  on uid switch: clears the trusted loader (its dirs are per-uid) and the
 *  open loader (per-uid package roots). */
export async function invalidateSkills(): Promise<void> {
  _openLoader = null;
  if (!_loaderPromise) return;
  const loader = await _loaderPromise;
  loader.invalidate();
}

/** For diagnostics: return the skill list. Picks a description per the active UI language. */
export async function listSkills(): Promise<Array<{ id: string; name: string; description: string }>> {
  const loader = await getLoader();
  const lang = descriptionLang(getLanguage());
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
