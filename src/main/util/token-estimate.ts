/**
 * Local text estimation, without a tokenizer dependency or provider request.
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
 * Runtime budgets additionally account for numeric and punctuation runs. This
 * remains an estimate, not billable usage or an exact provider token count.
 * `#core-agent` carries its own synchronous budget scanner because main can
 * only import that package dynamically; parity tests pin the two together.
 */

/** Real tokenizers charge roughly 0.6–1.0 tokens per CJK character. */
export const ACCURATE_CJK_WEIGHT = 0.7;
/** Deliberately above the real cost: for context budgeting an under-estimate
 *  ends a run, while an over-estimate only compacts sooner. */
export const CONSERVATIVE_CJK_WEIGHT = 1.5;
/** Latin-ish text: ~4 characters per token. */
export const NON_CJK_CHARS_PER_TOKEN = 4;

function isCjkCodeUnit(code: number): boolean {
  return (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x3000 && code <= 0x30FF)
    || (code >= 0xFF00 && code <= 0xFFEF)
    || (code >= 0xAC00 && code <= 0xD7AF);
}

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
    if (isCjkCodeUnit(code)) {
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

/** Retain lexical boundaries when counting decoded chunks of one output. */
export type TokenBudgetScanState = {
  digitRemainder: number;
  inAsciiPunctuation: boolean;
};

/**
 * Runtime budget in quarter-tokens, rounded only after the complete text.
 * Keep prose/CJK weights; count digit runs in groups of up to three and give
 * each ASCII punctuation run one token plus the ordinary weight for its tail.
 * This covers short numeric fields and separators without charging repeated
 * Markdown delimiters as one token per character. It does not identify file
 * formats, infer task intent, or claim exact BPE behavior for every model.
 *
 * The scan is linear, constant-space and prefix-monotone for range bisection.
 * Callers streaming one result must preserve state between chunks.
 */
export function estimateBudgetTokenQuarters(text: string, state?: TokenBudgetScanState): number {
  let digits = state?.digitRemainder ?? 0;
  let punctuation = state?.inAsciiPunctuation ?? false;
  let quarters = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
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
    quarters += isPunctuation
      ? (punctuation ? 1 : 4)
      : (isCjkCodeUnit(code) ? CONSERVATIVE_CJK_WEIGHT * 4 : 1);
    punctuation = isPunctuation;
  }
  if (state) {
    state.digitRemainder = digits;
    state.inAsciiPunctuation = punctuation;
  }
  return quarters;
}
