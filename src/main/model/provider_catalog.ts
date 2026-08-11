/**
 * Provider catalog — the single place to curate which providers the settings
 * page offers. Provider model defaults live in features/client_config.ts and
 * are registered through the central client-config manager.
 *
 * ## Layout
 *
 *   CATALOG          — ordered list of visible providers (one entry per
 *                      provider card). This is the source of truth; every
 *                      other export is derived from it.
 *   CURATED_MODELS   — default per-provider model whitelist shown in the
 *                      model dropdown. Can be overridden by model-catalog JSON.
 *   EXTRA_LABELS     — friendly labels for providers that aren't in
 *                      CATALOG but may show up via legacy saved profiles.
 *
 * ## Selection policy
 *
 * The shipped catalog generally favors the two newest useful version
 * generations, but this is a curation guideline rather than a runtime cap.
 * Keep older models when capability or product coverage justifies them.
 * Runtime SDK discovery never makes an unlisted provider/model selectable.
 *
 * Runtime override:
 *   Server remote-config can override model_catalog; the desktop cache is
 *   last-known-good only, not a local source of truth.
 *
 * ## OAuth
 *
 * OAuth capability is part of the shipped product catalog. The implementation
 * module is still validated and loaded only when the user starts an OAuth
 * flow. `oauthOnly: true` tells the UI not to offer the API-key path.
 */

import {
  DEFAULT_IMAGE_GEN_BY_PROVIDER,
  DEFAULT_PROVIDER_MODELS,
  type ImageGenCapability as ConfigImageGenCapability,
  type ProviderModelEntry,
  getConfiguredImageGenCapability,
  getConfiguredProviderModels,
} from '../features/client_config';
import type { Api, Model } from '@earendil-works/pi-ai';

// ── Catalog entry shape ─────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;                 // pi-ai provider id (matches listPiProviders())
  label: string;              // display label
  labelKey?: string;          // renderer i18n key for localized generic labels
  docsUrl?: string;           // where to create an API key (shown in the add-key form)
  region?: 'cn';              // 'cn' marks providers whose primary endpoint is in China
  oauthOnly?: boolean;        // if true, hide the API-key path entirely
  managedByOrkas?: boolean;   // if true, Orkas Server brokers the model; no user API key is needed
  customOpenAICompatible?: boolean; // user supplies base URL + model metadata
  /** Per-provider prerequisite note shown on the card + the add-key form.
   *  Used when the same "brand" has two independent billing/auth surfaces
   *  (e.g. Moonshot pay-as-you-go open platform vs. Kimi Coding Plan
   *  monthly subscription) so users
   *  can tell which one they have before wasting a key. Keep it short —
   *  one sentence max, UI shows it with a warning-style accent.
   *
   *  **Value is an i18n key** (e.g. `provider.moonshot.note_paygo`), not raw
   *  text. Renderer resolves via `t()` so the hint follows UI language. */
  subscriptionNote?: string;
  /** Mark a provider as the recommended default. UI shows a "Recommended"
   *  suffix on the picker label. Purely cosmetic — does not change selection
   *  defaults or routing. */
  recommended?: boolean;
}

// ── Ordered catalog (dropdown order = array order) ──────────────────────
//
// Group 0: optional/direct provider. Production builds hide DeepSeek by
// default via provider_policy.ts; dev builds keep it for local testing.
// Group 1: global frontier labs (Anthropic, OpenAI, Google)
// Group 2: China mainstream (Zhipu GLM, Moonshot Kimi, MiniMax)
// Group 3: aggregators (OpenRouter)

export const CATALOG: readonly CatalogEntry[] = [
  // DeepSeek direct (not in pi-ai 0.68.1; routed through the
  // openai-completions adapter in external-providers.ts).
  { id: 'deepseek',     label: 'DeepSeek',      docsUrl: 'https://platform.deepseek.com/api_keys' },

  { id: 'openai-codex', label: 'OpenAI Codex',  oauthOnly: true },
  { id: 'openai',       label: 'OpenAI',        docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google',       label: 'Google Gemini', docsUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'anthropic',    label: 'Anthropic',     docsUrl: 'https://console.anthropic.com/settings/keys' },

  { id: 'zai',                label: 'Zhipu GLM',     docsUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',      region: 'cn' },
  // Moonshot has two independently-billed endpoints:
  //   - `moonshot` → https://api.moonshot.cn/v1 (OpenAI-compatible,
  //     pay-as-you-go open platform).
  //   - `kimi-coding` → https://api.kimi.com/coding (Anthropic protocol,
  //     monthly subscription for Kimi Coding only).
  // Both bind to the same Moonshot account but have separate auth and
  // quota — a single key cannot be used on both. The UI shows them as
  // two separate cards, each with its own `subscriptionNote`.
  { id: 'moonshot',           label: 'Moonshot',      docsUrl: 'https://platform.moonshot.cn/console/api-keys',              region: 'cn',
    subscriptionNote: 'provider.moonshot.note_paygo' },
  { id: 'kimi-coding',        label: 'Moonshot Coding Plan', docsUrl: 'https://platform.moonshot.cn/console/api-keys',           region: 'cn',
    subscriptionNote: 'provider.kimi_coding.note_subscription' },
  // MiniMax has two surfaces: the API-key endpoint (minimax-cn) and the
  // OAuth "portal" endpoint. They're separate pi-ai provider ids with
  // different base URLs and auth modes, so they surface as separate cards.
  { id: 'minimax-portal',     label: 'MiniMax (Global)', oauthOnly: true, region: 'cn' },
  { id: 'minimax-portal-cn',  label: 'MiniMax (CN)',     oauthOnly: true, region: 'cn' },
  { id: 'minimax-cn',         label: 'MiniMax',       docsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', region: 'cn' },

  // Doubao / Volcengine Ark
  { id: 'doubao',             label: 'Doubao',  docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', region: 'cn',
    subscriptionNote: '' },

  { id: 'openrouter',         label: 'OpenRouter',    docsUrl: 'https://openrouter.ai/keys' },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    labelKey: 'provider.custom.label',
    customOpenAICompatible: true,
  },
];

// ── Curated model lists ─────────────────────────────────────────────────
//
// The sole source of truth for what shows up in the model dropdown.
// Order in the array = order shown to the user — put the flagship first.
// Ids must match pi-ai's `listPiModels(provider)` exactly.
//
// Providers without an entry here expose no selectable chat models.

export const CURATED_MODELS = DEFAULT_PROVIDER_MODELS;

export function curatedModelsFor(providerId: string): ProviderModelEntry[] {
  const configured = getConfiguredProviderModels(providerId);
  const list = configured?.models || CURATED_MODELS[providerId];
  return list ? list.map((model) => ({
    ...model,
    ...(model.includedModels ? { includedModels: [...model.includedModels] } : {}),
  })) : [];
}

/** Product boundary for image blocks in one chat-model request. Attachment
 * storage may keep more files over the life of a conversation, but a single
 * composer turn currently accepts at most 20 attachments. */
export const MAX_MODEL_INPUT_IMAGES = 20;
export const DEFAULT_MODEL_INPUT_IMAGE_LIMIT = 5;

/**
 * Resolve the image count for one concrete provider/model candidate.
 *
 * Model protocol metadata is authoritative for whether images are supported
 * at all. The remotely configurable catalog may then declare the provider's
 * exact per-request count. Unknown multimodal models retain the old,
 * conservative five-image behavior instead of risking an upstream 400.
 */
export function modelInputImageLimit(
  providerId: string,
  modelId: string,
  model: Pick<Model<Api>, 'id' | 'input'> | null | undefined,
): number {
  if (!model?.input?.includes('image')) return 0;
  const configured = curatedModelsFor(providerId)
    .find((entry) => entry.id === modelId || entry.id === model.id);
  const raw = configured?.maxInputImages;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_MODEL_INPUT_IMAGE_LIMIT;
  }
  return Math.min(MAX_MODEL_INPUT_IMAGES, Math.max(0, Math.trunc(raw)));
}

/**
 * pi-ai catalog aliases for provider ids that are runtime surfaces, not raw
 * catalog provider ids. The model metadata is still valid because the alias
 * points to the same API protocol and base URL family.
 */
export const PI_MODEL_PROVIDER_ALIAS: Readonly<Record<string, string>> = {
  'minimax-portal-cn': 'minimax-cn',
  'minimax-portal':    'minimax',
};

const PI_MODEL_TEMPLATE_ALIAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'kimi-coding': {
    k2p7: 'kimi-for-coding',
    k2p6: 'kimi-for-coding',
  },
};

const PI_MODEL_TEMPLATE_ALIAS_LABEL: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'kimi-coding': {
    k2p7: 'Kimi K2.7 Code',
    k2p6: 'Kimi K2.6',
  },
};

const MODEL_UPGRADE_ALIAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  anthropic: {
    'claude-opus-4-7': 'claude-opus-5',
    'claude-opus-4-8': 'claude-opus-5',
    'claude-sonnet-5': 'claude-fable-5',
  },
  'openai-codex': {
    'gpt-5.6-luna': 'gpt-5.6-terra',
    'gpt-5.5': 'gpt-5.6-sol',
  },
  openai: {
    'gpt-5.6-luna': 'gpt-5.6-terra',
    'gpt-5.5': 'gpt-5.6-sol',
  },
  google: {
    'gemini-3-flash-preview': 'gemini-3.6-flash',
    'gemini-3.5-flash': 'gemini-3.6-flash',
    'gemini-3-pro-preview': 'gemini-3.6-flash',
    'gemini-3.1-pro-preview': 'gemini-3.6-flash',
    'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite',
  },
  moonshot: {
    'kimi-k2.5': 'kimi-k2.7-code',
  },
  'kimi-coding': {
    k2p6: 'k2p7',
    'kimi-k2-thinking': 'k2p7',
  },
  'minimax-cn': {
    'MiniMax-M2.7-highspeed': 'MiniMax-M3',
  },
  'minimax-portal': {
    'MiniMax-M2.7-highspeed': 'MiniMax-M3',
  },
  'minimax-portal-cn': {
    'MiniMax-M2.7-highspeed': 'MiniMax-M3',
  },
  doubao: {
    'doubao-seed-2-0-lite-260215': 'doubao-seed-2-0-lite-260428',
  },
  openrouter: {
    'anthropic/claude-opus-4.7': 'anthropic/claude-opus-5',
    'anthropic/claude-opus-4.8': 'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5': 'anthropic/claude-fable-5',
    'openai/gpt-5.5': 'openai/gpt-5.6-sol',
    'openai/gpt-5.6-luna': 'openai/gpt-5.6-terra',
    'google/gemini-3-flash-preview': 'google/gemini-3.6-flash',
    'google/gemini-3.5-flash': 'google/gemini-3.6-flash',
    'google/gemini-3-pro-preview': 'google/gemini-3.6-flash',
    'google/gemini-3.1-pro-preview': 'google/gemini-3.6-flash',
    'google/gemini-3.1-flash-lite-preview': 'google/gemini-3.5-flash-lite',
    'google/gemini-3.1-flash-lite': 'google/gemini-3.5-flash-lite',
    'deepseek/deepseek-v4-flash': 'deepseek/deepseek-v4-flash-0731',
    'moonshotai/kimi-k2.5': 'moonshotai/kimi-k3',
    'moonshotai/kimi-k2.6': 'moonshotai/kimi-k3',
    'moonshotai/kimi-k2.7-code': 'moonshotai/kimi-k3',
    'qwen/qwen3-max': 'qwen/qwen3.7-max',
    'qwen/qwen3-coder': 'qwen/qwen3.7-max',
    'qwen/qwen3-coder-next': 'qwen/qwen3.7-max',
    'qwen/qwen3.7-flash': 'qwen/qwen3.7-plus',
    'z-ai/glm-5.1': 'z-ai/glm-5.2',
    'minimax/minimax-m2.7': 'minimax/minimax-m3',
  },
};

export interface ModelUpgradeResolution {
  providerId: string;
  modelId: string;
  previousModelId: string;
  upgraded: boolean;
}

function isModelInSelectionList(providerId: string, modelId: string): boolean {
  return curatedModelsFor(providerId).some((m) => m.id === modelId);
}

/** OpenRouter is a relay over a large, fast-moving catalog. Its public model
 * ids are deliberately accepted outside our small shortcut list; the list is
 * navigation, not an authorization boundary. Keep validation shape-only so
 * aliases such as `:free` and newly released vendor slugs remain usable. */
function isValidOpenRouterModelId(modelId: string): boolean {
  return modelId.length > 0
    && modelId.length <= 200
    && !/[\s\u0000-\u001f\u007f]/.test(modelId);
}

export function resolveModelUpgrade(providerId: string, modelId: string): ModelUpgradeResolution {
  const requestedProviderId = String(providerId || '').trim();
  const requestedModelId = String(modelId || '').trim();
  let upgradedModelId = requestedModelId;
  if (requestedModelId && !isModelInSelectionList(requestedProviderId, requestedModelId)) {
    const aliasTarget = MODEL_UPGRADE_ALIAS[requestedProviderId]?.[requestedModelId];
    if (aliasTarget && isModelInSelectionList(requestedProviderId, aliasTarget)) {
      upgradedModelId = aliasTarget;
    }
  }
  return {
    providerId: requestedProviderId,
    modelId: upgradedModelId,
    previousModelId: requestedModelId,
    upgraded: !!requestedModelId && upgradedModelId !== requestedModelId,
  };
}

/**
 * Return whether a provider/model pair belongs to the current user-facing
 * chat-model catalog. This is the single whitelist shared by Settings,
 * persisted-entry recovery, connection tests, and runtime routing.
 *
 * Explicit upgrade aliases are resolved first so a known retired id can be
 * migrated to its catalog replacement. OpenRouter is the intentional
 * exception: it accepts validated user-entered ids because its upstream
 * catalog is much larger and changes faster than our shortcut list.
 */
export function isSelectableModel(providerId: string, modelId: string): boolean {
  const provider = String(providerId || '').trim();
  const requested = String(modelId || '').trim();
  if (!provider || !requested || !isKnownModelProvider(provider)) return false;
  if (provider === 'custom') {
    return requested.length <= 200 && !/[\u0000-\u001f\u007f]/.test(requested);
  }
  const resolved = resolveModelUpgrade(provider, requested);
  if (provider === 'openrouter') return isValidOpenRouterModelId(resolved.modelId);
  return isModelInSelectionList(provider, resolved.modelId);
}

export interface PiModelCatalogLike {
  getPiModel(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ConfiguredPiModelResolution {
  model: Model<Api>;
  requestedProviderId: string;
  requestedModelId: string;
  catalogProviderId: string;
  templateModelId: string;
  isConfiguredFallback: boolean;
  needsCustomModel: boolean;
}

function safeGetPiModel(
  catalog: PiModelCatalogLike,
  providerId: string,
  modelId: string,
): Model<Api> | undefined {
  try {
    return catalog.getPiModel(providerId, modelId);
  } catch {
    return undefined;
  }
}

function cloneModelWithId(
  template: Model<Api>,
  id: string,
  name: string,
  overrides?: Pick<ProviderModelEntry, 'contextWindow' | 'maxTokens'>,
): Model<Api> {
  const cloned = {
    ...template,
    id,
    name,
    input: [...template.input],
    cost: { ...template.cost },
    ...(template.headers ? { headers: { ...template.headers } } : {}),
    ...(template.thinkingLevelMap ? { thinkingLevelMap: { ...template.thinkingLevelMap } } : {}),
  };
  return applyConfiguredModelOverrides(cloned, overrides);
}

function hasConfiguredModelOverrides(configured: ProviderModelEntry | undefined): boolean {
  return !!configured
    && (typeof configured.contextWindow === 'number' || typeof configured.maxTokens === 'number');
}

function applyConfiguredModelOverrides(
  model: Model<Api>,
  overrides?: Pick<ProviderModelEntry, 'contextWindow' | 'maxTokens'>,
): Model<Api> {
  if (!overrides) return model;
  return {
    ...model,
    ...(typeof overrides.contextWindow === 'number' && overrides.contextWindow > 0
      ? { contextWindow: overrides.contextWindow }
      : {}),
    ...(typeof overrides.maxTokens === 'number' && overrides.maxTokens > 0
      ? { maxTokens: overrides.maxTokens }
      : {}),
  };
}

function modelFamilyKey(modelId: string): string {
  return String(modelId || '')
    .toLowerCase()
    .replace(/^.+?\//, '')
    .replace(/[:._]+/g, '-')
    .split('-')
    .filter((part) => part && !/^\d/.test(part))
    .filter((part) => !/^(latest|preview|experimental|exp|early|beta|free)$/.test(part))
    .join('-');
}

/**
 * Resolve a model for runtime use.
 *
 * Server config may intentionally advertise a newly released model id before
 * pi-ai has shipped it. For those cases, clone metadata from a configured,
 * same-family model that pi-ai already knows and override only id/name. This
 * keeps provider protocol, base URL, context defaults and payload handling in
 * one place while letting model-version bumps ship via Server JSON.
 */
export function resolveConfiguredPiModel(
  catalog: PiModelCatalogLike,
  providerId: string,
  modelId: string,
): ConfiguredPiModelResolution | null {
  const requestedProviderId = String(providerId || '').trim();
  const requestedModelId = resolveModelUpgrade(requestedProviderId, modelId).modelId;
  if (!requestedProviderId || !requestedModelId) return null;

  const catalogProviderId = PI_MODEL_PROVIDER_ALIAS[requestedProviderId] || requestedProviderId;
  const configuredModels = curatedModelsFor(requestedProviderId);
  const configured = configuredModels.find((m) => m.id === requestedModelId);
  const exact = safeGetPiModel(catalog, catalogProviderId, requestedModelId);
  if (exact) {
    return {
      model: applyConfiguredModelOverrides(exact, configured),
      requestedProviderId,
      requestedModelId,
      catalogProviderId,
      templateModelId: requestedModelId,
      isConfiguredFallback: false,
      needsCustomModel: catalogProviderId !== requestedProviderId || hasConfiguredModelOverrides(configured),
    };
  }

  const templateAlias = configured?.template || PI_MODEL_TEMPLATE_ALIAS[requestedProviderId]?.[requestedModelId];
  if (templateAlias) {
    const template = safeGetPiModel(catalog, catalogProviderId, templateAlias);
    if (template) {
      const name = configured?.name
        || PI_MODEL_TEMPLATE_ALIAS_LABEL[requestedProviderId]?.[requestedModelId]
        || requestedModelId;
      return {
        model: cloneModelWithId(template, requestedModelId, name, configured),
        requestedProviderId,
        requestedModelId,
        catalogProviderId,
        templateModelId: templateAlias,
        isConfiguredFallback: true,
        needsCustomModel: true,
      };
    }
  }

  // A manually entered OpenRouter slug may be newer than pi-ai's generated
  // catalog. Clone only the relay protocol/base URL from Auto Router and keep
  // the fallback text-only; exact SDK entries above retain their richer image
  // and token metadata as soon as pi-ai knows the model.
  if (!configured && requestedProviderId === 'openrouter' && isValidOpenRouterModelId(requestedModelId)) {
    const template = safeGetPiModel(catalog, catalogProviderId, 'openrouter/auto');
    if (template) {
      return {
        model: {
          ...cloneModelWithId(template, requestedModelId, requestedModelId),
          input: ['text'],
        },
        requestedProviderId,
        requestedModelId,
        catalogProviderId,
        templateModelId: 'openrouter/auto',
        isConfiguredFallback: true,
        needsCustomModel: true,
      };
    }
  }

  if (!configured) return null;

  const requestedFamily = modelFamilyKey(requestedModelId);
  const candidates = configuredModels
    .filter((m) => m.id !== requestedModelId)
    .filter((m) => requestedFamily && modelFamilyKey(m.id) === requestedFamily);

  for (const candidate of candidates) {
    const template = safeGetPiModel(catalog, catalogProviderId, candidate.id);
    if (!template) continue;
    return {
      model: cloneModelWithId(template, requestedModelId, configured.name || requestedModelId, configured),
      requestedProviderId,
      requestedModelId,
      catalogProviderId,
      templateModelId: candidate.id,
      isConfiguredFallback: true,
      needsCustomModel: true,
    };
  }

  return null;
}

/**
 * Map a resolved pi-ai model's window fields to a core-agent `models.catalog`
 * entry. The host (PC `buildRunner`) feeds this into `createConfig` so the
 * runner's compaction trigger uses the model's REAL context window — without
 * it, `config.models.catalog` is empty and the runner falls back to a 200K
 * window, compacting a 1M-window model at 0.8×200K=160K (G7). pi-ai's `Model`
 * carries `contextWindow` + `maxTokens`; the catalog field is `maxOutputTokens`.
 * Returns null when nothing is known (→ runner keeps its 200K fallback).
 */
export function modelCatalogEntryFromModel(
  model: { contextWindow?: number; maxTokens?: number } | null | undefined,
): { contextWindow?: number; maxOutputTokens?: number } | null {
  if (!model) return null;
  const entry: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    entry.contextWindow = model.contextWindow;
  }
  if (typeof model.maxTokens === 'number' && model.maxTokens > 0) {
    entry.maxOutputTokens = model.maxTokens;
  }
  return Object.keys(entry).length ? entry : null;
}

// ── Labels for providers outside CATALOG ────────────────────────────────
//
// Only hit when the user has a legacy saved profile for a provider that
// no longer appears in the dropdown. Add to CATALOG instead if you want
// the provider to be offered in the add-credential flow.

export const EXTRA_LABELS: Readonly<Record<string, string>> = {
  'amazon-bedrock':         'Amazon Bedrock',
  'azure-openai-responses': 'Azure OpenAI',
  'cerebras':               'Cerebras',
  'github-copilot':         'GitHub Copilot',
  'google-antigravity':     'Google Antigravity',
  'google-gemini-cli':      'Google Gemini CLI',
  'google-vertex':          'Google Vertex',
  'groq':                   'Groq',
  'huggingface':            'Hugging Face',
  'minimax':                'MiniMax (Global)',
  'mistral':                'Mistral',
  'opencode':               'OpenCode',
  'opencode-go':            'OpenCode Go',
  'vercel-ai-gateway':      'Vercel AI Gateway',
  'xai':                    'xAI',
};

// ── Derived exports (back-compat with auth.ts) ──────────────────────────

/** Providers shown in the settings dropdown, in display order. */
export const VISIBLE_PROVIDERS: readonly string[] = CATALOG.map((p) => p.id);

/** Ordered index map for sorting. */
const CATALOG_ORDER = new Map<string, number>(CATALOG.map((p, i) => [p.id, i]));

export function isVisibleProvider(id: string): boolean {
  return CATALOG_ORDER.has(id);
}

/** Providers understood by the runtime but intentionally absent from the
 * user-addable provider picker. */
export const OFFICIAL_MODEL_PROVIDERS: readonly string[] = [];

export function isOfficialModelProvider(id: string): boolean {
  return OFFICIAL_MODEL_PROVIDERS.includes(String(id || '').trim());
}

export function isUserAddableProvider(id: string): boolean {
  return isVisibleProvider(String(id || '').trim());
}

export function isKnownModelProvider(id: string): boolean {
  const normalized = String(id || '').trim();
  return isUserAddableProvider(normalized) || isOfficialModelProvider(normalized);
}

export interface ProviderMeta {
  id: string;
  label: string;
  docsUrl?: string;
}

/**
 * Back-compat: the subset of CATALOG that advertises API-key setup (docsUrl).
 * `oauthOnly` providers (OpenAI Codex) are excluded.
 */
export const FEATURED_API_PROVIDERS: readonly ProviderMeta[] = CATALOG
  .filter((p) => !p.oauthOnly && p.docsUrl)
  .map((p) => ({ id: p.id, label: p.label, docsUrl: p.docsUrl }));

/**
 * Back-compat: providers that primarily exist as an OAuth backend. This
 * is the pi-ai-facing list used to advertise OAuth capability without loading
 * the OAuth implementation during startup or settings-shell rendering.
 */
export const OAUTH_PROVIDERS: readonly ProviderMeta[] = [
  { id: 'anthropic',          label: 'Anthropic (Claude Pro/Max)' },
  { id: 'openai-codex',       label: 'OpenAI Codex' },
  { id: 'google-gemini-cli',  label: 'Google Gemini' },
  { id: 'google-antigravity', label: 'Google Antigravity' },
  { id: 'github-copilot',     label: 'GitHub Copilot' },
  // Custom providers registered at runtime (features/oauth-minimax.ts).
  { id: 'minimax-portal',     label: 'MiniMax Subscription (Global)' },
  { id: 'minimax-portal-cn',  label: 'MiniMax Subscription (CN)' },
];

/**
 * OAuth alias map — when the API-key and OAuth surfaces access the **same**
 * underlying service, surface them on one card so users can pick their auth
 * method from a single entry instead of hunting for two look-alike dropdown
 * items.
 *
 * Rule of thumb: alias only when both surfaces call the same endpoint.
 *   - OpenAI ↔ OpenAI Codex → **do NOT alias** (different products; previous
 *     incident where conflating them caused confusion — keep them as two
 *     separate CATALOG entries).
 *   - MiniMax API key (`minimax-cn` → api.minimaxi.com) ↔ MiniMax OAuth CN
 *     (`minimax-portal-cn` → api.minimaxi.com) → **alias**. They're the same
 *     service, just authenticated differently. The Global OAuth surface
 *     (`minimax-portal` → api.minimax.io) stays as its own entry since its
 *     base URL differs.
 */
export const OAUTH_ALIAS_FOR: Readonly<Record<string, string>> = {
  'minimax-cn': 'minimax-portal-cn',
};

export function providerLabel(id: string): string {
  const c = CATALOG.find((p) => p.id === id);
  if (c) return c.label;
  if (EXTRA_LABELS[id]) return EXTRA_LABELS[id];
  const oauth = OAUTH_PROVIDERS.find((p) => p.id === id);
  if (oauth) return oauth.label;
  return id;
}

export function providerLabelKey(id: string): string | undefined {
  return CATALOG.find((p) => p.id === id)?.labelKey;
}

export function providerDocsUrl(id: string): string | undefined {
  return CATALOG.find((p) => p.id === id)?.docsUrl;
}

export function providerSubscriptionNote(id: string): string | undefined {
  return CATALOG.find((p) => p.id === id)?.subscriptionNote;
}

export function providerRecommended(id: string): boolean {
  return CATALOG.find((p) => p.id === id)?.recommended === true;
}

export function providerManagedByOrkas(id: string): boolean {
  if (isOfficialModelProvider(id)) return true;
  return CATALOG.find((p) => p.id === id)?.managedByOrkas === true;
}

export function providerUsesCustomOpenAIConfig(id: string): boolean {
  return CATALOG.find((p) => p.id === id)?.customOpenAICompatible === true;
}

export interface CustomOpenAICompatibleRuntimeConfig {
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  /** Optional OpenAI-compatible reasoning effort for curated relay profiles. */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Providers Orkas supports via a custom adapter in
 * `model/core-agent/external-providers.ts`, NOT via pi-ai's built-in
 * provider registry. `listProviders()` treats these as API-key-capable
 * even though `listPiProviders()` doesn't list them.
 */
export const EXTERNAL_API_PROVIDERS: readonly string[] = ['moonshot', 'deepseek', 'doubao', 'custom'];

// ── Image-generation capability map ─────────────────────────────────────
//
// provider id → fixed image-gen model + which HTTP API to dispatch to.
//
// Decoupled from CURATED_MODELS on purpose:
//   - The user's chat-model selection is irrelevant. As long as they have
//     configured *any* api-key entry on a provider in this map, image
//     generation will reuse that key against the provider's fixed image
//     model — no model switch required, no extra dropdown clutter.
//   - OAuth entries are NOT eligible (every OAuth surface we ship — Anthropic
//     Pro/Max, OpenAI Codex, Gemini CLI, Antigravity, MiniMax Portal, GitHub
//     Copilot — is scope-restricted or ToS-restricted away from image gen).
//     `features/image_gen.ts::pickImageGenProfile` enforces the api_key
//     filter; this map only declares "given an api_key for X, here's how".
//
// Adding a new provider: add an entry here AND a matching adapter in
// `features/image_gen.ts::dispatchImageGen`.

export type ImageGenCapability = ConfigImageGenCapability;

export const IMAGE_GEN_BY_PROVIDER = DEFAULT_IMAGE_GEN_BY_PROVIDER;

export function findImageGenCapability(providerId: string): ConfigImageGenCapability | null {
  const base = IMAGE_GEN_BY_PROVIDER[providerId] || null;
  const configured = getConfiguredImageGenCapability(providerId);
  if (!configured) return base;
  if (!base) {
    if (!configured.model || !configured.api) return null;
    return {
      model: configured.model,
      api: configured.api,
      supportsEdit: configured.supportsEdit === true,
    };
  }
  return {
    ...base,
    ...configured,
  };
}

/**
 * Sort provider ids by CATALOG order (authoritative). Ids not in CATALOG
 * sort after, alphabetically. Used to position "orphan" profile providers
 * at the bottom of the list.
 */
export function sortProviderIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ra = CATALOG_ORDER.has(a) ? (CATALOG_ORDER.get(a) as number) : 1000;
    const rb = CATALOG_ORDER.has(b) ? (CATALOG_ORDER.get(b) as number) : 1000;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

// ── Version-based model picker (catalog maintenance utility) ────────────

export interface RawModel { id: string; name?: string }

// Date snapshot suffix: -YYYYMMDD, -YYYY-MM-DD, or mid-id -YYYY-MM-DD-.
const DATE_RE = /-\d{4}-\d{2}-\d{2}(-|$)|-\d{8}(-|$)|-\d{4}(-|$)(?=[a-z])/;
// Preview / experimental / early builds shadow the rolling alias.
const PREVIEW_RE = /(?:^|[-_/])(?:preview|experimental|exp|early|beta)(?:[-_]|$)/i;
// Free mirror duplicates on openrouter etc.
const FREE_RE = /:free$/;

function normId(id: string): string {
  return id.replace(/^.+?\//, ''); // strip vendor prefix in openrouter-like ids
}

/**
 * First numeric version sequence in the id.
 *
 * Examples:
 *   "claude-opus-4-7"        → [4, 7]
 *   "gpt-5.4-mini"           → [5, 4]
 *   "gemini-2.5-pro"         → [2, 5]
 *   "grok-4.20"              → [4, 20]
 *   "llama-3.3-70b-versatile"→ [3, 3]   (stops at non-version "70b")
 *   "gpt-4o"                 → [4]      ("o" is not a digit)
 *   "groq/compound"          → []
 */
function extractVersion(id: string): number[] {
  const n = normId(id);
  const match = n.match(/(\d+(?:[.\-]\d+)*)/);
  if (!match) return [];
  return match[1].split(/[.\-]/).map((s) => parseInt(s, 10)).filter((v) => !isNaN(v));
}

/** (major, minor) tuple used to bucket models into "generations". */
function generationKey(version: number[]): string {
  if (!version.length) return '';
  if (version.length === 1) return String(version[0]);
  return `${version[0]}.${version[1]}`;
}

/** Compare two version arrays; returns positive if a > b. */
function cmpVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function cmpGenKey(a: string, b: string): number {
  return cmpVersion(parseGenKey(a), parseGenKey(b));
}
function parseGenKey(k: string): number[] {
  if (!k) return [];
  return k.split('.').map((s) => parseInt(s, 10)).filter((v) => !isNaN(v));
}

interface Scored {
  model: RawModel;
  genKey: string;
  version: number[];
  isAlias: boolean;
}

/**
 * Return every model from the latest N (major, minor) generations, sorted
 * newest → oldest. Within a generation, sort by full version descending so
 * the flagship comes before its older mini/nano siblings of the same tier.
 *
 * Filters applied before bucketing:
 *   - drop pinned snapshots (date-suffixed ids)
 *   - drop preview/experimental/beta builds
 *   - drop `:free` mirror entries (openrouter)
 *   - when `foo` and `foo-latest` both exist at the same version, keep
 *     whichever has a shorter id (stable, non-aliased).
 */
export function pickLatestGenerations(
  list: RawModel[],
  generations: number = 2,
): { id: string; name: string }[] {
  if (!Array.isArray(list) || list.length === 0) return [];

  const scored: Scored[] = [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string') continue;
    if (DATE_RE.test(m.id))    continue;
    if (PREVIEW_RE.test(m.id)) continue;
    if (FREE_RE.test(m.id))    continue;
    const version = extractVersion(m.id);
    const isAlias = /-latest$/.test(m.id) || / \(latest\)$/i.test(m.name || '');
    scored.push({
      model: { id: m.id, name: m.name || m.id },
      genKey: generationKey(version),
      version,
      isAlias,
    });
  }

  // Collapse "foo" vs "foo-latest" at the same version → keep the shorter id.
  const deduped = new Map<string, Scored>();
  for (const s of scored) {
    const key = s.model.id.replace(/-latest$/, '');
    const prev = deduped.get(key);
    if (!prev) { deduped.set(key, s); continue; }
    if (cmpVersion(s.version, prev.version) > 0) { deduped.set(key, s); continue; }
    if (cmpVersion(s.version, prev.version) === 0 && prev.isAlias && !s.isAlias) {
      deduped.set(key, s);
    }
  }
  const uniq = [...deduped.values()];

  // Unique generation keys, sorted newest first.
  const genKeys = [...new Set(uniq.map((s) => s.genKey))]
    .filter((k) => k !== '')
    .sort((a, b) => cmpGenKey(b, a));

  const keepKeys = new Set(genKeys.slice(0, generations));
  const picked = uniq.filter((s) => keepKeys.has(s.genKey));

  picked.sort((a, b) => {
    const g = cmpGenKey(b.genKey, a.genKey);
    if (g !== 0) return g;
    const v = cmpVersion(b.version, a.version);
    if (v !== 0) return v;
    return a.model.id.localeCompare(b.model.id);
  });

  return picked.map((s) => ({ id: s.model.id, name: cleanName(s.model.name || s.model.id) }));
}

/** Strip "(latest)" / "(YYYY-MM-DD)" noise from names for display. */
function cleanName(raw: string): string {
  return String(raw || '')
    .replace(/\s*\(latest\)$/i, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')
    .trim();
}
