/** Shared HTTP response handling for web_fetch providers. */

export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 60_000;

/** Network/body safety bound, separate from the model-context policy. */
export const MAX_WEB_FETCH_RESPONSE_BYTES = 16 * 1024 * 1024;

export const WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function webFetchAcceptLanguage(): string {
  return process.env.ORKAS_ACCEPT_LANGUAGE || "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7";
}

/**
 * Prefer the HTTP charset, then a charset declared in the first 2 KB of HTML,
 * and finally UTF-8.
 */
export function resolveCharset(contentType: string, headBytes: Buffer): string {
  const headerMatch = contentType.match(/charset\s*=\s*["']?([A-Za-z0-9._\-]+)/i);
  if (headerMatch) return headerMatch[1].toLowerCase();

  const head = headBytes.subarray(0, Math.min(headBytes.byteLength, 2048)).toString("latin1");
  const metaMatch = head.match(/<meta[^>]*charset\s*=\s*["']?([A-Za-z0-9._\-]+)/i);
  if (metaMatch) return metaMatch[1].toLowerCase();

  return "utf-8";
}

/** Decode with the declared charset and safely fall back to UTF-8. */
export function decodeBytes(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

/**
 * Non-2xx bodies are read only to classify blocked/challenge pages, never kept
 * as evidence, so a small bound is enough to see a challenge marker while
 * keeping a hostile error page bounded.
 */
export const MAX_WEB_FETCH_ERROR_BODY_BYTES = 256 * 1024;

export type WebFetchResponseBody =
  | { ok: true; raw: string; contentType: string }
  // `errorBody` is deliberately not named `raw`: callers discriminate this
  // union with `"raw" in body`, so the failure variant must not expose that key.
  | { ok: false; error: string; errorBody?: string };

/** Read a bounded prefix of a body, or null when nothing could be read. */
async function readBoundedBody(response: Response, limitBytes: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    // Keep whatever arrived; a truncated challenge page still classifies.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!chunks.length) return null;
  return Buffer.concat(chunks).subarray(0, limitBytes);
}

/** Read and decode a response once while enforcing the common hard body limit. */
export async function readWebFetchResponse(response: Response): Promise<WebFetchResponseBody> {
  if (!response.ok) {
    // Keep the body: a 401/403/503 that is really an anti-bot challenge only
    // says so in its markup. Discarding it left callers with a bare status and
    // no way to tell "needs credentials" from "blocked as a bot".
    const error = `HTTP ${response.status} ${response.statusText}`;
    const bytes = await readBoundedBody(response, MAX_WEB_FETCH_ERROR_BODY_BYTES);
    if (!bytes?.byteLength) return { ok: false, error };
    const charset = resolveCharset(response.headers.get("content-type") ?? "", bytes);
    return { ok: false, error, errorBody: decodeBytes(bytes, charset) };
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEB_FETCH_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      error:
        `E_FETCH_RESPONSE_TOO_LARGE: response declares ${declaredLength} bytes; `
        + `hard safety limit is ${MAX_WEB_FETCH_RESPONSE_BYTES} bytes. No partial page was returned.`,
    };
  }

  const reader = response.body?.getReader();
  if (!reader) return { ok: false, error: "Error: empty response body" };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_WEB_FETCH_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        error:
          `E_FETCH_RESPONSE_TOO_LARGE: response exceeded ${MAX_WEB_FETCH_RESPONSE_BYTES} bytes while streaming. `
          + "No partial page was returned.",
      };
    }
    chunks.push(value);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.concat(chunks);
  const charset = resolveCharset(contentType, buffer);
  return { ok: true, raw: decodeBytes(buffer, charset), contentType };
}
