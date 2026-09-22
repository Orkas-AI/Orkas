/** Parse one JSON object from a mixed stdout stream without assuming it is the
 * final output. Background diagnostics may be flushed after the scorecard. */
export function parseJsonObjectAt<T>(text: string, start: number): { value: T; end: number } {
  if (start < 0 || text[start] !== '{') throw new Error('JSON object start was not found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return { value: JSON.parse(text.slice(start, index + 1)) as T, end: index + 1 };
    }
  }
  throw new Error('JSON object was not terminated');
}
