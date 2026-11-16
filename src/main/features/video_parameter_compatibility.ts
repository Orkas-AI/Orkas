/** Native request settings are distinct from the desired, locally finished output.
 * Pure and shared by production quotation and every generation entry point. */
import { isSeedance25Model, videoModelSpec, type VideoModelSpec } from './video_models';

export interface VideoParameterInput {
  duration?: number;
  resolution?: string;
  ratio?: string;
  generateAudio?: boolean;
  seed?: number;
  operation?: 'generate' | 'edit';
  firstFrameUrl?: string;
  firstFramePath?: string;
  lastFrameUrl?: string;
  lastFramePath?: string;
  referenceImageUrls?: string[];
  referenceImagePaths?: string[];
  referenceVideoUrls?: string[];
  referenceVideoPaths?: string[];
}

export function videoParameterModel(provider: string, model: string): { provider: string; spec: VideoModelSpec } | undefined {
  const spec = videoModelSpec(provider, model);
  return spec ? { provider, spec } : undefined;
}

export const VIDEO_RESOLUTION_HEIGHTS: Readonly<Record<string, number>> = {
  '360p': 360, '480p': 480, '540p': 540, '720p': 720, '768p': 768,
  '1080p': 1080, '2k': 1440, '4k': 2160,
};

function numericRatio(value: string): number {
  const [width, height] = value.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

/** Adjust only representable controls, never discard media or rewrite its meaning.
 * Above-maximum duration remains an explicit request for multiple shots; clamping
 * it would silently lose requested action. Invalid credentials/references remain
 * the existing validator's responsibility, before upload or paid submission. */
export function fitVideoParameters<T extends VideoParameterInput>(wanted: T, provider: string, model: string): T {
  const known = videoParameterModel(provider, model);
  const actual = { ...wanted };
  if (!known) return actual;
  const { spec, provider: nativeProvider } = known;
  const framed = !!(wanted.firstFrameUrl || wanted.firstFramePath);
  const images = (wanted.referenceImageUrls?.length || 0) + (wanted.referenceImagePaths?.length || 0);
  const videos = (wanted.referenceVideoUrls?.length || 0) + (wanted.referenceVideoPaths?.length || 0);

  if (typeof wanted.duration === 'number' && Number.isFinite(wanted.duration)) {
    if (nativeProvider === 'google' && wanted.duration <= spec.maxDuration) delete actual.duration;
    else if (wanted.duration === -1 && !spec.autoDuration) actual.duration = Math.max(spec.minDuration, 5);
    else if (wanted.duration > 0 && wanted.duration <= spec.maxDuration) {
      actual.duration = Math.max(spec.minDuration, Math.ceil(wanted.duration));
      if (nativeProvider === 'google-cloud') actual.duration = [4, 6, 8].find(value => value >= actual.duration!) ?? 8;
    }
  }

  if (wanted.resolution !== undefined) {
    const desired = wanted.resolution.toLowerCase();
    const height = VIDEO_RESOLUTION_HEIGHTS[desired];
    if (spec.resolutions.includes(desired)) actual.resolution = desired;
    else if (height) {
      const ordered = [...spec.resolutions].sort((a, b) => VIDEO_RESOLUTION_HEIGHTS[a] - VIDEO_RESOLUTION_HEIGHTS[b]);
      actual.resolution = ordered.find(value => VIDEO_RESOLUTION_HEIGHTS[value] >= height) ?? ordered[ordered.length - 1];
    }
  }
  // High resolution can extend an otherwise admissible short shot, but cannot
  // turn an invalid or overlong request into a shorter paid generation.
  if (nativeProvider === 'google-cloud' && ['1080p', '4k'].includes(actual.resolution || '')
    && (actual.duration === undefined || (typeof actual.duration === 'number'
      && actual.duration > 0 && actual.duration <= spec.maxDuration))) actual.duration = 8;

  if (framed && spec.framesFixRatio) actual.ratio = 'adaptive';
  else if (wanted.ratio !== undefined) {
    let offered = spec.ratios;
    if (nativeProvider === 'runway' && !framed && !images) offered = ['16:9', '9:16'];
    if (!framed && !images && !videos && ['minimax', 'kling'].includes(nativeProvider)) offered = offered.filter(value => value !== 'adaptive');
    if (!offered.includes(wanted.ratio)) {
      const fixed = offered.filter(value => value !== 'adaptive');
      const shape = numericRatio(wanted.ratio);
      actual.ratio = fixed.reduce((best, value) => Math.abs(Math.log(numericRatio(value) / shape)) < Math.abs(Math.log(numericRatio(best) / shape)) ? value : best, fixed[0]);
    }
  }
  if (nativeProvider === 'doubao' && isSeedance25Model(model) && wanted.operation === 'edit') {
    actual.duration = -1;
    actual.ratio = 'adaptive';
  }
  if (wanted.generateAudio === false && !spec.silent) actual.generateAudio = true;
  if (['minimax', 'kling', 'google'].includes(nativeProvider)) delete actual.seed;
  return actual;
}
