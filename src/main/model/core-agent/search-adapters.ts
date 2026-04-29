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

const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Tavily ──────────────────────────────────────────────────────────────

async function tavilySearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    api_key: profile.apiKey,
    query,
    max_results: clamp(count, 1, 20),
    search_depth: 'basic',
  });
  const resp = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Tavily ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
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
  const resp = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': profile.apiKey,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Serper ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
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
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': profile.apiKey,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Brave Search ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
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

// ── 百度 AI 搜索 (千帆) ─────────────────────────────────────────────────

/**
 * 百度智能云千帆 AI 搜索：
 * Endpoint: POST https://qianfan.baidubce.com/v2/ai_search
 * 鉴权：Authorization: Bearer <API Key>（千帆 API Key，控制台「API Key 管理」获取）
 * 文档：https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk
 *
 * 注：百度该接口请求体里只需要 `messages`（用户 query），返回结构是
 * `references[]`，每项 `{title, url, snippet}` —— 直接映射即可。
 */
async function baiduAiSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: query }],
    resource_type_filter: [{ type: 'web', top_k: clamp(count, 1, 20) }],
  });
  const resp = await fetchWithTimeout('https://qianfan.baidubce.com/v2/ai_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Baidu AI Search ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
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

// ── 秘塔 AI 搜索 (Metaso) ───────────────────────────────────────────────

/**
 * 秘塔 AI 搜索：
 * Endpoint: POST https://api.metaso.cn/search
 * 鉴权：Authorization: Bearer <api-key>
 * 文档/控制台：https://metaso.cn/
 *
 * 请求体核心字段（核对 2026-04）：
 *   - q (string, required)
 *   - scope: 'webpage' | 'document' | 'scholar' | 'podcast' | 'video' | 'image'
 *            默认 'webpage'
 *   - size (number, optional)
 *   - includeSummary (boolean, optional)
 *
 * 响应字段名秘塔不同环境下不完全一致（references / results / data 都能见到；
 * 单条里 title/url/snippet/content/summary 也存在简写差异），所以做多键 fallback。
 */
async function metasoSearch(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const body = JSON.stringify({
    q: query,
    scope: 'webpage',
    size: clamp(count, 1, 20),
    includeSummary: false,
  });
  const resp = await fetchWithTimeout('https://api.metaso.cn/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Metaso ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
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

export type SearchAdapter = (profile: SearchProfile, query: string, count: number) => Promise<SearchAdapterResult>;

export const searchAdaptersByProvider: Record<string, SearchAdapter> = {
  tavily:            tavilySearch,
  serper:            serperSearch,
  'brave-search':    braveApiSearch,
  'baidu-ai-search': baiduAiSearch,
  metaso:            metasoSearch,
};

/** Display labels for provider ids — used by both the settings UI and the
 *  formatted tool result so the LLM knows which API answered. */
export const SEARCH_PROVIDER_LABEL: Record<string, string> = {
  tavily:            'Tavily',
  serper:            'Serper',
  'brave-search':    'Brave',
  'baidu-ai-search': '百度',
  metaso:            '秘塔',
};

/** Documentation URL shown next to the API-key input in the settings UI. */
export const SEARCH_PROVIDER_DOCS: Record<string, string> = {
  tavily:            'https://tavily.com/',
  serper:            'https://serper.dev/',
  'brave-search':    'https://brave.com/search/api/',
  'baidu-ai-search': 'https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk',
  metaso:            'https://metaso.cn/',
};

export async function runSearchAdapter(profile: SearchProfile, query: string, count: number): Promise<SearchAdapterResult> {
  const adapter = searchAdaptersByProvider[profile.provider];
  if (!adapter) throw new Error(`no search adapter registered for provider "${profile.provider}"`);
  log.debug('runSearchAdapter', { provider: profile.provider, count });
  return adapter(profile, query, count);
}
