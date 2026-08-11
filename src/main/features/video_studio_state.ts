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
  /** Visual projection of the composition (audio bytes and narration text
   * excluded; scene windows retained). Present on preview entries recorded since the
   * P1 sub-identity split: while it matches the live tree, the preview and
   * its approval/design review survive narration-only changes. Older entries
   * without this proof fail closed into one fresh preview. */
  visual_signature?: string;
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
   * chosen by the caller; v4 excludes reserved runtime output directories;
   * v5 also reserves the legacy outputs directory. */
  validation_version: 1 | 2 | 3 | 4 | 5;
  design_review?: {
    required: boolean;
    status: 'pending' | 'passed' | 'repair' | 'blocked';
    reviewed_at?: string;
    verdict?: string;
    scope?: string;
    findings?: string[];
    quality_scorecard?: {
      content_alignment: number;
      cover_communication: number;
      hierarchy: number;
      text_legibility: number;
      motion_readiness: number;
      specificity: number;
      reference_fidelity?: number;
      overall: number;
      pass_threshold: number;
      dimension_floor: number;
    };
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
  /** Present only when this transaction is the one new provider request
   * authorized after an earlier request ended with an uncertain outcome. */
  retry_of_transaction_id?: string;
  authorized_turn_id?: string;
  authorization_source?: 'form' | 'model_interpreted_user_message';
  attempt_number?: number;
  timing_episode_id?: string;
  attempt_kind?: 'initial' | 'automatic_timing_retry' | 'user_authorized_timing_retry' | 'provider_retry';
  started_at: string;
  updated_at: string;
};

/**
 * One real user decision may authorize one fresh provider request. Persist it
 * separately from the request transaction so non-billable local repair
 * between approval and dispatch does not require the same confirmation again.
 */
export type VideoProductionNarrationRetryAuthorization = {
  authorization_id: string;
  request_signature: string;
  failed_transaction_id: string;
  authorized_turn_id: string;
  authorization_source: 'form' | 'model_interpreted_user_message';
  max_new_requests: 1;
  consumed_new_requests: 0 | 1;
  authorized_at: string;
  consumed_at?: string;
  validation_version: 1;
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
  tolerance_ratio: number;
  tolerance_floor_sec: number;
  tolerance_sec: number;
  min_duration_sec: number;
  max_duration_sec: number;
  generic_estimated_duration_sec: number;
  estimated_duration_sec: number;
  duration_scale: number;
  narration_unit: 'words' | 'characters';
  narration_units: number;
  suggested_units: number;
  checked_at: string;
  validation_version: 1 | 2;
};

/** The exact COMPOSE plan candidate whose free narration preflight was ready
 * to present. Natural-language approval is interpreted by the model in a later
 * turn; keeping this one bounded snapshot lets the host bind that decision to
 * what was reviewed even if the agent rewrites the manifest before it records
 * the approval. This is review provenance, not a workflow stage. */
export type VideoProductionPlanReviewCandidate = {
  signature: string;
  manifest_json: string;
  checked_turn_id?: string;
  checked_at: string;
  validation_version: 1;
};

export type VideoProductionNarrationTimingEpisode = {
  episode_id: string;
  approval_signature: string;
  target_duration_sec: number;
  tolerance_ratio: number;
  tolerance_floor_sec: number;
  tolerance_sec: number;
  min_duration_sec: number;
  max_duration_sec: number;
  initial_transaction_id: string;
  transaction_ids: string[];
  automatic_retry_limit: 1;
  automatic_retries_used: 0 | 1;
  user_authorized_requests: number;
  user_authorization_consumed: number;
  status: 'active' | 'awaiting_user_decision' | 'accepted' | 'accepted_by_user_waiver';
  latest_measured_duration_sec: number;
  latest_text_sha256: string;
  created_at: string;
  updated_at: string;
  user_waiver?: {
    quote: string;
    turn_id: string;
    created_at: string;
  };
  validation_version: 1;
};

export type VideoProductionPlanFileRecord = {
  path: string;
  sha256: string;
};

export type VideoProductionPlanFiles = {
  /** Retired inputs, recorded only for approvals signed before the manifest
   * became the whole plan. New plans have neither. */
  script?: VideoProductionPlanFileRecord;
  shotlist?: VideoProductionPlanFileRecord;
  manifest: VideoProductionPlanFileRecord;
};

export type VideoProductionPlanApproval = {
  gate: 'B';
  /** Content address of the canonical user-approved intent. Raw artifact
   * hashes below are locators/concurrency evidence, not approval identity. */
  signature: string;
  identity_kind?: 'legacy_artifact_bundle_sha256' | 'approved_intent_sha256';
  /** Immutable normalized payload whose SHA-256 is `signature`. It lets
   * recovery report exact intent differences instead of only two hashes. */
  intent_snapshot?: Record<string, unknown>;
  turn_id: string;
  approved_at: string;
  /** Current role-to-file evidence. Paths are locators and raw hashes detect
   * relocation/concurrent edits; a raw hash change does not itself invalidate
   * the approved intent. */
  artifact_records?: VideoProductionPlanFiles;
  /** Legacy flat list retained for backward compatibility and audit output. */
  artifact_paths: string[];
  inherited_from_signature?: string;
  inherited_at?: string;
  inheritance_reason?: 'measured_narration_fit_repair' | 'parent_edl_segment';
  parent_plan_path?: string;
  parent_segment_id?: string;
  validation_version: 1 | 2 | 3;
};

export type VideoProductionQaWaiverV1 = {
  /** The exact QA finding code the user chose to skip. */
  code: string;
  /** The user's verbatim words from the turn that authorized the waiver. */
  quote: string;
  turn_id: string;
  created_at: string;
};

/** The parent EDL this composition is a segment of, resolved from the current
 * plan approval and falling back to the newest history entry that still
 * carries the link. Being a segment of a plan is structural identity — it
 * survives approvals that were re-signed without resolving the parent, and
 * consumers (review grouping, delivered-opening checks) must all read it the
 * same way or one video scatters into per-segment behavior. */
export function parentEdlLinkOf(
  state: VideoProductionStateV1 | undefined,
): { planPath: string; segmentId: string } {
  const candidates = [
    state?.plan_approval,
    ...[...(state?.plan_approval_history || [])].reverse(),
  ];
  for (const approval of candidates) {
    if (approval?.inheritance_reason === 'parent_edl_segment'
      && typeof approval.parent_plan_path === 'string' && approval.parent_plan_path
      && typeof approval.parent_segment_id === 'string' && approval.parent_segment_id) {
      return { planPath: approval.parent_plan_path, segmentId: approval.parent_segment_id };
    }
  }
  return { planPath: '', segmentId: '' };
}

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
  /** Visual-only projection of the current composition. Narration audio,
   * bindings, and retimed delivery windows do not change this identity. */
  visual_signature?: string;
  /** Visual-only identity recorded when the runtime scaffold was prepared. */
  scaffold_visual_signature?: string;
  /** Legacy full-HTML scaffold identity retained for transaction recovery and
   * old states. It is not sufficient to prove visual authoring because the
   * runtime itself changes HTML when it binds narration. */
  scaffold_html_sha256?: string;
};

export type VideoProductionCandidateLocators = {
  html_path?: string;
  manifest_path?: string;
  preview_path?: string;
  frame_paths?: string[];
  draft_path?: string;
  report_path?: string;
  findings_path?: string;
};

export type VideoProductionCandidateSnapshot = {
  /** Private content-addressed storage. Canonical source files may live
   * anywhere in the allowed workspace; this is not an authoring-directory
   * requirement. */
  root_path: string;
  manifest_path: string;
  source_file_count: number;
  source_total_bytes: number;
  /** Stable copies used to inspect this exact revision after canonical files
   * have changed. */
  locators: VideoProductionCandidateLocators;
  updated_at: string;
};

/**
 * A content-addressed candidate revision. The authored content identity and
 * parent link never change; later probes may only add evidence locators and a
 * newer observation. This is a version record, not a workflow stage.
 */
export type VideoProductionCandidateRevision = {
  revision_id: string;
  parent_revision_id?: string;
  content_hash: string;
  /** Visual projection hash of this candidate (see the preview gate entry's
   * field of the same name). Lets review labeling recognize that a preview
   * approval still covers a candidate whose only drift is narration/audio. */
  visual_signature?: string;
  artifacts: VideoProductionArtifactState;
  locators: VideoProductionCandidateLocators;
  snapshot?: VideoProductionCandidateSnapshot;
  runtime_fingerprint: string;
  created_at: string;
  last_observed_at: string;
  last_observed_op: string;
  last_quality_result?: {
    ok: boolean;
    error_code?: string;
    blocking_error_count?: number;
    observed_at: string;
  };
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
  input_hash?: string;
  stage: VideoProductionStage;
  revision: number;
  turn_id?: string;
  output_path?: string;
  report_path?: string;
  findings_path?: string;
  started_at: string;
};

export type VideoProductionOperationJournalEntry = {
  operation_id: string;
  op: string;
  input_hash?: string;
  status: 'started' | 'passed' | 'failed' | 'interrupted';
  turn_id?: string;
  output_path?: string;
  report_path?: string;
  findings_path?: string;
  error_code?: string;
  /** Quality/content failures consume a same-input attempt; environment and
   * interruption failures remain retryable without changing authored input. */
  consumes_same_input_attempt?: boolean;
  started_at: string;
  finished_at?: string;
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
  /** The turn that recorded the most recent failure. A later real user turn
   *  means that repair episode was abandoned rather than continued. */
  last_failure_turn_id?: string;
  /** Set once an exhausted cycle has measured one further repair. The model
   *  always writes its next repair before it learns the budget is gone, and
   *  presenting pre-repair findings asks the user to choose blind. */
  final_repair_measured?: boolean;
  started_at: string;
  started_by_turn_id?: string;
  /** The turn in which this cycle's budget ran out. The next real user turn
   *  after it is the reply that grants the following cycle. */
  exhausted_by_turn_id?: string;
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
  /** One-line restatement of what the user asked for, recorded when the plan
   * is confirmed. Display only: review surfaces show it instead of the
   * composition path, which users cannot read. Absent on states written
   * before this field and by skills that do not send it. */
  task_title?: string;
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
  /** Bounded audit history for superseded narration attempts. The active
   * transaction remains singular so crash recovery never has to guess which
   * provider request owns the canonical output. */
  narration_transaction_history?: VideoProductionNarrationTransaction[];
  /** Pending only between a retry decision and atomic provider dispatch.
   * Mutable display labels and file locators cannot invalidate it. */
  narration_retry_authorization?: VideoProductionNarrationRetryAuthorization;
  /** Survives narration text revisions; applied only to the same requested
   * voice/speed profile. */
  narration_calibration?: VideoProductionNarrationCalibration;
  /** Signature-bound free preflight result for the candidate Gate B plan. */
  narration_fit?: VideoProductionNarrationFit;
  /** Latest ready, unapproved COMPOSE plan candidate. The full manifest stays
   * durable for same-turn recovery but is omitted from model-facing status. */
  plan_review_candidate?: VideoProductionPlanReviewCandidate;
  /** Bounded authorization for a timing-only narration repair after measured
   * speech misses the approved delivery band. */
  narration_repair?: VideoProductionNarrationRepairAuthorization;
  /** One approved narration plan may spend at most one automatic timing retry,
   * even though each timing edit necessarily changes text_sha256. */
  narration_timing_episode?: VideoProductionNarrationTimingEpisode;
  preview?: VideoProductionGateEntry;
  /** The keyframe preview's one user go-ahead, admitted through the signed plan.
   * Recorded when a render admission passes the preview stop (the user
   * replied after seeing frames). It follows a re-signed plan only when the
   * recorded visual signature is unchanged, so narration-only amendments do
   * not re-open a silent preview while real visual amendments still do. */
  preview_go_ahead?: {
    plan_signature: string;
    turn_id: string;
    created_at: string;
  };
  draft?: VideoProductionGateEntry;
  active_operation?: VideoProductionActiveOperation;
  operation_journal?: VideoProductionOperationJournalEntry[];
  blocked_operation?: VideoProductionBlockedOperation;
  visual_qa?: VideoProductionVisualQaState;
  /** User-authorized waivers of named QA finding codes. Each records the
   * user's verbatim current-turn quote that authorized skipping that check;
   * once recorded, every later QA phase on this production reports the
   * finding as informational instead of blocking. */
  qa_waivers?: VideoProductionQaWaiverV1[];
  /** Current authored candidate plus bounded content-addressed history. */
  current_candidate?: VideoProductionCandidateRevision;
  candidate_history?: VideoProductionCandidateRevision[];
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

function normalizedVideoProductionState(
  value: unknown,
  compositionDir: string,
): VideoProductionStateV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version === 1) {
    if (typeof record.revision !== 'number' || !isVideoProductionStage(record.stage)) {
      return undefined;
    }
    const loaded = record as VideoProductionStateV1;
    return {
      ...initialState(compositionDir),
      ...loaded,
      composition_dir: compositionDir,
      artifacts: loaded.artifacts && typeof loaded.artifacts === 'object' ? loaded.artifacts : {},
      plan_approval_history: Array.isArray(loaded.plan_approval_history)
        ? loaded.plan_approval_history.slice(-10)
        : [],
      candidate_history: Array.isArray(loaded.candidate_history)
        ? loaded.candidate_history.slice(-20)
        : [],
      operation_journal: Array.isArray(loaded.operation_journal)
        ? loaded.operation_journal.slice(-100)
        : [],
      narration_transaction_history: Array.isArray(loaded.narration_transaction_history)
        ? loaded.narration_transaction_history.slice(-20)
        : [],
      history: Array.isArray(loaded.history) ? loaded.history.slice(-50) : [],
    };
  }
  if (record.schema_version !== undefined) return undefined;
  const legacy = record as LegacyGateState;
  return {
    ...initialState(compositionDir),
    stage: stageFromLegacy(legacy),
    ...(legacy.preview ? { preview: legacy.preview } : {}),
    ...(legacy.draft ? { draft: legacy.draft } : {}),
  };
}

async function readVideoProductionStateFile(
  candidatePath: string,
  compositionDir: string,
): Promise<VideoProductionStateV1 | undefined> {
  try {
    return normalizedVideoProductionState(
      JSON.parse(await fs.readFile(candidatePath, 'utf8')),
      compositionDir,
    );
  } catch {
    return undefined;
  }
}

const PLAN_APPROVAL_REQUIRED_OPS = new Set([
  'composition.prepare',
  'composition.materialize_narration',
  'composition.lint',
  'composition.inspect',
  'composition.snapshot',
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
  // A segment of an assembled production has no user gate of its own: the
  // whole production is confirmed once, and the host books each segment from
  // that one answer. Advertising the per-composition approval here is what
  // made a user-requested tweak to one scene open a confirmation for that
  // scene — the model was doing what this list offered it.
  const assembledSegment = state.plan_approval?.inheritance_reason === 'parent_edl_segment';
  // Once the required inputs and preview exist, expose the single productive
  // frontier. Returning the full capability inventory here made the model
  // repeatedly re-inspect/re-snapshot while deciding whether a clear user
  // reply counted; composition.draft is itself the semantic decision point.
  if (!narrationPending && state.draft?.status === 'approved') {
    return ['composition.export'];
  }
  if (!narrationPending && state.draft?.status === 'ready') {
    return assembledSegment ? [] : ['composition.approve_draft'];
  }
  if (!narrationPending && state.preview) {
    return ['composition.draft'];
  }
  const visualEvidenceOps = ['composition.snapshot'];
  const completionOps = narrationPending ? [] : [
    'composition.draft',
    ...(!assembledSegment && state.draft?.status === 'ready' ? ['composition.approve_draft'] : []),
    ...(state.draft?.status === 'approved' ? ['composition.export'] : []),
  ];
  const candidates = [...new Set([
    'composition.approve_plan',
    'composition.prepare',
    ...(!facts || narrationPending ? ['composition.materialize_narration'] : []),
    'composition.lint',
    'composition.inspect',
    ...visualEvidenceOps,
    ...completionOps,
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
  const [primary, mirror] = await Promise.all([
    readVideoProductionStateFile(statePath, compositionDir),
    readVideoProductionStateFile(`${statePath}.bak`, compositionDir),
  ]);
  if (primary && mirror) return mirror.revision > primary.revision ? mirror : primary;
  return primary || mirror || initialState(compositionDir);
}

export async function writeVideoProductionState(
  statePath: string,
  state: VideoProductionStateV1,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const serialized = JSON.stringify(state, null, 2);
  const id = crypto.randomUUID();
  const tempPath = `${statePath}.${id}.tmp`;
  const mirrorPath = `${statePath}.bak`;
  const mirrorTempPath = `${mirrorPath}.${id}.tmp`;
  try {
    await Promise.all([
      fs.writeFile(tempPath, serialized, 'utf8'),
      fs.writeFile(mirrorTempPath, serialized, 'utf8'),
    ]);
    // Publish the mirror first. Readers compare revisions across both files,
    // so interruption between renames still exposes the newest complete
    // record.
    await fs.rename(mirrorTempPath, mirrorPath);
    await fs.rename(tempPath, statePath);
  } finally {
    await Promise.all([
      fs.rm(tempPath, { force: true }),
      fs.rm(mirrorTempPath, { force: true }),
    ]);
  }
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

function mergeCandidateLocators(
  current: VideoProductionCandidateLocators,
  incoming: VideoProductionCandidateLocators,
): VideoProductionCandidateLocators {
  const framePaths = [...new Set([
    ...(current.frame_paths || []),
    ...(incoming.frame_paths || []),
  ])];
  return {
    ...current,
    ...incoming,
    ...(framePaths.length ? { frame_paths: framePaths } : {}),
  };
}

/**
 * Records an immutable content revision while allowing evidence produced for
 * that exact revision to accumulate. A changed content hash creates a child
 * revision and preserves the previous candidate for comparison or rollback.
 */
export function recordVideoProductionCandidate(
  state: VideoProductionStateV1,
  input: {
    contentHash: string;
    visualSignature?: string;
    artifacts: VideoProductionArtifactState;
    locators?: VideoProductionCandidateLocators;
    snapshot?: VideoProductionCandidateSnapshot;
    runtimeFingerprint: string;
    op: string;
    ok?: boolean;
    errorCode?: string;
    blockingErrorCount?: number;
    observedAt?: string;
  },
): VideoProductionCandidateRevision | undefined {
  if (!input.contentHash) return state.current_candidate;
  const observedAt = input.observedAt || new Date().toISOString();
  const quality = typeof input.ok === 'boolean'
    ? {
      ok: input.ok,
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      ...(typeof input.blockingErrorCount === 'number'
        ? { blocking_error_count: input.blockingErrorCount }
        : {}),
      observed_at: observedAt,
    }
    : undefined;
  const current = state.current_candidate;
  if (current?.content_hash === input.contentHash) {
    state.current_candidate = {
      ...current,
      ...(input.visualSignature ? { visual_signature: input.visualSignature } : {}),
      artifacts: { ...current.artifacts, ...input.artifacts },
      locators: mergeCandidateLocators(current.locators, input.locators || {}),
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      runtime_fingerprint: input.runtimeFingerprint,
      last_observed_at: observedAt,
      last_observed_op: input.op,
      ...(quality ? { last_quality_result: quality } : {}),
    };
    return state.current_candidate;
  }
  if (current) {
    state.candidate_history = [
      ...(state.candidate_history || []).filter(
        (candidate) => candidate.content_hash !== current.content_hash,
      ),
      current,
    ].slice(-20);
  }
  state.current_candidate = {
    revision_id: `candidate-${input.contentHash.slice(0, 16)}`,
    ...(current ? { parent_revision_id: current.revision_id } : {}),
    content_hash: input.contentHash,
    ...(input.visualSignature ? { visual_signature: input.visualSignature } : {}),
    artifacts: { ...input.artifacts },
    locators: { ...(input.locators || {}) },
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    runtime_fingerprint: input.runtimeFingerprint,
    created_at: observedAt,
    last_observed_at: observedAt,
    last_observed_op: input.op,
    ...(quality ? { last_quality_result: quality } : {}),
  };
  return state.current_candidate;
}

/**
 * Drop a candidate revision's frozen-store bookkeeping before a model sees it.
 *
 * The live locators sit beside these and are the paths skills repair and
 * publish from; a frozen-store path is an internal content-addressed copy that
 * would be wrong to hand a user anyway. It was 2.6KB of every status call. This
 * lives here rather than in the result compactor because it is not a size
 * decision — the bytes are not usable at any size.
 */
export function projectCandidateRevisionForModel<T>(revision: T): T {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return revision;
  const record = { ...(revision as Record<string, unknown>) };
  const snapshot = record.snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    // An allow-list, not a deny-list: the frozen store owns this object and
    // grows its own bookkeeping (a source index, for one), so a projection
    // that only names what to drop leaks every field added later.
    const kept = snapshot as Record<string, unknown>;
    record.snapshot = {
      ...(kept.manifest_path !== undefined ? { manifest_path: kept.manifest_path } : {}),
      ...(kept.root_path !== undefined ? { root_path: kept.root_path } : {}),
      ...(kept.source_file_count !== undefined ? { source_file_count: kept.source_file_count } : {}),
      ...(kept.source_total_bytes !== undefined ? { source_total_bytes: kept.source_total_bytes } : {}),
      ...(kept.updated_at !== undefined ? { updated_at: kept.updated_at } : {}),
    };
  }
  return record as unknown as T;
}

export function summarizeVideoProductionState(
  state: VideoProductionStateV1,
  facts?: VideoProductionPolicyFacts,
): Record<string, unknown> {
  const visualReadiness = !state.artifacts.html_sha256
    ? 'missing'
    : state.artifacts.scaffold_visual_signature && state.artifacts.visual_signature
      ? state.artifacts.visual_signature === state.artifacts.scaffold_visual_signature
        ? 'scaffold_only'
        : 'authored'
      : state.artifacts.scaffold_html_sha256
        && state.artifacts.html_sha256 === state.artifacts.scaffold_html_sha256
        ? 'scaffold_only'
        : 'authored';
  const narrationReadiness = state.narration?.status === 'materialized'
    ? 'materialized'
    : state.narration_transaction
      ? state.narration_transaction.status === 'synthesized'
        ? 'synthesized_not_accepted'
        : state.narration_transaction.status
      : 'missing';
  const narrationRequired = facts?.narrationRequired
    ?? state.capability_check?.narration_required
    ?? true;
  return {
    schema_version: state.schema_version,
    revision: state.revision,
    stage: state.stage,
    artifacts: state.artifacts,
    artifact_readiness: {
      visuals: visualReadiness,
      narration: narrationReadiness,
      preview: state.preview?.status || 'missing',
      draft: state.draft?.status || 'missing',
      complete_delivery_ready: (!narrationRequired || !!state.narration)
        && visualReadiness === 'authored'
        && !!state.draft,
    },
    // The approved-intent snapshot is the host's own comparison input, not
    // something a reader acts on: the currency check reads it from durable
    // state, and the only question a model could ask of it — what changed
    // since the approval — is answered directly by `plan_intent_changes`.
    // 1.5KB of every status call. `artifact_records` stays: it is a path and a
    // hash, and where the approved plan file lives is a status fact.
    plan_approval: state.plan_approval
      ? (({ intent_snapshot: _snapshot, ...rest }) => rest)(state.plan_approval)
      : null,
    preserved_plan_approval_count: state.plan_approval_history?.length || 0,
    capability_check: state.capability_check || null,
    ...(state.narration ? { narration: state.narration } : {}),
    ...(state.narration_transaction ? { narration_transaction: state.narration_transaction } : {}),
    narration_transaction_history: state.narration_transaction_history || [],
    ...(state.narration_retry_authorization
      ? { narration_retry_authorization: state.narration_retry_authorization }
      : {}),
    ...(state.narration_calibration ? { narration_calibration: state.narration_calibration } : {}),
    ...(state.narration_fit ? { narration_fit: state.narration_fit } : {}),
    ...(state.plan_review_candidate
      ? {
        plan_review_candidate: {
          signature: state.plan_review_candidate.signature,
          checked_turn_id: state.plan_review_candidate.checked_turn_id,
          checked_at: state.plan_review_candidate.checked_at,
          validation_version: state.plan_review_candidate.validation_version,
        },
      }
      : {}),
    ...(state.narration_repair ? { narration_repair: state.narration_repair } : {}),
    ...(state.narration_timing_episode
      ? { narration_timing_episode: state.narration_timing_episode }
      : {}),
    ...(state.active_operation ? { active_operation: state.active_operation } : {}),
    // Bounded on purpose. Measured over the 2026-08-04 run: 202 native results
    // totalling 15.0MB, median 62KB each, and the size was uniform rather than
    // driven by a few large failures. Half of every returned byte was durable
    // state echoed back in full — candidate_history alone was 33%, the journal
    // 8% — and no prompt or skill ever asks the model to read either. Both are
    // append-at-end, so the tail is the recent end; the full records stay on
    // disk and the counts below keep the "how many" fact.
    //
    // The journal entries keep what a reader can act on. `operation_id` and
    // `input_hash` were 1.4KB of every status call and neither is actionable
    // from outside: the model cannot compute a hash, and the repeated-input
    // question it would answer is decided host-side and returned as
    // `same_input_attempts` by the operation that needs it.
    operation_journal: (state.operation_journal || []).slice(-10).map((entry) => {
      const { operation_id: _id, input_hash: _hash, ...actionable } = entry;
      return actionable;
    }),
    operation_journal_count: state.operation_journal?.length || 0,
    ...(state.blocked_operation ? { blocked_operation: state.blocked_operation } : {}),
    ...(state.visual_qa ? { visual_qa: state.visual_qa } : {}),
    ...(state.current_candidate
      ? { current_candidate: projectCandidateRevisionForModel(state.current_candidate) }
      : {}),
    // The count, not the entries. Superseded revisions had exactly one reader —
    // an assembled segment's "fall back to the last version that rendered" —
    // and that path is gone: nothing restored a segment from a preserved
    // snapshot, and a segment never gets its own user approval to fall back to.
    // With it removed no reader is left, while the entries were 11.3KB of every
    // status call, 84% of it absolute frozen-store paths. The full records stay
    // on disk for audit.
    candidate_history_count: state.candidate_history?.length || 0,
    ...(state.last_operation ? { last_operation: state.last_operation } : {}),
    preview_status: state.preview?.status || 'missing',
    ...(state.preview?.design_review
      ? { preview_design_review: state.preview.design_review }
      : {}),
    draft_status: state.draft?.status || 'missing',
    ...(state.draft?.design_review
      ? { draft_design_review: state.draft.design_review }
      : {}),
    next_allowed_ops: nextVideoProductionOps(state, facts),
    updated_at: state.updated_at,
  };
}
