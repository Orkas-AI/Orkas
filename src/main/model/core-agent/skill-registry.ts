/**
 * SkillRegistry — a single `SkillLoader` over Orkas's two skill roots,
 * shared by every core-agent chat request.
 *
 * Resolution order (见 CLAUDE.md §6)：
 *   1. <uid>/cloud/skills/      (用户自定义，同 id 覆盖 builtin)
 *   2. data/builtin/skills/     (内置，启动时按 hash 同步自 src/builtin/skills)
 *
 * The loader caches by per-dir mtime, so `list()` is effectively free
 * between CRUD events. `features/skills.ts` can call `invalidateSkills()`
 * after a create/update/delete to force a re-scan before the next chat.
 *
 * `来源` 标签在本层计算（`skillSourceLabel`），不依赖 loader 的 basename
 * 推断——per-uid 迁移后两个根都以 `/skills` 结尾，basename 已不可用。
 */

import * as path from 'node:path';

import { BUILTIN_SKILLS_DIR, userSkillsDir } from '../../paths';
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

// `来源` 标签按根路径判定，而不是 `path.basename(source)` —— per-uid 迁移后两个
// skill 根都以 `/skills` 结尾，basename 已失去区分力（见 CLAUDE.md §4）。只有
// `BUILTIN_SKILLS_DIR` 是 builtin，其它（= `userSkillsDir(uid)`）一律 custom。
const BUILTIN_ROOT_RESOLVED = path.resolve(BUILTIN_SKILLS_DIR);
function skillSourceLabel(source: string): 'builtin' | 'custom' {
  return path.resolve(source) === BUILTIN_ROOT_RESOLVED ? 'builtin' : 'custom';
}

async function renderSkillLines(specs: SkillSpec[]): Promise<string> {
  if (!specs.length) return '';
  const lang = getCurrentLang();
  const pick = await getPickDescription();
  const lines = ['## 可用技能 (skills)', ''];
  for (const s of specs) {
    const source = skillSourceLabel(s.source);
    const description = pick(s, lang);
    const desc = description ? ` — ${description}` : '';
    lines.push(`- **${s.name}** (来源: ${source})${desc}`);
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
        dirs: [userSkillsDir(getActiveUserId()), BUILTIN_SKILLS_DIR],
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
 * `renderSkillLines` so the `来源` label is derived from the exact root
 * path rather than basename.
 */
export async function getSystemPromptBlock(opts: SystemPromptBlockOptions = {}): Promise<string> {
  const loader = await getLoader();
  const specs = loader.list();
  const disabled = opts.disabledIds ? new Set(opts.disabledIds) : null;
  const filterDisabled = (list: typeof specs) =>
    disabled && disabled.size ? list.filter((s) => !disabled.has(s.id)) : list;

  if (opts.allowlist === undefined) return renderSkillLines(filterDisabled(specs));

  const rawAllow = opts.allowlist.filter((id) => typeof id === 'string' && id.length > 0);
  if (rawAllow.length === 0) return '';

  const allow = new Set(rawAllow);
  return renderSkillLines(filterDisabled(specs.filter((s) => allow.has(s.id))));
}

/** Drop the internal mtime cache so the next `list()` rescans. */
export async function invalidateSkills(): Promise<void> {
  if (!_loaderPromise) return;
  const loader = await _loaderPromise;
  loader.invalidate();
}

/** For diagnostics: return the skill list. */
export async function listSkills(): Promise<Array<{ id: string; name: string; description: string }>> {
  const loader = await getLoader();
  return loader.list().map((s) => ({ id: s.id, name: s.name, description: s.description }));
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
