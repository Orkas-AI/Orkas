/**
 * Local CLI agent media — sniffing, decoding and bounded downloading of the
 * images and videos a CLI backend hands back (inline data or a remote URL).
 *
 * Pure helpers and constants only; the per-run reservation registry and the
 * materialize/commit closures stay with the run in `runner.ts`, which is the
 * sole consumer. Direct remote downloads reject private/link-local addresses
 * in the network stack's actual connection lookup (SSRF guard); proxy routes
 * keep the shared proxy policy and delegate destination resolution to the
 * configured proxy.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import * as path from 'node:path';

import { composeAbortSignal } from '../../util/abort.js';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../chat_attachments.js';
import { downloadBinaryWithProxyPolicy } from '../../util/proxy-dispatcher.js';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_SIGNATURE = Buffer.from('ffd8', 'hex');
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MAX_GENERATED_IMAGE_DIMENSION = 16_384;
const MAX_GENERATED_IMAGE_AREA = 100_000_000;
export const LOCAL_AGENT_REMOTE_IMAGE_TIMEOUT_MS = 15_000;
export const LOCAL_AGENT_REMOTE_VIDEO_TIMEOUT_MS = 45_000;
export const LOCAL_AGENT_REMOTE_BATCH_TIMEOUT_MS = 60_000;
export const LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const LOCAL_AGENT_REMOTE_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
export const LOCAL_AGENT_REMOTE_MAX_ITEMS = 4;
export const LOCAL_AGENT_REMOTE_GLOBAL_MAX_ITEMS = 8;
export const LOCAL_AGENT_REMOTE_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;

export type CodexGeneratedImageDecodeResult =
  | { ok: true; buffer: Buffer; width: number; height: number; extension: '.png' }
  | { ok: false; reason: 'not_image' | 'too_large' | 'malformed' | 'unsupported_format' | 'invalid_dimensions' };

/** Decode the real Codex app-server `imageGeneration.result` shape: a bare
 * Base64 PNG string (the desktop UI receives image bytes, not a filesystem
 * path). Keep this synchronous so the normalized file event is ordered before
 * the backend's terminal marker. */
export function decodeCodexGeneratedImageResult(
  raw: unknown,
  maxBytes = MAX_IMAGE_ATTACHMENT_BYTES,
): CodexGeneratedImageDecodeResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_image' };
  const source = raw.trim();
  if (!source) return { ok: false, reason: 'not_image' };

  let encoded = source;
  const dataUrl = /^data:image\/([^;,]+);base64,([\s\S]*)$/i.exec(source);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== 'png') return { ok: false, reason: 'unsupported_format' };
    encoded = dataUrl[2];
  }
  const compact = encoded.replace(/\s+/g, '');
  // A bare PNG always starts with this Base64 representation of its magic.
  // The early gate keeps ordinary status prose such as "completed" out of
  // the decoder without treating it as a malformed image.
  if (!dataUrl && !compact.startsWith('iVBORw0KGgo')) return { ok: false, reason: 'not_image' };
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return { ok: false, reason: 'malformed' };
  }
  const encodedLimit = Math.ceil(Math.max(1, maxBytes) / 3) * 4 + 4;
  if (compact.length > encodedLimit) return { ok: false, reason: 'too_large' };

  const buffer = Buffer.from(compact, 'base64');
  const canonical = buffer.toString('base64').replace(/=+$/, '');
  if (canonical !== compact.replace(/=+$/, '')) return { ok: false, reason: 'malformed' };
  if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' };
  if (
    buffer.length < 33
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.readUInt32BE(8) !== 13
    || buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return { ok: false, reason: 'unsupported_format' };
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    !width || !height
    || width > MAX_GENERATED_IMAGE_DIMENSION
    || height > MAX_GENERATED_IMAGE_DIMENSION
    || width * height > MAX_GENERATED_IMAGE_AREA
  ) {
    return { ok: false, reason: 'invalid_dimensions' };
  }
  return { ok: true, buffer, width, height, extension: '.png' };
}

type LocalAgentImageDecodeResult =
  | { ok: true; buffer: Buffer; width: number; height: number; mimeType: string; extension: '.png' | '.jpg' | '.webp' | '.gif' }
  | { ok: false; reason: 'not_image' | 'too_large' | 'malformed' | 'unsupported_format' | 'invalid_dimensions' };

function normalizedImageMime(raw: unknown): string {
  const mime = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || !buffer.subarray(0, 2).equals(JPEG_SIGNATURE)) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (sof.has(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
      || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  const kind = buffer.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && buffer[20] === 0x2f && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function inspectRasterImage(buffer: Buffer, declaredMime?: unknown): LocalAgentImageDecodeResult {
  let mimeType = '';
  let extension: '.png' | '.jpg' | '.webp' | '.gif' = '.png';
  let dimensions: { width: number; height: number } | null = null;
  if (
    buffer.length >= 33
    && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && buffer.readUInt32BE(8) === 13
    && buffer.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    mimeType = 'image/png';
    extension = '.png';
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer.subarray(0, 2).equals(JPEG_SIGNATURE)) {
    mimeType = 'image/jpeg';
    extension = '.jpg';
    dimensions = jpegDimensions(buffer);
  } else if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    mimeType = 'image/gif';
    extension = '.gif';
    dimensions = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } else if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    mimeType = 'image/webp';
    extension = '.webp';
    dimensions = webpDimensions(buffer);
  } else {
    return { ok: false, reason: 'unsupported_format' };
  }
  const expectedMime = normalizedImageMime(declaredMime);
  if (expectedMime && expectedMime !== mimeType) return { ok: false, reason: 'unsupported_format' };
  if (!dimensions) return { ok: false, reason: 'malformed' };
  const { width, height } = dimensions;
  if (!width || !height || width > MAX_GENERATED_IMAGE_DIMENSION || height > MAX_GENERATED_IMAGE_DIMENSION
      || width * height > MAX_GENERATED_IMAGE_AREA) {
    return { ok: false, reason: 'invalid_dimensions' };
  }
  return { ok: true, buffer, width, height, mimeType, extension };
}

function decodeLocalAgentImageData(
  raw: unknown,
  declaredMime?: unknown,
  maxBytes = MAX_IMAGE_ATTACHMENT_BYTES,
): LocalAgentImageDecodeResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'not_image' };
  const source = raw.trim();
  let encoded = source;
  let mime = normalizedImageMime(declaredMime);
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(source);
  if (dataUrl) {
    const dataMime = normalizedImageMime(dataUrl[1]);
    if (mime && dataMime !== mime) return { ok: false, reason: 'unsupported_format' };
    mime = dataMime;
    encoded = dataUrl[2];
  }
  const compact = encoded.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return { ok: false, reason: 'malformed' };
  }
  if (compact.length > Math.ceil(Math.max(1, maxBytes) / 3) * 4 + 4) return { ok: false, reason: 'too_large' };
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    return { ok: false, reason: 'malformed' };
  }
  if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' };
  return inspectRasterImage(buffer, mime);
}

export type LocalAgentMediaDecodeResult =
  | ({ ok: true; kind: 'image' } & Omit<Extract<LocalAgentImageDecodeResult, { ok: true }>, 'ok'>)
  | {
      ok: true;
      kind: 'video';
      buffer: Buffer;
      mimeType: 'video/mp4' | 'video/quicktime' | 'video/x-m4v' | 'video/webm' | 'video/ogg';
      extension: '.mp4' | '.mov' | '.m4v' | '.webm' | '.ogv';
    }
  | { ok: false; reason: 'not_media' | 'too_large' | 'malformed' | 'unsupported_format' | 'invalid_dimensions' };

export function normalizedMediaMime(raw: unknown): string {
  const mime = typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : '';
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'video/mov') return 'video/quicktime';
  if (mime === 'video/m4v') return 'video/x-m4v';
  return mime;
}

export function mediaKindHint(mime: unknown, name = ''): 'image' | 'video' | null {
  const normalized = normalizedMediaMime(mime);
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  const ext = path.extname(String(name || '').split(/[?#]/, 1)[0]).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext)) return 'video';
  return null;
}

export type SupportedMediaExtension =
  '.png' | '.jpg' | '.webp' | '.gif' | '.mp4' | '.mov' | '.m4v' | '.webm' | '.ogv';

export function mediaExtensionHint(mime: unknown, name = ''): SupportedMediaExtension | null {
  const normalized = normalizedMediaMime(mime);
  const byMime: Partial<Record<string, SupportedMediaExtension>> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-m4v': '.m4v',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
  };
  if (byMime[normalized]) return byMime[normalized];
  const ext = path.extname(String(name || '').split(/[?#]/, 1)[0]).toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  if (['.png', '.jpg', '.webp', '.gif', '.mp4', '.mov', '.m4v', '.webm', '.ogv'].includes(ext)) {
    return ext as SupportedMediaExtension;
  }
  return null;
}

export function stableRemoteMediaName(uri: string, extension: SupportedMediaExtension): string {
  const digest = createHash('sha256').update(uri).digest('hex').slice(0, 24);
  return `cli-remote-${digest}${extension}`;
}

function hasIsoBmffFtyp(buffer: Buffer): boolean {
  const scanLimit = Math.min(buffer.length, 4096);
  let offset = 0;
  while (offset + 8 <= scanLimit) {
    let boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > scanLimit) break;
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      boxSize = Number(extendedSize);
      headerSize = 16;
    }
    if (boxType === 'ftyp') return boxSize >= headerSize + 8 && offset + boxSize <= buffer.length;
    if (boxSize === 0 || boxSize < headerSize || offset + boxSize > scanLimit) break;
    offset += boxSize;
  }
  return false;
}

export function inspectLocalAgentMedia(
  buffer: Buffer,
  declaredMime?: unknown,
  name = '',
): LocalAgentMediaDecodeResult {
  const declared = normalizedMediaMime(declaredMime);
  if (declared && !declared.startsWith('image/') && !declared.startsWith('video/')) {
    return { ok: false, reason: 'unsupported_format' };
  }
  if (!declared || declared.startsWith('image/')) {
    const image = inspectRasterImage(buffer, declared);
    if (image.ok) return { ...image, kind: 'image' };
    if (declared.startsWith('image/') && 'reason' in image) {
      return { ok: false, reason: image.reason === 'not_image' ? 'not_media' : image.reason };
    }
  }

  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(WEBM_SIGNATURE)) {
    if (declared && declared !== 'video/webm') return { ok: false, reason: 'unsupported_format' };
    return { ok: true, kind: 'video', buffer, mimeType: 'video/webm', extension: '.webm' };
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    if (declared && declared !== 'video/ogg') return { ok: false, reason: 'unsupported_format' };
    if (!declared && path.extname(name.split(/[?#]/, 1)[0]).toLowerCase() !== '.ogv') {
      return { ok: false, reason: 'unsupported_format' };
    }
    return { ok: true, kind: 'video', buffer, mimeType: 'video/ogg', extension: '.ogv' };
  }
  if (hasIsoBmffFtyp(buffer)) {
    const declaredVideo = declared || '';
    if (declaredVideo && !['video/mp4', 'video/quicktime', 'video/x-m4v'].includes(declaredVideo)) {
      return { ok: false, reason: 'unsupported_format' };
    }
    const sourceExt = path.extname(name.split(/[?#]/, 1)[0]).toLowerCase();
    if (declaredVideo === 'video/quicktime' || sourceExt === '.mov') {
      return { ok: true, kind: 'video', buffer, mimeType: 'video/quicktime', extension: '.mov' };
    }
    if (declaredVideo === 'video/x-m4v' || sourceExt === '.m4v') {
      return { ok: true, kind: 'video', buffer, mimeType: 'video/x-m4v', extension: '.m4v' };
    }
    return { ok: true, kind: 'video', buffer, mimeType: 'video/mp4', extension: '.mp4' };
  }
  return { ok: false, reason: 'unsupported_format' };
}

export function decodeLocalAgentMediaData(raw: unknown, declaredMime?: unknown): LocalAgentMediaDecodeResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'not_media' };
  const source = raw.trim();
  let encoded = source;
  let mime = normalizedMediaMime(declaredMime);
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(source);
  if (dataUrl) {
    const dataMime = normalizedMediaMime(dataUrl[1]);
    if (mime && dataMime !== mime) return { ok: false, reason: 'unsupported_format' };
    mime = dataMime;
    encoded = dataUrl[2];
  }
  const compact = encoded.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return { ok: false, reason: 'malformed' };
  }
  const cap = mediaKindHint(mime) === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES;
  if (compact.length > Math.ceil(Math.max(1, cap) / 3) * 4 + 4) return { ok: false, reason: 'too_large' };
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    return { ok: false, reason: 'malformed' };
  }
  if (buffer.length > cap) return { ok: false, reason: 'too_large' };
  return inspectLocalAgentMedia(buffer, mime);
}

function isPublicRemoteMediaIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  );
}

export function isPublicRemoteMediaIp(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%[^%]+$/, '');
  if (isIP(normalized) === 4) return isPublicRemoteMediaIpv4(normalized);
  if (isIP(normalized) !== 6) return false;
  return !(
    normalized === '::' || normalized === '::1'
    || normalized.startsWith('::ffff:')
    || /^(?:fc|fd)/.test(normalized)
    || /^fe[89ab]/.test(normalized)
    || /^ff/.test(normalized)
    || /^2001:db8(?:[:]|$)/.test(normalized)
  );
}

function validateRemoteMediaUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('malformed remote media URL'); }
  // The remote URL remains available to the renderer as the compatibility
  // fallback, but main-process background materialization is HTTPS-only.
  if (url.protocol !== 'https:') throw new Error('background media download requires HTTPS');
  if (url.username || url.password) throw new Error('remote media URL must not use URL credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('remote media URL resolves to a local host');
  }
  if (isIP(hostname) && !isPublicRemoteMediaIp(hostname)) {
    throw new Error('remote media URL resolves to a non-public address');
  }
  return url;
}

export async function downloadLocalAgentMedia(
  uri: string,
  declaredMime: unknown,
  name: string,
  signal: AbortSignal,
  kind: 'image' | 'video',
  timeoutMs: number,
): Promise<LocalAgentMediaDecodeResult> {
  const maxBytes = kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES;
  const composed = composeAbortSignal(signal, timeoutMs, 'remote media download timed out');
  try {
    const url = validateRemoteMediaUrl(uri);
    const result = await downloadBinaryWithProxyPolicy(url.toString(), {
      label: 'local agent remote media download',
      signal: composed.signal,
      maxBytes,
      redirect: 'error',
      retries: 0,
      headers: { Accept: kind === 'video' ? 'video/*' : 'image/*' },
      isAllowedDirectAddress: isPublicRemoteMediaIp,
      validate: body => {
        const inspected = inspectLocalAgentMedia(body, declaredMime, name || url.pathname);
        if ('reason' in inspected) throw new Error(`remote media rejected: ${inspected.reason}`);
      },
    });
    return inspectLocalAgentMedia(result.body, declaredMime, name || url.pathname);
  } catch (error) {
    if (signal.aborted || composed.signal.aborted) return { ok: false, reason: 'malformed' };
    throw error;
  } finally {
    composed.cleanup();
  }
}
