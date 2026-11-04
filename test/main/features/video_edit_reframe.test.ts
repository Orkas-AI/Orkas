import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildReframeFilter,
  editVideo,
  reframeCanvas,
  reframePadColor,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

// `reframe` exists because edit_video had no way to change aspect ratio while
// the agent card promised vertical formats: on 2026-10-26 a plain "make this
// 9:16" request was refused in four of six live runs and the user was sent to
// another editor. The runs that did hand-write ffmpeg picked 1152x2048 and
// 1440x2560 for the same request, so the canvas is pinned here too.

const tmpRoots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-reframe-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reframeCanvas', () => {
  it.each([
    ['9:16', 1080, 1920],
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
    ['4:5', 1080, 1350],
    ['3:4', 1080, 1440],
    ['4:3', 1440, 1080],
    ['9x16', 1080, 1920],
    ['18:32', 1080, 1920],
  ])('puts %s on its platform-standard canvas', (aspect, width, height) => {
    expect(reframeCanvas({ aspect })).toEqual({ ok: true, width, height });
  });

  it('keeps a 1920 long side with even sides for any other ratio', () => {
    expect(reframeCanvas({ aspect: '2.35:1' })).toEqual({ ok: true, width: 1920, height: 816 });
    expect(reframeCanvas({ aspect: '2:3' })).toEqual({ ok: true, width: 1280, height: 1920 });
  });

  it('lets an explicit size win and rounds it down to even sides', () => {
    expect(reframeCanvas({ aspect: '9:16', width: 721, height: 1281 })).toEqual({ ok: true, width: 720, height: 1280 });
  });

  it('refuses a half-specified size, an out-of-range size and an unreadable aspect', () => {
    expect(reframeCanvas({ width: 720 }).ok).toBe(false);
    expect(reframeCanvas({ width: 8, height: 8 }).ok).toBe(false);
    expect(reframeCanvas({ width: 9000, height: 1080 }).ok).toBe(false);
    expect(reframeCanvas({ aspect: 'vertical' }).ok).toBe(false);
    expect(reframeCanvas({}).ok).toBe(false);
    expect(reframeCanvas({ aspect: '0:16' }).ok).toBe(false);
  });
});

describe('reframePadColor', () => {
  it('accepts colour names and 6-digit hex', () => {
    expect(reframePadColor(undefined)).toBe('black');
    expect(reframePadColor('White')).toBe('white');
    expect(reframePadColor('#1A2b3C')).toBe('0x1a2b3c');
    expect(reframePadColor('0xFFFFFF')).toBe('0xffffff');
  });

  it('rejects anything that could splice into the filter graph', () => {
    expect(reframePadColor('red;drawtext=text=x')).toBeNull();
    expect(reframePadColor('black:x=1')).toBeNull();
    expect(reframePadColor('#fff')).toBeNull();
  });
});

describe('buildReframeFilter', () => {
  it('letterboxes by default and always ends on square-pixel yuv420p', () => {
    const { filter, complex } = buildReframeFilter({ mode: 'pad', width: 1080, height: 1920 });
    expect(complex).toBe(false);
    expect(filter.startsWith('scale=trunc(iw*sar/2)*2:ih,setsar=1,')).toBe(true);
    expect(filter).toContain('scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2');
    expect(filter).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(filter.endsWith('setsar=1,format=yuv420p')).toBe(true);
  });

  it('crops around the requested focus and clamps it to the frame', () => {
    expect(buildReframeFilter({ mode: 'crop', width: 1080, height: 1920 }).filter)
      .toContain('crop=1080:1920:(iw-ow)*0.5:(ih-oh)*0.5');
    expect(buildReframeFilter({ mode: 'crop', width: 1080, height: 1920, focusX: 2, focusY: -1 }).filter)
      .toContain('crop=1080:1920:(iw-ow)*1:(ih-oh)*0');
  });

  it('fills the bars with a blurred copy through a labelled filter_complex', () => {
    const { filter, complex } = buildReframeFilter({ mode: 'blur', width: 1080, height: 1920 });
    expect(complex).toBe(true);
    expect(filter).toMatch(/^\[0:v\]/);
    expect(filter).toContain('boxblur=45:2');
    expect(filter.endsWith('[rfv]')).toBe(true);
  });
});

// ── Real-ffmpeg round trips (skip where the bundled runtime is absent) ──────
const bins = bundledFfmpegPaths();
const haveFfmpeg = !!bins.ffmpeg && !!bins.ffprobe;

function redLandscapeClip(dir: string): string {
  const out = path.join(dir, 'landscape.mp4');
  const r = spawnSync(bins.ffmpeg!, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=15:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  return out;
}

function probe(file: string): { width: number; height: number; hasAudio: boolean; durationSec: number } {
  const r = spawnSync(bins.ffprobe!, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const j = JSON.parse(r.stdout) as {
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
    format: { duration?: string };
  };
  const video = j.streams.find((s) => s.codec_type === 'video')!;
  return {
    width: Number(video.width),
    height: Number(video.height),
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
    durationSec: Number(j.format.duration),
  };
}

/** RGB of one pixel in the frame at 0.5s. */
function pixel(file: string, width: number, height: number, x: number, y: number): [number, number, number] {
  const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 20_000 });
  expect(r.status, String(r.stderr)).toBe(0);
  expect(r.stdout.length).toBe(width * height * 3);
  const i = (y * width + x) * 3;
  return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]];
}

describe.skipIf(!haveFfmpeg)('reframe on real footage', () => {
  it('letterboxes a landscape clip onto a vertical canvas without losing picture, sound or time', async () => {
    const dir = tmp();
    const input = redLandscapeClip(dir);
    const original = fs.readFileSync(input);
    const output = path.join(dir, 'vertical.mp4');
    const result = await editVideo({ op: 'reframe', inputAbsPath: input, outputAbsPath: output, width: 90, height: 160 });
    expect(result).toMatchObject({ ok: true, op: 'reframe', path: output, reframe: { mode: 'pad', canvas: '90x160', from: '160x90' } });
    const out = probe(output);
    expect([out.width, out.height]).toEqual([90, 160]);
    expect(out.hasAudio).toBe(true);
    expect(Math.abs(out.durationSec - 1)).toBeLessThan(0.2);
    const [tr, tg, tb] = pixel(output, 90, 160, 45, 5);
    expect(Math.max(tr, tg, tb)).toBeLessThan(30);
    const [cr, cg, cb] = pixel(output, 90, 160, 45, 80);
    expect(cr).toBeGreaterThan(200);
    expect(Math.max(cg, cb)).toBeLessThan(60);
    expect(fs.readFileSync(input)).toEqual(original);
  });

  it('fills the canvas edge to edge when cropping', async () => {
    const dir = tmp();
    const input = redLandscapeClip(dir);
    const output = path.join(dir, 'cropped.mp4');
    const result = await editVideo({ op: 'reframe', inputAbsPath: input, outputAbsPath: output, width: 90, height: 160, mode: 'crop' });
    expect(result).toMatchObject({ ok: true, reframe: { mode: 'crop', focus: { x: 0.5, y: 0.5 } } });
    const [r, g, b] = pixel(output, 90, 160, 45, 5);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g, b)).toBeLessThan(60);
  });

  it('fills the bars with the blurred frame instead of black', async () => {
    const dir = tmp();
    const input = redLandscapeClip(dir);
    const output = path.join(dir, 'blurred.mp4');
    const result = await editVideo({ op: 'reframe', inputAbsPath: input, outputAbsPath: output, width: 90, height: 160, mode: 'blur' });
    expect(result).toMatchObject({ ok: true, reframe: { mode: 'blur', canvas: '90x160' } });
    expect([probe(output).width, probe(output).height]).toEqual([90, 160]);
    const [r] = pixel(output, 90, 160, 45, 5);
    expect(r).toBeGreaterThan(150);
  });

  it('refuses to write over its own input', async () => {
    const dir = tmp();
    const input = redLandscapeClip(dir);
    const original = fs.readFileSync(input);
    const result = await editVideo({ op: 'reframe', inputAbsPath: input, outputAbsPath: input, aspect: '9:16' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_EDIT_ARG' });
    expect(fs.readFileSync(input)).toEqual(original);
  });

  it('reports an input with no picture instead of encoding nothing', async () => {
    const dir = tmp();
    const audioOnly = path.join(dir, 'tone.m4a');
    const r = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const output = path.join(dir, 'never.mp4');
    const result = await editVideo({ op: 'reframe', inputAbsPath: audioOnly, outputAbsPath: output, aspect: '9:16' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_EDIT_NO_VIDEO' });
    expect(fs.existsSync(output)).toBe(false);
  });
});
