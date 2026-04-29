/**
 * Minimal YAML frontmatter parser for SKILL.md.
 *
 * Supports the subset we actually need:
 *   ---
 *   name: some-name
 *   description: text that may contain colons or commas
 *   ---
 *
 * Values are read as raw strings (no nested structures, no lists, no folded
 * scalars). Unknown keys are preserved verbatim in the returned map so
 * callers can fish out extras if they want. If the document has no
 * frontmatter, `parseFrontmatter` returns `{ data: {}, body: text }`.
 *
 * Why hand-rolled instead of a dependency: core-agent deliberately keeps
 * its dep list tiny and these three fields are all we ever read.
 */

export interface FrontmatterParseResult {
  data: Record<string, string>;
  body: string;
}

const FENCE = /^---\s*$/m;

export function parseFrontmatter(text: string): FrontmatterParseResult {
  // Fast path: no leading `---`, nothing to parse.
  const first = text.indexOf("\n");
  const head = first >= 0 ? text.slice(0, first).trimEnd() : text.trimEnd();
  if (head.trim() !== "---") {
    return { data: {}, body: text };
  }

  // Find the closing fence. We scan line-by-line starting after the first fence.
  const lines = text.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) {
    // Unterminated frontmatter — treat as body, don't throw.
    return { data: {}, body: text };
  }

  const fmLines = lines.slice(1, closeIdx);
  const data: Record<string, string> = {};
  for (const raw of fmLines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  const body = lines.slice(closeIdx + 1).join("\n");
  return { data, body };
}
