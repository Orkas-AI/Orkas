/**
 * Fetch diagnostics — logs the real undici cause chain when a request to
 * an LLM provider endpoint fails.
 *
 * Why this exists:
 *   - Node 18+ global fetch (undici) surfaces network failures as a bare
 *     `TypeError: fetch failed`. The actual cause (UND_ERR_HEADERS_TIMEOUT,
 *     UND_ERR_SOCKET, ECONNRESET, ENOTFOUND, …) is on `err.cause` / `err
 *     .cause.cause`.
 *   - pi-ai catches those errors internally, keeps only `error.message`,
 *     and retries up to 3 times. By the time the error reaches the host,
 *     the cause chain is long gone — so the `fetch failed` the user sees
 *     has no actionable signal.
 *
 * Scope:
 *   - Wraps `globalThis.fetch` once at boot, unconditionally.
 *   - Filters by URL so only LLM-provider traffic is logged — not
 *     arbitrary `web_fetch` or KB embedder downloads.
 *   - Output lands in `data/logs/YYYY-MM-DD.log`; grep for `fetch-diag`.
 */
import { createLogger } from '../../logger';

const log = createLogger('fetch-diag');

const PROVIDER_HOST_RE = /\b(openai\.com|anthropic\.com|chatgpt\.com|googleapis\.com|moonshot\.cn|api\.moonshot|bedrock|codex)\b/i;

export function installFetchDiag(): void {
  const original = globalThis.fetch;
  if (!original || (original as any).__orkasFetchDiag) return;

  const wrapped: typeof fetch = async (input: any, init?: any) => {
    const url =
      typeof input === 'string' ? input :
      input?.url ? String(input.url) :
      String(input);
    // Only watch provider traffic. Skip everything else so KB model
    // downloads etc. don't flood the log.
    if (!PROVIDER_HOST_RE.test(url)) return original(input, init);

    const t0 = Date.now();
    try {
      const res = await original(input, init);
      const dt = Date.now() - t0;
      if (!res.ok) {
        log.warn(
          `non-ok url=${url} status=${res.status} statusText="${res.statusText}" ms=${dt}`,
        );
      } else {
        log.info(`ok url=${url} status=${res.status} ms=${dt}`);
      }
      return res;
    } catch (err: any) {
      const dt = Date.now() - t0;
      const c1 = err?.cause;
      const c2 = c1?.cause;
      log.warn(
        `threw url=${url} ms=${dt} ` +
        `name=${err?.name ?? '-'} code=${err?.code ?? '-'} ` +
        `msg="${String(err?.message ?? '').slice(0, 200)}" ` +
        `cause.name=${c1?.name ?? '-'} cause.code=${c1?.code ?? '-'} ` +
        `cause.msg="${String(c1?.message ?? '').slice(0, 200)}" ` +
        `cause.cause.code=${c2?.code ?? '-'} ` +
        `cause.cause.msg="${String(c2?.message ?? '').slice(0, 200)}"`,
      );
      throw err;
    }
  };
  (wrapped as any).__orkasFetchDiag = true;
  globalThis.fetch = wrapped;
  log.info('installed');
}
