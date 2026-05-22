import { describe, it, expect, beforeAll } from 'vitest';
import { prepareFeedbackUploadImage, toCompressedGrayJpeg } from '../../../src/main/util/image-transform';

let sourcePng: Buffer;

beforeAll(async () => {
  // Build a 2000x1500 colorful PNG via jimp (test-only dep on the same lib).
  const { Jimp } = await import('jimp' as any);
  const img: any = new Jimp({ width: 2000, height: 1500, color: 0x336699FF });
  // Stamp a few colored bands so greyscale conversion has something to verify.
  img.scan(0, 0, 2000, 100, function (this: any, _x: number, _y: number, idx: number) {
    this.bitmap.data[idx + 0] = 220;
    this.bitmap.data[idx + 1] = 30;
    this.bitmap.data[idx + 2] = 30;
  });
  sourcePng = await img.getBuffer('image/png');
});

describe('image-transform › toCompressedGrayJpeg', () => {
  it('downscales long edge to maxDim and emits JPEG', async () => {
    const r = await toCompressedGrayJpeg(sourcePng, { maxDim: 800, quality: 60 });
    expect(r.mimeType).toBe('image/jpeg');
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(800);
    // JPEG magic
    expect(r.buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // Sanity: non-zero byte length
    expect(r.buf.length).toBeGreaterThan(100);
  });

  it('produces grayscale pixels (R≈G≈B for sampled pixel)', async () => {
    const r = await toCompressedGrayJpeg(sourcePng, { maxDim: 200 });
    const { Jimp } = await import('jimp' as any);
    const out: any = await Jimp.read(r.buf);
    // Sample a band that started red — after greyscale, R/G/B should be near-equal.
    const px = out.getPixelColor(50, 50); // 0xRRGGBBAA
    const r8 = (px >>> 24) & 0xff;
    const g8 = (px >>> 16) & 0xff;
    const b8 = (px >>> 8)  & 0xff;
    expect(Math.abs(r8 - g8)).toBeLessThanOrEqual(8);
    expect(Math.abs(g8 - b8)).toBeLessThanOrEqual(8);
  });

  it('does not upscale when source is smaller than maxDim', async () => {
    const { Jimp } = await import('jimp' as any);
    const small: any = new Jimp({ width: 100, height: 80, color: 0xFFFFFFFF });
    const smallPng: Buffer = await small.getBuffer('image/png');
    const r = await toCompressedGrayJpeg(smallPng, { maxDim: 1024 });
    expect(r.width).toBe(100);
    expect(r.height).toBe(80);
  });

  it('rejects empty buffer', async () => {
    await expect(toCompressedGrayJpeg(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});

describe('image-transform › prepareFeedbackUploadImage', () => {
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
});
