import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageStudioFileHash, isImageStudioGeneration } from '../../../src/main/features/image_studio_provenance';
const require = createRequire(import.meta.url);
const imageAsset = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js');
let root: string;
let outputs: Array<{ output_path: string; output_sha256: string }>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-provenance-'));
  await sharp(Buffer.from('<svg width="256" height="128"><rect width="256" height="128" fill="#b92645"/><circle cx="150" cy="70" r="48" fill="#eee5c1"/></svg>')).png().toFile(path.join(root, 'provider.png'));
  outputs = [{ output_path: path.join(root, 'provider.png'), output_sha256: await imageStudioFileHash(path.join(root, 'provider.png')) }];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const verify = (name: string) => isImageStudioGeneration({ projectDirAbs: root, rasterAbsPath: path.join(root, name), outputs });
async function processAsset(request: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ op: 'process', input_path: 'provider.png', ...request }));
  return imageAsset({ args: ['--project', root, '--request', 'request.json'] });
}
describe('generation artifact provenance', () => {
  it('binds exemption to recorded provider bytes rather than the output path alone', async () => {
    expect(await verify('provider.png')).toBe(true);
    fs.writeFileSync(path.join(root, 'provider.png'), 'replaced');
    expect(await verify('provider.png')).toBe(false);
    expect(await isImageStudioGeneration({ projectDirAbs: root, rasterAbsPath: outputs[0].output_path, outputs: [] })).toBe(false);
  });
  it('preserves verified format conversion and proportional resize across a chain', async () => {
    await processAsset({ output_path: 'scaled.png', operations: [{ type: 'resize', width: 128, height: 64, fit: 'contain' }] });
    expect(await verify('scaled.png')).toBe(true);
    await processAsset({ input_path: 'scaled.png', output_path: 'delivery.jpg' });
    expect(await verify('delivery.jpg')).toBe(true);
    expect(await imageStudioFileHash(outputs[0].output_path)).toBe(outputs[0].output_sha256);
    const size = await sharp(path.join(root, 'delivery.jpg')).metadata();
    expect(size).toMatchObject({ width: 128, height: 64, format: 'jpeg' });
  });
  it('does not inherit exemption for crop, stretch, masking or overlay', async () => {
    await sharp({ create: { width: 30, height: 20, channels: 4, background: '#0055ff' } }).png().toFile(path.join(root, 'mark.png'));
    for (const [name, request] of Object.entries({
      crop: { operations: [{ type: 'extract', left: 0, top: 0, width: 128, height: 64 }] },
      stretch: { operations: [{ type: 'resize', width: 128, height: 128, fit: 'fill' }] },
      overlay: { composite_layers: [{ path: 'mark.png', left: 0, top: 0 }] },
      mask: { composite_layers: [{ path: 'mark.png', left: 0, top: 0, blend: 'dest-in' }] },
    })) {
      await processAsset({ output_path: `${name}.png`, ...request });
      expect(await verify(`${name}.png`)).toBe(false);
    }
  });
  it('rejects a forged normalization receipt and a changed ancestor', async () => {
    await processAsset({ output_path: 'scaled.png', operations: [{ type: 'resize', width: 128, height: 64, fit: 'fill' }] });
    expect(await verify('scaled.png')).toBe(true);
    const receiptPath = path.join(root, 'scaled.png.image-normalization.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    await sharp({ create: { width: 128, height: 64, channels: 4, background: '#00ff00' } }).png().toFile(path.join(root, 'scaled.png'));
    receipt.output_sha256 = await imageStudioFileHash(path.join(root, 'scaled.png'));
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(await verify('scaled.png')).toBe(false);
    await processAsset({ output_path: 'second.png', operations: [{ type: 'resize', width: 128, height: 64, fit: 'fill' }] });
    fs.writeFileSync(path.join(root, 'provider.png'), 'changed ancestor');
    expect(await verify('second.png')).toBe(false);
  });
  it('rejects out-of-project and cyclic ancestry without granting generation', async () => {
    const receipt = { schema_version: 1, input_path: 'provider.png', input_sha256: outputs[0].output_sha256, output_sha256: outputs[0].output_sha256, format: 'png', quality: 92, resize: false };
    fs.copyFileSync(path.join(root, 'provider.png'), path.join(root, 'copy.png'));
    for (const inputPath of ['../outside.png', 'copy.png']) {
      fs.writeFileSync(path.join(root, 'copy.png.image-normalization.json'), JSON.stringify({ ...receipt, input_path: inputPath }));
      expect(await verify('copy.png')).toBe(false);
    }
  });
});
