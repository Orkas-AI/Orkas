/** Video generation through the API-key authenticated Orkas public API. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { loadVideoProfiles } from './auth';
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

interface NormalizedVideoInput {
  prompt: string;
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  operation: 'generate' | 'edit';
  ratio: string;
  duration: number;
  resolution: string;
  quality: 'balanced' | 'quality';
  generateAudio: boolean;
  seed?: number;
  pollIntervalMs: number;
  timeoutMs: number;
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
    if (!input.prompt?.trim()) return { ok: false, errorCode: 'BAD_INPUT', message: 'prompt is required' };
    if (!input.outputAbsPath) return { ok: false, errorCode: 'BAD_INPUT', message: 'outputAbsPath is required' };

    const profile = loadVideoProfiles().find((candidate) => (
      candidate.provider === ORKAS_API_PROVIDER && candidate.model === ORKAS_API_VIDEO_MODEL
    ));
    if (!profile) {
      return { ok: false, errorCode: 'NO_CAPABLE_MODEL', message: t('video_gen.no_capable_model') };
    }

    let normalized: NormalizedVideoInput;
    try {
      const refs = await resolveReferenceUrls(input);
      normalized = normalizeVideoInput({
        ...input,
        referenceImageUrls: refs.referenceImageUrls,
        referenceVideoUrls: refs.referenceVideoUrls,
      });
    } catch (err) {
      return {
        ok: false,
        errorCode: 'BAD_INPUT',
        message: sanitizeLogTextForUpload((err as Error).message || String(err)),
      };
    }
    const generated = await callOrkasApiVideo({
      ...normalized,
      apiKey: profile.apiKey,
      signal: input.signal,
      onProgress: input.onProgress,
      ...(input.usageContext ? { usageContext: input.usageContext } : {}),
    });

    const finalPath = ensureMp4Extension(input.outputAbsPath);
    try {
      throwIfAborted(input.signal);
      emitProgress(input.onProgress, 'save', 'Saving generated video');
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, generated.buffer);
    } catch (err) {
      log.error('video write failed after provider completed', {
        task_id: generated.taskId,
        path: logPathRef(finalPath),
        error: logErrorSummary(err),
      });
      return {
        ok: false,
        errorCode: 'IO_ERROR',
        message: sanitizeLogTextForUpload(
          `The provider completed this potentially billable video, but it could not be saved locally. Do not retry automatically. ${(err as Error).message}`,
        ),
        taskId: generated.taskId,
        postDispatch: true,
      };
    }

    registerGeneratedMediaUrl(finalPath, generated.videoUrl);
    return {
      ok: true,
      path: finalPath,
      bytes: generated.buffer.length,
      provider: ORKAS_API_PROVIDER,
      model: ORKAS_API_VIDEO_MODEL,
      taskId: generated.taskId,
      videoUrl: generated.videoUrl,
      status: generated.status,
      ...(generated.ratio ? { ratio: generated.ratio } : {}),
      ...(typeof generated.duration === 'number' ? { duration: generated.duration } : {}),
      ...(generated.resolution ? { resolution: generated.resolution } : {}),
    };
  } catch (err) {
    const message = sanitizeLogTextForUpload((err as Error).message || String(err));
    if (err instanceof VideoDeliveryError) {
      return {
        ok: false,
        errorCode: 'DELIVERY_ERROR',
        message,
        taskId: err.taskId,
        postDispatch: true,
      };
    }
    if (err instanceof OrkasApiQuotaError) {
      return { ok: false, errorCode: 'CREDITS_EXHAUSTED', message };
    }
    if (input.signal?.aborted || /operation aborted/i.test(message)) {
      return { ok: false, errorCode: 'BAD_INPUT', message };
    }
    return {
      ok: false,
      errorCode: /timed out|timeout/i.test(message) ? 'TIMEOUT' : 'PROVIDER_API_ERROR',
      message,
    };
  }
}

export const video_gen = generateVideo;

async function resolveReferenceUrls(input: GenerateVideoInput): Promise<{
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
}> {
  const count = (input.referenceImageUrls?.length || 0)
    + (input.referenceImagePaths?.length || 0)
    + (input.referenceVideoUrls?.length || 0)
    + (input.referenceVideoPaths?.length || 0);
  if (count) emitProgress(input.onProgress, 'prepare_references', 'Preparing video references', { count });
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

function normalizeVideoInput(input: GenerateVideoInput): NormalizedVideoInput {
  const operation = input.operation === 'edit' ? 'edit' : 'generate';
  const referenceVideoUrls = (input.referenceVideoUrls || []).slice(0, 3);
  if (operation === 'edit' && referenceVideoUrls.length < 1) {
    throw new Error('operation=edit requires at least one reference video');
  }
  return {
    prompt: input.prompt.trim(),
    referenceImageUrls: (input.referenceImageUrls || []).slice(0, 9),
    referenceVideoUrls,
    operation,
    ratio: choice(input.ratio, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'),
    duration: integer(input.duration, 5, 4, 15),
    resolution: choice(input.resolution, ['480p', '720p', '1080p'], '720p'),
    quality: input.quality === 'quality' ? 'quality' : 'balanced',
    generateAudio: input.generateAudio !== false,
    ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { seed: Math.trunc(input.seed) } : {}),
    pollIntervalMs: integer(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1_000, 30_000),
    timeoutMs: integer(input.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000, DEFAULT_TIMEOUT_MS),
  };
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
): Promise<Buffer> {
  emitProgress(onProgress, 'download', 'Downloading generated video');
  const timeout = composeAbortSignal(signal, DOWNLOAD_TIMEOUT_MS, 'video download timed out');
  try {
    const result = await downloadBinaryWithProxyPolicy(url, {
      label: 'Orkas API generated video download',
      signal: timeout.signal,
      maxBytes: 512 * 1024 * 1024,
      validate: validateDownloadedVideo,
    });
    emitProgress(onProgress, 'download_done', `Video download complete: ${result.body.length} bytes`);
    return result.body;
  } catch (err) {
    throw new VideoDeliveryError(
      `The provider completed task ${taskId}, but the generated video could not be downloaded after bounded retries. Do not submit another generation task. ${(err as Error).message}`,
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
    const boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    if (boxType === 'ftyp' && boxSize >= 16 && offset + boxSize <= buffer.length) return;
    if (boxSize < 8 || offset + boxSize > scanLimit) break;
    offset += boxSize;
  }
  throw new Error('video download returned invalid or unsupported MP4 bytes');
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function choice(value: unknown, allowed: string[], fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return allowed.includes(normalized) ? normalized : fallback;
}

function ensureMp4Extension(value: string): string {
  const extension = path.extname(value);
  if (extension.toLowerCase() === '.mp4') return value;
  return extension ? `${value.slice(0, -extension.length)}.mp4` : `${value}.mp4`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('operation aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function emitProgress(
  onProgress: VideoProgressReporter | undefined,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  onProgress?.({ phase, message, ...(data ? { data } : {}) });
}
