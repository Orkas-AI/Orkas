import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const asset = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js');
let root: string;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-photo-batch-')));
  await sharp(Buffer.from([32, 64, 96]), { raw: { width: 1, height: 1, channels: 3 } }).png().toFile(path.join(root, 'a.png'));
  fs.copyFileSync(path.join(root, 'a.png'), path.join(root, 'b.png'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
async function run(request: unknown) {
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
  return asset({ args: ['--project', root, '--request', 'request.json'] });
}
async function pixels(name: string) {
  return [...await sharp(path.join(root, name)).removeAlpha().raw().toBuffer()];
}
const items = () => [
  { input_path: 'a.png', output_path: 'edited/a.png' },
  { input_path: 'b.png', output_path: 'edited/b.png' },
];

it('applies shared photo adjustments and an explicit per-photo replacement while preserving originals', async () => {
  const original = fs.readFileSync(path.join(root, 'a.png'));
  const result = await run({ op: 'batch', operations: [{ type: 'linear', a: 2, b: 0 }], items: [
    items()[0], { ...items()[1], operations: [{ type: 'linear', a: [2, 1, .5], b: 0 }] },
  ] });
  expect(result).toMatchObject({ ok: true, model_calls: 0, completed: 2, failed: 0, reused: 0 });
  expect(await pixels('edited/a.png')).toEqual([64, 128, 192]);
  expect(await pixels('edited/b.png')).toEqual([64, 64, 48]);
  expect(fs.readFileSync(path.join(root, 'a.png'))).toEqual(original);
  expect(fs.readFileSync(path.join(root, 'b.png'))).toEqual(original);
});

it('supports bounded brightness and saturation without synthesizing new content', async () => {
  await run({ op: 'process', ...items()[0], operations: [{ type: 'modulate', brightness: 1.5, saturation: 0 }] });
  const value = await pixels('edited/a.png');
  expect(Math.max(...value) - Math.min(...value)).toBeLessThanOrEqual(1);
  expect(value[0]).toBeGreaterThan(64);
});

it('resumes verified completed photos and retries only the repaired failed input', async () => {
  fs.writeFileSync(path.join(root, 'b.png'), 'interrupted upload');
  const request = { op: 'batch', operations: [{ type: 'linear', a: 2 }], items: items() };
  const failed = await run(request);
  expect(failed).toMatchObject({ ok: false, completed: 1, failed: 1, reused: 0, model_calls: 0 });
  expect(failed.items[1]).toMatchObject({ status: 'failed', error_code: 'E_IMAGE_ASSET_INVALID' });
  const firstBytes = fs.readFileSync(path.join(root, 'edited/a.png'));
  const firstTime = fs.statSync(path.join(root, 'edited/a.png')).mtimeMs;
  fs.copyFileSync(path.join(root, 'a.png'), path.join(root, 'b.png'));
  const recovered = await run(request);
  expect(recovered).toMatchObject({ ok: true, completed: 1, reused: 1, failed: 0 });
  expect(fs.readFileSync(path.join(root, 'edited/a.png'))).toEqual(firstBytes);
  expect(fs.statSync(path.join(root, 'edited/a.png')).mtimeMs).toBe(firstTime);
  expect(await pixels('edited/b.png')).toEqual([64, 128, 192]);
});

it('does not trust stale receipts or silently overwrite a previous delivery after a parameter change', async () => {
  const request = { op: 'batch', operations: [{ type: 'linear', a: 2 }], items: items() };
  await run(request);
  const changed = await run({ ...request, operations: [{ type: 'linear', a: 3 }] });
  expect(changed).toMatchObject({ ok: false, reused: 0, completed: 0, failed: 2 });
  expect(await pixels('edited/a.png')).toEqual([64, 128, 192]);
  fs.copyFileSync(path.join(root, 'a.png'), path.join(root, 'edited/a.png'));
  const tampered = await run(request);
  expect(tampered).toMatchObject({ ok: false, reused: 1, failed: 1 });
});

it.each([
  [{ ...items()[0], output_path: 'a.png' }],
  [items()[0], { ...items()[1], output_path: 'edited/a.png' }],
  [items()[0], { input_path: 'edited/a.png', output_path: 'edited/c.png' }],
  [items()[0], { ...items()[1], output_path: '../escape.png' }],
])('rejects an unsafe batch before writing any photo: %j', async batch => {
  const original = fs.readFileSync(path.join(root, 'a.png'));
  await expect(run({ op: 'batch', items: batch })).rejects.toThrow(/E_IMAGE_ASSET_/);
  expect(fs.existsSync(path.join(root, 'edited/a.png'))).toBe(false);
  expect(fs.readFileSync(path.join(root, 'a.png'))).toEqual(original);
});

it.each([
  { type: 'linear', a: Infinity }, { type: 'linear', a: [1, 2] },
  { type: 'modulate', saturation: -1 }, { type: 'modulate', brightness: 5 },
  { type: 'modulate', hue: 181 },
])('rejects invalid photo parameters before partial processing: %j', async operation => {
  await expect(run({ op: 'batch', items: [items()[0], { ...items()[1], operations: [operation] }] }))
    .rejects.toThrow('E_IMAGE_ASSET_ARGUMENT');
  expect(fs.existsSync(path.join(root, 'edited/a.png'))).toBe(false);
});

it('bounds batch work and refuses an empty job rather than reporting a completed collection', async () => {
  await expect(run({ op: 'batch', items: [] })).rejects.toThrow('E_IMAGE_ASSET_LIMIT');
  await expect(run({ op: 'batch', items: Array(129).fill(items()[0]) })).rejects.toThrow('E_IMAGE_ASSET_LIMIT');
});

it('publishes concurrent outputs without replacing the winner or leaving partial files', async () => {
  const make = (name: string, a: number) => {
    fs.writeFileSync(path.join(root, name), JSON.stringify({ op: 'batch', items: [{ ...items()[0], operations: [{ type: 'linear', a }] }] }));
    return asset({ args: ['--project', root, '--request', name] });
  };
  const results = await Promise.allSettled([make('one.json', 1), make('two.json', 2)]);
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  const values = results.map(result => result.status === 'fulfilled' ? result.value : {});
  expect(values.reduce((sum, value) => sum + value.completed, 0)).toBe(1);
  expect(values.reduce((sum, value) => sum + value.failed, 0)).toBe(1);
  expect([[32, 64, 96], [64, 128, 192]]).toContainEqual(await pixels('edited/a.png'));
  expect(fs.readdirSync(path.join(root, 'edited')).some(name => name.includes('.tmp'))).toBe(false);
});

it('keeps alpha unchanged during per-channel photo adjustments', async () => {
  await sharp(Buffer.from([32, 64, 96, 80]), { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(path.join(root, 'alpha.png'));
  await run({ op: 'batch', items: [{ input_path: 'alpha.png', output_path: 'alpha-adjusted.png', operations: [{ type: 'linear', a: [2, 1, .5] }] }] });
  const rgba = await sharp(path.join(root, 'alpha-adjusted.png')).raw().toBuffer();
  expect([...rgba]).toEqual([64, 64, 48, 80]);
});

it.skipIf(process.platform === 'win32')('rejects a POSIX symlink receipt that could delete the original', async () => {
  fs.symlinkSync(path.join(root, 'a.png'), path.join(root, 'delivery.png.image-normalization.json'));
  await expect(run({ op: 'process', input_path: 'a.png', output_path: 'delivery.png' })).rejects.toThrow('E_IMAGE_ASSET_PATH');
  expect(fs.existsSync(path.join(root, 'a.png'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'delivery.png'))).toBe(false);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'user notes');
  fs.symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'batch.png.image-batch.json'));
  await expect(run({ op: 'batch', items: [{ input_path: 'a.png', output_path: 'batch.png' }] })).rejects.toThrow('E_IMAGE_ASSET_PATH');
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('user notes');
  expect(fs.existsSync(path.join(root, 'batch.png'))).toBe(false);
});

it('accepts the complete 128-photo batch boundary and reuses all completed outputs', async () => {
  const request = { op: 'batch', items: Array.from({ length: 128 }, (_, index) => ({ input_path: 'a.png', output_path: `out/${index}.png` })) };
  expect(await run(request)).toMatchObject({ ok: true, completed: 128, reused: 0, failed: 0 });
  expect(await run(request)).toMatchObject({ ok: true, completed: 0, reused: 128, failed: 0 });
});

it('composites only a binary mask selection and preserves every protected RGBA byte', async () => {
  await sharp(Buffer.from([32, 64, 96, 80, 30, 60, 90, 40]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(path.join(root, 'original.png'));
  await sharp({ create: { width: 2, height: 1, channels: 4, background: '#bbbbbb' } }).png().toFile(path.join(root, 'background.png'));
  await sharp(Buffer.from([255, 0]), { raw: { width: 2, height: 1, channels: 1 } }).png().toFile(path.join(root, 'mask.png'));
  const original = fs.readFileSync(path.join(root, 'original.png'));
  const result = await run({ op: 'masked_composite', input_path: 'original.png', background_path: 'background.png', mask_path: 'mask.png', output_path: 'masked.png' });
  expect(result).toMatchObject({ ok: true, model_calls: 0, protected_pixels_verified: true });
  expect([...await sharp(path.join(root, 'masked.png')).raw().toBuffer()]).toEqual([187, 187, 187, 255, 30, 60, 90, 40]);
  expect(fs.readFileSync(path.join(root, 'original.png'))).toEqual(original);
  await expect(run({ op: 'masked_composite', input_path: 'original.png', background_path: 'background.png', mask_path: 'mask.png', output_path: 'original.png', overwrite: true }))
    .rejects.toThrow('E_IMAGE_ASSET_PATH');
});

it('rejects feathered or mismatched masks before writing an unverifiable output', async () => {
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#777777' } }).png().toFile(path.join(root, 'mask.png'));
  const request = { op: 'masked_composite', input_path: 'a.png', background_path: 'b.png', mask_path: 'mask.png', output_path: 'masked.png' };
  await expect(run(request)).rejects.toThrow('E_IMAGE_ASSET_MASK');
  await sharp({ create: { width: 2, height: 1, channels: 3, background: '#ffffff' } }).png().toFile(path.join(root, 'mask.png'));
  await expect(run(request)).rejects.toThrow('E_IMAGE_ASSET_MASK');
  expect(fs.existsSync(path.join(root, 'masked.png'))).toBe(false);
});
