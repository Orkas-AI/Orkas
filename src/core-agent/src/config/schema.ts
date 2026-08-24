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

/** Agent configuration schema. */
export const AgentConfigSchema = z.object({
  /** Default model to use for the agent. */
  defaultModel: z.string().default("claude-opus-4-8"),
  /** Default provider. */
  defaultProvider: z.string().default("anthropic"),
  /** Max retry attempts on transient errors. */
  maxRetries: z.number().int().min(0).default(3),
  /** Maximum number of tool-use loop iterations per run. */
  maxToolLoops: z.number().int().positive().default(100),
  /** Max time a tool may run without completing or reporting substantive progress. */
  toolIdleTimeoutMs: z.number().int().positive().default(1_800_000),
  /** System prompt override or additions. */
  systemPrompt: z.string().optional(),
  /** Explicit thinking/reasoning override. Omission preserves the model/provider default. */
  thinkingLevel: z.enum(["off", "low", "high"]).optional(),
});

/** Metacognition (intrinsic self-improvement) configuration schema. */
export const MetacognitionConfigSchema = z.object({
  /** Whether metacognitive self-improvement is enabled. */
  enabled: z.boolean().default(true),
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
  // The `memory` retrieval-engine section was removed with the unwired
  // OpenClaw-ported engine (2026-08-16); the non-strict schema strips the key
  // from older config files.
  evolution: EvolutionConfigSchema.default({}),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type MetacognitionConfig = z.infer<typeof MetacognitionConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;
export type CoreAgentConfig = z.infer<typeof CoreAgentConfigSchema>;
