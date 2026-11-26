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

/** Spans shorter than this between two pauses are not speech worth placing words in. */
const SPEECH_SPAN_MIN_SEC = 0.01;
/** Share of the recognized characters each span's own recognition must repeat exactly. */
const PLACEMENT_MIN_AGREEMENT = 0.5;
/** Largest character alignment computed (about ten minutes of Chinese speech each way). */
const PLACEMENT_MAX_CELLS = 8_000_000;
/** Cost of a second away from a span, against one unmatched character, for words the spans did not repeat. */
const PLACEMENT_TIME_WEIGHT = 0.5;

/** The speech between measured pauses: each span runs from where one pause ends to where the next begins. Pure. */
export function speechSpans(silences: PhraseSpan[], durationSec: number): PhraseSpan[] {
  const quiet = silences
    .filter((s) => isNum(s.startSec) && isNum(s.endSec) && s.endSec - s.startSec >= PHRASE_MIN_PAUSE_SEC)
    .sort((a, b) => a.startSec - b.startSec);
  const spans: PhraseSpan[] = [];
  let heard = 0;
  for (const s of [...quiet, { startSec: durationSec, endSec: durationSec }]) {
    if (s.startSec - heard >= SPEECH_SPAN_MIN_SEC) spans.push({ startSec: heard, endSec: Math.min(s.startSec, durationSec) });
    heard = Math.max(heard, s.endSec);
  }
  return spans;
}

/** True when more than a quarter of the words overlap no span: the recording is quieter than the
 *  pause threshold and its "pauses" hold speech, the same rule the phrase view uses before moving
 *  a word out of a pause. */
export function pausesHoldSpeech(words: PhraseWord[], spans: PhraseSpan[]): boolean {
  const inPause = words.filter((w) => !spans.some((s) => s.startSec < w.endSec && w.startSec < s.endSec)).length;
  return inPause > words.length * 0.25;
}

const placementUnits = (text: string): string[] => [...text.normalize('NFKC').toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));

/**
 * Moves each recognized word into the measured span of speech it was spoken in. Recognizers misplace
 * word times across pauses (2026-11-17: 燈 in a false start, 柔 in its retake, so the false start read
 * as the end of the sentence before it). `spans` carries each span recognized on its own; its text
 * only guides placement and may be poor (補兑 for 不對 on 0.2 s of audio). The words, their order and
 * their text are kept; the words of a span are moved and scaled together onto the part of it they
 * missed. Returns null when the guide does not repeat enough of the words to be trusted, or when the
 * pauses hold speech. Pure.
 */
export function placeWordsInSpeech(words: PhraseWord[], spans: Array<PhraseSpan & { text: string }>): PhraseWord[] | null {
  if (words.length === 0 || spans.length < 2) return null;
  // Ordered, nonoverlapping word spans, as a validated transcript has them.
  if (words.some((w, i) => !isNum(w.startSec) || !isNum(w.endSec) || !(w.endSec > w.startSec)
    || (i > 0 && w.startSec < words[i - 1].endSec))) return null;
  if (pausesHoldSpeech(words, spans)) return null;
  const heardWord: number[] = []; const heard: string[] = [];
  words.forEach((w, i) => { for (const c of placementUnits(w.text)) { heard.push(c); heardWord.push(i); } });
  const guideSpan: number[] = []; const guide: string[] = [];
  spans.forEach((s, k) => { for (const c of placementUnits(s.text)) { guide.push(c); guideSpan.push(k); } });
  const n = heard.length, m = guide.length, width = m + 1;
  if (!n || !m || (n + 1) * width > PLACEMENT_MAX_CELLS) return null;
  // Global edit-distance alignment of the two character sequences (1 = pair, 2 = skip a word
  // character, 3 = skip a guide character); pairs give each word votes for the spans they fall in.
  const steps = new Uint8Array((n + 1) * width);
  let previous = new Int32Array(width), current = new Int32Array(width);
  for (let y = 0; y <= m; y += 1) { previous[y] = y; steps[y] = 3; }
  for (let x = 1; x <= n; x += 1) {
    current[0] = x; steps[x * width] = 2;
    for (let y = 1; y <= m; y += 1) {
      let best = previous[y - 1] + (heard[x - 1] === guide[y - 1] ? 0 : 1), step = 1;
      if (previous[y] + 1 < best) { best = previous[y] + 1; step = 2; }
      if (current[y - 1] + 1 < best) { best = current[y - 1] + 1; step = 3; }
      current[y] = best; steps[x * width + y] = step;
    }
    [previous, current] = [current, previous];
  }
  const votes = words.map(() => new Map<number, number>());
  let exact = 0;
  for (let x = n, y = m; x > 0 || y > 0;) {
    const step = x > 0 && y > 0 ? steps[x * width + y] : x > 0 ? 2 : 3;
    if (step === 1) {
      const same = heard[x - 1] === guide[y - 1];
      if (same) exact += 1;
      const tally = votes[heardWord[x - 1]];
      tally.set(guideSpan[y - 1], (tally.get(guideSpan[y - 1]) ?? 0) + (same ? 2 : 1));
      x -= 1; y -= 1;
    } else if (step === 2) x -= 1;
    else y -= 1;
  }
  if (exact < n * PLACEMENT_MIN_AGREEMENT) return null;
  // Each word to one span, in order: unmatched characters cost, and so does distance in time,
  // which decides for words the guide did not repeat.
  const K = spans.length;
  const units = words.map((w) => placementUnits(w.text).length);
  const cost = (i: number, k: number) => {
    const mid = (words[i].startSec + words[i].endSec) / 2, s = spans[k];
    const away = mid < s.startSec ? s.startSec - mid : mid > s.endSec ? mid - s.endSec : 0;
    return 2 * units[i] - (votes[i].get(k) ?? 0) + PLACEMENT_TIME_WEIGHT * away;
  };
  const from = new Int32Array(words.length * K);
  let totals = Float64Array.from({ length: K }, (_, k) => cost(0, k));
  for (let i = 1; i < words.length; i += 1) {
    const next = new Float64Array(K);
    let low = Infinity, lowAt = 0;
    for (let k = 0; k < K; k += 1) {
      if (totals[k] < low) { low = totals[k]; lowAt = k; }
      next[k] = low + cost(i, k); from[i * K + k] = lowAt;
    }
    totals = next;
  }
  const span = new Int32Array(words.length);
  let k = 0;
  for (let j = 1; j < K; j += 1) if (totals[j] < totals[k]) k = j;
  for (let i = words.length - 1; i >= 0; i -= 1) { span[i] = k; k = from[i * K + k]; }
  const placed = words.map((w) => ({ ...w }));
  for (let first = 0; first < words.length;) {
    let last = first;
    while (last + 1 < words.length && span[last + 1] === span[first]) last += 1;
    const s = spans[span[first]], startSec = words[first].startSec, endSec = words[last].endSec;
    let to0 = Math.max(startSec, s.startSec), to1 = Math.min(endSec, s.endSec);
    if (!(to1 > to0)) { to0 = s.startSec; to1 = s.endSec; }
    if (to0 !== startSec || to1 !== endSec) {
      // Milliseconds, as recognized times are, rounded toward the inside of the span.
      const scale = (to1 - to0) / (endSec - startSec), low = Math.ceil(to0 * 1000) / 1000, high = Math.floor(to1 * 1000) / 1000;
      for (let i = first; i <= last; i += 1) {
        placed[i].startSec = Math.max(low, round3(to0 + (words[i].startSec - startSec) * scale));
        placed[i].endSec = Math.min(high, round3(to0 + (words[i].endSec - startSec) * scale));
      }
    }
    first = last + 1;
  }
  for (let i = 0; i < placed.length; i += 1) {
    if (!(placed[i].endSec > placed[i].startSec) || (i > 0 && placed[i].startSec < placed[i - 1].endSec)) return null;
  }
  return placed;
}

/** Read with the view, so a word recognition placed on the wrong side of a pause does not
 *  move a cut into the line it belongs beside (2026-11-13: "现在只要" lost from a kept take). */
export const PHRASE_VIEW_NOTE = 'Times and pauses are measured from the recording; the words come from speech recognition and can sit up to about a second off. A word at the start or end of a line may belong to the line next to it: cut at line edges or marked pauses, never inside a line to drop such a word.';

/** A word ending with one of these ends a clause of what is heard. */
const CLAUSE_END = /[。！？!?.,，、；;：:…]$/;
/** A pause this long ends a clause that no punctuation closed. */
const CLAUSE_GAP_SEC = 0.5;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** What a recording says, clause by clause, from its words' own times; the recognizer's
 *  sentences when it gave no word times. A narration voiced in one take comes back as one
 *  long sentence (2026-11-19: 28 s for every step of a tutorial), while its clauses each
 *  name one step. Pure. */
export function heardClauses(
  words: readonly PhraseWord[],
  sentences: ReadonlyArray<{ text: string; startSec: number; endSec: number }>,
): Array<{ text: string; startSec: number; endSec: number }> {
  const timed = words
    .filter((word) => typeof word.text === 'string' && word.text.trim() && isNum(word.startSec) && isNum(word.endSec) && word.endSec >= word.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  if (!timed.length) return sentences.filter((sentence) => HAS_WORD.test(sentence.text)).map((sentence) => ({ ...sentence }));
  const clauses: Array<{ text: string; startSec: number; endSec: number }> = [];
  let current: { text: string; startSec: number; endSec: number } | null = null;
  const close = () => {
    if (current && HAS_WORD.test(current.text)) clauses.push(current);
    current = null;
  };
  for (const word of timed) {
    const text = word.text.trim();
    if (current && word.startSec - current.endSec >= CLAUSE_GAP_SEC) close();
    if (!current) current = { text, startSec: word.startSec, endSec: word.endSec };
    else current = { text: joinTokens(current.text, text), startSec: current.startSec, endSec: Math.max(current.endSec, word.endSec) };
    if (CLAUSE_END.test(text)) close();
  }
  close();
  return clauses;
}

/** Frames a transcribed video shows under its phrases, in one sheet. */
export const PHRASE_FRAMES_MAX = 16;

/** What the frames under a transcribed video's phrases are for. */
export const PHRASE_FRAMES_NOTE = "The attached sheet shows the picture in the middle of each phrase, labelled with the phrase's start time as in phrases. Look at it before writing about the picture: title cards, recaps and previews of other episodes, burned-in subtitles and who is on screen are there, not in the words.";

/** Keeps the first and last of `count` items and spreads the rest evenly, up to `max`. Pure. */
export function spreadIndexes(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_item, index) => index);
  if (max <= 1) return [0];
  return [...new Set(Array.from({ length: max }, (_item, index) => Math.round(index * (count - 1) / (max - 1))))];
}

/** Where to look at a video under its phrases: the middle of each, labelled with the start time
 *  the phrase view prints, so a frame and its line are found by the same number. A preview of
 *  the next episode, a title card or burned-in subtitles show in the picture, not in the words
 *  (2026-11-17: a recap told "录音被删了" from a 下集预告 card as something that happened). Pure. */
export function phraseFrameSamples(
  lines: readonly PhraseLine[],
  durationSec: number,
  max = PHRASE_FRAMES_MAX,
): Array<{ atSec: number; label: string; startSec: number }> {
  const lastSec = Math.max(0, durationSec - 0.1);
  return spreadIndexes(lines.length, max).map((index) => {
    const line = lines[index];
    return {
      atSec: round3(Math.min(lastSec, Math.max(0, (line.startSec + line.endSec) / 2))),
      label: `[${line.startSec.toFixed(2)}]`,
      startSec: line.startSec,
    };
  });
}

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
