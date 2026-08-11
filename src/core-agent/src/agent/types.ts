import type {
  ProviderEmptyKind,
  ServerModelFallbackReason,
  Usage,
  StopReason,
  MessageContent,
} from "../shared/types.js";
import type { HistoryResource } from "./session.js";
import type { CommandExecutionObservation } from "../tools/base.js";

/** A user-authored message admitted into an already-running AgentRunner.
 *
 * The host resolves UI/domain objects (attachments, references, skills,
 * connectors) before they cross this boundary. CoreAgent only persists the
 * provider-facing rich content plus durable resource references. `onApplied`
 * is the host's acknowledgement boundary: it runs only after the Session has
 * accepted the message and resources, so a queued source item can remain
 * recoverable when preparation or persistence fails. */
export type AgentRunSteerMessage = {
  /** Stable host id used to make repeated drains idempotent within one run. */
  id: string;
  /** Provider-facing user content. At least one non-empty text or image block. */
  content: MessageContent[];
  /** Host-verified resources that must survive turn compaction/history trim. */
  historyResources?: HistoryResource[];
  /** Called after the message and resources have been committed to Session. */
  onApplied?: () => void | Promise<void>;
};

/** Text remains accepted for compatibility with non-host callers and older
 * tests. Product integrations should use the structured shape above. */
export type AgentRunSteerInput = string | AgentRunSteerMessage;

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
   * work and handling the message as a separate follow-up turn. The hook may
   * asynchronously hydrate attachments/skills/references; the runner never
   * calls it while a provider request or tool mutation is being committed.
   */
  drainSteer?: () =>
    | AgentRunSteerInput[]
    | undefined
    | Promise<AgentRunSteerInput[] | undefined>;
  /**
   * Host-side terminal-response guard. Called when the model produces a final
   * answer with no tool calls. Return a correction instruction to REJECT that
   * answer: the runner folds it in as a request control and re-prompts, so the
   * model repairs the response inside the SAME turn instead of shipping a
   * broken one to the user. Return null/undefined to accept.
   *
   * Runs on every terminal answer but REJECTS at most once per run: a guard
   * that keeps failing cannot spin the turn, and the second offence ships
   * (logged) with the user still able to act. Domain rules belong in the host —
   * the runner owns only the reject-and-re-prompt mechanism, the same shape as
   * the premature-completion nudge.
   */
  terminalTextGuard?: (text: string) => string | null | undefined;
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

/** Existing runner safeguards that had to intervene to make a run converge.
 * These are diagnostic signals only: they do not redefine task completion. */
export type AgentRunConvergenceSignal =
  | "tool_loop_limit_nudge"
  | "elapsed_convergence_nudge"
  | "spin_convergence_nudge"
  | "no_progress_nudge"
  | "discovery_stall_nudge"
  | "tool_loop_limit"
  | "repetitive_tool_calls"
  | "no_progress_stop"
  | "discovery_stall_stop"
  | "output_limit_continuation"
  | "output_limit_unrecovered";

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
  /** Bounded, low-cardinality runner convergence interventions. */
  convergenceSignals?: AgentRunConvergenceSignal[];
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
      displayName?: string;
      persistedOutput?: { path: string; size: number; ref: string };
      isError?: boolean;
      errorCode?: string;
      errorSeverity?: "recoverable" | "error";
      durationMs?: number;
      execution?: CommandExecutionObservation;
    }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; summary?: string; usage?: Usage; durationMs?: number }
  | {
      /** Low-cardinality timing for one main/final-summary provider request.
       * Internal telemetry only; host event mappers do not render it. */
      type: "provider_call";
      durationMs: number;
      outcome: "completed" | "failed";
      model: string;
      stopReason?: StopReason;
    }
  | {
      type: "context_status";
      phase:
        | "history_summary_start"
        | "history_summary_done"
        | "history_summary_failed"
        | "active_process_compaction_start"
        | "active_process_compaction_done"
        | "active_process_compaction_failed"
        /** Layered compaction could not hold the request under the ceiling, so
         *  raw tool output was dropped without a summary. Distinct from the
         *  phases above because information was lost, not condensed. */
        | "emergency_reduction";
      data?: Record<string, unknown>;
    }
  | { type: "retry"; attempt: number; reason: string; waitMs?: number }
  | {
      type: "provider_fallback";
      reason: "auth" | "no_first_event_timeout" | "server_model_fallback";
      providerId: string;
      candidateIndex?: number;
      candidateCount?: number;
      fromModel?: string;
      toModel?: string;
      serverFallbackReason?: ServerModelFallbackReason;
    }
  | {
      type: "provider_empty";
      kind: ProviderEmptyKind;
      providerId: string;
      candidateIndex: number;
      candidateCount: number;
      terminalEventSeen: boolean;
      usage?: Partial<Usage>;
    }
  | { type: "done"; result: AgentRunResult };
