/**
 * External providers — factories for chat providers that pi-ai 0.68.1
 * doesn't ship out of the box.
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
import type { Model } from '@mariozechner/pi-ai';
import { curatedModelsFor } from '../provider_catalog';

// core-agent is an ESM package and the Orkas main process is CJS, so
// **static import is not allowed**. Reuse the dynamic-import + lazy cache
// pattern from runner.ts / session-store.ts.
type CA = typeof import('#core-agent');
let _caPromise: Promise<CA> | null = null;
function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
}

// ── Moonshot open-platform (https://api.moonshot.cn/v1) ─────────────────

const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';

/**
 * Context windows by Moonshot model id. Numbers come from
 * platform.kimi.com/docs/models (checked 2026-04). Fallback 131072 for
 * ids we haven't catalogued — safe lower bound given every current kimi
 * model is at least 128k. Catalog only ships K2.5 / K2.6; legacy K2 preview
 * ids still resolve via fallback if a stale credential references them.
 */
const MOONSHOT_CONTEXT_WINDOW: Record<string, number> = {
  'kimi-k2.6': 262144,
  'kimi-k2.5': 262144,
};

function moonshotContextWindow(modelId: string): number {
  return MOONSHOT_CONTEXT_WINDOW[modelId] ?? 131072;
}

/**
 * Build a `Model<"openai-completions">` object for a Moonshot model.
 * Exported for tests — production code usually goes through
 * `createMoonshotProvider()`.
 */
export function buildMoonshotModel(modelId: string): Model<'openai-completions'> {
  // `name` defaults to the curated label if we have one; otherwise the id.
  const curated = curatedModelsFor('moonshot').find((m) => m.id === modelId);
  return {
    id: modelId,
    name: curated?.name || modelId,
    api: 'openai-completions',
    // `Provider` in pi-ai accepts arbitrary strings (not just KnownProvider)
    // so using a custom id here is supported.
    provider: 'moonshot' as any,
    baseUrl: MOONSHOT_BASE_URL,
    reasoning: false,
    input: ['text', 'image'],
    // The Moonshot open platform bills per token, but pi-ai's `cost`
    // field is only used for local cost-statistics display and does not
    // affect the actual request. Filling 0 means "not accounted for here";
    // users check the actual price on their Moonshot bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: moonshotContextWindow(modelId),
    maxTokens: 8192,
  };
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
  const mod = await ca();
  const model = buildMoonshotModel(config.modelId);
  return mod.createPiProvider({
    provider: 'moonshot',
    apiKey: config.apiKey,
    customModel: model,
  });
}

// ── DeepSeek (https://api.deepseek.com/v1) ──────────────────────────────

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

// Context windows from https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-04). DeepSeek V4 series introduced 1M-token context via
// Compressed Sparse Attention. Fallback 131072 for unknown ids (safe lower
// bound; older deprecated v3 snapshots top out there).
const DEEPSEEK_CONTEXT_WINDOW: Record<string, number> = {
  'deepseek-v4-pro':   1_048_576,
  'deepseek-v4-flash': 1_048_576,
};

function deepseekContextWindow(modelId: string): number {
  return DEEPSEEK_CONTEXT_WINDOW[modelId] ?? 131072;
}

export function buildDeepSeekModel(modelId: string): Model<'openai-completions'> {
  const curated = curatedModelsFor('deepseek').find((m) => m.id === modelId);
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
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: deepseekContextWindow(modelId),
    maxTokens: 8192,
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
    //   - all have  → keep reasoning_effort  (covers A in reverse)
    //   - not all   → drop reasoning_effort  (covers B)
    onPayload: (params) => {
      try {
        const p = params as { reasoning_effort?: string; messages?: Array<{ role?: string; reasoning_content?: unknown; reasoning?: unknown }> };
        const priorAssistants = (p.messages || []).filter((m) => m && m.role === 'assistant');
        if (priorAssistants.length === 0) {
          // No prior turns — nothing to be inconsistent with. Default
          // direction: keep reasoning_effort if model.reasoning=true so a
          // fresh thinking-mode session works.
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
    },
    ...(model.reasoning ? { defaultReasoning: 'low' as const } : {}),
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
};

function doubaoContextWindow(modelId: string): number {
  return DOUBAO_CONTEXT_WINDOW[modelId] ?? 131072;
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
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: doubaoContextWindow(modelId),
    maxTokens: 8192,
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
  });
}
