import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow, NativeImage as ElectronNativeImage } from 'electron';

import { bundledFfmpegPaths, bundledWhisperPaths } from '../util/bundled-runtime';
import { versionedChatMediaLocalUrl } from '../util/chat-media-url';
import { redactPaths } from '../util/redact';
import { logErrorSummary } from '../util/log-redact';
import { createLogger } from '../logger';
import { writeJson } from '../storage';
import { prepareProducedFileForInput } from './produced_output_hooks';
import {
  CompositionManifestSchema,
  compositionNarrationText,
  decomposeCompositionSceneAttribution,
  ensureCompositionManifest,
  manifestAsDesignContract,
  manifestAsSceneMap,
  prepareCompositionScaffold,
  type CompositionManifest,
  type SceneAttributionDecomposition,
} from './video_studio_contract';
import {
  designContractReadiness,
  DRAFT_REPAIR_MAX_PASSES,
  analyzeNativeImage,
  regionContrast,
  buildDesignReviewInputs,
  buildDraftFrameSamplePlan,
  buildInspectFrameSamplePlan,
  buildPreviewFrameSamplePlan,
  compareVisualBaseline,
  initDraftRepairBudget,
  isSuspiciousCrossSceneDuplicate,
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
  type VisibleSemanticElementEvidence,
  type HiddenSemanticElementEvidence,
  BLANK_FRAME_MAX_CONTRAST,
} from './video_studio_qa';
import { extractCssImports, extractCssUrls, extractHtmlResourceRefs, parseHtmlStructure, type HtmlResourceRef } from './video_studio_html_check';
import { hardenedWebPreferences } from '../util/window-security';
import { killProcessTree } from '../../core-agent/src/sandbox/executor';

const log = createLogger('video-studio');

function logOptionalReadFailure(message: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
  log.warn(message, { error: logErrorSummary(err) });
}

const COMPOSITION_LOAD_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_LOAD_TIMEOUT_MS) || 30_000;
const COMPOSITION_READY_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_READY_TIMEOUT_MS) || 20_000;
const COMPOSITION_SCRIPT_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_SCRIPT_TIMEOUT_MS) || 15_000;
const COMPOSITION_CAPTURE_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_CAPTURE_TIMEOUT_MS) || 15_000;
const COMPOSITION_RENDER_FRAME_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_RENDER_FRAME_TIMEOUT_MS) || 20_000;

export type VideoStudioOp =
  | 'production.status'
  | 'production.approve_plan'
  | 'production.approve_generation'
  | 'production.segment_qa'
  | 'composition.status'
  | 'composition.doctor'
  | 'composition.reconcile'
  | 'composition.check_narration_fit'
  | 'composition.approve_plan'
  | 'composition.prepare'
  | 'composition.materialize_narration'
  | 'composition.lint'
  | 'composition.inspect'
  | 'composition.render'
  | 'composition.draft'
  | 'composition.export'
  | 'composition.snapshot'
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
  /** Whether this composition's frame 0 is the delivered video's first frame.
   *  Only the owning tool layer knows: a standalone COMPOSE always is, while an
   *  assembled child is only when it is the first segment of its parent EDL.
   *  Omitted means yes, so direct callers and tests keep the original rule. */
  isDeliveredOpening?: boolean;
  /** QA finding codes the user chose to skip, read from the production state
   *  by the owning tool layer. Matching design/frame findings report as
   *  informational; media-integrity QA is never filtered. */
  waivedQaFindings?: string[];
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
  frame_pipeline?: 'raw_bgra_pipe' | 'video_track_reuse' | 'scene_segment_assembly';
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

/** The composition's own declared frame rate, or undefined when there is no
 *  manifest to read it from. It lives only in composition-manifest.json — the
 *  HTML root carries width/height/duration but never fps — so nothing on the
 *  render path had it. */
export async function declaredCompositionFps(compositionDirAbs: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { composition?: { fps?: unknown } };
    // A real number, as CompositionManifestSchema requires. Coercing a string
    // here would let the renderer honour a value the manifest itself rejects.
    const raw_fps = parsed?.composition?.fps;
    const declared = typeof raw_fps === 'number' ? raw_fps : Number.NaN;
    return Number.isFinite(declared) && declared > 0
      ? Math.max(1, Math.min(MAX_FPS, Math.floor(declared)))
      : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit request first, then draft's deliberate speed shortcut, then what
 *  the composition declared, and only then the house default.
 *
 *  `declared` used to be missing entirely: the manifest's `fps` reached the
 *  design contract's canvas and stopped there, so every non-draft render came
 *  out at 30 whatever the composition asked for — a 24 or 60 fps composition
 *  was silently re-rated, and the plan summary the user approves reads its fps
 *  from the same manifest the renderer ignored. Draft keeps 15: that is the
 *  point of a draft, and it is labelled as one. */
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

/** P3c R0: page-identical whole-track reuse. A successful render persists the
 * exact inputs its video track depends on; a later render with the same key
 * reuses that track and remixes only the audio graph. Frame identity rests on
 * the same seek-determinism the preview snapshot pipeline already stakes on.
 * The provenance file lives under qa/, which every composition signature walk
 * excludes, so writing it never perturbs input identity. */
const RENDER_PROVENANCE_MAX_ENTRIES = 4;
const VIDEO_TRACK_REMUX_TIMEOUT_MS = 120_000;

export type RenderWindowVector = Array<{ id: string; start: number; duration: number }>;

export type RenderProvenanceEntry = {
  key: string;
  visual_signature: string;
  windows: RenderWindowVector;
  width: number;
  height: number;
  fps: number;
  quality: string;
  format: string;
  video_path: string;
  video_sha256: string;
  evidence_dir?: string;
  contact_sheet?: string;
  samples?: FrameSampleEvidence[];
  rendered_at: string;
};

type PersistedRenderProvenance = { version: 1; entries: RenderProvenanceEntry[] };

function renderProvenancePath(compositionDirAbs: string): string {
  return path.join(compositionDirAbs, 'qa', 'render-provenance.json');
}

export function buildRenderReuseKey(input: {
  visualSignature: string;
  windows: RenderWindowVector;
  width: number;
  height: number;
  fps: number;
  quality: string | undefined;
  format: string | undefined;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    visual_signature: input.visualSignature,
    windows: input.windows.map((window) => [window.id, window.start, window.duration]),
    width: input.width,
    height: input.height,
    fps: input.fps,
    // Undefined quality maps to its own encoder CRF tier; never fold it into
    // a named tier or two differently encoded requests would share a key.
    quality: input.quality ?? 'unset',
    format: input.format ?? 'mp4',
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function readCompositionWindowVector(compositionDirAbs: string): Promise<RenderWindowVector | null> {
  try {
    const raw = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scenes?: Array<{ id?: unknown; start?: unknown; duration?: unknown }> };
    if (!Array.isArray(parsed?.scenes) || parsed.scenes.length === 0) return null;
    const windows: RenderWindowVector = [];
    for (const scene of parsed.scenes) {
      const id = typeof scene?.id === 'string' ? scene.id : null;
      const start = typeof scene?.start === 'number' && Number.isFinite(scene.start) ? scene.start : null;
      const duration = typeof scene?.duration === 'number' && Number.isFinite(scene.duration) ? scene.duration : null;
      if (id === null || start === null || duration === null) return null;
      windows.push({ id, start, duration });
    }
    return windows;
  } catch (err) {
    logOptionalReadFailure('composition window vector read failed', err);
    return null;
  }
}

async function readRenderProvenance(compositionDirAbs: string): Promise<RenderProvenanceEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(renderProvenancePath(compositionDirAbs), 'utf8')) as PersistedRenderProvenance;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => !!entry && typeof entry.key === 'string' && typeof entry.video_sha256 === 'string');
  } catch (err) {
    logOptionalReadFailure('render provenance read failed', err);
    return [];
  }
}

async function upsertRenderProvenance(compositionDirAbs: string, entry: RenderProvenanceEntry): Promise<void> {
  const existing = await readRenderProvenance(compositionDirAbs);
  const entries = [entry, ...existing.filter((candidate) => candidate.key !== entry.key)]
    .slice(0, RENDER_PROVENANCE_MAX_ENTRIES);
  const out = renderProvenancePath(compositionDirAbs);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify({ version: 1, entries } satisfies PersistedRenderProvenance, null, 2), 'utf8');
}

async function sha256File(absPath: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(absPath)).digest('hex');
  } catch (err) {
    logOptionalReadFailure('video checksum read failed', err);
    return null;
  }
}

export function evaluateVideoTrackReuse(input: {
  entry: RenderProvenanceEntry | null;
  priorVideoSha256: string | null;
  evidenceRequired: boolean;
  priorSamplesPresent: boolean;
}): { reuse: boolean; reason: 'match' | 'no_provenance' | 'video_missing_or_changed' | 'evidence_missing' } {
  if (!input.entry) return { reuse: false, reason: 'no_provenance' };
  if (!input.priorVideoSha256 || input.priorVideoSha256 !== input.entry.video_sha256) {
    return { reuse: false, reason: 'video_missing_or_changed' };
  }
  if (input.evidenceRequired && !input.priorSamplesPresent) {
    return { reuse: false, reason: 'evidence_missing' };
  }
  return { reuse: true, reason: 'match' };
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

  await prepareProducedFileForInput(htmlPath, { source: 'video_studio.composition_input' });
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

export type CompositionPreflightProfile = 'visual-preview' | 'delivery';

function stepIssues(step: Record<string, unknown>): Issue[] {
  return Array.isArray(step.issues) ? step.issues.filter((issue): issue is Issue => !!issue && typeof issue === 'object') : [];
}

function deferErrorsForVisualPreview(
  step: Record<string, unknown>,
  profile: CompositionPreflightProfile,
  shouldDefer: (issue: Issue) => boolean,
): Record<string, unknown> {
  if (profile === 'delivery') return step;
  const originalIssues = stepIssues(step);
  const issues = originalIssues.map((issue) => (
    issue.severity === 'error' && shouldDefer(issue)
      ? {
        ...issue,
        severity: 'warning' as const,
        message: `${issue.message} This remains a delivery blocker, but it does not block visual inspection or preview evidence.`,
      }
      : issue
  ));
  const deferredDeliveryErrorCount = originalIssues
    .filter((issue) => issue.severity === 'error' && shouldDefer(issue)).length;
  const remainingErrorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ...step,
    ok: remainingErrorCount === 0,
    error_count: remainingErrorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    issue_count: issues.length,
    issues,
    deferred_for_delivery: deferredDeliveryErrorCount > 0,
    deferred_delivery_error_count: deferredDeliveryErrorCount,
  };
}

function deliveryRequirementsForPreflightProfile(
  step: Record<string, unknown>,
  profile: CompositionPreflightProfile,
): Record<string, unknown> {
  return deferErrorsForVisualPreview(
    step,
    profile,
    (issue) => issue.code === 'DELIVERY_NARRATION_MISSING',
  );
}

function audioTimingForPreflightProfile(
  step: Record<string, unknown>,
  profile: CompositionPreflightProfile,
): Record<string, unknown> {
  return deferErrorsForVisualPreview(step, profile, () => true);
}

function hasIncompleteNarration(issues: Issue[]): boolean {
  return issues.some((issue) => (
    issue.code === 'DELIVERY_NARRATION_MISSING'
    || issue.code === 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED'
    || issue.code === 'NARRATION_ASSET_MISSING'
    || issue.code === 'NARRATION_DECLARED_BUT_SILENT'
  ));
}

function narrationPendingInPreflight(preflight: CompositionPreflightResult): boolean {
  return Number(preflight.report.deferred_delivery_error_count || 0) > 0
    || hasIncompleteNarration(preflight.issues);
}

export async function preflightComposition(
  p: CompositionOptions,
  profile: CompositionPreflightProfile = 'delivery',
): Promise<CompositionPreflightResult> {
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
      profile,
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
    {
      ...(p.isDeliveredOpening === false ? { isDeliveredOpening: false } : {}),
      ...(p.waivedQaFindings?.length ? { waivedFindings: p.waivedQaFindings } : {}),
    },
  );
  const sourceAlignment = await runSourceAlignmentQa(canonicalSceneMapLoad, shotlistLoad);
  const deliveryRequirements = deliveryRequirementsForPreflightProfile(await runDeliveryRequirementsQa(
    loaded.meta,
    canonicalSceneMapLoad,
    shotlistLoad,
    p.compositionDirAbs,
  ), profile);
  const audioTiming = audioTimingForPreflightProfile(await runAudioTimingQa(
    loaded.meta,
    canonicalContractLoad,
    canonicalSceneMapLoad,
    narrationMapLoad,
    p.compositionDirAbs,
  ), profile);
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
  const deferredDeliveryErrorCount = Number(deliveryRequirements.deferred_delivery_error_count || 0)
    + Number(audioTiming.deferred_delivery_error_count || 0);
  const narrationIncomplete = deferredDeliveryErrorCount > 0 || hasIncompleteNarration(issues);
  const report = {
    status: blockingErrorCount ? 'failed' : 'passed',
    stage: 'preflight',
    profile,
    blocking_error_count: blockingErrorCount,
    deferred_delivery_error_count: deferredDeliveryErrorCount,
    completeness: narrationIncomplete
      ? 'visual_only'
      : 'complete',
    advisory_count: issues.filter((issue) => issue.severity === 'warning').length,
    manifest: steps.manifest,
    steps,
    issues,
    next_allowed_ops: blockingErrorCount
      ? narrationIncomplete
        ? [
          'composition.prepare',
          'composition.materialize_narration',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ]
        : ['composition.prepare']
      : profile === 'visual-preview' && deferredDeliveryErrorCount > 0
        ? ['composition.inspect', 'composition.snapshot', 'composition.materialize_narration']
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
    // Judged here, where "before writing HTML" is still before writing HTML.
    // Prepare stays passing — the contract is authored INTO this manifest
    // next, so blocking on its absence would deadlock the very step that
    // fixes it. Inspect keeps the hard gate.
    design_contract: designContractReadiness(prepared.manifest),
    issues,
    next_allowed_ops: prepared.manifest
      && prepared.manifest.audio.owner !== 'assembler'
      && !!compositionNarrationText(prepared.manifest)
      && !prepared.manifest.audio.tracks.some((track) => track.kind === 'narration')
      ? ['composition.materialize_narration']
      : ['composition.lint', 'composition.inspect', 'composition.snapshot'],
  };
}

/** Persist a findings document when the caller asked for one.
 *
 * `findings_path` is a promise that the complete evidence is readable at that
 * path. lint returned the path in its result but never wrote the file: on
 * 2026-08-07 the batched QA advertised
 * `segment-qa-lint-findings.json`, the model read it twice and got E_NOT_FOUND
 * both times, and — with the batched summary carrying only the first issue —
 * spent twelve minutes editing manifests blind. Whoever names a findings path
 * writes it. */
async function writeFindingsIfRequested(absPath: string | undefined, findings: string): Promise<void> {
  if (!absPath) return;
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, findings, 'utf8');
}

export async function lintComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const preflight = await preflightComposition(p, 'visual-preview');
  const findings = findingsJson(preflight.issues, {
    engine: 'orkas-native',
    profile: 'orkas-html-composition',
    canvas: preflight.meta ? { width: preflight.meta.width, height: preflight.meta.height, durationSec: preflight.meta.durationSec } : null,
    preflight: preflight.report,
  });
  await writeFindingsIfRequested(p.findingsAbsPath, findings);
  const findingsPath = p.findingsAbsPath ? { findings_path: p.findingsAbsPath } : {};
  if (!preflight.ok) {
    const narrationPending = narrationPendingInPreflight(preflight);
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
      ...findingsPath,
      next_allowed_ops: narrationPending
        ? ['composition.prepare', 'composition.materialize_narration']
        : ['composition.prepare'],
    };
  }
  const narrationPending = narrationPendingInPreflight(preflight);
  return {
    ok: true,
    op: 'composition.lint',
    status: 'passed',
    stage: 'preflight',
    blocking_error_count: 0,
    preflight: preflight.report,
    findings,
    ...findingsPath,
    preview_completeness: narrationPending ? 'visual_only' : 'complete',
    narration_pending: narrationPending,
    next_allowed_ops: narrationPending
      ? ['composition.inspect', 'composition.snapshot', 'composition.materialize_narration']
      : ['composition.inspect', 'composition.snapshot', 'composition.draft'],
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

export function buildTimelineAdapterScript(meta: CompositionMeta, variables?: Record<string, unknown>): string {
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
      // GSAP skips rendering when the playhead is already at the requested
      // time, so a zero-duration set positioned exactly there never applies.
      // A freshly created paused timeline sits at 0, which makes frame 0 the
      // permanent victim: tl.set(scene, autoAlpha 1) at position 0 — the
      // reveal the authoring skill asks for — is never rendered, the
      // scaffold's .clip opacity:0/visibility:hidden stands, and frame 0
      // captures blank. Verified against the bundled build: seek(0) leaves
      // the element untouched while seek(0.5) applies it, and a forced render
      // fixes 0. Force only when the seek is a no-op, so ordinary frames keep
      // the normal path.
      const before = typeof tl.time === 'function' ? Number(tl.time()) : NaN;
      const forceRender = () => {
        if (Number.isFinite(before) && Math.abs(before - t) < 1e-6 && typeof tl.render === 'function') {
          tl.render(t, false, true);
        }
      };
      if (typeof tl.seek === 'function') { tl.seek(t, false); forceRender(); return true; }
      if (typeof tl.time === 'function') { tl.time(t, false); forceRender(); return true; }
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

async function settleCompositionPaint(win: ElectronBrowserWindow): Promise<void> {
  win.webContents.invalidate();
  await withVideoStudioTimeout(win.webContents.executeJavaScript(`
new Promise((resolve) => requestAnimationFrame(() => {
  setTimeout(() => requestAnimationFrame(resolve), 0);
}))
`, true), COMPOSITION_SCRIPT_TIMEOUT_MS, 'E_COMPOSITION_PAINT_TIMEOUT', 'composition paint did not settle before capture.', () => {
    try { win.destroy(); } catch { /* best effort */ }
  });
}

/** How many times a capture may be retaken when the pixels contradict the DOM.
 *  Two settles is already far past the one-frame race; more would be waiting
 *  on something else. */
const COMPOSITION_CONTRADICTED_CAPTURE_MAX_RETRIES = 2;
/** A visible element must cover at least this share of the frame before its
 *  absence from the pixels counts as a contradiction rather than a rounding
 *  difference. */
const CONTRADICTED_CAPTURE_MIN_AREA_RATIO = 0.02;

/** Did this capture come back blank while the page said it had content?
 *
 *  `capturePage` returns the last COMPOSITED surface, not the current DOM. The
 *  render loop's first capture races that compositor: seek(0) applies the
 *  scene-reveal styles, but nothing has painted since the window loaded with
 *  every scene scaffold-hidden, so the pixels can be one flat field while the
 *  DOM already holds the title.
 *
 *  2026-08-07: a delivered draft's frame 0 came back at brightness 17.8 /
 *  contrast 0 — a black cover — while the same sample's semantic evidence
 *  recorded `visible_scene_ids: ["hook"]` and a `data-role="title"` occupying
 *  14% of the frame. QA correctly reported EMPTY_HOOK_FRAME and pointed the
 *  model at the HTML, which was not wrong; the model could never fix it, and
 *  the run died there. Those two facts cannot both be true, and the host holds
 *  both — so it decides the capture failed rather than blaming the page.
 *
 *  2026-08-08 widened it: the whole-frame test above answers "is this image
 *  blank", which is not the same question. A page with a gradient background
 *  and a grid overlay measured contrast 9.03 — comfortably past the blank
 *  threshold — while its 88px headline was absent from the pixels and the DOM
 *  reported that same headline visible with text. The same composition rendered
 *  to video correctly, so the preview the user judges was worse than the video
 *  they would get. The question has to be asked of the region the element
 *  occupies, not of the frame.
 *
 *  Deliberately narrow, in both forms: it needs real content in the DOM AND
 *  either a mathematically uniform frame, or a named element whose own region
 *  is uniform while it claims meaningful area. A dark design is not uniform; an
 *  intentionally empty frame has nothing in the DOM to contradict; an element
 *  the probe never located is not judged. */
export function captureContradictsDom(
  stats: { brightness: number; contrast: number },
  evidence: { visible_text?: string; visible_elements?: VisibleSemanticElementEvidence[] },
  region?: (area: { left: number; top: number; width: number; height: number }) => number,
): boolean {
  const substantial = (evidence.visible_elements || []).filter(
    (element) => Number(element.area_ratio || 0) >= CONTRADICTED_CAPTURE_MIN_AREA_RATIO,
  );
  if (stats.contrast < BLANK_FRAME_MAX_CONTRAST) {
    if (String(evidence.visible_text || '').trim()) return true;
    return substantial.length > 0;
  }
  if (!region) return false;
  // Only elements the probe placed AND that carry something a viewer would
  // miss: text, a cover signal, or the hero. A decorative box that renders as
  // one flat colour is legitimately uniform and must not trigger a re-shoot.
  return substantial.some((element) => {
    if (element.left_ratio === undefined || element.top_ratio === undefined) return false;
    if (!String(element.text || '').trim() && !element.cover_signal && !element.cover_hero) return false;
    return region({
      left: element.left_ratio,
      top: element.top_ratio,
      width: Number(element.width_ratio || 0),
      height: Number(element.height_ratio || 0),
    }) < BLANK_FRAME_MAX_CONTRAST;
  });
}

async function readFrameSemanticEvidence(win: ElectronBrowserWindow): Promise<{
  visible_scene_ids: string[];
  visible_roles: string[];
  visible_text: string;
  visible_elements: VisibleSemanticElementEvidence[];
  hidden_elements: HiddenSemanticElementEvidence[];
}> {
  return await withVideoStudioTimeout(win.webContents.executeJavaScript(`
(() => {
  const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1);
  const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight || 1);
  const selectorOf = (el) => {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    const tag = String(el.tagName || '').toLowerCase();
    const sceneId = el.getAttribute && el.getAttribute('data-scene-id');
    if (sceneId) return tag + '[data-scene-id="' + sceneId + '"]';
    const role = el.getAttribute && el.getAttribute('data-role');
    if (role) return tag + '[data-role="' + role + '"]';
    const cls = String((el.className && el.className.baseVal) || el.className || '').trim().split(/\\s+/)[0];
    return cls ? tag + '.' + cls : tag;
  };
  // Returns null when the element renders, otherwise the reason it does not.
  // The walk is identical to the old boolean test — only its answer is richer.
  const failure = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return { reason: 'zero_size' };
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    if (visibleWidth <= 1 || visibleHeight <= 1) return { reason: 'offscreen' };
    let node = el;
    let opacity = 1;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return { reason: 'display_none', blocked_by: selectorOf(node) };
      if (style.visibility === 'hidden') return { reason: 'visibility_hidden', blocked_by: selectorOf(node) };
      opacity *= Number(style.opacity || 1);
      if (opacity <= 0.1) {
        return { reason: 'transparent', blocked_by: selectorOf(node), computed_opacity: Number(opacity.toFixed(3)) };
      }
      node = node.parentElement;
    }
    return null;
  };
  const visible = (el) => failure(el) === null;
  const scenes = Array.from(document.querySelectorAll('[data-scene-id]'))
    .filter(visible)
    .map((el) => String(el.getAttribute('data-scene-id') || '').trim())
    .filter(Boolean);
  const roleEls = Array.from(document.querySelectorAll('[data-role]')).filter(visible);
  const roles = roleEls
    .map((el) => String(el.getAttribute('data-role') || '').trim())
    .filter(Boolean);
  const visibleElements = Array.from(document.querySelectorAll('[data-role], [data-cover-signal], [data-cover-hero]'))
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const sceneOwner = el.closest('[data-scene-id]');
      const style = getComputedStyle(el);
      const role = String(el.getAttribute('data-role') || '').trim();
      const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
      const coverSignal = String(el.getAttribute('data-cover-signal') || '').trim();
      return {
        ...(sceneOwner ? { scene_id: String(sceneOwner.getAttribute('data-scene-id') || '').trim() } : {}),
        ...(role ? { role } : {}),
        ...(text ? { text } : {}),
        text_transform: String(style.textTransform || 'none').trim().toLowerCase(),
        ...(coverSignal ? { cover_signal: coverSignal } : {}),
        ...(el.hasAttribute('data-cover-hero') ? { cover_hero: true } : {}),
        width_ratio: Number((visibleWidth / viewportWidth).toFixed(4)),
        height_ratio: Number((visibleHeight / viewportHeight).toFixed(4)),
        area_ratio: Number(((visibleWidth * visibleHeight) / (viewportWidth * viewportHeight)).toFixed(4)),
        left_ratio: Number((Math.max(0, rect.left) / viewportWidth).toFixed(4)),
        top_ratio: Number((Math.max(0, rect.top) / viewportHeight).toFixed(4)),
      };
    });
  const text = visibleElements
    .filter((element) => !!element.role)
    .map((element) => element.text || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
  // Only the elements QA asks about: scene roots and the cover-bearing roles.
  // Report the OUTERMOST failing element per subtree: in a 9-scene video eight
  // scenes are legitimately hidden at any sampled time, and listing each of
  // their titles and heroes too would bury the one the finding asks about
  // under expected noise — and could push it past the cap entirely. A hidden
  // container is the cause; its children are consequences.
  const candidates = Array.from(document.querySelectorAll('[data-scene-id], [data-role], [data-cover-hero], [data-cover-signal]'));
  const failingSet = new Set(candidates.filter((el) => failure(el) !== null));
  const hiddenElements = [];
  const hiddenSeen = new Set();
  for (const el of candidates) {
    if (hiddenElements.length >= 12) break;
    const why = failure(el);
    if (!why) continue;
    let ancestor = el.parentElement;
    let coveredByAncestor = false;
    while (ancestor) {
      if (failingSet.has(ancestor)) { coveredByAncestor = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (coveredByAncestor) continue;
    const selector = selectorOf(el);
    if (hiddenSeen.has(selector)) continue;
    hiddenSeen.add(selector);
    const sceneOwner = el.closest('[data-scene-id]');
    const role = String(el.getAttribute('data-role') || '').trim();
    hiddenElements.push({
      selector,
      ...(sceneOwner ? { scene_id: String(sceneOwner.getAttribute('data-scene-id') || '').trim() } : {}),
      ...(role ? { role } : {}),
      reason: why.reason,
      ...(why.blocked_by && why.blocked_by !== selector ? { blocked_by: why.blocked_by } : {}),
      ...(typeof why.computed_opacity === 'number' ? { computed_opacity: why.computed_opacity } : {}),
      ...(el.hasAttribute('data-cover-hero') ? { cover_hero: true } : {}),
    });
  }
  return {
    visible_scene_ids: [...new Set(scenes)],
    visible_roles: [...new Set(roles)],
    visible_text: text,
    visible_elements: visibleElements,
    hidden_elements: hiddenElements,
  };
})()
`, true) as Promise<{
  visible_scene_ids: string[];
  visible_roles: string[];
  visible_text: string;
  visible_elements: VisibleSemanticElementEvidence[];
  hidden_elements: HiddenSemanticElementEvidence[];
}>,
  COMPOSITION_SCRIPT_TIMEOUT_MS,
  'E_SEMANTIC_EVIDENCE_TIMEOUT',
  'composition semantic evidence collection timed out.');
}

function sampleTimes(durationSec: number): number[] {
  const dur = Math.max(0.1, durationSec);
  return [...new Set([0, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.05)].map((n) => round2(n)))];
}

export function previewEvidenceRunDir(snapshotAbsPath: string, sourceHtml: string): string {
  const snapshotStem = path.basename(snapshotAbsPath, path.extname(snapshotAbsPath));
  const sourceHash = crypto.createHash('sha256').update(sourceHtml).digest('hex').slice(0, 12);
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return path.join(path.dirname(snapshotAbsPath), `${snapshotStem}-frames`, `${sourceHash}-${runId}`);
}

export function previewArtifactPaths(
  snapshotAbsPath: string,
  contactSheetPath: string,
  samples: FrameSampleEvidence[],
): Record<string, string> {
  const firstFramePath = samples[0]?.path || snapshotAbsPath;
  return {
    path: contactSheetPath,
    contact_sheet: contactSheetPath,
    contact_sheet_path: contactSheetPath,
    first_frame: firstFramePath,
    first_frame_path: firstFramePath,
    artifact_type: 'contact_sheet',
  };
}

export function videoCoverArtifactPath(videoAbsPath: string): string {
  const resolved = path.resolve(videoAbsPath);
  const extension = path.extname(resolved);
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;
  return `${stem}-cover.png`;
}

export async function materializeVideoCover(
  videoAbsPath: string,
  frameEvidence: FrameEvidence | null,
): Promise<{ path: string; source_frame: string; label: string }> {
  const sample = frameEvidence?.samples.find((item) => item.label === 'first-frame')
    || frameEvidence?.samples[0];
  if (!sample?.path) {
    throw new VideoStudioRuntimeError(
      'E_COVER_FRAME_MISSING',
      'The dedicated frame-0 cover could not be exported because first-frame evidence is missing.',
    );
  }
  const source = path.resolve(sample.path);
  const target = videoCoverArtifactPath(videoAbsPath);
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new VideoStudioRuntimeError(
      'E_COVER_FRAME_MISSING',
      `The dedicated frame-0 cover source is missing: ${source}`,
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (source !== target) await fs.copyFile(source, target);
  return { path: target, source_frame: source, label: sample.label };
}

/** Does every blocking preflight error live in the manifest's declarative
 *  art-direction contract?
 *
 *  Those fields (`reference_fidelity`, `cover`, the reference/anchor family)
 *  describe intent for later review; nothing about them changes what the page
 *  renders. Blocking the runtime probe on them hides the layout findings for a
 *  whole cycle: on 2026-08-07 an inspect blocked solely by
 *  REFERENCE_FIDELITY_CONTRACT_INCOMPLETE returned no layout evidence, and the
 *  13 advisory defects it would have reported only surfaced after the metadata
 *  was fixed. Anything pointing at `index.html`, timing, narration, or
 *  resources keeps the probe closed — there the rendered page really is not
 *  the one under review, and probe output would mislead. */
function preflightBlockedOnlyByDeclarativeArtDirection(preflight: CompositionPreflightResult): boolean {
  const blocking = preflight.issues.filter((issue) => issue.severity === 'error');
  return blocking.length > 0 && blocking.every((issue) => String(issue.selector || '')
    .startsWith('composition-manifest.json#art_direction'));
}

export async function inspectComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const preflight = await preflightComposition(p, 'visual-preview');
  // A declarative-only block still runs the probe so its findings arrive with
  // the metadata repair instead of one cycle later. The verdict below is
  // unchanged: the operation still fails with E_PREFLIGHT_BLOCKED and still
  // sends the model back through prepare.
  const probeDespitePreflight = !preflight.ok
    && !!preflight.meta
    && preflightBlockedOnlyByDeclarativeArtDirection(preflight);
  if ((!preflight.ok && !probeDespitePreflight) || !preflight.meta) {
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
  const narrationPending = narrationPendingInPreflight(preflight);
  const issues: Issue[] = [...preflight.issues];
  const samplePlans = buildInspectFrameSamplePlan(meta, preflight.sceneMapLoad.value, 30);
  const samples = samplePlans.map((plan) => plan.timeSec);
  let isolationProbe: SceneIsolationProbeResult | null = null;
  try {
    await withCompositionWindow(meta, p, async (win) => {
      for (const plan of samplePlans) {
        await seek(win, plan.timeSec);
        const sampleIssues = await withVideoStudioTimeout(
          win.webContents.executeJavaScript(buildInspectScript(meta, plan.timeSec, plan.sceneId), true) as Promise<Issue[]>,
          COMPOSITION_SCRIPT_TIMEOUT_MS,
          'E_INSPECT_TIMEOUT',
          `composition inspect timed out at ${round2(plan.timeSec)}s.`,
          () => {
            try { win.destroy(); }
            catch (err) { log.warn('inspect window cleanup failed', { error: logErrorSummary(err) }); }
          },
        );
        issues.push(...sampleIssues);
      }
      if (preflight.manifest) {
        // Advisory attribution probe: failures leave the record unsupported
        // but never fail or slow down the inspect verdict itself.
        isolationProbe = await withVideoStudioTimeout(
          win.webContents.executeJavaScript(buildSceneIsolationProbeScript(preflight.manifest), true) as Promise<SceneIsolationProbeResult>,
          COMPOSITION_SCRIPT_TIMEOUT_MS,
          'E_INSPECT_TIMEOUT',
          'scene isolation probe timed out.',
          () => {
            try { win.destroy(); }
            catch (err) { log.warn('isolation probe window cleanup failed', { error: logErrorSummary(err) }); }
          },
        ).catch((err) => {
          log.warn('scene isolation probe failed', { error: logErrorSummary(err) });
          return null;
        });
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
  let sceneIsolation: SceneIsolationRecord | null = null;
  if (preflight.manifest) {
    sceneIsolation = summarizeSceneIsolation({
      htmlSha256: crypto.createHash('sha256').update(meta.html).digest('hex'),
      decomposition: decomposeCompositionSceneAttribution(meta.html, preflight.manifest),
      probe: isolationProbe,
    });
    const isolationOut = sceneIsolationPath(p.compositionDirAbs);
    await fs.mkdir(path.dirname(isolationOut), { recursive: true })
      .then(() => fs.writeFile(isolationOut, JSON.stringify(sceneIsolation, null, 2), 'utf8'))
      .catch((err) => {
        log.warn('persist scene isolation record failed', { error: logErrorSummary(err) });
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
  if (probeDespitePreflight) {
    // Same verdict as the early return above — the declarative contract still
    // has to be repaired before anything proceeds — but `findings` now carries
    // the layout evidence too, so both repairs can be made in one pass.
    const result = {
      ok: false,
      op: 'composition.inspect',
      errorCode: 'E_PREFLIGHT_BLOCKED',
      message: preflight.issues.find((issue) => issue.severity === 'error')?.message || 'Composition preflight failed.',
      status: 'failed',
      stage: 'runtime_probe',
      runtime_probe_ran: true,
      blocking_error_count: preflight.issues.filter((issue) => issue.severity === 'error').length,
      preflight: preflight.report,
      preview_completeness: narrationPending ? 'visual_only' : 'complete',
      narration_pending: narrationPending,
      findings,
      next_allowed_ops: ['composition.prepare'],
    } as VideoStudioResult;
    await writeJsonIfRequested(p.findingsAbsPath, result);
    return result;
  }
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
      preview_completeness: narrationPending ? 'visual_only' : 'complete',
      narration_pending: narrationPending,
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
      preview_completeness: narrationPending ? 'visual_only' : 'complete',
      narration_pending: narrationPending,
      findings,
      inspect_disposition: disposition,
      ...(sceneIsolation ? { scene_isolation: sceneIsolationSummary(sceneIsolation) } : {}),
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
    preview_completeness: narrationPending ? 'visual_only' : 'complete',
    narration_pending: narrationPending,
    findings,
    ...(sceneIsolation ? { scene_isolation: sceneIsolationSummary(sceneIsolation) } : {}),
    next_allowed_ops: narrationPending
      ? ['composition.snapshot', 'composition.materialize_narration']
      : ['composition.snapshot', 'composition.draft'],
  } as VideoStudioResult;
  await writeJsonIfRequested(p.findingsAbsPath, result);
  return result;
}

function sceneIsolationSummary(record: SceneIsolationRecord): Record<string, unknown> {
  return {
    attributable: record.attributable,
    runtime_supported: record.runtime_supported,
    isolation: record.isolation,
    violation_count: record.violations.length,
  };
}

/** P3c R1: one-shot runtime probe over the composition timeline. Classifies
 * every leaf tween by the scene window(s) its global interval fits inside and
 * verifies its targets live in exactly that scene's section. Contract-owned
 * visibility setters (targets that ARE scene sections) are exempt. The result
 * is an advisory attribution fact, never a QA verdict. */
export function buildSceneIsolationProbeScript(manifest: CompositionManifest): string {
  const windows = manifest.scenes.map((scene) => ({ id: scene.id, start: scene.start, end: scene.start + scene.duration }));
  return `
(() => {
  const windows = ${JSON.stringify(windows)};
  const EPSILON = 0.001;
  const violations = [];
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const timelines = window.__timelines || {};
  const tl = window.__ORKAS_COMPOSITION_TIMELINE__
    || timelines[${JSON.stringify(manifest.composition.id)}]
    || timelines.main
    || timelines.root;
  if (!tl || typeof tl.getChildren !== 'function') {
    return { supported: false, isolation: false, violations: [{ reason: 'no_composition_timeline' }] };
  }
  const describeTargets = (targets) => targets.slice(0, 3).map((target) => {
    if (target && target.nodeType === 1) {
      return (target.tagName || '').toLowerCase() + (target.id ? '#' + target.id : '');
    }
    return typeof target;
  });
  const record = (violation) => {
    if (violations.length < 20) violations.push(violation);
  };
  const walk = (node, offset) => {
    const children = node.getChildren(false, true, true) || [];
    for (const child of children) {
      const start = offset + child.startTime();
      const end = offset + (typeof child.endTime === 'function'
        ? child.endTime(true)
        : child.startTime() + child.totalDuration());
      if (typeof child.getChildren === 'function') {
        walk(child, start);
        continue;
      }
      const targets = typeof child.targets === 'function' ? (child.targets() || []) : [];
      if (!targets.length) continue;
      if (targets.every((target) => target && target.nodeType === 1
        && target.hasAttribute && target.hasAttribute('data-scene-id'))) continue;
      const candidates = windows.filter((w) => start >= w.start - EPSILON && end <= w.end + EPSILON);
      if (!candidates.length) {
        record({ reason: 'tween_spans_scene_windows', start: round(start), end: round(end), targets: describeTargets(targets) });
        continue;
      }
      const targetSceneIds = new Set();
      let nonElement = false;
      let outsideScenes = false;
      for (const target of targets) {
        const el = target && target.nodeType === 1 ? target : null;
        if (!el) { nonElement = true; continue; }
        const scene = el.closest ? el.closest('[data-scene-id]') : null;
        if (!scene) { outsideScenes = true; continue; }
        targetSceneIds.add(String(scene.getAttribute('data-scene-id') || ''));
      }
      if (nonElement) {
        record({ reason: 'non_element_target', start: round(start), end: round(end), targets: describeTargets(targets) });
        continue;
      }
      if (outsideScenes) {
        record({ reason: 'target_outside_scenes', start: round(start), end: round(end), targets: describeTargets(targets) });
        continue;
      }
      if (targetSceneIds.size !== 1) {
        record({ reason: 'multi_scene_targets', start: round(start), end: round(end), targets: describeTargets(targets) });
        continue;
      }
      const sceneId = [...targetSceneIds][0];
      if (!candidates.some((w) => w.id === sceneId)) {
        record({
          reason: 'target_in_other_scene',
          expected: candidates.map((w) => w.id),
          actual: sceneId,
          start: round(start),
          end: round(end),
          targets: describeTargets(targets),
        });
      }
    }
  };
  try {
    walk(tl, 0);
  } catch (err) {
    return { supported: false, isolation: false, violations: [{ reason: 'walk_failed', message: String((err && err.message) || err) }] };
  }
  return { supported: true, isolation: violations.length === 0, violations };
})()
`;
}

export type SceneIsolationRecord = {
  version: 1;
  html_sha256: string;
  attributable: boolean;
  attribution_reasons: string[];
  runtime_supported: boolean;
  isolation: boolean;
  violations: Array<Record<string, unknown>>;
  verified_at: string;
};

type SceneIsolationProbeResult = {
  supported?: boolean;
  isolation?: boolean;
  violations?: Array<Record<string, unknown>>;
};

export function summarizeSceneIsolation(input: {
  htmlSha256: string;
  decomposition: SceneAttributionDecomposition;
  probe: SceneIsolationProbeResult | null;
}): SceneIsolationRecord {
  const runtimeSupported = input.probe?.supported === true;
  return {
    version: 1,
    html_sha256: input.htmlSha256,
    attributable: input.decomposition.attributable,
    attribution_reasons: input.decomposition.reasons,
    runtime_supported: runtimeSupported,
    isolation: input.decomposition.attributable && runtimeSupported && input.probe?.isolation === true,
    violations: Array.isArray(input.probe?.violations) ? input.probe.violations.slice(0, 20) : [],
    verified_at: new Date().toISOString(),
  };
}

function sceneIsolationPath(compositionDirAbs: string): string {
  return path.join(compositionDirAbs, 'qa', 'scene-isolation.json');
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
    // The convention is the host's, and the caller cannot infer it: frames
    // belong under the composition's own preview/ directory, where a snapshot
    // does not change the composition signature.
    return {
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_OUTPUT_REQUIRED',
      message: 'snapshot output path is required: pass the frame destination inside this composition, conventionally preview/first-frame.png.',
    };
  }
  const preflight = await preflightComposition(p, 'visual-preview');
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
  const narrationPending = narrationPendingInPreflight(preflight);
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
      preview_completeness: narrationPending ? 'visual_only' : 'complete',
      narration_pending: narrationPending,
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
    const evidenceDirAbs = p.frameEvidenceDirAbs
      || previewEvidenceRunDir(p.snapshotAbsPath, meta.html);
    await fs.mkdir(evidenceDirAbs, { recursive: true });
    const capturedSamples: FrameSampleEvidence[] = [];
    const captureSample = async (
      win: ElectronBrowserWindow,
      index: number,
      retryCount = 0,
    ): Promise<FrameSampleEvidence> => {
      const plan = plans[index];
      await seek(win, plan.timeSec);
      await settleCompositionPaint(win);
      const semanticEvidence = await readFrameSemanticEvidence(win);
      const captureFrame = async (): Promise<ReturnType<typeof normalizeCapturedFrame>> => {
        const shot = await withVideoStudioTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: meta.width, height: meta.height }),
          COMPOSITION_CAPTURE_TIMEOUT_MS,
          'E_SNAPSHOT_TIMEOUT',
          `composition snapshot timed out while capturing preview frame ${index + 1}/${plans.length}.`,
          () => { try { win.destroy(); } catch { /* best effort */ } },
        );
        return normalizeCapturedFrame(shot, meta.width, meta.height);
      };
      let normalizedCapture = await captureFrame();
      // The preview is what the user approves, so a frame that came back blank
      // while the page held content must not reach them either.
      let contradictedRetries = 0;
      while (
        contradictedRetries < COMPOSITION_CONTRADICTED_CAPTURE_MAX_RETRIES
        && captureContradictsDom(
          analyzeNativeImage(normalizedCapture.image),
          semanticEvidence,
          (area) => regionContrast(normalizedCapture.image, area),
        )
      ) {
        contradictedRetries += 1;
        await settleCompositionPaint(win);
        normalizedCapture = await captureFrame();
      }
      const image = normalizedCapture.image;
      const png = image.toPNG();
      if (index === 0) await fs.writeFile(p.snapshotAbsPath!, png);
      const samplePath = path.join(evidenceDirAbs, `${String(index + 1).padStart(2, '0')}-${plan.label}.png`);
      await fs.writeFile(samplePath, png);
      return {
        label: plan.label,
        time_seconds: round2(plan.timeSec),
        frame_index: plan.frameIndex,
        path: samplePath,
        ...(plan.sceneId ? { expected_scene_id: plan.sceneId } : {}),
        capture_source_width: normalizedCapture.sourceWidth,
        capture_source_height: normalizedCapture.sourceHeight,
        capture_scale_factor: normalizedCapture.scaleFactor,
        ...(retryCount + contradictedRetries > 0 ? { capture_retry_count: retryCount + contradictedRetries } : {}),
        ...semanticEvidence,
        ...analyzeNativeImage(image),
      };
    };
    await withCompositionWindow(meta, p, async (win) => {
      for (const [index, plan] of plans.entries()) {
        capturedSamples.push(await captureSample(win, index));
        p.onProgress?.({
          phase: 'composition.snapshot.capture',
          message: `Captured preview frame ${index + 1}/${plans.length}.`,
          data: { frame: index + 1, totalFrames: plans.length, timeSec: plan.timeSec },
        });
      }
    });
    const suspiciousIndexes = capturedSamples
      .map((sample, index) => index > 0 && isSuspiciousCrossSceneDuplicate(capturedSamples[index - 1], sample) ? index : -1)
      .filter((index) => index >= 0);
    if (suspiciousIndexes.length) {
      await withCompositionWindow(meta, p, async (win) => {
        for (const index of suspiciousIndexes) {
          capturedSamples[index] = await captureSample(win, index, 1);
          p.onProgress?.({
            phase: 'composition.snapshot.recapture',
            message: `Recaptured semantically inconsistent preview frame ${index + 1}/${plans.length} in a fresh renderer.`,
            data: { frame: index + 1, totalFrames: plans.length, timeSec: plans[index].timeSec },
          });
        }
      });
    }
    const previewRevision = path.basename(evidenceDirAbs);
    const contactSheet = await writeFrameContactSheet(evidenceDirAbs, capturedSamples);
    const publicArtifacts = previewArtifactPaths(p.snapshotAbsPath, contactSheet, capturedSamples);
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
      sceneWindows: manifest.scenes.map((scene) => ({
        id: scene.id, start: scene.start, duration: scene.duration,
      })),
      requireSemanticCoverage: true,
      ...(p.isDeliveredOpening === false ? { isDeliveredOpening: false } : {}),
      ...(p.waivedQaFindings?.length ? { waivedFindings: p.waivedQaFindings } : {}),
      designContract: preflight.contractLoad.value,
      sceneMap: preflight.sceneMapLoad.value,
    });
    const st = await fs.stat(contactSheet);
    if (previewQa.ok === false) {
      const result = {
        ok: false,
        op: 'composition.snapshot',
        errorCode: 'E_PREVIEW_QA_BLOCKED',
        message: 'Preview frame coverage or scene semantics failed QA.',
        status: 'failed',
        stage: 'preview',
        blocking_error_count: Number(previewQa.error_count || 0),
        ...publicArtifacts,
        bytes: st.size,
        preview_revision: previewRevision,
        frame_paths: frameEvidence.frame_paths,
        frame_evidence: frameEvidence,
        preview_qa: previewQa,
        preflight: preflight.report,
        preview_completeness: narrationPending ? 'visual_only' : 'complete',
        narration_pending: narrationPending,
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
        ...publicArtifacts,
        bytes: st.size,
        preview_revision: previewRevision,
        frame_paths: frameEvidence.frame_paths,
        frame_evidence: frameEvidence,
        preview_qa: reviewQa,
        inspect_disposition: inspectDisposition,
        preflight: preflight.report,
        preview_completeness: narrationPending ? 'visual_only' : 'complete',
        narration_pending: narrationPending,
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
      ...publicArtifacts,
      bytes: st.size,
      preview_revision: previewRevision,
      frame_paths: frameEvidence.frame_paths,
      frame_evidence: frameEvidence,
      preview_qa: previewQa,
      preflight: preflight.report,
      preview_completeness: narrationPending ? 'visual_only' : 'complete',
      narration_pending: narrationPending,
      visual_regression: visualRegression,
      design_review_inputs: designReviewInputs,
      preview_ready: true,
      next_allowed_ops: ['composition.draft'],
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

/** R0 fast path: returns a complete render result when the prior video track
 * is provably identical for this key, or null to fall through to the full
 * frame-capture render. Every failure inside is a silent fallback, never an
 * error surface — reuse is an optimization, not a contract. */
async function attemptVideoTrackReuse(
  p: CompositionOptions,
  meta: CompositionMeta,
  ctx: {
    fps: number;
    totalFrames: number;
    ffmpeg: string;
    ffprobe: string;
    renderProfile: NativeRenderProfile;
  },
): Promise<VideoStudioResult | null> {
  if (!p.visualSignature || !p.outputAbsPath) return null;
  const windows = await readCompositionWindowVector(p.compositionDirAbs);
  if (!windows) return null;
  const key = buildRenderReuseKey({
    visualSignature: p.visualSignature,
    windows,
    width: meta.width,
    height: meta.height,
    fps: ctx.fps,
    quality: p.quality,
    format: p.format,
  });
  const entry = (await readRenderProvenance(p.compositionDirAbs)).find((candidate) => candidate.key === key) || null;
  const priorVideoSha256 = entry ? await sha256File(entry.video_path) : null;
  const evidenceRequired = !!p.frameEvidenceDirAbs;
  let priorSamplesPresent = false;
  if (entry?.samples?.length) {
    priorSamplesPresent = (await Promise.all(
      entry.samples.map((sample) => fs.stat(sample.path).then(() => true, () => false)),
    )).every(Boolean);
  }
  const decision = evaluateVideoTrackReuse({ entry, priorVideoSha256, evidenceRequired, priorSamplesPresent });
  if (!decision.reuse || !entry) return null;
  const startedAt = Date.now();
  const outputDir = path.dirname(p.outputAbsPath);
  const outputExt = path.extname(p.outputAbsPath) || (p.format === 'webm' ? '.webm' : '.mp4');
  const tempOutputAbsPath = path.join(
    outputDir,
    `.${path.basename(p.outputAbsPath, path.extname(p.outputAbsPath))}.remuxing-${crypto.randomUUID()}${outputExt}`,
  );
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const remux = await runProcess(ctx.ffmpeg, buildVideoTrackRemuxArgs({
      priorVideoAbsPath: entry.video_path,
      outputAbsPath: tempOutputAbsPath,
      durationSec: meta.durationSec,
      ...(p.format ? { format: p.format } : {}),
      audioTracks: meta.audioTracks,
    }), { timeoutMs: VIDEO_TRACK_REMUX_TIMEOUT_MS, ...(p.signal ? { signal: p.signal } : {}) });
    if (remux.code !== 0) {
      log.warn('video track remux failed; falling back to full render', { code: remux.code });
      await fs.rm(tempOutputAbsPath, { force: true }).catch((err) => {
        log.warn('failed remux cleanup failed', { error: logErrorSummary(err) });
      });
      return null;
    }
    const probe = await probeMedia(ctx.ffprobe, tempOutputAbsPath, p.signal);
    if (!probe?.video || probe.duration_seconds === null) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch((err) => {
        log.warn('invalid remux cleanup failed', { error: logErrorSummary(err) });
      });
      return null;
    }
    let frameEvidence: FrameEvidence | undefined;
    let copiedSamples: FrameSampleEvidence[] = [];
    if (evidenceRequired && p.frameEvidenceDirAbs && entry.samples?.length) {
      await fs.mkdir(p.frameEvidenceDirAbs, { recursive: true });
      for (const sample of entry.samples) {
        const target = path.join(p.frameEvidenceDirAbs, path.basename(sample.path));
        if (path.resolve(target) !== path.resolve(sample.path)) {
          await fs.copyFile(sample.path, target);
        }
        copiedSamples.push({ ...sample, path: target, reused_from_prior_render: true });
      }
      const contactSheet = await writeFrameContactSheet(p.frameEvidenceDirAbs, copiedSamples);
      frameEvidence = {
        evidence_dir: p.frameEvidenceDirAbs,
        contact_sheet: contactSheet,
        frame_paths: copiedSamples.map((sample) => sample.path),
        samples: copiedSamples,
      };
    }
    await fs.rename(tempOutputAbsPath, p.outputAbsPath);
    const st = await fs.stat(p.outputAbsPath);
    const outputSha = await sha256File(p.outputAbsPath);
    if (outputSha) {
      await upsertRenderProvenance(p.compositionDirAbs, {
        ...entry,
        video_path: p.outputAbsPath,
        video_sha256: outputSha,
        ...(frameEvidence
          ? { evidence_dir: frameEvidence.evidence_dir, contact_sheet: frameEvidence.contact_sheet, samples: copiedSamples }
          : {}),
        rendered_at: new Date().toISOString(),
      }).catch((err) => {
        log.warn('reused render provenance refresh failed', { error: logErrorSummary(err) });
      });
    }
    const totalSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const renderProfile: NativeRenderProfile = {
      ...ctx.renderProfile,
      frame_pipeline: 'video_track_reuse',
      total_render_seconds: round2(totalSeconds),
      frame_bytes_streamed: 0,
      temporary_frame_bytes: 0,
    };
    p.onProgress?.({
      phase: 'composition.render',
      message: 'Visual inputs and scene windows are unchanged; reusing the prior rendered video track and remixing audio only.',
      data: { framePipeline: 'video_track_reuse', totalFrames: ctx.totalFrames },
    });
    return {
      ok: true,
      op: 'composition.render',
      path: p.outputAbsPath,
      bytes: st.size,
      media: versionedChatMediaLocalUrl(p.outputAbsPath),
      probe,
      engine: 'orkas-native',
      fps: ctx.fps,
      frames: ctx.totalFrames,
      canvas: { width: meta.width, height: meta.height, durationSec: meta.durationSec },
      render_profile: renderProfile,
      reused_video_track: true,
      ...(frameEvidence ? { frame_evidence: frameEvidence } : {}),
    };
  } catch (err) {
    await fs.rm(tempOutputAbsPath, { force: true }).catch((cleanupErr) => {
      log.warn('remux rollback cleanup failed', { error: logErrorSummary(cleanupErr) });
    });
    if (p.signal?.aborted) throw err;
    log.warn('video track reuse attempt failed; falling back to full render', { error: logErrorSummary(err) });
    return null;
  }
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
const SEGMENT_CACHE_META_VERSION = 1;

type SegmentCacheSample = Omit<FrameSampleEvidence, 'path'> & { cache_relative_path: string };

type SegmentCacheMeta = {
  version: typeof SEGMENT_CACHE_META_VERSION;
  scene_id: string;
  frame_range: [number, number];
  fps: number;
  samples: SegmentCacheSample[];
};

export type SceneFrameRange = {
  sceneId: string;
  window: { start: number; duration: number };
  startFrame: number;
  endFrame: number;
};

/** Partition [0, totalFrames) at scene-start boundaries. Uses starts only, so
 * the partition is total even when manifest windows carry tolerance gaps. */
export function computeSceneFrameRanges(
  windows: RenderWindowVector,
  fps: number,
  totalFrames: number,
): SceneFrameRange[] | null {
  if (!windows.length || !Number.isFinite(fps) || fps <= 0 || totalFrames < 1) return null;
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const boundaries = sorted.map((window, index) => (index === 0
    ? 0
    : Math.max(0, Math.min(totalFrames, Math.ceil(window.start * fps - 1e-6)))));
  const ranges: SceneFrameRange[] = [];
  for (const [index, window] of sorted.entries()) {
    const startFrame = boundaries[index];
    const endFrame = index + 1 < sorted.length ? boundaries[index + 1] : totalFrames;
    if (endFrame < startFrame) return null;
    ranges.push({
      sceneId: window.id,
      window: { start: window.start, duration: window.duration },
      startFrame,
      endFrame,
    });
  }
  return ranges;
}

export function buildSceneSegmentKey(input: {
  sceneId: string;
  window: { start: number; duration: number };
  frameRange: [number, number];
  subtreeSha256: string;
  motionRegionSha256: string;
  sharedSurfaceSha256: string;
  sceneAssetsSha256: string;
  sharedAssetsSha256: string;
  fps: number;
  width: number;
  height: number;
  quality: string | undefined;
  format: string | undefined;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    v: 2,
    scene: input.sceneId,
    window: [input.window.start, input.window.duration],
    frames: input.frameRange,
    subtree: input.subtreeSha256,
    motion: input.motionRegionSha256,
    shared: input.sharedSurfaceSha256,
    scene_assets: input.sceneAssetsSha256,
    shared_assets: input.sharedAssetsSha256,
    fps: input.fps,
    width: input.width,
    height: input.height,
    quality: input.quality ?? 'unset',
    format: input.format ?? 'mp4',
  })).digest('hex');
}

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
): Promise<string> {
  const queue: Array<{ ref: string; baseDirAbs: string }> = extractHtmlResourceRefs(parseHtmlStructure(htmlFragment))
    .map((item) => ({ ref: item.ref, baseDirAbs: compositionDirAbs }));
  const visited = new Set<string>();
  const assets: Array<[string, string]> = [];

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const abs = safeResolveLocalRefFromBase(compositionDirAbs, item.baseDirAbs, item.ref);
    if (!abs || visited.has(abs) || SEGMENT_VISUAL_SIGNATURE_EXCLUDED_AUDIO_RE.test(abs)) continue;
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

async function readSegmentCacheMeta(entryDirAbs: string): Promise<SegmentCacheMeta | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(entryDirAbs, 'meta.json'), 'utf8')) as SegmentCacheMeta;
    if (parsed?.version !== SEGMENT_CACHE_META_VERSION || !Array.isArray(parsed.frame_range)) return null;
    return parsed;
  } catch (err) {
    logOptionalReadFailure('segment cache metadata read failed', err);
    return null;
  }
}

export async function pruneSegmentCache(
  cacheDirAbs: string,
  removeEntry: (dirAbs: string) => Promise<void> = (dirAbs) => fs.rm(dirAbs, { recursive: true, force: true }),
): Promise<void> {
  try {
    const entries = await fs.readdir(cacheDirAbs, { withFileTypes: true });
    const stats: Array<{ dirAbs: string; mtimeMs: number; bytes: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
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

async function attemptSceneSegmentAssembly(
  p: CompositionOptions,
  meta: CompositionMeta,
  ctx: {
    fps: number;
    totalFrames: number;
    ffmpeg: string;
    ffprobe: string;
    renderProfile: NativeRenderProfile;
  },
): Promise<VideoStudioResult | null> {
  if (!p.segmentCacheDirAbs || !p.outputAbsPath || !p.visualSignature) return null;
  const windows = await readCompositionWindowVector(p.compositionDirAbs);
  if (!windows || windows.length < 2) return null;
  const ranges = computeSceneFrameRanges(windows, ctx.fps, ctx.totalFrames);
  if (!ranges) return null;

  // Isolation must be proven for the exact current HTML bytes.
  const htmlSha = sha256Text(meta.html);
  let isolation: SceneIsolationRecord | null = null;
  try {
    isolation = JSON.parse(await fs.readFile(sceneIsolationPath(p.compositionDirAbs), 'utf8')) as SceneIsolationRecord;
  } catch (err) {
    logOptionalReadFailure('scene isolation record read failed', err);
    return null;
  }
  if (!isolation || isolation.version !== 1 || isolation.isolation !== true || isolation.html_sha256 !== htmlSha) {
    return null;
  }

  let manifest: CompositionManifest;
  try {
    const parsed = CompositionManifestSchema.safeParse(
      JSON.parse(await fs.readFile(path.join(p.compositionDirAbs, 'composition-manifest.json'), 'utf8')),
    );
    if (!parsed.success) return null;
    manifest = parsed.data;
  } catch (err) {
    logOptionalReadFailure('segment assembly manifest read failed', err);
    return null;
  }
  const decomposition = decomposeCompositionSceneAttribution(meta.html, manifest);
  if (!decomposition.attributable) return null;

  const sharedSha = sha256Text(decomposition.shared_surface);
  let segments: Array<{ range: SceneFrameRange; key: string }>;
  try {
    const sharedAssetsSha256 = await videoStudioReferencedVisualAssetSignature(
      p.compositionDirAbs,
      decomposition.shared_surface,
    );
    segments = await Promise.all(ranges.map(async (range) => {
      const subtree = decomposition.scene_subtrees[range.sceneId] ?? '';
      const motionRegion = decomposition.scene_motion_regions[range.sceneId] ?? '';
      return {
        range,
        key: buildSceneSegmentKey({
          sceneId: range.sceneId,
          window: range.window,
          frameRange: [range.startFrame, range.endFrame],
          subtreeSha256: sha256Text(subtree),
          motionRegionSha256: sha256Text(motionRegion),
          sharedSurfaceSha256: sharedSha,
          sceneAssetsSha256: await videoStudioReferencedVisualAssetSignature(
            p.compositionDirAbs,
            `${subtree}\n${motionRegion}`,
          ),
          sharedAssetsSha256,
          fps: ctx.fps,
          width: meta.width,
          height: meta.height,
          quality: p.quality,
          format: p.format,
        }),
      };
    }));
  } catch (err) {
    log.warn('scene segment dependency fingerprint failed; falling back to full render', {
      error: logErrorSummary(err),
    });
    return null;
  }

  const evidenceDirAbs = p.frameEvidenceDirAbs;
  const requestedSampleTimes = p.frameSampleTimes || [];
  const samplePlans: FrameSamplePlan[] = evidenceDirAbs
    ? requestedSampleTimes.map((item) => ({
      label: samplePlanKey(item.label),
      timeSec: Math.max(0, Math.min(meta.durationSec - 0.001, item.timeSec)),
      frameIndex: Math.max(0, Math.min(ctx.totalFrames - 1, Math.floor(Math.max(0, item.timeSec) * ctx.fps))),
      ...(item.sceneId ? { sceneId: item.sceneId } : {}),
    }))
    : [];
  const planSegmentOf = (plan: FrameSamplePlan) => segments.find(
    (segment) => plan.frameIndex >= segment.range.startFrame && plan.frameIndex < segment.range.endFrame,
  );

  type SegmentJob = typeof segments[number] & { entryDirAbs: string; cachedMeta: SegmentCacheMeta | null };
  const jobs: SegmentJob[] = [];
  for (const segment of segments) {
    const entryDirAbs = path.join(p.segmentCacheDirAbs, segment.key);
    let cachedMeta = await readSegmentCacheMeta(entryDirAbs);
    if (cachedMeta && !(await fs.stat(path.join(entryDirAbs, 'segment.mp4')).then((st) => st.isFile(), () => false))) {
      cachedMeta = null;
    }
    if (cachedMeta && evidenceDirAbs) {
      // A cached segment must carry every scene-anchored sample its range owns,
      // or draft evidence would silently thin out. Missing samples demote the
      // segment to a fresh render.
      const owned = samplePlans.filter((plan) => plan.sceneId && planSegmentOf(plan)?.key === segment.key);
      const labels = new Set(cachedMeta.samples.map((sample) => sample.label));
      if (!owned.every((plan) => labels.has(plan.label))) cachedMeta = null;
    }
    jobs.push({ ...segment, entryDirAbs, cachedMeta });
  }

  const dirty = jobs.filter((job) => !job.cachedMeta);
  const globalPlans = samplePlans.filter((plan) => !plan.sceneId);
  const needsWindow = dirty.length > 0 || globalPlans.length > 0;
  const startedAt = Date.now();
  const outputDir = path.dirname(p.outputAbsPath);
  const workDirAbs = path.join(outputDir, `.segment-assembly-${crypto.randomUUID()}`);
  const collected = new Map<string, { evidence: FrameSampleEvidence; reused: boolean }>();

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(workDirAbs, { recursive: true });
    if (evidenceDirAbs) await fs.mkdir(evidenceDirAbs, { recursive: true });

    if (needsWindow) {
      await withCompositionWindow(meta, p, async (win) => {
        for (const job of dirty) {
          const frameCount = job.range.endFrame - job.range.startFrame;
          if (frameCount <= 0) continue;
          const stagingDirAbs = path.join(workDirAbs, `render-${job.key.slice(0, 12)}`);
          await fs.mkdir(path.join(stagingDirAbs, 'samples'), { recursive: true });
          const segmentTmpAbs = path.join(stagingDirAbs, 'segment.mp4');
          const ownedPlans = evidenceDirAbs
            ? samplePlans.filter((plan) => plan.sceneId && planSegmentOf(plan)?.key === job.key)
            : [];
          const planByFrame = new Map<number, FrameSamplePlan>();
          for (const plan of ownedPlans) {
            if (!planByFrame.has(plan.frameIndex)) planByFrame.set(plan.frameIndex, plan);
          }
          const segmentSamples: SegmentCacheSample[] = [];
          const encoder = startRawFrameEncoder({
            ffmpeg: ctx.ffmpeg,
            outputAbsPath: segmentTmpAbs,
            width: meta.width,
            height: meta.height,
            fps: ctx.fps,
            format: p.format ?? 'mp4',
            quality: p.quality,
            audioTracks: [],
            durationSec: frameCount / ctx.fps,
            signal: p.signal,
          });
          try {
            for (let frame = job.range.startFrame; frame < job.range.endFrame; frame += 1) {
              if (p.signal?.aborted) throw new Error('render aborted');
              const t = Math.min(frame / ctx.fps, Math.max(0, meta.durationSec - 0.001));
              await seek(win, t);
              const plan = planByFrame.get(frame);
              const semanticEvidence = plan ? await readFrameSemanticEvidence(win) : null;
              const capturedImage = await withVideoStudioTimeout(
                win.webContents.capturePage({ x: 0, y: 0, width: meta.width, height: meta.height }),
                COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
                'E_RENDER_CAPTURE_TIMEOUT',
                `segment render timed out while capturing frame ${frame + 1}.`,
                () => {
                  try { win.destroy(); }
                  catch (err) { log.warn('segment render window cleanup failed', { error: logErrorSummary(err) }); }
                },
              );
              const normalized = normalizeCapturedFrame(capturedImage, meta.width, meta.height);
              await withVideoStudioTimeout(
                encoder.writeFrame(normalized.image.toBitmap()),
                COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
                'E_RENDER_PIPE_TIMEOUT',
                `segment render timed out while streaming frame ${frame + 1}.`,
                () => encoder.cancel(),
              );
              if (plan) {
                const stats = analyzeNativeImage(normalized.image);
                const relative = path.join('samples', `${plan.label}.png`);
                await fs.writeFile(path.join(stagingDirAbs, relative), normalized.image.toPNG());
                segmentSamples.push({
                  label: plan.label,
                  time_seconds: round2(plan.timeSec),
                  frame_index: frame,
                  ...(plan.sceneId ? { expected_scene_id: plan.sceneId } : {}),
                  capture_source_width: normalized.sourceWidth,
                  capture_source_height: normalized.sourceHeight,
                  capture_scale_factor: normalized.scaleFactor,
                  ...(semanticEvidence || {}),
                  ...stats,
                  cache_relative_path: relative,
                });
              }
            }
            const encoded = await encoder.finish();
            if (encoded.aborted || encoded.timedOut || encoded.code !== 0) {
              throw new Error(`segment encode failed (code ${encoded.code}).`);
            }
          } catch (err) {
            encoder.cancel();
            await encoder.wait().catch((waitErr) => {
              log.warn('segment encoder cleanup failed', { error: logErrorSummary(waitErr) });
              return null;
            });
            throw err;
          }
          const segmentProbe = await probeMedia(ctx.ffprobe, segmentTmpAbs, p.signal);
          if (!segmentProbe?.video) throw new Error('segment media could not be probed.');
          await fs.writeFile(path.join(stagingDirAbs, 'meta.json'), JSON.stringify({
            version: SEGMENT_CACHE_META_VERSION,
            scene_id: job.range.sceneId,
            frame_range: [job.range.startFrame, job.range.endFrame],
            fps: ctx.fps,
            samples: segmentSamples,
          } satisfies SegmentCacheMeta, null, 2), 'utf8');
          await fs.rm(job.entryDirAbs, { recursive: true, force: true }).catch((err) => {
            log.warn('stale segment cache cleanup failed', { error: logErrorSummary(err) });
          });
          await fs.mkdir(path.dirname(job.entryDirAbs), { recursive: true });
          await fs.rename(stagingDirAbs, job.entryDirAbs);
          job.cachedMeta = await readSegmentCacheMeta(job.entryDirAbs);
          if (!job.cachedMeta) throw new Error('segment cache entry did not persist.');
        }
        if (evidenceDirAbs) {
          for (const plan of globalPlans) {
            await seek(win, plan.timeSec);
            await settleCompositionPaint(win);
            const semanticEvidence = await readFrameSemanticEvidence(win);
            const capturedImage = await withVideoStudioTimeout(
              win.webContents.capturePage({ x: 0, y: 0, width: meta.width, height: meta.height }),
              COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
              'E_RENDER_CAPTURE_TIMEOUT',
              `sample capture timed out at ${round2(plan.timeSec)}s.`,
              () => {
                try { win.destroy(); }
                catch (err) { log.warn('sample capture window cleanup failed', { error: logErrorSummary(err) }); }
              },
            );
            const normalized = normalizeCapturedFrame(capturedImage, meta.width, meta.height);
            const stats = analyzeNativeImage(normalized.image);
            const evidence: FrameSampleEvidence = {
              label: plan.label,
              time_seconds: round2(plan.timeSec),
              frame_index: plan.frameIndex,
              path: '',
              capture_source_width: normalized.sourceWidth,
              capture_source_height: normalized.sourceHeight,
              capture_scale_factor: normalized.scaleFactor,
              ...(semanticEvidence || {}),
              ...stats,
            } as FrameSampleEvidence;
            collected.set(plan.label, {
              reused: false,
              evidence: { ...evidence, path: path.join(workDirAbs, `${plan.label}.png`) },
            });
            await fs.writeFile(path.join(workDirAbs, `${plan.label}.png`), normalized.image.toPNG());
          }
        }
      });
    }

    if (evidenceDirAbs) {
      for (const job of jobs) {
        if (!job.cachedMeta) throw new Error('segment unexpectedly missing after render.');
        const wasReused = dirty.every((candidate) => candidate.key !== job.key);
        for (const sample of job.cachedMeta.samples) {
          const { cache_relative_path: relative, ...rest } = sample;
          collected.set(sample.label, {
            reused: wasReused,
            evidence: { ...rest, path: path.join(job.entryDirAbs, relative) } as FrameSampleEvidence,
          });
        }
      }
    }

    const parts = jobs.filter((job) => job.range.endFrame > job.range.startFrame);
    if (!parts.length) return null;
    const concatListAbs = path.join(workDirAbs, 'segments.txt');
    await fs.writeFile(concatListAbs, parts.map((job) => (
      `file '${path.join(job.entryDirAbs, 'segment.mp4').replace(/'/g, "'\\''")}'`
    )).join('\n'), 'utf8');
    const concatVideoAbs = path.join(workDirAbs, `video${p.format === 'webm' ? '.webm' : '.mp4'}`);
    const concatRun = await runProcess(ctx.ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListAbs, '-c', 'copy', concatVideoAbs,
    ], { timeoutMs: VIDEO_TRACK_REMUX_TIMEOUT_MS, ...(p.signal ? { signal: p.signal } : {}) });
    if (concatRun.code !== 0) throw new Error(`segment concat failed (code ${concatRun.code}).`);

    const outputExt = path.extname(p.outputAbsPath) || (p.format === 'webm' ? '.webm' : '.mp4');
    const tempOutputAbsPath = path.join(
      outputDir,
      `.${path.basename(p.outputAbsPath, path.extname(p.outputAbsPath))}.assembling-${crypto.randomUUID()}${outputExt}`,
    );
    const remux = await runProcess(ctx.ffmpeg, buildVideoTrackRemuxArgs({
      priorVideoAbsPath: concatVideoAbs,
      outputAbsPath: tempOutputAbsPath,
      durationSec: meta.durationSec,
      ...(p.format ? { format: p.format } : {}),
      audioTracks: meta.audioTracks,
    }), { timeoutMs: VIDEO_TRACK_REMUX_TIMEOUT_MS, ...(p.signal ? { signal: p.signal } : {}) });
    if (remux.code !== 0) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch((err) => {
        log.warn('failed segment remux cleanup failed', { error: logErrorSummary(err) });
      });
      throw new Error(`segment assembly remux failed (code ${remux.code}).`);
    }
    const probe = await probeMedia(ctx.ffprobe, tempOutputAbsPath, p.signal);
    if (!probe?.video || probe.duration_seconds === null) {
      await fs.rm(tempOutputAbsPath, { force: true }).catch((err) => {
        log.warn('invalid segment remux cleanup failed', { error: logErrorSummary(err) });
      });
      throw new Error('assembled media could not be probed.');
    }

    let frameEvidence: FrameEvidence | undefined;
    if (evidenceDirAbs) {
      const ordered: FrameSampleEvidence[] = [];
      for (const plan of samplePlans) {
        const item = collected.get(plan.label);
        if (!item) continue;
        const target = path.join(evidenceDirAbs, `${String(ordered.length + 1).padStart(2, '0')}-${plan.label}.png`);
        await fs.copyFile(item.evidence.path, target);
        ordered.push({
          ...item.evidence,
          path: target,
          ...(item.reused ? { reused_from_prior_render: true } : {}),
        });
      }
      const contactSheet = await writeFrameContactSheet(evidenceDirAbs, ordered);
      frameEvidence = {
        evidence_dir: evidenceDirAbs,
        contact_sheet: contactSheet,
        frame_paths: ordered.map((sample) => sample.path),
        samples: ordered,
      };
    }

    await fs.rename(tempOutputAbsPath, p.outputAbsPath);
    const st = await fs.stat(p.outputAbsPath);
    if (p.visualSignature) {
      const videoSha = await sha256File(p.outputAbsPath);
      if (videoSha) {
        await upsertRenderProvenance(p.compositionDirAbs, {
          key: buildRenderReuseKey({
            visualSignature: p.visualSignature,
            windows,
            width: meta.width,
            height: meta.height,
            fps: ctx.fps,
            quality: p.quality,
            format: p.format,
          }),
          visual_signature: p.visualSignature,
          windows,
          width: meta.width,
          height: meta.height,
          fps: ctx.fps,
          quality: p.quality ?? 'unset',
          format: p.format ?? 'mp4',
          video_path: p.outputAbsPath,
          video_sha256: videoSha,
          ...(frameEvidence
            ? {
              evidence_dir: frameEvidence.evidence_dir,
              contact_sheet: frameEvidence.contact_sheet,
              samples: frameEvidence.samples,
            }
            : {}),
          rendered_at: new Date().toISOString(),
        }).catch((err) => {
          log.warn('segment render provenance persistence failed', { error: logErrorSummary(err) });
        });
      }
    }
    await pruneSegmentCache(p.segmentCacheDirAbs);
    const totalSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const renderProfile: NativeRenderProfile = {
      ...ctx.renderProfile,
      frame_pipeline: 'scene_segment_assembly',
      total_render_seconds: round2(totalSeconds),
    };
    p.onProgress?.({
      phase: 'composition.render',
      message: `Scene attribution verified; rendered ${dirty.length} changed scene segment(s) and reused ${jobs.length - dirty.length} cached segment(s).`,
      data: { framePipeline: 'scene_segment_assembly', segmentsTotal: jobs.length, segmentsRendered: dirty.length },
    });
    return {
      ok: true,
      op: 'composition.render',
      path: p.outputAbsPath,
      bytes: st.size,
      media: versionedChatMediaLocalUrl(p.outputAbsPath),
      probe,
      engine: 'orkas-native',
      fps: ctx.fps,
      frames: ctx.totalFrames,
      canvas: { width: meta.width, height: meta.height, durationSec: meta.durationSec },
      render_profile: renderProfile,
      scene_segments: {
        total: jobs.length,
        rendered: dirty.length,
        reused: jobs.length - dirty.length,
      },
      ...(frameEvidence ? { frame_evidence: frameEvidence } : {}),
    };
  } catch (err) {
    if (p.signal?.aborted) throw err;
    log.warn('scene segment assembly failed; falling back to full render', { error: logErrorSummary(err) });
    return null;
  } finally {
    await fs.rm(workDirAbs, { recursive: true, force: true }).catch((err) => {
      log.warn('segment assembly workspace cleanup failed', { error: logErrorSummary(err) });
    });
  }
}

/** One image of the whole assembled video, segments in playback order.
 *
 * An AUTO production's frames live per child composition, so the keyframe
 * preview used to arrive as one contact sheet per segment — four links for a
 * five-segment video on 2026-08-07, with the user's own opening footage absent
 * because a media segment has no snapshot to publish. The stop exists so the
 * user can judge the whole video in one look, and only the host can compose
 * that: it owns every segment's frames and the order they play in.
 *
 * A media segment contributes one extracted frame so the footage the user
 * supplied appears beside the authored scenes. Best effort throughout — a
 * segment that yields nothing is skipped rather than failing the preview.
 */
export async function writeProductionContactSheet(input: {
  outputDirAbs: string;
  segments: Array<{
    segmentId: string;
    framePaths?: string[];
    mediaPath?: string;
  }>;
  signal?: AbortSignal;
}): Promise<string> {
  const bins = bundledFfmpegPaths();
  await fs.mkdir(input.outputDirAbs, { recursive: true });
  const samples: FrameSampleEvidence[] = [];
  for (const segment of input.segments) {
    for (const framePath of segment.framePaths || []) {
      if (!(await fs.access(framePath).then(() => true).catch(() => false))) continue;
      const label = path.basename(framePath).replace(/^\d+-/, '').replace(/\.png$/i, '');
      samples.push({
        label: `${segment.segmentId} · ${label}`,
        time_seconds: 0,
        frame_index: 0,
        path: framePath,
        hash: '',
        brightness: 0,
        contrast: 0,
        width: 0,
        height: 0,
      } as FrameSampleEvidence);
    }
    if (segment.framePaths?.length || !segment.mediaPath || !bins.ffmpeg) continue;
    // A cut or generated shot: pull one representative frame so the segment is
    // visible in the overview instead of silently missing from it.
    const stillPath = path.join(input.outputDirAbs, `segment-${segment.segmentId}-still.png`);
    const extracted = await runProcess(bins.ffmpeg, [
      '-y', '-loglevel', 'error',
      '-ss', '0.5', '-i', segment.mediaPath,
      '-frames:v', '1', '-q:v', '3', stillPath,
    ], { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: 30_000 }).catch(() => null);
    if (extracted?.code !== 0) continue;
    if (!(await fs.access(stillPath).then(() => true).catch(() => false))) continue;
    samples.push({
      label: `${segment.segmentId} · clip`,
      time_seconds: 0,
      frame_index: 0,
      path: stillPath,
      hash: '',
      brightness: 0,
      contrast: 0,
      width: 0,
      height: 0,
    } as FrameSampleEvidence);
  }
  if (!samples.length) return '';
  // Cells are labelled by segment and frame: across compositions a per-cell
  // timeline offset means nothing, and "@ 0s" on every cell would be false.
  return writeFrameContactSheet(input.outputDirAbs, samples, { labelOnly: true });
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
    return {
      ok: false,
      op: 'composition.render',
      errorCode: 'E_OUTPUT_REQUIRED',
      message: 'output path is required, and it must sit outside composition_dir so a runtime file cannot invalidate authored-input approvals — conventionally project/render/<name>.mp4.',
    };
  }
  const requestedFps = qualityFps(p.quality, p.fps, await declaredCompositionFps(p.compositionDirAbs));
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
  const reused = await attemptVideoTrackReuse(p, loaded.meta, {
    fps,
    totalFrames,
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
    renderProfile,
  });
  if (reused) return reused;
  const assembled = await attemptSceneSegmentAssembly(p, loaded.meta, {
    fps,
    totalFrames,
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
    renderProfile,
  });
  if (assembled) return assembled;
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
        if (frame === 0) {
          // The first capture races the compositor: seek(0) applies the
          // scene-reveal styles, but capturePage returns the last composited
          // frame, and nothing has painted since the window loaded with every
          // scene scaffold-hidden. The snapshot path settles before every
          // capture and its frame 0 passes; this loop skipped settling for
          // throughput and its frame 0 captured the pre-reveal state — a
          // blank opening at background luminance on an HTML whose snapshot
          // had just passed QA (2026-08-07). Later frames are safe: each
          // capture composites the previous frame's already-painted state,
          // one frame apart at most. Only the first needs the explicit wait.
          await settleCompositionPaint(win);
        }
        const sample = sampleByFrame.get(frame);
        const semanticEvidence = sample ? await readFrameSemanticEvidence(win) : null;
        const captureFrame = async (): Promise<ReturnType<typeof normalizeCapturedFrame>> => {
          const shot = await withVideoStudioTimeout(
            win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height }),
            COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
            'E_RENDER_CAPTURE_TIMEOUT',
            `composition render timed out while capturing frame ${frame + 1}/${totalFrames}.`,
            () => { try { win.destroy(); } catch { /* best effort */ } },
          );
          return normalizeCapturedFrame(shot, loaded.meta!.width, loaded.meta!.height);
        };
        let normalizedCapture = await captureFrame();
        // Re-shoot BEFORE the frame reaches the encoder: once it is streamed it
        // is in the video, and every later check is reporting a defect the host
        // could have prevented here. Only sampled frames carry the DOM evidence
        // this compares against, and frame 0 — the one that races the
        // compositor — is always sampled.
        let captureRetryCount = 0;
        while (
          semanticEvidence
          && captureRetryCount < COMPOSITION_CONTRADICTED_CAPTURE_MAX_RETRIES
          && captureContradictsDom(
          analyzeNativeImage(normalizedCapture.image),
          semanticEvidence,
          (area) => regionContrast(normalizedCapture.image, area),
        )
        ) {
          captureRetryCount += 1;
          await settleCompositionPaint(win);
          normalizedCapture = await captureFrame();
        }
        if (captureRetryCount > 0) {
          log.warn('composition render recaptured a frame whose pixels contradicted the page', {
            frame,
            retries: captureRetryCount,
          });
        }
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
            ...(captureRetryCount > 0 ? { capture_retry_count: captureRetryCount } : {}),
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
      log.warn('persist render profile failed', { error: logErrorSummary(err) });
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
    if (p.visualSignature) {
      const windows = await readCompositionWindowVector(p.compositionDirAbs);
      const videoSha = windows ? await sha256File(p.outputAbsPath) : null;
      if (windows && videoSha) {
        await upsertRenderProvenance(p.compositionDirAbs, {
          key: buildRenderReuseKey({
            visualSignature: p.visualSignature,
            windows,
            width: loaded.meta.width,
            height: loaded.meta.height,
            fps,
            quality: p.quality,
            format: p.format,
          }),
          visual_signature: p.visualSignature,
          windows,
          width: loaded.meta.width,
          height: loaded.meta.height,
          fps,
          quality: p.quality ?? 'unset',
          format: p.format ?? 'mp4',
          video_path: p.outputAbsPath,
          video_sha256: videoSha,
          ...(frameEvidence
            ? {
              evidence_dir: frameEvidence.evidence_dir,
              contact_sheet: frameEvidence.contact_sheet,
              samples: capturedSamples,
            }
            : {}),
          rendered_at: new Date().toISOString(),
        }).catch((err) => {
          log.warn('persist render provenance failed', { error: logErrorSummary(err) });
        });
      }
    }
    return {
      ok: true,
      op: 'composition.render',
      path: p.outputAbsPath,
      bytes: st.size,
      media: versionedChatMediaLocalUrl(p.outputAbsPath),
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
    filters.push(`[${inputIndex}:a]volume=${volume},${delay}apad,atrim=0:${duration}[a${index}]`);
  });
  if (tracks.length === 1) {
    filters.push('[a0]anull[aout]');
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
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', String(crfForQuality(opts.quality)), '-movflags', '+faststart');
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

function startRawFrameEncoder(opts: FrameEncoderOptions): {
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
    try { killProcessTree(child, 'SIGKILL'); } catch { /* best effort */ }
  };
  const onAbort = () => {
    if (!child.stdin.destroyed) child.stdin.destroy();
    terminate();
    settle(-1);
  };
  timer = setTimeout(() => {
    timedOut = true;
    terminate();
    settle(-1);
  }, RENDER_TIMEOUT_MS);
  timer.unref?.();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
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
      if (!settled) {
        terminate();
        settle(-1);
      }
    },
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
      message: `The initial draft plus ${DRAFT_REPAIR_MAX_PASSES} materially different repair pass(es) still failed for this input history. Stop repeating the same render strategy, preserve the evidence, and make a different canonical edit before retrying.`,
    };
    await writeReportIfRequested(p.reportAbsPath, report);
    return {
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_REPAIR_BUDGET_EXCEEDED',
      message: 'The previous draft repair strategies did not resolve the recorded quality failure for this exact composition input. Preserve the current artifacts, inspect the last failure, make a materially different edit to the canonical inputs, and retry after the input signature changes.',
      report,
      repair_budget: repairBudget.summary,
      last_error: repairBudget.summary.last_error,
      blocked_operation: 'composition.draft',
      same_input_retry_allowed: false,
      requires_user_decision: false,
      allowed_recovery_ops: [
        'composition.status',
        'composition.reconcile',
        'composition.prepare',
        'composition.lint',
        'composition.inspect',
      ],
      next_action: 'repair_inputs_then_retry_draft',
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
    const narrationPending = narrationPendingInPreflight(preflight);
    return failDraft(report, p, 'E_PREFLIGHT_BLOCKED', 'composition manifest/HTML/source/audio preflight failed before rendering.', {
      repair_target: firstError?.selector || 'composition-manifest.json',
      preflight: preflight.report,
      next_allowed_ops: narrationPending
        ? [
          'composition.materialize_narration',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ]
        : ['composition.prepare'],
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
  const fps = qualityFps(p.quality, p.fps, await declaredCompositionFps(p.compositionDirAbs));
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
  const renderedCandidate = {
    path: renderPath,
    media: render.media,
    contact_sheet: renderedFrameEvidence?.contact_sheet || '',
    frame_paths: renderedFrameEvidence?.frame_paths || [],
    frame_evidence: renderedFrameEvidence,
    draft_ready: false,
  };
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
        ...renderedCandidate,
        media_qa: mediaQa,
      }, repairBudget);
    }
    const videoQa = summarizeVideoFrameQa(renderedFrameEvidence, metaForRender.durationSec, {
      sceneCount: preflight.manifest.scenes.length,
      expectedSceneIds: preflight.manifest.scenes.map((scene) => scene.id),
      sceneWindows: preflight.manifest.scenes.map((scene) => ({
        id: scene.id, start: scene.start, duration: scene.duration,
      })),
      requireSemanticCoverage: true,
      ...(p.isDeliveredOpening === false ? { isDeliveredOpening: false } : {}),
      ...(p.waivedQaFindings?.length ? { waivedFindings: p.waivedQaFindings } : {}),
      designContract: preflight.contractLoad.value,
      sceneMap: preflight.sceneMapLoad.value,
    });
    steps.video_qa = videoQa;
    if (videoQa.ok === false) {
      return failDraft(report, p, 'E_VIDEO_QA_BLOCKED', 'video-level QA failed; repair the canonical manifest, mapped content, or visual HTML before Gate D.', {
        ...renderedCandidate,
        video_qa: videoQa,
      }, repairBudget);
    }
  }

  let coverArtifact: { path: string; source_frame: string; label: string };
  try {
    coverArtifact = await materializeVideoCover(renderPath, renderedFrameEvidence);
  } catch (err) {
    const code = err instanceof VideoStudioRuntimeError ? err.errorCode : 'E_COVER_EXPORT_FAILED';
    return failDraft(report, p, code, (err as Error).message || 'Dedicated video cover export failed.', {
      ...renderedCandidate,
      frame_evidence: renderedFrameEvidence,
    }, repairBudget);
  }

  const successBudget = await recordDraftSuccess(repairBudget, p.reportAbsPath, render.path as string | undefined);
  steps.repair_budget = successBudget;
  report.repair_budget = successBudget;
  report.ok = true;
  report.media = { path: renderPath, bytes: finalBytes };
  report.cover = coverArtifact;
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
    cover_path: coverArtifact.path,
    cover_media: versionedChatMediaLocalUrl(coverArtifact.path),
    bytes: finalBytes,
    report_path: p.reportAbsPath || '',
    findings_path: p.findingsAbsPath || '',
    media: versionedChatMediaLocalUrl(renderPath),
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
    const ex = await runProcess(bins.ffmpeg, ['-y', '-i', p.inputAbsPath, '-vn', '-ac', '1', '-ar', '16000', wav], { signal: p.signal, timeoutMs: 20 * 60 * 1000 });
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
    p.onProgress?.({ phase: 'speech.transcribe.asr', message: 'Running Orkas-native whisper.cpp transcription.' });
    const timestampDetail = p.timestamps === 'word' ? 'word' : 'segment';
    const args = buildSpeechTranscribeArgs(backend.model, wav, outBase, {
      language: p.language,
      timestamps: timestampDetail,
    });
    const tr = await runProcess(backend.cli, args, { signal: p.signal, timeoutMs: 45 * 60 * 1000 });
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
