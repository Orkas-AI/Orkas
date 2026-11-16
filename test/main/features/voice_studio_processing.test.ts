import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
const exec = promisify(execFile);
let root: string, project: string, prior: NodeJS.ProcessEnv;
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-processing-')));
  project = path.join(root, 'voice-project.json');
});
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });
// Source timing and frequencies are authored independently of the processing code.
function wav(parts: Array<{ seconds: number; hz?: number; amplitude?: number; noise?: number }>) {
  const rate = 48000, count = parts.reduce((n, p) => n + Math.round(p.seconds * rate), 0);
  const b = Buffer.alloc(44 + count * 4); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(count * 4, 40);
  let offset = 0, seed = 7;
  for (const p of parts) for (let i = 0; i < Math.round(p.seconds * rate); i++, offset++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const n = (seed / 0xffffffff * 2 - 1) * (p.noise || 0);
    const v = Math.max(-.99, Math.min(.99, (p.hz ? Math.sin(i * 2 * Math.PI * p.hz / rate) * (p.amplitude ?? .2) : 0) + n));
    b.writeInt16LE(Math.round(v * 32767), 44 + offset * 4); b.writeInt16LE(Math.round(v * 32767), 46 + offset * 4);
  }
  return b;
}
async function setup(parts: Parameters<typeof wav>[0], processing: any[], extra = {}) {
  const source = wav(parts); await fs.writeFile(path.join(root, 'source.wav'), source);
  await fs.writeFile(project, JSON.stringify({ schema_version: 2, roles: {}, segments: [{ id: 'recording', path: 'source.wav' }], processing, ...extra }));
  return source;
}
async function render() {
  const result = await audio.execute('render', { project, format: 'wav' });
  const receipt = JSON.parse(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8'));
  return { result, receipt, file: path.join(root, result.files[0]) };
}
async function pcm(file: string) {
  const { stdout, stderr } = await exec(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  expect(stderr.length).toBe(0); return stdout;
}
function energy(b: Buffer, start: number, length: number, hz?: number) {
  let a = 0, c = 0; const n = Math.floor(length * 48000), off = Math.floor(start * 48000);
  for (let i = 0; i < n; i++) { const v = b.readFloatLE((off + i) * 4); if (hz) { a += v * Math.cos(i * 2 * Math.PI * hz / 48000); c += v * Math.sin(i * 2 * Math.PI * hz / 48000); } else a += v * v; }
  return hz ? Math.hypot(a, c) / n : Math.sqrt(a / n);
}
it('trims only the edges, retaining quiet content, short and long internal pauses and the source', async () => {
  const source = await setup([{ seconds: .5 }, { seconds: .7, hz: 440, amplitude: .025 }, { seconds: 1.2 }, { seconds: .7, hz: 660 }, { seconds: .5 }], [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: .05 }]);
  const { result, receipt, file } = await render();
  expect(result.duration_sec).toBeCloseTo(2.7, 1);
  const signal = await pcm(file); expect(energy(signal, .15, .2, 440)).toBeGreaterThan(.005); expect(energy(signal, 2.1, .2, 660)).toBeGreaterThan(.02);
  expect(receipt.processing[0].time_map[0]).toMatchObject({ input_start_sec: expect.closeTo(.45, 1), output_start_sec: 0 });
  expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(source);
});
it('compresses internal long pauses without removing edges or a short natural pause', async () => {
  await setup([{ seconds: .4 }, { seconds: .6, hz: 440 }, { seconds: .2 }, { seconds: .6, hz: 660 }, { seconds: 1.4 }, { seconds: .6, hz: 880 }, { seconds: .4 }], [{ type: 'silence', mode: 'compress', min_silence_sec: .8, keep_sec: .3 }]);
  const { result, receipt, file } = await render(); expect(result.duration_sec).toBeCloseTo(3.1, 1);
  expect(receipt.processing[0].removed_sec).toBeCloseTo(1.1, 1);
  const b = await pcm(file); expect(energy(b, .5, .2, 440)).toBeGreaterThan(.02); expect(energy(b, 1.3, .2, 660)).toBeGreaterThan(.02); expect(energy(b, 2.2, .2, 880)).toBeGreaterThan(.02);
});
it('reuses an unchanged processing result and invalidates a changed setting or corrupt cached output', async () => {
  await setup([{ seconds: .5 }, { seconds: 1, hz: 440 }, { seconds: .5 }], [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: .05 }]);
  const first = await render(), second = await render();
  expect(first.receipt.processing[0].reused).toBe(false); expect(second.receipt.processing[0].reused).toBe(true);
  const p = JSON.parse(await fs.readFile(project, 'utf8')); p.processing[0].padding_sec = .15; await fs.writeFile(project, JSON.stringify(p));
  const changed = await render(); expect(changed.receipt.processing[0].key).not.toBe(first.receipt.processing[0].key); expect(changed.result.duration_sec).toBeCloseTo(1.3, 1);
  const cached = path.join(root, changed.receipt.processing[0].output_path); await fs.writeFile(cached, 'corrupt');
  const repaired = await render(); expect(repaired.receipt.processing[0].reused).toBe(false); expect(repaired.result.duration_sec).toBeCloseTo(1.3, 1);
  expect((await fs.stat(first.file)).size).toBeGreaterThan(44);
});
it('reduces steady noise while retaining a known signal and records the chosen strength', async () => {
  await setup([{ seconds: .5, noise: .025 }, { seconds: 1, hz: 440, noise: .025 }, { seconds: .5, noise: .025 }], [{ type: 'denoise', strength: 'standard' }]);
  const first = await render(); const p = JSON.parse(await fs.readFile(project, 'utf8')); p.processing = []; await fs.writeFile(project, JSON.stringify(p)); const plain = await render();
  const clean = await pcm(first.file), original = await pcm(plain.file);
  expect(energy(clean, .2, .15)).toBeLessThan(energy(original, .2, .15) * .8);
  expect(energy(clean, .8, .2, 440)).toBeGreaterThan(energy(original, .8, .2, 440) * .65);
  expect(first.receipt.processing[0].settings).toEqual({ type: 'denoise', strength: 'standard' });
});
it('does not call all-silent material a successful empty export', async () => {
  const source = await setup([{ seconds: 2 }], [{ type: 'silence', mode: 'edges', min_silence_sec: .3 }]);
  await expect(render()).rejects.toMatchObject({ code: 'E_ALL_SILENT' });
  expect(await fs.readFile(path.join(root, 'source.wav'))).toEqual(source);
  expect((await fs.readdir(root)).some(f => f.startsWith('export-'))).toBe(false);
});
it.each([{ type: 'silence', mode: 'compress', keep_sec: -1 }, { type: 'silence', threshold_db: 2 }, { type: 'denoise', strength: 'maximum' }, { type: 'execute', command: 'anything' }])('rejects invalid structured settings without output: %j', async step => {
  await setup([{ seconds: 1, hz: 440 }], [step]);
  await expect(render()).rejects.toMatchObject({ code: 'E_PROCESSING' });
  expect((await fs.readdir(root)).filter(f => f.startsWith('export-'))).toEqual([]);
});
it('rejects unversioned processing rather than silently ignoring it in a legacy project', async () => {
  await setup([{ seconds: 1, hz: 440 }], [{ type: 'denoise', strength: 'light' }], { schema_version: 1 });
  await expect(render()).rejects.toMatchObject({ code: 'E_PLAN' });
});
it('retains old captions but omits new misleading captions after changing timing', async () => {
  const p = { schema_version: 2, roles: { a: { route_ref: 'fixture', voice_ref: 'fixture', language: 'en' } }, segments: [{ id: 'line', role: 'a', text: 'Some spoken words.' }], processing: [{ type: 'silence', mode: 'edges', min_silence_sec: .3 }] };
  await fs.writeFile(project, JSON.stringify(p)); const attempt = await audio.execute('begin', { project, segment_id: 'line' });
  await fs.writeFile(attempt.request.output_path, wav([{ seconds: .5 }, { seconds: 1, hz: 440 }, { seconds: .5 }]));
  await audio.execute('record', { project, segment_id: 'line', key: attempt.key });
  const { result, receipt } = await render(); expect(result.captions_complete).toBe(false); expect(result.files.some((f: string) => f.endsWith('.srt'))).toBe(false); expect(receipt.processing[0].time_map.length).toBeGreaterThan(0);
  expect((await audio.execute('status', { project })).segments[0].status).toBe('ready');
});
it('cancels without deleting source/previous output and can subsequently render', async () => {
  await setup([{ seconds: .5 }, { seconds: 1, hz: 440 }], [{ type: 'silence', mode: 'edges', min_silence_sec: .3 }]);
  const first = await render(); const abort = new AbortController(); abort.abort();
  await expect(audio.execute('render', { project }, abort.signal)).rejects.toMatchObject({ code: 'E_CANCELLED' });
  expect((await fs.stat(first.file)).size).toBeGreaterThan(44); expect((await fs.readdir(root)).filter(f => f.startsWith('.voice-render-') || f === '.voice-lock')).toEqual([]);
  expect((await render()).result.duration_sec).toBeCloseTo(first.result.duration_sec, 2);
});
it('runs ordered combined cleanup from originals and can undo it without changing earlier exports', async () => {
  await setup([{ seconds: .5 }, { seconds: .6, hz: 440 }, { seconds: 1.2 }, { seconds: .6, hz: 660 }, { seconds: .5 }], [{ type: 'denoise', strength: 'light' }, { type: 'silence', mode: 'remove', min_silence_sec: .3, keep_sec: 0, padding_sec: .05 }]);
  const first = await render(); expect(first.result.duration_sec).toBeCloseTo(1.3, 1); expect(first.receipt.processing.map((s: any) => s.settings.type)).toEqual(['denoise', 'silence']);
  const p = JSON.parse(await fs.readFile(project, 'utf8')); p.processing = []; await fs.writeFile(project, JSON.stringify(p));
  const undone = await render(); expect(undone.result.duration_sec).toBeCloseTo(3.4, 1); expect((await fs.stat(first.file)).size).toBeGreaterThan(44);
});
it('keeps editing available when transcription prerequisites are absent', async () => {
  delete process.env.ORKAS_WHISPER_CPP; delete process.env.ORKAS_WHISPER_MODEL;
  expect(await audio.execute('preflight', {})).toMatchObject({ ok: true, capabilities: { processing: true, editing: true, transcription: false } });
});
it('parses exact structured analysis metadata and ignores similar diagnostic text', () => {
  const { intervals } = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/processing.js');
  expect(intervals('frame:1\nlavfi.silence_start=0\nlavfi.silence_end=0.5\n', 2)).toEqual([[0, .5]]);
  expect(intervals('[silencedetect] silence_start: 0\nnot_lavfi.silence_start=0\n', 2)).toEqual([]);
  expect(() => intervals('lavfi.silence_end=0.5', 2)).toThrow('Incomplete');
  expect(() => intervals('lavfi.silence_start=8', 2)).toThrow('Invalid');
});
