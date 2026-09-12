import * as path from 'node:path';
import type { Metadata, OutputInfo, SharpOptions, PngOptions, JpegOptions, WebpOptions } from 'sharp';
import { PC_ROOT } from '../paths';
import { createLogger } from '../logger';
import { bundledNodeExecutable } from './bundled-runtime';

interface ImageRequestOptions extends Pick<SharpOptions, 'failOn' | 'limitInputPixels' | 'density'> {
  format?: 'png' | 'jpeg' | 'webp';
  encodeOptions?: PngOptions | JpegOptions | WebpOptions;
  resize?: { width: number; height: number; fit: 'fill' };
}

interface ImageClient {
  request(operation: string, buffer: Buffer, options?: ImageRequestOptions): Promise<any>;
  close(): void;
}

let client: ImageClient | undefined;
function imageClient(): ImageClient {
  if (!client) {
    const unpackedRoot = PC_ROOT.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
    const workerPath = path.join(unpackedRoot, 'bin', 'sharp-worker.cjs');
    try {
      const { createSharpClient } = require(workerPath) as {
        createSharpClient: (options: { nodeExecutable?: string; workerPath: string; onDiagnostic(): void }) => ImageClient;
      };
      client = createSharpClient({ nodeExecutable: bundledNodeExecutable(), workerPath,
        onDiagnostic: () => createLogger('image-runtime').warn('image engine emitted native diagnostics'),
      });
    } catch {
      throw Object.assign(new Error('E_IMAGE_RUNTIME_MISSING: The bundled image runtime is unavailable. Prepare the app runtimes or reinstall Orkas.'), { code: 'E_IMAGE_RUNTIME_MISSING' });
    }
  }
  return client;
}

export function imageMetadata(buffer: Buffer, options: ImageRequestOptions = {}): Promise<Metadata> {
  return imageClient().request('metadata', buffer, options);
}

export function encodeImage(buffer: Buffer, options: ImageRequestOptions): Promise<{ data: Buffer; info: OutputInfo }> {
  return imageClient().request('encode', buffer, options);
}

export function closeImageRuntime(): void {
  client?.close();
  client = undefined;
}
