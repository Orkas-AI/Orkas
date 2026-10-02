import { describe, expect, it } from 'vitest';
import { terminalOutputSnapshot } from '../../../src/main/util/terminal-output-diagnostics';

describe('last-response output evidence', () => {
  it.each([
    [false, 0, 0, 0, 'unterminated'],
    [true, 0, 0, 0, 'empty'],
    [true, 0, 188, 0, 'reasoning_only'],
    [true, 5, 188, 0, 'text'],
    [true, 5, 188, 1, 'tool_calls'],
  ])('classifies observed boundaries (%s, %s, %s, %s)', (seen, text, thinking, tools, kind) => {
    expect(terminalOutputSnapshot({ version: 1, provider_terminal_seen: seen,
      provider_text_chars: text, provider_thinking_chars: thinking, provider_tool_calls: tools,
    }).output_kind).toBe(kind);
  });
  it('keeps missing evidence unknown and rejects private or malformed fields', () => {
    expect(terminalOutputSnapshot(undefined)).toEqual({ version: 1, output_kind: 'unknown' });
    expect(terminalOutputSnapshot({ version: 1, provider_terminal_seen: true }).output_kind).toBe('unknown');
    expect(terminalOutputSnapshot({ version: 1, output_kind: 'reasoning_only',
      provider_stop_reason: 'PRIVATE', provider_text_chars: NaN, provider_thinking_chars: -1,
      provider_tool_calls: true, runner_text_chars: 'PRIVATE', mapped_text_chars: 0, text: 'PRIVATE',
    })).toEqual({ version: 1, output_kind: 'unknown', mapped_text_chars: 0 });
    expect(terminalOutputSnapshot({ version: 1, runner_text_chars: 2e9, mapped_text_chars: Infinity }))
      .toEqual({ version: 1, output_kind: 'unknown', runner_text_chars: 1e9 });
  });
});
