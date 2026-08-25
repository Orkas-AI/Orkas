import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { SkillLoaderOptions, SkillSpec } from "./types.js";
import { pickDescription } from "./types.js";
import { errorCodeForLog } from "../shared/errors.js";

const log = createLogger("skill-loader");

interface SkillOrkasMeta {
  descriptions?: { zh?: string; en?: string; [lang: string]: string | undefined };
  description_zh?: string;
  description_en?: string;
}

function normalizeDescription(value: string | undefined): string {
  return String(value || "")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SkillLoader scans one or more directories for `SKILL.md` files and
 * returns a de-duplicated `SkillSpec[]`.
 *
 * Caching: the list is cached by root inventory plus each immediate Skill's
 * `SKILL.md` / `_meta.json` metadata stamp. This catches in-place edits made
 * by external hosts without re-reading or reparsing every frontmatter block
 * on an unchanged turn. Callers may still call `invalidate()` after known
 * mutations to force a fresh scan.
 *
 * De-duplication: when the same skill id appears in multiple dirs, the
 * FIRST occurrence wins. Put higher-priority roots earlier — for example,
 * Orkas passes `[marketplaceDir, customDir]` so builtin/platform installs
 * beat custom skills on id conflicts.
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

  /** List all skills, de-duplicated. Cached by inventory/file metadata. */
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
        log.warn("skill root read failed", { code: errorCodeForLog(err) });
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        // Accept real dirs AND symlinks that resolve to a directory. Global
        // skill roots like `~/.claude/skills` commonly hold each skill as a
        // symlink into a shared store; `Dirent.isDirectory()` is false for a
        // symlink, so it must be resolved (statSync follows links) or those
        // skills silently vanish from the listing.
        if (!e.isDirectory() && !(e.isSymbolicLink() && this.isDir(path.join(dir, e.name)))) continue;
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
   * `lang` selects which description is rendered; unsupported description
   * locales use English first, then fall back per
   * `pickDescription`. Defaults to `'en'` for safety in non-UI callers.
   */
  // Default convenience renderer for hosts without their own block builder.
  // **Orkas does NOT use this in production** — it ships its own renderer
  // at `src/main/model/core-agent/skill-registry.ts::renderSkillLines` that
  // (a) decides Source label by the resolved root path (basename collides
  // when both roots end in `/skills`) and (b) gives production runners a
  // host-resolved `@skill/<ref>` while retaining the absolute-root format for
  // standalone prompt fragments. Other hosts may use
  // this default helper, in which case Source is taken from the dirs[]
  // basename.
  renderSystemPromptBlock(lang: string = 'en'): string {
    const skills = this.list();
    if (!skills.length) return "";
    const lines = ["## Available skills (skills)", ""];
    for (const s of skills) {
      const source = path.basename(s.source);
      const description = pickDescription(s, lang);
      const desc = description ? ` — ${description}` : "";
      lines.push(`- **${s.id}** (Source: ${source})${desc}`);
    }
    return lines.join("\n");
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private parseSpec(dir: string, skillFile: string, source: string): SkillSpec | null {
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, "utf-8");
    } catch (err) {
      log.warn("skill file read failed", { code: errorCodeForLog(err) });
      return null;
    }
    const { data } = parseFrontmatter(raw);
    const sidecar = this.readOrkasMeta(dir);
    // `id` = dir basename (always unique within the loader's roots, used as the read_file
    // path component). `name` = frontmatter human-readable display label; falls back to
    // the id when frontmatter is missing one. Decoupled because marketplace installs land
    // under `<server-id>/` (hex string) but should still surface their authored name to
    // the LLM picker — see `docs/architecture/skill-engineering-contract.md`
    // and `skill-registry::renderSkillLines`.
    const id = path.basename(dir);
    const declaredName = (data.name && data.name.trim()) || id;
    // Migrate legacy single-`description` into the matching language slot.
    // Heuristic: if it contains any CJK ideograph it lands in `_zh`, else
    // `_en`. Explicit `description_zh` / `description_en` always win, even
    // when legacy field is also present — explicit > inferred.
    const legacy = normalizeDescription(data.description);
    const explicitZh = normalizeDescription(data.description_zh);
    const explicitEn = normalizeDescription(data.description_en);
    const legacyHasChinese = /[一-鿿]/.test(legacy);
    const sidecarDescriptions = sidecar.descriptions || {};
    const sidecarZh = normalizeDescription(sidecarDescriptions.zh || sidecar.description_zh);
    const sidecarEn = normalizeDescription(sidecarDescriptions.en || sidecar.description_en);
    // Agent-private ownership tag (frontmatter `ownerAgent`). Trimmed; empty
    // → undefined (a shared skill). Hosts gate prompt/UI exposure on this.
    const ownerAgent = (typeof data.ownerAgent === "string" && data.ownerAgent.trim()) || undefined;
    return {
      id,
      name: declaredName,
      // Platform-managed packages own their localized descriptions directly
      // in SKILL.md. A sidecar pair remains a compatibility fallback for
      // custom and older external packages, and a single portable
      // `description` remains the last fallback.
      description_zh: explicitZh || sidecarZh || (legacy && legacyHasChinese ? legacy : ""),
      description_en: explicitEn || sidecarEn || (legacy && !legacyHasChinese ? legacy : ""),
      dir,
      skillFile,
      source,
      ...(ownerAgent ? { ownerAgent } : {}),
    };
  }

  private readOrkasMeta(dir: string): SkillOrkasMeta {
    const file = path.join(dir, "_meta.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as SkillOrkasMeta : {};
    } catch {
      return {};
    }
  }

  private dirStamp(): string {
    const parts: string[] = [];
    for (const d of this.dirs) {
      try {
        const st = fs.statSync(d, { bigint: true });
        parts.push(`${d}:root:${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`);
      } catch {
        parts.push(`${d}:missing`);
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        parts.push(`${d}:unreadable`);
        continue;
      }
      for (const entry of entries) {
        const skillDir = path.join(d, entry.name);
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && this.isDir(skillDir))) continue;
        parts.push(this.fileStamp(path.join(skillDir, "SKILL.md")));
        parts.push(this.fileStamp(path.join(skillDir, "_meta.json")));
      }
    }
    return parts.join("|");
  }

  private fileStamp(file: string): string {
    try {
      const st = fs.statSync(file, { bigint: true });
      // ctime catches same-size rewrites even when an external host restores
      // mtime; inode also catches atomic replacement with preserved metadata.
      return `${file}:${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
    } catch {
      return `${file}:missing`;
    }
  }

  private isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); }
    catch { return false; }
  }
}
