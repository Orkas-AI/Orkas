/**
 * Host-owned review-panel payload for VideoStudio productions (P2).
 *
 * The renderer's video review panel shows what the production state already
 * proves — scenes, preview evidence, narration audio, candidate history —
 * instead of asking the model to describe it. Everything here is read-only:
 * the panel's modification entries only prefill the composer, and every
 * mutation still travels the normal conversation path.
 *
 * State files are keyed by hash(uid + composition dir) and carry their
 * composition_dir, so a conversation's productions are found by scanning the
 * gates directory and keeping states whose composition lives inside the
 * conversation's workspace. Corrupt files are skipped after a bounded warning
 * and foreign files are ignored; this diagnostic surface stays non-blocking.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalRoot } from '../paths';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
import { getConversationWorkspacePath } from './group_chat/conv_workspace';
import { resolveLocalMediaPath } from './chat_attachments';
import { samplePlanKey } from './video_studio_qa';
import {
  readVideoProductionControlState,
  videoProductionControlStatePath,
  videoProductionNarrationLineIdentity,
} from './video_production_control';
import type { VideoProductionNarrationLineFact } from './video_production_control';
import { parentEdlLinkOf } from './video_studio_state';
import type { VideoProductionStateV1 } from './video_studio_state';

const log = createLogger('video-studio-review');

export type VideoStudioReviewScene = {
  id: string;
  narration_text?: string;
  approved_copy: string[];
  /** Mid-scene preview frame, when the recorded frame evidence contains one
   * for this scene (snapshot names frames `NN-<key(sceneId)>-mid.png`). */
  frame_path?: string;
  /** The produced clip this scene IS, on a media-backed segment. A cut or
   * generated shot has no authored scenes and no frame to sample: the file is
   * what the viewer sees, so the panel plays it in place of a still. */
  media_path?: string;
  /** Parent EDL segment that owns this scene, on an assembled production. */
  segment_id?: string;
};

/** One segment of an assembled production. A composition segment carries the
 * state its own composition recorded; a media segment is a file the assembler
 * produced from the signed EDL and has no gate state of its own. Both are
 * listed so the production reads as its whole timeline, without pretending the
 * segments are separate videos. */
export type VideoStudioReviewSegment = {
  segment_id: string;
  kind: 'composition' | 'media';
  /** Empty on a media segment, which has no gate state and no composition. */
  state_key: string;
  composition_dir: string;
  media_path?: string;
  stage: string;
  plan_approved: boolean;
  /** `candidate` is evidence from the current candidate's locators when no
   * passing snapshot was recorded — real frames the viewer can see, produced
   * by an op whose QA did not pass. It never reads as capture. */
  preview?: {
    status: 'ready' | 'approved' | 'candidate';
    contact_sheet_path?: string;
    frame_paths: string[];
  };
  narration?: { status: string; audio_path?: string; duration_sec?: number };
  /** `qa_blocked` is a render that exists on disk but failed video QA; it is
   * shown as the current unapproved version, never as a passing draft. */
  draft?: { status: 'ready' | 'approved' | 'qa_blocked'; path?: string };
  scenes: VideoStudioReviewScene[];
};

export type VideoStudioReviewComposition = {
  state_key: string;
  composition_dir: string;
  display_name: string;
  /** What the user asked for, when the production recorded it. The panel
   * titles the production with this, and prefilled instructions quote it so
   * an instruction names the video the way the user does. */
  task_title?: string;
  stage: string;
  updated_at_ms: number;
  plan_approved: boolean;
  preview?: {
    status: 'ready' | 'approved' | 'candidate';
    contact_sheet_path?: string;
    frame_paths: string[];
  };
  narration?: {
    status: string;
    audio_path?: string;
    duration_sec?: number;
    language?: string;
    speed?: number;
    /** Assembled narration is per line; a `partial` production says how far
     * it got so the drawer can render 2/5 instead of pretending nothing
     * happened — the original defect this surface exists to prevent. */
    produced_lines?: number;
    planned_lines?: number;
  };
  draft?: { status: 'ready' | 'approved' | 'qa_blocked'; path?: string };
  /** The delivered whole-production video, when the plan's runtime record
   * names one that exists (`_runtime.render.final_path`). This is what the
   * user received; presence is delivery evidence for the 成片 step. */
  final?: { path: string };
  scenes: VideoStudioReviewScene[];
  /** The segment compositions this production was assembled from, in plan
   * order. Present only for an AUTO assembly; a COMPOSE production is one
   * composition and has none. Its aggregate gates above read as "every
   * segment got there", so one segment still waiting keeps the whole
   * production waiting. */
  segments?: VideoStudioReviewSegment[];
};

export type VideoStudioReviewPanel = {
  compositions: VideoStudioReviewComposition[];
};

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sceneFrameFor(sceneId: string, framePaths: string[]): string | undefined {
  // Snapshot writes the per-scene midpoint sample as `NN-<label>.png` with
  // label = samplePlanKey(`${scene.id}-mid`); reuse the exact normalizer so
  // matching never drifts from the producer.
  const key = samplePlanKey(`${sceneId}-mid`);
  const pattern = new RegExp(`^\\d+-${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.png$`, 'i');
  return framePaths.find((framePath) => pattern.test(path.basename(framePath)));
}

/** The parent EDL plan this composition was assembled into, or ''.
 *
 * An AUTO production authors each segment as its own composition with its own
 * production state, so a panel that lists states lists one row per segment —
 * seven "videos" where the user made one. The parent link recorded on the
 * inherited plan approval is what puts them back together; resolution
 * (current approval, then approval history) is shared with the tool's
 * delivered-opening check so both surfaces read the same structure. */
function parentPlanPathOf(state: VideoProductionStateV1): string {
  return parentEdlLinkOf(state).planPath;
}

function parentSegmentIdOf(state: VideoProductionStateV1): string {
  return parentEdlLinkOf(state).segmentId;
}

/** Sources whose artifact is a produced media file rather than a composition. */
const MEDIA_BACKED_SEGMENT_SOURCES = new Set(['edit', 'generate', 'provided']);

type PlanSegment = { id: string; source: string; produced_path: string };
type PlanNarrationFacts = {
  /** Planned line texts in index order — the identity inputs the reader
   *  checks produced records against. */
  texts: string[];
  synthesis: { route_ref: string; voice_ref: string; language: string; speed?: number } | null;
};
type PlanFacts = { segments: PlanSegment[]; final_path: string; narration: PlanNarrationFacts };

/** The EDL's segments in plan order, so an assembly reads in the order it
 *  plays, plus the delivered-final runtime record when the assembler wrote
 *  one (`_runtime.render.final_path` — the reserved runtime envelope, which
 *  approval identity excludes, so recording delivery never re-opens the
 *  plan confirmation). Falls back to empty — callers then keep segment-id
 *  order, which is still stable, just not necessarily the timeline. */
async function planFacts(planPathAbs: string): Promise<PlanFacts> {
  try {
    const plan = JSON.parse(await fs.readFile(planPathAbs, 'utf8')) as {
      segments?: unknown;
      tracks?: { narration?: { segments?: unknown; synthesis?: unknown } };
      _runtime?: { render?: { final_path?: unknown } };
    };
    const narrationTexts = Array.isArray(plan.tracks?.narration?.segments)
      ? plan.tracks.narration.segments.map((line) => (
        line && typeof line === 'object' && !Array.isArray(line)
          ? String((line as Record<string, unknown>).text ?? '')
          : ''
      ))
      : [];
    const rawSynthesis = plan.tracks?.narration?.synthesis;
    const synthesisRecord = rawSynthesis && typeof rawSynthesis === 'object' && !Array.isArray(rawSynthesis)
      ? rawSynthesis as Record<string, unknown>
      : null;
    const synthesis = synthesisRecord
      && typeof synthesisRecord.route_ref === 'string' && synthesisRecord.route_ref.trim()
      && typeof synthesisRecord.voice_ref === 'string' && synthesisRecord.voice_ref.trim()
      ? {
        route_ref: synthesisRecord.route_ref,
        voice_ref: synthesisRecord.voice_ref,
        language: String(synthesisRecord.language ?? ''),
        ...(typeof synthesisRecord.speed === 'number' ? { speed: synthesisRecord.speed } : {}),
      }
      : null;
    const finalPath = typeof plan._runtime?.render?.final_path === 'string'
      ? plan._runtime.render.final_path.trim()
      : '';
    const segments = Array.isArray(plan.segments)
      ? plan.segments.flatMap((segment) => {
        if (!segment || typeof segment !== 'object') return [];
        const record = segment as Record<string, unknown>;
        if (typeof record.id !== 'string' || !record.id) return [];
        return [{
          id: record.id,
          source: typeof record.source === 'string' ? record.source : '',
          produced_path: typeof record.produced_path === 'string' ? record.produced_path.trim() : '',
        }];
      })
      : [];
    return { segments, final_path: finalPath, narration: { texts: narrationTexts, synthesis } };
  } catch {
    return { segments: [], final_path: '', narration: { texts: [], synthesis: null } };
  }
}

/** The delivered final video as a displayable path, or '' — same fail-closed
 *  resolution as media segments: recorded, inside this conversation's
 *  workspace, existing, and servable. */
async function finalRenderPath(
  workspacePath: string,
  planPathAbs: string,
  recordedPath: string,
): Promise<string> {
  if (!recordedPath) return '';
  const abs = path.isAbsolute(recordedPath)
    ? path.resolve(recordedPath)
    : path.resolve(path.dirname(path.dirname(planPathAbs)), recordedPath);
  if (!isInside(workspacePath, abs)) return '';
  if (!(await fs.stat(abs).then((s) => s.isFile()).catch(() => false))) return '';
  const resolved = resolveLocalMediaPath(abs);
  return resolved.ok ? resolved.absPath : '';
}

/** The playable file of a segment the assembler produced rather than authored,
 *  or '' when there is nothing the panel could show.
 *
 * An edit/generate/provided segment has no composition and therefore no gate
 * state, so listing only gate states dropped it from the production entirely —
 * on 2026-08-05 the opening shot of a nine-segment video was missing from the
 * review it was supposed to be part of. Resolution is fail-closed: relative to
 * the video directory (the plan lives at `<video>/project/plan.json` while its
 * own paths read `project/cuts/<id>.mp4`), inside this conversation's
 * workspace, and displayable by the same resolver `chat-media://local/` serves
 * through. */
async function mediaSegmentPath(
  workspacePath: string,
  planPathAbs: string,
  segment: PlanSegment,
): Promise<string> {
  if (!MEDIA_BACKED_SEGMENT_SOURCES.has(segment.source)) return '';
  const videoDir = path.dirname(path.dirname(planPathAbs));
  const candidates: string[] = [];
  if (segment.produced_path) {
    candidates.push(path.isAbsolute(segment.produced_path)
      ? path.resolve(segment.produced_path)
      : path.resolve(videoDir, segment.produced_path));
  } else {
    // The assembler's contract writes an edit segment's artifact to
    // project/cuts/<id>.<ext> and records it as produced_path. A run that
    // produced the file but skipped the write-back (2026-08-06: the user's
    // own footage vanished from the review of the video it opens) still has
    // the artifact at the contract location, so probe exactly there —
    // nothing else, and only when the plan recorded no path at all.
    for (const ext of ['mp4', 'mov', 'webm', 'm4v']) {
      candidates.push(path.resolve(videoDir, 'project', 'cuts', `${segment.id}.${ext}`));
    }
  }
  for (const abs of candidates) {
    if (!isInside(workspacePath, abs)) continue;
    if (!segment.produced_path && !(await fs.stat(abs).then((s) => s.isFile()).catch(() => false))) continue;
    const resolved = resolveLocalMediaPath(abs);
    if (resolved.ok) return resolved.absPath;
  }
  return '';
}

/** The video a composition belongs to: the directory owning its `project/`
 *  scaffold. Several compositions live under one video — an AUTO run authors
 *  one per segment beside the parent plan — so this is the key for judging
 *  which of them still describe that video's work. */
function videoDirOf(compositionDirAbs: string): string {
  const resolved = path.resolve(compositionDirAbs);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (parts[i] === 'project') return parts.slice(0, i).join(path.sep) || path.sep;
  }
  return resolved;
}

/** Candidate locators that prove something was produced. `manifest_path` is
 *  deliberately absent: the manifest is the composition's INPUT, so recording
 *  it says only that a file was written, never that work came out. */
const PRODUCED_CANDIDATE_LOCATORS = [
  'html_path',
  'preview_path',
  'draft_path',
  'report_path',
  'findings_path',
] as const;

function hasProducedEvidence(state: VideoProductionStateV1): boolean {
  if (state.preview || state.draft || state.narration) return true;
  const locators = state.current_candidate?.locators;
  if (!locators) return false;
  if ((locators.frame_paths || []).length) return true;
  return PRODUCED_CANDIDATE_LOCATORS.some((key) => !!locators[key]);
}

/** A composition that never reached any plan approval and produced nothing is
 *  a manifest the model wrote and walked away from — an abandoned attempt at
 *  the same video, not a second video.
 *
 *  2026-08-06: a run that began as one composition per segment, failed to
 *  inherit the parent plan, then switched to a single whole-video
 *  composition left six such shells behind. The drawer listed each as its own
 *  production, repeating the live composition's scenes six times and badging
 *  every one 方案待确认 — a stop the user was never actually asked for. */
function isAbandonedShell(state: VideoProductionStateV1): boolean {
  if (state.plan_approval || (state.plan_approval_history || []).length) return false;
  return !hasProducedEvidence(state);
}

async function readSceneList(
  compositionDirAbs: string,
  framePaths: string[],
): Promise<VideoStudioReviewScene[]> {
  try {
    const raw = JSON.parse(await fs.readFile(
      path.join(compositionDirAbs, 'composition-manifest.json'),
      'utf8',
    )) as { scenes?: unknown };
    if (!Array.isArray(raw.scenes)) return [];
    return raw.scenes.flatMap((scene) => {
      if (!scene || typeof scene !== 'object') return [];
      const record = scene as Record<string, unknown>;
      if (typeof record.id !== 'string' || !record.id) return [];
      const framePath = sceneFrameFor(record.id, framePaths);
      return [{
        id: record.id,
        ...(typeof record.narration_text === 'string' && record.narration_text
          ? { narration_text: record.narration_text }
          : {}),
        approved_copy: Array.isArray(record.approved_copy)
          ? record.approved_copy.filter((value): value is string => typeof value === 'string')
          : [],
        ...(framePath ? { frame_path: framePath } : {}),
      }];
    });
  } catch (err) {
    log.warn('review panel scene manifest read failed', { error: logErrorSummary(err) });
    return [];
  }
}

type ReviewStateRecord = {
  state_key: string;
  composition_dir: string;
  updated_at_ms: number;
  state: VideoProductionStateV1;
};

function previewOf(state: VideoProductionStateV1) {
  if (state.preview) {
    return {
      preview: {
        status: state.preview.status,
        ...(state.preview.path ? { contact_sheet_path: state.preview.path } : {}),
        frame_paths: state.preview.frame_paths || [],
      },
    };
  }
  // No passing snapshot, but the current candidate may still have recorded
  // frame evidence (a QA-blocked snapshot/draft persists its locators). Those
  // frames exist and the user can look at them, so the panel shows them —
  // as `candidate`, which no progress reading treats as capture. Without this
  // tier the 2026-08-06 run's drawer showed 暂无预览帧 beside a delivered
  // video whose every frame was on disk.
  const locators = state.current_candidate?.locators;
  const framePaths = (locators?.frame_paths || []).filter(
    (value): value is string => typeof value === 'string' && !!value,
  );
  if (!locators || (!locators.preview_path && framePaths.length === 0)) return {};
  return {
    preview: {
      status: 'candidate' as const,
      ...(locators.preview_path ? { contact_sheet_path: locators.preview_path } : {}),
      frame_paths: framePaths,
    },
  };
}

function narrationOf(state: VideoProductionStateV1) {
  if (!state.narration) return {};
  return {
    narration: {
      status: state.narration.status,
      ...(state.narration.path ? { audio_path: state.narration.path } : {}),
      ...(typeof state.narration.measured_duration_sec === 'number'
        ? { duration_sec: state.narration.measured_duration_sec }
        : {}),
      ...(state.narration.language ? { language: state.narration.language } : {}),
      ...(typeof state.narration.speed === 'number' ? { speed: state.narration.speed } : {}),
    },
  };
}

function draftOf(state: VideoProductionStateV1) {
  if (state.draft) {
    return {
      draft: {
        status: state.draft.status,
        ...(state.draft.path ? { path: state.draft.path } : {}),
      },
    };
  }
  // A render that exists but failed video QA never becomes state.draft; its
  // path lives on the candidate. Surface it as the current unapproved
  // version — `qa_blocked` — so the drawer shows the file the user may
  // already have been shown in chat, without ever reading as a passing draft.
  // Only a candidate whose recorded quality result actually failed qualifies:
  // a draft_path left behind by a plan change (state.draft deleted, quality
  // ok) is a superseded artifact, not the current version.
  const candidate = state.current_candidate;
  const draftPath = candidate?.locators?.draft_path;
  if (typeof draftPath !== 'string' || !draftPath) return {};
  if (candidate?.last_quality_result?.ok !== false) return {};
  return {
    draft: {
      status: 'qa_blocked' as const,
      path: draftPath,
    },
  };
}

async function standaloneComposition(
  workspacePath: string,
  record: ReviewStateRecord,
): Promise<VideoStudioReviewComposition> {
  const { state } = record;
  const preview = previewOf(state);
  return {
    state_key: record.state_key,
    composition_dir: record.composition_dir,
    display_name: path.relative(workspacePath, record.composition_dir).replace(/\\/g, '/')
      || path.basename(record.composition_dir),
    ...(typeof state.task_title === 'string' && state.task_title.trim()
      ? { task_title: state.task_title.trim() }
      : {}),
    stage: typeof state.stage === 'string' ? state.stage : 'unknown',
    updated_at_ms: record.updated_at_ms,
    plan_approved: !!state.plan_approval,
    ...preview,
    ...narrationOf(state),
    ...draftOf(state),
    scenes: await readSceneList(record.composition_dir, preview.preview?.frame_paths || []),
  };
}

/** This production's narration, read from the parent that owns it.
 *
 * An assembled production's narration belongs to the parent EDL: children are
 * required to render silent (`E_PARENT_COMPOSITION_AUDIO_OWNERSHIP`), the
 * parent synthesizes one file per planned line and mixes them once. The panel
 * used to aggregate narration from those same children — asking the one party
 * contractually forbidden to have an answer — so an assembled production could
 * never report narration at all: on 2026-08-06 a finished 60s video with five
 * spoken lines showed "narration: not started". Reports partial work honestly
 * rather than hiding it: `partial` is fewer produced lines than the plan calls
 * for, which is what an interrupted assembly actually looks like. Returns
 * undefined when nothing was produced, leaving the composition-owned path to
 * answer for a standalone-style production. */
async function assembledNarration(
  uid: string,
  planPathAbs: string,
  narration: PlanNarrationFacts,
): Promise<VideoStudioReviewComposition['narration']> {
  const plannedLines = narration.texts.length;
  if (plannedLines <= 0) return undefined;
  const state = await readVideoProductionControlState(
    videoProductionControlStatePath({ userId: uid, planPath: planPathAbs }),
    planPathAbs,
  ).catch(() => undefined);
  if (!state?.narration_lines) return undefined;
  // A produced record counts only while the current plan still holds that
  // line's identity — text plus the signed synthesis selection. Counting by
  // record presence alone would keep superseded audio alive as this plan's
  // narration; counting by whole-plan signature was the 2026-08-08 wipe.
  // Records from before line_identity existed count while the plan they name
  // is still the currently approved one.
  const matched: VideoProductionNarrationLineFact[] = [];
  for (let index = 0; index < plannedLines; index += 1) {
    const entry = state.narration_lines[String(index)];
    if (!entry) continue;
    if (entry.line_identity) {
      if (!narration.synthesis) continue;
      const expected = videoProductionNarrationLineIdentity({
        text: narration.texts[index],
        routeRef: narration.synthesis.route_ref,
        voiceRef: narration.synthesis.voice_ref,
        language: narration.synthesis.language,
        ...(typeof narration.synthesis.speed === 'number' ? { speed: narration.synthesis.speed } : {}),
      });
      if (entry.line_identity !== expected) continue;
    } else if (!entry.plan_signature || entry.plan_signature !== state.plan_signature) {
      continue;
    }
    matched.push(entry);
  }
  if (!matched.length) return undefined;
  const measured = matched.reduce((total, line) => total + (line.measured_duration_sec || 0), 0);
  return {
    status: matched.length >= plannedLines ? 'materialized' : 'partial',
    produced_lines: matched.length,
    planned_lines: plannedLines,
    ...(measured > 0 ? { duration_sec: measured } : {}),
    ...(matched[0].language ? { language: matched[0].language } : {}),
    ...(typeof matched[0].speed === 'number' ? { speed: matched[0].speed } : {}),
  };
}

/** One assembled production from the segments it was built out of.
 *
 * The only aggregated decision is the plan: every composition segment inherits
 * the one parent Gate B, so `plan_approved` means "each segment holds that
 * inheritance". Everything else here is evidence and aggregates by presence —
 * frames, narration, drafts are produced and shown, never approved, so an
 * "every segment approved" reading could only claim someone was being waited
 * on when nobody is. Presence is scoped to composition segments because a cut
 * has no composition to produce these artifacts from — counting it would hold
 * every mixed production at "missing" forever. Aggregates carry no contact
 * sheet or narration audio of their own — those artifacts exist per segment,
 * and inventing a whole-production one out of the first segment's would
 * misreport it. */
async function assembledProduction(
  uid: string,
  workspacePath: string,
  planPathAbs: string,
  records: ReviewStateRecord[],
): Promise<VideoStudioReviewComposition> {
  const plan = await planFacts(planPathAbs);
  const order = plan.segments.map((segment) => segment.id);
  const rank = (record: ReviewStateRecord) => {
    const index = order.indexOf(parentSegmentIdOf(record.state));
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = [...records].sort((a, b) => rank(a) - rank(b)
    || parentSegmentIdOf(a.state).localeCompare(parentSegmentIdOf(b.state)));

  const compositionSegments: VideoStudioReviewSegment[] = [];
  for (const record of ordered) {
    const { state } = record;
    const segmentId = parentSegmentIdOf(state);
    const preview = previewOf(state);
    const scenes = (await readSceneList(record.composition_dir, preview.preview?.frame_paths || []))
      .map((scene) => ({ ...scene, ...(segmentId ? { segment_id: segmentId } : {}) }));
    compositionSegments.push({
      segment_id: segmentId,
      kind: 'composition',
      state_key: record.state_key,
      composition_dir: record.composition_dir,
      stage: typeof state.stage === 'string' ? state.stage : 'unknown',
      plan_approved: !!state.plan_approval,
      ...preview,
      ...narrationOf(state),
      ...draftOf(state),
      scenes,
    });
  }

  // Media segments slot into plan order around the compositions, so the panel
  // reads as the timeline the viewer will see rather than as the subset that
  // happens to have gate state. A plan that cannot be read leaves the
  // composition order untouched.
  const byPlanSegmentId = new Map(compositionSegments.map((segment) => [segment.segment_id, segment]));
  const segments: VideoStudioReviewSegment[] = [];
  if (order.length) {
    for (const planSegment of plan.segments) {
      const authored = byPlanSegmentId.get(planSegment.id);
      if (authored) {
        segments.push(authored);
        continue;
      }
      const mediaPath = await mediaSegmentPath(workspacePath, planPathAbs, planSegment);
      if (!mediaPath) continue;
      segments.push({
        segment_id: planSegment.id,
        kind: 'media' as const,
        state_key: '',
        composition_dir: '',
        media_path: mediaPath,
        stage: 'produced',
        plan_approved: true,
        // One scene, and it is the clip itself: a media segment has no authored
        // copy or narration of its own, and the parent EDL owns its voice.
        scenes: [{
          id: planSegment.id,
          approved_copy: [],
          media_path: mediaPath,
          segment_id: planSegment.id,
        }],
      });
    }
  } else {
    segments.push(...compositionSegments);
  }

  const every = (predicate: (segment: VideoStudioReviewSegment) => boolean) => (
    compositionSegments.length > 0 && compositionSegments.every(predicate)
  );
  // Passing evidence and candidate evidence aggregate separately: candidate
  // frames/renders are shown, but only passing tiers may read as progress.
  const previewed = compositionSegments.filter((segment) => segment.preview);
  const passingPreviews = previewed.filter((segment) => segment.preview?.status !== 'candidate');
  const blockedDrafts = compositionSegments.filter(
    (segment) => segment.draft?.status === 'qa_blocked',
  );
  const compositionBySegmentId = new Map(
    compositionSegments.map((segment) => [segment.segment_id, segment]),
  );
  const plannedCompositionIds = plan.segments
    .filter((segment) => segment.source === 'compose')
    .map((segment) => segment.id);
  const everyPlannedComposition = (
    predicate: (segment: VideoStudioReviewSegment) => boolean,
  ) => plannedCompositionIds.length > 0
    ? plannedCompositionIds.every((id) => {
      const segment = compositionBySegmentId.get(id);
      return !!segment && predicate(segment);
    })
    : every(predicate);
  const wholeDraftReady = everyPlannedComposition(
    (segment) => !!segment.draft && segment.draft.status !== 'qa_blocked',
  );
  const finalPath = await finalRenderPath(workspacePath, planPathAbs, plan.final_path);
  const narrations = compositionSegments.map((segment) => segment.narration);
  const totalNarrationSec = narrations.reduce(
    (total, narration) => total + (narration?.duration_sec || 0),
    0,
  );
  const firstNarrationState = ordered.find((record) => record.state.narration)?.state.narration;
  const parentNarration = await assembledNarration(uid, planPathAbs, plan.narration);

  // The production directory, not the plan file's own folder: `compositionTitle`
  // strips the scaffold segments, so `<video>/project/plan.json` titles as
  // `<video>` exactly like a standalone composition does.
  const productionDir = path.dirname(planPathAbs);
  return {
    state_key: `plan:${path.relative(workspacePath, planPathAbs).replace(/\\/g, '/')}`,
    composition_dir: productionDir,
    display_name: path.relative(workspacePath, productionDir).replace(/\\/g, '/')
      || path.basename(productionDir),
    ...(ordered.map((record) => String(record.state.task_title || '').trim()).find(Boolean)
      ? { task_title: ordered.map((r) => String(r.state.task_title || '').trim()).find(Boolean) }
      : {}),
    // The production's stage is how far its authored work has got; a media
    // segment is `produced` the moment it exists and would otherwise report a
    // whole production as finished from its opening cut alone.
    stage: compositionSegments[0]?.stage || 'unknown',
    updated_at_ms: Math.max(...ordered.map((record) => record.updated_at_ms), 0),
    plan_approved: every((segment) => segment.plan_approved),
    // Frames and per-segment drafts are evidence, not decisions. Partial
    // passing frames are still useful to show, while a whole-production draft
    // exists only after every planned composition child produced one. The tier
    // remains explicit so candidate-only evidence never reads as progress.
    ...(previewed.length ? {
      preview: {
        status: passingPreviews.length ? ('ready' as const) : ('candidate' as const),
        // Deduplicated: candidate-tier locators may name shared evidence files
        // (draft QA writes render/draft-evidence/* per run), and the panel's
        // whole-production frame strip must not repeat one file per segment.
        frame_paths: [...new Set(previewed.flatMap((segment) => segment.preview?.frame_paths || []))],
      },
    } : {}),
    ...(parentNarration ? { narration: parentNarration }
      : every((segment) => !!segment.narration) ? {
        narration: {
          status: firstNarrationState?.status || 'ready',
          ...(totalNarrationSec > 0 ? { duration_sec: totalNarrationSec } : {}),
          ...(firstNarrationState?.language ? { language: firstNarrationState.language } : {}),
          ...(typeof firstNarrationState?.speed === 'number'
            ? { speed: firstNarrationState.speed }
            : {}),
        },
      } : {}),
    // A recorded delivered final is draft-step evidence on its own: the
    // assembly path renders through generic edit operations that write no
    // per-segment gate state, so a finished video must not depend on
    // composition drafts existing to be reported.
    ...(wholeDraftReady || finalPath ? {
      draft: { status: 'ready' as const },
    } : blockedDrafts.length ? {
      draft: { status: 'qa_blocked' as const },
    } : {}),
    ...(finalPath ? { final: { path: finalPath } } : {}),
    scenes: segments.flatMap((segment) => segment.scenes),
    segments,
  };
}

export async function buildVideoStudioReviewPanel(
  uid: string,
  cid: string,
): Promise<VideoStudioReviewPanel> {
  const workspacePath = await getConversationWorkspacePath(uid, cid).catch((err) => {
    log.warn('review panel workspace resolution failed', {
      user_id: maskId(uid),
      cid: maskId(cid),
      error: logErrorSummary(err),
    });
    return '';
  });
  if (!workspacePath) return { compositions: [] };
  const gatesDir = path.join(userLocalRoot(uid), 'video_studio', 'gates');
  const entries = await fs.readdir(gatesDir, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('review panel gate directory read failed', { error: logErrorSummary(err) });
    }
    return [];
  });
  const records: ReviewStateRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(gatesDir, entry.name);
    let state: VideoProductionStateV1;
    try {
      state = JSON.parse(await fs.readFile(filePath, 'utf8')) as VideoProductionStateV1;
    } catch (err) {
      log.warn('review panel state read failed', { error: logErrorSummary(err) });
      continue;
    }
    const compositionDir = typeof state?.composition_dir === 'string' ? state.composition_dir : '';
    if (!compositionDir || !isInside(workspacePath, compositionDir)) continue;
    const stat = await fs.stat(filePath).catch((err) => {
      log.warn('review panel state stat failed', { error: logErrorSummary(err) });
      return null;
    });
    records.push({
      state_key: path.basename(entry.name, '.json'),
      composition_dir: compositionDir,
      updated_at_ms: stat?.mtimeMs || 0,
      state,
    });
  }

  // Drop abandoned shells that a live sibling superseded. The test is scoped
  // to one video: a shell alone under its own video is a production that just
  // started and must still show, because hiding it would say the drawer knows
  // of no work at all.
  const byVideo = new Map<string, ReviewStateRecord[]>();
  for (const record of records) {
    const key = videoDirOf(record.composition_dir);
    const group = byVideo.get(key);
    if (group) group.push(record);
    else byVideo.set(key, [record]);
  }
  const live = records.filter((record) => {
    if (!isAbandonedShell(record.state)) return true;
    return !(byVideo.get(videoDirOf(record.composition_dir)) || [])
      .some((other) => other !== record && !isAbandonedShell(other.state));
  });

  const standalone: ReviewStateRecord[] = [];
  const assembled = new Map<string, ReviewStateRecord[]>();
  for (const record of live) {
    // A parent plan outside this conversation's workspace cannot be titled or
    // linked here, so its segments stay standalone rather than grouping under
    // a path the panel would show but never resolve.
    const planPath = parentPlanPathOf(record.state);
    if (planPath && isInside(workspacePath, planPath)) {
      const group = assembled.get(planPath);
      if (group) group.push(record);
      else assembled.set(planPath, [record]);
    } else {
      standalone.push(record);
    }
  }

  const compositions = await Promise.all([
    ...standalone.map((record) => standaloneComposition(workspacePath, record)),
    ...[...assembled.entries()].map(
      ([planPath, records]) => assembledProduction(uid, workspacePath, planPath, records),
    ),
  ]);
  compositions.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  log.info('review panel built', {
    compositions: compositions.length,
    assembled: assembled.size,
    superseded_shells: records.length - live.length,
  });
  return { compositions };
}
