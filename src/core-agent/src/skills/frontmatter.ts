/**
 * Minimal YAML frontmatter parser for SKILL.md.
 *
 * Supports the subset we actually need:
 *   ---
 *   name: some-name
 *   description: text that may contain colons or commas
 *   ---
 *
 * Values are read as raw strings (no nested structures, no lists). Literal
 * (`|`) and folded (`>`) block scalars ARE supported for multi-line values
 * (commonly `description: |`) — without this the header line's value parses
 * as the bare `|`/`>` indicator and the indented body is dropped. Unknown
 * keys are preserved verbatim in the returned map so callers can fish out
 * extras if they want. If the document has no frontmatter,
 * `parseFrontmatter` returns `{ data: {}, body: text }`.
 *
 * Why hand-rolled instead of a dependency: core-agent deliberately keeps
 * its dep list tiny and these three fields are all we ever read.
 */

export interface FrontmatterParseResult {
  data: Record<string, string>;
  body: string;
}

const FENCE = /^---\s*$/m;

/** Fold a YAML `>` block: consecutive non-blank lines join with a single
 *  space; each blank line becomes a newline. */
function foldBlockLines(lines: string[]): string {
  let out = "";
  let prevBlank = true;
  for (const l of lines) {
    if (l === "") { out += "\n"; prevBlank = true; continue; }
    out += (prevBlank ? "" : " ") + l;
    prevBlank = false;
  }
  return out;
}

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
  for (let i = 0; i < fmLines.length; i++) {
    const raw = fmLines[i];
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();

    // Block scalar header: `key: |` / `key: >`, with optional chomping (`-`/`+`)
    // and indent (`|2`) indicators. Collect the following more-indented lines
    // as the value. Literal (`|`) keeps line breaks; folded (`>`) joins lines
    // with spaces (blank lines become newlines). We only need the text, so
    // chomping indicators are tolerated but trailing blank lines are dropped.
    const block = /^([|>])[+-]?\d*$/.exec(value);
    if (block) {
      const folded = block[1] === ">";
      const keyIndent = raw.length - raw.trimStart().length;
      const collected: string[] = [];
      let j = i + 1;
      for (; j < fmLines.length; j++) {
        const bl = fmLines[j];
        if (bl.trim() === "") { collected.push(""); continue; }
        const indent = bl.length - bl.trimStart().length;
        if (indent <= keyIndent) break; // dedent → block ended
        collected.push(bl);
      }
      i = j - 1;
      const indents = collected
        .filter((l) => l.trim() !== "")
        .map((l) => l.length - l.trimStart().length);
      const strip = indents.length ? Math.min(...indents) : 0;
      const deindented = collected.map((l) => (l.trim() === "" ? "" : l.slice(strip).trimEnd()));
      while (deindented.length && deindented[deindented.length - 1] === "") deindented.pop();
      data[key] = (folded ? foldBlockLines(deindented) : deindented.join("\n")).trim();
      continue;
    }

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
