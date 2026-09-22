/** Synchronous, dependency-free context budget estimation. Host parity is tested. */
export function estimateTextTokenQuarters(s: string): number {
  let quarters = 0;
  let digits = 0;
  let punctuation = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Match main/util/token-estimate.ts::estimateBudgetTokenQuarters. Keep
    // this synchronous ESM package independent of the CommonJS host.
    if (code >= 0x30 && code <= 0x39) {
      if (digits === 0) quarters += 4;
      digits = (digits + 1) % 3;
      punctuation = false;
      continue;
    }
    digits = 0;
    const isPunctuation = (code >= 0x21 && code <= 0x2F)
      || (code >= 0x3A && code <= 0x40)
      || (code >= 0x5B && code <= 0x60)
      || (code >= 0x7B && code <= 0x7E);
    if (isPunctuation) {
      quarters += punctuation ? 1 : 4;
      punctuation = true;
      continue;
    }
    punctuation = false;
    // CJK Unified Ideographs (U+4E00-U+9FFF), Extension A (U+3400-U+4DBF),
    // CJK Symbols & Punctuation (U+3000-U+303F), Hiragana (U+3040-U+309F),
    // Katakana (U+30A0-U+30FF), Halfwidth/Fullwidth Forms (U+FF00-U+FFEF),
    // Hangul Syllables (U+AC00-U+D7AF).
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0x3040 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) quarters += 6;
    else quarters += 1;
  }
  return quarters;
}

/** Local budget estimate with CJK weights and numeric/punctuation boundaries;
 * provider usage remains authoritative for actual request consumption. */
export function estimateTextTokens(s: string): number {
  return Math.ceil(estimateTextTokenQuarters(s) / 4);
}
