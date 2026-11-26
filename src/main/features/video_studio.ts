import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow, NativeImage as ElectronNativeImage, Rectangle } from 'electron';

import { bundledFfmpegPaths, bundledWhisperPaths } from '../util/bundled-runtime';
import { redactPaths } from '../util/redact';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { createLogger } from '../logger';
import { getCurrentLang } from '../i18n';
import { writeJson } from '../storage';
import { prepareProducedFileForInput } from './produced_output_hooks';
import {
  writeFrameContactSheet,
  type FrameSampleEvidence,
  type Issue,
} from './video_studio_qa';
import { extractCssImports, extractCssUrls, extractHtmlResourceRefs, parseHtmlStructure, type HtmlResourceRef } from './video_studio_html_check';
import {
  PHRASE_SILENCE_FILTER, packTranscriptPhrases, parseSilenceLog, pausesHoldSpeech, phraseViewForResult, placeWordsInSpeech, speechSpans,
  type PhraseSpan, type PhraseWord,
} from './video_phrases';
import { rhythmSteps, tempoOf } from './audio_rhythm';
import { hardenedWebPreferences } from '../util/window-security';
import { killProcessTree } from '../../core-agent/src/sandbox/executor';

const log = createLogger('video-studio');

function logOptionalReadFailure(message: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
  log.warn(message, { error: logErrorSummary(err) });
}

const COMPOSITION_LOAD_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_LOAD_TIMEOUT_MS) || 30_000;
const COMPOSITION_READY_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_READY_TIMEOUT_MS) || 20_000;
export const COMPOSITION_SCRIPT_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_SCRIPT_TIMEOUT_MS) || 15_000;
export const COMPOSITION_RENDER_FRAME_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_RENDER_FRAME_TIMEOUT_MS) || 20_000;

export type VideoStudioOp =
  | 'reference.inspect'
  | 'product.capture'
  | 'speech.capabilities'
  | 'speech.transcribe'
  | 'video.check'
  | 'video.sheet'
  | 'video.render'
  | 'video.ship';

export type RenderQuality = 'draft' | 'standard' | 'high';
export type RenderFormat = 'mp4' | 'webm';

export interface CompositionOptions {
  compositionDirAbs: string;
  outputAbsPath?: string;
  quality?: RenderQuality;
  fps?: number;
  /** Final exports normally choose the highest safe fps for this machine.
   * Set false only when the user explicitly requires exact render settings. */
  allowFpsFallback?: boolean;
  format?: RenderFormat;
  /** Timing-normalized visual identity of the canonical composition inputs,
   * computed by the owning tool layer. When present, successful renders
   * persist provenance and later identical-key renders may reuse the prior
   * video track (audio-only remux). Absent means no reuse is attempted. */
  visualSignature?: string;
  /** Machine-private content-addressed store for per-scene rendered segments
   * (P3c R2). Absent means scene-segment assembly is never attempted. */
  segmentCacheDirAbs?: string;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export interface SpeechTranscribeOptions {
  inputAbsPath: string;
  transcriptAbsPath?: string;
  model?: string;
  language?: string;
  timestamps?: 'segment' | 'word';
  /** Also return the phrase view's lines as `phrase_lines`, for frames under them. */
  phraseLines?: boolean;
  /** Leave words the recognizer gave no room for a time out of `words` instead of refusing
   *  the transcript. Only for looking at frames under what is heard: subtitles and cuts need
   *  every word timed. */
  looseTiming?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export type VideoStudioResult =
  | { ok: true; op: VideoStudioOp; [key: string]: unknown }
  | { ok: false; op?: VideoStudioOp; errorCode: string; message: string; [key: string]: unknown };

export type AudioTrack = {
  absPath: string;
  startSec: number;
  declaredDurationSec?: number;
  volume: number;
  /** Read the source from here for this long instead of from its start. */
  inSec?: number;
  durSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Lowered under `voice` tracks. */
  duck?: boolean;
  voice?: boolean;
};

export type CompositionMeta = {
  htmlPath: string;
  html: string;
  rootAttrs: Record<string, string>;
  id: string;
  width: number;
  height: number;
  durationSec: number;
  audioTracks: AudioTrack[];
};

export type MediaProbe = {
  container?: string;
  container_brand?: string;
  duration_seconds: number | null;
  size_bytes: number | null;
  video?: {
    codec: string;
    width?: number;
    height?: number;
    sample_aspect_ratio?: string;
    rotation?: number;
    duration_seconds?: number;
    avg_frame_rate?: string;
  };
  audio?: {
    codec: string;
    duration_seconds?: number;
    bit_rate?: number;
  };
};

export type NativeRenderProfile = {
  constrained: boolean;
  machine_ram_gb: number;
  cost_units: number;
  decision: 'proceed' | 'degrade' | 'fail_fast';
  requested_fps: number;
  render_fps: number;
  observed_gpu_mode?: 'hardware' | 'software';
  degraded_fps?: string;
  fallback_reason?: 'constrained_machine';
  confirmation_required?: false;
  degrade_ineffective?: string;
  frame_pipeline?: 'raw_bgra_pipe' | 'video_track_reuse' | 'scene_segment_assembly';
  /** Why the scene-segment pipeline did not own this render. Present only on
   * raw whole-composition renders so a raw run is always explainable. */
  segment_assembly_ineligible_reasons?: string[];
  capture_pipeline_seconds?: number;
  encoder_finalize_seconds?: number;
  total_render_seconds?: number;
  observed_capture_fps?: number;
  observed_realtime_factor?: number;
  frame_bytes_streamed?: number;
  temporary_frame_bytes?: number;
  capture_source_width?: number;
  capture_source_height?: number;
  capture_scale_factor?: number;
};

export type LoudnessReport = {
  ok: boolean;
  input_i: number | null;
  input_tp: number | null;
  input_lra: number | null;
  /** The gating threshold and offset loudnorm measured, which a second pass takes back. */
  input_thresh?: number | null;
  target_offset?: number | null;
  target_i: number;
  target_tp: number;
  target_lra: number;
  normalized?: unknown;
  raw_tail?: string;
  error?: string;
};

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
/** Text has to reach about this size where it is watched: a phone showing the video full
 *  screen, about this many CSS pixels across its short side (2026-11-19). At 1080 that is
 *  42 px; an absolute 18 px floor let 6 px text through on a phone. */
export const PHONE_TEXT_MIN_PX = 14;
export const PHONE_SHORT_SIDE_PX = 360;
const DEFAULT_DURATION_SEC = 5;
const MAX_RENDER_DURATION_SEC = 20 * 60;
const MAX_FPS = 60;
export const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
// Per-segment attempts inside one assembly call: the initial render plus one
// retry in a fresh renderer window (the frame timeout handlers destroy the
// shared window, so a retry always needs a new one).
export const SEGMENT_RENDER_MAX_ATTEMPTS = 2;
const AUDIO_DURATION_TOLERANCE_SEC = 0.5;
const MEDIA_DURATION_TOLERANCE_SEC = 0.5;
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
const LOW_RAM_GB = 8;
const HEAVY_RENDER_COST = 3000;
const LOUDNESS_TARGET_I = -14;
const LOUDNESS_TARGET_TP = -1;
const LOUDNESS_TARGET_LRA = 11;
const LOUDNESS_DRAFT_NORMALIZE_DELTA_LU = 4;
const REQUIRED_GSAP_TIMELINE_APIS = ['timeScale', 'totalTime', 'totalDuration', 'getChildren'];

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function htmlAttrNumber(attrs: Record<string, string>, key: string): number {
  const v = Number(attrs[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normalizeRef(ref: string): string {
  return String(ref || '').trim().replace(/&amp;/g, '&');
}

function isRemoteRef(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref);
}

function isIgnorableRef(ref: string): boolean {
  return !ref
    || ref.startsWith('#')
    || /^data:/i.test(ref)
    || /^blob:/i.test(ref)
    || /^javascript:/i.test(ref)
    || /^mailto:/i.test(ref);
}

function safeResolveLocalRef(compositionDirAbs: string, ref: string): string | null {
  return safeResolveLocalRefFromBase(compositionDirAbs, compositionDirAbs, ref);
}

function safeResolveLocalRefFromBase(compositionDirAbs: string, baseDirAbs: string, ref: string): string | null {
  const noHash = normalizeRef(ref).split('#')[0].split('?')[0];
  if (isIgnorableRef(noHash) || isRemoteRef(noHash) || path.isAbsolute(noHash)) return null;
  let decoded = noHash;
  try { decoded = decodeURIComponent(noHash); } catch { /* keep raw */ }
  const abs = path.resolve(baseDirAbs, decoded);
  const rel = path.relative(compositionDirAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function normalizedLocalRefPath(ref: string): string {
  const noHash = normalizeRef(ref).split('#')[0].split('?')[0];
  let decoded = noHash;
  try { decoded = decodeURIComponent(noHash); } catch { /* keep raw */ }
  return decoded.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Page scripts VideoStudio ships with its skill and copies into a video folder
 *  the first time a page references them. */
const BUNDLED_VENDOR_FILES = new Set(['gsap.min.js', 'screen-demo.js']);
const GSAP_VENDOR_REF = 'assets/vendor/gsap.min.js';

function bundledVendorFile(ref: string): string | null {
  const rel = normalizedLocalRefPath(ref);
  const file = rel.startsWith('assets/vendor/') ? rel.slice('assets/vendor/'.length) : '';
  return BUNDLED_VENDOR_FILES.has(file) ? file : null;
}

function isKnownBundledVendorRef(ref: string): boolean {
  return bundledVendorFile(ref) !== null;
}

function isGsapVendorRef(ref: string): boolean {
  return normalizedLocalRefPath(ref) === GSAP_VENDOR_REF;
}

function gsapVendorCompatibilityIssue(text: string): { code: string; missing: string[] } | null {
  const s = String(text || '');
  if (!s.trim()) return { code: 'VENDOR_GSAP_EMPTY', missing: REQUIRED_GSAP_TIMELINE_APIS };
  const missing = REQUIRED_GSAP_TIMELINE_APIS.filter((api) => !s.includes(api));
  return missing.length ? { code: 'VENDOR_GSAP_MISSING_TIMELINE_API', missing } : null;
}

function isFileSync(absPath: string): boolean {
  try { return fss.statSync(absPath).isFile(); } catch { return false; }
}

function builtinVendorCandidates(file: string): string[] {
  const agentRel = path.join(
    'marketplace',
    'agents',
    VIDEO_STUDIO_AGENT_ID,
    'skills',
    'video-studio',
    'assets',
    'vendor',
    file,
  );
  const sourceRel = path.join('resources', 'builtin', agentRel);
  const roots = [
    process.env.ORKAS_PC_DIR,
    process.cwd(),
    path.join(process.cwd(), 'PC'),
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..', 'PC'),
  ].filter((v): v is string => !!v);
  const resourceRoots = [
    process.env.ORKAS_BUILTIN_ROOT,
    (process as unknown as { resourcesPath?: string }).resourcesPath
      ? path.join((process as unknown as { resourcesPath: string }).resourcesPath, 'builtin')
      : undefined,
  ].filter((v): v is string => !!v);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of resourceRoots) {
    const candidate = path.resolve(root, agentRel);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  for (const root of roots) {
    const candidate = path.resolve(root, sourceRel);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

async function copyKnownBundledVendor(ref: string, targetAbsPath: string): Promise<{ ok: true } | { ok: false; code: string; missing?: string[] }> {
  const file = bundledVendorFile(ref);
  if (!file) return { ok: false, code: 'LOCAL_VENDOR_UNKNOWN' };
  const gsap = isGsapVendorRef(ref);
  const source = builtinVendorCandidates(file).find((candidate) => isFileSync(candidate));
  if (!source) return { ok: false, code: gsap ? 'VENDOR_GSAP_SOURCE_MISSING' : 'VENDOR_SOURCE_MISSING' };
  const sourceIssue = gsap ? gsapVendorCompatibilityIssue(await fs.readFile(source, 'utf8').catch(() => '')) : null;
  if (sourceIssue) return { ok: false, code: 'VENDOR_GSAP_SOURCE_INCOMPATIBLE', missing: sourceIssue.missing };
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  await fs.copyFile(source, targetAbsPath);
  return { ok: true };
}

async function validateKnownBundledVendor(ref: string, targetAbsPath: string): Promise<Issue | null> {
  if (!isGsapVendorRef(ref)) return null;
  const text = await fs.readFile(targetAbsPath, 'utf8').catch(() => '');
  const issue = gsapVendorCompatibilityIssue(text);
  if (!issue) return null;
  return {
    code: 'VENDOR_GSAP_INCOMPATIBLE',
    severity: 'error',
    selector: `[src="${ref}"]`,
    message: `Existing GSAP vendor is missing required timeline APIs: ${issue.missing.join(', ')}. Remove or replace assets/vendor/gsap.min.js; do not patch it manually inside the composition.`,
    fixHint: 'Delete the incompatible local vendor file so VideoStudio can prepare the built-in GSAP vendor, or replace it with a compatible full GSAP build.',
    source: 'orkas-native-vendor-assets',
  };
}

/** Explicit request first, then draft's deliberate speed shortcut, then what
 *  the composition declared, and only then the house default.
 *
 *  Draft keeps 15: that is the point of a draft, and it is labelled as one. */
export function qualityFps(
  quality: RenderQuality | undefined,
  fps: number | undefined,
  declared?: number,
): number {
  if (isFinitePositive(fps)) return Math.max(1, Math.min(MAX_FPS, Math.floor(fps)));
  if (quality === 'draft') return 15;
  if (isFinitePositive(declared)) return Math.max(1, Math.min(MAX_FPS, Math.floor(declared)));
  return 30;
}

function machineRamGB(): number {
  const mocked = Number(process.env.ORKAS_MOCK_RAM_GB);
  if (Number.isFinite(mocked) && mocked > 0) return Math.round(mocked * 10) / 10;
  return Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
}

/** Lets a manual check stand in for a machine whose GPU Electron cannot report. */
function mockedGpuMode(): 'hardware' | 'software' | undefined {
  const mocked = process.env.ORKAS_MOCK_OBSERVED_GPU_MODE;
  return mocked === 'hardware' || mocked === 'software' ? mocked : undefined;
}

async function observeElectronGpuMode(): Promise<'hardware' | 'software' | undefined> {
  try {
    const electron = await import('electron') as unknown as { app?: { getGPUFeatureStatus?: () => Record<string, string> } };
    const status = electron.app?.getGPUFeatureStatus?.();
    if (!status) return undefined;
    const gpuCompositing = status.gpu_compositing || '';
    const rasterization = status.rasterization || '';
    const webgl = status.webgl || '';
    const isSoftware = (value: string) => /software|disabled|unavailable/i.test(value);
    const isHardware = (value: string) => /enabled|hardware/i.test(value);
    if (isSoftware(gpuCompositing) || (isSoftware(rasterization) && isSoftware(webgl))) return 'software';
    if (isHardware(gpuCompositing) || isHardware(rasterization) || isHardware(webgl)) return 'hardware';
  } catch {
    // Runtime observation is best effort outside Electron (for example, unit tests).
  }
  return undefined;
}
export const VIDEO_TRACK_REMUX_TIMEOUT_MS = 120_000;

function isConstrainedMachine(totalRamGB: number, observedGpuMode?: 'hardware' | 'software'): boolean {
  return totalRamGB <= LOW_RAM_GB || observedGpuMode === 'software';
}

function estimateRenderCost(width: number, height: number, durationSec: number, fps: number): number {
  const frames = Math.max(1, durationSec) * Math.max(1, fps);
  const megapixels = Math.max(1, (Math.max(1, width) * Math.max(1, height)) / 1e6);
  return Math.round(frames * megapixels);
}

function renderCostDecision(opts: { constrained: boolean; costUnits: number; isFinal: boolean }): NativeRenderProfile['decision'] {
  if (!opts.constrained || opts.costUnits <= HEAVY_RENDER_COST) return 'proceed';
  return opts.isFinal ? 'fail_fast' : 'degrade';
}

function degradedFps(fps: number): number {
  return fps > 30 ? 30 : fps;
}

export function selectSafeFinalRenderFps(input: {
  width: number;
  height: number;
  durationSec: number;
  requestedFps: number;
}): number | null {
  const requestedFps = Math.max(1, Math.min(MAX_FPS, Math.floor(input.requestedFps)));
  const candidates = [...new Set([requestedFps, 30, 24, 20, 15])]
    .filter((fps) => fps <= requestedFps)
    .sort((a, b) => b - a);
  return candidates.find((fps) => estimateRenderCost(
    input.width,
    input.height,
    input.durationSec,
    fps,
  ) <= HEAVY_RENDER_COST) ?? null;
}

export async function resolveNativeRenderProfile(
  meta: CompositionMeta,
  quality: RenderQuality | undefined,
  requestedFps: number,
  allowFpsFallback: boolean,
): Promise<NativeRenderProfile> {
  const ramGB = machineRamGB();
  const observedGpuMode = await observeElectronGpuMode() || mockedGpuMode();
  const constrained = isConstrainedMachine(ramGB, observedGpuMode);
  const costUnits = estimateRenderCost(meta.width, meta.height, meta.durationSec, requestedFps);
  let decision = renderCostDecision({ constrained, costUnits, isFinal: quality === 'high' });
  let renderFps = decision === 'degrade' ? degradedFps(requestedFps) : requestedFps;
  let automaticFinalFallback = false;
  if (decision === 'fail_fast' && quality === 'high' && allowFpsFallback) {
    const safeFps = selectSafeFinalRenderFps({
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      requestedFps,
    });
    if (safeFps && safeFps < requestedFps) {
      decision = 'degrade';
      renderFps = safeFps;
      automaticFinalFallback = true;
    }
  }
  return {
    constrained,
    machine_ram_gb: ramGB,
    ...(observedGpuMode ? { observed_gpu_mode: observedGpuMode } : {}),
    cost_units: costUnits,
    decision,
    requested_fps: requestedFps,
    render_fps: renderFps,
    ...(automaticFinalFallback ? {
      fallback_reason: 'constrained_machine' as const,
      confirmation_required: false as const,
    } : {}),
    ...(renderFps !== requestedFps ? { degraded_fps: `${requestedFps}->${renderFps}` } : {}),
    ...(decision === 'degrade' && renderFps === requestedFps
      ? { degrade_ineffective: 'fps already at floor; heavy composition may render slowly on this machine' }
      : {}),
  };
}

function crfForQuality(quality: RenderQuality | undefined): number {
  if (quality === 'high') return 16;
  if (quality === 'standard') return 20;
  return 26;
}

export function mp4VideoEncoderArgs(quality: RenderQuality | undefined): string[] {
  return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', String(crfForQuality(quality)), '-movflags', '+faststart'];
}

function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nullablePositiveNumber(value: unknown): number | null {
  return positiveNumber(value) ?? null;
}

export async function probeMedia(ffprobe: string, mediaAbsPath: string, signal?: AbortSignal): Promise<MediaProbe | null> {
  const r = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration,size:format_tags=major_brand:stream=codec_type,codec_name,width,height,duration,bit_rate,avg_frame_rate,sample_aspect_ratio:stream_side_data_list',
    '-of', 'json',
    mediaAbsPath,
  ], { signal, timeoutMs: FFPROBE_TIMEOUT_MS });
  if (r.aborted || r.timedOut || r.code !== 0) return null;

  let parsed: {
    format?: { format_name?: string; duration?: string; size?: string; tags?: { major_brand?: string } };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      sample_aspect_ratio?: string;
      side_data_list?: Array<{ rotation?: number }>;
      duration?: string;
      bit_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return null;
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    container: parsed.format?.format_name,
    container_brand: parsed.format?.tags?.major_brand,
    duration_seconds: nullablePositiveNumber(parsed.format?.duration),
    size_bytes: nullablePositiveNumber(parsed.format?.size),
    ...(video ? {
      video: {
        codec: video.codec_name || '',
        width: positiveNumber(video.width),
        height: positiveNumber(video.height),
        sample_aspect_ratio: video.sample_aspect_ratio,
        rotation: video.side_data_list?.find(side => typeof side.rotation === 'number')?.rotation,
        duration_seconds: positiveNumber(video.duration),
        avg_frame_rate: video.avg_frame_rate,
      },
    } : {}),
    ...(audio ? {
      audio: {
        codec: audio.codec_name || '',
        duration_seconds: positiveNumber(audio.duration),
        bit_rate: positiveNumber(audio.bit_rate),
      },
    } : {}),
  };
}

export async function loadCompositionMeta(compositionDirAbs: string): Promise<{ meta: CompositionMeta | null; issues: Issue[] }> {
  const issues: Issue[] = [];
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  // Composition HTML is a render source, never a presentation layer for the
  // derived video. Repair files finalized by older app versions before any
  // lint/inspect/snapshot/render path reads and captures them.
  await prepareProducedFileForInput(htmlPath, { source: 'video_studio.composition_input' });
  const st = await fs.stat(htmlPath).catch(() => null);
  if (!st || !st.isFile()) {
    return {
      meta: null,
      issues: [{
        code: 'NO_COMPOSITION',
        severity: 'error',
        selector: 'index.html',
        message: `No index.html found in composition dir: ${compositionDirAbs}`,
      }],
    };
  }

  const html = await fs.readFile(htmlPath, 'utf8');
  const structure = parseHtmlStructure(html);
  const rootTag = structure.tags.find((tag) => tag.attrs['data-composition-id']);
  const rootAttrs = rootTag?.attrs || {};
  const width = htmlAttrNumber(rootAttrs, 'data-width') || DEFAULT_WIDTH;
  const height = htmlAttrNumber(rootAttrs, 'data-height') || DEFAULT_HEIGHT;
  const durationSec = htmlAttrNumber(rootAttrs, 'data-duration') || DEFAULT_DURATION_SEC;
  const id = rootAttrs['data-composition-id'] || 'main';

  if (!rootTag) {
    issues.push({
      code: 'ROOT_COMPOSITION_MISSING',
      severity: 'error',
      selector: '[data-composition-id]',
      message: 'index.html must declare a root element with data-composition-id, data-width, data-height, and data-duration.',
    });
  }
  for (const diagnostic of structure.diagnostics.slice(0, 4)) {
    issues.push({
      code: 'HTML_STRUCTURE_MALFORMED',
      severity: 'warning',
      selector: 'index.html',
      message: `HTML structure warning: ${diagnostic}.`,
    });
  }
  for (const key of ['data-width', 'data-height', 'data-duration']) {
    if (!htmlAttrNumber(rootAttrs, key)) {
      issues.push({
        code: 'ROOT_TIMING_ATTR_MISSING',
        severity: 'error',
        selector: '[data-composition-id]',
        message: `root composition is missing a positive numeric ${key}.`,
      });
    }
  }
  if (durationSec > MAX_RENDER_DURATION_SEC) {
    issues.push({
      code: 'DURATION_TOO_LONG',
      severity: 'error',
      selector: '[data-composition-id]',
      message: `composition duration ${durationSec}s exceeds the ${MAX_RENDER_DURATION_SEC}s render limit.`,
    });
  }

  const refs: Array<HtmlResourceRef & { baseDirAbs: string }> = extractHtmlResourceRefs(structure)
    .map((item) => ({ ...item, baseDirAbs: compositionDirAbs }));
  const cssQueue = refs.filter((item) => item.attr === 'href' && /\.css(?:[?#]|$)/i.test(item.ref));
  const visitedCss = new Set<string>();
  for (let index = 0; index < cssQueue.length; index += 1) {
    const item = cssQueue[index];
    const cssAbs = safeResolveLocalRefFromBase(compositionDirAbs, item.baseDirAbs, item.ref);
    if (!cssAbs || visitedCss.has(cssAbs)) continue;
    visitedCss.add(cssAbs);
    const css = await fs.readFile(cssAbs, 'utf8').catch(() => '');
    const imports = extractCssImports(css);
    const importedRefs = new Set(imports);
    for (const ref of extractCssUrls(css)) {
      if (!importedRefs.has(ref)) refs.push({ attr: 'style-url', ref, baseDirAbs: path.dirname(cssAbs) });
    }
    for (const ref of imports) {
      const imported = { attr: 'css-import' as const, ref, baseDirAbs: path.dirname(cssAbs) };
      refs.push(imported);
      cssQueue.push(imported);
    }
  }
  const audioTracks: AudioTrack[] = [];
  for (const item of refs) {
    if (isIgnorableRef(item.ref)) continue;
    if (isRemoteRef(item.ref)) {
      issues.push({
        code: 'REMOTE_RESOURCE_BLOCKED',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Remote runtime resource is not allowed during video render: ${item.ref}`,
        fixHint: 'Copy runtime assets into the composition directory and reference them relatively.',
      });
      continue;
    }
    if (path.isAbsolute(item.ref)) {
      issues.push({
        code: 'ABSOLUTE_RESOURCE_BLOCKED',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Absolute runtime resource is not allowed during video render: ${item.ref}`,
      });
      continue;
    }
    const abs = safeResolveLocalRefFromBase(compositionDirAbs, item.baseDirAbs, item.ref);
    if (!abs) {
      issues.push({
        code: 'RESOURCE_OUT_OF_SCOPE',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Resource reference escapes the composition directory: ${item.ref}`,
      });
      continue;
    }
    let exists = await fs.stat(abs).catch(() => null);
    if ((!exists || !exists.isFile()) && isKnownBundledVendorRef(item.ref)) {
      const prepared = await copyKnownBundledVendor(item.ref, abs);
      if (prepared.ok === false) {
        issues.push({
          code: prepared.code,
          severity: 'error',
          selector: `[${item.attr}="${item.ref}"]`,
          message: `Built-in vendor resource could not be prepared: ${item.ref}`,
          fixHint: prepared.missing
            ? `Built-in GSAP vendor is missing required APIs: ${prepared.missing.join(', ')}.`
            : `Use the provided path assets/vendor/${bundledVendorFile(item.ref)} or remove the runtime dependency.`,
        });
        continue;
      }
      exists = await fs.stat(abs).catch(() => null);
    }
    if (exists && exists.isFile() && isKnownBundledVendorRef(item.ref)) {
      const vendorIssue = await validateKnownBundledVendor(item.ref, abs);
      if (vendorIssue) {
        issues.push(vendorIssue);
        continue;
      }
    }
    if (!exists || !exists.isFile()) {
      issues.push({
        code: 'LOCAL_RESOURCE_MISSING',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Local resource does not exist: ${item.ref}`,
      });
    }
  }

  for (const audioTag of structure.tags.filter((tag) => tag.tagName === 'audio')) {
    const attrs = audioTag.attrs;
    const src = attrs.src;
    if (!src || isIgnorableRef(src) || isRemoteRef(src) || path.isAbsolute(src)) continue;
    const abs = safeResolveLocalRef(compositionDirAbs, src);
    if (abs) {
      audioTracks.push({
        absPath: abs,
        startSec: Number(attrs['data-start']) || 0,
        declaredDurationSec: htmlAttrNumber(attrs, 'data-duration') || undefined,
        volume: Number.isFinite(Number(attrs['data-volume'])) && Number(attrs['data-volume']) >= 0
          ? Number(attrs['data-volume'])
          : 1,
      });
    }
  }

  return {
    meta: { htmlPath, html, rootAttrs, id, width, height, durationSec, audioTracks },
    issues,
  };
}

function fileUrl(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).toString();
}

function realPathOrResolved(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    return fss.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathInsideOrEqual(candidateAbs: string, rootAbs: string): boolean {
  const candidate = realPathOrResolved(candidateAbs);
  const root = realPathOrResolved(rootAbs);
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isCompositionRequestUrlAllowed(
  requestUrl: string,
  compositionDirAbs: string,
  extraAllowedDirsAbs: readonly string[] = [],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'about:') return parsed.href === 'about:blank';
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
  if (parsed.protocol !== 'file:') return false;
  try {
    const requested = fileURLToPath(parsed);
    return [compositionDirAbs, ...extraAllowedDirsAbs].some((dir) => pathInsideOrEqual(requested, dir));
  } catch {
    return false;
  }
}

class VideoStudioTimeoutError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoStudioTimeoutError';
  }
}

class VideoStudioRuntimeError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoStudioRuntimeError';
  }
}

export function videoStudioErrorCode(err: unknown, fallback: string): string {
  return err instanceof VideoStudioTimeoutError || err instanceof VideoStudioRuntimeError
    ? err.errorCode
    : fallback;
}

/** Electron capturePage returns physical pixels on high-DPI displays while
 * composition dimensions are CSS pixels. Equal-axis scaling is expected and
 * safe to normalize automatically; only distorted geometry is exceptional. */
export function normalizeCapturedFrame(
  image: ElectronNativeImage,
  targetWidth: number,
  targetHeight: number,
): {
  image: ElectronNativeImage;
  sourceWidth: number;
  sourceHeight: number;
  scaleFactor: number;
  normalized: boolean;
} {
  const source = image.getSize();
  if (source.width === targetWidth && source.height === targetHeight) {
    return {
      image,
      sourceWidth: source.width,
      sourceHeight: source.height,
      scaleFactor: 1,
      normalized: false,
    };
  }
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;
  const tolerance = Math.max(0.01, Math.max(Math.abs(scaleX), Math.abs(scaleY)) * 0.005);
  if (source.width <= 0 || source.height <= 0 || targetWidth <= 0 || targetHeight <= 0
    || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)
    || Math.abs(scaleX - scaleY) > tolerance) {
    throw new VideoStudioRuntimeError(
      'E_CAPTURE_GEOMETRY_INVALID',
      `Captured frame geometry cannot be normalized: expected ${targetWidth}x${targetHeight}, got ${source.width}x${source.height}.`,
    );
  }
  const normalized = image.resize({ width: targetWidth, height: targetHeight, quality: 'best' });
  const normalizedSize = normalized.getSize();
  if (normalizedSize.width !== targetWidth || normalizedSize.height !== targetHeight) {
    throw new VideoStudioRuntimeError(
      'E_CAPTURE_GEOMETRY_INVALID',
      `Captured frame normalization failed: expected ${targetWidth}x${targetHeight}, got ${normalizedSize.width}x${normalizedSize.height}.`,
    );
  }
  return {
    image: normalized,
    sourceWidth: source.width,
    sourceHeight: source.height,
    scaleFactor: round2((scaleX + scaleY) / 2),
    normalized: true,
  };
}

export async function withVideoStudioTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode: string,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new VideoStudioTimeoutError(errorCode, message));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Machine-level render gate. Frame-capture rendering saturates the CPU/GPU:
 * two concurrent renders (observed 2026-08-22 — two videos in one
 * conversation) roughly halve each other's throughput while pushing both
 * toward the idle watchdogs, so one render at a time finishes strictly sooner
 * in aggregate. Process-local FIFO; waiters emit progress so the queue wait
 * is user-visible and keeps the watchdogs fed. Light work (status, checks,
 * frame sheets, audio-only track reuse) is deliberately not gated. */
let compositionRenderSlotTail: Promise<void> = Promise.resolve();
const RENDER_SLOT_WAIT_PROGRESS_INTERVAL_MS = 30_000;
const softwarePresentation = new WeakMap<ElectronBrowserWindow, 'onscreen' | 'offscreen'>();

export async function acquireCompositionRenderSlot(input: {
  signal?: AbortSignal;
  onWait?: (waitedMs: number) => void;
  waitProgressIntervalMs?: number;
} = {}): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const prior = compositionRenderSlotTail;
  compositionRenderSlotTail = prior.then(() => mine);
  let acquired = false;
  const waitStartedAt = Date.now();
  const ticker = setInterval(() => {
    if (!acquired) input.onWait?.(Date.now() - waitStartedAt);
  }, Math.max(1, input.waitProgressIntervalMs ?? RENDER_SLOT_WAIT_PROGRESS_INTERVAL_MS));
  if (typeof ticker.unref === 'function') ticker.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('render aborted'));
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });
      void prior.then(() => {
        input.signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    acquired = true;
    return release;
  } catch (err) {
    // Abandon the queue position without blocking later waiters: this slot
    // auto-releases the moment the prior holder finishes.
    void prior.then(() => release());
    throw err;
  } finally {
    clearInterval(ticker);
  }
}

export type CompositionWindowOptions = {
  /** Directories the page may load from besides the composition itself. */
  extraAllowedDirsAbs?: readonly string[];
  /** Installed after load: it drives the page's time for each captured frame. */
  adapterScript: string;
  /** Called with each console error the page raises, from before it loads. */
  onConsoleError?: (message: string) => void;
  /** Paint rate of an offscreen window. Each settled frame waits on paint ticks,
   *  so at the default 60 this wait is most of the cost of a captured frame. */
  offscreenFrameRate?: number;
};

export async function withCompositionWindow<T>(
  meta: CompositionMeta,
  p: CompositionOptions,
  fn: (win: ElectronBrowserWindow) => Promise<T>,
  windowOpts: CompositionWindowOptions,
): Promise<T> {
  const electron = await import('electron');
  const { BrowserWindow, session, app } = electron;
  if (!BrowserWindow) throw new Error('Electron BrowserWindow unavailable');
  const observedGpuMode = await observeElectronGpuMode();
  const softwareRendering = observedGpuMode === 'software'
    || app.commandLine.hasSwitch('disable-gpu')
    || process.argv.includes('--disable-gpu');
  const useOffscreenPainting = !(process.platform === 'win32' && softwareRendering);
  const partition = `video-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    if (!isCompositionRequestUrlAllowed(url, p.compositionDirAbs, windowOpts.extraAllowedDirsAbs)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    width: meta.width,
    height: meta.height,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences: hardenedWebPreferences({
      session: ses,
      // Windows software retains the prior scene on an offscreen surface.
      // Use its hidden on-screen surface for presentation acknowledgements.
      offscreen: useOffscreenPainting,
    }),
  });
  if (!useOffscreenPainting) softwarePresentation.set(win, 'onscreen');
  if (process.platform === 'darwin' && softwareRendering) softwarePresentation.set(win, 'offscreen');
  try {
    // Electron centers new Windows/Linux windows within the display work
    // area, which can shrink even a useContentSize window (1920x1080 became
    // 1904x993 in production). Restore the approved viewport after constructor
    // centering, before loading or measuring the composition. Resizing a
    // cropped bitmap later would lose content and change the aspect ratio.
    win.setContentSize(meta.width, meta.height);
    if (windowOpts.offscreenFrameRate && useOffscreenPainting) win.webContents.setFrameRate(windowOpts.offscreenFrameRate);
    if (windowOpts.onConsoleError) {
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error') windowOpts.onConsoleError?.(String(event.message || ''));
      });
    }
    const destroyOnTimeout = () => {
      try { win.destroy(); } catch { /* best effort */ }
    };
    const loaded = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, _code, desc) => reject(new Error(`did-fail-load: ${desc}`)));
    });
    await withVideoStudioTimeout(
      win.loadURL(fileUrl(meta.htmlPath)),
      COMPOSITION_LOAD_TIMEOUT_MS,
      'E_COMPOSITION_LOAD_TIMEOUT',
      'composition window timed out while loading index.html.',
      destroyOnTimeout,
    );
    await withVideoStudioTimeout(
      loaded,
      COMPOSITION_LOAD_TIMEOUT_MS,
      'E_COMPOSITION_LOAD_TIMEOUT',
      'composition window timed out before load completion.',
      destroyOnTimeout,
    );
    await withVideoStudioTimeout(
      win.webContents.executeJavaScript(windowOpts.adapterScript, true),
      COMPOSITION_SCRIPT_TIMEOUT_MS,
      'E_COMPOSITION_SCRIPT_TIMEOUT',
      'composition window timed out while installing the timeline adapter.',
      destroyOnTimeout,
    );
    await withVideoStudioTimeout(
      waitForReady(win),
      COMPOSITION_READY_TIMEOUT_MS,
      'E_COMPOSITION_READY_TIMEOUT',
      'composition window timed out while waiting for fonts, images, and media metadata.',
      destroyOnTimeout,
    );
    return await fn(win);
  } finally {
    try { win.destroy(); } catch { /* best effort */ }
  }
}

async function waitForReady(win: ElectronBrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
(async () => {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const imgs = Array.from(document.images || []);
  await Promise.all(imgs.map((img) => {
    if (img.complete) return Promise.resolve();
    if (typeof img.decode === 'function') return img.decode().catch(() => {});
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }));
  const media = Array.from(document.querySelectorAll('audio,video'));
  await Promise.all(media.map((m) => {
    if (m.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      m.addEventListener('loadedmetadata', resolve, { once: true });
      m.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 2000);
    });
  }));
})()
`, true);
}

export async function settleCompositionPaint(win: ElectronBrowserWindow): Promise<void> {
  win.webContents.invalidate();
  await withVideoStudioTimeout(win.webContents.executeJavaScript(`
new Promise((resolve) => requestAnimationFrame(() => {
  setTimeout(() => requestAnimationFrame(resolve), 0);
}))
`, true), COMPOSITION_SCRIPT_TIMEOUT_MS, 'E_COMPOSITION_PAINT_TIMEOUT', 'composition paint did not settle before capture.', () => {
    try { win.destroy(); } catch { /* best effort */ }
  });
}

export function usesSoftwareCompositionPresentation(win: ElectronBrowserWindow): boolean {
  return softwarePresentation.has(win);
}

/** Read only the tiny marker patch. Subscription images use physical pixels. */
function compositionMarkerVisible(image: ElectronNativeImage, width: number, height: number,
  colors: readonly boolean[], cellWidth: number, markerHeight: number): boolean | null {
  if (image.isEmpty()) return null;
  const { width: imageWidth, height: imageHeight } = image.getSize();
  if (imageWidth < colors.length || imageHeight < 1) return null;
  const xScale = imageWidth / width;
  const yScale = imageHeight / height;
  const patchWidth = Math.min(imageWidth, Math.ceil(colors.length * cellWidth * xScale));
  const patchHeight = Math.min(imageHeight, Math.ceil(markerHeight * yScale));
  const pixels = image.crop({ x: 0, y: 0, width: patchWidth, height: patchHeight }).toBitmap();
  if (pixels.length !== patchWidth * patchHeight * 4) return null;
  return colors.every((magenta, index) => {
    const x = Math.floor((index + 0.5) * cellWidth * xScale);
    const y = Math.floor(markerHeight * yScale / 2);
    const offset = (y * patchWidth + x) * 4;
    const [blue, green, red] = pixels.subarray(offset, offset + 3);
    return magenta ? red > 150 && blue > 150 && green < 90 : green > 150 && red < 90 && blue < 90;
  });
}

/** Software compositors can present after the page's RAF callbacks. Wait for
 * a paint of the target marker, then for the paint that removes it. */
export async function capturePresentedCompositionFrame(input: {
  win: ElectronBrowserWindow;
  width: number;
  height: number;
  render: () => Promise<void>;
  timeoutMessage: string;
  signal?: AbortSignal;
}): Promise<ElectronNativeImage> {
  const { win, width, height, signal } = input;
  signal?.throwIfAborted();
  const contents = win.webContents;
  const markerId = `orkas-frame-${crypto.randomUUID()}`;
  const cellWidth = Math.min(width, 4);
  const markerHeight = Math.min(height, 4);
  const colorCount = Math.min(16, Math.floor(width / cellWidth));
  const markerBits = Number.parseInt(markerId.slice(12, 20), 16);
  const colors = Array.from({ length: colorCount }, (_, i) => (markerBits & (1 << i)) !== 0);
  const stops = colors.map((magenta, i) => `${magenta ? 'magenta' : 'lime'} ${i * cellWidth}px ${(i + 1) * cellWidth}px`);
  const background = colorCount > 1 ? `linear-gradient(to right, ${stops.join(', ')})` : (colors[0] ? 'magenta' : 'lime');
  const offscreen = softwarePresentation.get(win) === 'offscreen';
  let receive: ((image: ElectronNativeImage) => void) | undefined;
  const onPaint = (_event: unknown, dirty: Rectangle, image: ElectronNativeImage) => {
    if (!receive || image.isEmpty()) return;
    const size = image.getSize();
    // A paint of an unrelated patch cannot acknowledge removal. Offscreen
    // software sends a full backing bitmap together with its damage rectangle.
    if (size.width < width || size.height < height || dirty.x !== 0 || dirty.y !== 0
      || dirty.width < Math.ceil(colorCount * cellWidth * size.width / width)
      || dirty.height < Math.ceil(markerHeight * size.height / height)) return;
    receive(image);
  };
  let abort: (() => void) | undefined;
  const dispose = () => { try { win.destroy(); } catch { /* best effort */ } };
  const cancelled = signal ? new Promise<never>((_, reject) => {
    abort = () => { dispose(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  }) : null;
  let subscribed = false;
  try {
    if (offscreen) contents.on('paint', onPaint);
    else contents.beginFrameSubscription(false, (image) => receive?.(image));
    subscribed = true;
    const waitForFrame = async (visible: boolean, source: string) => {
      const presented = new Promise<ElectronNativeImage>((resolve, reject) => {
        receive = (image) => {
          try {
            if (compositionMarkerVisible(image, width, height, colors, cellWidth, markerHeight) === visible) {
              receive = undefined;
              resolve(image);
            }
          } catch (error) { reject(error); }
        };
      });
      const updated = contents.executeJavaScript(source, true).then(async () => {
        if (offscreen) return;
        // A hidden static surface can miss a presentation callback. Request
        // another paint and inspect its snapshot until the event or snapshot
        // confirms the marker state. The capture watchdog bounds this loop.
        while (receive) {
          await settleCompositionPaint(win);
          if (receive) receive(await contents.capturePage(undefined, { stayHidden: true }));
        }
      });
      const [image] = await Promise.all([presented, updated]);
      return image;
    };
    const capture = (async () => {
      await input.render();
      await waitForFrame(true, `(() => {
        const marker = document.createElement('orkas-frame-marker');
        marker.id = ${JSON.stringify(markerId)};
        marker.setAttribute('popover', 'manual');
        marker.inert = true;
        marker.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;'
          + 'margin:0!important;display:block!important;pointer-events:none!important;'
          + ${JSON.stringify(`width:${colorCount * cellWidth}px!important;height:${markerHeight}px!important;background:${background}!important`)};
        document.documentElement.append(marker);
        marker.showPopover();
      })()`);
      return waitForFrame(false, `document.getElementById(${JSON.stringify(markerId)}).remove()`);
    })();
    return await withVideoStudioTimeout(cancelled ? Promise.race([capture, cancelled]) : capture,
      COMPOSITION_RENDER_FRAME_TIMEOUT_MS, 'E_RENDER_CAPTURE_TIMEOUT', input.timeoutMessage, dispose);
  } finally {
    receive = undefined;
    if (abort) signal?.removeEventListener('abort', abort);
    if (subscribed && !win.isDestroyed()) {
      if (offscreen) contents.off('paint', onPaint);
      else contents.endFrameSubscription();
    }
  }
}

export function buildInspectScript(meta: CompositionMeta, tSec: number, expectedSceneId?: string): string {
  return `
(() => {
  const issues = [];
  const width = ${meta.width};
  const height = ${meta.height};
  const tSec = ${tSec};
  const expectedSceneId = ${JSON.stringify(expectedSceneId || '')};
  const safeX = Math.max(48, Math.min(96, width * 0.05));
  const safeY = Math.max(48, Math.min(96, height * 0.06));
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const minTextPx = Math.round(${PHONE_TEXT_MIN_PX} * Math.min(width, height) / ${PHONE_SHORT_SIDE_PX});
  const selectorFor = (el) => {
    if (!el || !el.tagName) return 'document';
    if (el.id) return '#' + el.id;
    const scene = el.closest && el.closest('[data-scene-id]');
    const scenePart = scene ? '[data-scene-id="' + String(scene.getAttribute('data-scene-id') || '') + '"]' : '';
    if (scene === el) return scenePart;
    const parts = [];
    let cur = el;
    while (cur && cur !== scene && cur.tagName && parts.length < 4) {
      if (cur.id) {
        parts.unshift('#' + cur.id);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const roleValue = String(cur.getAttribute && cur.getAttribute('data-role') || '').trim();
      if (roleValue) part += '[data-role="' + roleValue + '"]';
      else if (typeof cur.className === 'string' && cur.className.trim()) {
        part += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children || []).filter((candidate) => candidate.tagName === cur.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return [scenePart, parts.join(' > ')].filter(Boolean).join(' > ') || el.tagName.toLowerCase();
  };
  const add = (code, severity, confidence, el, message, evidence) => {
    const scene = el && el.closest ? el.closest('[data-scene-id]') : null;
    const role = el && el.closest ? el.closest('[data-role]') : null;
    issues.push({
      code,
      severity,
      confidence,
      selector: selectorFor(el),
      message: '[' + tSec.toFixed(2) + 's] ' + message,
      source: 'orkas-native-inspect',
      sampleTimeSec: tSec,
      activeScene: !expectedSceneId || !scene || String(scene.getAttribute('data-scene-id') || '') === expectedSceneId,
      evidence: evidence || {},
      ...(scene ? { sceneId: scene.getAttribute('data-scene-id') || '' } : {}),
      ...(role ? { role: role.getAttribute('data-role') || '' } : {}),
    });
  };
  const visible = (el) => {
    let cur = el;
    let opacity = 1;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(cur);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      opacity *= Number(style.opacity || 1);
      if (opacity <= 0.01) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  const directText = (el) => Array.from(el.childNodes || [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || '')
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
  const parseColor = (value) => {
    const m = /^rgba?\\(([^)]+)\\)$/i.exec(String(value || '').trim());
    if (!m) return null;
    const parts = m[1].split(/[\\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const channels = parts.slice(0, 3).map((part) => Number(part.replace('%', '')) * (part.endsWith('%') ? 2.55 : 1));
    const alpha = parts.length === 4 ? Number(parts[3].replace('%', '')) / (parts[3].endsWith('%') ? 100 : 1) : 1;
    if (channels.some((n) => !Number.isFinite(n) || n < 0 || n > 255) || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
  };
  // Source-over is applied to ink and paper separately. Element opacity then
  // flattens the whole group, not just its foreground colour (W3C compositing-1).
  const over = (front, back) => {
    const a = front.a + back.a * (1 - front.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (key) => (front[key] * front.a + back[key] * back.a * (1 - front.a)) / a;
    return { r: channel('r'), g: channel('g'), b: channel('b'), a };
  };
  const contrastStyles = new WeakMap();
  const contrastStyle = (el) => {
    if (!contrastStyles.has(el)) contrastStyles.set(el, getComputedStyle(el));
    return contrastStyles.get(el);
  };
  const canvasRoot = document.documentElement;
  const rootStyle = canvasRoot ? contrastStyle(canvasRoot) : null;
  const rootBg = rootStyle ? parseColor(rootStyle.backgroundColor) : null;
  const bodyStyle = contrastStyle(document.body);
  // CSS Backgrounds propagates an HTML body's background to an otherwise
  // transparent root canvas, outside the body's box and opacity group.
  const bodyPaintsCanvas = canvasRoot && canvasRoot.tagName === 'HTML'
    && document.body.parentElement === canvasRoot && rootBg && rootBg.a === 0
    && rootStyle.backgroundImage === 'none'
    && (!rootStyle.contain || rootStyle.contain === 'none') && (!bodyStyle.contain || bodyStyle.contain === 'none');
  const contrastColorsFor = (el, fg, rect) => {
    let ink = fg;
    let paper = { r: 0, g: 0, b: 0, a: 0 };
    let backing = null;
    let cur = el;
    let depth = 0;
    while (cur && depth++ < 64) {
      const style = contrastStyle(cur);
      // Images, gradients and non-source-over effects need frame review. A
      // guessed solid colour must not become a repair finding.
      if (['filter', 'backdropFilter', 'mixBlendMode', 'maskImage', 'webkitMaskImage'].some((key) =>
        style[key] && style[key] !== 'none' && style[key] !== 'normal')) return null;
      const paint = bodyPaintsCanvas && cur === document.body ? null : bodyPaintsCanvas && cur === canvasRoot ? bodyStyle : style;
      if (paint && (ink.a < 1 || paper.a < 1)) {
        if (paint.backgroundImage && paint.backgroundImage !== 'none') return null;
        const bg = parseColor(paint.backgroundColor);
        if (!bg) return null;
        if (bg.a > 0) {
          if (cur !== canvasRoot && paint.backgroundClip && paint.backgroundClip !== 'border-box') return null;
          const box = cur === canvasRoot ? { left: 0, top: 0, right: width, bottom: height } : cur === el ? rect : cur.getBoundingClientRect();
          const covers = box.left <= rect.left && box.top <= rect.top && box.right >= rect.right && box.bottom >= rect.bottom;
          const overlaps = box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
          if (!covers && overlaps) return null;
          if (covers) {
            ink = over(ink, bg);
            paper = over(paper, bg);
            if (paper.a === 1) backing = cur;
          }
        }
      }
      const opacity = Number(style.opacity || 1);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return null;
      ink = { ...ink, a: ink.a * opacity };
      paper = { ...paper, a: paper.a * opacity };
      if (paper.a < 1) backing = null;
      cur = cur.parentElement;
    }
    // An unobserved/transparent canvas or an over-deep tree is unknown, not
    // a black background. Opaque child plates still work over unknown images.
    return !cur && ink.a === 1 && paper.a === 1 ? { ink, paper, backing } : null;
  };
  const knownContrastBackdrop = (el, colours, rect) => {
    if (colours.backing === el) return true;
    if (typeof document.elementsFromPoint !== 'function') return false;
    // A sibling image/plate can sit between transparent text and its ancestor
    // background. Hit-test only candidate findings, with a bounded paint stack.
    const stack = document.elementsFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2).slice(0, 32);
    if (stack[0] !== el) return false;
    for (const node of stack.slice(1)) {
      if (node === colours.backing) return true;
      if (node.contains && node.contains(el)) continue;
      const style = contrastStyle(node);
      const bg = parseColor(style.backgroundColor);
      if (!bg || bg.a > 0 || (style.backgroundImage && style.backgroundImage !== 'none')
        || ['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(node.tagName)) return false;
    }
    return false;
  };
  const luminance = (c) => {
    const channel = (v) => {
      const x = Math.max(0, Math.min(255, v)) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const contrastRatio = (fg, bg) => {
    const a = luminance(fg);
    const b = luminance(bg);
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const area = (rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
  const intersectionArea = (a, b) => {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return w * h;
  };
  const textBoxes = [];
  let visibleCount = 0;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (!visible(el)) continue;
    const scene = el.closest && el.closest('[data-scene-id]');
    const sceneId = scene ? String(scene.getAttribute('data-scene-id') || '') : '';
    if (expectedSceneId && sceneId && sceneId !== expectedSceneId) continue;
    visibleCount += 1;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) continue;
    // What screen-demo.js draws inside a screenshot (typed text, a zoomed screen it
    // clips) is part of that screen, like the screenshot's own words.
    const screen = el.closest && el.closest('[data-orkas-screen]');
    if (screen && screen !== el) continue;
    const text = directText(el);
    const rectEvidence = {
      rect: { left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) },
      canvas: { width, height },
      expected_scene_id: expectedSceneId || null,
    };
    if (rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1) {
      const overflow = {
        left: round(Math.max(0, -rect.left)),
        top: round(Math.max(0, -rect.top)),
        right: round(Math.max(0, rect.right - width)),
        bottom: round(Math.max(0, rect.bottom - height)),
      };
      const overflowTotal = overflow.left + overflow.top + overflow.right + overflow.bottom;
      const role = el.closest && el.closest('[data-role]');
      const roleName = role ? String(role.getAttribute('data-role') || '').toLowerCase() : '';
      const semantic = !!text || (!!roleName && !/(?:background|decor|texture|glow|particle|ornament)/.test(roleName));
      const confidence = semantic && overflowTotal >= 8 ? 'high' : semantic ? 'medium' : 'low';
      add('ELEMENT_OUT_OF_CANVAS', 'warning', confidence, el, 'element extends outside the declared video canvas.', {
        ...rectEvidence,
        overflow_pixels: overflow,
        intersection_ratio: round(intersectionArea(rect, { left: 0, top: 0, right: width, bottom: height }) / Math.max(1, area(rect))),
      });
    }
    if (text) {
      textBoxes.push({ el, rect, text, area: area(rect) });
      const overflowX = Math.max(0, el.scrollWidth - el.clientWidth);
      const overflowY = Math.max(0, el.scrollHeight - el.clientHeight);
      if (overflowX > 2 || overflowY > 2) {
        const clipsOverflow = /(?:hidden|clip|auto|scroll)/.test(String(style.overflowX || style.overflow || ''))
          || /(?:hidden|clip|auto|scroll)/.test(String(style.overflowY || style.overflow || ''));
        add('TEXT_OVERFLOW', 'warning', clipsOverflow && Math.max(overflowX, overflowY) > 4 ? 'high' : 'medium', el, 'text content overflows its box.', {
          ...rectEvidence,
          overflow_pixels: { x: round(overflowX), y: round(overflowY) },
          css_overflow: { x: style.overflowX, y: style.overflowY },
        });
      }
      const fs = parseFloat(style.fontSize || '0');
      if (Number.isFinite(fs) && fs > 0 && fs < minTextPx) {
        add('FONT_TOO_SMALL', 'warning', 'high', el, 'text is ' + round(fs) + 'px, under the ' + minTextPx + 'px it needs to be read when this video fills a phone screen.', { ...rectEvidence, font_size_px: round(fs), minimum_px: minTextPx });
      }
      if (rect.left < safeX || rect.top < safeY || rect.right > width - safeX || rect.bottom > height - safeY) {
        add('SAFE_AREA_VIOLATION', 'warning', 'medium', el, 'readable text sits near the video edge or platform-safe area.', { ...rectEvidence, safe_area: { x: round(safeX), y: round(safeY) } });
      }
      if (text.length > 180 || (text.length > 110 && rect.height > height * 0.32)) {
        add('TEXT_DENSITY_HIGH', 'warning', 'low', el, 'text block is dense for phone-size video review.', { ...rectEvidence, character_count: text.length });
      }
      const fg = parseColor(style.webkitTextFillColor || style.color);
      const colours = fg ? contrastColorsFor(el, fg, rect) : null;
      if (colours) {
        const ratio = contrastRatio(colours.ink, colours.paper);
        const minRatio = fs >= 32 ? 3 : 4.5;
        if (ratio < minRatio && knownContrastBackdrop(el, colours, rect)) {
          add('LOW_CONTRAST', 'warning', 'medium', el, 'text contrast is low against its nearest solid background.', { ...rectEvidence, contrast_ratio: round(ratio), minimum_ratio: minRatio });
        }
      }
    }
  }
  for (let i = 0; i < Math.min(textBoxes.length, 80); i += 1) {
    for (let j = i + 1; j < Math.min(textBoxes.length, 80); j += 1) {
      const a = textBoxes[i];
      const b = textBoxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const overlap = intersectionArea(a.rect, b.rect);
      if (overlap > Math.min(a.area, b.area) * 0.18) {
        add('TEXT_OCCLUDED', 'warning', 'medium', a.el, 'visible text overlaps another text element.', { overlap_area: round(overlap), overlap_ratio: round(overlap / Math.max(1, Math.min(a.area, b.area))), other_selector: selectorFor(b.el) });
        j = textBoxes.length;
      }
    }
  }
  if (visibleCount > 240) {
    add('VISUAL_COMPLEXITY_HIGH', 'warning', 'low', document.body, 'scene has a very high visible element count; simplify the visual grammar if it reads like UI clutter.', { visible_element_count: visibleCount, threshold: 240, expected_scene_id: expectedSceneId || null });
  }
  return issues;
})()
`;
}

/** P3c R2: per-scene segment assembly. The global frame sequence is
 * partitioned at scene-start boundaries; each partition renders (or reuses)
 * an independently encoded video-only segment, and the final output is a
 * lossless concat plus one audio remux. Correctness rests on verified scene
 * attribution: segments are keyed by scene subtree + motion region + shared
 * surface + absolute window + frame range + encode params, and the whole
 * path is eligible only while qa/scene-isolation.json proves isolation for
 * the exact current HTML bytes. */
const SEGMENT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// Segments render inside the cache they publish into, because rename cannot
// cross volumes and a project can sit on any of them (2026-11-03: project on C:,
// data root on D:, every segment failed with EXDEV). Only the render-slot holder
// writes here, and it is neither a cache entry nor subject to eviction.
export const SEGMENT_CACHE_STAGING_DIR_NAME = '.staging';

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const SEGMENT_VISUAL_SIGNATURE_EXCLUDED_AUDIO_RE = /\.(?:mp3|wav|m4a|ogg|aac|flac|opus)$/i;

/** Content identity of the local visual resources referenced by one
 * attributable HTML surface. The fragment bytes themselves are already part
 * of the segment key; this projection closes the separate same-path/content-
 * changed hole without making an unrelated scene inherit the whole
 * composition signature. */
export async function videoStudioReferencedVisualAssetSignature(
  compositionDirAbs: string,
  htmlFragment: string,
  allowedRootsAbs?: readonly string[],
): Promise<string> {
  const queue: Array<{ ref: string; baseDirAbs: string }> = extractHtmlResourceRefs(parseHtmlStructure(htmlFragment))
    .map((item) => ({ ref: item.ref, baseDirAbs: compositionDirAbs }));
  const visited = new Set<string>();
  const assets: Array<[string, string]> = [];

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const abs = safeResolveLocalRefFromBase(compositionDirAbs, item.baseDirAbs, item.ref);
    if (!abs || visited.has(abs) || SEGMENT_VISUAL_SIGNATURE_EXCLUDED_AUDIO_RE.test(abs)) continue;
    if (allowedRootsAbs && !isPathAllowed(abs, allowedRootsAbs)) throw new Error('Visual resource is outside the readable scope.');
    visited.add(abs);
    const bytes = await fs.readFile(abs);
    const rel = path.relative(compositionDirAbs, abs).replace(/\\/g, '/');
    assets.push([rel, crypto.createHash('sha256').update(bytes).digest('hex')]);
    if (path.extname(abs).toLowerCase() !== '.css') continue;
    const css = bytes.toString('utf8');
    for (const ref of new Set([...extractCssImports(css), ...extractCssUrls(css)])) {
      queue.push({ ref, baseDirAbs: path.dirname(abs) });
    }
  }

  assets.sort(([left], [right]) => left.localeCompare(right));
  return sha256Text(JSON.stringify(assets));
}

export async function pruneSegmentCache(
  cacheDirAbs: string,
  removeEntry: (dirAbs: string) => Promise<void> = (dirAbs) => fs.rm(dirAbs, { recursive: true, force: true }),
): Promise<void> {
  try {
    const entries = await fs.readdir(cacheDirAbs, { withFileTypes: true });
    const stats: Array<{ dirAbs: string; mtimeMs: number; bytes: number }> = [];
    for (const entry of entries) {
      // Workspaces may belong to another active assembly. Only completed
      // cache entries participate in size accounting and eviction.
      if (!entry.isDirectory()
        || entry.name === SEGMENT_CACHE_STAGING_DIR_NAME
        || entry.name.startsWith('.segment-assembly-')) continue;
      const dirAbs = path.join(cacheDirAbs, entry.name);
      let bytes = 0;
      let mtimeMs = 0;
      for (const file of await fs.readdir(dirAbs, { recursive: true, withFileTypes: true }).catch((err) => {
        logOptionalReadFailure('segment cache directory read failed', err);
        return [];
      })) {
        if (!file.isFile()) continue;
        const st = await fs.stat(path.join(String(file.parentPath || file.path || dirAbs), file.name)).catch((err) => {
          logOptionalReadFailure('segment cache file stat failed', err);
          return null;
        });
        if (!st) continue;
        bytes += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
      stats.push({ dirAbs, mtimeMs, bytes });
    }
    let total = stats.reduce((sum, item) => sum + item.bytes, 0);
    if (total <= SEGMENT_CACHE_MAX_BYTES) return;
    for (const item of stats.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= SEGMENT_CACHE_MAX_BYTES) break;
      const removed = await removeEntry(item.dirAbs).then(() => true).catch((err) => {
        log.warn('segment cache eviction failed', { error: logErrorSummary(err) });
        return false;
      });
      if (removed) total -= item.bytes;
    }
  } catch (err) {
    logOptionalReadFailure('segment cache pruning failed', err);
  }
}

const REFERENCE_SHOT_SAMPLES = 24;
const REFERENCE_MAX_SAMPLES = 32;
const REFERENCE_DEFAULT_FRACTIONS = [0, 0.2, 0.4, 0.6, 0.8, 0.98];

/** One still per detected shot (cover frame at 0, otherwise just after the cut
 * so transitions have settled), thinned evenly to the sample cap. Sparse cut
 * lists are topped up with the evenly distributed defaults. */
export function referenceSampleTimes(durationSec: number, cutsSec: readonly number[]): number[] {
  const end = durationSec * 0.98;
  const starts = [0, ...cutsSec.filter(t => Number.isFinite(t) && t > 0.2 && t < end)].sort((a, b) => a - b);
  let times = starts.map((start, i) => (start === 0 ? 0
    : Math.min(start + Math.min(0.4, ((starts[i + 1] ?? durationSec) - start) / 2), end)));
  if (times.length > REFERENCE_SHOT_SAMPLES) {
    const picked = times;
    times = Array.from({ length: REFERENCE_SHOT_SAMPLES }, (_v, i) => picked[Math.round(i * (picked.length - 1) / (REFERENCE_SHOT_SAMPLES - 1))]);
  }
  if (times.length < REFERENCE_DEFAULT_FRACTIONS.length) times.push(...REFERENCE_DEFAULT_FRACTIONS.map(f => f * durationSec));
  const kept: number[] = [];
  for (const t of times.map(v => Math.round(v * 1000) / 1000).sort((a, b) => a - b)) {
    if (!kept.length || t - kept[kept.length - 1] > 0.149) kept.push(t);
  }
  return kept;
}

/** Shots that change inside themselves (builds, typing, camera moves, wipes),
 * from per-frame scene scores: at least 1.5 s long with a summed in-shot
 * change of 0.02 or more. Strongest first, so the end stills that fit under
 * the sample cap go to the shots that move most. */
export function referenceMovingShots(
  durationSec: number,
  cutsSec: readonly number[],
  frameScores: ReadonlyArray<{ t: number; score: number }>,
): Array<{ start_sec: number; end_sec: number; change: number }> {
  const bounds = [0, ...cutsSec, durationSec];
  const moving: Array<{ start_sec: number; end_sec: number; change: number }> = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    if (end - start < 1.5) continue;
    const change = frameScores.reduce((sum, f) => (f.t > start + 0.05 && f.t < end - 0.02 ? sum + f.score : sum), 0);
    if (change >= 0.02) moving.push({ start_sec: start, end_sec: end, change: Math.round(change * 1000) / 1000 });
  }
  return moving.sort((a, b) => b.change - a.change);
}

/** A beat this confident reads as clear. Of 11 local videos with sound
 * (2026-11-13), music beds scored 0.57–0.93, a busy ad track 0.38, and the
 * other seven under 0.1, where the tracker withholds the beats. */
const CLEAR_BEAT_CONFIDENCE = 0.5;
/** The rate the tracker analyses at, so the decode needs no resampling. */
const REFERENCE_AUDIO_RATE = 22050;

/** Tempo of a reference's soundtrack from the beat tracker the music-cut tools
 * use, run in short slices so the main process keeps answering. Null when
 * cancelled. */
export async function referenceTempo(samples: Float32Array, sampleRate: number, signal?: AbortSignal):
  Promise<{ bpm: number | null; beat: 'clear' | 'moderate' | 'unclear' } | null> {
  const steps = rhythmSteps({ sampleRate, channels: [samples] });
  let sliceStart = Date.now();
  let next = steps.next();
  while (!next.done) {
    if (Date.now() - sliceStart >= 10) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (signal?.aborted) return null;
      sliceStart = Date.now();
    }
    next = steps.next();
  }
  const { beats } = next.value;
  const bpm = beats.times.length ? tempoOf(beats.times).value : null;
  return { bpm, beat: bpm === null ? 'unclear' : (beats.confidence ?? 0) >= CLEAR_BEAT_CONFIDENCE ? 'clear' : 'moderate' };
}

/** On-demand source evidence before authoring. Read grants never become write
 * grants: freeze the source under the composition, then decode only that copy.
 * No shell, provider, or semantic verdict is involved. */
/** The local reference readers use the same explicit media input contract. */
export function referenceVideoInput(file: string): string[] | null {
  const extension = path.extname(file).toLowerCase();
  const demuxer = ({ '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.webm': 'matroska', '.mkv': 'matroska', '.ogv': 'ogg' } as Record<string, string>)[extension];
  // Explicit demuxing and local protocols keep reference reading confined to media.
  return demuxer ? ['-protocol_whitelist', 'file,pipe', '-f', demuxer, '-i', file] : null;
}

export async function inspectVideoReference(input: {
  inputAbsPath: string;
  compositionDirAbs: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  sampleTimes?: unknown;
  signal?: AbortSignal;
}): Promise<VideoStudioResult> {
  const fail = (errorCode: string, message: string): VideoStudioResult => ({ ok: false, op: 'reference.inspect', errorCode, message });
  const base = path.join(input.compositionDirAbs, 'assets', 'references');
  if (!isPathAllowed(input.inputAbsPath, input.readRoots)) return fail('E_PATH_OUT_OF_SCOPE', 'Reference source is outside the readable scope.');
  if (!isPathAllowed(base, input.writeRoots)) {
    return fail('E_PATH_OUT_OF_SCOPE', 'Reference evidence must be written inside the writable workspace.');
  }
  const ext = path.extname(input.inputAbsPath).toLowerCase();
  if (!referenceVideoInput(input.inputAbsPath)) return fail('E_REFERENCE_FORMAT', 'Unsupported reference video container.');
  const supplied = input.sampleTimes;
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > REFERENCE_MAX_SAMPLES
    || supplied.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0)
    || new Set(supplied).size !== supplied.length)) {
    return fail('E_REFERENCE_TIMES', `sample_times must contain one to ${REFERENCE_MAX_SAMPLES} distinct non-negative seconds.`);
  }
  const maxBytes = 256 * 1024 * 1024;
  const stat = await fs.stat(input.inputAbsPath).catch(() => null);
  if (!stat?.isFile()) return fail('E_REFERENCE_MISSING', 'Reference video file is unavailable.');
  if (stat.size > maxBytes) return fail('E_REFERENCE_SIZE', 'Reference inspection supports files up to 256 MiB.');
  if (input.signal?.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled.');
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg || !bins.ffprobe) return fail('E_REFERENCE_DECODER', 'Bundled video decoder is unavailable.');
  const timeout = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), 60_000);
  timer.unref?.();
  let dir = '';
  let completed = false;
  try {
    await fs.mkdir(base, { recursive: true });
    dir = await fs.mkdtemp(path.join(base, 'inspect-'));
    const source = path.join(dir, `source${ext}`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    await pipeline(fss.createReadStream(input.inputAbsPath), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) { callback(new Error('reference size limit')); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    }), fss.createWriteStream(source, { flags: 'wx' }), { signal });
    const safeInput = referenceVideoInput(source)!;
    const probe = await runProcess(bins.ffprobe, ['-v', 'error', ...safeInput,
      '-show_entries', 'stream=index,codec_type,width,height,duration:format=duration', '-of', 'json'],
    { signal, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    if (signal.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
    if (probe.code !== 0) return fail('E_REFERENCE_DECODE', 'Reference video could not be decoded.');
    const metadata = JSON.parse(probe.stdout);
    const stream = metadata.streams?.find((s: { codec_type?: string }) => s.codec_type === 'video');
    const hasAudio = metadata.streams?.some((s: { codec_type?: string }) => s.codec_type === 'audio') === true;
    const duration = Number(stream?.duration || metadata.format?.duration);
    const width = Number(stream?.width), height = Number(stream?.height);
    if (!Number.isFinite(duration) || duration <= 0 || !width || !height) return fail('E_REFERENCE_DECODE', 'Reference has no usable video stream or duration.');
    // The default pass also reads the edit rhythm: shot cuts on a downscaled
    // decode and the soundtrack tempo. Neighbor passes with explicit times
    // reuse that evidence and only decode the requested stills.
    let shots: { detected: boolean; cuts_sec: number[]; count: number; median_shot_sec: number | null;
      moving: Array<{ start_sec: number; end_sec: number }> } | undefined;
    let moving: ReturnType<typeof referenceMovingShots> = [];
    let audio: { present: boolean; bpm: number | null; beat: 'clear' | 'moderate' | 'unclear' | 'none' } | undefined;
    if (supplied === undefined) {
      // One downscaled decode prints every frame's scene score: scores above
      // 0.3 are cuts, small scores inside a shot are its own motion.
      const scene = await runProcess(bins.ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'error', ...safeInput, '-t', '600', '-an',
        '-vf', "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", '-f', 'null', '-'],
      { signal, timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 });
      if (signal.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
      const frameScores: Array<{ t: number; score: number }> = [];
      if (scene.code === 0) {
        let t = Number.NaN;
        for (const line of scene.stdout.split('\n')) {
          const time = /pts_time:([0-9.]+)/.exec(line);
          if (time) { t = Number(time[1]); continue; }
          const score = /scene_score=([0-9.]+)/.exec(line);
          if (score && Number.isFinite(t)) frameScores.push({ t, score: Number(score[1]) });
        }
      }
      const cuts = frameScores.filter(f => f.score > 0.3 && f.t > 0).map(f => Math.round(f.t * 1000) / 1000);
      moving = referenceMovingShots(duration, cuts, frameScores);
      const bounds = [0, ...cuts, duration];
      const lengths = bounds.slice(1).map((t, i) => t - bounds[i]).sort((a, b) => a - b);
      shots = { detected: scene.code === 0, cuts_sec: cuts, count: cuts.length + 1,
        median_shot_sec: scene.code === 0 ? Math.round(lengths[Math.floor(lengths.length / 2)] * 100) / 100 : null,
        moving: moving.map(m => ({ start_sec: m.start_sec, end_sec: m.end_sec })).sort((a, b) => a.start_sec - b.start_sec) };
      const pcmPath = path.join(dir, 'audio.f32');
      const decoded = await runProcess(bins.ffmpeg, ['-y', '-loglevel', 'error', ...safeInput, '-t', '120', '-vn', '-ac', '1', '-ar', String(REFERENCE_AUDIO_RATE), '-f', 'f32le', pcmPath],
        { signal, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
      const pcm = decoded.code === 0 ? await fs.readFile(pcmPath).catch(() => null) : null;
      await fs.rm(pcmPath, { force: true }).catch(() => undefined);
      if (signal.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
      if (hasAudio && pcm && pcm.length >= REFERENCE_AUDIO_RATE * 4 * 4) {
        const tempo = await referenceTempo(new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 4))), REFERENCE_AUDIO_RATE, signal);
        if (!tempo) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
        audio = { present: true, ...tempo };
      } else {
        audio = { present: hasAudio, bpm: null, beat: hasAudio ? 'unclear' : 'none' };
      }
    }
    let times = (supplied as number[] | undefined) || referenceSampleTimes(duration, shots?.cuts_sec ?? []);
    // A moving shot also gets a still just before its end, so the sheet shows
    // where its build, camera move or wipe arrives.
    const shotEnds = new Set<number>();
    if (supplied === undefined) {
      for (const shot of moving) {
        if (times.length + shotEnds.size >= REFERENCE_MAX_SAMPLES) break;
        const end = Math.round(Math.min(shot.end_sec - 0.3, duration * 0.99) * 1000) / 1000;
        if (times.some(t => Math.abs(t - end) < 0.6)) continue;
        shotEnds.add(end);
      }
      times = [...times, ...shotEnds].sort((a, b) => a - b);
    }
    if (times.some(t => t >= duration)) return { ...fail('E_REFERENCE_TIMES', 'Requested sample is outside the video duration.'), duration_sec: duration };
    const samples: Array<Pick<FrameSampleEvidence, 'label' | 'time_seconds' | 'path'>> = [];
    for (const time of times) {
      const still = path.join(dir, `frame-${samples.length}.png`);
      const decoded = await runProcess(bins.ffmpeg, ['-y', '-loglevel', 'error', '-threads', '2', '-ss', String(time), ...safeInput,
        '-frames:v', '1', '-threads', '2', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease', still],
      { signal, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (signal.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
      if (decoded.code !== 0 || !(await fs.stat(still).catch(() => null))?.size) {
        return fail('E_REFERENCE_DECODE', 'Requested reference frame is unavailable.');
      }
      samples.push({ label: `source @ ${time.toFixed(3)}s${shotEnds.has(time) ? ' · shot end' : ''}`, time_seconds: time, path: still });
    }
    const contactSheet = await writeFrameContactSheet(dir, samples, { labelOnly: true, columns: 4, thumbWidth: 480 });
    if (signal.aborted) return fail('E_REFERENCE_CANCELLED', 'Reference inspection was cancelled or timed out.');
    completed = true;
    return { ok: true, op: 'reference.inspect', composition_dir: input.compositionDirAbs,
      input_path: input.inputAbsPath, source_path: source, reference_path: path.relative(input.compositionDirAbs, source).split(path.sep).join('/'),
      source_sha256: hash.digest('hex'), bytes, duration_sec: duration, width, height, samples, contact_sheet: contactSheet,
      ...(shots ? { shots } : {}), ...(audio ? { audio } : {}),
      evidence_scope: 'Sampled source stills plus measured cut times and soundtrack tempo. Motion inside shots, speech and target-product facts are not established.' };
  } catch {
    return fail(signal.aborted ? 'E_REFERENCE_CANCELLED' : 'E_REFERENCE_DECODE',
      signal.aborted ? 'Reference inspection was cancelled or timed out.' : 'Reference evidence could not be prepared.');
  } finally {
    clearTimeout(timer);
    if (!completed && dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

const WINDOWS_NATIVE_RUNTIME_INCOMPATIBLE_EXITS = new Set([
  -1073741795, // 0xC000001D: illegal instruction (CPU feature mismatch)
  -1073741515, // 0xC0000135: dependent DLL not found
  -1073741701, // 0xC000007B: invalid image / architecture mismatch
]);

export function isWindowsNativeRuntimeIncompatible(code: number | null): boolean {
  return process.platform === 'win32'
    && typeof code === 'number'
    && WINDOWS_NATIVE_RUNTIME_INCOMPATIBLE_EXITS.has(code | 0);
}

type FrameEncoderOptions = {
  ffmpeg: string;
  outputAbsPath: string;
  width: number;
  height: number;
  fps: number;
  format: RenderFormat;
  quality?: RenderQuality;
  audioTracks: AudioTrack[];
  durationSec: number;
  signal?: AbortSignal;
};

/** Audio graph shared by the frame encoder and the video-track remux path.
 * The video stream is always ffmpeg input 0; audio files follow. */
function audioTrackShapingFilters(track: AudioTrack, durationSec: number): { trim: string; fades: string } {
  const trim = track.inSec !== undefined || track.durSec !== undefined
    ? `atrim=start=${(track.inSec ?? 0).toFixed(3)}${track.durSec !== undefined ? `:duration=${track.durSec.toFixed(3)}` : ''},asetpts=PTS-STARTPTS,`
    : '';
  const fades: string[] = [];
  if (track.fadeInSec) fades.push(`afade=t=in:st=0:d=${track.fadeInSec.toFixed(3)}`);
  if (track.fadeOutSec) {
    // The fade ends where this sound stops being heard, which is the video's end
    // when the source runs longer.
    const audibleSec = Math.min(track.durSec ?? track.declaredDurationSec ?? durationSec, durationSec - track.startSec);
    const startSec = Math.max(0, audibleSec - track.fadeOutSec);
    fades.push(`afade=t=out:st=${startSec.toFixed(3)}:d=${track.fadeOutSec.toFixed(3)}`);
  }
  return { trim, fades: fades.length ? `${fades.join(',')},` : '' };
}

function buildAudioMixGraph(audioTracksIn: AudioTrack[], durationSec: number): {
  tracks: AudioTrack[];
  inputArgs: string[];
  filterAndMapArgs: string[];
} {
  const tracks = audioTracksIn.filter((track) => fss.existsSync(track.absPath));
  const inputArgs: string[] = [];
  for (const track of tracks) inputArgs.push('-i', track.absPath);
  if (!tracks.length) return { tracks, inputArgs, filterAndMapArgs: [] };
  const duration = durationSec.toFixed(3);
  const filters: string[] = [];
  tracks.forEach((track, index) => {
    const inputIndex = index + 1;
    const delayMs = Math.max(0, Math.round((track.startSec || 0) * 1000));
    const volume = Number.isFinite(track.volume) && track.volume >= 0 ? track.volume : 1;
    const delay = delayMs > 0 ? `adelay=${delayMs}|${delayMs},` : '';
    const { trim, fades } = audioTrackShapingFilters(track, durationSec);
    filters.push(`[${inputIndex}:a]${trim}volume=${volume},${fades}${delay}apad,atrim=0:${duration}[a${index}]`);
  });
  const label = (index: number) => `[a${index}]`;
  const voices = tracks.flatMap((track, index) => (track.voice ? [index] : []));
  const ducked = tracks.flatMap((track, index) => (track.duck && !track.voice ? [index] : []));
  if (tracks.length === 1) {
    filters.push('[a0]anull[aout]');
  } else if (voices.length && ducked.length) {
    const mixed = (indexes: number[], out: string) => (indexes.length === 1
      ? `${label(indexes[0])}anull[${out}]`
      : `${indexes.map(label).join('')}amix=inputs=${indexes.length}:duration=longest:normalize=0[${out}]`);
    const others = tracks.flatMap((track, index) => (track.voice || (track.duck && !track.voice) ? [] : [index]));
    filters.push(mixed(voices, 'voice_mix'));
    filters.push('[voice_mix]asetnsamples=n=1024:p=1,asplit=2[voice_out][voice_key]');
    filters.push(mixed(ducked, 'duck_mix'));
    // Complete frames keep compressor EOF from discarding the music tail.
    filters.push('[duck_mix]asetnsamples=n=1024:p=1[duck_aligned]');
    filters.push('[duck_aligned][voice_key]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[duck_out]');
    filters.push(`[voice_out][duck_out]${others.map(label).join('')}amix=inputs=${2 + others.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
  } else {
    filters.push(`${tracks.map((_track, index) => `[a${index}]`).join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
  }
  return {
    tracks,
    inputArgs,
    filterAndMapArgs: ['-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]'],
  };
}

export function buildFrameEncoderArgs(opts: Omit<FrameEncoderOptions, 'ffmpeg' | 'signal'>): string[] {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${opts.width}x${opts.height}`,
    '-framerate', String(opts.fps),
    '-i', 'pipe:0',
  ];
  const graph = buildAudioMixGraph(opts.audioTracks, opts.durationSec);
  const audioTracks = graph.tracks;
  args.push(...graph.inputArgs);
  args.push(...graph.filterAndMapArgs);
  if (opts.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(crfForQuality(opts.quality) + 8));
    if (audioTracks.length) args.push('-c:a', 'libopus');
  } else {
    args.push(...mp4VideoEncoderArgs(opts.quality));
    if (audioTracks.length) args.push('-c:a', 'aac');
  }
  args.push('-t', opts.durationSec.toFixed(3), opts.outputAbsPath);
  return args;
}

/** Remux for the R0 reuse path: copy the prior render's video stream
 * untouched and rebuild only the audio graph from the current tracks. */
export function buildVideoTrackRemuxArgs(opts: {
  priorVideoAbsPath: string;
  outputAbsPath: string;
  durationSec: number;
  format?: RenderFormat;
  audioTracks: AudioTrack[];
}): string[] {
  const args = ['-y', '-i', opts.priorVideoAbsPath];
  const graph = buildAudioMixGraph(opts.audioTracks, opts.durationSec);
  args.push(...graph.inputArgs);
  if (graph.tracks.length) {
    args.push(...graph.filterAndMapArgs);
  } else {
    args.push('-map', '0:v:0', '-an');
  }
  args.push('-c:v', 'copy');
  if (opts.format === 'webm') {
    if (graph.tracks.length) args.push('-c:a', 'libopus');
  } else {
    if (graph.tracks.length) args.push('-c:a', 'aac');
    args.push('-movflags', '+faststart');
  }
  args.push('-t', opts.durationSec.toFixed(3), opts.outputAbsPath);
  return args;
}

export function startRawFrameEncoder(opts: FrameEncoderOptions): {
  writeFrame: (bitmap: Buffer) => Promise<void>;
  finish: () => Promise<ProcessResult>;
  wait: () => Promise<ProcessResult>;
  cancel: () => void;
  bytesWritten: () => number;
} {
  const child = spawn(opts.ffmpeg, buildFrameEncoderArgs(opts), {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let settled = false;
  let terminating = false;
  let childClosed = false;
  let treeCleanupComplete = false;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let bytesWritten = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let resolveDone: (result: ProcessResult) => void = () => {};
  const done = new Promise<ProcessResult>((resolve) => { resolveDone = resolve; });
  let timer: NodeJS.Timeout | null = null;
  const appendBounded = (target: string[], chunk: Buffer) => {
    target.push(chunk.toString('utf8'));
    while (target.length > 128) target.shift();
  };
  const settle = (code: number | null, errorMessage = '') => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    timer = null;
    opts.signal?.removeEventListener('abort', onAbort);
    if (errorMessage) stderr.push(errorMessage);
    resolveDone({
      code,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      timedOut,
      aborted: !!opts.signal?.aborted,
    });
  };
  const terminate = () => {
    if (terminating || settled) return;
    terminating = true;
    cleanupTimer = setTimeout(() => {
      settle(-1, 'FFmpeg process cleanup did not confirm exit within 10 seconds.');
    }, 10_000);
    const complete = () => {
      treeCleanupComplete = true;
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (childClosed) settle(-1);
    };
    // Closing stdin first lets FFmpeg exit before Windows can identify its
    // process tree. Keep the pipe open until the bounded tree cleanup completes.
    try { killProcessTree(child, 'SIGKILL', { onComplete: complete }); }
    catch { complete(); }
  };
  const onAbort = () => {
    terminate();
  };
  timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, RENDER_TIMEOUT_MS);
  timer.unref?.();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderr, chunk));
  child.stdin?.on('error', () => { /* write callbacks surface EPIPE to the render loop */ });
  child.on('error', (err: Error) => settle(-1, err.message));
  child.on('close', (code) => {
    childClosed = true;
    if (!terminating) settle(code);
    else if (treeCleanupComplete) settle(-1);
  });

  return {
    writeFrame: (bitmap: Buffer) => new Promise<void>((resolve, reject) => {
      if (settled || terminating || child.stdin.destroyed || !child.stdin.writable) {
        reject(new Error('ffmpeg frame pipe closed before all frames were written.'));
        return;
      }
      bytesWritten += bitmap.length;
      child.stdin.write(bitmap, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    finish: async () => {
      if (!terminating && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      return done;
    },
    wait: () => done,
    cancel: terminate,
    bytesWritten: () => bytesWritten,
  };
}

const PROCESS_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export async function runVideoProcessForTest(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ProcessResult> {
  if (opts.signal?.aborted) {
    return { code: -1, stdout: '', stderr: '', timedOut: false, aborted: true };
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let settled = false;
    let outputBytes = 0;
    const maxOutputBytes = Math.max(1, opts.maxOutputBytes ?? PROCESS_OUTPUT_MAX_BYTES);
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (code: number | null, errorMessage = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      if (errorMessage) err.push(errorMessage);
      resolve({ code, stdout: out.join(''), stderr: err.join(''), timedOut, aborted: !!opts.signal?.aborted });
    };
    const terminate = () => {
      try { killProcessTree(child, 'SIGKILL'); } catch { /* best effort */ }
    };
    const onAbort = () => {
      terminate();
      finish(-1);
    };
    const capture = (target: string[], chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        finish(-1, `process output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      target.push(data.toString('utf8'));
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
        finish(-1);
      }, opts.timeoutMs);
      timer.unref?.();
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout?.on('data', (c: Buffer | string) => capture(out, c));
    child.stderr?.on('data', (c: Buffer | string) => capture(err, c));
    child.stdin?.on('error', () => { /* spawn/termination races can close stdin before EOF */ });
    child.stdin?.end();
    child.on('error', (e: Error) => {
      finish(-1, e.message);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

const runProcess = runVideoProcessForTest;

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || '');
  const end = raw.lastIndexOf('}');
  if (end < 0) return null;
  const start = raw.lastIndexOf('{', end);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function loudnessNumber(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function loudnessReportFromJson(value: Record<string, unknown> | null, rawTail = ''): LoudnessReport {
  if (!value) {
    return {
      ok: false,
      input_i: null,
      input_tp: null,
      input_lra: null,
      target_i: LOUDNESS_TARGET_I,
      target_tp: LOUDNESS_TARGET_TP,
      target_lra: LOUDNESS_TARGET_LRA,
      raw_tail: rawTail,
      error: 'Could not parse ffmpeg loudnorm JSON.',
    };
  }
  return {
    ok: true,
    input_i: loudnessNumber(value.input_i),
    input_tp: loudnessNumber(value.input_tp),
    input_lra: loudnessNumber(value.input_lra),
    input_thresh: loudnessNumber(value.input_thresh),
    target_offset: loudnessNumber(value.target_offset),
    target_i: LOUDNESS_TARGET_I,
    target_tp: LOUDNESS_TARGET_TP,
    target_lra: LOUDNESS_TARGET_LRA,
    normalized: value,
  };
}

/** loudnorm options that apply a measurement of the same audio, or null when it is incomplete.
 *  One pass guesses as it goes and falls short on a quiet mix with louder moments: a -28 LUFS
 *  ad (a music bed under a 2 s voice-over) came out at -18.4 against -14 (2026-11-17). Pure. */
export function loudnormSecondPassOptions(report: LoudnessReport | null | undefined): string | null {
  if (!report) return null;
  const values = [report.input_i, report.input_tp, report.input_lra, report.input_thresh, report.target_offset];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const [i, tp, lra, thresh, offset] = values as number[];
  return `measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${thresh}:offset=${offset}:linear=true`;
}

export function shouldNormalizeLoudness(report: LoudnessReport | null, quality: RenderQuality | undefined): { normalize: boolean; reason: string } {
  if (!report || report.ok === false) return { normalize: false, reason: 'loudness analysis unavailable' };
  if (report.input_i === null || !Number.isFinite(report.input_i)
      || report.input_tp === null || !Number.isFinite(report.input_tp)) {
    return { normalize: false, reason: 'loudness analysis unavailable' };
  }
  if (quality === 'high') return { normalize: true, reason: 'high quality export' };
  const integrated = report.input_i;
  if (integrated !== null && Math.abs(integrated - LOUDNESS_TARGET_I) >= LOUDNESS_DRAFT_NORMALIZE_DELTA_LU) {
    return { normalize: true, reason: `integrated loudness ${round2(integrated)} LUFS is far from target ${LOUDNESS_TARGET_I} LUFS` };
  }
  const truePeak = report.input_tp;
  if (truePeak !== null && truePeak > LOUDNESS_TARGET_TP + 0.5) {
    return { normalize: true, reason: `true peak ${round2(truePeak)} dBTP exceeds target ${LOUDNESS_TARGET_TP} dBTP` };
  }
  return { normalize: false, reason: 'within draft loudness tolerance' };
}

export async function analyzeLoudness(ffmpeg: string, mediaAbsPath: string, signal?: AbortSignal): Promise<LoudnessReport> {
  const r = await runProcess(ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i', mediaAbsPath,
    '-af', `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}:print_format=json`,
    '-f', 'null',
    '-',
  ], { signal, timeoutMs: FFPROBE_TIMEOUT_MS });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.aborted) return { ...loudnessReportFromJson(null), error: 'loudness analysis aborted.' };
  if (r.timedOut) return { ...loudnessReportFromJson(null), error: 'loudness analysis timed out.' };
  if (r.code !== 0) return { ...loudnessReportFromJson(null), error: 'loudness analysis failed.' };
  return loudnessReportFromJson(parseLastJsonObject(text), text.slice(-1000));
}

/** `measured` is analyzeLoudness of this same file; with it, the normalization is the second of
 *  two passes and lands on the target instead of short of it. */
export async function normalizeAudioInPlace(
  ffmpeg: string,
  mediaAbsPath: string,
  signal?: AbortSignal,
  measured?: LoudnessReport | null,
): Promise<Record<string, unknown>> {
  const ext = path.extname(mediaAbsPath) || '.mp4';
  if (ext.toLowerCase() !== '.mp4') {
    return { skipped: true, reason: 'audio normalization currently applies only to mp4 output' };
  }
  const tmp = path.join(path.dirname(mediaAbsPath), `${path.basename(mediaAbsPath, ext)}.norm-${Date.now()}${ext}`);
  const secondPass = loudnormSecondPassOptions(measured);
  const r = await runProcess(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaAbsPath,
    '-af', `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}${secondPass ? `:${secondPass}` : ''}`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    // loudnorm works at 192 kHz, and without an output rate the AAC file came out at 96 kHz.
    '-ar', '48000',
    tmp,
  ], { signal, timeoutMs: RENDER_TIMEOUT_MS });
  if (r.aborted) return { skipped: true, reason: 'normalization aborted' };
  if (r.timedOut) return { skipped: true, reason: 'normalization timed out' };
  if (r.code !== 0) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { skipped: true, reason: 'normalization failed', stderr_tail: redactPaths(r.stderr.slice(-1000)) };
  }
  await fs.rename(tmp, mediaAbsPath);
  return { skipped: false, path: mediaAbsPath, passes: secondPass ? 2 : 1 };
}

export async function buildMediaQa(
  meta: CompositionMeta,
  mediaProbe: MediaProbe | null,
  ffprobe: string | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  const sourceAudioTracks: Array<{
    path: string;
    start_seconds: number;
    volume: number;
    declared_duration_seconds?: number;
    source_duration_seconds?: number;
    expected_duration_seconds?: number;
    expected_end_seconds?: number;
  }> = [];

  if (!mediaProbe) {
    issues.push({
      code: 'MEDIA_PROBE_MISSING',
      severity: 'error',
      message: 'Final media could not be probed with ffprobe.',
      source: 'orkas-native-media-qa',
    });
  } else {
    if (!mediaProbe.video) {
      issues.push({
        code: 'VIDEO_STREAM_MISSING',
        severity: 'error',
        message: 'Final media does not contain a video stream.',
        source: 'orkas-native-media-qa',
      });
    }
    if (mediaProbe.duration_seconds !== null && Math.abs(mediaProbe.duration_seconds - meta.durationSec) > MEDIA_DURATION_TOLERANCE_SEC) {
      issues.push({
        code: 'MEDIA_DURATION_MISMATCH',
        severity: 'error',
        message: `Final media duration ${round2(mediaProbe.duration_seconds)}s does not match composition duration ${round2(meta.durationSec)}s.`,
        source: 'orkas-native-media-qa',
      });
    }
    const videoDuration = mediaProbe.video?.duration_seconds;
    if (videoDuration !== undefined && Math.abs(videoDuration - meta.durationSec) > MEDIA_DURATION_TOLERANCE_SEC) {
      issues.push({
        code: 'VIDEO_DURATION_MISMATCH',
        severity: 'error',
        message: `Final video stream duration ${round2(videoDuration)}s does not match composition duration ${round2(meta.durationSec)}s.`,
        source: 'orkas-native-media-qa',
      });
    }
  }

  let expectedAudioEndSec = 0;
  for (const track of meta.audioTracks) {
    const sourceProbe = ffprobe ? await probeMedia(ffprobe, track.absPath, signal) : null;
    const sourceDurationSec = sourceProbe?.duration_seconds ?? sourceProbe?.audio?.duration_seconds;
    const expectedCandidates = [
      track.declaredDurationSec,
      sourceDurationSec,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
    const expectedDurationSec = expectedCandidates.length ? Math.min(...expectedCandidates) : undefined;
    const expectedEndSec = expectedDurationSec !== undefined
      ? Math.min(meta.durationSec, track.startSec + expectedDurationSec)
      : undefined;
    if (expectedEndSec !== undefined) expectedAudioEndSec = Math.max(expectedAudioEndSec, expectedEndSec);
    sourceAudioTracks.push({
      path: track.absPath,
      start_seconds: round2(track.startSec),
      volume: round2(track.volume),
      ...(track.declaredDurationSec !== undefined ? { declared_duration_seconds: round2(track.declaredDurationSec) } : {}),
      ...(sourceDurationSec !== undefined ? { source_duration_seconds: round2(sourceDurationSec) } : {}),
      ...(expectedDurationSec !== undefined ? { expected_duration_seconds: round2(expectedDurationSec) } : {}),
      ...(expectedEndSec !== undefined ? { expected_end_seconds: round2(expectedEndSec) } : {}),
    });
  }

  if (meta.audioTracks.length > 0) {
    if (!mediaProbe?.audio) {
      issues.push({
        code: 'AUDIO_STREAM_MISSING',
        severity: 'error',
        message: 'Composition declares audio tracks, but final media has no audio stream.',
        source: 'orkas-native-media-qa',
      });
    } else {
      const actualAudioDurationSec = mediaProbe.audio.duration_seconds ?? mediaProbe.duration_seconds;
      if (expectedAudioEndSec > 0 && actualAudioDurationSec !== null && actualAudioDurationSec !== undefined
        && actualAudioDurationSec + AUDIO_DURATION_TOLERANCE_SEC < expectedAudioEndSec) {
        issues.push({
          code: 'AUDIO_STREAM_TOO_SHORT',
          severity: 'error',
          message: `Final audio stream duration ${round2(actualAudioDurationSec)}s is shorter than expected narration coverage ${round2(expectedAudioEndSec)}s.`,
          source: 'orkas-native-media-qa',
        });
      }
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    media_duration_seconds: mediaProbe?.duration_seconds !== null && mediaProbe?.duration_seconds !== undefined
      ? round2(mediaProbe.duration_seconds)
      : null,
    video_duration_seconds: mediaProbe?.video?.duration_seconds !== undefined ? round2(mediaProbe.video.duration_seconds) : null,
    audio_duration_seconds: mediaProbe?.audio?.duration_seconds !== undefined
      ? round2(mediaProbe.audio.duration_seconds)
      : (mediaProbe?.audio && mediaProbe.duration_seconds !== null ? round2(mediaProbe.duration_seconds) : null),
    expected_audio_end_seconds: expectedAudioEndSec > 0 ? round2(expectedAudioEndSec) : null,
    source_audio_tracks: sourceAudioTracks,
    issues,
  };
}

function filePathIfExists(value: string | undefined): string {
  if (!value) return '';
  try {
    const resolved = path.resolve(value);
    return fss.statSync(resolved).isFile() ? resolved : '';
  } catch {
    return '';
  }
}

function resolveWhisperBackend(modelHint?: string): { cli: string; model: string; source: 'env' | 'bundled' } | null {
  const cli = filePathIfExists(process.env.ORKAS_WHISPER_CPP || process.env.ORKAS_WHISPER_CLI);
  const model = filePathIfExists(modelHint) || filePathIfExists(process.env.ORKAS_WHISPER_MODEL);
  if (!cli || !model) return null;
  return { cli, model, source: 'env' };
}

export function resolveSpeechTranscribeBackend(modelHint?: string): { cli: string; model: string; source: 'env' | 'bundled' } | null {
  const envBackend = resolveWhisperBackend(modelHint);
  if (envBackend) return envBackend;
  const bundled = bundledWhisperPaths(modelHint);
  const envCli = filePathIfExists(process.env.ORKAS_WHISPER_CPP || process.env.ORKAS_WHISPER_CLI);
  if (envCli && bundled.model) return { cli: envCli, model: bundled.model, source: 'bundled' };
  const envModel = filePathIfExists(modelHint) || filePathIfExists(process.env.ORKAS_WHISPER_MODEL);
  if (bundled.cli && envModel) return { cli: bundled.cli, model: envModel, source: 'bundled' };
  if (bundled.cli && bundled.model) return { cli: bundled.cli, model: bundled.model, source: 'bundled' };
  return null;
}

type WhisperJsonObject = Record<string, unknown>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function offsetsMs(value: unknown): { from: number; to: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const offsets = value as WhisperJsonObject;
  const from = finiteNumber(offsets.from);
  const to = finiteNumber(offsets.to);
  return from === undefined || to === undefined ? null : { from, to };
}

function isWhisperSpecialToken(text: string): boolean {
  return /^\[[_A-Z0-9]+\]$/i.test(text.trim()) || /^<\|[^|]+\|>$/.test(text.trim());
}

function tokenWords(tokens: unknown[], segment: { from: number; to: number } | null): Array<{ text: string; startSec: number; endSec: number }> {
  const timed = tokens.flatMap(token => {
    if (!token || typeof token !== 'object' || Array.isArray(token)) return [];
    const item = token as WhisperJsonObject;
    const rawText = typeof item.text === 'string' ? item.text : '';
    const timing = offsetsMs(item.offsets);
    if (!rawText.trim() || !timing || isWhisperSpecialToken(rawText)) return [];
    const endMs = timing.to;
    return [{ rawText, text: rawText.trim(), startMs: timing.from, endMs }];
  });

  const words: Array<{ text: string; startSec: number; endSec: number }> = [];
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const punctuation = /^[\p{P}\p{S}]+$/u;
  // whisper.cpp gives some words a point instead of a span: 5 of 62 words in a Chinese
  // talking-head recording and 7 of 170 in a podcast (2026-11-14), each at or before the
  // next word's start with a gap after the previous word. Such a word was spoken between
  // its neighbours' measured edges (the segment's own edges at either end), so it takes
  // that span; nothing is invented past them. A point with no room there, or outside it,
  // stays a point and fails validation. Punctuation keeps attaching to the word before.
  for (let index = 0; index < timed.length; index += 1) {
    const token = timed[index];
    if (token.endMs !== token.startMs || punctuation.test(token.text)) continue;
    const lowMs = index > 0 ? timed[index - 1].endMs : segment?.from;
    const highMs = index + 1 < timed.length ? timed[index + 1].startMs : segment?.to;
    if (lowMs === undefined || highMs === undefined || !(lowMs <= token.startMs && token.startMs <= highMs && lowMs < highMs)) continue;
    token.startMs = lowMs;
    token.endMs = highMs;
  }
  for (const token of timed) {
    const previous = words[words.length - 1];
    const startsNewWord = /^\s/u.test(token.rawText) || cjk.test(token.text) || !previous;
    if (previous && punctuation.test(token.text)) {
      previous.text += token.text;
      previous.endSec = Math.max(previous.endSec, token.endMs / 1000);
    } else if (previous && !startsNewWord) {
      previous.text += token.text;
      previous.endSec = Math.max(previous.endSec, token.endMs / 1000);
    } else {
      words.push({ text: token.text, startSec: token.startMs / 1000, endSec: token.endMs / 1000 });
    }
  }
  return words.filter(word => word.text);
}

export function normalizeWhisperTranscript(parsed: unknown, timestampDetail: 'segment' | 'word'): WhisperJsonObject {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as WhisperJsonObject
    : { raw: parsed };
  const transcription = Array.isArray(source.transcription) ? source.transcription : [];
  const segments = transcription.flatMap(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return [];
    const item = segment as WhisperJsonObject;
    const timing = offsetsMs(item.offsets);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!timing || !text || timing.to <= timing.from) return [];
    return [{ text, startSec: timing.from / 1000, endSec: timing.to / 1000 }];
  });
  const words = timestampDetail === 'word'
    ? transcription.flatMap(segment => {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return [];
      const item = segment as WhisperJsonObject;
      return Array.isArray(item.tokens) ? tokenWords(item.tokens, offsetsMs(item.offsets)) : [];
    })
    : [];
  const result = source.result && typeof source.result === 'object' && !Array.isArray(source.result)
    ? source.result as WhisperJsonObject
    : {};
  return {
    ...source,
    schema_version: 1,
    backend: 'whisper.cpp',
    language: typeof result.language === 'string' ? result.language : '',
    timestamp_detail: timestampDetail,
    text: segments.map(segment => segment.text).join(' ').trim(),
    segments,
    words,
  };
}

function whisperDtwModel(modelPath: string): string | undefined {
  const name = path.basename(modelPath).toLowerCase();
  for (const model of ['large-v3-turbo', 'large-v3', 'large-v2', 'large-v1', 'medium', 'small', 'base', 'tiny']) {
    if (name.includes(model)) return model;
  }
  return undefined;
}

/** The language argument whisper.cpp accepts: `auto`, or a language without
 * its region or script. whisper.cpp answers `-l zh-CN` by printing its usage
 * and exiting 0 with no transcript, and callers pass such tags because the
 * same `language` field takes one for speech.capabilities (2026-10-31). */
function whisperLanguageArg(language: string | undefined): string {
  const value = String(language ?? '').trim();
  if (!value || value.toLowerCase() === 'auto') return 'auto';
  return (value.split(/[-_]/)[0] || value).toLowerCase();
}

/** The sentence a Chinese recording is read as following, in the script the account reads.
 *  Without one the bundled model wrote Mandarin in Traditional characters, so captions came out
 *  Traditional for a Simplified reader, and it misheard more: on 2026-11-24 a talk read
 *  會員/採過康 and a lecture 未國 where they said 会员/踩过坑 and 魏国; with the sentence both
 *  came out Simplified and right. A Traditional Chinese account gets the Traditional sentence. Pure. */
export function chineseTranscriptPrompt(lang: string): string {
  return lang === 'zh-tw' ? '以下是普通話的句子。' : '以下是普通话的句子。';
}

/** Match offline audio projects: the bundled Intel macOS Metal path can corrupt recognition. */
const whisperDeviceArgs = (): string[] => (process.platform === 'darwin' && process.arch === 'x64' ? ['-ng'] : []);

export function buildSpeechTranscribeArgs(
  modelPath: string,
  wavPath: string,
  outBase: string,
  options: Pick<SpeechTranscribeOptions, 'language' | 'timestamps'> & { prompt?: string },
): string[] {
  const timestampDetail = options.timestamps === 'word' ? 'word' : 'segment';
  const args = ['-m', modelPath, '-f', wavPath, timestampDetail === 'word' ? '-ojf' : '-oj', '-of', outBase, '-np'];
  args.push('-l', whisperLanguageArg(options.language));
  if (options.prompt) args.push('--prompt', options.prompt);
  args.push(...whisperDeviceArgs());
  if (timestampDetail === 'word') {
    const dtwModel = whisperDtwModel(modelPath);
    if (dtwModel) args.push('-dtw', dtwModel);
  }
  return args;
}

/** Most measured speech spans recognized again to place the words: about eight minutes of talk. */
export const WORD_PLACEMENT_MAX_SPANS = 240;
/** Most speech, in seconds, recognized again to place the words. */
const WORD_PLACEMENT_MAX_SPEECH_SEC = 900;
/** Spans up to this long with their padding fit the short recognition window below. */
const WORD_PLACEMENT_SHORT_SEC = 5;
/** whisper.cpp audio context for short spans, in 20 ms frames (5.12 s). A span is otherwise padded
 * to a 30 s window: 204 short spans took 98 s on a CPU, 21 s with this (2026-11-18), and the text
 * only guides placement. */
const WORD_PLACEMENT_SHORT_CONTEXT = '256';
/** Pause kept on each side of a span, at most half of it, so a soft onset is still heard. */
const WORD_PLACEMENT_PAD_SEC = 0.1;
const WORD_PLACEMENT_TIMEOUT_MS = 90_000;

/** Where the samples of a 16-bit mono PCM WAV are and their rate, from its header alone. */
async function pcm16MonoWav(file: fs.FileHandle): Promise<{ rate: number; dataOffset: number; dataBytes: number } | null> {
  const head = Buffer.alloc(64 * 1024);
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  if (bytesRead < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let rate = 0;
  for (let offset = 12; offset + 8 <= bytesRead;) {
    const id = head.toString('ascii', offset, offset + 4), size = head.readUInt32LE(offset + 4), body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytesRead) {
      const pcm = head.readUInt16LE(body) === 1 && head.readUInt16LE(body + 2) === 1 && head.readUInt16LE(body + 14) === 16;
      rate = pcm ? head.readUInt32LE(body + 4) : 0;
    } else if (id === 'data') {
      return rate > 0 ? { rate, dataOffset: body, dataBytes: size } : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function wavBytes(rate: number, samples: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/**
 * The recognized words, each moved into the measured speech span it was spoken in, or null when
 * they cannot be placed and keep their recognized times. Each span between measured pauses is cut
 * from the extracted audio and recognized on its own in one more whisper.cpp run; that text only
 * guides placement (`placeWordsInSpeech`). Bounded by span count, speech length and a deadline;
 * a failed or unusable run changes nothing. Throws only when cancelled.
 */
async function placeWordsBySpanRecognition(o: {
  backend: { cli: string; model: string }; wavPath: string; dir: string; language: string; prompt?: string;
  words: PhraseWord[]; silences: PhraseSpan[]; durationSec: number; signal?: AbortSignal;
}): Promise<PhraseWord[] | null> {
  const spans = speechSpans(o.silences, o.durationSec);
  const speech = spans.reduce((sum, s) => sum + s.endSec - s.startSec, 0);
  if (spans.length < 2 || spans.length > WORD_PLACEMENT_MAX_SPANS || speech > WORD_PLACEMENT_MAX_SPEECH_SEC
    || !o.words.length || pausesHoldSpeech(o.words, spans)) return null;
  const started = Date.now();
  const spanDir = path.join(o.dir, 'spans');
  await fs.mkdir(spanDir, { recursive: true });
  const files: string[] = [];
  const handle = await fs.open(o.wavPath, 'r');
  try {
    const wav = await pcm16MonoWav(handle);
    if (!wav) return null;
    for (let i = 0; i < spans.length; i += 1) {
      const before = i > 0 ? spans[i].startSec - spans[i - 1].endSec : spans[i].startSec;
      const after = (i + 1 < spans.length ? spans[i + 1].startSec : o.durationSec) - spans[i].endSec;
      const from = Math.max(0, spans[i].startSec - Math.min(WORD_PLACEMENT_PAD_SEC, before / 2));
      const to = spans[i].endSec + Math.max(0, Math.min(WORD_PLACEMENT_PAD_SEC, after / 2));
      const first = Math.floor(from * wav.rate) * 2, end = Math.min(wav.dataBytes, Math.ceil(to * wav.rate) * 2);
      const samples = Buffer.alloc(Math.max(0, end - first));
      if (samples.length) await handle.read(samples, 0, samples.length, wav.dataOffset + first);
      files.push(path.join(spanDir, `${i}.wav`));
      await fs.writeFile(files[i], wavBytes(wav.rate, samples));
    }
  } finally { await handle.close(); }
  const short = files.filter((_, i) => spans[i].endSec - spans[i].startSec + 2 * WORD_PLACEMENT_PAD_SEC <= WORD_PLACEMENT_SHORT_SEC);
  const long = files.filter(file => !short.includes(file));
  // The same opening sentence as the whole file, so each span is written in the same script.
  const base = ['-m', o.backend.model, '-l', o.language, ...(o.prompt ? ['--prompt', o.prompt] : []), '-oj', '-np', '-nf', ...whisperDeviceArgs()];
  for (const [group, context] of [[short, ['-ac', WORD_PLACEMENT_SHORT_CONTEXT]], [long, []]] as const) {
    if (!group.length) continue;
    o.signal?.throwIfAborted();
    const timeoutMs = WORD_PLACEMENT_TIMEOUT_MS - (Date.now() - started);
    const run = timeoutMs > 0
      ? await runProcess(o.backend.cli, [...base, ...context, ...group.flatMap(file => ['-f', file])], { signal: o.signal, timeoutMs })
      : null;
    if (run?.aborted) o.signal?.throwIfAborted();
    if (!run || run.code !== 0) {
      log.warn('speech.transcribe kept recognized word times', { spans: spans.length, reason: run ? (run.timedOut ? 'timeout' : `exit ${run.code}`) : 'timeout' });
      return null;
    }
  }
  const texts = await Promise.all(files.map(async (file) => {
    try {
      const rows = (JSON.parse(await fs.readFile(`${file}.json`, 'utf8')) as WhisperJsonObject).transcription;
      return Array.isArray(rows) ? rows.map(row => String((row as WhisperJsonObject)?.text ?? '').trim()).join(' ') : '';
    } catch { return ''; }
  }));
  const placed = placeWordsInSpeech(o.words, spans.map((s, i) => ({ ...s, text: texts[i] })));
  log.info('speech.transcribe word placement', { spans: spans.length, placed: !!placed, ms: Date.now() - started });
  return placed;
}

/** Share of the words that may start after the end of the recording before its timing as a
 *  whole is not trusted. Real transcripts had at most 5 of 89 there (2026-11-19). */
const LATE_WORDS_MAX_SHARE = 0.1;

const isTextToken = (token: unknown): boolean => {
  const text = token && typeof token === 'object' && !Array.isArray(token) ? (token as WhisperJsonObject).text : undefined;
  return typeof text === 'string' && !!text.trim() && !isWhisperSpecialToken(text);
};

/** A whisper result whose times past the end of the recording end there, or null when too many
 *  of its words start after the end for its timing to be trusted (left to the usual checks).
 *  2026-11-19: 128 of 263 real transcripts were refused whole for such times, mostly by tens
 *  of milliseconds or by a last segment running to the recognizer's 30 s window. Pure. */
export function endedWithRecording(parsed: unknown, endMs: number): unknown | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(endMs > 0)) return null;
  const rows = (parsed as WhisperJsonObject).transcription;
  if (!Array.isArray(rows)) return null;
  const words = rows.flatMap((row) => (row && typeof row === 'object' && Array.isArray((row as WhisperJsonObject).tokens)
    ? ((row as WhisperJsonObject).tokens as unknown[]).filter(isTextToken) : []));
  const late = words.filter((token) => (offsetsMs((token as WhisperJsonObject).offsets)?.from ?? 0) >= endMs).length;
  if (late > words.length * LATE_WORDS_MAX_SHARE) return null;
  return clampWhisperTimesToEnd(parsed, endMs);
}

/** A whisper result with every time past `endMs` ended there and every segment or word
 *  starting at or after it dropped; anything else is left for the usual checks. Pure. */
export function clampWhisperTimesToEnd(parsed: unknown, endMs: number): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(endMs > 0)) return parsed;
  const rows = (parsed as WhisperJsonObject).transcription;
  if (!Array.isArray(rows)) return parsed;
  // Only timed objects are touched; anything malformed is kept for the structural checks.
  const timing = (item: unknown) => (item && typeof item === 'object' && !Array.isArray(item) ? offsetsMs((item as WhisperJsonObject).offsets) : null);
  const startsAfter = (item: unknown) => (timing(item)?.from ?? -1) >= endMs;
  const ended = (item: unknown): unknown => {
    const time = timing(item);
    if (!time || time.to <= endMs) return item;
    return { ...(item as WhisperJsonObject), offsets: { ...((item as WhisperJsonObject).offsets as object), to: endMs } };
  };
  const transcription = rows.filter((row) => !startsAfter(row)).map((row) => {
    const kept = ended(row);
    const tokens = kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as WhisperJsonObject).tokens : undefined;
    return Array.isArray(tokens) ? { ...(kept as WhisperJsonObject), tokens: tokens.filter((token) => !startsAfter(token)).map(ended) } : kept;
  });
  return { ...(parsed as WhisperJsonObject), transcription };
}

/**
 * whisper.cpp may time the first words after a long pause to end before they start: the start is
 * the segment's, the end a word time drifted into the pause before it (2026-11-23: five words after
 * a 2.6 s pause in a talk to camera, each starting at 38.4 s and ending between 37.0 and 38.2 s).
 * The whole transcript was then refused, so a talk with one long pause got no subtitles and no
 * timed cuts. Each run of such words takes the time between the words around it, split at the
 * run's own end times when they fall in order inside it, else evenly; word placement then moves
 * them into the measured speech. A run with no time between its neighbours is left as it came,
 * and the usual checks refuse it. Pure; returns how many words it retimed.
 */
export function retimeInvertedWords(parsed: unknown): { parsed: unknown; retimed: number } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { parsed, retimed: 0 };
  const rows = (parsed as WhisperJsonObject).transcription;
  if (!Array.isArray(rows)) return { parsed, retimed: 0 };
  type Ref = { row: number; token: number; from: number; to: number };
  const refs: Ref[] = [];
  rows.forEach((row, rowIndex) => {
    const tokens = row && typeof row === 'object' && !Array.isArray(row) ? (row as WhisperJsonObject).tokens : undefined;
    if (!Array.isArray(tokens)) return;
    tokens.forEach((token, tokenIndex) => {
      const time = isTextToken(token) ? offsetsMs((token as WhisperJsonObject).offsets) : null;
      if (time) refs.push({ row: rowIndex, token: tokenIndex, ...time });
    });
  });
  const inverted = (ref: Ref) => ref.to < ref.from;
  let transcription: unknown[] | undefined;
  let retimed = 0;
  for (let start = 0; start < refs.length; start += 1) {
    if (!inverted(refs[start])) continue;
    let end = start;
    while (end + 1 < refs.length && inverted(refs[end + 1])) end += 1;
    const run = refs.slice(start, end + 1);
    const low = start > 0 ? refs[start - 1].to : 0;
    const lastRow = offsetsMs((rows[run[run.length - 1].row] as WhisperJsonObject).offsets);
    const high = end + 1 < refs.length ? refs[end + 1].from : lastRow?.to ?? low;
    start = end;
    if (!(high - low >= run.length)) continue;
    const ownEnds = run.every((ref, index) => ref.to > (index ? run[index - 1].to : low) && ref.to <= high);
    run.forEach((ref, index) => {
      const from = index === 0 ? low : ownEnds ? run[index - 1].to : Math.round(low + (high - low) * index / run.length);
      const to = ownEnds ? ref.to : Math.round(low + (high - low) * (index + 1) / run.length);
      transcription ??= [...rows];
      if (transcription[ref.row] === rows[ref.row]) {
        const row = rows[ref.row] as WhisperJsonObject;
        transcription[ref.row] = { ...row, tokens: [...(row.tokens as unknown[])] };
      }
      const tokens = (transcription[ref.row] as WhisperJsonObject).tokens as WhisperJsonObject[];
      const token = tokens[ref.token];
      tokens[ref.token] = { ...token, offsets: { ...(token.offsets as object), from, to } };
      retimed += 1;
    });
  }
  return transcription ? { parsed: { ...(parsed as WhisperJsonObject), transcription }, retimed } : { parsed, retimed };
}

/** Share of the recognized segments that may lie in measured silence and be dropped (one is
 *  always allowed while another remains); above it the recording is quieter than the pause
 *  threshold, and nothing is dropped. */
const SILENT_SEGMENTS_MAX_SHARE = 0.25;

/**
 * A segment recognized wholly inside a measured silence is dropped: the recognizer fills silence
 * with words never said (2026-11-23: "(字幕:J Chong)" in the last 2.5 s of silence of a talk), and
 * they would be subtitled. When more than a quarter of the segments lie in silence (beyond one), or
 * all of them, the recording is quieter than the pause threshold and nothing is dropped. Pure;
 * returns the dropped text.
 */
export function dropSegmentsHeardInSilence(parsed: unknown, silences: readonly PhraseSpan[]): { parsed: unknown; dropped: string[] } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !silences.length) return { parsed, dropped: [] };
  const rows = (parsed as WhisperJsonObject).transcription;
  if (!Array.isArray(rows)) return { parsed, dropped: [] };
  const spoken = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row) && String((row as WhisperJsonObject).text ?? '').trim());
  // Index the farthest end at each starting time. This also handles overlapping
  // or out-of-order intervals without combining adjacent, distinct silences.
  const quiet = silences.map(({ startSec, endSec }) => ({ from: startSec * 1000, to: endSec * 1000 }))
    .filter(span => !Number.isNaN(span.from) && !Number.isNaN(span.to))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < quiet.length; i += 1) quiet[i].to = Math.max(quiet[i].to, quiet[i - 1].to);
  const silent = new Set(spoken.filter((row) => {
    const time = offsetsMs((row as WhisperJsonObject).offsets);
    if (!time || time.to <= time.from) return false;
    let low = 0;
    let high = quiet.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (quiet[mid].from <= time.from + 20) low = mid + 1;
      else high = mid;
    }
    return low > 0 && time.to - 20 <= quiet[low - 1].to;
  }));
  if (!silent.size || silent.size >= spoken.length || silent.size > Math.max(1, spoken.length * SILENT_SEGMENTS_MAX_SHARE)) {
    return { parsed, dropped: [] };
  }
  return {
    parsed: { ...(parsed as WhisperJsonObject), transcription: rows.filter((row) => !silent.has(row)) },
    dropped: [...silent].map((row) => String((row as WhisperJsonObject).text).trim()),
  };
}

/** Validate emitted intervals after legitimate punctuation/subword merging.
 * A timestamp error is not a reason to rewrite words or replay recognition. */
function validTranscriptIntervals(rows: unknown, duration: number): boolean {
  if (!Array.isArray(rows)) return false;
  let previous = 0;
  return rows.every(row => {
    const r = row as { startSec: number; endSec: number };
    const valid = Number.isFinite(r.startSec) && Number.isFinite(r.endSec)
      && r.startSec >= previous && r.endSec > r.startSec && r.endSec <= duration + .001;
    previous = r.endSec; return valid;
  });
}
async function invalidTranscriptTiming(p: SpeechTranscribeOptions, transcription: WhisperJsonObject[]): Promise<VideoStudioResult> {
  const text = transcription.map(row => String(row.text).trim()).filter(Boolean).join('\n');
  let textPath: string | undefined;
  if (p.transcriptAbsPath && text) {
    await fs.mkdir(path.dirname(p.transcriptAbsPath), { recursive: true });
    const dir = await fs.mkdtemp(path.join(path.dirname(p.transcriptAbsPath), 'transcript-text-'));
    try {
      p.signal?.throwIfAborted();
      const bytes = text + '\n'; textPath = path.join(dir, 'transcript.txt');
      await fs.writeFile(textPath, bytes, { flag: 'wx' });
      await writeJson(path.join(dir, '.orkas-output-types.json'), { schema_version: 1, outputs: [{
        path: 'transcript.txt', content_type: 'audio-text', sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }] });
      p.signal?.throwIfAborted();
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
  }
  return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT', timing_valid: false,
    message: 'The transcript text was preserved, but its timestamps are invalid. Subtitles and timing-based edits are unavailable.',
    text, ...(textPath ? { text_path: textPath } : {}) };
}

/** Validate each recognition before choosing which result can replace the saved transcript. */
function prepareSpeechReading(parsed: unknown, duration: number, measuredSilences: PhraseSpan[],
  timestampDetail: 'word' | 'segment', looseTiming?: boolean) {
  // The recognizer times the last words of a recording up to its 30 s window past the end;
  // nothing is said after the audio ends, so those times end with it.
  parsed = endedWithRecording(parsed, duration * 1000) ?? parsed;
  // Lines heard in silence go before any check, so they are neither subtitled nor refused for.
  const heard = dropSegmentsHeardInSilence(parsed, measuredSilences);
  const retimed = retimeInvertedWords(heard.parsed);
  parsed = retimed.parsed;
  const transcription = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as WhisperJsonObject).transcription : undefined;
  if (!Array.isArray(transcription) || transcription.some(segment => !segment || typeof segment !== 'object'
    || Array.isArray(segment) || typeof (segment as WhisperJsonObject).text !== 'string')) {
    return { kind: 'malformed' as const };
  }
  const malformedTime = transcription.some(segment => {
    const item = segment as WhisperJsonObject, timing = offsetsMs(item.offsets);
    if (!timing || timing.from < 0 || timing.to < timing.from || (String(item.text).trim() && timing.to === timing.from)) return true;
    return Array.isArray(item.tokens) && item.tokens.some(token => {
      if (!token || typeof token !== 'object' || Array.isArray(token)) return false;
      const t = token as WhisperJsonObject;
      if (typeof t.text !== 'string' || !t.text.trim() || isWhisperSpecialToken(t.text)) return false;
      const time = offsetsMs(t.offsets);
      return !time || time.from < 0 || time.to < time.from || time.to > duration * 1000 + 1;
    });
  });
  const wordView = normalizeWhisperTranscript(parsed, 'word');
  // A word left as a point, with no room between its neighbours, has no time to show it at.
  if (looseTiming && Array.isArray(wordView.words)) {
    wordView.words = (wordView.words as Array<{ startSec: number; endSec: number }>).filter((word) => word.endSec > word.startSec);
  }
  const normalized = timestampDetail === 'word' ? wordView : normalizeWhisperTranscript(parsed, 'segment');
  if (malformedTime || !validTranscriptIntervals(normalized.segments, duration) || !validTranscriptIntervals(wordView.words, duration)) {
    return { kind: 'timing' as const, transcription: transcription as WhisperJsonObject[] };
  }
  return { kind: 'ready' as const, normalized, wordView, droppedSegments: heard.dropped.length, retimedWords: retimed.retimed };
}

export async function transcribeSpeech(p: SpeechTranscribeOptions): Promise<VideoStudioResult> {
  const backend = resolveSpeechTranscribeBackend(p.model);
  if (!backend) {
    return {
      ok: false,
      op: 'speech.transcribe',
      errorCode: 'E_TRANSCRIBE_BACKEND_MISSING',
      message: 'Speech transcription needs a bundled whisper.cpp runtime under resources/runtime/whisper or explicit ORKAS_WHISPER_CPP/ORKAS_WHISPER_MODEL paths.',
      backend_resolution: {
        checked: ['ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_CLI', 'ORKAS_WHISPER_MODEL', 'resources/runtime/whisper/current', `resources/runtime/whisper/${process.platform}-${process.arch}`],
        model_hint: p.model || '',
      },
    };
  }
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg || !bins.ffprobe) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled FFmpeg/FFprobe not found.' };
  }
  const st = await fs.stat(p.inputAbsPath).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_INPUT', message: 'input is not a file' };
  }
  // A file with no audio track is not a failed extraction — there is nothing
  // to extract. Asked to transcribe a silent clip, ffmpeg printed its version
  // banner and the input's whole metadata dump, then one final line saying
  // the output would hold no stream; the host returned the last 1200
  // characters of that as the message, so the answer was ~97% banner and the
  // reason was the tail of it (2026-08-08 run: 2135 chars of stderr, the
  // cause at offset 2107). The host can see the streams before spending the
  // run, and the caller's recovery is a different tool, not a retry.
  const probe = bins.ffprobe
    ? await probeMedia(bins.ffprobe, p.inputAbsPath, p.signal)
    : null;
  if (probe && !probe.audio) {
    return {
      ok: false,
      op: 'speech.transcribe',
      errorCode: 'E_TRANSCRIBE_NO_AUDIO_TRACK',
      message: 'This file has no audio track, so there is nothing to transcribe. '
        + 'To read what it shows, extract frames and read those instead.',
      next_action: 'read_visual_content_instead_of_transcribing',
      media: {
        ...(probe.video ? { video_codec: probe.video.codec } : {}),
        has_audio: false,
        ...(typeof probe.duration_seconds === 'number' ? { duration_seconds: probe.duration_seconds } : {}),
      },
    };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-transcribe-'));
  const wav = path.join(tmp, 'audio.wav');
  const outBase = path.join(tmp, 'transcript');
  try {
    p.onProgress?.({ phase: 'speech.transcribe.extract', message: 'Extracting mono 16 kHz audio for transcription.' });
    // silencedetect passes the audio through unchanged and logs the pauses the
    // phrase view is split at, so they cost no second decode.
    const ex = await runProcess(bins.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', p.inputAbsPath, '-vn', '-ac', '1', '-ar', '16000', '-af', PHRASE_SILENCE_FILTER, wav], { signal: p.signal, timeoutMs: 20 * 60 * 1000 });
    if (ex.code !== 0) {
      // A real extraction failure: say what happened in the caller's terms and
      // keep the tool's own words as bounded diagnostic detail, never as the
      // message. The last lines carry the cause; the banner never does.
      const stderrTail = redactPaths(ex.stderr.trim().split('\n').slice(-4).join('\n')).slice(-400);
      return {
        ok: false,
        op: 'speech.transcribe',
        errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED',
        message: 'The audio in this file could not be decoded for transcription. '
          + 'It may be corrupt or in an unsupported codec; try a re-encoded copy, '
          + 'or read the visual content instead.',
        next_action: 'retry_with_reencoded_media_or_read_visual_content',
        ...(stderrTail ? { extract_diagnostic: stderrTail } : {}),
      };
    }
    const decoded = await probeMedia(bins.ffprobe, wav, p.signal);
    const duration = decoded?.duration_seconds;
    if (!Number.isFinite(duration) || !(duration! > 0)) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED',
        message: 'The decoded audio duration could not be verified. The previous transcript was preserved.' };
    }
    p.onProgress?.({ phase: 'speech.transcribe.asr', message: 'Running Orkas-native whisper.cpp transcription.' });
    const timestampDetail = p.timestamps === 'word' ? 'word' : 'segment';
    // Always ask for word times: they cost no measurable time (2.1 s either way on a
    // 128 s podcast) and the phrase view needs them; the transcript keeps the detail
    // the caller asked for.
    const language = whisperLanguageArg(p.language);
    let prompt = language === 'zh' ? chineseTranscriptPrompt(getCurrentLang()) : undefined;
    const args = buildSpeechTranscribeArgs(backend.model, wav, outBase, {
      language: p.language,
      timestamps: 'word',
      ...(prompt ? { prompt } : {}),
    });
    const recognitionTimeoutMs = 45 * 60 * 1000;
    const recognitionDeadline = performance.now() + recognitionTimeoutMs;
    const tr = await runProcess(backend.cli, args, { signal: p.signal, timeoutMs: recognitionTimeoutMs });
    // whisper.cpp reports a language it cannot use on stderr and may still
    // exit 0 without output; name the caller's value instead of "no output".
    if (/\bunknown language\b/i.test(tr.stderr)) {
      return {
        ok: false,
        op: 'speech.transcribe',
        errorCode: 'E_TRANSCRIBE_LANGUAGE_UNSUPPORTED',
        message: `Speech transcription does not support the language "${String(p.language ?? '').trim().slice(0, 40)}". `
          + 'Use a two-letter language code such as zh or en, or auto.',
      };
    }
    if (tr.code !== 0) {
      if (isWindowsNativeRuntimeIncompatible(tr.code)) {
        return {
          ok: false,
          op: 'speech.transcribe',
          errorCode: 'E_TRANSCRIBE_RUNTIME_INCOMPATIBLE',
          message: 'The whisper.cpp runtime cannot run on this Windows machine. Reinstall the native runtime or use a CPU-compatible build.',
          backend_source: backend.source,
        };
      }
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_FAILED', message: redactPaths(tr.stderr.slice(-1200)) || 'transcriber failed' };
    }
    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_OUTPUT', message: 'transcriber produced no JSON output.' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { /* Invalid backend output is rejected before replacing a transcript. */ }
    const measuredSilences = parseSilenceLog(ex.stderr, duration!);
    const prepare = (value: unknown) => prepareSpeechReading(value, duration!, measuredSilences, timestampDetail, p.looseTiming);
    let reading = language === 'zh' ? prepare(parsed) : undefined;
    const heardLanguage = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? ((parsed as WhisperJsonObject).result as WhisperJsonObject | undefined)?.language : undefined;
    const detectedChinese = language === 'auto' && heardLanguage === 'zh';
    const invalidChineseTiming = reading?.kind === 'timing' && reading.transcription.some(row => String(row.text).trim());
    const retryTimeoutMs = detectedChinese ? recognitionTimeoutMs : Math.floor(recognitionDeadline - performance.now());
    // Retry with the opening sentence for auto-detected Chinese, or remove it when
    // explicitly requested Chinese yielded text with invalid timing.
    if ((detectedChinese || invalidChineseTiming) && retryTimeoutMs > 0) {
      p.signal?.throwIfAborted();
      const retryPrompt = detectedChinese ? chineseTranscriptPrompt(getCurrentLang()) : undefined;
      const secondBase = path.join(tmp, detectedChinese ? 'transcript-prompted' : 'transcript-unprompted');
      const retryArgs = buildSpeechTranscribeArgs(backend.model, wav, secondBase, { language: 'zh', timestamps: 'word', prompt: retryPrompt });
      const rerun = await runProcess(backend.cli, retryArgs, { signal: p.signal, timeoutMs: retryTimeoutMs });
      if (rerun.aborted) p.signal?.throwIfAborted();
      const rerunRaw = rerun.code === 0 ? await fs.readFile(`${secondBase}.json`, 'utf8').catch(() => '') : '';
      let reparsed: unknown;
      try { reparsed = rerunRaw.trim() ? JSON.parse(rerunRaw) : undefined; } catch { reparsed = undefined; }
      const candidate = prepare(reparsed);
      if (candidate.kind === 'ready' && candidate.normalized.text) {
        reading = candidate;
        prompt = retryPrompt;
      } else {
        log.warn('speech.transcribe kept the first reading of a Chinese recording', { code: rerun.code });
      }
    }
    reading ??= prepare(parsed);
    if (reading.kind === 'malformed') {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT',
        message: 'The transcription result could not be read. Try transcribing the recording again.' };
    }
    if (reading.kind === 'timing') return await invalidTranscriptTiming(p, reading.transcription);
    const { normalized, wordView, droppedSegments, retimedWords } = reading;
    if (droppedSegments || retimedWords) {
      log.info('speech.transcribe repaired recognizer output', { droppedSegments, retimedWords });
    }
    // Word times drift across pauses (2026-11-17: a false start read as the end of the sentence
    // before it and a retake cleanup kept it), so each word is moved into the measured speech it
    // was spoken in. The words, sentences and text stay as recognized.
    const placed = await placeWordsBySpanRecognition({
      backend, wavPath: wav, dir: tmp, durationSec: duration!, signal: p.signal,
      language: typeof wordView.language === 'string' && wordView.language ? wordView.language : whisperLanguageArg(p.language),
      ...(prompt ? { prompt } : {}),
      words: Array.isArray(wordView.words) ? wordView.words as PhraseWord[] : [],
      silences: measuredSilences,
    }).catch((err) => {
      if (p.signal?.aborted) throw err;
      log.warn('speech.transcribe kept recognized word times', { error: logErrorSummary(err) });
      return null;
    });
    if (placed && validTranscriptIntervals(placed, duration!)) wordView.words = placed;
    if (p.transcriptAbsPath) {
      await writeJson(p.transcriptAbsPath, normalized);
    }
    const words = Array.isArray(wordView.words) ? wordView.words as PhraseWord[] : [];
    const units = words.length ? words : (Array.isArray(normalized.segments) ? normalized.segments as PhraseWord[] : []);
    const silences = parseSilenceLog(ex.stderr);
    const phraseOpts = words.length ? {} : { segments: true };
    return {
      ok: true,
      op: 'speech.transcribe',
      // First, so it is what a capped result shows: times to cut on, split at
      // pauses measured in this audio rather than the recognizer's word gaps.
      phrases: phraseViewForResult(units, silences, phraseOpts),
      ...(p.phraseLines ? { phrase_lines: packTranscriptPhrases(units, silences, phraseOpts) } : {}),
      summary: normalized,
      transcript_path: p.transcriptAbsPath || '',
      backend: 'orkas-native:whisper.cpp',
      backend_source: backend.source,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
