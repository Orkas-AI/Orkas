import * as crypto from 'node:crypto';

import { createLogger } from '../logger';
import { chatWithModel } from '../model/client';
import { prompts } from '../prompts/loader';
import { toCompressedGrayJpeg } from '../util/image-transform';

const log = createLogger('library_image_describer');

// Per-image cap for KB / project-library vision summaries. This is not an
// interactive chat turn, but slow model routing can exceed two minutes; 5min
// avoids premature fallback while keeping a bad image from stalling a whole
// indexing batch for too long.
const IMAGE_DESCRIBE_TIMEOUT_MS = 5 * 60 * 1000;
const IMAGE_DESCRIBE_IDLE_TIMEOUT_SEC = Math.ceil(IMAGE_DESCRIBE_TIMEOUT_MS / 1000);

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
    log.warn(`prepare ${cleanName}: ${(err as Error).message}; using fallback`);
    return fallbackDescription(cleanName);
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const sessionId = `${sessionPrefix}-${crypto.randomBytes(4).toString('hex')}`;
  const message = prompts.load('contexts_extract_image', { source_name: cleanName });

  const modelCall: Promise<VisionResult> = chatWithModel({
    userId,
    sessionId,
    message,
    images: [{ data: compressed.buf.toString('base64'), mediaType: 'image/jpeg' }],
    skillList: [],
    idleTimeout: IMAGE_DESCRIBE_IDLE_TIMEOUT_SEC,
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
        error: `vision timeout after ${Math.round(IMAGE_DESCRIBE_TIMEOUT_MS / 1000)}s`,
        aborted: true,
      });
    }, IMAGE_DESCRIBE_TIMEOUT_MS);
  });

  const result = await Promise.race([modelCall, timeoutCall]);
  if (timer) clearTimeout(timer);

  if (!result.ok) {
    log.warn(`describe ${cleanName}: ${result.error || 'unknown error'}; using fallback`);
    return fallbackDescription(cleanName);
  }
  const text = (result.text || '').trim();
  if (!text) {
    log.warn(`describe ${cleanName}: empty response; using fallback`);
    return fallbackDescription(cleanName);
  }
  return text;
}

function cleanSourceName(sourceName: string): string {
  const s = String(sourceName || '').replace(/[\r\n]+/g, ' ').trim();
  return s || 'image';
}

function fallbackDescription(sourceName: string): string {
  return [
    `# ${sourceName}`,
    '',
    'Image file; automatic visual description is unavailable.',
    `Filename: ${sourceName}`,
  ].join('\n');
}
