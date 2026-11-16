import { isDeepStrictEqual } from 'node:util';

type InputDiagnostic = {
  stream_json: 'strict' | 'non_strict' | 'unobserved' | 'limit';
  tolerant_parse: 'used' | 'not_used' | 'unknown';
  parsed_input_matches?: boolean;
  stream_chars?: number;
  stream_chunks?: number;
  json_root?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'invalid_json' | 'unobserved' | 'limit';
};

export type ToolArgumentsFailure = {
  version: 1;
  code: 'tool_arguments_invalid';
  api: string;
  stop_reason: string;
  stream_json: InputDiagnostic['stream_json'];
  json_root: NonNullable<InputDiagnostic['json_root']>;
  stream_chars?: number;
  stream_chunks?: number;
};

/** Content-free facts only. Complete calls have no observed argument stream. */
export function toolArgumentsFailure(input: unknown, api: string, stopReason: string): ToolArgumentsFailure {
  const observed = toolInputDiagnostic(input);
  return {
    version: 1, code: 'tool_arguments_invalid',
    api: ['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages',
      'google-generative-ai', 'google-vertex', 'google-gemini-cli', 'bedrock-converse-stream'].includes(api) ? api : 'unknown',
    stop_reason: ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(stopReason) ? stopReason : 'unknown',
    stream_json: observed?.stream_json ?? 'unobserved', json_root: observed?.json_root ?? 'unobserved',
    ...(observed?.stream_chars === undefined ? {} : { stream_chars: observed.stream_chars, stream_chunks: observed.stream_chunks }),
  };
}

// Facts follow the executed input by identity. They never become model input,
// durable history, raw logs, or an alternative parser/execution decision.
const facts = new WeakMap<object, Readonly<InputDiagnostic>>();
export function toolInputDiagnostic(input: unknown): Readonly<InputDiagnostic> | undefined {
  return input && typeof input === 'object' ? facts.get(input) : undefined;
}

/** Observe only bounded SDK deltas, once per completed call. Completions uses
 * their concatenation as its final JSON input. Other transports may replace it
 * in a terminal snapshot, so their parser provenance remains unknown. */
export class ToolInputDiagnostics {
  private readonly pending = new Map<number, { raw: string | null; chars: number; chunks: number }>();
  private chars = 0;
  private calls = 0;
  constructor(private readonly concatenatedFinalInput: boolean) {}

  start(index: number): void {
    if (this.calls++ < 32) this.pending.set(index, { raw: '', chars: 0, chunks: 0 });
  }

  delta(index: number, delta: string): void {
    const current = this.pending.get(index);
    if (!current) return;
    current.chars = Math.min(1_000_000_000, current.chars + delta.length);
    current.chunks = Math.min(1_000_000_000, current.chunks + 1);
    if (current.raw === null) return;
    // Cumulative limits also bound CPU for a storm of completed/oversized calls.
    if (current.raw.length + delta.length > 32_768 || this.chars + delta.length > 131_072) {
      current.raw = null;
      return;
    }
    this.chars += delta.length;
    current.raw += delta;
  }

  end(index: number, input: unknown): void {
    const pending = this.pending.get(index);
    const raw = pending?.raw;
    this.pending.delete(index);
    if (!input || typeof input !== 'object') return;
    const diagnostic: InputDiagnostic = {
      stream_json: raw === null ? 'limit' : 'unobserved', tolerant_parse: 'unknown',
      json_root: raw === null ? 'limit' : 'unobserved',
      ...(pending ? { stream_chars: pending.chars, stream_chunks: pending.chunks } : {}),
    };
    if (typeof raw === 'string' && raw.trim().length) {
      try {
        const parsed = JSON.parse(raw);
        diagnostic.stream_json = 'strict';
        diagnostic.json_root = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed as 'object' | 'string' | 'number' | 'boolean';
        diagnostic.parsed_input_matches = isDeepStrictEqual(parsed, input);
        if (this.concatenatedFinalInput && diagnostic.parsed_input_matches) {
          diagnostic.tolerant_parse = 'not_used';
        }
      } catch {
        diagnostic.stream_json = 'non_strict';
        diagnostic.json_root = 'invalid_json';
        if (this.concatenatedFinalInput) diagnostic.tolerant_parse = 'used';
      }
    }
    facts.set(input, Object.freeze(diagnostic));
  }
}
