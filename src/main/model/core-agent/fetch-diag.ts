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
 *     and retries up to 3 times. By the time the error reaches Orkas, the
 *     cause chain is long gone — so the `fetch failed` the user sees has
 *     no actionable signal.
 *
 * When it runs:
 *   - The open-source build installs it unconditionally so provider fetch failures surface
 *     their real cause in both development and packaged builds.
 *
 * Scope:
 *   - Wraps `globalThis.fetch` once.
 *   - Filters by URL so only LLM-provider traffic is logged — not
 *     arbitrary `web_fetch`, KB embedder downloads, or telemetry pings.
 *
 * Usage:
 *   grep "fetch-diag" data/logs/YYYY-MM-DD.log
 */
import { createLogger } from '../../logger';
import { logErrorSummary, safeUrlAction } from '../../util/log-redact';

const log = createLogger('fetch-diag');

function isHostOrSubdomain(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isProviderUrl(rawUrl: string): boolean {
  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  if (
    isHostOrSubdomain(hostname, 'openai.com')
    || isHostOrSubdomain(hostname, 'anthropic.com')
    || isHostOrSubdomain(hostname, 'chatgpt.com')
    || isHostOrSubdomain(hostname, 'moonshot.cn')
    || isHostOrSubdomain(hostname, 'moonshot.ai')
    || hostname === 'generativelanguage.googleapis.com'
    || hostname === 'aiplatform.googleapis.com'
    || hostname.endsWith('-aiplatform.googleapis.com')
  ) return true;
  return (
    (hostname === 'amazonaws.com' || hostname.endsWith('.amazonaws.com'))
    && hostname.split('.')[0].startsWith('bedrock')
  );
}

export function installFetchDiag(): void {
  const original = globalThis.fetch;
  if (!original || (original as any).__orkasFetchDiag) return;

  const wrapped: typeof fetch = async (input: any, init?: any) => {
    const url =
      typeof input === 'string' ? input :
      input?.url ? String(input.url) :
      String(input);
    // Only watch provider traffic. Skip everything else so dev-mode KB
    // model downloads etc. don't flood the log.
    if (!isProviderUrl(url)) return original(input, init);

    const t0 = Date.now();
    try {
      const res = await original(input, init);
      const dt = Date.now() - t0;
      if (!res.ok) {
        log.warn('provider fetch non-ok', {
          url: safeUrlAction(url),
          status: res.status,
          ms: dt,
        });
      } else {
        log.info('provider fetch ok', { url: safeUrlAction(url), status: res.status, ms: dt });
      }
      return res;
    } catch (err: any) {
      const dt = Date.now() - t0;
      const c1 = err?.cause;
      const c2 = c1?.cause;
      log.warn('provider fetch threw', {
        url: safeUrlAction(url),
        ms: dt,
        error: logErrorSummary(err),
        cause: logErrorSummary(c1),
        cause_cause: logErrorSummary(c2),
      });
      throw err;
    }
  };
  (wrapped as any).__orkasFetchDiag = true;
  globalThis.fetch = wrapped;
  log.info('installed', { mode: 'open_always' });
}
