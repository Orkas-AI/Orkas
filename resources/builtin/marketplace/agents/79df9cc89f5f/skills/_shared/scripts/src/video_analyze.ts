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

import {
  measureSilenceCoverage,
  assessVoiceoverCoverage,
  detectSceneChanges,
  detectQuality,
} from './video_edit';
import type { QualityThresholds } from './video_decide';

const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export type AnalyzeOp = 'silence' | 'scenes' | 'quality';

export interface AnalyzeParams {
  op: AnalyzeOp;
  inputAbsPath: string;
  /** op:"scenes" only — scene-change sensitivity 0..1 (default 0.4; lower = more cuts). */
  threshold?: number;
  /** op:"quality" only — blur/brightness flag thresholds (defaults blur>15, dark<50, bright>200). */
  qualityThresholds?: QualityThresholds;
  signal?: AbortSignal;
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

  return { ok: false, errorCode: 'E_ANALYZE_ARG', message: `unknown op: ${String(p.op)}` };
}
