/**
 * Paid web-search API adapters.
 *
 * Each adapter takes a (SearchProfile, query, count) triple and returns a
 * normalised list of `{ title, url, snippet }`. All adapters use plain
 * `fetch` — no new npm dep. Failures throw; the caller in
 * `search-tools.ts` is responsible for wrapping the error into the
 * AgentTool's `{ content, isError }` shape.
 *
 * Provider list lives in `searchAdaptersByProvider` — keep it in sync with
 * the catalog rendered by `settings.js` and the validation in
 * `features/search_auth.ts::addSearchProfile`.
 */

import type { SearchProfile } from '../../features/auth';
import { createLogger } from '../../logger';
import { fetchAndReadWithTimeout } from '../../util/abort';
import {
  ORKAS_API_BASE_URL,
  ORKAS_API_KEYS_URL,
  ORKAS_API_PROVIDER,
  orkasApiUsageHeaders,
  type OrkasApiUsageContext,
} from '../../features/orkas_api';

const log = createLogger('search-adapters');

export interface NormalisedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchAdapterResult {
  provider: string;
  results: NormalisedSearchResult[];
}

/** Account-level search failure that should not be retried immediately. */
export class SearchAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchAccountError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; text: string }> {
  const { response, body } = await fetchAndReadWithTimeout(
    url,
    init,
    timeoutMs,
    null,
    `Search request timed out after ${timeoutMs}ms`,
    (resp) => resp.text(),
  );
  return { response, text: body };
}

function parseJson<T>(text: string): T {
  return (text ? JSON.parse(text) : {}) as T;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Orkas public search API ─────────────────────────────────────────────

async function orkasApiSearch(
  profile: SearchProfile,
  query: string,
  count: number,
  context?: OrkasApiUsageContext,
): Promise<SearchAdapterResult> {
  const { response: resp, text } = await fetchTextWithTimeout(`${ORKAS_API_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
      ...orkasApiUsageHeaders(context),
    },
    body: JSON.stringify({ query, max_results: clamp(count, 1, 20) }),
  });
  if (!resp.ok) {
    throw new Error(`Orkas Search ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as {
    results?: Array<{ title?: string; url?: string; snippet?: string }>;
  };
  return {
    provider: ORKAS_API_PROVIDER,
    results: (data.results || []).map((result) => ({
      title: String(result.title || ''),
      url: String(result.url || ''),
      snippet: String(result.snippet || ''),
    })).filter((result) => result.url),
  };
}

// ── Tavily ──────────────────────────────────────────────────────────────

async function tavilySearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    api_key: profile.apiKey,
    query,
    max_results: clamp(count, 1, 20),
    search_depth: 'basic',
  });
  const { response: resp, text } = await fetchTextWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Tavily ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return {
    provider: 'tavily',
    results: (data.results || []).map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.content || ''),
    })).filter((r) => r.url),
  };
}

// ── Serper ──────────────────────────────────────────────────────────────

async function serperSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({ q: query, num: clamp(count, 1, 20) });
  const { response: resp, text } = await fetchTextWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': profile.apiKey,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Serper ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return {
    provider: 'serper',
    results: (data.organic || []).map((r) => ({
      title: String(r.title || ''),
      url: String(r.link || ''),
      snippet: String(r.snippet || ''),
    })).filter((r) => r.url),
  };
}

// ── Brave Search API ────────────────────────────────────────────────────

async function braveApiSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
    q: query,
    count: String(clamp(count, 1, 20)),
  }).toString()}`;
  const { response: resp, text } = await fetchTextWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': profile.apiKey,
    },
  });
  if (!resp.ok) {
    throw new Error(`Brave Search ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return {
    provider: 'brave-search',
    results: (data.web?.results || []).map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.description || ''),
    })).filter((r) => r.url),
  };
}

// ── Baidu AI Search (Qianfan) ───────────────────────────────────────────

/**
 * Baidu Cloud Qianfan AI Search:
 * Endpoint: POST https://qianfan.baidubce.com/v2/ai_search
 * Auth: Authorization: Bearer <API Key> (Qianfan API Key, obtained from
 *       the "API Key Management" page of the console).
 * Docs: https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk
 *
 * Note: this endpoint only needs `messages` (the user query) in the
 * request body; the response shape is `references[]`, each entry
 * `{title, url, snippet}` — a direct mapping.
 */
async function baiduAiSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: query }],
    resource_type_filter: [{ type: 'web', top_k: clamp(count, 1, 20) }],
  });
  const { response: resp, text } = await fetchTextWithTimeout('https://qianfan.baidubce.com/v2/ai_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Baidu AI Search ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as {
    references?: Array<{ title?: string; url?: string; web_anchor?: string; snippet?: string; content?: string }>;
  };
  return {
    provider: 'baidu-ai-search',
    results: (data.references || []).map((r) => ({
      title: String(r.title || r.web_anchor || ''),
      url: String(r.url || ''),
      snippet: String(r.snippet || r.content || ''),
    })).filter((r) => r.url),
  };
}

// ── Metaso AI Search ────────────────────────────────────────────────────

/**
 * Metaso AI Search:
 * Endpoint: POST https://api.metaso.cn/search
 * Auth: Authorization: Bearer <api-key>
 * Docs / console: https://metaso.cn/
 *
 * Request body core fields (verified 2026-04):
 *   - q (string, required)
 *   - scope: 'webpage' | 'document' | 'scholar' | 'podcast' | 'video' | 'image'
 *            (default 'webpage')
 *   - size (number, optional)
 *   - includeSummary (boolean, optional)
 *
 * Response field names vary across Metaso environments (references /
 * results / data are all observed; per-entry title/url/snippet/content/
 * summary also have abbreviation differences), so we do multi-key
 * fallback.
 */
async function metasoSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    q: query,
    scope: 'webpage',
    size: clamp(count, 1, 20),
    includeSummary: false,
  });
  const { response: resp, text } = await fetchTextWithTimeout('https://api.metaso.cn/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Metaso ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as Record<string, unknown>;
  const list: any[] = Array.isArray((data as any).references) ? (data as any).references
                    : Array.isArray((data as any).results)    ? (data as any).results
                    : Array.isArray((data as any).data)       ? (data as any).data
                    : Array.isArray(data)                     ? (data as any)
                    : [];
  return {
    provider: 'metaso',
    results: list.map((r: any) => ({
      title:   String(r?.title || r?.name || ''),
      url:     String(r?.url || r?.link || r?.href || ''),
      snippet: String(r?.snippet || r?.summary || r?.content || r?.description || ''),
    })).filter((r) => r.url),
  };
}

// ── Registry ────────────────────────────────────────────────────────────

export type SearchAdapter = (
  profile: SearchProfile,
  query: string,
  count: number,
  context?: OrkasApiUsageContext,
) => Promise<SearchAdapterResult>;

export const searchAdaptersByProvider: Record<string, SearchAdapter> = {
  [ORKAS_API_PROVIDER]: orkasApiSearch,
  tavily:            tavilySearch,
  serper:            serperSearch,
  'brave-search':    braveApiSearch,
  'baidu-ai-search': baiduAiSearch,
  metaso:            metasoSearch,
};

/** Display labels for provider ids — used by both the settings UI and the
 *  formatted tool result so the LLM knows which API answered. */
export const SEARCH_PROVIDER_LABEL: Record<string, string> = {
  [ORKAS_API_PROVIDER]: 'Orkas · Search',
  tavily:            'Tavily',
  serper:            'Serper',
  'brave-search':    'Brave',
  'baidu-ai-search': 'Baidu',
  metaso:            'Metaso',
};

/** Documentation URL shown next to the API-key input in the settings UI. */
export const SEARCH_PROVIDER_DOCS: Record<string, string> = {
  [ORKAS_API_PROVIDER]: ORKAS_API_KEYS_URL,
  tavily:            'https://tavily.com/',
  serper:            'https://serper.dev/',
  'brave-search':    'https://brave.com/search/api/',
  'baidu-ai-search': 'https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk',
  metaso:            'https://metaso.cn/',
};

export async function runSearchAdapter(
  profile: SearchProfile,
  query: string,
  count: number,
  context?: OrkasApiUsageContext,
): Promise<SearchAdapterResult> {
  const adapter = searchAdaptersByProvider[profile.provider];
  if (!adapter) throw new Error(`no search adapter registered for provider "${profile.provider}"`);
  log.debug('runSearchAdapter', { provider: profile.provider, count });
  return adapter(profile, query, count, context);
}
