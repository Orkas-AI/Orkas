// Canonical regexes + thresholds for the heuristic conversation auto-title
// ladder. Defined here so `src/main/features/chats.ts` (backend persistence
// path) can import them directly. The renderer mirrors these in
// `src/renderer/modules/auto-title.js` because §8 forbids cross-layer
// imports from renderer to main; the parity is asserted in
// `test/renderer/auto-title-parity.test.ts`, so adding a filler word to one
// side without updating the other fails the test loudly.
//
// Filler regex notes:
//   - Both ZH and EN lists are ordered LONGEST-FIRST so the alternation
//     doesn't match a shorter prefix when a longer one is also valid
//     ("请帮我看一下..." must strip "请帮我看一下", not "请帮我" then leave "看一下").
//   - Single-character ZH fillers (bare "请") are intentionally NOT listed
//     — too likely to clip real content like "请教...".
//   - The clause regex catches ZH/EN sentence terminators. URL_TOKEN_RE and
//     findTitleClauseBoundary keep punctuation inside HTTP(S)/www URLs from
//     being mistaken for a clause boundary.
//   - 30-char truncate matches sidebar visual budget.

export const ZH_FILLER_RE = /^(帮我看一下|可不可以|帮我看下|帮我看看|麻烦你|帮我看|我想要|想问问|能不能|可以不|可以吗|请帮我|看一下|麻烦|帮我|我想|想问|请问|看下|看看)\s*/;
export const EN_FILLER_RE = /^(could you|would you|can you|help me|i'?d like to|i want to|please)\s+/i;
export const CLAUSE_RE = /[，。？！；;,.?!]/;
export const URL_TOKEN_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'，。？！；]+/gi;
export const TITLE_MAX = 30;

/**
 * Find the first sentence punctuation that is not part of an HTTP(S)/www URL.
 * Trailing punctuation is removed from each URL range first, so both
 * `https://orkas.ai?q=docs` and `https://orkas.ai，继续` behave naturally.
 */
export function findTitleClauseBoundary(text: string): number {
  const urlRanges: Array<{ start: number; end: number }> = [];
  const urlRe = new RegExp(URL_TOKEN_RE.source, URL_TOKEN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(text)) !== null) {
    const start = match.index;
    let end = start + match[0].length;
    while (end > start && CLAUSE_RE.test(text[end - 1])) end -= 1;
    if (end > start) urlRanges.push({ start, end });
  }

  let rangeIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (urlRanges[rangeIndex] && urlRanges[rangeIndex].end <= i) rangeIndex += 1;
    const range = urlRanges[rangeIndex];
    const insideUrl = Boolean(range && range.start <= i && i < range.end);
    if (!insideUrl && CLAUSE_RE.test(text[i])) return i;
  }
  return -1;
}
