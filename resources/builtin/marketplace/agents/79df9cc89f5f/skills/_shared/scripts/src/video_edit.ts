/**
 * video_edit — local backend for the `edit_video` tool (deterministic real-
 * footage editing). Runs the bundled ffmpeg/ffprobe (see util/bundled-runtime
 * `bundledFfmpegPaths`) — zero new dependencies, no network, no npx. This is
 * the deterministic editing capability axis; COMPOSE rendering is owned by the native
 * `video_studio` tool.
 *
 * Multi-op (per the design decision that edit_video is one multi-sub-op tool):
 *   probe | trim | concat | burnsubs | overlay | extract_frame | reframe | …
 * The tool layer owns path-sandbox validation; this backend trusts the
 * absolute paths it receives.
 *
 * Re-encode policy: trim/concat/burnsubs/overlay re-encode (libx264 -preset
 * veryfast) ON PURPOSE — trim needs frame-accurate cuts (not keyframe-snapped
 * -c copy), and concat must unify clips that may differ in codec/bitrate. Each
 * op is one lossy pass; chaining many ops on the SAME footage compounds loss,
 * but for generated/web-quality sources it's imperceptible. If a fast lossless
 * path is ever needed, add a probe-gated `-c copy` concat for identical inputs.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { bundledFfmpegPaths } from './bundled-runtime';
import { redactPaths } from './redact';
import { createLogger } from './logger-shim';
import {
  ACTIVITY_SAMPLE_RATE,
  keepIntervalsFromRemovals,
  complementIntervals,
  fillerSpansFromWords,
  normalizeTranscriptWords,
  buildKeepFilterComplex,
  parseSceneChanges,
  parseQualityFrames,
  parseLabeledIntervals,
  summarizeQuality,
  decisionEvidence,
  DEFAULT_FILLERS,
  normalizeFocusPlan,
  piecewiseExpr,
  type FocusStep,
  type ActivityRegion,
  type Span,
  type SceneCandidate,
  type DecisionEvidence,
  type QualityReport,
  type QualityThresholds,
} from './video_decide';

/** A finite, in-range number or undefined. */
function finiteNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const log = createLogger('video-edit');

/** Backstop for a wedged ffmpeg run. Editing real footage can be long; rely on
 *  the abort signal for normal cancellation. */
const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;

/** `mix` output is pinned to 48 kHz. TTS commonly emits 24 kHz and the loudnorm
 *  filter upsamples to 192 kHz internally — without an explicit trailing
 *  resample the muxed track inherits a non-standard rate (this is exactly the
 *  96 kHz artifact that shipped a broken draft). 48 kHz is the AAC/video
 *  delivery standard. */
const MIX_OUTPUT_SR = 48000;
/** Publish loudness targets (video-craft §7): ~-14 LUFS integrated, TP ≤ -1 dBTP. */
const MIX_LOUDNORM = { I: -14, TP: -1.0, LRA: 11 } as const;
/** silencedetect defaults: below -40 dB for ≥0.5 s counts as silence. */
const SILENCE_NOISE_DB = -40;
const SILENCE_MIN_SEC = 0.5;
/** Coverage thresholds — a voiceover should cover the clip it is laid over. */
const COVERAGE_TRAILING_GAP_SEC = 2.0; // silent tail after the narration ends
const COVERAGE_OVERSHOOT_SEC = 0.3;    // narration longer than the clip (gets cut)
const COVERAGE_LEAD_GAP_SEC = 3.0;     // long silent lead-in before narration starts
/** An interior hole this long between narration lines reads as dead air on a
 *  voiceover with no music bed — the 2026-08-05 draft had seven of them (up to
 *  6.9 s, 29.7 s of a 60 s cut silent) while coverage still reported 95%,
 *  because the old ratio only measured how FAR the narration reached. */
const COVERAGE_INTERIOR_GAP_SEC = 2.5;
const COVERAGE_MAX_REPORTED_GAPS = 12;
const MIX_COVERAGE_CONCURRENCY = 4;
const MIN_TRIM_OUTPUT_SEC = 0.1;
const RUN_PROGRESS_HEARTBEAT_MS = 15_000;
const RUN_PROGRESS_MIN_EMIT_MS = 2_000;

export type EditOp = 'probe' | 'trim' | 'concat' | 'burnsubs' | 'overlay' | 'extract_frame' | 'loudness' | 'normalize_loudness' | 'mix' | 'trim_silence' | 'remove_fillers' | 'reframe';

/** How `reframe` fits a source onto a canvas of another aspect ratio:
 *  `pad` keeps every pixel on solid bars, `blur` fills the bars with a blurred
 *  copy of the frame, `crop` fills the canvas and cuts the overflowing edges. */
export type ReframeMode = 'pad' | 'crop' | 'blur';

/** What a reframe changed, so the caller can report it and check the frame. */
export interface ReframeReport {
  mode: ReframeMode;
  canvas: string;
  from: string | null;
  focus?: { x: number; y: number };
  /** The point kept centred per stretch, when the reframe followed a plan. */
  plan?: Array<{ start: number; centre_x: number; centre_y: number }>;
  pad_color?: string;
  note?: string;
}

/** ebur128 loudness measurement (video-craft §7 targets: ~-14 LUFS integrated,
 *  true-peak ≤ ~-1 dBTP). A field is null when the source is silent (ffmpeg
 *  prints `-inf`). */
export interface LoudnessResult {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbfs: number | null;
}

/** One detected silent interval (seconds). */
export interface SilenceInterval { startSec: number; endSec: number }

/** Voiced/silence timing of one media file, derived from ffmpeg silencedetect. */
export interface SilenceTiming {
  durationSec: number;
  voicedStartSec: number;     // first non-silent moment
  voicedEndSec: number;       // last non-silent moment
  voicedDurationSec: number;  // total non-silent time
  leadingSilenceSec: number;
  trailingSilenceSec: number;
  silences: SilenceInterval[];
}

/** How well an added voiceover covers the clip it is laid over. */
export interface CoverageReport {
  referenceDurationSec: number;
  voicedStartSec: number;  // on the clip timeline (offset-shifted)
  voicedEndSec: number;
  leadingGapSec: number;   // silence before the narration starts
  trailingGapSec: number;  // silence after the narration ends
  overshootSec: number;    // narration length beyond the clip (>0 ⇒ truncated)
  coverageRatio: number;   // how far into the clip the narration reaches (0..1)
  /** Share of the clip that actually carries voice (0..1). `coverageRatio`
   *  says the narration ENDS near the end; this says how much of the middle
   *  is dead air. The two disagreeing is exactly the shipped defect. */
  voicedRatio: number;
  /** Interior silent holes between voiced spans (clip timeline, ≥0.5 s),
   *  largest first, capped at COVERAGE_MAX_REPORTED_GAPS. */
  interiorGaps: Array<{ startSec: number; endSec: number; durationSec: number }>;
  maxInteriorGapSec: number;
  /** Seconds two lines speak at once, and how many line pairs collide. A
   *  line whose audio runs past the next line's start mixes as double
   *  narration — the 2026-08-06 delivery carried up to 1.48 s of it. */
  maxOverlapSec: number;
  overlapCount: number;
  status: 'ok' | 'under' | 'over' | 'silent' | 'gapped' | 'overlapped';
  warnings: string[];
}

export interface EditParams {
  op: EditOp;
  /** Single input (probe / trim / burnsubs; overlay/mix base). */
  inputAbsPath?: string;
  /** Multiple inputs in order (concat). */
  inputAbsPaths?: string[];
  /** mix: the narration/music audio laid over the base video. */
  audioAbsPath?: string;
  /** mix: place MULTIPLE narration lines, each delayed to its own `startSec`
   *  (multi-adelay = per-line placement, so plan.json's per-line `start_sec`
   *  actually lands on its scene). Takes precedence over audioAbsPath/start
   *  when non-empty. */
  audioSegments?: Array<{ audioAbsPath: string; startSec?: number; endSec?: number }>;
  /** mix: what to do when the BASE video already carries an audio track.
   *  - 'reject' (DEFAULT): fail — prevents silently stacking a SECOND narration
   *    onto a base that already has one (e.g. a compose render that baked it in;
   *    the "two voices" defect).
   *  - 'mix': intentionally layer (music under a talking-head's built-in voice).
   *  - 'replace': drop the base audio, keep only the added narration. */
  onExistingAudio?: 'reject' | 'mix' | 'replace';
  /** mix with on_existing_audio 'mix': lower the base under the added audio. */
  duck?: boolean;
  /** Output path (all ops except probe / loudness). */
  outputAbsPath?: string;
  /** trim: seconds. mix: lead-in offset (delay) for the added audio. */
  start?: number;
  duration?: number;
  /** burnsubs: subtitle file (.srt/.ass). */
  subtitlesAbsPath?: string;
  /** burnsubs: a band of the picture, as fractions of its height from the top, to cover with
   *  an opaque bar before the captions go on it: captions already burned into the source. */
  cover?: { top: number; bottom: number };
  /** overlay: the overlaid media + position (px, defaults 0,0). */
  overlayAbsPath?: string;
  x?: number;
  y?: number;
  /** trim_silence: silence threshold dB (default -40) and the shortest silence to
   *  cut (default 0.5s). */
  noiseDb?: number;
  minSilenceSec?: number;
  /** trim_silence / remove_fillers: breathing-room kept at each cut (default 0.1s
   *  for silence) and the smallest kept sliver (default 0.3s). */
  padSec?: number;
  minKeepSec?: number;
  /** remove_fillers: the video_studio speech.transcribe JSON (word-level timings) and the
   *  filler tokens to drop (default um/uh/...). */
  transcriptAbsPath?: string;
  fillers?: string[];
  /** reframe: target aspect (`9:16`, `1:1`, `4:5`, `16:9`, any `W:H`) or an
   *  explicit canvas (both width and height, which win over aspect); how to
   *  fit (default pad); crop focus 0..1 per axis (default centre); bar colour. */
  aspect?: string;
  width?: number;
  height?: number;
  mode?: ReframeMode;
  focusX?: number;
  focusY?: number;
  /** reframe (crop): the point to keep centred per stretch, `[{start, centre_x, centre_y?}]`
   *  as fractions of the source, each holding until the next start, so a cut can
   *  follow whoever is speaking. */
  focusPlan?: unknown;
  padColor?: string;
  signal?: AbortSignal;
}

export type EditResult =
  | { ok: true; op: EditOp; path?: string; bytes?: number; probe?: unknown; loudness?: LoudnessResult; coverage?: CoverageReport; decision?: DecisionEvidence; reframe?: ReframeReport }
  | { ok: false; errorCode: string; message: string };

/** Platform-standard canvases for the aspect ratios people post at. A known
 *  ratio always lands on the same size, so a batch of reframes matches: the
 *  2026-10-26 live runs that hand-wrote the command picked 1152x2048 and
 *  1440x2560 for the same 9:16 request. Any other ratio keeps a 1920 long side. */
const REFRAME_STANDARD_CANVASES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1080, height: 1920 }, // 9:16
  { width: 1920, height: 1080 }, // 16:9
  { width: 1080, height: 1080 }, // 1:1
  { width: 1080, height: 1350 }, // 4:5
  { width: 1080, height: 1440 }, // 3:4
  { width: 1440, height: 1080 }, // 4:3
];
const REFRAME_LONG_SIDE = 1920;
const REFRAME_MIN_SIDE = 16;
const REFRAME_MAX_SIDE = 7680;

function evenFloor(n: number): number {
  return Math.floor(n / 2) * 2;
}

/** Resolve the reframe canvas from an explicit size or an aspect ratio.
 *  Sides are rounded down to even numbers (yuv420p H.264 needs them).
 *  Pure → unit-tested. */
export function reframeCanvas(opts: { aspect?: string; width?: number; height?: number }):
  { ok: true; width: number; height: number } | { ok: false; message: string } {
  const w = finiteNum(opts.width);
  const h = finiteNum(opts.height);
  const inRange = (width: number, height: number) => (
    width >= REFRAME_MIN_SIDE && height >= REFRAME_MIN_SIDE && width <= REFRAME_MAX_SIDE && height <= REFRAME_MAX_SIDE
  );
  if (w !== undefined || h !== undefined) {
    if (w === undefined || h === undefined) {
      return { ok: false, message: 'reframe needs both width and height, or an aspect such as 9:16.' };
    }
    const width = evenFloor(w);
    const height = evenFloor(h);
    if (!inRange(width, height)) {
      return { ok: false, message: `reframe canvas must be ${REFRAME_MIN_SIDE}-${REFRAME_MAX_SIDE}px per side; got ${w}x${h}.` };
    }
    return { ok: true, width, height };
  }
  const raw = String(opts.aspect ?? '').trim();
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/i);
  const aw = m ? Number(m[1]) : NaN;
  const ah = m ? Number(m[2]) : NaN;
  if (!(aw > 0) || !(ah > 0)) {
    return { ok: false, message: `reframe needs an aspect such as 9:16, 1:1, 4:5 or 16:9, or both width and height; got ${raw || 'none'}.` };
  }
  const ratio = aw / ah;
  const standard = REFRAME_STANDARD_CANVASES.find((c) => Math.abs(c.width / c.height - ratio) < 1e-6);
  if (standard) return { ok: true, width: standard.width, height: standard.height };
  const width = ratio >= 1 ? REFRAME_LONG_SIDE : evenFloor(REFRAME_LONG_SIDE * ratio);
  const height = ratio >= 1 ? evenFloor(REFRAME_LONG_SIDE / ratio) : REFRAME_LONG_SIDE;
  if (!inRange(width, height)) {
    return { ok: false, message: `aspect ${raw} is too extreme for a ${REFRAME_LONG_SIDE}px long side.` };
  }
  return { ok: true, width, height };
}

/** Normalise a bar colour to an ffmpeg colour token, or null when it is not a
 *  plain name or 6-digit hex (the value goes into a filter graph). */
export function reframePadColor(raw: string | undefined): string | null {
  const value = String(raw ?? 'black').trim();
  const hex = value.match(/^(?:#|0x)?([0-9a-f]{6})$/i);
  if (hex) return `0x${hex[1].toLowerCase()}`;
  return /^[a-z]{3,20}$/i.test(value) ? value.toLowerCase() : null;
}

/** The ffmpeg filter for a reframe. Every chain first squares the pixels
 *  (anamorphic sources would otherwise come out stretched) and ends on
 *  square-pixel yuv420p so the result plays on every platform. `blur` needs a
 *  filter_complex whose output is `[rfv]`. Pure → unit-tested. */
export function buildReframeFilter(opts: {
  mode: ReframeMode;
  width: number;
  height: number;
  focusX?: number;
  focusY?: number;
  /** crop only: the point to keep centred per stretch, overriding focusX/focusY. */
  plan?: FocusStep[];
  padColor?: string;
}): { filter: string; complex: boolean } {
  const W = opts.width;
  const H = opts.height;
  const squarePixels = 'scale=trunc(iw*sar/2)*2:ih,setsar=1';
  const tail = 'setsar=1,format=yuv420p';
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const fill = `scale=${W}:${H}:force_original_aspect_ratio=increase`;
  if (opts.mode === 'crop') {
    const fx = clamp(finiteNum(opts.focusX) ?? 0.5, 0, 1);
    const fy = clamp(finiteNum(opts.focusY) ?? 0.5, 0, 1);
    if (opts.plan && opts.plan.length) {
      // `t` is the source time of each frame; the window cuts at each step's start
      // to keep that step's point centred, stopping at the frame edges.
      const ex = piecewiseExpr(opts.plan, (s) => s.centreX);
      const ey = piecewiseExpr(opts.plan, (s) => s.centreY ?? 0.5);
      return { complex: false, filter: `${squarePixels},${fill},crop=${W}:${H}:x='clip(iw*${ex}-ow/2,0,iw-ow)':y='clip(ih*${ey}-oh/2,0,ih-oh)',${tail}` };
    }
    return { complex: false, filter: `${squarePixels},${fill},crop=${W}:${H}:(iw-ow)*${fx}:(ih-oh)*${fy},${tail}` };
  }
  if (opts.mode === 'blur') {
    const radius = Math.max(2, Math.floor(Math.min(W, H) / 24));
    return {
      complex: true,
      filter: `[0:v]${squarePixels},split=2[rfbg][rffg];`
        + `[rfbg]${fill},crop=${W}:${H},boxblur=${radius}:2[rfback];`
        + `[rffg]${fit}[rffront];`
        + `[rfback][rffront]overlay=(W-w)/2:(H-h)/2,${tail}[rfv]`,
    };
  }
  const color = reframePadColor(opts.padColor) ?? 'black';
  return { complex: false, filter: `${squarePixels},${fit},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${color},${tail}` };
}

/** Parse the `[Parsed_ebur128_…] Summary:` block ffmpeg prints to stderr.
 *  `-inf` (silent source) maps to null. Returns null when no summary block is
 *  present (no measurable result), which fails the caller closed rather than
 *  reporting a number that is not a measurement.
 *
 *  Scoped to the summary on purpose. ebur128 also logs a running line every
 *  100ms carrying `I:` and `LRA:`, and the first one always reads `I: -70.0
 *  LUFS  LRA: 0.0 LU` because nothing has been integrated yet. Matching those
 *  first made every measurement report -70 LUFS / 0 LU: the 2026-08-10 AUTO
 *  delivery measured -13.8 LUFS and was reported as -70, i.e. silence. True
 *  peak was right by accident — `Peak:` appears only in the summary. The old
 *  fixtures held a bare summary with no running lines, so they could not see
 *  it; the shapes below are real ffmpeg output. */
export function parseEbur128Summary(stderr: string): LoudnessResult | null {
  // ffmpeg prints one summary per ebur128 instance. The last one belongs to
  // the measurement that just finished.
  const summaryAt = stderr.toLowerCase().lastIndexOf('summary:');
  if (summaryAt < 0) return null;
  const summary = stderr.slice(summaryAt);
  const num = (re: RegExp): number | null => {
    const m = summary.match(re);
    if (!m) return null;
    if (/inf/i.test(m[1])) return null; // -inf for a silent source
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  // Within the summary `I:` is unique to the integrated line; LRA/Peak
  // likewise. Values can be negative or `-inf`. Order is Integrated → Range →
  // True peak.
  const hasIntegrated = /\bI:\s*(-?(?:inf|[\d.]+))\s*LUFS/i.test(summary);
  if (!hasIntegrated) return null;
  return {
    integratedLufs: num(/\bI:\s*(-?(?:inf|[\d.]+))\s*LUFS/i),
    loudnessRangeLu: num(/\bLRA:\s*(-?(?:inf|[\d.]+))\s*LU\b/i),
    truePeakDbfs: num(/\bPeak:\s*(-?(?:inf|[\d.]+))\s*dBFS/i),
  };
}

/** Escape an unquoted option value through both FFmpeg parsers: the option
 * parser consumes colon/backslash/quote escapes after the filtergraph parser. */
export function escapeFfmpegFilterValue(value: string): string {
  return value
    .replace(/[\\':\s]/g, '\\$&')
    .replace(/[\\'\[\],;\s]/g, '\\$&');
}

/** Round to 2 decimals (display-friendly seconds). */
function round2(n: number): number { return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100; }
function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export function validateTrimRequest(inputDurationSec: number, startSec: number, durationSec: number): EditResult | null {
  if (durationSec < MIN_TRIM_OUTPUT_SEC) {
    return fail('E_EDIT_TRIM_RANGE', `trim duration must be at least ${MIN_TRIM_OUTPUT_SEC}s; got ${round2(durationSec)}s.`);
  }
  if (Number.isFinite(inputDurationSec) && inputDurationSec > 0) {
    const remaining = inputDurationSec - startSec;
    if (remaining < MIN_TRIM_OUTPUT_SEC) {
      return fail(
        'E_EDIT_TRIM_RANGE',
        `trim start ${round2(startSec)}s is outside or too close to the end of the ${round2(inputDurationSec)}s input; choose a start at least ${MIN_TRIM_OUTPUT_SEC}s before the end.`,
      );
    }
  }
  return null;
}

/** Parse ffmpeg `silencedetect` stderr into a voiced/silence timing map. ffmpeg
 *  prints `silence_start: X` then `silence_end: Y | silence_duration: Z`; a
 *  silence that runs to EOF still prints an end at ~duration (it can read a hair
 *  past `durationSec` on a padded track). `durationSec` is the media duration
 *  from ffprobe, used to resolve leading/trailing. Pure → unit-tested. */
export function parseSilenceDetect(stderr: string, durationSec: number): SilenceTiming {
  const EPS_LEAD = 0.05;   // a silence starting within 50 ms of 0 is "leading"
  const EPS_TAIL = 0.30;   // a silence ending within 300 ms of EOF is "trailing"
  const tokens: Array<{ kind: 'start' | 'end'; t: number }> = [];
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[2]);
    if (Number.isFinite(t)) tokens.push({ kind: m[1] as 'start' | 'end', t });
  }
  const silences: SilenceInterval[] = [];
  let openStart: number | null = null;
  for (const tk of tokens) {
    if (tk.kind === 'start') {
      openStart = tk.t;
    } else if (openStart !== null) {
      silences.push({ startSec: Math.max(0, openStart), endSec: tk.t });
      openStart = null;
    }
  }
  const dur = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : (silences.length ? silences[silences.length - 1].endSec : 0);
  // A trailing start with no matching end → silence runs to EOF.
  if (openStart !== null) silences.push({ startSec: Math.max(0, openStart), endSec: dur });

  const first = silences[0];
  const last = silences.length ? silences[silences.length - 1] : undefined;
  const leadingSilenceSec = first && first.startSec <= EPS_LEAD ? Math.min(first.endSec, dur) : 0;
  const trailingSilenceSec = last && last.endSec >= dur - EPS_TAIL ? Math.max(0, dur - last.startSec) : 0;
  const totalSilence = silences.reduce((s, iv) => s + Math.max(0, Math.min(iv.endSec, dur) - iv.startSec), 0);
  const voicedDurationSec = Math.max(0, dur - totalSilence);
  const voicedStartSec = leadingSilenceSec;
  const voicedEndSec = Math.max(voicedStartSec, dur - trailingSilenceSec);
  return { durationSec: dur, voicedStartSec, voicedEndSec, voicedDurationSec, leadingSilenceSec, trailingSilenceSec, silences };
}

/** Assess how well a voiceover's voiced span covers the clip it sits on. Flags
 *  the two failure modes that shipped silently: a silent tail (narration ends
 *  well before the clip) and overshoot (narration longer than the clip, so the
 *  -shortest mux truncates it). Pure → unit-tested. */
export function assessVoiceoverCoverage(input: {
  referenceDurationSec: number;
  offsetSec?: number;
  audioDurationSec: number;
  voicedStartSec: number;
  voicedEndSec: number;
  /** Voiced spans on the clip timeline (already offset-shifted). When
   *  provided, interior holes between them are measured; without them the
   *  report can only see the head and tail, which is how a half-silent draft
   *  once scored 95%. */
  voicedSpans?: Array<{ startSec: number; endSec: number }>;
  /** Explicit fixed picture windows: report gaps without suggesting a picture edit. */
  preservePicture?: boolean;
}): CoverageReport {
  const ref = Math.max(0, input.referenceDurationSec);
  const offset = Math.max(0, input.offsetSec ?? 0);
  const voicedStart = offset + Math.max(0, input.voicedStartSec);
  const voicedEnd = offset + Math.max(0, input.voicedEndSec);
  const hasVoice = (input.voicedEndSec - input.voicedStartSec) > 0.05 && input.audioDurationSec > 0.05;
  const leadingGapSec = round2(voicedStart);
  const trailingGapSec = round2(ref - voicedEnd);
  const overshootSec = round2(offset + input.audioDurationSec - ref);
  const coverageRatio = ref > 0 ? round2(clamp(voicedEnd / ref, 0, 1)) : 0;
  // Merge the spans and measure what sits between them. Only holes ≥0.5 s
  // count — natural inter-phrase pauses are not dead air.
  const spans = (input.voicedSpans ?? [])
    .map((sp) => ({ startSec: Math.max(0, sp.startSec), endSec: Math.min(ref, sp.endSec) }))
    .filter((sp) => sp.endSec - sp.startSec > 0.05)
    .sort((a, z) => a.startSec - z.startSec);
  const merged: Array<{ startSec: number; endSec: number }> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.startSec <= last.endSec + 0.05) last.endSec = Math.max(last.endSec, sp.endSec);
    else merged.push({ ...sp });
  }
  // Overlaps are measured on the RAW spans, before merging: merging is what
  // hides a collision, and a collision is exactly what must be reported.
  let maxOverlapSec = 0;
  let overlapCount = 0;
  for (let i = 1; i < spans.length; i += 1) {
    const collide = spans[i - 1].endSec - spans[i].startSec;
    if (collide > 0.05) {
      overlapCount += 1;
      maxOverlapSec = Math.max(maxOverlapSec, collide);
    }
  }
  maxOverlapSec = round2(maxOverlapSec);
  const interiorGaps: CoverageReport['interiorGaps'] = [];
  for (let i = 1; i < merged.length; i += 1) {
    const gap = merged[i].startSec - merged[i - 1].endSec;
    if (gap >= 0.5) {
      interiorGaps.push({
        startSec: round2(merged[i - 1].endSec),
        endSec: round2(merged[i].startSec),
        durationSec: round2(gap),
      });
    }
  }
  interiorGaps.sort((a, z) => z.durationSec - a.durationSec);
  interiorGaps.length = Math.min(interiorGaps.length, COVERAGE_MAX_REPORTED_GAPS);
  const maxInteriorGapSec = interiorGaps.length ? interiorGaps[0].durationSec : 0;
  const voicedTotal = merged.reduce((sum, sp) => sum + (sp.endSec - sp.startSec), 0);
  const voicedRatio = ref > 0
    ? round2(clamp((merged.length ? voicedTotal : Math.max(0, voicedEnd - voicedStart)) / ref, 0, 1))
    : 0;
  const warnings: string[] = [];
  let status: CoverageReport['status'] = 'ok';
  if (!hasVoice) {
    status = 'silent';
    warnings.push('No speech detected in the added audio — the mux produced a silent or near-silent track.');
  } else {
    if (overshootSec > COVERAGE_OVERSHOOT_SEC) {
      status = 'over';
      warnings.push(`Narration runs ${overshootSec}s past the ${round2(ref)}s clip and was truncated to fit — shorten the script so it ends before the clip does (trim the words; do not just raise speed).`);
    }
    if (trailingGapSec > COVERAGE_TRAILING_GAP_SEC) {
      if (status === 'ok') status = 'under';
      const pct = ref > 0 ? Math.round((trailingGapSec / ref) * 100) : 0;
      warnings.push(`The added audio ends at ${round2(voicedEnd)}s, leaving ${trailingGapSec}s not covered by this audio on a ${round2(ref)}s clip (~${pct}% uncovered).`
        + (input.preservePicture ? ' The declared picture timing is retained.' : '')
        + ' Audio coverage alone does not establish missing narration or an intended pause.');
    }
    if (leadingGapSec > COVERAGE_LEAD_GAP_SEC) {
      warnings.push(`The added audio starts at ${leadingGapSec}s; its measured audio span does not cover 0–${leadingGapSec}s.`
        + (input.preservePicture ? ' The declared picture timing is retained.' : ''));
    }
    if (overlapCount > 0 && maxOverlapSec > 0.3) {
      // Double narration outranks everything except truncation: two voices at
      // once is broken audio, not a style choice.
      if (status !== 'over') status = 'overlapped';
      warnings.push(`${overlapCount} narration line pair(s) overlap by up to ${maxOverlapSec}s — two lines speak at once. A line's audio must end before the next line's start_sec; shorten the colliding lines or move their windows, and check that target_sec is each line's DURATION, not its end time.`);
    }
    if (maxInteriorGapSec > COVERAGE_INTERIOR_GAP_SEC) {
      // Interior dead air outranks a short tail: 'under' describes a missing
      // ending, 'gapped' a broken middle, and the middle is what listeners
      // hear first. Truncation ('over') and double voice keep priority.
      if (status === 'ok' || status === 'under') status = 'gapped';
      const silentTotal = round2(interiorGaps.reduce((sum, g) => sum + g.durationSec, 0));
      warnings.push(`The added audio leaves ${interiorGaps.length} interior uncovered interval(s) totalling ${silentTotal}s (largest ${maxInteriorGapSec}s).`
        + (input.preservePicture ? ' The declared picture timing is retained.' : '')
        + ' Audio coverage alone does not establish missing narration or intended pauses.');
    }
  }
  return { referenceDurationSec: round2(ref), voicedStartSec: round2(voicedStart), voicedEndSec: round2(voicedEnd), leadingGapSec, trailingGapSec, overshootSec, coverageRatio, voicedRatio, interiorGaps, maxInteriorGapSec, maxOverlapSec, overlapCount, status, warnings };
}

/** Build the `-filter_complex` for `mix`. ffmpeg input order is FIXED: `[0]` is
 *  the base video, `[1..N]` are the narration/music segments in
 *  `segmentStartSec` order. Each segment is resampled and `adelay`-ed to its own
 *  start (multi-adelay = per-line placement, so plan.json's per-line `start_sec`
 *  actually lands on its scene); the placed segments `amix` into one bed, which
 *  is then padded to the clip length and loudness-normalized.
 *
 *  `baseHasAudio` + `mode` decide how the base's OWN audio is treated:
 *   - base silent           → just the narration bed (mode ignored).
 *   - baseHasAudio + 'mix'  → amix base + bed (keep a talking-head's built-in voice).
 *   - baseHasAudio + 'replace' → base audio is simply not mapped in; bed only.
 *  Pure → unit-tested. */
export function buildMixFilter(opts: {
  sr: number;
  segmentStartSec: number[];
  baseHasAudio: boolean;
  mode: 'mix' | 'replace';
  padWholeDurSec: number | null;
  loudnorm: string;
  /** Lower the base's own sound while the added segments play (narration over
   *  kept dialogue or ambience), as the timeline ducks music under speech. */
  duck?: boolean;
}): string {
  const { sr, segmentStartSec, baseHasAudio, mode, padWholeDurSec, loudnorm, duck } = opts;
  const chains: string[] = [];
  const segLabels: string[] = [];
  segmentStartSec.forEach((startSec, i) => {
    const idx = i + 1; // [0] is the base video; audio inputs start at [1]
    const parts = [`[${idx}:a]aresample=${sr}`];
    const ms = Math.round(Math.max(0, startSec) * 1000);
    if (ms > 0) parts.push(`adelay=${ms}:all=1`);
    chains.push(`${parts.join(',')}[seg${i}]`);
    segLabels.push(`[seg${i}]`);
  });
  // Collapse the placed segments into one narration bed.
  let bed: string;
  if (segLabels.length <= 1) {
    bed = segLabels[0] ?? '';
  } else {
    chains.push(`${segLabels.join('')}amix=inputs=${segLabels.length}:duration=longest:normalize=0[vobed]`);
    bed = '[vobed]';
  }
  // Pad bounded to the clip length (never open-ended apad — that would never EOF
  // and `-shortest` + `-c:v copy` would spin forever generating silence), then
  // loudnorm + a trailing resample (loudnorm upsamples to 192 kHz internally).
  // The trailing aformat pins stereo with a known layout — see the identical
  // note on normalize_loudness; without it a TTS-only (all-mono) mix writes a
  // track its own loudness pass cannot process.
  const tail = `${padWholeDurSec && padWholeDurSec > 0 ? `apad=whole_dur=${padWholeDurSec.toFixed(3)},` : ''}${loudnorm},aresample=${sr},aformat=channel_layouts=stereo`;
  if (baseHasAudio && mode === 'mix' && duck) {
    // Same keying as the timeline's music duck: the added bed drives a sidechain
    // compressor on the base, so the base dips only while something is said.
    // sidechaincompress stops at the FIRST input to end, so the key is padded
    // with silence: otherwise the base is cut off where the last added segment
    // ends. Open-ended apad is safe here (unlike on the output) because the
    // compressor still ends with the base.
    // Align the split source, padded key and base before either branch drains.
    // The known duration or the caller's video-master -shortest removes padding.
    const keyPad = padWholeDurSec && padWholeDurSec > 0 ? `apad=whole_dur=${padWholeDurSec.toFixed(3)}` : 'apad';
    chains.push(`${bed}asetnsamples=n=1024:p=1,asplit=2[bedmix][bedkey0]`);
    chains.push(`[bedkey0]${keyPad},asetnsamples=n=1024:p=1[bedkey]`);
    chains.push(`[0:a]aresample=${sr},asetnsamples=n=1024:p=1[base0]`);
    chains.push(`[base0][bedkey]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[base]`);
    chains.push(`[base][bedmix]amix=inputs=2:duration=longest:normalize=0,${tail}${padWholeDurSec && padWholeDurSec > 0 ? `,atrim=duration=${padWholeDurSec.toFixed(3)}` : ''}[aout]`);
  } else if (baseHasAudio && mode === 'mix') {
    chains.push(`[0:a]aresample=${sr}[base]`);
    chains.push(`[base]${bed}amix=inputs=2:duration=longest:normalize=0,${tail}[aout]`);
  } else {
    // silent base, or 'replace' (the base audio is never mapped into the graph)
    chains.push(`${bed}${tail}[aout]`);
  }
  return chains.join(';');
}

function totalSpanSeconds(spans: Span[]): number {
  return spans.reduce((sum, iv) => sum + Math.max(0, iv.endSec - iv.startSec), 0);
}

function resolveBins(): { ffmpeg: string; ffprobe: string } | null {
  const b = bundledFfmpegPaths();
  if (!b.ffmpeg || !b.ffprobe) return null;
  return { ffmpeg: b.ffmpeg, ffprobe: b.ffprobe };
}

type RunProgressOptions = {
  op: string;
  phase?: 'analyze' | 'edit' | 'validate';
  durationSec?: number | null;
  heartbeatMs?: number;
};

function parseProgressClock(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (![h, min, sec].every(Number.isFinite)) return null;
  return h * 3600 + min * 60 + sec;
}

export function parseFfmpegProgressTimeSec(fields: Record<string, string>): number | null {
  for (const key of ['out_time_us', 'out_time_ms']) {
    const raw = fields[key];
    if (!raw) continue;
    const micros = Number(raw);
    if (Number.isFinite(micros) && micros >= 0) return micros / 1_000_000;
  }
  return parseProgressClock(fields.out_time);
}

function emitRunProgress(progress: RunProgressOptions, event: Record<string, unknown>): void {
  const payload = {
    type: 'progress',
    source: 'video_edit',
    op: progress.op,
    phase: progress.phase ?? 'edit',
    ...event,
  };
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Progress is best-effort; never let telemetry break the media operation.
  }
}

function withFfmpegProgress(args: string[]): string[] {
  return args.includes('-progress') ? args : ['-progress', 'pipe:2', ...args];
}

/** Spawn a bundled binary, capture stdout/stderr, resolve on exit. */
function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  progress?: RunProgressOptions,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { ...(signal ? { signal } : {}) });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false });
      return;
    }
    const out: string[] = [];
    const errChunks: string[] = [];
    let timedOut = false;
    const startedAtMs = Date.now();
    let lastProgressEmitMs = 0;
    let progressFields: Record<string, string> = {};
    let progressLineBuffer = '';
    const heartbeat = progress
      ? setInterval(() => {
          emitRunProgress(progress, {
            status: 'heartbeat',
            elapsed_sec: round2((Date.now() - startedAtMs) / 1000),
          });
        }, progress.heartbeatMs ?? RUN_PROGRESS_HEARTBEAT_MS)
      : null;
    heartbeat?.unref?.();

    const emitFfmpegProgress = (status: string, force = false) => {
      if (!progress) return;
      const now = Date.now();
      if (!force && now - lastProgressEmitMs < RUN_PROGRESS_MIN_EMIT_MS) return;
      lastProgressEmitMs = now;
      const processedSec = parseFfmpegProgressTimeSec(progressFields);
      const configuredDurationSec = progress.durationSec;
      const durationSec = typeof configuredDurationSec === 'number' && Number.isFinite(configuredDurationSec) && configuredDurationSec > 0
        ? configuredDurationSec
        : null;
      emitRunProgress(progress, {
        status: status === 'end' ? 'completed' : 'running',
        elapsed_sec: round2((now - startedAtMs) / 1000),
        ...(processedSec !== null ? { processed_sec: round2(processedSec) } : {}),
        ...(status === 'end'
          ? { percent: 100 }
          : processedSec !== null && durationSec
            ? { percent: round2(clamp((processedSec / durationSec) * 100, 0, 100)) }
            : {}),
      });
    };

    const ingestProgressChunk = (text: string) => {
      if (!progress) return;
      progressLineBuffer += text.replace(/\r/g, '\n');
      const lines = progressLineBuffer.split('\n');
      progressLineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.trim().match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (!m) continue;
        progressFields[m[1]] = m[2];
        if (m[1] === 'progress') {
          emitFfmpegProgress(m[2], m[2] === 'end');
          if (m[2] === 'end') progressFields = {};
        }
      }
    };

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, FFMPEG_TIMEOUT_MS);
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (progress && result.code !== 0) {
        emitRunProgress(progress, {
          status: result.aborted ? 'aborted' : result.timedOut ? 'timed_out' : 'failed',
          elapsed_sec: round2((Date.now() - startedAtMs) / 1000),
          code: result.code,
        });
      }
      resolve(result);
    };

    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      errChunks.push(text);
      ingestProgressChunk(text);
    });
    child.stdin?.end();
    child.on('error', (err) => {
      finish({ code: -1, stdout: out.join(''), stderr: err.message, timedOut, aborted: !!signal?.aborted });
    });
    child.on('close', (code) => {
      finish({ code, stdout: out.join(''), stderr: errChunks.join(''), timedOut, aborted: !!signal?.aborted });
    });
  });
}

async function statSize(p: string): Promise<number> {
  const st = await fs.stat(p).catch(() => null);
  return st && st.isFile() ? st.size : 0;
}

async function validateTrimOutput(
  ffprobe: string,
  outputAbsPath: string,
  signal?: AbortSignal,
): Promise<{ ok: true; bytes: number; durationSec: number } | { ok: false; errorCode: string; message: string }> {
  const bytes = await statSize(outputAbsPath);
  if (bytes <= 0) {
    return { ok: false, errorCode: 'E_EDIT_EMPTY_OUTPUT', message: 'trim produced an empty output file; check the requested start/duration.' };
  }
  const durationSec = await probeDurationSec(ffprobe, outputAbsPath, signal);
  if (signal?.aborted) return { ok: false, errorCode: 'E_EDIT_ABORTED', message: 'trim output validation aborted.' };
  if (durationSec < MIN_TRIM_OUTPUT_SEC) {
    return {
      ok: false,
      errorCode: 'E_EDIT_EMPTY_OUTPUT',
      message: `trim produced a ${round2(durationSec)}s output, which is too short to use; check the requested start/duration.`,
    };
  }
  return { ok: true, bytes, durationSec };
}

function fail(errorCode: string, message: string): EditResult {
  return { ok: false, errorCode, message };
}

/** Map a run() result that failed into an EditResult, with a stderr tail. */
/** Caption font family for `burnsubs`, chosen by the caption text's script.
 *
 * Left unset, libass resolves a default family per platform — on macOS that
 * is a Japanese-coverage font, which renders Simplified-only characters as
 * tofu boxes: the 2026-08-06 delivery burned 指□官 / □家 / 协作□ into every
 * caption while shared-with-Japanese characters looked fine, so nothing
 * failed and the video shipped. The chooser is per-glyph-fallback-free by
 * design: the bundled libass does not fall back across families, so the ONE
 * family named here must cover the deliverable script. Kana wins over Han
 * because Japanese text contains both. Latin-only captions keep the platform
 * default. Pure → unit-tested. */
/** Bottom margin for burned captions on a vertical frame, in libass script units
 *  (288 per frame height). Measured on 1080×1920: the default left the caption
 *  81 px above the bottom, under the buttons and text TikTok, Reels and Shorts lay
 *  over roughly the lowest 380 px; 60 puts it 415 px up, at any vertical size. */
export const VERTICAL_CAPTION_MARGIN_V = 60;

/** `force_style` for `burnsubs`: the caption font, plus the raised margin on a
 *  vertical frame. An .ass file keeps the margins its author set. Pure. */
export function burnsubsForceStyle(
  fontName: string,
  displaySize: { width: number; height: number } | null,
  subtitlesPath: string,
): string {
  const parts: string[] = [];
  if (fontName) parts.push(`FontName=${fontName}`);
  const authored = /\.(ass|ssa)$/i.test(subtitlesPath);
  if (!authored && displaySize && displaySize.height > displaySize.width) parts.push(`MarginV=${VERTICAL_CAPTION_MARGIN_V}`);
  return parts.length ? `:force_style='${parts.join(',')}'` : '';
}

/** A translated version once went out with the original captions still showing under the
 *  new ones (2026-11-14). The band is covered with an opaque bar across the frame, and plain
 *  captions are placed inside it. SRT captions are laid out on a 288-unit-high script. */
export function coverBandFilter(cover: { top: number; bottom: number }): { filter: string; marginV: number } {
  const top = Math.max(0, Math.min(1, cover.top));
  const bottom = Math.max(top, Math.min(1, cover.bottom));
  const band = bottom - top;
  const line = 20;
  return {
    filter: `drawbox=x=0:y=ih*${top.toFixed(4)}:w=iw:h=ih*${band.toFixed(4)}:color=black@1:t=fill`,
    marginV: Math.max(0, Math.round((1 - bottom) * 288 + Math.max(2, (band * 288 - line) / 2))),
  };
}

export function captionFontForText(text: string, platform: NodeJS.Platform): string {
  const hasKana = /[\u3040-\u30ff]/u.test(text);
  const hasHan = /[\u4e00-\u9fff]/u.test(text);
  if (hasKana) {
    if (platform === 'darwin') return 'Hiragino Sans';
    if (platform === 'win32') return 'Yu Gothic UI';
    return 'Noto Sans CJK JP';
  }
  if (hasHan) {
    if (platform === 'darwin') return 'PingFang SC';
    if (platform === 'win32') return 'Microsoft YaHei';
    return 'Noto Sans CJK SC';
  }
  return '';
}

/** The publish-loudness audio chain. The trailing aformat pins a KNOWN stereo
 *  layout: a mono input (every TTS-only mix is mono) otherwise dies in layout
 *  negotiation between aresample and the aac encoder — "Cannot select channel
 *  layout for the link between Parsed_aresample_1 and format_out_0_1", the
 *  exact failure that blocked the 2026-08-05 delivery. Stereo is the delivery
 *  standard and a mono→stereo upmix is lossless channel duplication. */
export function normalizeLoudnessAudioFilter(): string {
  return `loudnorm=I=${MIX_LOUDNORM.I}:TP=${MIX_LOUDNORM.TP}:LRA=${MIX_LOUDNORM.LRA},aresample=${MIX_OUTPUT_SR},aformat=channel_layouts=stereo`;
}

/** Would `overlay` erase the base instead of compositing over it?
 *
 * True exactly when the overlay covers the whole base frame and its pixel
 *  format carries no alpha — an opaque full-frame layer replaces every pixel.
 *  Fail-open on missing probe data: a guard that cannot see must not block a
 *  legitimate edit. Pure → unit-tested. */
export function overlayWouldEraseBase(
  base: { width: number; height: number } | null,
  overlay: { width: number; height: number; hasAlpha: boolean } | null,
): boolean {
  if (!base || !overlay) return false;
  return overlay.width >= base.width && overlay.height >= base.height && !overlay.hasAlpha;
}

export function ffmpegFailure(op: EditOp, r: { code: number | null; stderr: string; timedOut: boolean; aborted: boolean }, outputAbsPath?: string): EditResult {
  // A failed run must not leave its partial output behind: ffmpeg creates the
  // file before the filter graph initializes, and resume logic treats an
  // existing output newer than its inputs as done — the 2026-08-05 loudness
  // crash left a 0-byte video.mp4 one resume away from shipping.
  if (outputAbsPath) {
    try { fsSync.unlinkSync(outputAbsPath); } catch { /* absent or busy — best effort */ }
  }
  if (r.aborted) return fail('E_EDIT_ABORTED', `${op} aborted.`);
  if (r.timedOut) return fail('E_EDIT_TIMEOUT', `${op} timed out.`);
  const tail = r.stderr.trim().slice(-1200);
  log.warn(`ffmpeg ${op} exited ${r.code}: ${redactPaths(tail.slice(-300))}`);
  return fail('E_EDIT_FAILED', `${op} failed (exit ${r.code}). ${tail || 'No diagnostic output.'}`);
}

async function measureLoudness(
  ffmpeg: string,
  ffprobe: string,
  inputAbsPath: string,
  signal?: AbortSignal,
): Promise<EditResult> {
  const durationSec = await probeDurationSec(ffprobe, inputAbsPath, signal);
  // ebur128 prints its Summary to stderr; -f null discards the decoded output.
  const r = await run(ffmpeg, withFfmpegProgress([
    '-hide_banner', '-nostats', '-i', inputAbsPath, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]), signal, { op: 'loudness', phase: 'analyze', durationSec });
  if (r.code !== 0) return ffmpegFailure('loudness', r);
  const loudness = parseEbur128Summary(r.stderr);
  if (!loudness) return fail('E_EDIT_LOUDNESS_PARSE', 'Could not parse the ffmpeg ebur128 loudness summary.');
  return { ok: true, op: 'loudness', loudness };
}

/** ffprobe a file's container duration (seconds), falling back to the first
 *  audio stream's duration. Returns 0 when neither is available. */
async function probeDurationSec(ffprobe: string, input: string, signal?: AbortSignal): Promise<number> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', input], signal);
  const v = Number(r.stdout.trim());
  if (Number.isFinite(v) && v > 0) return v;
  const r2 = await run(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'default=nokey=1:noprint_wrappers=1', input], signal);
  const v2 = Number(r2.stdout.trim());
  return Number.isFinite(v2) && v2 > 0 ? v2 : 0;
}

/** Length of a file's picture alone, or null when it has none or it cannot be read. */
async function probeVideoDurationSec(ffprobe: string, input: string, signal?: AbortSignal): Promise<number | null> {
  const r = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nokey=1:noprint_wrappers=1', input], signal);
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The concat list: each file holds the timeline for its picture's length. Left to
 *  itself the demuxer advances by the whole file, whose AAC sound runs a few
 *  milliseconds past the picture, and over sixteen beat-length cuts that added a
 *  frame (2026-11-13). Pure. */
export function concatListBody(files: string[], videoDurations: Array<number | null>): string {
  return files.map((f, i) => {
    const line = `file '${f.replace(/'/g, "'\\''")}'`;
    const d = videoDurations[i];
    return typeof d === 'number' && d > 0 ? `${line}\nduration ${d.toFixed(6)}` : line;
  }).join('\n');
}

/** Probe duration + whether the file carries an audio stream (one ffprobe). */
/** Pixel formats that can carry transparency — the only overlays that can sit
 *  on a full frame without erasing it. */
const ALPHA_PIX_FMT_RE = /(yuva|argb|abgr|rgba|bgra|ya8|ya16|gbrap)/i;

type ConcatInputSpec = { width: number; height: number; fps: number };

/** What a join had to change about its inputs before they could be joined. */
export type ConcatConformReport = {
  applied: true;
  target: string;
  conformed_inputs: Array<{ input: string; from: string; to: string }>;
  note: string;
};

/** Width/height/frame-rate of an input's first video stream, for deciding
 *  whether a concat set is uniform enough to join as-is. */
async function probeConcatInputSpec(
  ffprobe: string,
  input: string,
  signal?: AbortSignal,
): Promise<ConcatInputSpec | null> {
  const r = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', input,
  ], signal);
  try {
    const j = JSON.parse(r.stdout) as {
      streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
    };
    const v = (j.streams ?? [])[0];
    if (!v || !Number.isFinite(v.width) || !Number.isFinite(v.height)) return null;
    const [num, den] = String(v.r_frame_rate || '').split('/');
    const fps = Number(num) / (Number(den) || 1);
    if (!Number.isFinite(fps) || fps <= 0) return null;
    return { width: Number(v.width), height: Number(v.height), fps };
  } catch { return null; }
}

/** Re-encode one input onto the shared canvas and frame rate, letterboxing
 *  rather than cropping so a designed frame keeps every pixel it composed. */
async function conformConcatInput(
  bins: { ffmpeg: string },
  input: string,
  target: ConcatInputSpec,
  outPath: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof run>>> {
  const filter = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${target.fps}`,
  ].join(',');
  return run(bins.ffmpeg, [
    '-y', '-i', input, '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', outPath,
  ], signal);
}

export type ConcatAudioConformReport = {
  applied: true;
  padded_inputs: string[];
  note: string;
};

type ConcatAudioSpec = { sampleRate: number; channels: number };

/** Sample rate and channel count of an input's first audio stream, or null
 *  when it has none. */
async function probeConcatAudioSpec(
  ffprobe: string,
  input: string,
  signal?: AbortSignal,
): Promise<ConcatAudioSpec | null> {
  const r = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels', '-of', 'json', input,
  ], signal);
  try {
    const a = ((JSON.parse(r.stdout) as { streams?: Array<{ sample_rate?: string; channels?: number }> }).streams ?? [])[0];
    const sampleRate = Number(a?.sample_rate);
    const channels = Number(a?.channels);
    if (!a || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
    return { sampleRate, channels: Number.isFinite(channels) && channels > 0 ? channels : 2 };
  } catch { return null; }
}

/** Give a silent input a silent track in the other inputs' format, leaving
 *  its video untouched, so the join keeps their sound. */
async function addConcatSilence(
  bins: { ffmpeg: string },
  input: string,
  audio: ConcatAudioSpec,
  outPath: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof run>>> {
  const layout = audio.channels === 1 ? 'mono' : 'stereo';
  return run(bins.ffmpeg, [
    '-y', '-i', input, '-f', 'lavfi', '-i', `anullsrc=channel_layout=${layout}:sample_rate=${audio.sampleRate}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outPath,
  ], signal);
}

async function probeVideoStream(
  ffprobe: string,
  input: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; pixFmt: string; hasAlpha: boolean } | null> {
  const r = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', input,
  ], signal);
  try {
    const j = JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number; pix_fmt?: string }> };
    const v = (j.streams ?? [])[0];
    if (!v || !Number.isFinite(v.width) || !Number.isFinite(v.height)) return null;
    const pixFmt = String(v.pix_fmt || '');
    return { width: Number(v.width), height: Number(v.height), pixFmt, hasAlpha: ALPHA_PIX_FMT_RE.test(pixFmt) };
  } catch { return null; }
}

/** The size the first video stream is shown at. A phone clip stores a
 *  portrait shot as landscape pixels plus a 90° rotation that ffmpeg applies
 *  while decoding, so the raw width/height alone would report it backwards. */
async function probeDisplaySize(
  ffprobe: string,
  input: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  const r = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', input], signal);
  try {
    const j = JSON.parse(r.stdout) as {
      streams?: Array<{
        width?: number;
        height?: number;
        tags?: { rotate?: string };
        side_data_list?: Array<{ rotation?: number }>;
      }>;
    };
    const v = (j.streams ?? [])[0];
    if (!v || !Number.isFinite(v.width) || !Number.isFinite(v.height)) return null;
    const sideRotation = (v.side_data_list ?? []).map((s) => Number(s.rotation)).find((n) => Number.isFinite(n));
    const rotation = sideRotation ?? (Number(v.tags?.rotate) || 0);
    const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    return quarterTurn
      ? { width: Number(v.height), height: Number(v.width) }
      : { width: Number(v.width), height: Number(v.height) };
  } catch { return null; }
}

async function probeBasic(ffprobe: string, input: string, signal?: AbortSignal): Promise<{ durationSec: number; hasAudio: boolean; comment: string }> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:format_tags=comment:stream=codec_type', '-of', 'json', input], signal);
  let durationSec = 0;
  let hasAudio = false;
  let comment = '';
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string; tags?: { comment?: unknown } }; streams?: Array<{ codec_type?: string }> };
    const d = Number(j.format?.duration);
    if (Number.isFinite(d) && d > 0) durationSec = d;
    hasAudio = (j.streams ?? []).some((s) => s.codec_type === 'audio');
    if (typeof j.format?.tags?.comment === 'string') comment = j.format.tags.comment;
  } catch { /* leave defaults */ }
  return { durationSec, hasAudio, comment };
}

/** Public duration probe (resolves the bundled ffprobe itself). Best-effort:
 *  returns null when ffprobe is missing or the file has no readable duration.
 *  Used by skill scripts to report synthesized-narration length. */
export async function probeMediaDurationSec(inputAbsPath: string, signal?: AbortSignal): Promise<number | null> {
  const bins = resolveBins();
  if (!bins) return null;
  const d = await probeDurationSec(bins.ffprobe, inputAbsPath, signal);
  return d > 0 ? d : null;
}

export type SilenceMeasureResult =
  | { ok: true; timing: SilenceTiming }
  | { ok: false; errorCode: string; message: string };

/** Run ffprobe (duration) + ffmpeg silencedetect over one media file and parse
 *  the result. Shared by `edit_video mix` (coverage of the muxed voiceover) and
 *  `analyze_media silence` (standalone QA gate). */
export async function measureSilenceCoverage(
  inputAbsPath: string,
  opts?: { signal?: AbortSignal; noiseDb?: number; minSilenceSec?: number },
): Promise<SilenceMeasureResult> {
  const bins = resolveBins();
  if (!bins) return { ok: false, errorCode: 'E_EDIT_FFMPEG_MISSING', message: 'Bundled ffmpeg/ffprobe not found.' };
  const dur = await probeDurationSec(bins.ffprobe, inputAbsPath, opts?.signal);
  const noise = opts?.noiseDb ?? SILENCE_NOISE_DB;
  const minSec = opts?.minSilenceSec ?? SILENCE_MIN_SEC;
  // `-f null -` discards decoded output; silencedetect prints its events to stderr.
  const r = await run(bins.ffmpeg, withFfmpegProgress([
    '-hide_banner', '-nostats', '-i', inputAbsPath, '-af', `silencedetect=noise=${noise}dB:d=${minSec}`, '-f', 'null', '-',
  ]), opts?.signal, { op: 'silence_detect', phase: 'analyze', durationSec: dur });
  if (r.code !== 0) {
    if (r.aborted) return { ok: false, errorCode: 'E_EDIT_ABORTED', message: 'silence detect aborted.' };
    if (r.timedOut) return { ok: false, errorCode: 'E_EDIT_TIMEOUT', message: 'silence detect timed out.' };
    const tail = r.stderr.trim().slice(-800);
    log.warn(`ffmpeg silencedetect exited ${r.code}: ${redactPaths(tail.slice(-300))}`);
    return { ok: false, errorCode: 'E_EDIT_FAILED', message: `silence detect failed (exit ${r.code}). ${tail || 'No diagnostic output.'}` };
  }
  return { ok: true, timing: parseSilenceDetect(r.stderr, dur) };
}

/** Run the single-pass jump-cut that keeps `kept` from input, on frame-aligned
 *  pieces when the frame rate is known. Returns the raw run() result — the caller
 *  checks `.code` like the other ops. */
async function runJumpCut(
  bins: { ffmpeg: string; ffprobe: string },
  inputAbsPath: string,
  kept: Span[],
  outputAbsPath: string,
  signal?: AbortSignal,
  progress?: RunProgressOptions,
): ReturnType<typeof run> {
  const ffmpeg = bins.ffmpeg;
  const spec = await probeConcatInputSpec(bins.ffprobe, inputAbsPath, signal);
  const { filter, maps } = buildKeepFilterComplex(kept, spec ? { fps: spec.fps } : {});
  return run(ffmpeg, withFfmpegProgress([
    '-y', '-i', inputAbsPath, '-filter_complex', filter, ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', outputAbsPath,
  ]), signal, progress);
}

export type SceneDetectResult =
  | { ok: true; durationSec: number; threshold: number; candidates: SceneCandidate[] }
  | { ok: false; errorCode: string; message: string };

/** Detect shot/scene boundaries via ffmpeg's `select=scene` + metadata print.
 *  Returns candidate cut points (timecode + score) for the decision layer to
 *  pick from. Lives here (with ffmpeg) like measureSilenceCoverage; analyze_media
 *  `scenes` calls it. */
export async function detectSceneChanges(
  inputAbsPath: string,
  opts?: { signal?: AbortSignal; threshold?: number },
): Promise<SceneDetectResult> {
  const bins = resolveBins();
  if (!bins) return { ok: false, errorCode: 'E_EDIT_FFMPEG_MISSING', message: 'Bundled ffmpeg/ffprobe not found.' };
  const th = finiteNum(opts?.threshold);
  const threshold = th !== undefined && th >= 0 && th <= 1 ? th : 0.4;
  const dur = await probeDurationSec(bins.ffprobe, inputAbsPath, opts?.signal);
  // `select='gt(scene,TH)'` keeps only scene-change frames; `metadata=print`
  // prints each kept frame's pts_time + lavfi.scene_score. `-an -f null -`
  // discards audio/output. Parse stdout+stderr (ffmpeg log target varies).
  const r = await run(bins.ffmpeg, withFfmpegProgress([
    '-hide_banner', '-nostats', '-i', inputAbsPath,
    '-vf', `select='gt(scene,${threshold})',metadata=print`, '-an', '-f', 'null', '-',
  ]), opts?.signal, { op: 'scene_detect', phase: 'analyze', durationSec: dur });
  if (r.code !== 0) {
    if (r.aborted) return { ok: false, errorCode: 'E_EDIT_ABORTED', message: 'scene detect aborted.' };
    if (r.timedOut) return { ok: false, errorCode: 'E_EDIT_TIMEOUT', message: 'scene detect timed out.' };
    const tail = r.stderr.trim().slice(-800);
    log.warn(`ffmpeg scenedetect exited ${r.code}: ${redactPaths(tail.slice(-300))}`);
    return { ok: false, errorCode: 'E_EDIT_FAILED', message: `scene detect failed (exit ${r.code}). ${tail || 'No diagnostic output.'}` };
  }
  return { ok: true, durationSec: dur, threshold, candidates: parseSceneChanges(`${r.stdout}\n${r.stderr}`) };
}

export type QualityDetectResult =
  | { ok: true; report: QualityReport }
  | { ok: false; errorCode: string; message: string };

/** Per-clip quality metrics (blur / exposure / black / freeze) from one bundled
 *  ffmpeg pass — `fps=3,blackdetect,freezedetect,blurdetect,signalstats,metadata=print`.
 *  Zero new deps. Lives here with ffmpeg like detectSceneChanges; analyze_media
 *  `quality` calls it. */
export async function detectQuality(
  inputAbsPath: string,
  opts?: { signal?: AbortSignal; thresholds?: QualityThresholds; fps?: number },
): Promise<QualityDetectResult> {
  const bins = resolveBins();
  if (!bins) return { ok: false, errorCode: 'E_EDIT_FFMPEG_MISSING', message: 'Bundled ffmpeg/ffprobe not found.' };
  const fpsN = finiteNum(opts?.fps);
  const fps = fpsN !== undefined && fpsN > 0 && fpsN <= 30 ? fpsN : 3; // sample ~3 fps — plenty to aggregate, keeps the log bounded
  const dur = await probeDurationSec(bins.ffprobe, inputAbsPath, opts?.signal);
  const vf = `fps=${fps},blackdetect=d=0.1:pix_th=0.10,freezedetect=n=0.003:d=0.5,blurdetect,signalstats,metadata=print`;
  const r = await run(
    bins.ffmpeg,
    withFfmpegProgress(['-hide_banner', '-nostats', '-i', inputAbsPath, '-vf', vf, '-an', '-f', 'null', '-']),
    opts?.signal,
    { op: 'quality_scan', phase: 'analyze', durationSec: dur },
  );
  if (r.code !== 0) {
    if (r.aborted) return { ok: false, errorCode: 'E_EDIT_ABORTED', message: 'quality scan aborted.' };
    if (r.timedOut) return { ok: false, errorCode: 'E_EDIT_TIMEOUT', message: 'quality scan timed out.' };
    const tail = r.stderr.trim().slice(-800);
    log.warn(`ffmpeg quality scan exited ${r.code}: ${redactPaths(tail.slice(-300))}`);
    return { ok: false, errorCode: 'E_EDIT_FAILED', message: `quality scan failed (exit ${r.code}). ${tail || 'No diagnostic output.'}` };
  }
  const logText = `${r.stdout}\n${r.stderr}`;
  const report = summarizeQuality({
    durationSec: dur,
    frames: parseQualityFrames(logText),
    blackSpans: parseLabeledIntervals(logText, 'black'),
    freezeSpans: parseLabeledIntervals(logText, 'freeze'),
    ...(opts?.thresholds ? { thresholds: opts.thresholds } : {}),
  });
  return { ok: true, report };
}

/** Decode a file's sound to mono 32-bit float PCM at `rate`, through a temporary file
 *  (run() collects text). Null when there is no sound or decoding fails. */
export async function decodeMonoPcm(inputAbsPath: string, rate: number, signal?: AbortSignal): Promise<Float32Array | null> {
  const bins = resolveBins();
  if (!bins) return null;
  const tmp = path.join(os.tmpdir(), `orkas-pcm-${randomUUID()}.f32`);
  try {
    const r = await run(bins.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', inputAbsPath, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', tmp], signal);
    if (r.code !== 0) return null;
    const buf = await fs.readFile(tmp);
    if (!buf.length) return null;
    const out = new Float32Array(Math.floor(buf.length / 4));
    for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Frame rate of a file's picture, or null when it has none. */
export async function probeVideoFps(inputAbsPath: string, signal?: AbortSignal): Promise<number | null> {
  const bins = resolveBins();
  if (!bins) return null;
  const spec = await probeConcatInputSpec(bins.ffprobe, inputAbsPath, signal);
  return spec ? spec.fps : null;
}

/** Frames per second sampled when measuring motion inside regions. */

/** Per-frame motion inside each region: the mean luma change between consecutive
 *  sampled frames, one ffmpeg pass per region on a small grey crop. */
export async function measureRegionActivity(
  inputAbsPath: string,
  regions: ActivityRegion[],
  opts?: { signal?: AbortSignal },
): Promise<
  | { ok: true; durationSec: number; series: Record<string, Array<{ tSec: number; value: number }>> }
  | { ok: false; errorCode: string; message: string }
> {
  const bins = resolveBins();
  if (!bins) return { ok: false, errorCode: 'E_EDIT_FFMPEG_MISSING', message: 'Bundled ffmpeg/ffprobe not found.' };
  const dur = await probeDurationSec(bins.ffprobe, inputAbsPath, opts?.signal);
  const series: Record<string, Array<{ tSec: number; value: number }>> = Object.create(null);
  for (const region of regions) {
    const [l, t, r, b] = region.box;
    const crop = `crop=iw*${(r - l).toFixed(4)}:ih*${(b - t).toFixed(4)}:iw*${l.toFixed(4)}:ih*${t.toFixed(4)}`;
    const vf = `fps=${ACTIVITY_SAMPLE_RATE},${crop},scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print`;
    const res = await run(
      bins.ffmpeg,
      withFfmpegProgress(['-hide_banner', '-nostats', '-i', inputAbsPath, '-vf', vf, '-an', '-f', 'null', '-']),
      opts?.signal,
      { op: 'activity_scan', phase: 'analyze', durationSec: dur },
    );
    if (res.code !== 0) {
      if (res.aborted) return { ok: false, errorCode: 'E_EDIT_ABORTED', message: 'activity scan aborted.' };
      if (res.timedOut) return { ok: false, errorCode: 'E_EDIT_TIMEOUT', message: 'activity scan timed out.' };
      const tail = res.stderr.trim().slice(-800);
      return { ok: false, errorCode: 'E_EDIT_FAILED', message: `activity scan failed (exit ${res.code}). ${tail || 'No diagnostic output.'}` };
    }
    series[region.id] = parseQualityFrames(`${res.stdout}\n${res.stderr}`)
      .filter((f) => typeof f.brightness === 'number')
      .map((f) => ({ tSec: f.tSec, value: f.brightness as number }));
  }
  return { ok: true, durationSec: dur, series };
}

/** Where a mix records the narration it laid over a clip's own sound: a hidden file
 *  beside the output. Delivery reads it to find lines that play while someone in the
 *  clip is talking, which the mixed file alone cannot show. */
export function narrationRecordPath(videoAbsPath: string): string {
  return path.join(path.dirname(videoAbsPath), `.${path.basename(videoAbsPath)}.narration.json`);
}

/** Execute an explicit selection in one synchronized pass; no semantic choices. */
export async function editSelectedIntervals(p: {
  inputAbsPath: string; outputAbsPath: string; kept: Span[]; signal?: AbortSignal;
}): Promise<EditResult> {
  const bins = resolveBins();
  if (!bins) return fail('E_EDIT_FFMPEG_MISSING', 'Bundled ffmpeg/ffprobe not found.');
  const duration = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
  const spec = await probeConcatInputSpec(bins.ffprobe, p.inputAbsPath, p.signal);
  if (!(duration > 0) || !spec) return fail('E_EDIT_SELECTION', 'Selection source has no readable duration or frame rate.');
  if (!Array.isArray(p.kept) || !p.kept.length || p.kept.length > 1000 || p.kept.some((s, i) =>
    !Number.isFinite(s.startSec) || !Number.isFinite(s.endSec) || s.startSec < 0 || s.endSec > duration + 0.01
    || s.endSec <= s.startSec || (i > 0 && s.startSec < p.kept[i - 1].endSec))) {
    return fail('E_EDIT_SELECTION', 'Selection requires 1–1000 ordered, nonoverlapping source intervals.');
  }
  const kept = p.kept.map(s => ({ startSec: Math.round(s.startSec * spec.fps) / spec.fps,
    endSec: Math.min(duration, Math.round(s.endSec * spec.fps) / spec.fps) }));
  if (kept.some(s => s.endSec <= s.startSec)) return fail('E_EDIT_SELECTION', 'A selected interval contains no complete video frame.');
  await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true });
  const unchanged = kept.length === 1 && kept[0].startSec === 0 && Math.abs(kept[0].endSec - duration) < 0.01;
  try {
    if (unchanged) await fs.copyFile(p.inputAbsPath, p.outputAbsPath, fsSync.constants.COPYFILE_EXCL);
    else {
      const claim = await fs.open(p.outputAbsPath, 'wx'); await claim.close();
      const cut = await runJumpCut(bins, p.inputAbsPath, kept, p.outputAbsPath, p.signal,
        { op: 'phrase_selection', phase: 'edit', durationSec: totalSpanSeconds(kept) });
      if (cut.code !== 0) return ffmpegFailure('phrase_selection', cut, p.outputAbsPath);
      const actual = await probeDurationSec(bins.ffprobe, p.outputAbsPath, p.signal);
      if (Math.abs(actual - totalSpanSeconds(kept)) > 1 / spec.fps + 0.05) {
        return fail('E_EDIT_SELECTION_DRIFT', 'The selected output duration does not match its frame-aligned cut list.');
      }
    }
  } catch (err) {
    return fail('E_EDIT_SELECTION', `Selection output was not written: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  return { ok: true, op: 'concat', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath),
    decision: decisionEvidence(complementIntervals(kept, duration), kept, 'explicit measured phrase selection') };
}

export interface NarrationRecord {
  kind: 'orkas-mix-narration';
  version: 1;
  /** The bytes carrying these placed lines, not just their unchanged base clip. */
  output: { sha256: string };
  /** The clip the narration was laid over, with its hash so a changed file is ignored. */
  base: { path: string; sha256: string };
  /** Each line's voiced span on the clip's timeline, in seconds. */
  lines: Array<{ index: number; start: number; end: number }>;
}

async function sha256OfFile(fileAbs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fsSync.createReadStream(fileAbs)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Ops that keep every moment where it was, so a narration record still holds for their output. */
const TIMING_PRESERVING_OPS = new Set<EditOp>(['normalize_loudness', 'burnsubs', 'reframe', 'overlay']);

export async function editVideo(p: EditParams): Promise<EditResult> {
  const result = await runEdit(p);
  if (result.ok && TIMING_PRESERVING_OPS.has(p.op) && p.inputAbsPath && p.outputAbsPath) {
    try {
      const record = JSON.parse(await fs.readFile(narrationRecordPath(p.inputAbsPath), 'utf8')) as NarrationRecord;
      if (record?.kind === 'orkas-mix-narration' && record.version === 1
        && record.output?.sha256 === await sha256OfFile(p.inputAbsPath)) {
        record.output = { sha256: await sha256OfFile(p.outputAbsPath) };
        await fs.writeFile(narrationRecordPath(p.outputAbsPath), `${JSON.stringify(record)}\n`);
      }
    } catch { /* Missing or obsolete advisory evidence does not fail a successful edit. */ }
  }
  return result;
}

async function runEdit(p: EditParams): Promise<EditResult> {
  const bins = resolveBins();
  if (!bins) return fail('E_EDIT_FFMPEG_MISSING', 'Bundled ffmpeg/ffprobe not found.');

  const ensureOutDir = async (out: string) => { await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {}); };

  if (p.op === 'probe') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'probe requires input_path');
    const r = await run(bins.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p.inputAbsPath,
    ], p.signal);
    if (r.code !== 0) return ffmpegFailure('probe', r);
    try { return { ok: true, op: 'probe', probe: JSON.parse(r.stdout) }; }
    catch { return fail('E_EDIT_PROBE_PARSE', 'ffprobe returned unparseable JSON'); }
  }

  if (p.op === 'loudness') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'loudness requires input_path');
    return measureLoudness(bins.ffmpeg, bins.ffprobe, p.inputAbsPath, p.signal);
  }

  if (!p.outputAbsPath) return fail('E_EDIT_ARG', `${p.op} requires output_path`);
  await ensureOutDir(p.outputAbsPath);

  if (p.op === 'trim') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'trim requires input_path');
    const start = finiteNum(p.start);
    const duration = finiteNum(p.duration);
    if (start === undefined || start < 0) return fail('E_EDIT_ARG', 'trim requires a finite start >= 0 (seconds)');
    if (duration === undefined || duration <= 0) return fail('E_EDIT_ARG', 'trim requires a finite duration > 0 (seconds)');
    const inputDurationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const trimRangeError = validateTrimRequest(inputDurationSec, start, duration);
    if (trimRangeError) return trimRangeError;
    // A cut is a whole number of frames, rounded to the nearest: `-t` alone keeps every
    // frame that starts before the end, so each piece came out up to a frame long while
    // its sound did not (2026-11-13: sixteen 128 BPM beats at 30 fps joined to 8.03 s
    // instead of 7.5 s, the last cut more than a beat late). Picture and sound both get
    // exactly that many frames' time; a caller cutting to a grid rounds each cut from
    // its absolute frame so the pieces add up.
    const spec = await probeConcatInputSpec(bins.ffprobe, p.inputAbsPath, p.signal);
    const basic = spec ? await probeBasic(bins.ffprobe, p.inputAbsPath, p.signal) : null;
    const frames = spec ? Math.max(1, Math.round(duration * spec.fps)) : 0;
    const args = spec && basic
      ? [
          '-y', '-ss', String(start), '-i', p.inputAbsPath,
          '-filter_complex', `[0:v]trim=end_frame=${frames},setpts=PTS-STARTPTS[v]`
            + (basic.hasAudio ? `;[0:a]atrim=end=${(frames / spec.fps).toFixed(6)},asetpts=PTS-STARTPTS[a]` : ''),
          '-map', '[v]', ...(basic.hasAudio ? ['-map', '[a]'] : []),
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath,
        ]
      // Accurate seek (-ss/-t after -i) + re-encode when the frame rate is unknown.
      : ['-y', '-i', p.inputAbsPath, '-ss', String(start), '-t', String(duration),
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath];
    const r = await run(bins.ffmpeg, withFfmpegProgress(args), p.signal, { op: 'trim', phase: 'edit', durationSec: duration });
    if (r.code !== 0) return ffmpegFailure('trim', r, p.outputAbsPath);
    const checked = await validateTrimOutput(bins.ffprobe, p.outputAbsPath, p.signal);
    if (checked.ok === false) return fail(checked.errorCode, checked.message);
    return { ok: true, op: 'trim', path: p.outputAbsPath, bytes: checked.bytes };
  }

  if (p.op === 'normalize_loudness') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'normalize_loudness requires input_path');
    const base = await probeBasic(bins.ffprobe, p.inputAbsPath, p.signal);
    if (!base.hasAudio) return fail('E_EDIT_NO_AUDIO', 'normalize_loudness requires an input with an audio stream.');
    const ln = normalizeLoudnessAudioFilter();
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath,
      '-map', '0:v?', '-map', '0:a:0',
      '-c:v', 'copy',
      '-filter:a:0', ln,
      '-c:a', 'aac', '-ar', String(MIX_OUTPUT_SR),
      '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'normalize_loudness', phase: 'edit', durationSec: base.durationSec });
    if (r.code !== 0) return ffmpegFailure('normalize_loudness', r, p.outputAbsPath);
    const loudnessResult = await measureLoudness(bins.ffmpeg, bins.ffprobe, p.outputAbsPath, p.signal);
    if (loudnessResult.ok === false) return loudnessResult;
    return {
      ok: true,
      op: 'normalize_loudness',
      path: p.outputAbsPath,
      bytes: await statSize(p.outputAbsPath),
      loudness: loudnessResult.loudness,
    };
  }

  if (p.op === 'concat') {
    const inputs = p.inputAbsPaths ?? [];
    if (inputs.length < 2) return fail('E_EDIT_ARG', 'concat requires input_paths with at least 2 entries');
    // concat demuxer with a temp list file, re-encoding so differing codecs join cleanly.
    const listPath = path.join(os.tmpdir(), `orkas-concat-${randomUUID()}.txt`);
    const scratch: string[] = [];
    try {
      const [inputDurations, specs] = await Promise.all([
        mapWithConcurrencyLimit(inputs, MIX_COVERAGE_CONCURRENCY, (input) =>
          probeDurationSec(bins.ffprobe, input, p.signal)),
        mapWithConcurrencyLimit(inputs, MIX_COVERAGE_CONCURRENCY, (input) =>
          probeConcatInputSpec(bins.ffprobe, input, p.signal)),
      ]);
      const concatDurationSec = inputDurations.every((d) => d > 0)
        ? inputDurations.reduce((sum, d) => sum + d, 0)
        : null;

      // The concat demuxer takes its canvas and time base from the FIRST input
      // and reinterprets the rest against it. Feeding it a mixed set silently
      // produced a corrupt timeline: on 2026-08-09 five 1920x1080@15 composed
      // parts joined to one 1918x1080@24 source cut and 60.03s of material came
      // out as a 75.04s file (exactly 24/15), so every scene drifted further
      // behind narration that was still timed to the plan, and the whole video
      // shrank to the odd 1918 width of one clip. Conform first — letterbox
      // onto the largest canvas at the highest rate, which upgrades a part and
      // never crops a designed frame.
      const known = specs.filter((s): s is ConcatInputSpec => !!s);
      const uniform = known.length === inputs.length && known.every((s) => (
        s.width === known[0].width && s.height === known[0].height && s.fps === known[0].fps
      ));
      let joinInputs = inputs;
      // Re-encoding the caller's material to a canvas and frame rate it did
      // not ask for is a change to the delivery, not an implementation detail.
      // Reporting only "concat wrote <path>" left the 2026-08-10 AUTO run
      // unaware that six 15fps parts had been resampled to 24 and its source
      // padded 1918→1920, so nothing downstream could weigh whether the parts
      // should have been rendered at delivery quality in the first place.
      let conform: ConcatConformReport | undefined;
      if (!uniform && known.length === inputs.length) {
        const target: ConcatInputSpec = {
          width: Math.max(...known.map((s) => s.width)) + (Math.max(...known.map((s) => s.width)) % 2),
          height: Math.max(...known.map((s) => s.height)) + (Math.max(...known.map((s) => s.height)) % 2),
          fps: Math.max(...known.map((s) => s.fps)),
        };
        const conformed_inputs: ConcatConformReport['conformed_inputs'] = [];
        joinInputs = [];
        for (let i = 0; i < inputs.length; i += 1) {
          const spec = known[i];
          if (spec.width === target.width && spec.height === target.height && spec.fps === target.fps) {
            joinInputs.push(inputs[i]);
            continue;
          }
          const conformedPath = path.join(os.tmpdir(), `orkas-conform-${randomUUID()}.mp4`);
          scratch.push(conformedPath);
          const cr = await conformConcatInput(bins, inputs[i], target, conformedPath, p.signal);
          if (cr.code !== 0) return ffmpegFailure('concat', cr, p.outputAbsPath);
          conformed_inputs.push({
            input: inputs[i],
            from: `${spec.width}x${spec.height}@${spec.fps}`,
            to: `${target.width}x${target.height}@${target.fps}`,
          });
          joinInputs.push(conformedPath);
        }
        conform = {
          applied: true,
          target: `${target.width}x${target.height}@${target.fps}`,
          conformed_inputs,
          note: 'Inputs did not share one canvas and frame rate, so the mismatched ones were re-encoded onto the'
            + ' largest canvas at the highest rate before joining. An upscaled part carries the detail of its'
            + ' original render, not of the target — re-render it at delivery quality if that matters.',
        };
      }

      // The demuxer takes its streams from the first input too. A silent title
      // card first joined to narrated cuts dropped the whole video's sound, and
      // one in the middle ended it early (2026-10-31 runs). Give each silent
      // input silence in the others' format; an all-silent join stays silent.
      const audioSpecs = await mapWithConcurrencyLimit(joinInputs, MIX_COVERAGE_CONCURRENCY, (input) =>
        probeConcatAudioSpec(bins.ffprobe, input, p.signal));
      const audioReference = audioSpecs.find((spec): spec is ConcatAudioSpec => !!spec);
      let audioConform: ConcatAudioConformReport | undefined;
      if (audioReference && audioSpecs.some((spec) => !spec)) {
        joinInputs = [...joinInputs];
        const padded_inputs: string[] = [];
        for (let i = 0; i < joinInputs.length; i += 1) {
          if (audioSpecs[i]) continue;
          const paddedPath = path.join(os.tmpdir(), `orkas-silence-${randomUUID()}.mp4`);
          scratch.push(paddedPath);
          const ar = await addConcatSilence(bins, joinInputs[i], audioReference, paddedPath, p.signal);
          if (ar.code !== 0) return ffmpegFailure('concat', ar, p.outputAbsPath);
          padded_inputs.push(inputs[i]);
          joinInputs[i] = paddedPath;
        }
        audioConform = {
          applied: true,
          padded_inputs,
          note: 'Inputs without an audio track were given silence so the joined video keeps the sound of the others.',
        };
      }

      const videoDurations = await Promise.all(joinInputs.map((f) => probeVideoDurationSec(bins.ffprobe, f, p.signal)));
      const listBody = concatListBody(joinInputs, videoDurations);
      await fs.writeFile(listPath, listBody, 'utf8');
      const r = await run(bins.ffmpeg, withFfmpegProgress([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        // The parts already share one rate (conformed above); a constant-rate output
        // would add a frame wherever their timestamps do not land exactly on its grid.
        '-fps_mode', 'passthrough',
        // Kept as they come, the picture's timestamps start one frame after the sound, so
        // every cut of a montage landed a frame late against its music (2026-11-14).
        '-vf', 'setpts=PTS-STARTPTS',
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath,
      ]), p.signal, { op: 'concat', phase: 'edit', durationSec: concatDurationSec });
      if (r.code !== 0) return ffmpegFailure('concat', r, p.outputAbsPath);

      // The expected total was already in hand above and went only to the
      // progress bar. A joined timeline that does not match the material it was
      // built from is corrupt however it happened, and saying so here costs one
      // probe instead of a repair loop discovered at the draft.
      const actualDurationSec = await probeDurationSec(bins.ffprobe, p.outputAbsPath, p.signal);
      if (concatDurationSec && actualDurationSec > 0) {
        const driftSec = Math.abs(actualDurationSec - concatDurationSec);
        if (driftSec > Math.max(0.5, concatDurationSec * 0.02)) {
          return fail(
            'E_EDIT_CONCAT_DURATION_DRIFT',
            `The joined video is ${actualDurationSec.toFixed(2)}s but its parts total ${concatDurationSec.toFixed(2)}s`
            + ` (off by ${driftSec.toFixed(2)}s). The output was written but does not match its material, so anything`
            + ` timed against the plan — narration, captions — will drift. Re-check the parts before using it.`,
          );
        }
      }
      return {
        ok: true,
        op: 'concat',
        path: p.outputAbsPath,
        bytes: await statSize(p.outputAbsPath),
        ...(conform ? { conform } : {}),
        ...(audioConform ? { audio_conform: audioConform } : {}),
      };
    } finally {
      await fs.rm(listPath, { force: true }).catch(() => {});
      for (const tmp of scratch) await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  if (p.op === 'burnsubs') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'burnsubs requires input_path');
    if (!p.subtitlesAbsPath) return fail('E_EDIT_ARG', 'burnsubs requires subtitles_path (.srt/.ass)');
    const subEsc = escapeFfmpegFilterValue(p.subtitlesAbsPath);
    const subtitleText = await fs.readFile(p.subtitlesAbsPath, 'utf8').catch(() => '');
    const fontName = captionFontForText(subtitleText, process.platform);
    const displaySize = await probeDisplaySize(bins.ffprobe, p.inputAbsPath, p.signal);
    let styleSuffix = burnsubsForceStyle(fontName, displaySize, p.subtitlesAbsPath);
    let coverFilter = '';
    if (p.cover) {
      const { top, bottom } = p.cover;
      if (!(Number.isFinite(top) && Number.isFinite(bottom) && top >= 0 && bottom <= 1 && bottom - top > 0 && bottom - top <= 0.5)) {
        return fail('E_EDIT_ARG', 'cover takes the band of the old captions as two fractions of the picture height from the top, top then bottom, at most half the height apart (for example 0.78,0.88).');
      }
      const band = coverBandFilter(p.cover);
      coverFilter = `${band.filter},`;
      // Plain captions sit in the band; an .ass file keeps its own placement.
      if (!/\.(ass|ssa)$/i.test(p.subtitlesAbsPath)) {
        styleSuffix = `:force_style='${[fontName ? `FontName=${fontName}` : '', 'Alignment=2', `MarginV=${band.marginV}`].filter(Boolean).join(',')}'`;
      }
    }
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath, '-vf', `${coverFilter}subtitles=filename=${subEsc}${styleSuffix}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'burnsubs', phase: 'edit', durationSec });
    if (r.code !== 0) return ffmpegFailure('burnsubs', r, p.outputAbsPath);
    return { ok: true, op: 'burnsubs', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
  }

  if (p.op === 'overlay') {
    if (!p.inputAbsPath || !p.overlayAbsPath) return fail('E_EDIT_ARG', 'overlay requires input_path (base) and overlay_path');
    const clampXY = (v: unknown) => Math.round(Math.max(-100000, Math.min(100000, finiteNum(v) ?? 0)));
    const x = clampXY(p.x);
    const y = clampXY(p.y);
    // A full-frame overlay with no alpha channel does not composite — it
    // REPLACES every pixel of the base. That is how a branded intro card
    // silently deleted the user's orca footage on 2026-08-05: the composed
    // overlay rendered as opaque H.264 and `overlay` laid it over the whole
    // cut. Fail closed with the real options instead of shipping the loss.
    // Smaller-than-base opaque overlays (logo boxes, lower thirds) keep
    // working: they cover only the region they occupy, which is the intent.
    const [baseInfo, overlayInfo] = await Promise.all([
      probeVideoStream(bins.ffprobe, p.inputAbsPath, p.signal),
      probeVideoStream(bins.ffprobe, p.overlayAbsPath, p.signal),
    ]);
    if (baseInfo && overlayInfo && overlayWouldEraseBase(baseInfo, overlayInfo)) {
      return fail(
        'E_EDIT_OVERLAY_OPAQUE',
        `overlay covers the full ${baseInfo.width}x${baseInfo.height} base with an opaque ${overlayInfo.width}x${overlayInfo.height} layer (pix_fmt ${overlayInfo.pixFmt || 'unknown'} has no alpha), which would completely replace the base footage instead of compositing over it. Use edge elements smaller than the frame (logo box, lower third), or plan this beat as a composed primary segment without footage underneath; a full-frame brand layer over footage needs an alpha-capable overlay render.`,
      );
    }
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath, '-i', p.overlayAbsPath,
      '-filter_complex', `overlay=${x}:${y}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'overlay', phase: 'edit', durationSec });
    if (r.code !== 0) return ffmpegFailure('overlay', r, p.outputAbsPath);
    return { ok: true, op: 'overlay', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
  }

  if (p.op === 'reframe') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'reframe requires input_path');
    // A reframe is a new deliverable. Encoding over the source would destroy
    // the user's only copy the moment ffmpeg truncates it.
    if (path.resolve(p.outputAbsPath) === path.resolve(p.inputAbsPath)) {
      return fail('E_EDIT_ARG', 'reframe must write a new output file, not over its input.');
    }
    const canvas = reframeCanvas({ aspect: p.aspect, width: p.width, height: p.height });
    if (canvas.ok === false) return fail('E_EDIT_ARG', canvas.message);
    let plan: FocusStep[] | undefined;
    if (p.focusPlan !== undefined) {
      const parsed = normalizeFocusPlan(p.focusPlan);
      if (typeof parsed === 'string') return fail('E_EDIT_ARG', `reframe ${parsed}`);
      if (p.mode && p.mode !== 'crop') return fail('E_EDIT_ARG', 'reframe plan needs mode crop: it moves the crop position over time.');
      plan = parsed;
    }
    const mode: ReframeMode = p.mode ?? (plan ? 'crop' : 'pad');
    if (mode !== 'pad' && mode !== 'crop' && mode !== 'blur') {
      return fail('E_EDIT_ARG', `reframe mode must be pad, crop or blur; got ${String(mode)}`);
    }
    const padColor = mode === 'pad' ? reframePadColor(p.padColor) : null;
    if (mode === 'pad' && !padColor) {
      return fail('E_EDIT_ARG', `reframe pad color must be a colour name or 6-digit hex; got ${String(p.padColor)}`);
    }
    const source = await probeDisplaySize(bins.ffprobe, p.inputAbsPath, p.signal);
    if (!source) return fail('E_EDIT_NO_VIDEO', 'reframe needs an input with a readable video stream.');
    const { width, height } = canvas;
    const built = buildReframeFilter({
      mode, width, height, focusX: p.focusX, focusY: p.focusY, ...(plan ? { plan } : {}), ...(padColor ? { padColor } : {}),
    });
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath,
      ...(built.complex ? ['-filter_complex', built.filter, '-map', '[rfv]'] : ['-map', '0:v:0', '-vf', built.filter]),
      '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'reframe', phase: 'edit', durationSec });
    if (r.code !== 0) return ffmpegFailure('reframe', r, p.outputAbsPath);
    // The canvas is the point of the op, and a timeline that gained or lost
    // time against its source is corrupt however it happened — check the file
    // that was written, not the command that was run (same rule as concat).
    const written = await probeVideoStream(bins.ffprobe, p.outputAbsPath, p.signal);
    if (!written || written.width !== width || written.height !== height) {
      try { fsSync.unlinkSync(p.outputAbsPath); } catch { /* best effort */ }
      return fail(
        'E_EDIT_REFRAME_CANVAS',
        `reframe wrote ${written ? `${written.width}x${written.height}` : 'no readable video'} instead of ${width}x${height}.`,
      );
    }
    const writtenDurationSec = await probeDurationSec(bins.ffprobe, p.outputAbsPath, p.signal);
    if (durationSec > 0 && writtenDurationSec > 0) {
      const driftSec = Math.abs(writtenDurationSec - durationSec);
      if (driftSec > Math.max(0.5, durationSec * 0.02)) {
        try { fsSync.unlinkSync(p.outputAbsPath); } catch { /* best effort */ }
        return fail(
          'E_EDIT_REFRAME_DURATION_DRIFT',
          `The reframed video is ${writtenDurationSec.toFixed(2)}s but its source is ${durationSec.toFixed(2)}s; the output was removed.`,
        );
      }
    }
    const reframe: ReframeReport = {
      mode,
      canvas: `${width}x${height}`,
      from: `${source.width}x${source.height}`,
      ...(padColor ? { pad_color: padColor } : {}),
      ...(mode === 'crop'
        ? {
            ...(plan
              ? { plan: plan.map((s) => ({ start: s.startSec, centre_x: s.centreX, centre_y: s.centreY ?? 0.5 })) }
              : { focus: { x: clamp(finiteNum(p.focusX) ?? 0.5, 0, 1), y: clamp(finiteNum(p.focusY) ?? 0.5, 0, 1) } }),
            note: 'crop cut the source edges outside the canvas; extract a frame and confirm no text, captions or faces were lost.',
          }
        : {}),
    };
    return { ok: true, op: 'reframe', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), reframe };
  }

  if (p.op === 'extract_frame') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'extract_frame requires input_path');
    const sf = finiteNum(p.start);
    const at = sf !== undefined && sf >= 0 ? sf : 0;
    // One still frame at `at` seconds → image (consistency anchor for the next shot).
    const r = await run(bins.ffmpeg, [
      '-y', '-ss', String(at), '-i', p.inputAbsPath, '-frames:v', '1', '-update', '1', p.outputAbsPath,
    ], p.signal);
    if (r.code !== 0) return ffmpegFailure('extract_frame', r, p.outputAbsPath);
    return { ok: true, op: 'extract_frame', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
  }

  if (p.op === 'trim_silence') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'trim_silence requires input_path');
    const noiseDb = finiteNum(p.noiseDb);
    const minSilenceSec = finiteNum(p.minSilenceSec);
    const padSec = finiteNum(p.padSec);
    const minKeepSec = finiteNum(p.minKeepSec);
    const meas = await measureSilenceCoverage(p.inputAbsPath, {
      ...(p.signal ? { signal: p.signal } : {}),
      ...(noiseDb !== undefined ? { noiseDb } : {}),
      ...(minSilenceSec !== undefined ? { minSilenceSec } : {}),
    });
    if (meas.ok === false) return fail(meas.errorCode, meas.message);
    const dur = meas.timing.durationSec;
    const kept = keepIntervalsFromRemovals(dur, meas.timing.silences, {
      ...(padSec !== undefined ? { padSec } : {}),
      ...(minSilenceSec !== undefined ? { minRemoveSec: minSilenceSec } : {}),
      ...(minKeepSec !== undefined ? { minKeepSec } : {}),
    });
    const removed = complementIntervals(kept, dur);
    if (!removed.length || !kept.length) {
      return fail('E_EDIT_NO_CHANGE', `No silence ≥ ${minSilenceSec ?? SILENCE_MIN_SEC}s found below ${noiseDb ?? SILENCE_NOISE_DB} dB — nothing to trim; use the original clip.`);
    }
    const cut = await runJumpCut(bins, p.inputAbsPath, kept, p.outputAbsPath, p.signal, {
      op: 'trim_silence',
      phase: 'edit',
      durationSec: totalSpanSeconds(kept),
    });
    if (cut.code !== 0) return ffmpegFailure('trim_silence', cut, p.outputAbsPath);
    const decision = decisionEvidence(removed, kept, `removed ${removed.length} silent span(s) below ${noiseDb ?? SILENCE_NOISE_DB} dB`);
    return { ok: true, op: 'trim_silence', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), decision };
  }

  if (p.op === 'remove_fillers') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'remove_fillers requires input_path');
    if (!p.transcriptAbsPath) return fail('E_EDIT_ARG', 'remove_fillers requires transcript_path (the video_studio speech.transcribe JSON with word timings)');
    let json: unknown;
    try { json = JSON.parse(await fs.readFile(p.transcriptAbsPath, 'utf8')); }
    catch (err) { return fail('E_EDIT_TRANSCRIPT_PARSE', `could not read/parse transcript_path: ${(err as Error).message}`); }
    const words = normalizeTranscriptWords(json);
    if (!words.length) return fail('E_EDIT_NO_WORDS', 'transcript had no word-level timings — re-run video_studio op:"speech.transcribe" with timestamps:"word" on this clip.');
    const padSec = finiteNum(p.padSec);
    const minKeepSec = finiteNum(p.minKeepSec);
    const removeSpans = fillerSpansFromWords(
      words,
      p.fillers && p.fillers.length ? p.fillers : DEFAULT_FILLERS,
      padSec !== undefined ? { padSec } : {},
    );
    if (!removeSpans.length) return fail('E_EDIT_NO_CHANGE', 'no filler words found — nothing to remove; use the original clip.');
    const dur = (await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal)) || 0;
    if (dur <= 0) return fail('E_EDIT_FAILED', 'could not probe duration for filler removal.');
    // Filler spans are already padded; keep computation must not shrink or drop them.
    const kept = keepIntervalsFromRemovals(dur, removeSpans, {
      padSec: 0,
      minRemoveSec: 0,
      ...(minKeepSec !== undefined ? { minKeepSec } : {}),
    });
    if (!kept.length) return fail('E_EDIT_NO_CHANGE', 'filler removal left nothing to keep.');
    const cut = await runJumpCut(bins, p.inputAbsPath, kept, p.outputAbsPath, p.signal, {
      op: 'remove_fillers',
      phase: 'edit',
      durationSec: totalSpanSeconds(kept),
    });
    if (cut.code !== 0) return ffmpegFailure('remove_fillers', cut, p.outputAbsPath);
    // Evidence must reflect the ACTUAL cut complement, not the padded/unmerged
    // filler spans (which double-count adjacent fillers and ignore sub-minKeep
    // slivers folded into the cut) — mirror trim_silence's complementIntervals.
    const removed = complementIntervals(kept, dur);
    const decision = decisionEvidence(removed, kept, `removed ${removeSpans.length} filler word(s)`);
    return { ok: true, op: 'remove_fillers', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), decision };
  }

  if (p.op === 'mix') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'mix requires input_path (the base video)');
    // Per-line segments take precedence; otherwise the single audio_path + start.
    const segs: Array<{ audioAbsPath: string; startSec: number; endSec?: number }> =
      (p.audioSegments && p.audioSegments.length)
        ? p.audioSegments
            .filter((s) => s && typeof s.audioAbsPath === 'string' && s.audioAbsPath)
            .map((s) => ({ audioAbsPath: s.audioAbsPath, startSec: Math.max(0, finiteNum(s.startSec) ?? 0), ...(s.endSec !== undefined ? { endSec: s.endSec } : {}) }))
        : (p.audioAbsPath ? [{ audioAbsPath: p.audioAbsPath, startSec: Math.max(0, finiteNum(p.start) ?? 0) }] : []);
    if (!segs.length) return fail('E_EDIT_ARG', 'mix requires audio_path (the narration/music to add) or a non-empty audio_segments');

    const mode = p.onExistingAudio ?? 'reject';
    const base = await probeBasic(bins.ffprobe, p.inputAbsPath, p.signal);
    const pictureLocked = segs.some(s => s.endSec !== undefined);
    let windowMeasurements: SilenceMeasureResult[] | undefined;
    if (pictureLocked) {
      if (p.audioSegments!.some(s => s.startSec !== undefined && (!Number.isFinite(s.startSec) || s.startSec < 0))
        || segs.some((s, i) => !Number.isFinite(s.endSec) || !(s.endSec! > s.startSec)
        || s.endSec! > base.durationSec || (i > 0 && s.startSec < segs[i - 1].endSec!))) {
        return fail('E_EDIT_VOICE_WINDOW', 'Every fixed picture window must have a finite end, fit the source and follow the previous window.');
      }
      windowMeasurements = await mapWithConcurrencyLimit(segs, MIX_COVERAGE_CONCURRENCY, s =>
        measureSilenceCoverage(s.audioAbsPath, p.signal ? { signal: p.signal } : {}));
      for (let i = 0; i < segs.length; i++) {
        const measured = windowMeasurements[i];
        if (!measured.ok) return fail('E_EDIT_VOICE_WINDOW', `Speech timing for segment ${i + 1} is unavailable; no mix was written.`);
        if (segs[i].startSec + measured.timing.voicedEndSec > segs[i].endSec! + 0.001) {
          return fail('E_EDIT_VOICE_WINDOW', `Speech in segment ${i + 1} exceeds its declared picture window; no mix was written.`);
        }
      }
    }
    // A standard MP4 comment survives ordinary external ffmpeg transforms.
    // It signals that a missing sidecar is unknown, never that audio is clean.
    const marker = 'ORKAS_NARRATION_MIX_V1';
    const comment = base.comment.split('\n').filter(line => line !== marker).join('\n');
    const recordsNarration = (p.audioSegments?.length ?? 0) > 0 && base.hasAudio && mode === 'mix';
    const markedComment = recordsNarration || (mode === 'mix' && base.comment.split('\n').includes(marker))
      ? [comment, marker].filter(Boolean).join('\n') : comment;
    // Guard the "two voices" defect: a base that already carries audio + a
    // narration mix = stacked voices. Refuse by default; the caller must opt into
    // layering ('mix') or replacing ('replace') the base audio on purpose.
    if (base.hasAudio && mode === 'reject') {
      return fail(
        'E_EDIT_BASE_HAS_AUDIO',
        'The base video already has an audio track, so mixing narration onto it would STACK a second voice (the "two voices" defect). '
        + 'Render the base SILENT first — for a compose segment, remove the narration <audio> from its index.html so the native composition draft has no audio, then re-mix. '
        + "If layering is intended (e.g. music under a talking-head's built-in lip-synced voice) pass on_existing_audio='mix'; "
        + "to drop the base audio and keep only this narration pass on_existing_audio='replace'.",
      );
    }

    const sr = MIX_OUTPUT_SR;
    const ln = `loudnorm=I=${MIX_LOUDNORM.I}:TP=${MIX_LOUDNORM.TP}:LRA=${MIX_LOUDNORM.LRA}`;
    // When the duration probe fails, skip padding rather than risk the -shortest hang.
    const filter = buildMixFilter({
      sr,
      segmentStartSec: segs.map((s) => s.startSec),
      baseHasAudio: base.hasAudio,
      mode: mode === 'replace' ? 'replace' : 'mix',
      padWholeDurSec: base.durationSec > 0 ? base.durationSec : null,
      loudnorm: ln,
      duck: p.duck === true,
    });
    // Video is the master: copy it untouched and -shortest trims the
    // padded audio bed back to the clip length.
    const inputArgs: string[] = ['-y', '-i', p.inputAbsPath];
    for (const s of segs) inputArgs.push('-i', s.audioAbsPath);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-ar', String(sr),
      '-metadata', `comment=${markedComment}`,
      '-shortest', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'mix', phase: 'edit', durationSec: base.durationSec });
    if (r.code !== 0) return ffmpegFailure('mix', r, p.outputAbsPath);
    // Coverage: silencedetect each SOURCE segment and combine the placed voiced
    // spans on the clip timeline — deterministic and unaffected by the -shortest
    // truncation that would hide an overshoot in the output. (The per-line start
    // is folded into the placed spans, so offsetSec is 0 in the combined assess.)
    let coverage: CoverageReport | undefined;
    const placedStarts: number[] = [];
    const placedEnds: number[] = [];
    const placedAudioEnds: number[] = [];
    const placedSpans: Array<{ startSec: number; endSec: number }> = [];
    const measurements = windowMeasurements ?? await mapWithConcurrencyLimit(segs, MIX_COVERAGE_CONCURRENCY, (s) =>
      measureSilenceCoverage(s.audioAbsPath, p.signal ? { signal: p.signal } : {}));
    const measuredAll = measurements.every((meas) => meas.ok);
    if (measuredAll) {
      for (let i = 0; i < segs.length; i += 1) {
        const s = segs[i];
        const meas = measurements[i];
        if (!meas.ok) continue;
        placedStarts.push(s.startSec + meas.timing.voicedStartSec);
        placedEnds.push(s.startSec + meas.timing.voicedEndSec);
        placedAudioEnds.push(s.startSec + meas.timing.durationSec);
        placedSpans.push({
          startSec: s.startSec + meas.timing.voicedStartSec,
          endSec: s.startSec + meas.timing.voicedEndSec,
        });
      }
    }
    if (measuredAll && placedEnds.length) {
      coverage = assessVoiceoverCoverage({
        referenceDurationSec: base.durationSec,
        offsetSec: 0,
        audioDurationSec: Math.max(...placedAudioEnds),
        voicedStartSec: Math.min(...placedStarts),
        voicedEndSec: Math.max(...placedEnds),
        voicedSpans: placedSpans,
        preservePicture: pictureLocked,
      });
    }
    // Overshoot means `-shortest` already cut words off the end of the last
    // line: the file was written and does not contain the audio it was given.
    // That is the same defect class as E_EDIT_CONCAT_DURATION_DRIFT above, and
    // it is a failure, not a warning — on 2026-08-10 this returned ok with the
    // truncation stated in `warnings`, the model read past it, and the video
    // shipped with its closing call-to-action cut 0.72s short.
    //
    // Scoped to per-line placement, which is the narration tier by
    // construction: the assembly skill mixes narration with `audio_segments`
    // (one entry per line) onto a silent base, then adds a music bed as a
    // single `audio_path` ducked under it. A bed longer than the clip is meant
    // to be trimmed, so only the per-line call can be truncated wrongly.
    // Interior gaps and overlaps stay warnings — those are editorial calls.
    // Narration laid line by line over a clip that keeps its own sound: record where each
    // line speaks, so delivery can check it against where the clip's people speak.
    if (measuredAll && placedSpans.length && (p.audioSegments?.length ?? 0) > 0 && base.hasAudio && mode === 'mix') {
      const record: NarrationRecord = {
        kind: 'orkas-mix-narration',
        version: 1,
        output: { sha256: await sha256OfFile(p.outputAbsPath) },
        base: { path: p.inputAbsPath, sha256: await sha256OfFile(p.inputAbsPath) },
        lines: placedSpans.map((span, index) => ({ index: index + 1, start: round2(span.startSec), end: round2(span.endSec) })),
      };
      await fs.writeFile(narrationRecordPath(p.outputAbsPath), `${JSON.stringify(record)}\n`).catch(() => {});
    }
    if (coverage && coverage.status === 'over' && (p.audioSegments?.length ?? 0) > 0) {
      return fail(
        'E_EDIT_MIX_NARRATION_TRUNCATED',
        `The narration runs ${coverage.overshootSec}s past the ${coverage.referenceDurationSec}s video, so that much of the`
        + ` last line was cut off the end. The file at ${p.outputAbsPath} was written but does not contain all the narration it`
        + ' was given, so it cannot ship. Shorten the last line so its speech ends before the video does and re-synthesize it,'
        + ' or extend the video to cover it. Do not raise the speech speed to fit — a rushed read still misses its scene.',
      );
    }
    return { ok: true, op: 'mix', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), ...(coverage ? { coverage } : {}) };
  }

  return fail('E_EDIT_ARG', `unknown op: ${String(p.op)}`);
}
