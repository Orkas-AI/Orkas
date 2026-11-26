/** Verified native API tiers. Saved legacy identities are separate from the picker. */
export interface VideoModelSpec {
  id: string;
  name: string;
  minDuration: number;
  maxDuration: number;
  resolutions: readonly string[];
  ratios: readonly string[];
  images: number;
  videos: number;
  silent: boolean;
  autoDuration?: boolean;
  /** Frames the model's own API takes: none, a first frame, or a first and a last. */
  frames: VideoFrames;
  /** The API takes frames beside reference images and videos. */
  framesWithReferences?: boolean;
  /** Given a first frame, the video takes that frame's aspect ratio and no other can be asked for. */
  framesFixRatio?: boolean;
}

export type VideoFrames = 'none' | 'first' | 'first_last';

const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
// Frames as each API documents them (checked 2026-11-10): Seedance, H3 and Wan take frames in place
// of references, Kling 4.0 beside them; Flash and Runway take a first frame only.
const seedance = { minDuration: 4, maxDuration: 15, resolutions: ['480p', '720p', '1080p'], ratios, images: 9, videos: 3, silent: true, frames: 'first_last' as const };
const h3 = { minDuration: 4, maxDuration: 15, resolutions: ['480p', '768p'], ratios, images: 9, videos: 3, silent: false, frames: 'first_last' as const, framesFixRatio: true };
const kling = { minDuration: 3, maxDuration: 30, resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16', '1:1', '21:9', 'adaptive'], images: 10, videos: 5, silent: false, frames: 'first_last' as const, framesWithReferences: true };
/** The only lengths Veo 3.1 makes, in seconds. */
export const VEO_DURATIONS: readonly number[] = [4, 6, 8];
const veo = { minDuration: 4, maxDuration: 8, resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'], images: 1, videos: 0, silent: true, frames: 'first_last' as const };
const wan = { minDuration: 2, maxDuration: 30, resolutions: ['480p', '720p', '1080p'], ratios, images: 10, videos: 5, silent: true, autoDuration: true, frames: 'first_last' as const };

export const VIDEO_MODEL_SPECS: Readonly<Record<string, readonly VideoModelSpec[]>> = {
  doubao: [
    { ...seedance, id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', maxDuration: 30, images: 30, videos: 10, autoDuration: true, framesFixRatio: true },
    { ...seedance, id: 'doubao-seedance-2-5-flash', name: 'Seedance 2.5 Flash', maxDuration: 30, resolutions: ['480p', '720p'], images: 10, videos: 5, autoDuration: true, framesFixRatio: true },
    { ...seedance, id: 'doubao-seedance-2-0-260128', name: 'Doubao Seedance 2.0' },
    { ...seedance, id: 'doubao-seedance-2-0-fast-260128', name: 'Doubao Seedance 2.0 Fast', resolutions: ['480p', '720p'] },
    { ...seedance, id: 'doubao-seedance-2-0-mini', name: 'Doubao Seedance 2.0 Mini', resolutions: ['480p', '720p'] },
  ],
  minimax: [
    { ...h3, id: 'MiniMax-H3', name: 'MiniMax H3', resolutions: ['768p', '2k'] },
    { ...h3, id: 'MiniMax-H3-Highspeed', name: 'MiniMax H3 Highspeed' },
    // Lite makes the ratio it is asked for, first frame or not: on 2026-11-10 one 480x864 first
    // frame made 864x480 at 16:9 and 480x864 at 9:16.
    { ...h3, id: 'MiniMax-H3-Lite', name: 'MiniMax H3 Lite', ratios: ratios.filter(r => r !== 'adaptive'), framesFixRatio: false },
    { ...h3, id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', minDuration: 5 },
  ],
  vidu: ['pro', 'turbo'].map(tier => ({ id: `viduq3-${tier}`, name: `Vidu Q3 ${tier === 'pro' ? 'Pro' : 'Turbo'}`, minDuration: 1, maxDuration: 16, resolutions: ['540p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], images: 1, videos: 0, silent: true, frames: 'first_last' as const, framesFixRatio: true })),
  kling: [
    { ...kling, id: 'kling-v4-0', name: 'Kling 4.0' },
    { ...kling, id: 'kling-v4-0-flash', name: 'Kling 4.0 Flash', maxDuration: 20, resolutions: ['720p'], frames: 'first' },
  ],
  // Omni has no frame setting: it reads image roles from the prompt.
  google: [{ id: 'gemini-omni-1.1-flash', name: 'Gemini Omni 1.1 Flash', minDuration: 3, maxDuration: 10, resolutions: ['360p', '720p', '1080p', '4k'], ratios: ['16:9', '9:16'], images: 9, videos: 1, silent: false, frames: 'none' }],
  'google-cloud': [
    { ...veo, id: 'veo-3.1-generate-001', name: 'Google Cloud Veo 3.1', resolutions: ['720p', '1080p', '4k'] },
    { ...veo, id: 'veo-3.1-fast-generate-001', name: 'Google Cloud Veo 3.1 Fast' },
    { ...veo, id: 'veo-3.1-lite-generate-001', name: 'Google Cloud Veo 3.1 Lite', images: 0, frames: 'none' },
  ],
  runway: [{ id: 'gen4.5', name: 'Runway Gen-4.5', minDuration: 2, maxDuration: 10, resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], images: 1, videos: 0, silent: true, frames: 'first' }],
  aliyun: [
    { ...wan, id: 'wan3.0-video', name: 'Wan 3.0' },
    { ...wan, id: 'wan3.0-video-prime', name: 'Wan 3.0 Prime' },
  ],
};

export const LEGACY_VIDEO_MODELS: Readonly<Record<string, readonly string[]>> = {
  minimax: ['MiniMax-Hailuo-2.3'], kling: ['kling-v3-0-turbo'],
  google: ['veo-3.1-generate-preview'], doubao: ['doubao-seedance-2-0-mini-260615'],
};

export function videoModelSpec(provider: string, model: string): VideoModelSpec | undefined {
  return VIDEO_MODEL_SPECS[provider]?.find(spec => spec.id === model);
}

export function isSeedance25Model(model: string | undefined): boolean {
  return model === 'doubao-seedance-2-5-260628' || model === 'doubao-seedance-2-5-flash';
}

export type VideoFrameSupport = { name: string; frames: VideoFrames; withReferences: boolean; fixRatio: boolean };

/** Frames accepted by configured services, including models saved before the current list. */
export function videoFrameSupport(provider: string, model: string): VideoFrameSupport {
  const spec = videoModelSpec(provider, model);
  if (spec) return { name: spec.name, frames: spec.frames, withReferences: spec.framesWithReferences === true, fixRatio: spec.framesFixRatio === true };
  if (provider === 'doubao' && model.startsWith('doubao-seedance-2-0')) return { name: 'Doubao Seedance 2.0 Mini', frames: 'first_last', withReferences: false, fixRatio: false };
  if (provider === 'minimax' && model === 'MiniMax-Hailuo-2.3') return { name: 'MiniMax Hailuo 2.3', frames: 'first', withReferences: false, fixRatio: false };
  if (provider === 'kling' && model === 'kling-v3-0-turbo') return { name: 'Kling 3.0 Turbo', frames: 'first', withReferences: false, fixRatio: true };
  return { name: model, frames: 'none', withReferences: false, fixRatio: false };
}

export function isRetiredVideoModel(provider: string, model: string): boolean {
  return provider === 'google' && model === 'veo-3.1-generate-preview';
}

export const WAN_REGIONS = ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1', 'cn-hongkong'] as const;
