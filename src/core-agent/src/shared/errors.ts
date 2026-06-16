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

export type RetryableErrorKind =
  | "rate_limit"
  | "timeout"
  | "connection_dropped"
  | "service_unavailable"
  | "server_error"
  | "network";

const RETRYABLE_PROVIDER_STATUS = new Set([
  408, // request timeout
  409, // conflict / transient write race on some gateways
  425, // too early
  429,
  500,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
  529,
  598,
  599,
]);

const TRANSIENT_CODE_RE =
  /^(UND_ERR_|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETDOWN|ENETUNREACH|EPIPE|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE)/i;

const TRANSIENT_MESSAGE_PATTERNS: Array<[RetryableErrorKind, RegExp]> = [
  ["service_unavailable", /\b(502|503|504|520|521|522|523|524|529|598|599)\b|bad gateway|service unavailable|gateway timeout|overloaded|upstream.?connect|connection.?refused/i],
  ["timeout", /\bcodex sse response headers timed out after \d+ms\b|\bsse response headers timed out\b|\bresponse headers? (timed out|timeout)\b|\bheaders? (timed out|timeout)\b|\brequest timed out\b|\btimed out\b|\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/i],
  ["connection_dropped", /\bterminated\b|\bfetch failed\b|socket (hang up|closed|close)|websocket (error|closed|close)|\bws (error|closed|close)\b|connection (closed|close|reset|dropped|terminated)|stream (closed|close|interrupted|disconnected|reset|terminated)|premature close|err_stream_premature_close|\b(read )?(econnreset|epipe)\b|\bund_err_socket\b/i],
  ["network", /network.?(error|failure)|enetunreach|enetdown|eai_again|econnrefused/i],
  ["rate_limit", /rate.?limit|too many requests|\b429\b/i],
  ["server_error", /\b500\b|internal server error/i],
];

const NON_RETRYABLE_BALANCE_RE =
  /orkas_(llm|points)_quota_exceeded|insufficient[_\s-]?(balance|quota|credits|funds)|payment[_\s-]?required|balance[_\s-]?not[_\s-]?enough|余额不足|账户余额|积分不足|out of credits|credit[_\s-]?exhausted/i;

function retryKindForProviderStatus(statusCode: number | undefined): RetryableErrorKind | null {
  if (!statusCode || !RETRYABLE_PROVIDER_STATUS.has(statusCode)) return null;
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || statusCode === 524 || statusCode === 598 || statusCode === 599) return "timeout";
  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 520 || statusCode === 521 || statusCode === 522 || statusCode === 523 || statusCode === 529) {
    return "service_unavailable";
  }
  return "server_error";
}

function retryKindForMessage(message: string): RetryableErrorKind | null {
  for (const [kind, pattern] of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return null;
}

function errorMessageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "";
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.message === "string") return rec.message;
    if (typeof rec.error === "string") return rec.error;
  }
  return "";
}

function errorCodeOf(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const rec = err as Record<string, unknown>;
  return typeof rec.code === "string" ? rec.code : "";
}

function errorCauseOf(err: unknown): unknown {
  if (!err || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  if ("cause" in rec) return rec.cause;
  if (rec.error && typeof rec.error === "object") return rec.error;
  return null;
}

function hasNonRetryableBalanceSignal(err: unknown): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const msg = errorMessageOf(cur);
    if (msg && NON_RETRYABLE_BALANCE_RE.test(msg)) return true;
    const code = errorCodeOf(cur);
    if (code && NON_RETRYABLE_BALANCE_RE.test(code)) return true;
    cur = errorCauseOf(cur);
    depth++;
  }
  return false;
}

export function classifyTransientNetworkError(err: unknown): RetryableErrorKind | null {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const msg = errorMessageOf(cur);
    if (msg) {
      const kind = retryKindForMessage(msg);
      if (kind) return kind;
    }
    const code = errorCodeOf(cur);
    if (code && TRANSIENT_CODE_RE.test(code)) {
      if (/TIMEOUT/i.test(code)) return "timeout";
      if (/ECONNREFUSED|ENETUNREACH|ENETDOWN|EAI_AGAIN/i.test(code)) return "network";
      return "connection_dropped";
    }
    cur = errorCauseOf(cur);
    depth++;
  }
  return null;
}

export function classifyRetryableError(err: unknown): RetryableErrorKind | null {
  if (hasNonRetryableBalanceSignal(err)) return null;
  if (err instanceof RateLimitError) return "rate_limit";
  if (err instanceof TimeoutError) return "timeout";
  if (err instanceof ProviderError) {
    const statusKind = retryKindForProviderStatus(err.statusCode);
    if (statusKind) return statusKind;
    // Fall through to message/cause inspection — many network-layer failures
    // surface here as ProviderError with no statusCode.
  }
  return classifyTransientNetworkError(err);
}

export function isRetryableError(err: unknown): boolean {
  return classifyRetryableError(err) !== null;
}

/**
 * Detect transient network / stream failures that warrant a retry:
 *   - slow first-byte / response-header waits: "Codex SSE response headers timed out after 10000ms"
 *   - undici SSE body cutoff: `TypeError { message: "terminated", cause: SocketError }`
 *   - Node fetch front-door: `TypeError { message: "fetch failed", cause: ... }`
 *   - WebSocket stream drops surfaced by hosted/OAuth transports as a bare
 *     "WebSocket error" / close marker
 *   - Provider/SDK stream-close variants: "connection closed", "stream
 *     disconnected", "ERR_STREAM_PREMATURE_CLOSE", "read ECONNRESET"
 *   - Raw socket codes: ECONNRESET / ETIMEDOUT / ECONNREFUSED / ENETDOWN / EPIPE / EAI_AGAIN
 *   - undici named codes: UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT
 *
 * Matches both `err.message` and the cause chain (depth-limited) because
 * pi-ai / pi-provider may have already wrapped the original error, losing
 * the instanceof relationship but preserving the string.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return classifyTransientNetworkError(err) !== null;
}
