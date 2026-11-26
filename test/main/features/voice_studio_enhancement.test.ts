import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { enhancementCases, enhancementWav, enhancementMatches, enhancementMeasures, decodeEnhancement } from '../../../eval/model-eval/regression/voice-enhancement-fixtures';
const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
const { settings } = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/processing.js');
let root: string, project: string, prior: NodeJS.ProcessEnv;
const steps = [{ type: 'highpass' }, { type: 'deesser', strength: 'standard' }, { type: 'compressor' }];
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-enhance-'))); project = path.join(root, 'voice-project.json');
  await fs.writeFile(path.join(root, 'source.wav'), enhancementWav());
});
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });
async function save(processing: any[]) { await fs.writeFile(project, JSON.stringify({ schema_version: 2, roles: {}, segments: [{ id: 'recording', path: 'source.wav' }], processing })); }
async function render() {
  const r = await audio.execute('render', { project, format: 'wav' });
  return { r, file: path.join(root, r.files[0]), receipt: JSON.parse(await fs.readFile(path.join(root, r.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8')) };
}
it.each(enhancementCases)('delivers the requested audible change without changing timing or unrelated signal: %s', async id => {
  await save(id === enhancementCases[3] ? steps : [steps[enhancementCases.indexOf(id)]]);
  const result = await render();
  const samples = decodeEnhancement(result.file);
  expect(enhancementMatches(id, samples)).toBe(true);
  expect(result.receipt.export.normalize_loudness).toBe(false);
  if (id === 'voice-deess') {
    const source = enhancementMeasures(decodeEnhancement(path.join(root, 'source.wav')));
    const enhanced = enhancementMeasures(samples);
    expect(Math.abs(enhanced.quietVoice - source.quietVoice)).toBeLessThanOrEqual(4 / 32768);
    expect(Math.abs(enhanced.loudVoice - source.loudVoice)).toBeLessThanOrEqual(4 / 32768);
  }
  expect(result.receipt.processing.map((p: any) => p.settings.type)).toEqual(id === enhancementCases[3] ? ['highpass', 'deesser', 'compressor'] : [steps[enhancementCases.indexOf(id)].type]);
  for (const step of result.receipt.processing) {
    expect(step.removed_sec).toBe(0); expect(step.silent_intervals).toBe(0);
    expect(step.time_map).toEqual([{ input_start_sec: 0, input_end_sec: 6, output_start_sec: 0, output_end_sec: 6 }]);
  }
  expect((await fs.readFile(path.join(root, 'source.wav'))).equals(enhancementWav())).toBe(true);
});
it('reuses an unchanged prefix, invalidates only revised downstream processing, and undoes from the source', async () => {
  await save(steps); const first = await render(), bytes = await fs.readFile(first.file);
  expect((await render()).receipt.processing.every((p: any) => p.reused)).toBe(true);
  await save([steps[0], { type: 'deesser', strength: 'light' }, steps[2]]);
  const revision = await render(); expect(revision.receipt.processing.map((p: any) => p.reused)).toEqual([true, false, false]);
  const changed = enhancementWav(); changed.writeInt16LE(100, 44);
  await fs.writeFile(path.join(root, 'source.wav'), changed);
  expect((await render()).receipt.processing.every((p: any) => !p.reused)).toBe(true);
  await fs.writeFile(path.join(root, 'source.wav'), enhancementWav());
  await save([]); const undone = await render();
  expect(undone.r.duration_sec).toBe(6); expect(undone.receipt.processing).toBeUndefined();
  expect(enhancementMatches('voice-enhance-combined', decodeEnhancement(undone.file))).toBe(false);
  expect(await fs.readFile(first.file)).toEqual(bytes);
});
it.each(['light', 'strong'])('renders both supported de-essing strength extremes without shifting time: %s', async strength => {
  await save([{ type: 'deesser', strength }]); const { r, receipt } = await render();
  expect(r.duration_sec).toBe(6); expect(receipt.processing[0].removed_sec).toBe(0);
});
it('does not reject silence or invent sound when only enhancement was requested', async () => {
  const b = enhancementWav(); b.fill(0, 44); await fs.writeFile(path.join(root, 'source.wav'), b);
  await save(steps); const { r, file } = await render();
  expect(r.duration_sec).toBe(6); expect(decodeEnhancement(file).every(n => n === 0)).toBe(true);
});
it('retains generated-speech captions and recording identity when enhancement does not cut time', async () => {
  await fs.writeFile(project, JSON.stringify({ schema_version: 2, roles: { a: { route_ref: 'fixture', voice_ref: 'fixture', language: 'en' } }, segments: [{ id: 'line', role: 'a', text: 'A retained sentence.' }], processing: steps }));
  const attempt = await audio.execute('begin', { project, segment_id: 'line' });
  await fs.writeFile(attempt.request.output_path, enhancementWav()); await audio.execute('record', { project, segment_id: 'line', key: attempt.key });
  const { r } = await render(); expect(r.captions_complete).toBe(true);
  expect(await fs.readFile(path.join(root, r.files.find((f: string) => f.endsWith('.srt'))), 'utf8')).toContain('00:00:00,000 --> 00:00:06,000');
  expect((await audio.execute('status', { project })).segments[0]).toMatchObject({ key: attempt.key, status: 'ready' });
});
it('preserves completed work on cancellation and missing codec, then recovers without a model or network', async () => {
  await save(steps); const first = await render(), bytes = await fs.readFile(first.file);
  const abort = new AbortController(); abort.abort();
  await expect(audio.execute('render', { project }, abort.signal)).rejects.toMatchObject({ code: 'E_CANCELLED' });
  delete process.env.ORKAS_BUNDLED_FFMPEG;
  await expect(render()).rejects.toMatchObject({ code: 'E_RUNTIME_MISSING' });
  Object.assign(process.env, bundledRuntimeEnv()); delete process.env.ORKAS_WHISPER_CPP; delete process.env.ORKAS_WHISPER_MODEL;
  expect((await render()).receipt.processing.every((p: any) => p.reused)).toBe(true);
  expect(await fs.readFile(first.file)).toEqual(bytes);
  expect((await fs.readdir(root)).filter(f => f.startsWith('.voice-render-') || f === '.voice-lock')).toEqual([]);
});
it.each([
  { type: 'highpass', frequency_hz: 19.99 }, { type: 'highpass', frequency_hz: 300.01 },
  { type: 'highpass', frequency_hz: '80' }, { type: 'highpass', frequency_hz: '80,volume=4' },
  { type: 'deesser', strength: 'maximum' }, { type: 'deesser', frequency_hz: 8000 },
  { type: 'compressor', threshold_db: -60.01 }, { type: 'compressor', threshold_db: .01 },
  { type: 'compressor', ratio: .99 }, { type: 'compressor', ratio: 20.01 },
  { type: 'compressor', attack_ms: .009 }, { type: 'compressor', attack_ms: 2000.01 },
  { type: 'compressor', release_ms: .009 }, { type: 'compressor', release_ms: 9000.01 },
  { type: 'compressor', makeup: 64 }, { type: 'highpass', strength: 'light' },
])('rejects malformed settings before publishing or changing the source: %j', async s => {
  await save([s]); await expect(render()).rejects.toMatchObject({ code: 'E_PROCESSING' });
  expect((await fs.readdir(root)).sort()).toEqual(['source.wav', 'voice-project.json']);
  expect((await fs.readFile(path.join(root, 'source.wav'))).equals(enhancementWav())).toBe(true);
});
it('accepts documented numeric boundaries, rejects non-finite values and bounds cumulative work', () => {
  expect(settings([{ type: 'highpass', frequency_hz: 20 }, { type: 'highpass', frequency_hz: 300 },
    { type: 'compressor', threshold_db: -60, ratio: 1, attack_ms: .01, release_ms: .01 },
    { type: 'compressor', threshold_db: 0, ratio: 20, attack_ms: 2000, release_ms: 9000 }])).toHaveLength(4);
  for (const n of [NaN, Infinity, -Infinity]) expect(() => settings([{ type: 'highpass', frequency_hz: n }])).toThrow();
  expect(() => settings(Array.from({ length: 17 }, () => steps[0]))).toThrow();
});
