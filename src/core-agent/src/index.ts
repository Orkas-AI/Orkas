// Core Agent — simplified extraction of OpenClaw's core modules.
// Provides: LLM Provider interaction (via @earendil-works/pi-ai), Agent Harness,
// Memory System (with SQLite), Sandbox execution, and CLI commands.

// Config
export { loadConfig, createConfig, CoreAgentConfigSchema } from "./config/index.js";
export type { CoreAgentConfig, AgentConfig, MemoryConfig, ProviderConfig, ModelConfig, EvolutionConfig } from "./config/index.js";

// Shared types & utilities
export type { Message, MessageContent, Usage, StopReason, StreamEvent } from "./shared/types.js";
export {
  CoreAgentError,
  AuthError,
  RateLimitError,
  ContextOverflowError,
  OutputLimitError,
  ProviderError,
  TimeoutError,
  DEFAULT_RETRY_ERROR_POLICY,
  configureRetryErrorPolicy,
  getRetryErrorPolicy,
  isRetryableError,
  isTransientNetworkError,
  classifyRetryableError,
  classifyRetryableErrorWithPolicy,
  classifyTransientNetworkError,
  classifyTransientNetworkErrorWithPolicy,
} from "./shared/errors.js";
export type { RetryableErrorKind, RetryErrorPolicyConfig } from "./shared/errors.js";
export { createLogger } from "./shared/logger.js";
export type { Logger, LogLevel } from "./shared/logger.js";

// Providers (backed by @earendil-works/pi-ai)
export type { LLMProvider, CompletionParams, CompletionResult, ToolDefinition } from "./providers/index.js";
export { createAnthropicProvider, createOpenAIProvider, createPiProvider } from "./providers/index.js";
export { listPiProviders, listPiModels, getPiModel } from "./providers/index.js";
export { ProviderRegistry } from "./providers/index.js";

// Agent Harness
export { AgentRunner } from "./agent/index.js";
export { Session } from "./agent/index.js";
export { PersistentSession } from "./agent/index.js";
export type { ToolProtocolRepairReport } from "./agent/index.js";
export type {
  CompletedWorkEntry,
  CompletedWorkInput,
  CompletedWorkStatus,
  ExecutionPlanAuditRecord,
  ExecutionPlanState,
  ExecutionPlanStep,
  ExecutionPlanStepStatus,
  ExecutionPlanUpdate,
  HistoryResource,
  HistoryResourceKind,
} from "./agent/index.js";
export type { AgentRunParams, AgentRunResult, AgentRunMeta, AgentRunTimings, AgentRunEvent } from "./agent/index.js";

// Tools
export type { AgentTool, ToolContext, ToolResult, ToolResultImage } from "./tools/index.js";
export { defineTool, toToolDefinition, getBuiltinTools, createExecutionPlanTool, runBuiltinWebSearch, WEB_SEARCH_DEFAULT_COUNT, WEB_SEARCH_MAX_COUNT } from "./tools/index.js";

// Sandbox
export { SandboxExecutor } from "./sandbox/index.js";
export {
  ProcessOutputCapture,
  discardStreamedToolOutput,
  DEFAULT_PROCESS_OUTPUT_MEMORY_BYTES,
  DEFAULT_PROCESS_OUTPUT_SPOOL_BYTES,
} from "./sandbox/index.js";
export type {
  SandboxConfig,
  SandboxResult,
  CapturedProcessOutput,
  StreamedToolOutput,
} from "./sandbox/index.js";

// Skills (SKILL.md directory scanner + system-prompt injection helper)
export { SkillLoader, parseFrontmatter, pickDescription } from "./skills/index.js";
export type { SkillSpec, SkillLoaderOptions, FrontmatterParseResult } from "./skills/index.js";

// Memory
export { MemoryIndexManager } from "./memory/index.js";
export { SqliteMemoryManager } from "./memory/index.js";
export type { MemorySearchManager, MemorySearchResult } from "./memory/index.js";
export { createOpenAIEmbeddingProvider, createGeminiEmbeddingProvider } from "./memory/index.js";
export type { EmbeddingProvider } from "./memory/index.js";
export { createMemorySearchTool, createMemoryReadTool } from "./memory/index.js";

// Auth (OAuth & credential management)
export type { AuthCredential, ApiKeyCredential, OAuthCredential, AuthStore } from "./auth/index.js";
export {
  loadAuthStore,
  saveAuthStore,
  writeOAuthCredentials,
  writeApiKeyCredential,
  removeCredential,
  resolveApiKeyFromStore,
  isOAuthExpired,
  getOAuthCredential,
  listCredentials,
  resolveAuthDir,
  resolveAuthStorePath,
  loginOAuthProvider,
  refreshOAuthCredential,
  resolveOAuthApiKey,
} from "./auth/index.js";

// Evolution (self-improvement)
export { SkillStore, createSkillManageTool } from "./evolution/index.js";
export type { Skill, SkillSummary, SkillFrontmatter } from "./evolution/index.js";
export { detectUserCorrection, emptyRunMetrics, shouldReflect, buildReviewPrompt } from "./evolution/index.js";
export type { MetacognitionConfig, RunMetrics, TriggerSignal, MetacognitiveReflection } from "./evolution/index.js";

// CLI
export { CLI } from "./cli/index.js";
