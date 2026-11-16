/**
 * video_analyze — local backend for the `analyze_media` tool. Handles
 * scene/silence/quality analysis over real footage. Spoken transcription is owned
 * by the built-in `video_studio` tool (`op: "speech.transcribe"`) so this
 * script stays independent from external render/transcription CLIs.
 *
 * Multi-op (room to grow: scenes / silence / highlights later). The tool layer
 * owns path-sandbox validation.
 */

import * as fs from 'node:fs/promises';

import { rhythm, tempoOf, STEADY_BEAT_CONFIDENCE } from './audio_rhythm';
import {
  decodeMonoPcm,
  probeVideoFps,
  measureRegionActivity,
  measureSilenceCoverage,
  assessVoiceoverCoverage,
  detectSceneChanges,
  detectQuality,
} from './video_edit';
import {
  normalizeTranscriptWords,
  packTranscriptPhrases,
  formatPhraseLines,
  PHRASE_MIN_PAUSE_SEC,
  normalizeActivityRegions,
  summarizeActivity,
  type QualityThresholds,
  type Word,
} from './video_decide';

const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export type AnalyzeOp = 'silence' | 'scenes' | 'quality' | 'phrases' | 'activity' | 'beats';

/** Beats returned by op:"beats"; a longer track reports its tempo and the first ones. */
export const BEATS_MAX_LISTED = 600;
/** The rate the beat tracker analyzes at; decoding straight to it skips resampling. */
const BEAT_ANALYSIS_RATE = 22050;
/** A cut further than this many frames from its nearest beat is called off the beat. */
export const BEAT_CUT_TOLERANCE_FRAMES = 1;

/** Windows returned by op:"activity"; a longer clip reports its turns only. */
export const ACTIVITY_MAX_WINDOWS = 240;

/** Lines returned inline by op:"phrases"; a longer view must be saved to a file. */
export const PHRASES_INLINE_MAX_LINES = 200;

export interface AnalyzeParams {
  op: AnalyzeOp;
  inputAbsPath: string;
  /** op:"scenes" only — scene-change sensitivity 0..1 (default 0.4; lower = more cuts). */
  threshold?: number;
  /** op:"quality" only — blur/brightness flag thresholds (defaults blur>15, dark<50, bright>200). */
  qualityThresholds?: QualityThresholds;
  /** op:"phrases" only — the speech.transcribe JSON for this media, the pause that
   *  starts a new line (default 0.5s) and the silence threshold (default -40 dB). */
  transcriptAbsPath?: string;
  /** Private selection executor: retain exact measured rows instead of display-rounded text. */
  structuredPhrases?: boolean;
  breakSec?: number;
  noiseDb?: number;
  /** op:"activity" only — a box per speaker's mouth (fractions of the frame), the
   *  window length, how far ahead a speaker must be, and the shortest turn kept. */
  regions?: unknown;
  windowSec?: number;
  leadRatio?: number;
  minTurnSec?: number;
  /** op:"beats" only — the frame rate to number beats at (default: the input's, else 30). */
  fps?: number;
  signal?: AbortSignal;
}

/** Each beat's loudness, RMS over ±50 ms, as a share of the loudest beat's. Pure. */
export function beatStrengths(samples: Float32Array, rate: number, times: number[]): number[] {
  const half = Math.round(0.05 * rate);
  const rms = times.map((t) => {
    const centre = Math.round(t * rate);
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, centre - half); i < Math.min(samples.length, centre + half); i += 1) { sum += samples[i] * samples[i]; n += 1; }
    return n ? Math.sqrt(sum / n) : 0;
  });
  const loudest = Math.max(0, ...rms);
  return rms.map((v) => (loudest > 0 ? Math.round((v / loudest) * 100) / 100 : 0));
}

/** Each cut's distance to the nearest beat, in seconds and in frames (cut minus beat). Pure. */
export function cutsAgainstBeats(cuts: number[], beats: number[], fps: number): Array<{ t: number; beat: number; offsetSec: number; offsetFrames: number }> {
  return cuts.map((t) => {
    let beat = beats[0];
    for (const b of beats) if (Math.abs(b - t) < Math.abs(beat - t)) beat = b;
    const offsetSec = Math.round((t - beat) * 1000) / 1000;
    return { t, beat, offsetSec, offsetFrames: Math.round(offsetSec * fps) };
  });
}

/** Words from a transcript, or its segments when it has no word timings. */
function transcriptUnits(json: unknown): { units: Word[]; detail: 'word' | 'segment' } {
  const words = normalizeTranscriptWords(json);
  if (words.length) return { units: words, detail: 'word' };
  const segments = json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).segments)
    ? normalizeTranscriptWords((json as Record<string, unknown>).segments)
    : [];
  return { units: segments, detail: 'segment' };
}

export type AnalyzeResult =
  | { ok: true; op: AnalyzeOp; summary: unknown }
  | { ok: false; errorCode: string; message: string };

export async function analyzeMedia(p: AnalyzeParams): Promise<AnalyzeResult> {
  const st = await fs.stat(p.inputAbsPath).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, errorCode: 'E_ANALYZE_NO_INPUT', message: `input is not a file: ${p.inputAbsPath}` };
  }

  if (p.op === 'silence') {
    const meas = await measureSilenceCoverage(p.inputAbsPath, p.signal ? { signal: p.signal } : {});
    if (meas.ok === false) return { ok: false, errorCode: meas.errorCode, message: meas.message };
    const t = meas.timing;
    // Self-coverage: does the file's voiced span fill its own duration? (Used as
    // a QA gate on a final draft — leading/trailing silence + uncovered tail.)
    const coverage = assessVoiceoverCoverage({
      referenceDurationSec: t.durationSec,
      offsetSec: 0,
      audioDurationSec: t.durationSec,
      voicedStartSec: t.voicedStartSec,
      voicedEndSec: t.voicedEndSec,
    });
    const summary = {
      op: 'silence',
      durationSec: round2(t.durationSec),
      voicedStartSec: round2(t.voicedStartSec),
      voicedEndSec: round2(t.voicedEndSec),
      voicedDurationSec: round2(t.voicedDurationSec),
      leadingSilenceSec: round2(t.leadingSilenceSec),
      trailingSilenceSec: round2(t.trailingSilenceSec),
      silences: t.silences.map((s) => ({ startSec: round2(s.startSec), endSec: round2(s.endSec) })),
      coverage,
    };
    return { ok: true, op: 'silence', summary };
  }

  if (p.op === 'scenes') {
    const r = await detectSceneChanges(p.inputAbsPath, {
      ...(p.signal ? { signal: p.signal } : {}),
      ...(typeof p.threshold === 'number' ? { threshold: p.threshold } : {}),
    });
    if (r.ok === false) return { ok: false, errorCode: r.errorCode, message: r.message };
    return {
      ok: true,
      op: 'scenes',
      summary: {
        op: 'scenes',
        durationSec: round2(r.durationSec),
        threshold: r.threshold,
        count: r.candidates.length,
        candidates: r.candidates.map((c) => ({ tSec: round2(c.tSec), score: c.score })),
      },
    };
  }

  if (p.op === 'quality') {
    const r = await detectQuality(p.inputAbsPath, {
      ...(p.signal ? { signal: p.signal } : {}),
      ...(p.qualityThresholds ? { thresholds: p.qualityThresholds } : {}),
    });
    if (r.ok === false) return { ok: false, errorCode: r.errorCode, message: r.message };
    return { ok: true, op: 'quality', summary: { op: 'quality', ...r.report } };
  }

  if (p.op === 'beats') {
    const samples = await decodeMonoPcm(p.inputAbsPath, BEAT_ANALYSIS_RATE, p.signal);
    if (!samples) return { ok: false, errorCode: 'E_ANALYZE_NO_AUDIO', message: 'beats needs a file with sound it can decode.' };
    const videoFps = await probeVideoFps(p.inputAbsPath, p.signal);
    const fps = typeof p.fps === 'number' && p.fps > 0 ? p.fps : videoFps ?? 30;
    const found = rhythm({ sampleRate: BEAT_ANALYSIS_RATE, channels: [samples] });
    const times = found.beats.times;
    const durationSec = round2(samples.length / BEAT_ANALYSIS_RATE);
    if (!times.length) {
      return {
        ok: true,
        op: 'beats',
        summary: {
          op: 'beats', durationSec, steady: false, confidence: found.beats.confidence ?? 0,
          reason: found.beats.reason ?? 'no steady beat',
          note: 'No beat to cut on: cut on phrases or strong moments instead, or hold.',
        },
      };
    }
    const strengths = beatStrengths(samples, BEAT_ANALYSIS_RATE, times);
    const beats = times.map((t, i) => ({ t, frame: Math.round(t * fps), strength: strengths[i] }));
    // A rendered video: where each of its cuts lands against the beat of its own sound.
    let cuts: Record<string, unknown> | undefined;
    if (videoFps) {
      const scenes = await detectSceneChanges(p.inputAbsPath, p.signal ? { signal: p.signal } : {});
      if (scenes.ok) {
        const measured = cutsAgainstBeats(scenes.candidates.map((c) => c.tSec), times, fps);
        const off = measured.filter((c) => Math.abs(c.offsetFrames) > BEAT_CUT_TOLERANCE_FRAMES);
        cuts = {
          count: measured.length,
          off_beat: off.length,
          list: measured.slice(0, 200).map((c) => ({ t: c.t, beat: c.beat, offset_sec: c.offsetSec, offset_frames: c.offsetFrames })),
        };
      }
    }
    return {
      ok: true,
      op: 'beats',
      summary: {
        op: 'beats',
        durationSec,
        steady: (found.beats.confidence ?? 0) >= STEADY_BEAT_CONFIDENCE,
        confidence: found.beats.confidence ?? 0,
        bpm: tempoOf(times).value,
        fps,
        beatCount: beats.length,
        beats: beats.slice(0, BEATS_MAX_LISTED),
        ...(beats.length > BEATS_MAX_LISTED ? { note: `${beats.length - BEATS_MAX_LISTED} more beats not listed.` } : {}),
        downbeats: { times: found.downbeats.times.slice(0, 200), meter: found.downbeats.meter, confidence: 'low' },
        ...(cuts ? { cuts } : {}),
      },
    };
  }

  if (p.op === 'activity') {
    if (p.windowSec !== undefined && (!Number.isFinite(p.windowSec) || p.windowSec <= 0 || !Number.isFinite(1 / p.windowSec))) {
      return { ok: false, errorCode: 'E_ANALYZE_ARG', message: 'activity --window must be a positive finite number; use a larger window if it is too small to compute.' };
    }
    const regions = normalizeActivityRegions(p.regions);
    if (typeof regions === 'string') return { ok: false, errorCode: 'E_ANALYZE_ARG', message: `activity ${regions}` };
    const measured = await measureRegionActivity(p.inputAbsPath, regions, p.signal ? { signal: p.signal } : {});
    if (measured.ok === false) return { ok: false, errorCode: measured.errorCode, message: measured.message };
    let activity: ReturnType<typeof summarizeActivity>;
    try {
      // The summarizer owns duration fallback as well as its allocation budget.
      activity = summarizeActivity(measured.series, {
        durationSec: measured.durationSec,
        ...(typeof p.windowSec === 'number' ? { windowSec: p.windowSec } : {}),
        ...(typeof p.leadRatio === 'number' ? { leadRatio: p.leadRatio } : {}),
        ...(typeof p.minTurnSec === 'number' ? { minTurnSec: p.minTurnSec } : {}),
      });
    } catch (err) {
      if (err instanceof RangeError) return { ok: false, errorCode: 'E_ANALYZE_ARG', message: err.message };
      throw err;
    }
    const { windows, turns } = activity;
    const centre = Object.fromEntries(regions.map((r) => [r.id, { x: round2((r.box[0] + r.box[2]) / 2), y: round2((r.box[1] + r.box[3]) / 2) }]));
    return {
      ok: true,
      op: 'activity',
      summary: {
        op: 'activity',
        durationSec: round2(measured.durationSec),
        regions,
        turns: turns.map((t) => ({ start: t.startSec, end: t.endSec, region: t.regionId, centre: centre[t.regionId] })),
        // Ready for `edit_video --op reframe --plan`, once each turn is checked.
        plan: turns.map((t) => ({ start: t.startSec, centre_x: centre[t.regionId].x, centre_y: centre[t.regionId].y })),
        windowCount: windows.length,
        ...(windows.length <= ACTIVITY_MAX_WINDOWS
          ? { windows: windows.map((w) => ({ start: w.startSec, end: w.endSec, lead: w.lead, levels: w.levels })) }
          : { note: `${windows.length} windows; only turns are listed.` }),
        caution: 'Motion inside each box stands in for speech. It holds for a still camera with each mouth in its box; check a frame at every turn before cutting on it.',
      },
    };
  }

  if (p.op === 'phrases') {
    if (!p.transcriptAbsPath) return { ok: false, errorCode: 'E_ANALYZE_ARG', message: 'phrases requires --transcript (the speech.transcribe JSON for this media)' };
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(p.transcriptAbsPath, 'utf8'));
    } catch (err) {
      return { ok: false, errorCode: 'E_ANALYZE_TRANSCRIPT', message: `transcript is not readable JSON: ${(err as Error).message}` };
    }
    const { units, detail } = transcriptUnits(json);
    if (!units.length) return { ok: false, errorCode: 'E_ANALYZE_TRANSCRIPT', message: 'transcript has no timed words or segments' };
    const meas = await measureSilenceCoverage(p.inputAbsPath, {
      ...(p.signal ? { signal: p.signal } : {}),
      ...(typeof p.noiseDb === 'number' ? { noiseDb: p.noiseDb } : {}),
      minSilenceSec: PHRASE_MIN_PAUSE_SEC,
    });
    if (meas.ok === false) return { ok: false, errorCode: meas.errorCode, message: meas.message };
    const lines = packTranscriptPhrases(units, meas.timing.silences, {
      ...(typeof p.breakSec === 'number' ? { breakSec: p.breakSec } : {}),
      ...(detail === 'segment' ? { segments: true } : {}),
    });
    const text = formatPhraseLines(lines);
    return {
      ok: true,
      op: 'phrases',
      summary: {
        op: 'phrases',
        durationSec: round2(meas.timing.durationSec),
        timing: detail,
        lines: lines.length,
        measuredPauses: meas.timing.silences.length,
        ...(p.structuredPhrases ? { phrases: lines } : {}),
        note: 'Times and pauses are measured from the recording; the words come from speech recognition and can sit up to about a second off. A word at the start or end of a line may belong to the line next to it: cut at line edges or marked pauses, never inside a line to drop such a word.',
        text,
      },
    };
  }

  return { ok: false, errorCode: 'E_ANALYZE_ARG', message: `unknown op: ${String(p.op)}` };
}
