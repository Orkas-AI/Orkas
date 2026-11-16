import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeNativeImage } from '../../../src/main/features/video_studio_qa';

describe('native image BGRA diagnostics', () => {
  it.each([
    { name: 'red', pixels: [0, 0, 255, 255, 0, 0, 255, 255], brightness: 54.21, contrast: 0 },
    { name: 'blue', pixels: [255, 0, 0, 255, 255, 0, 0, 255], brightness: 18.41, contrast: 0 },
    { name: 'green', pixels: [0, 255, 0, 255, 0, 255, 0, 255], brightness: 182.38, contrast: 0 },
    { name: 'white', pixels: [255, 255, 255, 255, 255, 255, 255, 255], brightness: 255, contrast: 0 },
    { name: 'black', pixels: [0, 0, 0, 255, 0, 0, 0, 255], brightness: 0, contrast: 0 },
    { name: 'red and black', pixels: [0, 0, 255, 255, 0, 0, 0, 255], brightness: 27.11, contrast: 27.11 },
    { name: 'blue and black', pixels: [255, 0, 0, 255, 0, 0, 0, 255], brightness: 9.21, contrast: 9.21 },
  ])('measures $name BGRA pixels without changing their identity', ({ pixels, brightness, contrast }) => {
    // Known colour patches calibrate the diagnostic values independently from
    // the implementation. Red/blue distinguish channel order; neutral colours
    // alone would miss it, and split patches also exercise spatial contrast.
    const bitmap = Buffer.from(pixels);
    const original = Buffer.from(bitmap);
    const image = {
      getSize: () => ({ width: 2, height: 1 }),
      toBitmap: () => bitmap,
    } as unknown as Parameters<typeof analyzeNativeImage>[0];

    expect(analyzeNativeImage(image)).toMatchObject({
      width: 2, height: 1, brightness, contrast,
      hash: createHash('sha256').update(original).digest('hex'),
    });
    expect(bitmap).toEqual(original);
  });

});
