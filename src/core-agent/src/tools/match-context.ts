/** Failure-only excerpts. Source text stays in tool content, never observations. */
export function matchRecoveryContext(
  body: string,
  hash: string,
  positions: readonly ({ line: number } | { offset: number })[],
  matchCount: number,
  maxChars: 1200 | 1600,
): string {
  const starts = [0];
  const breaks = /\r\n?|\n/g;
  let next: RegExpExecArray | null;
  while ((next = breaks.exec(body))) starts.push(next.index + next[0].length);
  const locations = positions.slice(0, 3).map((position) => {
    const offset = 'offset' in position ? position.offset : starts[position.line - 1];
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { offset, line: low + 1, column: offset - starts[low] + 1,
      from: starts[Math.max(0, low - 2)], to: starts[low + 3] ?? body.length };
  });
  // Account for JSON escaping as well as source length. Recenter when shrinking
  // so even very long lines show the actual match, rather than the line prefix.
  let excerptChars = Math.floor(maxChars / Math.max(1, locations.length));
  for (;;) {
    const candidates = locations.map(({ offset, line, column, from, to }) => {
      const start = Math.max(from, offset - Math.floor(excerptChars / 3));
      const end = Math.min(to, start + excerptChars);
      return { line, column, char_start: start, char_end: end,
        text: body.slice(start, end), truncated: start > from || end < to };
    });
    const serialized = JSON.stringify({ file_hash: hash, match_count: matchCount,
      omitted_matches: matchCount - candidates.length,
      coordinates: 'line/column: 1-based; char offsets: 0-based UTF-16', candidates });
    if (serialized.length <= maxChars) return serialized;
    excerptChars = Math.floor(excerptChars / 2);
  }
}

/** Match edit_file's non-overlapping counting without retaining every match. */
export function firstMatchOffsets(body: string, needle: string): { offset: number }[] {
  const positions: { offset: number }[] = [];
  if (!needle) return positions;
  let from = 0;
  while (positions.length < 3) {
    const offset = body.indexOf(needle, from);
    if (offset === -1) break;
    positions.push({ offset });
    from = offset + needle.length;
  }
  return positions;
}
