/**
 * Run a local CLI agent for one dispatch.
 *
 * Invariants:
 *   - Single spawn entry point for the whole project. `bus.ts` must
 *     route here; `features/*` must not call `child_process.spawn`
 *     directly for CLI agents.
 *   - Pre-flight `detectOne` re-probes the binary even if the cached
 *     entry says available — the user might have uninstalled it
 *     mid-conversation. A miss yields `done({status: 'missing_cli'})`
 *     before any persistence happens.
 *   - Persistence wraps every backend event so `events.jsonl` is the
 *     authoritative replay log. Output text is also appended to
 *     output.txt as it streams; the final body lands in meta.json.
 *   - The runner never throws on the happy path; failures are reported
 *     through the same `onEvent({type:'done', status:'failed', ...})`
 *     channel so the caller has a single completion contract.
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../../logger.js';
import { chatMediaCidUrl } from '../../util/chat-media-url.js';
import { logErrorRef, logErrorSummary, logPathRef, maskId } from '../../util/log-redact.js';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize.js';
import { redactPaths } from '../../util/redact.js';
import {
  detectOne,
  localCliCapabilities,
  type LocalCliEntry,
  type LocalCliType,
} from './registry.js';
import { claudeBackend } from './backends/claude.js';
import { codexBackend } from './backends/codex.js';
import { openclawBackend } from './backends/openclaw.js';
import { opencodeBackend } from './backends/opencode.js';
import { hermesBackend } from './backends/hermes.js';
import {
  type LocalActiveRunIngress,
  type LocalBackend,
  type LocalEvent,
} from './backends/base.js';
import * as persist from './persist.js';
import { sessionToolResultsDir } from '../../paths.js';
import { maybeSpillToolResult, toolResultRefForPath } from '../../util/tool-result-cap.js';
import { isPathAllowed } from '../../util/path-sandbox.js';
import { composeAbortSignal } from '../../util/abort.js';
import { downloadBinaryWithProxyPolicy } from '../../util/proxy-dispatcher.js';
import { conversationMessageReadFile } from '../../util/project-layout.js';
import { isCliResumeRejectedMessage } from './context.js';
import type { BridgeCapability, BridgeHandle, CommanderHandoffRequest } from './bridge.js';
import { registerUserSwitchHook } from '../user-switch-hooks.js';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  resolveAttachmentAbsPath,
  saveGeneratedImageAttachment,
  saveGeneratedMediaCacheAttachment,
  saveGeneratedMediaAttachment,
} from '../chat_attachments.js';

const log = createLogger('local-agents:runner');

function bridgeToolKey(event: LocalEvent): string {
  if (event.type !== 'tool-event') return '';
  let tool = String(event.tool || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (tool.startsWith('mcp__orkas__')) tool = tool.slice('mcp__orkas__'.length);
  else if (tool.startsWith('orkas.')) tool = tool.slice('orkas.'.length);
  return tool;
}

function bridgeSkillRefFromToolEvent(event: LocalEvent): string {
  const tool = bridgeToolKey(event);
  if (!tool) return '';
  const input = event.input && typeof event.input === 'object' && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : {};
  if (tool === 'orkas_read_skill') return String(input.id || '').trim();
  if (tool === 'orkas_run_skill' && String(input.action || 'run').trim().toLowerCase() !== 'read') {
    return String(input.skill || '').trim();
  }
  return '';
}

function bridgeConnectorIdFromToolEvent(event: LocalEvent): string {
  if (bridgeToolKey(event) !== 'orkas_call_connector_tool') return '';
  const input = event.input && typeof event.input === 'object' && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : {};
  return String(input.connector_id || input.connectorId || '').trim();
}

/** Hard wall-clock cap for a single CLI dispatch — zombie insurance
 *  only. The hang detector is the idle-kill below, so this can be
 *  generous: healthy coding dispatches routinely pass 20 minutes
 *  (builds, model downloads, renders). The old 20-min value doubled as
 *  the hang detector and killed an actively-working 20-min claude turn
 *  (run 1dffe7c48d18). Override via ORKAS_LOCAL_AGENT_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Backends with no mid-run event stream can't be idle-killed (silence
 *  is normal for them), so they keep a long-but-bounded wall-clock cap
 *  as their only hang bound. */
const BACKEND_TIMEOUT_MS: Partial<Record<LocalCliType, number>> = {
  openclaw: 60 * 60 * 1000,
};

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_SIGNATURE = Buffer.from('ffd8', 'hex');
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MAX_GENERATED_IMAGE_DIMENSION = 16_384;
const MAX_GENERATED_IMAGE_AREA = 100_000_000;
const LOCAL_AGENT_REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const LOCAL_AGENT_REMOTE_VIDEO_TIMEOUT_MS = 45_000;
const LOCAL_AGENT_REMOTE_BATCH_TIMEOUT_MS = 60_000;
const LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
const LOCAL_AGENT_REMOTE_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
const LOCAL_AGENT_REMOTE_MAX_ITEMS = 4;
const LOCAL_AGENT_REMOTE_GLOBAL_MAX_ITEMS = 8;
const LOCAL_AGENT_REMOTE_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;

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

type LocalAgentMediaDecodeResult =
  | ({ ok: true; kind: 'image' } & Omit<Extract<LocalAgentImageDecodeResult, { ok: true }>, 'ok'>)
  | {
      ok: true;
      kind: 'video';
      buffer: Buffer;
      mimeType: 'video/mp4' | 'video/quicktime' | 'video/x-m4v' | 'video/webm' | 'video/ogg';
      extension: '.mp4' | '.mov' | '.m4v' | '.webm' | '.ogv';
    }
  | { ok: false; reason: 'not_media' | 'too_large' | 'malformed' | 'unsupported_format' | 'invalid_dimensions' };

function normalizedMediaMime(raw: unknown): string {
  const mime = typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : '';
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'video/mov') return 'video/quicktime';
  if (mime === 'video/m4v') return 'video/x-m4v';
  return mime;
}

function mediaKindHint(mime: unknown, name = ''): 'image' | 'video' | null {
  const normalized = normalizedMediaMime(mime);
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  const ext = path.extname(String(name || '').split(/[?#]/, 1)[0]).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext)) return 'video';
  return null;
}

type SupportedMediaExtension =
  '.png' | '.jpg' | '.webp' | '.gif' | '.mp4' | '.mov' | '.m4v' | '.webm' | '.ogv';

function mediaExtensionHint(mime: unknown, name = ''): SupportedMediaExtension | null {
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

function stableRemoteMediaName(uri: string, extension: SupportedMediaExtension): string {
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

function inspectLocalAgentMedia(
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

function decodeLocalAgentMediaData(raw: unknown, declaredMime?: unknown): LocalAgentMediaDecodeResult {
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

function isPublicRemoteMediaIp(address: string): boolean {
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

async function validateRemoteMediaUrl(raw: string): Promise<URL> {
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
  if (isIP(hostname)) {
    if (!isPublicRemoteMediaIp(hostname)) throw new Error('remote media URL resolves to a non-public address');
    return url;
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicRemoteMediaIp(entry.address))) {
    throw new Error('remote media URL resolves to a non-public address');
  }
  return url;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('operation aborted');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function downloadLocalAgentMedia(
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
    const url = await awaitWithAbort(validateRemoteMediaUrl(uri), composed.signal);
    const result = await downloadBinaryWithProxyPolicy(url.toString(), {
      label: 'local agent remote media download',
      signal: composed.signal,
      maxBytes,
      redirect: 'error',
      retries: 0,
      headers: { Accept: kind === 'video' ? 'video/*' : 'image/*' },
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

function resolveTimeoutMs(cli: LocalCliType): number {
  const fallback = BACKEND_TIMEOUT_MS[cli] ?? DEFAULT_TIMEOUT_MS;
  const raw = process.env.ORKAS_LOCAL_AGENT_TIMEOUT_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return fallback;
  return n;
}

/** Kill the CLI when it emits NO events for this long. This is the
 *  actual hang detector (vs the wall cap above). Long quiet stretches
 *  are real — a single Bash tool call sat silent ~10 min downloading a
 *  whisper model — so the default stays comfortably above them.
 *  Override via ORKAS_LOCAL_AGENT_IDLE_KILL_MS; 0 disables. */
const DEFAULT_IDLE_KILL_MS = 30 * 60 * 1000;

/** Idle-kill is meaningless for backends that emit nothing mid-run
 *  (their silence carries no hang signal) — disable it there and rely
 *  on the per-backend wall cap instead. */
const BACKEND_IDLE_KILL_DISABLED: Partial<Record<LocalCliType, boolean>> = {
  openclaw: true,
};

function resolveIdleKillMs(cli: LocalCliType): number | undefined {
  if (BACKEND_IDLE_KILL_DISABLED[cli]) return undefined;
  const raw = process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (n <= 0) return undefined;          // explicit disable
      if (n >= 60_000) return n;             // floor guards against drumming kills
    }
  }
  return DEFAULT_IDLE_KILL_MS;
}

/** How long the runner waits without seeing user-visible backend activity
 *  before emitting an `idle` heartbeat. Content-free synthetic heartbeats
 *  count here while a known reasoning/tool item remains active, but they do
 *  not advance the separate real-activity clock used by the kill watchdog.
 *  The ticker below fires every `IDLE_TICK_MS`; the first emit happens once
 *  the visible-activity age exceeds this threshold. Default 90 s because a
 *  thinking turn between tool calls runs ~10-40 s — 90 s comfortably skips
 *  real activity and catches genuine stalls. */
const DEFAULT_IDLE_MS = 90 * 1000;
const DEFAULT_IDLE_TICK_MS = 30 * 1000;
/** Lower bound on user-supplied / backend-supplied idle thresholds so a
 *  misconfigured value can't drum the rail every second. Tests can
 *  shrink this through `ORKAS_LOCAL_AGENT_IDLE_MIN_MS` to exercise the
 *  heartbeat at a manageable speed; production never sets it. */
const MIN_IDLE_MS_DEFAULT = 30 * 1000;

function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function resolveIdleMs(backendHint: number | undefined): number {
  const minMs = envNum('ORKAS_LOCAL_AGENT_IDLE_MIN_MS') ?? MIN_IDLE_MS_DEFAULT;
  const candidates: Array<number | undefined> = [
    backendHint,
    envNum('ORKAS_LOCAL_AGENT_IDLE_MS'),
  ];
  for (const c of candidates) {
    if (c !== undefined && c >= minMs) return c;
  }
  return Math.max(DEFAULT_IDLE_MS, minMs);
}

function resolveIdleTickMs(idleMs: number): number {
  // Tick at most every 30 s; for very short thresholds (tests, or a
  // future short-idleMs backend) divide so the user sees ~3 pulses
  // before the threshold is reached.
  return Math.min(DEFAULT_IDLE_TICK_MS, Math.max(50, Math.floor(idleMs / 3)));
}

/** Default idle threshold per backend. Override only when the backend
 *  semantics deviate from "streams events through the turn"; openclaw
 *  emits no mid-run stream, so use the normal 90s/30s heartbeat cadence
 *  instead of the older 30s/10s cadence that was too noisy for long runs. */
const BACKEND_IDLE_MS: Partial<Record<LocalCliType, number>> = {
  openclaw: DEFAULT_IDLE_MS,
};

const BACKENDS: Partial<Record<LocalCliType, LocalBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
  opencode: opencodeBackend,
  hermes: hermesBackend,
};

const MAX_PUBLIC_DIAGNOSTIC_CHARS = 4_096;
const MAX_PUBLIC_THINKING_SUMMARY_CHARS = 2_048;
const MAX_PUBLIC_TOOL_PATH_CHARS = 512;
const MAX_PUBLIC_TOOL_INPUT_FILES = 64;
const MAX_PUBLIC_TOOL_INPUT_FIELDS = 64;

const TOOL_COMMAND_INPUT_KEYS = new Set(['command', 'cmd', 'script']);
const TOOL_WEB_INPUT_KEYS = new Set(['href', 'uri', 'url']);
const TOOL_PATH_INPUT_KEYS = new Set([
  'path', 'file', 'file_path', 'filePath', 'filename',
  'dir', 'directory', 'cwd',
  'output_path', 'outputPath', 'input_path', 'inputPath',
  'source_path', 'sourcePath', 'notebook_path', 'notebookPath',
]);
const TOOL_PRIVATE_BODY_KEYS = new Set([
  'body', 'code', 'content', 'contents', 'data', 'description', 'diff',
  'headers', 'html', 'input', 'instructions', 'markdown', 'messages',
  'newstring', 'newtext', 'oldstring', 'oldtext', 'output', 'patch',
  'payload', 'prompt', 'replace', 'replacement', 'result', 'schema',
  'source', 'systemprompt', 'template', 'text',
]);

function sanitizePublicDiagnostic(value: unknown): string {
  const sanitized = redactPaths(sanitizeLogTextForUpload(String(value ?? '')));
  return sanitized.length > MAX_PUBLIC_DIAGNOSTIC_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_DIAGNOSTIC_CHARS)}…`
    : sanitized;
}

/** Reasoning summaries are model-authored progress descriptions, distinct from
 * raw chain-of-thought. Keep the useful summary while applying the same secret
 * and absolute-path filtering as other public CLI diagnostics. */
export function sanitizePublicThinkingSummary(value: unknown): string {
  const sanitized = redactPaths(sanitizeLogTextForUpload(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > MAX_PUBLIC_THINKING_SUMMARY_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_THINKING_SUMMARY_CHARS)}…`
    : sanitized;
}

function compactToolInputKey(value: unknown): string {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isPrivateToolInputKey(key: string): boolean {
  const compact = compactToolInputKey(key);
  return TOOL_PRIVATE_BODY_KEYS.has(compact)
    || [
      'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'privatekey',
      'accesskey', 'clientsecret', 'secret', 'password', 'passwd',
      'credential', 'authorization', 'cookie', 'sessionid', 'signature',
      'token',
    ].some(part => compact === part || compact.endsWith(part));
}

type PublicToolPath = { value: string; ownershipSafe: boolean };

function boundedPublicToolPath(value: unknown, workingDir?: string): PublicToolPath | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(firstLine) || firstLine.startsWith('\\\\');
  const posixAbsolute = firstLine.startsWith('/');
  const windowsWorkingDir = typeof workingDir === 'string'
    && (/^[A-Za-z]:[\\/]/.test(workingDir) || workingDir.startsWith('\\\\'));
  const pathApi = windowsAbsolute || (!posixAbsolute && windowsWorkingDir) ? path.win32 : path.posix;
  const absolute = windowsAbsolute || (pathApi === path.posix && posixAbsolute);
  let publicPath = firstLine;
  let ownershipSafe = true;

  if (absolute) {
    const comparableCwd = typeof workingDir === 'string' && workingDir
      && pathApi.isAbsolute(workingDir)
      ? pathApi.normalize(workingDir)
      : '';
    const relative = comparableCwd
      ? pathApi.relative(comparableCwd, pathApi.normalize(firstLine))
      : '';
    const insideWorkingDir = !!relative
      && relative !== '..'
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative);
    ownershipSafe = insideWorkingDir;
    publicPath = insideWorkingDir ? relative : pathApi.basename(firstLine);
  } else {
    const normalized = pathApi.normalize(firstLine);
    const escapesWorkingDir = normalized === '..'
      || normalized.startsWith(`..${pathApi.sep}`)
      || normalized.startsWith('../')
      || normalized.startsWith('..\\');
    if (escapesWorkingDir) {
      ownershipSafe = false;
      publicPath = path.posix.basename(path.win32.basename(normalized));
    }
  }

  // Relative project paths are useful to the renderer and let the bus retain
  // exact multi-file ownership. Never retain an absolute machine path: paths
  // outside the active cwd collapse to a basename, while paths inside it are
  // expressed relative to that cwd.
  const sanitized = sanitizeLogTextForUpload(publicPath.replace(/\\/g, '/'))
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return {
    value: sanitized.slice(0, MAX_PUBLIC_TOOL_PATH_CHARS),
    ownershipSafe,
  };
}

function addPublicToolPath(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  workingDir?: string,
): void {
  const pathInfo = boundedPublicToolPath(value, workingDir);
  if (!pathInfo) return;
  if (pathInfo.ownershipSafe) {
    target[key] = pathInfo.value;
    return;
  }
  // A basename is still useful in the process rail, but it is not a trusted
  // locator for conversation ownership. Keep it under a display-only key that
  // the renderer understands and the bus deliberately ignores.
  if (typeof target.displayPath !== 'string') {
    target.displayPath = pathInfo.value;
    return;
  }
  const existing = Array.isArray(target.displayPaths)
    ? target.displayPaths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (target.displayPath !== pathInfo.value && !existing.includes(pathInfo.value)) {
    target.displayPaths = [...existing, pathInfo.value];
  }
}

const SENSITIVE_COMMAND_OPTION =
  '(?:--(?:api[-_]?key|x[-_]?api[-_]?key|x[-_]?auth[-_]?token|access[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?id|conversation[-_]?id|client[-_]?secret|private[-_]?key|password|passwd|pwd|secret|token|security[-_]?token|authorization|auth|credential|cookie|set[-_]?cookie|signature|header|user)|-[Hu])';
const SENSITIVE_COMMAND_OPTION_RE = new RegExp(
  `(^|\\s)(${SENSITIVE_COMMAND_OPTION})(\\s*=\\s*|\\s+)("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s;&|]+)`,
  'gi',
);
const SENSITIVE_COMMAND_ATTACHED_SHORT_OPTION_RE = new RegExp(
  `(^|\\s)(-[Hu])("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s;&|]+)`,
  'gi',
);

function redactSeparatedCommandSecrets(value: string): string {
  return value
    .replace(SENSITIVE_COMMAND_OPTION_RE, (_match, prefix: string, flag: string, separator: string) => (
      `${prefix}${flag}${separator}***`
    ))
    // curl and similar CLIs also accept credentials/header values attached to
    // the short flag (`-uuser:pass`, `-H"Authorization: Bearer ..."`). These
    // are distinct argv shapes from the separated form above and must be
    // removed before a tool event can reach cloud-synced process history.
    .replace(SENSITIVE_COMMAND_ATTACHED_SHORT_OPTION_RE, (_match, prefix: string, flag: string) => (
      `${prefix}${flag}***`
    ))
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

function boundedPublicToolCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;
  // Preserve the executable and leaf filename the user needs to identify the
  // action, while removing machine-specific absolute prefixes before the
  // generic diagnostic sanitizer replaces them with opaque path markers.
  const withPublicPaths = firstLine
    .replace(/(["'])((?:\/(?!\/)|[A-Za-z]:[\\/])[^"'\r\n]+)\1/g, (_match, quote, rawPath) => {
      const leaf = path.posix.basename(path.win32.basename(String(rawPath).replace(/\\ /g, ' ')));
      return `${quote}${leaf}${quote}`;
    })
    .replace(/(^|[\s=(:,])((?:\/(?!\/)|[A-Za-z]:[\\/])(?:\\ |[^\s;&|<>()"'])+)/g, (_match, prefix, rawPath) => {
      const leaf = path.posix.basename(path.win32.basename(String(rawPath).replace(/\\ /g, ' ')));
      return `${prefix}${leaf}`;
    });
  const sanitized = sanitizePublicDiagnostic(redactSeparatedCommandSecrets(withPublicPaths))
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || undefined;
}

function boundedPublicToolWebTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;
  const sanitized = sanitizeLogTextForUpload(firstLine)
    // URL user-info can contain credentials but is not query-shaped, so the
    // shared sanitizer deliberately does not catch it.
    .replace(/^(https?:\/\/)[^/@\s]+@/i, '$1***@')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > MAX_PUBLIC_DIAGNOSTIC_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_DIAGNOSTIC_CHARS)}…`
    : sanitized;
}

function sanitizePublicToolFiles(value: unknown, workingDir?: string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: unknown[] = [];
  for (const entry of value.slice(0, MAX_PUBLIC_TOOL_INPUT_FILES)) {
    const direct = boundedPublicToolPath(entry, workingDir);
    if (direct) {
      files.push(direct.ownershipSafe ? direct.value : { displayPath: direct.value });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of ['path', 'file', 'file_path', 'filePath', 'filename']) {
      addPublicToolPath(safe, key, source[key], workingDir);
    }
    if (Object.keys(safe).length) files.push(safe);
  }
  return files.length ? files : undefined;
}

function sanitizePublicToolInput(
  value: unknown,
  workingDir?: string,
  depth = 0,
): unknown {
  if (typeof value === 'string') return boundedPublicToolCommand(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return undefined;

  const source = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source).slice(0, MAX_PUBLIC_TOOL_INPUT_FIELDS)) {
    if (isPrivateToolInputKey(key)) continue;
    if (TOOL_COMMAND_INPUT_KEYS.has(key)) {
      const command = boundedPublicToolCommand(raw);
      if (command) safe[key] = command;
      continue;
    }
    if (TOOL_PATH_INPUT_KEYS.has(key)) {
      addPublicToolPath(safe, key, raw, workingDir);
      continue;
    }
    if (TOOL_WEB_INPUT_KEYS.has(key)) {
      const webTarget = boundedPublicToolWebTarget(raw);
      if (webTarget) safe[key] = webTarget;
      continue;
    }
    if (key === 'files') {
      const files = sanitizePublicToolFiles(raw, workingDir);
      if (files) safe.files = files;
      continue;
    }
    if (typeof raw === 'string') {
      const metadata = boundedPublicToolCommand(raw);
      if (metadata) safe[key] = metadata;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      safe[key] = raw;
    } else if (typeof raw === 'boolean') {
      safe[key] = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = sanitizePublicToolInput(raw, workingDir, depth + 1);
      if (nested && Object.keys(nested as Record<string, unknown>).length) safe[key] = nested;
    }
  }
  return safe;
}

/** Strip raw reasoning and machine diagnostics before events cross the runner
 * boundary. A backend may explicitly mark a model-authored reasoning summary;
 * it is bounded/redacted here while raw `text` is always removed. Persistence,
 * devtools archives, and the process rail receive only the allow-listed shape.
 * User-authored answer and tool result events remain intact because those are
 * intentional task output. */
export function redactPrivateLocalAgentEvent(event: LocalEvent, workingDir?: string): LocalEvent {
  if (!event) return event;
  if (event.type === 'thinking') {
    const rawChars = typeof event.text === 'string' ? event.text.length : Number(event.chars);
    const chars = Number.isFinite(rawChars) && rawChars > 0 ? Math.round(rawChars) : 0;
    const itemId = typeof event.itemId === 'string' && event.itemId
      ? event.itemId
      : undefined;
    const summary = sanitizePublicThinkingSummary(event.summary);
    return {
      type: 'thinking',
      chars,
      ...(summary ? { summary } : {}),
      ...(itemId ? { itemId } : {}),
      ...(event.heartbeat === true ? { heartbeat: true } : {}),
      ...(event.synthetic === true ? { synthetic: true } : {}),
    };
  }
  if (event.type === 'process-info') {
    const rawCommand = typeof event.cmd === 'string' ? event.cmd : '';
    const command = path.posix.basename(path.win32.basename(rawCommand));
    return {
      type: 'process-info',
      pid: event.pid,
      cmd: command || 'cli',
      argCount: Array.isArray(event.args) ? event.args.length : 0,
    };
  }
  if (event.type === 'tool-event') {
    const { input: _privateInput, ...rest } = event;
    const input = sanitizePublicToolInput(event.input, workingDir);
    return {
      ...rest,
      ...(input !== undefined ? { input } : {}),
      ...(typeof event.error === 'string'
        ? { error: sanitizePublicDiagnostic(event.error) }
        : {}),
    };
  }
  if (event.type === 'stderr-line' || event.type === 'raw-line') {
    return { ...event, line: sanitizePublicDiagnostic(event.line) };
  }
  if (event.type === 'log') {
    return { ...event, message: sanitizePublicDiagnostic(event.message) };
  }
  if (event.type === 'done') {
    return {
      ...event,
      ...(typeof event.error === 'string'
        ? { error: sanitizePublicDiagnostic(event.error) }
        : {}),
      ...(typeof event.stderrTail === 'string'
        ? { stderrTail: sanitizePublicDiagnostic(event.stderrTail) }
        : {}),
    };
  }
  return event;
}

/** CLIs with a supported MCP-config injection path (claude:
 *  `--mcp-config`; codex: `-c mcp_servers.…`). Others run without the
 *  bridge until an injection mechanism exists for them. */
function _bridgeSupported(cli: LocalCliType): boolean {
  return localCliCapabilities(cli).orkasBridge;
}

/** Appended to the CLI agent's system prompt when the bridge is live.
 * Runtime-generated (not a tracked prompt md). It is compiled from the exact
 * per-run capability manifest so an unavailable category is neither advertised
 * nor left to fail only after the model selects it. */
export function buildBridgeSystemPrompt(capabilities: readonly BridgeCapability[]): string {
  const granted = new Set(capabilities);
  const sentences = [
    'You are running inside Orkas, the user\'s agent workspace. An MCP server named "orkas" is connected with a run-scoped capability allowlist.',
  ];
  if (granted.has('skills.read') || granted.has('skills.run')) {
    sentences.push(
      'It lists and reads the user\'s granted Orkas skills (orkas_list_skills / orkas_read_skill)'
      + `${granted.has('skills.run') ? ' and can run their packaged scripts (orkas_run_skill)' : ''}.`,
    );
  }
  if (granted.has('connectors')) {
    sentences.push(
      'It reaches the same connected services available to an ordinary Orkas group-chat Agent '
      + '(orkas_list_connector_tools / orkas_call_connector_tool); calls may wait for the user to approve a permission prompt in Orkas.',
    );
  }
  if (granted.has('kb.read')) {
    sentences.push('It browses and searches the granted knowledge base with library actions list / search / read.');
  }
  if (granted.has('chat.read')) {
    sentences.push(
      'It exposes chat_history actions search / read for quoted history from this conversation only. '
      + 'Use the conversation context supplied in the current prompt before these tools. Query only when exact needed context was omitted by the bounded '
      + 'history block or the user explicitly asks for a lookup. Use small pages with page mode latest, then follow the returned before hint. '
      + 'Use action=search only when a useful name, phrase, id, or fact is available.',
    );
  }
  if (granted.has('commander.handoff')) {
    sentences.push(
      'For Commander-only work—Orkas automation CRUD, Orkas Agent or Skill mutation, cross-Agent orchestration, or a user decision outside this CLI capability— '
      + 'call orkas_handoff_to_commander with the concrete reason and continuation context, then end the turn. '
      + 'Do not emit Commander-only <auto-task>, <agent>, or <skill> mutation containers from a CLI reply.',
    );
  }
  sentences.push('Use only the registered bridge tools and prefer them when the task involves a granted Orkas capability or referenced context.');
  return sentences.join(' ');
}

type LocalToolRunCounter = {
  use: number;
  result: number;
  other: number;
};

type LocalToolTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  tool: string;
  phase: 'use' | 'result' | 'other';
  call_id?: string;
  is_error?: boolean;
  output_chars?: number;
  spilled?: boolean;
};

type LocalEventTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  event: string;
  detail?: string;
};

/** Did resuming this session consume the user's message without answering it?
 *
 *  A CLI resumed onto a session that was interrupted mid-flight can spend its
 *  turn digesting that half-written state and end without calling the model at
 *  all — the user's message goes in and nothing comes back, and the host would
 *  report "the model returned nothing". The message is simply gone.
 *
 *  Zero usage is the discriminator that makes this safe to act on: a model that
 *  chose to stay silent still burned tokens, so it is never mistaken for this.
 *  The stop record is what the recovery digest emits while clearing the old
 *  session's live work, and a fresh session cannot swallow a resumed input at
 *  all — together they keep an ordinary quiet turn from being resent.
 */
export function resumeConsumedTheTurn(observed: {
  attemptedResume: boolean;
  status?: string;
  outputChars: number;
  usageTokens: number;
  sawBackgroundStopped: boolean;
}): boolean {
  if (!observed.attemptedResume) return false;
  if (observed.status !== 'completed') return false;
  if (observed.outputChars > 0) return false;
  if (observed.usageTokens > 0) return false;
  return observed.sawBackgroundStopped;
}

/** Tokens a run actually spent, from the terminal event's usage. Unknown or
 *  malformed usage counts as spent so a quiet turn is never resent on a guess. */
export function runUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 1;
  const row = usage as Record<string, unknown>;
  let total = 0;
  let sawNumber = false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreate']) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) { total += Math.max(0, value); sawNumber = true; }
  }
  if (!sawNumber) {
    const cost = Number(row.cost);
    return Number.isFinite(cost) ? (cost > 0 ? 1 : 0) : 1;
  }
  return total;
}

export interface LocalAgentRunLogDiagnostics {
  startedAtMs: number;
  eventCount: number;
  eventTypes: Record<string, number>;
  textDeltaChars: number;
  thinkingChars: number;
  stderrLines: number;
  stderrChars: number;
  rawLines: number;
  rawChars: number;
  idleEvents: number;
  maxIdleStalledMs: number;
  permissionRequests: number;
  permissionAutoAllow: number;
  permissionAutoDeny: number;
  fileChangeEvents: number;
  fileChangePathCount: number;
  logLevels: Record<string, number>;
  toolEvents: number;
  toolResultEvents: number;
  spilledToolResults: number;
  toolCounts: Record<string, LocalToolRunCounter>;
  firstEventMs?: number;
  firstTextDeltaMs?: number;
  firstToolMs?: number;
  doneEventMs?: number;
  terminalStatus?: string;
  terminalError: boolean;
  usage?: Record<string, number>;
  toolTimeline: LocalToolTimelineLogEntry[];
  toolTimelineTruncated: number;
  eventTimeline: LocalEventTimelineLogEntry[];
  eventTimelineTruncated: number;
  textDeltaTimelineRecorded: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function safeUsageForLog(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const allowed = new Set([
    'input', 'output', 'total',
    'inputTokens', 'outputTokens', 'totalTokens',
    'cacheRead', 'cacheCreate', 'cacheWrite',
    'cacheReadTokens', 'cacheWriteTokens',
    'costUsd', 'totalCostUsd',
  ]);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const n = finiteNumber(raw);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createLocalAgentRunLogDiagnostics(nowMs = Date.now()): LocalAgentRunLogDiagnostics {
  return {
    startedAtMs: nowMs,
    eventCount: 0,
    eventTypes: {},
    textDeltaChars: 0,
    thinkingChars: 0,
    stderrLines: 0,
    stderrChars: 0,
    rawLines: 0,
    rawChars: 0,
    idleEvents: 0,
    maxIdleStalledMs: 0,
    permissionRequests: 0,
    permissionAutoAllow: 0,
    permissionAutoDeny: 0,
    fileChangeEvents: 0,
    fileChangePathCount: 0,
    logLevels: {},
    toolEvents: 0,
    toolResultEvents: 0,
    spilledToolResults: 0,
    toolCounts: {},
    terminalError: false,
    toolTimeline: [],
    toolTimelineTruncated: 0,
    eventTimeline: [],
    eventTimelineTruncated: 0,
    textDeltaTimelineRecorded: false,
  };
}

function noteElapsedOnce(target: LocalAgentRunLogDiagnostics, key: keyof LocalAgentRunLogDiagnostics, nowMs: number): void {
  if (target[key] !== undefined) return;
  (target as unknown as Record<string, unknown>)[key as string] = Math.max(0, nowMs - target.startedAtMs);
}

function localToolCounter(stats: LocalAgentRunLogDiagnostics, rawName: unknown): LocalToolRunCounter {
  const name = String(rawName || 'unknown').slice(0, 80) || 'unknown';
  if (!stats.toolCounts[name]) stats.toolCounts[name] = { use: 0, result: 0, other: 0 };
  return stats.toolCounts[name];
}

const MAX_TOOL_TIMELINE_LOG_ENTRIES = 80;
const MAX_EVENT_TIMELINE_LOG_ENTRIES = 120;

function safeToolNameForLog(rawName: unknown): string {
  return String(rawName || 'unknown').slice(0, 80) || 'unknown';
}

function safeLocalToolPhaseForLog(rawPhase: unknown): LocalToolTimelineLogEntry['phase'] {
  const phase = String(rawPhase || '');
  if (phase === 'use' || phase === 'result') return phase;
  return 'other';
}

function noteLocalToolTimelineForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs: number): void {
  if (stats.toolTimeline.length >= MAX_TOOL_TIMELINE_LOG_ENTRIES) {
    stats.toolTimelineTruncated += 1;
    return;
  }
  const phase = safeLocalToolPhaseForLog(e.phase);
  const entry: LocalToolTimelineLogEntry = {
    seq: stats.toolTimeline.length + stats.toolTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    tool: safeToolNameForLog(e.tool),
    phase,
  };
  const callId = e.callId;
  if (callId !== undefined && callId !== null && String(callId)) entry.call_id = maskId(callId);
  const isError = !!e.isError || !!e.error;
  if (isError) entry.is_error = true;
  if (phase === 'result') {
    if (typeof e.output === 'string') entry.output_chars = e.output.length;
    entry.spilled = !!(e.outputPath || e.outputRef);
  }
  stats.toolTimeline.push(entry);
}

function noteLocalEventTimelineForLog(
  stats: LocalAgentRunLogDiagnostics,
  event: string,
  nowMs: number,
  detail?: string,
): void {
  if (stats.eventTimeline.length >= MAX_EVENT_TIMELINE_LOG_ENTRIES) {
    stats.eventTimelineTruncated += 1;
    return;
  }
  stats.eventTimeline.push({
    seq: stats.eventTimeline.length + stats.eventTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    event,
    ...(detail ? { detail } : {}),
  });
}

function formatLocalEventTimelineEntryForLog(entry: LocalEventTimelineLogEntry): string {
  return [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.event,
    entry.detail,
  ].filter(Boolean).join(' ');
}

function formatLocalToolTimelineEntryForLog(entry: LocalToolTimelineLogEntry): string {
  const parts = [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.tool,
    entry.phase,
  ];
  if (entry.call_id) parts.push(`call=${entry.call_id}`);
  if (entry.is_error !== undefined) parts.push(`error=${entry.is_error ? 'true' : 'false'}`);
  if (entry.output_chars !== undefined) parts.push(`output_chars=${entry.output_chars}`);
  if (entry.spilled !== undefined) parts.push(`spilled=${entry.spilled ? 'true' : 'false'}`);
  return parts.join(' ');
}

export function recordLocalAgentEventForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs = Date.now()): void {
  if (!stats || !e) return;
  stats.eventCount += 1;
  stats.eventTypes[e.type] = (stats.eventTypes[e.type] || 0) + 1;
  noteElapsedOnce(stats, 'firstEventMs', nowMs);

  switch (e.type) {
    case 'process-info':
      noteLocalEventTimelineForLog(stats, 'process_info', nowMs, `pid=${finiteNumber(e.pid) ?? 'unknown'}`);
      break;
    case 'text-delta':
      stats.textDeltaChars += typeof e.text === 'string' ? e.text.length : 0;
      noteElapsedOnce(stats, 'firstTextDeltaMs', nowMs);
      if (!stats.textDeltaTimelineRecorded) {
        stats.textDeltaTimelineRecorded = true;
        noteLocalEventTimelineForLog(stats, 'text_delta', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      }
      break;
    case 'thinking':
      {
        const rawChars = typeof e.text === 'string' ? e.text.length : Number(e.chars);
        const chars = Number.isFinite(rawChars) && rawChars > 0 ? Math.round(rawChars) : 0;
        stats.thinkingChars += chars;
        noteLocalEventTimelineForLog(stats, 'thinking', nowMs, `chars=${chars}`);
      }
      break;
    case 'stderr-line':
      stats.stderrLines += 1;
      stats.stderrChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.stderrLines === 1) noteLocalEventTimelineForLog(stats, 'stderr_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'raw-line':
      stats.rawLines += 1;
      stats.rawChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.rawLines === 1) noteLocalEventTimelineForLog(stats, 'raw_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'idle': {
      stats.idleEvents += 1;
      const stalledMs = finiteNumber(e.stalledMs) || 0;
      stats.maxIdleStalledMs = Math.max(stats.maxIdleStalledMs, stalledMs);
      noteLocalEventTimelineForLog(stats, 'idle', nowMs, `stalled_ms=${stalledMs}`);
      break;
    }
    case 'permission-request':
      stats.permissionRequests += 1;
      if (e.autoDecided === 'allow') stats.permissionAutoAllow += 1;
      if (e.autoDecided === 'deny') stats.permissionAutoDeny += 1;
      noteLocalEventTimelineForLog(
        stats,
        'permission_request',
        nowMs,
        `tool=${safeToolNameForLog(e.tool)} auto=${String(e.autoDecided || 'manual')}`,
      );
      break;
    case 'file-change':
      stats.fileChangeEvents += 1;
      stats.fileChangePathCount += Array.isArray(e.paths) ? e.paths.length : 0;
      noteLocalEventTimelineForLog(stats, 'file_change', nowMs, `paths=${Array.isArray(e.paths) ? e.paths.length : 0}`);
      break;
    case 'log': {
      const level = String(e.level || 'info').toLowerCase();
      stats.logLevels[level] = (stats.logLevels[level] || 0) + 1;
      noteLocalEventTimelineForLog(stats, 'log', nowMs, `level=${level}`);
      break;
    }
    case 'tool-event': {
      stats.toolEvents += 1;
      const counter = localToolCounter(stats, e.tool);
      const phase = String(e.phase || '');
      if (phase === 'use') counter.use += 1;
      else if (phase === 'result') {
        counter.result += 1;
        stats.toolResultEvents += 1;
        if (e.outputPath || e.outputRef) stats.spilledToolResults += 1;
      } else {
        counter.other += 1;
      }
      noteLocalToolTimelineForLog(stats, e, nowMs);
      noteLocalEventTimelineForLog(stats, 'tool_event', nowMs, `tool=${safeToolNameForLog(e.tool)} phase=${safeLocalToolPhaseForLog(e.phase)}`);
      noteElapsedOnce(stats, 'firstToolMs', nowMs);
      break;
    }
    case 'status':
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'status', nowMs, `status=${String(e.status || '')}`);
      break;
    case 'done':
      noteElapsedOnce(stats, 'doneEventMs', nowMs);
      stats.terminalStatus = typeof e.status === 'string' ? e.status : stats.terminalStatus;
      stats.terminalError = !!e.error;
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'done', nowMs, `status=${String(e.status || '')} error=${e.error ? 'true' : 'false'}`);
      break;
    default:
      break;
  }
}

export function summarizeLocalAgentRunForLog(stats: LocalAgentRunLogDiagnostics, nowMs = Date.now()): Record<string, unknown> {
  return {
    durationMs: Math.max(0, nowMs - stats.startedAtMs),
    eventCount: stats.eventCount,
    eventTypes: stats.eventTypes,
    textDeltaChars: stats.textDeltaChars,
    thinkingChars: stats.thinkingChars,
    stderrLines: stats.stderrLines,
    stderrChars: stats.stderrChars,
    rawLines: stats.rawLines,
    rawChars: stats.rawChars,
    idleEvents: stats.idleEvents,
    maxIdleStalledMs: stats.maxIdleStalledMs,
    permissionRequests: stats.permissionRequests,
    permissionAutoAllow: stats.permissionAutoAllow,
    permissionAutoDeny: stats.permissionAutoDeny,
    fileChangeEvents: stats.fileChangeEvents,
    fileChangePathCount: stats.fileChangePathCount,
    logLevels: stats.logLevels,
    toolEvents: stats.toolEvents,
    toolResultEvents: stats.toolResultEvents,
    spilledToolResults: stats.spilledToolResults,
    toolNames: Object.keys(stats.toolCounts).sort(),
    toolCounts: stats.toolCounts,
    toolTimeline: stats.toolTimeline.map(formatLocalToolTimelineEntryForLog),
    toolTimelineTruncated: stats.toolTimelineTruncated,
    eventTimeline: stats.eventTimeline.map(formatLocalEventTimelineEntryForLog),
    eventTimelineTruncated: stats.eventTimelineTruncated,
    firstEventMs: stats.firstEventMs,
    firstTextDeltaMs: stats.firstTextDeltaMs,
    firstToolMs: stats.firstToolMs,
    doneEventMs: stats.doneEventMs,
    terminalStatus: stats.terminalStatus,
    terminalError: stats.terminalError,
    usage: stats.usage,
  };
}

export function localAgentRunContextForLog(opts: {
  uid?: string;
  cid?: string;
  agentId?: string;
  projectId?: string;
  cli?: LocalCliType;
  customArgs?: readonly string[];
  resumeSessionId?: string;
  prompt?: string;
  systemPrompt?: string;
  resumeFallbackPrompt?: string;
  reuseSessionInstructions?: boolean;
  cwd?: string;
  runId?: string;
  cliAvailable?: boolean;
  cliVersion?: string | null;
  bridgeSupported?: boolean;
  timeoutMs?: number;
  idleKillMs?: number;
  idleMs?: number;
}): Record<string, unknown> {
  return {
    run_id: maskId(opts.runId),
    user_id: maskId(opts.uid),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    project_id: maskId(opts.projectId),
    cli: opts.cli,
    cli_available: opts.cliAvailable,
    cli_version: opts.cliVersion || undefined,
    bridge_supported: opts.bridgeSupported,
    custom_arg_count: opts.customArgs?.length || 0,
    has_resume_session: !!opts.resumeSessionId,
    prompt_chars: String(opts.prompt || '').length,
    system_prompt_chars: String(opts.systemPrompt || '').length,
    resume_fallback_chars: String(opts.resumeFallbackPrompt || '').length,
    reuse_session_instructions: !!opts.reuseSessionInstructions,
    has_cwd: !!opts.cwd,
    cwd: opts.cwd ? logPathRef(opts.cwd) : undefined,
    timeout_ms: opts.timeoutMs,
    idle_kill_ms: opts.idleKillMs,
    idle_ms: opts.idleMs,
  };
}

export interface RunCliAgentOpts {
  uid: string;
  cid: string;
  agentId: string;
  /** Display name for permission dialogs; falls back to agentId. */
  agentName?: string;
  /** Inbound conversation message that triggered this run. */
  currentMessageId: string;
  /** Conversation project scope, when the CLI turn belongs to a project. */
  projectId?: string;
  cli: LocalCliType;
  customArgs?: string[];
  modelOverride?: string;
  thinkingLevel?: string;
  /** If set, the dispatch resumes a CLI-side session (claude
   *  `--resume <id>`) and the caller has already trimmed the prompt
   *  to "just the new turn" content — the CLI provides the prior
   *  context out of its own memory. The caller only sets this for a
   *  backend whose registry capability supports continuation. */
  resumeSessionId?: string;
  prompt: string;
  systemPrompt?: string;
  resumeFallbackPrompt?: string;
  reuseSessionInstructions?: boolean;
  cwd: string;
  signal: AbortSignal;
  /** Forwarded each backend event verbatim, after persistence. */
  onEvent: (e: LocalEvent) => void;
  /** Active native-turn ingress lifecycle. The runner forwards backend
   * readiness and guarantees a final clear even when a backend throws. */
  onActiveRunIngress?: (ingress: LocalActiveRunIngress | null) => void;
}

export interface RunCliAgentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'missing_cli';
  output?: string;
  error?: string;
  cliError?: LocalCliEntry['error'];
  cliPath?: string;
  cliVersion?: string;
  commanderHandoff?: CommanderHandoffRequest;
  timeoutPhase?: 'foreground' | 'background';
}

/** Active background phases held so app shutdown cannot orphan their detached
 *  CLI process groups. Their conversation turns remain active independently. */
const backgroundRuns = new Set<{
  stop: (reason: string) => void;
  untilProcessExit: Promise<void>;
}>();

interface BackgroundMediaDownload {
  uid: string;
  cid: string;
  reservedBytes: number;
  abort: (reason: string) => void;
  done: Promise<void>;
}

const backgroundMediaDownloads = new Map<string, BackgroundMediaDownload>();
let backgroundMediaReservedBytes = 0;

function linkedAbortSignal(...parents: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners = parents.map((parent) => {
    const onAbort = () => {
      const reason = (parent as AbortSignal & { reason?: unknown }).reason;
      if (!controller.signal.aborted) controller.abort(reason || new Error('operation aborted'));
    };
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
    return { parent, onAbort };
  });
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { parent, onAbort } of listeners) parent.removeEventListener('abort', onAbort);
    },
  };
}

function broadcastMaterializedRemoteMedia(payload: {
  uid: string;
  cid: string;
  remoteUrl: string;
  localUrl: string;
  kind: 'image' | 'video';
}): void {
  try {
    // Keep Electron and account state out of the runner's test/module-load
    // path. A stale account must never receive another user's signed URL.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const users = require('../users') as typeof import('../users');
    if (!users.hasActiveUser() || users.getActiveUserId() !== payload.uid) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('conversation:media_materialized', {
          user_id: payload.uid,
          conversation_id: payload.cid,
          remote_url: payload.remoteUrl,
          local_url: payload.localUrl,
          media_kind: payload.kind,
        });
      } catch { /* another live window can still receive the update */ }
    }
  } catch { /* app/window already gone */ }
}

registerUserSwitchHook('local-agent-media-downloads', (previousUid) => {
  for (const entry of backgroundMediaDownloads.values()) {
    if (entry.uid === previousUid) entry.abort('the active user changed');
  }
});

/** Stop media work owned by a conversation without delaying deletion. The
 * attachment writer's deletion lock remains the final guard against a response
 * that had already crossed its abort boundary. */
export function cancelBackgroundMediaForConversation(
  uid: string,
  cid: string,
  reason = 'the conversation was deleted',
): number {
  let cancelled = 0;
  for (const entry of backgroundMediaDownloads.values()) {
    if (entry.uid !== uid || entry.cid !== cid) continue;
    entry.abort(reason);
    cancelled += 1;
  }
  return cancelled;
}

/** End every active background run and wait, bounded. */
export async function stopBackgroundRuns(reason: string, deadlineMs = 5_000): Promise<number> {
  const entries = [...backgroundRuns];
  const mediaEntries = [...backgroundMediaDownloads.values()];
  const total = entries.length + mediaEntries.length;
  if (!total) return 0;
  log.info('stopping background local agent work', {
    reason,
    run_count: entries.length,
    media_count: mediaEntries.length,
  });
  for (const entry of entries) {
    try { entry.stop(reason); }
    catch (err) { log.warn('background run stop failed', { error: logErrorSummary(err) }); }
  }
  for (const entry of mediaEntries) entry.abort(reason);
  await Promise.race([
    Promise.all([
      ...entries.map(entry => entry.untilProcessExit),
      ...mediaEntries.map(entry => entry.done),
    ]),
    new Promise(resolve => { setTimeout(resolve, Math.max(0, deadlineMs)).unref?.(); }),
  ]);
  return total;
}


export async function run(opts: RunCliAgentOpts): Promise<RunCliAgentResult> {
  const backend = BACKENDS[opts.cli];
  let runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    resumeFallbackPrompt: opts.resumeFallbackPrompt,
    reuseSessionInstructions: opts.reuseSessionInstructions,
    cwd: opts.cwd,
    bridgeSupported: _bridgeSupported(opts.cli),
  });
  if (!backend) {
    log.warn('local agent backend missing', runLogContext);
    const err = `local CLI backend not implemented: ${opts.cli}`;
    opts.onEvent({ type: 'done', status: 'failed', error: err });
    return { runId: '', status: 'failed', error: err };
  }

  // Pre-flight probe (cache-busting). A user might have uninstalled
  // the CLI between create-time detection and now.
  const entry = await detectOne(opts.cli);
  if (!entry.available || !entry.path) {
    return _missing(opts, entry);
  }

  const timeoutMs = resolveTimeoutMs(opts.cli);
  const idleKillMs = resolveIdleKillMs(opts.cli);
  const idleThresholdMs = resolveIdleMs(BACKEND_IDLE_MS[opts.cli]);

  const handle = await persist.start(opts.uid, {
    agentId: opts.agentId,
    cid: opts.cid,
    cli: opts.cli,
    cliPath: entry.path,
    prompt: opts.prompt,
  });
  const startedAtMs = Date.now();
  const runDiagnostics = createLocalAgentRunLogDiagnostics(startedAtMs);
  const startedAtIso = new Date(startedAtMs).toISOString();
  runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    resumeFallbackPrompt: opts.resumeFallbackPrompt,
    reuseSessionInstructions: opts.reuseSessionInstructions,
    cwd: opts.cwd,
    runId: handle.runId,
    cliAvailable: entry.available,
    cliVersion: entry.version,
    bridgeSupported: _bridgeSupported(opts.cli),
    timeoutMs,
    idleKillMs,
    idleMs: idleThresholdMs,
  });
  log.info('local agent run start', runLogContext);

  // Wrapper writes events to disk before forwarding upstream so that
  // a renderer crash mid-run still leaves a complete jsonl trail.
  let streamedOutput = '';
  let terminal: {
    status: RunCliAgentResult['status'];
    output?: string;
    error?: string;
    sessionId?: string;
    timeoutPhase?: 'foreground' | 'background';
    // Read to tell a turn the model never ran from one it chose to end quietly.
    usage?: unknown;
  } | null = null;
  // CLI dispatch session id. The per-session spill dir is anchored on this
  // so sweep / read paths can find the file again.
  const cliSessionId = `cli-${opts.cli}-${handle.runId}`;
  const spillDir = sessionToolResultsDir(opts.uid, cliSessionId);
  const toolStartedAtByCallId = new Map<string, number>();
  const materializedMediaKeys = new Set<string>();
  let backgroundMediaQueue: Promise<void> = Promise.resolve();
  let remoteMediaScheduledCount = 0;
  let remoteMediaReservedBytes = 0;
  let remoteMediaDeadlineAt = 0;
  let lastBackendEventAt = Date.now();
  let lastVisibleActivityAt = lastBackendEventAt;
  const bridgeSkillRefByCallId = new Map<string, string>();
  let bridge: BridgeHandle | null = null;
  let inspectResumeAttempt = !!(opts.resumeSessionId && opts.resumeFallbackPrompt);
  let resumeRejected = false;
  let resumeAttemptExecuted = false;
  // The recovery digest emits this while clearing the interrupted session's
  // live work; it is what separates a consumed turn from a quiet one.
  let sawBackgroundStopped = false;
  // A resumed turn's terminal is held until we know whether the resume answered
  // it. Wider than the recovery check below, which also needs a fallback prompt.
  let holdTerminalForResumeCheck = !!opts.resumeSessionId;
  let resendAttempted = false;
  let deferredDone: LocalEvent | null = null;
  const setTerminal = (e: LocalEvent) => {
    terminal = {
      status: (e.status as RunCliAgentResult['status']) || 'failed',
      output: typeof e.output === 'string' ? e.output : undefined,
      error: typeof e.error === 'string' ? e.error : undefined,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
      timeoutPhase: e.timeoutPhase === 'background' ? 'background'
        : (e.timeoutPhase === 'foreground' ? 'foreground' : undefined),
      usage: e.usage,
    };
  };
  const materializeMediaItem = (
    raw: unknown,
  ): LocalAgentMediaDecodeResult => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'not_media' };
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.data === 'string' && item.data.trim()) {
      return decodeLocalAgentMediaData(item.data, item.mediaType);
    }
    if (typeof item.uri !== 'string' || !item.uri.trim()) return { ok: false, reason: 'not_media' };
    const uri = item.uri.trim();
    if (uri.toLowerCase().startsWith('data:')) {
      return decodeLocalAgentMediaData(uri, item.mediaType);
    }
    let candidate: string;
    try {
      if (uri.toLowerCase().startsWith('file:')) candidate = fileURLToPath(uri);
      else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return { ok: false, reason: 'unsupported_format' };
      else candidate = path.isAbsolute(uri) ? uri : path.resolve(opts.cwd, uri);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!isPathAllowed(candidate, [opts.cwd])) return { ok: false, reason: 'unsupported_format' };
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return { ok: false, reason: 'not_media' };
      const cap = mediaKindHint(item.mediaType, candidate) === 'video'
        ? LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES
        : MAX_IMAGE_ATTACHMENT_BYTES;
      if (stat.size > cap) return { ok: false, reason: 'too_large' };
      return inspectLocalAgentMedia(fs.readFileSync(candidate), item.mediaType, candidate);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  };
  const commitEvent = (e: LocalEvent): void => {
    const eventAtMs = Date.now();
    let generatedFileEvent: LocalEvent | null = null;
    // Every non-idle event is visible activity. Synthetic heartbeats therefore
    // keep a known active reasoning/tool item out of the user-facing
    // "unresponsive" state. They still do not prove that the CLI produced new
    // bytes, so only real protocol/process activity may slide the independent
    // hang deadline; otherwise a wedged Codex item could pulse forever.
    if (e.type !== 'idle') lastVisibleActivityAt = eventAtMs;
    if (e.type !== 'idle' && e.synthetic !== true) lastBackendEventAt = eventAtMs;
    if (e.type === 'tool-event') {
      const callId = String(e.callId || '').trim();
      const phase = String(e.phase || '').toLowerCase();
      if (callId && phase === 'use' && !toolStartedAtByCallId.has(callId)) {
        toolStartedAtByCallId.set(callId, eventAtMs);
      } else if (callId && phase === 'result') {
        const startedAt = toolStartedAtByCallId.get(callId);
        const suppliedDuration = Number(e.durationMs);
        const hasSuppliedDuration = e.durationMs != null
          && Number.isFinite(suppliedDuration)
          && suppliedDuration >= 0;
        if (!hasSuppliedDuration && startedAt != null) {
          // Normalize per-call timing once at the runner boundary so every CLI
          // adapter gets the same live and persisted process presentation.
          e.durationMs = Math.max(0, eventAtMs - startedAt);
        }
        toolStartedAtByCallId.delete(callId);
      }
    }
    // Codex app-server returns `imageGeneration.result` as a bare Base64 PNG,
    // not a path. Materialize it into the active conversation's synced media
    // pool before the generic oversized-result spill can turn those bytes into
    // an opaque .txt diagnostic. The synthetic file event then enters the
    // same produced-file ownership path as native CLI writes.
    if (
      opts.cli === 'codex'
      && e.type === 'tool-event'
      && String(e.tool || '').toLowerCase() === 'image_generation'
      && String(e.phase || '').toLowerCase() === 'result'
    ) {
      const decoded = decodeCodexGeneratedImageResult(e.output);
      const callId = String(e.callId || '').trim();
      if (decoded.ok && callId && materializedMediaKeys.has(callId)) {
        e.output = 'Generated PNG image was already materialized for this tool call.';
      } else if (decoded.ok) {
        const saved = saveGeneratedImageAttachment(
          opts.uid,
          opts.cid,
          decoded.buffer,
          `codex-generated-image${decoded.extension}`,
        );
        if (saved.ok) {
          if (callId) materializedMediaKeys.add(callId);
          e.output = `Generated PNG image (${decoded.width}×${decoded.height}, ${decoded.buffer.length} bytes).`;
          generatedFileEvent = {
            type: 'file-change',
            paths: [saved.absPath],
            scope: 'conversation-media',
            source: 'image_generation',
            synthetic: true,
          };
        } else {
          e.output = 'Generated image could not be saved by Orkas.';
          e.error = 'generated_image_save_failed';
          log.warn('codex generated image save failed', {
            ...runLogContext,
            error: logErrorRef(new Error('error' in saved ? saved.error : 'unknown generated image save failure')),
          });
        }
      } else if ('reason' in decoded && decoded.reason !== 'not_image') {
        e.output = `Generated image result was rejected by Orkas (${decoded.reason}).`;
        e.error = `generated_image_${decoded.reason}`;
        log.warn('codex generated image rejected', {
          ...runLogContext,
          reason: decoded.reason,
        });
      }
    }
    // Tool-event result phase: spill oversized output to disk before
    // it lands in events.jsonl / the renderer stream. Above the estimated
    // inline-token budget the raw output bloats the persistence log and the
    // renderer memory; the spill keeps a bounded preview inline (matching
    // the in-process tool-result spill format) and exposes an opaque
    // content ref for click-to-expand. Backends don't know
    // about this — they always emit the full output.
    if (e.type === 'tool-event' && (e as any).phase === 'result' && typeof (e as any).output === 'string') {
      const { output, outputPath } = maybeSpillToolResult({
        toolResultsDir: spillDir,
        toolName: String((e as any).tool || 'tool'),
        callId: String((e as any).callId || ''),
        output: (e as any).output as string,
      });
      // Rewrite in place so the persisted event and the forwarded
      // event match exactly — no divergence between disk replay and
      // live render.
      (e as any).output = output;
      if (outputPath) {
        // Conversation process events are cloud-synced. Persist only the
        // content-addressed opaque ref; the absolute machine-local path stays
        // behind the active-user IPC resolver.
        (e as any).outputRef = toolResultRefForPath(outputPath);
      }
    }
    recordLocalAgentEventForLog(runDiagnostics, e);
    persist.append(handle, e);
    if (e.type === 'text-delta' && typeof e.text === 'string') {
      streamedOutput += e.text;
      persist.appendOutput(handle, e.text);
    }
    if (e.type === 'done') {
      setTerminal(e);
    }
    opts.onEvent(e);
    if (generatedFileEvent) commitEvent(generatedFileEvent);
  };
  const scheduleRemoteMediaDownload = (args: {
    uri: string;
    declaredMime: unknown;
    sourceName: string;
    localName: string;
    extension: SupportedMediaExtension;
    kind: 'image' | 'video';
    source: string;
  }): boolean => {
    let parsed: URL;
    try { parsed = new URL(args.uri); }
    catch { return false; }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (
      parsed.protocol !== 'https:'
      || parsed.username || parsed.password
      || !hostname || hostname === 'localhost'
      || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || (isIP(hostname) && !isPublicRemoteMediaIp(hostname))
    ) {
      return false;
    }

    const existing = resolveAttachmentAbsPath(opts.uid, opts.cid, args.localName);
    if (existing.ok && existing.kind === args.kind) return true;
    const key = JSON.stringify([opts.uid, opts.cid, args.uri, args.localName]);
    if (backgroundMediaDownloads.has(key)) return true;

    const reservedBytes = args.kind === 'image'
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES;
    if (
      remoteMediaScheduledCount >= LOCAL_AGENT_REMOTE_MAX_ITEMS
      || backgroundMediaDownloads.size >= LOCAL_AGENT_REMOTE_GLOBAL_MAX_ITEMS
      || backgroundMediaReservedBytes + reservedBytes > LOCAL_AGENT_REMOTE_GLOBAL_MAX_BYTES
      || remoteMediaReservedBytes + reservedBytes > LOCAL_AGENT_REMOTE_TOTAL_MAX_BYTES
    ) {
      return false;
    }
    remoteMediaScheduledCount += 1;
    remoteMediaReservedBytes += reservedBytes;
    backgroundMediaReservedBytes += reservedBytes;
    if (!remoteMediaDeadlineAt) remoteMediaDeadlineAt = Date.now() + LOCAL_AGENT_REMOTE_BATCH_TIMEOUT_MS;

    const controller = new AbortController();
    const linked = linkedAbortSignal(opts.signal, controller.signal);
    let entry!: BackgroundMediaDownload;
    const done = backgroundMediaQueue
      .catch(() => undefined)
      .then(async () => {
        if (linked.signal.aborted || Date.now() >= remoteMediaDeadlineAt) return;
        if (!fs.existsSync(conversationMessageReadFile(opts.uid, opts.cid, opts.projectId))) return;
        const cached = resolveAttachmentAbsPath(opts.uid, opts.cid, args.localName);
        if (cached.ok && cached.kind === args.kind) {
          broadcastMaterializedRemoteMedia({
            uid: opts.uid,
            cid: opts.cid,
            remoteUrl: args.uri,
            localUrl: chatMediaCidUrl(opts.cid, args.localName),
            kind: args.kind,
          });
          return;
        }
        const remainingMs = remoteMediaDeadlineAt - Date.now();
        if (remainingMs <= 0) return;
        const timeoutMs = Math.max(1, Math.min(
          args.kind === 'image' ? LOCAL_AGENT_REMOTE_IMAGE_TIMEOUT_MS : LOCAL_AGENT_REMOTE_VIDEO_TIMEOUT_MS,
          remainingMs,
        ));
        const decoded = await downloadLocalAgentMedia(
          args.uri,
          args.declaredMime,
          args.sourceName,
          linked.signal,
          args.kind,
          timeoutMs,
        );
        if (linked.signal.aborted) return;
        if (!decoded.ok || decoded.kind !== args.kind || decoded.extension !== args.extension) {
          const reason = 'reason' in decoded ? decoded.reason : 'container_mismatch';
          log.warn('local CLI remote media download rejected', {
            ...runLogContext,
            source: args.source,
            reason,
          });
          return;
        }
        const saved = await saveGeneratedMediaCacheAttachment(
          opts.uid,
          opts.cid,
          decoded.buffer,
          args.localName,
          args.kind,
        );
        if (!saved.ok) {
          const saveError = 'error' in saved ? saved.error : 'unknown media cache save failure';
          if (saveError !== 'conversation no longer exists') {
            log.warn('local CLI remote media cache save failed', {
              ...runLogContext,
              source: args.source,
              kind: args.kind,
              error: logErrorRef(new Error(saveError)),
            });
          }
          return;
        }
        broadcastMaterializedRemoteMedia({
          uid: opts.uid,
          cid: opts.cid,
          remoteUrl: args.uri,
          localUrl: chatMediaCidUrl(opts.cid, saved.info.name),
          kind: args.kind,
        });
      })
      .catch((error) => {
        if (!linked.signal.aborted) {
          log.warn('local CLI remote media background download failed', {
            ...runLogContext,
            source: args.source,
            error: logErrorRef(error),
          });
        }
      })
      .finally(() => {
        linked.cleanup();
        if (backgroundMediaDownloads.get(key) === entry) {
          backgroundMediaDownloads.delete(key);
          backgroundMediaReservedBytes = Math.max(0, backgroundMediaReservedBytes - entry.reservedBytes);
        }
      });
    entry = {
      uid: opts.uid,
      cid: opts.cid,
      reservedBytes,
      abort: (reason: string) => {
        if (!controller.signal.aborted) controller.abort(new Error(reason));
      },
      done,
    };
    backgroundMediaDownloads.set(key, entry);
    backgroundMediaQueue = done;
    return true;
  };

  const commitMediaOutput = (rawEvent: LocalEvent): void => {
    const source = typeof rawEvent.source === 'string' && rawEvent.source.trim()
      ? rawEvent.source.trim().slice(0, 40)
      : 'cli';
    const callId = typeof rawEvent.callId === 'string' ? rawEvent.callId.slice(0, 160) : '';
    const rawItems = Array.isArray(rawEvent.items) ? rawEvent.items.slice(0, 16) : [];
    const remoteItems: Array<Record<string, string>> = [];
    const fileEvents: LocalEvent[] = [];
    let rejectedCount = 0;
    let backgroundSkippedCount = 0;

    const safeStem = (raw: string, fallback: string): string => {
      let name = raw;
      try { name = decodeURIComponent(raw); } catch { /* keep encoded source */ }
      const base = path.basename(name.trim());
      return (path.basename(base, path.extname(base)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || fallback);
    };
    const saveDecoded = (
      decoded: Extract<LocalAgentMediaDecodeResult, { ok: true }>,
      requestedName: string,
    ): { absPath: string; name: string } | null => {
      const fallback = `${source.replace(/[^A-Za-z0-9_-]+/g, '-')}-generated-${decoded.kind}`;
      const stem = safeStem(requestedName, fallback);
      const saved = saveGeneratedMediaAttachment(
        opts.uid,
        opts.cid,
        decoded.buffer,
        `${stem}${decoded.extension}`,
        decoded.kind,
      );
      if (!saved.ok) {
        log.warn('local CLI media output save failed', {
          ...runLogContext,
          source,
          kind: decoded.kind,
          error: logErrorRef(new Error('error' in saved ? saved.error : 'unknown media save failure')),
        });
        return null;
      }
      fileEvents.push({
        type: 'file-change',
        paths: [saved.absPath],
        scope: 'conversation-media',
        source: 'cli_media_output',
        synthetic: true,
      });
      return { absPath: saved.absPath, name: saved.info.name };
    };

    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        rejectedCount += 1;
        continue;
      }
      const item = raw as Record<string, unknown>;
      const uri = typeof item.uri === 'string' ? item.uri.trim() : '';
      if (uri) {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const mediaType = normalizedMediaMime(item.mediaType);
            if (mediaType && !mediaType.startsWith('image/') && !mediaType.startsWith('video/')) {
              rejectedCount += 1;
              continue;
            }
            const key = `remote:${source}:${callId}:${uri}`;
            if (materializedMediaKeys.has(key)) continue;
            materializedMediaKeys.add(key);
            const explicitName = typeof item.name === 'string' && item.name.trim()
              ? path.basename(item.name.trim()).slice(0, 160)
              : '';
            const downloadName = explicitName || path.basename(parsed.pathname).slice(0, 160);
            const record: Record<string, string> = {
              uri: parsed.toString(),
              ...(mediaType ? { mediaType } : {}),
              ...(explicitName ? { name: explicitName } : {}),
            };
            const extension = mediaExtensionHint(mediaType, downloadName || parsed.pathname);
            const kind = mediaKindHint(mediaType, downloadName || parsed.pathname);
            if (extension && kind) {
              const localName = stableRemoteMediaName(parsed.toString(), extension);
              if (scheduleRemoteMediaDownload({
                uri: parsed.toString(),
                declaredMime: item.mediaType,
                sourceName: downloadName,
                localName,
                extension,
                kind,
                source,
              })) {
                record.localName = localName;
              } else {
                backgroundSkippedCount += 1;
              }
            } else {
              backgroundSkippedCount += 1;
            }
            remoteItems.push(record);
            continue;
          }
        } catch { /* local path or malformed URI; validation continues below */ }
      }
      const decoded = materializeMediaItem(item);
      if (!decoded.ok) {
        rejectedCount += 1;
        const reason = 'reason' in decoded ? decoded.reason : 'malformed';
        log.warn('local CLI media output rejected', { ...runLogContext, source, reason });
        continue;
      }
      const contentKey = [source, callId, decoded.buffer.length, decoded.buffer.subarray(0, 24).toString('base64')].join(':');
      if (materializedMediaKeys.has(contentKey)) continue;
      const requestedName = typeof item.name === 'string' ? path.basename(item.name.trim()) : '';
      const saved = saveDecoded(decoded, requestedName);
      if (!saved) {
        rejectedCount += 1;
        continue;
      }
      materializedMediaKeys.add(contentKey);
    }

    commitEvent({
      type: 'media-output',
      source,
      ...(callId ? { callId } : {}),
      items: remoteItems,
      materializedCount: fileEvents.length,
      scheduledCount: remoteItems.filter(item => !!item.localName).length,
      rejectedCount,
      ...(backgroundSkippedCount ? { backgroundSkippedCount } : {}),
    });
    for (const fileEvent of fileEvents) commitEvent(fileEvent);
  };
  const onEvent = (rawEvent: LocalEvent) => {
    if (rawEvent.type === 'media-output') {
      if (inspectResumeAttempt) resumeAttemptExecuted = true;
      commitMediaOutput(rawEvent);
      return;
    }
    if (rawEvent.type === 'tool-event') {
      const callId = String(rawEvent.callId || '').trim();
      const phase = String(rawEvent.phase || '').trim().toLowerCase();
      let skillRef = bridgeSkillRefFromToolEvent(rawEvent);
      if (phase === 'use' && callId && skillRef) bridgeSkillRefByCallId.set(callId, skillRef);
      if (!skillRef && callId) skillRef = bridgeSkillRefByCallId.get(callId) || '';
      const skillName = skillRef ? bridge?.getSkillDisplayName(skillRef) : null;
      if (skillName) rawEvent.skill_name = skillName;
      const connectorId = bridgeConnectorIdFromToolEvent(rawEvent);
      const connectorName = connectorId ? bridge?.getConnectorDisplayName(connectorId) : null;
      if (connectorName) rawEvent.connector_name = connectorName;
      if (phase === 'result' && callId) bridgeSkillRefByCallId.delete(callId);
    }
    const e = redactPrivateLocalAgentEvent(rawEvent, opts.cwd);
    if (inspectResumeAttempt) {
      if (
        (e.type === 'stderr-line' && isCliResumeRejectedMessage(e.line))
        || (e.type === 'done' && isCliResumeRejectedMessage(e.error))
      ) {
        resumeRejected = true;
      }
      if (e.type === 'done' && resumeRejected) e.resumeRejected = true;
      if (
        e.type === 'text-delta'
        || e.type === 'tool-event'
        || e.type === 'media-output'
        || e.type === 'file-change'
        || e.type === 'permission-request'
        || (e.type === 'status' && e.status === 'running')
      ) {
        resumeAttemptExecuted = true;
      }
    }
    if (e.type === 'status' && e.status === 'background-stopped') sawBackgroundStopped = true;
    // Hold only the terminal marker until we know whether this resume was a
    // pre-execution stale-session rejection, or answered the user at all.
    // Diagnostic stderr/process rows remain visible; users still get exactly
    // one terminal event.
    if (holdTerminalForResumeCheck && e.type === 'done') {
      deferredDone = e;
      setTerminal(e);
      return;
    }
    commitEvent(e);
  };

  // Idle ticker — purely informational; never kills the process itself.
  // Killing is the backend watchdog's job (idle-kill at `idleKillMs` +
  // wall cap, see resolveIdleKillMs/resolveTimeoutMs above); this
  // threshold sits far below the kill window so the user sees a steady
  // drumbeat ("○ no output for 30s" repeated) well before any kill,
  // rather than a single heartbeat that ages out.
  const idleTickMs = resolveIdleTickMs(idleThresholdMs);
  const idleTimer = setInterval(() => {
    if (terminal) return;  // run already finished, don't keep pulsing
    const stalledMs = Date.now() - lastVisibleActivityAt;
    if (stalledMs > idleThresholdMs) {
      onEvent({ type: 'idle', stalledMs });
    }
  }, idleTickMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  // orkas-bridge (plan §D): per-run host exposing the user's Orkas
  // skills / connectors / KB to the CLI agent over a local socket. Bridge
  // failures never fail the dispatch — the CLI just runs without the
  // `orkas` MCP server, same as before the bridge existed.
  // Set when Claude enters a background phase. The backend promise and host
  // turn stay active; this marker is only for diagnostics and the app-shutdown
  // stop registry.
  let backgroundRunEntered = false;
  let backgroundTaskCount = 0;
  if (_bridgeSupported(opts.cli) && process.env.ORKAS_BRIDGE_DISABLED !== '1') {
    try {
      const [{ startBridge }, { buildSkillSandboxEnv }] = await Promise.all([
        import('./bridge.js'),
        import('../../model/core-agent/client.js'),
      ]);
      bridge = await startBridge({
        uid: opts.uid,
        cid: opts.cid,
        agentId: opts.agentId,
        agentName: opts.agentName || opts.agentId,
        currentMessageId: opts.currentMessageId,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        runId: handle.runId,
        configDir: handle.dir,
        sandboxEnv: buildSkillSandboxEnv(opts.uid, opts.agentId),
        preloadSkillDisplayNames: !!opts.resumeSessionId,
      });
      log.info('local agent bridge ready', runLogContext);
    } catch (err) {
      log.warn('bridge start failed — running without orkas MCP server', {
        ...runLogContext,
        error: logErrorRef(err),
      });
    }
  }

  const runBackendAttempt = async (attempt: {
    prompt: string;
    resumeSessionId?: string;
    reuseSessionInstructions?: boolean;
  }) => {
    try {
      await backend.run({
        binPath: entry.path,
        prompt: attempt.prompt,
        systemPrompt: opts.systemPrompt,
        resumeFallbackPrompt: opts.resumeFallbackPrompt,
        reuseSessionInstructions: attempt.reuseSessionInstructions,
        cwd: opts.cwd,
        customArgs: opts.customArgs,
        modelOverride: opts.modelOverride,
        thinkingLevel: opts.thinkingLevel,
        resumeSessionId: attempt.resumeSessionId,
        signal: opts.signal,
        onEvent,
        onActiveRunIngress: opts.onActiveRunIngress,
        onBackgroundRun: handle => {
          backgroundRunEntered = true;
          backgroundTaskCount = handle.liveTasks();
          const entry = { stop: handle.stop, untilProcessExit: handle.untilProcessExit };
          backgroundRuns.add(entry);
          void handle.untilProcessExit.then(() => {
            backgroundRuns.delete(entry);
          });
        },
        timeoutMs,
        idleKillMs,
        // Real-activity clock for the backend's idle-kill watchdog. It excludes
        // self-emitted idle rows and synthetic backend heartbeats, so visible
        // progress can suppress false UI warnings without extending a wedged
        // process indefinitely.
        lastEventAt: () => lastBackendEventAt,
        idleMs: BACKEND_IDLE_MS[opts.cli],
        ...(bridge ? {
          bridge: {
            mcpConfigPath: bridge.mcpConfigPath,
            server: {
              command: bridge.serverEnv.ORKAS_NODE,
              args: [`${bridge.serverEnv.ORKAS_PC_DIR}/bin/orkas-bridge.cjs`],
              env: bridge.serverEnv,
            },
            appendSystemPrompt: buildBridgeSystemPrompt(bridge.capabilities),
          },
        } : {}),
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      log.error('local agent backend threw', { ...runLogContext, error: logErrorSummary(err) });
      if (!terminal) {
        onEvent({ type: 'done', status: 'failed', error: msg });
      }
    } finally {
      // Fail closed on every path. Backends also clear at their authoritative
      // terminal event so the UI updates promptly; this covers throws, process
      // crashes, and future adapters that forget the lifecycle callback.
      try { opts.onActiveRunIngress?.(null); } catch { /* host already gone */ }
    }
  };

  let commanderHandoff: CommanderHandoffRequest | null = null;
  try {
    await runBackendAttempt({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      reuseSessionInstructions: opts.reuseSessionInstructions,
    });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
    }
    const mayRecoverFresh = inspectResumeAttempt
      && resumeRejected
      && terminal?.status === 'failed'
      && !resumeAttemptExecuted
      && !opts.signal.aborted;
    if (mayRecoverFresh) {
      log.warn('local agent resume rejected before execution; retrying with bounded recovery', {
        ...runLogContext,
        recovery_prompt_chars: String(opts.resumeFallbackPrompt || '').length,
      });
      commitEvent({ type: 'status', status: 'resume-rejected' });
      inspectResumeAttempt = false;
      deferredDone = null;
      terminal = null;
      resumeRejected = false;
      await runBackendAttempt({
        prompt: opts.resumeFallbackPrompt!,
        reuseSessionInstructions: false,
      });
    }
    // The resume answered nothing and never called the model: it spent the turn
    // digesting an interrupted session and ate the user's message on the way
    // through. Send it once more rather than telling the user the model
    // returned nothing — the message is otherwise simply lost.
    const mayResend = !mayRecoverFresh
      && !resendAttempted
      && !opts.signal.aborted
      && resumeConsumedTheTurn({
        attemptedResume: !!opts.resumeSessionId,
        status: terminal?.status,
        outputChars: (terminal?.output || streamedOutput || '').length,
        usageTokens: runUsageTokens(terminal?.usage),
        sawBackgroundStopped,
      });
    if (mayResend) {
      log.warn('local agent resume consumed the turn without answering; resending once', {
        ...runLogContext,
      });
      resendAttempted = true;
      deferredDone = null;
      terminal = null;
      sawBackgroundStopped = false;
      await runBackendAttempt({
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        reuseSessionInstructions: opts.reuseSessionInstructions,
      });
    }
  } finally {
    if (bridge) {
      commanderHandoff = bridge.getCommanderHandoff();
      try { await bridge.close(); }
      catch (err) { log.warn('bridge close failed', { ...runLogContext, error: logErrorRef(err) }); }
    }
  }

  clearInterval(idleTimer);

  // Backends are required to emit a `done` — if missing, treat as
  // failure so callers don't hang on an absent terminal event.
  if (!terminal) {
    onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
    terminal = { status: 'failed', error: 'backend exited without terminal event' };
  }
  if (deferredDone) {
    const done = deferredDone;
    deferredDone = null;
    commitEvent(done);
  }

  const finalOutput = terminal.output ?? streamedOutput;
  const endedAtMs = Date.now();
  await persist.finalize(handle, {
    status: terminal.status,
    output: finalOutput,
    error: terminal.error,
    sessionId: terminal.sessionId,
    durationMs: endedAtMs - startedAtMs,
  });
  log.info('local agent run finish', {
    ...runLogContext,
    status: terminal.status,
    ...(backgroundRunEntered ? { background_run: true, background_tasks: backgroundTaskCount } : {}),
    output_chars: finalOutput?.length ?? 0,
    has_error: !!terminal.error,
    commander_handoff: !!commanderHandoff,
    error: terminal.error ? logErrorRef(new Error(terminal.error)) : undefined,
    duration_ms: endedAtMs - startedAtMs,
    diagnostics: summarizeLocalAgentRunForLog(runDiagnostics, endedAtMs),
  });
  return {
    runId: handle.runId,
    status: terminal.status,
    output: finalOutput,
    error: terminal.error,
    ...(terminal.timeoutPhase ? { timeoutPhase: terminal.timeoutPhase } : {}),
    ...(commanderHandoff ? { commanderHandoff } : {}),
  };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('local agent cli missing', {
    ...localAgentRunContextForLog({
      uid: opts.uid,
      cid: opts.cid,
      agentId: opts.agentId,
      projectId: opts.projectId,
      cli: opts.cli,
      customArgs: opts.customArgs,
      resumeSessionId: opts.resumeSessionId,
      prompt: opts.prompt,
      cwd: opts.cwd,
      cliAvailable: entry.available,
      cliVersion: entry.version,
      bridgeSupported: _bridgeSupported(opts.cli),
    }),
    error: logErrorRef(new Error(err)),
  });
  opts.onEvent({
    type: 'done',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  });
  return {
    runId: '',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  };
}
