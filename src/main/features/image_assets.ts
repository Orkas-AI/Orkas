import type { Metadata } from 'sharp';

import { encodeImage, imageMetadata } from '../util/sharp-runtime';

export interface LosslessModelImageResult {
  buf: Buffer;
  mediaType: 'image/png' | 'image/webp';
  width: number;
  height: number;
  sourceBytes: number;
  encodedBytes: number;
  transcoded: boolean;
}

const MAX_DIMENSION = 16_384;
const MAX_AREA = 100_000_000;

export async function inspectImageAssetBuffer(buffer: Buffer): Promise<{
  format: string;
  width: number;
  height: number;
  channels: number;
  bytes: number;
}> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('E_IMAGE_ASSET_INVALID: image response is empty.');
  let metadata: Metadata;
  try {
    metadata = await imageMetadata(buffer, { failOn: 'error', limitInputPixels: MAX_AREA });
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code || '').startsWith('E_IMAGE_RUNTIME_')) throw error;
    throw new Error(`E_IMAGE_ASSET_INVALID: image input is not a readable image (${(error as Error).message}).`);
  }
  if (!metadata.format || !metadata.width || !metadata.height) throw new Error('E_IMAGE_ASSET_INVALID: image input has no image dimensions.');
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_AREA) {
    throw new Error('E_IMAGE_ASSET_LIMIT: image input exceeds the image dimension limit.');
  }
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    channels: metadata.channels || 0,
    bytes: buffer.length,
  };
}

/** Build the smallest lossless model-facing representation of a PNG.
 *
 * HTML preview screenshots remain PNG evidence locally. The model copy is
 * always passed through the lossless encoder, but the original is retained
 * when lossless WebP would be larger so preprocessing can never inflate the
 * network payload. Sharp failures are surfaced instead of silently sending an
 * unprocessed screenshot because this transform is part of the model-input
 * contract. */
export async function prepareLosslessModelImage(buffer: Buffer): Promise<LosslessModelImageResult> {
  const inspected = await inspectImageAssetBuffer(buffer);
  if (inspected.format !== 'png') {
    throw new Error('E_IMAGE_ASSET_FORMAT: lossless model preprocessing requires PNG input.');
  }
  return encodeLosslessModelPng(buffer, inspected);
}

/** Inspect and prepare one buffer so format routing and PNG encoding share the
 * same validated dimensions. The caller handles formats it cannot attach. */
export async function prepareModelImageAsset(buffer: Buffer) {
  const { format, width, height } = await inspectImageAssetBuffer(buffer);
  if (format === 'png') return { format, ...await encodeLosslessModelPng(buffer, { width, height }) };
  const mediaType = format === 'jpeg' ? 'image/jpeg' as const
    : format === 'webp' ? 'image/webp' as const : undefined;
  return { format, width, height, buf: buffer, mediaType };
}

async function encodeLosslessModelPng(
  buffer: Buffer,
  { width, height }: { width: number; height: number },
): Promise<LosslessModelImageResult> {
  const { data: webp } = await encodeImage(buffer, {
    failOn: 'error', limitInputPixels: MAX_AREA,
    format: 'webp', encodeOptions: { lossless: true, effort: 4 },
  });
  const useWebp = webp.length < buffer.length;
  const selected = useWebp ? webp : buffer;
  return {
    buf: selected,
    mediaType: useWebp ? 'image/webp' : 'image/png',
    width,
    height,
    sourceBytes: buffer.length,
    encodedBytes: selected.length,
    transcoded: useWebp,
  };
}
