/** Public production request admission and durable asset bookkeeping. */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../logger';
import { atomicTmpPath, linkWithRetry, writeBytesAtomic } from '../storage';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { fileEditLock } from '../util/locks';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { sha256OfFileStream } from '../util/sha256';
import { throwIfAborted } from '../util/abort';
import { probeMedia, runVideoProcessForTest } from './video_studio';
import { localFileIdentity } from './generation_reference_assets';
import { appTaskMediaRoute } from './app_media_route';
import { appConversationOwner } from '../paths';
import { productionRequestHold, reserveProductionRequest, settleProductionRequest, releaseProductionRequest, type ProductionRequestKind } from './video_production_budget';
import { checkVideoProductionServices, type VideoParameterProblem, type VideoProductionServiceAvailability, type VideoProductionGenerationIntent } from './video_production_services';
import { VideoAssetLedgerSchema, type VideoAssetRecord } from './video_timeline';
const log = createLogger('video-production-spend');
const CLIP_PREVIEW_TIMEOUT_MS = 60000;
export function productionRequestFingerprint(request: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function ledgerPath(productionDirAbs: string): string {
  return path.join(productionDirAbs, 'assets.json');
}

function requireProductionPath(productionDirAbs: string, fileAbs: string): void {
  if (!isPathAllowed(fileAbs, [productionDirAbs])) {
    throw new Error(`Resource reference escapes the composition directory: ${path.relative(productionDirAbs, fileAbs)}`);
  }
}

function assetIdFrom(filePath: string, taken: Set<string>): string {
  const stem = path.basename(filePath, path.extname(filePath)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
  const base = /^[A-Za-z0-9]/.test(stem) ? stem : `a-${stem}`;
  let id = base;
  for (let suffix = 2;taken.has(id);suffix += 1) id = `${base}-${suffix}`;
  return id;
}

export async function recordProductionAsset(input: {
  productionDirAbs: string;
  fileAbs: string;
  record: Omit<VideoAssetRecord, 'id' | 'path'>;
}): Promise<string> {
  const file = ledgerPath(input.productionDirAbs);
  requireProductionPath(input.productionDirAbs, file);
  await fs.mkdir(input.productionDirAbs, { recursive: true });
  return fileEditLock(file).runExclusive(async () => {
    requireProductionPath(input.productionDirAbs, file);
    let assets: VideoAssetRecord[] = [];
    try {
      assets = VideoAssetLedgerSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).assets;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Never overwrite a ledger the model can still repair by hand.
        log.warn('asset ledger unreadable; result not recorded', { error: logErrorSummary(err) });
        throw new Error('assets.json could not be read, so this file was not added to it.');
      }
    }
    const relative = path.relative(input.productionDirAbs, input.fileAbs);
    const portable = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : input.fileAbs;
    const existing = assets.find((asset) => asset.path === portable);
    const id = existing?.id ?? assetIdFrom(input.fileAbs, new Set(assets.map((asset) => asset.id)));
    const row: VideoAssetRecord = { ...input.record, id, path: portable };
    const next = existing ? assets.map((asset) => (asset === existing ? row : asset)) : [...assets, row];
    await writeBytesAtomic(file, Buffer.from(`${JSON.stringify({ assets: next }, null, 2)}\n`));
    return id;
  });
}

const ATTACHMENT_KINDS: Array<[VideoAssetRecord['kind'], RegExp]> = [
  ['image', /\.(?:jpe?g|png|webp|gif|bmp|avif)$/i],
  ['video', /\.(?:mp4|mov|m4v|webm|mkv|avi)$/i],
  ['audio', /\.(?:mp3|wav|m4a|aac|flac|ogg|opus)$/i],
];

const MAX_IMPORTED_ATTACHMENTS = 32;

export type ImportedAttachment = {
  asset_id: string;
  kind: VideoAssetRecord['kind'];
  label: string;
  path: string;
  duration_sec?: number;
  width?: number;
  height?: number;
};

async function describeImported(input: {
  productionDirAbs: string;
  fileAbs: string;
  kind: VideoAssetRecord['kind'];
  label: string;
  signal?: AbortSignal;
}): Promise<ImportedAttachment> {
  const assetId = await recordProductionAsset({
    productionDirAbs: input.productionDirAbs,
    fileAbs: input.fileAbs,
    record: { kind: input.kind, label: input.label, origin: 'upload' },
  });
  const { ffprobe } = bundledFfmpegPaths();
  const probe = input.kind !== 'audio' && ffprobe ? await probeMedia(ffprobe, input.fileAbs, input.signal) : null;
  return {
    asset_id: assetId,
    kind: input.kind,
    label: input.label,
    path: path.relative(input.productionDirAbs, input.fileAbs).split(path.sep).join('/'),
    ...(input.kind === 'video' && probe?.duration_seconds ? { duration_sec: probe.duration_seconds } : {}),
    ...(probe?.video?.width && probe.video.height ? { width: probe.video.width, height: probe.video.height } : {}),
  };
}

export async function importProductionAttachments(input: {
  productionDirAbs: string;
  attachmentDirAbs: string;
  names?: readonly string[];
  signal?: AbortSignal;
}): Promise<{ imported: ImportedAttachment[]; skipped: string[] }> {
  const wanted = input.names?.length ? new Set(input.names) : null;
  const entries = await fs.readdir(input.attachmentDirAbs, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && (!wanted || wanted.has(entry.name))).slice(0, MAX_IMPORTED_ATTACHMENTS);
  const mediaDir = path.join(input.productionDirAbs, 'media');
  return fileEditLock(mediaDir).runExclusive(async () => {
    requireProductionPath(input.productionDirAbs, mediaDir);
    requireProductionPath(input.productionDirAbs, ledgerPath(input.productionDirAbs));
    const imported: ImportedAttachment[] = [];
    const skipped: string[] = [];
    for (const entry of files) {
      const kind = ATTACHMENT_KINDS.find(([, pattern]) => pattern.test(entry.name))?.[0];
      if (!kind) {
        skipped.push(entry.name);
        continue;
      }
      const source = path.join(input.attachmentDirAbs, entry.name);
      const copy = path.join(mediaDir, entry.name);
      requireProductionPath(input.productionDirAbs, copy);
      await fs.mkdir(mediaDir, { recursive: true });
      const [sourceStat, copyStat] = await Promise.all([fs.stat(source), fs.stat(copy).catch(() => null)]);
      const sameBytes = copyStat?.isFile() && copyStat.size === sourceStat.size
        && await sha256OfFileStream(source) === await sha256OfFileStream(copy);
      if (!sameBytes) await fs.copyFile(source, copy, fsConstants.COPYFILE_FICLONE);
      imported.push(await describeImported({
        productionDirAbs: input.productionDirAbs,
        fileAbs: copy,
        kind,
        label: entry.name,
        ...(input.signal ? { signal: input.signal } : {}),
      }));
    }
    return { imported, skipped: [...skipped, ...(wanted ? [...wanted].filter((name) => !files.some((file) => file.name === name)) : [])] };
  });
}

export async function importProductionFile(input: {
  productionDirAbs: string;
  sourceAbs: string;
  name: string;
  signal?: AbortSignal;
}): Promise<ImportedAttachment | null> {
  const name = path.basename(input.name);
  const kind = ATTACHMENT_KINDS.find(([, pattern]) => pattern.test(name))?.[0];
  if (!kind) return null;
  const mediaDir = path.join(input.productionDirAbs, 'media');
  return fileEditLock(mediaDir).runExclusive(async () => {
    requireProductionPath(input.productionDirAbs, mediaDir);
    requireProductionPath(input.productionDirAbs, ledgerPath(input.productionDirAbs));
    await fs.mkdir(mediaDir, { recursive: true });
    const sourceHash = await sha256OfFileStream(input.sourceAbs);
    const { name: stem, ext } = path.parse(name);
    let target = path.join(mediaDir, name);
    let staged: string | undefined;
    try {
      for (let suffix = 2; ; suffix += 1) {
        requireProductionPath(input.productionDirAbs, target);
        const existing = await sha256OfFileStream(target).catch(() => null);
        if (existing === sourceHash) break;
        if (existing === null) {
          if (!staged) {
            staged = atomicTmpPath(target);
            requireProductionPath(input.productionDirAbs, staged);
            await fs.copyFile(input.sourceAbs, staged, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
          }
          try {
            // Publish complete bytes atomically without replacing a competing import.
            await linkWithRetry(staged, target);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            requireProductionPath(input.productionDirAbs, target);
            if (await sha256OfFileStream(target).catch(() => null) === sourceHash) break;
          }
        }
        target = path.join(mediaDir, `${stem}-${suffix}${ext}`);
      }
    } finally {
      if (staged) await fs.rm(staged, { force: true }).catch(error => {
        log.warn('temporary media import cleanup failed', { error: logErrorSummary(error) });
      });
    }
    // These bytes may already be listed, perhaps as a paid result, and stay what they are.
    const raw = await fs.readFile(ledgerPath(input.productionDirAbs), 'utf8').catch(() => '');
    const listed = raw ? VideoAssetLedgerSchema.parse(JSON.parse(raw)).assets.find((row) => path.resolve(input.productionDirAbs, row.path) === target) : undefined;
    if (listed) return { asset_id: listed.id, kind: listed.kind, label: listed.label, path: listed.path };
    return describeImported({
      productionDirAbs: input.productionDirAbs,
      fileAbs: target,
      kind,
      label: name,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  });
}

export const OWN_KEY_RESULT_PREFIX = '{"billed_to_own_key":true';

async function clipPreviewPng(fileAbs: string, durationSec: number, signal?: AbortSignal): Promise<Buffer | null> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-clip-preview-'));
  const out = path.join(dir, 'preview.png');
  try {
    const rate = Math.max(0.05, 3 / Math.max(0.5, durationSec));
    const run = await runVideoProcessForTest(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', fileAbs,
      '-vf', `fps=${rate.toFixed(4)},scale=480:-2,tile=3x1`, '-frames:v', '1', out,
    ], { timeoutMs: CLIP_PREVIEW_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return run.code === 0 ? await fs.readFile(out) : null;
  } catch (err) {
    log.warn('clip preview failed', { error: logErrorSummary(err) });
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

type LedgerRef = NonNullable<VideoAssetRecord['refs']>[number];

async function referencesInLedger(
  productionDirAbs: string,
  files: readonly string[],
  frames: TimelineFrameFiles = {},
): Promise<LedgerRef[]> {
  const named: Array<{ file: string; role: LedgerRef['role'] }> = [
    ...(frames.first_frame ? [{ file: frames.first_frame, role: 'first_frame' as const }] : []),
    ...files.map((file) => ({ file, role: 'reference' as const })),
    ...(frames.last_frame ? [{ file: frames.last_frame, role: 'last_frame' as const }] : []),
  ];
  if (!named.length) return [];
  const raw = await fs.readFile(ledgerPath(productionDirAbs), 'utf8').catch(() => '');
  const parsed = raw ? VideoAssetLedgerSchema.safeParse(JSON.parse(raw)) : null;
  const byPath = new Map((parsed?.success ? parsed.data.assets : []).map((asset) => [path.resolve(productionDirAbs, asset.path), asset.id]));
  return named.flatMap(({ file, role }) => {
    const asset = byPath.get(path.resolve(file));
    return asset ? [{ asset, role }] : [];
  });
}

export type TimelineFrameFiles = { first_frame?: string; last_frame?: string };
export type ProductionQuoteContext = { userId: string; cid?: string };
export async function quoteProductionIntents(intents: VideoProductionGenerationIntent[], signal?: AbortSignal, context?: ProductionQuoteContext, videoProfileId?: string): Promise<VideoProductionServiceAvailability> {
  if (!context?.cid || !appConversationOwner(context.cid)) return checkVideoProductionServices(intents, signal, videoProfileId);
  const [videoRoute, imageRoute] = await Promise.all([appTaskMediaRoute(context.userId, context.cid, 'video', signal), appTaskMediaRoute(context.userId, context.cid, 'image', signal)]);
  return checkVideoProductionServices(intents, signal, videoRoute || videoProfileId, imageRoute);
}
export function videoParametersRefusal(error: unknown): string | null {
  const problem = (error as { videoParameters?: VideoParameterProblem } | null)?.videoParameters;
  if (!problem || typeof problem.reason !== 'string') return null;
  return problem.silentOnly ? `${problem.model} always makes video with sound, so this request was not sent. Ask again with generate_audio true: a clip's own sound stays out of the video unless the clip sets "audio": "keep".` : `${problem.reason} Nothing was sent. Change the request to fit and ask again.`;
}
export function isExternallyBilled(quote: VideoProductionServiceAvailability): boolean { return quote.sufficient && quote.externally_billed_segment_ids.length > 0; }
export const settleProductionSpend = settleProductionRequest;
export const releaseProductionSpend = releaseProductionRequest;
export type TimelineSpend = { scope: string; productionDirAbs: string; fingerprint: string; heldNow: boolean; videoRoute?: string };
export type TimelineGenerationStart = { spend: TimelineSpend; reusedPath?: string } | { refusal: { content: string; isError: true } };
function generationRefusal(errorCode: string, message: string): TimelineGenerationStart { return { refusal: { content: JSON.stringify({ ok: false, errorCode, message }), isError: true } }; }
/** Admission is shared by both image and video tools, outside the writable production. */
export async function beginTimelineGeneration(input: {
  userId: string; scope: string; productionDirAbs: string; allowedRoots: readonly string[]; kind: ProductionRequestKind;
  intent: VideoProductionGenerationIntent; requestedAbs: string; request: Record<string, unknown>; shot?: string; referenceFiles?: readonly string[]; videoProfileId?: string; signal?: AbortSignal;
}): Promise<TimelineGenerationStart> {
  if (!isPathAllowed(input.productionDirAbs, input.allowedRoots) || !isPathAllowed(input.requestedAbs, input.allowedRoots)) return generationRefusal('E_PATH_OUT_OF_SCOPE', 'The generation paths are outside the task workspace.');
  throwIfAborted(input.signal);
  const fingerprint = productionRequestFingerprint({ ...input.request, output: input.requestedAbs, reference_files: (input.referenceFiles ?? []).map(file => [file, localFileIdentity(file)]) });
  const key = { userId: input.userId, scope: input.scope, fingerprint };
  const held = await productionRequestHold(key);
  const spend = (heldNow: boolean, videoRoute?: string): TimelineSpend => ({ scope: input.scope, productionDirAbs: input.productionDirAbs, fingerprint, heldNow, ...(videoRoute ? { videoRoute } : {}) });
  const pending = () => generationRefusal('E_GENERATION_PENDING', 'The same generation request is still pending. No new request was sent.');
  if (held?.state === 'reserved') return pending();
  if (held?.state === 'settled') {
    const saved = held.output ?? input.requestedAbs;
    if (!isPathAllowed(saved, input.allowedRoots)) return generationRefusal('E_PATH_OUT_OF_SCOPE', 'The earlier generation result is outside the task workspace.');
    if (await fs.stat(saved).then(stat => stat.isFile(), () => false)) return { spend: spend(false, held.video_route), reusedPath: saved };
  }
  const route = input.videoProfileId ?? held?.video_route;
  try {
    const quote = await quoteProductionIntents([input.intent], input.signal, { userId: input.userId, cid: input.scope }, route);
    if (!quote.sufficient) return generationRefusal('E_UNAVAILABLE', 'No configured service can make this request. Nothing was sent.');
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const reason = videoParametersRefusal(error);
    return generationRefusal(reason ? 'E_VIDEO_PARAMETERS_INVALID' : 'E_UNAVAILABLE', reason ?? 'The configured generation service could not be checked. Nothing was sent.');
  }
  throwIfAborted(input.signal);
  const reserved = await reserveProductionRequest({ ...key, kind: input.kind, ...(held?.state === 'settled' ? { sendAgain: true } : {}), ...(route ? { videoRoute: route } : {}), ...(input.shot ? { production: { dir: input.productionDirAbs, shot: input.shot } } : {}) });
  if (reserved.status === 'already_reserved') return pending();
  if (reserved.status === 'already_settled') {
    const current = await productionRequestHold(key), saved = current?.output ?? input.requestedAbs;
    if (isPathAllowed(saved, input.allowedRoots) && await fs.stat(saved).then(stat => stat.isFile(), () => false)) return { spend: spend(false, current?.video_route), reusedPath: saved };
    return generationRefusal('E_GENERATION_PENDING', 'The earlier generation result is unavailable. No new request was sent.');
  }
  return { spend: spend(true, route) };
}
export type TimelineGenerationResult = { billed_to_own_key: true; asset_id?: string; duration_seconds?: number; width?: number; height?: number; note?: string; previewPng?: Buffer | null };
/** A completed file survives a later ledger failure; neither condition resends generation. */
export async function finishTimelineGeneration(input: { spend: TimelineSpend; userId: string; kind: ProductionRequestKind; fileAbs: string; prompt: string; shot?: string; label?: string; model?: string; referenceFiles?: readonly string[]; frameFiles?: TimelineFrameFiles; request?: Record<string, unknown>; signal?: AbortSignal }): Promise<TimelineGenerationResult> {
  await settleProductionRequest({ userId: input.userId, scope: input.spend.scope, fingerprint: input.spend.fingerprint, output: input.fileAbs });
  const { ffprobe } = bundledFfmpegPaths(); const probe = ffprobe ? await probeMedia(ffprobe, input.fileAbs, input.signal) : null;
  const out: TimelineGenerationResult = { billed_to_own_key: true };
  if (probe?.duration_seconds) out.duration_seconds = probe.duration_seconds; if (probe?.video?.width) out.width = probe.video.width; if (probe?.video?.height) out.height = probe.video.height;
  try {
    const refs = await referencesInLedger(input.spend.productionDirAbs, input.referenceFiles ?? [], input.frameFiles);
    out.asset_id = await recordProductionAsset({ productionDirAbs: input.spend.productionDirAbs, fileAbs: input.fileAbs, record: { kind: input.kind, label: input.label || path.basename(input.fileAbs), origin: 'generated', prompt: input.prompt, ...(input.shot ? { shot: input.shot } : {}), ...(input.model ? { model: input.model } : {}), ...(refs.length ? { refs } : {}), ...(input.request ? { request: input.request } : {}) } });
  } catch (error) { out.note = `${(error as Error).message} Add this file to assets.json yourself.`; }
  if (input.kind === 'video') out.previewPng = await clipPreviewPng(input.fileAbs, out.duration_seconds ?? 1, input.signal);
  return out;
}
