/**
 * web_fetch — HTTP GET + basic text extraction.
 *
 * Fetches a URL and returns the page content as readable text (stripped HTML).
 * No external dependencies — uses Node's built-in fetch() + regex-based
 * HTML tag stripping.
 */
import { defineTool, type AgentTool } from "./base.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function acceptLanguage(): string {
  return process.env.ORKAS_ACCEPT_LANGUAGE || "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7";
}

/**
 * Pick the charset for decoding raw response bytes.
 *
 *   1. HTTP `Content-Type: text/html; charset=...` header — authoritative
 *      when present.
 *   2. `<meta charset="...">` or `<meta http-equiv="Content-Type"
 *      content="text/html; charset=...">` in the first ~2 KB of the body.
 *      We peek at the bytes as latin1 because ASCII-range tags (`<meta`)
 *      survive that decoding regardless of the actual document encoding.
 *   3. Default to `utf-8`.
 *
 * Returned value is lowercased and passed directly to `TextDecoder` — the
 * WHATWG Encoding standard accepts aliases like `gbk`, `gb2312`, `gb18030`,
 * `big5`, `shift_jis`, `windows-1252`, etc.
 */
export function resolveCharset(contentType: string, headBytes: Buffer): string {
  const headerMatch = contentType.match(/charset\s*=\s*["']?([A-Za-z0-9._\-]+)/i);
  if (headerMatch) return headerMatch[1].toLowerCase();

  const head = headBytes.subarray(0, Math.min(headBytes.byteLength, 2048)).toString("latin1");
  const metaMatch = head.match(/<meta[^>]*charset\s*=\s*["']?([A-Za-z0-9._\-]+)/i);
  if (metaMatch) return metaMatch[1].toLowerCase();

  return "utf-8";
}

/**
 * Decode bytes with the given charset label. If the label is unknown or
 * unsupported by the runtime's TextDecoder, fall back to UTF-8 — replacement
 * characters are preferable to throwing on the caller.
 */
export function decodeBytes(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
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

export type FetchContentIssue = {
  code: "WAF_OR_BOT_CHECK" | "PAGE_NOT_FOUND" | "JS_OR_NAV_SHELL";
  message: string;
};

export function classifyFetchContent(url: string, title: string | undefined, raw: string, text: string): FetchContentIssue | null {
  const head = `${title || ""}\n${raw.slice(0, 6000)}\n${text.slice(0, 3000)}`;
  const compactText = text.replace(/\s+/g, "");

  if (/_waf_[a-z0-9]+|captcha|cloudflare|access denied|bot detection|人机验证|安全验证|访问验证|验证码|反爬/i.test(head)) {
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

export const webFetchTool: AgentTool = defineTool({
  name: "web_fetch",
  executionMode: "parallel",
  description:
    "Fetch a web page by URL and return its content as readable text. " +
    "Use this to read articles, documentation, or any web page content. " +
    "Returns the page title and extracted text.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The HTTP or HTTPS URL to fetch." },
      maxChars: {
        type: "number",
        description: `Maximum characters to return (default: ${DEFAULT_MAX_CHARS}). Truncates if exceeded.`,
      },
    },
    required: ["url"],
  },
  async execute(input) {
    const url = (input.url as string).trim();
    const maxChars = (input.maxChars as number | undefined) ?? DEFAULT_MAX_CHARS;

    if (!url) {
      return { content: "Error: url is required", isError: true };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { content: "Error: only http:// and https:// URLs are supported", isError: true };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(url, {
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
          return {
            content: `HTTP ${resp.status} ${resp.statusText} for ${url}`,
            isError: true,
          };
        }

        const contentType = resp.headers.get("content-type") ?? "";

        // Read response body with size limit. Keep the timeout active until
        // the body is consumed; slow pages often send headers quickly and then
        // stall during the read.
        const reader = resp.body?.getReader();
        if (!reader) {
          return { content: "Error: empty response body", isError: true };
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel();
            break;
          }
        }

        const buf = Buffer.concat(chunks);
        const charset = resolveCharset(contentType, buf);
        const raw = decodeBytes(buf, charset);

        // JSON responses: return as-is (pretty-printed if possible)
        if (contentType.includes("json")) {
          try {
            const pretty = JSON.stringify(JSON.parse(raw), null, 2);
            const truncated = pretty.length > maxChars ? pretty.slice(0, maxChars) + "\n...(truncated)" : pretty;
            return { content: truncated };
          } catch {
            const truncated = raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated)" : raw;
            return { content: truncated };
          }
        }

        // Plain text: return as-is
        if (contentType.includes("text/plain")) {
          const truncated = raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated)" : raw;
          return { content: truncated };
        }

        // HTML: extract text
        const title = extractTitle(raw);
        let text = htmlToText(raw);
        const issue = classifyFetchContent(url, title, raw, text);
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + "\n...(truncated)";
        }

        const header = title ? `Title: ${title}\nURL: ${url}\n\n` : `URL: ${url}\n\n`;
        if (issue) {
          return { content: `${header}${issue.code}: ${issue.message}\n\nExtracted text preview:\n${text}`, isError: true };
        }
        return { content: header + text };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { content: `Timeout fetching ${url} (${DEFAULT_TIMEOUT_MS}ms)`, isError: true };
      }
      return { content: `Error fetching ${url}: ${msg}`, isError: true };
    }
  },
});
