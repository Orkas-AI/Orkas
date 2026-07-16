import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow, NativeImage as ElectronNativeImage } from 'electron';

import { bundledFfmpegPaths, bundledWhisperPaths } from '../util/bundled-runtime';
import { redactPaths } from '../util/redact';
import { createLogger } from '../logger';
import { writeJson } from '../storage';
import {
  ensureCompositionManifest,
  manifestAsDesignContract,
  manifestAsSceneMap,
  prepareCompositionScaffold,
  type CompositionManifest,
} from './video_studio_contract';
import {
  DRAFT_REPAIR_MAX_PASSES,
  analyzeNativeImage,
  buildDesignReviewInputs,
  buildDraftFrameSamplePlan,
  buildInspectFrameSamplePlan,
  buildPreviewFrameSamplePlan,
  compareVisualBaseline,
  initDraftRepairBudget,
  dedupeInspectIssues,
  normalizeDraftInspectIssueSeverities,
  loadDesignContract,
  loadNarrationMap,
  loadSceneMap,
  loadShotlist,
  isEnvironmentalDraftFailure,
  parseFindingsPayload,
  recordDraftFailure,
  recordDraftSuccess,
  runAudioTimingQa,
  runContractHtmlQa,
  runSourceAlignmentQa,
  runDeliveryRequirementsQa,
  samplePlanKey,
  summarizeDraftInspectDisposition,
  summarizeVideoFrameQa,
  writeFrameContactSheet,
  writeVisualBaseline,
  VIDEO_STUDIO_INSPECTOR_VERSION,
  type DraftRepairBudget,
  type FrameEvidence,
  type FrameSampleEvidence,
  type FrameSamplePlan,
  type Issue,
} from './video_studio_qa';
import { extractCssImports, extractCssUrls, extractHtmlResourceRefs, parseHtmlStructure, type HtmlResourceRef } from './video_studio_html_check';
import { hardenedWebPreferences } from '../util/window-security';

const log = createLogger('video-studio');

const COMPOSITION_LOAD_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_LOAD_TIMEOUT_MS) || 30_000;
const COMPOSITION_READY_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_READY_TIMEOUT_MS) || 20_000;
const COMPOSITION_SCRIPT_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_SCRIPT_TIMEOUT_MS) || 15_000;
const COMPOSITION_CAPTURE_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_CAPTURE_TIMEOUT_MS) || 15_000;
const COMPOSITION_RENDER_FRAME_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_RENDER_FRAME_TIMEOUT_MS) || 20_000;

export type VideoStudioOp =
  | 'production.status'
  | 'production.approve_plan'
  | 'production.approve_generation'
  | 'composition.status'
  | 'composition.doctor'
  | 'composition.reconcile'
  | 'composition.check_narration_fit'
  | 'composition.approve_plan'
  | 'composition.prepare'
  | 'composition.materialize_narration'
  | 'composition.lint'
  | 'composition.inspect'
  | 'composition.begin_visual_revision'
  | 'composition.render'
  | 'composition.draft'
  | 'composition.export'
  | 'composition.snapshot'
  | 'composition.approve_preview'
  | 'composition.submit_design_review'
  | 'composition.approve_draft'
  | 'speech.capabilities'
  | 'speech.transcribe';

export type RenderQuality = 'draft' | 'standard' | 'high';
export type RenderFormat = 'mp4' | 'webm';

export interface CompositionOptions {
  compositionDirAbs: string;
  /** Optional main-process-owned repair ledger. When omitted, direct callers
   * retain the legacy composition-local ledger used by tests and scripts. */
  repairStateAbsPath?: string;
  outputAbsPath?: string;
  reportAbsPath?: string;
  findingsAbsPath?: string;
  snapshotAbsPath?: string;
  quality?: RenderQuality;
  fps?: number;
  /** Final exports normally choose the highest safe fps for this machine.
   * Set false only when the user explicitly requires exact render settings. */
  allowFpsFallback?: boolean;
  format?: RenderFormat;
  variables?: Record<string, unknown>;
  frameEvidenceDirAbs?: string;
  frameSampleTimes?: Array<{ label: string; timeSec: number; sceneId?: string }>;
  visualBaselineAbsPath?: string;
  updateVisualBaseline?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export interface SpeechTranscribeOptions {
  inputAbsPath: string;
  transcriptAbsPath?: string;
  model?: string;
  language?: string;
  timestamps?: 'segment' | 'word';
  allowModelDownload?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export type VideoStudioResult =
  | { ok: true; op: VideoStudioOp; [key: string]: unknown }
  | { ok: false; op?: VideoStudioOp; errorCode: string; message: string; [key: string]: unknown };

type AudioTrack = {
  absPath: string;
  startSec: number;
  declaredDurationSec?: number;
  volume: number;
};

type CompositionMeta = {
  htmlPath: string;
  html: string;
  rootAttrs: Record<string, string>;
  id: string;
  width: number;
  height: number;
  durationSec: number;
  audioTracks: AudioTrack[];
};

type MediaProbe = {
  duration_seconds: number | null;
  size_bytes: number | null;
  video?: {
    codec: string;
    width?: number;
    height?: number;
    duration_seconds?: number;
    avg_frame_rate?: string;
  };
  audio?: {
    codec: string;
    duration_seconds?: number;
    bit_rate?: number;
  };
};

type NativeRenderProfile = {
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
  previous_observed_capture_fps?: number;
  previous_realtime_factor?: number;
  frame_pipeline?: 'raw_bgra_pipe';
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

type LoudnessReport = {
  ok: boolean;
  input_i: number | null;
  input_tp: number | null;
  input_lra: number | null;
  target_i: number;
  target_tp: number;
  target_lra: number;
  normalized?: unknown;
  raw_tail?: string;
  error?: string;
};

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_DURATION_SEC = 5;
const MAX_RENDER_DURATION_SEC = 20 * 60;
const MAX_FPS = 60;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
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

function isKnownBundledVendorRef(ref: string): boolean {
  return normalizedLocalRefPath(ref) === 'assets/vendor/gsap.min.js';
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

function builtinGsapVendorCandidates(): string[] {
  const agentRel = path.join(
    'marketplace',
    'agents',
    VIDEO_STUDIO_AGENT_ID,
    'skills',
    'stage-compose',
    'scripts',
    'vendor',
    'gsap.min.js',
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
  if (!isKnownBundledVendorRef(ref)) return { ok: false, code: 'LOCAL_VENDOR_UNKNOWN' };
  const source = builtinGsapVendorCandidates().find((candidate) => isFileSync(candidate));
  if (!source) return { ok: false, code: 'VENDOR_GSAP_SOURCE_MISSING' };
  const sourceIssue = gsapVendorCompatibilityIssue(await fs.readFile(source, 'utf8').catch(() => ''));
  if (sourceIssue) return { ok: false, code: 'VENDOR_GSAP_SOURCE_INCOMPATIBLE', missing: sourceIssue.missing };
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  await fs.copyFile(source, targetAbsPath);
  return { ok: true };
}

async function validateKnownBundledVendor(ref: string, targetAbsPath: string): Promise<Issue | null> {
  if (!isKnownBundledVendorRef(ref)) return null;
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

function findingsJson(issues: Issue[], extra: Record<string, unknown> = {}): string {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return JSON.stringify({
    ok: errorCount === 0,
    errorCount,
    warningCount,
    issueCount: issues.length,
    totalIssueCount: issues.length,
    issues,
    ...extra,
  }, null, 2);
}

function qualityFps(quality: RenderQuality | undefined, fps: number | undefined): number {
  if (isFinitePositive(fps)) return Math.max(1, Math.min(MAX_FPS, Math.floor(fps)));
  if (quality === 'draft') return 15;
  return 30;
}

function machineRamGB(): number {
  const mocked = Number(process.env.ORKAS_MOCK_RAM_GB);
  if (Number.isFinite(mocked) && mocked > 0) return Math.round(mocked * 10) / 10;
  return Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
}

function renderProfilePath(compositionDirAbs: string): string {
  return path.join(path.resolve(compositionDirAbs, '..', 'render'), '.render-profile.json');
}

type PersistedRenderProfile = {
  gpuMode?: 'hardware' | 'software';
  lastRender?: {
    observed_capture_fps?: number;
    observed_realtime_factor?: number;
  };
};

async function readObservedRenderProfile(compositionDirAbs: string): Promise<PersistedRenderProfile> {
  const mocked = process.env.ORKAS_MOCK_OBSERVED_GPU_MODE;
  if (mocked === 'hardware' || mocked === 'software') return { gpuMode: mocked };
  try {
    const parsed = JSON.parse(await fs.readFile(renderProfilePath(compositionDirAbs), 'utf8')) as PersistedRenderProfile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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

async function persistObservedRenderProfile(compositionDirAbs: string, profile: NativeRenderProfile): Promise<void> {
  const out = renderProfilePath(compositionDirAbs);
  const persisted = await readObservedRenderProfile(compositionDirAbs);
  const gpuMode = profile.observed_gpu_mode || persisted.gpuMode;
  const value = {
    version: 1,
    updated_at: new Date().toISOString(),
    ...(gpuMode ? { gpuMode } : {}),
    lastRender: {
      observed_capture_fps: profile.observed_capture_fps,
      observed_realtime_factor: profile.observed_realtime_factor,
      capture_pipeline_seconds: profile.capture_pipeline_seconds,
      encoder_finalize_seconds: profile.encoder_finalize_seconds,
      total_render_seconds: profile.total_render_seconds,
      frame_pipeline: profile.frame_pipeline,
      frame_bytes_streamed: profile.frame_bytes_streamed,
      temporary_frame_bytes: profile.temporary_frame_bytes,
    },
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(value, null, 2), 'utf8');
}

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

async function resolveNativeRenderProfile(
  compositionDirAbs: string,
  meta: CompositionMeta,
  quality: RenderQuality | undefined,
  requestedFps: number,
  allowFpsFallback: boolean,
): Promise<NativeRenderProfile> {
  const ramGB = machineRamGB();
  const observed = await readObservedRenderProfile(compositionDirAbs);
  const observedGpuMode = await observeElectronGpuMode() || observed.gpuMode;
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
    ...(positiveNumber(observed.lastRender?.observed_capture_fps)
      ? { previous_observed_capture_fps: round2(Number(observed.lastRender?.observed_capture_fps)) }
      : {}),
    ...(positiveNumber(observed.lastRender?.observed_realtime_factor)
      ? { previous_realtime_factor: round2(Number(observed.lastRender?.observed_realtime_factor)) }
      : {}),
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

function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nullablePositiveNumber(value: unknown): number | null {
  return positiveNumber(value) ?? null;
}

async function probeMedia(ffprobe: string, mediaAbsPath: string, signal?: AbortSignal): Promise<MediaProbe | null> {
  const r = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,duration,bit_rate,avg_frame_rate',
    '-of', 'json',
    mediaAbsPath,
  ], { signal, timeoutMs: FFPROBE_TIMEOUT_MS });
  if (r.aborted || r.timedOut || r.code !== 0) return null;

  let parsed: {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
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
    duration_seconds: nullablePositiveNumber(parsed.format?.duration),
    size_bytes: nullablePositiveNumber(parsed.format?.size),
    ...(video ? {
      video: {
        codec: video.codec_name || '',
        width: positiveNumber(video.width),
        height: positiveNumber(video.height),
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

async function loadCompositionMeta(compositionDirAbs: string): Promise<{ meta: CompositionMeta | null; issues: Issue[] }> {
  const issues: Issue[] = [];
  const htmlPath = path.join(compositionDirAbs, 'index.html');
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
            : 'Use the built-in stage-compose vendor path assets/vendor/gsap.min.js or remove the runtime dependency.',
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

type CompositionPreflightResult = {
  ok: boolean;
  meta: CompositionMeta | null;
  manifest: CompositionManifest | null;
  contractLoad: Awaited<ReturnType<typeof loadDesignContract>>;
  sceneMapLoad: Awaited<ReturnType<typeof loadSceneMap>>;
  narrationMapLoad: Awaited<ReturnType<typeof loadNarrationMap>>;
  shotlistLoad: Awaited<ReturnType<typeof loadShotlist>>;
  steps: Record<string, unknown>;
  issues: Issue[];
  report: Record<string, unknown>;
};

function stepIssues(step: Record<string, unknown>): Issue[] {
  return Array.isArray(step.issues) ? step.issues.filter((issue): issue is Issue => !!issue && typeof issue === 'object') : [];
}

export async function preflightComposition(p: CompositionOptions): Promise<CompositionPreflightResult> {
  const manifestLoad = await ensureCompositionManifest(p.compositionDirAbs, { writeGenerated: true });
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  const legacyContractLoad = await loadDesignContract(p.compositionDirAbs);
  const narrationMapLoad = await loadNarrationMap(p.compositionDirAbs);
  const shotlistLoad = await loadShotlist(p.compositionDirAbs);
  const manifestIssues = manifestLoad.issues as Issue[];
  if (!manifestLoad.manifest || !loaded.meta) {
    const issues = [...manifestIssues, ...loaded.issues];
    const blockingErrorCount = issues.filter((issue) => issue.severity === 'error').length;
    const report = {
      status: 'failed',
      stage: 'preflight',
      blocking_error_count: blockingErrorCount,
      advisory_count: issues.filter((issue) => issue.severity === 'warning').length,
      manifest: {
        path: manifestLoad.manifestPath,
        source: manifestLoad.source,
        written: manifestLoad.wroteManifest,
      },
      issues,
      next_allowed_ops: ['composition.prepare'],
    };
    return {
      ok: false,
      meta: loaded.meta,
      manifest: null,
      contractLoad: legacyContractLoad,
      sceneMapLoad: await loadSceneMap(p.compositionDirAbs),
      narrationMapLoad,
      shotlistLoad,
      steps: { manifest: report.manifest },
      issues,
      report,
    };
  }

  const manifest = manifestLoad.manifest;
  const canonicalContractLoad = {
    path: manifestLoad.manifestPath,
    exists: true,
    value: manifestAsDesignContract(manifest, null),
  };
  const canonicalSceneMapLoad = {
    path: manifestLoad.manifestPath,
    exists: true,
    value: manifestAsSceneMap(manifest),
  };
  const contractHtml = await runContractHtmlQa(
    loaded.meta,
    loaded.issues,
    canonicalContractLoad,
    canonicalSceneMapLoad,
    p.compositionDirAbs,
  );
  const sourceAlignment = await runSourceAlignmentQa(canonicalSceneMapLoad, shotlistLoad);
  const deliveryRequirements = await runDeliveryRequirementsQa(
    loaded.meta,
    canonicalSceneMapLoad,
    shotlistLoad,
    p.compositionDirAbs,
  );
  const audioTiming = await runAudioTimingQa(
    loaded.meta,
    canonicalContractLoad,
    canonicalSceneMapLoad,
    narrationMapLoad,
    p.compositionDirAbs,
  );
  const steps = {
    manifest: {
      ok: manifestLoad.ok,
      path: manifestLoad.manifestPath,
      source: manifestLoad.source,
      written: manifestLoad.wroteManifest,
      issues: manifestIssues,
    },
    contract_html: contractHtml,
    source_alignment: sourceAlignment,
    delivery_requirements: deliveryRequirements,
    audio_timing: audioTiming,
  };
  const issues = [
    ...manifestIssues,
    ...stepIssues(contractHtml),
    ...stepIssues(sourceAlignment),
    ...stepIssues(deliveryRequirements),
    ...stepIssues(audioTiming),
  ];
  const blockingErrorCount = issues.filter((issue) => issue.severity === 'error').length;
  const report = {
    status: blockingErrorCount ? 'failed' : 'passed',
    stage: 'preflight',
    blocking_error_count: blockingErrorCount,
    advisory_count: issues.filter((issue) => issue.severity === 'warning').length,
    manifest: steps.manifest,
    steps,
    issues,
    next_allowed_ops: blockingErrorCount
      ? ['composition.prepare']
      : ['composition.inspect', 'composition.snapshot', 'composition.draft'],
  };
  return {
    ok: blockingErrorCount === 0,
    meta: loaded.meta,
    manifest,
    contractLoad: canonicalContractLoad,
    sceneMapLoad: canonicalSceneMapLoad,
    narrationMapLoad,
    shotlistLoad,
    steps,
    issues,
    report,
  };
}

export async function prepareComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const prepared = await prepareCompositionScaffold(p.compositionDirAbs);
  if (!prepared.ok) {
    return {
      ok: false,
      op: 'composition.prepare',
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: prepared.issues.find((issue) => issue.severity === 'error')?.message || 'Composition manifest is invalid.',
      status: 'failed',
      stage: 'manifest',
      blocking_error_count: prepared.issues.filter((issue) => issue.severity === 'error').length,
      issues: prepared.issues,
      next_allowed_ops: ['composition.prepare'],
    };
  }
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  const issues = [...prepared.issues, ...loaded.issues];
  const blockingErrorCount = issues.filter((issue) => issue.severity === 'error').length;
  if (!loaded.meta || blockingErrorCount > 0) {
    return {
      ok: false,
      op: 'composition.prepare',
      errorCode: 'E_COMPOSITION_SCAFFOLD_INVALID',
      message: issues.find((issue) => issue.severity === 'error')?.message || 'Composition scaffold could not be prepared.',
      status: 'failed',
      stage: 'scaffold',
      blocking_error_count: blockingErrorCount,
      manifest_path: prepared.manifest_path,
      html_path: prepared.html_path,
      scaffold_created: prepared.scaffold_created,
      issues,
      next_allowed_ops: ['composition.prepare'],
    };
  }
  return {
    ok: true,
    op: 'composition.prepare',
    status: 'passed',
    stage: 'manifest',
    manifest_path: prepared.manifest_path,
    manifest_source: prepared.manifest_source,
    manifest_written: prepared.manifest_written,
    html_path: prepared.html_path,
    scaffold_created: prepared.scaffold_created,
    blocking_error_count: 0,
    issues,
    next_allowed_ops: ['composition.lint', 'composition.inspect', 'composition.snapshot'],
  };
}

export async function lintComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const preflight = await preflightComposition(p);
  const findings = findingsJson(preflight.issues, {
    engine: 'orkas-native',
    profile: 'orkas-html-composition',
    canvas: preflight.meta ? { width: preflight.meta.width, height: preflight.meta.height, durationSec: preflight.meta.durationSec } : null,
    preflight: preflight.report,
  });
  if (!preflight.ok) {
    return {
      ok: false,
      op: 'composition.lint',
      errorCode: 'E_PREFLIGHT_BLOCKED',
      message: preflight.issues.find((issue) => issue.severity === 'error')?.message || 'Composition preflight failed.',
      status: 'failed',
      stage: 'preflight',
      blocking_error_count: preflight.issues.filter((issue) => issue.severity === 'error').length,
      preflight: preflight.report,
      findings,
      next_allowed_ops: ['composition.prepare'],
    };
  }
  return {
    ok: true,
    op: 'composition.lint',
    status: 'passed',
    stage: 'preflight',
    blocking_error_count: 0,
    preflight: preflight.report,
    findings,
    next_allowed_ops: ['composition.inspect', 'composition.snapshot', 'composition.draft'],
  };
}

function fileUrl(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).toString();
}

export const compositionFileUrlForTest = fileUrl;

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

export function isCompositionRequestUrlAllowed(requestUrl: string, compositionDirAbs: string): boolean {
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
    return pathInsideOrEqual(fileURLToPath(parsed), compositionDirAbs);
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

function videoStudioErrorCode(err: unknown, fallback: string): string {
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

async function withCompositionWindow<T>(
  meta: CompositionMeta,
  p: CompositionOptions,
  fn: (win: ElectronBrowserWindow) => Promise<T>,
): Promise<T> {
  const electron = await import('electron');
  const { BrowserWindow, session } = electron;
  if (!BrowserWindow) throw new Error('Electron BrowserWindow unavailable');
  const partition = `video-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    if (!isCompositionRequestUrlAllowed(url, p.compositionDirAbs)) {
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
    backgroundColor: '#000000',
    webPreferences: hardenedWebPreferences({
      session: ses,
    }),
  });
  try {
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
      win.webContents.executeJavaScript(buildTimelineAdapterScript(meta, p.variables), true),
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

function buildTimelineAdapterScript(meta: CompositionMeta, variables?: Record<string, unknown>): string {
  const vars = JSON.stringify(variables || {});
  return `
(() => {
  const root = document.querySelector('[data-composition-id]') || document.body;
  const compositionId = root && root.getAttribute ? (root.getAttribute('data-composition-id') || ${JSON.stringify(meta.id)}) : ${JSON.stringify(meta.id)};
  const variables = ${vars};
  window.__ORKAS_VIDEO_VARIABLES__ = variables;
  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function pauseMedia() {
    for (const media of Array.from(document.querySelectorAll('audio,video'))) {
      try { media.pause(); } catch {}
    }
  }
  async function seekMedia(t) {
    const mediaEls = Array.from(document.querySelectorAll('audio,video'));
    await Promise.all(mediaEls.map((media) => new Promise((resolve) => {
      const start = num(media.getAttribute('data-start'), 0);
      const local = Math.max(0, t - start);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        media.pause();
        if (Number.isFinite(media.duration) && Math.abs(media.currentTime - local) > 0.04) {
          media.addEventListener('seeked', finish, { once: true });
          media.currentTime = Math.min(local, Math.max(0, media.duration || local));
          setTimeout(finish, 1000);
        } else {
          finish();
        }
      } catch {
        finish();
      }
    })));
  }
  function seekTimelines(t) {
    const timelines = window.__timelines || {};
    const tl = timelines[compositionId] || timelines.main || timelines.root;
    if (!tl) return false;
    try {
      if (typeof tl.pause === 'function') tl.pause();
      if (typeof tl.seek === 'function') { tl.seek(t, false); return true; }
      if (typeof tl.time === 'function') { tl.time(t, false); return true; }
      if (typeof tl.progress === 'function' && typeof tl.duration === 'function') {
        const dur = Number(tl.duration()) || ${meta.durationSec};
        tl.progress(dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 0, false);
        return true;
      }
    } catch {}
    return false;
  }
  function seekWebAnimations(t) {
    try {
      for (const anim of document.getAnimations({ subtree: true })) {
        try {
          anim.pause();
          anim.currentTime = Math.max(0, t * 1000);
        } catch {}
      }
    } catch {}
  }
  function applyTimedVisibility(t) {
    for (const el of Array.from(document.querySelectorAll('[data-start], [data-duration]'))) {
      if (el === root) continue;
      const start = num(el.getAttribute('data-start'), 0);
      const dur = num(el.getAttribute('data-duration'), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(dur)) continue;
      const visible = t >= start && t <= start + dur;
      if (el.classList && el.classList.contains('clip')) {
        el.style.visibility = visible ? '' : 'hidden';
      }
    }
  }
  window.__ORKAS_VIDEO__ = window.__ORKAS_VIDEO__ || {};
  window.__ORKAS_VIDEO__.duration = ${meta.durationSec};
  window.__ORKAS_VIDEO__.seek = async (t) => {
    pauseMedia();
    const usedTimeline = seekTimelines(t);
    seekWebAnimations(t);
    if (!usedTimeline) applyTimedVisibility(t);
    await seekMedia(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  pauseMedia();
})()
`;
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

async function seek(win: ElectronBrowserWindow, tSec: number): Promise<void> {
  await withVideoStudioTimeout(win.webContents.executeJavaScript(`
(async () => {
  if (window.__ORKAS_VIDEO__ && typeof window.__ORKAS_VIDEO__.seek === 'function') {
    await window.__ORKAS_VIDEO__.seek(${JSON.stringify(tSec)});
  }
})()
`, true), COMPOSITION_SCRIPT_TIMEOUT_MS, 'E_COMPOSITION_SEEK_TIMEOUT', `composition seek timed out at ${round2(tSec)}s.`, () => {
    try { win.destroy(); } catch { /* best effort */ }
  });
}

async function readFrameSemanticEvidence(win: ElectronBrowserWindow): Promise<{
  visible_scene_ids: string[];
  visible_roles: string[];
  visible_text: string;
}> {
  return await withVideoStudioTimeout(win.webContents.executeJavaScript(`
(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    let node = el;
    let opacity = 1;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      opacity *= Number(style.opacity || 1);
      if (opacity <= 0.01) return false;
      node = node.parentElement;
    }
    return true;
  };
  const scenes = Array.from(document.querySelectorAll('[data-scene-id]'))
    .filter(visible)
    .map((el) => String(el.getAttribute('data-scene-id') || '').trim())
    .filter(Boolean);
  const roleEls = Array.from(document.querySelectorAll('[data-role]')).filter(visible);
  const roles = roleEls
    .map((el) => String(el.getAttribute('data-role') || '').trim())
    .filter(Boolean);
  const text = roleEls
    .map((el) => String(el.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
  return {
    visible_scene_ids: [...new Set(scenes)],
    visible_roles: [...new Set(roles)],
    visible_text: text,
  };
})()
`, true) as Promise<{ visible_scene_ids: string[]; visible_roles: string[]; visible_text: string }>,
  COMPOSITION_SCRIPT_TIMEOUT_MS,
  'E_SEMANTIC_EVIDENCE_TIMEOUT',
  'composition semantic evidence collection timed out.');
}

function sampleTimes(durationSec: number): number[] {
  const dur = Math.max(0.1, durationSec);
  return [...new Set([0, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.05)].map((n) => round2(n)))];
}

export async function inspectComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const preflight = await preflightComposition(p);
  if (!preflight.ok || !preflight.meta) {
    const result = {
      ok: false,
      op: 'composition.inspect',
      errorCode: 'E_PREFLIGHT_BLOCKED',
      message: preflight.issues.find((issue) => issue.severity === 'error')?.message || 'Composition preflight failed.',
      status: 'failed',
      stage: 'preflight',
      blocking_error_count: preflight.issues.filter((issue) => issue.severity === 'error').length,
      preflight: preflight.report,
      findings: findingsJson(preflight.issues),
      next_allowed_ops: ['composition.prepare'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
  const meta = preflight.meta;
  const issues: Issue[] = [...preflight.issues];
  const samplePlans = buildInspectFrameSamplePlan(meta, preflight.sceneMapLoad.value, 30);
  const samples = samplePlans.map((plan) => plan.timeSec);
  try {
    await withCompositionWindow(meta, p, async (win) => {
      for (const plan of samplePlans) {
        await seek(win, plan.timeSec);
        const sampleIssues = await withVideoStudioTimeout(
          win.webContents.executeJavaScript(buildInspectScript(meta, plan.timeSec, plan.sceneId), true) as Promise<Issue[]>,
          COMPOSITION_SCRIPT_TIMEOUT_MS,
          'E_INSPECT_TIMEOUT',
          `composition inspect timed out at ${round2(plan.timeSec)}s.`,
          () => { try { win.destroy(); } catch { /* best effort */ } },
        );
        issues.push(...sampleIssues);
      }
    });
  } catch (err) {
    issues.push({
      code: err instanceof VideoStudioTimeoutError ? 'INSPECT_RENDERER_TIMEOUT' : 'INSPECT_RENDERER_FAILED',
      severity: 'error',
      selector: 'document',
      message: (err as Error).message,
      source: 'orkas-native',
    });
  }
  const normalizedIssues = dedupeInspectIssues(normalizeDraftInspectIssueSeverities(issues));
  const findings = findingsJson(normalizedIssues, {
    engine: 'orkas-native',
    inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
    samples,
    sample_plan: samplePlans,
    canvas: { width: meta.width, height: meta.height, durationSec: meta.durationSec },
    preflight: preflight.report,
  });
  const disposition = summarizeDraftInspectDisposition(findings);
  const blockingErrorCount = Number(disposition.blocking_error_count || 0);
  const fatalErrorCount = Number(disposition.fatal_error_count || 0);
  if (fatalErrorCount > 0) {
    const result = {
      ok: false,
      op: 'composition.inspect',
      errorCode: 'E_INSPECT_BLOCKED',
      message: normalizedIssues.find((issue) => issue.severity === 'error')?.message || 'Composition inspect failed.',
      status: 'failed',
      stage: 'runtime_probe',
      blocking_error_count: blockingErrorCount,
      fatal_error_count: fatalErrorCount,
      preflight: preflight.report,
      findings,
      next_allowed_ops: ['composition.lint', 'composition.inspect'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
  if (blockingErrorCount > 0) {
    const result = {
      ok: true,
      op: 'composition.inspect',
      status: 'review_required',
      stage: 'runtime_probe',
      message: 'Visual QA found high-confidence layout defects. Preview capture is allowed so the user can inspect the evidence, but preview approval and final rendering remain blocked until repaired.',
      blocking_error_count: blockingErrorCount,
      fatal_error_count: 0,
      visual_review_required: true,
      preview_capture_allowed: true,
      preflight: preflight.report,
      findings,
      inspect_disposition: disposition,
      next_allowed_ops: ['composition.snapshot'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
  const result = {
    ok: true,
    op: 'composition.inspect',
    status: 'passed',
    stage: 'runtime_probe',
    blocking_error_count: 0,
    fatal_error_count: 0,
    preflight: preflight.report,
    findings,
    next_allowed_ops: ['composition.snapshot', 'composition.draft'],
  } as VideoStudioResult;
  await writeJsonIfRequested(p.findingsAbsPath, result);
  return result;
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
    const m = /rgba?\\(([^)]+)\\)/i.exec(String(value || ''));
    if (!m) return null;
    const parts = m[1].split(',').map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
    if (alpha <= 0.03) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  };
  const bgColorFor = (el) => {
    let cur = el;
    while (cur) {
      const c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c) return c;
      cur = cur.parentElement;
    }
    return { r: 0, g: 0, b: 0, a: 1 };
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
      if (Number.isFinite(fs) && fs > 0 && fs < 18) {
        add('FONT_TOO_SMALL', 'warning', 'high', el, 'text is below the 18px legibility floor.', { ...rectEvidence, font_size_px: round(fs), minimum_px: 18 });
      }
      if (rect.left < safeX || rect.top < safeY || rect.right > width - safeX || rect.bottom > height - safeY) {
        add('SAFE_AREA_VIOLATION', 'warning', 'medium', el, 'readable text sits near the video edge or platform-safe area.', { ...rectEvidence, safe_area: { x: round(safeX), y: round(safeY) } });
      }
      if (text.length > 180 || (text.length > 110 && rect.height > height * 0.32)) {
        add('TEXT_DENSITY_HIGH', 'warning', 'low', el, 'text block is dense for phone-size video review.', { ...rectEvidence, character_count: text.length });
      }
      const fg = parseColor(style.color);
      const bg = bgColorFor(el.parentElement || el);
      if (fg && bg) {
        const ratio = contrastRatio(fg, bg);
        const minRatio = fs >= 32 ? 3 : 4.5;
        if (ratio < minRatio) {
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

export async function snapshotComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  if (!p.snapshotAbsPath) {
    return { ok: false, op: 'composition.snapshot', errorCode: 'E_OUTPUT_REQUIRED', message: 'snapshot output path is required.' };
  }
  const preflight = await preflightComposition(p);
  if (!preflight.ok || !preflight.meta || !preflight.manifest) {
    const result = {
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREFLIGHT_BLOCKED',
      message: preflight.issues.find((issue) => issue.severity === 'error')?.message || 'Composition preflight failed.',
      status: 'failed',
      stage: 'preflight',
      blocking_error_count: preflight.issues.filter((issue) => issue.severity === 'error').length,
      preflight: preflight.report,
      next_allowed_ops: ['composition.prepare', 'composition.inspect'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
  const meta = preflight.meta;
  const manifest = preflight.manifest;
  const inspect = await inspectComposition({ ...p, findingsAbsPath: undefined });
  const inspectDisposition = summarizeDraftInspectDisposition(String(inspect.findings || ''));
  const fatalInspectCount = Number(inspectDisposition.fatal_error_count || 0);
  if (inspect.ok === false || fatalInspectCount > 0) {
    const result = {
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREVIEW_FATAL_QA_BLOCKED',
      message: 'Preview capture is blocked by a fatal runtime or structural inspection error. Repair the runtime contract before capturing frames.',
      status: 'failed',
      stage: 'runtime_probe',
      blocking_error_count: Number(inspectDisposition.blocking_error_count || inspect.blocking_error_count || 1),
      fatal_error_count: Math.max(1, fatalInspectCount),
      preflight: preflight.report,
      findings: inspect.findings,
      inspect_disposition: inspectDisposition,
      preview_ready: false,
      next_allowed_ops: ['composition.inspect'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
  await fs.mkdir(path.dirname(p.snapshotAbsPath), { recursive: true });
  try {
    const plans: FrameSamplePlan[] = p.frameSampleTimes?.length
      ? p.frameSampleTimes.map((item) => ({
        label: samplePlanKey(item.label),
        timeSec: Math.max(0, Math.min(meta.durationSec - 0.001, item.timeSec)),
        frameIndex: Math.max(0, Math.floor(item.timeSec * 30)),
        ...(item.sceneId ? { sceneId: item.sceneId } : {}),
      }))
      : buildPreviewFrameSamplePlan(meta, preflight.sceneMapLoad.value, 30);
    const snapshotStem = path.basename(p.snapshotAbsPath, path.extname(p.snapshotAbsPath));
    const evidenceDirAbs = p.frameEvidenceDirAbs
      || path.join(path.dirname(p.snapshotAbsPath), `${snapshotStem}-frames`);
    await fs.mkdir(evidenceDirAbs, { recursive: true });
    const capturedSamples: FrameSampleEvidence[] = [];
    await withCompositionWindow(meta, p, async (win) => {
      for (const [index, plan] of plans.entries()) {
        await seek(win, plan.timeSec);
        const semanticEvidence = await readFrameSemanticEvidence(win);
        const capturedImage = await withVideoStudioTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: meta.width, height: meta.height }),
          COMPOSITION_CAPTURE_TIMEOUT_MS,
          'E_SNAPSHOT_TIMEOUT',
          `composition snapshot timed out while capturing preview frame ${index + 1}/${plans.length}.`,
          () => { try { win.destroy(); } catch { /* best effort */ } },
        );
        const normalizedCapture = normalizeCapturedFrame(capturedImage, meta.width, meta.height);
        const image = normalizedCapture.image;
        const png = image.toPNG();
        if (index === 0) await fs.writeFile(p.snapshotAbsPath!, png);
        const samplePath = path.join(evidenceDirAbs, `${String(index + 1).padStart(2, '0')}-${plan.label}.png`);
        await fs.writeFile(samplePath, png);
        capturedSamples.push({
          label: plan.label,
          time_seconds: round2(plan.timeSec),
          frame_index: plan.frameIndex,
          path: samplePath,
          ...(plan.sceneId ? { expected_scene_id: plan.sceneId } : {}),
          capture_source_width: normalizedCapture.sourceWidth,
          capture_source_height: normalizedCapture.sourceHeight,
          capture_scale_factor: normalizedCapture.scaleFactor,
          ...semanticEvidence,
          ...analyzeNativeImage(image),
        });
        p.onProgress?.({
          phase: 'composition.snapshot.capture',
          message: `Captured preview frame ${index + 1}/${plans.length}.`,
          data: { frame: index + 1, totalFrames: plans.length, timeSec: plan.timeSec },
        });
      }
    });
    const contactSheet = await writeFrameContactSheet(evidenceDirAbs, capturedSamples);
    const frameEvidence: FrameEvidence = {
      evidence_dir: evidenceDirAbs,
      contact_sheet: contactSheet,
      frame_paths: capturedSamples.map((sample) => sample.path),
      samples: capturedSamples,
    };
    const baselineAbsPath = p.visualBaselineAbsPath || path.join(p.compositionDirAbs, 'qa', 'visual-baseline.json');
    const visualRegression = p.updateVisualBaseline
      ? {
        ok: true,
        skipped: false,
        status: 'updated',
        changed: false,
        baseline_path: await writeVisualBaseline(baselineAbsPath, frameEvidence),
        issues: [],
      }
      : await compareVisualBaseline(baselineAbsPath, frameEvidence);
    const designReviewInputs = buildDesignReviewInputs({
      contractLoad: preflight.contractLoad,
      sceneMapLoad: preflight.sceneMapLoad,
      contractHtml: preflight.steps.contract_html as Record<string, unknown>,
      frameEvidence,
      visualRegression,
    });
    const previewQa = summarizeVideoFrameQa(frameEvidence, meta.durationSec, {
      sceneCount: manifest.scenes.length,
      expectedSceneIds: manifest.scenes.map((scene) => scene.id),
      requireSemanticCoverage: true,
    });
    const st = await fs.stat(p.snapshotAbsPath);
    if (previewQa.ok === false) {
      const result = {
        ok: false,
        op: 'composition.snapshot',
        errorCode: 'E_PREVIEW_QA_BLOCKED',
        message: 'Preview frame coverage or scene semantics failed QA.',
        status: 'failed',
        stage: 'preview',
        blocking_error_count: Number(previewQa.error_count || 0),
        path: p.snapshotAbsPath,
        first_frame: p.snapshotAbsPath,
        artifact_type: 'first_frame',
        bytes: st.size,
        contact_sheet: contactSheet,
        frame_paths: frameEvidence.frame_paths,
        frame_evidence: frameEvidence,
        preview_qa: previewQa,
        preflight: preflight.report,
        visual_regression: visualRegression,
        design_review_inputs: designReviewInputs,
        preview_ready: false,
        next_allowed_ops: ['composition.inspect'],
      } as VideoStudioResult;
      await writeJsonIfRequested(p.findingsAbsPath, result);
      return result;
    }
    const visualBlockingCount = Number(inspectDisposition.blocking_error_count || 0);
    if (visualBlockingCount > 0) {
      const reviewQa = {
        ...previewQa,
        ok: false,
        error_count: visualBlockingCount,
        status: 'visual_review_required',
        issues: inspectDisposition.blocking_issues,
      };
      const result = {
        ok: false,
        op: 'composition.snapshot',
        errorCode: 'E_PREVIEW_DESIGN_QA_BLOCKED',
        message: 'Preview frames were captured, but high-confidence visual layout defects still require repair before preview approval or final rendering.',
        status: 'review_required',
        stage: 'preview',
        blocking_error_count: visualBlockingCount,
        fatal_error_count: 0,
        path: p.snapshotAbsPath,
        first_frame: p.snapshotAbsPath,
        artifact_type: 'first_frame',
        bytes: st.size,
        contact_sheet: contactSheet,
        frame_paths: frameEvidence.frame_paths,
        frame_evidence: frameEvidence,
        preview_qa: reviewQa,
        inspect_disposition: inspectDisposition,
        preflight: preflight.report,
        visual_regression: visualRegression,
        design_review_inputs: designReviewInputs,
        preview_ready: false,
        preview_captured: true,
        next_allowed_ops: ['composition.inspect'],
      } as VideoStudioResult;
      await writeJsonIfRequested(p.findingsAbsPath, result);
      return result;
    }
    const result = {
      ok: true,
      op: 'composition.snapshot',
      status: 'passed',
      stage: 'preview',
      blocking_error_count: 0,
      path: p.snapshotAbsPath,
      first_frame: p.snapshotAbsPath,
      artifact_type: 'first_frame',
      bytes: st.size,
      contact_sheet: contactSheet,
      frame_paths: frameEvidence.frame_paths,
      frame_evidence: frameEvidence,
      preview_qa: previewQa,
      preflight: preflight.report,
      visual_regression: visualRegression,
      design_review_inputs: designReviewInputs,
      preview_ready: true,
      next_allowed_ops: ['composition.approve_preview'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      op: 'composition.snapshot',
      errorCode: videoStudioErrorCode(err, 'E_SNAPSHOT_FAILED'),
      message: (err as Error).message,
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
}

export async function renderComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: false, op: 'composition.render', errorCode: 'E_COMPOSITION_INVALID', message: loaded.issues[0]?.message || 'composition invalid' };
  }
  const blocking = loaded.issues.filter((i) => i.severity === 'error');
  if (blocking.length) {
    return { ok: false, op: 'composition.render', errorCode: 'E_LINT_BLOCKED', message: blocking[0].message, findings: findingsJson(loaded.issues) };
  }
  if (!p.outputAbsPath) {
    return { ok: false, op: 'composition.render', errorCode: 'E_OUTPUT_REQUIRED', message: 'output path is required.' };
  }
  const requestedFps = qualityFps(p.quality, p.fps);
  const renderProfile = await resolveNativeRenderProfile(
    p.compositionDirAbs,
    loaded.meta,
    p.quality,
    requestedFps,
    p.allowFpsFallback !== false,
  );
  if (renderProfile.decision === 'fail_fast') {
    return {
      ok: false,
      op: 'composition.render',
      errorCode: 'E_RENDER_TOO_HEAVY',
      message: `This ${loaded.meta.width}x${loaded.meta.height}, ${Math.round(loaded.meta.durationSec)}s composition cannot be rendered at ${p.quality || 'standard'} quality on this constrained machine without likely hanging. No safe automatic fps fallback satisfies the requested settings; report the delivery constraint without reopening a content approval gate.`,
      render_profile: renderProfile,
    };
  }
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg) {
    return { ok: false, op: 'composition.render', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  }
  if (!bins.ffprobe) {
    return { ok: false, op: 'composition.render', errorCode: 'E_FFPROBE_MISSING', message: 'Bundled ffprobe not found; final media cannot be verified.' };
  }

  const fps = renderProfile.render_fps;
  const totalFrames = Math.max(1, Math.ceil(loaded.meta.durationSec * fps));
  const evidenceDirAbs = p.frameEvidenceDirAbs;
  const requestedSampleTimes: Array<{ label: string; timeSec: number; sceneId?: string }> = p.frameSampleTimes
    || sampleTimes(loaded.meta.durationSec).map((timeSec, index) => ({ label: `sample-${index + 1}`, timeSec }));
  const samplePlans: FrameSamplePlan[] = evidenceDirAbs
    ? requestedSampleTimes.map((item) => ({
        label: samplePlanKey(item.label),
        timeSec: Math.max(0, Math.min(loaded.meta!.durationSec - 0.001, item.timeSec)),
        frameIndex: Math.max(0, Math.min(totalFrames - 1, Math.floor(Math.max(0, item.timeSec) * fps))),
        ...(item.sceneId ? { sceneId: item.sceneId } : {}),
      }))
    : [];
  const sampleByFrame = new Map<number, FrameSamplePlan>();
  for (const sample of samplePlans) {
    if (!sampleByFrame.has(sample.frameIndex)) sampleByFrame.set(sample.frameIndex, sample);
  }
  const capturedSamples: FrameSampleEvidence[] = [];
  const renderStartedAt = Date.now();
  let encoder: ReturnType<typeof startRawFrameEncoder> | null = null;
  const outputDir = path.dirname(p.outputAbsPath);
  const outputExt = path.extname(p.outputAbsPath) || (p.format === 'webm' ? '.webm' : '.mp4');
  const tempOutputAbsPath = path.join(
    outputDir,
    `.${path.basename(p.outputAbsPath, path.extname(p.outputAbsPath))}.rendering-${crypto.randomUUID()}${outputExt}`,
  );
  try {
    if (evidenceDirAbs) await fs.mkdir(evidenceDirAbs, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    encoder = startRawFrameEncoder({
      ffmpeg: bins.ffmpeg,
      outputAbsPath: tempOutputAbsPath,
      width: loaded.meta.width,
      height: loaded.meta.height,
      fps,
      format: p.format ?? 'mp4',
      quality: p.quality,
      audioTracks: loaded.meta.audioTracks,
      durationSec: loaded.meta.durationSec,
      signal: p.signal,
    });
    const captureStartedAt = Date.now();
    p.onProgress?.({ phase: 'composition.render', message: `Capturing and streaming ${totalFrames} frames to the native encoder.`, data: { totalFrames, fps, framePipeline: 'raw_bgra_pipe' } });
    await withCompositionWindow(loaded.meta, p, async (win) => {
      for (let frame = 0; frame < totalFrames; frame += 1) {
        if (p.signal?.aborted) throw new Error('render aborted');
        const t = frame / fps;
        await seek(win, Math.min(t, Math.max(0, loaded.meta!.durationSec - 0.001)));
        const sample = sampleByFrame.get(frame);
        const semanticEvidence = sample ? await readFrameSemanticEvidence(win) : null;
        const capturedImage = await withVideoStudioTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height }),
          COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
          'E_RENDER_CAPTURE_TIMEOUT',
          `composition render timed out while capturing frame ${frame + 1}/${totalFrames}.`,
          () => { try { win.destroy(); } catch { /* best effort */ } },
        );
        const normalizedCapture = normalizeCapturedFrame(
          capturedImage,
          loaded.meta!.width,
          loaded.meta!.height,
        );
        const image = normalizedCapture.image;
        renderProfile.capture_source_width = normalizedCapture.sourceWidth;
        renderProfile.capture_source_height = normalizedCapture.sourceHeight;
        renderProfile.capture_scale_factor = normalizedCapture.scaleFactor;
        const bitmap = image.toBitmap();
        await withVideoStudioTimeout(
          encoder!.writeFrame(bitmap),
          COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
          'E_RENDER_PIPE_TIMEOUT',
          `composition render timed out while streaming frame ${frame + 1}/${totalFrames} to ffmpeg.`,
          () => encoder?.cancel(),
        );
        if (sample && evidenceDirAbs) {
          const stats = analyzeNativeImage(image);
          const samplePath = path.join(evidenceDirAbs, `${String(capturedSamples.length + 1).padStart(2, '0')}-${sample.label}.png`);
          await fs.writeFile(samplePath, image.toPNG());
          capturedSamples.push({
            label: sample.label,
            time_seconds: round2(sample.timeSec),
            frame_index: frame,
            path: samplePath,
            ...(sample.sceneId ? { expected_scene_id: sample.sceneId } : {}),
            capture_source_width: normalizedCapture.sourceWidth,
            capture_source_height: normalizedCapture.sourceHeight,
            capture_scale_factor: normalizedCapture.scaleFactor,
            ...(semanticEvidence || {}),
            ...stats,
          });
        }
        if (frame % Math.max(1, Math.floor(fps * 2)) === 0) {
          p.onProgress?.({ phase: 'composition.render.capture', message: `Captured frame ${frame + 1}/${totalFrames}.`, data: { frame: frame + 1, totalFrames } });
        }
      }
    });
    const capturePipelineSeconds = Math.max(0.001, (Date.now() - captureStartedAt) / 1000);
    const encoderFinalizeStartedAt = Date.now();
    const encoded = await encoder.finish();
    const encoderFinalizeSeconds = Math.max(0, (Date.now() - encoderFinalizeStartedAt) / 1000);
    const totalRenderSeconds = Math.max(0.001, (Date.now() - renderStartedAt) / 1000);
    renderProfile.frame_pipeline = 'raw_bgra_pipe';
    renderProfile.capture_pipeline_seconds = round2(capturePipelineSeconds);
    renderProfile.encoder_finalize_seconds = round2(encoderFinalizeSeconds);
    renderProfile.total_render_seconds = round2(totalRenderSeconds);
    renderProfile.observed_capture_fps = round2(totalFrames / capturePipelineSeconds);
    renderProfile.observed_realtime_factor = round2(totalRenderSeconds / Math.max(0.001, loaded.meta.durationSec));
    renderProfile.frame_bytes_streamed = encoder.bytesWritten();
    renderProfile.temporary_frame_bytes = 0;
    if (encoded.aborted) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch(() => {});
      return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_ABORTED', message: 'render aborted.', render_profile: renderProfile };
    }
    if (encoded.timedOut) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch(() => {});
      return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_TIMEOUT', message: 'ffmpeg streaming encode timed out.', render_profile: renderProfile };
    }
    if (encoded.code !== 0) {
      const stderrTail = redactPaths(encoded.stderr.slice(-1200));
      log.warn('ffmpeg streaming encode failed', { code: encoded.code, stderr_chars: encoded.stderr.length, stderr_tail: stderrTail.slice(-500) });
      await fs.rm(tempOutputAbsPath, { force: true }).catch(() => {});
      return {
        ok: false,
        op: 'composition.render',
        errorCode: 'E_RENDER_ENCODE_FAILED',
        message: `ffmpeg exited ${encoded.code}. ${stderrTail}`,
        render_profile: renderProfile,
      };
    }
    let frameEvidence: FrameEvidence | undefined;
    if (evidenceDirAbs) {
      const contactSheet = await writeFrameContactSheet(evidenceDirAbs, capturedSamples);
      frameEvidence = {
        evidence_dir: evidenceDirAbs,
        contact_sheet: contactSheet,
        frame_paths: capturedSamples.map((sample) => sample.path),
        samples: capturedSamples,
      };
    }
    await persistObservedRenderProfile(p.compositionDirAbs, renderProfile).catch((err) => {
      log.warn('persist render profile failed', { message: (err as Error).message });
    });
    const probe = await probeMedia(bins.ffprobe, tempOutputAbsPath, p.signal);
    if (!probe?.video || probe.duration_seconds === null) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch(() => {});
      return {
        ok: false,
        op: 'composition.render',
        errorCode: 'E_RENDER_MEDIA_UNPROBEABLE',
        message: 'ffmpeg completed, but the rendered media could not be probed as a valid video. The temporary file was discarded.',
        render_profile: renderProfile,
      };
    }
    await fs.rename(tempOutputAbsPath, p.outputAbsPath);
    const st = await fs.stat(p.outputAbsPath);
    return {
      ok: true,
      op: 'composition.render',
      path: p.outputAbsPath,
      bytes: st.size,
      media: `chat-media://local/${p.outputAbsPath}`,
      probe,
      engine: 'orkas-native',
      fps,
      frames: totalFrames,
      canvas: { width: loaded.meta.width, height: loaded.meta.height, durationSec: loaded.meta.durationSec },
      render_profile: renderProfile,
      ...(frameEvidence ? { frame_evidence: frameEvidence } : {}),
    };
  } catch (err) {
    encoder?.cancel();
    if (encoder) await encoder.wait().catch(() => null);
    await fs.rm(tempOutputAbsPath, { force: true }).catch(() => {});
    return {
      ok: false,
      op: 'composition.render',
      errorCode: p.signal?.aborted ? 'E_RENDER_ABORTED' : videoStudioErrorCode(err, 'E_RENDER_FAILED'),
      message: (err as Error).message,
      render_profile: renderProfile,
    };
  }
}

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

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

export function buildFrameEncoderArgs(opts: Omit<FrameEncoderOptions, 'ffmpeg' | 'signal'>): string[] {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${opts.width}x${opts.height}`,
    '-framerate', String(opts.fps),
    '-i', 'pipe:0',
  ];
  const audioTracks = opts.audioTracks.filter((track) => fss.existsSync(track.absPath));
  for (const track of audioTracks) args.push('-i', track.absPath);
  if (audioTracks.length) {
    const duration = opts.durationSec.toFixed(3);
    const filters: string[] = [];
    audioTracks.forEach((track, index) => {
      const inputIndex = index + 1;
      const delayMs = Math.max(0, Math.round((track.startSec || 0) * 1000));
      const volume = Number.isFinite(track.volume) && track.volume >= 0 ? track.volume : 1;
      const delay = delayMs > 0 ? `adelay=${delayMs}|${delayMs},` : '';
      filters.push(`[${inputIndex}:a]volume=${volume},${delay}apad,atrim=0:${duration}[a${index}]`);
    });
    if (audioTracks.length === 1) {
      filters.push('[a0]anull[aout]');
    } else {
      filters.push(`${audioTracks.map((_track, index) => `[a${index}]`).join('')}amix=inputs=${audioTracks.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
    }
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]');
  }
  if (opts.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(crfForQuality(opts.quality) + 8));
    if (audioTracks.length) args.push('-c:a', 'libopus');
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', String(crfForQuality(opts.quality)), '-movflags', '+faststart');
    if (audioTracks.length) args.push('-c:a', 'aac');
  }
  args.push('-t', opts.durationSec.toFixed(3), opts.outputAbsPath);
  return args;
}

function startRawFrameEncoder(opts: FrameEncoderOptions): {
  writeFrame: (bitmap: Buffer) => Promise<void>;
  finish: () => Promise<ProcessResult>;
  wait: () => Promise<ProcessResult>;
  cancel: () => void;
  bytesWritten: () => number;
} {
  const child = spawn(opts.ffmpeg, buildFrameEncoderArgs(opts), { ...(opts.signal ? { signal: opts.signal } : {}) });
  let settled = false;
  let timedOut = false;
  let bytesWritten = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let resolveDone: (result: ProcessResult) => void = () => {};
  const done = new Promise<ProcessResult>((resolve) => { resolveDone = resolve; });
  const appendBounded = (target: string[], chunk: Buffer) => {
    target.push(chunk.toString('utf8'));
    while (target.length > 128) target.shift();
  };
  const settle = (code: number | null, errorMessage = '') => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (errorMessage) stderr.push(errorMessage);
    resolveDone({
      code,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      timedOut,
      aborted: !!opts.signal?.aborted,
    });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, RENDER_TIMEOUT_MS);
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderr, chunk));
  child.stdin?.on('error', () => { /* write callbacks surface EPIPE to the render loop */ });
  child.on('error', (err: Error) => settle(-1, err.message));
  child.on('close', (code) => settle(code));

  return {
    writeFrame: (bitmap: Buffer) => new Promise<void>((resolve, reject) => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) {
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
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      return done;
    },
    wait: () => done,
    cancel: () => {
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!settled) child.kill('SIGKILL');
    },
    bytesWritten: () => bytesWritten,
  };
}

async function runProcess(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => err.push(c.toString('utf8')));
    child.stdin?.end();
    child.on('error', (e: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: out.join(''), stderr: e.message, timedOut, aborted: !!opts.signal?.aborted });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: out.join(''), stderr: err.join(''), timedOut, aborted: !!opts.signal?.aborted });
    });
  });
}

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
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function loudnessReportFromJson(value: Record<string, unknown> | null, rawTail = ''): LoudnessReport {
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
    target_i: LOUDNESS_TARGET_I,
    target_tp: LOUDNESS_TARGET_TP,
    target_lra: LOUDNESS_TARGET_LRA,
    normalized: value,
  };
}

export function shouldNormalizeLoudness(report: LoudnessReport | null, quality: RenderQuality | undefined): { normalize: boolean; reason: string } {
  if (!report || report.ok === false) return { normalize: false, reason: 'loudness analysis unavailable' };
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

async function analyzeLoudness(ffmpeg: string, mediaAbsPath: string, signal?: AbortSignal): Promise<LoudnessReport> {
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
  return loudnessReportFromJson(parseLastJsonObject(text), text.slice(-1000));
}

async function normalizeAudioInPlace(ffmpeg: string, mediaAbsPath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const ext = path.extname(mediaAbsPath) || '.mp4';
  if (ext.toLowerCase() !== '.mp4') {
    return { skipped: true, reason: 'audio normalization currently applies only to mp4 output' };
  }
  const tmp = path.join(path.dirname(mediaAbsPath), `${path.basename(mediaAbsPath, ext)}.norm-${Date.now()}${ext}`);
  const r = await runProcess(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaAbsPath,
    '-af', `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    tmp,
  ], { signal, timeoutMs: RENDER_TIMEOUT_MS });
  if (r.aborted) return { skipped: true, reason: 'normalization aborted' };
  if (r.timedOut) return { skipped: true, reason: 'normalization timed out' };
  if (r.code !== 0) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { skipped: true, reason: 'normalization failed', stderr_tail: redactPaths(r.stderr.slice(-1000)) };
  }
  await fs.rename(tmp, mediaAbsPath);
  return { skipped: false, path: mediaAbsPath };
}

async function buildMediaQa(
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

async function failDraft(
  report: Record<string, unknown>,
  p: CompositionOptions,
  code: string,
  message: string,
  extra: Record<string, unknown>,
  repairBudget: DraftRepairBudget,
): Promise<VideoStudioResult> {
  report.error = {
    code,
    message,
    ...(extra.repair_target ? { repair_target: extra.repair_target } : {}),
  };
  // Environmental failures fail fast but do not spend a repair pass — there is
  // nothing in the composition to repair, so counting them would brick a
  // constrained machine after a few identical machine-side failures.
  const budgetSummary = isEnvironmentalDraftFailure(code)
    ? repairBudget.summary
    : await recordDraftFailure(repairBudget, p.reportAbsPath, code, message, extra);
  const steps = report.steps as Record<string, unknown>;
  steps.repair_budget = budgetSummary;
  report.repair_budget = budgetSummary;
  await writeReportIfRequested(p.reportAbsPath, report);
  return {
    ok: false,
    op: 'composition.draft',
    errorCode: code,
    message,
    report,
    repair_budget: budgetSummary,
    ...extra,
  };
}

export async function draftComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const report: Record<string, unknown> = {
    ok: false,
    op: 'composition.draft',
    engine: 'orkas-native',
    composition_dir: p.compositionDirAbs,
    path: p.outputAbsPath || '',
    steps: {},
  };
  const steps = report.steps as Record<string, unknown>;
  const repairBudget = await initDraftRepairBudget(p.compositionDirAbs, p.repairStateAbsPath);
  steps.repair_budget = repairBudget.summary;
  report.repair_budget = repairBudget.summary;
  if (repairBudget.blocked) {
    report.error = {
      code: 'E_REPAIR_BUDGET_EXCEEDED',
      message: `Draft repair budget exceeded: the initial draft plus ${DRAFT_REPAIR_MAX_PASSES} repair pass(es) still failed. Stop and report the blocker instead of continuing to patch.`,
    };
    await writeReportIfRequested(p.reportAbsPath, report);
    return {
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_REPAIR_BUDGET_EXCEEDED',
      message: String((report.error as Record<string, unknown>).message),
      report,
      repair_budget: repairBudget.summary,
      last_error: repairBudget.summary.last_error,
    };
  }

  const preflight = await preflightComposition(p);
  steps.preflight = preflight.report;
  steps.lint = {
    ok: preflight.ok,
    status: preflight.ok ? 'passed' : 'failed',
    stage: 'preflight',
    blocking_error_count: preflight.issues.filter((issue) => issue.severity === 'error').length,
    findings: findingsJson(preflight.issues),
  };
  if (!preflight.ok || !preflight.meta || !preflight.manifest) {
    const firstError = preflight.issues.find((issue) => issue.severity === 'error');
    return failDraft(report, p, 'E_PREFLIGHT_BLOCKED', 'composition manifest/HTML/source/audio preflight failed before rendering.', {
      repair_target: firstError?.selector || 'composition-manifest.json',
      preflight: preflight.report,
      next_allowed_ops: ['composition.prepare'],
    }, repairBudget);
  }

  const loaded = { meta: preflight.meta };
  steps.authoring = {
    ok: true,
    mode: 'manifest_bounded_model_authored_html',
    path: preflight.meta.htmlPath,
    manifest_path: preflight.contractLoad.path,
    scene_map_path: preflight.sceneMapLoad.path,
    shotlist_path: preflight.shotlistLoad.exists ? preflight.shotlistLoad.path : '',
  };
  steps.contract_html = preflight.steps.contract_html;
  steps.source_alignment = preflight.steps.source_alignment;
  steps.audio_timing = preflight.steps.audio_timing;

  const inspect = await inspectComposition(p);
  const inspectDisposition = inspect.ok
    ? summarizeDraftInspectDisposition(String(inspect.findings || ''))
    : { blocking_error_count: 1, advisory_count: 0, blocking_issues: [], advisory_issues: [] };
  steps.inspect = {
    ...inspect,
    draft_disposition: inspectDisposition,
  };
  if (inspect.ok === false) {
    return failDraft(report, p, inspect.errorCode || 'E_INSPECT_BLOCKED', inspect.message || 'composition inspect failed.', {
      inspect,
      next_allowed_ops: ['composition.prepare', 'composition.inspect'],
    }, repairBudget);
  }
  if (p.findingsAbsPath && inspect.ok) {
    await fs.mkdir(path.dirname(p.findingsAbsPath), { recursive: true });
    await fs.writeFile(p.findingsAbsPath, String(inspect.findings || ''), 'utf8');
  }
  if (Number(inspectDisposition.blocking_error_count || 0) > 0) {
    return failDraft(report, p, 'E_INSPECT_BLOCKED', 'inspect found fatal runtime errors or high-confidence visual blockers; repair the canonical manifest or visual HTML before rendering.', {
      inspect_summary: parseFindingsPayload(String(inspect.findings || '')),
      draft_disposition: inspectDisposition,
    }, repairBudget);
  }

  const metaForRender = loaded.meta ?? (await loadCompositionMeta(p.compositionDirAbs)).meta;
  const sceneMapForSamples = preflight.sceneMapLoad;
  const fps = qualityFps(p.quality, p.fps);
  const evidenceDirAbs = p.frameEvidenceDirAbs
    || (p.outputAbsPath ? path.join(path.dirname(p.outputAbsPath), 'draft-evidence') : path.join(p.compositionDirAbs, 'qa', 'draft-evidence'));
  const render = await renderComposition({
    ...p,
    frameEvidenceDirAbs: evidenceDirAbs,
    ...(metaForRender ? { frameSampleTimes: buildDraftFrameSamplePlan(metaForRender, sceneMapForSamples.value, fps) } : {}),
  });
  steps.render = render;
  if ((render as { render_profile?: unknown }).render_profile) {
    steps.render_profile = (render as { render_profile?: unknown }).render_profile;
  }
  if (render.ok === false) {
    return failDraft(report, p, render.errorCode, render.message, {
      render,
    }, repairBudget);
  }

  const renderPath = String(render.path || p.outputAbsPath || '');
  const renderedFrameEvidence = ((render as { frame_evidence?: FrameEvidence }).frame_evidence ?? null);
  const reviewContractLoad = preflight.contractLoad;
  const reviewSceneMapLoad = preflight.sceneMapLoad;
  const baselineAbsPath = p.visualBaselineAbsPath || path.join(p.compositionDirAbs, 'qa', 'visual-baseline.json');
  const visualRegression = p.updateVisualBaseline && renderedFrameEvidence
    ? {
      ok: true,
      skipped: false,
      status: 'updated',
      changed: false,
      baseline_path: await writeVisualBaseline(baselineAbsPath, renderedFrameEvidence),
      issues: [],
    }
    : await compareVisualBaseline(baselineAbsPath, renderedFrameEvidence);
  steps.visual_regression = visualRegression;
  const designReviewInputs = buildDesignReviewInputs({
    contractLoad: reviewContractLoad,
    sceneMapLoad: reviewSceneMapLoad,
    contractHtml: (steps.contract_html as Record<string, unknown>) || null,
    inspectDisposition,
    frameEvidence: renderedFrameEvidence,
    visualRegression,
  });
  steps.design_review_inputs = designReviewInputs;
  let finalBytes = typeof render.bytes === 'number' ? render.bytes : 0;
  let mediaProbe = ((render as { probe?: MediaProbe | null }).probe ?? null);
  steps.media_probe = mediaProbe;
  const binsForPostprocess = bundledFfmpegPaths();
  if (renderPath && mediaProbe?.audio && binsForPostprocess.ffmpeg) {
    const loudnessBefore = await analyzeLoudness(binsForPostprocess.ffmpeg, renderPath, p.signal);
    steps.loudness_before = loudnessBefore;
    const normalizeDecision = shouldNormalizeLoudness(loudnessBefore, p.quality);
    if (normalizeDecision.normalize) {
      steps.audio_normalize = {
        decision: normalizeDecision,
        ...(await normalizeAudioInPlace(binsForPostprocess.ffmpeg, renderPath, p.signal)),
      };
      if ((steps.audio_normalize as { skipped?: boolean }).skipped === false) {
        mediaProbe = binsForPostprocess.ffprobe ? await probeMedia(binsForPostprocess.ffprobe, renderPath, p.signal) : mediaProbe;
        steps.media_probe = mediaProbe;
        steps.loudness_after = await analyzeLoudness(binsForPostprocess.ffmpeg, renderPath, p.signal);
        const st = await fs.stat(renderPath).catch(() => null);
        if (st?.isFile()) finalBytes = st.size;
      }
    } else {
      steps.audio_normalize = { skipped: true, reason: normalizeDecision.reason, decision: normalizeDecision };
    }
  } else {
    steps.audio_normalize = { skipped: true, reason: mediaProbe?.audio ? 'ffmpeg unavailable' : 'no audio stream' };
  }
  if (metaForRender) {
    const mediaQa = await buildMediaQa(metaForRender, mediaProbe, binsForPostprocess.ffprobe, p.signal);
    steps.media_qa = mediaQa;
    if (mediaQa.ok === false) {
      return failDraft(report, p, 'E_MEDIA_QA_BLOCKED', 'draft media QA failed.', {
        media_qa: mediaQa,
      }, repairBudget);
    }
    const videoQa = summarizeVideoFrameQa(renderedFrameEvidence, metaForRender.durationSec, {
      sceneCount: preflight.manifest.scenes.length,
      expectedSceneIds: preflight.manifest.scenes.map((scene) => scene.id),
      requireSemanticCoverage: true,
    });
    steps.video_qa = videoQa;
    if (videoQa.ok === false) {
      return failDraft(report, p, 'E_VIDEO_QA_BLOCKED', 'video-level QA failed; repair the canonical manifest, mapped content, or visual HTML before Gate D.', {
        video_qa: videoQa,
      }, repairBudget);
    }
  }

  const successBudget = await recordDraftSuccess(repairBudget, p.reportAbsPath, render.path as string | undefined);
  steps.repair_budget = successBudget;
  report.repair_budget = successBudget;
  report.ok = true;
  report.media = { path: renderPath, bytes: finalBytes };
  report.video_qa = (steps.video_qa as Record<string, unknown>) || null;
  report.render_profile = (steps.render_profile as Record<string, unknown>) || null;
  report.visual_regression = visualRegression;
  report.design_review_inputs = designReviewInputs;
  report.next_action = 'open_gate_d';
  report.advisory_policy = 'visual inspect warnings are advisory after ok:true; open Gate D instead of self-repairing.';
  await writeReportIfRequested(p.reportAbsPath, report);
  return {
    ok: true,
    op: 'composition.draft',
    path: renderPath,
    bytes: finalBytes,
    report_path: p.reportAbsPath || '',
    findings_path: p.findingsAbsPath || '',
    media: `chat-media://local/${renderPath}`,
    probe: mediaProbe,
    render_profile: (steps.render_profile as Record<string, unknown>) || null,
    visual_regression: visualRegression,
    design_review_inputs: designReviewInputs,
    contact_sheet: renderedFrameEvidence?.contact_sheet || '',
    frame_paths: renderedFrameEvidence?.frame_paths || [],
    draft_ready: true,
    next_action: 'open_gate_d',
    next_allowed_ops: ['composition.approve_draft'],
    report,
  };
}

async function writeReportIfRequested(reportAbsPath: string | undefined, report: Record<string, unknown>): Promise<void> {
  if (!reportAbsPath) return;
  await fs.mkdir(path.dirname(reportAbsPath), { recursive: true });
  await fs.writeFile(reportAbsPath, JSON.stringify(report, null, 2), 'utf8');
  report.report_path = reportAbsPath;
}

async function writeJsonIfRequested(absPath: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!absPath) return;
  payload.findings_path = absPath;
  await writeJson(absPath, payload);
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

function resolveSpeechTranscribeBackend(modelHint?: string): { cli: string; model: string; source: 'env' | 'bundled' } | null {
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

function tokenWords(tokens: unknown[], segmentEndMs: number): Array<{ text: string; startSec: number; endSec: number }> {
  const timed = tokens.flatMap((token, index) => {
    if (!token || typeof token !== 'object' || Array.isArray(token)) return [];
    const item = token as WhisperJsonObject;
    const rawText = typeof item.text === 'string' ? item.text : '';
    const timing = offsetsMs(item.offsets);
    if (!rawText.trim() || !timing || isWhisperSpecialToken(rawText)) return [];
    let endMs = timing.to;
    if (endMs <= timing.from) {
      for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex += 1) {
        const next = tokens[nextIndex];
        if (!next || typeof next !== 'object' || Array.isArray(next)) continue;
        const nextTiming = offsetsMs((next as WhisperJsonObject).offsets);
        if (nextTiming && nextTiming.from > timing.from) {
          endMs = nextTiming.from;
          break;
        }
      }
      if (endMs <= timing.from) endMs = Math.max(timing.from + 10, segmentEndMs);
    }
    return [{ rawText, text: rawText.trim(), startMs: timing.from, endMs }];
  });

  const words: Array<{ text: string; startSec: number; endSec: number }> = [];
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const punctuation = /^[\p{P}\p{S}]+$/u;
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
  return words.filter(word => word.text && word.endSec > word.startSec);
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
      const timing = offsetsMs(item.offsets);
      return Array.isArray(item.tokens) ? tokenWords(item.tokens, timing?.to || 0) : [];
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

export function buildSpeechTranscribeArgs(
  modelPath: string,
  wavPath: string,
  outBase: string,
  options: Pick<SpeechTranscribeOptions, 'language' | 'timestamps'>,
): string[] {
  const timestampDetail = options.timestamps === 'word' ? 'word' : 'segment';
  const args = ['-m', modelPath, '-f', wavPath, timestampDetail === 'word' ? '-ojf' : '-oj', '-of', outBase, '-np'];
  args.push('-l', options.language?.trim() || 'auto');
  if (timestampDetail === 'word') {
    const dtwModel = whisperDtwModel(modelPath);
    if (dtwModel) args.push('-dtw', dtwModel);
  }
  return args;
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
  if (!bins.ffmpeg) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  }
  const st = await fs.stat(p.inputAbsPath).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_INPUT', message: 'input is not a file' };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-transcribe-'));
  const wav = path.join(tmp, 'audio.wav');
  const outBase = path.join(tmp, 'transcript');
  try {
    p.onProgress?.({ phase: 'speech.transcribe.extract', message: 'Extracting mono 16 kHz audio for transcription.' });
    const ex = await runProcess(bins.ffmpeg, ['-y', '-i', p.inputAbsPath, '-vn', '-ac', '1', '-ar', '16000', wav], { signal: p.signal, timeoutMs: 20 * 60 * 1000 });
    if (ex.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED', message: redactPaths(ex.stderr.slice(-1200)) || 'audio extraction failed' };
    }
    p.onProgress?.({ phase: 'speech.transcribe.asr', message: 'Running Orkas-native whisper.cpp transcription.' });
    const timestampDetail = p.timestamps === 'word' ? 'word' : 'segment';
    const args = buildSpeechTranscribeArgs(backend.model, wav, outBase, {
      language: p.language,
      timestamps: timestampDetail,
    });
    const tr = await runProcess(backend.cli, args, { signal: p.signal, timeoutMs: 45 * 60 * 1000 });
    if (tr.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_FAILED', message: redactPaths(tr.stderr.slice(-1200)) || 'transcriber failed' };
    }
    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_OUTPUT', message: 'transcriber produced no JSON output.' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { raw }; }
    const normalized = normalizeWhisperTranscript(parsed, timestampDetail);
    if (p.transcriptAbsPath) {
      await fs.mkdir(path.dirname(p.transcriptAbsPath), { recursive: true });
      await fs.writeFile(p.transcriptAbsPath, JSON.stringify(normalized, null, 2), 'utf8');
    }
    return {
      ok: true,
      op: 'speech.transcribe',
      summary: normalized,
      transcript_path: p.transcriptAbsPath || '',
      backend: 'orkas-native:whisper.cpp',
      backend_source: backend.source,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
