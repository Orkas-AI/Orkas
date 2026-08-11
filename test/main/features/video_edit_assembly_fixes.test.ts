import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import {
  captionFontForText,
  editVideo,
  ffmpegFailure,
  normalizeLoudnessAudioFilter,
  overlayWouldEraseBase,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

// The 2026-08-05 assembly triple: loudness died on its own mono mix, a failed
// run left a 0-byte deliverable for resume to pick up, and an opaque
// full-frame overlay silently replaced the user's footage. Each fix gets its
// exact failure shape pinned here.

const tmpRoots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-edit-fixes-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalize_loudness channel-layout pin', () => {
  it('pins a known stereo layout after the resample', () => {
    // Without the trailing aformat, a mono input dies in negotiation between
    // aresample and the aac encoder ("Cannot select channel layout for the
    // link between Parsed_aresample_1 and format_out_0_1") — and a TTS-only
    // mix is ALWAYS mono, so the pipeline's own draft was unprocessable.
    const filter = normalizeLoudnessAudioFilter();
    expect(filter).toMatch(/^loudnorm=I=-14:TP=-1:LRA=11,/);
    expect(filter.endsWith('aresample=48000,aformat=channel_layouts=stereo')).toBe(true);
  });
});

describe('overlayWouldEraseBase', () => {
  const base = { width: 1920, height: 1080 };
  it('flags a full-frame opaque overlay — the shape that deleted the orca footage', () => {
    expect(overlayWouldEraseBase(base, { width: 1920, height: 1080, hasAlpha: false })).toBe(true);
    // Larger than the base erases it just the same.
    expect(overlayWouldEraseBase(base, { width: 3840, height: 2160, hasAlpha: false })).toBe(true);
  });
  it('keeps partial opaque overlays working — logo boxes and lower thirds are the intent', () => {
    expect(overlayWouldEraseBase(base, { width: 1920, height: 240, hasAlpha: false })).toBe(false);
    expect(overlayWouldEraseBase(base, { width: 480, height: 270, hasAlpha: false })).toBe(false);
  });
  it('lets a full-frame ALPHA overlay through — that is the correct future path', () => {
    expect(overlayWouldEraseBase(base, { width: 1920, height: 1080, hasAlpha: true })).toBe(false);
  });
  it('fails open when a probe is missing — a blind guard must not block edits', () => {
    expect(overlayWouldEraseBase(null, { width: 1920, height: 1080, hasAlpha: false })).toBe(false);
    expect(overlayWouldEraseBase(base, null)).toBe(false);
  });
});

describe('captionFontForText', () => {
  it('names a Simplified-capable family for zh captions — the tofu fix', () => {
    // Unset, macOS libass resolves a Japanese-coverage default:
    // Simplified-only characters (指挥官的挥、专家的专、协作的协) burned as
    // tofu boxes in the 2026-08-06 delivery while shared kanji rendered fine.
    const zh = '指挥官 + 专家 Agent 协作交付';
    expect(captionFontForText(zh, 'darwin')).toBe('PingFang SC');
    expect(captionFontForText(zh, 'win32')).toBe('Microsoft YaHei');
    expect(captionFontForText(zh, 'linux')).toBe('Noto Sans CJK SC');
  });

  it('lets kana win over Han — Japanese captions contain both scripts', () => {
    expect(captionFontForText('チームで直接、成果を届ける', 'darwin')).toBe('Hiragino Sans');
    expect(captionFontForText('AIチームが交付します', 'win32')).toBe('Yu Gothic UI');
  });

  it('keeps the platform default for Latin-only captions', () => {
    expect(captionFontForText('Direct your AI team by chat.', 'darwin')).toBe('');
    expect(captionFontForText('Entregue com sua equipe de IA.', 'win32')).toBe('');
  });
});

describe('ffmpegFailure output cleanup', () => {
  it('removes the partial output a failed run left behind', () => {
    // ffmpeg creates the output before the filter graph initializes; the
    // loudness crash left a 0-byte video.mp4, and stage-assemble's resume
    // treats an existing newer output as done — one resume from shipping it.
    const dir = tmp();
    const partial = path.join(dir, 'video.mp4');
    fs.writeFileSync(partial, '');
    const result = ffmpegFailure(
      'normalize_loudness',
      { code: 1, stderr: 'Conversion failed!', timedOut: false, aborted: false },
      partial,
    );
    expect(result.ok).toBe(false);
    expect(fs.existsSync(partial)).toBe(false);
  });

  it('reports the failure unchanged when there is nothing to clean', () => {
    const result = ffmpegFailure(
      'concat',
      { code: 1, stderr: 'boom', timedOut: false, aborted: false },
      path.join(tmp(), 'never-created.mp4'),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errorCode).toBe('E_EDIT_FAILED');
  });
});

// ── Real-ffmpeg round trips (skip where the bundled runtime is absent) ──────
const bins = bundledFfmpegPaths();
const haveFfmpeg = !!bins.ffmpeg && !!bins.ffprobe;

function makeToneClip(dir: string, opts: { channels: 1 | 2; withVideo: boolean; name: string; durationSec?: number }): string {
  const out = path.join(dir, opts.name);
  const dur = String(opts.durationSec ?? 2);
  const args = opts.withVideo
    ? ['-y', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:r=15:d=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-ac', String(opts.channels), '-c:v', 'libx264', '-c:a', 'aac', '-shortest', out]
    : ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-ac', String(opts.channels), '-c:a', 'aac', out];
  const r = spawnSync(bins.ffmpeg!, args, { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return out;
}

function probeAudioChannels(file: string): number {
  const r = spawnSync(bins.ffprobe!, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  return Number(String(r.stdout).trim());
}

describe.skipIf(!haveFfmpeg)('normalize_loudness on a mono draft (the delivery blocker)', () => {
  it('normalizes a mono aac video and outputs stereo', async () => {
    const dir = tmp();
    const monoDraft = makeToneClip(dir, { channels: 1, withVideo: true, name: 'draft-mono.mp4', durationSec: 3 });
    const out = path.join(dir, 'video.mp4');
    const result = await editVideo({ op: 'normalize_loudness', inputAbsPath: monoDraft, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    expect(probeAudioChannels(out)).toBe(2);
    if (result.ok) expect(result.loudness?.integratedLufs).not.toBeNull();
  }, 60_000);
});

describe.skipIf(!haveFfmpeg)('overlay opaque guard against real files', () => {
  it('refuses the full-frame opaque overlay instead of erasing the base', async () => {
    const dir = tmp();
    const base = makeToneClip(dir, { channels: 1, withVideo: true, name: 'base.mp4' });
    const overlay = makeToneClip(dir, { channels: 1, withVideo: true, name: 'overlay.mp4' });
    const result = await editVideo({
      op: 'overlay', inputAbsPath: base, overlayAbsPath: overlay,
      outputAbsPath: path.join(dir, 'out.mp4'),
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorCode).toBe('E_EDIT_OVERLAY_OPAQUE');
      expect(result.message).toMatch(/replace the base footage/i);
      expect(result.message).toMatch(/lower third|composed primary/i);
    }
  }, 60_000);
});

// 2026-08-09: five 1920x1080@15 composed parts were joined to one 1918x1080@24
// source cut. The concat demuxer takes its canvas and time base from the FIRST
// input and reinterprets the rest against it, so 60.03s of material came out
// as a 75.04s file — exactly 24/15 — with every scene drifting behind
// narration still timed to the plan, and the whole video shrunk to one clip's
// odd 1918 width. The op returned ok. The model only caught it two assembly
// rounds later by probing the draft against the plan.
// 2026-08-10 AUTO delivery: the last narration line was 6.84s in a 6.125s
// window, `-shortest` cut 0.72s of it off the end, and the mix reported that in
// `coverage.warnings` while returning ok. The model read past it and published
// a video whose closing call-to-action stops mid-sentence. A file that does not
// contain the audio it was handed is corrupt the same way a concat whose
// duration does not match its parts is corrupt, and that one already fails.
describe.skipIf(!haveFfmpeg)('mix refuses a narration it had to cut short', () => {
  function silentVideo(dir: string, name: string, dur: number): string {
    const out = path.join(dir, name);
    const r = spawnSync(bins.ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=15:d=${dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
    ], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return out;
  }
  function tone(dir: string, name: string, dur: number): string {
    const out = path.join(dir, name);
    const r = spawnSync(bins.ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-c:a', 'libmp3lame', out,
    ], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return out;
  }

  it('fails when a per-line narration runs past the video', async () => {
    const dir = tmp();
    const base = silentVideo(dir, 'primary.mp4', 3);
    const line = tone(dir, 'line-01.mp3', 4.5);
    const out = path.join(dir, 'mixed.mp4');

    const result = await editVideo({
      op: 'mix',
      inputAbsPath: base,
      audioSegments: [{ audioAbsPath: line, startSec: 0 }],
      outputAbsPath: out,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.errorCode).toBe('E_EDIT_MIX_NARRATION_TRUNCATED');
    // The refusal carries the size of the loss and both legal fixes; a bare
    // "truncated" is what the warning already said and it changed nothing.
    expect(result.message).toMatch(/past the 3s video/);
    expect(result.message).toMatch(/re-synthesize|extend the video/);
  }, 120_000);

  it('leaves a music bed longer than the clip alone', async () => {
    // The assembly skill mixes narration per line onto a silent base, then
    // ducks a music bed under it as a single audio_path. A bed longer than the
    // clip is MEANT to be trimmed, so only per-line placement can be cut wrong.
    const dir = tmp();
    const base = silentVideo(dir, 'primary.mp4', 3);
    const bed = tone(dir, 'bed.mp3', 4.5);
    const out = path.join(dir, 'with-bed.mp4');

    const result = await editVideo({
      op: 'mix',
      inputAbsPath: base,
      audioAbsPath: bed,
      outputAbsPath: out,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  }, 120_000);

  it('keeps interior dead air a warning, not a refusal', async () => {
    // Gaps between lines are an editorial call the user may accept; only a
    // truncated deliverable is objectively broken.
    const dir = tmp();
    const base = silentVideo(dir, 'primary.mp4', 10);
    const first = tone(dir, 'a.mp3', 1);
    const second = tone(dir, 'b.mp3', 1);
    const out = path.join(dir, 'gapped.mp4');

    const result = await editVideo({
      op: 'mix',
      inputAbsPath: base,
      audioSegments: [{ audioAbsPath: first, startSec: 0 }, { audioAbsPath: second, startSec: 7 }],
      outputAbsPath: out,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect((result as any).coverage.status).toBe('gapped');
  }, 120_000);
});

describe.skipIf(!haveFfmpeg)('concat across parts that do not share a canvas', () => {
  function makeSilentClip(dir: string, name: string, w: number, h: number, fps: number, dur: number): string {
    const out = path.join(dir, name);
    const r = spawnSync(bins.ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${w}x${h}:r=${fps}:d=${dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
    ], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return out;
  }
  function probe(file: string): { width: number; fps: number; duration: number } {
    const r = spawnSync(bins.ffprobe!, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,r_frame_rate', '-show_entries', 'format=duration',
      '-of', 'json', file,
    ], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout) as {
      streams?: Array<{ width?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const s = (j.streams ?? [])[0] ?? {};
    const [num, den] = String(s.r_frame_rate || '0/1').split('/');
    return {
      width: Number(s.width),
      fps: Number(num) / (Number(den) || 1),
      duration: Number(j.format?.duration ?? 0),
    };
  }

  it('keeps the timeline and the larger canvas when the parts disagree', async () => {
    const dir = tmp();
    // The incident's shape: an odd-width 24fps cut first, designed 15fps parts
    // after it. First-input-wins is what made this corrupt.
    const cut = makeSilentClip(dir, 'cut.mp4', 1918, 1080, 24, 2);
    const composedA = makeSilentClip(dir, 'a.mp4', 1920, 1080, 15, 3);
    const composedB = makeSilentClip(dir, 'b.mp4', 1920, 1080, 15, 3);
    const out = path.join(dir, 'primary.mp4');

    const result = await editVideo({
      op: 'concat',
      inputAbsPaths: [cut, composedA, composedB],
      outputAbsPath: out,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const joined = probe(out);
    // 8s of material must stay 8s — the 24/15 stretch put it at 12.8s.
    expect(joined.duration).toBeGreaterThan(7.5);
    expect(joined.duration).toBeLessThan(8.5);
    // A designed 1920 frame is never shrunk to fit one clip's 1918.
    expect(joined.width).toBe(1920);
    expect(joined.fps).toBe(24);
    // Re-encoding the caller's material to a canvas and rate it did not ask
    // for is a change to the delivery. The 2026-08-10 AUTO run got only
    // "concat wrote <path>", so nothing downstream could see that its parts
    // had been resampled 15→24 and its source padded 1918→1920.
    const conform = (result as any).conform;
    expect(conform.applied).toBe(true);
    expect(conform.target).toBe('1920x1080@24');
    expect(conform.conformed_inputs.map((entry: any) => [entry.input, entry.from, entry.to])).toEqual([
      [cut, '1918x1080@24', '1920x1080@24'],
      [composedA, '1920x1080@15', '1920x1080@24'],
      [composedB, '1920x1080@15', '1920x1080@24'],
    ]);
    expect(conform.note).toMatch(/re-render it at delivery quality/);
  }, 180_000);

  it('joins an already-uniform set without touching it', async () => {
    const dir = tmp();
    const a = makeSilentClip(dir, 'u1.mp4', 640, 360, 24, 2);
    const b = makeSilentClip(dir, 'u2.mp4', 640, 360, 24, 2);
    const out = path.join(dir, 'uniform.mp4');
    const result = await editVideo({ op: 'concat', inputAbsPaths: [a, b], outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const joined = probe(out);
    expect(joined.width).toBe(640);
    expect(joined.duration).toBeGreaterThan(3.5);
    expect(joined.duration).toBeLessThan(4.5);
    // Nothing was changed, so nothing is reported — an unconditional conform
    // block would make every ordinary join look like a re-encode.
    expect((result as any).conform).toBeUndefined();
  }, 120_000);
});
