/**
 * Image preprocessing for vision-model input. Resizes long edge, converts to
 * grayscale, re-encodes as JPEG. Significantly shrinks the byte payload while
 * preserving everything a vision model actually needs (text/shapes/layout).
 *
 * Pure function, reusable anywhere in main/.
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
