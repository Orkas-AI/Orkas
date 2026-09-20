/**
 * Model-native web search tool dispatch.
 *
 * pi-ai's provider.stream() calls `options.onPayload?(params, model)` after
 * `buildParams`, allowing the callback to return new params that overwrite
 * the originals. We use this hook to replace the function-style `web_search`
 * with the vendor's server-side search schema. The model therefore sees one
 * search route, never two competing routes.
 *
 * Dispatch checks the actual request model and API passed to onPayload.
 * This module owns native-search capability facts and vendor schemas.
 */

/**
 * Returns the model-native web search tool schema for this pi-ai api;
 * returns undefined when unsupported.
 * The schema replaces the function-style search entry in `params.tools`;
 * pi-ai does not touch it again (it only transforms `type: "function"`
 * entries).
 */
export function nativeSearchToolForApi(api: string | undefined): Record<string, unknown> | undefined {
  switch (api) {
    // OpenAI Responses family (direct / Azure / ChatGPT Codex OAuth) all
    //   use the **GA** `web_search` tool, no longer the older
    //   `web_search_preview` variant.
    //   - Codex backend (verified 2026-04-23) only accepts GA; preview
    //     errors with
    //     `{"detail":"Unsupported tool type: web_search_preview"}`.
    //   - Direct accounts accept both preview and GA, but GA is the
    //     official release with stable schema + SLA — no reason to keep
    //     using preview.
    //   - Azure hasn't been independently tested; default to GA by API
    //     consistency. If an early Azure backend version rejects GA,
    //     branch back here.
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { type: 'web_search' };

    // Anthropic Messages protocol — **deliberately unsupported**.
    //   The `web_search_20250305` server tool is a real entry in the
    //   official docs, but in the Orkas catalog the `anthropic` provider
    //   is mostly accessed via OAuth (Claude Pro/Max subscription or
    //   Claude Code login, token shaped like `sk-ant-oat...`), and pi-ai
    //   wraps OAuth with the `claude-code-20250219` +
    //   `oauth-2025-04-20` beta header — the backend gates capability by
    //   header, the same mechanism that makes ChatGPT Codex OAuth reject
    //   `web_search_preview`. The OAuth path is very likely to reject
    //   server tools; injecting one would error out the whole
    //   conversation.
    //   Following the "above all, don't break the live conversation"
    //   rule we omit the entry. If a user explicitly uses a direct API
    //   key and wants native search, we can later add an
    //   `if isOAuth ? skip : inject` branch.
    //
    // case 'anthropic-messages':
    //   return { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

    // Google SDK uses camelCase; the host supplies the tool-combination config.
    case 'google-generative-ai':
      return { googleSearch: {} };
    // The installed Google SDK rejects tool-context circulation on Vertex.
    // Keep the executable function route rather than send an invalid mixture.
    case 'google-vertex':
      return undefined;

    default:
      return undefined;
  }
}

// Capability facts, not model routing or a list of selectable models. Unknown
// IDs keep the executable Orkas search route; API compatibility is insufficient.
// Sources (checked 2026-09-12): OpenAI model pages and tools-web-search guide;
// https://ai.google.dev/gemini-api/docs/generate-content/google-search
const OPENAI_SEARCH_MODELS = new Set([
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini',
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3-codex',
  'gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra',
]);
// Tool combinations are supported only by documented Gemini 3 models.
// https://ai.google.dev/gemini-api/docs/generate-content/tool-combination
const GOOGLE_SEARCH_MODELS = new Set([
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
]);

/** Check the actual request candidate, including request-level restrictions. */
export function nativeSearchToolForModel(
  model: { api?: string; id?: string; provider?: string },
  payload: { reasoning?: { effort?: unknown } },
): Record<string, unknown> | undefined {
  if (!model.id || !model.provider || providerApi(model.provider) !== model.api) return undefined;
  const tool = nativeSearchToolForApi(model.api);
  if (!tool) return undefined;
  // Official dated snapshots retain the named model's capability. Deployment
  // aliases and unreviewed variants must not inherit it from a similar name.
  const id = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (tool.type === 'web_search') {
    if (!OPENAI_SEARCH_MODELS.has(id)) return undefined;
    if (['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(id) && payload.reasoning?.effort === 'minimal') return undefined;
  } else if (!GOOGLE_SEARCH_MODELS.has(id)) return undefined;
  return tool;
}

/**
 * Provider-only schema lookup retained for compatibility. This does not
 * establish model support or activation; runtime uses nativeSearchToolForModel.
 * The mapping is provider → its most common api convention; a small
 * number of providers may differ (e.g. Azure OpenAI uses responses), but
 * those are not in the current catalog. Providers outside the catalog are
 * not enumerated here — we return undefined and let onPayload make the
 * final call.
 */
export function nativeSearchToolForProvider(providerId: string): Record<string, unknown> | undefined {
  const api = providerApi(providerId);
  return api ? nativeSearchToolForApi(api) : undefined;
}

/** Conservative providerId → api mapping. Unlisted = unknown = no inject.
 *  `anthropic` has an api mapping, but
 *  `nativeSearchToolForApi('anthropic-messages')` currently returns
 *  undefined (see the note above) — effectively no-op. */
function providerApi(providerId: string): string | undefined {
  switch (providerId) {
    case 'openai':                   return 'openai-responses';
    case 'openai-codex':             return 'openai-codex-responses';
    case 'azure-openai-responses':   return 'azure-openai-responses';
    case 'anthropic':                return 'anthropic-messages';
    case 'google':                   return 'google-generative-ai';
    case 'google-vertex':            return 'google-vertex';
    default:                         return undefined;
  }
}

/** Human-readable label (used by logs / archive event displays). */
export function nativeSearchToolName(tool: Record<string, unknown> | undefined): string | undefined {
  if (!tool) return undefined;
  const t = tool['type'];
  if (typeof t === 'string') return t;
  if ('googleSearch' in tool) return 'google_search';
  return undefined;
}

export type SearchPayloadRoute = 'absent' | 'orkas' | 'native';

export type SearchPayloadRouteResult = {
  tools: unknown[] | undefined;
  input?: unknown[];
  route: SearchPayloadRoute;
  replacedOrkasSearch: boolean;
};

function isOrkasWebSearchTool(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as {
    type?: unknown;
    name?: unknown;
    function?: { name?: unknown };
    functionDeclarations?: Array<{ name?: unknown }>;
  };
  return value.name === 'web_search'
    || value.function?.name === 'web_search'
    || value.functionDeclarations?.some((item) => item?.name === 'web_search') === true;
}

function removeOrkasWebSearchTool(candidate: unknown): unknown | undefined {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const value = candidate as {
    name?: unknown;
    function?: { name?: unknown };
    functionDeclarations?: Array<{ name?: unknown }>;
  };
  if (value.name === 'web_search' || value.function?.name === 'web_search') {
    return undefined;
  }
  if (!Array.isArray(value.functionDeclarations)) return candidate;
  const remaining = value.functionDeclarations.filter((item) => item?.name !== 'web_search');
  if (remaining.length === value.functionDeclarations.length) return candidate;
  if (remaining.length === 0) return undefined;
  return { ...value, functionDeclarations: remaining };
}

function sameNativeTool(candidate: unknown, nativeTool: Record<string, unknown>): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  if ('googleSearch' in nativeTool) return 'googleSearch' in candidate;
  return nativeTool.type === 'web_search'
    && (candidate as { type?: unknown }).type === 'web_search';
}

function deferredToolReceipt(candidate: unknown): { tools: unknown[] } | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined;
  const value = candidate as Record<string, unknown>;
  if (!Array.isArray(value.tools)) return undefined;
  if ((value.type === 'tool_search_output' && value.execution === 'client' && value.status === 'completed')
    || (value.type === 'additional_tools' && value.role === 'developer')) {
    return value as { tools: unknown[] };
  }
  return undefined;
}

/**
 * Select exactly one search route for a provider payload.
 *
 * The Orkas function remains the compatibility path for paid search profiles,
 * disabled native search, and unsupported APIs. Native search is allowed only
 * when the scoped surface already activated `web_search`; it replaces that
 * function instead of being appended beside it.
 */
export function routeSearchPayloadTools(input: {
  tools: unknown[] | undefined;
  input?: unknown[];
  nativeEnabled: boolean;
  paidSearchConfigured: boolean;
  nativeTool: Record<string, unknown> | undefined;
}): SearchPayloadRouteResult {
  const { tools, nativeEnabled, paidSearchConfigured, nativeTool } = input;
  const history = input.input;
  const unchanged = { tools, ...(history !== undefined ? { input: history } : {}) };
  const hasOrkasSearch = tools?.some(isOrkasWebSearchTool)
    || history?.some(item => deferredToolReceipt(item)?.tools.some(isOrkasWebSearchTool));
  if (!hasOrkasSearch) {
    return { ...unchanged, route: 'absent', replacedOrkasSearch: false };
  }
  if (!nativeEnabled || paidSearchConfigured || !nativeTool) {
    return { ...unchanged, route: 'orkas', replacedOrkasSearch: false };
  }

  const withoutSearchDuplicates = (tools ?? []).flatMap((candidate) => {
    if (sameNativeTool(candidate, nativeTool)) return [];
    const stripped = removeOrkasWebSearchTool(candidate);
    return stripped === undefined ? [] : [stripped];
  });
  return {
    tools: [...withoutSearchDuplicates, nativeTool],
    ...(history !== undefined ? { input: history.map(item => {
      const receipt = deferredToolReceipt(item);
      if (!receipt || !receipt.tools.some(isOrkasWebSearchTool)) return item;
      // Keep the receipt/call pair, insertion position, and unrelated tools.
      // Never mutate persisted history: retries and other models rebuild from it.
      return { ...receipt, tools: receipt.tools.flatMap(candidate => {
        const stripped = removeOrkasWebSearchTool(candidate);
        return stripped === undefined ? [] : [stripped];
      }) };
    }) } : {}),
    route: 'native',
    replacedOrkasSearch: true,
  };
}
