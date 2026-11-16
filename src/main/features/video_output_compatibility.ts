/** Finish generated footage locally; code-rendered videos never enter this path. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfAborted } from '../util/abort';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { VIDEO_RESOLUTION_HEIGHTS, type VideoParameterInput } from './video_parameter_compatibility';

const OUTPUT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

export function videoOutputConversion(wanted: VideoParameterInput, native: VideoParameterInput): {
  filters: string[]; audioFilters: string[]; duration?: number; mute: boolean; ratio?: string; resolution?: string;
} {
  const duration = typeof wanted.duration === 'number' && Number.isFinite(wanted.duration)
    && wanted.duration > 0 && (native.duration === undefined || native.duration === -1 || wanted.duration < native.duration)
    ? wanted.duration : undefined;
  const mute = wanted.generateAudio === false && native.generateAudio !== false;
  const resize = !!wanted.resolution && !!VIDEO_RESOLUTION_HEIGHTS[wanted.resolution.toLowerCase()]
    && wanted.resolution.toLowerCase() !== native.resolution;
  const reshape = !!wanted.ratio && OUTPUT_RATIOS.includes(wanted.ratio) && wanted.ratio !== native.ratio;
  const filters: string[] = [];
  const audioFilters: string[] = [];
  if (duration && native.duration && native.duration > duration && (wanted.lastFrameUrl || wanted.lastFramePath)) {
    // A tail frame is an explicit visual requirement. Preserve both ends rather
    // than trimming the requested ending out of a minimum-duration generation.
    filters.push(`setpts=${duration / native.duration}*(PTS-STARTPTS)`);
    if (!mute) {
      let speed = native.duration / Math.max(duration, 1 / 60);
      for (let part = 0; part < 16 && speed > 2; part++, speed /= 2) audioFilters.push('atempo=2');
      audioFilters.push(`atempo=${speed}`);
    }
  }
  if (resize || reshape) {
    const ratio = OUTPUT_RATIOS.includes(wanted.ratio || '') ? wanted.ratio!
      : OUTPUT_RATIOS.includes(native.ratio || '') ? native.ratio! : undefined;
    const short = VIDEO_RESOLUTION_HEIGHTS[(wanted.resolution || native.resolution || '').toLowerCase()];
    if (ratio && short) {
      const [x, y] = ratio.split(':').map(Number);
      const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
      const width = even(x >= y ? short * x / y : short);
      const height = even(x >= y ? short : short * y / x);
      // Fit and pad rather than crop: product details and reference compositions survive.
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1');
    } else if (short) {
      // Adaptive input keeps its measured shape; resize only its shorter side.
      filters.push(`scale=w='if(gte(iw,ih),-2,${short})':h='if(gte(iw,ih),${short},-2)'`, 'setsar=1');
    }
  }
  return { filters, audioFilters, mute, ...(duration ? { duration } : {}),
    ...(reshape ? { ratio: wanted.ratio } : {}), ...(resize ? { resolution: wanted.resolution!.toLowerCase() } : {}) };
}

export async function saveCompatibleVideo(
  buffer: Buffer, output: string, wanted: VideoParameterInput, native: VideoParameterInput,
  signal?: AbortSignal, exclusive = false,
): Promise<{ bytes: number; changed: boolean; duration?: number; resolution?: string; ratio?: string }> {
  throwIfAborted(signal);
  let plan = videoOutputConversion(wanted, native);
  const measureDuration = !!wanted.duration && wanted.duration > 0
    && (native.duration === undefined || native.duration === -1);
  if (!measureDuration && !plan.duration && !plan.mute && !plan.filters.length) {
    await fs.writeFile(output, buffer, exclusive ? { flag: 'wx' } : undefined);
    return { bytes: buffer.length, changed: false };
  }
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (!ffmpeg) throw new Error('The video was generated, but its local format conversion is unavailable.');
  const { runVideoProcessForTest, probeMedia } = await import('./video_studio');
  const stem = path.join(path.dirname(output), `.video-fit-${randomUUID()}`);
  const source = stem + '.source.mp4', converted = stem + '.mp4';
  try {
    await fs.writeFile(source, buffer, { flag: 'wx' });
    throwIfAborted(signal);
    let measuredDuration: number | undefined;
    if (measureDuration) {
      const measured = ffprobe ? await probeMedia(ffprobe, source, signal) : null;
      throwIfAborted(signal);
      measuredDuration = measured?.video?.duration_seconds || measured?.duration_seconds || undefined;
      if (!measuredDuration) throw new Error('The generated video duration could not be verified locally.');
      plan = videoOutputConversion(wanted, { ...native, duration: measuredDuration });
      if (!plan.duration && !plan.mute && !plan.filters.length) {
        await fs.writeFile(output, buffer, exclusive ? { flag: 'wx' } : undefined);
        return { bytes: buffer.length, changed: false, duration: measuredDuration };
      }
    }
    const result = await runVideoProcessForTest(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2', '-i', source,
      ...(plan.duration ? ['-t', String(plan.duration)] : []),
      '-map', '0:v:0', ...(plan.mute ? ['-an'] : ['-map', '0:a?']),
      ...(plan.filters.length ? ['-vf', plan.filters.join(',')] : []),
      // Re-encode a trimmed clip to get a frame-accurate end, rather than a GOP boundary.
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      ...(plan.mute ? [] : plan.audioFilters.length ? ['-af', plan.audioFilters.join(','), '-c:a', 'aac'] : ['-c:a', 'copy']), '-movflags', '+faststart', converted,
    ], { signal, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
    throwIfAborted(signal);
    if (result.code !== 0 || result.timedOut || result.aborted) throw new Error('The generated video could not be converted locally.');
    const bytes = (await fs.stat(converted)).size;
    if (!bytes) throw new Error('Local video conversion produced no output.');
    // link is atomic and cannot overwrite a result reserved by another writer.
    if (exclusive) await fs.link(converted, output);
    else await fs.rename(converted, output);
    const duration = plan.duration ?? measuredDuration;
    return { bytes, changed: true, ...(duration ? { duration } : {}),
      ...(plan.ratio ? { ratio: plan.ratio } : {}), ...(plan.resolution ? { resolution: plan.resolution } : {}) };
  } finally {
    await Promise.all([fs.rm(source, { force: true }), fs.rm(converted, { force: true })]);
  }
}
