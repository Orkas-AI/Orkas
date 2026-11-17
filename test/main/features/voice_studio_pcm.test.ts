import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { bundledRuntimeEnv, bundledNodeExecutable } from '../../../src/main/util/bundled-runtime';

const require = createRequire(import.meta.url);
const script = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
const audio = require(script);
let root: string, project: string, prior: NodeJS.ProcessEnv;
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-pcm-')));
  project = path.join(root, 'voice-project.json');
});
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });

// Author integer samples directly, including low bits and independent channels.
// The oracle is a source byte slice, never an FFmpeg re-encoding of the answer.
async function recording(rate: number, bits: number, channels: number) {
  const width = bits / 8, stride = width * channels, pcm = Buffer.alloc(rate * 2 * stride);
  for (let i = 0; i < rate * 2; i++) for (let c = 0; c < channels; c++) {
    pcm.writeIntLE(Math.round(Math.sin(i * (.41 + c * .13)) * (2 ** (bits - 3))) + i % 17 - 8, i * stride + c * width, width);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * stride, 28); header.writeUInt16LE(stride, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const bytes = Buffer.concat([header, pcm]); await fs.writeFile(path.join(root, 'recording.wav'), bytes);
  return { bytes, pcm, stride };
}
function decode(file: string, bits: number) {
  const result = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i', file,
    '-c:a', 'pcm_s' + bits + 'le', '-f', 's' + bits + 'le', '-'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.status, String(result.stderr)).toBe(0); expect(result.stderr.length).toBe(0); return result.stdout;
}
const call = (fields = {}, signal?: AbortSignal) => audio.execute('render', { project, ...fields }, signal);
const save = (plan: unknown) => fs.writeFile(project, JSON.stringify(plan));

it.each([[16000,16,1], [24000,24,1], [44100,32,1], [48000,32,2], [16000,24,2]])(
  'keeps neutral %iHz/%i-bit/%i-channel cuts exact after a fresh-process reopen', async (rate, bits, channels) => {
    const source = await recording(rate, bits, channels);
    const plan = { schema_version: 1, roles: {}, segments: [{ id: 'excerpt', path: 'recording.wav', start_sec: .2, end_sec: 1.6, volume: 1, speed: 1 }],
      export: { format: 'wav', ...(rate === 48000 ? {} : { sample_rate: rate }), channels, bit_depth: bits, normalize_loudness: false } };
    await save(plan); const saved = await fs.readFile(project);
    const first = await call(), output = path.join(root, first.files[0]);
    const expected = source.pcm.subarray(rate * .2 * source.stride, rate * 1.6 * source.stride);
    expect(decode(output, bits).equals(expected), 'neutral cuts must retain every original sample').toBe(true);
    expect(first).toMatchObject({ sample_rate: rate, channels });
    const firstBytes = await fs.readFile(output);
    const request = path.join(root, 'request.json'); await fs.writeFile(request, JSON.stringify({ project }));
    const node = bundledNodeExecutable(); expect(node).toBeTruthy();
    const reopened = spawnSync(node!, [script, 'render', request], { env: process.env, encoding: 'utf8', timeout: 30000 });
    expect(reopened.status, reopened.stderr).toBe(0); expect(reopened.stderr).toBe('');
    const next = JSON.parse(reopened.stdout); expect(next.ok).toBe(true); expect(next.files[0]).not.toBe(first.files[0]);
    expect(decode(path.join(root, next.files[0]), bits).equals(expected)).toBe(true);
    plan.segments[0].volume = .5; await save(plan);
    const treated = decode(path.join(root, (await call()).files[0]), bits);
    let inputEnergy = 0, outputEnergy = 0;
    for (let i = 0; i < expected.length; i += bits / 8) {
      inputEnergy += expected.readIntLE(i, bits / 8) ** 2; outputEnergy += treated.readIntLE(i, bits / 8) ** 2;
    }
    expect(treated.length).toBe(expected.length);
    expect(Math.sqrt(outputEnergy / inputEnergy)).toBeCloseTo(.5, 3);
    expect(await fs.readFile(output)).toEqual(firstBytes); expect(await fs.readFile(path.join(root, 'recording.wav'))).toEqual(source.bytes);
    plan.segments[0].volume = 1; await save(plan); expect(await fs.readFile(project)).toEqual(saved);
  }, 30000);

it('concatenates exact excerpts, applies request overrides without rewriting the saved profile, and recovers a rejected trim', async () => {
  const rate = 24000, source = await recording(rate, 24, 2);
  const plan = { schema_version: 3, roles: {}, segments: [
    { id: 'later', path: 'recording.wav', start_sec: 1, end_sec: 1.5 },
    { id: 'earlier', path: 'recording.wav', start_sec: .25, end_sec: .75 }],
    export: { format: 'mp3', channels: 1, normalize_loudness: true } };
  await save(plan); const saved = await fs.readFile(project);
  const fields = { export: { format: 'wav', sample_rate: rate, bit_depth: 24, channels: 2, normalize_loudness: false } };
  const first = await call(fields), output = path.join(root, first.files[0]);
  const expected = Buffer.concat([source.pcm.subarray(rate * source.stride, rate * 1.5 * source.stride),
    source.pcm.subarray(rate * .25 * source.stride, rate * .75 * source.stride)]);
  expect(decode(output, 24).equals(expected)).toBe(true);
  const retained = await fs.readFile(output);
  const receipt = JSON.parse(await fs.readFile(path.join(root, first.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8'));
  expect(receipt.export).toMatchObject(fields.export); expect(await fs.readFile(project)).toEqual(saved);
  plan.segments[0].end_sec = 3; await save(plan);
  await expect(call(fields)).rejects.toMatchObject({ code: 'E_TRIM' });
  expect((await fs.readdir(root)).some(f => f.startsWith('.voice-render-') || f === '.voice-lock')).toBe(false);
  plan.segments[0].end_sec = 1.5; await save(plan);
  const abort = new AbortController(); abort.abort();
  await expect(call(fields, abort.signal)).rejects.toMatchObject({ code: 'E_CANCELLED' });
  expect((await fs.readdir(root)).some(f => f.startsWith('.voice-render-') || f === '.voice-lock')).toBe(false);
  expect(decode(path.join(root, (await call(fields)).files[0]), 24).equals(expected)).toBe(true);
  expect(await fs.readFile(output)).toEqual(retained); expect(await fs.readFile(path.join(root, 'recording.wav'))).toEqual(source.bytes);
  expect(await fs.readFile(project)).toEqual(saved);
}, 30000);


it('updates an installed VoiceStudio package and renders its repaired private script in a fresh process', async () => {
  const id = '5f890bd72ac4', uid = 'pcm-install-user';
  const bundled = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents', id);
  const packageRoot = path.join(root, 'builtin/marketplace/agents', id);
  await fs.mkdir(path.dirname(packageRoot), { recursive: true }); await fs.cp(bundled, packageRoot, { recursive: true });
  const definition = await fs.readFile(path.join(bundled, 'agent.json'), 'utf8'), current = JSON.parse(definition);
  const parts = current.version.split('.').map(Number); parts[2] -= 1;
  await fs.writeFile(path.join(packageRoot, 'agent.json'), JSON.stringify({ ...current, version: parts.join('.') }));
  const relativeScript = 'skills/voice-project/scripts/audio.js';
  await fs.writeFile(path.join(packageRoot, relativeScript), '// Previous package fixture.\n');
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'runtime'); process.env.ORKAS_BUILTIN_ROOT = path.join(root, 'builtin');
  vi.resetModules(); const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('This local package journey must not dispatch network work.'));
  try {
    const { seedBuiltinMarketplaceForUser } = await import('../../../src/main/features/builtin_marketplace');
    const { userMarketplaceAgentDir } = await import('../../../src/main/paths');
    const { readInstalls } = await import('../../../src/main/features/marketplace_installs');
    expect((await seedBuiltinMarketplaceForUser(uid)).seeded_agents).toBe(1);
    const installed = userMarketplaceAgentDir(uid, id);
    expect(JSON.parse(await fs.readFile(path.join(installed, 'agent.json'), 'utf8')).version).toBe(parts.join('.'));
    await fs.writeFile(path.join(installed, 'notes.txt'), 'User-owned note.');
    await fs.copyFile(path.join(bundled, relativeScript), path.join(packageRoot, relativeScript));
    await fs.writeFile(path.join(packageRoot, 'agent.json'), definition);
    expect((await seedBuiltinMarketplaceForUser(uid)).seeded_agents).toBe(1);
    expect((await readInstalls(uid)).agents.find(a => a.id === id)?.version).toBe(current.version);
    expect(await fs.readFile(path.join(installed, 'notes.txt'), 'utf8')).toBe('User-owned note.');
    const source = await recording(16000, 16, 1);
    await save({ schema_version: 1, segments: [{ id: 'cut', path: 'recording.wav', start_sec: .2, end_sec: 1.6 }],
      export: { format: 'wav', sample_rate: 16000, bit_depth: 16, channels: 1, normalize_loudness: false } });
    const request = path.join(root, 'request.json'); await fs.writeFile(request, JSON.stringify({ project }));
    const node = bundledNodeExecutable(); expect(node).toBeTruthy();
    const result = spawnSync(node!, [path.join(installed, relativeScript), 'render', request], { env: process.env, encoding: 'utf8', timeout: 30000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout); expect(output.ok).toBe(true);
    expect(decode(path.join(root, output.files[0]), 16).equals(source.pcm.subarray(16000 * .2 * 2, 16000 * 1.6 * 2))).toBe(true);
    expect((await seedBuiltinMarketplaceForUser(uid)).seeded_agents).toBe(0);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); vi.resetModules(); }
}, 30000);
