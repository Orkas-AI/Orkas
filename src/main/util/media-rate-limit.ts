import { fetchAndReadWithTimeout, throwIfAborted } from './abort';
import { RetriableHttpStatusError } from './retry';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';

// Rejection recovery only: no network/ordinary 5xx/accepted-body replay.
export const MEDIA_LIMIT_RETRIES = 3;
const MAX_ERROR_BYTES = 16 * 1024;
const LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests',
  'concurrency_limit_exceeded', 'concurrent_limit_exceeded', 'RateLimitExceeded',
  'TooManyRequests', 'Throttling', 'ThrottlingException', 'rate_limited']);
const limitCodes = new WeakMap<Response, string>();
const log = createLogger('media-rate-limit');
type MediaOperation = 'media' | 'image' | 'video' | 'tts';

/** Keep speech retries ten seconds apart until the operation deadline, while
 * preserving a longer provider Retry-After as the minimum wait. */
export function mediaLimitRetryDelay(attempt: number, retryAfterMs: number, operation: MediaOperation = 'media'): number {
  const floor = operation === 'tts' ? 10_000
    : Math.min(8_000, 1_000 * 2 ** attempt);
  return Math.max(retryAfterMs, floor);
}

// Only classified codes enter diagnostics. Provider suffixes can contain private data.
function diagnosticCode(code: unknown): string {
  return typeof code === 'string' && LIMIT_CODES.has(code) ? code
    : typeof code === 'string' && code.startsWith('RateLimitExceeded.') ? 'RateLimitExceeded.*' : 'http_429';
}

export function mediaRateLimitCode(response: Response): string {
  return limitCodes.get(response) ?? 'http_429';
}

/** Private diagnostic records, at most three waits and one result per limited call.
 * Speech may keep waiting beyond three retries; the terminal record aggregates all.
 * No additional body reads, timers, telemetry events or ordinary-success records.
 */
export function mediaLimitDiagnostics(operation: MediaOperation) {
  const started = Date.now();
  let requestRef: string | undefined;
  let status = 0, lastLimitStatus = 0, code = '', plannedWait = 0, waitMs = 0, retries = 0;
  const emit = (fields: Record<string, string | number>) => {
    // Diagnostic delivery must never change the request's result or replay policy.
    try { log.warn('media_rate_limit', { operation, request_ref: requestRef, code,
      status, last_limit_status: lastLimitStatus, retry_count: retries,
      ...(operation === 'tts' ? { retry_bound: 'deadline' } : { max_retries: MEDIA_LIMIT_RETRIES }),
      wait_ms: waitMs, elapsed_ms: Math.max(0, Date.now() - started), planned_wait_ms: plannedWait, ...fields }); } catch { /* Best effort. */ }
  };
  return {
    attempt(value: number) { retries = value; status = 0; },
    response(value: number) { status = value; },
    rejected(httpStatus: number, knownCode: string, delay: number) {
      requestRef ??= randomUUID();
      status = lastLimitStatus = httpStatus; code = knownCode; plannedWait = delay;
    },
    async wait(attempt: number, retryAfter: number, signal?: AbortSignal) {
      if (operation !== 'tts' || attempt < 3) emit({ event: 'wait', retry: attempt + 1 });
      const before = Date.now();
      try { await waitForMediaLimit(attempt, retryAfter, signal, operation === 'tts'); }
      finally { waitMs += Math.max(0, Date.now() - before); }
    },
    finish(outcome: 'response_received' | 'recovered' | 'http_error' | 'retry_exhausted' | 'budget_exhausted' | 'cancelled' | 'owner_changed' | 'failed', finalStatus?: number) {
      if (!requestRef) return;
      if (finalStatus !== undefined) status = finalStatus;
      emit({ event: 'result', outcome });
      requestRef = undefined;
    },
  };
}

function limitEnvelope(data: any): boolean {
  if (!data || typeof data !== 'object' || data.id || data.task_id || data.data || data.output || data.audio) return false;
  const error = data.error && typeof data.error === 'object' ? data.error : data;
  const code = error.code ?? data.detail?.status ?? error.type;
  return code === undefined || (typeof code === 'string'
    && (LIMIT_CODES.has(code) || code.startsWith('RateLimitExceeded.')));
}

/** Inspect HTTP limits and known pre-admission queue refusals; never classify prose. */
export async function mediaRateLimitDelay(response: Response, signal?: AbortSignal, preAdmissionCodes: readonly string[] = []): Promise<number | null> {
  if (response.status !== 429 && response.status !== 503) return null;
  const copy = response.clone();
  const reader = copy.body?.getReader();
  let timer: NodeJS.Timeout | undefined;
  let abort!: () => void;
  try {
    const inspected = (async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ERROR_BYTES) return false;
        chunks.push(value);
      }
      if (!bytes) return response.status === 429;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.status === 503) {
          const limited = ['image_queue_full', 'video_queue_full', ...preAdmissionCodes].includes(data?.error?.code)
            && !data?.id && !data?.task_id && !data?.data;
          if (limited) limitCodes.set(response, 'pre_admission_busy');
          return limited;
        }
        const limited = limitEnvelope(data);
        if (limited) {
          const error = data.error && typeof data.error === 'object' ? data.error : data;
          limitCodes.set(response, diagnosticCode(error.code ?? data.detail?.status ?? error.type));
        }
        return limited;
      }
      catch { return false; }
    })();
    const interrupted = new Promise<false>(resolve => {
      abort = () => resolve(false);
      timer = setTimeout(abort, 2_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (!await Promise.race([inspected, interrupted])) return null;
    const hint = new RetriableHttpStatusError(429, 'media', response.headers.get('retry-after')).retryAfterMs;
    return hint ?? 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    void reader?.cancel().catch(() => {});
  }
}

export async function waitForMediaLimit(attempt: number, retryAfterMs: number, signal?: AbortSignal, exactDelay = false): Promise<void> {
  throwIfAborted(signal);
  const delay = exactDelay ? retryAfterMs : mediaLimitRetryDelay(attempt, retryAfterMs);
  // Long Retry-After values retain exact minimum semantics without Node timer overflow.
  let remaining = delay;
  while (remaining > 0) {
    const slice = Math.min(remaining, 60_000);
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, slice);
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('operation aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    remaining -= slice;
  }
}

/** Same request/body/idempotency key, bounded by the caller's existing IO budget. */
export async function fetchMediaAndRead<T>(
  input: Parameters<typeof fetch>[0], init: RequestInit, timeoutMs: number,
  signal: AbortSignal | undefined | null, timeoutMessage: string,
  readBody: (response: Response) => Promise<T>,
  preAdmissionCodes: readonly string[] = [],
  operation: MediaOperation = 'media',
): Promise<{ response: Response; body: T }> {
  const deadline = performance.now() + timeoutMs;
  const diagnostics = mediaLimitDiagnostics(operation);
  let budgetExhausted = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { budgetExhausted = true; throw new Error(timeoutMessage); }
      diagnostics.attempt(attempt);
      const result = await fetchAndReadWithTimeout(input, init, remaining, signal,
        timeoutMessage, async response => {
          diagnostics.response(response.status);
          const retryAfter = operation === 'tts' || attempt < MEDIA_LIMIT_RETRIES ? await mediaRateLimitDelay(response, signal ?? undefined, preAdmissionCodes) : null;
          const planned = retryAfter === null ? 0 : mediaLimitRetryDelay(attempt, retryAfter, operation);
          const remaining = Math.max(0, deadline - performance.now());
          const waitMs = operation === 'tts' ? Math.min(planned, remaining) : planned;
          if (retryAfter !== null) diagnostics.rejected(response.status, mediaRateLimitCode(response), waitMs);
          if (retryAfter !== null && (operation === 'tts' || waitMs < remaining)) {
            void response.body?.cancel().catch(() => {});
            return { retryAfter: waitMs } as const;
          }
          if (retryAfter !== null) budgetExhausted = true;
          return { value: await readBody(response) } as const;
        });
      if ('value' in result.body) {
        diagnostics.finish(budgetExhausted ? 'budget_exhausted' : result.response.ok ? 'response_received' : 'http_error', result.response.status);
        return { response: result.response, body: result.body.value };
      }
      await diagnostics.wait(attempt, result.body.retryAfter, signal ?? undefined);
    }
  } catch (error) {
    diagnostics.finish(signal?.aborted ? 'cancelled' : budgetExhausted ? 'budget_exhausted' : 'failed');
    throw error;
  }
}
