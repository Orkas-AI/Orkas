import * as crypto from 'node:crypto';

import { createLogger } from '../logger';
import { prompts } from '../prompts/loader';
import {
  LIBRARY_IMAGE_TRANSFORM_OPTIONS,
  toCompressedJpeg,
} from '../util/image-transform';

const log = createLogger('library_image_describer');

// Per-image cap for KB / project-library vision summaries. The owning
// indexers enforce a 5min extraction deadline that starts before image
// preprocessing, so vision must settle earlier to leave time for status updates,
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
  let compressed: Awaited<ReturnType<typeof toCompressedJpeg>>;
  try {
    compressed = await toCompressedJpeg(raw, LIBRARY_IMAGE_TRANSFORM_OPTIONS);
  } catch (err) {
    logFailure('prepare', cleanName, 'image_prepare_failed');
    throw imageDescriptionError('image_prepare_failed');
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

  // Index/catalog startup must not load the model runtime before an image
  // actually needs description. Include first-use loading in the deadline.
  const modelCall: Promise<VisionResult> = import('../model/client').then(({ chatWithModel }) => chatWithModel({
    userId,
    sessionId,
    message,
    images: [{ data: compressed.buf.toString('base64'), mediaType: 'image/jpeg' }],
    skillList: [],
    // This one-shot vision operation must not receive the default tool set.
    toolList: [],
    requireImageInput: true,
    idleTimeout: Math.ceil(timeoutMs / 1000),
    abortSignal: controller.signal,
  })).catch((err) => ({
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
    logFailure(
      'describe',
      cleanName,
      result.aborted ? 'image_describe_timeout' : 'image_describe_failed',
    );
    throw imageDescriptionError(result.aborted ? 'image_describe_timeout' : 'image_describe_failed');
  }
  const text = (result.text || '').trim();
  if (!text) {
    logFailure('describe', cleanName, 'image_describe_empty');
    throw imageDescriptionError('image_describe_empty');
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

function logFailure(stage: 'prepare' | 'describe', sourceName: string, errorCode: string): void {
  const sourceRef = crypto.createHash('sha256').update(sourceName).digest('hex').slice(0, 12);
  log.warn('library image description failed', {
    stage,
    source_ref: sourceRef,
    error_code: errorCode,
  });
}

/** A failed description is status, never searchable image content. */
function imageDescriptionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
