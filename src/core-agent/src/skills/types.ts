/**
 * A single skill discovered on disk.
 *
 * `id` is the subdirectory name (matches openclaw conventions); `description`
 * comes from the SKILL.md YAML frontmatter. `dir` is the absolute path to
 * the skill's root — callers read SKILL.md or other files relative to this.
 *
 * Invariant: `name === id` always. Frontmatter `name` is enforced equal to
 * the directory name by `features/skills.ts` on write, and re-aligned by
 * `SkillLoader.parseSpec` on read. The separate `name` field is kept only
 * for consumer API stability.
 */
export interface SkillSpec {
  /** Subdirectory name (also the skill id). */
  id: string;
  /** Display name — always equal to `id`. */
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
}

/** Pick a description for a target language with cross-language fallback.
 *
 *  `lang === 'zh'`: `description_zh` || `description_en` || `''`. Mirror for
 *  `'en'`. Cross-fallback guarantees non-empty when any description exists,
 *  so the user never sees a blank entry just because the matching locale
 *  hasn't been filled. Loader migrates legacy single-`description` files
 *  into one of the two slots at parse time — nothing else needs to look at
 *  the legacy field. */
export function pickDescription(
  spec: { description_zh?: string; description_en?: string },
  lang: 'zh' | 'en',
): string {
  const zh = (spec.description_zh || '').trim();
  const en = (spec.description_en || '').trim();
  if (lang === 'zh') return zh || en || '';
  return en || zh || '';
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
