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
  renderGitHubSnapshotView,
  type GitHubRepositorySnapshot,
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

export type WebFetchRenderedPage = {
  /** Full document HTML after the browser finished loading and running scripts. */
  html: string;
  /** Final URL after client-side redirects, when the renderer can report one. */
  url?: string;
};

/**
 * Browser-rendered retry for a URL whose direct HTTP response was a bot check
 * or a client-rendered shell. core-agent ships no browser runtime, so the host
 * registers one; unregistered, every fetch keeps the HTTP-only behavior.
 * Returning null means "could not recover" and leaves the direct failure intact.
 */
export type WebFetchRenderer = (
  url: string,
  signal?: AbortSignal,
) => Promise<WebFetchRenderedPage | null>;

let activeWebFetchRenderer: WebFetchRenderer | null = null;

/** Register the host's browser-rendered retry, or clear it with `null`. */
export function configureWebFetchRenderer(renderer: WebFetchRenderer | null): void {
  activeWebFetchRenderer = renderer;
}

type WebFetchCacheEntry = {
  epoch: number;
  result: Promise<ToolResult>;
  githubSnapshot?: Promise<GitHubRepositorySnapshot>;
  /** End of the furthest character range already returned for this URL. After
   * context compaction, only windows at or beyond it are served again. */
  servedThrough?: number;
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
    /\bHTTP\s+(?:404|410)\b|\b(?:PAGE_NOT_FOUND|JS_OR_NAV_SHELL|E_FETCH_RESPONSE_TOO_LARGE|E_WEB_FETCH_BINARY_CONTENT)\b/i
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

const REUSABLE_HEADER_RE = /^(?:Title|URL|Accessed at|Retrieved by|HTTP Last-Modified|Embedded document dates \(newest first\)):/i;

/** Source header lines (title, URL, access time) from the block before the body. */
function reusableHeader(content: string): string {
  const blankLine = content.indexOf("\n\n");
  const head = blankLine < 0 ? content.slice(0, 2_000) : content.slice(0, blankLine);
  return head.split("\n").filter((line) => REUSABLE_HEADER_RE.test(line)).slice(0, 6).join("\n");
}

/** Headings named in a truncation receipt, and how far past the cut to look. */
const RECEIPT_MAX_HEADINGS = 10;
const RECEIPT_HEADING_SCAN_CHARS = 200_000;
const RECEIPT_HEADING_MAX_CHARS = 80;
const NUMBERED_HEADING_RE = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}|[A-Z](?:\.\d{1,2}){1,3})\.?\s+\S/;
const SENTENCE_END_RE = /[.,;:!。，；：！…、]$/;

function looksLikeTitle(line: string, maxLength: number): boolean {
  if (line.length > maxLength || SENTENCE_END_RE.test(line)) return false;
  if (/https?:\/\/|www\.|\|/.test(line) || line.split(" ").length > 12) return false;
  if (!/^[\p{Lu}\p{Lo}\d]/u.test(line)) return false;
  // Table rows and figure data are mostly digits and symbols.
  const visible = line.replace(/\s/g, "");
  const letters = visible.match(/\p{L}/gu)?.length ?? 0;
  return letters >= visible.length * 0.6;
}

/**
 * Lines after `from` that look like section headings, used only to describe
 * the unread remainder in a truncation receipt. Markdown and numbered headings
 * are listed alone when there are enough of them; otherwise short title-like
 * lines are included. Character counts and offsets in a receipt are exact; this
 * outline is best effort.
 */
function detectHeadingsAfter(content: string, from: number): { headings: string[]; more: number } {
  let tail = content.slice(from, from + RECEIPT_HEADING_SCAN_CHARS);
  if (from > 0 && content[from - 1] !== "\n") {
    // Skip the line the window boundary cut through.
    const lineEnd = tail.indexOf("\n");
    tail = lineEnd < 0 ? "" : tail.slice(lineEnd + 1);
  }
  const candidates: Array<{ title: string; structural: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of tail.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3) continue;
    const markdown = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    const structural = Boolean(markdown) || (NUMBERED_HEADING_RE.test(line) && looksLikeTitle(line, 90));
    if (!structural && !looksLikeTitle(line, RECEIPT_HEADING_MAX_CHARS)) continue;
    const title = (markdown ? markdown[1] : line).slice(0, RECEIPT_HEADING_MAX_CHARS);
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ title, structural });
  }
  const structuralCount = candidates.filter((candidate) => candidate.structural).length;
  const pool = structuralCount >= 3 ? candidates.filter((candidate) => candidate.structural) : candidates;
  const headings = pool.slice(0, RECEIPT_MAX_HEADINGS).map((candidate) => candidate.title);
  return { headings, more: pool.length - headings.length };
}

/** Exact remainder facts plus the offset that continues the same URL. */
function continuationReceipt(content: string, end: number, opening: string): string {
  const { headings, more } = detectHeadingsAfter(content, end);
  return [
    `\n...(${opening}; ${content.length - end} more characters remain.`,
    ...(headings.length
      ? [`Headings after this point (detected): ${headings.join(" | ")}${more > 0 ? ` (+${more} more)` : ""}.`]
      : []),
    `Continue with the same url and "offset": ${end}; later windows come from this run's cache without another network request.)`,
  ].join("\n");
}

type FetchView = {
  result: ToolResult;
  /** End of the character range this view returned in reading order. */
  servedEnd: number | null;
};

/**
 * Render one call's view of a complete fetch result. Offset 0 returns the
 * prefix that fits maxChars (a GitHub snapshot fits its README instead);
 * a positive offset returns the window starting there, with the source header
 * repeated so the window stands on its own as evidence.
 */
function renderFetchView(
  result: ToolResult,
  maxChars: number | null,
  offset: number,
  githubSnapshot: boolean,
): FetchView {
  if (result.isError) return { result: applyExplicitCharacterLimit(result, maxChars), servedEnd: null };
  const content = result.content;
  const total = content.length;
  if (offset === 0) {
    if (githubSnapshot) {
      const view = renderGitHubSnapshotView(content, maxChars);
      if (view) return { result: { ...result, content: view.content }, servedEnd: view.servedEnd };
    }
    if (maxChars === null || total <= maxChars) return { result, servedEnd: total };
    return {
      result: {
        ...result,
        content: content.slice(0, maxChars) + continuationReceipt(
          content,
          maxChars,
          `truncated at the explicitly requested maxChars: characters 0-${maxChars} of ${total} shown`,
        ),
      },
      servedEnd: maxChars,
    };
  }
  if (offset >= total) {
    return {
      result: {
        content:
          `E_WEB_FETCH_OFFSET_OUT_OF_RANGE: offset ${offset} is at or past the end of this URL's `
          + `extracted content (${total} characters). Use an offset below ${total}.`,
        isError: true,
      },
      servedEnd: null,
    };
  }
  const end = maxChars === null ? total : Math.min(total, offset + maxChars);
  const header = reusableHeader(content);
  const windowLine = `Window: characters ${offset}-${end} of ${total} (continued from this run's cached fetch; no network request was made)`;
  return {
    result: {
      ...result,
      content: `${header ? `${header}\n` : ""}${windowLine}\n\n${content.slice(offset, end)}`
        + (end < total
          ? continuationReceipt(content, end, `window ends at character ${end} of ${total}`)
          : `\n...(end of the extracted content at character ${total}.)`),
    },
    servedEnd: end,
  };
}

function parseOffset(value: unknown): number | string {
  if (value === undefined || value === null || value === "") return 0;
  const offset = Number(value);
  if (Number.isInteger(offset) && offset >= 0) return offset;
  return `Error: offset must be a non-negative integer character position (received ${JSON.stringify(String(value).slice(0, 40))}); `
    + "use 0 or the offset a truncated result reported.";
}

function compactCacheReplay(result: ToolResult, servedThrough: number): ToolResult {
  const total = result.content.length;
  return {
    content: [
      "WEB_FETCH_RUN_CACHE_HIT: this normalized URL already succeeded earlier in this run; no network request was made.",
      reusableHeader(result.content),
      "The full page is intentionally not re-injected after context compaction. Use the durable evidence/file ledger and saved exact quotes. Do not request this URL again merely to recover compacted context.",
      servedThrough < total
        ? `Characters ${servedThrough}-${total} have not been read in order yet; to continue, call web_fetch with "offset": ${servedThrough}.`
        : "",
    ].filter(Boolean).join("\n"),
  };
}

/**
 * Strip HTML tags and convert to readable plain text.
 * Handles common HTML entities and collapses whitespace.
 */
export function decodeNumericEntity(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  return String.fromCodePoint(codePoint);
}

export function htmlToText(html: string): string {
  let text = html;

  // Remove <script>, <style>, <noscript> blocks entirely
  text = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Replace <br> and block-level closing tags with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)>/gi, "\n");
  // Adjacent table cells must not concatenate ("<td>a</td><td>b</td>" → "a b"),
  // so map cell-closing tags to a space before the generic tag strip.
  text = text.replace(/<\/(td|th)>/gi, " ");
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
    .replace(/&#(\d+);/g, (_, num) => decodeNumericEntity(parseInt(num, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeNumericEntity(parseInt(hex, 16)));

  // Collapse excessive whitespace / blank lines
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ +\n/g, "\n");
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

const BINARY_APPLICATION_TYPES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/java-archive",
  "application/x-msdownload",
  "application/msword",
]);

/** Share of NUL, control, and replacement characters that marks decoded bytes as binary. */
const BINARY_NOISE_RATIO = 0.1;

/**
 * Name the binary payload a response carries, or null for readable text.
 * Decoding a PDF or archive as text produced pages of mojibake that were
 * returned as a successful fetch; the content type and the PDF signature are
 * authoritative. A body without a textual type counts as binary only when its
 * decoded prefix is mostly non-text characters; text types keep their existing
 * handling even when a missing charset garbles them.
 */
function binaryContentKind(contentType: string, raw: string): string | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/pdf" || raw.startsWith("%PDF-")) return "a PDF document";
  if (
    (/^(?:image|audio|video|font)\//.test(type) && type !== "image/svg+xml")
    || BINARY_APPLICATION_TYPES.has(type)
    || /^application\/vnd\.(?:openxmlformats-officedocument|ms-|oasis\.opendocument)/.test(type)
  ) {
    return `a binary file (${type})`;
  }
  if (/^text\//.test(type) || /xml|json|javascript|html/.test(type)) return null;
  const sample = raw.slice(0, 4_096);
  if (!sample) return null;
  let noise = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (char === "\uFFFD" || code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)) {
      noise += 1;
    }
  }
  if (sample.includes("\u0000") || noise > sample.length * BINARY_NOISE_RATIO) {
    return type ? `a binary file (${type})` : "a binary file";
  }
  return null;
}

/** Bounds for the shell-by-emptiness rule in `classifyFetchContent`. */
const SHELL_MAX_TEXT_CHARS = 600;
const SHELL_MIN_HTML_BYTES = 4096;
const SHELL_MAX_TEXT_TO_HTML_RATIO = 0.005;

export type FetchContentIssue = {
  code: "WAF_OR_BOT_CHECK" | "PAGE_NOT_FOUND" | "JS_OR_NAV_SHELL";
  message: string;
};

const BOT_CHECK_ISSUE: FetchContentIssue = {
  code: "WAF_OR_BOT_CHECK",
  message:
    "The site returned an anti-bot/WAF challenge instead of readable page content. " +
    "Do not retry the same web_fetch URL repeatedly; use search snippets, an accessible mirror/official source, or ask the user to provide the page text.",
};

export function classifyFetchContent(url: string, title: string | undefined, raw: string, text: string): FetchContentIssue | null {
  const head = `${title || ""}\n${raw.slice(0, 6000)}\n${text.slice(0, 3000)}`;
  const compactText = text.replace(/\s+/g, "");

  // Match anti-bot/WAF *challenge* markers, not infrastructure names. Bare
  // `cloudflare`/`captcha`/`access denied` false-positived on any normal page
  // that merely loads a Cloudflare CDN/Insights asset (cdnjs.cloudflare.com,
  // static.cloudflareinsights.com) or a reCAPTCHA widget, wrongly telling the
  // model "do not retry, this is a bot wall". These phrases only appear on the
  // actual challenge/block page. The `verify your browser|connection` clause
  // covers AWS WAF interstitials ("Verifying your connection...", "Please wait
  // while we verify your browser"), which share no wording with Cloudflare's.
  if (/_waf_[a-z0-9]+|cf-browser-verification|__cf_chl|cf_chl_opt|Attention Required!\s*\|\s*Cloudflare|Cloudflare Ray ID|Checking your browser before access|verif(?:y|ying)\s+(?:your\s+)?(?:browser|connection)|Just a moment\.\.\.|Enable JavaScript and cookies to continue|Verify (?:you are|you're)(?: a)? human|complete the security check|you don'?t have permission to access|人机(?:身份)?验证|安全验证|访问验证|滑动验证|请完成验证|反爬/i.test(head)) {
    return BOT_CHECK_ISSUE;
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

  // A response carrying almost no readable text for its markup size is an app
  // shell, bot-check interstitial, or login wall. Without this, such pages
  // returned isError:false with an empty body, so the run cache recorded a
  // successful fetch and the model could not tell "blocked" from "page is
  // genuinely empty". Absolute and relative bounds must both hold so a
  // genuinely short page (small markup, short text) is never flagged.
  if (
    compactText.length < SHELL_MAX_TEXT_CHARS
    && raw.length >= SHELL_MIN_HTML_BYTES
    && compactText.length < raw.length * SHELL_MAX_TEXT_TO_HTML_RATIO
  ) {
    return {
      code: "JS_OR_NAV_SHELL",
      message:
        "The response carried almost no readable text for its markup size — a client-rendered " +
        "app shell, bot-check interstitial, or login wall rather than the page body. " +
        "Do not treat this as source content; use a browser-rendered source, search snippets, an alternate source, or ask the user for the text.",
    };
  }

  return null;
}

function pageHeader(fields: {
  title?: string | undefined;
  url: string;
  lastModified?: string | null;
  embeddedDates?: readonly string[];
  retrievedBy?: string;
}): string {
  return [
    ...(fields.title ? [`Title: ${fields.title}`] : []),
    `URL: ${fields.url}`,
    `Accessed at: ${new Date().toISOString()}`,
    ...(fields.retrievedBy ? [`Retrieved by: ${fields.retrievedBy}`] : []),
    ...(fields.lastModified ? [`HTTP Last-Modified: ${fields.lastModified}`] : []),
    ...(fields.embeddedDates?.length
      ? [`Embedded document dates (newest first): ${fields.embeddedDates.join(", ")}`]
      : []),
    "",
    "",
  ].join("\n");
}

type DirectFetchOutcome = {
  result: ToolResult;
  /** Set when running the same URL through a real browser could plausibly
   * recover the body — a bot check or a client-rendered shell, not a missing
   * page, an oversized body, or a transport failure. */
  browserRecoverable: boolean;
};

async function httpFetchPage(url: string, signal?: AbortSignal): Promise<DirectFetchOutcome> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
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
    // SSE's CDN can return a cookie challenge with HTTP 200 and no readable
    // body markers. Use its explicit response diagnostic, not the server brand
    // or a guessed interpretation of the obfuscated JavaScript.
    const headerChallenge = response.headers.get("x-tengine-error")?.trim().toLowerCase() === "denied by bot"
      ? BOT_CHECK_ISSUE : null;
    if ("error" in body) {
      const base = body.error.startsWith("HTTP") ? `${body.error} for ${url}` : body.error;
      // Preserve explicit header or markup challenge evidence instead of
      // reporting only a bare status.
      const challenge = (body.error.startsWith("HTTP") ? headerChallenge : null) ?? (body.errorBody
        ? classifyFetchContent(url, extractTitle(body.errorBody), body.errorBody, htmlToText(body.errorBody))
        : null);
      if (!challenge) return { result: { content: base, isError: true }, browserRecoverable: false };
      return {
        result: { content: `${base}\n${challenge.code}: ${challenge.message}`, isError: true },
        browserRecoverable: challenge.code === "WAF_OR_BOT_CHECK",
      };
    }

    if (headerChallenge) {
      return {
        result: {
          content: pageHeader({ url: response.url || url }) + `${headerChallenge.code}: ${headerChallenge.message}`,
          isError: true,
        },
        browserRecoverable: true,
      };
    }

    const binaryKind = binaryContentKind(body.contentType, body.raw);
    if (binaryKind) {
      return {
        result: {
          content:
            `E_WEB_FETCH_BINARY_CONTENT: ${response.url || url} returned ${binaryKind}, not readable HTML or text; `
            + "web_fetch does not extract binary files. Use an HTML or text version of the same document, or another source.",
          isError: true,
        },
        browserRecoverable: false,
      };
    }

    if (body.contentType.includes("json")) {
      try {
        return { result: { content: JSON.stringify(JSON.parse(body.raw), null, 2) }, browserRecoverable: false };
      } catch {
        return { result: { content: body.raw }, browserRecoverable: false };
      }
    }
    if (body.contentType.includes("text/plain")) {
      return { result: { content: body.raw }, browserRecoverable: false };
    }

    const title = extractTitle(body.raw);
    const text = htmlToText(body.raw);
    const issue = classifyFetchContent(url, title, body.raw, text);
    const header = pageHeader({
      title,
      url: response.url || url,
      lastModified: response.headers.get("last-modified"),
      embeddedDates: extractEmbeddedDocumentDates(body.raw),
    });
    if (issue) {
      return {
        result: {
          content: `${header}${issue.code}: ${issue.message}\n\nExtracted text preview:\n${text}`,
          isError: true,
        },
        // A deleted page stays deleted in a browser; a challenge or a shell may not.
        browserRecoverable: issue.code !== "PAGE_NOT_FOUND",
      };
    }
    return { result: { content: header + text }, browserRecoverable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal?.aborted) {
      return { result: { content: `Fetch of ${url} was cancelled`, isError: true }, browserRecoverable: false };
    }
    if (message.includes("abort")) {
      return {
        result: {
          content: `Timeout fetching ${url} (${DEFAULT_WEB_FETCH_TIMEOUT_MS}ms)`,
          isError: true,
        },
        browserRecoverable: false,
      };
    }
    return {
      result: { content: `Error fetching ${url}: ${formatWebFetchNetworkFailure(error)}`, isError: true },
      browserRecoverable: false,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Retry through the host browser. Returns null whenever the rendered document
 * is missing, unusable, or still a challenge/shell, so the caller keeps the
 * direct failure rather than presenting a second shell as evidence. */
async function renderPage(url: string, signal?: AbortSignal): Promise<ToolResult | null> {
  const renderer = activeWebFetchRenderer;
  if (!renderer || signal?.aborted) return null;

  let page: WebFetchRenderedPage | null = null;
  try {
    page = await renderer(url, signal);
  } catch (error) {
    log.warn("browser render retry failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }

  const html = page?.html ?? "";
  if (!html) return null;
  const title = extractTitle(html);
  const text = htmlToText(html);
  if (classifyFetchContent(url, title, html, text)) {
    log.info("browser render retry still returned a challenge or shell");
    return null;
  }

  log.info("browser render retry recovered the page body", { text_chars: text.length });
  return {
    content: pageHeader({
      title,
      url: page?.url || url,
      embeddedDates: extractEmbeddedDocumentDates(html),
      retrievedBy: "browser rendering (the direct HTTP response was a bot check or app shell)",
    }) + text,
  };
}

async function fetchGeneralUrl(url: string, signal?: AbortSignal): Promise<ToolResult> {
  const direct = await httpFetchPage(url, signal);
  if (!direct.browserRecoverable) return direct.result;
  return (await renderPage(url, signal)) ?? direct.result;
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
      offset: {
        type: "integer",
        minimum: 0,
        description: "Optional zero-based character position in the complete extracted result to start from; a result cut by maxChars reports the next offset. Windows of a URL fetched earlier in this run come from the run cache without a network request.",
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
    const offset = parseOffset(input.offset);
    if (typeof offset === "string") return { content: offset, isError: true };
    if (ctx.signal?.aborted) return { content: `Fetch of ${url} was cancelled`, isError: true };

    const fetchCache = fetchCacheForState(ctx.state);
    const failurePolicy = failurePolicyForState(ctx.state);
    const githubResource = identifyGitHubRepositoryResource(url);
    const githubSnapshot = githubResource?.kind === "repository";
    const requestKey = githubSnapshot
      ? `github:${githubResource.key}`
      : normalizedFetchUrl(url);
    const origin = fetchOrigin(url);
    const epoch = contextEpoch(ctx.state);
    const serveView = (entry: WebFetchCacheEntry, result: ToolResult): ToolResult => {
      const view = renderFetchView(result, maxChars, offset, githubSnapshot);
      if (view.servedEnd !== null) {
        entry.servedThrough = Math.max(entry.servedThrough ?? 0, view.servedEnd);
      }
      return view.result;
    };
    const cached = fetchCache.get(requestKey);
    if (cached) {
      const servedThrough = cached.servedThrough ?? 0;
      // After compaction a window is served only to continue past what was
      // already returned, never to re-inject text the model has seen.
      const compactReplay = epoch > cached.epoch && !(offset > 0 && offset >= servedThrough);
      log.info("run cache hit; skipped network request", {
        maxChars: maxChars ?? "complete",
        offset,
        compactReplay,
      });
      const result = await cached.result;
      if (result.isError) return failedCacheReplay(result);
      return compactReplay ? compactCacheReplay(result, servedThrough) : serveView(cached, result);
    }

    const priorGitHubSnapshot = githubResource?.snapshotComponent
      ? fetchCache.get(`github:${githubResource.key}`)?.githubSnapshot
      : undefined;
    if (githubResource?.snapshotComponent && priorGitHubSnapshot) {
      // Raw URLs and ref/path variants have independent identities. An exact
      // default API alias may reuse only its own acquired component or failure.
      const snapshot = await priorGitHubSnapshot;
      if (ctx.signal?.aborted) return { content: `Fetch of ${url} was cancelled`, isError: true };
      const component = snapshot.components[githubResource.snapshotComponent];
      if (component.ok === false) return applyExplicitCharacterLimit({ content: component.error, isError: true }, maxChars);
      log.info("github repository alias cache hit; skipped network request", {
        repository: githubResource.key,
        requestedKind: githubResource.kind,
      });
      return applyExplicitCharacterLimit(compactGitHubSnapshotReplay(githubResource), maxChars);
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

    const snapshotRequest = githubResource?.kind === "repository"
      ? fetchGitHubRepositorySnapshot(githubResource, ctx.signal)
      : undefined;
    const request = snapshotRequest
      ? snapshotRequest.then(snapshot => snapshot.result)
      : fetchGeneralUrl(url, ctx.signal);
    const cacheEntry: WebFetchCacheEntry = { epoch, result: request, githubSnapshot: snapshotRequest };
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
    return serveView(cacheEntry, result);
  },
});
