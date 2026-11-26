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

// 2026-11-17 VideoStudio benchmark, retake cleanup: whisper.cpp put words on the wrong side of
// the measured pauses (燈 in the false start, 柔 in the complete take, 它 in the 嗯 line), so the
// false start read as the end of the sentence before it and was kept. Below are the bundled
// whisper's words for two of those recordings, their pauses measured with the phrase filter, and
// each span between pauses recognized on its own. The expected lines are the script each
// recording was synthesized from, written in the recognizer's own characters.
describe('placing recognized words in the speech they were spoken in', () => {
  const s = (startSec: number, endSec: number) => ({ startSec, endSec });
  const LAMP = {
    duration: 25.240125,
    words: [
      w('大家好,', 0.6, 1.12), w('今天', 1.12, 1.73), w('給', 1.73, 2.03), w('大家', 2.03, 2.58), w('介', 2.64, 2.94), w('紹', 2.94, 3.24),
      w('一', 3.24, 3.44), w('款', 3.56, 3.75), w('護', 3.84, 4.14), w('眼', 4.14, 4.42), w('台', 4.47, 4.7), w('燈。', 4.94, 5.38),
      w('它的', 5.55, 5.9), w('光', 5.9, 6.16), w('線', 6.16, 6.35), w('非常', 6.35, 6.94), w('柔,', 6.94, 7.36), w('它的', 7.36, 7.76),
      w('光', 7.85, 8.03), w('線', 8.12, 8.29), w('非常', 8.35, 8.82), w('柔', 8.82, 9.01), w('和,', 9.01, 9.46), w('看', 9.46, 9.7),
      w('久', 9.7, 9.94), w('了', 9.94, 10.17), w('眼', 10.25, 10.42), w('睛', 10.42, 10.64), w('也', 10.71, 10.9), w('不', 10.9, 11.07),
      w('累。', 11.07, 11.6), w('嗯,', 11.6, 12.06), w('它', 12.2, 12.34), w('有', 12.34, 12.6), w('三', 12.7, 12.9), w('檔', 12.9, 13.17),
      w('色', 13.29, 13.45), w('溫', 13.45, 13.72), w('可', 13.72, 13.96), w('已', 14.02, 14.28), w('掉。', 14.28, 14.9), w('現在', 14.9, 15.45),
      w('只', 15.45, 15.72), w('要198', 15.72, 16.81), w('元,', 16.81, 17.26), w('不對,', 17.29, 17.95), w('現在', 17.95, 18.81), w('只', 18.81, 18.89),
      w('要199', 18.89, 19.89), w('元,', 19.95, 20.44), w('喜歡', 20.44, 21), w('的話,', 21.01, 21.74), w('點', 21.74, 22.02), w('擊', 22.02, 22.23),
      w('下', 22.31, 22.58), w('方', 22.58, 22.67), w('鏈', 22.67, 23.13), w('接', 23.13, 23.48), w('就', 23.48, 23.6), w('能', 23.6, 24.18),
      w('買', 24.18, 24.25), w('到。', 24.25, 24.88),
    ],
    silences: [
      s(0, 0.600938), s(1.34737, 1.66437), s(4.72262, 5.52525), s(6.36056, 7.2635), s(9.0315, 9.33481), s(11.087, 11.8874), s(12.0023, 12.5583),
      s(14.524, 15.325), s(16.5284, 17.0337), s(17.2448, 17.8479), s(20.0918, 20.8936), s(21.7285, 22.0414), s(24.3371, 25.2401),
    ],
    spanTexts: ['大家好', '今天給大家介紹一款護眼台燈。', '它的光线非常柔。', '它的光線非常柔和。', '看久了眼睛也不累', '嗯', '它有三檔色溫可已掉',
      '現在只要198元。', '補兑', '現在只要199元。', '喜歡的話。', '點擊下方鏈接就能買到。'],
    lines: ['大家好,', '今天給大家介紹一款護眼台燈。', '它的光線非常柔,', '它的光線非常柔和,', '看久了眼睛也不累。', '嗯,', '它有三檔色溫可已掉。',
      '現在只要198元,', '不對,', '現在只要199元,', '喜歡的話,', '點擊下方鏈接就能買到。'],
  };
  const CAMP = {
    duration: 19.063563,
    words: [
      w('出', 0, 0.33), w('門', 0.6, 0.66), w('露', 0.69, 0.99), w('營', 0.99, 1.32), w('之前,', 1.32, 2.18), w('先', 2.33, 2.45),
      w('檢', 2.45, 2.72), w('查', 2.72, 2.99), w('這', 2.99, 3.26), w('三', 3.26, 3.53), w('個', 3.53, 3.8), w('地方,', 3.8, 4.46),
      w('先', 4.46, 4.77), w('盤', 4.77, 4.88), w('帳', 4.88, 5.09), w('篷', 5.09, 5.3), w('的', 5.3, 5.51), w('汁,', 5.51, 6),
      w('先', 6.01, 6.25), w('看', 6.25, 6.5), w('帳', 6.5, 6.74), w('篷', 6.74, 6.98), w('的', 6.98, 7.23), w('汁', 7.23, 7.47),
      w('感', 7.47, 7.72), w('有沒有', 7.72, 8.47), w('列', 8.47, 8.62), w('文。', 8.62, 9), w('那個,', 9, 9.73), w('噢!', 9.73, 10.3),
      w('水', 10.3, 10.54), w('壺', 10.54, 10.78), w('裝', 10.78, 10.96), w('三', 10.96, 11.33), w('聲', 11.33, 11.5), w('水,', 11.5, 11.89),
      w('不對,', 11.94, 12.55), w('重', 12.55, 12.79), w('來,', 12.79, 13.16), w('水', 13.18, 13.2), w('壺', 13.2, 13.67), w('裝', 13.77, 13.91),
      w('兩', 13.96, 14.15), w('聲', 14.15, 14.38), w('水。', 14.4, 15), w('最後', 15, 15.69), w('把', 15.69, 15.85), w('充', 15.85, 16.13),
      w('滿', 16.13, 16.39), w('電', 16.42, 16.57), w('的', 16.69, 16.96), w('手', 16.96, 16.98), w('電', 17.33, 17.53), w('放', 17.53, 17.81),
      w('進', 17.81, 18.09), w('背', 18.09, 18.31), w('包。', 18.4, 18.92),
    ],
    silences: [
      s(0, 0.604375), s(1.99463, 2.30788), s(4.20931, 4.7605), s(5.53775, 5.98806), s(8.64456, 9.44475), s(9.65631, 9.81338), s(9.92938, 10.5297),
      s(11.3934, 11.7963), s(12.0394, 12.2009), s(12.4953, 12.8994), s(14.4791, 15.1842), s(18.1482, 19.0636),
    ],
    spanTexts: ['出门露營之前。', '先檢查這三個地方。', '先盤帳篷的汁。', '先看仗碰的質感有沒有列文。', '你个', '嗯', '水狐装三生水。', '不對', '宋禮',
      '水湖裝涼生水。', '最後把充滿電的手電放進背包'],
    lines: ['出門露營之前,', '先檢查這三個地方,', '先盤帳篷的汁,', '先看帳篷的汁感有沒有列文。', '那個,', '噢!', '水壺裝三聲水,', '不對,', '重來,',
      '水壺裝兩聲水。', '最後把充滿電的手電放進背包。'],
  };
  type Recording = typeof LAMP;
  const spansOf = (r: Recording, texts = r.spanTexts) =>
    host.speechSpans(r.silences, r.duration).map((span, i) => ({ ...span, text: texts[i] }));
  const lineTexts = (words: ReturnType<typeof w>[], r: Recording, breakSec = host.PHRASE_MIN_PAUSE_SEC) =>
    host.packTranscriptPhrases(words, r.silences, { breakSec }).map((l) => l.text);

  it('finds the speech between the measured pauses, edge to edge', () => {
    const spans = host.speechSpans(LAMP.silences, LAMP.duration);
    expect(spans).toHaveLength(12);
    expect(spans[0]).toEqual({ startSec: 0.600938, endSec: 1.34737 });
    expect(spans[2]).toEqual({ startSec: 5.52525, endSec: 6.36056 });
    expect(spans.at(-1)).toEqual({ startSec: 22.0414, endSec: 24.3371 });
    // Speech running to the end of the file, and silences that touch or overlap.
    expect(host.speechSpans([s(0, 1), s(0.9, 2), s(3, 3.2)], 5)).toEqual([{ startSec: 2, endSec: 3 }, { startSec: 3.2, endSec: 5 }]);
    expect(host.speechSpans([], 5)).toEqual([{ startSec: 0, endSec: 5 }]);
  });

  it.each([['talking-head lamp take', LAMP], ['camping take with restarts under half a second apart', CAMP]] as const)(
    'puts every word of the %s in the measured line it was spoken in', (_label, recording) => {
      // The defect: without placement, a word drifts into the line beside it.
      expect(lineTexts(recording.words, recording)).not.toEqual(recording.lines);
      const placed = host.placeWordsInSpeech(recording.words, spansOf(recording));
      expect(placed).not.toBeNull();
      expect(placed!.map((word) => word.text)).toEqual(recording.words.map((word) => word.text));
      expect(lineTexts(placed!, recording)).toEqual(recording.lines);
      const spans = host.speechSpans(recording.silences, recording.duration);
      let previousEnd = 0;
      for (const word of placed!) {
        expect(word.endSec).toBeGreaterThan(word.startSec);
        expect(word.startSec).toBeGreaterThanOrEqual(previousEnd);
        expect(spans.some((span) => span.startSec <= word.startSec && word.endSec <= span.endSec)).toBe(true);
        previousEnd = word.endSec;
      }
    });

  it('splits the lamp take at its long pauses into the lines of its script, the false start on its own', () => {
    const placed = host.placeWordsInSpeech(LAMP.words, spansOf(LAMP))!;
    expect(lineTexts(placed, LAMP, host.PHRASE_BREAK_SEC)).toEqual([
      '大家好, (0.32s) 今天給大家介紹一款護眼台燈。', '它的光線非常柔,', '它的光線非常柔和, (0.30s) 看久了眼睛也不累。', '嗯,', '它有三檔色溫可已掉。',
      '現在只要198元,', '不對,', '現在只要199元,', '喜歡的話, (0.31s) 點擊下方鏈接就能買到。',
    ]);
  });

  it('leaves the times of words that already sit inside their span', () => {
    const words = [w('so', 0.1, 0.4), w('we', 0.5, 0.9), w('shipped', 1.3, 1.8)];
    const spans = [{ startSec: 0, endSec: 1, text: 'so we' }, { startSec: 1.2, endSec: 2, text: 'shipped' }];
    expect(host.placeWordsInSpeech(words, spans)).toEqual(words);
  });

  it('places a word whose span recognized nothing by its time', () => {
    const texts = [...LAMP.spanTexts]; texts[5] = '';
    const placed = host.placeWordsInSpeech(LAMP.words, spansOf(LAMP, texts))!;
    expect(lineTexts(placed, LAMP)).toEqual(LAMP.lines);
  });

  it('keeps the words where they were when the spans were recognized as something else', () => {
    // A recognizer that hallucinates on short audio, or a different language per span.
    const unrelated = LAMP.spanTexts.map(() => '謝謝觀看');
    expect(host.placeWordsInSpeech(LAMP.words, spansOf(LAMP, unrelated))).toBeNull();
    expect(host.placeWordsInSpeech(LAMP.words, spansOf(LAMP, LAMP.spanTexts.map(() => '')))).toBeNull();
  });

  it('moves nothing when the pauses hold speech, as in a recording quieter than the threshold', () => {
    const words = [w('one', 0, 1), w('two', 1.2, 1.8), w('three', 2.1, 2.9), w('four', 3, 4)];
    const spans = [{ startSec: 0, endSec: 1, text: 'one' }, { startSec: 3, endSec: 4, text: 'four' }];
    expect(host.pausesHoldSpeech(words, spans)).toBe(true);
    expect(host.placeWordsInSpeech(words, spans)).toBeNull();
    expect(host.pausesHoldSpeech(LAMP.words, host.speechSpans(LAMP.silences, LAMP.duration))).toBe(false);
  });

  it('needs at least two spans and some words', () => {
    expect(host.placeWordsInSpeech(LAMP.words, [{ startSec: 0, endSec: LAMP.duration, text: LAMP.spanTexts.join('') }])).toBeNull();
    expect(host.placeWordsInSpeech([], spansOf(LAMP))).toBeNull();
  });
});

// 2026-11-17 benchmark: a drama recap told the next episode's preview ("录音被删了") as
// something that had happened. Only the picture said it was a preview, and the Agent wrote
// from the transcript alone, so a transcribed video now shows a frame under each phrase.
describe('phraseFrameSamples', () => {
  const line = (startSec: number, endSec: number, text = 'x') => ({ startSec, endSec, text, pauseAfterSec: null });

  it('takes each phrase in its middle and labels it with the start the phrase view shows', () => {
    expect(host.phraseFrameSamples([line(3, 4.52, '小周，合同呢？'), line(22.36, 24, '录音被删了。')], 26.16)).toEqual([
      { atSec: 3.76, label: '[3.00]', startSec: 3 },
      { atSec: 23.18, label: '[22.36]', startSec: 22.36 },
    ]);
  });

  it('keeps the first and last of many phrases and spreads the rest evenly', () => {
    const many = Array.from({ length: 40 }, (_item, index) => line(index, index + 0.5));
    const samples = host.phraseFrameSamples(many, 41);
    expect(samples).toHaveLength(host.PHRASE_FRAMES_MAX);
    expect(samples[0].startSec).toBe(0);
    expect(samples.at(-1)!.startSec).toBe(39);
    const gaps = samples.slice(1).map((sample, index) => sample.startSec - samples[index].startSec);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('keeps a frame inside the file when a phrase is timed past its end', () => {
    expect(host.phraseFrameSamples([line(9.8, 10.4)], 10)[0].atSec).toBeLessThanOrEqual(9.9);
    expect(host.phraseFrameSamples([], 10)).toEqual([]);
  });
});

// 2026-11-19 run: a tutorial's narration voiced in one take came back from the recognizer as one
// 28 s segment, so the delivered frames had one cell for every step it named. Its words carry
// their own times and commas; a frame per clause puts each step's words over its picture.
describe('heardClauses', () => {
  it('ends a clause at its punctuation, with the times of its own words', () => {
    const words = [
      w('先', 2.1, 2.3), w('打开', 2.3, 2.7), w('设置,', 2.7, 3.2), w('再', 3.25, 3.4), w('进入', 3.4, 3.7), w('备份页。', 3.7, 4.4),
      w('点击', 9.8, 10.1), w('立即备份。', 10.1, 11),
    ];
    expect(host.heardClauses(words, [])).toEqual([
      { text: '先打开设置,', startSec: 2.1, endSec: 3.2 },
      { text: '再进入备份页。', startSec: 3.25, endSec: 4.4 },
      { text: '点击立即备份。', startSec: 9.8, endSec: 11 },
    ]);
  });

  it('spaces words of other languages and breaks at a pause where nothing marks the clause', () => {
    const words = [w('Open', 0.1, 0.4), w('the', 0.4, 0.5), w('export', 0.5, 0.9), w('page', 0.9, 1.2), w('Then', 2, 2.2), w('save', 2.2, 2.6)];
    expect(host.heardClauses(words, [])).toEqual([
      { text: 'Open the export page', startSec: 0.1, endSec: 1.2 },
      { text: 'Then save', startSec: 2, endSec: 2.6 },
    ]);
  });

  it('keeps the recognizer\'s sentences when it gave no word times, and drops punctuation on its own', () => {
    const segments = [{ text: 'It is saved.', startSec: 1, endSec: 2 }];
    expect(host.heardClauses([], segments)).toEqual(segments);
    expect(host.heardClauses([w('好。', 0, 0.5), w('。', 0.5, 0.6)], [])).toEqual([{ text: '好。', startSec: 0, endSec: 0.5 }]);
  });
});
