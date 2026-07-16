/**
 * VideoStudio-owned native runtime tool.
 *
 * This intentionally covers only the VideoStudio dependency points that need
 * to be native:
 * HTML composition render/lint/inspect and speech transcription. The rest of
 * VideoStudio's agent-private scripts stay script-owned.
 */

import * as crypto from 'node:crypto';
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
  type CompositionManifest,
} from '../../features/video_studio_contract';
import {
  advanceVideoProductionStage,
  isVideoProductionOpAllowed,
  readVideoProductionState,
  recordVideoProductionTransition,
  summarizeVideoProductionState,
  updateVideoProductionState,
  videoProductionStageAtLeast,
  type VideoProductionArtifactState,
  type VideoProductionGateEntry,
  type VideoProductionNarrationFit,
  type VideoProductionNarrationRepairAuthorization,
  type VideoProductionStateV1,
  type VideoProductionVisualQaCycle,
  type VideoProductionVisualQaState,
  type VideoProductionVisualQaAttempt,
} from '../../features/video_studio_state';
import {
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

export type VideoStudioApprovalGate = 'plan' | 'generation' | 'preview' | 'draft';
export type VideoStudioApprovalDecision = 'approve' | 'reject' | 'unknown';

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
  if (/(?:^|_)(?:html_?preview|preview)(?:_|$)/i.test(key)) hints.add('preview');
  if (/(?:^|_)(?:gate_?d|draft|export|final)(?:_|$)/i.test(key)) hints.add('draft');
  return hints;
}

function structuredApprovalValue(value: unknown): VideoStudioApprovalDecision {
  if (value === true) return 'approve';
  if (value === false) return 'reject';
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (APPROVAL_VALUES.has(normalized)) return 'approve';
  if (REJECTION_VALUES.has(normalized)) return 'reject';
  return 'unknown';
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
  const payload = currentUserTurnPayload(message);
  if (!payload) return 'unknown';

  const hasSubmissionTag = /<agent-input-submission\b/i.test(payload);
  const submission = decodeSubmission(payload);
  if (hasSubmissionTag) {
    if (!submission || submission.agent_id !== expectedAgentId) return 'unknown';
    let approved = false;
    let rejected = false;
    for (const [key, value] of Object.entries(submission.values)) {
      if (!APPROVAL_FIELD_RE.test(key)) continue;
      const hints = approvalKeyGateHints(key);
      // A generic `decision=approve` is not enough: it could belong to Gate A,
      // billing consent, or another production gate in the same conversation.
      if (hints.size !== 1 || !hints.has(gate)) continue;
      const decision = structuredApprovalValue(value);
      if (decision === 'approve') approved = true;
      if (decision === 'reject') rejected = true;
    }
    if (rejected) return 'reject';
    return approved ? 'approve' : 'unknown';
  }

  const text = payload
    .split(/\r?\n/)
    .filter((line) => !/^\s*@[^\s]+\s*$/.test(line))
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 300 || /[?？]/.test(text)) return 'unknown';
  if (/(?:不同意|不批准|不确认|不继续|先别|不要|拒绝|取消|返回|暂停|停止|修改|调整|重做|有问题|revise|reject|deny|cancel|stop|pause|change\s+direction)/i.test(text)) {
    return 'reject';
  }
  if (gate === 'generation'
    && !/(?:gate\s*c|付费|计费|扣费|生成(?:镜头|图片|视频)|billable|billing|paid\s+generation|generate\s+(?:the\s+)?(?:image|video|shot))/i.test(text)) {
    return 'unknown';
  }
  if (/^(?:我(?:已|明确)?\s*)?(?:同意|批准|确认|通过)(?:$|[\s，,。.!！]|当前|以上|该|此|并|继续|执行|批准|付费|计费|扣费|生成)/i.test(text)) return 'approve';
  if (/^(?:可以|继续|按(?:这个|此)方案(?:继续|执行)?)[。！!\s]*$/i.test(text)) return 'approve';
  if (/^(?:i\s+)?(?:approve|approved|confirm|confirmed|accept|accepted|yes|continue|looks good)[.!\s]*$/i.test(text)) return 'approve';
  return 'unknown';
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
  | { ok: false; errorCode: string; message: string };

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

async function compositionFiles(
  compositionDirAbs: string,
  signatureVersion: 1 | 2 | 3 = 3,
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
        if (signatureVersion >= 3 && isRuntimeGeneratedCompositionPathV3(rel, true)) continue;
        if (signatureVersion === 2 && isRuntimeGeneratedCompositionPath(rel, true)) continue;
        await visit(abs);
      } else if (entry.isFile()) {
        if (hasCanonicalManifest && (rel === 'design-contract.json' || rel === 'scene-map.json')) continue;
        if (signatureVersion >= 3 && isRuntimeGeneratedCompositionPathV3(rel, false)) continue;
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
  signatureVersion: 2 | 3 = 3,
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
  if (entry.validation_version >= 3) return videoStudioCompositionSignature(compositionDirAbs, 3);
  if (entry.validation_version === 2) return videoStudioCompositionSignature(compositionDirAbs, 2);
  return legacyVideoStudioCompositionSignature(compositionDirAbs);
}

async function checkVideoStudioGateSignature(
  compositionDirAbs: string,
  entry: VideoProductionGateEntry,
): Promise<{ matches: boolean; upgradeToV3: boolean }> {
  if (entry.validation_version !== 2) {
    return {
      matches: entry.signature === await videoStudioGateSignature(compositionDirAbs, entry),
      upgradeToV3: false,
    };
  }
  const [v2Signature, v3Signature] = await Promise.all([
    videoStudioCompositionSignature(compositionDirAbs, 2),
    videoStudioCompositionSignature(compositionDirAbs, 3),
  ]);
  return {
    matches: entry.signature === v2Signature || entry.signature === v3Signature,
    upgradeToV3: entry.signature === v3Signature,
  };
}

async function compositionInputsUnchangedSince(
  compositionDirAbs: string,
  isoTime: string | undefined,
): Promise<boolean> {
  const cutoff = Date.parse(isoTime || '');
  if (!Number.isFinite(cutoff)) return false;
  const stats = await Promise.all((await compositionFiles(compositionDirAbs, 3)).map((abs) => fs.stat(abs)));
  return stats.every((stat) => stat.mtimeMs <= cutoff);
}

async function migrateVideoStudioGateSignatureV3(
  statePath: string,
  kind: 'preview' | 'draft',
  compositionDirAbs: string,
  state: VideoProductionStateV1,
): Promise<VideoProductionStateV1> {
  const entry = state[kind];
  if (!entry || entry.validation_version !== 2) return state;
  const check = await checkVideoStudioGateSignature(compositionDirAbs, entry);
  const unchangedApprovedInputs = entry.status === 'approved'
    && await compositionInputsUnchangedSince(compositionDirAbs, entry.approved_at);
  // Some v2 gates included an earlier copy of draft-qa.json. Once that report
  // was rewritten, its old bytes were unavailable, so equality cannot prove
  // migration. File mtimes provide the second safe path: every v3 input must
  // still predate the recorded approval; runtime reports are excluded.
  if ((!check.matches || !check.upgradeToV3) && !unchangedApprovedInputs) return state;
  const artifacts = await videoProductionArtifacts(compositionDirAbs);
  try {
    return await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
      const nextEntry = next[kind];
      if (!nextEntry || nextEntry.validation_version !== 2 || nextEntry.signature !== entry.signature) {
        throw new Error('E_VIDEO_PRODUCTION_STATE_CONFLICT: gate changed while its signature was being migrated.');
      }
      nextEntry.validation_version = 3;
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

function sameVideoProductionArtifacts(
  a: VideoProductionArtifactState | undefined,
  b: VideoProductionArtifactState | undefined,
): boolean {
  return !!a && !!b
    && a.composition_signature === b.composition_signature
    && a.manifest_sha256 === b.manifest_sha256
    && a.html_sha256 === b.html_sha256;
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
  if (cycle.passed_signatures[key] === signature) {
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
          ...(state.preview?.path ? { contact_sheet: state.preview.path } : {}),
        } : {}),
        next_action: input.op === 'composition.inspect'
          ? 'composition.snapshot'
          : previewStatus === 'approved' ? 'composition.draft' : 'composition.approve_preview',
        visual_repair_cycle: visualQaRepairSummary(cycle),
        production_state: summarizeVideoProductionState(state),
      }),
      isError: false,
    };
  }
  const failedSignatures = cycle.failed_signatures;
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
        visual_repair_cycle: visualQaRepairSummary(cycle),
      }),
      isError: true,
    };
  }
  if (cycle.status === 'exhausted' || failedSignatures.length >= VISUAL_QA_MAX_REPAIR_PASSES + 1) {
    return {
      content: resultContent({
        ok: false,
        op: input.op,
        errorCode: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
        message: `Automatic visual repair reached the limit for this QA cycle after the initial attempt plus ${VISUAL_QA_MAX_REPAIR_PASSES} distinct repair passes. Preserve the approved plan and narration; do not edit again until the user starts a new visual revision.`,
        visual_revision_recovery_available: true,
        recovery_action: 'composition.begin_visual_revision',
        recovery_requires_explicit_user_confirmation: true,
        recovery_form: {
          field_id: 'visual_recovery_decision',
          approve_value: 'new_visual_revision',
        },
        preserved_artifacts: ['plan_approval', 'script', 'shotlist', 'composition_manifest', 'narration'],
        visual_repair_cycle: visualQaRepairSummary(cycle),
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

function canonicalPlanPayload(manifest: CompositionManifest, targetDuration?: number): Record<string, unknown> {
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

async function videoProductionPlanIdentity(compositionDirAbs: string): Promise<{
  applicable: boolean;
  complete: boolean;
  signature: string;
  artifactPaths: string[];
  requirementIssues: string[];
}> {
  const projectDir = path.resolve(compositionDirAbs, '..');
  const localScriptPath = path.join(compositionDirAbs, 'script.md');
  const localShotlistPath = path.join(compositionDirAbs, 'shotlist.json');
  const parentScriptPath = path.join(projectDir, 'script.md');
  const parentShotlistPath = path.join(projectDir, 'shotlist.json');
  const localArtifacts = !!await fs.stat(localScriptPath).catch(() => null)
    || !!await fs.stat(localShotlistPath).catch(() => null);
  const scriptPath = localArtifacts ? localScriptPath : parentScriptPath;
  const shotlistPath = localArtifacts ? localShotlistPath : parentShotlistPath;
  const manifestPath = path.join(compositionDirAbs, 'composition-manifest.json');
  const [script, shotlistRaw, manifestRaw] = await Promise.all([
    fs.readFile(scriptPath).catch(() => null),
    fs.readFile(shotlistPath).catch(() => null),
    fs.readFile(manifestPath, 'utf8').catch(() => ''),
  ]);
  const applicable = !!script || !!shotlistRaw;
  if (!applicable) return { applicable: false, complete: false, signature: '', artifactPaths: [], requirementIssues: [] };
  let shotlist: Record<string, unknown> = {};
  let shotlistValid = false;
  try {
    const parsed = JSON.parse(shotlistRaw?.toString('utf8') || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      shotlist = parsed;
      shotlistValid = true;
    }
  } catch { /* reported as an incomplete Gate B artifact below */ }
  const targetDuration = Number(shotlist.target_duration_seconds);
  const requirementIssues = [
    ...(Number.isFinite(targetDuration) && targetDuration > 0 ? [] : ['shotlist.target_duration_seconds']),
    ...(typeof shotlist.video_language === 'string' && shotlist.video_language.trim() ? [] : ['shotlist.video_language']),
    ...(typeof shotlist.audio_mode === 'string' && shotlist.audio_mode.trim() ? [] : ['shotlist.audio_mode']),
    ...(typeof shotlist.caption_mode === 'string' && shotlist.caption_mode.trim() ? [] : ['shotlist.caption_mode']),
    ...(typeof shotlist.music_mode === 'string' && shotlist.music_mode.trim() ? [] : ['shotlist.music_mode']),
  ];
  let planPayload = '';
  let manifestValid = false;
  try {
    const manifest = CompositionManifestSchema.parse(JSON.parse(manifestRaw));
    manifestValid = true;
    planPayload = JSON.stringify(canonicalPlanPayload(
      manifest,
      Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : undefined,
    ));
  } catch {
    planPayload = manifestRaw;
  }
  const hash = crypto.createHash('sha256');
  hash.update(script || Buffer.alloc(0));
  hash.update('\0');
  hash.update(shotlistRaw || Buffer.alloc(0));
  hash.update('\0');
  hash.update(planPayload);
  return {
    applicable,
    complete: !!script && !!shotlistRaw && shotlistValid && manifestValid,
    signature: hash.digest('hex'),
    artifactPaths: [scriptPath, shotlistPath, manifestPath],
    requirementIssues,
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
      message: 'AUTO compose inheritance requires spec.composition_plan.scenes in the Gate B EDL. Do not open a child Gate B automatically; revise and re-approve the parent EDL once.',
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
      message: 'The child composition copy, narration, scene ids, or semantic roles differ from the Gate B parent EDL binding.',
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

function normalizedRepairText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
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
 * that may be shortened/expanded by the measured-duration repair. The three
 * narration copies must still agree scene-by-scene, and approved on-screen
 * copy is redacted only when it exactly duplicates that scene's narration.
 */
async function videoProductionNarrationRepairIdentity(
  compositionDirAbs: string,
): Promise<NarrationRepairIdentity | undefined> {
  const projectDir = path.resolve(compositionDirAbs, '..');
  const [script, shotlistRaw, manifestRaw] = await Promise.all([
    fs.readFile(path.join(projectDir, 'script.md'), 'utf8').catch(() => ''),
    fs.readFile(path.join(projectDir, 'shotlist.json'), 'utf8').catch(() => ''),
    fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8').catch(() => ''),
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
  if (!Array.isArray(shotlist.shots) || shotlist.shots.length !== manifest.scenes.length) return undefined;

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
    const shotNarration = typeof shot?.narration === 'string' ? shot.narration.trim() : '';
    if (!narration || !shot || normalizedRepairText(shotNarration) !== normalizedRepairText(narration)) {
      return undefined;
    }
    const scriptIndex = scriptStructure.indexOf(narration);
    if (scriptIndex < 0) return undefined;
    const marker = `{{ORKAS_NARRATION:${scene.id}}}`;
    scriptStructure = `${scriptStructure.slice(0, scriptIndex)}${marker}${scriptStructure.slice(scriptIndex + narration.length)}`;
    sanitizedShots.push({ ...shot, narration: marker });
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
  if (checksUsed > authorization.max_checks) {
    return { status: 'rejected', reason: 'repair_check_budget_exhausted', checksUsed };
  }
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
    reason: input.fit.status === 'fits' ? 'measured_narration_fit_repaired' : 'repair_still_outside_delivery_band',
    editRatio,
    checksUsed,
  };
}

async function approvedTargetDurationSec(
  compositionDirAbs: string,
  manifest: CompositionManifest,
): Promise<number> {
  if (typeof manifest.composition.target_duration === 'number') return manifest.composition.target_duration;
  try {
    const shotlist = JSON.parse(await fs.readFile(path.join(compositionDirAbs, '..', 'shotlist.json'), 'utf8')) as Record<string, unknown>;
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
        message: 'A narrated schema_version 2 manifest must contain audio.narration_intent selected from speech.capabilities before Gate B.',
      };
    }
    if (input.legacyVoice
      || (typeof input.legacySpeed === 'number' && Math.abs(input.legacySpeed - intent.speed) > 0.0001)) {
      return {
        ok: false,
        errorCode: 'E_TTS_SELECTION_OVERRIDE_FORBIDDEN',
        message: 'Execution cannot override the Gate B-signed narration route, voice, language, or speed. Revise audio.narration_intent and reopen Gate B.',
      };
    }
    const resolved = await resolveTtsSelection({
      routeRef: intent.route_ref,
      voiceRef: intent.voice_ref,
      language: intent.language,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (resolved.ok === false) return resolved;
    if (resolved.selection.displayName !== intent.display_name) {
      return {
        ok: false,
        errorCode: 'E_TTS_INTENT_LABEL_MISMATCH',
        message: 'The signed narration display name no longer matches the active capability catalog. Refresh speech.capabilities and reopen Gate B.',
      };
    }
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
  return `Narration is estimated at ${fit.estimated_duration_sec}s for a ${fit.target_duration_sec}s target using ${source} and is ready for Gate B.`;
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
    if (resolved.selection.displayName !== displayName) {
      return {
        ok: false,
        errorCode: 'E_TTS_INTENT_LABEL_MISMATCH',
        message: 'tracks.narration.synthesis.display_name no longer matches speech.capabilities. Refresh the plan before Gate B.',
      };
    }
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
): Promise<{ ok: true } | { ok: false; errorCode: string; message: string }> {
  const identity = await videoProductionPlanIdentity(compositionDirAbs);
  if (!identity.complete) {
    return {
      ok: false,
      errorCode: 'E_GATE_B_ARTIFACTS_INCOMPLETE',
      message: 'Gate B requires project/script.md, project/shotlist.json, and a valid composition manifest before prepare.',
    };
  }
  const state = await readVideoProductionState(statePath, compositionDirAbs);
  if (!state.plan_approval) {
    return {
      ok: false,
      errorCode: 'E_GATE_B_APPROVAL_REQUIRED',
      message: 'Record the explicit script/shotlist approval with composition.approve_plan before prepare.',
    };
  }
  if (state.plan_approval.signature !== identity.signature) {
    await updateVideoProductionState(statePath, compositionDirAbs, (next) => {
      delete next.plan_approval;
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
      message: 'The approved script, shotlist, or narration payload changed. Re-open Gate B and approve the new plan.',
    };
  }
  return { ok: true };
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
  textSha?: string;
  audioSha?: string;
  duration?: number;
  materialized: boolean;
}> {
  try {
    const parsed = CompositionManifestSchema.safeParse(JSON.parse(
      await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
    ));
    if (!parsed.success) return { materialized: false };
    const text = compositionNarrationText(parsed.data);
    const track = parsed.data.audio.tracks.find((item) => item.kind === 'narration');
    const audioAbsPath = track?.src === 'assets/narration.mp3'
      ? path.join(compositionDirAbs, track.src)
      : '';
    const audioSha = audioAbsPath ? await sha256File(audioAbsPath) : undefined;
    return {
      ...(text ? { textSha: crypto.createHash('sha256').update(text).digest('hex') } : {}),
      ...(audioSha ? { audioSha } : {}),
      ...(track ? { duration: track.duration } : {}),
      materialized: parsed.data.audio.owner === 'composition'
        && track?.src === 'assets/narration.mp3'
        && !!audioSha,
    };
  } catch {
    return { materialized: false };
  }
}

async function recordVideoStudioOperationState(input: {
  statePath: string;
  compositionDirAbs: string;
  op: string;
  turnId?: string;
  ok: boolean;
  stage?: VideoProductionStateV1['stage'];
  errorCode?: string;
}): Promise<VideoProductionStateV1> {
  const artifacts = await videoProductionArtifacts(input.compositionDirAbs);
  const narration = input.ok && input.op === 'composition.prepare'
    ? await currentNarrationIdentity(input.compositionDirAbs)
    : null;
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    const narrationIsCurrent = !!state.narration
      && narration?.materialized === true
      && narration.textSha === state.narration.text_sha256
      && narration.audioSha === state.narration.audio_sha256
      && Math.abs((narration.duration || 0) - state.narration.measured_duration_sec) <= 0.01;
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
  return updateVideoProductionState(input.statePath, input.compositionDirAbs, (state) => {
    const startedAt = new Date().toISOString();
    state.active_operation = {
      operation_id: crypto.randomUUID(),
      op: input.op,
      stage: state.stage,
      revision: state.revision + 1,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      ...(input.outputPath ? { output_path: input.outputPath } : {}),
      ...(input.reportPath ? { report_path: input.reportPath } : {}),
      ...(input.findingsPath ? { findings_path: input.findingsPath } : {}),
      started_at: startedAt,
    };
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
  await updateVideoProductionState(statePath, compositionDirAbs, (state) => {
    state[kind] = {
      signature,
      turn_id: turnId,
      created_at: new Date().toISOString(),
      status: 'ready',
      validation_version: 3,
      ...(kind === 'preview' && typeof result.contact_sheet === 'string' && result.contact_sheet
        ? { path: result.contact_sheet }
        : typeof result.path === 'string' && result.path ? { path: result.path } : {}),
      ...(typeof result.report_path === 'string' && result.report_path ? { report_path: result.report_path } : {}),
      ...(kind === 'draft' ? {
        design_review: {
          required: result.design_review_required === true,
          status: result.design_review_required === true ? 'pending' : 'passed',
          ...(result.design_review_required === true ? {} : {
            reviewed_at: new Date().toISOString(),
            verdict: 'not_required',
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
): Promise<VideoStudioGateCheck> {
  let state = await readVideoProductionState(statePath, compositionDirAbs);
  state = await migrateVideoStudioGateSignatureV3(statePath, kind, compositionDirAbs, state);
  const entry = state[kind];
  if (!entry) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_REQUIRED', message: 'Generate a passing composition.snapshot before approving the HTML preview.' }
      : { ok: false, errorCode: 'E_DRAFT_QA_REQUIRED', message: 'Generate a passing composition.draft before approving Gate D.' };
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
      : { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'Gate D approval must come from a later explicit user turn.' };
  }
  if (kind === 'draft' && entry.design_review?.required && entry.design_review.status !== 'passed') {
    return {
      ok: false,
      errorCode: 'E_DESIGN_REVIEW_REQUIRED',
      message: 'Gate D cannot be approved until composition.submit_design_review records a passed review for this exact draft signature.',
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
        message: 'The current real user message must explicitly approve the displayed draft before composition.approve_draft can record Gate D approval.',
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
  state = await migrateVideoStudioGateSignatureV3(statePath, kind, compositionDirAbs, state);
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
      : { ok: false, errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED', message: 'Composition inputs changed after the approved draft. Run composition.draft again and reopen Gate D.' };
  }
  if (entry.status !== 'approved' || !entry.approved_turn_id || !entry.approved_at) {
    return kind === 'preview'
      ? { ok: false, errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED', message: 'The preview exists but has not been explicitly approved. Call composition.approve_preview only after the user approves it.' }
      : { ok: false, errorCode: 'E_GATE_D_APPROVAL_REQUIRED', message: 'The draft exists but Gate D has not been explicitly approved. Call composition.approve_draft only after the user approves it.' };
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
    videoProductionPlanIdentity(input.compositionDirAbs),
  ]);
  const visualAuthored = videoProductionStageAtLeast(currentState.stage, 'visuals_ready')
    || (!!currentState.artifacts.scaffold_html_sha256
      && originalHtmlSha !== currentState.artifacts.scaffold_html_sha256);
  const narrationProvenanceMatches = (!!currentState.narration
    && currentState.narration.text_sha256 === narrationIdentity.textSha
    && currentState.narration.audio_sha256 === narrationIdentity.audioSha)
    || (!!currentState.narration_transaction
      && currentState.narration_transaction.text_sha256 === narrationIdentity.textSha
      && (!currentState.narration_transaction.audio_sha256
        || currentState.narration_transaction.audio_sha256 === narrationIdentity.audioSha));
  const narrationRecovered = narrationProvenanceMatches
    && narrationIdentity.materialized
    && !!narrationIdentity.textSha
    && !!narrationIdentity.audioSha
    && typeof narrationIdentity.duration === 'number';
  const state = await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
    if (next.active_operation) {
      recordVideoProductionTransition(next, {
        op: next.active_operation.op,
        status: 'failed',
        errorCode: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
        stage: next.stage,
      });
    }
    const planChanged = !!next.plan_approval
      && planIdentity.applicable
      && next.plan_approval.signature !== planIdentity.signature;
    if (planChanged) delete next.plan_approval;
    const previewValid = !!next.preview && previewGateCheck?.matches === true;
    const draftValid = !!next.draft && draftGateCheck?.matches === true;
    if (!previewValid) delete next.preview;
    else if (next.preview && previewGateCheck?.upgradeToV3) {
      next.preview.validation_version = 3;
      next.preview.signature = artifacts.composition_signature || next.preview.signature;
    }
    if (!draftValid) delete next.draft;
    else if (next.draft && draftGateCheck?.upgradeToV3) {
      next.draft.validation_version = 3;
      next.draft.signature = artifacts.composition_signature || next.draft.signature;
    }
    if (narrationRecovered) {
      const previous = next.narration;
      next.narration = {
        status: 'materialized',
        text_sha256: narrationIdentity.textSha!,
        audio_sha256: narrationIdentity.audioSha!,
        path: path.join(input.compositionDirAbs, 'assets', 'narration.mp3'),
        measured_duration_sec: narrationIdentity.duration!,
        backend: previous?.backend || next.narration_transaction?.backend || 'recovered',
        ...(previous?.voice ? { voice: previous.voice } : {}),
        ...(typeof previous?.speed === 'number' ? { speed: previous.speed } : {}),
        materialized_at: previous?.materialized_at || new Date().toISOString(),
      };
      delete next.narration_transaction;
    } else if (next.narration) {
      delete next.narration;
    }
    let stage: VideoProductionStateV1['stage'] = visualAuthored
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
    html_path: htmlPath,
    issues: reconciled.issues,
    production_state: summarizeVideoProductionState(state),
  };
}

async function materializeCompositionNarration(input: {
  compositionDirAbs: string;
  statePath: string;
  voice?: string;
  speed?: number;
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

  const state = await readVideoProductionState(input.statePath, input.compositionDirAbs);
  const textSha = crypto.createHash('sha256').update(text).digest('hex');
  const requestSignature = crypto.createHash('sha256').update(JSON.stringify({
    text_sha256: textSha,
    route_ref: routeRef,
    voice_ref: voiceRef,
    language,
    model: narrationSelection.selection.model,
    speed: effectiveSpeed,
    format: 'mp3',
  })).digest('hex');
  const outputAbsPath = path.join(input.compositionDirAbs, 'assets', 'narration.mp3');
  const existingOutput = await fs.stat(outputAbsPath).catch(() => null);
  const existingAudioSha = existingOutput?.isFile() ? await sha256File(outputAbsPath) : undefined;
  const narrationTrack = manifest.audio.tracks.find((track) => track.kind === 'narration');
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
  if (trackedNarrationIsCurrent) {
    const reusedState = videoProductionStageAtLeast(state.stage, 'narration_ready')
      ? state
      : await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
        next.stage = 'narration_ready';
        recordVideoProductionTransition(next, {
          op: 'composition.materialize_narration',
          status: 'passed',
          turnId: input.opts.turnId,
          stage: 'narration_ready',
          artifacts: next.artifacts,
        });
      });
    return {
      ok: true,
      op: 'composition.materialize_narration',
      status: 'reused',
      path: outputAbsPath,
      measured_duration_sec: state.narration.measured_duration_sec,
      narration_text_sha256: textSha,
      billable_request_sent: false,
      production_state: summarizeVideoProductionState(reusedState),
    };
  }
  const transactionMatches = !!state.narration_transaction
    && state.narration_transaction.text_sha256 === textSha
    && path.resolve(state.narration_transaction.path) === path.resolve(outputAbsPath)
    && (state.narration_transaction.request_signature === requestSignature
      || (manifest.schema_version === 1 && !state.narration_transaction.request_signature));
  if (!existingOutput && transactionMatches && state.narration_transaction?.status === 'failed') {
    const transaction = state.narration_transaction;
    const safeAfterPlanFix = transaction.retry_policy === 'safe_after_plan_fix'
      || transaction.charge_status === 'not_charged'
      || transaction.request_disposition === 'rejected_preflight';
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: safeAfterPlanFix ? 'E_TTS_PLAN_REVISION_REQUIRED' : 'E_TTS_RETRY_REQUIRES_USER_ACTION',
      message: safeAfterPlanFix
        ? 'The matching narration request was rejected without a charge. Refresh speech.capabilities, revise the signed narration intent, and reopen Gate B before retrying.'
        : 'The matching narration request may have reached the provider and its charge state is not safely retryable. Do not resend automatically; require explicit user direction and a new signed request.',
      billable_request_sent: transaction.request_disposition === 'sent',
      request_disposition: transaction.request_disposition || 'sent',
      charge_status: transaction.charge_status || 'unknown',
      retry_policy: transaction.retry_policy || 'requires_user_action',
    };
  }
  if (existingOutput && !transactionMatches) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_OUTPUT_CONFLICT',
      message: 'assets/narration.mp3 exists but its text/audio hashes or transaction do not match production state. Preserve it and run composition.reconcile instead of overwriting a potentially billable artifact.',
    };
  }
  if (state.stage !== 'scaffold_ready' && !transactionMatches) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_STAGE_INVALID',
      message: `Narration may be generated only at scaffold_ready, after composition.prepare and before visual authoring. Current stage: ${state.stage}.`,
      production_state: summarizeVideoProductionState(state),
    };
  }
  const currentArtifacts = await videoProductionArtifacts(input.compositionDirAbs);
  if (!transactionMatches && (!state.artifacts.manifest_sha256
    || !state.artifacts.html_sha256
    || state.artifacts.manifest_sha256 !== currentArtifacts.manifest_sha256
    || state.artifacts.html_sha256 !== currentArtifacts.html_sha256)) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_NARRATION_PREPARE_STALE',
      message: 'Manifest or scaffold changed after composition.prepare. Run prepare again so narration is generated only from validated, untouched production inputs.',
    };
  }
  const htmlPath = path.join(input.compositionDirAbs, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8').catch(() => '');
  if (!html.includes('ORKAS-GENERATED-SCAFFOLD') && !transactionMatches) {
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
      message: 'No TTS provider is configured. Configure Orkas Voice or a speech provider, then retry from scaffold_ready.',
    };
  }

  const [targetDurationSec, planIdentity] = await Promise.all([
    approvedTargetDurationSec(input.compositionDirAbs, manifest),
    videoProductionPlanIdentity(input.compositionDirAbs),
  ]);
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
      message: `${narrationFitMessage(fit)} Revise the candidate manifest, run composition.check_narration_fit until gate_b_ready=true, then open Gate B once for the fitting script.`,
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
  if (!existingOutput) {
    const now = new Date().toISOString();
    await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
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
        started_at: now,
        updated_at: now,
      };
      recordVideoProductionTransition(next, {
        op: 'composition.materialize_narration',
        status: 'started',
        turnId: input.opts.turnId,
        stage: 'scaffold_ready',
      });
    });
    const speech = await generateSpeech({
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
    if (speech.ok === false) {
      billableRequestSent = speech.requestDisposition === 'sent';
      await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
        if (next.narration_transaction?.transaction_id === transactionId) {
          next.narration_transaction.status = 'failed';
          next.narration_transaction.error_code = speech.errorCode;
          next.narration_transaction.request_disposition = speech.requestDisposition || 'sent';
          next.narration_transaction.charge_status = speech.chargeStatus || 'unknown';
          next.narration_transaction.retry_policy = speech.retryPolicy || 'unknown';
          next.narration_transaction.updated_at = new Date().toISOString();
        }
      });
      return {
        ok: false,
        op: 'composition.materialize_narration',
        errorCode: speech.errorCode,
        message: speech.message,
        billable_request_sent: billableRequestSent,
        request_disposition: speech.requestDisposition || 'sent',
        charge_status: speech.chargeStatus || 'unknown',
        retry_policy: speech.retryPolicy || 'unknown',
        ...(speech.providerErrorCode ? { provider_error_code: speech.providerErrorCode } : {}),
      };
    }
    billableRequestSent = true;
    backend = routeRef;
    bytes = speech.bytes;
    recovered = false;
  }
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
    };
  }
  const audioSha = await sha256File(outputAbsPath);
  if (!audioSha) {
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_AUDIO_MISSING',
      message: 'Narration transaction has no readable audio artifact.',
      billable_request_sent: billableRequestSent,
    };
  }
  const measuredDurationMismatch = measuredDurationSec > targetDurationSec + 0.15
    || measuredDurationSec < targetDurationSec * 0.9;
  const repairIdentity = measuredDurationMismatch
    ? await videoProductionNarrationRepairIdentity(input.compositionDirAbs)
    : undefined;
  await updateVideoProductionState(input.statePath, input.compositionDirAbs, (next) => {
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
        && next.plan_approval?.signature === planIdentity.signature) {
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
    return {
      ok: false,
      op: 'composition.materialize_narration',
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      message: `Measured narration is ${Math.round(measuredDurationSec * 1000) / 1000}s and cannot fit the approved ${targetDurationSec}s target (it may be at most 10% shorter, but cannot run longer). The synthesized audio, transaction, measured voice calibration, and bounded timing-repair authorization were preserved. Revise the script, shotlist narration, and manifest narration together to narration_fit.suggested_units, then run composition.check_narration_fit. When it returns approval_inherited=true, continue with composition.prepare without opening Gate B again.`,
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
  await writeTextAtomic(htmlPath, buildCompositionScaffold(retimedValidation.data));
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
    next.stage = advanceVideoProductionStage(next.stage, 'narration_ready');
    delete next.preview;
    delete next.draft;
    next.artifacts = { ...finalArtifacts, scaffold_html_sha256: finalArtifacts.html_sha256 };
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
    billable_request_sent: billableRequestSent,
    narration_selection: {
      route_ref: routeRef,
      voice_ref: voiceRef,
      display_name: narrationSelection.selection.displayName,
      language,
      speed: effectiveSpeed,
      legacy: narrationSelection.legacy,
    },
    production_state: summarizeVideoProductionState(updated),
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
          description: 'Operation: production.status, production.approve_plan, production.approve_generation, composition.status, composition.doctor, composition.reconcile, composition.check_narration_fit, composition.approve_plan, composition.prepare, composition.materialize_narration, composition.lint, composition.inspect, composition.begin_visual_revision, composition.snapshot, composition.approve_preview, composition.draft, composition.submit_design_review, composition.approve_draft, composition.export, speech.capabilities, or speech.transcribe.',
        },
        plan_path: { type: 'string', description: 'Canonical project/plan.json for production.* operations or AUTO child-composition Gate B inheritance.' },
        segment_id: { type: 'string', description: 'Parent EDL segment id for AUTO child-composition Gate B inheritance.' },
        composition_dir: { type: 'string', description: 'Directory containing composition-manifest.json and generated index.html; prepare may run before index.html exists.' },
        output_path: { type: 'string', description: 'Output video path for composition.draft/export, or snapshot path for composition.snapshot.' },
        report_path: { type: 'string', description: 'Optional JSON QA report path for composition.draft/export.' },
        findings_path: { type: 'string', description: 'Optional findings JSON path for composition.inspect/snapshot/draft.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality; draft uses lower fps/CRF.' },
        fps: { type: 'number', description: 'Frames per second, capped at 60.' },
        strict_render_settings: { type: 'boolean', description: 'Set true only when the user explicitly requires exact fps/render settings. Default false lets final export choose the highest safe fps without another confirmation.' },
        format: { type: 'string', enum: ['mp4', 'webm'], description: 'Output video format. Default mp4.' },
        variables: { type: 'object', description: 'Optional composition variables exposed as window.__ORKAS_VIDEO_VARIABLES__.' },
        visual_baseline_path: { type: 'string', description: 'Optional visual baseline JSON path for advisory preview/draft regression checks.' },
        update_visual_baseline: { type: 'boolean', description: 'Explicitly promote current sampled preview/draft frames to the visual baseline. Never enabled automatically.' },
        voice: { type: 'string', description: 'Legacy schema_version 1 compatibility only. New manifests must use the Gate B-signed audio.narration_intent from speech.capabilities.' },
        speed: { type: 'number', description: 'Legacy schema_version 1 compatibility only. New manifests read speed from the Gate B-signed audio.narration_intent.' },
        review_verdict: { type: 'string', enum: ['passed', 'repair', 'blocked'], description: 'Structured design-review verdict for composition.submit_design_review.' },
        review_scope: { type: 'string', description: 'What the design review inspected (contact sheet, sampled frames, hierarchy, typography, rhythm).' },
        review_findings: { type: 'array', items: { type: 'string' }, description: 'Concise visual findings or required repairs.' },
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
            invariant: 'Choose only a returned route_ref + voice_ref pair whose native_locale or verified supported_locales matches the deliverable language, and sign route_ref, voice_ref, language, display_name, and speed at Gate B. language_confidence=candidate is unavailable for non-native production until verified; mixed_language_support permits inline foreign tokens, not an unsupported narration language. Never invent or pass an ad hoc provider voice id.',
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
            if (explicitVideoStudioGateDecision(opts.userMessage, 'plan') !== 'approve') {
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
          if (explicitVideoStudioGateDecision(opts.userMessage, 'generation') !== 'approve') {
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
        const stateBefore = await readVideoProductionState(gateStatePath, compositionDirAbs);
        if (PLAN_APPROVAL_REQUIRED_OPS.has(op)) {
          const planApproval = await validatePlanApproval(
            gateStatePath,
            compositionDirAbs,
          );
          if (planApproval.ok === false) {
            return { content: `${planApproval.errorCode}: ${planApproval.message}`, isError: true } as ToolResult;
          }
        }
        if (!isVideoProductionOpAllowed(stateBefore, op)) {
          return {
            content: resultContent({
              ok: false,
              op,
              errorCode: 'E_VIDEO_PRODUCTION_STAGE_INVALID',
              message: `Operation ${op} is not allowed at production stage ${stateBefore.stage}.`,
              production_state: summarizeVideoProductionState(stateBefore),
            }),
            isError: true,
          } as ToolResult;
        }
        if (op === 'composition.status') {
          const [planIdentity, currentArtifacts, repairState] = await Promise.all([
            videoProductionPlanIdentity(compositionDirAbs),
            videoProductionArtifacts(compositionDirAbs),
            videoStudioRepairSummary(opts, compositionDirAbs),
          ]);
          const artifactDrift = !!stateBefore.artifacts.composition_signature
            && stateBefore.artifacts.composition_signature !== currentArtifacts.composition_signature;
          return {
            content: resultContent({
              ok: true,
              op,
              status: 'reported',
              artifact_drift: artifactDrift,
              reconciliation_required: artifactDrift
                || !!stateBefore.narration_transaction
                || !!stateBefore.active_operation,
              plan_artifacts_present: planIdentity.applicable,
              plan_artifacts_complete: planIdentity.complete,
              plan_requirement_issues: planIdentity.requirementIssues,
              plan_approval_current: !!stateBefore.plan_approval
                && stateBefore.plan_approval.signature === planIdentity.signature,
              inspector_version: VIDEO_STUDIO_INSPECTOR_VERSION,
              visual_qa_cycle_stale: !!legacyVisualQaCycle(stateBefore.visual_qa)
                && !currentVisualQaCycle(stateBefore.visual_qa),
              repair_state: repairState,
              production_state: summarizeVideoProductionState(stateBefore),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.begin_visual_revision') {
          if (!opts.turnId || explicitVideoStudioVisualRecoveryDecision(opts.userMessage) !== 'new_visual_revision') {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED',
                message: 'A new visual revision can start only in the real user turn that submitted visual_recovery_decision=new_visual_revision.',
                recovery_form: {
                  field_id: 'visual_recovery_decision',
                  approve_value: 'new_visual_revision',
                },
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
                visual_repair_cycle: visualQaRepairSummary(legacyVisualQaCycle(stateBefore.visual_qa)),
              }),
              isError: true,
            } as ToolResult;
          }
          if (stateBefore.stage === 'draft_approved' || stateBefore.stage === 'exported') {
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_VISUAL_REVISION_STAGE_INVALID',
                message: `A visual QA recovery revision cannot start from ${stateBefore.stage}; use the signed follow-up edit workflow.`,
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
          result.production_state = summarizeVideoProductionState(checkedState);
          return { content: resultContent(result), isError: result.ok !== true } as ToolResult;
        }
        if (op === 'composition.reconcile') {
          const result = await reconcileVideoProduction({
            compositionDirAbs,
            statePath: gateStatePath,
            turnId: opts.turnId,
          });
          if (result.ok) await notifyWritten(opts, [result.html_path]);
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
          const identity = await videoProductionPlanIdentity(compositionDirAbs);
          if (!identity.complete) {
            return {
              content: 'E_NARRATION_FIT_ARTIFACTS_INCOMPLETE: write project/script.md, project/shotlist.json, and the candidate composition-manifest.json before checking narration fit.',
              isError: true,
            } as ToolResult;
          }
          if (identity.requirementIssues.length > 0) {
            return {
              content: `E_GATE_B_REQUIREMENTS_INCOMPLETE: Gate B shotlist must declare target duration, language, audio, captions, and music. Missing: ${identity.requirementIssues.join(', ')}.`,
              isError: true,
            } as ToolResult;
          }
          let manifest: CompositionManifest;
          try {
            manifest = CompositionManifestSchema.parse(JSON.parse(
              await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8'),
            ));
          } catch (err) {
            return {
              content: `E_COMPOSITION_MANIFEST_INVALID: ${(err as Error).message}`,
              isError: true,
            } as ToolResult;
          }
          const text = compositionNarrationText(manifest);
          if (!text) {
            return {
              content: 'E_NARRATION_TEXT_MISSING: add the complete candidate narration_text to manifest scenes before checking Gate B fit.',
              isError: true,
            } as ToolResult;
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
            targetDurationSec: await approvedTargetDurationSec(compositionDirAbs, manifest),
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
          const repairIdentity = stateBefore.narration_repair
            ? await videoProductionNarrationRepairIdentity(compositionDirAbs)
            : undefined;
          const repairAssessment = assessNarrationRepair({
            authorization: stateBefore.narration_repair,
            identity: repairIdentity,
            fit,
            state: stateBefore,
          });
          const approvalInherited = repairAssessment.status === 'inheritable';
          const repairBudgetExhausted = repairAssessment.reason === 'repair_check_budget_exhausted';
          const gateBRequired = repairAssessment.status === 'none'
            || (repairAssessment.status === 'rejected' && !repairBudgetExhausted);
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
              next.plan_approval = {
                gate: 'B',
                signature: identity.signature,
                turn_id: authorization.approval_turn_id,
                approved_at: authorization.approval_at,
                artifact_paths: identity.artifactPaths,
                inherited_from_signature: authorization.approval_signature,
                inherited_at: new Date().toISOString(),
                inheritance_reason: 'measured_narration_fit_repair',
                validation_version: 1,
              };
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
          const message = approvalInherited
            ? `${narrationFitMessage(fit)} The existing Gate B approval was inherited for this bounded measured-duration repair. Do not open Gate B again; run composition.prepare next.`
            : repairAssessment.status === 'pending'
              ? `${narrationFitMessage(fit)} This remains an authorized internal timing repair. Revise once more and recheck without opening Gate B.`
              : repairBudgetExhausted
                ? `${narrationFitMessage(fit)} The bounded timing-repair check budget is exhausted. Report this deterministic blocker instead of reopening Gate B or sending another speech request.`
                : repairAssessment.status === 'rejected'
                  ? `${narrationFitMessage(fit)} The change is outside the timing-only repair authorization (${repairAssessment.reason}); a new Gate B approval is required for the changed plan.`
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
                : repairAssessment.status === 'pending'
                  ? 'revise_narration_then_composition.check_narration_fit'
                  : repairBudgetExhausted
                    ? 'report_narration_fit_blocker'
                    : fit.status === 'fits'
                      ? 'open_gate_b'
                      : 'revise_narration_then_composition.check_narration_fit',
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
              production_state: summarizeVideoProductionState(checked),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.approve_plan') {
          const identity = await videoProductionPlanIdentity(compositionDirAbs);
          if (!identity.complete) {
            return {
              content: 'E_GATE_B_ARTIFACTS_INCOMPLETE: Gate B approval requires project/script.md, project/shotlist.json, and composition/composition-manifest.json.',
              isError: true,
            } as ToolResult;
          }
          if (identity.requirementIssues.length > 0) {
            return {
              content: `E_GATE_B_REQUIREMENTS_INCOMPLETE: Gate B shotlist must declare target duration, language, audio, captions, and music. Missing: ${identity.requirementIssues.join(', ')}.`,
              isError: true,
            } as ToolResult;
          }
          const parentPlanRaw = String(input.plan_path || '').trim();
          const parentSegmentId = String(input.segment_id || '').trim();
          let inheritedParent: {
            signature: string;
            turnId: string;
            approvedAt: string;
            planPath: string;
            segmentId: string;
          } | undefined;
          if (parentPlanRaw || parentSegmentId) {
            if (!parentPlanRaw || !parentSegmentId) {
              return { content: 'E_PARENT_COMPOSITION_BINDING_INCOMPLETE: plan_path and segment_id are both required for AUTO Gate B inheritance.', isError: true } as ToolResult;
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
            if (explicitVideoStudioGateDecision(
              opts.userMessage,
              'plan',
            ) !== 'approve') {
              return {
                content: 'E_GATE_B_EXPLICIT_APPROVAL_REQUIRED: composition.approve_plan is allowed only when the current real user message explicitly approves the displayed script and shotlist.',
                isError: true,
              } as ToolResult;
            }
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
              targetDurationSec: await approvedTargetDurationSec(compositionDirAbs, manifest),
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
            return {
              content: resultContent({
                ok: false,
                op,
                errorCode: 'E_GATE_B_NARRATION_FIT_REQUIRED',
                message: `${narrationFitMessage(approvedNarrationFit)} Revise the candidate files and run composition.check_narration_fit before reopening Gate B; do not ask the user to approve another known-unfit script.`,
                gate_b_ready: false,
                billable_request_sent: false,
                narration_fit: approvedNarrationFit,
              }),
              isError: true,
            } as ToolResult;
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
          const approved = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
            const changed = next.plan_approval?.signature !== identity.signature;
            next.plan_approval = {
              gate: 'B',
              signature: identity.signature,
              turn_id: inheritedParent?.turnId || opts.turnId!,
              approved_at: inheritedParent?.approvedAt || new Date().toISOString(),
              artifact_paths: identity.artifactPaths,
              ...(inheritedParent ? {
                inherited_from_signature: inheritedParent.signature,
                inherited_at: new Date().toISOString(),
                inheritance_reason: 'parent_edl_segment' as const,
                parent_plan_path: inheritedParent.planPath,
                parent_segment_id: inheritedParent.segmentId,
              } : {}),
              validation_version: 1,
            };
            if (approvedNarrationFit) next.narration_fit = approvedNarrationFit;
            else delete next.narration_fit;
            delete next.narration_repair;
            if (changed) {
              delete next.preview;
              delete next.draft;
              delete next.visual_qa;
              if (!narrationTextStillCurrent || !narrationSelectionStillCurrent) {
                delete next.narration;
                delete next.narration_transaction;
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
                next_action: 'composition.doctor',
              } : {}),
              production_state: summarizeVideoProductionState(approved),
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
                  production_state: summarizeVideoProductionState(checkedState),
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
          if ((stateBefore.draft?.design_review?.status === 'repair' || stateBefore.draft?.design_review?.status === 'blocked')
            && verdict === 'passed') {
            return {
              content: 'E_DESIGN_REVIEW_REPAIR_REQUIRED: a repair/blocked verdict is signature-bound. Change the composition, run composition.reconcile, and render a new draft before submitting a passed review.',
              isError: true,
            } as ToolResult;
          }
          const draftEntry = stateBefore.draft;
          const draftSignatureCheck = draftEntry
            ? await checkVideoStudioGateSignature(compositionDirAbs, draftEntry)
            : undefined;
          if (!draftEntry || draftSignatureCheck?.matches !== true) {
            return { content: 'E_DESIGN_REVIEW_DRAFT_STALE: render a new draft before reviewing changed composition inputs.', isError: true } as ToolResult;
          }
          const signature = draftEntry.signature;
          let reviewed: VideoProductionStateV1;
          try {
            reviewed = await updateVideoProductionState(gateStatePath, compositionDirAbs, (next) => {
              if (!next.draft || next.draft.signature !== signature) {
                throw new Error('E_DESIGN_REVIEW_DRAFT_STALE: render a new draft before reviewing changed composition inputs.');
              }
              next.draft.design_review = {
                required: true,
                status: verdict,
                reviewed_at: new Date().toISOString(),
                verdict,
                scope,
                findings,
              };
              recordVideoProductionTransition(next, {
                op,
                status: 'passed',
                turnId: opts.turnId,
                stage: 'draft_ready',
              });
            });
          } catch (err) {
            return { content: (err as Error).message, isError: true } as ToolResult;
          }
          return {
            content: resultContent({
              ok: true,
              op,
              status: verdict,
              gate_d_ready: verdict === 'passed',
              next_action: verdict === 'passed' ? 'composition.approve_draft' : 'repair_visuals_then_composition.reconcile',
              production_state: summarizeVideoProductionState(reviewed),
            }),
            isError: false,
          } as ToolResult;
        }
        if (op === 'composition.approve_preview' || op === 'composition.approve_draft') {
          const kind = op === 'composition.approve_preview' ? 'preview' : 'draft';
          const explicitlyApproved = explicitVideoStudioGateDecision(
            opts.userMessage,
            kind,
          ) === 'approve';
          const approval = await approveVideoStudioGate(
            gateStatePath,
            kind,
            compositionDirAbs,
            opts.turnId || '',
            explicitlyApproved,
          );
          if (approval.ok === false) {
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
            opts,
            ctx,
          });
          if (narrationResult.ok !== true) {
            const failedState = await recordVideoStudioOperationState({
              statePath: gateStatePath,
              compositionDirAbs,
              op,
              turnId: opts.turnId,
              ok: false,
              errorCode: typeof narrationResult.errorCode === 'string' ? narrationResult.errorCode : undefined,
            });
            narrationResult.production_state = summarizeVideoProductionState(failedState);
          } else {
            await notifyWritten(opts, [
              narrationResult.path,
              narrationResult.manifest_path,
              narrationResult.html_path,
              narrationResult.narration_map_path,
            ]);
          }
          return { content: resultContent(narrationResult), isError: narrationResult.ok !== true } as ToolResult;
        }
        if (op === 'composition.draft' && await videoStudioPreviewRequired(compositionDirAbs)) {
          const gate = await validateVideoStudioGate(gateStatePath, 'preview', compositionDirAbs, opts.turnId || '');
          if (gate.ok === false) {
            return { content: `${gate.errorCode}: ${gate.message}`, isError: true } as ToolResult;
          }
        }
        if (op === 'composition.export') {
          const gate = await validateVideoStudioGate(gateStatePath, 'draft', compositionDirAbs, opts.turnId || '');
          if (gate.ok === false) {
            return { content: `${gate.errorCode}: ${gate.message}`, isError: true } as ToolResult;
          }
        }
        if (op === 'composition.inspect' || op === 'composition.snapshot') {
          const guarded = await guardVisualQaAttempt({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
          });
          if (guarded) return guarded;
        }
        const renderBudgetKey = `video_studio:full_render_count:${compositionDirAbs}`;
        const runScopedLedger = ctx.state.runScopedLedger instanceof Map
          ? ctx.state.runScopedLedger as Map<string, unknown>
          : new Map<string, unknown>();
        if (!(ctx.state.runScopedLedger instanceof Map)) ctx.state.runScopedLedger = runScopedLedger;
        const fullRenderCount = Number(runScopedLedger.get(renderBudgetKey) || 0);
        if ((op === 'composition.draft' || op === 'composition.export') && fullRenderCount >= 2) {
          return {
            content: 'E_FULL_RENDER_TURN_BUDGET_EXCEEDED: Two full render attempts already ran in this turn. Stop and report the blocker or wait for explicit user direction instead of rendering again.',
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
          const failedState = await recordVideoStudioOperationState({
            statePath: gateStatePath,
            compositionDirAbs,
            op,
            turnId: opts.turnId,
            ok: false,
            errorCode,
          });
          return {
            content: resultContent({
              ok: false,
              op,
              errorCode,
              message: interrupted
                ? 'The operation was interrupted. Its durable state was preserved; resume with composition.status and composition.reconcile instead of reopening Gate B or blindly rerunning.'
                : `The operation failed before a normal tool result: ${(err as Error).message || String(err)}`,
              recovery: ['composition.status', 'composition.reconcile'],
              production_state: summarizeVideoProductionState(failedState),
            }),
            isError: true,
          } as ToolResult;
        }

        if (result.ok && op === 'composition.draft') {
          const designReviewRequired = await videoStudioDesignReviewRequired(compositionDirAbs, result);
          result = {
            ...result,
            design_review_required: designReviewRequired,
            gate_d_ready: !designReviewRequired,
            next_action: designReviewRequired ? 'composition.submit_design_review' : 'open_gate_d',
          } as typeof result;
        }

        if ((op === 'composition.draft' || op === 'composition.export') && resultConsumesFullRenderTurnBudget(result)) {
          runScopedLedger.set(renderBudgetKey, fullRenderCount + 1);
        }

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
          });
        }
        result = {
          ...result,
          production_state: summarizeVideoProductionState(productionState),
        } as typeof result;

        if (result.ok) {
          await notifyWritten(opts, [
            result.path,
            result.first_frame,
            result.report_path,
            result.findings_path,
            result.manifest_path,
            result.html_path,
            result.contact_sheet,
            result.frame_paths,
            (result.visual_regression as { baseline_path?: unknown } | undefined)?.baseline_path,
          ]);
          if (op === 'composition.snapshot') {
            await publishVisibleOutputs(opts, [
              result.contact_sheet,
            ]);
          } else if (op === 'composition.draft' || op === 'composition.export') {
            await publishVisibleOutputs(opts, [
              result.path,
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
