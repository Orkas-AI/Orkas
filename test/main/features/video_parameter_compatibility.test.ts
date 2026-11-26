import { describe, expect, it } from 'vitest';
import { fitVideoParameters, videoParameterModel } from '../../../src/main/features/video_parameter_compatibility';

describe('desired video output versus native provider settings', () => {
  it.each(['doubao'])('fits Flash controls for %s without changing the legacy default', provider => {
    const model = 'doubao-seedance-2-5-flash';
    expect(videoParameterModel(provider, model)?.spec).toMatchObject({
      minDuration: 4, maxDuration: 30, resolutions: ['480p', '720p'], images: 10, videos: 5,
    });
    expect(fitVideoParameters({ duration: 30, resolution: '1080p' }, provider, model))
      .toEqual({ duration: 30, resolution: '720p' });
    expect(fitVideoParameters({ operation: 'edit', duration: 5, ratio: '9:16' }, provider, model))
      .toEqual({ operation: 'edit', duration: -1, ratio: 'adaptive' });
    expect(fitVideoParameters({ firstFramePath: 'source.png', ratio: '16:9' }, provider, model).ratio).toBe('adaptive');
  });
  it('fits the failing H3 Lite request without mutating its desired output', () => {
    const wanted = { duration: 2, resolution: '720p', ratio: '9:16', generateAudio: false };
    expect(fitVideoParameters(wanted, 'minimax', 'MiniMax-H3-Lite'))
      .toEqual({ duration: 4, resolution: '768p', ratio: '9:16', generateAudio: true });
    expect(wanted).toEqual({ duration: 2, resolution: '720p', ratio: '9:16', generateAudio: false });
  });

  it.each([
    ['doubao', 'doubao-seedance-2-5-260628', 4, '720p'],
    ['minimax', 'MiniMax-H3-Max', 5, '768p'],
    ['vidu', 'viduq3-pro', 1, '720p'],
    ['kling', 'kling-v4-0-flash', 3, '720p'],
    ['google-cloud', 'veo-3.1-generate-001', 4, '720p'],
    ['aliyun', 'wan3.0-video', 2, '720p'],
    ['runway', 'gen4.5', 2, '720p'],
  ])('fits a short shot to %s/%s, not a universal duration', (provider, model, duration, resolution) => {
    expect(fitVideoParameters({ duration: 0.5, resolution: '720p' }, String(provider), String(model)))
      .toMatchObject({ duration, resolution });
  });

  it('uses Veo duration steps and its high-resolution duration requirement', () => {
    expect(fitVideoParameters({ duration: 5 }, 'google-cloud', 'veo-3.1-generate-001').duration).toBe(6);
    expect(fitVideoParameters({ duration: 4, resolution: '1080p' }, 'google-cloud', 'veo-3.1-generate-001').duration).toBe(8);
    expect(fitVideoParameters({ duration: 4, resolution: '4k' }, 'google-cloud', 'veo-3.1-generate-001').duration).toBe(8);
  });

  it('uses native editing settings without losing the source video or prompt', () => {
    const wanted = { duration: 2, ratio: '9:16', operation: 'edit' as const, prompt: 'Replace the sky', referenceVideoUrls: ['https://media.example/source.mp4'] };
    expect(fitVideoParameters(wanted, 'doubao', 'doubao-seedance-2-5-260628'))
      .toEqual({ ...wanted, duration: -1, ratio: 'adaptive' });
  });

  it('omits an unsupported Omni duration/seed control and preserves every reference', () => {
    const wanted = { duration: 2, generateAudio: false, seed: 123, referenceImagePaths: ['first.png', 'character.png'] };
    expect(fitVideoParameters(wanted, 'google', 'gemini-omni-1.1-flash'))
      .toEqual({ generateAudio: true, referenceImagePaths: wanted.referenceImagePaths });
  });

  it('fits Runway text ratios separately from image ratios', () => {
    expect(fitVideoParameters({ ratio: '1:1' }, 'runway', 'gen4.5').ratio).toBe('16:9');
    expect(fitVideoParameters({ ratio: '1:1', firstFramePath: 'source.png' }, 'runway', 'gen4.5').ratio).toBe('1:1');
  });

  it.each([
    ['doubao', 'doubao-seedance-2-0-fast-260128', '720p'],
    ['doubao', 'doubao-seedance-2-0-mini', '720p'],
    ['minimax', 'MiniMax-H3', '2k'], ['minimax', 'MiniMax-H3-Lite', '768p'],
    ['kling', 'kling-v4-0-flash', '720p'], ['google-cloud', 'veo-3.1-fast-generate-001', '1080p'],
  ])('converts an unsupported resolution without swapping %s/%s', (provider, model, resolution) => {
    const asked = model.startsWith('veo') ? '4k' : '1080p';
    expect(fitVideoParameters({ resolution: asked }, provider, model).resolution).toBe(resolution);
  });

  // The VideoStudio canvas fits its settings with this same rule (review S4-6, 2026-11-18).
  it('takes the lowest resolution offered not below one between tiers, and rounds a length up to a whole second', () => {
    expect(fitVideoParameters({ resolution: '540p' }, 'doubao', 'doubao-seedance-2-0-fast-260128').resolution).toBe('720p');
    expect(fitVideoParameters({ resolution: '540p' }, 'minimax', 'MiniMax-H3-Lite').resolution).toBe('768p');
    expect(fitVideoParameters({ resolution: '360p' }, 'minimax', 'MiniMax-H3-Highspeed').resolution).toBe('480p');
    expect(fitVideoParameters({ resolution: '540P' }, 'vidu', 'viduq3-turbo').resolution).toBe('540p');
    expect(fitVideoParameters({ duration: 8.4 }, 'doubao', 'doubao-seedance-2-0-260128').duration).toBe(9);
    expect(fitVideoParameters({ duration: 4.2 }, 'google-cloud', 'veo-3.1-fast-generate-001').duration).toBe(6);
    expect(fitVideoParameters({ duration: 1 }, 'runway', 'gen4.5').duration).toBe(2);
  });

  it.each([
    ['doubao', 'doubao-seedance-2-5-260628'], ['minimax', 'MiniMax-H3'], ['vidu', 'viduq3-pro'],
  ])('keeps the first frame native on %s/%s and leaves the desired canvas to local conversion', (provider, model) => {
    expect(fitVideoParameters({ firstFramePath: 'opening.png', ratio: '9:16' }, provider, model))
      .toEqual({ firstFramePath: 'opening.png', ratio: 'adaptive' });
  });

  it('keeps legal native automatic settings, valid requests and unknown models intact', () => {
    const automatic = { duration: -1, ratio: 'adaptive', resolution: '1080p', generateAudio: false };
    expect(fitVideoParameters(automatic, 'aliyun', 'wan3.0-video')).toEqual(automatic);
    expect(fitVideoParameters({ duration: 10, resolution: '768p' }, 'minimax', 'MiniMax-H3-Lite')).toEqual({ duration: 10, resolution: '768p' });
    expect(fitVideoParameters({ duration: 2, resolution: '720p' }, 'future-provider', 'future-model')).toEqual({ duration: 2, resolution: '720p' });
  });

  it('preserves a too-long shot for explicit multi-shot handling rather than truncating its action', () => {
    expect(fitVideoParameters({ duration: 30 }, 'minimax', 'MiniMax-H3-Lite').duration).toBe(30);
  });
});
