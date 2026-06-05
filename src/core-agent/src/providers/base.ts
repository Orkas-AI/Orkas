import type {
  Model,
  Api,
  Context as PiContext,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiStreamEvent,
  Tool as PiTool,
  StreamOptions as PiStreamOptions,
  SimpleStreamOptions as PiSimpleStreamOptions,
} from "@earendil-works/pi-ai";

// Re-export pi-ai types that consumers need
export type { Model, PiContext, PiAssistantMessage, PiStreamEvent, PiTool };

import type { Message, StreamEvent, StopReason, Usage } from "../shared/types.js";

/** Tool definition for LLM function calling. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Parameters for an LLM completion request. */
export type CompletionParams = {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Thinking/reasoning level.
   *  - `"off"` explicitly disables thinking even if the provider has a
   *    `defaultReasoning` configured (used to opt out per-call).
   *  - `undefined` falls back to the provider's `defaultReasoning` (e.g.
   *    DeepSeek V4 Pro factories set `'low'` because the API errors 400 if
   *    `reasoning_effort` is missing while assistant history carries
   *    `reasoning_content`).
   *  - `"minimal"`/`"low"`/`"medium"`/`"high"` map directly to pi-ai's
   *    `ThinkingLevel` for the provider's reasoner channel. */
  reasoning?: "off" | "minimal" | "low" | "medium" | "high";
  /** Prompt-cache TTL policy forwarded to pi-ai. `"short"` (default in pi-ai)
   * = Anthropic 5m / OpenAI default window; `"long"` = Anthropic 1h / OpenAI
   * 24h extended; `"none"` disables caching. Provider-specific translation
   * happens inside pi-ai; providers without cache support ignore it. */
  cacheRetention?: "none" | "short" | "long";
  /** Stable identifier used as `prompt_cache_key` (OpenAI / Codex / Azure /
   * OpenRouter) and as cache-affinity hint (Mistral, others). Should be the
   * caller's session id so repeated turns on the same conversation hit the
   * same cache bucket. */
  sessionId?: string;
};

/** Non-streaming completion result. */
export type CompletionResult = {
  content: Message["content"];
  stopReason: StopReason;
  usage: Usage;
  model: string;
};

/**
 * Abstract LLM provider interface.
 *
 * Now backed by @earendil-works/pi-ai for multi-provider support via OpenClaw's
 * unified LLM communication layer.
 */
export interface LLMProvider {
  readonly id: string;
  readonly name: string;

  /** Create a non-streaming completion. */
  complete(params: CompletionParams): Promise<CompletionResult>;

  /** Create a streaming completion. Yields StreamEvent items. */
  stream(params: CompletionParams): AsyncIterable<StreamEvent>;

  /** Test whether this provider's credentials are valid. */
  validateAuth(): Promise<boolean>;
}

/** Provider factory function. */
export type ProviderFactory = (config: {
  apiKey?: string;
  baseUrl?: string;
}) => LLMProvider;
