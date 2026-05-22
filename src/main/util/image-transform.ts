/**
 * Shared image preprocessing utilities for main/.
 *
 * Knowledge-base indexing uses the grayscale JPEG path because vision input
 * only needs text/shapes/layout. User feedback keeps color and only compresses
 * upload payloads when doing so is useful.
 */

export interface ImageTransformOpts {
  /** Long-edge pixel cap. Default 1024. */
  maxDim?: number;
  /** JPEG quality 1-100. Default 70. */
  quality?: number;
  /** Apply greyscale. Default true. */
  grayscale?: boolean;
}

export interface ImageTransformResult {
  buf: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

export interface FeedbackImageTransformOpts {
  fileName?: string;
  mimeType?: string;
  maxBytes?: number;
  maxDim?: number;
  compressTriggerBytes?: number;
}

export type FeedbackImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface FeedbackImageTransformResult {
  buf: Buffer;
  mimeType: FeedbackImageMimeType;
  fileName: string;
  width?: number;
  height?: number;
  compressed: boolean;
}

const FEEDBACK_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const FEEDBACK_DEFAULT_MAX_DIM = 1920;
const FEEDBACK_DEFAULT_TRIGGER_BYTES = 1536 * 1024;
const FEEDBACK_JPEG_CONFIGS = [
  { maxDim: 1920, quality: 82 },
  { maxDim: 1920, quality: 72 },
  { maxDim: 1600, quality: 72 },
  { maxDim: 1600, quality: 62 },
  { maxDim: 1280, quality: 62 },
  { maxDim: 1280, quality: 52 },
  { maxDim: 1024, quality: 48 },
  { maxDim: 800, quality: 42 },
];

let _jimpPromise: Promise<any> | null = null;
function loadJimp(): Promise<any> {
  if (!_jimpPromise) _jimpPromise = import('jimp' as any).then((m: any) => m.Jimp ?? m.default?.Jimp ?? m.default);
  return _jimpPromise;
}

export async function toCompressedGrayJpeg(
  buf: Buffer,
  opts: ImageTransformOpts = {},
): Promise<ImageTransformResult> {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error('toCompressedGrayJpeg: empty or invalid buffer');
  }
  const maxDim = Math.max(64, opts.maxDim ?? 1024);
  const quality = Math.min(100, Math.max(1, opts.quality ?? 70));
  const grayscale = opts.grayscale !== false;

  const Jimp: any = await loadJimp();
  const img: any = await Jimp.read(buf);

  // Only downscale if either dim exceeds maxDim. scaleToFit preserves aspect.
  if (img.bitmap.width > maxDim || img.bitmap.height > maxDim) {
    img.scaleToFit({ w: maxDim, h: maxDim });
  }
  if (grayscale) img.greyscale();

  const out: Buffer = await img.getBuffer('image/jpeg', { quality });
  return {
    buf: out,
    mimeType: 'image/jpeg',
    width: img.bitmap.width,
    height: img.bitmap.height,
  };
}

export async function prepareFeedbackUploadImage(
  buf: Buffer,
  opts: FeedbackImageTransformOpts = {},
): Promise<FeedbackImageTransformResult> {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error('prepareFeedbackUploadImage: empty or invalid buffer');
  }

  const maxBytes = Math.max(1, opts.maxBytes ?? FEEDBACK_DEFAULT_MAX_BYTES);
  const maxDim = Math.max(64, opts.maxDim ?? FEEDBACK_DEFAULT_MAX_DIM);
  const compressTriggerBytes = Math.max(0, opts.compressTriggerBytes ?? FEEDBACK_DEFAULT_TRIGGER_BYTES);
  const originalMime = feedbackImageMime(opts.mimeType, opts.fileName);
  const originalName = normalizeFileName(opts.fileName || `image${extForMime(originalMime)}`);

  if (originalMime === 'image/gif') {
    if (buf.length > maxBytes) throw imageTooLargeError();
    return {
      buf,
      mimeType: originalMime,
      fileName: ensureFileExt(originalName, extForMime(originalMime)),
      compressed: false,
    };
  }

  const Jimp: any = await loadJimp();
  let img: any;
  try {
    img = await Jimp.read(buf);
  } catch {
    if (buf.length <= maxBytes) {
      return {
        buf,
        mimeType: originalMime,
        fileName: ensureFileExt(originalName, extForMime(originalMime)),
        compressed: false,
      };
    }
    throw imageTooLargeError();
  }

  const originalWidth = img.bitmap.width;
  const originalHeight = img.bitmap.height;
  const shouldCompress = buf.length > compressTriggerBytes || Math.max(originalWidth, originalHeight) > maxDim;
  if (!shouldCompress) {
    if (buf.length > maxBytes) throw imageTooLargeError();
    return {
      buf,
      mimeType: originalMime,
      fileName: ensureFileExt(originalName, extForMime(originalMime)),
      width: originalWidth,
      height: originalHeight,
      compressed: false,
    };
  }

  let best: ImageTransformResult | null = null;
  for (const cfg of FEEDBACK_JPEG_CONFIGS) {
    const candidateMaxDim = Math.min(maxDim, cfg.maxDim);
    const work = img.clone();
    if (work.bitmap.width > candidateMaxDim || work.bitmap.height > candidateMaxDim) {
      work.scaleToFit({ w: candidateMaxDim, h: candidateMaxDim });
    }
    const out: Buffer = await work.getBuffer('image/jpeg', { quality: cfg.quality });
    const candidate: ImageTransformResult = {
      buf: out,
      mimeType: 'image/jpeg',
      width: work.bitmap.width,
      height: work.bitmap.height,
    };
    if (!best || candidate.buf.length < best.buf.length) best = candidate;
    if (candidate.buf.length <= maxBytes && (buf.length > maxBytes || candidate.buf.length < buf.length)) {
      return feedbackJpegResult(candidate, originalName);
    }
  }

  if (buf.length <= maxBytes) {
    return {
      buf,
      mimeType: originalMime,
      fileName: ensureFileExt(originalName, extForMime(originalMime)),
      width: originalWidth,
      height: originalHeight,
      compressed: false,
    };
  }
  if (best && best.buf.length <= maxBytes) {
    return feedbackJpegResult(best, originalName);
  }
  throw imageTooLargeError();
}

function feedbackJpegResult(result: ImageTransformResult, originalName: string): FeedbackImageTransformResult {
  return {
    ...result,
    fileName: replaceFileExt(originalName, '.jpg'),
    compressed: true,
  };
}

function feedbackImageMime(mimeType?: string, fileName?: string): FeedbackImageMimeType {
  const mt = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mt === 'image/jpg' || mt === 'image/jpeg') return 'image/jpeg';
  if (mt === 'image/png') return 'image/png';
  if (mt === 'image/gif') return 'image/gif';
  if (mt === 'image/webp') return 'image/webp';

  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function extForMime(mimeType: FeedbackImageMimeType): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function normalizeFileName(fileName: string): string {
  const clean = String(fileName || 'image').replace(/[\\/]/g, '_').trim();
  return clean || 'image';
}

function replaceFileExt(fileName: string, ext: string): string {
  const clean = normalizeFileName(fileName);
  const base = clean.replace(/\.[^.]*$/, '') || 'image';
  return `${base}${ext}`;
}

function ensureFileExt(fileName: string, ext: string): string {
  return /\.[^.]+$/.test(fileName) ? fileName : `${fileName}${ext}`;
}

function imageTooLargeError(): Error & { code: string } {
  const err = new Error('image too large') as Error & { code: string };
  err.code = 'image_too_large';
  return err;
}
