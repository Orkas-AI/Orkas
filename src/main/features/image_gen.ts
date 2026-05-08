/**
 * Image generation — provider-agnostic dispatch on top of the existing
 * auth-profiles store.
 *
 * Two-step picker:
 *   1. `pickImageGenProfile()` walks the user's priority-ordered entry list,
 *      filters out OAuth (none of the OAuth surfaces we ship can reach image
 *      APIs — see auth.ts::listApiKeyEntries note), and returns the first
 *      entry whose provider is in `IMAGE_GEN_BY_PROVIDER`.
 *   2. The capability table fixes the model id (e.g. `gpt-image-1` /
 *      `gemini-2.5-flash-image-preview`) — the user's chat model selection
 *      on that entry is irrelevant; reusing the api_key is the whole point.
 *
 * Adapters (`callOpenAIImage` / `callGeminiImage`) wrap each provider's
 * native image endpoint via `fetch` (no new npm dep). Add a new family by
 * extending IMAGE_GEN_BY_PROVIDER + the dispatch switch in `generateImage`.
 *
 * The caller (`model/core-agent/image-gen-tool.ts`) handles permission
 * gating, path-sandbox checks, and `onFileWritten` notification — this
 * module only deals with credentials, HTTP, and writing the bytes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { listApiKeyEntries, loadImageProfiles, type ApiKeyEntryChoice } from './auth';
import { findImageGenCapability, type ImageGenCapability } from '../model/provider_catalog';
import { createLogger } from '../logger';
import { t } from '../i18n';

const log = createLogger('image-gen');

// ── Picker ───────────────────────────────────────────────────────────────

export interface PickedImageGenProfile {
  entry: ApiKeyEntryChoice;
  capability: ImageGenCapability;
}

/**
 * Pick which (api_key, image-capable provider) pair to use for the next
 * image generation call.
 *
 * Priority:
 *   1. The user's dedicated `imageProfiles` list (from the "Image
 *      Generation API Key" card in settings). First entry whose
 *      provider has a capability wins.
 *      Multiple entries on the same provider just shadow each other —
 *      first wins, no rotation (image gen calls are rare; rotation isn't
 *      worth the surprise factor).
 *   2. Fallback: the chat `entries` list. If the user never set up a
 *      dedicated image key but happens to have an OpenAI/Google chat key,
 *      reuse it. Keeps existing setups working without forcing a re-config.
 */
export function pickImageGenProfile(): PickedImageGenProfile | null {
  const dedicated = loadImageProfiles();
  for (const p of dedicated) {
    const cap = findImageGenCapability(p.provider);
    if (!cap) continue;
    return {
      entry: {
        entryId: p.id,
        profileId: p.id,
        provider: p.provider,
        model: cap.model,
        apiKey: p.apiKey,
      },
      capability: cap,
    };
  }
  const chatEntries = listApiKeyEntries();
  for (const e of chatEntries) {
    const cap = findImageGenCapability(e.provider);
    if (cap) return { entry: e, capability: cap };
  }
  return null;
}

// ── Public entry ─────────────────────────────────────────────────────────

export interface GenerateImageInput {
  /** Image description (required). */
  prompt: string;
  /** Absolute path to write the image to. Caller must already have
   *  validated this against path-sandbox. Extension may be omitted —
   *  it'll be appended based on the returned mime type. */
  outputAbsPath: string;
  /** Already-validated absolute paths to reference images for editing /
   *  variations. The picked capability must have `supportsEdit: true`. */
  referenceImagePaths?: string[];
  /** Provider-side size hint. Default `1024x1024`. */
  size?: string;
}

export type GenerateImageResult =
  | {
      ok: true;
      path: string;
      width: number;
      height: number;
      bytes: number;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      errorCode:
        | 'NO_CAPABLE_MODEL'
        | 'EDIT_NOT_SUPPORTED'
        | 'PROVIDER_API_ERROR'
        | 'IO_ERROR'
        | 'BAD_INPUT';
      message: string;
    };

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, errorCode: 'BAD_INPUT', message: 'prompt is required' };
  }
  if (!input.outputAbsPath) {
    return { ok: false, errorCode: 'BAD_INPUT', message: 'outputAbsPath is required' };
  }

  const picked = pickImageGenProfile();
  if (!picked) {
    log.warn('image gen aborted: no api-key entry maps to an image-capable provider');
    return { ok: false, errorCode: 'NO_CAPABLE_MODEL', message: t('image_gen.no_capable_model') };
  }

  const { entry, capability } = picked;
  const refPaths = input.referenceImagePaths || [];

  if (refPaths.length && !capability.supportsEdit) {
    return {
      ok: false,
      errorCode: 'EDIT_NOT_SUPPORTED',
      message: `Image model ${capability.model} does not support reference-image editing`,
    };
  }

  let referenceBuffers: Buffer[] | undefined;
  if (refPaths.length) {
    try {
      referenceBuffers = await Promise.all(refPaths.map((p) => fs.readFile(p)));
    } catch (err) {
      log.warn(`failed reading reference image: ${(err as Error).message}`);
      return {
        ok: false,
        errorCode: 'IO_ERROR',
        message: `Failed to read reference image: ${(err as Error).message}`,
      };
    }
  }

  const size = input.size || '1024x1024';
  const adapterReq: AdapterRequest = {
    apiKey: entry.apiKey,
    model: capability.model,
    prompt: input.prompt,
    size,
    ...(referenceBuffers ? { referenceImages: referenceBuffers } : {}),
  };

  let adapterRes: AdapterResult;
  try {
    if (capability.api === 'openai') {
      adapterRes = await callOpenAIImage(adapterReq);
    } else if (capability.api === 'gemini') {
      adapterRes = await callGeminiImage(adapterReq);
    } else if (capability.api === 'doubao') {
      adapterRes = await callDoubaoImage(adapterReq);
    } else {
      return {
        ok: false,
        errorCode: 'BAD_INPUT',
        message: `Unknown image-gen api: ${(capability as ImageGenCapability).api}`,
      };
    }
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`image gen API call failed (${entry.provider}/${capability.model}): ${msg}`);
    return { ok: false, errorCode: 'PROVIDER_API_ERROR', message: msg };
  }

  let finalPath: string;
  try {
    finalPath = ensureExtension(input.outputAbsPath, adapterRes.mimeType);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, adapterRes.buffer);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`image write failed (${input.outputAbsPath}): ${msg}`);
    return { ok: false, errorCode: 'IO_ERROR', message: `Failed to write image: ${msg}` };
  }

  log.info('image generated', {
    provider: entry.provider,
    model: capability.model,
    path: finalPath,
    bytes: adapterRes.buffer.length,
    width: adapterRes.width,
    height: adapterRes.height,
  });

  return {
    ok: true,
    path: finalPath,
    width: adapterRes.width,
    height: adapterRes.height,
    bytes: adapterRes.buffer.length,
    provider: entry.provider,
    model: capability.model,
  };
}

// ── Adapters ─────────────────────────────────────────────────────────────

export interface AdapterRequest {
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  referenceImages?: Buffer[];
}

export interface AdapterResult {
  buffer: Buffer;
  mimeType: string;
  /** 0 if dimensions could not be parsed — non-fatal, the file is still
   *  on disk. */
  width: number;
  height: number;
}

const OPENAI_BASE = 'https://api.openai.com';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com';

export async function callOpenAIImage(req: AdapterRequest): Promise<AdapterResult> {
  const hasRefs = !!(req.referenceImages && req.referenceImages.length);
  const url = hasRefs
    ? `${OPENAI_BASE}/v1/images/edits`
    : `${OPENAI_BASE}/v1/images/generations`;

  let headers: Record<string, string>;
  let body: BodyInit;

  if (hasRefs) {
    const form = new FormData();
    form.append('model', req.model);
    form.append('prompt', req.prompt);
    form.append('size', req.size);
    form.append('n', '1');
    req.referenceImages!.forEach((buf, i) => {
      const mime = detectMimeType(buf) || 'image/png';
      const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
      // OpenAI's edits endpoint expects `image[]` for multi-ref; gpt-image-1
      // accepts up to 16. Use Blob from Uint8Array (works on Node 20 fetch).
      form.append('image[]', new Blob([new Uint8Array(buf)], { type: mime }), `ref-${i}.${ext}`);
    });
    body = form;
    headers = { Authorization: `Bearer ${req.apiKey}` };
  } else {
    body = JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      size: req.size,
      n: 1,
    });
    headers = {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  const resp = await fetch(url, { method: 'POST', headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI image API ${resp.status}: ${truncate(text, 500)}`);
  }
  const data = (await resp.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI image API returned no b64_json data');
  const buffer = Buffer.from(b64, 'base64');
  const mimeType = detectMimeType(buffer) || 'image/png';
  const dim = parseImageDimensions(buffer, mimeType);
  return { buffer, mimeType, width: dim.width, height: dim.height };
}

export async function callGeminiImage(req: AdapterRequest): Promise<AdapterResult> {
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const parts: unknown[] = [{ text: req.prompt }];
  if (req.referenceImages?.length) {
    for (const buf of req.referenceImages) {
      parts.push({
        inline_data: {
          mime_type: detectMimeType(buf) || 'image/png',
          data: buf.toString('base64'),
        },
      });
    }
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': req.apiKey,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Gemini image API ${resp.status}: ${truncate(text, 500)}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<
          | { text?: string }
          | { inline_data?: { mime_type?: string; data?: string }; inlineData?: { mimeType?: string; data?: string } }
        >;
      };
    }>;
  };
  const candParts = data.candidates?.[0]?.content?.parts ?? [];
  for (const p of candParts) {
    // Gemini API responses use both snake_case (`inline_data` / `mime_type`)
    // and camelCase (`inlineData` / `mimeType`) depending on which surface
    // and version. Normalise to a single shape before reading.
    const raw = (p as Record<string, unknown>).inline_data ?? (p as Record<string, unknown>).inlineData;
    if (!raw || typeof raw !== 'object') continue;
    const inline = raw as { mime_type?: string; mimeType?: string; data?: string };
    if (!inline.data) continue;
    const buffer = Buffer.from(inline.data, 'base64');
    const mimeType = inline.mime_type ?? inline.mimeType ?? detectMimeType(buffer) ?? 'image/png';
    const dim = parseImageDimensions(buffer, mimeType);
    return { buffer, mimeType, width: dim.width, height: dim.height };
  }
  throw new Error('Gemini image API returned no inline image data');
}

/**
 * Volcengine Ark (Doubao) Seedream text-to-image + image-to-image (4.5+).
 * Endpoint: POST /api/v3/images/generations, OpenAI-compatible request body.
 * Returns `{ data: [{ url: "..." }] }` by default (base64 also available
 * on request); we use the URL mode and re-fetch the bytes ourselves so
 * we don't bump into account-level base64 quotas.
 *
 * Image-to-image: add `image: string | string[]` to the body; each entry
 * is either a public HTTPS URL or a data URI
 * (`data:<mime>;base64,<b64>`). Local reference images are encoded as
 * data URIs uniformly.
 * Reference images + outputs total ≤ 15; the tool layer additionally
 * caps references to 4.
 *
 * Size note: Seedream 4.5's `size` does NOT accept arbitrary `WxH` like
 * OpenAI — the value must satisfy both:
 *   1. Pixels ≥ 3,686,400 (≈ 1920×1920).
 *   2. Form must be `WIDTHxHEIGHT` or one of the keywords
 *      `1k` / `2k` / `4k`.
 * Callers default to `1024x1024` (OpenAI-style), which is under
 * Seedream's lower bound, so we translate here: bump to `2k` when below
 * the pixel floor; pass through anything already large enough or
 * already a keyword. In image-to-image mode, when the caller hasn't
 * explicitly set a non-default size, we pass `adaptive` so the model
 * picks dimensions from the reference image, avoiding aspect-ratio
 * conflicts when forcing 2k.
 */
const SEEDREAM_MIN_PIXELS = 3_686_400;
const SEEDREAM_DEFAULT_SIZE = '1024x1024';

function normaliseSeedreamSize(size: string): string {
  const s = String(size || '').trim().toLowerCase();
  if (!s) return '2k';
  if (s === '1k' || s === '2k' || s === '4k' || s === 'adaptive') return s;
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) return '2k';
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return '2k';
  if (w * h < SEEDREAM_MIN_PIXELS) return '2k';
  return `${w}x${h}`;
}

function bufferToDataUri(buf: Buffer): string {
  const mime = detectMimeType(buf) || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function callDoubaoImage(req: AdapterRequest): Promise<AdapterResult> {
  const refs = req.referenceImages ?? [];
  const isEdit = refs.length > 0;
  const size = isEdit && req.size === SEEDREAM_DEFAULT_SIZE
    ? 'adaptive'
    : normaliseSeedreamSize(req.size);
  const bodyObj: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size,
    n: 1,
    response_format: 'url',
  };
  if (isEdit) {
    const dataUris = refs.map(bufferToDataUri);
    bodyObj.image = dataUris.length === 1 ? dataUris[0] : dataUris;
  }
  const body = JSON.stringify(bodyObj);
  const resp = await fetch(`${DOUBAO_BASE}/api/v3/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Doubao image API ${resp.status}: ${truncate(text, 500)}`);
  }
  const data = (await resp.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const item = data.data?.[0];
  let buffer: Buffer | null = null;
  if (item?.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    const imgResp = await fetch(item.url);
    if (!imgResp.ok) throw new Error(`Doubao image fetch failed ${imgResp.status}`);
    buffer = Buffer.from(await imgResp.arrayBuffer());
  }
  if (!buffer) throw new Error('Doubao image API returned no image payload');
  const mimeType = detectMimeType(buffer) || 'image/png';
  const dim = parseImageDimensions(buffer, mimeType);
  return { buffer, mimeType, width: dim.width, height: dim.height };
}

// ── Image format helpers ─────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function detectMimeType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

function parseImageDimensions(buf: Buffer, mimeType: string): { width: number; height: number } {
  try {
    if (mimeType === 'image/png')  return parsePngDimensions(buf);
    if (mimeType === 'image/jpeg') return parseJpegDimensions(buf);
    if (mimeType === 'image/webp') return parseWebpDimensions(buf);
  } catch { /* fallthrough */ }
  return { width: 0, height: 0 };
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  // 8-byte signature + 4 chunk-len + 4 type ("IHDR") + 4 width BE + 4 height BE
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 — skip DHT/DAC/SOS markers in same range too.
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // segment: 2 length + 1 precision + 2 height + 2 width
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) {
      i += 2; continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

function parseWebpDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 30) return { width: 0, height: 0 };
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8X') {
    const width  = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (fmt === 'VP8 ') {
    // VP8 lossy: width/height at file offset 26/28, lower 14 bits each.
    const width  = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (fmt === 'VP8L') {
    // VP8L lossless: byte 20 = 0x2f signature, then 28 bits packed in bytes 21-24.
    const b21 = buf[21], b22 = buf[22], b23 = buf[23], b24 = buf[24];
    const width  = 1 + (((b22 & 0x3f) << 8) | b21);
    const height = 1 + (((b24 & 0x0f) << 10) | (b23 << 2) | ((b22 & 0xc0) >> 6));
    return { width, height };
  }
  return { width: 0, height: 0 };
}

function ensureExtension(p: string, mimeType: string): string {
  const ext =
    mimeType === 'image/png'  ? '.png'  :
    mimeType === 'image/jpeg' ? '.jpg'  :
    mimeType === 'image/webp' ? '.webp' : '';
  if (!ext) return p;
  const lower = p.toLowerCase();
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
    return p;
  }
  return p + ext;
}
