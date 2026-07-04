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

describe('parseEbur128Summary', () => {
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
