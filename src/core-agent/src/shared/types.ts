/** Unified message content types for LLM interactions. */
export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image";
  /** Base64-encoded image data or URL. */
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Generic semantic intent preserved for provider-side visual routing. */
  analysisMode?: "understand" | "quality_review";
};

export type ToolUseContent = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider state for replaying tool calls, notably Gemini thought signatures. */
  thoughtSignature?: string;
};

export type ToolResultContent = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

/** Reasoning / chain-of-thought block emitted by reasoning models.
 *  Must be round-tripped back to the API on the next turn — DeepSeek's
 *  reasoner endpoints 400 with "reasoning_content in the thinking mode must
 *  be passed back" if the prior assistant turn's reasoning is dropped from
 *  history. `thinkingSignature` is opaque per-provider state: for OpenAI-
 *  compatible reasoners it's the JSON field name to write back
 *  (`reasoning_content` / `reasoning` / `reasoning_text`); for Anthropic
 *  encrypted thinking it's the signature blob. */
export type ThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;

export type MessageRole = "user" | "assistant" | "system";

export type Message = {
  role: MessageRole;
  content: MessageContent[];
  /**
   * Orkas-owned UI turn identity. Assigned by Session, persisted for healing /
   * restart, and stripped from provider-facing projections. Models never
   * create, read, or reconcile this field.
   */
  turnId?: number;
};

/** Token usage tracking. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
};

/** Stop reasons from LLM API calls. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

/**
 * Low-cardinality interpretation of the provider's native terminal marker.
 * Keep this separate from `StopReason`: the latter is the agent-loop control
 * signal, while this value preserves enough evidence to decide whether an
 * otherwise empty response is safe to recover.
 */
export type ProviderTerminationCategory =
  | "normal"
  | "length"
  | "safety"
  | "error"
  | "unknown";

/** Empty-response classes used by recovery and sampled diagnostics. */
export type ProviderEmptyKind =
  | "transport_empty"
  | "normal_end_empty"
  | "safety_filtered_empty"
  | "unknown_empty";

/** Closed-world Server reason for an Orkas Pro → Orkas 1.5 fallback. */
export type ServerModelFallbackReason =
  | "rate_limited"
  | "transport_error"
  | "configuration_error"
  | "not_configured"
  | "upstream_error"
  | "empty_response"
  | "unavailable"
  | "unknown";

/** Streaming event types. */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "retry"; attempt: number; reason: string }
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
      /** Whether a provider terminal event was observed before emptiness. */
      terminalEventSeen: boolean;
      /** Usage charged by a terminal empty request, when reported upstream. */
      usage?: Partial<Usage>;
    }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; input: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_start"; usage?: Partial<Usage> }
  | {
      type: "message_end";
      stopReason: StopReason;
      usage?: Partial<Usage>;
      /**
       * Full reconstructed assistant message content. Populated by providers
       * whose stream emits it at the end (pi-provider fills this from pi-ai's
       * `done.message`), allowing callers to feed the tool-loop / session
       * persistence without running a second non-streaming completion.
       */
      content?: MessageContent[];
      /** Model id echoed back so CompletionResult callers can record it. */
      model?: string;
      /** Bounded Orkas Server fallback reason recovered from response metadata. */
      serverFallbackReason?: ServerModelFallbackReason;
      /** Provider-native terminal classification for empty-response recovery. */
      providerTermination?: { category: ProviderTerminationCategory };
    }
  | {
      type: "error";
      error: Error;
      /** Present when Orkas Server switched models before the terminal error. */
      model?: string;
      serverFallbackReason?: ServerModelFallbackReason;
    };
