/**
 * web_search — HTML scraping search with request-driven provider fallback.
 *
 * Six providers, all keyless:
 *   1. Brave Search (search.brave.com)   — preferred everywhere except
 *      networks where the domain is blocked.
 *   2. DuckDuckGo HTML                    — fallback when Brave is rate limited.
 *   3. 360 Search                         — Chinese direct-URL fallback.
 *   4. Yahoo Search                       — additional full-result fallback.
 *   5. Sogou Search                       — Chinese full-result fallback.
 *   6. Bing RSS                           — structured last-resort fallback.
 *
 * Provider selection is cached at `<state_dir>/web-search-cache.json`.
 * A call tries the preferred provider and, on a network error, HTTP failure
 * (including 429), or an empty/unparseable result page, tries the remaining
 * providers in order. This avoids separate HEAD probes and keeps provider
 * recovery inside one tool call instead of asking the model to retry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type AgentTool, type ToolResult } from "./base.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("web-search");

const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const PROVIDER_FAILURE_COOLDOWN_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function acceptLanguage(): string {
  return process.env.ORKAS_ACCEPT_LANGUAGE || "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7";
}

export type SearchProvider =
  | "brave"
  | "duckduckgo"
  | "so"
  | "sogou"
  | "yahoo"
  | "bing";

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

// ─── HTML helpers ─────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")    // en space (U+2002) — collapsed to ASCII space
    .replace(/&emsp;/g, " ")    // em space (U+2003)
    .replace(/&thinsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/\\u0027/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Brave Search HTML: results live in `<div class="snippet ... svelte-jmfu5f"
 * data-type="web">` blocks. Svelte compiles class hashes (`svelte-jmfu5f`,
 * `svelte-14r20fy`), so this parser is inherently fragile — when Brave
 * rebuilds the frontend the hashes shift and results come back empty.
 */
export function parseBraveHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<div\b(?=[^>]*\bdata-type=["']web["'])(?=[^>]*\bclass=["'][^"']*\bsnippet\b[^"']*["'])[^>]*>([\s\S]*?)(?=<div\b(?=[^>]*\bdata-type=["']web["'])|<footer\b|$)/gi;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const content = block[1];
    const linkMatch = content.match(
      /<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1]);

    const titleMatch = content.match(
      /class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|h\d)>/i,
    );
    const title = decodeEntities(stripTags(titleMatch?.[1] || linkMatch[2]));

    const descMatch = content.match(
      /class=["'][^"']*\bsnippet-description\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p)>/i,
    );
    const snippet = descMatch ? decodeEntities(stripTags(descMatch[1])) : "";

    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Bing HTML: each organic result is a `<li class="b_algo">` with
 *   <h2><a href="URL">TITLE</a></h2>
 *   <div class="b_caption"><p>SNIPPET</p></div>
 * The class names have been stable across www.bing.com and cn.bing.com
 * for many years. cn.bing.com occasionally wraps click-URLs in a tracking
 * redirect — we skip non-http(s) hrefs so the LLM never sees those.
 */
export function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<li\b(?=[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'])[^>]*>([\s\S]*?)<\/li>/gi;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const content = block[1];

    const h2Match = content.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2Match) continue;
    const linkMatch = h2Match[1].match(
      /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;

    const url = decodeEntities(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(linkMatch[2]));

    let snippet = "";
    const captionMatch = content.match(
      /class=["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
    );
    if (captionMatch) snippet = decodeEntities(stripTags(captionMatch[1]));

    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

// ─── Provider registry ────────────────────────────────────────────────────

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeEntities(rawUrl);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const parsed = new URL(absolute);
    if (
      /(^|\.)duckduckgo\.com$/i.test(parsed.hostname)
      && parsed.pathname.startsWith("/l/")
    ) {
      const target = parsed.searchParams.get("uddg");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch {
    /* Return the decoded URL below; the caller will validate its scheme. */
  }
  return absolute;
}

/** Parse the semantic result classes from DuckDuckGo's keyless HTML page. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern =
    /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])([^>]*)>([\s\S]*?)<\/a>/gi;

  let link: RegExpExecArray | null;
  while ((link = linkPattern.exec(html)) !== null) {
    const hrefMatch = link[1].match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const url = unwrapDuckDuckGoUrl(hrefMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;

    const title = decodeEntities(stripTags(link[2]));
    const tail = html.slice(linkPattern.lastIndex);
    const nextResult = tail.search(
      /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])/i,
    );
    const resultBody = tail.slice(0, nextResult >= 0 ? nextResult : 5_000);
    const snippetMatch = resultBody.match(
      /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1]))
      : "";

    if (title) results.push({ title, url, snippet });
  }
  return results;
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1");
}

/** Parse Bing's structured RSS mode, which exposes direct source URLs. */
export function parseBingRss(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let item: RegExpExecArray | null;
  while ((item = itemPattern.exec(xml)) !== null) {
    const titleMatch = item[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = item[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    if (!titleMatch || !linkMatch) continue;
    const title = decodeEntities(stripTags(stripCdata(titleMatch[1])));
    const url = decodeEntities(stripCdata(linkMatch[1]).trim());
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const descriptionMatch = item[1].match(
      /<description\b[^>]*>([\s\S]*?)<\/description>/i,
    );
    const snippet = descriptionMatch
      ? decodeEntities(stripTags(stripCdata(descriptionMatch[1])))
      : "";
    results.push({ title, url, snippet });
  }
  return results;
}

function unwrapYahooUrl(rawUrl: string): string {
  const decoded = decodeEntities(rawUrl);
  try {
    const parsed = new URL(decoded);
    if (/(^|\.)search\.yahoo\.com$/i.test(parsed.hostname)) {
      const targetMatch = decoded.match(/\/RU=([^/]+)\/RK=/i);
      if (targetMatch) {
        const target = decodeURIComponent(targetMatch[1]);
        if (/^https?:\/\//i.test(target)) return target;
      }
    }
  } catch {
    /* Return the decoded URL below; the caller will validate its scheme. */
  }
  return decoded;
}

/** Parse Yahoo's semantic organic-result blocks and unwrap their source URL. */
export function parseYahooHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<div\b(?=[^>]*\bclass=["'][^"']*\balgo-sr\b[^"']*["'])[^>]*>([\s\S]*?)(?=<div\b(?=[^>]*\bclass=["'][^"']*\balgo-sr\b[^"']*["'])|<div\b(?=[^>]*\bclass=["'][^"']*\bcompPagination\b[^"']*["'])|$)/gi;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const linkMatch = block[1].match(
      /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/i,
    );
    if (!linkMatch) continue;
    const url = unwrapYahooUrl(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(linkMatch[2]));
    const snippetMatch = block[1].match(
      /<div\b(?=[^>]*\bclass=["'][^"']*\bcompText\b[^"']*["'])[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1]))
      : "";
    if (title) results.push({ title, url, snippet });
  }
  return results;
}

function decodeUrlComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isLikelyErrorPageUrl(rawUrl: string): boolean {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    return /\/(?:404|error|not-found|notfound)(?:[./_-]|$)/i.test(path);
  } catch {
    return true;
  }
}

/** Parse Sogou result cards. The hidden result metadata exposes the direct
 * source URL and title even when the visible anchor uses `/link?...`. */
export function parseSogouHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<div\b(?=[^>]*\bclass=["'][^"']*\bvrwrap\b[^"']*["'])[^>]*>([\s\S]*?)(?=<div\b(?=[^>]*\bclass=["'][^"']*\bvrwrap\b[^"']*["'])|<div\b[^>]*\bid=["']pagebar_container["']|$)/gi;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const directMatch = block[1].match(/\bdata-url=["'](https?:\/\/[^"']+)["']/i);
    if (!directMatch) continue;
    const url = decodeEntities(directMatch[1]);
    const encodedTitle = block[1].match(/\bdata-title=["']([^"']+)["']/i)?.[1];
    const heading = block[1].match(
      /<h3\b(?=[^>]*\bclass=["'][^"']*\bvr-title\b[^"']*["'])[^>]*>([\s\S]*?)<\/h3>/i,
    )?.[1];
    const title = encodedTitle
      ? decodeEntities(stripTags(decodeUrlComponent(encodedTitle)))
      : decodeEntities(stripTags(heading || ""));
    const snippetMatch = block[1].match(
      /<p\b(?=[^>]*\bclass=["'][^"']*\bstar-wiki\b[^"']*["'])[^>]*>([\s\S]*?)<\/p>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1]))
      : "";
    if (title && /^https?:\/\//i.test(url)) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

/** Parse 360 Search organic results. `data-mdurl` is the direct source URL,
 * unlike the visible `/link?...` tracking URL. */
export function parseSoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<li\b(?=[^>]*\bclass=["'][^"']*\bres-list\b[^"']*["'])[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const linkMatch = block[1].match(
      /<h3\b[^>]*>[\s\S]*?<a\b[^>]*\bdata-mdurl=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i,
    );
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1]);
    const title = decodeEntities(stripTags(linkMatch[2]));
    const snippetMatch = block[1].match(
      /<p\b(?=[^>]*\bclass=["'][^"']*\bres-desc\b[^"']*["'])[^>]*>([\s\S]*?)<\/p>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1]))
      : "";
    if (title && !isLikelyErrorPageUrl(url)) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

type ProviderConfig = {
  id: SearchProvider;
  label: string;
  probeUrl: string;
  buildSearchUrl: (query: string) => string;
  parse: (html: string) => SearchResult[];
};

const PROVIDERS: Record<SearchProvider, ProviderConfig> = {
  brave: {
    id: "brave",
    label: "Brave",
    probeUrl: "https://search.brave.com/",
    buildSearchUrl: (q) =>
      `https://search.brave.com/search?${new URLSearchParams({ q }).toString()}`,
    parse: parseBraveHtml,
  },
  duckduckgo: {
    id: "duckduckgo",
    label: "DuckDuckGo",
    probeUrl: "https://html.duckduckgo.com/",
    buildSearchUrl: (q) =>
      `https://html.duckduckgo.com/html/?${new URLSearchParams({ q }).toString()}`,
    parse: parseDuckDuckGoHtml,
  },
  so: {
    id: "so",
    label: "360 Search",
    probeUrl: "https://www.so.com/",
    buildSearchUrl: (q) =>
      `https://www.so.com/s?${new URLSearchParams({ q }).toString()}`,
    parse: parseSoHtml,
  },
  sogou: {
    id: "sogou",
    label: "Sogou",
    probeUrl: "https://www.sogou.com/",
    buildSearchUrl: (q) =>
      `https://www.sogou.com/web?${new URLSearchParams({
        query: q,
        num: "10",
      }).toString()}`,
    parse: parseSogouHtml,
  },
  yahoo: {
    id: "yahoo",
    label: "Yahoo",
    probeUrl: "https://search.yahoo.com/",
    buildSearchUrl: (q) =>
      `https://search.yahoo.com/search?${new URLSearchParams({
        p: q,
        n: "10",
      }).toString()}`,
    parse: parseYahooHtml,
  },
  bing: {
    id: "bing",
    label: "Bing",
    probeUrl: "https://www.bing.com/",
    buildSearchUrl: (q) =>
      `https://www.bing.com/search?${new URLSearchParams({
        q,
        setlang: "zh-CN",
        mkt: "zh-CN",
        format: "rss",
      }).toString()}`,
    parse: (body) => {
      const rssResults = parseBingRss(body);
      return rssResults.length > 0 ? rssResults : parseBingHtml(body);
    },
  },
};

/** Probe order also defines the default preference when no cache exists. */
const PROVIDER_ORDER: SearchProvider[] = [
  "brave",
  "duckduckgo",
  "yahoo",
  "sogou",
  "so",
  "bing",
];

function providerOrderForQuery(query: string): SearchProvider[] {
  return /[\u3400-\u9fff]/u.test(query)
    ? ["so", "yahoo", "brave", "duckduckgo", "sogou", "bing"]
    : PROVIDER_ORDER;
}

// ─── Provider selection (pure) ────────────────────────────────────────────

/**
 * Pick the preferred provider given a probe map.
 *
 *   - Stick with `previous` if it's still reachable (sticky preference
 *     avoids flapping when both are up).
 *   - Else pick the first reachable provider in PROVIDER_ORDER.
 *   - Return null if nothing is reachable (caller treats as network error).
 */
export function chooseProvider(
  probes: Record<SearchProvider, boolean>,
  previous?: SearchProvider,
): SearchProvider | null {
  if (previous && probes[previous]) return previous;
  for (const id of PROVIDER_ORDER) {
    if (probes[id]) return id;
  }
  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────────

type CacheState = {
  preferred: SearchProvider;
  probedAt: string;
  reason?: string;
};

function resolveCacheFile(): string {
  // Embedders (e.g. Orkas) can pin this to their workspace.
  // CORE_AGENT_STATE_DIR is the preferred new env; fall back to the
  // existing CORE_AGENT_AUTH_DIR for zero-config compat — core-agent
  // already writes there and its parent is the only workspace the
  // embedder has wired up.
  const override = process.env.CORE_AGENT_STATE_DIR || process.env.CORE_AGENT_AUTH_DIR;
  const dir = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(os.homedir(), ".core-agent");
  return path.join(dir, "web-search-cache.json");
}

function loadCache(): CacheState | null {
  try {
    const raw = fs.readFileSync(resolveCacheFile(), "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (
      data.preferred === "brave"
      || data.preferred === "duckduckgo"
      || data.preferred === "so"
      || data.preferred === "sogou"
      || data.preferred === "yahoo"
      || data.preferred === "bing"
    ) {
      return {
        preferred: data.preferred,
        probedAt: String(data.probedAt || ""),
        reason: typeof data.reason === "string" ? data.reason : undefined,
      };
    }
  } catch {
    /* missing / malformed → treat as no cache */
  }
  return null;
}

function saveCache(state: CacheState): void {
  try {
    const file = resolveCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    log.warn("cache write failed:", (err as Error).message);
  }
}

// ─── Search execution ─────────────────────────────────────────────────────

type ProviderRunSuccess = { ok: true; results: SearchResult[] };
type ProviderRunFailure = { ok: false; reason: "unreachable" | "http"; detail: string };
type ProviderRunResult = ProviderRunSuccess | ProviderRunFailure;

type SearchRuntimeState = {
  tail: Promise<void>;
  cooldownUntil: Record<SearchProvider, number>;
};

const runtimeStateByCacheFile = new Map<string, SearchRuntimeState>();

function searchRuntimeState(): SearchRuntimeState {
  const key = resolveCacheFile();
  let state = runtimeStateByCacheFile.get(key);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      cooldownUntil: {
        brave: 0,
        duckduckgo: 0,
        so: 0,
        sogou: 0,
        yahoo: 0,
        bing: 0,
      },
    };
    runtimeStateByCacheFile.set(key, state);
  }
  return state;
}

function enqueueSearch<T>(state: SearchRuntimeState, task: () => Promise<T>): Promise<T> {
  const run = state.tail.then(task, task);
  state.tail = run.then(() => undefined, () => undefined);
  return run;
}

function providerFailureDetail(result: ProviderRunResult): string {
  return result.ok
    ? "no parseable search results"
    : (result as ProviderRunFailure).detail;
}

function markProviderFailure(
  state: SearchRuntimeState,
  provider: SearchProvider,
): void {
  state.cooldownUntil[provider] = Date.now() + PROVIDER_FAILURE_COOLDOWN_MS;
}

async function runProviderSearch(
  config: ProviderConfig,
  query: string,
): Promise<ProviderRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const maxAttempts = config.id === "yahoo" ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const resp = await fetch(config.buildSearchUrl(query), {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": acceptLanguage(),
        },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!resp.ok) {
        if (config.id === "yahoo" && resp.status === 500 && attempt === 0) {
          continue;
        }
        return {
          ok: false,
          reason: "http",
          detail: `HTTP ${resp.status} ${resp.statusText}`,
        };
      }
      const html = await resp.text();
      return { ok: true, results: config.parse(html) };
    }
    return {
      ok: false,
      reason: "http",
      detail: "HTTP 500 after retry",
    };
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatResults(
  query: string,
  results: SearchResult[],
  provider: SearchProvider,
  count: number,
): string {
  const trimmed = results.slice(0, count);
  if (trimmed.length === 0) {
    return `No search results found for: "${query}" (via ${PROVIDERS[provider].label})`;
  }
  const lines = [`Search results for: "${query}" (via ${PROVIDERS[provider].label})\n`];
  for (let i = 0; i < trimmed.length; i++) {
    const r = trimmed[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }
  lines.push("Use the web_fetch tool to read the full content of any result URL.");
  return lines.join("\n");
}

export const WEB_SEARCH_DEFAULT_COUNT = DEFAULT_COUNT;
export const WEB_SEARCH_MAX_COUNT = MAX_COUNT;

/** Public web_search execution — exposes the keyless multi-provider pipeline so
 *  embedders (e.g. Orkas's overriding `web_search` tool) can fall back to
 *  it when the user hasn't configured a paid search API. Returns the same
 *  `ToolResult` shape as the AgentTool execute callback, including the
 *  host-only display name of the provider that actually answered. */
export async function runBuiltinWebSearch(
  query: string,
  count: number = DEFAULT_COUNT,
): Promise<ToolResult> {
  const q = (query || "").trim();
  const n = Math.min(count, MAX_COUNT);
  if (!q) return { content: "Error: query is required", isError: true };
  return runWebSearchInternal(q, n);
}

export const webSearchTool: AgentTool = defineTool({
  name: "web_search",
  executionMode: "parallel",
  description:
    "Search the web for information. Returns a list of search results with titles, URLs, and snippets. " +
    "Use this when you need to find current information, news, documentation, or any web content. " +
    "After searching, use web_fetch to read the full content of relevant result URLs.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      count: {
        type: "number",
        description: `Number of results to return (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT}).`,
      },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = ((input.query as string) || "").trim();
    const count = Math.min(
      (input.count as number | undefined) ?? DEFAULT_COUNT,
      MAX_COUNT,
    );
    if (!query) return { content: "Error: query is required", isError: true };
    return runWebSearchInternal(query, count);
  },
});

async function runWebSearchInternal(
  query: string,
  count: number,
): Promise<ToolResult> {
  const state = searchRuntimeState();
  return enqueueSearch(state, () => runSerializedWebSearch(state, query, count));
}

async function runSerializedWebSearch(
  state: SearchRuntimeState,
  query: string,
  count: number,
): Promise<ToolResult> {
  const cached = loadCache();
  const queryOrder = providerOrderForQuery(query);
  const cachedPreferred = cached?.preferred ?? queryOrder[0];
  const now = Date.now();
  const available = [
    cachedPreferred,
    ...queryOrder.filter((provider) => provider !== cachedPreferred),
  ].filter((provider) => state.cooldownUntil[provider] <= now);
  const order = available.length
    ? available
    : [cachedPreferred, ...queryOrder.filter((provider) => provider !== cachedPreferred)];
  const failures: Array<{ provider: SearchProvider; detail: string }> = [];
  for (const provider of order) {
    const result = await runProviderSearch(PROVIDERS[provider], query);
    if (result.ok && result.results.length > 0) {
      state.cooldownUntil[provider] = 0;
      if (!cached || cached.preferred !== provider) {
        const fallbackFrom = failures[0];
        saveCache({
          preferred: provider,
          probedAt: new Date().toISOString(),
          reason: fallbackFrom
            ? `fallback from ${fallbackFrom.provider}: ${fallbackFrom.detail}`
            : "successful direct request",
        });
      }
      return {
        content: formatResults(query, result.results, provider, count),
        displayName: PROVIDERS[provider].label,
      };
    }

    const detail = providerFailureDetail(result);
    failures.push({ provider, detail });
    markProviderFailure(state, provider);
    const next = order[failures.length];
    if (next) {
      log.warn(
        `provider request failed: ${provider} (${detail}); trying ${next}`,
      );
    }
  }

  return {
    content:
      "Search failed on all providers. "
      + failures
        .map(({ provider, detail }) => `${PROVIDERS[provider].label}: ${detail}`)
        .join("; "),
    isError: true,
  };
}
