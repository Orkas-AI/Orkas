import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Mutex } from 'async-mutex';

import { userLocalRoot } from '../paths';
import { projectVideoApprovalIntent } from './video_approval_identity';
import { assessEstimatedNarrationFit, estimateNarrationDuration, narrationMeasurementOverruns } from './tts';

export type VideoProductionGenerationKind = 'image' | 'video';

export type VideoProductionGenerationIntent = {
  segment_id: string;
  kind: VideoProductionGenerationKind;
  prompt: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  quality?: string;
  generate_audio?: boolean;
  size?: string;
  operation?: 'generate' | 'edit';
  reference_images?: string[];
  reference_image_urls?: string[];
  reference_image_paths?: string[];
  reference_video_urls?: string[];
  reference_video_paths?: string[];
};

export type VideoProductionControlApproval = {
  signature: string;
  /** Visual-only projection of the approved EDL. A narration-only amendment
   *  may re-sign the plan without making already-presented silent frames
   *  unseen. Optional so control files written before this projection remain
   *  fail-closed and reopen the preview once on their next amendment. */
  visual_signature?: string;
  turn_id: string;
  approved_at: string;
  /** Present when this approval was inherited rather than asked for again:
   *  a measured-fit narration shortening keeps the user's original Gate B. */
  inheritance_reason?: 'measured_narration_fit_repair';
  /** What a narration-only repair is measured against: the plan's signature
   *  with every narration line's text blanked, plus the approved line texts
   *  and windows. Recorded at approval so the repair can be recognized later
   *  without the approved plan content, which the state deliberately does not
   *  keep. `line_windows` is absent only on bases recorded before window
   *  tracking existed; those keep the windows-must-match legacy meaning. */
  narration_fit_basis?: {
    non_narration_signature: string;
    line_texts: string[];
    line_windows?: Array<{ start_sec: number | null; target_sec: number | null }>;
  };
};

export type VideoProductionGenerationApproval = VideoProductionControlApproval & {
  approval_id: string;
  plan_signature: string;
  intent_signature: string;
  segment_ids: string[];
};

export type VideoProductionGenerationTransaction = {
  transaction_id: string;
  approval_id: string;
  segment_id: string;
  kind: VideoProductionGenerationKind;
  request_signature: string;
  output_path: string;
  reserved_output_paths?: string[];
  status: 'pending' | 'completed' | 'failed';
  started_at: string;
  updated_at: string;
  completed_at?: string;
  output_sha256?: string;
  provider_task_id?: string;
  error_code?: string;
};

/** What one segment currently has on disk.
 *
 * Supplied by the caller because segment artifacts live in per-composition
 * state this module does not own. `visual_signature` is the segment's CURRENT
 * visual signature computed from its files. `captured` means there are frames
 * of exactly those bytes to show — an authored-but-never-snapshotted
 * composition has a signature and nothing to look at. How a segment satisfies
 * it depends on what its artifact is: a composition needs snapshot evidence
 * because HTML is not yet pixels, while a cut or generated clip is captured by
 * its own file.
 *
 * This is work state, not approval state: the host no longer records what the
 * user approved of which version. Editing a segment drops it back to
 * uncaptured, which is exactly the set QA has to re-run. */
export type VideoProductionSegmentReviewFact = {
  segment_id: string;
  visual_signature: string;
  captured: boolean;
};

/** One narration line the host itself synthesized for this EDL.
 *
 * The assembled route's narration is owned by the parent: children render
 * silent, the parent synthesizes one file per `tracks.narration.segments` line
 * and mixes them. Nothing recorded that. The review panel derived narration by
 * asking every composition child for its own, which an assembled child is
 * forbidden to have — so a finished, narrated video reported "narration: not
 * started" and no host record existed of six paid syntheses. The plan's own
 * `produced_path` write-back is not a substitute: it depends on the model
 * remembering, and on 2026-08-06 all five lines shipped with it still null.
 *
 * Validity is per line, not per plan. `line_identity` hashes the one thing
 * that governs this line's audio — its exact text plus the signed synthesis
 * selection — and the reader checks it against the current plan. The first
 * version keyed invalidation on the whole plan signature instead, and the
 * very first amendment (2026-08-08: one line shortened to fit its window,
 * user-approved) wiped the record of the four untouched lines whose paid
 * audio was mixed into the delivered video unchanged. `plan_signature` stays
 * for records written before `line_identity` existed: such a line still
 * counts while the plan it names is the currently approved one. */
export type VideoProductionNarrationLineFact = {
  plan_signature: string;
  line_identity?: string;
  segment_index: number;
  path: string;
  measured_duration_sec?: number;
  backend: string;
  language: string;
  speed?: number;
  produced_at: string;
};

export type VideoProductionNarrationLineIdentityInput = {
  text: string;
  routeRef: string;
  voiceRef: string;
  language: string;
  speed?: number;
};

/** Stable identity of one narration line's approved intent: exact text plus
 * the signed synthesis selection. Output format is deliberately absent — the
 * plan signs no per-line format, and the file on disk is the file that gets
 * mixed. Pure, and the single place the hash rule lives: the recorder and the
 * review reader must compute it identically or produced work goes invisible. */
export function videoProductionNarrationLineIdentity(
  input: VideoProductionNarrationLineIdentityInput,
): string {
  return sha256Text(stableJson({
    text: input.text.trim(),
    route_ref: input.routeRef.trim(),
    voice_ref: input.voiceRef.trim(),
    language: input.language.trim(),
    speed: input.speed ?? 1,
  }));
}

export type VideoProductionControlStateV1 = {
  schema_version: 1;
  revision: number;
  plan_path: string;
  plan_signature: string;
  /** Produced narration lines, keyed by zero-based narration segment index. */
  narration_lines?: Record<string, VideoProductionNarrationLineFact>;
  /** Why the last Gate B was invalidated, with the basis it was judged
   * against. The stale path used to delete the approval AND the basis in one
   * motion, so when the fit-repair rule rejected a real repair (2026-08-08:
   * retimed windows) there was nothing left to diagnose WITH — the incident
   * evidence rode out in the deletion. One bounded record, overwritten by the
   * next invalidation, cleared by the next approval. */
  gate_b_invalidation?: {
    invalidated_at: string;
    reason: string;
    detail: string;
    approved_signature: string;
    approved_turn_id: string;
    narration_fit_basis?: { non_narration_signature: string; line_texts: string[]; line_windows?: Array<{ start_sec: number | null; target_sec: number | null }> };
  };
  plan_approval?: VideoProductionControlApproval;
  generation_approval?: VideoProductionGenerationApproval;
  /** The user's reply to this production's aggregate keyframe preview.
   *  Segments defer their own stop to the production's, so the answer has to
   *  live where every segment can see it. Admission requires both the current
   *  plan and complete-production visual signatures; a narration-only re-sign
   *  migrates the plan key while keeping the visual key unchanged. */
  preview_go_ahead?: {
    plan_signature: string;
    /** Content identity of the complete production preview the user saw.
     *  Optional only for backward-compatible reads; an entry without it does
     *  not prove which frames were reviewed and therefore fails closed. */
    visual_signature?: string;
    turn_id: string;
    created_at: string;
  };
  transactions: Record<string, VideoProductionGenerationTransaction>;
  transaction_history: VideoProductionGenerationTransaction[];
  created_at: string;
  updated_at: string;
};

export type VideoProductionPlanIdentity = {
  plan_path: string;
  signature: string;
  visual_signature: string;
  plan: Record<string, unknown>;
  generation_intents: VideoProductionGenerationIntent[];
  intent_signature: string;
};

const mutexes = new Map<string, Mutex>();
function mutexFor(statePath: string): Mutex {
  const key = path.resolve(statePath);
  const existing = mutexes.get(key);
  if (existing) return existing;
  const created = new Mutex();
  mutexes.set(key, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim())
    : [];
}

function assertSemanticVideoEditContract(
  plan: Record<string, unknown>,
  segment: Record<string, unknown>,
  spec: Record<string, unknown>,
): void {
  const segmentId = String(segment.id || '').trim();
  const sourceVideos = [
    ...nonEmptyStringList(spec.reference_video_paths),
    ...nonEmptyStringList(spec.reference_video_urls),
  ];
  if (!sourceVideos.length) {
    throw new Error(`E_VIDEO_PRODUCTION_SEMANTIC_EDIT_REFERENCE_REQUIRED: segment ${segmentId} requires an original reference video`);
  }
  const strategy = isRecord(plan.edit_strategy) ? plan.edit_strategy : null;
  if (!strategy || (strategy.mode !== 'semantic' && strategy.mode !== 'mixed')) {
    throw new Error(`E_VIDEO_PRODUCTION_SEMANTIC_EDIT_STRATEGY_REQUIRED: segment ${segmentId} requires edit_strategy.mode=semantic|mixed`);
  }
  const objectives = nonEmptyStringList(strategy.objectives);
  const signals = nonEmptyStringList(strategy.decision_signals);
  const preserve = nonEmptyStringList(strategy.preserve);
  const mayChange = nonEmptyStringList(strategy.may_change);
  if (!objectives.length || !signals.includes('semantic_model') || !preserve.length || !mayChange.length
    || preserve.some((item) => mayChange.includes(item))) {
    throw new Error(`E_VIDEO_PRODUCTION_SEMANTIC_EDIT_BOUNDARY_INVALID: segment ${segmentId} needs objectives, semantic_model evidence, and non-overlapping preserve/may_change boundaries`);
  }
  const references = Array.isArray(plan.references) ? plan.references.filter(isRecord) : [];
  for (const source of sourceVideos) {
    const reference = references.find((item) => item.source === source
      && item.media_type === 'video'
      && item.intent === 'edit'
      && item.required === true
      && nonEmptyStringList(item.target_segment_ids).includes(segmentId));
    if (!reference) {
      throw new Error(`E_VIDEO_PRODUCTION_SEMANTIC_EDIT_REFERENCE_UNDECLARED: ${source} must be a required top-level video reference with intent=edit targeting ${segmentId}`);
    }
    const referencePreserve = nonEmptyStringList(reference.preserve);
    const referenceMayChange = nonEmptyStringList(reference.may_change);
    const referenceRoles = nonEmptyStringList(reference.roles);
    const temporalAnchors = Array.isArray(reference.temporal_anchors) ? reference.temporal_anchors.filter(isRecord) : [];
    const hasTargetAnchor = temporalAnchors.some((anchor) => anchor.target_segment_id === segmentId
      && typeof anchor.source_start_sec === 'number'
      && Number.isFinite(anchor.source_start_sec)
      && anchor.source_start_sec >= 0
      && typeof anchor.source_end_sec === 'number'
      && Number.isFinite(anchor.source_end_sec)
      && anchor.source_end_sec > anchor.source_start_sec);
    if (!referenceRoles.length || !referencePreserve.length || !referenceMayChange.length
      || referencePreserve.some((item) => referenceMayChange.includes(item))
      || preserve.some((item) => referenceMayChange.includes(item))
      || mayChange.some((item) => referencePreserve.includes(item))
      || !hasTargetAnchor) {
      throw new Error(`E_VIDEO_PRODUCTION_SEMANTIC_EDIT_REFERENCE_INVALID: ${source} needs roles, compatible preserve/may_change boundaries, and a temporal anchor targeting ${segmentId}`);
    }
  }
}

function normalizedApprovalValue(value: unknown): unknown {
  return projectVideoApprovalIntent(value, {
    excludeRootKeys: ['schema_version'],
  });
}

/** Visual projection of the assembled production plan.
 *
 * The production preview is a silent contact sheet. Narration selection and
 * narration text therefore do not change what it proves, including the copy
 * mirrored into a compose child's `narration_text`. Everything else remains
 * fail-closed: a prompt, approved on-screen copy, source, layout contract, or
 * segment duration change produces a different visual signature. */
function videoProductionVisualSignature(plan: Record<string, unknown>): string {
  const projected = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  if (isRecord(projected.tracks)) {
    delete projected.tracks.narration;
    if (Object.keys(projected.tracks).length === 0) delete projected.tracks;
  }
  if (Array.isArray(projected.segments)) {
    for (const segment of projected.segments) {
      if (!isRecord(segment) || !isRecord(segment.spec)) continue;
      const compositionPlan = isRecord(segment.spec.composition_plan)
        ? segment.spec.composition_plan
        : undefined;
      if (!compositionPlan || !Array.isArray(compositionPlan.scenes)) continue;
      for (const scene of compositionPlan.scenes) {
        if (!isRecord(scene)) continue;
        delete scene.narration_text;
        delete scene.narration_refs;
      }
    }
  }
  return sha256Text(stableJson(normalizedApprovalValue(projected)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(absPath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(absPath)).digest('hex');
}

export function videoProductionControlStatePath(input: {
  userId: string;
  projectId?: string;
  planPath: string;
}): string {
  // The absolute plan path is the project artifact identity. projectId/cid are
  // request routing metadata and must not fork approvals for the same file.
  const identity = [input.userId, path.resolve(input.planPath)].join('\0');
  const key = sha256Text(identity).slice(0, 32);
  return path.join(userLocalRoot(input.userId), 'video_studio', 'production', `${key}.json`);
}

function normalizedGenerationIntent(plan: Record<string, unknown>, segment: Record<string, unknown>): VideoProductionGenerationIntent | null {
  if (segment.source !== 'generate' || typeof segment.id !== 'string' || !isRecord(segment.spec)) return null;
  const spec = segment.spec;
  const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : '';
  if (!prompt) return null;
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  const kind: VideoProductionGenerationKind = spec.media_kind === 'image' ? 'image' : 'video';
  if (kind === 'image') {
    const referenceImages = stringList(spec.reference_images);
    const referenceImageUrls = stringList(spec.reference_image_urls);
    return {
      segment_id: segment.id,
      kind,
      prompt,
      ...(typeof spec.size === 'string' && spec.size.trim() ? { size: spec.size.trim() } : {}),
      ...(referenceImages.length ? { reference_images: referenceImages } : {}),
      ...(referenceImageUrls.length ? { reference_image_urls: referenceImageUrls } : {}),
    };
  }
  const targetSec = typeof segment.target_sec === 'number' && Number.isFinite(segment.target_sec)
    ? segment.target_sec
    : 5;
  const requestedDuration = typeof spec.generation_duration_sec === 'number' && Number.isFinite(spec.generation_duration_sec)
    ? spec.generation_duration_sec
    : targetSec;
  const referenceImageUrls = stringList(spec.reference_image_urls);
  const referenceImagePaths = stringList(spec.reference_image_paths);
  const referenceVideoUrls = stringList(spec.reference_video_urls);
  const referenceVideoPaths = stringList(spec.reference_video_paths);
  return {
    segment_id: segment.id,
    kind,
    prompt,
    ratio: typeof plan.aspect === 'string' && plan.aspect.trim() ? plan.aspect.trim() : '16:9',
    duration: Math.min(15, Math.max(4, requestedDuration)),
    resolution: typeof spec.resolution === 'string' && spec.resolution.trim() ? spec.resolution.trim() : '720p',
    quality: spec.quality === 'economy' || spec.quality === 'quality' ? spec.quality : 'balanced',
    generate_audio: spec.generate_audio !== false,
    ...(spec.operation === 'edit' ? { operation: 'edit' as const } : {}),
    ...(referenceImageUrls.length ? { reference_image_urls: referenceImageUrls } : {}),
    ...(referenceImagePaths.length ? { reference_image_paths: referenceImagePaths } : {}),
    ...(referenceVideoUrls.length ? { reference_video_urls: referenceVideoUrls } : {}),
    ...(referenceVideoPaths.length ? { reference_video_paths: referenceVideoPaths } : {}),
  };
}

/** The plan's identity with narration line texts held out, plus those texts
 * and the approved line windows.
 *
 * stage-assemble's own instruction for an over-budget narration line is
 * "shorten it in project/plan.json" — and the narration text is signed
 * intent, so following that instruction re-signed the plan, and
 * `validateVideoProductionPlanApproval` deleted the user's Gate B. On
 * 2026-08-08 one line ran 12.48s against an 11s window; the mechanical
 * shorten cost the user a fresh "confirm the production plan" for a change
 * the host itself required. The single-composition route already inherits
 * across exactly this repair (`measured_narration_fit_repair`).
 *
 * `line_windows` exists because the first version of this basis modeled the
 * repair as "text only, everything else byte-identical" — and the real repair
 * retimes: shortened lines pull the following `start_sec`/`target_sec` with
 * them. Measured the same evening: a five-line retime + shorten was refused,
 * the approval destroyed mid-synthesis, and the user re-asked. The signature
 * still blanks ONLY the texts (so bases recorded before `line_windows`
 * existed keep their exact old meaning); at comparison time the APPROVED
 * windows are substituted into the current plan, which makes "windows moved,
 * nothing else did" land on the same signature. */
function videoProductionNarrationFitBasis(
  plan: Record<string, unknown>,
): { non_narration_signature: string; line_texts: string[]; line_windows: Array<{ start_sec: number | null; target_sec: number | null }> } {
  const lineTexts: string[] = [];
  const lineWindows: Array<{ start_sec: number | null; target_sec: number | null }> = [];
  for (const line of narrationLinesOf(plan)) {
    lineTexts.push(String(line.text ?? ''));
    lineWindows.push({
      start_sec: typeof line.start_sec === 'number' ? line.start_sec : null,
      target_sec: typeof line.target_sec === 'number' ? line.target_sec : null,
    });
  }
  return {
    non_narration_signature: narrationFitComparisonSignature(plan),
    line_texts: lineTexts,
    line_windows: lineWindows,
  };
}

function narrationLinesOf(plan: Record<string, unknown>): Array<Record<string, unknown>> {
  const tracks = isRecord(plan.tracks) ? plan.tracks : undefined;
  const narration = tracks && isRecord(tracks.narration) ? tracks.narration : undefined;
  const segments = narration && Array.isArray(narration.segments) ? narration.segments : [];
  return segments.filter(isRecord);
}

/** The plan's signature with narration texts blanked and, when approved
 * windows are supplied, each line's window replaced by the approved one
 * (null = the approved plan had no such key). Without substitution this is
 * exactly the pre-`line_windows` signature, which is what keeps legacy bases
 * meaningful. */
function narrationFitComparisonSignature(
  plan: Record<string, unknown>,
  approvedWindows?: Array<{ start_sec: number | null; target_sec: number | null }>,
): string {
  const blanked = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  narrationLinesOf(blanked).forEach((line, index) => {
    line.text = '';
    const window = approvedWindows?.[index];
    if (!window) return;
    if (window.start_sec === null) delete line.start_sec; else line.start_sec = window.start_sec;
    if (window.target_sec === null) delete line.target_sec; else line.target_sec = window.target_sec;
  });
  return sha256Text(stableJson(normalizedApprovalValue(blanked)));
}

export type NarrationFitRepairVerdict =
  | { covers: true; repaired: boolean }
  | {
    covers: false;
    /** Which criterion failed — the caller reports it, because a bare
     * boolean here is exactly the held-answer antipattern this module keeps
     * meeting from the other side: the host knew why and said "stale". */
    reason: 'line_count_changed'
      | 'non_narration_changed'
      | 'line_emptied'
      | 'line_lengthened'
      | 'no_narration_change'
      | 'window_only_change'
      | 'no_overrun_evidence'
      | 'narration_change_too_broad';
    detail: string;
  };

const NARRATION_FIT_REPAIR_MAX_EDIT_RATIO = 0.15;

function narrationFitRepairTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const estimate = estimateNarrationDuration(text);
  return estimate.unit === 'characters'
    ? Array.from(normalized).filter((character) => /[\p{L}\p{N}]/u.test(character))
    : normalized.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
}

function narrationFitRepairEditRatio(beforeText: string, afterText: string): number {
  const before = narrationFitRepairTokens(beforeText);
  const after = narrationFitRepairTokens(afterText);
  if (before.length === 0 && after.length === 0) return 0;
  let previous = Array.from({ length: after.length + 1 }, (_, index) => index);
  for (let row = 1; row <= before.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= after.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (before[row - 1] === after[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[after.length] / Math.max(before.length, after.length, 1);
}

function narrationSynthesisSelection(
  plan: Record<string, unknown>,
): Omit<VideoProductionNarrationLineIdentityInput, 'text'> | null {
  const tracks = isRecord(plan.tracks) ? plan.tracks : null;
  const narration = tracks && isRecord(tracks.narration) ? tracks.narration : null;
  const synthesis = narration && isRecord(narration.synthesis) ? narration.synthesis : null;
  if (!synthesis
    || typeof synthesis.route_ref !== 'string'
    || typeof synthesis.voice_ref !== 'string'
    || typeof synthesis.language !== 'string') return null;
  return {
    routeRef: synthesis.route_ref,
    voiceRef: synthesis.voice_ref,
    language: synthesis.language,
    ...(typeof synthesis.speed === 'number' ? { speed: synthesis.speed } : {}),
  };
}

function narrationLineHadOverrun(input: {
  approvedText: string;
  approvedTargetSec: number;
  index: number;
  plan: Record<string, unknown>;
  state: VideoProductionControlStateV1;
}): boolean {
  const selection = narrationSynthesisSelection(input.plan);
  const fact = input.state.narration_lines?.[String(input.index)];
  // Read the measurement the way the warning that prompted this repair read
  // it. This used `narrationDurationBand`, whose five-second floor is an
  // allowance for ESTIMATE error and swallows every short-form line: a 6.125s
  // window accepted 1.13s–11.13s, so the 6.84s line reported `over` at
  // synthesis had "no matching measured overrun" here and its shortening was
  // refused. The estimate band still governs what may be signed; a measured
  // duration is not an estimate and no longer borrows its tolerance.
  if (!fact || typeof fact.measured_duration_sec !== 'number'
    || !narrationMeasurementOverruns(fact.measured_duration_sec, input.approvedTargetSec)) return false;
  return fact.line_identity
    ? !!selection && fact.line_identity === videoProductionNarrationLineIdentity({
      ...selection,
      text: input.approvedText,
    })
    : fact.plan_signature === input.state.plan_approval?.signature;
}

function narrationLineFits(text: string, targetSec: number, plan: Record<string, unknown>): boolean {
  const speed = narrationSynthesisSelection(plan)?.speed ?? 1;
  const fit = assessEstimatedNarrationFit({
    estimate: estimateNarrationDuration(text, speed),
    targetSec,
  });
  return !!fit && fit.status === 'fits';
}

/** Whether the current plan differs from the approved one only by one bounded
 * narration fit repair: at least one objectively over-budget line is shortened
 * into its window, any accompanying retime stays inside those windows, and
 * everything else remains identical. */
function narrationFitRepairCovers(
  approved: { non_narration_signature: string; line_texts: string[]; line_windows?: Array<{ start_sec: number | null; target_sec: number | null }> },
  plan: Record<string, unknown>,
  state: VideoProductionControlStateV1,
): NarrationFitRepairVerdict {
  const lines = narrationLinesOf(plan);
  if (approved.line_texts.length !== lines.length) {
    return {
      covers: false,
      reason: 'line_count_changed',
      detail: `narration line count changed from ${approved.line_texts.length} to ${lines.length}`,
    };
  }
  const comparison = narrationFitComparisonSignature(plan, approved.line_windows);
  if (comparison !== approved.non_narration_signature) {
    return {
      covers: false,
      reason: 'non_narration_changed',
      detail: approved.line_windows
        ? 'a field outside the narration line texts and windows changed'
        : 'a field outside the narration line texts changed (this approval predates window tracking, so retimed windows also land here)',
    };
  }
  let changed = 0;
  let changedTexts = 0;
  const touchedLines = new Set<number>();
  for (let index = 0; index < approved.line_texts.length; index += 1) {
    const before = approved.line_texts[index].trim();
    const after = String(lines[index].text ?? '').trim();
    const textChanged = before !== after;
    if (textChanged) {
      if (!after) {
        return { covers: false, reason: 'line_emptied', detail: `narration line ${index} was emptied — a deleted line is a content change the user should see` };
      }
      if (after.length >= before.length) {
        return { covers: false, reason: 'line_lengthened', detail: `narration line ${index} grew from ${before.length} to ${after.length} characters — a rewrite, not a fit repair` };
      }
      const currentTarget = typeof lines[index].target_sec === 'number' ? lines[index].target_sec : null;
      const approvedTarget = approved.line_windows?.[index]?.target_sec ?? currentTarget;
      if (!(typeof approvedTarget === 'number' && approvedTarget > 0)
        || !narrationLineHadOverrun({
          approvedText: before,
          approvedTargetSec: approvedTarget,
          index,
          plan,
          state,
        })) {
        return {
          covers: false,
          reason: 'no_overrun_evidence',
          detail: `narration line ${index} had no matching measured overrun for this repair to solve`,
        };
      }
      const editRatio = narrationFitRepairEditRatio(before, after);
      if (editRatio > NARRATION_FIT_REPAIR_MAX_EDIT_RATIO) {
        // Name the budget and the overspend. Bare "beyond the bounded scope"
        // left the 2026-08-10 run's 38% rewrite with nowhere to go: the model
        // reverted its shortening and trimmed the audio instead, which cut the
        // closing words out of the delivered video. A trim that fits inside
        // this budget is the move, and it is only actionable if the caller can
        // see how far over it is.
        return {
          covers: false,
          reason: 'narration_change_too_broad',
          detail: `narration line ${index} rewrote ${Math.round(editRatio * 100)}% of its words, past the`
            + ` ${Math.round(NARRATION_FIT_REPAIR_MAX_EDIT_RATIO * 100)}% a timing repair may change without a new approval —`
            + ' restore the approved wording and cut only what the overrun needs, or present the rewrite for approval',
        };
      }
      changed += 1;
      changedTexts += 1;
      touchedLines.add(index);
    }
    const approvedWindow = approved.line_windows?.[index];
    if (approvedWindow) {
      const startNow = typeof lines[index].start_sec === 'number' ? lines[index].start_sec : null;
      const targetNow = typeof lines[index].target_sec === 'number' ? lines[index].target_sec : null;
      if (approvedWindow.start_sec !== startNow || approvedWindow.target_sec !== targetNow) {
        if (!textChanged) {
          return {
            covers: false,
            reason: 'window_only_change',
            detail: `narration line ${index} changed its window without shortening that line`,
          };
        }
        changed += 1;
        touchedLines.add(index);
      }
    }
  }
  if (!changed) {
    return { covers: false, reason: 'no_narration_change', detail: 'the plan re-signed without any narration line change this repair could explain' };
  }
  if (!changedTexts) {
    return { covers: false, reason: 'window_only_change', detail: 'narration windows changed without an over-budget line being shortened' };
  }
  let repaired = true;
  for (const index of touchedLines) {
    const targetSec = typeof lines[index].target_sec === 'number' ? lines[index].target_sec : null;
    if (!(typeof targetSec === 'number' && targetSec > 0)) {
      return {
        covers: false,
        reason: 'non_narration_changed',
        detail: `narration line ${index} has no valid repaired window`,
      };
    }
    if (!narrationLineFits(String(lines[index].text ?? '').trim(), targetSec, plan)) repaired = false;
  }
  return { covers: true, repaired };
}

export async function readVideoProductionPlanIdentity(planPath: string): Promise<VideoProductionPlanIdentity> {
  const planAbs = path.resolve(planPath);
  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await fs.readFile(planAbs, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('plan must be a JSON object');
    plan = parsed;
  } catch (err) {
    throw new Error(`E_VIDEO_PRODUCTION_PLAN_INVALID: ${(err as Error).message}`);
  }
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) {
    throw new Error('E_VIDEO_PRODUCTION_PLAN_INVALID: plan.segments must be a non-empty array');
  }
  if (typeof plan.aspect !== 'string' || !plan.aspect.trim()
    || typeof plan.total_target_sec !== 'number' || !Number.isFinite(plan.total_target_sec) || plan.total_target_sec <= 0
    || typeof plan.language !== 'string' || !plan.language.trim()) {
    throw new Error('E_VIDEO_PRODUCTION_PLAN_INVALID: aspect, positive total_target_sec, and language are required');
  }
  const segments = plan.segments.filter(isRecord);
  if (segments.length !== plan.segments.length) {
    throw new Error('E_VIDEO_PRODUCTION_PLAN_INVALID: every plan segment must be an object');
  }
  const segmentIds = new Set<string>();
  for (const segment of segments) {
    if (typeof segment.id !== 'string' || !segment.id.trim() || segmentIds.has(segment.id)) {
      throw new Error('E_VIDEO_PRODUCTION_PLAN_INVALID: every segment needs a unique non-empty id');
    }
    segmentIds.add(segment.id);
    const spec = isRecord(segment.spec) ? segment.spec : null;
    if (!['edit', 'generate', 'compose', 'provided'].includes(String(segment.source))
      || !['primary', 'overlay', 'bg'].includes(String(segment.layer))
      || typeof segment.target_sec !== 'number' || !Number.isFinite(segment.target_sec) || segment.target_sec <= 0
      || !spec) {
      throw new Error(`E_VIDEO_PRODUCTION_PLAN_INVALID: segment ${segment.id} has an invalid source, layer, duration, or spec`);
    }
    if (segment.source === 'edit') {
      if (typeof spec.input_id !== 'string' || !spec.input_id.trim()
        || typeof spec.in_sec !== 'number' || !Number.isFinite(spec.in_sec)
        || typeof spec.out_sec !== 'number' || !Number.isFinite(spec.out_sec)
        || spec.out_sec <= spec.in_sec) {
        throw new Error(`E_VIDEO_PRODUCTION_EDIT_INTENT_INVALID: segment ${segment.id} needs input_id and a valid trim range`);
      }
    }
    if (segment.source === 'generate') {
      if ((spec.media_kind !== 'image' && spec.media_kind !== 'video')
        || typeof spec.prompt !== 'string' || !spec.prompt.trim()) {
        throw new Error(`E_VIDEO_PRODUCTION_GENERATE_INTENT_INVALID: segment ${segment.id} needs an explicit media_kind and prompt`);
      }
      if (spec.duration_sec !== undefined || spec.audio !== undefined) {
        throw new Error(`E_VIDEO_PRODUCTION_GENERATE_SETTINGS_ALIAS: segment ${segment.id} must use generation_duration_sec and generate_audio; duration_sec/audio are not provider fields`);
      }
      if (spec.aspect !== undefined && spec.aspect !== plan.aspect) {
        throw new Error(`E_VIDEO_PRODUCTION_GENERATE_ASPECT_MISMATCH: segment ${segment.id} spec.aspect conflicts with the plan aspect`);
      }
      const referenceFields = spec.media_kind === 'image'
        ? ['reference_images', 'reference_image_urls']
        : ['reference_image_urls', 'reference_image_paths', 'reference_video_urls', 'reference_video_paths'];
      for (const field of referenceFields) {
        const value = spec[field];
        if (value !== undefined && (!Array.isArray(value)
          || value.some((item) => typeof item !== 'string' || !item.trim()))) {
          throw new Error(`E_VIDEO_PRODUCTION_GENERATE_REFERENCE_INVALID: segment ${segment.id} ${field} must contain non-empty strings`);
        }
      }
      if (spec.media_kind === 'image') {
        if (spec.operation !== undefined
          || (spec.size !== undefined && (typeof spec.size !== 'string' || !spec.size.trim()))) {
          throw new Error(`E_VIDEO_PRODUCTION_GENERATE_SETTINGS_INVALID: image segment ${segment.id} supports size and image references, not operation`);
        }
      } else if ((spec.operation !== undefined && spec.operation !== 'generate' && spec.operation !== 'edit')
        || (spec.generation_duration_sec !== undefined
          && (typeof spec.generation_duration_sec !== 'number'
            || !Number.isFinite(spec.generation_duration_sec)
            || spec.generation_duration_sec < 4
            || spec.generation_duration_sec > 15))
        || (spec.resolution !== undefined && !['480p', '720p', '1080p'].includes(String(spec.resolution)))
        || (spec.quality !== undefined && !['economy', 'balanced', 'quality'].includes(String(spec.quality)))
        || (spec.generate_audio !== undefined && typeof spec.generate_audio !== 'boolean')) {
        throw new Error(`E_VIDEO_PRODUCTION_GENERATE_SETTINGS_INVALID: video segment ${segment.id} has invalid operation, duration, resolution, quality, or audio intent`);
      }
      if (spec.media_kind === 'video' && spec.operation === 'edit') {
        assertSemanticVideoEditContract(plan, segment, spec);
      }
    }
    if (segment.source === 'compose') {
      const binding = isRecord(spec.composition_plan) ? spec.composition_plan : null;
      if (!binding || !Array.isArray(binding.scenes) || binding.scenes.length === 0) {
        throw new Error(`E_VIDEO_PRODUCTION_COMPOSITION_BINDING_REQUIRED: segment ${segment.id} needs spec.composition_plan.scenes before production plan confirmation`);
      }
    }
    if (segment.source === 'provided' && (spec.kind !== 'image' && spec.kind !== 'video')) {
      throw new Error(`E_VIDEO_PRODUCTION_PROVIDED_KIND_REQUIRED: segment ${segment.id} must declare spec.kind=image|video`);
    }
  }
  const generateCount = segments.filter((segment) => segment.source === 'generate').length;
  const billableCount = isRecord(plan.cost_estimate)
    && typeof plan.cost_estimate.billable_generations === 'number'
    && Number.isFinite(plan.cost_estimate.billable_generations)
    ? plan.cost_estimate.billable_generations
    : 0;
  if (billableCount !== generateCount) {
    throw new Error(`E_VIDEO_PRODUCTION_COST_COUNT_MISMATCH: cost_estimate.billable_generations=${billableCount} but the plan has ${generateCount} generate segment(s)`);
  }
  const normalizedPlan = normalizedApprovalValue(plan);
  const signature = sha256Text(stableJson(normalizedPlan));
  const generationIntents = segments
    .map((segment) => normalizedGenerationIntent(plan, segment))
    .filter((intent): intent is VideoProductionGenerationIntent => !!intent)
    .sort((a, b) => a.segment_id.localeCompare(b.segment_id));
  return {
    plan_path: planAbs,
    signature,
    visual_signature: videoProductionVisualSignature(plan),
    plan,
    generation_intents: generationIntents,
    intent_signature: sha256Text(stableJson(generationIntents)),
  };
}

function initialState(planPath: string): VideoProductionControlStateV1 {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    revision: 0,
    plan_path: path.resolve(planPath),
    plan_signature: '',
    transactions: {},
    transaction_history: [],
    created_at: now,
    updated_at: now,
  };
}

export async function readVideoProductionControlState(
  statePath: string,
  planPath: string,
): Promise<VideoProductionControlStateV1> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.schema_version !== 1) return initialState(planPath);
    const loaded = parsed as VideoProductionControlStateV1 & Record<string, unknown>;
    // `review_ledger` / `review_offer` written by an older build are dropped
    // on read: the host no longer records which artifact version the user
    // approved, and a confirmed plan or a paid transaction must stay usable
    // across that removal. Deleted explicitly — the spread would otherwise
    // carry them through every later write forever.
    delete loaded.review_ledger;
    delete loaded.review_offer;
    return {
      ...initialState(planPath),
      ...loaded,
      plan_path: path.resolve(planPath),
      transactions: isRecord(loaded.transactions) ? loaded.transactions : {},
      transaction_history: Array.isArray(loaded.transaction_history)
        ? loaded.transaction_history.slice(-50)
        : [],
    };
  } catch {
    return initialState(planPath);
  }
}

async function writeState(statePath: string, state: VideoProductionControlStateV1): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, statePath);
}

async function updateState(
  statePath: string,
  planPath: string,
  update: (state: VideoProductionControlStateV1) => void,
): Promise<VideoProductionControlStateV1> {
  return mutexFor(statePath).runExclusive(async () => {
    const state = await readVideoProductionControlState(statePath, planPath);
    update(state);
    state.revision += 1;
    state.updated_at = new Date().toISOString();
    await writeState(statePath, state);
    return state;
  });
}

export async function approveVideoProductionPlan(input: {
  statePath: string;
  planPath: string;
  turnId: string;
}): Promise<{ identity: VideoProductionPlanIdentity; state: VideoProductionControlStateV1 }> {
  const identity = await readVideoProductionPlanIdentity(input.planPath);
  const approvedAt = new Date().toISOString();
  const state = await updateState(input.statePath, identity.plan_path, (next) => {
    const changed = next.plan_signature !== identity.signature;
    const previewGoAheadSurvives = changed
      && !!next.plan_approval?.visual_signature
      && next.plan_approval.visual_signature === identity.visual_signature
      && next.preview_go_ahead?.plan_signature === next.plan_approval.signature;
    next.plan_path = identity.plan_path;
    next.plan_signature = identity.signature;
    next.plan_approval = {
      signature: identity.signature,
      visual_signature: identity.visual_signature,
      turn_id: input.turnId,
      approved_at: approvedAt,
      narration_fit_basis: videoProductionNarrationFitBasis(identity.plan),
    };
    delete next.gate_b_invalidation;
    if (changed) {
      delete next.generation_approval;
      if (previewGoAheadSurvives && next.preview_go_ahead) {
        next.preview_go_ahead = {
          ...next.preview_go_ahead,
          plan_signature: identity.signature,
        };
      } else {
        delete next.preview_go_ahead;
      }
      // narration_lines deliberately survives: each line carries its own
      // identity and the reader filters against the current plan. Wiping on
      // re-sign was the 2026-08-08 bug — one user-approved line edit erased
      // the record of four untouched, paid, still-mixed lines.
      next.transaction_history = [
        ...next.transaction_history,
        ...Object.values(next.transactions),
      ].slice(-50);
      next.transactions = {};
    }
  });
  return { identity, state };
}

/** Record the user's reply to this production's keyframe preview stop. */
export async function recordVideoProductionPreviewGoAhead(input: {
  statePath: string;
  planPath: string;
  planSignature: string;
  visualSignature: string;
  turnId: string;
}): Promise<VideoProductionControlStateV1> {
  return updateState(input.statePath, input.planPath, (next) => {
    if (next.preview_go_ahead?.plan_signature === input.planSignature
      && next.preview_go_ahead.visual_signature === input.visualSignature) return;
    next.preview_go_ahead = {
      plan_signature: input.planSignature,
      visual_signature: input.visualSignature,
      turn_id: input.turnId,
      created_at: new Date().toISOString(),
    };
  });
}

/** Record one narration line this host synthesized against the approved plan.
 *
 * Called after the bytes exist, so it never gates or repeats a paid request; a
 * re-synthesis of the same line supersedes the earlier fact rather than
 * accumulating, because only the file currently on disk gets mixed. Records
 * are never wiped here or at approval: each line carries its own identity and
 * the reader counts only lines whose identity the current plan still holds. */
export async function recordVideoProductionNarrationLine(input: {
  statePath: string;
  planPath: string;
  planSignature: string;
  line: Omit<VideoProductionNarrationLineFact, 'plan_signature' | 'line_identity' | 'produced_at'>;
  identity: VideoProductionNarrationLineIdentityInput;
}): Promise<VideoProductionControlStateV1> {
  const producedAt = new Date().toISOString();
  return updateState(input.statePath, input.planPath, (next) => {
    const lines = next.narration_lines ?? {};
    lines[String(input.line.segment_index)] = {
      ...input.line,
      plan_signature: input.planSignature,
      line_identity: videoProductionNarrationLineIdentity(input.identity),
      produced_at: producedAt,
    };
    next.narration_lines = lines;
  });
}

export async function validateVideoProductionPlanApproval(input: {
  statePath: string;
  planPath: string;
}): Promise<{
  identity: VideoProductionPlanIdentity;
  state: VideoProductionControlStateV1;
}> {
  const identity = await readVideoProductionPlanIdentity(input.planPath);
  const state = await readVideoProductionControlState(input.statePath, identity.plan_path);
  if (!state.plan_approval) throw new Error('E_VIDEO_PRODUCTION_GATE_B_REQUIRED: approve the displayed EDL before production');
  if (state.plan_approval.signature !== identity.signature || state.plan_signature !== identity.signature) {
    // A line shortened after a matching measured overrun is the host's own
    // required repair — asking again destroyed the user's approval for a
    // change the host required (2026-08-08). The original Gate B covers one
    // bounded repair episode until it fits; unrelated, post-repair, or
    // structural edits keep the stale path and the user's gate.
    const basis = state.plan_approval.narration_fit_basis;
    const verdict: NarrationFitRepairVerdict = basis
      ? narrationFitRepairCovers(basis, identity.plan, state)
      : { covers: false, reason: 'non_narration_changed', detail: 'this approval recorded no narration basis to judge a repair against' };
    if (verdict.covers === true) {
      const inherited = await updateState(input.statePath, identity.plan_path, (next) => {
        if (!next.plan_approval) return;
        next.plan_signature = identity.signature;
        next.plan_approval = {
          ...next.plan_approval,
          signature: identity.signature,
          visual_signature: identity.visual_signature,
          inheritance_reason: 'measured_narration_fit_repair',
          narration_fit_basis: verdict.repaired
            ? videoProductionNarrationFitBasis(identity.plan)
            : basis,
        };
        if (next.preview_go_ahead) {
          next.preview_go_ahead = { ...next.preview_go_ahead, plan_signature: identity.signature };
        }
        if (next.generation_approval) {
          next.generation_approval = { ...next.generation_approval, plan_signature: identity.signature };
        }
      });
      return { identity, state: inherited };
    }
    const refusal = verdict;
    const invalidatedApproval = state.plan_approval;
    await updateState(input.statePath, identity.plan_path, (next) => {
      next.plan_signature = identity.signature;
      next.gate_b_invalidation = {
        invalidated_at: new Date().toISOString(),
        reason: refusal.reason,
        detail: refusal.detail,
        approved_signature: invalidatedApproval.signature,
        approved_turn_id: invalidatedApproval.turn_id,
        ...(invalidatedApproval.narration_fit_basis
          ? { narration_fit_basis: invalidatedApproval.narration_fit_basis }
          : {}),
      };
      delete next.plan_approval;
      delete next.generation_approval;
    });
    throw new Error(`E_VIDEO_PRODUCTION_GATE_B_STALE: plan.json changed after production plan confirmation — ${refusal.detail}. The invalidated approval and its narration basis are recorded in state as gate_b_invalidation.`);
  }
  return { identity, state };
}

export async function approveVideoProductionGeneration(input: {
  statePath: string;
  planPath: string;
  turnId: string;
}): Promise<{ identity: VideoProductionPlanIdentity; state: VideoProductionControlStateV1 }> {
  const { identity } = await validateVideoProductionPlanApproval(input);
  if (identity.generation_intents.length === 0) {
    throw new Error('E_VIDEO_PRODUCTION_GATE_C_NOT_APPLICABLE: the approved plan has no generate segments');
  }
  const approvedAt = new Date().toISOString();
  const state = await updateState(input.statePath, identity.plan_path, (next) => {
    next.generation_approval = {
      approval_id: crypto.randomUUID(),
      signature: sha256Text(`${identity.signature}\0${identity.intent_signature}\0${approvedAt}`),
      plan_signature: identity.signature,
      intent_signature: identity.intent_signature,
      segment_ids: identity.generation_intents.map((intent) => intent.segment_id),
      turn_id: input.turnId,
      approved_at: approvedAt,
    };
  });
  return { identity, state };
}

export function generationRequestSignature(input: {
  intent: VideoProductionGenerationIntent;
  outputPath: string;
  request: Record<string, unknown>;
}): string {
  return sha256Text(stableJson({
    intent: input.intent,
    output_path: path.resolve(input.outputPath),
    request: normalizedApprovalValue(input.request),
  }));
}

function assertGenerationRequestMatchesIntent(
  intent: VideoProductionGenerationIntent,
  request: Record<string, unknown>,
): void {
  const actualPrompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (actualPrompt !== intent.prompt) {
    throw new Error('E_VIDEO_PRODUCTION_GENERATION_PROMPT_MISMATCH: the provider prompt differs from the confirmed production plan');
  }
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  if (intent.kind === 'image') {
    const actual = {
      size: typeof request.size === 'string' ? request.size.trim() : '',
      reference_images: stringList(request.reference_images),
      reference_image_urls: stringList(request.reference_image_urls),
    };
    const expected = {
      size: intent.size || '',
      reference_images: intent.reference_images || [],
      reference_image_urls: intent.reference_image_urls || [],
    };
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_SETTINGS_MISMATCH: image size or references differ from the approved plan');
    }
    return;
  }
  const normalizedActual = {
    operation: request.operation === 'edit' ? 'edit' : 'generate',
    ratio: typeof request.ratio === 'string' && request.ratio.trim() ? request.ratio.trim() : '16:9',
    duration: typeof request.duration === 'number' && Number.isFinite(request.duration) ? request.duration : 5,
    resolution: typeof request.resolution === 'string' && request.resolution.trim() ? request.resolution.trim() : '720p',
    quality: request.quality === 'economy' || request.quality === 'quality' ? request.quality : 'balanced',
    generate_audio: request.generate_audio !== false,
    reference_image_urls: stringList(request.reference_image_urls),
    reference_image_paths: stringList(request.reference_image_paths),
    reference_video_urls: stringList(request.reference_video_urls),
    reference_video_paths: stringList(request.reference_video_paths),
  };
  const expected = {
    operation: intent.operation || 'generate',
    ratio: intent.ratio || '16:9',
    duration: intent.duration ?? 5,
    resolution: intent.resolution || '720p',
    quality: intent.quality || 'balanced',
    generate_audio: intent.generate_audio !== false,
    reference_image_urls: intent.reference_image_urls || [],
    reference_image_paths: intent.reference_image_paths || [],
    reference_video_urls: intent.reference_video_urls || [],
    reference_video_paths: intent.reference_video_paths || [],
  };
  if (stableJson(normalizedActual) !== stableJson(expected)) {
    throw new Error('E_VIDEO_PRODUCTION_GENERATION_SETTINGS_MISMATCH: operation, references, ratio, duration, resolution, quality, or audio differs from the approved plan');
  }
}

function transactionKey(kind: VideoProductionGenerationKind, segmentId: string): string {
  return `${kind}:${segmentId}`;
}

export async function beginVideoProductionGeneration(input: {
  statePath: string;
  planPath: string;
  segmentId: string;
  kind: VideoProductionGenerationKind;
  outputPath: string;
  candidateOutputPaths?: string[];
  request: Record<string, unknown>;
}): Promise<
  | { status: 'started'; transaction: VideoProductionGenerationTransaction; intent: VideoProductionGenerationIntent }
  | { status: 'reused'; transaction: VideoProductionGenerationTransaction; intent: VideoProductionGenerationIntent }
> {
  return mutexFor(input.statePath).runExclusive(async () => {
    const identity = await readVideoProductionPlanIdentity(input.planPath);
    const state = await readVideoProductionControlState(input.statePath, identity.plan_path);
    if (!state.plan_approval) {
      throw new Error('E_VIDEO_PRODUCTION_GATE_B_REQUIRED: approve the displayed EDL before production');
    }
    if (state.plan_approval.signature !== identity.signature
      || state.plan_signature !== identity.signature) {
      delete state.plan_approval;
      delete state.generation_approval;
      state.plan_signature = identity.signature;
      state.revision += 1;
      state.updated_at = new Date().toISOString();
      await writeState(input.statePath, state);
      throw new Error('E_VIDEO_PRODUCTION_GATE_B_STALE: plan.json changed after production plan confirmation');
    }
    const approval = state.generation_approval;
    if (!approval
      || approval.plan_signature !== identity.signature
      || approval.intent_signature !== identity.intent_signature) {
      throw new Error('E_VIDEO_PRODUCTION_GATE_C_REQUIRED: obtain explicit paid generation confirmation for the current generation intents');
    }
    const intent = identity.generation_intents.find((candidate) => candidate.segment_id === input.segmentId);
    if (!intent) throw new Error(`E_VIDEO_PRODUCTION_SEGMENT_NOT_APPROVED: no approved generate segment ${input.segmentId}`);
    if (intent.kind !== input.kind) {
      throw new Error(`E_VIDEO_PRODUCTION_GENERATION_KIND_MISMATCH: segment ${input.segmentId} is approved for ${intent.kind}, not ${input.kind}`);
    }
    assertGenerationRequestMatchesIntent(intent, input.request);
    const requestSignature = generationRequestSignature({
      intent,
      outputPath: input.outputPath,
      request: input.request,
    });
    const key = transactionKey(input.kind, input.segmentId);
    const existing = state.transactions[key];
    if (existing?.status === 'completed') {
      if (existing.request_signature !== requestSignature) {
        throw new Error('E_VIDEO_PRODUCTION_GENERATION_REQUEST_CHANGED: a completed segment cannot be regenerated with changed inputs under the same plan');
      }
      const stat = await fs.stat(existing.output_path).catch(() => null);
      if (!stat?.isFile()) {
        throw new Error('E_VIDEO_PRODUCTION_GENERATION_ARTIFACT_MISSING: the completed transaction artifact is missing; revise the plan before generating again');
      }
      return { status: 'reused' as const, transaction: existing, intent };
    }
    if (existing?.status === 'pending' && existing.approval_id === approval.approval_id) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_UNCERTAIN: the prior billable request may still have completed; do not retry without a new explicit paid generation confirmation');
    }
    if (existing?.status === 'failed' && existing.approval_id === approval.approval_id) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_REAPPROVAL_REQUIRED: the prior attempt failed after dispatch; obtain a new explicit paid generation confirmation before retrying');
    }
    const reservedOutputPaths = [...new Set([
      input.outputPath,
      ...(input.candidateOutputPaths || []),
    ].map((candidate) => path.resolve(candidate)))];
    if (existing?.status === 'pending') {
      const uncertainPaths = existing.reserved_output_paths?.length
        ? existing.reserved_output_paths
        : [existing.output_path];
      if (uncertainPaths.some((candidate) => reservedOutputPaths.includes(path.resolve(candidate)))) {
        throw new Error('E_VIDEO_PRODUCTION_OUTPUT_RESERVED_BY_UNCERTAIN_ATTEMPT: the previous provider request may still write this path; after renewed paid generation confirmation choose a new output path');
      }
    }
    for (const transaction of Object.values(state.transactions)) {
      if (transaction.segment_id === input.segmentId || transaction.status === 'failed') continue;
      const otherPaths = transaction.reserved_output_paths?.length
        ? transaction.reserved_output_paths
        : [transaction.output_path];
      if (otherPaths.some((candidate) => reservedOutputPaths.includes(path.resolve(candidate)))) {
        throw new Error('E_VIDEO_PRODUCTION_OUTPUT_RESERVED: another approved segment already owns the requested output path');
      }
    }
    for (const candidate of reservedOutputPaths) {
      if (await fs.stat(candidate).catch(() => null)) {
        throw new Error('E_VIDEO_PRODUCTION_OUTPUT_COLLISION: the requested output path already exists but is not owned by a completed transaction; choose a new segment output path');
      }
    }
    const now = new Date().toISOString();
    const transaction: VideoProductionGenerationTransaction = {
      transaction_id: crypto.randomUUID(),
      approval_id: approval.approval_id,
      segment_id: input.segmentId,
      kind: input.kind,
      request_signature: requestSignature,
      output_path: path.resolve(input.outputPath),
      reserved_output_paths: reservedOutputPaths,
      status: 'pending',
      started_at: now,
      updated_at: now,
    };
    if (existing) {
      state.transaction_history = [...state.transaction_history, existing].slice(-50);
    }
    state.transactions[key] = transaction;
    state.revision += 1;
    state.updated_at = now;
    await writeState(input.statePath, state);
    return { status: 'started' as const, transaction, intent };
  });
}

export async function finishVideoProductionGeneration(input: {
  statePath: string;
  planPath: string;
  transactionId: string;
  segmentId: string;
  kind: VideoProductionGenerationKind;
  ok: boolean;
  outputPath?: string;
  providerTaskId?: string;
  errorCode?: string;
}): Promise<VideoProductionGenerationTransaction> {
  const key = transactionKey(input.kind, input.segmentId);
  if (input.ok) {
    if (!input.outputPath) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_ARTIFACT_MISSING: a successful provider result must include its output path');
    }
    const outputAbs = path.resolve(input.outputPath);
    const outputStat = await fs.stat(outputAbs).catch(() => null);
    if (!outputStat?.isFile()) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_ARTIFACT_MISSING: provider reported success but no output file exists');
    }
    const before = await readVideoProductionControlState(input.statePath, input.planPath);
    const active = before.transactions[key];
    if (active?.transaction_id === input.transactionId
      && active.reserved_output_paths?.length
      && !active.reserved_output_paths.map((candidate) => path.resolve(candidate)).includes(outputAbs)) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_OUTPUT_UNEXPECTED: provider output is outside the transaction reservation');
    }
  }
  let finished: VideoProductionGenerationTransaction | undefined;
  await updateState(input.statePath, input.planPath, (next) => {
    const transaction = next.transactions[key];
    if (!transaction || transaction.transaction_id !== input.transactionId) {
      throw new Error('E_VIDEO_PRODUCTION_GENERATION_TRANSACTION_STALE: transaction no longer owns this segment');
    }
    transaction.status = input.ok ? 'completed' : 'failed';
    transaction.updated_at = new Date().toISOString();
    if (input.providerTaskId) transaction.provider_task_id = input.providerTaskId;
    if (input.ok) {
      transaction.completed_at = transaction.updated_at;
      if (input.outputPath) transaction.output_path = path.resolve(input.outputPath);
      delete transaction.error_code;
    } else if (input.errorCode) {
      transaction.error_code = input.errorCode;
    }
    finished = { ...transaction };
  });
  if (!finished) throw new Error('E_VIDEO_PRODUCTION_GENERATION_TRANSACTION_STALE');
  if (input.ok && finished.output_path) {
    const outputSha = await sha256File(finished.output_path).catch(() => '');
    if (outputSha) {
      const completed = finished;
      await updateState(input.statePath, input.planPath, (next) => {
        const transaction = next.transactions[key];
        if (transaction?.transaction_id === input.transactionId) transaction.output_sha256 = outputSha;
      });
      completed.output_sha256 = outputSha;
    }
  }
  return finished;
}

/** Plan-order segment ids of the confirmed EDL. */
export function videoProductionSegmentIds(identity: VideoProductionPlanIdentity): string[] {
  const segments = Array.isArray(identity.plan.segments) ? identity.plan.segments : [];
  return segments.flatMap((segment) => (isRecord(segment) && typeof segment.id === 'string' && segment.id
    ? [segment.id]
    : []));
}

/** What the user approved about one segment, independent of its bytes.
 *
 * Keyed off the plan's own segment record so a segment whose intent is
 * untouched keeps its ledger entry when a sibling is rewritten — the whole
 * point of accounting per segment instead of per production. */
export function videoProductionSegmentIntentSignatures(
  identity: VideoProductionPlanIdentity,
): Record<string, string> {
  const segments = Array.isArray(identity.plan.segments) ? identity.plan.segments : [];
  const output: Record<string, string> = {};
  for (const segment of segments) {
    if (!isRecord(segment) || typeof segment.id !== 'string' || !segment.id) continue;
    output[segment.id] = sha256Text(stableJson(projectVideoApprovalIntent(segment)));
  }
  return output;
}

export type VideoProductionSegmentReviewStatus = {
  segment_id: string;
  plan_intent_signature: string;
  visual_signature: string;
  /** The segment has current snapshot evidence — frames matching its bytes. */
  captured: boolean;
};

/** How far the production's own work has got.
 *
 * There is deliberately no notion of "approved" here. The host used to keep a
 * per-segment ledger of which artifact version the user had confirmed, plus a
 * record of the review it was shown; three days of defects all traced to that
 * one layer — a single-slot offer overwritten by the next status call, a plain
 * reply with no signature to echo, a non-composition segment that could never
 * become approved, and answers voided because the version the user saw was not
 * the version the host remembered. Outside Gate B / Gate C / Gate D the user is
 * shown the artifact and work continues; saying nothing is agreement, so there
 * is nothing left to record. */
export type VideoProductionReviewStatus = {
  segments: VideoProductionSegmentReviewStatus[];
  uncaptured_segment_ids: string[];
  /** Every segment has frames of its current bytes, so the assembly is built
   *  from artifacts that passed QA rather than from unrendered HTML. */
  renderable: boolean;
};

export function videoProductionReviewStatus(input: {
  identity: VideoProductionPlanIdentity;
  facts: VideoProductionSegmentReviewFact[];
}): VideoProductionReviewStatus {
  const intents = videoProductionSegmentIntentSignatures(input.identity);
  const factBySegment = new Map(input.facts.map((fact) => [fact.segment_id, fact]));
  const segments = videoProductionSegmentIds(input.identity).map((segmentId) => {
    const fact = factBySegment.get(segmentId);
    return {
      segment_id: segmentId,
      plan_intent_signature: intents[segmentId] || '',
      visual_signature: fact?.visual_signature || '',
      captured: fact?.captured === true,
    };
  });
  return {
    segments,
    uncaptured_segment_ids: segments.filter((segment) => !segment.captured).map((segment) => segment.segment_id),
    renderable: segments.length > 0 && segments.every((segment) => segment.captured),
  };
}

export function videoProductionControlSummary(
  identity: VideoProductionPlanIdentity,
  state: VideoProductionControlStateV1,
): Record<string, unknown> {
  return {
    schema_version: state.schema_version,
    revision: state.revision,
    plan_signature: identity.signature,
    plan_approval_current: state.plan_approval?.signature === identity.signature,
    generation_intent_count: identity.generation_intents.length,
    generation_approval_current: !!state.generation_approval
      && state.generation_approval.plan_signature === identity.signature
      && state.generation_approval.intent_signature === identity.intent_signature,
    generation_segment_ids: identity.generation_intents.map((intent) => intent.segment_id),
    transaction_history_count: state.transaction_history.length,
    // The stale error tells the model this record exists; production.status
    // is the model's only read surface, so the claim has to be true HERE.
    // Written without a reader, the invalidation was diagnosable only by a
    // human opening the state file — the model's own recovery path (status
    // after a lost approval) saw nothing. Bounded: reason and one detail
    // sentence, the line COUNT of the judged basis, never the line texts —
    // those are user content and stay in the state file.
    ...(state.gate_b_invalidation ? {
      gate_b_invalidation: {
        reason: state.gate_b_invalidation.reason,
        detail: state.gate_b_invalidation.detail,
        invalidated_at: state.gate_b_invalidation.invalidated_at,
        approved_turn_id: state.gate_b_invalidation.approved_turn_id,
        ...(state.gate_b_invalidation.narration_fit_basis
          ? { judged_narration_lines: state.gate_b_invalidation.narration_fit_basis.line_texts.length }
          : {}),
      },
    } : {}),
    transactions: Object.values(state.transactions).map((transaction) => ({
      segment_id: transaction.segment_id,
      kind: transaction.kind,
      status: transaction.status,
      updated_at: transaction.updated_at,
      ...(transaction.error_code ? { error_code: transaction.error_code } : {}),
    })),
    updated_at: state.updated_at,
  };
}
