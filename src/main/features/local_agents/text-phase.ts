/** Text phases exposed by CLIs that distinguish working commentary from the
 * canonical answer. Today Codex app-server is the only backend that emits
 * these values; keeping the accumulator backend-agnostic lets the group-chat
 * bridge preserve the same contract if another CLI adopts it later. */
export type LocalTextPhase = 'commentary' | 'final_answer';

export function normalizeLocalTextPhase(value: unknown): LocalTextPhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

export interface PhasedTextState {
  allText: string;
  commentaryText: string;
  finalAnswerText: string;
  sawFinalAnswer: boolean;
}

export function createPhasedTextState(): PhasedTextState {
  return {
    allText: '',
    commentaryText: '',
    finalAnswerText: '',
    sawFinalAnswer: false,
  };
}

/** Append one streamed text chunk. `commentaryToFinalize` is returned exactly
 * once, on the first final-answer chunk, so callers can atomically move the
 * live commentary preview into their process/history surface before painting
 * the final answer. */
export function appendPhasedText(
  state: PhasedTextState,
  text: string,
  rawPhase: unknown,
): { phase?: LocalTextPhase; commentaryToFinalize?: string } {
  const phase = normalizeLocalTextPhase(rawPhase);
  const commentaryToFinalize = phase === 'final_answer' && !state.sawFinalAnswer
    ? state.commentaryText
    : '';

  state.allText += text;
  if (phase === 'commentary') {
    state.commentaryText += text;
  } else if (phase === 'final_answer') {
    state.sawFinalAnswer = true;
    state.finalAnswerText += text;
  }

  return {
    ...(phase ? { phase } : {}),
    ...(commentaryToFinalize ? { commentaryToFinalize } : {}),
  };
}

/** Prefer the backend's terminal body when present. Otherwise a phased stream
 * resolves to final-answer text only; an unphased/commentary-only stream keeps
 * the legacy full-text fallback, which is also the abort-before-final result. */
export function resolvedPhasedText(state: PhasedTextState, terminalText = ''): string {
  if (terminalText) return terminalText;
  return state.sawFinalAnswer ? state.finalAnswerText : state.allText;
}

/** Some CLIs (currently Claude Code) expose a canonical terminal result but no
 * token-level final-answer phase. When that result is about to replace the live
 * body, preserve the complete body the user already watched as process history.
 * No content matching is intentional: terminal replacement is the boundary. */
export function commentaryForTerminalReplacement(
  state: PhasedTextState,
  terminalText: string,
): string {
  return terminalText && state.allText ? state.allText : '';
}
