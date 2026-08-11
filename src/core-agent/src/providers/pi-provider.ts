/**
 * Unified LLM provider backed by @earendil-works/pi-ai.
 *
 * Replaces the individual Anthropic/OpenAI implementations with pi-ai's
 * multi-provider layer — the same approach used by OpenClaw.
 */
// The compatibility stream helpers retain custom-provider dispatch. Model
// discovery below deliberately uses pi-ai's native built-in provider catalog.
import {
  complete as piComplete,
  stream as piStream,
  completeSimple as piCompleteSimple,
  streamSimple as piStreamSimple,
  Type,
} from "@earendil-works/pi-ai/compat";
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import type {
  Model,
  Api,
  Context as PiContext,
  AssistantMessage as PiAssistantMessage,
  Tool as PiTool,
  KnownProvider,
} from "@earendil-works/pi-ai/compat";

import * as crypto from "node:crypto";

import type {
  Message,
  MessageContent,
  ProviderTerminationCategory,
  ServerModelFallbackReason,
  StreamEvent,
  StopReason,
  Usage,
} from "../shared/types.js";
import {
  AuthError,
  ProviderError,
  RateLimitError,
  ContextOverflowError,
  StorageFullError,
  isStorageFullError,
} from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import type { CompletionParams, CompletionResult, LLMProvider, ToolDefinition } from "./base.js";

const log = createLogger("pi-provider");

// Core-agent favors stable HTTP event streams over WebSocket optimizations.
// Providers that do not support transport selection ignore this option.
const CORE_AGENT_TRANSPORT = "sse" as const;

/** pi-ai's portable image block has no extension slot for Orkas analysis
 * intent. Encode the generic intent as a same-message control block so the
 * managed Server can consume it without reverse-engineering the tool call
 * that produced the image. Non-managed visual providers simply receive the
 * equivalent plain-text instruction beside the image. */
function visualAnalysisMarker(mode: "understand" | "quality_review"): string {
  return `<orkas_visual_analysis mode="${mode}"/>`;
}

function resolvedResponseModel(
  response: { responseModel?: string; model?: string },
  fallbackModel: string,
): string {
  return response.responseModel || response.model || fallbackModel;
}

const SERVER_FALLBACK_REASON_BY_MARKER: Readonly<Record<string, ServerModelFallbackReason>> = {
  pro_rate_limited: "rate_limited",
  pro_transport_error: "transport_error",
  pro_configuration_error: "configuration_error",
  pro_not_configured: "not_configured",
  pro_upstream_error: "upstream_error",
  pro_empty_response: "empty_response",
  pro_unavailable: "unavailable",
};

/**
 * Decode only the closed-world marker emitted by Orkas Server. A normal
 * provider response id is deliberately ignored; unknown marker values are
 * collapsed rather than forwarded into logs or analytics.
 */
function serverFallbackReasonFromResponseId(responseId: unknown): ServerModelFallbackReason | undefined {
  const marker = typeof responseId === "string" ? responseId.trim() : "";
  const prefix = "orkas-fallback:";
  if (!marker.startsWith(prefix)) return undefined;
  return SERVER_FALLBACK_REASON_BY_MARKER[marker.slice(prefix.length)] || "unknown";
}

/**
 * Clamp a session id to a provider-safe cache key. OpenAI / Codex / Azure
 * enforce `prompt_cache_key.length ≤ 64`; pi-ai forwards `options.sessionId`
 * verbatim to that field. With the dev-mode OAuth flow `reconcileDevUid()`
 * can install a 36-char GUID uid, after which `<uid>-gmember-<cid>-<aid>`
 * is 70 chars and OpenAI 400s the request.
 *
 * Inputs that fit pass through unchanged so existing 8-digit-uid sessions
 * keep their readable cache key (and existing cache buckets). Longer ones
 * collapse to `<prefix>-<sha1hex>` = 22 + 1 + 40 = 63 chars — deterministic
 * (same session ⇒ same key ⇒ cache still hits) and keeps a recognizable
 * head for log diagnosis. */
const MAX_CACHE_KEY_LEN = 64;
function cacheSafeSessionId(s: string | undefined): string | undefined {
  if (!s) return s;
  if (s.length <= MAX_CACHE_KEY_LEN) return s;
  const hash = crypto.createHash("sha1").update(s).digest("hex");
  return `${s.slice(0, 22)}-${hash}`;
}

// ─── Type conversion helpers ──────────────────────────────────────────────

/** Convert our internal Message[] to pi-ai Context. */
function buildPiContext(
  messages: Message[],
  systemPrompt?: string,
  tools?: ToolDefinition[],
  /**
   * Current model being called. Used to stamp each replayed assistant
   * message with `api`/`provider`/`model` matching the active model so
   * pi-ai's `transformMessages` evaluates `isSameModel === true` and
   * preserves thinking blocks (with their `thinkingSignature`) intact.
   *
   * Why this matters: pi-ai's transformMessages downgrades a thinking
   * block to a plain text block whenever it judges the source model
   * differs from the current one — that path skips the reasoner-specific
   * field (`reasoning_content` / `signature`) altogether, which causes
   * DeepSeek V4 Pro to 400 with a misleading "reasoning_content in the
   * thinking mode must be passed back" error. Stamping the current model
   * here keeps the thinking block whole and lets pi-ai's openai-completions
   * converter set `assistantMsg.reasoning_content` correctly.
   *
   * Caveat: Orkas doesn't persist per-message provenance in the session
   * jsonl, so this assumes the entire conversation was generated by one
   * model. If the user mid-chat switches to a different provider whose
   * thinking signatures are incompatible (Anthropic encrypted thinking →
   * OpenAI o-series), pi-ai's safety downgrade was the right behavior;
   * we accept that mid-chat switch may produce a turn the new model
   * rejects. Per-message stamping is the proper long-term fix.
   */
  model?: { api: string; provider: string; id: string },
): PiContext {
  const piMessages: PiContext["messages"] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      // Check for tool_result content
      const toolResults = msg.content.filter((c) => c.type === "tool_result");
      const others = msg.content.filter((c) => c.type !== "tool_result");

      // Emit tool result messages first
      for (const tr of toolResults) {
        if (tr.type !== "tool_result") continue;
        const toolName = toolNameByCallId.get(tr.toolUseId);
        if (!toolName) {
          continue;
        }
        piMessages.push({
          role: "toolResult",
          toolCallId: tr.toolUseId,
          toolName,
          content: [{ type: "text", text: tr.content }],
          isError: tr.isError ?? false,
          timestamp: Date.now(),
        });
      }

      // Emit user text/image content
      if (others.length > 0) {
        const piContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const c of others) {
          if (c.type === "text") {
            piContent.push({ type: "text", text: c.text });
          } else if (c.type === "image") {
            if (c.analysisMode) {
              piContent.push({ type: "text", text: visualAnalysisMarker(c.analysisMode) });
            }
            piContent.push({ type: "image", data: c.data, mimeType: c.mediaType });
          }
        }
        if (piContent.length > 0) {
          piMessages.push({
            role: "user",
            content: piContent,
            timestamp: Date.now(),
          });
        }
      }
    } else if (msg.role === "assistant") {
      const piContent: PiAssistantMessage["content"] = [];
      for (const c of msg.content) {
        if (c.type === "text") {
          piContent.push({ type: "text", text: c.text });
        } else if (c.type === "tool_use") {
          const toolCallId = String(c.id || "").trim();
          const toolName = String(c.name || "").trim();
          if (!toolCallId || !toolName) {
            continue;
          }
          toolNameByCallId.set(toolCallId, toolName);
          piContent.push({
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: c.input,
            ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
          });
        } else if (c.type === "thinking") {
          // Re-inject reasoning into outgoing context — required by DeepSeek
          // reasoner / Anthropic encrypted-thinking / llama.cpp gpt-oss; see
          // mapContent() for the inbound side.
          //
          // pi-ai stores `thinkingSignature` in two incompatible formats
          // depending on which provider produced the block:
          //   - openai-completions adapter writes the literal field name
          //     ("reasoning_content" / "reasoning" / "reasoning_text") so
          //     the next-turn payload can echo `assistantMsg[signature]`
          //     back as the same key.
          //   - openai-responses-shared expects a JSON-encoded reasoning
          //     item and does `JSON.parse(thinkingSignature)` unconditionally.
          // A cross-provider conversation (e.g. DeepSeek then gpt-5) will
          // crash the second turn with `Unexpected token 'r', "reasoning_content"
          // is not valid JSON`. Drop the signature when it would crash the
          // target adapter; losing the signature only weakens DeepSeek-style
          // "echo back" guarantees, which is acceptable cross-provider.
          const targetIsResponsesApi = model?.api === "openai-responses"
            || model?.api === "azure-openai-responses"
            || model?.api === "openai-codex-responses";
          let safeSignature = c.thinkingSignature;
          if (safeSignature && targetIsResponsesApi) {
            try { JSON.parse(safeSignature); }
            catch { safeSignature = undefined; }
          }
          piContent.push({
            type: "thinking",
            thinking: c.thinking,
            ...(safeSignature ? { thinkingSignature: safeSignature } : {}),
            ...(c.redacted ? { redacted: c.redacted } : {}),
          });
        }
      }
      if (piContent.length === 0) {
        continue;
      }
      piMessages.push({
        role: "assistant",
        content: piContent,
        // Stamp with the current model so pi-ai's `transformMessages` sees
        // `isSameModel === true` and keeps thinking blocks (with their
        // signature) verbatim — see the param comment on `buildPiContext`.
        // Falls back to harmless placeholders only when no model is supplied
        // (utility paths like validateAuth that don't replay history).
        api: (model?.api ?? "anthropic-messages") as PiAssistantMessage["api"],
        provider: model?.provider ?? "anthropic",
        model: model?.id ?? "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }

  // Convert tool definitions to pi-ai Tool format
  const piTools: PiTool[] | undefined = tools?.map((t) => ({
    name: t.name,
    description: t.description,
    // ToolDefinition already carries provider-ready JSON Schema. Wrapping the
    // schema keeps nested objects, array items, enums, unions, and required
    // fields intact while adding the TypeBox marker pi-ai expects. Rebuilding
    // only the top-level properties would misdeclare object inputs as strings
    // and array items as Any, teaching the model to emit invalid tool calls.
    parameters: Type.Unsafe(t.inputSchema),
  }));

  return {
    systemPrompt,
    messages: piMessages,
    tools: piTools,
  };
}

export function buildPiContextForTest(
  messages: Message[],
  systemPrompt?: string,
  tools?: ToolDefinition[],
  model?: { api: string; provider: string; id: string },
): PiContext {
  return buildPiContext(messages, systemPrompt, tools, model);
}

/** Map pi-ai StopReason to our StopReason. */
function mapStopReason(reason: PiAssistantMessage["stopReason"]): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "error":
    case "aborted":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * Preserve only the bounded semantic class of a native stop marker. Raw
 * provider strings are intentionally not propagated into analytics.
 *
 * A known native marker takes precedence over pi-ai's normalized reason. If
 * the provider adds a new marker, fail closed as `unknown` instead of treating
 * pi-ai's successful `done` envelope as proof that an empty result is safe to
 * retry or switch across models.
 */
function providerTerminationCategory(
  rawStopReason: unknown,
  normalizedStopReason: unknown,
): ProviderTerminationCategory {
  const raw = typeof rawStopReason === "string"
    ? rawStopReason.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  if (raw) {
    const safetyReasons = new Set([
      "content_filter",
      "refusal",
      "sensitive",
      "safety",
      "spii",
      "blocklist",
      "prohibited_content",
      "recitation",
      "image_safety",
      "image_prohibited_content",
      "image_recitation",
    ]);
    if (safetyReasons.has(raw)) return "safety";
    if (["stop", "end", "end_turn", "stop_sequence", "completed", "pause_turn", "tool_use", "tool_calls", "function_call"].includes(raw)) {
      return "normal";
    }
    if (["length", "max_tokens", "model_context_window_exceeded", "incomplete"].includes(raw)) {
      return "length";
    }
    if (["error", "failed", "cancelled", "canceled", "aborted", "network_error"].includes(raw)) {
      return "error";
    }
    return "unknown";
  }

  const normalized = String(normalizedStopReason || "").trim();
  if (normalized === "stop" || normalized === "toolUse") return "normal";
  if (normalized === "length") return "length";
  if (normalized === "error" || normalized === "aborted") return "error";
  return "unknown";
}

/** Convert pi-ai Usage to our Usage. */
function mapUsage(u: PiAssistantMessage["usage"]): Usage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead || undefined,
    cacheWriteTokens: u.cacheWrite || undefined,
    totalTokens: u.totalTokens,
  };
}

/** Convert pi-ai AssistantMessage content to our MessageContent[]. */
function mapContent(content: PiAssistantMessage["content"]): MessageContent[] {
  const result: MessageContent[] = [];
  for (const block of content) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      result.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
        ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
      });
    } else if (block.type === "thinking") {
      // Preserve reasoning blocks for round-trip. DeepSeek-style reasoners
      // 400 the next turn if `reasoning_content` isn't echoed back; pi-ai's
      // openai-completions adapter writes it via `assistantMsg[signature]`
      // (signature = original field name, e.g. "reasoning_content").
      const tc: MessageContent = {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted ? { redacted: block.redacted } : {}),
      };
      result.push(tc);
    }
  }
  return result;
}

export function mapContentForTest(content: PiAssistantMessage["content"]): MessageContent[] {
  return mapContent(content);
}

const REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;
type PiReasoningLevel = typeof REASONING_LEVELS[number];

/** Normalize an agent-requested reasoning level to the closest level an
 * upstream endpoint declares. Exported so provider compatibility can be
 * verified without making a network request. */
export function normalizeReasoningForProvider(
  requested: PiReasoningLevel | undefined,
  supported?: ReadonlyArray<PiReasoningLevel>,
): PiReasoningLevel | undefined {
  if (!requested || !supported?.length || supported.includes(requested)) return requested;
  const requestedIndex = REASONING_LEVELS.indexOf(requested);
  return [...supported].sort((a, b) => {
    const distance = Math.abs(REASONING_LEVELS.indexOf(a) - requestedIndex)
      - Math.abs(REASONING_LEVELS.indexOf(b) - requestedIndex);
    return distance || REASONING_LEVELS.indexOf(a) - REASONING_LEVELS.indexOf(b);
  })[0];
}

// ─── Provider creation ────────────────────────────────────────────────────

/**
 * Create an LLMProvider backed by pi-ai for the given provider/model.
 *
 * This is the main factory — it resolves built-in models from pi-ai's native
 * provider catalog, then wraps `complete()` and `stream()` behind our
 * LLMProvider interface.
 */
export function createPiProvider(config: {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Pre-built pi-ai Model object. Bypasses native catalog lookup — use for
   *  providers not registered in pi-ai's catalog (e.g. Moonshot's open
   *  platform), where the `Model<"openai-completions">` shape is
   *  hand-constructed by the caller. When set, `config.model` /
   *  `config.baseUrl` are ignored (the Model already carries them). */
  customModel?: Model<Api>;
  /** Each pi-ai provider invokes `options.onPayload?(params, model)`
   *  after `buildParams` and before sending the request, allowing the
   *  callback to return new params that overwrite the originals.
   *  Forwarded directly to pi-ai's hook of the same name; the upper
   *  layer can use it to inject vendor server-side tools (e.g.
   *  `{type:"web_search_preview"}`) without modifying pi-ai source. */
  onPayload?: (params: unknown, model: Model<Api>, requestMetadata?: Record<string, unknown>) => unknown | Promise<unknown>;
  /** Default thinking level applied when the caller does not pass
   *  `params.reasoning`. Set this for models whose API requires
   *  `reasoning_effort` to be present whenever `model.reasoning === true` —
   *  provider integrations may use this when their protocol requires an
   *  explicit effort. The caller can still pass `params.reasoning: 'off'`
   *  to bypass the configured default for a specific call. */
  defaultReasoning?: "minimal" | "low" | "medium" | "high";
  /** Reasoning levels accepted by the upstream endpoint. Some OpenAI-
   *  compatible gateways expose a narrower enum than pi-ai (for example the
   *  managed Orkas route does not accept `minimal`). Requested levels are
   *  clamped to the nearest supported level before the request is sent. */
  supportedReasoning?: ReadonlyArray<"minimal" | "low" | "medium" | "high">;
}): LLMProvider {
  const providerId = config.provider as KnownProvider;

  // Resolve the model object. `customModel` shortcuts pi-ai's catalog
  // lookup for providers pi-ai doesn't know about.
  let resolvedModel: Model<Api> | undefined = config.customModel;
  if (!resolvedModel && config.model) {
    try {
      resolvedModel = getBuiltinModel(providerId as any, config.model as any);
    } catch {
      // Model not found in pi-ai catalog — will be resolved later per-request
    }
  }

  // If baseUrl is overridden, create a custom model
  if (config.baseUrl && resolvedModel && !config.customModel) {
    resolvedModel = { ...resolvedModel, baseUrl: config.baseUrl };
  }

  // Resolve the effective ThinkingLevel for a single call. Pi-ai accepts
  // ThinkingLevel | undefined; our `'off'` is a meta-value meaning "skip the
  // provider default", not a pi-ai level. Caller's explicit `'off'` always
  // wins; otherwise fall back to the provider's `defaultReasoning`.
  const effectiveReasoning = (
    paramReasoning: CompletionParams["reasoning"],
  ): "minimal" | "low" | "medium" | "high" | undefined => {
    if (paramReasoning === "off") return undefined;
    return normalizeReasoningForProvider(
      paramReasoning || config.defaultReasoning,
      config.supportedReasoning,
    );
  };

  const provider: LLMProvider = {
    id: providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),

    async complete(params: CompletionParams): Promise<CompletionResult> {
      const model = resolveModel(providerId, params.model, resolvedModel, config.baseUrl);
      const context = buildPiContext(params.messages, params.systemPrompt, params.tools, model);
      const reasoning = effectiveReasoning(params.reasoning);
      const sessionId = cacheSafeSessionId(params.sessionId);
      const onPayload = config.onPayload
        ? ((payload: unknown, hookModel: Model<Api>) => config.onPayload!(payload, hookModel, params.requestMetadata))
        : undefined;

      log.debug(`complete ${providerId}/${model.id}`);

      try {
        let result: PiAssistantMessage;

        if (reasoning) {
          result = await piCompleteSimple(model, context, {
            apiKey: config.apiKey,
            transport: CORE_AGENT_TRANSPORT,
            signal: params.signal,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            reasoning,
            cacheRetention: params.cacheRetention,
            sessionId,
            ...(onPayload ? { onPayload: onPayload as any } : {}),
          });
        } else {
          result = await piComplete(model, context, {
            apiKey: config.apiKey,
            transport: CORE_AGENT_TRANSPORT,
            signal: params.signal,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            cacheRetention: params.cacheRetention,
            sessionId,
            ...(onPayload ? { onPayload: onPayload as any } : {}),
          });
        }

        if (result.stopReason === "error") {
          throw new ProviderError(
            result.errorMessage ?? "Unknown provider error",
            providerId,
          );
        }

        return {
          content: mapContent(result.content),
          stopReason: mapStopReason(result.stopReason),
          usage: mapUsage(result.usage),
          model: resolvedResponseModel(result, model.id),
        };
      } catch (err) {
        throw wrapError(err, providerId);
      }
    },

    async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      const model = resolveModel(providerId, params.model, resolvedModel, config.baseUrl);
      const context = buildPiContext(params.messages, params.systemPrompt, params.tools, model);
      const reasoning = effectiveReasoning(params.reasoning);
      const sessionId = cacheSafeSessionId(params.sessionId);
      const onPayload = config.onPayload
        ? ((payload: unknown, hookModel: Model<Api>) => config.onPayload!(payload, hookModel, params.requestMetadata))
        : undefined;

      log.debug(`stream ${providerId}/${model.id}`);

      try {
        const eventStream = reasoning
          ? piStreamSimple(model, context, {
              apiKey: config.apiKey,
              transport: CORE_AGENT_TRANSPORT,
              signal: params.signal,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              reasoning,
              cacheRetention: params.cacheRetention,
              sessionId,
              ...(onPayload ? { onPayload: onPayload as any } : {}),
            })
          : piStream(model, context, {
              apiKey: config.apiKey,
              transport: CORE_AGENT_TRANSPORT,
              signal: params.signal,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              cacheRetention: params.cacheRetention,
              sessionId,
              ...(onPayload ? { onPayload: onPayload as any } : {}),
            });

        for await (const event of eventStream) {
          switch (event.type) {
            case "start":
              yield { type: "message_start" };
              break;
            case "text_delta":
              yield { type: "text_delta", text: event.delta };
              break;
            case "toolcall_start":
              yield {
                type: "tool_use_start",
                id: event.partial.content[event.contentIndex]?.type === "toolCall"
                  ? (event.partial.content[event.contentIndex] as { id: string }).id
                  : "",
                name: event.partial.content[event.contentIndex]?.type === "toolCall"
                  ? (event.partial.content[event.contentIndex] as { name: string }).name
                  : "",
              };
              break;
            case "toolcall_delta":
              yield { type: "tool_use_delta", id: "", input: event.delta };
              break;
            case "toolcall_end":
              yield { type: "tool_use_end", id: event.toolCall.id };
              break;
            case "done":
              const serverFallbackReason = serverFallbackReasonFromResponseId(event.message.responseId);
              yield {
                type: "message_end",
                stopReason: mapStopReason(event.reason),
                usage: mapUsage(event.message.usage),
                content: mapContent(event.message.content),
                model: resolvedResponseModel(event.message, model.id),
                ...(serverFallbackReason ? { serverFallbackReason } : {}),
                providerTermination: {
                  category: providerTerminationCategory(
                    event.message.rawStopReason,
                    event.reason,
                  ),
                },
              };
              break;
            case "error":
              const errorServerFallbackReason = serverFallbackReasonFromResponseId(event.error.responseId);
              const responseModel = resolvedResponseModel(event.error, model.id);
              // Surface everything we can from the stream error event.
              // pi-ai's fetch layer swallows the original Error(cause chain)
              // and only keeps `.message` on `errorMessage`; any extra field
              // the provider adapter exposes (kind/reason/statusCode/...) is
              // still useful and worth logging. Without this the caller
              // sees a bare "fetch failed" string and has no path to the
              // real undici / SDK cause.
              try {
                const pe = (event as any).error;
                const peKeys = pe && typeof pe === 'object' ? Object.keys(pe) : [];
                log.warn(
                  `stream error provider=${providerId} model=${model.id} ` +
                  `msg="${String(pe?.errorMessage || '').slice(0, 200)}" ` +
                  `reason=${pe?.stopReason ?? '-'} ` +
                  `fields=${JSON.stringify(peKeys)}`,
                );
              } catch (_) { /* best-effort */ }
              yield {
                type: "error",
                error: wrapError(new ProviderError(
                  event.error.errorMessage ?? "Stream error",
                  providerId,
                ), providerId),
                ...(responseModel ? { model: responseModel } : {}),
                ...(errorServerFallbackReason ? { serverFallbackReason: errorServerFallbackReason } : {}),
              };
              break;
          }
        }
      } catch (err) {
        throw wrapError(err, providerId);
      }
    },

    async validateAuth(): Promise<boolean> {
      try {
        const model = resolveModel(providerId, undefined, resolvedModel, config.baseUrl);
        const result = await piComplete(model, {
          messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        }, {
          apiKey: config.apiKey,
          transport: CORE_AGENT_TRANSPORT,
          maxTokens: 1,
        });
        return result.stopReason !== "error";
      } catch {
        return false;
      }
    },
  };

  return provider;
}

export const resolvedResponseModelForTest = resolvedResponseModel;
export const providerTerminationCategoryForTest = providerTerminationCategory;
export const serverFallbackReasonFromResponseIdForTest = serverFallbackReasonFromResponseId;

/** Resolve a pi-ai Model for the given provider + model ID. */
function resolveModel(
  providerId: string,
  modelId?: string,
  cached?: Model<Api>,
  baseUrl?: string,
): Model<Api> {
  // Use cached model if model ID matches
  if (cached && (!modelId || cached.id === modelId)) {
    return baseUrl ? { ...cached, baseUrl } : cached;
  }

  // Try to look up the model. `getModel` returns undefined for unknown
  // (provider, model) pairs — DO NOT return that as a Model; fall through
  // so the next branches (cached / first-of-provider / throw) can run.
  if (modelId) {
    try {
      const m = getBuiltinModel(providerId as any, modelId as any);
      if (m) return baseUrl ? { ...m, baseUrl } : m;
    } catch {
      // Fall through
    }
  }

  // If we have a cached model, use it
  if (cached) {
    return baseUrl ? { ...cached, baseUrl } : cached;
  }

  if (modelId) {
    throw new ProviderError(`No model found for provider: ${providerId}, model: ${modelId}`, providerId);
  }

  // Pick first available model for provider-only callers, such as auth
  // validation paths that intentionally do not pin a specific model.
  const models = getBuiltinModels(providerId as any);
  if (models.length > 0) {
    return baseUrl ? { ...models[0], baseUrl } : models[0];
  }

  throw new ProviderError(`No model found for provider: ${providerId}`, providerId);
}

/** Wrap pi-ai errors into our error hierarchy.
 *
 * Always preserves the original error as `.cause` so downstream consumers
 * (e.g. Orkas's `auth-error.ts::classifyKeyFailure`) can walk the cause
 * chain to recover `status` (401 / 403 / 429 / 402) — the SDK-level
 * `APIError` carries status but our shared `AuthError` / `RateLimitError`
 * etc don't have dedicated status fields. Without the cause link, the
 * status signal would be dropped and classification would be forced to
 * fall back on fragile message-pattern matching alone. */
function wrapError(err: unknown, providerId: string): Error {
  if (err instanceof StorageFullError) return err;

  const original = err instanceof Error ? err : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  if (isStorageFullError(err)) {
    return new StorageFullError(msg, original);
  }

  if (err instanceof AuthError || err instanceof RateLimitError || err instanceof ContextOverflowError || err instanceof ProviderError) {
    return err;
  }

  const msgLower = msg.toLowerCase();

  if (msgLower.includes("401") || msgLower.includes("403") || msgLower.includes("authentication") || msgLower.includes("unauthorized")) {
    return new AuthError(`${providerId} auth failed: ${msg}`, original);
  }
  if (msgLower.includes("429") || msgLower.includes("rate limit") || msgLower.includes("too many requests")) {
    return new RateLimitError(`${providerId} rate limited: ${msg}`, undefined, original);
  }
  if (msgLower.includes("context") && (msgLower.includes("overflow") || msgLower.includes("too long") || msgLower.includes("maximum"))) {
    return new ContextOverflowError(`${providerId} context overflow: ${msg}`, original);
  }

  // Generic ProviderError — try to forward `status` from the underlying
  // SDK error (Anthropic / OpenAI both expose `.status` on APIError).
  const status = original && typeof (original as any).status === 'number'
    ? (original as any).status as number
    : undefined;
  return new ProviderError(msg, providerId, status, original);
}

// ─── Convenience factories for specific providers ─────────────────────────

/** Create an Anthropic provider using pi-ai. */
export function createAnthropicProvider(config: {
  apiKey?: string;
  baseUrl?: string;
} = {}): LLMProvider {
  return createPiProvider({
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

/** Create an OpenAI provider using pi-ai. */
export function createOpenAIProvider(config: {
  apiKey?: string;
  baseUrl?: string;
} = {}): LLMProvider {
  return createPiProvider({
    provider: "openai",
    model: "gpt-4o",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

// ─── Utility exports ──────────────────────────────────────────────────────

/** List all providers available via pi-ai. */
export function listPiProviders(): string[] {
  return getBuiltinProviders();
}

/** List all models for a provider. */
export function listPiModels(provider: string): Array<{ id: string; name: string; contextWindow: number }> {
  try {
    return getBuiltinModels(provider as any).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
    }));
  } catch {
    return [];
  }
}
