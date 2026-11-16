import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: [] as any[],
}));

vi.mock('../../../src/main/features/image_gen', () => ({
  listOpenImageGenCandidates: () => h.candidates,
}));

import {
  buildImageProductionQuoteSegment,
  checkImageProductionServices,
  imageProductionQuotePayloadSegments,
} from '../../../src/main/features/image_production_services';

function candidate(provider: string, supportsEdit = true): any {
  return {
    entry: { provider, apiKey: `${provider}-secret`, entryId: provider },
    capability: { model: `${provider}-model`, supportsEdit },
  };
}

beforeEach(() => {
  h.candidates = [];
});

describe('ImageStudio open-provider availability quote', () => {
  it('marks a configured provider as externally billed', () => {
    expect(buildImageProductionQuoteSegment(
      { requestId: 'hero', size: '2048x2048' },
      [candidate('openai')],
    )).toEqual({
      segment_id: 'hero',
      kind: 'image',
      billing_mode: 'external',
      provider: 'openai',
      size: '2048x2048',
    });
  });

  it('skips candidates that cannot edit when references are present', () => {
    expect(buildImageProductionQuoteSegment(
      { requestId: 'edit', referenceCount: 2 },
      [candidate('openai', false), candidate('google', true)],
    )).toMatchObject({
      billing_mode: 'external',
      provider: 'google',
      reference_images: ['reference-1', 'reference-2'],
    });
  });

  it('reports unavailable when no configured candidate can execute the request', () => {
    expect(buildImageProductionQuoteSegment(
      { requestId: 'edit', referenceCount: 1 },
      [candidate('openai', false)],
    )).toMatchObject({
      billing_mode: 'unavailable',
      provider: '',
    });
  });

  it('returns a local disclosure without network or in-app billing', async () => {
    h.candidates = [candidate('openai')];
    const quote = await checkImageProductionServices({
      requestId: 'private-edit',
      size: '2048x2048',
      referenceCount: 2,
    });
    expect(quote).not.toHaveProperty('in_app_credits_required_milli');
    expect(quote).toMatchObject({
      sufficient: true,
      external_billing_estimate_available: false,
      externally_billed_segment_ids: ['private-edit'],
      unavailable_segment_ids: [],
    });
  });

  it('keeps quote construction free of credentials and arbitrary request content', () => {
    const payload = imageProductionQuotePayloadSegments(
      { requestId: 'safe-id', size: '2k', referenceCount: 1 },
      [candidate('openai')],
    );
    expect(payload).toEqual([{
      segment_id: 'safe-id',
      kind: 'image',
      billing_mode: 'external',
      provider: 'openai',
      size: '2k',
      reference_images: ['reference-1'],
    }]);
    expect(JSON.stringify(payload)).not.toContain('openai-secret');
  });
});

// The app's explicit service choice must not silently quote a different provider.
it('quotes the selected configured service and keeps a missing or incapable selection unavailable', () => {
  const candidates = [candidate('openai'), candidate('google'), candidate('text-only', false)];
  expect(buildImageProductionQuoteSegment({ requestId: 'selected', profileId: 'google' }, candidates))
    .toMatchObject({ provider: 'google', billing_mode: 'external' });
  for (const profileId of ['missing', 'text-only']) {
    expect(buildImageProductionQuoteSegment({ requestId: 'selected', profileId, referenceCount: 1 }, candidates))
      .toMatchObject({ provider: '', billing_mode: 'unavailable' });
  }
  expect(candidates.map(row => row.entry.entryId)).toEqual(['openai', 'google', 'text-only']);
});

it('refuses an unsupported Seedream size before quoting its selected provider', () => {
  const row = { entry: { provider: 'doubao', entryId: 'seedream' },
    capability: { api: 'doubao', model: 'doubao-seedream-5-0-flash-260915', supportsEdit: true } } as any;
  expect(() => buildImageProductionQuoteSegment({ requestId: 'size', profileId: 'seedream', size: '4k' }, [row]))
    .toThrow('Unsupported image size');
  expect(buildImageProductionQuoteSegment({ requestId: 'size', profileId: 'seedream', size: '2k' }, [row]))
    .toMatchObject({ provider: 'doubao', billing_mode: 'external', size: '2k' });
});
