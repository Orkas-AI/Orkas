import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathAllowed } from '../util/path-sandbox';
import { encodeImage, imageMetadata } from '../util/sharp-runtime';

export interface ImageStudioGenerationOutput {
  output_path: string;
  output_sha256: string;
}

export function imageStudioBytesHash(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function imageStudioFileHash(file: string): Promise<string> {
  return imageStudioBytesHash(await fs.readFile(file));
}

/** Receipts from private authoring scripts are only hints. Reproduce the narrow
 * delivery transform from a hash-bound provider ancestor before trusting one.
 * Never infer generation from a route, filename, receipt flag or visual similarity. */
export async function isImageStudioGeneration(input: {
  projectDirAbs: string;
  rasterAbsPath: string;
  outputs: readonly ImageStudioGenerationOutput[];
}): Promise<boolean> {
  const roots = [path.resolve(input.projectDirAbs)];
  const seen = new Set<string>();
  const verify = async (file: string, depth: number): Promise<boolean> => {
    if (depth > 4 || seen.has(file) || !isPathAllowed(file, roots)) return false;
    seen.add(file);
    const bytes = await fs.readFile(file);
    const digest = imageStudioBytesHash(bytes);
    if (input.outputs.some(record => path.resolve(record.output_path) === file && record.output_sha256 === digest)) return true;
    const receiptPath = `${file}.image-normalization.json`;
    if (!isPathAllowed(receiptPath, roots)) return false;
    try {
      const stat = await fs.stat(receiptPath);
      if (stat.size > 4096) return false;
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      if (receipt.schema_version !== 1 || receipt.output_sha256 !== digest
        || typeof receipt.input_path !== 'string'
        || !['png', 'jpeg', 'webp'].includes(receipt.format)
        || !Number.isInteger(receipt.quality) || receipt.quality < 1 || receipt.quality > 100
        || typeof receipt.resize !== 'boolean') return false;
      const source = path.resolve(input.projectDirAbs, receipt.input_path);
      if (!isPathAllowed(source, roots) || !(await verify(source, depth + 1))) return false;
      const sourceBytes = await fs.readFile(source);
      if (imageStudioBytesHash(sourceBytes) !== receipt.input_sha256) return false;
      const [before, after] = await Promise.all([imageMetadata(sourceBytes), imageMetadata(bytes)]);
      if (!before.width || !before.height || !after.width || !after.height
        || after.width * after.height > 16_777_216
        || before.width * after.height !== before.height * after.width) return false;
      if (!receipt.resize && (before.width !== after.width || before.height !== after.height)) return false;
      const expected = await encodeImage(sourceBytes, {
        format: receipt.format,
        encodeOptions: { quality: receipt.quality },
        ...(receipt.resize ? { resize: { width: after.width, height: after.height, fit: 'fill' as const } } : {}),
      });
      return imageStudioBytesHash(expected.data) === digest;
    } catch { return false; }
  };
  // No provider record can prove any descendant. Avoid decoding/hashing twice
  // on the ordinary authored-raster path.
  if (!input.outputs.length) return false;
  return verify(path.resolve(input.rasterAbsPath), 0);
}
