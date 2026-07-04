import { describe, expect, it } from 'vitest';

import {
  mergeSpans,
  keepIntervalsFromRemovals,
  complementIntervals,
  fillerSpansFromWords,
  normalizeTranscriptWords,
  parseSceneChanges,
  buildKeepFilterComplex,
  decisionEvidence,
  parseQualityFrames,
  parseLabeledIntervals,
  summarizeQuality,
  textSimilarity,
  clusterTakes,
  rankTakes,
  DEFAULT_FILLERS,
  type Word,
  type Take,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_decide';

describe('mergeSpans', () => {
  it('merges overlapping and touching spans, drops invalid ones', () => {
    expect(
      mergeSpans([
        { startSec: 1, endSec: 3 },
        { startSec: 2.5, endSec: 4 },
        { startSec: 4, endSec: 5 },
        { startSec: 8, endSec: 7 }, // invalid (end<=start) → dropped
        { startSec: 10, endSec: 11 },
      ]),
    ).toEqual([
      { startSec: 1, endSec: 5 },
      { startSec: 10, endSec: 11 },
    ]);
  });
});

describe('keepIntervalsFromRemovals', () => {
  it('keeps the whole clip when there are no removals', () => {
    expect(keepIntervalsFromRemovals(10, [])).toEqual([{ startSec: 0, endSec: 10 }]);
  });

  it('keeps the complement of the silence, padded inward', () => {
    // 10s clip, silence 4–6s; padSec 0.1 shrinks removal to 4.1–5.9.
    const kept = keepIntervalsFromRemovals(10, [{ startSec: 4, endSec: 6 }], { padSec: 0.1, minKeepSec: 0.3 });
    expect(kept).toEqual([
      { startSec: 0, endSec: 4.1 },
      { startSec: 5.9, endSec: 10 },
    ]);
  });

  it('ignores removals shorter than minRemoveSec', () => {
    // a 0.4s "silence" with minRemove 0.5 → nothing removed → whole clip kept.
    expect(keepIntervalsFromRemovals(10, [{ startSec: 5, endSec: 5.4 }], { minRemoveSec: 0.5, padSec: 0 })).toEqual([
      { startSec: 0, endSec: 10 },
    ]);
  });

  it('drops kept slivers shorter than minKeepSec', () => {
    // removals at 1–2 and 2.1–4 leave a 0.1s sliver (2–2.1) that is dropped.
    const kept = keepIntervalsFromRemovals(10, [
      { startSec: 1, endSec: 2 },
      { startSec: 2.1, endSec: 4 },
    ], { padSec: 0, minKeepSec: 0.3 });
    expect(kept).toEqual([
      { startSec: 0, endSec: 1 },
      { startSec: 4, endSec: 10 },
    ]);
  });

  it('returns empty when an invalid duration is given', () => {
    expect(keepIntervalsFromRemovals(0, [{ startSec: 1, endSec: 2 }])).toEqual([]);
    expect(keepIntervalsFromRemovals(NaN, [])).toEqual([]);
  });
});

describe('complementIntervals', () => {
  it('returns the gaps between kept intervals (what a jump-cut drops)', () => {
    expect(complementIntervals([{ startSec: 0, endSec: 4.1 }, { startSec: 5.9, endSec: 10 }], 10)).toEqual([
      { startSec: 4.1, endSec: 5.9 },
    ]);
  });

  it('is empty when the kept set covers the whole clip', () => {
    expect(complementIntervals([{ startSec: 0, endSec: 10 }], 10)).toEqual([]);
  });

  it('returns the whole clip when nothing is kept', () => {
    expect(complementIntervals([], 10)).toEqual([{ startSec: 0, endSec: 10 }]);
  });

  it('is the inverse of keepIntervalsFromRemovals (round-trip → the removed spans)', () => {
    const kept = keepIntervalsFromRemovals(10, [{ startSec: 4, endSec: 6 }], { padSec: 0, minKeepSec: 0.3 });
    expect(complementIntervals(kept, 10)).toEqual([{ startSec: 4, endSec: 6 }]);
  });
});

describe('fillerSpansFromWords', () => {
  const words: Word[] = [
    { text: 'So', startSec: 0, endSec: 0.3 },
    { text: 'um', startSec: 0.3, endSec: 0.6 },
    { text: 'the', startSec: 0.6, endSec: 0.8 },
    { text: 'summary', startSec: 0.8, endSec: 1.4 }, // look-alike: must NOT match "um"
    { text: 'uh,', startSec: 1.4, endSec: 1.7 }, // punctuation stripped → matches "uh"
    { text: 'umbrella', startSec: 1.7, endSec: 2.3 }, // look-alike
  ];

  it('matches only exact filler tokens, not words that contain them', () => {
    const spans = fillerSpansFromWords(words, DEFAULT_FILLERS, { padSec: 0 });
    expect(spans).toEqual([
      { startSec: 0.3, endSec: 0.6 },
      { startSec: 1.4, endSec: 1.7 },
    ]);
  });

  it('pads matched spans and never goes below 0', () => {
    const spans = fillerSpansFromWords([{ text: 'um', startSec: 0.02, endSec: 0.5 }], DEFAULT_FILLERS, { padSec: 0.05 });
    expect(spans[0].startSec).toBe(0); // 0.02 - 0.05 clamped to 0
    expect(spans[0].endSec).toBeCloseTo(0.55, 5);
  });
});

describe('normalizeTranscriptWords', () => {
  it('reads a top-level words array (word/start/end)', () => {
    expect(
      normalizeTranscriptWords({ words: [{ word: 'hi', start: 0, end: 0.5 }, { word: 'there', start: 0.5, end: 1 }] }),
    ).toEqual([
      { text: 'hi', startSec: 0, endSec: 0.5 },
      { text: 'there', startSec: 0.5, endSec: 1 },
    ]);
  });

  it('reads a top-level array of {text,start,end} (the real hyperframes transcribe shape)', () => {
    // Verified against `npx hyperframes transcribe --json` output (small.en).
    expect(
      normalizeTranscriptWords([
        { text: 'So,', start: 0.12, end: 0.41 },
        { text: 'um,', start: 0.65, end: 0.93 },
        { text: 'answer.', start: 3.34, end: 3.77 },
      ]),
    ).toEqual([
      { text: 'So,', startSec: 0.12, endSec: 0.41 },
      { text: 'um,', startSec: 0.65, endSec: 0.93 },
      { text: 'answer.', startSec: 3.34, endSec: 3.77 },
    ]);
  });

  it('reads segments[].words (text/startSec/endSec)', () => {
    expect(
      normalizeTranscriptWords({ segments: [{ words: [{ text: 'a', startSec: 1, endSec: 1.2 }] }, { words: [{ text: 'b', startSec: 2, endSec: 2.3 }] }] }),
    ).toEqual([
      { text: 'a', startSec: 1, endSec: 1.2 },
      { text: 'b', startSec: 2, endSec: 2.3 },
    ]);
  });

  it('reads whisper-style offsets in milliseconds', () => {
    expect(normalizeTranscriptWords({ words: [{ text: 'x', offsets: { from: 1000, to: 1500 } }] })).toEqual([
      { text: 'x', startSec: 1, endSec: 1.5 },
    ]);
  });

  it('returns [] for shapes it does not understand and skips bad entries', () => {
    expect(normalizeTranscriptWords({ foo: 'bar' })).toEqual([]);
    expect(normalizeTranscriptWords(null)).toEqual([]);
    expect(normalizeTranscriptWords({ words: [{ word: 'x', start: 2, end: 1 }] })).toEqual([]); // end<=start
  });
});

describe('parseSceneChanges', () => {
  it('pairs pts_time with the following scene_score', () => {
    const log = [
      'frame:30 pts:30000 pts_time:1.0',
      'lavfi.scene_score=0.412',
      'frame:90 pts:90000 pts_time:3.0',
      'lavfi.scene_score=0.871',
    ].join('\n');
    expect(parseSceneChanges(log)).toEqual([
      { tSec: 1, score: 0.412 },
      { tSec: 3, score: 0.871 },
    ]);
  });

  it('returns [] when there are no scene changes', () => {
    expect(parseSceneChanges('frame:1 pts_time:0.0\n(no scores)\n')).toEqual([]);
  });
});

describe('buildKeepFilterComplex', () => {
  it('builds a select/aselect jump-cut over the kept intervals', () => {
    const { filter, maps } = buildKeepFilterComplex([
      { startSec: 0, endSec: 4.1 },
      { startSec: 5.9, endSec: 10 },
    ]);
    expect(filter).toContain("select='between(t,0.000,4.100)+between(t,5.900,10.000)'");
    expect(filter).toContain('aselect=');
    expect(filter).toContain('setpts=N/FRAME_RATE/TB');
    expect(maps).toEqual(['-map', '[v]', '-map', '[a]']);
  });

  it('throws when there is nothing to keep', () => {
    expect(() => buildKeepFilterComplex([])).toThrow(/nothing to keep|no intervals/i);
  });
});

describe('parseQualityFrames', () => {
  it('extracts per-frame blur + brightness from a metadata=print log', () => {
    const log = [
      'frame:0    pts:0      pts_time:0',
      'lavfi.blur=4.986',
      'lavfi.signalstats.YAVG=125.738',
      'frame:3    pts:3000   pts_time:0.333',
      'lavfi.blur=28.523',
      'lavfi.signalstats.YAVG=41.410',
    ].join('\n');
    expect(parseQualityFrames(log)).toEqual([
      { tSec: 0, blur: 4.986, brightness: 125.738 },
      { tSec: 0.333, blur: 28.523, brightness: 41.41 },
    ]);
  });
});

describe('parseLabeledIntervals', () => {
  it('parses blackdetect same-line start/end', () => {
    expect(parseLabeledIntervals('[blackdetect @ 0x1] black_start:1.0 black_end:2.0 black_duration:1.0', 'black')).toEqual([
      { startSec: 1, endSec: 2 },
    ]);
  });
  it('parses freezedetect metadata (= form, split lines)', () => {
    const log = 'lavfi.freezedetect.freeze_start=3\nframe:...\nlavfi.freezedetect.freeze_duration=1\nlavfi.freezedetect.freeze_end=4';
    expect(parseLabeledIntervals(log, 'freeze')).toEqual([{ startSec: 3, endSec: 4 }]);
  });
  it('returns [] when the label is absent', () => {
    expect(parseLabeledIntervals('nothing here', 'black')).toEqual([]);
  });
});

describe('summarizeQuality', () => {
  const frames = (blur: number, bri: number) => [
    { tSec: 0, blur, brightness: bri },
    { tSec: 0.3, blur, brightness: bri },
  ];

  it('a sharp, well-exposed clip has no flags and a perfect score', () => {
    const q = summarizeQuality({ durationSec: 10, frames: frames(5, 125) });
    expect(q.flags).toEqual([]);
    expect(q.score).toBe(1);
    expect(q.blur?.mean).toBe(5);
  });

  it('flags blur when the mean exceeds the threshold', () => {
    const q = summarizeQuality({ durationSec: 10, frames: frames(28, 125) });
    expect(q.flags).toContain('blurry');
    expect(q.score).toBe(0.7);
  });

  it('flags too_dark / too_bright by brightness', () => {
    expect(summarizeQuality({ durationSec: 10, frames: frames(5, 41) }).flags).toContain('too_dark');
    expect(summarizeQuality({ durationSec: 10, frames: frames(5, 230) }).flags).toContain('too_bright');
  });

  it('flags black and penalizes the score by its share of runtime', () => {
    const q = summarizeQuality({ durationSec: 10, frames: frames(5, 125), blackSpans: [{ startSec: 0, endSec: 1 }] });
    expect(q.flags).toContain('has_black');
    expect(q.black_sec).toBe(1);
    expect(q.score).toBe(0.9); // 1 - min(0.4, 1/10)
  });

  it('respects custom thresholds', () => {
    const q = summarizeQuality({ durationSec: 10, frames: frames(28, 125), thresholds: { blur: 40 } });
    expect(q.flags).not.toContain('blurry'); // 28 < 40
  });

  it('flags freeze and never scores below 0 on a fully defective clip', () => {
    const q = summarizeQuality({
      durationSec: 10,
      frames: frames(40, 30), // blurry + dark
      blackSpans: [{ startSec: 0, endSec: 6 }],
      freezeSpans: [{ startSec: 6, endSec: 10 }],
    });
    expect(q.flags).toEqual(expect.arrayContaining(['blurry', 'too_dark', 'has_black', 'has_freeze']));
    expect(q.freeze_sec).toBe(4);
    expect(q.score).toBe(0); // 1 - 0.3 - 0.3 - 0.4 - 0.3 = -0.3, clamped to 0
  });
});

describe('textSimilarity', () => {
  it('is 1 for identical token sets, 0 for disjoint', () => {
    expect(textSimilarity('the answer is yes', 'the ANSWER is, yes!')).toBe(1); // case + punctuation normalized
    expect(textSimilarity('hello world', 'foo bar baz')).toBe(0);
  });
  it('is a fraction for partial overlap', () => {
    // {the,answer,is,yes} vs {the,answer,is,no}: inter 3, union 5 → 0.6
    expect(textSimilarity('the answer is yes', 'the answer is no')).toBe(0.6);
  });
});

describe('clusterTakes', () => {
  it('groups repeats of the same line and keeps distinct lines separate', () => {
    const takes: Take[] = [
      { id: 'a', text: 'the answer is yes' },
      { id: 'b', text: 'the answer is yes!' }, // repeat of a
      { id: 'c', text: 'completely different sentence here' },
    ];
    expect(clusterTakes(takes, { threshold: 0.6 })).toEqual([['a', 'b'], ['c']]);
  });
  it('puts text-less takes each in their own cluster', () => {
    expect(clusterTakes([{ id: 'x' }, { id: 'y' }])).toEqual([['x'], ['y']]);
  });
});

describe('rankTakes', () => {
  it('picks the highest-quality take within a repeated group', () => {
    const r = rankTakes([
      { id: 'a', text: 'the answer is yes', quality_score: 0.4 },
      { id: 'b', text: 'the answer is yes', quality_score: 0.9 },
      { id: 'c', text: 'a different line', quality_score: 0.7 },
    ]);
    expect(r.clusters).toHaveLength(2);
    const repeated = r.clusters.find((c) => c.take_ids.length > 1)!;
    expect(repeated.best_id).toBe('b'); // higher quality wins
    expect(repeated.reason).toContain('best of 2');
  });

  it('reports a unique line as a single-take cluster', () => {
    const r = rankTakes([{ id: 'x', text: 'only line', quality_score: 0.6 }]);
    expect(r.clusters).toEqual([{ take_ids: ['x'], best_id: 'x', reason: expect.stringContaining('single take') }]);
    expect(r.scores.x).toBeCloseTo(0.54, 2); // 0.6 * 0.9, no duration bonus
  });
});

describe('decisionEvidence', () => {
  it('summarizes removed/kept with counts and total seconds', () => {
    const ev = decisionEvidence(
      [{ startSec: 4, endSec: 6 }, { startSec: 8, endSec: 8.5 }],
      [{ startSec: 0, endSec: 4 }, { startSec: 6, endSec: 8 }],
      'removed 2 silent spans',
    );
    expect(ev.removed_count).toBe(2);
    expect(ev.removed_sec).toBe(2.5);
    expect(ev.confidence).toBe(0.9);
    expect(ev.reason).toBe('removed 2 silent spans');
  });
});
