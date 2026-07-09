import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

import { bundledFfmpegPaths, bundledWhisperPaths } from '../util/bundled-runtime';
import { redactPaths } from '../util/redact';
import { createLogger } from '../logger';
import {
  DRAFT_REPAIR_MAX_PASSES,
  analyzeNativeImage,
  buildDraftFrameSamplePlan,
  initDraftRepairBudget,
  loadDesignContract,
  loadNarrationMap,
  loadSceneMap,
  loadShotlist,
  parseFindingsPayload,
  recordDraftFailure,
  recordDraftSuccess,
  runAudioTimingQa,
  runContractHtmlQa,
  runSourceAlignmentQa,
  samplePlanKey,
  summarizeDraftInspectDisposition,
  summarizeVideoFrameQa,
  writeFrameContactSheet,
  type DraftRepairBudget,
  type FrameEvidence,
  type FrameSampleEvidence,
  type FrameSamplePlan,
} from './video_studio_qa';

const log = createLogger('video-studio');

const COMPOSITION_LOAD_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_LOAD_TIMEOUT_MS) || 30_000;
const COMPOSITION_READY_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_READY_TIMEOUT_MS) || 20_000;
const COMPOSITION_SCRIPT_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_SCRIPT_TIMEOUT_MS) || 15_000;
const COMPOSITION_CAPTURE_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_CAPTURE_TIMEOUT_MS) || 15_000;
const COMPOSITION_RENDER_FRAME_TIMEOUT_MS = Number(process.env.ORKAS_VIDEO_STUDIO_RENDER_FRAME_TIMEOUT_MS) || 20_000;

export type VideoStudioOp =
  | 'composition.lint'
  | 'composition.inspect'
  | 'composition.render'
  | 'composition.draft'
  | 'composition.snapshot'
  | 'speech.transcribe';

export type RenderQuality = 'draft' | 'standard' | 'high';
export type RenderFormat = 'mp4' | 'webm';

export interface CompositionOptions {
  compositionDirAbs: string;
  outputAbsPath?: string;
  reportAbsPath?: string;
  findingsAbsPath?: string;
  snapshotAbsPath?: string;
  quality?: RenderQuality;
  fps?: number;
  format?: RenderFormat;
  variables?: Record<string, unknown>;
  frameEvidenceDirAbs?: string;
  frameSampleTimes?: Array<{ label: string; timeSec: number }>;
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

type Issue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
};

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
  degrade_ineffective?: string;
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

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
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
  const noHash = normalizeRef(ref).split('#')[0].split('?')[0];
  if (isIgnorableRef(noHash) || isRemoteRef(noHash) || path.isAbsolute(noHash)) return null;
  let decoded = noHash;
  try { decoded = decodeURIComponent(noHash); } catch { /* keep raw */ }
  const abs = path.resolve(compositionDirAbs, decoded);
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

function extractResourceRefs(html: string): Array<{ attr: string; ref: string }> {
  const refs: Array<{ attr: string; ref: string }> = [];
  const re = /\b(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    refs.push({ attr: m[1].toLowerCase(), ref: normalizeRef(m[2] ?? m[3] ?? '') });
  }
  const cssRe = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]+))\s*\)/gi;
  while ((m = cssRe.exec(html)) !== null) {
    refs.push({ attr: 'css-url', ref: normalizeRef(m[1] ?? m[2] ?? m[3] ?? '') });
  }
  return refs;
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

async function readObservedGpuMode(compositionDirAbs: string): Promise<'hardware' | 'software' | undefined> {
  const mocked = process.env.ORKAS_MOCK_OBSERVED_GPU_MODE;
  if (mocked === 'hardware' || mocked === 'software') return mocked;
  try {
    const parsed = JSON.parse(await fs.readFile(renderProfilePath(compositionDirAbs), 'utf8')) as { gpuMode?: unknown };
    return parsed.gpuMode === 'hardware' || parsed.gpuMode === 'software' ? parsed.gpuMode : undefined;
  } catch {
    return undefined;
  }
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

async function resolveNativeRenderProfile(
  compositionDirAbs: string,
  meta: CompositionMeta,
  quality: RenderQuality | undefined,
  requestedFps: number,
): Promise<NativeRenderProfile> {
  const ramGB = machineRamGB();
  const observedGpuMode = await readObservedGpuMode(compositionDirAbs);
  const constrained = isConstrainedMachine(ramGB, observedGpuMode);
  const costUnits = estimateRenderCost(meta.width, meta.height, meta.durationSec, requestedFps);
  const decision = renderCostDecision({ constrained, costUnits, isFinal: quality === 'high' });
  const renderFps = decision === 'degrade' ? degradedFps(requestedFps) : requestedFps;
  return {
    constrained,
    machine_ram_gb: ramGB,
    ...(observedGpuMode ? { observed_gpu_mode: observedGpuMode } : {}),
    cost_units: costUnits,
    decision,
    requested_fps: requestedFps,
    render_fps: renderFps,
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
  const rootTag = html.match(/<[^>]+\bdata-composition-id\s*=\s*["'][^"']+["'][^>]*>/i)?.[0] ?? '';
  const rootAttrs = rootTag ? parseAttrs(rootTag) : {};
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

  const refs = extractResourceRefs(html);
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
    const abs = safeResolveLocalRef(compositionDirAbs, item.ref);
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

  const audioRe = /<audio\b[^>]*>/gi;
  let audioMatch: RegExpExecArray | null;
  while ((audioMatch = audioRe.exec(html)) !== null) {
    const attrs = parseAttrs(audioMatch[0]);
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

export async function lintComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const { meta, issues } = await loadCompositionMeta(p.compositionDirAbs);
  const findings = findingsJson(issues, {
    engine: 'orkas-native',
    profile: 'orkas-html-composition',
    canvas: meta ? { width: meta.width, height: meta.height, durationSec: meta.durationSec } : null,
  });
  return { ok: true, op: 'composition.lint', findings };
}

function fileUrl(absPath: string): string {
  let resolved = path.resolve(absPath).replace(/\\/g, '/');
  if (!resolved.startsWith('/')) resolved = `/${resolved}`;
  return encodeURI(`file://${resolved}`);
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

function videoStudioErrorCode(err: unknown, fallback: string): string {
  return err instanceof VideoStudioTimeoutError ? err.errorCode : fallback;
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
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      session: ses,
    },
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

function sampleTimes(durationSec: number): number[] {
  const dur = Math.max(0.1, durationSec);
  return [...new Set([0, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.05)].map((n) => round2(n)))];
}

export async function inspectComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: true, op: 'composition.inspect', findings: findingsJson(loaded.issues) };
  }
  const issues: Issue[] = [...loaded.issues];
  const samples = sampleTimes(loaded.meta.durationSec);
  try {
    await withCompositionWindow(loaded.meta, p, async (win) => {
      for (const t of samples) {
        await seek(win, t);
        const sampleIssues = await withVideoStudioTimeout(
          win.webContents.executeJavaScript(buildInspectScript(loaded.meta, t), true) as Promise<Issue[]>,
          COMPOSITION_SCRIPT_TIMEOUT_MS,
          'E_INSPECT_TIMEOUT',
          `composition inspect timed out at ${round2(t)}s.`,
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
  return {
    ok: true,
    op: 'composition.inspect',
    findings: findingsJson(issues, {
      engine: 'orkas-native',
      samples,
      canvas: { width: loaded.meta.width, height: loaded.meta.height, durationSec: loaded.meta.durationSec },
    }),
  };
}

function buildInspectScript(meta: CompositionMeta, tSec: number): string {
  return `
(() => {
  const issues = [];
  const width = ${meta.width};
  const height = ${meta.height};
  const tSec = ${tSec};
  const selectorFor = (el) => {
    if (!el || !el.tagName) return 'document';
    if (el.id) return '#' + el.id;
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  };
  const add = (code, severity, el, message) => issues.push({
    code, severity, selector: selectorFor(el), message: '[' + tSec.toFixed(2) + 's] ' + message, source: 'orkas-native-inspect'
  });
  const visible = (el, style) => style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.01;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (!visible(el, style)) continue;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) continue;
    if (rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1) {
      add('ELEMENT_OUT_OF_CANVAS', 'warning', el, 'element extends outside the declared video canvas.');
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) {
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        add('TEXT_OVERFLOW', 'warning', el, 'text content overflows its box.');
      }
      const fs = parseFloat(style.fontSize || '0');
      if (Number.isFinite(fs) && fs > 0 && fs < 18) {
        add('FONT_TOO_SMALL', 'warning', el, 'text is below the 18px legibility floor.');
      }
    }
  }
  return issues;
})()
`;
}

export async function snapshotComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: false, op: 'composition.snapshot', errorCode: 'E_COMPOSITION_INVALID', message: loaded.issues[0]?.message || 'composition invalid' };
  }
  if (!p.snapshotAbsPath) {
    return { ok: false, op: 'composition.snapshot', errorCode: 'E_OUTPUT_REQUIRED', message: 'snapshot output path is required.' };
  }
  await fs.mkdir(path.dirname(p.snapshotAbsPath), { recursive: true });
  try {
    await withCompositionWindow(loaded.meta, p, async (win) => {
      await seek(win, 0);
      const image = await withVideoStudioTimeout(
        win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height }),
        COMPOSITION_CAPTURE_TIMEOUT_MS,
        'E_SNAPSHOT_TIMEOUT',
        'composition snapshot timed out while capturing the frame.',
        () => { try { win.destroy(); } catch { /* best effort */ } },
      );
      await fs.writeFile(p.snapshotAbsPath!, image.toPNG());
    });
    const st = await fs.stat(p.snapshotAbsPath);
    return { ok: true, op: 'composition.snapshot', path: p.snapshotAbsPath, bytes: st.size };
  } catch (err) {
    return {
      ok: false,
      op: 'composition.snapshot',
      errorCode: videoStudioErrorCode(err, 'E_SNAPSHOT_FAILED'),
      message: (err as Error).message,
    };
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
  const renderProfile = await resolveNativeRenderProfile(p.compositionDirAbs, loaded.meta, p.quality, requestedFps);
  if (renderProfile.decision === 'fail_fast') {
    return {
      ok: false,
      op: 'composition.render',
      errorCode: 'E_RENDER_TOO_HEAVY',
      message: `This ${loaded.meta.width}x${loaded.meta.height}, ${Math.round(loaded.meta.durationSec)}s composition cannot be rendered at ${p.quality || 'standard'} quality on this constrained machine without likely hanging. Lower the resolution, fps, or length; keep the draft; or render on a stronger machine.`,
      render_profile: renderProfile,
    };
  }
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg) {
    return { ok: false, op: 'composition.render', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  }

  const fps = renderProfile.render_fps;
  const totalFrames = Math.max(1, Math.ceil(loaded.meta.durationSec * fps));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-studio-'));
  const framePattern = path.join(tmp, 'frame-%06d.png');
  const evidenceDirAbs = p.frameEvidenceDirAbs;
  const samplePlans = evidenceDirAbs
    ? (p.frameSampleTimes || sampleTimes(loaded.meta.durationSec).map((timeSec, index) => ({ label: `sample-${index + 1}`, timeSec })))
      .map((item) => ({
        label: samplePlanKey(item.label),
        timeSec: Math.max(0, Math.min(loaded.meta!.durationSec - 0.001, item.timeSec)),
        frameIndex: Math.max(0, Math.min(totalFrames - 1, Math.floor(Math.max(0, item.timeSec) * fps))),
      }))
    : [];
  const sampleByFrame = new Map<number, FrameSamplePlan>();
  for (const sample of samplePlans) {
    if (!sampleByFrame.has(sample.frameIndex)) sampleByFrame.set(sample.frameIndex, sample);
  }
  const capturedSamples: FrameSampleEvidence[] = [];
  try {
    if (evidenceDirAbs) await fs.mkdir(evidenceDirAbs, { recursive: true });
    p.onProgress?.({ phase: 'composition.render', message: `Capturing ${totalFrames} frames with the native renderer.`, data: { totalFrames, fps } });
    await withCompositionWindow(loaded.meta, p, async (win) => {
      for (let frame = 0; frame < totalFrames; frame += 1) {
        if (p.signal?.aborted) throw new Error('render aborted');
        const t = frame / fps;
        await seek(win, Math.min(t, Math.max(0, loaded.meta!.durationSec - 0.001)));
        const image = await withVideoStudioTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height }),
          COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
          'E_RENDER_CAPTURE_TIMEOUT',
          `composition render timed out while capturing frame ${frame + 1}/${totalFrames}.`,
          () => { try { win.destroy(); } catch { /* best effort */ } },
        );
        const png = image.toPNG();
        await fs.writeFile(path.join(tmp, `frame-${String(frame + 1).padStart(6, '0')}.png`), png);
        const sample = sampleByFrame.get(frame);
        if (sample && evidenceDirAbs) {
          const stats = analyzeNativeImage(image);
          const samplePath = path.join(evidenceDirAbs, `${String(capturedSamples.length + 1).padStart(2, '0')}-${sample.label}.png`);
          await fs.writeFile(samplePath, png);
          capturedSamples.push({
            label: sample.label,
            time_seconds: round2(sample.timeSec),
            frame_index: frame,
            path: samplePath,
            ...stats,
          });
        }
        if (frame % Math.max(1, Math.floor(fps * 2)) === 0) {
          p.onProgress?.({ phase: 'composition.render.capture', message: `Captured frame ${frame + 1}/${totalFrames}.`, data: { frame: frame + 1, totalFrames } });
        }
      }
    });
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
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true });
    const encoded = await encodeFrames({
      ffmpeg: bins.ffmpeg,
      framePattern,
      outputAbsPath: p.outputAbsPath,
      fps,
      format: p.format ?? 'mp4',
      quality: p.quality,
      audioTracks: loaded.meta.audioTracks,
      durationSec: loaded.meta.durationSec,
      signal: p.signal,
    });
    if (encoded.ok === false) return encoded;
    const st = await fs.stat(p.outputAbsPath);
    const probe = bins.ffprobe ? await probeMedia(bins.ffprobe, p.outputAbsPath, p.signal) : null;
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
    return {
      ok: false,
      op: 'composition.render',
      errorCode: p.signal?.aborted ? 'E_RENDER_ABORTED' : videoStudioErrorCode(err, 'E_RENDER_FAILED'),
      message: (err as Error).message,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function encodeFrames(opts: {
  ffmpeg: string;
  framePattern: string;
  outputAbsPath: string;
  fps: number;
  format: RenderFormat;
  quality?: RenderQuality;
  audioTracks: AudioTrack[];
  durationSec: number;
  signal?: AbortSignal;
}): Promise<VideoStudioResult> {
  const args = ['-y', '-framerate', String(opts.fps), '-i', opts.framePattern];
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
  const r = await runProcess(opts.ffmpeg, args, { signal: opts.signal, timeoutMs: RENDER_TIMEOUT_MS });
  if (r.aborted) return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_ABORTED', message: 'render aborted.' };
  if (r.timedOut) return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_TIMEOUT', message: 'ffmpeg encode timed out.' };
  if (r.code !== 0) {
    const stderrTail = redactPaths(r.stderr.slice(-1200));
    log.warn('ffmpeg encode failed', { code: r.code, stderr_chars: r.stderr.length, stderr_tail: stderrTail.slice(-500) });
    return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_ENCODE_FAILED', message: `ffmpeg exited ${r.code}. ${stderrTail}` };
  }
  return { ok: true, op: 'composition.render' };
}

async function runProcess(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
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
      severity: meta.audioTracks.length ? 'error' : 'warning',
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
  const budgetSummary = await recordDraftFailure(repairBudget, p.reportAbsPath, code, message, extra);
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
  const repairBudget = await initDraftRepairBudget(p.compositionDirAbs);
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

  const lint = await lintComposition(p);
  steps.lint = lint;
  if (lint.ok === false) return lint;
  const parsedLint = parseFindingsPayload(String(lint.findings || ''));
  if (parsedLint.errorCount > 0) {
    return failDraft(report, p, 'E_LINT_BLOCKED', 'composition lint failed.', {
      lint_summary: {
        error_count: parsedLint.errorCount,
        warning_count: parsedLint.warningCount,
        issues: parsedLint.issues.slice(0, 12),
      },
    }, repairBudget);
  }

  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (loaded.meta) {
    const contractLoad = await loadDesignContract(p.compositionDirAbs);
    const sceneMapLoad = await loadSceneMap(p.compositionDirAbs);
    const narrationMapLoad = await loadNarrationMap(p.compositionDirAbs);
    const shotlistLoad = await loadShotlist(p.compositionDirAbs);
    steps.authoring = {
      ok: true,
      mode: 'model_authored_html',
      path: loaded.meta.htmlPath,
      design_contract_path: contractLoad.path,
      scene_map_path: sceneMapLoad.exists ? sceneMapLoad.path : '',
      shotlist_path: shotlistLoad.exists ? shotlistLoad.path : '',
    };

    const contractHtml = await runContractHtmlQa(loaded.meta, loaded.issues, contractLoad, sceneMapLoad, p.compositionDirAbs);
    steps.contract_html = contractHtml;
    if (contractHtml.ok === false) {
      const firstError = ((contractHtml.issues as Issue[] | undefined) || []).find((issue) => issue.severity === 'error');
      return failDraft(report, p, 'E_CONTRACT_HTML_BLOCKED', 'design-contract/scene-map/index.html consistency failed draft QA.', {
        repair_target: firstError?.selector || 'index.html',
        contract_html: contractHtml,
      }, repairBudget);
    }

    const sourceAlignment = await runSourceAlignmentQa(sceneMapLoad, shotlistLoad);
    steps.source_alignment = sourceAlignment;
    if (sourceAlignment.ok === false) {
      return failDraft(report, p, 'E_SOURCE_ALIGNMENT_BLOCKED', 'script/shotlist/scene-map alignment failed draft QA.', {
        repair_target: 'scene-map.json',
        source_alignment: sourceAlignment,
      }, repairBudget);
    }

    const audioTiming = await runAudioTimingQa(loaded.meta, contractLoad, sceneMapLoad, narrationMapLoad, p.compositionDirAbs);
    steps.audio_timing = audioTiming;
    if (audioTiming.ok === false) {
      const firstError = ((audioTiming.issues as Issue[] | undefined) || []).find((issue) => issue.severity === 'error');
      return failDraft(report, p, 'E_AUDIO_TIMING_BLOCKED', 'audio timing or narration mapping failed draft QA.', {
        repair_target: firstError?.selector || 'scene-map.json',
        audio_timing: audioTiming,
      }, repairBudget);
    }
  }

  const inspect = await inspectComposition(p);
  const inspectDisposition = inspect.ok
    ? summarizeDraftInspectDisposition(String(inspect.findings || ''))
    : { blocking_error_count: 1, advisory_count: 0, blocking_issues: [], advisory_issues: [] };
  steps.inspect = {
    ...inspect,
    draft_disposition: inspectDisposition,
  };
  if (inspect.ok === false) return inspect;
  if (p.findingsAbsPath && inspect.ok) {
    await fs.mkdir(path.dirname(p.findingsAbsPath), { recursive: true });
    await fs.writeFile(p.findingsAbsPath, String(inspect.findings || ''), 'utf8');
  }
  if (Number(inspectDisposition.blocking_error_count || 0) > 0) {
    return failDraft(report, p, 'E_INSPECT_BLOCKED', 'inspect found non-visual blockers; repair design-contract/scene-map/HTML before rendering.', {
      inspect_summary: parseFindingsPayload(String(inspect.findings || '')),
      draft_disposition: inspectDisposition,
    }, repairBudget);
  }

  const metaForRender = loaded.meta ?? (await loadCompositionMeta(p.compositionDirAbs)).meta;
  const sceneMapForSamples = await loadSceneMap(p.compositionDirAbs);
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
    const videoQa = summarizeVideoFrameQa(((render as { frame_evidence?: FrameEvidence }).frame_evidence ?? null), metaForRender.durationSec);
    steps.video_qa = videoQa;
    if (videoQa.ok === false) {
      return failDraft(report, p, 'E_VIDEO_QA_BLOCKED', 'video-level QA failed; repair design-contract/scene-map/HTML before Gate D.', {
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
    next_action: 'open_gate_d',
    report,
  };
}

async function writeReportIfRequested(reportAbsPath: string | undefined, report: Record<string, unknown>): Promise<void> {
  if (!reportAbsPath) return;
  await fs.mkdir(path.dirname(reportAbsPath), { recursive: true });
  await fs.writeFile(reportAbsPath, JSON.stringify(report, null, 2), 'utf8');
  report.report_path = reportAbsPath;
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
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_INPUT', message: `input is not a file: ${p.inputAbsPath}` };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-transcribe-'));
  const wav = path.join(tmp, 'audio.wav');
  const outBase = path.join(tmp, 'transcript');
  try {
    p.onProgress?.({ phase: 'speech.transcribe.extract', message: 'Extracting mono 16 kHz audio for transcription.' });
    const ex = await runProcess(bins.ffmpeg, ['-y', '-i', p.inputAbsPath, '-vn', '-ac', '1', '-ar', '16000', wav], { signal: p.signal, timeoutMs: 20 * 60 * 1000 });
    if (ex.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED', message: ex.stderr.slice(-1200) };
    }
    p.onProgress?.({ phase: 'speech.transcribe.asr', message: 'Running Orkas-native whisper.cpp transcription.' });
    const args = ['-m', backend.model, '-f', wav, '-oj', '-of', outBase];
    if (p.language && p.language !== 'auto') args.push('-l', p.language);
    const tr = await runProcess(backend.cli, args, { signal: p.signal, timeoutMs: 45 * 60 * 1000 });
    if (tr.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_FAILED', message: tr.stderr.slice(-1200) || tr.stdout.slice(-1200) };
    }
    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_OUTPUT', message: 'transcriber produced no JSON output.' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { raw }; }
    if (p.transcriptAbsPath) {
      await fs.mkdir(path.dirname(p.transcriptAbsPath), { recursive: true });
      await fs.writeFile(p.transcriptAbsPath, JSON.stringify(parsed, null, 2), 'utf8');
    }
    return {
      ok: true,
      op: 'speech.transcribe',
      summary: parsed,
      transcript_path: p.transcriptAbsPath || '',
      backend: 'orkas-native:whisper.cpp',
      backend_source: backend.source,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
