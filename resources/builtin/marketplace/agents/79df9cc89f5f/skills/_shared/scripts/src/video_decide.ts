/**
 * video_decide — the deterministic real-footage DECISION layer (P3a). Pure: no
 * IO, no ffmpeg, no model. It turns measured signals (silence spans, transcript
 * words, scene scores) into edit decisions (which spans to drop, which intervals
 * to keep) plus the evidence behind each cut, so an auto-cut is auditable rather
 * than a black box.
 *
 * The executor layer (video_edit `trim_silence` / `remove_fillers`,
 * video_analyze `scenes`) measures the signals and runs the ffmpeg jump-cut this
 * module describes. Keeping the logic here (PURE) is what makes it unit-testable
 * and what ports verbatim to an open-source build.
 */

export interface Span {
  startSec: number;
  endSec: number;
}

export interface Word {
  text: string;
  startSec: number;
  endSec: number;
}

export interface SceneCandidate {
  tSec: number;
  score: number;
}

export interface DecisionEvidence {
  removed_spans: Span[];
  kept_intervals: Span[];
  removed_count: number;
  removed_sec: number;
  reason: string;
  /** Deterministic ops are high-confidence; the field exists so the LLM-grounded
   *  selections of a later milestone can report a lower, honest number. */
  confidence: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round3 = (n: number): number => Math.round((isNum(n) ? n : 0) * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Sort by start and merge overlapping/touching spans into a minimal set. */
export function mergeSpans(spans: Span[]): Span[] {
  const clean = spans
    .filter((s) => isNum(s.startSec) && isNum(s.endSec) && s.endSec > s.startSec)
    .map((s) => ({ startSec: s.startSec, endSec: s.endSec }))
    .sort((a, b) => a.startSec - b.startSec);
  const out: Span[] = [];
  for (const s of clean) {
    const last = out[out.length - 1];
    if (last && s.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, s.endSec);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export interface KeepOpts {
  /** Keep this many seconds of the removed material as breathing room at each
   *  boundary (so cuts are not jarringly tight). Default 0.1. */
  padSec?: number;
  /** Ignore removals shorter than this (not worth a cut). Default 0.5. */
  minRemoveSec?: number;
  /** Drop kept slivers shorter than this (a frame between two removals). Default 0.3. */
  minKeepSec?: number;
}

/**
 * Compute the intervals to KEEP, given the spans to REMOVE over a clip of length
 * `durationSec`. Removals are shrunk by `padSec` (keep breathing room), tiny
 * removals are ignored, the rest are merged, and the kept set is their complement
 * with sub-`minKeepSec` slivers dropped. With no effective removals the whole
 * clip is kept.
 */
export function keepIntervalsFromRemovals(durationSec: number, removeSpans: Span[], opts: KeepOpts = {}): Span[] {
  const dur = isNum(durationSec) && durationSec > 0 ? durationSec : 0;
  if (dur <= 0) return [];
  const padSec = isNum(opts.padSec) && opts.padSec >= 0 ? opts.padSec : 0.1;
  const minRemoveSec = isNum(opts.minRemoveSec) && opts.minRemoveSec >= 0 ? opts.minRemoveSec : 0.5;
  const minKeepSec = isNum(opts.minKeepSec) && opts.minKeepSec >= 0 ? opts.minKeepSec : 0.3;

  const shrunk: Span[] = [];
  for (const s of removeSpans) {
    if (!isNum(s.startSec) || !isNum(s.endSec)) continue;
    const start = clamp(s.startSec + padSec, 0, dur);
    const end = clamp(s.endSec - padSec, 0, dur);
    if (end - start >= minRemoveSec) shrunk.push({ startSec: start, endSec: end });
  }
  const removals = mergeSpans(shrunk);
  if (!removals.length) return [{ startSec: 0, endSec: round3(dur) }];

  const kept: Span[] = [];
  let cursor = 0;
  for (const r of removals) {
    if (r.startSec - cursor >= minKeepSec) kept.push({ startSec: round3(cursor), endSec: round3(r.startSec) });
    cursor = Math.max(cursor, r.endSec);
  }
  if (dur - cursor >= minKeepSec) kept.push({ startSec: round3(cursor), endSec: round3(dur) });
  return kept;
}

/** The complement of `kept` over [0, durationSec] — the spans that were REMOVED
 *  (the gaps a jump-cut drops). Inverse of {@link keepIntervalsFromRemovals}'s
 *  output; used to report deterministic evidence (e.g. for trim_silence). Pure. */
export function complementIntervals(kept: Span[], durationSec: number): Span[] {
  const dur = isNum(durationSec) && durationSec > 0 ? durationSec : 0;
  const removed: Span[] = [];
  let cursor = 0;
  for (const k of kept) {
    if (!isNum(k.startSec) || !isNum(k.endSec)) continue;
    if (k.startSec > cursor) removed.push({ startSec: round3(cursor), endSec: round3(k.startSec) });
    cursor = Math.max(cursor, k.endSec);
  }
  if (dur > cursor) removed.push({ startSec: round3(cursor), endSec: round3(dur) });
  return removed;
}

/** Default filler tokens removed by `remove_fillers`. Conservative on purpose —
 *  only true disfluencies, never real words like "like" or "so" that carry meaning. */
export const DEFAULT_FILLERS: readonly string[] = ['um', 'uh', 'umm', 'uhh', 'erm', 'er', 'ah', 'eh', 'hmm', 'mm', 'mmm'];

/** Letters and digits of any script, lower-cased; punctuation and spacing dropped.
 *  Stripping everything outside a–z turned every Chinese word into "", so a Chinese
 *  filler matched every word. */
const normToken = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').trim();

/**
 * Spans to remove for filler words. A word matches only on EXACT normalized
 * equality (so "summary" never matches "um", "这款" never matches "嗯"); a token
 * with no letters or digits never matches. Matched spans are padded by `padSec`
 * into surrounding silence only, never into a neighbouring word. Pure.
 */
export function fillerSpansFromWords(words: Word[], fillers: Iterable<string> = DEFAULT_FILLERS, opts: { padSec?: number } = {}): Span[] {
  const set = new Set(Array.from(fillers, (f) => normToken(f)).filter(Boolean));
  const padSec = isNum(opts.padSec) && opts.padSec >= 0 ? opts.padSec : 0.03;
  const timed = words
    .filter((w) => w && typeof w.text === 'string' && isNum(w.startSec) && isNum(w.endSec) && w.endSec > w.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const spans: Span[] = [];
  timed.forEach((w, i) => {
    const token = normToken(w.text);
    if (!token || !set.has(token)) return;
    const prevEnd = i > 0 ? timed[i - 1].endSec : 0;
    const nextStart = i + 1 < timed.length ? timed[i + 1].startSec : Number.POSITIVE_INFINITY;
    spans.push({
      startSec: Math.max(0, Math.min(w.startSec, Math.max(w.startSec - padSec, prevEnd))),
      endSec: Math.max(w.endSec, Math.min(w.endSec + padSec, nextStart)),
    });
  });
  return spans;
}

/**
 * Tolerantly extract `{text,startSec,endSec}` words from whatever shape a
 * transcript JSON uses: a top-level `words` array, `segments[].words`, or a
 * `result`/`transcript` wrapper; per-word seconds from `start/end`,
 * `startSec/endSec`, or `offsets.{from,to}` (milliseconds). Unknown shapes →
 * `[]`. Pure → fixtured for matching + look-alike shapes.
 */
export function normalizeTranscriptWords(json: unknown): Word[] {
  const collect: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 32 || !node || typeof node !== 'object') return;  // depth cap: guard against pathological nesting
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.words)) collect.push(...o.words);
    if (Array.isArray(o.segments)) for (const seg of o.segments) visit(seg, depth + 1);
    if (o.result) visit(o.result, depth + 1);
    if (o.transcript) visit(o.transcript, depth + 1);
  };
  if (Array.isArray(json)) collect.push(...json);
  else visit(json, 0);

  const out: Word[] = [];
  for (const raw of collect) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    const text = (w.word ?? w.text ?? w.w) as unknown;
    if (typeof text !== 'string' || !text.trim()) continue;
    let start: number | undefined;
    let end: number | undefined;
    if (isNum(w.startSec) && isNum(w.endSec)) { start = w.startSec; end = w.endSec; }
    else if (isNum(w.start) && isNum(w.end)) { start = w.start; end = w.end; }
    else if (w.offsets && typeof w.offsets === 'object') {
      const off = w.offsets as Record<string, unknown>;
      if (isNum(off.from) && isNum(off.to)) { start = off.from / 1000; end = off.to / 1000; }
    }
    if (start === undefined || end === undefined || end <= start) continue;
    out.push({ text: text.trim(), startSec: start, endSec: end });
  }
  return out;
}

/** A pause this long starts a new line in the phrase view; shorter measured pauses
 *  are marked inside the line. Shorter than this is rarely a clean cut. */
export const PHRASE_BREAK_SEC = 0.5;
/** Shortest measured silence shown in the phrase view. */
export const PHRASE_MIN_PAUSE_SEC = 0.15;

export interface PhraseLine {
  startSec: number;
  endSec: number;
  text: string;
  /** Measured pause before the next line, or null after the last one. */
  pauseAfterSec: number | null;
  /** A short excerpt bounded by silence, for checking audio with no aligned word. */
  review?: Span;
}

function untranscribedPhrases(words: Word[], quiet: Span[]): Array<Word & { review: Span }> {
  const candidates: Array<Word & { review: Span }> = [];
  let wordIndex = 0;
  let lastWordEnd = 0;
  for (let i = 1; i < quiet.length; i++) {
    const before = quiet[i - 1], after = quiet[i];
    const startSec = before.endSec, endSec = after.startSec;
    const length = endSec - startSec;
    // Inspect only short isolated sounds. A candidate does not classify that sound as speech or filler.
    if (length < 0.08 || length > 1) continue;
    while (wordIndex < words.length && words[wordIndex].startSec < endSec) {
      lastWordEnd = Math.max(lastWordEnd, words[wordIndex++].endSec);
    }
    if (lastWordEnd > startSec) continue;
    const padding = (pause: Span) => Math.min(0.45, (pause.endSec - pause.startSec) * 0.8);
    candidates.push({
      text: '', startSec, endSec,
      review: { startSec: round3(startSec - padding(before)), endSec: round3(endSec + padding(after)) },
    });
  }
  return candidates;
}

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

/**
 * Read a transcript as lines split at measured pauses. Speech recognition folds
 * short pauses into the neighbouring words (measured 2026-11-12: a 0.49s and a
 * 0.59s silence around 嗯/呃 left no gap between the words at all), so word gaps
 * alone hide most cut points. Each word is trimmed to the silences it overlaps,
 * then a pause of `breakSec` or more starts a new line and shorter pauses of at
 * least PHRASE_MIN_PAUSE_SEC are shown inline as `(0.31s)`. Pure.
 */
export function packTranscriptPhrases(words: Word[], silences: Span[], opts: {
  breakSec?: number; segments?: boolean; includeUntranscribed?: boolean;
} = {}): PhraseLine[] {
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
  const timed: Array<Word & { review?: Span }> = opts.includeUntranscribed
    ? [...fixed, ...untranscribedPhrases(fixed, quiet)].sort((a, b) => a.startSec - b.startSec) : fixed;
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
  for (const w of timed) {
    const gap = current ? pauseBetween(previousEnd, Math.max(previousEnd, w.startSec)) : { sec: 0, quiet: null };
    if (!current || w.review || current.review || gap.sec >= breakSec) {
      let startSec = w.startSec;
      if (current) {
        if (gap.quiet && !current.review && !w.review) {
          current.endSec = Math.max(current.endSec, Math.min(gap.quiet.startSec, w.startSec));
          startSec = Math.min(w.startSec, Math.max(gap.quiet.endSec, current.endSec));
        }
        current.pauseAfterSec = round3(gap.quiet || current.review || w.review ? startSec - current.endSec : gap.sec);
        lines.push(current);
      }
      current = { startSec, endSec: w.endSec, text: w.text, pauseAfterSec: null, ...(w.review ? { review: w.review } : {}) };
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

/** Plain-text phrase view: `[start–end] text`, with the pause between lines on its own row. */
export function formatPhraseLines(lines: PhraseLine[]): string {
  const rows: string[] = [];
  for (const l of lines) {
    rows.push(`[${l.startSec.toFixed(2)}–${l.endSec.toFixed(2)}] ${l.text}`);
    if (l.pauseAfterSec !== null) rows.push(`  — ${l.pauseAfterSec.toFixed(2)}s —`);
  }
  return rows.join('\n');
}

/**
 * Parse ffmpeg `select='gt(scene,…)',metadata=print` log output into scene-change
 * candidates. ffmpeg prints `pts_time:T` then `lavfi.scene_score=S` per detected
 * change. Pure.
 */
export function parseSceneChanges(log: string): SceneCandidate[] {
  const out: SceneCandidate[] = [];
  let pts: number | null = null;
  for (const line of log.split('\n')) {
    const tp = line.match(/pts_time:\s*([\d.]+)/);
    if (tp) { pts = Number(tp[1]); continue; }
    const sc = line.match(/scene_score\s*[:=]\s*([\d.]+)/);
    if (sc && pts !== null) {
      const score = Number(sc[1]);
      out.push({ tSec: round3(pts), score: Number.isFinite(score) ? round3(score) : 0 });
      pts = null;
    }
  }
  return out;
}

export interface KeepFilter {
  filter: string;
  maps: string[];
}

/** Fade at each audio join of a jump-cut, in seconds; shorter pieces use a quarter
 *  of their length. Without it the waveform steps at every join and clicks. */
export const JOIN_FADE_SEC = 0.03;

/**
 * Build the single-pass ffmpeg `-filter_complex` that keeps only `intervals` from
 * both video and audio (a jump-cut), re-stamping PTS so the kept pieces play
 * back-to-back. Video keeps its frames inside the intervals; audio takes each
 * interval sample-exactly with a short fade in and out, then joins them, so no
 * join clicks. Throws if there is nothing to keep. Pure.
 */
export function buildKeepFilterComplex(intervals: Span[], opts: { fps?: number } = {}): KeepFilter {
  const fps = isNum(opts.fps) && opts.fps > 0 ? opts.fps : 0;
  const given = intervals.filter((iv) => isNum(iv.startSec) && isNum(iv.endSec) && iv.endSec > iv.startSec);
  // With the frame rate known, each piece starts and ends on a frame, so its frames
  // and its samples last exactly as long and a long cut cannot drift out of sync
  // (unsnapped, every join could drop up to a frame of picture but no sound).
  const valid = fps
    ? given
      .map((iv) => ({ startSec: Math.round(iv.startSec * fps) / fps, endSec: Math.round(iv.endSec * fps) / fps }))
      .filter((iv) => iv.endSec > iv.startSec)
    : given;
  if (!valid.length) throw new Error('buildKeepFilterComplex: no intervals to keep');
  const digits = fps ? 6 : 3;
  // Half a frame either side keeps exactly the frames from start up to, not
  // including, end; a bound written right on a frame time could round past it.
  const halfFrame = fps ? 0.5 / fps : 0;
  const expr = valid
    .map((iv) => `between(t,${Math.max(0, iv.startSec - halfFrame).toFixed(digits)},${(iv.endSec - halfFrame).toFixed(digits)})`)
    .join('+');
  const chains = [`[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[v]`];
  const pieces = valid.map((iv, i) => {
    const len = iv.endSec - iv.startSec;
    const fade = Math.min(JOIN_FADE_SEC, len / 4);
    const fadeOutAt = Math.max(0, len - fade);
    return `[s${i}]atrim=start=${iv.startSec.toFixed(digits)}:end=${iv.endSec.toFixed(digits)},asetpts=PTS-STARTPTS,`
      + `afade=t=in:st=0:d=${fade.toFixed(4)},afade=t=out:st=${fadeOutAt.toFixed(4)}:d=${fade.toFixed(4)}[p${i}]`;
  });
  if (valid.length === 1) {
    chains.push(pieces[0].replace('[s0]', '[0:a]').replace('[p0]', '[a]'));
  } else {
    chains.push(`[0:a]asplit=${valid.length}${valid.map((_, i) => `[s${i}]`).join('')}`);
    chains.push(...pieces);
    chains.push(`${valid.map((_, i) => `[p${i}]`).join('')}concat=n=${valid.length}:v=0:a=1[a]`);
  }
  return { filter: chains.join(';'), maps: ['-map', '[v]', '-map', '[a]'] };
}

/** Total seconds of a span list. */
function spanSeconds(spans: Span[]): number {
  return spans.reduce((s, iv) => s + Math.max(0, iv.endSec - iv.startSec), 0);
}

/** Build the auditable evidence record attached to a produced cut. */
export function decisionEvidence(removeSpans: Span[], keptIntervals: Span[], reason: string, confidence = 0.9): DecisionEvidence {
  return {
    removed_spans: removeSpans.map((s) => ({ startSec: round3(s.startSec), endSec: round3(s.endSec) })),
    kept_intervals: keptIntervals.map((s) => ({ startSec: round3(s.startSec), endSec: round3(s.endSec) })),
    removed_count: removeSpans.length,
    removed_sec: round3(spanSeconds(removeSpans)),
    reason,
    confidence,
  };
}

// --- P3b: footage quality metrics (all from bundled ffmpeg, zero new deps) ---
//
// Calibrated on the bundled ffmpeg 6.0: `lavfi.blur` HIGHER = blurrier (sharp
// testsrc ≈ 5, boxblur ≈ 28); `signalstats.YAVG` is luma 0–255 (normal ≈ 125,
// dark ≈ 41). Blur is most reliable RELATIVELY (compare a clip's own takes), so
// the absolute `blurry` flag is a coarse default, tunable per source.

export interface QualityFrame {
  tSec: number;
  /** ffmpeg blurdetect `lavfi.blur` — higher = blurrier. */
  blur?: number;
  /** signalstats YAVG, luma 0–255 — exposure/brightness. */
  brightness?: number;
}

export interface QualityThresholds {
  /** Mean blur above this flags `blurry` (default 15; content-dependent). */
  blur?: number;
  /** Mean brightness below this flags `too_dark` (default 50, of 255). */
  darkBelow?: number;
  /** Mean brightness above this flags `too_bright` (default 200, of 255). */
  brightAbove?: number;
}

export interface QualityReport {
  durationSec: number;
  frames_analyzed: number;
  blur: { mean: number; min: number; max: number } | null;
  brightness: { mean: number; min: number; max: number } | null;
  black_sec: number;
  freeze_sec: number;
  black_spans: Span[];
  freeze_spans: Span[];
  flags: string[];
  /** Overall 0..1 (1 = clean); penalized per flag + black/freeze share of runtime. */
  score: number;
}

/** Per-frame `{tSec, blur?, brightness?}` from an ffmpeg `metadata=print` log. */
export function parseQualityFrames(log: string): QualityFrame[] {
  const frames: QualityFrame[] = [];
  let cur: QualityFrame | null = null;
  for (const line of log.split('\n')) {
    const tp = line.match(/pts_time:\s*([\d.]+)/);
    if (tp) {
      if (cur) frames.push(cur);
      cur = { tSec: round3(Number(tp[1])) };
      continue;
    }
    if (!cur) continue;
    const b = line.match(/lavfi\.blur=\s*([\d.]+)/);
    if (b) { cur.blur = round3(Number(b[1])); continue; }
    const y = line.match(/lavfi\.signalstats\.YAVG=\s*([\d.]+)/);
    if (y) { cur.brightness = round3(Number(y[1])); continue; }
  }
  if (cur) frames.push(cur);
  return frames;
}

/** Parse `<label>_start` / `<label>_end` events into spans (tolerant of `:` or
 *  `=`, same-line or split). Reused for blackdetect (`black_*`) and freezedetect
 *  (`freeze_*`). Pure. */
export function parseLabeledIntervals(log: string, label: string): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(`${label}_(start|end)[:=]\\s*(-?[\\d.]+)`, 'g');
  let openStart: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'start') openStart = v;
    else if (openStart !== null) {
      spans.push({ startSec: round3(Math.max(0, openStart)), endSec: round3(v) });
      openStart = null;
    }
  }
  return spans;
}

function stats(nums: number[]): { mean: number; min: number; max: number } | null {
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return { mean: round3(sum / nums.length), min: round3(Math.min(...nums)), max: round3(Math.max(...nums)) };
}

/** Aggregate per-frame quality + black/freeze spans into a flagged report with a
 *  0..1 score. Pure → fixtured. */
export function summarizeQuality(input: {
  durationSec: number;
  frames: QualityFrame[];
  blackSpans?: Span[];
  freezeSpans?: Span[];
  thresholds?: QualityThresholds;
}): QualityReport {
  const blurT = isNum(input.thresholds?.blur) ? (input.thresholds!.blur as number) : 15;
  const darkBelow = isNum(input.thresholds?.darkBelow) ? (input.thresholds!.darkBelow as number) : 50;
  const brightAbove = isNum(input.thresholds?.brightAbove) ? (input.thresholds!.brightAbove as number) : 200;

  const blur = stats(input.frames.map((f) => f.blur).filter((v): v is number => isNum(v)));
  const brightness = stats(input.frames.map((f) => f.brightness).filter((v): v is number => isNum(v)));
  const blackSpans = input.blackSpans ?? [];
  const freezeSpans = input.freezeSpans ?? [];
  const black_sec = round3(spanSeconds(blackSpans));
  const freeze_sec = round3(spanSeconds(freezeSpans));
  const dur = isNum(input.durationSec) && input.durationSec > 0 ? input.durationSec : 0;

  const flags: string[] = [];
  if (blur && blur.mean > blurT) flags.push('blurry');
  if (brightness && brightness.mean < darkBelow) flags.push('too_dark');
  if (brightness && brightness.mean > brightAbove) flags.push('too_bright');
  if (black_sec > 0) flags.push('has_black');
  if (freeze_sec > 0) flags.push('has_freeze');

  let score = 1;
  if (flags.includes('blurry')) score -= 0.3;
  if (flags.includes('too_dark') || flags.includes('too_bright')) score -= 0.3;
  if (dur > 0) {
    score -= Math.min(0.4, black_sec / dur);
    score -= Math.min(0.3, freeze_sec / dur);
  }
  score = Math.max(0, Math.min(1, round3(score)));

  const roundSpans = (ss: Span[]): Span[] => ss.map((s) => ({ startSec: round3(s.startSec), endSec: round3(s.endSec) }));
  return {
    durationSec: round3(dur),
    frames_analyzed: input.frames.length,
    blur,
    brightness,
    black_sec,
    freeze_sec,
    black_spans: roundSpans(blackSpans),
    freeze_spans: roundSpans(freezeSpans),
    flags,
    score,
  };
}

// --- P3c: best-take selection (deterministic dedup + ranking) ----------------
//
// The SELECTION of what to keep is the agent's judgment (grounded on the P3a/P3b
// signals via the stage-decide skill). What IS deterministic and worth a tool is
// de-duplicating REPEATED takes (the same line recorded several times) and
// ranking them by the measured quality — so the agent picks the best take from a
// structured answer instead of guessing. Pure → unit-tested + ports verbatim.

/** Normalized token set of a string (lowercase, punctuation stripped). */
function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Jaccard similarity of two strings' token sets, 0..1. Two empty strings = 1
 *  (identically empty); one empty = 0. Pure. */
export function textSimilarity(a: string, b: string): number {
  const A = tokenSet(a ?? '');
  const B = tokenSet(b ?? '');
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? round3(inter / union) : 0;
}

export interface Take {
  id: string;
  /** The take's transcript (used to detect repeats of the same line). */
  text?: string;
  /** P3b quality score 0..1 (higher = better); defaults to 0.5 when absent. */
  quality_score?: number;
  duration_sec?: number;
}

export interface TakeCluster {
  take_ids: string[];
  best_id: string;
  reason: string;
}
export interface TakeRanking {
  clusters: TakeCluster[];
  scores: Record<string, number>;
}

/** Composite take score — quality dominates; duration is a minor completeness
 *  tiebreaker (a more complete delivery, capped so a rambling long take is not
 *  rewarded). */
function scoreTake(t: Take): number {
  const q = isNum(t.quality_score) ? clamp(t.quality_score, 0, 1) : 0.5;
  const dur = isNum(t.duration_sec) && t.duration_sec > 0 ? t.duration_sec : 0;
  const completeness = Math.min(0.1, dur / 100);
  return round3(q * 0.9 + completeness);
}

/** Group takes that say the SAME thing (transcript similarity ≥ threshold) so
 *  repeats collapse into one cluster. A take with no text is its own cluster
 *  (nothing to compare on). Greedy single-link. Pure. */
export function clusterTakes(takes: Take[], opts: { threshold?: number } = {}): string[][] {
  const th = isNum(opts.threshold) ? opts.threshold : 0.6;
  const clusters: Array<{ ids: string[]; rep: string }> = [];
  for (const t of takes) {
    const text = (t.text ?? '').trim();
    if (!text) {
      clusters.push({ ids: [t.id], rep: '' });
      continue;
    }
    let placed = false;
    for (const c of clusters) {
      if (c.rep && textSimilarity(text, c.rep) >= th) {
        c.ids.push(t.id);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ ids: [t.id], rep: text });
  }
  return clusters.map((c) => c.ids);
}

/** De-duplicate repeated takes and pick the best of each cluster by quality +
 *  completeness. Returns the clusters (with the recommended `best_id` + reason)
 *  and every take's score. The selection of WHICH lines/moments to keep stays
 *  the agent's judgment; this only answers "given these repeats, which take?" */
export function rankTakes(takes: Take[], opts: { threshold?: number } = {}): TakeRanking {
  const scores: Record<string, number> = {};
  for (const t of takes) scores[t.id] = scoreTake(t);
  const groups = clusterTakes(takes, opts);
  const clusters: TakeCluster[] = groups.map((ids) => {
    let best = ids[0] ?? '';
    for (const id of ids) if ((scores[id] ?? 0) > (scores[best] ?? 0)) best = id;
    const reason =
      ids.length > 1
        ? `best of ${ids.length} repeated take(s) by quality/completeness (score ${scores[best] ?? 0})`
        : `single take (score ${scores[best] ?? 0})`;
    return { take_ids: ids, best_id: best, reason };
  });
  return { clusters, scores };
}

// ── Who is talking: motion inside each speaker's mouth box ─────────────────

/** A region to watch, as fractions of the frame: [left, top, right, bottom]. */
export interface ActivityRegion {
  id: string;
  box: [number, number, number, number];
}

export interface ActivityWindow {
  startSec: number;
  endSec: number;
  /** Mean frame-to-frame change inside each region (0–255 luma). */
  levels: Record<string, number>;
  /** The region clearly busier than the rest, or null when none is. */
  lead: string | null;
}

export interface ActivityTurn {
  startSec: number;
  endSec: number;
  regionId: string;
}

/** A window's lead must beat the runner-up by this factor. */
export const ACTIVITY_LEAD_RATIO = 1.5;
/** Turns shorter than this fold into a neighbour, so a "yeah" does not cause a cut. */
export const ACTIVITY_MIN_TURN_SEC = 1.0;
export const ACTIVITY_WINDOW_SEC = 0.5;
/** Motion is measured at 10 Hz, independently of the requested summary window. */
export const ACTIVITY_SAMPLE_RATE = 10;
/** Bound summary allocation/work, without imposing a sampling-based window minimum.
 *  100,000 windows cover 83 minutes at 50ms or almost 14 hours at the default. */
export const ACTIVITY_MAX_COMPUTED_WINDOWS = 100_000;

export function activityWindowCount(durationSec: number, windowSec: number): number {
  const count = Math.max(1, Math.ceil(durationSec / windowSec - 1e-9));
  if (!Number.isSafeInteger(count) || count > ACTIVITY_MAX_COMPUTED_WINDOWS) {
    throw new RangeError(`activity summary exceeds ${ACTIVITY_MAX_COMPUTED_WINDOWS} windows; use a larger window or a shorter clip.`);
  }
  return count;
}

/** Validate regions from the caller: 1–4, unique ids, boxes inside the frame. */
export function normalizeActivityRegions(raw: unknown): ActivityRegion[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return 'regions must be a list of 1 to 4 boxes';
  const out: ActivityRegion[] = [];
  for (const [index, item] of raw.entries()) {
    const o = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `r${index + 1}`;
    const box = Array.isArray(o.box) ? o.box.map(Number) : [];
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
      return `regions[${index}].box must be [left, top, right, bottom] as fractions of the frame`;
    }
    const [l, t, r, b] = box;
    if (r - l < 0.02 || b - t < 0.02) return `regions[${index}].box is too small or inverted`;
    if (out.some((region) => region.id === id)) return `regions[${index}].id "${id}" is used twice`;
    out.push({ id, box: [l, t, r, b] });
  }
  return out;
}

/**
 * Turn per-frame motion inside each region into windows and speaker turns.
 * A window's lead is the region busier than every other by `leadRatio`; a window
 * with no clear lead keeps the previous speaker, and turns shorter than
 * `minTurnSec` fold into the turn before them (or after, at the start). Motion is
 * a proxy for speech: it works on a still camera where each speaker's mouth stays
 * in its box, and says nothing about who is heard. Pure.
 */
export function summarizeActivity(
  series: Record<string, Array<{ tSec: number; value: number }>>,
  opts: { durationSec: number; windowSec?: number; leadRatio?: number; minTurnSec?: number },
): { windows: ActivityWindow[]; turns: ActivityTurn[] } {
  const ids = Object.keys(series);
  const windowSec = isNum(opts.windowSec) && opts.windowSec > 0 ? opts.windowSec : ACTIVITY_WINDOW_SEC;
  const leadRatio = isNum(opts.leadRatio) && opts.leadRatio > 1 ? opts.leadRatio : ACTIVITY_LEAD_RATIO;
  const minTurnSec = isNum(opts.minTurnSec) && opts.minTurnSec >= 0 ? opts.minTurnSec : ACTIVITY_MIN_TURN_SEC;
  let lastSample = 0;
  for (const id of ids) for (const sample of series[id]) lastSample = Math.max(lastSample, sample.tSec);
  const duration = isNum(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : lastSample;
  const count = activityWindowCount(duration, windowSec);
  const windows: ActivityWindow[] = [];
  for (let i = 0; i < count; i += 1) {
    const startSec = round3(i * windowSec);
    const endSec = round3(Math.min(duration, (i + 1) * windowSec));
    const levels: Record<string, number> = Object.create(null);
    for (const id of ids) levels[id] = 0;
    windows.push({ startSec, endSec, levels, lead: null });
  }
  // Locate each sample once. Binary search retains rounded, half-open boundaries
  // and input summation order even for unordered samples and zero-width windows.
  for (const id of ids) {
    const sums = new Float64Array(count);
    const samples = new Uint32Array(count);
    for (const sample of series[id]) {
      if (!isNum(sample.value) || !(sample.tSec >= windows[0].startSec && sample.tSec < windows[count - 1].endSec)) continue;
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (windows[mid].endSec <= sample.tSec) lo = mid + 1;
        else hi = mid;
      }
      sums[lo] += sample.value;
      samples[lo] += 1;
    }
    for (let i = 0; i < count; i += 1) {
      windows[i].levels[id] = samples[i] ? round3(sums[i] / samples[i]) : 0;
    }
  }
  for (const window of windows) {
    const { levels } = window;
    const ranked = [...ids].sort((a, b) => levels[b] - levels[a]);
    const top = ranked[0];
    const second = ranked.length > 1 ? levels[ranked[1]] : 0;
    const lead = top !== undefined && levels[top] > 0 && (ranked.length === 1 || levels[top] >= second * leadRatio) ? top : null;
    window.lead = lead;
  }
  // Hold the last clear speaker through windows with no lead.
  const firstLead = windows.find((w) => w.lead)?.lead ?? null;
  if (!firstLead) return { windows, turns: [] };
  let current = firstLead;
  const turns: ActivityTurn[] = [];
  for (const w of windows) {
    if (w.lead) current = w.lead;
    const last = turns[turns.length - 1];
    if (last && last.regionId === current) last.endSec = w.endSec;
    else turns.push({ startSec: w.startSec, endSec: w.endSec, regionId: current });
  }
  // Fold in chronological order. Only the first short turn folds forward;
  // every later short turn extends its already-settled predecessor.
  let first = 0;
  while (first < turns.length - 1 && turns[first].endSec - turns[first].startSec < minTurnSec) {
    turns[first + 1].startSec = turns[first].startSec;
    first += 1;
  }
  const folded: ActivityTurn[] = [];
  for (let i = first; i < turns.length; i += 1) {
    const turn = turns[i];
    const last = folded[folded.length - 1];
    if (last && (last.regionId === turn.regionId || turn.endSec - turn.startSec < minTurnSec)) last.endSec = turn.endSec;
    else folded.push(turn);
  }
  return { windows, turns: folded.map((t) => ({ ...t, startSec: round3(t.startSec), endSec: round3(t.endSec) })) };
}

/** What a reframe keeps centred for one stretch, as fractions of the source frame:
 *  from `startSec` until the next step. */
export interface FocusStep {
  startSec: number;
  centreX: number;
  centreY?: number;
}

/** Validate a reframe plan: 1–200 steps, the first at 0, rising starts, centres 0–1. */
export function normalizeFocusPlan(raw: unknown): FocusStep[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) return 'plan must be a list of 1 to 200 steps';
  const out: FocusStep[] = [];
  for (const [index, item] of raw.entries()) {
    const o = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const startSec = Number(o.start ?? o.start_sec ?? o.startSec);
    const centreX = Number(o.centre_x ?? o.center_x ?? o.centreX);
    const cy = o.centre_y ?? o.center_y ?? o.centreY;
    if (!Number.isFinite(startSec) || startSec < 0) return `plan[${index}].start must be a time in seconds`;
    if (!Number.isFinite(centreX) || centreX < 0 || centreX > 1) return `plan[${index}].centre_x must be between 0 and 1: the point to keep centred, as a fraction of the source width`;
    const step: FocusStep = { startSec, centreX };
    if (cy !== undefined) {
      const centreY = Number(cy);
      if (!Number.isFinite(centreY) || centreY < 0 || centreY > 1) return `plan[${index}].centre_y must be between 0 and 1`;
      step.centreY = centreY;
    }
    if (out.length && startSec <= out[out.length - 1].startSec) return `plan[${index}].start must be later than the step before it`;
    out.push(step);
  }
  if (out[0].startSec > 0.001) return 'plan must start at 0';
  return out;
}

/** A piecewise ffmpeg expression: `values[0]` until `steps[1]`, then `values[1]`, … */
export function piecewiseExpr(steps: FocusStep[], value: (s: FocusStep) => number): string {
  let expr = value(steps[steps.length - 1]).toFixed(4);
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    expr = `if(lt(t,${steps[i + 1].startSec.toFixed(3)}),${value(steps[i]).toFixed(4)},${expr})`;
  }
  return expr;
}
