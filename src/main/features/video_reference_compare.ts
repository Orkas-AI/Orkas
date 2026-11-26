/**
 * A video made from a reference, set beside that reference at delivery.
 *
 * Remakes kept coming out stiller than what they copied: on 2026-11-14 the remake
 * case passed 0 of 2 (63.3), and on 2026-11-16 one run left out a whole part and the end
 * card. Nothing in delivery looked at the reference again, so the model judged its own
 * cut from memory. Two things change that, both read from the files themselves:
 *
 * - how much each quarter of the delivered file moves against the same quarter of the
 *   reference (median luma change between frames, sampled small), so a still picture
 *   standing in for moving footage is named with where it is;
 * - a sheet putting the reference and the delivery side by side at those quarters.
 *
 * Neither grades fidelity. Rows the reference itself barely moves in are not compared,
 * and a finding needs half or more of the compared rows to fall below half the
 * reference's movement, so one held shot or a changed order does not set it off.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { composeAbortSignal } from '../util/abort';
import { fileSnapshotSignature } from '../util/file-snapshot';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { referenceVideoInput, runVideoProcessForTest } from './video_studio';
import { probeDeliveredVideo } from './video_studio_delivery';
import { writeFrameContactSheet } from './video_studio_qa';

const log = createLogger('video-reference-compare');

/** Rows of the comparison: the middle of each quarter of each video. */
export const REFERENCE_COMPARE_ROWS = 4;
/** Sampled this small and this often, a minute of video decodes in about a second. */
const MOTION_SAMPLE_FPS = 8;
const MOTION_SAMPLE_WIDTH = 160;
/** Longer videos are measured over this much from the start. */
const MOTION_MAX_SEC = 300;
const MOTION_TIMEOUT_MS = 90 * 1000;
/** Shorter than this, a quarter has too few samples to say how much it moves. */
export const REFERENCE_COMPARE_MIN_SEC = 2;
/** Median luma change (0-255, 160 px wide, 8 fps) a reference quarter needs before it is
 *  compared. Measured 2026-11-19: moving footage 3-9, a moving viral-style edit 5.9-9.0,
 *  its static end card 0.0, interface animation 0.04-0.6. */
export const REFERENCE_MOTION_FLOOR = 1;
/** Below this share of the reference's movement, a row counts as much stiller. */
export const REFERENCE_MOTION_WEAK_RATIO = 0.5;
const FRAME_TIMEOUT_MS = 30 * 1000;
const SHEET_CELL = 360;
const REFERENCE_IDENTITY_MAX_BYTES = 512 * 1024 * 1024;
const REFERENCE_IDENTITY_TIMEOUT_MS = 5_000;

export type ReferenceMoment = { row: number; referenceSec: number; videoSec: number; share: number };

/** The same point of each video, as a share of its length: the middle of each quarter. */
export function referenceMoments(referenceSec: number, videoSec: number): ReferenceMoment[] {
  const span = (sec: number) => Math.min(sec, MOTION_MAX_SEC);
  return Array.from({ length: REFERENCE_COMPARE_ROWS }, (_, index) => {
    const share = (index + 0.5) / REFERENCE_COMPARE_ROWS;
    return {
      row: index + 1,
      share,
      referenceSec: round2(span(referenceSec) * share),
      videoSec: round2(span(videoSec) * share),
    };
  });
}

/** Median frame-to-frame luma change in each quarter, or null for a quarter with too few
 *  samples. Null when the file cannot be read. */
async function measureMotionByQuarter(
  ffmpeg: string,
  mediaInput: readonly string[],
  durationSec: number,
  signal?: AbortSignal,
): Promise<Array<number | null> | null> {
  if (!(durationSec >= REFERENCE_COMPARE_MIN_SEC)) return null;
  const span = Math.min(durationSec, MOTION_MAX_SEC);
  const run = await runVideoProcessForTest(ffmpeg, [
    '-hide_banner', '-nostats', '-t', span.toFixed(3), ...mediaInput,
    '-map', '0:v:0',
    '-vf', `fps=${MOTION_SAMPLE_FPS},scale=${MOTION_SAMPLE_WIDTH}:-2:flags=area,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { timeoutMs: MOTION_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (run.code !== 0) {
    log.warn('motion pass failed', { code: run.code, timedOut: run.timedOut });
    return null;
  }
  return quarterMedians(parseMotionSamples(run.stderr), span);
}

/** `pts_time` and the YAVG that follows it, from ffmpeg's metadata print. */
export function parseMotionSamples(stderr: string): Array<{ atSec: number; change: number }> {
  const samples: Array<{ atSec: number; change: number }> = [];
  let at: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) at = Number(time[1]);
    const value = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (value && at !== null && Number.isFinite(at)) {
      samples.push({ atSec: at, change: Number(value[1]) });
      at = null;
    }
  }
  return samples;
}

export function quarterMedians(samples: ReadonlyArray<{ atSec: number; change: number }>, spanSec: number): Array<number | null> {
  return Array.from({ length: REFERENCE_COMPARE_ROWS }, (_, index) => {
    const from = spanSec * index / REFERENCE_COMPARE_ROWS;
    const to = spanSec * (index + 1) / REFERENCE_COMPARE_ROWS;
    const values = samples
      .filter((sample) => sample.atSec >= from && (sample.atSec < to || index === REFERENCE_COMPARE_ROWS - 1))
      .map((sample) => sample.change)
      .sort((a, b) => a - b);
    if (values.length < 2) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  });
}

export type MotionRow = {
  row: number;
  reference: number | null;
  video: number | null;
  /** Share of the reference's movement, when the reference moves enough there to compare. */
  ratio: number | null;
};

export type MotionAssessment = {
  rows: MotionRow[];
  /** Rows compared and found much stiller than the reference. */
  weakRows: number[];
  /** Mean share of the reference's movement over the compared rows, capped at 1 each. */
  score: number | null;
  stiller: boolean;
};

export function assessMotionAgainstReference(
  reference: ReadonlyArray<number | null>,
  video: ReadonlyArray<number | null>,
): MotionAssessment {
  const rows: MotionRow[] = Array.from({ length: REFERENCE_COMPARE_ROWS }, (_, index) => {
    const ref = reference[index] ?? null;
    const own = video[index] ?? null;
    const compared = ref !== null && own !== null && ref >= REFERENCE_MOTION_FLOOR;
    return { row: index + 1, reference: ref, video: own, ratio: compared ? own / ref : null };
  });
  const compared = rows.filter((row) => row.ratio !== null);
  const weakRows = compared.filter((row) => (row.ratio as number) < REFERENCE_MOTION_WEAK_RATIO).map((row) => row.row);
  const score = compared.length
    ? compared.reduce((sum, row) => sum + Math.min(1, row.ratio as number), 0) / compared.length
    : null;
  return { rows, weakRows, score, stiller: compared.length > 0 && weakRows.length >= Math.ceil(compared.length / 2) };
}

export const REFERENCE_MOTION_CODE = 'DELIVERY_MOTION_BELOW_REFERENCE';

/** The finding for a delivery much stiller than its reference, naming the rows. */
export function referenceMotionIssue(
  assessment: MotionAssessment,
  moments: readonly ReferenceMoment[],
): { code: string; severity: 'warning'; message: string } | null {
  if (!assessment.stiller) return null;
  const parts = assessment.weakRows.map((row) => {
    const moment = moments.find((entry) => entry.row === row);
    const ratio = assessment.rows.find((entry) => entry.row === row)?.ratio ?? 0;
    return `row ${row} (${Math.round((moment?.share ?? 0) * 100)}% through: ${Math.round(ratio * 100)}% of the reference's movement)`;
  });
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return {
    code: REFERENCE_MOTION_CODE,
    severity: 'warning',
    message: `Beside the reference at the same point of each, this video moves much less in ${listed} of the reference comparison.`
      + ' Make those parts move the way the reference does there, with footage, a camera move or animation instead of a held picture, then render.',
  };
}

/** What delivery reports about the comparison, for the Agent and for the sheet. */
export type ReferenceComparison = {
  rows: Array<{
    row: number;
    reference_at_sec: number;
    video_at_sec: number;
    /** Share of the reference's movement there; absent where the reference barely moves. */
    motion_vs_reference?: number;
  }>;
  motion_score: number | null;
};

export function referenceComparisonReport(moments: readonly ReferenceMoment[], assessment: MotionAssessment | null): ReferenceComparison {
  return {
    rows: moments.map((moment) => {
      const ratio = assessment?.rows.find((row) => row.row === moment.row)?.ratio;
      return {
        row: moment.row,
        reference_at_sec: moment.referenceSec,
        video_at_sec: moment.videoSec,
        ...(typeof ratio === 'number' ? { motion_vs_reference: round2(ratio) } : {}),
      };
    }),
    motion_score: assessment?.score === null || assessment?.score === undefined ? null : round2(assessment.score),
  };
}

/** Both videos measured quarter by quarter. Null when either cannot be read or is too short
 *  to compare, which says nothing about how the delivery moves. */
export async function compareWithReference(input: {
  ffmpeg: string;
  referenceAbs: string;
  videoAbs: string;
  videoSec: number | null;
  signal?: AbortSignal;
}): Promise<{ report: ReferenceComparison; issue: ReturnType<typeof referenceMotionIssue> } | null> {
  try {
    const referenceInput = referenceVideoInput(input.referenceAbs);
    if (!referenceInput) return null;
    const referenceSec = (await probeDeliveredVideo(input.referenceAbs, input.signal, { referenceContainer: true }))?.durationSec ?? null;
    if (!referenceSec || !input.videoSec || referenceSec < REFERENCE_COMPARE_MIN_SEC || input.videoSec < REFERENCE_COMPARE_MIN_SEC) return null;
    const moments = referenceMoments(referenceSec, input.videoSec);
    const [reference, own] = await Promise.all([
      measureMotionByQuarter(input.ffmpeg, referenceInput, referenceSec, input.signal),
      measureMotionByQuarter(input.ffmpeg, localDeliveryInput(input.videoAbs), input.videoSec, input.signal),
    ]);
    const assessment = reference && own ? assessMotionAgainstReference(reference, own) : null;
    return {
      report: referenceComparisonReport(moments, assessment),
      issue: assessment ? referenceMotionIssue(assessment, moments) : null,
    };
  } catch (err) {
    log.warn('reference comparison failed', { error: logErrorSummary(err) });
    return null;
  }
}

/**
 * The reference a production follows: the one this run inspected last when it is a
 * file still in place, else the single source frozen anywhere under the production.
 * Two different sources under the production and none inspected this run is not
 * guessed between.
 */
export async function findFollowedReference(input: {
  productionDirAbs: string;
  allowedRoots: string[];
  /** Sources inspected in this run, oldest first. */
  inspectedThisRun?: readonly string[];
  signal?: AbortSignal;
}): Promise<string | null> {
  if (input.signal?.aborted) return null;
  for (const candidate of [...(input.inspectedThisRun ?? [])].reverse()) {
    if (isPathAllowed(candidate, input.allowedRoots) && await isFile(candidate)) return candidate;
  }
  const frozen = await frozenReferenceSources(input.productionDirAbs);
  const candidates: Array<{ file: string; size: number; stamp: string }> = [];
  let bytes = 0;
  for (const file of frozen) {
    if (!isPathAllowed(file, input.allowedRoots)) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    if (candidates.length && candidates[0].size !== stat.size) return null;
    bytes += stat.size;
    candidates.push({ file, size: stat.size, stamp: fileSnapshotSignature(stat) });
  }
  if (input.signal?.aborted) return null;
  if (candidates.length <= 1) return candidates[0]?.file ?? null;
  if (!bytes || bytes > REFERENCE_IDENTITY_MAX_BYTES) return null;

  // Read only when identical sizes leave multiple possible sources. A timed
  // out, changed or unreadable copy is insufficient to choose a reference.
  const budget = composeAbortSignal(input.signal, REFERENCE_IDENTITY_TIMEOUT_MS, 'Reference identity check timed out');
  let expected: string | undefined;
  try {
    for (const { file, size, stamp } of candidates) {
      const digest = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(file, { end: size - 1, signal: budget.signal })) {
        digest.update(chunk);
        read += chunk.length;
      }
      if (read !== size || fileSnapshotSignature(await fs.stat(file)) !== stamp) return null;
      const identity = digest.digest('hex');
      if (expected !== undefined && identity !== expected) return null;
      expected = identity;
    }
    return budget.signal.aborted ? null : candidates.at(-1)!.file;
  } catch {
    return null;
  } finally {
    budget.cleanup();
  }
}

/** `<production>/videos/<id>/assets/references/inspect-*`/source.* and the same under the
 *  production itself, where reference.inspect freezes what it reads. */
async function frozenReferenceSources(productionDirAbs: string): Promise<string[]> {
  const bases = [path.join(productionDirAbs, 'assets', 'references')];
  const videos = await fs.readdir(path.join(productionDirAbs, 'videos'), { withFileTypes: true }).catch(() => []);
  for (const entry of videos) {
    if (entry.isDirectory()) bases.push(path.join(productionDirAbs, 'videos', entry.name, 'assets', 'references'));
  }
  const found: string[] = [];
  for (const base of bases) {
    const inspections = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const inspection of inspections) {
      if (!inspection.isDirectory() || !inspection.name.startsWith('inspect-')) continue;
      const files = await fs.readdir(path.join(base, inspection.name)).catch(() => [] as string[]);
      const source = files.find((name) => /^source\.[A-Za-z0-9]+$/.test(name));
      if (source) found.push(path.join(base, inspection.name, source));
    }
  }
  return found;
}

/** Reference left, delivery right, one row per moment. Null when no row could be drawn. */
export async function writeReferenceComparisonSheet(input: {
  ffmpeg: string;
  referenceAbs: string;
  videoAbs: string;
  moments: readonly ReferenceMoment[];
  outputDirAbs: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const referenceInput = referenceVideoInput(input.referenceAbs);
  if (!referenceInput) return null;
  const videoInput = localDeliveryInput(input.videoAbs);
  const cells: Array<{ label: string; time_seconds: number; path: string }> = [];
  for (const moment of input.moments) {
    const reference = await frameAt(input.ffmpeg, referenceInput, moment.referenceSec, path.join(input.outputDirAbs, `${moment.row}-reference.png`), input.signal);
    const own = await frameAt(input.ffmpeg, videoInput, moment.videoSec, path.join(input.outputDirAbs, `${moment.row}-video.png`), input.signal);
    // A row is drawn only whole: half a pair would compare a frame with nothing.
    if (!reference || !own) continue;
    cells.push({ label: `${moment.row} · reference ${moment.referenceSec.toFixed(1)}s`, time_seconds: moment.referenceSec, path: reference });
    cells.push({ label: `${moment.row} · this video ${moment.videoSec.toFixed(1)}s`, time_seconds: moment.videoSec, path: own });
  }
  if (!cells.length) return null;
  try {
    return await writeFrameContactSheet(input.outputDirAbs, cells, { labelOnly: true, columns: 2, thumbWidth: SHEET_CELL, thumbHeight: SHEET_CELL });
  } catch (err) {
    log.warn('reference comparison sheet not written', { error: logErrorSummary(err) });
    return null;
  }
}

function localDeliveryInput(file: string): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-i', file];
}

async function frameAt(ffmpeg: string, mediaInput: readonly string[], atSec: number, outAbs: string, signal?: AbortSignal): Promise<string | null> {
  const run = await runVideoProcessForTest(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Math.max(0, atSec).toFixed(3), ...mediaInput,
    '-frames:v', '1', '-vf', `scale=${SHEET_CELL}:${SHEET_CELL}:force_original_aspect_ratio=decrease`, outAbs,
  ], { timeoutMs: FRAME_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  return run.code === 0 && await isPng(outAbs) ? outAbs : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function isPng(fileAbs: string): Promise<boolean> {
  const handle = await fs.open(fileAbs, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(PNG_SIGNATURE);
  } finally {
    await handle.close();
  }
}

async function isFile(fileAbs: string): Promise<boolean> {
  return fs.stat(fileAbs).then((stat) => stat.isFile(), () => false);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
