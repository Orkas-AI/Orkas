/** YAML frontmatter metadata for a SKILL.md file. */
export type SkillFrontmatter = {
  /** Skill display name (max 60 ASCII chars or 30 CJK/Japanese chars). */
  name: string;
  /** One-line description (max 1024 chars). */
  description: string;
  /** When this skill was created (ISO 8601). */
  createdAt: string;
  /** When this skill was last updated (ISO 8601). */
  updatedAt: string;
  /** How many times this skill has been patched. */
  patchCount: number;
  /** Optional tags for categorization. */
  tags?: string[];
  /** When this skill was last read/used via skill_manage(read) (ISO 8601). */
  lastUsedAt?: string;
};

/** A loaded skill with parsed frontmatter and body content. */
export type Skill = {
  /** Skill identifier (directory name). */
  id: string;
  /** Parsed frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body (instructions/procedures). */
  body: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
};

/** Summary info for listing skills without loading full body. */
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  patchCount: number;
  tags?: string[];
  lastUsedAt?: string;
};

/** Configuration for the self-evolution subsystem. */
export type EvolutionConfig = {
  /** Whether evolution features are enabled. */
  enabled: boolean;
  /** Directory for storing skills. */
  skillsDir: string;
  /** Maximum number of skills (to prevent unbounded growth). */
  maxSkills: number;
  /** Maximum SKILL.md content length in characters. */
  maxSkillContentLength: number;
  /** Metacognition subsystem config. */
  metacognition: MetacognitionConfig;
};

/** Configuration for the metacognition subsystem. */
export type MetacognitionConfig = {
  enabled: boolean;
  competenceCharLimit: number;
  strategiesCharLimit: number;
};
