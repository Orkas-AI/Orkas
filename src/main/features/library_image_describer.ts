import * as crypto from 'node:crypto';

import { createLogger } from '../logger';
import { chatWithModel } from '../model/client';
import { prompts } from '../prompts/loader';
import { toCompressedGrayJpeg } from '../util/image-transform';

const log = createLogger('library_image_describer');

// Per-image cap for KB / project-library vision summaries. The owning
// indexers enforce a 5min extraction deadline that starts before image
// preprocessing, so vision must settle earlier to leave time for fallback,
// chunking, embedding, and persistence.
const DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_SOURCE_NAME_CHARS = 160;

interface VisionResult {
  ok: boolean;
  text: string;
  error: string;
  aborted?: boolean;
}

export async function describeLibraryImage(
  userId: string,
  sourceName: string,
  raw: Buffer,
  opts: { sessionPrefix?: string } = {},
): Promise<string> {
  const sessionPrefix = opts.sessionPrefix || 'extract-img';
  const cleanName = cleanSourceName(sourceName);
  let compressed: Awaited<ReturnType<typeof toCompressedGrayJpeg>>;
  try {
    compressed = await toCompressedGrayJpeg(raw, { maxDim: 1024, quality: 70, grayscale: true });
  } catch (err) {
    logFallback('prepare', cleanName, 'image_prepare_failed');
    return fallbackDescription(cleanName);
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const timeoutMs = imageDescribeTimeoutMs();
  const safeSessionPrefix = String(sessionPrefix || 'extract-img')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'extract-img';
  const sessionId = `${safeSessionPrefix}-${crypto.randomBytes(4).toString('hex')}`;
  const message = prompts.load('contexts_extract_image', {
    source_name_json: JSON.stringify(cleanName),
  });

  const modelCall: Promise<VisionResult> = chatWithModel({
    userId,
    sessionId,
    message,
    images: [{ data: compressed.buf.toString('base64'), mediaType: 'image/jpeg' }],
    skillList: [],
    idleTimeout: Math.ceil(timeoutMs / 1000),
    abortSignal: controller.signal,
  }).catch((err) => ({
    ok: false,
    text: '',
    error: (err as Error).message || String(err),
    aborted: false,
  }));

  const timeoutCall: Promise<VisionResult> = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        text: '',
        error: 'vision timeout',
        aborted: true,
      });
    }, timeoutMs);
  });

  const result = await Promise.race([modelCall, timeoutCall]);
  if (timer) clearTimeout(timer);

  if (!result.ok) {
    logFallback(
      'describe',
      cleanName,
      result.aborted ? 'image_describe_timeout' : 'image_describe_failed',
    );
    return fallbackDescription(cleanName);
  }
  const text = (result.text || '').trim();
  if (!text) {
    logFallback('describe', cleanName, 'image_describe_empty');
    return fallbackDescription(cleanName);
  }
  return text;
}

function cleanSourceName(sourceName: string): string {
  const flattened = String(sourceName || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  const basename = flattened.split(/[\\/]/).filter(Boolean).pop() || '';
  return basename.slice(0, MAX_SOURCE_NAME_CHARS).trim() || 'image';
}

function imageDescribeTimeoutMs(): number {
  const configured = Math.round(Number(process.env.ORKAS_LIBRARY_IMAGE_DESCRIBE_TIMEOUT_MS));
  if (!Number.isFinite(configured) || configured < 50) return DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS;
  return Math.min(configured, DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS);
}

function logFallback(stage: 'prepare' | 'describe', sourceName: string, errorCode: string): void {
  const sourceRef = crypto.createHash('sha256').update(sourceName).digest('hex').slice(0, 12);
  log.warn('library image description fallback', {
    stage,
    source_ref: sourceRef,
    error_code: errorCode,
  });
}

function fallbackDescription(sourceName: string): string {
  return [
    `# ${sourceName}`,
    '',
    'Image file; automatic visual description is unavailable.',
    `Filename: ${sourceName}`,
  ].join('\n');
}
