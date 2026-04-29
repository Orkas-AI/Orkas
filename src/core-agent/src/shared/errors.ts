/** Base error class for core-agent errors. */
export class CoreAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "CoreAgentError";
  }
}

export class AuthError extends CoreAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "AUTH_ERROR", cause);
    this.name = "AuthError";
  }
}

export class RateLimitError extends CoreAgentError {
  public readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number, cause?: Error) {
    super(message, "RATE_LIMIT", cause);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ContextOverflowError extends CoreAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "CONTEXT_OVERFLOW", cause);
    this.name = "ContextOverflowError";
  }
}

export class ProviderError extends CoreAgentError {
  public readonly provider: string;
  public readonly statusCode?: number;

  constructor(message: string, provider: string, statusCode?: number, cause?: Error) {
    super(message, "PROVIDER_ERROR", cause);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

export class TimeoutError extends CoreAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "TIMEOUT", cause);
    this.name = "TimeoutError";
  }
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof TimeoutError) return true;
  if (err instanceof ProviderError) {
    const code = err.statusCode;
    if (code === 429 || code === 500 || code === 502 || code === 503 || code === 529) return true;
    // Fall through to message/cause inspection — many network-layer failures
    // surface here as ProviderError with no statusCode.
  }
  if (isTransientNetworkError(err)) return true;
  return false;
}

/**
 * Detect transient network / stream failures that warrant a retry:
 *   - undici SSE body cutoff: `TypeError { message: "terminated", cause: SocketError }`
 *   - Node fetch front-door: `TypeError { message: "fetch failed", cause: ... }`
 *   - Raw socket codes: ECONNRESET / ETIMEDOUT / ECONNREFUSED / ENETDOWN / EPIPE / EAI_AGAIN
 *   - undici named codes: UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT
 *
 * Matches both `err.message` and the cause chain (depth-limited) because
 * pi-ai / pi-provider may have already wrapped the original error, losing
 * the instanceof relationship but preserving the string.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const MSG_RE = /\bterminated\b|\bfetch failed\b|socket hang up|network.?(error|failure)/i;
  const CODE_RE = /^(UND_ERR_|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETDOWN|ENETUNREACH|EPIPE|EAI_AGAIN)/i;

  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      if (MSG_RE.test(cur.message || "")) return true;
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && CODE_RE.test(code)) return true;
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === "string") {
      return MSG_RE.test(cur);
    } else {
      break;
    }
    depth++;
  }
  return false;
}
