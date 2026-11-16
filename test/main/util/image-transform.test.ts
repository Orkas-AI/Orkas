import { describe, it, expect, beforeAll } from 'vitest';
import {
  flattenTransparentImageToJpeg,
  prepareFeedbackUploadImage,
  toCompressedJpeg,
} from '../../../src/main/util/image-transform';

let sourcePng: Buffer;

beforeAll(async () => {
  // Build a 2000x1500 colorful PNG via jimp (test-only dep on the same lib).
  const { Jimp } = await import('jimp' as any);
  const img: any = new Jimp({ width: 2000, height: 1500, color: 0x336699FF });
  // Include red and blue regions to detect lost color after compression.
  img.scan(0, 0, 2000, 100, function (this: any, _x: number, _y: number, idx: number) {
    this.bitmap.data[idx + 0] = 220;
    this.bitmap.data[idx + 1] = 30;
    this.bitmap.data[idx + 2] = 30;
  });
  sourcePng = await img.getBuffer('image/png');
});

describe('image-transform › toCompressedJpeg', () => {
  it('downscales long edge to maxDim and emits JPEG', async () => {
    const r = await toCompressedJpeg(sourcePng, { maxDim: 800, quality: 60 });
    expect(r.mimeType).toBe('image/jpeg');
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(800);
    // JPEG magic
    expect(r.buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // Sanity: non-zero byte length
    expect(r.buf.length).toBeGreaterThan(100);
  });

  it('preserves red and blue pixels with the default transform', async () => {
    const r = await toCompressedJpeg(sourcePng);
    const { Jimp } = await import('jimp' as any);
    const out: any = await Jimp.read(r.buf);
    for (const [x, y, expected] of [
      [50, 20, [220, 30, 30]],
      [50, 100, [51, 102, 153]],
    ] as const) {
      const px = out.getPixelColor(x, y);
      const actual = [(px >>> 24) & 0xff, (px >>> 16) & 0xff, (px >>> 8) & 0xff];
      actual.forEach((channel, i) => expect(Math.abs(channel - expected[i])).toBeLessThan(15));
    }
  });

  it('does not upscale when source is smaller than maxDim', async () => {
    const { Jimp } = await import('jimp' as any);
    const small: any = new Jimp({ width: 100, height: 80, color: 0xFFFFFFFF });
    const smallPng: Buffer = await small.getBuffer('image/png');
    const r = await toCompressedJpeg(smallPng, { maxDim: 1024 });
    expect(r.width).toBe(100);
    expect(r.height).toBe(80);
  });

  it('flattens transparent images onto white before JPEG encoding', async () => {
    const { Jimp } = await import('jimp' as any);
    const transparent: any = new Jimp({ width: 80, height: 60, color: 0x00000000 });
    transparent.scan(25, 20, 30, 20, function (this: any, _x: number, _y: number, idx: number) {
      this.bitmap.data[idx + 0] = 0;
      this.bitmap.data[idx + 1] = 0;
      this.bitmap.data[idx + 2] = 0;
      this.bitmap.data[idx + 3] = 255;
    });
    const input: Buffer = await transparent.getBuffer('image/png');

    const result = await toCompressedJpeg(input, { maxDim: 100, quality: 90 });
    const output: any = await Jimp.read(result.buf);
    const background = output.getPixelColor(5, 5);
    const foreground = output.getPixelColor(40, 30);

    expect((background >>> 24) & 0xff).toBeGreaterThan(240);
    expect((foreground >>> 24) & 0xff).toBeLessThan(20);
  });

  it('only creates an OCR normalization copy for images with transparency', async () => {
    await expect(flattenTransparentImageToJpeg(sourcePng)).resolves.toBeNull();

    const { Jimp } = await import('jimp' as any);
    const transparent: any = new Jimp({ width: 20, height: 20, color: 0x00000000 });
    const input: Buffer = await transparent.getBuffer('image/png');
    const normalized = await flattenTransparentImageToJpeg(input);
    expect(normalized?.mimeType).toBe('image/jpeg');
  });

  it('rejects empty buffer', async () => {
    await expect(toCompressedJpeg(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});

describe('image-transform › prepareFeedbackUploadImage', () => {
  async function texturedImage(transparent = false): Promise<any> {
    const { Jimp } = await import('jimp' as any);
    const image: any = new Jimp({ width: 320, height: 240, color: 0xFFFFFFFF });
    let seed = 12345;
    image.scan(0, 0, 320, 240, function (this: any, x: number, y: number, idx: number) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        this.bitmap.data[idx + channel] = seed >>> 24;
      }
      if (transparent && x < 40 && y < 40) {
        this.bitmap.data.fill(0, idx, idx + 4);
      }
    });
    return image;
  }

  it.each(['image/png', 'image/jpeg'])('compresses %s below 1.5 MiB without changing its source', async (mimeType) => {
    const image = await texturedImage();
    const input: Buffer = await image.getBuffer(mimeType, { quality: 100 });
    const original = Buffer.from(input);
    expect(input.length).toBeLessThan(1536 * 1024);
    const result = await prepareFeedbackUploadImage(input, {
      fileName: mimeType === 'image/png' ? 'small.png' : 'small.jpeg', mimeType,
    });

    expect(result.compressed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.fileName).toBe('small.jpg');
    expect(result.buf.length).toBeLessThan(input.length);
    const { Jimp } = await import('jimp' as any);
    const decoded: any = await Jimp.read(result.buf);
    expect([decoded.bitmap.width, decoded.bitmap.height]).toEqual([320, 240]);
    expect(input.equals(original)).toBe(true);
  });

  it('keeps transparent backgrounds readable when a small PNG becomes JPEG', async () => {
    const image = await texturedImage(true);
    const input: Buffer = await image.getBuffer('image/png');
    const result = await prepareFeedbackUploadImage(input, { fileName: 'transparent.png' });
    expect(result.compressed).toBe(true);
    const { Jimp } = await import('jimp' as any);
    const decoded: any = await Jimp.read(result.buf);
    const pixel = decoded.getPixelColor(10, 10);
    for (const shift of [24, 16, 8]) expect((pixel >>> shift) & 0xff).toBeGreaterThan(240);
  });

  it('compresses large feedback images as color JPEG', async () => {
    const r = await prepareFeedbackUploadImage(sourcePng, {
      fileName: 'screen.png',
      mimeType: 'image/png',
      maxBytes: 200 * 1024,
      maxDim: 600,
      compressTriggerBytes: 0,
    });

    expect(r.compressed).toBe(true);
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.fileName).toBe('screen.jpg');
    expect(r.buf.length).toBeLessThanOrEqual(200 * 1024);
    expect(Math.max(r.width || 0, r.height || 0)).toBeLessThanOrEqual(600);

    const { Jimp } = await import('jimp' as any);
    const out: any = await Jimp.read(r.buf);
    const px = out.getPixelColor(20, 20);
    const r8 = (px >>> 24) & 0xff;
    const g8 = (px >>> 16) & 0xff;
    const b8 = (px >>> 8)  & 0xff;
    expect(Math.max(Math.abs(r8 - g8), Math.abs(g8 - b8), Math.abs(r8 - b8))).toBeGreaterThan(16);
  });

  it('keeps small feedback images untouched when compression is not useful', async () => {
    const { Jimp } = await import('jimp' as any);
    const small: any = new Jimp({ width: 120, height: 90, color: 0x6699CCFF });
    const smallPng: Buffer = await small.getBuffer('image/png');
    const r = await prepareFeedbackUploadImage(smallPng, {
      fileName: 'small.png',
      mimeType: 'image/png',
      maxBytes: 5 * 1024 * 1024,
    });

    expect(r.compressed).toBe(false);
    expect(r.mimeType).toBe('image/png');
    expect(r.fileName).toBe('small.png');
    expect(r.buf.equals(smallPng)).toBe(true);
  });

  it('does not try to compress oversized GIFs', async () => {
    await expect(prepareFeedbackUploadImage(Buffer.alloc(11), {
      fileName: 'clip.gif',
      mimeType: 'image/gif',
      maxBytes: 10,
    })).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('preserves GIF bytes and undecodable in-budget images', async () => {
    for (const [fileName, mimeType, input] of [
      ['clip.gif', 'image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
      ['unsupported.webp', 'image/webp', Buffer.from('undecodable image')],
    ] as const) {
      const result = await prepareFeedbackUploadImage(input, { fileName, mimeType });
      expect(result).toMatchObject({ fileName, mimeType, compressed: false });
      expect(result.buf.equals(input)).toBe(true);
    }
  });
});
