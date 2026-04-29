import { z } from "zod";

/** Provider configuration schema. */
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  auth: z.enum(["api-key", "oauth", "token"]).optional(),
  /** Max concurrent requests to this provider. */
  maxConcurrency: z.number().int().positive().optional(),
});

/** Model configuration schema. */
export const ModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Whether this model supports tool use. */
  supportsTools: z.boolean().optional(),
  /** Whether this model supports vision/images. */
  supportsVision: z.boolean().optional(),
  /** Whether this model supports streaming. */
  supportsStreaming: z.boolean().optional(),
});

/** Memory configuration schema. */
export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["openai", "gemini", "voyage", "mistral", "local", "auto"]).default("auto"),
  model: z.string().optional(),
  /** Directory containing memory markdown files. */
  memoryDir: z.string().optional(),
  /** Maximum number of search results to return. */
  maxResults: z.number().int().positive().default(10),
  /** Minimum relevance score for search results. */
  minScore: z.number().min(0).max(1).default(0.3),
  /** Full-text search configuration. */
  fts: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  /** Vector search configuration. */
  vector: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  /** Embedding cache configuration. */
  cache: z
    .object({
      enabled: z.boolean().default(true),
      maxEntries: z.number().int().positive().optional(),
    })
    .default({}),
});

/** Agent configuration schema. */
export const AgentConfigSchema = z.object({
  /** Default model to use for the agent. */
  defaultModel: z.string().default("claude-sonnet-4-20250514"),
  /** Default provider. */
  defaultProvider: z.string().default("anthropic"),
  /** Max retry attempts on transient errors. */
  maxRetries: z.number().int().min(0).default(3),
  /** Maximum number of tool-use loop iterations per run. */
  maxToolLoops: z.number().int().positive().default(50),
  /** System prompt override or additions. */
  systemPrompt: z.string().optional(),
  /** Thinking/reasoning level: off, low, high. */
  thinkingLevel: z.enum(["off", "low", "high"]).default("off"),
});

/** Metacognition (intrinsic self-improvement) configuration schema. */
export const MetacognitionConfigSchema = z.object({
  /** Whether metacognitive self-improvement is enabled. */
  enabled: z.boolean().default(true),
  /** Minimum weighted signal score to trigger reflection (0–1 scale). */
  reflectThreshold: z.number().min(0).max(2).default(0.7),
  /** Character limit for COMPETENCE.md (agent self-assessment). */
  competenceCharLimit: z.number().int().positive().default(3000),
  /** Character limit for LEARNING_STRATEGIES.md. */
  strategiesCharLimit: z.number().int().positive().default(2500),
});

/** Evolution (self-improvement) configuration schema. */
export const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Directory for storing learned skills. */
  skillsDir: z.string().default("skills"),
  /** Maximum number of stored skills. */
  maxSkills: z.number().int().positive().default(200),
  /** Maximum SKILL.md content length in characters. */
  maxSkillContentLength: z.number().int().positive().default(100_000),
  /** Metacognition subsystem. */
  metacognition: MetacognitionConfigSchema.default({}),
});

/** Top-level core-agent configuration schema. */
export const CoreAgentConfigSchema = z.object({
  agent: AgentConfigSchema.default({}),
  models: z
    .object({
      providers: z.record(z.string(), ProviderConfigSchema).default({}),
      catalog: z.record(z.string(), ModelConfigSchema).default({}),
    })
    .default({}),
  memory: MemoryConfigSchema.default({}),
  evolution: EvolutionConfigSchema.default({}),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type MetacognitionConfig = z.infer<typeof MetacognitionConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;
export type CoreAgentConfig = z.infer<typeof CoreAgentConfigSchema>;
