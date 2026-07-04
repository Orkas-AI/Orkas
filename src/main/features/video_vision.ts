/**
 * video_vision — provider-agnostic visual reading for the video pipeline
 * (ingest "据观察不据假设" frame reads + QA visual spot-checks). The seam is a
 * single `analyzeFrames(frames, question) -> text` so callers never bake in a
 * specific model/provider.
 *
 * Routing (the user's contract: prefer the agent's own model; only reach for a
 * separate VLM if it cannot see):
 *  1. AGENT MODEL FIRST. The video-studio agent runs on the user's configured
 *     model. If that model is multimodal, the agent reads frames directly via
 *     `read_file` (images are forwarded as multimodal) — no call here needed.
 *     When native code needs a frame read (the QA pass runs outside the agent
 *     turn), `analyzeFrames` calls `chatWithModel`, which forwards images to the
 *     same configured model.
 *  2. SEPARATE VLM (G11b, not yet wired). If the configured model is NOT
 *     multimodal, a BYO vision profile (mirroring tts/image profiles) would be
 *     used instead. That provider-config surface does not exist yet, so
 *     `resolveVisionRoute` returns only 'agent-model' today; the seam is here so
 *     adding it later needs no caller changes.
 *  3. DEGRADE. If no model can see the frames (non-multimodal model, no VLM
 *     profile, or the call fails), `analyzeFrames` returns ok:false with a
 *     reason. Callers must degrade — mark the read as unverified and proceed on
 *     probe / transcript / OCR evidence — never crash and never silently
 *     pretend the frames were seen.
 *
 * Cost note: frames are downscaled to a long edge of 1024px before sending, so
 * each frame is ~0.8K image tokens; QA spot-checks send ~4 frames per pass.
 */

import * as fs from 'node:fs/promises';

import { chatWithModel } from '../model/client';
import { toCompressedGrayJpeg } from '../util/image-transform';
import { createLogger } from '../logger';

const log = createLogger('video-vision');

/** Long edge (px) frames are downscaled to before sending. Keeps on-screen text
 *  legible while holding each frame to ~0.8K image tokens. */
const FRAME_MAX_DIM = 1024;
const FRAME_JPEG_QUALITY = 72;
/** Default cap on frames per call — visual QA spot-checks 4; ingest reads a
 *  handful. Hard cap guards cost if a caller passes a whole frame dump. */
const DEFAULT_MAX_FRAMES = 8;
const HARD_MAX_FRAMES = 16;
/** Outer wall-clock cap for one frame-read call. Vision is a single short turn;
 *  this only catches a provider that started then went silent. */
const VISION_TIMEOUT_MS = 3 * 60 * 1000;

/** A model that genuinely cannot see the images is asked to reply with exactly
 *  this token, so a non-multimodal model describing nothing is caught instead of
 *  its hallucination being trusted. */
export const NO_VISION_SENTINEL = 'NO_VISION';

export type VisionRoute = 'agent-model' | 'vlm-profile';

export interface LoadedImage {
  data: string;
  mediaType: 'image/jpeg';
}

export interface AnalyzeFramesParams {
  userId: string;
  /** Absolute paths to already-extracted image frames, in display order. */
  framePaths: string[];
  /** What to assess ("Is the product right-side up? Any garbled caption text?"). */
  question: string;
  agentId?: string;
  sessionId?: string;
  maxFrames?: number;
  signal?: AbortSignal;
  /** Test seam: injected model call. Defaults to the real chatWithModel. */
  chat?: typeof chatWithModel;
  /** Test seam: injected frame loader. Defaults to decode+downscale via jimp. */
  loadFrames?: (paths: string[]) => Promise<LoadedImage[]>;
}

export type AnalyzeFramesResult =
  | { ok: true; route: VisionRoute; text: string; framesUsed: number }
  | { ok: false; reason: 'no-frames' | 'no-vision' | 'aborted' | 'error'; message: string };

/**
 * Which vision provider to use. Today only the agent/configured model is wired,
 * so this always returns 'agent-model'. When a BYO vision profile lands (G11b),
 * return 'vlm-profile' when the configured model is not multimodal.
 */
export function resolveVisionRoute(_userId: string): VisionRoute {
  return 'agent-model';
}

/** Cap + de-dupe frame paths deterministically (order preserved). Pure. */
export function selectFrames(framePaths: string[], maxFrames = DEFAULT_MAX_FRAMES): string[] {
  const cap = Math.max(1, Math.min(maxFrames, HARD_MAX_FRAMES));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of framePaths) {
    const s = String(p || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Map a raw model response into an AnalyzeFramesResult. Pure — the degrade
 * policy lives here so it is unit-testable: an aborted call, a failed call, an
 * empty answer, or the NO_VISION sentinel all become a typed `ok:false` the
 * caller degrades on, rather than trusting a model that cannot actually see.
 */
export function interpretVisionResponse(
  res: { ok: boolean; text: string; error: string; aborted: boolean },
  framesUsed: number,
  route: VisionRoute,
): AnalyzeFramesResult {
  if (res.aborted) return { ok: false, reason: 'aborted', message: res.error || 'vision call aborted' };
  if (!res.ok) return { ok: false, reason: 'error', message: res.error || 'vision call failed' };
  const text = (res.text || '').trim();
  if (!text) return { ok: false, reason: 'no-vision', message: 'empty vision response' };
  // The model declared it cannot see the frames (or the whole answer is the
  // sentinel) — treat as no usable vision, do not trust a blind description.
  const upper = text.toUpperCase();
  if (upper === NO_VISION_SENTINEL || upper.startsWith(`${NO_VISION_SENTINEL}\n`) || upper.startsWith(`${NO_VISION_SENTINEL}.`) || upper.startsWith(`${NO_VISION_SENTINEL} `)) {
    return { ok: false, reason: 'no-vision', message: 'model reported it cannot see the frames' };
  }
  return { ok: true, route, text, framesUsed };
}

function buildVisionMessage(question: string, frameCount: number): string {
  return (
    `You are given ${frameCount} video frame${frameCount === 1 ? '' : 's'} in order. ` +
    `Answer this concisely and factually, describing only what is actually visible:\n\n${question.trim()}\n\n` +
    `If you genuinely cannot see the images, reply with exactly ${NO_VISION_SENTINEL} and nothing else.`
  );
}

async function loadFrame(p: string): Promise<LoadedImage | null> {
  try {
    const raw = await fs.readFile(p);
    const compressed = await toCompressedGrayJpeg(raw, { maxDim: FRAME_MAX_DIM, quality: FRAME_JPEG_QUALITY, grayscale: false });
    return { data: compressed.buf.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    log.warn(`load frame ${p}: ${(err as Error).message}`);
    return null;
  }
}

/** Decode + downscale frames to JPEG base64, dropping any that fail to load. */
async function defaultLoadFrames(paths: string[]): Promise<LoadedImage[]> {
  const loaded = await Promise.all(paths.map(loadFrame));
  return loaded.filter((x): x is LoadedImage => x !== null);
}

/**
 * Read a set of frames with a vision-capable model and return a textual answer.
 * Provider-agnostic: routes per `resolveVisionRoute`, and degrades to a typed
 * `ok:false` (never throws on a missing-vision condition) so ingest/QA can mark
 * the read unverified and continue.
 */
export async function analyzeFrames(params: AnalyzeFramesParams): Promise<AnalyzeFramesResult> {
  const frames = selectFrames(params.framePaths || [], params.maxFrames ?? DEFAULT_MAX_FRAMES);
  if (frames.length === 0) {
    return { ok: false, reason: 'no-frames', message: 'no frame paths supplied' };
  }
  const route = resolveVisionRoute(params.userId);

  const loader = params.loadFrames ?? defaultLoadFrames;
  const loaded = await loader(frames);
  if (loaded.length === 0) {
    return { ok: false, reason: 'no-frames', message: 'all frames failed to load' };
  }

  const chat = params.chat ?? chatWithModel;
  const controller = new AbortController();
  if (params.signal) {
    if (params.signal.aborted) controller.abort();
    else params.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<{ ok: boolean; text: string; error: string; aborted: boolean }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, text: '', error: `vision timeout after ${Math.round(VISION_TIMEOUT_MS / 1000)}s`, aborted: true });
    }, VISION_TIMEOUT_MS);
  });

  const call = Promise.resolve(
    chat({
      userId: params.userId,
      message: buildVisionMessage(params.question, loaded.length),
      images: loaded,
      skillList: [],
      idleTimeout: Math.ceil(VISION_TIMEOUT_MS / 1000),
      abortSignal: controller.signal,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    }),
  ).catch((err) => ({ ok: false, text: '', error: (err as Error).message || String(err), aborted: false }));

  const res = await Promise.race([call, timeout]);
  if (timer) clearTimeout(timer);

  const out = interpretVisionResponse(res, loaded.length, route);
  if (out.ok === false && out.reason !== 'aborted') {
    log.warn(`analyzeFrames degraded (${out.reason}): ${out.message}`);
  }
  return out;
}
