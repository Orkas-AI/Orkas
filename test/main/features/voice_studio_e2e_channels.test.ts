import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { bundledRuntimeEnv, bundledNodeExecutable } from '../../../src/main/util/bundled-runtime';

const require = createRequire(import.meta.url);
const script = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
const audio = require(script);
let root: string, project: string, prior: NodeJS.ProcessEnv;
const rate = 48000;
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-channels-')));
  project = path.join(root, 'voice-project.json');
});
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });
// Author each channel independently; a stereo source with identical channels
// would miss channel swaps, crosstalk and an inappropriate universal gain fix.
async function source(name: string, seconds: number, signals: Array<(t: number) => number>) {
  const frames = Math.round(seconds * rate), channels = signals.length, stride = channels * 2;
  const b = Buffer.alloc(44 + frames * stride);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * stride, 28); b.writeUInt16LE(stride, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(frames * stride, 40);
  for (let i = 0; i < frames; i++) signals.forEach((s, c) => b.writeInt16LE(Math.round(s(i / rate) * 32767), 44 + i * stride + c * 2));
  await fs.writeFile(path.join(root, name), b); return b;
}
const tone = (hz: number, gain = .2) => (t: number) => gain * Math.sin(2 * Math.PI * hz * t);
async function save(extra: any = {}) {
  await fs.writeFile(project, JSON.stringify({ schema_version: 3, roles: {}, segments: [{ id: 'voice', path: 'voice.wav' }],
    export: { format: 'wav', channels: 1, normalize_loudness: false }, ...extra }));
}
function ff(args: string[]) {
  const r = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  expect(r.status, r.stderr?.toString()).toBe(0); expect(r.stderr?.length).toBe(0); return r.stdout;
}
const pcm = (file: string) => ff(['-i', file, '-c:a', 'pcm_s16le', '-f', 's16le', '-']);
async function render(fields = {}) {
  const r = await audio.execute('render', { project, ...fields });
  return { r, file: path.join(root, r.files[0]), receipt: JSON.parse(await fs.readFile(path.join(root, r.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8')) };
}
function amp(b: Buffer, at: number, hz: number, channel = 0, channels = 1) {
  let re = 0, im = 0; const n = rate / 5, offset = Math.round(at * rate);
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(((offset + i) * channels + channel) * 2) / 32768;
    re += v * Math.cos(2 * Math.PI * hz * i / rate); im += v * Math.sin(2 * Math.PI * hz * i / rate);
  }
  return 2 * Math.hypot(re, im) / n;
}
it.each([1, 2, 3])('retains exact mono samples through a schema %i trim and fresh-process re-export', async schema_version => {
  const b = await source('voice.wav', 2, [t => t < 1 ? tone(440)(t) : tone(660)(t)]);
  await save({ schema_version, segments: [{ id: 'cut', path: 'voice.wav', start_sec: .5, end_sec: 1.5 }], export: { format: 'wav' } });
  const plan = await fs.readFile(project), first = await render(), expected = b.subarray(44 + rate, 44 + rate * 3);
  expect(first.r.channels).toBe(1); expect(pcm(first.file).equals(expected), 'Retained mono PCM must match the source samples.').toBe(true);
  await fs.writeFile(path.join(root, 'request.json'), JSON.stringify({ project }));
  const node = bundledNodeExecutable(); expect(node).toBeTruthy();
  const next = spawnSync(node!, [script, 'render', path.join(root, 'request.json')], { env: process.env, encoding: 'utf8', timeout: 30000 });
  expect(next.status, next.stderr).toBe(0); expect(next.stderr).toBe('');
  const reopened = JSON.parse(next.stdout);
  expect(reopened.channels).toBe(1);
  expect(pcm(path.join(root, reopened.files[0])).equals(expected)).toBe(true);
  expect(await fs.readFile(project)).toEqual(plan); expect(await fs.readFile(path.join(root, 'voice.wav'))).toEqual(b);
});
it.each([undefined, 1, 2])('keeps distinct stereo channel levels with export.channels set to %s', async channels => {
  const b = await source('voice.wav', 1, [tone(330, .16), tone(880, .08)]);
  await save({ export: { format: 'wav', channels, normalize_loudness: false } });
  const result = await render(), actual = pcm(result.file); expect(result.r.channels).toBe(channels ?? 2);
  if (channels !== 1) expect(actual).toEqual(b.subarray(44));
  else { expect(amp(actual, .2, 330)).toBeCloseTo(.08, 3); expect(amp(actual, .2, 880)).toBeCloseTo(.04, 3); }
});
it.each([
  { type: 'denoise', strength: 'light' }, { type: 'highpass', frequency_hz: 20 },
  { type: 'deesser', strength: 'light' }, { type: 'compressor', threshold_db: 0, ratio: 1 },
  { type: 'silence', mode: 'edges', min_silence_sec: .2, padding_sec: 0 },
])('preserves mono passband level through $type, cache reuse and undo', async step => {
  const b = await source('voice.wav', 2, [t => t >= .5 && t < 1.5 ? tone(660)(t) : 0]);
  await save({ processing: [step] }); const first = await render(), actual = pcm(first.file);
  expect(first.r.channels).toBe(1); expect(amp(actual, .6, 660)).toBeGreaterThan(.18); expect(amp(actual, .6, 660)).toBeLessThan(.205);
  const reused = await render(); expect(reused.receipt.processing[0].reused).toBe(true); expect(pcm(reused.file)).toEqual(actual);
  await save({ processing: [] }); expect(pcm((await render()).file)).toEqual(b.subarray(44));
  expect(pcm(first.file)).toEqual(actual); expect(await fs.readFile(path.join(root, 'voice.wav'))).toEqual(b);
});
it('switches export channels without changing the saved profile or attenuating a cached mono result', async () => {
  await source('voice.wav', 1, [tone(660)]);
  await save({ processing: [{ type: 'compressor', ratio: 1 }], export: { format: 'wav' } });
  const plan = await fs.readFile(project);
  const mono = await render(), stereo = await render({ export: { channels: 2 } }), restored = await render();
  expect(mono.r.channels).toBe(1); expect(amp(pcm(mono.file), .2, 660)).toBeCloseTo(.2, 3);
  expect(stereo.r.channels).toBe(2);
  expect(mono.receipt.export.channels).toBe(1); expect(stereo.receipt.export.channels).toBe(2);
  for (const channel of [0, 1]) expect(amp(pcm(stereo.file), .2, 660, channel, 2)).toBeCloseTo(.2 / Math.sqrt(2), 3);
  expect(restored.receipt.processing[0].reused).toBe(true); expect(pcm(restored.file)).toEqual(pcm(mono.file));
  expect(await fs.readFile(project)).toEqual(plan);
});
it('retains stereo as the implicit layout for multiple recorded segments', async () => {
  await source('voice.wav', 1, [tone(440)]);
  await source('other.wav', 1, [tone(660)]);
  await save({ segments: [{ id: 'first', path: 'voice.wav' }, { id: 'second', path: 'other.wav' }], export: { format: 'wav' } });
  const result = await render();
  expect(result.r.channels).toBe(2);
  const samples = pcm(result.file);
  expect(samples.length).toBe(2 * rate * 2 * 2);
  for (const channel of [0, 1]) {
    expect(amp(samples, .2, 440, channel, 2)).toBeCloseTo(.2 / Math.sqrt(2), 3);
    expect(amp(samples, 1.2, 660, channel, 2)).toBeCloseTo(.2 / Math.sqrt(2), 3);
  }
});
it.each(['legacy', 'timeline'])('preserves mono speech and stereo music levels in the %s mixer with optional ducking', async mixer => {
  await source('voice.wav', 3, [t => t >= 1 && t < 2 ? tone(660)(t) : 0]);
  await source('music.wav', 3, [tone(220, .04), tone(330, .04)]);
  const mix = (duck: boolean) => mixer === 'legacy' ? { music: { path: 'music.wav', volume: 1, duck } }
    : { tracks: [{ id: 'bg', kind: 'music', path: 'music.wav', volume: 1, duck }] };
  await save(mix(false)); const plain = pcm((await render()).file);
  await save(mix(true)); const ducked = pcm((await render()).file);
  for (const hz of [220, 330]) {
    expect(amp(plain, .2, hz)).toBeCloseTo(.02, 3); expect(amp(plain, 1.4, hz)).toBeCloseTo(.02, 3);
    expect(amp(ducked, 1.4, hz) / amp(plain, 1.4, hz)).toBeLessThan(.4);
    expect(amp(ducked, .2, hz)).toBeCloseTo(.02, 3);
  }
  expect(amp(plain, 1.4, 660)).toBeCloseTo(.2, 3); expect(amp(ducked, 1.4, 660)).toBeCloseTo(.2, 3);
});
it('preserves exact retained mono word samples before the render stage', async () => {
  const b = await source('voice.wav', 2, [t => t < 1 ? tone(440)(t) : tone(660)(t)]);
  await fs.writeFile(path.join(root, 'words.json'), JSON.stringify({ schema_version: 1, granularity: 'word', timing: 'estimated',
    source_sha256: createHash('sha256').update(b).digest('hex'), segments: [{ text: 'first', start_sec: 0, end_sec: 1 }, { text: 'second', start_sec: 1, end_sec: 2 }] }));
  await save({ segments: [{ id: 'words', path: 'voice.wav', word_edit: { transcript_path: 'words.json', mode: 'keep', ranges: [{ first: 1, last: 1 }] } }] });
  const result = await render(); expect(result.r.channels).toBe(1); expect(pcm(result.file).equals(b.subarray(44 + rate * 2))).toBe(true);
});
it('normalizes an overlapping mono mix without clipping its intermediate signal', async () => {
  await source('voice.wav', 2, [tone(660, .2)]);
  await save({ segments: [{ id: 'voice', path: 'voice.wav', volume: 2 }], tracks: [{ id: 'fx', kind: 'effect', path: 'voice.wav', volume: 4 }],
    export: { format: 'wav', channels: 1, normalize_loudness: true } });
  const result = await render(), b = pcm(result.file); expect(result.r.channels).toBe(1);
  expect(amp(b, .5, 660)).toBeGreaterThan(.05); expect(amp(b, .5, 1980) / amp(b, .5, 660)).toBeLessThan(.002);
  let peak = 0; for (let i = 0; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i) / 32768));
  expect(peak).toBeLessThan(10 ** (-1.5 / 20) + .002);
});
