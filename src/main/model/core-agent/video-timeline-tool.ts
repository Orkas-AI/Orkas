/**
 * The `video_studio` tool for timeline productions. A production is one folder; a
 * video in it is `videos/<id>/` holding `manifest.json` and an optional `index.html`.
 * There is no approval state here: the model edits those files directly, and this
 * tool checks them, renders them and judges the result.
 */
import { realpathSync } from 'node:fs';
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
import { transcribeSpeech, type VideoStudioResult } from '../../features/video_studio';
import { heardClauses } from '../../features/video_phrases';
import {
  checkVideoTimeline,
  visualReview,
  capturedPictureKinds,
  loadVideoProject,
  pictureLooksLikeScreen,
  renderVideoTimeline,
  sheetVideoTimeline,
} from '../../features/video_timeline_render';
import { deliveredFrameSamples, shipVideoFile, writeDeliveredFrameSheet, type HeardLine, type VideoVersion } from '../../features/video_timeline_ship';
import {
  REFERENCE_MOTION_CODE,
  findFollowedReference,
  writeReferenceComparisonSheet,
  type ReferenceComparison,
} from '../../features/video_reference_compare';
import { bundledFfmpegPaths } from '../../util/bundled-runtime';
import { getToolCatalogEntry, VIDEO_STUDIO_AGENT_ID } from './tool-catalog';
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
import { gateOutsideRead } from './outside-read-gate';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { sha256OfFileStream } from '../../util/sha256';
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

const REPLY_LINK_NOTE = 'Link the video in your reply with reply_link exactly as given; change only the words in brackets.';
const MARKDOWN_PATH_ESCAPES: Record<string, string> = {
  '%': '%25', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E',
  '#': '%23', '?': '%3F', ':': '%3A', '`': '%60',
};

/**
 * A Markdown link to a delivered file, written relative to the folder this conversation's
 * agents run in, which is the folder the app resolves such links against. The app turns it
 * into the playable file. 2026-11-20 benchmark: 6 of 34 runs copied the delivered file's long
 * absolute link wrong (a folder dropped, a 0 added, a character of a Chinese name lost), and
 * users got a link that opened nothing.
 */
export function replyLinkFor(fileAbs: string, workingDirAbs: string): string | null {
  const inside = (base: string, file: string) => {
    const rel = path.relative(base, file);
    return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
  };
  const real = (value: string) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  // A folder reached through a link (/var and /private/var on macOS) names the same file.
  const relative = inside(path.resolve(workingDirAbs), path.resolve(fileAbs)) ?? inside(real(workingDirAbs), real(fileAbs));
  if (!relative) return null;
  const destination = relative.split(path.sep)
    .map((part) => part.replace(/[%()<>#?:`]/g, (ch) => MARKDOWN_PATH_ESCAPES[ch]).replace(/\s/g, (ch) => encodeURIComponent(ch)))
    .join('/');
  // Keep the raw label out of Markdown's inline-code syntax too.
  const label = path.basename(fileAbs).replace(/[[\]`]/g, '');
  return `[${label}](${destination})`;
}

/** What an unknown op says. Live runs on 2026-11-17–19 put another tool's name in op
 *  (generate_speech, twice), this tool's own name (twice) or an op without its prefix
 *  (request_budget), and a bare list of ops did not say which mistake it was. */
function unknownOpMessage(op: string): string {
  const listed = `op must be one of: ${OPS.join(', ')}`;
  if (op === 'video_studio') return `op names the operation, not this tool. It is one of: ${OPS.join(', ')}`;
  if (op && getToolCatalogEntry(op)) return `${op} is a tool of its own, not a video_studio op. Call ${op} with these fields.`;
  const prefixed = op ? OPS.filter((known) => known.slice(known.indexOf('.') + 1) === op) : [];
  if (prefixed.length === 1) return `There is no op ${op}; it is ${prefixed[0]}. Run it again with that name.`;
  return listed;
}
/** Delivered versions per video that video.status lists; older ones are counted. */
const STATUS_VERSIONS_PER_VIDEO = 5;

/** video.status opens every later turn, so it lists, per video, the newest versions with
 *  what a decision needs and the visual review of the newest one only. versions.json
 *  keeps every field. */
function statusVersions(versions: unknown[]): { versions: Array<Record<string, unknown>>; older_versions?: number } {
  const records = versions.filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object');
  const byVideo = new Map<unknown, Array<Record<string, unknown>>>();
  for (const record of records) byVideo.set(record.video_id, [...(byVideo.get(record.video_id) ?? []), record]);
  const listed = new Set<Record<string, unknown>>();
  const newest = new Set<Record<string, unknown>>();
  for (const list of byVideo.values()) {
    for (const record of list.slice(-STATUS_VERSIONS_PER_VIDEO)) listed.add(record);
    newest.add(list[list.length - 1]);
  }
  const older = records.length - listed.size;
  return {
    versions: records.filter((record) => listed.has(record)).map((record) => ({
      id: record.id,
      ...(record.video_id !== undefined ? { video_id: record.video_id } : {}),
      path: record.path,
      duration_sec: record.duration_sec,
      shipped_at: record.shipped_at,
      warnings: record.warnings,
      ...(record.override ? { override: record.override } : {}),
      ...(newest.has(record) && record.visual_review ? { visual_review: record.visual_review } : {}),
    })),
    ...(older ? { older_versions: older } : {}),
  };
}
const MAX_LISTED_PRODUCTION_CANDIDATES = 200;
const VIDEO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DEFAULT_VIDEO_ID = 'main';
/** The frames invite a fix after delivery: the first ship plus at most two repairs, per video. */
const MAX_DELIVERIES_TO_REWORK = 3;
const MAX_UPGRADE_NOTES_CHARS = 4000;
const DELIVERED_FRAMES = 'These are frames from the published file.';
const DELIVERED_HEARD_FRAMES = 'These are frames from the published file, each taken as a line of its voice ends, then its last frame; delivered_frames lists the words heard at each.';
const HEARD_FRAMES_REPAIR = 'Where a line names a step, a result or an event that its frame does not show, fix the cut or the line.';
const HEARD_FRAMES_REPORT = 'Where a line names a step, a result or an event that its frame does not show, say so in your reply.';
const REWORK_OPEN = "Rework is still available this turn. Apply the video-studio Skill's Deliver section to decide whether to repair, report a blocker, or finish.";
const REWORK_SPENT = "This turn's rework limit has been reached; do not rework again. Apply the video-studio Skill's Deliver section for an honest final status.";
/** A voiced delivery is listened to up to this length; a longer one keeps evenly spaced frames. */
const HEARD_FRAMES_MAX_SEC = 600;
/** A production that keeps reference notes follows a reference; its first delivery names what
 *  the video left out of it and how the user could still have it. */
const REFERENCE_DROPS_MESSAGE = 'This video follows a reference. In your reply, name what reference-notes.md drops and why, and for a presenter or character the user has no footage of, offer to add one from footage they film or as an original generated one, priced when they ask.';
/** Delivery findings that are defects to repair, not editorial notes. */
const REPAIR_FINDINGS = new Set([
  'DELIVERY_SILENT_STRETCH', 'DELIVERY_NARRATION_OVER_SPEECH', 'DELIVERY_CUTS_OFF_BEAT', 'DELIVERY_NO_CUTS', 'DELIVERY_SHOT_HELD',
  REFERENCE_MOTION_CODE,
]);
/** A video that follows a reference is shown beside it at each delivery, within the same rework. */
const REFERENCE_SHEET_REPAIR = 'The reference comparison image shows the reference (left) and this video (right) at the same point of each, one row per quarter. Where this video leaves out a part, an end card or on-screen text that the reference has and reference-notes.md does not drop, fix it in this rework; what the notes drop or change is not a defect.';
const REFERENCE_SHEET_REPORT = 'The reference comparison image shows the reference (left) and this video (right) at the same point of each, one row per quarter. Where this video still leaves out something the reference has and reference-notes.md does not drop, say so in your reply.';
/** A repair that moves the delivery less than this much closer to the reference's movement
 *  is not asked for again: the next attempt would most likely change as little. */
const REFERENCE_MOTION_MIN_GAIN = 0.1;
function referenceMotionStalled(before: number, now: number): string {
  return `The movement below the reference did not improve enough since the last delivery (${Math.round(before * 100)}% to ${Math.round(now * 100)}% of the reference's movement), so do not rework it again: name it in your reply as a known difference from the reference.`;
}

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

/** The delivered file's voice, line by line, when it carries one; empty when it does not,
 *  is too long to listen to here, or cannot be heard. */
async function heardLines(videoPathAbs: string, version: VideoVersion | undefined, signal: AbortSignal | undefined): Promise<HeardLine[]> {
  const durationSec = version?.duration_sec ?? 0;
  if (version?.voiced !== true || !(durationSec > 0) || durationSec > HEARD_FRAMES_MAX_SEC) return [];
  try {
    // Frames need times only roughly: the last words are often timed past the end of the file,
    // where a frame is its last frame, and a word the recognizer could not time is skipped.
    const result = await transcribeSpeech({ inputAbsPath: videoPathAbs, timestamps: 'word', looseTiming: true, ...(signal ? { signal } : {}) });
    if (!result.ok) return [];
    const summary = (result.summary ?? {}) as { words?: unknown; segments?: unknown };
    const timed = (value: unknown) => (Array.isArray(value) ? value : []).flatMap((item) => {
      const { text, startSec, endSec } = (item ?? {}) as { text?: unknown; startSec?: unknown; endSec?: unknown };
      // A punctuation mark can take no time and still end a clause.
      return typeof text === 'string' && text.trim() && typeof startSec === 'number' && typeof endSec === 'number' && endSec >= startSec
        ? [{ text: text.trim(), startSec, endSec }] : [];
    });
    return heardClauses(timed(summary.words), timed(summary.segments));
  } catch (err) {
    log.warn('delivered voice not heard', { error: logErrorSummary(err) });
    return [];
  }
}

async function deliveredFramesVisual(
  videoPathAbs: string,
  version: VideoVersion | undefined,
  signal: AbortSignal | undefined,
): Promise<{ image: { data: string; mediaType: 'image/png' | 'image/webp' }; heard: Array<{ frame: number; at_sec: number; heard?: string }> | null } | null> {
  const [width, height] = (version?.canvas ?? '').split('x').map(Number);
  let dir: string | null = null;
  try {
    const heard = await heardLines(videoPathAbs, version, signal);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-delivered-'));
    const sheet = await writeDeliveredFrameSheet({
      videoPathAbs,
      outputDirAbs: dir,
      durationSec: version?.duration_sec ?? 0,
      width: width ?? 0,
      height: height ?? 0,
      heard,
      ...(signal ? { signal } : {}),
    });
    const image = sheet ? await prepareVideoStudioModelVisual(sheet) : null;
    if (!image) return null;
    // The same frames the sheet was made from, numbered as its cells are.
    return {
      image,
      heard: heard.length
        ? deliveredFrameSamples(version?.duration_sec ?? 0, heard)
          .map((sample, index) => ({ frame: index + 1, at_sec: sample.atSec, ...(sample.heard ? { heard: sample.heard } : {}) }))
        : null,
    };
  } catch (err) {
    log.warn('delivered frames unavailable', { error: logErrorSummary(err) });
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The reference and the delivery side by side at the rows delivery measured. Losing it
 *  loses the picture, never the delivery. */
async function referenceComparisonVisual(
  referenceAbs: string,
  videoAbs: string,
  comparison: ReferenceComparison,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mediaType: 'image/png' | 'image/webp' } | null> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg || !comparison.rows.length) return null;
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-reference-'));
    const sheet = await writeReferenceComparisonSheet({
      ffmpeg,
      referenceAbs,
      videoAbs,
      moments: comparison.rows.map((row) => ({
        row: row.row,
        referenceSec: row.reference_at_sec,
        videoSec: row.video_at_sec,
        share: (row.row - 0.5) / comparison.rows.length,
      })),
      outputDirAbs: dir,
      ...(signal ? { signal } : {}),
    });
    return sheet ? await prepareVideoStudioModelVisual(sheet) : null;
  } catch (err) {
    log.warn('reference comparison unavailable', { error: logErrorSummary(err) });
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The frozen source a successful reference.inspect returned. */
function inspectedSource(result: ToolResult): string | null {
  if (typeof result.content !== 'string') return null;
  try {
    const body = JSON.parse(result.content) as { ok?: unknown; source_path?: unknown };
    return body.ok === true && typeof body.source_path === 'string' && body.source_path ? path.resolve(body.source_path) : null;
  } catch {
    return null;
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
    ...statusVersions(versions),
  };
}

// On 2026-11-07 a run with nothing to generate priced an empty plan, and an answer that the plan
// had to list something sent it looking for something to list. Live runs on 2026-11-17–19 still
// priced empty plans 12 times; answered as a failure, one of them stopped there. Nothing to pay
// for is a result, not a mistake.
const NOTHING_TO_PRICE = 'There is nothing in the plan to generate, so there is no price to confirm. Carry on with what you have.';

/** One entry of `planned`, in the shape the credit quote reads. Empty when nothing in it costs. */
function plannedIntents(raw: unknown): Array<{ segment_id: string; kind: 'video' | 'image'; prompt: string; ratio?: string; duration?: number; resolution?: string; quality?: string; generate_audio?: boolean; size?: string }> | string {
  if (!Array.isArray(raw)) return 'planned must list what you intend to generate.';
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
  return out;
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

/** What a delivery says when files it may use need credit (confirmed 2026-11-16). */
function creditMessage(credits: { timeline: boolean }, file: string): string {
  return credits.timeline
    ? `This video uses files that need credit. In your reply, give the user these lines to paste into the post's description; they are also saved beside the video as ${file}.`
    : `This production has files that need credit. In your reply, give the user the lines for those this video uses, to paste into the post's description; all are saved beside the video as ${file}.`;
}

/** Credit lines for a delivery; a failure to write them never fails the delivery. */
async function stockCredits(productionDirAbs: string, deliveredAbs: string, videoDirAbs: string | undefined) {
  try {
    const stock = await import('../../features/video_timeline_ship');
    return await stock.writeStockCredits({ productionDirAbs, deliveredAbs, ...(videoDirAbs ? { videoDirAbs } : {}) });
  } catch (err) {
    log.warn('delivery credits unavailable', { error: logErrorSummary(err) });
    return null;
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
  // Reference sources inspected in this run, oldest first: the last is the one a remake follows.
  const inspectedReferences: string[] = [];
  // Per video, how close its last delivery came to the reference's movement when it fell short.
  const referenceMotion = new Map<string, number>();
  // Checks in this run that asked to move words off the product; the check stops asking after three.
  let wordsOnProductAsks = 0;
  // Checks in this run that pointed out empty or still scenes, and small text; three each.
  let stillScenesAsks = 0;
  let smallTextAsks = 0;
  let screenStepAsks = 0;
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
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, description: 'video.import: local image, video or audio paths, relative to the workspace or absolute; a file outside the workspace follows the user\'s access setting and may ask the user first. Use instead of names; omit both to import conversation attachments.' },
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
        include_preview: { type: 'boolean', description: 'video.check: attach a sheet of sampled scene starts and ends (up to 32 frames). Omit for diagnostics only.' },
        times: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 32, description: 'video.sheet: seconds on the video to show. Default: the start and end of every scene.' },
        range: {
          type: 'object',
          description: 'video.sheet: every frame in this span instead of times, at most 32.',
          properties: { start_sec: { type: 'number' }, end_sec: { type: 'number' } },
          required: ['start_sec', 'end_sec'],
        },
        output_path: { type: 'string', description: 'video.render: absolute or production-relative MP4 path. Workspace-relative paths inside the production also work. Defaults to render/<video_id>.mp4 in the production.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'video.render: default high. draft is 15fps and fast.' },
        path: { type: 'string', description: 'video.ship: use the actual absolute file path from the producing tool. Relative paths try the production first, then the workspace.' },
        expect_duration_sec: { type: 'number', description: 'video.ship: requested duration in seconds, if known. A difference is advisory, including when video_id is set.' },
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
        all_voices: { type: 'boolean', description: 'speech.capabilities: list every eligible voice instead of a sample.' },
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
      if (!OPS.includes(op)) return refuse(op, 'E_VIDEO_OP_UNKNOWN', unknownOpMessage(op));
      if (SHARED_OPS.has(op)) {
        const result = await sharedOp(op, input as Record<string, unknown>, shared, ctx, opts);
        if (op === 'reference.inspect') {
          const source = inspectedSource(result);
          if (source) inspectedReferences.push(source);
        }
        return result;
      }
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
            // A file elsewhere on the computer is read as the file tools read it, by the
            // user's access setting, and copied in, so the video never depends on it.
            const gate = await gateOutsideRead({
              userId: opts.userId, ...(opts.cid ? { cid: opts.cid } : {}),
              ...(opts.agentId ? { agentId: opts.agentId } : {}), ...(opts.agentName ? { agentName: opts.agentName } : {}),
              roots, abs: source, operation: 'video.import', ctx,
            });
            if (gate.ok === false) return refuse(op, gate.code, gate.message);
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
          const screens = await importedScreens(productionDirAbs, imported);
          return reply({ ok: true, op, assets: imported, ...(skipped.length ? { skipped } : {}),
            ...(imported.length ? (screens ? { message: screens } : {}) : { message: 'The selected files contain no supported images, videos or audio.' }) });
        }
        if (!opts.cid) return refuse(op, 'E_VIDEO_IMPORT_NO_CONVERSATION', 'There are no attachments outside a conversation.');
        const { imported, skipped } = await importProductionAttachments({
          productionDirAbs,
          attachmentDirAbs: chatAttachmentDirForConversation(opts.userId, opts.cid),
          ...(Array.isArray(input.names) ? { names: input.names.map(String) } : {}),
          ...signalOpt,
        });
        const screens = await importedScreens(productionDirAbs, imported);
        return reply({
          ok: true,
          op,
          assets: imported,
          ...(skipped.length ? { skipped } : {}),
          ...(imported.length ? (screens ? { message: screens } : {}) : { message: 'There are no images, videos or audio files attached to this conversation.' }),
        });
      }

      if (op === 'video.request_budget') {
        const intents = plannedIntents(input.planned);
        if (typeof intents === 'string') return refuse(op, 'E_BUDGET_PLAN', intents);
        if (!intents.length) return reply({ ok: true, op, quoted_credits: 0, message: NOTHING_TO_PRICE });
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
        // reference-notes.md marks a video made from a reference, as for the first delivery's notes below.
        const followsNotes = await fs.stat(path.join(productionDirAbs, 'reference-notes.md')).then((stat) => stat.isFile(), () => false);
        const referenceAbs = followsNotes
          ? await findFollowedReference({ productionDirAbs, allowedRoots: roots, inspectedThisRun: inspectedReferences, ...signalOpt })
          : null;
        const result = await shipVideoFile({
          productionDirAbs,
          allowedRoots: roots,
          videoPathAbs,
          ...(videoDirAbs ? { videoDirAbs } : {}),
          ...(Object.keys(expect).length ? { expect } : {}),
          ...(accepted.length ? { override: { codes: accepted, reason: String(input.accept_reason || '') } } : {}),
          ...(input.cut_to_beat === true ? { cutToBeat: true } : {}),
          ...(referenceAbs ? { referenceAbs } : {}),
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
        const key = deliveryKey(productionDirAbs, input.video_id, videoPathAbs);
        const shipped = (deliveries.get(key) ?? 0) + 1;
        deliveries.set(key, shipped);
        const credits = await stockCredits(productionDirAbs, deliveredAbs, videoDirAbs);
        if (credits) await notifyWritten(opts, [credits.file]);
        // The host replaces the visible output selection on each publication.
        await publishVisibleOutputs(opts, credits ? [deliveredAbs, credits.file] : [deliveredAbs]);
        const frames = await deliveredFramesVisual(deliveredAbs, delivered, ctx.signal);
        const visual = frames?.image ?? null;
        const reworkOpen = shipped < MAX_DELIVERIES_TO_REWORK;
        const shippedWarnings = (result as { warnings?: unknown }).warnings;
        const warnings: Array<{ code?: unknown }> = Array.isArray(shippedWarnings) ? shippedWarnings : [];
        const comparison = (result as { reference_comparison?: ReferenceComparison }).reference_comparison;
        // A repair that left the movement about where it was is not asked for again, rework or not.
        const motionShort = warnings.some((warning) => warning?.code === REFERENCE_MOTION_CODE);
        const motionNow = comparison?.motion_score;
        const motionBefore = referenceMotion.get(key);
        const motionStalled = reworkOpen && motionShort && typeof motionNow === 'number' && motionBefore !== undefined
          && motionNow - motionBefore < REFERENCE_MOTION_MIN_GAIN;
        if (motionShort && typeof motionNow === 'number') referenceMotion.set(key, motionNow);
        else referenceMotion.delete(key);
        const repair = repairInstruction(motionStalled ? warnings.filter((warning) => warning?.code !== REFERENCE_MOTION_CODE) : warnings, shipped);
        const look = !visual ? null : frames?.heard
          ? `${DELIVERED_HEARD_FRAMES} ${reworkOpen ? HEARD_FRAMES_REPAIR : HEARD_FRAMES_REPORT} ${reworkOpen ? REWORK_OPEN : REWORK_SPENT}`
          : `${DELIVERED_FRAMES} ${reworkOpen ? REWORK_OPEN : REWORK_SPENT}`;
        const compared = referenceAbs && comparison ? await referenceComparisonVisual(referenceAbs, deliveredAbs, comparison, ctx.signal) : null;
        const comparedNote = compared ? (reworkOpen ? REFERENCE_SHEET_REPAIR : REFERENCE_SHEET_REPORT) : null;
        const stalledNote = motionStalled ? referenceMotionStalled(motionBefore as number, motionNow as number) : null;
        const followsReference = firstDelivery.get(productionDirAbs) === true && followsNotes;
        const creditNote = credits ? creditMessage(credits, path.basename(credits.file)) : null;
        const replyLink = replyLinkFor(deliveredAbs, defaultRoot(opts, ctx));
        const message = [repair, look, comparedNote, stalledNote, followsReference ? REFERENCE_DROPS_MESSAGE : null, creditNote,
          replyLink ? REPLY_LINK_NOTE : null].filter(Boolean).join(' ');
        const images = [visual, compared].filter((image): image is NonNullable<typeof visual> => !!image);
        return reply(
          {
            ...result,
            ...(replyLink ? { reply_link: replyLink } : {}),
            ...(credits ? { credits: credits.lines, credits_file: path.relative(productionDirAbs, credits.file).split(path.sep).join('/') } : {}),
            visual_evidence: { attached: !!visual, role: 'delivered_frames' },
            ...(compared ? { reference_evidence: { attached: true, role: 'reference_comparison' } } : {}),
            ...(frames?.heard ? { delivered_frames: frames.heard } : {}),
            ...(message ? { message } : {}),
          },
          images.length ? { images, imageRetention: 'active_turn' as const } : {},
        );
      }

      const videoDirAbs = videoDirOf(productionDirAbs, input.video_id);
      if (!videoDirAbs) return refuse(op, 'E_VIDEO_ID', 'video_id must be a folder name under videos/.');
      const segmentCacheDirAbs = videoStudioSegmentCachePath(opts, productionDirAbs);
      const paths = { productionDirAbs, videoDirAbs, allowedRoots: roots, segmentCacheDirAbs };

      if (op === 'video.check') {
        const checkOptions = {
          ...paths,
          onProgress: progress,
          ...signalOpt,
          wordsOnProductAsked: wordsOnProductAsks,
          onWordsOnProductAsked: () => { wordsOnProductAsks += 1; },
          stillScenesAsked: stillScenesAsks,
          onStillScenesAsked: () => { stillScenesAsks += 1; },
          smallTextAsked: smallTextAsks,
          onSmallTextAsked: () => { smallTextAsks += 1; },
          screenStepsAsked: screenStepAsks,
          onScreenStepsAsked: () => { screenStepAsks += 1; },
        };
        if (input.include_preview !== true) return reply(await checkVideoTimeline(checkOptions));

        const previewOutputDirAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-check-')).catch((err) => {
          log.warn('checked frame preview workspace unavailable', { error: logErrorSummary(err) });
          return undefined;
        });
        try {
          const { contact_sheet: sheet, ...result } = await checkVideoTimeline({ ...checkOptions, previewOutputDirAbs });
          const visual = result.ok && typeof sheet === 'string' && !ctx.signal?.aborted
            ? await prepareVideoStudioModelVisual(sheet)
            : null;
          return reply(
            { ...result, visual_evidence: {
              attached: !!visual, role: 'video_frames',
              ...(visual ? { coverage: 'scene_start_and_end' } : {}),
            } },
            visual ? { images: [visual], imageRetention: 'active_turn' } : {},
          );
        } finally {
          if (previewOutputDirAbs) await fs.rm(previewOutputDirAbs, { recursive: true, force: true }).catch((err) => {
            log.warn('checked frame preview workspace cleanup failed', { error: logErrorSummary(err) });
          });
        }
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
        requireSound: true,
        ...signalOpt,
      });
      if (result.ok) await notifyWritten(opts, [outputAbsPath]);
      return reply(renderResultForModel(result as Record<string, unknown>));
    },
  };
}

/** Said when pictures arrive, while the scenes are still to be planned: the ones that look
 *  like screens of a site or app, and how a step on them is shown. As a question, because a
 *  flat-lay photograph can look the same. */
async function importedScreens(productionDirAbs: string, imported: ReadonlyArray<{ asset_id: string; kind: string; path: string }>): Promise<string | null> {
  const screens: string[] = [];
  let captured: Map<string, boolean> | null = null;
  for (const asset of imported) {
    if (asset.kind !== 'image') continue;
    const abs = path.resolve(productionDirAbs, asset.path);
    if (path.relative(productionDirAbs, abs).startsWith('..')) continue;
    // A crop product.capture saved keeps what the page said it was.
    captured ??= await capturedPictureKinds(productionDirAbs).catch(() => new Map<string, boolean>());
    const known = captured.size ? captured.get(await sha256OfFileStream(abs).catch(() => '')) : undefined;
    if (known ?? await pictureLooksLikeScreen(abs)) screens.push(asset.asset_id);
  }
  return screens.length ? importedScreensMessage(screens) : null;
}

export function importedScreensMessage(assetIds: readonly string[]): string {
  const many = assetIds.length > 1;
  return `${assetIds.join(', ')} ${many ? 'look' : 'looks'} like ${many ? 'screens' : 'a screen'} of a site or app. Where the video says what someone does there, plan that step done on the screen with ./assets/vendor/screen-demo.js (timeline.md): the tap or the typing, then the screen it leads to, rather than the screenshot under a caption. A photograph needs none of this.`;
}
