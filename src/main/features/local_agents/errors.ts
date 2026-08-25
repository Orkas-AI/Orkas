/** Stable classification of backend diagnostics that are safe to turn into
 * actionable user copy. Raw CLI errors remain private because they can carry
 * local paths, stderr, or protocol payloads. */
export type CliRuntimeFailure = 'upgrade_required' | null;

const UPGRADE_REQUIRED_PATTERNS = [
  /requires? a newer version of (?:the )?(?:Codex|CLI)/i,
  /please upgrade to the latest (?:app or )?CLI/i,
  /Codex version is (?:too old|unsupported)/i,
];

/** Hermes 0.9 can stream this runtime-authored sentence as its only agent
 * message before returning a successful ACP end_turn. It is an upstream
 * request failure, not a model answer. Keep the match deliberately narrow so
 * ordinary explanations that merely discuss API errors remain untouched. */
export function isHermesApiRetryFailureText(text: unknown): boolean {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > 0
    && value.length <= 1_000
    && /^API call failed after \d+ retries?:\s*[^\r\n]+$/iu.test(value);
}

export function classifyCliRuntimeFailure(error: unknown): CliRuntimeFailure {
  const text = typeof error === 'string'
    ? error
    : (error instanceof Error ? error.message : '');
  if (!text) return null;
  return UPGRADE_REQUIRED_PATTERNS.some((pattern) => pattern.test(text))
    ? 'upgrade_required'
    : null;
}
