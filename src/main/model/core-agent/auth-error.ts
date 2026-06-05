/**
 * Key-failure classification for the auto-rotation path.
 *
 * "Key failure" = a response the server rejected **because of this
 * specific credential**. Rotating to another key in the same
 * `(provider, model)` group has a chance of succeeding.
 *
 * Five kinds we recognize:
 *   - `auth`       → HTTP 401 / `authentication_error` / `invalid_api_key`
 *   - `permission` → HTTP 403 / `permission_error` / `plan_required` /
 *                    `subscription_expired` (key revoked, missing tier)
 *   - `rate_limit` → HTTP 429 / `rate_limit_error` / `too_many_requests`
 *                    / `quota_exceeded` (this key is rate-limited right now)
 *   - `balance`    → HTTP 402 / `insufficient_balance` / `insufficient_quota`
 *                    / `payment_required` (this account is out of money)
 *   - `network`    → ECONNRESET / ETIMEDOUT / ENOTFOUND / "fetch failed" /
 *                    "Client network socket disconnected before secure TLS"
 *                    (TCP/TLS reset. Rotating to a different provider can
 *                    help inside the current request, but we do NOT cooldown
 *                    network failures; the next user request starts from the
 *                    configured entries list again).
 *
 * **Not** key failures (return null — error propagates, no rotation):
 *   - 400 malformed request / invalid model param (config issue, same on any key)
 *   - content-policy / safety / content_filter (model will refuse again)
 *   - 5xx server_error (server issue, not key's fault)
 *
 * Signal flow:
 *   1. pi-ai SDK throws a raw `Error` with `status`/`message` (Anthropic /
 *      OpenAI SDK shapes).
 *   2. `pi-provider.ts::wrapError` maps some of these into core-agent's
 *      typed errors (`AuthError` / `RateLimitError` / `ContextOverflowError`
 *      / generic `ProviderError`). Status code is **not** always carried
 *      through — `wrapError` pattern-matches on message only for non-
 *      instanceof cases.
 *   3. `classifyKeyFailure` below checks both the typed instance AND a
 *      message-pattern fallback so we catch cases pi-ai dropped on the
 *      floor (notably 402 balance errors which pi-ai has no typed class
 *      for).
 *
 * The cause chain is walked up to depth 5 so we don't miss a wrapped
 * error whose outer message is generic.
 */

/**
 * Note on instanceof checks
 * ─────────────────────────
 * We deliberately **do not** use `err instanceof AuthError` etc here. pi-ai
 * is loaded through the ESM branch (dynamic `import('#core-agent')`) while
 * Orkas main is CJS — which causes `core-agent/src/shared/errors.js` to be
 * loaded **twice**, once per module system. Two class identities, so
 * `instanceof` silently returns false across the boundary. Every signal we
 * need lives in `err.status` / `err.message` / `err.cause.*` anyway, so we
 * rely on those exclusively.
 */

export type KeyFailureKind = 'auth' | 'permission' | 'rate_limit' | 'balance' | 'network';

// ─── Message patterns ────────────────────────────────────────────────────

const AUTH_RE =
  /invalid[_\s-]?api[_\s-]?key|incorrect[_\s-]?api[_\s-]?key|authentication[_\s-]?error|\bunauthorized\b|api[_\s-]?key[_\s-]?(invalid|incorrect|expired|missing|not[_\s-]?found|appears)|\bauth[_\s-]?failed\b|appears to be invalid|\bno[_\s-]?such[_\s-]?api[_\s-]?key\b|\bsk-[a-z0-9\-_]{4,}\b.*?(invalid|incorrect|expired)/i;

const PERM_RE =
  /permission[_\s-]?error|\bforbidden\b|plan[_\s-]?required|subscription[_\s-]?(expired|required|invalid|canceled)|access[_\s-]?denied/i;

const RATE_RE =
  /rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|quota[_\s-]?exceeded|requests[_\s-]?per[_\s-]?minute|throttled/i;

const BALANCE_RE =
  /insufficient[_\s-]?(balance|quota|credits|funds)|payment[_\s-]?required|balance[_\s-]?not[_\s-]?enough|余额不足|账户余额|out of credits|credit[_\s-]?exhausted/i;

// Explicit non-key failures — patterns that MUST NOT be classified as key
// failure even if they overlap the above (e.g. "invalid request" contains
// "invalid" which auth regex also picks up). Checked first.
const NON_KEY_RE =
  /content[_\s-]?policy|content[_\s-]?filter|safety[_\s-]?violation|content_filter|invalid[_\s-]?request[_\s-]?error|bad[_\s-]?request|model[_\s-]?not[_\s-]?found|context[_\s-]?(length|overflow|too[_\s-]?long)/i;

// Network-layer failures: TCP reset / TLS handshake aborted / DNS failure /
// generic fetch failure. These propagate up as `TypeError("fetch failed")`
// from undici with the real cause buried in `err.cause.code` (Node's net
// stack uses the `EXXX` convention).
const NETWORK_CODE_SET: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

const NETWORK_RE =
  /\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bECONNREFUSED\b|\bENETUNREACH\b|\bEAI_AGAIN\b|\bEPIPE\b|\bEHOSTUNREACH\b|socket\s*hang\s*up|socket[_\s-]?disconnected|network[_\s-]?socket[_\s-]?disconnected|Client\s+network\s+socket\s+disconnected\s+before\s+secure\s+TLS|fetch[_\s-]?failed|network[_\s-]?error|request[_\s-]?timed[_\s-]?out|connection[_\s-]?reset|getaddrinfo\s+(EAI_AGAIN|ENOTFOUND)|connect\s+ETIMEDOUT/i;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Aggregate error messages along the cause chain so we match against the
 * whole story, not just the outermost Error's `.message`. Depth-limited
 * to avoid runaway loops from circular causes.
 */
function collectMessages(err: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < maxDepth) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === 'string') {
      parts.push(cur);
      break;
    } else {
      break;
    }
    depth++;
  }
  return parts.join(' │ ');
}

/**
 * Read a `status` / `statusCode` / `http_status` number from anywhere in
 * the cause chain. Returns undefined if none found.
 */
function collectStatus(err: unknown, maxDepth = 5): number | undefined {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < maxDepth) {
    const s = (cur as { status?: unknown; statusCode?: unknown }) || {};
    if (typeof s.status === 'number') return s.status;
    if (typeof s.statusCode === 'number') return s.statusCode;
    if (cur instanceof Error) cur = (cur as { cause?: unknown }).cause;
    else break;
    depth++;
  }
  return undefined;
}

/** Walk the cause chain collecting any string `code` properties (Node's
 *  ECONNRESET / ETIMEDOUT etc. typically live on `err.cause.code` rather
 *  than the outer message). */
function collectCodes(err: unknown, maxDepth = 5): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < maxDepth) {
    const c = (cur as { code?: unknown })?.code;
    if (typeof c === 'string') codes.push(c);
    if (cur instanceof Error) cur = (cur as { cause?: unknown }).cause;
    else break;
    depth++;
  }
  return codes;
}

// ─── Classification ──────────────────────────────────────────────────────

/**
 * Classify a failure. Returns the kind for rotatable failures; null for
 * non-rotatable (malformed request, content policy, 5xx, timeout, etc.).
 */
export function classifyKeyFailure(err: unknown): KeyFailureKind | null {
  if (!err) return null;

  const msg = collectMessages(err);
  const status = collectStatus(err);

  // Explicit exclusion first — some "invalid" messages are request-side,
  // not key-side. Also covers context-overflow / timeout which carry
  // matching keywords in their messages (e.g. "context_length_exceeded",
  // "request timed out"), so we don't need instanceof checks for those.
  if (NON_KEY_RE.test(msg)) return null;

  // Status-code fast path (most reliable signal).
  if (status === 401) return 'auth';
  if (status === 403) return /rate|throttl|quota/i.test(msg) ? 'rate_limit' : 'permission';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'balance';

  // Message-pattern fallback. Order matters: balance BEFORE auth because
  // some "insufficient credits" messages mention "invalid" as side text.
  if (BALANCE_RE.test(msg)) return 'balance';
  if (RATE_RE.test(msg))    return 'rate_limit';
  if (PERM_RE.test(msg))    return 'permission';
  if (AUTH_RE.test(msg))    return 'auth';

  // Network-layer last — checked after auth-style classifications so a
  // "fetch failed" wrapping a 401 (rare but possible) still ends up as auth.
  // Two-pass: cause-chain `code` first (Node's reliable signal), then a
  // message regex for cases where the code didn't propagate.
  const codes = collectCodes(err);
  if (codes.some((c) => NETWORK_CODE_SET.has(c))) return 'network';
  if (NETWORK_RE.test(msg)) return 'network';

  return null;
}

/** Convenience: `classifyKeyFailure(err) !== null`. */
export function isKeyFailure(err: unknown): boolean {
  return classifyKeyFailure(err) !== null;
}

/**
 * One-line human-readable summary for logs / cooldown records. Keeps the
 * kind prefix + a trimmed message snippet. Does NOT leak api keys —
 * callers are responsible for the error payload being safe.
 */
export function formatKeyFailure(err: unknown): string {
  const kind = classifyKeyFailure(err);
  const msg  = collectMessages(err).slice(0, 200).replace(/\s+/g, ' ').trim();
  return kind ? `[${kind}] ${msg}` : msg;
}
