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

export type WebFetchResponseBody =
  | { ok: true; raw: string; contentType: string }
  | { ok: false; error: string };

/** Read and decode a response once while enforcing the common hard body limit. */
export async function readWebFetchResponse(response: Response): Promise<WebFetchResponseBody> {
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
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
