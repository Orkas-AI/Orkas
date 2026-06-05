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
  reflectThreshold: number;
  competenceCharLimit: number;
  strategiesCharLimit: number;
};

// ── Metacognition: run metrics & trigger signals ────────────────────────

/** Error classification for metacognitive signal gating. */
export type ErrorKind = 'none' | 'transient' | 'permanent' | 'mixed';

/** Lightweight metrics collected during a single agent run (no LLM cost). */
export type RunMetrics = {
  /** Total tool calls in this run. */
  toolCalls: number;
  /** Names of tools called (for pattern analysis). */
  toolNames: string[];
  /** Skill ids loaded via skill_manage(action='read') during this run. */
  skillsLoaded: string[];
  /** Whether errors occurred during the run. */
  hadErrors: boolean;
  /** Whether the agent recovered from errors (error + non-empty response). */
  recovered: boolean;
  /** Number of errors encountered. */
  errorCount: number;
  /** Number of user corrections detected (heuristic). */
  userCorrections: number;
  /** Classification of errors: transient (network), permanent, mixed, or none. */
  errorKind: ErrorKind;
  /** Count of transient (retryable/network) errors among tool calls. */
  transientErrorCount: number;
};

/** A single signal contributing to the reflection trigger decision. */
export type TriggerSignal = {
  /** Signal identifier. */
  name: string;
  /** Weight / importance (0–1). */
  weight: number;
  /** Human-readable reason. */
  reason: string;
};

/** Result of the metacognitive trigger evaluation. */
export type MetacognitiveReflection = {
  /** Whether to trigger a background review. */
  shouldReflect: boolean;
  /** All signals that contributed. */
  signals: TriggerSignal[];
  /** The primary focus area for the review prompt. */
  primaryFocus: string;
  /** Total weighted score. */
  score: number;
};
