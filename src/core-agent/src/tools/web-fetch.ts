/**
 * web_fetch — HTTP GET + basic text extraction.
 *
 * Fetches a URL and returns the page content as readable text (stripped HTML).
 * No external dependencies — uses Node's built-in fetch() + regex-based
 * HTML tag stripping.
 */
import { defineTool, type AgentTool } from "./base.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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

export const webFetchTool: AgentTool = defineTool({
  name: "web_fetch",
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

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timer);

      if (!resp.ok) {
        return {
          content: `HTTP ${resp.status} ${resp.statusText} for ${url}`,
          isError: true,
        };
      }

      const contentType = resp.headers.get("content-type") ?? "";

      // Read response body with size limit
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
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + "\n...(truncated)";
      }

      const header = title ? `Title: ${title}\nURL: ${url}\n\n` : `URL: ${url}\n\n`;
      return { content: header + text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { content: `Timeout fetching ${url} (${DEFAULT_TIMEOUT_MS}ms)`, isError: true };
      }
      return { content: `Error fetching ${url}: ${msg}`, isError: true };
    }
  },
});
