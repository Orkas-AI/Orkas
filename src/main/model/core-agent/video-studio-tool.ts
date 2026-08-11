/**
 * VideoStudio-owned native runtime tool.
 *
 * This intentionally covers only the VideoStudio dependency points that need
 * to be native:
 * HTML composition render/lint/inspect and speech transcription. The rest of
 * VideoStudio's agent-private scripts stay script-owned.
 */

import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { prepareLosslessModelImage } from '../../features/image_assets';
import { getLocalExecGranted } from '../../features/permissions';
import {
  checkInstalledVideoStudioContract,
  VIDEO_STUDIO_MIN_COMPATIBLE_AGENT_VERSION,
  VIDEO_STUDIO_TOOL_CONTRACT,
  type VideoStudioContractCheck,
} from '../../features/video_studio_skill_contract';
import {
  draftComposition,
  inspectComposition,
  lintComposition,
  prepareComposition,
  snapshotComposition,
  transcribeSpeech,
  writeProductionContactSheet,
  type RenderFormat,
  type RenderQuality,
  type VideoStudioOp,
  type VideoStudioResult,
} from '../../features/video_studio';
import {
  buildCompositionNarrationMap,
  buildCompositionScaffold,
  compositionNarrationText,
  CompositionManifestSchema,
  normalizeCompositionHtmlForVisualIdentity,
  reconcileCompositionHtml,
  retimeCompositionManifestForNarration,
  validateCompositionManifestSemantics,
  visualProjectionOfCompositionManifest,
  type CompositionManifest,
} from '../../features/video_studio_contract';
import {
  evaluateVideoProductionOperation,
  parentEdlLinkOf,
  readVideoProductionState,
  recordVideoProductionCandidate,
  recordVideoProductionTransition,
  projectCandidateRevisionForModel,
  summarizeVideoProductionState,
  updateVideoProductionState,
  type VideoProductionArtifactState,
  type VideoProductionCandidateLocators,
  type VideoProductionCandidateRevision,
  type VideoProductionCandidateSnapshot,
  type VideoProductionGateEntry,
  type VideoProductionNarrationFit,
  type VideoProductionNarrationRepairAuthorization,
  type VideoProductionNarrationTimingEpisode,
  type VideoProductionNarrationTransaction,
  type VideoProductionPlanApproval,
  type VideoProductionPlanFileRecord,
  type VideoProductionPlanFiles,
  type VideoProductionPolicyFacts,
  type VideoProductionStateV1,
  type VideoProductionVisualQaCycle,
  type VideoProductionVisualQaState,
  type VideoProductionVisualQaAttempt,
} from '../../features/video_studio_state';
import {
  assertVideoStudioDesignQualityVerdict,
  compileVideoStudioDesignQualityScorecard,
  isEnvironmentalDraftFailure,
  qaFindingIsWaivable,
  VIDEO_STUDIO_INSPECTOR_VERSION,
} from '../../features/video_studio_qa';
import {
  approveVideoProductionGeneration,
  approveVideoProductionPlan,
  readVideoProductionControlState,
  recordVideoProductionPreviewGoAhead,
  readVideoProductionPlanIdentity,
  validateVideoProductionPlanApproval,
  videoProductionControlStatePath,
  videoProductionControlSummary,
  videoProductionReviewStatus,
  videoProductionSegmentIds,
  type VideoProductionPlanIdentity,
  type VideoProductionSegmentReviewFact,
} from '../../features/video_production_control';
import { verifyProductionDelivery } from '../../features/video_studio_delivery';
import { projectVideoApprovalIntent } from '../../features/video_approval_identity';
import { redactPaths } from '../../util/redact';
import { canonicalizeManifestSourceShotReferences } from '../../features/video_studio_source_alignment';
import {
  assessEstimatedNarrationFit,
  configuredTtsBackendId,
  estimateNarrationDuration,
  generateSpeech,
  hasConfiguredTtsProvider,
  narrationDurationBand,
  narrationFitBlocksProduction,
  narrationDurationCalibrationScale,
} from '../../features/tts';
import {
  getTtsAvailabilityDetails,
  listableTtsVoices,
  listTtsCapabilities,
  publicTtsCapabilities,
  resolveTtsSelection,
  type ResolvedTtsSelection,
} from '../../features/tts_capabilities';
import { probeMediaDurationSec } from '../../util/media_probe';
import { bundledFfmpegPaths, bundledWhisperPaths } from '../../util/bundled-runtime';
import { isPathAllowed } from '../../util/path-sandbox';
import { chatMediaLocalUrl } from '../../util/chat-media-url';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { getWorkspacePath } from '../../features/user_workspace';
import { decodeSubmission } from '../../features/group_chat/router';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { resolveLocalMediaPath } from '../../features/chat_attachments';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { userLocalRoot } from '../../paths';
import { recordRead } from './read-tracker';
import { finalizeProducedFile } from '../../features/produced_output_hooks';

const log = createLogger('video-studio-tool');
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
const NARRATION_REPAIR_MAX_EDIT_RATIO = 0.15;
const NARRATION_REPAIR_MAX_CHECKS = 2;
const VISUAL_QA_MAX_REPAIR_PASSES = 2;
/** Canonical snapshot destination, relative to the composition directory.
 *  `preview/` is excluded from every composition-signature version, so
 *  defaulting here cannot perturb an approved plan's identity. */
const DEFAULT_SNAPSHOT_OUTPUT_RELATIVE_PATH = path.join('preview', 'first-frame.png');
/**
 * Where each QA operation's record lands when the caller names no findings_path.
 *
 * It used to land nowhere. `findings_path` is optional, so a call that omitted
 * it produced a result that existed only in that one tool payload — and the
 * payload is gone once the turn completes. 2026-08-08: a blocked snapshot left
 * `qa/snapshot.json` holding the PREVIOUS evening's conclusions, which is worse
 * than an absent file, because anything reading it (the model on a later turn,
 * anyone doing forensics) gets a confident answer about a run that no longer
 * exists. `qa/` is outside the composition signature, so rewriting it on every
 * call costs nothing the preflight will notice. Only the two operations whose
 * whole output IS a QA verdict get a default; draft and export keep their own
 * `report_path`.
 */
const DEFAULT_QA_FINDINGS_RELATIVE_PATH: Record<string, string> = {
  'composition.snapshot': path.join('qa', 'snapshot.json'),
  'composition.inspect': path.join('qa', 'inspect.json'),
};

export type VideoStudioApprovalGate = 'plan' | 'generation' | 'narration_retry' | 'preview' | 'draft' | 'qa_waiver';
export type VideoStudioApprovalDecision = 'approve' | 'reject' | 'unknown';
export type VideoStudioDecisionEvidence = {
  source: 'user_message';
  gate: VideoStudioApprovalGate;
  decision: 'approve' | 'revise' | 'reject';
  /** Verbatim excerpt from the current real user turn. The host verifies
   * provenance only; semantic interpretation belongs to the model. */
  quote: string;
};

export type VideoStudioResolvedDecision = {
  decision: 'approve' | 'revise' | 'reject' | 'unknown';
  source: 'form' | 'model_interpreted_user_message' | 'none';
  evidence_status: 'not_provided' | 'valid' | 'invalid';
  /** A deterministic form was submitted, but it did not decide this gate. */
  structured_submission_detected?: boolean;
  /** Structured Preview/Final forms bind their opaque option value to the
   * exact artifact signature they displayed. Natural-language replies target
   * the current artifact semantically and therefore omit this field. */
  artifact_signature?: string;
  evidence_format?: 'object' | 'json_string';
  evidence_issue?:
  | 'expected_object'
  | 'source_invalid'
  | 'gate_mismatch'
  | 'decision_invalid'
  | 'quote_missing'
  | 'quote_not_in_current_turn';
};

const APPROVAL_FIELD_RE = /(?:^|_)(?:approval|approve|decision|action|confirm|confirmation|reconfirm)(?:_|$)/i;
const APPROVAL_VALUES = new Set([
  'approve', 'approved', 'yes', 'continue', 'confirm', 'confirmed', 'accept', 'accepted',
  '同意', '批准', '确认', '继续', '通过',
]);
const REJECTION_VALUES = new Set([
  'revise', 'revision', 'change', 'change_direction', 'reject', 'rejected', 'deny', 'denied',
  'no', 'cancel', 'back', 'modify', 'edit', 'stop', 'pause',
  '修改', '调整', '重做', '拒绝', '取消', '返回', '停止', '暂停',
]);
const REVISION_VALUES = new Set([
  'revise', 'revision', 'change', 'change_direction', 'modify', 'edit',
  '修改', '调整', '重做',
]);

function currentUserTurnPayload(message: string | undefined): string {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const messageRe = /<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi;
  let current = '';
  let sawWrappedMessage = false;
  for (const match of raw.matchAll(messageRe)) {
    sawWrappedMessage = true;
    const attrs = match[1] || '';
    const from = attrs.match(/\bfrom\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (from === 'user') current = match[2] || '';
  }
  return (sawWrappedMessage ? current : raw).trim();
}

/**
 * A gate decision may only come from a real user turn. A commander nested
 * dispatch wakes the agent with `<msg from="commander" …>`, which carries no
 * user reply at all — that is a routing fact, not a malformed tool argument,
 * so it must never be reported as a retryable input error. An unwrapped
 * message (plain chat, no group envelope) is the user's own turn.
 */
function currentUserTurnAvailable(message: string | undefined): boolean {
  return !!currentUserTurnPayload(message);
}

function approvalKeyGateHints(key: string): Set<VideoStudioApprovalGate> {
  const hints = new Set<VideoStudioApprovalGate>();
  if (/(?:^|_)(?:gate_?b|plan|script|shotlist|storyboard|edl)(?:_|$)/i.test(key)) hints.add('plan');
  if (/(?:^|_)(?:gate_?c|billing|billable|generation|cost)(?:_|$)/i.test(key)) hints.add('generation');
  if (/(?:^|_)(?:narration_?retry|tts_?retry|speech_?retry)(?:_|$)/i.test(key)) hints.add('narration_retry');
  if (/(?:^|_)(?:html_?preview|preview)(?:_|$)/i.test(key)) hints.add('preview');
  if (/(?:^|_)(?:gate_?d|draft|export|final)(?:_|$)/i.test(key)) hints.add('draft');
  return hints;
}

function structuredApproval(value: unknown): {
  decision: VideoStudioApprovalDecision;
  artifact_signature?: string;
} {
  if (value === true) return { decision: 'approve' };
  if (value === false) return { decision: 'reject' };
  if (typeof value !== 'string') return { decision: 'unknown' };
  const raw = value.trim();
  const bound = raw.match(/^([^:]+)::([a-f0-9]{64})$/i);
  const decisionText = bound?.[1] || raw;
  const normalized = decisionText.toLowerCase().replace(/[\s-]+/g, '_');
  const decision = APPROVAL_VALUES.has(normalized)
    ? 'approve'
    : REJECTION_VALUES.has(normalized)
      ? 'reject'
      : 'unknown';
  return {
    decision,
    ...(bound && decision !== 'unknown'
      ? { artifact_signature: bound[2].toLowerCase() }
      : {}),
  };
}

function structuredVideoStudioGateDecision(
  message: string | undefined,
  gate: VideoStudioApprovalGate,
  expectedAgentId = VIDEO_STUDIO_AGENT_ID,
): {
  decision: VideoStudioApprovalDecision;
  artifact_signature?: string;
} {
  const payload = currentUserTurnPayload(message);
  if (!payload) return { decision: 'unknown' };

  const hasSubmissionTag = /<agent-input-submission\b/i.test(payload);
  const submission = decodeSubmission(payload);
  if (!hasSubmissionTag || !submission || submission.agent_id !== expectedAgentId) {
    return { decision: 'unknown' };
  }
  let approved: { artifact_signature?: string } | undefined;
  let rejected: { artifact_signature?: string } | undefined;
  for (const [key, value] of Object.entries(submission.values)) {
    if (!APPROVAL_FIELD_RE.test(key)) continue;
    const hints = approvalKeyGateHints(key);
    if (hints.size !== 1 || !hints.has(gate)) continue;
    const parsed = structuredApproval(value);
    if (parsed.decision === 'approve') approved = parsed;
    if (parsed.decision === 'reject') rejected = parsed;
  }
  if (rejected) return { decision: 'reject', ...rejected };
  return approved ? { decision: 'approve', ...approved } : { decision: 'unknown' };
}

/**
 * Resolve approval only from the current real user turn. Structured form data
 * wins over its human-readable summary, field ids may vary but must carry an
 * approval semantic, and a field explicitly tied to another gate is ignored.
 */
export function explicitVideoStudioGateDecision(
  message: string | undefined,
  gate: VideoStudioApprovalGate,
  expectedAgentId = VIDEO_STUDIO_AGENT_ID,
): VideoStudioApprovalDecision {
  return structuredVideoStudioGateDecision(message, gate, expectedAgentId).decision;
}

function normalizedDecisionText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Forms remain deterministic structured input. Natural-language replies are
 * interpreted by the model and supplied as structured evidence. The host only
 * verifies that the quoted evidence came from the current real user turn and
 * that it targets the operation's gate; it intentionally has no keyword or
 * locale-specific intent rules.
 */
export function resolveVideoStudioCurrentTurnDecision(
  message: string | undefined,
  gate: VideoStudioApprovalGate,
  evidence: unknown,
  expectedAgentId = VIDEO_STUDIO_AGENT_ID,
): VideoStudioResolvedDecision {
  const structured = structuredVideoStudioGateDecision(message, gate, expectedAgentId);
  if (structured.decision !== 'unknown') {
    return {
      decision: structured.decision === 'approve' ? 'approve' : 'reject',
      source: 'form',
      evidence_status: 'not_provided',
      ...(structured.artifact_signature
        ? { artifact_signature: structured.artifact_signature }
        : {}),
    };
  }
  const structuredSubmissionDetected = /<agent-input-submission\b/i.test(
    currentUserTurnPayload(message),
  );
  if (evidence === undefined || evidence === null) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'not_provided',
      ...(structuredSubmissionDetected ? { structured_submission_detected: true } : {}),
    };
  }
  let normalizedEvidence = evidence;
  let evidenceFormat: 'object' | 'json_string' = 'object';
  if (typeof normalizedEvidence === 'string') {
    evidenceFormat = 'json_string';
    try {
      normalizedEvidence = JSON.parse(normalizedEvidence);
    } catch {
      return {
        decision: 'unknown',
        source: 'none',
        evidence_status: 'invalid',
        evidence_format: evidenceFormat,
        evidence_issue: 'expected_object',
      };
    }
  }
  if (!normalizedEvidence
    || typeof normalizedEvidence !== 'object'
    || Array.isArray(normalizedEvidence)) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'expected_object',
    };
  }
  const record = normalizedEvidence as Record<string, unknown>;
  if (record.source !== 'user_message') {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'source_invalid',
    };
  }
  if (record.gate !== gate) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'gate_mismatch',
    };
  }
  if (!['approve', 'revise', 'reject'].includes(String(record.decision || ''))) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'decision_invalid',
    };
  }
  const payload = normalizedDecisionText(currentUserTurnPayload(message));
  const quote = normalizedDecisionText(String(record.quote || ''));
  if (!quote || quote.length > 500) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'quote_missing',
    };
  }
  if (!payload || !payload.includes(quote)) {
    return {
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: evidenceFormat,
      evidence_issue: 'quote_not_in_current_turn',
    };
  }
  return {
    decision: record.decision as 'approve' | 'revise' | 'reject',
    source: 'model_interpreted_user_message',
    evidence_status: 'valid',
    evidence_format: evidenceFormat,
  };
}

function decisionEvidenceCorrectionResult(
  op: VideoStudioOp,
  gate: VideoStudioApprovalGate,
  decision: VideoStudioResolvedDecision,
  options: { correctOmittedEvidence?: boolean } = {},
): Record<string, unknown> | undefined {
  if (decision.source === 'form') return undefined;
  const missing = options.correctOmittedEvidence === true
    && decision.evidence_status === 'not_provided'
    && decision.source === 'none'
    && decision.structured_submission_detected !== true;
  if (!missing && decision.evidence_status !== 'invalid') return undefined;
  // A quote that is not in the current user message is a PROVENANCE failure,
  // not a shape one. Reporting it as "not a valid structured object" and
  // telling the model to re-interpret and retry is how a fabricated approval
  // becomes a loop: on 2026-08-10 the model invented `quote: "确认方案"` for a
  // decision the user never made, was told its object was malformed, retried
  // the identical object, and the no-progress breaker ended the turn with a
  // page of English diagnostics in the user's chat. The host knows which of
  // the two it is — `evidence_issue` has always carried it — so it says so,
  // and leans to the user: a needless stop costs one reply, a needless retry
  // costs the turn.
  if (!missing && decision.evidence_issue === 'quote_not_in_current_turn') {
    return {
      ok: false,
      op,
      errorCode: 'E_DECISION_EVIDENCE_NOT_FROM_USER',
      message: 'The quoted text does not appear in the current user message, so nothing here records this decision.'
        + ' The evidence object itself was well formed — do not reshape it and retry. If the user did decide this gate,'
        + ' quote their words exactly as they wrote them and retry once. If they did not, they have not answered yet:'
        + ' present the current review material to them and end the turn.',
      presentation_required: true,
      decision_evidence_valid: false,
      decision_evidence_issue: 'quote_not_in_current_turn',
      current_user_message_available: true,
      requires_user_decision: true,
      user_reconfirmation_required: false,
      automatic_recovery_expected: false,
      next_step_owner: 'user',
      same_turn_continuation_required: false,
      billable_request_sent: false,
      expected_decision_evidence: {
        source: 'user_message',
        gate,
        decision: ['approve', 'revise', 'reject'],
        quote: 'verbatim excerpt from the current real user message',
      },
      next_action: 'present_review_material_and_end_turn_unless_the_user_already_decided',
    };
  }
  return {
    ok: false,
    op,
    errorCode: missing ? 'E_DECISION_EVIDENCE_REQUIRED' : 'E_DECISION_EVIDENCE_INVALID',
    message: missing
      ? 'This gate operation omitted the model\'s semantic decision for the current user reply. Classify that same reply once: if it decides this gate, retry now with structured decision_evidence; otherwise continue the appropriate non-gate flow. This missing argument is Agent work and must not reopen or display a user confirmation.'
      : 'The current user reply is still available, but decision_evidence was not a valid structured object for this operation. Re-interpret the same current reply and retry this operation now with a native object; do not ask the user to confirm again.',
    presentation_required: false,
    decision_evidence_valid: false,
    decision_evidence_required: true,
    decision_evidence_issue: missing ? 'not_provided' : decision.evidence_issue || 'expected_object',
    decision_evidence_format: decision.evidence_format || 'object',
    current_user_message_available: true,
    requires_user_decision: false,
    user_reconfirmation_required: false,
    automatic_recovery_expected: true,
    next_step_owner: 'agent',
    same_turn_continuation_required: true,
    interaction_required: false,
    billable_request_sent: false,
    expected_decision_evidence: {
      source: 'user_message',
      gate,
      decision: ['approve', 'revise', 'reject'],
      quote: 'verbatim excerpt from the current real user message',
    },
    ...(!missing ? { allowed_recovery_ops: [op] } : {}),
    next_action: missing
      ? 'classify_current_reply_then_retry_with_evidence_or_continue_without_gate'
      : 'retry_same_operation_with_structured_decision_evidence',
  };
}

/**
 * No user reply exists in this turn, so the gate cannot be decided here at all.
 * The field set mirrors `E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED` because the
 * required agent behavior is the same: show the current review artifact with a
 * plain decision prompt and end the turn. Retrying in this turn cannot succeed.
 */
function missingUserTurnGateResult(
  op: VideoStudioOp,
  gate: VideoStudioApprovalGate,
): Record<string, unknown> {
  return {
    ok: false,
    op,
    errorCode: 'E_GATE_USER_TURN_REQUIRED',
    message: 'This turn was started by another actor and carries no user reply, so it cannot authorize this gate. Show the current review artifact with one plain decision prompt and end the turn; the decision has to arrive in a later real user turn. Do not open a form or retry this operation in the current turn.',
    gate,
    current_user_message_available: false,
    requires_user_decision: true,
    user_reconfirmation_required: false,
    automatic_recovery_expected: false,
    same_turn_continuation_required: false,
    interaction_required: true,
    interaction_mode: 'request_gate_decision',
    form_policy: 'plain_message_no_form',
    next_step_owner: 'user',
    billable_request_sent: false,
    next_action: 'show_current_artifact_and_request_user_decision',
  };
}

/**
 * Ops whose behavior depends on skill-side protocol knowledge (gate decisions,
 * evidence shapes, review verdicts). A skill generation that predates the host
 * contract loops on these instead of failing visibly, so they are refused
 * explicitly on a detected mismatch. Read/QA/render ops keep working — the
 * degraded mode is "produce and show, but no gate decisions".
 */
const CONTRACT_SENSITIVE_OPS = new Set<string>([
  'composition.approve_plan',
  'composition.approve_draft',
  'composition.submit_design_review',
  'composition.materialize_narration',
  'production.approve_plan',
  'production.approve_generation',
  'production.segment_qa',
]);

function videoStudioContractMismatchResult(
  op: string,
  check: Extract<VideoStudioContractCheck, { compatible: false }>,
): ToolResult {
  const skillOutdated = check.direction === 'skill_outdated';
  return {
    content: resultContent({
      ok: false,
      op,
      errorCode: skillOutdated ? 'E_VIDEO_STUDIO_SKILL_OUTDATED' : 'E_VIDEO_STUDIO_HOST_OUTDATED',
      message: skillOutdated
        ? 'The installed VideoStudio agent predates the video production protocol this app implements, so gate and review operations cannot proceed reliably. Do not retry this operation. Tell the user, in their language, that the video agent component is out of date: restarting the app repairs it automatically, and reinstalling VideoStudio from the marketplace also fixes it. Then end the turn.'
        : 'The installed VideoStudio agent declares a newer video production protocol than this app implements. Do not retry this operation. Tell the user, in their language, to update the app to use this agent version, then end the turn.',
      host_contract: VIDEO_STUDIO_TOOL_CONTRACT,
      declared_contract: check.declared_contract,
      installed_agent_version: check.installed_version,
      min_compatible_agent_version: VIDEO_STUDIO_MIN_COMPATIBLE_AGENT_VERSION,
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: false,
      same_turn_continuation_required: false,
      next_step_owner: 'user',
      interaction_required: true,
      billable_request_sent: false,
      next_action: 'inform_user_component_update_needed_and_end_turn',
    }),
    isError: true,
  } as ToolResult;
}

const VIDEO_STUDIO_REPEATED_FAILURE_LIMIT = 3;

function videoStudioCallArgsHash(input: Record<string, unknown>): string {
  // Top-level key order normalized; identical args means the model resent the
  // same call payload.
  const normalized = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function videoStudioFailureClass(content: string): {
  code: string;
  freshEvidence: boolean;
  candidateIdentity?: string;
  billableRequestSent?: boolean;
  requestDisposition?: unknown;
  chargeStatus?: unknown;
} {
  const text = content.split('\n\n<file-renamed>')[0];
  const direct = /^([A-Z][A-Z0-9_]+):/.exec(text.trim());
  if (direct) return { code: direct[1], freshEvidence: false };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const narrationFit = parsed.narration_fit && typeof parsed.narration_fit === 'object'
      ? parsed.narration_fit as Record<string, unknown>
      : undefined;
    const candidatePayload = {
      request_signature: parsed.request_signature,
      text_sha256: parsed.narration_text_sha256 || narrationFit?.text_sha256,
      plan_signature: parsed.plan_signature || narrationFit?.plan_signature,
      target_duration_sec: parsed.target_duration_sec || narrationFit?.target_duration_sec,
      min_duration_sec: parsed.min_duration_sec || narrationFit?.min_duration_sec,
      max_duration_sec: parsed.max_duration_sec || narrationFit?.max_duration_sec,
    };
    const candidateIdentity = Object.values(candidatePayload).some((value) => value !== undefined)
      ? crypto.createHash('sha256').update(JSON.stringify(candidatePayload)).digest('hex')
      : undefined;
    const billableRequestSent = typeof parsed.billable_request_sent === 'boolean'
      ? parsed.billable_request_sent
      : undefined;
    return {
      code: typeof parsed?.errorCode === 'string' && parsed.errorCode ? parsed.errorCode : 'E_UNCLASSIFIED',
      // A failure carrying fresh execution evidence means the renderer or
      // inspector actually ran against current inputs. Those ops govern their
      // own repetition (signature-aware E_*_RETRY_NO_CHANGE + repair budgets),
      // and each attempt may follow a real file repair, so the breaker must
      // not count them. The compacted QA-blocked payload replaces the bulky
      // report with video_qa/media_qa sections and an evidence_note stamp;
      // those mark the same executed run.
      freshEvidence: !!(parsed && (
        parsed.report || parsed.preview_qa || parsed.video_qa
        || parsed.media_qa || parsed.findings_path
        || parsed.frame_evidence || parsed.draft_disposition
        || parsed.evidence_note || parsed.measured_duration_sec
        || parsed.narration_fit || billableRequestSent === true
        || parsed.request_disposition === 'sent'
      )),
      ...(candidateIdentity ? { candidateIdentity } : {}),
      ...(billableRequestSent !== undefined ? { billableRequestSent } : {}),
      ...(parsed.request_disposition !== undefined
        ? { requestDisposition: parsed.request_disposition }
        : {}),
      ...(parsed.charge_status !== undefined ? { chargeStatus: parsed.charge_status } : {}),
    };
  } catch {
    return { code: 'E_UNCLASSIFIED', freshEvidence: false };
  }
}

/**
 * Host-side circuit breaker: the loops observed in production were the model
 * resending one failing call unchanged, each failure instructing another
 * retry. A streak is keyed by (arguments, errorCode) — identical arguments
 * can still legitimately progress when the model repaired files with other
 * tools between attempts, and that progress shows up as a different error,
 * fresh execution evidence, or success. Three failures with the same call AND
 * the same validation error mean nothing is changing, so the host — not model
 * obedience — ends the loop and hands the turn to the user. Runs after
 * execution so a repair-then-identical retry that now succeeds is untouched;
 * success clears the call's streaks.
 */
function applyVideoStudioFailureBreaker(
  streaks: Map<string, number>,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolResult {
  const argsHash = videoStudioCallArgsHash(input);
  const original = typeof result.content === 'string' ? result.content : String(result.content ?? '');
  if (!result.isError) {
    for (const key of [...streaks.keys()]) {
      if (key.startsWith(`${argsHash}::`)) streaks.delete(key);
    }
    return result;
  }
  const failureClass = videoStudioFailureClass(original);
  if (failureClass.freshEvidence) return result;
  const key = `${argsHash}::${failureClass.candidateIdentity || 'no-candidate'}::${failureClass.code}`;
  const failures = (streaks.get(key) || 0) + 1;
  streaks.set(key, failures);
  if (failures < VIDEO_STUDIO_REPEATED_FAILURE_LIMIT) return result;
  return {
    content: resultContent({
      ok: false,
      op: String(input.op || ''),
      errorCode: 'E_REPEATED_FAILURE_USER_DECISION_REQUIRED',
      message: `This exact candidate failed ${failures} times in this turn with identical arguments and the same error, so sending it again cannot make progress. Stop retrying. Summarize the blocker in plain language, show the current artifacts, ask the user how to proceed, and end the turn.`,
      identical_failed_attempts: failures,
      original_error_excerpt: original.slice(0, 1500),
      requires_user_decision: true,
      user_reconfirmation_required: false,
      automatic_recovery_expected: false,
      same_turn_continuation_required: false,
      next_step_owner: 'user',
      interaction_required: true,
      billable_request_sent: failureClass.billableRequestSent ?? false,
      ...(failureClass.requestDisposition !== undefined
        ? { request_disposition: failureClass.requestDisposition }
        : {}),
      ...(failureClass.chargeStatus !== undefined
        ? { charge_status: failureClass.chargeStatus }
        : {}),
      next_action: 'present_blocker_to_user_and_end_turn',
    }),
    isError: true,
  } as ToolResult;
}

/** Convert the model-facing VideoStudio outcome into the generic runner
 * boundary contract. The JSON remains the source of truth for the synthesis;
 * this host-only bit only prevents another tool round. */
function applyVideoStudioTurnBoundary(result: ToolResult): ToolResult {
  try {
    const payload = JSON.parse(result.content.split(/\n\n<file-renamed\b/i, 1)[0]) as { outcome?: unknown };
    return payload.outcome === 'need_user'
      ? { ...result, synthesizeAndEndTurn: true }
      : result;
  } catch {
    return result;
  }
}

export function explicitVideoStudioVisualRecoveryDecision(
  message: string | undefined,
  expectedAgentId = VIDEO_STUDIO_AGENT_ID,
): 'new_visual_revision' | 'unknown' {
  const payload = currentUserTurnPayload(message);
  if (!payload || !/<agent-input-submission\b/i.test(payload)) return 'unknown';
  const submission = decodeSubmission(payload);
  if (!submission || submission.agent_id !== expectedAgentId) return 'unknown';
  return submission.values.visual_recovery_decision === 'new_visual_revision'
    ? 'new_visual_revision'
    : 'unknown';
}

/**
 * A Preview/Gate D revise submission is the user authorization for the
 * requested bounded visual edit. Restarting an exhausted, non-billable QA
 * cycle is an internal consequence of that decision and must not create a
 * second recovery-confirmation form.
 */
export function explicitVideoStudioVisualRevisionDecision(
  message: string | undefined,
  expectedAgentId = VIDEO_STUDIO_AGENT_ID,
): 'revise' | 'unknown' {
  const payload = currentUserTurnPayload(message);
  if (!payload) return 'unknown';
  if (/<agent-input-submission\b/i.test(payload)) {
    const submission = decodeSubmission(payload);
    if (!submission || submission.agent_id !== expectedAgentId) return 'unknown';
    for (const [key, value] of Object.entries(submission.values)) {
      if (!APPROVAL_FIELD_RE.test(key) || typeof value !== 'string') continue;
      const hints = approvalKeyGateHints(key);
      if (hints.size !== 1 || (!hints.has('preview') && !hints.has('draft'))) continue;
      const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (REVISION_VALUES.has(normalized)) return 'revise';
    }
    return 'unknown';
  }
  return 'unknown';
}

const DENY_MESSAGE =
  'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so VideoStudio native rendering/transcription was not run.';

export interface VideoStudioToolOpts {
  userId: string;
  cid?: string;
  conversationTitle?: string;
  conversationTitleUpdatedAt?: number;
  turnId?: string;
  userMessage?: string;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  hasProducedPath?: (absPath: string) => boolean;
}

const OPS = new Set<VideoStudioOp>([
  'production.status',
  'production.approve_plan',
  'production.approve_generation',
  'production.segment_qa',
  'composition.status',
  'composition.doctor',
  'composition.reconcile',
  'composition.check_narration_fit',
  'composition.approve_plan',
  'composition.prepare',
  'composition.materialize_narration',
  'composition.lint',
  'composition.inspect',
  'composition.draft',
  'composition.export',
  'composition.snapshot',
  'composition.submit_design_review',
  'composition.approve_draft',
  'speech.capabilities',
  'speech.transcribe',
]);

const PLAN_APPROVAL_REQUIRED_OPS = new Set<VideoStudioOp>([
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

function allowedRoots(opts: VideoStudioToolOpts): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try { push(getWorkspacePath(opts.userId)); }
  catch (err) { log.warn('resolve workspace failed', { error: logErrorSummary(err) }); }
  if (opts.projectId) {
    try { push(getWorkspacePath(opts.userId, opts.projectId)); }
    catch (err) { log.warn('resolve project workspace failed', { error: logErrorSummary(err) }); }
  }
  if (opts.cid) {
    try { push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn('resolve attachment dir failed', { error: logErrorSummary(err) }); }
  }
  for (const root of opts.extraRoots || []) push(root);
  return roots;
}

function isProjectRelativePath(p: string): boolean {
  const first = p.replace(/\\/g, '/').split('/').find(Boolean);
  return first === 'project';
}

function defaultRoot(opts: VideoStudioToolOpts, ctx: ToolContext): string {
  if (ctx.workingDir) return ctx.workingDir;
  try { return getWorkspacePath(opts.userId, opts.projectId); }
  catch { return '.'; }
}

function resolvePath(ctx: ToolContext, opts: VideoStudioToolOpts, raw: string, roots: string[]): string {
  const value = String(raw || '').trim();
  if (path.isAbsolute(value)) return path.resolve(value);
  if (ctx.workingDir && isProjectRelativePath(value)) {
    const candidate = path.resolve(ctx.workingDir, value);
    if (isPathAllowed(candidate, roots)) return candidate;
  }
  return path.resolve(defaultRoot(opts, ctx), value);
}

function withExtension(absPath: string, ext: string): string {
  const wanted = `.${ext.replace(/^\./, '').toLowerCase()}`;
  const current = path.extname(absPath);
  if (current.toLowerCase() === wanted) return absPath;
  return current ? `${absPath.slice(0, -current.length)}${wanted}` : `${absPath}${wanted}`;
}

function videoStudioStateKey(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  const identity = [
    opts.userId,
    path.resolve(compositionDirAbs),
  ].join('\0');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function legacyVideoStudioStateKey(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  const identity = [
    opts.userId,
    opts.projectId || '',
    opts.cid || '',
    path.resolve(compositionDirAbs),
  ].join('\0');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function videoStudioRepairStatePath(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  return path.join(userLocalRoot(opts.userId), 'video_studio', 'draft-repair', `${videoStudioStateKey(opts, compositionDirAbs)}.json`);
}

export function videoStudioSegmentCachePath(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  return path.join(userLocalRoot(opts.userId), 'video_studio', 'segment_cache', videoStudioStateKey(opts, compositionDirAbs));
}

export function videoStudioProductionStatePath(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  // Preserve the original private path so existing gate-only records can be
  // upgraded in place to VideoProductionStateV1 without losing approvals.
  return path.join(userLocalRoot(opts.userId), 'video_studio', 'gates', `${videoStudioStateKey(opts, compositionDirAbs)}.json`);
}

async function migrateConversationScopedVideoStudioState(
  opts: VideoStudioToolOpts,
  compositionDirAbs: string,
): Promise<void> {
  const migrate = async (folder: 'gates' | 'draft-repair') => {
    const folderAbs = path.join(userLocalRoot(opts.userId), 'video_studio', folder);
    const target = path.join(
      folderAbs,
      `${videoStudioStateKey(opts, compositionDirAbs)}.json`,
    );
    if (await fs.stat(target).catch(() => null)) return;
    const candidates: string[] = [];
    if (opts.cid) {
      candidates.push(path.join(folderAbs, `${legacyVideoStudioStateKey(opts, compositionDirAbs)}.json`));
    }
    // A resumed task has a new conversation id, so its legacy hash cannot be
    // reconstructed. Gate ledgers carry composition_dir and can be recovered
    // by artifact identity instead of forcing Gate B to open again.
    if (folder === 'gates') {
      const entries = await fs.readdir(folderAbs, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const candidate = path.join(folderAbs, entry.name);
        if (candidate === target || candidates.includes(candidate)) continue;
        try {
          const value = JSON.parse(await fs.readFile(candidate, 'utf8')) as Record<string, unknown>;
          if (typeof value.composition_dir === 'string'
            && path.resolve(value.composition_dir) === path.resolve(compositionDirAbs)) {
            candidates.push(candidate);
          }
        } catch {
          // Ignore unrelated or corrupt historical ledgers.
        }
      }
    }
    let source = '';
    for (const candidate of candidates) {
      if (await fs.stat(candidate).catch(() => null)) {
        source = candidate;
        break;
      }
    }
    if (!source) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  };
  await Promise.all([migrate('gates'), migrate('draft-repair')]);
}

async function videoStudioRepairSummary(
  opts: VideoStudioToolOpts,
  compositionDirAbs: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(videoStudioRepairStatePath(opts, compositionDirAbs), 'utf8')) as Record<string, unknown>;
    const failedAttempts = Math.max(0, Number(raw.failed_attempts) || 0);
    const maxRepairPasses = Math.max(0, Number(raw.max_repair_passes) || 2);
    const repairPassesUsed = Math.max(0, failedAttempts - 1);
    const lastError = raw.last_error && typeof raw.last_error === 'object' && !Array.isArray(raw.last_error)
      ? raw.last_error as Record<string, unknown>
      : null;
    return {
      status: raw.status === 'failed' ? 'failed' : 'ok',
      failed_attempts: failedAttempts,
      max_repair_passes: maxRepairPasses,
      repair_passes_used: repairPassesUsed,
      repair_passes_remaining: Math.max(0, maxRepairPasses - repairPassesUsed),
      budget_exhausted: failedAttempts > 0 && repairPassesUsed >= maxRepairPasses,
      last_error: lastError ? {
        ...(typeof lastError.error_code === 'string' ? { error_code: lastError.error_code } : {}),
        ...(typeof lastError.message === 'string' ? { message: lastError.message.slice(0, 500) } : {}),
      } : null,
    };
  } catch {
    return { status: 'unused', failed_attempts: 0, repair_passes_used: 0, budget_exhausted: false };
  }
}

export function videoStudioGateStatePath(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  return videoStudioProductionStatePath(opts, compositionDirAbs);
}

type VideoStudioGateEntry = VideoProductionGateEntry;

type VideoStudioGateCheck =
  | { ok: true; entry: VideoStudioGateEntry }
  | {
    ok: false;
    errorCode: string;
    message: string;
    submitted_artifact_signature?: string | null;
    current_artifact_signature?: string;
    submitted_decision_status?: 'superseded' | 'unbound_after_revision' | 'unbound';
  };

function isRuntimeGeneratedCompositionPath(rel: string, isDirectory: boolean): boolean {
  const normalized = rel.replace(/\\/g, '/');
  const topLevel = normalized.split('/')[0] || '';
  if (isDirectory) {
    return normalized === 'assets/narration-history'
      || normalized.startsWith('assets/narration-history/')
      || topLevel === 'qa'
      || topLevel === 'preview'
      || /^(?:preview-)?contact-sheet-frames$/i.test(topLevel)
      || /^(?:draft|final)-evidence(?:$|-)/i.test(topLevel);
  }
  if (normalized.includes('/')) return false;
  return /^(?:preview-)?contact-sheet(?:-[^.]+)?\.(?:png|svg)$/i.test(normalized)
    || /^(?:draft|final)\.(?:mp4|webm)$/i.test(normalized)
    || /^(?:draft|final)-(?:qa-)?report\.json$/i.test(normalized)
    || /^(?:snapshot|draft|final)-findings\.json$/i.test(normalized)
    || /^probe-[^.]+\.(?:js|json|png)$/i.test(normalized)
    || /^\.(?:draft|final)\.rendering-[^.]+\.(?:mp4|webm)$/i.test(normalized);
}

function isRuntimeGeneratedCompositionPathV3(rel: string, isDirectory: boolean): boolean {
  if (isRuntimeGeneratedCompositionPath(rel, isDirectory)) return true;
  const normalized = rel.replace(/\\/g, '/');
  if (isDirectory || normalized.includes('/')) return false;
  return /^(?:draft|final|export)-qa(?:-[^.]+)?\.json$/i.test(normalized);
}

function isRuntimeGeneratedCompositionPathV4(rel: string, isDirectory: boolean): boolean {
  if (isRuntimeGeneratedCompositionPathV3(rel, isDirectory)) return true;
  if (!isDirectory) return false;
  const topLevel = rel.replace(/\\/g, '/').split('/')[0]?.toLowerCase() || '';
  return topLevel === 'previews' || topLevel === 'drafts' || topLevel === 'reports';
}

function isRuntimeGeneratedCompositionPathV5(rel: string, isDirectory: boolean): boolean {
  if (isRuntimeGeneratedCompositionPathV4(rel, isDirectory)) return true;
  if (!isDirectory) return false;
  const topLevel = rel.replace(/\\/g, '/').split('/')[0]?.toLowerCase() || '';
  return topLevel === 'outputs';
}

/** True when a runtime artifact would land inside the authored-input
 *  signature: inside the composition directory but outside the given
 *  signature-excluded subtree. Writing there makes the operation invalidate
 *  its own evidence, because the next signature comparison sees a composition
 *  the operation itself changed. */
function runtimeArtifactInsideSignature(
  artifactAbsPath: string,
  compositionDirAbs: string,
  excludedSubtree: 'preview' | 'qa',
): boolean {
  if (!isWithinDirectory(artifactAbsPath, compositionDirAbs)) return false;
  const rel = path.relative(path.resolve(compositionDirAbs), path.resolve(artifactAbsPath))
    .replace(/\\/g, '/');
  return (rel.split('/')[0] || '').toLowerCase() !== excludedSubtree;
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

async function compositionFiles(
  compositionDirAbs: string,
  signatureVersion: 1 | 2 | 3 | 4 | 5 = 5,
): Promise<string[]> {
  const out: string[] = [];
  const hasCanonicalManifest = !!(await fs.stat(path.join(compositionDirAbs, 'composition-manifest.json')).catch(() => null));
  const visit = async (dirAbs: string): Promise<void> => {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(compositionDirAbs, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (rel === 'qa' || rel === 'preview' || rel.startsWith('qa/') || rel.startsWith('preview/')) continue;
        if (signatureVersion >= 5 && isRuntimeGeneratedCompositionPathV5(rel, true)) continue;
        if (signatureVersion === 4 && isRuntimeGeneratedCompositionPathV4(rel, true)) continue;
        if (signatureVersion === 3 && isRuntimeGeneratedCompositionPathV3(rel, true)) continue;
        if (signatureVersion === 2 && isRuntimeGeneratedCompositionPath(rel, true)) continue;
        await visit(abs);
      } else if (entry.isFile()) {
        if (hasCanonicalManifest && (rel === 'design-contract.json' || rel === 'scene-map.json')) continue;
        if (signatureVersion >= 5 && isRuntimeGeneratedCompositionPathV5(rel, false)) continue;
        if (signatureVersion === 4 && isRuntimeGeneratedCompositionPathV4(rel, false)) continue;
        if (signatureVersion === 3 && isRuntimeGeneratedCompositionPathV3(rel, false)) continue;
        if (signatureVersion === 2 && isRuntimeGeneratedCompositionPath(rel, false)) continue;
        out.push(abs);
      }
    }
  };
  await visit(compositionDirAbs);
  return out;
}

export async function videoStudioCompositionSignature(
  compositionDirAbs: string,
  signatureVersion: 2 | 3 | 4 | 5 = 5,
): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const abs of await compositionFiles(compositionDirAbs, signatureVersion)) {
    const rel = path.relative(compositionDirAbs, abs).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const VISUAL_IDENTITY_EXCLUDED_AUDIO_RE = /\.(?:mp3|wav|m4a|ogg|aac|flac|opus)$/i;

/**
 * Visual sub-identity: the composition hashed through its visual projection —
 * audio files and narration-map excluded, the manifest reduced to visual
 * fields, and the HTML normalized over invisible declarative audio tags.
 * Scene timing remains part of the identity because it changes sampled
 * pixels. A narration re-materialization that fits the existing scene windows
 * leaves this signature unchanged, which lets the preview survive it.
 */
export async function videoStudioVisualCompositionSignature(compositionDirAbs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const abs of await compositionFiles(compositionDirAbs, 5)) {
    const rel = path.relative(compositionDirAbs, abs).replace(/\\/g, '/');
    if (VISUAL_IDENTITY_EXCLUDED_AUDIO_RE.test(rel)) continue;
    if (rel === 'narration-map.json') continue;
    hash.update(rel);
    hash.update('\0');
    if (rel === 'composition-manifest.json') {
      const raw = await fs.readFile(abs, 'utf8').catch((err) => {
        log.warn('visual manifest signature read failed', { error: logErrorSummary(err) });
        throw err;
      });
      let projected = raw;
      try {
        projected = visualProjectionOfCompositionManifest(JSON.parse(raw));
      } catch (err) {
        log.warn('visual manifest signature projection failed', { error: logErrorSummary(err) });
      }
      hash.update(projected);
    } else if (rel === 'index.html') {
      const raw = await fs.readFile(abs, 'utf8').catch((err) => {
        log.warn('visual HTML signature read failed', { error: logErrorSummary(err) });
        throw err;
      });
      hash.update(normalizeCompositionHtmlForVisualIdentity(raw));
    } else {
      hash.update(await fs.readFile(abs));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Single staleness rule for preview entries. Entries carrying a
 * visual_signature stay current while the visual projection matches — the
 * approval-inheritance half of the P1 sub-identity split. Older entries do
 * not prove that sub-identity and therefore fail closed into one new preview.
 */
async function previewStillVisuallyCurrent(
  compositionDirAbs: string,
  entry: VideoProductionGateEntry,
): Promise<boolean> {
  if (!entry.visual_signature) return false;
  return entry.visual_signature === await videoStudioVisualCompositionSignature(compositionDirAbs);
}

/**
 * Remove one stale visual-evidence bundle as a unit. Preview frames, the
 * user's go-ahead for those frames, and their visual QA record all describe
 * the same visual identity; retaining only part of that bundle creates the
 * contradictory "approved but confirm again" state.
 */
function invalidateVisualEvidenceUnlessCurrent(
  state: VideoProductionStateV1,
  currentVisualSignature: string,
): boolean {
  // A go-ahead without the preview identity it authorizes is never usable.
  // Older prepare paths could leave exactly this orphan behind.
  if (!state.preview) {
    const hadOrphan = !!state.preview_go_ahead;
    delete state.preview_go_ahead;
    return hadOrphan;
  }
  if (state.preview.visual_signature
    && state.preview.visual_signature === currentVisualSignature) return false;
  delete state.preview;
  delete state.preview_go_ahead;
  delete state.visual_qa;
  return true;
}

async function legacyVideoStudioCompositionSignature(compositionDirAbs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const abs of await compositionFiles(compositionDirAbs, 1)) {
    const rel = path.relative(compositionDirAbs, abs).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function videoStudioGateSignature(
  compositionDirAbs: string,
  entry: VideoProductionGateEntry,
): Promise<string> {
  if (entry.validation_version >= 5) return videoStudioCompositionSignature(compositionDirAbs, 5);
  if (entry.validation_version === 4) return videoStudioCompositionSignature(compositionDirAbs, 4);
  if (entry.validation_version === 3) return videoStudioCompositionSignature(compositionDirAbs, 3);
  if (entry.validation_version === 2) return videoStudioCompositionSignature(compositionDirAbs, 2);
  return legacyVideoStudioCompositionSignature(compositionDirAbs);
}

async function checkVideoStudioGateSignature(
  compositionDirAbs: string,
  entry: VideoProductionGateEntry,
): Promise<{ matches: boolean; upgradeToV5: boolean }> {
  if (entry.validation_version === 5 || entry.validation_version === 1) {
    return {
      matches: entry.signature === await videoStudioGateSignature(compositionDirAbs, entry),
      upgradeToV5: false,
    };
  }
  const [legacySignature, v5Signature] = await Promise.all([
    videoStudioCompositionSignature(compositionDirAbs, entry.validation_version),
    videoStudioCompositionSignature(compositionDirAbs, 5),
  ]);
  return {
    matches: entry.signature === legacySignature || entry.signature === v5Signature,
    upgradeToV5: entry.signature === legacySignature || entry.signature === v5Signature,
  };
}

async function migrateVideoStudioGateSignatureV5(
  statePath: string,
  kind: 'preview' | 'draft',
  compositionDirAbs: string,
  state: VideoProductionStateV1,
): Promise<VideoProductionStateV1> {
  const entry = state[kind];
  if (!entry || entry.validation_version === 1 || entry.validation_version === 5) return state;
  const check = await checkVideoStudioGateSignature(compositionDirAbs, entry);
  // Upgrade only when the stored signature still exactly matches the current
  // tree under either its original rules or v5. The old exact match proves
  // that no authored input changed while runtime-only paths are reclassified.
  if (!check.matches || !check.upgradeToV5) return state;
  const artifacts = await videoProductionArtifacts(compositionDirAbs);
  try {
    return await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
      const nextEntry = next[kind];
      if (!nextEntry
        || nextEntry.validation_version !== entry.validation_version
        || nextEntry.signature !== entry.signature) {
        throw new Error('E_VIDEO_PRODUCTION_STATE_CONFLICT: gate changed while its signature was being migrated.');
      }
      nextEntry.validation_version = 5;
      nextEntry.signature = artifacts.composition_signature || entry.signature;
      if (kind === 'preview') {
        nextEntry.visual_signature = artifacts.visual_signature;
      }
      next.artifacts = { ...next.artifacts, ...artifacts };
    }, { expectedRevision: state.revision });
  } catch (err) {
    if (!String((err as Error).message || err).includes('E_VIDEO_PRODUCTION_STATE_CONFLICT')) throw err;
    return readVideoProductionState(statePath, compositionDirAbs);
  }
}

async function sha256File(absPath: string): Promise<string | undefined> {
  const content = await fs.readFile(absPath).catch(() => null);
  return content ? crypto.createHash('sha256').update(content).digest('hex') : undefined;
}

async function videoProductionArtifacts(compositionDirAbs: string): Promise<VideoProductionArtifactState> {
  const [manifestSha, htmlSha, compositionSignature, visualSignature] = await Promise.all([
    sha256File(path.join(compositionDirAbs, 'composition-manifest.json')),
    sha256File(path.join(compositionDirAbs, 'index.html')),
    videoStudioCompositionSignature(compositionDirAbs),
    videoStudioVisualCompositionSignature(compositionDirAbs),
  ]);
  return {
    composition_signature: compositionSignature,
    visual_signature: visualSignature,
    ...(manifestSha ? { manifest_sha256: manifestSha } : {}),
    ...(htmlSha ? { html_sha256: htmlSha } : {}),
  };
}

function artifactsShowAuthoredVisuals(
  baseline: VideoProductionArtifactState,
  current: VideoProductionArtifactState,
  currentHtml = '',
): boolean {
  if (baseline.scaffold_visual_signature && current.visual_signature) {
    return baseline.scaffold_visual_signature !== current.visual_signature;
  }
  if (baseline.scaffold_html_sha256 && current.html_sha256) {
    return baseline.scaffold_html_sha256 !== current.html_sha256;
  }
  return !!currentHtml && !currentHtml.includes('ORKAS-GENERATED-SCAFFOLD');
}

function videoStudioRuntimeFingerprint(): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  })).digest('hex');
}

async function existingCandidateFile(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved).catch(() => null);
  return stat?.isFile() ? resolved : undefined;
}

type CandidateSnapshotFileRecord = {
  relative_path: string;
  sha256: string;
  size_bytes: number;
  snapshot_path: string;
};

type CandidateSnapshotManifest = {
  schema_version: 1;
  revision_id: string;
  content_hash: string;
  runtime_fingerprint: string;
  canonical_locators: VideoProductionCandidateLocators;
  frozen_locators: VideoProductionCandidateLocators;
  source_files: CandidateSnapshotFileRecord[];
  created_at: string;
  updated_at: string;
};

async function sha256FileStream(absPath: string): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const stream = createReadStream(absPath);
    stream.on('data', (chunk: Buffer) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({
      sha256: hash.digest('hex'),
      sizeBytes,
    }));
  });
}

async function ensureCandidateBlob(
  videoStudioRoot: string,
  sourcePath: string,
): Promise<{ blobPath: string; sha256: string; sizeBytes: number }> {
  const { sha256, sizeBytes } = await sha256FileStream(sourcePath);
  const blobPath = path.join(videoStudioRoot, 'candidate-blobs', sha256.slice(0, 2), sha256);
  if (!(await fs.stat(blobPath).catch(() => null))) {
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    const tempPath = `${blobPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.copyFile(sourcePath, tempPath);
      await fs.rename(tempPath, blobPath);
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }
  return { blobPath, sha256, sizeBytes };
}

async function materializeCandidateBlob(blobPath: string, snapshotPath: string): Promise<string> {
  if (await fs.stat(snapshotPath).catch(() => null)) return snapshotPath;
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  try {
    await fs.link(blobPath, snapshotPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return snapshotPath;
    await fs.copyFile(blobPath, snapshotPath);
  }
  return snapshotPath;
}

function hashedEvidenceName(sourcePath: string, sha256: string, index?: number): string {
  const parsed = path.parse(sourcePath);
  const prefix = typeof index === 'number' ? `${String(index).padStart(3, '0')}-` : '';
  return `${prefix}${parsed.name}-${sha256.slice(0, 12)}${parsed.ext}`;
}

async function freezeCandidateFile(input: {
  videoStudioRoot: string;
  sourcePath: string;
  snapshotPath: string;
  relativePath: string;
}): Promise<CandidateSnapshotFileRecord> {
  const blob = await ensureCandidateBlob(input.videoStudioRoot, input.sourcePath);
  const snapshotPath = await materializeCandidateBlob(blob.blobPath, input.snapshotPath);
  return {
    relative_path: input.relativePath,
    sha256: blob.sha256,
    size_bytes: blob.sizeBytes,
    snapshot_path: snapshotPath,
  };
}

function snapshotLocatorsFromManifest(value: unknown): VideoProductionCandidateLocators {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const locators = value as VideoProductionCandidateLocators;
  return {
    ...(typeof locators.html_path === 'string' ? { html_path: locators.html_path } : {}),
    ...(typeof locators.manifest_path === 'string' ? { manifest_path: locators.manifest_path } : {}),
    ...(typeof locators.preview_path === 'string' ? { preview_path: locators.preview_path } : {}),
    ...(Array.isArray(locators.frame_paths)
      ? { frame_paths: locators.frame_paths.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof locators.draft_path === 'string' ? { draft_path: locators.draft_path } : {}),
    ...(typeof locators.report_path === 'string' ? { report_path: locators.report_path } : {}),
    ...(typeof locators.findings_path === 'string' ? { findings_path: locators.findings_path } : {}),
  };
}

function mergeCandidateSnapshotLocators(
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

async function materializeVideoProductionCandidateSnapshot(input: {
  statePath: string;
  compositionDirAbs: string;
  contentHash: string;
  runtimeFingerprint: string;
  canonicalLocators: VideoProductionCandidateLocators;
}): Promise<VideoProductionCandidateSnapshot> {
  const stateKey = path.basename(input.statePath, path.extname(input.statePath));
  const videoStudioRoot = path.dirname(path.dirname(input.statePath));
  const rootPath = path.join(videoStudioRoot, 'candidates', stateKey, input.contentHash);
  const manifestPath = path.join(rootPath, 'candidate.json');
  const now = new Date().toISOString();
  const prior = await fs.readFile(manifestPath, 'utf8')
    .then((raw) => JSON.parse(raw) as CandidateSnapshotManifest)
    .catch(() => undefined);

  let sourceFiles = prior?.content_hash === input.contentHash && Array.isArray(prior.source_files)
    ? prior.source_files
    : [];
  if (!sourceFiles.length) {
    sourceFiles = [];
    for (const sourcePath of await compositionFiles(input.compositionDirAbs, 5)) {
      const relativePath = path.relative(input.compositionDirAbs, sourcePath).replace(/\\/g, '/');
      sourceFiles.push(await freezeCandidateFile({
        videoStudioRoot,
        sourcePath,
        snapshotPath: path.join(rootPath, 'source', ...relativePath.split('/')),
        relativePath,
      }));
    }
  }

  const sourceByRelativePath = new Map<string, CandidateSnapshotFileRecord>(
    sourceFiles.map((entry) => [entry.relative_path, entry] as const),
  );
  const frozenLocators = mergeCandidateSnapshotLocators(
    snapshotLocatorsFromManifest(prior?.frozen_locators),
    {
      ...(sourceByRelativePath.get('index.html')
        ? { html_path: sourceByRelativePath.get('index.html')!.snapshot_path }
        : {}),
      ...(sourceByRelativePath.get('composition-manifest.json')
        ? { manifest_path: sourceByRelativePath.get('composition-manifest.json')!.snapshot_path }
        : {}),
    },
  );

  const freezeEvidence = async (
    kind: 'preview' | 'draft' | 'report' | 'findings',
    sourcePath: string | undefined,
  ): Promise<string | undefined> => {
    if (!sourcePath) return undefined;
    const blob = await ensureCandidateBlob(videoStudioRoot, sourcePath);
    return materializeCandidateBlob(
      blob.blobPath,
      path.join(rootPath, 'evidence', kind, hashedEvidenceName(sourcePath, blob.sha256)),
    );
  };
  const [previewPath, draftPath, reportPath, findingsPath] = await Promise.all([
    freezeEvidence('preview', input.canonicalLocators.preview_path),
    freezeEvidence('draft', input.canonicalLocators.draft_path),
    freezeEvidence('report', input.canonicalLocators.report_path),
    freezeEvidence('findings', input.canonicalLocators.findings_path),
  ]);
  const framePaths = (await Promise.all(
    (input.canonicalLocators.frame_paths || []).map(async (sourcePath, index) => {
      const blob = await ensureCandidateBlob(videoStudioRoot, sourcePath);
      return materializeCandidateBlob(
        blob.blobPath,
        path.join(rootPath, 'evidence', 'frames', hashedEvidenceName(sourcePath, blob.sha256, index)),
      );
    }),
  ));
  const mergedFrozenLocators = mergeCandidateSnapshotLocators(frozenLocators, {
    ...(previewPath ? { preview_path: previewPath } : {}),
    ...(framePaths.length ? { frame_paths: framePaths } : {}),
    ...(draftPath ? { draft_path: draftPath } : {}),
    ...(reportPath ? { report_path: reportPath } : {}),
    ...(findingsPath ? { findings_path: findingsPath } : {}),
  });
  const canonicalLocators = mergeCandidateSnapshotLocators(
    snapshotLocatorsFromManifest(prior?.canonical_locators),
    input.canonicalLocators,
  );
  const snapshotManifest: CandidateSnapshotManifest = {
    schema_version: 1,
    revision_id: `candidate-${input.contentHash.slice(0, 16)}`,
    content_hash: input.contentHash,
    runtime_fingerprint: input.runtimeFingerprint,
    canonical_locators: canonicalLocators,
    frozen_locators: mergedFrozenLocators,
    source_files: sourceFiles,
    created_at: prior?.created_at || now,
    updated_at: now,
  };
  await fs.mkdir(rootPath, { recursive: true });
  const tempManifestPath = `${manifestPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempManifestPath, JSON.stringify(snapshotManifest, null, 2), 'utf8');
  await fs.rename(tempManifestPath, manifestPath);
  return {
    root_path: rootPath,
    manifest_path: manifestPath,
    source_file_count: sourceFiles.length,
    source_total_bytes: sourceFiles.reduce((sum, entry) => sum + entry.size_bytes, 0),
    locators: mergedFrozenLocators,
    updated_at: now,
  };
}

async function recordCurrentVideoProductionCandidate(input: {
  statePath: string;
  compositionDirAbs: string;
  op: string;
  result: Record<string, unknown>;
}): Promise<VideoProductionStateV1> {
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const [htmlPath, manifestPath, previewPath, draftPath, reportPath, findingsPath] = await Promise.all([
    existingCandidateFile(path.join(input.compositionDirAbs, 'index.html')),
    existingCandidateFile(path.join(input.compositionDirAbs, 'composition-manifest.json')),
    existingCandidateFile(input.result.contact_sheet || input.result.contact_sheet_path),
    existingCandidateFile(
      input.op === 'composition.draft' || input.op === 'composition.export'
        ? input.result.path
        : undefined,
    ),
    existingCandidateFile(input.result.report_path),
    existingCandidateFile(input.result.findings_path),
  ]);
  const framePaths = (await Promise.all(
    (Array.isArray(input.result.frame_paths) ? input.result.frame_paths : [])
      .map((value) => existingCandidateFile(value)),
  )).filter((value): value is string => !!value);
  const locators: VideoProductionCandidateLocators = {
    ...(htmlPath ? { html_path: htmlPath } : {}),
    ...(manifestPath ? { manifest_path: manifestPath } : {}),
    ...(previewPath ? { preview_path: previewPath } : {}),
    ...(framePaths.length ? { frame_paths: framePaths } : {}),
    ...(draftPath ? { draft_path: draftPath } : {}),
    ...(reportPath ? { report_path: reportPath } : {}),
    ...(findingsPath ? { findings_path: findingsPath } : {}),
  };
  const runtimeFingerprint = videoStudioRuntimeFingerprint();
  const visualSignature = artifacts.composition_signature
    ? await videoStudioVisualCompositionSignature(input.compositionDirAbs).catch((err) => {
      log.warn('candidate visual signature failed', { error: logErrorSummary(err) });
      return '';
    })
    : '';
  const snapshot = artifacts.composition_signature
    ? await materializeVideoProductionCandidateSnapshot({
      statePath: input.statePath,
      compositionDirAbs: input.compositionDirAbs,
      contentHash: artifacts.composition_signature,
      runtimeFingerprint,
      canonicalLocators: locators,
    }).catch((err) => {
      // Candidate identity and recovery state remain useful if private
      // snapshot storage is temporarily unavailable (for example, disk
      // pressure). Do not turn an inspect/render result into a new blocker.
      log.warn('candidate snapshot failed', { error: logErrorSummary(err) });
      return undefined;
    })
    : undefined;
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    recordVideoProductionCandidate(state, {
      contentHash: artifacts.composition_signature || '',
      ...(visualSignature ? { visualSignature } : {}),
      artifacts,
      locators,
      ...(snapshot ? { snapshot } : {}),
      runtimeFingerprint,
      op: input.op,
      ok: input.result.ok === true,
      ...(typeof input.result.errorCode === 'string'
        ? { errorCode: input.result.errorCode }
        : {}),
      ...(Number.isFinite(Number(input.result.blocking_error_count))
        ? { blockingErrorCount: Number(input.result.blocking_error_count) }
        : {}),
    });
  });
}

function candidateRegisteredPaths(candidate: VideoProductionCandidateRevision | undefined): string[] {
  if (!candidate) return [];
  const frozen = candidate.snapshot?.locators;
  return [
    candidate.locators.html_path,
    candidate.locators.manifest_path,
    candidate.locators.preview_path,
    candidate.locators.frame_paths,
    candidate.locators.draft_path,
    candidate.locators.report_path,
    candidate.locators.findings_path,
    candidate.snapshot?.manifest_path,
    frozen?.preview_path,
    frozen?.frame_paths,
    frozen?.draft_path,
    frozen?.report_path,
    frozen?.findings_path,
  ].flat().filter((value): value is string => typeof value === 'string' && !!value);
}

type VideoStudioReviewArtifact = {
  role: 'draft' | 'preview' | 'frame' | 'html' | 'manifest' | 'findings' | 'report'
  | 'script' | 'shotlist' | 'plan_manifest';
  path: string;
  source: 'candidate_snapshot' | 'candidate_canonical' | 'plan_evidence';
  review_status: 'current_approved' | 'current_unapproved' | 'current_input';
};

type VideoStudioReviewPackage = {
  presentation_required: boolean;
  status: 'current_approved' | 'current_unapproved';
  conclusion: {
    outcome: 'quality_not_accepted' | 'blocked';
    error_code: string;
    summary: string;
    next_action: string;
    requires_user_decision: boolean;
    next_step_owner: 'agent' | 'user' | 'external';
    automatic_recovery_expected: boolean;
  };
  user_guidance: {
    what_happened: string;
    what_remains_safe: string;
    what_happens_next: string;
  };
  continuation: {
    recoverable: true;
    terminal: false;
    user_action_required: boolean;
    system_action: string;
    user_options: Array<{
      id: string;
      label: string;
      effect: string;
    }>;
  };
  primary_artifact?: VideoStudioReviewArtifact;
  /** Omitted when the package is not presentable — see deliverReviewPackage. */
  artifacts?: VideoStudioReviewArtifact[];
  visible_artifact_paths?: string[];
};

function reviewUserGuidance(input: {
  errorCode: string;
  result: Record<string, unknown>;
  nextAction: string;
  requiresUserDecision: boolean;
}): VideoStudioReviewPackage['user_guidance'] {
  const approvalStillValid = input.result.approval_still_valid === true
    || (input.result.approval_received === true
      && input.result.user_reconfirmation_required === false);
  const preserved = approvalStillValid
    ? 'The existing production-plan confirmation remains valid, and the current project files are preserved.'
    : 'The current project files and usable production artifacts are preserved.';

  if (/(?:GATE_B|NARRATION_FIT)_ARTIFACT_INVALID|COMPOSITION_MANIFEST_INVALID/.test(input.errorCode)) {
    return {
      what_happened: 'A production-plan file has a formatting or field-validation problem.',
      what_remains_safe: preserved,
      what_happens_next: 'I will repair only the listed fields and check the same plan again now.',
    };
  }
  if (/(?:GATE_B|NARRATION_FIT)_ARTIFACTS_INCOMPLETE/.test(input.errorCode)) {
    return {
      what_happened: 'One of the production-plan files is missing.',
      what_remains_safe: preserved,
      what_happens_next: 'I will restore the missing plan file and check the same plan again now.',
    };
  }
  if (input.errorCode === 'E_GATE_B_REQUIREMENTS_INCOMPLETE') {
    return {
      what_happened: 'Some required production-plan details are incomplete or inconsistent.',
      what_remains_safe: preserved,
      what_happens_next: 'I will correct the listed plan details and rerun the free check now.',
    };
  }
  if (input.errorCode === 'E_GATE_B_NARRATION_FIT_REQUIRED') {
    return {
      what_happened: 'The narration length does not yet match the planned video timing.',
      what_remains_safe: 'The current script, shot list, voice selection, and visual plan are preserved.',
      what_happens_next: 'I will adjust the narration timing and check it again before asking for any review.',
    };
  }
  if (input.errorCode === 'E_DECISION_EVIDENCE_INVALID'
    || input.errorCode === 'E_DECISION_EVIDENCE_REQUIRED') {
    return {
      what_happened: 'I need to correct how I recorded the current reply.',
      what_remains_safe: 'The user reply and the pending review remain available.',
      what_happens_next: 'I will correct the operation input and retry it now; no new confirmation is needed.',
    };
  }
  if (input.errorCode === 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED') {
    return {
      what_happened: 'The submitted reply belongs to an earlier or unbound preview version.',
      what_remains_safe: 'The latest complete preview and its review state are preserved.',
      what_happens_next: 'I will show the latest preview and resume its current review choices without advancing production.',
    };
  }
  // Must precede the generic TTS branch: "not ready yet" invites waiting and
  // retrying, but these speech states require a configuration change first.
  if (input.errorCode === 'E_TTS_USER_DISABLED') {
    return {
      what_happened: 'Orkas · Voice is turned off in Settings, and no other speech provider is available.',
      what_remains_safe: 'The visuals, script, and captions are preserved, and no speech request was sent.',
      what_happens_next: 'I will tell the user to open Settings > Models > Text-to-speech services and enable Orkas · Voice or configure another speech provider; retrying before that change cannot help.',
    };
  }
  if (input.errorCode === 'E_TTS_NOT_CONFIGURED') {
    return {
      what_happened: 'Speech synthesis is not configured on this server, so no narration audio can be produced.',
      what_remains_safe: 'The visuals, script, captions, and the chosen voice are preserved, and the video can still be delivered without narration.',
      what_happens_next: 'I will deliver the current visual result and report that narration needs a server-side speech credential; retrying or changing the voice cannot help.',
    };
  }
  if (/(?:NARRATION_MATERIALIZATION|TTS)/.test(input.errorCode)) {
    return {
      what_happened: 'The narration audio is not ready yet.',
      what_remains_safe: 'The current visuals, script, voice selection, and any usable audio result are preserved.',
      what_happens_next: input.requiresUserDecision
        ? 'I will show the available narration choices so the user can choose the next step.'
        : `I will continue the narration-audio recovery now (${input.nextAction}).`,
    };
  }
  return {
    what_happened: typeof input.result.message === 'string'
      ? input.result.message
      : 'The current production result needs another step.',
    what_remains_safe: 'The current project files and usable production artifacts are preserved.',
    what_happens_next: input.requiresUserDecision
      ? 'I will show the current artifact with concrete choices.'
      : `I will continue with ${input.nextAction} now.`,
  };
}

function currentReviewPackage(input: {
  state: VideoProductionStateV1;
  result: Record<string, unknown>;
  planEvidence?: VideoProductionPlanEvidence;
  /** False when this composition is not a thing the user reviews — an AUTO
   *  child segment, whose frames belong to the assembled production's review.
   *  The presentation payload then has no reader and is omitted. */
  presentable?: boolean;
}): VideoStudioReviewPackage {
  const candidate = input.state.current_candidate;
  const frozenLocators = candidate?.snapshot?.locators;
  // A snapshot may have been created before later evidence (for example the
  // contact sheet) was attached to the same content-addressed candidate.
  // Prefer frozen copies where present, but do not hide newer canonical
  // evidence merely because an earlier partial snapshot exists.
  const locators = {
    ...(candidate?.locators || {}),
    ...(frozenLocators || {}),
  };
  const candidateSource = frozenLocators ? 'candidate_snapshot' : 'candidate_canonical';
  // Preview approval attests visual content: it also covers a candidate whose
  // only drift from the approved one is narration/audio (matching visual
  // signatures). Draft approval stays bound to the exact full content hash.
  const previewApprovalMatchesCandidate = input.state.preview?.status === 'approved'
    && !!candidate?.content_hash
    && (input.state.preview.signature === candidate.content_hash
      || (!!input.state.preview.visual_signature
        && input.state.preview.visual_signature === candidate.visual_signature));
  const draftApprovalMatchesCandidate = input.state.draft?.status === 'approved'
    && !!candidate?.content_hash
    && input.state.draft.signature === candidate.content_hash;
  const previewReviewStatus: VideoStudioReviewArtifact['review_status'] =
    previewApprovalMatchesCandidate ? 'current_approved' : 'current_unapproved';
  const draftReviewStatus: VideoStudioReviewArtifact['review_status'] =
    draftApprovalMatchesCandidate ? 'current_approved' : 'current_unapproved';
  const evidenceReviewStatus = locators.draft_path ? draftReviewStatus : previewReviewStatus;
  const artifacts: VideoStudioReviewArtifact[] = [];
  const seen = new Set<string>();
  const add = (
    role: VideoStudioReviewArtifact['role'],
    value: unknown,
    source: VideoStudioReviewArtifact['source'],
    reviewStatus: VideoStudioReviewArtifact['review_status'],
  ) => {
    if (typeof value !== 'string' || !value) return;
    const normalized = path.resolve(value);
    const key = `${role}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push({
      role,
      path: normalized,
      source,
      review_status: reviewStatus,
    });
  };
  add('draft', locators.draft_path, candidateSource, draftReviewStatus);
  add('preview', locators.preview_path, candidateSource, previewReviewStatus);
  for (const framePath of locators.frame_paths || []) {
    add('frame', framePath, candidateSource, previewReviewStatus);
  }
  add('html', locators.html_path, candidateSource, previewReviewStatus);
  add('manifest', locators.manifest_path, candidateSource, previewReviewStatus);
  add('findings', locators.findings_path, candidateSource, evidenceReviewStatus);
  add('report', locators.report_path, candidateSource, evidenceReviewStatus);

  const observations = input.planEvidence?.observations.filter((item) => item.status !== 'missing') || [];
  if (observations.length) {
    for (const observation of observations) {
      add(
        observation.role === 'manifest' ? 'plan_manifest' : observation.role,
        observation.path,
        'plan_evidence',
        'current_input',
      );
    }
  } else if (input.state.plan_approval?.artifact_records) {
    const records = input.state.plan_approval.artifact_records;
    if (records.script) add('script', records.script.path, 'plan_evidence', 'current_input');
    if (records.shotlist) add('shotlist', records.shotlist.path, 'plan_evidence', 'current_input');
    add('plan_manifest', records.manifest.path, 'plan_evidence', 'current_input');
  }

  const errorCode = typeof input.result.errorCode === 'string'
    ? input.result.errorCode
    : typeof input.result.conclusion_code === 'string'
      ? input.result.conclusion_code
      : '';
  const planRelated = /(?:GATE_B|PLAN|NARRATION_FIT)/.test(errorCode);
  const primaryArtifact = planRelated
    ? artifacts.find((item) => item.role === 'script')
      || artifacts.find((item) => item.source === 'plan_evidence')
    : artifacts.find((item) => item.role === 'draft')
      || artifacts.find((item) => item.role === 'preview')
      || artifacts.find((item) => item.role === 'frame')
      || artifacts.find((item) => item.role === 'html')
      || artifacts.find((item) => item.source === 'plan_evidence');
  const diagnosticPaths = artifacts
    .filter((item) => item.role === 'findings' || item.role === 'report')
    .map((item) => item.path);
  const planPaths = planRelated
    ? artifacts.filter((item) => item.source === 'plan_evidence').map((item) => item.path)
    : [];
  const visibleArtifactPaths = [...new Set([
    primaryArtifact?.path,
    ...diagnosticPaths,
    ...planPaths,
  ].filter((value): value is string => !!value))];
  const requestedNextAction = typeof input.result.next_action === 'string'
    ? input.result.next_action
    : Array.isArray(input.result.next_allowed_ops)
      ? input.result.next_allowed_ops.map(String).join(' → ')
      : Array.isArray(input.result.allowed_recovery_ops)
        ? input.result.allowed_recovery_ops.map(String).join(' → ')
        : '';
  const nextAction = requestedNextAction || (planRelated
    ? 'inspect_plan_evidence_and_repair_current_artifacts'
    : 'inspect_current_candidate_and_continue_recovery');
  const packageStatus = primaryArtifact?.review_status === 'current_approved'
    ? 'current_approved'
    : 'current_unapproved';
  const requiresUserDecision = input.result.requires_user_decision === true;
  const explicitNextStepOwner = input.result.next_step_owner === 'agent'
    || input.result.next_step_owner === 'user'
    || input.result.next_step_owner === 'external'
    ? input.result.next_step_owner
    : undefined;
  const automaticRecoveryExpected = typeof input.result.automatic_recovery_expected === 'boolean'
    ? input.result.automatic_recovery_expected
    : !requiresUserDecision;
  const nextStepOwner = explicitNextStepOwner
    || (requiresUserDecision ? 'user' : automaticRecoveryExpected ? 'agent' : 'external');
  const userGuidance = reviewUserGuidance({
    errorCode,
    result: input.result,
    nextAction,
    requiresUserDecision,
  });
  const resultOptions = Array.isArray(input.result.user_options)
    ? input.result.user_options.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const option = item as Record<string, unknown>;
      if (typeof option.label !== 'string' || typeof option.effect !== 'string') return [];
      return [{
        id: typeof option.id === 'string' ? option.id : `option_${index + 1}`,
        label: option.label,
        effect: option.effect,
      }];
    })
    : [];
  return {
    presentation_required: input.presentable !== false,
    status: packageStatus,
    conclusion: {
      outcome: /(?:QA|QUALITY|INSPECT|REPAIR|REVIEW|RENDER|PREFLIGHT|DRAFT)/.test(errorCode)
        ? 'quality_not_accepted'
        : 'blocked',
      error_code: errorCode,
      summary: userGuidance.what_happened,
      next_action: nextAction,
      requires_user_decision: requiresUserDecision,
      next_step_owner: nextStepOwner,
      automatic_recovery_expected: nextStepOwner === 'agent' && automaticRecoveryExpected,
    },
    user_guidance: userGuidance,
    continuation: {
      recoverable: true,
      terminal: false,
      user_action_required: requiresUserDecision,
      system_action: requiresUserDecision
        ? 'Present the current artifact and the concrete choices below; continue from the user’s natural-language decision.'
        : nextStepOwner === 'external'
          ? 'Present the preserved artifact and the external-state boundary; do not claim that an automatic retry is running.'
        : `Run ${nextAction} and continue recovery in the same turn; do not end with a diagnosis-only response.`,
      user_options: requiresUserDecision
        ? resultOptions.length
          ? resultOptions
          : [{
            id: 'describe_change',
            label: 'Tell me what you want changed',
            effect: 'The current artifacts stay preserved while the requested change is applied.',
          }]
        : [],
    },
    ...(primaryArtifact ? { primary_artifact: primaryArtifact } : {}),
    artifacts,
    visible_artifact_paths: visibleArtifactPaths,
  };
}

async function deliverReviewPackage(input: {
  opts: VideoStudioToolOpts;
  state: VideoProductionStateV1;
  result: Record<string, unknown>;
  planEvidence?: VideoProductionPlanEvidence;
  presentable?: boolean;
}): Promise<VideoStudioReviewPackage> {
  const reviewPackage = currentReviewPackage(input);
  const presentationSuppressed = input.result.presentation_required === false;
  if (!presentationSuppressed) {
    await notifyWritten(input.opts, candidateRegisteredPaths(input.state.current_candidate));
    // Publishing is how the frames become visible at all, so it runs even when
    // the returned package omits the listing: an AUTO child's frames still
    // belong in the parent's production review.
    await publishVisibleOutputs(input.opts, reviewPackage.visible_artifact_paths);
  }
  if (input.presentable === false || presentationSuppressed) {
    // The artifact listing exists to be shown, and this composition is not one
    // the user reviews, so it has no reader and costs the message it rides: on
    // 2026-08-09 seven E_SEGMENT_HAS_NO_USER_GATE refusals — whose own text is
    // "do not ask the user about a single segment" — each carried a full
    // presentation package, 65% of 48,237 characters across one round. All
    // seven spilled, so the sentence telling the model to keep going arrived
    // as a search ref.
    const {
      primary_artifact: _primaryArtifact,
      artifacts: _artifacts,
      visible_artifact_paths: _visibleArtifactPaths,
      ...withoutPresentation
    } = reviewPackage;
    return { ...withoutPresentation, presentation_required: false };
  }
  return reviewPackage;
}

async function reviewToolResult(input: {
  opts: VideoStudioToolOpts;
  state: VideoProductionStateV1;
  result: Record<string, unknown>;
  planEvidence?: VideoProductionPlanEvidence;
  isError?: boolean;
  presentable?: boolean;
}): Promise<ToolResult> {
  const reviewPackage = await deliverReviewPackage(input);
  const nextStepOwner = input.result.next_step_owner === 'user'
    || input.result.next_step_owner === 'agent'
    || input.result.next_step_owner === 'external'
    ? input.result.next_step_owner
    : reviewPackage.conclusion.next_step_owner;
  const interactionRequired = nextStepOwner === 'user';
  const approvalStillValid = input.result.approval_still_valid === true
    || (input.result.approval_received === true
      && input.result.user_reconfirmation_required === false);
  const nextAction = typeof input.result.next_action === 'string'
    ? input.result.next_action
    : reviewPackage.conclusion.next_action;
  return {
    content: resultContent({
      ...input.result,
      next_step_owner: nextStepOwner,
      interaction_required: interactionRequired,
      automatic_recovery_expected: nextStepOwner === 'agent'
        && input.result.automatic_recovery_expected !== false,
      same_turn_continuation_required: nextStepOwner === 'agent',
      ...(approvalStillValid ? { approval_still_valid: true } : {}),
      execution: {
        next_action: nextAction,
        next_step_owner: nextStepOwner,
        continue_in_current_turn: nextStepOwner === 'agent',
        interaction_required: interactionRequired,
        requires_concrete_mutation_before_retry: nextStepOwner === 'agent'
          && /(?:repair|restore|revise|edit|apply)/i.test(nextAction),
      },
      user_guidance: reviewPackage.user_guidance,
      review_package: reviewPackage,
    }),
    isError: input.isError ?? input.result.ok === false,
  } as ToolResult;
}

function sameVideoProductionArtifacts(
  a: VideoProductionArtifactState | undefined,
  b: VideoProductionArtifactState | undefined,
): boolean {
  return !!a && !!b
    && a.composition_signature === b.composition_signature
    && a.manifest_sha256 === b.manifest_sha256
    && a.html_sha256 === b.html_sha256;
}

const MAX_PRESERVED_PLAN_APPROVALS = 10;

function preservePlanApproval(
  state: VideoProductionStateV1,
  approval: VideoProductionPlanApproval | undefined = state.plan_approval,
): void {
  if (!approval) return;
  const prior = Array.isArray(state.plan_approval_history) ? state.plan_approval_history : [];
  state.plan_approval_history = [
    ...prior.filter((entry) => entry.signature !== approval.signature),
    approval,
  ].slice(-MAX_PRESERVED_PLAN_APPROVALS);
}

function setCurrentPlanApproval(
  state: VideoProductionStateV1,
  approval: VideoProductionPlanApproval,
): void {
  if (state.plan_approval && state.plan_approval.signature !== approval.signature) {
    preservePlanApproval(state, state.plan_approval);
  }
  // Being a segment of a parent EDL is structural identity, not part of any
  // one approval: a child whose plan approval is re-signed without resolving
  // the parent again (direct approve_plan, amendment, reconcile restore) is
  // still the same segment of the same plan. Dropping the linkage here is
  // what scattered an assembled production into standalone rows in the
  // review panel (2026-08-06: 4 of 6 segments lost it mid-run). Carry the
  // structural fields; inherited_from_signature/inherited_at stay with the
  // approval that actually inherited, so they are deliberately not carried.
  const prior = state.plan_approval;
  if (prior?.inheritance_reason === 'parent_edl_segment'
    && !approval.inheritance_reason
    && typeof prior.parent_plan_path === 'string'
    && typeof prior.parent_segment_id === 'string') {
    approval = {
      ...approval,
      inheritance_reason: 'parent_edl_segment',
      parent_plan_path: prior.parent_plan_path,
      parent_segment_id: prior.parent_segment_id,
    };
  }
  state.plan_approval = approval;
  delete state.plan_review_candidate;
  state.plan_approval_history = (state.plan_approval_history || [])
    .filter((entry) => entry.signature !== approval.signature)
    .slice(-MAX_PRESERVED_PLAN_APPROVALS);
}

function planApprovalMatchesIdentity(
  approval: VideoProductionPlanApproval | undefined,
  identity: VideoProductionPlanIdentityResult,
): boolean {
  if (!approval) return false;
  if (approval.signature === identity.signature) return true;
  // Re-project stored snapshots through the current approval contract. This
  // migrates legacy runtime/catalog metadata without reopening Gate B while
  // retaining fail-closed behavior for unknown or creative fields.
  if (approval.intent_snapshot && identity.intentPayload) {
    if (stableJson(canonicalApprovedPlanIntentSnapshot(approval.intent_snapshot))
      === stableJson(canonicalApprovedPlanIntentSnapshot(identity.intentPayload))) {
      return true;
    }
  }
  // The pre-content-addressing byte hash is gone with the files it hashed:
  // it was defined over script.md + shotlist.json + the manifest payload, and
  // two of those three are no longer read. Approvals recorded by clients that
  // old re-sign once; every approval since carries an intent snapshot, which
  // the re-projection above migrates for free.
  return false;
}

function contentAddressedPlanApproval(
  approval: VideoProductionPlanApproval,
  identity: VideoProductionPlanIdentityResult,
): VideoProductionPlanApproval {
  return {
    ...approval,
    signature: identity.signature,
    identity_kind: 'approved_intent_sha256',
    ...(identity.intentPayload ? { intent_snapshot: identity.intentPayload } : {}),
    ...(identity.artifactRecords ? { artifact_records: identity.artifactRecords } : {}),
    artifact_paths: identity.artifactPaths,
    validation_version: 3,
  };
}

async function enforceNarrationProductionInvariant(input: {
  statePath: string;
  compositionDirAbs: string;
  state: VideoProductionStateV1;
  identity: CompositionNarrationIdentity;
  turnId?: string;
}): Promise<VideoProductionStateV1> {
  const facts = narrationPolicyFacts(input.state, input.identity);
  if (!facts.narrationRequired
    || facts.narrationMaterialized) {
    return input.state;
  }
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const alreadyRecorded = input.state.blocked_operation?.error_code === 'E_NARRATION_MATERIALIZATION_REQUIRED'
    && sameVideoProductionArtifacts(input.state.blocked_operation.artifacts, artifacts)
    && !input.state.draft;
  if (alreadyRecorded) return input.state;
  const hasScaffold = !!(await fs.stat(path.join(input.compositionDirAbs, 'index.html')).catch(() => null));
  try {
    return await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      delete next.draft;
      // `stage` is retained only as a compatibility projection for older
      // clients. Runtime admission below is based on canonical facts.
      if (next.plan_approval) next.stage = hasScaffold ? 'scaffold_ready' : 'manifest_ready';
      next.blocked_operation = {
        op: 'composition.materialize_narration',
        error_code: 'E_NARRATION_MATERIALIZATION_REQUIRED',
        message: 'Required standalone narration is missing. Draft/final completion remains unavailable until narration is recovered, but visual preview, editing, and visual QA evidence remain available without another production-plan confirmation.',
        artifacts,
        created_at: new Date().toISOString(),
      };
      recordVideoProductionTransition(next, {
        op: 'recover_narration_invariant',
        status: 'passed',
        turnId: input.turnId,
        stage: next.stage,
      });
    }, { expectedRevision: input.state.revision });
  } catch (err) {
    if (!String((err as Error).message || err).includes('E_VIDEO_PRODUCTION_STATE_CONFLICT')) throw err;
    return readVideoProductionState(input.statePath, input.compositionDirAbs);
  }
}

async function summarizeCompositionProductionState(
  state: VideoProductionStateV1,
  compositionDirAbs: string,
): Promise<Record<string, unknown>> {
  const identity = await currentNarrationIdentity(compositionDirAbs);
  return summarizeVideoProductionState(state, narrationPolicyFacts(state, identity));
}

type VisualQaOp = 'composition.inspect' | 'composition.snapshot';

type VisualQaKey = 'inspect' | 'snapshot';

function visualQaStateKey(op: VisualQaOp): VisualQaKey {
  return op === 'composition.inspect' ? 'inspect' : 'snapshot';
}

function visualQaFailedSignatures(attempt: VideoProductionVisualQaAttempt | undefined): string[] {
  return Array.isArray(attempt?.failed_signatures)
    ? attempt.failed_signatures.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
}

function legacyVisualQaCycle(state: VideoProductionVisualQaState | undefined): VideoProductionVisualQaCycle | undefined {
  if (!state) return undefined;
  if (state.cycle) return state.cycle;
  const failedSignatures = [...new Set([
    ...visualQaFailedSignatures(state.inspect),
    ...visualQaFailedSignatures(state.snapshot),
  ])];
  const last = [state.inspect, state.snapshot]
    .filter((attempt): attempt is VideoProductionVisualQaAttempt => !!attempt)
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .at(-1);
  if (!last && failedSignatures.length === 0) return undefined;
  const updatedAt = last?.updated_at || new Date(0).toISOString();
  return {
    inspector_version: 1,
    cycle_id: 'legacy-per-operation-ledger',
    visual_revision: 0,
    status: failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1
      ? 'exhausted'
      : (state.snapshot?.status === 'passed' ? 'passed' : 'active'),
    max_repair_passes: VISUAL_QA_MAX_REPAIR_PASSES,
    failed_signatures: failedSignatures,
    passed_signatures: {
      ...(state.inspect?.status === 'passed' ? { inspect: state.inspect.last_signature } : {}),
      ...(state.snapshot?.status === 'passed' ? { snapshot: state.snapshot.last_signature } : {}),
    },
    ...(last?.last_signature ? { last_signature: last.last_signature } : {}),
    ...(last?.last_error_code ? { last_error_code: last.last_error_code } : {}),
    started_at: updatedAt,
    updated_at: updatedAt,
  };
}

function currentVisualQaCycle(state: VideoProductionVisualQaState | undefined): VideoProductionVisualQaCycle | undefined {
  const cycle = state?.cycle;
  return cycle?.inspector_version === VIDEO_STUDIO_INSPECTOR_VERSION ? cycle : undefined;
}

function visualQaHistoryWithCurrent(state: VideoProductionVisualQaState | undefined): VideoProductionVisualQaCycle[] {
  const history = Array.isArray(state?.history) ? state.history : [];
  const current = legacyVisualQaCycle(state);
  if (!current) return history.slice(-9);
  const withoutDuplicate = history.filter((cycle) => cycle.cycle_id !== current.cycle_id);
  return [...withoutDuplicate, current].slice(-10);
}

function nextVisualRevision(state: VideoProductionVisualQaState | undefined): number {
  const revisions = [
    state?.cycle?.visual_revision || 0,
    ...(state?.history || []).map((cycle) => cycle.visual_revision || 0),
  ];
  return Math.max(0, ...revisions) + 1;
}

function newVisualQaCycle(input: { visualRevision: number; turnId?: string }): VideoProductionVisualQaCycle {
  const now = new Date().toISOString();
  return {
    inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
    cycle_id: crypto.randomUUID(),
    visual_revision: input.visualRevision,
    status: 'active',
    max_repair_passes: VISUAL_QA_MAX_REPAIR_PASSES,
    failed_signatures: [],
    passed_signatures: {},
    started_at: now,
    ...(input.turnId ? { started_by_turn_id: input.turnId } : {}),
    updated_at: now,
  };
}

function visualQaRepairSummary(cycle: VideoProductionVisualQaCycle | undefined): Record<string, unknown> {
  const failedAttempts = cycle?.failed_signatures.length || 0;
  const used = Math.max(0, failedAttempts - 1);
  return {
    inspector_version: cycle?.inspector_version || VIDEO_STUDIO_INSPECTOR_VERSION,
    cycle_id: cycle?.cycle_id || null,
    visual_revision: cycle?.visual_revision || 0,
    status: cycle?.status || 'unused',
    max_repair_passes: VISUAL_QA_MAX_REPAIR_PASSES,
    failed_attempts: failedAttempts,
    repair_passes_used: used,
    repair_passes_remaining: Math.max(0, VISUAL_QA_MAX_REPAIR_PASSES - used),
    budget_exhausted: failedAttempts > 0 && used >= VISUAL_QA_MAX_REPAIR_PASSES,
  };
}

/** How an exhausted segment sits inside the production it belongs to.
 *
 * A composition that is one segment of an assembled EDL must not stop the other
 * segments when its own repair budget runs out. On 2026-08-04 s1 exhausted at
 * 15:47, the whole video stopped to ask, and the user answered at 17:52 — two
 * hours in which the six untouched segments could have been finished. The user
 * still gets the creative fork; it just travels with the one production review
 * instead of halting production to ask about one scene. */
export async function exhaustedSegmentProductionContext(input: {
  opts: VideoStudioToolOpts;
  state: VideoProductionStateV1;
}): Promise<Record<string, unknown>> {
  const approval = input.state.plan_approval;
  if (!approval
    || approval.inheritance_reason !== 'parent_edl_segment'
    || typeof approval.parent_plan_path !== 'string'
    || typeof approval.parent_segment_id !== 'string'
    || !approval.parent_segment_id) return {};
  // This used to also offer "keep the version you already approved for this
  // scene", built from the last candidate revision that still had frames. It
  // was removed rather than repaired, because all three of its legs were
  // broken: no operation restores a segment from a preserved snapshot (the
  // `snapshot_root` it published had no reader anywhere); a segment of an
  // assembled production never stops on its own frames, so a version the user
  // approved for one scene cannot exist; and the option was keyed
  // `rendered_fallback` at this end and read as `approved_fallback` at the
  // other through a type assertion, so it was never once offered to anyone.
  return {
    production_segment: {
      plan_path: approval.parent_plan_path,
      segment_id: approval.parent_segment_id,
    },
  };
}

async function guardVisualQaAttempt(input: {
  opts: VideoStudioToolOpts;
  statePath: string;
  compositionDirAbs: string;
  op: VisualQaOp;
}): Promise<ToolResult | null> {
  const [state, artifacts] = await Promise.all([
    readVideoProductionState(input.statePath, input.compositionDirAbs),
    videoProductionArtifacts(input.compositionDirAbs),
  ]);
  const signature = artifacts.composition_signature || '';
  const cycle = currentVisualQaCycle(state.visual_qa);
  if (!signature || !cycle) return null;
  const key = visualQaStateKey(input.op);
  const legacyPreviewNeedsRevision = input.op === 'composition.snapshot'
    && (!state.preview?.revision_id || !state.preview.path);
  if (cycle.passed_signatures[key] === signature && !legacyPreviewNeedsRevision) {
    const previewStatus = state.preview?.status;
    return {
      content: resultContent({
        ok: true,
        op: input.op,
        status: 'already_passed',
        reused_result: true,
        message: `${input.op} already passed for this exact composition input signature; the cached QA result was reused.`,
        ...(input.op === 'composition.snapshot' ? {
          preview_ready: true,
          preview_status: previewStatus || 'ready',
          ...(state.preview?.path ? {
            contact_sheet: state.preview.path,
            contact_sheet_path: state.preview.path,
          } : {}),
          ...(state.preview?.revision_id ? { preview_revision: state.preview.revision_id } : {}),
        } : {}),
        next_action: input.op === 'composition.inspect'
          ? 'composition.snapshot'
          : 'composition.draft',
        visual_repair_cycle: visualQaRepairSummary(cycle),
        ...(state.current_candidate ? { current_candidate: state.current_candidate } : {}),
        production_state: summarizeVideoProductionState(state),
      }),
      isError: false,
    };
  }
  const failedSignatures = cycle.failed_signatures;
  const budgetSpent = cycle.status === 'exhausted'
    || failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1;
  // The model writes its next repair before it can learn the budget is gone —
  // the check that would tell it runs at the entry of the call it makes to
  // verify. 2026-08-08: six successful edits, three minutes, then this branch
  // discarded them unmeasured and asked the user to pick between another round
  // and skipping a check while nobody knew whether the edits had already
  // fixed it. Measuring is ~2s of tool time against a user round trip, so an
  // input this cycle has never seen gets one. Consumed only by a failure: if
  // the repair is working, letting it continue is the point.
  const measuresTheFinalRepair = budgetSpent
    && !cycle.final_repair_measured
    && !failedSignatures.includes(signature)
    && cycle.passed_signatures[key] !== signature;
  if (budgetSpent && !measuresTheFinalRepair) {
    // P3b: an exhausted repair budget is a creative fork, not a technical
    // dead end. A production session ground for 17 minutes of invisible
    // internal restarts before hitting this wall; the user — who can redirect
    // the visual approach in one sentence — was never consulted. Show the
    // current candidate evidence and hand them the choice; another internal
    // cycle remains one of the options, never the silent default.
    const segmentContext = await exhaustedSegmentProductionContext({ opts: input.opts, state });
    // Read, not asserted. The removed fallback option survived unreachable for
    // as long as it did because an `as` cast let this end name a key the other
    // end never produced, and the compiler had no opinion about it.
    const rawSegment = segmentContext.production_segment;
    const segment = rawSegment
      && typeof rawSegment === 'object'
      && typeof (rawSegment as { segment_id?: unknown }).segment_id === 'string'
      ? rawSegment as { segment_id: string }
      : undefined;
    return {
      content: resultContent({
        ok: false,
        op: input.op,
        errorCode: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
        message: `The previous visual repair strategies did not resolve the QA findings after ${VISUAL_QA_MAX_REPAIR_PASSES} distinct repair passes.`
          + (segment
            ? ` This is segment "${segment.segment_id}" of an assembled production; every other segment is unaffected and its recorded approvals stand. Keep producing them and raise this with the one production review rather than stopping the whole video for one scene.`
            : '')
          + ' Show the current candidate evidence and the remaining findings in plain language, offer another repair round and skipping the named check among the options, and end the turn. The user reply grants the next cycle automatically; there is no operation that restarts one.',
        visual_revision_recovery_available: false,
        recovery_requires_new_user_revision: true,
        requires_user_decision: true,
        user_reconfirmation_required: false,
        next_step_owner: 'user',
        interaction_required: true,
        automatic_recovery_expected: false,
        same_turn_continuation_required: false,
        billable_request_sent: false,
        user_options: [
          {
            id: 'guide_revision',
            label: 'Describe what to change',
            effect: 'The user redirects the visual approach in their own words; apply it as a bounded revision and restart QA.',
          },
          {
            id: 'simplify_scene',
            label: 'Simplify the failing scene',
            effect: 'Reduce the failing scene to a simpler layout that satisfies the recorded findings, then restart QA.',
          },
          {
            id: 'retry_internal',
            label: 'Try again with a different approach',
            effect: 'The user asks for one more repair round. Their reply grants it: the next cycle starts automatically with a fresh budget, and the strategies already recorded as failed must not be repeated.',
          },
          {
            id: 'waive_findings',
            label: 'Skip the failing check and continue',
            effect: 'The user waives the named QA findings for this video; pass them as waive_qa_findings with their decision evidence and continue production.',
          },
        ],
        allowed_recovery_ops: ['composition.reconcile'],
        // Being a segment is what makes "carry on with the others" right; it
        // never depended on an old revision existing, which is all the removed
        // `blocks_production` measured.
        next_action: segment
          ? 'continue_other_segments_then_present_findings_with_production_review'
          : 'present_findings_and_ask_user_direction',
        preserved_artifacts: ['plan_approval', 'composition_manifest', 'narration'],
        visual_repair_cycle: visualQaRepairSummary(cycle),
        ...segmentContext,
        ...(state.current_candidate ? { current_candidate: state.current_candidate } : {}),
      }),
      isError: true,
    };
  }
  if (failedSignatures.includes(signature)) {
    const code = input.op === 'composition.inspect'
      ? 'E_INSPECT_RETRY_NO_CHANGE'
      : 'E_SNAPSHOT_RETRY_NO_CHANGE';
    return {
      content: resultContent({
        ok: false,
        op: input.op,
        errorCode: code,
        message: `${input.op} already failed for this exact composition input signature. Edit the canonical manifest or visual HTML, then run composition.lint and retry; do not repeat the unchanged probe.`,
        blocked_operation: input.op,
        same_input_retry_allowed: false,
        requires_user_decision: false,
        allowed_recovery_ops: ['composition.reconcile', 'composition.lint', 'composition.inspect'],
        next_action: 'repair_visuals_then_composition.reconcile',
        visual_repair_cycle: visualQaRepairSummary(cycle),
        ...(state.current_candidate ? { current_candidate: state.current_candidate } : {}),
      }),
      isError: true,
    };
  }
  return null;
}

async function recordVisualQaAttempt(input: {
  statePath: string;
  compositionDirAbs: string;
  op: VisualQaOp;
  ok: boolean;
  errorCode?: string;
  turnId?: string;
}): Promise<void> {
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const signature = artifacts.composition_signature || '';
  if (!signature) return;
  const key = visualQaStateKey(input.op);
  const repairableFailure = input.errorCode === 'E_INSPECT_BLOCKED'
    || input.errorCode === 'E_PREVIEW_DESIGN_QA_BLOCKED'
    || input.errorCode === 'E_PREVIEW_QA_BLOCKED';
  if (!input.ok && !repairableFailure) return;
  await updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    const previousVisualQa = state.visual_qa;
    const previousCycle = currentVisualQaCycle(previousVisualQa);
    const cycle = previousCycle
      ? { ...previousCycle, passed_signatures: { ...previousCycle.passed_signatures } }
      : newVisualQaCycle({
        visualRevision: Math.max(1, nextVisualRevision(previousVisualQa) - 1),
      });
    const failedSignatures = input.ok
      ? cycle.failed_signatures
      : [...new Set([...cycle.failed_signatures, signature])].slice(-(VISUAL_QA_MAX_REPAIR_PASSES + 1));
    cycle.failed_signatures = failedSignatures;
    cycle.last_signature = signature;
    cycle.updated_at = new Date().toISOString();
    if (input.ok) {
      cycle.passed_signatures[key] = signature;
      cycle.status = key === 'snapshot' ? 'passed' : 'active';
      delete cycle.last_error_code;
    } else {
      const wasSpent = !!previousCycle
        && (previousCycle.status === 'exhausted'
          || previousCycle.failed_signatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1);
      delete cycle.passed_signatures[key];
      cycle.status = failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1 ? 'exhausted' : 'active';
      // Stamp the turn the budget ran out in. The stop is presented in that
      // turn; only a LATER real user turn is a reply to it, and that reply is
      // what buys the next cycle.
      if (cycle.status === 'exhausted' && input.turnId) cycle.exhausted_by_turn_id = input.turnId;
      if (input.turnId) cycle.last_failure_turn_id = input.turnId;
      // The one post-budget measurement is spent by a failure, not by progress.
      if (wasSpent) cycle.final_repair_measured = true;
      if (input.errorCode) cycle.last_error_code = input.errorCode;
    }
    state.visual_qa = {
      cycle,
      ...(!previousCycle && previousVisualQa ? { history: visualQaHistoryWithCurrent(previousVisualQa) } : previousVisualQa?.history ? { history: previousVisualQa.history } : {}),
    };
  });
}

function canonicalPlanText(value: string): string {
  return value
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line, index, lines) => line || (index > 0 && !!lines[index - 1]))
    .join('\n')
    .trim();
}

function canonicalLegacyManifestPlanPayload(
  manifest: CompositionManifest,
): Record<string, unknown> {
  return {
    schema_version: manifest.schema_version,
    composition: {
      id: manifest.composition.id,
      width: manifest.composition.width,
      height: manifest.composition.height,
      target_duration: manifest.composition.target_duration ?? manifest.composition.duration,
      language: manifest.composition.language || '',
      // Emitted only when declared, so a manifest written before captions
      // moved here projects byte-identically and its approval still matches.
      ...(manifest.composition.caption_mode
        ? { caption_mode: manifest.composition.caption_mode }
        : {}),
    },
    scenes: manifest.scenes.map((scene) => ({
      id: scene.id,
      approved_copy: scene.approved_copy,
      narration_text: scene.narration_text || '',
      narration_refs: scene.narration_text !== undefined && !scene.narration_text.trim()
        ? []
        : scene.narration_refs,
      source_shots: scene.source_shots,
      roles: scene.roles,
    })),
    audio: {
      narration_intent: manifest.audio.narration_intent || null,
    },
  };
}

/**
 * Catalog display names are presentation metadata. Stable route/voice
 * references, language, and speed are the user-approved synthesis intent.
 */
function canonicalNarrationIntentForApproval(
  intent: CompositionManifest['audio']['narration_intent'],
): Record<string, unknown> | null {
  if (!intent) return null;
  return projectVideoApprovalIntent(intent) as Record<string, unknown>;
}

function canonicalApprovedManifestIntentPayload(
  manifest: CompositionManifest,
): Record<string, unknown> {
  const legacy = canonicalLegacyManifestPlanPayload(manifest);
  const { schema_version: _schemaVersion, ...approvedIntent } = legacy;
  return {
    ...approvedIntent,
    audio: {
      narration_intent: canonicalNarrationIntentForApproval(manifest.audio.narration_intent),
    },
  };
}

/** The approved intent IS the manifest.
 *
 * A stored snapshot written before script.md and shotlist.json were retired
 * still carries `script` and `shotlist` keys; both are ignored on both sides
 * of the comparison, so an approval recorded then still matches the same
 * manifest today without a re-signature. Dropping the script also stops a
 * heading, a scene label, or a timing annotation — none of them approved
 * creative intent — from changing the signature and reopening the plan. */
function canonicalApprovedPlanIntentSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = snapshot.manifest;
  return {
    manifest: projectVideoApprovalIntent(
      manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? manifest
        : {},
      { excludeRootKeys: ['schema_version', 'art_direction'] },
    ) as Record<string, unknown>,
  };
}

/**
 * What the user is being asked to approve, handed back with the refusal.
 *
 * Gate B is the one approval that authorizes production, and the refusal used
 * to be a bare sentence saying the user "must explicitly approve the displayed
 * EDL" — while checking nothing about whether anything had been displayed and
 * carrying nothing the model could display. 2026-08-08, measured: the model
 * showed the user two sentences and a file path, and asked them to approve six
 * segments, sixty seconds, and a language they never saw. `gate-control` has
 * always required a locked direction summary plus the plan digest here; this is
 * the host supplying the material for it instead of hoping.
 *
 * Bounded to the fields that decide the video. The full plan stays on disk.
 */
/** The production plan rendered as the text the user decides on.
 *
 * Host-side twin of the stage-plan skill's `summarizeEdl`: same information
 * set (line, per-segment timeline with compose copy, narration voice,
 * captions, cost). It exists because two prose instructions and a ready-made
 * skill payload all failed to make the model show the plan before asking for
 * approval — on 2026-08-08 the user confirmed a production whose entire
 * on-screen description was "制作方案已准备好". The presentation stop returns
 * THIS text, so what the user judges no longer depends on the model choosing
 * to relay it. */
export function renderVideoProductionPlanSummary(plan: Record<string, unknown>): string {
  const lines: string[] = [];
  const promise = isIntentRecord(plan.delivery_promise) ? plan.delivery_promise : {};
  const motionRatio = Number(promise.motion_min_ratio);
  lines.push(
    `Plan: ${plan.aspect || '?'} · ~${plan.total_target_sec || '?'}s · ${plan.language || '?'} · promise=${promise.type || '?'}`
    + (promise.source_required ? ' · source-required' : '')
    + (promise.type === 'compose_led'
      ? ' · HTML-motion=native-QA'
      : Number.isFinite(motionRatio) ? ` · motion≥${Math.round(motionRatio * 100)}%` : ''),
  );
  const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  const describe = (segment: Record<string, unknown>): string => {
    const spec = isIntentRecord(segment.spec) ? segment.spec : {};
    if (segment.source === 'edit') {
      const inSec = Number(spec.in_sec);
      const outSec = Number(spec.out_sec);
      const range = Number.isFinite(inSec) && Number.isFinite(outSec) ? ` [${inSec}–${outSec}s]` : '';
      return `edit ${String(spec.input_id ?? '?')}${range}`;
    }
    if (segment.source === 'generate') {
      return `generate-${spec.media_kind === 'image' ? 'image' : 'video'} "${truncate(String(spec.prompt ?? ''), 56)}"`;
    }
    if (segment.source === 'compose') {
      const binding = isIntentRecord(spec.composition_plan) ? spec.composition_plan : {};
      const scenes = Array.isArray(binding.scenes) ? binding.scenes.filter(isIntentRecord) : [];
      const copy = scenes.flatMap((scene) => (Array.isArray(scene.approved_copy) ? scene.approved_copy.map(String) : []));
      return `compose ${String(spec.kind ?? '?')}${copy.length ? ` — "${truncate(copy.join(' / '), 72)}"` : ''}`;
    }
    if (segment.source === 'provided') return `provided ${String(spec.asset_id ?? '?')}`;
    return String(segment.source ?? '?');
  };
  const segments = Array.isArray(plan.segments) ? plan.segments.filter(isIntentRecord) : [];
  const primary = segments
    .filter((segment) => segment.layer === 'primary')
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  lines.push('Timeline:');
  primary.forEach((segment, index) => {
    lines.push(`  ${index + 1}. [${segment.role}] ${describe(segment)} (~${segment.target_sec ?? '?'}s)`);
    for (const overlay of segments.filter((other) => other.layer !== 'primary' && other.over === segment.id)) {
      lines.push(`       └ ${overlay.layer}: ${describe(overlay)}`);
    }
  });
  const tracks = isIntentRecord(plan.tracks) ? plan.tracks : {};
  const narration = isIntentRecord(tracks.narration) ? tracks.narration : undefined;
  const narrationLines = narration && Array.isArray(narration.segments) ? narration.segments.length : 0;
  if (narration && narrationLines) {
    const synthesis = isIntentRecord(narration.synthesis) ? narration.synthesis : undefined;
    const voice = synthesis
      ? `${synthesis.display_name} (${synthesis.route_ref}) · language=${synthesis.language} · speed=${synthesis.speed}`
      : `legacy:${narration.voice}`;
    lines.push(`Narration: voice=${voice}, ${narrationLines} line(s)`);
    // Windows are authored from the visual beat and the copy is written
    // separately; nothing measures one against the other while the plan is
    // being written, and the plan validator only checks that windows do not
    // overlap. On 2026-08-09 a signed plan gave 54.2s of windows to copy that
    // speaks in 33.5s, and the 20s of slack surfaced only at assembly — where
    // it was filled by slowing the narration audio, which the user heard as
    // wrong pacing and spent three rounds correcting. This summary is what the
    // model reads back and the user approves, so the measurement belongs here,
    // where it is still cheap to retime a window or lengthen a line. It is
    // shown, not enforced: slack can be deliberate, and a fill-ratio threshold
    // cannot tell a padded plan from a sparse one — measured, legitimate short
    // lines fill 0.28–0.41 of their windows while this incident's ran 0.59–0.78.
    const speed = synthesis && Number.isFinite(Number(synthesis.speed)) ? Number(synthesis.speed) : 1;
    const timed = (Array.isArray(narration.segments) ? narration.segments : [])
      .filter(isIntentRecord)
      .map((line) => {
        const text = String(line.text ?? '').trim();
        const target = Number(line.target_sec);
        if (!text || !Number.isFinite(target) || target <= 0) return null;
        return { text, target, speech: estimateNarrationDuration(text, speed).estimatedSec };
      })
      .filter((entry): entry is { text: string; target: number; speech: number } => !!entry);
    if (timed.length) {
      const windowTotal = timed.reduce((sum, entry) => sum + entry.target, 0);
      const speechTotal = timed.reduce((sum, entry) => sum + entry.speech, 0);
      lines.push(`  windows ${windowTotal.toFixed(1)}s · speech ~${speechTotal.toFixed(1)}s`
        + ` · silence ~${Math.max(0, windowTotal - speechTotal).toFixed(1)}s`);
      timed.forEach((entry, index) => {
        if (Math.abs(entry.target - entry.speech) < 1) return;
        lines.push(`    ${index + 1}. ${entry.target}s window · ~${entry.speech.toFixed(1)}s speech`
          + ` — ${truncate(entry.text, 24)}`);
      });
    }
  }
  const music = isIntentRecord(tracks.music) ? tracks.music : undefined;
  if (music && typeof music.path === 'string' && music.path.trim()) {
    lines.push(`Music: ${music.path}${music.duck ? ' · ducked under narration' : ''}`);
  }
  const captions = isIntentRecord(tracks.captions) ? tracks.captions : undefined;
  const captionLines = captions && Array.isArray(captions.lines) ? captions.lines.length : 0;
  if (captions && (captionLines || captions.from)) {
    lines.push(`Captions: ${captionLines ? `${captionLines} line(s)` : `from=${captions.from || '?'}`}${captions.style ? ` · ${captions.style}` : ''}`);
  }
  const cost = isIntentRecord(plan.cost_estimate) ? plan.cost_estimate : {};
  const billable = Number.isFinite(Number(cost.billable_generations)) ? Number(cost.billable_generations) : 0;
  lines.push(`Cost: ${billable} billable generation(s)${cost.note ? ` — ${cost.note}` : ''}`);
  return lines.join('\n');
}

/** The COMPOSE counterpart of the EDL summary above, rendered from the signed
 * manifest: canvas and duration, every scene with its window, on-screen copy
 * and the words it speaks, plus the same narration window-vs-speech accounting.
 *
 * COMPOSE reached Gate B with no rendered plan at all. Its approval refusal
 * said "Show the plan below in their language first — they cannot approve what
 * they have not seen" and attached a digest, so there was nothing below to
 * show; `composition.status` returned no plan text either. Every presentation
 * fix so far landed on the AUTO/EDL path and none of it reached here, which is
 * why the same failure kept coming back: on 2026-08-09 the agent asked for
 * approval with "方案已准备好", the user answered "方案展示一下", and it
 * refused to show anything and asked for approval again — across a whole turn
 * it never called a single status operation, because none of them would have
 * handed it the plan. */
export function renderCompositionPlanSummary(manifest: Record<string, unknown>): string {
  const composition = isIntentRecord(manifest.composition) ? manifest.composition : {};
  const audio = isIntentRecord(manifest.audio) ? manifest.audio : {};
  const intent = isIntentRecord(audio.narration_intent) ? audio.narration_intent : undefined;
  const scenes = (Array.isArray(manifest.scenes) ? manifest.scenes : []).filter(isIntentRecord);
  const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  const lines: string[] = [];
  const width = Number(composition.width);
  const height = Number(composition.height);
  lines.push(
    `Plan: ${Number.isFinite(width) && Number.isFinite(height) ? `${width}x${height}` : '?'}`
    + ` · ~${composition.duration ?? composition.target_duration ?? '?'}s`
    + ` · ${composition.language ?? '?'}`
    + (composition.fps ? ` · ${composition.fps}fps` : ''),
  );
  lines.push('Scenes:');
  scenes.forEach((scene, index) => {
    const copy = (Array.isArray(scene.approved_copy) ? scene.approved_copy : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
    lines.push(`  ${index + 1}. [${scene.id ?? '?'}] ${scene.start ?? '?'}–${Number(scene.start ?? 0) + Number(scene.duration ?? 0)}s`
      + (copy.length ? ` — ${truncate(copy.join(' / '), 72)}` : ''));
    const narrationText = String(scene.narration_text ?? '').trim();
    if (narrationText) lines.push(`       narration: ${truncate(narrationText, 72)}`);
  });
  if (intent) {
    lines.push(`Narration: voice=${intent.display_name} (${intent.route_ref})`
      + ` · language=${intent.language} · speed=${intent.speed}`);
    // Same accounting the EDL summary carries: the windows are authored from
    // the scene beats and the copy is written separately, so the slack that
    // assembly has to fill belongs in front of the person approving it.
    const speed = Number.isFinite(Number(intent.speed)) ? Number(intent.speed) : 1;
    const spoken = scenes
      .map((scene) => {
        const text = String(scene.narration_text ?? '').trim();
        const window = Number(scene.duration);
        if (!text || !Number.isFinite(window) || window <= 0) return null;
        return { window, speech: estimateNarrationDuration(text, speed).estimatedSec };
      })
      .filter((entry): entry is { window: number; speech: number } => !!entry);
    if (spoken.length) {
      const windowTotal = spoken.reduce((sum, entry) => sum + entry.window, 0);
      const speechTotal = spoken.reduce((sum, entry) => sum + entry.speech, 0);
      lines.push(`  windows ${windowTotal.toFixed(1)}s · speech ~${speechTotal.toFixed(1)}s`
        + ` · silence ~${Math.max(0, windowTotal - speechTotal).toFixed(1)}s`);
    }
  } else if (audio.owner === 'none') {
    lines.push('Narration: none');
  }
  return lines.join('\n');
}

/** Every EDL narration line whose text cannot be spoken inside its window,
 * judged with the SAME estimator and tolerance generate_speech applies before
 * a paid request (estimated > target * 1.05). This runs at Gate B because on
 * 2026-08-08 all four narrated lines of an approved plan were over budget and
 * each was discovered one paid-gate refusal at a time, mid-assembly — after
 * the user had approved a script that never fit its own windows. Free: no
 * provider is contacted. */
export function edlNarrationBudgetIssues(plan: Record<string, unknown>): Array<{
  index: number;
  target_sec: number;
  estimated_sec: number;
  current_units: number;
  shorten_to_units: number;
  remove_units: number;
  unit: string;
  text_head: string;
}> {
  const tracks = isIntentRecord(plan.tracks) ? plan.tracks : {};
  const narration = isIntentRecord(tracks.narration) ? tracks.narration : undefined;
  if (!narration) return [];
  const synthesis = isIntentRecord(narration.synthesis) ? narration.synthesis : undefined;
  const speed = synthesis && Number.isFinite(Number(synthesis.speed)) ? Number(synthesis.speed) : 1;
  const segments = Array.isArray(narration.segments) ? narration.segments : [];
  const issues: Array<{ index: number; target_sec: number; estimated_sec: number; current_units: number; shorten_to_units: number; remove_units: number; unit: string; text_head: string }> = [];
  segments.forEach((line, index) => {
    if (!isIntentRecord(line)) return;
    const text = String(line.text ?? '').trim();
    const target = Number(line.target_sec);
    if (!text || !Number.isFinite(target) || target <= 0) return;
    const estimate = estimateNarrationDuration(text, speed);
    if (estimate.estimatedSec <= target * 1.05) return;
    const keepRatio = Math.min(1, target / estimate.estimatedSec);
    const shortenTo = Math.max(1, Math.floor(estimate.units * keepRatio));
    issues.push({
      index,
      target_sec: target,
      estimated_sec: estimate.estimatedSec,
      // Both counts, not just the destination: a mixed CJK/Latin line is
      // exactly what a model cannot measure by eye, so "shorten to 27" made
      // it guess its own length and undershoot every line, every round
      // (2026-08-09: six lines went 12.4s -> 9.9s against an 8s window and
      // were refused again). The host counted them already.
      current_units: estimate.units,
      shorten_to_units: shortenTo,
      remove_units: Math.max(1, estimate.units - shortenTo),
      unit: estimate.unit,
      text_head: text.slice(0, 20),
    });
  });
  return issues;
}

/** Every segment reports produced bytes, so a final artifact is expected to
 * exist and the delivery check has something to check. */
function videoProductionLooksAssembled(plan: Record<string, unknown>): boolean {
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  if (!segments.length) return false;
  return segments.every((segment) => (
    !!segment && typeof segment === 'object' && !Array.isArray(segment)
      && typeof (segment as Record<string, unknown>).produced_path === 'string'
      && !!String((segment as Record<string, unknown>).produced_path).trim()
  ));
}

function videoProductionPlanDigest(plan: unknown): Record<string, unknown> | undefined {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
  const record = plan as Record<string, unknown>;
  const segments = Array.isArray(record.segments) ? record.segments : [];
  const references = Array.isArray(record.references) ? record.references : [];
  const delivery = isIntentRecord(record.delivery_promise) ? record.delivery_promise : {};
  const cost = isIntentRecord(record.cost_estimate) ? record.cost_estimate : {};
  const generateCount = segments.filter((segment) => (
    isIntentRecord(segment) && segment.source === 'generate'
  )).length;
  return {
    aspect: record.aspect,
    duration_sec: record.total_target_sec,
    language: record.language,
    delivery: delivery.type,
    ...(delivery.source_required !== undefined ? { source_required: delivery.source_required } : {}),
    billable_generations: cost.billable_generations ?? generateCount,
    supplied_references: references.slice(0, 6).map((reference) => (
      isIntentRecord(reference)
        ? { id: reference.id, media_type: reference.media_type, roles: reference.roles }
        : reference
    )),
    segments: segments.slice(0, 24).map((segment) => (isIntentRecord(segment)
      ? {
        id: segment.id,
        role: segment.role,
        source: segment.source,
        ...(segment.duration_sec !== undefined ? { duration_sec: segment.duration_sec } : {}),
      }
      : segment)),
    ...(segments.length > 24 ? { segments_omitted: segments.length - 24 } : {}),
  };
}

/** The composition-line counterpart of `videoProductionPlanDigest`. */
/** The rendered plan for a composition directory, or undefined when the
 *  manifest is missing or unreadable. Paired with the digest at every point
 *  that asks the user to approve: the digest says WHICH plan, this says WHAT. */
async function compositionPlanSummaryFor(compositionDirAbs: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8')
    .catch(() => '');
  if (!raw) return undefined;
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { return undefined; }
  if (!isIntentRecord(manifest)) return undefined;
  const summary = renderCompositionPlanSummary(manifest).trim();
  return summary || undefined;
}

async function compositionManifestApprovalDigest(
  compositionDirAbs: string,
): Promise<Record<string, unknown> | undefined> {
  const raw = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8')
    .catch(() => '');
  if (!raw) return undefined;
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { return undefined; }
  if (!isIntentRecord(manifest)) return undefined;
  const composition = isIntentRecord(manifest.composition) ? manifest.composition : {};
  const audio = isIntentRecord(manifest.audio) ? manifest.audio : {};
  const narration = isIntentRecord(audio.narration_intent) ? audio.narration_intent : undefined;
  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  return {
    aspect: composition.width && composition.height
      ? `${composition.width}x${composition.height}`
      : undefined,
    duration_sec: composition.target_duration ?? composition.duration,
    language: composition.language,
    audio: narration
      ? { narrated: true, voice_ref: narration.voice_ref, language: narration.language }
      : { narrated: false },
    scenes: scenes.slice(0, 24).map((scene) => (isIntentRecord(scene)
      ? {
        id: scene.id,
        ...(scene.approved_copy !== undefined ? { approved_copy: scene.approved_copy } : {}),
        ...(scene.narration_text !== undefined ? { narration_text: scene.narration_text } : {}),
      }
      : scene)),
    ...(scenes.length > 24 ? { scenes_omitted: scenes.length - 24 } : {}),
  };
}

const APPROVED_INTENT_CHANGES_REPORTED = 12;

function isIntentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Collect the paths at which two approved-intent projections disagree. */
function collectIntentChanges(
  approved: unknown,
  candidate: unknown,
  prefix: string,
  out: string[],
): void {
  if (out.length >= APPROVED_INTENT_CHANGES_REPORTED) return;
  if (Array.isArray(approved) && Array.isArray(candidate)) {
    // Scenes are addressed by id, not by position: "scenes.cta.narration_text"
    // survives a reorder, and "scenes.3" tells the model to go count.
    const keyOf = (value: unknown, index: number): string => (
      isIntentRecord(value) && typeof value.id === 'string' && value.id ? value.id : String(index)
    );
    const approvedByKey = new Map(approved.map((value, index) => [keyOf(value, index), value]));
    const candidateByKey = new Map(candidate.map((value, index) => [keyOf(value, index), value]));
    for (const [key, value] of candidateByKey) {
      if (!approvedByKey.has(key)) out.push(`${prefix}.${key} (added)`);
      else collectIntentChanges(approvedByKey.get(key), value, `${prefix}.${key}`, out);
    }
    for (const key of approvedByKey.keys()) {
      if (!candidateByKey.has(key)) out.push(`${prefix}.${key} (removed)`);
    }
    return;
  }
  if (isIntentRecord(approved) && isIntentRecord(candidate)) {
    for (const key of [...new Set([...Object.keys(approved), ...Object.keys(candidate)])].sort()) {
      collectIntentChanges(approved[key], candidate[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (stableJson(approved) !== stableJson(candidate)) out.push(prefix);
}

/**
 * What changed in the approved intent since the recorded approval.
 *
 * `plan_approval_current: false` is a boolean over two snapshots the host is
 * holding, and reopening a gate is expensive: it costs the user a round trip
 * and it costs the model a full plan re-presentation, because a bare false
 * gives it nothing smaller to show. 2026-08-08: the user confirmed, the model
 * then rewrote the narration text (its fit estimate moved 48.77s -> 51.21s),
 * that invalidated the approval it had just been given, and it re-presented the
 * whole plan twice without ever knowing it had caused this itself. The diff
 * turns that into "the narration text of two scenes changed" — which the model
 * can either show as a one-line delta or, seeing that it was its own edit,
 * reconsider.
 */
function approvedPlanIntentChanges(
  approval: VideoProductionPlanApproval | undefined,
  identity: VideoProductionPlanIdentityResult,
): string[] {
  if (!approval?.intent_snapshot || !identity.intentPayload) return [];
  const out: string[] = [];
  collectIntentChanges(
    canonicalApprovedPlanIntentSnapshot(approval.intent_snapshot),
    canonicalApprovedPlanIntentSnapshot(identity.intentPayload),
    '',
    out,
  );
  return out;
}

/** Project the diff into a result, omitting it entirely when there is none. */
function intentChangesField(changes: string[]): Record<string, unknown> {
  if (!changes.length) return {};
  const shown = changes.slice(0, APPROVED_INTENT_CHANGES_REPORTED);
  return {
    plan_intent_changes: shown,
    plan_intent_changes_note: `The recorded confirmation covers a different plan: ${shown.join(', ')}`
      + (changes.length > shown.length ? `, and ${changes.length - shown.length} more` : '')
      + '. Confirm only what changed rather than re-presenting the whole plan, and check first whether an edit of your own caused this.',
  };
}

function canonicalPlanPayload(manifest: CompositionManifest): Record<string, unknown> {
  return canonicalApprovedPlanIntentSnapshot({
    manifest: canonicalApprovedManifestIntentPayload(manifest),
  });
}

type VideoProductionPlanArtifactRole = keyof VideoProductionPlanFiles;

type VideoProductionPlanEvidence = {
  observations: Array<{
    role: VideoProductionPlanArtifactRole;
    status: 'matched' | 'relocated' | 'missing' | 'changed' | 'candidate';
    path: string;
    sha256?: string;
  }>;
  conflicts: Array<{
    code: string;
    message: string;
    paths?: string[];
  }>;
  intent_changes?: Array<{
    path: string;
    before: unknown;
    after: unknown;
  }>;
  protected_constraints: string[];
};

type VideoProductionPlanArtifactIssue = {
  role: VideoProductionPlanArtifactRole;
  code: 'empty_file' | 'invalid_json' | 'invalid_object' | 'invalid_manifest';
  path: string;
  message: string;
  details?: Array<{
    path: string;
    message: string;
  }>;
};

type VideoProductionPlanIdentityResult = {
  applicable: boolean;
  complete: boolean;
  /** SHA-256 of the normalized, user-approved intent projection. */
  signature: string;
  intentPayload?: Record<string, unknown>;
  artifactPaths: string[];
  artifactRecords?: VideoProductionPlanFiles;
  requirementIssues: string[];
  artifactIssues?: VideoProductionPlanArtifactIssue[];
  evidence: VideoProductionPlanEvidence;
};

function emptyPlanEvidence(): VideoProductionPlanEvidence {
  return {
    observations: [],
    conflicts: [],
    protected_constraints: [
      'approved_plan_content_must_not_change_without_user_approval',
      'paid_narration_artifacts_must_not_be_overwritten_or_regenerated',
    ],
  };
}

function boundedPlanValidationDetails(error: unknown): Array<{ path: string; message: string }> {
  const issues = error && typeof error === 'object' && Array.isArray(
    (error as { issues?: unknown }).issues,
  )
    ? (error as {
      issues: Array<{ path?: unknown; message?: unknown }>;
    }).issues
    : [];
  if (issues.length > 0) {
    return issues.slice(0, 12).map((issue) => ({
      path: Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.map(String).join('.')
        : '$',
      message: String(issue.message || 'Invalid value').slice(0, 240),
    }));
  }
  const message = error instanceof Error ? error.message : String(error || 'Invalid content');
  return [{ path: '$', message: message.slice(0, 240) }];
}

function planSearchRoots(roots: string[]): string[] {
  const unique = [...new Set(roots.map((value) => path.resolve(value)))];
  return unique.filter((candidate) => !unique.some((other) => (
    other !== candidate && isWithinDirectory(candidate, other)
  )));
}

function compositionPlanIntentSignature(manifest: CompositionManifest): string {
  return crypto.createHash('sha256')
    .update(stableJson(canonicalPlanPayload(manifest)))
    .digest('hex');
}

async function buildVideoProductionPlanIdentity(
  records: VideoProductionPlanFiles,
  evidence: VideoProductionPlanEvidence,
): Promise<VideoProductionPlanIdentityResult> {
  // The manifest is the plan. script.md and shotlist.json are retired as
  // INPUTS: each carried a second copy of something the manifest already
  // states, each needed a reconciliation check to police its copy, and those
  // checks failed twice in one week over differences that were never about
  // the video. The identity below hashes the normalized approved-intent
  // projection of the manifest alone; `records.script`/`records.shotlist`
  // survive only as OPTIONAL fields on `VideoProductionPlanFiles` so
  // approvals recorded before the retirement still deserialize. Their bytes
  // are not read — a readable script is RENDERED from the manifest instead.
  const manifestPath = records.manifest.path;
  const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch(() => '');
  const applicable = !!manifestRaw.trim();
  if (!applicable) {
    return {
      applicable: false,
      complete: false,
      signature: '',
      artifactPaths: [],
      requirementIssues: [],
      artifactIssues: [],
      evidence,
    };
  }
  const artifactIssues: VideoProductionPlanArtifactIssue[] = [];
  const requirementIssues: string[] = [];
  let planPayload = '';
  let intentPayload: Record<string, unknown> | undefined;
  let manifestValid = false;
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(manifestRaw));
    manifestValid = true;
    requirementIssues.push(...validateCompositionManifestSemantics(manifest)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code));
    intentPayload = canonicalPlanPayload(manifest);
    planPayload = stableJson(intentPayload);
  } catch (error) {
    planPayload = manifestRaw;
    artifactIssues.push({
      role: 'manifest',
      code: 'invalid_manifest',
      path: manifestPath,
      message: 'composition-manifest.json does not match the required video-plan structure.',
      details: boundedPlanValidationDetails(error),
    });
  }
  const semanticHash = crypto.createHash('sha256').update(planPayload);
  return {
    applicable,
    complete: manifestValid,
    signature: semanticHash.digest('hex'),
    ...(intentPayload ? { intentPayload } : {}),
    artifactPaths: [manifestPath],
    artifactRecords: records,
    requirementIssues,
    artifactIssues,
    evidence,
  };
}

async function videoProductionPlanIdentity(
  compositionDirAbs: string,
  input: {
    approval?: VideoProductionPlanApproval;
    roots?: string[];
    preferLocal?: boolean;
  } = {},
): Promise<VideoProductionPlanIdentityResult> {
  // One file, one place. Bundle discovery and relocation existed because the
  // plan was spread across script.md and shotlist.json, which a reformat could
  // move or rewrite out from under their recorded hashes — and searching for
  // them is what bound a sibling conversation's files on 2026-08-06
  // (E_GATE_B_ARTIFACT_CONFLICT). The manifest lives at a known path inside the
  // composition it describes, so there is nothing to search for and no second
  // bundle to disagree with.
  const manifestPath = path.join(compositionDirAbs, 'composition-manifest.json');
  const manifestSha = await sha256File(manifestPath);
  const evidence = emptyPlanEvidence();
  const recorded = input.approval?.artifact_records?.manifest;
  evidence.observations.push({
    role: 'manifest',
    status: !manifestSha
      ? 'missing'
      : !recorded
        ? 'candidate'
        : recorded.sha256 === manifestSha ? 'matched' : 'changed',
    path: manifestPath,
    ...(manifestSha ? { sha256: manifestSha } : {}),
  });
  if (!manifestSha) {
    if (recorded) {
      evidence.conflicts.push({
        code: 'recorded_artifact_missing',
        message: 'The approved composition manifest could not be found.',
        paths: [manifestPath],
      });
    }
    return {
      applicable: false,
      complete: false,
      signature: '',
      artifactPaths: [],
      requirementIssues: [],
      artifactIssues: [],
      evidence,
    };
  }
  return buildVideoProductionPlanIdentity(
    { manifest: { path: manifestPath, sha256: manifestSha } },
    evidence,
  );
}

type ParentCompositionBindingCheck =
  | { ok: true; parentSignature: string }
  | { ok: false; errorCode: string; message: string };

/** The one image of the whole video the preview stop leads with.
 *
 * Extracted because it used to live only in the full batch path, and the
 * moment a production becomes ready is exactly the moment that path is not
 * taken: with every segment captured, the batch's default scope (segments
 * with no current frames) is empty, so it early-returns "nothing to check,
 * open the preview review" — and composed no sheet. Measured 2026-08-09: the
 * host never produced one, and the model hand-built its own contact sheet to
 * have something to show. Both exits compose it now. */
async function composeProductionContactSheet(
  opts: VideoStudioToolOpts,
  planPathAbs: string,
  records: Array<{
    fact: { segment_id: string };
    mediaPath?: string;
    statePath?: string;
    compositionDir?: string;
  }>,
): Promise<string> {
  const orderedFrames = await Promise.all(records.map(async (record) => {
    if (record.mediaPath) {
      return { segmentId: record.fact.segment_id, mediaPath: record.mediaPath };
    }
    if (!record.statePath || !record.compositionDir) return null;
    const segmentState = await readVideoProductionState(record.statePath, record.compositionDir)
      .catch(() => null);
    const framePaths = segmentState?.preview?.frame_paths || [];
    return framePaths.length ? { segmentId: record.fact.segment_id, framePaths } : null;
  }));
  const sheet = await writeProductionContactSheet({
    outputDirAbs: path.join(path.dirname(planPathAbs), 'preview'),
    segments: orderedFrames.filter((entry): entry is NonNullable<typeof entry> => !!entry),
  }).catch(() => '');
  if (sheet) await notifyWritten(opts, [sheet]);
  return sheet;
}

/** Run one QA phase across an assembled production's segments in a single call.
 *
 * The per-composition ops are correct but the model issues six or eight of them
 * at once, and each returns the whole durable state again. On 2026-08-05 that
 * fan-out was 1084KB of 1.25MB returned — 87% — and drove six context
 * compactions plus a convergence nudge inside one run. Batching does not save
 * wall clock (the calls already go out in the same second); it saves the
 * context that repeating one production's state N times consumes.
 *
 * Concurrency is preserved deliberately: running the phases serially would make
 * something that currently finishes in one second take N times longer.
 */
async function runProductionSegmentQa(input: {
  opts: VideoStudioToolOpts;
  ctx: ToolContext;
  planPathAbs: string;
  phase: 'lint' | 'inspect' | 'snapshot';
  requestedSegmentIds: string[];
  roots: string[];
  /** Verified user-authorized waiver codes to record on every segment this
   * batch touches before running its phase. */
  waiveQaFindings?: string[];
  waiverQuote?: string;
  /** Per-turn `<phase>::<segmentId>` -> last failed composition signature.
   * Lets an unchanged retry be refused before it pays for a full pass. */
  failedSignatures: Map<string, string>;
}): Promise<Record<string, unknown>> {
  const identity = await readVideoProductionPlanIdentity(input.planPathAbs);
  const statePath = videoProductionControlStatePath({
    userId: input.opts.userId,
    ...(input.opts.projectId ? { projectId: input.opts.projectId } : {}),
    planPath: input.planPathAbs,
  });
  const records = await videoProductionSegmentReviewRecords({
    opts: input.opts,
    planPathAbs: input.planPathAbs,
    identity,
    roots: input.roots,
  });
  const review = videoProductionReviewStatus({
    identity,
    facts: records.map((record) => record.fact),
  });
  // Editing a segment drops it back to uncaptured, so "has no current frames"
  // already IS the set of work that remains. An explicit list overrides it for
  // a targeted re-check.
  const defaultScope = new Set(review.uncaptured_segment_ids);
  const scope = input.requestedSegmentIds.length
    ? input.requestedSegmentIds
    : records.map((record) => record.fact.segment_id).filter((id) => defaultScope.has(id));
  const byId = new Map(records.map((record) => [record.fact.segment_id, record]));
  const runnable = scope.filter((id) => !!byId.get(id)?.compositionDir);
  // A cut or generated clip has no HTML to lint, inspect, or snapshot — it is
  // already the frames a review shows. Naming one is not an error and does not
  // mean the segment is missing; saying "author it first" would send the model
  // to re-produce work that is already done.
  const mediaBackedIds = scope.filter((id) => !!byId.get(id)?.mediaPath);
  const unknownIds = scope.filter((id) => {
    const record = byId.get(id);
    return !record?.compositionDir && !record?.mediaPath;
  });

  if (!runnable.length) {
    // Naming the segments without naming WHERE they go sends the model
    // hunting: on 2026-08-08 this exact message produced a guessed
    // composition_dir, two filesystem searches, then hand-built directories
    // and stub manifests — which the ownership gate then rejected, the same
    // trap the incident before it hit. The host computes this path itself
    // everywhere else; it is a convention the caller cannot infer and that
    // appears in no skill. The derivation instruction rides with it, because
    // the manifest is not the model's to write for a parent segment.
    const planDirPosix = path.posix.dirname(input.planPathAbs.split(path.sep).join('/'));
    const unbound = unknownIds.map((segmentId) => ({
      segment_id: segmentId,
      composition_dir: path.posix.join(planDirPosix, 'compositions', segmentId),
    }));
    const readySheet = input.phase === 'snapshot' && !unknownIds.length && !review.uncaptured_segment_ids.length
      ? await composeProductionContactSheet(input.opts, input.planPathAbs, records)
      : '';
    return {
      ok: unknownIds.length === 0,
      op: 'production.segment_qa',
      phase: input.phase,
      nothing_to_check: unknownIds.length === 0,
      ...(readySheet ? { production_contact_sheet: readySheet } : {}),
      checked_segment_ids: [],
      ...(unknownIds.length ? { unknown_segment_ids: unknownIds, unbound_segments: unbound } : {}),
      ...(mediaBackedIds.length ? { media_backed_segment_ids: mediaBackedIds } : {}),
      segments: [],
      production_review: {
        renderable: review.renderable,
        uncaptured_segment_ids: review.uncaptured_segment_ids,
      },
      message: unknownIds.length
        ? `No composition is bound to segment(s) ${unknownIds.join(', ')}. For each, call composition.approve_plan with `
          + `plan_path=${path.posix.basename(planDirPosix)}/plan.json, its segment_id, and the composition_dir listed in `
          + 'unbound_segments: that inherits the parent Gate B, creates the directory, and derives '
          + 'composition-manifest.json from the signed parent. Do not create the directory or author the manifest by hand; '
          + 'author only index.html afterwards.'
        : mediaBackedIds.length
          ? `Segment(s) ${mediaBackedIds.join(', ')} are produced media, not compositions: their file is the review evidence and needs no QA phase. Nothing else in scope needs re-checking.`
          : 'Every segment is already approved for its current bytes; there is nothing to re-check. Take the production review to the user instead of re-running QA.',
      next_action: unknownIds.length ? 'author_missing_segments' : 'open_production_preview_review',
    };
  }

  // Bounded concurrency: snapshot drives a Chromium capture per segment, and
  // eight at once is a memory risk on an ordinary laptop.
  const limit = input.phase === 'snapshot' ? 3 : 6;
  const results = new Map<string, Record<string, unknown>>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= runnable.length) return;
      const segmentId = runnable[index];
      const record = byId.get(segmentId)!;
      const compositionDirAbs = record.compositionDir!;
      try {
        // The unchanged-probe guard the single-composition path has had all
        // along (E_INSPECT_RETRY_NO_CHANGE / E_SNAPSHOT_RETRY_NO_CHANGE), now
        // on the batched path too. The repeated-failure breaker judges AFTER
        // execution — deliberately, so a repair-then-identical retry still
        // counts — but that means an unchanged retry pays the full pass
        // first. On 2026-08-07 three such rounds each ran QA over four
        // segments before being refused. A segment whose bytes did not move
        // cannot produce a different verdict, so it is skipped here and its
        // siblings still run.
        const signatureKey = `${input.phase}::${segmentId}`;
        const currentSignature = (await videoProductionArtifacts(compositionDirAbs))
          .composition_signature || '';
        if (currentSignature && input.failedSignatures.get(signatureKey) === currentSignature) {
          results.set(segmentId, {
            result: {
              ok: false,
              op: `composition.${input.phase}`,
              errorCode: input.phase === 'snapshot'
                ? 'E_SNAPSHOT_RETRY_NO_CHANGE'
                : input.phase === 'inspect'
                  ? 'E_INSPECT_RETRY_NO_CHANGE'
                  : 'E_LINT_RETRY_NO_CHANGE',
              message: `${input.phase} already failed for this exact composition input signature. Repair this segment's canonical manifest or visual HTML before re-running the phase; an unchanged probe cannot return a different verdict.`,
              same_input_retry_allowed: false,
              blocking_error_count: 0,
            } as unknown as Record<string, unknown>,
          });
          continue;
        }
        // Under `qa/`, which the composition signature excludes. At the top
        // level it did not: every batched phase wrote its findings beside
        // index.html, so running QA changed the very signature that decides
        // whether the composition changed. That silently defeated the
        // unchanged-probe guards and made each pass look like a new candidate.
        const findingsAbsPath = path.join(
          compositionDirAbs,
          'qa',
          `segment-qa-${input.phase}-findings.json`,
        );
        // A waiver is production-wide: the user skipped the check for their
        // video, so every segment this batch touches records it.
        const segmentState = input.waiveQaFindings?.length
          ? await recordQaWaivers({
            statePath: record.statePath!,
            compositionDirAbs,
            codes: input.waiveQaFindings,
            quote: input.waiverQuote || '',
            turnId: input.opts.turnId,
          })
          : await readVideoProductionState(record.statePath!, compositionDirAbs);
        const segmentWaivers = (segmentState.qa_waivers || []).map((waiver) => waiver.code);
        const common = {
          compositionDirAbs,
          findingsAbsPath,
          // The snapshot phase captures frames and therefore needs somewhere to
          // put them. This path never supplied one, so `snapshotComposition`
          // returned E_OUTPUT_REQUIRED on its first line for every segment and
          // the batched snapshot phase could not succeed at all. The model then
          // did what the comment below already records it doing on 2026-08-07:
          // gave up on the batch and re-ran every child through
          // `composition.snapshot` by hand — which is exactly the fan-out
          // batching exists to remove (87% of the bytes returned on 2026-08-05).
          // Observed again in production on 2026-08-08, five segments, five
          // failures, six manual snapshots. Same destination the single-
          // composition path defaults to, inside signature-excluded `preview/`.
          ...(input.phase === 'snapshot'
            ? { snapshotAbsPath: path.join(compositionDirAbs, DEFAULT_SNAPSHOT_OUTPUT_RELATIVE_PATH) }
            : {}),
          // Lint and inspect run the shared preflight too, so the opening
          // determination gates the cover family on every phase.
          isDeliveredOpening: await compositionIsDeliveredOpening(segmentState),
          ...(segmentWaivers.length ? { waivedQaFindings: segmentWaivers } : {}),
          ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
        };
        const result = input.phase === 'lint'
          ? await lintComposition(common)
          : input.phase === 'inspect'
            ? await inspectComposition(common)
            : await snapshotComposition(common);
        // A passing batched snapshot records its segment's preview entry, the
        // same as the single-composition path. Without this the batch produced
        // frames that no segment fact could see: `captured` stayed false,
        // `uncaptured_segment_ids` never emptied, and the production could not
        // reach its preview stop through the batched call the skill tells the
        // model to prefer. On 2026-08-07 the model gave up on it after three
        // rounds and re-ran every child through composition.snapshot by hand.
        if (input.phase === 'snapshot' && result.ok === true && record.statePath && input.opts.turnId) {
          await recordVideoStudioGate(
            record.statePath,
            'preview',
            compositionDirAbs,
            input.opts.turnId,
            result as unknown as Record<string, unknown>,
          ).catch(() => false);
        }
        if (currentSignature) {
          if (result.ok === true) input.failedSignatures.delete(signatureKey);
          else input.failedSignatures.set(signatureKey, currentSignature);
        }
        results.set(segmentId, { result: result as unknown as Record<string, unknown>, findingsAbsPath });
      } catch (err) {
        // One segment throwing is that segment's outcome, never the batch's:
        // the same rule that keeps a failing segment from stopping the
        // production keeps it from hiding its siblings' results.
        results.set(segmentId, {
          error: (err as Error).message || String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, runnable.length) }, () => worker()));

  const after = await videoProductionSegmentReviewRecords({
    opts: input.opts,
    planPathAbs: input.planPathAbs,
    identity,
    roots: input.roots,
  });
  const afterReview = videoProductionReviewStatus({
    identity,
    facts: after.map((record) => record.fact),
  });
  const afterById = new Map(after.map((record) => [record.fact.segment_id, record]));

  const segments = runnable.map((segmentId) => {
    const entry = results.get(segmentId) || {};
    const fact = afterById.get(segmentId)?.fact;
    if (entry.error) {
      return {
        segment_id: segmentId,
        ok: false,
        error_code: 'E_SEGMENT_QA_FAILED',
        message: String(entry.error).slice(0, 500),
      };
    }
    const result = (entry.result || {}) as Record<string, unknown>;
    const ok = result.ok === true;
    // `findings` arrives as a serialized JSON blob, not an array — the old
    // Array.isArray test silently discarded it, so a segment failing three
    // checks reported `error_count: 3` and exactly ONE message: the first
    // issue's. The model repaired that one, re-ran the phase (~2 min across
    // four segments), and met the second. Measured on the 2026-08-07 11:09
    // run: three such rounds, ~8 minutes, to converge on a list the host had
    // complete on the first call. Every blocking issue now travels with the
    // failure, bounded and with its fix hint.
    const parsedFindings = result.findings === undefined
      ? undefined
      : compactFindingsPayload(result.findings);
    const findingsRecord = parsedFindings && typeof parsedFindings === 'object' && !Array.isArray(parsedFindings)
      ? parsedFindings as Record<string, unknown>
      : undefined;
    // Compaction now carries an advisory tail as well, but this row is the
    // segment's BLOCKER list — an advisory entry here would read as something
    // that has to be fixed before the segment can proceed.
    const findingsIssues = (Array.isArray(parsedFindings)
      ? parsedFindings as Record<string, unknown>[]
      : Array.isArray(findingsRecord?.issues)
        ? findingsRecord.issues as Record<string, unknown>[]
        : []).filter((issue) => issue.severity === 'error');
    // The snapshot phase does not produce `findings` at all. Its blockers ride
    // on `inspect_disposition` (already bounded to 12 by the QA layer), so
    // reading only `findings` left every snapshot failure with a count and
    // nothing else: the 2026-08-10 AUTO run got `error_count: 14` with zero
    // issues, then spent a round of partial reads and a grep across five
    // 35–55KB findings files to recover what this row was holding. lint and
    // inspect keep using `findings`; whichever the phase wrote, the blockers
    // travel with the failure.
    const dispositionIssues = findingsIssues.length ? [] : (() => {
      const disposition = result.inspect_disposition;
      const issues = disposition && typeof disposition === 'object' && !Array.isArray(disposition)
        ? (disposition as Record<string, unknown>).blocking_issues
        : undefined;
      return Array.isArray(issues) ? issues as Record<string, unknown>[] : [];
    })();
    const blockingIssues = findingsIssues.length ? findingsIssues : dispositionIssues;
    const errorCount = Number(result.blocking_error_count ?? 0)
      || Number(findingsRecord?.errorCount ?? 0)
      || blockingIssues.length;
    return {
      segment_id: segmentId,
      ok,
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
      error_count: errorCount,
      warning_count: Number(findingsRecord?.warningCount ?? 0),
      ...(fact ? { visual_signature: fact.visual_signature, captured: fact.captured } : {}),
      // Advertise the findings file only when the phase actually wrote one.
      // Every writer stamps `findings_path` onto its own result as it writes,
      // so this is the fact rather than the intent: reporting the intended
      // path unconditionally is what sent the model to a nonexistent file
      // twice on 2026-08-07.
      ...(typeof result.findings_path === 'string' && result.findings_path
        ? { findings_path: result.findings_path }
        : {}),
      // Repair material and the reviewable candidate ride only with a failure.
      // A passing segment has nothing to repair, and repeating its state is
      // what filled the context in the first place.
      ...(ok ? {} : {
        // An unchanged-probe refusal must say so on the segment itself; the
        // model reads these rows, not the underlying phase result.
        ...(result.same_input_retry_allowed === false ? { same_input_retry_allowed: false } : {}),
        ...(blockingIssues.length ? { blocking_issues: blockingIssues } : {}),
        // Count only the blockers that did not fit; `issues_omitted` also
        // covers the advisory tail, which would overstate what is missing.
        // `errorCount` is the segment's own blocker total whichever carrier
        // supplied the list, so a truncated snapshot list says so too rather
        // than reading as complete.
        ...(Math.max(0, errorCount - blockingIssues.length) > 0
          ? { blocking_issues_omitted: errorCount - blockingIssues.length }
          : {}),
        ...(result.current_candidate ? { current_candidate: result.current_candidate } : {}),
        ...(result.message ? { message: result.message } : {}),
      }),
    };
  });

  const failed = segments.filter((segment) => !segment.ok).map((segment) => segment.segment_id);
  // When the last segment is captured, the keyframe preview opens — and its
  // artifact is ONE image of the whole video. Composing it is the host's job:
  // only it holds every segment's frames and the order they play in. Without
  // it the stop arrives as one contact sheet per child composition (four
  // links for a five-segment video on 2026-08-07) with media segments missing
  // entirely, which is not something a user can review as a video.
  let productionContactSheet = '';
  if (input.phase === 'snapshot' && !failed.length && afterReview.uncaptured_segment_ids.length === 0) {
    productionContactSheet = await composeProductionContactSheet(input.opts, input.planPathAbs, after);
  }
  return {
    ok: failed.length === 0,
    op: 'production.segment_qa',
    phase: input.phase,
    checked_segment_ids: runnable,
    ...(productionContactSheet ? { production_contact_sheet: productionContactSheet } : {}),
    ...(unknownIds.length ? { unknown_segment_ids: unknownIds } : {}),
    ...(mediaBackedIds.length ? { media_backed_segment_ids: mediaBackedIds } : {}),
    failed_segment_ids: failed,
    segments,
    production_review: {
      renderable: afterReview.renderable,
      uncaptured_segment_ids: afterReview.uncaptured_segment_ids,
    },
    ...productionSegmentQaOutcome({
      phase: input.phase,
      failed,
      checkedCount: runnable.length,
      uncaptured: afterReview.uncaptured_segment_ids,
    }),
  };
}

/** What a finished QA batch tells the model to do next, and why.
 *
 * Pure, because it is the one place a passing phase can contradict the
 * production's own readiness. A snapshot batch that passes while a segment
 * is still unproduced used to answer "snapshot passed" +
 * `open_production_preview_review`, while the whole-video contact sheet was
 * withheld — correctly, since it cannot be composed until every segment has
 * frames. The model opened the stop as instructed and the user got "The
 * visual preview is ready" with nothing to look at (2026-08-08: five
 * compositions captured, one edit segment with no produced file). The next
 * action follows readiness now, and names what is missing. */
export function productionSegmentQaOutcome(input: {
  phase: 'lint' | 'inspect' | 'snapshot';
  failed: string[];
  checkedCount: number;
  uncaptured: string[];
}): { message: string; next_action: string } {
  if (input.failed.length) {
    return {
      message: `${input.phase} failed for ${input.failed.join(', ')}. Repair those segments only; the passing segments keep their results and must not be re-run.`,
      next_action: 'repair_failed_segments_then_recheck',
    };
  }
  if (input.phase === 'snapshot' && input.uncaptured.length) {
    return {
      message: `snapshot passed for all ${input.checkedCount} checked segment(s), but the production is not ready `
        + `to review: ${input.uncaptured.join(', ')} has no current frames. `
        + 'Produce it first — a media segment needs its produced_path file, a composition needs this QA '
        + 'phase — then run this phase again. The whole-video contact sheet the preview stop leads with '
        + 'is only composed once every segment is captured.',
      next_action: 'produce_uncaptured_segments_then_recheck',
    };
  }
  return {
    message: `${input.phase} passed for all ${input.checkedCount} checked segment(s).`,
    next_action: input.phase === 'snapshot'
      ? 'open_production_preview_review'
      // Phrases, never operation-shaped strings: these are next_action hints,
      // and a `namespace.verb` hint is indistinguishable from a real op — a
      // caller that takes it literally calls something that does not exist.
      // The phase is an argument of production.segment_qa, not an op of its own.
      : input.phase === 'lint' ? 'run_segment_qa_inspect_phase' : 'run_segment_qa_snapshot_phase',
  };
}

/** Whether this composition's frame 0 is the delivered video's first frame.
 *
 * A standalone COMPOSE always is. An assembled child only is when it leads its
 * parent EDL: a middle segment's frame 0 plays somewhere inside the finished
 * video, so the opening-promise rule would be applying whole-video cover
 * semantics to the middle of a film. Unreadable parent plan means yes, so an
 * unknown stays on the stricter side. */
/** Error results the model must repair from, whose full payloads run to
 * ~100KB (per-frame visible_elements, whole preflight reports). Inlining
 * that spills the tool result to disk, and the model then burns two extra
 * round trips (tool_result_search + read_chunk) before it can start the
 * repair — 2026-08-06: ~5 minutes per QA block on a run the user was
 * waiting on. The returned payload keeps the actionable repair focus; the
 * complete evidence is already persisted via findings/report files. */
const QA_BLOCKED_COMPACT_CODES = new Set([
  'E_PREFLIGHT_BLOCKED',
  'E_PREVIEW_QA_BLOCKED',
  'E_PREVIEW_DESIGN_QA_BLOCKED',
  'E_VIDEO_QA_BLOCKED',
  'E_MEDIA_QA_BLOCKED',
]);

const QA_COMPACT_MAX_ISSUES = 12;
/** Advisory findings are repair material, not noise. Compaction used to keep
 *  only `severity:'error'`, so a passing inspect reported `issueCount: 13,
 *  issues: []` — a count and nothing else. On 2026-08-07 the model then
 *  rediscovered those layout defects by eye, one frame-review cycle at a
 *  time. Warnings ride along behind the errors and stay bounded so the result
 *  still fits inline; the count of what was dropped is still reported. */
const QA_COMPACT_MAX_ADVISORY = 8;

function compactQaIssueEntries(issues: unknown): Record<string, unknown>[] {
  if (!Array.isArray(issues)) return [];
  const entries = issues.filter((issue): issue is Record<string, unknown> => (
    !!issue && typeof issue === 'object' && !Array.isArray(issue)
  ));
  // Errors first: they are what blocks, and a truncated tail must never cost
  // the model a blocker in exchange for an advisory note.
  const kept = [
    ...entries.filter((issue) => issue.severity === 'error').slice(0, QA_COMPACT_MAX_ISSUES),
    ...entries.filter((issue) => issue.severity === 'warning').slice(0, QA_COMPACT_MAX_ADVISORY),
  ];
  return kept.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    ...(issue.sceneId ? { sceneId: issue.sceneId } : {}),
    ...(typeof issue.sampleTimeSec === 'number' ? { sampleTimeSec: issue.sampleTimeSec } : {}),
    ...(issue.selector ? { selector: issue.selector } : {}),
    message: issue.message,
    ...(issue.fixHint ? { fixHint: issue.fixHint } : {}),
  }));
}

function compactQaSection(section: unknown): Record<string, unknown> | undefined {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined;
  const record = section as Record<string, unknown>;
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const errors = compactQaIssueEntries(issues);
  return {
    ...(record.ok !== undefined ? { ok: record.ok } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.error_count !== undefined ? { error_count: record.error_count } : {}),
    ...(record.warning_count !== undefined ? { warning_count: record.warning_count } : {}),
    ...(record.issue_count !== undefined ? { issue_count: record.issue_count } : {}),
    issues: errors,
    ...(issues.length > errors.length ? { issues_omitted: issues.length - errors.length } : {}),
  };
}

/** Deep-collect error-severity issue entries from an arbitrary report shape
 * (preflight reports nest per-section issue arrays). Bounded. */
/** Walks a preflight payload for blocking findings.
 *
 * Deduplicated, because a preflight carries its findings in more than one
 * place — the result's own `issues` and the same array again under `report`
 * — and a blind walk emitted every finding twice: a 2026-08-09 run was told
 * it had six problems when it had three, each repair line printed twice. The
 * key is what identifies a finding to a reader, not object identity, since
 * the copies may be structurally equal without being the same object. */
function collectErrorIssues(
  value: unknown,
  out: Record<string, unknown>[],
  depth = 0,
  seen: Set<string> = new Set(),
): void {
  if (out.length >= QA_COMPACT_MAX_ISSUES || depth > 6) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectErrorIssues(entry, out, depth + 1, seen);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.severity === 'error' && typeof record.message === 'string' && record.code) {
    const key = [record.code, record.selector ?? '', record.sceneId ?? '', record.message].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(...compactQaIssueEntries([record]));
    return;
  }
  for (const key of Object.keys(record)) collectErrorIssues(record[key], out, depth + 1, seen);
}

/** Payload size past which a findings-carrying result is compacted even
 * without a blocker: anything near the inline cap spills to disk and costs
 * the model a search round trip to read its own result. */
const QA_COMPACT_SIZE_THRESHOLD = 24_000;

const QA_SECTION_KEYS = ['findings', 'preview_qa', 'video_qa', 'media_qa', 'inspect_disposition'] as const;

function needsQaCompaction(result: VideoStudioResult): boolean {
  const record = result as unknown as Record<string, unknown>;
  if (result.ok === false && QA_BLOCKED_COMPACT_CODES.has(String(result.errorCode))) return true;
  // A SUCCESS result can carry blockers: composition.inspect returns
  // ok:true / status:"review_required" with blocking_error_count > 0 and a
  // ~68KB serialized findings blob. 2026-08-06: the model spent 8 minutes
  // on six searches and a chunk read hunting the single error inside it.
  if (Number(record.blocking_error_count || 0) > 0) return true;
  if (!QA_SECTION_KEYS.some((key) => record[key] !== undefined)) return false;
  return JSON.stringify(record).length > QA_COMPACT_SIZE_THRESHOLD;
}

/** The actionable core of a serialized findings blob. `findings` is a
 * pretty-printed JSON STRING holding every issue plus samples, sample plans
 * and the preflight report; only its counts and error entries are repair
 * material. Unparseable input degrades to a length note, never a throw. */
function compactFindingsPayload(value: unknown): unknown {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return compactQaIssueEntries(value);
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { omitted_chars: value.length, note: 'findings payload was not parseable JSON and was omitted for size.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  const issues = Array.isArray(record.issues) ? record.issues : [];
  const errors = compactQaIssueEntries(issues);
  return {
    ...(record.ok !== undefined ? { ok: record.ok } : {}),
    ...(record.errorCount !== undefined ? { errorCount: record.errorCount } : {}),
    ...(record.warningCount !== undefined ? { warningCount: record.warningCount } : {}),
    ...(record.issueCount !== undefined ? { issueCount: record.issueCount } : {}),
    issues: errors,
    ...(issues.length > errors.length ? { issues_omitted: issues.length - errors.length } : {}),
  };
}

/** Bounded projection of the durable-state sections a result carries.
 *
 * These are recoverable on demand — composition.status returns the complete
 * picture — so a result that has to spill to disk to carry them costs the
 * model a search round trip for evidence it did not need. The 2026-08-07
 * QA-blocked draft was 71KB: 36KB production_state (11KB superseded candidate
 * history, a 10KB duplicate of the candidate already at top level, a 6KB
 * approved-intent snapshot), 10KB current_candidate (6KB of private
 * content-store metadata), 11KB review package (8.7KB artifact inventory) —
 * against 257 bytes of actual QA findings. Measured again on 2026-08-07 over
 * the case's ordinary ok:true results: lint/status/reconcile each ~43KB with
 * production_state at 32KB — the same echo on every call, all session long.
 *
 * What remains here is the size decision alone. Whether a field is usable at
 * all belongs to `summarizeVideoProductionState`, which is why the frozen-store
 * locators and the approved-intent snapshot left from there rather than from
 * here — status was exempt from this projection by design, so anything applied
 * only here never reached the largest result of the run.
 */
function compactProductionStateSection(
  value: unknown,
  opts: { topLevelCandidatePresent: boolean },
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  // The duplicate of the candidate the result already carries at top level.
  // Some early-return paths carry the candidate only here — keep it then.
  if (opts.topLevelCandidatePresent) delete record.current_candidate;
  if (Array.isArray(record.operation_journal)) {
    record.operation_journal = record.operation_journal.slice(-6);
  }
  if (Array.isArray(record.narration_transaction_history)) {
    record.narration_transaction_history = record.narration_transaction_history.slice(-3);
  }
  if (Array.isArray(record.history)) record.history = record.history.slice(-6);
  return record;
}

function compactCandidateSection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...projectCandidateRevisionForModel(value as Record<string, unknown>) };
  delete record.artifacts;
  return record;
}

function compactReviewPackageSection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const artifacts = record.artifacts;
  if (Array.isArray(artifacts)) {
    record.artifacts = artifacts.slice(0, 8);
    if (artifacts.length > 8) record.artifacts_omitted = artifacts.length - 8;
  }
  const visible = record.visible_artifact_paths;
  if (Array.isArray(visible) && visible.length > 12) {
    record.visible_artifact_paths = visible.slice(0, 12);
    record.visible_artifact_paths_omitted = visible.length - 12;
  }
  return record;
}

/** The one model-facing result projection, applied where results serialize.
 *
 * Only `composition.status`/`production.status` return the complete durable
 * state — that is what the operation is FOR. Every other operation answers
 * "what did this call do", so the durable-state sections it carries travel as
 * the bounded projection: full echo on every working call was the single
 * largest token cost in the 2026-08-06 case run (29 native calls, ~43KB each,
 * >60% repeated state; 14 of 96 tool calls existed only to search spilled
 * copies of results the model had already been handed). QA-blocked or
 * findings-heavy results additionally compact their QA payload down to the
 * error entries that are actual repair material.
 */
/** A passing report, projected to what a passing result is FOR: which steps
 * ran, the QA verdict with any surviving issues, and a pointer at the disk
 * copy for everything else. Issues are kept verbatim — on a passing report
 * they are the advisory tail (hundreds of bytes), and they are exactly the
 * part the model may still act on. */
function summarizePassingDiskBackedReport(report: Record<string, unknown>): Record<string, unknown> {
  const steps = report.steps && typeof report.steps === 'object' && !Array.isArray(report.steps)
    ? report.steps as Record<string, unknown>
    : {};
  const stepStatus: Record<string, string> = {};
  for (const [name, value] of Object.entries(steps)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const step = value as Record<string, unknown>;
    // Data blocks stored beside steps (design_review_inputs) have no verdict
    // and are not steps; the top-level result carries them once already.
    if (step.ok === undefined && step.status === undefined) continue;
    stepStatus[name] = step.ok === true ? 'ok' : step.ok === false ? 'failed' : String(step.status);
  }
  const videoQa = report.video_qa && typeof report.video_qa === 'object' && !Array.isArray(report.video_qa)
    ? report.video_qa as Record<string, unknown>
    : undefined;
  return {
    ...(Object.keys(stepStatus).length ? { steps: stepStatus } : {}),
    ...(videoQa ? {
      video_qa: {
        ...(videoQa.ok !== undefined ? { ok: videoQa.ok } : {}),
        ...(videoQa.issue_count !== undefined ? { issue_count: videoQa.issue_count } : {}),
        ...(videoQa.error_count !== undefined ? { error_count: videoQa.error_count } : {}),
        ...(videoQa.warning_count !== undefined ? { warning_count: videoQa.warning_count } : {}),
        sample_count: Array.isArray(videoQa.samples) ? videoQa.samples.length : 0,
        ...(Array.isArray(videoQa.issues) && videoQa.issues.length ? { issues: videoQa.issues } : {}),
      },
    } : {}),
    // A bare "the rest is at report_path" is an invitation to read the whole
    // thing. On 2026-08-09 the model did exactly that: 311,495 characters of
    // draft report pulled back in one read_file, ~78k tokens, spilled again on
    // the way in — larger than the inline report this projection removed. Say
    // what the file is for and that a passing draft does not need it.
    note: 'Every step above passed. The full render/QA detail (per-frame samples, frame evidence, passing findings, preflight)'
      + ' is on disk at report_path for a later failure to be traced against — reading it whole costs more context than it'
      + ' carries. Open it only for a specific question, and search or seek to that part rather than loading the file.',
  };
}

export function compactQaBlockedVideoStudioResult(result: VideoStudioResult): VideoStudioResult {
  const record = { ...(result as unknown as Record<string, unknown>) };
  const op = String(record.op || '');
  if (op === 'composition.status' || op === 'production.status') return result;
  const qaCompaction = needsQaCompaction(result);
  const carriesStateEcho = record.production_state !== undefined
    || record.current_candidate !== undefined
    || record.review_package !== undefined
    || record.evidence !== undefined;
  // A passing render whose detail is already on disk is projectable on its own
  // merits. Gating that on a state echo made it accidental: it ran only
  // because draft/export happen to carry production_state as well.
  const carriesDiskBackedDetail = result.ok === true
    && typeof record.report_path === 'string' && !!record.report_path
    && (record.report !== undefined || record.design_review_inputs !== undefined);
  if (!qaCompaction && !carriesStateEcho && !carriesDiskBackedDetail) return result;
  if (record.production_state !== undefined) {
    record.production_state = compactProductionStateSection(record.production_state, {
      topLevelCandidatePresent: record.current_candidate !== undefined,
    });
  }
  const evidence = record.evidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const observations = (evidence as Record<string, unknown>).observations;
    if (Array.isArray(observations) && observations.length > 24) {
      record.evidence = {
        ...(evidence as Record<string, unknown>),
        observations: observations.slice(0, 24),
        observations_omitted: observations.length - 24,
      };
    }
  }
  if (record.current_candidate !== undefined) {
    record.current_candidate = compactCandidateSection(record.current_candidate);
  }
  if (record.review_package !== undefined) {
    record.review_package = compactReviewPackageSection(record.review_package);
  }
  // A PASSING draft/export inlined its whole report even though the same
  // bytes were just written to report_path — per-frame samples, render frame
  // evidence, passing inspect findings, and video_qa/design_review_inputs a
  // second time each under steps: ~61K of the ~100K result. Five segments per
  // batch put every one of those PASSING results over the tool-result cap, so
  // the model received five search refs where five verdicts should have been,
  // and the turn compacted three times (2026-08-08 run). The failing paths
  // were already projected (delete record.report below); the passing path is
  // now projected too. Guarded on report_path: with no disk copy verified,
  // the inline report is the only copy and must survive.
  if (carriesDiskBackedDetail) {
    if (record.report && typeof record.report === 'object' && !Array.isArray(record.report)) {
      record.report = summarizePassingDiskBackedReport(record.report as Record<string, unknown>);
    }
    // The projection above left the largest block of that same detail inline:
    // `design_review_inputs` on a passing draft measured 3.9–5.8KB while the
    // result beside it said `design_review_required: false`, and the disk copy
    // was already written by the same call. Six segments in one round on
    // 2026-08-10 came to ~4,095 tokens each against a 7,027 round budget, so
    // three of the six verdicts reached the model as refs. The deletion below
    // never ran for them — it sits after the `qaCompaction` return, and a
    // passing result is not QA-blocked. A review that IS required keeps its
    // inputs: that is the one caller who has to act on them.
    if (record.design_review_required !== true && record.design_review_inputs !== undefined) {
      delete record.design_review_inputs;
      record.design_review_inputs_note = 'No design review is open, so its inputs were omitted; they are in the report at report_path.';
    }
  }
  if (!qaCompaction) return record as unknown as VideoStudioResult;
  for (const key of ['preview_qa', 'video_qa', 'media_qa'] as const) {
    const compact = compactQaSection(record[key]);
    if (compact) record[key] = compact;
  }
  const frameEvidence = record.frame_evidence as Record<string, unknown> | undefined;
  if (frameEvidence && typeof frameEvidence === 'object') {
    record.frame_evidence = {
      ...(frameEvidence.evidence_dir ? { evidence_dir: frameEvidence.evidence_dir } : {}),
      ...(frameEvidence.contact_sheet ? { contact_sheet: frameEvidence.contact_sheet } : {}),
      sample_count: Array.isArray(frameEvidence.samples) ? frameEvidence.samples.length : 0,
    };
  }
  if (record.preflight && typeof record.preflight === 'object') {
    const preflight = record.preflight as Record<string, unknown>;
    const errorIssues: Record<string, unknown>[] = [];
    collectErrorIssues(preflight, errorIssues);
    record.preflight = {
      ...(preflight.status !== undefined ? { status: preflight.status } : {}),
      ...(preflight.blocking_error_count !== undefined
        ? { blocking_error_count: preflight.blocking_error_count }
        : {}),
      ...(preflight.fatal_error_count !== undefined
        ? { fatal_error_count: preflight.fatal_error_count }
        : {}),
      error_issues: errorIssues,
    };
  }
  if (record.findings !== undefined) {
    record.findings = compactFindingsPayload(record.findings);
  }
  // inspect already summarizes its own verdict into bounded blocking/advisory
  // lists — exactly the repair material — so it is kept as-is.
  delete record.design_review_inputs;
  delete record.visual_regression;
  delete record.report;
  delete record.steps;
  delete record.samples;
  delete record.sample_plan;
  record.evidence_note = 'Repair from the error issues above. Bulk evidence (per-frame elements, sample plans, the full preflight report) was omitted for size; re-run this operation with findings_path to write the complete report to disk.';
  return record as unknown as VideoStudioResult;
}

function normalizedQaWaiverCodes(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((code) => String(code || '').trim()).filter(Boolean))]
    : [];
}

function qaWaiverQuoteOf(evidence: unknown): string {
  let record = evidence;
  if (typeof record === 'string') {
    try { record = JSON.parse(record); } catch { return ''; }
  }
  return record && typeof record === 'object' && !Array.isArray(record)
    ? String((record as Record<string, unknown>).quote || '').trim()
    : '';
}

/** Validate a user-authorized QA waiver request. Returns an error payload to
 * return as-is, or the verified verbatim quote to record. Waiving a finding
 * is a user decision: the quote must come from the current real user turn,
 * and evidence-integrity findings are never waivable. */
function verifyQaWaiverRequest(
  op: string,
  userMessage: string | undefined,
  codes: string[],
  evidence: unknown,
): { error?: Record<string, unknown>; quote?: string } {
  const nonWaivable = codes.filter((code) => !qaFindingIsWaivable(code));
  if (nonWaivable.length) {
    return {
      error: {
        ok: false,
        op,
        errorCode: 'E_QA_WAIVER_NOT_ALLOWED',
        message: `These findings mark missing or corrupt QA evidence and cannot be waived: ${nonWaivable.join(', ')}. Repair the evidence path instead; the user may waive judgment findings only.`,
        non_waivable_findings: nonWaivable,
      },
    };
  }
  const decision = resolveVideoStudioCurrentTurnDecision(userMessage, 'qa_waiver', evidence);
  const invalid = decisionEvidenceCorrectionResult(op as VideoStudioOp, 'qa_waiver', decision);
  if (invalid) return { error: invalid };
  if (decision.decision !== 'approve' || decision.source !== 'model_interpreted_user_message') {
    return {
      error: {
        ok: false,
        op,
        errorCode: 'E_QA_WAIVER_EVIDENCE_REQUIRED',
        message: 'Waiving a QA finding is a user decision: pass decision_evidence with source user_message, gate "qa_waiver", decision "approve", and the user\'s verbatim words from the current turn.',
      },
    };
  }
  return { quote: qaWaiverQuoteOf(evidence) };
}

/** Append accepted waivers to the production state (deduplicated by code)
 * and return the updated state. Bounded like other audit lists. */
async function recordQaWaivers(input: {
  statePath: string;
  compositionDirAbs: string;
  codes: string[];
  quote: string;
  turnId?: string;
}): Promise<VideoProductionStateV1> {
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    const waivers = next.qa_waivers || [];
    const known = new Set(waivers.map((waiver) => waiver.code));
    for (const code of input.codes) {
      if (known.has(code)) continue;
      known.add(code);
      waivers.push({
        code,
        quote: input.quote,
        turn_id: input.turnId || '',
        created_at: new Date().toISOString(),
      });
    }
    next.qa_waivers = waivers.slice(-40);
  });
}

async function compositionIsDeliveredOpening(state: VideoProductionStateV1): Promise<boolean> {
  // Structural parent linkage, with history fallback: an approval re-signed
  // without resolving the parent must not turn a mid-film segment back into
  // "the delivered opening" — that is what held the 2026-08-06 run's middle
  // segments to poster-frame cover standards.
  const link = parentEdlLinkOf(state);
  if (!link.planPath || !link.segmentId) return true;
  try {
    const plan = JSON.parse(await fs.readFile(link.planPath, 'utf8')) as { segments?: unknown };
    const segments = Array.isArray(plan.segments) ? plan.segments : [];
    // Layer order decides what the viewer sees first: an overlay riding on the
    // opening primary segment is not itself the delivered opening.
    const primary = segments.filter((segment): segment is Record<string, unknown> => !!segment
      && typeof segment === 'object'
      && !Array.isArray(segment)
      && (segment as Record<string, unknown>).layer === 'primary');
    const first = (primary[0] || {}) as Record<string, unknown>;
    return typeof first.id === 'string' ? first.id === link.segmentId : true;
  } catch {
    return true;
  }
}

/** Current per-segment review facts for one assembled production.
 *
 * A compose segment is authored as its own composition with its own state, and
 * the link back is the parent reference recorded on its inherited plan
 * approval — the same one the review panel groups by. Signatures are read from
 * the composition as it is NOW, so a segment edited after its confirmation
 * reports a different value and shows up as stale rather than silently
 * renderable.
 *
 * An edit/generate/provided segment has no composition at all: its artifact is
 * the produced media file, and the panel plays exactly that file. Deriving
 * every segment from composition state made those segments permanently
 * uncaptured, which on 2026-08-05 left a nine-segment production — eight
 * compositions and one cut — unable to reach `renderable` at all. They are
 * therefore captured by their own bytes rather than by snapshot evidence: HTML
 * needs rendering before there is anything to look at, a cut is already
 * pixels. */
type SegmentReviewRecord = {
  fact: VideoProductionSegmentReviewFact;
  /** The gate state file the fact was read from, so the aggregate approval can
   *  stamp this segment's own preview entry. Absent for a segment with no gate
   *  ledger yet, and for a media-backed segment, which has none. */
  statePath?: string;
  compositionDir?: string;
  /** The produced media file this segment's fact was read from. Present only
   *  for a media-backed segment; it is what the review shows. */
  mediaPath?: string;
};

/** A composition-manifest read failure, said in the caller's terms.
 *
 * Four sites passed the raw fs error straight through as the message, so a
 * manifest that simply did not exist yet answered as "invalid" with a full
 * local absolute path inside (`ENOENT ... open '/Users/...'`) — the same
 * misclassification family as "no audio track is not a failed extraction",
 * plus a path-hygiene violation. Missing and invalid are different answers:
 * missing points at the step that creates the file, invalid carries the
 * parse detail (path-redacted; zod details are field paths and were already
 * safe). Observed live on 2026-08-09 before the media-segment routing fix
 * intercepted that run's instance one step earlier. */
function compositionManifestFailure(err: unknown): { missing: boolean; detail: string } {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return { missing: true, detail: 'composition-manifest.json does not exist here yet' };
  }
  return { missing: false, detail: redactPaths(String((err as Error)?.message ?? err)) };
}

/** Sources whose artifact is produced media rather than an authored composition. */
const MEDIA_BACKED_SEGMENT_SOURCES = new Set(['edit', 'generate', 'provided']);

/** The reviewable media file of a non-compose segment, or '' when it has none.
 *
 * Fail-closed at every step: an unknown source, a missing `produced_path`, a
 * path outside the agent's scope, an extension or size the panel cannot serve,
 * and an empty file all yield '' — the segment stays uncaptured, which is the
 * same answer as before this branch existed. `resolveLocalMediaPath` is the
 * same resolver `chat-media://local/` serves through, so "captured" means
 * exactly "the panel can display these bytes". */
function mediaBackedSegmentPath(input: {
  segment: Record<string, unknown>;
  planPathAbs: string;
  roots: string[];
}): string {
  const source = typeof input.segment.source === 'string' ? input.segment.source : '';
  if (!MEDIA_BACKED_SEGMENT_SOURCES.has(source)) return '';
  const producedPath = typeof input.segment.produced_path === 'string'
    ? input.segment.produced_path.trim()
    : '';
  if (!producedPath) return '';
  // The plan lives at `<video>/project/plan.json` and its own paths read
  // `project/cuts/<id>.mp4`, so a relative produced path is relative to the
  // video directory, not to the plan's own folder.
  const abs = path.isAbsolute(producedPath)
    ? path.resolve(producedPath)
    : path.resolve(path.dirname(path.dirname(input.planPathAbs)), producedPath);
  if (!isPathAllowed(abs, input.roots)) return '';
  const resolved = resolveLocalMediaPath(abs);
  return resolved.ok ? resolved.absPath : '';
}

async function videoProductionSegmentReviewRecords(input: {
  opts: VideoStudioToolOpts;
  planPathAbs: string;
  identity: VideoProductionPlanIdentity;
  roots: string[];
}): Promise<SegmentReviewRecord[]> {
  const segmentIds = videoProductionSegmentIds(input.identity);
  const planSegments = new Map<string, Record<string, unknown>>();
  for (const segment of Array.isArray(input.identity.plan.segments)
    ? input.identity.plan.segments
    : []) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) continue;
    const record = segment as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id) planSegments.set(record.id, record);
  }
  const gatesDir = path.join(userLocalRoot(input.opts.userId), 'video_studio', 'gates');
  const entries = await fs.readdir(gatesDir, { withFileTypes: true }).catch(() => []);
  const wanted = new Set(segmentIds);
  const bySegment = new Map<string, {
    compositionDir: string;
    statePath: string;
    state: VideoProductionStateV1;
    updatedAtMs: number;
  }>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(gatesDir, entry.name);
    let state: VideoProductionStateV1;
    try {
      state = JSON.parse(await fs.readFile(filePath, 'utf8')) as VideoProductionStateV1;
    } catch {
      continue;
    }
    const approval = state?.plan_approval;
    if (!approval
      || approval.inheritance_reason !== 'parent_edl_segment'
      || typeof approval.parent_plan_path !== 'string'
      || path.resolve(approval.parent_plan_path) !== path.resolve(input.planPathAbs)) continue;
    const segmentId = typeof approval.parent_segment_id === 'string' ? approval.parent_segment_id : '';
    const compositionDir = typeof state.composition_dir === 'string' ? state.composition_dir : '';
    if (!segmentId || !wanted.has(segmentId) || !compositionDir) continue;
    // The same segment can have more than one historical ledger (a resumed task
    // rekeys them). The freshest record names the composition in use.
    const updatedAtMs = (await fs.stat(filePath).catch(() => null))?.mtimeMs || 0;
    const existing = bySegment.get(segmentId);
    if (!existing || updatedAtMs > existing.updatedAtMs) {
      bySegment.set(segmentId, { compositionDir, statePath: filePath, state, updatedAtMs });
    }
  }
  return Promise.all(segmentIds.map(async (segmentId) => {
    const found = bySegment.get(segmentId);
    if (found) {
      const visualSignature = await videoStudioVisualCompositionSignature(found.compositionDir)
        .catch(() => '');
      // Captured means the user can be shown frames of exactly these bytes: a
      // snapshot preview entry exists and its visual identity still matches the
      // files. An authored-but-never-snapshotted segment, or one edited after
      // its snapshot, has nothing reviewable and must not count.
      const captured = !!visualSignature
        && found.state.preview?.visual_signature === visualSignature;
      return {
        fact: { segment_id: segmentId, visual_signature: visualSignature, captured },
        statePath: found.statePath,
        compositionDir: found.compositionDir,
      };
    }
    // No composition. A media-backed segment is captured by its own bytes; a
    // compose segment that has not been authored yet is not, and neither is a
    // compose segment whose plan happens to carry a produced_path — its HTML
    // still has to be snapshotted before there is anything to review.
    const planSegment = planSegments.get(segmentId);
    const mediaPath = planSegment
      ? mediaBackedSegmentPath({
        segment: planSegment,
        planPathAbs: input.planPathAbs,
        roots: input.roots,
      })
      : '';
    if (!mediaPath) {
      return { fact: { segment_id: segmentId, visual_signature: '', captured: false } };
    }
    const { sha256, sizeBytes } = await sha256FileStream(mediaPath)
      .catch(() => ({ sha256: '', sizeBytes: 0 }));
    // The file's own bytes are the signature, so a re-trim to the same path
    // reports a different value and the segment goes stale exactly like an
    // edited composition does.
    if (!sha256 || sizeBytes === 0) {
      return { fact: { segment_id: segmentId, visual_signature: '', captured: false } };
    }
    return {
      fact: { segment_id: segmentId, visual_signature: sha256, captured: true },
      mediaPath,
    };
  }));
}

/** Why an assembled child's audio declaration is wrong, or '' when it is fine.
 *
 * A silent child that still carries narration text is `owner:"assembler"`, not
 * `owner:"none"`. The two are not interchangeable: every narration predicate in
 * the host reads `owner !== 'assembler'` as "this composition owes its own
 * narration audio", and the manifest schema then demands a signed
 * `narration_intent`. A child written as `"none"` could not satisfy both
 * contracts at once — on 2026-08-04 that produced five consecutive
 * E_GATE_B_ARTIFACT_INVALID, and the escape the model found was to sign a voice
 * for a segment that must never speak. `"none"` stays correct for a child with
 * no narration at all. Reads the raw manifest so it can run before the schema.
 * Pure → unit-tested. */
export function parentCompositionAudioFault(rawManifest: unknown): string {
  const manifest = rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)
    ? rawManifest as Record<string, unknown>
    : {};
  const audio = manifest.audio && typeof manifest.audio === 'object' && !Array.isArray(manifest.audio)
    ? manifest.audio as Record<string, unknown>
    : {};
  const owner = String(audio.owner ?? '');
  const trackCount = Array.isArray(audio.tracks) ? audio.tracks.length : 0;
  const hasNarrationText = Array.isArray(manifest.scenes)
    && manifest.scenes.some((scene) => !!scene
      && typeof scene === 'object'
      && !Array.isArray(scene)
      && typeof (scene as Record<string, unknown>).narration_text === 'string'
      && !!((scene as Record<string, unknown>).narration_text as string).trim());
  if (trackCount > 0 || owner === 'composition') {
    return 'The child carries its own audio. Remove audio.tracks and do not set audio.owner:"composition": the parent assembler mixes one narration for the whole video, so a baked-in child track plays twice.';
  }
  if (audio.narration_intent) {
    return 'The child signs its own audio.narration_intent. Remove it: the voice is selected once on the parent EDL, and a segment that never speaks must not sign one.';
  }
  if (hasNarrationText && owner !== 'assembler') {
    return `The child carries narration text but declares audio.owner:"${owner}". Use audio.owner:"assembler" — it renders silent exactly like "none" while naming the real owner, so the host stops asking this segment for its own narration audio.`;
  }
  return '';
}

async function validateParentCompositionBinding(input: {
  parentIdentity: VideoProductionPlanIdentity;
  segmentId: string;
  compositionDirAbs: string;
}): Promise<ParentCompositionBindingCheck> {
  const segments = Array.isArray(input.parentIdentity.plan.segments)
    ? input.parentIdentity.plan.segments.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const segment = segments.find((candidate) => candidate.id === input.segmentId);
  if (segment && segment.source !== 'compose') {
    // A media-backed segment has no composition and never will: its artifact
    // is the file at produced_path. Answering "no compose segment named X"
    // reads as a typo and sent a 2026-08-09 run down the composition line for
    // an `edit` segment — an empty directory created for it, doctor passing
    // on that empty directory, and reconcile finally failing on a missing
    // manifest nobody was ever supposed to write. The parent plan says what
    // this segment is; say it.
    return {
      ok: false,
      errorCode: 'E_PARENT_SEGMENT_NOT_A_COMPOSITION',
      message: `Segment "${input.segmentId}" is ${/^[aeiou]/i.test(String(segment.source)) ? 'an' : 'a'} ${segment.source} segment, not a composition: its artifact is its produced_path file, so it has no composition-manifest.json and no composition operation applies to it. Produce it on its own line and let the production QA phases pick it up from the file.`,
    };
  }
  if (!segment) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_SEGMENT_INVALID',
      message: `The approved parent EDL has no compose segment named ${input.segmentId}. Its compose segments are: ${segments.filter((candidate) => candidate.source === 'compose').map((candidate) => String(candidate.id)).join(', ') || '(none)'}.`,
    };
  }
  const spec = segment.spec && typeof segment.spec === 'object' && !Array.isArray(segment.spec)
    ? segment.spec as Record<string, unknown>
    : {};
  const binding = spec.composition_plan && typeof spec.composition_plan === 'object'
    && !Array.isArray(spec.composition_plan)
    ? spec.composition_plan as Record<string, unknown>
    : null;
  if (!binding || !Array.isArray(binding.scenes) || binding.scenes.length === 0) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_BINDING_REQUIRED',
      message: 'AUTO compose inheritance requires spec.composition_plan.scenes in the confirmed parent EDL. Do not request a separate child production plan confirmation; revise and confirm the parent EDL once.',
    };
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(
      await fs.readFile(path.join(input.compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    );
  } catch (err) {
    const failure = compositionManifestFailure(err);
    return {
      ok: false,
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: failure.missing
        ? 'composition-manifest.json does not exist here yet — approving this segment derives it from the signed parent; retry composition.approve_plan with the same binding.'
        : failure.detail,
    };
  }
  // Audio ownership is decided before the manifest schema runs, because the
  // schema's standalone-narration rule assumes a composition that owes its own
  // voice — which an assembled child never does. Judged in the other order it
  // reports "sign an audio.narration_intent" at a segment that must stay
  // silent, and following that advice is what cost the 2026-08-04 run its
  // fourth user confirmation.
  const audioFault = parentCompositionAudioFault(rawManifest);
  if (audioFault) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_AUDIO_OWNERSHIP',
      message: `AUTO child compositions must remain silent; the parent assembler owns narration and audio. ${audioFault}`,
    };
  }
  let manifest: CompositionManifest;
  try {
    manifest = CompositionManifestSchema.parse(rawManifest);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: (err as Error).message,
    };
  }
  const parentLanguage = typeof input.parentIdentity.plan.language === 'string'
    ? input.parentIdentity.plan.language.trim()
    : '';
  // Every mismatch below names BOTH sides. The host just compared them, and
  // "does not match" alone makes the caller re-derive what the host already
  // knows — the largest defect class in this tool's incident history.
  const targetDuration = Number(segment.target_sec);
  const childDuration = manifest.composition.target_duration ?? manifest.composition.duration;
  if (!Number.isFinite(targetDuration) || Math.abs(childDuration - targetDuration) > 0.01) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_DURATION_MISMATCH',
      message: `The child composition is ${childDuration}s but the approved parent EDL signs segment "${input.segmentId}" at ${Number.isFinite(targetDuration) ? `${targetDuration}s` : 'no duration at all'}. Set the composition duration to the signed value; changing the segment's length needs a parent EDL amendment.`,
    };
  }
  if (parentLanguage && manifest.composition.language && manifest.composition.language !== parentLanguage) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_LANGUAGE_MISMATCH',
      message: `The child composition language is "${manifest.composition.language}" but the approved parent EDL signs "${parentLanguage}". Use the signed language.`,
    };
  }
  const normalizeScene = (value: Record<string, unknown>): Record<string, unknown> => ({
    id: String(value.id || ''),
    approved_copy: Array.isArray(value.approved_copy) ? value.approved_copy.map(String) : [],
    narration_text: typeof value.narration_text === 'string' ? value.narration_text : '',
    roles: Array.isArray(value.roles) ? value.roles.map(String) : [],
  });
  const expectedScenes = binding.scenes
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .map(normalizeScene);
  const actualScenes = manifest.scenes.map((scene) => normalizeScene(scene as unknown as Record<string, unknown>));
  if (stableJson(expectedScenes) !== stableJson(actualScenes)) {
    // Naming the four candidate fields and leaving the caller to find which
    // one drifted is a search, not an answer: the host holds both sides.
    const drift: string[] = [];
    const describe = (value: unknown): string => (Array.isArray(value) ? JSON.stringify(value) : `"${String(value)}"`);
    for (let index = 0; index < Math.max(expectedScenes.length, actualScenes.length); index += 1) {
      const expected = expectedScenes[index];
      const actual = actualScenes[index];
      if (!expected) { drift.push(`scene ${index} ("${actual?.id}") is not in the signed plan`); continue; }
      if (!actual) { drift.push(`signed scene "${expected.id}" is missing from the manifest`); continue; }
      for (const field of ['id', 'approved_copy', 'narration_text', 'roles'] as const) {
        if (stableJson(expected[field]) === stableJson(actual[field])) continue;
        drift.push(`scene ${index} ${field}: signed ${describe(expected[field])}, manifest has ${describe(actual[field])}`);
      }
    }
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_CONTENT_MISMATCH',
      message: `The child composition no longer reproduces the confirmed parent EDL binding — ${drift.slice(0, 6).join('; ')}${drift.length > 6 ? `; and ${drift.length - 6} more` : ''}. Restore the signed values; changing them needs a parent EDL amendment.`,
    };
  }
  return { ok: true, parentSignature: input.parentIdentity.signature };
}

/** Write an AUTO child's plan artifacts from the signed parent EDL segment.
 *
 * The host already holds the child's complete specification: the parent
 * binding fixes the scene ids, approved copy, narration text and roles, the
 * segment fixes the duration, the plan fixes language and aspect, and an
 * assembled child is silent by rule. Until 2026-08-07 that specification was
 * used only as a COMPARATOR — the model had to hand-author script.md,
 * shotlist.json and composition-manifest.json for every child, and the host
 * graded the result field by field. Measured on the 11:09 run: 4 children x 3
 * files, and three rounds of E_GATE_B_ARTIFACTS_INCOMPLETE /
 * E_GATE_B_REQUIREMENTS_INCOMPLETE (`shotlist.target_duration_seconds`,
 * `video_language`, `audio_mode`, `caption_mode`, `music_mode`,
 * `shots.missing`) before the same values the parent already carried were
 * finally typed correctly — about ten minutes of the run, spent restating
 * signed facts.
 *
 * So the same specification generates. Deterministic derivation belongs to
 * the host; the model authors what needs judgment (the HTML and its art
 * direction), and those are preserved here untouched. Idempotent: a
 * conforming file is left alone, so re-deriving never churns the artifact
 * signature.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function materializeChildPlanArtifacts(input: {
  parentIdentity: VideoProductionPlanIdentity;
  segmentId: string;
  compositionDirAbs: string;
}): Promise<{ written: string[] }> {
  const plan = input.parentIdentity.plan as Record<string, unknown>;
  const segments = Array.isArray(plan.segments)
    ? plan.segments.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const segment = segments.find((candidate) => candidate.id === input.segmentId);
  if (!segment || segment.source !== 'compose') return { written: [] };
  const spec = segment.spec && typeof segment.spec === 'object' && !Array.isArray(segment.spec)
    ? segment.spec as Record<string, unknown>
    : {};
  const binding = spec.composition_plan && typeof spec.composition_plan === 'object'
    && !Array.isArray(spec.composition_plan)
    ? spec.composition_plan as Record<string, unknown>
    : null;
  const boundScenes = Array.isArray(binding?.scenes)
    ? binding.scenes.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const targetDuration = Number(segment.target_sec);
  if (!boundScenes.length || !Number.isFinite(targetDuration) || targetDuration <= 0) return { written: [] };

  const language = typeof plan.language === 'string' && plan.language.trim() ? plan.language.trim() : 'en';
  const aspect = String(plan.aspect || '16:9').trim();
  const [width, height] = aspect === '9:16' ? [1080, 1920] : aspect === '1:1' ? [1080, 1080] : [1920, 1080];
  const written: string[] = [];
  const writeIfChanged = async (fileName: string, content: string): Promise<void> => {
    const filePath = path.join(input.compositionDirAbs, fileName);
    const current = await fs.readFile(filePath, 'utf8').catch(() => null);
    if (current === content) return;
    await fs.mkdir(input.compositionDirAbs, { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    written.push(filePath);
  };

  // Windows follow the binding's own durations when it declares them, and
  // otherwise split the signed segment length evenly. Either way the last
  // scene absorbs the rounding so the child ends exactly on target_sec.
  const declared = boundScenes.map((scene) => Number(scene.duration));
  const declaredTotal = declared.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  const useDeclared = declared.every((value) => Number.isFinite(value) && value > 0)
    && Math.abs(declaredTotal - targetDuration) <= 0.01;
  const evenShare = targetDuration / boundScenes.length;
  let cursor = 0;
  const scenes = boundScenes.map((scene, index) => {
    const last = index === boundScenes.length - 1;
    const start = round3(cursor);
    const duration = last
      ? round3(Math.max(0.001, targetDuration - start))
      : round3(useDeclared ? declared[index] : evenShare);
    cursor = start + duration;
    const id = String(scene.id || `${input.segmentId}_${index + 1}`);
    return {
      id,
      start,
      duration,
      approved_copy: Array.isArray(scene.approved_copy) ? scene.approved_copy.map(String) : [],
      narration_text: typeof scene.narration_text === 'string' ? scene.narration_text : '',
      source_shots: [id],
      roles: Array.isArray(scene.roles) ? scene.roles.map(String) : [],
    };
  });

  const existingManifest = await fs.readFile(
    path.join(input.compositionDirAbs, 'composition-manifest.json'), 'utf8',
  ).then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => null);
  const existingComposition = existingManifest && typeof existingManifest.composition === 'object'
    && !Array.isArray(existingManifest.composition)
    ? existingManifest.composition as Record<string, unknown>
    : {};
  const fps = Number(existingComposition.fps) > 0 ? Number(existingComposition.fps) : 30;
  const authoredScenes = Array.isArray(existingManifest?.scenes)
    ? existingManifest.scenes.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  // Authored scene CONTENT is never overwritten. Copy, narration and roles
  // can carry a change the user asked for, and silently reverting them to the
  // parent would erase that instruction without a word — the binding
  // comparator still reports the mismatch and sends the amendment to the one
  // parent EDL, which is where a content change belongs. Only the structure
  // the parent fixes deterministically (windows, canvas, language) is filled
  // in here, and a missing manifest is derived whole.
  const manifestScenes = authoredScenes.length
    ? authoredScenes.map((scene, index) => ({
      ...scene,
      ...(scenes[index] ? { start: scenes[index].start, duration: scenes[index].duration } : {}),
      ...(Array.isArray(scene.source_shots) && scene.source_shots.length
        ? {}
        : { source_shots: [String(scene.id || scenes[index]?.id || '')] }),
    }))
    : scenes;
  const manifest: Record<string, unknown> = {
    // The model's own work — art direction above all — survives derivation.
    ...(existingManifest || {}),
    schema_version: 2,
    composition: {
      ...existingComposition,
      id: String(existingComposition.id || input.segmentId),
      width,
      height,
      duration: round3(targetDuration),
      target_duration: round3(targetDuration),
      fps,
      language,
    },
    scenes: manifestScenes,
    // Audio ownership is derived only for a manifest this call creates. An
    // existing one keeps whatever it declares so the ownership check can name
    // the mistake instead of it being quietly rewritten.
    audio: existingManifest?.audio ?? { owner: 'assembler', tracks: [] },
  };
  await writeIfChanged('composition-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { written };
}

/** The plan as prose, rendered from the manifest.
 *
 * script.md used to be an authored input carrying a second copy of every
 * scene's narration, policed by an alignment check — a check that failed on a
 * script whose only sin was line breaks (2026-08-07) and blocked the run.
 * The words now have one home. This renders the readable view from that home,
 * so it is a report, never a source: it cannot drift, and editing it changes
 * nothing. */
function renderPlanScript(manifest: CompositionManifest, title: string): string {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const lines: string[] = [
    `# ${title}`,
    '',
    `<!-- Rendered from composition-manifest.json. Edit the manifest, not this file. -->`,
    '',
    `${round(manifest.composition.target_duration ?? manifest.composition.duration)}s · `
      + `${manifest.composition.width}x${manifest.composition.height}`
      + (manifest.composition.language ? ` · ${manifest.composition.language}` : ''),
    '',
  ];
  for (const [index, scene] of manifest.scenes.entries()) {
    const start = round(scene.start);
    const end = round(scene.start + scene.duration);
    lines.push(`## ${index + 1}. ${scene.id} (${start}s–${end}s)`, '');
    for (const copy of scene.approved_copy) lines.push(`- ${copy}`);
    if (scene.approved_copy.length) lines.push('');
    if (scene.narration_text?.trim()) lines.push(scene.narration_text.trim(), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}


type NarrationRepairIdentity = {
  structureSignature: string;
  narrationTokenHashes: string[];
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function boundedIntentEvidenceValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 237)}...`;
  return typeof value === 'undefined' ? null : value;
}

function approvedIntentChanges(
  before: unknown,
  after: unknown,
  pathPrefix = '',
  changes: NonNullable<VideoProductionPlanEvidence['intent_changes']> = [],
): NonNullable<VideoProductionPlanEvidence['intent_changes']> {
  if (changes.length >= 50 || stableJson(before) === stableJson(after)) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count && changes.length < 50; index += 1) {
      approvedIntentChanges(before[index], after[index], `${pathPrefix}[${index}]`, changes);
    }
    return changes;
  }
  if (before && after
    && typeof before === 'object' && !Array.isArray(before)
    && typeof after === 'object' && !Array.isArray(after)) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
    for (const key of keys) {
      if (changes.length >= 50) break;
      approvedIntentChanges(
        beforeRecord[key],
        afterRecord[key],
        pathPrefix ? `${pathPrefix}.${key}` : key,
        changes,
      );
    }
    return changes;
  }
  changes.push({
    path: pathPrefix || '$',
    before: boundedIntentEvidenceValue(before),
    after: boundedIntentEvidenceValue(after),
  });
  return changes;
}

function normalizedRepairText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Every narrated scene's words appear in the script, in playback order.
 *
 * The script is the one place the user reads the narration as prose, so it
 * must not drift from the manifest that speaks it. The shot-binding half of
 * this check went with shotlist.json: it reconciled two copies of the same
 * fact and produced `shotlist.shots.missing` — an error about bookkeeping,
 * not about the video. */
function narrationRepairTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const estimate = estimateNarrationDuration(text);
  const tokens = estimate.unit === 'characters'
    ? Array.from(normalized).filter((character) => /[\p{L}\p{N}]/u.test(character))
    : normalized.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
  return tokens.map((token) => crypto.createHash('sha256').update(token).digest('hex'));
}

function narrationTokenEditRatio(before: string[], after: string[]): number {
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

/**
 * Build a signature for every approved plan field except the narration copy
 * that may be shortened or expanded by the measured-duration repair. The
 * manifest is the plan, so the structure is the manifest with each scene's
 * narration replaced by a per-scene marker — and approved on-screen copy
 * redacted only where it exactly duplicates that narration. Rewording the
 * spoken line alone leaves this signature unchanged; changing anything else
 * does not.
 */
async function videoProductionNarrationRepairIdentity(
  planIdentity: VideoProductionPlanIdentityResult,
): Promise<NarrationRepairIdentity | undefined> {
  const records = planIdentity.artifactRecords;
  if (!records) return undefined;
  const manifestRaw = await fs.readFile(records.manifest.path, 'utf8').catch(() => '');
  if (!manifestRaw) return undefined;

  let manifest: CompositionManifest;
  try {
    manifest = CompositionManifestSchema.parse(JSON.parse(manifestRaw));
  } catch {
    return undefined;
  }

  const sanitizedScenes: CompositionManifest['scenes'] = [];
  for (const scene of manifest.scenes) {
    const narration = scene.narration_text?.trim() || '';
    if (!narration) return undefined;
    const marker = `{{ORKAS_NARRATION:${scene.id}}}`;
    sanitizedScenes.push({
      ...scene,
      narration_text: marker,
      approved_copy: scene.approved_copy.map((copy) => (
        normalizedRepairText(copy) === normalizedRepairText(narration) ? marker : copy
      )),
    });
  }

  const narrationText = compositionNarrationText(manifest);
  if (!narrationText) return undefined;
  return {
    structureSignature: crypto.createHash('sha256')
      .update(stableJson({ manifest: { ...manifest, scenes: sanitizedScenes } }))
      .digest('hex'),
    narrationTokenHashes: narrationRepairTokens(narrationText),
  };
}

type NarrationRepairAssessment = {
  status: 'none' | 'pending' | 'inheritable' | 'rejected';
  reason: string;
  editRatio?: number;
  checksUsed?: number;
};

function assessNarrationRepair(input: {
  authorization?: VideoProductionNarrationRepairAuthorization;
  identity?: NarrationRepairIdentity;
  fit: VideoProductionNarrationFit;
  state: VideoProductionStateV1;
}): NarrationRepairAssessment {
  const authorization = input.authorization;
  if (!authorization) return { status: 'none', reason: 'no_measured_repair_authorization' };
  const checksUsed = authorization.checks_used + 1;
  if (!input.identity || input.identity.structureSignature !== authorization.structure_signature) {
    return { status: 'rejected', reason: 'approved_structure_changed', checksUsed };
  }
  if (Math.abs(input.fit.target_duration_sec - authorization.target_duration_sec) > 0.001) {
    return { status: 'rejected', reason: 'approved_target_duration_changed', checksUsed };
  }
  const calibration = input.state.narration_calibration;
  if (input.fit.source !== 'measured_calibration'
    || calibration?.backend !== authorization.backend
    || (input.fit.voice || '') !== (authorization.voice || '')
    || Math.abs(input.fit.speed - authorization.speed) > 0.0001) {
    return { status: 'rejected', reason: 'measured_voice_profile_changed', checksUsed };
  }
  const editRatio = narrationTokenEditRatio(
    authorization.narration_token_hashes,
    input.identity.narrationTokenHashes,
  );
  if (editRatio > authorization.max_edit_ratio) {
    return { status: 'rejected', reason: 'narration_change_exceeds_authorized_scope', editRatio, checksUsed };
  }
  const repaired = !narrationFitBlocksProduction(input.fit.status);
  return {
    status: repaired ? 'inheritable' : 'pending',
    reason: repaired
      ? 'measured_narration_fit_repaired'
      : checksUsed > authorization.max_checks
        ? 'repair_strategy_review_required'
        : 'repair_still_outside_delivery_band',
    editRatio,
    checksUsed,
  };
}

async function approvedTargetDurationSec(
  manifest: CompositionManifest,
  planIdentity?: VideoProductionPlanIdentityResult,
): Promise<number> {
  if (typeof manifest.composition.target_duration === 'number') return manifest.composition.target_duration;
  try {
    const shotlistPath = planIdentity?.artifactRecords?.shotlist.path;
    if (!shotlistPath) return manifest.composition.duration;
    const shotlist = JSON.parse(await fs.readFile(shotlistPath, 'utf8')) as Record<string, unknown>;
    const target = Number(shotlist.target_duration_seconds);
    if (Number.isFinite(target) && target > 0 && target <= 600) return target;
  } catch { /* Gate B validation reports malformed/missing shotlists. */ }
  return manifest.composition.duration;
}

function normalizedNarrationProfile(input: { voice?: string; language?: string; speed?: number }): {
  voice?: string;
  language?: string;
  speed: number;
} {
  const voice = input.voice?.trim();
  const language = input.language?.trim();
  return {
    ...(voice ? { voice } : {}),
    ...(language ? { language } : {}),
    speed: typeof input.speed === 'number' && Number.isFinite(input.speed) ? input.speed : 1,
  };
}

type CompositionNarrationSelectionResult =
  | { ok: true; selection: ResolvedTtsSelection; speed: number; legacy: boolean }
  | { ok: false; errorCode: string; message: string };

async function resolveCompositionNarrationSelection(input: {
  manifest: CompositionManifest;
  legacyVoice?: string;
  legacySpeed?: number;
  signal?: AbortSignal;
}): Promise<CompositionNarrationSelectionResult> {
  const intent = input.manifest.audio.narration_intent;
  if (input.manifest.schema_version === 2) {
    if (!intent) {
      return {
        ok: false,
        errorCode: 'E_TTS_NARRATION_INTENT_REQUIRED',
        message: 'A narrated schema_version 2 manifest must contain audio.narration_intent selected from speech.capabilities before production plan confirmation.',
      };
    }
    if (input.legacyVoice
      || (typeof input.legacySpeed === 'number' && Math.abs(input.legacySpeed - intent.speed) > 0.0001)) {
      return {
        ok: false,
        errorCode: 'E_TTS_SELECTION_OVERRIDE_FORBIDDEN',
        message: 'Execution cannot override the confirmed narration route, voice, language, or speed. Revise audio.narration_intent and request production plan confirmation again.',
      };
    }
    const resolved = await resolveTtsSelection({
      routeRef: intent.route_ref,
      voiceRef: intent.voice_ref,
      language: intent.language,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (resolved.ok === false) return resolved;
    // display_name is mutable capability-catalog metadata. Stable route_ref,
    // voice_ref, language, and speed identify the approved synthesis request.
    return { ok: true, selection: resolved.selection, speed: intent.speed, legacy: false };
  }

  const resolved = await resolveTtsSelection({
    ...(input.legacyVoice ? { legacyVoice: input.legacyVoice } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (resolved.ok === false) return resolved;
  return {
    ok: true,
    selection: resolved.selection,
    speed: typeof input.legacySpeed === 'number' ? input.legacySpeed : 1,
    legacy: true,
  };
}

function narrationCalibrationMatches(
  state: VideoProductionStateV1,
  profile: { backend: string; voice?: string; language?: string; speed: number },
): boolean {
  const calibration = state.narration_calibration;
  return !!calibration
    && calibration.backend === profile.backend
    && (calibration.voice || '') === (profile.voice || '')
    && (calibration.language || '') === (profile.language || '')
    && Math.abs(calibration.speed - profile.speed) <= 0.0001;
}

function compositionNarrationFit(input: {
  text: string;
  targetDurationSec: number;
  planSignature: string;
  state: VideoProductionStateV1;
  routeRef?: string;
  voiceRef?: string;
  language?: string;
  voice?: string;
  speed?: number;
}): VideoProductionNarrationFit {
  const profile = normalizedNarrationProfile({
    voice: input.voiceRef || input.voice,
    language: input.language,
    speed: input.speed,
  });
  const estimate = estimateNarrationDuration(input.text, profile.speed);
  const calibration = narrationCalibrationMatches(input.state, {
    ...profile,
    backend: input.routeRef || configuredTtsBackendId(),
  })
    ? input.state.narration_calibration
    : undefined;
  const assessed = assessEstimatedNarrationFit({
    estimate,
    targetSec: input.targetDurationSec,
    ...(calibration ? { durationScale: calibration.duration_scale } : {}),
  });
  if (!assessed) throw new Error('E_NARRATION_FIT_UNAVAILABLE: narration or target duration is invalid.');
  return {
    status: assessed.status,
    source: calibration ? 'measured_calibration' : 'generic',
    plan_signature: input.planSignature,
    text_sha256: crypto.createHash('sha256').update(input.text).digest('hex'),
    ...(input.routeRef ? { route_ref: input.routeRef } : {}),
    ...(input.voiceRef ? { voice_ref: input.voiceRef } : {}),
    ...(profile.language ? { language: profile.language } : {}),
    ...(profile.voice ? { voice: profile.voice } : {}),
    speed: profile.speed,
    target_duration_sec: assessed.targetSec,
    tolerance_ratio: assessed.toleranceRatio,
    tolerance_floor_sec: assessed.toleranceFloorSec,
    tolerance_sec: assessed.toleranceSec,
    min_duration_sec: assessed.minDurationSec,
    max_duration_sec: assessed.maxDurationSec,
    generic_estimated_duration_sec: assessed.genericEstimatedSec,
    estimated_duration_sec: assessed.estimatedSec,
    duration_scale: assessed.durationScale,
    narration_unit: assessed.unit,
    narration_units: assessed.units,
    suggested_units: assessed.suggestedUnits,
    checked_at: new Date().toISOString(),
    validation_version: 2,
  };
}

function narrationFitMessage(fit: VideoProductionNarrationFit): string {
  const source = fit.source === 'measured_calibration'
    ? 'the persisted measured voice pace'
    : 'the generic natural-pace estimate';
  if (fit.status === 'over') {
    return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source}, outside the accepted ${fit.min_duration_sec}-${fit.max_duration_sec}s band. Trim it to about ${fit.suggested_units} ${fit.narration_unit}; no speech request was sent.`;
  }
  if (fit.status === 'under') {
    return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source}, outside the accepted ${fit.min_duration_sec}-${fit.max_duration_sec}s band. Expand it to about ${fit.suggested_units} ${fit.narration_unit}; no speech request was sent.`;
  }
  return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source}, inside the accepted ${fit.min_duration_sec}-${fit.max_duration_sec}s band, and is ready for production plan confirmation.`;
}

async function currentPlanNarrationTextSha(compositionDirAbs: string): Promise<string> {
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    const text = compositionNarrationText(manifest);
    return text ? crypto.createHash('sha256').update(text).digest('hex') : '';
  } catch {
    return '';
  }
}

async function validateEdlNarrationSelection(planPath: string, signal?: AbortSignal): Promise<
  | { ok: true; selection?: ResolvedTtsSelection; speed?: number; legacy?: boolean }
  | { ok: false; errorCode: string; message: string }
> {
  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true };
    plan = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, errorCode: 'E_VIDEO_PLAN_INVALID', message: `Cannot parse production plan: ${(err as Error).message}` };
  }
  const tracks = plan.tracks;
  if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) return { ok: true };
  const narration = (tracks as Record<string, unknown>).narration;
  if (!narration || typeof narration !== 'object' || Array.isArray(narration)) return { ok: true };
  const nar = narration as Record<string, unknown>;
  const segments = Array.isArray(nar.segments) ? nar.segments : [];
  if (!segments.length) return { ok: true };
  const synthesis = nar.synthesis;
  if (synthesis && typeof synthesis === 'object' && !Array.isArray(synthesis)) {
    const intent = synthesis as Record<string, unknown>;
    const routeRef = String(intent.route_ref || '').trim();
    const voiceRef = String(intent.voice_ref || '').trim();
    const displayName = String(intent.display_name || '').trim();
    const language = String(intent.language || '').trim();
    const speed = Number(intent.speed);
    if (!routeRef || !voiceRef || !displayName || !language || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      return {
        ok: false,
        errorCode: 'E_TTS_NARRATION_INTENT_INVALID',
        message: 'tracks.narration.synthesis requires route_ref, voice_ref, display_name, language, and speed 0.5–2 selected from speech.capabilities.',
      };
    }
    const resolved = await resolveTtsSelection({ routeRef, voiceRef, language, ...(signal ? { signal } : {}) });
    if (resolved.ok === false) return resolved;
    // Catalog label changes are presentation refreshes, not plan amendments.
    return { ok: true, selection: resolved.selection, speed, legacy: false };
  }
  const legacyVoice = String(nar.voice || '').trim();
  if (!legacyVoice) {
    return {
      ok: false,
      errorCode: 'E_TTS_NARRATION_INTENT_REQUIRED',
      message: 'An active narration track requires tracks.narration.synthesis selected from speech.capabilities.',
    };
  }
  const resolved = await resolveTtsSelection({ legacyVoice, ...(signal ? { signal } : {}) });
  if (resolved.ok === false) return resolved;
  return { ok: true, selection: resolved.selection, speed: 1, legacy: true };
}

async function archiveStaleNarrationAudio(input: {
  state: VideoProductionStateV1;
  currentNarrationTextSha: string;
  compositionDirAbs: string;
  roots: string[];
}): Promise<string> {
  const trackedTextSha = input.state.narration?.text_sha256
    || input.state.narration_transaction?.text_sha256;
  const priorNarrationPath = input.state.narration?.path
    || input.state.narration_transaction?.path;
  if (!trackedTextSha
    || trackedTextSha === input.currentNarrationTextSha
    || !priorNarrationPath) return '';
  const source = path.resolve(priorNarrationPath);
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isFile() || !isPathAllowed(source, input.roots)) return '';
  const priorAudioSha = input.state.narration?.audio_sha256
    || input.state.narration_transaction?.audio_sha256
    || await sha256File(source)
    || 'unhashed';
  const archivedNarrationPath = path.join(
    input.compositionDirAbs,
    'assets',
    'narration-history',
    `${priorAudioSha}-${Date.now()}.mp3`,
  );
  await fs.mkdir(path.dirname(archivedNarrationPath), { recursive: true });
  await fs.rename(source, archivedNarrationPath);
  return archivedNarrationPath;
}

async function validatePlanApproval(
  statePath: string,
  compositionDirAbs: string,
  roots: string[],
  /** The parent-EDL binding the caller passed (plan_path + segment_id), when
   *  present. A missing manifest means something different under it: the
   *  manifest is host-derived by composition.approve_plan, not restored by
   *  the model. */
  parentBinding?: { segmentId: string; planPath: string },
): Promise<
  | { ok: true }
  | {
    ok: false;
    errorCode: string;
    message: string;
    evidence?: VideoProductionPlanEvidence;
    artifactIssues?: VideoProductionPlanArtifactIssue[];
  }
> {
  const state = await readVideoProductionState(statePath, compositionDirAbs);
  const identity = await videoProductionPlanIdentity(compositionDirAbs, {
    approval: state.plan_approval,
    roots,
  });
  if (!identity.complete) {
    // The host already parsed the manifest, so it knows both WHICH failure
    // this is and WHICH fields failed — `buildVideoProductionPlanIdentity`
    // records them as `artifactIssues[].details`. This branch used to collapse
    // both cases into one sentence and drop the issues, while the sibling
    // approve_plan / check_narration_fit branches classified them. That cost
    // ~4 minutes on 2026-08-07: the model could not tell a schema-invalid
    // manifest from a missing one, the sentence named `script` and `shotlist`
    // (both retired in 4658470f8), and it re-read gate-control in full
    // (12.4k tokens) because the wording described a gate problem while
    // `plan_gate_class` already said artifact_repair.
    const artifactIssues = identity.artifactIssues ?? [];
    const artifactInvalid = artifactIssues.length > 0;
    const details = artifactIssues.flatMap((issue) => (issue.details ?? [])
      .map((entry) => `${entry.path}: ${entry.message}`));
    if (!artifactInvalid && identity.evidence.conflicts.length === 0 && parentBinding) {
      // "Restore the canonical plan manifest" is the wrong instruction for an
      // AUTO child — the manifest is derived by the host at inheritance. On
      // 2026-08-08 the model obeyed it literally: five hand-written manifests,
      // which the ownership gate then rejected five more times for signing a
      // voice, and a bash pass to unwind — two full failure rounds caused by
      // this sentence pointing at the wrong actor.
      return {
        ok: false,
        errorCode: 'E_GATE_B_APPROVAL_REQUIRED',
        message: `composition-manifest.json does not exist here yet, and for segment "${parentBinding.segmentId}" `
          + `of ${parentBinding.planPath} it is not yours to write: call composition.approve_plan with the same `
          + 'composition_dir, plan_path, and segment_id — it inherits the parent Gate B and derives the manifest '
          + 'from the signed parent. Then retry this operation.',
        evidence: identity.evidence,
      };
    }
    return {
      ok: false,
      errorCode: identity.evidence.conflicts.length > 0
        ? 'E_GATE_B_ARTIFACT_CONFLICT'
        : artifactInvalid
          ? 'E_GATE_B_ARTIFACT_INVALID'
          : 'E_GATE_B_ARTIFACTS_INCOMPLETE',
      message: identity.evidence.conflicts[0]?.message
        || (artifactInvalid
          ? `composition-manifest.json does not match the required video-plan structure${details.length ? ` — ${details.slice(0, 6).join('; ')}` : ''}. Repair those fields without changing the confirmed plan, then retry the same operation in this turn.`
          : 'composition-manifest.json is missing, empty, or unreadable. Restore the canonical plan manifest, then retry the same operation in this turn.'),
      evidence: identity.evidence,
      ...(artifactInvalid ? { artifactIssues } : {}),
    };
  }
  if (identity.requirementIssues.length > 0) {
    return {
      ok: false,
      errorCode: 'E_GATE_B_ARTIFACTS_INCOMPLETE',
      message: `The current candidate no longer faithfully projects the approved intent: ${identity.requirementIssues.join(', ')}. Repair the candidate files without requesting another approval.`,
      evidence: identity.evidence,
    };
  }
  if (planApprovalMatchesIdentity(state.plan_approval, identity)) {
    if (state.plan_approval
      && (state.plan_approval.signature !== identity.signature
        || state.plan_approval.identity_kind !== 'approved_intent_sha256'
        || stableJson(state.plan_approval.artifact_records) !== stableJson(identity.artifactRecords))) {
      await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
        if (!planApprovalMatchesIdentity(next.plan_approval, identity) || !next.plan_approval) return;
        next.plan_approval = contentAddressedPlanApproval(next.plan_approval, identity);
      });
    }
    return { ok: true };
  }
  const restorable = [...(state.plan_approval_history || [])]
    .reverse()
    .find((entry) => planApprovalMatchesIdentity(entry, identity));
  if (restorable) {
    await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
      setCurrentPlanApproval(next, contentAddressedPlanApproval(restorable, identity));
    });
    return { ok: true };
  }
  if (!state.plan_approval) {
    return {
      ok: false,
      errorCode: 'E_GATE_B_APPROVAL_REQUIRED',
      message: 'Record the explicit plan approval with composition.approve_plan before prepare.',
    };
  }
  const currentVisualSignature = await videoStudioVisualCompositionSignature(compositionDirAbs)
    .catch(() => '');
  await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
    invalidateVisualEvidenceUnlessCurrent(next, currentVisualSignature);
    delete next.draft;
    next.stage = 'manifest_ready';
    recordVideoProductionTransition(next, {
      op: 'composition.approve_plan',
      status: 'failed',
      errorCode: 'E_GATE_B_ARTIFACT_CHANGED',
      stage: 'manifest_ready',
    });
  });
  return {
    ok: false,
    errorCode: 'E_GATE_B_ARTIFACT_CHANGED',
    message: 'The normalized user-intent content changed. Show the semantic difference and use the current user message as evidence when it explicitly requests the change; implementation-only artifact edits must not reopen approval.',
    evidence: {
      ...identity.evidence,
      ...(state.plan_approval.intent_snapshot && identity.intentPayload ? {
        intent_changes: approvedIntentChanges(
          state.plan_approval.intent_snapshot,
          identity.intentPayload,
        ),
      } : {}),
      conflicts: [
        ...identity.evidence.conflicts,
        {
          code: 'approved_intent_content_changed',
          message: 'The current canonical user-intent hash differs from the approved content address.',
          paths: identity.artifactPaths,
        },
      ],
    },
  };
}

/** Re-stamp the fs read baseline after a native op rewrites a file the model
 *  also edits with `edit_file`.
 *
 *  `edit_file` enforces read-before-edit through a run-scoped stamp and
 *  refreshes it after its own write, so consecutive edits need no re-read.
 *  Native composition writes are another writer in the same run: `rename`
 *  gives the file a new mtime, the stamp goes stale, and the model's next
 *  `edit_file` fails `E_STALE` and must spend a `read_file` round trip first.
 *  On 2026-08-07 that pattern cost ~30 round trips at ~29s each. Re-stamping
 *  costs nothing and is not a weaker guarantee: `old_string` must still match
 *  the current bytes exactly, so an edit aimed at a region this write changed
 *  degrades to `E_NO_MATCH`, which already returns bounded current context and
 *  a fresh hash for a same-turn retry. */
function restampReadBaseline(ctx: ToolContext | undefined, absPath: string): void {
  if (!ctx) return;
  recordRead(ctx, absPath);
}

async function writeJsonAtomic(absPath: string, value: unknown, ctx?: ToolContext): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, absPath);
  restampReadBaseline(ctx, absPath);
}

async function writeTextAtomic(absPath: string, value: string, ctx?: ToolContext): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, absPath);
  restampReadBaseline(ctx, absPath);
}

async function currentNarrationIdentity(compositionDirAbs: string): Promise<{
  required: boolean;
  textSha?: string;
  audioSha?: string;
  duration?: number;
  narrationMapMatches: boolean;
  materializationReceiptMatches: boolean;
  legacyMaterializationReceipt?: boolean;
  htmlTrackMatches: boolean;
  materialized: boolean;
}> {
  try {
    const parsed = CompositionManifestSchema.safeParse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    if (!parsed.success) {
      return {
        required: false,
        narrationMapMatches: false,
        materializationReceiptMatches: false,
        htmlTrackMatches: false,
        materialized: false,
      };
    }
    const text = compositionNarrationText(parsed.data);
    const required = !!text && parsed.data.audio.owner !== 'assembler';
    const track = parsed.data.audio.tracks.find((item) => item.kind === 'narration');
    const audioAbsPath = track?.src === 'assets/narration.mp3'
      ? path.join(compositionDirAbs, track.src)
      : '';
    const audioSha = audioAbsPath ? await sha256File(audioAbsPath) : undefined;
    const textSha = text ? crypto.createHash('sha256').update(text).digest('hex') : undefined;
    const narrationMap = await fs.readFile(path.join(compositionDirAbs, 'narration-map.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    const narrationMapMatches = !!narrationMap
      && narrationMap.narration_text_sha256 === textSha
      && narrationMap.narration_audio_sha256 === audioSha;
    const alignmentMethod = narrationMap?.alignment_method === 'forced_alignment'
      ? 'forced_alignment'
      : narrationMap?.alignment_method === 'scene_estimate_scaled'
        ? 'scene_estimate_scaled'
        : undefined;
    const expectedReceipt = alignmentMethod && textSha && audioSha
      ? buildCompositionNarrationMap(parsed.data, {
        textSha256: textSha,
        audioSha256: audioSha,
        method: alignmentMethod,
        ...(typeof narrationMap?.narration_audio_duration === 'number'
          && typeof track?.duration === 'number'
          ? { audioDurationSec: track.duration }
          : {}),
      })
      : undefined;
    const legacyExpectedReceipt = alignmentMethod && textSha && audioSha
      ? {
        schema_version: 1,
        source: 'composition.materialize_narration',
        alignment_method: alignmentMethod,
        narration_text_sha256: textSha,
        narration_audio_sha256: audioSha,
        total_duration: parsed.data.composition.duration,
        ...(typeof narrationMap?.narration_audio_duration === 'number'
          && typeof track?.duration === 'number'
          ? { narration_audio_duration: track.duration }
          : {}),
        lines: parsed.data.scenes.flatMap((scene) => {
          const lineText = scene.narration_text?.trim() || '';
          if (!lineText) return [];
          const ids = scene.narration_refs.length
            ? scene.narration_refs
            : [`narration-${scene.id}`];
          return ids.map((id) => ({
            id,
            scene_id: scene.id,
            start: scene.start,
            duration: scene.duration,
            text: lineText,
          }));
        }),
      }
      : undefined;
    // narration-map.json is the durable materialization receipt written only
    // after measured audio, the retimed manifest, and their content hashes
    // agree. It is safe to restore a lost ledger binding from that receipt,
    // but not from a matching filename or a pair of hashes alone.
    const legacyMaterializationReceipt = narrationMapMatches
      && narrationMap?.schema_version === 1
      && narrationMap?.source === 'composition.materialize_narration'
      && !!legacyExpectedReceipt
      && stableJson(narrationMap) === stableJson(legacyExpectedReceipt);
    const materializationReceiptMatches = narrationMapMatches
      && narrationMap?.schema_version === 1
      && narrationMap?.source === 'composition.materialize_narration'
      && !!expectedReceipt
      && (stableJson(narrationMap) === stableJson(expectedReceipt)
        || legacyMaterializationReceipt);
    const html = await fs.readFile(path.join(compositionDirAbs, 'index.html'), 'utf8').catch(() => '');
    const htmlTrackMatches = (html.match(/<audio\b[^>]*>/gi) || []).some((tag) => {
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const src = (srcMatch?.[1] || srcMatch?.[2] || '').replace(/\\/g, '/').replace(/^\.\//, '');
      return src === 'assets/narration.mp3';
    });
    return {
      required,
      ...(textSha ? { textSha } : {}),
      ...(audioSha ? { audioSha } : {}),
      ...(track ? { duration: track.duration } : {}),
      narrationMapMatches,
      materializationReceiptMatches,
      ...(legacyMaterializationReceipt ? { legacyMaterializationReceipt: true } : {}),
      htmlTrackMatches,
      materialized: parsed.data.audio.owner === 'composition'
        && track?.src === 'assets/narration.mp3'
        && !!audioSha,
    };
  } catch {
    return {
      required: false,
      narrationMapMatches: false,
      materializationReceiptMatches: false,
      htmlTrackMatches: false,
      materialized: false,
    };
  }
}

type CompositionNarrationIdentity = Awaited<ReturnType<typeof currentNarrationIdentity>>;

function narrationAudioMatchesState(
  state: VideoProductionStateV1,
  identity: CompositionNarrationIdentity,
): boolean {
  return !!state.narration
    && identity.materialized
    && identity.narrationMapMatches
    && identity.textSha === state.narration.text_sha256
    && identity.audioSha === state.narration.audio_sha256
    && Math.abs((identity.duration || 0) - state.narration.measured_duration_sec) <= 0.01;
}

function narrationIdentityMatchesState(
  state: VideoProductionStateV1,
  identity: CompositionNarrationIdentity,
): boolean {
  return narrationAudioMatchesState(state, identity)
    && identity.narrationMapMatches
    && identity.htmlTrackMatches;
}

function narrationPolicyFacts(
  state: VideoProductionStateV1,
  identity: CompositionNarrationIdentity,
): VideoProductionPolicyFacts {
  return {
    narrationRequired: identity.required,
    narrationMaterialized: !identity.required || narrationIdentityMatchesState(state, identity),
  };
}

async function recordVideoStudioOperationState(input: {
  statePath: string;
  compositionDirAbs: string;
  op: string;
  turnId?: string;
  ok: boolean;
  stage?: VideoProductionStateV1['stage'];
  errorCode?: string;
  consumesSameInputAttempt?: boolean;
}): Promise<VideoProductionStateV1> {
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const narration = input.ok && input.op === 'composition.prepare'
    ? await currentNarrationIdentity(input.compositionDirAbs)
    : null;
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    const narrationIsCurrent = !!narration && narrationIdentityMatchesState(state, narration);
    if (input.stage) {
      const authoredVisuals = input.stage === 'visuals_ready'
        && artifactsShowAuthoredVisuals(state.artifacts, artifacts);
      state.stage = input.stage === 'scaffold_ready' && narrationIsCurrent
        ? 'narration_ready'
        : input.stage === 'visuals_ready' && !authoredVisuals
          ? narrationIsCurrent ? 'narration_ready' : 'scaffold_ready'
          : input.stage;
    }
    if (input.ok && input.op === 'composition.prepare') {
      invalidateVisualEvidenceUnlessCurrent(state, artifacts.visual_signature || '');
      delete state.draft;
    }
    if (input.ok && input.op === 'composition.inspect') {
      // Inspect normally runs BEFORE the snapshot, on freshly authored
      // visuals, so dropping an older preview is right. Dropping it
      // unconditionally also punished the redundant order — snapshot, then
      // inspect again to double-check — by discarding frames that still match
      // the bytes, forcing another full Chromium capture and answering the
      // next draft with "this composition requires a snapshot" (2026-08-09).
      // The visual signature is the same authority the draft's own staleness
      // check applies one step later, so a preview it still vouches for is
      // kept, and the more precise E_HTML_PREVIEW_STALE stays reachable.
      invalidateVisualEvidenceUnlessCurrent(state, artifacts.visual_signature || '');
      delete state.draft;
    }
    if (input.ok || !sameVideoProductionArtifacts(state.blocked_operation?.artifacts, artifacts)) {
      delete state.blocked_operation;
    }
    if (!input.ok && input.op === 'composition.snapshot' && input.errorCode === 'E_PREVIEW_QA_BLOCKED') {
      state.blocked_operation = {
        op: input.op,
        error_code: input.errorCode,
        artifacts,
        created_at: new Date().toISOString(),
      };
    }
    if (input.ok && input.op === 'composition.prepare' && state.narration && !narrationIsCurrent) {
      delete state.narration;
    }
    if (input.ok && input.op === 'composition.prepare' && !state.artifacts.scaffold_html_sha256) {
      artifacts.scaffold_html_sha256 = artifacts.html_sha256;
      artifacts.scaffold_visual_signature = artifacts.visual_signature;
    } else if (state.artifacts.scaffold_html_sha256) {
      artifacts.scaffold_html_sha256 = state.artifacts.scaffold_html_sha256;
      artifacts.scaffold_visual_signature = state.artifacts.scaffold_visual_signature;
    }
    const activeOperation = state.active_operation?.op === input.op
      ? state.active_operation
      : undefined;
    if (activeOperation) {
      const journal = state.operation_journal || [];
      const index = journal.findIndex(
        (entry) => entry.operation_id === activeOperation.operation_id,
      );
      if (index >= 0) {
        journal[index] = {
          ...journal[index],
          status: input.errorCode === 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED'
            ? 'interrupted'
            : input.ok ? 'passed' : 'failed',
          ...(input.errorCode ? { error_code: input.errorCode } : {}),
          ...(typeof input.consumesSameInputAttempt === 'boolean'
            ? { consumes_same_input_attempt: input.consumesSameInputAttempt }
            : {}),
          finished_at: new Date().toISOString(),
        };
        state.operation_journal = journal.slice(-100);
      }
    }
    recordVideoProductionTransition(state, {
      op: input.op,
      status: input.ok ? 'passed' : 'failed',
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.stage ? { stage: state.stage } : {}),
      artifacts,
    });
  });
}

async function startVideoStudioOperationState(input: {
  statePath: string;
  compositionDirAbs: string;
  op: string;
  turnId?: string;
  outputPath?: string;
  reportPath?: string;
  findingsPath?: string;
}): Promise<VideoProductionStateV1> {
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const operationId = crypto.randomUUID();
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    const startedAt = new Date().toISOString();
    state.active_operation = {
      operation_id: operationId,
      op: input.op,
      ...(artifacts.composition_signature
        ? { input_hash: artifacts.composition_signature }
        : {}),
      stage: state.stage,
      revision: state.revision + 1,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      ...(input.outputPath ? { output_path: input.outputPath } : {}),
      ...(input.reportPath ? { report_path: input.reportPath } : {}),
      ...(input.findingsPath ? { findings_path: input.findingsPath } : {}),
      started_at: startedAt,
    };
    state.operation_journal = [
      ...(state.operation_journal || []),
      {
        operation_id: operationId,
        op: input.op,
        ...(artifacts.composition_signature
          ? { input_hash: artifacts.composition_signature }
          : {}),
        status: 'started' as const,
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        ...(input.outputPath ? { output_path: input.outputPath } : {}),
        ...(input.reportPath ? { report_path: input.reportPath } : {}),
        ...(input.findingsPath ? { findings_path: input.findingsPath } : {}),
        started_at: startedAt,
      },
    ].slice(-100);
    recordVideoProductionTransition(state, {
      op: input.op,
      status: 'started',
      ...(input.turnId ? { turnId: input.turnId } : {}),
      stage: state.stage,
    });
  });
}

export async function recordVideoStudioGate(
  statePath: string,
  kind: 'preview' | 'draft',
  compositionDirAbs: string,
  turnId: string,
  result: Record<string, unknown> = {},
): Promise<boolean> {
  const isReady = kind === 'preview'
    ? result.preview_ready === true
      && isPassingResultSection(result.preview_qa)
      && isPassingPreflight(result.preflight)
    : result.draft_ready === true;
  if (!isReady) return false;
  // A rejected Promise.all returns while its sibling filesystem scans keep
  // running. On Windows that lets callers begin temp-tree cleanup while those
  // scans still hold files open. Settle every scan before propagating an error.
  const [signatureResult, visualSignatureResult, artifactsResult] = await Promise.allSettled([
    videoStudioCompositionSignature(compositionDirAbs),
    videoStudioVisualCompositionSignature(compositionDirAbs),
    videoProductionArtifacts(compositionDirAbs),
  ]);
  if (signatureResult.status === 'rejected') throw signatureResult.reason;
  if (visualSignatureResult.status === 'rejected') throw visualSignatureResult.reason;
  if (artifactsResult.status === 'rejected') throw artifactsResult.reason;
  const signature = signatureResult.value;
  const visualSignature = visualSignatureResult.value;
  const artifacts = artifactsResult.value;
  const framePaths = Array.isArray(result.frame_paths)
    ? result.frame_paths
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value))
    : [];
  await updateVideoProductionState(statePath, compositionDirAbs, (state) => {
    state[kind] = {
      signature,
      // Preview attests visual content only (it is silent); the visual
      // sub-identity is what its approval survives narration changes on.
      // Draft muxes audio and timing, so it stays bound to the full signature.
      ...(kind === 'preview' ? { visual_signature: visualSignature } : {}),
      ...(kind === 'preview' && typeof result.preview_revision === 'string' && result.preview_revision
        ? { revision_id: result.preview_revision }
        : {}),
      turn_id: turnId,
      created_at: new Date().toISOString(),
      status: 'ready',
      validation_version: 5,
      ...(kind === 'preview' && typeof result.contact_sheet === 'string' && result.contact_sheet
        ? { path: result.contact_sheet }
        : typeof result.path === 'string' && result.path ? { path: result.path } : {}),
      ...(framePaths.length ? { frame_paths: framePaths } : {}),
      ...(typeof result.report_path === 'string' && result.report_path ? { report_path: result.report_path } : {}),
      ...(kind === 'preview' && result.design_review_required === true ? {
        design_review: {
          required: true,
          status: 'pending',
        },
      } : {}),
      ...(kind === 'draft' ? {
        design_review: {
          required: result.design_review_required === true,
          status: result.design_review_required === true ? 'pending' : 'passed',
          ...(result.design_review_required === true ? {} : {
            reviewed_at: new Date().toISOString(),
            verdict: result.design_review_inherited_from_preview === true
              ? 'preview_review_inherited'
              : 'not_required',
          }),
        },
      } : {}),
    };
    if (kind === 'preview') {
      delete state.draft;
      state.stage = 'preview_ready';
    } else {
      state.stage = 'draft_ready';
    }
    const activeOperation = state.active_operation?.op === (
      kind === 'preview' ? 'composition.snapshot' : 'composition.draft'
    ) ? state.active_operation : undefined;
    if (activeOperation) {
      const journal = state.operation_journal || [];
      const index = journal.findIndex(
        (entry) => entry.operation_id === activeOperation.operation_id,
      );
      if (index >= 0) {
        journal[index] = {
          ...journal[index],
          status: 'passed',
          finished_at: new Date().toISOString(),
        };
        state.operation_journal = journal.slice(-100);
      }
    }
    recordVideoProductionTransition(state, {
      op: kind === 'preview' ? 'composition.snapshot' : 'composition.draft',
      status: 'passed',
      turnId,
      stage: state.stage,
      artifacts,
    });
  });
  return true;
}

function isPassingResultSection(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).ok === true
    && Number((value as Record<string, unknown>).error_count || 0) === 0;
}

function isPassingPreflight(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).status === 'passed'
    && Number((value as Record<string, unknown>).blocking_error_count || 0) === 0;
}

export async function approveVideoStudioGate(
  statePath: string,
  kind: 'draft',
  compositionDirAbs: string,
  currentTurnId: string,
  explicitlyApproved: boolean,
  submittedArtifactSignature?: string,
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  state = await migrateVideoStudioGateSignatureV5(statePath, kind, compositionDirAbs, state);
  const entry = state[kind];
  if (!entry) {
    return { ok: false, errorCode: 'E_DRAFT_QA_REQUIRED', message: 'Generate a passing composition.draft before final video confirmation.' };
  }
  if (submittedArtifactSignature
    && submittedArtifactSignature.toLowerCase() !== entry.signature.toLowerCase()) {
    return {
      ok: false,
      errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
      message: 'This decision belongs to an older rendered draft. It was not applied to the latest draft; keep the latest review open and show that current artifact without rendering or exporting again.',
      submitted_artifact_signature: submittedArtifactSignature.toLowerCase(),
      current_artifact_signature: entry.signature,
      submitted_decision_status: 'superseded',
    };
  }
  if (entry.signature !== await videoStudioGateSignature(compositionDirAbs, entry)) {
    return { ok: false, errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED', message: 'Composition inputs changed after the draft. Render a new draft.' };
  }
  if (!currentTurnId || entry.turn_id === currentTurnId) {
    return { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'Final video confirmation must come from a later explicit user turn.' };
  }
  // P3: model-scored design review is advisory and never blocks approval —
  // including legacy entries recorded with a pending review requirement.
  if (!explicitlyApproved) {
    return {
      ok: false,
      errorCode: 'E_GATE_D_EXPLICIT_APPROVAL_REQUIRED',
      message: 'The current real user message must explicitly confirm the displayed draft before composition.approve_draft can record final video approval.',
    };
  }
  const artifacts = await videoProductionArtifacts(compositionDirAbs);
  const approvedState = await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
    const nextEntry = next[kind];
    if (!nextEntry || nextEntry.signature !== entry.signature) {
      throw new Error('E_VIDEO_PRODUCTION_STATE_CONFLICT: gate changed while approval was being recorded.');
    }
    nextEntry.status = 'approved';
    nextEntry.approved_turn_id = currentTurnId;
    nextEntry.approved_at = new Date().toISOString();
    next.stage = 'draft_approved';
    recordVideoProductionTransition(next, {
      op: 'composition.approve_draft',
      status: 'passed',
      turnId: currentTurnId,
      stage: next.stage,
      artifacts,
    });
  });
  return { ok: true, entry: approvedState[kind]! };
}

/** Does this composition have frames of exactly its current bytes?
 *
 * The evidence a draft render needs, with no user decision in it. A snapshot
 * that was never taken, or one taken before the last edit, means there is
 * nothing to render from and nothing the user could have seen. */
export async function validateCompositionFrameEvidence(
  statePath: string,
  compositionDirAbs: string,
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  // Signature-version normalization, not approval logic: an entry recorded
  // under an older signature scheme covered a different file set, so it has to
  // be re-proved against the current one before its frames count as current.
  state = await migrateVideoStudioGateSignatureV5(statePath, 'preview', compositionDirAbs, state);
  const entry = state.preview;
  if (!entry) {
    return {
      ok: false,
      errorCode: 'E_HTML_PREVIEW_REQUIRED',
      message: 'This multi-scene or designed composition requires a passing composition.snapshot before mp4 rendering.',
    };
  }
  if (!(await previewStillVisuallyCurrent(compositionDirAbs, entry))) {
    return {
      ok: false,
      errorCode: 'E_HTML_PREVIEW_STALE',
      message: 'Composition inputs changed after the snapshot. Capture a new snapshot before rendering.',
    };
  }
  return { ok: true, entry };
}

export async function validateVideoStudioGate(
  statePath: string,
  kind: 'draft',
  compositionDirAbs: string,
  _currentTurnId: string,
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  state = await migrateVideoStudioGateSignatureV5(statePath, kind, compositionDirAbs, state);
  const entry = state[kind];
  if (!entry) {
    return { ok: false, errorCode: 'E_DRAFT_QA_REQUIRED', message: 'A successful composition.draft with video QA is required before high-quality export.' };
  }
  if (entry.signature !== await videoStudioGateSignature(compositionDirAbs, entry)) {
    return { ok: false, errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED', message: 'Composition inputs changed after the approved draft. Run composition.draft again and request final video confirmation.' };
  }
  // P3: design review is advisory; legacy pending entries do not block here.
  if (entry.status !== 'approved' || !entry.approved_turn_id || !entry.approved_at) {
    return { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'The draft exists but the final video has not been explicitly confirmed. Call composition.approve_draft only after the user confirms it.' };
  }
  return { ok: true, entry };
}

/** Enforce the keyframe preview stop for the delivered composition.
 *
 * The property this protects is a control-flow fact — the run stopped on the
 * frames and the user got a chance to look — not a claim the model can
 * evidence. Two earlier designs tried to verify it from tool-call-local
 * evidence and both were routed around: quote provenance was met with a
 * fabricated quote, and turn ordering was met with a "继续" the user had said
 * to resume an interrupted run, before the frames existed. Whether the frames
 * actually reached the user is simply not observable from inside a tool call.
 *
 * So the stop is made structural instead of inferred: a render attempted in
 * the same turn that captured the frames is refused AND ends the turn
 * (`endTurn`), so the model cannot negotiate, re-word, or loop — the run stops
 * on the frames, which are published with it. The go-ahead is then just what
 * it looks like: the user speaking in a later turn. No decision evidence is
 * required, because a quote never proved the property anyway.
 */
/** Record preview authorization only when the model chooses the owning
 *  operation, `composition.draft`. Read-only/status operations must not turn
 *  an arbitrary user question into a durable go-ahead. The model owns the
 *  semantic decision; the host owns temporal and visual-identity validation. */
async function recordKeyframePreviewGoAhead(input: {
  statePath: string;
  compositionDirAbs: string;
  state: VideoProductionStateV1;
  opts: VideoStudioToolOpts;
}): Promise<VideoProductionStateV1> {
  const entry = input.state.preview;
  if (!entry) return input.state;
  const parentLink = parentEdlLinkOf(input.state);
  const captureTurn = String(entry.turn_id || '');
  const currentTurn = String(input.opts.turnId || '');
  if (!captureTurn || !currentTurn || captureTurn === currentTurn) return input.state;
  if (!currentUserTurnAvailable(input.opts.userMessage)) return input.state;
  // A segment's reply belongs to the production, not to the segment: the stop
  // it answered covers every sibling, and the answer has to be somewhere they
  // can all read it. Recording it in this composition's own state would stop
  // the next segment too, which is the per-segment stop the protocol forbids.
  if (parentLink.segmentId) {
    if (!parentLink.planPath) return input.state;
    const controlPath = videoProductionControlStatePath({
      userId: input.opts.userId,
      planPath: parentLink.planPath,
    });
    const control = await readVideoProductionControlState(controlPath, parentLink.planPath)
      .catch(() => null);
    const productionSignature = String(control?.plan_approval?.signature || control?.plan_signature || '');
    if (!productionSignature) return input.state;
    const productionVisualSignature = await currentProductionPreviewVisualSignature(
      input.opts,
      parentLink.planPath,
    );
    if (!productionVisualSignature) return input.state;
    await recordVideoProductionPreviewGoAhead({
      statePath: controlPath,
      planPath: parentLink.planPath,
      planSignature: productionSignature,
      visualSignature: productionVisualSignature,
      turnId: currentTurn,
    });
    return input.state;
  }
  const planSignature = String(input.state.plan_approval?.signature || '');
  if (!planSignature) return input.state;
  if (input.state.preview_go_ahead?.plan_signature === planSignature) return input.state;
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    state.preview_go_ahead = {
      plan_signature: planSignature,
      turn_id: currentTurn,
      created_at: new Date().toISOString(),
    };
  });
}

/** Grant the next visual-QA cycle when the user replies to an exhausted one.
 *
 *  The per-cycle budget bounds retrying ONE strategy. It used to be reopened by
 *  `composition.begin_visual_revision`, an operation the model called on its
 *  own — so the budget bounded a cycle and nothing bounded the cycles. On
 *  2026-08-07 a CTA scene alternated between "never visible" and "visible in
 *  every frame" across three self-granted cycles and about twelve minutes,
 *  never stopping to ask, and the run ended with the model inventing a QA
 *  waiver it had no authority to grant.
 *
 *  The operation is gone. An exhausted cycle ends the turn on the user, and
 *  their reply is what buys the next one — so the bound is a person, not a
 *  counter. A reply that asks to skip the check instead reaches
 *  `waive_qa_findings` and leaves this cycle unused, which costs nothing. The
 *  failed strategies stay in `visual_qa.history` precisely so the next cycle
 *  can be told not to repeat them. */
async function grantVisualQaCycleOnUserTurn(input: {
  statePath: string;
  compositionDirAbs: string;
  state: VideoProductionStateV1;
  opts: VideoStudioToolOpts;
}): Promise<VideoProductionStateV1> {
  if (input.state.draft?.status === 'approved') return input.state;
  // Read through the legacy shape so an old record is recognised, then hand it
  // straight back: a cycle recorded in the pre-cycle shape, or by an older
  // inspector, is invalidated by its own `visual_qa_cycle_stale` path, which
  // re-proves the composition against the current checks. Granting a fresh
  // cycle over it would erase that signal before anyone acted on it.
  const cycle = legacyVisualQaCycle(input.state.visual_qa);
  if (cycle && !currentVisualQaCycle(input.state.visual_qa)) return input.state;
  const currentTurn = String(input.opts.turnId || '');
  // The turn that exhausted the budget is the turn that presents it; only a
  // LATER real user turn is a reply to that presentation.
  if (!currentTurn || !cycle) return input.state;
  if (String(cycle.exhausted_by_turn_id || '') === currentTurn) return input.state;
  if (!currentUserTurnAvailable(input.opts.userMessage)) return input.state;
  const drained = cycle.status === 'exhausted'
    || cycle.failed_signatures.length >= cycle.max_repair_passes + 1;
  // A partly spent cycle whose last failure came from an earlier turn is an
  // ABANDONED repair episode. The budget bounds how far the model repairs
  // WITHOUT the user, so charging an abandoned episode's spend to the run the
  // user just started is the same as never having consulted them. 2026-08-08:
  // a cycle opened the previous evening carried 2 of its 2 passes into a fresh
  // session, the first failure of the new run hit the wall seven minutes in,
  // and the model told the user it had done "3 repair rounds" — two of them
  // belonged to a conversation the user was no longer in.
  //
  // The stamp is required, not assumed: a cycle recorded before it existed, or
  // seeded by a caller that does not stamp, cannot be proven abandoned, and
  // erasing a live episode's failed signatures would lose the record that makes
  // "try a different strategy" enforceable.
  const abandoned = !drained
    && cycle.failed_signatures.length > 0
    && !!cycle.last_failure_turn_id
    && cycle.last_failure_turn_id !== currentTurn;
  if (!drained && !abandoned) return input.state;
  const visualRevision = nextVisualRevision(input.state.visual_qa);
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    next.visual_qa = {
      cycle: newVisualQaCycle({ visualRevision, turnId: currentTurn }),
      history: visualQaHistoryWithCurrent(next.visual_qa),
    };
    delete next.blocked_operation;
    recordVideoProductionTransition(next, {
      op: 'composition.status',
      status: 'passed',
      turnId: currentTurn,
      stage: next.stage,
    });
  });
}

/** Identity of the complete production preview: segment order plus the current
 * visual bytes of every captured child/media segment. Narration and other
 * non-visual plan fields are deliberately absent. */
async function currentProductionPreviewVisualSignature(
  opts: VideoStudioToolOpts,
  planPath: string,
): Promise<string> {
  const identity = await readVideoProductionPlanIdentity(planPath).catch(() => null);
  if (!identity) return '';
  const records = await videoProductionSegmentReviewRecords({
    opts,
    planPathAbs: planPath,
    identity,
    roots: allowedRoots(opts),
  }).catch(() => []);
  const review = videoProductionReviewStatus({
    identity,
    facts: records.map((record) => record.fact),
  });
  if (!review.renderable) return '';
  return crypto.createHash('sha256').update(stableJson(review.segments.map((segment) => ({
    segment_id: segment.segment_id,
    visual_signature: segment.visual_signature,
  })))).digest('hex');
}

/** Has this segment's production already had its current visual preview stop answered? */
async function productionPreviewGoAheadGranted(
  opts: VideoStudioToolOpts,
  state: VideoProductionStateV1,
): Promise<{ granted: boolean }> {
  const link = parentEdlLinkOf(state);
  if (!link.segmentId || !link.planPath) return { granted: false };
  const control = await readVideoProductionControlState(
    videoProductionControlStatePath({ userId: opts.userId, planPath: link.planPath }),
    link.planPath,
  ).catch(() => null);
  const goAhead = control?.preview_go_ahead;
  if (!goAhead) return { granted: false };
  const signature = String(control?.plan_approval?.signature || control?.plan_signature || '');
  const visualSignature = await currentProductionPreviewVisualSignature(opts, link.planPath);
  return {
    granted: !!signature
      && !!visualSignature
      && goAhead.plan_signature === signature
      && goAhead.visual_signature === visualSignature,
  };
}

function keyframePreviewStopBlock(input: {
  state: VideoProductionStateV1;
  entry?: VideoProductionGateEntry;
  opts: VideoStudioToolOpts;
  /** For a segment: whether the PRODUCTION already has the user's go-ahead. */
  productionPreviewGoAhead?: boolean;
}): Record<string, unknown> | undefined {
  const entry = input.entry || input.state.preview;
  if (!entry) return undefined;
  // A segment of an assembled production does not stop on its own frames —
  // per-segment stops are what the protocol forbids — but it defers to the
  // production's ONE stop, and for a long time that stop existed only in this
  // comment: there is no production-level render or export operation to host
  // it, the assembly is ffmpeg driven by the model, so nothing ever asked.
  // Measured twice on 2026-08-08 in one run: the first delivery went capture
  // straight to finished video, and a user-requested frame fix was captured
  // (16:37:51, 16:38:29) and rendered (16:38:49) inside a single turn — the
  // change the user asked to see became the final video without being shown.
  // So the deferral now has to point at something: the first segment to draft
  // carries the stop until the production records a go-ahead, and every
  // segment after that renders straight through.
  const autoChild = !!parentEdlLinkOf(input.state).segmentId;
  if (autoChild) {
    if (input.productionPreviewGoAhead) return undefined;
  } else {
    // The stop happens once per visual identity. Re-capturing unchanged bytes
    // does not reopen it; a visible edit invalidates the preview/go-ahead
    // bundle before capture. A narration-only amendment re-keys the same
    // visual go-ahead during plan approval.
    const planSignature = String(input.state.plan_approval?.signature || '');
    const goAhead = input.state.preview_go_ahead;
    if (planSignature && goAhead?.plan_signature === planSignature) return undefined;
  }

  const captureTurn = String(entry.turn_id || '');
  const currentTurn = String(input.opts.turnId || '');
  const sameTurnAsCapture = !!captureTurn && captureTurn === currentTurn;

  const framePaths = (entry.frame_paths || []).slice(0, 24);
  return {
    ok: false,
    op: 'composition.draft',
    errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
    message: sameTurnAsCapture
      ? 'These frames were captured in this same turn, so the user has not seen them. Do not retry this call — it cannot succeed until they reply. Write the keyframe preview message NOW: name each frame path below, invite changes in one line, end the turn with the interaction marker, and render on their next reply.'
      : 'The keyframe preview is still pending a user reply. Do not retry this call. Present the frames below with their paths, invite changes, and end the turn; render after they respond.',
    contact_sheet: entry.path || '',
    frame_paths: framePaths,
    ...(entry.frame_paths && entry.frame_paths.length > framePaths.length
      ? { frame_paths_omitted: entry.frame_paths.length - framePaths.length }
      : {}),
    frames_captured_this_turn: sameTurnAsCapture,
    requires_user_decision: true,
    next_step_owner: 'user',
    interaction_required: true,
    automatic_recovery_expected: false,
    same_turn_continuation_required: false,
    billable_request_sent: false,
    next_action: 'present_keyframe_preview_and_end_turn',
  };
}

/** How the narration retime should divide the target duration across scenes.
 *
 * Speech time is reserved: a narrated scene weighs its estimated speech
 * duration, because a window shorter than its own line cuts the voice off.
 * Whatever time remains is shared among the SILENT scenes in proportion to the
 * durations the design gave them — a silent hook, title card or payoff hold is
 * a deliberate beat, not filler.
 *
 * The previous rule weighed a silent scene at 3% of its authored duration,
 * which did not shorten it so much as delete it: on 2026-08-06 a 5.875s
 * opening hook was retimed to 0.224s — seven frames — and every sampled frame
 * around it came back blank, which read as a rendering defect rather than the
 * timing decision it was. When speech alone already exceeds the target there
 * is nothing to share, so silent scenes fall back to a floor and the
 * narration-overflow QA reports the real problem.
 */
function narrationSceneWeights(
  manifest: CompositionManifest,
  targetDurationSec: number,
  effectiveSpeed: number,
): number[] {
  const MIN_WEIGHT = 0.05;
  const speech = manifest.scenes.map((scene) => {
    const text = scene.narration_text?.trim() || '';
    return text ? Math.max(MIN_WEIGHT, estimateNarrationDuration(text, effectiveSpeed).estimatedSec) : 0;
  });
  const authoredSilent = manifest.scenes.map((scene, index) => (
    speech[index] > 0 ? 0 : Math.max(MIN_WEIGHT, scene.duration)
  ));
  const totalSpeech = speech.reduce((sum, value) => sum + value, 0);
  const totalSilent = authoredSilent.reduce((sum, value) => sum + value, 0);
  const remaining = Number.isFinite(targetDurationSec) ? targetDurationSec - totalSpeech : 0;
  if (!(totalSilent > 0) || !(remaining > 0)) {
    return manifest.scenes.map((_, index) => (
      speech[index] > 0 ? speech[index] : MIN_WEIGHT
    ));
  }
  return manifest.scenes.map((_, index) => (
    speech[index] > 0
      ? speech[index]
      : Math.max(MIN_WEIGHT, remaining * authoredSilent[index] / totalSilent)
  ));
}

function narrationTimingBudget(
  manifest: CompositionManifest,
  deliveryTargetDurationSec: number,
): { targetDurationSec: number; reservedSilentDurationSec: number } {
  const reservedSilentDurationSec = Math.round(manifest.scenes.reduce((sum, scene) => (
    scene.narration_text?.trim() ? sum : sum + scene.duration
  ), 0) * 1000) / 1000;
  return {
    targetDurationSec: Math.max(0.5, Math.round(
      (deliveryTargetDurationSec - reservedSilentDurationSec) * 1000,
    ) / 1000),
    reservedSilentDurationSec,
  };
}

function interstitialSilentSceneIds(manifest: CompositionManifest): string[] {
  const narrated = manifest.scenes.flatMap((scene, index) => (
    scene.narration_text?.trim() ? [index] : []
  ));
  if (narrated.length < 2) return [];
  const first = narrated[0];
  const last = narrated.at(-1)!;
  return manifest.scenes
    .slice(first + 1, last)
    .filter((scene) => !scene.narration_text?.trim())
    .map((scene) => scene.id);
}

/** Test seam for the scene-weight rule: the retime it feeds is only reachable
 *  through a billable narration call. */
export const _narrationSceneWeightsForTest = narrationSceneWeights;

/** Whether the ASSEMBLED production this segment belongs to needs a keyframe
 * preview — judged on the parent EDL, because the promise is per video, not
 * per segment. The per-segment thresholds exempted every segment of a real
 * 60s six-segment promo (each under 20s, one scene each), so the production
 * stop that the segment exemption defers to was never evaluated: on
 * 2026-08-08 all five segments went snapshot -> draft -> ffmpeg assembly with
 * `preview_go_ahead: null`, twice in one day, and the user asked twice why no
 * preview ever appeared. Same thresholds, applied to the whole video: total
 * target duration, and the scene count summed across compose segments.
 * Unreadable plans fall back to the segment-level answer instead of inventing
 * a requirement. */
async function assembledProductionPreviewRequired(planPathAbs: string): Promise<boolean> {
  try {
    const plan = JSON.parse(await fs.readFile(planPathAbs, 'utf8')) as Record<string, unknown>;
    const totalSec = Number(plan.total_target_sec);
    if (Number.isFinite(totalSec) && totalSec >= 20) return true;
    const segments = Array.isArray(plan.segments) ? plan.segments : [];
    let sceneCount = 0;
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) continue;
      const record = segment as Record<string, unknown>;
      if (record.source !== 'compose') continue;
      const spec = record.spec && typeof record.spec === 'object' && !Array.isArray(record.spec)
        ? record.spec as Record<string, unknown>
        : {};
      const binding = spec.composition_plan && typeof spec.composition_plan === 'object'
        && !Array.isArray(spec.composition_plan)
        ? spec.composition_plan as Record<string, unknown>
        : {};
      sceneCount += Array.isArray(binding.scenes) ? binding.scenes.length : 0;
    }
    return sceneCount >= 3;
  } catch {
    return false;
  }
}

export async function videoStudioPreviewRequired(compositionDirAbs: string): Promise<boolean> {
  const manifestRaw = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8').catch(() => '');
  if (manifestRaw) {
    try {
      const parsed = CompositionManifestSchema.safeParse(JSON.parse(manifestRaw));
      if (parsed.success) {
        return parsed.data.composition.duration >= 20 || parsed.data.scenes.length >= 3;
      }
    } catch { /* invalid manifests are blocked by preflight */ }
  }
  const html = await fs.readFile(path.join(compositionDirAbs, 'index.html'), 'utf8').catch(() => '');
  const duration = Number(html.match(/\bdata-duration\s*=\s*["']([^"']+)["']/i)?.[1] || 0);
  const sceneMap = await fs.readFile(path.join(compositionDirAbs, 'scene-map.json'), 'utf8').catch(() => '');
  let sceneCount = 0;
  try {
    const value = JSON.parse(sceneMap) as Record<string, unknown>;
    const scenes = Array.isArray(value.scenes) ? value.scenes : Array.isArray(value.shots) ? value.shots : [];
    sceneCount = scenes.length;
  } catch { /* fall back to semantic HTML hooks below */ }
  if (!sceneCount) {
    sceneCount = new Set([...html.matchAll(/\bdata-scene-id\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])).size;
  }
  return duration >= 20 || sceneCount >= 3;
}

async function videoStudioReferenceReviewRequirement(compositionDirAbs: string): Promise<{
  required: boolean;
  minimumScore: number;
}> {
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    const artDirection = manifest.art_direction && typeof manifest.art_direction === 'object'
      && !Array.isArray(manifest.art_direction)
      ? manifest.art_direction as Record<string, unknown>
      : {};
    const references = Array.isArray(artDirection.references) ? artDirection.references : [];
    const fidelity = artDirection.reference_fidelity && typeof artDirection.reference_fidelity === 'object'
      && !Array.isArray(artDirection.reference_fidelity)
      ? artDirection.reference_fidelity as Record<string, unknown>
      : {};
    const verification = fidelity.verification && typeof fidelity.verification === 'object'
      && !Array.isArray(fidelity.verification)
      ? fidelity.verification as Record<string, unknown>
      : {};
    const required = Object.keys(fidelity).length > 0 || references.length > 0;
    const declaredMinimum = Number(verification.minimum_score);
    const mode = String(fidelity.mode || '').trim().toLowerCase();
    const minimumScore = Number.isFinite(declaredMinimum)
      ? Math.min(100, Math.max(70, declaredMinimum))
      : mode === 'exact' ? 85 : 70;
    return { required, minimumScore };
  } catch {
    return { required: false, minimumScore: 70 };
  }
}

/** Refusal content when a required path argument does not name a readable
 *  file, or null when it does. The bare `input is not a file: <path>` this
 *  replaced carried no error code, no next action, and no argument name — the
 *  same string answered a missing `plan_path` and a `speech.transcribe`
 *  `input_path`, so the model could not tell which of its arguments was wrong
 *  or whether the file was absent or merely a directory (2026-08-09 run). */
async function ensureInputFile(
  absPath: string,
  argument: 'plan_path' | 'input_path' | 'delivered_video_path',
): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  if (st?.isFile()) return null;
  const missing = !st;
  return resultContent({
    ok: false,
    errorCode: missing ? 'E_INPUT_FILE_NOT_FOUND' : 'E_INPUT_NOT_A_FILE',
    message: missing
      ? `${argument} does not exist here yet: ${absPath}`
      : `${argument} names a directory, not a file: ${absPath}`,
    next_action: 'retry_with_the_path_that_holds_the_file',
  });
}

/** Inspection result when composition_dir does not name a usable directory.
 *  Twin of ensureInputFile above and fixed for the same
 *  reason: the bare `composition_dir is not a directory: <path>` it replaced
 *  carried no error code, no next action, and did not separate a directory
 *  that does not exist yet from a path that is a file. The AUTO-child branch
 *  below answers its own case. The `exists` fact also lets the read-only
 *  status operation distinguish a fresh composition from a mistyped file. */
async function inspectInputDir(absPath: string): Promise<{
  error: string | null;
  exists: boolean;
}> {
  const st = await fs.stat(absPath).catch(() => null);
  if (st?.isDirectory()) return { error: null, exists: true };
  const missing = !st;
  return {
    exists: !missing,
    error: resultContent({
      ok: false,
      errorCode: missing ? 'E_COMPOSITION_DIR_NOT_FOUND' : 'E_COMPOSITION_DIR_NOT_A_DIRECTORY',
      message: missing
        ? `composition_dir does not exist yet: ${absPath}. Author composition-manifest.json there first, then call composition.prepare to create the generated index.html scaffold; or pass the directory that already holds the composition.`
        : `composition_dir names a file, not a directory: ${absPath}.`,
      next_action: 'retry_with_the_composition_directory',
    }),
  };
}

async function notifyWritten(opts: VideoStudioToolOpts, paths: Array<unknown>): Promise<void> {
  if (!opts.onFileWritten) return;
  const seen = new Set<string>();
  const queue = [...paths];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value !== 'string' || !value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try { await opts.onFileWritten(abs); }
    catch (err) { log.warn('onFileWritten failed', { error: logErrorSummary(err) }); }
  }
}

async function publishVisibleOutputs(opts: VideoStudioToolOpts, paths: Array<unknown>): Promise<void> {
  if (!opts.onOutputsPublished) return;
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...paths];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value !== 'string' || !value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  if (!out.length) return;
  try { await opts.onOutputsPublished(out); }
  catch (err) { log.warn('onOutputsPublished failed', { error: logErrorSummary(err) }); }
}

async function finalizeVideoBeforePublish(
  opts: VideoStudioToolOpts,
  op: 'composition.draft' | 'composition.export',
  outputPath: unknown,
  coverPath?: unknown,
): Promise<void> {
  if (typeof outputPath !== 'string' || !outputPath) return;
  try {
    // Both draft and export videos are user-visible deliverables. Finalize them
    // before returning the tool result so a streamed chat-media link never
    // exposes the clean render before output policy post-processing completes.
    await finalizeProducedFile(path.resolve(outputPath), {
      userId: opts.userId,
      ...(opts.cid ? { cid: opts.cid } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      source: op === 'composition.draft'
        ? 'video_studio.draft_pre_publish'
        : 'video_studio.export_pre_publish',
    });
    if (typeof coverPath === 'string' && coverPath) {
      await finalizeProducedFile(path.resolve(coverPath), {
        userId: opts.userId,
        ...(opts.cid ? { cid: opts.cid } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        source: op === 'composition.draft'
          ? 'video_studio.draft_cover_pre_publish'
          : 'video_studio.export_cover_pre_publish',
      });
    }
  } catch (err) {
    log.warn(`${op} pre-publish finalization failed`, { error: logErrorSummary(err) });
  }
}

async function prepareVideoStudioModelVisual(
  absPath: string,
): Promise<{ data: string; mediaType: 'image/png' | 'image/webp' } | null> {
  try {
    const source = await fs.readFile(absPath);
    const prepared = await prepareLosslessModelImage(source);
    return {
      data: prepared.buf.toString('base64'),
      mediaType: prepared.mediaType,
    };
  } catch (err) {
    // Native snapshot/draft paths are expected to be valid PNGs. Keep older
    // mocked/legacy hosts compatible, but never label unreadable bytes as
    // model-visible evidence.
    log.warn('video visual evidence attachment skipped', {
      path: absPath,
      error: logErrorSummary(err),
    });
    return null;
  }
}

export function deriveVideoStudioOutcome(
  result: Record<string, unknown>,
): 'continue' | 'need_user' | 'stop' {
  if (result.ok === true) return result.op === 'composition.export' ? 'stop' : 'continue';
  if (result.next_step_owner === 'user'
    || result.requires_user_decision === true
    || result.interaction_required === true) {
    return 'need_user';
  }
  return 'continue';
}

const VIDEO_STUDIO_ERROR_CLASS_RULES: Array<{ re: RegExp; cls: string }> = [
  { re: /^E_(?:DECISION_EVIDENCE|DESIGN_REVIEW_(?:SCORES?|VERDICT|SCORE)|PATH_OUT_OF_SCOPE|PARENT_COMPOSITION_BINDING)/, cls: 'input_error' },
  { re: /^E_(?:GATE_USER_TURN_REQUIRED|REPEATED_FAILURE_USER_DECISION_REQUIRED|VIDEO_REVIEW_SUBMISSION_SUPERSEDED|NARRATION_TIMING_USER_DECISION_REQUIRED)/, cls: 'user_turn_required' },
  { re: /APPROVAL_REQUIRED|APPROVAL_TURN_REQUIRED|EXPLICIT_APPROVAL/, cls: 'user_turn_required' },
  { re: /^E_(?:VIDEO_STUDIO_SKILL_OUTDATED|VIDEO_STUDIO_HOST_OUTDATED)/, cls: 'user_turn_required' },
  { re: /^E_TTS_RETRY_EPISODE_EXHAUSTED|BUDGET_EXCEEDED|RETRY_NO_CHANGE|ALREADY_PASSED/, cls: 'budget' },
  { re: /^E_(?:TTS_MEASURED_DURATION_MISMATCH|NARRATION_TIMING_REVISION_REQUIRED|NARRATION_TIMING_WAIVER_MATERIALIZATION_REQUIRED)/, cls: 'narration_timing' },
  { re: /^E_TTS_TEXT_(?:TOO_LONG|TOO_SHORT)/, cls: 'input_error' },
  { re: /^E_TTS_|PROVIDER|^E_VIDEO_QA_BLOCKED|TIMEOUT/, cls: 'provider_error' },
];

export function deriveVideoStudioErrorClass(errorCode: unknown): string | undefined {
  const code = typeof errorCode === 'string' ? errorCode : '';
  if (!code) return undefined;
  for (const rule of VIDEO_STUDIO_ERROR_CLASS_RULES) {
    if (rule.re.test(code)) return rule.cls;
  }
  return 'precondition';
}

export function deriveVideoStudioPlanGateClass(
  errorCode: unknown,
): 'artifact_repair' | 'intent_amendment' | undefined {
  const code = typeof errorCode === 'string' ? errorCode : '';
  if (!code.startsWith('E_GATE_B_')) return undefined;
  const needsUser = code === 'E_GATE_B_ARTIFACT_CHANGED'
    || code === 'E_GATE_B_APPROVAL_REQUIRED'
    || code === 'E_GATE_B_EXPLICIT_APPROVAL_REQUIRED'
    || code === 'E_GATE_B_APPROVE_PLAN_REQUIRED';
  return needsUser ? 'intent_amendment' : 'artifact_repair';
}

function resultContent(result: Record<string, unknown>, renamedNote = ''): string {
  // Every JSON protocol result names the host tool contract so skills can
  // verify they are reading the protocol generation they were written for.
  // Serialization is also where the model-facing projection applies, so every
  // return path — including early gate refusals — carries the same bounded
  // envelope instead of the full durable-state echo.
  const compact = compactQaBlockedVideoStudioResult(result as VideoStudioResult) as unknown as Record<string, unknown>;
  const errorClass = deriveVideoStudioErrorClass(compact.errorCode);
  const planGateClass = deriveVideoStudioPlanGateClass(compact.errorCode);
  return `${JSON.stringify({
    contract_version: VIDEO_STUDIO_TOOL_CONTRACT,
    outcome: deriveVideoStudioOutcome(compact),
    ...(errorClass ? { error_class: errorClass } : {}),
    ...(planGateClass ? { plan_gate_class: planGateClass } : {}),
    ...compact,
  }, null, 2)}${renamedNote}`;
}

export function resultConsumesFullRenderTurnBudget(result: Record<string, unknown>): boolean {
  const errorCode = typeof result.errorCode === 'string' ? result.errorCode : '';
  if (errorCode && isEnvironmentalDraftFailure(errorCode)) return false;
  const report = result.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  const steps = (report as Record<string, unknown>).steps;
  return !!steps && typeof steps === 'object' && !Array.isArray(steps)
    && !!(steps as Record<string, unknown>).render;
}

async function compositionDoctor(compositionDirAbs: string): Promise<Record<string, unknown>> {
  const bins = bundledFfmpegPaths();
  const whisper = bundledWhisperPaths();
  const executable = async (value: string | undefined): Promise<boolean> => !!value
    && fs.access(value, 1).then(() => true).catch(() => false);
  const [ffmpegReady, ffprobeReady, whisperCliReady, whisperModelReady] = await Promise.all([
    executable(bins.ffmpeg),
    executable(bins.ffprobe),
    executable(whisper.cli),
    whisper.model ? fs.access(whisper.model).then(() => true).catch(() => false) : Promise.resolve(false),
  ]);
  let browserWindowAvailable = false;
  try {
    const electron = await import('electron') as unknown as { BrowserWindow?: unknown };
    browserWindowAvailable = typeof electron.BrowserWindow === 'function';
  } catch { /* reported below */ }
  const writable = await fs.access(compositionDirAbs, 2).then(() => true).catch(() => false);
  let narrationRequested = false;
  let narrationSelection: CompositionNarrationSelectionResult | undefined;
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    // Narration readiness belongs to whoever will synthesize the audio. An
    // assembled child carries the words so its frames can be timed and
    // captioned, but the parent EDL signs the voice and mixes it. Asking the
    // child here demanded an `audio.narration_intent` that
    // `composition.approve_plan` refuses on exactly the same manifest
    // (`E_PARENT_COMPOSITION_AUDIO_OWNERSHIP`), so a narrated AUTO segment
    // could satisfy neither check and production stopped with nothing to fix.
    narrationRequested = !!compositionNarrationText(manifest)
      && manifest.audio.owner !== 'assembler';
    if (narrationRequested) {
      narrationSelection = await resolveCompositionNarrationSelection({ manifest });
    }
  } catch { /* manifest readiness is reported by prepare */ }
  const ttsProviderReady = hasConfiguredTtsProvider();
  const ttsAvailability = ttsProviderReady
    ? { available: true as const, reason: 'available' as const }
    : getTtsAvailabilityDetails(false);
  const checks = {
    workspace_write: { ok: writable, required: true },
    ffmpeg: { ok: ffmpegReady, required: true },
    ffprobe: { ok: ffprobeReady, required: true },
    browser_window: { ok: browserWindowAvailable, required: true },
    tts_provider: {
      ok: ttsProviderReady,
      required: narrationRequested,
      availability: ttsAvailability.reason,
      ...(!ttsAvailability.available ? {
        error_code: ttsAvailability.errorCode,
        message: ttsAvailability.message,
        next_action: ttsAvailability.nextAction,
      } : {}),
    },
    tts_selection: {
      ok: !narrationRequested || narrationSelection?.ok === true,
      required: narrationRequested,
      ...(narrationSelection?.ok === false ? {
        error_code: narrationSelection.errorCode,
        message: narrationSelection.message,
      } : {}),
    },
    whisper: { ok: whisperCliReady && whisperModelReady, required: false },
  };
  const blocking = Object.entries(checks)
    .filter(([, check]) => check.required && !check.ok)
    .map(([name]) => name);
  return {
    ok: blocking.length === 0,
    op: 'composition.doctor',
    status: blocking.length ? 'blocked' : 'ready',
    checks,
    blocking_capabilities: blocking,
    narration_required: narrationRequested,
    ...(narrationSelection?.ok === true ? {
      narration_selection: {
        route_ref: narrationSelection.selection.routeRef,
        voice_ref: narrationSelection.selection.voiceRef,
        display_name: narrationSelection.selection.displayName,
        language: narrationSelection.selection.language,
        provider: narrationSelection.selection.provider,
        model: narrationSelection.selection.model,
        catalog_status: narrationSelection.selection.catalogStatus,
        speed: narrationSelection.speed,
        legacy: narrationSelection.legacy,
      },
    } : {}),
    message: blocking.length
      ? `Video production runtime is missing required capabilities: ${blocking.join(', ')}.`
      : 'Video production runtime is ready.',
  };
}

async function recordCompositionDoctorResult(
  statePath: string,
  compositionDirAbs: string,
  result: Record<string, unknown>,
  turnId?: string,
): Promise<VideoProductionStateV1> {
  return updateVideoProductionState(statePath, compositionDirAbs, (next) => {
    next.capability_check = {
      status: result.ok === true ? 'ready' : 'blocked',
      blocking_capabilities: Array.isArray(result.blocking_capabilities)
        ? result.blocking_capabilities.map(String)
        : [],
      narration_required: result.narration_required === true,
      platform: process.platform,
      arch: process.arch,
      checked_at: new Date().toISOString(),
    };
    recordVideoProductionTransition(next, {
      op: 'composition.doctor',
      status: result.ok === true ? 'passed' : 'failed',
      ...(turnId ? { turnId } : {}),
      ...(result.ok === true ? {} : { errorCode: 'E_VIDEO_PRODUCTION_CAPABILITY_MISSING' }),
      stage: next.stage,
    });
  });
}

async function reconcileVideoProduction(input: {
  compositionDirAbs: string;
  statePath: string;
  roots: string[];
  turnId?: string;
  ctx?: ToolContext;
}): Promise<Record<string, unknown>> {
  const manifestPath = path.join(input.compositionDirAbs, 'composition-manifest.json');
  const htmlPath = path.join(input.compositionDirAbs, 'index.html');
  let manifest: CompositionManifest;
  try {
    manifest = CompositionManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  } catch (err) {
    const failure = compositionManifestFailure(err);
    return {
      ok: false,
      op: 'composition.reconcile',
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: failure.missing
        ? 'There is no composition-manifest.json here to reconcile. For an AUTO child, composition.approve_plan with the parent plan_path and segment_id derives it; a standalone composition authors it before composition.prepare.'
        : `Cannot reconcile an invalid composition manifest: ${failure.detail}`,
    };
  }
  const currentState = await readVideoProductionState(input.statePath, input.compositionDirAbs);
  const originalHtml = await fs.readFile(htmlPath, 'utf8').catch(() => '');
  if (!originalHtml) {
    const state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      next.stage = 'manifest_ready';
      recordVideoProductionTransition(next, {
        op: 'composition.reconcile',
        status: 'passed',
        turnId: input.turnId,
        stage: 'manifest_ready',
      });
    });
    return {
      ok: true,
      op: 'composition.reconcile',
      status: 'manifest_ready',
      changed: false,
      next_action: 'composition.prepare',
      production_state: summarizeVideoProductionState(state),
    };
  }
  const reconciled = reconcileCompositionHtml(originalHtml, manifest);
  if (!reconciled.ok) {
    return {
      ok: false,
      op: 'composition.reconcile',
      errorCode: 'E_COMPOSITION_RECONCILE_BLOCKED',
      message: reconciled.issues[0]?.message || 'Protected composition structure could not be reconciled.',
      issues: reconciled.issues,
      blocked_operation: 'composition.reconcile',
      requires_user_decision: false,
      allowed_recovery_ops: ['composition.status', 'composition.reconcile', 'composition.lint'],
      next_action: 'repair_protected_binding_then_composition.reconcile',
    };
  }
  if (reconciled.changed) {
    await writeTextAtomic(htmlPath, reconciled.html, input.ctx);
  }
  const [artifacts, draftGateCheck, narrationIdentity, planIdentity] = await Promise.all([
    videoProductionArtifacts(input.compositionDirAbs),
    currentState.draft
      ? checkVideoStudioGateSignature(input.compositionDirAbs, currentState.draft)
      : Promise.resolve(undefined),
    currentNarrationIdentity(input.compositionDirAbs),
    videoProductionPlanIdentity(input.compositionDirAbs, {
      approval: currentState.plan_approval,
      roots: input.roots,
    }),
  ]);
  const visualAuthored = artifactsShowAuthoredVisuals(
    currentState.artifacts,
    artifacts,
    originalHtml,
  );
  const narrationProvenanceMatches = (!!currentState.narration
    && currentState.narration.text_sha256 === narrationIdentity.textSha
    && currentState.narration.audio_sha256 === narrationIdentity.audioSha)
    || (!!currentState.narration_transaction
      && currentState.narration_transaction.text_sha256 === narrationIdentity.textSha
      && (!currentState.narration_transaction.audio_sha256
        || currentState.narration_transaction.audio_sha256 === narrationIdentity.audioSha))
    || narrationIdentity.materializationReceiptMatches;
  const narrationRecovered = narrationProvenanceMatches
    && narrationIdentity.materialized
    && narrationIdentity.narrationMapMatches
    && narrationIdentity.htmlTrackMatches
    && !!narrationIdentity.textSha
    && !!narrationIdentity.audioSha
    && typeof narrationIdentity.duration === 'number';
  const state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    if (next.active_operation) {
      const active = next.active_operation;
      const journal = next.operation_journal || [];
      const index = journal.findIndex((entry) => entry.operation_id === active.operation_id);
      if (index >= 0) {
        journal[index] = {
          ...journal[index],
          status: 'interrupted',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
          consumes_same_input_attempt: false,
          finished_at: new Date().toISOString(),
        };
        next.operation_journal = journal.slice(-100);
      }
      recordVideoProductionTransition(next, {
        op: active.op,
        status: 'failed',
        errorCode: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
        stage: next.stage,
      });
    }
    if (planIdentity.complete) {
      if (planApprovalMatchesIdentity(next.plan_approval, planIdentity) && next.plan_approval) {
        next.plan_approval = contentAddressedPlanApproval(next.plan_approval, planIdentity);
      } else {
        const restorable = [...(next.plan_approval_history || [])]
          .reverse()
          .find((entry) => planApprovalMatchesIdentity(entry, planIdentity));
        if (restorable) setCurrentPlanApproval(next, contentAddressedPlanApproval(restorable, planIdentity));
      }
    }
    const narrationPending = narrationIdentity.required && !narrationRecovered;
    const previewValid = !!next.preview?.visual_signature
      && next.preview.visual_signature === artifacts.visual_signature;
    const draftValid = !narrationPending && !!next.draft && draftGateCheck?.matches === true;
    if (narrationPending) {
      delete next.draft;
      next.blocked_operation = {
        op: 'composition.materialize_narration',
        error_code: 'E_NARRATION_MATERIALIZATION_REQUIRED',
        message: 'Required standalone narration is missing. Visual preview and repair may continue; draft approval and final export remain unavailable until composition.materialize_narration succeeds.',
        artifacts,
        created_at: new Date().toISOString(),
      };
    } else if (next.blocked_operation?.error_code === 'E_NARRATION_MATERIALIZATION_REQUIRED') {
      delete next.blocked_operation;
    }
    // A preview is keyed only by the visual projection. Narration recovery
    // and other non-visual reconciliation keep the whole evidence bundle;
    // legacy entries without that sub-identity fail closed.
    invalidateVisualEvidenceUnlessCurrent(next, artifacts.visual_signature || '');
    if (!draftValid) delete next.draft;
    else if (next.draft && draftGateCheck?.upgradeToV5) {
      next.draft.validation_version = 5;
      next.draft.signature = artifacts.composition_signature || next.draft.signature;
    }
    if (narrationRecovered) {
      const previous = next.narration;
      const narrationIntent = manifest.schema_version === 2
        ? manifest.audio.narration_intent
        : undefined;
      next.narration = {
        status: 'materialized',
        text_sha256: narrationIdentity.textSha!,
        audio_sha256: narrationIdentity.audioSha!,
        path: path.join(input.compositionDirAbs, 'assets', 'narration.mp3'),
        measured_duration_sec: narrationIdentity.duration!,
        backend: previous?.backend
          || next.narration_transaction?.backend
          || (narrationIdentity.materializationReceiptMatches
            ? 'materialization_receipt'
            : 'recovered'),
        ...(narrationIntent ? {
          route_ref: narrationIntent.route_ref,
          voice_ref: narrationIntent.voice_ref,
          language: narrationIntent.language,
          voice: narrationIntent.voice_ref,
          speed: narrationIntent.speed,
        } : {
          ...(previous?.voice ? { voice: previous.voice } : {}),
          ...(typeof previous?.speed === 'number' ? { speed: previous.speed } : {}),
        }),
        materialized_at: previous?.materialized_at || new Date().toISOString(),
      };
      appendNarrationTransactionHistory(next, next.narration_transaction);
      delete next.narration_transaction;
      delete next.narration_retry_authorization;
    } else if (next.narration && !narrationAudioMatchesState(next, narrationIdentity)) {
      delete next.narration;
    }
    let stage: VideoProductionStateV1['stage'] = narrationPending
      ? 'scaffold_ready'
      : visualAuthored
        ? 'visuals_ready'
        : narrationRecovered ? 'narration_ready' : 'scaffold_ready';
    if (draftValid && next.draft?.status === 'approved') stage = 'draft_approved';
    else if (draftValid) stage = 'draft_ready';
    else if (previewValid && next.preview?.status === 'approved') stage = 'preview_approved';
    else if (previewValid) stage = 'preview_ready';
    next.stage = stage;
    next.artifacts = {
      ...artifacts,
      ...(!visualAuthored && artifacts.html_sha256
        ? {
          scaffold_html_sha256: artifacts.html_sha256,
          scaffold_visual_signature: artifacts.visual_signature,
        }
        : currentState.artifacts.scaffold_html_sha256
          ? {
            scaffold_html_sha256: currentState.artifacts.scaffold_html_sha256,
            scaffold_visual_signature: currentState.artifacts.scaffold_visual_signature,
          }
          : {}),
    };
    recordVideoProductionTransition(next, {
      op: 'composition.reconcile',
      status: 'passed',
      turnId: input.turnId,
      stage,
      artifacts: next.artifacts,
    });
  });
  return {
    ok: true,
    op: 'composition.reconcile',
    status: 'reconciled',
    changed: reconciled.changed,
    plan_record_refreshed: planIdentity.evidence.observations
      .some((observation) => observation.status === 'relocated'),
    plan_evidence: planIdentity.evidence,
    html_path: htmlPath,
    issues: reconciled.issues,
    production_state: summarizeVideoProductionState(state),
  };
}

/**
 * One initial request plus one explicitly authorized retry is the maximum
 * uncertainty we allow for an unchanged narration request. This is an episode
 * boundary derived from the transaction ledger, not a workflow stage: changing
 * the stable narration intent creates a different request signature, while
 * file moves, catalog labels, and provider implementation labels do not.
 */
const MAX_UNCERTAIN_NARRATION_REQUESTS_PER_INTENT = 2;

function narrationRetryEpisodeTransactions(
  state: VideoProductionStateV1,
  requestSignature: string,
): VideoProductionNarrationTransaction[] {
  const unique = new Map<string, VideoProductionNarrationTransaction>();
  for (const transaction of [
    ...(state.narration_transaction_history || []),
    ...(state.narration_transaction ? [state.narration_transaction] : []),
  ]) {
    if (transaction.request_signature !== requestSignature
      || transaction.status !== 'failed'
      || transaction.request_disposition !== 'sent'
      || (transaction.charge_status !== 'unknown' && transaction.charge_status !== 'charged')) {
      continue;
    }
    unique.set(transaction.transaction_id, transaction);
  }
  return [...unique.values()];
}

type NarrationRetryDecisionResolution = {
  decision: VideoStudioResolvedDecision;
  protocol: 'narration_retry_form' | 'legacy_gate_c_form' | 'model_interpreted_user_message' | 'none';
};

function resolveNarrationRetryDecision(
  userMessage: string | undefined,
  evidence: unknown,
): NarrationRetryDecisionResolution {
  let decision = resolveVideoStudioCurrentTurnDecision(
    userMessage,
    'narration_retry',
    evidence,
  );
  let protocol: NarrationRetryDecisionResolution['protocol'] = decision.source === 'form'
    ? 'narration_retry_form'
    : decision.source === 'model_interpreted_user_message'
      ? 'model_interpreted_user_message'
      : 'none';

  // A narration retry form opened by VideoStudio <=1.1.29 used the Gate C
  // field id. Consume that already-visible structured decision only while
  // reconciling a matching failed narration transaction; new forms use
  // narration_retry_decision and natural-language replies stay model
  // interpreted.
  if (decision.decision === 'unknown') {
    const legacyDecision = explicitVideoStudioGateDecision(
      userMessage,
      'generation',
    );
    if (legacyDecision !== 'unknown') {
      decision = {
        decision: legacyDecision === 'approve' ? 'approve' : 'reject',
        source: 'form',
        evidence_status: 'not_provided',
      };
      protocol = 'legacy_gate_c_form';
    }
  }
  return { decision, protocol };
}

function exhaustedNarrationRetryResult(input: {
  state: VideoProductionStateV1;
  requestSignature: string;
  billableRequestSent: boolean;
  providerErrorCode?: string;
  submittedDecision?: NarrationRetryDecisionResolution;
}): Record<string, unknown> {
  const attempts = narrationRetryEpisodeTransactions(input.state, input.requestSignature);
  const latest = attempts.at(-1);
  const submittedDecision = input.submittedDecision?.decision.decision !== 'unknown'
    ? input.submittedDecision
    : undefined;
  return {
    ok: false,
    op: 'composition.materialize_narration',
    errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
    message: submittedDecision
      ? 'Your reply was received, but before sending anything the current transaction ledger showed that this unchanged narration plan already has two provider requests with no usable audio and charged or uncertain billing. The older retry proposal is no longer actionable and has been closed without sending or charging a new request. The approved visual candidate remains available; continue after provider reconciliation, or revise the narration voice/content before starting a new request episode.'
      : 'Narration stopped after two provider requests returned no usable audio while billing was charged or could not be confirmed. No further request will be sent for this unchanged narration plan. The approved visual candidate remains available; continue after provider reconciliation, or revise the narration voice/content before starting a new request episode.',
    ...(input.providerErrorCode ? { provider_error_code: input.providerErrorCode } : {}),
    billable_request_sent: input.billableRequestSent,
    request_disposition: input.billableRequestSent ? 'sent' : 'not_sent',
    charge_status: latest?.charge_status || 'unknown',
    retry_policy: 'episode_exhausted',
    requires_user_decision: false,
    user_reconfirmation_required: false,
    automatic_recovery_expected: false,
    next_step_owner: 'external',
    same_turn_continuation_required: false,
    interaction_required: false,
    recovery_status: 'completed_with_preserved_visual_candidate',
    blocked_scope: 'narration_and_complete_delivery_only',
    candidate_completeness: 'visual_only',
    ...(submittedDecision ? {
      decision_acknowledged: true,
      decision_applied: false,
      decision_reuse_allowed: false,
      submitted_decision: submittedDecision.decision.decision,
      submitted_decision_source: submittedDecision.decision.source,
      submitted_decision_protocol: submittedDecision.protocol,
      submitted_decision_status: 'superseded_by_current_transaction_ledger',
      retry_proposal_status: 'superseded',
      compatibility_status: 'stale_retry_decision_resolved_safely',
    } : {}),
    narration_retry_episode: {
      status: 'exhausted',
      request_signature: input.requestSignature,
      failed_request_count: attempts.length,
      max_failed_requests: MAX_UNCERTAIN_NARRATION_REQUESTS_PER_INTENT,
      reset_condition: 'provider_outcome_reconciled_or_stable_narration_intent_changed',
      transactions: attempts.map((transaction) => ({
        transaction_id: transaction.transaction_id,
        charge_status: transaction.charge_status,
        error_code: transaction.error_code,
      })),
    },
    allowed_recovery_ops: [
      'composition.status',
      'composition.reconcile',
      'composition.lint',
      'composition.inspect',
      'composition.snapshot',
    ],
    next_action: submittedDecision
      ? 'acknowledge_superseded_confirmation_show_current_visual_candidate_and_recovery_options'
      : 'show_current_visual_candidate_and_recovery_options',
  };
}

/**
 * Move a narration artifact that cannot be attributed to the current script out
 * of the composition, without losing it.
 *
 * The audio was very likely paid for, so it is preserved under the
 * runtime-owned `assets/narration-history/` directory rather than deleted. That
 * directory is excluded from the composition-file walk, so the artifact stops
 * participating in the composition identity while remaining on disk for the
 * user. Preview approval is unaffected either way — it resolves against the
 * VISUAL signature, which excludes audio.
 *
 * The name is content-addressed, so re-preserving the same bytes is idempotent.
 * Returns the new path, or null when the move failed; a caller that gets null
 * must keep treating the original as present.
 */
async function preserveUnmatchedNarrationAudio(
  compositionDirAbs: string,
  audioAbsPath: string,
): Promise<string | null> {
  const historyDir = path.join(compositionDirAbs, 'assets', 'narration-history');
  const sha = await sha256File(audioAbsPath);
  const target = path.join(historyDir, `unmatched-${(sha || 'unknown').slice(0, 16)}.mp3`);
  try {
    await fs.mkdir(historyDir, { recursive: true });
    await fs.rename(audioAbsPath, target);
    return target;
  } catch (err) {
    log.warn('preserve unmatched narration audio failed', { error: logErrorSummary(err) });
    return null;
  }
}

function appendNarrationTransactionHistory(
  state: VideoProductionStateV1,
  transaction: VideoProductionNarrationTransaction | undefined,
): void {
  if (!transaction) return;
  const history = (state.narration_transaction_history || [])
    .filter((candidate) => candidate.transaction_id !== transaction.transaction_id);
  state.narration_transaction_history = [...history, transaction].slice(-20);
}

function narrationTimingDecisionResult(input: {
  episode: VideoProductionNarrationTimingEpisode;
  measuredDurationSec: number;
  billableRequestSent: boolean;
}): Record<string, unknown> {
  return {
    ok: false,
    op: 'composition.materialize_narration',
    errorCode: 'E_NARRATION_TIMING_USER_DECISION_REQUIRED',
    message: `Narration measured ${Math.round(input.measuredDurationSec * 1000) / 1000}s, outside the accepted ${input.episode.min_duration_sec}-${input.episode.max_duration_sec}s range after the one automatic timing retry. No further speech request will be sent automatically. Ask the user whether to revise the narration again or continue production with this complete audio and its actual duration.`,
    measured_duration_sec: Math.round(input.measuredDurationSec * 1000) / 1000,
    target_duration_sec: input.episode.target_duration_sec,
    tolerance_sec: input.episode.tolerance_sec,
    min_duration_sec: input.episode.min_duration_sec,
    max_duration_sec: input.episode.max_duration_sec,
    timing_episode_id: input.episode.episode_id,
    automatic_retries_used: input.episode.automatic_retries_used,
    automatic_retry_limit: input.episode.automatic_retry_limit,
    billable_request_sent: input.billableRequestSent,
    requires_user_decision: true,
    user_reconfirmation_required: true,
    automatic_recovery_expected: false,
    next_step_owner: 'user',
    interaction_required: true,
    blocked_scope: 'narration_and_complete_delivery_only',
    candidate_completeness: 'visual_only',
    user_options: [
      {
        id: 'continue_narration_revision',
        label: 'Continue revising narration',
        effect: 'Authorize exactly one additional speech request after a timing-focused text revision and free fit check.',
      },
      {
        id: 'proceed_with_current_narration',
        label: 'Continue with the current narration',
        effect: 'Record a duration waiver and retime the composition to the complete current audio without truncating speech.',
      },
    ],
    allowed_recovery_ops: [
      'composition.status',
      'composition.lint',
      'composition.inspect',
      'composition.snapshot',
      'composition.materialize_narration',
    ],
    next_action: 'present_narration_timing_decision_and_end_turn',
  };
}

async function materializeCompositionNarration(input: {
  compositionDirAbs: string;
  statePath: string;
  voice?: string;
  speed?: number;
  decisionEvidence?: unknown;
  opts: VideoStudioToolOpts;
  ctx: ToolContext;
}): Promise<Record<string, unknown>> {
  if (typeof input.speed === 'number'
    && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_SPEED_INVALID',
      message: 'speed must be between 0.5 and 2.0; prefer a natural pace near 1.0.',
    };
  }
  const manifestPath = path.join(input.compositionDirAbs, 'composition-manifest.json');
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (err) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: `A valid composition-manifest.json is required before narration: ${compositionManifestFailure(err).detail}. Run composition.prepare (or AUTO inheritance via composition.approve_plan) first when it does not exist yet.`,
    };
  }
  const parsed = CompositionManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: parsed.error.issues[0]?.message || 'Composition manifest is invalid.',
    };
  }
  const manifest = parsed.data;
  // Hard boundary, not advice: materializing here would bake a narration track
  // into a segment whose parent mixes the one real narration — the "two
  // voices" defect the assembler's silence contract exists to prevent. The v2
  // schema already blocks this path, but with a message that tells the model to
  // sign a voice; a v1 manifest plus a legacy voice parameter would sail
  // through to a paid synthesis.
  if (manifest.audio.owner === 'assembler') {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_NOT_OWNED',
      message: 'This composition declares audio.owner:"assembler": the parent production synthesizes and mixes the one narration for the whole video, and this segment must render silent. No speech request was sent and no credits were consumed. Do not sign an audio.narration_intent here; continue with visual authoring and let the parent assembler own narration.',
      billable_request_sent: false,
      requires_user_decision: false,
      next_action: 'continue_visual_authoring',
    };
  }
  const text = compositionNarrationText(manifest);
  if (!text) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_TEXT_MISSING',
      message: 'Add approved narration_text to manifest scenes before materializing narration.',
    };
  }
  const unsupportedSilentGaps = interstitialSilentSceneIds(manifest);
  if (unsupportedSilentGaps.length) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_INTERSTITIAL_SILENCE_UNSUPPORTED',
      message: `Scene(s) ${unsupportedSilentGaps.join(', ')} are silent between narrated scenes, but one continuous narration track cannot pause across those windows without measured per-line audio cuts. Move intentional silence to the opening or ending, or make the pause part of the narrated script before checking fit. No speech request was sent.`,
      scene_ids: unsupportedSilentGaps,
      billable_request_sent: false,
      requires_user_decision: false,
      next_action: 'repair_narration_timeline_then_composition.check_narration_fit',
    };
  }
  const narrationSelection = await resolveCompositionNarrationSelection({
    manifest,
    ...(input.voice ? { legacyVoice: input.voice } : {}),
    ...(typeof input.speed === 'number' ? { legacySpeed: input.speed } : {}),
    ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
  });
  if (narrationSelection.ok === false) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: narrationSelection.errorCode,
      message: narrationSelection.message,
      billable_request_sent: false,
      request_disposition: 'rejected_preflight',
      charge_status: 'not_charged',
      retry_policy: 'safe_after_plan_fix',
    };
  }
  const routeRef = narrationSelection.selection.routeRef;
  const voiceRef = narrationSelection.selection.voiceRef;
  const language = narrationSelection.selection.language;
  const effectiveSpeed = narrationSelection.speed;
  if (manifest.audio.tracks.some((track) => track.kind !== 'narration')) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_RETIME_UNSAFE',
      message: 'Materialize narration before adding music or SFX tracks so measured-duration retiming cannot corrupt other audio windows.',
    };
  }

  let state = await readVideoProductionState(input.statePath, input.compositionDirAbs);
  const narrationInvariantRecovery = state.blocked_operation?.error_code === 'E_NARRATION_MATERIALIZATION_REQUIRED';
  const textSha = crypto.createHash('sha256').update(text).digest('hex');
  const requestSignature = crypto.createHash('sha256').update(JSON.stringify({
    text_sha256: textSha,
    route_ref: routeRef,
    voice_ref: voiceRef,
    language,
    speed: effectiveSpeed,
    format: 'mp3',
  })).digest('hex');
  const legacyTransactionMatchesStableRequest = (
    transaction: VideoProductionNarrationTransaction | undefined,
  ): boolean => !!transaction
    && manifest.schema_version === 2
    && transaction.text_sha256 === textSha
    && transaction.route_ref === routeRef
    && transaction.voice_ref === voiceRef
    && transaction.language === language
    && Math.abs((transaction.speed ?? 1) - effectiveSpeed) <= 0.0001
    && path.resolve(transaction.path) === path.resolve(
      path.join(input.compositionDirAbs, 'assets', 'narration.mp3'),
    );
  const requestIdentityMigrationRequired = [
    ...(state.narration_transaction_history || []),
    ...(state.narration_transaction ? [state.narration_transaction] : []),
  ].some((transaction) => legacyTransactionMatchesStableRequest(transaction)
    && transaction.request_signature !== requestSignature);
  if (requestIdentityMigrationRequired) {
    state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      for (const transaction of next.narration_transaction_history || []) {
        if (legacyTransactionMatchesStableRequest(transaction)) {
          transaction.request_signature = requestSignature;
        }
      }
      if (legacyTransactionMatchesStableRequest(next.narration_transaction)) {
        next.narration_transaction!.request_signature = requestSignature;
      }
      if (next.narration_retry_authorization
        && next.narration_retry_authorization.failed_transaction_id
        === next.narration_transaction?.transaction_id) {
        next.narration_retry_authorization.request_signature = requestSignature;
      }
    });
  }
  if (state.narration_retry_authorization
    && (state.narration_retry_authorization.request_signature !== requestSignature
      || state.narration_retry_authorization.failed_transaction_id
      !== state.narration_transaction?.transaction_id)) {
    state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      delete next.narration_retry_authorization;
    });
  }
  const outputAbsPath = path.join(input.compositionDirAbs, 'assets', 'narration.mp3');
  // Not const: an unmatched artifact may be preserved out of the way below, and
  // every later branch must then see the composition as having no narration.
  let existingOutput = await fs.stat(outputAbsPath).catch(() => null);
  const existingAudioSha = existingOutput?.isFile() ? await sha256File(outputAbsPath) : undefined;
  const narrationTrack = manifest.audio.tracks.find((track) => track.kind === 'narration');
  const existingIdentity = existingOutput?.isFile()
    ? await currentNarrationIdentity(input.compositionDirAbs)
    : undefined;
  const trackedNarrationIsCurrent = state.narration?.text_sha256 === textSha
    && (manifest.schema_version === 1
      || (state.narration.route_ref === routeRef && state.narration.voice_ref === voiceRef
        && state.narration.language === language
        && Math.abs((state.narration.speed ?? 1) - effectiveSpeed) <= 0.0001))
    && !!existingAudioSha
    && state.narration.audio_sha256 === existingAudioSha
    && manifest.audio.owner === 'composition'
    && narrationTrack?.src === 'assets/narration.mp3'
    && Math.abs((narrationTrack?.duration || 0) - state.narration.measured_duration_sec) <= 0.01;
  const receiptNarrationIsCurrent = !trackedNarrationIsCurrent
    && !!existingIdentity?.materializationReceiptMatches
    && existingIdentity.materialized
    && existingIdentity.textSha === textSha
    && existingIdentity.audioSha === existingAudioSha
    && typeof existingIdentity.duration === 'number';
  if (trackedNarrationIsCurrent || receiptNarrationIsCurrent) {
    const measuredDurationSec = state.narration?.measured_duration_sec
      ?? existingIdentity?.duration;
    const narrationMapPath = path.join(input.compositionDirAbs, 'narration-map.json');
    if (!existingIdentity?.narrationMapMatches || existingIdentity.legacyMaterializationReceipt) {
      await writeJsonAtomic(narrationMapPath, buildCompositionNarrationMap(manifest, {
        textSha256: textSha,
        audioSha256: existingAudioSha!,
        method: 'scene_estimate_scaled',
        ...(typeof measuredDurationSec === 'number' ? { audioDurationSec: measuredDurationSec } : {}),
      }));
    }
    const htmlPath = path.join(input.compositionDirAbs, 'index.html');
    const existingHtml = await fs.readFile(htmlPath, 'utf8').catch(() => '');
    if (!existingIdentity?.htmlTrackMatches) {
      const reconciledHtml = reconcileCompositionHtml(existingHtml, manifest);
      if (!reconciledHtml.ok) {
        return {
          ok: false,
          op: 'composition.materialize_narration',
          errorCode: 'E_NARRATION_VISUAL_RECOVERY_BLOCKED',
          message: reconciledHtml.issues[0]?.message || 'Narration audio exists, but its render binding could not be repaired without replacing authored visuals.',
          issues: reconciledHtml.issues,
          path: outputAbsPath,
          billable_request_sent: false,
          blocked_operation: 'composition.materialize_narration',
          requires_user_decision: false,
          preserved_artifacts: ['narration_audio', 'narration_transaction', 'composition_manifest', 'authored_visuals'],
          allowed_recovery_ops: ['composition.status', 'composition.reconcile', 'composition.lint'],
          next_action: 'repair_protected_binding_then_composition.reconcile',
        };
      }
      if (reconciledHtml.changed) await writeTextAtomic(htmlPath, reconciledHtml.html, input.ctx);
    }
    if (typeof measuredDurationSec !== 'number') {
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_NARRATION_RECEIPT_DURATION_MISSING',
        message: 'The existing narration receipt matches the current audio and text, but its measured duration is missing. Preserve the audio and repair the receipt before retrying.',
        path: outputAbsPath,
        billable_request_sent: false,
        requires_user_decision: false,
        allowed_recovery_ops: ['composition.status', 'composition.reconcile'],
        next_action: 'repair_narration_receipt_then_composition.reconcile',
      };
    }
    const metadataRecovered = receiptNarrationIsCurrent
      || !existingIdentity?.narrationMapMatches
      || !existingIdentity?.htmlTrackMatches;
    const finalArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
    const authoredVisualsRecovered = narrationInvariantRecovery
      && artifactsShowAuthoredVisuals(state.artifacts, finalArtifacts, existingHtml);
    const reusedState = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      next.stage = authoredVisualsRecovered ? 'visuals_ready' : 'narration_ready';
      next.narration = {
        status: 'materialized',
        text_sha256: textSha,
        audio_sha256: existingAudioSha!,
        path: outputAbsPath,
        measured_duration_sec: measuredDurationSec,
        backend: state.narration?.backend
          || state.narration_transaction?.backend
          || 'materialization_receipt',
        ...(manifest.schema_version === 2 ? {
          route_ref: routeRef,
          voice_ref: voiceRef,
          language,
          voice: voiceRef,
          speed: effectiveSpeed,
        } : {
          ...(state.narration?.voice ? { voice: state.narration.voice } : {}),
          ...(typeof state.narration?.speed === 'number' ? { speed: state.narration.speed } : {}),
        }),
        materialized_at: state.narration?.materialized_at || new Date().toISOString(),
      };
      appendNarrationTransactionHistory(next, next.narration_transaction);
      delete next.narration_transaction;
      delete next.narration_retry_authorization;
      delete next.blocked_operation;
      next.artifacts = {
        ...finalArtifacts,
        scaffold_html_sha256: authoredVisualsRecovered
          ? state.artifacts.scaffold_html_sha256
          : finalArtifacts.html_sha256,
        scaffold_visual_signature: authoredVisualsRecovered
          ? state.artifacts.scaffold_visual_signature
          : finalArtifacts.visual_signature,
      };
      recordVideoProductionTransition(next, {
        op: 'composition.materialize_narration',
        status: 'passed',
        turnId: input.opts.turnId,
        stage: next.stage,
        artifacts: next.artifacts,
      });
    });
    return {
      ok: true,
      op: 'composition.materialize_narration',
      status: metadataRecovered ? 'recovered' : 'reused',
      path: outputAbsPath,
      measured_duration_sec: measuredDurationSec,
      narration_text_sha256: textSha,
      narration_map_path: narrationMapPath,
      html_path: htmlPath,
      visuals_preserved: authoredVisualsRecovered,
      ...(receiptNarrationIsCurrent ? {
        recovery_source: 'materialization_receipt',
        ledger_binding_restored: true,
      } : {}),
      billable_request_sent: false,
      narration_audition: {
        audio_path: outputAbsPath,
        duration_sec: measuredDurationSec,
        action: 'share_audio_with_user_for_audition_now',
      },
      production_state: await summarizeCompositionProductionState(reusedState, input.compositionDirAbs),
    };
  }
  let transactionMatches = !!state.narration_transaction
    && state.narration_transaction.text_sha256 === textSha
    && path.resolve(state.narration_transaction.path) === path.resolve(outputAbsPath)
    && (state.narration_transaction.request_signature === requestSignature
      || (manifest.schema_version === 1 && !state.narration_transaction.request_signature));
  const narrationRetryOffer = (transactionId: string, attemptNumber: number) => ({
    offer_id: crypto.createHash('sha256').update(JSON.stringify({
      request_signature: requestSignature,
      failed_transaction_id: transactionId,
      next_attempt_number: attemptNumber + 1,
    })).digest('hex'),
    previous_request_outcome: 'unknown',
    new_billable_request_count: 1,
    narration_text_sha256: textSha,
    route_ref: routeRef,
    voice_ref: voiceRef,
    language,
    speed: effectiveSpeed,
    ...(state.current_candidate?.revision_id
      ? { current_candidate_revision_id: state.current_candidate.revision_id }
      : {}),
  });
  const failNarrationArtifactAfterDispatch = async (failure: {
    transactionId: string;
    attemptNumber: number;
    errorCode: 'E_TTS_AUDIO_MISSING';
    message: string;
    billableRequestSent: boolean;
    backend?: string;
  }): Promise<Record<string, unknown>> => {
    const failedState = await updateVideoProductionState(
      input.statePath,
      input.compositionDirAbs,
      (next) => {
        const transaction = next.narration_transaction;
        if (!transaction || transaction.transaction_id !== failure.transactionId) return;
        transaction.status = 'failed';
        transaction.error_code = failure.errorCode;
        if (failure.backend) transaction.backend = failure.backend;
        // A durable pending record is written immediately before dispatch.
        // If execution stops after that boundary, `not_sent` is not proof that
        // the provider never received the request. Fail closed against a
        // duplicate paid request and require one explicit retry decision.
        transaction.request_disposition = 'sent';
        transaction.charge_status = narrationSelection.selection.provider === 'orkas-voice'
          ? 'charged'
          : transaction.charge_status || 'unknown';
        transaction.retry_policy = 'requires_user_action';
        transaction.updated_at = new Date().toISOString();
      },
    );
    if (narrationRetryEpisodeTransactions(failedState, requestSignature).length
      >= MAX_UNCERTAIN_NARRATION_REQUESTS_PER_INTENT) {
      return exhaustedNarrationRetryResult({
        state: failedState,
        requestSignature,
        billableRequestSent: failure.billableRequestSent,
        providerErrorCode: failure.errorCode,
      });
    }
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: failure.errorCode,
      message: failure.message,
      billable_request_sent: failure.billableRequestSent,
      request_disposition: 'sent',
      charge_status: failedState.narration_transaction?.charge_status || 'unknown',
      retry_policy: 'requires_user_action',
      requires_user_decision: true,
      blocked_scope: 'narration_and_complete_delivery_only',
      candidate_completeness: 'visual_only',
      narration_retry_offer: narrationRetryOffer(
        failure.transactionId,
        failure.attemptNumber,
      ),
      allowed_recovery_ops: [
        'composition.status',
        'composition.reconcile',
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ],
      next_action: 'continue_visual_preview_then_request_narration_retry_decision',
    };
  };
  let retryAuthorization: {
    authorizationId: string;
    failedTransactionId: string;
    attemptNumber: number;
    turnId: string;
    source: 'form' | 'model_interpreted_user_message';
  } | undefined;
  if (!existingOutput && transactionMatches && state.narration_transaction?.status === 'failed') {
    const transaction = state.narration_transaction;
    const safeAfterPlanFix = transaction.retry_policy === 'safe_after_plan_fix'
      || transaction.charge_status === 'not_charged'
      || transaction.request_disposition === 'rejected_preflight';
    const attemptNumber = transaction.attempt_number || 1;
    const retryOffer = narrationRetryOffer(transaction.transaction_id, attemptNumber);
    const currentDecision = resolveNarrationRetryDecision(
      input.opts.userMessage,
      input.decisionEvidence,
    );
    if (!safeAfterPlanFix
      && narrationRetryEpisodeTransactions(state, requestSignature).length
      >= MAX_UNCERTAIN_NARRATION_REQUESTS_PER_INTENT) {
      return exhaustedNarrationRetryResult({
        state,
        requestSignature,
        billableRequestSent: false,
        ...(transaction.error_code ? { providerErrorCode: transaction.error_code } : {}),
        submittedDecision: currentDecision,
      });
    }
    const persistedAuthorization = state.narration_retry_authorization;
    if (!safeAfterPlanFix
      && persistedAuthorization?.request_signature === requestSignature
      && persistedAuthorization.failed_transaction_id === transaction.transaction_id
      && persistedAuthorization.consumed_new_requests === 0) {
      retryAuthorization = {
        authorizationId: persistedAuthorization.authorization_id,
        failedTransactionId: transaction.transaction_id,
        attemptNumber,
        turnId: persistedAuthorization.authorized_turn_id,
        source: persistedAuthorization.authorization_source,
      };
      transactionMatches = false;
    }
    if (!safeAfterPlanFix && !retryAuthorization) {
      const decision = currentDecision.decision;
      if (!currentUserTurnAvailable(input.opts.userMessage)) {
        return {
          ...missingUserTurnGateResult('composition.materialize_narration', 'narration_retry'),
          blocked_scope: 'narration_and_complete_delivery_only',
          candidate_completeness: 'visual_only',
          narration_retry_offer: retryOffer,
          request_disposition: transaction.request_disposition || 'sent',
          charge_status: transaction.charge_status || 'unknown',
        };
      }
      const invalidEvidence = decisionEvidenceCorrectionResult(
        'composition.materialize_narration',
        'narration_retry',
        decision,
      );
      if (invalidEvidence) {
        return {
          ...invalidEvidence,
          blocked_scope: 'narration_and_complete_delivery_only',
          candidate_completeness: 'visual_only',
          narration_retry_offer: retryOffer,
          request_disposition: transaction.request_disposition || 'sent',
          charge_status: transaction.charge_status || 'unknown',
        };
      }
      if (decision.decision === 'approve') {
        if (!input.opts.turnId || transaction.authorized_turn_id === input.opts.turnId) {
          return {
            ok: false,
            op: 'composition.materialize_narration',
            errorCode: 'E_TTS_RETRY_DECISION_ALREADY_CONSUMED',
            message: 'This reply already authorized one new narration request, and that attempt also ended without a conclusive provider result. It will not be sent again from the same reply.',
            billable_request_sent: transaction.request_disposition === 'sent',
            request_disposition: transaction.request_disposition || 'sent',
            charge_status: transaction.charge_status || 'unknown',
            retry_policy: transaction.retry_policy || 'requires_user_action',
            requires_user_decision: true,
            decision_source: decision.source,
            approval_consumed: true,
            blocked_scope: 'narration_and_complete_delivery_only',
            candidate_completeness: 'visual_only',
            narration_retry_offer: retryOffer,
            allowed_recovery_ops: [
              'composition.status',
              'composition.reconcile',
              'composition.lint',
              'composition.inspect',
              'composition.snapshot',
            ],
            next_action: 'show_current_visual_candidate_then_request_a_new_narration_retry_decision',
          };
        }
        retryAuthorization = {
          authorizationId: retryOffer.offer_id,
          failedTransactionId: transaction.transaction_id,
          attemptNumber,
          turnId: input.opts.turnId,
          source: decision.source === 'form' ? 'form' : 'model_interpreted_user_message',
        };
        await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
          if (next.narration_transaction?.transaction_id !== transaction.transaction_id
            || next.narration_transaction.status !== 'failed') {
            throw new Error('E_TTS_RETRY_STATE_CHANGED: narration retry state changed before authorization could be recorded.');
          }
          next.narration_retry_authorization = {
            authorization_id: retryOffer.offer_id,
            request_signature: requestSignature,
            failed_transaction_id: transaction.transaction_id,
            authorized_turn_id: input.opts.turnId!,
            authorization_source: retryAuthorization!.source,
            max_new_requests: 1,
            consumed_new_requests: 0,
            authorized_at: new Date().toISOString(),
            validation_version: 1,
          };
        });
        // The current content/voice signature is intentionally unchanged. A
        // persisted real user decision authorizes exactly one new transaction,
        // even if a non-billable local repair is needed before dispatch.
        transactionMatches = false;
      } else if (decision.decision === 'revise' || decision.decision === 'reject') {
        await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
          if (next.narration_retry_authorization?.failed_transaction_id === transaction.transaction_id) {
            delete next.narration_retry_authorization;
          }
        });
        return {
          ok: false,
          op: 'composition.materialize_narration',
          errorCode: 'E_TTS_RETRY_NOT_AUTHORIZED',
          message: 'No new narration request was sent. The current visual candidate and prior request record remain available while the narration plan is revised or left disabled.',
          billable_request_sent: false,
          requires_user_decision: false,
          decision_source: decision.source,
          blocked_scope: 'narration_and_complete_delivery_only',
          candidate_completeness: 'visual_only',
          next_action: decision.decision === 'revise'
            ? 'revise_narration_plan_then_composition.check_narration_fit'
            : 'continue_with_current_visual_candidate_without_resending_narration',
        };
      } else {
        return {
          ok: false,
          op: 'composition.materialize_narration',
          errorCode: 'E_TTS_RETRY_REQUIRES_USER_ACTION',
          message: 'The previous narration request may have reached the provider, but no usable audio was returned. The current visual work is safe. To finish with narration, show the current preview and ask whether to send exactly one new narration request.',
          billable_request_sent: transaction.request_disposition === 'sent',
          request_disposition: transaction.request_disposition || 'sent',
          charge_status: transaction.charge_status || 'unknown',
          retry_policy: transaction.retry_policy || 'requires_user_action',
          requires_user_decision: true,
          blocked_scope: 'narration_and_complete_delivery_only',
          candidate_completeness: 'visual_only',
          narration_retry_offer: retryOffer,
          allowed_recovery_ops: [
            'composition.status',
            'composition.reconcile',
            'composition.lint',
            'composition.inspect',
            'composition.snapshot',
          ],
          next_action: 'continue_visual_preview_then_request_narration_retry_decision',
        };
      }
    }
    if (!retryAuthorization) {
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_TTS_PLAN_REVISION_REQUIRED',
        message: 'The narration request was rejected before billing. Refresh speech capabilities, revise the confirmed narration intent, and check narration fit before trying again.',
        billable_request_sent: transaction.request_disposition === 'sent',
        request_disposition: transaction.request_disposition || 'sent',
        charge_status: transaction.charge_status || 'unknown',
        retry_policy: transaction.retry_policy || 'requires_user_action',
        requires_user_decision: false,
        blocked_scope: 'narration_and_complete_delivery_only',
        candidate_completeness: 'visual_only',
        allowed_recovery_ops: [
          'composition.status',
          'composition.reconcile',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ],
        next_action: 'repair_narration_plan_while_continuing_visual_preview',
      };
    }
  }
  if (existingOutput && !transactionMatches) {
    // Escape hatch for an unattributable artifact. The retry-authorization
    // block above is gated on `!existingOutput`, so while this file sits here a
    // user approval can never be recorded OR consumed: every call returns this
    // same error, and none of the offered options can clear it because no code
    // path ever removes the audio. Observed 2026-08-04/05: a charged narration
    // was invalidated by a silent rebind (`audio.owner` -> "none", narration
    // track dropped), the state record was deleted while the mp3 stayed, and
    // regeneration was then permanently impossible — the user confirmed a retry
    // and got the identical refusal back.
    //
    // An explicit approval in the CURRENT turn does the one thing that breaks
    // the loop: preserve the unmatched audio out of the composition, then fall
    // through to normal materialization. Approval is required because the
    // continuation dispatches a billable request; without it the refusal below
    // still stands, and the artifact stays exactly where it is.
    const conflictDecision = resolveNarrationRetryDecision(
      input.opts.userMessage,
      input.decisionEvidence,
    );
    const approvedRegeneration = conflictDecision.decision.decision === 'approve'
      && currentUserTurnAvailable(input.opts.userMessage);
    const preservedAudioPath = approvedRegeneration
      ? await preserveUnmatchedNarrationAudio(input.compositionDirAbs, outputAbsPath)
      : null;
    if (preservedAudioPath) {
      existingOutput = null;
    } else {
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_NARRATION_OUTPUT_CONFLICT',
        message: 'The saved narration cannot be proven to belong to the current confirmed script. It has been preserved and no new speech request was sent. Approving regeneration moves it into assets/narration-history/ and creates exactly one new narration request.',
        recoverable: true,
        terminal: false,
        retry_same_operation: false,
        billable_request_sent: false,
        requires_user_decision: true,
        blocked_scope: 'narration_and_complete_delivery_only',
        candidate_completeness: 'visual_only',
        preserved_artifacts: [
          'current_visual_candidate',
          'approved_preview',
          'existing_narration_audio',
          'approved_plan',
        ],
        allowed_recovery_ops: [
          'composition.status',
          'composition.reconcile',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ],
        next_action: 'show_current_candidate_and_request_narration_conflict_resolution',
        user_options: [
          {
            id: 'regenerate_current_narration',
            label: 'Regenerate from the current confirmed script',
            effect: 'Move the existing audio into assets/narration-history/ so it is kept but no longer bound to this composition, then create exactly one new narration request. This may incur a charge.',
          },
          {
            id: 'revise_narration',
            label: 'Change the narration or voice first',
            effect: 'Keep the current preview and existing audio while the narration plan is revised.',
          },
          {
            id: 'pause_with_visuals',
            label: 'Pause and keep the current visuals',
            effect: 'Make no speech request and keep all current artifacts available.',
          },
        ],
      };
    }
  }
  const currentArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const htmlPath = path.join(input.compositionDirAbs, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8').catch(() => '');
  const authoredVisualsPresent = (narrationInvariantRecovery || !!retryAuthorization)
    && artifactsShowAuthoredVisuals(state.artifacts, currentArtifacts, html);
  if (!transactionMatches && (!state.artifacts.manifest_sha256
    || !state.artifacts.html_sha256
    || state.artifacts.manifest_sha256 !== currentArtifacts.manifest_sha256
    || (state.artifacts.html_sha256 !== currentArtifacts.html_sha256 && !authoredVisualsPresent))) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_PREPARE_STALE',
      message: 'The manifest changed after composition.prepare, or the HTML cannot be proven to be a prepared scaffold or an authored-visual recovery. Reconcile the current files before narration materialization.',
    };
  }
  if (!html.includes('ORKAS-GENERATED-SCAFFOLD')
    && !transactionMatches
    && !narrationInvariantRecovery
    && !retryAuthorization) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_SCAFFOLD_NOT_PRISTINE',
      message: 'Narration retiming requires the untouched generated scaffold. Run it immediately after composition.prepare, before authoring visual HTML.',
    };
  }
  if (!existingOutput && !hasConfiguredTtsProvider()) {
    const availability = getTtsAvailabilityDetails(false);
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: availability.errorCode || 'E_TTS_NO_PROVIDER',
      message: availability.message || 'No speech provider is available.',
      availability: availability.reason,
      next_action: availability.nextAction,
    };
  }

  const planIdentity = await videoProductionPlanIdentity(input.compositionDirAbs, {
    approval: state.plan_approval,
    roots: allowedRoots(input.opts),
  });
  const deliveryTargetDurationSec = await approvedTargetDurationSec(manifest, planIdentity);
  const narrationBudget = narrationTimingBudget(manifest, deliveryTargetDurationSec);
  const targetDurationSec = narrationBudget.targetDurationSec;
  const estimate = estimateNarrationDuration(text, effectiveSpeed);
  const fit = compositionNarrationFit({
    text,
    targetDurationSec,
    planSignature: planIdentity.signature,
    state,
    ...(narrationSelection.legacy
      ? (input.voice ? { voice: input.voice } : {})
      : { routeRef, voiceRef, language }),
    speed: effectiveSpeed,
  });
  state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    next.narration_fit = fit;
  });
  // A matching on-disk transaction is already paid/recoverable. Never strand
  // it behind a later estimator change; probe the real audio and let the
  // measured policy below decide. The estimate gate applies only before a new
  // provider request can be sent.
  if (narrationFitBlocksProduction(fit.status) && !existingOutput) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: fit.status === 'over' ? 'E_TTS_TEXT_TOO_LONG' : 'E_TTS_TEXT_TOO_SHORT',
      message: `${narrationFitMessage(fit)} Revise the candidate manifest, run composition.check_narration_fit until gate_b_ready=true, then request production plan confirmation once for the fitting script.`,
      billable_request_sent: false,
      narration_fit: fit,
    };
  }
  const plannedSceneWeights = narrationSceneWeights(manifest, targetDurationSec, effectiveSpeed);

  const matchingTimingEpisode = state.narration_timing_episode
    && state.narration_timing_episode.approval_signature === planIdentity.signature
    && Math.abs(state.narration_timing_episode.target_duration_sec - targetDurationSec) <= 0.001
    ? state.narration_timing_episode
    : undefined;
  let timingAttemptKind: VideoProductionNarrationTransaction['attempt_kind'] = retryAuthorization
    ? 'provider_retry'
    : 'initial';
  if (!existingOutput && !retryAuthorization && matchingTimingEpisode) {
    if (matchingTimingEpisode.status === 'awaiting_user_decision') {
      const decision = resolveNarrationRetryDecision(input.opts.userMessage, input.decisionEvidence);
      const invalidEvidence = decisionEvidenceCorrectionResult(
        'composition.materialize_narration',
        'narration_retry',
        decision.decision,
      );
      if (invalidEvidence) return invalidEvidence;
      if (decision.decision.decision !== 'approve') {
        return narrationTimingDecisionResult({
          episode: matchingTimingEpisode,
          measuredDurationSec: matchingTimingEpisode.latest_measured_duration_sec,
          billableRequestSent: false,
        });
      }
      state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
        const episode = next.narration_timing_episode;
        if (!episode || episode.episode_id !== matchingTimingEpisode.episode_id
          || episode.status !== 'awaiting_user_decision') {
          throw new Error('E_NARRATION_TIMING_DECISION_STATE_CHANGED: timing episode changed before authorization.');
        }
        episode.user_authorized_requests += 1;
        episode.status = 'active';
        episode.updated_at = new Date().toISOString();
      });
      timingAttemptKind = 'user_authorized_timing_retry';
    } else if (matchingTimingEpisode.user_authorized_requests
      > matchingTimingEpisode.user_authorization_consumed) {
      timingAttemptKind = 'user_authorized_timing_retry';
    } else if (matchingTimingEpisode.automatic_retries_used
      < matchingTimingEpisode.automatic_retry_limit) {
      timingAttemptKind = 'automatic_timing_retry';
    } else {
      return narrationTimingDecisionResult({
        episode: matchingTimingEpisode,
        measuredDurationSec: matchingTimingEpisode.latest_measured_duration_sec,
        billableRequestSent: false,
      });
    }
  }

  await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
  const transactionId = transactionMatches
    ? state.narration_transaction!.transaction_id
    : crypto.randomUUID();
  const timingEpisodeId = matchingTimingEpisode?.episode_id || crypto.randomUUID();
  let backend = state.narration_transaction?.backend || 'recovered';
  let bytes = existingOutput?.size || 0;
  let billableRequestSent = false;
  let recovered = !!existingOutput;
  if (!existingOutput
    && transactionMatches
    && state.narration_transaction
    && (state.narration_transaction.status === 'pending'
      || state.narration_transaction.status === 'synthesized')) {
    return failNarrationArtifactAfterDispatch({
      transactionId,
      attemptNumber: state.narration_transaction.attempt_number || 1,
      errorCode: 'E_TTS_AUDIO_MISSING',
      message: 'The previous narration operation stopped after its provider-dispatch boundary, but no readable audio was recorded. Its billing outcome is treated as uncertain, so it will not be sent again automatically. The current visual candidate remains available.',
      billableRequestSent: false,
      ...(state.narration_transaction.backend
        ? { backend: state.narration_transaction.backend }
        : {}),
    });
  }
  if (!existingOutput) {
    const now = new Date().toISOString();
    await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
      if (retryAuthorization) {
        if (next.narration_transaction?.transaction_id !== retryAuthorization.failedTransactionId) {
          throw new Error('E_TTS_RETRY_STATE_CHANGED: narration retry state changed before the authorized request could start.');
        }
        const persisted = next.narration_retry_authorization;
        if (!persisted
          || persisted.authorization_id !== retryAuthorization.authorizationId
          || persisted.request_signature !== requestSignature
          || persisted.consumed_new_requests !== 0) {
          throw new Error('E_TTS_RETRY_AUTHORIZATION_CHANGED: the one-request narration authorization is no longer available.');
        }
        appendNarrationTransactionHistory(next, next.narration_transaction);
        persisted.consumed_new_requests = 1;
        persisted.consumed_at = now;
      }
      if (!retryAuthorization && next.narration_transaction
        && next.narration_transaction.transaction_id !== transactionId) {
        appendNarrationTransactionHistory(next, next.narration_transaction);
      }
      if (timingAttemptKind === 'automatic_timing_retry') {
        const episode = next.narration_timing_episode;
        if (!episode || episode.episode_id !== timingEpisodeId
          || episode.automatic_retries_used >= episode.automatic_retry_limit) {
          throw new Error('E_NARRATION_TIMING_RETRY_STATE_CHANGED: automatic timing retry is no longer available.');
        }
        episode.automatic_retries_used = 1;
        episode.updated_at = now;
      } else if (timingAttemptKind === 'user_authorized_timing_retry') {
        const episode = next.narration_timing_episode;
        if (!episode || episode.episode_id !== timingEpisodeId
          || episode.user_authorization_consumed >= episode.user_authorized_requests) {
          throw new Error('E_NARRATION_TIMING_AUTHORIZATION_CHANGED: no user-authorized timing request remains.');
        }
        episode.user_authorization_consumed += 1;
        episode.updated_at = now;
      }
      next.narration_transaction = {
        transaction_id: transactionId,
        status: 'pending',
        text_sha256: textSha,
        path: outputAbsPath,
        manifest_sha256: currentArtifacts.manifest_sha256 || '',
        scaffold_html_sha256: currentArtifacts.html_sha256 || '',
        request_signature: requestSignature,
        timing_episode_id: timingEpisodeId,
        attempt_kind: timingAttemptKind,
        ...(!narrationSelection.legacy ? { route_ref: routeRef, voice_ref: voiceRef, language } : {}),
        ...(narrationSelection.legacy && input.voice ? { voice: input.voice } : {}),
        speed: effectiveSpeed,
        request_disposition: 'not_sent',
        charge_status: 'unknown',
        retry_policy: 'unknown',
        generic_estimated_duration_sec: estimate.estimatedSec,
        narration_unit: estimate.unit,
        narration_units: estimate.units,
        scene_weights: plannedSceneWeights,
        ...(retryAuthorization ? {
          retry_of_transaction_id: retryAuthorization.failedTransactionId,
          authorized_turn_id: retryAuthorization.turnId,
          authorization_source: retryAuthorization.source,
          attempt_number: retryAuthorization.attemptNumber + 1,
        } : {
          attempt_number: 1,
        }),
        started_at: now,
        updated_at: now,
      };
      if (retryAuthorization) delete next.narration_retry_authorization;
      recordVideoProductionTransition(next, {
        op: 'composition.materialize_narration',
        status: 'started',
        turnId: input.opts.turnId,
        stage: next.stage,
      });
    });
    log.info('narration request dispatching', {
      transaction_id: transactionId,
      timing_episode_id: timingEpisodeId,
      attempt_kind: timingAttemptKind,
      text_sha256: textSha,
      request_signature: requestSignature,
      target_duration_sec: targetDurationSec,
      min_duration_sec: fit.min_duration_sec,
      max_duration_sec: fit.max_duration_sec,
    });
    let speech: Awaited<ReturnType<typeof generateSpeech>>;
    try {
      speech = await generateSpeech({
        text,
        outputAbsPath,
        routeRef,
        voiceRef,
        language,
        speed: effectiveSpeed,
        format: 'mp3',
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
        onProgress: (event) => input.ctx.emitProgress?.({ phase: event.phase, message: event.message }),
      });
    } catch (err) {
      return failNarrationArtifactAfterDispatch({
        transactionId,
        attemptNumber: retryAuthorization
          ? retryAuthorization.attemptNumber + 1
          : 1,
        errorCode: 'E_TTS_AUDIO_MISSING',
        message: `The narration provider operation ended without a durable result (${(err as Error).message}). It may already have been billed, so it will not be sent again automatically. The current visual candidate remains available.`,
        billableRequestSent: true,
        backend: routeRef,
      });
    }
    if (speech.ok === false) {
      billableRequestSent = speech.requestDisposition === 'sent';
      const safeAfterPlanFix = speech.retryPolicy === 'safe_after_plan_fix'
        || speech.chargeStatus === 'not_charged'
        || speech.requestDisposition === 'rejected_preflight';
      const failedState = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
        if (next.narration_transaction?.transaction_id === transactionId) {
          next.narration_transaction.status = 'failed';
          next.narration_transaction.error_code = speech.errorCode;
          next.narration_transaction.request_disposition = speech.requestDisposition || 'sent';
          next.narration_transaction.charge_status = speech.chargeStatus || 'unknown';
          next.narration_transaction.retry_policy = speech.retryPolicy || 'unknown';
          next.narration_transaction.updated_at = new Date().toISOString();
        }
      });
      // Disabled, missing, or deployment-disabled speech configuration is
      // refused before any provider call. `not_charged` would otherwise hand it
      // to the automatic repair-and-retry path — observed 2026-08-03, where
      // that path burned two provider attempts and two user confirmations
      // against an instant 503. Close the episode and identify who can restore
      // the route instead of presenting it as a transient provider failure.
      const ttsConfigurationActionRequired = [
        'E_TTS_USER_DISABLED',
        'E_TTS_SERVICE_DISABLED',
        'E_TTS_SIGN_IN_REQUIRED',
        'E_TTS_NO_PROVIDER',
        'E_TTS_NOT_CONFIGURED',
      ].includes(speech.errorCode);
      if (ttsConfigurationActionRequired) {
        const userCanResolve = speech.errorCode === 'E_TTS_USER_DISABLED'
          || speech.errorCode === 'E_TTS_SIGN_IN_REQUIRED'
          || speech.errorCode === 'E_TTS_NO_PROVIDER';
        return {
          ok: false,
          op: 'composition.materialize_narration',
          errorCode: speech.errorCode,
          message: speech.message,
          ...(speech.providerErrorCode ? { provider_error_code: speech.providerErrorCode } : {}),
          billable_request_sent: billableRequestSent,
          request_disposition: speech.requestDisposition || 'sent',
          charge_status: speech.chargeStatus || 'not_charged',
          retry_policy: 'requires_user_action',
          requires_user_decision: userCanResolve,
          user_reconfirmation_required: false,
          automatic_recovery_expected: false,
          next_step_owner: userCanResolve ? 'user' : 'external',
          same_turn_continuation_required: false,
          interaction_required: userCanResolve,
          recovery_status: 'completed_with_preserved_visual_candidate',
          blocked_scope: 'narration_and_complete_delivery_only',
          candidate_completeness: 'visual_only',
          allowed_recovery_ops: [
            'composition.status',
            'composition.reconcile',
            'composition.lint',
            'composition.inspect',
            'composition.snapshot',
          ],
          next_action: userCanResolve
            ? (getTtsAvailabilityDetails(false).nextAction || 'ask_user_to_review_voice_settings')
            : 'deliver_visual_candidate_and_report_speech_unavailable',
        };
      }
      if (!safeAfterPlanFix
        && narrationRetryEpisodeTransactions(failedState, requestSignature).length
        >= MAX_UNCERTAIN_NARRATION_REQUESTS_PER_INTENT) {
        return exhaustedNarrationRetryResult({
          state: failedState,
          requestSignature,
          billableRequestSent,
          providerErrorCode: speech.providerErrorCode || speech.errorCode,
        });
      }
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: speech.errorCode,
        message: speech.message,
        billable_request_sent: billableRequestSent,
        request_disposition: speech.requestDisposition || 'sent',
        charge_status: speech.chargeStatus || 'unknown',
        retry_policy: speech.retryPolicy || 'unknown',
        requires_user_decision: !safeAfterPlanFix,
        blocked_scope: 'narration_and_complete_delivery_only',
        candidate_completeness: 'visual_only',
        allowed_recovery_ops: [
          'composition.status',
          'composition.reconcile',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ],
        next_action: safeAfterPlanFix
          ? 'repair_narration_plan_while_continuing_visual_preview'
          : 'continue_visual_preview_then_request_narration_retry_decision',
        ...(!safeAfterPlanFix ? {
          narration_retry_offer: narrationRetryOffer(
            transactionId,
            retryAuthorization ? retryAuthorization.attemptNumber + 1 : 1,
          ),
        } : {}),
        ...(speech.providerErrorCode ? { provider_error_code: speech.providerErrorCode } : {}),
      };
    }
    billableRequestSent = true;
    backend = routeRef;
    bytes = speech.bytes;
    recovered = false;
  }
  const audioSha = await sha256File(outputAbsPath);
  if (!audioSha) {
    return failNarrationArtifactAfterDispatch({
      transactionId,
      attemptNumber: retryAuthorization
        ? retryAuthorization.attemptNumber + 1
        : state.narration_transaction?.attempt_number || 1,
      errorCode: 'E_TTS_AUDIO_MISSING',
      message: 'The narration provider returned, but no readable audio artifact was recorded. The request may already have been billed, so it will not be sent again automatically. The current visual candidate remains available.',
      billableRequestSent,
      backend,
    });
  }
  // Persist successful provider output before media probing or manifest/HTML
  // reconciliation. Those local steps may fail or the process may stop, but a
  // later call must recover this paid artifact instead of dispatching again.
  await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    const transaction = next.narration_transaction;
    if (!transaction || transaction.transaction_id !== transactionId) return;
    transaction.status = 'synthesized';
    transaction.backend = backend;
    transaction.request_disposition = transaction.request_disposition === 'not_sent'
      ? 'sent'
      : transaction.request_disposition;
    transaction.charge_status = narrationSelection.selection.provider === 'orkas-voice'
      ? 'charged'
      : transaction.charge_status || 'unknown';
    transaction.audio_sha256 = audioSha;
    transaction.updated_at = new Date().toISOString();
  });
  const measuredDurationSec = state.narration_transaction?.measured_duration_sec
    || await probeMediaDurationSec(outputAbsPath, input.ctx.signal);
  if (!(typeof measuredDurationSec === 'number' && measuredDurationSec > 0)) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_DURATION_UNAVAILABLE',
      message: 'Narration audio exists, but its measured duration is unavailable. The transaction remains recoverable; repair media probing and call materialize_narration again without deleting the audio.',
      path: outputAbsPath,
      billable_request_sent: billableRequestSent,
      request_disposition: 'sent',
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      blocked_scope: 'narration_and_complete_delivery_only',
      candidate_completeness: 'visual_only',
      allowed_recovery_ops: [
        'composition.status',
        'composition.reconcile',
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ],
      next_action: 'repair_media_probe_then_resume_same_narration_transaction',
    };
  }
  // COMPOSE keeps estimates and measured audio on one editorial band on
  // purpose: this composition owns its own length, so delivery expands to a
  // fitting longer narration below and accepted speech is never truncated
  // merely to preserve the nominal target. Crossing the band here opens a user
  // timing decision, so the wide allowance is also what keeps that stop rare.
  // AUTO cannot do either — its windows are signed at Gate B and the video is
  // cut to them — so its measured-overrun check reads
  // `narrationMeasurementOverruns` instead. Do not merge the two.
  const measuredBand = narrationDurationBand(targetDurationSec);
  const measuredOutsideBand = measuredDurationSec < measuredBand.minDurationSec
    || measuredDurationSec > measuredBand.maxDurationSec;
  const timingDecisionAtMeasurement = matchingTimingEpisode?.status === 'awaiting_user_decision'
    ? resolveNarrationRetryDecision(input.opts.userMessage, input.decisionEvidence)
    : undefined;
  if (timingDecisionAtMeasurement) {
    const invalidEvidence = decisionEvidenceCorrectionResult(
      'composition.materialize_narration',
      'narration_retry',
      timingDecisionAtMeasurement.decision,
    );
    if (invalidEvidence) return invalidEvidence;
  }
  const acceptTimingWaiver = measuredOutsideBand
    && timingDecisionAtMeasurement?.decision.decision === 'reject';
  const continueTimingRevision = measuredOutsideBand
    && (timingDecisionAtMeasurement?.decision.decision === 'approve'
      || timingDecisionAtMeasurement?.decision.decision === 'revise');
  const measuredDurationMismatch = measuredOutsideBand && !acceptTimingWaiver;
  log.info('narration duration measured', {
    transaction_id: transactionId,
    timing_episode_id: timingEpisodeId,
    attempt_kind: state.narration_transaction?.attempt_kind || timingAttemptKind,
    text_sha256: textSha,
    request_signature: requestSignature,
    measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
    target_duration_sec: targetDurationSec,
    min_duration_sec: measuredBand.minDurationSec,
    max_duration_sec: measuredBand.maxDurationSec,
    fit_status: measuredOutsideBand
      ? measuredDurationSec < measuredBand.minDurationSec ? 'under' : 'over'
      : 'fits',
    timing_waiver_applied: acceptTimingWaiver,
  });
  const repairIdentity = measuredDurationMismatch
    ? await videoProductionNarrationRepairIdentity(planIdentity)
    : undefined;
  const updatedState = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    const transaction = next.narration_transaction;
    if (!transaction || transaction.transaction_id !== transactionId) return;
    transaction.status = 'synthesized';
    transaction.backend = backend;
    transaction.request_disposition = transaction.request_disposition === 'not_sent' ? 'sent' : transaction.request_disposition;
    transaction.charge_status = transaction.charge_status || 'unknown';
    transaction.audio_sha256 = audioSha;
    transaction.measured_duration_sec = Math.round(measuredDurationSec * 1000) / 1000;
    transaction.updated_at = new Date().toISOString();
    if (measuredOutsideBand) {
      const previousEpisode = next.narration_timing_episode?.episode_id === timingEpisodeId
        ? next.narration_timing_episode
        : undefined;
      const now = new Date().toISOString();
      const transactionIds = [...new Set([
        ...(previousEpisode?.transaction_ids || []),
        transaction.transaction_id,
      ])];
      const episode: VideoProductionNarrationTimingEpisode = previousEpisode
        ? {
          ...previousEpisode,
          transaction_ids: transactionIds,
          latest_measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
          latest_text_sha256: textSha,
          updated_at: now,
        }
        : {
          episode_id: timingEpisodeId,
          approval_signature: planIdentity.signature,
          target_duration_sec: targetDurationSec,
          tolerance_ratio: measuredBand.toleranceRatio,
          tolerance_floor_sec: measuredBand.toleranceFloorSec,
          tolerance_sec: measuredBand.toleranceSec,
          min_duration_sec: measuredBand.minDurationSec,
          max_duration_sec: measuredBand.maxDurationSec,
          initial_transaction_id: transaction.transaction_id,
          transaction_ids: transactionIds,
          automatic_retry_limit: 1,
          automatic_retries_used: 0,
          user_authorized_requests: 0,
          user_authorization_consumed: 0,
          status: 'active',
          latest_measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
          latest_text_sha256: textSha,
          created_at: now,
          updated_at: now,
          validation_version: 1,
        };
      if (acceptTimingWaiver) {
        episode.status = 'accepted_by_user_waiver';
        episode.user_waiver = {
          quote: currentUserTurnPayload(input.opts.userMessage).slice(0, 500),
          turn_id: input.opts.turnId || '',
          created_at: now,
        };
      } else if (continueTimingRevision) {
        episode.user_authorized_requests += 1;
        episode.status = 'active';
      } else if (transaction.attempt_kind === 'automatic_timing_retry'
        || transaction.attempt_kind === 'user_authorized_timing_retry') {
        episode.status = 'awaiting_user_decision';
      }
      next.narration_timing_episode = episode;
    } else if (next.narration_timing_episode?.episode_id === timingEpisodeId) {
      next.narration_timing_episode.status = 'accepted';
      next.narration_timing_episode.latest_measured_duration_sec = Math.round(measuredDurationSec * 1000) / 1000;
      next.narration_timing_episode.latest_text_sha256 = textSha;
      next.narration_timing_episode.updated_at = new Date().toISOString();
    }
    const genericEstimatedSec = transaction.generic_estimated_duration_sec || estimate.estimatedSec;
    const durationScale = narrationDurationCalibrationScale({
      genericEstimatedSec,
      measuredSec: measuredDurationSec,
    });
    const profile = normalizedNarrationProfile({
      voice: transaction.voice_ref || transaction.voice || (narrationSelection.legacy ? input.voice : voiceRef),
      language: transaction.language || language,
      speed: transaction.speed ?? effectiveSpeed,
    });
    const calibrationBackend = transaction.route_ref
      || (narrationSelection.legacy ? backend : routeRef);
    if (durationScale) {
      next.narration_calibration = {
        source: 'measured_tts',
        backend: calibrationBackend,
        ...(!narrationSelection.legacy ? {
          route_ref: transaction.route_ref || routeRef,
          voice_ref: transaction.voice_ref || voiceRef,
          language: transaction.language || language,
        } : {}),
        ...(profile.voice ? { voice: profile.voice } : {}),
        speed: profile.speed,
        generic_estimated_duration_sec: genericEstimatedSec,
        measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
        duration_scale: durationScale,
        narration_unit: transaction.narration_unit || estimate.unit,
        narration_units: transaction.narration_units || estimate.units,
        observed_at: new Date().toISOString(),
      };
      next.narration_fit = compositionNarrationFit({
        text,
        targetDurationSec,
        planSignature: planIdentity.signature,
        state: next,
        ...(!narrationSelection.legacy
          ? {
            routeRef: transaction.route_ref || routeRef,
            voiceRef: transaction.voice_ref || voiceRef,
            language: transaction.language || language,
          }
          : (transaction.voice ? { voice: transaction.voice } : {})),
        speed: transaction.speed ?? effectiveSpeed,
      });
      if (measuredDurationMismatch
        && repairIdentity
        && planApprovalMatchesIdentity(next.plan_approval, planIdentity)
        && next.plan_approval) {
        next.narration_repair = {
          source: 'measured_duration_mismatch',
          approval_signature: next.plan_approval.signature,
          approval_turn_id: next.plan_approval.turn_id,
          approval_at: next.plan_approval.approved_at,
          structure_signature: repairIdentity.structureSignature,
          narration_token_hashes: repairIdentity.narrationTokenHashes,
          backend: calibrationBackend,
          ...(!narrationSelection.legacy ? {
            route_ref: transaction.route_ref || routeRef,
            voice_ref: transaction.voice_ref || voiceRef,
            language: transaction.language || language,
          } : {}),
          ...(profile.voice ? { voice: profile.voice } : {}),
          speed: profile.speed,
          target_duration_sec: targetDurationSec,
          max_edit_ratio: NARRATION_REPAIR_MAX_EDIT_RATIO,
          max_checks: NARRATION_REPAIR_MAX_CHECKS,
          checks_used: 0,
          authorized_at: new Date().toISOString(),
          validation_version: 1,
        };
      }
    }
  });

  if (measuredDurationMismatch) {
    const timingEpisode = updatedState.narration_timing_episode;
    if (continueTimingRevision && timingEpisode) {
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_NARRATION_TIMING_REVISION_REQUIRED',
        message: `The user authorized one additional timing-focused narration request. Revise the narration, run composition.check_narration_fit, then call composition.prepare and composition.materialize_narration once. The authorization is durable and no request was sent by this decision call.`,
        path: outputAbsPath,
        measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
        target_duration_sec: targetDurationSec,
        min_duration_sec: measuredBand.minDurationSec,
        max_duration_sec: measuredBand.maxDurationSec,
        timing_episode_id: timingEpisode.episode_id,
        billable_request_sent: false,
        requires_user_decision: false,
        user_reconfirmation_required: false,
        automatic_recovery_expected: true,
        next_step_owner: 'agent',
        same_turn_continuation_required: true,
        next_action: 'revise_narration_then_check_prepare_and_materialize_once',
      };
    }
    if (timingEpisode?.status === 'awaiting_user_decision') {
      return narrationTimingDecisionResult({
        episode: timingEpisode,
        measuredDurationSec,
        billableRequestSent,
      });
    }
    const repairAuthorizationPreserved = !!updatedState.narration_repair
      && updatedState.narration_repair.approval_signature === planIdentity.signature;
    if (!repairAuthorizationPreserved) {
      const evidence: VideoProductionPlanEvidence = {
        ...planIdentity.evidence,
        conflicts: [
          ...planIdentity.evidence.conflicts,
          {
            code: 'narration_repair_identity_unavailable',
            message: 'The synthesized narration transaction is present, but its approved plan files could not produce a safe timing-repair identity.',
            paths: planIdentity.artifactPaths,
          },
        ],
      };
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED',
        message: 'Measured narration does not fit, but the timing-repair authorization could not be persisted. Preserve the synthesized audio and transaction, do not send another speech request, and do not reopen production plan confirmation. Repair the narration plan-alignment invariant, then resume the bounded timing repair.',
        path: outputAbsPath,
        measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
        target_duration_sec: targetDurationSec,
        billable_request_sent: billableRequestSent,
        evidence,
        blocked_operation: 'composition.materialize_narration',
        requires_user_decision: false,
        preserved_artifacts: ['narration_audio', 'narration_transaction', 'approved_plan'],
        allowed_recovery_ops: ['composition.status', 'composition.reconcile', 'composition.check_narration_fit'],
        next_action: 'repair_narration_plan_alignment_then_resume',
      };
    }
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      message: `Measured narration is ${Math.round(measuredDurationSec * 1000) / 1000}s, outside the approved ${measuredBand.minDurationSec}-${measuredBand.maxDurationSec}s range around the ${targetDurationSec}s target. The synthesized audio, transaction, measured voice calibration, and one automatic timing-repair authorization were preserved. Revise the script and manifest narration together to narration_fit.suggested_units, run composition.check_narration_fit, then composition.prepare and composition.materialize_narration once without requesting production plan confirmation again.`,
      path: outputAbsPath,
      measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
      target_duration_sec: targetDurationSec,
      tolerance_sec: measuredBand.toleranceSec,
      min_duration_sec: measuredBand.minDurationSec,
      max_duration_sec: measuredBand.maxDurationSec,
      billable_request_sent: billableRequestSent,
      requires_user_decision: false,
      automatic_timing_retries_remaining: timingEpisode
        ? Math.max(0, timingEpisode.automatic_retry_limit - timingEpisode.automatic_retries_used)
        : 1,
      narration_fit: compositionNarrationFit({
        text,
        targetDurationSec,
        planSignature: planIdentity.signature,
        state: await readVideoProductionState(input.statePath, input.compositionDirAbs),
        ...(narrationSelection.legacy
          ? (input.voice ? { voice: input.voice } : {})
          : { routeRef, voiceRef, language }),
        speed: effectiveSpeed,
      }),
    };
  }

  const sceneWeights = state.narration_transaction?.scene_weights?.length === manifest.scenes.length
    ? state.narration_transaction.scene_weights
    : plannedSceneWeights;
  const retimed = retimeCompositionManifestForNarration({
    ...manifest,
    composition: { ...manifest.composition, target_duration: deliveryTargetDurationSec },
  }, measuredDurationSec, sceneWeights);
  const retimedValidation = CompositionManifestSchema.safeParse(retimed);
  if (!retimedValidation.success) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_RETIME_INVALID',
      message: retimedValidation.error.issues[0]?.message || 'Measured narration timing could not be applied safely.',
      path: outputAbsPath,
      billable_request_sent: billableRequestSent,
    };
  }
  const sceneRetiming = retimedValidation.data.scenes.map((scene, index) => ({
    id: scene.id,
    previous_start: manifest.scenes[index]?.start ?? null,
    previous_duration: manifest.scenes[index]?.duration ?? null,
    start: scene.start,
    duration: scene.duration,
    shifted: Math.abs((manifest.scenes[index]?.start ?? scene.start) - scene.start) > 0.05
      || Math.abs((manifest.scenes[index]?.duration ?? scene.duration) - scene.duration) > 0.05,
  }));
  const scaffoldRetimed = sceneRetiming.some((scene) => scene.shifted);
  await writeJsonAtomic(manifestPath, retimedValidation.data, input.ctx);
  const narrationMapPath = path.join(input.compositionDirAbs, 'narration-map.json');
  await writeJsonAtomic(narrationMapPath, buildCompositionNarrationMap(retimedValidation.data, {
    textSha256: textSha,
    audioSha256: audioSha,
    method: 'scene_estimate_scaled',
    audioDurationSec: measuredDurationSec,
  }));
  const authoredVisualsRecovered = narrationInvariantRecovery
    && artifactsShowAuthoredVisuals(state.artifacts, currentArtifacts, html);
  if (authoredVisualsRecovered) {
    const reconciledHtml = reconcileCompositionHtml(html, retimedValidation.data);
    if (!reconciledHtml.ok) {
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: 'E_NARRATION_VISUAL_RECOVERY_BLOCKED',
        message: reconciledHtml.issues[0]?.message || 'Narration was generated, but protected timing/audio markup could not be reconciled without replacing authored visuals.',
        issues: reconciledHtml.issues,
        path: outputAbsPath,
        billable_request_sent: billableRequestSent,
        blocked_operation: 'composition.materialize_narration',
        requires_user_decision: false,
        preserved_artifacts: ['narration_audio', 'narration_transaction', 'composition_manifest', 'authored_visuals'],
        allowed_recovery_ops: ['composition.status', 'composition.reconcile', 'composition.lint'],
        next_action: 'repair_protected_binding_then_composition.reconcile',
      };
    }
    await writeTextAtomic(htmlPath, reconciledHtml.html, input.ctx);
  } else {
    await writeTextAtomic(htmlPath, buildCompositionScaffold(retimedValidation.data), input.ctx);
  }
  // Files are in their final post-narration form now: the visual signature
  // decides whether the recorded preview (with its approval and design
  // review) survives. Narration-only changes leave it unchanged; a scaffold
  // rebuild or authored-visual drift does not.
  const currentVisualSignature = await videoStudioVisualCompositionSignature(input.compositionDirAbs);
  const finalArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const updated = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    next.narration = {
      status: 'materialized',
      text_sha256: textSha,
      audio_sha256: audioSha,
      path: outputAbsPath,
      measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
      backend,
      ...(!narrationSelection.legacy ? {
        route_ref: routeRef,
        voice_ref: voiceRef,
        language,
        voice: voiceRef,
      } : {}),
      ...(narrationSelection.legacy && input.voice ? { voice: input.voice } : {}),
      speed: effectiveSpeed,
      materialized_at: new Date().toISOString(),
    };
    appendNarrationTransactionHistory(next, next.narration_transaction);
    delete next.narration_transaction;
    delete next.narration_repair;
    next.stage = authoredVisualsRecovered ? 'visuals_ready' : 'narration_ready';
    // The draft muxes the narration audio, so it is always invalidated. The
    // preview is silent: it survives while its visual identity still matches
    // the post-narration tree. Legacy entries without a visual signature keep
    // the old always-invalidate behavior.
    invalidateVisualEvidenceUnlessCurrent(next, currentVisualSignature);
    delete next.draft;
    delete next.blocked_operation;
    next.artifacts = {
      ...finalArtifacts,
      scaffold_html_sha256: authoredVisualsRecovered
        ? state.artifacts.scaffold_html_sha256
        : finalArtifacts.html_sha256,
      scaffold_visual_signature: authoredVisualsRecovered
        ? state.artifacts.scaffold_visual_signature
        : finalArtifacts.visual_signature,
    };
    recordVideoProductionTransition(next, {
      op: 'composition.materialize_narration',
      status: 'passed',
      turnId: input.opts.turnId,
      stage: next.stage,
      artifacts: next.artifacts,
    });
  });
  return {
    ok: true,
    op: 'composition.materialize_narration',
    status: recovered ? 'recovered' : 'passed',
    path: outputAbsPath,
    bytes,
    backend,
    narration_text_sha256: textSha,
    previous_duration_sec: manifest.composition.duration,
    target_duration_sec: deliveryTargetDurationSec,
    narration_target_duration_sec: targetDurationSec,
    reserved_silent_duration_sec: narrationBudget.reservedSilentDurationSec,
    measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
    manifest_path: manifestPath,
    html_path: htmlPath,
    narration_map_path: narrationMapPath,
    alignment_method: 'scene_estimate_scaled',
    scaffold_retimed: scaffoldRetimed,
    // Retiming moves every scene window, which silently invalidates the
    // in-scene motion the model positioned against the OLD windows: on
    // 2026-08-06 the element entrances of scene 2 stayed at their pre-retime
    // times, so the scene's sampled midpoint captured its content still at
    // opacity 0 and QA reported a blank frame instead of a stale tween. The
    // shifted windows are named here so the repair is obvious.
    scene_retiming: sceneRetiming,
    retiming_action: scaffoldRetimed
      ? 'Scene windows moved. Re-time every in-scene tween to its new window — an entrance still positioned at an old time leaves that scene blank at its sampled midpoint — then rerun composition.inspect and composition.snapshot.'
      : 'Scene windows did not move. Keep the existing visual authoring and preview; continue with the current narration binding.',
    visuals_preserved: authoredVisualsRecovered,
    billable_request_sent: billableRequestSent,
    narration_selection: {
      route_ref: routeRef,
      voice_ref: voiceRef,
      display_name: narrationSelection.selection.displayName,
      language,
      speed: effectiveSpeed,
      legacy: narrationSelection.legacy,
    },
    // The narration audio is the user's earliest chance to judge voice and
    // tone — the visual preview is silent, so without this the first audible
    // checkpoint is the rendered draft, where narration changes cost the
    // whole downstream chain.
    narration_audition: {
      audio_path: outputAbsPath,
      duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
      action: 'share_audio_with_user_for_audition_now',
    },
    production_state: await summarizeCompositionProductionState(updated, input.compositionDirAbs),
  };
}

export function createVideoStudioTool(opts: VideoStudioToolOpts): AgentTool {
  // Consecutive identical-argument failures in this turn, keyed by the
  // normalized call payload. See applyVideoStudioFailureBreaker.
  const failureStreaks = new Map<string, number>();
  // `<phase>::<segmentId>` -> the composition signature that already failed
  // that batched QA phase in this turn. See batchedQaNoChangeRefusal.
  const batchedQaFailedSignatures = new Map<string, string>();
  const inner: AgentTool = {
    name: 'video_studio',
    description:
      'VideoStudio-native runtime for durable EDL approvals, billable generation authorization, stateful manifest-bounded HTML video production, runtime speech capabilities, and transcription. Use production.* for AUTO/GENERATE control and composition.* for signed HTML production.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [...OPS],
          description: 'Operation: production.status, production.approve_plan, production.approve_generation, production.segment_qa, composition.status, composition.doctor, composition.reconcile, composition.check_narration_fit, composition.approve_plan, composition.prepare, composition.materialize_narration, composition.lint, composition.inspect, composition.snapshot, composition.draft, composition.submit_design_review, composition.approve_draft, composition.export, speech.capabilities, or speech.transcribe. Segment frames are progress and never create per-segment approval. A required delivered-composition keyframe preview is published and must end the current turn; on a later real user turn, choosing composition.draft records the go-ahead only while that visual identity is current, with no preview-approval operation. Only the production plan, paid generation, and the final video require explicit user decisions. production.status verifies an assembled deliverable when given delivered_video_path, and reports that the check is available once every segment has produced bytes. production.segment_qa runs one QA phase (lint, inspect, or snapshot) across every segment of an assembled production in one call, defaulting to the segments that have no current frames; it returns a per-segment summary with full findings only for failures, and is the AUTO path — the per-composition ops remain for COMPOSE and for re-checking one named segment. An exhausted visual-QA cycle is not restarted by any operation: present the findings, let the user choose another repair round or skipping the check, and their reply grants the next cycle automatically.',
        },
        plan_path: { type: 'string', description: 'Canonical project/plan.json for production.* operations or AUTO child-composition production-plan inheritance.' },
        delivered_video_path: { type: 'string', description: 'Assembled final video to verify against the approved plan on production.status — length, canvas, narration placement, loudness, and declared captions. Checks the artifact, not how it was assembled, so a hand-built file is held to the same bar as one produced by the assembly operations.' },
        segment_id: { type: 'string', description: 'Parent EDL segment id for AUTO child-composition production-plan inheritance.' },
        composition_dir: { type: 'string', description: 'Directory containing composition-manifest.json and generated index.html; prepare may run before index.html exists.' },
        decision_evidence: {
          type: 'object',
          description: 'For a natural-language user reply, pass a native object (never a quoted JSON string or bare reply) containing the model semantic decision and a verbatim excerpt from the current user turn. Do not send this for structured forms. The host verifies provenance, gate scope, version, and safety but does not classify user language with keyword rules. A safely parseable JSON-object string is accepted only as transport recovery; any other malformed value returns a same-turn self-correction result without consuming approval or sending a billable request.',
          properties: {
            source: { type: 'string', enum: ['user_message'] },
            gate: { type: 'string', enum: ['plan', 'generation', 'narration_retry', 'preview', 'draft', 'qa_waiver'] },
            decision: { type: 'string', enum: ['approve', 'revise', 'reject'] },
            quote: { type: 'string' },
          },
          required: ['source', 'gate', 'decision', 'quote'],
        },
        task_title: { type: 'string', description: 'Optional one-line restatement of what the user asked this production to deliver, in the user language, for composition.approve_plan. Display only: review surfaces title the production with it instead of its directory path. It is not part of the approval identity and never reopens a gate.' },
        expected_plan_change: { type: 'boolean', description: 'Set true only when composition.approve_plan consumes an approved production-plan amendment. The operation then fails closed unless the signed manifest signature actually changed; it never converts that mismatch into a recovery form.' },
        output_path: { type: 'string', description: 'Output video path for composition.draft/export, or snapshot path for composition.snapshot. Draft/export output is required and must be outside composition_dir; use project/render. Snapshot output is optional and defaults to the composition directory\'s preview/first-frame.png; a snapshot path inside composition_dir but outside preview/ is relocated there, because capturing into the signed composition invalidates its own preview.' },
        report_path: { type: 'string', description: 'Optional JSON QA report path for composition.draft/export. It must be outside composition_dir; use project/render.' },
        findings_path: { type: 'string', description: 'Optional findings JSON path for composition.inspect/snapshot/draft. A path inside composition_dir but outside qa/ is relocated there, because runtime evidence written into the signed composition invalidates the next preflight.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality; draft uses lower fps/CRF.' },
        fps: { type: 'number', description: 'Frames per second, capped at 60.' },
        strict_render_settings: { type: 'boolean', description: 'Set true only when the user explicitly requires exact fps/render settings. Default false lets final export choose the highest safe fps without another confirmation.' },
        format: { type: 'string', enum: ['mp4', 'webm'], description: 'Output video format. Default mp4.' },
        variables: { type: 'object', description: 'Optional composition variables exposed as window.__ORKAS_VIDEO_VARIABLES__.' },
        visual_baseline_path: { type: 'string', description: 'Optional visual baseline JSON path for advisory preview/draft regression checks.' },
        update_visual_baseline: { type: 'boolean', description: 'Explicitly promote current sampled preview/draft frames to the visual baseline. Never enabled automatically.' },
        waive_qa_findings: { type: 'array', items: { type: 'string' }, description: 'QA finding codes the user chose to skip, for composition.inspect/snapshot/draft and production.segment_qa. Requires decision_evidence with gate qa_waiver quoting the user verbatim from the current turn. Accepted waivers persist on this production: the findings report as informational and stop blocking. Evidence-integrity findings cannot be waived.' },
        voice: { type: 'string', description: 'Legacy schema_version 1 compatibility only. New manifests must use the production-plan-confirmed audio.narration_intent from speech.capabilities.' },
        speed: { type: 'number', description: 'Legacy schema_version 1 compatibility only. New manifests read speed from the production-plan-confirmed audio.narration_intent.' },
        review_verdict: { type: 'string', enum: ['passed', 'repair', 'blocked'], description: 'Structured design-review verdict for composition.submit_design_review. passed requires review_findings to be omitted or []; repair and blocked require one or more concrete unresolved findings.' },
        review_scope: { type: 'string', description: 'What the design review inspected (contact sheet, sampled frames, hierarchy, typography, rhythm).' },
        review_findings: { type: 'array', items: { type: 'string' }, description: 'Unresolved visual defects that still require repair. For review_verdict=passed, omit this field or send []; do not put positive observations or a pass summary here. For repair or blocked, send one or more concrete findings.' },
        quality_scores: {
          type: 'object',
          description: 'Evidence-based 0-100 design scores. cover_communication is always required; reference_fidelity is additionally required for concrete visual references.',
          properties: {
            content_alignment: { type: 'number' },
            cover_communication: { type: 'number' },
            hierarchy: { type: 'number' },
            text_legibility: { type: 'number' },
            motion_readiness: { type: 'number' },
            specificity: { type: 'number' },
            reference_fidelity: { type: 'number' },
          },
          required: ['content_alignment', 'cover_communication', 'hierarchy', 'text_legibility', 'motion_readiness', 'specificity'],
        },
        reviewed_frame_paths: { type: 'array', items: { type: 'string' }, description: 'Every returned snapshot frame path actually inspected during a preview design review. Required to cover the complete current preview frame set before the preview can be shown.' },
        phase: { type: 'string', enum: ['lint', 'inspect', 'snapshot'], description: 'QA phase for production.segment_qa.' },
        segment_ids: { type: 'array', items: { type: 'string' }, description: 'Segments for production.segment_qa. Omit to check every segment the ledger reports as stale or uncaptured.' },
        input_path: { type: 'string', description: 'Input audio/video path for speech.transcribe.' },
        transcript_path: { type: 'string', description: 'Optional transcript JSON output path for speech.transcribe.' },
        model: { type: 'string', description: 'ASR model id/path. Backend-specific.' },
        language: { type: 'string', description: 'ASR language code for speech.transcribe, or auto. For speech.capabilities, the deliverable narration language: the listing then carries only the voices verified for it.' },
        all_voices: { type: 'boolean', description: 'List every eligible voice for speech.capabilities instead of a use-case-diverse sample. Use when the user named a particular voice; the default sample is what a narration choice needs.' },
        timestamps: { type: 'string', enum: ['segment', 'word'], description: 'ASR timestamp detail.' },
        allow_model_download: { type: 'boolean', description: 'Whether native ASR may download a missing model. Backend-specific.' },
      },
      required: ['op'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) {
        return { content: DENY_MESSAGE, isError: true } as ToolResult;
      }

      const rawOp = String(input.op || '').trim();
      // Compatibility for an observed model mistake. Keep the schema canonical
      // so new calls learn the namespaced operation, but do not burn a turn when
      // an older/resumed rollout sends the unambiguous legacy alias.
      let op = (rawOp === 'doctor' ? 'composition.doctor' : rawOp) as VideoStudioOp;
      if (!OPS.has(op)) {
        return { content: `op must be one of: ${[...OPS].join(', ')}`, isError: true } as ToolResult;
      }

      // Resolve once for this call. COMPOSE can route the decision only after
      // it has loaded the durable reviewed candidate below; a plan decision on
      // an unrelated operation or an already-approved plan must remain scoped
      // to the operation the model actually requested.
      const turnPlanDecision = resolveVideoStudioCurrentTurnDecision(
        opts.userMessage,
        'plan',
        input.decision_evidence,
      );
      let decisionRoutedFromOp = '';

      const roots = allowedRoots(opts);

      if (op === 'speech.capabilities') {
        const routes = await listTtsCapabilities(ctx.signal);
        const availability = routes.length > 0
          ? { available: true as const, reason: 'available' as const }
          : getTtsAvailabilityDetails(false);
        // The catalog is ~100 voices and the selection rule below is the host's
        // own; applying it here costs one optional argument and saves the model
        // a result larger than its whole inline budget. all_voices reopens the
        // full eligible catalog for a user who named a specific voice.
        const wantedLanguage = String(input.language || '').trim();
        const listingLimit = input.all_voices === true ? Number.POSITIVE_INFINITY : undefined;
        const listings = publicTtsCapabilities(routes).map((route) => ({
          route,
          listing: listableTtsVoices(route.voices, {
            ...(wantedLanguage ? { language: wantedLanguage } : {}),
            ...(listingLimit === undefined ? {} : { limit: listingLimit }),
          }),
        }));
        const eligibleTotal = listings.reduce((sum, item) => sum + item.listing.eligible, 0);
        return {
          content: resultContent({
            ok: routes.length > 0,
            op,
            status: routes.length ? 'ready' : 'unavailable',
            availability: availability.reason,
            ...(!availability.available ? {
              error_code: availability.errorCode,
              message: availability.message,
              next_action: availability.nextAction,
            } : {}),
            ...(wantedLanguage ? { requested_language: wantedLanguage } : {}),
            ...(wantedLanguage && routes.length && eligibleTotal === 0 ? {
              message: `No configured voice is verified for ${wantedLanguage}. Narrate in a language a listed route covers, or call again with all_voices true to see every voice this account has.`,
            } : {}),
            routes: listings.map(({ route, listing }) => ({
              route_ref: route.routeRef,
              provider: route.provider,
              model: route.model,
              display_name: route.displayName,
              catalog_status: route.catalogStatus,
              default_voice_ref: route.defaultVoiceRef,
              voice_count: listing.eligible,
              ...(listing.voices.length < listing.eligible
                ? { voices_shown: listing.voices.length }
                : {}),
              voices: listing.voices.map((voice) => ({
                voice_ref: voice.voiceRef,
                display_name: voice.displayName,
                locale: voice.locale,
                native_locale: voice.nativeLocale,
                supported_locales: voice.supportedLocales,
                mixed_language_support: voice.mixedLanguageSupport,
                language_confidence: voice.languageConfidence,
                // Only when nothing named the voice's language. The host lists
                // it BECAUSE it cannot be ruled out for the requested
                // language; without saying so, `supported_locales:["und"]`
                // reads as proof it speaks something else.
                ...(voice.languageDeclared === false
                  ? {
                    language_declared: false,
                    language_note: 'This endpoint publishes no voice catalog, so nothing declares what this voice speaks.'
                      + ' It is listed because it cannot be ruled out for the requested language, not because it was checked.'
                      + ' It is usable: select it, and judge the language from the first synthesized line.',
                  }
                  : {}),
                ...(voice.accent ? { accent: voice.accent } : {}),
                gender: voice.gender,
                style_tags: voice.styleTags,
                use_cases: voice.useCases,
                is_default: voice.isDefault,
              })),
              supports: route.supports,
            })),
            invariant: 'When no route is listed, narration cannot be synthesized at all: the ways out are delivering with captions and no narration track, or the setup named by this result. A narration audio file the user supplies is NOT one of them — a schema_version 2 plan takes narration only from a route listed here and no segment or track binds supplied audio, so do not offer that (2026-08-09: it was offered, and it cannot work). Choose only a returned route_ref + voice_ref pair, and sign route_ref, voice_ref, language, display_name, and speed during production plan confirmation. Pass language to list only the voices verified for the deliverable language; without it the list spans every language, a voice qualifies on native_locale or verified supported_locales, language_confidence=candidate stays unavailable for non-native production until verified EXCEPT when language_declared is false, which means nothing declares this voice\'s language at all — such a voice is listed because it cannot be ruled out and is usable, so select it rather than abandoning narration, and mixed_language_support permits inline foreign tokens rather than an unsupported narration language. voices_shown under voice_count means the list is a use-case-diverse sample of the eligible voices — pass all_voices true for the rest, as when the user named a particular voice. Never invent or pass an ad hoc provider voice id.',
          }),
          isError: routes.length === 0,
        } as ToolResult;
      }

      if (op.startsWith('production.')) {
        const planRaw = String(input.plan_path || '').trim();
        if (!planRaw) return { content: 'plan_path is required for production.*', isError: true } as ToolResult;
        const planAbs = resolvePath(ctx, opts, planRaw, roots);
        if (!isPathAllowed(planAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: plan_path is outside scope: ${planAbs}`, isError: true } as ToolResult;
        }
        const planErr = await ensureInputFile(planAbs, 'plan_path');
        if (planErr) return { content: planErr, isError: true } as ToolResult;
        const statePath = videoProductionControlStatePath({
          userId: opts.userId,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          planPath: planAbs,
        });
        try {
          if (op === 'production.status') {
            const identity = await readVideoProductionPlanIdentity(planAbs);
            const state = await readVideoProductionControlState(statePath, planAbs);
            const records = await videoProductionSegmentReviewRecords({
              opts,
              planPathAbs: planAbs,
              identity,
              roots,
            });
            const review = videoProductionReviewStatus({
              identity,
              facts: records.map((record) => record.fact),
            });
            // Verify the DELIVERED artifact, not the route that produced it.
            // Every assembly check lives on the op that performs the step, so
            // hand-written ffmpeg — a legitimate fallback that stays available
            // — drops all of them at once: the 2026-08-10 run shipped 0.44s of
            // two voices, -18.3 LUFS, and none of its 8 declared caption lines
            // while reporting success. Reading the file and the signed plan
            // holds every route to one bar without closing the fallback.
            let deliveryCheck: Record<string, unknown> | undefined;
            const deliveredPathRaw = typeof input.delivered_video_path === 'string'
              ? input.delivered_video_path.trim()
              : '';
            if (deliveredPathRaw) {
              const deliveredAbs = path.isAbsolute(deliveredPathRaw)
                ? deliveredPathRaw
                : path.resolve(path.dirname(planAbs), deliveredPathRaw);
              const missing = await ensureInputFile(deliveredAbs, 'delivered_video_path');
              if (missing) return { content: missing, isError: true } as ToolResult;
              deliveryCheck = await verifyProductionDelivery({
                planAbsPath: planAbs,
                plan: identity.plan,
                videoAbsPath: deliveredAbs,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              }) as unknown as Record<string, unknown>;
            } else if (videoProductionLooksAssembled(identity.plan)) {
              deliveryCheck = {
                status: 'not_run',
                reason: 'Every segment reports a produced_path, so this production has something to deliver.'
                  + ' Pass delivered_video_path to have the final file checked against the approved plan —'
                  + ' length, canvas, narration placement, loudness, and declared captions — whichever way it'
                  + ' was assembled. This is the QA headline the final-video stop needs.',
              };
            }
            // The host hands the plan text over for an unapproved plan so the
            // model always has the exact wording to present; nothing records
            // that it did, because nothing reads such a record — the
            // presentation gate that would have was withdrawn the same day it
            // shipped (unobservable property, two false positives).
            return {
              content: resultContent({
                ok: true,
                op,
                status: 'reported',
                ...(deliveryCheck ? { delivery_check: deliveryCheck } : {}),
                ...(state.plan_approval ? {} : {
                  plan_summary: renderVideoProductionPlanSummary(identity.plan),
                  plan_presentation: 'This plan is not approved yet. Present plan_summary verbatim in the user\'s language before asking them to approve it.',
                }),
                production_control: videoProductionControlSummary(identity, state),
                production_review: {
                  renderable: review.renderable,
                  uncaptured_segment_ids: review.uncaptured_segment_ids,
                  segments: review.segments,
                  invariant: 'Segment frames are shown to the user, never put to them for approval: publish the current frames and keep working. Only the production plan, paid generation, and the final video wait for the user. A segment listed in uncaptured_segment_ids has no current frames and needs its QA phase re-run; everything else is ready to assemble.',
                },
              }),
              isError: false,
            } as ToolResult;
          }
          if (op === 'production.segment_qa') {
            const phase = String(input.phase || '').trim();
            if (phase !== 'lint' && phase !== 'inspect' && phase !== 'snapshot') {
              return { content: 'E_SEGMENT_QA_PHASE_REQUIRED: phase must be lint, inspect, or snapshot.', isError: true } as ToolResult;
            }
            const requestedSegmentIds = Array.isArray(input.segment_ids)
              ? input.segment_ids.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim())
              : [];
            const requestedQaWaivers = normalizedQaWaiverCodes(input.waive_qa_findings);
            let waiverQuote = '';
            if (requestedQaWaivers.length) {
              const verdict = verifyQaWaiverRequest(op, opts.userMessage, requestedQaWaivers, input.decision_evidence);
              if (verdict.error) {
                return { content: resultContent(verdict.error), isError: true } as ToolResult;
              }
              waiverQuote = verdict.quote || '';
            }
            const batch = await runProductionSegmentQa({
              opts,
              ctx,
              planPathAbs: planAbs,
              phase,
              requestedSegmentIds,
              roots,
              failedSignatures: batchedQaFailedSignatures,
              ...(requestedQaWaivers.length ? { waiveQaFindings: requestedQaWaivers, waiverQuote } : {}),
            });
            const productionContactSheet = batch.ok === true
              && phase === 'snapshot'
              && typeof batch.production_contact_sheet === 'string'
              ? batch.production_contact_sheet
              : '';
            const modelVisual = productionContactSheet
              ? await prepareVideoStudioModelVisual(productionContactSheet)
              : null;
            const modelFacingBatch = modelVisual
              ? {
                  ...batch,
                  visual_evidence: {
                    attached: true,
                    role: 'production_contact_sheet',
                    path: productionContactSheet,
                    policy: 'attached_only_after_all_segment_snapshot_qa_passed',
                  },
                }
              : batch;
            return {
              content: resultContent(modelFacingBatch),
              ...(modelVisual ? { images: [modelVisual] } : {}),
              isError: batch.ok !== true,
            } as ToolResult;
          }
          if (!opts.turnId) {
            return { content: 'E_VIDEO_PRODUCTION_APPROVAL_TURN_REQUIRED: approval must be recorded in the current user turn.', isError: true } as ToolResult;
          }
          if (op === 'production.approve_plan') {
            const resolvedDecision = resolveVideoStudioCurrentTurnDecision(
              opts.userMessage,
              'plan',
              input.decision_evidence,
            );
            if (!currentUserTurnAvailable(opts.userMessage)) {
              return {
                content: resultContent(missingUserTurnGateResult(op, 'plan')),
                isError: true,
              } as ToolResult;
            }
            const invalidEvidence = decisionEvidenceCorrectionResult(op, 'plan', resolvedDecision, {
              correctOmittedEvidence: true,
            });
            if (invalidEvidence) {
              return { content: resultContent(invalidEvidence), isError: true } as ToolResult;
            }
            // Same exemption as the composition line: a change the user named
            // in this turn does not have to be confirmed back to them. The
            // quote is host-verified against the current user message, the
            // caller must declare it is applying a change, and the EDL must
            // actually differ from the one already approved.
            const controlBefore = await readVideoProductionControlState(statePath, planAbs).catch(() => null);
            const identityNow = await readVideoProductionPlanIdentity(planAbs).catch(() => null);
            const priorPlanSignature = controlBefore?.plan_approval?.signature || '';
            const edlChanged = !!priorPlanSignature && !!identityNow
              && priorPlanSignature !== identityNow.signature;
            const userInstructed = resolvedDecision.decision === 'revise'
              && resolvedDecision.evidence_status === 'valid'
              && input.expected_plan_change === true
              && edlChanged;
            if (resolvedDecision.decision !== 'approve' && !userInstructed) {
              const digest = videoProductionPlanDigest(identityNow?.plan);
              return {
                content: resultContent({
                  ok: false,
                  op,
                  errorCode: 'E_VIDEO_PRODUCTION_GATE_B_EXPLICIT_APPROVAL_REQUIRED',
                  message: 'The current real user turn must explicitly approve this plan, or name the exact change being applied'
                    + ' (decision_evidence decision="revise" quoting the user, with expected_plan_change=true).'
                    + ' Present plan_summary below to the user verbatim, in their language, then end the turn.',
                  presentation_required: true,
                  requires_user_decision: true,
                  next_step_owner: 'user',
                  next_action: 'present_plan_then_await_user_decision',
                  ...(identityNow ? { plan_summary: renderVideoProductionPlanSummary(identityNow.plan) } : {}),
                  ...(digest ? { plan_digest: digest } : {}),
                }),
                isError: true,
              } as ToolResult;
            }
            // No refusal here. Presentation cannot be verified from inside a
            // tool call — the host never sees the assistant's message — so the
            // gate that required a recorded hand-over in an earlier turn was a
            // proxy, and two live runs (2026-08-08) showed the proxy is wrong
            // in the common case: both models composed a complete plan of
            // their own and called approve_plan only after the user replied,
            // so both were refused and both cost the user a confirmation for
            // presenting correctly. Two false positives, no true positive, and
            // the cost lands on the one metric this whole gate class exists to
            // protect. What survives is the part that worked: the host renders
            // the plan and hands it over (production.status for an unapproved
            // plan, and the no-evidence branch above), so the model always has
            // the exact text, and the hand-over is recorded for diagnostics.
            // Budget every narration line BEFORE the plan is signed. Each of
            // these would otherwise surface as its own E_TTS_TEXT_TOO_LONG at
            // the paid gate, one line per round trip, against an already
            // user-approved script; the resulting shorten is then the exact
            // fit-repair the inheritance rule exists to absorb. One reply
            // here lists every over-budget line, and the model repairs them
            // in the same turn the user's approval evidence is still valid,
            // so the confirmation count does not move.
            if (identityNow) {
              const overBudget = edlNarrationBudgetIssues(identityNow.plan);
              if (overBudget.length) {
                return {
                  content: resultContent({
                    ok: false,
                    op,
                    errorCode: 'E_VIDEO_PRODUCTION_NARRATION_OVERBUDGET',
                    message: `${overBudget.length} narration line(s) cannot be spoken inside their windows: `
                      + overBudget.map((line) => `line ${line.index} needs ~${line.estimated_sec}s for a ${line.target_sec}s window — it has ${line.current_units} ${line.unit}, cut about ${line.remove_units} to reach ≈${line.shorten_to_units}`).join('; ')
                      + '. Shorten those lines in the plan (retiming their windows as needed) and call this operation again in this turn. Cut to the stated counts rather than trimming by eye — a line that lands over budget again costs another full round. No approval was recorded and no synthesis was attempted.',
                    over_budget_lines: overBudget,
                    next_action: 'shorten_listed_lines_then_retry_production.approve_plan',
                    billable_request_sent: false,
                  }),
                  isError: true,
                } as ToolResult;
              }
            }
            const narrationSelection = await validateEdlNarrationSelection(planAbs, ctx.signal);
            if (narrationSelection.ok === false) {
              return { content: `${narrationSelection.errorCode}: ${narrationSelection.message}`, isError: true } as ToolResult;
            }
            const approved = await approveVideoProductionPlan({ statePath, planPath: planAbs, turnId: opts.turnId });
            return {
              content: resultContent({
                ok: true,
                op,
                status: 'approved',
                gate: 'B',
                plan_authorization: userInstructed ? 'user_instruction' : 'explicit_approval',
                ...(userInstructed ? {
                  message: 'The user named this change in the current turn, so applying it is already authorized. Continue to the next reviewable artifact; do not ask them to confirm the change they just asked for.',
                } : {}),
                ...(narrationSelection.selection ? {
                  narration_selection: {
                    route_ref: narrationSelection.selection.routeRef,
                    voice_ref: narrationSelection.selection.voiceRef,
                    display_name: narrationSelection.selection.displayName,
                    language: narrationSelection.selection.language,
                    speed: narrationSelection.speed,
                    legacy: narrationSelection.legacy,
                  },
                } : {}),
                production_control: videoProductionControlSummary(approved.identity, approved.state),
              }),
              isError: false,
            } as ToolResult;
          }
          const resolvedDecision = resolveVideoStudioCurrentTurnDecision(
            opts.userMessage,
            'generation',
            input.decision_evidence,
          );
          if (!currentUserTurnAvailable(opts.userMessage)) {
            return {
              content: resultContent(missingUserTurnGateResult(op, 'generation')),
              isError: true,
            } as ToolResult;
          }
          const invalidEvidence = decisionEvidenceCorrectionResult(op, 'generation', resolvedDecision, {
            correctOmittedEvidence: true,
          });
          if (invalidEvidence) {
            return { content: resultContent(invalidEvidence), isError: true } as ToolResult;
          }
          if (resolvedDecision.decision !== 'approve') {
            return { content: 'E_VIDEO_PRODUCTION_GATE_C_EXPLICIT_APPROVAL_REQUIRED: the current real user turn must explicitly approve the displayed generation count.', isError: true } as ToolResult;
          }
          await validateVideoProductionPlanApproval({ statePath, planPath: planAbs });
          const approved = await approveVideoProductionGeneration({ statePath, planPath: planAbs, turnId: opts.turnId });
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'approved',
              gate: 'C',
              production_control: videoProductionControlSummary(approved.identity, approved.state),
            }),
            isError: false,
          } as ToolResult;
        } catch (err) {
          return { content: (err as Error).message, isError: true } as ToolResult;
        }
      }

      if (op.startsWith('composition.')) {
        const compositionRaw = String(input.composition_dir || '').trim();
        if (!compositionRaw) {
          // Naming the convention costs nothing and the caller cannot infer it:
          // it appears in no skill, and on 2026-08-08 a model that had been told
          // (correctly) to inherit a segment approval with plan_path+segment_id
          // spent four round trips listing directories to guess this argument.
          const segmentId = String(input.segment_id || '').trim();
          const planPath = String(input.plan_path || '').trim();
          const suggestion = segmentId && planPath
            ? ` For segment "${segmentId}" of ${planPath} that is `
              + `${path.posix.join(path.posix.dirname(planPath.split(path.sep).join('/')), 'compositions', segmentId)}, `
              + 'which must already exist.'
            : '';
          return {
            content: resultContent({
              ok: false,
              op,
              errorCode: 'E_COMPOSITION_DIR_REQUIRED',
              message: `composition_dir is required: pass the directory holding this composition's `
                + `composition-manifest.json and index.html.${suggestion}`,
              next_action: 'retry_with_composition_dir',
            }),
            isError: true,
          } as ToolResult;
        }
        const compositionDirAbs = resolvePath(ctx, opts, compositionRaw, roots);
        if (!isPathAllowed(compositionDirAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: composition_dir is outside scope: ${compositionDirAbs}`, isError: true } as ToolResult;
        }
        // What KIND of segment this is decides whether ANY composition
        // operation applies, so it is answered before the directory is
        // examined or created. A 2026-08-09 run called approve_plan for an
        // `edit` segment: the directory was created for it (the manifest
        // derivation then refused, leaving it empty), the artifacts check
        // answered "restore composition-manifest.json" — a file that segment
        // must never have — doctor passed on the empty directory, and
        // reconcile died on a raw ENOENT. The parent plan knew all along.
        //
        // Reads the one field it needs. Resolving the full plan identity here
        // would validate and hash the whole EDL on every composition call to
        // answer "what source is this segment", and would skip the check
        // entirely for a plan with any unrelated validation error.
        {
          const boundSegment = String(input.segment_id || '').trim();
          const boundPlan = String(input.plan_path || '').trim();
          if (boundSegment && boundPlan) {
            const parentPlanAbs = resolvePath(ctx, opts, boundPlan, roots);
            if (isPathAllowed(parentPlanAbs, roots)) {
              const source = await fs.readFile(parentPlanAbs, 'utf8')
                .then((raw) => {
                  const plan = JSON.parse(raw) as { segments?: unknown };
                  const segments = Array.isArray(plan.segments) ? plan.segments : [];
                  const segment = segments.find((entry) => isIntentRecord(entry) && entry.id === boundSegment);
                  return isIntentRecord(segment) ? String(segment.source || '') : '';
                })
                .catch(() => '');
              if (source && source !== 'compose') {
                return {
                  content: resultContent({
                    ok: false,
                    op,
                    errorCode: 'E_PARENT_SEGMENT_NOT_A_COMPOSITION',
                    message: `Segment "${boundSegment}" is ${/^[aeiou]/i.test(source) ? 'an' : 'a'} ${source} segment, not a composition: its artifact is its produced_path file, so it has no composition-manifest.json and no composition operation applies to it. Produce it on its own line and let the production QA phases pick it up from the file.`,
                    next_action: 'produce_this_segment_on_its_own_line',
                    requires_user_decision: false,
                  }),
                  isError: true,
                } as ToolResult;
              }
            }
          }
        }
        const dirCheck = await inspectInputDir(compositionDirAbs);
        const standaloneMissingStatus = op === 'composition.status'
          && !dirCheck.exists
          && !String(input.segment_id || '').trim()
          && !String(input.plan_path || '').trim();
        if (dirCheck.error && !standaloneMissingStatus) {
          // An AUTO child's composition directory holds nothing the model
          // authors before inheritance: composition.approve_plan derives the
          // manifest from the signed parent into it. Demanding the directory
          // exist first made "mkdir" the model's entire first round trip, and
          // the miss-message sent it further astray — on 2026-08-08 the reply
          // to this error was five hand-authored manifests (which the next
          // gate rejected for signing a voice), because "is not a directory"
          // says nothing about WHO creates the contents. The host creates the
          // directory exactly where it creates the manifest; every other
          // composition op with the parent binding points at that step.
          const segmentId = String(input.segment_id || '').trim();
          const planPath = String(input.plan_path || '').trim();
          if (segmentId && planPath) {
            if (op === 'composition.approve_plan') {
              // Created here only because the very next step derives the
              // manifest into it. A non-compose segment derives nothing, so
              // creating one leaves an empty directory that looks like a
              // composition to every later operation — 2026-08-09: doctor
              // passed on it and reconcile died on the missing manifest. The
              // binding check below refuses that segment by name; let it.
              await fs.mkdir(compositionDirAbs, { recursive: true });
            } else {
              return {
                content: resultContent({
                  ok: false,
                  op,
                  errorCode: 'E_PARENT_SEGMENT_NOT_DERIVED',
                  message: `${compositionDirAbs} does not exist yet. For segment "${segmentId}" of ${planPath}, `
                    + 'call composition.approve_plan with the same composition_dir, plan_path, and segment_id first: '
                    + 'it inherits the parent Gate B, creates the directory, and derives composition-manifest.json '
                    + 'from the signed parent. Do not create the directory or author the manifest by hand.',
                  next_action: 'inherit_parent_approval_via_composition.approve_plan',
                }),
                isError: true,
              } as ToolResult;
            }
          } else {
            return { content: dirCheck.error, isError: true } as ToolResult;
          }
        }

        const format = input.format === 'webm' ? 'webm' as RenderFormat : 'mp4' as RenderFormat;
        const quality = (input.quality === 'standard' || input.quality === 'high' || input.quality === 'draft')
          ? input.quality as RenderQuality
          : undefined;
        const fps = typeof input.fps === 'number' ? input.fps : undefined;
        const variables = input.variables && typeof input.variables === 'object' && !Array.isArray(input.variables)
          ? input.variables as Record<string, unknown>
          : undefined;

        let outputAbsPath: string | undefined;
        let requestedOutput = '';
        let renamed = false;
        let snapshotOutputRelocatedFrom = '';
        if (op === 'composition.draft' || op === 'composition.export') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_OUTPUT_PATH_REQUIRED',
                message: 'output_path is required and must sit outside composition_dir. Use project/render/<name>.',
                next_action: 'retry_with_project_render_output',
              }),
              isError: true,
            } as ToolResult;
          }
          requestedOutput = withExtension(resolvePath(ctx, opts, outputRaw, roots), format);
          if (!isPathAllowed(requestedOutput, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requestedOutput}`, isError: true } as ToolResult;
          }
          if (isWithinDirectory(requestedOutput, compositionDirAbs)) {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_COMPOSITION_RUNTIME_OUTPUT_IN_SOURCE',
                message: 'Draft and export output_path must be outside composition_dir so rendered artifacts cannot invalidate authored-input approvals. Use project/render/<name>.',
                next_action: 'retry_with_project_render_output',
              }),
              isError: true,
            } as ToolResult;
          }
          const isMine = opts.hasProducedPath ? (p: string) => opts.hasProducedPath!(p) : () => false;
          const unique = await uniquifyPath(requestedOutput, isMine);
          outputAbsPath = unique.finalPath;
          renamed = unique.renamed;
        } else if (op === 'composition.snapshot') {
          // Snapshots have exactly one canonical destination, prescribed by
          // the skill and excluded from the composition signature, so an
          // omitted output_path is a defaultable argument rather than a
          // failure. It used to cost a full round trip (~30s of model time on
          // 2026-08-07) for a bare string carrying no error code.
          const outputRaw = String(input.output_path || '').trim();
          const requestedSnapshot = outputRaw
            ? withExtension(resolvePath(ctx, opts, outputRaw, roots), 'png')
            : path.join(compositionDirAbs, DEFAULT_SNAPSHOT_OUTPUT_RELATIVE_PATH);
          // A snapshot written into the signed composition — anywhere but the
          // signature-excluded preview/ subtree — invalidates itself: its
          // frame directory carries a fresh random run id, so capturing
          // changes the very signature the draft preflight then compares
          // against. 2026-08-07: the model snapshotted to
          // <composition>/project/render/ (generalizing draft/export's "use
          // project/render" rule), draft answered E_HTML_PREVIEW_STALE, and
          // each retry captured another directory and re-armed the same
          // failure. Six accumulated across four "继续" replies before the
          // user gave up. draft/export refuse an in-source output for exactly
          // this reason; snapshot is the step immediately before draft, so it
          // relocates to the canonical destination and says so rather than
          // spending a round trip on a correction the host can make itself.
          outputAbsPath = runtimeArtifactInsideSignature(requestedSnapshot, compositionDirAbs, 'preview')
            ? path.join(compositionDirAbs, 'preview', path.basename(requestedSnapshot))
            : requestedSnapshot;
          if (outputAbsPath !== requestedSnapshot) snapshotOutputRelocatedFrom = requestedSnapshot;
          if (!isPathAllowed(outputAbsPath, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${outputAbsPath}`, isError: true } as ToolResult;
          }
        }

        const reportAbsPath = typeof input.report_path === 'string' && input.report_path.trim()
          ? resolvePath(ctx, opts, input.report_path, roots)
          : undefined;
        if (reportAbsPath && !isPathAllowed(reportAbsPath, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: report_path is outside scope: ${reportAbsPath}`, isError: true } as ToolResult;
        }
        // The report is this render's durable QA evidence, and the passing-draft
        // projection below points the model at it instead of inlining ~50K
        // characters of per-frame samples. Leaving the file to an optional
        // argument made both conditional on the model supplying it: on
        // 2026-08-09 seven passing drafts arrived with no report_path, so
        // nothing was written, the projection stayed off, and each ~95K result
        // spilled to disk anyway — as an opaque tool-result ref instead of the
        // report. Default it beside the required output, which draft has
        // already refused to place inside composition_dir. Same reasoning as
        // the snapshot default above: a defaultable argument is not worth a
        // round trip. Draft only — export runs once and writes into the
        // directory the user collects the finished video from, so a report
        // nobody asked for does not belong beside it.
        const effectiveReportPath = reportAbsPath
          ?? (outputAbsPath && op === 'composition.draft'
            ? `${outputAbsPath.replace(/\.[^./\\]+$/, '')}-report.json`
            : undefined);
        if ((op === 'composition.draft' || op === 'composition.export')
          && reportAbsPath
          && isWithinDirectory(reportAbsPath, compositionDirAbs)) {
          return {
            content: resultContent({
              ok: false,
              op,
              errorCode: 'E_COMPOSITION_RUNTIME_OUTPUT_IN_SOURCE',
              message: 'Draft and export report_path must be outside composition_dir so runtime reports cannot invalidate authored-input approvals. Use project/render/<name>-report.json.',
              next_action: 'retry_with_project_render_report',
            }),
            isError: true,
          } as ToolResult;
        }
        // Findings are runtime evidence, not authored input, and they carry
        // the same self-invalidation hazard the snapshot destination does:
        // written into the signed composition they change the signature the
        // next preflight compares against. The batched segment-QA path
        // already hard-codes `qa/` for this reason; a model-supplied
        // findings_path gets the same guarantee by relocation.
        const requestedFindings = typeof input.findings_path === 'string' && input.findings_path.trim()
          ? resolvePath(ctx, opts, input.findings_path, roots)
          : undefined;
        const defaultFindingsRelativePath = DEFAULT_QA_FINDINGS_RELATIVE_PATH[op] || '';
        const findingsAbsPath = requestedFindings
          ? (runtimeArtifactInsideSignature(requestedFindings, compositionDirAbs, 'qa')
            ? path.join(compositionDirAbs, 'qa', path.basename(requestedFindings))
            : requestedFindings)
          : (defaultFindingsRelativePath
            ? path.join(compositionDirAbs, defaultFindingsRelativePath)
            : undefined);
        if (findingsAbsPath && !isPathAllowed(findingsAbsPath, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: findings_path is outside scope: ${findingsAbsPath}`, isError: true } as ToolResult;
        }
        const visualBaselineAbsPath = typeof input.visual_baseline_path === 'string' && input.visual_baseline_path.trim()
          ? resolvePath(ctx, opts, input.visual_baseline_path, roots)
          : undefined;
        if (visualBaselineAbsPath && !isPathAllowed(visualBaselineAbsPath, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: visual_baseline_path is outside scope: ${visualBaselineAbsPath}`, isError: true } as ToolResult;
        }

        await migrateConversationScopedVideoStudioState(opts, compositionDirAbs);
        const gateStatePath = videoStudioGateStatePath(opts, compositionDirAbs);
        let stateBefore = await readVideoProductionState(gateStatePath, compositionDirAbs);
        const narrationIdentityBefore = await currentNarrationIdentity(compositionDirAbs);
        stateBefore = await enforceNarrationProductionInvariant({
          statePath: gateStatePath,
          compositionDirAbs,
          state: stateBefore,
          identity: narrationIdentityBefore,
          turnId: opts.turnId,
        });
        stateBefore = await migrateVideoStudioGateSignatureV5(
          gateStatePath,
          'preview',
          compositionDirAbs,
          stateBefore,
        );
        stateBefore = await migrateVideoStudioGateSignatureV5(
          gateStatePath,
          'draft',
          compositionDirAbs,
          stateBefore,
        );
        stateBefore = await grantVisualQaCycleOnUserTurn({
          statePath: gateStatePath,
          compositionDirAbs,
          state: stateBefore,
          opts,
        });

        // A natural-language plan decision belongs to the user turn, not to
        // the first operation the model happens to choose. Route it only while
        // a ready, unapproved candidate from an earlier turn is outstanding;
        // once approval is recorded the candidate is deleted, so later plan
        // evidence cannot hijack draft, narration, QA, or recovery operations.
        if (turnPlanDecision.decision === 'approve'
          && stateBefore.plan_review_candidate
          && stateBefore.plan_review_candidate.checked_turn_id !== opts.turnId
          && op !== 'composition.approve_plan') {
          decisionRoutedFromOp = op;
          op = 'composition.approve_plan';
        }

        // User-authorized QA waivers are accepted before any admission gate:
        // the user already made this decision, and losing it because the
        // operation then failed some other precondition would force the model
        // to ask them to skip the same check twice. Invalid requests fail
        // closed here without writing state.
        const requestedQaWaivers = normalizedQaWaiverCodes(input.waive_qa_findings);
        if (requestedQaWaivers.length) {
          const verdict = verifyQaWaiverRequest(op, opts.userMessage, requestedQaWaivers, input.decision_evidence);
          if (verdict.error) {
            return { content: resultContent(verdict.error), isError: true } as ToolResult;
          }
          stateBefore = await recordQaWaivers({
            statePath: gateStatePath,
            compositionDirAbs,
            codes: requestedQaWaivers,
            quote: verdict.quote || '',
            turnId: opts.turnId,
          });
        }
        const policyFactsBefore = narrationPolicyFacts(stateBefore, narrationIdentityBefore);
        if (PLAN_APPROVAL_REQUIRED_OPS.has(op)) {
          const boundSegmentId = String(input.segment_id || '').trim();
          const boundPlanPath = String(input.plan_path || '').trim();
          const planApproval = await validatePlanApproval(
            gateStatePath,
            compositionDirAbs,
            roots,
            boundSegmentId && boundPlanPath
              ? { segmentId: boundSegmentId, planPath: boundPlanPath }
              : undefined,
          );
          if (planApproval.ok === false) {
            const blockedResult = {
              ok: false,
              op,
              errorCode: planApproval.errorCode,
              message: planApproval.message,
              ...(planApproval.evidence ? { evidence: planApproval.evidence } : {}),
              ...(planApproval.artifactIssues?.length
                ? { artifact_issues: planApproval.artifactIssues }
                : {}),
              billable_request_sent: false,
              ...(stateBefore.current_candidate
                ? { current_candidate: stateBefore.current_candidate }
                : {}),
            };
            const reviewPackage = await deliverReviewPackage({
              opts,
              state: stateBefore,
              result: blockedResult,
              ...(planApproval.evidence ? { planEvidence: planApproval.evidence } : {}),
            });
            return {
              content: resultContent({
                ...blockedResult,
                review_package: reviewPackage,
              }),
              isError: true,
            } as ToolResult;
          }
        }
        const admission = evaluateVideoProductionOperation(stateBefore, op, policyFactsBefore);
        if (admission.ok === false) {
          const blockedResult = {
            ok: false,
            op,
            errorCode: admission.errorCode,
            message: admission.message,
            gate_b_required: admission.errorCode === 'E_GATE_B_APPROVAL_REQUIRED',
            ...(admission.nextAction ? { next_action: admission.nextAction } : {}),
            ...(stateBefore.current_candidate
              ? { current_candidate: stateBefore.current_candidate }
              : {}),
            production_state: summarizeVideoProductionState(stateBefore, policyFactsBefore),
          };
          const reviewPackage = await deliverReviewPackage({
            opts,
            state: stateBefore,
            result: blockedResult,
          });
          return {
            content: resultContent({
              ...blockedResult,
              review_package: reviewPackage,
            }),
            isError: true,
          } as ToolResult;
        }
        if (op === 'composition.status') {
          const [planIdentity, currentArtifacts, repairState] = await Promise.all([
            videoProductionPlanIdentity(compositionDirAbs, {
              approval: stateBefore.plan_approval,
              roots,
            }),
            videoProductionArtifacts(compositionDirAbs),
            videoStudioRepairSummary(opts, compositionDirAbs),
          ]);
          const artifactDrift = !!stateBefore.artifacts.composition_signature
            && stateBefore.artifacts.composition_signature !== currentArtifacts.composition_signature;
          const planRecordRefreshRequired = planIdentity.evidence.observations
            .some((observation) => (
              observation.status === 'relocated'
              || (observation.status === 'changed'
                && planApprovalMatchesIdentity(stateBefore.plan_approval, planIdentity))
            ));
          const planApprovalCurrent = planApprovalMatchesIdentity(
            stateBefore.plan_approval,
            planIdentity,
          );
          const planIdentityMigrated = planApprovalCurrent
            && planIdentity.complete
            && !!stateBefore.plan_approval
            && (
              stateBefore.plan_approval.signature !== planIdentity.signature
              || stateBefore.plan_approval.identity_kind !== 'approved_intent_sha256'
            );
          if (planIdentityMigrated && stateBefore.plan_approval) {
            stateBefore = await updateVideoProductionState(
              gateStatePath,
              compositionDirAbs,
              (next) => {
                if (!next.plan_approval
                  || !planApprovalMatchesIdentity(next.plan_approval, planIdentity)) return;
                next.plan_approval = contentAddressedPlanApproval(
                  next.plan_approval,
                  planIdentity,
                );
              },
            );
          }
          const planArtifactConflict = planIdentity.evidence.conflicts.length > 0
            || (!!stateBefore.plan_approval
              && planIdentity.complete
              && !planApprovalCurrent);
          // The plan itself, not just facts about it. Until now this reported
          // hashes, drift flags and requirement issues while the only readable
          // rendering of the plan lived on the AUTO path, so a COMPOSE run had
          // no operation that could hand the model something to show — and
          // asking for it produced another approval request instead
          // (2026-08-09). Carried while the approval is not yet current, which
          // is exactly when someone still has to read it.
          const planSummary = planApprovalCurrent
            ? undefined
            : await compositionPlanSummaryFor(compositionDirAbs);
          const freshMissingComposition = !dirCheck.exists && stateBefore.revision === 0;
          return {
            content: resultContent({
              ok: true,
              op,
              status: freshMissingComposition ? 'not_started' : 'reported',
              composition_dir_exists: dirCheck.exists,
              ...(freshMissingComposition ? {
                message: 'No composition has been authored at this location yet. Author composition-manifest.json first; after plan approval, composition.prepare owns the generated index.html scaffold.',
                next_action: 'author_composition_manifest',
                billable_request_sent: false,
              } : {}),
              ...(planSummary ? { plan_summary: planSummary } : {}),
              artifact_drift: artifactDrift,
              reconciliation_required: artifactDrift
                || planRecordRefreshRequired
                || planArtifactConflict
                || (!dirCheck.exists && !freshMissingComposition)
                || !!stateBefore.narration_transaction
                || !!stateBefore.active_operation,
              plan_record_refresh_required: planRecordRefreshRequired,
              plan_identity_migrated: planIdentityMigrated,
              plan_artifact_conflict: planArtifactConflict,
              plan_artifacts_present: planIdentity.applicable,
              plan_artifacts_complete: planIdentity.complete,
              plan_requirement_issues: planIdentity.requirementIssues,
              plan_evidence: planIdentity.evidence,
              approved_intent_hash: planApprovalCurrent
                ? planIdentity.signature
                : stateBefore.plan_approval?.signature || null,
              candidate_intent_hash: planIdentity.signature || null,
              plan_approval_current: planApprovalCurrent,
              ...(planApprovalCurrent
                ? {}
                : intentChangesField(approvedPlanIntentChanges(stateBefore.plan_approval, planIdentity))),
              inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
              visual_qa_cycle_stale: !!legacyVisualQaCycle(stateBefore.visual_qa)
                && !currentVisualQaCycle(stateBefore.visual_qa),
              repair_state: repairState,
              production_state: summarizeVideoProductionState(stateBefore, policyFactsBefore),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.doctor') {
          const result = await compositionDoctor(compositionDirAbs);
          const checkedState = await recordCompositionDoctorResult(
            gateStatePath,
            compositionDirAbs,
            result,
            opts.turnId,
          );
          result.production_state = await summarizeCompositionProductionState(checkedState, compositionDirAbs);
          return { content: resultContent(result), isError: result.ok !== true } as ToolResult;
        }
        if (op === 'composition.reconcile') {
          const result = await reconcileVideoProduction({
            compositionDirAbs,
            statePath: gateStatePath,
            roots,
            turnId: opts.turnId,
            ctx,
          });
          if (result.ok) await notifyWritten(opts, [result.html_path]);
          let reconciledState = await recordCurrentVideoProductionCandidate({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            result,
          });
          if (result.ok !== true) {
            result.review_package = await deliverReviewPackage({
              opts,
              state: reconciledState,
              result,
            });
          }
          if (reconciledState.current_candidate) {
            result.current_candidate = reconciledState.current_candidate;
          }
          result.production_state = await summarizeCompositionProductionState(reconciledState, compositionDirAbs);
          return { content: resultContent(result), isError: result.ok !== true } as ToolResult;
        }
        if (op === 'composition.check_narration_fit') {
          const pendingPlanReview = stateBefore.plan_review_candidate;
          const replyTargetsEarlierReview = !!pendingPlanReview
            && !!opts.turnId
            && !!pendingPlanReview.checked_turn_id
            && pendingPlanReview.checked_turn_id !== opts.turnId
            && currentUserTurnAvailable(opts.userMessage);
          if (replyTargetsEarlierReview && turnPlanDecision.decision !== 'revise') {
            const invalidEvidence = decisionEvidenceCorrectionResult(
              'composition.approve_plan',
              'plan',
              turnPlanDecision,
              { correctOmittedEvidence: true },
            );
            if (invalidEvidence) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                presentable: false,
                result: invalidEvidence,
              });
            }
            return reviewToolResult({
              opts,
              state: stateBefore,
              presentable: false,
              result: {
                ok: false,
                op,
                errorCode: turnPlanDecision.decision === 'reject'
                  ? 'E_GATE_B_REPLY_REJECTED_PLAN'
                  : 'E_GATE_B_REPLY_UNRESOLVED',
                message: turnPlanDecision.decision === 'reject'
                  ? 'The current user reply rejects the reviewed production plan. Honor that decision or apply the change they requested; do not run another fit check or ask them to reject it again.'
                  : 'A ready production plan was reviewed in an earlier turn and the current real user reply is still available. Classify that reply once. If it approves the plan, retry any VideoStudio operation with plan decision_evidence and the same composition_dir; the host will record approval before that operation. If it is a question or unrelated, answer it without reopening the production-plan confirmation.',
                reviewed_plan_signature: pendingPlanReview.signature,
                decision_received: turnPlanDecision.decision === 'reject',
                decision_still_valid: turnPlanDecision.decision === 'reject',
                requires_user_decision: false,
                user_reconfirmation_required: false,
                presentation_required: false,
                next_step_owner: 'agent',
                same_turn_continuation_required: true,
                next_action: turnPlanDecision.decision === 'reject'
                  ? 'honor_current_plan_rejection_without_reconfirmation'
                  : 'classify_current_reply_then_retry_with_plan_evidence_or_continue_without_gate',
              },
            });
          }
          if (typeof input.speed === 'number'
            && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) {
            return {
              content: 'E_TTS_SPEED_INVALID: speed must be between 0.5 and 2.0; prefer a natural pace near 1.0.',
              isError: true,
            } as ToolResult;
          }
          // A segment of an assembled production carries narration text only so
          // frames can be captioned and timed; the parent EDL owns the voice
          // and the mix. Without this short-circuit the schema-v2 path answers
          // "sign an audio.narration_intent" — the exact instruction that made
          // a silent segment sign a voice on 2026-08-04 — and the v1 path runs
          // a fit check whose repair loop edits words the parent already signed.
          const ownerFit = await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8')
            .then((raw) => (JSON.parse(raw) as { audio?: { owner?: unknown } }).audio?.owner)
            .catch((err) => {
              log.warn('narration fit owner lookup failed', { error: logErrorSummary(err) });
              return undefined;
            });
          if (ownerFit === 'assembler') {
            return {
              content: resultContent({
                ok: true,
                op,
                status: 'not_applicable',
                gate_b_ready: true,
                gate_b_required: false,
                requires_user_decision: false,
                billable_request_sent: false,
                message: 'This composition declares audio.owner:"assembler": the parent production owns narration selection, timing fit, and synthesis, and this segment renders silent. There is nothing to fit here — do not sign an audio.narration_intent and do not edit narration text for timing. Continue with visual authoring and the parent production flow.',
                next_action: 'continue_visual_authoring',
              }),
              isError: false,
            } as ToolResult;
          }
          const identity = await videoProductionPlanIdentity(compositionDirAbs, {
            approval: stateBefore.plan_approval,
            roots,
          });
          if (!identity.complete) {
            const artifactInvalid = (identity.artifactIssues?.length || 0) > 0;
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: identity.evidence.conflicts.length > 0
                  ? 'E_NARRATION_FIT_ARTIFACT_CONFLICT'
                  : artifactInvalid
                    ? 'E_NARRATION_FIT_ARTIFACT_INVALID'
                    : 'E_NARRATION_FIT_ARTIFACTS_INCOMPLETE',
                message: identity.evidence.conflicts[0]?.message
                  || (artifactInvalid
                    ? 'The current plan files are present, but one or more files could not be parsed or validated. Repair the listed file fields without changing the approved meaning, then retry this free check in the same turn.'
                    : 'The canonical plan manifest is missing. Restore composition-manifest.json before checking narration fit.'),
                evidence: identity.evidence,
                artifact_issues: identity.artifactIssues || [],
                billable_request_sent: false,
                requires_user_decision: false,
                next_action: artifactInvalid
                  ? 'repair_invalid_plan_artifacts_then_recheck_narration_fit'
                  : 'restore_missing_plan_artifacts_then_recheck_narration_fit',
              },
            });
          }
          if (identity.requirementIssues.length > 0) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_GATE_B_REQUIREMENTS_INCOMPLETE',
                message: `Resolve the production-plan metadata or narration-alignment issues before confirmation: ${identity.requirementIssues.join(', ')}.`,
                evidence: identity.evidence,
                requirement_issues: identity.requirementIssues,
                requires_user_decision: false,
                next_action: 'repair_current_plan_artifacts_then_recheck_narration_fit',
              },
            });
          }
          let manifest: CompositionManifest;
          try {
            manifest = CompositionManifestSchema.parse(JSON.parse(
              await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
            ));
          } catch (err) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
                message: compositionManifestFailure(err).detail,
                evidence: identity.evidence,
                requires_user_decision: false,
                next_action: 'repair_current_manifest_then_recheck_narration_fit',
              },
            });
          }
          const text = compositionNarrationText(manifest);
          if (!text) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_NARRATION_TEXT_MISSING',
                message: 'Add the complete candidate narration_text to manifest scenes before checking production-plan narration fit.',
                evidence: identity.evidence,
                requires_user_decision: false,
                next_action: 'repair_current_script_and_manifest_then_recheck_narration_fit',
              },
            });
          }
          const narrationSelection = await resolveCompositionNarrationSelection({
            manifest,
            ...(typeof input.voice === 'string' && input.voice.trim() ? { legacyVoice: input.voice.trim() } : {}),
            ...(typeof input.speed === 'number' ? { legacySpeed: input.speed } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (narrationSelection.ok === false) {
            return {
              content: `${narrationSelection.errorCode}: ${narrationSelection.message}`,
              isError: true,
            } as ToolResult;
          }
          const deliveryTargetDurationSec = await approvedTargetDurationSec(manifest, identity);
          const fit = compositionNarrationFit({
            text,
            targetDurationSec: narrationTimingBudget(manifest, deliveryTargetDurationSec).targetDurationSec,
            planSignature: identity.signature,
            state: stateBefore,
            ...(narrationSelection.legacy
              ? (typeof input.voice === 'string' && input.voice.trim() ? { voice: input.voice.trim() } : {})
              : {
                routeRef: narrationSelection.selection.routeRef,
                voiceRef: narrationSelection.selection.voiceRef,
                language: narrationSelection.selection.language,
              }),
            speed: narrationSelection.speed,
          });
          const pendingTimingEpisode = stateBefore.narration_timing_episode?.status === 'awaiting_user_decision'
            && [
              identity.signature,
              stateBefore.plan_approval?.signature,
              stateBefore.narration_repair?.approval_signature,
            ].includes(stateBefore.narration_timing_episode.approval_signature)
            ? stateBefore.narration_timing_episode
            : undefined;
          if (pendingTimingEpisode) {
            const decision = resolveNarrationRetryDecision(opts.userMessage, input.decision_evidence);
            const invalidEvidence = decisionEvidenceCorrectionResult(op, 'narration_retry', decision.decision);
            if (invalidEvidence) {
              return { content: resultContent(invalidEvidence), isError: true } as ToolResult;
            }
            if (decision.decision.decision === 'reject') {
              return {
                content: resultContent({
                  ok: false,
                  op,
                  errorCode: 'E_NARRATION_TIMING_WAIVER_MATERIALIZATION_REQUIRED',
                  message: 'The user chose to continue with the current complete narration. Call composition.materialize_narration now with the same current-turn narration_retry decision evidence so the duration waiver is recorded and the composition is retimed without truncating speech.',
                  billable_request_sent: false,
                  requires_user_decision: false,
                  user_reconfirmation_required: false,
                  same_turn_continuation_required: true,
                  next_step_owner: 'agent',
                  next_action: 'composition.materialize_narration',
                }),
                isError: true,
              } as ToolResult;
            }
            if (decision.decision.decision === 'unknown') {
              const blocked = narrationTimingDecisionResult({
                episode: pendingTimingEpisode,
                measuredDurationSec: pendingTimingEpisode.latest_measured_duration_sec,
                billableRequestSent: false,
              });
              return {
                content: resultContent({ ...blocked, op }),
                isError: true,
              } as ToolResult;
            }
            stateBefore = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
              const episode = next.narration_timing_episode;
              if (!episode || episode.episode_id !== pendingTimingEpisode.episode_id
                || episode.status !== 'awaiting_user_decision') {
                throw new Error('E_NARRATION_TIMING_DECISION_STATE_CHANGED: timing episode changed before authorization.');
              }
              episode.user_authorized_requests += 1;
              episode.status = 'active';
              episode.updated_at = new Date().toISOString();
            });
          }
          const repeatedMeasuredRepairInput = !!stateBefore.narration_repair
            && stateBefore.narration_fit?.source === 'measured_calibration'
            && stateBefore.narration_fit.text_sha256 === fit.text_sha256
            && narrationFitBlocksProduction(stateBefore.narration_fit.status);
          if (repeatedMeasuredRepairInput) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_NARRATION_FIT_RETRY_NO_CHANGE',
                message: 'This exact narration text already failed the measured timing check. Keep the approved voice, target, and structure; make a timing-focused text change before checking again. No new speech request or user confirmation is required.',
                blocked_operation: op,
                same_input_retry_allowed: false,
                requires_user_decision: false,
                billable_request_sent: false,
                allowed_recovery_ops: ['composition.check_narration_fit', 'composition.status'],
                next_action: 'revise_narration_then_composition.check_narration_fit',
                narration_fit: fit,
                production_state: await summarizeCompositionProductionState(stateBefore, compositionDirAbs),
              },
            });
          }
          const repairIdentity = stateBefore.narration_repair
            ? await videoProductionNarrationRepairIdentity(identity)
            : undefined;
          const repairAssessment = assessNarrationRepair({
            authorization: stateBefore.narration_repair,
            identity: repairIdentity,
            fit,
            state: stateBefore,
          });
          const approvalInherited = repairAssessment.status === 'inheritable';
          const planApprovalCurrent = planApprovalMatchesIdentity(stateBefore.plan_approval, identity);
          const gateBRequired = !planApprovalCurrent && (repairAssessment.status === 'none'
            || repairAssessment.status === 'rejected');
          const fitReady = !narrationFitBlocksProduction(fit.status);
          const archivedNarrationPath = approvalInherited
            ? await archiveStaleNarrationAudio({
              state: stateBefore,
              currentNarrationTextSha: fit.text_sha256,
              compositionDirAbs,
              roots,
            })
            : '';
          const repairedVisualSignature = approvalInherited
            ? await videoStudioVisualCompositionSignature(compositionDirAbs).catch(() => '')
            : '';
          const checked = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
            next.narration_fit = fit;
            if (gateBRequired && fitReady) {
              next.plan_review_candidate = {
                signature: identity.signature,
                manifest_json: `${JSON.stringify(manifest, null, 2)}\n`,
                ...(opts.turnId ? { checked_turn_id: opts.turnId } : {}),
                checked_at: fit.checked_at,
                validation_version: 1,
              };
            } else if (planApprovalCurrent
              || !fitReady
              || next.plan_review_candidate?.signature !== identity.signature) {
              delete next.plan_review_candidate;
            }
            if (approvalInherited && next.narration_repair) {
              const authorization = next.narration_repair;
              setCurrentPlanApproval(next, {
                gate: 'B',
                signature: identity.signature,
                identity_kind: 'approved_intent_sha256',
                ...(identity.intentPayload ? { intent_snapshot: identity.intentPayload } : {}),
                turn_id: authorization.approval_turn_id,
                approved_at: authorization.approval_at,
                ...(identity.artifactRecords ? { artifact_records: identity.artifactRecords } : {}),
                artifact_paths: identity.artifactPaths,
                inherited_from_signature: authorization.approval_signature,
                inherited_at: new Date().toISOString(),
                inheritance_reason: 'measured_narration_fit_repair',
                validation_version: 3,
              });
              if (next.narration_timing_episode
                && next.narration_timing_episode.approval_signature === authorization.approval_signature) {
                next.narration_timing_episode.approval_signature = identity.signature;
                next.narration_timing_episode.updated_at = new Date().toISOString();
              }
              appendNarrationTransactionHistory(next, next.narration_transaction);
              delete next.narration;
              delete next.narration_transaction;
              delete next.narration_repair;
              invalidateVisualEvidenceUnlessCurrent(next, repairedVisualSignature);
              delete next.draft;
              next.stage = 'manifest_ready';
            } else if (next.narration_repair && repairAssessment.status === 'pending') {
              next.narration_repair.checks_used = repairAssessment.checksUsed || next.narration_repair.checks_used;
            } else if (next.narration_repair && repairAssessment.status === 'rejected') {
              delete next.narration_repair;
            }
            recordVideoProductionTransition(next, {
              op,
              status: 'passed',
              turnId: opts.turnId,
              stage: next.stage,
            });
          });
          if (archivedNarrationPath) await notifyWritten(opts, [archivedNarrationPath]);
          const preparedHtmlPresent = !!(await fs.stat(path.join(compositionDirAbs, 'index.html')).catch(() => null));
          const message = approvalInherited
            ? `${narrationFitMessage(fit)} The existing production plan confirmation was inherited for this bounded measured-duration repair. Do not request it again; run composition.prepare next.`
            : planApprovalCurrent && fitReady
              ? `${narrationFitMessage(fit)} The current production plan confirmation already covers this unchanged narration plan. Do not request it again; follow the current native narration operation.`
            : repairAssessment.status === 'pending'
              ? repairAssessment.reason === 'repair_strategy_review_required'
                ? `${narrationFitMessage(fit)} The prior timing edits did not converge. Keep the existing approval and measured voice profile, diagnose the remaining difference, make a materially different timing-focused revision, and recheck without asking the user or sending another speech request.`
                : `${narrationFitMessage(fit)} This remains an authorized internal timing repair. Revise once more and recheck without requesting production plan confirmation.`
                : repairAssessment.status === 'rejected'
                  ? `${narrationFitMessage(fit)} The change is outside the timing-only repair authorization (${repairAssessment.reason}); a new production plan confirmation is required for the changed plan.`
                  : narrationFitMessage(fit);
          return {
            content: resultContent({
              ok: true,
              op,
              status: fit.status,
              gate_b_ready: fitReady,
              gate_b_required: gateBRequired,
              ...(gateBRequired
                ? intentChangesField(approvedPlanIntentChanges(stateBefore.plan_approval, identity))
                : {}),
              approval_inherited: approvalInherited,
              repair_authorization_status: repairAssessment.status,
              repair_authorization_reason: repairAssessment.reason,
              ...(typeof repairAssessment.editRatio === 'number'
                ? { narration_edit_ratio: Math.round(repairAssessment.editRatio * 10_000) / 10_000 }
                : {}),
              next_action: approvalInherited
                ? 'composition.prepare'
                : planApprovalCurrent && fitReady
                  ? preparedHtmlPresent ? 'composition.materialize_narration' : 'composition.prepare'
                : repairAssessment.status === 'pending'
                  ? 'revise_narration_then_composition.check_narration_fit'
                    : fitReady
                      ? 'open_gate_b'
                      : 'revise_narration_then_composition.check_narration_fit',
              requires_user_decision: gateBRequired,
              allowed_recovery_ops: repairAssessment.status === 'pending'
                ? ['composition.check_narration_fit', 'composition.status']
                : [],
              message,
              billable_request_sent: false,
              narration_selection: {
                route_ref: narrationSelection.selection.routeRef,
                voice_ref: narrationSelection.selection.voiceRef,
                display_name: narrationSelection.selection.displayName,
                language: narrationSelection.selection.language,
                speed: narrationSelection.speed,
                legacy: narrationSelection.legacy,
              },
              ...(archivedNarrationPath ? { archived_narration_path: archivedNarrationPath } : {}),
              narration_fit: fit,
              production_state: await summarizeCompositionProductionState(checked, compositionDirAbs),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.approve_plan') {
          const parentPlanRaw = String(input.plan_path || '').trim();
          const parentSegmentId = String(input.segment_id || '').trim();
          const resolvedPlanDecision = resolveVideoStudioCurrentTurnDecision(
            opts.userMessage,
            'plan',
            input.decision_evidence,
          );
          if (!parentPlanRaw && !parentSegmentId) {
            // AUTO inheritance reuses a recorded parent approval and needs no
            // user turn; a first-party Gate B always does.
            if (!currentUserTurnAvailable(opts.userMessage)) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                result: missingUserTurnGateResult(op, 'plan'),
              });
            }
            const invalidEvidence = decisionEvidenceCorrectionResult(op, 'plan', resolvedPlanDecision, {
              correctOmittedEvidence: true,
            });
            if (invalidEvidence) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                result: invalidEvidence,
              });
            }
          }
          if (parentPlanRaw || parentSegmentId) {
            // Derive the child's plan artifacts from the signed parent before
            // anything grades them. The parent binding IS the child's
            // specification, and the host has held it all along — see
            // materializeChildPlanArtifacts. Deriving from an unapproved
            // parent would launder authorization, so a parent whose approval
            // does not validate is left to the existing error path below.
            if (parentPlanRaw && parentSegmentId) {
              const derivedParentPlanAbs = resolvePath(ctx, opts, parentPlanRaw, roots);
              if (isPathAllowed(derivedParentPlanAbs, roots)) {
                const approvedParent = await validateVideoProductionPlanApproval({
                  statePath: videoProductionControlStatePath({
                    userId: opts.userId,
                    ...(opts.projectId ? { projectId: opts.projectId } : {}),
                    planPath: derivedParentPlanAbs,
                  }),
                  planPath: derivedParentPlanAbs,
                }).catch(() => null);
                if (approvedParent) {
                  await materializeChildPlanArtifacts({
                    parentIdentity: approvedParent.identity,
                    segmentId: parentSegmentId,
                    compositionDirAbs,
                  }).catch(() => ({ written: [] }));
                }
              }
            }
            // An assembled child's audio ownership is judged before standalone
            // plan-artifact validation. The manifest schema's
            // standalone-narration rule assumes a composition that owes its own
            // voice; applied to a segment it reports "sign an
            // audio.narration_intent" at something that must never speak, and
            // following that advice is what produced the 2026-08-04 run's
            // fourth confirmation.
            const rawChildManifest = await fs.readFile(
              path.join(compositionDirAbs, 'composition-manifest.json'),
              'utf8',
            ).then((raw) => JSON.parse(raw) as unknown).catch(() => null);
            const audioFault = rawChildManifest ? parentCompositionAudioFault(rawChildManifest) : '';
            if (audioFault) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                result: {
                  ok: false,
                  op,
                  errorCode: 'E_PARENT_COMPOSITION_AUDIO_OWNERSHIP',
                  message: `AUTO child compositions must remain silent; the parent assembler owns narration and audio. ${audioFault}`,
                  requires_user_decision: false,
                  user_reconfirmation_required: false,
                  next_step_owner: 'agent',
                  same_turn_continuation_required: true,
                  interaction_required: false,
                  billable_request_sent: false,
                  next_action: 'repair_child_audio_ownership_then_retry_composition.approve_plan',
                },
              });
            }
          }
          let identity = await videoProductionPlanIdentity(compositionDirAbs, {
            roots,
            preferLocal: !!parentPlanRaw || !!parentSegmentId,
          });
          let reviewedPlanRestored = false;
          const reviewedPlan = stateBefore.plan_review_candidate;
          const consumesExplicitReviewedApproval = !parentPlanRaw
            && !parentSegmentId
            && resolvedPlanDecision.decision === 'approve'
            && input.expected_plan_change !== true;
          if (consumesExplicitReviewedApproval
            && reviewedPlan
            && identity.signature !== reviewedPlan.signature) {
            let reviewedManifest: CompositionManifest | undefined;
            try {
              reviewedManifest = CompositionManifestSchema.parse(JSON.parse(reviewedPlan.manifest_json));
            } catch {
              reviewedManifest = undefined;
            }
            if (!reviewedManifest
              || compositionPlanIntentSignature(reviewedManifest) !== reviewedPlan.signature) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                presentable: false,
                result: {
                  ok: false,
                  op,
                  errorCode: 'E_GATE_B_REVIEW_SNAPSHOT_INVALID',
                  message: 'The durable reviewed-plan snapshot could not be validated. Preserve the current user approval, recover the reviewed candidate from conversation evidence, and retry in this same turn; do not ask the user to confirm again.',
                  approval_received: true,
                  approval_still_valid: true,
                  requires_user_decision: false,
                  user_reconfirmation_required: false,
                  presentation_required: false,
                  next_step_owner: 'agent',
                  same_turn_continuation_required: true,
                  next_action: 'recover_reviewed_plan_candidate_then_retry_composition.approve_plan',
                },
              });
            }
            const manifestPath = path.join(compositionDirAbs, 'composition-manifest.json');
            try {
              await writeTextAtomic(manifestPath, reviewedPlan.manifest_json, ctx);
              await notifyWritten(opts, [manifestPath]);
              identity = await videoProductionPlanIdentity(compositionDirAbs, { roots });
              reviewedPlanRestored = identity.complete
                && identity.signature === reviewedPlan.signature;
            } catch {
              reviewedPlanRestored = false;
            }
            if (!reviewedPlanRestored) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                presentable: false,
                result: {
                  ok: false,
                  op,
                  errorCode: 'E_GATE_B_REVIEW_SNAPSHOT_RESTORE_FAILED',
                  message: 'The reviewed production plan could not be restored atomically. Keep the current user approval and retry recovery in this same turn; do not reopen the production-plan confirmation.',
                  approval_received: true,
                  approval_still_valid: true,
                  requires_user_decision: false,
                  user_reconfirmation_required: false,
                  presentation_required: false,
                  next_step_owner: 'agent',
                  same_turn_continuation_required: true,
                  next_action: 'retry_reviewed_plan_restore_without_user_reconfirmation',
                },
              });
            }
          }
          const planChanged = !planApprovalMatchesIdentity(stateBefore.plan_approval, identity);
          if (!identity.complete) {
            const artifactInvalid = (identity.artifactIssues?.length || 0) > 0;
            const approvalReceived = resolvedPlanDecision.decision === 'approve';
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: identity.evidence.conflicts.length > 0
                  ? 'E_GATE_B_ARTIFACT_CONFLICT'
                  : artifactInvalid
                    ? 'E_GATE_B_ARTIFACT_INVALID'
                    : 'E_GATE_B_ARTIFACTS_INCOMPLETE',
                message: identity.evidence.conflicts[0]?.message
                  || (artifactInvalid
                    ? `${approvalReceived ? 'Your confirmation is still valid. ' : ''}The current plan files are present, but one or more files could not be parsed or validated. Repair only the listed structure or fields without changing the confirmed plan, then retry approval validation in this same turn.`
                    : `${approvalReceived ? 'Your confirmation was received. ' : ''}The canonical plan manifest is missing. Restore composition-manifest.json, then retry approval validation in this same turn.`),
                evidence: identity.evidence,
                artifact_issues: identity.artifactIssues || [],
                billable_request_sent: false,
                requires_user_decision: false,
                approval_received: approvalReceived,
                approval_still_valid: approvalReceived,
                user_reconfirmation_required: !approvalReceived,
                next_step_owner: 'agent',
                same_turn_continuation_required: true,
                interaction_required: false,
                next_action: artifactInvalid
                  ? 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan'
                  : 'restore_missing_plan_artifacts_then_retry_composition.approve_plan',
              },
            });
          }
          if (identity.requirementIssues.length > 0) {
            const approvalReceived = resolvedPlanDecision.decision === 'approve';
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_GATE_B_REQUIREMENTS_INCOMPLETE',
                message: `Resolve the production-plan metadata or narration-alignment issues before confirmation: ${identity.requirementIssues.join(', ')}.`,
                evidence: identity.evidence,
                requirement_issues: identity.requirementIssues,
                requires_user_decision: false,
                approval_received: approvalReceived,
                approval_still_valid: approvalReceived,
                user_reconfirmation_required: !approvalReceived,
                next_step_owner: 'agent',
                same_turn_continuation_required: true,
                interaction_required: false,
                next_action: 'repair_current_plan_artifacts_before_confirmation',
              },
            });
          }
          let planAuthorization: 'explicit_approval' | 'user_instruction' | 'inherited' = 'inherited';
          let inheritedParent: {
            signature: string;
            turnId: string;
            approvedAt: string;
            planPath: string;
            segmentId: string;
          } | undefined;
          if (parentPlanRaw || parentSegmentId) {
            if (!parentPlanRaw || !parentSegmentId) {
              return { content: 'E_PARENT_COMPOSITION_BINDING_INCOMPLETE: plan_path and segment_id are both required for AUTO production-plan inheritance.', isError: true } as ToolResult;
            }
            const parentPlanAbs = resolvePath(ctx, opts, parentPlanRaw, roots);
            if (!isPathAllowed(parentPlanAbs, roots)) {
              return { content: `E_PATH_OUT_OF_SCOPE: plan_path is outside scope: ${parentPlanAbs}`, isError: true } as ToolResult;
            }
            try {
              const parentStatePath = videoProductionControlStatePath({
                userId: opts.userId,
                ...(opts.projectId ? { projectId: opts.projectId } : {}),
                planPath: parentPlanAbs,
              });
              const parent = await validateVideoProductionPlanApproval({
                statePath: parentStatePath,
                planPath: parentPlanAbs,
              });
              const binding = await validateParentCompositionBinding({
                parentIdentity: parent.identity,
                segmentId: parentSegmentId,
                compositionDirAbs,
              });
              if (binding.ok === false) {
                return { content: `${binding.errorCode}: ${binding.message}`, isError: true } as ToolResult;
              }
              inheritedParent = {
                signature: parent.identity.signature,
                turnId: parent.state.plan_approval!.turn_id,
                approvedAt: parent.state.plan_approval!.approved_at,
                planPath: parentPlanAbs,
                segmentId: parentSegmentId,
              };
            } catch (err) {
              return { content: (err as Error).message, isError: true } as ToolResult;
            }
          } else {
            if (!opts.turnId) {
              return {
                content: 'E_GATE_B_APPROVAL_REQUIRED: plan approval must be recorded in the explicit user-approval turn.',
                isError: true,
              } as ToolResult;
            }
            // A change the user dictated in this turn is already authorized by
            // the instruction itself. On 2026-08-04 the user asked for a brand
            // animation at 12:11, the model applied it at 12:12 and then opened
            // a confirmation asking whether to do what they had just asked for
            // — a whole round trip spent re-agreeing. The exemption is narrow:
            // the quote must appear verbatim in the current user turn (the host
            // checks that), the caller must declare it is applying a change,
            // and the plan must actually have changed. A model-initiated
            // rewrite carries no such quote and still opens a confirmation.
            // `planChanged` is deliberately not part of this condition: the
            // check just below already refuses a declared amendment that did
            // not change anything, and it names that defect precisely instead
            // of reporting a missing approval.
            //
            // A prior approval IS required. An instruction amends a plan the
            // user has already seen; without this condition the very first
            // Gate B could be recorded from a revise quote — planChanged is
            // vacuously true when nothing was ever approved, so the
            // amendment-not-applied check below would never fire, and a plan
            // the user never reviewed would become the signed baseline.
            const hadPlanApproval = !!stateBefore.plan_approval
              || (stateBefore.plan_approval_history?.length || 0) > 0;
            const userInstructed = resolvedPlanDecision.decision === 'revise'
              && resolvedPlanDecision.evidence_status === 'valid'
              && input.expected_plan_change === true
              && hadPlanApproval;
            if (resolvedPlanDecision.decision !== 'approve' && !userInstructed) {
              // Same reason as the production gate: hand back what is being
              // approved, so "the displayed plan" is a thing the model can
              // actually display rather than an assumption about the turn.
              const manifestDigest = await compositionManifestApprovalDigest(compositionDirAbs);
              const manifestSummary = await compositionPlanSummaryFor(compositionDirAbs);
              return {
                content: resultContent({
                  ok: false,
                  op,
                  errorCode: 'E_GATE_B_EXPLICIT_APPROVAL_REQUIRED',
                  message: 'composition.approve_plan is allowed only when the current real user message explicitly approves this plan,'
                    + ' or names the exact change being applied (decision_evidence decision="revise" quoting the user, with expected_plan_change=true).'
                    + ' Show the plan below in their language first — they cannot approve what they have not seen.',
                  presentation_required: true,
                  requires_user_decision: true,
                  next_step_owner: 'user',
                  next_action: 'present_plan_then_await_user_decision',
                  ...(manifestSummary ? { plan_summary: manifestSummary } : {}),
                  ...(manifestDigest ? { plan_digest: manifestDigest } : {}),
                }),
                isError: true,
              } as ToolResult;
            }
            planAuthorization = userInstructed ? 'user_instruction' : 'explicit_approval';
          }
          if (input.expected_plan_change === true && !planChanged) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_GATE_B_AMENDMENT_NOT_APPLIED',
                message: 'The approved production-plan amendment did not change the signed composition manifest. Apply the exact displayed patch to composition-manifest.json, then retry composition.approve_plan in this same approval turn. Do not request visual recovery or another production plan confirmation.',
                expected_plan_change: true,
                plan_changed: false,
                visual_revision_recovery_available: false,
                next_action: 'apply_approved_amendment_then_composition.approve_plan',
                requires_user_decision: false,
              },
            });
          }
          const manifest = CompositionManifestSchema.parse(JSON.parse(
            await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
          ));
          // Narration selection and the fit check belong to whoever will
          // synthesize the audio. An assembled child carries the words so the
          // frames can be captioned and timed, but the parent EDL signs the
          // voice and owns the mix — asking the child for a voice made a silent
          // segment sign one, which is how the 2026-08-04 run acquired its
          // fourth confirmation.
          const approvedNarrationText = manifest.audio.owner === 'assembler'
            ? ''
            : compositionNarrationText(manifest);
          const approvedNarrationTextSha = approvedNarrationText
            ? crypto.createHash('sha256').update(approvedNarrationText).digest('hex')
            : '';
          const approvedNarrationSelection = approvedNarrationText
            ? await resolveCompositionNarrationSelection({
              manifest,
              ...(typeof input.voice === 'string' && input.voice.trim() ? { legacyVoice: input.voice.trim() } : {}),
              ...(typeof input.speed === 'number' ? { legacySpeed: input.speed } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            })
            : undefined;
          if (approvedNarrationSelection?.ok === false) {
            return {
              content: `${approvedNarrationSelection.errorCode}: ${approvedNarrationSelection.message}`,
              isError: true,
            } as ToolResult;
          }
          const approvedNarrationDeliveryTarget = approvedNarrationText
            ? await approvedTargetDurationSec(manifest, identity)
            : 0;
          const approvedNarrationTarget = approvedNarrationText
            ? narrationTimingBudget(manifest, approvedNarrationDeliveryTarget).targetDurationSec
            : 0;
          const checkedNarrationFit = stateBefore.narration_fit?.plan_signature === identity.signature
            && stateBefore.narration_fit.text_sha256 === approvedNarrationTextSha
            && Math.abs(stateBefore.narration_fit.target_duration_sec - approvedNarrationTarget) <= 0.001
            && (!approvedNarrationSelection
              || (approvedNarrationSelection.legacy
                ? Math.abs(stateBefore.narration_fit.speed - approvedNarrationSelection.speed) <= 0.0001
                : (stateBefore.narration_fit.route_ref === approvedNarrationSelection.selection.routeRef
                  && stateBefore.narration_fit.voice_ref === approvedNarrationSelection.selection.voiceRef
                  && Math.abs(stateBefore.narration_fit.speed - approvedNarrationSelection.speed) <= 0.0001)))
            ? stateBefore.narration_fit
            : undefined;
          const approvedNarrationFit = approvedNarrationText
            ? checkedNarrationFit || compositionNarrationFit({
              text: approvedNarrationText,
              targetDurationSec: approvedNarrationTarget,
              planSignature: identity.signature,
              state: stateBefore,
              ...(approvedNarrationSelection?.ok === true
                ? approvedNarrationSelection.legacy
                  ? {
                    ...(typeof input.voice === 'string' && input.voice.trim() ? { voice: input.voice.trim() } : {}),
                    speed: approvedNarrationSelection.speed,
                  }
                  : {
                    routeRef: approvedNarrationSelection.selection.routeRef,
                    voiceRef: approvedNarrationSelection.selection.voiceRef,
                    language: approvedNarrationSelection.selection.language,
                    speed: approvedNarrationSelection.speed,
                  }
                : {}),
            })
            : undefined;
          if (approvedNarrationFit && narrationFitBlocksProduction(approvedNarrationFit.status)) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              planEvidence: identity.evidence,
              result: {
                ok: false,
                op,
                errorCode: 'E_GATE_B_NARRATION_FIT_REQUIRED',
                message: `${narrationFitMessage(approvedNarrationFit)} Revise the candidate files and run composition.check_narration_fit before requesting production plan confirmation again; do not ask the user to approve another known-unfit script.`,
                gate_b_ready: false,
                billable_request_sent: false,
                narration_fit: approvedNarrationFit,
                requires_user_decision: false,
                next_action: 'revise_narration_then_composition.check_narration_fit',
              },
            });
          }
          const currentNarrationTextSha = await currentPlanNarrationTextSha(compositionDirAbs);
          const trackedNarrationTextSha = stateBefore.narration?.text_sha256
            || stateBefore.narration_transaction?.text_sha256;
          const narrationTextStillCurrent = !!trackedNarrationTextSha
            && trackedNarrationTextSha === currentNarrationTextSha;
          const trackedNarration = stateBefore.narration_transaction || stateBefore.narration;
          const narrationSelectionStillCurrent = approvedNarrationSelection?.ok !== true
            || approvedNarrationSelection.legacy
            || (!!trackedNarration
              && trackedNarration.route_ref === approvedNarrationSelection.selection.routeRef
              && trackedNarration.voice_ref === approvedNarrationSelection.selection.voiceRef
              && Math.abs((trackedNarration.speed ?? 1) - approvedNarrationSelection.speed) <= 0.0001);
          const archivedNarrationPath = await archiveStaleNarrationAudio({
            state: stateBefore,
            currentNarrationTextSha,
            compositionDirAbs,
            roots,
          });
          // The plan artifacts are already in their amended form here. A plan
          // amendment that leaves the visual projection untouched (narration
          // wording, audio intent) keeps the recorded preview and its QA
          // cycle; only a visual intent change resets them. Legacy preview
          // entries without a visual signature keep the old full reset.
          const planVisualSignature = planChanged
            ? await videoStudioVisualCompositionSignature(compositionDirAbs)
            : '';
          const previewSurvivesPlanChange = planChanged
            && stateBefore.preview?.visual_signature === planVisualSignature;
          const previewGoAheadSurvivesPlanChange = previewSurvivesPlanChange
            && !!stateBefore.plan_approval?.signature
            && stateBefore.preview_go_ahead?.plan_signature === stateBefore.plan_approval.signature;
          const visualQaReset = planChanged && !previewSurvivesPlanChange && !!stateBefore.visual_qa;
          // Display-only label for review surfaces. Recorded here because the
          // confirmed plan is the one moment the caller has the user's own
          // wording for the whole production; it never takes part in approval
          // identity, and a caller that omits it keeps the previous title.
          const taskTitle = String(input.task_title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const approved = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
            if (taskTitle) next.task_title = taskTitle;
            setCurrentPlanApproval(next, {
              gate: 'B',
              signature: identity.signature,
              identity_kind: 'approved_intent_sha256',
              ...(identity.intentPayload ? { intent_snapshot: identity.intentPayload } : {}),
              turn_id: inheritedParent?.turnId || opts.turnId!,
              approved_at: inheritedParent?.approvedAt || new Date().toISOString(),
              ...(identity.artifactRecords ? { artifact_records: identity.artifactRecords } : {}),
              artifact_paths: identity.artifactPaths,
              ...(inheritedParent ? {
                inherited_from_signature: inheritedParent.signature,
                inherited_at: new Date().toISOString(),
                inheritance_reason: 'parent_edl_segment' as const,
                parent_plan_path: inheritedParent.planPath,
                parent_segment_id: inheritedParent.segmentId,
              } : {}),
              validation_version: 3,
            });
            if (approvedNarrationFit) next.narration_fit = approvedNarrationFit;
            else delete next.narration_fit;
            delete next.narration_repair;
            if (planChanged) {
              if (!(next.preview?.visual_signature && next.preview.visual_signature === planVisualSignature)) {
                delete next.preview;
                delete next.preview_go_ahead;
                delete next.visual_qa;
              } else if (next.preview_go_ahead) {
                if (previewGoAheadSurvivesPlanChange) {
                  // The user has already seen these exact silent frames. Re-key
                  // their reply to the narration-amended plan so draft admission
                  // does not ask them to confirm unchanged visuals again.
                  next.preview_go_ahead = {
                    ...next.preview_go_ahead,
                    plan_signature: identity.signature,
                  };
                } else {
                  delete next.preview_go_ahead;
                }
              }
              delete next.draft;
              if (!narrationTextStillCurrent || !narrationSelectionStillCurrent) {
                delete next.narration;
                appendNarrationTransactionHistory(next, next.narration_transaction);
                delete next.narration_transaction;
                delete next.narration_retry_authorization;
              }
              delete next.capability_check;
              next.stage = 'manifest_ready';
            } else if (next.stage === 'initialized') {
              next.stage = 'manifest_ready';
            }
            recordVideoProductionTransition(next, {
              op,
              status: 'passed',
              turnId: opts.turnId,
              stage: next.stage,
            });
          });
          if (archivedNarrationPath) await notifyWritten(opts, [archivedNarrationPath]);
          // The readable plan is a rendered view of what was just signed, so
          // it exists the moment the plan does and can never disagree with it.
          // Returned as text, never written. A file inside the composition
          // directory would change the composition signature and stale the
          // preview — the same trap the QA findings file fell into earlier
          // today — and the user reads the plan in the confirmation message,
          // not on disk.
          const approvedManifest = await fs.readFile(
            path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8',
          ).then((raw) => CompositionManifestSchema.parse(JSON.parse(raw))).catch(() => null);
          const planScript = approvedManifest
            ? renderPlanScript(
              approvedManifest,
              taskTitle || (await readVideoProductionState(gateStatePath, compositionDirAbs)).task_title || '',
            )
            : '';
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'approved',
              gate: 'B',
              ...(planScript ? { plan_script: planScript } : {}),
              plan_signature: identity.signature,
              approved_intent_hash: identity.signature,
              plan_identity_kind: 'approved_intent_sha256',
              plan_changed: planChanged,
              visual_qa_reset: visualQaReset,
              requires_user_decision: false,
              user_reconfirmation_required: false,
              approval_inherited: !!inheritedParent,
              plan_authorization: planAuthorization,
              ...(decisionRoutedFromOp ? { decision_routed_from_op: decisionRoutedFromOp } : {}),
              ...(reviewedPlanRestored
                ? {
                  reviewed_plan_restored: true,
                  message: 'The user approved the reviewed plan. An unrequested agent rewrite made after that review was discarded, and production continues from the reviewed signature without another confirmation.',
                }
                : {}),
              ...(planAuthorization === 'user_instruction'
                ? {
                  message: 'The user named this change in the current turn, so applying it is already authorized. Continue to the next reviewable artifact; do not ask them to confirm the change they just asked for.',
                }
                : {}),
              ...(approvedNarrationSelection?.ok === true ? {
                narration_selection: {
                  route_ref: approvedNarrationSelection.selection.routeRef,
                  voice_ref: approvedNarrationSelection.selection.voiceRef,
                  display_name: approvedNarrationSelection.selection.displayName,
                  language: approvedNarrationSelection.selection.language,
                  speed: approvedNarrationSelection.speed,
                  legacy: approvedNarrationSelection.legacy,
                },
              } : {}),
              ...(inheritedParent ? {
                inherited_from_parent_plan_signature: inheritedParent.signature,
                parent_segment_id: inheritedParent.segmentId,
              } : {}),
              next_action: planChanged
                ? 'composition.doctor'
                : 'follow_current_native_state_without_visual_reset',
              production_state: await summarizeCompositionProductionState(approved, compositionDirAbs),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.prepare' || op === 'composition.materialize_narration') {
          let checkedState = await readVideoProductionState(gateStatePath, compositionDirAbs);
          if (checkedState.capability_check?.status !== 'ready') {
            const doctorResult = await compositionDoctor(compositionDirAbs);
            checkedState = await recordCompositionDoctorResult(
              gateStatePath,
              compositionDirAbs,
              doctorResult,
              opts.turnId,
            );
            if (doctorResult.ok !== true) {
              return {
                content: resultContent({
                  ...doctorResult,
                  errorCode: 'E_VIDEO_PRODUCTION_CAPABILITY_MISSING',
                  auto_checked: true,
                  production_state: await summarizeCompositionProductionState(checkedState, compositionDirAbs),
                }),
                isError: true,
              } as ToolResult;
            }
          }
          if (checkedState.capability_check?.status !== 'ready') {
            return {
              content: 'E_VIDEO_PRODUCTION_CAPABILITY_MISSING: automatic runtime capability validation did not reach ready state.',
              isError: true,
            } as ToolResult;
          }
        }
        if (op === 'composition.submit_design_review') {
          const verdict = String(input.review_verdict || '').trim().toLowerCase();
          if (verdict !== 'passed' && verdict !== 'repair' && verdict !== 'blocked') {
            return { content: 'E_DESIGN_REVIEW_VERDICT_REQUIRED: review_verdict must be passed, repair, or blocked.', isError: true } as ToolResult;
          }
          const scope = String(input.review_scope || '').trim();
          const findings = Array.isArray(input.review_findings)
            ? input.review_findings.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20)
            : [];
          if (!scope || (verdict !== 'passed' && findings.length === 0)) {
            return { content: 'E_DESIGN_REVIEW_EVIDENCE_REQUIRED: provide review_scope and concrete findings for any non-passing verdict.', isError: true } as ToolResult;
          }
          const reviewKind = stateBefore.draft?.design_review?.required
            ? 'draft'
            : stateBefore.preview?.design_review?.required
              ? 'preview'
              : stateBefore.draft ? 'draft' : 'preview';
          const reviewEntry = stateBefore[reviewKind];
          if ((reviewEntry?.design_review?.status === 'repair' || reviewEntry?.design_review?.status === 'blocked')
            && verdict === 'passed') {
            return {
              content: `E_DESIGN_REVIEW_REPAIR_REQUIRED: a repair/blocked verdict is signature-bound. Change the composition, run composition.reconcile, and generate a new ${reviewKind === 'preview' ? 'snapshot' : 'draft'} before submitting a passed review.`,
              isError: true,
            } as ToolResult;
          }
          const signatureCheck = reviewEntry
            ? await checkVideoStudioGateSignature(compositionDirAbs, reviewEntry)
            : undefined;
          if (!reviewEntry || signatureCheck?.matches !== true) {
            return {
              content: reviewKind === 'preview'
                ? 'E_DESIGN_REVIEW_PREVIEW_STALE: capture a new snapshot before reviewing changed composition inputs.'
                : 'E_DESIGN_REVIEW_DRAFT_STALE: render a new draft before reviewing changed composition inputs.',
              isError: true,
            } as ToolResult;
          }
          const submittedFramePaths = Array.isArray(input.reviewed_frame_paths)
            ? input.reviewed_frame_paths
              .map(String)
              .map((value) => value.trim())
              .filter(Boolean)
            : [];
          const expectedFramePaths = (reviewEntry.frame_paths || []).map((value) => path.resolve(value));
          const submittedPathCandidates = new Set(submittedFramePaths.flatMap((value) => path.isAbsolute(value)
            ? [path.resolve(value)]
            : [path.resolve(compositionDirAbs, value), path.resolve(ctx.workingDir, value)]));
          const reviewedFramePaths = expectedFramePaths.filter((value) => submittedPathCandidates.has(value));
          if (reviewKind === 'preview') {
            if (expectedFramePaths.length === 0) {
              return {
                content: 'E_PREVIEW_DESIGN_REVIEW_EVIDENCE_MISSING: the current snapshot has no recorded frame paths. Capture a new snapshot before design review.',
                isError: true,
              } as ToolResult;
            }
            const missingFramePaths = expectedFramePaths.filter((value) => !submittedPathCandidates.has(value));
            if (missingFramePaths.length > 0) {
              return {
                content: resultContent({
                  ok: false,
                  op,
                  errorCode: 'E_PREVIEW_DESIGN_REVIEW_COVERAGE_REQUIRED',
                  message: 'Inspect every frame returned by the current snapshot in one review pass before submitting a verdict.',
                  reviewed_frame_count: reviewedFramePaths.length,
                  expected_frame_count: expectedFramePaths.length,
                  missing_frame_paths: missingFramePaths,
                }),
                isError: true,
              } as ToolResult;
            }
          }
          const referenceRequirement = await videoStudioReferenceReviewRequirement(compositionDirAbs);
          let qualityScorecard;
          try {
            qualityScorecard = compileVideoStudioDesignQualityScorecard(
              input.quality_scores,
              referenceRequirement.required,
            );
            assertVideoStudioDesignQualityVerdict(
              verdict,
              findings,
              qualityScorecard,
              referenceRequirement.minimumScore,
            );
          } catch (err) {
            return { content: (err as Error).message, isError: true } as ToolResult;
          }
          const signature = reviewEntry.signature;
          let reviewed: VideoProductionStateV1;
          try {
            reviewed = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
              const nextEntry = next[reviewKind];
              if (!nextEntry || nextEntry.signature !== signature) {
                throw new Error(reviewKind === 'preview'
                  ? 'E_DESIGN_REVIEW_PREVIEW_STALE: capture a new snapshot before reviewing changed composition inputs.'
                  : 'E_DESIGN_REVIEW_DRAFT_STALE: render a new draft before reviewing changed composition inputs.');
              }
              nextEntry.design_review = {
                required: true,
                status: verdict,
                reviewed_at: new Date().toISOString(),
                verdict,
                scope,
                findings,
                quality_scorecard: qualityScorecard,
                ...(reviewedFramePaths.length ? { reviewed_frame_paths: reviewedFramePaths } : {}),
              };
              recordVideoProductionTransition(next, {
                op,
                status: 'passed',
                turnId: opts.turnId,
                stage: reviewKind === 'preview' ? 'preview_ready' : 'draft_ready',
              });
            });
          } catch (err) {
            return { content: (err as Error).message, isError: true } as ToolResult;
          }
          if (reviewKind === 'preview' && verdict === 'passed') {
            await publishVisibleOutputs(opts, [reviewEntry.path]);
          }
          const reviewResult: Record<string, unknown> = {
            ok: true,
            op,
            status: verdict,
            review_target: reviewKind,
            reviewed_frame_count: reviewedFramePaths.length,
            expected_frame_count: expectedFramePaths.length,
            quality_scorecard: qualityScorecard,
            ...(reviewKind === 'preview' ? {
              preview_gate_ready: verdict === 'passed',
              contact_sheet: reviewEntry.path || '',
              frame_paths: expectedFramePaths,
            } : {
              gate_d_ready: verdict === 'passed',
            }),
            ...(verdict !== 'passed' ? {
              conclusion_code: reviewKind === 'preview'
                ? 'E_PREVIEW_DESIGN_REVIEW_NOT_ACCEPTED'
                : 'E_DRAFT_DESIGN_REVIEW_NOT_ACCEPTED',
              message: findings.length
                ? `The current ${reviewKind} was not accepted: ${findings.join('; ')}`
                : `The current ${reviewKind} was not accepted by design review.`,
              requires_user_decision: false,
            } : {}),
            next_action: verdict === 'passed'
              ? reviewKind === 'preview' ? 'show_preview_then_wait_for_user_approval' : 'composition.approve_draft'
              : 'repair_visuals_then_composition.reconcile',
            ...(reviewed.current_candidate ? { current_candidate: reviewed.current_candidate } : {}),
            production_state: summarizeVideoProductionState(reviewed),
          };
          if (verdict !== 'passed') {
            return reviewToolResult({
              opts,
              state: reviewed,
              result: reviewResult,
              isError: false,
            });
          }
          return {
            content: resultContent(reviewResult),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.approve_draft') {
          const kind = 'draft' as const;
          // A segment of an assembled production is not a thing the user was
          // asked about: the assembled video is what they confirm, and a
          // segment's own draft is an intermediate the parent assembles.
          const segmentApproval = stateBefore.plan_approval;
          if (segmentApproval?.inheritance_reason === 'parent_edl_segment') {
            return reviewToolResult({
              opts,
              state: stateBefore,
              result: {
                ok: false,
                op,
                errorCode: 'E_SEGMENT_HAS_NO_USER_GATE',
                message: `This composition is segment "${segmentApproval.parent_segment_id || ''}" of an assembled production, which is reviewed as one video. Do not ask the user about a single segment: re-capture it, keep producing, and let the assembled video be what they confirm. This segment's updated frames are already visible in the production review.`,
                requires_user_decision: false,
                user_reconfirmation_required: false,
                next_step_owner: 'agent',
                interaction_required: false,
                same_turn_continuation_required: true,
                billable_request_sent: false,
                ...(segmentApproval.parent_plan_path
                  ? { production_plan_path: segmentApproval.parent_plan_path }
                  : {}),
                next_action: 'read_production_status_then_continue_assembly',
              },
              // The refusal's own point: a segment is not put to the user, so
              // it carries no presentation payload either.
              presentable: false,
            });
          }
          const resolvedDecision = resolveVideoStudioCurrentTurnDecision(
            opts.userMessage,
            kind,
            input.decision_evidence,
          );
          if (!currentUserTurnAvailable(opts.userMessage)) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              result: missingUserTurnGateResult(op, kind),
            });
          }
          const invalidEvidence = decisionEvidenceCorrectionResult(op, kind, resolvedDecision, {
            correctOmittedEvidence: true,
          });
          if (invalidEvidence) {
            return reviewToolResult({
              opts,
              state: stateBefore,
              result: invalidEvidence,
            });
          }
          const explicitlyApproved = resolvedDecision.decision === 'approve';
          const approval = await approveVideoStudioGate(
            gateStatePath,
            kind,
            compositionDirAbs,
            opts.turnId || '',
            explicitlyApproved,
            resolvedDecision.source === 'form'
              ? resolvedDecision.artifact_signature
              : undefined,
          );
          if (approval.ok === false) {
            if (approval.errorCode === 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED') {
              return reviewToolResult({
                opts,
                state: stateBefore,
                result: {
                  ok: false,
                  op,
                  errorCode: approval.errorCode,
                  message: approval.message,
                  submitted_decision_status: approval.submitted_decision_status,
                  submitted_artifact_signature: approval.submitted_artifact_signature,
                  current_artifact_signature: approval.current_artifact_signature,
                  current_review_status: 'pending',
                  requires_user_decision: true,
                  user_reconfirmation_required: false,
                  next_step_owner: 'user',
                  interaction_required: true,
                  interaction_mode: 'resume_current_review',
                  form_policy: 'plain_message_current_artifact_no_duplicate_form',
                  automatic_recovery_expected: false,
                  same_turn_continuation_required: false,
                  user_options: [
                    {
                      id: 'approve_current',
                      label: 'Approve the latest complete video',
                      effect: `Approve only the displayed current ${kind} artifact.`,
                    },
                    {
                      id: 'revise_current',
                      label: 'Request video changes',
                      effect: `Keep the current ${kind} artifact and apply the requested changes.`,
                    },
                  ],
                  billable_request_sent: false,
                  next_action: 'show_current_artifact_and_keep_existing_review_pending',
                  ...(stateBefore.current_candidate
                    ? { current_candidate: stateBefore.current_candidate }
                    : {}),
                },
              });
            }
            return { content: `${approval.errorCode}: ${approval.message}`, isError: true } as ToolResult;
          }
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'approved',
              stage: 'draft_approval',
              artifact_signature: approval.entry.signature,
              approved_at: approval.entry.approved_at,
              decision_source: resolvedDecision.source,
              next_allowed_ops: ['composition.export'],
              production_state: summarizeVideoProductionState(
                await readVideoProductionState(gateStatePath, compositionDirAbs),
              ),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.materialize_narration') {
          const narrationResult = await materializeCompositionNarration({
            compositionDirAbs,
            statePath: gateStatePath,
            ...(typeof input.voice === 'string' && input.voice.trim() ? { voice: input.voice.trim() } : {}),
            ...(typeof input.speed === 'number' ? { speed: input.speed } : {}),
            decisionEvidence: input.decision_evidence,
            opts,
            ctx,
          });
          let narrationState: VideoProductionStateV1;
          if (narrationResult.ok !== true) {
            narrationState = await recordVideoStudioOperationState({
              statePath: gateStatePath,
              compositionDirAbs,
              op,
              turnId: opts.turnId,
              ok: false,
              errorCode: typeof narrationResult.errorCode === 'string' ? narrationResult.errorCode : undefined,
            });
          } else {
            await notifyWritten(opts, [
              narrationResult.path,
              narrationResult.manifest_path,
              narrationResult.html_path,
              narrationResult.narration_map_path,
            ]);
            narrationState = await readVideoProductionState(gateStatePath, compositionDirAbs);
          }
          narrationState = await recordCurrentVideoProductionCandidate({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            result: narrationResult,
          });
          if (narrationState.current_candidate) {
            narrationResult.current_candidate = narrationState.current_candidate;
          }
          narrationResult.production_state = await summarizeCompositionProductionState(
            narrationState,
            compositionDirAbs,
          );
          if (narrationResult.ok !== true) {
            narrationResult.review_package = await deliverReviewPackage({
              opts,
              state: narrationState,
              result: narrationResult,
            });
          }
          return { content: resultContent(narrationResult), isError: narrationResult.ok !== true } as ToolResult;
        }
        // The keyframe preview stop, enforced.
        //
        // A long or multi-scene composition must be rendered from frames that
        // were actually captured and still match its bytes, AND that the user
        // has seen and replied to. The frame-currency half was always here;
        // the user half was prose only after the form protocol was removed,
        // and on 2026-08-06 the model went straight from a passing snapshot to
        // rendering the video — the exact stop the user asked to restore. The
        // model's choice of composition.draft is the semantic go-ahead; the
        // host then verifies that the frames came from an earlier turn and a
        // real user turn exists. AUTO
        // children are exempt from per-segment stops: the delivered
        // production's aggregate visual identity covers them, and changes to
        // any child make that aggregate go-ahead stale.
        const draftParentLink = op === 'composition.draft' ? parentEdlLinkOf(stateBefore) : { segmentId: '', planPath: '' };
        const draftPreviewRequired = op === 'composition.draft'
          && (await videoStudioPreviewRequired(compositionDirAbs)
            || (!!draftParentLink.segmentId && !!draftParentLink.planPath
              && await assembledProductionPreviewRequired(draftParentLink.planPath)));
        if (draftPreviewRequired) {
          const gate = await validateCompositionFrameEvidence(gateStatePath, compositionDirAbs);
          if (gate.ok === false) {
            const currentState = await readVideoProductionState(gateStatePath, compositionDirAbs);
            const blockedResult = {
              ok: false,
              op,
              errorCode: gate.errorCode,
              message: gate.message,
              ...(currentState.current_candidate
                ? { current_candidate: currentState.current_candidate }
                : {}),
              production_state: await summarizeCompositionProductionState(currentState, compositionDirAbs),
            };
            const reviewPackage = await deliverReviewPackage({
              opts,
              state: currentState,
              result: blockedResult,
            });
            return {
              content: resultContent({
                ...blockedResult,
                review_package: reviewPackage,
              }),
              isError: true,
            } as ToolResult;
          }
          // This is deliberately draft-only. A status/read/repair call in a
          // user turn is not evidence that the user authorized production.
          stateBefore = await recordKeyframePreviewGoAhead({
            statePath: gateStatePath,
            compositionDirAbs,
            state: stateBefore,
            opts,
          });
          const previewStop = keyframePreviewStopBlock({
            state: stateBefore,
            entry: gate.entry,
            opts,
            ...(await productionPreviewGoAheadGranted(opts, stateBefore).then((granted) => ({
              productionPreviewGoAhead: granted.granted,
            }))),
          });
          if (previewStop) {
            // Deliberately NOT terminal. Ending the turn here guarantees the
            // stop but leaves the host unable to write the message that goes
            // with it: on 2026-08-07 the user's whole reply was "Snapshot 通过
            // （0 阻断）。直接渲染草稿。" — the half-thought that happened to
            // precede the refused call — with no frames offered and nothing to
            // answer. The render is what must be blocked; the message has to
            // be authored by the model, which needs one more inference to
            // write it. Refusing without terminating gives it exactly that,
            // with the frame paths in hand. A model that ignores this and
            // retries the same call instead is caught by the repeated-failure
            // breaker, which forces a user-facing summary — bounded, and
            // still with nothing rendered.
            return { content: resultContent(previewStop), isError: true } as ToolResult;
          }
        }
        if (op === 'composition.export') {
          const gate = await validateVideoStudioGate(gateStatePath, 'draft', compositionDirAbs, opts.turnId || '');
          if (gate.ok === false) {
            const currentState = await readVideoProductionState(gateStatePath, compositionDirAbs);
            const blockedResult = {
              ok: false,
              op,
              errorCode: gate.errorCode,
              message: gate.message,
              ...(currentState.current_candidate
                ? { current_candidate: currentState.current_candidate }
                : {}),
              production_state: await summarizeCompositionProductionState(currentState, compositionDirAbs),
            };
            const reviewPackage = await deliverReviewPackage({
              opts,
              state: currentState,
              result: blockedResult,
            });
            return {
              content: resultContent({
                ...blockedResult,
                review_package: reviewPackage,
              }),
              isError: true,
            } as ToolResult;
          }
        }
        if (op === 'composition.inspect' || op === 'composition.snapshot') {
          const guarded = await guardVisualQaAttempt({
            opts,
            statePath: gateStatePath,
            compositionDirAbs,
            op,
          });
          if (guarded) {
            const guardedState = await readVideoProductionState(gateStatePath, compositionDirAbs);
            const guardedResult = JSON.parse(guarded.content) as Record<string, unknown>;
            const reviewPackage = await deliverReviewPackage({
              opts,
              state: guardedState,
              result: guardedResult,
            });
            return {
              ...guarded,
              content: resultContent({
                ...guardedResult,
                review_package: reviewPackage,
              }),
            };
          }
        }
        const renderInputSignature = (op === 'composition.draft' || op === 'composition.export')
          ? (await videoProductionArtifacts(compositionDirAbs)).composition_signature || 'missing-signature'
          : '';
        const identicalRenderAttempts = stateBefore.operation_journal?.filter(
          (entry) => entry.op === op
            && entry.input_hash === renderInputSignature
            && entry.status === 'failed'
            && entry.consumes_same_input_attempt === true,
        ).length || 0;
        if ((op === 'composition.draft' || op === 'composition.export') && identicalRenderAttempts >= 2) {
          const blockedResult = {
            ok: false,
            op,
            errorCode: 'E_FULL_RENDER_RETRY_NO_CHANGE',
            message: 'Two full render attempts already ran for this exact composition input. Do not repeat the unchanged render; inspect the recorded failure, edit the relevant canonical input, and retry with the new input signature. No user confirmation is required.',
            blocked_operation: op,
            input_signature: renderInputSignature,
            same_input_retry_allowed: false,
            requires_user_decision: false,
            allowed_recovery_ops: ['composition.status', 'composition.reconcile', 'composition.lint', 'composition.inspect'],
            next_action: 'repair_inputs_then_retry_render',
            operation_journal_evidence: {
              input_hash: renderInputSignature,
              same_input_attempts: identicalRenderAttempts,
              durable: true,
            },
            ...(stateBefore.current_candidate
              ? { current_candidate: stateBefore.current_candidate }
              : {}),
            production_state: summarizeVideoProductionState(stateBefore, policyFactsBefore),
          };
          const reviewPackage = await deliverReviewPackage({
            opts,
            state: stateBefore,
            result: blockedResult,
          });
          return {
            content: resultContent({
              ...blockedResult,
              review_package: reviewPackage,
            }),
            isError: true,
          } as ToolResult;
        }

        const activeQaWaivers = (stateBefore.qa_waivers || []).map((waiver) => waiver.code);

        await startVideoStudioOperationState({
          statePath: gateStatePath,
          compositionDirAbs,
          op,
          turnId: opts.turnId,
          ...(outputAbsPath ? { outputPath: outputAbsPath } : {}),
          ...(effectiveReportPath ? { reportPath: effectiveReportPath } : {}),
          ...(findingsAbsPath ? { findingsPath: findingsAbsPath } : {}),
        });

        const renderVisualSignature = (op === 'composition.draft' || op === 'composition.export')
          ? await videoStudioVisualCompositionSignature(compositionDirAbs).catch((err) => {
            log.warn('render visual signature failed', { error: logErrorSummary(err) });
            return '';
          })
          : '';
        // Every op on this path runs the shared preflight, whose design
        // contract carries the cover family — so the opening determination
        // must reach lint/inspect too, not only the frame-sampling ops.
        const deliveredOpening = await compositionIsDeliveredOpening(stateBefore);
        const common = {
          compositionDirAbs,
          ...(deliveredOpening ? {} : { isDeliveredOpening: false }),
          ...(activeQaWaivers.length ? { waivedQaFindings: activeQaWaivers } : {}),
          ...(op === 'composition.draft' || op === 'composition.export'
            ? {
              repairStateAbsPath: videoStudioRepairStatePath(opts, compositionDirAbs),
              segmentCacheDirAbs: videoStudioSegmentCachePath(opts, compositionDirAbs),
            }
            : {}),
          ...(renderVisualSignature ? { visualSignature: renderVisualSignature } : {}),
          ...(outputAbsPath && op !== 'composition.snapshot' ? { outputAbsPath } : {}),
          ...(outputAbsPath && op === 'composition.snapshot' ? { snapshotAbsPath: outputAbsPath } : {}),
          ...(effectiveReportPath ? { reportAbsPath: effectiveReportPath } : {}),
          ...(findingsAbsPath ? { findingsAbsPath } : {}),
          ...((op === 'composition.export') ? { quality: 'high' as RenderQuality } : quality ? { quality } : {}),
          ...((op === 'composition.export')
            ? { fps: typeof fps === 'number' ? fps : 30 }
            : typeof fps === 'number' ? { fps } : {}),
          ...((op === 'composition.export')
            ? { allowFpsFallback: input.strict_render_settings !== true }
            : {}),
          format,
          ...(variables ? { variables } : {}),
          ...(visualBaselineAbsPath ? { visualBaselineAbsPath } : {}),
          ...(input.update_visual_baseline === true ? { updateVisualBaseline: true } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (event: { phase: string; message: string; data?: Record<string, unknown> }) => ctx.emitProgress?.(event),
        };
        let result: VideoStudioResult;
        try {
          result = op === 'composition.prepare'
            ? await prepareComposition(common)
            : op === 'composition.lint'
              ? await lintComposition(common)
              : op === 'composition.inspect'
                ? await inspectComposition(common)
                : op === 'composition.snapshot'
                  ? await snapshotComposition(common)
                  : await draftComposition(common);
        } catch (err) {
          const interrupted = ctx.signal?.aborted === true || (err as Error).name === 'AbortError';
          const errorCode = interrupted
            ? 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED'
            : 'E_VIDEO_PRODUCTION_OPERATION_FAILED';
          let failedState = await recordVideoStudioOperationState({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            turnId: opts.turnId,
            ok: false,
            errorCode,
          });
          const failedResult = {
            ok: false,
            op,
            errorCode,
            message: interrupted
              ? 'The operation was interrupted. Its durable state was preserved; resume with composition.status and composition.reconcile instead of requesting production plan confirmation again or blindly rerunning.'
              : `The operation failed before a normal tool result: ${(err as Error).message || String(err)}`,
          };
          failedState = await recordCurrentVideoProductionCandidate({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            result: failedResult,
          });
          const failedPayload = {
            ...failedResult,
            ...(failedState.current_candidate
              ? { current_candidate: failedState.current_candidate }
              : {}),
            recovery: ['composition.status', 'composition.reconcile'],
            production_state: await summarizeCompositionProductionState(failedState, compositionDirAbs),
          };
          const reviewPackage = await deliverReviewPackage({
            opts,
            state: failedState,
            result: failedPayload,
          });
          return {
            content: resultContent({
              ...failedPayload,
              review_package: reviewPackage,
            }),
            isError: true,
          } as ToolResult;
        }

        // P3: the model-scored design review is advisory. Deterministic QA
        // (lint/inspect/snapshot semantic checks) remains the hard gate; a
        // passing snapshot opens the preview review directly. The
        // submit_design_review op still records verdicts for skills that
        // submit them, but nothing blocks on it anymore — self-graded scores
        // were ritual, not independent evidence, and their schema failures
        // were a production loop source.
        if (result.ok && op === 'composition.snapshot') {
          result = {
            ...result,
            design_review_required: false,
            preview_design_review_required: false,
            ...(snapshotOutputRelocatedFrom
              ? {
                output_path_relocated: {
                  requested: snapshotOutputRelocatedFrom,
                  used: outputAbsPath,
                  reason: 'a snapshot inside the composition invalidates its own preview; frames belong under preview/',
                },
              }
              : {}),
          } as typeof result;
        }

        if (result.ok && op === 'composition.draft') {
          // P3: design review is advisory — a passing draft (deterministic
          // render/media/frame QA) opens Gate D directly.
          result = {
            ...result,
            design_review_required: false,
            gate_d_ready: true,
            next_action: 'open_gate_d',
          } as typeof result;
        }

        // The expensive model-facing visual pass happens only after native
        // preflight/inspect/sampled-frame QA has passed. Snapshot contributes
        // one complete contact sheet, not N sequential frame reads. A short
        // composition allowed to skip preview contributes its draft contact
        // sheet once; a draft with an already reviewed preview does not pay
        // for the same static visual evidence again.
        const shouldAttachSnapshotVisual = result.ok
          && op === 'composition.snapshot'
          && typeof result.contact_sheet === 'string'
          && !!result.contact_sheet;
        const shouldAttachFirstDraftVisual = result.ok
          && op === 'composition.draft'
          && !stateBefore.preview
          && typeof result.contact_sheet === 'string'
          && !!result.contact_sheet;
        const modelVisualPath = shouldAttachSnapshotVisual || shouldAttachFirstDraftVisual
          ? String(result.contact_sheet)
          : '';
        const modelVisual = modelVisualPath
          ? await prepareVideoStudioModelVisual(modelVisualPath)
          : null;
        if (modelVisual) {
          result = {
            ...result,
            visual_evidence: {
              attached: true,
              role: shouldAttachSnapshotVisual ? 'preview_contact_sheet' : 'first_draft_contact_sheet',
              path: modelVisualPath,
              policy: 'attached_only_after_native_deterministic_qa_passed',
            },
          } as typeof result;
        }

        const consumesFullRenderAttempt = (op === 'composition.draft' || op === 'composition.export')
          && resultConsumesFullRenderTurnBudget(result);

        if (result.ok && op === 'composition.snapshot' && opts.turnId) {
          const recorded = await recordVideoStudioGate(gateStatePath, 'preview', compositionDirAbs, opts.turnId, result);
          if (!recorded) {
            return { content: 'E_PREVIEW_GATE_NOT_READY: snapshot did not produce a passing preflight and preview QA token.', isError: true } as ToolResult;
          }
        }
        if (result.ok && op === 'composition.draft' && opts.turnId) {
          const recorded = await recordVideoStudioGate(gateStatePath, 'draft', compositionDirAbs, opts.turnId, result);
          if (!recorded) {
            return { content: 'E_DRAFT_GATE_NOT_READY: draft did not produce a passing QA token.', isError: true } as ToolResult;
          }
        }
        if (op === 'composition.export') {
          const report = result.report && typeof result.report === 'object' && !Array.isArray(result.report)
            ? result.report as Record<string, unknown>
            : null;
          if (report) {
            report.op = 'composition.export';
            report.next_action = result.ok ? 'deliver_final' : report.next_action;
            if (effectiveReportPath) {
              await fs.writeFile(effectiveReportPath, JSON.stringify(report, null, 2), 'utf8');
            }
          }
          result = {
            ...result,
            op: 'composition.export',
            render_settings: {
              source: input.strict_render_settings === true ? 'explicit_user_constraint' : 'system_default',
              automatic_fallback_allowed: input.strict_render_settings !== true,
              confirmation_required: false,
            },
            ...(result.ok ? { next_action: 'deliver_final' } : {}),
            // The chat player only loads `chat-media://local`. Image and
            // video tools state this form in their descriptions; this tool
            // never did, so the model wrote the path under a convention from
            // its own training (`sandbox:/…`) and a finished 62s video reached
            // the user as a black frame stuck at 0:00 (2026-08-09). The exact
            // line to paste is cheaper than an instruction to compose one.
            ...(result.ok && outputAbsPath
              ? { deliver_markdown: `[${path.basename(outputAbsPath)}](${chatMediaLocalUrl(outputAbsPath)})` }
              : {}),
          } as typeof result;
        }

        if (op === 'composition.inspect' || op === 'composition.snapshot') {
          await recordVisualQaAttempt({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            ok: result.ok === true,
            ...(opts.turnId ? { turnId: opts.turnId } : {}),
            ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}),
          });
          result = {
            ...result,
            visual_repair_cycle: visualQaRepairSummary(
              (await readVideoProductionState(gateStatePath, compositionDirAbs)).visual_qa?.cycle,
            ),
          } as typeof result;
        }

        if (findingsAbsPath && await existingCandidateFile(findingsAbsPath)) {
          result = { ...result, findings_path: findingsAbsPath } as typeof result;
        }
        if (effectiveReportPath && await existingCandidateFile(effectiveReportPath)) {
          result = { ...result, report_path: effectiveReportPath } as typeof result;
        }

        let productionState: VideoProductionStateV1;
        const gateRecorded = result.ok
          && !!opts.turnId
          && (op === 'composition.snapshot' || op === 'composition.draft');
        if (gateRecorded) {
          productionState = await readVideoProductionState(gateStatePath, compositionDirAbs);
        } else {
          const nextStage = result.ok
            ? op === 'composition.prepare'
              ? 'scaffold_ready' as const
              : op === 'composition.inspect'
                ? 'visuals_ready' as const
                : op === 'composition.export'
                  ? 'exported' as const
                  : undefined
            : undefined;
          productionState = await recordVideoStudioOperationState({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            turnId: opts.turnId,
            ok: result.ok,
            ...(nextStage ? { stage: nextStage } : {}),
            ...(result.ok === false && typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}),
            ...(consumesFullRenderAttempt ? { consumesSameInputAttempt: true } : {}),
          });
        }
        productionState = await recordCurrentVideoProductionCandidate({
          statePath: gateStatePath,
          compositionDirAbs,
          op,
          result: result as Record<string, unknown>,
        });
        const productionStateSummary = await summarizeCompositionProductionState(productionState, compositionDirAbs);
        const nativeAllowedRecoveryOps = result.ok === false && Array.isArray(result.next_allowed_ops)
          ? result.next_allowed_ops
          : result.ok === false && Array.isArray((result as Record<string, unknown>).allowed_recovery_ops)
            ? (result as Record<string, unknown>).allowed_recovery_ops as unknown[]
            : undefined;
        result = {
          ...result,
          ...(productionState.current_candidate
            ? { current_candidate: productionState.current_candidate }
            : {}),
          production_state: productionStateSummary,
          next_allowed_ops: nativeAllowedRecoveryOps
            ?? (Array.isArray(productionStateSummary.next_allowed_ops)
              ? productionStateSummary.next_allowed_ops
              : []),
        } as typeof result;

        if (result.ok === false) {
          const reviewPackage = await deliverReviewPackage({
            opts,
            state: productionState,
            result: result as Record<string, unknown>,
          });
          result = {
            ...result,
            review_package: reviewPackage,
          } as typeof result;
        }
        if (result.ok) {
          if (op === 'composition.draft' || op === 'composition.export') {
            await finalizeVideoBeforePublish(opts, op, result.path, result.cover_path);
          }
          await notifyWritten(opts, [
            result.path,
            result.cover_path,
            result.first_frame,
            result.report_path,
            result.findings_path,
            result.manifest_path,
            result.html_path,
            result.contact_sheet,
            result.frame_paths,
            (result.visual_regression as { baseline_path?: unknown } | undefined)?.baseline_path,
          ]);
          if (op === 'composition.draft' || op === 'composition.export') {
            await publishVisibleOutputs(opts, [
              result.path,
              result.cover_path,
            ]);
          }
          // P3: with design review advisory, a passing snapshot is the
          // preview-review moment — publish the contact sheet immediately
          // instead of waiting for a review submission that no longer gates.
          if (op === 'composition.snapshot' && result.ok) {
            await publishVisibleOutputs(opts, [result.contact_sheet]);
          }
        }
        const renameNote = renamed && outputAbsPath ? renderRenameSignal(requestedOutput, outputAbsPath) : '';
        // State, candidate locators, and the review package were all recorded
        // from the full result above; resultContent applies the model-facing
        // projection at serialization time for every return path.
        return {
          content: resultContent(result, renameNote),
          ...(modelVisual ? { images: [modelVisual] } : {}),
          isError: result.ok === false,
        } as ToolResult;
      }

      const inputRaw = String(input.input_path || '').trim();
      if (!inputRaw) return { content: 'input_path is required for speech.transcribe', isError: true } as ToolResult;
      const inputAbsPath = resolvePath(ctx, opts, inputRaw, roots);
      if (!isPathAllowed(inputAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside scope: ${inputAbsPath}`, isError: true } as ToolResult;
      }
      const fileErr = await ensureInputFile(inputAbsPath, 'input_path');
      if (fileErr) return { content: fileErr, isError: true } as ToolResult;

      const transcriptAbsPath = typeof input.transcript_path === 'string' && input.transcript_path.trim()
        ? resolvePath(ctx, opts, input.transcript_path, roots)
        : undefined;
      if (transcriptAbsPath && !isPathAllowed(transcriptAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: transcript_path is outside scope: ${transcriptAbsPath}`, isError: true } as ToolResult;
      }
      const result = await transcribeSpeech({
        inputAbsPath,
        ...(transcriptAbsPath ? { transcriptAbsPath } : {}),
        ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
        ...(typeof input.language === 'string' && input.language.trim() ? { language: input.language.trim() } : {}),
        timestamps: input.timestamps === 'segment' ? 'segment' : 'word',
        allowModelDownload: input.allow_model_download === true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (event) => ctx.emitProgress?.(event),
      });
      if (result.ok) await notifyWritten(opts, [result.transcript_path]);
      return { content: resultContent(result), isError: result.ok === false } as ToolResult;
    },
  };
  let contractCheck: VideoStudioContractCheck | undefined;
  return {
    ...inner,
    async execute(input, ctx) {
      const op = String(input.op || '').trim();
      if (CONTRACT_SENSITIVE_OPS.has(op)) {
        contractCheck ??= checkInstalledVideoStudioContract(
          opts.userId,
          opts.agentId || VIDEO_STUDIO_AGENT_ID,
        );
        if (contractCheck.compatible === false) {
          return videoStudioContractMismatchResult(op, contractCheck);
        }
      }
      // Run the real operation first: a retry after a genuine external repair
      // (e.g. the model restored a missing plan file with write_file and then
      // resent the identical call) must still be able to succeed.
      const result = await inner.execute(input, ctx);
      return applyVideoStudioTurnBoundary(
        applyVideoStudioFailureBreaker(failureStreaks, input, result),
      );
    },
  };
}
