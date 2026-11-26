import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterAll, describe, expect, it } from 'vitest';
import { PHRASE_VIEW_NOTE } from '../../../src/main/features/video_phrases';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const scriptContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-skill-container-'));
afterAll(() => fs.rmSync(scriptContainer, { recursive: true, force: true }));

function pcDir() {
  return path.resolve(__dirname, '../../..');
}

function skillDir(skillId: 'stage-edit' | 'stage-plan') {
  return path.join(
    pcDir(),
    'resources',
    'builtin',
    'marketplace',
    'agents',
    '79df9cc89f5f',
    'skills',
    skillId,
  );
}

function runSkill(
  skillId: 'stage-edit',
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const dir = pcDir();
  return spawnSync(
    TEST_NODE,
    [path.join(dir, 'bin', 'run-skill.cjs'), skillId, script, '--', ...args],
    {
      cwd: path.dirname(dir),
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_PC_DIR: dir,
        ORKAS_RUN_SKILL_DIR: skillDir(skillId),
        ORKAS_WORKSPACE_ROOT: path.join(scriptContainer, 'data'),
        ...extraEnv,
      },
    },
  );
}

function parseJson(text: string) {
  return JSON.parse(text.trim());
}

/** The result line of a script that also prints progress lines. */
function lastJson(text: string) {
  const lines = text.trim().split('\n').filter((line) => line.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1]);
}

function makeFakeFfmpegEnv(tmp: string) {
  if (process.platform === 'win32') {
    const runtimeDir = path.join(pcDir(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
    const ffmpegPath = path.join(runtimeDir, 'ffmpeg.exe');
    const ffprobePath = path.join(runtimeDir, 'ffprobe.exe');
    const input = path.join(tmp, 'input.mp4');
    const generated = spawnSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=3',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
    ], { encoding: 'utf8' });
    if (generated.status !== 0) throw new Error(generated.stderr || 'failed to generate Windows media fixture');
    return {
      ORKAS_BUNDLED_FFMPEG: ffmpegPath,
      ORKAS_BUNDLED_FFPROBE: ffprobePath,
    };
  }

  const binDir = path.join(tmp, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ffprobePath = path.join(binDir, 'ffprobe');
  fs.writeFileSync(ffprobePath, [
    '#!/usr/bin/env node',
    "process.stdout.write('10');",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffprobePath, 0o755);

  const ffmpegPath = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ffmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const out = process.argv[process.argv.length - 1];',
    "process.stderr.write('out_time_us=1000000\\nprogress=continue\\n');",
    "process.stderr.write('out_time_us=2000000\\nprogress=end\\n');",
    "fs.writeFileSync(out, 'fake video output');",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffmpegPath, 0o755);

  return {
    ORKAS_BUNDLED_FFMPEG: ffmpegPath,
    ORKAS_BUNDLED_FFPROBE: ffprobePath,
  };
}

describe('video media skill scripts', () => {
  it('grounds screen narration in current-model frame evidence without a recognition installation', () => {
    const reference = fs.readFileSync(path.join(skillDir('stage-edit'), 'references', 'transcript-and-screen-grounded-editing.md'), 'utf8');
    for (const body of [reference,
      fs.readFileSync(path.join(skillDir('stage-edit'), 'SKILL.md'), 'utf8'),
    ]) {
      expect(body).not.toMatch(/ocr_file|--op ocr|OCR is mandatory|OCR runtime/);
      expect(body).toContain('extract_frame');
    }
    expect(reference).toContain('current model');
    expect(reference).toContain('extraction time');
    expect(reference).toContain('not an\n   exact transition boundary');
    expect(reference).toContain('readable text with timing');
    expect(reference).toContain('install a local\n   recognition engine');
    expect(reference).toContain('separate paid vision model');
  });

  it('keeps VideoStudio media logic local to skill scripts', () => {
    const files = [
      path.join(skillDir('stage-edit'), 'scripts', 'analyze_media.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'edit_video.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_analyze_core.cjs'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_edit_core.cjs'),
    ];
    const forbidden = [
      /\bpcRequire\b/,
      /src\/main\/features/,
      /src\/main\/util\/uniquify/,
      /electron-log/,
      /node_modules\/electron/,
      /require\(["']electron["']\)/,
      /rapidocr|pypdfium2|ocr_runtime|ocrImagesText|ocrImageText/,
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of forbidden) expect(text, `${file} contains ${re}`).not.toMatch(re);
    }

    for (const file of [
      path.join(pcDir(), 'src', 'main', 'features', 'video_analyze.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_decide.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_edit.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_edl.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_render.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_craft_lint.ts'),
    ]) {
      expect(fs.existsSync(file), `${file} should not exist`).toBe(false);
    }
  });

  it('exposes analyze_media through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'analyze_media', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).not.toContain('transcribe');
    expect(out.ops).not.toContain('ocr');
    expect(out.ops).toContain('quality');
    expect(out.usage).toContain('speech.transcribe');
  });

  it('rejects retired OCR commands before loading a backend or touching input', () => {
    const res = runSkill('stage-edit', 'analyze_media', ['--op', 'ocr', '--input', 'missing.mp4']);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(parseJson(res.stderr)).toMatchObject({ code: 'E_ARGS' });
    expect(parseJson(res.stderr).message).toBe('op must be one of: silence, scenes, quality, phrases, activity, beats');
  });

  const realFfmpegDir = path.join(pcDir(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
  const realFfmpeg = path.join(realFfmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  it.skipIf(!fs.existsSync(realFfmpeg))('splits a transcript at the pauses measured in the recording', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-phrases-'));
    try {
      // Speech, 0.6 s of silence, speech: the transcript stretches the first word
      // over the pause, as speech recognition does.
      const media = path.join(tmp, 'talk.m4a');
      const made = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.6',
        '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=1',
        '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', '-c:a', 'aac', media], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const transcript = path.join(tmp, 'talk.transcript.json');
      fs.writeFileSync(transcript, JSON.stringify({ words: [
        { text: '第一句', startSec: 0, endSec: 1.5 }, { text: '第二句', startSec: 1.5, endSec: 2.6 },
      ] }));
      const ffprobe = path.join(realFfmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const env = { ORKAS_BUNDLED_FFMPEG: realFfmpeg, ORKAS_BUNDLED_FFPROBE: ffprobe };
      const inline = runSkill('stage-edit', 'analyze_media', ['--op', 'phrases', '--input', media, '--transcript', transcript], env);
      expect(inline.status, inline.stderr).toBe(0);
      const out = lastJson(inline.stdout);
      expect(out.summary).toMatchObject({ lines: 2, measuredPauses: 1 });
      // The same caution the transcription result carries with its view.
      expect(out.summary.note).toBe(PHRASE_VIEW_NOTE);
      expect(out.text).toMatch(/^\[0\.00–1\.0\d\] 第一句\n  — 0\.[56]\ds —\n\[1\.[56]\d–2\.60\] 第二句$/);

      const saved = path.join(tmp, 'cuts', 'phrases.txt');
      const filed = runSkill('stage-edit', 'analyze_media', ['--op', 'phrases', '--input', media, '--transcript', transcript, '--output', saved], env);
      expect(filed.status, filed.stderr).toBe(0);
      expect(lastJson(filed.stdout)).toMatchObject({ path: saved });
      expect(fs.readFileSync(saved, 'utf8')).toBe(`${out.text}\n`);

      // A long recording: the reply carries the first 200 lines and asks for --output.
      // Its audio never falls silent, so the words' own gaps split the lines.
      const steady = path.join(tmp, 'steady.m4a');
      const toned = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=3', '-c:a', 'aac', steady], { encoding: 'utf8' });
      expect(toned.status, toned.stderr).toBe(0);
      const long = path.join(tmp, 'long.transcript.json');
      fs.writeFileSync(long, JSON.stringify({ words: Array.from({ length: 250 }, (_, i) => ({ text: `w${i}`, startSec: i, endSec: i + 0.4 })) }));
      const capped = lastJson(runSkill('stage-edit', 'analyze_media', ['--op', 'phrases', '--input', steady, '--transcript', long], env).stdout);
      expect(capped.summary).toMatchObject({ lines: 250, truncated: true });
      expect(capped.text.split('\n').filter((row: string) => row.startsWith('['))).toHaveLength(200);
      expect(capped.text).toMatch(/50 more lines\. Run again with --output/);

      const clobber = runSkill('stage-edit', 'analyze_media', ['--op', 'phrases', '--input', media, '--transcript', transcript, '--output', transcript], env);
      expect(clobber.status).toBe(1);
      expect(parseJson(clobber.stderr)).toMatchObject({ code: 'E_ARGS' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!fs.existsSync(realFfmpeg))('follows whoever is talking from mouth motion to a vertical cut', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-activity-'));
    try {
      // Two faces on a still camera; noise in a mouth box stands in for speech. Left talks
      // 0–3 s, right 3–6.5 s, left says one half-second word, right talks again to 9 s.
      const media = path.join(tmp, 'talk.mp4');
      const made = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x404850:s=1280x720:r=30:d=9',
        '-f', 'lavfi', '-i', 'color=c=0x808080:s=128x64:r=30:d=9,noise=alls=100:allf=t+u',
        '-filter_complex', "[0:v]drawbox=x=190:y=200:w=260:h=320:color=0xd8b090:t=fill,drawbox=x=830:y=200:w=260:h=320:color=0xc0a080:t=fill[base];"
          + "[1:v]split=2[n1][n2];[base][n1]overlay=x=256:y=400:enable='between(t,0,3)+between(t,6.5,7)'[a];"
          + "[a][n2]overlay=x=896:y=400:enable='between(t,3,6.5)+between(t,7,9)'[v]",
        '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const ffprobe = path.join(realFfmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const env = { ORKAS_BUNDLED_FFMPEG: realFfmpeg, ORKAS_BUNDLED_FFPROBE: ffprobe };
      const sourceBytes = fs.readFileSync(media);
      const regions = JSON.stringify([{ id: '__proto__', box: [0.18, 0.52, 0.38, 0.68] }, { id: 'right', box: [0.68, 0.52, 0.88, 0.68] }]);
      const measured = runSkill('stage-edit', 'analyze_media', ['--op', 'activity', '--input', media, '--regions', regions], env);
      expect(measured.status, measured.stderr).toBe(0);
      const summary = lastJson(measured.stdout).summary;
      expect(summary.turns.map((t: any) => [t.start, t.end, t.region])).toEqual([[0, 3, '__proto__'], [3, 9, 'right']]);
      expect(summary.plan).toEqual([{ start: 0, centre_x: 0.28, centre_y: 0.6 }, { start: 3, centre_x: 0.78, centre_y: 0.6 }]);

      const fine = runSkill('stage-edit', 'analyze_media', ['--op', 'activity', '--input', media,
        '--regions', regions, '--window', '0.05'], env);
      expect(fine.status, fine.stderr).toBe(0);
      const fineSummary = lastJson(fine.stdout).summary;
      expect(fineSummary.windowCount).toBe(180);
      expect(fineSummary.windows[0]).toMatchObject({ start: 0, end: 0.05 });
      // At 10Hz the first measured difference after the 3s handoff is at 3.1s;
      // a 50ms window must retain it, rather than reuse the coarse 0.5s boundary.
      expect(fineSummary.plan).toEqual([{ start: 0, centre_x: 0.28, centre_y: 0.6 },
        { start: 3.1, centre_x: 0.78, centre_y: 0.6 }]);
      expect(fineSummary.turns[0]).toMatchObject({ start: 0, region: '__proto__' });
      expect(fineSummary.turns.at(-1)).toMatchObject({ end: 9, region: 'right' });
      expect(fs.readFileSync(media)).toEqual(sourceBytes);

      const planFile = path.join(tmp, 'plan.json');
      fs.writeFileSync(planFile, JSON.stringify(summary.plan));
      const vertical = path.join(tmp, 'vertical.mp4');
      const cut = runSkill('stage-edit', 'edit_video', ['--op', 'reframe', '--input', media, '--aspect', '9:16', '--plan', `@${planFile}`, '--output', vertical], env);
      expect(cut.status, cut.stderr).toBe(0);
      // The middle of the frame shows the lighter left face at 1 s and the darker right face at 5 s.
      const centreLuma = (sec: number): number => {
        const r = spawnSync(realFfmpeg, ['-v', 'error', '-ss', String(sec), '-i', vertical, '-frames:v', '1',
          '-vf', 'crop=200:200:440:560,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
        expect(r.status, String(r.stderr)).toBe(0);
        return r.stdout[0];
      };
      const left = centreLuma(1);
      const right = centreLuma(5);
      expect(Math.abs(left - 184)).toBeLessThan(8);
      expect(Math.abs(right - 166)).toBeLessThan(8);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!fs.existsSync(realFfmpeg)).each([false, true])('covers existing captions and preserves an occupied command-line output (collision=%s)', collision => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cover-'));
    try {
      const ffprobe = path.join(realFfmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const env = { ORKAS_BUNDLED_FFMPEG: realFfmpeg, ORKAS_BUNDLED_FFPROBE: ffprobe };
      const media = path.join(tmp, 'clip.mp4');
      const made = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x506070:s=360x640:r=30:d=1',
        '-vf', 'drawbox=x=40:y=ih*0.80:w=280:h=ih*0.07:color=red@1:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const subtitles = path.join(tmp, 'en.srt');
      fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:01,000\nEasy on your eyes\n');
      const out = path.join(tmp, 'en.mp4');
      const original = fs.readFileSync(media);
      if (collision) fs.writeFileSync(out, original);
      const expectedOutput = collision ? path.join(tmp, 'en-2.mp4') : out;
      const res = runSkill('stage-edit', 'edit_video', ['--op', 'burnsubs', '--input', media, '--subtitles', subtitles, '--cover', '0.78,0.89', '--output', out], env);
      expect(res.status, res.stderr).toBe(0);
      expect(lastJson(res.stdout)).toMatchObject({ ok: true, path: expectedOutput });
      expect(fs.readFileSync(media)).toEqual(original);
      if (collision) expect(fs.readFileSync(out)).toEqual(original);
      const band = spawnSync(realFfmpeg, ['-v', 'error', '-ss', '0.5', '-i', expectedOutput, '-frames:v', '1',
        '-vf', 'crop=iw:ih*0.11:0:ih*0.78', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 24 });
      expect(band.status, String(band.stderr)).toBe(0);
      let red = 0;
      for (let i = 0; i + 2 < band.stdout.length; i += 3) if (band.stdout[i] > 150 && band.stdout[i + 1] < 90 && band.stdout[i + 2] < 90) red += 1;
      expect(red).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  // 2026-11-14 baseline: runs passed inline JSON or a path list where a file or JSON was
  // asked for, or a path from the wrong folder, then reported the tool as broken and stopped.
  // 2026-11-19: an attachment named "导出带商品图片的 PDF 清单-录屏.mp4" passed unquoted came back as
  // "unexpected argument: PDF", twice, with nothing saying the shell had split the path.
  it('names a path the shell split at its spaces and shows it quoted, and lists the options otherwise', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-split-path-'));
    try {
      const named = path.join(tmp, '导出带商品图片的 PDF 清单-录屏.mp4');
      fs.writeFileSync(named, 'not a real video');
      const split = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', path.join(tmp, '导出带商品图片的'), 'PDF', '清单-录屏.mp4']);
      expect(split.status).toBe(1);
      expect(parseJson(split.stderr)).toMatchObject({ code: 'E_ARGS',
        message: `unexpected argument: PDF. The path after --input has spaces, so the shell split it: quote it, as in --input '${named}', and run it again.` });

      const stray = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', path.join(tmp, '导出带商品图片的'), 'PDF', 'other.mp4']);
      expect(stray.status).toBe(1);
      const strayError = parseJson(stray.stderr);
      expect(strayError.message).toMatch(/^unexpected argument: PDF; accepted options are --aspect /);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Each message now says what to pass and to run it again.
  it('says how to fix a call the caller got wrong', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-own-call-'));
    try {
      const timing = createRequire(import.meta.url)(path.join(pcDir(), 'resources', 'builtin', 'marketplace', 'agents',
        '79df9cc89f5f', 'skills', 'video-studio', 'scripts', 'storyboard_timing.js'));
      const inline = await timing({ args: ['--input', '{"duration_sec":30,"segments":[]}'] });
      expect(inline).toMatchObject({ ok: false, errorCode: 'E_STORYBOARD_TIMING_INPUT' });
      expect(inline.message).toContain('Write the JSON to a file in the production');
      expect(inline.message).toContain('run it again');

      const media = path.join(tmp, 'clip.mp4');
      fs.writeFileSync(media, 'not a real video');
      const segments = runSkill('stage-edit', 'edit_video', ['--op', 'mix', '--input', media,
        '--audio-segments', 'voice/1.mp3,voice/2.mp3', '--output', path.join(tmp, 'out.mp4')]);
      expect(segments.status).toBe(1);
      const segmentsError = parseJson(segments.stderr);
      expect(segmentsError).toMatchObject({ code: 'E_ARGS' });
      expect(segmentsError.message).toContain('--audio-segments is not valid JSON');
      expect(segmentsError.message).toContain(`'[{"path": "voice/1.mp3", "start": 0}]'`);
      expect(segmentsError.message).toContain('run it again');

      const plan = runSkill('stage-edit', 'edit_video', ['--op', 'reframe', '--input', media, '--aspect', '9:16',
        '--mode', 'crop', '--plan', 'not json', '--output', path.join(tmp, 'tall.mp4')]);
      expect(plan.status).toBe(1);
      const planError = parseJson(plan.stderr);
      expect(planError.message).toContain('--plan is not valid JSON');
      expect(planError.message).not.toContain('voice/1.mp3');

      const missing = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', 'project/media/nothing-here.mp4']);
      expect(missing.status).toBe(1);
      const missingError = parseJson(missing.stderr);
      expect(missingError).toMatchObject({ code: 'E_INPUT' });
      expect(missingError.message).toContain('input is not a file');
      expect(missingError.message).toContain(`Paths are read from ${path.dirname(pcDir())}`);
      expect(missingError.message).toContain('check the name with ls and run it again');

      // 2026-11-16 baseline: an op the call did not read was ignored, so reframe with a range
      // reframed the whole podcast and the Agent stopped; a missing transcript, then an op tried
      // as a script name, read as "the cleanup tool is missing".
      const ranged = runSkill('stage-edit', 'edit_video', ['--op', 'reframe', '--input', media, '--start', '10.7',
        '--duration', '11.5', '--aspect', '9:16', '--output', path.join(tmp, 'tall-range.mp4')]);
      expect(ranged.status).toBe(1);
      expect(parseJson(ranged.stderr)).toMatchObject({ code: 'E_ARGS', message: 'reframe does not take --start or --duration: it works on the whole input. Cut the part you want with --op trim first, then run reframe on that file.' });
      const startOnly = parseJson(runSkill('stage-edit', 'edit_video', ['--op', 'burnsubs', '--input', media, '--start', '2',
        '--subtitles', 'x.srt', '--output', path.join(tmp, 'subs.mp4')]).stderr);
      expect(startOnly.message).toBe('burnsubs does not take --start: it works on the whole input. Cut the part you want with --op trim first, then run burnsubs on that file.');
      for (const op of ['extract_frame', 'mix']) {
        const frame = parseJson(runSkill('stage-edit', 'edit_video', ['--op', op, '--input', media, '--start', '1',
          '--duration', '2', '--output', path.join(tmp, `${op}.png`)]).stderr);
        expect(frame.message).toBe(`${op} takes --start but not --duration.`);
      }
      const trimmed = lastJson(runSkill('stage-edit', 'edit_video', ['--op', 'trim', '--input', media, '--start', '1',
        '--duration', '2', '--output', path.join(tmp, 'cut.mp4')]).stderr);
      expect(trimmed.message).not.toContain('does not take');

      const fillers = runSkill('stage-edit', 'edit_video', ['--op', 'remove_fillers', '--input', media, '--fillers', '嗯,呃',
        '--output', path.join(tmp, 'clean.mp4')]);
      expect(fillers.status).toBe(1);
      expect(parseJson(fillers.stderr).message).toBe('remove_fillers requires --transcript: the video_studio speech.transcribe JSON for this input, made with timestamps "word". Pass its transcript_path and run it again.');
      const asScript = runSkill('stage-edit', 'remove_fillers', ['--input', media]);
      expect(asScript.status).toBe(66);
      expect(parseJson(asScript.stderr)).toMatchObject({
        error: expect.stringContaining('skill script not found: stage-edit/remove_fillers'),
        hint: 'stage-edit has these scripts: analyze_media, cut_selection, edit_video. Pass one of these as the script name and its options after --.',
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!fs.existsSync(realFfmpeg))('lists a track\'s beats and says which cuts of a montage miss them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-beats-'));
    try {
      const ffprobe = path.join(realFfmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const env = { ORKAS_BUNDLED_FFMPEG: realFfmpeg, ORKAS_BUNDLED_FFPROBE: ffprobe };
      const B = 0.46875; // 128 BPM
      const music = path.join(tmp, 'music.wav');
      const made = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        `aevalsrc='0.8*sin(2*PI*60*mod(t\\,${B}))*exp(-mod(t\\,${B})*18)+0.15*sin(2*PI*(220+110*floor(mod(t/(4*${B})\\,2)))*t)':s=44100:d=16`, music], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const listed = runSkill('stage-edit', 'analyze_media', ['--op', 'beats', '--input', music, '--fps', '30'], env);
      expect(listed.status, listed.stderr).toBe(0);
      const beats = lastJson(listed.stdout).summary;
      expect(beats).toMatchObject({ steady: true, fps: 30 });
      expect(beats.bpm).toBeCloseTo(128, 0);
      expect(beats.beats[0]).toEqual({ t: expect.any(Number), frame: Math.round(beats.beats[0].t * 30), strength: expect.any(Number) });

      // A montage that changes colour on every bar, then the same cut three frames late.
      const montage = (shift: number, name: string): string => {
        const colors = ['red', 'blue', 'green', 'yellow', 'white', 'purple', 'orange', 'cyan'];
        const edges = [0, ...[1, 2, 3, 4, 5, 6, 7].map((k) => Math.round(k * 4 * B * 30) + shift), 480];
        const inputs = colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=160x90:r=30`]);
        const chains = colors.map((_, i) => `[${i}:v]trim=end_frame=${edges[i + 1] - edges[i]},setpts=PTS-STARTPTS[v${i}]`);
        const out = path.join(tmp, name);
        const r = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-i', music,
          '-filter_complex', `${chains.join(';')};${colors.map((_, i) => `[v${i}]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`,
          '-map', '[v]', '-map', `${colors.length}:a`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        return out;
      };
      const onBeat = lastJson(runSkill('stage-edit', 'analyze_media', ['--op', 'beats', '--input', montage(0, 'on.mp4')], env).stdout).summary;
      expect(onBeat.cuts.count).toBeGreaterThan(3);
      expect(onBeat.cuts.off_beat).toBe(0);
      const late = lastJson(runSkill('stage-edit', 'analyze_media', ['--op', 'beats', '--input', montage(3, 'late.mp4')], env).stdout).summary;
      expect(late.cuts.off_beat).toBe(late.cuts.count);
      expect(late.cuts.list.every((c: any) => c.offset_frames >= 2)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('exposes edit_video through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('trim');
    expect(out.ops).toContain('mix');
    expect(out.ops).toContain('normalize_loudness');
    expect(out.ops).toContain('reframe');
  });

  // 2026-11-17 benchmark: six ~4s guesthouse clips were cut with --start at their places in the
  // music (0.6, 3.0, 5.4s ...). A start 3.005s into a 4s clip returned a 0.97s piece as a plain
  // success, the join came out 12.5s instead of 14.4s and its cuts left the beat.
  describe('trim reports the length it actually cut', () => {
    const binDir = path.join(pcDir(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
    const extension = process.platform === 'win32' ? '.exe' : '';
    const bundled = { ffmpeg: path.join(binDir, `ffmpeg${extension}`), ffprobe: path.join(binDir, `ffprobe${extension}`) };
    const env = { ORKAS_BUNDLED_FFMPEG: bundled.ffmpeg, ORKAS_BUNDLED_FFPROBE: bundled.ffprobe };
    const pictureFrames = (file: string) => Number(spawnSync(bundled.ffprobe, ['-v', 'error', '-count_frames',
      '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());

    function withFourSecondClip(body: (clip: string, tmp: string) => void) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-trim-length-'));
      try {
        const clip = path.join(tmp, 'room.mp4');
        const made = spawnSync(bundled.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
          '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip], { encoding: 'utf8', timeout: 20_000 });
        expect(made.status, made.stderr || String(made.error || '')).toBe(0);
        body(clip, tmp);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const trim = (clip: string, out: string, start: string, duration: string) => {
      const res = runSkill('stage-edit', 'edit_video', ['--op', 'trim', '--input', clip, '--start', start,
        '--duration', duration, '--output', out], env);
      expect(res.status, res.stderr).toBe(0);
      return lastJson(res.stdout);
    };

    it.skipIf(!fs.existsSync(bundled.ffmpeg))('says so when the clip ends before the requested length', () => {
      withFourSecondClip((clip, tmp) => {
        const out = path.join(tmp, 'short.mp4');
        const result = trim(clip, out, '3.005', '2.4');
        expect(result).toMatchObject({ ok: true, op: 'trim', path: out });
        // 4 − 3.005 leaves at most 0.995s: 29 or 30 frames, never the 72 asked for.
        expect(pictureFrames(out)).toBeLessThanOrEqual(30);
        expect(result.duration_sec).toBeGreaterThan(0.9);
        expect(result.duration_sec).toBeLessThan(1);
        expect(result.warning).toMatch(/The input is 4\.0\ds long, so from 3\.005s this cut is 0\.9\ds/);
        expect(result.warning).toContain('not the 2.40s asked for');
        expect(result.warning).toContain('--start is a time inside the input');
        expect(result.warning).toMatch(/start at or before 1\.6\ds for the full length/);
        expect(result.text).toContain(result.warning);
      });
    }, 60_000);

    it.skipIf(!fs.existsSync(bundled.ffmpeg))('reports the full length and no warning when the clip holds it', () => {
      withFourSecondClip((clip, tmp) => {
        const out = path.join(tmp, 'fits.mp4');
        const result = trim(clip, out, '1.6', '2.4');
        expect(pictureFrames(out)).toBe(72);
        expect(result.duration_sec).toBeCloseTo(2.4, 2);
        expect(result.warning).toBeUndefined();
      });
    }, 60_000);

    it.skipIf(!fs.existsSync(bundled.ffmpeg))('says the clip itself is too short when no start would give the length', () => {
      withFourSecondClip((clip, tmp) => {
        const result = trim(clip, path.join(tmp, 'whole.mp4'), '0', '5');
        expect(result.duration_sec).toBeCloseTo(4, 1);
        expect(result.warning).toMatch(/The input is only 4\.0\ds long/);
        expect(result.warning).toContain('not the 5.00s asked for');
        expect(result.warning).not.toContain('start at or before');
      });
    }, 60_000);
  });

  it('extracts a real video frame without a Python or uv recognition runtime', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-frame-reading-'));
    try {
      const binDir = path.join(pcDir(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
      const extension = process.platform === 'win32' ? '.exe' : '';
      const ffmpeg = path.join(binDir, `ffmpeg${extension}`);
      const input = path.join(tmp, 'source.mp4');
      const frame = path.join(tmp, 'frame.png');
      const generated = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=red:s=64x64:r=5:d=2', '-an', '-c:v', 'libx264', input,
      ], { encoding: 'utf8', timeout: 20_000 });
      expect(generated.status, generated.stderr || String(generated.error || '')).toBe(0);
      expect(generated.stderr).toBe('');
      const res = runSkill('stage-edit', 'edit_video', [
        '--op', 'extract_frame', '--input', input, '--start', '1', '--output', frame,
      ], {
        ORKAS_BUNDLED_FFMPEG: ffmpeg,
        ORKAS_BUNDLED_FFPROBE: path.join(binDir, `ffprobe${extension}`),
        ORKAS_PYTHON: path.join(tmp, 'missing-python'),
        ORKAS_UV: path.join(tmp, 'missing-uv'),
      });
      expect(res.status, res.stderr).toBe(0);
      expect(parseJson(res.stdout)).toMatchObject({ ok: true, op: 'extract_frame' });
      const progress = res.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      for (const item of progress) expect(item).toMatchObject({ type: 'progress', source: 'video_edit' });
      const { Jimp } = await import('jimp');
      const image = await Jimp.read(frame);
      expect([image.width, image.height]).toEqual([64, 64]);
      const rgba = image.getPixelColor(32, 32);
      expect((rgba >>> 24) & 255).toBeGreaterThan(240);
      expect((rgba >>> 16) & 255).toBeLessThan(10);
      expect((rgba >>> 8) & 255).toBeLessThan(10);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps edit_video stdout parseable while streaming progress JSONL on stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-progress-'));
    const input = path.join(tmp, 'input.mp4');
    const output = path.join(tmp, 'trimmed.mp4');
    fs.writeFileSync(input, 'fake input', 'utf8');

    const res = runSkill('stage-edit', 'edit_video', [
      '--op', 'trim',
      '--input', input,
      '--output', output,
      '--start', '0',
      '--duration', '2',
    ], makeFakeFfmpegEnv(tmp));

    expect(res.status, res.stderr).toBe(0);
    expect(parseJson(res.stdout)).toMatchObject({ ok: true, op: 'trim' });
    const progress = res.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress', source: 'video_edit', op: 'trim', status: 'running' }),
      expect.objectContaining({ type: 'progress', source: 'video_edit', op: 'trim', status: 'completed', percent: 100 }),
    ]));
  });

  it('fails edit_video before invoking ffmpeg when an input is missing', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', 'missing.mp4']);
    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('E_INPUT');
  });

  it('reframes a landscape clip onto a vertical canvas through the stage-edit runner', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reframe-runner-'));
    try {
      const binDir = path.join(pcDir(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
      const extension = process.platform === 'win32' ? '.exe' : '';
      const ffmpeg = path.join(binDir, `ffmpeg${extension}`);
      const ffprobe = path.join(binDir, `ffprobe${extension}`);
      const input = path.join(tmp, 'landscape.mp4');
      const output = path.join(tmp, 'vertical.mp4');
      const generated = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=red:s=128x72:r=5:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
      ], { encoding: 'utf8', timeout: 20_000 });
      expect(generated.status, generated.stderr || String(generated.error || '')).toBe(0);
      const env = { ORKAS_BUNDLED_FFMPEG: ffmpeg, ORKAS_BUNDLED_FFPROBE: ffprobe };

      const missingAspect = runSkill('stage-edit', 'edit_video', ['--op', 'reframe', '--input', input, '--output', output], env);
      expect(missingAspect.status).toBe(1);
      expect(parseJson(missingAspect.stderr)).toMatchObject({ code: 'E_ARGS' });
      const badMode = runSkill('stage-edit', 'edit_video', [
        '--op', 'reframe', '--input', input, '--aspect', '9:16', '--mode', 'zoom', '--output', output,
      ], env);
      expect(badMode.status).toBe(1);
      expect(parseJson(badMode.stderr).message).toBe('reframe --mode must be one of: pad, crop, blur');
      expect(fs.existsSync(output)).toBe(false);

      const res = runSkill('stage-edit', 'edit_video', [
        '--op', 'reframe', '--input', input, '--width', '72', '--height', '128', '--mode', 'blur', '--output', output,
      ], env);
      expect(res.status, res.stderr).toBe(0);
      expect(parseJson(res.stdout)).toMatchObject({
        ok: true,
        op: 'reframe',
        path: output,
        reframe: { mode: 'blur', canvas: '72x128', from: '128x72' },
        text: `reframe wrote ${output} at 72x128 (blur).`,
      });
      const probed = spawnSync(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output,
      ], { encoding: 'utf8' });
      expect(probed.stdout.trim()).toBe('72,128');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
