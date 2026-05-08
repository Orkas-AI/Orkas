/**
 * Provider + model catalog — the single place to curate what the settings
 * page offers.
 *
 * ## Layout
 *
 *   CATALOG          — ordered list of visible providers (one entry per
 *                      provider card). This is the source of truth; every
 *                      other export is derived from it.
 *   CURATED_MODELS   — per-provider model whitelist shown in the model
 *                      dropdown. Edit here to add or remove models.
 *   EXTRA_LABELS     — friendly labels for providers that aren't in
 *                      CATALOG but may show up via legacy saved profiles.
 *
 * ## Fallbacks
 *
 * When a CATALOG provider has no `CURATED_MODELS` entry, `listModels()`
 * falls back to `pickLatestGenerations()` over pi-ai's raw model list,
 * which keeps the last 2 (major, minor) version bands.
 *
 * ## OAuth
 *
 * OAuth capability is detected at runtime via pi-ai's `getOAuthProviders()`
 * — we don't maintain a parallel list here. `oauthOnly: true` on a catalog
 * entry tells the UI not to offer the API-key path (e.g. OpenAI Codex, the
 * Google CLI/Antigravity backends).
 */

// ── Catalog entry shape ─────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;                 // pi-ai provider id (matches listPiProviders())
  label: string;              // display label
  docsUrl?: string;           // where to create an API key (shown in the add-key form)
  region?: 'cn';              // 'cn' marks providers whose primary endpoint is in China
  oauthOnly?: boolean;        // if true, hide the API-key path entirely
  /** Per-provider prerequisite note shown on the card + the add-key form.
   *  Used when the same "brand" has two independent billing/auth surfaces
   *  (e.g. Moonshot 开放平台按量付费 vs. Kimi Coding Plan 月付订阅) so users
   *  can tell which one they have before wasting a key. Keep it short —
   *  one sentence max, UI shows it with a warning-style accent.
   *
   *  **Value is an i18n key** (e.g. `provider.moonshot.note_paygo`), not raw
   *  text. Renderer resolves via `t()` so the hint follows UI language. */
  subscriptionNote?: string;
  /** Mark a provider as the recommended default. UI shows a "推荐 / Recommended"
   *  suffix on the picker label. Purely cosmetic — does not change selection
   *  defaults or routing. */
  recommended?: boolean;
}

// ── Ordered catalog (dropdown order = array order) ──────────────────────
//
// Group 0: recommended default (DeepSeek 直连 — 国内速度 + 价格优势)
// Group 1: global frontier labs (Anthropic, OpenAI, Google)
// Group 2: China mainstream (Zhipu GLM, Moonshot Kimi, MiniMax)
// Group 3: aggregators (OpenRouter)

export const CATALOG: readonly CatalogEntry[] = [
  // DeepSeek 直连（pi-ai 0.68.1 不带，走 external-providers.ts 的 openai-completions 适配）
  { id: 'deepseek',     label: 'DeepSeek',      docsUrl: 'https://platform.deepseek.com/api_keys', recommended: true },

  { id: 'openai-codex', label: 'OpenAI Codex',  oauthOnly: true },
  { id: 'openai',       label: 'OpenAI',        docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google',       label: 'Google Gemini', docsUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'anthropic',    label: 'Anthropic',     docsUrl: 'https://console.anthropic.com/settings/keys' },

  { id: 'zai',                label: 'Zhipu GLM',     docsUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',      region: 'cn' },
  // Moonshot 有两条独立计费的 endpoint：
  //   - `moonshot` → https://api.moonshot.cn/v1 （OpenAI 兼容，按量付费开放平台）
  //   - `kimi-coding` → https://api.kimi.com/coding （Anthropic 协议，Kimi 编程订阅月付专用）
  // 两条都绑在同一 Moonshot 账号上但鉴权/额度完全独立，一张 key 不能两边通用。
  // UI 上分成两张独立卡片，各自带 `subscriptionNote` 提示前提条件。
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

  // 豆包 / 火山方舟
  { id: 'doubao',             label: 'Doubao',  docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', region: 'cn',
    subscriptionNote: '' },

  { id: 'openrouter',         label: 'OpenRouter',    docsUrl: 'https://openrouter.ai/keys' },
];

// ── Curated model lists ─────────────────────────────────────────────────
//
// The sole source of truth for what shows up in the model dropdown.
// Order in the array = order shown to the user — put the flagship first.
// Ids must match pi-ai's `listPiModels(provider)` exactly.
//
// Providers without an entry here fall through to `pickLatestGenerations`
// which keeps the last 2 version bands from pi-ai's raw list.

export const CURATED_MODELS: Readonly<Record<string, readonly { id: string; name: string }[]>> = {
  // Anthropic 直连：id 用 dash 形式（pi-ai 0.68.1 的 provider="anthropic" 用
  // claude-<tier>-<major>-<minor>）。Opus 4.5–4.7、Sonnet 4.5/4.6、Haiku 4.5
  // 是 pi-ai 0.68.1 实际存在的 id；sonnet-4-7 / haiku-4-6/4-7 在 pi-ai 里不
  // 存在（2026-04 核对），已剔除。
  anthropic: [
    { id: 'claude-opus-4-7',   name: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ],

  // ChatGPT OAuth ("Codex subscription") whitelist — verified by probing
  // https://chatgpt.com/backend-api/codex/responses. Most codex variants
  // pi-ai lists (-codex-spark / -mini / -max / gpt-5.1 / gpt-5.2-codex)
  // are rejected by OpenAI with "not supported when using Codex with a
  // ChatGPT account". gpt-5.5 was added 2026-05-06 alongside the pi-ai
  // 0.73.0 bump — re-probe before relying on it in production; if the
  // Codex backend rejects it, drop the entry like the other 5.x variants.
  'openai-codex': [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
  ],

  // OpenAI direct. pi-ai 0.73.0 ships gpt-5.5 / 5.5-pro. The 5.3 family
  // (only -codex / -codex-spark exist, no plain chat id) was dropped on
  // 2026-05-06 — keep this list to the 5.4 + 5.5 generations only.
  openai: [
    { id: 'gpt-5.5',      name: 'GPT-5.5' },
    { id: 'gpt-5.5-pro',  name: 'GPT-5.5 Pro' },
    { id: 'gpt-5.4',      name: 'GPT-5.4' },
    { id: 'gpt-5.4-pro',  name: 'GPT-5.4 Pro' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  ],

  // Google Gemini 直连。pi-ai 0.68.1 的 provider="google" 只列出带 -preview
  // 后缀的 3.x 条目（Google 当前 3.x 仍在预览阶段），稳定版最高到 2.5。旧
  // 版 catalog 写的 `gemini-3.1-pro` / `gemini-3-pro` / `gemini-3.0-flash`
  // 是幻觉 id（pi-ai 不认），已全部改为真实 id。
  google: [
    { id: 'gemini-3.1-pro-preview',        name: 'Gemini 3.1 Pro (preview)' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (preview)' },
    { id: 'gemini-3-pro-preview',          name: 'Gemini 3 Pro (preview)' },
    { id: 'gemini-3-flash-preview',        name: 'Gemini 3 Flash (preview)' },
  ],

  // Zhipu GLM — https://bigmodel.cn
  zai: [
    { id: 'glm-5.1',        name: 'GLM-5.1' },
    { id: 'glm-5',          name: 'GLM-5' },
    { id: 'glm-5-turbo',    name: 'GLM-5 Turbo' },
    { id: 'glm-5v-turbo',   name: 'GLM-5V Turbo' },
  ],

  // Moonshot 开放平台 — https://api.moonshot.cn/v1 (OpenAI 兼容，按量付费)。
  // pi-ai 0.68.1 没注册这个 provider，我们通过 `model/core-agent/external-providers.ts`
  // 手构 `Model<"openai-completions">` 直接调 pi-ai 的低阶 API。
  // id 取自 platform.kimi.com/docs/models（2026-04 核对）。
  // 只收录当代主力 K2.5 / K2.6（id 带点）；上一代 K2 preview 系列 2026-05-25 EOL
  // 不再列出，避免新建凭证默认选到将停服的模型。
  moonshot: [
    { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
  ],

  // Kimi Coding Plan — https://api.kimi.com/coding (Anthropic 协议，月付订阅专用)
  // pi-ai 0.68.1 的 provider id 是 `kimi-coding`；新增 `k2p6` (K2.6)。
  'kimi-coding': [
    { id: 'k2p6',             name: 'Kimi K2.6' },
    { id: 'kimi-for-coding',  name: 'Kimi For Coding' },
  ],

  // MiniMax (China endpoint, API key)
  'minimax-cn': [
    { id: 'MiniMax-M2.7',           name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],

  // MiniMax Portal (OAuth subscription) — same model ids as the API-key
  // endpoint but auth'd via OAuth2 device-code (see features/oauth-minimax.ts).
  'minimax-portal': [
    { id: 'MiniMax-M2.7',           name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
  'minimax-portal-cn': [
    { id: 'MiniMax-M2.7',           name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],

  // DeepSeek V4 直连（OpenAI 兼容协议，base url https://api.deepseek.com/v1）。
  // 2026-04-24 发布；旧 id `deepseek-chat` / `deepseek-reasoner` 官方明确将
  // deprecate，分别对应 v4-flash 的非推理 / 推理模式。这里只收正式 id。
  // 来源：https://api-docs.deepseek.com/quick_start/pricing （2026-04 核对）。
  deepseek: [
    { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],

  // 豆包 Seed 2.0（火山方舟，OpenAI 兼容协议，base url https://ark.cn-beijing.volces.com/api/v3）。
  // 2026-02-15 发布。Pro = 旗舰多模态，Lite = 性价比档。Mini / Code 子档暂
  // 不收（Mini 边缘场景、Code 编程专用，常规 chat 主线列两档够了）。
  // 火山方舟也支持用户自建接入点（ep-xxxx）—— 自建 id 直接在 entry 表手填覆盖即可。
  doubao: [
    { id: 'doubao-seed-2-0-pro-260215',  name: 'Doubao Seed 2.0 Pro' },
    { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao Seed 2.0 Lite' },
  ],

  // OpenRouter aggregator. Notes against pi-ai 0.73.0 (2026-05-06):
  //   - openai/gpt-5.5 / 5.5-pro added; openai/gpt-5.3-codex dropped.
  //   - anthropic/claude-sonnet-4.7 / haiku-4.7 and google/gemini-3.1-pro
  //     (no -preview suffix) still aren't in pi-ai's generated registry —
  //     keep using the real ids below.
  //   - xiaomi/mimo-v2.5 series is now registered in pi-ai 0.73.0
  //     (previously kept ahead-of-registry against OpenRouter /v1/models).
  openrouter: [
    { id: 'anthropic/claude-opus-4.7',      name: 'Claude Opus 4.7' },
    { id: 'anthropic/claude-opus-4.6-fast', name: 'Claude Opus 4.6 Fast' },
    { id: 'anthropic/claude-sonnet-4.6',    name: 'Claude Sonnet 4.6' },
    { id: 'anthropic/claude-haiku-4.5',     name: 'Claude Haiku 4.5' },
    { id: 'openai/gpt-5.5',                 name: 'GPT-5.5' },
    { id: 'openai/gpt-5.5-pro',             name: 'GPT-5.5 Pro' },
    { id: 'openai/gpt-5.4',                 name: 'GPT-5.4' },
    { id: 'openai/gpt-5.4-pro',             name: 'GPT-5.4 Pro' },
    { id: 'google/gemini-3.1-pro-preview',  name: 'Gemini 3.1 Pro (preview)' },
    { id: 'google/gemini-3-pro-preview',    name: 'Gemini 3 Pro (preview)' },
    { id: 'deepseek/deepseek-v4-pro',       name: 'DeepSeek V4 Pro' },
    { id: 'deepseek/deepseek-v4-flash',     name: 'DeepSeek V4 Flash' },
    { id: 'moonshotai/kimi-k2.6',           name: 'Kimi K2.6' },
    { id: 'moonshotai/kimi-k2.5',           name: 'Kimi K2.5' },
    { id: 'qwen/qwen3-max',                 name: 'Qwen3 Max' },
    { id: 'qwen/qwen3-coder',               name: 'Qwen3 Coder' },
    { id: 'z-ai/glm-5.1',                   name: 'GLM-5.1' },
    { id: 'z-ai/glm-5',                     name: 'GLM-5' },
    { id: 'minimax/minimax-m2.7',           name: 'MiniMax M2.7' },
    { id: 'xiaomi/mimo-v2.5-pro',           name: 'Xiaomi MiMo V2.5 Pro' },
    { id: 'xiaomi/mimo-v2.5',               name: 'Xiaomi MiMo V2.5' },
  ],
};

export function curatedModelsFor(providerId: string): { id: string; name: string }[] {
  const list = CURATED_MODELS[providerId];
  return list ? list.map((m) => ({ id: m.id, name: m.name })) : [];
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
 * is the pi-ai-facing list; actual OAuth capability per visible provider
 * is resolved at runtime via `getOAuthProviders()` in `features/auth.ts`.
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

export function providerDocsUrl(id: string): string | undefined {
  return CATALOG.find((p) => p.id === id)?.docsUrl;
}

export function providerSubscriptionNote(id: string): string | undefined {
  return CATALOG.find((p) => p.id === id)?.subscriptionNote;
}

export function providerRecommended(id: string): boolean {
  return CATALOG.find((p) => p.id === id)?.recommended === true;
}

/**
 * Providers Orkas supports via a custom adapter in
 * `model/core-agent/external-providers.ts`, NOT via pi-ai's built-in
 * provider registry. `listProviders()` treats these as API-key-capable
 * even though `listPiProviders()` doesn't list them.
 */
export const EXTERNAL_API_PROVIDERS: readonly string[] = ['moonshot', 'deepseek', 'doubao'];

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

export interface ImageGenCapability {
  /** Fixed model id passed to the provider's image API. NOT user-overridable
   *  and NOT shown in any dropdown. */
  model: string;
  /** Which adapter in features/image_gen.ts handles the HTTP call. */
  api: 'openai' | 'gemini' | 'doubao';
  /** Whether the model accepts reference images for editing/variations. */
  supportsEdit: boolean;
}

export const IMAGE_GEN_BY_PROVIDER: Readonly<Record<string, ImageGenCapability>> = {
  // OpenAI GPT Image 2（2026-04-21 发布；HTTP 接口与 gpt-image-1 完全兼容，
  // 仍走 /v1/images/generations + /v1/images/edits）。
  openai: { model: 'gpt-image-2',                     api: 'openai', supportsEdit: true },
  // Google Nano Banana 2 = `gemini-3.1-flash-image-preview`（preview 后缀
  // 是官方 model id 的一部分，不能去掉）。Pro 版叫 Nano Banana Pro
  // (`gemini-3-pro-image-preview`)，本期先收 Flash —— 速度 + 价格更平衡。
  google: { model: 'gemini-3.1-flash-image-preview',  api: 'gemini', supportsEdit: true },
  // 火山方舟 Seedream 4.5（doubao-seedream-4-5-251128，2025-11-28 production）。
  // OpenAI-compatible images endpoint (POST /api/v3/images/generations)，
  // 文生图 / 图生图 / 多图组合都共用这一个 endpoint：body 不带 `image` 字段
  // 就是文生图，带 `image: string | string[]`（URL 或 data URI）就是图生图。
  // 旧的 seedream-3-0-t2i-250415 已下线（404）。
  doubao: { model: 'doubao-seedream-4-5-251128',      api: 'doubao', supportsEdit: true },
};

export function findImageGenCapability(providerId: string): ImageGenCapability | null {
  return IMAGE_GEN_BY_PROVIDER[providerId] || null;
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

// ── Version-based model picker (fallback for uncurated providers) ───────

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
