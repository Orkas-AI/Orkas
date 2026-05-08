/**
 * Model-native web search tool dispatch.
 *
 * pi-ai's provider.stream() calls `options.onPayload?(params, model)` after
 * `buildParams`, allowing the callback to return new params that overwrite
 * the originals. We use this hook to append the vendor's server-side
 * web_search schema to `params.tools` — without modifying pi-ai source or
 * patching node_modules.
 *
 * Dispatch is keyed by pi-ai's Model.api field (the `model` argument
 * passed to onPayload by provider.stream()).
 * Single source of truth: adding new supported apis / bumping the vendor
 * tool schema version is a one-place change here.
 */

/**
 * Returns the model-native web search tool schema for this pi-ai api;
 * returns undefined when unsupported.
 * The schema is appended verbatim to `params.tools`; pi-ai does not touch
 * it again (it only transforms `type: "function"` entries).
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
