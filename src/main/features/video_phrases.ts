/**
 * The phrase view `speech.transcribe` returns: the transcript as lines split at
 * the pauses measured in the same audio. Speech recognition folds short pauses
 * into the neighbouring words (measured 2026-11-12: a 0.49s and a 0.59s silence
 * around 嗯/呃 left no gap between the words at all), so a model reading word or
 * segment times alone cuts into words (2026-11-13: three clips cut from a podcast
 * dropped a question, a closing line and a payoff).
 *
 * The same packing ships in the VideoStudio skill bundle for transcripts the
 * agent already has (`analyze_media --op phrases`); a parity test keeps the two
 * identical. The host cannot import the skill's sources, which are not packaged.
 */

export interface PhraseWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface PhraseSpan {
  startSec: number;
  endSec: number;
}

export interface PhraseLine {
  startSec: number;
  endSec: number;
  text: string;
  /** Measured pause before the next line, or null after the last one. */
  pauseAfterSec: number | null;
}

/** A pause this long starts a new line; shorter measured pauses are marked inline. */
export const PHRASE_BREAK_SEC = 0.5;
/** Shortest measured silence shown in the phrase view. */
export const PHRASE_MIN_PAUSE_SEC = 0.15;
/** The silencedetect settings the view is measured with. */
export const PHRASE_SILENCE_FILTER = `silencedetect=noise=-40dB:d=${PHRASE_MIN_PAUSE_SEC}`;
/** Lines returned inline; a longer view points to `analyze_media --op phrases --output`. */
export const PHRASES_INLINE_MAX_LINES = 200;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round3 = (n: number): number => Math.round((isNum(n) ? n : 0) * 1000) / 1000;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LEADING_PUNCT = /^[\p{P}\p{S}]/u;

function joinTokens(left: string, right: string): string {
  if (!left) return right;
  const a = left[left.length - 1];
  const b = right[0];
  // Chinese, Japanese and Korean run together, and punctuation attaches to the
  // word before it; other words are spaced.
  return CJK_CHAR.test(a) || CJK_CHAR.test(b) || LEADING_PUNCT.test(right) ? `${left}${right}` : `${left} ${right}`;
}

/** Silences from ffmpeg `silencedetect` log lines; an unfinished silence runs to `durationSec`. */
export function parseSilenceLog(log: string, durationSec?: number): PhraseSpan[] {
  const spans: PhraseSpan[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === 'start') open = Math.max(0, t);
    else if (open !== null) {
      if (t > open) spans.push({ startSec: open, endSec: t });
      open = null;
    }
  }
  if (open !== null && isNum(durationSec) && durationSec > open) spans.push({ startSec: open, endSec: durationSec });
  return spans;
}

/**
 * Each word is trimmed to the silences it overlaps; then a pause of `breakSec` or
 * more starts a new line and shorter pauses of at least PHRASE_MIN_PAUSE_SEC are
 * shown inline as `(0.31s)`. Pure.
 */
export function packTranscriptPhrases(words: PhraseWord[], silences: PhraseSpan[], opts: { breakSec?: number; segments?: boolean } = {}): PhraseLine[] {
  const breakSec = isNum(opts.breakSec) && opts.breakSec > 0 ? opts.breakSec : PHRASE_BREAK_SEC;
  const quiet = silences
    .filter((s) => isNum(s.startSec) && isNum(s.endSec) && s.endSec - s.startSec >= PHRASE_MIN_PAUSE_SEC)
    .sort((a, b) => a.startSec - b.startSec);
  const fixed = words
    .filter((w) => w && typeof w.text === 'string' && w.text.trim() && isNum(w.startSec) && isNum(w.endSec) && w.endSec > w.startSec)
    .map((w) => ({ text: w.text.trim(), startSec: w.startSec, endSec: w.endSec }))
    .sort((a, b) => a.startSec - b.startSec);
  const within = (w: { startSec: number; endSec: number }, s: { startSec: number; endSec: number }) => s.startSec <= w.startSec && w.endSec <= s.endSec;
  // Recognizers misplace word times by up to half a second: a word can sit wholly
  // inside a measured silence (2026-11-13: 的? and 去年 inside the 1.1 s pause between
  // a question and its answer). Such a word belongs to the speech on the nearer side.
  // When many words do, the recording is too quiet for the threshold and its
  // "silences" hold speech, so nothing is moved.
  const insideCount = fixed.filter((w) => quiet.some((s) => within(w, s))).length;
  const snapInside = insideCount <= fixed.length * 0.25;
  // Sentence-level units span their own pauses, so only words are trimmed.
  if (!opts.segments) for (const w of fixed) {
    for (const s of quiet) {
      if (s.endSec <= w.startSec || s.startSec >= w.endSec) continue;
      if (within(w, s)) {
        if (!snapInside) continue;
        if ((w.startSec + w.endSec) / 2 - s.startSec < s.endSec - (w.startSec + w.endSec) / 2) {
          w.startSec = Math.max(0, s.startSec - 0.01); w.endSec = s.startSec;
        } else {
          w.startSec = s.endSec; w.endSec = s.endSec + 0.01;
        }
      } else if (s.startSec > w.startSec) {
        // Silence starts inside the word: the word ended there.
        w.endSec = Math.min(w.endSec, s.startSec);
      } else if (s.endSec < w.endSec) {
        // Silence covers the word's start: the word started where it ends.
        w.startSec = s.endSec;
      }
    }
  }
  fixed.sort((a, b) => a.startSec - b.startSec);
  // With pauses measured, the pause between two words is the silence measured
  // between them, and a line ends where the sound stops and the next starts where
  // it resumes. With none measured (speech over music), word gaps are all there is.
  const measured = quiet.length > 0;
  const pauseBetween = (a: number, b: number): { sec: number; quiet: { startSec: number; endSec: number } | null } => {
    if (!measured) return { sec: Math.max(0, b - a), quiet: null };
    let sec = 0;
    let widest: { startSec: number; endSec: number } | null = null;
    for (const s of quiet) {
      const overlap = Math.min(b, s.endSec) - Math.max(a, s.startSec);
      if (overlap <= 0) continue;
      sec += overlap;
      if (!widest || overlap > Math.min(b, widest.endSec) - Math.max(a, widest.startSec)) widest = s;
    }
    return { sec, quiet: widest };
  };
  const lines: PhraseLine[] = [];
  let current: PhraseLine | null = null;
  let previousEnd = 0;
  for (const w of fixed) {
    const gap = current ? pauseBetween(previousEnd, Math.max(previousEnd, w.startSec)) : { sec: 0, quiet: null };
    if (!current || gap.sec >= breakSec) {
      let startSec = w.startSec;
      if (current) {
        if (gap.quiet) {
          current.endSec = Math.max(current.endSec, Math.min(gap.quiet.startSec, w.startSec));
          startSec = Math.min(w.startSec, Math.max(gap.quiet.endSec, current.endSec));
        }
        current.pauseAfterSec = round3(gap.quiet ? startSec - current.endSec : gap.sec);
        lines.push(current);
      }
      current = { startSec, endSec: w.endSec, text: w.text, pauseAfterSec: null };
    } else {
      const marked = gap.sec >= PHRASE_MIN_PAUSE_SEC ? `${current.text} (${gap.sec.toFixed(2)}s)` : current.text;
      current.text = gap.sec >= PHRASE_MIN_PAUSE_SEC ? `${marked} ${w.text}` : joinTokens(current.text, w.text);
      current.endSec = Math.max(current.endSec, w.endSec);
    }
    previousEnd = Math.max(previousEnd, w.endSec);
  }
  if (current) lines.push(current);
  return lines.map((l) => ({ ...l, startSec: round3(l.startSec), endSec: round3(l.endSec) }));
}

/** Plain-text view: `[start–end] text`, with the pause between lines on its own row. */
export function formatPhraseLines(lines: PhraseLine[]): string {
  const rows: string[] = [];
  for (const l of lines) {
    rows.push(`[${l.startSec.toFixed(2)}–${l.endSec.toFixed(2)}] ${l.text}`);
    if (l.pauseAfterSec !== null) rows.push(`  — ${l.pauseAfterSec.toFixed(2)}s —`);
  }
  return rows.join('\n');
}

/** Read with the view, so a word recognition placed on the wrong side of a pause does not
 *  move a cut into the line it belongs beside (2026-11-13: "现在只要" lost from a kept take). */
export const PHRASE_VIEW_NOTE = 'Times and pauses are measured from the recording; the words come from speech recognition and can sit up to about a second off. A word at the start or end of a line may belong to the line next to it: cut at line edges or marked pauses, never inside a line to drop such a word.';

/** The view as it goes into a tool result: inline up to PHRASES_INLINE_MAX_LINES lines. */
export function phraseViewForResult(
  units: PhraseWord[],
  silences: PhraseSpan[] | null,
  opts: { segments?: boolean } = {},
): { lines: number; measured_pauses: number | null; note: string; text: string; truncated?: true } {
  const lines = packTranscriptPhrases(units, silences ?? [], opts.segments ? { segments: true } : {});
  const rows = formatPhraseLines(lines).split('\n');
  const base = { lines: lines.length, measured_pauses: silences ? silences.length : null, note: PHRASE_VIEW_NOTE };
  if (lines.length <= PHRASES_INLINE_MAX_LINES) return { ...base, text: rows.join('\n') };
  const head: string[] = [];
  let seen = 0;
  for (const row of rows) {
    if (row.startsWith('[')) { seen += 1; if (seen > PHRASES_INLINE_MAX_LINES) break; }
    head.push(row);
  }
  return {
    ...base,
    truncated: true,
    text: `${head.join('\n')}\n… ${lines.length - PHRASES_INLINE_MAX_LINES} more lines. For the rest, run stage-edit analyze_media --op phrases with --transcript and --output, and read the file in parts.`,
  };
}
