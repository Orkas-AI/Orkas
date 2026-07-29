import { describe, expect, it } from 'vitest';
import {
  appendPhasedText,
  commentaryForTerminalReplacement,
  createPhasedTextState,
  resolvedPhasedText,
} from '../../../../src/main/features/local_agents/text-phase';

describe('local_agents/text-phase', () => {
  it('finalizes commentary exactly once when final_answer begins', () => {
    const state = createPhasedTextState();
    expect(appendPhasedText(state, 'Inspecting ', 'commentary')).toEqual({ phase: 'commentary' });
    expect(appendPhasedText(state, 'the code.', 'commentary')).toEqual({ phase: 'commentary' });
    expect(appendPhasedText(state, 'Done', 'final_answer')).toEqual({
      phase: 'final_answer',
      commentaryToFinalize: 'Inspecting the code.',
    });
    expect(appendPhasedText(state, '.', 'final_answer')).toEqual({ phase: 'final_answer' });
    expect(resolvedPhasedText(state)).toBe('Done.');
  });

  it('keeps commentary as partial output when no final answer arrives', () => {
    const state = createPhasedTextState();
    appendPhasedText(state, 'Still working', 'commentary');
    expect(resolvedPhasedText(state)).toBe('Still working');
  });

  it('preserves the legacy concatenation for unphased CLIs', () => {
    const state = createPhasedTextState();
    appendPhasedText(state, 'one ', undefined);
    appendPhasedText(state, 'two', null);
    expect(resolvedPhasedText(state)).toBe('one two');
  });

  it('prefers a canonical terminal body when the backend supplies one', () => {
    const state = createPhasedTextState();
    appendPhasedText(state, 'streamed', 'final_answer');
    expect(resolvedPhasedText(state, 'canonical')).toBe('canonical');
  });

  it('preserves the complete streamed body before a canonical terminal replacement', () => {
    const state = createPhasedTextState();
    appendPhasedText(state, 'Working note. ', undefined);
    appendPhasedText(state, 'Final answer.', undefined);

    expect(commentaryForTerminalReplacement(state, 'Final answer.')).toBe(
      'Working note. Final answer.',
    );
  });

  it('does not finalize an empty body or a missing terminal result', () => {
    const empty = createPhasedTextState();
    expect(commentaryForTerminalReplacement(empty, 'Final answer.')).toBe('');

    const partial = createPhasedTextState();
    appendPhasedText(partial, 'Partial body', undefined);
    expect(commentaryForTerminalReplacement(partial, '')).toBe('');
  });
});
