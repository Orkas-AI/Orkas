import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function pcDir() {
  return fs.existsSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'))
    ? process.cwd()
    : path.resolve(process.cwd(), 'PC');
}

function skillDir(skillId: 'stage-edit' | 'stage-plan' | 'stage-compose') {
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
  skillId: 'stage-edit' | 'stage-compose',
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const dir = pcDir();
  const workspaceRoot = path.join(os.tmpdir(), 'orkas-video-skill-workspace');
  return spawnSync(
    process.execPath,
    [path.join(dir, 'bin', 'run-skill.cjs'), skillId, script, '--', ...args],
    {
      cwd: path.dirname(dir),
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_PC_DIR: dir,
        ORKAS_RUN_SKILL_DIR: skillDir(skillId),
        ORKAS_WORKSPACE_ROOT: workspaceRoot,
        ...extraEnv,
      },
    },
  );
}

function parseJson(text: string) {
  return JSON.parse(text.trim());
}

function makeFakeFfmpegEnv(tmp: string) {
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
  it('keeps VideoStudio media logic local to skill scripts', () => {
    const files = [
      path.join(skillDir('stage-edit'), 'scripts', 'analyze_media.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'edit_video.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_analyze_core.cjs'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_edit_core.cjs'),
      path.join(skillDir('stage-plan'), 'scripts', 'video_plan.js'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_decide_core.cjs'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_edl_core.cjs'),
      path.join(skillDir('stage-compose'), 'scripts', 'render_composition.js'),
      path.join(skillDir('stage-compose'), 'scripts', 'lib', 'video_render_core.cjs'),
    ];
    const forbidden = [
      /\bpcRequire\b/,
      /src\/main\/features/,
      /src\/main\/util\/uniquify/,
      /electron-log/,
      /node_modules\/electron/,
      /require\(["']electron["']\)/,
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
    ]) {
      expect(fs.existsSync(file), `${file} should not exist`).toBe(false);
    }
  });

  it('exposes analyze_media through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'analyze_media', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('transcribe');
    expect(out.ops).toContain('quality');
  });

  it('exposes edit_video through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('trim');
    expect(out.ops).toContain('mix');
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

  it('exposes render_composition through the stage-compose skill runner', () => {
    const res = runSkill('stage-compose', 'render_composition', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('inspect');
    expect(out.ops).toContain('render');
  });

  it('fails edit_video before invoking ffmpeg when an input is missing', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', 'missing.mp4']);
    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('E_INPUT');
  });

  it('fails render_composition before invoking HyperFrames when the directory is missing', () => {
    const res = runSkill('stage-compose', 'render_composition', ['--op', 'inspect', '--composition-dir', 'missing-composition']);
    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('E_INPUT');
  });
});
