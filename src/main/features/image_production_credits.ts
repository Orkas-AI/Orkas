import {
  listOpenImageGenCandidates,
  type PickedImageGenProfile,
} from './image_gen';

export type ImageProductionBillingMode = 'external' | 'unavailable';

export type ImageProductionCreditIntent = {
  requestId: string;
  size?: string;
  referenceCount?: number;
};

export type ImageProductionQuoteSegment = {
  segment_id: string;
  kind: 'image';
  billing_mode: ImageProductionBillingMode;
  provider: string;
  size?: string;
  reference_images?: string[];
};

export type ImageProductionCreditQuote = {
  in_app_credits_required_milli: 0;
  sufficient: boolean;
  external_billing_estimate_available: false;
  externally_billed_segment_ids: string[];
  unavailable_segment_ids: string[];
  segments: ImageProductionQuoteSegment[];
};

function capableCandidates(
  referenceCount: number,
  candidates: PickedImageGenProfile[],
): PickedImageGenProfile[] {
  return referenceCount > 0
    ? candidates.filter((candidate) => candidate.capability.supportsEdit)
    : candidates;
}

export function buildImageProductionQuoteSegment(
  intent: ImageProductionCreditIntent,
  candidates = listOpenImageGenCandidates(),
): ImageProductionQuoteSegment {
  const referenceCount = Math.max(0, Math.trunc(Number(intent.referenceCount) || 0));
  const first = capableCandidates(referenceCount, candidates)[0];
  const common = {
    segment_id: String(intent.requestId || '').trim(),
    kind: 'image' as const,
    ...(intent.size ? { size: intent.size } : {}),
    ...(referenceCount ? {
      reference_images: Array.from(
        { length: referenceCount },
        (_item, index) => `reference-${index + 1}`,
      ),
    } : {}),
  };
  if (!first) {
    return { ...common, billing_mode: 'unavailable', provider: '' };
  }
  return {
    ...common,
    billing_mode: 'external',
    provider: first.entry.provider,
  };
}

export function imageProductionQuotePayloadSegments(
  intent: ImageProductionCreditIntent,
  candidates = listOpenImageGenCandidates(),
): ImageProductionQuoteSegment[] {
  return [buildImageProductionQuoteSegment(intent, candidates)];
}

/**
 * Open builds have no Orkas billing account. This local quote discloses
 * whether a configured BYO/local provider can handle the request while
 * leaving provider-side price estimation to that provider.
 */
export async function estimateImageProductionCredits(
  intent: ImageProductionCreditIntent,
  signal?: AbortSignal,
): Promise<ImageProductionCreditQuote> {
  if (signal?.aborted) throw new Error('E_IMAGE_PRODUCTION_QUOTE_ABORTED: request aborted');
  const requestId = String(intent.requestId || '').trim();
  if (!requestId) throw new Error('E_IMAGE_PRODUCTION_QUOTE_REQUEST_REQUIRED: requestId is required');
  const segments = imageProductionQuotePayloadSegments({ ...intent, requestId });
  const externalIds = segments
    .filter((segment) => segment.billing_mode === 'external')
    .map((segment) => segment.segment_id);
  const unavailableIds = segments
    .filter((segment) => segment.billing_mode === 'unavailable')
    .map((segment) => segment.segment_id);
  return {
    in_app_credits_required_milli: 0,
    sufficient: unavailableIds.length === 0,
    external_billing_estimate_available: false,
    externally_billed_segment_ids: externalIds,
    unavailable_segment_ids: unavailableIds,
    segments,
  };
}
