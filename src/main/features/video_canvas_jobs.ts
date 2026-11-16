/**
 * What the canvas starts and the user waits for: rendering a changed video, making a shot again,
 * and making a new shot drawn from footage (decided 2026-11-10). A video renders only when the user
 * updates it (decided 2026-11-09): a change waits for the Update, and stops one in progress, whose
 * file would no longer match. Finished scenes stay cached, so the next Update renders only what
 * changed.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { registerUserSwitchHook } from './user-switch-hooks';
import { getActiveUserId, hasActiveUser } from './users';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { VIDEO_STUDIO_AGENT_ID } from '../model/core-agent/tool-catalog';
import { finalizeProducedFile } from './produced_output_hooks';
import type { VideoProfile } from './auth';
import { listOpenImageGenCandidates } from './image_gen';
import { imageSizeForAspect } from './image_size';
import {
  applyVideoCanvasEdit,
  locateProduction,
  pictureShape,
  readProductionLedger,
  readVideoCanvasDraft,
  settleVideoCanvasDraft,
  videoDirIn,
  videoUpToDate,
  type VideoCanvasDraftMethod,
  type VideoCanvasDraftSource,
  type VideoCanvasRefusal,
  type VideoCanvasTakeParams,
  VIDEO_RESOLUTIONS,
} from './video_canvas';
import { effectiveVideoSettings, listVideoGenCandidates, videoGenerationInputError, type GenerateVideoInput } from './video_gen';
import { videoFrameSupport, videoModelSpec, type VideoFrames } from './video_models';
import { hasPendingProductionRequest } from './video_production_budget';
import { isExternallyBilled, quoteProductionIntents } from './video_production_spend';
import type { VideoProductionServiceAvailability, VideoProductionGenerationIntent } from './video_production_services';
import { renderVideoTimeline, type VideoProgress } from './video_timeline_render';
import { shipVideoFile, type ShipIssue, type VideoVersion } from './video_timeline_ship';
import type { VideoAssetRecord } from './video_timeline';

const log = createLogger('video-canvas-jobs');

const PROGRESS_EMIT_INTERVAL_MS = 300;

export type VideoCanvasJobContext = {
  uid: string;
  cid: string;
  dir: string;
  projectId?: string;
  conversationTitle?: string;
};

export type VideoCanvasJobPhase = 'queue' | 'render' | 'deliver' | 'generate';

/** What the user changed for a new take: its words, its service, both or neither. */
export type VideoCanvasRedoChanges = 'none' | 'prompt' | 'model' | 'both';

export type VideoCanvasJobState = {
  dir: string;
  /** The video a render is for. */
  video_id?: string;
  /** `new_shot`: a new shot drawn from footage on the canvas (2026-11-10). */
  kind: 'render' | 'redo' | 'new_shot';
  status: 'running' | 'failed';
  /** The shot card a new take is being made for, or the new shot's draft card. */
  shot?: string;
  phase?: VideoCanvasJobPhase;
  /** 0 to 1, when it can be known. */
  progress?: number;
  code?: string;
  changes?: VideoCanvasRedoChanges;
  /** Footage the user added to the call in the panel; all of a new shot's footage. */
  added_refs?: number;
};

export type VideoCanvasJobEvent = Omit<VideoCanvasJobState, 'status'> & {
  userId: string;
  cid: string;
  /** `stopped`: a change made the render pointless, and the video waits for the next Update. */
  status: 'running' | 'failed' | 'done' | 'stopped';
  /** The version a finished render delivered. */
  version?: string;
  /** A finished take, and whether the videos that showed its shot now show it. */
  asset_id?: string;
  swapped?: boolean;
  /** The user's own service made the shot, so the charge is on their account. */
  own_key?: boolean;
};

let jobListener: ((event: VideoCanvasJobEvent) => void) | null = null;
export function onVideoCanvasJob(next: typeof jobListener): void { jobListener = next; }

type RenderJob = {
  ctx: VideoCanvasJobContext;
  video: string;
  state: VideoCanvasJobState;
  timer?: NodeJS.Timeout;
  controller?: AbortController;
  running: boolean;
  /** The user updated again during this render. */
  again: boolean;
  cancelled: boolean;
  /** A change came after this Update, so what it renders is no longer the video. */
  stopped: boolean;
};

type RedoJob = { ctx: VideoCanvasJobContext; state: VideoCanvasJobState; controller: AbortController };

const renders = new Map<string, RenderJob>();
const redos = new Map<string, RedoJob>();

registerUserSwitchHook('video-canvas-jobs', (previousUid) => {
  for (const [key, job] of renders) {
    if (job.ctx.uid !== previousUid) continue;
    job.cancelled = true;
    job.again = false;
    if (job.timer) clearTimeout(job.timer);
    job.controller?.abort();
    renders.delete(key);
  }
  for (const [key, job] of redos) {
    if (job.ctx.uid !== previousUid) continue;
    job.controller.abort();
    redos.delete(key);
  }
});

/** Whether VideoStudio has joined this conversation, which is what gives it a canvas. */
export function conversationUsesVideoStudio(conversation: { agent_id?: string; agent_ids?: string[] } | null): boolean {
  return conversation?.agent_id === VIDEO_STUDIO_AGENT_ID || !!conversation?.agent_ids?.includes(VIDEO_STUDIO_AGENT_ID);
}

function ownsActiveAccount(ctx: VideoCanvasJobContext): boolean {
  return hasActiveUser() && getActiveUserId() === ctx.uid;
}

function jobKey(ctx: VideoCanvasJobContext, ...rest: string[]): string {
  return [ctx.uid, ctx.cid, ctx.dir, ...rest].join('\0');
}

function emit(ctx: VideoCanvasJobContext, state: Omit<VideoCanvasJobState, 'status'> & { status: VideoCanvasJobEvent['status'] }, extra: Partial<VideoCanvasJobEvent> = {}): void {
  try {
    jobListener?.({ ...state, ...extra, userId: ctx.uid, cid: ctx.cid });
  } catch (err) {
    log.warn('job event not delivered', { error: logErrorSummary(err) });
  }
}

function fail(job: RenderJob | RedoJob, code: string): void {
  job.state = { ...job.state, status: 'failed', code };
  delete job.state.phase;
  delete job.state.progress;
  emit(job.ctx, job.state);
}

/** The work in progress for a conversation, and what failed. While the Agent works it owns
 *  these videos, so an older failure no longer describes them. */
export function videoCanvasJobs(uid: string, cid: string, options: { busy: boolean }): VideoCanvasJobState[] {
  const inConversation = <T extends RenderJob | RedoJob>(jobs: Map<string, T>): T[] => (
    [...jobs.entries()].flatMap(([key, job]) => {
      if (job.ctx.uid !== uid || job.ctx.cid !== cid) return [];
      // Still letting go of a render nobody waits for.
      if ('stopped' in job && job.stopped) return [];
      if (job.state.status === 'failed' && options.busy) {
        jobs.delete(key);
        return [];
      }
      return [job];
    })
  );
  return [...inConversation(renders), ...inConversation(redos)].map((job) => job.state);
}

/** Render a video for the user's Update. Another Update while it renders starts it over, once
 *  the one in progress has let go. */
export function scheduleVideoCanvasRender(ctx: VideoCanvasJobContext, video: string, options: { delayMs?: number } = {}): void {
  if (!ownsActiveAccount(ctx)) return;
  const key = jobKey(ctx, video);
  const job: RenderJob = renders.get(key) ?? {
    ctx,
    video,
    state: { dir: ctx.dir, video_id: video, kind: 'render', status: 'running' },
    running: false,
    again: false,
    cancelled: false,
    stopped: false,
  };
  renders.set(key, job);
  job.ctx = ctx;
  job.stopped = false;
  job.state = { dir: ctx.dir, video_id: video, kind: 'render', status: 'running', phase: 'queue' };
  emit(ctx, job.state);
  if (job.timer) clearTimeout(job.timer);
  job.controller?.abort();
  job.timer = setTimeout(() => {
    job.timer = undefined;
    if (job.running) {
      job.again = true;
      return;
    }
    void runRenderJob(key, job);
  }, options.delayMs ?? 0);
}

/**
 * The user's Update (decided 2026-11-11): a video whose timeline has not changed since its last
 * version renders nothing; any other one renders as before. Product facts changed since its
 * delivery go to the Agent from the canvas before this is asked.
 */
export async function updateVideoCanvasVideo(ctx: VideoCanvasJobContext, video: string): Promise<{ ok: true; unchanged?: true } | VideoCanvasRefusal> {
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const located = await locateProduction(ctx.uid, ctx.cid, ctx.dir);
  if (!located || !videoDirIn(located.productionAbs, video) || !ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const unchanged = await videoUpToDate(located.productionAbs, video);
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (unchanged) return { ok: true, unchanged: true };
  scheduleVideoCanvasRender(ctx, video, { delayMs: 0 });
  return { ok: true };
}

/** The video changed, so a render for it renders what it no longer is. Stop it, and let go of a
 *  failure the change may have fixed: the card offers the Update again. */
export function stopVideoCanvasRender(ctx: VideoCanvasJobContext, video: string): void {
  const key = jobKey(ctx, video);
  const job = renders.get(key);
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  job.timer = undefined;
  job.again = false;
  job.stopped = true;
  job.controller?.abort();
  // A render still letting go keeps its place, so a new Update waits for it to finish.
  if (!job.running) renders.delete(key);
  emit(job.ctx, { dir: job.ctx.dir, video_id: video, kind: 'render', status: 'stopped' });
}

async function runRenderJob(key: string, job: RenderJob): Promise<void> {
  job.running = true;
  do {
    job.again = false;
    try {
      await renderOnce(job);
    } catch (err) {
      log.warn('canvas render failed', { error: logErrorSummary(err) });
      if (!job.cancelled && !job.stopped && !job.timer && !job.again) fail(job, 'E_CANVAS_RENDER');
    }
  } while (job.again && !job.cancelled);
  job.running = false;
  job.controller = undefined;
  if (renders.get(key) === job && !job.timer && job.state.status !== 'failed') renders.delete(key);
}

/** How far along a render is, from the events it reports. */
function renderProgress(job: RenderJob): VideoProgress {
  let toRender = 0;
  let scenesSeen = 0;
  let scene = '';
  let lastEmit = 0;
  return (event) => {
    if (job.cancelled || job.stopped) return;
    const data = event.data ?? {};
    if (event.phase === 'video.render' && typeof data.segmentsToRender === 'number') {
      toRender = data.segmentsToRender;
    }
    if (event.phase === 'video.render.queue') {
      if (job.state.phase !== 'queue') {
        job.state = { ...job.state, phase: 'queue' };
        emit(job.ctx, job.state);
      }
      return;
    }
    if (event.phase !== 'video.render.capture' || typeof data.frame !== 'number' || typeof data.totalFrames !== 'number') return;
    if (data.sceneId !== scene) {
      scene = String(data.sceneId);
      scenesSeen += 1;
    }
    const progress = toRender ? Math.min(1, (scenesSeen - 1 + data.frame / data.totalFrames) / toRender) : undefined;
    job.state = { ...job.state, phase: 'render', ...(progress === undefined ? {} : { progress }) };
    const now = Date.now();
    if (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS) {
      lastEmit = now;
      emit(job.ctx, job.state);
    }
  };
}

async function renderOnce(job: RenderJob): Promise<void> {
  const { ctx, video } = job;
  const located = await locateProduction(ctx.uid, ctx.cid, ctx.dir);
  if (job.cancelled || job.stopped) return;
  const videoDirAbs = located ? videoDirIn(located.productionAbs, video) : null;
  if (!located || !videoDirAbs) {
    fail(job, 'E_CANVAS_NOT_FOUND');
    return;
  }
  const controller = new AbortController();
  job.controller = controller;
  // A change or another Update came, so this one's outcome means nothing.
  const superseded = () => job.cancelled || job.stopped || controller.signal.aborted || !!job.timer || job.again;
  const { allowedRoots, videoStudioSegmentCachePath } = await import('../model/core-agent/video-studio-tool');
  if (superseded()) return;
  const toolOpts = { userId: ctx.uid, cid: ctx.cid, ...(ctx.projectId ? { projectId: ctx.projectId } : {}) };
  const roots = allowedRoots(toolOpts);
  const outputAbsPath = path.join(located.productionAbs, 'render', `${video}.mp4`);
  job.state = { ...job.state, phase: 'render' };
  emit(ctx, job.state);
  const render = (quality: 'high' | 'standard') => renderVideoTimeline({
    productionDirAbs: located.productionAbs,
    videoDirAbs,
    allowedRoots: roots,
    outputAbsPath,
    segmentCacheDirAbs: videoStudioSegmentCachePath(toolOpts, located.productionAbs),
    quality,
    onProgress: renderProgress(job),
    signal: controller.signal,
  });
  let rendered = await render('high');
  // A long video on a modest machine: the Agent gets the same refusal and renders at standard.
  if (rendered.ok === false && rendered.errorCode === 'E_RENDER_TOO_HEAVY' && !superseded()) rendered = await render('standard');
  if (superseded()) return;
  if (!rendered.ok) {
    const code = String(rendered.errorCode);
    log.warn('canvas render refused', { code });
    fail(job, code);
    return;
  }
  job.state = { ...job.state, phase: 'deliver', progress: 1 };
  emit(ctx, job.state);
  const shipped = await shipVideoFile({
    productionDirAbs: located.productionAbs,
    allowedRoots: roots,
    videoPathAbs: outputAbsPath,
    videoDirAbs,
    finalize: async (fileAbs) => {
      if (superseded()) return;
      await finalizeProducedFile(fileAbs, {
        userId: ctx.uid,
        cid: ctx.cid,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        source: 'video_canvas.ship',
      }).catch((err) => log.warn('canvas delivery finalization failed', { error: logErrorSummary(err) }));
    },
    signal: controller.signal,
  });
  if (superseded()) return;
  if (!shipped.ok) {
    const [issue] = (shipped.issues ?? []) as ShipIssue[];
    const code = issue?.code ?? String(shipped.errorCode);
    log.warn('canvas delivery refused', { code });
    fail(job, code);
    return;
  }
  emit(ctx, { dir: ctx.dir, video_id: video, kind: 'render', status: 'done' }, { version: (shipped.version as VideoVersion).id });
}

type RedoSource = {
  row: VideoAssetRecord & { request: Record<string, unknown> };
  located: { workspaceAbs: string; productionAbs: string };
  ledger: VideoAssetRecord[];
};

async function findRedoSource(ctx: VideoCanvasJobContext, asset: unknown): Promise<RedoSource | VideoCanvasRefusal> {
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const located = await locateProduction(ctx.uid, ctx.cid, ctx.dir);
  if (!located || !ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const ledger = await readProductionLedger(located.productionAbs);
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (!ledger) return { ok: false, code: 'unreadable' };
  const row = ledger.find((item) => item.id === asset);
  if (!row?.request || row.origin !== 'generated' || row.kind === 'audio') return { ok: false, code: 'not_found' };
  return { row: row as RedoSource['row'], located, ledger };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

/** A frame the call named, as a link or a path, as `generate_video` reads it. */
function frameOf(value: unknown): { url?: string; path?: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return {};
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? { url: raw } : { path: raw };
}

/** The call shape used by the same configured-service availability check as its tool. */
function intentOf(kind: VideoAssetRecord['kind'], request: Record<string, unknown>, workspaceAbs: string): VideoProductionGenerationIntent {
  const prompt = String(request.prompt ?? '');
  const local = (value: unknown) => stringsOf(value).map((item) => path.resolve(workspaceAbs, item));
  if (kind === 'image') {
    return {
      segment_id: 'request',
      kind: 'image',
      prompt,
      reference_images: local(request.reference_images),
      reference_image_urls: stringsOf(request.reference_image_urls),
      ...(typeof request.size === 'string' ? { size: request.size } : {}),
    };
  }
  return {
    segment_id: 'request',
    kind: 'video',
    prompt,
    operation: request.operation === 'edit' ? 'edit' : 'generate',
    reference_image_paths: local(request.reference_image_paths),
    reference_image_urls: stringsOf(request.reference_image_urls),
    reference_video_paths: local(request.reference_video_paths),
    reference_video_urls: stringsOf(request.reference_video_urls),
    ...framesIntent(request, workspaceAbs),
    generate_audio: request.generate_audio !== false,
    ...(typeof request.ratio === 'string' ? { ratio: request.ratio } : {}),
    ...(typeof request.duration === 'number' ? { duration: request.duration } : {}),
    ...(typeof request.resolution === 'string' ? { resolution: request.resolution } : {}),
    ...(typeof request.quality === 'string' ? { quality: request.quality } : {}),
  };
}

function framesIntent(request: Record<string, unknown>, workspaceAbs: string): Partial<VideoProductionGenerationIntent> {
  const first = frameOf(request.first_frame);
  const last = frameOf(request.last_frame);
  return {
    ...(first.url ? { first_frame_url: first.url } : {}),
    ...(first.path ? { first_frame_path: path.resolve(workspaceAbs, first.path) } : {}),
    ...(last.url ? { last_frame_url: last.url } : {}),
    ...(last.path ? { last_frame_path: path.resolve(workspaceAbs, last.path) } : {}),
  };
}

/** The generation input limit; refuse longer prompts before dispatch. */
const MAX_PROMPT_CHARS = 20000;
/** What the panel can add to a take, and the most images a still's tool takes (decided 2026-11-10). */
const MAX_ADDED_INPUTS = 30;
const STILL_MAX_IMAGES = 4;

/** Legacy saved models and the public API keep their dispatch envelope. Current native
 *  models use their independently declared capabilities. */
const ENVELOPE_WITHOUT_SPEC = {
  minDuration: 4,
  maxDuration: 15,
  resolutions: ['480p', '720p', '1080p'],
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  images: 9,
  videos: 3,
  silent: true,
  autoDuration: false,
};

const RESOLUTION_LINES: Readonly<Record<string, number>> = {
  '360p': 360, '480p': 480, '540p': 540, '720p': 720, '768p': 768, '1080p': 1080, '2k': 1440, '4k': 2160,
};

/** The resolution a service offers nearest the one asked for; on a tie, the sharper. */
function nearestResolution(asked: string, offered: readonly string[]): string {
  const lines = RESOLUTION_LINES[asked];
  if (offered.includes(asked) || lines === undefined) return asked;
  return offered
    .filter((item) => RESOLUTION_LINES[item] !== undefined)
    .sort((a, b) => Math.abs(RESOLUTION_LINES[a] - lines) - Math.abs(RESOLUTION_LINES[b] - lines) || RESOLUTION_LINES[b] - RESOLUTION_LINES[a])[0] ?? asked;
}

/** Why a service cannot make a take as it was asked for. A length, shape, resolution or sound it
 *  does not make moves to the nearest it does (decided 2026-11-10, plan 27.21). */
export type VideoCanvasUnavailable =
  | { code: 'images' | 'videos'; max: number }
  /** The take opens or ends on frames this service cannot take as asked (2026-11-10), or frames
   *  were asked for with inputs that cannot be them: one or two images. */
  | { code: 'frames' | 'last_frame' | 'frames_with_references' | 'frames_inputs' }
  | { code: 'other' };

export type VideoCanvasRedoChoice = {
  /** The configured service identity sent back for preflight and generation. */
  id: string;
  /** The configured service's model name. */
  name: string;
  /** The frames the service takes, so the panel can say when it takes none. */
  frames: VideoFrames;
  /** What the take asks for on this service. */
  params: VideoCanvasTakeParams;
  /** What it makes a video at, for the panel's settings (decided 2026-11-10, plan 27.21): the
   *  shapes, resolutions and lengths it lists with the other settings, and whether it can leave
   *  sound out. An edit keeps its source's shape and length, so it lists none. */
  ratios: string[];
  resolutions: string[];
  durations: number[];
  silent: boolean;
  unavailable?: VideoCanvasUnavailable;
};

export type VideoCanvasInputMethod = VideoCanvasDraftMethod;

export type VideoCanvasRedoOptions = {
  ok: true;
  /** A still keeps the configured service, so it has none to choose. */
  choices: VideoCanvasRedoChoice[];
  /** The service that made the take, or the first that can make it again. */
  current: string;
  /** How a video take is made, from references or on frames; a still and an edit have no choice. */
  method?: VideoCanvasInputMethod;
  /** Its inputs could open and end it instead: one or two images and no video. */
  frames_fit?: boolean;
  /** A still given more images than its tool takes. */
  unavailable?: VideoCanvasUnavailable;
};

type Route = { choice: VideoCanvasRedoChoice; profileId: string; provider: string; model: string; request: Record<string, unknown> };

function generationInputOf(request: Record<string, unknown>): GenerateVideoInput {
  const first = frameOf(request.first_frame);
  const last = frameOf(request.last_frame);
  return {
    prompt: String(request.prompt ?? ''),
    outputAbsPath: '',
    operation: request.operation === 'edit' ? 'edit' : 'generate',
    referenceImageUrls: stringsOf(request.reference_image_urls),
    referenceImagePaths: stringsOf(request.reference_image_paths),
    referenceVideoUrls: stringsOf(request.reference_video_urls),
    referenceVideoPaths: stringsOf(request.reference_video_paths),
    ...(first.url ? { firstFrameUrl: first.url } : {}),
    ...(first.path ? { firstFramePath: first.path } : {}),
    ...(last.url ? { lastFrameUrl: last.url } : {}),
    ...(last.path ? { lastFramePath: last.path } : {}),
    generateAudio: request.generate_audio !== false,
    ...(typeof request.ratio === 'string' ? { ratio: request.ratio } : {}),
    ...(typeof request.duration === 'number' ? { duration: request.duration } : {}),
    ...(typeof request.resolution === 'string' ? { resolution: request.resolution } : {}),
  };
}

/** Given a first frame and no ratio, the service keeps the frame's own shape, as the generation
 *  defaults it (video_gen normalizeVideoInput), or takes no other. */
function followsFrame(profile: VideoProfile): boolean {
  const spec = videoModelSpec(profile.provider, profile.model);
  const support = videoFrameSupport(profile.provider, profile.model);
  if (support.frames === 'none') return false;
  return support.fixRatio || !!spec?.ratios.includes('adaptive')
    || (!spec && (profile.provider === 'doubao'));
}

// ── Generation settings (decided 2026-11-10, plan 27.21) ────────────────────
// The panel sets a video's shape, resolution, length and sound, as TapNow's settings do. Each
// service lists what it makes; a setting it does not make becomes the nearest one it does, so
// only footage that does not fit greys a service out.

/** The settings the user picked for a take made again; one not picked stays as recorded. */
export type VideoCanvasSettings = { ratio?: string; resolution?: string; duration?: number; audio?: boolean };

type VideoOffer = Pick<VideoCanvasRedoChoice, 'ratios' | 'resolutions' | 'durations' | 'silent'>;
type Shape = { width: number; height: number } | null;

const SETTING_RATIOS: readonly string[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const MAX_SETTING_SECONDS = 30;

/** The settings the panel sent, or why they cannot be read. */
function askedSettings(value: unknown): VideoCanvasSettings | VideoCanvasRefusal {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid' };
  const { ratio, resolution, duration, audio } = value as Record<string, unknown>;
  const readable = (ratio === undefined || (typeof ratio === 'string' && SETTING_RATIOS.includes(ratio)))
    && (resolution === undefined || (typeof resolution === 'string' && VIDEO_RESOLUTIONS.includes(resolution)))
    && (duration === undefined || (typeof duration === 'number' && Number.isInteger(duration) && duration >= 1 && duration <= MAX_SETTING_SECONDS))
    && (audio === undefined || typeof audio === 'boolean');
  if (!readable) return { ok: false, code: 'invalid' };
  return {
    ...(typeof ratio === 'string' ? { ratio } : {}),
    ...(typeof resolution === 'string' ? { resolution } : {}),
    ...(typeof duration === 'number' ? { duration } : {}),
    ...(typeof audio === 'boolean' ? { audio } : {}),
  };
}

function aspectOf(ratio: string): number | undefined {
  const [width, height] = ratio.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : undefined;
}

/** The offered shape nearest one asked for; on a tie, the one nearest the production's video. */
function nearestRatioTo(asked: string, offered: readonly string[], shape: Shape): string | undefined {
  const concrete = offered.filter((ratio) => ratio !== 'adaptive');
  const target = aspectOf(asked) ?? (shape ? shape.width / shape.height : undefined);
  if (target === undefined) return concrete.includes('16:9') ? '16:9' : concrete[0] ?? offered[0];
  const home = shape ? shape.width / shape.height : target;
  const distance = (ratio: string, to: number) => Math.abs(Math.log((aspectOf(ratio) as number) / to));
  return [...concrete].sort((a, b) => {
    const nearer = distance(a, target) - distance(b, target);
    return Math.abs(nearer) > 1e-9 ? nearer : distance(a, home) - distance(b, home);
  })[0] ?? offered[0];
}

/**
 * A video call with the user's settings, as one service makes it. Each setting is the one asked
 * for where the service makes it, else the nearest it makes; sound is on where it cannot be left
 * out; a framed call on a service that takes its first frame's shape asks for none. The service's
 * own check decides which shapes it makes for this call, and which lengths at this resolution
 * (Veo makes 1080p at 8 seconds only). A setting neither the call nor the user named stays out,
 * for the service's own default, except a new shot's default shape and a framed call's shape on a
 * service that would not keep the first frame's: that is the one nearest the frame (decided
 * 2026-11-10). An edit keeps its source's shape and length. `shape` is the first frame's for a
 * framed call, else the production's video's, when known.
 */
function settingsOn(
  call: Record<string, unknown>,
  profile: VideoProfile,
  asked: VideoCanvasSettings,
  shape: Shape,
  defaultShape = false,
): { request: Record<string, unknown>; offer: VideoOffer; params: VideoCanvasTakeParams } {
  const envelope = videoModelSpec(profile.provider, profile.model) ?? ENVELOPE_WITHOUT_SPEC;
  const framed = !!(frameOf(call.first_frame).url || frameOf(call.first_frame).path);
  const edit = call.operation === 'edit';
  const request: Record<string, unknown> = { ...call };
  if (asked.ratio !== undefined) request.ratio = asked.ratio;
  if (asked.resolution !== undefined) request.resolution = asked.resolution;
  if (asked.duration !== undefined) request.duration = asked.duration;
  if (asked.audio !== undefined) request.generate_audio = asked.audio;
  const makes = (next: Record<string, unknown>) => !videoGenerationInputError(generationInputOf(next), profile);

  // Sound and resolution first: they depend on nothing else.
  if (request.generate_audio === false && !envelope.silent) request.generate_audio = true;
  const resolutions = [...envelope.resolutions];
  if (typeof request.resolution === 'string') request.resolution = nearestResolution(request.resolution, resolutions);

  let ratios: string[] = [];
  let durations: number[] = [];
  if (!edit) {
    const follows = framed && followsFrame(profile);
    if (framed && videoFrameSupport(profile.provider, profile.model).fixRatio) {
      ratios = ['adaptive'];
      if (!(request.ratio === 'adaptive' && envelope.ratios.includes('adaptive'))) delete request.ratio;
    } else {
      const candidates = [...(follows ? ['adaptive'] : []), ...envelope.ratios.filter((ratio) => ratio !== 'adaptive')];
      const offered = candidates.filter((ratio) => makes({ ...request, ratio }));
      ratios = offered.length ? offered : candidates;
      if (typeof request.ratio === 'string' && !ratios.includes(request.ratio)) request.ratio = nearestRatioTo(request.ratio, ratios, shape);
      else if (request.ratio === undefined && defaultShape) request.ratio = follows && ratios.includes('adaptive') ? 'adaptive' : nearestRatio(shape, ratios);
      else if (request.ratio === undefined && framed && !follows && shape) request.ratio = nearestRatio(shape, ratios);
    }
    const steps = draftDurations(profile, envelope);
    if (!steps.length) {
      // Omni times a video from its prompt.
      delete request.duration;
    } else {
      const lengthFits = (seconds: number) => makes({ ...request, duration: seconds });
      const allowed = steps.filter(lengthFits);
      const listed = allowed.length ? allowed : steps;
      const wanted = request.duration;
      if (typeof wanted === 'number' && !listed.includes(wanted) && !(Number.isInteger(wanted) && lengthFits(wanted))) {
        request.duration = nearestNumber(wanted, listed);
      }
      // A length it makes without a step, as a take on record may have, stays listed.
      durations = typeof request.duration === 'number' && !listed.includes(request.duration)
        ? [...listed, request.duration].sort((a, b) => a - b)
        : listed;
    }
  }

  const effective = effectiveVideoSettings(generationInputOf(request), profile);
  const params: VideoCanvasTakeParams = {
    ...(edit ? {} : typeof request.ratio === 'string' ? { ratio: request.ratio } : framed && followsFrame(profile) ? { ratio: 'adaptive' } : { ratio: effective.ratio }),
    resolution: typeof request.resolution === 'string' ? request.resolution : effective.resolution,
    ...(durations.length ? { duration: typeof request.duration === 'number' ? request.duration : effective.duration } : {}),
    audio: request.generate_audio !== false,
  };
  return { request, offer: { ratios, resolutions, durations, silent: envelope.silent }, params };
}

/** A take's call as one service would make it, with the settings the user picked. Only footage
 *  it cannot take, or frames it cannot open or end on, makes it a reason not to. */
function routeOf(
  asked: Record<string, unknown>,
  profile: VideoProfile,
  framesMisfit = false,
  settings: VideoCanvasSettings = {},
  frameShape: Shape = null,
): Pick<Route, 'request'> & Omit<VideoCanvasRedoChoice, 'id' | 'name' | 'frames'> {
  const envelope = videoModelSpec(profile.provider, profile.model) ?? ENVELOPE_WITHOUT_SPEC;
  const { request, offer, params } = settingsOn(asked, profile, settings, frameShape);
  const images = stringsOf(request.reference_image_paths).length + stringsOf(request.reference_image_urls).length;
  const videos = stringsOf(request.reference_video_paths).length + stringsOf(request.reference_video_urls).length;
  let unavailable: VideoCanvasUnavailable | undefined;
  const frames = framesUnavailable(request, profile, images + videos > 0);
  if (framesMisfit) unavailable = { code: 'frames_inputs' };
  else if (images > envelope.images) unavailable = { code: 'images', max: envelope.images };
  else if (videos > envelope.videos) unavailable = { code: 'videos', max: envelope.videos };
  else if (frames) unavailable = frames;
  else if (videoGenerationInputError(generationInputOf(request), profile)) unavailable = { code: 'other' };
  return { request, params, ...offer, ...(unavailable ? { unavailable } : {}) };
}

/** Why a service cannot open or end a take on the frames its call named, or nothing. */
function framesUnavailable(request: Record<string, unknown>, profile: VideoProfile, references: boolean): VideoCanvasUnavailable | undefined {
  const first = frameOf(request.first_frame);
  const last = frameOf(request.last_frame);
  if (!first.url && !first.path && !last.url && !last.path) return undefined;
  const support = videoFrameSupport(profile.provider, profile.model);
  if (support.frames === 'none') return { code: 'frames' };
  if ((last.url || last.path) && support.frames === 'first') return { code: 'last_frame' };
  if (references && !support.withReferences) return { code: 'frames_with_references' };
  return undefined;
}

/** One route per configured service, preserving settings order and exact identity. */
function serviceRoutes<C extends VideoCanvasRedoChoice>(
  shape: (entry: VideoProfile) => { request: Record<string, unknown>; choice: Omit<C, 'id' | 'name'> },
): Array<Route & { choice: C }> {
  const entries = listVideoGenCandidates().map(({ entry }) => entry);
  const names = entries.map((entry) => videoModelSpec(entry.provider, entry.model)?.name ?? entry.model);
  return entries.map((entry, index) => {
    const { request, choice } = shape(entry);
    const shared = names.filter((name) => name === names[index]).length > 1 && entry.label && entry.label !== 'default';
    return {
      choice: { id: entry.id, name: shared ? `${names[index]} · ${entry.label}` : names[index], ...choice } as C,
      profileId: entry.id, provider: entry.provider, model: entry.model, request,
    };
  });
}

/** The services a video take can be made on again, in the order configured, at the settings the
 *  user picked. */
function routesFor(row: RedoSource['row'], plan: InputPlan, settings: VideoCanvasSettings = {}): Route[] {
  if (row.kind !== 'video') return [];
  return serviceRoutes((entry) => {
    const { request, ...choice } = routeOf(plan.request, entry, plan.framesMisfit, settings, plan.frameShape);
    return { request, choice: { frames: videoFrameSupport(entry.provider, entry.model).frames, ...choice } };
  });
}

/** The first configured service that can make the call. */
function defaultRoute<R extends Route>(routes: readonly R[], fallback: R | undefined = routes[0]): R | undefined {
  return routes.find((route) => !route.choice.unavailable) ?? fallback;
}

/** Prefer the configured model that made the take while it can still make this call. */
function currentRoute(row: RedoSource['row'], routes: readonly Route[]): Route | undefined {
  const made = String(row.model ?? '');
  const slash = made.indexOf('/');
  const provider = slash > 0 ? made.slice(0, slash) : '';
  const model = slash > 0 ? made.slice(slash + 1) : '';
  const maker = routes.find((route) => route.provider === provider && route.model === model);
  if (maker && !maker.choice.unavailable) return maker;
  return defaultRoute(routes, maker ?? routes[0]);
}

/** Footage a call names, as a path its tool resolves from the workspace or as a link. */
type CallInput = { kind: 'image' | 'video'; path?: string; url?: string };

/** What the panel changed about a take's inputs, checked against the production. */
type AskedInputs = { method?: VideoCanvasInputMethod; added: CallInput[] };

/** A video take is made from references or on frames; a still and an edit have no choice. */
function offersMethod(row: RedoSource['row']): boolean {
  return row.kind === 'video' && row.request.operation !== 'edit';
}

function methodOf(request: Record<string, unknown>): VideoCanvasInputMethod {
  const first = frameOf(request.first_frame);
  return first.url || first.path ? 'frames' : 'references';
}

async function isFile(fileAbs: string): Promise<boolean> {
  return fs.stat(fileAbs).then((st) => st.isFile(), () => false);
}

/** The panel's change to a take's inputs (decided 2026-11-10), or why it cannot be made:
 *  footage that is not this production's, sound, a video for a still, or frames for a take with
 *  no choice of method. */
async function askedInputs(value: unknown, { row, located, ledger }: RedoSource): Promise<AskedInputs | VideoCanvasRefusal> {
  if (value === undefined || value === null) return { added: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid' };
  const { method, added } = value as { method?: unknown; added?: unknown };
  if (method !== undefined && method !== 'references' && method !== 'frames') return { ok: false, code: 'invalid' };
  if (method === 'frames' && !offersMethod(row)) return { ok: false, code: 'invalid' };
  if (added !== undefined && (!Array.isArray(added) || added.length > MAX_ADDED_INPUTS)) return { ok: false, code: 'invalid' };
  const inputs: CallInput[] = [];
  for (const id of (added as unknown[] | undefined) ?? []) {
    const source = typeof id === 'string' ? ledger.find((entry) => entry.id === id) : undefined;
    if (!source || source.kind === 'audio' || (row.kind === 'image' && source.kind !== 'image')) return { ok: false, code: 'invalid' };
    const fileAbs = path.resolve(located.productionAbs, source.path);
    if (!isPathAllowed(fileAbs, [located.productionAbs]) || !await isFile(fileAbs)) return { ok: false, code: 'invalid' };
    inputs.push({ kind: source.kind, path: fileAbs });
  }
  return { ...(method ? { method: method as VideoCanvasInputMethod } : {}), added: inputs };
}

/** A call's inputs in the order it names them: the opening frame, the references, the closing frame. */
function recordedInputs(kind: VideoAssetRecord['kind'], request: Record<string, unknown>): CallInput[] {
  const named = (field: unknown, as: CallInput['kind'], link: boolean): CallInput[] => stringsOf(field)
    .map((value) => (link ? { kind: as, url: value } : { kind: as, path: value }));
  if (kind === 'image') return [...named(request.reference_images, 'image', false), ...named(request.reference_image_urls, 'image', true)];
  const frame = (value: unknown): CallInput[] => {
    const { url, path: file } = frameOf(value);
    return url ? [{ kind: 'image', url }] : file ? [{ kind: 'image', path: file }] : [];
  };
  return [
    ...frame(request.first_frame),
    ...named(request.reference_image_paths, 'image', false),
    ...named(request.reference_image_urls, 'image', true),
    ...named(request.reference_video_paths, 'video', false),
    ...named(request.reference_video_urls, 'video', true),
    ...frame(request.last_frame),
  ];
}

const REFERENCE_FIELDS = [
  ['reference_image_paths', 'image', false],
  ['reference_image_urls', 'image', true],
  ['reference_video_paths', 'video', false],
  ['reference_video_urls', 'video', true],
] as const;

/** A video call naming these inputs in order: as references, or as the frames it opens and ends on. */
function videoCallWith(request: Record<string, unknown>, inputs: readonly CallInput[], method: VideoCanvasInputMethod): Record<string, unknown> {
  const next = { ...request };
  delete next.first_frame;
  delete next.last_frame;
  for (const [field] of REFERENCE_FIELDS) delete next[field];
  if (method === 'frames') {
    const [first, last] = inputs;
    if (first) next.first_frame = first.path ?? first.url;
    if (last) next.last_frame = last.path ?? last.url;
    return next;
  }
  for (const [field, kind, link] of REFERENCE_FIELDS) {
    const values = inputs.filter((input) => input.kind === kind && !!input.url === link).map((input) => input.url ?? input.path);
    if (values.length) next[field] = values;
  }
  return next;
}

/** A still's call with images added after its own. The roles count local images before links, so
 *  each link's role moves past the new images and keeps meaning the same picture. */
function stillCallWith(request: Record<string, unknown>, added: readonly CallInput[]): Record<string, unknown> {
  const own = stringsOf(request.reference_images);
  const bindings = Array.isArray(request.reference_bindings)
    ? request.reference_bindings.map((binding: unknown) => {
      const index = binding && typeof binding === 'object' ? (binding as { index?: unknown }).index : undefined;
      return typeof index === 'number' && index >= own.length ? { ...(binding as object), index: index + added.length } : binding;
    })
    : undefined;
  return { ...request, reference_images: [...own, ...added.map((input) => input.path)], ...(bindings ? { reference_bindings: bindings } : {}) };
}

type InputPlan = {
  request: Record<string, unknown>;
  /** How the take is made: its own way, or the one the user picked. */
  method: VideoCanvasInputMethod;
  /** Its inputs could be the frames it opens and ends on: one or two images and no video. */
  framesFit: boolean;
  /** The user asked for frames with inputs that cannot be them. */
  framesMisfit: boolean;
  /** Footage the user added that the call did not already name. */
  added: number;
  images: number;
  /** The shape of the picture it opens on, when it opens on a file in the workspace. */
  frameShape: Shape;
};

/** The shape of the picture a framed call opens on, read from its file in the workspace. */
async function frameShapeOf(request: Record<string, unknown>, workspaceAbs: string): Promise<Shape> {
  const { path: file } = frameOf(request.first_frame);
  if (!file) return null;
  const fileAbs = path.resolve(workspaceAbs, file);
  return isPathAllowed(fileAbs, [workspaceAbs]) ? pictureShape(fileAbs) : null;
}

/** The take's call with the panel's inputs: its own and the added ones, in order, as references or
 *  as frames. Unchanged when nothing changed, so a take made again as it was asks the same. */
async function planInputs({ row, located }: RedoSource, asked: AskedInputs): Promise<InputPlan> {
  const { request } = row;
  const own = recordedInputs(row.kind, request);
  const identity = (input: CallInput) => input.url ?? path.resolve(located.workspaceAbs, input.path as string);
  const seen = new Set(own.map(identity));
  const added: CallInput[] = [];
  for (const input of asked.added) {
    if (seen.has(identity(input))) continue;
    seen.add(identity(input));
    added.push(input);
  }
  const all = [...own, ...added];
  const recorded = offersMethod(row) ? methodOf(request) : 'references';
  const method = offersMethod(row) ? asked.method ?? recorded : 'references';
  const framesFit = all.length <= 2 && all.every((input) => input.kind === 'image');
  const unchanged = !added.length && method === recorded;
  const planned = unchanged ? request : row.kind === 'image' ? stillCallWith(request, added) : videoCallWith(request, all, method);
  return {
    request: planned,
    method,
    framesFit,
    framesMisfit: !unchanged && method === 'frames' && !(framesFit && all.length > 0),
    added: added.length,
    images: all.filter((input) => input.kind === 'image').length,
    frameShape: row.kind === 'video' && method === 'frames' ? await frameShapeOf(planned, located.workspaceAbs) : null,
  };
}

/** What making this take again on a service would ask for, for the panel that offers it, with the
 *  footage the user added and the way they picked. */
export async function videoCanvasRedoOptions(ctx: VideoCanvasJobContext, asset: unknown, inputs?: unknown, settings?: unknown): Promise<VideoCanvasRedoOptions | VideoCanvasRefusal> {
  const source = await findRedoSource(ctx, asset);
  if ('ok' in source) return source;
  const asked = await askedInputs(inputs, source);
  if ('ok' in asked) return asked;
  const picked = askedSettings(settings);
  if ('ok' in picked) return picked;
  const plan = await planInputs(source, asked);
  if (source.row.kind !== 'video') {
    return { ok: true, choices: [], current: '', ...(plan.images > STILL_MAX_IMAGES ? { unavailable: { code: 'images', max: STILL_MAX_IMAGES } } : {}) };
  }
  const routes = routesFor(source.row, plan, picked);
  return {
    ok: true,
    choices: routes.map((route) => route.choice),
    current: currentRoute(source.row, routes)?.choice.id ?? '',
    ...(offersMethod(source.row) ? { method: plan.method, frames_fit: plan.framesFit } : {}),
  };
}

export type VideoCanvasRedoQuote = {
  ok: true;
  sufficient: boolean;
  /** The configured service sets and charges its own fees. */
  own_key: boolean;
  external_billing_estimate_available: false;
};

type RedoRefusal = VideoCanvasRefusal | {
  ok: false;
  code: 'quote_failed' | 'in_progress' | 'unsupported' | 'route_unavailable';
};

/** A call ready to check and send on the selected configured service. */
type PlannedCall = { request: Record<string, unknown>; profileId?: string };

type PlannedRedo = PlannedCall & { changes: VideoCanvasRedoChanges; added: number };

/** The take's call with the user's words, footage and service. With no services to choose, a still
 *  or a video goes to the configured service, as a call from the Agent would. */
function planRedo(row: RedoSource['row'], asked: { prompt?: unknown; choice?: unknown }, plan: InputPlan, settings: VideoCanvasSettings = {}): PlannedRedo | RedoRefusal {
  const recorded = String(row.request.prompt ?? '').trim();
  const prompt = asked.prompt === undefined ? recorded : String(asked.prompt).trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return { ok: false, code: 'invalid' };
  const promptChanged = prompt !== recorded;
  // A still keeps the configured image service.
  if (row.kind !== 'video') {
    if (plan.images > STILL_MAX_IMAGES) return { ok: false, code: 'unsupported' };
    return { request: { ...plan.request, prompt }, changes: promptChanged ? 'prompt' : 'none', added: plan.added };
  }
  if (plan.framesMisfit) return { ok: false, code: 'unsupported' };
  const routes = routesFor(row, plan, settings);
  const current = currentRoute(row, routes);
  const wanted = typeof asked.choice === 'string' && asked.choice ? asked.choice : current?.choice.id;
  if (!wanted) return { request: { ...plan.request, prompt }, changes: promptChanged ? 'prompt' : 'none', added: plan.added };
  const route = routes.find((item) => item.choice.id === wanted);
  if (!route) return { ok: false, code: 'route_unavailable' };
  if (route.choice.unavailable) return { ok: false, code: 'unsupported' };
  const modelChanged = wanted !== current?.choice.id;
  return {
    request: { ...route.request, prompt },
    profileId: route.profileId,
    changes: promptChanged && modelChanged ? 'both' : promptChanged ? 'prompt' : modelChanged ? 'model' : 'none',
    added: plan.added,
  };
}

function shotOf(row: VideoAssetRecord): string {
  return row.shot || row.id;
}

/** An unresolved dispatch blocks another call for the shot, across turns and restarts. */
async function pendingRequestFor(ctx: VideoCanvasJobContext, call: {
  kind: 'image' | 'video'; shot: string; located: RedoSource['located'];
}): Promise<boolean> {
  return hasPendingProductionRequest({ userId: ctx.uid, scope: ctx.cid,
    productionDirAbs: call.located.productionAbs, shot: call.shot, kind: call.kind });
}

function pendingRedoRequest(ctx: VideoCanvasJobContext, { row, located }: RedoSource): Promise<boolean> {
  return pendingRequestFor(ctx, { kind: row.kind as 'image' | 'video', shot: shotOf(row), located });
}

function quoteOf(quote: VideoProductionServiceAvailability): VideoCanvasRedoQuote {
  return { ok: true, sufficient: quote.sufficient, own_key: isExternallyBilled(quote),
    external_billing_estimate_available: false };
}

async function availabilityOf(ctx: VideoCanvasJobContext, kind: VideoAssetRecord['kind'], planned: PlannedCall, workspaceAbs: string): Promise<VideoCanvasRedoQuote | RedoRefusal> {
  try {
    if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
    const quote = await quoteProductionIntents([intentOf(kind, planned.request, workspaceAbs)], undefined, { userId: ctx.uid, cid: ctx.cid }, planned.profileId);
    return ownsActiveAccount(ctx) ? quoteOf(quote) : { ok: false, code: 'not_found' };
  } catch (err) {
    log.warn('canvas redo quote failed', { error: logErrorSummary(err) });
    return { ok: false, code: 'quote_failed' };
  }
}

/** Whether the selected service can make the take. External fees are not estimated. */
export async function quoteVideoCanvasRedo(ctx: VideoCanvasJobContext, asset: unknown, choice?: unknown, inputs?: unknown, settings?: unknown): Promise<VideoCanvasRedoQuote | RedoRefusal> {
  const source = await findRedoSource(ctx, asset);
  if ('ok' in source) return source;
  const asked = await askedInputs(inputs, source);
  if ('ok' in asked) return asked;
  const picked = askedSettings(settings);
  if ('ok' in picked) return picked;
  const pending = await pendingRedoRequest(ctx, source);
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (pending) return { ok: false, code: 'in_progress' };
  const planned = planRedo(source.row, { choice }, await planInputs(source, asked), picked);
  if ('ok' in planned) return planned;
  return availabilityOf(ctx, source.row.kind, planned, source.located.workspaceAbs);
}

/** The planned call as a new request: the output path is what makes it new, since a repeat of
 *  the old call would return its already completed output. */
function newRequest({ row, located }: RedoSource, request: Record<string, unknown>): Record<string, unknown> {
  const fileAbs = path.resolve(located.productionAbs, row.path);
  const relative = path.relative(located.productionAbs, fileAbs);
  const inProduction = !relative.startsWith('..') && !path.isAbsolute(relative);
  const { name, ext } = path.parse(fileAbs);
  return {
    ...request,
    // Inside the production, or the result would have no card to show on.
    output_path: path.join(inProduction ? path.dirname(fileAbs) : path.join(located.productionAbs, 'shots'), `${name}-redo-${Date.now()}${ext}`),
    production_dir: located.productionAbs,
    shot: shotOf(row),
    label: row.label,
  };
}

/** Takes and new shots being started, until their job is registered. */
const startingRedos = new Set<string>();

/** Recheck configured-service availability, then start the explicitly requested job. */
async function launchJob(input: {
  ctx: VideoCanvasJobContext;
  key: string;
  state: VideoCanvasJobState;
  kind: VideoAssetRecord['kind'];
  located: RedoSource['located'];
  request: Record<string, unknown>;
  planned: PlannedCall;
  isBusy: () => boolean;
  place: (assetId: string) => Promise<Partial<VideoCanvasJobEvent>>;
}): Promise<{ ok: true } | RedoRefusal> {
  const { ctx, key, planned } = input;
  // Request/source reads happen before switch hooks can see this job.
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (redos.get(key)?.state.status === 'running') return { ok: false, code: 'in_progress' };
  const job: RedoJob = { ctx, controller: new AbortController(), state: input.state };
  redos.set(key, job);
  const refuse = (refusal: RedoRefusal): RedoRefusal => {
    if (redos.get(key) === job) redos.delete(key);
    return refusal;
  };
  if (planned) {
    let quote: VideoProductionServiceAvailability;
    try {
      quote = await quoteProductionIntents([intentOf(input.kind, planned.request, input.located.workspaceAbs)], undefined, { userId: ctx.uid, cid: ctx.cid }, planned.profileId);
    } catch (err) {
      log.warn('canvas redo quote failed', { error: logErrorSummary(err) });
      return refuse({ ok: false, code: 'quote_failed' });
    }
    if (job.controller.signal.aborted) return refuse({ ok: false, code: 'not_found' });
    if (!quote.sufficient) return refuse({ ok: false, code: 'route_unavailable' });
  }
  if (job.controller.signal.aborted) return refuse({ ok: false, code: 'not_found' });
  if (input.isBusy()) return refuse({ ok: false, code: 'busy' });
  emit(ctx, job.state);
  void runCanvasJob({
    key,
    job,
    kind: input.kind,
    located: input.located,
    request: input.request,
    ...(planned?.profileId ? { videoRoute: planned.profileId } : {}),
    place: input.place,
  });
  return { ok: true };
}

/** Make the explicitly requested take through the Agent's own generation tool and durable
 *  request/asset bookkeeping. Videos wait for the user's Update. */
export async function startVideoCanvasRedo(input: {
  ctx: VideoCanvasJobContext;
  asset: unknown;
  /** The words to make it with; the take's own when absent. */
  prompt?: unknown;
  /** A choice from videoCanvasRedoOptions; the take's own service when absent. */
  choice?: unknown;
  /** Footage the user added and the way they picked; the take's own when absent. */
  inputs?: unknown;
  /** The shape, resolution, length and sound the user picked; the take's own when absent. */
  settings?: unknown;
  /** The Agent owns the timeline while it works, and a take can outlast a turn. */
  isBusy: () => boolean;
}): Promise<{ ok: true } | RedoRefusal> {
  const { ctx } = input;
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (input.isBusy()) return { ok: false, code: 'busy' };
  if (typeof input.asset !== 'string') return { ok: false, code: 'not_found' };
  // Held before anything is awaited, so two confirmations cannot both get through.
  const startKey = jobKey(ctx, 'take', input.asset);
  if (startingRedos.has(startKey)) return { ok: false, code: 'in_progress' };
  startingRedos.add(startKey);
  try {
    const source = await findRedoSource(ctx, input.asset);
    if ('ok' in source) return source;
    const asked = await askedInputs(input.inputs, source);
    if ('ok' in asked) return asked;
    const picked = askedSettings(input.settings);
    if ('ok' in picked) return picked;
    const shot = `shot:${shotOf(source.row)}`;
    const key = jobKey(ctx, shot);
    if (redos.get(key)?.state.status === 'running') return { ok: false, code: 'in_progress' };
    const pending = await pendingRedoRequest(ctx, source);
    if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
    if (pending) return { ok: false, code: 'in_progress' };
    const inputs = await planInputs(source, asked);
    // The first frame read can outlast an account switch.
    if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
    const planned = planRedo(source.row, { prompt: input.prompt, choice: input.choice }, inputs, picked);
    if ('ok' in planned) return planned;
    return await launchJob({
      ctx,
      key,
      state: {
        dir: ctx.dir,
        kind: 'redo',
        status: 'running',
        shot,
        phase: 'generate',
        changes: planned.changes,
        added_refs: planned.added,
      },
      kind: source.row.kind,
      located: source.located,
      request: newRequest(source, planned.request),
      planned,
      isBusy: input.isBusy,
      place: async (assetId) => {
        // The completed result stays in the shot's history whatever happens next.
        if (input.isBusy()) return { swapped: false };
        const applied = await applyVideoCanvasEdit({
          uid: ctx.uid,
          cid: ctx.cid,
          dir: ctx.dir,
          busy: false,
          edit: { kind: 'use_result', asset: assetId },
        });
        if (applied.ok !== true) {
          log.warn('canvas redo kept on its shot card', { code: applied.code });
          return { swapped: false };
        }
        for (const video of applied.changed_videos) stopVideoCanvasRender(ctx, video);
        return { swapped: applied.changed_videos.length > 0 };
      },
    });
  } finally {
    startingRedos.delete(startKey);
  }
}

// ── New shots drawn from footage (decided 2026-11-10, plan 27.20) ─────────────────────────────

/** The lengths offered for a new shot, within what each service makes. */
const DURATION_STEPS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
const VEO_SECONDS = [4, 6, 8];
const DEFAULT_SECONDS = 5;
const VEO_DEFAULT_SECONDS = 8;
const DEFAULT_RESOLUTION = '720p';
/** A new shot is named by the start of its words. */
const LABEL_CHARS = 16;

type DraftSource = VideoCanvasDraftSource & { id: string; located: RedoSource['located'] };

/** A service for a new shot, with what it makes ("adaptive" keeps the first frame's shape). */
export type VideoCanvasDraftChoice = VideoCanvasRedoChoice;

export type VideoCanvasDraftOptions =
  | { ok: true; kind: 'video'; choices: VideoCanvasDraftChoice[]; current: string; method: VideoCanvasInputMethod; frames_fit: boolean }
  | { ok: true; kind: 'image'; choices: []; current: ''; unavailable?: VideoCanvasUnavailable };

type DraftRoute = Route & { choice: VideoCanvasDraftChoice };

async function findDraft(ctx: VideoCanvasJobContext, id: unknown): Promise<DraftSource | VideoCanvasRefusal> {
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const located = await locateProduction(ctx.uid, ctx.cid, ctx.dir);
  if (!located || !ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  const found = await readVideoCanvasDraft(located.productionAbs, id);
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if ('ok' in found) return found;
  return { ...found, id: id as string, located };
}

function nearestNumber(value: number, offered: readonly number[]): number | undefined {
  return [...offered].sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || b - a)[0];
}

/** The aspect ratio nearest the production's video among those offered; 16:9 without one. */
function nearestRatio(shape: DraftSource['shape'], offered: readonly string[]): string | undefined {
  const concrete = offered.filter((ratio) => ratio !== 'adaptive');
  if (!shape) return concrete.includes('16:9') ? '16:9' : concrete[0] ?? offered[0];
  const aspect = Math.log(shape.width / shape.height);
  const distance = (ratio: string) => {
    const [width, height] = ratio.split(':').map(Number);
    return Math.abs(Math.log(width / height) - aspect);
  };
  return [...concrete].sort((a, b) => distance(a) - distance(b))[0] ?? offered[0];
}

/** The lengths a service makes a new shot at. Omni times a video from its prompt. */
function draftDurations(profile: VideoProfile, envelope: { minDuration: number; maxDuration: number }): number[] {
  if (profile.provider === 'google') return [];
  const steps = profile.provider === 'google-cloud' ? VEO_SECONDS : DURATION_STEPS;
  return steps.filter((seconds) => seconds >= envelope.minDuration && seconds <= envelope.maxDuration);
}

/** The new shot has a stable output identity; unresolved requests are never replayed. */
function draftCall({ id, draft, inputs, located, shape }: DraftSource): Record<string, unknown> {
  const call: Record<string, unknown> = {
    prompt: draft.prompt.trim(),
    output_path: path.join(located.productionAbs, 'shots', `${id}.${draft.kind === 'video' ? 'mp4' : 'png'}`),
    production_dir: located.productionAbs,
    shot: id,
    label: Array.from(draft.prompt.replace(/\s+/g, ' ').trim()).slice(0, LABEL_CHARS).join('').trim(),
  };
  if (draft.kind === 'image') {
    const size = stillSize(shape, inputs.length > 0);
    return {
      ...call,
      ...(inputs.length ? { reference_images: inputs.map((input) => input.path) } : {}),
      ...(size ? { size } : {}),
    };
  }
  return videoCallWith(call, inputs.map(({ kind, path: file }) => ({ kind, path: file })), draft.method);
}

/** A still the shape of the production's videos, at a size the image service it goes to first
 *  makes as asked (decided 2026-11-10); none keeps that service's default. A still drawn from
 *  footage goes to the first service that takes references, as the image tool sends it. */
function stillSize(shape: DraftSource['shape'], withReferences: boolean): string | undefined {
  if (!shape) return undefined;
  const first = listOpenImageGenCandidates().find(({ capability }) => !withReferences || capability.supportsEdit);
  return first ? imageSizeForAspect(first.capability, shape.width / shape.height) : undefined;
}

/** A new shot as one service would make it: the user's settings where it makes them, else the
 *  nearest it makes, from the defaults decided (the production's shape, or on frames the first
 *  frame's, kept by the service or the nearest it makes; 5 seconds, 8 on Veo; the resolution
 *  nearest 720p; no sound where it can leave sound out). */
function draftRouteOf(source: DraftSource, profile: VideoProfile): Pick<DraftRoute, 'request'> & Omit<VideoCanvasDraftChoice, 'id' | 'name' | 'frames'> {
  const { draft, inputs, shape, frameShape } = source;
  const envelope = videoModelSpec(profile.provider, profile.model) ?? ENVELOPE_WITHOUT_SPEC;
  const framed = draft.method === 'frames';
  const { request, offer, params } = settingsOn(draftCall(source), profile, {
    ...(draft.ratio ? { ratio: draft.ratio } : {}),
    duration: draft.duration ?? (profile.provider === 'google-cloud' ? VEO_DEFAULT_SECONDS : DEFAULT_SECONDS),
    resolution: draft.resolution ?? DEFAULT_RESOLUTION,
    audio: draft.audio ?? false,
  }, framed ? frameShape ?? shape : shape, true);
  const images = inputs.filter((input) => input.kind === 'image').length;
  const videos = inputs.length - images;
  let unavailable: VideoCanvasUnavailable | undefined;
  if (framed && (!inputs.length || inputs.length > 2 || videos)) unavailable = { code: 'frames_inputs' };
  else if (framed) unavailable = framesUnavailable(request, profile, false);
  else if (images > envelope.images) unavailable = { code: 'images', max: envelope.images };
  else if (videos > envelope.videos) unavailable = { code: 'videos', max: envelope.videos };
  if (!unavailable && videoGenerationInputError(generationInputOf(request), profile)) unavailable = { code: 'other' };
  return { request, params, ...offer, ...(unavailable ? { unavailable } : {}) };
}

function draftRoutes(source: DraftSource): DraftRoute[] {
  return serviceRoutes<VideoCanvasDraftChoice>((entry) => {
    const { request, ...choice } = draftRouteOf(source, entry);
    return { request, choice: { frames: videoFrameSupport(entry.provider, entry.model).frames, ...choice } };
  });
}

/** The services a new shot can be made on, with the shapes and lengths each offers. A still keeps
 *  the configured image service, so it has none to choose. */
export async function videoCanvasDraftOptions(ctx: VideoCanvasJobContext, id: unknown): Promise<VideoCanvasDraftOptions | VideoCanvasRefusal> {
  const source = await findDraft(ctx, id);
  if ('ok' in source) return source;
  const { draft, inputs } = source;
  if (draft.kind === 'image') {
    return { ok: true, kind: 'image', choices: [], current: '', ...(inputs.length > STILL_MAX_IMAGES ? { unavailable: { code: 'images', max: STILL_MAX_IMAGES } } : {}) };
  }
  const routes = draftRoutes(source);
  return {
    ok: true,
    kind: 'video',
    choices: routes.map((route) => route.choice),
    current: defaultRoute(routes)?.choice.id ?? '',
    method: draft.method,
    frames_fit: inputs.length <= 2 && inputs.every((input) => input.kind === 'image'),
  };
}

/** The new shot's call, on the service the user picked while it is offered, else the default.
 *  Preflight can check settings before words are entered; generation requires the words
 *  explicitly supplied by the user (decided 2026-11-10). */
function planDraft(source: DraftSource, { pricing = false } = {}): PlannedCall | RedoRefusal {
  const prompt = source.draft.prompt.trim();
  if ((!prompt && !pricing) || prompt.length > MAX_PROMPT_CHARS) return { ok: false, code: 'invalid' };
  if (source.draft.kind === 'image') {
    return source.inputs.length > STILL_MAX_IMAGES ? { ok: false, code: 'unsupported' } : { request: draftCall(source) };
  }
  const routes = draftRoutes(source);
  const route = routes.find((item) => item.choice.id === source.draft.choice) ?? defaultRoute(routes);
  if (!route) return { ok: false, code: 'route_unavailable' };
  if (route.choice.unavailable) return { ok: false, code: 'unsupported' };
  return { request: route.request, profileId: route.profileId };
}

function pendingDraftRequest(ctx: VideoCanvasJobContext, { id, draft, located }: DraftSource): Promise<boolean> {
  return pendingRequestFor(ctx, { kind: draft.kind, shot: id, located });
}

/** Whether the configured service can make the new shot. External fees are not estimated. */
export async function quoteVideoCanvasDraft(ctx: VideoCanvasJobContext, id: unknown): Promise<VideoCanvasRedoQuote | RedoRefusal> {
  const source = await findDraft(ctx, id);
  if ('ok' in source) return source;
  const pending = await pendingDraftRequest(ctx, source);
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (pending) return { ok: false, code: 'in_progress' };
  const planned = planDraft(source, { pricing: true });
  if ('ok' in planned) return planned;
  return availabilityOf(ctx, source.draft.kind, planned, source.located.workspaceAbs);
}

/**
 * Make the explicitly requested new shot from footage through the Agent's own
 * tool. It becomes a shot card where the new shot stood, and goes into no video.
 */
export async function startVideoCanvasDraft(input: {
  ctx: VideoCanvasJobContext;
  id: unknown;
  isBusy: () => boolean;
}): Promise<{ ok: true } | RedoRefusal> {
  const { ctx } = input;
  if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
  if (input.isBusy()) return { ok: false, code: 'busy' };
  if (typeof input.id !== 'string') return { ok: false, code: 'not_found' };
  const startKey = jobKey(ctx, 'draft', input.id);
  if (startingRedos.has(startKey)) return { ok: false, code: 'in_progress' };
  startingRedos.add(startKey);
  try {
    const source = await findDraft(ctx, input.id);
    if ('ok' in source) return source;
    const shot = `draft:${source.id}`;
    const key = jobKey(ctx, shot);
    if (redos.get(key)?.state.status === 'running') return { ok: false, code: 'in_progress' };
    const pending = await pendingDraftRequest(ctx, source);
    if (!ownsActiveAccount(ctx)) return { ok: false, code: 'not_found' };
    if (pending) return { ok: false, code: 'in_progress' };
    const planned = planDraft(source);
    if ('ok' in planned) return planned;
    return await launchJob({
      ctx,
      key,
      state: { dir: ctx.dir, kind: 'new_shot', status: 'running', shot, phase: 'generate', added_refs: source.inputs.length },
      kind: source.draft.kind,
      located: source.located,
      request: planned.request,
      planned,
      isBusy: input.isBusy,
      place: async () => {
        // The completed shot is on the ledger; only its draft card is left to give way.
        await settleVideoCanvasDraft(source.located.productionAbs, source.id)
          .catch((err) => log.warn('canvas new shot left as a draft', { error: logErrorSummary(err) }));
        return {};
      },
    });
  } finally {
    startingRedos.delete(startKey);
  }
}

function redoFailureCode(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  const bracket = /^\[([A-Z_]+)\]/.exec(text)?.[1];
  const plain = /^(E_[A-Z_]+)/.exec(text)?.[1];
  try {
    const refusal = JSON.parse(text) as { errorCode?: unknown };
    if (typeof refusal.errorCode === 'string') return refusal.errorCode;
  } catch { /* not a structured refusal */ }
  return bracket ?? plain ?? 'E_CANVAS_REDO';
}

async function runCanvasJob(input: {
  key: string;
  job: RedoJob;
  kind: VideoAssetRecord['kind'];
  located: RedoSource['located'];
  request: Record<string, unknown>;
  videoRoute?: string;
  /** Where a finished result goes on the canvas, and what its event says about that. */
  place: (assetId: string) => Promise<Partial<VideoCanvasJobEvent>>;
}): Promise<void> {
  const { job } = input;
  const { ctx } = job;
  try {
    const toolOpts = {
      userId: ctx.uid,
      cid: ctx.cid,
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      ...(ctx.conversationTitle ? { conversationTitle: ctx.conversationTitle } : {}),
    };
    const tool = input.kind === 'video'
      ? (await import('../model/core-agent/video-gen-tool')).createVideoGenTool({ ...toolOpts, ...(input.videoRoute ? { videoRoute: input.videoRoute } : {}) })
      : (await import('../model/core-agent/image-gen-tool')).createImageGenTool(toolOpts);
    if (job.controller.signal.aborted) return;
    const result = await tool.execute(input.request, { workingDir: input.located.workspaceAbs, state: {}, signal: job.controller.signal });
    if (job.controller.signal.aborted) return;
    const [firstLine] = String(result.content ?? '').split('\n');
    let facts: { asset_id?: unknown; billed_to_own_key?: unknown } = {};
    try { facts = JSON.parse(firstLine) as typeof facts; } catch { /* a refusal or a plain message */ }
    if (result.isError || result.synthesizeAndEndTurn || typeof facts.asset_id !== 'string') {
      const code = redoFailureCode(result.content);
      log.warn('canvas redo refused', { code });
      fail(job, code);
      return;
    }
    const assetId = facts.asset_id;
    const placed = await input.place(assetId);
    if (redos.get(input.key) === job) redos.delete(input.key);
    const { phase: _phase, progress: _progress, code: _code, ...state } = job.state;
    emit(ctx, { ...state, status: 'done' }, {
      asset_id: assetId,
      ...placed,
      ...(facts.billed_to_own_key === true ? { own_key: true } : {}),
    });
  } catch (err) {
    if (job.controller.signal.aborted) return;
    log.warn('canvas redo failed', { error: logErrorSummary(err) });
    fail(job, 'E_CANVAS_REDO');
  }
}

/** Test seam: forget everything between cases. */
export function resetVideoCanvasJobsForTest(): void {
  for (const job of renders.values()) {
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    job.controller?.abort();
  }
  renders.clear();
  for (const job of redos.values()) job.controller.abort();
  redos.clear();
  startingRedos.clear();
  jobListener = null;
}
