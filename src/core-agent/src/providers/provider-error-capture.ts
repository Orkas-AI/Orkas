import { providerErrorFacts, providerRetryAfterMs } from '../shared/provider-error-facts.js';
import { responsesRejectedInput, type ResponsesRejectedInput } from './responses-status-diagnostics.js';

function rejectionHasOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [record, record.response].some(envelope => {
    if (!envelope || typeof envelope !== 'object') return false;
    const body = envelope as Record<string, unknown>;
    return [body.output, body.choices].some(output =>
      Array.isArray(output) ? output.length > 0 : !!output);
  });
}

/** pi-ai flattens SDK errors into display strings. Retain request-local facts
 * before that boundary. Never retain bodies in diagnostics or shared state. */
export function createProviderErrorCapture(streamProtocol?: 'openai-responses' | 'openai-completions', onStreamError?: (error: object) => void) {
  let original: unknown;
  let responseFacts: Error | undefined;
  let rejectedInput: ResponsesRejectedInput | undefined;
  let owner: object;
  return {
    get rejectedInputIndex(): number | undefined { return rejectedInput?.index; },
    get rejectedInput(): ResponsesRejectedInput | undefined { return rejectedInput; },
    rethrow(error: unknown): never {
      original = error;
      throw error;
    },
    wrapFetch(next: typeof globalThis.fetch): typeof globalThis.fetch {
      return async (input, init) => {
        const requestOwner = owner = {};
        original = undefined;
        responseFacts = undefined;
        rejectedInput = undefined;
        try {
          const response = await next(input, init);
          if (response.status >= 400) {
            responseFacts = Object.assign(new Error('Provider HTTP error'), { status: response.status, retryAfterMs: providerRetryAfterMs({ headers: response.headers }), providerRequestRejected: true });
            const detail = await readErrorBody(response, init?.signal, input => { rejectedInput = input; });
            if (detail) Object.assign(responseFacts, { error: detail });
          } else if (streamProtocol && response.body && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
            return observeStreamErrors(response, streamProtocol, error => {
              if (owner !== requestOwner) return;
              try { onStreamError?.(error); } catch { /* Diagnostics cannot replace delivery. */ }
              const facts = providerErrorFacts(error, false);
              if (facts.status === undefined && !facts.codes.length) return;
              let cause: object = {};
              for (const code of facts.codes.reverse()) cause = { code, cause };
              responseFacts = Object.assign(new Error('Provider stream error'), { status: facts.status, cause, retryAfterMs: providerRetryAfterMs(error) ?? providerRetryAfterMs({ headers: response.headers }), providerRequestRejected: true });
            }, error => {
              // Fetch has already resolved here; retain body-read causes before
              // SDK flattening without replacing an earlier protocol rejection.
              if (owner === requestOwner && !responseFacts) original = error;
            });
          }
          return response;
        } catch (error) {
          original = error;
          throw error;
        }
      };
    },
    cause(sdkErrorMessage?: string): Error | undefined {
      if (original instanceof Error) return original;
      if (original && typeof original === 'object') return Object.assign(new Error('Provider transport error'), { cause: original });
      if (responseFacts) return responseFacts;
      // Legacy adapters without custom fetch expose complete serialized API
      // envelopes only. Decode their machine fields at this adapter boundary;
      // arbitrary prose, partial JSON and nested message strings are not facts.
      const facts = serializedSdkFacts(sdkErrorMessage);
      if (facts.status === undefined && !facts.codes.length) return undefined;
      let cause: Error | undefined;
      for (const code of facts.codes.reverse()) cause = Object.assign(new Error('Provider error'), { code, cause });
      return Object.assign(new Error('Provider error'), { status: facts.status, cause, providerRequestRejected: true });
    },
  };
}

/** Bounded inspection of rejected HTTP JSON. */
async function readErrorBody(response: Response, signal?: AbortSignal | null, observeInput?: (input: ResponsesRejectedInput) => void): Promise<object | undefined> {
  const limit = 16 * 1024;
  if (signal?.aborted || !response.headers.get('content-type')?.toLowerCase().includes('application/json')
    || Number(response.headers.get('content-length')) > limit) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try { reader = response.clone().body?.getReader(); } catch { return; }
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const stopped = new Promise<undefined>(resolve => {
    stop = () => resolve(undefined);
    timer = setTimeout(stop, 2000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), stopped]);
      if (!part) return;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) return;
      chunks.push(part.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Only structured fields leave this function; error prose cannot become a
    // nested serialized envelope and cannot override the actual HTTP status.
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    const param = error && typeof error === 'object' ? (error as { param?: unknown }).param : undefined;
    const rejected = responsesRejectedInput(param);
    if (rejected) observeInput?.(rejected);
    const { codes } = providerErrorFacts(body, false);
    if (rejectionHasOutput(body)) codes.push('PROVIDER_OUTPUT_UNCERTAIN');
    let detail: object = { retryAfterMs: providerRetryAfterMs(body) };
    for (const code of codes.reverse()) detail = { code, cause: detail };
    return detail;
  } catch { return; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    void reader.cancel().catch(() => {});
  }
}

/** Observe protocol error envelopes before the SDK flattens them. One reader,
 * unchanged bytes/backpressure, no tee or prefetch. The SDK still owns parsing
 * model output and terminal/cancellation behavior. Oversized frames are unknown. */
function observeStreamErrors(response: Response, protocol: 'openai-responses' | 'openai-completions', observe: (error: object) => void, observeReadFailure: (error: unknown) => void): Response {
  const limit = 16 * 1024;
  const reader = response.body!.getReader();
  const frame = new Uint8Array(limit);
  const decoder = new TextDecoder();
  let size = 0, lineHasData = false, dropped = false, afterCR = false, terminal = false;
  const dispatch = () => {
    if (dropped || terminal) return;
    let event = '';
    const data: string[] = [];
    for (const line of decoder.decode(frame.subarray(0, size)).split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
      else if (line.startsWith('event:')) event = line.slice(line[6] === ' ' ? 7 : 6);
    }
    if (!data.length || (event && event !== 'error' && event !== 'response.failed')) return;
    try {
      const value: unknown = JSON.parse(data.join('\n'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      let error: unknown;
      if (protocol === 'openai-responses' && record.type === 'error') error = record;
      else if (protocol === 'openai-responses' && record.type === 'response.failed') {
        error = (record.response as { error?: unknown } | undefined)?.error;
      } else if (protocol === 'openai-completions') error = record.error;
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        terminal = true;
        observe(rejectionHasOutput(record)
          ? { code: 'PROVIDER_OUTPUT_UNCERTAIN', error } : error);
      }
    } catch { /* Invalid or incomplete protocol envelopes provide no facts. */ }
  };
  const inspect = (bytes: Uint8Array) => {
    // Scan bytes without decoding/copying an unbounded transport chunk. The
    // bounded observer never consumes prose nested inside ordinary model output.
    for (let i = 0; i < bytes.length && !terminal; i++) {
      const byte = bytes[i];
      if (byte === 10 && afterCR) { afterCR = false; continue; }
      afterCR = byte === 13;
      if (byte === 13 || byte === 10) {
        if (!lineHasData) {
          dispatch(); size = 0; dropped = false;
        } else if (size < limit) frame[size++] = 10;
        else dropped = true;
        lineHasData = false;
      } else {
        lineHasData = true;
        if (size < limit) frame[size++] = byte;
        else dropped = true;
      }
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read().catch(error => { observeReadFailure(error); throw error; });
        if (part.done) { controller.close(); reader.releaseLock(); return; }
        inspect(part.value);
        controller.enqueue(part.value);
      } catch (error) { controller.error(error); reader.releaseLock(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const name of ['url', 'redirected', 'type'] as const) Object.defineProperty(observed, name, { value: response[name] });
  return observed;
}

/** Decode one complete SDK protocol envelope, never JSON inside its message. */
function serializedSdkFacts(message?: string): { status?: number; codes: string[] } {
  if (!message || message.length > 65_536) return { codes: [] };
  const text = message.trim();
  const prefix = /^(?:HTTP\s+)?([45]\d\d)(?::\s*|\s+)(\{[\s\S]*\})$/.exec(text)
    || /^OpenAI API error \(([45]\d\d)\):\s*(\{[\s\S]*\})$/.exec(text);
  try {
    const body: unknown = JSON.parse(prefix ? prefix[2] : text);
    const facts = providerErrorFacts(body, false);
    if (rejectionHasOutput(body)) facts.codes.push('PROVIDER_OUTPUT_UNCERTAIN');
    return { ...facts, status: prefix ? Number(prefix[1]) : facts.status };
  } catch { return { codes: [] }; }
}
