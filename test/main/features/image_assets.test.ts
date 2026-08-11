import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import {
  inspectImageAssetBuffer,
  prepareLosslessModelImage,
  writeImageAssetBuffer,
} from '../../../src/main/features/image_assets';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let root = '';
let projectDir = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-assets-'));
  projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('image asset materialization', () => {
  it('inspects valid image bytes and rejects empty, unreadable, and oversized inputs', async () => {
    await expect(inspectImageAssetBuffer(PNG_1X1)).resolves.toMatchObject({
      format: 'png',
      width: 1,
      height: 1,
      channels: 4,
      bytes: PNG_1X1.length,
    });
    await expect(inspectImageAssetBuffer(Buffer.alloc(0)))
      .rejects.toThrow('image response is empty');
    await expect(inspectImageAssetBuffer(Buffer.from('not-an-image')))
      .rejects.toThrow('not a readable image');
    await expect(inspectImageAssetBuffer(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"/>',
    ))).rejects.toThrow('exceeds the image dimension limit');
  });

  it('transcodes to the requested format and reports deterministic zero-model metadata', async () => {
    const output = path.join(projectDir, 'nested', 'result.jpg');

    const result = await writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: output,
      buffer: PNG_1X1,
      quality: 87,
    });

    expect(result).toMatchObject({
      output_path: output,
      format: 'jpeg',
      width: 1,
      height: 1,
      engine: 'sharp',
      model_calls: 0,
    });
    expect(fs.readFileSync(output).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(fs.readdirSync(path.dirname(output))).toEqual(['result.jpg']);
  });

  it('creates a smaller pixel-identical lossless model copy without changing the source', async () => {
    const source = await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 4,
        background: { r: 24, g: 96, b: 180, alpha: 1 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();
    const sourceSnapshot = Buffer.from(source);

    const result = await prepareLosslessModelImage(source);
    const sourcePixels = await sharp(source).ensureAlpha().raw().toBuffer();
    const resultPixels = await sharp(result.buf).ensureAlpha().raw().toBuffer();

    expect(result).toMatchObject({
      mediaType: 'image/webp',
      width: 320,
      height: 200,
      sourceBytes: source.length,
      encodedBytes: result.buf.length,
      transcoded: true,
    });
    expect(result.buf.length).toBeLessThan(source.length);
    expect(resultPixels).toEqual(sourcePixels);
    expect(source).toEqual(sourceSnapshot);
  });

  it('keeps the original PNG when lossless WebP would increase payload size', async () => {
    let state = 123_456_789;
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state & 0xff;
    }
    const source = await sharp(pixels, {
      raw: { width: 4, height: 4, channels: 4 },
    }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();

    const result = await prepareLosslessModelImage(source);

    expect(result).toMatchObject({
      mediaType: 'image/png',
      width: 4,
      height: 4,
      sourceBytes: source.length,
      encodedBytes: source.length,
      transcoded: false,
    });
    expect(result.buf).toBe(source);
  });

  it('rejects invalid or non-PNG model inputs instead of bypassing lossless preprocessing', async () => {
    const jpeg = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).jpeg().toBuffer();

    await expect(prepareLosslessModelImage(Buffer.from('not-an-image')))
      .rejects.toThrow('not a readable image');
    await expect(prepareLosslessModelImage(jpeg))
      .rejects.toThrow('requires PNG input');
  });

  it('rejects paths and arguments before publishing an output', async () => {
    const outside = path.join(root, 'outside.png');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: outside,
      buffer: PNG_1X1,
    })).rejects.toThrow('must stay inside the image project');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(projectDir, 'result.gif'),
      buffer: PNG_1X1,
    })).rejects.toThrow('must end in png, jpg, jpeg, or webp');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(projectDir, 'result.png'),
      buffer: PNG_1X1,
      quality: 0,
    })).rejects.toThrow('quality must be an integer from 1 to 100');
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects an output routed through a project-local symlink', async () => {
    const outsideDir = path.join(root, 'outside');
    const escape = path.join(projectDir, 'escape');
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, escape, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(escape, 'escaped.png'),
      buffer: PNG_1X1,
    })).rejects.toThrow('must stay inside the image project');

    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it('never replaces an existing output and cleans its completed temporary file', async () => {
    const output = path.join(projectDir, 'result.webp');
    fs.writeFileSync(output, 'user-owned-bytes', 'utf8');

    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: output,
      buffer: PNG_1X1,
    })).rejects.toThrow('E_IMAGE_ASSET_EXISTS');

    expect(fs.readFileSync(output, 'utf8')).toBe('user-owned-bytes');
    expect(fs.readdirSync(projectDir)).toEqual(['result.webp']);
  });
});
