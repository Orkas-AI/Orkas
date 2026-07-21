import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { fetchAndReadWithRetry } from '../util/retry';

const log = createLogger('marketplace_bundle');

export const MAX_MARKETPLACE_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_MARKETPLACE_BUNDLE_ENTRIES = 500;
export const MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

type ZipEntry = ReturnType<AdmZip['getEntries']>[number];

interface ValidatedZipEntry {
  entry: ZipEntry;
  relPath: string | null;
}

interface MarketplaceBundleDownloadOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
  assertContinue?: () => void;
  retries?: number;
  delaysMs?: number[];
}

export class MarketplaceBundleSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceBundleSizeError';
  }
}

const validatedEntries = new WeakMap<AdmZip, ValidatedZipEntry[]>();

const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

function _abortError(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error('operation aborted');
}

async function _readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw _abortError(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(_abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Read an HTTP body with an authoritative streaming byte cap. */
export async function readMarketplaceBundleBody(
  response: Response,
  opts: {
    maxBytes?: number;
    signal?: AbortSignal;
    assertContinue?: () => void;
  } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_MARKETPLACE_BUNDLE_BYTES;
  const declaredText = response.headers.get('content-length')?.trim() || '';
  if (/^\d+$/.test(declaredText)) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new MarketplaceBundleSizeError(`bundle compressed size exceeds ${maxBytes} bytes`);
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      opts.assertContinue?.();
      const { done, value } = await _readChunk(reader, opts.signal);
      if (done) break;
      opts.assertContinue?.();
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new MarketplaceBundleSizeError(`bundle compressed size exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    try { await reader.cancel(err); } catch { /* the stream may already be aborted */ }
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/** Download a Marketplace bundle with retry, body timeout, cancellation, and byte limits. */
export async function downloadMarketplaceBundle(
  label: string,
  bundleUrl: string,
  opts: MarketplaceBundleDownloadOptions = {},
): Promise<{ response: Response; buffer: Buffer | null }> {
  const timeoutMs = opts.timeoutMs ?? MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS;
  const timeoutMessage = opts.timeoutMessage || `${label} timed out after ${Math.round(timeoutMs / 1000)}s`;
  const { response, body } = await fetchAndReadWithRetry(
    label,
    bundleUrl,
    undefined,
    async (res, signal) => {
      if (!res.ok) return null;
      return readMarketplaceBundleBody(res, {
        signal,
        assertContinue: opts.assertContinue,
      });
    },
    {
      timeoutMs,
      timeoutMessage,
      retries: opts.retries,
      delaysMs: opts.delaysMs,
      isRetriable: (err) => {
        if (err instanceof MarketplaceBundleSizeError) return false;
        if (opts.assertContinue) {
          try { opts.assertContinue(); } catch { return false; }
        }
        return true;
      },
    },
  );
  return { response, buffer: body };
}

/** Parse and fully inspect the archive before any id discovery or extraction. */
export function parseMarketplaceBundle(bundle: Buffer): AdmZip {
  _preflightMarketplaceBundle(bundle);
  const zip = new AdmZip(bundle);
  inspectMarketplaceBundle(zip);
  return zip;
}

/** Read the central directory limits before AdmZip allocates one object per entry. */
function _preflightMarketplaceBundle(bundle: Buffer): void {
  let endOffset = -1;
  const firstCandidate = Math.max(0, bundle.length - ZIP_END_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bundle.length - ZIP_END_MIN_BYTES; offset >= firstCandidate; offset -= 1) {
    if (bundle.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentBytes = bundle.readUInt16LE(offset + 20);
    if (offset + ZIP_END_MIN_BYTES + commentBytes === bundle.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('zip end-of-central-directory record missing');

  const diskNumber = bundle.readUInt16LE(endOffset + 4);
  const centralDisk = bundle.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bundle.readUInt16LE(endOffset + 8);
  const totalEntries = bundle.readUInt16LE(endOffset + 10);
  const centralBytes = bundle.readUInt32LE(endOffset + 12);
  const centralOffset = bundle.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries
    || totalEntries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
  ) {
    throw new Error('multi-disk or ZIP64 marketplace bundles are not supported');
  }
  if (totalEntries > MAX_MARKETPLACE_BUNDLE_ENTRIES) {
    throw new Error(`zip entry count ${totalEntries} exceeds limit ${MAX_MARKETPLACE_BUNDLE_ENTRIES}`);
  }
  if (centralOffset + centralBytes > endOffset || centralOffset > bundle.length) {
    throw new Error('zip central directory is out of bounds');
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > bundle.length || bundle.readUInt32LE(cursor) !== ZIP_CENTRAL_ENTRY_SIGNATURE) {
      throw new Error('zip central directory entry is invalid');
    }
    const size = bundle.readUInt32LE(cursor + 24);
    if (size === 0xffffffff) throw new Error('ZIP64 marketplace bundle entries are not supported');
    totalUncompressed += size;
    if (totalUncompressed > MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES) {
      throw new Error(`zip uncompressed total exceeds ${MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES} bytes`);
    }
    const nameBytes = bundle.readUInt16LE(cursor + 28);
    const extraBytes = bundle.readUInt16LE(cursor + 30);
    const commentBytes = bundle.readUInt16LE(cursor + 32);
    cursor += 46 + nameBytes + extraBytes + commentBytes;
    if (cursor > centralOffset + centralBytes) throw new Error('zip central directory entry is out of bounds');
  }
}

export function inspectMarketplaceBundle(zip: AdmZip): ValidatedZipEntry[] {
  const cached = validatedEntries.get(zip);
  if (cached) return cached;

  const entries = zip.getEntries();
  if (entries.length > MAX_MARKETPLACE_BUNDLE_ENTRIES) {
    throw new Error(`zip entry count ${entries.length} exceeds limit ${MAX_MARKETPLACE_BUNDLE_ENTRIES}`);
  }

  let total = 0;
  const inspected = entries.map((entry) => {
    if (!entry.isDirectory) {
      const size = entry.header.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('zip entry has invalid uncompressed size');
      total += size;
      if (total > MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES) {
        throw new Error(`zip uncompressed total exceeds ${MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES} bytes`);
      }
    }
    return { entry, relPath: safeRelPath(entry.entryName) };
  });
  validatedEntries.set(zip, inspected);
  return inspected;
}

/** Extract only inspected in-root entries; callers provide a fresh destination directory. */
export function extractBundleSafely(zip: AdmZip, dst: string): void {
  let skipped = 0;
  for (const { entry, relPath } of inspectMarketplaceBundle(zip)) {
    if (entry.isDirectory) continue;
    if (!relPath) {
      skipped += 1;
      continue;
    }
    const out = path.join(dst, relPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.getData());
  }
  if (skipped) log.warn('skipped unsafe marketplace bundle entries', { count: skipped });
}

/** Return a normalized relative POSIX path that remains inside the extraction root. */
export function safeRelPath(rel: string): string | null {
  if (!rel || typeof rel !== 'string' || rel.includes('\0')) return null;
  if (path.isAbsolute(rel)) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm === '.' || norm === '') return null;
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)) return null;
  return norm;
}
