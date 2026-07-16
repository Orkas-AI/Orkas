/**
 * tts — pluggable text-to-speech backend for the `generate_speech`
 * runtime. Encapsulated so new user-configured backends slot in behind one
 * interface:
 *
 *   - 'openai-compatible' (PRIMARY): BYO user TTS API in the OpenAI
 *     `/audio/speech` shape — ElevenLabs / OpenAI / any compatible gateway.
 *     Config = a saved `TtsProfile` (base url, key, model, voice).
 *   - 'doubao': Volcengine V3 TTS (`/api/v3/tts/unidirectional`). NOT OpenAI-
 *     compatible — `X-Api-Key` + `X-Api-Resource-Id` auth (the API-key console
 *     method) and an NDJSON stream of base64 audio chunks. Routed by
 *     `profile.provider === 'doubao'`.
 *   - no configured provider: fail fast with a clear setup error. Speech
 *     generation never downloads or runs a local renderer implicitly.
 *
 * Additional user-owned backends can implement the same `TtsBackend`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TtsProfile } from './auth';
import {
  DOUBAO_DEFAULT_VOICE,
  listTtsProfiles,
} from './tts_auth';
import { probeMediaDurationSec } from '../util/media_probe';
import { redactPaths } from '../util/redact';
import { createLogger } from '../logger';
import { resolveTtsSelection } from './tts_capabilities';

const log = createLogger('tts');

/** Cap on a synthesized-audio response so a misbehaving endpoint can't balloon
 *  memory. Speech of a sentence/paragraph is KB–low-MB; 50MB is very generous. */
const MAX_TTS_BYTES = 50 * 1024 * 1024;

export interface TtsParams {
  text: string;
  outputAbsPath: string;
  /** Stable configured route selected from the runtime capability catalog. */
  routeRef?: string;
  /** Stable route-bound voice reference selected from the capability catalog. */
  voiceRef?: string;
  /** BCP-47 narration language signed with the selected voice. */
  language?: string;
  /** Voice id (provider-specific). Falls back to the profile / backend default. */
  voice?: string;
  /** Speed multiplier (1.0 = normal). */
  speed?: number;
  /** Output container (mp3 | wav | opus | ...); falls back to the profile default. */
  format?: string;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string }) => void;
}

export type TtsResult =
  | { ok: true; path: string; bytes: number; backend: string; durationSec?: number }
  | {
    ok: false;
    errorCode: string;
    message: string;
    requestDisposition?: 'not_sent' | 'rejected_preflight' | 'sent';
    chargeStatus?: 'not_charged' | 'charged' | 'unknown';
    retryPolicy?: 'safe_after_plan_fix' | 'requires_user_action' | 'unknown';
    providerErrorCode?: string;
  };

/** Whether a synthesized narration fits a target clip duration, with a concrete
 *  remedy (word count / speed derived from the OBSERVED speaking rate). The
 *  upstream check that the shipped pipeline lacked: a 16 s narration silently
 *  dropped into a 24 s clip "passed" because nothing compared the two. */
export interface NarrationFit {
  status: 'fits' | 'over' | 'under';
  measuredSec: number;
  targetSec: number;
  deltaSec: number;       // measured - target (positive ⇒ too long)
  ratio: number;          // measured / target
  wordsPerSec: number;    // observed speaking rate
  suggestedWords: number; // word count to hit the target at that rate
  suggestedSpeed: number; // speed multiplier to hit the target (clamped 0.5–2.0)
  message: string;
}

function round2(n: number): number { return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100; }
function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

/** Compare a synthesized narration's measured duration to a target clip length.
 *  Returns null when either duration is unusable. Pure → unit-tested. */
export function assessNarrationFit(input: { measuredSec: number; targetSec: number; wordCount: number; unit?: 'words' | 'characters' }): NarrationFit | null {
  const measured = input.measuredSec;
  const target = input.targetSec;
  if (!(measured > 0) || !(target > 0)) return null;
  // Chinese/Japanese/Korean have no word spaces — a whole line reads as one
  // "word", making any words-per-second math meaningless. Callers pass
  // unit:'characters' (with a character count) for CJK so the budget below is
  // a real, usable number.
  const unitLabel = input.unit === 'characters' ? 'characters' : 'words';
  const ratio = measured / target;
  const wps = input.wordCount > 0 ? input.wordCount / measured : 0;
  const suggestedWords = wps > 0 ? Math.round(wps * target) : 0;
  const suggestedSpeed = round2(clamp(ratio, 0.5, 2.0));
  const deltaSec = round2(measured - target);
  // ±tolerance band around the target: comfortably inside ⇒ "fits".
  const OVER = 1.05;
  const UNDER = 0.85;
  let status: NarrationFit['status'] = 'fits';
  let message = `Narration is ${round2(measured)}s for a ${round2(target)}s clip — fits.`;
  if (ratio > OVER) {
    status = 'over';
    // Lead with trimming. Raising `speed` to cram a long script in sounds
    // rushed AND still won't land each line on its scene — a shorter script at
    // a natural pace is the fix, so we no longer offer a faster read as a remedy.
    const hint = suggestedWords > 0 ? `trim the script to ≈${suggestedWords} ${unitLabel}` : 'shorten the script';
    message = `Narration is ${round2(measured)}s, ${deltaSec}s longer than the ${round2(target)}s clip — ${hint} rather than raising speed (a fast read sounds rushed).`;
  } else if (ratio < UNDER) {
    status = 'under';
    const addWords = Math.max(0, suggestedWords - input.wordCount);
    const hint = addWords > 0 ? `add ~${addWords} ${unitLabel}` : 'lengthen the script';
    message = `Narration is ${round2(measured)}s, ${round2(target - measured)}s shorter than the ${round2(target)}s clip — that much of the clip will have no narration. ${hint}, or accept an early finish.`;
  }
  return { status, measuredSec: round2(measured), targetSec: round2(target), deltaSec, ratio: round2(ratio), wordsPerSec: round2(wps), suggestedWords, suggestedSpeed, message };
}

/** Pick the right length unit for a narration script: characters for a CJK
 *  (Chinese/Japanese/Korean) line, whitespace words for a Latin one. Feeds
 *  assessNarrationFit so its budget ("trim to ≈N …") is a usable number rather
 *  than a meaningless word count on spaceless Chinese. Pure → unit-tested. */
export function measureNarrationUnits(text: string): { unit: 'words' | 'characters'; units: number } {
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3\uf900-\ufaff]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  // CJK is spaceless, so a Chinese line counts as ~1 word — count characters
  // whenever the script is CJK-dominant; otherwise count Latin words.
  return cjk >= words ? { unit: 'characters', units: cjk } : { unit: 'words', units: words };
}

export interface NarrationDurationEstimate {
  estimatedSec: number;
  unit: 'words' | 'characters';
  units: number;
  unitsPerSec: number;
  breakdown: {
    cjkCharacters: number;
    latinWords: number;
    numericDigits: number;
    numericSeparators: number;
    majorPauses: number;
    minorPauses: number;
    longPauses: number;
    speechSec: number;
    pauseSec: number;
  };
}

export interface EstimatedNarrationFit {
  status: 'fits' | 'over' | 'under';
  genericEstimatedSec: number;
  estimatedSec: number;
  targetSec: number;
  durationScale: number;
  unit: 'words' | 'characters';
  units: number;
  suggestedUnits: number;
}

/** Derive a reusable correction factor from a real synthesis. Keeping this
 *  separate from a narration transaction lets a revised script converge on
 *  the same voice's observed pace instead of falling back to the generic
 *  estimate and oscillating between "too short" and "too long". */
export function narrationDurationCalibrationScale(input: {
  genericEstimatedSec: number;
  measuredSec: number;
}): number | null {
  if (!(input.genericEstimatedSec > 0) || !(input.measuredSec > 0)) return null;
  return Math.round(clamp(input.measuredSec / input.genericEstimatedSec, 0.5, 2) * 10_000) / 10_000;
}

/** Apply the exact VideoStudio delivery band to either a generic estimate or a
 *  measured-voice-calibrated estimate. The same policy is used before billing
 *  and after media probing: narration may finish up to 10% early and may
 *  overrun the immutable target by at most 150ms. */
export function assessEstimatedNarrationFit(input: {
  estimate: NarrationDurationEstimate;
  targetSec: number;
  durationScale?: number;
}): EstimatedNarrationFit | null {
  if (!(input.targetSec > 0) || !(input.estimate.estimatedSec > 0)) return null;
  const durationScale = Number.isFinite(input.durationScale) && (input.durationScale || 0) > 0
    ? clamp(input.durationScale!, 0.5, 2)
    : 1;
  const rawEstimatedSec = input.estimate.estimatedSec * durationScale;
  const estimatedSec = round2(rawEstimatedSec);
  const status: EstimatedNarrationFit['status'] = rawEstimatedSec > input.targetSec + 0.15
    ? 'over'
    : rawEstimatedSec < input.targetSec * 0.9
      ? 'under'
      : 'fits';
  return {
    status,
    genericEstimatedSec: input.estimate.estimatedSec,
    estimatedSec,
    targetSec: round2(input.targetSec),
    durationScale: Math.round(durationScale * 10_000) / 10_000,
    unit: input.estimate.unit,
    units: input.estimate.units,
    suggestedUnits: Math.max(1, Math.round(input.estimate.units * input.targetSec / rawEstimatedSec)),
  };
}

/** Conservative natural-pace estimate used before a paid synthesis request.
 *  Mixed-language scripts must be additive: choosing CJK characters OR Latin
 *  words drops model names, acronyms, versions, years, and punctuation from the
 *  budget. The rates below intentionally approximate a natural explainer read;
 *  the post-synthesis media probe remains the source of truth. */
export function estimateNarrationDuration(text: string, speed = 1): NarrationDurationEstimate {
  const measured = measureNarrationUnits(text);
  const cjkCharacters = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7a3\uf900-\ufaff]/g) || []).length;
  const latinTokens: string[] = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
  const numericDigits = (text.match(/\d/g) || []).length;
  // A decimal/thousands separator is spoken in versions and many quantities,
  // but must not also be counted as a sentence pause.
  const numericSeparators = (text.match(/\d[.,](?=\d)/g) || []).length;
  const pauseText = text.replace(/(\d)[.,](?=\d)/g, '$1');
  const majorPauses = (pauseText.match(/[。！？!?；;.\n]+/g) || []).length;
  const minorPauses = (pauseText.match(/[，,、：:]+/g) || []).length;
  const longPauses = (pauseText.match(/[—–…]+/g) || []).length;

  const cjkSec = cjkCharacters / 4;
  const latinSec = latinTokens.reduce<number>((total, token) => {
    // Initialisms such as GPT/MCP are commonly read letter by letter and take
    // longer than an ordinary one-syllable English word.
    const tokenSec = /^[A-Z]{2,6}$/.test(token)
      ? Math.max(1 / 2.5, token.length * 0.18)
      : 1 / 2.5;
    return total + tokenSec;
  }, 0);
  const numericSec = numericDigits * 0.18 + numericSeparators * 0.15;
  const speechSec = cjkSec + latinSec + numericSec;
  const pauseSec = majorPauses * 0.28 + minorPauses * 0.12 + longPauses * 0.18;
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.5, 2) : 1;
  const unitsPerSec = measured.unit === 'characters' ? 4 : 2.5;
  return {
    estimatedSec: round2((speechSec + pauseSec) / safeSpeed),
    unit: measured.unit,
    units: measured.units,
    unitsPerSec,
    breakdown: {
      cjkCharacters,
      latinWords: latinTokens.length,
      numericDigits,
      numericSeparators,
      majorPauses,
      minorPauses,
      longPauses,
      speechSec: round2(speechSec),
      pauseSec: round2(pauseSec),
    },
  };
}

interface TtsBackend {
  id: string;
  synthesize(p: TtsParams): Promise<TtsResult>;
}

/** Default request timeout for a synthesis call. Speech of a sentence is quick;
 *  generous enough for a paragraph without hanging forever. */
const TTS_TIMEOUT_MS = 120_000;

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ── Backend: OpenAI-compatible /audio/speech (BYO) ──────────────────────────

class OpenAICompatibleTtsBackend implements TtsBackend {
  readonly id = 'openai-compatible';
  constructor(private readonly profile: { baseUrl: string; apiKey: string; model: string; voice?: string; format?: string; label?: string }) {}

  async synthesize(p: TtsParams): Promise<TtsResult> {
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    const url = `${base}/audio/speech`;
    const voice = p.voice || this.profile.voice;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    const body: Record<string, unknown> = {
      model: this.profile.model,
      input: p.text,
      ...(voice ? { voice } : {}),
      response_format: format,
      ...(typeof p.speed === 'number' ? { speed: p.speed } : {}),
    };

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || base}` });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combineSignal(p.signal, TTS_TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = p.signal?.aborted;
      // Don't echo the raw fetch error (it can embed the configured endpoint URL).
      if (!aborted) log.warn(`tts request failed: ${redactPaths((err as Error).message)}`);
      return { ok: false, errorCode: aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK', message: aborted ? 'TTS aborted.' : 'TTS request failed (network/endpoint error).' };
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 400);
      return { ok: false, errorCode: 'E_TTS_API_ERROR', message: `TTS API ${resp.status}: ${detail || resp.statusText}` };
    }
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_TTS_BYTES) {
      return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${declared} bytes).` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_TTS_BYTES) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${buf.length} bytes).` };
    if (!buf.length) return { ok: false, errorCode: 'E_TTS_EMPTY', message: 'TTS API returned empty audio.' };
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true }).catch(() => {});
    await fs.writeFile(p.outputAbsPath, buf);
    return { ok: true, path: p.outputAbsPath, bytes: buf.length, backend: this.id };
  }
}

// ── Backend: Doubao (Volcengine) V3 TTS ─────────────────────────────────────
//
// Not OpenAI-compatible: POST `/api/v3/tts/unidirectional` with `X-Api-Key` +
// `X-Api-Resource-Id` headers (the API-key console method). The response is an
// NDJSON stream — one JSON object per line; data lines carry base64 audio
// chunks (`code: 0`), `code: 20000000` terminates. See features/tts_auth.ts for
// the credential set (API key + resource id + voice).

/** Default synthesis model/voice family for the V3 endpoint. The resource id
 *  must match the voice family (2.0 official voices → seed-tts-2.0). */
const DOUBAO_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
/** Doubao V3 success terminator event code (carries no audio). */
const DOUBAO_V3_DONE_CODE = 20000000;

/** Map a Doubao speaker id to its X-Api-Resource-Id family. The resource id MUST
 *  match the voice family or the V3 endpoint rejects the call, so we derive it
 *  from the speaker suffix — that way picking a different voice (per call or in
 *  settings) automatically uses the right resource id, no manual config. A
 *  profile's explicit `resourceId` overrides this. Pure → unit-tested.
 *    *_moon_* / *_mars_* / ICL_*       → seed-tts-1.0
 *    *_uranus_* / *_jupiter_* / saturn_* → seed-tts-2.0
 *    S_* (cloned voice)                 → seed-icl-2.0   (fallback seed-tts-2.0) */
export function deriveDoubaoResourceId(voice: string): string {
  const v = (voice || '').toLowerCase();
  if (v.startsWith('s_')) return 'seed-icl-2.0';
  if (/_(uranus|jupiter)_/.test(v) || v.startsWith('saturn_')) return 'seed-tts-2.0';
  if (/_(moon|mars)_/.test(v) || v.startsWith('icl_')) return 'seed-tts-1.0';
  return DOUBAO_DEFAULT_RESOURCE_ID;
}

/** Concatenate the base64 audio chunks from a Doubao V3 `/unidirectional`
 *  NDJSON response. Data events are `{code:0,data:"<base64>"}`; the stream ends
 *  with `{code:20000000}`; any other code is an error event. Pure → unit-tested. */
export function parseDoubaoV3Ndjson(raw: string): { ok: true; audio: Buffer } | { ok: false; message: string } {
  const chunks: Buffer[] = [];
  let error = '';
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    if (s.startsWith('data:')) s = s.slice(5).trim();
    let obj: { code?: number | string; data?: string; message?: string; msg?: string };
    try { obj = JSON.parse(s); } catch { continue; } // tolerate stray non-JSON lines
    const code = typeof obj.code === 'number'
      ? obj.code
      : (typeof obj.code === 'string' && /^-?\d+$/.test(obj.code.trim()) ? Number(obj.code) : undefined);
    if (code === 0 && typeof obj.data === 'string' && obj.data) {
      chunks.push(Buffer.from(obj.data, 'base64'));
    } else if (code !== undefined && code !== 0 && code !== DOUBAO_V3_DONE_CODE) {
      error = obj.message || obj.msg || `code ${code}`;
    }
  }
  if (error) return { ok: false, message: `Doubao TTS failed: ${error}` };
  if (!chunks.length) return { ok: false, message: 'Doubao TTS returned no audio.' };
  return { ok: true, audio: Buffer.concat(chunks) };
}

/** The V3 streaming endpoint uses provider-specific container names and does
 * not stream a WAV container. Request PCM for WAV and wrap it after parsing. */
export function normalizeDoubaoAudioFormat(format: string): string {
  const value = String(format || 'mp3').trim().toLowerCase();
  if (value === 'wav') return 'pcm';
  if (value === 'opus' || value === 'ogg') return 'ogg_opus';
  return 'mp3';
}

export function wrapPcm16MonoWav(audio: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

class DoubaoTtsBackend implements TtsBackend {
  readonly id = 'doubao';
  constructor(private readonly profile: {
    baseUrl: string; apiKey: string; resourceId?: string;
    voice?: string; format?: string; label?: string;
  }) {}

  async synthesize(p: TtsParams): Promise<TtsResult> {
    const speaker = p.voice || this.profile.voice;
    if (!speaker) return { ok: false, errorCode: 'E_TTS_ARG', message: 'Doubao TTS requires a voice (speaker).' };
    const base = (this.profile.baseUrl || 'https://openspeech.bytedance.com').replace(/\/+$/, '');
    const url = `${base}/api/v3/tts/unidirectional`;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    const upstreamFormat = normalizeDoubaoAudioFormat(format);
    const resourceId = this.profile.resourceId?.trim() || deriveDoubaoResourceId(speaker);
    const body = {
      user: { uid: 'orkas' },
      req_params: {
        text: p.text,
        speaker,
        audio_params: { format: upstreamFormat, sample_rate: 24000 },
      },
    };

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || 'Doubao'}` });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.profile.apiKey,
          'X-Api-Resource-Id': resourceId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combineSignal(p.signal, TTS_TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = p.signal?.aborted;
      if (!aborted) log.warn(`doubao tts request failed: ${redactPaths((err as Error).message)}`);
      return { ok: false, errorCode: aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK', message: aborted ? 'TTS aborted.' : 'TTS request failed (network/endpoint error).' };
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 400);
      return { ok: false, errorCode: 'E_TTS_API_ERROR', message: `TTS API ${resp.status}: ${detail || resp.statusText}` };
    }
    const raw = await resp.text();
    // base64 inflates ~1.33×; a 50MB audio cap is ~67MB of NDJSON text.
    if (raw.length > MAX_TTS_BYTES * 2) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: 'TTS response too large.' };
    const parsed = parseDoubaoV3Ndjson(raw);
    if (parsed.ok === false) return { ok: false, errorCode: 'E_TTS_API_ERROR', message: parsed.message };
    const buf = format === 'wav' ? wrapPcm16MonoWav(parsed.audio) : parsed.audio;
    if (buf.length > MAX_TTS_BYTES) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${buf.length} bytes).` };
    if (!buf.length) return { ok: false, errorCode: 'E_TTS_EMPTY', message: 'TTS API returned empty audio.' };
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true }).catch(() => {});
    await fs.writeFile(p.outputAbsPath, buf);
    return { ok: true, path: p.outputAbsPath, bytes: buf.length, backend: this.id };
  }
}

class UnconfiguredTtsBackend implements TtsBackend {
  readonly id = 'unconfigured';
  async synthesize(): Promise<TtsResult> {
    return {
      ok: false,
      errorCode: 'E_TTS_NOT_CONFIGURED',
      message: 'No TTS provider is configured. Configure Doubao or an OpenAI-compatible speech provider before generating narration.',
    };
  }
}

/** Resolve the active TTS backend: env override -> ordered saved profile list -> explicit setup error. */
function resolveTtsBackend(routeRef?: string): TtsBackend {
  const envBase = process.env.ORKAS_TTS_BASE_URL;
  const envKey = process.env.ORKAS_TTS_API_KEY;
  const envModel = process.env.ORKAS_TTS_MODEL;
  if (envBase && envKey && envModel && (!routeRef || routeRef === 'env:tts')) {
    return new OpenAICompatibleTtsBackend({
      baseUrl: envBase, apiKey: envKey, model: envModel,
      ...(process.env.ORKAS_TTS_VOICE ? { voice: process.env.ORKAS_TTS_VOICE } : {}),
      ...(process.env.ORKAS_TTS_FORMAT ? { format: process.env.ORKAS_TTS_FORMAT } : {}),
      label: 'env',
    });
  }
  let profiles: TtsProfile[] = [];
  try { profiles = listTtsProfiles(); } catch (err) { log.warn(`listTtsProfiles: ${(err as Error).message}`); }
  const p = routeRef ? profiles.find((profile) => profile.id === routeRef) : profiles[0];
  if (p) {
    if (p.provider === 'doubao') {
      return new DoubaoTtsBackend({
        baseUrl: p.baseUrl, apiKey: p.apiKey,
        ...(p.resourceId ? { resourceId: p.resourceId } : {}),
        ...(p.voice ? { voice: p.voice } : {}),
        ...(p.format ? { format: p.format } : {}),
        label: p.label,
      });
    }
    return new OpenAICompatibleTtsBackend(p);
  }
  return new UnconfiguredTtsBackend();
}

/** True when a BYO TTS provider is configured (env or saved profile). */
export function hasConfiguredTtsProvider(): boolean {
  if (process.env.ORKAS_TTS_BASE_URL && process.env.ORKAS_TTS_API_KEY && process.env.ORKAS_TTS_MODEL) return true;
  try { return listTtsProfiles().length > 0; } catch { return false; }
}

/** Non-secret active backend identity used to scope persisted duration
 * calibration. A provider change must never reuse another backend's observed
 * speaking pace. */
export function configuredTtsBackendId(): string {
  return resolveTtsBackend().id;
}

export async function generateSpeech(p: TtsParams): Promise<TtsResult> {
  if (!p.text.trim()) return { ok: false, errorCode: 'E_TTS_ARG', message: 'text is required' };
  const resolved = await resolveTtsSelection({
    ...(p.routeRef ? { routeRef: p.routeRef } : {}),
    ...(p.voiceRef ? { voiceRef: p.voiceRef } : {}),
    ...(p.voice ? { legacyVoice: p.voice } : {}),
    ...(p.language ? { language: p.language } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (resolved.ok === false) {
    return {
      ok: false,
      errorCode: resolved.errorCode,
      message: resolved.message,
      requestDisposition: 'rejected_preflight',
      chargeStatus: 'not_charged',
      retryPolicy: 'safe_after_plan_fix',
    };
  }
  const res = await resolveTtsBackend(resolved.selection.routeRef).synthesize({
    ...p,
    routeRef: resolved.selection.routeRef,
    voiceRef: resolved.selection.voiceRef,
    voice: resolved.selection.providerVoiceId,
    language: resolved.selection.language,
  });
  if (res.ok) {
    // Best-effort: measure the synthesized length so callers can check it fits
    // the clip. Never fail a good synthesis on a probe error.
    try {
      const dur = await probeMediaDurationSec(res.path, p.signal);
      if (dur != null) return { ...res, durationSec: dur };
    } catch (err) { log.warn(`probe narration duration: ${redactPaths((err as Error).message)}`); }
  }
  return res;
}
