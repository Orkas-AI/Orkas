import { isDeepStrictEqual } from 'node:util';

type InputDiagnostic = {
  stream_json: 'strict' | 'non_strict' | 'unobserved' | 'limit';
  tolerant_parse: 'used' | 'not_used' | 'unknown';
  parsed_input_matches?: boolean;
};

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
  private readonly pending = new Map<number, string | null>();
  private chars = 0;
  private calls = 0;
  constructor(private readonly concatenatedFinalInput: boolean) {}

  start(index: number): void {
    if (this.calls++ < 32) this.pending.set(index, '');
  }

  delta(index: number, delta: string): void {
    const current = this.pending.get(index);
    if (typeof current !== 'string') return;
    // Cumulative limits also bound CPU for a storm of completed/oversized calls.
    if (current.length + delta.length > 32_768 || this.chars + delta.length > 131_072) {
      this.pending.set(index, null);
      return;
    }
    this.chars += delta.length;
    this.pending.set(index, current + delta);
  }

  end(index: number, input: unknown): void {
    const raw = this.pending.get(index);
    this.pending.delete(index);
    if (!input || typeof input !== 'object') return;
    const diagnostic: InputDiagnostic = {
      stream_json: raw === null ? 'limit' : 'unobserved', tolerant_parse: 'unknown',
    };
    if (typeof raw === 'string' && raw.trim().length) {
      try {
        const parsed = JSON.parse(raw);
        diagnostic.stream_json = 'strict';
        diagnostic.parsed_input_matches = isDeepStrictEqual(parsed, input);
        if (this.concatenatedFinalInput && diagnostic.parsed_input_matches) {
          diagnostic.tolerant_parse = 'not_used';
        }
      } catch {
        diagnostic.stream_json = 'non_strict';
        if (this.concatenatedFinalInput) diagnostic.tolerant_parse = 'used';
      }
    }
    facts.set(input, Object.freeze(diagnostic));
  }
}
