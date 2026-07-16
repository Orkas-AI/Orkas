/**
 * SkillRegistry — `SkillLoader`s over Orkas's skill roots, shared by every
 * core-agent chat request.
 *
 * Two loader tiers (see CLAUDE.md §6 and
 * docs/plans/open-ecosystem-architecture.md §A3/§B1):
 *
 * TRUSTED tier (one loader; specs flow into agent `skill_list`
 * resolution, advertise signals, and every session kind):
 *   1. <uid>/local/marketplace/skills/    (builtin/platform-installed; per-machine copy reconciled
 *                                          from the cloud-synced installs.json manifest)
 *   2. <uid>/cloud/skills/                (user-custom; platform/builtin override same id)
 *
 * OPEN tier (separate loader; group-chat task + agent-edit authoring sessions,
 * per `includeOpenSources`):
 *   3. enabled external-package skill roots (<uid>/local/packages/, registry-driven)
 *      — INLINED into `## Available skills` (registry-bounded, quality source;
 *        so the model uses an installed package instead of re-installing it).
 *   4. global skill roots (~/.claude/skills, ~/.codex/skills; interop, preference-gated)
 *      — NOT inlined; reached on demand via the `skill_search` tool (unbounded
 *        user content kept out of the cache-prefix). `searchOpenTierSkills`
 *        returns this global tier only.
 * Open-tier specs never enter generic `resolveSkillAllowlistRefs` /
 * `listSkillSpecs`; agent metadata uses an explicit trusted+external helper.
 * Open-tier SKILL.md is read leniently and NEVER normalized or written.
 *
 * The loaders cache by per-dir mtime, so `list()` is effectively free
 * between CRUD events. `features/skills.ts` can call `invalidateSkills()`
 * after a create/update/delete to force a re-scan before the next chat.
 * The open loader is additionally rebuilt whenever its computed dir-set
 * changes (package installs happen out-of-process via bin/orkas-pkg.cjs,
 * so the dir list is recomputed — cheap registry JSON read — per call).
 *
 * The `Source` label is computed in this layer (root-path + install metadata),
 * not by the loader's basename inference — several roots end in `/skills`, so
 * basename is non-discriminating. Marketplace-root skills with
 * `_install.json::seed_source === "builtin"` are labelled `builtin`; the rest
 * are labelled `platform`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  agentEvolvedSkillsDir,
  agentPrivateSkillsDir,
  userMarketplaceAgentSkillsDir,
  userMarketplaceSkillsDir,
  userPackageDir,
  userSkillsDir,
  userSystemSkillsDir,
  globalSkillRoots,
} from '../../paths';
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

export type SkillSourceLabel = 'builtin' | 'platform' | 'custom' | 'external' | 'global' | 'unknown';

// `Source` is decided by root path, not by `path.basename(source)` — several skill roots
// end in `/skills`, so basename is non-discriminating (see CLAUDE.md §4). Resolved per-call
// because the marketplace dir is per-uid; can't pre-resolve to a module-level constant.
// Open-tier roots (external packages / global dirs) are matched by the caller-supplied
// label map in `renderSkillLines`; this fast path only distinguishes the trusted tier and
// is what allowlist ranking + advertise signals rely on.
function skillSourceLabel(source: string): 'platform' | 'custom' | 'unknown' {
  try {
    const resolved = path.resolve(source);
    if (resolved === path.resolve(userSkillsDir(getActiveUserId()))) return 'custom';
    if (resolved === path.resolve(userMarketplaceSkillsDir(getActiveUserId()))) return 'platform';
    // Catch-all. custom is now matched EXPLICITLY above, so an unrecognized
    // root falls here as `unknown` (lowest dedupe priority) instead of being
    // silently treated as `custom` (highest). Open-tier roots are ranked via
    // `rankByRoot` before this is ever reached; this guards a future/
    // mis-registered trusted-side root from shadowing a real custom/platform
    // skill by display name.
    return 'unknown';
  } catch { return 'unknown'; }
}

function _readObjectJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function _isBuiltinMarketplaceSkillDir(dir: string | undefined): boolean {
  if (!dir) return false;
  return _readObjectJson(path.join(dir, '_install.json'))?.seed_source === 'builtin';
}

function skillSourceLabelForSpec(s: Pick<SkillAllowlistRef, 'source' | 'dir'>): SkillSourceLabel {
  const base = skillSourceLabel(s.source || '');
  if (base === 'platform' && _isBuiltinMarketplaceSkillDir(s.dir)) return 'builtin';
  return base;
}

function skillSourceRank(s: Pick<SkillAllowlistRef, 'source' | 'dir'>): number {
  return SOURCE_DEDUPE_RANK[skillSourceLabelForSpec(s)];
}

// A compacted roster/skill-list entry shorter than this conveys no domain for
// the commander to route on. Some descriptions open with a tagline first
// sentence (e.g. video-studio's "做视频，也剪视频。") whose real capability +
// routing guidance lives in LATER sentences; collapsing to that tagline
// silently broke commander routing to the agent. See the floor in
// compactPromptDescription.
const MIN_USEFUL_SUMMARY = 16;
// Never let an extended summary blow up the cache prefix.
const MAX_COMPACT_SUMMARY = 240;

export function compactPromptDescription(description: string): string {
  const text = String(description || '').trim();
  if (!text) return '';

  const primary = firstSummarySegment(text);
  // Floor: if the first segment is a too-short tagline, extend it up to the
  // trigger/适合 section (or a hard cap) so the entry still carries the
  // routing-critical content. Currently-adequate descriptions (the vast
  // majority) are returned byte-identical — the floor only fires when the
  // first segment is shorter than a usable domain phrase.
  if (primary.length >= MIN_USEFUL_SUMMARY || primary.length >= text.length) return primary;
  return expandShortSummary(text);
}

function firstSummarySegment(text: string): string {
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

// Extend a too-short first segment up to the start of the trigger/适合/触发词
// enumeration, recognising a 。 / newline boundary (a tagline-first description
// ends sentences with 。, not ；, before those lists — which is exactly why the
// ；-only markers in firstSummarySegment miss them). Falls back to a sentence-
// clipped cap when there is no such section.
function expandShortSummary(text: string): string {
  const sectionPatterns: RegExp[] = [
    /[。；;\n]\s*适合/u,
    /[。；;\n]\s*适用/u,
    /[。；;\n]\s*触发词?/u,
    /[。；;\n]\s*关键词/u,
    /[。.；;\n]\s*(?:suitable for|use when|use for|best for|ideal for|triggers?|keywords?)\b/i,
  ];
  let end = text.length;
  for (const re of sectionPatterns) {
    const m = re.exec(text);
    if (!m) continue;
    const delim = text[m.index];
    // Keep a sentence-ending 。/. so the kept text reads as whole sentences;
    // drop a ；/;/newline clause boundary.
    const stop = delim === '。' || delim === '.' ? m.index + 1 : m.index;
    if (stop < end) end = stop;
  }
  let out = text.slice(0, end).trim();
  if (out.length > MAX_COMPACT_SUMMARY) {
    const clipped = out.slice(0, MAX_COMPACT_SUMMARY);
    const lastStop = clipped.lastIndexOf('。');
    out = (lastStop >= 0 ? clipped.slice(0, lastStop + 1) : clipped).trim();
  }
  return out || firstSummarySegment(text);
}

// Shadowing rank for display-name / role-conflict dedupe. Lower wins; ties
// all stay. Product-owned capability beats user/open tiers only when there is
// an actual conflict; unrelated lower-tier skills still render normally.
// `unknown` is the catch-all for an unrecognized source root: it sits at the
// LOWEST priority so a mis-classified/future source can never shadow a real
// tier by display name (fail toward least trust, not most).
const SOURCE_DEDUPE_RANK: Record<SkillSourceLabel, number> = {
  builtin: 0,
  platform: 1,
  custom: 2,
  external: 3,
  global: 4,
  unknown: 99,
};

function dedupeSkillsByDisplayName<T extends SkillAllowlistRef>(
  specs: T[],
  rankOf: (s: T) => number = (s) => skillSourceRank(s),
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
//   `- builtin: <abs path>\n` +
//   `- platform: <abs path>\n` +
//   `- custom:  <abs path>\n` +
//   `Use these ROOT values verbatim.\n\n` +
//   per-entry lines `- **<display name>** (Source: builtin|platform|custom; internal read id: <id>) — desc`
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
  for (const r of rootEntries) {
    const resolved = path.resolve(r.root);
    if (!labelByRoot.has(resolved)) labelByRoot.set(resolved, r.label);
  }
  // Only print ROOT rows the entry list actually references — open-tier
  // roots with zero surviving entries would be prompt noise.
  const usedLabels = new Set<string>();
  const labelOf = (s: SkillSpec): string => {
    const trusted = skillSourceLabelForSpec(s);
    if (trusted !== 'unknown') return trusted;
    return labelByRoot.get(path.resolve(s.source)) || 'unknown';
  };
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
    // builtin + platform + custom rows always render (stable prompt prefix);
    // other tiers render only when referenced. `custom:` keeps its historical
    // two-space alignment.
    if (r.label === 'builtin' || r.label === 'platform' || r.label === 'custom' || usedLabels.has(r.label)) {
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

function agentPrivateSkillRoots(uid: string, agentId: string): string[] {
  if (!agentId) return [];
  // NOTE: self-evolved skills (`agentEvolvedSkillsDir`, cloud/agents/<id>/skills)
  // are deliberately NOT here. core-agent's evolution SkillStore.buildIndex()
  // injects them into the system prompt itself, so rendering them here too would
  // double-inject. This path is only the Orkas-side prompt block (marketplace
  // agent skills + author-published private_skills).
  return [
    userMarketplaceAgentSkillsDir(uid, agentId),
    agentPrivateSkillsDir(uid, agentId),
  ].map((root) => path.resolve(root));
}

let _agentPrivateLoaders = new Map<string, SkillLoaderInstance>();

async function getAgentPrivateLoader(root: string): Promise<SkillLoaderInstance> {
  const resolved = path.resolve(root);
  const existing = _agentPrivateLoaders.get(resolved);
  if (existing) return existing;
  const m = await import('#core-agent');
  const loader = new m.SkillLoader({ dirs: [resolved] });
  _agentPrivateLoaders.set(resolved, loader);
  return loader;
}

async function loadAgentPrivateSkillSpecs(uid: string, agentId: string): Promise<Array<{ root: string; specs: SkillSpec[] }>> {
  const roots = agentPrivateSkillRoots(uid, agentId).filter((root) => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  });
  if (!roots.length) return [];
  return Promise.all(roots.map(async (root) => {
    const loader = await getAgentPrivateLoader(root);
    return { root, specs: loader.list() as SkillSpec[] };
  }));
}

export interface SkillAllowlistRef {
  id: string;
  name?: string;
  source?: string;
  dir?: string;
  ownerAgent?: string;
}

function _skillRefRank(s: SkillAllowlistRef): number {
  if (!s.source) return SOURCE_DEDUPE_RANK.unknown;
  return skillSourceRank(s);
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

function orderSkillsByRefs<T extends SkillAllowlistRef>(specs: T[], refs: string[]): T[] {
  if (specs.length < 2 || !refs.length) return specs;
  const order = new Map<string, number>();
  for (const ref of refs) {
    const key = String(ref || '').trim().toLowerCase();
    if (!key || order.has(key)) continue;
    order.set(key, order.size);
  }
  if (!order.size) return specs;
  return specs
    .map((s, idx) => {
      const keys = [s.id, s.name].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      const rank = Math.min(...keys.map((k) => order.get(k) ?? Number.POSITIVE_INFINITY));
      return { s, idx, rank };
    })
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map((row) => row.s);
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
        // builtin/platform listed first → product/platform override same-id custom skills.
        dirs: [userMarketplaceSkillsDir(getActiveUserId()), userSkillsDir(getActiveUserId())],
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

/** OPEN-tier dirs the caller's read scope must cover so the rendered
 *  `read_file(<ROOT>/<id>/SKILL.md)` paths actually resolve. Existing dirs
 *  only. Callers pass these as `readOnlyExtraRoots` for group-chat task and
 *  agent-edit authoring turns — same mechanism as the custom/marketplace roots. */
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
 * Search GLOBAL-folder skills by capability. External-package skills are
 * inlined into task/authoring prompts, so this backs the `skill_search` tool
 * only for the still-lazy global tier. Trusted-tier ids win id collisions
 * (dropped here) so a result never points at an ambiguous read path. Ranking
 * is lexical token overlap on name + description; an empty query returns a
 * bounded list ordered by name. Results are capped to `limit` (default 8,
 * max 20); `total_matched` lets the caller know more exist. `disabledIds`
 * (the user's component-disable set, passed in by the feature caller so this
 * model-layer module stays free of `features/*`) is filtered out — a disabled
 * skill never surfaces in search.
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
   * array is passed, renders an empty block — legacy explicit-empty allowlist
   * semantics.
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
   * Group-chat task sessions (`gconv` commander + `gmember` in-process agents)
   * and agent-edit authoring sessions only. Inlines enabled EXTERNAL-package
   * skills into the block (registry-bounded, quality source — so the model sees
   * what's installed and won't re-install it), and appends a static one-line hint
   * pointing at `skill_search` (-> `searchOpenTierSkills`) for the still-lazy
   * GLOBAL-folder tier (unbounded user content). Ignored under an allowlist
   * (project pinning stays trusted-tier-only). Agent metadata uses a separate
   * trusted+external helper and still excludes global-folder skills.
   */
  includeOpenSources?: boolean;
  /**
   * The acting agent's `agent_id` for this render (empty/undefined for the
   * commander and non-agent sessions). Skills tagged `ownerAgent` render ONLY
   * when their owner matches this id — so an agent-private skill never leaks
   * into the commander or any other agent, even when an allowlist names it.
   * Mirrors the agent-private tool `ownerAgent` default-deny gate.
   */
  agentId?: string;
  /**
   * User-explicit skills selected from the composer/picker in addition to an
   * agent's default allowlist. This is primarily for open/global skills, which
   * stay lazy by default but must become visible when the user explicitly asks
   * an agent to use one.
   */
  forceOpenSkillRefs?: string[];
}

/**
 * Markdown block describing available skills — splice this into a
 * system prompt so the LLM knows what's available. Empty string when
 * no skills are found (core-agent treats `""` as "skip the section").
 *
 * When `opts.allowlist` is provided, trusted skills are restricted to that
 * list, then the acting agent's private skills and user-forced open skills
 * are appended. Rendering always goes through `renderSkillLines` so the
 * `Source` label is derived from the exact root path rather than basename.
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
  const marketplaceRoot = path.resolve(userMarketplaceSkillsDir(uid));
  const rootEntries: PromptRootEntry[] = [
    { label: 'builtin', root: marketplaceRoot },
    { label: 'platform', root: marketplaceRoot },
    { label: 'custom', root: path.resolve(userSkillsDir(uid)) },
  ];

  let rendered: typeof specs;
  let allowlisted = false;
  let rawAllow: string[] = [];
  if (opts.allowlist === undefined) {
    rendered = filterDisabled(specs);
  } else {
    allowlisted = true;
    rawAllow = opts.allowlist.filter((id) => typeof id === 'string' && id.length > 0);
    if (rawAllow.length === 0) {
      rendered = [];
    } else {
      const { ids } = resolveSkillAllowlistRefs(specs, rawAllow);
      const allow = new Set([...ids, ...rawAllow]);
      rendered = filterDisabled(specs.filter((s) => allow.has(s.id)));
    }
  }

  const actorAgentId = (opts.agentId || '').trim();
  if (actorAgentId) {
    const existingIds = new Set(rendered.map((s) => s.id));
    let privateIndex = 0;
    for (const { root, specs: privateList } of await loadAgentPrivateSkillSpecs(uid, actorAgentId)) {
      const privateSpecs = filterDisabled(privateList)
        .filter((s) => !s.ownerAgent || s.ownerAgent === actorAgentId)
        .filter((s) => !existingIds.has(s.id));
      if (!privateSpecs.length) continue;
      rootEntries.push({ label: privateIndex === 0 ? 'agent' : `agent${privateIndex + 1}`, root });
      privateIndex++;
      for (const s of privateSpecs) existingIds.add(s.id);
      rendered = [...rendered, ...privateSpecs];
    }
  }

  // EXTERNAL-package skills are inlined for task/authoring sessions
  // (registry-bounded, quality source). GLOBAL-folder skills stay behind
  // `skill_search` (unbounded user content; the hint below points there).
  // Inlining external means a package install/enable busts the session cache
  // prefix — an accepted trade for the model directly seeing installed
  // packages (so it won't try to re-install something already present).
  // Allowlisted render paths stay trusted-only. Agent metadata has its own
  // trusted+external helper, and still excludes the unbounded global tier.
  const openRootSet = new Set<string>();
  const openRankByRoot = new Map<string, number>();
  const addPromptRoot = (label: string, root: string) => {
    const resolved = path.resolve(root);
    if (rootEntries.some((r) => r.label === label && path.resolve(r.root) === resolved)) return;
    rootEntries.push({ label, root: resolved });
  };
  if (opts.includeOpenSources && !allowlisted) {
    const openDirs = _computeOpenTierDirs(uid);
    if (openDirs.external.length) {
      const openLoader = await getOpenLoader(openDirs);
      if (openLoader) {
        openDirs.external.forEach((dir, i) => {
          const resolved = path.resolve(dir);
          openRootSet.add(resolved);
          openRankByRoot.set(resolved, SOURCE_DEDUPE_RANK.external);
          addPromptRoot(i === 0 ? 'external' : `external${i + 1}`, resolved);
        });
        const trustedIds = new Set(rendered.map((s) => s.id));
        const externalSpecs = openLoader.list().filter((s) => {
          if (!openRootSet.has(path.resolve(s.source))) return false;
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

  const forcedOpenRefs = (opts.forceOpenSkillRefs || [])
    .filter((id) => typeof id === 'string' && id.length > 0);
  if (forcedOpenRefs.length) {
    const openDirs = _computeOpenTierDirs(uid);
    const openLoader = await getOpenLoader(openDirs);
    if (openLoader) {
      const externalRoots = openDirs.external.map((d) => path.resolve(d));
      const globalRoots = openDirs.global.map((d) => path.resolve(d));
      const externalSet = new Set(externalRoots);
      const globalSet = new Set(globalRoots);
      const openSpecs = openLoader.list().filter((s) => {
        const root = path.resolve(s.source);
        if (!externalSet.has(root) && !globalSet.has(root)) return false;
        if (disabled && disabled.has(s.id)) return false;
        if (externalSet.has(root)) {
          const meta = packageMetaForSkillDir(uid, s.dir);
          if (!meta.package_name || meta.package_enabled === false) return false;
        }
        return true;
      });
      const { ids } = resolveSkillAllowlistRefs(openSpecs, forcedOpenRefs);
      const allow = new Set([...ids, ...forcedOpenRefs]);
      const existingIds = new Set(rendered.map((s) => s.id));
      const forcedSpecs = openSpecs.filter((s) => allow.has(s.id) && !existingIds.has(s.id));
      for (const s of forcedSpecs) {
        const root = path.resolve(s.source);
        const externalIdx = externalRoots.indexOf(root);
        const globalIdx = globalRoots.indexOf(root);
        if (externalIdx >= 0) {
          openRootSet.add(root);
          openRankByRoot.set(root, SOURCE_DEDUPE_RANK.external);
          addPromptRoot(externalIdx === 0 ? 'external' : `external${externalIdx + 1}`, root);
        } else if (globalIdx >= 0) {
          openRootSet.add(root);
          openRankByRoot.set(root, SOURCE_DEDUPE_RANK.global);
          addPromptRoot(globalIdx === 0 ? 'global' : `global${globalIdx + 1}`, root);
        }
      }
      rendered = [...rendered, ...forcedSpecs];
    }
  }

  // Dedupe by display name; product/platform shadows custom/open tiers
  // (builtin > platform > custom > external > global). When external is merged
  // we pass a root-aware rank so the external roots map to their tier rank;
  // otherwise the default rank applies.
  rendered = openRankByRoot.size
    ? dedupeSkillsByDisplayName(rendered, (s) => {
      const r = openRankByRoot.get(path.resolve(s.source || ''));
      return r !== undefined ? r : skillSourceRank(s);
    })
    : dedupeSkillsByDisplayName(rendered);

  // Agent-private skills (frontmatter `ownerAgent`) render only for their
  // owning agent. Drop owner-tagged specs whose owner isn't THIS actor — hides
  // them from the commander, every other agent, and an allowlist that happens
  // to name them. Applied after dedupe so a private skill can't shadow a
  // same-name shared one for a non-owner. (Mirrors agent-private tool gating.)
  rendered = rendered.filter((s) => !s.ownerAgent || s.ownerAgent === actorAgentId);

  if (allowlisted) {
    rendered = orderSkillsByRefs(rendered, [...rawAllow, ...forcedOpenRefs]);
  }

  // Advertise signal stays trusted-only (`A.custom` / `A.platform`); external
  // entries are rendered but not advertised — their invocation is still
  // attributed downstream via `onSkillInvoked` (B tier).
  if (opts.onSkillAdvertised && rendered.length) {
    for (const s of rendered) {
      if (openRootSet.has(path.resolve(s.source || ''))) continue;
      const label = skillSourceLabelForSpec(s);
      if (label === 'unknown') continue;
      try {
        opts.onSkillAdvertised(s.id, label === 'custom' ? 'A.custom' : 'A.platform');
      } catch { /* callback throws are non-fatal; signal emission is best-effort */ }
    }
  }

  if (opts.displayNameById) {
    for (const s of rendered) {
      if (s.id) opts.displayNameById.set(s.id, s.name || s.id);
    }
  }

  const block = await renderSkillLines(rendered, rootEntries);
  // Task/authoring hint that GLOBAL-folder skills exist behind `skill_search`
  // (external packages are inlined above). Constant (no count) so global-folder
  // changes don't churn the cache prefix. Skipped under an allowlist — pinned
  // render lists stay trusted-only, while authored metadata excludes global.
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
  // Agent-private skills never reach external CLI agents — the orkas-bridge
  // serves the CLI actor, never the in-process owning agent.
  let specs: SkillSpec[] = loader.list().filter((s) => !s.ownerAgent);
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
    return openRank !== undefined ? openRank : skillSourceRank(s);
  });
  return specs.map((s) => {
    const openRank = rankByRoot.get(path.resolve(s.source));
    const source = openRank === SOURCE_DEDUPE_RANK.external ? 'external' : skillSourceLabelForSpec(s);
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
  for (const loader of _agentPrivateLoaders.values()) loader.invalidate();
  _agentPrivateLoaders = new Map();
  if (_loaderPromise) {
    const loader = await _loaderPromise;
    loader.invalidate();
  }
}

/** For diagnostics: return the skill list. Picks a description per the active UI language. */
export async function listSkills(): Promise<Array<{ id: string; name: string; description: string }>> {
  const loader = await getLoader();
  const lang = descriptionLang(getLanguage());
  const pick = await getPickDescription();
  return loader.list().map((s) => ({ id: s.id, name: s.name, description: pick(s, lang) }));
}

function scanSkillIds(root: string): string[] {
  try {
    if (!fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false;
        const dir = path.join(root, entry.name);
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && fs.statSync(dir).isDirectory())) return false;
        return fs.existsSync(path.join(dir, 'SKILL.md'));
      })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function listAgentOwnedSkillIds(uid: string, agentId: string): Promise<string[]> {
  const owner = String(agentId || '').trim();
  if (!uid || !owner) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const clean = String(id || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const { specs: privateList } of await loadAgentPrivateSkillSpecs(uid, owner)) {
    for (const s of privateList) {
      if (!s.ownerAgent || s.ownerAgent === owner) add(s.id);
    }
  }
  for (const id of scanSkillIds(agentEvolvedSkillsDir(uid, owner))) add(id);
  return out;
}

/**
 * Full `SkillSpec[]` snapshot — used by `features/agents.ts` to filter
 * unknown ids out of `agent.skill_list` writes. Goes through the registry
 * singleton so loader caching is shared with `getSystemPromptBlock`.
 *
 * `opts.forAgentId` scopes agent-private (`ownerAgent`) skills: when set,
 * skills owned by a DIFFERENT agent are dropped, so an agent can neither pin
 * another agent's private skill into its `skill_list` nor resolve it at
 * runtime — the owner keeps its own. With no agent context the full list is
 * returned (display-name normalization needs every name).
 */
export async function listSkillSpecs(opts: { forAgentId?: string } = {}): Promise<SkillSpec[]> {
  const loader = await getLoader();
  let specs = loader.list();
  if (opts.forAgentId === undefined) return specs;
  const forAgentId = opts.forAgentId.trim();
  specs = specs.filter((s) => !s.ownerAgent || s.ownerAgent === forAgentId);
  const knownIds = new Set(specs.map((s) => s.id));
  for (const { specs: privateList } of await loadAgentPrivateSkillSpecs(getActiveUserId(), forAgentId)) {
    const next = privateList
      .filter((s) => !s.ownerAgent || s.ownerAgent === forAgentId)
      .filter((s) => !knownIds.has(s.id));
    for (const s of next) knownIds.add(s.id);
    specs = [...specs, ...next];
  }
  return specs;
}

/**
 * Skill refs an agent authoring session may persist in `<skills>` metadata.
 * Includes trusted skills plus enabled external-package skills that are
 * inlined into the edit prompt. Deliberately excludes global-folder skills:
 * they remain searchable/readable for authoring context, but are unbounded
 * machine-global content and should not become synced agent metadata.
 * `opts.forAgentId` applies the same agent-private owner gate as
 * `listSkillSpecs`: another agent's `ownerAgent` skill cannot be persisted in
 * this agent's metadata.
 */
export async function listSkillSpecsForAgentMetadata(
  uid: string,
  opts: { forAgentId?: string } = {},
): Promise<SkillAllowlistRef[]> {
  const loader = await getLoader();
  const forAgentId = opts.forAgentId === undefined ? null : opts.forAgentId.trim();
  let specs: SkillAllowlistRef[] = loader.list();
  if (forAgentId !== null) {
    specs = specs.filter((s) => !s.ownerAgent || s.ownerAgent === forAgentId);
    const knownIds = new Set(specs.map((s) => s.id));
    for (const { specs: privateList } of await loadAgentPrivateSkillSpecs(uid, forAgentId)) {
      const next = privateList
        .filter((s) => !s.ownerAgent || s.ownerAgent === forAgentId)
        .filter((s) => !knownIds.has(s.id));
      for (const s of next) knownIds.add(s.id);
      specs = [...specs, ...next];
    }
  }
  const dirs = _computeOpenTierDirs(uid);
  if (!dirs.external.length) return specs;
  const openLoader = await getOpenLoader(dirs);
  if (!openLoader) return specs;
  const externalSet = new Set(dirs.external.map((d) => path.resolve(d)));
  const trustedIds = new Set(specs.map((s) => s.id));
  const externalSpecs = openLoader.list().filter((s) => {
    if (forAgentId !== null && s.ownerAgent && s.ownerAgent !== forAgentId) return false;
    if (!externalSet.has(path.resolve(s.source))) return false;
    if (trustedIds.has(s.id)) return false;
    const meta = packageMetaForSkillDir(uid, s.dir);
    return !!meta.package_name && meta.package_enabled !== false;
  });
  specs = [...specs, ...externalSpecs];
  return specs;
}
