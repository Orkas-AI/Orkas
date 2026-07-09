/**
 * video_analyze — local backend for the `analyze_media` tool. Handles
 * frame/text/quality analysis over real footage. Spoken transcription is owned
 * by the built-in `video_studio` tool (`op: "speech.transcribe"`) so this
 * script stays independent from external render/transcription CLIs.
 *
 * Multi-op (room to grow: scenes / silence / highlights later). The tool layer
 * owns path-sandbox validation.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  measureSilenceCoverage,
  assessVoiceoverCoverage,
  extractFrameAt,
  probeMediaDurationSec,
  detectSceneChanges,
  detectQuality,
} from './video_edit';
import type { QualityThresholds } from './video_decide';
import { ocrImageText, ocrImagesText } from './ocr_runtime';

const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** Best-effort progress JSONL on stderr (same protocol as video_edit); the
 *  direct-CLI runner forwards these lines to the user-facing tool progress. */
function emitAnalyzeProgress(op: AnalyzeOp, event: Record<string, unknown>): void {
  const payload = { type: 'progress', source: 'video_analyze', op, phase: op, ...event };
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Progress must never break the media operation.
  }
}

export type AnalyzeOp = 'silence' | 'ocr' | 'scenes' | 'quality';

export interface AnalyzeParams {
  op: AnalyzeOp;
  inputAbsPath: string;
  /** op:"ocr" only — seconds between sampled frames (default 2.5). */
  intervalSec?: number;
  /** op:"ocr" only — cap on sampled frames (default 16). */
  maxFrames?: number;
  /** op:"scenes" only — scene-change sensitivity 0..1 (default 0.4; lower = more cuts). */
  threshold?: number;
  /** op:"quality" only — blur/brightness flag thresholds (defaults blur>15, dark<50, bright>200). */
  qualityThresholds?: QualityThresholds;
  signal?: AbortSignal;
}

export type AnalyzeResult =
  | { ok: true; op: AnalyzeOp; summary: unknown }
  | { ok: false; errorCode: string; message: string };

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

function ocrInputKind(p: string): 'image' | 'video' | 'unsupported' {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'unsupported';
}

/** Pick frame sample timecodes (seconds) across a clip: ~1 frame / `intervalSec`
 *  starting half a step in (so we read mid-slide, not on a transition). If that
 *  interval would need more than `maxFrames` frames, the step is widened so the
 *  cap of samples still spreads start→end — a long clip never loses its tail to
 *  the cap. Pure → unit-tested. */
export function sampleTimecodes(durationSec: number, intervalSec: number, maxFrames: number): number[] {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (dur <= 0) return [0];
  const cap = Math.max(1, Math.min(Math.floor(Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : 16), 60));
  const desired = Math.max(0.5, Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 2.5);
  const step = Math.max(desired, dur / cap);
  const out: number[] = [];
  for (let t = step / 2; t < dur && out.length < cap; t += step) {
    out.push(round2(t));
  }
  if (!out.length) out.push(round2(dur / 2));
  return out;
}

/** Collapse consecutive frames whose OCR text is identical (whitespace-normalized)
 *  into time-ranged segments, then stretch each segment's end to the next one's
 *  start (clip end for the last) so the table covers the whole timeline. Turns
 *  interval samples into a clean per-slide table. Pure → unit-tested. */
export function collapseOcrSegments(
  frames: Array<{ tSec: number; text: string }>,
  durationSec: number,
): Array<{ startSec: number; endSec: number; text: string }> {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const segs: Array<{ startSec: number; endSec: number; text: string }> = [];
  for (const f of frames) {
    const prev = segs[segs.length - 1];
    if (prev && norm(prev.text) === norm(f.text)) prev.endSec = f.tSec;
    else segs.push({ startSec: f.tSec, endSec: f.tSec, text: f.text });
  }
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    segs[i].startSec = round2(i === 0 ? 0 : segs[i].startSec);
    segs[i].endSec = round2(next ? next.startSec : Math.max(segs[i].endSec, durationSec));
  }
  return segs;
}

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

  if (p.op === 'ocr') {
    const kind = ocrInputKind(p.inputAbsPath);
    if (kind === 'unsupported') {
      return { ok: false, errorCode: 'E_ANALYZE_ARG', message: `ocr input must be an image or video: ${p.inputAbsPath}` };
    }

    if (kind === 'image') {
      const r = await ocrImageText({ absPath: p.inputAbsPath, ...(p.signal ? { signal: p.signal } : {}) });
      if (r.ok === false) return { ok: false, errorCode: r.errorCode, message: r.message };
      return { ok: true, op: 'ocr', summary: { op: 'ocr', engine: 'local:rapidocr-onnxruntime', kind: 'image', text: r.text } };
    }

    // Video: sample frames across the timeline → ONE batch OCR (single Python
    // process / single model load instead of a cold engine per frame) →
    // collapse identical consecutive reads into a per-slide timecode table.
    const durationSec = (await probeMediaDurationSec(p.inputAbsPath, p.signal)) ?? 0;
    if (durationSec <= 0) {
      return { ok: false, errorCode: 'E_ANALYZE_FAILED', message: 'could not probe video duration for frame sampling.' };
    }
    const times = sampleTimecodes(durationSec, p.intervalSec ?? 2.5, p.maxFrames ?? 16);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-ocr-'));
    try {
      let firstErr: { errorCode: string; message: string } | null = null;
      const extracted: Array<{ tSec: number; framePath: string }> = [];
      for (const t of times) {
        if (p.signal?.aborted) return { ok: false, errorCode: 'E_ANALYZE_ABORTED', message: 'ocr aborted.' };
        const out = path.join(tmp, `f-${Math.round(t * 1000)}.png`);
        const ex = await extractFrameAt(p.inputAbsPath, t, out, p.signal);
        if (ex.ok === false) { if (!firstErr) firstErr = ex; continue; }
        extracted.push({ tSec: t, framePath: out });
      }
      if (!extracted.length) {
        return { ok: false, errorCode: firstErr?.errorCode ?? 'E_ANALYZE_FAILED', message: firstErr?.message ?? 'ocr produced no frames.' };
      }
      emitAnalyzeProgress('ocr', { status: 'ocr_batch', frames: extracted.length });
      const batch = await ocrImagesText({
        absPaths: extracted.map((f) => f.framePath),
        ...(p.signal ? { signal: p.signal } : {}),
        onProgress: (ev) => emitAnalyzeProgress('ocr', { status: ev.phase, ...(ev.message ? { detail: ev.message } : {}) }),
      });
      if (batch.ok === false) {
        // Runtime install/missing is surfaced as-is so the workflow can apply
        // its own fallback; a whole-batch OCR failure is an analyze failure.
        return { ok: false, errorCode: batch.errorCode, message: batch.message };
      }
      const frames: Array<{ tSec: number; text: string }> = [];
      for (let i = 0; i < extracted.length; i++) {
        const r = batch.results[i];
        if (!r || r.error) { if (!firstErr && r?.error) firstErr = { errorCode: 'E_OCR_FAILED', message: r.error }; continue; }
        frames.push({ tSec: extracted[i].tSec, text: r.text });
      }
      if (!frames.length) {
        return { ok: false, errorCode: firstErr?.errorCode ?? 'E_ANALYZE_FAILED', message: firstErr?.message ?? 'ocr produced no frames.' };
      }
      const segments = collapseOcrSegments(frames, durationSec);
      return {
        ok: true,
        op: 'ocr',
        summary: {
          op: 'ocr',
          engine: 'local:rapidocr-onnxruntime',
          kind: 'video',
          durationSec: round2(durationSec),
          sampledFrames: frames.length,
          segments,
        },
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { ok: false, errorCode: 'E_ANALYZE_ARG', message: `unknown op: ${String(p.op)}` };
}
