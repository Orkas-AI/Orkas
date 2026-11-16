/**
 * The `video_studio` tool for timeline productions. A production is one folder; a
 * video in it is `videos/<id>/` holding `manifest.json` and an optional `index.html`.
 * There is no approval state here: the model edits those files directly, and this
 * tool checks them, renders them and judges the result.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getWorkspacePath } from '../../features/user_workspace';
import { readUpgradeNotes, upgradeWorkspaceOnce } from '../../features/video_project_upgrade';
import {
  checkInstalledVideoStudioContract,
  VIDEO_STUDIO_TOOL_CONTRACT,
} from '../../features/video_studio_skill_contract';
import { finalizeProducedFile } from '../../features/produced_output_hooks';
import { productionRequestStatus } from '../../features/video_production_budget';
import {
  importProductionAttachments,
  importProductionFile,
  isExternallyBilled,
  quoteProductionIntents,
  videoParametersRefusal,
} from '../../features/video_production_spend';
import type { VideoStudioResult } from '../../features/video_studio';
import {
  checkVideoTimeline,
  visualReview,
  loadVideoProject,
  renderVideoTimeline,
  sheetVideoTimeline,
} from '../../features/video_timeline_render';
import { shipVideoFile, writeDeliveredFrameSheet, type VideoVersion } from '../../features/video_timeline_ship';
import { VIDEO_STUDIO_AGENT_ID } from './tool-catalog';
import { deriveVideoStudioOutcome } from './video-studio-tool';
import {
  allowedRoots,
  defaultRoot,
  notifyWritten,
  prepareVideoStudioModelVisual,
  publishVisibleOutputs,
  resolvePath,
  videoStudioSegmentCachePath,
  type VideoStudioToolOpts,
} from './video-studio-tool';
import { deriveVideoTimeline } from '../../features/video_timeline';
import { isPathAllowed } from '../../util/path-sandbox';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { VIDEO_QUOTE_FAILURE_MESSAGE, videoQuoteFailureDetails } from '../../features/video_production_quote_error';
import { chatAttachmentDirForConversation } from '../../util/project-layout';

const log = createLogger('video-timeline-tool');

const SHARED_OPS = new Set(['reference.inspect', 'product.capture', 'speech.capabilities', 'speech.transcribe']);
const OPS = [
  'video.status',
  'video.import',
  'video.request_budget',
  'video.check',
  'video.sheet',
  'video.render',
  'video.ship',
  ...SHARED_OPS,
];
const MAX_LISTED_VIDEOS = 32;
const MAX_LISTED_PRODUCTION_CANDIDATES = 200;
const VIDEO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DEFAULT_VIDEO_ID = 'main';
/** The frames invite a fix after delivery: the first ship plus at most two repairs, per video. */
const MAX_DELIVERIES_TO_REWORK = 3;
const MAX_UPGRADE_NOTES_CHARS = 4000;
const DELIVERED_FRAMES_LOOK = "These are frames from the published file. Rework is still available this turn. Apply the video-studio Skill's Deliver section to decide whether to repair, report a blocker, or finish.";
const DELIVERED_FRAMES_LAST_LOOK = "These are frames from the published file. This turn's rework limit has been reached; do not rework again. Apply the video-studio Skill's Deliver section for an honest final status.";
/** A production that keeps reference notes follows a reference; its first delivery names what
 *  the video left out of it and how the user could still have it. */
const REFERENCE_DROPS_MESSAGE = 'This video follows a reference. In your reply, name what reference-notes.md drops and why, and for a presenter or character the user has no footage of, offer to add one from footage they film or as an original generated one, priced when they ask.';
/** Delivery findings that are defects to repair, not editorial notes. */
const REPAIR_FINDINGS = new Set(['DELIVERY_SILENT_STRETCH', 'DELIVERY_NARRATION_OVER_SPEECH', 'DELIVERY_CUTS_OFF_BEAT']);

/** What to do about repair findings: fix and ship again while rework remains, else name them. */
function repairInstruction(warnings: unknown, shipped: number): string | null {
  const found = (Array.isArray(warnings) ? warnings : [])
    .filter((w): w is { code: string; message: string } => !!w && typeof w === 'object'
      && REPAIR_FINDINGS.has(String((w as { code?: unknown }).code)) && typeof (w as { message?: unknown }).message === 'string');
  if (!found.length) return null;
  const listed = found.map((w) => w.message).join(' ');
  return shipped < MAX_DELIVERIES_TO_REWORK
    ? `Repair before you reply: ${listed} Then deliver this video again.`
    : `These remain and the rework limit is reached: ${listed} Name them in your reply as known problems.`;
}

function reply(result: Record<string, unknown>, extra: Partial<ToolResult> = {}): ToolResult {
  const content = JSON.stringify({
    contract_version: VIDEO_STUDIO_TOOL_CONTRACT,
    outcome: deriveVideoStudioOutcome(result),
    ...(['video.check', 'video.render', 'video.ship'].includes(String(result.op))
      ? { visual_review: visualReview(result.ok === false ? 'unavailable' : 'not_checked') } : {}),
    ...result,
  });
  return { content, ...(result.ok === false ? { isError: true } : {}), ...extra } as ToolResult;
}

function refuse(op: string, errorCode: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return reply({ ok: false, op, errorCode, message, ...extra });
}

type Located = { productionDirAbs: string; roots: string[] };

function locateProduction(input: Record<string, unknown>, ctx: ToolContext, opts: VideoStudioToolOpts): Located | string {
  const raw = typeof input.production_dir === 'string' ? input.production_dir.trim() : '';
  if (!raw) return 'production_dir is required: the folder holding this production, for example lamp-ad.';
  const roots = allowedRoots(opts);
  const productionDirAbs = resolvePath(ctx, opts, raw, roots);
  const writable = [defaultRoot(opts, ctx), getWorkspacePath(opts.userId, opts.projectId, opts.cid)];
  if (!isPathAllowed(productionDirAbs, writable)) {
    return `production_dir must be inside the workspace: ${productionDirAbs}`;
  }
  for (const name of ['assets.json', 'product.json', 'versions.json', 'videos', 'media', 'shots', 'render', 'preview', 'versions']) {
    if (!isPathAllowed(path.join(productionDirAbs, name), [productionDirAbs])) {
      return `production_dir must be inside the workspace: ${productionDirAbs}`;
    }
  }
  return { productionDirAbs, roots };
}

function videoDirOf(productionDirAbs: string, videoId: unknown): string | null {
  const id = typeof videoId === 'string' ? videoId.trim() : '';
  return VIDEO_ID_RE.test(id) ? path.join(productionDirAbs, 'videos', id) : null;
}

/** Folders in the workspace that hold a production, so a later turn can find its work
 *  without remembering a name. Bounded to one directory level. */
async function listProductions(ctx: ToolContext, opts: VideoStudioToolOpts): Promise<string[]> {
  const base = defaultRoot(opts, ctx);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const found: string[] = await fs.stat(path.join(base, 'videos')).then((st) => (st.isDirectory() ? ['.'] : []), () => []);
  for (const entry of entries.filter((item) => item.isDirectory()).slice(0, MAX_LISTED_PRODUCTION_CANDIDATES)) {
    const dir = path.join(base, entry.name);
    const isProduction = await fs.stat(path.join(dir, 'videos')).then((st) => st.isDirectory(), () => false)
      || await fs.stat(path.join(dir, 'assets.json')).then((st) => st.isFile(), () => false);
    if (isProduction) found.push(entry.name);
  }
  return found;
}

/** A relative path may start at the production or at the workspace; models write both. */
async function resolveDeliveredPath(
  raw: string,
  productionDirAbs: string,
  ctx: ToolContext,
  opts: VideoStudioToolOpts,
  roots: string[],
): Promise<string> {
  if (!path.isAbsolute(raw)) {
    const inProduction = path.resolve(productionDirAbs, raw);
    if (isPathAllowed(inProduction, roots) && await fs.stat(inProduction).then((stat) => stat.isFile(), () => false)) {
      return inProduction;
    }
  }
  return resolvePath(ctx, opts, raw, roots);
}

/** A relative output lands in the production, where video.ship looks first, unless it already
 *  names the production from the workspace. On 2026-11-08 render/main-179.mp4 was written
 *  beside the production, so shipping that path could have sent an older file inside it. */
function resolveRenderOutputPath(
  raw: string,
  productionDirAbs: string,
  ctx: ToolContext,
  opts: VideoStudioToolOpts,
  roots: string[],
): string {
  const fromWorkspace = resolvePath(ctx, opts, raw, roots);
  if (path.isAbsolute(raw) || isPathAllowed(fromWorkspace, [productionDirAbs])) return fromWorkspace;
  return path.resolve(productionDirAbs, raw);
}

/** Keep render bookkeeping out: a live run mistook cost_units for credits.
 *  Advisory visual evidence remains explicit even when media checks are clean. */
export function renderResultForModel(result: Record<string, unknown>): Record<string, unknown> {
  const { render_profile: _profile, probe: _probe, media_qa: mediaQa, loudness, ...rest } = result;
  const qa = mediaQa as { issue_count?: number } | undefined;
  const level = loudness as { skipped?: boolean } | undefined;
  return {
    ...rest,
    ...(qa?.issue_count ? { media_qa: qa } : {}),
    ...(level && !level.skipped ? { loudness: level } : {}),
  };
}

async function deliveredFramesVisual(
  videoPathAbs: string,
  version: VideoVersion | undefined,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mediaType: 'image/png' | 'image/webp' } | null> {
  const [width, height] = (version?.canvas ?? '').split('x').map(Number);
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-delivered-'));
    const sheet = await writeDeliveredFrameSheet({
      videoPathAbs,
      outputDirAbs: dir,
      durationSec: version?.duration_sec ?? 0,
      width: width ?? 0,
      height: height ?? 0,
      ...(signal ? { signal } : {}),
    });
    return sheet ? await prepareVideoStudioModelVisual(sheet) : null;
  } catch (err) {
    log.warn('delivered frames unavailable', { error: logErrorSummary(err) });
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The first look at a workspace brings its old productions over. */
async function upgradeForStatus(opts: VideoStudioToolOpts, ctx: ToolContext): Promise<Record<string, unknown>> {
  const results = await upgradeWorkspaceOnce({
    userId: opts.userId,
    workspaceAbs: defaultRoot(opts, ctx),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!results.length) return {};
  return {
    upgraded: results,
    message: 'Old productions in this workspace were upgraded to timelines. Their plans and approvals no longer apply, and nothing is waiting for a confirmation: read upgrade_notes and carry on.',
  };
}

async function productionStatus(input: {
  productionDirAbs: string;
  scope: string;
  opts: VideoStudioToolOpts;
  roots: string[];
}): Promise<Record<string, unknown>> {
  const { productionDirAbs, scope, opts, roots } = input;
  const entries = await fs.readdir(path.join(productionDirAbs, 'videos'), { withFileTypes: true }).catch(() => []);
  const videos: Array<Record<string, unknown>> = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.')).slice(0, MAX_LISTED_VIDEOS)) {
    const project = await loadVideoProject({
      productionDirAbs,
      videoDirAbs: path.join(productionDirAbs, 'videos', entry.name),
      allowedRoots: roots,
    });
    if (!project.manifest) {
      videos.push({ id: entry.name, readable: false });
      continue;
    }
    const timeline = deriveVideoTimeline(project.manifest);
    const notes = project.manifest.upgraded_from ? await readUpgradeNotes(path.join(productionDirAbs, 'videos', entry.name)) : null;
    videos.push({
      id: entry.name,
      label: project.manifest.label,
      duration_seconds: timeline.durationSec,
      scenes: timeline.scenes.map((scene) => scene.id),
      has_page: project.html !== null,
      ...(notes ? { upgrade_notes: notes.slice(0, MAX_UPGRADE_NOTES_CHARS) } : {}),
    });
  }
  const versions = await fs.readFile(path.join(productionDirAbs, 'versions.json'), 'utf8')
    .then((raw) => (JSON.parse(raw) as { versions?: unknown[] }).versions ?? [])
    .catch(() => []);
  const assets = await fs.readFile(path.join(productionDirAbs, 'assets.json'), 'utf8')
    .then((raw) => (JSON.parse(raw) as { assets?: unknown[] }).assets ?? [])
    .catch(() => []);
  return {
    generation_requests: await productionRequestStatus({ userId: opts.userId, scope }),
    videos,
    asset_count: assets.length,
    versions,
  };
}

const NOTHING_TO_PRICE = 'planned is empty, so there is nothing to price. If you are not generating anything, you do not need video.request_budget: carry on with what you have.';

/** One entry of `planned`, in the shape the credit quote reads. */
function plannedIntents(raw: unknown): Array<{ segment_id: string; kind: 'video' | 'image'; prompt: string; ratio?: string; duration?: number; resolution?: string; quality?: string; generate_audio?: boolean; size?: string }> | string {
  if (!Array.isArray(raw)) return 'planned must list what you intend to generate.';
  // On 2026-11-07 a run with nothing to generate priced an empty plan, and the old answer sent
  // it looking for something to list.
  if (!raw.length) return NOTHING_TO_PRICE;
  const out: ReturnType<typeof plannedIntents> = [];
  for (const [index, item] of raw.entries()) {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (entry.kind !== 'video' && entry.kind !== 'image') return `planned[${index}].kind must be video or image.`;
    // A count below one plans none of it: on 2026-11-10 `count: 0` was priced as one image.
    if (Number.isInteger(entry.count) && Number(entry.count) < 1) continue;
    const count = Number.isInteger(entry.count) ? Math.min(Number(entry.count), 20) : 1;
    for (let copy = 0; copy < count; copy += 1) {
      out.push({
        segment_id: `planned-${index + 1}-${copy + 1}`,
        kind: entry.kind,
        prompt: '',
        ...(typeof entry.ratio === 'string' ? { ratio: entry.ratio } : {}),
        ...(typeof entry.duration === 'number' ? { duration: entry.duration } : {}),
        ...(typeof entry.resolution === 'string' ? { resolution: entry.resolution } : {}),
        ...(typeof entry.quality === 'string' ? { quality: entry.quality } : {}),
        ...(typeof entry.generate_audio === 'boolean' ? { generate_audio: entry.generate_audio } : {}),
      });
    }
  }
  return out.length ? out : NOTHING_TO_PRICE;
}

function checkFailure(result: VideoStudioResult): ToolResult {
  return reply(result as Record<string, unknown>);
}

/**
 * The operations implemented in video-studio-tool. Files they save belong beside the
 * page that uses them; on 2026-11-04 captures landed in a folder nothing here reads,
 * and a live run looked for them, found nothing and gave up.
 */
async function sharedOp(op: string, input: Record<string, unknown>, shared: AgentTool, ctx: ToolContext, opts: VideoStudioToolOpts): Promise<ToolResult> {
  const { video_dir: rawVideoDir, production_dir: rawProductionDir, ...rest } = input;
  const videoDir = typeof rawVideoDir === 'string' ? rawVideoDir.trim() : '';
  const productionDir = typeof rawProductionDir === 'string' ? rawProductionDir.trim() : '';
  const folder = videoDir || (productionDir ? path.join(productionDir, 'videos', DEFAULT_VIDEO_ID) : '');
  if (op === 'product.capture' && !folder) {
    return refuse(op, 'E_PRODUCTION_DIR', 'production_dir is required, so the captured files land in this production: for example lamp-ad.');
  }
  const savesFiles = op === 'product.capture' || op === 'reference.inspect';
  // video.import reports paths inside the production, and these read from the workspace.
  const inputPath = typeof rest.input_path === 'string' ? rest.input_path.trim() : '';
  const inProduction = inputPath && productionDir
    ? { input_path: await resolveDeliveredPath(inputPath, resolvePath(ctx, opts, productionDir, allowedRoots(opts)), ctx, opts, allowedRoots(opts)) }
    : {};
  // A transcript named relative to the production lands in it, as its input is read from it:
  // on 2026-11-12 `transcript.json` with production_dir set was written at the workspace root,
  // and the next call looked for it in the production.
  const transcriptPath = typeof rest.transcript_path === 'string' ? rest.transcript_path.trim() : '';
  if (transcriptPath && productionDir) {
    (inProduction as Record<string, unknown>).transcript_path = resolveRenderOutputPath(
      transcriptPath, resolvePath(ctx, opts, productionDir, allowedRoots(opts)), ctx, opts, allowedRoots(opts));
  }
  const result = await shared.execute({ ...rest, ...inProduction, ...(savesFiles && folder ? { composition_dir: folder } : {}) }, ctx);
  if ((op !== 'product.capture' && op !== 'speech.capabilities') || typeof result.content !== 'string') return result;
  try {
    const body = JSON.parse(result.content) as Record<string, unknown>;
    if (op === 'speech.capabilities') {
      // Told to configure a provider first, a live run asked the user to, and stopped.
      return body.status === 'unavailable'
        ? { ...result, content: JSON.stringify({ ...body, message: `${String(body.message ?? '')} Do not stop for this: use on-screen text and captions, and say so in your reply.`.trim() }) }
        : result;
    }
    if (typeof body.composition_dir !== 'string') return result;
    return { ...result, content: JSON.stringify({ ...body, paths_relative_to: body.composition_dir }) };
  } catch {
    return result;
  }
}

/** A repaired file saved under a new name is still the same video: `final-fixed`,
 *  `final-v2` and `final-normalized` all count against `final`. Numbered clips
 *  (`clip-01`, `clip-02`) stay apart. */
export function deliveryStem(stem: string): string {
  let out = stem;
  for (;;) {
    const next = out.replace(/[-_ ](?:v\d+|final|fixed|fix|new|repaired|repair|normalized|norm|loudnorm|out|again)$/i, '');
    if (next === out || !next) return out;
    out = next;
  }
}

/** What one delivery counts against: the timeline it was rendered from, or for a video
 *  made with ffmpeg alone the file's name. Several clips shipped in one turn are separate
 *  videos, each with its own repairs. */
function deliveryKey(productionDirAbs: string, videoId: unknown, videoPathAbs: string): string {
  const own = typeof videoId === 'string' && videoId.trim()
    ? `video:${videoId.trim()}`
    : `file:${deliveryStem(path.basename(videoPathAbs, path.extname(videoPathAbs)))}`;
  return `${productionDirAbs}\u0000${own}`;
}

export function createVideoTimelineTool(opts: VideoStudioToolOpts, shared: AgentTool): AgentTool {
  // Deliveries this run, per video: the first ship plus at most two repairs each.
  const deliveries = new Map<string, number>();
  const firstDelivery = new Map<string, boolean>();
  // Checks in this run that asked to move words off the product; the check stops asking after three.
  let wordsOnProductAsks = 0;
  return {
    name: 'video_studio',
    description:
      'Check, preview, render and deliver a timeline video; capture product pages; inspect reference videos; list voices and transcribe. ok reports operation success; visual_review reports advisory sampled-page findings.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: OPS,
          description: 'video.status: local generation requests, videos and delivered versions. video.import: copy attachments or scoped local media into the production and add them to assets.json. video.request_budget: check that configured services can make what you plan; service accounts bill directly. video.check: structure, files and page layout, no render. video.sheet: frames without rendering. video.render: write the mp4. video.ship: judge the final file and record it as a version.',
        },
        production_dir: { type: 'string', description: 'Folder holding this production, relative to the workspace. Required by video.* ops, except video.status, which without it lists the productions here.' },
        video_id: { type: 'string', description: 'A folder name under videos/. Required by check, sheet and render; on ship, names the timeline the file came from.' },
        names: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'video.import: attachment file names, instead of paths. Omit both to import all attachments.' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, description: 'video.import: local image, video or audio paths, relative to the workspace or absolute within read scope. Use instead of names; omit both to import conversation attachments.' },
        planned: {
          type: 'array',
          description: 'video.request_budget: everything you intend to generate.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['video', 'image'] },
              count: { type: 'integer', minimum: 1 },
              duration: { type: 'number', description: 'Seconds per video.' },
              resolution: { type: 'string' },
              ratio: { type: 'string' },
              quality: { type: 'string' },
              generate_audio: { type: 'boolean' },
            },
            required: ['kind'],
          },
        },
        times: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 32, description: 'video.sheet: seconds on the video to show. Default: the start and end of every scene.' },
        range: {
          type: 'object',
          description: 'video.sheet: every frame in this span instead of times, at most 32.',
          properties: { start_sec: { type: 'number' }, end_sec: { type: 'number' } },
          required: ['start_sec', 'end_sec'],
        },
        output_path: { type: 'string', description: 'video.render: where to write the mp4. Default render/<video_id>.mp4 in the production.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'video.render: default high. draft is 15fps and fast.' },
        path: { type: 'string', description: 'video.ship: the file to deliver, from any tool. Relative to the production or the workspace.' },
        expect_duration_sec: { type: 'number', description: 'video.ship without video_id: the intended length.' },
        expect_aspect: { type: 'string', description: 'video.ship without video_id: the intended shape, like 9:16.' },
        expect_audio: { type: 'boolean', description: 'video.ship without video_id: whether it must have sound.' },
        cut_to_beat: { type: 'boolean', description: 'true when the video is cut to its music\'s beat (卡点). Delivery then checks every cut of the delivered file against the soundtrack\'s beats.' },
        accept_findings: { type: 'array', items: { type: 'string' }, description: 'video.ship: blocking finding codes the user chose to deliver anyway, with accept_reason.' },
        accept_reason: { type: 'string', description: 'video.ship: what the user said, in their words.' },
        video_dir: { type: 'string', description: 'product.capture and reference.inspect: the video folder to save into. Default: videos/main in production_dir.' },
        input_path: { type: 'string', description: 'product.capture: scoped local .html/.htm entry up to 8 MiB, instead of url; local resources stay inside its directory. speech.transcribe or reference.inspect: media input; reference videos up to 256 MiB, frames are attached.' },
        url: { type: 'string', description: 'product.capture: the http(s) page to capture into assets/product/. reference.inspect: a page playing the reference video, such as a share link, used instead of input_path.' },
        clips: { type: 'array', items: { type: 'object' }, description: 'product.capture: page rects (CSS px, 1440 wide) to save at 2x.' },
        selectors: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'product.capture: CSS selectors to save at 2x.' },
        sample_times: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 32, description: 'reference.inspect: source seconds; omit to sample each detected shot.' },
        transcript_path: { type: 'string', description: 'speech.transcribe: where to save the transcript JSON.' },
        language: { type: 'string', description: 'speech.transcribe: ASR language or auto. speech.capabilities: narration language to list voices for.' },
        model: { type: 'string', description: 'speech.transcribe: ASR model id or path.' },
        timestamps: { type: 'string', enum: ['segment', 'word'], description: 'speech.transcribe timing detail.' },
      },
      required: ['op'],
    },
    async execute(input, ctx) {
      const op = String(input.op || '').trim();
      // Skills reach users through the marketplace and this tool through app releases,
      // so either can be ahead for a while. Say so, rather than fail on every operation.
      const installed = checkInstalledVideoStudioContract(opts.userId, VIDEO_STUDIO_AGENT_ID);
      if (installed.compatible === false) {
        return refuse(op, installed.direction === 'skill_outdated' ? 'E_VIDEO_STUDIO_SKILL_OUTDATED' : 'E_VIDEO_STUDIO_HOST_OUTDATED', installed.direction === 'skill_outdated'
          ? 'The installed VideoStudio agent is older than this app and cannot work with it. Do not retry. Tell the user to update VideoStudio in the marketplace, then ask again.'
          : 'The installed VideoStudio agent is newer than this app and cannot work with it. Do not retry. Tell the user to update Orkas, then ask again.');
      }
      if (!OPS.includes(op)) return refuse(op, 'E_VIDEO_OP_UNKNOWN', `op must be one of: ${OPS.join(', ')}`);
      if (SHARED_OPS.has(op)) return sharedOp(op, input as Record<string, unknown>, shared, ctx, opts);
      if (op === 'video.status' && !String(input.production_dir ?? '').trim()) {
        const upgrade = await upgradeForStatus(opts, ctx);
        return reply({ ok: true, op, productions: await listProductions(ctx, opts), ...upgrade });
      }
      const located = locateProduction(input, ctx, opts);
      if (typeof located === 'string') return refuse(op, 'E_PRODUCTION_DIR', located);
      const { productionDirAbs, roots } = located;
      const scope = opts.cid || productionDirAbs;
      const progress = (event: { phase: string; message: string; data?: Record<string, unknown> }) => {
        ctx.emitProgress?.({ phase: event.phase, message: event.message, ...(event.data ? { data: event.data } : {}) });
      };
      const signalOpt = ctx.signal ? { signal: ctx.signal } : {};

      if (op === 'video.status') {
        const upgrade = await upgradeForStatus(opts, ctx);
        return reply({ ok: true, op, ...(await productionStatus({ productionDirAbs, scope, opts, roots })), ...upgrade });
      }

      if (op === 'video.import') {
        if (input.paths !== undefined) {
          if (input.names !== undefined || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 32
            || input.paths.some(raw => typeof raw !== 'string' || !raw.trim())) {
            return refuse(op, 'E_VIDEO_IMPORT_INPUT', 'paths must contain 1–32 local media paths and cannot be combined with names.');
          }
          // Authorize and stat the whole batch before creating media or ledger files.
          const sources: string[] = [];
          for (const raw of input.paths as string[]) {
            const source = resolvePath(ctx, opts, raw, roots);
            if (!isPathAllowed(source, roots)) return refuse(op, 'E_PATH_OUT_OF_SCOPE', 'Import files must be inside the readable workspace or current attachments.');
            const stat = await fs.stat(source).catch(() => null);
            if (!stat?.isFile()) return refuse(op, 'E_VIDEO_IMPORT_INPUT', 'An import source is missing or is not a regular file. Choose an existing media file.');
            if (!sources.includes(source)) sources.push(source);
          }
          const imported = [];
          const skipped = [];
          try {
            for (const source of sources) {
              if (ctx.signal?.aborted) return refuse(op, 'E_VIDEO_IMPORT_CANCELLED', 'Media import was cancelled. Already imported assets remain available.');
              const asset = await importProductionFile({ productionDirAbs, sourceAbs: source, name: path.basename(source), ...signalOpt });
              if (asset) imported.push(asset);
              else skipped.push(path.basename(source));
            }
          } catch (err) {
            log.warn('local media import failed', { error: logErrorSummary(err) });
            return refuse(op, 'E_VIDEO_IMPORT_FAILED', 'A media file could not be imported. Already imported assets remain available; check the source files and retry.', { assets: imported });
          }
          return reply({ ok: true, op, assets: imported, ...(skipped.length ? { skipped } : {}),
            ...(imported.length ? {} : { message: 'The selected files contain no supported images, videos or audio.' }) });
        }
        if (!opts.cid) return refuse(op, 'E_VIDEO_IMPORT_NO_CONVERSATION', 'There are no attachments outside a conversation.');
        const { imported, skipped } = await importProductionAttachments({
          productionDirAbs,
          attachmentDirAbs: chatAttachmentDirForConversation(opts.userId, opts.cid),
          ...(Array.isArray(input.names) ? { names: input.names.map(String) } : {}),
          ...signalOpt,
        });
        return reply({
          ok: true,
          op,
          assets: imported,
          ...(skipped.length ? { skipped } : {}),
          ...(imported.length ? {} : { message: 'There are no images, videos or audio files attached to this conversation.' }),
        });
      }

      if (op === 'video.request_budget') {
        const intents = plannedIntents(input.planned);
        if (typeof intents === 'string') return refuse(op, 'E_BUDGET_PLAN', intents);
        let quote;
        try {
          quote = await quoteProductionIntents(intents, ctx.signal, { userId: opts.userId, ...(opts.cid ? { cid: opts.cid } : {}) });
        } catch (err) {
          const refusal = videoParametersRefusal(err);
          if (refusal) return refuse(op, 'E_VIDEO_PARAMETERS_INVALID', refusal);
          return refuse(op, 'E_BUDGET_QUOTE_FAILED', VIDEO_QUOTE_FAILURE_MESSAGE, { quote_error: videoQuoteFailureDetails(err) });
        }
        if (!quote.sufficient) return refuse(op, 'E_UNAVAILABLE', 'No configured service can make the full plan. Nothing was sent.');
        return reply({ ok: true, op, covered: true, billed_to_own_key: isExternallyBilled(quote), external_billing_estimate_available: false });
      }

      if (op === 'video.ship') {
        const raw = typeof input.path === 'string' ? input.path.trim() : '';
        if (!raw) return refuse(op, 'E_VIDEO_SHIP_PATH', 'path is required: the file to deliver.');
        const videoPathAbs = await resolveDeliveredPath(raw, productionDirAbs, ctx, opts, roots);
        const videoDirAbs = input.video_id === undefined ? undefined : videoDirOf(productionDirAbs, input.video_id);
        if (videoDirAbs === null) return refuse(op, 'E_VIDEO_ID', 'video_id must be a folder name under videos/.');
        const accepted = Array.isArray(input.accept_findings) ? input.accept_findings.map(String) : [];
        if (!firstDelivery.has(productionDirAbs)) {
          firstDelivery.set(productionDirAbs, await fs.readFile(path.join(productionDirAbs, 'versions.json'), 'utf8')
            .then((raw) => ((JSON.parse(raw) as { versions?: unknown[] }).versions ?? []).length === 0)
            .catch(() => true));
        }
        const expect = {
          ...(typeof input.expect_duration_sec === 'number' ? { durationSec: input.expect_duration_sec } : {}),
          ...(typeof input.expect_aspect === 'string' ? { aspect: input.expect_aspect } : {}),
          ...(typeof input.expect_audio === 'boolean' ? { hasAudio: input.expect_audio } : {}),
        };
        const result = await shipVideoFile({
          productionDirAbs,
          allowedRoots: roots,
          videoPathAbs,
          ...(videoDirAbs ? { videoDirAbs } : {}),
          ...(Object.keys(expect).length ? { expect } : {}),
          ...(accepted.length ? { override: { codes: accepted, reason: String(input.accept_reason || '') } } : {}),
          ...(input.cut_to_beat === true ? { cutToBeat: true } : {}),
          finalize: async (fileAbs) => {
            await finalizeProducedFile(fileAbs, {
              userId: opts.userId,
              ...(opts.cid ? { cid: opts.cid } : {}),
              ...(opts.projectId ? { projectId: opts.projectId } : {}),
              source: 'video_studio.ship',
            }).catch((err) => log.warn('delivery finalization failed', { error: logErrorSummary(err) }));
          },
          ...signalOpt,
        });
        if (!result.ok) return reply(result as Record<string, unknown>);
        const delivered = result.version as VideoVersion;
        const deliveredAbs = path.resolve(productionDirAbs, delivered.path);
        await notifyWritten(opts, [deliveredAbs]);
        await publishVisibleOutputs(opts, [deliveredAbs]);
        const key = deliveryKey(productionDirAbs, input.video_id, videoPathAbs);
        const shipped = (deliveries.get(key) ?? 0) + 1;
        deliveries.set(key, shipped);
        const visual = await deliveredFramesVisual(deliveredAbs, delivered, ctx.signal);
        const repair = repairInstruction((result as { warnings?: unknown }).warnings, shipped);
        const look = visual ? (shipped < MAX_DELIVERIES_TO_REWORK ? DELIVERED_FRAMES_LOOK : DELIVERED_FRAMES_LAST_LOOK) : null;
        const followsReference = firstDelivery.get(productionDirAbs) === true
          && await fs.stat(path.join(productionDirAbs, 'reference-notes.md')).then((stat) => stat.isFile(), () => false);
        const message = [repair, look, followsReference ? REFERENCE_DROPS_MESSAGE : null].filter(Boolean).join(' ');
        return reply(
          {
            ...result,
            visual_evidence: { attached: !!visual, role: 'delivered_frames' },
            ...(message ? { message } : {}),
          },
          visual ? { images: [visual], imageRetention: 'active_turn' as const } : {},
        );
      }

      const videoDirAbs = videoDirOf(productionDirAbs, input.video_id);
      if (!videoDirAbs) return refuse(op, 'E_VIDEO_ID', 'video_id must be a folder name under videos/.');
      const segmentCacheDirAbs = videoStudioSegmentCachePath(opts, productionDirAbs);
      const paths = { productionDirAbs, videoDirAbs, allowedRoots: roots, segmentCacheDirAbs };

      if (op === 'video.check') {
        const result = await checkVideoTimeline({
          ...paths,
          onProgress: progress,
          ...signalOpt,
          wordsOnProductAsked: wordsOnProductAsks,
          onWordsOnProductAsked: () => { wordsOnProductAsks += 1; },
        });
        return reply(result as Record<string, unknown>);
      }

      if (op === 'video.sheet') {
        const range = input.range && typeof input.range === 'object' ? input.range as Record<string, unknown> : null;
        const result = await sheetVideoTimeline({
          ...paths,
          outputDirAbs: path.join(productionDirAbs, 'preview', String(input.video_id), String(Date.now())),
          ...(Array.isArray(input.times) ? { times: input.times.map(Number) } : {}),
          ...(range ? { range: { startSec: Number(range.start_sec), endSec: Number(range.end_sec) } } : {}),
          ...signalOpt,
        });
        if (!result.ok) return checkFailure(result);
        const visual = await prepareVideoStudioModelVisual(String(result.contact_sheet));
        return reply(
          { ...result, visual_evidence: { attached: !!visual, role: 'video_frames' } },
          visual ? { images: [visual], imageRetention: 'active_turn' as const } : {},
        );
      }

      // video.render
      const rawOutput = typeof input.output_path === 'string' ? input.output_path.trim() : '';
      const outputAbsPath = rawOutput
        ? resolveRenderOutputPath(rawOutput, productionDirAbs, ctx, opts, roots)
        : path.join(productionDirAbs, 'render', `${String(input.video_id)}.mp4`);
      if (!isPathAllowed(outputAbsPath, roots)) return refuse(op, 'E_PATH_OUT_OF_SCOPE', `output_path is outside this task's files: ${outputAbsPath}`);
      const result = await renderVideoTimeline({
        ...paths,
        outputAbsPath,
        quality: input.quality === 'draft' || input.quality === 'standard' ? input.quality : 'high',
        onProgress: progress,
        ...signalOpt,
      });
      if (result.ok) await notifyWritten(opts, [outputAbsPath]);
      return reply(renderResultForModel(result as Record<string, unknown>));
    },
  };
}
