import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function pcDir() {
  return process.cwd();
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
        ORKAS_WORKSPACE_ROOT: path.join(
          os.tmpdir(),
          `orkas-video-media-skill-${process.pid}`,
          'data',
        ),
        ...extraEnv,
      },
    },
  );
}

function parseJson(text: string) {
  return JSON.parse(text.trim());
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
      fs.readFileSync(path.join(skillDir('stage-plan'), 'SKILL.md'), 'utf8'),
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
      path.join(skillDir('stage-plan'), 'scripts', 'video_plan.js'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_decide_core.cjs'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_edl_core.cjs'),
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
    expect(parseJson(res.stderr).message).toBe('op must be one of: silence, scenes, quality');
  });

  it('exposes edit_video through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('trim');
    expect(out.ops).toContain('mix');
    expect(out.ops).toContain('normalize_loudness');
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

});
