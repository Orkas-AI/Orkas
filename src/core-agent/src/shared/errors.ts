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

export class OutputLimitError extends CoreAgentError {
  constructor(message: string, cause?: Error) {
    super(message, "OUTPUT_LIMIT", cause);
    this.name = "OutputLimitError";
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

export interface RetryErrorPolicyConfig {
  permanent_statuses: number[];
  permanent_message_patterns: string[];
  permanent_code_patterns: string[];
}

const TRANSIENT_PROVIDER_STATUS_FOR_REASON = new Set([
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

const DEFAULT_PERMANENT_PROVIDER_STATUS = [
  400, // bad request / malformed payload
  401,
  402,
  403,
  404,
  405,
  406,
  410,
  411,
  413,
  414,
  415,
  422,
] as const;

const TRANSIENT_CODE_RE =
  /^(UND_ERR_|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETDOWN|ENETUNREACH|EPIPE|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE)/i;

const TRANSIENT_MESSAGE_REASON_PATTERNS: Array<[RetryableErrorKind, RegExp]> = [
  [
    "service_unavailable",
    /\b(502|503|504|520|521|522|523|524|529|598|599)\b|bad gateway|service unavailable|gateway timeout|overloaded|upstream.?connect|connection.?refused/i,
  ],
  [
    "timeout",
    /\bcodex sse response headers timed out after \d+ms\b|\bsse response headers timed out\b|\bresponse headers? (timed out|timeout)\b|\bheaders? (timed out|timeout)\b|\brequest timed out\b|\btimed out\b|\btimeout\b|etimedout|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/i,
  ],
  [
    "connection_dropped",
    /\bterminated\b|\bfetch failed\b|stream ended without finish_reason|missing finish_reason|without finish_reason|missing final (chunk|event)|without final (chunk|event)|socket (hang up|closed|close)|websocket (error|closed|close)|\bws (error|closed|close)\b|connection (closed|close|reset|dropped|terminated)|stream (closed|close|interrupted|disconnected|reset|terminated)|premature close|err_stream_premature_close|\b(read )?(econnreset|epipe)\b|\bund_err_socket\b/i,
  ],
  [
    "network",
    /network.?(error|failure)|enetunreach|enetdown|eai_again|econnrefused/i,
  ],
  [
    "rate_limit",
    /rate.?limit|too many requests|\b429\b/i,
  ],
  [
    "server_error",
    /\b500\b|internal server error/i,
  ],
];

const DEFAULT_PERMANENT_MESSAGE_PATTERNS = [
  /^(?:http\s*)?(?:400|401|402|403|404|405|406|410|411|413|414|415|422)\b|messages?\s+with\s+role\s+['"]?tool['"]?\s+must\s+be\s+a\s+response\s+to\s+a\s+preceding\s+message\s+with\s+['"]?tool_calls/i.source,
  /orkas_(llm|points|credits)_quota_exceeded|insufficient[_\s-]?(balance|quota|credits|funds)|payment[_\s-]?required|balance[_\s-]?not[_\s-]?enough|余额不足|账户余额|积分不足|out of credits|credit[_\s-]?exhausted/i.source,
  /invalid[_\s-]?api[_\s-]?key|incorrect[_\s-]?api[_\s-]?key|authentication[_\s-]?error|\bunauthorized\b|\bforbidden\b|permission[_\s-]?denied|permission[_\s-]?error|access[_\s-]?denied|not[_\s-]?logged[_\s-]?in|sign[_\s-]?in required|session expired|invalid[_\s-]?request(?:[_\s-]?error)?|bad[_\s-]?request|invalid[_\s-]?(argument|parameter|schema|tool)|schema[_\s-]?(validation|error|mismatch)|unsupported[_\s-]?model|model[_\s-]?not[_\s-]?found|no model found|context[_\s-]?(length|overflow|too[_\s-]?long)|prompt (is )?too long|request (entity )?too large|content[_\s-]?policy|content[_\s-]?filter|safety[_\s-]?(violation|policy)|blocked by policy|user (abort|aborted|cancelled|canceled|declined|denied)|request (?:was )?(abort|aborted|cancelled|canceled)|operation (?:was )?(abort|aborted|cancelled|canceled)|aborted by user|abort[_\s-]?error|cancel(?:led|ed)|confirmation required|permission required|tool execution access|path outside|e_path_out_of_scope/i.source,
];

const DEFAULT_PERMANENT_CODE_PATTERNS = [
  /^(AUTH_ERROR|CONTEXT_OVERFLOW|OUTPUT_LIMIT|ABORT_ERR|ERR_ABORTED|ERR_CANCELED|ERR_CANCELLED|ERR_INVALID_|INVALID_REQUEST|INVALID_ARGUMENT|INVALID_SCHEMA|CONTENT_POLICY|CONTENT_FILTER|SAFETY|MODEL_NOT_FOUND|UNSUPPORTED_MODEL|E_PATH_OUT_OF_SCOPE)/i.source,
];

export const DEFAULT_RETRY_ERROR_POLICY: RetryErrorPolicyConfig = Object.freeze({
  permanent_statuses: [...DEFAULT_PERMANENT_PROVIDER_STATUS],
  permanent_message_patterns: [...DEFAULT_PERMANENT_MESSAGE_PATTERNS],
  permanent_code_patterns: [...DEFAULT_PERMANENT_CODE_PATTERNS],
});

interface CompiledRetryErrorPolicy {
  config: RetryErrorPolicyConfig;
  permanentProviderStatus: Set<number>;
  permanentMessagePatterns: RegExp[];
  permanentCodePatterns: RegExp[];
}

function retryKindForProviderStatus(statusCode: number | undefined): RetryableErrorKind | null {
  if (!statusCode || !TRANSIENT_PROVIDER_STATUS_FOR_REASON.has(statusCode)) return null;
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || statusCode === 524 || statusCode === 598 || statusCode === 599) return "timeout";
  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 520 || statusCode === 521 || statusCode === 522 || statusCode === 523 || statusCode === 529) {
    return "service_unavailable";
  }
  return "server_error";
}

function cloneRetryErrorPolicyConfig(config: RetryErrorPolicyConfig): RetryErrorPolicyConfig {
  return {
    permanent_statuses: [...config.permanent_statuses],
    permanent_message_patterns: [...config.permanent_message_patterns],
    permanent_code_patterns: [...config.permanent_code_patterns],
  };
}

function normalizePatternList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function normalizeStatusList(value: unknown, fallback: readonly number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(n) || n < 100 || n > 599 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeRetryErrorPolicyConfig(config?: Partial<RetryErrorPolicyConfig> | null): RetryErrorPolicyConfig {
  const raw = config && typeof config === "object" ? config : {};
  return {
    permanent_statuses: normalizeStatusList(raw.permanent_statuses, DEFAULT_RETRY_ERROR_POLICY.permanent_statuses),
    permanent_message_patterns: normalizePatternList(raw.permanent_message_patterns, DEFAULT_RETRY_ERROR_POLICY.permanent_message_patterns),
    permanent_code_patterns: normalizePatternList(raw.permanent_code_patterns, DEFAULT_RETRY_ERROR_POLICY.permanent_code_patterns),
  };
}

function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

function compileRetryErrorPolicy(config?: Partial<RetryErrorPolicyConfig> | null): CompiledRetryErrorPolicy {
  const normalized = normalizeRetryErrorPolicyConfig(config);
  return {
    config: normalized,
    permanentProviderStatus: new Set(normalized.permanent_statuses),
    permanentMessagePatterns: normalized.permanent_message_patterns.map(compilePattern).filter(Boolean) as RegExp[],
    permanentCodePatterns: normalized.permanent_code_patterns.map(compilePattern).filter(Boolean) as RegExp[],
  };
}

let activeRetryErrorPolicy = compileRetryErrorPolicy(DEFAULT_RETRY_ERROR_POLICY);

export function configureRetryErrorPolicy(config?: Partial<RetryErrorPolicyConfig> | null): void {
  activeRetryErrorPolicy = compileRetryErrorPolicy(config ?? DEFAULT_RETRY_ERROR_POLICY);
}

export function getRetryErrorPolicy(): RetryErrorPolicyConfig {
  return cloneRetryErrorPolicyConfig(activeRetryErrorPolicy.config);
}

function isPermanentProviderStatus(policy: CompiledRetryErrorPolicy, statusCode: number | undefined, includeRequestStatus: boolean): boolean {
  if (!statusCode) return false;
  if (statusCode === 400) return includeRequestStatus && policy.permanentProviderStatus.has(statusCode);
  return policy.permanentProviderStatus.has(statusCode);
}

function retryKindForMessage(message: string): RetryableErrorKind | null {
  for (const [kind, pattern] of TRANSIENT_MESSAGE_REASON_PATTERNS) {
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

function errorStatusOf(err: unknown): number | undefined {
  if (err instanceof ProviderError) return err.statusCode;
  if (!err || typeof err !== "object") return undefined;
  const rec = err as Record<string, unknown>;
  const raw = rec.statusCode ?? rec.status ?? rec.httpStatus ?? rec.http_status;
  const status = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(status) ? status : undefined;
}

function errorCauseOf(err: unknown): unknown {
  if (!err || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  if ("cause" in rec) return rec.cause;
  if (rec.error && typeof rec.error === "object") return rec.error;
  return null;
}

function retryKindForStatusChain(err: unknown): RetryableErrorKind | null {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const statusKind = retryKindForProviderStatus(errorStatusOf(cur));
    if (statusKind) return statusKind;
    cur = errorCauseOf(cur);
    depth++;
  }
  return null;
}

function hasPermanentFailureSignal(policy: CompiledRetryErrorPolicy, err: unknown, includeRequestStatus: boolean): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const status = errorStatusOf(cur);
    if (isPermanentProviderStatus(policy, status, includeRequestStatus)) return true;

    const msg = errorMessageOf(cur);
    if (msg && policy.permanentMessagePatterns.some((pattern) => pattern.test(msg))) return true;

    const code = errorCodeOf(cur);
    if (code && policy.permanentCodePatterns.some((pattern) => pattern.test(code))) return true;

    cur = errorCauseOf(cur);
    depth++;
  }
  return false;
}

export function classifyTransientNetworkError(err: unknown): RetryableErrorKind | null {
  return classifyTransientNetworkErrorWithPolicy(err);
}

export function classifyTransientNetworkErrorWithPolicy(
  err: unknown,
  _config?: Partial<RetryErrorPolicyConfig> | null,
): RetryableErrorKind | null {
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
  return classifyRetryableErrorWithPolicy(err, activeRetryErrorPolicy.config);
}

export function classifyRetryableErrorWithPolicy(
  err: unknown,
  config?: Partial<RetryErrorPolicyConfig> | null,
): RetryableErrorKind | null {
  const policy = config ? compileRetryErrorPolicy(config) : activeRetryErrorPolicy;
  if (err == null) return null;
  if (err instanceof AuthError || err instanceof ContextOverflowError || err instanceof OutputLimitError) return null;

  // Hard permanent signals should win even if a wrapper adds generic text
  // like "fetch failed" outside the real provider error.
  if (hasPermanentFailureSignal(policy, err, false)) return null;

  const transientKind = classifyTransientNetworkError(err);
  if (transientKind) return transientKind;

  const statusKind = retryKindForStatusChain(err);
  if (statusKind) return statusKind;

  if (hasPermanentFailureSignal(policy, err, true)) return null;

  if (err instanceof RateLimitError) return "rate_limit";
  if (err instanceof TimeoutError) return "timeout";

  // Default to retrying unknown model/provider/runtime failures. The
  // blacklist above guards deterministic failures; abrupt termination is
  // worse than a possible duplicate partial response.
  return "network";
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
