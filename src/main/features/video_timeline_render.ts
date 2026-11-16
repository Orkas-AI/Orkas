/**
 * Turns one timeline video into an mp4: footage is extracted to stills, each scene
 * is captured frame by frame into a cached segment, the segments are joined without
 * re-encoding, and the sound is mixed over the result.
 *
 * Footage reaches the page as stills because a seeked <video> is not frame-accurate:
 * in the measured comparison the old adapter showed the wrong source frame on 100 of
 * 150 frames, and exact seeking cost more per frame than decoding a JPEG. Scene
 * segments are keyed by content and not by position, so moving a scene re-renders
 * nothing and editing one scene's words re-renders that scene alone.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow, NativeImage } from 'electron';

import { createLogger } from '../logger';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { versionedChatMediaLocalUrl } from '../util/chat-media-url';
import { writeBytesAtomic } from '../storage';
import { fileEditLock } from '../util/locks';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { redactPaths } from '../util/redact';
import { sha256OfFileStream } from '../util/sha256';
import {
  acquireCompositionRenderSlot,
  analyzeLoudness,
  buildMediaQa,
  buildInspectScript,
  buildVideoTrackRemuxArgs,
  COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
  COMPOSITION_SCRIPT_TIMEOUT_MS,
  loadCompositionMeta,
  normalizeAudioInPlace,
  normalizeCapturedFrame,
  probeMedia,
  pruneSegmentCache,
  qualityFps,
  resolveNativeRenderProfile,
  RENDER_TIMEOUT_MS,
  runVideoProcessForTest,
  SEGMENT_CACHE_STAGING_DIR_NAME,
  SEGMENT_RENDER_MAX_ATTEMPTS,
  settleCompositionPaint,
  shouldNormalizeLoudness,
  startRawFrameEncoder,
  VIDEO_TRACK_REMUX_TIMEOUT_MS,
  videoStudioErrorCode,
  videoStudioReferencedVisualAssetSignature,
  withCompositionWindow,
  withVideoStudioTimeout,
  type AudioTrack,
  type CompositionMeta,
  type MediaProbe,
  type RenderQuality,
  type VideoStudioResult,
} from './video_studio';
import { analyzeNativeImage, dedupeInspectIssues, writeFrameContactSheet, type Issue } from './video_studio_qa';
import {
  buildTimelineSceneKey,
  buildVideoTimelineAdapterScript,
  captionCues,
  compileVideoPage,
  deriveVideoTimeline,
  dominantFlatShare,
  pagePictureIssues,
  pagePictureRefs,
  sheetLayoutFor,
  summarizeCheckWarnings,
  boundedCheckWarning,
  parseVideoManifest,
  timelineAudioTracks,
  validateVideoTimeline,
  VideoAssetLedgerSchema,
  VideoProductSchema,
  type CaptionFrameCue,
  type CheckWarningRow,
  type CompiledVideoPage,
  type ContractIssue,
  type DerivedClip,
  type DerivedScene,
  type DerivedTimeline,
  type VideoAssetRecord,
  type VideoManifestV3,
  type VideoProduct,
} from './video_timeline';

const log = createLogger('video-timeline');

const SOURCE = 'orkas-video-timeline';
const SEGMENT_META_VERSION = 1;
const WORK_DIR_PREFIX = '.segment-assembly-';
const STALE_WORK_DIR_MS = 24 * 60 * 60 * 1000;
const FRAME_EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
/** A source's last frames can fall a frame or two short of its nominal length. */
const CLIP_FRAME_SHORTFALL_TOLERANCE = 2;
const MAX_REPORTED_PAGE_ERRORS = 8;
const SHEET_MAX_FRAMES = 32;
const CHECK_SAMPLES_PER_SCENE = 3;
/** Past this, nearly all of the frame is one flat colour. Measured on live runs: words on a
 *  blank field score 97%, a designed page with a plain background and a large product card
 *  56-73%. At 55%, good designs got reworked for four rounds at five times the tokens. */
const EMPTY_FRAME_SHARE_HINT = 0.9;
const EMPTY_FRAME_PROBE_WIDTH = 36;
/** The most Chromium accepts for an offscreen window. */
const RENDER_OFFSCREEN_FRAME_RATE = 240;
const LAST_RENDER_FILE = '.last-render.json';
/** Which scenes a viewer could see right now, however the page hides the others. */
const SHOWN_SCENES_SCRIPT = `Array.from(document.querySelectorAll('[data-scene-id]')).filter((section) => {
  const style = getComputedStyle(section);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
}).map((section) => section.getAttribute('data-scene-id'))`;
/** Captures of a frame the window jumped to. A frame that matches the one before it uses them
 *  all, about 30 ms each. */
const JUMP_FRAME_MAX_CAPTURES = 6;
/** A line counts as on the product when a quarter of it lies there; less only grazes it. */
const PRODUCT_COVER_MIN_SHARE = 0.25;
/** The first check and two fixes ask to move words off the product; after that it is listed
 *  among the warnings, since a product filling the frame can leave no room beside it. */
const WORDS_ON_PRODUCT_ASKS = 3;
const WORDS_ON_PRODUCT_NAMED = 3;

type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** Where the marked part of an image lands on the canvas, from how the page draws the image:
 *  its laid-out size before transforms, its box after them, its natural size, object-fit and
 *  object-position. It also runs inside the page, so it uses nothing from outside itself. */
export function productRectOnCanvas(image: {
  box: { left: number; top: number; width: number; height: number };
  layout: { width: number; height: number };
  natural: { width: number; height: number };
  fit: string;
  position: string;
}, subject: readonly number[]): ScreenRect | null {
  const unit = (value: number | undefined) => Math.min(1, Math.max(0, Number(value) || 0));
  const [a, b, c, d] = [unit(subject[0]), unit(subject[1]), unit(subject[2]), unit(subject[3])];
  const left = Math.min(a, c);
  const right = Math.max(a, c);
  const top = Math.min(b, d);
  const bottom = Math.max(b, d);
  const { width, height } = image.layout;
  const { width: naturalWidth, height: naturalHeight } = image.natural;
  if (!(width > 0 && height > 0 && naturalWidth > 0 && naturalHeight > 0) || right <= left || bottom <= top) return null;
  const scale = image.fit === 'cover' ? Math.max(width / naturalWidth, height / naturalHeight)
    : image.fit === 'contain' ? Math.min(width / naturalWidth, height / naturalHeight)
      : image.fit === 'scale-down' ? Math.min(1, width / naturalWidth, height / naturalHeight)
        : image.fit === 'none' ? 1 : 0;
  const drawnWidth = scale ? naturalWidth * scale : width;
  const drawnHeight = scale ? naturalHeight * scale : height;
  const [xToken, yToken] = String(image.position || '').trim().split(/\s+/);
  const offset = (token: string | undefined, free: number) => {
    if (!token || token === 'center') return free / 2;
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return free;
    if (token.endsWith('%')) return (parseFloat(token) / 100) * free;
    const pixels = parseFloat(token);
    return Number.isFinite(pixels) ? pixels : free / 2;
  };
  const x0 = offset(xToken, width - drawnWidth);
  const y0 = offset(yToken, height - drawnHeight);
  const scaleX = image.box.width / width;
  const scaleY = image.box.height / height;
  const at = (value: number) => Math.round(value * 100) / 100;
  return {
    left: at(image.box.left + (x0 + left * drawnWidth) * scaleX),
    top: at(image.box.top + (y0 + top * drawnHeight) * scaleY),
    right: at(image.box.left + (x0 + right * drawnWidth) * scaleX),
    bottom: at(image.box.top + (y0 + bottom * drawnHeight) * scaleY),
  };
}

/** How much of a line of words lies on the product, as a share of the line's own area. */
export function shareOnProduct(line: ScreenRect, product: ScreenRect): number {
  const width = Math.max(0, Math.min(line.right, product.right) - Math.max(line.left, product.left));
  const height = Math.max(0, Math.min(line.bottom, product.bottom) - Math.max(line.top, product.top));
  const area = Math.max(0, line.right - line.left) * Math.max(0, line.bottom - line.top);
  return area > 0 ? (width * height) / area : 0;
}

/** Each shown line of words with how much of it lies on a marked product, measured on the
 *  glyphs rather than the element box: a full-width heading with a short word is not on the
 *  product just because its box crosses it. Captions count too. */
function buildProductCoverScript(subjects: Record<string, readonly number[]>, canvas: { width: number; height: number }): string {
  return `(() => {
  // The dev loader keeps function names with a helper the page does not have.
  const __name = (fn) => fn;
  const productRectOnCanvas = ${productRectOnCanvas.toString()};
  const shareOnProduct = ${shareOnProduct.toString()};
  const subjects = ${JSON.stringify(subjects)};
  const canvas = ${JSON.stringify(canvas)};
  const shown = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const visibleArea = (el) => {
    const area = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
    for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (!/hidden|clip/.test(style.overflowX + ' ' + style.overflowY)) continue;
      const box = node.getBoundingClientRect();
      area.left = Math.max(area.left, box.left);
      area.top = Math.max(area.top, box.top);
      area.right = Math.min(area.right, box.right);
      area.bottom = Math.min(area.bottom, box.bottom);
    }
    return area;
  };
  const products = [];
  for (const image of document.querySelectorAll('img[data-clip]')) {
    const subject = subjects[image.getAttribute('data-clip')];
    if (!subject || !shown(image)) continue;
    const style = getComputedStyle(image);
    const box = image.getBoundingClientRect();
    const rect = productRectOnCanvas({
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      layout: { width: image.offsetWidth, height: image.offsetHeight },
      natural: { width: image.naturalWidth, height: image.naturalHeight },
      fit: style.objectFit,
      position: style.objectPosition,
    }, subject);
    if (!rect) continue;
    const area = visibleArea(image);
    const seen = {
      left: Math.max(rect.left, area.left),
      top: Math.max(rect.top, area.top),
      right: Math.min(rect.right, area.right),
      bottom: Math.min(rect.bottom, area.bottom),
    };
    if (seen.right - seen.left > 1 && seen.bottom - seen.top > 1) products.push(seen);
  }
  if (!products.length) return [];
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text || !node.parentElement || !shown(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    let share = 0;
    for (const line of range.getClientRects()) {
      for (const product of products) share = Math.max(share, shareOnProduct(line, product));
    }
    if (share > 0) found.push({ text: text.slice(0, 40), share: Math.round(share * 100) / 100 });
  }
  return found;
})()`;
}

export type VideoProjectPaths = {
  productionDirAbs: string;
  videoDirAbs: string;
  /** Roots a ledger path may resolve into. The ledger is a workspace file, so its
   *  paths get the same check as any other model-written path. */
  allowedRoots: readonly string[];
};

export type VideoProgress = (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;

export type VideoRenderOptions = VideoProjectPaths & {
  outputAbsPath: string;
  /** Machine-private store of rendered scene segments. */
  segmentCacheDirAbs: string;
  quality?: RenderQuality;
  fps?: number;
  allowFpsFallback?: boolean;
  signal?: AbortSignal;
  onProgress?: VideoProgress;
};

type AssetFacts = {
  record: VideoAssetRecord;
  absPath: string;
  durationSec?: number;
  width?: number;
  height?: number;
  sha256?: string;
};

export type LoadedVideoProject = {
  manifest: VideoManifestV3 | null;
  assets: VideoAssetRecord[];
  product: VideoProduct | null;
  html: string | null;
  issues: ContractIssue[];
};

async function readOptionalText(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function fileIssue(code: string, selector: string, message: string): ContractIssue {
  return { code, severity: 'error', selector, message, source: SOURCE };
}

function parseJsonFile<T>(raw: string, selector: string, parse: (value: unknown) => T, issues: ContractIssue[]): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    issues.push(fileIssue('PROJECT_FILE_NOT_JSON', selector, `${selector} is not valid JSON: ${(err as Error).message}`));
    return null;
  }
  try {
    return parse(value);
  } catch (err) {
    issues.push(fileIssue('PROJECT_FILE_INVALID', selector, `${selector} does not match its schema: ${(err as Error).message.slice(0, 400)}`));
    return null;
  }
}

export async function loadVideoProject(paths: VideoProjectPaths): Promise<LoadedVideoProject> {
  const issues: ContractIssue[] = [];
  // Fixed project filenames are model-written paths too: checking only media
  // rows leaves manifest/product/page symlinks outside the task's authority.
  for (const [directory, selector] of [
    [paths.videoDirAbs, 'manifest.json'], [paths.videoDirAbs, 'index.html'],
    [paths.videoDirAbs, LAST_RENDER_FILE], [paths.videoDirAbs, 'upgrade-notes.md'],
    [paths.productionDirAbs, 'assets.json'], [paths.productionDirAbs, 'product.json'],
  ]) {
    if (!isPathAllowed(path.join(directory, selector), paths.allowedRoots)) {
      return { manifest: null, assets: [], product: null, html: null, issues: [
        fileIssue('RESOURCE_OUT_OF_SCOPE', selector, `Resource reference escapes the composition directory: ${selector}`),
      ] };
    }
  }
  const manifestRaw = await readOptionalText(path.join(paths.videoDirAbs, 'manifest.json'));
  let manifest: VideoManifestV3 | null = null;
  if (manifestRaw === null) {
    issues.push(fileIssue(
      'TIMELINE_MANIFEST_MISSING',
      'manifest.json',
      `No manifest.json at ${path.join(paths.videoDirAbs, 'manifest.json')}. production_dir is the folder that holds videos/<video_id>/manifest.json.`
        // A montage cut with ffmpeg was handed back unfinished after this (2026-11-14).
        + ' Only a page timeline has one: a video made with edit_video or ffmpeg needs no check or render; deliver it'
        + ' with video.ship, its path and expect_duration_sec, expect_aspect and expect_audio.',
    ));
  } else {
    const parsed = parseJsonFile(manifestRaw, 'manifest.json', parseVideoManifest, issues);
    if (parsed) {
      manifest = parsed.manifest;
      issues.push(...parsed.issues);
    }
  }
  const ledgerRaw = await readOptionalText(path.join(paths.productionDirAbs, 'assets.json'));
  const ledger = ledgerRaw === null
    ? null
    : parseJsonFile(ledgerRaw, 'assets.json', (value) => VideoAssetLedgerSchema.parse(value), issues);
  const productRaw = await readOptionalText(path.join(paths.productionDirAbs, 'product.json'));
  const product = productRaw === null
    ? null
    : parseJsonFile(productRaw, 'product.json', (value) => VideoProductSchema.parse(value), issues);
  return {
    manifest,
    assets: ledger?.assets ?? [],
    product,
    html: await readOptionalText(path.join(paths.videoDirAbs, 'index.html')),
    issues,
  };
}

/** Hashes of this form count only the facts a timeline quotes. Older ones counted the whole of
 *  product.json, and are still read that way. */
const QUOTED_FACTS_HASH = 'facts:';
/** Deliveries hash what the scenes say, not how their file is laid out: the canvas writes it its
 *  own way, and a change undone there is the video that went out (decided 2026-11-11). Renders
 *  still hash the file's text, and older deliveries are read that way. */
const PARSED_SCENES_HASH = 'parsed:';

type TimelineHashForm = 'whole' | 'facts' | 'parsed';

/** The scenes as the render reads them, in the order the canvas writes them. What does not read
 *  counts as written. */
function parsedScenes(manifestRaw: string): string {
  try {
    const { manifest } = parseVideoManifest(JSON.parse(manifestRaw));
    return manifest ? JSON.stringify(manifest) : manifestRaw;
  } catch {
    return manifestRaw;
  }
}

/** The facts the scenes quote, as the page shows them. What cannot be read counts whole. */
function quotedFacts(manifestRaw: string, productRaw: string): string {
  let ids: string[];
  try {
    const { scenes } = JSON.parse(manifestRaw) as { scenes?: unknown };
    ids = [...new Set((Array.isArray(scenes) ? scenes : []).flatMap((scene) => {
      const text = (scene as { text?: unknown } | null)?.text;
      return text && typeof text === 'object'
        ? Object.values(text).flatMap((entry) => typeof (entry as { fact_id?: unknown } | null)?.fact_id === 'string' ? [(entry as { fact_id: string }).fact_id] : [])
        : [];
    }))].sort();
  } catch {
    return productRaw;
  }
  if (!ids.length) return '';
  try {
    const { facts } = JSON.parse(productRaw) as { facts?: unknown };
    const text = new Map((Array.isArray(facts) ? facts : []).map((fact) => [(fact as { id?: unknown })?.id, (fact as { text?: unknown })?.text]));
    return JSON.stringify(ids.map((id) => [id, text.get(id) ?? null]));
  } catch {
    return productRaw;
  }
}

/** What a change to a video touches: its scenes, its page and the facts it quotes. */
async function timelineSourceHash(paths: { productionDirAbs: string; videoDirAbs: string }, form: TimelineHashForm = 'facts'): Promise<string> {
  const read = async (file: string) => isPathAllowed(file, [paths.productionDirAbs]) ? await readOptionalText(file) ?? '' : '';
  const manifest = await read(path.join(paths.videoDirAbs, 'manifest.json'));
  const page = await read(path.join(paths.videoDirAbs, 'index.html'));
  const product = await read(path.join(paths.productionDirAbs, 'product.json'));
  return videoTimelineSourceHash({ manifest, page, product }, form);
}

/** The existing source fingerprint, also used by bounded read-only delivery notices. */
export function videoTimelineSourceHash(source: { manifest: string; page: string; product: string }, form: TimelineHashForm = 'facts'): string {
  const { manifest, page, product } = source;
  const scenes = form === 'parsed' ? parsedScenes(manifest) : manifest;
  const hash = crypto.createHash('sha256').update(scenes).update('\0').update(page).update('\0');
  if (form === 'whole') return hash.update(product).update('\0').digest('hex');
  const prefix = form === 'parsed' ? PARSED_SCENES_HASH : QUOTED_FACTS_HASH;
  return `${prefix}${hash.update(quotedFacts(manifest, product)).update('\0').digest('hex')}`;
}

/** Whether a recorded hash still describes the timeline, in the form it was recorded in. */
async function timelineUnchanged(recorded: unknown, paths: { productionDirAbs: string; videoDirAbs: string }): Promise<boolean> {
  if (typeof recorded !== 'string') return false;
  const form = recorded.startsWith(PARSED_SCENES_HASH) ? 'parsed' : recorded.startsWith(QUOTED_FACTS_HASH) ? 'facts' : 'whole';
  return recorded === await timelineSourceHash(paths, form);
}

/** Whether this file is the video's last render and the timeline has changed since. Bytes
 *  cannot say: the output policy can rewrite the file in place at the end of a turn. A file
 *  from anywhere else, such as one made from the render with ffmpeg, cannot be judged. */
export async function renderedBeforeLastChange(input: { productionDirAbs: string; videoDirAbs: string; fileAbs: string }): Promise<boolean> {
  const record = await readLastRender(input.videoDirAbs);
  if (typeof record?.output !== 'string' || path.resolve(input.productionDirAbs, record.output) !== path.resolve(input.fileAbs)) return false;
  return !await timelineUnchanged(record.source_sha256, input);
}

type ProductFact = { id: string; text: string };

type LastRender = {
  /** The file the last render wrote, and the timeline it showed. */
  output?: string;
  source_sha256?: string;
  /** The timeline the latest delivered version shows. */
  delivered_source_sha256?: string;
  /** Associates optional turn-end notices with this exact delivered version. Older records omit it. */
  delivered_version_id?: string;
  /** The product facts the latest delivered version was made from. The Agent applies a change to
   *  them when the user updates the video (decided 2026-11-09). */
  delivered_facts?: ProductFact[];
  visual_check?: { input_sha256: string | null; review: VideoVisualReview };
  visual_render?: { output_sha256: string; review: VideoVisualReview };
};

/** Advisory measurements of sampled page frames, never an approval of the film. */
export type VideoVisualReview = {
  status: 'has_findings' | 'no_findings' | 'not_checked' | 'stale' | 'unavailable';
  scope: 'sampled_page';
  advisory: true;
  findings: CheckWarningRow[];
  omitted_finding_types?: number;
};

const REVIEW_FINDING_TYPES_MAX = 16;

export function visualReview(status: VideoVisualReview['status'], findings: CheckWarningRow[] = []): VideoVisualReview {
  return {
    status, scope: 'sampled_page', advisory: true,
    findings: findings.slice(0, REVIEW_FINDING_TYPES_MAX).map(boundedCheckWarning),
    ...(findings.length > REVIEW_FINDING_TYPES_MAX ? { omitted_finding_types: findings.length - REVIEW_FINDING_TYPES_MAX } : {}),
  };
}

/** Older records have no review. Malformed evidence cannot become a clean result. */
export function parseVisualReview(value: unknown): VideoVisualReview | null {
  if (!value || typeof value !== 'object') return null;
  const review = value as VideoVisualReview;
  if (!['has_findings', 'no_findings', 'not_checked', 'stale', 'unavailable'].includes(review.status)
      || review.scope !== 'sampled_page' || review.advisory !== true || !Array.isArray(review.findings)
      || review.findings.length > REVIEW_FINDING_TYPES_MAX) return null;
  if (review.omitted_finding_types !== undefined && (!Number.isSafeInteger(review.omitted_finding_types) || review.omitted_finding_types < 0)) return null;
  for (const row of review.findings) {
    if (!row || typeof row.code !== 'string' || !row.code || !Number.isSafeInteger(row.count) || row.count < 1
        || !Array.isArray(row.scenes) || row.scenes.length > 12 || !row.scenes.every((scene) => typeof scene === 'string')
        || !Array.isArray(row.examples) || row.examples.length > 2 || !row.examples.every((example) => example && typeof example.message === 'string'
          && (example.scene_id === undefined || typeof example.scene_id === 'string')
          && (example.selector === undefined || typeof example.selector === 'string'))) return null;
    const validCount = (value: unknown, minimum = 0) => value === undefined
      || Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= row.count;
    if (!validCount(row.target_count) || !validCount(row.unlocated_count) || !validCount(row.omitted_targets)
        || (row.target_count !== undefined && row.unlocated_count !== undefined && row.target_count + row.unlocated_count > row.count)
        || (row.omitted_targets !== undefined && (row.target_count === undefined || row.omitted_targets > row.target_count))) return null;
    let locatedObservations = 0;
    for (const example of row.examples) {
      if (!validCount(example.occurrences, 1)
          || (example.occurrences !== undefined && !example.selector)
          || (example.scene_time_sec !== undefined && (!example.scene_id || !Number.isFinite(example.scene_time_sec) || example.scene_time_sec < 0))) return null;
      locatedObservations += example.occurrences ?? 0;
    }
    if (locatedObservations > row.count) return null;
  }
  if (review.status === 'no_findings' && (review.findings.length || review.omitted_finding_types)) return null;
  if (review.status === 'has_findings' && !review.findings.length && !review.omitted_finding_types) return null;
  return { ...visualReview(review.status, review.findings), ...(review.omitted_finding_types ? { omitted_finding_types: review.omitted_finding_types } : {}) };
}

async function readLastRender(videoDirAbs: string): Promise<LastRender | null> {
  const raw = await readOptionalText(path.join(videoDirAbs, LAST_RENDER_FILE)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastRender;
  } catch {
    return null;
  }
}

async function updateLastRender(paths: { productionDirAbs: string; videoDirAbs: string }, patch: Partial<LastRender>): Promise<void> {
  const file = path.join(paths.videoDirAbs, LAST_RENDER_FILE);
  if (!isPathAllowed(file, [paths.productionDirAbs])) throw new Error('Video record is outside the production.');
  await fileEditLock(file).runExclusive(async () => {
    await writeBytesAtomic(file, Buffer.from(JSON.stringify({ ...await readLastRender(paths.videoDirAbs), ...patch })));
  });
}

/** Reuse render asset hashes; check hashes its referenced media once. Linked local
 *  CSS/images are covered too. Failure loses freshness evidence, never an operation. */
async function visualInputHash(prepared: PreparedTimeline, paths: VideoProjectPaths): Promise<string | null> {
  try {
    const files: Array<[string, string]> = [];
    for (const [id, fact] of prepared.facts) files.push([id, fact.sha256 ?? await sha256OfFileStream(fact.absPath)]);
    // Match the render cache's authored regions, excluding the host-injected base
    // URL, which is a resolver instruction rather than a resource to hash.
    const linked = await videoStudioReferencedVisualAssetSignature(paths.videoDirAbs, [
      prepared.compiled.shared,
      ...Object.values(prepared.compiled.scenes).flatMap((scene) => [scene.subtree, scene.motion]),
    ].join('\n'), [paths.videoDirAbs]);
    return crypto.createHash('sha256').update(JSON.stringify({
      project: prepared.project, files, linked,
    })).digest('hex');
  } catch {
    return null;
  }
}

async function reviewForRender(paths: VideoProjectPaths, prepared: PreparedTimeline): Promise<VideoVisualReview> {
  const check = (await readLastRender(paths.videoDirAbs))?.visual_check;
  if (!check) return visualReview('not_checked');
  const review = parseVisualReview(check.review);
  if (!review || !check.input_sha256) return visualReview('unavailable');
  const signature = await visualInputHash(prepared, paths);
  if (!signature) return visualReview('unavailable');
  return signature === check.input_sha256 ? review : { ...review, status: 'stale' };
}

/** Match bytes, not a claimed path or the latest check; checks cannot approve an
 *  older render retrospectively. The resulting snapshot belongs to its version. */
export async function renderedVisualReview(videoDirAbs: string | undefined, sha256: string): Promise<VideoVisualReview> {
  if (!videoDirAbs) return visualReview('not_checked');
  const rendered = (await readLastRender(videoDirAbs))?.visual_render;
  if (!rendered || rendered.output_sha256 !== sha256) return visualReview('not_checked');
  return parseVisualReview(rendered.review) ?? visualReview('unavailable');
}

/** Whether the timeline is ahead of what was last delivered: changed since, or rendered and
 *  never delivered. With nothing on record, as for an upgraded video, nothing has changed. */
export async function timelineAheadOfDelivery(paths: { productionDirAbs: string; videoDirAbs: string }): Promise<boolean> {
  const record = await readLastRender(paths.videoDirAbs);
  return !!(record?.output || record?.delivered_source_sha256) && !await timelineUnchanged(record!.delivered_source_sha256, paths);
}

/** The product's facts as they read now. A file that cannot be read has none. */
async function productFactsNow(productionDirAbs: string): Promise<ProductFact[]> {
  const file = path.join(productionDirAbs, 'product.json');
  if (!isPathAllowed(file, [productionDirAbs])) return [];
  const raw = await readOptionalText(file).catch(() => null);
  if (!raw) return [];
  try {
    const { facts } = JSON.parse(raw) as { facts?: unknown };
    return factsOf(facts);
  } catch {
    return [];
  }
}

function factsOf(value: unknown): ProductFact[] {
  return (Array.isArray(value) ? value : []).flatMap((fact) => {
    const { id, text } = (fact ?? {}) as { id?: unknown; text?: unknown };
    return typeof id === 'string' && typeof text === 'string' ? [{ id, text }] : [];
  });
}

/** Remembers what a timeline and the product were before their first change, when nothing
 *  recorded them, as with an upgraded video: its delivered file shows this. A delivery recorded
 *  in an older form is noted again while the timeline is still that delivery, so undoing the
 *  change ahead comes back to it. */
export async function noteTimelineBeforeChange(paths: { productionDirAbs: string; videoDirAbs: string }): Promise<void> {
  const record = await readLastRender(paths.videoDirAbs);
  const recorded = record?.delivered_source_sha256;
  const delivered = !!(record?.output || recorded);
  const olderForm = typeof recorded === 'string' && !recorded.startsWith(PARSED_SCENES_HASH) && await timelineUnchanged(recorded, paths);
  const factsNoted = Array.isArray(record?.delivered_facts);
  if (delivered && factsNoted && !olderForm) return;
  await updateLastRender(paths, {
    ...(delivered && !olderForm ? {} : { delivered_source_sha256: await timelineSourceHash(paths, 'parsed') }),
    ...(factsNoted ? {} : { delivered_facts: await productFactsNow(paths.productionDirAbs) }),
  });
}

/** The timeline and the product as they are now have reached the user. */
export async function markTimelineDelivered(paths: { productionDirAbs: string; videoDirAbs: string }, versionId?: string): Promise<void> {
  await updateLastRender(paths, {
    delivered_source_sha256: await timelineSourceHash(paths, 'parsed'),
    delivered_version_id: versionId,
    delivered_facts: await productFactsNow(paths.productionDirAbs),
  });
}

/** The product facts whose words changed since the latest delivery, as they read then and now.
 *  A fact noted since was not in the video, and one taken out has nothing to change to. With
 *  nothing on record, as for a video delivered before deliveries kept them, nothing changed. */
export async function productChangesSinceDelivery(paths: { productionDirAbs: string; videoDirAbs: string }): Promise<Array<{ before: string; after: string }>> {
  const record = await readLastRender(paths.videoDirAbs);
  if (!Array.isArray(record?.delivered_facts)) return [];
  const now = new Map((await productFactsNow(paths.productionDirAbs)).map((fact) => [fact.id, fact.text]));
  return factsOf(record.delivered_facts).flatMap((fact) => {
    const after = now.get(fact.id);
    return after !== undefined && after !== fact.text ? [{ before: fact.text, after }] : [];
  });
}

function usedAssetIds(manifest: VideoManifestV3): Set<string> {
  const ids = new Set<string>();
  for (const scene of manifest.scenes) {
    for (const clip of scene.clips ?? []) ids.add(clip.asset);
    if (scene.narration?.asset) ids.add(scene.narration.asset);
  }
  for (const track of manifest.tracks ?? []) ids.add(track.asset);
  return ids;
}

/** Read each used file's real facts. Never trusts the ledger's own numbers. */
async function measureUsedAssets(input: {
  project: LoadedVideoProject;
  paths: VideoProjectPaths;
  ffprobe: string;
  withHash: boolean;
  signal?: AbortSignal;
}): Promise<{ facts: Map<string, AssetFacts>; issues: ContractIssue[] }> {
  const { project, paths } = input;
  const facts = new Map<string, AssetFacts>();
  const issues: ContractIssue[] = [];
  if (!project.manifest) return { facts, issues };
  const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
  for (const id of usedAssetIds(project.manifest)) {
    const record = byId.get(id);
    if (!record) continue; // validateVideoTimeline names it.
    const absPath = path.resolve(paths.productionDirAbs, record.path);
    if (!isPathAllowed(absPath, paths.allowedRoots)) {
      issues.push(fileIssue('TIMELINE_ASSET_OUT_OF_SCOPE', `assets.json#${id}`, `Asset "${id}" points outside the files this task can use.`));
      continue;
    }
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) {
      issues.push(fileIssue('TIMELINE_ASSET_MISSING', `assets.json#${id}`, `Asset "${id}" has no file at ${record.path}.`));
      continue;
    }
    const entry: AssetFacts = { record, absPath };
    const probe = await probeMedia(input.ffprobe, absPath, input.signal);
    if (record.kind !== 'image') {
      if (!probe || (record.kind === 'video' ? !probe.video : !probe.audio)) {
        issues.push(fileIssue('TIMELINE_ASSET_UNREADABLE', `assets.json#${id}`, `Asset "${id}" could not be read as ${record.kind}.`));
        continue;
      }
      entry.durationSec = probe.duration_seconds ?? undefined;
    }
    entry.width = probe?.video?.width;
    entry.height = probe?.video?.height;
    if (input.withHash) entry.sha256 = await sha256OfFileStream(absPath);
    facts.set(id, entry);
  }
  return { facts, issues };
}

type PreparedTimeline = {
  project: LoadedVideoProject & { manifest: VideoManifestV3 };
  facts: Map<string, AssetFacts>;
  compiled: CompiledVideoPage;
  issues: ContractIssue[];
};

/** Everything that can be known without opening a window. */
async function prepareTimeline(input: {
  paths: VideoProjectPaths;
  ffprobe: string;
  withHash: boolean;
  fps?: number;
  signal?: AbortSignal;
}): Promise<{ prepared: PreparedTimeline | null; issues: ContractIssue[] }> {
  const project = await loadVideoProject(input.paths);
  if (!project.manifest) return { prepared: null, issues: project.issues };
  const { manifest } = project;
  const measured = await measureUsedAssets({
    project,
    paths: input.paths,
    ffprobe: input.ffprobe,
    withHash: input.withHash,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const mediaDurations = new Map(
    [...measured.facts].flatMap(([id, fact]) => (fact.durationSec !== undefined ? [[id, fact.durationSec] as const] : [])),
  );
  const compiled = compileVideoPage({
    html: project.html,
    manifest,
    product: project.product,
    baseHref: pathToFileURL(`${input.paths.videoDirAbs}${path.sep}`).href,
  });
  const issues: ContractIssue[] = [
    ...project.issues,
    ...measured.issues,
    ...validateVideoTimeline({
      manifest,
      assets: project.assets,
      product: project.product,
      mediaDurations,
      ...(input.fps ? { fps: input.fps } : {}),
    }),
    ...compiled.issues,
  ];
  if (project.html !== null) {
    // The composition loader owns resource rules and provisions bundled vendor
    // scripts; only its root-attribute rules do not apply to a timeline page.
    const loaded = await loadCompositionMeta(input.paths.videoDirAbs);
    for (const issue of loaded.issues) {
      if (issue.code === 'ROOT_COMPOSITION_MISSING' || issue.code === 'ROOT_TIMING_ATTR_MISSING' || issue.code === 'DURATION_TOO_LONG') continue;
      issues.push((issue.code === 'RESOURCE_OUT_OF_SCOPE'
        ? { ...issue, message: `${issue.message} Keep files inside the video folder and refer to them as ./assets/...; GSAP is provided at ./assets/vendor/gsap.min.js.` }
        : issue) as ContractIssue);
    }
  }
  return {
    prepared: { project: { ...project, manifest }, facts: measured.facts, compiled, issues },
    issues,
  };
}

function hasErrors(issues: readonly ContractIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function blockedResult(op: 'video.render' | 'video.sheet', issues: ContractIssue[]): VideoStudioResult {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    ok: false,
    op,
    errorCode: 'E_VIDEO_CHECK_BLOCKED',
    message: errors[0]?.message || 'The video did not pass its checks.',
    issues: errors,
  };
}

function sceneCues(manifest: VideoManifestV3, scene: DerivedScene, fps: number, facts: Map<string, AssetFacts>): CaptionFrameCue[] {
  const authored = manifest.scenes[scene.index];
  if (manifest.captions?.enabled !== true || !authored.narration) return [];
  const spokenSec = authored.narration.asset
    ? facts.get(authored.narration.asset)?.durationSec ?? scene.durationSec
    : scene.durationSec;
  return captionCues(authored.narration.text, Math.min(spokenSec, scene.durationSec)).map((cue) => ({
    fromFrame: Math.round(cue.startSec * fps),
    toFrame: Math.round(cue.endSec * fps),
    text: cue.text,
  }));
}

async function extractClipFrames(input: {
  ffmpeg: string;
  clip: DerivedClip;
  fact: AssetFacts;
  fps: number;
  width: number;
  height: number;
  dirAbs: string;
  frameLimit?: number;
  startOffsetFrames?: number;
  signal?: AbortSignal;
}): Promise<ClipFrames> {
  const { clip, fact } = input;
  await fs.mkdir(input.dirAbs, { recursive: true });
  if (fact.record.kind === 'image') {
    const stillAbs = path.join(input.dirAbs, `still${path.extname(fact.absPath) || '.img'}`);
    await fs.copyFile(fact.absPath, stillAbs);
    return { kind: 'still', url: pathToFileURL(stillAbs).href };
  }
  const offset = input.startOffsetFrames ?? 0;
  const wanted = input.frameLimit ?? clip.frameCount;
  const filters = [`fps=${input.fps}`];
  if (fact.width && fact.height) {
    // Never larger than the canvas needs; bounds disk use for 4K sources.
    const scale = Math.max(input.width / fact.width, input.height / fact.height);
    if (scale < 1) filters.push(`scale=${Math.ceil(fact.width * scale / 2) * 2}:-2`);
  }
  const startSec = clip.inSec + offset / input.fps;
  const extract = (fromSec: number) => runVideoProcessForTest(input.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', fromSec.toFixed(6),
    '-i', fact.absPath,
    '-map', '0:v:0',
    '-vf', filters.join(','),
    '-frames:v', String(wanted),
    '-q:v', '2',
    '-f', 'image2',
    path.join(input.dirAbs, 'f%06d.jpg'),
  ], { timeoutMs: FRAME_EXTRACT_TIMEOUT_MS, ...(input.signal ? { signal: input.signal } : {}) });
  let run = await extract(startSec);
  if (run.aborted) throw new Error('render aborted');
  if (run.code !== 0) {
    throw new Error(`E_CLIP_FRAMES_FAILED: frames for clip "${clip.id}" could not be extracted. ${redactPaths(run.stderr.slice(-300))}`);
  }
  const countFrames = async () => (await fs.readdir(input.dirAbs)).filter((name) => name.endsWith('.jpg')).length;
  let produced = await countFrames();
  if (produced === 0 && offset > 0) {
    // A preview of a clip's last frame can land just past a source's end, the same
    // small shortfall a full render tolerates by holding its last frame.
    run = await extract(Math.max(clip.inSec, startSec - CLIP_FRAME_SHORTFALL_TOLERANCE / input.fps));
    if (run.aborted) throw new Error('render aborted');
    produced = await countFrames();
  }
  if (produced < wanted - CLIP_FRAME_SHORTFALL_TOLERANCE || produced === 0) {
    throw new Error(`E_CLIP_FRAMES_SHORT: clip "${clip.id}" needs ${wanted} frames from ${startSec.toFixed(2)}s but its source yields ${produced}.`);
  }
  return { kind: 'frames', dirAbs: input.dirAbs, produced };
}

type ClipFrames =
  | { kind: 'still'; url: string }
  | { kind: 'frames'; dirAbs: string; produced: number };

function clipFrameUrl(frames: ClipFrames, index: number): string {
  if (frames.kind === 'still') return frames.url;
  const file = `f${String(Math.min(index, frames.produced - 1) + 1).padStart(6, '0')}.jpg`;
  return pathToFileURL(path.join(frames.dirAbs, file)).href;
}

type TimelineFrame = {
  win: ElectronBrowserWindow;
  sceneId: string;
  tSec: number;
  clips: Record<string, string>;
  caption: string;
};

async function showTimelineFrame(input: TimelineFrame): Promise<void> {
  const call = `window.__ORKAS_VIDEO__.renderFrame(${JSON.stringify(input.sceneId)}, ${JSON.stringify(input.tSec)}, ${JSON.stringify(input.clips)}, ${JSON.stringify(input.caption)})`;
  await withVideoStudioTimeout(
    input.win.webContents.executeJavaScript(call, true),
    COMPOSITION_SCRIPT_TIMEOUT_MS,
    'E_COMPOSITION_SEEK_TIMEOUT',
    `scene "${input.sceneId}" timed out at ${input.tSec.toFixed(2)}s.`,
    () => { try { input.win.destroy(); } catch { /* best effort */ } },
  );
  await settleCompositionPaint(input.win);
}

function captureWindow(win: ElectronBrowserWindow, width: number, height: number, timeoutMessage: string): Promise<NativeImage> {
  return withVideoStudioTimeout(
    win.webContents.capturePage({ x: 0, y: 0, width, height }),
    COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
    'E_RENDER_CAPTURE_TIMEOUT',
    timeoutMessage,
    () => { try { win.destroy(); } catch { /* best effort */ } },
  );
}

/**
 * Show a frame far from the one on screen, and capture it.
 *
 * A capture copies the last surface the compositor finished. When most of the picture
 * changes, painting can outlast the settle wait, so the copy still shows the page as it was:
 * the previous scene, or every scene at once on a fresh window. Capture until the picture
 * has changed and holds.
 */
async function showAndCaptureJump(input: TimelineFrame & { width: number; height: number; timeoutMessage: string }): Promise<NativeImage> {
  const capture = () => captureWindow(input.win, input.width, input.height, input.timeoutMessage);
  await settleCompositionPaint(input.win);
  const before = (await capture()).toBitmap();
  await showTimelineFrame(input);
  let shot = await capture();
  for (let count = 1; count < JUMP_FRAME_MAX_CAPTURES; count += 1) {
    const previous = shot.toBitmap();
    await settleCompositionPaint(input.win);
    shot = await capture();
    const current = shot.toBitmap();
    if (current.equals(previous) && !current.equals(before)) break;
  }
  return shot;
}

function sceneFrameClips(scene: DerivedScene, frames: Map<string, ClipFrames>, frame: number): Record<string, string> {
  const clips: Record<string, string> = {};
  for (const clip of scene.clips) {
    if (frame < clip.startFrame || frame >= clip.startFrame + clip.frameCount) continue;
    const clipFrames = frames.get(clip.id);
    if (clipFrames) clips[clip.id] = clipFrameUrl(clipFrames, frame - clip.startFrame);
  }
  return clips;
}

function cueAt(cues: readonly CaptionFrameCue[], frame: number): string {
  return cues.find((cue) => frame >= cue.fromFrame && frame < cue.toFrame)?.text ?? '';
}

type SegmentMeta = { version: number; scene_id: string; frame_count: number; fps: number };

async function readSegmentMeta(entryDirAbs: string): Promise<SegmentMeta | null> {
  const raw = await readOptionalText(path.join(entryDirAbs, 'meta.json')).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SegmentMeta;
    return parsed?.version === SEGMENT_META_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

type SceneJob = {
  scene: DerivedScene;
  key: string;
  entryDirAbs: string;
  cues: CaptionFrameCue[];
  cached: boolean;
};

class PageContractError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
  }
}

/** Refuse a page whose motion is not per scene before any frame is captured. A
 *  timeline under any other key would run on absolute time, which cannot survive a
 *  reorder and never renders here at all. */
async function assertPageTimelines(win: ElectronBrowserWindow, manifest: VideoManifestV3): Promise<void> {
  if (manifest.upgraded_from) return;
  const keys = await win.webContents.executeJavaScript('window.__ORKAS_VIDEO__.timelineKeys()', true) as string[];
  const sceneIds = new Set(manifest.scenes.map((scene) => scene.id));
  let stray = (Array.isArray(keys) ? keys : []).filter((key) => !sceneIds.has(key));
  if (stray.length) {
    // A scene taken off the timeline keeps its section and its motion in the page.
    const sections = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-scene-id]')).map((section) => section.getAttribute('data-scene-id'))`,
      true,
    ) as string[];
    stray = stray.filter((key) => !sections.includes(key));
  }
  if (stray.length) {
    throw new PageContractError(
      'E_PAGE_TIMELINE_NOT_PER_SCENE',
      `window.__timelines has ${stray.map((key) => `"${key}"`).join(', ')}, which ${stray.length > 1 ? 'are not scenes' : 'is not a scene'}. Give each scene its own paused timeline in scene-local seconds, under its scene id.`,
    );
  }
}

function uncaughtPageErrors(messages: readonly string[]): string[] {
  return messages.filter((message) => /^Uncaught\b/.test(message)).slice(0, MAX_REPORTED_PAGE_ERRORS).map(redactPaths);
}

async function renderSceneIntoCache(input: {
  win: ElectronBrowserWindow;
  job: SceneJob;
  frames: Map<string, ClipFrames>;
  width: number;
  height: number;
  fps: number;
  ffmpeg: string;
  ffprobe: string;
  stagingDirAbs: string;
  segmentIndex: number;
  segmentsToRender: number;
  p: VideoRenderOptions;
}): Promise<void> {
  const { win, job, p, fps, stagingDirAbs } = input;
  const { scene } = job;
  await fs.rm(stagingDirAbs, { recursive: true, force: true });
  await fs.mkdir(stagingDirAbs, { recursive: true });
  const encoder = startRawFrameEncoder({
    ffmpeg: input.ffmpeg,
    outputAbsPath: path.join(stagingDirAbs, 'segment.mp4'),
    width: input.width,
    height: input.height,
    fps,
    format: 'mp4',
    audioTracks: [],
    durationSec: scene.frameCount / fps,
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  try {
    for (let frame = 0; frame < scene.frameCount; frame += 1) {
      if (p.signal?.aborted) throw new Error('render aborted');
      const shown: TimelineFrame = {
        win,
        sceneId: scene.id,
        tSec: frame / fps,
        clips: sceneFrameClips(scene, input.frames, frame),
        caption: cueAt(job.cues, frame),
      };
      const timeoutMessage = `scene "${scene.id}" timed out capturing frame ${frame + 1}.`;
      let captured: NativeImage;
      if (frame === 0) {
        captured = await showAndCaptureJump({ ...shown, width: input.width, height: input.height, timeoutMessage });
      } else {
        await showTimelineFrame(shown);
        captured = await captureWindow(win, input.width, input.height, timeoutMessage);
      }
      const normalized = normalizeCapturedFrame(captured, input.width, input.height);
      await withVideoStudioTimeout(
        encoder.writeFrame(normalized.image.toBitmap()),
        COMPOSITION_RENDER_FRAME_TIMEOUT_MS,
        'E_RENDER_PIPE_TIMEOUT',
        `scene "${scene.id}" timed out streaming frame ${frame + 1}.`,
        () => encoder.cancel(),
      );
      if (frame % Math.max(1, Math.floor(fps * 2)) === 0) {
        p.onProgress?.({
          phase: 'video.render.capture',
          message: `Scene ${input.segmentIndex}/${input.segmentsToRender}: frame ${frame + 1}/${scene.frameCount}.`,
          data: { sceneId: scene.id, frame: frame + 1, totalFrames: scene.frameCount },
        });
      }
    }
    const encoded = await encoder.finish();
    if (encoded.aborted || encoded.timedOut || encoded.code !== 0) {
      throw new Error(`segment encode failed (code ${encoded.code}).`);
    }
  } catch (err) {
    encoder.cancel();
    await encoder.wait().catch(() => null);
    throw err;
  }
  const probe = await probeMedia(input.ffprobe, path.join(stagingDirAbs, 'segment.mp4'), p.signal);
  if (!probe?.video) throw new Error('segment media could not be probed.');
  const meta: SegmentMeta = { version: SEGMENT_META_VERSION, scene_id: scene.id, frame_count: scene.frameCount, fps };
  await fs.writeFile(path.join(stagingDirAbs, 'meta.json'), JSON.stringify(meta), 'utf8');
  await fs.rm(job.entryDirAbs, { recursive: true, force: true });
  await fs.rename(stagingDirAbs, job.entryDirAbs);
}

/** A crash leaves its work directory behind, and these hold extracted frames.
 *  Called while holding the render slot; a live one is far younger than this. */
async function sweepStaleWorkDirs(cacheDirAbs: string): Promise<void> {
  const entries = await fs.readdir(cacheDirAbs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_DIR_PREFIX)) continue;
    const dirAbs = path.join(cacheDirAbs, entry.name);
    const stat = await fs.stat(dirAbs).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_WORK_DIR_MS) {
      await fs.rm(dirAbs, { recursive: true, force: true }).catch((err) => {
        log.warn('stale render workspace cleanup failed', { error: logErrorSummary(err) });
      });
    }
  }
}

function compositionMeta(input: {
  htmlPath: string;
  html: string;
  manifest: VideoManifestV3;
  durationSec: number;
  audioTracks?: AudioTrack[];
}): CompositionMeta {
  return {
    htmlPath: input.htmlPath,
    html: input.html,
    rootAttrs: {},
    id: input.manifest.id,
    width: input.manifest.canvas.width,
    height: input.manifest.canvas.height,
    durationSec: input.durationSec,
    audioTracks: input.audioTracks ?? [],
  };
}

function sumFrames(timeline: DerivedTimeline): number {
  return timeline.scenes.reduce((sum, scene) => sum + scene.frameCount, 0);
}

async function audioTracksFor(
  prepared: PreparedTimeline,
  timeline: DerivedTimeline,
  ffmpeg: string,
  workDirAbs: string,
  signal?: AbortSignal,
): Promise<AudioTrack[]> {
  const { manifest } = prepared.project;
  const byPath = new Map([...prepared.facts.values()].map((fact) => [fact.absPath, fact]));
  const tracks = timelineAudioTracks({
    manifest,
    timeline,
    resolve: (assetId) => prepared.facts.get(assetId)?.absPath ?? '',
  });
  const result: AudioTrack[] = [];
  for (const [index, { loop, ...track }] of tracks.entries()) {
    const declared = track.durSec ?? byPath.get(track.absPath)?.durationSec;
    const remainingSec = timeline.durationSec - track.startSec;
    if (loop && !(declared !== undefined && declared >= remainingSec)) {
      // Drain the repeating input before mixing. A looping demuxer in the mix
      // can stall FFmpeg even when the output/filter duration is bounded.
      const filledAbsPath = path.join(workDirAbs, `music-${index}.wav`);
      const filled = await runVideoProcessForTest(ffmpeg, [
        '-y', '-nostdin', '-stream_loop', '-1', '-i', track.absPath,
        // AAC priming can leave timestamp gaps on each repeat. Count decoded
        // samples continuously so the filled sound reaches the requested end.
        '-af', 'asetpts=N/SR/TB', '-t', remainingSec.toFixed(3),
        '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', filledAbsPath,
      ], { timeoutMs: RENDER_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      if (filled.code !== 0) throw new Error(`music repeat failed (code ${filled.code}): ${redactPaths(filled.stderr.slice(-400))}`);
      result.push({ ...track, absPath: filledAbsPath, declaredDurationSec: remainingSec });
    } else {
      result.push({ ...track, ...(declared !== undefined ? { declaredDurationSec: declared } : {}) });
    }
  }
  return result;
}

export async function renderVideoTimeline(p: VideoRenderOptions): Promise<VideoStudioResult> {
  const op = 'video.render' as const;
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (!ffmpeg) return { ok: false, op, errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  if (!ffprobe) return { ok: false, op, errorCode: 'E_FFPROBE_MISSING', message: 'Bundled ffprobe not found; final media cannot be verified.' };
  // Read before the render does, so a change made while it runs counts as made after it.
  const sourceSha256 = await timelineSourceHash(p);
  const { prepared, issues } = await prepareTimeline({
    paths: p,
    ffprobe,
    withHash: true,
    ...(p.fps ? { fps: p.fps } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (!prepared || hasErrors(issues)) return blockedResult(op, issues);
  const { manifest } = prepared.project;
  const { compiled } = prepared;
  let review = await reviewForRender(p, prepared);

  const requestedFps = qualityFps(p.quality, p.fps, manifest.canvas.fps);
  const nominal = deriveVideoTimeline(manifest, requestedFps);
  const renderProfile = await resolveNativeRenderProfile(
    p.videoDirAbs,
    compositionMeta({ htmlPath: '', html: compiled.html, manifest, durationSec: nominal.durationSec }),
    p.quality,
    requestedFps,
    p.allowFpsFallback !== false,
  );
  if (renderProfile.decision === 'fail_fast') {
    return {
      ok: false,
      op,
      errorCode: 'E_RENDER_TOO_HEAVY',
      message: `This ${manifest.canvas.width}x${manifest.canvas.height}, ${Math.round(nominal.durationSec)}s video cannot be rendered at ${p.quality} quality on this machine without likely hanging.`,
      render_profile: renderProfile,
    };
  }
  const fps = renderProfile.render_fps;
  // Quality and machine capacity can change fps after the initial preflight.
  // Validate the actual frame ranges before extracting media or opening a page.
  const frameIssues = validateVideoTimeline({ manifest, assets: prepared.project.assets,
    product: prepared.project.product, fps });
  if (hasErrors(frameIssues)) return blockedResult(op, frameIssues);
  const timeline = deriveVideoTimeline(manifest, fps);
  const { width, height } = manifest.canvas;

  await fs.mkdir(p.segmentCacheDirAbs, { recursive: true });
  const sharedAssetsSha256 = await videoStudioReferencedVisualAssetSignature(p.videoDirAbs, compiled.shared);
  const jobs: SceneJob[] = [];
  for (const scene of timeline.scenes) {
    const page = compiled.scenes[scene.id];
    const cues = sceneCues(manifest, scene, fps, prepared.facts);
    const key = buildTimelineSceneKey({
      subtree: page.subtree,
      motion: page.motion,
      shared: compiled.shared,
      sceneAssetsSha256: await videoStudioReferencedVisualAssetSignature(p.videoDirAbs, `${page.subtree}\n${page.motion}`),
      sharedAssetsSha256,
      clips: scene.clips.map((clip) => ({
        id: clip.id,
        assetSha256: prepared.facts.get(clip.assetId)?.sha256 ?? '',
        inSec: clip.inSec,
        startFrame: clip.startFrame,
        frameCount: clip.frameCount,
      })),
      captions: cues,
      frameCount: scene.frameCount,
      fps,
      width,
      height,
      quality: p.quality,
      ...(manifest.absolute_page?.scene_starts[scene.id] === undefined ? {} : { pageStart: manifest.absolute_page.scene_starts[scene.id] }),
      format: 'mp4',
    });
    const entryDirAbs = path.join(p.segmentCacheDirAbs, key);
    const meta = await readSegmentMeta(entryDirAbs);
    const hasSegment = await fs.stat(path.join(entryDirAbs, 'segment.mp4')).then((st) => st.isFile(), () => false);
    jobs.push({ scene, key, entryDirAbs, cues, cached: !!meta && hasSegment && meta.frame_count === scene.frameCount });
  }

  const pending = jobs.filter((job) => !job.cached);
  const reusedCount = jobs.length - pending.length;
  const releaseSlot = pending.length
    ? await acquireCompositionRenderSlot({
      ...(p.signal ? { signal: p.signal } : {}),
      onWait: (waitedMs) => p.onProgress?.({
        phase: 'video.render.queue',
        message: `Waiting for another render to finish (queued ${Math.round(waitedMs / 1000)}s).`,
        data: { queued: true, waitedMs },
      }),
    })
    : null;
  const startedAt = Date.now();
  const workDirAbs = path.join(p.segmentCacheDirAbs, `${WORK_DIR_PREFIX}${crypto.randomUUID()}`);
  const stagingRootAbs = path.join(p.segmentCacheDirAbs, SEGMENT_CACHE_STAGING_DIR_NAME);
  const failedScenes: Array<{ scene_id: string; attempts: number; error: string }> = [];
  const pageErrors: string[] = [];
  let renderedCount = 0;
  let stage = 'segment_render';
  const incomplete = (err: unknown): VideoStudioResult => ({
    ok: false,
    op,
    errorCode: 'E_SEGMENT_ASSEMBLY_INCOMPLETE',
    message: `${failedScenes.length
      ? `${failedScenes.length} of ${jobs.length} scene(s) failed to render after a retry`
      : `the render failed during ${stage} (${videoStudioErrorCode(err, 'E_RENDER_FAILED')}: ${String((err as Error)?.message || err).slice(0, 300)})`}. ${reusedCount + renderedCount} of ${jobs.length} scene(s) are rendered and cached; render again with unchanged inputs to finish only what is missing.`,
    failed_stage: stage,
    render_profile: renderProfile,
    scene_segments: {
      total: jobs.length,
      rendered: renderedCount,
      reused: reusedCount,
      failed: failedScenes.length,
      resumable: true,
    },
    ...(failedScenes.length ? { failed_scenes: failedScenes } : {}),
  });

  try {
    await fs.mkdir(workDirAbs, { recursive: true });
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true });
    const compiledHtmlPath = path.join(workDirAbs, 'index.html');
    await fs.writeFile(compiledHtmlPath, compiled.html, 'utf8');

    if (pending.length) {
      await sweepStaleWorkDirs(p.segmentCacheDirAbs);
      p.onProgress?.({
        phase: 'video.render',
        message: `Rendering ${pending.length} of ${jobs.length} scene(s); ${reusedCount} unchanged.`,
        data: { segmentsTotal: jobs.length, segmentsToRender: pending.length, segmentsCached: reusedCount },
      });
      const segmentsToRender = pending.length;
      const attempts = new Map<string, number>();
      let consecutiveSetupFailures = 0;
      while (pending.length) {
        if (p.signal?.aborted) throw new Error('render aborted');
        let sessionEntered = false;
        try {
          await withCompositionWindow(
            compositionMeta({ htmlPath: compiledHtmlPath, html: compiled.html, manifest, durationSec: timeline.durationSec }),
            { compositionDirAbs: p.videoDirAbs },
            async (win) => {
              sessionEntered = true;
              await assertPageTimelines(win, manifest);
              const uncaught = uncaughtPageErrors(pageErrors);
              if (uncaught.length) throw new PageContractError('E_PAGE_SCRIPT_ERROR', `The page raised an error while loading: ${uncaught[0]}`);
              while (pending.length) {
                if (p.signal?.aborted) throw new Error('render aborted');
                const job = pending[0];
                const framesDirAbs = path.join(workDirAbs, 'frames', job.key.slice(0, 12));
                const frames = new Map<string, ClipFrames>();
                for (const clip of job.scene.clips) {
                  const fact = prepared.facts.get(clip.assetId);
                  if (!fact) continue;
                  frames.set(clip.id, await extractClipFrames({
                    ffmpeg,
                    clip,
                    fact,
                    fps,
                    width,
                    height,
                    dirAbs: path.join(framesDirAbs, clip.id),
                    ...(p.signal ? { signal: p.signal } : {}),
                  }));
                }
                await renderSceneIntoCache({
                  win,
                  job,
                  frames,
                  width,
                  height,
                  fps,
                  ffmpeg,
                  ffprobe,
                  stagingDirAbs: path.join(stagingRootAbs, job.key.slice(0, 12)),
                  segmentIndex: renderedCount + failedScenes.length + 1,
                  segmentsToRender,
                  p,
                });
                await fs.rm(framesDirAbs, { recursive: true, force: true });
                pending.shift();
                renderedCount += 1;
              }
            },
            {
              extraAllowedDirsAbs: [workDirAbs],
              adapterScript: buildVideoTimelineAdapterScript(manifest.absolute_page),
              offscreenFrameRate: RENDER_OFFSCREEN_FRAME_RATE,
              onConsoleError: (message) => { if (pageErrors.length < 64) pageErrors.push(message); },
            },
          );
          consecutiveSetupFailures = 0;
        } catch (err) {
          if (p.signal?.aborted) throw err;
          if (err instanceof PageContractError) {
            return { ok: false, op, errorCode: err.errorCode, message: err.message, render_profile: renderProfile };
          }
          if (!sessionEntered) {
            consecutiveSetupFailures += 1;
            if (consecutiveSetupFailures >= 2) throw err;
            continue;
          }
          consecutiveSetupFailures = 0;
          const job = pending[0];
          if (!job) throw err;
          const code = videoStudioErrorCode(err, 'E_RENDER_FAILED');
          const count = (attempts.get(job.key) || 0) + 1;
          attempts.set(job.key, count);
          if (count >= SEGMENT_RENDER_MAX_ATTEMPTS) {
            pending.shift();
            failedScenes.push({ scene_id: job.scene.id, attempts: count, error: `${code}: ${String((err as Error).message || err).slice(0, 300)}` });
          }
          p.onProgress?.({
            phase: 'video.render.capture',
            message: `Scene "${job.scene.id}" failed (${code}); ${count >= SEGMENT_RENDER_MAX_ATTEMPTS ? 'continuing with the rest' : 'retrying in a fresh window'}.`,
            data: { sceneId: job.scene.id, retry: count < SEGMENT_RENDER_MAX_ATTEMPTS },
          });
        }
      }
      if (failedScenes.length) return incomplete(new Error('scene render incomplete'));
    }

    stage = 'concat';
    const concatListAbs = path.join(workDirAbs, 'segments.txt');
    await fs.writeFile(concatListAbs, jobs.map((job) => (
      `file '${path.join(job.entryDirAbs, 'segment.mp4').replace(/'/g, "'\\''")}'`
    )).join('\n'), 'utf8');
    const concatVideoAbs = path.join(workDirAbs, 'video.mp4');
    const concatRun = await runVideoProcessForTest(ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListAbs, '-c', 'copy', concatVideoAbs,
    ], { timeoutMs: VIDEO_TRACK_REMUX_TIMEOUT_MS, ...(p.signal ? { signal: p.signal } : {}) });
    if (concatRun.code !== 0) throw new Error(`segment concat failed (code ${concatRun.code}).`);

    stage = 'audio_mix';
    const audioTracks = await audioTracksFor(prepared, timeline, ffmpeg, workDirAbs, p.signal);
    const outputExt = path.extname(p.outputAbsPath) || '.mp4';
    const tempOutputAbs = path.join(
      path.dirname(p.outputAbsPath),
      `.${path.basename(p.outputAbsPath, outputExt)}.assembling-${crypto.randomUUID()}${outputExt}`,
    );
    try {
      const mix = await runVideoProcessForTest(ffmpeg, buildVideoTrackRemuxArgs({
        priorVideoAbsPath: concatVideoAbs,
        outputAbsPath: tempOutputAbs,
        durationSec: timeline.durationSec,
        format: 'mp4',
        audioTracks,
      }), { timeoutMs: RENDER_TIMEOUT_MS, ...(p.signal ? { signal: p.signal } : {}) });
      if (mix.code !== 0) throw new Error(`audio mix failed (code ${mix.code}): ${redactPaths(mix.stderr.slice(-400))}`);

      stage = 'loudness';
      let probe: MediaProbe | null = await probeMedia(ffprobe, tempOutputAbs, p.signal);
      let loudness: Record<string, unknown> = { skipped: true, reason: 'no audio stream' };
      if (probe?.audio) {
        const before = await analyzeLoudness(ffmpeg, tempOutputAbs, p.signal);
        const decision = shouldNormalizeLoudness(before, p.quality);
        loudness = { before, decision };
        if (decision.normalize) {
          loudness.normalize = await normalizeAudioInPlace(ffmpeg, tempOutputAbs, p.signal);
          probe = await probeMedia(ffprobe, tempOutputAbs, p.signal);
        }
      }

      stage = 'media_qa';
      const mediaQa = await buildMediaQa(
        compositionMeta({ htmlPath: compiledHtmlPath, html: compiled.html, manifest, durationSec: timeline.durationSec, audioTracks }),
        probe,
        ffprobe,
        p.signal,
      );
      if (mediaQa.ok === false) {
        return { ok: false, op, errorCode: 'E_MEDIA_QA_BLOCKED', message: 'The rendered file failed its media checks.', media_qa: mediaQa };
      }

      stage = 'finalize';
      await fs.rename(tempOutputAbs, p.outputAbsPath);
      // Losing this loses a check at delivery, never the render.
      const outputSha256 = await sha256OfFileStream(p.outputAbsPath).catch(() => null);
      if (!outputSha256) review = { ...review, status: 'unavailable' };
      await updateLastRender(p, {
        output: path.relative(p.productionDirAbs, p.outputAbsPath), source_sha256: sourceSha256,
        visual_render: { output_sha256: outputSha256 ?? '', review },
      }).catch((err) => {
        review = { ...review, status: 'unavailable' };
        log.warn('last render not recorded', { error: logErrorSummary(err) });
      });
      const stat = await fs.stat(p.outputAbsPath);
      await pruneSegmentCache(p.segmentCacheDirAbs);
      const totalSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      return {
        ok: true,
        op,
        path: p.outputAbsPath,
        bytes: stat.size,
        media: versionedChatMediaLocalUrl(p.outputAbsPath),
        probe,
        fps,
        frames: sumFrames(timeline),
        canvas: { width, height, durationSec: timeline.durationSec },
        render_profile: { ...renderProfile, total_render_seconds: Math.round(totalSeconds * 100) / 100 },
        scene_segments: { total: jobs.length, rendered: renderedCount, reused: reusedCount },
        media_qa: mediaQa,
        loudness,
        visual_review: review,
      };
    } finally {
      await fs.rm(tempOutputAbs, { force: true }).catch(() => {});
    }
  } catch (err) {
    if (p.signal?.aborted) {
      return { ok: false, op, errorCode: 'E_RENDER_ABORTED', message: 'render aborted.', render_profile: renderProfile };
    }
    log.warn('timeline render failed', { stage, error: logErrorSummary(err) });
    return incomplete(err);
  } finally {
    if (releaseSlot) {
      await fs.rm(stagingRootAbs, { recursive: true, force: true }).catch((err) => {
        log.warn('segment staging cleanup failed', { error: logErrorSummary(err) });
      });
    }
    releaseSlot?.();
    await fs.rm(workDirAbs, { recursive: true, force: true }).catch((err) => {
      log.warn('render workspace cleanup failed', { error: logErrorSummary(err) });
    });
  }
}

/** Which scene and scene-local frame an absolute time falls on. */
export function locateTimelineFrame(timeline: DerivedTimeline, tSec: number): { scene: DerivedScene; frame: number } {
  const absolute = Math.max(0, Math.min(timeline.totalFrames - 1, Math.floor(tSec * timeline.fps + 1e-6)));
  const scene = timeline.scenes.find((candidate) => absolute < candidate.startFrame + candidate.frameCount)
    ?? timeline.scenes[timeline.scenes.length - 1];
  return { scene, frame: absolute - scene.startFrame };
}

type SampleRequest = { label: string; timeSec: number };

/** One still per clip visible on a frame, extracted on demand: a sheet touches a
 *  few frames of a video, so whole clips are never extracted for it. */
async function framesForSample(input: {
  ffmpeg: string;
  scene: DerivedScene;
  frame: number;
  fps: number;
  width: number;
  height: number;
  facts: Map<string, AssetFacts>;
  dirAbs: string;
  signal?: AbortSignal;
}): Promise<Record<string, string>> {
  const clips: Record<string, string> = {};
  for (const clip of input.scene.clips) {
    if (input.frame < clip.startFrame || input.frame >= clip.startFrame + clip.frameCount) continue;
    const fact = input.facts.get(clip.assetId);
    if (!fact) continue;
    const frames = await extractClipFrames({
      ffmpeg: input.ffmpeg,
      clip,
      fact,
      fps: input.fps,
      width: input.width,
      height: input.height,
      dirAbs: path.join(input.dirAbs, `${clip.id}-${input.frame}`),
      frameLimit: 1,
      startOffsetFrames: input.frame - clip.startFrame,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    clips[clip.id] = clipFrameUrl(frames, 0);
  }
  return clips;
}

export type VideoSheetOptions = VideoProjectPaths & {
  outputDirAbs: string;
  segmentCacheDirAbs: string;
  /** Absolute times to show. Defaults to the start and end of every scene. */
  times?: number[];
  /** Every frame in this span, instead of `times`. */
  range?: { startSec: number; endSec: number };
  fps?: number;
  signal?: AbortSignal;
};

function sheetRequests(timeline: DerivedTimeline, options: VideoSheetOptions): SampleRequest[] {
  if (options.range) {
    const first = Math.max(0, Math.floor(options.range.startSec * timeline.fps));
    const last = Math.min(timeline.totalFrames - 1, Math.ceil(options.range.endSec * timeline.fps));
    const count = Math.min(SHEET_MAX_FRAMES, last - first + 1);
    return Array.from({ length: Math.max(0, count) }, (_item, index) => {
      const frame = first + index;
      return { label: `f${frame}`, timeSec: frame / timeline.fps };
    });
  }
  if (options.times?.length) {
    return options.times.slice(0, SHEET_MAX_FRAMES).map((timeSec, index) => ({ label: `t${index + 1}`, timeSec }));
  }
  return timeline.scenes.flatMap((scene) => {
    const last = scene.startFrame + scene.frameCount - 1;
    return [
      { label: `${scene.id}-start`, timeSec: scene.startFrame / timeline.fps },
      { label: `${scene.id}-end`, timeSec: last / timeline.fps },
    ];
  }).slice(0, SHEET_MAX_FRAMES);
}

/** Frames of the video as it stands, without rendering it. */
export async function sheetVideoTimeline(p: VideoSheetOptions): Promise<VideoStudioResult> {
  const op = 'video.sheet' as const;
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (!ffmpeg || !ffprobe) return { ok: false, op, errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  const { prepared, issues } = await prepareTimeline({
    paths: p,
    ffprobe,
    withHash: false,
    ...(p.fps ? { fps: p.fps } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (!prepared || hasErrors(issues)) return blockedResult(op, issues);
  const { manifest } = prepared.project;
  const fps = p.fps ?? manifest.canvas.fps;
  const timeline = deriveVideoTimeline(manifest, fps);
  const { width, height } = manifest.canvas;
  const requests = sheetRequests(timeline, p);
  if (!requests.length) return { ok: false, op, errorCode: 'E_VIDEO_SHEET_EMPTY', message: 'No frames fall in that range.' };
  await fs.mkdir(p.segmentCacheDirAbs, { recursive: true });
  await fs.mkdir(p.outputDirAbs, { recursive: true });
  const workDirAbs = path.join(p.segmentCacheDirAbs, `${WORK_DIR_PREFIX}${crypto.randomUUID()}`);
  const pageErrors: string[] = [];
  try {
    await fs.mkdir(workDirAbs, { recursive: true });
    const compiledHtmlPath = path.join(workDirAbs, 'index.html');
    await fs.writeFile(compiledHtmlPath, prepared.compiled.html, 'utf8');
    const samples = await withCompositionWindow(
      compositionMeta({ htmlPath: compiledHtmlPath, html: prepared.compiled.html, manifest, durationSec: timeline.durationSec }),
      { compositionDirAbs: p.videoDirAbs },
      async (win) => {
        await assertPageTimelines(win, manifest);
        const out: Array<{ label: string; time_seconds: number; scene_id: string; path: string; hash: string; brightness: number; contrast: number }> = [];
        for (const request of requests) {
          if (p.signal?.aborted) throw new Error('render aborted');
          const { scene, frame } = locateTimelineFrame(timeline, request.timeSec);
          const clips = await framesForSample({
            ffmpeg,
            scene,
            frame,
            fps,
            width,
            height,
            facts: prepared.facts,
            dirAbs: path.join(workDirAbs, 'frames'),
            ...(p.signal ? { signal: p.signal } : {}),
          });
          const captured = await showAndCaptureJump({
            win,
            sceneId: scene.id,
            tSec: frame / fps,
            clips,
            caption: cueAt(sceneCues(manifest, scene, fps, prepared.facts), frame),
            width,
            height,
            timeoutMessage: `scene "${scene.id}" timed out capturing a preview frame.`,
          });
          const normalized = normalizeCapturedFrame(captured, width, height);
          const framePath = path.join(p.outputDirAbs, `${String(out.length + 1).padStart(2, '0')}-${request.label}.png`);
          await fs.writeFile(framePath, normalized.image.toPNG());
          const stats = analyzeNativeImage(normalized.image);
          out.push({
            label: request.label,
            time_seconds: Math.round(request.timeSec * 1000) / 1000,
            scene_id: scene.id,
            path: framePath,
            hash: stats.hash,
            brightness: stats.brightness,
            contrast: stats.contrast,
          });
        }
        return out;
      },
      {
        extraAllowedDirsAbs: [workDirAbs],
        adapterScript: buildVideoTimelineAdapterScript(manifest.absolute_page),
        onConsoleError: (message) => { if (pageErrors.length < 64) pageErrors.push(message); },
      },
    );
    const contactSheet = await writeFrameContactSheet(p.outputDirAbs, samples, { labelOnly: true, ...sheetLayoutFor(width, height) });
    return {
      ok: true,
      op,
      contact_sheet: contactSheet,
      samples,
      ...(uncaughtPageErrors(pageErrors).length ? { page_errors: uncaughtPageErrors(pageErrors) } : {}),
    };
  } catch (err) {
    if (err instanceof PageContractError) return { ok: false, op, errorCode: err.errorCode, message: err.message };
    return { ok: false, op, errorCode: videoStudioErrorCode(err, 'E_VIDEO_SHEET_FAILED'), message: String((err as Error).message || err).slice(0, 400) };
  } finally {
    await fs.rm(workDirAbs, { recursive: true, force: true }).catch((err) => {
      log.warn('sheet workspace cleanup failed', { error: logErrorSummary(err) });
    });
  }
}

export type VideoCheckOptions = VideoProjectPaths & {
  segmentCacheDirAbs: string;
  signal?: AbortSignal;
  onProgress?: VideoProgress;
  /** Checks earlier in this run that asked to move words off the product. */
  wordsOnProductAsked?: number;
  /** Called when this check asks to move words off the product. */
  onWordsOnProductAsked?: () => void;
};

/** Everything that can be wrong before rendering: structure and files without a
 *  window, then layout and page errors from the real page at a few frames of each
 *  scene. Bounded to three frames a scene, whatever the video's length. */
export async function checkVideoTimeline(p: VideoCheckOptions): Promise<VideoStudioResult> {
  const op = 'video.check' as const;
  const { ffmpeg, ffprobe } = bundledFfmpegPaths();
  if (!ffmpeg || !ffprobe) return { ok: false, op, errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  const { prepared, issues: prepareIssues } = await prepareTimeline({
    paths: p,
    ffprobe,
    withHash: false,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  const inputSha256 = prepared && !hasErrors(prepareIssues) ? await visualInputHash(prepared, p) : null;
  const saveReview = async (review: VideoVisualReview) => {
    if (p.signal?.aborted) return;
    await updateLastRender(p, { visual_check: { input_sha256: inputSha256, review } })
      .catch((err) => log.warn('visual check not recorded', { error: logErrorSummary(err) }));
  };
  // Only the check asks: the page renders these pictures either way.
  const issues = prepared
    ? [...prepareIssues, ...pagePictureIssues(prepared.project.manifest, pagePictureRefs({
      compiled: prepared.compiled,
      assets: prepared.project.assets,
      videoDirAbs: p.videoDirAbs,
      productionDirAbs: p.productionDirAbs,
    }))]
    : prepareIssues;
  // Lines of words found on a marked product, in the order the scenes play.
  const wordsOnProduct: Array<{ text: string; sceneId: string }> = [];
  const wordsOnProductMessage = () => `Words cover the product in ${wordsOnProduct.slice(0, WORDS_ON_PRODUCT_NAMED)
    .map((line) => `"${line.text}" (${line.sceneId})`).join(', ')}. Move the copy or the crop until the product is clear, then check again before rendering.`;
  const asksWordsOffProduct = () => wordsOnProduct.length > 0 && (p.wordsOnProductAsked ?? 0) < WORDS_ON_PRODUCT_ASKS;
  const respond = async (all: Array<ContractIssue | Issue>, extra: Record<string, unknown> = {}): Promise<VideoStudioResult> => {
    const errors = all.filter((issue) => issue.severity === 'error');
    const warnings = all.filter((issue) => issue.severity !== 'error');
    const scenesWith = (...codes: string[]) => [...new Set(warnings.flatMap((issue) => (
      codes.includes(issue.code) ? [(issue as { sceneId?: string }).sceneId ?? 'the page'] : []
    )))];
    const looksEmpty = scenesWith('SCENE_MOSTLY_EMPTY', 'SCENE_STATIC');
    const tooSmall = scenesWith('FONT_TOO_SMALL');
    // A warning in a list gets read past. What decides whether this reads as an ad goes
    // where the next decision is made.
    const needsWork = [
      looksEmpty.length ? `${looksEmpty.length} scene(s) are mostly empty or do not move: ${looksEmpty.join(', ')}. This will read as slides. Before rendering, give each one real footage or a product image filling the frame, or motion that changes what is seen.` : '',
      tooSmall.length ? `Text in ${tooSmall.join(', ')} is too small to read on a phone. If you did not choose that size, look for a CSS error that dropped the page's styles. Fix it before rendering.` : '',
      asksWordsOffProduct() ? wordsOnProductMessage() : '',
    ].filter(Boolean);
    const summary = summarizeCheckWarnings(warnings);
    const review = visualReview(errors.length || !inputSha256 ? 'unavailable' : summary.length ? 'has_findings' : 'no_findings', summary);
    await saveReview(review);
    if (!errors.length && asksWordsOffProduct()) p.onWordsOnProductAsked?.();
    return errors.length
      ? { ok: false, op, errorCode: 'E_VIDEO_CHECK_BLOCKED', message: errors[0].message, issues: errors, warnings: summary, visual_review: review, ...extra }
      : {
        ok: true,
        op,
        visual_review: review,
        ...(needsWork.length ? { message: needsWork.join(' ') } : {}),
        warnings: summary,
        ...extra,
      };
  };
  if (!prepared || hasErrors(issues)) return respond(issues);
  const { manifest } = prepared.project;
  const fps = manifest.canvas.fps;
  const timeline = deriveVideoTimeline(manifest, fps);
  const { width, height } = manifest.canvas;
  const facts = {
    duration_seconds: timeline.durationSec,
    scenes: timeline.scenes.map((scene) => ({ id: scene.id, start: scene.startSec, duration: scene.durationSec })),
  };
  await fs.mkdir(p.segmentCacheDirAbs, { recursive: true });
  const workDirAbs = path.join(p.segmentCacheDirAbs, `${WORK_DIR_PREFIX}${crypto.randomUUID()}`);
  const pageErrors: string[] = [];
  const found: Array<ContractIssue | Issue> = [...issues];
  const notShown: Issue[] = [];
  try {
    await fs.mkdir(workDirAbs, { recursive: true });
    const compiledHtmlPath = path.join(workDirAbs, 'index.html');
    await fs.writeFile(compiledHtmlPath, prepared.compiled.html, 'utf8');
    const meta = compositionMeta({ htmlPath: compiledHtmlPath, html: prepared.compiled.html, manifest, durationSec: timeline.durationSec });
    await withCompositionWindow(meta, { compositionDirAbs: p.videoDirAbs }, async (win) => {
      await assertPageTimelines(win, manifest);
      const inspected: Issue[] = [];
      const sceneHashes = new Map<string, Set<string>>();
      const sceneEmptyShare = new Map<string, number>();
      for (const scene of timeline.scenes) {
        if (p.signal?.aborted) throw new Error('render aborted');
        const lastFrame = scene.frameCount - 1;
        const frames = [...new Set([0, Math.floor(lastFrame / 2), lastFrame])].slice(0, CHECK_SAMPLES_PER_SCENE);
        const cues = sceneCues(manifest, scene, fps, prepared.facts);
        const subjects: Record<string, readonly number[]> = {};
        for (const clip of scene.clips) {
          const asset = prepared.project.assets.find((row) => row.id === clip.assetId);
          if (asset?.kind === 'image' && asset.subject) subjects[clip.id] = asset.subject;
        }
        const hashes = new Set<string>();
        let sceneOnPage = false;
        const shownInstead = new Set<string>();
        for (const frame of frames) {
          const clips = await framesForSample({
            ffmpeg,
            scene,
            frame,
            fps,
            width,
            height,
            facts: prepared.facts,
            dirAbs: path.join(workDirAbs, 'frames'),
            ...(p.signal ? { signal: p.signal } : {}),
          });
          const captured = await showAndCaptureJump({
            win,
            sceneId: scene.id,
            tSec: frame / fps,
            clips,
            caption: cueAt(cues, frame),
            width,
            height,
            timeoutMessage: `scene "${scene.id}" timed out capturing a check frame.`,
          });
          const sampled = await win.webContents.executeJavaScript(buildInspectScript(meta, frame / fps, scene.id), true) as Issue[];
          inspected.push(...sampled);
          if (Object.keys(subjects).length) {
            const covered = await win.webContents.executeJavaScript(buildProductCoverScript(subjects, { width, height }), true) as Array<{ text: string; share: number }> | undefined;
            for (const line of Array.isArray(covered) ? covered : []) {
              if (line.share < PRODUCT_COVER_MIN_SHARE) continue;
              if (!wordsOnProduct.some((seen) => seen.sceneId === scene.id && seen.text === line.text)) wordsOnProduct.push({ text: line.text, sceneId: scene.id });
            }
          }
          const shown = await win.webContents.executeJavaScript(SHOWN_SCENES_SCRIPT, true) as string[] | undefined;
          if (!Array.isArray(shown) || shown.includes(scene.id)) sceneOnPage = true;
          else shown.forEach((id) => shownInstead.add(id));
          const frameImage = normalizeCapturedFrame(captured, width, height).image;
          hashes.add(analyzeNativeImage(frameImage).hash);
          const probe = frameImage.resize({ width: EMPTY_FRAME_PROBE_WIDTH, quality: 'good' });
          const probeSize = probe.getSize();
          // The fullest of the frames counts: a scene that builds up starts out blank.
          sceneEmptyShare.set(scene.id, Math.min(
            sceneEmptyShare.get(scene.id) ?? 1,
            dominantFlatShare(probe.toBitmap(), probeSize.width, probeSize.height),
          ));
        }
        sceneHashes.set(scene.id, hashes);
        // Any of the samples will do: an old page can switch a little after its scene list.
        const pageStart = manifest.absolute_page?.scene_starts[scene.id];
        if (typeof pageStart === 'number' && !sceneOnPage) {
          notShown.push({
            code: 'PAGE_SCENE_NOT_SHOWN',
            severity: 'error',
            message: `Scene "${scene.id}" plays from ${pageStart}s on the page's timeline, but the page shows ${[...shownInstead].map((id) => `"${id}"`).join(', ') || 'no scene'} there. scene_starts in manifest.json and the times in the page disagree, so this would come out in the wrong order. Make them agree. The order scenes play in is their order in "scenes".`,
            sceneId: scene.id,
            source: SOURCE,
          });
        }
        p.onProgress?.({
          phase: 'video.check',
          message: `Checked scene ${scene.index + 1}/${timeline.scenes.length}.`,
          data: { sceneId: scene.id },
        });
      }
      // Layout findings inform; they do not stop a render. A page the model judged
      // acceptable after seeing them is its call, and the delivered file is what
      // video.ship gates.
      found.push(...dedupeInspectIssues(inspected).map((issue) => ({ ...issue, severity: 'warning' as const })));
      if (wordsOnProduct.length) {
        found.push({ code: 'TEXT_OVER_PRODUCT', severity: 'warning', message: wordsOnProductMessage(), sceneId: wordsOnProduct[0].sceneId, source: SOURCE });
      }
      for (const scene of timeline.scenes) {
        const emptyShare = sceneEmptyShare.get(scene.id) ?? 0;
        if (emptyShare > EMPTY_FRAME_SHARE_HINT) {
          found.push({
            code: 'SCENE_MOSTLY_EMPTY',
            severity: 'warning',
            message: `About ${Math.round(emptyShare * 100)}% of scene "${scene.id}" is one flat colour. Make the product, footage or type larger so the frame reads as full on a phone.`,
            sceneId: scene.id,
            source: SOURCE,
          });
        }
        const hashes = sceneHashes.get(scene.id);
        if (hashes && hashes.size === 1 && scene.frameCount > fps) {
          found.push({
            code: 'SCENE_STATIC',
            severity: 'warning',
            message: `Scene "${scene.id}" shows the same picture from start to end (${scene.durationSec.toFixed(1)}s). Add motion or shorten it.`,
            sceneId: scene.id,
            source: SOURCE,
          });
        }
      }
    }, {
      extraAllowedDirsAbs: [workDirAbs],
      adapterScript: buildVideoTimelineAdapterScript(manifest.absolute_page),
      onConsoleError: (message) => { if (pageErrors.length < 64) pageErrors.push(message); },
    });
    const scriptErrors = uncaughtPageErrors(pageErrors);
    for (const message of scriptErrors) {
      found.push({ code: 'PAGE_SCRIPT_ERROR', severity: 'error', message: `The page raised an error: ${message}`, source: SOURCE });
    }
    // A page whose script died shows nothing for that reason, and that is the one to fix.
    if (!scriptErrors.length) found.push(...notShown);
    return respond(found, facts);
  } catch (err) {
    if (err instanceof PageContractError) {
      found.push({ code: err.errorCode, severity: 'error', message: err.message, source: SOURCE });
      return respond(found, facts);
    }
    const review = visualReview('unavailable', summarizeCheckWarnings(found.filter((issue) => issue.severity !== 'error')));
    await saveReview(review);
    return { ok: false, op, errorCode: videoStudioErrorCode(err, 'E_VIDEO_CHECK_FAILED'), message: String((err as Error).message || err).slice(0, 400), issues: found, visual_review: review };
  } finally {
    await fs.rm(workDirAbs, { recursive: true, force: true }).catch((err) => {
      log.warn('check workspace cleanup failed', { error: logErrorSummary(err) });
    });
  }
}
