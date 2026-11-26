import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';

const require = createRequire(import.meta.url);
const script = require.resolve('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root: string, project: string, prior: NodeJS.ProcessEnv;
const releases = new Set<() => void>();
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-parallel-')));
  project = path.join(root, 'voice-project.json');
});
afterEach(async () => {
  for (const release of releases) release(); releases.clear();
  vi.restoreAllMocks(); delete require.cache[script]; process.env = prior;
  await fs.rm(root, { force: true, recursive: true });
});
function tone(hz: number) {
  const b = Buffer.alloc(44 + 48000 * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < 48000; i++) b.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * hz * i / 48000)), 44 + i * 2);
  return b;
}
async function fixture() {
  const plan = { schema_version: 3, roles: { n: { route_ref: 'prior', voice_ref: 'prior', language: 'en' } },
    segments: [330, 440, 660, 880].map((hz, i) => ({ id: `line${i}`, role: 'n', text: `Line ${i}.`, gap_after_sec: .2 })),
    export: { format: 'wav', channels: 1, normalize_loudness: false } };
  await fs.writeFile(project, JSON.stringify(plan));
  const original = require(script);
  for (const [i, hz] of [330, 440, 660, 880].entries()) {
    const a = await original.execute('begin', { project, segment_id: `line${i}` });
    await fs.writeFile(a.request.output_path, tone(hz));
    await original.execute('record', { project, segment_id: `line${i}`, key: a.key });
  }
  return plan;
}
// Hold the completion event of a real codec process. This forces out-of-order
// completion without substituting audio, and makes a serial implementation fail.
function instrument(mode: 'order' | 'failure' | 'cancel') {
  const spawn = childProcess.spawn.bind(childProcess);
  let active = 0, peak = 0;
  const launched: number[] = [], closed: number[] = [];
  let second!: () => void;
  const secondDone = new Promise<void>(r => { second = r; });
  let releaseFirst = () => {};
  vi.spyOn(childProcess, 'spawn').mockImplementation(((exe: string, args: string[], opts: any) => {
    const child = spawn(exe, args, opts);
    const match = /[/\\]\.voice-render-[^/\\]+[/\\](\d+)\.wav$/.exec(args.at(-1) ?? '');
    if (exe !== process.env.ORKAS_BUNDLED_FFMPEG || !match) return child;
    const index = Number(match[1]); launched.push(index); peak = Math.max(peak, ++active);
    const emit = child.emit.bind(child), kill = child.kill.bind(child);
    let held: (() => void) | undefined, released = index !== 0;
    const release = () => { released = true; held?.(); held = undefined; };
    releases.add(release);
    if (index === 0) releaseFirst = release;
    child.emit = ((event: string, ...values: any[]) => {
      if (event !== 'close') return emit(event, ...values);
      const finish = () => { active--; closed.push(index); releases.delete(release); emit(event, mode === 'failure' && index === 1 ? 1 : values[0], ...values.slice(1)); if (index === 1) second(); };
      if (!released) { held = finish; return true; }
      finish(); return true;
    }) as typeof child.emit;
    child.kill = ((signal?: NodeJS.Signals | number) => { const result = kill(signal); release(); return result; }) as typeof child.kill;
    return child;
  }) as any);
  delete require.cache[script];
  return { audio: require(script), launched, closed, get peak() { return peak; }, get active() { return active; },
    release: () => releaseFirst(), secondDone };
}
async function within<T>(promise: Promise<T>, fallback: T, ms: number, timeout = () => {}) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<T>(r => { timer = setTimeout(() => { timeout(); r(fallback); }, ms); })]); }
  finally { clearTimeout(timer!); }
}
it('prepares independent clips concurrently, bounds codecs to two, and preserves waveform/caption order', async () => {
  await fixture();
  const state = await fs.readFile(path.join(root, '.voice-state.json'));
  const p = instrument('order'), pending = p.audio.execute('render', { project });
  const overlapped = await within(p.secondDone.then(() => true), false, 5000); p.release();
  const result = await pending;
  expect(overlapped, 'The second independent clip must finish while the first is held.').toBe(true);
  expect(p.peak).toBe(2); expect(p.active).toBe(0);
  const decoded = childProcess.spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-i', path.join(root, result.files[0]), '-f', 's16le', '-'], { maxBuffer: 2 * 1024 * 1024 });
  expect(decoded.status).toBe(0); expect(decoded.stderr.length).toBe(0);
  expect(decoded.stdout).toEqual(Buffer.concat([330, 440, 660, 880].flatMap(hz => [tone(hz).subarray(44), Buffer.alloc(9600 * 2)])));
  const receipt = JSON.parse(await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('receipt.json'))), 'utf8'));
  receipt.cues.forEach((cue: any, i: number) => { expect(cue.text).toBe(`Line ${i}.`); expect(cue.start_sec).toBeCloseTo(i * 1.2, 6); expect(cue.end_sec).toBeCloseTo(i * 1.2 + 1, 6); });
  expect(await fs.readFile(path.join(root, '.voice-state.json'))).toEqual(state);
}, 15000);
it.each([1, 3])('preserves all %i clips at single/odd batch boundaries', async count => {
  const plan = await fixture(); plan.segments = plan.segments.slice(0, count);
  await fs.writeFile(project, JSON.stringify(plan));
  const result = await require(script).execute('render', { project });
  const decoded = childProcess.spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-i', path.join(root, result.files[0]), '-f', 's16le', '-'], { maxBuffer: 2 * 1024 * 1024 });
  expect(decoded.status).toBe(0); expect(decoded.stderr.length).toBe(0);
  expect(decoded.stdout).toEqual(Buffer.concat([330, 440, 660].slice(0, count).flatMap(hz => [tone(hz).subarray(44), Buffer.alloc(9600 * 2)])));
});
it.each(['failure', 'cancel'] as const)('settles sibling codecs before cleanup after %s and allows a clean local retry', async mode => {
  await fixture();
  const original = require(script), previous = await original.execute('render', { project });
  const bytes = await fs.readFile(path.join(root, previous.files[0]));
  const p = instrument(mode), abort = new AbortController();
  const pending = p.audio.execute('render', { project }, abort.signal).then(() => null, (e: any) => e);
  if (mode === 'cancel') {
    // The second real child is allowed to finish; the held first still owns its slot.
    const overlapped = await within(p.secondDone.then(() => true), false, 5000);
    abort.abort(); if (!overlapped) p.release();
    expect(overlapped).toBe(true);
  }
  const settled = await within(pending.then(error => ({ complete: true, error })), { complete: false, error: null }, 5000, p.release);
  const error = await pending;
  expect(settled.complete).toBe(true);
  expect(error).toMatchObject({ code: mode === 'failure' ? 'E_PROCESS' : 'E_CANCELLED' });
  expect(p.peak).toBe(2); expect(p.active).toBe(0); expect([...p.launched].sort()).toEqual([0, 1]);
  expect((await fs.readdir(root)).filter(f => f.startsWith('.voice-render-') || f === '.voice-lock')).toEqual([]);
  expect(await fs.readFile(path.join(root, previous.files[0]))).toEqual(bytes);
  vi.restoreAllMocks(); delete require.cache[script];
  const recovered = await require(script).execute('render', { project });
  expect(recovered.duration_sec).toBeCloseTo(4.8, 6);
  expect(await fs.readFile(path.join(root, previous.files[0]))).toEqual(bytes);
}, 15000);
