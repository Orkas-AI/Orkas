/**
 * Delivery verification for an assembled AUTO production.
 *
 * Every check the assembly tiers carry — narration coverage, duration drift,
 * loudness — lives on the OPERATION that performs the step, so choosing a
 * different route silently drops all of them. On 2026-08-10 a run assembled
 * with hand-written ffmpeg instead of `stage-edit edit_video --op concat/mix/
 * normalize_loudness`; that is a legitimate fallback and stays available, but
 * it shipped 0.44s of two voices talking over each other, -18.3 LUFS against a
 * -14 target, and none of the 8 declared caption lines, and the model reported
 * "narration added, AAC 48kHz". Two of the three real assemblies on this
 * machine had taken that route at least once.
 *
 * So this verifies the ARTIFACT against the signed plan and never asks how the
 * artifact was made. Same bar for every route.
 *
 * Measurement (needs ffmpeg) is separated from assessment (pure) so the
 * judgement is unit-testable against real captured numbers.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { bundledFfmpegPaths } from '../util/bundled-runtime';

const log = createLogger('video-studio-delivery');

/** Same targets the assembly tier normalizes to (video-craft §7). */
export const DELIVERY_LOUDNESS_TARGET_I = -14;
/** Integrated loudness within this many LU of target is delivery-clean. Wider
 *  than a mastering tolerance on purpose: platforms renormalize, so this is
 *  meant to catch "nobody normalized at all", not to grade a mix. */
export const DELIVERY_LOUDNESS_TOLERANCE_LU = 2;
/** Duration agreement between the delivered file and the signed plan. */
export const DELIVERY_DURATION_TOLERANCE_SEC = 0.5;
/** Two lines closer than this are treated as touching, not overlapping —
 *  silencedetect boundaries are not frame-exact. */
export const DELIVERY_OVERLAP_TOLERANCE_SEC = 0.05;

export type DeliveryVideoSpec = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  subtitleStreams: number;
};

export type DeliveryNarrationLine = {
  index: number;
  startSec: number;
  targetSec: number | null;
  /** Absolute seconds on the delivered timeline where this line's speech
   *  actually starts and stops — NOT the file's byte duration. A provider that
   *  pads silence would otherwise read as an overlap it does not cause. */
  voicedStartSec: number;
  voicedEndSec: number;
  textHead: string;
};

export type DeliveryIssue = {
  code:
    | 'DELIVERY_NARRATION_OVERLAP'
    | 'DELIVERY_NARRATION_TRUNCATED'
    | 'DELIVERY_DURATION_DRIFT'
    | 'DELIVERY_ASPECT_MISMATCH'
    | 'DELIVERY_NO_AUDIO'
    | 'DELIVERY_LOUDNESS_OFF_TARGET'
    | 'DELIVERY_CAPTIONS_MISSING'
    | 'DELIVERY_NARRATION_UNVERIFIABLE';
  severity: 'error' | 'warning';
  message: string;
};

/** Overlapping or truncated speech in the delivered timeline.
 *
 * Judged on voiced spans, the same way `assessVoiceoverCoverage` judges a mix,
 * because a file's duration is not its speech: the 2026-08-10 files happened to
 * carry no trailing silence, so duration math agreed by luck, and a provider
 * that pads would have produced false overlaps on every line. Interior gaps are
 * deliberately NOT reported as issues — a measured survey of 13 plans put a
 * usable gap threshold at 6 of 13 firing, so held silence stays the author's
 * call. */
export function assessDeliveredNarration(
  lines: readonly DeliveryNarrationLine[],
  videoDurationSec: number | null,
): DeliveryIssue[] {
  const issues: DeliveryIssue[] = [];
  const ordered = [...lines].sort((a, b) => a.voicedStartSec - b.voicedStartSec);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const line = ordered[i];
    const overlap = prev.voicedEndSec - line.voicedStartSec;
    if (overlap > DELIVERY_OVERLAP_TOLERANCE_SEC) {
      issues.push({
        code: 'DELIVERY_NARRATION_OVERLAP',
        severity: 'error',
        message: `Narration lines ${prev.index} and ${line.index} both speak for ${overlap.toFixed(2)}s`
          + ` — line ${prev.index} runs to ${prev.voicedEndSec.toFixed(2)}s and line ${line.index} starts at`
          + ` ${line.voicedStartSec.toFixed(2)}s. Shorten line ${prev.index} and re-synthesize it, or move line`
          + ` ${line.index} later in the plan.`,
      });
    }
  }
  const last = ordered.at(-1);
  if (last && typeof videoDurationSec === 'number' && videoDurationSec > 0) {
    const past = last.voicedEndSec - videoDurationSec;
    if (past > DELIVERY_OVERLAP_TOLERANCE_SEC) {
      issues.push({
        code: 'DELIVERY_NARRATION_TRUNCATED',
        severity: 'error',
        message: `Narration line ${last.index} still speaks ${past.toFixed(2)}s after the ${videoDurationSec.toFixed(2)}s`
          + ' video ends, so that much of it is missing from the deliverable. Shorten that line and re-synthesize it,'
          + ' or extend the video to cover it.',
      });
    }
  }
  return issues;
}

/** Delivered file against the signed plan: length, canvas, audio presence,
 *  loudness, and declared captions. */
export function assessDeliveredSpec(input: {
  spec: DeliveryVideoSpec;
  planTotalTargetSec: number | null;
  planAspect: string | null;
  narrationLineCount: number;
  captionLineCount: number;
  integratedLufs: number | null;
  sidecarSubtitleFound: boolean;
}): DeliveryIssue[] {
  const issues: DeliveryIssue[] = [];
  const { spec } = input;
  if (typeof spec.durationSec === 'number' && typeof input.planTotalTargetSec === 'number'
    && input.planTotalTargetSec > 0) {
    const drift = Math.abs(spec.durationSec - input.planTotalTargetSec);
    if (drift > DELIVERY_DURATION_TOLERANCE_SEC) {
      issues.push({
        code: 'DELIVERY_DURATION_DRIFT',
        severity: 'error',
        message: `The delivered video is ${spec.durationSec.toFixed(2)}s but the approved plan is`
          + ` ${input.planTotalTargetSec}s (off by ${drift.toFixed(2)}s). Everything timed against the plan —`
          + ' narration placement, captions — is judged against the plan length, so this has to agree before delivery.',
      });
    }
  }
  const aspect = parseAspectRatio(input.planAspect);
  if (aspect && spec.width && spec.height) {
    const delivered = spec.width / spec.height;
    if (Math.abs(delivered - aspect) / aspect > 0.02) {
      issues.push({
        code: 'DELIVERY_ASPECT_MISMATCH',
        severity: 'error',
        message: `The delivered video is ${spec.width}x${spec.height} but the approved plan is ${input.planAspect}.`,
      });
    }
  }
  if (input.narrationLineCount > 0 && !spec.hasAudio) {
    issues.push({
      code: 'DELIVERY_NO_AUDIO',
      severity: 'error',
      message: `The plan carries ${input.narrationLineCount} narration line(s) but the delivered file has no audio track.`,
    });
  }
  if (spec.hasAudio && typeof input.integratedLufs === 'number') {
    const off = input.integratedLufs - DELIVERY_LOUDNESS_TARGET_I;
    if (Math.abs(off) > DELIVERY_LOUDNESS_TOLERANCE_LU) {
      issues.push({
        code: 'DELIVERY_LOUDNESS_OFF_TARGET',
        severity: 'warning',
        message: `The delivered audio measures ${input.integratedLufs.toFixed(1)} LUFS against a`
          + ` ${DELIVERY_LOUDNESS_TARGET_I} LUFS target (${off > 0 ? 'louder' : 'quieter'} by`
          + ` ${Math.abs(off).toFixed(1)} LU). Run the assembly loudness step on the final file.`,
      });
    }
  }
  if (input.captionLineCount > 0 && spec.subtitleStreams === 0 && !input.sidecarSubtitleFound) {
    issues.push({
      code: 'DELIVERY_CAPTIONS_MISSING',
      severity: 'warning',
      message: `The plan declares ${input.captionLineCount} caption line(s), and the delivered file has no subtitle`
        + ' stream and no sidecar subtitle file beside it. Burned-in captions cannot be detected from the container,'
        + ' so if they were burned in say so; otherwise the captions track was not produced.',
    });
  }
  return issues;
}

/** `16:9` -> 1.777…; anything unparseable -> null (no aspect claim to check). */
export function parseAspectRatio(value: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return w / h;
}

/** Voiced span of one audio file, in file-relative seconds.
 *
 * Trailing silence exists only when the final `silence_start` has no matching
 * `silence_end`; the pairs in between are ordinary phrase pauses. Reading the
 * last `silence_start` as the end of speech reports a 4.26s file as 1.47s of
 * audio. */
export function parseVoicedSpan(stderr: string, durationSec: number): { startSec: number; endSec: number } {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const leading = starts.length && ends.length && starts[0] <= 0.001 ? ends[0] : 0;
  const trailing = starts.length > ends.length ? Math.max(0, durationSec - starts[starts.length - 1]) : 0;
  const startSec = Math.min(Math.max(0, leading), durationSec);
  const endSec = Math.max(startSec, durationSec - trailing);
  return { startSec, endSec };
}

/** Integrated LUFS of a delivered file, or null when it cannot be measured.
 *
 * Reads the ebur128 SUMMARY, never the running log: that log carries its own
 * `I:` and the first line always reads the -70 LUFS gate floor. */
export function parseIntegratedLufs(stderr: string): number | null {
  const at = stderr.toLowerCase().lastIndexOf('summary:');
  if (at < 0) return null;
  const match = /\bI:\s*(-?(?:inf|[\d.]+))\s*LUFS/i.exec(stderr.slice(at));
  if (!match || /inf/i.test(match[1])) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, signal ? { signal } : {});
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
  });
}

export async function probeDeliveredVideo(videoAbsPath: string, signal?: AbortSignal): Promise<DeliveryVideoSpec | null> {
  const { ffprobe } = bundledFfmpegPaths();
  if (!ffprobe) return null;
  const r = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoAbsPath,
  ], signal);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: { duration?: string };
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const rate = String(video?.r_frame_rate ?? '');
    const [num, den] = rate.split('/').map(Number);
    return {
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
      width: typeof video?.width === 'number' ? video.width : null,
      height: typeof video?.height === 'number' ? video.height : null,
      fps: Number.isFinite(num) && Number.isFinite(den) && den ? num / den : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      subtitleStreams: streams.filter((s) => s.codec_type === 'subtitle').length,
    };
  } catch (err) {
    log.warn(`delivered probe parse failed: ${(err as Error).message}`);
    return null;
  }
}

export async function measureIntegratedLufs(videoAbsPath: string, signal?: AbortSignal): Promise<number | null> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg) return null;
  const r = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-i', videoAbsPath, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], signal);
  return parseIntegratedLufs(r.stderr);
}

export async function measureVoicedSpan(
  audioAbsPath: string,
  signal?: AbortSignal,
): Promise<{ startSec: number; endSec: number; durationSec: number } | null> {
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (!ffmpeg || !ffprobe) return null;
  const probe = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioAbsPath,
  ], signal);
  const durationSec = Number(String(probe.stdout).trim());
  if (!(durationSec > 0)) return null;
  const detect = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-i', audioAbsPath, '-af', 'silencedetect=noise=-45dB:d=0.15', '-f', 'null', '-',
  ], signal);
  const span = parseVoicedSpan(detect.stderr, durationSec);
  return { ...span, durationSec };
}

export type DeliveryVerdict = {
  ok: boolean;
  video_path: string;
  duration_sec: number | null;
  canvas: string | null;
  fps: number | null;
  integrated_lufs: number | null;
  narration_lines_measured: number;
  issues: DeliveryIssue[];
  note: string;
};

const SUBTITLE_SIDECAR_EXTENSIONS = ['.srt', '.vtt', '.ass'];

async function sidecarSubtitleExists(videoAbsPath: string): Promise<boolean> {
  const stem = videoAbsPath.replace(/\.[^.\\/]+$/, '');
  for (const ext of SUBTITLE_SIDECAR_EXTENSIONS) {
    try {
      await fs.access(`${stem}${ext}`);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

/** Verify one delivered video against the plan it was produced from.
 *
 * Route-agnostic on purpose: it reads the artifact and the signed plan, never
 * how the file was built, so the hand-written ffmpeg fallback and the assembly
 * ops are held to the same bar. */
export async function verifyProductionDelivery(input: {
  planAbsPath: string;
  plan: Record<string, unknown>;
  videoAbsPath: string;
  signal?: AbortSignal;
}): Promise<DeliveryVerdict> {
  // The plan lives at `<video>/project/plan.json` and its own paths read
  // `project/audio/<line>.mp3`, so a relative produced_path is relative to the
  // VIDEO directory, not the plan's own folder — the same base
  // videoProductionSegmentReviewRecords and the review panel already use.
  // Resolving one level too deep produced `<video>/project/project/audio/...`,
  // which never exists: on 2026-08-10 every line was measured as unreadable,
  // DELIVERY_NARRATION_UNVERIFIABLE fired seven times in a row, and the model
  // rewrote paths that had been correct all along before publishing anyway.
  const videoDir = path.dirname(path.dirname(input.planAbsPath));
  const spec = await probeDeliveredVideo(input.videoAbsPath, input.signal);
  const tracks = (input.plan.tracks && typeof input.plan.tracks === 'object' && !Array.isArray(input.plan.tracks))
    ? input.plan.tracks as Record<string, unknown>
    : {};
  const narration = (tracks.narration && typeof tracks.narration === 'object' && !Array.isArray(tracks.narration))
    ? tracks.narration as Record<string, unknown>
    : undefined;
  const narrationSegments = Array.isArray(narration?.segments) ? narration!.segments as Record<string, unknown>[] : [];
  const captions = (tracks.captions && typeof tracks.captions === 'object' && !Array.isArray(tracks.captions))
    ? tracks.captions as Record<string, unknown>
    : undefined;
  const captionLines = Array.isArray(captions?.lines) ? captions!.lines.length : 0;

  const measured: DeliveryNarrationLine[] = [];
  // Why each unjudged line could not be judged, so the refusal names the field
  // that is actually missing. Collapsing them into "no readable produced_path"
  // sent the 2026-08-10 run chasing paths that were already correct: the lines
  // carried produced_path and target_sec but no start_sec, and the model
  // rewrote the paths seven times against a message describing the wrong gap.
  const unjudged: Array<{ index: number; reason: string }> = [];
  for (let index = 0; index < narrationSegments.length; index += 1) {
    const line = narrationSegments[index];
    const produced = typeof line.produced_path === 'string' ? line.produced_path.trim() : '';
    const startSec = Number(line.start_sec);
    if (!produced) {
      unjudged.push({ index, reason: 'no produced_path' });
      continue;
    }
    if (!Number.isFinite(startSec)) {
      unjudged.push({ index, reason: 'no start_sec (its position on the timeline)' });
      continue;
    }
    const audioAbs = path.isAbsolute(produced) ? produced : path.resolve(videoDir, produced);
    const span = await measureVoicedSpan(audioAbs, input.signal);
    if (!span) {
      unjudged.push({ index, reason: `audio at ${produced} could not be read` });
      continue;
    }
    measured.push({
      index,
      startSec,
      targetSec: Number.isFinite(Number(line.target_sec)) ? Number(line.target_sec) : null,
      voicedStartSec: startSec + span.startSec,
      voicedEndSec: startSec + span.endSec,
      textHead: String(line.text ?? '').slice(0, 20),
    });
  }

  const integratedLufs = spec?.hasAudio ? await measureIntegratedLufs(input.videoAbsPath, input.signal) : null;
  const issues: DeliveryIssue[] = [];
  if (!spec) {
    issues.push({
      code: 'DELIVERY_DURATION_DRIFT',
      severity: 'error',
      message: `The delivered file at ${input.videoAbsPath} could not be probed, so nothing about it can be verified.`,
    });
  } else {
    issues.push(...assessDeliveredSpec({
      spec,
      planTotalTargetSec: Number.isFinite(Number(input.plan.total_target_sec))
        ? Number(input.plan.total_target_sec)
        : null,
      planAspect: typeof input.plan.aspect === 'string' ? input.plan.aspect : null,
      narrationLineCount: narrationSegments.length,
      captionLineCount: captionLines,
      integratedLufs,
      sidecarSubtitleFound: await sidecarSubtitleExists(input.videoAbsPath),
    }));
    issues.push(...assessDeliveredNarration(measured, spec.durationSec));
  }

  // A declared narration track that could not be judged is UNVERIFIED, not
  // clean. The first version reported ok:true with a note when no line carried
  // a produced_path — and that is exactly the shape the hand-assembled route
  // produces, because it mixes the audio files directly and never writes the
  // paths back. So the one check that exists for that route reported a pass on
  // the very run whose delivery had two overlapping lines (2026-08-10).
  //
  // Overlap cannot be recovered from the artifact alone: the delivered track is
  // one mixed stream, where two voices at once and one continuous voice are the
  // same waveform. Per-line audio is required, so the honest answer when it is
  // missing is "not verified" plus what to write back.
  if (unjudged.length) {
    issues.push({
      code: 'DELIVERY_NARRATION_UNVERIFIABLE',
      severity: 'error',
      message: `${unjudged.length} of ${narrationSegments.length} narration line(s) could not be placed on the timeline, so this`
        + ' delivery is unverified rather than clean: '
        + unjudged.map((u) => `line ${u.index} — ${u.reason}`).join('; ')
        + '. Overlap and truncation are judged from each line\'s own audio at its own start, which the mixed track cannot'
        + ' supply. Fill exactly the fields named above in tracks.narration.segments and re-run this check.',
    });
  }
  const blocking = issues.filter((issue) => issue.severity === 'error');
  return {
    ok: blocking.length === 0,
    video_path: input.videoAbsPath,
    duration_sec: spec?.durationSec ?? null,
    canvas: spec?.width && spec?.height ? `${spec.width}x${spec.height}` : null,
    fps: spec?.fps ?? null,
    integrated_lufs: integratedLufs,
    narration_lines_measured: measured.length,
    issues,
    note: 'Checked against the approved plan, not against how the file was assembled.',
  };
}
