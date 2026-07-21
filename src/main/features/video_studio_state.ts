import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Mutex } from 'async-mutex';

export type VideoProductionStage =
  | 'initialized'
  | 'manifest_ready'
  | 'scaffold_ready'
  | 'narration_ready'
  | 'visuals_ready'
  | 'preview_ready'
  | 'preview_approved'
  | 'draft_ready'
  | 'draft_approved'
  | 'exported';

export type VideoProductionGateEntry = {
  signature: string;
  revision_id?: string;
  turn_id: string;
  created_at: string;
  status: 'ready' | 'approved';
  approved_turn_id?: string;
  approved_at?: string;
  path?: string;
  frame_paths?: string[];
  report_path?: string;
  /** v1 signatures included runtime outputs; v2 excludes the original
   * runtime-output set; v3 also excludes runtime QA reports whose names are
   * chosen by the caller. */
  validation_version: 1 | 2 | 3;
  design_review?: {
    required: boolean;
    status: 'pending' | 'passed' | 'repair' | 'blocked';
    reviewed_at?: string;
    verdict?: string;
    scope?: string;
    findings?: string[];
    reviewed_frame_paths?: string[];
  };
};

export type VideoProductionNarration = {
  status: 'materialized';
  text_sha256: string;
  audio_sha256: string;
  path: string;
  measured_duration_sec: number;
  backend: string;
  route_ref?: string;
  voice_ref?: string;
  language?: string;
  voice?: string;
  speed?: number;
  materialized_at: string;
};

export type VideoProductionNarrationTransaction = {
  transaction_id: string;
  status: 'pending' | 'synthesized' | 'failed';
  text_sha256: string;
  path: string;
  manifest_sha256: string;
  scaffold_html_sha256: string;
  request_signature?: string;
  backend?: string;
  route_ref?: string;
  voice_ref?: string;
  language?: string;
  voice?: string;
  speed?: number;
  generic_estimated_duration_sec?: number;
  narration_unit?: 'words' | 'characters';
  narration_units?: number;
  scene_weights?: number[];
  audio_sha256?: string;
  measured_duration_sec?: number;
  error_code?: string;
  request_disposition?: 'not_sent' | 'rejected_preflight' | 'sent';
  charge_status?: 'not_charged' | 'charged' | 'unknown';
  retry_policy?: 'safe_after_plan_fix' | 'requires_user_action' | 'unknown';
  started_at: string;
  updated_at: string;
};

export type VideoProductionNarrationCalibration = {
  source: 'measured_tts';
  backend: string;
  route_ref?: string;
  voice_ref?: string;
  language?: string;
  voice?: string;
  speed: number;
  generic_estimated_duration_sec: number;
  measured_duration_sec: number;
  duration_scale: number;
  narration_unit: 'words' | 'characters';
  narration_units: number;
  observed_at: string;
};

export type VideoProductionNarrationFit = {
  status: 'fits' | 'over' | 'under';
  source: 'generic' | 'measured_calibration';
  plan_signature: string;
  text_sha256: string;
  route_ref?: string;
  voice_ref?: string;
  language?: string;
  voice?: string;
  speed: number;
  target_duration_sec: number;
  generic_estimated_duration_sec: number;
  estimated_duration_sec: number;
  duration_scale: number;
  narration_unit: 'words' | 'characters';
  narration_units: number;
  suggested_units: number;
  checked_at: string;
  validation_version: 1;
};

export type VideoProductionPlanApproval = {
  gate: 'B';
  signature: string;
  turn_id: string;
  approved_at: string;
  artifact_paths: string[];
  inherited_from_signature?: string;
  inherited_at?: string;
  inheritance_reason?: 'measured_narration_fit_repair' | 'parent_edl_segment';
  parent_plan_path?: string;
  parent_segment_id?: string;
  validation_version: 1;
};

export type VideoProductionNarrationRepairAuthorization = {
  source: 'measured_duration_mismatch';
  approval_signature: string;
  approval_turn_id: string;
  approval_at: string;
  structure_signature: string;
  narration_token_hashes: string[];
  backend: string;
  route_ref?: string;
  voice_ref?: string;
  language?: string;
  voice?: string;
  speed: number;
  target_duration_sec: number;
  max_edit_ratio: number;
  max_checks: number;
  checks_used: number;
  authorized_at: string;
  validation_version: 1;
};

export type VideoProductionCapabilityCheck = {
  status: 'ready' | 'blocked';
  blocking_capabilities: string[];
  narration_required: boolean;
  platform: string;
  arch: string;
  checked_at: string;
};

export type VideoProductionArtifactState = {
  composition_signature?: string;
  manifest_sha256?: string;
  html_sha256?: string;
  /** Hash of the last runtime-owned scaffold. A different current HTML hash
   * proves that visual authoring happened after prepare/narration materialize. */
  scaffold_html_sha256?: string;
};

export type VideoProductionTransition = {
  revision: number;
  op: string;
  status: 'started' | 'passed' | 'failed';
  stage: VideoProductionStage;
  turn_id?: string;
  error_code?: string;
  duration_ms?: number;
  at: string;
};

export type VideoProductionActiveOperation = {
  operation_id: string;
  op: string;
  stage: VideoProductionStage;
  revision: number;
  turn_id?: string;
  output_path?: string;
  report_path?: string;
  findings_path?: string;
  started_at: string;
};

export type VideoProductionBlockedOperation = {
  op: string;
  error_code: string;
  message?: string;
  artifacts: VideoProductionArtifactState;
  created_at: string;
};

export type VideoProductionVisualQaAttempt = {
  status: 'failed' | 'passed';
  max_repair_passes: number;
  /** Distinct composition input signatures that failed in the current
   * repair cycle. Repeating any one of them is rejected before Electron is
   * launched. */
  failed_signatures: string[];
  last_signature: string;
  last_error_code?: string;
  updated_at: string;
};

export type VideoProductionVisualQaCycle = {
  /** Bumps whenever the native inspector's evidence or disposition policy
   * changes. A mismatched persisted cycle is diagnostic history, not an
   * enforceable budget. */
  inspector_version: number;
  cycle_id: string;
  visual_revision: number;
  status: 'active' | 'passed' | 'exhausted';
  max_repair_passes: number;
  /** Shared by inspect and snapshot so the same visual defect cannot consume
   * two independent repair budgets. */
  failed_signatures: string[];
  passed_signatures: Partial<Record<'inspect' | 'snapshot', string>>;
  last_signature?: string;
  last_error_code?: string;
  started_at: string;
  started_by_turn_id?: string;
  updated_at: string;
};

export type VideoProductionVisualQaState = {
  cycle?: VideoProductionVisualQaCycle;
  history?: VideoProductionVisualQaCycle[];
  /** Legacy per-operation ledgers are retained for migration/audit only. */
  inspect?: VideoProductionVisualQaAttempt;
  snapshot?: VideoProductionVisualQaAttempt;
};

/**
 * VideoStudio's durable domain state. Agent session state records that a tool
 * call completed; this record explains which video-production stage and
 * immutable artifacts that completed call represents.
 */
export type VideoProductionStateV1 = {
  schema_version: 1;
  revision: number;
  composition_dir: string;
  stage: VideoProductionStage;
  artifacts: VideoProductionArtifactState;
  plan_approval?: VideoProductionPlanApproval;
  /** Previously valid Gate B approvals are retained so a transient artifact
   * drift can recover automatically when the canonical plan returns to an
   * already-approved signature. */
  plan_approval_history?: VideoProductionPlanApproval[];
  capability_check?: VideoProductionCapabilityCheck;
  narration?: VideoProductionNarration;
  narration_transaction?: VideoProductionNarrationTransaction;
  /** Survives narration text revisions; applied only to the same requested
   * voice/speed profile. */
  narration_calibration?: VideoProductionNarrationCalibration;
  /** Signature-bound free preflight result for the candidate Gate B plan. */
  narration_fit?: VideoProductionNarrationFit;
  /** Bounded authorization for a timing-only narration repair after measured
   * speech misses the approved delivery band. */
  narration_repair?: VideoProductionNarrationRepairAuthorization;
  preview?: VideoProductionGateEntry;
  draft?: VideoProductionGateEntry;
  active_operation?: VideoProductionActiveOperation;
  blocked_operation?: VideoProductionBlockedOperation;
  visual_qa?: VideoProductionVisualQaState;
  last_operation?: VideoProductionTransition;
  history: VideoProductionTransition[];
  created_at: string;
  updated_at: string;
};

/** Canonical filesystem facts are intentionally not persisted in production
 * state. Callers recompute them from the current manifest/audio artifacts and
 * pass them into the policy so a stale compatibility phase cannot authorize a
 * narrated composition without its audio. */
export type VideoProductionPolicyFacts = {
  narrationRequired: boolean;
  narrationMaterialized: boolean;
};

export type VideoProductionOperationAdmission =
  | { ok: true }
  | {
    ok: false;
    errorCode: string;
    message: string;
    nextAction?: string;
  };

type LegacyGateState = {
  preview?: VideoProductionGateEntry;
  draft?: VideoProductionGateEntry;
};

const LEGACY_STAGE_VALUES = new Set<VideoProductionStage>([
  'initialized',
  'manifest_ready',
  'scaffold_ready',
  'narration_ready',
  'visuals_ready',
  'preview_ready',
  'preview_approved',
  'draft_ready',
  'draft_approved',
  'exported',
]);

const stateMutexes = new Map<string, Mutex>();

function stateMutex(statePath: string): Mutex {
  const key = path.resolve(statePath);
  const existing = stateMutexes.get(key);
  if (existing) return existing;
  const created = new Mutex();
  stateMutexes.set(key, created);
  return created;
}

function isVideoProductionStage(value: unknown): value is VideoProductionStage {
  return typeof value === 'string' && LEGACY_STAGE_VALUES.has(value as VideoProductionStage);
}

function initialState(compositionDir: string): VideoProductionStateV1 {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    revision: 0,
    composition_dir: compositionDir,
    stage: 'initialized',
    artifacts: {},
    history: [],
    created_at: now,
    updated_at: now,
  };
}

function stageFromLegacy(value: LegacyGateState): VideoProductionStage {
  if (value.draft?.status === 'approved') return 'draft_approved';
  if (value.draft) return 'draft_ready';
  if (value.preview?.status === 'approved') return 'preview_approved';
  if (value.preview) return 'preview_ready';
  return 'initialized';
}

const PLAN_APPROVAL_REQUIRED_OPS = new Set([
  'composition.prepare',
  'composition.materialize_narration',
  'composition.lint',
  'composition.inspect',
  'composition.begin_visual_revision',
  'composition.snapshot',
  'composition.approve_preview',
  'composition.submit_design_review',
  'composition.draft',
  'composition.approve_draft',
  'composition.export',
]);

/** Operations whose result would be presented, approved, rendered, or
 * delivered as a complete composition. Visual authoring and diagnostics stay
 * available while narration is missing so an orthogonal task cannot strand
 * another one. */
const NARRATION_COMPLETE_REQUIRED_OPS = new Set([
  'composition.snapshot',
  'composition.approve_preview',
  'composition.submit_design_review',
  'composition.draft',
  'composition.approve_draft',
  'composition.export',
]);

/**
 * Fact-based operation admission. The persisted `stage` is deliberately not
 * consulted: it remains a compatibility/display field for existing clients,
 * not an authority over the production workflow.
 */
export function evaluateVideoProductionOperation(
  state: VideoProductionStateV1,
  op: string,
  facts?: VideoProductionPolicyFacts,
): VideoProductionOperationAdmission {
  if (PLAN_APPROVAL_REQUIRED_OPS.has(op) && !state.plan_approval) {
    return {
      ok: false,
      errorCode: 'E_GATE_B_APPROVAL_REQUIRED',
      message: 'Approve the current composition plan before production.',
      nextAction: 'composition.approve_plan',
    };
  }
  if (facts?.narrationRequired
    && !facts.narrationMaterialized
    && NARRATION_COMPLETE_REQUIRED_OPS.has(op)) {
    return {
      ok: false,
      errorCode: 'E_NARRATION_MATERIALIZATION_REQUIRED',
      message: 'This composition requires standalone narration, but its audio or render binding is incomplete. Materialize or recover narration before creating or approving a deliverable artifact.',
      nextAction: 'composition.materialize_narration',
    };
  }
  return { ok: true };
}

export function nextVideoProductionOps(
  state: VideoProductionStateV1,
  facts?: VideoProductionPolicyFacts,
): string[] {
  const recoveryOps = [
    'composition.status',
    'composition.doctor',
    'composition.reconcile',
    'composition.check_narration_fit',
  ];
  if (!state.plan_approval) {
    return ['composition.approve_plan', ...recoveryOps];
  }
  const narrationPending = facts?.narrationRequired && !facts.narrationMaterialized;
  const evidenceOps = narrationPending ? [] : [
    'composition.snapshot',
    'composition.draft',
    ...(state.preview?.design_review?.required && state.preview.design_review.status !== 'passed'
      ? ['composition.submit_design_review']
      : state.preview?.status === 'ready' ? ['composition.approve_preview'] : []),
    ...(state.draft?.design_review?.required && state.draft.design_review.status !== 'passed'
      ? ['composition.submit_design_review']
      : state.draft?.status === 'ready' ? ['composition.approve_draft'] : []),
    ...(state.draft?.status === 'approved' ? ['composition.export'] : []),
  ];
  const candidates = [...new Set([
    'composition.approve_plan',
    'composition.prepare',
    ...(!facts || narrationPending ? ['composition.materialize_narration'] : []),
    'composition.lint',
    'composition.inspect',
    ...(state.visual_qa?.cycle?.status === 'exhausted' ? ['composition.begin_visual_revision'] : []),
    ...evidenceOps,
    ...recoveryOps,
  ])];
  return candidates.filter((op) => evaluateVideoProductionOperation(state, op, facts).ok);
}

/** @deprecated Compatibility helper. Runtime enforcement uses
 * evaluateVideoProductionOperation directly and never interprets `stage`. */
export function isVideoProductionOpAllowed(
  state: VideoProductionStateV1,
  op: string,
  facts?: VideoProductionPolicyFacts,
): boolean {
  return evaluateVideoProductionOperation(state, op, facts).ok;
}

export async function readVideoProductionState(
  statePath: string,
  compositionDir: string,
): Promise<VideoProductionStateV1> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch { return initialState(compositionDir); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return initialState(compositionDir);
  const record = value as Record<string, unknown>;
  if (record.schema_version === 1 && typeof record.revision === 'number' && isVideoProductionStage(record.stage)) {
    const loaded = record as VideoProductionStateV1;
    return {
      ...initialState(compositionDir),
      ...loaded,
      composition_dir: compositionDir,
      artifacts: loaded.artifacts && typeof loaded.artifacts === 'object' ? loaded.artifacts : {},
      plan_approval_history: Array.isArray(loaded.plan_approval_history)
        ? loaded.plan_approval_history.slice(-10)
        : [],
      history: Array.isArray(loaded.history) ? loaded.history.slice(-50) : [],
    };
  }
  const legacy = record as LegacyGateState;
  return {
    ...initialState(compositionDir),
    stage: stageFromLegacy(legacy),
    ...(legacy.preview ? { preview: legacy.preview } : {}),
    ...(legacy.draft ? { draft: legacy.draft } : {}),
  };
}

export async function writeVideoProductionState(
  statePath: string,
  state: VideoProductionStateV1,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tempPath, statePath);
}

export async function updateVideoProductionState(
  statePath: string,
  compositionDir: string,
  update: (state: VideoProductionStateV1) => void,
  options: { expectedRevision?: number } = {},
): Promise<VideoProductionStateV1> {
  return stateMutex(statePath).runExclusive(async () => {
    const state = await readVideoProductionState(statePath, compositionDir);
    if (typeof options.expectedRevision === 'number' && state.revision !== options.expectedRevision) {
      throw new Error(`E_VIDEO_PRODUCTION_STATE_CONFLICT: expected revision ${options.expectedRevision}, found ${state.revision}.`);
    }
    update(state);
    state.revision += 1;
    state.updated_at = new Date().toISOString();
    await writeVideoProductionState(statePath, state);
    return state;
  });
}

export function recordVideoProductionTransition(
  state: VideoProductionStateV1,
  input: {
    op: string;
    status: 'started' | 'passed' | 'failed';
    turnId?: string;
    stage?: VideoProductionStage;
    errorCode?: string;
    artifacts?: VideoProductionArtifactState;
  },
): void {
  if (input.stage) state.stage = input.stage;
  if (input.artifacts) state.artifacts = { ...state.artifacts, ...input.artifacts };
  const active = state.active_operation?.op === input.op ? state.active_operation : undefined;
  const durationMs = active && input.status !== 'started'
    ? Math.max(0, Date.now() - Date.parse(active.started_at))
    : undefined;
  const transition: VideoProductionTransition = {
    revision: state.revision + 1,
    op: input.op,
    status: input.status,
    stage: state.stage,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
    at: new Date().toISOString(),
  };
  if (input.status !== 'started' && active) delete state.active_operation;
  state.last_operation = transition;
  state.history = [...state.history, transition].slice(-50);
}

export function summarizeVideoProductionState(
  state: VideoProductionStateV1,
  facts?: VideoProductionPolicyFacts,
): Record<string, unknown> {
  return {
    schema_version: state.schema_version,
    revision: state.revision,
    stage: state.stage,
    artifacts: state.artifacts,
    plan_approval: state.plan_approval || null,
    preserved_plan_approval_count: state.plan_approval_history?.length || 0,
    capability_check: state.capability_check || null,
    ...(state.narration ? { narration: state.narration } : {}),
    ...(state.narration_transaction ? { narration_transaction: state.narration_transaction } : {}),
    ...(state.narration_calibration ? { narration_calibration: state.narration_calibration } : {}),
    ...(state.narration_fit ? { narration_fit: state.narration_fit } : {}),
    ...(state.narration_repair ? { narration_repair: state.narration_repair } : {}),
    ...(state.active_operation ? { active_operation: state.active_operation } : {}),
    ...(state.blocked_operation ? { blocked_operation: state.blocked_operation } : {}),
    ...(state.visual_qa ? { visual_qa: state.visual_qa } : {}),
    ...(state.last_operation ? { last_operation: state.last_operation } : {}),
    preview_status: state.preview?.status || 'missing',
    preview_design_review: state.preview?.design_review || null,
    draft_status: state.draft?.status || 'missing',
    draft_design_review: state.draft?.design_review || null,
    next_allowed_ops: nextVideoProductionOps(state, facts),
    updated_at: state.updated_at,
  };
}
