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

const normToken = (s: string): string => s.toLowerCase().replace(/[^a-z']/g, '').trim();

/**
 * Spans to remove for filler words. A word matches only on EXACT normalized
 * equality (so "summary" never matches "um"); matched spans are padded by
 * `padSec`. Pure.
 */
export function fillerSpansFromWords(words: Word[], fillers: Iterable<string> = DEFAULT_FILLERS, opts: { padSec?: number } = {}): Span[] {
  const set = new Set(Array.from(fillers, (f) => normToken(f)));
  const padSec = isNum(opts.padSec) && opts.padSec >= 0 ? opts.padSec : 0.03;
  const spans: Span[] = [];
  for (const w of words) {
    if (!w || typeof w.text !== 'string' || !isNum(w.startSec) || !isNum(w.endSec)) continue;
    if (w.endSec <= w.startSec) continue;
    if (set.has(normToken(w.text))) {
      spans.push({ startSec: Math.max(0, w.startSec - padSec), endSec: w.endSec + padSec });
    }
  }
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

/**
 * Build the single-pass ffmpeg `-filter_complex` that keeps only `intervals` from
 * both video and audio (a jump-cut), re-stamping PTS so the kept pieces play
 * back-to-back. Throws if there is nothing to keep. Pure.
 */
export function buildKeepFilterComplex(intervals: Span[]): KeepFilter {
  const valid = intervals.filter((iv) => isNum(iv.startSec) && isNum(iv.endSec) && iv.endSec > iv.startSec);
  if (!valid.length) throw new Error('buildKeepFilterComplex: no intervals to keep');
  const expr = valid.map((iv) => `between(t,${iv.startSec.toFixed(3)},${iv.endSec.toFixed(3)})`).join('+');
  const filter = `[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='${expr}',asetpts=N/SR/TB[a]`;
  return { filter, maps: ['-map', '[v]', '-map', '[a]'] };
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
