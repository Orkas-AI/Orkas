/** Metadata only: this observer never changes errors used by retry policy. */
export interface ProviderRequestFailure {
  phase: 'unknown' | 'before_request' | 'before_response' | 'after_response';
  code: string;
  httpStatus?: number;
  elapsedMs: number;
  aborted: boolean;
  source: ProviderFailureSource;
  lastEvent: string;
  requestSequence?: number;
}

export type ProviderFailureSource = 'unknown' | 'payload' | 'transport' | 'http' | 'sdk_error' | 'exception';
const STREAM_EVENTS = new Set(['start', 'text_start', 'text_delta', 'text_end',
  'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
// The host supplies one observer per run, shared by retries and auxiliary calls.
// Weak ownership retains no sessions, request bodies or unbounded attempt arrays.
const requestSequences = new WeakMap<(failure: ProviderRequestFailure) => void, number>();

const DIAGNOSTIC_CODES = new Set([
  'EPERM', 'EACCES',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function safeCode(error: unknown): string {
  // Bound traversal even for cyclic causes. Never inspect messages or bodies.
  try {
    for (let depth = 0; error && typeof error === 'object' && depth < 8; depth++) {
      const item = error as { code?: unknown; cause?: unknown };
      if (typeof item.code === 'string' && DIAGNOSTIC_CODES.has(item.code)) return item.code;
      if (error instanceof ReferenceError) return 'REFERENCE_ERROR';
      error = item.cause;
    }
  } catch { /* Untrusted exception accessors are not diagnostic facts. */ }
  return 'unknown';
}

/** Request-local hooks supported by pi-ai. Observe headers without cloning,
 * buffering or wrapping the response body; post-header SDK-flattened causes
 * remain unknown instead of being guessed from prose. */
export function createRequestDiagnostics(
  signal?: AbortSignal,
  onFailure?: (failure: ProviderRequestFailure) => void,
) {
  const started = performance.now();
  const requestSequence = onFailure ? Math.min(1_000_000_000, (requestSequences.get(onFailure) ?? 0) + 1) : undefined;
  if (onFailure && requestSequence !== undefined) requestSequences.set(onFailure, requestSequence);
  let source: ProviderFailureSource = 'unknown';
  let lastEvent = 'none';
  let phase: ProviderRequestFailure['phase'] = 'unknown';
  let status: number | undefined;
  let code = 'unknown';
  let reported = false;
  let observed = false;
  const onResponse = (response: { status: number }) => {
    phase = 'after_response';
    status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : undefined;
  };
  const requestFetch: typeof globalThis.fetch = async (input, init) => {
    phase = 'before_response';
    status = undefined;
    code = 'unknown';
    source = 'unknown';
    try {
      const response = await globalThis.fetch(input, init);
      onResponse(response);
      return response;
    } catch (error) {
      code = safeCode(error);
      source = 'transport';
      throw error;
    }
  };
  return {
    get observed(): boolean { return observed; },
    onResponse,
    requestFetch,
    observeEvent(type: string): void {
      // Retain the event preceding failure, not the generic terminal error.
      if (type !== 'error') lastEvent = STREAM_EVENTS.has(type) ? type : 'unknown';
    },
    async observePayload<T>(operation: () => T | Promise<T>): Promise<T> {
      try { return await operation(); }
      catch (error) {
        // The host hook failed before this SDK invocation could send a request.
        // Store only closed metadata; rethrow the same error for the SDK policy.
        phase = 'before_request';
        source = 'payload';
        status = undefined;
        code = safeCode(error);
        throw error;
      }
    },
    report(error: unknown, aborted = false, boundary: ProviderFailureSource = 'unknown'): ProviderRequestFailure | undefined {
      if (reported) return undefined;
      reported = true;
      const failure: ProviderRequestFailure = {
        phase,
        source: source !== 'unknown' ? source : status !== undefined && status >= 400 ? 'http' : boundary,
        lastEvent,
        ...(requestSequence === undefined ? {} : { requestSequence }),
        code: code === 'unknown' ? safeCode(error) : code,
        ...(status === undefined ? {} : { httpStatus: status }),
        elapsedMs: Math.min(1_000_000_000, Math.max(0, Math.round(performance.now() - started))),
        aborted: aborted || signal?.aborted === true,
      };
      try { if (onFailure) { onFailure({ ...failure }); observed = true; } } catch { /* Best-effort observer. */ }
      return failure;
    },
  };
}
