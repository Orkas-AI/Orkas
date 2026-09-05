/**
 * External providers — factories for chat providers with app-specific ids
 * and endpoint configuration.
 *
 * Each factory hand-builds a pi-ai `Model<TApi>` object and passes it to
 * `createPiProvider({ customModel })`. That route bypasses pi-ai's
 * `getModel()` catalog (which would throw for unknown providers) but still
 * reuses pi-ai's API dispatcher — the `api` field on the Model
 * (`"openai-completions"` / `"anthropic-messages"`) tells pi-ai which
 * provider-side implementation to use.
 *
 * ## Currently registered
 *
 *   moonshot → https://api.moonshot.cn/v1
 *     OpenAI-compatible, pay-as-you-go "open platform" account.
 *     Independent from pi-ai's `kimi-coding` provider, which hits
 *     `api.kimi.com/coding` and requires a Kimi Coding Plan subscription.
 *
 *   deepseek → https://api.deepseek.com/v1
 *     OpenAI-compatible. pi-ai 0.68.1 only carries DeepSeek models inside
 *     the OpenRouter aggregate; direct billing requires this adapter.
 *
 *   doubao → https://ark.cn-beijing.volces.com/api/v3
 *     OpenAI-compatible (Volcengine Ark). User must create a "model
 *     endpoint" (endpoint id) in the ark console and use that id as the
 *     model — the curated list is just a hint.
 *
 * ## Adding a new external provider
 *
 *   1. Export a factory `createXxxProvider({ apiKey, modelId })` here.
 *   2. Add its id to `EXTERNAL_API_PROVIDERS` in `provider_catalog.ts`.
 *   3. Add a CATALOG entry + `CURATED_MODELS[id]` entries (and a
 *      `subscriptionNote` if users might confuse it with another brand's
 *      endpoint).
 *   4. Route to the factory from `runner.ts::buildExternalProvider` and
 *      `auth.ts::testConnection`.
 */

import type { LLMProvider } from '#core-agent';
import type { Model } from '@earendil-works/pi-ai';
import { isBearerTokenHeaderSafe } from '../../util/http-authorization';
import {
  curatedModelsFor,
  modelInputFromConfiguredCapabilities,
  type CustomOpenAICompatibleRuntimeConfig,
} from '../provider_catalog';
import { repairOpenAIToolMessageOrder } from './openai-payload';
import {
  ORKAS_API_BASE_URL,
  ORKAS_API_PROVIDER,
  orkasApiUsageHeaders,
  type OrkasApiUsageContext,
} from '../../features/orkas_api';

// core-agent is an ESM package and the Orkas main process is CJS, so
// **static import is not allowed**. Reuse the dynamic-import + lazy cache
// pattern from runner.ts / session-store.ts.
type CA = typeof import('#core-agent');
let _caPromise: Promise<CA> | null = null;
function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
}

function configuredPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * OpenAI-compatible endpoints do not expose a portable capability-discovery
 * API. Treat unknown custom models as multimodal so attached images reach new
 * models without a client release, while retaining a narrow list of official
 * DeepSeek aliases that are documented as text-only. Dated snapshots and the
 * official `[1m]` alias share the same capability; names containing an
 * explicit vision variant intentionally do not match.
 */
const KNOWN_TEXT_ONLY_OPENAI_COMPATIBLE_MODELS = [
  /^deepseek-(?:chat|reasoner)$/i,
  /^deepseek-v4-(?:pro|flash)(?:-\d{4,8})?(?:\[[^\]]+\])?$/i,
];

function openAICompatibleModelSupportsImages(
  modelId: string,
  declared: boolean | undefined,
  unknownDefault: boolean,
): boolean {
  const leafId = String(modelId || '').trim().split('/').pop()?.split(':', 1)[0] || '';
  if (KNOWN_TEXT_ONLY_OPENAI_COMPATIBLE_MODELS.some((pattern) => pattern.test(leafId))) {
    return false;
  }
  return declared ?? unknownDefault;
}

function configuredModelVisionDeclaration(model: {
  supportsVision?: boolean;
  maxInputImages?: number;
} | undefined): boolean | undefined {
  if (typeof model?.supportsVision === 'boolean') return model.supportsVision;
  if (typeof model?.maxInputImages === 'number') return model.maxInputImages > 0;
  return undefined;
}

function alignDeepSeekReasoningPayload(params: unknown): unknown {
  try {
    const p = params as { reasoning_effort?: string; messages?: Array<{ role?: string; reasoning_content?: unknown; reasoning?: unknown }> };
    const priorAssistants = (p.messages || []).filter((m) => m && m.role === 'assistant');
    if (priorAssistants.length === 0) {
      // No prior turns — nothing to be inconsistent with. Preserve an
      // explicitly requested reasoning_effort; an omitted control remains
      // omitted so DeepSeek applies the selected model's official defaults.
      return params;
    }
    const allHaveReasoning = priorAssistants.every(
      (m) => (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0)
        || (typeof m.reasoning === 'string' && (m.reasoning as string).length > 0),
    );
    if (!allHaveReasoning && p.reasoning_effort !== undefined) {
      delete p.reasoning_effort;
    }
  } catch { /* never let onPayload throw — pi-ai treats throw as fatal */ }
  return params;
}

export function repairDeepSeekPayload(params: unknown): unknown {
  return repairOpenAIToolMessageOrder(alignDeepSeekReasoningPayload(params));
}

export function repairOpenAICompatiblePayload(params: unknown): unknown {
  return repairOpenAIToolMessageOrder(params);
}

// ── Orkas public API ───────────────────────────────────────────────────

export function buildOrkasApiModel(modelId: string): Model<'openai-completions'> {
  const curated = curatedModelsFor(ORKAS_API_PROVIDER).find((model) => model.id === modelId);
  return {
    id: modelId,
    name: curated?.name || modelId,
    api: 'openai-completions',
    provider: ORKAS_API_PROVIDER as any,
    baseUrl: ORKAS_API_BASE_URL,
    reasoning: true,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    },
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredPositiveInteger(curated?.contextWindow, 1_048_576),
    maxTokens: configuredPositiveInteger(curated?.maxTokens, 32_000),
  };
}

export async function createOrkasApiProvider(config: {
  apiKey: string;
  modelId: string;
  usageContext?: OrkasApiUsageContext;
}): Promise<LLMProvider> {
  if (!config.apiKey) throw new Error('orkas-api: apiKey required');
  if (!isBearerTokenHeaderSafe(config.apiKey)) throw new Error('orkas-api: invalid API key');
  if (!config.modelId) throw new Error('orkas-api: modelId required');
  const mod = await ca();
  return mod.createPiProvider({
    provider: ORKAS_API_PROVIDER,
    apiKey: config.apiKey,
    customModel: buildOrkasApiModel(config.modelId),
    defaultReasoning: 'low',
    headers: orkasApiUsageHeaders(config.usageContext),
    onPayload: repairOpenAICompatiblePayload,
  });
}

// ── Moonshot open-platform (https://api.moonshot.cn/v1) ─────────────────

const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';

/**
 * Context windows by Moonshot model id. Numbers come from
 * platform.kimi.com/docs/models (checked 2026-06). Fallback 131072 for
 * ids we haven't catalogued — safe lower bound given every current kimi
 * model is at least 128k. Legacy K2 preview ids still resolve via fallback
 * if a stale credential references them.
 */
const MOONSHOT_CONTEXT_WINDOW: Record<string, number> = {
  'kimi-k3': 1048576,
  'kimi-k2.7-code': 262144,
  'kimi-k2.7-code-highspeed': 262144,
  'kimi-k2.6': 262144,
  'kimi-k2.5': 262144,
};

function moonshotContextWindow(modelId: string): number {
  return MOONSHOT_CONTEXT_WINDOW[modelId] ?? 131072;
}

// Per-model max output tokens. Why this needs a per-model table: pi-ai's
// `simple-options.buildBaseOptions` reads `model.maxTokens` as the default
// `max_tokens` request param and fits it to the remaining context; a single
// hard-coded value caps every model at the lowest common denominator and complex
// structured replies get cut mid-stream with `stopReason: "length"` while
// the renderer just shows whatever streamed before the cap. Numbers from
// platform.kimi.com/docs/models (2026-06). Unknown ids fall back to 8192
// to stay safe against providers that 400 on over-cap requests.
const MOONSHOT_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'kimi-k3': 131072,
  'kimi-k2.7-code': 32768,
  'kimi-k2.7-code-highspeed': 32768,
  'kimi-k2.6': 32768,
  'kimi-k2.5': 16384,
};

function moonshotMaxOutputTokens(modelId: string): number {
  return MOONSHOT_MAX_OUTPUT_TOKENS[modelId] ?? 8192;
}

// K3 was added to pi-ai in 0.80.9. Keep this small local fallback so the
// synchronous catalog/window path remains accurate, but use pi-ai's native
// model at runtime (see buildRuntimeMoonshotModel) so future protocol changes
// do not have to be mirrored here before requests can work.
const MOONSHOT_K3_PROTOCOL_FALLBACK: Pick<
  Model<'openai-completions'>,
  'reasoning' | 'thinkingLevelMap' | 'input' | 'compat'
> = {
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: 'max',
  },
  input: ['text', 'image'],
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStrictMode: false,
    thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true,
    deferredToolsMode: 'kimi',
  },
};

type PiBuiltinCatalog = typeof import('@earendil-works/pi-ai/providers/all');
let _piBuiltinCatalogPromise: Promise<PiBuiltinCatalog> | null = null;
function piBuiltinCatalog(): Promise<PiBuiltinCatalog> {
  if (!_piBuiltinCatalogPromise) {
    _piBuiltinCatalogPromise = import('@earendil-works/pi-ai/providers/all');
  }
  return _piBuiltinCatalogPromise;
}

/**
 * Build a `Model<"openai-completions">` object for a Moonshot model.
 * Exported for tests — production code usually goes through
 * `createMoonshotProvider()`.
 */
export function buildMoonshotModel(
  modelId: string,
  nativeModel?: Model<'openai-completions'>,
): Model<'openai-completions'> {
  // Server model_catalog metadata is authoritative when present. The local
  // tables remain conservative fallbacks for offline/stale configurations.
  const curated = curatedModelsFor('moonshot').find((m) => m.id === modelId);
  const fallbackProtocol = modelId === 'kimi-k3' ? MOONSHOT_K3_PROTOCOL_FALLBACK : null;
  const protocol = nativeModel || fallbackProtocol;
  return {
    id: modelId,
    name: curated?.name || modelId,
    api: 'openai-completions',
    // `Provider` in pi-ai accepts arbitrary strings (not just KnownProvider)
    // so using a custom id here is supported.
    provider: 'moonshot' as any,
    baseUrl: MOONSHOT_BASE_URL,
    reasoning: protocol?.reasoning ?? false,
    ...(protocol?.thinkingLevelMap
      ? { thinkingLevelMap: { ...protocol.thinkingLevelMap } }
      : {}),
    input: modelInputFromConfiguredCapabilities(
      protocol ? [...protocol.input] : ['text', 'image'],
      curated,
    ),
    // The Moonshot open platform bills per token, but pi-ai's `cost`
    // field is only used for local cost-statistics display and does not
    // affect the actual request. Filling 0 means "not accounted for here";
    // users check the actual price on their Moonshot bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredPositiveInteger(curated?.contextWindow, moonshotContextWindow(modelId)),
    maxTokens: configuredPositiveInteger(curated?.maxTokens, moonshotMaxOutputTokens(modelId)),
    ...(nativeModel?.headers ? { headers: { ...nativeModel.headers } } : {}),
    ...(protocol?.compat ? { compat: { ...protocol.compat } } : {}),
  };
}

/** Build the request-time model with pi-ai's native Moonshot protocol data. */
export async function buildRuntimeMoonshotModel(modelId: string): Promise<Model<'openai-completions'>> {
  const catalog = await piBuiltinCatalog();
  const nativeModel = (catalog.getBuiltinModel as (
    providerId: string,
    requestedModelId: string,
  ) => Model<'openai-completions'> | undefined)('moonshotai-cn', modelId);
  return buildMoonshotModel(modelId, nativeModel);
}

export interface CreateMoonshotProviderConfig {
  apiKey: string;
  modelId: string;
}

/**
 * Build an LLMProvider wired to the Moonshot open-platform endpoint.
 *
 * Async because core-agent is loaded on-demand (ESM from CJS main).
 * Calling this does NOT talk to the network — it just wires a pi-ai
 * provider wrapper around our hand-built Model. First network request
 * is deferred until the returned provider's `complete` / `stream` is
 * invoked.
 */
export async function createMoonshotProvider(config: CreateMoonshotProviderConfig): Promise<LLMProvider> {
  if (!config.apiKey) throw new Error('moonshot: apiKey required');
  if (!config.modelId) throw new Error('moonshot: modelId required');
  const [mod, model] = await Promise.all([
    ca(),
    buildRuntimeMoonshotModel(config.modelId),
  ]);
  return mod.createPiProvider({
    provider: 'moonshot',
    apiKey: config.apiKey,
    customModel: model,
    onPayload: repairOpenAICompatiblePayload,
  });
}

// ── DeepSeek (https://api.deepseek.com/v1) ──────────────────────────────

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

// Context windows from https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-08). DeepSeek V4 series introduced 1M-token context via
// Compressed Sparse Attention. Fallback 131072 for unknown ids (safe lower
// bound; older deprecated v3 snapshots top out there).
const DEEPSEEK_CONTEXT_WINDOW: Record<string, number> = {
  'deepseek-v4-pro':              1_048_576,
  'deepseek-v4-flash-vision-exp': 1_048_576,
  'deepseek-v4-flash':            1_048_576,
};

function deepseekContextWindow(modelId: string): number {
  return DEEPSEEK_CONTEXT_WINDOW[modelId] ?? 131072;
}

// The official V4 pricing/spec table lists a 384K maximum output for Pro,
// Flash, and Flash Vision Exp. pi-ai clamps only against remaining context,
// so preserving the provider's real cap avoids silently truncating long
// reasoning + answers. Unknown/legacy ids retain a conservative 8192 fallback.
const DEEPSEEK_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'deepseek-v4-pro':              384_000,
  'deepseek-v4-flash-vision-exp': 384_000,
  'deepseek-v4-flash':            384_000,
};

function deepseekMaxOutputTokens(modelId: string): number {
  return DEEPSEEK_MAX_OUTPUT_TOKENS[modelId] ?? 8192;
}

export function buildDeepSeekModel(modelId: string): Model<'openai-completions'> {
  const curated = curatedModelsFor('deepseek').find((m) => m.id === modelId);
  const configuredVision = configuredModelVisionDeclaration(curated);
  return {
    id: modelId,
    name: curated?.name || modelId,
    api: 'openai-completions',
    provider: 'deepseek' as any,
    baseUrl: DEEPSEEK_BASE_URL,
    // Both V4 Pro and V4 Flash must be treated as reasoners: empirically
    // V4 Flash also spontaneously returns `reasoning_content`, and once
    // that lands in session history, subsequent turns missing
    // `reasoning_effort` get rejected by DeepSeek (misleading error
    // message "reasoning_content in the thinking mode must be passed
    // back"). pi-ai's openai-completions adapter only attaches
    // `reasoning_effort` when `model.reasoning === true` (see pi-ai
    // openai-completions.js line 396), so we must mark every v4-* as
    // true, paired with `defaultReasoning: 'low'` below so the request
    // always carries the effort field.
    reasoning: /^deepseek-v4-/.test(modelId),
    // Official Pro/Flash aliases remain text-only. Flash Vision and remotely
    // configured models can declare supportsVision explicitly; an omitted
    // declaration defaults to visual for parity with user-defined endpoints.
    input: openAICompatibleModelSupportsImages(modelId, configuredVision, true)
      ? ['text', 'image']
      : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredPositiveInteger(curated?.contextWindow, deepseekContextWindow(modelId)),
    maxTokens: configuredPositiveInteger(curated?.maxTokens, deepseekMaxOutputTokens(modelId)),
  };
}

export interface CreateDeepSeekProviderConfig {
  apiKey: string;
  modelId: string;
}

export async function createDeepSeekProvider(config: CreateDeepSeekProviderConfig): Promise<LLMProvider> {
  if (!config.apiKey) throw new Error('deepseek: apiKey required');
  if (!config.modelId) throw new Error('deepseek: modelId required');
  const mod = await ca();
  const model = buildDeepSeekModel(config.modelId);
  return mod.createPiProvider({
    provider: 'deepseek',
    apiKey: config.apiKey,
    customModel: model,
    // DeepSeek V4 server-side validation has two symmetric failure modes
    // with the same misleading error message ("reasoning_content in the
    // thinking mode must be passed back to the API"):
    //   A. `reasoning_effort` missing + history has
    //      assistant.reasoning_content → 400
    //   B. `reasoning_effort` present + history has an assistant message
    //      missing reasoning_content → 400
    // The actual rule is: the presence of `reasoning_effort` must match
    // the presence of reasoning_content across all history (all-or-none);
    // a "half-open" mix is rejected.
    //
    // Observed scenario B: rotating-provider falls over from primary
    // candidate openai-codex to deepseek; pi-ai/transform-messages.js
    // downgrades codex's `thinking` blocks to plain text on a
    // cross-provider hop (losing thinkingSignature), so the history's
    // assistant message has no reasoning_content. Adding reasoning_effort
    // then triggers B.
    //
    // Fix: `onPayload` decides reasoning_effort dynamically — inspect
    // every prior assistant turn for reasoning_content
    // ("reasoning consistent"):
    //   - all have  → keep an explicitly requested reasoning_effort
    //   - not all   → drop only that explicit effort
    onPayload: repairDeepSeekPayload,
  });
}

// ── Doubao / Volcengine Ark (https://ark.cn-beijing.volces.com/api/v3) ───

const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// Doubao Seed 2.0 series on Volcengine Ark — 256k context window (verified
// against the official model card 2026-02). The user may enter either an
// endpoint id (ep-xxxx) or a model id; the context window is keyed by model
// id, with a 131072 safe lower-bound fallback for unknown ids.
const DOUBAO_CONTEXT_WINDOW: Record<string, number> = {
  'doubao-seed-2-0-pro-260215':  262144,
  'doubao-seed-2-0-lite-260215': 262144,
  'doubao-seed-2-0-lite-260428': 262144,
};

function doubaoContextWindow(modelId: string): number {
  return DOUBAO_CONTEXT_WINDOW[modelId] ?? 131072;
}

// 火山方舟 Seed 2.0 系列官方 max_tokens 上限 16K（控制台接入点配置可见）。
// 用户填的可能是 endpoint id（ep-xxxx）也可能是模型 id；endpoint id 形式
// 走 fallback 8192 兜底，不会撞到上游 400。
const DOUBAO_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'doubao-seed-2-0-pro-260215':  16384,
  'doubao-seed-2-0-lite-260215': 16384,
  'doubao-seed-2-0-lite-260428': 32768,
};

function doubaoMaxOutputTokens(modelId: string): number {
  return DOUBAO_MAX_OUTPUT_TOKENS[modelId] ?? 8192;
}

export function buildDoubaoModel(modelId: string): Model<'openai-completions'> {
  const curated = curatedModelsFor('doubao').find((m) => m.id === modelId);
  return {
    id: modelId,
    name: curated?.name || modelId,
    api: 'openai-completions',
    provider: 'doubao' as any,
    baseUrl: DOUBAO_BASE_URL,
    // Seed 2.0 Pro defaults to the reasoning channel; Lite is the
    // non-reasoning budget tier. Seed 1.x distinguished reasoning via a
    // `-thinking-` suffix, but Seed 2.0 switched to per-tier naming —
    // we recognize both naming schemes for compatibility.
    reasoning: /-pro-/.test(modelId) || /thinking/.test(modelId),
    // Volcengine Ark's OpenAI-compatible endpoint only accepts
    // system/assistant/user/tool; pi-ai by default auto-enables OpenAI's
    // developer role for unknown providers, which Ark rejects with a
    // 400. Disable it explicitly.
    compat: { supportsDeveloperRole: false },
    input: modelInputFromConfiguredCapabilities(['text', 'image'], curated),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredPositiveInteger(curated?.contextWindow, doubaoContextWindow(modelId)),
    maxTokens: configuredPositiveInteger(curated?.maxTokens, doubaoMaxOutputTokens(modelId)),
  };
}

export interface CreateDoubaoProviderConfig {
  apiKey: string;
  modelId: string;
}

export async function createDoubaoProvider(config: CreateDoubaoProviderConfig): Promise<LLMProvider> {
  if (!config.apiKey) throw new Error('doubao: apiKey required');
  if (!config.modelId) throw new Error('doubao: modelId required');
  const mod = await ca();
  const model = buildDoubaoModel(config.modelId);
  return mod.createPiProvider({
    provider: 'doubao',
    apiKey: config.apiKey,
    customModel: model,
    onPayload: repairOpenAICompatiblePayload,
  });
}

// ── User-configured OpenAI-compatible endpoint ──────────────────────────

export interface CreateCustomOpenAICompatibleProviderConfig
  extends CustomOpenAICompatibleRuntimeConfig {
  apiKey: string;
  modelId: string;
}

export function buildCustomOpenAICompatibleModel(
  modelId: string,
  config: CustomOpenAICompatibleRuntimeConfig,
): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'custom' as any,
    baseUrl: config.baseUrl,
    reasoning: config.supportsReasoning ?? !!config.reasoningEffort,
    input: openAICompatibleModelSupportsImages(modelId, config.supportsVision, true)
      ? ['text', 'image']
      : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: !!config.reasoningEffort,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    },
  };
}

export async function createCustomOpenAICompatibleProvider(
  config: CreateCustomOpenAICompatibleProviderConfig,
): Promise<LLMProvider> {
  if (!config.apiKey) throw new Error('custom: apiKey required');
  if (!isBearerTokenHeaderSafe(config.apiKey)) {
    throw Object.assign(
      new Error(
        'Custom model has an invalid API key for HTTP Authorization headers. Re-enter it in Settings.',
      ),
      { code: 'CUSTOM_API_KEY_INVALID' },
    );
  }
  if (!config.modelId) throw new Error('custom: modelId required');
  if (!config.baseUrl) throw new Error('custom: baseUrl required');
  const mod = await ca();
  return mod.createPiProvider({
    provider: 'custom',
    apiKey: config.apiKey,
    customModel: buildCustomOpenAICompatibleModel(config.modelId, config),
    onPayload: repairOpenAICompatiblePayload,
    ...(config.reasoningEffort ? { defaultReasoning: config.reasoningEffort } : {}),
  });
}
