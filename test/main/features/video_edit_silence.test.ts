import { describe, expect, it } from 'vitest';

import {
  parseSilenceDetect,
  assessVoiceoverCoverage,
  mapWithConcurrencyLimit,
  parseFfmpegProgressTimeSec,
  validateTrimRequest,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

// The exact shape ffmpeg `silencedetect` prints for the broken draft that
// shipped: speech to ~16.81s, then a silent tail to EOF on a 23.9s clip.
const DRAFT_TAIL = `
[silencedetect @ 0x12ee17150] silence_start: 16.808812
[silencedetect @ 0x12ee17150] silence_end: 23.905333 | silence_duration: 7.096521
`;

// Leading + a mid/trailing silence on a 12s clip.
const LEAD_AND_TAIL = `
[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5
[silencedetect @ 0x1] silence_start: 10
[silencedetect @ 0x1] silence_end: 12 | silence_duration: 2
`;

describe('parseSilenceDetect', () => {
  it('finds the trailing silent tail that the broken draft shipped', () => {
    const t = parseSilenceDetect(DRAFT_TAIL, 23.9);
    expect(t.leadingSilenceSec).toBe(0);
    expect(t.trailingSilenceSec).toBeCloseTo(7.09, 1);
    expect(t.voicedStartSec).toBe(0);
    expect(t.voicedEndSec).toBeCloseTo(16.81, 1);
    expect(t.silences).toHaveLength(1);
  });

  it('separates leading from trailing silence and the voiced span between', () => {
    const t = parseSilenceDetect(LEAD_AND_TAIL, 12);
    expect(t.leadingSilenceSec).toBe(1.5);
    expect(t.trailingSilenceSec).toBe(2);
    expect(t.voicedStartSec).toBe(1.5);
    expect(t.voicedEndSec).toBe(10);
    expect(t.voicedDurationSec).toBeCloseTo(8.5, 5); // 12 - 1.5 - 2
  });

  it('treats no silence events as fully voiced', () => {
    const t = parseSilenceDetect('Duration: 00:00:16.25\nsome unrelated stderr', 16.25);
    expect(t.silences).toHaveLength(0);
    expect(t.leadingSilenceSec).toBe(0);
    expect(t.trailingSilenceSec).toBe(0);
    expect(t.voicedStartSec).toBe(0);
    expect(t.voicedEndSec).toBe(16.25);
  });

  it('closes a trailing silence_start that has no matching end (runs to EOF)', () => {
    const t = parseSilenceDetect('silence_start: 8', 10);
    expect(t.silences).toEqual([{ startSec: 8, endSec: 10 }]);
    expect(t.trailingSilenceSec).toBe(2);
    expect(t.voicedEndSec).toBe(8);
  });

  it('reports a fully silent file as a zero-length voiced span', () => {
    const fully = 'silence_start: 0\nsilence_end: 5 | silence_duration: 5';
    const t = parseSilenceDetect(fully, 5);
    expect(t.voicedDurationSec).toBe(0);
    expect(t.voicedStartSec).toBe(t.voicedEndSec); // no voiced span
  });
});

describe('assessVoiceoverCoverage', () => {
  it('flags the silent tail the loudness check could not see (the draft bug)', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 23.9, offsetSec: 0, audioDurationSec: 16.25,
      voicedStartSec: 0, voicedEndSec: 16.25,
    });
    expect(cv.status).toBe('under');
    expect(cv.trailingGapSec).toBeCloseTo(7.65, 2);
    expect(cv.overshootSec).toBeLessThan(0);
    expect(cv.warnings.join(' ')).toMatch(/silent tail|uncovered/i);
  });

  it('flags overshoot (narration longer than the clip → truncated)', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 10, offsetSec: 0, audioDurationSec: 14,
      voicedStartSec: 0, voicedEndSec: 13.5,
    });
    expect(cv.status).toBe('over');
    expect(cv.overshootSec).toBeCloseTo(4, 5);
    expect(cv.warnings.join(' ')).toMatch(/past the|truncated/i);
  });

  it('passes a narration that comfortably covers the clip', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 20, offsetSec: 0, audioDurationSec: 19.5,
      voicedStartSec: 0, voicedEndSec: 19.2,
    });
    expect(cv.status).toBe('ok');
    expect(cv.warnings).toHaveLength(0);
    expect(cv.coverageRatio).toBeGreaterThan(0.9);
  });

  it('reports a silent/near-silent mux instead of a bogus coverage number', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 20, offsetSec: 0, audioDurationSec: 0,
      voicedStartSec: 0, voicedEndSec: 0,
    });
    expect(cv.status).toBe('silent');
    expect(cv.warnings.join(' ')).toMatch(/no speech/i);
  });

  it('accounts for a lead-in offset when placing the voiced span on the timeline', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 20, offsetSec: 4, audioDurationSec: 10,
      voicedStartSec: 0, voicedEndSec: 10,
    });
    expect(cv.voicedStartSec).toBe(4);
    expect(cv.voicedEndSec).toBe(14);
    expect(cv.trailingGapSec).toBeCloseTo(6, 5); // 20 - 14
    expect(cv.warnings.join(' ')).toMatch(/silent tail|uncovered/i);
  });

  it('reports interior dead air instead of scoring how far the last line reached (the 95% lie)', () => {
    // The 2026-08-05 draft: seven lines pinned to scene starts on a 60 s cut,
    // 29.7 s of it silent in holes up to 6.9 s — and the old ratio still said
    // 0.95 because the last line ended at 56.8 s. The report has to carry the
    // holes, the honest voiced share, and a status QA can fail on.
    const lines: Array<[number, number]> = [
      [0, 3.52], [6.15, 10.55], [14.24, 19.41], [26.29, 31.97],
      [37.30, 42.16], [47.32, 51.56], [54.29, 56.78],
    ];
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 60.07,
      offsetSec: 0,
      audioDurationSec: 56.78,
      voicedStartSec: 0,
      voicedEndSec: 56.78,
      voicedSpans: lines.map(([startSec, endSec]) => ({ startSec, endSec })),
    });
    expect(cv.status).toBe('gapped');
    // The old number stays high — that is the point of keeping both.
    expect(cv.coverageRatio).toBeGreaterThan(0.9);
    expect(cv.voicedRatio).toBeLessThan(0.55);
    expect(cv.maxInteriorGapSec).toBeCloseTo(6.88, 1);
    expect(cv.interiorGaps.length).toBe(6);
    expect(cv.interiorGaps[0]).toMatchObject({ startSec: 19.41, endSec: 26.29 });
    expect(cv.warnings.join(' ')).toMatch(/dead air/i);
    expect(cv.warnings.join(' ')).toMatch(/music bed|re-time|shorten/i);
  });

  it('reports two lines speaking at once — the 2026-08-06 double-narration mix', () => {
    // The plan wrote target_sec as end times, every line's audio outran its
    // window, and three pairs collided (up to 1.48 s at n4→n5). Merged spans
    // hide a collision, so the raw spans are what the check reads.
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 40,
      offsetSec: 0,
      audioDurationSec: 43.46,
      voicedStartSec: 0,
      voicedEndSec: 43.46,
      voicedSpans: [
        { startSec: 0, endSec: 6.26 },
        { startSec: 11, endSec: 18.87 },
        { startSec: 20, endSec: 26.46 },
        { startSec: 26, endSec: 32.84 },
        { startSec: 32, endSec: 38.48 },
        { startSec: 37, endSec: 43.46 },
      ],
    });
    expect(cv.overlapCount).toBe(3);
    expect(cv.maxOverlapSec).toBeCloseTo(1.48, 2);
    // Truncation past the clip is destructive and keeps status priority; the
    // overlap still lands in the warnings with its own remediation.
    expect(cv.status).toBe('over');
    expect(cv.warnings.join(' ')).toMatch(/speak at once/i);
    expect(cv.warnings.join(' ')).toMatch(/DURATION, not its end time/);
  });

  it('flags overlap as the status when nothing is truncated', () => {
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 20,
      offsetSec: 0,
      audioDurationSec: 19,
      voicedStartSec: 0,
      voicedEndSec: 19,
      voicedSpans: [
        { startSec: 0, endSec: 9.5 },
        { startSec: 9, endSec: 19 },
      ],
    });
    expect(cv.status).toBe('overlapped');
    expect(cv.overlapCount).toBe(1);
  });

  it('does not call natural phrasing gaps dead air', () => {
    // Densely-timed lines with sub-threshold pauses must stay 'ok' — flagging
    // every breath would make the gapped status meaningless.
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 20,
      offsetSec: 0,
      audioDurationSec: 19.5,
      voicedStartSec: 0,
      voicedEndSec: 19.2,
      voicedSpans: [
        { startSec: 0, endSec: 4.8 }, { startSec: 5.6, endSec: 9.9 },
        { startSec: 10.9, endSec: 14.7 }, { startSec: 16.2, endSec: 19.2 },
      ],
    });
    expect(cv.status).toBe('ok');
    expect(cv.maxInteriorGapSec).toBeLessThanOrEqual(1.5);
    expect(cv.voicedRatio).toBeGreaterThan(0.75);
    expect(cv.warnings).toHaveLength(0);
  });

  it('keeps the legacy no-spans call shape working for single-file callers', () => {
    // trim_silence-style callers pass no spans; the report degrades to the
    // head/tail view without inventing interior data.
    const cv = assessVoiceoverCoverage({
      referenceDurationSec: 23.9, offsetSec: 0, audioDurationSec: 16.25,
      voicedStartSec: 0, voicedEndSec: 16.25,
    });
    expect(cv.status).toBe('under');
    expect(cv.interiorGaps).toEqual([]);
    expect(cv.maxInteriorGapSec).toBe(0);
    expect(cv.voicedRatio).toBeCloseTo(0.68, 2);
  });
});

describe('mapWithConcurrencyLimit', () => {
  it('keeps mix coverage probes under the requested concurrency while preserving order', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });
});

describe('parseFfmpegProgressTimeSec', () => {
  it('parses microsecond progress fields from ffmpeg -progress output', () => {
    expect(parseFfmpegProgressTimeSec({ out_time_us: '12340000' })).toBeCloseTo(12.34, 5);
    expect(parseFfmpegProgressTimeSec({ out_time_ms: '2500000' })).toBeCloseTo(2.5, 5);
  });

  it('falls back to clock progress output', () => {
    expect(parseFfmpegProgressTimeSec({ out_time: '00:01:02.500000' })).toBeCloseTo(62.5, 5);
  });

  it('ignores invalid progress timestamps', () => {
    expect(parseFfmpegProgressTimeSec({ out_time_us: '-1' })).toBeNull();
    expect(parseFfmpegProgressTimeSec({ out_time: 'not-a-clock' })).toBeNull();
  });
});

describe('validateTrimRequest', () => {
  it('rejects a trim that starts outside the known input duration', () => {
    const err = validateTrimRequest(10, 10.05, 1);
    expect(err).toMatchObject({ ok: false, errorCode: 'E_EDIT_TRIM_RANGE' });
  });

  it('rejects a near-zero trim request before ffmpeg can report a bogus success', () => {
    const err = validateTrimRequest(10, 2, 0.05);
    expect(err).toMatchObject({ ok: false, errorCode: 'E_EDIT_TRIM_RANGE' });
  });

  it('allows an overlong duration when the start can still produce a usable clip to EOF', () => {
    expect(validateTrimRequest(10, 8, 10)).toBeNull();
  });
});
