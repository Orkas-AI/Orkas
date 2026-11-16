import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { transcribeSpeech } from '../../../src/main/features/video_studio';
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
    { label: 'past the decoded audio end', rows: [seg(0, 3000)] },
    { label: 'reversed segments', rows: [seg(1000, 1500, 'First.'), seg(0, 500, 'Second.')] },
    { label: 'overlapping segments', rows: [seg(0, 1200), seg(1000, 1800)] },
    { label: 'zero duration', rows: [seg(0, 0)] },
    { label: 'negative start', rows: [seg(-100, 500)] },
    { label: 'word token past source end', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(1000, 3000, ' second')] }] },
    { label: 'word token missing time', rows: [{ ...seg(0, 2000), tokens: [{ text: ' First', offsets: { from: null, to: 1000 } }] }] },
    { label: 'untimed word with no room between its neighbours', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(1000, 1000, ' lost'), seg(1000, 2000, ' second')] }] },
    { label: 'untimed word before the previous word ends', rows: [{ ...seg(0, 2000), tokens: [seg(0, 1000, ' First'), seg(500, 500, ' early'), seg(1000, 2000, ' second')] }] },
    { label: 'untimed word after the next word starts', rows: [{ ...seg(0, 2000), tokens: [seg(0, 500, ' First'), seg(1200, 1200, ' late'), seg(1000, 2000, ' second')] }] },
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
    await recognize([seg(0, 3000)]); const before = await fs.readdir(root);
    const result = await transcribeSpeech({ inputAbsPath: source });
    expect(result).toMatchObject({ ok: false, timing_valid: false, text: 'Keep recognized words.' });
    expect(result).not.toHaveProperty('text_path'); expect(await fs.readdir(root)).toEqual([...before, 'calls'].sort());
  });
  it('cleans an interrupted text candidate and keeps the old JSON for explicit retry', async () => {
    await recognize([seg(0, 3000)]); const original = fs.writeFile.bind(fs); let injected = false;
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
    expect(await transcribeSpeech({ inputAbsPath: video, transcriptAbsPath: output })).toMatchObject({ ok: false, timing_valid: false });
    expect(await fs.readFile(output, 'utf8')).toBe('{"text":"Prior result"}\n');
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
