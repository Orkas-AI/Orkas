import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import {
  captionFontForText,
  concatListBody,
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

describe('subtitle filesystem paths through the real filter parser', () => {
  it.each(['captions.srt', "字幕 [1], it's; final.srt"])(
    'burns %s without changing the original clip', async (filename) => {
      const root = tmp();
      const input = path.join(root, 'source.mp4');
      const output = path.join(root, 'captioned.mp4');
      const subtitles = path.join(root, filename);
      const ffmpeg = bundledFfmpegPaths().ffmpeg!;
      const generated = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=blue:s=216x384:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { timeout: 10_000 });
      expect(generated.status, String(generated.stderr)).toBe(0);
      const original = fs.readFileSync(input);
      fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:01,000\nCaption visible\n');
      const result = await editVideo({ op: 'burnsubs', inputAbsPath: input,
        subtitlesAbsPath: subtitles, outputAbsPath: output });
      expect(result).toMatchObject({ ok: true, path: output });
      const frame = (file: string) => {
        const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1',
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 10_000 });
        expect(decoded.status, String(decoded.stderr)).toBe(0);
        expect(decoded.stdout.length).toBe(216 * 384 * 3);
        return decoded.stdout;
      };
      expect(frame(output)).not.toEqual(frame(input));
      expect(fs.readFileSync(input)).toEqual(original);
    });
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

describe.skipIf(!haveFfmpeg)('concat when only some parts carry sound', () => {
  // 2026-10-31 runs: a silent composed title card first, narrated cuts after.
  // The concat demuxer takes its streams from the first input, so the joined
  // video had no audio at all; a silent part in the middle ended it early.
  function clip(dir: string, name: string, withAudio: boolean): string {
    const out = path.join(dir, name);
    const r = spawnSync(bins.ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=2',
      ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'aac', '-shortest'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
    ], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return out;
  }
  function audioDuration(file: string): number | null {
    const r = spawnSync(bins.ffprobe!, [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' });
    const value = Number(r.stdout.trim());
    return r.stdout.trim() && Number.isFinite(value) ? value : null;
  }

  it.each([
    ['silent part first', [false, true]],
    ['silent part last', [true, false]],
  ])('keeps the sound across the whole join with the %s', async (_label, layout) => {
    const dir = tmp();
    const parts = (layout as boolean[]).map((withAudio, index) => clip(dir, `p${index}.mp4`, withAudio));
    const out = path.join(dir, 'joined.mp4');
    const result = await editVideo({ op: 'concat', inputAbsPaths: parts, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(audioDuration(out)).toBeGreaterThan(3.8);
    const audioConform = (result as any).audio_conform;
    expect(audioConform.padded_inputs).toEqual(parts.filter((_, index) => !(layout as boolean[])[index]));
    expect(audioConform.note).toMatch(/keeps the sound of the others/);
  }, 120_000);

  it.each([
    ['every part has sound', [true, true], true],
    ['no part has sound', [false, false], false],
  ])('leaves the join unchanged when %s', async (_label, layout, hasAudio) => {
    const dir = tmp();
    const parts = (layout as boolean[]).map((withAudio, index) => clip(dir, `q${index}.mp4`, withAudio));
    const out = path.join(dir, 'joined.mp4');
    const result = await editVideo({ op: 'concat', inputAbsPaths: parts, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(audioDuration(out) !== null).toBe(hasAudio);
    expect((result as any).audio_conform).toBeUndefined();
  }, 120_000);
});

// 2026-11-12: remove_fillers on a steady tone with ten cuts clicked at every
// join (max sample step 0.053 against a source 0.007) and came out with the
// audio 0.16s longer than the picture, because aselect kept samples the frame
// select had dropped. Cuts now land on frames and each audio piece is faded.
describe.skipIf(!haveFfmpeg)('jump cuts join cleanly and stay in sync', () => {
  function decodeMono(file: string): Float32Array {
    const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, String(r.stderr)).toBe(0);
    const buf = Buffer.from(r.stdout);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  }
  function streamDurations(file: string): Record<string, number> {
    const r = spawnSync(bins.ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const out: Record<string, number> = {};
    for (const line of String(r.stdout).trim().split('\n')) {
      const [kind, dur] = line.split(',');
      out[kind] = Number(dur);
    }
    return out;
  }
  function maxStep(samples: Float32Array, skip: number): number {
    let max = 0;
    for (let i = skip + 1; i < samples.length - skip; i += 1) max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
    return max;
  }

  it('removes ten fillers without clicks or audio drift', async () => {
    const dir = tmp();
    const input = path.join(dir, 'talk.mp4');
    const made = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=12',
      '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=12,volume=0.5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', input], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const words: Array<{ word: string; start: number; end: number }> = [];
    let t = 0;
    for (let i = 0; i < 10; i += 1) {
      words.push({ word: `w${i}`, start: t, end: t + 0.7137 });
      words.push({ word: 'um', start: t + 0.7137, end: t + 1.1348 });
      t += 1.1348;
    }
    words.push({ word: 'end', start: t, end: 12 });
    const transcript = path.join(dir, 'transcript.json');
    fs.writeFileSync(transcript, JSON.stringify({ words }));
    const out = path.join(dir, 'tight.mp4');
    const result = await editVideo({ op: 'remove_fillers', inputAbsPath: input, transcriptAbsPath: transcript, fillers: ['um'], padSec: 0, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const d = streamDurations(out);
    expect(d.video).toBeLessThan(9);
    expect(Math.abs(d.audio - d.video)).toBeLessThan(1 / 30 + 0.025);

    const source = maxStep(decodeMono(input), 4800);
    const cut = maxStep(decodeMono(out), 4800);
    expect(cut).toBeLessThan(source * 2);
  }, 120_000);
});

describe.skipIf(!haveFfmpeg)('burned captions on a vertical frame', () => {
  function captionBottomGap(file: string, w: number, h: number): number {
    const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
    expect(r.status, String(r.stderr)).toBe(0);
    const px = Buffer.from(r.stdout);
    expect(px.length).toBe(w * h);
    for (let y = h - 1; y >= 0; y -= 1) {
      for (let x = 0; x < w; x += 1) if (px[y * w + x] > 100) return h - 1 - y;
    }
    return -1;
  }
  it.each([
    ['vertical', 360, 640, (gap: number, h: number) => expect(gap / h).toBeGreaterThan(0.15)],
    ['landscape', 640, 360, (gap: number, h: number) => expect(gap / h).toBeLessThan(0.1)],
  ])('places %s captions for the frame shape', async (_label, w, h, check) => {
    const dir = tmp();
    const input = path.join(dir, 'clip.mp4');
    const made = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const subtitles = path.join(dir, 'captions.srt');
    fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:01,000\nCaption visible\n');
    const out = path.join(dir, 'captioned.mp4');
    const result = await editVideo({ op: 'burnsubs', inputAbsPath: input, subtitlesAbsPath: subtitles, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const gap = captionBottomGap(out, w, h);
    expect(gap).toBeGreaterThan(0);
    (check as (gap: number, h: number) => void)(gap, h);
  }, 60_000);
});

// 2026-11-14: an English version went out with the Chinese captions still burned in under
// the new ones. `cover` lays an opaque bar over the old band and puts the new captions on it.
describe.skipIf(!haveFfmpeg)('captions over captions already in the picture', () => {
  function rgbFrame(file: string, w: number, h: number, at: number): Buffer {
    const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 26 });
    expect(r.status).toBe(0);
    return r.stdout as Buffer;
  }
  const count = (px: Buffer, w: number, rows: [number, number], test: (r: number, g: number, b: number) => boolean) => {
    let n = 0;
    for (let y = rows[0]; y < rows[1]; y += 1) for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      if (test(px[i], px[i + 1], px[i + 2])) n += 1;
    }
    return n;
  };
  const red = (r: number, g: number, b: number) => r > 150 && g < 90 && b < 90;
  const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;

  it('covers the old band, sets the new captions in it, and leaves the rest of the picture', async () => {
    const dir = tmp();
    const [w, h] = [360, 640];
    const input = path.join(dir, 'clip.mp4');
    // A grey picture with a red caption bar burned in at 80-87% of the height.
    const made = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x506070:s=${w}x${h}:r=30:d=2`,
      '-vf', 'drawbox=x=40:y=ih*0.80:w=280:h=ih*0.07:color=red@1:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const subtitles = path.join(dir, 'english.srt');
    fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:02,000\nEasy on your eyes\n');
    const out = path.join(dir, 'english.mp4');
    const result = await editVideo({ op: 'burnsubs', inputAbsPath: input, subtitlesAbsPath: subtitles, cover: { top: 0.78, bottom: 0.89 }, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const band: [number, number] = [Math.floor(h * 0.78), Math.ceil(h * 0.89)];
    const before = rgbFrame(input, w, h, 1);
    const after = rgbFrame(out, w, h, 1);
    expect(count(before, w, band, red)).toBeGreaterThan(5000);
    expect(count(after, w, band, red)).toBe(0);
    expect(count(after, w, band, white)).toBeGreaterThan(50);
    // Above the band the picture is untouched: no bar, no caption.
    expect(count(after, w, [0, band[0] - 2], white)).toBe(0);
    expect(count(after, w, [0, band[0] - 2], (r, g, b) => r + g + b < 60)).toBe(0);

    const wide = await editVideo({ op: 'burnsubs', inputAbsPath: input, subtitlesAbsPath: subtitles, cover: { top: 0.2, bottom: 0.9 }, outputAbsPath: path.join(dir, 'wide.mp4') });
    expect(wide).toMatchObject({ ok: false, errorCode: 'E_EDIT_ARG' });
  }, 60_000);
});

describe.skipIf(!haveFfmpeg)('mix lowers the original sound only under the added line', () => {
  function bandLevelDb(samples: Float32Array, sr: number, freq: number, fromSec: number, toSec: number): number {
    // Goertzel power at one frequency over the window.
    const start = Math.floor(fromSec * sr);
    const end = Math.floor(toSec * sr);
    const k = (2 * Math.PI * freq) / sr;
    const coeff = 2 * Math.cos(k);
    let s1 = 0; let s2 = 0;
    for (let i = start; i < end; i += 1) { const s0 = samples[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return 10 * Math.log10(power / ((end - start) ** 2) + 1e-20);
  }
  it('ducks the base during the line and restores it after', async () => {
    const dir = tmp();
    const base = path.join(dir, 'scene.mp4');
    const made = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=6',
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=6,volume=0.3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const line = path.join(dir, 'line.wav');
    const tone = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=2,volume=0.5', line], { encoding: 'utf8' });
    expect(tone.status, tone.stderr).toBe(0);
    const out = path.join(dir, 'narrated.mp4');
    const result = await editVideo({ op: 'mix', inputAbsPath: base, audioSegments: [{ audioAbsPath: line, startSec: 2 }], onExistingAudio: 'mix', duck: true, outputAbsPath: out });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-i', out, '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, String(r.stderr)).toBe(0);
    const buf = Buffer.from(r.stdout);
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const before = bandLevelDb(pcm, 48000, 440, 0.3, 1.7);
    const during = bandLevelDb(pcm, 48000, 440, 2.3, 3.7);
    const after = bandLevelDb(pcm, 48000, 440, 4.6, 5.6);
    expect(before - during).toBeGreaterThan(5);
    expect(Math.abs(after - before)).toBeLessThan(2);
  }, 120_000);
});

// 2026-11-13: sixteen 128 BPM beats cut at 30 fps joined to 8.03 s instead of 7.5 s:
// each trim kept a frame too many and the join added one more where timestamps did
// not land on its constant-rate grid, so the last cut fell more than a beat late.
describe.skipIf(!haveFfmpeg)('cuts to a beat grid add up to the grid', () => {
  function frames(file: string): number {
    const r = spawnSync(bins.ffprobe!, ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return Number(String(r.stdout).trim());
  }

  it('trims to the nearest whole frame and joins sixteen beat cuts to exactly 7.5 s', async () => {
    const dir = tmp();
    const source = path.join(dir, 'source.mp4');
    const made = spawnSync(bins.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=12',
      '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);

    const one = path.join(dir, 'one-beat.mp4');
    expect((await editVideo({ op: 'trim', inputAbsPath: source, start: 1.03, duration: 0.46875, outputAbsPath: one })).ok).toBe(true);
    expect(frames(one)).toBe(14);

    const beat = 60 / 128;
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      const from = Math.round(i * beat * 30);
      const to = Math.round((i + 1) * beat * 30);
      const part = path.join(dir, `beat-${i}.mp4`);
      const cut = await editVideo({ op: 'trim', inputAbsPath: source, start: from / 30, duration: (to - from) / 30, outputAbsPath: part });
      expect(cut.ok, JSON.stringify(cut)).toBe(true);
      parts.push(part);
    }
    const joined = path.join(dir, 'joined.mp4');
    const result = await editVideo({ op: 'concat', inputAbsPaths: parts, outputAbsPath: joined });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(frames(joined)).toBe(225);
    // The picture starts with the sound, so each cut sits on its frame against the music
    // (2026-11-14: it started one frame late, and a montage's cuts with it).
    const starts = spawnSync(bins.ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'csv=p=0', joined], { encoding: 'utf8' });
    const start = Object.fromEntries(String(starts.stdout).trim().split('\n').map((row) => { const [kind, at] = row.split(','); return [kind, Number(at)]; }));
    expect(start.video).toBeCloseTo(start.audio, 3);
    const times = spawnSync(bins.ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', joined], { encoding: 'utf8' });
    const at = String(times.stdout).split('\n').map((row) => row.trim()).filter(Boolean).map((row) => Number(row.split(',')[0]));
    expect(at[0]).toBeCloseTo(0, 3);
    expect(at[Math.round(beat * 30)]).toBeCloseTo(Math.round(beat * 30) / 30, 3);
  }, 180_000);

  it('gives each file in the join its picture\'s length', () => {
    expect(concatListBody(['/a/x.mp4', "/a/it's.mp4", '/a/y.mp4'], [0.466667, 0.5, null])).toBe(
      "file '/a/x.mp4'\nduration 0.466667\nfile '/a/it'\\''s.mp4'\nduration 0.500000\nfile '/a/y.mp4'",
    );
  });
});
