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
 *     OpenAI-compatible (Volcengine 火山方舟). User must create a "model
 *     endpoint" (接入点 ID) in the ark console and use that id as the
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

// core-agent 是 ESM 包，Orkas main 进程走 CJS，**不能**静态 import。沿用
// runner.ts / session-store.ts 的动态 import + 懒缓存 pattern。
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
    // Moonshot 开放平台收费按 token 算，但 pi-ai 的 cost 字段只用于本地成本
    // 统计展示，不影响请求。填 0 代表"不在此处核算"，具体价格用户去 Moonshot
    // 账单看。
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
 * Build an LLMProvider wired to the Moonshot 开放平台 endpoint.
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
    // V4 Pro / V4 Flash 都需当 reasoner 处理：实测 V4 Flash 也会自发返回
    // `reasoning_content`，一旦进入 session 历史，后续轮次缺 `reasoning_effort`
    // 就会被 DeepSeek 拒（误导性错误 "reasoning_content in the thinking mode
    // must be passed back"）。pi-ai 的 openai-completions 适配器只在
    // `model.reasoning === true` 时才会拼 `reasoning_effort`（见 pi-ai
    // openai-completions.js 第 396 行），所以这里必须把 v4-* 全部标 true，
    // 配合下面的 `defaultReasoning: 'low'` 让请求里恒带 effort。
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
    // DeepSeek V4 server-side 校验有两个对称失效模式,误导性错误信息相同
    // ("reasoning_content in the thinking mode must be passed back to the API"):
    //   A. `reasoning_effort` 缺失 + 历史里有 assistant.reasoning_content → 400
    //   B. `reasoning_effort` 存在 + 历史里有 assistant 缺 reasoning_content → 400
    // 真正的规则是:`reasoning_effort` 的存在必须与 history 的 reasoning_content
    // 保持一致(全有 / 全无),不能"半开半关"。
    //
    // 实测场景 B:rotating-provider 把主候选 openai-codex 失败后 fallback 到
    // deepseek,pi-ai/transform-messages.js 在 cross-provider 时把 codex 的
    // `thinking` 块降级成纯文本(丢 thinkingSignature),history 里 assistant
    // 没有 reasoning_content。我们再带 reasoning_effort 就触发 B。
    //
    // 修法:`onPayload` 动态决定 reasoning_effort —— 检查所有 prior assistant
    // 是否都带 reasoning_content(即"reasoning consistent"):
    //   - 都有  → 保留 reasoning_effort  (反向治 A)
    //   - 不全有 → 删掉 reasoning_effort (治 B)
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

// ── Doubao / 火山方舟 (https://ark.cn-beijing.volces.com/api/v3) ─────────

const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// 火山方舟 Doubao Seed 2.0 系列 256k 上下文（官方 model card 2026-02 核对）。
// 用户填的可能是 endpoint id（ep-xxxx）也可能是模型 id；上下文窗口以
// 模型为准，未知 id fallback 到 131072 安全下界。
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
    // Seed 2.0 Pro 默认走推理通道；Lite 是非推理性价比档。Seed 1.x
    // 用 `-thinking-` 后缀区分 reasoning，但 Seed 2.0 系列改成档位区分，
    // 兼容两套命名都能正确识别。
    reasoning: /-pro-/.test(modelId) || /thinking/.test(modelId),
    // 火山方舟 OpenAI 兼容端只接受 system/assistant/user/tool；pi-ai 默认对未知
    // provider 自动启用 OpenAI 的 developer role，会被方舟 400 拒掉。显式关掉。
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
