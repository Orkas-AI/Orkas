/**
 * video_edit — local backend for the `edit_video` tool (deterministic real-
 * footage editing). Runs the bundled ffmpeg/ffprobe (see util/bundled-runtime
 * `bundledFfmpegPaths`) — zero new dependencies, no network, no npx. This is
 * the "C 剪辑" capability axis; render_composition (HyperFrames) stays separate.
 *
 * Multi-op (per the design decision that edit_video is one multi-sub-op tool):
 *   probe | trim | concat | burnsubs | overlay | extract_frame
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
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { bundledFfmpegPaths } from './bundled-runtime';
import { redactPaths } from './redact';
import { createLogger } from './logger-shim';
import {
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
const MIX_COVERAGE_CONCURRENCY = 4;
const MIN_TRIM_OUTPUT_SEC = 0.1;
const RUN_PROGRESS_HEARTBEAT_MS = 15_000;
const RUN_PROGRESS_MIN_EMIT_MS = 2_000;

export type EditOp = 'probe' | 'trim' | 'concat' | 'burnsubs' | 'overlay' | 'extract_frame' | 'loudness' | 'mix' | 'trim_silence' | 'remove_fillers';

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
  status: 'ok' | 'under' | 'over' | 'silent';
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
  audioSegments?: Array<{ audioAbsPath: string; startSec?: number }>;
  /** mix: what to do when the BASE video already carries an audio track.
   *  - 'reject' (DEFAULT): fail — prevents silently stacking a SECOND narration
   *    onto a base that already has one (e.g. a compose render that baked it in;
   *    the "two voices" defect).
   *  - 'mix': intentionally layer (music under a talking-head's built-in voice).
   *  - 'replace': drop the base audio, keep only the added narration. */
  onExistingAudio?: 'reject' | 'mix' | 'replace';
  /** Output path (all ops except probe / loudness). */
  outputAbsPath?: string;
  /** trim: seconds. mix: lead-in offset (delay) for the added audio. */
  start?: number;
  duration?: number;
  /** burnsubs: subtitle file (.srt/.ass). */
  subtitlesAbsPath?: string;
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
  /** remove_fillers: the analyze_media transcribe JSON (word-level timings) and the
   *  filler tokens to drop (default um/uh/...). */
  transcriptAbsPath?: string;
  fillers?: string[];
  signal?: AbortSignal;
}

export type EditResult =
  | { ok: true; op: EditOp; path?: string; bytes?: number; probe?: unknown; loudness?: LoudnessResult; coverage?: CoverageReport; decision?: DecisionEvidence }
  | { ok: false; errorCode: string; message: string };

/** Parse the `[Parsed_ebur128_…] Summary:` block ffmpeg prints to stderr.
 *  `-inf` (silent source) maps to null. Returns null only when the integrated
 *  line is absent entirely (no measurable summary). */
export function parseEbur128Summary(stderr: string): LoudnessResult | null {
  const num = (re: RegExp): number | null => {
    const m = stderr.match(re);
    if (!m) return null;
    if (/inf/i.test(m[1])) return null; // -inf for a silent source
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  // `I:` is unique to the integrated line; LRA/Peak likewise. The values can be
  // negative or `-inf`. Order in the summary is Integrated → Range → True peak.
  const hasIntegrated = /\bI:\s*(-?(?:inf|[\d.]+))\s*LUFS/i.test(stderr);
  if (!hasIntegrated) return null;
  return {
    integratedLufs: num(/\bI:\s*(-?(?:inf|[\d.]+))\s*LUFS/i),
    loudnessRangeLu: num(/\bLRA:\s*(-?(?:inf|[\d.]+))\s*LU\b/i),
    truePeakDbfs: num(/\bPeak:\s*(-?(?:inf|[\d.]+))\s*dBFS/i),
  };
}

/** Escape a filesystem path for use as one ffmpeg filter option value. */
export function escapeFfmpegFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
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
      warnings.push(`Narration ends at ${round2(voicedEnd)}s, leaving ${trailingGapSec}s of silent tail on a ${round2(ref)}s clip (~${pct}% uncovered) — lengthen the script, add a closing line, or trim the clip to match.`);
    }
    if (leadingGapSec > COVERAGE_LEAD_GAP_SEC) {
      warnings.push(`Narration only starts at ${leadingGapSec}s — long silent lead-in; reduce the offset or trim the head.`);
    }
  }
  return { referenceDurationSec: round2(ref), voicedStartSec: round2(voicedStart), voicedEndSec: round2(voicedEnd), leadingGapSec, trailingGapSec, overshootSec, coverageRatio, status, warnings };
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
}): string {
  const { sr, segmentStartSec, baseHasAudio, mode, padWholeDurSec, loudnorm } = opts;
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
  const tail = `${padWholeDurSec && padWholeDurSec > 0 ? `apad=whole_dur=${padWholeDurSec.toFixed(3)},` : ''}${loudnorm},aresample=${sr}`;
  if (baseHasAudio && mode === 'mix') {
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
        ...(processedSec !== null && durationSec ? { percent: round2(clamp((processedSec / durationSec) * 100, 0, 100)) } : {}),
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
function ffmpegFailure(op: EditOp, r: { code: number | null; stderr: string; timedOut: boolean; aborted: boolean }): EditResult {
  if (r.aborted) return fail('E_EDIT_ABORTED', `${op} aborted.`);
  if (r.timedOut) return fail('E_EDIT_TIMEOUT', `${op} timed out.`);
  const tail = r.stderr.trim().slice(-1200);
  log.warn(`ffmpeg ${op} exited ${r.code}: ${redactPaths(tail.slice(-300))}`);
  return fail('E_EDIT_FAILED', `${op} failed (exit ${r.code}). ${tail || 'No diagnostic output.'}`);
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

/** Probe duration + whether the file carries an audio stream (one ffprobe). */
async function probeBasic(ffprobe: string, input: string, signal?: AbortSignal): Promise<{ durationSec: number; hasAudio: boolean }> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input], signal);
  let durationSec = 0;
  let hasAudio = false;
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const d = Number(j.format?.duration);
    if (Number.isFinite(d) && d > 0) durationSec = d;
    hasAudio = (j.streams ?? []).some((s) => s.codec_type === 'audio');
  } catch { /* leave defaults */ }
  return { durationSec, hasAudio };
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

export type ExtractFrameResult = { ok: true } | { ok: false; errorCode: string; message: string };

/** Extract a single frame at `atSec` to `outAbsPath` (format by extension) using
 *  the bundled ffmpeg. Reused by analyze_media op:"ocr" to sample frames for
 *  on-screen-text grounding without going through the full edit_video tool. */
export async function extractFrameAt(
  inputAbsPath: string,
  atSec: number,
  outAbsPath: string,
  signal?: AbortSignal,
): Promise<ExtractFrameResult> {
  const bins = resolveBins();
  if (!bins) return { ok: false, errorCode: 'E_EDIT_FFMPEG_MISSING', message: 'Bundled ffmpeg/ffprobe not found.' };
  const at = Number.isFinite(atSec) && atSec > 0 ? atSec : 0;
  const r = await run(bins.ffmpeg, ['-y', '-ss', String(at), '-i', inputAbsPath, '-frames:v', '1', '-update', '1', outAbsPath], signal);
  if (r.code !== 0) {
    const f = ffmpegFailure('extract_frame', r) as { errorCode: string; message: string };
    return { ok: false, errorCode: f.errorCode, message: f.message };
  }
  return { ok: true };
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

/** Run the single-pass select/aselect jump-cut that keeps `kept` from input.
 *  Returns the raw run() result — the caller checks `.code` like the other ops. */
function runJumpCut(
  ffmpeg: string,
  inputAbsPath: string,
  kept: Span[],
  outputAbsPath: string,
  signal?: AbortSignal,
  progress?: RunProgressOptions,
): ReturnType<typeof run> {
  const { filter, maps } = buildKeepFilterComplex(kept);
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

export async function editVideo(p: EditParams): Promise<EditResult> {
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
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    // ebur128 prints its Summary to stderr; -f null discards the decoded output.
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-hide_banner', '-nostats', '-i', p.inputAbsPath, '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ]), p.signal, { op: 'loudness', phase: 'analyze', durationSec });
    if (r.code !== 0) return ffmpegFailure('loudness', r);
    const loudness = parseEbur128Summary(r.stderr);
    if (!loudness) return fail('E_EDIT_LOUDNESS_PARSE', 'Could not parse the ffmpeg ebur128 loudness summary.');
    return { ok: true, op: 'loudness', loudness };
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
    // Accurate seek (-ss/-t after -i) + re-encode so arbitrary cut points are frame-exact.
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath, '-ss', String(start), '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'trim', phase: 'edit', durationSec: duration });
    if (r.code !== 0) return ffmpegFailure('trim', r);
    const checked = await validateTrimOutput(bins.ffprobe, p.outputAbsPath, p.signal);
    if (checked.ok === false) return fail(checked.errorCode, checked.message);
    return { ok: true, op: 'trim', path: p.outputAbsPath, bytes: checked.bytes };
  }

  if (p.op === 'concat') {
    const inputs = p.inputAbsPaths ?? [];
    if (inputs.length < 2) return fail('E_EDIT_ARG', 'concat requires input_paths with at least 2 entries');
    // concat demuxer with a temp list file, re-encoding so differing codecs join cleanly.
    const listPath = path.join(os.tmpdir(), `orkas-concat-${randomUUID()}.txt`);
    const listBody = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(listPath, listBody, 'utf8');
    try {
      const inputDurations = await mapWithConcurrencyLimit(inputs, MIX_COVERAGE_CONCURRENCY, (input) =>
        probeDurationSec(bins.ffprobe, input, p.signal));
      const concatDurationSec = inputDurations.every((d) => d > 0)
        ? inputDurations.reduce((sum, d) => sum + d, 0)
        : null;
      const r = await run(bins.ffmpeg, withFfmpegProgress([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', p.outputAbsPath,
      ]), p.signal, { op: 'concat', phase: 'edit', durationSec: concatDurationSec });
      if (r.code !== 0) return ffmpegFailure('concat', r);
      return { ok: true, op: 'concat', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
    } finally {
      await fs.rm(listPath, { force: true }).catch(() => {});
    }
  }

  if (p.op === 'burnsubs') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'burnsubs requires input_path');
    if (!p.subtitlesAbsPath) return fail('E_EDIT_ARG', 'burnsubs requires subtitles_path (.srt/.ass)');
    const subEsc = escapeFfmpegFilterValue(p.subtitlesAbsPath);
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath, '-vf', `subtitles=filename=${subEsc}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'burnsubs', phase: 'edit', durationSec });
    if (r.code !== 0) return ffmpegFailure('burnsubs', r);
    return { ok: true, op: 'burnsubs', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
  }

  if (p.op === 'overlay') {
    if (!p.inputAbsPath || !p.overlayAbsPath) return fail('E_EDIT_ARG', 'overlay requires input_path (base) and overlay_path');
    const clampXY = (v: unknown) => Math.round(Math.max(-100000, Math.min(100000, finiteNum(v) ?? 0)));
    const x = clampXY(p.x);
    const y = clampXY(p.y);
    const durationSec = await probeDurationSec(bins.ffprobe, p.inputAbsPath, p.signal);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      '-y', '-i', p.inputAbsPath, '-i', p.overlayAbsPath,
      '-filter_complex', `overlay=${x}:${y}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'overlay', phase: 'edit', durationSec });
    if (r.code !== 0) return ffmpegFailure('overlay', r);
    return { ok: true, op: 'overlay', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath) };
  }

  if (p.op === 'extract_frame') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'extract_frame requires input_path');
    const sf = finiteNum(p.start);
    const at = sf !== undefined && sf >= 0 ? sf : 0;
    // One still frame at `at` seconds → image (consistency anchor for the next shot).
    const r = await run(bins.ffmpeg, [
      '-y', '-ss', String(at), '-i', p.inputAbsPath, '-frames:v', '1', '-update', '1', p.outputAbsPath,
    ], p.signal);
    if (r.code !== 0) return ffmpegFailure('extract_frame', r);
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
    const cut = await runJumpCut(bins.ffmpeg, p.inputAbsPath, kept, p.outputAbsPath, p.signal, {
      op: 'trim_silence',
      phase: 'edit',
      durationSec: totalSpanSeconds(kept),
    });
    if (cut.code !== 0) return ffmpegFailure('trim_silence', cut);
    const decision = decisionEvidence(removed, kept, `removed ${removed.length} silent span(s) below ${noiseDb ?? SILENCE_NOISE_DB} dB`);
    return { ok: true, op: 'trim_silence', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), decision };
  }

  if (p.op === 'remove_fillers') {
    if (!p.inputAbsPath) return fail('E_EDIT_ARG', 'remove_fillers requires input_path');
    if (!p.transcriptAbsPath) return fail('E_EDIT_ARG', 'remove_fillers requires transcript_path (the analyze_media transcribe JSON with word timings)');
    let json: unknown;
    try { json = JSON.parse(await fs.readFile(p.transcriptAbsPath, 'utf8')); }
    catch (err) { return fail('E_EDIT_TRANSCRIPT_PARSE', `could not read/parse transcript_path: ${(err as Error).message}`); }
    const words = normalizeTranscriptWords(json);
    if (!words.length) return fail('E_EDIT_NO_WORDS', 'transcript had no word-level timings — re-run analyze_media transcribe (--json) on this clip.');
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
    const cut = await runJumpCut(bins.ffmpeg, p.inputAbsPath, kept, p.outputAbsPath, p.signal, {
      op: 'remove_fillers',
      phase: 'edit',
      durationSec: totalSpanSeconds(kept),
    });
    if (cut.code !== 0) return ffmpegFailure('remove_fillers', cut);
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
    const segs: Array<{ audioAbsPath: string; startSec: number }> =
      (p.audioSegments && p.audioSegments.length)
        ? p.audioSegments
            .filter((s) => s && typeof s.audioAbsPath === 'string' && s.audioAbsPath)
            .map((s) => ({ audioAbsPath: s.audioAbsPath, startSec: Math.max(0, finiteNum(s.startSec) ?? 0) }))
        : (p.audioAbsPath ? [{ audioAbsPath: p.audioAbsPath, startSec: Math.max(0, finiteNum(p.start) ?? 0) }] : []);
    if (!segs.length) return fail('E_EDIT_ARG', 'mix requires audio_path (the narration/music to add) or a non-empty audio_segments');

    const mode = p.onExistingAudio ?? 'reject';
    const base = await probeBasic(bins.ffprobe, p.inputAbsPath, p.signal);
    // Guard the "two voices" defect: a base that already carries audio + a
    // narration mix = stacked voices. Refuse by default; the caller must opt into
    // layering ('mix') or replacing ('replace') the base audio on purpose.
    if (base.hasAudio && mode === 'reject') {
      return fail(
        'E_EDIT_BASE_HAS_AUDIO',
        'The base video already has an audio track, so mixing narration onto it would STACK a second voice (the "two voices" defect). '
        + 'Render the base SILENT first — for a compose segment, remove the narration <audio> from its index.html so render_composition produces no audio, then re-mix. '
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
    });
    // Video is the master: copy it untouched (画面不动) and -shortest trims the
    // padded audio bed back to the clip length.
    const inputArgs: string[] = ['-y', '-i', p.inputAbsPath];
    for (const s of segs) inputArgs.push('-i', s.audioAbsPath);
    const r = await run(bins.ffmpeg, withFfmpegProgress([
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-ar', String(sr),
      '-shortest', '-movflags', '+faststart', p.outputAbsPath,
    ]), p.signal, { op: 'mix', phase: 'edit', durationSec: base.durationSec });
    if (r.code !== 0) return ffmpegFailure('mix', r);
    // Coverage: silencedetect each SOURCE segment and combine the placed voiced
    // spans on the clip timeline — deterministic and unaffected by the -shortest
    // truncation that would hide an overshoot in the output. (The per-line start
    // is folded into the placed spans, so offsetSec is 0 in the combined assess.)
    let coverage: CoverageReport | undefined;
    const placedStarts: number[] = [];
    const placedEnds: number[] = [];
    const placedAudioEnds: number[] = [];
    const measurements = await mapWithConcurrencyLimit(segs, MIX_COVERAGE_CONCURRENCY, (s) =>
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
      }
    }
    if (measuredAll && placedEnds.length) {
      coverage = assessVoiceoverCoverage({
        referenceDurationSec: base.durationSec,
        offsetSec: 0,
        audioDurationSec: Math.max(...placedAudioEnds),
        voicedStartSec: Math.min(...placedStarts),
        voicedEndSec: Math.max(...placedEnds),
      });
    }
    return { ok: true, op: 'mix', path: p.outputAbsPath, bytes: await statSize(p.outputAbsPath), ...(coverage ? { coverage } : {}) };
  }

  return fail('E_EDIT_ARG', `unknown op: ${String(p.op)}`);
}
