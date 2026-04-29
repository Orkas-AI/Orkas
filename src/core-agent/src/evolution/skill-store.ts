import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import type { Skill, SkillSummary, SkillFrontmatter, EvolutionConfig } from "./types.js";

const log = createLogger("skill-store");

const SKILL_FILENAME = "SKILL.md";
const NAME_MAX_LEN = 64;
const DESC_MAX_LEN = 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * SkillStore manages learned skills on the filesystem.
 *
 * Each skill lives in its own directory as a SKILL.md file with
 * YAML frontmatter (name, description, timestamps, patchCount, tags)
 * and a markdown body containing procedures/instructions.
 *
 * Modeled after Hermes-Agent's skill_manager_tool.py.
 */
export class SkillStore {
  private readonly skillsDir: string;
  private readonly config: EvolutionConfig;

  constructor(skillsDir: string, config: EvolutionConfig) {
    this.skillsDir = path.resolve(skillsDir);
    this.config = config;
  }

  /** Ensure the skills directory exists. */
  async init(): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
  }

  /** List all skills (summary only, no full body). */
  async list(): Promise<SkillSummary[]> {
    await this.init();
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const summaries: SkillSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skill = await this.read(entry.name);
        if (skill) {
          summaries.push({
            id: skill.id,
            name: skill.frontmatter.name,
            description: skill.frontmatter.description,
            createdAt: skill.frontmatter.createdAt,
            updatedAt: skill.frontmatter.updatedAt,
            patchCount: skill.frontmatter.patchCount,
            tags: skill.frontmatter.tags,
            lastUsedAt: skill.frontmatter.lastUsedAt,
          });
        }
      } catch {
        log.warn(`Skipping invalid skill directory: ${entry.name}`);
      }
    }

    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read a skill by its id (directory name). Returns null if not found. */
  async read(id: string): Promise<Skill | null> {
    const skillPath = path.join(this.skillsDir, id, SKILL_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(skillPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const { frontmatter, body } = parseFrontmatter(raw);
    return { id, frontmatter, body, path: skillPath };
  }

  /** Create a new skill. Returns the created skill or throws on validation error. */
  async create(opts: {
    id: string;
    name: string;
    description: string;
    body: string;
    tags?: string[];
  }): Promise<Skill> {
    // Validate
    this.validateId(opts.id);
    this.validateName(opts.name);
    this.validateDescription(opts.description);

    const fullContent = opts.body.length;
    if (fullContent > this.config.maxSkillContentLength) {
      throw new Error(
        `Skill content too long: ${fullContent} chars (max ${this.config.maxSkillContentLength})`,
      );
    }

    // Check name collision
    const existing = await this.read(opts.id);
    if (existing) {
      throw new Error(`Skill already exists: ${opts.id}`);
    }

    // LRU eviction when at capacity
    const all = await this.list();
    if (all.length >= this.config.maxSkills) {
      const evicted = this.pickLruCandidate(all);
      if (evicted) {
        log.info(`Evicting least-recently-used skill "${evicted.id}" to make room (${all.length}/${this.config.maxSkills})`);
        await this.delete(evicted.id);
      } else {
        throw new Error(`Maximum skill limit reached (${this.config.maxSkills}) and no eviction candidate found`);
      }
    }

    const now = new Date().toISOString();
    const frontmatter: SkillFrontmatter = {
      name: opts.name,
      description: opts.description,
      createdAt: now,
      updatedAt: now,
      patchCount: 0,
      tags: opts.tags,
    };

    const content = serializeFrontmatter(frontmatter) + opts.body;
    const skillDir = path.join(this.skillsDir, opts.id);
    const skillPath = path.join(skillDir, SKILL_FILENAME);

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, content, "utf-8");

    log.info(`Created skill: ${opts.id}`);
    return { id: opts.id, frontmatter, body: opts.body, path: skillPath };
  }

  /**
   * Patch an existing skill by replacing text in its body.
   * Uses simple string replacement (exact match).
   */
  async patch(
    id: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<Skill> {
    const skill = await this.read(id);
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }

    if (oldString === newString) {
      throw new Error("old_string and new_string are identical");
    }

    if (!skill.body.includes(oldString)) {
      throw new Error(
        `old_string not found in skill body. ` +
        `Skill body starts with: "${skill.body.slice(0, 100)}..."`,
      );
    }

    let newBody: string;
    if (replaceAll) {
      newBody = skill.body.split(oldString).join(newString);
    } else {
      const idx = skill.body.indexOf(oldString);
      newBody =
        skill.body.slice(0, idx) + newString + skill.body.slice(idx + oldString.length);
    }

    if (newBody.length > this.config.maxSkillContentLength) {
      throw new Error(
        `Patched content too long: ${newBody.length} chars (max ${this.config.maxSkillContentLength})`,
      );
    }

    const updatedFrontmatter: SkillFrontmatter = {
      ...skill.frontmatter,
      updatedAt: new Date().toISOString(),
      patchCount: skill.frontmatter.patchCount + 1,
    };

    const content = serializeFrontmatter(updatedFrontmatter) + newBody;
    await fs.writeFile(skill.path, content, "utf-8");

    log.info(`Patched skill: ${id} (patch #${updatedFrontmatter.patchCount})`);
    return { id, frontmatter: updatedFrontmatter, body: newBody, path: skill.path };
  }

  /** Delete a skill by id. Returns true if deleted, false if not found. */
  async delete(id: string): Promise<boolean> {
    const skillDir = path.join(this.skillsDir, id);
    try {
      await fs.rm(skillDir, { recursive: true });
      log.info(`Deleted skill: ${id}`);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /** Update lastUsedAt timestamp for a skill (called on skill_manage read). */
  async touch(id: string): Promise<void> {
    const skill = await this.read(id);
    if (!skill) return;

    const updatedFrontmatter: SkillFrontmatter = {
      ...skill.frontmatter,
      lastUsedAt: new Date().toISOString(),
    };

    const content = serializeFrontmatter(updatedFrontmatter) + skill.body;
    await fs.writeFile(skill.path, content, "utf-8");
  }

  /** Build a concise skills index string for system prompt injection.
   *  When `allowlist` is provided, only matching skill ids are included. */
  async buildIndex(allowlist?: string[]): Promise<string> {
    let skills = await this.list();
    if (allowlist !== undefined) {
      const allow = new Set(allowlist);
      skills = skills.filter((s) => allow.has(s.id));
    }
    if (skills.length === 0) return "";

    const lines = skills.map(
      (s) => `- **${s.name}** (${s.id}): ${s.description}`,
    );

    return [
      "## Available Learned Skills",
      "",
      ...lines,
      "",
      // Scope this instruction explicitly to the list above. Other skill
      // surfaces (e.g. the regular `## 可用技能 (skills)` block injected by
      // the host app) live in different stores and are loaded differently
      // (read_file on the path constants the host gives you) — picking the
      // wrong path here returns "Skill not found" and leads the model to
      // fabricate reasons (we've seen "skill is in a 'pending' state" on a
      // perfectly populated regular skill).
      `Use skill_manage(action='read', id='<id>') ONLY for the Learned Skills listed in this section. Regular skills shown elsewhere (e.g. under "## 可用技能 (skills)") are NOT in this store — load them with read_file using the path constants in the host's prompt instead.`,
    ].join("\n");
  }

  /**
   * Pick the least-recently-used skill for eviction. Skills that have never
   * been read (no lastUsedAt) are evicted first, sorted by createdAt so the
   * oldest unused skill goes first. Among used skills, the one with the
   * oldest lastUsedAt is picked.
   */
  private pickLruCandidate(skills: SkillSummary[]): SkillSummary | null {
    if (skills.length === 0) return null;

    return skills.reduce((lru, s) => {
      const lruTime = lru.lastUsedAt || lru.createdAt;
      const sTime = s.lastUsedAt || s.createdAt;
      // Prefer evicting never-used skills over used ones
      if (!lru.lastUsedAt && s.lastUsedAt) return lru;
      if (lru.lastUsedAt && !s.lastUsedAt) return s;
      return sTime < lruTime ? s : lru;
    });
  }

  private validateId(id: string): void {
    if (!NAME_PATTERN.test(id)) {
      throw new Error(
        `Invalid skill id: "${id}". Must match ${NAME_PATTERN} (lowercase, hyphens, underscores)`,
      );
    }
    if (id.length > NAME_MAX_LEN) {
      throw new Error(`Skill id too long: ${id.length} chars (max ${NAME_MAX_LEN})`);
    }
  }

  private validateName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error("Skill name cannot be empty");
    }
    if (name.length > NAME_MAX_LEN) {
      throw new Error(`Skill name too long: ${name.length} chars (max ${NAME_MAX_LEN})`);
    }
  }

  private validateDescription(desc: string): void {
    if (!desc || desc.trim().length === 0) {
      throw new Error("Skill description cannot be empty");
    }
    if (desc.length > DESC_MAX_LEN) {
      throw new Error(
        `Skill description too long: ${desc.length} chars (max ${DESC_MAX_LEN})`,
      );
    }
  }
}

// --- Frontmatter parsing/serialization ---

/** Parse YAML frontmatter from a SKILL.md file. */
export function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Invalid SKILL.md: missing YAML frontmatter");
  }

  const yamlBlock = match[1];
  const body = match[2];

  // Simple YAML parser for our known flat structure
  const fields: Record<string, string> = {};
  let currentKey = "";
  const tagsList: string[] = [];
  let inTags = false;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && inTags) {
      tagsList.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    inTags = false;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    currentKey = key;

    if (key === "tags" && val === "") {
      inTags = true;
      continue;
    }

    fields[key] = val;
  }

  return {
    frontmatter: {
      name: fields.name ?? "",
      description: fields.description ?? "",
      createdAt: fields.createdAt ?? new Date().toISOString(),
      updatedAt: fields.updatedAt ?? new Date().toISOString(),
      patchCount: parseInt(fields.patchCount ?? "0", 10) || 0,
      tags: tagsList.length > 0 ? tagsList : (fields.tags ? [fields.tags] : undefined),
      lastUsedAt: fields.lastUsedAt || undefined,
    },
    body,
  };
}

/** Serialize frontmatter to YAML and prepend to body. */
export function serializeFrontmatter(fm: SkillFrontmatter): string {
  const lines = [
    "---",
    `name: "${fm.name}"`,
    `description: "${fm.description}"`,
    `createdAt: "${fm.createdAt}"`,
    `updatedAt: "${fm.updatedAt}"`,
    `patchCount: ${fm.patchCount}`,
  ];

  if (fm.tags && fm.tags.length > 0) {
    lines.push("tags:");
    for (const tag of fm.tags) {
      lines.push(`  - "${tag}"`);
    }
  }

  if (fm.lastUsedAt) {
    lines.push(`lastUsedAt: "${fm.lastUsedAt}"`);
  }

  lines.push("---", "");
  return lines.join("\n");
}
