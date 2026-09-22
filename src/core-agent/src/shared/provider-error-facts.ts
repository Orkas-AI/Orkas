/** Structured provider error evidence shared by transport, routing and display.
 * Free-form error prose is never a credential/account classification signal. */
export type ProviderCredentialFailure = 'auth' | 'permission' | 'rate_limit' | 'balance';

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

export function providerErrorFacts(error: unknown): { status?: number; codes: string[] } {
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
    if (typeof message !== 'string' || message.length > 65_536) return;
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
    readStatus(rec.status);
    readStatus(rec.statusCode);
    readStatus(rec.http_status);
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

export function providerCredentialFailure(error: unknown): ProviderCredentialFailure | null {
  const { status, codes } = providerErrorFacts(error);
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
