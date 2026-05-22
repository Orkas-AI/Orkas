// Backend port of the renderer's `_splitMarkdownProseCode` +
// `_findOuterTagRanges` (lives in `src/renderer/modules/strip-structural-blocks.js`).
// Used to give the post-stream container extractors (`<skill>` and `<agent>`)
// a prose/code guard: an LLM mentioning a machine tag inside a non-XML
// fenced block, inline backtick span, or inline quoted sentence (e.g.,
// teaching the user the protocol) must NOT cause the backend to falsely
// "extract" the example as a real container and persist nonexistent files.
// Explicit ```xml fences remain structural output: the LLM sometimes wraps
// real XML protocol blocks in Markdown, and those must still be parsed.
//
// Logic mirror is intentional — the renderer pins set A / set B fixtures
// directly in `test/renderer/strip-structural-blocks.test.ts`; the
// backend port is exercised indirectly through
// `test/main/features/skills.test.ts` and `test/main/features/agents.test.ts`
// (prose/code guards against `extractSkillContainers` /
// `extractAgentFieldBlocks`). Both copies must stay in sync; if you change
// one, change the other and extend BOTH fixture sets.
//
// Why duplicated rather than shared: renderer is vanilla JS without
// imports (PC/CLAUDE.md §8); main is TS with strict layering (§3, no
// renderer imports). The pure logic is small (~80 lines) and the cost
// of two copies + a sync convention is lower than introducing a build
// step or a cross-layer require.

export interface ProseCodeSegment {
  kind: 'prose' | 'code';
  text: string;
  xmlFence?: boolean;
}

/** Split a markdown buffer into alternating prose / code segments. "Code" =
 *  fenced ``` / ~~~ blocks (≤3-space indent, info-string allowed) plus
 *  inline backtick spans; everything else is prose. Fenced blocks with an
 *  `xml` info string carry `xmlFence: true` so downstream structural
 *  parsers can still process them. Mid-stream unclosed fences and unclosed
 *  inline backticks are treated as code through end-of-buffer, matching the
 *  renderer's behavior. */
export function splitMarkdownProseCode(text: string): ProseCodeSegment[] {
  const segs: ProseCodeSegment[] = [];
  if (!text) return segs;
  const n = text.length;
  let proseStart = 0;
  const flushProse = (end: number) => {
    if (end > proseStart) segs.push({ kind: 'prose', text: text.slice(proseStart, end) });
  };
  let i = 0;
  while (i < n) {
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart) {
      let j = i;
      let indent = 0;
      while (indent < 3 && text[j] === ' ') { j++; indent++; }
      const ch = text[j];
      if (ch === '`' || ch === '~') {
        let count = 0;
        while (text[j + count] === ch) count++;
        if (count >= 3) {
          let k = j + count;
          while (k < n && text[k] !== '\n') k++;
          const info = text.slice(j + count, k).trim().toLowerCase();
          const xmlFence = /^xml(?:\s|$)/.test(info);
          let scan = k < n ? k + 1 : n;
          let close = -1;
          while (scan < n) {
            let s = scan;
            let pad = 0;
            while (pad < 3 && text[s] === ' ') { s++; pad++; }
            if (text[s] === ch) {
              let cc = 0;
              while (text[s + cc] === ch) cc++;
              if (cc >= count) {
                let lineEnd = s + cc;
                while (lineEnd < n && text[lineEnd] !== '\n') lineEnd++;
                close = lineEnd;
                break;
              }
            }
            while (scan < n && text[scan] !== '\n') scan++;
            if (scan < n) scan++;
          }
          flushProse(i);
          const endIdx = close >= 0 ? close : n;
          segs.push({ kind: 'code', text: text.slice(i, endIdx), xmlFence });
          proseStart = endIdx;
          i = endIdx;
          continue;
        }
      }
    }
    if (text[i] === '`') {
      let count = 0;
      while (text[i + count] === '`') count++;
      let j = i + count;
      let close = -1;
      while (j < n) {
        if (text[j] === '`') {
          let cc = 0;
          while (text[j + cc] === '`') cc++;
          if (cc === count) { close = j + cc; break; }
          j += cc;
        } else {
          j++;
        }
      }
      if (close > 0) {
        flushProse(i);
        segs.push({ kind: 'code', text: text.slice(i, close) });
        proseStart = close;
        i = close;
        continue;
      }
      flushProse(i);
      segs.push({ kind: 'code', text: text.slice(i, n) });
      proseStart = n;
      i = n;
      continue;
    }
    i++;
  }
  flushProse(n);
  return segs;
}

function isInsideQuotedSpanOnLine(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(0, idx - 1)) + 1;
  const nextNl = text.indexOf('\n', idx);
  const lineEnd = nextNl < 0 ? text.length : nextNl;
  const linePrefix = text.slice(lineStart, idx);
  const closingAsciiDouble = text.indexOf('"', idx);
  if (closingAsciiDouble >= 0 && closingAsciiDouble < lineEnd) {
    let open = false;
    for (let i = 0; i < linePrefix.length; i++) {
      if (linePrefix[i] !== '"') continue;
      if (i > 0 && linePrefix[i - 1] === '\\') continue;
      open = !open;
    }
    if (open) return true;
  }

  const pairs: Array<[string, string]> = [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》']];
  for (const [openQuote, closeQuote] of pairs) {
    const lastOpen = text.lastIndexOf(openQuote, idx - 1);
    if (lastOpen < lineStart) continue;
    const lastClose = text.lastIndexOf(closeQuote, idx - 1);
    const nextClose = text.indexOf(closeQuote, idx);
    if (lastOpen > lastClose && nextClose >= 0 && nextClose < lineEnd) return true;
  }
  return false;
}

function isLineStartOpening(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(0, idx - 1)) + 1;
  for (let i = lineStart; i < idx; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '"' || ch === '\'' || ch === '“' || ch === '‘' || ch === '「' || ch === '『' || ch === '《') continue;
    return false;
  }
  return true;
}

function isInlineQuotedOpening(text: string, idx: number): boolean {
  return isInsideQuotedSpanOnLine(text, idx) && !isLineStartOpening(text, idx);
}

/** Find every `<TAG>...</TAG>` (or unclosed `<TAG>...EOF`) range whose
 *  OPENING tag falls in an outer prose segment or an explicit XML fence.
 *  The tagged container is
 *  treated as one atomic unit — once the opening tag is in prose, we walk
 *  to the matching `</TAG>` (or EOF) regardless of what's inside, so
 *  backticks / fences / quotes authored inside the body don't fragment
 *  the container. Boundary check (next char must be `>`, whitespace, or
 *  `/`) keeps `<skill>` lookup from also matching `<skills>` and similar
 *  same-prefix siblings.
 *
 *  Mirror of renderer's `_findOuterTagRanges` (`strip-structural-blocks.js`); see
 *  module header for the sync convention. */
export function findOuterTagRanges(text: string, tagName: string): Array<[number, number]> {
  if (!text || !tagName) return [];
  const openLeader = `<${tagName}`;
  const closeLiteral = `</${tagName}>`;
  if (text.indexOf(openLeader) < 0) return [];
  const segs = splitMarkdownProseCode(text);
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  for (const seg of segs) {
    const segStart = pos;
    pos += seg.text.length;
    if (seg.kind !== 'prose' && !seg.xmlFence) continue;
    let from = segStart;
    while (from < pos) {
      const last = ranges.length ? ranges[ranges.length - 1] : null;
      if (last && from < last[1]) from = last[1];
      if (from >= pos) break;
      const openIdx = text.indexOf(openLeader, from);
      if (openIdx < 0 || openIdx >= pos) break;
      const next = text.charCodeAt(openIdx + openLeader.length);
      const isBoundary = next === 62 /* > */ || next === 32 /* space */
        || next === 9 /* \t */ || next === 10 /* \n */ || next === 13 /* \r */
        || next === 47 /* / */;
      if (!isBoundary) {
        from = openIdx + openLeader.length;
        continue;
      }
      if (!seg.xmlFence && isInlineQuotedOpening(text, openIdx)) {
        from = openIdx + openLeader.length;
        continue;
      }
      const tagEnd = text.indexOf('>', openIdx + openLeader.length);
      if (tagEnd < 0) {
        ranges.push([openIdx, text.length]);
        from = text.length;
        break;
      }
      const closeIdx = text.indexOf(closeLiteral, tagEnd + 1);
      const endPos = closeIdx < 0 ? text.length : closeIdx + closeLiteral.length;
      ranges.push([openIdx, endPos]);
      from = endPos;
    }
  }
  return ranges;
}
