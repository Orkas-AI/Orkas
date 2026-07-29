import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  probeMediaDurationSec,
  probeMediaDurationWithRunner,
  runMediaProbeProcessForTest,
} from '../../../src/main/util/media_probe';

const prevFfprobe = process.env.ORKAS_BUNDLED_FFPROBE;
const fixtureDirs: string[] = [];

afterEach(() => {
  if (prevFfprobe === undefined) delete process.env.ORKAS_BUNDLED_FFPROBE;
  else process.env.ORKAS_BUNDLED_FFPROBE = prevFfprobe;
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeFfprobe(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffprobe-'));
  fixtureDirs.push(dir);
  const file = path.join(dir, 'ffprobe');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
  process.env.ORKAS_BUNDLED_FFPROBE = file;
  return file;
}

function windowsMediaFixture(durationSec: number): string {
  const runtimeDir = path.join(process.cwd(), 'resources', 'runtime', 'ffmpeg', `${process.platform}-${process.arch}`);
  const ffmpeg = path.join(runtimeDir, 'ffmpeg.exe');
  const ffprobe = path.join(runtimeDir, 'ffprobe.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-probe-win-'));
  fixtureDirs.push(dir);
  const input = path.join(dir, 'input.wav');
  const generated = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `anullsrc=r=8000:cl=mono:d=${durationSec}`,
    input,
  ], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(generated.stderr || 'failed to generate media probe fixture');
  process.env.ORKAS_BUNDLED_FFPROBE = ffprobe;
  return input;
}

describe('probeMediaDurationSec', () => {
  it('reads container duration from ffprobe', async () => {
    const input = process.platform === 'win32'
      ? windowsMediaFixture(1.25)
      : (fakeFfprobe("process.stdout.write('12.5\\n');"), '/tmp/input.mp3');
    const result = await probeMediaDurationSec(input);
    if (process.platform === 'win32') expect(result).toBeCloseTo(1.25, 2);
    else expect(result).toBe(12.5);
  });

  it('falls back to the first audio stream duration', async () => {
    const calls: string[][] = [];
    const runner = async (_bin: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: args.includes('stream=duration') ? '7.25\n' : 'N/A\n',
      };
    };
    await expect(probeMediaDurationWithRunner('ffprobe', 'C:\\media\\input.mp3', runner)).resolves.toBe(7.25);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('format=duration');
    expect(calls[1]).toContain('stream=duration');
  });

  it('settles promptly on abort without waiting for the child close event', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runMediaProbeProcessForTest(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();

    await expect(pending).resolves.toEqual({ code: -1, stdout: '' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.runIf(process.platform === 'win32')('kills a real Windows ffprobe-style process tree on timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-probe-tree-'));
    fixtureDirs.push(dir);
    const sentinel = path.join(dir, 'orphan-wrote.txt');
    const grandchildScript = [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'orphaned'), 700);`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');

    await expect(runMediaProbeProcessForTest(
      process.execPath,
      ['-e', parentScript],
      { timeoutMs: 75 },
    )).resolves.toEqual({ code: -1, stdout: '' });

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});
