import { getDeviceId } from './machine_device_id';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { isIP } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { registerUserSwitchHook } from './user-switch-hooks';
import { prepareFeedbackUploadImage } from '../util/image-transform';
import { composeAbortSignal, throwIfAborted } from '../util/abort';
import { logPathRef } from '../util/log-redact';
import { createLogger } from '../logger';
import { killProcessTree } from '../../core-agent/src/sandbox/executor';
import { downloadBinaryWithProxyPolicy } from '../util/proxy-dispatcher';
import { bundledFfmpegPaths } from '../util/bundled-runtime';

import { MEDIA_TRANSFER_POLICY } from '../util/media-transfer-policy';

const log = createLogger('generation-reference-assets');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const MAX_REFERENCE_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const VIDEO_COMPRESS_TRIGGER_BYTES = 8 * 1024 * 1024;
const REFERENCE_TRANSFER_TIMEOUT_MS = MEDIA_TRANSFER_POLICY.transferMs;
const VIDEO_COMPRESS_TIMEOUT_MS = MEDIA_TRANSFER_POLICY.preparationMs;
const PROGRESS_HEARTBEAT_MS = 15 * 1000;

interface GeneratedMediaUrlEntry {
  url: string;
  ownerId: string;
  fileIdentity: string;
  expiresAt: number;
}

const generatedMediaUrls = new Map<string, GeneratedMediaUrlEntry>();

export type GenerationReferenceKind = 'image' | 'video';

export interface PrepareReferenceUrlsInput {
  kind: GenerationReferenceKind;
  urls?: string[];
  paths?: string[];
  maxItems: number;
  pathsFirst?: boolean;
  preserveImageBytes?: boolean;
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
  let cleanUrl = '';
  try {
    cleanUrl = normalizeUrl(url);
  } catch {
    // Provider responses are validated by their owning adapter. A URL that is
    // unsuitable for later reference reuse must not turn a completed
    // generation into a failure; simply make the local file take the upload
    // path next time.
    return;
  }
  const fileIdentity = localFileIdentity(cleanPath);
  if (!cleanPath || !cleanUrl || !fileIdentity) return;
  generatedMediaUrls.delete(cleanPath);
  if (generatedMediaUrls.size >= 256) generatedMediaUrls.delete(generatedMediaUrls.keys().next().value!);
  generatedMediaUrls.set(cleanPath, {
    url: cleanUrl,
    ownerId: currentReferenceOwnerId(),
    fileIdentity,
    expiresAt: referenceUrlExpiry(cleanUrl),
  });
}

export function generatedMediaUrlForPath(absPath: string): string {
  const cleanPath = normalizePath(absPath);
  const entry = generatedMediaUrls.get(cleanPath);
  if (!entry) return '';
  if (
    entry.expiresAt <= Date.now() + MEDIA_TRANSFER_POLICY.transferMs
    || entry.ownerId !== currentReferenceOwnerId()
    || entry.fileIdentity !== localFileIdentity(cleanPath)
  ) {
    generatedMediaUrls.delete(cleanPath);
    return '';
  }
  return entry.url;
}

registerUserSwitchHook('generation-reference-assets', () => {
  generatedMediaUrls.clear();
});

// COS signatures have a structured expiry. Unsigned public URLs retain their
// existing semantics; similarly named application query fields are not expiry.
function referenceUrlExpiry(url: string): number {
  const signedTime = new URL(url).searchParams.get('q-sign-time');
  if (signedTime === null) return Infinity;
  const parts = signedTime.split(';');
  if (parts.length !== 2 || !parts.every(part => /^\d+$/.test(part))) return 0;
  const expiry = Number(parts[1]) * 1000;
  return Number.isSafeInteger(expiry) ? expiry : 0;
}

export async function withReferencePreparation<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const composed = composeAbortSignal(signal, MEDIA_TRANSFER_POLICY.preparationMs, 'Reference preparation timed out');
  try {
    const result = await work(composed.signal);
    throwIfAborted(composed.signal);
    return result;
  } catch (error) {
    if (composed.signal.aborted && !signal?.aborted) throw composed.signal.reason;
    throw error;
  } finally { composed.cleanup(); }
}

export async function prepareReferenceUrls(input: PrepareReferenceUrlsInput): Promise<string[]> {
  return withReferencePreparation(input.signal, signal => prepareReferenceUrlsWithinBudget({ ...input, signal }));
}

async function prepareReferenceUrlsWithinBudget(input: PrepareReferenceUrlsInput): Promise<string[]> {
  const urls = (input.urls || []).map(normalizeUrl).filter(Boolean);
  const paths = (input.paths || []).map(normalizePath).filter(Boolean);
  if (input.preserveImageBytes && urls.some(url => url.startsWith('asset://'))) {
    throw new Error('Reference images require an HTTPS URL or a local image path');
  }
  const out: string[] = [];

  if (!input.pathsFirst) out.push(...urls.slice(0, input.maxItems));

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
      preserveImageBytes: input.preserveImageBytes,
    }));
  }

  if (input.pathsFirst) out.push(...urls.slice(0, Math.max(0, input.maxItems - out.length)));
  throwIfAborted(input.signal);
  return out;
}

export async function loadImageReferenceBuffers(urls: string[] = [], paths: string[] = []): Promise<Buffer[]> {
  return loadImageReferenceBuffersWithProgress(urls, paths);
}

export async function loadImageReferenceBuffersWithProgress(
  urls: string[] = [], paths: string[] = [],
  opts: { signal?: AbortSignal; onProgress?: GenerationReferenceProgressReporter; assertLocalPath?: (file: string) => void } = {},
): Promise<Buffer[]> {
  return withReferencePreparation(opts.signal, signal => loadImageReferenceBuffersWithinBudget(urls, paths, { ...opts, signal }));
}

async function loadImageReferenceBuffersWithinBudget(
  urls: string[] = [],
  paths: string[] = [],
  opts: {
    signal?: AbortSignal;
    onProgress?: GenerationReferenceProgressReporter;
    assertLocalPath?: (file: string) => void;
  } = {},
): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let index = 0;
  const total = urls.filter(Boolean).length + paths.filter(Boolean).length;
  // Validate URLs before I/O, then preserve the public reference-binding order.
  const referenceUrls = urls.map(normalizeUrl).filter(Boolean);
  for (const localPath of paths.map(normalizePath).filter(Boolean)) {
    index += 1;
    throwIfAborted(opts.signal);
    emitProgress(opts.onProgress, 'reference_load', `Loading reference image ${index}/${total}`, {
      kind: 'image',
      index,
      total,
    });
    opts.assertLocalPath?.(localPath);
    const buf = await fs.readFile(localPath, { signal: opts.signal });
    throwIfAborted(opts.signal);
    out.push(buf);
  }
  for (const url of referenceUrls) {
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
    const timeoutMessage = `reference image download timed out after ${Math.round(REFERENCE_TRANSFER_TIMEOUT_MS / 1000)}s`;
    const composed = composeAbortSignal(opts.signal, REFERENCE_TRANSFER_TIMEOUT_MS, timeoutMessage);
    let buf: Buffer;
    try {
      const downloaded = await downloadBinaryWithProxyPolicy(url, {
        label: 'reference image download',
        signal: composed.signal,
        maxBytes: MAX_REFERENCE_DOWNLOAD_BYTES,
        isAllowedDirectAddress: address => isIP(address) !== 0 && !isPrivateReferenceHost(address),
        validateRedirectUrl: isPublicHttpsReferenceUrl,
        validate: (body) => {
          if (!body.length) throw new Error('reference image download returned an empty body');
        },
      });
      buf = downloaded.body;
    } catch (err) {
      if (opts.signal?.aborted) throw new Error('operation aborted');
      if (composed.signal.aborted) throw new Error(timeoutMessage);
      throw err;
    } finally {
      composed.cleanup();
    }
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
    preserveImageBytes?: boolean;
  },
): Promise<string> {
  throwIfAborted(opts.signal);
  emitProgress(opts.onProgress, 'reference_prepare', `Preparing reference ${kind} ${opts.index}/${opts.total}`, {
    kind,
    index: opts.index,
    total: opts.total,
  });
  const prepared = kind === 'image'
    ? await prepareImage(localPath, opts)
    : await prepareVideo(localPath, opts);

  const uploadLimit = kind === 'image' && opts.preserveImageBytes ? 24 * 1024 * 1024 : MAX_UPLOAD_BYTES;
  if (prepared.buf.length > uploadLimit) {
    throw new Error(`${referenceLabel(kind, opts)} exceeds ${uploadLimit / 1024 / 1024}MB after compression`);
  }

  throwIfAborted(opts.signal);
  throw new Error(
    `E_REFERENCE_PUBLIC_URL_REQUIRED: local reference ${kind}s cannot be uploaded by the open build; `
    + 'provide a public HTTPS URL or reuse a generated output that exposes one',
  );
}

async function prepareImage(
  localPath: string,
  opts: { signal?: AbortSignal; preserveImageBytes?: boolean },
): Promise<{ buf: Buffer; mimeType: string; fileName: string }> {
  throwIfAborted(opts.signal);
  if (opts.preserveImageBytes && (await fs.stat(localPath)).size > 24 * 1024 * 1024) throw new Error('Reference image exceeds 24MB');
  const raw = await fs.readFile(localPath, { signal: opts.signal });
  throwIfAborted(opts.signal);
  if (!raw.length) throw new Error(`${referenceLabel('image', opts)} is empty`);
  const mimeType = detectImageMime(raw, localPath);
  if (!mimeType) throw new Error(`unsupported ${referenceLabel('image', opts)} type`);

  if (opts.preserveImageBytes) return { buf: raw, mimeType, fileName: replaceExt(path.basename(localPath), '.' + mimeType.split('/')[1].replace('jpeg', 'jpg')) };
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
  const raw = await fs.readFile(localPath, { signal: opts.signal });
  throwIfAborted(opts.signal);
  if (!raw.length) throw new Error(`${referenceLabel('video', opts)} is empty`);
  const mimeType = detectVideoMime(raw, localPath);
  if (!mimeType) throw new Error(`unsupported ${referenceLabel('video', opts)} type`);

  if (raw.length <= VIDEO_COMPRESS_TRIGGER_BYTES) {
    return { buf: raw, mimeType, fileName: ensureExt(path.basename(localPath), extForVideoMime(mimeType)) };
  }

  const ffmpeg = process.env.FFMPEG_PATH || bundledFfmpegPaths().ffmpeg || 'ffmpeg';
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

const MAX_FFMPEG_STDERR_BYTES = 64 * 1024;

export function runReferenceFfmpegForTest(
  cmd: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    timeoutMs: number;
    onProgress?: (elapsedMs: number) => void;
    maxStderrBytes?: number;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(opts.signal); } catch (err) { reject(err); return; }
    const child = spawn(cmd, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stderrBytes = 0;
    let settled = false;
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const maxStderrBytes = Math.max(1, opts.maxStderrBytes ?? MAX_FFMPEG_STDERR_BYTES);
    const heartbeat = setInterval(() => {
      opts.onProgress?.(Date.now() - started);
    }, PROGRESS_HEARTBEAT_MS);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener?.('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const terminateChild = () => {
      try { killProcessTree(child, 'SIGKILL'); } catch { /* already gone */ }
    };
    const onAbort = () => {
      terminateChild();
      finish(new Error('operation aborted'));
    };
    timeout = setTimeout(() => {
      terminateChild();
      finish(new Error(`ffmpeg timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    timeout.unref?.();
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += data.length;
      if (stderrBytes > maxStderrBytes) {
        terminateChild();
        finish(new Error(`ffmpeg stderr exceeded ${maxStderrBytes} bytes`));
        return;
      }
      stderr += data.toString('utf8');
    });
    child.on('error', (err) => finish(new Error(`ffmpeg failed${errorCodeSuffix(err)}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg exited ${code}${stderr ? ' with stderr' : ''}`));
    });
  });
}

const runFfmpeg = runReferenceFfmpegForTest;

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

function isPublicHttpsReferenceUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !isPrivateReferenceHost(url.hostname);
}

function normalizeUrl(value?: string): string {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^asset:\/\//i.test(s)) {
    try {
      const parsed = new URL(s);
      if (parsed.protocol === 'asset:' && !parsed.username && !parsed.password && parsed.hostname) return s;
    } catch { /* rejected below */ }
    throw new Error('reference URL must be an HTTPS public URL or asset:// provider URL');
  }
  try {
    const parsed = new URL(s);
    if (isPublicHttpsReferenceUrl(parsed)) {
      return s;
    }
  } catch { /* rejected below */ }
  throw new Error('reference URL must be an HTTPS public URL or asset:// provider URL');
}

export function localFileIdentity(absPath: string): string {
  if (!absPath) return '';
  try {
    const stat = fsSync.statSync(absPath, { bigint: true });
    if (!stat.isFile()) return '';
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return '';
  }
}

function currentReferenceOwnerId(): string {
  return getDeviceId();
}

function isPrivateReferenceHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateReferenceIpv4(host);
  if (ipVersion === 6) {
    // WHATWG URL rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the
    // mapped address arrives as two hex groups. Judge the IPv4 it carries.
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      if (mapped[1]) return isPrivateReferenceIpv4(mapped[1]);
      const high = parseInt(mapped[2], 16);
      const low = parseInt(mapped[3], 16);
      return isPrivateReferenceIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return host === '::'
      || host === '::1'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function isPrivateReferenceIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isLoopbackReferenceHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
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
