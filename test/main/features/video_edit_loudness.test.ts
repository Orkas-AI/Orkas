import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { editVideo, loudnormMeasuredOptions, normalizeLoudnessAudioFilter, parseEbur128Summary } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

// A realistic ffmpeg `ebur128=peak=true` stderr Summary block.
const NORMAL = `
[Parsed_ebur128_0 @ 0x7f8] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.7 LUFS

  Loudness range:
    LRA:         6.4 LU
    Threshold: -34.8 LUFS
    LRA low:   -19.2 LUFS
    LRA high:  -12.8 LUFS

  True peak:
    Peak:       -1.4 dBFS
`;

// A silent source: ffmpeg prints -inf for integrated loudness and true peak.
const SILENT = `
[Parsed_ebur128_0 @ 0x7f8] Summary:

  Integrated loudness:
    I:         -inf LUFS
    Threshold: -inf LUFS

  Loudness range:
    LRA:         0.0 LU

  True peak:
    Peak:       -inf dBFS
`;

// What ffmpeg actually writes: a running log line every 100ms, THEN the
// summary. Captured from the 2026-08-10 delivery (real values -13.8 / 4.4 /
// -2.5). The running lines carry their own `I:` and `LRA:`, and the first ones
// always read -70.0 LUFS / 0.0 LU because nothing has been integrated yet.
const WITH_RUNNING_LOG = `
[Parsed_ebur128_0 @ 0x600001b0c0b0] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -38.9 -38.9 dBFS  TPK: -38.9 -38.9 dBFS
[Parsed_ebur128_0 @ 0x600001b0c0b0] t: 0.199979   TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -43.1 -43.1 dBFS  TPK: -38.9 -38.9 dBFS
[Parsed_ebur128_0 @ 0x600001b0c0b0] t: 59.996     TARGET:-23 LUFS    M: -12.2 S: -12.8     I: -13.8 LUFS       LRA:   4.4 LU  FTPK:  -3.3  -3.4 dBFS  TPK:  -2.5  -2.5 dBFS
[Parsed_ebur128_0 @ 0x600001b0c0b0] Summary:

  Integrated loudness:
    I:         -13.8 LUFS
    Threshold: -24.2 LUFS

  Loudness range:
    LRA:         4.4 LU
    Threshold: -34.7 LUFS
    LRA low:   -17.2 LUFS
    LRA high:  -12.8 LUFS

  True peak:
    Peak:       -2.5 dBFS
`;

describe('parseEbur128Summary', () => {
  it('reads the summary, not the running log that precedes it', () => {
    // The delivered video measured -13.8 LUFS. Reported as -70 LUFS / 0 LU,
    // the assembly chain's closing loudness check compares a constant.
    expect(parseEbur128Summary(WITH_RUNNING_LOG)).toEqual({
      integratedLufs: -13.8,
      loudnessRangeLu: 4.4,
      truePeakDbfs: -2.5,
    });
  });

  it('fails closed when the running log is all there is (no summary)', () => {
    // An aborted or still-running measurement has frame lines and no summary.
    // Their -70.0/0.0 is the gate floor, not a measurement, and must not be
    // returned as one.
    const runningOnly = WITH_RUNNING_LOG.slice(0, WITH_RUNNING_LOG.indexOf('Summary:'));
    expect(runningOnly).toContain('I: -70.0 LUFS');
    expect(parseEbur128Summary(runningOnly)).toBeNull();
  });

  it('extracts integrated LUFS, range, and true-peak from a normal summary', () => {
    expect(parseEbur128Summary(NORMAL)).toEqual({
      integratedLufs: -14.2,
      loudnessRangeLu: 6.4,
      truePeakDbfs: -1.4,
    });
  });

  it('does not confuse the Threshold LUFS line with the integrated I: line', () => {
    // Threshold is -24.7 LUFS; the integrated I: is -14.2. Must pick I:.
    expect(parseEbur128Summary(NORMAL)!.integratedLufs).toBe(-14.2);
  });

  it('maps -inf (silent source) to null rather than a bogus number', () => {
    expect(parseEbur128Summary(SILENT)).toEqual({
      integratedLufs: null,
      loudnessRangeLu: 0,
      truePeakDbfs: null,
    });
  });

  it('returns null when there is no integrated line (not a loudness summary)', () => {
    expect(parseEbur128Summary('ffmpeg version 6.0\nsome unrelated stderr')).toBeNull();
    expect(parseEbur128Summary('')).toBeNull();
  });

  it('tolerates a positive true peak (clipping past 0 dBFS)', () => {
    const clipping = NORMAL.replace('Peak:       -1.4 dBFS', 'Peak:        0.8 dBFS');
    expect(parseEbur128Summary(clipping)!.truePeakDbfs).toBe(0.8);
  });
});

// 2026-11-17 benchmark: delivery told the Agent to run normalize_loudness on a -18.4 LUFS ad, and
// one loudnorm pass left it at -16.6, still outside the delivery's 2 LU, so the advice could not
// be followed to the end. normalize_loudness now measures first and applies that measurement.
describe('normalize_loudness reaches the delivery loudness', () => {
  const { ffmpeg } = bundledFfmpegPaths();

  it('turns a loudnorm measurement into second-pass options, and refuses an incomplete one', () => {
    const measured = '{"input_i":"-28.25","input_tp":"-6.16","input_lra":"11.00","input_thresh":"-38.57","target_offset":"4.43"}';
    expect(loudnormMeasuredOptions(`[Parsed_loudnorm_0 @ 0x1]\n${measured}\n`)).toBe('measured_I=-28.25:measured_TP=-6.16:measured_LRA=11:measured_thresh=-38.57:offset=4.43:linear=true');
    expect(loudnormMeasuredOptions('{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70.00","target_offset":"0.00"}')).toBeNull();
    expect(loudnormMeasuredOptions('no json here')).toBeNull();
    expect(normalizeLoudnessAudioFilter('measured_I=-28.25:linear=true')).toMatch(/^loudnorm=I=-14:TP=-1:LRA=11:measured_I=-28\.25:linear=true,aresample=/);
    expect(normalizeLoudnessAudioFilter()).toMatch(/^loudnorm=I=-14:TP=-1:LRA=11,aresample=/);
  });

  it.skipIf(!ffmpeg)('brings a quiet music bed under a short voice within 2 LU of -14 LUFS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-normalize-'));
    try {
      const input = path.join(dir, 'quiet.mp4');
      const made = spawnSync(ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:a=0.03:seed=7',
        '-f', 'lavfi', '-i', 'sine=f=300:d=2.5,volume=0.35,tremolo=f=5:d=0.8',
        '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=20',
        '-filter_complex', '[1:a]adelay=300|300,apad[v];[0:a][v]amix=inputs=2:duration=first:normalize=0,aformat=channel_layouts=stereo[a]',
        '-map', '2:v', '-map', '[a]', '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const output = path.join(dir, 'normalized.mp4');
      const result: any = await editVideo({ op: 'normalize_loudness', inputAbsPath: input, outputAbsPath: output });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // Measured independently of the op, as delivery measures it.
      const summary = spawnSync(ffmpeg!, ['-hide_banner', '-nostats', '-i', output, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
      const integrated = parseEbur128Summary(summary.stderr)!.integratedLufs!;
      expect(Math.abs(integrated + 14)).toBeLessThanOrEqual(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
