/** Credential/account failures use structured status/code evidence only.
 * Transport failures retain their existing recovery policy. The shared facts
 * reader follows SDK cause chains and machine error envelopes;
 * incidental prose must never cool down a credential or assert an account cause.
 */

import { isProviderSafetyError } from '../../../core-agent/src/shared/errors';
import { providerCredentialFailure, providerErrorFacts } from '../../../core-agent/src/shared/provider-error-facts';

export type KeyFailureKind = 'auth' | 'permission' | 'rate_limit' | 'balance' | 'network';

// Network-layer failures: TCP reset / TLS handshake aborted / DNS failure /
// generic fetch failure. These propagate up as `TypeError("fetch failed")`
// from undici with the real cause buried in `err.cause.code` (Node's net
// stack uses the `EXXX` convention).
const NETWORK_CODE_SET: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Aggregate display diagnostics along the cause chain, never for classification. Depth-limited
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
    } else if (typeof cur === 'object') {
      const rec = cur as { message?: unknown; error?: unknown; cause?: unknown };
      if (typeof rec.message === 'string' && rec.message) parts.push(rec.message);
      if (typeof rec.error === 'string' && rec.error) parts.push(rec.error);
      cur = rec.cause;
    } else {
      break;
    }
    depth++;
  }
  return parts.join(' │ ');
}

// ─── Classification ──────────────────────────────────────────────────────

/**
 * Classify a failure. Returns the kind for rotatable failures; null for
 * non-rotatable (malformed request, content policy, 5xx, timeout, etc.).
 */
export function classifyKeyFailure(err: unknown): KeyFailureKind | null {
  if (!err) return null;

  // A provider safety decision belongs to the selected provider's response,
  // never to a credential. Keep this ahead of incidental balance/auth words
  // so rotation cannot bypass a structured safety code.
  if (isProviderSafetyError(err)) return null;

  const credentialKind = providerCredentialFailure(err, false);
  if (credentialKind) return credentialKind;
  const { status, codes } = providerErrorFacts(err, false);
  if (status !== undefined) return null;

  // Network-layer last — checked after auth-style classifications so a
  // "fetch failed" wrapping a 401 (rare but possible) still ends up as auth.
  // Only cause-chain machine codes establish a network failure.
  if (codes.some((c) => NETWORK_CODE_SET.has(c))) return 'network';

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
