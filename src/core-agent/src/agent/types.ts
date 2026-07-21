import type { Usage, StopReason, MessageContent } from "../shared/types.js";
import type { HistoryResource } from "./session.js";

/** Parameters for starting an agent run. */
export type AgentRunParams = {
  /** User message to send to the agent. */
  message: string;
  /** Continue the currently active durable UI turn instead of closing it and
   * starting a new one. The host sets this only after verifying that a failed
   * run still owns recoverable state in this same persistent session. */
  resumeActiveTurn?: boolean;
  /** Optional image attachments (base64). */
  images?: Array<{
    data: string;
    mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  }>;
  /** Durable, host-verified resources from this UI turn (attachments/results). */
  historyResources?: HistoryResource[];
  /** Host-private metadata for provider adapters. This is not rendered into
   * the conversation and must not be exposed to generic providers unless an
   * adapter explicitly forwards selected fields. */
  requestMetadata?: Record<string, unknown>;
  /** Per-turn ephemeral context (e.g. an orchestration ledger / datetime that
   * changes EVERY turn). Injected into the model-facing view of THIS turn's
   * user message only — the uncached tail, after all history — and NEVER
   * persisted to the session JSONL or replayed into future turns. Host uses
   * this to keep volatile blocks out of the (cached) system prompt so the
   * system + history cache prefix stays byte-stable across turns. */
  turnEphemeral?: string;
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

export type AgentRunTimings = {
  /** Time awaiting primary/final-summary model calls. */
  providerMs: number;
  /** Wall time spent inside tool execution batches. */
  toolMs: number;
  /** Time spent producing/applying context summaries. */
  compactionMs: number;
  /** Explicit runner backoff sleep; provider-internal retries remain provider time. */
  retryWaitMs: number;
  /** Residual orchestration, serialization, rendering events, and bookkeeping. */
  otherMs: number;
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
  /** Non-overlapping wall-time buckets for diagnosis and UI attribution. */
  timings?: AgentRunTimings;
  /** Whether the run was aborted. */
  aborted?: boolean;
  /** Error info if the run failed. */
  error?: {
    kind: "auth" | "rate_limit" | "context_overflow" | "timeout" | "provider_error";
    message: string;
    /** Machine-readable provider/runtime code. Host adapters must map this to
     * a bounded telemetry taxonomy before reporting it externally. */
    code?: string;
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
  | {
      type: "tool_end";
      name: string;
      id: string;
      result: string;
      persistedOutput?: { path: string; size: number; ref: string };
      isError?: boolean;
      errorCode?: string;
      errorSeverity?: "recoverable" | "error";
      durationMs?: number;
    }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; summary?: string; usage?: Usage; durationMs?: number }
  | {
      type: "context_status";
      phase:
        | "history_summary_start"
        | "history_summary_done"
        | "history_summary_failed"
        | "active_process_compaction_start"
        | "active_process_compaction_done"
        | "active_process_compaction_failed";
      message: string;
      data?: Record<string, unknown>;
    }
  | { type: "retry"; attempt: number; reason: string; waitMs?: number }
  | { type: "provider_fallback"; reason: "auth" | "no_first_event_timeout"; providerId: string }
  | { type: "done"; result: AgentRunResult };
