/**
 * web_search — HTML scraping search with reachability-based fallback.
 *
 * Two providers, both keyless:
 *   1. Brave Search (search.brave.com)   — preferred everywhere except
 *      networks where the domain is blocked.
 *   2. Bing China  (cn.bing.com)          — fallback for blocked networks.
 *
 * Provider selection is cached at `<state_dir>/web-search-cache.json` and
 * only re-probed when a search fails. The probe distinguishes two failure
 * modes:
 *
 *   - Neither provider is reachable → network problem. Cache is kept, a
 *     clear error is returned, we do NOT poison the cache.
 *   - Cached provider unreachable but the other one is → real provider
 *     outage for this network. Switch cache and retry once.
 *   - Cached provider reachable but search failed (HTTP 4xx/5xx, empty
 *     parse) → site is up, error is not a reachability issue — don't
 *     switch, propagate the error so the LLM can adjust query.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type AgentTool } from "./base.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("web-search");

const SEARCH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type SearchProvider = "brave" | "bing";

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
    /<div class="snippet[^"]*svelte-jmfu5f"[^>]*data-type="web"[^>]*>([\s\S]*?)(?=<div class="snippet[^"]*svelte-jmfu5f|<footer|$)/g;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const content = block[1];
    const urlMatch = content.match(/<a href="(https?:\/\/[^"]+)"[^>]*class="svelte-14r20fy/);
    if (!urlMatch) continue;
    const url = decodeEntities(urlMatch[1]);

    const titleMatch = content.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : "";

    const descMatch = content.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
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
  const blockPattern = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;

  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null) {
    const content = block[1];

    const h2Match = content.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2Match) continue;
    const linkMatch = h2Match[1].match(/<a[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const url = decodeEntities(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(linkMatch[2]));

    let snippet = "";
    const captionMatch = content.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    if (captionMatch) snippet = decodeEntities(stripTags(captionMatch[1]));

    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

// ─── Provider registry ────────────────────────────────────────────────────

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
  bing: {
    id: "bing",
    label: "Bing",
    probeUrl: "https://cn.bing.com/",
    buildSearchUrl: (q) =>
      `https://cn.bing.com/search?${new URLSearchParams({
        q,
        setlang: "zh-CN",
        mkt: "zh-CN",
      }).toString()}`,
    parse: parseBingHtml,
  },
};

/** Probe order also defines the default preference when no cache exists. */
const PROVIDER_ORDER: SearchProvider[] = ["brave", "bing"];

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
    if (data.preferred === "brave" || data.preferred === "bing") {
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

// ─── Reachability probe ───────────────────────────────────────────────────

/**
 * Did we get ANY HTTP response from the server? A 403 / 429 / 503 still
 * counts as "reachable" — the question we're answering is whether the
 * domain + TCP layer is working, not whether the site is happy with us.
 */
async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll(): Promise<Record<SearchProvider, boolean>> {
  const entries = await Promise.all(
    PROVIDER_ORDER.map(async (id) => [id, await isReachable(PROVIDERS[id].probeUrl)] as const),
  );
  return Object.fromEntries(entries) as Record<SearchProvider, boolean>;
}

// ─── Search execution ─────────────────────────────────────────────────────

type ProviderRunSuccess = { ok: true; results: SearchResult[] };
type ProviderRunFailure = { ok: false; reason: "unreachable" | "http"; detail: string };
type ProviderRunResult = ProviderRunSuccess | ProviderRunFailure;

async function runProviderSearch(
  config: ProviderConfig,
  query: string,
): Promise<ProviderRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(config.buildSearchUrl(query), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) {
      return {
        ok: false,
        reason: "http",
        detail: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const html = await resp.text();
    return { ok: true, results: config.parse(html) };
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

/** Public web_search execution — exposes the keyless Brave/Bing pipeline so
 *  embedders (e.g. Orkas's overriding `web_search` tool) can fall back to
 *  it when the user hasn't configured a paid search API. Returns the same
 *  `{ content, isError }` shape as the AgentTool execute callback. */
export async function runBuiltinWebSearch(
  query: string,
  count: number = DEFAULT_COUNT,
): Promise<{ content: string; isError?: boolean }> {
  const q = (query || "").trim();
  const n = Math.min(count, MAX_COUNT);
  if (!q) return { content: "Error: query is required", isError: true };
  return runWebSearchInternal(q, n);
}

export const webSearchTool: AgentTool = defineTool({
  name: "web_search",
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
): Promise<{ content: string; isError?: boolean }> {
  {
    // Step 1 — make sure we have a preferred provider in cache.
    let cache = loadCache();
    if (!cache) {
      const probes = await probeAll();
      const picked = chooseProvider(probes);
      if (!picked) {
        return {
          content:
            "Network unreachable: could not reach any search provider. Please check the internet connection.",
          isError: true,
        };
      }
      cache = {
        preferred: picked,
        probedAt: new Date().toISOString(),
        reason: "initial probe",
      };
      saveCache(cache);
      log.info(`initial probe selected ${picked}`);
    }

    // Step 2 — try the preferred provider.
    const first = await runProviderSearch(PROVIDERS[cache.preferred], query);
    if (first.ok) {
      const text = formatResults(query, first.results, cache.preferred, count);
      return first.results.length > 0
        ? { content: text }
        : { content: text, isError: true };
    }
    // TS narrowing gets lost across subsequent `await`s — force the failure
    // variant so `.detail` is reachable from the branches below.
    const firstErr = first as ProviderRunFailure;

    // Step 3 — re-probe to distinguish network-down vs provider-blocked.
    const probes = await probeAll();
    const other = PROVIDER_ORDER.find((p) => p !== cache!.preferred)!;

    if (!probes.brave && !probes.bing) {
      // Nothing is reachable — network outage, not a provider problem.
      // Keep cache as-is; the next call will re-probe on success path.
      return {
        content:
          `Network unreachable: both search providers failed the reachability probe.\n` +
          `Last error from ${PROVIDERS[cache.preferred].label}: ${firstErr.detail}`,
        isError: true,
      };
    }

    if (probes[cache.preferred]) {
      // Preferred site is up but search itself failed (HTTP error / parse
      // miss / rate limit). Per the switch policy this is NOT a reachability
      // issue, so don't swap cache — surface the error.
      return {
        content: `Search failed on ${PROVIDERS[cache.preferred].label}: ${firstErr.detail}`,
        isError: true,
      };
    }

    // Preferred unreachable, other reachable → switch and retry once.
    log.warn(
      `switching provider: ${cache.preferred} unreachable (${firstErr.detail}), trying ${other}`,
    );
    const retry = await runProviderSearch(PROVIDERS[other], query);
    const nextCache: CacheState = {
      preferred: other,
      probedAt: new Date().toISOString(),
      reason: `switched from ${cache.preferred}: ${firstErr.detail}`,
    };
    saveCache(nextCache);

    if (retry.ok) {
      const text = formatResults(query, retry.results, other, count);
      return retry.results.length > 0
        ? { content: text }
        : { content: text, isError: true };
    }
    const retryErr = retry as ProviderRunFailure;
    return {
      content:
        `Search failed on both providers. ` +
        `${PROVIDERS[cache.preferred].label}: ${firstErr.detail}; ` +
        `${PROVIDERS[other].label}: ${retryErr.detail}`,
      isError: true,
    };
  }
}
