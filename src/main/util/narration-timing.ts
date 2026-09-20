/** Pure narration estimates shared by host speech callers and packaged writing scripts.
 * No provider, account, media production or filesystem dependency.
 * Estimates retain the existing natural-pace algorithm; they are not measured audio. */
function round2(n: number): number { return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100; }
function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }


/** Pick the right length unit for a narration script: characters for a CJK
 *  (Chinese/Japanese/Korean) line, whitespace words for a Latin one. Feeds
 *  assessNarrationFit so its budget ("trim to ≈N …") is a usable number rather
 *  than a meaningless word count on spaceless Chinese. Pure → unit-tested. */
export function measureNarrationUnits(text: string): { unit: 'words' | 'characters'; units: number } {
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3\uf900-\ufaff]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  // CJK is spaceless, so a Chinese line counts as ~1 word — count characters
  // whenever the script is CJK-dominant; otherwise count Latin words.
  return cjk >= words ? { unit: 'characters', units: cjk } : { unit: 'words', units: words };
}


export interface NarrationDurationEstimate {
  estimatedSec: number;
  unit: 'words' | 'characters';
  units: number;
  unitsPerSec: number;
  breakdown: {
    cjkCharacters: number;
    latinWords: number;
    numericDigits: number;
    numericSeparators: number;
    majorPauses: number;
    minorPauses: number;
    longPauses: number;
    speechSec: number;
    pauseSec: number;
  };
}


/** Conservative natural-pace estimate used before a paid synthesis request.
 *  Mixed-language scripts must be additive: choosing CJK characters OR Latin
 *  words drops model names, acronyms, versions, years, and punctuation from the
 *  budget. The rates below intentionally approximate a natural explainer read;
 *  the post-synthesis media probe remains the source of truth. */
export function estimateNarrationDuration(text: string, speed = 1): NarrationDurationEstimate {
  const measured = measureNarrationUnits(text);
  const cjkCharacters = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3\uf900-\ufaff]/g) || []).length;
  const latinTokens: string[] = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
  const numericDigits = (text.match(/\d/g) || []).length;
  // A decimal/thousands separator is spoken in versions and many quantities,
  // but must not also be counted as a sentence pause.
  const numericSeparators = (text.match(/\d[.,](?=\d)/g) || []).length;
  const pauseText = text.replace(/(\d)[.,](?=\d)/g, '$1');
  const majorPauses = (pauseText.match(/[。！？!?；;.\n]+/g) || []).length;
  const minorPauses = (pauseText.match(/[，,、：:]+/g) || []).length;
  const longPauses = (pauseText.match(/[—–…]+/g) || []).length;

  const cjkSec = cjkCharacters / 4;
  const latinSec = latinTokens.reduce<number>((total, token) => {
    // Initialisms such as GPT/MCP are commonly read letter by letter and take
    // longer than an ordinary one-syllable English word.
    const tokenSec = /^[A-Z]{2,6}$/.test(token)
      ? Math.max(1 / 2.5, token.length * 0.18)
      : 1 / 2.5;
    return total + tokenSec;
  }, 0);
  const numericSec = numericDigits * 0.18 + numericSeparators * 0.15;
  const speechSec = cjkSec + latinSec + numericSec;
  const pauseSec = majorPauses * 0.28 + minorPauses * 0.12 + longPauses * 0.18;
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.5, 2) : 1;
  const unitsPerSec = measured.unit === 'characters' ? 4 : 2.5;
  return {
    estimatedSec: round2((speechSec + pauseSec) / safeSpeed),
    unit: measured.unit,
    units: measured.units,
    unitsPerSec,
    breakdown: {
      cjkCharacters,
      latinWords: latinTokens.length,
      numericDigits,
      numericSeparators,
      majorPauses,
      minorPauses,
      longPauses,
      speechSec: round2(speechSec),
      pauseSec: round2(pauseSec),
    },
  };
}
