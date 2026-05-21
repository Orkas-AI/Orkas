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
import { getCurrentLang } from '../../i18n';
// `pickDescription` is loaded lazily — see CLAUDE.md §3: any static import
// from `#core-agent` at module load would pull in pi-ai before
// `sdk-timeout-patch` has had a chance to monkey-patch it. The cached fn is
// hydrated on first render call, after the loader is already initialized.
type PickDescription = (s: { description_zh?: string; description_en?: string }, lang: 'zh' | 'en') => string;
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

// Render the system-prompt block listing every skill the LLM can use.
//
// Format:
//   `## Available skills (skills)\n\n` +
//   `\`read_file(<ROOT>/<id>/SKILL.md)\` — ROOT by Source:\n` +
//   `- custom:  <abs path>\n` +
//   `- builtin: <abs path>\n` +
//   `Use these ROOT values verbatim; do NOT use training-prior layouts (e.g. \`/data/custom/skills/\`).\n\n` +
//   per-entry lines `- **<id>** (Source: custom|builtin) — desc`
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
  const lang = getCurrentLang();
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
    'Use these ROOT values verbatim. `<id>` is the directory name shown after each entry; use it in the path even when it differs from the display name.',
    '',
  ];
  for (const s of specs) {
    const source = skillSourceLabel(s.source);
    const description = pick(s, lang);
    const desc = description ? ` — ${description}` : '';
    // When name == id (custom skills authored locally), collapse the redundancy; when they
    // differ (marketplace installs), surface both so the model can pick by name and read by id.
    const head = s.name && s.name !== s.id ? `**${s.name}** (id: ${s.id})` : `**${s.id}**`;
    lines.push(`- ${head} (Source: ${source})${desc}`);
  }
  return lines.join('\n');
}

type CoreAgent = typeof import('#core-agent');
type SkillLoaderCtor = CoreAgent['SkillLoader'];
type SkillLoaderInstance = InstanceType<SkillLoaderCtor>;
type SkillSpec = ReturnType<SkillLoaderInstance['list']>[number];

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
   * Unknown ids are silently dropped (skill may have been deleted since the
   * agent was configured); a warn-level log surfaces the mismatch.
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

  if (opts.allowlist === undefined) return renderSkillLines(filterDisabled(specs), customRoot, builtinRoot);

  const rawAllow = opts.allowlist.filter((id) => typeof id === 'string' && id.length > 0);
  if (rawAllow.length === 0) return '';

  const allow = new Set(rawAllow);
  return renderSkillLines(filterDisabled(specs.filter((s) => allow.has(s.id))), customRoot, builtinRoot);
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
  const lang = getCurrentLang();
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
