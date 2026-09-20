/** Custom Chat Completions wire compatibility. Never inspect model prose or
 * replay an accepted HTTP response. Learned fields are process-local only. */
import { createHash } from 'node:crypto';
import { createLogger } from '../../logger';

const log = createLogger('custom-output-limit');
type Field = 'max_tokens' | 'max_completion_tokens';
const FIELDS: readonly Field[] = ['max_tokens', 'max_completion_tokens'];
const CACHE_LIMIT = 128;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_BYTES = 16 * 1024;
const ERROR_READ_MS = 2000;
const learned = new Map<string, { field: Field; expires: number; version: number }>();
let version = 0;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function limitField(body: Record<string, unknown>): Field | undefined {
  const present = FIELDS.filter(field => Object.hasOwn(body, field));
  if (present.length !== 1) return undefined;
  const field = present[0];
  return Number.isSafeInteger(body[field]) && Number(body[field]) > 0 ? field : undefined;
}
function swap(body: Record<string, unknown>, from: Field, to: Field): Record<string, unknown> {
  const next = { ...body, [to]: body[from] };
  delete next[from];
  return next;
}

/** Inspect only a bounded clone of a JSON rejection. A slow/malformed body
 * remains the SDK's original response; inspection cannot extend indefinitely. */
async function unsupportedField(response: Response, field: Field, signal?: AbortSignal | null): Promise<boolean> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')
    || Number(response.headers.get('content-length')) > ERROR_BYTES || signal?.aborted) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<undefined>(resolve => {
    stop = () => resolve(undefined);
    timer = setTimeout(stop, ERROR_READ_MS);
    signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), stopped]);
      if (!part) return false;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > ERROR_BYTES) return false;
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return record(parsed) && record(parsed.error)
      && parsed.error.code === 'unsupported_parameter' && parsed.error.param === field;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    // Awaiting cancellation of a tee branch can wait for the original SDK
    // branch to finish. It has not been handed to the SDK yet.
    void reader.cancel().catch(() => {});
  }
}

export function createCustomOutputLimitCompatibility(config: {
  apiKey: string; baseUrl: string; contextWindow: number; maxTokens: number;
  supportsReasoning?: boolean; supportsVision?: boolean; reasoningEffort?: string;
}) {
  // Retain no credentials or endpoint strings in the bounded shared cache.
  const identity = createHash('sha256').update(JSON.stringify([
    config.apiKey, config.baseUrl, config.contextWindow, config.maxTokens,
    config.supportsReasoning, config.supportsVision, config.reasoningEffort,
  ])).digest('hex');
  const keyFor = (body: Record<string, unknown>) => typeof body.model === 'string'
    ? createHash('sha256').update(identity).update('\0').update(body.model).digest('hex') : undefined;
  const get = (key: string) => {
    const entry = learned.get(key);
    if (entry && entry.expires <= Date.now()) { learned.delete(key); return undefined; }
    return entry;
  };
  return {
    onPayload(payload: unknown): unknown {
      if (!record(payload)) return payload;
      const field = limitField(payload);
      const key = keyFor(payload);
      const cached = key ? get(key) : undefined;
      return field && cached && cached.field !== field ? swap(payload, field, cached.field) : payload;
    },
    wrapFetch(next: typeof globalThis.fetch): typeof globalThis.fetch {
      return async (input, init) => {
        const startedVersion = version;
        const response = await next(input, init);
        if (response.status !== 400 || init?.signal?.aborted || init?.method?.toUpperCase() !== 'POST'
          || typeof init.body !== 'string') return response;
        let body: unknown;
        try { body = JSON.parse(init.body); } catch { return response; }
        if (!record(body)) return response;
        const field = limitField(body);
        const key = keyFor(body);
        if (!field || !key || !await unsupportedField(response, field, init.signal) || init.signal?.aborted) return response;
        const cached = get(key);
        if (cached?.field === field && cached.version <= startedVersion) learned.delete(key);
        const alternate: Field = field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
        const headers = new Headers(init.headers);
        headers.delete('content-length');
        // HTTP 400 is still private to this adapter. No generation or tool
        // event from this request has reached the SDK/runner.
        void response.body?.cancel().catch(() => {});
        const retried = await next(input, { ...init, headers, body: JSON.stringify(swap(body, field, alternate)) });
        if (retried.ok && !init.signal?.aborted && (get(key)?.version ?? 0) <= startedVersion) {
          if (learned.size >= CACHE_LIMIT && !learned.has(key)) learned.delete(learned.keys().next().value!);
          learned.set(key, { field: alternate, expires: Date.now() + CACHE_TTL_MS, version: ++version });
        }
        try { log.info('output limit field negotiation', { field: alternate, accepted: retried.ok }); } catch { /* Best-effort diagnostics. */ }
        return retried;
      };
    },
  };
}
