import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function validPlan() {
  return {
    aspect: '9:16',
    total_target_sec: 20,
    language: 'zh',
    delivery_promise: { type: 'hybrid', source_required: true, motion_min_ratio: 0.5 },
    segments: [
      { id: 'hook', order: 1, role: 'hook', layer: 'primary', source: 'edit', target_sec: 12, spec: { input_id: 'clipA', in_sec: 4, out_sec: 16 } },
      { id: 'body', order: 2, role: 'body', layer: 'primary', source: 'compose', target_sec: 8, spec: { kind: 'stat-card' } },
    ],
    tracks: {
      narration: {
        voice: 'zh_male_jieshuoxiaoming_uranus_bigtts',
        segments: [{ text: 'hi', start_sec: 0, target_sec: 4 }],
      },
    },
    cost_estimate: { billable_generations: 0 },
  };
}

function makeProject(plan: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-plan-script-'));
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project', 'plan.json'), `${JSON.stringify(plan)}\n`, 'utf8');
  return dir;
}

function makeFakeProbeEnv(cwd: string, durations: Record<string, number>) {
  const binDir = path.join(cwd, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const durationsPath = path.join(binDir, 'durations.json');
  fs.writeFileSync(durationsPath, `${JSON.stringify(durations)}\n`, 'utf8');

  const ffprobePath = path.join(binDir, 'ffprobe');
  fs.writeFileSync(ffprobePath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const map = JSON.parse(fs.readFileSync(process.env.FAKE_FFPROBE_DURATIONS, 'utf8'));",
    'const input = path.resolve(process.cwd(), process.argv[process.argv.length - 1]);',
    'const value = map[input] ?? map[path.basename(input)];',
    'if (value === undefined) process.exit(2);',
    'process.stdout.write(String(value));',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffprobePath, 0o755);

  const ffmpegPath = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ffmpegPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(ffmpegPath, 0o755);

  return {
    ORKAS_BUNDLED_FFMPEG: ffmpegPath,
    ORKAS_BUNDLED_FFPROBE: ffprobePath,
    FAKE_FFPROBE_DURATIONS: durationsPath,
  };
}

function runVideoPlan(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const pcDir = fs.existsSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'))
    ? process.cwd()
    : path.resolve(process.cwd(), 'PC');
  const skillDir = path.join(pcDir, 'resources', 'builtin', 'marketplace', 'agents', '79df9cc89f5f', 'skills', 'stage-plan');
  return spawnSync(
    TEST_NODE,
    [path.join(pcDir, 'bin', 'run-skill.cjs'), 'stage-plan', 'video_plan', '--', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_PC_DIR: pcDir,
        ORKAS_RUN_SKILL_DIR: skillDir,
        ORKAS_WORKSPACE_ROOT: cwd,
        ...extraEnv,
      },
    },
  );
}

function parseJsonOutput(text: string) {
  return JSON.parse(text.trim());
}

describe('stage-plan video_plan skill script', () => {
  it('validates a well-formed EDL through run-skill', () => {
    const cwd = makeProject(validPlan());
    const res = runVideoPlan(cwd, ['--op', 'validate', '--plan', 'project/plan.json']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonOutput(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.valid).toBe(true);
    expect(out.text).toContain('plan VALID');
  });

  it('keeps legacy empty tracks executable and reports them as disabled', () => {
    const plan = validPlan() as any;
    plan.tracks = {
      narration: { voice: null, segments: [] },
      music: {},
      captions: { lines: [] },
    };
    const cwd = makeProject(plan);
    const res = runVideoPlan(cwd, ['--op', 'validate', '--plan', 'project/plan.json']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJsonOutput(res.stdout);
    expect(out.valid).toBe(true);
    expect(out.warnings.map((warning: { code: string }) => warning.code)).toEqual(
      expect.arrayContaining(['W_EMPTY_TRACK_DISABLED', 'W_CAPTIONS_EMPTY']),
    );
  });

  it('returns a non-zero exit for an invalid EDL', () => {
    const cwd = makeProject({ segments: [] });
    const res = runVideoPlan(cwd, ['--op', 'validate', '--plan', 'project/plan.json']);
    expect(res.status).toBe(1);
    const out = parseJsonOutput(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.valid).toBe(false);
    expect(out.errors.map((e: { code: string }) => e.code)).toContain('E_ASPECT_MISSING');
  });

  it('returns a non-zero exit when the delivery promise fails', () => {
    const plan = validPlan();
    plan.segments[0].target_sec = 2;
    plan.segments[1].target_sec = 18;
    const cwd = makeProject(plan);
    const res = runVideoPlan(cwd, ['--op', 'promise_check', '--plan', 'project/plan.json']);
    expect(res.status).toBe(1);
    const out = parseJsonOutput(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.assessment.verdict).toBe('fail');
  });

  it('can gate-D check the real produced durations instead of the planned target_sec', () => {
    const plan = validPlan() as any;
    plan.segments[0].target_sec = 14; // planned motion ratio passes: 70%
    plan.segments[1].target_sec = 6;
    plan.segments[0].produced_path = 'project/cuts/hook.mp4';
    plan.segments[1].produced_path = 'project/cuts/body.mp4';

    const cwd = makeProject(plan);
    fs.mkdirSync(path.join(cwd, 'project', 'cuts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'project', 'cuts', 'hook.mp4'), '');
    fs.writeFileSync(path.join(cwd, 'project', 'cuts', 'body.mp4'), '');

    const env = makeFakeProbeEnv(cwd, {
      'hook.mp4': 2,
      'body.mp4': 18,
    });

    const planned = runVideoPlan(cwd, ['--op', 'promise_check', '--plan', 'project/plan.json'], env);
    expect(planned.status, planned.stderr).toBe(0);

    const probed = runVideoPlan(cwd, ['--op', 'promise_check', '--plan', 'project/plan.json', '--probe-produced'], env);
    expect(probed.status).toBe(1);
    const out = parseJsonOutput(probed.stderr);
    expect(out.ok).toBe(false);
    expect(out.assessment.motion_ratio).toBe(0.1);
    expect(out.assessment.verdict).toBe('fail');
    expect(out.produced_sec).toEqual({ hook: 2, body: 18 });
    expect(out.text).toContain('using produced_path durations');
  });
});
