/**
 * A montage cut against a 128 BPM click track, the way a model might cut one by hand:
 * solid colour shots joined at chosen times, with the track underneath. The beat is a
 * decaying click every 60/128 s, so the tracker finds it and the true beat times are known.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bundledFfmpegPaths } from '../../src/main/util/bundled-runtime';

export const BEAT_SEC = 60 / 128;
const FPS = 30;
/** Bright and dark in turn, so every join reads as a cut. */
const COLOURS = ['0xf0e0c0', '0x202040', '0xe0f0a0', '0x402020', '0xa0e0f0', '0x204020'];

function ffmpeg(args: string[]): void {
  const { ffmpeg: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** Cut times on the beat: every second beat, as frames taken from the beat list. */
export function onBeatCuts(seconds: number): number[] {
  const cuts: number[] = [];
  for (let beat = 2; beat * BEAT_SEC < seconds - 0.5; beat += 2) cuts.push(Math.round(beat * BEAT_SEC * FPS) / FPS);
  return cuts;
}

/** Cut times from adding up a rounded two-beat length (28 frames, 0.933 s), which drifts. */
export function driftingCuts(seconds: number): number[] {
  const cuts: number[] = [];
  for (let at = 28 / FPS; at < seconds - 0.5; at += 28 / FPS) cuts.push(Math.round(at * FPS) / FPS);
  return cuts;
}

/** Writes the montage to `file`: shots between `cuts`, over the click track or a plain tone. */
export function makeBeatMontage(file: string, seconds: number, cuts: number[], sound: 'clicks' | 'tone' = 'clicks'): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-beat-montage-'));
  try {
    const bounds = [0, ...cuts, seconds];
    const list: string[] = [];
    bounds.slice(1).forEach((end, index) => {
      const frames = Math.round(end * FPS) - Math.round(bounds[index] * FPS);
      const shot = path.join(dir, `shot-${index}.mp4`);
      ffmpeg(['-f', 'lavfi', '-i', `color=c=${COLOURS[index % COLOURS.length]}:s=360x640:r=${FPS}`, '-frames:v', String(frames),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', shot]);
      list.push(`file '${shot}'`);
    });
    fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
    const audio = sound === 'clicks'
      ? `aevalsrc='0.8*sin(2*PI*1000*t)*exp(-60*mod(t\\,${BEAT_SEC}))':s=22050:d=${seconds}`
      : `sine=frequency=330:sample_rate=22050:duration=${seconds}`;
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-f', 'lavfi', '-i', audio,
      '-c:v', 'copy', '-c:a', 'aac', '-shortest', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
