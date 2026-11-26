import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { WORD_PLACEMENT_MAX_SPANS, buildSpeechTranscribeArgs, chineseTranscriptPrompt, dropSegmentsHeardInSilence, retimeInvertedWords, transcribeSpeech } from '../../../src/main/features/video_studio';
import { getCurrentLang, setCurrentLang } from '../../../src/main/i18n';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { finalizeProducedFile } from '../../../src/main/features/produced_output_hooks';
let root: string, source: string, output: string, prior: NodeJS.ProcessEnv;
const seg = (from: number, to: number, text = 'Keep recognized words.') => ({ text, offsets: { from, to } });
function ff(args: string[]) {
  const r = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', ...args], { encoding: 'utf8', timeout: 30000 });
  expect(r.status).toBe(0); expect(r.stderr).toBe('');
}
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-asr-timing-')));
  source = path.join(root, 'source.wav'); output = path.join(root, 'prior.json');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', source]);
  await fs.writeFile(output, '{"text":"Prior result"}\n');
});
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });
async function recognize(rows: unknown[]) {
  const raw = path.join(root, 'raw.json'); await fs.writeFile(raw, JSON.stringify({ transcription: rows }));
  const cli = path.join(root, 'whisper');
  await fs.writeFile(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'calls'),'1');
fs.copyFileSync(path.join(__dirname,'raw.json'),a[a.indexOf('-of')+1]+'.json');
`); await fs.chmod(cli, 0o755);
  process.env.ORKAS_WHISPER_CPP = cli; process.env.ORKAS_WHISPER_MODEL = raw;
}
describe.skipIf(process.platform === 'win32')('native transcript timing and recoverable text', () => {
  it.each([
    { label: 'most words timed after the decoded audio end', rows: [{ ...seg(0, 5000), tokens: [seg(0, 500, ' First'), seg(2100, 2500, ' second'), seg(2600, 3000, ' third'), seg(3100, 4000, ' fourth')] }] },
    { label: 'reversed segments', rows: [seg(1000, 1500, 'First.'), seg(0, 500, 'Second.')] },
    { label: 'overlapping segments', rows: [seg(0, 1200), seg(1000, 1800)] },
    { label: 'zero duration', rows: [seg(0, 0)] },
    { label: 'negative start', rows: [seg(-100, 500)] },
    { label: 'word token missing time', rows: [{ ...seg(0, 2000), tokens: [{ text: ' First', offsets: { from: null, to: 1000 } }] }] },
    { label: 'untimed word with no room between its neighbours', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(1000, 1000, ' lost'), seg(1000, 2000, ' second')] }] },
    { label: 'untimed word before the previous word ends', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(500, 500, ' early'), seg(1000, 2000, ' second')] }] },
    { label: 'untimed word after the next word starts', rows: [{ ...seg(0, 2000), tokens: [seg(0, 500, ' First'), seg(1200, 1200, ' late'), seg(1000, 2000, ' second')] }] },
    { label: 'words ending before they start with no time between their neighbours', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(1000, 900, ' back'), seg(1000, 2000, ' second')] }] },
  ])('preserves TXT and previous JSON for $label, without replay, and permits explicit recovery', async ({ rows }) => {
    await recognize(rows); const bytes = await fs.readFile(source);
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, timestamps: 'word' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT', timing_valid: false });
    expect(result).not.toHaveProperty('summary'); expect(result).not.toHaveProperty('phrases');
    expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
    const textPath = result.text_path as string;
    expect(textPath).not.toBe(output);
    const words = rows.map(row => row.text.trim()).join('\n') + '\n';
    expect(await fs.readFile(textPath, 'utf8')).toBe(words);
    await finalizeProducedFile(textPath, { source: 'video_studio.transcript_text' });
    expect(await fs.readFile(textPath, 'utf8')).toBe(words);
    expect(await fs.readFile(path.join(root, 'calls'), 'utf8')).toBe('1');
    expect(await fs.readFile(source)).toEqual(bytes);
    await recognize([seg(0, 2000)]);
    expect(await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output })).toMatchObject({ ok: true });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).segments[0].endSec).toBe(2);
    expect(await fs.readFile(textPath, 'utf8')).toBe(words);
    expect(await fs.readFile(path.join(root, 'calls'), 'utf8')).toBe('11');
  });
  it('keeps an internal failed check in memory without creating a persistent text file', async () => {
    await recognize([seg(1500, 500)]); const before = await fs.readdir(root);
    const result = await transcribeSpeech({ inputAbsPath: source });
    expect(result).toMatchObject({ ok: false, timing_valid: false, text: 'Keep recognized words.' });
    expect(result).not.toHaveProperty('text_path'); expect(await fs.readdir(root)).toEqual([...before, 'calls'].sort());
  });
  it('cleans an interrupted text candidate and keeps the old JSON for explicit retry', async () => {
    await recognize([seg(1500, 500)]); const original = fs.writeFile.bind(fs); let injected = false;
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (...args: any[]) => {
      if (String(args[0]).includes('transcript-text-') && String(args[0]).endsWith('transcript.txt')) {
        injected = true; await original(args[0], 'partial'); throw Object.assign(new Error('Controlled text write failure'), { code: 'EIO' });
      }
      return (original as any)(...args);
    }) as any);
    syncBuiltinESMExports();
    try { await expect(transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output })).rejects.toMatchObject({ code: 'EIO' }); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(injected).toBe(true); expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
    expect((await fs.readdir(root)).some(n => n.startsWith('transcript-text-'))).toBe(false);
    expect(await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output })).toMatchObject({ ok: false, timing_valid: false, text_path: expect.any(String) });
  });
  it('checks audio rather than a longer video container', async () => {
    const video = path.join(root, 'long.mp4');
    ff(['-f', 'lavfi', '-i', 'color=s=32x32:duration=4', '-i', source, '-c:v', 'mpeg4', '-c:a', 'aac', video]);
    await recognize([seg(0, 3000)]);
    // The 2 s of sound (2.048 s once AAC pads it) bound the times, not the 4 s container.
    const result: any = await transcribeSpeech({ inputAbsPath: video, transcriptAbsPath: output });
    expect(result.ok).toBe(true);
    expect(result.summary.segments[0].endSec).toBeGreaterThanOrEqual(2);
    expect(result.summary.segments[0].endSec).toBeLessThan(2.1);
  });
  it('places an untimed word in the gap between the words around it, as Chinese recognition often needs', async () => {
    // Shapes from the bundled whisper on Chinese speech (2026-11-14: 5 of 62 words in a talking-head
    // recording, 7 of 170 in a podcast): a point at the next word's start (非常), a point inside the gap
    // (和), two points in a row (現在只), and words at the segment's first and last edges.
    const tokens = [seg(200, 200, '今天'), seg(300, 500, '光'), seg(600, 600, '、'), seg(900, 900, '非常'), seg(900, 1100, '柔'),
      seg(1200, 1200, '和'), seg(1300, 1400, '适'), seg(1550, 1550, '現在'), seg(1700, 1700, '只'), seg(1800, 1950, '要'), seg(1990, 1990, '走')];
    await recognize([{ ...seg(0, 2000, '今天光、非常柔和适現在只要走'), tokens }]);
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, timestamps: 'word' });
    const expected = [
      { text: '今天', startSec: 0, endSec: 0.3 }, { text: '光、', startSec: 0.3, endSec: 0.6 }, { text: '非常', startSec: 0.6, endSec: 0.9 },
      { text: '柔', startSec: 0.9, endSec: 1.1 }, { text: '和', startSec: 1.1, endSec: 1.3 }, { text: '适', startSec: 1.3, endSec: 1.4 },
      { text: '現在', startSec: 1.4, endSec: 1.7 }, { text: '只', startSec: 1.7, endSec: 1.8 }, { text: '要', startSec: 1.8, endSec: 1.95 },
      { text: '走', startSec: 1.95, endSec: 2 },
    ];
    expect(result).toMatchObject({ ok: true, summary: { text: '今天光、非常柔和适現在只要走', words: expected } });
    expect(result).toHaveProperty('phrases');
    expect(JSON.parse(await fs.readFile(output, 'utf8')).words).toEqual(expected);
  });

  it('retains valid punctuation, subword merging, millisecond precision and empty recognition', async () => {
    await recognize([{ ...seg(0, 2000, 'Hello!'), tokens: [seg(0, 500, ' Hel'), seg(500, 1000, 'lo'), seg(1000, 1000, '!')] }]);
    const result = await transcribeSpeech({ inputAbsPath: source, timestamps: 'word' });
    expect(result).toMatchObject({ ok: true, summary: { words: [{ text: 'Hello!', startSec: 0, endSec: 1 }] } });
    await recognize([seg(0, 2001)]);
    expect(await transcribeSpeech({ inputAbsPath: source })).toMatchObject({ ok: true });
    await recognize([]);
    expect(await transcribeSpeech({ inputAbsPath: source })).toMatchObject({ ok: true, summary: { text: '', segments: [], words: [] } });
  });
});

it.runIf(process.env.ORKAS_REAL_WHISPER_TEST === '1').each([
  { file: 'jfk.wav', language: 'en', timestamps: 'segment' as const },
  { file: 'jfk.wav', language: 'en', timestamps: 'word' as const },
  { file: 'thchs30-D11_750.wav', language: 'zh', timestamps: 'word' as const },
])('validates real local $language $timestamps recognition without inventing word times', async ({ file, language, timestamps }) => {
  const result = await transcribeSpeech({ inputAbsPath: path.resolve(__dirname, '../../fixtures/voice', file), transcriptAbsPath: output, language, timestamps });
  if (language === 'en') {
    // The actual bundled DTW output gives "And" a point interval (220–220 ms), and
    // " so" starts at 330 ms (raw-runtime probe, 2026-11-14). It takes the room before
    // " so" and nothing past it; the old implementation stretched it into the next token.
    expect(result).toMatchObject({ ok: true, summary: { text: expect.stringContaining('fellow Americans') } });
    if (timestamps === 'word') {
      const first = (result.summary as any).words[0];
      expect(first.text).toBe('And');
      expect(first.startSec).toBeGreaterThanOrEqual(0);
      expect(first.endSec).toBeGreaterThan(first.startSec);
      expect(first.endSec).toBeLessThanOrEqual(0.33);
    }
  } else {
    expect(result).toMatchObject({ ok: true });
    expect(String((result.summary as any).text).length).toBeGreaterThan(5);
  }
}, 60000);

// 2026-11-23 VideoStudio benchmark: in a talk to camera, the five words after a 2.6 s pause were
// timed to end before they start (each from 38.4 s, ending 37.0-38.2 s), and the whole transcript
// was refused, so the talk got no subtitles; the last 2.5 s of silence was heard as
// "(字幕:J Chong)". Such words now take the time between their neighbours and are placed in the
// measured speech; a segment wholly inside measured silence is dropped.
describe.skipIf(process.platform === 'win32')('words timed backwards and lines heard in silence', () => {
  const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  const pause = [
    { ...seg(0, 1000, '前一句。'), tokens: [tok('前', 0, 400), tok('一句', 400, 900), tok('。', 900, 1000)] },
    // The run's own ends fall in order between the last word before it (1.0 s) and the next (1.4 s).
    { ...seg(1400, 2000, '第三個坑，把會員'), tokens: [tok('第三', 1400, 1100), tok('個', 1400, 1200), tok('坑', 1400, 1300), tok('，', 1400, 1350),
      tok('把', 1400, 1380), tok('會', 1400, 1600), tok('員', 1600, 2000), tok('[_TT_100]', 2000, 2000)] },
  ];

  it('checks long transcripts without rescanning every silence for each segment', () => {
    const size = 400;
    const rows = Array.from({ length: size }, (_, i) => seg(i * 100, i * 100 + 50, ' word'));
    let reads = 0;
    const silences = rows.map((_, i) => ({
      get startSec() { reads += 1; return 100 + i; },
      endSec: 100.5 + i,
    }));
    const input = { transcription: rows };
    expect(dropSegmentsHeardInSilence(input, silences)).toEqual({ parsed: input, dropped: [] });
    expect(reads).toBeLessThan(size * 20);
    const words = [seg(0, 1200, 'keep'), seg(1700, 1850, 'drop'), seg(1850, 2200, 'straddles'), seg(2200, 2400, 'keep')];
    const unordered = [{ startSec: 2, endSec: 2.2 }, { startSec: 1.65, endSec: 1.7 }, { startSec: 1.5, endSec: 2 }];
    expect(dropSegmentsHeardInSilence({ transcription: words }, unordered).dropped).toEqual(['drop']);
  });

  it('gives a backwards run the time between its neighbours, at its own end times when they are in order', () => {
    const { parsed, retimed } = retimeInvertedWords({ transcription: pause });
    expect(retimed).toBe(5);
    const tokens = ((parsed as any).transcription[1].tokens as any[]).map((token) => [token.text, token.offsets.from, token.offsets.to]);
    expect(tokens).toEqual([['第三', 1000, 1100], ['個', 1100, 1200], ['坑', 1200, 1300], ['，', 1300, 1350], ['把', 1350, 1380],
      ['會', 1400, 1600], ['員', 1600, 2000], ['[_TT_100]', 2000, 2000]]);
    // The segments and the other words are left as they came.
    expect((parsed as any).transcription[0]).toBe(pause[0]);
    expect((parsed as any).transcription[1].offsets).toEqual({ from: 1400, to: 2000 });
  });

  it('splits the time evenly when the run\'s own ends are out of order, and leaves a run with no time alone', () => {
    const shuffled = [{ ...seg(0, 2000), tokens: [tok('A', 0, 500), tok('b', 1100, 900), tok('c', 1100, 600), tok('d', 1100, 1500)] }];
    const even = retimeInvertedWords({ transcription: shuffled });
    expect(((even.parsed as any).transcription[0].tokens as any[]).map((token) => [token.offsets.from, token.offsets.to]))
      .toEqual([[0, 500], [500, 800], [800, 1100], [1100, 1500]]);
    const boxed = { transcription: [{ ...seg(0, 2000), tokens: [tok('A', 0, 1000), tok('b', 1000, 900), tok('c', 1000, 2000)] }] };
    expect(retimeInvertedWords(boxed)).toEqual({ parsed: boxed, retimed: 0 });
    const fine = { transcription: [{ ...seg(0, 2000), tokens: [tok('A', 0, 1000), tok('b', 1000, 1000), tok('c', 1000, 2000)] }] };
    expect(retimeInvertedWords(fine)).toEqual({ parsed: fine, retimed: 0 });
  });

  it('drops a segment wholly inside measured silence, unless too many are, or all', () => {
    const silences = [{ startSec: 0, endSec: 0.3 }, { startSec: 4.1, endSec: 6 }];
    const rows = [seg(300, 1200, '一'), seg(1200, 2400, '二'), seg(2400, 4100, '三'), seg(4400, 5600, '(字幕:J Chong)')];
    const kept = dropSegmentsHeardInSilence({ transcription: rows }, silences);
    expect(kept.dropped).toEqual(['(字幕:J Chong)']);
    expect((kept.parsed as any).transcription.map((row: any) => row.text)).toEqual(['一', '二', '三']);
    // Overlapping speech by more than 20 ms keeps a segment.
    expect(dropSegmentsHeardInSilence({ transcription: [...rows.slice(0, 3), seg(4000, 5600, '尾')] }, silences).dropped).toEqual([]);
    // One line in silence beside one spoken line is still dropped; two of three is too many.
    expect(dropSegmentsHeardInSilence({ transcription: [rows[0], rows[3]] }, silences).dropped).toEqual(['(字幕:J Chong)']);
    expect(dropSegmentsHeardInSilence({ transcription: [rows[0], rows[3], seg(4200, 4300, '又')] }, silences).dropped).toEqual([]);
    // The only line is never dropped.
    expect(dropSegmentsHeardInSilence({ transcription: [rows[3]] }, silences).dropped).toEqual([]);
    // A recording quieter than the pause threshold reads as silence throughout: nothing goes.
    const quiet = [{ startSec: 0, endSec: 6 }];
    expect(dropSegmentsHeardInSilence({ transcription: rows }, quiet).dropped).toEqual([]);
    expect(dropSegmentsHeardInSilence({ transcription: rows }, []).dropped).toEqual([]);
  });

  it('keeps the transcript whole: the backwards words timed between their neighbours, the line heard in silence gone', async () => {
    // Sound 0-1.2 s, then silence to 2 s.
    const talk = path.join(root, 'talk.wav');
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)*lt(t,1.2)':s=16000:d=2", '-y', talk]);
    await recognize([
      { ...seg(0, 1150, 'Real words here.'), tokens: [tok(' Real', 0, 300), tok(' words', 700, 450), tok(' here', 700, 600), tok('.', 700, 1150)] },
      { ...seg(1300, 1950, '(字幕:J Chong)'), tokens: [tok('(字幕:J Chong)', 1300, 1950)] },
    ]);
    const result: any = await transcribeSpeech({ inputAbsPath: talk, transcriptAbsPath: output, timestamps: 'word' });
    expect(result).toMatchObject({ ok: true, summary: { text: 'Real words here.' } });
    expect(result.summary.words).toEqual([
      { text: 'Real', startSec: 0, endSec: 0.3 }, { text: 'words', startSec: 0.3, endSec: 0.45 }, { text: 'here.', startSec: 0.45, endSec: 1.15 },
    ]);
    expect(JSON.parse(await fs.readFile(output, 'utf8')).segments).toEqual([{ text: 'Real words here.', startSec: 0, endSec: 1.15 }]);
  });
});

// 2026-11-24: the bundled model wrote Mandarin in Traditional characters and misheard more
// (會員/採過康 for 会员/踩过坑); an opening sentence in the account's script fixed both.
const SIMPLIFIED = '以下是普通话的句子。';
const TRADITIONAL = '以下是普通話的句子。';

it('chooses the sentence by the account\'s script and passes it to the recognizer', () => {
  expect(chineseTranscriptPrompt('zh')).toBe(SIMPLIFIED);
  expect(chineseTranscriptPrompt('en')).toBe(SIMPLIFIED);
  expect(chineseTranscriptPrompt('zh-tw')).toBe(TRADITIONAL);
  const args = buildSpeechTranscribeArgs('/m.bin', '/a.wav', '/out', { language: 'zh', timestamps: 'word', prompt: SIMPLIFIED });
  expect(args.slice(args.indexOf('--prompt'), args.indexOf('--prompt') + 2)).toEqual(['--prompt', SIMPLIFIED]);
  expect(buildSpeechTranscribeArgs('/m.bin', '/a.wav', '/out', { language: 'en', timestamps: 'word' })).not.toContain('--prompt');
});

describe.skipIf(process.platform === 'win32')('Chinese read in the account\'s script', () => {
  let priorLang: ReturnType<typeof getCurrentLang>;
  beforeEach(() => { priorLang = getCurrentLang(); });
  afterEach(() => { setCurrentLang(priorLang); });
  /** A recognizer that answers with `plain` without a prompt and `prompted` with one, failing
   *  prompted runs when told to; every call's arguments are kept. */
  async function readers(plain: unknown, prompted: unknown, failPrompted = false) {
    await fs.writeFile(path.join(root, 'plain.json'), JSON.stringify(plain));
    await fs.writeFile(path.join(root, 'prompted.json'), JSON.stringify(prompted));
    const cli = path.join(root, 'whisper');
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'calls.jsonl'),JSON.stringify(a)+'\\n');
const prompted=a.includes('--prompt');
if(prompted&&${failPrompted ? 'true' : 'false'}){process.stderr.write('failed');process.exit(2);}
if(a.includes('-of'))fs.copyFileSync(path.join(__dirname,prompted?'prompted.json':'plain.json'),a[a.indexOf('-of')+1]+'.json');
`); await fs.chmod(cli, 0o755);
    process.env.ORKAS_WHISPER_CPP = cli; process.env.ORKAS_WHISPER_MODEL = path.join(root, 'plain.json');
  }
  const calls = async () => (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
  const promptOf = (args: string[]) => (args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : undefined);
  const traditional = { result: { language: 'zh' }, transcription: [seg(0, 2000, '會員')] };
  const simplified = { result: { language: 'zh' }, transcription: [seg(0, 2000, '会员')] };
  const invalidTail = { result: { language: 'zh' }, transcription: [{
    ...seg(0, 1990, '会员到了'),
    tokens: [seg(0, 500, '会'), seg(500, 1000, '员'), seg(1000, 1990, '到'), seg(1990, 1990, '了')],
  }] };

  it('reads Chinese asked for by language with the sentence at once, in Traditional for a Traditional account', async () => {
    setCurrentLang('zh');
    await readers(traditional, simplified);
    const result: any = await transcribeSpeech({ inputAbsPath: source, language: 'zh-CN' });
    expect(result).toMatchObject({ ok: true, summary: { text: '会员' } });
    expect((await calls()).map(promptOf)).toEqual([SIMPLIFIED]);
    await fs.rm(path.join(root, 'calls.jsonl'));
    setCurrentLang('zh-tw');
    await transcribeSpeech({ inputAbsPath: source, language: 'zh' });
    expect((await calls()).map(promptOf)).toEqual([TRADITIONAL]);
  });

  it('recovers a specified Chinese transcript with a zero-length final word using the same audio and language', async () => {
    setCurrentLang('zh');
    const plain = { result: { language: 'zh' }, transcription: [
      seg(100, 800, '會員'), seg(1000, 1700, '到了'),
    ] };
    await readers(plain, invalidTail);
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, language: 'zh-CN', timestamps: 'word' });
    const segments = [
      { text: '會員', startSec: 0.1, endSec: 0.8 },
      { text: '到了', startSec: 1, endSec: 1.7 },
    ];
    expect(result).toMatchObject({ ok: true, summary: { text: '會員 到了', segments } });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).segments).toEqual(segments);
    const attempts = await calls();
    expect(attempts.map(promptOf)).toEqual([SIMPLIFIED, undefined]);
    expect(attempts.map(args => args[args.indexOf('-l') + 1])).toEqual(['zh', 'zh']);
    expect(attempts[0][attempts[0].indexOf('-f') + 1]).toBe(attempts[1][attempts[1].indexOf('-f') + 1]);
  });

  it.each([
    ['empty', []],
    ['invalid timing', [seg(0, 0, '第二次识别')]],
  ])('preserves the first Chinese text and existing timing when recovery returns %s', async (_name, rows) => {
    setCurrentLang('zh');
    await readers({ result: { language: 'zh' }, transcription: rows }, invalidTail);
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, language: 'zh' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT', timing_valid: false, text: '会员到了' });
    expect(await fs.readFile(String(result.text_path), 'utf8')).toBe('会员到了\n');
    expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
    expect((await calls()).map(promptOf)).toEqual([SIMPLIFIED, undefined]);
  });

  it('keeps a malformed first result as a regular transcription failure', async () => {
    setCurrentLang('zh');
    await readers(traditional, { result: { language: 'zh' }, transcription: [null] });
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, language: 'zh' });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT' });
    expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
    expect((await calls()).map(promptOf)).toEqual([SIMPLIFIED]);
  });

  it('reads a recording heard as Chinese once more with the sentence, and keeps the first reading when that fails', async () => {
    setCurrentLang('zh');
    await readers(traditional, simplified);
    const result: any = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output });
    expect(result).toMatchObject({ ok: true, summary: { text: '会员' } });
    const [first, second] = await calls();
    expect(promptOf(first)).toBeUndefined();
    expect(first[first.indexOf('-l') + 1]).toBe('auto');
    expect(promptOf(second)).toBe(SIMPLIFIED);
    expect(second[second.indexOf('-l') + 1]).toBe('zh');
    expect(JSON.parse(await fs.readFile(output, 'utf8')).text).toBe('会员');

    await fs.rm(path.join(root, 'calls.jsonl'));
    await readers(traditional, simplified, true);
    expect(await transcribeSpeech({ inputAbsPath: source })).toMatchObject({ ok: true, summary: { text: '會員' } });
    expect(await calls()).toHaveLength(2);
  });

  it.each([
    ['empty', []],
    ['malformed', [null]],
    ['invalid timing', [seg(0, 0, '会员')]],
  ])('keeps the usable first transcript after a successful process returns %s Chinese output', async (_name, rows) => {
    await readers(traditional, { result: { language: 'zh' }, transcription: rows });
    const result = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output });
    expect(result).toMatchObject({ ok: true, summary: { text: '會員' } });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).text).toBe('會員');
    expect(await calls()).toHaveLength(2);
  });

  it('reads other languages once and as they were', async () => {
    setCurrentLang('zh');
    await readers({ result: { language: 'en' }, transcription: [seg(0, 2000, 'Hello there.')] }, simplified);
    expect(await transcribeSpeech({ inputAbsPath: source })).toMatchObject({ ok: true, summary: { text: 'Hello there.' } });
    expect((await calls()).map(promptOf)).toEqual([undefined]);
  });
});

// 2026-11-17 VideoStudio benchmark: the recognizer put words on the wrong side of measured pauses,
// so a false start read as the end of the sentence before it and the retake cleanup kept it. The
// transcript now places each word in the measured speech it was spoken in, guided by each span
// recognized on its own; the words themselves and the sentence text stay the recognizer's.
describe.skipIf(process.platform === 'win32')('placing transcript words in the measured speech', () => {
  const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  // Late word times, as whisper.cpp gives them: "there." starts in the pause and ends in the next
  // span; "I" starts in the second pause.
  const DRIFTED = [{ ...seg(300, 3900, ' Hello there. I mean I mean it.'), tokens: [
    tok(' Hello', 300, 800), tok(' there', 1100, 1650), tok('.', 1650, 1700), tok(' I', 1700, 1900), tok(' mean', 1900, 2600),
    tok(' I', 2600, 2850), tok(' mean', 2850, 3200), tok(' it', 3200, 3800), tok('.', 3800, 3900),
  ] }];
  const RECOGNIZED = [
    { text: 'Hello', startSec: 0.3, endSec: 0.8 }, { text: 'there.', startSec: 1.1, endSec: 1.7 }, { text: 'I', startSec: 1.7, endSec: 1.9 },
    { text: 'mean', startSec: 1.9, endSec: 2.6 }, { text: 'I', startSec: 2.6, endSec: 2.85 }, { text: 'mean', startSec: 2.85, endSec: 3.2 },
    { text: 'it.', startSec: 3.2, endSec: 3.9 },
  ];
  // Speech at 0.3–1.0, 1.6–2.4 and 2.7–3.6 s of a 4 s file.
  const speech = (file: string) => ff(['-f', 'lavfi', '-i',
    "aevalsrc='0.4*sin(2*PI*440*t)*(between(t,0.3,1.0)+between(t,1.6,2.4)+between(t,2.7,3.6))':s=16000:d=4", '-y', file]);
  // One recognizer: the whole file when asked for `-of`, otherwise one result per `-f` input in order.
  async function recognizer(spans: { mode: 'texts' | 'fail' | 'wait'; texts?: string[] }) {
    await fs.writeFile(path.join(root, 'raw.json'), JSON.stringify({ result: { language: 'en' }, transcription: DRIFTED }));
    await fs.writeFile(path.join(root, 'spans.json'), JSON.stringify(spans));
    const cli = path.join(root, 'whisper');
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'calls.jsonl'),JSON.stringify(a)+'\\n');
if(a.includes('-of')){fs.copyFileSync(path.join(__dirname,'raw.json'),a[a.indexOf('-of')+1]+'.json');process.exit(0);}
const spans=JSON.parse(fs.readFileSync(path.join(__dirname,'spans.json'),'utf8'));
if(spans.mode==='fail'){process.stderr.write('recognizer crashed');process.exit(3);}
if(spans.mode==='wait'){fs.writeFileSync(path.join(__dirname,'waiting'),'');setTimeout(()=>{},30000);return;}
const inputs=a.flatMap((v,i)=>v==='-f'?[a[i+1]]:[]);
inputs.forEach((f,i)=>fs.writeFileSync(f+'.json',JSON.stringify({transcription:[{text:' '+(spans.texts[i]??''),offsets:{from:0,to:500}}]})));
`); await fs.chmod(cli, 0o755);
    process.env.ORKAS_WHISPER_CPP = cli; process.env.ORKAS_WHISPER_MODEL = path.join(root, 'raw.json');
  }
  const calls = async () => (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  const inside = (word: { startSec: number; endSec: number }, from: number, to: number) =>
    word.startSec >= from - 0.02 && word.endSec <= to + 0.02;

  it('moves a word recognized across a pause into the speech it was spoken in, keeping the words and text', async () => {
    const talk = path.join(root, 'talk.wav'); speech(talk);
    await recognizer({ mode: 'texts', texts: ['Hello there.', 'I mean', 'I mean it.'] });
    const result: any = await transcribeSpeech({ inputAbsPath: talk, transcriptAbsPath: output, timestamps: 'word' });
    expect(result).toMatchObject({ ok: true, summary: { text: 'Hello there. I mean I mean it.' } });
    const saved = JSON.parse(await fs.readFile(output, 'utf8'));
    expect(saved.words.map((word: any) => word.text)).toEqual(RECOGNIZED.map(word => word.text));
    expect(saved.segments).toEqual([{ text: 'Hello there. I mean I mean it.', startSec: 0.3, endSec: 3.9 }]);
    const [hello, there, i1, mean1, i2, mean2, it] = saved.words;
    for (const word of [hello, there]) expect(inside(word, 0.3, 1.0)).toBe(true);
    for (const word of [i1, mean1]) expect(inside(word, 1.6, 2.4)).toBe(true);
    for (const word of [i2, mean2, it]) expect(inside(word, 2.7, 3.6)).toBe(true);
    expect(result.summary.words).toEqual(saved.words);
    expect(result.phrases.text.split('\n').map((row: string) => row.replace(/^\[[^\]]+\] /, ''))).toEqual([
      'Hello there.', '  — 0.60s —', 'I mean (0.30s) I mean it.',
    ]);
    // The spans are recognized once, in the language of the whole file, one input per span.
    const [whole, spanRun] = await calls();
    expect(whole).toContain('-of');
    expect(spanRun.filter(arg => arg === '-f')).toHaveLength(3);
    expect(spanRun[spanRun.indexOf('-l') + 1]).toBe('en');
    expect(await calls()).toHaveLength(2);
  });

  it.each([
    { label: 'the span recognizer fails', spans: { mode: 'fail' as const } },
    { label: 'the spans are recognized as something else', spans: { mode: 'texts' as const, texts: ['Thank you.', 'Thank you.', 'Thank you.'] } },
  ])('keeps the recognized word times when $label', async ({ spans }) => {
    const talk = path.join(root, 'talk.wav'); speech(talk);
    await recognizer(spans);
    const result: any = await transcribeSpeech({ inputAbsPath: talk, transcriptAbsPath: output, timestamps: 'word' });
    expect(result).toMatchObject({ ok: true, summary: { words: RECOGNIZED } });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).words).toEqual(RECOGNIZED);
    expect(await calls()).toHaveLength(2);
  });

  it('keeps the recognized word times when the span audio cannot be written', async () => {
    const talk = path.join(root, 'talk.wav'); speech(talk);
    await recognizer({ mode: 'texts', texts: ['Hello there.', 'I mean', 'I mean it.'] });
    const original = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (...args: any[]) => {
      if (/[\\/]spans[\\/]\d+\.wav$/.test(String(args[0]))) throw Object.assign(new Error('Controlled span write failure'), { code: 'ENOSPC' });
      return (original as any)(...args);
    }) as any);
    syncBuiltinESMExports();
    try {
      const result: any = await transcribeSpeech({ inputAbsPath: talk, transcriptAbsPath: output, timestamps: 'word' });
      expect(result).toMatchObject({ ok: true, summary: { words: RECOGNIZED } });
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(JSON.parse(await fs.readFile(output, 'utf8')).words).toEqual(RECOGNIZED);
    expect(await calls()).toHaveLength(1);
  });

  it('stops without writing when cancelled while the spans are recognized', async () => {
    const talk = path.join(root, 'talk.wav'); speech(talk);
    await recognizer({ mode: 'wait' });
    const controller = new AbortController();
    const pending = transcribeSpeech({ inputAbsPath: talk, transcriptAbsPath: output, timestamps: 'word', signal: controller.signal });
    for (let i = 0; i < 200 && !(await fs.stat(path.join(root, 'waiting')).catch(() => null)); i++) await new Promise(r => setTimeout(r, 25));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
  });

  it.each([
    { label: 'at the span limit', extra: 0, runs: 2 },
    { label: 'above the span limit', extra: 1, runs: 1 },
  ])('recognizes the spans again only $label or below', async ({ extra, runs }) => {
    // Bursts of 0.12 s every 0.3 s: each 0.18 s gap is a measured pause.
    const count = WORD_PLACEMENT_MAX_SPANS + extra, many = path.join(root, 'many.wav');
    ff(['-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,0.3),0.12)':s=16000:d=${(count * 0.3).toFixed(1)}`, '-y', many]);
    await recognizer({ mode: 'texts', texts: [] });
    expect(await transcribeSpeech({ inputAbsPath: many, transcriptAbsPath: output, timestamps: 'word' })).toMatchObject({ ok: true });
    expect(await calls()).toHaveLength(runs);
    if (runs === 2) expect((await calls())[1].filter(arg => arg === '-f')).toHaveLength(count);
  }, 60000);
});

// 2026-11-19: 128 of 263 real transcripts (narrated deliveries, voice lines and source
// footage from two days of runs) were refused whole for times past the end of the audio:
// 60 by 2-100 ms, 44 by a last segment running to the recognizer's window while its words
// ended inside, 17 by the last words, and never more than 5 words starting after the end
// (5 of 89). An end past the audio now ends with it, words starting after it are left out of
// the words, and timing is still refused when many words start after the end.
describe.skipIf(process.platform === 'win32')('times past the end of the recording', () => {
  // Ten words inside, the last running past the end, and one starting after it: within the 10%.
  const inside = ['One', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((word, index) => seg(index * 200, index * 200 + 200, ` ${word}`));
  const late = [{ ...seg(0, 3000, 'One to nine last gone.'), tokens: [...inside, seg(1800, 2600, ' last.'), seg(2100, 2600, ' gone')] }];

  it.each([
    { label: 'a segment past the end', rows: [seg(0, 3000)], segments: [{ text: 'Keep recognized words.', startSec: 0, endSec: 2 }] },
    { label: 'a last segment and word past the end', rows: late, segments: [{ text: 'One to nine last gone.', startSec: 0, endSec: 2 }] },
  ])('ends $label with the recording and keeps the transcript', async ({ rows, segments }) => {
    await recognize(rows);
    const result: any = await transcribeSpeech({ inputAbsPath: source, transcriptAbsPath: output, timestamps: 'word' });
    expect(result.ok).toBe(true);
    expect(result.summary.segments).toEqual(segments);
    expect(JSON.parse(await fs.readFile(output, 'utf8')).segments).toEqual(segments);
  });

  it('leaves a word that starts after the end out of the words, and keeps its text', async () => {
    await recognize(late);
    const result: any = await transcribeSpeech({ inputAbsPath: source, timestamps: 'word' });
    expect(result.summary.words.slice(-2).map((word: any) => [word.text.trim(), word.endSec])).toEqual([['nine', 1.8], ['last.', 2]]);
    expect(result.summary.words.map((word: any) => word.text.trim())).not.toContain('gone');
    expect(result.summary.text).toBe('One to nine last gone.');
  });
});

// Looking at frames takes times more loosely still: words the recognizer gave no room for a
// time are left out instead of refusing the transcript. Subtitles and cuts keep the check.
describe.skipIf(process.platform === 'win32')('loose times, only for looking at frames', () => {
  const pinned = [{ ...seg(0, 2000, 'First a b end.'), tokens: [seg(0, 1000, ' First'), seg(1000, 1000, ' a'), seg(1000, 1000, ' b'), seg(1000, 2000, ' end.')] }];

  it('still rejects words with no room for their time by default', async () => {
    await recognize(pinned);
    expect(await transcribeSpeech({ inputAbsPath: source, timestamps: 'word' }))
      .toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT', timing_valid: false });
  });

  it('leaves out words it cannot time and keeps the rest', async () => {
    await recognize(pinned);
    const result: any = await transcribeSpeech({ inputAbsPath: source, timestamps: 'word', looseTiming: true });
    expect(result.ok).toBe(true);
    expect(result.summary.words.map((word: any) => word.text.trim())).toEqual(['First', 'end.']);
    expect(result.summary.segments[0].text).toBe('First a b end.');
  });
});
