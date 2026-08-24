/**
 * Shared character classification for token estimation.
 *
 * The classification (which code points are counted as CJK-width) is one
 * decision and lives here; the *weight* applied to it is not, because the two
 * callers face opposite risks:
 *
 *   • Context/tool-result budgeting over-estimates on purpose. Guessing low
 *     there means a request that overflows the model window and a dead run,
 *     so `CONSERVATIVE_CJK_WEIGHT` sits above what real tokenizers charge.
 *   • Prompt-shaping budgets (how much material to fit into a section of a
 *     much larger window) want accuracy: over-estimating silently halves the
 *     material for CJK text, and under-estimating only makes a section of an
 *     otherwise-roomy prompt slightly larger. `ACCURATE_CJK_WEIGHT` is inside
 *     the 0.6–1.0 band real tokenizers charge for CJK.
 *
 * Keeping both weights named and in one file is the point: the divergence was
 * previously three separate implementations with three different constants and
 * no cross-reference, which reads as drift rather than as a decision.
 *
 * `#core-agent` carries its own copy (it is dynamic-import-only from main and
 * needs this synchronously); the parity test in `tool-result-cap.test.ts` pins
 * the two together.
 */

/** Real tokenizers charge roughly 0.6–1.0 tokens per CJK character. */
export const ACCURATE_CJK_WEIGHT = 0.7;
/** Deliberately above the real cost: for context budgeting an under-estimate
 *  ends a run, while an over-estimate only compacts sooner. */
export const CONSERVATIVE_CJK_WEIGHT = 1.5;
/** Latin-ish text: ~4 characters per token. */
export const NON_CJK_CHARS_PER_TOKEN = 4;

/**
 * Split text into CJK-width and other characters.
 *
 * Iterates UTF-16 units rather than code points so a surrogate pair counts as
 * two "other" units — matching the core-agent copy exactly, since a divergent
 * count would move a result across a budget line on one side only.
 */
export function countTokenCharacters(text: string): { cjk: number; other: number } {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      // CJK Unified Ideographs, Extension A, CJK Symbols & Punctuation
      // (、。「」 — ordinary Chinese punctuation, easy to miss and common
      // enough to skew a Chinese estimate on its own), Hiragana, Katakana,
      // Halfwidth/Fullwidth Forms, Hangul Syllables.
      (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0x3400 && code <= 0x4DBF)
      || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0x3040 && code <= 0x309F)
      || (code >= 0x30A0 && code <= 0x30FF)
      || (code >= 0xFF00 && code <= 0xFFEF)
      || (code >= 0xAC00 && code <= 0xD7AF)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return { cjk, other };
}

/** Estimate tokens with an explicit CJK weight — pass one of the named
 *  constants above so the choice stays visible at the call site. */
export function estimateTokensWithWeight(text: string, cjkWeight: number): number {
  const { cjk, other } = countTokenCharacters(text);
  return Math.ceil(cjk * cjkWeight + other / NON_CJK_CHARS_PER_TOKEN);
}
