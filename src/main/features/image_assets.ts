import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Sharp, SharpConstructor } from 'sharp';

import { isPathAllowed } from '../util/path-sandbox';

export interface ImageAssetProcessResult {
  output_path: string;
  format: string;
  width: number;
  height: number;
  channels: number;
  bytes: number;
  engine: 'sharp';
  model_calls: 0;
}

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

function finiteInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`E_IMAGE_ASSET_ARGUMENT: ${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function assertProjectFile(projectDirAbs: string, absPath: string, label: string): void {
  if (!isPathAllowed(absPath, [projectDirAbs])) {
    throw new Error(`E_IMAGE_ASSET_PATH: ${label} must stay inside the image project.`);
  }
}

async function loadSharp(): Promise<SharpConstructor> {
  try {
    const module = await import('sharp');
    const factory = module.default;
    if (typeof factory !== 'function') {
      throw new Error('sharp did not expose a callable default export');
    }
    return factory;
  } catch (error) {
    throw new Error(`E_SHARP_UNAVAILABLE: the image output validator is unavailable (${(error as Error).message}).`);
  }
}

export async function inspectImageAssetBuffer(buffer: Buffer): Promise<{
  format: string;
  width: number;
  height: number;
  channels: number;
  bytes: number;
}> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('E_IMAGE_ASSET_INVALID: image response is empty.');
  const sharp = await loadSharp();
  let metadata: Awaited<ReturnType<Sharp['metadata']>>;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_AREA }).metadata();
  } catch (error) {
    throw new Error(`E_IMAGE_ASSET_INVALID: workflow output is not a readable image (${(error as Error).message}).`);
  }
  if (!metadata.format || !metadata.width || !metadata.height) throw new Error('E_IMAGE_ASSET_INVALID: workflow output has no image dimensions.');
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_AREA) {
    throw new Error('E_IMAGE_ASSET_LIMIT: workflow output exceeds the image dimension limit.');
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
  const sharp = await loadSharp();
  const webp = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_AREA })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  const useWebp = webp.length < buffer.length;
  const selected = useWebp ? webp : buffer;
  return {
    buf: selected,
    mediaType: useWebp ? 'image/webp' : 'image/png',
    width: inspected.width,
    height: inspected.height,
    sourceBytes: buffer.length,
    encodedBytes: selected.length,
    transcoded: useWebp,
  };
}

export async function writeImageAssetBuffer(input: {
  projectDirAbs: string;
  outputAbsPath: string;
  buffer: Buffer;
  quality?: number;
}): Promise<ImageAssetProcessResult> {
  const projectDirAbs = path.resolve(input.projectDirAbs);
  const outputAbsPath = path.resolve(input.outputAbsPath);
  assertProjectFile(projectDirAbs, outputAbsPath, 'output_path');
  const extension = path.extname(outputAbsPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('E_IMAGE_ASSET_FORMAT: workflow output_path must end in png, jpg, jpeg, or webp.');
  }
  await inspectImageAssetBuffer(input.buffer);
  const quality = input.quality === undefined ? 95 : finiteInteger(input.quality, 'quality', 1, 100);
  const sharp = await loadSharp();
  let pipeline = sharp(input.buffer, { failOn: 'error', limitInputPixels: MAX_AREA });
  if (extension === '.png') pipeline = pipeline.png({ quality });
  else if (extension === '.webp') pipeline = pipeline.webp({ quality });
  else pipeline = pipeline.jpeg({ quality });
  await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
  const temporaryPath = `${outputAbsPath}.${process.pid}.${randomUUID()}.tmp${extension}`;
  let info: Awaited<ReturnType<Sharp['toFile']>>;
  try {
    info = await pipeline.toFile(temporaryPath);
    // A sibling hard link publishes the fully-written inode atomically and,
    // unlike rename, refuses to replace an existing path on every supported
    // platform. This also closes the race between the caller's uniquify check
    // and a concurrent writer choosing the same output.
    await fs.link(temporaryPath, outputAbsPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('E_IMAGE_ASSET_EXISTS: workflow output_path already exists.');
    }
    throw error;
  }
  // The published path remains valid if temporary cleanup is interrupted.
  await fs.unlink(temporaryPath).catch(() => undefined);
  return {
    output_path: outputAbsPath,
    format: info.format,
    width: info.width,
    height: info.height,
    channels: info.channels,
    bytes: info.size,
    engine: 'sharp',
    model_calls: 0,
  };
}
