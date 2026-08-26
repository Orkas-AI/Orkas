/**
 * Model-native web search tool dispatch.
 *
 * pi-ai's provider.stream() calls `options.onPayload?(params, model)` after
 * `buildParams`, allowing the callback to return new params that overwrite
 * the originals. We use this hook to replace the function-style `web_search`
 * with the vendor's server-side search schema. The model therefore sees one
 * search route, never two competing routes.
 *
 * Dispatch is keyed by pi-ai's Model.api field (the `model` argument
 * passed to onPayload by provider.stream()).
 * Single source of truth: adding new supported apis / bumping the vendor
 * tool schema version is a one-place change here.
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

    // Google Gemini / Vertex — grounding with google search. No extra fields.
    case 'google-generative-ai':
    case 'google-vertex':
      return { google_search: {} };

    default:
      return undefined;
  }
}

/**
 * Pre-flight "will we inject?" check for callers that only have a
 * providerId (no pi-ai Model object yet); used by client.ts to push a
 * synthetic archive event before the stream starts.
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
  if ('google_search' in tool) return 'google_search';
  return undefined;
}

export type SearchPayloadRoute = 'absent' | 'orkas' | 'native';

export type SearchPayloadRouteResult = {
  tools: unknown[] | undefined;
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
  if ('google_search' in nativeTool) return 'google_search' in candidate;
  return nativeTool.type === 'web_search'
    && (candidate as { type?: unknown }).type === 'web_search';
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
  nativeEnabled: boolean;
  paidSearchConfigured: boolean;
  nativeTool: Record<string, unknown> | undefined;
}): SearchPayloadRouteResult {
  const { tools, nativeEnabled, paidSearchConfigured, nativeTool } = input;
  if (!Array.isArray(tools)) {
    return { tools, route: 'absent', replacedOrkasSearch: false };
  }
  const hasOrkasSearch = tools.some(isOrkasWebSearchTool);
  if (!hasOrkasSearch) {
    return { tools, route: 'absent', replacedOrkasSearch: false };
  }
  if (!nativeEnabled || paidSearchConfigured || !nativeTool) {
    return { tools, route: 'orkas', replacedOrkasSearch: false };
  }

  const withoutSearchDuplicates = tools.flatMap((candidate) => {
    if (sameNativeTool(candidate, nativeTool)) return [];
    const stripped = removeOrkasWebSearchTool(candidate);
    return stripped === undefined ? [] : [stripped];
  });
  return {
    tools: [...withoutSearchDuplicates, nativeTool],
    route: 'native',
    replacedOrkasSearch: true,
  };
}
