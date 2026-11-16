import { describe, expect, it } from 'vitest';

import * as host from '../../../src/main/features/video_phrases';
import * as skill from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_decide';

// whisper.cpp on a synthesized 14 s 口播 with a restart, and silencedetect at -40 dB /
// 0.15 s on the same file (2026-11-12). The pauses around 呃 left no word gap at all.
const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
const WORDS = [
  w('大家好,', 0.01, 1.14), w('今天', 1.14, 1.54), w('给', 1.58, 1.76), w('大家', 1.82, 2.21), w('介', 2.21, 2.42), w('绍', 2.42, 2.63),
  w('一', 2.63, 2.84), w('款', 2.84, 3.05), w('户', 3.05, 3.26), w('眼', 3.26, 3.47), w('台', 3.47, 3.59), w('灯。', 3.67, 4.11),
  w('它的', 5.16, 5.17), w('亮', 5.17, 5.28), w('度', 5.28, 5.57), w('可以', 5.67, 6.4), w('调', 6.4, 6.77), w('节,', 6.77, 7.21),
  w('呃,', 7.21, 7.91), w('它的', 7.91, 8.32), w('亮', 8.4, 8.58), w('度', 8.58, 8.75), w('可以', 8.8, 9.25), w('无', 9.25, 9.27),
  w('极', 9.27, 9.69), w('调', 9.69, 9.91), w('节。', 9.91, 10.44), w('现在', 11.72, 11.73), w('下', 11.72, 11.73), w('单', 11.73, 11.84),
  w('立', 11.84, 12.13), w('减50', 12.23, 13.23), w('元。', 13.23, 13.94),
];
const SILENCES = [
  { startSec: 0.752, endSec: 1.058 }, { startSec: 4.136, endSec: 5.265 }, { startSec: 6.946, endSec: 7.439 },
  { startSec: 7.719, endSec: 8.307 }, { startSec: 10.358, endSec: 11.76 },
];

describe('phrase view: host and skill bundle agree', () => {
  // A seeded generator: words of mixed scripts, some silences inside words, some between.
  function cases(): Array<{ words: ReturnType<typeof w>[]; silences: Array<{ startSec: number; endSec: number }> }> {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const tokens = ['我们', 'the', '店', 'price,', '。', 'went', '涨', 'up'];
    return Array.from({ length: 40 }, () => {
      let t = 0;
      const words = Array.from({ length: 12 }, () => {
        const start = t + next() * 0.4;
        const end = start + 0.1 + next() * 0.6;
        t = end;
        return w(tokens[Math.floor(next() * tokens.length)], Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000);
      });
      const silences = Array.from({ length: 4 }, () => {
        const s = next() * t;
        return { startSec: Math.round(s * 1000) / 1000, endSec: Math.round((s + 0.1 + next() * 0.8) * 1000) / 1000 };
      });
      return { words, silences };
    });
  }

  it('packs and formats identically, for words and for sentences', () => {
    for (const { words, silences } of [{ words: WORDS, silences: SILENCES }, ...cases()]) {
      for (const opts of [{}, { segments: true }, { breakSec: 0.3 }]) {
        const a = host.packTranscriptPhrases(words, silences, opts);
        expect(a).toEqual(skill.packTranscriptPhrases(words, silences, opts));
        expect(host.formatPhraseLines(a)).toBe(skill.formatPhraseLines(a));
      }
    }
    expect(host.PHRASE_BREAK_SEC).toBe(skill.PHRASE_BREAK_SEC);
    expect(host.PHRASE_MIN_PAUSE_SEC).toBe(skill.PHRASE_MIN_PAUSE_SEC);
  });

  it('puts the restart on its own line from the measured pauses', () => {
    expect(host.packTranscriptPhrases(WORDS, SILENCES).map((l) => l.text)).toEqual([
      '大家好, (0.31s) 今天给大家介绍一款户眼台灯。',
      '它的亮度可以调节, (0.49s) 呃,',
      '它的亮度可以无极调节。',
      '现在下单立减50元。',
    ]);
    // Each line ends where the sound stops and starts where it resumes.
    expect(host.packTranscriptPhrases(WORDS, SILENCES).map((l) => [l.startSec, l.endSec]))
      .toEqual([[0.01, 4.136], [5.265, 7.719], [8.307, 10.358], [11.76, 13.94]]);
  });

  it('keeps a sentence whole when a pause falls inside it', () => {
    const sentences = [w('First we raised the price, then sales went up.', 0, 4), w('Here is why.', 4.8, 6)];
    const pauses = [{ startSec: 1.6, endSec: 2.1 }, { startSec: 4.1, endSec: 4.7 }];
    const lines = host.packTranscriptPhrases(sentences, pauses, { segments: true });
    expect(lines.map((l) => [l.startSec, l.endSec, l.text])).toEqual([
      [0, 4.1, 'First we raised the price, then sales went up.'],
      [4.7, 6, 'Here is why.'],
    ]);
  });
});

describe('parseSilenceLog', () => {
  it('pairs starts with ends and ignores everything else', () => {
    const log = [
      'Input #0, mov,mp4 …',
      '[silencedetect @ 0x1] silence_start: 0.752',
      '[silencedetect @ 0x1] silence_end: 1.058 | silence_duration: 0.306',
      'size=  N/A time=00:00:05.00',
      '[silencedetect @ 0x1] silence_start: 4.136',
      '[silencedetect @ 0x1] silence_end: 5.265 | silence_duration: 1.129',
    ].join('\n');
    expect(host.parseSilenceLog(log)).toEqual([{ startSec: 0.752, endSec: 1.058 }, { startSec: 4.136, endSec: 5.265 }]);
  });

  it('closes a silence that runs to the end only when the length is known', () => {
    expect(host.parseSilenceLog('silence_start: 3.5')).toEqual([]);
    expect(host.parseSilenceLog('silence_start: 3.5', 5)).toEqual([{ startSec: 3.5, endSec: 5 }]);
    expect(host.parseSilenceLog('')).toEqual([]);
  });
});

describe('phraseViewForResult', () => {
  it('returns the whole view when it is short', () => {
    const view = host.phraseViewForResult(WORDS, SILENCES);
    expect(view).toMatchObject({ lines: 4, measured_pauses: 5 });
    expect(view.text.startsWith('[0.01–4.14] 大家好')).toBe(true);
    expect(view.truncated).toBeUndefined();
  });

  it('caps a long view and says how to read the rest', () => {
    const many = Array.from({ length: 250 }, (_, i) => w(`w${i}`, i, i + 0.4));
    const view = host.phraseViewForResult(many, []);
    expect(view).toMatchObject({ lines: 250, measured_pauses: 0, truncated: true });
    expect(view.text.split('\n').filter((row) => row.startsWith('['))).toHaveLength(host.PHRASES_INLINE_MAX_LINES);
    expect(view.text).toMatch(/50 more lines\. For the rest, run stage-edit analyze_media --op phrases/);
  });

  it('tells the reader, before the lines, that words near a line edge may belong beside it', () => {
    // 2026-11-13: recognition put "不对" at the start of the kept take's line, the cut moved
    // inside that line to drop it, and the take lost "现在只要".
    const view = host.phraseViewForResult(WORDS, SILENCES);
    expect(view.note).toBe('Times and pauses are measured from the recording; the words come from speech recognition and can sit up to about a second off. A word at the start or end of a line may belong to the line next to it: cut at line edges or marked pauses, never inside a line to drop such a word.');
    expect(Object.keys(view).indexOf('note')).toBeLessThan(Object.keys(view).indexOf('text'));
  });

  it('says when no pauses could be measured', () => {
    expect(host.phraseViewForResult(WORDS, null).measured_pauses).toBeNull();
  });
});
