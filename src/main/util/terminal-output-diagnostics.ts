/** Last-response metadata only. Missing observations must never become zeros. */
export type TerminalOutput = {
  version: 1;
  output_kind: string;
  provider_terminal_seen?: boolean;
  provider_stop_reason?: string;
  provider_text_chars?: number;
  provider_thinking_chars?: number;
  provider_tool_calls?: number;
  runner_text_chars?: number;
  mapped_text_chars?: number;
};

export const OUTPUT_KINDS = new Set(['text', 'reasoning_only', 'tool_calls', 'empty', 'unterminated', 'unknown']);
const STOP_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'unknown']);

export function terminalOutputSnapshot(value: unknown): TerminalOutput {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const out: TerminalOutput = { version: 1, output_kind: 'unknown' };
  if (raw.version !== 1) return out;
  if (typeof raw.provider_terminal_seen === 'boolean') out.provider_terminal_seen = raw.provider_terminal_seen;
  if (typeof raw.provider_stop_reason === 'string' && STOP_REASONS.has(raw.provider_stop_reason)) {
    out.provider_stop_reason = raw.provider_stop_reason;
  }
  for (const key of ['provider_text_chars', 'provider_thinking_chars', 'provider_tool_calls', 'runner_text_chars', 'mapped_text_chars'] as const) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[key] = Math.min(n, 1_000_000_000);
  }
  if (out.provider_terminal_seen === false) out.output_kind = 'unterminated';
  else if (out.provider_terminal_seen === true) {
    if ((out.provider_tool_calls ?? 0) > 0) out.output_kind = 'tool_calls';
    else if ((out.provider_text_chars ?? 0) > 0) out.output_kind = 'text';
    else if (out.provider_tool_calls === 0 && out.provider_text_chars === 0) {
      if ((out.provider_thinking_chars ?? 0) > 0) out.output_kind = 'reasoning_only';
      else if (out.provider_thinking_chars === 0) out.output_kind = 'empty';
    }
  }
  return out;
}
