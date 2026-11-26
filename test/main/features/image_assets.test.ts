import { describe, expect, it } from 'vitest';
import sharp from '../../helpers/fixture-sharp';

import {
  inspectImageAssetBuffer,
  prepareLosslessModelImage,
} from '../../../src/main/features/image_assets';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('model image preparation', () => {
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
});
