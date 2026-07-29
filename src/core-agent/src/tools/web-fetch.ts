/**
 * web_fetch — HTTP GET + basic text extraction.
 *
 * Fetches a URL and returns the page content as readable text (stripped HTML).
 * No external dependencies — uses Node's built-in fetch() + regex-based
 * HTML tag stripping.
 */
import { defineTool, type AgentTool, type ToolResult } from "./base.js";
import { createLogger } from "../shared/logger.js";
import {
  compactGitHubSnapshotReplay,
  fetchGitHubRepositorySnapshot,
  identifyGitHubRepositoryResource,
} from "./github-repository-fetch.js";
import {
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  readWebFetchResponse,
  WEB_FETCH_USER_AGENT,
  webFetchAcceptLanguage,
} from "./web-fetch-http.js";

export {
  decodeBytes,
  MAX_WEB_FETCH_RESPONSE_BYTES,
  resolveCharset,
} from "./web-fetch-http.js";

const log = createLogger("web-fetch");

type WebFetchCacheEntry = {
  epoch: number;
  result: Promise<ToolResult>;
};

const fetchCacheByRunState = new WeakMap<object, Map<string, WebFetchCacheEntry>>();
const WEB_FETCH_RUN_CACHE_KEY = "webFetchCache";

function fetchCacheForState(state: Record<string, unknown>): Map<string, WebFetchCacheEntry> {
  // AgentRunner rebuilds ToolContext.state after every model round and context
  // compaction, but injects the same runScopedLedger Map by reference. Keep the
  // fetch cache there so a compacted model cannot cause the same successful URL
  // to hit the network again. The WeakMap is retained for direct/tool tests and
  // other callers that do not provide the runner ledger.
  const runScopedLedger = state.runScopedLedger;
  if (runScopedLedger instanceof Map) {
    const cached = runScopedLedger.get(WEB_FETCH_RUN_CACHE_KEY);
    if (cached instanceof Map) return cached as Map<string, WebFetchCacheEntry>;
    const created = new Map<string, WebFetchCacheEntry>();
    runScopedLedger.set(WEB_FETCH_RUN_CACHE_KEY, created);
    return created;
  }

  let fallback = fetchCacheByRunState.get(state);
  if (!fallback) {
    fallback = new Map<string, WebFetchCacheEntry>();
    fetchCacheByRunState.set(state, fallback);
  }
  return fallback;
}

function contextEpoch(state: Record<string, unknown>): number {
  const ledger = state.toolResultReadLedger;
  if (!ledger || typeof ledger !== "object") return 0;
  const epoch = Number((ledger as { epoch?: unknown }).epoch);
  return Number.isFinite(epoch) && epoch >= 0 ? Math.trunc(epoch) : 0;
}

function normalizedFetchUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function applyExplicitCharacterLimit(result: ToolResult, maxChars: number | null): ToolResult {
  if (maxChars === null || result.content.length <= maxChars) return result;
  return {
    ...result,
    content:
      result.content.slice(0, maxChars)
      + "\n...(truncated at the explicitly requested maxChars)",
  };
}

function compactCacheReplay(result: ToolResult): ToolResult {
  const reusableHeader = result.content
    .split("\n")
    .filter((line) =>
      /^(?:Title|URL|Accessed at|HTTP Last-Modified|Embedded document dates \(newest first\)):/i.test(line),
    )
    .slice(0, 5)
    .join("\n");
  return {
    content: [
      "WEB_FETCH_RUN_CACHE_HIT: this normalized URL already succeeded earlier in this run; no network request was made.",
      reusableHeader,
      "The full page is intentionally not re-injected after context compaction. Use the durable evidence/file ledger and saved exact quotes. Do not request this URL again merely to recover compacted context.",
    ].filter(Boolean).join("\n"),
  };
}

/**
 * Strip HTML tags and convert to readable plain text.
 * Handles common HTML entities and collapses whitespace.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove <script>, <style>, <noscript> blocks entirely
  text = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Replace <br> and block-level closing tags with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)>/gi, "\n");
  text = text.replace(/<(hr)\s*\/?>/gi, "\n---\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Collapse excessive whitespace / blank lines
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Try to extract the <title> from an HTML document.
 */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).trim() : undefined;
}

/** Extract machine-readable dates already embedded in HTML (for example,
 * GitHub's <relative-time datetime="..."> values). This adds research
 * freshness context without another network request. */
export function extractEmbeddedDocumentDates(html: string): string[] {
  const values = new Set<string>();
  const pattern = /<(?:time|relative-time)\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const timestamp = Date.parse(match[1]);
    if (Number.isFinite(timestamp)) values.add(new Date(timestamp).toISOString());
  }
  return [...values].sort((a, b) => b.localeCompare(a)).slice(0, 5);
}

export type FetchContentIssue = {
  code: "WAF_OR_BOT_CHECK" | "PAGE_NOT_FOUND" | "JS_OR_NAV_SHELL";
  message: string;
};

export function classifyFetchContent(url: string, title: string | undefined, raw: string, text: string): FetchContentIssue | null {
  const head = `${title || ""}\n${raw.slice(0, 6000)}\n${text.slice(0, 3000)}`;
  const compactText = text.replace(/\s+/g, "");

  // Match anti-bot/WAF *challenge* markers, not infrastructure names. Bare
  // `cloudflare`/`captcha`/`access denied` false-positived on any normal page
  // that merely loads a Cloudflare CDN/Insights asset (cdnjs.cloudflare.com,
  // static.cloudflareinsights.com) or a reCAPTCHA widget, wrongly telling the
  // model "do not retry, this is a bot wall". These phrases only appear on the
  // actual challenge/block page.
  if (/_waf_[a-z0-9]+|cf-browser-verification|__cf_chl|cf_chl_opt|Attention Required!\s*\|\s*Cloudflare|Cloudflare Ray ID|Checking your browser before access|Just a moment\.\.\.|Enable JavaScript and cookies to continue|Verify (?:you are|you're)(?: a)? human|complete the security check|you don'?t have permission to access|人机(?:身份)?验证|安全验证|访问验证|滑动验证|请完成验证|反爬/i.test(head)) {
    return {
      code: "WAF_OR_BOT_CHECK",
      message:
        "The site returned an anti-bot/WAF challenge instead of readable page content. " +
        "Do not retry the same web_fetch URL repeatedly; use search snippets, an accessible mirror/official source, or ask the user to provide the page text.",
    };
  }

  if (/页面不见了|页面找不到了|你访问的页面不见了|内容不存在|该内容已删除|404\s*(?:not found|页面)|page not found/i.test(head)) {
    return {
      code: "PAGE_NOT_FOUND",
      message:
        "The site says the page is missing or unavailable. " +
        "Do not keep fetching this URL; search for another copy or ask the user for a valid link/source.",
    };
  }

  if (
    /please enable javascript|enable javascript to continue|requires javascript|请启用javascript|需要javascript/i.test(head)
    || (/cls\.cn/i.test(url) && /关于我们网站声明联系方式用户反馈网站地图帮助首页电报话题盯盘VIPFM投研下载/.test(compactText))
  ) {
    return {
      code: "JS_OR_NAV_SHELL",
      message:
        "The site returned a JavaScript application shell/navigation page, not the article body. " +
        "Do not treat this as source content; use a browser-rendered source, search snippets, an alternate source, or ask the user for the text.",
    };
  }

  return null;
}

async function fetchGeneralUrl(url: string): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": WEB_FETCH_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": webFetchAcceptLanguage(),
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await readWebFetchResponse(response);
    if ("error" in body) {
      return {
        content: body.error.startsWith("HTTP") ? `${body.error} for ${url}` : body.error,
        isError: true,
      };
    }

    if (body.contentType.includes("json")) {
      try {
        return { content: JSON.stringify(JSON.parse(body.raw), null, 2) };
      } catch {
        return { content: body.raw };
      }
    }
    if (body.contentType.includes("text/plain")) {
      return { content: body.raw };
    }

    const title = extractTitle(body.raw);
    const text = htmlToText(body.raw);
    const issue = classifyFetchContent(url, title, body.raw, text);
    const lastModified = response.headers.get("last-modified");
    const embeddedDates = extractEmbeddedDocumentDates(body.raw);
    const header = [
      ...(title ? [`Title: ${title}`] : []),
      `URL: ${response.url || url}`,
      `Accessed at: ${new Date().toISOString()}`,
      ...(lastModified ? [`HTTP Last-Modified: ${lastModified}`] : []),
      ...(embeddedDates.length
        ? [`Embedded document dates (newest first): ${embeddedDates.join(", ")}`]
        : []),
      "",
      "",
    ].join("\n");
    if (issue) {
      return {
        content: `${header}${issue.code}: ${issue.message}\n\nExtracted text preview:\n${text}`,
        isError: true,
      };
    }
    return { content: header + text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("abort")) {
      return {
        content: `Timeout fetching ${url} (${DEFAULT_WEB_FETCH_TIMEOUT_MS}ms)`,
        isError: true,
      };
    }
    return { content: `Error fetching ${url}: ${message}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}

export const webFetchTool: AgentTool = defineTool({
  name: "web_fetch",
  executionMode: "parallel",
  description:
    "Fetch a web page by URL and return its content as readable text. " +
    "Use this to read articles, documentation, or any web page content. " +
    "Returns the page title and extracted text. A GitHub repository root is " +
    "resolved to a structured metadata + official README snapshot, so do not " +
    "make follow-up requests to its API or raw README aliases.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The HTTP or HTTPS URL to fetch." },
      maxChars: {
        type: "number",
        description: "Optional explicit character limit. Omit it to return the complete extracted body to the host Result Store.",
      },
    },
    required: ["url"],
  },
  async execute(input, ctx) {
    const url = (input.url as string).trim();
    const requestedMaxChars = Number(input.maxChars);
    const maxChars = Number.isFinite(requestedMaxChars) && requestedMaxChars > 0
      ? Math.trunc(requestedMaxChars)
      : null;

    if (!url) {
      return { content: "Error: url is required", isError: true };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { content: "Error: only http:// and https:// URLs are supported", isError: true };
    }

    const fetchCache = fetchCacheForState(ctx.state);
    const githubResource = identifyGitHubRepositoryResource(url);
    const requestKey = githubResource?.kind === "repository"
      ? `github:${githubResource.key}`
      : normalizedFetchUrl(url);
    const epoch = contextEpoch(ctx.state);
    const cached = fetchCache.get(requestKey);
    if (cached) {
      log.info("run cache hit; skipped network request", {
        maxChars: maxChars ?? "complete",
        compactReplay: epoch > cached.epoch,
      });
      const result = await cached.result;
      return epoch > cached.epoch
        ? compactCacheReplay(result)
        : applyExplicitCharacterLimit(result, maxChars);
    }

    const priorGitHubSnapshot = githubResource
      ? fetchCache.get(`github:${githubResource.key}`)
      : undefined;
    if (githubResource && githubResource.kind !== "repository" && priorGitHubSnapshot) {
      log.info("github repository alias cache hit; skipped network request", {
        repository: githubResource.key,
        requestedKind: githubResource.kind,
      });
      return compactGitHubSnapshotReplay(githubResource);
    }

    const request = githubResource?.kind === "repository"
      ? fetchGitHubRepositorySnapshot(githubResource)
      : fetchGeneralUrl(url);
    const cacheEntry = { epoch, result: request };
    fetchCache.set(requestKey, cacheEntry);
    const result = await request;
    if (result.isError) {
      fetchCache.delete(requestKey);
    }
    return applyExplicitCharacterLimit(result, maxChars);
  },
});
