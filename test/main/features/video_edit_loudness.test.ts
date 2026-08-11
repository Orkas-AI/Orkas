import { describe, expect, it } from 'vitest';

import { parseEbur128Summary } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

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
