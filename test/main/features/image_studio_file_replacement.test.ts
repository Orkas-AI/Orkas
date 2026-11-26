import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
const scriptPath = require.resolve('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js');
let root = '';
let original: Buffer;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-replacement-')));
  original = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#cc2244' } }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'output.png'), original);
  fs.writeFileSync(path.join(root, 'source.png'), await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#22cc44' },
  }).png().toBuffer());
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function runner() {
  const run = require(scriptPath) as (input: { args: string[] }) => Promise<Record<string, unknown>>;
  return (overrides: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({
      op: 'process', input_path: 'source.png', output_path: 'output.png', overwrite: true, ...overrides,
    }));
    return run({ args: ['--project', root, '--request', 'request.json'] });
  };
}

function expectOriginalPreserved() {
  expect(fs.readFileSync(path.join(root, 'output.png'))).toEqual(original);
  expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
}

async function expectReplacement() {
  const decoded = await sharp(path.join(root, 'output.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: 8, height: 8, channels: 4 });
  expect([...decoded.data.subarray(0, 4)]).toEqual([34, 204, 68, 255]);
  expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
}

describe('ImageStudio local image file replacement', () => {
  it('replaces the requested file with a readable new image', async () => {
    const source = fs.readFileSync(path.join(root, 'source.png'));
    expect(await runner()()).toMatchObject({ ok: true, output_path: path.join(root, 'output.png') });
    await expectReplacement();
    expect(fs.readFileSync(path.join(root, 'source.png'))).toEqual(source);
  });

  it('supports using the original path as both input and output', async () => {
    const run = runner();
    const result = await run({ input_path: 'output.png', operations: [{ type: 'resize', width: 4, height: 4 }] });
    expect(result.ok).toBe(true);
    expect((await sharp(path.join(root, 'output.png')).metadata()).width).toBe(4);
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it.each(['EPERM', 'EACCES'])('preserves the original on %s and can retry after the obstruction is removed', async (code) => {
    const run = runner();
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(root, 'output.png')) {
        throw Object.assign(new Error('Synthetic replacement denial'), { code });
      }
      return rename(from, to);
    });
    await expect(run()).rejects.toMatchObject({ code });
    expectOriginalPreserved();
    fault.mockRestore();
    expect((await run()).ok).toBe(true);
    await expectReplacement();
  });

  it('preserves the original when preparing or validating the replacement fails', async () => {
    fs.writeFileSync(path.join(root, 'source.png'), 'invalid image');
    await expect(runner()()).rejects.toThrow(/unsupported image format/i);
    expectOriginalPreserved();
  });

  it('requires explicit overwrite for an existing output', async () => {
    await expect(runner()({ overwrite: false })).rejects.toMatchObject({ code: 'E_IMAGE_ASSET_EXISTS' });
    expectOriginalPreserved();
  });
});
