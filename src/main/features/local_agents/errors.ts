/** Stable classification of backend diagnostics that are safe to turn into
 * actionable user copy. Raw CLI errors remain private because they can carry
 * local paths, stderr, or protocol payloads. */
export type CliRuntimeFailure = 'upgrade_required' | null;

const UPGRADE_REQUIRED_PATTERNS = [
  /requires? a newer version of (?:the )?(?:Codex|CLI)/i,
  /please upgrade to the latest (?:app or )?CLI/i,
  /Codex version is (?:too old|unsupported)/i,
];

export function classifyCliRuntimeFailure(error: unknown): CliRuntimeFailure {
  const text = typeof error === 'string'
    ? error
    : (error instanceof Error ? error.message : '');
  if (!text) return null;
  return UPGRADE_REQUIRED_PATTERNS.some((pattern) => pattern.test(text))
    ? 'upgrade_required'
    : null;
}
