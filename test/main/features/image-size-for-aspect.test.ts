import { describe, expect, it } from 'vitest';
import { findImageGenCapability } from '../../../src/main/model/provider_catalog';
import { ORKAS_API_PROVIDER } from '../../../src/main/features/orkas_api';
import { imageSizeForAspect, normaliseSeedreamSize, normaliseGeminiImageSize } from '../../../src/main/features/image_size';
describe('configured service stills for a video canvas', () => {
  it.each([
    { api: 'doubao', model: 'doubao-seedream-5-0-pro-260628', aspect: 9 / 16, size: '1440x2560' },
    { api: 'doubao', model: 'doubao-seedream-5-0-flash-260915', aspect: 16 / 9, size: '2560x1440' },
    { ...findImageGenCapability(ORKAS_API_PROVIDER)!, aspect: 9 / 16, size: '1440x2560' },
    { api: 'gemini', model: 'gemini-3.1-flash-image', aspect: 16 / 9, size: '2752x1536' },
    { api: 'gemini', model: 'gemini-2.5-flash-image', aspect: 9 / 16, size: '768x1344' },
  ])('preserves the requested shape using a real supported table size: $api/$model', ({ api, model, aspect, size }) => {
    expect(imageSizeForAspect({ api, model }, aspect)).toBe(size);
    if (api === 'doubao') expect(normaliseSeedreamSize(size, model)).toBe(size);
    if (api === 'gemini') expect(normaliseGeminiImageSize(size, model)).toBeDefined();
  });
  it.each([NaN, Infinity, 0, -1])('keeps the service default for an invalid aspect %s', aspect => { expect(imageSizeForAspect({ api: 'doubao', model: 'known' }, aspect)).toBeUndefined(); });
  it('keeps an unknown service default rather than inventing supported dimensions', () => { expect(imageSizeForAspect({ api: 'openai-images', model: 'unknown' }, 9 / 16)).toBeUndefined(); });
});
