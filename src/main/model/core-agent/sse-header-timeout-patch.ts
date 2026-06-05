/**
 * Ignore provider-local SSE response-header aborts.
 *
 * pi-ai's SSE transport owns a short "wait for response headers" AbortController
 * that can fire before a long-running model produces its first event. Orkas has
 * its own user-abort and idle-watchdog signals around the whole turn; those must
 * still work. This patch only suppresses aborts whose reason is the provider's
 * SSE header-timeout marker.
 */
import { createLogger } from '../../logger';

const log = createLogger('sse-header-timeout-patch');
const PATCHED = Symbol.for('orkas.sseHeaderTimeoutAbortPatch');
const SSE_HEADER_TIMEOUT_RE =
  /\bsse response headers timed out(?: after \d+ms)?\b/i;

type PatchedAbort = AbortController['abort'] & { [PATCHED]?: true };

export function isSseHeaderTimeoutAbortReason(reason: unknown): boolean {
  if (!reason) return false;
  const message = reason instanceof Error ? reason.message : String(reason);
  return SSE_HEADER_TIMEOUT_RE.test(message);
}

export function installSseHeaderTimeoutPatch(): void {
  const ctor = globalThis.AbortController;
  const proto = ctor?.prototype as (AbortController & { abort: PatchedAbort }) | undefined;
  if (!proto || typeof proto.abort !== 'function') return;
  if ((proto.abort as PatchedAbort)[PATCHED]) return;

  const originalAbort = proto.abort;
  const patchedAbort: PatchedAbort = function patchedAbort(this: AbortController, reason?: unknown): void {
    if (isSseHeaderTimeoutAbortReason(reason)) {
      log.info('ignored provider SSE response-header timeout abort; waiting for stream or Orkas watchdog');
      return;
    }
    return originalAbort.call(this, reason);
  };
  patchedAbort[PATCHED] = true;

  Object.defineProperty(proto, 'abort', {
    value: patchedAbort,
    writable: true,
    configurable: true,
  });
  log.info('installed SSE response-header timeout abort patch');
}
