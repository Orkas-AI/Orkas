import { createLogger } from '../logger';
import { logErrorRef } from './log-redact';

const log = createLogger('retry');

export const DEFAULT_NETWORK_RETRY_ATTEMPTS = 3;
export const DEFAULT_NETWORK_RETRY_DELAYS_MS = [500, 1_000, 2_000];

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface RetryOptions {
  retries?: number;
  delaysMs?: number[];
}

export interface FetchRetryOptions extends RetryOptions {
  /** Per-attempt wall-clock timeout. Omitted by default so large downloads can opt in deliberately. */
  timeoutMs?: number;
  timeoutMessage?: string;
  isRetriable?: (err: unknown) => boolean;
}

let fetchImplementation: FetchImplementation | null = null;

export function setFetchImplementation(impl: FetchImplementation | null): void {
  fetchImplementation = impl;
}

export class RetriableHttpStatusError extends Error {
  status: number;

  constructor(status: number, label = 'request') {
    super(`${label} http ${status}`);
    this.name = 'RetriableHttpStatusError';
    this.status = status;
  }
}

export function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryAsync<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOptions & {
    isRetriable?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? DEFAULT_NETWORK_RETRY_ATTEMPTS);
  const delaysMs = opts.delaysMs ?? DEFAULT_NETWORK_RETRY_DELAYS_MS;
  const isRetriable = opts.isRetriable ?? (() => true);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetriable(err)) throw err;
      const nextDelay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0;
      log.warn('request failed; retrying', {
        label,
        attempt: attempt + 1,
        retries,
        next_delay_ms: nextDelay,
        error: logErrorRef(err),
      });
      if (nextDelay > 0) await delay(nextDelay);
    }
  }
  throw lastErr;
}

function composeTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): { signal?: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: parent, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onAbort = () => {
    const reason = (parent as (AbortSignal & { reason?: unknown }) | undefined)?.reason;
    controller.abort(reason || new Error('operation aborted'));
  };
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener?.('abort', onAbort);
    },
    timedOut: () => didTimeout,
  };
}

export async function fetchWithRetry(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const { response } = await fetchAndReadWithRetry(
    label,
    input,
    init,
    async () => undefined,
    opts,
  );
  return response;
}

/** Keep the request timeout active until the caller has consumed the response body. */
export async function fetchAndReadWithRetry<T>(
  label: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  readBody: (response: Response, signal?: AbortSignal) => Promise<T>,
  opts: FetchRetryOptions = {},
): Promise<{ response: Response; body: T }> {
  return retryAsync(label, async () => {
    const timeoutMessage = opts.timeoutMessage || `${label} timed out after ${opts.timeoutMs}ms`;
    const composed = composeTimeoutSignal(init?.signal ?? undefined, opts.timeoutMs, timeoutMessage);
    try {
      const res = await (fetchImplementation || fetch)(input, { ...init, signal: composed.signal });
      if (isRetriableHttpStatus(res.status)) {
        throw new RetriableHttpStatusError(res.status, label);
      }
      return { response: res, body: await readBody(res, composed.signal) };
    } catch (err) {
      if (composed.timedOut()) throw new Error(timeoutMessage);
      throw err;
    } finally {
      composed.cleanup();
    }
  }, {
    retries: opts.retries,
    delaysMs: opts.delaysMs,
    isRetriable: opts.isRetriable,
  });
}
