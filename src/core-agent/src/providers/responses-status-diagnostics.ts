/** Closed protocol observations only. No history mutation, new persistence or
 * response-body reader. Origins live only as long as the host's run observer. */
import type { ProviderRequestFailure } from './request-diagnostics.js';

type ModelKey = { api: string; provider: string; id: string };
type Row = Record<string, string | number | boolean>;
type Origin = { status: string; response: string; sequence: number; ref?: string; model: ModelKey; ambiguous?: boolean };
const origins = new WeakMap<object, Map<string, Origin>>();
const STATES = new Set(['completed', 'in_progress', 'incomplete', 'failed', 'cancelled', 'queued']);
const KINDS = new Set(['reasoning', 'message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'additional_tools']);
const APIS = new Set(['openai-responses', 'azure-openai-responses', 'openai-codex-responses']);
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : undefined;
function status(value: unknown, present = true): string {
  return !present ? 'missing' : value === null ? 'null' : typeof value !== 'string'
    ? 'invalid_type' : STATES.has(value) ? value : 'other_string';
}
function id(item: Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256 ? item.id : undefined;
}

export function createResponsesStatusDiagnostics(
  owner: ((failure: ProviderRequestFailure) => void) | undefined,
  model: ModelKey,
  sequence: number | undefined,
  requestRef: unknown,
) {
  if (!owner || !APIS.has(model.api)) return undefined;
  let source = origins.get(owner);
  if (!source) { source = new Map(); origins.set(owner, source); }
  const records = source;
  const history = new Map<string, string>();
  const duplicates = new Set<string>();
  let payload: Record<string, unknown> | undefined;
  // The request already owns its payload until completion. Retain only its
  // array reference locally; on failure inspect the exact rejected item by
  // index, plus at most 48 prefix items. Nothing enters cross-request state.
  return {
    history(item: unknown): void {
      try {
        const row = object(item);
        if (!row || row.type !== 'reasoning') return;
        const key = id(row);
        if (!key || (!history.has(key) && history.size >= 256)) return;
        if (history.has(key)) duplicates.add(key);
        history.set(key, status(row.status, 'status' in row));
      } catch { /* Diagnostics cannot alter replay. */ }
    },
    payload(value: unknown): void { payload = object(value); },
    output(content: readonly unknown[], responseStatus: unknown): void {
      let chars = 0;
      try {
        for (const value of content.slice(0, 16)) {
          const block = object(value);
          const signature = block?.thinkingSignature;
          if (block?.type !== 'thinking' || typeof signature !== 'string') continue;
          if (signature.length > 65536 || (chars += signature.length) > 262144) continue;
          let item: Record<string, unknown> | undefined;
          try { item = object(JSON.parse(signature)); } catch { continue; }
          if (!item || item.type !== 'reasoning') continue;
          const key = id(item);
          if (!key) continue;
          const previous = records.get(key);
          if (previous && previous.sequence !== sequence) {
            previous.ambiguous = true;
            continue;
          }
          if (!previous && records.size >= 256) records.delete(records.keys().next().value!);
          records.set(key, { status: status(item.status, 'status' in item), response: status(responseStatus, responseStatus !== undefined),
            sequence: sequence ?? 0, model: { api: model.api, provider: model.provider, id: model.id },
            ...(typeof requestRef === 'string' && /^(?:[a-f0-9]{12}|[a-f0-9]{32})$/.test(requestRef) ? { ref: requestRef } : {}) });
        }
      } catch { /* Metadata never changes the response result. */ }
    },
    failure(rejectedIndex?: number): Record<string, unknown> | undefined {
      try {
        const input = payload?.input;
        if (!Array.isArray(input)) return undefined;
        const indices: number[] = [];
        if (rejectedIndex !== undefined && Number.isInteger(rejectedIndex) && rejectedIndex >= 0 && rejectedIndex < input.length) indices.push(rejectedIndex);
        for (let i = 0; i < Math.min(input.length, 48) && indices.length < 4; i++) {
          if (object(input[i])?.type === 'reasoning' && !indices.includes(i)) indices.push(i);
        }
        const rows: Row[] = indices.map(i => {
          const item = object(input[i]) ?? {};
          const key = item.type === 'reasoning' ? id(item) : undefined;
          const origin = key ? records.get(key) : undefined;
          const row: Row = { i, kind: typeof item.type === 'string' && KINDS.has(item.type) ? item.type : 'other',
            wire_status: status(item.status, 'status' in item),
            history_status: key && duplicates.has(key) ? 'ambiguous' : key ? history.get(key) ?? 'unobserved' : 'unobserved',
            origin: !origin ? 'unobserved' : origin.ambiguous ? 'ambiguous' : 'observed' };
          if (origin && !origin.ambiguous) {
            Object.assign(row, { source_status: origin.status, source_response_status: origin.response,
              source_sequence: origin.sequence,
              same_model: origin.model.api === model.api && origin.model.provider === model.provider && origin.model.id === model.id,
              ...(origin.ref ? { source_request_ref: origin.ref } : {}) });
          }
          return row;
        });
        return { version: 1, input_count: input.length, prefix_limit: 48,
          ...(rejectedIndex === undefined ? {} : { rejected_index: rejectedIndex }), rows };
      } catch { return undefined; }
    },
  };
}
