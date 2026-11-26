import { MEDIA_TRANSFER_POLICY } from '../util/media-transfer-policy';
import { fetchMediaAndRead } from '../util/media-rate-limit';
import { VEO_DURATIONS, VIDEO_MODEL_SPECS, LEGACY_VIDEO_MODELS, isSeedance25Model, videoModelSpec, videoFrameSupport, isRetiredVideoModel, WAN_REGIONS } from './video_models';
import { fitVideoParameters, videoParameterModel } from './video_parameter_compatibility';
import { createVideoCloudCredentials } from './video_cloud_auth';
/** Video generation through configured user-owned provider keys. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { loadVideoProfiles, type VideoProfile } from './auth';
import { isVideoProviderModelAllowed } from './video_auth';
export { VIDEO_MODELS_BY_PROVIDER, isVideoProviderModelAllowed } from './video_auth';
import {
  ORKAS_API_BASE_URL,
  ORKAS_API_PROVIDER,
  ORKAS_API_VIDEO_MODEL,
  orkasApiUsageHeaders,
  type OrkasApiUsageContext,
} from './orkas_api';
import { prepareReferenceUrls, registerGeneratedMediaUrl, withReferencePreparation } from './generation_reference_assets';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { composeAbortSignal, fetchAndReadWithTimeout, throwIfAborted } from '../util/abort';
import { downloadBinaryWithProxyPolicy } from '../util/proxy-dispatcher';
import { logErrorSummary, logPathRef } from '../util/log-redact';
import { Semaphore } from 'async-mutex';
import { acquireWithAbort } from '../util/locks';
import { sanitizeLogTextForUpload } from '../util/log-sanitize';

const log = createLogger('video-gen');
// Saved profiles retain their Orkas model IDs. Pin the versions sent to Ark.
const DOUBAO_UPSTREAM_MODELS = new Map([
  ['doubao-seedance-2-0-mini', 'doubao-seedance-2-0-mini-260615'],
  ['doubao-seedance-2-5-flash', 'doubao-seedance-2-5-flash-261115'],
]);
const fetchNativeVideoAndRead: typeof fetchMediaAndRead = (input,init,timeout,signal,message,read,codes) => fetchMediaAndRead(input,init,timeout,signal,message,read,codes,'video');
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const CREATE_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// The public Orkas API keeps its existing timeout-only budget.
const MAX_CONSECUTIVE_POLL_TIMEOUTS = 5;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
// Expired Ark-style tasks are terminal and cannot deliver a video.
const VIDEO_TASK_FAILED_STATUSES = ['failed', 'cancelled', 'canceled', 'expired'];

const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com';
const MINIMAX_BASE = 'https://api.minimax.io';
const VIDU_BASE = 'https://api.vidu.com';
const KLING_BASE = 'https://api-singapore.klingai.com';
const GOOGLE_VIDEO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const VIDEO_CREATE_HTTP_TIMEOUT_MS = MEDIA_TRANSFER_POLICY.legacyCreateMs;
const VIDEO_POLL_HTTP_TIMEOUT_MS = MEDIA_TRANSFER_POLICY.pollMs;


export interface GenerateVideoInput {
  prompt: string;
  outputAbsPath: string;
  referenceImageUrls?: string[];
  referenceImagePaths?: string[];
  referenceVideoUrls?: string[];
  referenceVideoPaths?: string[];
  operation?: 'generate' | 'edit';
  ratio?: string;
  duration?: number;
  resolution?: string;
  quality?: 'economy' | 'balanced' | 'quality';
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: VideoProgressReporter;
  usageContext?: OrkasApiUsageContext;
  firstFrameUrl?: string;
  firstFramePath?: string;
  lastFrameUrl?: string;
  lastFramePath?: string;
  profileId?: string;
}

export type VideoProgressReporter = (event: {
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}) => void;

export type GenerateVideoResult =
  | {
      ok: true;
      path: string;
      bytes: number;
      provider: string;
      model: string;
      taskId: string;
      videoUrl: string;
      status: string;
      ratio?: string;
      duration?: number;
      resolution?: string;
    }
  | {
      ok: false;
      errorCode:
        | 'NO_CAPABLE_MODEL'
        | 'PROVIDER_API_ERROR'
        | 'DELIVERY_ERROR'
        | 'IO_ERROR'
        | 'BAD_INPUT'
        | 'TIMEOUT'
        | 'CREDITS_EXHAUSTED';
      message: string;
      taskId?: string;
      postDispatch?: boolean;
      dispatched?: false;
    };

class OrkasApiQuotaError extends Error {
  override readonly name = 'OrkasApiQuotaError';
}

class VideoDeliveryError extends Error {
  override readonly name = 'VideoDeliveryError';
  constructor(message: string, readonly taskId: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface PickedVideoGenProfile {
  entry: VideoProfile;
}
export function listVideoGenCandidates(): PickedVideoGenProfile[] {
  return loadVideoProfiles()
    .filter((profile) => isVideoProviderModelAllowed(profile.provider, profile.model) && !isRetiredVideoModel(profile.provider, profile.model))
    .map((entry) => ({ entry }));
}
export function pickVideoGenProfile(): PickedVideoGenProfile | null {
  return listVideoGenCandidates()[0] || null;
}
export function videoGenCandidatesForCall(profileId?:string):PickedVideoGenProfile[]{const candidates=listVideoGenCandidates();return profileId?candidates.filter(c=>c.entry.id===profileId):candidates;}


interface NormalizedVideoInput {
  prompt: string;
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  /** The frames to open and end on, uploaded; validation has kept them apart from references
   *  wherever the service cannot take both. */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  operation: 'generate' | 'edit';
  ratio: string;
  duration: number;
  resolution: string;
  quality: 'economy' | 'balanced' | 'quality';
  generateAudio: boolean;
  watermark: boolean;
  seed?: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

interface AdapterVideoRequest extends NormalizedVideoInput {
  apiKey: string;
  model: string;
  workspaceId?: string;
  region?: string;
  apiSite?: VideoProfile['apiSite'];
  deadlineAt?: number;
  signal?: AbortSignal;
  onProgress?: VideoProgressReporter;
  usageContext?: OrkasApiUsageContext;
  /** The image API has no ratio override; distinguish the generic default. */
  ratioExplicit?: boolean;
  /** Host-only dispatch evidence; provider text never determines this state. */
  onRequestDisposition?: (disposition: 'sent' | 'accepted' | 'rejected') => void;
}

interface OrkasVideoRequest extends NormalizedVideoInput {
  apiKey: string;
  signal?: AbortSignal;
  onProgress?: VideoProgressReporter;
  usageContext?: OrkasApiUsageContext;
}

interface OrkasVideoResult {
  buffer: Buffer;
  taskId: string;
  videoUrl: string;
  status: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
}

class VideoControlHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'VideoControlHttpError';
  }
}

/** A structured terminal failure must not be confused with lost tracking. */
class VideoTaskFailedError extends Error {
  /** `reason` is safe to show the Agent; it never carries provider prose. */
  constructor(message: string, readonly reason = '', readonly inputRejected = false) {
    super(message);
  }
}

const VIDEO_TASK_NEW_ATTEMPT = 'Calling generate_video again starts a new paid generation.';

// Provider prose can echo a private prompt, so a rejection is identified and
// reported only by its structured code.
const PROVIDER_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/;
// https://docs.volcengine.com/docs/82379/1299023
const DOUBAO_INPUT_REJECTION_CODE =
  /^(?:Input(?:Text|Image|Video|Audio)(?:SensitiveContentDetected|RiskDetection)|SensitiveContentDetected|InvalidParameter|InvalidImageURL)(?:\.[A-Za-z]*)?$/;

function providerErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && PROVIDER_ERROR_CODE.test(code) ? code : '';
}

class VideoInputRejectedError extends VideoControlHttpError {}

const TRANSIENT_VIDEO_ERROR_RE =
  /系统繁忙|请稍?后(?:重|再)?试|\b(?:429|50[0-4])\b|timed?\s*out|timeout|service unavailable|temporarily unavailable|too many requests|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|\bnet::ERR_[A-Z0-9_]+/i;
export function classifyVideoGenError(message: string): 'TIMEOUT' | 'PROVIDER_API_ERROR' | 'BAD_INPUT' {
  const msg = String(message || '');
  if (!TRANSIENT_VIDEO_ERROR_RE.test(msg)) return 'BAD_INPUT';
  return /timed?[\s_]*out|timeout/i.test(msg) ? 'TIMEOUT' : 'PROVIDER_API_ERROR';
}


// Every caller shares the four source-approved video slots. Request deadlines begin
// after admission; cancellation while waiting never sends a provider request.
const videoSlots = new Semaphore(4);

export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  let release: (() => void) | undefined;
  try {
    try {
      const acquire = async () => (await videoSlots.acquire())[1];
      release = input.signal ? await acquireWithAbort(acquire, input.signal) : await acquire();
      throwIfAborted(input.signal);
    } catch (err) {
      return { ok: false, errorCode: 'BAD_INPUT', message: sanitizeLogTextForUpload((err as Error)?.message || String(err)), dispatched: false };
    }
    return await generateVideoObserved(input);
  } finally {
    release?.();
  }
}

async function generateVideoObserved(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  try {
    throwIfAborted(input.signal);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'BAD_INPUT',
      message: sanitizeLogTextForUpload((err as Error).message || String(err)),
      dispatched: false,
    };
  }
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, errorCode: 'BAD_INPUT', message: 'prompt is required', dispatched: false };
  }
  if (!input.outputAbsPath) {
    return { ok: false, errorCode: 'BAD_INPUT', message: 'outputAbsPath is required', dispatched: false };
  }

  const candidates = videoGenCandidatesForCall(input.profileId);
  if (!candidates.length) {
    log.warn('video gen aborted: no video profile configured');
    return { ok: false, errorCode: 'NO_CAPABLE_MODEL', message: t('video_gen.no_capable_model'), dispatched: false };
  }

  // Preserve unsupported raw arguments before generic normalization/upload.
  // Do not bill another configured service for an invalid selected request.
  const firstInputError = videoGenerationInputError(fitVideoParameters(input,candidates[0].entry.provider,candidates[0].entry.model),candidates[0].entry);
  if (firstInputError) return { ok: false, errorCode: 'BAD_INPUT', message: firstInputError, dispatched: false };

  let normalized: NormalizedVideoInput;
  try {
    const refCount = (input.referenceImagePaths?.length || 0)
      + (input.referenceVideoPaths?.length || 0)
      + (input.referenceImageUrls?.length || 0)
      + (input.referenceVideoUrls?.length || 0)
      + (hasFirstFrame(input) ? 1 : 0)
      + (input.lastFrameUrl || input.lastFramePath ? 1 : 0);
    if (refCount) {
      emitProgress(input.onProgress, 'prepare_references', 'Preparing video references', { count: refCount });
    }
    const refs = await resolveReferenceUrls(input,candidates[0].entry);
    normalized = normalizeVideoInput({
      ...input,
      referenceImageUrls: refs.referenceImageUrls,
      referenceVideoUrls: refs.referenceVideoUrls,
      firstFrameUrl:refs.firstFrameUrl, lastFrameUrl:refs.lastFrameUrl,
    },candidates[0].entry);
  } catch (err) {
    // Reference preparation failed before any generation request was sent.
    const message = (err as Error).message || String(err);
    const safeMessage = sanitizeLogTextForUpload(message);
    // No generation request has left yet, so nothing billable happened.
    return { ok: false, errorCode: classifyVideoGenError(message), message: safeMessage, dispatched: false };
  }

  let lastProviderError = '';
  let lastInputRejected = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const compatibleInput=fitVideoParameters(input,candidate.entry.provider,candidate.entry.model);
    const inputError=videoGenerationInputError(compatibleInput,candidate.entry);
    if (inputError) return { ok: false, errorCode: 'BAD_INPUT', message: inputError, ...(i === 0 ? { dispatched: false as const } : {}) };
    let adapterRes: AdapterVideoResult;
    let requestDisposition: 'sent' | 'accepted' | 'rejected' | undefined;
    let acceptedTaskId: string | undefined;
    try {
      adapterRes = await dispatchVideo({
        ...normalizeVideoInput({...input,referenceImageUrls:normalized.referenceImageUrls,referenceVideoUrls:normalized.referenceVideoUrls,firstFrameUrl:normalized.firstFrameUrl,lastFrameUrl:normalized.lastFrameUrl},candidate.entry),
        workspaceId:candidate.entry.workspaceId,region:candidate.entry.region,apiSite:candidate.entry.apiSite,
        apiKey: candidate.entry.apiKey,
        model: candidate.entry.model,
        ...(candidate.entry.provider === 'kling' && candidate.entry.model === 'kling-v3-0-turbo' ? { ratioExplicit: input.ratio !== undefined, duration: input.duration ?? normalized.duration } : {}),
        signal: input.signal,
        onProgress: event => {
          if (event.phase === 'task_created' && typeof event.data?.taskId === 'string') acceptedTaskId = event.data.taskId;
          input.onProgress?.(event);
        },
        onRequestDisposition: disposition => { requestDisposition = disposition; },
        usageContext: input.usageContext,
      }, candidate.entry.provider);
    } catch (err) {
      lastProviderError = (err as Error).message || String(err);
      if (candidate.entry.provider === ORKAS_API_PROVIDER) {
        // Preserve the public API's existing terminal error and quota contract.
        const message = sanitizeLogTextForUpload(lastProviderError);
        if (err instanceof VideoDeliveryError) {
          return { ok: false, errorCode: 'DELIVERY_ERROR', message, taskId: err.taskId, postDispatch: true };
        }
        if (err instanceof OrkasApiQuotaError) {
          return { ok: false, errorCode: 'CREDITS_EXHAUSTED', message };
        }
        return {
          ok: false,
          errorCode: input.signal?.aborted || /operation aborted/i.test(message) ? 'BAD_INPUT'
            : /timed out|timeout/i.test(message) ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
          message,
        };
      }
      if (err instanceof VideoGenerationAcceptedTaskError) {
        log.warn('video task tracking stopped after creation', {
          provider: candidate.entry.provider, error_code: err.errorCode, has_task_receipt: true,
        });
        return { ok: false, errorCode: err.errorCode, message: err.message, taskId: err.taskId, postDispatch: true };
      }
      if (err instanceof VideoDeliveryError) {
        log.warn('video task completed but delivery retries were exhausted', {
          provider: candidate.entry.provider,
          model: candidate.entry.model,
          taskId: err.taskId,
          error: logErrorSummary(err),
        });
        return {
          ok: false,
          errorCode: 'DELIVERY_ERROR',
          message: sanitizeLogTextForUpload(lastProviderError),
          taskId: err.taskId,
          postDispatch: true,
        };
      }
      if (requestDisposition === 'sent' || requestDisposition === 'accepted') {
        log.warn('video generation stopped after dispatch without replay', {
          provider: candidate.entry.provider, request_disposition: requestDisposition,
          has_task_receipt: !!acceptedTaskId,
        });
        return {
          ok: false,
          errorCode: input.signal?.aborted || (err instanceof VideoTaskFailedError && err.inputRejected)
            ? 'BAD_INPUT' : lastProviderError.includes('timed out') ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
          message: err instanceof VideoTaskFailedError
            ? `${err.reason} ${VIDEO_TASK_NEW_ATTEMPT}`
            : 'Video task tracking stopped after a generation request was sent. The task or charge status may be unknown.',
          ...(acceptedTaskId ? { taskId: acceptedTaskId } : {}),
          postDispatch: true,
        };
      }
      if (input.signal?.aborted || /operation aborted/i.test(lastProviderError)) {
        return {
          ok: false,
          errorCode: 'BAD_INPUT',
          message: sanitizeLogTextForUpload(lastProviderError),
        };
      }
      lastInputRejected = err instanceof VideoInputRejectedError;
      const suffix = i < candidates.length - 1 ? '; trying next provider' : '';
      log.warn(`video gen API call failed (${candidate.entry.provider}/${candidate.entry.model})${suffix}`, {
        error: logErrorSummary(err),
      });
      continue;
    }

    const selectedModel = adapterRes.model || candidate.entry.model;
    const finalPath = candidate.entry.provider === ORKAS_API_PROVIDER
      ? ensurePublicApiMp4Extension(input.outputAbsPath)
      : ensureMp4Extension(input.outputAbsPath);
    let finished: {bytes:number;changed:boolean;duration?:number;resolution?:string;ratio?:string};
    try {
      emitProgress(input.onProgress, 'save', 'Saving generated video', { provider: candidate.entry.provider });
      throwIfAborted(input.signal);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      if(candidate.entry.provider===ORKAS_API_PROVIDER){await fs.writeFile(finalPath,adapterRes.buffer);finished={bytes:adapterRes.buffer.length,changed:false};}
      else { const {saveCompatibleVideo}=await import('./video_output_compatibility'); finished=await saveCompatibleVideo(adapterRes.buffer,finalPath,input,{...normalizeVideoInput(compatibleInput,candidate.entry),...(candidate.entry.provider==='google'?{duration:-1}:{}),...(typeof adapterRes.duration==='number'?{duration:adapterRes.duration}:{}),...(adapterRes.ratio?{ratio:adapterRes.ratio}:{}),...(adapterRes.resolution?{resolution:adapterRes.resolution}:{})},input.signal); }
    } catch (err) {
      const message = (err as Error).message || String(err);
      log.error('video write failed after provider completed', {
        provider: candidate.entry.provider,
        model: selectedModel,
        taskId: adapterRes.taskId,
        path: logPathRef(finalPath),
        error: logErrorSummary(err),
      });
      return {
        ok: false,
        errorCode: input.signal?.aborted || /operation aborted/i.test(message) ? 'BAD_INPUT' : 'IO_ERROR',
        message: sanitizeLogTextForUpload(
          `The provider completed this potentially billable video, but it could not be saved locally. `
          + `Do not retry automatically. Local write error: ${message}`,
        ),
        taskId: adapterRes.taskId,
        postDispatch: true,
      };
    }

    if(!finished.changed) registerGeneratedMediaUrl(finalPath, adapterRes.videoUrl);
    log.info('video generated', {
      provider: candidate.entry.provider,
      model: selectedModel,
      taskId: adapterRes.taskId,
      path: logPathRef(finalPath),
      bytes: finished.bytes,
    });
    return {
      ok: true,
      path: finalPath,
      bytes: finished.bytes,
      provider: candidate.entry.provider,
      model: selectedModel,
      taskId: adapterRes.taskId,
      videoUrl: adapterRes.videoUrl,
      status: adapterRes.status,
      ...(adapterRes.ratio ? { ratio: adapterRes.ratio } : {}),
      ...(typeof adapterRes.duration === 'number' ? { duration: adapterRes.duration } : {}),
      ...(adapterRes.resolution ? { resolution: adapterRes.resolution } : {}),
      ...(finished.duration!==undefined?{duration:finished.duration}:{}),...(finished.ratio?{ratio:finished.ratio}:{}),...(finished.resolution?{resolution:finished.resolution}:{}),
    };
  }

  return {
    ok: false,
    errorCode: lastInputRejected ? 'BAD_INPUT' : lastProviderError.includes('timed out') ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
    message: sanitizeLogTextForUpload(lastProviderError || 'video generation failed'),
  };
}

export const video_gen = generateVideo;

async function resolveReferenceUrls(
  input: GenerateVideoInput,
  profile?: VideoProfile,
): Promise<ResolvedReferences> {
  return withReferencePreparation(input.signal, async (signal) => {
    const spec = profile && videoParameterModel(profile.provider, profile.model)?.spec;
    const referenceImageUrls = await prepareReferenceUrls({
      kind: 'image',
      urls: input.referenceImageUrls,
      paths: input.referenceImagePaths,
      maxItems: spec?.images ?? 9,
      signal,
      onProgress: input.onProgress,
    });
    const referenceVideoUrls = await prepareReferenceUrls({
      kind: 'video',
      urls: input.referenceVideoUrls,
      paths: input.referenceVideoPaths,
      maxItems: spec?.videos ?? 3,
      signal,
      onProgress: input.onProgress,
    });
    const frame = async (url?: string, filePath?: string) => (url || filePath ? (await prepareReferenceUrls({
      kind: 'image',
      urls: url ? [url] : [],
      paths: filePath ? [filePath] : [],
      maxItems: 1,
      signal,
      onProgress: input.onProgress,
    }))[0] : undefined);
    const firstFrameUrl = await frame(input.firstFrameUrl, input.firstFramePath);
    const lastFrameUrl = await frame(input.lastFrameUrl, input.lastFramePath);
    if(profile?.provider === ORKAS_API_PROVIDER && [...referenceImageUrls,...referenceVideoUrls].some(url=>!/^https:\/\//i.test(url))) throw new Error('Orkas API video references must use public HTTPS URLs');
    return { referenceImageUrls, referenceVideoUrls, ...(firstFrameUrl ? { firstFrameUrl } : {}), ...(lastFrameUrl ? { lastFrameUrl } : {}) };
  });
}

async function dispatchVideo(req: AdapterVideoRequest, provider: string): Promise<AdapterVideoResult> {
  req = { ...req, deadlineAt: req.deadlineAt ?? Date.now() + req.timeoutMs };
  if(provider === ORKAS_API_PROVIDER) return callOrkasApiVideo({...req,quality:req.quality==='quality'?'quality':'balanced'});
  if (provider === 'doubao') req = normalizeDoubaoVideoRequest(req);
  emitProgress(
    req.onProgress,
    'configuration',
    `Video configuration: ${provider}/${videoModelDisplayName(req.model)}, ${req.resolution}, ${req.model === 'gemini-omni-1.1-flash' ? 'prompt-controlled duration' : `${req.duration}s`}, `
      + `${req.generateAudio ? 'audio requested' : 'silent'}; user API key, 0 Orkas credits/second`,
    {
      provider,
      model: req.model,
      ...(req.model === 'gemini-omni-1.1-flash' ? {} : { duration: req.duration }),
      resolution: req.resolution,
      generateAudio: req.generateAudio,
      creditsMilliPerSecond: 0,
    },
  );
  if (provider === 'doubao') return callDoubaoVideo(req);
  if (provider === 'minimax') return callMiniMaxVideo(req);
  if (provider === 'vidu') return callViduVideo(req);
  if (provider === 'kling') return callKlingVideo(req);
  if (provider === 'google') return callGoogleVideo(req);
  if (provider === 'runway') return callRunwayVideo(req);
  if (provider === 'aliyun') return callWanVideo(req);
  if (provider === 'google-cloud') return callCloudVeoVideo(req);
  throw new Error(`Unknown video-gen provider: ${provider}`);
}

async function callOrkasApiVideo(req: OrkasVideoRequest): Promise<OrkasVideoResult> {
  throwIfAborted(req.signal);
  emitProgress(req.onProgress, 'create_task', 'Creating Orkas API video task');
  const { body: createdData } = await fetchAndReadWithTimeout(
    `${ORKAS_API_BASE_URL}/videos`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
        ...orkasApiUsageHeaders(req.usageContext),
      },
      body: JSON.stringify({
        prompt: req.prompt,
        duration: req.duration,
        resolution: req.resolution,
        ratio: req.ratio,
        quality: req.quality,
        generate_audio: req.generateAudio,
        reference_image_urls: req.referenceImageUrls,
        reference_video_urls: req.referenceVideoUrls,
        operation: req.operation,
        ...(typeof req.seed === 'number' ? { seed: req.seed } : {}),
      }),
    },
    CREATE_TIMEOUT_MS,
    req.signal,
    'Orkas API video create request timed out',
    (response) => readOrkasVideoResponse(response, 'create'),
  );
  let data = createdData;
  const taskId = String(data?.id || '').trim();
  if (!taskId) throw new Error('Orkas API video create returned no task id');
  emitProgress(req.onProgress, 'task_created', `Video task created: ${taskId}`, { taskId });

  const started = Date.now();
  let attempts = 0;
  let consecutiveTimeouts = 0;
  while (Date.now() - started < req.timeoutMs) {
    throwIfAborted(req.signal);
    const status = String(data?.status || 'processing').toLowerCase();
    if (VIDEO_TASK_FAILED_STATUSES.includes(status)) {
      throw new Error(`Orkas API video task ${taskId} ${status}: ${truncate(JSON.stringify(data?.error || data), 500)}`);
    }
    const url = String(data?.url || '').trim();
    if (url) {
      emitProgress(req.onProgress, 'task_succeeded', `Video task completed: ${taskId}`, { taskId });
      const buffer = await downloadVideo(url, taskId, req.signal, req.onProgress);
      return {
        buffer,
        taskId,
        videoUrl: url,
        status: status || 'succeeded',
        ...(typeof data?.ratio === 'string' ? { ratio: data.ratio } : {}),
        ...(typeof data?.duration === 'number' ? { duration: data.duration } : {}),
        ...(typeof data?.resolution === 'string' ? { resolution: data.resolution } : {}),
      };
    }

    attempts += 1;
    emitProgress(req.onProgress, 'poll_wait', 'Waiting before checking video status', { taskId, attempt: attempts });
    await sleep(req.pollIntervalMs, req.signal);
    try {
      const { body: statusData } = await fetchAndReadWithTimeout(
        `${ORKAS_API_BASE_URL}/videos/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${req.apiKey}`,
            ...orkasApiUsageHeaders(req.usageContext),
          },
        },
        POLL_TIMEOUT_MS,
        req.signal,
        'Orkas API video status request timed out',
        (response) => readOrkasVideoResponse(response, 'status'),
      );
      data = statusData;
      consecutiveTimeouts = 0;
      emitProgress(req.onProgress, 'poll_result', `Video task status: ${data?.status || 'processing'}`, {
        taskId,
        attempt: attempts,
        status: String(data?.status || 'processing'),
      });
    } catch (err) {
      if (req.signal?.aborted || !/timed out|timeout/i.test((err as Error).message)) throw err;
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_POLL_TIMEOUTS) throw err;
    }
  }
  throw new Error(`Orkas API video task ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)} seconds`);
}

async function readOrkasVideoResponse(resp: Response, phase: string): Promise<any> {
  const text = await resp.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!resp.ok) {
    const error = data?.error || {};
    const message = error.message || text || `HTTP ${resp.status}`;
    const detail = `Orkas API video ${phase} ${resp.status}: ${truncate(String(message), 500)}`;
    if (resp.status === 402 || error.type === 'insufficient_quota' || /quota_exceeded/.test(String(error.code || ''))) {
      throw new OrkasApiQuotaError(detail);
    }
    throw new Error(detail);
  }
  return data;
}

async function downloadVideo(
  url: string,
  taskId: string,
  signal?: AbortSignal,
  onProgress?: VideoProgressReporter,
  headers?: Record<string, string>,
): Promise<Buffer> {
  throwIfAborted(signal);
  emitProgress(onProgress, 'download', 'Downloading generated video');
  const timeout = composeAbortSignal(signal, DOWNLOAD_TIMEOUT_MS, 'video download timed out');
  try {
    const result = await downloadBinaryWithProxyPolicy(url, {
      label: 'generated video download',
      ...(headers ? { headers } : {}),
      signal: timeout.signal,
      maxBytes: 512 * 1024 * 1024,
      validate: validateDownloadedVideo,
    });
    emitProgress(onProgress, 'download_done', `Video download complete: ${result.body.length} bytes`);
    throwIfAborted(signal);
    return result.body;
  } catch (err) {
    const message = signal?.aborted
      ? 'delivery was cancelled after the provider completed generation'
      : timeout.signal.aborted ? 'video download timed out' : (err as Error).message;
    throw new VideoDeliveryError(
      `The provider completed task ${taskId}, but the generated video could not be downloaded after bounded retries. Do not submit another generation task. ${message}`,
      taskId,
      { cause: err },
    );
  } finally {
    timeout.cleanup();
  }
}

export function validateDownloadedVideo(buffer: Buffer): void {
  const scanLimit = Math.min(buffer.length, 4096);
  let offset = 0;
  while (offset + 8 <= scanLimit) {
    let boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > scanLimit) break;
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      boxSize = Number(extendedSize);
      headerSize = 16;
    }
    if (boxType === 'ftyp') {
      if (boxSize >= headerSize + 8 && offset + boxSize <= buffer.length) return;
      break;
    }
    if (boxSize === 0 || boxSize < headerSize || offset + boxSize > scanLimit) break;
    offset += boxSize;
  }
  throw new Error('video download returned invalid or unsupported MP4 bytes');
}

function ensurePublicApiMp4Extension(value: string): string {
  const extension = path.extname(value);
  if (extension.toLowerCase() === '.mp4') return value;
  return extension ? `${value.slice(0, -extension.length)}.mp4` : `${value}.mp4`;
}

function ensureMp4Extension(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return ext ? p : `${p}.mp4`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function emitProgress(
  onProgress: VideoProgressReporter | undefined,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  onProgress?.({ phase, message, ...(data ? { data } : {}) });
}

class VideoGenerationAcceptedTaskError extends Error {
  constructor(message: string, readonly taskId: string, readonly errorCode: 'PROVIDER_API_ERROR' | 'TIMEOUT' | 'BAD_INPUT', options?: ErrorOptions) {
    super(message, options);
  }
}

function klingVideoInputError(input: GenerateVideoInput & { ratioExplicit?: boolean }): string | null {
  const imageCount = (input.referenceImageUrls?.length || 0) + (input.referenceImagePaths?.length || 0) + (hasFirstFrame(input) ? 1 : 0);
  const videoCount = (input.referenceVideoUrls?.length || 0) + (input.referenceVideoPaths?.length || 0);
  if (input.operation === 'edit' || videoCount) return 'Kling 3.0 Turbo supports text or one first-frame image; video editing is unsupported.';
  if (imageCount > 1) return 'Kling 3.0 Turbo accepts only one first-frame image.';
  if (input.seed !== undefined) return 'Kling 3.0 Turbo does not support a seed parameter.';
  // Turbo supports native audio but its API exposes no audio-off control.
  if (input.generateAudio === false) return 'Kling 3.0 Turbo does not expose a silent-video control. Use a video service that supports silent generation.';
  if (input.resolution !== undefined && !['720p', '1080p'].includes(input.resolution)) return 'Kling 3.0 Turbo resolution must be 720p or 1080p.';
  if (input.duration !== undefined && (!Number.isInteger(input.duration) || input.duration < 3 || input.duration > 15)) return 'Kling 3.0 Turbo duration must be an integer from 3 to 15 seconds.';
  if (imageCount && (input.ratioExplicit ?? (input.ratio !== undefined))) return 'Kling 3.0 Turbo image generation does not accept an aspect-ratio override. Omit ratio and use the first-frame image dimensions.';
  if (!imageCount && input.ratio !== undefined && !['16:9', '9:16', '1:1'].includes(input.ratio)) return 'Kling 3.0 Turbo text generation supports 16:9, 9:16 or 1:1.';
  if (input.prompt.trim().length > (imageCount ? 2500 : 3072)) return 'The prompt exceeds the Kling 3.0 Turbo limit. Shorten it before retrying.';
  return null;
}

async function fetchVideoControl<T>(
  url: string, init: RequestInit, req: AdapterVideoRequest, timeoutMs: number,
  timeoutMessage: string, readBody: (response: Response) => Promise<T>, creation = false,
): Promise<T> {
  throwIfAborted(req.signal);
  if (!creation && req.deadlineAt !== undefined) {
    const remaining = req.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('Video task query timed out.');
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  if (creation) req.onRequestDisposition?.('sent');
  const { body } = await fetchNativeVideoAndRead(url, init, timeoutMs, req.signal, timeoutMessage, response => {
    if (creation) {
      // A successful header is acceptance, not a usable task receipt. A 5xx
      // or lost connection does not prove that creation had no side effect.
      if (response.ok) req.onRequestDisposition?.('accepted');
      else if (response.status >= 400 && response.status < 500) req.onRequestDisposition?.('rejected');
    }
    return readBody(response);
  });
  return body;
}

async function readNativeVideoResponse(response: Response, label: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    let body: any;
    try { body = JSON.parse(text); } catch { /* an unparsable body names no code */ }
    const code = providerErrorCode(body?.error);
    const message = `${label} API ${response.status}${code ? `: ${code}` : ''}`;
    if (label.startsWith('DouBao') && DOUBAO_INPUT_REJECTION_CODE.test(code)) {
      throw new VideoInputRejectedError(message, response.status);
    }
    throw new VideoControlHttpError(message, response.status);
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { return {}; } // Invalid successful bodies remain missing receipts.
}

interface AdapterVideoResult {
  buffer: Buffer;
  taskId: string;
  videoUrl: string;
  status: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  model?: string;
}

function normalizeVideoInput(input: GenerateVideoInput, profile?: VideoProfile): NormalizedVideoInput {
  if(!profile || profile.provider === ORKAS_API_PROVIDER) return normalizeLegacyVideoInput(input);
  input = fitVideoParameters(input, profile.provider, profile.model);
  const known = profile && videoParameterModel(profile.provider, profile.model);
  const spec = known?.spec;
  const nativeProvider = known?.provider ?? profile?.provider;
  const current = spec && !profile!.model.startsWith('doubao-seedance-2-0');
  const edit25 = isSeedance25Model(profile?.model) && input.operation === 'edit';
  const duration = current ? input.duration ?? (edit25 ? -1 : nativeProvider === 'google-cloud' ? 8 : 5) : clampNumber(input.duration, 5, 4, 15);
  const pollIntervalMs = clampNumber(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1000, 30000);
  const timeoutMs = clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000, 60 * 60 * 1000);
  const framed = hasFirstFrame(input);
  // Given a first frame and no ratio, keep the frame's own shape wherever the service can.
  const frameRatio = framed && (profile?.provider === 'doubao' || !!spec?.ratios.includes('adaptive'));
  const firstFrameUrl = String(input.firstFrameUrl || '').trim();
  const lastFrameUrl = String(input.lastFrameUrl || '').trim();
  return {
    prompt: input.prompt.trim(),
    referenceImageUrls: (input.referenceImageUrls || []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, spec?.images ?? 9),
    referenceVideoUrls: (input.referenceVideoUrls || []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, spec?.videos ?? 3),
    ...(firstFrameUrl ? { firstFrameUrl } : {}),
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    operation: input.operation === 'edit' ? 'edit' : 'generate',
    ratio: current || profile?.provider === 'doubao' ? input.ratio ?? (edit25 || frameRatio ? 'adaptive' : '16:9')
      : normalizeChoice(input.ratio, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'),
    duration,
    resolution: current ? input.resolution ?? (spec?.resolutions.includes('720p') ? '720p' : '768p') : normalizeChoice(input.resolution, ['480p', '720p', '1080p'], '720p'),
    quality: normalizeChoice(input.quality, ['economy', 'balanced', 'quality'], 'balanced') as NormalizedVideoInput['quality'],
    generateAudio: input.generateAudio !== false,
    watermark: input.watermark === true,
    ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { seed: Math.trunc(input.seed) } : {}),
    pollIntervalMs,
    timeoutMs,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeChoice(value: unknown, allowed: string[], fallback: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  return allowed.includes(v) ? v : fallback;
}

function normalizeDoubaoVideoRequest(req: AdapterVideoRequest): AdapterVideoRequest {
  // Official Fast/Mini contract permits480p/720p. Requester confirmed the
  // 1080p ->720p fallback; keep Standard and the selected model identity.
  // https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh
  const supports1080p = !['doubao-seedance-2-5-flash', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini', 'doubao-seedance-2-0-mini-260615'].includes(req.model);
  return req.resolution === '1080p' && !supports1080p ? { ...req, resolution: '720p' } : req;
}

export async function callDoubaoVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  throwIfAborted(req.signal);
  req = normalizeDoubaoVideoRequest(req);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }, ...frameContent(req)];
  for (const url of req.referenceImageUrls) {
    content.push({
      type: 'image_url',
      role: 'reference_image',
      image_url: { url },
    });
  }
  for (const url of req.referenceVideoUrls) {
    content.push({
      type: 'video_url',
      role: 'reference_video',
      video_url: { url },
    });
  }

  const createBody = {
    model: DOUBAO_UPSTREAM_MODELS.get(req.model) ?? req.model,
    content,
    ratio: req.ratio,
    duration: req.duration,
    resolution: req.resolution,
    generate_audio: req.generateAudio,
    watermark: req.watermark,
    ...(isSeedance25Model(req.model) && req.operation === 'edit' ? { omni_reference_task_type: 'edit' } : {}),
    ...(typeof req.seed === 'number' ? { seed: req.seed } : {}),
  };

  emitProgress(req.onProgress, 'create_task', 'Creating Doubao video task', {
    provider: 'doubao',
    duration: req.duration,
    resolution: req.resolution,
  });
  const created = await fetchVideoControl(
    `${DOUBAO_BASE}/api/v3/contents/generations/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    },
    req,
    VIDEO_CREATE_HTTP_TIMEOUT_MS,
    `DouBao video create timed out after ${Math.round(VIDEO_CREATE_HTTP_TIMEOUT_MS / 1000)}s`,
    response => readNativeVideoResponse(response, 'DouBao video create'),
    true,
  );
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error(`DouBao video create API returned no task id: ${truncate(JSON.stringify(created), 500)}`);
  emitProgress(req.onProgress, 'task_created', `Video task created: ${taskId}; status: ${formatVideoStatus((created as any)?.status)}`, {
    provider: 'doubao',
    taskId,
    status: String((created as any)?.status || 'queued'),
  });

  const started = Date.now();
  let last: unknown = created;
  let pollAttempt = 0;
  let pollFailures = NO_POLL_FAILURES;
  while (Date.now() - started < req.timeoutMs) {
    throwIfAborted(req.signal);
    const now = Date.now();
    const currentStatus = String((last as any)?.status || 'processing').toLowerCase();
    pollAttempt += 1;
    emitProgress(req.onProgress, 'poll_wait', `Waiting ${Math.round(req.pollIntervalMs / 1000)}s before video task poll ${pollAttempt}; status: ${formatVideoStatus(currentStatus)}`, {
      provider: 'doubao',
      taskId,
      attempt: pollAttempt,
      status: currentStatus,
      elapsedMs: now - started,
    });
    await sleep(req.pollIntervalMs, req.signal);
    emitProgress(req.onProgress, 'poll_request', `Polling video task status, attempt ${pollAttempt}`, {
      provider: 'doubao',
      taskId,
      attempt: pollAttempt,
      elapsedMs: Date.now() - started,
    });
    let status = '';
    try {
      last = await fetchVideoControl(
        `${DOUBAO_BASE}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${req.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
        req,
        VIDEO_POLL_HTTP_TIMEOUT_MS,
        `DouBao video query timed out after ${Math.round(VIDEO_POLL_HTTP_TIMEOUT_MS / 1000)}s`,
        response => readNativeVideoResponse(response, 'DouBao video query'),
      );
      status = String((last as any)?.status || '').toLowerCase();
      pollFailures = NO_POLL_FAILURES;
      emitProgress(req.onProgress, 'poll_result', `Video task poll ${pollAttempt}: ${formatVideoStatus(status)} after ${Math.round((Date.now() - started) / 1000)}s`, {
        provider: 'doubao',
        taskId,
        attempt: pollAttempt,
        status: status || 'processing',
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      pollFailures = countVideoPollFailure(pollFailures, err, req.signal);
      if (pollFailures.count >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(videoPollStoppedMessage('DouBao video', taskId, pollFailures));
      }
      emitVideoPollRetry(req.onProgress, err, pollFailures.count, {
        provider: 'doubao',
        taskId,
        attempt: pollAttempt,
        elapsedMs: Date.now() - started,
      });
      continue;
    }
    if (VIDEO_TASK_FAILED_STATUSES.includes(status)) {
      const failureCode = providerErrorCode((last as any)?.error);
      const reason = failureCode
        ? `The provider failed this video task with code ${failureCode}.`
        : 'The provider reported that this video task failed.';
      throw new VideoTaskFailedError(
        `DouBao video task ${taskId} ${status}${failureCode ? `: ${failureCode}` : ''}`,
        reason, DOUBAO_INPUT_REJECTION_CODE.test(failureCode),
      );
    }
    if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
      const videoUrl = extractVideoUrl(last);
      if (!videoUrl) throw new Error(`DouBao video task ${taskId} succeeded without video_url`);
      emitProgress(req.onProgress, 'task_succeeded', `Video task completed: ${taskId}; preparing download`, {
        provider: 'doubao',
        taskId,
        status: status || 'succeeded',
        elapsedMs: Date.now() - started,
      });
      const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress);
      return {
        buffer,
        taskId,
        videoUrl,
        status: status || 'succeeded',
        ...(typeof (last as any)?.duration === 'number' ? { duration: (last as any).duration } : {}),
        ...(typeof (last as any)?.ratio === 'string' ? { ratio: (last as any).ratio } : {}),
        resolution: typeof (last as any)?.resolution === 'string' ? (last as any).resolution : req.resolution,
      };
    }
  }

  throw new Error(`DouBao video task ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)}s; last response: ${truncate(JSON.stringify(last), 500)}`);
}

export async function callMiniMaxVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  if (videoModelSpec('minimax', req.model)) return callMiniMaxH3Video(req);
  if (req.referenceVideoUrls.length || req.operation === 'edit') {
    throw new Error('MiniMax Hailuo 2.3 does not support reference-video editing in this adapter');
  }
  const duration = req.duration >= 8 ? 10 : 6;
  const resolution = req.resolution === '1080p' && duration === 6 ? '1080P' : '768P';
  const headers = { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' };
  const createBody: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    duration,
    resolution,
  };
  const firstImage = req.firstFrameUrl || req.referenceImageUrls[0];
  if (firstImage) createBody.first_frame_image = firstImage;
  const created = await requestJson(
    `${videoApiBase('minimax', req)}/v1/video_generation`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    'MiniMax video create',
  );
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error(`MiniMax video create returned no task id: ${truncate(JSON.stringify(created), 500)}`);
  emitProgress(req.onProgress, 'task_created', `MiniMax video task created: ${taskId}`, { provider: 'minimax', taskId });

  const started = Date.now();
  while (Date.now() - started < req.timeoutMs) {
    await sleep(req.pollIntervalMs, req.signal);
    const queried = await requestJson(
      `${videoApiBase('minimax', req)}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { method: 'GET', headers },
      req,
      'MiniMax video query',
    );
    const status = String((queried as any)?.status || '').toLowerCase();
    emitProgress(req.onProgress, 'poll_result', `MiniMax video task: ${formatVideoStatus(status)}`, { provider: 'minimax', taskId, status });
    if (status === 'fail' || status === 'failed') {
      throw new Error(`MiniMax video task ${taskId} failed: ${truncate(JSON.stringify(queried), 500)}`);
    }
    if (status === 'success' || status === 'succeeded') {
      const fileId = String((queried as any)?.file_id || '').trim();
      if (!fileId) throw new Error(`MiniMax video task ${taskId} succeeded without file_id`);
      const file = await requestJson(
        `${videoApiBase('minimax', req)}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
        { method: 'GET', headers },
        req,
        'MiniMax video file retrieve',
      );
      const videoUrl = String((file as any)?.file?.download_url || '').trim();
      if (!videoUrl) throw new Error(`MiniMax file ${fileId} returned no download_url`);
      const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress);
      return { buffer, taskId, videoUrl, status: 'succeeded', duration, resolution: resolution.toLowerCase(), model: req.model };
    }
  }
  throw new Error(`MiniMax video task ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)}s`);
}

export async function callViduVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  if (req.referenceVideoUrls.length || req.operation === 'edit') {
    throw new Error('Vidu Q3 Pro supports text/image generation here; reference-video editing requires a different Vidu model');
  }
  const headers = { Authorization: `Token ${req.apiKey}`, 'Content-Type': 'application/json' };
  const firstImage = req.firstFrameUrl || req.referenceImageUrls[0];
  // https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/start-end-to-video
  const endpoint = req.lastFrameUrl ? 'start-end2video' : firstImage ? 'img2video' : 'text2video';
  const resolution = req.resolution === '480p' ? '540p' : req.resolution;
  const createBody: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    duration: req.duration,
    resolution,
    audio: req.generateAudio,
    off_peak: false,
    ...(typeof req.seed === 'number' ? { seed: req.seed } : {}),
  };
  if (firstImage) createBody.images = req.lastFrameUrl ? [firstImage, req.lastFrameUrl] : [firstImage];
  else createBody.aspect_ratio = normalizeChoice(req.ratio, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9');
  const created = await requestJson(
    `${videoApiBase('vidu', req)}/ent/v2/${endpoint}`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    'Vidu video create',
  );
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error(`Vidu video create returned no task id: ${truncate(JSON.stringify(created), 500)}`);
  emitProgress(req.onProgress, 'task_created', `Vidu video task created: ${taskId}`, { provider: 'vidu', taskId });
  const started = Date.now();
  while (Date.now() - started < req.timeoutMs) {
    await sleep(req.pollIntervalMs, req.signal);
    const queried = await requestJson(
      `${videoApiBase('vidu', req)}/ent/v2/tasks/${encodeURIComponent(taskId)}/creations`,
      { method: 'GET', headers },
      req,
      'Vidu video query',
    );
    const status = String((queried as any)?.state || (queried as any)?.status || '').toLowerCase();
    emitProgress(req.onProgress, 'poll_result', `Vidu video task: ${formatVideoStatus(status)}`, { provider: 'vidu', taskId, status });
    if (status === 'failed' || status === 'fail') throw new Error(`Vidu video task ${taskId} failed: ${truncate(JSON.stringify(queried), 500)}`);
    if (status === 'success' || status === 'succeeded') {
      const videoUrl = String((queried as any)?.creations?.[0]?.url || (queried as any)?.video_url || '').trim();
      if (!videoUrl) throw new Error(`Vidu video task ${taskId} succeeded without a video URL`);
      const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress);
      return { buffer, taskId, videoUrl, status: 'succeeded', duration: req.duration, resolution, model: req.model };
    }
  }
  throw new Error(`Vidu video task ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)}s`);
}

export async function callKlingVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  if (videoModelSpec('kling', req.model)) return callKling4Video(req);
  throwIfAborted(req.signal);
  const inputError = klingVideoInputError({ ...req, outputAbsPath: '' });
  if (inputError) throw new Error(inputError);
  const firstImage = req.firstFrameUrl || req.referenceImageUrls[0];
  const endpoint = firstImage ? 'image-to-video' : 'text-to-video';
  const headers = { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' };
  // https://kling.ai/document-api/api/video/3-0-turbo/text-to-video
  // https://kling.ai/document-api/api/video/3-0-turbo/image-to-video
  const createBody: Record<string, unknown> = {
    ...(firstImage ? { contents: [{ type: 'prompt', text: req.prompt }, { type: 'first_frame', url: firstImage }] } : { prompt: req.prompt }),
    settings: { duration: req.duration, resolution: req.resolution, ...(!firstImage ? { aspect_ratio: req.ratio } : {}) },
    options: { watermark_info: { enabled: req.watermark } },
  };
  const created = await requestKlingJson(
    `${videoApiBase('kling', req)}/${endpoint}/kling-3.0-turbo`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    'Kling video create',
  );
  const taskId = typeof created?.data?.id === 'string' ? created.data.id.trim() : '';
  if (!taskId) throw new Error('Kling video create returned no native task id.');
  emitProgress(req.onProgress, 'task_created', `Kling video task created: ${taskId}`, { provider: 'kling', taskId });
  const started = Date.now();
  let pollFailures = NO_POLL_FAILURES;
  try {
    while (Date.now() - started < req.timeoutMs) {
      await sleep(req.pollIntervalMs, req.signal);
      let queried: any;
      try {
        queried = await requestKlingJson(`${videoApiBase('kling', req)}/tasks?${new URLSearchParams({ task_ids: taskId })}`, { method: 'GET', headers }, req, 'Kling video query');
        pollFailures = NO_POLL_FAILURES;
      } catch (err) {
        pollFailures = countVideoPollFailure(pollFailures, err, req.signal);
        if (pollFailures.count >= MAX_CONSECUTIVE_POLL_FAILURES) throw err;
        const timedOut = isVideoPollTimeoutError(err);
        emitProgress(req.onProgress, timedOut ? 'poll_timeout' : 'poll_retry',
          `Kling task status request ${timedOut ? 'timed out' : 'failed'}; retrying the same task query`,
          { provider: 'kling', taskId, retry: pollFailures.count });
        continue;
      }
      const task = Array.isArray(queried.data) ? queried.data.find((item: any) => String(item?.id || '') === taskId) : null;
      if (!task) throw new Error('Kling task query did not contain the accepted task.');
      const status = String(task.status || '').toLowerCase();
      emitProgress(req.onProgress, 'poll_result', `Kling video task: ${formatVideoStatus(status)}`, { provider: 'kling', taskId, status });
      if (status === 'failed') throw new Error('Kling could not complete the accepted video task.');
      if (status === 'succeeded') {
        const video = Array.isArray(task.outputs) ? task.outputs.find((item: any) => item?.type === 'video') : null;
        const videoUrl = String((req.watermark ? video?.watermark_url : video?.url) || '').trim();
        if (!videoUrl) throw new Error('Kling completed the task without the requested video output.');
        const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress);
        return { buffer, taskId, videoUrl, status, duration: req.duration, resolution: req.resolution, ...(!firstImage ? { ratio: req.ratio } : {}), model: req.model };
      }
      if (status !== 'submitted' && status !== 'processing') throw new Error('Kling returned an unknown task state.');
    }
    throw new VideoGenerationAcceptedTaskError('Kling task polling reached its deadline. The task may still be running; do not submit another generation automatically.', taskId, 'TIMEOUT');
  } catch (err) {
    if (err instanceof VideoDeliveryError || err instanceof VideoGenerationAcceptedTaskError) throw err;
    throw new VideoGenerationAcceptedTaskError('Kling task tracking stopped after creation. Preserve this task receipt and do not submit another generation automatically.', taskId, req.signal?.aborted ? 'BAD_INPUT' : 'PROVIDER_API_ERROR', { cause: err });
  }
}

async function requestKlingJson(url: string, init: RequestInit, req: AdapterVideoRequest, label: string): Promise<any> {
  throwIfAborted(req.signal);
  const data = await fetchVideoControl(url, init, req,
    init.method === 'POST' ? VIDEO_CREATE_HTTP_TIMEOUT_MS : VIDEO_POLL_HTTP_TIMEOUT_MS,
    `${label} timed out`, response => readNativeVideoResponse(response, label), init.method === 'POST');
  if (data?.code !== 0) {
    // Native business errors can arrive with HTTP200. Do not echo private
    // provider messages or mistake a rejected envelope for successful output.
    const code = typeof data?.code === 'number' ? data.code : 'unknown';
    if (init.method === 'POST' && typeof data?.code === 'number') req.onRequestDisposition?.('rejected');
    throw new Error(`Kling rejected the video request (code ${code}). Verify the video service settings and parameters before retrying.`);
  }
  return data;
}

export async function callGoogleVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  if (req.model === 'gemini-omni-1.1-flash') return callOmniVideo(req);
  if (req.referenceVideoUrls.length || req.operation === 'edit') {
    throw new Error('Google Veo 3.1 direct adapter currently supports text/image generation, not reference-video editing');
  }
  const duration = nearestChoice(req.resolution === '1080p' ? 8 : req.duration, [4, 6, 8]);
  const headers = { 'x-goog-api-key': req.apiKey, 'Content-Type': 'application/json' };
  const instance: Record<string, unknown> = { prompt: req.prompt };
  if (req.referenceImageUrls[0]) instance.image = await imageUrlToGoogleVideoImage(req.referenceImageUrls[0], req);
  const createBody = {
    instances: [instance],
    parameters: {
      aspectRatio: normalizeChoice(req.ratio, ['16:9', '9:16'], '16:9'),
      durationSeconds: duration,
      resolution: req.resolution === '1080p' ? '1080p' : '720p',
    },
  };
  const created = await requestJson(
    `${GOOGLE_VIDEO_BASE}/models/${encodeURIComponent(req.model)}:predictLongRunning`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    'Google Veo create',
  );
  const taskId = String((created as any)?.name || '').trim();
  if (!taskId) throw new Error(`Google Veo create returned no operation name: ${truncate(JSON.stringify(created), 500)}`);
  emitProgress(req.onProgress, 'task_created', `Google Veo operation created: ${taskId}`, { provider: 'google', taskId });
  const started = Date.now();
  while (Date.now() - started < req.timeoutMs) {
    await sleep(req.pollIntervalMs, req.signal);
    const queried = await requestJson(
      `${GOOGLE_VIDEO_BASE}/${taskId}`,
      { method: 'GET', headers },
      req,
      'Google Veo query',
    );
    if ((queried as any)?.error) throw new Error(`Google Veo operation failed: ${truncate(JSON.stringify((queried as any).error), 500)}`);
    const done = (queried as any)?.done === true;
    emitProgress(req.onProgress, 'poll_result', `Google Veo operation: ${done ? 'completed' : 'processing'}`, { provider: 'google', taskId, status: done ? 'succeeded' : 'processing' });
    if (done) {
      const videoUrl = String((queried as any)?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || '').trim();
      if (!videoUrl) throw new Error(`Google Veo operation ${taskId} completed without a video URI`);
      const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress, { 'x-goog-api-key': req.apiKey });
      return { buffer, taskId, videoUrl, status: 'succeeded', duration, resolution: req.resolution === '1080p' ? '1080p' : '720p', model: req.model };
    }
  }
  throw new Error(`Google Veo operation ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)}s`);
}

export async function callRunwayVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  if (req.referenceVideoUrls.length || req.operation === 'edit') {
    throw new Error('Runway Gen-4.5 supports text/image generation; use a Runway edit model for reference-video editing');
  }
  const headers = {
    Authorization: `Bearer ${req.apiKey}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': '2024-11-06',
  };
  const firstImage = req.firstFrameUrl || req.referenceImageUrls[0];
  const endpoint = firstImage ? 'image_to_video' : 'text_to_video';
  const duration = req.duration;
  const createBody: Record<string, unknown> = {
    model: req.model,
    promptText: req.prompt,
    ratio: runwayRatio(req.ratio, !!firstImage),
    duration,
  };
  if (firstImage) createBody.promptImage = firstImage;
  const created = await requestJson(
    `${RUNWAY_BASE}/v1/${endpoint}`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    firstImage ? 'Runway image-to-video create' : 'Runway text-to-video create',
  );
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error(`Runway video create returned no task id: ${truncate(JSON.stringify(created), 500)}`);
  emitProgress(req.onProgress, 'task_created', `Runway video task created: ${taskId}`, { provider: 'runway', taskId });
  const started = Date.now();
  while (Date.now() - started < req.timeoutMs) {
    await sleep(req.pollIntervalMs, req.signal);
    const queried = await requestJson(
      `${RUNWAY_BASE}/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET', headers },
      req,
      'Runway video query',
    );
    const status = String((queried as any)?.status || '').toLowerCase();
    emitProgress(req.onProgress, 'poll_result', `Runway video task: ${formatVideoStatus(status)}`, { provider: 'runway', taskId, status });
    if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
      throw new Error(`Runway video task ${taskId} ${status}: ${truncate(JSON.stringify(queried), 500)}`);
    }
    if (status === 'succeeded' || status === 'success') {
      const videoUrl = String((queried as any)?.output?.[0] || '').trim();
      if (!videoUrl) throw new Error(`Runway video task ${taskId} succeeded without output`);
      const buffer = await downloadVideo(videoUrl, taskId, req.signal, req.onProgress);
      return { buffer, taskId, videoUrl, status: 'succeeded', duration, resolution: '720p', model: req.model };
    }
  }
  throw new Error(`Runway video task ${taskId} timed out after ${Math.round(req.timeoutMs / 1000)}s`);
}

function extractTaskId(data: unknown): string {
  const d = data as any;
  return String(d?.id || d?.task_id || d?.taskId || d?.data?.id || d?.data?.task_id || d?.data?.taskId || '').trim();
}

function extractVideoUrl(data: unknown): string {
  const d = data as any;
  return String(
    d?.content?.video_url
      || d?.content?.videoUrl
      || d?.content?.url
      || d?.video_url
      || d?.videoUrl
      || d?.data?.content?.video_url
      || d?.data?.video_url
      || '',
  ).trim();
}

async function requestJson(
  url: string,
  init: RequestInit,
  req: AdapterVideoRequest,
  label: string,
): Promise<any> {
  throwIfAborted(req.signal);
  const data = await fetchVideoControl(
    url,
    init,
    req,
    init.method === 'POST' ? VIDEO_CREATE_HTTP_TIMEOUT_MS : VIDEO_POLL_HTTP_TIMEOUT_MS,
    `${label} timed out`,
    response => readNativeVideoResponse(response, label),
    init.method === 'POST',
  );
  const businessCode = data?.base_resp?.status_code;
  if (typeof businessCode === 'number' && businessCode !== 0) {
    if (init.method === 'POST') req.onRequestDisposition?.('rejected');
    throw new Error(`${label} failed (code ${businessCode})`);
  }
  return data;
}

async function imageUrlToGoogleVideoImage(url: string, req: AdapterVideoRequest): Promise<Record<string, unknown>> {
  const timeoutMessage = 'Google Veo reference image download timed out';
  const composed = composeAbortSignal(req.signal, DOWNLOAD_TIMEOUT_MS, timeoutMessage);
  try {
    const result = await downloadBinaryWithProxyPolicy(url, {
      label: 'Google Veo reference image download',
      signal: composed.signal,
      maxBytes: 100 * 1024 * 1024,
      validate: (body) => {
        if (!detectReferenceImageMimeType(body)) {
          throw new Error('Google Veo reference image download returned unsupported image bytes');
        }
      },
    });
    // Veo predictLongRunning uses the native Image object, not a
    // generateContent Part. Matches Google SDK imageToMldev conversion.
    return {
      mimeType: detectReferenceImageMimeType(result.body),
      bytesBase64Encoded: result.body.toString('base64'),
    };
  } catch (err) {
    if (req.signal?.aborted) throw new Error('operation aborted');
    if (composed.signal.aborted) throw new Error(timeoutMessage);
    throw err;
  } finally {
    composed.cleanup();
  }
}

function detectReferenceImageMimeType(buffer: Buffer): string {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function nearestChoice(value: number, choices: number[]): number {
  return choices.reduce((best, current) => (
    Math.abs(current - value) < Math.abs(best - value) ? current : best
  ), choices[0]);
}

function runwayRatio(ratio: string, imageToVideo: boolean): string {
  // Gen-4.5 text-to-video accepts only landscape and portrait. Image-to-video
  // additionally accepts square and wider/taller fixed resolutions.
  if (!imageToVideo) return ratio === '9:16' || ratio === '3:4' ? '720:1280' : '1280:720';
  return ({
    '16:9': '1280:720',
    '9:16': '720:1280',
    '1:1': '960:960',
    '4:3': '1104:832',
    '3:4': '832:1104',
    '21:9': '1584:672',
  } as Record<string, string>)[ratio] || '1280:720';
}

function videoModelDisplayName(model: string): string {
  const current = Object.values(VIDEO_MODEL_SPECS).flat().find(spec => spec.id === model);
  if (current) return current.name;
  return ({
    'doubao-seedance-2-0-260128': 'Seedance 2.0',
    'doubao-seedance-2-0-fast-260128': 'Seedance 2.0 Fast',
    'doubao-seedance-2-0-mini': 'Seedance 2.0 Mini',
  } as Record<string, string>)[model] || model;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(signal); } catch (err) { reject(err); return; }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('operation aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function formatVideoStatus(value: unknown): string {
  const status = String(value || 'processing').trim().toLowerCase();
  if (status === 'queued') return 'queued';
  if (status === 'running' || status === 'processing') return 'processing';
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'done') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'canceled') return 'canceled';
  return status || 'processing';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || '');
}

function isVideoPollTimeoutError(err: unknown): boolean {
  return !(err instanceof VideoControlHttpError) && /\b(timed out|timeout)\b/i.test(errorMessage(err));
}

/** Whether a failed status read leaves the accepted task worth querying again.
 *  An HTTP status is authoritative, so a rejection whose body merely mentions
 *  "503" or 系统繁忙 stays terminal; other failures are judged by transport text. */
function isTransientVideoPollError(err: unknown): boolean {
  const status = err instanceof VideoControlHttpError ? err.status : 0;
  if (status >= 400) return status === 408 || status === 429 || status >= 500;
  return TRANSIENT_VIDEO_ERROR_RE.test(errorMessage(err));
}

interface VideoPollFailures { count: number; allTimedOut: boolean }
const NO_POLL_FAILURES: VideoPollFailures = { count: 0, allTimedOut: true };

/** Counts one retryable status-read failure; anything else ends tracking now. */
function countVideoPollFailure(previous: VideoPollFailures, err: unknown, signal?: AbortSignal | null): VideoPollFailures {
  if (signal?.aborted || !isTransientVideoPollError(err)) throw err;
  return { count: previous.count + 1, allTimedOut: previous.allTimedOut && isVideoPollTimeoutError(err) };
}

/** generateVideoObserved reads "timed out" here as the TIMEOUT error code, so the
 *  phrase appears only when every failure in the streak really was a timeout. */
function videoPollStoppedMessage(label: string, taskId: string, failures: VideoPollFailures): string {
  const cause = failures.allTimedOut
    ? `the connection timed out ${failures.count} times in a row`
    : `${failures.count} status checks in a row hit a temporary error`;
  const subject = failures.allTimedOut ? 'network' : 'service or network';
  return `${label} status polling stopped: ${cause} (task ${taskId}). The ${subject} looks persistently interrupted — stopped instead of retrying silently until the overall timeout.`;
}

function emitVideoPollRetry(
  onProgress: VideoProgressReporter | undefined,
  err: unknown,
  retry: number,
  data: Record<string, unknown>,
): void {
  const timedOut = isVideoPollTimeoutError(err);
  emitProgress(onProgress, timedOut ? 'poll_timeout' : 'poll_retry',
    `Video status poll ${timedOut ? 'timed out' : 'failed'}; retrying (${retry}/${MAX_CONSECUTIVE_POLL_FAILURES})`, {
      ...data,
      retry,
      maxRetry: MAX_CONSECUTIVE_POLL_FAILURES,
      // Other failures can quote an upstream body, which stays out of the UI stream.
      ...(timedOut ? { error: errorMessage(err) } : {}),
    });
}


function normalizeLegacyVideoInput(input: GenerateVideoInput): NormalizedVideoInput {
  if (input.operation === 'edit' && !(input.referenceVideoUrls?.length)) {
    throw new Error('operation=edit requires at least one reference video');
  }
  const duration = clampNumber(input.duration, 5, 4, 15);
  const pollIntervalMs = clampNumber(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1000, 30000);
  const timeoutMs = clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000, 60 * 60 * 1000);
  return {
    prompt: input.prompt.trim(),
    referenceImageUrls: (input.referenceImageUrls || []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 9),
    referenceVideoUrls: (input.referenceVideoUrls || []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 3),
    operation: input.operation === 'edit' ? 'edit' : 'generate',
    ratio: normalizeChoice(input.ratio, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'),
    duration,
    resolution: normalizeChoice(input.resolution, ['480p', '720p', '1080p'], '720p'),
    quality: normalizeChoice(input.quality, ['economy', 'balanced', 'quality'], 'balanced') as NormalizedVideoInput['quality'],
    generateAudio: input.generateAudio !== false,
    watermark: input.watermark === true,
    ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { seed: Math.trunc(input.seed) } : {}),
    pollIntervalMs,
    timeoutMs,
  };
}

const VIDEO_API_BASES = {
  minimax: { cn: 'https://api.minimax.cn', global: 'https://api.minimax.io' },
  vidu: { cn: 'https://api.vidu.cn', global: 'https://api.vidu.com' },
  kling: { cn: 'https://api-beijing.klingai.com', global: 'https://api-singapore.klingai.com' },
} as const;

function hasFirstFrame(input: GenerateVideoInput): boolean {
  return !!(input.firstFrameUrl || input.firstFramePath);
}

function videoFrameInputError(input: GenerateVideoInput, profile: VideoProfile, imageCap?: number): string | null {
  const first = hasFirstFrame(input);
  const last = !!(input.lastFrameUrl || input.lastFramePath);
  if (!first && !last) return null;
  if (!first) return 'last_frame needs first_frame. Pass the opening image as first_frame too, or move this image to first_frame.';
  if (input.operation === 'edit') return 'operation=edit cannot use first_frame or last_frame.';
  if (profile.provider === 'google') {
    return 'Gemini Omni has no frame setting. Pass the images as reference images and say in the prompt which one opens the video and which one ends it.';
  }
  const support = videoFrameSupport(profile.provider, profile.model);
  if (support.frames === 'none') return `${support.name} does not accept images; remove first_frame.`;
  if (last && support.frames === 'first') return `${support.name} takes a first frame only; remove last_frame.`;
  const images = (input.referenceImageUrls?.length || 0) + (input.referenceImagePaths?.length || 0);
  const videos = (input.referenceVideoUrls?.length || 0) + (input.referenceVideoPaths?.length || 0);
  if ((images || videos) && !support.withReferences) {
    return `${support.name} cannot combine first_frame or last_frame with reference images or videos. Send the images either as frames or as references.`;
  }
  if (imageCap !== undefined && images + 1 + (last ? 1 : 0) > imageCap) return `${support.name} accepts at most ${imageCap} images, frames included.`;
  if (support.fixRatio && input.ratio !== undefined && input.ratio !== 'adaptive') return `${support.name} takes its aspect ratio from first_frame; omit ratio.`;
  return null;
}

export function videoGenerationInputError(input: GenerateVideoInput, profile: VideoProfile): string | null {
  if (profile.provider === ORKAS_API_PROVIDER) {
    if (hasFirstFrame(input) || input.lastFrameUrl || input.lastFramePath) return 'The public Orkas API does not support explicit first_frame or last_frame. Use reference images instead.';
    if ((input.referenceImageUrls?.length || 0) + (input.referenceImagePaths?.length || 0) > 9) return 'The public Orkas API accepts at most 9 reference images.';
    if ((input.referenceVideoUrls?.length || 0) + (input.referenceVideoPaths?.length || 0) > 3) return 'The public Orkas API accepts at most 3 reference videos.';
    return null;
  }
  const spec = videoModelSpec(profile.provider,profile.model);
  if (profile.provider === 'kling' && profile.model === 'kling-v3-0-turbo') return videoFrameInputError(input, profile) ?? klingVideoInputError(input);
  const framed = hasFirstFrame(input);
  if (!spec) {
    const frameError = videoFrameInputError(input, profile);
    if (frameError) return frameError;
    // Managed and saved legacy routes retain their established conversions,
    // but cannot fulfill settings outside their original request envelope.
    if (input.duration !== undefined && (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15)) return 'This video service supports durations from 4 to 15 seconds. Select a configured model that supports the requested duration.';
    if (input.resolution !== undefined && !['480p', '720p', '1080p'].includes(input.resolution)) return 'This video service supports 480p, 720p or 1080p. Select a configured model that supports the requested resolution.';
    if (input.ratio !== undefined && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(input.ratio)
      && !(profile.provider === 'doubao' && input.ratio === 'adaptive')) return 'This video service does not support the requested aspect ratio.';
    return null;
  }
  const images = (input.referenceImageUrls?.length || 0) + (input.referenceImagePaths?.length || 0);
  const videos = (input.referenceVideoUrls?.length || 0) + (input.referenceVideoPaths?.length || 0);
  if (images > spec.images) return `${spec.name} accepts at most ${spec.images} reference images.`;
  if (videos > spec.videos) return `${spec.name} accepts at most ${spec.videos} reference videos.`;
  const frameError = videoFrameInputError(input, profile,
    spec.framesWithReferences ? spec.images : undefined);
  if (frameError) return frameError;
  if (input.operation === 'edit' && !videos) return 'Video editing requires a reference video.';
  if (input.operation === 'edit' && !spec.videos) return `${spec.name} does not support video editing.`;
  if (input.duration !== undefined && ((!Number.isInteger(input.duration) || input.duration < spec.minDuration || input.duration > spec.maxDuration)
    && !(spec.autoDuration && input.duration === -1))) return `${spec.name} duration must be ${spec.minDuration}-${spec.maxDuration} seconds${spec.autoDuration ? ' or -1 for automatic duration' : ''}.`;
  if (input.ratio !== undefined && !spec.ratios.includes(input.ratio)
    && !(framed && spec.framesFixRatio && input.ratio === 'adaptive')) return `${spec.name} does not support this aspect ratio.`;
  if (input.resolution !== undefined && !spec.resolutions.includes(input.resolution)) return `${spec.name} resolution must be ${spec.resolutions.join(', ')}.`;
  if (profile.provider === 'runway' && !images && !framed && input.ratio !== undefined && !['16:9', '9:16'].includes(input.ratio)) return 'Runway Gen-4.5 text-to-video supports 16:9 or 9:16.';
  if (input.generateAudio === false && !spec.silent) return `${spec.name} does not expose a silent-video control. Use a service that supports silent generation.`;
  if ((profile.provider === 'kling' || profile.provider === 'minimax' || profile.provider === 'google') && input.seed !== undefined) return `${spec.name} does not expose a seed parameter.`;
  if (profile.provider === 'google') {
    if (input.duration !== undefined) return 'Omni controls video duration through the prompt. Omit duration and describe the timing in the prompt.';
  }
  if (profile.provider === 'google-cloud' && input.duration !== undefined && !VEO_DURATIONS.includes(input.duration)) return 'Veo 3.1 supports durations of 4, 6 or 8 seconds.';
  if (profile.provider === 'google-cloud' && ['1080p', '4k'].includes(input.resolution || '') && input.duration !== undefined && input.duration !== 8) return 'Veo 3.1 at 1080p or 4K requires 8 seconds.';
  if (profile.provider === 'google-cloud') {
    try { createVideoCloudCredentials(profile.apiKey); }
    catch (err) { return (err as Error).message; }
  }
  if (isSeedance25Model(profile.model) && input.operation === 'edit') {
    if (input.duration !== undefined && input.duration !== -1) return 'Seedance 2.5 editing requires duration=-1.';
    if (input.ratio !== undefined && input.ratio !== 'adaptive') return 'Seedance 2.5 editing requires ratio=adaptive.';
  }
  if (profile.provider === 'minimax' && !images && !videos && !framed && input.ratio === 'adaptive') return 'MiniMax H3 text-to-video requires a concrete aspect ratio.';
  if (profile.provider === 'kling' && !images && !videos && !framed && input.ratio === 'adaptive') return 'Kling text-to-video requires a concrete aspect ratio.';
  if (profile.provider === 'kling') {
    // Native mixed-character budget: English/26000 + non-English/11000 <= 1.
    let english = 0;
    let other = 0;
    for (const character of input.prompt) {
      if (character.codePointAt(0)! <= 0x7f) english += 1;
      else other += 1;
      if (english * 11000 + other * 26000 > 26000 * 11000) return 'Shorten the Kling prompt to fit its English/non-English character budget.';
    }
  }
  if (profile.provider === 'aliyun') {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(profile.workspaceId || '')) return 'Configure the Alibaba Cloud workspace ID before generating a video.';
    if (!WAN_REGIONS.includes(profile.region as typeof WAN_REGIONS[number])) return 'Select a supported Alibaba Cloud region.';
    if (input.prompt.length > 20000) return 'Shorten the Wan prompt to at most 20000 characters.';
  }
  return null;
}

type ResolvedReferences = { referenceImageUrls: string[]; referenceVideoUrls: string[]; firstFrameUrl?: string; lastFrameUrl?: string };

export function effectiveVideoSettings(input: GenerateVideoInput, profile: VideoProfile): { ratio: string; resolution: string; duration: number; generateAudio: boolean } {
  const { ratio, resolution, duration, generateAudio } = normalizeVideoInput(input, profile);
  return { ratio, resolution, duration, generateAudio };
}

function videoApiBase(provider: keyof typeof VIDEO_API_BASES, req: AdapterVideoRequest): string {
  // New profiles pin China explicitly; untagged credentials keep the historical route.
  return VIDEO_API_BASES[provider][req.apiSite === 'cn' ? 'cn' : 'global'];
}

async function pollCurrentVideo(
  req: AdapterVideoRequest, provider: string, taskId: string,
  query: () => Promise<any>, state: (data: any) => string,
  completed: (data: any) => Promise<AdapterVideoResult>, initial?: any,
): Promise<AdapterVideoResult> {
  const deadline = req.deadlineAt ?? Date.now() + req.timeoutMs;
  emitProgress(req.onProgress, 'task_created', 'Video task accepted', { provider, taskId });
  let failures = NO_POLL_FAILURES;
  let data = initial;
  try {
    while (Date.now() < deadline) {
      throwIfAborted(req.signal);
      if (!data) {
        await sleep(Math.min(req.pollIntervalMs, Math.max(0, deadline - Date.now())), req.signal);
        if (Date.now() >= deadline) break;
        try { data = await query(); failures = NO_POLL_FAILURES; }
        catch (err) {
          failures = countVideoPollFailure(failures, err, req.signal);
          if (failures.count >= MAX_CONSECUTIVE_POLL_FAILURES) throw err;
          emitVideoPollRetry(req.onProgress, err, failures.count, { provider, taskId });
          continue;
        }
      }
      const status = state(data).toLowerCase();
      emitProgress(req.onProgress, 'poll_result', 'Video task status received', { provider, taskId, status });
      if (['succeeded', 'success', 'completed', 'active'].includes(status)) return await completed(data);
      if (['failed', 'fail', 'cancelled', 'canceled', 'expired', 'unknown'].includes(status)) {
        throw new VideoTaskFailedError('The video provider could not complete this task.', 'The video provider could not complete this task.');
      }
      if (!['queued', 'pending', 'submitted', 'running', 'processing', 'in_progress'].includes(status)) throw new Error('The provider returned an unknown video task state.');
      data = undefined;
    }
    throw new VideoGenerationAcceptedTaskError('Video task polling reached its deadline. Preserve the task receipt; do not submit another generation automatically.', taskId, 'TIMEOUT');
  } catch (err) {
    if (err instanceof VideoDeliveryError || err instanceof VideoGenerationAcceptedTaskError || err instanceof VideoTaskFailedError) throw err;
    throw new VideoGenerationAcceptedTaskError('Video task tracking stopped after creation. Preserve the task receipt; do not submit another generation automatically.', taskId,
      req.signal?.aborted ? 'BAD_INPUT' : failures.count > 0 && failures.allTimedOut ? 'TIMEOUT' : 'PROVIDER_API_ERROR', { cause: err });
  }
}

async function queryCurrentVideo(url: string, init: RequestInit, req: AdapterVideoRequest): Promise<any> {
  return fetchVideoControl(url, init, req, VIDEO_POLL_HTTP_TIMEOUT_MS, 'Video task query timed out.', response => readNativeVideoResponse(response, 'Video task query'));
}

function frameContent(req: AdapterVideoRequest): Array<Record<string, unknown>> {
  return [
    ...(req.firstFrameUrl ? [{ type: 'image_url', role: 'first_frame', image_url: { url: req.firstFrameUrl } }] : []),
    ...(req.lastFrameUrl ? [{ type: 'image_url', role: 'last_frame', image_url: { url: req.lastFrameUrl } }] : []),
  ];
}

function nativeContent(req: AdapterVideoRequest): Array<Record<string, unknown>> {
  return [
    { type: 'text', text: req.prompt },
    ...frameContent(req),
    ...req.referenceImageUrls.map(url => ({ type: 'image_url', role: 'reference_image', image_url: { url } })),
    ...req.referenceVideoUrls.map(url => ({ type: 'video_url', role: 'reference_video', video_url: { url } })),
  ];
}

async function callMiniMaxH3Video(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  const headers = { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' };
  const created = await requestJson(`${videoApiBase('minimax', req)}/v2/video_generation`, { method: 'POST', headers, body: JSON.stringify({
    model: req.model, content: nativeContent(req), resolution: req.resolution.toUpperCase(), duration: req.duration, ratio: req.ratio,
  }) }, req, 'MiniMax H3 create');
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error('MiniMax H3 returned no task receipt.');
  return pollCurrentVideo(req, 'minimax', taskId,
    () => queryCurrentVideo(`${videoApiBase('minimax', req)}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { method: 'GET', headers }, req),
    data => String(data?.task?.status || ''), async data => {
      const task = data.task;
      const videoUrl = String(task?.content?.url || '');
      if (!videoUrl) throw new Error('MiniMax H3 completed without a video output.');
      return { buffer: await downloadVideo(videoUrl, taskId, req.signal, req.onProgress), taskId, videoUrl, status: 'succeeded', model: req.model,
        duration: task.duration, resolution: String(task.resolution || req.resolution).toLowerCase(), ratio: task.ratio };
    });
}

async function callKling4Video(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  const headers = { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' };
  const nativeModel = req.model === 'kling-v4-0-flash' ? 'kling-4.0-flash' : 'kling-4.0';
  // Generic references are reference assets, not keyframes. Preserve every asset. Frames are
  // keyframes: Kling wants the first frame before and the last frame after the other images.
  const hasReferences = !!(req.referenceImageUrls.length || req.referenceVideoUrls.length || req.firstFrameUrl);
  const contents: Array<Record<string, unknown>> = [{ type: 'prompt', text: req.prompt }];
  req.referenceVideoUrls.forEach((url, index) => contents.push({ type: req.operation === 'edit' && index === 0 ? 'base_video' : 'feature_video', url, id: `Video${index + 1}` }));
  if (req.firstFrameUrl) contents.push({ type: 'first_frame', url: req.firstFrameUrl });
  req.referenceImageUrls.forEach((url, index) => contents.push({ type: 'refer_image', url, id: `Image${index + 1}` }));
  if (req.lastFrameUrl) contents.push({ type: 'last_frame', url: req.lastFrameUrl });
  const created = await requestKlingJson(`${videoApiBase('kling', req)}/${hasReferences ? 'omni-video' : 'text-to-video'}/${nativeModel}`, {
    method: 'POST', headers, body: JSON.stringify({
      ...(hasReferences ? { contents } : { prompt: req.prompt }),
      settings: { duration: req.duration, resolution: req.resolution, aspect_ratio: req.ratio },
      options: { watermark_info: { enabled: req.watermark } },
    }),
  }, req, 'Kling video create');
  const taskId = String(created?.data?.id || '');
  if (!taskId) throw new Error('Kling returned no task receipt.');
  const task = (data: any) => Array.isArray(data?.data) ? data.data.find((item: any) => item?.id === taskId) : undefined;
  return pollCurrentVideo(req, 'kling', taskId,
    () => requestKlingJson(`${videoApiBase('kling', req)}/tasks?${new URLSearchParams({ task_ids: taskId })}`, { method: 'GET', headers }, req, 'Kling video query'),
    data => String(task(data)?.status || ''), async data => {
      const result = task(data);
      const video = result?.outputs?.find((item: any) => item?.type === 'video');
      const videoUrl = String((req.watermark ? video?.watermark_url : video?.url) || '');
      if (!videoUrl) throw new Error('Kling completed without the requested video output.');
      const duration = Number(video.duration);
      return { buffer: await downloadVideo(videoUrl, taskId, req.signal, req.onProgress), taskId, videoUrl, status: 'succeeded', model: req.model,
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}), resolution: req.resolution, ratio: req.ratio };
    });
}

async function callWanVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  const base = `https://${req.workspaceId}.${req.region}.maas.aliyuncs.com/api/v1`;
  const headers = { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' };
  const media = [
    ...(req.firstFrameUrl ? [{ type: 'first_frame', url: req.firstFrameUrl }] : []),
    ...(req.lastFrameUrl ? [{ type: 'last_frame', url: req.lastFrameUrl }] : []),
    ...req.referenceImageUrls.map(url => ({ type: 'reference_image', url })),
    ...req.referenceVideoUrls.map(url => ({ type: 'reference_video', url })),
  ];
  const created = await requestJson(`${base}/services/aigc/video-generation/video-synthesis`, { method: 'POST', headers, body: JSON.stringify({
    model: req.model, input: { prompt: req.prompt, ...(media.length ? { media } : {}) },
    parameters: { resolution: req.resolution.toUpperCase(), ratio: req.ratio, duration: req.duration, audio: req.generateAudio,
      ...(req.seed !== undefined ? { seed: req.seed } : {}) },
  }) }, req, 'Wan video create');
  const taskId = String(created?.output?.task_id || '');
  if (!taskId) throw new Error('Wan returned no task receipt.');
  return pollCurrentVideo(req, 'aliyun', taskId,
    () => queryCurrentVideo(`${base}/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', headers }, req),
    data => String(data?.output?.task_status || ''), async data => {
      const videoUrl = String(data?.output?.video_url || '');
      if (!videoUrl) throw new Error('Wan completed without a video output.');
      return { buffer: await downloadVideo(videoUrl, taskId, req.signal, req.onProgress), taskId, videoUrl, status: 'succeeded', model: req.model,
        ...(typeof data.output.duration === 'number' ? { duration: data.output.duration } : {}), resolution: req.resolution };
    });
}

async function callCloudVeoVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  const credentials = createVideoCloudCredentials(req.apiKey, req.signal);
  const base = `https://us-central1-aiplatform.googleapis.com/v1/projects/${credentials.projectId}/locations/us-central1/publishers/google/models/${req.model}`;
  const headers = async () => ({ Authorization: `Bearer ${await credentials.token()}`, 'Content-Type': 'application/json' });
  const instance: Record<string, unknown> = { prompt: req.prompt };
  const firstImage = req.firstFrameUrl || req.referenceImageUrls[0];
  if (firstImage) instance.image = await imageUrlToGoogleVideoImage(firstImage, req);
  // https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation
  if (req.lastFrameUrl) instance.lastFrame = await imageUrlToGoogleVideoImage(req.lastFrameUrl, req);
  const created = await requestJson(`${base}:predictLongRunning`, { method: 'POST', headers: await headers(), body: JSON.stringify({
    instances: [instance], parameters: { aspectRatio: req.ratio, durationSeconds: req.duration, resolution: req.resolution, sampleCount: 1, generateAudio: req.generateAudio,
      ...(req.seed !== undefined ? { seed: req.seed } : {}) },
  }) }, req, 'Google Cloud Veo create');
  const taskId = String(created?.name || '');
  if (!taskId) throw new Error('Google Cloud Veo returned no operation receipt.');
  return pollCurrentVideo(req, 'google-cloud', taskId,
    async () => queryCurrentVideo(`${base}:fetchPredictOperation`, { method: 'POST', headers: await headers(), body: JSON.stringify({ operationName: taskId }) }, req),
    data => data?.error ? 'failed' : data?.done ? 'completed' : 'running', async data => {
      const video = data?.response?.videos?.[0];
      if (typeof video?.bytesBase64Encoded !== 'string' || video.mimeType !== 'video/mp4') throw new Error('Google Cloud Veo completed without inline MP4 output.');
      const buffer = Buffer.from(video.bytesBase64Encoded, 'base64');
      validateDownloadedVideo(buffer);
      return { buffer, taskId, videoUrl: '', status: 'succeeded', model: req.model, duration: req.duration, resolution: req.resolution, ratio: req.ratio };
    });
}

async function callOmniVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  const headers = { 'x-goog-api-key': req.apiKey, 'Content-Type': 'application/json' };
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
  for (const url of req.referenceImageUrls) {
    const image = await imageUrlToGoogleVideoImage(url, req);
    input.push({ type: 'image', mime_type: image.mimeType, data: image.bytesBase64Encoded });
  }
  for (const url of req.referenceVideoUrls) {
    const composed = composeAbortSignal(req.signal, DOWNLOAD_TIMEOUT_MS, 'Omni reference download timed out.');
    try {
      const { body } = await downloadBinaryWithProxyPolicy(url, { label: 'Omni reference video', signal: composed.signal, maxBytes: 20 * 1024 * 1024, validate: validateDownloadedVideo });
      input.push({ type: 'video', mime_type: 'video/mp4', data: body.toString('base64') });
    } finally { composed.cleanup(); }
  }
  const created = await requestJson(`${GOOGLE_VIDEO_BASE}/interactions`, { method: 'POST', headers, body: JSON.stringify({
    model: req.model, input, background: true,
    response_format: { type: 'video', delivery: 'uri', aspect_ratio: req.ratio, resolution: req.resolution },
  }) }, req, 'Google Omni create');
  const taskId = String(created?.id || '');
  if (!taskId) throw new Error('Google Omni returned no interaction receipt.');
  return pollCurrentVideo(req, 'google', taskId,
    () => queryCurrentVideo(`${GOOGLE_VIDEO_BASE}/interactions/${encodeURIComponent(taskId)}`, { method: 'GET', headers }, req),
    data => String(data?.status || ''), async data => {
      const video = data?.steps?.filter((step: any) => step?.type === 'model_output')
        .flatMap((step: any) => Array.isArray(step.content) ? step.content : []).find((item: any) => item?.type === 'video');
      if (video?.mime_type !== 'video/mp4') throw new Error('Google Omni completed without MP4 video output.');
      if (typeof video.data === 'string') {
        const buffer = Buffer.from(video.data, 'base64'); validateDownloadedVideo(buffer);
        return { buffer, taskId, videoUrl: '', status: 'succeeded', model: req.model, resolution: req.resolution };
      }
      // URI delivery uses the Files API. Never forward the user's key to a foreign host.
      const uri = new URL(String(video.uri || ''));
      if (uri.protocol !== 'https:' || uri.hostname !== 'generativelanguage.googleapis.com' || !uri.pathname.startsWith('/v1beta/files/')) throw new Error('Google Omni returned an unsupported file URI.');
      const fileMatch = /^\/v1beta\/files\/([A-Za-z0-9_-]+)(?::download)?$/.exec(uri.pathname);
      if (!fileMatch) throw new Error('Google Omni returned an unsupported file identifier.');
      const name = fileMatch[1];
      return pollCurrentVideo(req, 'google', taskId,
        () => queryCurrentVideo(`${GOOGLE_VIDEO_BASE}/files/${encodeURIComponent(name)}`, { method: 'GET', headers }, req),
        file => String(file?.state || ''), async () => {
          const download = new URL(`${GOOGLE_VIDEO_BASE}/files/${encodeURIComponent(name)}:download?alt=media`);
          return { buffer: await downloadVideo(download.href, taskId, req.signal, req.onProgress, { 'x-goog-api-key': req.apiKey }),
            taskId, videoUrl: '', status: 'succeeded', model: req.model, resolution: req.resolution };
        });
    }, created);
}
