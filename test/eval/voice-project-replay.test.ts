import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectProjectReplay } from '../../eval/model-eval/regression/voice-project-replay';
import { bundledRuntimeEnv } from '../../src/main/util/bundled-runtime';

let root: string, project: string, source: string, delivered: string, prior: NodeJS.ProcessEnv;
function wav(channels = 1, seconds = 1) {
  const frames = Math.round(seconds * 48000), stride = channels * 2, b = Buffer.alloc(44 + frames * stride);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(48000 * stride, 28); b.writeUInt16LE(stride, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(frames * stride, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(.15 * 32767 * Math.sin(2 * Math.PI * (c ? 880 : 440) * i / 48000)), 44 + i * stride + c * 2);
  return b;
}
function save(fields: any = {}) {
  fs.writeFileSync(project, JSON.stringify({ schema_version: 2, roles: {}, segments: [{ id: 'recording', path: 'sources/voice.wav' }],
    export: { format: 'wav', channels: 1, normalize_loudness: false }, ...fields }));
}
beforeEach(() => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-replay-test-')));
  project = path.join(root, 'voice-project.json'); fs.mkdirSync(path.join(root, 'sources'));
  source = path.join(root, 'sources/voice.wav'); delivered = path.join(root, 'delivery.wav');
  fs.writeFileSync(source, wav()); fs.copyFileSync(source, delivered); save();
});
afterEach(() => { process.env = prior; fs.rmSync(root, { recursive: true, force: true }); });
const inspect = () => inspectProjectReplay(root, [project], delivered);
it('replays a relocated project with a fresh cache while preserving all original files', () => {
  fs.mkdirSync(path.join(root, '.voice-cache')); fs.writeFileSync(path.join(root, '.voice-cache/untouched'), 'old cache');
  const plan = fs.readFileSync(project), input = fs.readFileSync(source), output = fs.readFileSync(delivered), files = fs.readdirSync(root).sort();
  expect(inspect()).toMatchObject({ matched: true, attempted: 1, reason: 'matched', maxSampleError: 0 });
  expect(fs.readFileSync(project)).toEqual(plan); expect(fs.readFileSync(source).equals(input)).toBe(true);
  expect(fs.readFileSync(delivered).equals(output)).toBe(true); expect(fs.readdirSync(root).sort()).toEqual(files);
  expect(fs.readFileSync(path.join(root, '.voice-cache/untouched'), 'utf8')).toBe('old cache');
});
it('permits a lossless replay of a saved lossy encoding profile without changing it', () => {
  save({ export: { format: 'mp3', channels: 1, bitrate_kbps: 192, normalize_loudness: false } });
  const before = fs.readFileSync(project); expect(inspect().matched).toBe(true); expect(fs.readFileSync(project)).toEqual(before);
});
it('checks every PCM sample instead of accepting sparse time windows', () => {
  const b = fs.readFileSync(delivered); b.writeInt16LE(3000, 44 + 24 * 2); fs.writeFileSync(delivered, b);
  expect(inspect()).toMatchObject({ matched: false, attempted: 1, reason: 'no-match' });
});
it('rejects swapped stereo channels even when their mono sum is unchanged', () => {
  const b = wav(2); fs.writeFileSync(source, b); const swapped = Buffer.from(b);
  for (let i = 44; i < b.length; i += 4) { swapped.writeInt16LE(b.readInt16LE(i + 2), i); swapped.writeInt16LE(b.readInt16LE(i), i + 2); }
  fs.writeFileSync(delivered, swapped); save({ export: { format: 'wav', channels: 2, normalize_loudness: false } });
  expect(inspect().matched).toBe(false);
  fs.writeFileSync(delivered, b); expect(inspect().matched).toBe(true);
});
it('rejects a missing or corrupt dependency and recovers when the original is restored', () => {
  const b = fs.readFileSync(source); fs.rmSync(source); expect(inspect().matched).toBe(false);
  fs.writeFileSync(source, 'not audio'); expect(inspect().matched).toBe(false);
  fs.writeFileSync(source, b); expect(inspect().matched).toBe(true);
});
it('refuses escaped dependencies without touching the external file or source project', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-replay-outside-'))), file = path.join(outside, 'voice.wav');
  try {
    fs.writeFileSync(file, wav()); fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    save({ segments: [{ id: 'escape', path: 'escape/voice.wav' }] }); const before = fs.readFileSync(project);
    expect(inspect()).toMatchObject({ matched: false, attempted: 0 });
    expect(fs.readFileSync(file).equals(wav())).toBe(true); expect(fs.readFileSync(project)).toEqual(before);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
it('accepts a source alias whose physical target remains inside the project', () => {
  fs.symlinkSync(source, path.join(root, 'alias.wav'));
  save({ segments: [{ id: 'alias', path: 'alias.wav' }] });
  expect(inspect().matched).toBe(true); expect(fs.lstatSync(path.join(root, 'alias.wav')).isSymbolicLink()).toBe(true);
});
it('fails closed for an unavailable workspace and excessive candidate count', () => {
  expect(inspectProjectReplay(path.join(root, 'missing'), [project], delivered)).toMatchObject({ matched: false, reason: 'unavailable' });
  expect(inspectProjectReplay(root, Array(9).fill(project), delivered)).toMatchObject({ matched: false, reason: 'budget', attempted: 0 });
});
it('bounds long compressed or PCM inputs before attempting a render', () => {
  fs.writeFileSync(source, wav(1, 31)); const before = fs.readdirSync(root).sort();
  expect(inspect()).toMatchObject({ matched: false, reason: 'budget', attempted: 0 });
  expect(fs.readdirSync(root).sort()).toEqual(before);
});
it('never turns missing synthesized takes into a fresh speech request', () => {
  save({ roles: { n: { route_ref: 'fixture', voice_ref: 'fixture', language: 'en' } }, segments: [{ id: 'line', role: 'n', text: 'Keep the completed take.' }] });
  expect(inspect()).toMatchObject({ matched: false, attempted: 0 }); expect(fs.existsSync(path.join(root, '.voice-state.json'))).toBe(false);
});
