import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: [] as any[],
}));

vi.mock('../../../src/main/features/image_gen', () => ({
  listOpenImageGenCandidates: () => h.candidates,
}));

import {
  buildImageProductionQuoteSegment,
  estimateImageProductionCredits,
  imageProductionQuotePayloadSegments,
} from '../../../src/main/features/image_production_credits';

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
    const quote = await estimateImageProductionCredits({
      requestId: 'private-edit',
      size: '2048x2048',
      referenceCount: 2,
    });
    expect(quote).toMatchObject({
      in_app_credits_required_milli: 0,
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
