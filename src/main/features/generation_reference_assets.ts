import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { accountApiBase, tokenStore } from './connectors/_server_bridge';
import { prepareFeedbackUploadImage } from '../util/image-transform';
import { fetchWithTimeout, throwIfAborted } from '../util/abort';
import { logPathRef } from '../util/log-redact';
import { createLogger } from '../logger';

const log = createLogger('generation-reference-assets');

const TEMP_REFERENCE_URL_EXPIRES = 6 * 60 * 60;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const VIDEO_COMPRESS_TRIGGER_BYTES = 8 * 1024 * 1024;
const REFERENCE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const VIDEO_COMPRESS_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_HEARTBEAT_MS = 15 * 1000;

const generatedMediaUrls = new Map<string, string>();

export type GenerationReferenceKind = 'image' | 'video';

export interface PrepareReferenceUrlsInput {
  kind: GenerationReferenceKind;
  urls?: string[];
  paths?: string[];
  maxItems: number;
  signal?: AbortSignal;
  onProgress?: GenerationReferenceProgressReporter;
}

export type GenerationReferenceProgressReporter = (event: {
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}) => void;

export function registerGeneratedMediaUrl(absPath: string, url?: string): void {
  const cleanPath = normalizePath(absPath);
  const cleanUrl = normalizeUrl(url);
  if (!cleanPath || !cleanUrl) return;
  generatedMediaUrls.set(cleanPath, cleanUrl);
}

export function generatedMediaUrlForPath(absPath: string): string {
  return generatedMediaUrls.get(normalizePath(absPath)) || '';
}

export async function prepareReferenceUrls(input: PrepareReferenceUrlsInput): Promise<string[]> {
  const urls = (input.urls || []).map(normalizeUrl).filter(Boolean);
  const paths = (input.paths || []).map(normalizePath).filter(Boolean);
  const out: string[] = [];

  for (const url of urls) {
    if (out.length >= input.maxItems) break;
    out.push(url);
  }

  let localIndex = 0;
  for (const localPath of paths) {
    localIndex += 1;
    if (out.length >= input.maxItems) break;
    throwIfAborted(input.signal);
    const known = generatedMediaUrlForPath(localPath);
    if (known) {
      emitProgress(input.onProgress, 'reference_reuse', `Reusing generated reference ${input.kind} ${localIndex}/${paths.length}`, {
        kind: input.kind,
        index: localIndex,
        total: paths.length,
      });
      out.push(known);
      continue;
    }
    out.push(await compressAndUploadReference(input.kind, localPath, {
      signal: input.signal,
      onProgress: input.onProgress,
      index: localIndex,
      total: paths.length,
    }));
  }

  return out;
}

export async function loadImageReferenceBuffers(urls: string[] = [], paths: string[] = []): Promise<Buffer[]> {
  return loadImageReferenceBuffersWithProgress(urls, paths);
}

export async function loadImageReferenceBuffersWithProgress(
  urls: string[] = [],
  paths: string[] = [],
  opts: {
    signal?: AbortSignal;
    onProgress?: GenerationReferenceProgressReporter;
  } = {},
): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let index = 0;
  const total = urls.filter(Boolean).length + paths.filter(Boolean).length;
  for (const url of urls.map(normalizeUrl).filter(Boolean)) {
    index += 1;
    throwIfAborted(opts.signal);
    if (url.toLowerCase().startsWith('asset://')) {
      throw new Error('asset:// reference images are only supported by URL-based video generation; use an HTTPS image URL or a local image path for generate_image');
    }
    emitProgress(opts.onProgress, 'reference_download', `Downloading reference image ${index}/${total}`, {
      kind: 'image',
      index,
      total,
    });
    const resp = await fetchWithTimeout(
      url,
      { method: 'GET' },
      REFERENCE_UPLOAD_TIMEOUT_MS,
      opts.signal,
      `reference image download timed out after ${Math.round(REFERENCE_UPLOAD_TIMEOUT_MS / 1000)}s`,
    );
    if (!resp.ok) throw new Error(`reference image download failed ${resp.status}: ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    throwIfAborted(opts.signal);
    out.push(buf);
  }
  for (const localPath of paths.map(normalizePath).filter(Boolean)) {
    index += 1;
    throwIfAborted(opts.signal);
    emitProgress(opts.onProgress, 'reference_load', `Loading reference image ${index}/${total}`, {
      kind: 'image',
      index,
      total,
    });
    const buf = await fs.readFile(localPath);
    throwIfAborted(opts.signal);
    out.push(buf);
  }
  return out;
}

async function compressAndUploadReference(
  kind: GenerationReferenceKind,
  localPath: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: GenerationReferenceProgressReporter;
    index: number;
    total: number;
  },
): Promise<string> {
  const headers = tokenStore.authHeaders();
  if (!headers.user_id || !headers.session_id) {
    throw new Error(`Orkas sign-in required to upload local reference ${kind}s to COS temp`);
  }

  throwIfAborted(opts.signal);
  emitProgress(opts.onProgress, 'reference_prepare', `Preparing reference ${kind} ${opts.index}/${opts.total}`, {
    kind,
    index: opts.index,
    total: opts.total,
  });
  const prepared = kind === 'image'
    ? await prepareImage(localPath, opts)
    : await prepareVideo(localPath, opts);

  if (prepared.buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`${referenceLabel(kind, opts)} exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB after compression`);
  }

  throwIfAborted(opts.signal);
  emitProgress(opts.onProgress, 'reference_upload', `Uploading reference ${kind} ${opts.index}/${opts.total}`, {
    kind,
    index: opts.index,
    total: opts.total,
    bytes: prepared.buf.length,
  });
  const form = new FormData();
  form.append('type', 'temp');
  form.append('file_dir', kind);
  form.append('signed_url', 'true');
  form.append('signed_url_expires', String(TEMP_REFERENCE_URL_EXPIRES));
  form.append('file', new Blob([new Uint8Array(prepared.buf)], { type: prepared.mimeType }), prepared.fileName);

  const res = await fetchWithTimeout(
    `${accountApiBase()}/file/upload`,
    { method: 'POST', headers, body: form },
    REFERENCE_UPLOAD_TIMEOUT_MS,
    opts.signal,
    `COS temp ${kind} upload timed out after ${Math.round(REFERENCE_UPLOAD_TIMEOUT_MS / 1000)}s`,
  );
  let json: any = {};
  try { json = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok || json?.code !== 0 || !json?.signed_url) {
    throw new Error(json?.msg || `COS temp ${kind} upload failed: HTTP ${res.status}`);
  }
  emitProgress(opts.onProgress, 'reference_uploaded', `Reference ${kind} ${opts.index}/${opts.total} uploaded`, {
    kind,
    index: opts.index,
    total: opts.total,
  });
  return String(json.signed_url);
}

async function prepareImage(
  localPath: string,
  opts: { signal?: AbortSignal },
): Promise<{ buf: Buffer; mimeType: string; fileName: string }> {
  throwIfAborted(opts.signal);
  const raw = await fs.readFile(localPath);
  throwIfAborted(opts.signal);
  if (!raw.length) throw new Error(`${referenceLabel('image', opts)} is empty`);
  const mimeType = detectImageMime(raw, localPath);
  if (!mimeType) throw new Error(`unsupported ${referenceLabel('image', opts)} type`);

  const image = await prepareFeedbackUploadImage(raw, {
    fileName: path.basename(localPath),
    mimeType,
    maxBytes: IMAGE_MAX_BYTES,
    maxDim: 2048,
    compressTriggerBytes: 0,
  });
  return { buf: image.buf, mimeType: image.mimeType, fileName: image.fileName };
}

async function prepareVideo(
  localPath: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: GenerationReferenceProgressReporter;
    index: number;
    total: number;
  },
): Promise<{ buf: Buffer; mimeType: string; fileName: string }> {
  throwIfAborted(opts.signal);
  const raw = await fs.readFile(localPath);
  throwIfAborted(opts.signal);
  if (!raw.length) throw new Error(`${referenceLabel('video', opts)} is empty`);
  const mimeType = detectVideoMime(raw, localPath);
  if (!mimeType) throw new Error(`unsupported ${referenceLabel('video', opts)} type`);

  if (raw.length <= VIDEO_COMPRESS_TRIGGER_BYTES) {
    return { buf: raw, mimeType, fileName: ensureExt(path.basename(localPath), extForVideoMime(mimeType)) };
  }

  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-ref-video-'));
  const outPath = path.join(tmpDir, 'reference.mp4');
  try {
    emitProgress(opts.onProgress, 'reference_compress', `Compressing reference video ${opts.index}/${opts.total}`, {
      kind: 'video',
      index: opts.index,
      total: opts.total,
      bytes: raw.length,
    });
    await runFfmpeg(ffmpeg, [
      '-y',
      '-i', localPath,
      '-vf', 'fps=24',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outPath,
    ], {
      signal: opts.signal,
      timeoutMs: VIDEO_COMPRESS_TIMEOUT_MS,
      onProgress: (elapsedMs) => emitProgress(opts.onProgress, 'reference_compress', `Compressing reference video ${opts.index}/${opts.total} (${Math.round(elapsedMs / 1000)}s)`, {
        kind: 'video',
        index: opts.index,
        total: opts.total,
        elapsedMs,
      }),
    });
    const compressed = await fs.readFile(outPath);
    if (compressed.length && compressed.length < raw.length) {
      return { buf: compressed, mimeType: 'video/mp4', fileName: replaceExt(path.basename(localPath), '.mp4') };
    }
  } catch (err) {
    if (opts.signal?.aborted || /operation aborted/i.test((err as Error).message || String(err))) {
      throw err;
    }
    log.warn('reference video compression failed', {
      file: logPathRef(localPath),
      error: errorCodeRef(err),
    });
    if (raw.length > MAX_UPLOAD_BYTES) {
      throw new Error(`${referenceLabel('video', opts)} needs compression but ffmpeg failed or is unavailable`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { buf: raw, mimeType, fileName: ensureExt(path.basename(localPath), extForVideoMime(mimeType)) };
}

function runFfmpeg(
  cmd: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    timeoutMs: number;
    onProgress?: (elapsedMs: number) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(opts.signal); } catch (err) { reject(err); return; }
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = setInterval(() => {
      opts.onProgress?.(Date.now() - started);
    }, PROGRESS_HEARTBEAT_MS);
    const terminateChild = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 10_000).unref?.();
    };
    const onAbort = () => {
      finish(new Error('operation aborted'));
      terminateChild();
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener?.('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    timeout = setTimeout(() => {
      finish(new Error(`ffmpeg timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
      terminateChild();
    }, opts.timeoutMs);
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', (err) => finish(new Error(`ffmpeg failed${errorCodeSuffix(err)}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg exited ${code}${stderr ? ' with stderr' : ''}`));
    });
  });
}

function referenceLabel(
  kind: GenerationReferenceKind,
  opts?: { signal?: AbortSignal; index?: number; total?: number },
): string {
  const index = Number(opts?.index || 0);
  const total = Number(opts?.total || 0);
  return index > 0 && total > 0
    ? `reference ${kind} ${index}/${total}`
    : `reference ${kind}`;
}

function errorCodeRef(err: unknown): Record<string, unknown> {
  const e = err as NodeJS.ErrnoException;
  return {
    name: e?.name ? String(e.name) : undefined,
    code: e?.code ? String(e.code) : undefined,
  };
}

function errorCodeSuffix(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ? ` (${e.code})` : '';
}

function emitProgress(
  onProgress: GenerationReferenceProgressReporter | undefined,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  onProgress?.({ phase, message, ...(data ? { data } : {}) });
}

function normalizePath(value?: string): string {
  const s = String(value || '').trim();
  return s ? path.resolve(s) : '';
}

function normalizeUrl(value?: string): string {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^(https?:|asset:)/i.test(s)) return s;
  return '';
}

function detectImageMime(buf: Buffer, fileName = ''): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function detectVideoMime(buf: Buffer, fileName = ''): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

function extForVideoMime(mimeType: string): string {
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType === 'video/quicktime') return '.mov';
  return '.mp4';
}

function replaceExt(fileName: string, ext: string): string {
  const base = fileName.replace(/\.[^.]*$/, '') || 'reference';
  return `${base}${ext}`;
}

function ensureExt(fileName: string, ext: string): string {
  return /\.[^.]+$/.test(fileName) ? fileName : `${fileName}${ext}`;
}
