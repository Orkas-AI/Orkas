import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { recordedAudio, recordedMeasures, recordedMatches, pcmWav, type RecordedKind, type RecordedLanguage } from '../../../eval/model-eval/regression/voice-recorded-fixtures';
import { decodeEnhancement } from '../../../eval/model-eval/regression/voice-enhancement-fixtures';
const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root: string, project: string, prior: NodeJS.ProcessEnv;
// The recorded speech has sparse peaks. Use a threshold that compresses the
// loud phrase without relying on another treatment in the final export.
const steps: Record<RecordedKind, object[]> = { noise: [{ type: 'denoise', strength: 'standard' }], rumble: [{ type: 'highpass', frequency_hz: 80 }], dynamics: [{ type: 'compressor', threshold_db: -26 }], deess: [{ type: 'deesser', strength: 'standard' }], preserve: [] };
beforeEach(async () => { prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv()); root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-recorded-'))); project = path.join(root, 'voice-project.json'); });
afterEach(async () => { process.env = prior; await fs.rm(root, { force: true, recursive: true }); });
async function save(processing: object[], input = 'source.wav', extra = {}) { await fs.writeFile(project, JSON.stringify({ schema_version: 2, roles: {}, segments: [{ id: 'recording', path: input }], processing, ...extra })); }
async function render(format = 'wav') {
  const result = await audio.execute('render', { project, format });
  const receipt = JSON.parse(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8'));
  return { result, file: path.join(root, result.files[0]), receipt };
}
const portfolio = (['en', 'zh'] as RecordedLanguage[]).flatMap(language => (['noise', 'rumble', 'dynamics', 'deess', 'preserve'] as RecordedKind[]).map(kind => ({ language, kind })));
it.each((['en', 'zh'] as RecordedLanguage[]).flatMap(language => ['half-level', 'double-level', 'missing-quiet-sample'].map(mutation => ({ language, mutation }))))(
  'rejects $mutation in an otherwise unchanged $language PCM conversion', async ({ language, mutation }) => {
    const fixture = recordedAudio('preserve', language);
    const source = path.join(root, 'source.wav'); await fs.writeFile(source, fixture.wav);
    const original = decodeEnhancement(source), changed = Buffer.from(original);
    expect(recordedMatches('preserve', recordedMeasures('preserve', language, original))).toBe(true);
    if (mutation === 'missing-quiet-sample') changed.writeFloatLE(.01, 400 * 4);
    else for (let i = 0; i < changed.length; i += 4) changed.writeFloatLE(changed.readFloatLE(i) * (mutation === 'half-level' ? .5 : 2), i);
    expect(recordedMatches('preserve', recordedMeasures('preserve', language, changed)), 'Original levels and every retained sample are part of a no-treatment conversion.').toBe(false);
    expect((await fs.readFile(source)).equals(fixture.wav)).toBe(true);
  });
it.each(portfolio)('processes real $language speech with controlled $kind degradation and preserves content/timing', async ({ language, kind }) => {
  const fixture = recordedAudio(kind, language); await fs.writeFile(path.join(root, 'source.wav'), fixture.wav);
  await save(steps[kind], 'source.wav', kind === 'preserve' ? { export: { format: 'wav', channels: 1, normalize_loudness: false } } : {});
  const { result, file, receipt } = await render(), m = recordedMeasures(kind, language, decodeEnhancement(file));
  expect(recordedMatches(kind, m), JSON.stringify(m)).toBe(true); expect(result.duration_sec).toBe(8);
  expect(receipt.export.normalize_loudness).toBe(false);
  expect((await fs.readFile(path.join(root, 'source.wav'))).equals(fixture.wav)).toBe(true);
  const noOp = recordedMeasures(kind, language, decodeEnhancement(path.join(root, 'source.wav')));
  expect(recordedMatches(kind, noOp)).toBe(kind === 'preserve');
  if (kind === 'noise') {
    // Alignment accommodates the bounded FFT delay, never an audible timeline edit.
    const delayed = new Float32Array(fixture.clean.length);
    delayed.set(fixture.clean.subarray(0, delayed.length - 4800), 4800);
    const pcm = Buffer.alloc(delayed.length * 4);
    delayed.forEach((v, i) => pcm.writeFloatLE(v, i * 4));
    expect(recordedMatches(kind, recordedMeasures(kind, language, pcm))).toBe(false);
  }
  // Silence or unrelated content of the right duration cannot masquerade as speech.
  expect(recordedMatches(kind, recordedMeasures(kind, language, Buffer.alloc(8 * 48000 * 4)))).toBe(false);
});
it.each([
  { name: 'float.wav', codec: 'pcm_f32le', rate: '44100', channels: '2' },
  { name: 'input.mp3', codec: 'libmp3lame', rate: '16000', channels: '1' },
  { name: 'input.flac', codec: 'flac', rate: '48000', channels: '2' },
  { name: 'input.m4a', codec: 'aac', rate: '44100', channels: '2' },
  { name: 'input.ogg', codec: 'libopus', rate: '48000', channels: '2' },
])('accepts $name speech and exports a decodable processed MP3 without changing the source', async input => {
  await fs.writeFile(path.join(root, 'source.wav'), recordedAudio('rumble', 'zh').wav);
  const file = path.join(root, input.name);
  const encoded = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i', path.join(root, 'source.wav'), '-ar', input.rate, '-ac', input.channels, '-c:a', input.codec, file], { encoding: 'utf8', timeout: 60000 });
  expect(encoded.status).toBe(0); expect(encoded.stderr).toBe(''); const original = await fs.readFile(file);
  await save(steps.rumble, input.name); const output = await render('mp3');
  expect(output.result.duration_sec).toBeCloseTo(8, 0);
  const m = recordedMeasures('rumble', 'zh', decodeEnhancement(output.file));
  expect(m.speech_correlation).toBeGreaterThan(.8); expect(m.output.rumble_to_speech).toBeLessThan(m.source.rumble_to_speech * .5);
  expect((await fs.readFile(file)).equals(original)).toBe(true);
});
it('keeps distinct stereo channels when only one channel has rumble', async () => {
  const mono = recordedAudio('preserve', 'en'), samples = new Float32Array(mono.clean.length * 2);
  for (let i = 0; i < mono.clean.length; i++) { samples[i * 2] = mono.input[i]; samples[i * 2 + 1] = mono.clean[i] * .5; }
  await fs.writeFile(path.join(root, 'source.wav'), pcmWav(samples, 2)); await save(steps.rumble);
  const output = await render();
  const decoded = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-i', output.file, '-f', 'f32le', '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  expect(decoded.status).toBe(0); expect(decoded.stderr.length).toBe(0);
  let difference = 0, total = 0;
  for (let i = 48000; i < 7 * 48000; i++) { const l = decoded.stdout.readFloatLE(i * 8), r = decoded.stdout.readFloatLE(i * 8 + 4); difference += (l - r) ** 2; total += l * l; }
  expect(difference / total).toBeGreaterThan(.05); expect(output.receipt.channels).toBe(2);
});
it.each([.001, .021, .2])('preserves a short %.3f-second clip through highpass/compression', async seconds => {
  const n = Math.round(seconds * 48000), samples = Float32Array.from({ length: n }, (_, i) => .1 * Math.sin(i * 2 * Math.PI * 440 / 48000));
  await fs.writeFile(path.join(root, 'source.wav'), pcmWav(samples)); await save([...steps.rumble, ...steps.dynamics]);
  const output = await render(); expect(Math.abs(output.result.duration_sec - seconds)).toBeLessThanOrEqual(1 / 48000);
});
it('cleans up an actively cancelled enhancement candidate and preserves prior source/export for recovery', async () => {
  const original = recordedAudio('rumble', 'en').wav; await fs.writeFile(path.join(root, 'source.wav'), original); await save([]);
  const previous = await render(), bytes = await fs.readFile(previous.file);
  await save(Array.from({ length: 16 }, (_, i) => ({ type: 'highpass', frequency_hz: 80 + i })));
  const abort = new AbortController(), pending = audio.execute('render', { project }, abort.signal).then(() => null, (e: any) => e);
  let active = false;
  for (let i = 0; i < 300; i++) { const names = await fs.readdir(path.join(root, '.voice-cache')).catch(() => []); if (names.some(n => n.startsWith('.candidate-'))) { active = true; break; } await new Promise(r => setTimeout(r, 10)); }
  abort.abort(); expect((await pending)?.code).toBe('E_CANCELLED'); expect(active).toBe(true);
  expect((await fs.readFile(previous.file)).equals(bytes)).toBe(true); expect((await fs.readFile(path.join(root, 'source.wav'))).equals(original)).toBe(true);
  expect((await fs.readdir(root)).filter(n => n === '.voice-lock' || n.startsWith('.voice-render-'))).toEqual([]);
  expect((await fs.readdir(path.join(root, '.voice-cache'))).some(n => n.startsWith('.candidate-'))).toBe(false);
  await save(steps.rumble); expect((await render()).result.duration_sec).toBe(8);
});
it.each(['missing', 'corrupt'])('preserves completed output when the recording is %s and recovers when restored', async state => {
  const source = recordedAudio('noise', 'en').wav; await fs.writeFile(path.join(root, 'source.wav'), source); await save(steps.noise);
  const first = await render(), bytes = await fs.readFile(first.file);
  if (state === 'missing') await fs.rm(path.join(root, 'source.wav')); else await fs.writeFile(path.join(root, 'source.wav'), 'broken recording');
  await expect(render()).rejects.toBeDefined(); expect((await fs.readFile(first.file)).equals(bytes)).toBe(true);
  expect((await fs.readdir(root)).filter(n => n === '.voice-lock' || n.startsWith('.voice-render-'))).toEqual([]);
  await fs.writeFile(path.join(root, 'source.wav'), source); expect((await render()).receipt.processing[0].reused).toBe(true);
});
it.each([
  { mode: 'edges', seconds: 5.1, shortPause: 1.1, phrase: .3 },
  { mode: 'compress', seconds: 7.3, shortPause: 2.05, phrase: 1.3 },
  { mode: 'remove', seconds: 4.1, shortPause: 1.1, phrase: .3 },
])('edits inserted $mode silence around quiet real speech without erasing a short breath', async c => {
  const fixture = recordedAudio('dynamics', 'en'), samples = fixture.clean.slice();
  for (let i = 0; i < samples.length; i++) {
    const t = i / 48000;
    // A known low-level marker keeps voiced regions above -60 dB even when
    // the recording itself contains a pause; the .2 s breath is deliberate.
    if ((t >= 1 && t < 3 || t >= 4 && t < 6) && !(t >= 2 && t < 2.2)) samples[i] += .004 * Math.sin(i * 2 * Math.PI * 1000 / 48000);
    if (t >= 2 && t < 2.2) samples[i] = 0;
  }
  const source = pcmWav(samples); await fs.writeFile(path.join(root, 'source.wav'), source);
  await save([{ type: 'silence', mode: c.mode, threshold_db: -60, min_silence_sec: .5, padding_sec: .05, keep_sec: c.mode === 'compress' ? .3 : 0 }]);
  const { file, result, receipt } = await render(); expect(result.duration_sec).toBeCloseTo(c.seconds, 2);
  const b = decodeEnhancement(file);
  const energy = (start: number) => { let n = 0; for (let i = Math.round(start * 48000); i < Math.round((start + .05) * 48000); i++) n += b.readFloatLE(i * 4) ** 2; return Math.sqrt(n / 2400); };
  expect(energy(c.shortPause)).toBeLessThan(.0001); expect(energy(c.phrase)).toBeGreaterThan(.001);
  expect(receipt.processing[0].time_map.length).toBeGreaterThan(0);
  expect((await fs.readFile(path.join(root, 'source.wav'))).equals(source)).toBe(true);
});
