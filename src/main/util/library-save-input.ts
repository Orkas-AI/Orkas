/** Shared rejection facts for native and CLI Library saves; no input rewriting. */
const FIELDS = ['source_path', 'name', 'action', 'expected_revision'];

export function librarySaveFieldError(input: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(input).find((key) => !FIELDS.includes(key));
  if (unknown !== undefined) {
    const field = unknown.length > 80 ? `${unknown.slice(0, 80)}…` : unknown;
    return `unsupported field ${JSON.stringify(field)}; allowed fields: ${FIELDS.join(', ')}`;
  }
  if (input.action !== undefined && input.action !== 'save' && input.action !== 'checkout') {
    return 'action must be "save" or "checkout"';
  }
  if (input.expected_revision !== undefined && (typeof input.expected_revision !== 'string' || !input.expected_revision)) {
    return 'expected_revision must be a non-empty string';
  }
  return undefined;
}
