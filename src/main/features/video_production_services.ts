/** Local configured-service preflight. User-owned services set their own charges. */
import { listOpenImageGenCandidates } from './image_gen';
import { buildImageProductionQuoteSegment } from './image_production_services';
import { listVideoGenCandidates, videoGenCandidatesForCall, videoGenerationInputError } from './video_gen';
import { fitVideoParameters } from './video_parameter_compatibility';
import { videoModelSpec } from './video_models';
import { VideoProductionQuoteError } from './video_production_quote_error';
import { throwIfAborted } from '../util/abort';

export type VideoProductionGenerationKind = 'image' | 'video';
export type VideoProductionGenerationIntent = {
  segment_id: string; kind: VideoProductionGenerationKind; prompt: string; ratio?: string; duration?: number; resolution?: string; quality?: string; generate_audio?: boolean; size?: string;
  operation?: 'generate' | 'edit'; reference_images?: string[]; reference_image_urls?: string[]; reference_image_paths?: string[]; reference_video_urls?: string[]; reference_video_paths?: string[];
  first_frame_path?: string; first_frame_url?: string; last_frame_path?: string; last_frame_url?: string;
};
export type VideoProductionQuoteSegment = VideoProductionGenerationIntent & { billing_mode: 'external' | 'unavailable'; provider: string };
export type VideoProductionServiceAvailability = {
  sufficient: boolean; external_billing_estimate_available: false;
  externally_billed_segment_ids: string[]; unavailable_segment_ids: string[]; segments: Array<Record<string, unknown>>;
};
export type VideoParameterProblem = { reason: string; silentOnly: boolean; model: string };
function parametersInvalid(problem: VideoParameterProblem): Error {
  return Object.assign(new VideoProductionQuoteError('E_VIDEO_PRODUCTION_VIDEO_PARAMETERS_INVALID', problem.reason), { videoParameters: problem });
}
/** Follow the same configured candidates and native controls as actual dispatch. */
export function buildVideoProductionQuoteSegments(intents: VideoProductionGenerationIntent[], imageCandidates = listOpenImageGenCandidates(), videoCandidates = listVideoGenCandidates()): VideoProductionQuoteSegment[] {
  return intents.map(intent => {
    if (intent.kind === 'image') {
      const count = (intent.reference_images?.length || 0) + (intent.reference_image_urls?.length || 0) + (intent.reference_image_paths?.length || 0);
      const quote = buildImageProductionQuoteSegment({ requestId: intent.segment_id, referenceCount: count, ...(intent.size ? { size: intent.size } : {}) }, imageCandidates);
      return { ...intent, billing_mode: quote.billing_mode, provider: quote.provider };
    }
    const first = videoCandidates[0]; if (!first) return { ...intent, billing_mode: 'unavailable', provider: '' };
    const request = fitVideoParameters({      
prompt: intent.prompt, outputAbsPath: '', duration: intent.duration, ratio: intent.ratio, resolution: intent.resolution, operation: intent.operation, generateAudio: intent.generate_audio,
      referenceImageUrls: intent.reference_image_urls, referenceImagePaths: intent.reference_image_paths, referenceVideoUrls: intent.reference_video_urls, referenceVideoPaths: intent.reference_video_paths,
      firstFramePath: intent.first_frame_path, firstFrameUrl: intent.first_frame_url, lastFramePath: intent.last_frame_path, lastFrameUrl: intent.last_frame_url    
}, first.entry.provider, first.entry.model);
    const invalid = videoGenerationInputError(request, first.entry);
    if (invalid) {
      if (videoGenerationInputError({ prompt: '', outputAbsPath: '' }, first.entry)) throw new VideoProductionQuoteError('E_VIDEO_PRODUCTION_VIDEO_PARAMETERS_INVALID', invalid);
      throw parametersInvalid({ reason: invalid, silentOnly: intent.generate_audio === false && !videoGenerationInputError({ ...request, generateAudio: true }, first.entry), model: videoModelSpec(first.entry.provider, first.entry.model)?.name || first.entry.model });
    }
    return { ...intent, duration: request.duration, resolution: request.resolution, ratio: request.ratio, generate_audio: request.generateAudio, billing_mode: 'external', provider: first.entry.provider };
  });
}
/** Availability facts need counts and settings, never prompts or reference identities. */
export function videoProductionQuotePayloadSegments(intents: VideoProductionGenerationIntent[], imageCandidates = listOpenImageGenCandidates(), videoCandidates = listVideoGenCandidates()): Array<Record<string, unknown>> {
  return buildVideoProductionQuoteSegments(intents, imageCandidates, videoCandidates).map(segment => {
    const common = { segment_id: segment.segment_id, kind: segment.kind, billing_mode: segment.billing_mode, provider: segment.provider };
    if (segment.kind === 'image') {
      const count = (segment.reference_images?.length || 0) + (segment.reference_image_urls?.length || 0) + (segment.reference_image_paths?.length || 0);
      return { ...common, ...(segment.size ? { size: segment.size } : {}), ...(count ? { reference_images: Array.from({ length: count }, (_, index) => `reference-${index + 1}`) } : {}) };
    }
    return { ...common, ...(segment.operation ? { operation: segment.operation } : {}), ...(segment.ratio ? { ratio: segment.ratio } : {}), ...(typeof segment.duration === 'number' ? { duration: segment.duration } : {}), ...(segment.resolution ? { resolution: segment.resolution } : {}), ...(typeof segment.generate_audio === 'boolean' ? { generate_audio: segment.generate_audio } : {}), ...((segment.reference_video_urls?.length || segment.reference_video_paths?.length) ? { reference_video_urls: ['reference-video-present'] } : {}) };
  });
}
export async function checkVideoProductionServices(intents: VideoProductionGenerationIntent[], signal?: AbortSignal, videoProfileId?: string, imageProfileId?: string): Promise<VideoProductionServiceAvailability> {
  throwIfAborted(signal);
  const videos = videoProfileId ? videoGenCandidatesForCall(videoProfileId) : listVideoGenCandidates();
  if (videoProfileId && !videos.length) throw new VideoProductionQuoteError('E_VIDEO_ROUTE_UNAVAILABLE', 'The chosen video service is no longer configured.');
  const images = listOpenImageGenCandidates().filter(candidate => !imageProfileId || candidate.entry.entryId === imageProfileId);
  const segments = videoProductionQuotePayloadSegments(intents, images, videos);
  const unavailable = segments.filter(item => item.billing_mode === 'unavailable').map(item => String(item.segment_id));
  return { sufficient: unavailable.length === 0, external_billing_estimate_available: false, externally_billed_segment_ids: segments.filter(item => item.billing_mode === 'external').map(item => String(item.segment_id)), unavailable_segment_ids: unavailable, segments };
}
