/**
 * Skill registry implementation: source loaders, prompt rosters, conflict
 * resolution, and run-scoped logical bindings. The complete runtime policy is
 * `docs/architecture/skill-engineering-contract.md`; do not redefine it here.
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
import { registerUserSwitchHook } from '../../features/user-switch-hooks';
import { getLanguage, getGlobalSkillRootsEnabled } from '../../features/config';
import { descriptionLang } from '../../i18n';
import { SKILL_DESCRIPTION_ROSTER_MAX_CHARS } from '../../util/skill-description-policy';
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
export type SkillSelectionSource = 'marketplace' | 'custom' | 'external' | 'global';
export interface SkillSelectionRef {
  id: string;
  name?: string;
  /** Omitted only by legacy persisted selections. */
  source?: SkillSelectionSource;
}
export type SkillSelectionInput = string | SkillSelectionRef;

// `Source` is decided by root path, not by `path.basename(source)` — several skill roots
// end in `/skills`, so basename is non-discriminating (see CLAUDE.md §4). Resolved per-call
// because the marketplace dir is per-uid; can't pre-resolve to a module-level constant.
// Open-tier roots (external packages / global dirs) are matched by the caller-supplied
// label map in `renderSkillLines`; this fast path only distinguishes the trusted tier and
// is what allowlist ranking + advertise signals rely on.
function skillSourceLabel(source: string, uid = getActiveUserId()): 'platform' | 'custom' | 'unknown' {
  try {
    const resolved = path.resolve(source);
    if (resolved === path.resolve(userSkillsDir(uid))) return 'custom';
    if (resolved === path.resolve(userMarketplaceSkillsDir(uid))) return 'platform';
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

function skillSourceLabelForSpec(
  s: Pick<SkillAllowlistRef, 'source' | 'dir'>,
  uid?: string,
): SkillSourceLabel {
  const base = skillSourceLabel(s.source || '', uid);
  if (base === 'platform' && _isBuiltinMarketplaceSkillDir(s.dir)) return 'builtin';
  return base;
}

function skillSourceRank(s: Pick<SkillAllowlistRef, 'source' | 'dir'>): number {
  return SOURCE_DEDUPE_RANK[skillSourceLabelForSpec(s)];
}

function capPromptDescription(text: string): string {
  if (text.length <= SKILL_DESCRIPTION_ROSTER_MAX_CHARS) return text;
  let end = SKILL_DESCRIPTION_ROSTER_MAX_CHARS - 1;
  const lastIncluded = text.charCodeAt(end - 1);
  const firstOmitted = text.charCodeAt(end);
  if (
    lastIncluded >= 0xD800 && lastIncluded <= 0xDBFF
    && firstOmitted >= 0xDC00 && firstOmitted <= 0xDFFF
  ) {
    end--;
  }
  const visible = text.slice(0, end).trimEnd();
  return `${visible}…`;
}

export function compactPromptDescription(description: string): string {
  const text = String(description || '').trim();
  if (!text) return '';
  // A Skill description is the routing index: capability, typical intent,
  // and any necessary boundary all affect whether the model reads SKILL.md.
  // Do not guess which clauses are expendable. Authors keep entries concise;
  // runtime only enforces the shared visible safety ceiling.
  return capPromptDescription(text);
}

/** Prompt-internal routing descriptions use one stable language so a Chinese
 * UI does not double the roster cost. Source text is unchanged; Chinese is the
 * fallback when an English description is absent. */
export function pickPromptDescription(
  spec: { description_zh?: string; description_en?: string },
): string {
  const en = String(spec.description_en || '').trim();
  const zh = String(spec.description_zh || '').trim();
  return en || zh;
}

/** Injected only after a regular Skill is selected and its entry is read. */
export const SKILL_RUNTIME_REQUIREMENTS_READ_PRELUDE = [
  '## Skill runtime requirements',
  'Resolve requirements declared by this Skill before stopping: use built-in node/npm/npx/python/uv directly, but never install or upgrade those runtimes with brew/apt/curl; report a newer-runtime requirement as a blocker.',
  'For another package or CLI, install once with the Skill\'s stated command and continue; do not retry a failed system-level install. Credentials and paid keys belong in the protected setup/input path, while OAuth or sudo requires the named interactive step. Never request, use, or invent a secret in ordinary chat.',
  'This execution rule does not grant dependency-install authority while authoring or editing a Skill; the creator protocol still applies.',
].join('\n');

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
// Legacy format (callers without a run-scoped binding map):
//   `## Available skills (skills)\n\n` +
//   `\`read_files({"paths":[{"path":"<ROOT>/<id>/SKILL.md"}]})\` — ROOT by Source:\n` +
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
// `read_files`. The roots-in-block form puts the actual values right next to the
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

/** Host-only, run-scoped target for an `@skill/<ref>` read. The map that
 * contains these bindings is created once per AgentRunner build and is never
 * persisted into conversation history. */
export interface SkillRuntimeBinding {
  id: string;
  name: string;
  root: string;
  entry: string;
  source: string;
  /** Optional host-generated context shown immediately before a successful
   * read of this Skill's entry file. It is run-scoped response context, not
   * part of SKILL.md, its hash, or its range coordinates. */
  entryReadPrelude?: string;
}

function isPortableRuntimeRef(value: string): boolean {
  const ref = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(ref);
}

function sameRuntimeBinding(a: SkillRuntimeBinding, b: SkillRuntimeBinding): boolean {
  return path.resolve(a.root) === path.resolve(b.root)
    && path.resolve(a.entry) === path.resolve(b.entry);
}

function reserveRuntimeBinding(
  bindings: Map<string, SkillRuntimeBinding>,
  ref: string,
  binding: SkillRuntimeBinding,
): boolean {
  if (!isPortableRuntimeRef(ref)) return false;
  const existing = bindings.get(ref);
  if (existing) return sameRuntimeBinding(existing, binding);
  bindings.set(ref, binding);
  return true;
}

/** Add one already-resolved Skill to a live runner's logical namespace.
 * Used by lazy discovery: the returned ref points at this exact physical
 * Skill for the current run and never requires a second directory scan. */
export function bindRuntimeSkillTarget(
  binding: SkillRuntimeBinding,
  bindings: Map<string, SkillRuntimeBinding>,
): string {
  for (const candidate of [binding.name.trim(), binding.id, `${binding.source}:${binding.id}`]) {
    if (reserveRuntimeBinding(bindings, candidate, binding)) return candidate;
  }
  let suffix = 1;
  while (true) {
    const candidate = `skill-${bindings.size + suffix++}`;
    if (reserveRuntimeBinding(bindings, candidate, binding)) return candidate;
  }
}

/** Reserve human-readable refs before internal ids, so an unrelated skill id
 * can never steal another skill's display-name alias. Same-name skills remain
 * supported: the first keeps the readable alias and later entries fall back
 * to their unique id (or a source-qualified id in the pathological case). */
function bindRuntimeSkillRefs(
  specs: SkillSpec[],
  labelOf: (s: SkillSpec) => string,
  bindings: Map<string, SkillRuntimeBinding>,
): Map<SkillSpec, string> {
  const refBySpec = new Map<SkillSpec, string>();
  const bindingBySpec = new Map<SkillSpec, SkillRuntimeBinding>();
  const reserve = (ref: string, binding: SkillRuntimeBinding): boolean => (
    reserveRuntimeBinding(bindings, ref, binding)
  );

  for (const spec of specs) {
    const binding: SkillRuntimeBinding = {
      id: spec.id,
      name: spec.name || spec.id,
      root: path.resolve(spec.dir),
      entry: path.resolve(spec.skillFile),
      source: labelOf(spec),
    };
    bindingBySpec.set(spec, binding);
    const preferred = binding.name.trim();
    if (reserve(preferred, binding)) refBySpec.set(spec, preferred);
  }

  for (const [index, spec] of specs.entries()) {
    if (refBySpec.has(spec)) continue;
    const binding = bindingBySpec.get(spec)!;
    const candidates = [binding.id, `${binding.source}:${binding.id}`, `skill-${index + 1}`];
    let fallback = candidates.find((candidate) => reserve(candidate, binding));
    let suffix = 2;
    while (!fallback) {
      const candidate = `skill-${index + 1}-${suffix++}`;
      if (reserve(candidate, binding)) fallback = candidate;
    }
    refBySpec.set(spec, fallback);
  }

  // Keep id lookup as a compatibility alias when it does not conflict with a
  // display-name ref. Prompt entries still advertise the human-readable ref.
  for (const spec of specs) {
    const binding = bindingBySpec.get(spec)!;
    reserve(binding.id, binding);
  }
  return refBySpec;
}

async function renderSkillLines(
  specs: SkillSpec[],
  rootEntries: PromptRootEntry[],
  runtimeBindings?: Map<string, SkillRuntimeBinding>,
): Promise<string> {
  if (!specs.length) return '';
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

  const runtimeRefBySpec = runtimeBindings
    ? bindRuntimeSkillRefs(specs, labelOf, runtimeBindings)
    : null;
  const lines: string[] = ['## Available skills (skills)', ''];
  if (runtimeRefBySpec) {
    lines.push(
      '`read_files({"paths":[{"path":"@skill/<read-ref>"}]})` loads that skill\'s SKILL.md for this run.',
      '`read_files({"paths":[{"path":"@skill/<read-ref>/<relative-path>"}]})` loads a referenced file, template, asset, or script inside the same skill.',
      'Use the exact read ref shown on the matching entry. Do not discover or reconstruct physical skill paths.',
      'These entries are skills, not tool names: read SKILL.md and follow it; never call the display name or id as a tool. Never mention skill ids in plans, workflows, progress, or final replies.',
      '',
    );
  } else {
    lines.push('`read_files({"paths":[{"path":"<ROOT>/<id>/SKILL.md"}]})` — ROOT by Source:');
    for (const r of rootEntries) {
      // builtin + platform + custom rows always render (stable prompt prefix);
      // other tiers render only when referenced. `custom:` keeps its historical
      // two-space alignment.
      if (r.label === 'builtin' || r.label === 'platform' || r.label === 'custom' || usedLabels.has(r.label)) {
        lines.push(`- ${r.label}:${r.label === 'custom' ? '  ' : ' '}${r.root}`);
      }
    }
    lines.push(
      'Use these ROOT values verbatim. `<id>` is the internal read id for read_files paths only, even when it differs from display name.',
      'These entries are skills, not tool names: read SKILL.md and follow it; never call the display name or id as a tool. Never mention skill ids in plans, workflows, progress, or final replies.',
      '',
    );
  }
  for (const s of specs) {
    const source = labelOf(s);
    const description = compactPromptDescription(pickPromptDescription(s));
    const desc = description ? ` — ${description}` : '';
    // When name == id (custom skills authored locally), collapse the redundancy; when they
    // differ (marketplace installs), keep the id explicitly internal so the model can read by
    // path without being primed to repeat the id in user-facing prose.
    const displayName = s.name || s.id;
    const runtimeRef = runtimeRefBySpec?.get(s);
    const internal = runtimeRef
      ? `; read ref: @skill/${runtimeRef}`
      : displayName !== s.id ? `; internal read id: ${s.id}` : '';
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

// The uid is part of the cache identity. This is stronger than relying on an
// async invalidation call from every login/logout path: even if a caller asks
// for the next account immediately, it can never receive the previous
// account's loader or Skill roster.
let _trustedLoader: { uid: string; promise: Promise<SkillLoaderInstance> } | null = null;

async function getLoader(uid = getActiveUserId()): Promise<SkillLoaderInstance> {
  if (!_trustedLoader || _trustedLoader.uid !== uid) {
    const capturedUid = uid;
    _trustedLoader = {
      uid: capturedUid,
      promise: import('#core-agent').then((m) => {
        return new m.SkillLoader({
          // builtin/platform listed first → product/platform override same-id custom skills.
          dirs: [userMarketplaceSkillsDir(capturedUid), userSkillsDir(capturedUid)],
        });
      }),
    };
  }
  return _trustedLoader.promise;
}

// OPEN-tier loader (external packages + global roots). Rebuilt whenever the
// computed dir-set changes — package installs happen out-of-process
// (bin/orkas-pkg.cjs), so the dir list is recomputed per call; the registry
// JSON read behind `enabledPackageSkillRoots` is tiny. Per-dir mtime
// caching inside SkillLoader still avoids re-scanning unchanged dirs.
let _openLoader: { signature: string; loader: SkillLoaderInstance } | null = null;

registerUserSwitchHook('skill-registry', () => {
  // Account activation is synchronous. Drop every filesystem-backed holder
  // synchronously too, before ACTIVE_UID and its roots move to the next user.
  _trustedLoader = null;
  _openLoader = null;
  _agentPrivateLoaders = new Map();
});

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

/** Existing OPEN-tier dirs used for host-side resolution and enforcement.
 * Ordinary Commander turns do not expose these wholesale: global discovery
 * grants only the directories returned by `skill_search`, while explicit user
 * selection creates an exact run-scoped Skill binding. File/exec guards also
 * use this complete set to keep disabled Skills blocked across every source. */
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
  + '`read_files` the returned run-scoped Skill ref before invoking.';

const OPEN_SEARCH_DEFAULT_LIMIT = 5;
const OPEN_SEARCH_MAX_LIMIT = 10;

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
 * bounded list ordered by name. Results are capped to `limit` (default 5,
 * max 10) after the zero-based `offset`; `total_matched` lets the host know
 * more exist. `disabledIds`
 * (the user's component-disable set, passed in by the feature caller so this
 * model-layer module stays free of `features/*`) is filtered out — a disabled
 * skill never surfaces in search.
 */
export async function searchOpenTierSkills(
  uid: string,
  query: string,
  limit?: number,
  disabledIds?: Iterable<string>,
  offset = 0,
): Promise<OpenSkillSearchResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('skill search offset must be a non-negative safe integer');
  }
  const dirs = _computeOpenTierDirs(uid);
  const loader = await getOpenLoader(dirs);
  if (!loader) return { rows: [], total_matched: 0, returned: 0 };

  // External-package skills are now inlined into the commander prompt, so
  // search returns ONLY global-folder skills (the still-lazy tier). The open
  // loader still loads both (cache shared with the prompt/bridge); we filter
  // external out of the results here.
  const externalSet = new Set(dirs.external.map((d) => path.resolve(d)));
  const trustedIds = new Set((await getLoader(uid)).list().map((s) => s.id));
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
  const rows: OpenSkillSearchRow[] = matched.slice(offset, offset + cap).map(({ s, name, fullDesc }) => {
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
   */
  onSkillAdvertised?: (skill_id: string, system: 'A.custom' | 'A.platform') => void;
  /**
   * UI-only display-name collector. `getSystemPromptBlock` already has the
   * filtered SkillSpec list in hand; callers can pass a Map here to reuse
   * that metadata for local process-log rendering without rescanning skills
   * or adding anything to the model prompt.
   */
  displayNameById?: Map<string, string>;
  /** Optional per-run logical-path table. When supplied, this exact filtered
   * render populates it and advertises stable `@skill/<ref>` reads instead of
   * physical roots. Omit for standalone prompt fragments that do not share a
   * live Runner (they retain the legacy absolute-path contract). */
  runtimeBindings?: Map<string, SkillRuntimeBinding>;
  /**
   * Commander task sessions (`gconv`) only.
   * Inlines enabled EXTERNAL-package skills into the block (registry-bounded,
   * quality source — so the model sees
   * what's installed and won't re-install it), and appends a static one-line hint
   * pointing at `skill_search` (-> `searchOpenTierSkills`) for the still-lazy
   * GLOBAL-folder tier (unbounded user content). Ignored under an allowlist
   * (project pinning stays trusted-tier-only). Agent metadata excludes the
   * entire OPEN tier because runtime Agents cannot load it.
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
  forceOpenSkillRefs?: readonly SkillSelectionInput[];
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

  // EXTERNAL-package skills are inlined for Commander task sessions
  // (registry-bounded, quality source). GLOBAL-folder skills stay behind
  // `skill_search` (unbounded user content; the hint below points there).
  // Inlining external means a package install/enable busts the session cache
  // prefix — an accepted trade for the model directly seeing installed
  // packages (so it won't try to re-install something already present).
  // Allowlisted render paths and Agent metadata stay trusted/private only.
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

  const forcedSkillSelections: SkillSelectionRef[] = [];
  const forcedSelectionSeen = new Set<string>();
  for (const input of opts.forceOpenSkillRefs || []) {
    const raw = typeof input === 'string' ? { id: input } : input;
    const id = String(raw?.id || raw?.name || '').trim();
    if (!id) continue;
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    const source = raw?.source;
    const key = `${source || ''}:${id}`;
    if (forcedSelectionSeen.has(key)) continue;
    forcedSelectionSeen.add(key);
    forcedSkillSelections.push({
      id,
      ...(name ? { name } : {}),
      ...(source ? { source } : {}),
    });
  }

  const forcedSpecs: typeof specs = [];
  if (forcedSkillSelections.length) {
    const openDirs = _computeOpenTierDirs(uid);
    const externalRoots = openDirs.external.map((d) => path.resolve(d));
    const globalRoots = openDirs.global.map((d) => path.resolve(d));
    const externalSet = new Set(externalRoots);
    const globalSet = new Set(globalRoots);
    const openSourceByRoot = new Map<string, SkillSelectionSource>();
    for (const root of externalRoots) {
      openSourceByRoot.set(root, 'external');
      openRankByRoot.set(root, SOURCE_DEDUPE_RANK.external);
    }
    for (const root of globalRoots) {
      openSourceByRoot.set(root, 'global');
      openRankByRoot.set(root, SOURCE_DEDUPE_RANK.global);
    }
    // Load the two tiers independently for explicit selection. The ordinary
    // combined open loader intentionally applies first-id-wins dedupe; using it
    // here would erase a selected global same-id row behind an external package.
    const loaderMod = await import('#core-agent');
    const selectableOpenSpecs = [
      ...(externalRoots.length ? new loaderMod.SkillLoader({ dirs: externalRoots }).list() : []),
      ...(globalRoots.length ? new loaderMod.SkillLoader({ dirs: globalRoots }).list() : []),
    ].filter((s) => {
        const root = path.resolve(s.source);
        if (!externalSet.has(root) && !globalSet.has(root)) return false;
        if (disabled && disabled.has(s.id)) return false;
        if (externalSet.has(root)) {
          const meta = packageMetaForSkillDir(uid, s.dir);
          if (!meta.package_name || meta.package_enabled === false) return false;
        }
        return true;
      });
    const selectableTrustedSpecs = filterDisabled(specs);
    const selectableSpecs = [...selectableTrustedSpecs, ...selectableOpenSpecs];
    const selectedSourceOf = (s: SkillAllowlistRef): SkillSelectionSource | null => {
      const openSource = openSourceByRoot.get(path.resolve(s.source || ''));
      if (openSource) return openSource;
      const label = skillSourceLabelForSpec(s);
      if (label === 'builtin' || label === 'platform') return 'marketplace';
      if (label === 'custom') return 'custom';
      return null;
    };
    const selectionRank = (s: SkillAllowlistRef): number => {
      const openRank = openRankByRoot.get(path.resolve(s.source || ''));
      return openRank !== undefined ? openRank : skillSourceRank(s);
    };
    const physicalKey = (s: SkillAllowlistRef): string => (
      `${path.resolve(s.source || s.dir || '')}\0${s.id}`
    );
    const selectedPhysical = new Set<string>();
    for (const selection of forcedSkillSelections) {
      const scoped = selection.source
        ? selectableSpecs.filter((s) => selectedSourceOf(s) === selection.source)
        : selectableSpecs;
      let matches = scoped.filter((s) => s.id === selection.id);
      // Source-aware selections carry the stable id written by the picker.
      // Falling back to a display name here could silently bind a different
      // Skill after the selected one was removed or renamed. Name fallback is
      // retained only for legacy source-less records.
      if (!matches.length && !selection.source) {
        const aliases = new Set([selection.id, selection.name].filter(Boolean));
        matches = scoped.filter((s) => aliases.has(s.name || s.id));
      }
      matches.sort((a, b) => selectionRank(a) - selectionRank(b));
      const selected = matches[0];
      // A source-aware selection is exact-or-missing. Never substitute a
      // same-id Skill from another tier when the chosen tier disappeared.
      if (!selected) continue;
      const selectedKey = physicalKey(selected);
      if (selectedPhysical.has(selectedKey)) continue;
      selectedPhysical.add(selectedKey);
      forcedSpecs.push(selected);
      if (selectedSourceOf(selected) === 'external' || selectedSourceOf(selected) === 'global') {
        const s = selected;
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
    }
  }

  // Explicit source-aware selections win conflicts with the resident surface.
  // Multiple explicitly selected same-id tiers are retained and receive
  // distinct run-scoped read refs; only non-selected candidates are deduped.
  const forcedPhysicalKeys = new Set(forcedSpecs.map((s) => (
    `${path.resolve(s.source || s.dir || '')}\0${s.id}`
  )));
  const forcedIds = new Set(forcedSpecs.map((s) => s.id));
  const forcedNames = new Set(forcedSpecs.map((s) => (s.name || s.id).trim()));
  rendered = rendered.filter((s) => {
    const physical = `${path.resolve(s.source || s.dir || '')}\0${s.id}`;
    if (forcedPhysicalKeys.has(physical)) return false;
    return !forcedIds.has(s.id) && !forcedNames.has((s.name || s.id).trim());
  });

  // Dedupe the remaining resident surface by display name; product/platform
  // shadows custom/open tiers
  // (builtin > platform > custom > external > global). When external is merged
  // we pass a root-aware rank so the external roots map to their tier rank;
  // otherwise the default rank applies.
  rendered = openRankByRoot.size
    ? dedupeSkillsByDisplayName(rendered, (s) => {
      const r = openRankByRoot.get(path.resolve(s.source || ''));
      return r !== undefined ? r : skillSourceRank(s);
    })
    : dedupeSkillsByDisplayName(rendered);

  if (allowlisted) {
    rendered = orderSkillsByRefs(rendered, rawAllow);
  }
  rendered = [...rendered, ...forcedSpecs];

  // Agent-private skills (frontmatter `ownerAgent`) render only for their
  // owning agent. Drop owner-tagged specs whose owner isn't THIS actor — hides
  // them from the commander, every other agent, and an allowlist that happens
  // to name them. Applied after dedupe so a private skill can't shadow a
  // same-name shared one for a non-owner. (Mirrors agent-private tool gating.)
  rendered = rendered.filter((s) => !s.ownerAgent || s.ownerAgent === actorAgentId);

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

  const block = await renderSkillLines(rendered, rootEntries, opts.runtimeBindings);
  // Commander-task hint that GLOBAL-folder skills exist behind `skill_search`
  // (external packages are inlined above). Constant (no count) so global-folder
  // changes don't churn the cache prefix. Skipped under an allowlist — pinned
  // render lists stay trusted-only, while authored metadata excludes global.
  if (opts.includeOpenSources && !allowlisted) {
    return block ? `${block}\n\n${OPEN_TIER_SKILL_HINT}` : OPEN_TIER_SKILL_HINT;
  }
  return block;
}

export async function getSystemSkillsPromptBlock(
  uid?: string,
  runtimeBindings?: Map<string, SkillRuntimeBinding>,
  allowlist?: readonly string[],
  exclude?: readonly string[],
): Promise<string> {
  const resolvedUid = uid || getActiveUserId();
  const root = path.resolve(userSystemSkillsDir(resolvedUid));
  const loaderMod = await import('#core-agent');
  const loader = new loaderMod.SkillLoader({ dirs: [root] });
  const allSpecs = loader.list();
  const allowlistedSpecs = allowlist === undefined
    ? allSpecs
    : allSpecs.filter((spec) => allowlist.includes(spec.id));
  const excludedIds = exclude?.length ? new Set(exclude) : null;
  const specs = excludedIds
    ? allowlistedSpecs.filter((spec) => !excludedIds.has(spec.id))
    : allowlistedSpecs;
  if (!specs.length) return '';
  const labelOf = () => 'system';
  const runtimeRefBySpec = runtimeBindings
    ? bindRuntimeSkillRefs(specs, labelOf, runtimeBindings)
    : null;
  const lines = [
    '## System skills',
    '',
    'System skills are product protocols. They are not marketplace or custom skills.',
    '',
    'Match the whole request against every description. Before other work, read the smallest complete set of matching SKILL.md files; never load nonmatches.',
    '',
    'Read one match:',
    runtimeRefBySpec
      ? '`read_files({"paths":[{"path":"@skill/<read-ref>"}]})` using the exact read ref on the matching entry.'
      : '`read_files({"paths":[{"path":"<SYSTEM_SKILLS_ROOT>/<id>/SKILL.md"}]})`',
    '',
    'Read 2+ matches together first:',
    runtimeRefBySpec
      ? '`read_files({"paths":[{"path":"@skill/<read-ref-1>"},{"path":"@skill/<read-ref-2>"}]})` using the exact read refs on the matching entries.'
      : '`read_files({"paths":[{"path":"<SYSTEM_SKILLS_ROOT>/<id-1>/SKILL.md"},{"path":"<SYSTEM_SKILLS_ROOT>/<id-2>/SKILL.md"}]})`',
    'Load only system SKILL.md files in that call; read attachments and other task sources afterward.',
    ...(runtimeRefBySpec ? [] : ['', 'SYSTEM_SKILLS_ROOT:', root]),
    '',
  ];
  for (const s of specs) {
    const displayName = s.name || s.id;
    const description = compactPromptDescription(pickPromptDescription(s));
    const desc = description ? ` — ${description}` : '';
    const runtimeRef = runtimeRefBySpec?.get(s);
    lines.push(`- **${displayName}**${runtimeRef ? ` (read ref: @skill/${runtimeRef})` : ''}${desc}`);
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
  const loader = await getLoader(uid);
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
    return openRank !== undefined ? openRank : SOURCE_DEDUPE_RANK[skillSourceLabelForSpec(s, uid)];
  });
  return specs.map((s) => {
    const openRank = rankByRoot.get(path.resolve(s.source));
    const source = openRank === SOURCE_DEDUPE_RANK.external ? 'external' : skillSourceLabelForSpec(s, uid);
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
  const trusted = _trustedLoader;
  _trustedLoader = null;
  _openLoader = null;
  for (const loader of _agentPrivateLoaders.values()) loader.invalidate();
  _agentPrivateLoaders = new Map();
  if (trusted) {
    const loader = await trusted.promise;
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
 * Includes only trusted shared skills and the target Agent's private skills.
 * External-package and global-folder Skills are Commander-only: admitting
 * their ids here would persist a dependency that runtime Agent resolution
 * deliberately cannot load.
 * `opts.forAgentId` applies the same agent-private owner gate as
 * `listSkillSpecs`: another agent's `ownerAgent` skill cannot be persisted in
 * this agent's metadata.
 */
export async function listSkillSpecsForAgentMetadata(
  uid: string,
  opts: { forAgentId?: string } = {},
): Promise<SkillAllowlistRef[]> {
  const loader = await getLoader(uid);
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
  return specs;
}
