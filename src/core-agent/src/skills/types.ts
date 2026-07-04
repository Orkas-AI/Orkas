/**
 * A single skill discovered on disk.
 *
 * `id` is the subdirectory name (matches openclaw conventions);
 * descriptions come from Orkas `_meta.json` when present, falling back to
 * SKILL.md frontmatter for portable skills. `dir` is the absolute path to
 * the skill's root — callers read SKILL.md or other files relative to this.
 */
export interface SkillSpec {
  /** Subdirectory name (also the skill id). */
  id: string;
  /** Display name from SKILL.md `name`, falling back to `id`. */
  name: string;
  /** Chinese description (zh locale). May be empty. */
  description_zh: string;
  /** English description (en locale). May be empty. */
  description_en: string;
  /** Absolute path to the skill's root directory. */
  dir: string;
  /** Absolute path to SKILL.md. */
  skillFile: string;
  /** Where this skill was loaded from (which `dirs` entry). */
  source: string;
  /** When set, the skill is PRIVATE to the named owning agent (its
   *  `agent_id`). Hosts that render skills into a prompt or UI use this to
   *  gate exposure: render only for that agent, hide from every other actor
   *  (commander, other agents) and from user-facing skill lists. Absent =
   *  normal shared skill. Parsed from SKILL.md frontmatter `ownerAgent`. */
  ownerAgent?: string;
}

function descriptionLocale(lang: string): 'zh' | 'en' {
  return String(lang || '').split(/[-_]/)[0] === 'zh' ? 'zh' : 'en';
}

/** Pick a description for a target language with cross-language fallback.
 *
 *  Description storage is intentionally zh/en only: non-Chinese UI languages
 *  use English first. Cross-fallback guarantees non-empty when any description
 *  exists, so the user never sees a blank entry just because the matching
 *  locale hasn't been filled. Loader migrates legacy single-`description`
 *  files into one of the two slots at parse time. */
export function pickDescription(
  spec: { description_zh?: string; description_en?: string },
  lang: string,
): string {
  const primaryLocale = descriptionLocale(lang);
  const primary = spec[`description_${primaryLocale}`];
  if (primary && primary.trim()) return primary.trim();
  const fallbackLocale = ({ zh: 'en', en: 'zh' } as const)[primaryLocale];
  const fallback = spec[`description_${fallbackLocale}`];
  return (fallback || '').trim();
}

/** Input to `SkillLoader`. */
export interface SkillLoaderOptions {
  /**
   * List of directories to scan. Each entry may be any absolute path; its
   * immediate subdirectories are inspected for a SKILL.md. When the same
   * skill id appears in multiple entries, the FIRST occurrence wins (i.e.,
   * put higher-priority roots earlier — typically `[customDir, builtinDir]`).
   */
  dirs: string[];
}
