import { getActiveUserId, hasActiveUser } from './users';
import { registerUserSwitchHook } from './user-switch-hooks';
/**
 * tts — pluggable text-to-speech backend for the `generate_speech`
 * tool. Encapsulated so new backends slot in behind one interface (mirrors the
 * image_gen / video_gen provider-adapter shape):
 *
 *   - 'openai-compatible' (PRIMARY): BYO user TTS API in the OpenAI
 *     `/audio/speech` shape — OpenAI / any compatible gateway.
 *     Config = a saved `TtsProfile` (base url, key, model, voice).
 *   - 'elevenlabs': native `/text-to-speech/:voice_id`, selected only by the
 *     saved profile's explicit provider id; shares the audio HTTP lifecycle.
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
import { randomUUID } from 'node:crypto';
import { Semaphore } from 'async-mutex';
import { acquireWithAbort } from '../util/locks';
import { mediaRateLimitDelay, mediaRateLimitCode, mediaLimitDiagnostics, mediaLimitRetryDelay } from '../util/media-rate-limit';

import type { TtsProfile } from './auth';
import {
  DOUBAO_DEFAULT_VOICE,
  listUsableTtsProfiles,
} from './tts_auth';
import { probeMediaDurationSec } from '../util/media_probe';
import { createLogger } from '../logger';
import { throwIfAborted } from '../util/abort';
import { RetriableHttpStatusError } from '../util/retry';
import { resolveTtsSelection } from './tts_capabilities';
import { DOUBAO_TTS_FORMATS, ttsModelPreset } from './tts_catalog';
import { decodeSpeechBase64, synthesizeNativeWebSocket } from './tts_native_websocket';
import { convertTtsWav, ttsWavConversionAvailable } from '../util/tts-audio';
import { estimateNarrationDuration, measureNarrationUnits, type NarrationDurationEstimate } from '../util/narration-timing';
export { estimateNarrationDuration, measureNarrationUnits } from '../util/narration-timing';
export type { NarrationDurationEstimate } from '../util/narration-timing';

import {
  ORKAS_API_PROVIDER,
  orkasApiUsageHeaders,
  type OrkasApiUsageContext,
} from './orkas_api';

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
  usageContext?: OrkasApiUsageContext;
}

export type TtsResult =
  | {
    ok: true;
    path: string;
    bytes: number;
    backend: string;
    durationSec?: number;
    /** The route and voice the line was made with, including a default the caller left out. */
    routeRef?: string;
    voiceRef?: string;
    /** Made on a service the user configured, which bills them, rather than on credits. */
    billedToOwnAccount?: boolean;
  }
  | {
    ok: false;
    errorCode: string;
    message: string;
    requestDisposition?: 'not_sent' | 'rejected_preflight' | 'sent';
    chargeStatus?: 'not_charged' | 'charged' | 'unknown';
    retryPolicy?: 'safe_after_plan_fix' | 'requires_user_action' | 'unknown';
    providerErrorCode?: string;
  };

type TtsFailure = Extract<TtsResult, { ok: false }>;

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

/** Ratio band applied to MEASURED narration audio. Separate from the estimate
 *  band in `narrationDurationBand`: an estimate carries the estimator's own
 *  error (up to ±20% against this repo's own fixtures), so judging a script
 *  before synthesis needs the wider allowance. A measured duration has no such
 *  error, and every consumer of a measurement must read it the same way. */
export const NARRATION_MEASURED_OVER_RATIO = 1.05;
export const NARRATION_MEASURED_UNDER_RATIO = 0.85;
/** How far an estimate not yet scaled to a measured voice may run past its target before
 *  synthesis is refused: the estimator's own error. A short span between two lines of
 *  dialogue keeps this proportional; a fixed floor of seconds would let a line cover them. */
export const NARRATION_ESTIMATE_OVER_RATIO = 1.2;
/** How many times a turn asks for a short line to be generated again, to the same file, to
 *  fill its scene: the first take plus at most two fills, as other VideoStudio repairs are
 *  bounded. The capped fit note says "twice"; change both together. */
export const NARRATION_FILL_RETRY_LIMIT = 2;

/** Whether synthesized audio runs past the window it was written for. The one
 *  predicate behind both the post-synthesis warning and the authorization for
 *  the bounded fit repair that answers it. They were separate before: the
 *  warning used this ratio while the authorization used the ±5s estimate band,
 *  so a 6.84s line in a 6.125s window was reported `over` and then refused a
 *  repair for having "no matching measured overrun" (2026-08-10 AUTO run). The
 *  model reverted its correct shortening, and `mix` truncated the closing line
 *  0.72s into the delivered video. Pure → unit-tested. */
export function narrationMeasurementOverruns(measuredSec: number, targetSec: number): boolean {
  if (!(measuredSec > 0) || !(targetSec > 0)) return false;
  return measuredSec / targetSec > NARRATION_MEASURED_OVER_RATIO;
}

/** Compare a synthesized narration's measured duration to a target clip length.
 *  Returns null when either duration is unusable. Pure → unit-tested. */
export function assessNarrationFit(input: { measuredSec: number; targetSec: number; wordCount: number; unit?: 'words' | 'characters'; fillLimitReached?: boolean }): NarrationFit | null {
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
  const OVER = NARRATION_MEASURED_OVER_RATIO;
  const UNDER = NARRATION_MEASURED_UNDER_RATIO;
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
    const gap = `Narration is ${round2(measured)}s, ${round2(target - measured)}s shorter than the ${round2(target)}s clip — that much of the clip will have no narration.`;
    message = input.fillLimitReached
      ? `${gap} This line has already been generated again twice this turn, the limit: keep this audio and let the scene finish early.`
      : `${gap} To fill it, ${hint} and generate the line once more to the same output_path.`;
  }
  return { status, measuredSec: round2(measured), targetSec: round2(target), deltaSec, ratio: round2(ratio), wordsPerSec: round2(wps), suggestedWords, suggestedSpeed, message };
}

export interface EstimatedNarrationFit {
  status: 'fits' | 'over' | 'under';
  genericEstimatedSec: number;
  estimatedSec: number;
  targetSec: number;
  toleranceRatio: number;
  toleranceFloorSec: number;
  toleranceSec: number;
  minDurationSec: number;
  maxDurationSec: number;
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

export const NARRATION_DURATION_TOLERANCE_RATIO = 0.05;
export const NARRATION_DURATION_TOLERANCE_FLOOR_SEC = 5;

/** A requested duration is an editorial target, not a frame-exact speech cap.
 *  Use the same symmetric band for estimates and measured audio so a candidate
 *  cannot pass the free check and then fail under a contradictory delivery
 *  threshold. */
export function narrationDurationBand(targetSec: number): {
  toleranceRatio: number;
  toleranceFloorSec: number;
  toleranceSec: number;
  minDurationSec: number;
  maxDurationSec: number;
} {
  const toleranceSec = Math.max(
    NARRATION_DURATION_TOLERANCE_FLOOR_SEC,
    targetSec * NARRATION_DURATION_TOLERANCE_RATIO,
  );
  return {
    toleranceRatio: NARRATION_DURATION_TOLERANCE_RATIO,
    toleranceFloorSec: NARRATION_DURATION_TOLERANCE_FLOOR_SEC,
    toleranceSec: round2(toleranceSec),
    minDurationSec: round2(Math.max(0, targetSec - toleranceSec)),
    maxDurationSec: round2(targetSec + toleranceSec),
  };
}

/** @deprecated Use narrationDurationBand so callers retain both boundaries. */
export function estimatedNarrationOverrunToleranceSec(targetSec: number): number {
  return narrationDurationBand(targetSec).toleranceSec;
}

/** Whether a narration fit verdict may block production.
 *
 *  Both sides of the approved delivery band are actionable. The five-second
 *  floor deliberately keeps ordinary short-form editorial variation inside
 *  the band; `under` now means the narration fell outside even that allowance. */
export function narrationFitBlocksProduction(status: EstimatedNarrationFit['status']): boolean {
  return status !== 'fits';
}

/** Apply the VideoStudio delivery band to either a generic estimate or a
 *  measured-voice-calibrated estimate, before billing. */
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
  const band = narrationDurationBand(input.targetSec);
  const status: EstimatedNarrationFit['status'] =
    rawEstimatedSec > band.maxDurationSec
      ? 'over'
      : rawEstimatedSec < band.minDurationSec
        ? 'under'
        : 'fits';
  return {
    status,
    genericEstimatedSec: input.estimate.estimatedSec,
    estimatedSec,
    targetSec: round2(input.targetSec),
    ...band,
    durationScale: Math.round(durationScale * 10_000) / 10_000,
    unit: input.estimate.unit,
    units: input.estimate.units,
    suggestedUnits: Math.max(1, Math.round(input.estimate.units * input.targetSec / rawEstimatedSec)),
  };
}

interface TtsBackend {
  id: string;
  synthesize(p: TtsParams, timeoutMs?: number): Promise<TtsResult>;
}

// Shared by every PC speech entry, not just one Agent's adjacent tool batch.
// Waiting has no new timeout; transport timers start inside synthesize after admission.
const speechSlots = new Semaphore(2);
const rateLimitReceipts = new WeakMap<TtsFailure, { delay: number; status: number; code: string }>();
let speechOwnerVersion = 0;
registerUserSwitchHook('tts-request-owner', () => { speechOwnerVersion += 1; });
const speechOwnerChanged = (owner: string, version: number) => version !== speechOwnerVersion
  || (!!owner && (!hasActiveUser() || getActiveUserId() !== owner));

async function speechLimitFailure(response: Response, signal?: AbortSignal): Promise<TtsFailure | null> {
  if (response.status !== 429) return null;
  const delay = await mediaRateLimitDelay(response, signal);
  if (delay === null) return null;
  const failure = sentFailure('E_TTS_API_ERROR', 'The speech service is rate limited.', 'unknown', 'not_charged');
  rateLimitReceipts.set(failure, { delay, status: response.status, code: mediaRateLimitCode(response) });
  return failure;
}

function isClearlyNonAudioResponse(resp: Response): boolean {
  const contentType = String(resp.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return contentType === 'application/json'
    || contentType === 'application/problem+json'
    || contentType === 'application/xml'
    || contentType === 'text/xml'
    || contentType === 'text/html'
    || contentType === 'text/plain';
}

function sentFailure(
  errorCode: string,
  message: string,
  retryPolicy: TtsFailure['retryPolicy'] = 'unknown',
  chargeStatus: TtsFailure['chargeStatus'] = 'unknown',
  providerErrorCode?: string,
): TtsFailure {
  return {
    ok: false,
    errorCode,
    message,
    requestDisposition: 'sent',
    chargeStatus,
    retryPolicy,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
}

function invalidAudioResponse(): TtsFailure {
  return sentFailure(
    'E_TTS_INVALID_AUDIO',
    'The speech provider returned a non-audio response. No audio file was saved.',
  );
}

function providerHttpFailure(provider: string, status: number): TtsFailure {
  if (status === 401 || status === 403) {
    return sentFailure(
      'E_TTS_API_ERROR',
      `${provider} rejected the configured credentials. Update the speech provider settings before retrying.`,
      'requires_user_action',
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return sentFailure(
      'E_TTS_API_ERROR',
      `${provider} rejected the speech request. Verify the selected model, voice, language, and format before retrying.`,
      'requires_user_action',
    );
  }
  if (status === 429) {
    return sentFailure(
      'E_TTS_API_ERROR',
      `${provider} is rate limited. Wait before starting a new retry.`,
    );
  }
  return sentFailure(
    'E_TTS_API_ERROR',
    status >= 500
      ? `${provider} is temporarily unavailable.`
      : `${provider} could not complete the speech request.`,
  );
}

async function persistSynthesizedAudio(
  backend: string,
  outputAbsPath: string,
  buf: Buffer,
): Promise<TtsResult> {
  try {
    await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
    await fs.writeFile(outputAbsPath, buf);
  } catch {
    log.warn('persist synthesized audio failed');
    return sentFailure(
      'E_TTS_WRITE',
      'Speech was generated but could not be saved. Free storage or choose a writable output path before retrying; the provider may already have charged for this request.',
      'requires_user_action',
    );
  }
  return { ok: true, path: outputAbsPath, bytes: buf.length, backend };
}

/** Default request timeout for a synthesis call. Speech of a sentence is quick;
 *  generous enough for a paragraph without hanging forever. */
const TTS_TIMEOUT_MS = 120_000;
function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Bound receipt before buffering, including chunked bodies with no length.
 * Keep the request deadline and cancellation active until the body is drained.
 * A failed receipt is still a dispatched, potentially billable operation. */
async function readTtsResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  parentSignal?: AbortSignal,
): Promise<{ ok: true; buffer: Buffer } | TtsFailure> {
  const tooLarge = () => sentFailure('E_TTS_TOO_LARGE', 'The speech response was too large and was not saved.');
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    return tooLarge();
  }
  if (!response.body) return { ok: true, buffer: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let complete = false;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let tail: Buffer | undefined;
    let tailBytes = 0;
    throwIfAborted(signal);
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) { complete = true; break; }
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - total) return tooLarge();
      total += value.byteLength;
      // Coalesce tiny wire chunks so their object overhead is bounded too.
      for (let offset = 0; offset < value.byteLength;) {
        tail ??= Buffer.allocUnsafe(64 * 1024);
        const length = Math.min(tail.length - tailBytes, value.byteLength - offset);
        tail.set(value.subarray(offset, offset + length), tailBytes);
        offset += length;
        tailBytes += length;
        if (tailBytes === tail.length) {
          chunks.push(tail);
          tail = undefined;
          tailBytes = 0;
        }
      }
    }
    if (tail && tailBytes) chunks.push(tail.subarray(0, tailBytes));
    return { ok: true, buffer: Buffer.concat(chunks, total) };
  } catch {
    const aborted = parentSignal?.aborted;
    if (!aborted) log.warn('tts response read failed', { reason: signal.aborted ? 'timeout' : 'network' });
    return sentFailure(
      aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK',
      aborted
        ? 'TTS was aborted after dispatch; the provider charge status is unknown.'
        : 'TTS request failed (network/endpoint error).',
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

// ── Backends: binary-audio HTTP (OpenAI-compatible / ElevenLabs BYO) ────────

class HttpAudioTtsBackend implements TtsBackend {
  readonly id: string;
  constructor(private readonly profile: { provider?: string; baseUrl: string; apiKey: string; model: string; voice?: string; format?: string; label?: string }) {
    this.id = profile.provider === 'elevenlabs' ? 'elevenlabs' : 'openai-compatible';
  }

  async synthesize(p: TtsParams, timeoutMs = TTS_TIMEOUT_MS): Promise<TtsResult> {
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    const voice = p.voice || this.profile.voice;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    let url = `${base}/audio/speech`;
    let headers: Record<string, string> = { Authorization: `Bearer ${this.profile.apiKey}`, 'Content-Type': 'application/json',
      ...(this.profile.provider === ORKAS_API_PROVIDER ? orkasApiUsageHeaders(p.usageContext) : {}) };
    let body: Record<string, unknown> = {
      model: this.profile.model,
      input: p.text,
      ...(voice ? { voice } : {}),
      response_format: format,
      ...(typeof p.speed === 'number' ? { speed: p.speed } : {}),
    };
    const capability = ttsModelPreset(this.profile.provider || '', this.profile.model);
    const invalid = validateNativeTtsArgs(capability, p, format, voice);
    if (invalid) return invalid;
    if (this.id === 'elevenlabs') {
      // Native contract: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
      // Request PCM 24k for WAV; 44.1k PCM/WAV requires a Pro subscription.
      const codecs: Record<string, string> = { mp3: 'mp3_44100_128', wav: 'pcm_24000', pcm: 'pcm_24000', opus: 'opus_48000_128' };
      if (!voice || !Object.hasOwn(codecs, format) || (p.speed !== undefined && (!Number.isFinite(p.speed) || p.speed < 0.7 || p.speed > 1.2))) {
        return { ok: false, errorCode: 'E_TTS_ARG', message: 'ElevenLabs requires a voice id, mp3/wav/pcm/opus output, and speed between 0.7 and 1.2.', requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'safe_after_plan_fix' };
      }
      url = `${base}/text-to-speech/${encodeURIComponent(voice)}?${new URLSearchParams({ output_format: codecs[format] })}`;
      headers = { 'xi-api-key': this.profile.apiKey, 'Content-Type': 'application/json' };
      body = { text: p.text, model_id: this.profile.model, ...(p.speed !== undefined && (!capability || capability.speed) ? { voice_settings: { speed: p.speed } } : {}) };
      if (this.profile.model === 'eleven_v4_turbo') {
        p.onProgress?.({ phase: 'tts.request', message: 'Requesting speech from the selected provider.' });
        const result = await synthesizeNativeWebSocket(this.profile as TtsProfile, p, combineSignal(p.signal, timeoutMs), format, codecs[format]);
        if (result.ok === false) return nativeSocketFailure(result, p.signal);
        return persistSynthesizedAudio(this.id, p.outputAbsPath, format === 'wav' ? wrapPcm16MonoWav(result.audio) : result.audio);
      }
    }

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || base}` });
    const requestSignal = combineSignal(p.signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      const aborted = p.signal?.aborted;
      // Don't echo the raw fetch error (it can embed the configured endpoint URL).
      if (!aborted) log.warn('tts request failed', { reason: requestSignal.aborted ? 'timeout' : 'network' });
      return sentFailure(
        aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK',
        aborted
          ? 'TTS was aborted after dispatch; the provider charge status is unknown.'
          : 'TTS request failed (network/endpoint error).',
      );
    }
    if (!resp.ok) {
      const limited = await speechLimitFailure(resp, p.signal);
      if (limited) { void resp.body?.cancel().catch(() => {}); return limited; }
      void resp.body?.cancel().catch(() => {});
      return providerHttpFailure('The speech provider', resp.status);
    }
    if (isClearlyNonAudioResponse(resp)) {
      void resp.body?.cancel().catch(() => {});
      return invalidAudioResponse();
    }
    const receipt = await readTtsResponse(resp, MAX_TTS_BYTES, requestSignal, p.signal);
    if (receipt.ok === false) return receipt;
    const buf = receipt.buffer;
    if (!buf.length) return sentFailure('E_TTS_EMPTY', 'The speech provider returned empty audio.');
    const audio = this.id === 'elevenlabs' && format === 'wav' ? wrapPcm16MonoWav(buf) : buf;
    return persistSynthesizedAudio(this.id, p.outputAbsPath, audio);
  }
}

function validateNativeTtsArgs(capability: ReturnType<typeof ttsModelPreset>, p: TtsParams, format: string, voice?: string): TtsFailure | undefined {
  if (!capability) return undefined; // Legacy/custom profiles retain their protocol contract.
  const speed = p.speed;
  if (!voice || !capability.formats.includes(format)
    || (speed !== undefined && (!Number.isFinite(speed) || (capability.speed
      ? speed < capability.speed[0] || speed > capability.speed[1] : speed !== 1)))
    || (capability.maxCharacters !== undefined && exceedsSpeechCharacterLimit(p.text, capability.maxCharacters))) {
    return { ok: false, errorCode: 'E_TTS_ARG', message: 'Check the selected speech model, voice, text length, output format, and speed.',
      requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'safe_after_plan_fix' };
  }
}

function exceedsSpeechCharacterLimit(text: string, limit: number): boolean {
  let count = 0;
  for (const _character of text) if (++count > limit) return true;
  return false;
}

function nativeSocketFailure(result: { errorCode: string; dispatched: boolean }, signal?: AbortSignal): TtsFailure {
  const failure = { ok: false as const, errorCode: signal?.aborted ? 'E_TTS_ABORTED' : result.errorCode,
    message: result.errorCode === 'E_TTS_PROXY'
      ? 'Speech could not connect through the configured proxy. Use a supported HTTP proxy before retrying.'
      : 'Speech did not complete. Check the provider credentials, model and voice before starting a new retry.' };
  return result.dispatched ? { ...failure, requestDisposition: 'sent', chargeStatus: 'unknown', retryPolicy: 'unknown' }
    : { ...failure, requestDisposition: 'not_sent', chargeStatus: 'not_charged', retryPolicy: 'requires_user_action' };
}

/** Native JSON and task protocols share the existing bounded receipt, durable
 * result and billing-uncertainty boundaries; none falls back to another vendor. */
class NativeTtsBackend implements TtsBackend {
  readonly id: string;
  constructor(private readonly profile: TtsProfile) { this.id = profile.provider; }
  async synthesize(p: TtsParams, timeoutMs = TTS_TIMEOUT_MS): Promise<TtsResult> {
    const capability = ttsModelPreset(this.id, this.profile.model);
    const format = (p.format || this.profile.format || capability?.formats[0] || 'mp3').toLowerCase();
    if (!capability) return { ok: false, errorCode: 'E_TTS_ARG', message: 'Select a supported speech model in Settings.',
      requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'requires_user_action' };
    const invalid = validateNativeTtsArgs(capability, p, format, p.voice);
    if (invalid) return invalid;
    if (this.id === 'google' && !ttsWavConversionAvailable(format)) return { ok: false, errorCode: 'E_TTS_ARG',
      message: 'Select WAV output or restore the local audio converter before retrying.',
      requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'requires_user_action' };
    const signal = combineSignal(p.signal, timeoutMs);
    if (this.profile.model.startsWith('cosyvoice-')) {
      p.onProgress?.({ phase: 'tts.request', message: 'Requesting speech from the selected provider.' });
      const result = await synthesizeNativeWebSocket(this.profile, p, signal, format);
      if (result.ok === false) return nativeSocketFailure(result, p.signal);
      return persistSynthesizedAudio(this.id, p.outputAbsPath, result.audio);
    }
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    let url: string;
    let body: unknown;
    let headers: Record<string, string> = { Authorization: `Bearer ${this.profile.apiKey}`, 'Content-Type': 'application/json' };
    if (this.id === 'minimax') {
      url = `${base}/t2a_v2`;
      body = { model: this.profile.model, text: p.text, stream: false, output_format: 'hex',
        voice_setting: { voice_id: p.voice, speed: p.speed ?? 1 },
        audio_setting: { format, sample_rate: format === 'opus' ? 24000 : 32000, bitrate: 128000, channel: 1 } };
    } else if (this.id === 'aliyun') {
      url = `${base}/api/v1/services/audio/tts/SpeechSynthesizer`;
      body = { model: this.profile.model, input: { text: p.text, voice: p.voice, format, sample_rate: 24000, rate: p.speed ?? 1 } };
    } else {
      url = `${base}/interactions`;
      headers = { 'x-goog-api-key': this.profile.apiKey, 'Content-Type': 'application/json' };
      body = { model: this.profile.model, input: [{ type: 'user_input', content: [{ type: 'text', text: p.text }] }],
        response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: p.voice }] }, store: false };
    }
    p.onProgress?.({ phase: 'tts.request', message: 'Requesting speech from the selected provider.' });
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
      if (!response.ok) {
        const limited = await speechLimitFailure(response, p.signal);
        void response.body?.cancel().catch(() => {});
        return limited ?? providerHttpFailure('The speech provider', response.status);
      }
      const receipt = await readTtsResponse(response, this.id === 'aliyun' ? 1024 * 1024 : MAX_TTS_BYTES * 2 + 1024 * 1024, signal, p.signal);
      if (receipt.ok === false) return receipt;
      const data = JSON.parse(receipt.buffer.toString('utf8'));
      let audio: Buffer | undefined;
      if (this.id === 'minimax') {
        const hex = data.data?.audio;
        if (data.base_resp?.status_code === 0 && data.data?.status === 2 && typeof hex === 'string'
          && hex.length > 0 && hex.length <= MAX_TTS_BYTES * 2 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) audio = Buffer.from(hex, 'hex');
      } else if (this.id === 'google') {
        if (data.status !== 'completed' || !Array.isArray(data.steps)) return invalidAudioResponse();
        const outputs = data.steps.filter((step: any) => step?.type === 'model_output')
          .flatMap((step: any) => Array.isArray(step.content) ? step.content : []).filter((part: any) => part?.type === 'audio');
        // Single-speaker unary synthesis must yield one complete audio artifact.
        if (outputs.length !== 1 || outputs[0].mime_type !== 'audio/wav') return invalidAudioResponse();
        const wav = decodeSpeechBase64(outputs[0].data);
        if (wav) audio = await convertTtsWav(wav, format, signal);
      } else {
        if (data.output?.finish_reason !== 'stop' || data.code) return invalidAudioResponse();
        const resultUrl = new URL(data.output.audio.url);
        if (!['http:', 'https:'].includes(resultUrl.protocol) || resultUrl.username || resultUrl.password || resultUrl.port
          || resultUrl.hostname !== 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com') return invalidAudioResponse();
        resultUrl.protocol = 'https:';
        // Download only the documented result host. Never forward provider credentials or follow redirects.
        const download = await fetch(resultUrl.href, { signal, redirect: 'error' });
        if (!download.ok || isClearlyNonAudioResponse(download)) {
          void download.body?.cancel().catch(() => {}); return invalidAudioResponse();
        }
        const result = await readTtsResponse(download, MAX_TTS_BYTES, signal, p.signal);
        if (result.ok === false) return result;
        audio = result.buffer;
      }
      if (!audio?.length) return invalidAudioResponse();
      if (signal.aborted) return sentFailure(p.signal?.aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK', 'Speech receipt was interrupted; the provider charge status is unknown.');
      return persistSynthesizedAudio(this.id, p.outputAbsPath, audio);
    } catch {
      return sentFailure(p.signal?.aborted ? 'E_TTS_ABORTED' : signal.aborted ? 'E_TTS_NETWORK' : 'E_TTS_API_ERROR',
        'Speech did not complete. Check the selected provider before starting a new retry.');
    }
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
 *  with `{code:20000000}`; clean EOF alone does not prove synthesis completed.
 *  Any other code is an error event. Pure → unit-tested. */
export function parseDoubaoV3Ndjson(raw: string): { ok: true; audio: Buffer } | { ok: false; message: string } {
  const chunks: Buffer[] = [];
  let error = '';
  let sawDone = false;
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    if (s.startsWith('data:')) s = s.slice(5).trim();
    let obj: { code?: number | string; data?: string; message?: string; msg?: string };
    try { obj = JSON.parse(s); } catch { continue; } // tolerate stray non-JSON lines
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const code = typeof obj.code === 'number'
      ? obj.code
      : (typeof obj.code === 'string' && /^-?\d+$/.test(obj.code.trim()) ? Number(obj.code) : undefined);
    if (code === 0 && typeof obj.data === 'string' && obj.data) {
      chunks.push(Buffer.from(obj.data, 'base64'));
    } else if (code === DOUBAO_V3_DONE_CODE) {
      sawDone = true;
    } else if (code !== undefined && code !== 0 && code !== DOUBAO_V3_DONE_CODE) {
      error = obj.message || obj.msg || `code ${code}`;
    }
  }
  if (error) return { ok: false, message: `Doubao TTS failed: ${error}` };
  if (!chunks.length) return { ok: false, message: 'Doubao TTS returned no audio.' };
  if (!sawDone) return { ok: false, message: 'Doubao TTS stream ended before completion.' };
  return { ok: true, audio: Buffer.concat(chunks) };
}

/** The V3 streaming endpoint uses provider-specific container names and does
 * not stream a WAV container. Request PCM for WAV and wrap it after parsing. */
export function normalizeDoubaoAudioFormat(format: string): string {
  const value = String(format || 'mp3').trim().toLowerCase();
  if (value === 'wav') return 'pcm';
  if (value === 'pcm') return 'pcm';
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

  async synthesize(p: TtsParams, timeoutMs = TTS_TIMEOUT_MS): Promise<TtsResult> {
    if (p.speed !== undefined && (!Number.isFinite(p.speed) || p.speed < 0.5 || p.speed > 2)) {
      return { ok: false, errorCode: 'E_TTS_ARG', message: 'Doubao speech speed must be between 0.5 and 2.', requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'safe_after_plan_fix' };
    }
    const speaker = p.voice || this.profile.voice;
    if (!speaker) return { ok: false, errorCode: 'E_TTS_ARG', message: 'Doubao TTS requires a voice (speaker).' };
    const base = (this.profile.baseUrl || 'https://openspeech.bytedance.com').replace(/\/+$/, '');
    const url = `${base}/api/v3/tts/unidirectional`;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    if (!DOUBAO_TTS_FORMATS.includes(format)) {
      return { ok: false, errorCode: 'E_TTS_ARG', message: 'Doubao speech supports mp3, wav, pcm, opus and ogg output.',
        requestDisposition: 'rejected_preflight', chargeStatus: 'not_charged', retryPolicy: 'safe_after_plan_fix' };
    }
    const upstreamFormat = normalizeDoubaoAudioFormat(format);
    const resourceId = this.profile.resourceId?.trim() || deriveDoubaoResourceId(speaker);
    const body = {
      user: { uid: 'orkas' },
      req_params: {
        text: p.text,
        speaker,
        ...(resourceId === 'seed-icl-2.0' ? { model: 'seed-tts-2.0-standard' } : {}),
        audio_params: {
          format: upstreamFormat, sample_rate: upstreamFormat === 'ogg_opus' ? 48000 : 24000,
          // V3 uses a percentage offset: -50 = 0.5x, 0 = 1x, 100 = 2x.
          ...(p.speed !== undefined ? { speech_rate: Math.round((p.speed - 1) * 100) } : {}),
        },
      },
    };

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || 'Doubao'}` });
    const requestSignal = combineSignal(p.signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.profile.apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      const aborted = p.signal?.aborted;
      if (!aborted) log.warn('doubao tts request failed', { reason: requestSignal.aborted ? 'timeout' : 'network' });
      return sentFailure(
        aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK',
        aborted
          ? 'TTS was aborted after dispatch; the provider charge status is unknown.'
          : 'TTS request failed (network/endpoint error).',
      );
    }
    if (!resp.ok) {
      const limited = await speechLimitFailure(resp, p.signal);
      if (limited) { void resp.body?.cancel().catch(() => {}); return limited; }
      void resp.body?.cancel().catch(() => {});
      return providerHttpFailure('Doubao TTS', resp.status);
    }
    // base64 inflates ~1.33×; a 50MB audio cap is ~67MB of NDJSON text.
    const receipt = await readTtsResponse(resp, MAX_TTS_BYTES * 2, requestSignal, p.signal);
    if (receipt.ok === false) return receipt;
    const raw = receipt.buffer.toString('utf8');
    if (receipt.buffer.length <= 16 * 1024) {
      try {
        const rejection = JSON.parse(raw);
        if (rejection && !['data', 'id', 'task_id', 'audio', 'output'].some(field => rejection[field]) && String(rejection.code) === '45000000'
          && (rejection.message ?? rejection.msg) === 'quota exceeded for types: concurrency') {
          const failure = sentFailure('E_TTS_API_ERROR', 'The speech service is rate limited.', 'unknown', 'not_charged');
          const delay = new RetriableHttpStatusError(429, 'tts', resp.headers.get('retry-after')).retryAfterMs ?? 0;
          rateLimitReceipts.set(failure, { delay, status: 200, code: '45000000_concurrency' });
          return failure;
        }
      } catch { /* Multiple events/partial audio never establish a safe rejection. */ }
    }
    const parsed = parseDoubaoV3Ndjson(raw);
    if (parsed.ok === false) {
      return sentFailure(
        'E_TTS_API_ERROR',
        'Doubao speech generation failed or did not complete. No audio file was saved; the provider may already have charged for this request.',
      );
    }
    const buf = format === 'wav' ? wrapPcm16MonoWav(parsed.audio) : parsed.audio;
    if (buf.length > MAX_TTS_BYTES) return sentFailure('E_TTS_TOO_LARGE', 'The speech response was too large and was not saved.');
    if (!buf.length) return sentFailure('E_TTS_EMPTY', 'Doubao TTS returned empty audio.');
    return persistSynthesizedAudio(this.id, p.outputAbsPath, buf);
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
    return new HttpAudioTtsBackend({
      baseUrl: envBase, apiKey: envKey, model: envModel,
      ...(process.env.ORKAS_TTS_VOICE ? { voice: process.env.ORKAS_TTS_VOICE } : {}),
      ...(process.env.ORKAS_TTS_FORMAT ? { format: process.env.ORKAS_TTS_FORMAT } : {}),
      label: 'env',
    });
  }
  let profiles: TtsProfile[] = [];
  try { profiles = listUsableTtsProfiles(); } catch { log.warn('list TTS profiles failed'); }
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
    if (['minimax', 'aliyun', 'google'].includes(p.provider)) return new NativeTtsBackend(p);
    return new HttpAudioTtsBackend(p);
  }
  return new UnconfiguredTtsBackend();
}

/** True when a BYO TTS provider is configured (env or saved profile). */
export function hasConfiguredTtsProvider(): boolean {
  if (process.env.ORKAS_TTS_BASE_URL && process.env.ORKAS_TTS_API_KEY && process.env.ORKAS_TTS_MODEL) return true;
  try { return listUsableTtsProfiles().length > 0; } catch { return false; }
}

/** Non-secret active backend identity used to scope persisted duration
 * calibration. A provider change must never reuse another backend's observed
 * speaking pace. */
export function configuredTtsBackendId(): string {
  return resolveTtsBackend().id;
}

export async function generateSpeech(p: TtsParams): Promise<TtsResult> {
  const owner = hasActiveUser() ? getActiveUserId() : '';
  const ownerVersion = speechOwnerVersion;
  let release: (() => void) | undefined;
  const queuedAt = Date.now();
  const queueRef = speechSlots.isLocked() ? randomUUID() : undefined;
  const queueLog = (event: 'wait' | 'result', result?: 'admitted' | 'cancelled' | 'owner_changed') => {
    if (!queueRef) return;
    try { log.warn('media_admission_wait', { event, operation: 'tts', request_ref: queueRef,
      concurrency: 2, wait_ms: Math.max(0, Date.now() - queuedAt), ...(result ? { outcome: result } : {}) }); } catch { /* Best effort. */ }
  };
  queueLog('wait');
  try {
    try {
      const acquire = async () => (await speechSlots.acquire())[1];
      release = p.signal ? await acquireWithAbort(acquire, p.signal) : await acquire();
      throwIfAborted(p.signal);
      if (speechOwnerChanged(owner, ownerVersion)) throw new Error('speech owner changed');
      queueLog('result', 'admitted');
    } catch {
      queueLog('result', speechOwnerChanged(owner, ownerVersion) && !p.signal?.aborted ? 'owner_changed' : 'cancelled');
      return { ok: false, errorCode: 'E_TTS_ABORTED', message: 'TTS was aborted before dispatch.',
        requestDisposition: 'not_sent', chargeStatus: 'not_charged', retryPolicy: 'unknown' };
    }
    return await generateSpeechObserved(p, owner, ownerVersion);
  } finally {
    release?.();
  }
}

async function generateSpeechObserved(p: TtsParams, owner: string, ownerVersion: number): Promise<TtsResult> {
  if (!p.text.trim()) return { ok: false, errorCode: 'E_TTS_ARG', message: 'text is required' };
  const resolved = await resolveTtsSelection({
    ...(p.routeRef ? { routeRef: p.routeRef } : {}),
    ...(p.voiceRef ? { voiceRef: p.voiceRef } : {}),
    ...(p.voice ? { legacyVoice: p.voice } : {}),
    ...(p.language ? { language: p.language } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (resolved.ok === false) {
    const requiresUserAction = [
      'E_TTS_USER_DISABLED',
      'E_TTS_SERVICE_DISABLED',
      'E_TTS_SIGN_IN_REQUIRED',
      'E_TTS_NO_PROVIDER',
      'E_TTS_NOT_CONFIGURED',
    ].includes(resolved.errorCode);
    return {
      ok: false,
      errorCode: resolved.errorCode,
      message: resolved.message,
      requestDisposition: 'rejected_preflight',
      chargeStatus: 'not_charged',
      retryPolicy: requiresUserAction ? 'requires_user_action' : 'safe_after_plan_fix',
    };
  }
  if (p.signal?.aborted) {
    return {
      ok: false,
      errorCode: 'E_TTS_ABORTED',
      message: 'TTS was aborted before the provider request.',
      requestDisposition: 'not_sent',
      chargeStatus: 'not_charged',
      retryPolicy: 'unknown',
    };
  }
  const backend = resolveTtsBackend(resolved.selection.routeRef);
  const diagnostics = mediaLimitDiagnostics('tts');
  // Admission wait has no new timeout. Once dispatched, attempts and backoff
  // consume one monotonic budget instead of restarting the timer on each retry.
  const deadline = performance.now() + TTS_TIMEOUT_MS;
  let res: TtsResult;
  try {
    for (let attempt = 0; ; attempt++) {
      if (p.signal?.aborted || speechOwnerChanged(owner, ownerVersion)) {
        diagnostics.finish(p.signal?.aborted ? 'cancelled' : 'owner_changed');
        return { ok: false, errorCode: 'E_TTS_ABORTED', message: 'TTS was aborted before dispatch.',
          requestDisposition: 'not_sent', chargeStatus: 'not_charged', retryPolicy: 'unknown' };
      }
      const remaining = Math.ceil(deadline - performance.now());
      if (attempt > 0 && remaining <= 0) {
        diagnostics.finish('budget_exhausted');
        res = sentFailure('E_TTS_NETWORK', 'Speech timed out waiting for service capacity.', 'unknown', 'not_charged');
        break;
      }
      diagnostics.attempt(attempt);
      res = await backend.synthesize({
        ...p,
        routeRef: resolved.selection.routeRef,
        voiceRef: resolved.selection.voiceRef,
        voice: resolved.selection.providerVoiceId,
        language: resolved.selection.language,
      }, Math.max(1, remaining));
      const receipt = res.ok === false ? rateLimitReceipts.get(res) : undefined;
      const delay = receipt ? Math.min(mediaLimitRetryDelay(attempt, receipt.delay, 'tts'), Math.max(0, deadline - performance.now())) : 0;
      if (receipt) diagnostics.rejected(receipt.status, receipt.code, delay);
      if (receipt === undefined) {
        diagnostics.finish(res.ok ? 'recovered' : p.signal?.aborted ? 'cancelled' : 'failed', res.ok ? 200 : undefined);
        break;
      }
      p.onProgress?.({ phase: 'tts.rate_limit', message: 'Speech service is busy; waiting before retrying the rejected request.' });
      try { await diagnostics.wait(attempt, delay, p.signal); }
      catch {
        diagnostics.finish('cancelled');
        return { ok: false, errorCode: 'E_TTS_ABORTED', message: 'TTS was aborted while waiting for service capacity.',
          requestDisposition: 'sent', chargeStatus: 'not_charged', retryPolicy: 'unknown' };
      }
    }
  } catch (error) { diagnostics.finish(p.signal?.aborted ? 'cancelled' : 'failed'); throw error; }
  if (!res.ok) return res;
  const made = {
    ...res,
    routeRef: resolved.selection.routeRef,
    voiceRef: resolved.selection.voiceRef,
    billedToOwnAccount: true,
  };
  // Best-effort: measure the synthesized length so callers can check it fits
  // the clip. Never fail a good synthesis on a probe error.
  try {
    const dur = await probeMediaDurationSec(res.path, p.signal);
    if (dur != null) return { ...made, durationSec: dur };
  } catch { log.warn('probe narration duration failed'); }
  return made;
}
