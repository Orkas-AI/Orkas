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
import { prepareReferenceUrls, registerGeneratedMediaUrl } from './generation_reference_assets';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { composeAbortSignal, fetchAndReadWithTimeout, throwIfAborted } from '../util/abort';
import { downloadBinaryWithProxyPolicy } from '../util/proxy-dispatcher';
import { logErrorSummary, logPathRef } from '../util/log-redact';
import { sanitizeLogTextForUpload } from '../util/log-sanitize';

const log = createLogger('video-gen');
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const CREATE_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_CONSECUTIVE_POLL_TIMEOUTS = 5;

const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com';
const MINIMAX_BASE = 'https://api.minimax.io';
const VIDU_BASE = 'https://api.vidu.com';
const KLING_BASE = 'https://api-singapore.klingai.com';
const GOOGLE_VIDEO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const VIDEO_CREATE_HTTP_TIMEOUT_MS = 130 * 1000;
const VIDEO_POLL_HTTP_TIMEOUT_MS = 20 * 1000;


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
    .filter((profile) => isVideoProviderModelAllowed(profile.provider, profile.model))
    .map((entry) => ({ entry }));
}
export function pickVideoGenProfile(): PickedVideoGenProfile | null {
  return listVideoGenCandidates()[0] || null;
}
function videoGenCandidatesForCall(): PickedVideoGenProfile[] {
  return listVideoGenCandidates();
}


interface NormalizedVideoInput {
  prompt: string;
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
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

export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
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

  const candidates = videoGenCandidatesForCall();
  if (!candidates.length) {
    log.warn('video gen aborted: no video profile configured');
    return { ok: false, errorCode: 'NO_CAPABLE_MODEL', message: t('video_gen.no_capable_model'), dispatched: false };
  }

  // Preserve unsupported raw arguments before generic normalization/upload.
  // Do not bill another configured service for an invalid selected request.
  const firstInputError = candidates[0].entry.provider === 'kling' ? klingVideoInputError(input) : null;
  if (firstInputError) return { ok: false, errorCode: 'BAD_INPUT', message: firstInputError, dispatched: false };

  let normalized: NormalizedVideoInput;
  try {
    const refCount = (input.referenceImagePaths?.length || 0)
      + (input.referenceVideoPaths?.length || 0)
      + (input.referenceImageUrls?.length || 0)
      + (input.referenceVideoUrls?.length || 0);
    if (refCount) {
      emitProgress(input.onProgress, 'prepare_references', 'Preparing video references', { count: refCount });
    }
    const refs = await resolveReferenceUrls(input);
    normalized = normalizeVideoInput({
      ...input,
      referenceImageUrls: refs.referenceImageUrls,
      referenceVideoUrls: refs.referenceVideoUrls,
    });
  } catch (err) {
    // Reference preparation failed before any generation request was sent.
    const message = (err as Error).message || String(err);
    const safeMessage = sanitizeLogTextForUpload(message);
    // No generation request has left yet, so nothing billable happened.
    return { ok: false, errorCode: 'BAD_INPUT', message: safeMessage, dispatched: false };
  }

  let lastProviderError = '';
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const inputError = candidate.entry.provider === 'kling' ? klingVideoInputError(input) : null;
    if (inputError) return { ok: false, errorCode: 'BAD_INPUT', message: inputError, ...(i === 0 ? { dispatched: false as const } : {}) };
    let adapterRes: AdapterVideoResult;
    let requestDisposition: 'sent' | 'accepted' | 'rejected' | undefined;
    let acceptedTaskId: string | undefined;
    try {
      adapterRes = await dispatchVideo({
        ...normalized,
        apiKey: candidate.entry.apiKey,
        model: candidate.entry.model,
        ...(candidate.entry.provider === 'kling' ? { ratioExplicit: input.ratio !== undefined, duration: input.duration ?? normalized.duration } : {}),
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
          errorCode: input.signal?.aborted ? 'BAD_INPUT' : lastProviderError.includes('timed out') ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
          message: 'Video task tracking stopped after a generation request was sent. The task or charge status may be unknown.',
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
      const suffix = i < candidates.length - 1 ? '; trying next provider' : '';
      log.warn(`video gen API call failed (${candidate.entry.provider}/${candidate.entry.model})${suffix}`, {
        error: logErrorSummary(err),
      });
      continue;
    }

    const selectedModel = adapterRes.model || candidate.entry.model;
    const finalPath = ensureMp4Extension(input.outputAbsPath);
    try {
      emitProgress(input.onProgress, 'save', 'Saving generated video', { provider: candidate.entry.provider });
      throwIfAborted(input.signal);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, adapterRes.buffer);
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

    registerGeneratedMediaUrl(finalPath, adapterRes.videoUrl);
    log.info('video generated', {
      provider: candidate.entry.provider,
      model: selectedModel,
      taskId: adapterRes.taskId,
      path: logPathRef(finalPath),
      bytes: adapterRes.buffer.length,
    });
    return {
      ok: true,
      path: finalPath,
      bytes: adapterRes.buffer.length,
      provider: candidate.entry.provider,
      model: selectedModel,
      taskId: adapterRes.taskId,
      videoUrl: adapterRes.videoUrl,
      status: adapterRes.status,
      ...(adapterRes.ratio ? { ratio: adapterRes.ratio } : {}),
      ...(typeof adapterRes.duration === 'number' ? { duration: adapterRes.duration } : {}),
      ...(adapterRes.resolution ? { resolution: adapterRes.resolution } : {}),
    };
  }

  return {
    ok: false,
    errorCode: lastProviderError.includes('timed out') ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
    message: sanitizeLogTextForUpload(lastProviderError || 'video generation failed'),
  };
}

export const video_gen = generateVideo;

async function resolveReferenceUrls(input: GenerateVideoInput): Promise<{
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
}> {
  const referenceImageUrls = await prepareReferenceUrls({
    kind: 'image',
    urls: input.referenceImageUrls,
    paths: input.referenceImagePaths,
    maxItems: 9,
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const referenceVideoUrls = await prepareReferenceUrls({
    kind: 'video',
    urls: input.referenceVideoUrls,
    paths: input.referenceVideoPaths,
    maxItems: 3,
    signal: input.signal,
    onProgress: input.onProgress,
  });
  if ([...referenceImageUrls, ...referenceVideoUrls].some((url) => !/^https:\/\//i.test(url))) {
    throw new Error('Orkas API video references must use public HTTPS URLs');
  }
  return { referenceImageUrls, referenceVideoUrls };
}

async function dispatchVideo(req: AdapterVideoRequest, provider: string): Promise<AdapterVideoResult> {
  if (provider === ORKAS_API_PROVIDER) {
    return callOrkasApiVideo({ ...req, quality: req.quality === 'quality' ? 'quality' : 'balanced' });
  }

  if (provider === 'doubao') req = normalizeDoubaoVideoRequest(req);
  emitProgress(
    req.onProgress,
    'configuration',
    `Video configuration: ${provider}/${videoModelDisplayName(req.model)}, ${req.resolution}, ${req.duration}s, `
      + `${req.generateAudio ? 'audio requested' : 'silent'}; user API key, 0 Orkas credits/second`,
    {
      provider,
      model: req.model,
      duration: req.duration,
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
    if (['failed', 'cancelled', 'canceled'].includes(status)) {
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

function ensureMp4Extension(value: string): string {
  const extension = path.extname(value);
  if (extension.toLowerCase() === '.mp4') return value;
  return extension ? `${value.slice(0, -extension.length)}.mp4` : `${value}.mp4`;
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
  const imageCount = (input.referenceImageUrls?.length || 0) + (input.referenceImagePaths?.length || 0);
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
  if (creation) req.onRequestDisposition?.('sent');
  const { body } = await fetchAndReadWithTimeout(url, init, timeoutMs, req.signal, timeoutMessage, response => {
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
  if (!response.ok) throw new Error(`${label} API ${response.status}`);
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

function normalizeVideoInput(input: GenerateVideoInput): NormalizedVideoInput {
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
  const supports1080p = !['doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini', 'doubao-seedance-2-0-mini-260615'].includes(req.model);
  return req.resolution === '1080p' && !supports1080p ? { ...req, resolution: '720p' } : req;
}

export async function callDoubaoVideo(req: AdapterVideoRequest): Promise<AdapterVideoResult> {
  throwIfAborted(req.signal);
  req = normalizeDoubaoVideoRequest(req);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
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
    // Pin only the outgoing Mini ID; keep saved profiles and result identity.
    // https://docs.volcengine.com/docs/ark/seedance-2-5?lang=en
    model: req.model === 'doubao-seedance-2-0-mini' ? 'doubao-seedance-2-0-mini-260615' : req.model,
    content,
    ratio: req.ratio,
    duration: req.duration,
    resolution: req.resolution,
    generate_audio: req.generateAudio,
    watermark: req.watermark,
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
  let consecutivePollTimeouts = 0;
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
      consecutivePollTimeouts = 0;
      emitProgress(req.onProgress, 'poll_result', `Video task poll ${pollAttempt}: ${formatVideoStatus(status)} after ${Math.round((Date.now() - started) / 1000)}s`, {
        provider: 'doubao',
        taskId,
        attempt: pollAttempt,
        status: status || 'processing',
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      if (req.signal?.aborted || !isVideoPollTimeoutError(err)) throw err;
      consecutivePollTimeouts += 1;
      if (consecutivePollTimeouts >= MAX_CONSECUTIVE_POLL_TIMEOUTS) {
        throw new Error(`DouBao video status polling stopped: the connection timed out ${consecutivePollTimeouts} times in a row (task ${taskId}). The network looks persistently interrupted — stopped instead of retrying silently until the overall timeout.`);
      }
      emitProgress(req.onProgress, 'poll_timeout', `Video status poll timed out; retrying (${consecutivePollTimeouts}/${MAX_CONSECUTIVE_POLL_TIMEOUTS})`, {
        provider: 'doubao',
        taskId,
        attempt: pollAttempt,
        retry: consecutivePollTimeouts,
        maxRetry: MAX_CONSECUTIVE_POLL_TIMEOUTS,
        elapsedMs: Date.now() - started,
        error: errorMessage(err),
      });
      continue;
    }
    if (['failed', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`DouBao video task ${taskId} ${status}: ${truncate(JSON.stringify((last as any)?.error || last), 500)}`);
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
  if (req.referenceImageUrls[0]) createBody.first_frame_image = req.referenceImageUrls[0];
  const created = await requestJson(
    `${MINIMAX_BASE}/v1/video_generation`,
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
      `${MINIMAX_BASE}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
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
        `${MINIMAX_BASE}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
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
  const firstImage = req.referenceImageUrls[0];
  const endpoint = firstImage ? 'img2video' : 'text2video';
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
  if (firstImage) createBody.images = [firstImage];
  else createBody.aspect_ratio = normalizeChoice(req.ratio, ['16:9', '9:16', '1:1', '4:3', '3:4'], '16:9');
  const created = await requestJson(
    `${VIDU_BASE}/ent/v2/${endpoint}`,
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
      `${VIDU_BASE}/ent/v2/tasks/${encodeURIComponent(taskId)}/creations`,
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
  throwIfAborted(req.signal);
  const inputError = klingVideoInputError({ ...req, outputAbsPath: '' });
  if (inputError) throw new Error(inputError);
  const firstImage = req.referenceImageUrls[0];
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
    `${KLING_BASE}/${endpoint}/kling-3.0-turbo`,
    { method: 'POST', headers, body: JSON.stringify(createBody) },
    req,
    'Kling video create',
  );
  const taskId = typeof created?.data?.id === 'string' ? created.data.id.trim() : '';
  if (!taskId) throw new Error('Kling video create returned no native task id.');
  emitProgress(req.onProgress, 'task_created', `Kling video task created: ${taskId}`, { provider: 'kling', taskId });
  const started = Date.now();
  let consecutivePollTimeouts = 0;
  try {
    while (Date.now() - started < req.timeoutMs) {
      await sleep(req.pollIntervalMs, req.signal);
      let queried: any;
      try {
        queried = await requestKlingJson(`${KLING_BASE}/tasks?${new URLSearchParams({ task_ids: taskId })}`, { method: 'GET', headers }, req, 'Kling video query');
        consecutivePollTimeouts = 0;
      } catch (err) {
        if (req.signal?.aborted || !isVideoPollTimeoutError(err)) throw err;
        if (++consecutivePollTimeouts >= MAX_CONSECUTIVE_POLL_TIMEOUTS) throw err;
        emitProgress(req.onProgress, 'poll_timeout', 'Kling task status request timed out; retrying the same task query', { provider: 'kling', taskId, retry: consecutivePollTimeouts });
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
  const firstImage = req.referenceImageUrls[0];
  const endpoint = firstImage ? 'image_to_video' : 'text_to_video';
  const duration = nearestChoice(req.duration, [5, 10]);
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
  return ({
    'doubao-seedance-2-0-260128': 'Seedance 2.0',
    'doubao-seedance-2-0-fast-260128': 'Seedance 2.0 Fast',
    'doubao-seedance-2-0-mini': 'Seedance 2.0 Mini',
    'server-managed': 'Server managed',
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
  return /\b(timed out|timeout)\b/i.test(errorMessage(err));
}
