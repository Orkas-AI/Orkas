import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { shipVideoFile } from '../../../src/main/features/video_timeline_ship';
import * as studio from '../../../src/main/features/video_studio';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import { measureVoicedSpan } from '../../../src/main/features/video_studio_delivery';

// Real FFmpeg files exercise the final delivery gate, including files made outside
// video.render. Synthetic test signals are fixtures, never production music.

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-ship-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  const { ffmpeg: bin } = bundledFfmpegPaths();
  const run = spawnSync(bin as string, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** Keep zeros as an actual AAC stream; a missing stream is a different defect. */
function withAudio(file: string, audio: string, secondAudio?: string): void {
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=1',
    '-f', 'lavfi', '-i', audio,
    ...(secondAudio ? ['-f', 'lavfi', '-i', secondAudio] : []),
    '-map', '0:v', '-map', '1:a', ...(secondAudio ? ['-map', '2:a'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
}

function codes(result: { issues?: unknown; warnings?: unknown }, key: 'issues' | 'warnings' = 'issues'): string[] {
  return ((result[key] ?? []) as Array<{ code: string }>).map((issue) => issue.code);
}

function project(root: string, manifest: unknown, assets: unknown[] = []) {
  const production = path.join(root, 'production');
  const video = path.join(production, 'videos', 'main');
  fs.mkdirSync(video, { recursive: true });
  fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets }));
  return { production, video };
}

function timeline(scenes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    id: 'main',
    label: 'Ad',
    canvas: { width: 360, height: 640, fps: 30 },
    scenes,
    ...extra,
  };
}

describe('measured narration boundaries', () => {
  const padded = 'aevalsrc=if(lt(t\\,0.5)\\,0.1*sin(2*PI*440*t)\\,0):s=48000:d=1';

  it.each([
    ['EOF silence', padded, 0, 0.5, 'pcm_s16le', 'wav'],
    ['compressed EOF silence', padded, 0, 0.5, 'aac', 'm4a'],
    ['interior pause', 'aevalsrc=if(between(t\\,0.3\\,0.6)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=1', 0, 1, 'pcm_s16le', 'wav'],
    ['speech resumes near EOF', 'aevalsrc=if(between(t\\,0.7\\,0.95)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=1', 0, 1, 'pcm_s16le', 'wav'],
    ['leading and trailing silence', 'aevalsrc=if(between(t\\,0.2\\,0.6)\\,0.1*sin(2*PI*440*t)\\,0):s=48000:d=1', 0.2, 0.6, 'pcm_s16le', 'wav'],
    ['no silence', 'sine=frequency=440:sample_rate=48000:duration=1', 0, 1, 'pcm_s16le', 'wav'],
    ['all silence', 'anullsrc=r=48000:cl=mono:d=1', 0, 0, 'pcm_s16le', 'wav'],
  ])('measures %s from actual decoded audio', async (_name, source, start, end, codec, extension) => {
    const file = path.join(makeRoot(), `source.${extension}`);
    ffmpeg(['-f', 'lavfi', '-i', String(source), '-c:a', String(codec), file]);
    const result = await measureVoicedSpan(file);
    expect(result).not.toBeNull();
    if (_name === 'all silence') expect(result!.endSec - result!.startSec).toBeCloseTo(0, 3);
    else {
      expect(result!.startSec).toBeCloseTo(Number(start), 2);
      expect(result!.endSec).toBeCloseTo(Number(end), 2);
    }
  });

  it('ships padded adjacent lines without a false overlap', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'a', duration: 0.6, narration: { text: 'One', asset: 'a' } },
      { id: 'b', duration: 0.4, narration: { text: 'Two', asset: 'b' } },
    ]), [
      { id: 'a', kind: 'audio', label: 'A', path: 'a.wav', origin: 'upload' },
      { id: 'b', kind: 'audio', label: 'B', path: 'b.wav', origin: 'upload' },
    ]);
    ffmpeg(['-f', 'lavfi', '-i', padded, '-c:a', 'pcm_s16le', path.join(production, 'a.wav')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.4', '-c:a', 'pcm_s16le', path.join(production, 'b.wav')]);
    const file = path.join(root, 'out.mp4');
    withAudio(file, 'aevalsrc=if(between(t\\,0.5\\,0.6)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=1');
    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
    expect(codes(result)).not.toContain('DELIVERY_NARRATION_OVERLAP');
    expect(result).toMatchObject({ ok: true, version: { id: 'v1' } });
    expect(fs.existsSync(path.join(production, 'versions/main-v1.mp4'))).toBe(true);
  });

  it.each(['failed', 'aborted'])('does not publish after a %s source narration decode', async (state) => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'a', duration: 1, narration: { text: 'One', asset: 'a' } },
    ]), [{ id: 'a', kind: 'audio', label: 'A', path: 'a.wav', origin: 'upload' }]);
    ffmpeg(['-f', 'lavfi', '-i', padded, '-c:a', 'pcm_s16le', path.join(production, 'a.wav')]);
    const file = path.join(root, 'out.mp4');
    withAudio(file, 'sine=frequency=440:sample_rate=48000:duration=1');
    const actual = studio.runVideoProcessForTest;
    vi.spyOn(studio, 'runVideoProcessForTest').mockImplementation(async (bin, args, options) => {
      if (!args.some(arg => arg.includes('silencedetect='))) return actual(bin, args, options);
      return { code: state === 'failed' ? 1 : 0, stdout: 'lavfi.silence_start=0.5', stderr: '', timedOut: false, aborted: state === 'aborted' };
    });
    const result = await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toContain('TIMELINE_ASSET_MISSING');
    expect(fs.existsSync(path.join(production, 'versions.json'))).toBe(false);
    expect(fs.existsSync(path.join(production, 'versions'))).toBe(false);
  });
});

describe('required sound in the delivered bytes', () => {
  const silence = 'anullsrc=r=48000:cl=stereo:d=1';
  const tone = 'sine=frequency=440:sample_rate=48000:duration=1';
  const silentCode = 'DELIVERY_AUDIO_SILENT';

  it('blocks zeros on a nonzero music track without publishing, then delivers a repaired file', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([{ id: 'a', duration: 1 }], {
      tracks: [{ kind: 'music', asset: 'bed', volume: 0.3 }],
    }), [{ id: 'bed', kind: 'audio', label: 'Music', path: 'bed.m4a', origin: 'upload' }]);
    ffmpeg(['-f', 'lavfi', '-i', tone, '-c:a', 'aac', path.join(production, 'bed.m4a')]);
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence);
    const ship = () => shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file });
    const before = fs.readFileSync(file);
    const result = await ship();
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toContain(silentCode);
    expect(fs.existsSync(path.join(production, 'versions.json'))).toBe(false);
    expect(fs.existsSync(path.join(production, 'versions'))).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);

    withAudio(file, tone);
    expect(await ship()).toMatchObject({ ok: true, version: { id: 'v1' } });
    const ledger = fs.readFileSync(path.join(production, 'versions.json'));
    const kept = fs.readFileSync(path.join(production, 'versions/main-v1.mp4'));
    withAudio(file, silence);
    expect(codes(await ship())).toContain(silentCode);
    expect(fs.readFileSync(path.join(production, 'versions.json'))).toEqual(ledger);
    expect(fs.readFileSync(path.join(production, 'versions/main-v1.mp4'))).toEqual(kept);
  });

  it.each(['track', 'clip'])('allows explicit zero volume on a %s', async (kind) => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'a', ...(kind === 'clip' ? { clips: [{ id: 'c', asset: 'source', in: 0, dur: 1, audio: 'keep', volume: 0 }] } : { duration: 1 }) },
    ], kind === 'track' ? { tracks: [{ kind: 'music', asset: 'source', volume: 0 }] } : {}), [
      { id: 'source', kind: kind === 'clip' ? 'video' : 'audio', label: 'Source', path: 'source.mp4', origin: 'upload' },
    ]);
    withAudio(path.join(production, 'source.mp4'), tone);
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence);
    expect(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file }))
      .toMatchObject({ ok: true });
  });

  it('requires sound for a clip keeping its audio at the default volume', async () => {
    const root = makeRoot();
    const { production, video } = project(root, timeline([
      { id: 'a', clips: [{ id: 'c', asset: 'source', in: 0, dur: 1, audio: 'keep' }] },
    ]), [{ id: 'source', kind: 'video', label: 'Source', path: 'source.mp4', origin: 'upload' }]);
    withAudio(path.join(production, 'source.mp4'), tone);
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence);
    expect(codes(await shipVideoFile({ productionDirAbs: production, videoDirAbs: video, allowedRoots: [root], videoPathAbs: file }))).toContain(silentCode);
  });

  it.each([
    ['quiet signal below the LUFS gate', 'aevalsrc=0.00001*sin(2*PI*440*t):s=48000:d=1'],
    ['a long pause then sound', 'aevalsrc=if(lt(t\\,0.8)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=1'],
    ['one active stereo channel', 'aevalsrc=0|0.1*sin(2*PI*440*t):s=48000:d=1'],
    ['opposite phase stereo channels', 'aevalsrc=0.1*sin(2*PI*440*t)|-0.1*sin(2*PI*440*t):s=48000:d=1'],
  ])('does not block %s', async (_name, source) => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, source);
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, expect: { hasAudio: true } });
    expect(result).toMatchObject({ ok: true });
    expect(codes(result, 'warnings')).not.toContain('DELIVERY_AUDIO_UNVERIFIABLE');
  });

  it('checks all audio streams instead of calling a silent first stream a silent file', async () => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence, tone);
    expect(await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, expect: { hasAudio: true } }))
      .toMatchObject({ ok: true });
    withAudio(file, silence, silence);
    expect(codes(await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, expect: { hasAudio: true } })))
      .toContain(silentCode);
  });

  it('permits an intentionally silent ffmpeg delivery, and preserves a user override for required sound', async () => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence);
    const args = { productionDirAbs: root, allowedRoots: [root], videoPathAbs: file };
    expect(await shipVideoFile({ ...args, expect: { hasAudio: false } })).toMatchObject({ ok: true });
    expect(codes(await shipVideoFile({ ...args, expect: { hasAudio: true } }))).toContain(silentCode);
    expect(await shipVideoFile({ ...args, expect: { hasAudio: true }, override: { codes: [silentCode], reason: 'User chose silence' } }))
      .toMatchObject({ ok: true, accepted_issues: [{ code: silentCode }] });
  });

  it.each(['silent', 'missing'] as const)('checks %s audio after finalization and removes a rejected copy without recording it', async (state) => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, tone);
    const before = fs.readFileSync(file);
    const finalize = vi.fn(async (kept: string) => {
      if (state === 'silent') withAudio(kept, silence);
      else ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=1', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', kept]);
    });
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, expect: { hasAudio: true }, finalize });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect(codes(result)).toContain(state === 'silent' ? silentCode : 'DELIVERY_NO_AUDIO');
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'versions.json'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'versions'))).toEqual([]);
  });

  it.each(['failed', 'timedOut', 'aborted', 'partial'] as const)('delivers with an explicit warning after %s audio verification, never a silence error', async (state) => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, tone);
    const actual = studio.runVideoProcessForTest;
    vi.spyOn(studio, 'runVideoProcessForTest').mockImplementation(async (bin, args, options) => {
      if (!args.some((arg) => arg.startsWith('astats='))) return actual(bin, args, options);
      return {
        code: state === 'failed' ? 1 : 0, stdout: '',
        stderr: '[Parsed_astats_0 @ 0x123] Overall\n[Parsed_astats_0 @ 0x123] Peak level dB: -inf\n'
          + (state === 'partial' ? '' : '[Parsed_astats_0 @ 0x123] Number of samples: 48000\n'),
        timedOut: state === 'timedOut', aborted: state === 'aborted',
      };
    });
    const result = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: file, expect: { hasAudio: true } });
    expect(result).toMatchObject({ ok: true, version: { integrated_lufs: null, warnings: ['DELIVERY_AUDIO_UNVERIFIABLE'] } });
    expect(codes(result)).not.toContain(silentCode);
    expect(codes(result, 'warnings')).toContain('DELIVERY_AUDIO_UNVERIFIABLE');
  });

  it('keeps a real silent loudnorm result unmeasurable without attempting normalization', async () => {
    const root = makeRoot();
    const file = path.join(root, 'out.mp4');
    withAudio(file, silence);
    const report = await studio.analyzeLoudness(bundledFfmpegPaths().ffmpeg!, file);
    expect(report).toMatchObject({ input_i: null, input_tp: null, normalized: { input_i: '-inf', input_tp: '-inf' } });
    expect(studio.shouldNormalizeLoudness(report, 'draft')).toEqual({ normalize: false, reason: 'loudness analysis unavailable' });
  });
});
