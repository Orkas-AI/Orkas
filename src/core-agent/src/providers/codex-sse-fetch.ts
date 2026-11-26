import * as zlib from 'node:zlib';

/** The installed SDK always compresses Codex SSE requests when zstd is
 * available. Some valid compressed representations are rejected upstream.
 * Send the exact decoded bytes through the existing host transport, without
 * rebuilding model input, changing headers owned by auth/routing, or replaying
 * a rejected request. Decoding uses the native async worker, not the main loop. */
export function codexSseFetch(next: typeof globalThis.fetch, api: string): typeof globalThis.fetch {
  if (api !== 'openai-codex-responses') return next;
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get('content-encoding')?.toLowerCase() !== 'zstd') return next(input, init);
    const encoded = init?.body;
    const bytes = ArrayBuffer.isView(encoded)
      ? Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength)
      : encoded instanceof ArrayBuffer ? Buffer.from(encoded) : undefined;
    // pi-ai emits a Uint8Array. Do not consume an unknown streaming body.
    if (!bytes) return next(input, init);
    init?.signal?.throwIfAborted();
    const body = await new Promise<Buffer>((resolve, reject) => {
      zlib.zstdDecompress(bytes, (error, decoded) => error ? reject(error) : resolve(decoded));
    });
    // Cancellation during native decoding must never dispatch a late request.
    init?.signal?.throwIfAborted();
    headers.delete('content-encoding');
    headers.delete('content-length');
    return next(input, { ...init, headers, body });
  };
}
