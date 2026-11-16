
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { rhythmSteps } from './audio_rhythm';
import { runVideoProcessForTest, transcribeSpeech } from './video_studio';
import { parseSilenceLog, type PhraseSpan } from './video_phrases';
import { isPathAllowed } from '../util/path-sandbox';
import { sha256OfFileStream } from '../util/sha256';

const log = createLogger('video-studio-delivery');

/** Same targets the assembly tier normalizes to (video-craft §7). */
export const DELIVERY_LOUDNESS_TARGET_I = -14;
/** Integrated loudness within this many LU of target is delivery-clean. Wider
 *  than a mastering tolerance on purpose: platforms renormalize, so this is
 *  meant to catch "nobody normalized at all", not to grade a mix. */
export const DELIVERY_LOUDNESS_TOLERANCE_LU = 2;
/** Duration agreement between the delivered file and what it should be. */
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
  audioStreams?: number;
  subtitleStreams: number;
  videoDurationSec?: number;
  audioDurationSec?: number;
  /** A mix marker requires narration evidence; it cannot establish a clean result. */
  narrationMixExpected?: boolean;
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
    | 'DELIVERY_VIDEO_UNREADABLE'
    | 'DELIVERY_NARRATION_OVERLAP'
    | 'DELIVERY_NARRATION_TRUNCATED'
    | 'DELIVERY_DURATION_DRIFT'
    | 'DELIVERY_ASPECT_MISMATCH'
    | 'DELIVERY_NO_AUDIO'
    | 'DELIVERY_AUDIO_SILENT'
    | 'DELIVERY_AUDIO_UNVERIFIABLE'
    | 'DELIVERY_LOUDNESS_OFF_TARGET'
    | 'DELIVERY_SILENT_STRETCH'
    | 'DELIVERY_NARRATION_OVER_SPEECH'
    | 'DELIVERY_CUTS_OFF_BEAT'
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
          + ` ${line.voicedStartSec.toFixed(2)}s. Shorten line ${prev.index} and re-synthesize it, or start line`
          + ` ${line.index} later.`,
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

/** Delivered file against what it should be: length, canvas, audio presence,
 *  loudness, and requested captions. */
export function assessDeliveredSpec(input: {
  spec: DeliveryVideoSpec;
  expectedDurationSec: number | null;
  /** Where the expected length came from: the video's timeline, or the length the Agent passed
   *  for a file it made itself. Only the first has narration and captions timed against it. */
  durationSource?: 'timeline' | 'requested';
  expectedAspect: string | null;
  expectsAudio: boolean;
  expectsCaptions: boolean;
  integratedLufs: number | null;
  /** Full successful decode: true only when every sample in every audio stream is zero. */
  digitalSilence?: boolean | null;
  sidecarSubtitleFound: boolean;
}): DeliveryIssue[] {
  const issues: DeliveryIssue[] = [];
  const { spec } = input;
  if (typeof spec.durationSec === 'number' && typeof input.expectedDurationSec === 'number'
    && input.expectedDurationSec > 0) {
    const drift = Math.abs(spec.durationSec - input.expectedDurationSec);
    if (drift > DELIVERY_DURATION_TOLERANCE_SEC) {
      // A file the Agent cut itself was once slowed down to match a rounded "about 15 s"
      // (2026-11-14 montage run), changing the music it was cut to.
      issues.push({
        code: 'DELIVERY_DURATION_DRIFT',
        severity: 'error',
        message: input.durationSource === 'requested'
          ? `The delivered video is ${spec.durationSec.toFixed(2)}s but expect_duration_sec says`
            + ` ${input.expectedDurationSec}s (off by ${drift.toFixed(2)}s). If you made it this length on purpose,`
            + ' deliver it again with its real length as expect_duration_sec. Do not speed up, slow down or pad'
            + ' a finished cut to reach a number: that changes its music and the timing it was cut to.'
          : `The delivered video is ${spec.durationSec.toFixed(2)}s but it should be`
            + ` ${input.expectedDurationSec}s (off by ${drift.toFixed(2)}s). Narration and captions are timed against`
            + ' that length, so the two have to agree before delivery.',
      });
    }
  }
  const aspect = parseAspectRatio(input.expectedAspect);
  if (aspect && spec.width && spec.height) {
    const delivered = spec.width / spec.height;
    if (Math.abs(delivered - aspect) / aspect > 0.02) {
      issues.push({
        code: 'DELIVERY_ASPECT_MISMATCH',
        severity: 'error',
        message: `The delivered video is ${spec.width}x${spec.height} but it should be ${input.expectedAspect}.`,
      });
    }
  }
  if (input.expectsAudio && !spec.hasAudio) {
    issues.push({
      code: 'DELIVERY_NO_AUDIO',
      severity: 'error',
      message: 'This video should have sound, but the delivered file has no audio track.',
    });
  }
  if (input.expectsAudio && spec.hasAudio && input.digitalSilence === true) {
    issues.push({
      code: 'DELIVERY_AUDIO_SILENT',
      severity: 'error',
      message: 'This video should have sound, but every decoded audio sample in the final file is zero. Check the source audio and mix gains, repair the mix, then render and ship again.',
    });
  } else if (input.expectsAudio && spec.hasAudio && input.digitalSilence === null) {
    issues.push({
      code: 'DELIVERY_AUDIO_UNVERIFIABLE',
      severity: 'warning',
      message: 'The final file has audio, but a complete audio measurement was unavailable. Its sound has not been verified; listen to the final file before using it.',
    });
  }
  if (spec.hasAudio && input.digitalSilence !== true && typeof input.integratedLufs === 'number' && Number.isFinite(input.integratedLufs)) {
    const off = input.integratedLufs - DELIVERY_LOUDNESS_TARGET_I;
    if (Math.abs(off) > DELIVERY_LOUDNESS_TOLERANCE_LU) {
      issues.push({
        code: 'DELIVERY_LOUDNESS_OFF_TARGET',
        severity: 'warning',
        message: `The delivered audio measures ${input.integratedLufs.toFixed(1)} LUFS against a`
          + ` ${DELIVERY_LOUDNESS_TARGET_I} LUFS target (${off > 0 ? 'louder' : 'quieter'} by`
          + ` ${Math.abs(off).toFixed(1)} LU). Run normalize_loudness on the final file.`,
      });
    }
  }
  if (input.expectsCaptions && spec.subtitleStreams === 0 && !input.sidecarSubtitleFound) {
    issues.push({
      code: 'DELIVERY_CAPTIONS_MISSING',
      severity: 'warning',
      message: 'Captions were asked for, and the delivered file has no subtitle stream and no sidecar subtitle file'
        + ' beside it. Burned-in captions cannot be detected from the container, so if they were burned in say so;'
        + ' otherwise the captions were not produced.',
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

/** Voiced span in file-relative seconds. Production reads FFmpeg ametadata:
 * an EOF silence stays open there, while stderr closes it during filter flush.
 * Legacy diagnostic event strings remain accepted. Closed interior pauses do
 * not shorten speech. */
export function parseVoicedSpan(stderr: string, durationSec: number): { startSec: number; endSec: number } {
  const starts = [...stderr.matchAll(/(?:silence_start:\s*|^lavfi\.silence_start=)(-?[\d.]+)/gm)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/(?:silence_end:\s*|^lavfi\.silence_end=)(-?[\d.]+)/gm)].map((m) => Number(m[1]));
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

// Probes read container metadata; decodes (loudness, silence detection) walk
// the whole delivered file. Both run through the shared bounded runner so a
// wedged ffmpeg cannot pin a `video.ship` call until turn abort, and
// tool output stays capped like every other spawn in this feature.
const DELIVERY_PROBE_TIMEOUT_MS = 60_000;
const DELIVERY_DECODE_TIMEOUT_MS = 10 * 60_000;

async function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs: number = DELIVERY_PROBE_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runVideoProcessForTest(cmd, args, { signal, timeoutMs });
  if (result.timedOut) {
    log.warn('delivery verification process timed out', { bin: path.basename(cmd), timeout_ms: timeoutMs });
  }
  return { code: result.timedOut || result.aborted ? -1 : result.code, stdout: result.stdout, stderr: result.stderr };
}

function streamDurationField(
  key: 'videoDurationSec' | 'audioDurationSec',
  stream: Record<string, unknown> | undefined,
): Partial<Pick<DeliveryVideoSpec, 'videoDurationSec' | 'audioDurationSec'>> {
  const seconds = Number(stream?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? { [key]: seconds } : {};
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
      format?: { duration?: string; tags?: { comment?: unknown } };
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    if (!video || !(Number(video.width) > 0) || !(Number(video.height) > 0)) return null;
    const rate = String(video?.r_frame_rate ?? '');
    const [num, den] = rate.split('/').map(Number);
    return {
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
      width: typeof video?.width === 'number' ? video.width : null,
      height: typeof video?.height === 'number' ? video.height : null,
      fps: Number.isFinite(num) && Number.isFinite(den) && den ? num / den : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
      subtitleStreams: streams.filter((s) => s.codec_type === 'subtitle').length,
      narrationMixExpected: typeof parsed.format?.tags?.comment === 'string'
        && parsed.format.tags.comment.split('\n').includes('ORKAS_NARRATION_MIX_V1'),
      ...streamDurationField('videoDurationSec', video),
      ...streamDurationField('audioDurationSec', streams.find((s) => s.codec_type === 'audio')),
    };
  } catch (err) {
    log.warn(`delivered probe parse failed: ${(err as Error).message}`);
    return null;
  }
}

export type DeliveredAudioMeasurement = {
  integratedLufs: number | null;
  digitalSilence: boolean | null;
  /** Stretches of at least DELIVERY_SILENT_STRETCH_SEC with no sound; null when not measured. */
  silences?: PhraseSpan[] | null;
};

/** A stretch this long with no sound, in a video that should have sound, is reported. */
export const DELIVERY_SILENT_STRETCH_SEC = 3;
/** Quieter than this is no sound to a viewer. */
const DELIVERY_SILENCE_FLOOR_DB = -50;

/** Overall astats covers all channels without downmixing (opposite-phase channels
 *  must not cancel). A missing stream, empty decode or incomplete summary is unknown,
 *  never silence. LUFS has a gate floor, so cannot prove zero samples. */
export function parseDeliveredAudioMeasurement(stderr: string, audioStreams: number): DeliveredAudioMeasurement {
  const summaries = new Map<string, { peak?: number; samples?: number }>();
  for (const match of stderr.matchAll(/^\[(Parsed_astats_\d+ @ [^\]]+)\]\s*(.*)$/gm)) {
    const [, id, line] = match;
    if (line === 'Overall') summaries.set(id, {});
    const summary = summaries.get(id);
    if (!summary) continue;
    if (line.startsWith('Peak level dB: ')) {
      const value = line.slice('Peak level dB: '.length).trim();
      summary.peak = value === '-inf' ? Number.NEGATIVE_INFINITY : Number(value);
    }
    if (line.startsWith('Number of samples: ')) summary.samples = Number(line.slice('Number of samples: '.length));
  }
  const complete = audioStreams > 0 && summaries.size === audioStreams && [...summaries.values()].every((summary) => (
    (Number.isFinite(summary.peak) || summary.peak === Number.NEGATIVE_INFINITY)
    && Number.isFinite(summary.samples) && summary.samples! > 0
  ));
  return {
    // Separate audio programs have no single integrated loudness. Do not report
    // whichever stream happened to print its summary last as the whole mix.
    integratedLufs: complete && audioStreams === 1 ? parseIntegratedLufs(stderr) : null,
    digitalSilence: complete ? [...summaries.values()].every((summary) => summary.peak === Number.NEGATIVE_INFINITY) : null,
  };
}

export async function measureDeliveredAudio(
  videoAbsPath: string,
  audioStreams: number,
  signal?: AbortSignal,
  durationSec?: number | null,
): Promise<DeliveredAudioMeasurement> {
  const { ffmpeg } = bundledFfmpegPaths();
  const unknown: DeliveredAudioMeasurement = { integratedLufs: null, digitalSilence: null };
  if (!ffmpeg) return unknown;
  // silencedetect rides on the same decode; with several streams its lines would mix.
  const silence = audioStreams === 1 ? `,silencedetect=noise=${DELIVERY_SILENCE_FLOOR_DB}dB:d=${DELIVERY_SILENT_STRETCH_SEC}` : '';
  const r = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-nostdin', '-xerror', '-i', videoAbsPath,
    '-map', '0:a', '-vn', '-sn', '-dn',
    '-af', `astats=measure_perchannel=none:measure_overall=Peak_level+Number_of_samples,ebur128=peak=true:framelog=verbose${silence}`,
    '-f', 'null', '-',
  ], signal, DELIVERY_DECODE_TIMEOUT_MS);
  // FFmpeg can print valid-looking summaries when interrupted or decoding fails.
  if (r.code !== 0) return unknown;
  return {
    ...parseDeliveredAudioMeasurement(r.stderr, audioStreams),
    silences: silence ? parseSilenceLog(r.stderr, durationSec ?? undefined) : null,
  };
}

/** A video that should have sound has none for a stretch: narration that ends early, a
 *  clip cut silent and left that way (2026-11-12: a recap went quiet for its last 33 s). */
export function assessSilentStretches(silences: PhraseSpan[] | null | undefined, expectsAudio: boolean): DeliveryIssue[] {
  if (!expectsAudio || !silences) return [];
  const long = silences.filter((s) => s.endSec - s.startSec >= DELIVERY_SILENT_STRETCH_SEC - 0.05);
  if (!long.length) return [];
  const listed = long.slice(0, 4).map((s) => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s (${(s.endSec - s.startSec).toFixed(1)}s)`).join(', ');
  return [{
    code: 'DELIVERY_SILENT_STRETCH',
    severity: 'warning',
    message: `This video should have sound but is silent at ${listed}${long.length > 4 ? ` and ${long.length - 4} more` : ''}.`
      + ' This is a low-level audio measurement; it does not establish missing narration or whether the silence is intended.',
  }];
}

/** Narration overlapping the clip's own speech by at least this much is reported. */
export const NARRATION_OVER_SPEECH_MIN_SEC = 0.5;

/** Where the clip's people speak: recognized words joined across gaps under 0.3 s. */
export function speechSpansFromWords(words: Array<{ startSec: number; endSec: number }>): PhraseSpan[] {
  const spans: PhraseSpan[] = [];
  for (const w of [...words].sort((a, b) => a.startSec - b.startSec)) {
    if (!(w.endSec > w.startSec)) continue;
    const last = spans[spans.length - 1];
    if (last && w.startSec - last.endSec < 0.3) last.endSec = Math.max(last.endSec, w.endSec);
    else spans.push({ startSec: w.startSec, endSec: w.endSec });
  }
  return spans;
}

/** Lines that speak while someone in the clip is speaking. Pure. */
export function assessNarrationOverSpeech(
  lines: Array<{ index: number; start: number; end: number }>,
  speech: PhraseSpan[],
): DeliveryIssue[] {
  const hits: string[] = [];
  for (const line of lines) {
    let overlap = 0;
    let from = Infinity;
    let to = -Infinity;
    for (const s of speech) {
      const a = Math.max(line.start, s.startSec);
      const b = Math.min(line.end, s.endSec);
      if (b <= a) continue;
      overlap += b - a;
      from = Math.min(from, a);
      to = Math.max(to, b);
    }
    if (overlap >= NARRATION_OVER_SPEECH_MIN_SEC) {
      hits.push(`line ${line.index} (${line.start.toFixed(1)}–${line.end.toFixed(1)}s) over speech at ${from.toFixed(1)}–${to.toFixed(1)}s`);
    }
  }
  if (!hits.length) return [];
  return [{
    code: 'DELIVERY_NARRATION_OVER_SPEECH',
    severity: 'warning',
    message: `Narration plays while someone in the clip is talking, so two voices speak at once: ${hits.slice(0, 4).join('; ')}${hits.length > 4 ? `; and ${hits.length - 4} more` : ''}.`
      + ' Move each line to where nobody speaks, shorten it, or cut that stretch of the clip silent, then mix again.',
  }];
}

/** Compare narration with speech in its original base. A carried mix marker
 *  requires matching evidence; unavailable evidence never proves no overlap.
 *  Unmarked external videos do not claim this check. */
export async function narrationOverSpeechIssues(
  deliveredAbs: string,
  productionDirAbs: string,
  signal?: AbortSignal,
  mixExpected?: boolean,
): Promise<DeliveryIssue[]> {
  const expected = mixExpected ?? (await probeDeliveredVideo(deliveredAbs, signal))?.narrationMixExpected ?? false;
  const unverified = (): DeliveryIssue[] => [{
    code: 'DELIVERY_NARRATION_UNVERIFIABLE', severity: 'warning',
    message: 'The narration-over-dialogue check could not be completed because its mix evidence is missing, stale or unreadable. Speech overlap has not been verified.',
  }];
  const recordAbs = path.join(path.dirname(deliveredAbs), `.${path.basename(deliveredAbs)}.narration.json`);
  let record: { kind?: unknown; version?: unknown; output?: { sha256?: unknown }; base?: { path?: unknown; sha256?: unknown }; lines?: unknown };
  try {
    record = JSON.parse(await fs.readFile(recordAbs, 'utf8'));
  } catch {
    return expected ? unverified() : [];
  }
  if (!record || typeof record !== 'object' || !/^[a-f0-9]{64}$/.test(String(record.output?.sha256))) return expected ? unverified() : [];
  const basePath = typeof record.base?.path === 'string' ? path.resolve(record.base.path) : '';
  if (record.kind !== 'orkas-mix-narration' || record.version !== 1 || !basePath || !Array.isArray(record.lines)) return expected ? unverified() : [];
  // A reused output name can retain an old sidecar. It describes only the
  // exact file the mix (or a verified timing-preserving pass) wrote.
  const outputSha = await sha256OfFileStream(deliveredAbs).catch(() => null);
  if (!outputSha || outputSha !== record.output?.sha256) return expected ? unverified() : [];
  if (!isPathAllowed(basePath, [productionDirAbs])) return unverified();
  const sha = await sha256OfFileStream(basePath).catch(() => null);
  if (!sha || sha !== record.base?.sha256) return unverified();
  if (!record.lines.every((l) => l && typeof l === 'object' && Number.isInteger(l.index) && l.index > 0
    && Number.isFinite(l.start) && l.start >= 0 && Number.isFinite(l.end) && l.end > l.start)) return unverified();
  const lines = (record.lines as Array<Record<string, number>>)
    .map((l) => ({ index: l.index, start: l.start, end: l.end }));
  if (!lines.length) return unverified();
  const heard = await transcribeSpeech({ inputAbsPath: basePath, timestamps: 'word', ...(signal ? { signal } : {}) }).catch(() => null);
  if (heard?.ok === false && heard.timing_valid === false) return [{
    code: 'DELIVERY_NARRATION_UNVERIFIABLE', severity: 'warning',
    message: 'The speech-overlap check could not be completed because the recording transcript has invalid timestamps.',
  }];
  if (!heard || heard.ok !== true) return unverified();
  const words = (heard.summary as { words?: Array<{ startSec: number; endSec: number }> })?.words;
  if (!Array.isArray(words)) return unverified();
  return assessNarrationOverSpeech(lines, speechSpansFromWords(words));
}

// The music-cut beat check's own numbers (stage-edit `analyze_media --op beats`), so the
// delivery and the Agent's own check count the same cuts.
const BEAT_CHECK_RATE = 22050;
const BEAT_CUT_SCENE_THRESHOLD = 0.4;
export const BEAT_CUT_TOLERANCE_FRAMES = 1;
/** Seconds of the delivered file the beat check reads. */
const BEAT_CHECK_MAX_SEC = 600;
const BEAT_CUTS_NAMED = 4;

/** Cuts more than a frame from their nearest beat, counted as the music-cut beat check
 *  counts them. Pure. */
export function assessCutsOffBeat(cuts: readonly number[], beats: readonly number[], fps: number): DeliveryIssue[] {
  if (!cuts.length || !beats.length || !(fps > 0)) return [];
  const off = cuts.map((t) => {
    let beat = beats[0];
    for (const b of beats) if (Math.abs(b - t) < Math.abs(beat - t)) beat = b;
    const offsetSec = Math.round((t - beat) * 1000) / 1000;
    return { t, beat, frames: Math.round(offsetSec * fps) };
  }).filter((cut) => Math.abs(cut.frames) > BEAT_CUT_TOLERANCE_FRAMES);
  if (!off.length) return [];
  const named = off.slice(0, BEAT_CUTS_NAMED).map((cut) => `${cut.t.toFixed(2)}s (beat ${cut.beat.toFixed(2)}s)`).join(', ');
  return [{
    code: 'DELIVERY_CUTS_OFF_BEAT',
    severity: 'warning',
    message: `${off.length} of ${cuts.length} cuts are more than a frame off the beat: ${named}${off.length > BEAT_CUTS_NAMED ? `, and ${off.length - BEAT_CUTS_NAMED} more` : ''}.`
      + " Take each cut's frame from the beat list rather than adding up a beat length, then render and deliver again.",
  }];
}

/** Where the cuts of a video cut to its music land against the beat of its own sound,
 *  read from the delivered file. No steady beat, or a pass that fails: nothing to report. */
export async function cutsOffBeatIssues(videoAbs: string, fps: number | null, signal?: AbortSignal): Promise<DeliveryIssue[]> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg || !fps || !(fps > 0)) return [];
  const pcmAbs = path.join(os.tmpdir(), `orkas-beat-check-${randomUUID()}.f32`);
  let samples: Float32Array;
  try {
    const decoded = await run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-t', String(BEAT_CHECK_MAX_SEC), '-i', videoAbs,
      '-vn', '-ac', '1', '-ar', String(BEAT_CHECK_RATE), '-f', 'f32le', pcmAbs], signal, DELIVERY_DECODE_TIMEOUT_MS);
    if (decoded.code !== 0) {
      log.warn('beat check decode failed', { code: decoded.code });
      return [];
    }
    const bytes = await fs.readFile(pcmAbs);
    samples = new Float32Array(Math.floor(bytes.length / 4));
    for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readFloatLE(i * 4);
  } catch (err) {
    log.warn('beat check decode unreadable', { error: (err as Error).name });
    return [];
  } finally {
    await fs.rm(pcmAbs, { force: true }).catch(() => undefined);
  }
  // Short slices, so the main process keeps answering while the tracker runs.
  const steps = rhythmSteps({ sampleRate: BEAT_CHECK_RATE, channels: [samples] });
  let sliceStart = Date.now();
  let next = steps.next();
  while (!next.done) {
    if (Date.now() - sliceStart >= 10) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return [];
      sliceStart = Date.now();
    }
    next = steps.next();
  }
  const beats = next.value.beats.times;
  if (!beats.length) return [];
  const scenes = await run(ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'error', '-t', String(BEAT_CHECK_MAX_SEC), '-i', videoAbs,
    '-an', '-vf', `select='gt(scene,${BEAT_CUT_SCENE_THRESHOLD})',metadata=print:file=-`, '-f', 'null', '-'], signal, DELIVERY_DECODE_TIMEOUT_MS);
  if (scenes.code !== 0) {
    log.warn('beat check cut pass failed', { code: scenes.code });
    return [];
  }
  const cuts: number[] = [];
  let pts = Number.NaN;
  for (const line of scenes.stdout.split('\n')) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) { pts = Number(time[1]); continue; }
    if (/scene_score=([0-9.]+)/.test(line) && Number.isFinite(pts) && pts > 0) {
      cuts.push(Math.round(pts * 1000) / 1000);
      pts = Number.NaN;
    }
  }
  return assessCutsOffBeat(cuts, beats, fps);
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
  if (probe.code !== 0 || !Number.isFinite(durationSec) || !(durationSec > 0)) return null;
  const detect = await run(ffmpeg, [
    '-v', 'error', '-nostdin', '-xerror', '-i', audioAbsPath,
    '-af', 'silencedetect=noise=-45dB:d=0.15,ametadata=mode=print:file=-', '-f', 'null', '-',
  ], signal, DELIVERY_DECODE_TIMEOUT_MS);
  if (detect.code !== 0) return null;
  const span = parseVoicedSpan(detect.stdout, durationSec);
  return { ...span, durationSec };
}
