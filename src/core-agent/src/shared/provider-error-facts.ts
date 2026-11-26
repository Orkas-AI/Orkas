/** Structured provider error evidence shared by transport, routing and display.
 * Free-form error prose is never a credential/account classification signal. */
export type ProviderCredentialFailure = 'auth' | 'permission' | 'rate_limit' | 'balance';

/** Adapter-owned rejection evidence, distinct from a local payload/transport
 * exception that happens to carry an HTTP-looking status. */
export function providerRequestWasRejected(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const record = current as Record<string, unknown>;
    if (record.providerRequestRejected === true) return true;
    current = record.cause ?? record.error;
  }
  return false;
}

const CODE_KINDS: Readonly<Record<string, ProviderCredentialFailure>> = Object.freeze({
  auth_error: 'auth', authentication_error: 'auth', invalid_api_key: 'auth',
  token_invalidated: 'auth', invalid_token: 'auth', unauthorized: 'auth',
  oauth_token_invalid: 'auth', oauth_token_invalidated: 'auth',
  oauth_token_expired: 'auth', oauth_token_revoked: 'auth',
  provider_auth: 'auth', provider_auth_exhausted: 'auth',
  permission_error: 'permission', permission_denied: 'permission', forbidden: 'permission',
  access_denied: 'permission', plan_required: 'permission', subscription_expired: 'permission',
  subscription_required: 'permission', modelnotopen: 'permission',
  provider_permission: 'permission', provider_permission_exhausted: 'permission',
  rate_limit: 'rate_limit', rate_limit_error: 'rate_limit', rate_limit_exceeded: 'rate_limit',
  too_many_requests: 'rate_limit', usage_limit_reached: 'rate_limit',
  provider_rate_limit: 'rate_limit', provider_rate_limit_exhausted: 'rate_limit',
  insufficient_balance: 'balance', insufficient_quota: 'balance', insufficient_credits: 'balance',
  insufficient_funds: 'balance', payment_required: 'balance', credit_exhausted: 'balance',
  provider_balance: 'balance', provider_balance_exhausted: 'balance',
  orkas_llm_quota_exceeded: 'balance', orkas_points_quota_exceeded: 'balance',
  orkas_credits_quota_exceeded: 'balance',
});

/** Runtime callers disable legacy message decoding. It remains available for
 * display of old saved errors, never as a source of retry/account decisions. */
export function providerErrorFacts(error: unknown, includeSerializedMessages = true): { status?: number; codes: string[] } {
  let status: number | undefined;
  const codes: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const readStatus = (value: unknown) => {
    if (status === undefined && typeof value === 'number'
      && Number.isInteger(value) && value >= 400 && value <= 599) status = value;
  };
  // Bound both wrapper traversal and serialized payload parsing on failure storms.
  const readSerialized = (message: unknown) => {
    if (!includeSerializedMessages || typeof message !== 'string' || message.length > 65_536) return;
    const text = message.trim();
    const prefix = /^(?:HTTP\s+)?([45]\d\d)(?::\s*|\s+)(\{[\s\S]*\})$/.exec(text)
      || /^OpenAI API error \(([45]\d\d)\):\s*(\{[\s\S]*\})$/.exec(text);
    const body = prefix ? prefix[2] : text;
    if (!body.startsWith('{') || !body.endsWith('}')) return;
    try {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (prefix) readStatus(Number(prefix[1]));
      pending.push(value);
    } catch { /* Malformed or quoted examples are not structured evidence. */ }
  };
  for (let count = 0; pending.length && count < 12; count++) {
    const current = pending.shift();
    if (typeof current === 'string') { readSerialized(current); continue; }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (rec.name === 'AbortError') codes.push('ABORT_ERR');
    readStatus(rec.status);
    readStatus(rec.statusCode);
    readStatus(rec.http_status);
    readStatus(rec.httpStatus);
    // Some API error envelopes use a numeric HTTP code instead of status.
    readStatus(rec.code);
    for (const field of ['code', 'type']) {
      if (typeof rec[field] === 'string' && rec[field].length <= 128) codes.push(rec[field]);
    }
    readSerialized(rec.message);
    if (rec.cause) pending.push(rec.cause);
    if (rec.error && typeof rec.error === 'object') pending.push(rec.error);
  }
  return { status, codes };
}

export function providerCredentialFailure(error: unknown, includeSerializedMessages = true): ProviderCredentialFailure | null {
  const { status, codes } = providerErrorFacts(error, includeSerializedMessages);
  if (status === 402) return 'balance';
  const kinds = new Set(codes.map((code) => {
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(CODE_KINDS, key) ? CODE_KINDS[key] : undefined;
  }).filter((kind): kind is ProviderCredentialFailure => kind !== undefined));
  // A generic rate wrapper may enclose the provider's explicit balance code.
  if (kinds.has('balance') && [...kinds].every((kind) => kind === 'balance' || kind === 'rate_limit')) return 'balance';
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size > 1) return null;
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  return null;
}

/** Case-insensitive header lookup supporting both WHATWG `Headers` (what
 * undici / newer SDK errors expose) and the plain record shape older
 * OpenAI/Anthropic SDK `APIError.headers` used. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    try {
      const v = (headers as { get: (n: string) => unknown }).get(name);
      if (typeof v === "string" && v) return v;
    } catch { /* fall through to record scan */ }
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === lower && typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Milliseconds the provider asked us to wait before retrying a 429, or
 * undefined when no parsable hint exists (the runner then keeps its default
 * backoff). The value is returned as given, with no upper bound: the runner
 * honours it only when recovering a stream cut off by a rate limit, and gives
 * up instead of waiting once the recovery's total wait would pass its cap.
 *
 * SDK-level errors (OpenAI/Anthropic `APIError`, undici response errors)
 * expose the failing response's headers as `.headers` or `.response.headers`;
 * pi-ai rethrows them unwrapped or one `cause` level deep, so we walk a short
 * chain. Recognized forms: `retry-after-ms` (milliseconds, OpenAI extension)
 * and `retry-after` (delta-seconds or an HTTP-date per RFC 9110). */
export function providerRetryAfterMs(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const rec = cur as Record<string, unknown>;
    for (const field of ['retryAfterMs', 'retry_after_ms']) {
      const value = rec[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
    }
    const headers = rec.headers
      ?? (rec.response && typeof rec.response === "object"
        ? (rec.response as Record<string, unknown>).headers
        : undefined);

    const rawMs = headerValue(headers, "retry-after-ms");
    if (rawMs !== undefined) {
      const ms = Number(rawMs);
      if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
    }
    const raw = headerValue(headers, "retry-after");
    if (raw !== undefined) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds)) {
        // Numeric → delta-seconds form; a negative value is malformed and
        // must NOT fall through to Date.parse (V8 parses "-5" as a date).
        if (seconds >= 0) return Math.ceil(seconds * 1000);
      } else {
        const dateMs = Date.parse(raw);
        if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
      }
    }
    cur = rec.cause ?? rec.error;
  }
  return undefined;
}
