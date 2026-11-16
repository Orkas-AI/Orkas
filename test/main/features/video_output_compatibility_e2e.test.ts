import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveCompatibleVideo, videoOutputConversion } from '../../../src/main/features/video_output_compatibility';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(blueEnding = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-compatibility-')); roots.push(root);
  const source = path.join(root, 'native.mp4');
  const { ffmpeg } = bundledFfmpegPaths();
  const result = spawnSync(ffmpeg!, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    ...(blueEnding ? ['-vf', "drawbox=color=blue:t=fill:enable='gte(t,2)'"] : []),
    '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { encoding: 'utf8', timeout: 30_000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  return { root, buffer: await fs.readFile(source) };
}

function probe(file: string) {
  const result = spawnSync(bundledFfmpegPaths().ffprobe!, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', timeout: 30_000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe('finish model footage without changing code-rendered video settings', () => {
  it('delivers two seconds, portrait 720p and no audio from a four-second native H3 clip', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'finished.mp4');
    const result = await saveCompatibleVideo(buffer, file,
      { duration: 2, resolution: '720p', ratio: '9:16', generateAudio: false },
      { duration: 4, resolution: '768p', ratio: '16:9', generateAudio: true });
    const actual = probe(file), video = actual.streams.find(s => s.codec_type === 'video');
    expect(Number(actual.format.duration)).toBeCloseTo(2, 1);
    expect([video.width, video.height]).toEqual([720, 1280]);
    expect(actual.streams.some(s => s.codec_type === 'audio')).toBe(false);
    expect(result).toMatchObject({ changed: true, duration: 2, resolution: '720p', ratio: '9:16' });
    expect(result.bytes).toBe((await fs.stat(file)).size);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.video-fit'))).toEqual([]);
  });

  it('preserves source bytes and their audio when native settings already satisfy the request', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'unchanged.mp4');
    expect(await saveCompatibleVideo(buffer, file, { duration: 4, generateAudio: true }, { duration: 4, generateAudio: true }))
      .toMatchObject({ changed: false, bytes: buffer.length });
    expect(await fs.readFile(file)).toEqual(buffer);
    expect(probe(file).streams.some(s => s.codec_type === 'audio')).toBe(true);
  });

  it('measures automatically timed footage before preserving its ending in a shorter delivery', async () => {
    const { root, buffer } = await fixture(true), file = path.join(root, 'automatic.mp4');
    await saveCompatibleVideo(buffer, file, { duration: 2, lastFramePath: 'ending.png' }, { duration: -1 });
    expect(Number(probe(file).format.duration)).toBeCloseTo(2, 1);
    const decoded = spawnSync(bundledFfmpegPaths().ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-ss', '1.8', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30_000 });
    expect(decoded.status).toBe(0); expect(decoded.stderr.length).toBe(0);
    expect(decoded.stdout[2]).toBeGreaterThan(200);
  });

  it('reports actual duration rather than claiming an automatically timed clip is longer', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'short-source.mp4');
    expect(await saveCompatibleVideo(buffer, file, { duration: 6 }, { duration: -1 }))
      .toMatchObject({ changed: false, duration: 4 });
    expect(await fs.readFile(file)).toEqual(buffer);
  });

  it('retains an existing result and removes temporary files when conversion fails', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'existing.mp4');
    await fs.writeFile(file, buffer);
    await expect(saveCompatibleVideo(Buffer.from('invalid video'), file, { duration: 2 }, { duration: 4 })).rejects.toThrow(/converted/);
    expect(await fs.readFile(file)).toEqual(buffer);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.video-fit'))).toEqual([]);
  });

  it('does not overwrite a result another delivery reserved during conversion', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'reserved.mp4');
    await fs.writeFile(file, buffer);
    await expect(saveCompatibleVideo(buffer, file, { duration: 2 }, { duration: 4 }, undefined, true))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(file)).toEqual(buffer);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.video-fit'))).toEqual([]);
  });

  it('keeps a requested ending frame when shortening a minimum-duration generation', async () => {
    const { root, buffer } = await fixture(true), file = path.join(root, 'ending.mp4');
    await saveCompatibleVideo(buffer, file, { duration: 2, lastFramePath: 'ending.png' }, { duration: 4 });
    const actual = probe(file);
    expect(Number(actual.format.duration)).toBeCloseTo(2, 1);
    const decoded = spawnSync(bundledFfmpegPaths().ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-ss', '1.8', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30_000 });
    expect(decoded.status).toBe(0); expect(decoded.stderr.length).toBe(0);
    expect(decoded.stdout[2]).toBeGreaterThan(200);
    expect(decoded.stdout[0]).toBeLessThan(30);
  });

  it('leaves an existing result intact when cancellation prevents local conversion', async () => {
    const { root, buffer } = await fixture(), file = path.join(root, 'existing.mp4');
    await fs.writeFile(file, buffer);
    const controller = new AbortController(); controller.abort();
    await expect(saveCompatibleVideo(buffer, file, { duration: 2 }, { duration: 4 }, controller.signal)).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(buffer);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.video-fit'))).toEqual([]);
  });

  it('does not extend short actual footage or impose an API minimum on code rendering', () => {
    expect(videoOutputConversion({ duration: 2 }, { duration: 2 })).toEqual({ filters: [], audioFilters: [], mute: false });
    expect(videoOutputConversion({ duration: 30 }, { duration: 15 })).toEqual({ filters: [], audioFilters: [], mute: false });
  });
});
