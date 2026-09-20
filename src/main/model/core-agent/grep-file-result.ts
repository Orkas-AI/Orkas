export interface GrepHit {
  path: string;
  line: number;
  column: number;
  snippet: string;
  before: Array<{ line: number; text: string }>;
  after: Array<{ line: number; text: string }>;
}

/** Emit the path once per contiguous file group. Preserve hit/context order,
 * including overlapping context; JSON escaping keeps unusual paths unambiguous. */
export function formatGrepFileResults(hits: readonly GrepHit[]): string {
  const lines: string[] = [];
  let previousPath: string | undefined;
  for (const hit of hits) {
    if (hit.path !== previousPath) {
      lines.push(`file: ${JSON.stringify(hit.path)}`);
      previousPath = hit.path;
    }
    for (const entry of hit.before) lines.push(`  -${entry.line}-  ${entry.text}`);
    lines.push(`  :${hit.line}:${hit.column}  ${hit.snippet}`);
    for (const entry of hit.after) lines.push(`  +${entry.line}+  ${entry.text}`);
  }
  return lines.join('\n');
}
