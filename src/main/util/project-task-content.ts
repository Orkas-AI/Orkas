/** Legacy fields are read-only aliases; canonical content always wins. */
export function taskContent(input: { content?: unknown; title?: unknown; detail?: unknown }): string | undefined {
  if (input.content !== undefined) return typeof input.content === 'string' ? input.content.trim() : undefined;
  return [input.title, input.detail].filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim()).filter(Boolean).join('\n');
}
