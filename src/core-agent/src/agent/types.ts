import type { Usage, StopReason, MessageContent } from "../shared/types.js";

/** Parameters for starting an agent run. */
export type AgentRunParams = {
  /** User message to send to the agent. */
  message: string;
  /** Optional image attachments (base64). */
  images?: Array<{
    data: string;
    mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  }>;
  /** Host-private metadata for provider adapters. This is not rendered into
   * the conversation and must not be exposed to generic providers unless an
   * adapter explicitly forwards selected fields. */
  requestMetadata?: Record<string, unknown>;
  /** Model override for this run. */
  model?: string;
  /** Provider override for this run. */
  provider?: string;
  /** System prompt override. */
  systemPrompt?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Working directory for tool execution. */
  workingDir?: string;
  /** Thinking/reasoning level. */
  thinkingLevel?: "off" | "low" | "high";
  /**
   * Env vars injected into the sandbox (bash tool) child process.
   * Surfaces as `ToolContext.state.sandboxEnv` and is consumed by
   * `SandboxExecutor.config.env`. Use this instead of mutating
   * `process.env` on the host — the sandbox strips parent env, and
   * globally-set vars leak to unrelated host children (e.g. Electron
   * helpers inheriting `ELECTRON_RUN_AS_NODE=1` crash at boot).
   */
  sandboxEnv?: Record<string, string>;
  /** Prompt-cache TTL policy forwarded to pi-ai. Default (undefined) lets
   * pi-ai pick `"short"`; set `"long"` for extended retention (Anthropic 1h
   * / OpenAI 24h), `"none"` to opt out. Provider-specific; providers without
   * caching silently ignore. */
  cacheRetention?: "none" | "short" | "long";
  /**
   * interrupt-steer hook. Called at each successful tool-loop boundary (after
   * tool results are committed, before the next LLM call). Return any user
   * messages the host wants folded into THIS run — each becomes a `user` turn
   * so the agent course-corrects mid-task instead of finishing the now-stale
   * work and handling the message as a separate follow-up turn. Synchronous
   * (the runner calls it between awaits); return `[]`/undefined for no steer.
   */
  drainSteer?: () => string[] | undefined;
};

/** Result of a single agent run. */
export type AgentRunResult = {
  /** The final text response from the agent. */
  text: string;
  /** All content blocks from the final response. */
  content: MessageContent[];
  /** Run metadata. */
  meta: AgentRunMeta;
};

/** Metadata about an agent run. */
export type AgentRunMeta = {
  /** Duration of the run in milliseconds. */
  durationMs: number;
  /** Model used. */
  model: string;
  /** Provider used. */
  provider: string;
  /** Stop reason. */
  stopReason: StopReason;
  /** Accumulated token usage. */
  usage: Usage;
  /** Number of tool-use loop iterations. */
  toolLoops: number;
  /** Number of compaction cycles. */
  compactionCount: number;
  /** Whether the run was aborted. */
  aborted?: boolean;
  /** Error info if the run failed. */
  error?: {
    kind: "auth" | "rate_limit" | "context_overflow" | "timeout" | "provider_error";
    message: string;
  };
  /** Names of tools actually called during this run. */
  toolNames?: string[];
  /** Skill ids loaded via skill_manage(action='read') during this run. */
  skillsLoaded?: string[];
  /** Count of tool calls that failed with a transient (network/retryable) error. */
  transientToolErrors?: number;
  /** Count of tool calls that failed with a permanent (non-retryable) error. */
  permanentToolErrors?: number;
};

/** Events emitted during an agent run for streaming. */
export type AgentRunEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_delta"; name?: string; id: string; inputDelta: string; inputBytes?: number }
  | { type: "tool_start"; name: string; id: string; input: unknown }
  | { type: "tool_progress"; name: string; id: string; phase?: string; message: string; data?: Record<string, unknown> }
  | { type: "tool_end"; name: string; id: string; result: string; isError?: boolean }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; summary?: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; result: AgentRunResult };
