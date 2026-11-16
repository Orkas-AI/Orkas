/** Provider image size contracts; unsupported requests never resize. */
export class UnsupportedImageSizeError extends Error {}

export function isSingleImageSeedream(model: string): boolean {
  return model === 'doubao-seedream-5-0-pro-260628'
    || model === 'doubao-seedream-5-0-flash-260915';
}

export function normaliseSeedreamSize(size: string, model: string): string {
  const s = String(size || '').trim().toLowerCase();
  if (!s) return '2k';
  const singleImage = isSingleImageSeedream(model);
  const invalid = (): string => {
    if (singleImage) throw new UnsupportedImageSizeError(
      'Unsupported image size. Flash/Pro support 1k, 1.5k, 2k, or WIDTHxHEIGHT '
      + '(921600-4624220 pixels; aspect ratio 1:16-16:1). The request was not resized.',
    );
    return '2k'; // Preserve the legacy Lite/older-model compatibility contract.
  };
  const keywords = singleImage ? ['1k', '1.5k', '2k'] : ['2k', '3k', '4k'];
  if (keywords.includes(s)) return s;
  const m = s.length <= 32 ? s.match(/^(\d+)x(\d+)$/) : null;
  if (!m) return invalid();
  const w = Number(m[1]);
  const h = Number(m[2]);
  const pixels = w * h;
  const aspect = w / h;
  const minPixels = singleImage ? 921_600 : 3_686_400;
  const maxPixels = singleImage ? 4_624_220 : 16_777_216;
  if (!w || !h || pixels < minPixels || pixels > maxPixels || aspect < 1 / 16 || aspect > 16) return invalid();
  return `${w}x${h}`;
}

type GeminiImageConfig = { aspectRatio: string; imageSize?: '512' | '1K' | '2K' | '4K' };

// Exact pixel pairs from the GenerateContent tables (not mathematical aspect
// approximations). The documented 2K/4K pairs are exactly 2x/4x these 1K pairs.
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
const GEMINI_1K_SIZES: ReadonlyArray<readonly [string, number, number]> = [
  ['1:1', 1024, 1024], ['1:4', 512, 2048], ['1:8', 384, 3072],
  ['2:3', 848, 1264], ['3:2', 1264, 848], ['3:4', 896, 1200],
  ['4:1', 2048, 512], ['4:3', 1200, 896], ['4:5', 928, 1152],
  ['5:4', 1152, 928], ['8:1', 3072, 384], ['9:16', 768, 1376],
  ['16:9', 1376, 768], ['21:9', 1584, 672],
];
const GEMINI_25_SIZES: ReadonlyArray<readonly [string, number, number]> = [
  ['1:1', 1024, 1024], ['2:3', 832, 1248], ['3:2', 1248, 832],
  ['3:4', 864, 1184], ['4:3', 1184, 864], ['4:5', 896, 1152],
  ['5:4', 1152, 896], ['9:16', 768, 1344], ['16:9', 1344, 768], ['21:9', 1536, 672],
];

export function normaliseGeminiImageSize(size: string, model: string): GeminiImageConfig | undefined {
  const value = String(size || '').trim().toLowerCase();
  if (!value || value === 'auto') return undefined;
  const legacy = model === 'gemini-2.5-flash-image' || model === 'gemini-2.5-flash-image-preview';
  const flash = model === 'gemini-3.1-flash-image' || model === 'gemini-3.1-flash-image-preview';
  const nano = model === 'gemini-nano-banana-2.1';
  const pro = model === 'gemini-3-pro-image' || model === 'gemini-3-pro-image-preview'
    || model === 'gemini-3.1-pro-image';
  if (legacy || flash || nano || pro) {
    for (const [aspectRatio, width, height] of legacy ? GEMINI_25_SIZES : GEMINI_1K_SIZES) {
      if (pro && ['1:4', '1:8', '4:1', '8:1'].includes(aspectRatio)) continue;
      if (legacy) {
        if (value === `${width}x${height}`) return { aspectRatio };
        continue;
      }
      for (const [scale, imageSize] of [[0.5, '512'], [1, '1K'], [2, '2K'], [4, '4K']] as const) {
        if (scale === 0.5 && !flash) continue;
        if (value === `${width * scale}x${height * scale}`) return { aspectRatio, imageSize };
      }
    }
  }
  throw new UnsupportedImageSizeError(
    'Unsupported image size for the selected Gemini model. Use auto or an exact WIDTHxHEIGHT '
    + 'from its supported size table. The request was not resized.',
  );
}

// Ark's recommended 2K sizes for Seedream. Each is inside both the Flash/Pro and the legacy Lite
// pixel ranges and preserve the public API 2K contract.
const SEEDREAM_2K_SIZES: ReadonlyArray<readonly [string, number, number]> = [
  ['1:1', 2048, 2048], ['4:3', 2304, 1728], ['3:4', 1728, 2304], ['16:9', 2560, 1440],
  ['9:16', 1440, 2560], ['3:2', 2496, 1664], ['2:3', 1664, 2496], ['21:9', 3024, 1296],
];

/**
 * The size nearest a width-to-height ratio that this service makes as asked, or none where it
 * takes no shape and keeps its own default. A still made for a video takes the video's shape
 * (decided 2026-11-10).
 */
export function imageSizeForAspect(capability: { api: string; model: string }, aspect: number): string | undefined {
  if (!Number.isFinite(aspect) || aspect <= 0) return undefined;
  const nearest = (sizes: ReadonlyArray<readonly [string, number, number]>) => [...sizes]
    .sort((a, b) => Math.abs(Math.log(a[1] / a[2] / aspect)) - Math.abs(Math.log(b[1] / b[2] / aspect)))[0];
  if (capability.api === 'doubao' || capability.api === 'orkas') {
    const [, width, height] = nearest(SEEDREAM_2K_SIZES);
    return `${width}x${height}`;
  }
  if (capability.api !== 'gemini') return undefined;
  // Gemini's own table decides which sizes a model takes: 2K where it can, else its one size.
  const taken = (size: string) => {
    try {
      return normaliseGeminiImageSize(size, capability.model) ? size : undefined;
    } catch (err) {
      if (err instanceof UnsupportedImageSizeError) return undefined;
      throw err;
    }
  };
  const [, width, height] = nearest(GEMINI_1K_SIZES);
  const [, legacyWidth, legacyHeight] = nearest(GEMINI_25_SIZES);
  return taken(`${width * 2}x${height * 2}`) ?? taken(`${width}x${height}`) ?? taken(`${legacyWidth}x${legacyHeight}`);
}
