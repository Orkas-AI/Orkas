import { describe, expect, it } from 'vitest';

import {
  mergeSpans,
  keepIntervalsFromRemovals,
  complementIntervals,
  fillerSpansFromWords,
  normalizeTranscriptWords,
  parseSceneChanges,
  buildKeepFilterComplex,
  JOIN_FADE_SEC,
  decisionEvidence,
  parseQualityFrames,
  parseLabeledIntervals,
  summarizeQuality,
  textSimilarity,
  clusterTakes,
  rankTakes,
  DEFAULT_FILLERS,
  packTranscriptPhrases,
  formatPhraseLines,
  normalizeActivityRegions,
  summarizeActivity,
  normalizeFocusPlan,
  piecewiseExpr,
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

  it('removes only the Chinese fillers asked for, never the words around them', () => {
    // Before: stripping everything outside a-z made every Chinese word "", equal to a
    // Chinese filler, so "嗯 这款 台灯 39" lost every word.
    const zh: Word[] = [
      { text: '嗯', startSec: 0, endSec: 0.3 },
      { text: '这款', startSec: 0.3, endSec: 0.6 },
      { text: '台灯', startSec: 0.6, endSec: 0.9 },
      { text: '39', startSec: 0.9, endSec: 1.2 },
      { text: '呃，', startSec: 1.2, endSec: 1.4 }, // punctuation stripped → matches "呃"
      { text: '嗯哼', startSec: 1.4, endSec: 1.8 }, // look-alike: must NOT match "嗯"
      { text: '。', startSec: 1.8, endSec: 1.9 }, // no letters: never a filler
    ];
    expect(fillerSpansFromWords(zh, ['嗯', '呃', '。'], { padSec: 0 })).toEqual([
      { startSec: 0, endSec: 0.3 },
      { startSec: 1.2, endSec: 1.4 },
    ]);
    expect(fillerSpansFromWords(zh, DEFAULT_FILLERS, { padSec: 0 })).toEqual([]);
  });

  it('pads into silence but never into the neighbouring words', () => {
    const touching: Word[] = [
      { text: 'so', startSec: 0, endSec: 1 },
      { text: 'um', startSec: 1, endSec: 1.3 },
      { text: 'the', startSec: 1.3, endSec: 2 },
    ];
    expect(fillerSpansFromWords(touching, DEFAULT_FILLERS, { padSec: 0.03 })).toEqual([{ startSec: 1, endSec: 1.3 }]);
    const gapped: Word[] = [
      { text: 'so', startSec: 0, endSec: 0.9 },
      { text: 'um', startSec: 1, endSec: 1.3 },
      { text: 'the', startSec: 1.5, endSec: 2 },
    ];
    const [span] = fillerSpansFromWords(gapped, DEFAULT_FILLERS, { padSec: 0.03 });
    expect(span.startSec).toBeCloseTo(0.97, 5);
    expect(span.endSec).toBeCloseTo(1.33, 5);
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

  it('reads a top-level array of {text,start,end} (legacy transcript shape)', () => {
    // Kept for backward compatibility with older transcript JSON artifacts.
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

describe('packTranscriptPhrases', () => {
  const w = (text: string, startSec: number, endSec: number): Word => ({ text, startSec, endSec });

  // whisper.cpp on a synthesized 14 s 口播 with a restart, and ffmpeg silencedetect
  // at -40 dB / 0.15 s on the same file (2026-11-12). The 0.49 s and 0.59 s pauses
  // around 呃 left no gap between the recognized words.
  const words = [
    w('大家好,', 0.01, 1.14), w('今天', 1.14, 1.54), w('给', 1.58, 1.76), w('大家', 1.82, 2.21), w('介', 2.21, 2.42), w('绍', 2.42, 2.63),
    w('一', 2.63, 2.84), w('款', 2.84, 3.05), w('户', 3.05, 3.26), w('眼', 3.26, 3.47), w('台', 3.47, 3.59), w('灯。', 3.67, 4.11),
    w('它的', 5.16, 5.17), w('亮', 5.17, 5.28), w('度', 5.28, 5.57), w('可以', 5.67, 6.4), w('调', 6.4, 6.77), w('节,', 6.77, 7.21),
    w('呃,', 7.21, 7.91), w('它的', 7.91, 8.32), w('亮', 8.4, 8.58), w('度', 8.58, 8.75), w('可以', 8.8, 9.25), w('无', 9.25, 9.27),
    w('极', 9.27, 9.69), w('调', 9.69, 9.91), w('节。', 9.91, 10.44), w('现在', 11.72, 11.73), w('下', 11.72, 11.73), w('单', 11.73, 11.84),
    w('立', 11.84, 12.13), w('减50', 12.23, 13.23), w('元。', 13.23, 13.94),
  ];
  const silences = [
    { startSec: 0.752, endSec: 1.058 }, { startSec: 4.136, endSec: 5.265 }, { startSec: 6.946, endSec: 7.439 },
    { startSec: 7.719, endSec: 8.307 }, { startSec: 10.358, endSec: 11.76 },
  ];

  it('puts a restart on its own line from the measured pauses the words hide', () => {
    const lines = packTranscriptPhrases(words, silences);
    expect(lines.map((l) => l.text)).toEqual([
      '大家好, (0.31s) 今天给大家介绍一款户眼台灯。',
      '它的亮度可以调节, (0.49s) 呃,',
      '它的亮度可以无极调节。',
      '现在下单立减50元。',
    ]);
    expect(lines[1]).toMatchObject({ startSec: 5.265, endSec: 7.719, pauseAfterSec: 0.588 });
    expect(lines[2].startSec).toBe(8.307);
    expect(lines[3].pauseAfterSec).toBeNull();
  });

  it('falls back to the word gaps when nothing was measured', () => {
    const lines = packTranscriptPhrases([w('one', 0, 0.4), w('two', 0.7, 1), w('three', 1.6, 2)], []);
    expect(lines.map((l) => l.text)).toEqual(['one (0.30s) two', 'three']);
    expect(lines[0].pauseAfterSec).toBe(0.6);
  });

  it('moves a word the recognizer placed inside a silence to the nearer speech', () => {
    // A question's last word and its answer's first both timed inside the pause
    // between them (2026-11-13) hid the speaker change entirely.
    const words = [w('a', 0, 0.5), w('b', 0.55, 0.95), w('x', 1.05, 1.15), w('c', 1.7, 2), w('d', 2, 2.4)];
    const lines = packTranscriptPhrases(words, [{ startSec: 1, endSec: 1.6 }]);
    expect(lines.map((l) => [l.startSec, l.endSec, l.text])).toEqual([[0, 1, 'a b x'], [1.6, 2.4, 'c d']]);
  });

  it('moves nothing when most words fall inside "silences": the recording is quieter than the threshold', () => {
    const words = [w('a', 0, 0.4), w('b', 0.5, 0.9), w('c', 1, 1.4)];
    const lines = packTranscriptPhrases(words, [{ startSec: 0, endSec: 2 }]);
    expect(lines.map((l) => [l.startSec, l.endSec])).toEqual([[0, 1.4]]);
  });

  it('spaces Latin words and attaches punctuation', () => {
    const lines = packTranscriptPhrases([w('Hello,', 0, 0.3), w('world', 0.32, 0.6), w('.', 0.6, 0.62), w('这款', 0.7, 0.9)], []);
    expect(lines[0].text).toBe('Hello, world.这款');
  });

  it('starts lines at the pause the caller asks for', () => {
    const lines = packTranscriptPhrases([w('a', 0, 0.4), w('b', 0.7, 1)], [], { breakSec: 0.25 });
    expect(lines).toHaveLength(2);
  });

  it('formats one line per phrase with the pause between', () => {
    expect(formatPhraseLines(packTranscriptPhrases([w('a', 0, 0.4), w('b', 1, 1.2)], [])))
      .toBe('[0.00–0.40] a\n  — 0.60s —\n[1.00–1.20] b');
  });
});

describe('summarizeActivity', () => {
  // Ten samples a second per region; `pattern` lists who moves in each half second.
  function series(pattern: Array<'a' | 'b' | '-'>): Record<string, Array<{ tSec: number; value: number }>> {
    const out: Record<string, Array<{ tSec: number; value: number }>> = { a: [], b: [] };
    pattern.forEach((who, w) => {
      for (let k = 0; k < 5; k += 1) {
        const tSec = Math.round((w * 0.5 + k * 0.1) * 1000) / 1000;
        out.a.push({ tSec, value: who === 'a' ? 12 : 2 });
        out.b.push({ tSec, value: who === 'b' ? 12 : 2 });
      }
    });
    return out;
  }

  it('preserves 50ms window boundaries and levels from unordered samples', () => {
    const measured = { a: [{ tSec: 0.1, value: 12 }, { tSec: 0, value: 6 },
      { tSec: 0.049, value: 10 }, { tSec: 0.05, value: NaN }],
      b: [{ tSec: 0, value: 2 }, { tSec: 0.1, value: 3 }] };
    const { windows, turns } = summarizeActivity(measured, { durationSec: 0.2, windowSec: 0.05 });
    expect(windows).toEqual([
      { startSec: 0, endSec: 0.05, levels: { a: 8, b: 2 }, lead: 'a' },
      { startSec: 0.05, endSec: 0.1, levels: { a: 0, b: 0 }, lead: null },
      { startSec: 0.1, endSec: 0.15, levels: { a: 12, b: 3 }, lead: 'a' },
      { startSec: 0.15, endSec: 0.2, levels: { a: 0, b: 0 }, lead: null },
    ]);
    expect(turns).toEqual([{ startSec: 0, endSec: 0.2, regionId: 'a' }]);
  });

  it('rejects non-finite or excessive window counts without substituting a different window', () => {
    for (const windowSec of [Number.MIN_VALUE, 1e-200, 1 / 100001]) {
      expect(() => summarizeActivity({}, { durationSec: 1, windowSec })).toThrow(/larger window/);
    }
    expect(summarizeActivity({}, { durationSec: 1, windowSec: 1 / 100000 }).windows).toHaveLength(100000);
  });

  it('retains millisecond windows below the sampling interval', () => {
    const result = summarizeActivity({ a: [{ tSec: 0.001, value: 9 }] }, { durationSec: 0.003, windowSec: 0.001 });
    expect(result.windows.map(w => [w.startSec, w.endSec, w.levels.a])).toEqual([
      [0, 0.001, 0], [0.001, 0.002, 9], [0.002, 0.003, 0],
    ]);
  });

  it('turns half-second leads into speaker turns', () => {
    const { windows, turns } = summarizeActivity(series(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']), { durationSec: 4 });
    expect(windows).toHaveLength(8);
    expect(windows[0]).toMatchObject({ startSec: 0, endSec: 0.5, lead: 'a' });
    expect(turns).toEqual([
      { startSec: 0, endSec: 2, regionId: 'a' },
      { startSec: 2, endSec: 4, regionId: 'b' },
    ]);
  });

  it('folds initial short turns forward before settling later short turns backward', () => {
    const { turns } = summarizeActivity(series(['a', 'b', 'a', 'a', 'b', 'b', 'a', 'b']), { durationSec: 4 });
    expect(turns).toEqual([{ startSec: 0, endSec: 1, regionId: 'b' },
      { startSec: 1, endSec: 2, regionId: 'a' }, { startSec: 2, endSec: 4, regionId: 'b' }]);
  });

  it('folds a short interjection into the turn around it', () => {
    const { turns } = summarizeActivity(series(['a', 'a', 'a', 'a', 'b', 'a', 'a', 'a']), { durationSec: 4 });
    expect(turns).toEqual([{ startSec: 0, endSec: 4, regionId: 'a' }]);
  });

  it('keeps the last clear speaker through windows nobody leads', () => {
    const { windows, turns } = summarizeActivity(series(['a', 'a', '-', '-', 'b', 'b', 'b']), { durationSec: 3.5 });
    expect(windows[2].lead).toBeNull();
    expect(turns).toEqual([
      { startSec: 0, endSec: 2, regionId: 'a' },
      { startSec: 2, endSec: 3.5, regionId: 'b' },
    ]);
  });

  it('calls no lead when the busier box is not clearly ahead', () => {
    const near = { a: [{ tSec: 0.1, value: 10 }], b: [{ tSec: 0.1, value: 8 }] };
    expect(summarizeActivity(near, { durationSec: 0.5 }).windows[0].lead).toBeNull();
    expect(summarizeActivity(near, { durationSec: 0.5, leadRatio: 1.2 }).windows[0].lead).toBe('a');
    expect(summarizeActivity(near, { durationSec: 0.5 }).turns).toEqual([]);
  });

  it('retains a speaker named __proto__ as an ordinary region through levels and turns', () => {
    const measured = Object.fromEntries([
      ['__proto__', [{ tSec: 0.1, value: 12 }, { tSec: 0.6, value: 12 }]],
      ['right', [{ tSec: 0.1, value: 2 }, { tSec: 0.6, value: 2 }]],
    ]);
    const { windows, turns } = summarizeActivity(measured, { durationSec: 1 });
    expect(Object.keys(windows[0].levels)).toEqual(['__proto__', 'right']);
    expect(windows[0].levels.__proto__).toBe(12);
    expect(turns).toEqual([{ startSec: 0, endSec: 1, regionId: '__proto__' }]);
  });

  it('summarizes four long speaker recordings without expanding samples into function arguments', () => {
    // At the real 10 Hz measurement rate, four regions over 67 minutes
    // exceed V8's argument limit, even when only one summary window is needed.
    const measured = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id,
      Array.from({ length: 40_000 }, (_, i) => ({ tSec: i / 10, value: id === 'a' ? 12 : 2 })),
    ]));
    const { windows, turns } = summarizeActivity(measured, { durationSec: 4000, windowSec: 4000 });
    expect(windows).toEqual([{ startSec: 0, endSec: 4000, levels: { a: 12, b: 2, c: 2, d: 2 }, lead: 'a' }]);
    expect(turns).toEqual([{ startSec: 0, endSec: 4000, regionId: 'a' }]);
  });
});

describe('normalizeActivityRegions', () => {
  it('accepts up to four named boxes inside the frame', () => {
    expect(normalizeActivityRegions([{ id: 'host', box: [0.1, 0.5, 0.3, 0.7] }, { box: [0.6, 0.5, 0.8, 0.7] }]))
      .toEqual([{ id: 'host', box: [0.1, 0.5, 0.3, 0.7] }, { id: 'r2', box: [0.6, 0.5, 0.8, 0.7] }]);
  });

  it('refuses boxes outside the frame, inverted, repeated ids and too many', () => {
    expect(normalizeActivityRegions([])).toMatch(/1 to 4/);
    expect(normalizeActivityRegions([{ box: [0.1, 0.5, 1.3, 0.7] }])).toMatch(/fractions of the frame/);
    expect(normalizeActivityRegions([{ box: [0.5, 0.5, 0.2, 0.7] }])).toMatch(/too small or inverted/);
    expect(normalizeActivityRegions([{ id: 'x', box: [0, 0, 0.5, 0.5] }, { id: 'x', box: [0.5, 0, 1, 0.5] }])).toMatch(/used twice/);
    expect(normalizeActivityRegions(Array.from({ length: 5 }, () => ({ box: [0, 0, 0.5, 0.5] })))).toMatch(/1 to 4/);
  });
});

describe('normalizeFocusPlan', () => {
  it('reads the point to keep centred per stretch, with either spelling', () => {
    expect(normalizeFocusPlan([{ start: 0, centre_x: 0.3 }, { start: 2.5, center_x: 0.7, center_y: 0.4 }]))
      .toEqual([{ startSec: 0, centreX: 0.3 }, { startSec: 2.5, centreX: 0.7, centreY: 0.4 }]);
  });

  it('refuses a plan that does not start at 0, goes back in time or leaves the frame', () => {
    expect(normalizeFocusPlan([{ start: 1, centre_x: 0.3 }])).toMatch(/start at 0/);
    expect(normalizeFocusPlan([{ start: 0, centre_x: 0.3 }, { start: 0, centre_x: 0.6 }])).toMatch(/later than the step before/);
    expect(normalizeFocusPlan([{ start: 0, centre_x: 1.2 }])).toMatch(/point to keep centred/);
    expect(normalizeFocusPlan([{ start: 0, focus_x: 0.3 }])).toMatch(/centre_x/);
    expect(normalizeFocusPlan([])).toMatch(/1 to 200/);
  });

  it('builds a nested expression that switches at each start', () => {
    const steps = [{ startSec: 0, centreX: 0.2 }, { startSec: 3, centreX: 0.8 }, { startSec: 7.5, centreX: 0.5 }];
    expect(piecewiseExpr(steps, (s) => s.centreX)).toBe('if(lt(t,3.000),0.2000,if(lt(t,7.500),0.8000,0.5000))');
    expect(piecewiseExpr([steps[0]], (s) => s.centreX)).toBe('0.2000');
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
  it('builds a select jump-cut and joins the audio pieces with short fades', () => {
    const { filter, maps } = buildKeepFilterComplex([
      { startSec: 0, endSec: 4.1 },
      { startSec: 5.9, endSec: 10 },
    ]);
    expect(filter).toContain("select='between(t,0.000,4.100)+between(t,5.900,10.000)'");
    expect(filter).toContain('setpts=N/FRAME_RATE/TB');
    // aselect butt-joined the samples and clicked at every cut; each piece is
    // now trimmed on its own and faded in and out before the concat.
    expect(filter).not.toContain('aselect=');
    expect(filter).toContain('[0:a]asplit=2[s0][s1]');
    expect(filter).toContain(`[s0]atrim=start=0.000:end=4.100,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${JOIN_FADE_SEC.toFixed(4)},afade=t=out:st=4.0700:d=0.0300[p0]`);
    expect(filter).toContain('[s1]atrim=start=5.900:end=10.000,asetpts=PTS-STARTPTS,');
    expect(filter).toContain('[p0][p1]concat=n=2:v=0:a=1[a]');
    expect(maps).toEqual(['-map', '[v]', '-map', '[a]']);
  });

  it('keeps one interval without a split or concat', () => {
    const { filter } = buildKeepFilterComplex([{ startSec: 1, endSec: 3 }]);
    expect(filter).not.toContain('asplit');
    expect(filter).not.toContain('concat');
    expect(filter).toContain('[0:a]atrim=start=1.000:end=3.000,asetpts=PTS-STARTPTS,');
    expect(filter).toMatch(/\[a\]$/);
  });

  it('shortens the fade on a piece too short to hold two full fades', () => {
    const { filter } = buildKeepFilterComplex([{ startSec: 0, endSec: 0.08 }, { startSec: 1, endSec: 2 }]);
    expect(filter).toContain('afade=t=in:st=0:d=0.0200,afade=t=out:st=0.0600:d=0.0200[p0]');
  });

  it('snaps cuts to whole frames so video and audio keep the same length', () => {
    // At 30 fps 0.7137s is not on a frame; the audio is cut at the frame the
    // video keeps, and the video window sits half a frame early so frame
    // timestamps exactly on a boundary are not lost to rounding.
    const { filter } = buildKeepFilterComplex([
      { startSec: 0, endSec: 0.7137 },
      { startSec: 1.1348, endSec: 1.8485 },
    ], { fps: 30 });
    expect(filter).toContain("select='between(t,0.000000,0.683333)+between(t,1.116667,1.816667)'");
    expect(filter).toContain('atrim=start=0.000000:end=0.700000');
    expect(filter).toContain('atrim=start=1.133333:end=1.833333');
  });

  it('drops an interval that rounds to nothing at the frame rate', () => {
    const { filter } = buildKeepFilterComplex([{ startSec: 0, endSec: 1 }, { startSec: 2.001, endSec: 2.01 }], { fps: 30 });
    expect(filter).not.toContain('asplit');
    expect(filter).toContain("select='between(t,0.000000,0.983333)'");
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
