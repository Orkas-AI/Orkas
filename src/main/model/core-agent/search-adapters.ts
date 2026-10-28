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

import { randomUUID } from 'node:crypto';
import type { SearchProfile } from '../../features/auth';
import { createLogger } from '../../logger';
import { composeAbortSignal, fetchAndReadWithTimeout } from '../../util/abort';
import { getSearchQueryMaxChars, validateSearchQuery } from '../../util/search-contract';
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

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000;
class SearchBodyTooLargeError extends Error {}

async function readSearchBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SearchBodyTooLargeError('Search response is too large');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

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
    readSearchBody,
  );
  return { response, text: body };
}

function parseJson<T>(text: string): T {
  return (text ? JSON.parse(text) : {}) as T;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normaliseResults(text: string, provider: 'deepseek' | 'tavily', count: number): NormalisedSearchResult[] {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`${SEARCH_PROVIDER_LABEL[provider]} search returned an invalid response`); }
  if (!data || !Array.isArray(data.results) || data.results.length > 100) {
    throw new Error(`${SEARCH_PROVIDER_LABEL[provider]} search returned an invalid response`);
  }
  const results: NormalisedSearchResult[] = [];
  for (const item of data.results) {
    if (!item || typeof item.url !== 'string' || item.url.length > 4096) continue;
    const url = item.url.trim();
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    } catch { continue; }
    const snippet = provider === 'deepseek' ? item.summary || item.snippet || ''
      : item.content || '';
    if (typeof snippet !== 'string' || (item.title != null && typeof item.title !== 'string')) continue;
    results.push({ title: (item.title || '').slice(0, 512), url, snippet: snippet.slice(0, 10000) });
    if (results.length >= count) break;
  }
  return results;
}

/**
 * Account-level search failure (credits exhausted / auth), not "no results".
 * Keep the HTTP status so callers can distinguish a balance that payment can
 * restore from rejected credentials. Both fall back without an inline retry.
 */
export class SearchAccountError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'SearchAccountError';
  }
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
    query,
    max_results: clamp(count, 1, 20),
    search_depth: 'basic',
  });
  const { response: resp, text } = await fetchTextWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
    body,
  });
  if (!resp.ok) {
    // Never expose provider error bodies: they may echo the key or query.
    const message = `Tavily search ${resp.status}: request failed`;
    if ([401, 402, 403].includes(resp.status)) throw new SearchAccountError(message, resp.status);
    throw new Error(message);
  }
  return { provider: 'tavily', results: normaliseResults(text, 'tavily', count) };
}

// ── DeepSeek ────────────────────────────────────────────────────────────

function searchTransportReason(error: unknown): string {
  // Node/Undici preserve structured causes. Never infer a cause from prose.
  let cause: any = error;
  const known: Record<string, string> = {
    ENOTFOUND: 'dns_error', EAI_AGAIN: 'dns_error', ECONNREFUSED: 'connect_error',
    ECONNRESET: 'connection_reset', ETIMEDOUT: 'transport_timeout',
    UND_ERR_CONNECT_TIMEOUT: 'connect_timeout', UND_ERR_HEADERS_TIMEOUT: 'headers_timeout',
    UND_ERR_BODY_TIMEOUT: 'read_timeout', CERT_HAS_EXPIRED: 'tls_error',
    ERR_TLS_CERT_ALTNAME_INVALID: 'tls_error', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_error',
    SELF_SIGNED_CERT_IN_CHAIN: 'tls_error',
  };
  try {
    for (let i = 0; cause && i < 4; i++) {
      if (typeof cause.code === 'string' && Object.hasOwn(known, cause.code)) return known[cause.code];
      cause = cause.cause;
    }
  } catch { /* A nonstandard error accessor must not replace the failure. */ }
  return 'transport_error';
}

async function deepseekSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const started = performance.now();
  const searchRef = randomUUID();
  const timeoutMessage = 'Search request timed out after 60000ms';
  const composed = composeAbortSignal(null, 60_000, timeoutMessage);
  let phase = 'before_response';
  let status = 0;
  let result = 'failure';
  let reason = 'transport_error';
  try {
    const resp = await fetch('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', signal: composed.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ query, count: clamp(Math.trunc(count) || 1, 1, 20), need_content: false }),
    });
    status = resp.status;
    phase = 'after_response';
    const text = await readSearchBody(resp);
    if (!resp.ok) {
      reason = 'http_error';
      const message = `DeepSeek search ${resp.status}: request failed`;
      if ([401, 402, 403].includes(resp.status)) throw new SearchAccountError(message, resp.status);
      throw new Error(message);
    }
    phase = 'response_validation';
    reason = 'invalid_response';
    const results = normaliseResults(text, 'deepseek', count);
    result = results.length ? 'success' : 'empty';
    reason = results.length ? 'none' : 'empty_results';
    return { provider: 'deepseek', results };
  } catch (error) {
    if (composed.signal.aborted) {
      reason = 'deadline_timeout';
      throw new Error(timeoutMessage);
    }
    if (error instanceof SearchBodyTooLargeError) reason = 'response_too_large';
    else if (phase !== 'response_validation' && reason !== 'http_error') reason = searchTransportReason(error);
    throw error;
  } finally {
    composed.cleanup();
    // One constant-size local observation, including the actual header status
    // on body failures. No account/profile id, query, URL or exception text.
    try {
      const data = { provider: 'deepseek', search_ref: searchRef, result, reason, phase,
        status_code: status, duration_ms: Math.min(1_000_000, Math.max(0, Math.round(performance.now() - started))) };
      if (result === 'failure') log.warn('search provider result', data);
      else log.debug('search provider result', data);
    } catch { /* Diagnostics cannot trigger fallback or change the result. */ }
  }
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
  const data = parseJson<{
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  }>(text);
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
  const data = parseJson<{
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  }>(text);
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
  const data = parseJson<{
    references?: Array<{ title?: string; url?: string; web_anchor?: string; snippet?: string; content?: string }>;
  }>(text);
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
 * Endpoint: POST https://metaso.cn/api/v1/search
 * Auth: Authorization: Bearer <api-key>
 * Docs / console: https://metaso.cn/search-api/playground
 *
 * Request body core fields (official playground + MCP catalog):
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
  const { response: resp, text } = await fetchTextWithTimeout('https://metaso.cn/api/v1/search', {
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
  const data = parseJson<Record<string, unknown>>(text);
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

// ── Keenable ────────────────────────────────────────────────────────────

/**
 * Keenable Search API:
 * Endpoint: POST https://api.keenable.ai/v1/search/public (no key) or
 *           POST https://api.keenable.ai/v1/search (with key)
 * Auth: optional X-API-Key; the key only raises the rate limit. Every call
 *       names the calling app in X-Keenable-Title.
 * Docs: https://docs.keenable.ai/
 *
 * `snippet` holds page text (often thousands of characters with line
 * breaks), so it is flattened and capped to keep one short line per result.
 */
const KEENABLE_API_BASE_URL = 'https://api.keenable.ai/v1';
const KEENABLE_SNIPPET_MAX_CHARS = 500;

function clipKeenableSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > KEENABLE_SNIPPET_MAX_CHARS
    ? `${flat.slice(0, KEENABLE_SNIPPET_MAX_CHARS).trimEnd()}…`
    : flat;
}

async function keenableSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const apiKey = String(profile.apiKey || '').trim();
  const { response: resp, text } = await fetchTextWithTimeout(
    `${KEENABLE_API_BASE_URL}/${apiKey ? 'search' : 'search/public'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Keenable-Title': 'Orkas',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      },
      body: JSON.stringify({ query, max_results: clamp(count, 1, 20) }),
    },
  );
  if (!resp.ok) {
    throw new Error(`Keenable ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = parseJson(text) as {
    results?: Array<{ title?: string; url?: string; snippet?: string; description?: string }>;
  };
  return {
    provider: 'keenable',
    results: (data.results || []).map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: clipKeenableSnippet(String(r.snippet || r.description || '')),
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
  deepseek:          deepseekSearch,
  serper:            serperSearch,
  'brave-search':    braveApiSearch,
  'baidu-ai-search': baiduAiSearch,
  metaso:            metasoSearch,
  keenable:          keenableSearch,
};

/** Display labels for provider ids — used by both the settings UI and the
 *  formatted tool result so the LLM knows which API answered. */
export const SEARCH_PROVIDER_LABEL: Record<string, string> = {
  [ORKAS_API_PROVIDER]: 'Orkas · Search',
  tavily:            'Tavily',
  deepseek:          'DeepSeek',
  serper:            'Serper',
  'brave-search':    'Brave',
  'baidu-ai-search': 'Baidu',
  metaso:            'Metaso',
  keenable:          'Keenable',
};

/** Documentation URL shown next to the API-key input in the settings UI. */
export const SEARCH_PROVIDER_DOCS: Record<string, string> = {
  [ORKAS_API_PROVIDER]: ORKAS_API_KEYS_URL,
  tavily:            'https://tavily.com/',
  deepseek:          'https://api-docs.deepseek.com/guides/search/',
  serper:            'https://serper.dev/',
  'brave-search':    'https://brave.com/search/api/',
  'baidu-ai-search': 'https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk',
  metaso:            'https://metaso.cn/',
  keenable:          'https://docs.keenable.ai/',
};

export async function runSearchAdapter(
  profile: SearchProfile,
  query: string,
  count: number,
  context?: OrkasApiUsageContext,
): Promise<SearchAdapterResult> {
  query = query.trim();
  validateSearchQuery(query, getSearchQueryMaxChars(profile.provider));
  count = clamp(Math.trunc(count) || 1, 1, 20);
  const adapter = searchAdaptersByProvider[profile.provider];
  if (!adapter) throw new Error(`no search adapter registered for provider "${profile.provider}"`);
  log.debug('runSearchAdapter', { provider: profile.provider, count });
  return adapter(profile, query, count, context);
}
