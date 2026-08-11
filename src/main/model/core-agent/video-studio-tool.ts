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
import { getLocalExecGranted } from '../../features/permissions';
import {
  draftComposition,
  inspectComposition,
  lintComposition,
  prepareComposition,
  snapshotComposition,
  transcribeSpeech,
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
  reconcileCompositionHtml,
  retimeCompositionManifestForNarration,
  validateCompositionManifestSemantics,
  type CompositionManifest,
} from '../../features/video_studio_contract';
import {
  evaluateVideoProductionOperation,
  readVideoProductionState,
  recordVideoProductionCandidate,
  recordVideoProductionTransition,
  summarizeVideoProductionState,
  updateVideoProductionState,
  type VideoProductionArtifactState,
  type VideoProductionCandidateLocators,
  type VideoProductionCandidateRevision,
  type VideoProductionCandidateSnapshot,
  type VideoProductionGateEntry,
  type VideoProductionNarrationFit,
  type VideoProductionNarrationRepairAuthorization,
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
  VIDEO_STUDIO_INSPECTOR_VERSION,
} from '../../features/video_studio_qa';
import {
  approveVideoProductionGeneration,
  approveVideoProductionPlan,
  readVideoProductionControlState,
  readVideoProductionPlanIdentity,
  validateVideoProductionPlanApproval,
  videoProductionControlStatePath,
  videoProductionControlSummary,
  type VideoProductionPlanIdentity,
} from '../../features/video_production_control';
import { projectVideoApprovalIntent } from '../../features/video_approval_identity';
import { canonicalizeManifestSourceShotReferences } from '../../features/video_studio_source_alignment';
import {
  assessEstimatedNarrationFit,
  configuredTtsBackendId,
  estimateNarrationDuration,
  generateSpeech,
  hasConfiguredTtsProvider,
  narrationDurationCalibrationScale,
} from '../../features/tts';
import {
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
import { createLogger } from '../../logger';
import { userLocalRoot } from '../../paths';

const log = createLogger('video-studio-tool');
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
const NARRATION_REPAIR_MAX_EDIT_RATIO = 0.15;
const NARRATION_REPAIR_MAX_CHECKS = 2;
const VISUAL_QA_MAX_REPAIR_PASSES = 2;

export type VideoStudioApprovalGate = 'plan' | 'generation' | 'narration_retry' | 'preview' | 'draft';
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
  if (evidence === undefined || evidence === null) {
    return { decision: 'unknown', source: 'none', evidence_status: 'not_provided' };
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

function invalidDecisionEvidenceResult(
  op: VideoStudioOp,
  gate: VideoStudioApprovalGate,
  decision: VideoStudioResolvedDecision,
): Record<string, unknown> | undefined {
  if (decision.evidence_status !== 'invalid') return undefined;
  return {
    ok: false,
    op,
    errorCode: 'E_DECISION_EVIDENCE_INVALID',
    message: 'The current user reply is still available, but decision_evidence was not a valid structured object for this operation. Re-interpret the same current reply and retry this operation now with a native object; do not ask the user to confirm again.',
    decision_evidence_valid: false,
    decision_evidence_issue: decision.evidence_issue || 'expected_object',
    decision_evidence_format: decision.evidence_format || 'object',
    current_user_message_available: true,
    requires_user_decision: false,
    user_reconfirmation_required: false,
    automatic_recovery_expected: true,
    billable_request_sent: false,
    expected_decision_evidence: {
      source: 'user_message',
      gate,
      decision: ['approve', 'revise', 'reject'],
      quote: 'verbatim excerpt from the current real user message',
    },
    allowed_recovery_ops: [op],
    next_action: 'retry_same_operation_with_structured_decision_evidence',
  };
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
  'composition.status',
  'composition.doctor',
  'composition.reconcile',
  'composition.check_narration_fit',
  'composition.approve_plan',
  'composition.prepare',
  'composition.materialize_narration',
  'composition.lint',
  'composition.inspect',
  'composition.begin_visual_revision',
  'composition.draft',
  'composition.export',
  'composition.snapshot',
  'composition.approve_preview',
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
  'composition.begin_visual_revision',
  'composition.snapshot',
  'composition.approve_preview',
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
  catch (err) { log.warn(`resolve workspace failed: ${(err as Error).message}`); }
  if (opts.projectId) {
    try { push(getWorkspacePath(opts.userId, opts.projectId)); }
    catch (err) { log.warn(`resolve project workspace failed: ${(err as Error).message}`); }
  }
  if (opts.cid) {
    try { push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir failed: ${(err as Error).message}`); }
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
    submitted_decision_status?: 'superseded' | 'unbound_after_revision';
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
  const manifestSha = await sha256File(path.join(compositionDirAbs, 'composition-manifest.json'));
  const htmlSha = await sha256File(path.join(compositionDirAbs, 'index.html'));
  return {
    composition_signature: await videoStudioCompositionSignature(compositionDirAbs),
    ...(manifestSha ? { manifest_sha256: manifestSha } : {}),
    ...(htmlSha ? { html_sha256: htmlSha } : {}),
  };
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
      log.warn(`candidate snapshot failed: ${(err as Error).message}`);
      return undefined;
    })
    : undefined;
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    recordVideoProductionCandidate(state, {
      contentHash: artifacts.composition_signature || '',
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
  presentation_required: true;
  status: 'current_approved' | 'current_unapproved';
  conclusion: {
    outcome: 'quality_not_accepted' | 'blocked';
    error_code: string;
    summary: string;
    next_action: string;
    requires_user_decision: boolean;
    next_step_owner: 'agent' | 'user';
    automatic_recovery_expected: boolean;
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
  artifacts: VideoStudioReviewArtifact[];
  visible_artifact_paths: string[];
};

function currentReviewPackage(input: {
  state: VideoProductionStateV1;
  result: Record<string, unknown>;
  planEvidence?: VideoProductionPlanEvidence;
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
  const previewApprovalMatchesCandidate = input.state.preview?.status === 'approved'
    && !!candidate?.content_hash
    && input.state.preview.signature === candidate.content_hash;
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
    add('script', records.script.path, 'plan_evidence', 'current_input');
    add('shotlist', records.shotlist.path, 'plan_evidence', 'current_input');
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
    presentation_required: true,
    status: packageStatus,
    conclusion: {
      outcome: /(?:QA|QUALITY|INSPECT|REPAIR|REVIEW|RENDER|PREFLIGHT|DRAFT)/.test(errorCode)
        ? 'quality_not_accepted'
        : 'blocked',
      error_code: errorCode,
      summary: typeof input.result.message === 'string' ? input.result.message : 'The current result is not accepted.',
      next_action: nextAction,
      requires_user_decision: requiresUserDecision,
      next_step_owner: requiresUserDecision ? 'user' : 'agent',
      automatic_recovery_expected: !requiresUserDecision,
    },
    continuation: {
      recoverable: true,
      terminal: false,
      user_action_required: requiresUserDecision,
      system_action: requiresUserDecision
        ? 'Present the current artifact and the concrete choices below; continue from the user’s natural-language decision.'
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
}): Promise<VideoStudioReviewPackage> {
  const reviewPackage = currentReviewPackage(input);
  await notifyWritten(input.opts, candidateRegisteredPaths(input.state.current_candidate));
  await publishVisibleOutputs(input.opts, reviewPackage.visible_artifact_paths);
  return reviewPackage;
}

async function reviewToolResult(input: {
  opts: VideoStudioToolOpts;
  state: VideoProductionStateV1;
  result: Record<string, unknown>;
  planEvidence?: VideoProductionPlanEvidence;
  isError?: boolean;
}): Promise<ToolResult> {
  const reviewPackage = await deliverReviewPackage(input);
  return {
    content: resultContent({
      ...input.result,
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
  state.plan_approval = approval;
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
  return approval.identity_kind !== 'approved_intent_sha256'
    && !!identity.legacySignature
    && approval.signature === identity.legacySignature;
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
        op: 'composition.recover_narration_invariant',
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

function visualQaBudgetExhausted(state: VideoProductionVisualQaState | undefined): boolean {
  const cycle = legacyVisualQaCycle(state);
  return !!cycle && (cycle.status === 'exhausted'
    || cycle.failed_signatures.length >= cycle.max_repair_passes + 1);
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

async function guardVisualQaAttempt(input: {
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
          : previewStatus === 'approved' ? 'composition.draft' : 'composition.approve_preview',
        visual_repair_cycle: visualQaRepairSummary(cycle),
        ...(state.current_candidate ? { current_candidate: state.current_candidate } : {}),
        production_state: summarizeVideoProductionState(state),
      }),
      isError: false,
    };
  }
  const failedSignatures = cycle.failed_signatures;
  if (cycle.status === 'exhausted' || failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1) {
    return {
      content: resultContent({
        ok: false,
        op: input.op,
        errorCode: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
        message: `The previous visual repair strategies did not resolve the QA findings after ${VISUAL_QA_MAX_REPAIR_PASSES} distinct repair passes. Preserve the approved plan and narration, start a new internal visual-repair cycle, choose a materially different fix from the recorded evidence, and continue QA without asking the user for a technical recovery confirmation.`,
        visual_revision_recovery_available: true,
        recovery_action: 'composition.begin_visual_revision',
        recovery_requires_new_user_revision: false,
        requires_user_decision: false,
        allowed_recovery_ops: ['composition.begin_visual_revision', 'composition.reconcile'],
        next_action: 'composition.begin_visual_revision',
        preserved_artifacts: ['plan_approval', 'script', 'shotlist', 'composition_manifest', 'narration'],
        visual_repair_cycle: visualQaRepairSummary(cycle),
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
      delete cycle.passed_signatures[key];
      cycle.status = failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1 ? 'exhausted' : 'active';
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
  targetDuration?: number,
): Record<string, unknown> {
  return {
    schema_version: manifest.schema_version,
    composition: {
      id: manifest.composition.id,
      width: manifest.composition.width,
      height: manifest.composition.height,
      target_duration: manifest.composition.target_duration ?? targetDuration ?? manifest.composition.duration,
      language: manifest.composition.language || '',
    },
    scenes: manifest.scenes.map((scene) => ({
      id: scene.id,
      approved_copy: scene.approved_copy,
      narration_text: scene.narration_text || '',
      narration_refs: scene.narration_refs,
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

function canonicalApprovedShotlistIntentPayload(
  shotlist: Record<string, unknown>,
): Record<string, unknown> {
  return projectVideoApprovalIntent(shotlist, {
    // These describe the artifact/implementation contract. Unknown fields stay
    // signed, and visual_provenance remains signed as a production constraint.
    excludeRootKeys: ['schema_version', 'art_direction'],
  }) as Record<string, unknown>;
}

function canonicalApprovedManifestIntentPayload(
  manifest: CompositionManifest,
  targetDuration?: number,
): Record<string, unknown> {
  const legacy = canonicalLegacyManifestPlanPayload(manifest, targetDuration);
  const { schema_version: _schemaVersion, ...approvedIntent } = legacy;
  return {
    ...approvedIntent,
    audio: {
      narration_intent: canonicalNarrationIntentForApproval(manifest.audio.narration_intent),
    },
  };
}

function canonicalApprovedPlanIntentSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const shotlist = snapshot.shotlist;
  const manifest = snapshot.manifest;
  const shotlistIntent = canonicalApprovedShotlistIntentPayload(
    shotlist && typeof shotlist === 'object' && !Array.isArray(shotlist)
      ? shotlist as Record<string, unknown>
      : {},
  );
  const manifestIntent = projectVideoApprovalIntent(
    manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? manifest
      : {},
    { excludeRootKeys: ['schema_version', 'art_direction'] },
  );
  return {
    script: canonicalPlanText(typeof snapshot.script === 'string' ? snapshot.script : ''),
    shotlist: shotlistIntent,
    manifest: canonicalizeManifestSourceShotReferences(
      manifestIntent,
      shotlistIntent,
    ),
  };
}

function canonicalPlanPayload(
  script: string,
  shotlist: Record<string, unknown>,
  manifest: CompositionManifest,
  targetDuration?: number,
): Record<string, unknown> {
  return canonicalApprovedPlanIntentSnapshot({
    script: canonicalPlanText(script),
    shotlist: canonicalApprovedShotlistIntentPayload(shotlist),
    manifest: canonicalApprovedManifestIntentPayload(manifest, targetDuration),
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
  /** Pre-content-addressing signature retained only to migrate approvals
   * written by older clients without reopening Gate B. */
  legacySignature?: string;
  intentPayload?: Record<string, unknown>;
  artifactPaths: string[];
  artifactRecords?: VideoProductionPlanFiles;
  requirementIssues: string[];
  artifactIssues?: VideoProductionPlanArtifactIssue[];
  evidence: VideoProductionPlanEvidence;
};

const PLAN_DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'render',
  'renders',
  'outputs',
]);

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

async function discoverPlanBundleDirectories(roots: string[]): Promise<string[]> {
  const directories = new Set<string>();
  let inspected = 0;
  const visit = async (dirAbs: string): Promise<void> => {
    if (inspected >= 5_000) return;
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (names.has('script.md') && names.has('shotlist.json')) directories.add(dirAbs);
    for (const entry of entries) {
      inspected += 1;
      if (inspected >= 5_000) break;
      if (!entry.isDirectory() || PLAN_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      await visit(path.join(dirAbs, entry.name));
    }
  };
  for (const root of planSearchRoots(roots)) {
    await visit(root);
  }
  return [...directories];
}

async function findRecordedPlanFile(
  role: VideoProductionPlanArtifactRole,
  record: VideoProductionPlanFileRecord,
  roots: string[],
): Promise<string | undefined> {
  const wantedExtension = role === 'script' ? '.md' : '.json';
  const matches: string[] = [];
  let inspected = 0;
  const visit = async (dirAbs: string): Promise<void> => {
    if (inspected >= 5_000) return;
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      inspected += 1;
      if (inspected >= 5_000) break;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (!PLAN_DISCOVERY_SKIP_DIRS.has(entry.name)) await visit(abs);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== wantedExtension) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile() || stat.size > 20 * 1024 * 1024) continue;
      if (await sha256File(abs) === record.sha256) matches.push(abs);
    }
  };
  for (const root of planSearchRoots(roots)) {
    await visit(root);
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => {
    const aDistance = path.relative(path.dirname(record.path), a).split(path.sep).length;
    const bDistance = path.relative(path.dirname(record.path), b).split(path.sep).length;
    return aDistance - bDistance || a.localeCompare(b);
  });
  return matches[0];
}

async function resolveRecordedPlanFiles(input: {
  records: VideoProductionPlanFiles;
  roots: string[];
}): Promise<{ records?: VideoProductionPlanFiles; evidence: VideoProductionPlanEvidence }> {
  const evidence = emptyPlanEvidence();
  const resolved = {} as Partial<VideoProductionPlanFiles>;
  for (const role of ['script', 'shotlist', 'manifest'] as const) {
    const record = input.records[role];
    const currentSha = await sha256File(record.path);
    if (currentSha === record.sha256) {
      resolved[role] = record;
      evidence.observations.push({
        role,
        status: 'matched',
        path: record.path,
        sha256: record.sha256,
      });
      continue;
    }
    if (currentSha) {
      // Raw file hashes identify concrete artifacts and concurrent edits. They
      // are not the Gate B identity: parse the changed candidate below and
      // compare its canonical approved-intent hash before deciding whether the
      // user's approval still applies.
      resolved[role] = { path: record.path, sha256: currentSha };
      evidence.observations.push({
        role,
        status: 'changed',
        path: record.path,
        sha256: currentSha,
      });
      continue;
    }
    const relocated = role === 'manifest'
      ? undefined
      : await findRecordedPlanFile(role, record, input.roots);
    if (!relocated) {
      evidence.observations.push({ role, status: 'missing', path: record.path });
      evidence.conflicts.push({
        code: 'recorded_artifact_missing',
        message: `The approved ${role} file could not be found by its recorded content hash.`,
        paths: [record.path],
      });
      continue;
    }
    resolved[role] = { path: relocated, sha256: record.sha256 };
    evidence.observations.push({
      role,
      status: 'relocated',
      path: relocated,
      sha256: record.sha256,
    });
  }
  if (!resolved.script || !resolved.shotlist || !resolved.manifest) return { evidence };
  return { records: resolved as VideoProductionPlanFiles, evidence };
}

async function buildVideoProductionPlanIdentity(
  records: VideoProductionPlanFiles,
  evidence: VideoProductionPlanEvidence,
): Promise<VideoProductionPlanIdentityResult> {
  const scriptPath = records.script.path;
  const shotlistPath = records.shotlist.path;
  const manifestPath = records.manifest.path;
  const [script, shotlistRaw, manifestRaw] = await Promise.all([
    fs.readFile(scriptPath).catch(() => null),
    fs.readFile(shotlistPath).catch(() => null),
    fs.readFile(manifestPath, 'utf8').catch(() => ''),
  ]);
  const applicable = !!script || !!shotlistRaw;
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
  const scriptValid = !!script && script.toString('utf8').trim().length > 0;
  if (script && !scriptValid) {
    artifactIssues.push({
      role: 'script',
      code: 'empty_file',
      path: scriptPath,
      message: 'script.md is empty.',
    });
  }
  let shotlist: Record<string, unknown> = {};
  let shotlistValid = false;
  try {
    const parsed = JSON.parse(shotlistRaw?.toString('utf8') || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      shotlist = parsed;
      shotlistValid = true;
    } else if (shotlistRaw) {
      artifactIssues.push({
        role: 'shotlist',
        code: 'invalid_object',
        path: shotlistPath,
        message: 'shotlist.json must contain one JSON object.',
      });
    }
  } catch (error) {
    artifactIssues.push({
      role: 'shotlist',
      code: 'invalid_json',
      path: shotlistPath,
      message: 'shotlist.json is not valid JSON.',
      details: boundedPlanValidationDetails(error),
    });
  }
  const targetDuration = Number(shotlist.target_duration_seconds);
  const requirementIssues = [
    ...(Number.isFinite(targetDuration) && targetDuration > 0 ? [] : ['shotlist.target_duration_seconds']),
    ...(typeof shotlist.video_language === 'string' && shotlist.video_language.trim() ? [] : ['shotlist.video_language']),
    ...(typeof shotlist.audio_mode === 'string' && shotlist.audio_mode.trim() ? [] : ['shotlist.audio_mode']),
    ...(typeof shotlist.caption_mode === 'string' && shotlist.caption_mode.trim() ? [] : ['shotlist.caption_mode']),
    ...(typeof shotlist.music_mode === 'string' && shotlist.music_mode.trim() ? [] : ['shotlist.music_mode']),
  ];
  let planPayload = '';
  let intentPayload: Record<string, unknown> | undefined;
  let legacyManifestPayload = '';
  let manifestValid = false;
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(manifestRaw));
    manifestValid = true;
    requirementIssues.push(...validateCompositionManifestSemantics(manifest)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code));
    requirementIssues.push(...videoProductionNarrationAlignmentIssues({
      script: script?.toString('utf8') || '',
      shotlist,
      manifest,
    }));
    intentPayload = canonicalPlanPayload(
      script?.toString('utf8') || '',
      shotlist,
      manifest,
      Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : undefined,
    );
    planPayload = stableJson(intentPayload);
    legacyManifestPayload = JSON.stringify(canonicalLegacyManifestPlanPayload(
      manifest,
      Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : undefined,
    ));
  } catch (error) {
    planPayload = manifestRaw;
    legacyManifestPayload = manifestRaw;
    artifactIssues.push({
      role: 'manifest',
      code: 'invalid_manifest',
      path: manifestPath,
      message: 'composition-manifest.json does not match the required video-plan structure.',
      details: boundedPlanValidationDetails(error),
    });
  }
  const legacyHash = crypto.createHash('sha256');
  legacyHash.update(script || Buffer.alloc(0));
  legacyHash.update('\0');
  legacyHash.update(shotlistRaw || Buffer.alloc(0));
  legacyHash.update('\0');
  legacyHash.update(legacyManifestPayload);
  const semanticHash = crypto.createHash('sha256').update(planPayload);
  return {
    applicable,
    complete: scriptValid && !!shotlistRaw && shotlistValid && manifestValid,
    signature: semanticHash.digest('hex'),
    legacySignature: legacyHash.digest('hex'),
    ...(intentPayload ? { intentPayload } : {}),
    artifactPaths: [scriptPath, shotlistPath, manifestPath],
    artifactRecords: records,
    requirementIssues,
    artifactIssues,
    evidence,
  };
}

async function candidatePlanIdentity(
  directory: string,
  manifestPath: string,
): Promise<VideoProductionPlanIdentityResult | undefined> {
  const scriptPath = path.join(directory, 'script.md');
  const shotlistPath = path.join(directory, 'shotlist.json');
  const [scriptSha, shotlistSha, manifestSha] = await Promise.all([
    sha256File(scriptPath),
    sha256File(shotlistPath),
    sha256File(manifestPath),
  ]);
  if (!scriptSha && !shotlistSha) return undefined;
  const evidence = emptyPlanEvidence();
  evidence.observations.push(
    {
      role: 'script',
      status: scriptSha ? 'candidate' : 'missing',
      path: scriptPath,
      ...(scriptSha ? { sha256: scriptSha } : {}),
    },
    {
      role: 'shotlist',
      status: shotlistSha ? 'candidate' : 'missing',
      path: shotlistPath,
      ...(shotlistSha ? { sha256: shotlistSha } : {}),
    },
    {
      role: 'manifest',
      status: manifestSha ? 'candidate' : 'missing',
      path: manifestPath,
      ...(manifestSha ? { sha256: manifestSha } : {}),
    },
  );
  if (!scriptSha || !shotlistSha || !manifestSha) {
    return {
      applicable: true,
      complete: false,
      signature: '',
      artifactPaths: [scriptPath, shotlistPath, manifestPath],
      requirementIssues: [],
      evidence,
    };
  }
  return buildVideoProductionPlanIdentity({
    script: { path: scriptPath, sha256: scriptSha },
    shotlist: { path: shotlistPath, sha256: shotlistSha },
    manifest: { path: manifestPath, sha256: manifestSha },
  }, evidence);
}

async function videoProductionPlanIdentity(
  compositionDirAbs: string,
  input: {
    approval?: VideoProductionPlanApproval;
    roots?: string[];
    preferLocal?: boolean;
  } = {},
): Promise<VideoProductionPlanIdentityResult> {
  const manifestPath = path.join(compositionDirAbs, 'composition-manifest.json');
  const roots = input.roots?.length ? input.roots : [path.resolve(compositionDirAbs, '..')];
  const localDir = path.resolve(compositionDirAbs);
  const parentDir = path.resolve(compositionDirAbs, '..');
  if (input.approval?.artifact_records) {
    const resolved = await resolveRecordedPlanFiles({
      records: input.approval.artifact_records,
      roots,
    });
    if (resolved.records) return buildVideoProductionPlanIdentity(resolved.records, resolved.evidence);

    // A plan bundle may be moved and reformatted in the same edit. In that
    // case neither its old path nor its old raw file hash can locate it. Search
    // complete bundles, then bind the one whose normalized approved intent
    // still matches the approval content address.
    const recoveryDirectories = [...new Set([
      localDir,
      parentDir,
      ...await discoverPlanBundleDirectories(roots),
    ])];
    const recoveryCandidates = (await Promise.all(
      recoveryDirectories.map((directory) => candidatePlanIdentity(directory, manifestPath)),
    )).filter((value): value is VideoProductionPlanIdentityResult => !!value?.complete);
    const matchingCandidates = recoveryCandidates
      .filter((candidate) => planApprovalMatchesIdentity(input.approval, candidate))
      .sort((a, b) => a.artifactPaths[0].localeCompare(b.artifactPaths[0]));
    if (matchingCandidates.length > 0) {
      const recovered = matchingCandidates[0];
      const recoveredRecords = recovered.artifactRecords!;
      const evidence = emptyPlanEvidence();
      for (const role of ['script', 'shotlist', 'manifest'] as const) {
        const prior = input.approval.artifact_records[role];
        const current = recoveredRecords[role];
        evidence.observations.push({
          role,
          status: current.path !== prior.path
            ? 'relocated'
            : current.sha256 !== prior.sha256 ? 'changed' : 'matched',
          path: current.path,
          sha256: current.sha256,
        });
      }
      return { ...recovered, evidence };
    }
    if (recoveryCandidates.length === 1) {
      // Return the only coherent current candidate so the caller can report a
      // semantic intent diff, rather than a misleading path/hash failure.
      return recoveryCandidates[0];
    }
    return {
      applicable: true,
      complete: false,
      signature: '',
      artifactPaths: input.approval.artifact_paths,
      requirementIssues: [],
      evidence: resolved.evidence,
    };
  }

  const direct = (await Promise.all([
    candidatePlanIdentity(localDir, manifestPath),
    candidatePlanIdentity(parentDir, manifestPath),
  ])).filter((value): value is VideoProductionPlanIdentityResult => !!value);
  const completeDirect = direct.filter((value) => value.complete);
  if (input.preferLocal) {
    const local = completeDirect.find((value) => path.dirname(value.artifactPaths[0]) === localDir);
    if (local) return local;
  }
  if (completeDirect.length === 1) return completeDirect[0];
  if (completeDirect.length > 1) {
    const signatures = new Set(completeDirect.map((value) => value.signature));
    if (signatures.size === 1) return completeDirect[0];
    const evidence = emptyPlanEvidence();
    evidence.observations.push(...completeDirect.flatMap((value) => value.evidence.observations));
    evidence.conflicts.push({
      code: 'multiple_plan_bundles',
      message: 'Multiple complete script/shotlist bundles disagree. Bind one coherent bundle before approval.',
      paths: completeDirect.flatMap((value) => value.artifactPaths.slice(0, 2)),
    });
    return {
      applicable: true,
      complete: false,
      signature: '',
      artifactPaths: [],
      requirementIssues: [],
      evidence,
    };
  }

  const discoveredDirs = await discoverPlanBundleDirectories(roots);
  const discovered = (await Promise.all(discoveredDirs
    .filter((directory) => directory !== localDir && directory !== parentDir)
    .map((directory) => candidatePlanIdentity(directory, manifestPath))))
    .filter((value): value is VideoProductionPlanIdentityResult => !!value?.complete);
  if (discovered.length === 1) return discovered[0];
  if (discovered.length > 1) {
    const signatures = new Set(discovered.map((value) => value.signature));
    if (signatures.size === 1) return discovered
      .sort((a, b) => a.artifactPaths[0].localeCompare(b.artifactPaths[0]))[0];
    const evidence = emptyPlanEvidence();
    evidence.observations.push(...discovered.flatMap((value) => value.evidence.observations));
    evidence.conflicts.push({
      code: 'multiple_plan_bundles',
      message: 'More than one complete plan bundle was found and their approved content differs.',
      paths: discovered.flatMap((value) => value.artifactPaths.slice(0, 2)),
    });
    return {
      applicable: true,
      complete: false,
      signature: '',
      artifactPaths: [],
      requirementIssues: [],
      evidence,
    };
  }
  const partial = direct[0];
  return partial || {
    applicable: false,
    complete: false,
    signature: '',
    artifactPaths: [],
    requirementIssues: [],
    evidence: emptyPlanEvidence(),
  };
}

type ParentCompositionBindingCheck =
  | { ok: true; parentSignature: string }
  | { ok: false; errorCode: string; message: string };

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
  if (!segment || segment.source !== 'compose') {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_SEGMENT_INVALID',
      message: `The approved parent EDL has no compose segment named ${input.segmentId}.`,
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
  let manifest: CompositionManifest;
  try {
    manifest = CompositionManifestSchema.parse(JSON.parse(
      await fs.readFile(path.join(input.compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
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
  const targetDuration = Number(segment.target_sec);
  if (!Number.isFinite(targetDuration)
    || Math.abs((manifest.composition.target_duration ?? manifest.composition.duration) - targetDuration) > 0.01) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_DURATION_MISMATCH',
      message: 'The child composition duration does not match the approved parent EDL segment.',
    };
  }
  if (parentLanguage && manifest.composition.language && manifest.composition.language !== parentLanguage) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_LANGUAGE_MISMATCH',
      message: 'The child composition language does not match the approved parent EDL.',
    };
  }
  if (manifest.audio.owner !== 'none' || manifest.audio.tracks.length > 0) {
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_AUDIO_OWNERSHIP',
      message: 'AUTO child compositions must remain silent; the parent assembler owns narration and audio.',
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
    return {
      ok: false,
      errorCode: 'E_PARENT_COMPOSITION_CONTENT_MISMATCH',
      message: 'The child composition copy, narration, scene ids, or semantic roles differ from the confirmed parent EDL binding.',
    };
  }
  return { ok: true, parentSignature: input.parentIdentity.signature };
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

type ShotNarrationProjection = {
  keys: Array<'narration' | 'narration_text'>;
  text: string;
  issue?: 'invalid' | 'conflict';
};

/** The manifest is the canonical narration source. Shotlist narration fields
 * are optional legacy/review projections; when present they must agree with
 * each other and with the manifest. */
function shotNarrationProjection(shot: Record<string, unknown>): ShotNarrationProjection {
  const keys = (['narration', 'narration_text'] as const)
    .filter((key) => Object.prototype.hasOwnProperty.call(shot, key));
  if (keys.length === 0) return { keys: [], text: '' };
  const values: string[] = [];
  for (const key of keys) {
    const value = shot[key];
    if (typeof value !== 'string' || !value.trim()) return { keys, text: '', issue: 'invalid' };
    values.push(value.trim());
  }
  if (values.some((value) => normalizedRepairText(value) !== normalizedRepairText(values[0]))) {
    return { keys, text: '', issue: 'conflict' };
  }
  return { keys, text: values[0] };
}

function videoProductionNarrationAlignmentIssues(input: {
  script: string;
  shotlist: Record<string, unknown>;
  manifest: CompositionManifest;
}): string[] {
  const narratedScenes = input.manifest.scenes.filter((scene) => !!scene.narration_text?.trim());
  if (narratedScenes.length === 0) return [];
  const shots = Array.isArray(input.shotlist.shots)
    ? input.shotlist.shots.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const shotsById = new Map(shots.map((shot) => [typeof shot.id === 'string' ? shot.id : '', shot]));
  const issues: string[] = [];
  let scriptCursor = 0;
  for (const scene of narratedScenes) {
    const narration = scene.narration_text!.trim();
    const scriptIndex = input.script.indexOf(narration, scriptCursor);
    if (scriptIndex < 0) issues.push(`script.narration_missing(${scene.id})`);
    else scriptCursor = scriptIndex + narration.length;
    const shot = shotsById.get(scene.id);
    if (!shot) {
      issues.push(`shotlist.shots.missing(${scene.id})`);
      continue;
    }
    const projection = shotNarrationProjection(shot);
    if (projection.issue) {
      issues.push(`shotlist.shots.${scene.id}.narration_${projection.issue}`);
    } else if (projection.text
      && normalizedRepairText(projection.text) !== normalizedRepairText(narration)) {
      issues.push(`shotlist.shots.${scene.id}.narration_conflicts_with_manifest`);
    }
  }
  return issues;
}

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
 * that may be shortened/expanded by the measured-duration repair. The
 * manifest is canonical. Optional shotlist narration/narration_text
 * projections must agree scene-by-scene, and approved on-screen copy is
 * redacted only when it exactly duplicates that scene's narration.
 */
async function videoProductionNarrationRepairIdentity(
  planIdentity: VideoProductionPlanIdentityResult,
): Promise<NarrationRepairIdentity | undefined> {
  const records = planIdentity.artifactRecords;
  if (!records) return undefined;
  const [script, shotlistRaw, manifestRaw] = await Promise.all([
    fs.readFile(records.script.path, 'utf8').catch(() => ''),
    fs.readFile(records.shotlist.path, 'utf8').catch(() => ''),
    fs.readFile(records.manifest.path, 'utf8').catch(() => ''),
  ]);
  if (!script || !shotlistRaw || !manifestRaw) return undefined;

  let shotlist: Record<string, unknown>;
  let manifest: CompositionManifest;
  try {
    const parsedShotlist = JSON.parse(shotlistRaw) as unknown;
    if (!parsedShotlist || typeof parsedShotlist !== 'object' || Array.isArray(parsedShotlist)) return undefined;
    shotlist = parsedShotlist as Record<string, unknown>;
    manifest = CompositionManifestSchema.parse(JSON.parse(manifestRaw));
  } catch {
    return undefined;
  }
  if (!Array.isArray(shotlist.shots)) return undefined;

  const shotsById = new Map<string, Record<string, unknown>>();
  for (const value of shotlist.shots) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const shot = value as Record<string, unknown>;
    const id = typeof shot.id === 'string' ? shot.id : '';
    if (!id || shotsById.has(id)) return undefined;
    shotsById.set(id, shot);
  }

  let scriptStructure = script;
  const sanitizedShots: Record<string, unknown>[] = [];
  const sanitizedScenes: CompositionManifest['scenes'] = [];
  for (const scene of manifest.scenes) {
    const narration = scene.narration_text?.trim() || '';
    const shot = shotsById.get(scene.id);
    if (!narration || !shot) {
      return undefined;
    }
    const projection = shotNarrationProjection(shot);
    if (projection.issue || (projection.text
      && normalizedRepairText(projection.text) !== normalizedRepairText(narration))) return undefined;
    const scriptIndex = scriptStructure.indexOf(narration);
    if (scriptIndex < 0) return undefined;
    const marker = `{{ORKAS_NARRATION:${scene.id}}}`;
    scriptStructure = `${scriptStructure.slice(0, scriptIndex)}${marker}${scriptStructure.slice(scriptIndex + narration.length)}`;
    const sanitizedShot = { ...shot };
    delete sanitizedShot.narration;
    delete sanitizedShot.narration_text;
    sanitizedShots.push(sanitizedShot);
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
  const structurePayload = {
    script: scriptStructure,
    shotlist: { ...shotlist, shots: sanitizedShots },
    manifest: { ...manifest, scenes: sanitizedScenes },
  };
  return {
    structureSignature: crypto.createHash('sha256').update(stableJson(structurePayload)).digest('hex'),
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
  return {
    status: input.fit.status === 'fits' ? 'inheritable' : 'pending',
    reason: input.fit.status === 'fits'
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
    generic_estimated_duration_sec: assessed.genericEstimatedSec,
    estimated_duration_sec: assessed.estimatedSec,
    duration_scale: assessed.durationScale,
    narration_unit: assessed.unit,
    narration_units: assessed.units,
    suggested_units: assessed.suggestedUnits,
    checked_at: new Date().toISOString(),
    validation_version: 1,
  };
}

function narrationFitMessage(fit: VideoProductionNarrationFit): string {
  const source = fit.source === 'measured_calibration'
    ? 'the persisted measured voice pace'
    : 'the generic natural-pace estimate';
  if (fit.status === 'over') {
    return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source}. Trim it to about ${fit.suggested_units} ${fit.narration_unit}; no speech request was sent.`;
  }
  if (fit.status === 'under') {
    return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source}. Expand it to about ${fit.suggested_units} ${fit.narration_unit}; no speech request was sent.`;
  }
  return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source} and is ready for production plan confirmation.`;
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
): Promise<
  | { ok: true }
  | { ok: false; errorCode: string; message: string; evidence?: VideoProductionPlanEvidence }
> {
  const state = await readVideoProductionState(statePath, compositionDirAbs);
  const identity = await videoProductionPlanIdentity(compositionDirAbs, {
    approval: state.plan_approval,
    roots,
  });
  if (!identity.complete) {
    return {
      ok: false,
      errorCode: identity.evidence.conflicts.length > 0
        ? 'E_GATE_B_ARTIFACT_CONFLICT'
        : 'E_GATE_B_ARTIFACTS_INCOMPLETE',
      message: identity.evidence.conflicts[0]?.message
        || 'Production plan confirmation requires one coherent script, shotlist, and valid composition manifest before prepare.',
      evidence: identity.evidence,
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
      message: 'Record the explicit script/shotlist approval with composition.approve_plan before prepare.',
    };
  }
  await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
    delete next.preview;
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

async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, absPath);
}

async function writeTextAtomic(absPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, absPath);
}

async function currentNarrationIdentity(compositionDirAbs: string): Promise<{
  required: boolean;
  textSha?: string;
  audioSha?: string;
  duration?: number;
  narrationMapMatches: boolean;
  materializationReceiptMatches: boolean;
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
      })
      : undefined;
    // narration-map.json is the durable materialization receipt written only
    // after measured audio, the retimed manifest, and their content hashes
    // agree. It is safe to restore a lost ledger binding from that receipt,
    // but not from a matching filename or a pair of hashes alone.
    const materializationReceiptMatches = narrationMapMatches
      && narrationMap?.schema_version === 1
      && narrationMap?.source === 'composition.materialize_narration'
      && !!expectedReceipt
      && stableJson(narrationMap) === stableJson(expectedReceipt);
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
        && !!state.artifacts.scaffold_html_sha256
        && artifacts.html_sha256 !== state.artifacts.scaffold_html_sha256;
      state.stage = input.stage === 'scaffold_ready' && narrationIsCurrent
        ? 'narration_ready'
        : input.stage === 'visuals_ready' && !authoredVisuals
          ? narrationIsCurrent ? 'narration_ready' : 'scaffold_ready'
          : input.stage;
    }
    if (input.ok && (input.op === 'composition.prepare' || input.op === 'composition.inspect')) {
      delete state.preview;
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
    } else if (state.artifacts.scaffold_html_sha256) {
      artifacts.scaffold_html_sha256 = state.artifacts.scaffold_html_sha256;
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
  const [signature, artifacts] = await Promise.all([
    videoStudioCompositionSignature(compositionDirAbs),
    videoProductionArtifacts(compositionDirAbs),
  ]);
  const framePaths = Array.isArray(result.frame_paths)
    ? result.frame_paths
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value))
    : [];
  await updateVideoProductionState(statePath, compositionDirAbs, (state) => {
    state[kind] = {
      signature,
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
  kind: 'preview' | 'draft',
  compositionDirAbs: string,
  currentTurnId: string,
  explicitlyApproved: boolean,
  decisionSource: VideoStudioResolvedDecision['source'] = 'none',
  submittedArtifactSignature?: string,
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  state = await migrateVideoStudioGateSignatureV5(statePath, kind, compositionDirAbs, state);
  const entry = state[kind];
  if (!entry) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_REQUIRED', message: 'Generate a passing composition.snapshot before approving the HTML preview.' }
      : { ok: false, errorCode: 'E_DRAFT_QA_REQUIRED', message: 'Generate a passing composition.draft before final video confirmation.' };
  }
  const signature = await videoStudioGateSignature(compositionDirAbs, entry);
  if (entry.signature !== signature) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_STALE', message: 'Composition inputs changed after the preview. Capture a new snapshot.' }
      : { ok: false, errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED', message: 'Composition inputs changed after the draft. Render a new draft.' };
  }
  if (!currentTurnId || entry.turn_id === currentTurnId) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED', message: 'Preview approval must come from a later explicit user turn.' }
      : { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'Final video confirmation must come from a later explicit user turn.' };
  }
  if (decisionSource === 'form') {
    if (submittedArtifactSignature && submittedArtifactSignature !== entry.signature) {
      return {
        ok: false,
        errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
        message: 'The submitted form belongs to an older review artifact. It was received but cannot approve the current artifact. Show the current artifact and keep its review pending without opening a duplicate form.',
        submitted_artifact_signature: submittedArtifactSignature,
        current_artifact_signature: entry.signature,
        submitted_decision_status: 'superseded',
      };
    }
    if (!submittedArtifactSignature && (state.candidate_history?.length || 0) > 0) {
      return {
        ok: false,
        errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
        message: 'This legacy form did not identify its review artifact and the project has since produced another candidate. It was received but cannot approve the current artifact. Show the current artifact and keep its review pending without opening a duplicate form.',
        submitted_artifact_signature: null,
        current_artifact_signature: entry.signature,
        submitted_decision_status: 'unbound_after_revision',
      };
    }
  }
  if (kind === 'preview' && entry.design_review?.required && entry.design_review.status !== 'passed') {
    return {
      ok: false,
      errorCode: 'E_PREVIEW_DESIGN_REVIEW_REQUIRED',
      message: 'Preview approval is unavailable until composition.submit_design_review records a passed review covering every frame from this exact snapshot.',
    };
  }
  if (kind === 'draft' && entry.design_review?.required && entry.design_review.status !== 'passed') {
    return {
      ok: false,
      errorCode: 'E_DESIGN_REVIEW_REQUIRED',
      message: 'Final video confirmation is unavailable until composition.submit_design_review records a passed review for this exact draft signature.',
    };
  }
  if (!explicitlyApproved) {
    return kind === 'preview'
      ? {
        ok: false,
        errorCode: 'E_HTML_PREVIEW_EXPLICIT_APPROVAL_REQUIRED',
        message: 'The current real user message must explicitly approve the displayed HTML preview before composition.approve_preview can record approval.',
      }
      : {
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
    next.stage = kind === 'preview' ? 'preview_approved' : 'draft_approved';
    recordVideoProductionTransition(next, {
      op: kind === 'preview' ? 'composition.approve_preview' : 'composition.approve_draft',
      status: 'passed',
      turnId: currentTurnId,
      stage: next.stage,
      artifacts,
    });
  });
  return { ok: true, entry: approvedState[kind]! };
}

export async function validateVideoStudioGate(
  statePath: string,
  kind: 'preview' | 'draft',
  compositionDirAbs: string,
  _currentTurnId: string,
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  state = await migrateVideoStudioGateSignatureV5(statePath, kind, compositionDirAbs, state);
  const entry = state[kind];
  if (!entry) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_REQUIRED', message: 'This multi-scene or designed composition requires composition.snapshot and a user preview turn before mp4 rendering.' }
      : { ok: false, errorCode: 'E_DRAFT_QA_REQUIRED', message: 'A successful composition.draft with video QA is required before high-quality export.' };
  }
  const signature = await videoStudioGateSignature(compositionDirAbs, entry);
  if (entry.signature !== signature) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_STALE', message: 'Composition inputs changed after the preview. Capture and show a new snapshot before rendering.' }
      : { ok: false, errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED', message: 'Composition inputs changed after the approved draft. Run composition.draft again and request final video confirmation.' };
  }
  if (kind === 'preview' && entry.design_review?.required && entry.design_review.status !== 'passed') {
    return {
      ok: false,
      errorCode: 'E_PREVIEW_DESIGN_REVIEW_REQUIRED',
      message: 'The snapshot exists but has not passed a complete preview-frame design review.',
    };
  }
  if (entry.status !== 'approved' || !entry.approved_turn_id || !entry.approved_at) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED', message: 'The preview exists but has not been explicitly approved. Call composition.approve_preview only after the user approves it.' }
      : { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'The draft exists but the final video has not been explicitly confirmed. Call composition.approve_draft only after the user confirms it.' };
  }
  return { ok: true, entry };
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

async function videoStudioDesignReviewRequired(
  compositionDirAbs: string,
  draftResult: Record<string, unknown>,
): Promise<boolean> {
  if (await videoStudioPreviewRequired(compositionDirAbs)) return true;
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    const artDirection = manifest.art_direction;
    if (artDirection && typeof artDirection === 'object' && !Array.isArray(artDirection)
      && (artDirection as Record<string, unknown>).style_source) return true;
  } catch { /* draft QA owns invalid-manifest errors */ }
  const report = draftResult.report && typeof draftResult.report === 'object' && !Array.isArray(draftResult.report)
    ? draftResult.report as Record<string, unknown>
    : {};
  const steps = report.steps && typeof report.steps === 'object' && !Array.isArray(report.steps)
    ? report.steps as Record<string, unknown>
    : {};
  const inspect = steps.inspect && typeof steps.inspect === 'object' && !Array.isArray(steps.inspect)
    ? steps.inspect as Record<string, unknown>
    : {};
  const disposition = inspect.draft_disposition && typeof inspect.draft_disposition === 'object'
    && !Array.isArray(inspect.draft_disposition)
    ? inspect.draft_disposition as Record<string, unknown>
    : {};
  return Number(disposition.advisory_count || 0) > 0;
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

async function ensureInputFile(absPath: string): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  return st && st.isFile() ? null : `input is not a file: ${absPath}`;
}

async function ensureInputDir(absPath: string): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  return st && st.isDirectory() ? null : `composition_dir is not a directory: ${absPath}`;
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
    catch (err) { log.warn(`onFileWritten failed: ${(err as Error).message}`); }
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
  catch (err) { log.warn(`onOutputsPublished failed: ${(err as Error).message}`); }
}

function resultContent(result: Record<string, unknown>, renamedNote = ''): string {
  return `${JSON.stringify(result, null, 2)}${renamedNote}`;
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
    narrationRequested = !!compositionNarrationText(manifest);
    if (narrationRequested) {
      narrationSelection = await resolveCompositionNarrationSelection({ manifest });
    }
  } catch { /* manifest readiness is reported by prepare */ }
  const checks = {
    workspace_write: { ok: writable, required: true },
    ffmpeg: { ok: ffmpegReady, required: true },
    ffprobe: { ok: ffprobeReady, required: true },
    browser_window: { ok: browserWindowAvailable, required: true },
    tts_provider: { ok: hasConfiguredTtsProvider(), required: narrationRequested },
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
}): Promise<Record<string, unknown>> {
  const manifestPath = path.join(input.compositionDirAbs, 'composition-manifest.json');
  const htmlPath = path.join(input.compositionDirAbs, 'index.html');
  let manifest: CompositionManifest;
  try {
    manifest = CompositionManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  } catch (err) {
    return {
      ok: false,
      op: 'composition.reconcile',
      errorCode: 'E_COMPOSITION_MANIFEST_INVALID',
      message: `Cannot reconcile an invalid composition manifest: ${(err as Error).message}`,
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
  const originalHtmlSha = crypto.createHash('sha256').update(originalHtml).digest('hex');
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
    await writeTextAtomic(htmlPath, reconciled.html);
  }
  const [artifacts, previewGateCheck, draftGateCheck, narrationIdentity, planIdentity] = await Promise.all([
    videoProductionArtifacts(input.compositionDirAbs),
    currentState.preview
      ? checkVideoStudioGateSignature(input.compositionDirAbs, currentState.preview)
      : Promise.resolve(undefined),
    currentState.draft
      ? checkVideoStudioGateSignature(input.compositionDirAbs, currentState.draft)
      : Promise.resolve(undefined),
    currentNarrationIdentity(input.compositionDirAbs),
    videoProductionPlanIdentity(input.compositionDirAbs, {
      approval: currentState.plan_approval,
      roots: input.roots,
    }),
  ]);
  const visualAuthored = (!!currentState.artifacts.scaffold_html_sha256
      && originalHtmlSha !== currentState.artifacts.scaffold_html_sha256)
    || !originalHtml.includes('ORKAS-GENERATED-SCAFFOLD');
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
    const previewValid = !!next.preview && previewGateCheck?.matches === true;
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
    if (!previewValid) delete next.preview;
    else if (next.preview && previewGateCheck?.upgradeToV5) {
      next.preview.validation_version = 5;
      next.preview.signature = artifacts.composition_signature || next.preview.signature;
    }
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
        ? { scaffold_html_sha256: artifacts.html_sha256 }
        : currentState.artifacts.scaffold_html_sha256
          ? { scaffold_html_sha256: currentState.artifacts.scaffold_html_sha256 }
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
    automatic_recovery_expected: true,
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
      message: `A valid composition-manifest.json is required before narration: ${(err as Error).message}`,
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
  const text = compositionNarrationText(manifest);
  if (!text) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_TEXT_MISSING',
      message: 'Add approved narration_text to manifest scenes before materializing narration.',
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
  const existingOutput = await fs.stat(outputAbsPath).catch(() => null);
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
    const narrationMapPath = path.join(input.compositionDirAbs, 'narration-map.json');
    if (!existingIdentity?.narrationMapMatches) {
      await writeJsonAtomic(narrationMapPath, buildCompositionNarrationMap(manifest, {
        textSha256: textSha,
        audioSha256: existingAudioSha!,
        method: 'scene_estimate_scaled',
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
      if (reconciledHtml.changed) await writeTextAtomic(htmlPath, reconciledHtml.html);
    }
    const measuredDurationSec = state.narration?.measured_duration_sec
      ?? existingIdentity?.duration;
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
    const authoredVisualsRecovered = narrationInvariantRecovery
      && ((!existingHtml.includes('ORKAS-GENERATED-SCAFFOLD'))
        || (!!state.artifacts.scaffold_html_sha256
          && state.artifacts.html_sha256 !== state.artifacts.scaffold_html_sha256));
    const finalArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
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
      delete next.narration_transaction;
      delete next.narration_retry_authorization;
      delete next.blocked_operation;
      next.artifacts = {
        ...finalArtifacts,
        scaffold_html_sha256: authoredVisualsRecovered
          ? state.artifacts.scaffold_html_sha256
          : finalArtifacts.html_sha256,
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
      const invalidEvidence = invalidDecisionEvidenceResult(
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
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_OUTPUT_CONFLICT',
      message: 'The saved narration cannot be proven to belong to the current confirmed script. It has been preserved and no new speech request was sent.',
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
          effect: 'Preserve the existing audio, then create one new narration request after explicit confirmation that it may incur a charge.',
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
  const currentArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const htmlPath = path.join(input.compositionDirAbs, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8').catch(() => '');
  const authoredVisualsPresent = (narrationInvariantRecovery || !!retryAuthorization)
    && ((!html.includes('ORKAS-GENERATED-SCAFFOLD'))
      || (!!state.artifacts.scaffold_html_sha256
        && currentArtifacts.html_sha256 !== state.artifacts.scaffold_html_sha256));
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
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_NO_PROVIDER',
      message: 'No TTS provider is configured. Configure Orkas Voice or a speech provider, then retry narration materialization.',
    };
  }

  const planIdentity = await videoProductionPlanIdentity(input.compositionDirAbs, {
    approval: state.plan_approval,
    roots: allowedRoots(input.opts),
  });
  const targetDurationSec = await approvedTargetDurationSec(manifest, planIdentity);
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
  await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    next.narration_fit = fit;
  });
  // A matching on-disk transaction is already paid/recoverable. Never strand
  // it behind a later estimator change; probe the real audio and let the
  // measured policy below decide. The estimate gate applies only before a new
  // provider request can be sent.
  if (fit.status !== 'fits' && !existingOutput) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: fit.status === 'over' ? 'E_TTS_TEXT_TOO_LONG' : 'E_TTS_TEXT_TOO_SHORT',
      message: `${narrationFitMessage(fit)} Revise the candidate manifest, run composition.check_narration_fit until gate_b_ready=true, then request production plan confirmation once for the fitting script.`,
      billable_request_sent: false,
      narration_fit: fit,
    };
  }
  const plannedSceneWeights = manifest.scenes.map((scene) => {
    const sceneText = scene.narration_text?.trim() || '';
    if (sceneText) return Math.max(0.05, estimateNarrationDuration(sceneText, effectiveSpeed).estimatedSec);
    return Math.max(0.05, scene.duration * 0.03);
  });

  await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
  const transactionId = transactionMatches
    ? state.narration_transaction!.transaction_id
    : crypto.randomUUID();
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
        next.narration_transaction_history = [
          ...(next.narration_transaction_history || []),
          next.narration_transaction,
        ].slice(-20);
        persisted.consumed_new_requests = 1;
        persisted.consumed_at = now;
      }
      next.narration_transaction = {
        transaction_id: transactionId,
        status: 'pending',
        text_sha256: textSha,
        path: outputAbsPath,
        manifest_sha256: currentArtifacts.manifest_sha256 || '',
        scaffold_html_sha256: currentArtifacts.html_sha256 || '',
        request_signature: requestSignature,
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
  const measuredDurationMismatch = measuredDurationSec > targetDurationSec + 0.15
    || measuredDurationSec < targetDurationSec * 0.9;
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
      message: `Measured narration is ${Math.round(measuredDurationSec * 1000) / 1000}s and cannot fit the approved ${targetDurationSec}s target (it may be at most 10% shorter, but cannot run longer). The synthesized audio, transaction, measured voice calibration, and bounded timing-repair authorization were preserved. Revise the script, shotlist narration, and manifest narration together to narration_fit.suggested_units, then run composition.check_narration_fit. When it returns approval_inherited=true, continue with composition.prepare without requesting production plan confirmation again.`,
      path: outputAbsPath,
      measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
      target_duration_sec: targetDurationSec,
      billable_request_sent: billableRequestSent,
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
    composition: { ...manifest.composition, target_duration: targetDurationSec },
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
  await writeJsonAtomic(manifestPath, retimedValidation.data);
  const narrationMapPath = path.join(input.compositionDirAbs, 'narration-map.json');
  await writeJsonAtomic(narrationMapPath, buildCompositionNarrationMap(retimedValidation.data, {
    textSha256: textSha,
    audioSha256: audioSha,
    method: 'scene_estimate_scaled',
  }));
  const authoredVisualsRecovered = narrationInvariantRecovery
    && ((!html.includes('ORKAS-GENERATED-SCAFFOLD'))
      || (!!state.artifacts.scaffold_html_sha256
        && state.artifacts.html_sha256 !== state.artifacts.scaffold_html_sha256));
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
    await writeTextAtomic(htmlPath, reconciledHtml.html);
  } else {
    await writeTextAtomic(htmlPath, buildCompositionScaffold(retimedValidation.data));
  }
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
    delete next.narration_transaction;
    delete next.narration_repair;
    next.stage = authoredVisualsRecovered ? 'visuals_ready' : 'narration_ready';
    delete next.preview;
    delete next.draft;
    delete next.blocked_operation;
    next.artifacts = {
      ...finalArtifacts,
      scaffold_html_sha256: authoredVisualsRecovered
        ? state.artifacts.scaffold_html_sha256
        : finalArtifacts.html_sha256,
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
    target_duration_sec: targetDurationSec,
    measured_duration_sec: Math.round(measuredDurationSec * 1000) / 1000,
    manifest_path: manifestPath,
    html_path: htmlPath,
    narration_map_path: narrationMapPath,
    alignment_method: 'scene_estimate_scaled',
    scaffold_retimed: true,
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
    production_state: await summarizeCompositionProductionState(updated, input.compositionDirAbs),
  };
}

export function createVideoStudioTool(opts: VideoStudioToolOpts): AgentTool {
  return {
    name: 'video_studio',
    description:
      'VideoStudio-native runtime for durable EDL approvals, billable generation authorization, stateful manifest-bounded HTML video production, runtime speech capabilities, and transcription. Use production.* for AUTO/GENERATE control and composition.* for signed HTML production.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [...OPS],
          description: 'Operation: production.status, production.approve_plan, production.approve_generation, composition.status, composition.doctor, composition.reconcile, composition.check_narration_fit, composition.approve_plan, composition.prepare, composition.materialize_narration, composition.lint, composition.inspect, composition.begin_visual_revision, composition.snapshot, composition.approve_preview, composition.draft, composition.submit_design_review, composition.approve_draft, composition.export, speech.capabilities, or speech.transcribe. composition.begin_visual_revision is an internal recovery operation for an exhausted visual-QA cycle. A current visual-preview or final-video revision submission authorizes the bounded edit and restart without a second user form; a newly confirmed production-plan signature starts fresh QA without this operation.',
        },
        plan_path: { type: 'string', description: 'Canonical project/plan.json for production.* operations or AUTO child-composition production-plan inheritance.' },
        segment_id: { type: 'string', description: 'Parent EDL segment id for AUTO child-composition production-plan inheritance.' },
        composition_dir: { type: 'string', description: 'Directory containing composition-manifest.json and generated index.html; prepare may run before index.html exists.' },
        decision_evidence: {
          type: 'object',
          description: 'For a natural-language user reply, pass a native object (never a quoted JSON string or bare reply) containing the model semantic decision and a verbatim excerpt from the current user turn. Do not send this for structured forms. The host verifies provenance, gate scope, version, and safety but does not classify user language with keyword rules. A safely parseable JSON-object string is accepted only as transport recovery; any other malformed value returns a same-turn self-correction result without consuming approval or sending a billable request.',
          properties: {
            source: { type: 'string', enum: ['user_message'] },
            gate: { type: 'string', enum: ['plan', 'generation', 'narration_retry', 'preview', 'draft'] },
            decision: { type: 'string', enum: ['approve', 'revise', 'reject'] },
            quote: { type: 'string' },
          },
          required: ['source', 'gate', 'decision', 'quote'],
        },
        expected_plan_change: { type: 'boolean', description: 'Set true only when composition.approve_plan consumes an approved production-plan amendment. The operation then fails closed unless the signed script, shotlist, or manifest signature actually changed; it never converts that mismatch into a recovery form.' },
        output_path: { type: 'string', description: 'Output video path for composition.draft/export, or snapshot path for composition.snapshot. Draft/export output must be outside composition_dir; use project/render.' },
        report_path: { type: 'string', description: 'Optional JSON QA report path for composition.draft/export. It must be outside composition_dir; use project/render.' },
        findings_path: { type: 'string', description: 'Optional findings JSON path for composition.inspect/snapshot/draft.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality; draft uses lower fps/CRF.' },
        fps: { type: 'number', description: 'Frames per second, capped at 60.' },
        strict_render_settings: { type: 'boolean', description: 'Set true only when the user explicitly requires exact fps/render settings. Default false lets final export choose the highest safe fps without another confirmation.' },
        format: { type: 'string', enum: ['mp4', 'webm'], description: 'Output video format. Default mp4.' },
        variables: { type: 'object', description: 'Optional composition variables exposed as window.__ORKAS_VIDEO_VARIABLES__.' },
        visual_baseline_path: { type: 'string', description: 'Optional visual baseline JSON path for advisory preview/draft regression checks.' },
        update_visual_baseline: { type: 'boolean', description: 'Explicitly promote current sampled preview/draft frames to the visual baseline. Never enabled automatically.' },
        voice: { type: 'string', description: 'Legacy schema_version 1 compatibility only. New manifests must use the production-plan-confirmed audio.narration_intent from speech.capabilities.' },
        speed: { type: 'number', description: 'Legacy schema_version 1 compatibility only. New manifests read speed from the production-plan-confirmed audio.narration_intent.' },
        review_verdict: { type: 'string', enum: ['passed', 'repair', 'blocked'], description: 'Structured design-review verdict for composition.submit_design_review.' },
        review_scope: { type: 'string', description: 'What the design review inspected (contact sheet, sampled frames, hierarchy, typography, rhythm).' },
        review_findings: { type: 'array', items: { type: 'string' }, description: 'Concise visual findings or required repairs.' },
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
        input_path: { type: 'string', description: 'Input audio/video path for speech.transcribe.' },
        transcript_path: { type: 'string', description: 'Optional transcript JSON output path for speech.transcribe.' },
        model: { type: 'string', description: 'ASR model id/path. Backend-specific.' },
        language: { type: 'string', description: 'ASR language code, or auto.' },
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
      const op = (rawOp === 'doctor' ? 'composition.doctor' : rawOp) as VideoStudioOp;
      if (!OPS.has(op)) {
        return { content: `op must be one of: ${[...OPS].join(', ')}`, isError: true } as ToolResult;
      }

      const roots = allowedRoots(opts);

      if (op === 'speech.capabilities') {
        const routes = await listTtsCapabilities(ctx.signal);
        return {
          content: resultContent({
            ok: routes.length > 0,
            op,
            status: routes.length ? 'ready' : 'unavailable',
            routes: publicTtsCapabilities(routes).map((route) => ({
              route_ref: route.routeRef,
              provider: route.provider,
              model: route.model,
              display_name: route.displayName,
              catalog_status: route.catalogStatus,
              default_voice_ref: route.defaultVoiceRef,
              voices: route.voices.map((voice) => ({
                voice_ref: voice.voiceRef,
                display_name: voice.displayName,
                locale: voice.locale,
                native_locale: voice.nativeLocale,
                supported_locales: voice.supportedLocales,
                mixed_language_support: voice.mixedLanguageSupport,
                language_confidence: voice.languageConfidence,
                ...(voice.accent ? { accent: voice.accent } : {}),
                gender: voice.gender,
                style_tags: voice.styleTags,
                use_cases: voice.useCases,
                is_default: voice.isDefault,
              })),
              supports: route.supports,
            })),
            invariant: 'Choose only a returned route_ref + voice_ref pair whose native_locale or verified supported_locales matches the deliverable language, and sign route_ref, voice_ref, language, display_name, and speed during production plan confirmation. language_confidence=candidate is unavailable for non-native production until verified; mixed_language_support permits inline foreign tokens, not an unsupported narration language. Never invent or pass an ad hoc provider voice id.',
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
        const planErr = await ensureInputFile(planAbs);
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
            return {
              content: resultContent({
                ok: true,
                op,
                status: 'reported',
                production_control: videoProductionControlSummary(identity, state),
              }),
              isError: false,
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
            const invalidEvidence = invalidDecisionEvidenceResult(op, 'plan', resolvedDecision);
            if (invalidEvidence) {
              return { content: resultContent(invalidEvidence), isError: true } as ToolResult;
            }
            if (resolvedDecision.decision !== 'approve') {
              return { content: 'E_VIDEO_PRODUCTION_GATE_B_EXPLICIT_APPROVAL_REQUIRED: the current real user turn must explicitly approve the displayed EDL.', isError: true } as ToolResult;
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
          const invalidEvidence = invalidDecisionEvidenceResult(op, 'generation', resolvedDecision);
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
        if (!compositionRaw) return { content: 'composition_dir is required', isError: true } as ToolResult;
        const compositionDirAbs = resolvePath(ctx, opts, compositionRaw, roots);
        if (!isPathAllowed(compositionDirAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: composition_dir is outside scope: ${compositionDirAbs}`, isError: true } as ToolResult;
        }
        const dirErr = await ensureInputDir(compositionDirAbs);
        if (dirErr) return { content: dirErr, isError: true } as ToolResult;

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
        if (op === 'composition.draft' || op === 'composition.export') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required', isError: true } as ToolResult;
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
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required for composition.snapshot', isError: true } as ToolResult;
          outputAbsPath = withExtension(resolvePath(ctx, opts, outputRaw, roots), 'png');
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
        const findingsAbsPath = typeof input.findings_path === 'string' && input.findings_path.trim()
          ? resolvePath(ctx, opts, input.findings_path, roots)
          : undefined;
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
        const policyFactsBefore = narrationPolicyFacts(stateBefore, narrationIdentityBefore);
        const misroutedGateBApproval = op === 'composition.begin_visual_revision'
          && resolveVideoStudioCurrentTurnDecision(
            opts.userMessage,
            'plan',
            input.decision_evidence,
          ).decision === 'approve';
        if (PLAN_APPROVAL_REQUIRED_OPS.has(op) && !misroutedGateBApproval) {
          const planApproval = await validatePlanApproval(
            gateStatePath,
            compositionDirAbs,
            roots,
          );
          if (planApproval.ok === false) {
            const blockedResult = {
              ok: false,
              op,
              errorCode: planApproval.errorCode,
              message: planApproval.message,
              ...(planApproval.evidence ? { evidence: planApproval.evidence } : {}),
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
        if (!misroutedGateBApproval && admission.ok === false) {
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
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'reported',
              artifact_drift: artifactDrift,
              reconciliation_required: artifactDrift
                || planRecordRefreshRequired
                || planArtifactConflict
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
              inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
              visual_qa_cycle_stale: !!legacyVisualQaCycle(stateBefore.visual_qa)
                && !currentVisualQaCycle(stateBefore.visual_qa),
              repair_state: repairState,
              production_state: summarizeVideoProductionState(stateBefore, policyFactsBefore),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.begin_visual_revision') {
          if (misroutedGateBApproval) {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_GATE_B_APPROVE_PLAN_REQUIRED',
                message: 'The current user already approved the displayed production-plan amendment. Apply that exact patch to the canonical plan artifacts, then call composition.approve_plan with expected_plan_change=true in this turn. Do not request visual recovery or another production plan confirmation.',
                expected_plan_change: true,
                visual_revision_recovery_available: false,
                next_action: 'apply_approved_amendment_then_composition.approve_plan',
              }),
              isError: true,
            } as ToolResult;
          }
          const existingCycle = currentVisualQaCycle(stateBefore.visual_qa);
          if (existingCycle?.started_by_turn_id === opts.turnId
            && existingCycle.failed_signatures.length === 0) {
            return {
              content: resultContent({
                ok: true,
                op,
                status: 'already_started',
                preserved_artifacts: ['plan_approval', 'script', 'shotlist', 'composition_manifest', 'narration'],
                next_action: 'composition.lint',
                visual_repair_cycle: visualQaRepairSummary(existingCycle),
                production_state: summarizeVideoProductionState(stateBefore),
              }),
              isError: false,
            } as ToolResult;
          }
          if (!visualQaBudgetExhausted(stateBefore.visual_qa)) {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_VISUAL_REVISION_NOT_REQUIRED',
                message: 'The current visual QA cycle is not exhausted. Continue the existing cycle instead of resetting it.',
                visual_revision_recovery_available: false,
                next_action: 'continue_current_cycle_without_recovery',
                visual_repair_cycle: visualQaRepairSummary(legacyVisualQaCycle(stateBefore.visual_qa)),
              }),
              isError: true,
            } as ToolResult;
          }
          if (stateBefore.draft?.status === 'approved') {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_VISUAL_REVISION_APPROVED_DRAFT_INVALID',
                message: 'A visual QA recovery revision cannot start after the current draft was approved; use the signed follow-up edit workflow.',
              }),
              isError: true,
            } as ToolResult;
          }
          const artifacts = await videoProductionArtifacts(compositionDirAbs);
          const visualRevision = nextVisualRevision(stateBefore.visual_qa);
          const revised = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
            const cycle = newVisualQaCycle({ visualRevision, turnId: opts.turnId });
            next.visual_qa = {
              cycle,
              history: visualQaHistoryWithCurrent(next.visual_qa),
            };
            delete next.preview;
            delete next.draft;
            delete next.blocked_operation;
            next.artifacts = { ...next.artifacts, ...artifacts };
            next.stage = 'visuals_ready';
            recordVideoProductionTransition(next, {
              op,
              status: 'passed',
              turnId: opts.turnId,
              stage: 'visuals_ready',
              artifacts,
            });
          }, { expectedRevision: stateBefore.revision });
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'started',
              visual_revision: visualRevision,
              inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
              recovery_started_automatically: true,
              requires_user_decision: false,
              preserved_artifacts: ['plan_approval', 'script', 'shotlist', 'composition_manifest', 'narration'],
              invalidated_artifacts: ['preview', 'draft'],
              next_action: 'composition.lint',
              visual_repair_cycle: visualQaRepairSummary(revised.visual_qa?.cycle),
              production_state: summarizeVideoProductionState(revised),
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
          if (typeof input.speed === 'number'
            && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) {
            return {
              content: 'E_TTS_SPEED_INVALID: speed must be between 0.5 and 2.0; prefer a natural pace near 1.0.',
              isError: true,
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
                    : 'One or more current plan files are missing. Restore the listed script, shotlist, or manifest before checking narration fit.'),
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
                message: (err as Error).message,
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
          const fit = compositionNarrationFit({
            text,
            targetDurationSec: await approvedTargetDurationSec(manifest, identity),
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
          const repeatedMeasuredRepairInput = !!stateBefore.narration_repair
            && stateBefore.narration_fit?.source === 'measured_calibration'
            && stateBefore.narration_fit.text_sha256 === fit.text_sha256
            && stateBefore.narration_fit.status !== 'fits';
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
          const archivedNarrationPath = approvalInherited
            ? await archiveStaleNarrationAudio({
              state: stateBefore,
              currentNarrationTextSha: fit.text_sha256,
              compositionDirAbs,
              roots,
            })
            : '';
          const checked = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
            next.narration_fit = fit;
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
              delete next.narration;
              delete next.narration_transaction;
              delete next.narration_repair;
              delete next.preview;
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
            : planApprovalCurrent && fit.status === 'fits'
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
              gate_b_ready: fit.status === 'fits',
              gate_b_required: gateBRequired,
              approval_inherited: approvalInherited,
              repair_authorization_status: repairAssessment.status,
              repair_authorization_reason: repairAssessment.reason,
              ...(typeof repairAssessment.editRatio === 'number'
                ? { narration_edit_ratio: Math.round(repairAssessment.editRatio * 10_000) / 10_000 }
                : {}),
              next_action: approvalInherited
                ? 'composition.prepare'
                : planApprovalCurrent && fit.status === 'fits'
                  ? preparedHtmlPresent ? 'composition.materialize_narration' : 'composition.prepare'
                : repairAssessment.status === 'pending'
                  ? 'revise_narration_then_composition.check_narration_fit'
                    : fit.status === 'fits'
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
            const invalidEvidence = invalidDecisionEvidenceResult(op, 'plan', resolvedPlanDecision);
            if (invalidEvidence) {
              return reviewToolResult({
                opts,
                state: stateBefore,
                result: invalidEvidence,
              });
            }
          }
          const identity = await videoProductionPlanIdentity(compositionDirAbs, {
            roots,
            preferLocal: !!parentPlanRaw || !!parentSegmentId,
          });
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
                    : `${approvalReceived ? 'Your confirmation was received. ' : ''}One or more current plan files are missing. Restore the listed script, shotlist, or manifest, then retry approval validation in this same turn.`),
                evidence: identity.evidence,
                artifact_issues: identity.artifactIssues || [],
                billable_request_sent: false,
                requires_user_decision: false,
                approval_received: approvalReceived,
                user_reconfirmation_required: !approvalReceived,
                next_action: artifactInvalid
                  ? 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan'
                  : 'restore_missing_plan_artifacts_then_retry_composition.approve_plan',
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
                next_action: 'repair_current_plan_artifacts_before_confirmation',
              },
            });
          }
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
            if (resolvedPlanDecision.decision !== 'approve') {
              return {
                content: 'E_GATE_B_EXPLICIT_APPROVAL_REQUIRED: composition.approve_plan is allowed only when the current real user message explicitly approves the displayed script and shotlist.',
                isError: true,
              } as ToolResult;
            }
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
                message: 'The approved production-plan amendment did not change the signed script, shotlist, or composition manifest. Apply the exact displayed patch to the canonical plan artifacts, then retry composition.approve_plan in this same approval turn. Do not request visual recovery or another production plan confirmation.',
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
          const approvedNarrationText = compositionNarrationText(manifest);
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
          const checkedNarrationFit = stateBefore.narration_fit?.plan_signature === identity.signature
            && stateBefore.narration_fit.text_sha256 === approvedNarrationTextSha
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
              targetDurationSec: await approvedTargetDurationSec(manifest, identity),
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
          if (approvedNarrationFit && approvedNarrationFit.status !== 'fits') {
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
          const visualQaReset = planChanged && !!stateBefore.visual_qa;
          const approved = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
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
              delete next.preview;
              delete next.draft;
              delete next.visual_qa;
              if (!narrationTextStillCurrent || !narrationSelectionStillCurrent) {
                delete next.narration;
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
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'approved',
              gate: 'B',
              plan_signature: identity.signature,
              approved_intent_hash: identity.signature,
              plan_identity_kind: 'approved_intent_sha256',
              plan_changed: planChanged,
              visual_qa_reset: visualQaReset,
              approval_inherited: !!inheritedParent,
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
        if (op === 'composition.approve_preview' || op === 'composition.approve_draft') {
          const kind = op === 'composition.approve_preview' ? 'preview' : 'draft';
          const resolvedDecision = resolveVideoStudioCurrentTurnDecision(
            opts.userMessage,
            kind,
            input.decision_evidence,
          );
          const invalidEvidence = invalidDecisionEvidenceResult(op, kind, resolvedDecision);
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
            resolvedDecision.source,
            resolvedDecision.artifact_signature,
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
              stage: kind === 'preview' ? 'preview_approval' : 'draft_approval',
              artifact_signature: approval.entry.signature,
              approved_at: approval.entry.approved_at,
              decision_source: resolvedDecision.source,
              next_allowed_ops: kind === 'preview' ? ['composition.draft'] : ['composition.export'],
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
        if (op === 'composition.draft' && await videoStudioPreviewRequired(compositionDirAbs)) {
          const gate = await validateVideoStudioGate(gateStatePath, 'preview', compositionDirAbs, opts.turnId || '');
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

        await startVideoStudioOperationState({
          statePath: gateStatePath,
          compositionDirAbs,
          op,
          turnId: opts.turnId,
          ...(outputAbsPath ? { outputPath: outputAbsPath } : {}),
          ...(reportAbsPath ? { reportPath: reportAbsPath } : {}),
          ...(findingsAbsPath ? { findingsPath: findingsAbsPath } : {}),
        });

        const common = {
          compositionDirAbs,
          ...(op === 'composition.draft' || op === 'composition.export'
            ? { repairStateAbsPath: videoStudioRepairStatePath(opts, compositionDirAbs) }
            : {}),
          ...(outputAbsPath && op !== 'composition.snapshot' ? { outputAbsPath } : {}),
          ...(outputAbsPath && op === 'composition.snapshot' ? { snapshotAbsPath: outputAbsPath } : {}),
          ...(reportAbsPath ? { reportAbsPath } : {}),
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

        if (result.ok && op === 'composition.snapshot') {
          result = {
            ...result,
            design_review_required: true,
            preview_design_review_required: true,
            preview_gate_ready: false,
            next_action: 'composition.submit_design_review',
            next_allowed_ops: ['composition.submit_design_review'],
          } as typeof result;
        }

        if (result.ok && op === 'composition.draft') {
          const previewEntry = stateBefore.preview;
          const previewReviewInherited = !!previewEntry
            && previewEntry.status === 'approved'
            && previewEntry.design_review?.status === 'passed'
            && (await checkVideoStudioGateSignature(compositionDirAbs, previewEntry)).matches;
          const designReviewRequired = previewReviewInherited
            ? false
            : await videoStudioDesignReviewRequired(compositionDirAbs, result);
          result = {
            ...result,
            design_review_required: designReviewRequired,
            design_review_inherited_from_preview: previewReviewInherited,
            gate_d_ready: !designReviewRequired,
            next_action: designReviewRequired ? 'composition.submit_design_review' : 'open_gate_d',
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
            if (reportAbsPath) {
              await fs.writeFile(reportAbsPath, JSON.stringify(report, null, 2), 'utf8');
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
        if (reportAbsPath && await existingCandidateFile(reportAbsPath)) {
          result = { ...result, report_path: reportAbsPath } as typeof result;
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
        }
        const renameNote = renamed && outputAbsPath ? renderRenameSignal(requestedOutput, outputAbsPath) : '';
        return { content: resultContent(result, renameNote), isError: result.ok === false } as ToolResult;
      }

      const inputRaw = String(input.input_path || '').trim();
      if (!inputRaw) return { content: 'input_path is required for speech.transcribe', isError: true } as ToolResult;
      const inputAbsPath = resolvePath(ctx, opts, inputRaw, roots);
      if (!isPathAllowed(inputAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside scope: ${inputAbsPath}`, isError: true } as ToolResult;
      }
      const fileErr = await ensureInputFile(inputAbsPath);
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
}
