import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { SkillLoaderOptions, SkillSpec } from "./types.js";
import { pickDescription } from "./types.js";

const log = createLogger("skill-loader");

/**
 * SkillLoader scans one or more directories for `SKILL.md` files and
 * returns a de-duplicated `SkillSpec[]`.
 *
 * Caching: the list is cached per `(dir, mtimeMs)` tuple — as long as the
 * directory's mtime hasn't changed we reuse the previous scan. Callers that
 * add/remove skill directories out-of-band can call `invalidate()` to force
 * a fresh scan on the next `list()`.
 *
 * De-duplication: when the same skill id appears in multiple dirs, the
 * FIRST occurrence wins. Put higher-priority roots earlier — for example,
 * Orkas passes `[customDir, builtinDir]` so user overrides beat shipped
 * defaults, matching openclaw's skill resolution.
 *
 * No skill bodies are loaded here — only frontmatter. Callers that need the
 * body read `spec.skillFile` themselves. This keeps list() cheap enough to
 * call on every turn.
 */
export class SkillLoader {
  private readonly dirs: string[];
  private cache: { stamp: string; skills: SkillSpec[] } | null = null;

  constructor(opts: SkillLoaderOptions) {
    this.dirs = [...opts.dirs];
  }

  /** List all skills, de-duplicated. Cached by per-dir mtime. */
  list(): SkillSpec[] {
    const stamp = this.dirStamp();
    if (this.cache && this.cache.stamp === stamp) return this.cache.skills;

    const seen = new Map<string, SkillSpec>();
    for (const dir of this.dirs) {
      if (!this.isDir(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        log.warn(`failed to read ${dir}: ${(err as Error).message}`);
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".")) continue;
        const skillDir = path.join(dir, e.name);
        const skillFile = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        if (seen.has(e.name)) continue; // first-wins
        const spec = this.parseSpec(skillDir, skillFile, dir);
        if (spec) seen.set(e.name, spec);
      }
    }

    const skills = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
    this.cache = { stamp, skills };
    return skills;
  }

  /** Drop the cache; the next `list()` will re-scan. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Render a markdown block listing every available skill. Suitable for
   * splicing into a system prompt so the LLM knows what skills exist and
   * when to reach for each one. Returns empty string if no skills.
   *
   * `lang` selects which description (zh / en) is rendered; falls back per
   * `pickDescription`. Defaults to `'en'` for safety in non-UI callers.
   */
  renderSystemPromptBlock(lang: 'zh' | 'en' = 'en'): string {
    const skills = this.list();
    if (!skills.length) return "";
    const lines = ["## 可用技能 (skills)", ""];
    for (const s of skills) {
      const source = path.basename(s.source);
      const description = pickDescription(s, lang);
      const desc = description ? ` — ${description}` : "";
      lines.push(`- **${s.id}** (来源: ${source})${desc}`);
    }
    return lines.join("\n");
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private parseSpec(dir: string, skillFile: string, source: string): SkillSpec | null {
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, "utf-8");
    } catch (err) {
      log.warn(`failed to read ${skillFile}: ${(err as Error).message}`);
      return null;
    }
    const { data } = parseFrontmatter(raw);
    const id = path.basename(dir);
    // Invariant: frontmatter `name` must equal the directory name (id).
    // The edit UI (`features/skills.ts::updateCustomSkill`) already renames
    // dir + rewrites frontmatter atomically, so divergence only happens
    // when a SKILL.md is hand-edited. Override silently here and log so
    // the drift surfaces in dev logs without breaking the load.
    const declaredName = data.name && data.name.trim();
    if (declaredName && declaredName !== id) {
      log.warn(`skill ${id}: frontmatter name "${declaredName}" differs from dir; using dir name`);
    }
    // Migrate legacy single-`description` into the matching language slot.
    // Heuristic: if it contains any CJK ideograph it lands in `_zh`, else
    // `_en`. Explicit `description_zh` / `description_en` always win, even
    // when legacy field is also present — explicit > inferred.
    const legacy = (data.description && data.description.trim()) || "";
    const explicitZh = (data.description_zh && data.description_zh.trim()) || "";
    const explicitEn = (data.description_en && data.description_en.trim()) || "";
    const legacyHasChinese = /[一-鿿]/.test(legacy);
    return {
      id,
      name: id,
      description_zh: explicitZh || (legacy && legacyHasChinese ? legacy : ""),
      description_en: explicitEn || (legacy && !legacyHasChinese ? legacy : ""),
      dir,
      skillFile,
      source,
    };
  }

  private dirStamp(): string {
    const parts: string[] = [];
    for (const d of this.dirs) {
      try {
        const st = fs.statSync(d);
        parts.push(`${d}:${st.mtimeMs}`);
      } catch {
        parts.push(`${d}:missing`);
      }
    }
    return parts.join("|");
  }

  private isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); }
    catch { return false; }
  }
}
