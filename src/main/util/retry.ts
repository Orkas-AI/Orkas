import { createLogger } from '../logger';
import { logErrorRef } from './log-redact';

const log = createLogger('retry');

export const DEFAULT_NETWORK_RETRY_ATTEMPTS = 3;
export const DEFAULT_NETWORK_RETRY_DELAYS_MS = [500, 1_000, 2_000];

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  opts: {
    retries?: number;
    delaysMs?: number[];
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

export async function fetchWithRetry(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: {
    retries?: number;
    delaysMs?: number[];
  } = {},
): Promise<Response> {
  return retryAsync(label, async () => {
    const res = await (fetchImplementation || fetch)(input, init);
    if (isRetriableHttpStatus(res.status)) {
      throw new RetriableHttpStatusError(res.status, label);
    }
    return res;
  }, opts);
}
