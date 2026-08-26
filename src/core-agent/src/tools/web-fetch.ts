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

type WebFetchFailurePolicyState = {
  authFailuresByOrigin: Map<string, number>;
  successfulOrigins: Set<string>;
  blockedAuthOrigins: Set<string>;
  transientFailuresByRequest: Map<string, number>;
};

const fetchCacheByRunState = new WeakMap<object, Map<string, WebFetchCacheEntry>>();
const failurePolicyByRunState = new WeakMap<object, WebFetchFailurePolicyState>();
const WEB_FETCH_RUN_CACHE_KEY = "webFetchCache";
const WEB_FETCH_FAILURE_POLICY_KEY = "webFetchFailurePolicy";
const AUTH_FAILURES_BEFORE_ORIGIN_BLOCK = 2;
const TRANSIENT_FAILURES_BEFORE_REQUEST_BLOCK = 2;

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

function newFailurePolicyState(): WebFetchFailurePolicyState {
  return {
    authFailuresByOrigin: new Map(),
    successfulOrigins: new Set(),
    blockedAuthOrigins: new Set(),
    transientFailuresByRequest: new Map(),
  };
}

function failurePolicyForState(state: Record<string, unknown>): WebFetchFailurePolicyState {
  const runScopedLedger = state.runScopedLedger;
  if (runScopedLedger instanceof Map) {
    const saved = runScopedLedger.get(WEB_FETCH_FAILURE_POLICY_KEY);
    if (saved && typeof saved === "object") return saved as WebFetchFailurePolicyState;
    const created = newFailurePolicyState();
    runScopedLedger.set(WEB_FETCH_FAILURE_POLICY_KEY, created);
    return created;
  }

  let fallback = failurePolicyByRunState.get(state);
  if (!fallback) {
    fallback = newFailurePolicyState();
    failurePolicyByRunState.set(state, fallback);
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

function fetchOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl;
  }
}

type FetchFailureDisposition = "auth_origin" | "permanent_url" | "transient";

function fetchFailureDisposition(result: ToolResult): FetchFailureDisposition | null {
  if (!result.isError) return null;
  if (/\bHTTP\s+(?:401|403)\b|\bWAF_OR_BOT_CHECK\b/i.test(result.content)) {
    return "auth_origin";
  }
  if (
    /\bHTTP\s+(?:404|410)\b|\b(?:PAGE_NOT_FOUND|JS_OR_NAV_SHELL|E_FETCH_RESPONSE_TOO_LARGE)\b/i
      .test(result.content)
  ) {
    return "permanent_url";
  }
  return "transient";
}

function failedCacheReplay(result: ToolResult): ToolResult {
  const original = result.content.replace(/\s+/g, " ").trim().slice(0, 320);
  return {
    content:
      "E_WEB_FETCH_NONRETRYABLE_CACHE_HIT: this normalized URL already failed "
      + "with a non-retryable result in this run; no network request was made. "
      + `Use a different source or strategy. Original result: ${original}`,
    isError: true,
  };
}

type WebFetchNetworkFailureCategory =
  | "dns"
  | "timeout"
  | "connection_refused"
  | "network_unreachable"
  | "connection_reset"
  | "tls"
  | "transport"
  | "network";

const SAFE_WEB_FETCH_NETWORK_CODE_RE = /\b(?:UND_ERR_[A-Z0-9_]+|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNRESET|ECONNABORTED|EPIPE|ERR_STREAM_PREMATURE_CLOSE|ERR_TLS_[A-Z0-9_]+|ERR_SSL_[A-Z0-9_]+|CERT_[A-Z0-9_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/g;
const MAX_WEB_FETCH_ERROR_NODES = 16;
const MAX_WEB_FETCH_ERROR_CODES = 4;

function webFetchNetworkFailureCategory(codes: readonly string[]): WebFetchNetworkFailureCategory {
  if (codes.some((code) => /^(?:ERR_(?:TLS|SSL)_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code))) return "tls";
  if (codes.some((code) => /^(?:EAI_AGAIN|ENOTFOUND)$/.test(code))) return "dns";
  if (codes.some((code) => /(?:TIMEOUT|ETIMEDOUT)/.test(code))) return "timeout";
  if (codes.includes("ECONNREFUSED")) return "connection_refused";
  if (codes.some((code) => /^(?:ENETUNREACH|EHOSTUNREACH|ENETDOWN)$/.test(code))) return "network_unreachable";
  if (codes.some((code) => /^(?:ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)$/.test(code))) return "connection_reset";
  if (codes.some((code) => code.startsWith("UND_ERR_"))) return "transport";
  return "network";
}

function collectSafeWebFetchNetworkCodes(error: unknown): string[] {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  const codes = new Set<string>();
  let visited = 0;

  while (queue.length && visited < MAX_WEB_FETCH_ERROR_NODES) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const value of [record.code, record.message]) {
      if (typeof value !== "string") continue;
      for (const match of value.toUpperCase().matchAll(SAFE_WEB_FETCH_NETWORK_CODE_RE)) {
        codes.add(match[0]);
        if (codes.size >= MAX_WEB_FETCH_ERROR_CODES) return [...codes];
      }
    }
    if (record.cause) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 8));
  }
  return [...codes];
}

/** Format a bounded network diagnostic without exposing socket addresses,
 * proxy details, certificate subjects, local paths, or arbitrary cause text. */
export function formatWebFetchNetworkFailure(error: unknown): string {
  const codes = collectSafeWebFetchNetworkCodes(error);
  const category = webFetchNetworkFailureCategory(codes);
  const summary = error instanceof Error && /^fetch failed$/i.test(error.message.trim())
    ? "fetch failed"
    : "request failed";
  return `${summary} [network_diagnostic category=${category}; codes=${codes.length ? codes.join(",") : "unavailable"}]`;
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
    return { content: `Error fetching ${url}: ${formatWebFetchNetworkFailure(error)}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}

export const webFetchTool: AgentTool = defineTool({
  name: "web_fetch",
  executionMode: "parallel",
  description:
    "Fetch one web URL and return its title and readable extracted text. A GitHub repository root returns structured metadata plus its official README snapshot. Run-scoped duplicate and repeated access failures are suppressed; switch sources instead of retrying them.",
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
    const failurePolicy = failurePolicyForState(ctx.state);
    const githubResource = identifyGitHubRepositoryResource(url);
    const requestKey = githubResource?.kind === "repository"
      ? `github:${githubResource.key}`
      : normalizedFetchUrl(url);
    const origin = fetchOrigin(url);
    const epoch = contextEpoch(ctx.state);
    const cached = fetchCache.get(requestKey);
    if (cached) {
      log.info("run cache hit; skipped network request", {
        maxChars: maxChars ?? "complete",
        compactReplay: epoch > cached.epoch,
      });
      const result = await cached.result;
      if (result.isError) return failedCacheReplay(result);
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

    if (failurePolicy.blockedAuthOrigins.has(origin)) {
      return {
        content:
          `E_WEB_FETCH_ORIGIN_AUTH_BLOCKED: ${origin} repeatedly returned authentication, `
          + "authorization, or anti-bot failures in this run. No network request was made. "
          + "Use a different source, search strategy, or an available browser capability.",
        isError: true,
      };
    }

    const request = githubResource?.kind === "repository"
      ? fetchGitHubRepositorySnapshot(githubResource)
      : fetchGeneralUrl(url);
    const cacheEntry = { epoch, result: request };
    fetchCache.set(requestKey, cacheEntry);
    let result = await request;
    const disposition = fetchFailureDisposition(result);
    if (disposition === null) {
      failurePolicy.successfulOrigins.add(origin);
      failurePolicy.authFailuresByOrigin.delete(origin);
      failurePolicy.blockedAuthOrigins.delete(origin);
      failurePolicy.transientFailuresByRequest.delete(requestKey);
    } else if (disposition === "auth_origin") {
      const failures = (failurePolicy.authFailuresByOrigin.get(origin) ?? 0) + 1;
      failurePolicy.authFailuresByOrigin.set(origin, failures);
      if (
        failures >= AUTH_FAILURES_BEFORE_ORIGIN_BLOCK
        && !failurePolicy.successfulOrigins.has(origin)
      ) {
        failurePolicy.blockedAuthOrigins.add(origin);
        result = {
          ...result,
          content:
            `${result.content}\n\nE_WEB_FETCH_ORIGIN_AUTH_CIRCUIT_OPENED: ${origin} has now failed `
            + `${failures} distinct access attempts in this run. Switch sources instead of `
            + "trying more URLs from this origin.",
        };
      }
      // Authentication, authorization, and WAF failures are not made useful by
      // retrying the same normalized URL. Keep this failed promise in the cache.
    } else if (disposition === "transient") {
      const failures = (failurePolicy.transientFailuresByRequest.get(requestKey) ?? 0) + 1;
      failurePolicy.transientFailuresByRequest.set(requestKey, failures);
      if (failures < TRANSIENT_FAILURES_BEFORE_REQUEST_BLOCK) {
        fetchCache.delete(requestKey);
      } else {
        result = {
          ...result,
          content:
            `${result.content}\n\nE_WEB_FETCH_RETRY_LIMIT: this URL has failed ${failures} `
            + "transient attempts in this run. Switch sources or strategy.",
        };
        cacheEntry.result = Promise.resolve(result);
      }
    }
    return applyExplicitCharacterLimit(result, maxChars);
  },
});
