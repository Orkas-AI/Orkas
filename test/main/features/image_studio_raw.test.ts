import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { bayerDng } from '../../../eval/model-eval/regression/raw-fixture';

const require = createRequire(import.meta.url);
const asset = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js');
// Product binaries target macOS and Windows. Linux coverage still runs the
// parameter and ICC cases; real decode cases run in both native CI lanes.
const nativeIt = it.runIf(process.platform === 'darwin' || process.platform === 'win32');
let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-raw-测试🚀-')); vi.stubEnv('ORKAS_PC_DIR', process.cwd()); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const run = (request: object) => { fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request)); return asset({ args: ['--project', root, '--request', 'request.json'] }); };
const mean = async (file: string) => { const b = await sharp(path.join(root, file)).raw().toBuffer(); return b.reduce((s, v) => s + v, 0) / b.length; };
const documentedRequests = () => [...fs.readFileSync(path.resolve('resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/references/photo-processing.md'), 'utf8')
  .matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));

describe('RAW development and screen delivery', () => {
  nativeIt('executes the documented RAW batch with preserved originals, effective parameters and verified resume', async () => {
    const request = documentedRequests().find(value => value.op === 'batch' && value.raw);
    expect(request, 'RAW instructions must supply a runnable request').toBeDefined();
    fs.mkdirSync(path.join(root, 'photos'));
    const original = bayerDng();
    for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `photos/${name}.dng`), original);
    expect(await run(request)).toMatchObject({ completed: 3, failed: 0 });
    for (const name of ['a', 'b', 'c']) {
      expect(fs.readFileSync(path.join(root, `photos/${name}.dng`))).toEqual(original);
      const output = path.join(root, `out/${name}.png`);
      expect(await sharp(output).metadata()).toMatchObject({ width: 256, height: 192, hasProfile: true, isPalette: false });
      const receipt = JSON.parse(fs.readFileSync(`${output}.image-batch.json`, 'utf8'));
      expect(receipt).toMatchObject({ raw: { exposure_ev: name === 'c' ? 2 : 1, white_balance: 'camera' },
        raw_engine: { name: 'libraw', version: '0.22.3' }, color: { output: 'srgb' } });
    }
    expect(await mean('out/c.png')).toBeGreaterThan(await mean('out/a.png') + 10);
    expect(await run(request)).toMatchObject({ completed: 0, reused: 3, failed: 0 });
  });
  it('executes the documented ICC conversion with independently converted pixels and no source mutation', async () => {
    const request = documentedRequests().find(value => value.op === 'batch' && value.color && !value.raw);
    expect(request, 'ICC instructions must supply a runnable request').toBeDefined();
    fs.mkdirSync(path.join(root, 'photos'));
    const original = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#d24b2d' } }).withIccProfile('p3').png().toBuffer();
    fs.writeFileSync(path.join(root, 'photos/wide-gamut.png'), original);
    expect(await run(request)).toMatchObject({ completed: 1, failed: 0 });
    const output = path.join(root, 'out/srgb.png'), expected = await sharp(original).withIccProfile('srgb').png().toBuffer();
    expect((await sharp(output).metadata()).icc).toEqual((await sharp(expected).metadata()).icc);
    expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
    expect(fs.readFileSync(path.join(root, 'photos/wide-gamut.png'))).toEqual(original);
  });
  nativeIt('develops real Bayer data with exposure changes, embedded sRGB and original dimensions', async () => {
    const original = bayerDng(); fs.writeFileSync(path.join(root, 'source.dng'), original);
    for (const [name, ev] of [['base', 0], ['lighter', 1]] as const) {
      expect(await run({ op: 'process', input_path: 'source.dng', output_path: `${name}.png`, raw: { exposure_ev: ev, white_balance: 'camera' }, color: { output: 'srgb' } })).toMatchObject({ ok: true, raw_developed: true });
      expect(await sharp(path.join(root, `${name}.png`)).metadata()).toMatchObject({ width: 256, height: 192, hasProfile: true, isPalette: false });
    }
    expect(await mean('lighter.png')).toBeGreaterThan(await mean('base.png') + 10);
    expect(fs.readFileSync(path.join(root, 'source.dng'))).toEqual(original);
    expect(fs.readdirSync(root).some(name => name.startsWith('.raw-'))).toBe(false);
  });
  nativeIt('preserves full-size photo dimensions beyond the composition canvas', async () => {
    fs.writeFileSync(path.join(root, 'wide.dng'), bayerDng(5120, 128));
    await run({ op: 'process', input_path: 'wide.dng', output_path: 'wide.png', raw: {} });
    expect(await sharp(path.join(root, 'wide.png')).metadata()).toMatchObject({ width: 5120, height: 128, hasProfile: true });
  });
  nativeIt.each([
    { white_balance: 'auto', highlights: 'blend', flags: ['-a', '-H', '2'] },
    { white_balance: { multipliers: [2, 1, 1, 1] }, highlights: 'rebuild', flags: ['-r', '2', '1', '1', '1', '-H', '3'] },
  ])('honors explicit white balance and highlight settings: %j', async ({ white_balance, highlights, flags }) => {
    fs.writeFileSync(path.join(root, 'source.dng'), bayerDng());
    await run({ op: 'process', input_path: 'source.dng', output_path: 'out.png', raw: { exposure_ev: 1, white_balance, highlights, preserve_highlights: 0.5 } });
    const decoder = path.resolve('resources/runtime/libraw', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'dcraw_emu.exe' : 'dcraw_emu');
    const reference = spawnSync(decoder, ['-T', '-6', '-W', '-g', '2.4', '12.92', '-o', '1', '-q', '3', '-aexpo', '2', '0.5', ...flags,
      '-Z', 'reference.tiff', 'source.dng'], { cwd: root, timeout: 30_000, env: { ...process.env, OMP_NUM_THREADS: '2' }, windowsHide: true });
    expect(reference.error).toBeUndefined(); expect(reference.status).toBe(0);
    expect(reference.stdout.length).toBe(0); expect(reference.stderr.length).toBe(0);
    const expected = await sharp(path.join(root, 'reference.tiff')).withIccProfile('srgb').png().toBuffer();
    expect(await sharp(path.join(root, 'out.png')).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
  });
  nativeIt('supports shared RAW settings, per-photo replacement, source preservation and verified resume', async () => {
    const original = bayerDng(); for (const n of ['a', 'b']) fs.writeFileSync(path.join(root, `${n}.dng`), original);
    const request = { op: 'batch', raw: { exposure_ev: 0 }, color: { output: 'srgb' }, items: [
      { input_path: 'a.dng', output_path: 'a.png' }, { input_path: 'b.dng', output_path: 'b.png', raw: { exposure_ev: 1 } },
    ] };
    expect(await run(request)).toMatchObject({ completed: 2, reused: 0, failed: 0 });
    expect(await mean('b.png')).toBeGreaterThan(await mean('a.png') + 10);
    expect(await run(request)).toMatchObject({ completed: 0, reused: 2, failed: 0 });
    for (const n of ['a', 'b']) expect(fs.readFileSync(path.join(root, `${n}.dng`))).toEqual(original);
    request.raw.exposure_ev = -1;
    expect(await run(request)).toMatchObject({ completed: 0, reused: 1, failed: 1 });
  });
  nativeIt('keeps completed photos when another RAW is corrupt, then resumes the repaired item', async () => {
    fs.writeFileSync(path.join(root, 'a.dng'), bayerDng()); fs.writeFileSync(path.join(root, 'bad.dng'), 'not RAW');
    const request = { op: 'batch', raw: {}, items: [{ input_path: 'bad.dng', output_path: 'bad.png' }, { input_path: 'a.dng', output_path: 'a.png' }] };
    expect(await run(request)).toMatchObject({ completed: 1, failed: 1 });
    expect(fs.existsSync(path.join(root, 'bad.png'))).toBe(false);
    fs.writeFileSync(path.join(root, 'bad.dng'), bayerDng());
    expect(await run(request)).toMatchObject({ completed: 1, reused: 1, failed: 0 });
  });
  it.each([{ exposure_ev: 4 }, { white_balance: 'invented' }, { white_balance: { multipliers: [1, -1, 1, 1] } }, { highlights: 'invented' }])('rejects unsupported RAW settings before outputs: %j', async raw => {
    fs.writeFileSync(path.join(root, 'source.dng'), bayerDng());
    await expect(run({ op: 'process', input_path: 'source.dng', output_path: 'out.png', raw })).rejects.toThrow(/E_RAW_ARGUMENT/);
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
  });
  nativeIt('does not call a normal raster a developed RAW or overwrite the original', async () => {
    await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } }).png().toFile(path.join(root, 'fake.dng'));
    await expect(run({ op: 'process', input_path: 'fake.dng', output_path: 'out.png', raw: {} })).rejects.toThrow(/E_RAW/);
    fs.writeFileSync(path.join(root, 'source.dng'), bayerDng());
    await expect(run({ op: 'process', input_path: 'source.dng', output_path: 'source.dng', raw: {}, overwrite: true })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
  });
  it('converts an embedded wide-gamut profile into tagged sRGB without retaining private metadata', async () => {
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#d24b2d' } }).withIccProfile('p3').withExif({ IFD0: { Artist: 'private-fixture' } }).png().toBuffer();
    fs.writeFileSync(path.join(root, 'p3.png'), bytes);
    await run({ op: 'process', input_path: 'p3.png', output_path: 'srgb.png', color: { output: 'srgb' } });
    const info = await sharp(path.join(root, 'srgb.png')).metadata();
    const expected = await sharp(bytes).withIccProfile('srgb').png().toBuffer();
    expect(info.hasProfile).toBe(true); expect(info.exif).toBeUndefined();
    expect(info.icc).toEqual((await sharp(expected).metadata()).icc);
    expect(await sharp(path.join(root, 'srgb.png')).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
    expect(fs.readFileSync(path.join(root, 'p3.png'))).toEqual(bytes);
  });
  it('does not authorize old outputs when color settings change and rejects unsupported profiles', async () => {
    await sharp({ create: { width: 128, height: 128, channels: 3, background: '#228855' } }).png().toFile(path.join(root, 'source.png'));
    const request: any = { op: 'batch', items: [{ input_path: 'source.png', output_path: 'out.png' }] };
    expect(await run(request)).toMatchObject({ completed: 1, failed: 0 });
    const before = fs.readFileSync(path.join(root, 'out.png'));
    request.color = { output: 'srgb' };
    expect(await run(request)).toMatchObject({ completed: 0, reused: 0, failed: 1 });
    expect(fs.readFileSync(path.join(root, 'out.png'))).toEqual(before);
    await expect(run({ op: 'process', input_path: 'source.png', output_path: 'new.png', color: { output: 'invented' } })).rejects.toThrow(/E_IMAGE_ASSET_COLOR/);
    expect(fs.existsSync(path.join(root, 'new.png'))).toBe(false);
  });
  nativeIt('stops the actual decoder on cancellation or timeout before reporting completion', async () => {
    const raw = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/raw_photo.js');
    const input = path.join(root, 'source.dng'); fs.writeFileSync(input, bayerDng());
    const controller = new AbortController(); controller.abort();
    await expect(raw.develop(input, path.join(root, 'cancelled.tiff'), raw.settings({}), 600_000, controller.signal)).rejects.toMatchObject({ code: 'E_RAW_CANCELLED' });
    await expect(raw.develop(input, path.join(root, 'timeout.tiff'), raw.settings({}), 1)).rejects.toMatchObject({ code: 'E_RAW_TIMEOUT' });
    expect(fs.existsSync(path.join(root, 'cancelled.tiff'))).toBe(false);
    expect(fs.readFileSync(input)).toEqual(bayerDng());
  });
  nativeIt('does not start another photo after cancellation and leaves unfinished outputs absent', async () => {
    const raw = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/raw_photo.js');
    const develop = raw.develop;
    const spy = vi.spyOn(raw, 'develop').mockImplementation(async (...args: any[]) => {
      await develop(...args);
      process.emit('SIGINT');
    });
    try {
      for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${name}.dng`), bayerDng());
      const result = await run({ op: 'batch', raw: {}, items: ['a', 'b', 'c'].map(name => ({ input_path: `${name}.dng`, output_path: `${name}.png` })) });
      expect(result).toMatchObject({ ok: false, completed: 0, failed: 1, pending: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
      for (const name of ['a', 'b', 'c']) expect(fs.existsSync(path.join(root, `${name}.png`))).toBe(false);
      expect(fs.readdirSync(root).some(name => name.startsWith('.raw-'))).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('rejects a malformed embedded ICC tag table before publishing a color conversion', async () => {
    const jpeg = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const icc = Buffer.alloc(132); icc.writeUInt32BE(132); icc.write('acsp', 36); icc.writeUInt32BE(5, 128);
    const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([1, 1]), icc]);
    const marker = Buffer.from([255, 226, 0, 0]); marker.writeUInt16BE(payload.length + 2, 2);
    const input = Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
    fs.writeFileSync(path.join(root, 'corrupt-profile.jpg'), input);
    expect((await sharp(input).metadata()).icc).toEqual(icc);
    await expect(run({ op: 'process', input_path: 'corrupt-profile.jpg', output_path: 'out.png', color: { output: 'srgb' } })).rejects.toThrow(/E_IMAGE_ASSET_COLOR/);
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'corrupt-profile.jpg'))).toEqual(input);
  });
  it('reports a missing bundled engine without a system-binary or embedded-preview fallback', async () => {
    vi.stubEnv('ORKAS_PC_DIR', root); vi.stubEnv('ORKAS_LIBRAW', path.join(root, 'missing'));
    const original = bayerDng(); fs.writeFileSync(path.join(root, 'source.dng'), original);
    await expect(run({ op: 'process', input_path: 'source.dng', output_path: 'out.png', raw: {} })).rejects.toThrow(/E_RAW_UNAVAILABLE/);
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'source.dng'))).toEqual(original);
    expect(fs.readdirSync(root).some(name => name.startsWith('.raw-'))).toBe(false);
  });
  it('keeps the structured validation error for a malformed batch member', async () => {
    await expect(run({ op: 'batch', items: [null] })).rejects.toThrow(/E_IMAGE_ASSET_ARGUMENT/);
  });
});
