import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import {
  assertImageGenerationRequestId,
  beginImageStudioGeneration,
  finishImageStudioGeneration,
  imageGenerationControlStatePath,
  readImageGenerationControlState,
  summarizeImageGenerationBudget,
} from '../../features/image_production_control';
import { estimateImageProductionCredits } from '../../features/image_production_credits';
import {
  ImageWorkflowError,
  assertImageWorkflowHostConfigured,
  imageWorkflowCapabilities,
  prepareImageWorkflow,
  runImageWorkflow,
  type ImageWorkflowEngine,
} from '../../features/image_workflow_adapter';
import {
  exportImageStudioProject,
  inspectImageStudioProject,
  readImageStudioEvidenceState,
  recordRasterEvidence,
  snapshotImageStudioProject,
  submitImageStudioDesignReview,
  type ImageStudioReviewVerdict,
} from '../../features/image_studio';
import { finalizeProducedFile } from '../../features/produced_output_hooks';
import { getWorkspacePath } from '../../features/user_workspace';
import { userLocalRoot } from '../../paths';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { isPathAllowed } from '../../util/path-sandbox';
import { renderRenameSignal, uniquifyPath } from '../../util/uniquify-path';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import { IMAGE_STUDIO_AGENT_ID } from './tool-catalog';

export type ImageStudioOp =
  | 'project.status'
  | 'generation.quote'
  | 'project.inspect'
  | 'project.snapshot'
  | 'project.submit_design_review'
  | 'project.export'
  | 'workflow.capabilities'
  | 'workflow.run';

const OPS = new Set<ImageStudioOp>([
  'project.status',
  'generation.quote',
  'project.inspect',
  'project.snapshot',
  'project.submit_design_review',
  'project.export',
  'workflow.capabilities',
  'workflow.run',
]);

const DENY_MESSAGE = 'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so ImageStudio rendering and export were not run.';

export interface ImageStudioToolOpts {
  userId: string;
  cid?: string;
  agentId?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  hasProducedPath?: (absPath: string) => boolean;
}

function allowedRoots(opts: ImageStudioToolOpts): string[] {
  const roots: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try { add(getWorkspacePath(opts.userId)); } catch { /* unavailable in narrow tests */ }
  if (opts.projectId) {
    try { add(getWorkspacePath(opts.userId, opts.projectId)); } catch { /* unavailable in narrow tests */ }
  }
  if (opts.cid) {
    try { add(chatAttachmentDirForConversation(opts.userId, opts.cid)); } catch { /* unavailable in narrow tests */ }
  }
  for (const root of opts.extraRoots || []) add(root);
  return roots;
}

function resolveAbs(ctx: ToolContext, opts: ImageStudioToolOpts, raw: unknown): string {
  const value = String(raw || '').trim();
  if (path.isAbsolute(value)) return path.resolve(value);
  if (ctx.workingDir) return path.resolve(ctx.workingDir, value);
  try { return path.resolve(getWorkspacePath(opts.userId, opts.projectId), value); }
  catch { return path.resolve(value); }
}

function resolveProjectAsset(projectDirAbs: string, raw: unknown): string {
  const value = String(raw || '').trim();
  return path.resolve(path.isAbsolute(value) ? value : path.join(projectDirAbs, value));
}

function stateKey(opts: ImageStudioToolOpts, projectDirAbs: string): string {
  return crypto.createHash('sha256')
    .update(`${opts.userId}\0${path.resolve(projectDirAbs)}`)
    .digest('hex')
    .slice(0, 32);
}

export function imageStudioStatePath(opts: ImageStudioToolOpts, projectDirAbs: string): string {
  return path.join(userLocalRoot(opts.userId), 'image_studio', 'evidence', `${stateKey(opts, projectDirAbs)}.json`);
}

function jsonResult(value: Record<string, unknown>, renameNote = ''): ToolResult {
  return { content: `${JSON.stringify(value, null, 2)}${renameNote}`, isError: value.ok === false };
}

function errorCodeFromMessage(message: string): string {
  return message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || 'E_IMAGE_STUDIO_FAILED';
}

async function existingFile(absPath: string | undefined): Promise<boolean> {
  if (!absPath) return false;
  try { return (await fs.stat(absPath)).isFile(); }
  catch { return false; }
}

function nextImageStudioRecoveryOperation(input: {
  inspection: Awaited<ReturnType<typeof inspectImageStudioProject>>;
  evidenceCurrent: boolean;
  evidenceAvailable: boolean;
  reviewVerdict: ImageStudioReviewVerdict | null;
}): string {
  if (!input.inspection.ok) return 'repair_project_then_project.inspect';
  if (!input.evidenceAvailable || !input.evidenceCurrent) {
    return input.inspection.route === 'compose' || input.inspection.route === 'hybrid'
      ? 'project.snapshot'
      : 'project.inspect';
  }
  if (input.reviewVerdict === 'passed') return 'project.export';
  if (input.reviewVerdict === 'repair' || input.reviewVerdict === 'blocked') {
    return 'repair_candidate_then_reinspect';
  }
  return 'project.submit_design_review';
}

async function buildImageStudioRecoveryHandoff(input: {
  projectDirAbs: string;
  stateAbsPath: string;
  generationStateAbsPath: string;
  inspection?: Awaited<ReturnType<typeof inspectImageStudioProject>>;
  generation?: Awaited<ReturnType<typeof readImageGenerationControlState>>;
}): Promise<Record<string, unknown>> {
  const state = await readImageStudioEvidenceState(input.stateAbsPath);
  const inspection = input.inspection
    || await inspectImageStudioProject(input.projectDirAbs, state?.source_path);
  const generation = input.generation === undefined
    ? await readImageGenerationControlState(input.generationStateAbsPath)
    : input.generation;
  const maxCalls = generation?.max_calls ?? inspection.manifest?.generation_budget.max_calls ?? null;
  const usage = summarizeImageGenerationBudget(generation, maxCalls ?? 0);
  const evidenceAvailable = await existingFile(state?.evidence_path);
  const evidenceCurrent = evidenceAvailable
    && !!state
    && !!inspection.signature
    && state.signature === inspection.signature;
  const reviewCurrent = evidenceCurrent
    && !!state?.review
    && state.review.signature === state.signature
    && path.resolve(state.review.evidence_path) === path.resolve(state.evidence_path);
  const reviewVerdict = reviewCurrent ? state?.review?.verdict || null : null;
  const currentCandidate = state && evidenceAvailable ? {
    status: reviewVerdict === 'passed'
      ? 'approved'
      : evidenceCurrent ? 'current_unapproved' : 'stale_unapproved',
    path: state.evidence_path,
    media: versionedChatMediaLocalUrl(state.evidence_path),
    content_hash: state.image_hash,
    source_signature: state.signature,
    current_signature: inspection.signature || null,
    evidence_current: evidenceCurrent,
    review_current: reviewCurrent,
    review_verdict: state.review?.verdict || null,
    review_scores: state.review?.quality_scorecard || null,
    review_findings: state.review?.findings || [],
  } : null;
  return {
    current_candidate: currentCandidate,
    recovery_context: {
      inspection_ok: inspection.ok,
      inspection_blockers: inspection.blockers,
      inspection_advisories: inspection.advisories,
      evidence_available: evidenceAvailable,
      evidence_current: evidenceCurrent,
      review_current: reviewCurrent,
      review_verdict: reviewVerdict,
      generation: {
        ...usage,
        max_calls: maxCalls,
        calls_remaining: maxCalls === null ? null : usage.calls_remaining,
        budget_exhausted: maxCalls === null ? null : usage.calls_remaining === 0,
      },
      next_operation: nextImageStudioRecoveryOperation({
        inspection,
        evidenceCurrent,
        evidenceAvailable,
        reviewVerdict,
      }),
    },
  };
}

async function ensureDirectory(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isDirectory() ? null : `E_IMAGE_PROJECT_NOT_DIRECTORY: ${absPath}`;
  } catch { return `E_IMAGE_PROJECT_MISSING: ${absPath}`; }
}

function withFormatExtension(absPath: string, format: 'png' | 'jpeg'): string {
  const extension = format === 'jpeg' ? '.jpg' : '.png';
  const current = path.extname(absPath);
  if ((format === 'jpeg' && /\.jpe?g$/i.test(current)) || (format === 'png' && current.toLowerCase() === '.png')) return absPath;
  return current ? `${absPath.slice(0, -current.length)}${extension}` : `${absPath}${extension}`;
}

async function reportWritten(opts: ImageStudioToolOpts, absPath: string): Promise<void> {
  if (opts.onFileWritten) await opts.onFileWritten(absPath);
}

export function createImageStudioTool(opts: ImageStudioToolOpts): AgentTool {
  return {
    name: 'image_studio',
    description: 'Minimal ImageStudio security kernel for BYO/local provider availability quotes, local HTML/SVG capture, project inspection, host-configured image workflow execution, signature-bound visual review, and approved PNG/JPEG export. Evolving authoring and asset operations live in private skills.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [...OPS],
          description: 'Project QA/export or host-configured external workflow operation.',
        },
        project_dir: { type: 'string', description: 'Image project directory containing image-manifest.json and local assets.' },
        input_path: { type: 'string', description: 'Generated or edited project-local raster for project.inspect.' },
        output_path: { type: 'string', description: 'Snapshot, external workflow, or final export path.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Final project.export format. Defaults from output_path, otherwise PNG.' },
        evidence_path: { type: 'string', description: 'Required for project.submit_design_review: exact current evidence path returned by project.inspect or project.snapshot.' },
        review_verdict: { type: 'string', enum: ['passed', 'repair', 'blocked'], description: 'Required for project.submit_design_review and must be sent in the same call as review_scope, review_findings, and the complete quality_scores object.' },
        review_scope: { type: 'string', description: 'Required for project.submit_design_review: concise statement of what was visually inspected.' },
        review_findings: { type: 'array', items: { type: 'string' }, description: 'Required for every project.submit_design_review call. Send [] for passed; send concrete non-empty findings for repair or blocked.' },
        quality_scores: {
          type: 'object',
          description: 'Required as one complete object in every project.submit_design_review call. Include all six evidence-based 0-100 scores; reference_fidelity is additionally required when the manifest has references.',
          properties: {
            intent_alignment: { type: 'number' },
            composition: { type: 'number' },
            craft: { type: 'number' },
            text_legibility: { type: 'number' },
            defect_freedom: { type: 'number' },
            specificity: { type: 'number' },
            reference_fidelity: { type: 'number' },
          },
          required: ['intent_alignment', 'composition', 'craft', 'text_legibility', 'defect_freedom', 'specificity'],
        },
        workflow_engine: { type: 'string', enum: ['comfyui', 'invokeai', 'automatic1111', 'iopaint'], description: 'Host-configured external workflow engine. The agent cannot supply an endpoint or token.' },
        workflow_path: { type: 'string', description: 'Project-local engine request/workflow JSON. Private skills own reusable templates.' },
        output_node_id: { type: 'string', description: 'Optional engine node id whose image output should be selected.' },
        output_index: { type: 'number', description: 'Zero-based image index within the selected workflow output. Defaults to 0.' },
        timeout_ms: { type: 'number', description: 'workflow.run terminal wait timeout from 1000 to 1800000 ms.' },
        image_request_id: { type: 'string', description: 'Stable ImageStudio generation intent id. Required by workflow.run and generate_image; optional label for generation.quote.' },
        size: { type: 'string', description: 'generation.quote only: exact provider size that will be passed to generate_image.' },
        reference_count: { type: 'number', description: 'generation.quote only: number of local and URL references that will be passed to generate_image, from 0 to 4.' },
      },
      required: ['op', 'project_dir'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return { content: DENY_MESSAGE, isError: true } as ToolResult;
      if (opts.agentId !== IMAGE_STUDIO_AGENT_ID) {
        return { content: 'E_IMAGE_STUDIO_OWNER_REQUIRED: image_studio is private to ImageStudio.', isError: true } as ToolResult;
      }
      const op = String(input.op || '').trim() as ImageStudioOp;
      if (!OPS.has(op)) return { content: `op must be one of: ${[...OPS].join(', ')}`, isError: true } as ToolResult;

      const roots = allowedRoots(opts);
      const projectDirAbs = resolveAbs(ctx, opts, input.project_dir);
      if (!isPathAllowed(projectDirAbs, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: project_dir is outside scope: ${projectDirAbs}`, isError: true } as ToolResult;
      }
      const dirError = await ensureDirectory(projectDirAbs);
      if (dirError) return { content: dirError, isError: true } as ToolResult;
      const stateAbsPath = imageStudioStatePath(opts, projectDirAbs);
      const generationStateAbsPath = imageGenerationControlStatePath(opts.userId, projectDirAbs);

      try {
        if (op === 'workflow.capabilities') {
          return jsonResult({ ok: true, op, capabilities: await imageWorkflowCapabilities(ctx.signal) });
        }

        if (op === 'workflow.run') {
          const engine = String(input.workflow_engine || '').trim() as ImageWorkflowEngine;
          const workflowRaw = String(input.workflow_path || '').trim();
          const outputRaw = String(input.output_path || '').trim();
          const requestId = String(input.image_request_id || '').trim();
          if (!['comfyui', 'invokeai', 'automatic1111', 'iopaint'].includes(engine)) {
            return { content: 'workflow_engine must be comfyui, invokeai, automatic1111, or iopaint', isError: true } as ToolResult;
          }
          if (!workflowRaw || !outputRaw || !requestId) return { content: 'workflow_path, output_path, and image_request_id are required for workflow.run', isError: true } as ToolResult;
          const workflowAbs = resolveProjectAsset(projectDirAbs, workflowRaw);
          const requestedOutput = resolveProjectAsset(projectDirAbs, outputRaw);
          if (!isPathAllowed(workflowAbs, [projectDirAbs]) || !isPathAllowed(requestedOutput, [projectDirAbs])) {
            return { content: 'E_IMAGE_WORKFLOW_PATH: workflow and output must stay inside project_dir.', isError: true } as ToolResult;
          }
          const unique = await uniquifyPath(requestedOutput, (candidate) => !!opts.hasProducedPath?.(candidate));
          const prepared = await prepareImageWorkflow({
            engine,
            projectDirAbs,
            workflowAbsPath: workflowAbs,
            ...(String(input.output_node_id || '').trim() ? { outputNodeId: String(input.output_node_id).trim() } : {}),
            ...(input.output_index !== undefined ? { outputIndex: Number(input.output_index) } : {}),
          });
          assertImageWorkflowHostConfigured(engine);
          const begun = await beginImageStudioGeneration({
            stateAbsPath: generationStateAbsPath,
            projectDirAbs,
            requestId,
            outputAbsPath: unique.finalPath,
          });
          if (begun.status === 'reused') {
            const reusedPath = begun.transaction.output_path!;
            await reportWritten(opts, reusedPath);
            return jsonResult({
              ok: true,
              op,
              reused: true,
              request_id: requestId,
              output_path: reusedPath,
              media: versionedChatMediaLocalUrl(reusedPath),
              generation: { calls_started: begun.callCount, max_calls: begun.maxCalls },
              credit_quote: {
                source: 'not_applicable_reused_output',
                in_app_credits_required_milli: 0,
                new_external_charge: false,
              },
            });
          }

          ctx.emitProgress?.({ phase: 'workflow_dispatch', message: `Dispatching ${engine} image workflow` });
          try {
            const result = await runImageWorkflow({
              prepared,
              projectDirAbs,
              outputAbsPath: unique.finalPath,
              ...(input.timeout_ms !== undefined ? { timeoutMs: Number(input.timeout_ms) } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            await finishImageStudioGeneration({
              stateAbsPath: generationStateAbsPath,
              transactionId: begun.transaction.transaction_id,
              ok: true,
              outputPath: result.output_path,
            });
            await reportWritten(opts, result.output_path);
            ctx.emitProgress?.({ phase: 'workflow_complete', message: `${engine} image workflow completed` });
            return jsonResult({
              ok: true,
              op,
              request_id: requestId,
              result,
              generation: { calls_started: begun.callCount, max_calls: begun.maxCalls },
              credit_quote: {
                source: 'host_configured_external_workflow',
                in_app_credits_required_milli: 0,
                external_billing_not_estimated: true,
              },
              media: versionedChatMediaLocalUrl(result.output_path),
            }, unique.renamed ? renderRenameSignal(requestedOutput, unique.finalPath) : '');
          } catch (error) {
            const workflowError = error instanceof ImageWorkflowError ? error : null;
            const uncertain = !!workflowError?.dispatched && !workflowError.terminal;
            let generation = await readImageGenerationControlState(generationStateAbsPath);
            if (!uncertain) {
              generation = await finishImageStudioGeneration({
                stateAbsPath: generationStateAbsPath,
                transactionId: begun.transaction.transaction_id,
                ok: false,
                errorCode: workflowError?.code || 'E_IMAGE_WORKFLOW_FAILED',
                countsTowardBudget: workflowError ? workflowError.dispatched : true,
              });
            }
            const usage = summarizeImageGenerationBudget(generation, begun.maxCalls);
            const handoff = await buildImageStudioRecoveryHandoff({
              projectDirAbs,
              stateAbsPath,
              generationStateAbsPath,
              generation,
            });
            return jsonResult({
              ok: false,
              op,
              status: uncertain ? 'pending_uncertain' : 'failed',
              request_id: requestId,
              error_code: workflowError?.code || 'E_IMAGE_WORKFLOW_FAILED',
              message: (error as Error).message || String(error),
              ...(workflowError?.dispatchId ? { dispatch_id: workflowError.dispatchId } : {}),
              generation: { ...usage, max_calls: begun.maxCalls },
              next_action: uncertain ? 'Do not retry this generation intent; inspect the host queue and keep the request pending.' : 'Repair the workflow before using a new request id within the remaining budget.',
              ...handoff,
            });
          }
        }

        if (op === 'generation.quote') {
          const evidenceState = await readImageStudioEvidenceState(stateAbsPath);
          const inspection = await inspectImageStudioProject(projectDirAbs, evidenceState?.source_path);
          if (!inspection.manifest) {
            const handoff = await buildImageStudioRecoveryHandoff({
              projectDirAbs,
              stateAbsPath,
              generationStateAbsPath,
              inspection,
            });
            return jsonResult({ ok: false, op, inspection, ...handoff });
          }
          const generation = await readImageGenerationControlState(
            generationStateAbsPath,
          );
          const maxCalls = generation?.max_calls ?? inspection.manifest.generation_budget.max_calls;
          const usage = summarizeImageGenerationBudget(generation, maxCalls);
          if (usage.calls_started >= maxCalls) {
            const handoff = await buildImageStudioRecoveryHandoff({
              projectDirAbs,
              stateAbsPath,
              generationStateAbsPath,
              inspection,
              generation,
            });
            return jsonResult({
              ok: false,
              op,
              error_code: 'E_IMAGE_GENERATION_BUDGET_EXHAUSTED',
              message: 'The planned image-generation calls have been used. Keep the current candidate visible and continue any useful zero-call repair before asking the user about another paid generation.',
              generation: { ...usage, max_calls: maxCalls },
              ...handoff,
            });
          }
          const rawReferenceCount = input.reference_count === undefined
            ? inspection.manifest.references?.length || 0
            : Number(input.reference_count);
          if (!Number.isInteger(rawReferenceCount) || rawReferenceCount < 0 || rawReferenceCount > 4) {
            return { content: 'reference_count must be an integer from 0 to 4', isError: true } as ToolResult;
          }
          const requestId = String(input.image_request_id || 'next-image-generation').trim();
          assertImageGenerationRequestId(requestId);
          const size = String(input.size || '').trim();
          const quote = await estimateImageProductionCredits({
            requestId,
            ...(size ? { size } : {}),
            referenceCount: rawReferenceCount,
          }, ctx.signal);
          return jsonResult({
            ok: true,
            op,
            source: 'local_provider_configuration',
            intent: {
              request_id: requestId,
              size: size || 'provider_default',
              reference_count: rawReferenceCount,
            },
            generation: {
              ...usage,
              max_calls: maxCalls,
            },
            credit_quote: quote,
            invariant: 'Provider availability is checked again immediately before dispatch; external provider billing is not estimated in-app.',
          });
        }

        if (op === 'project.status') {
          const [state, generation] = await Promise.all([
            readImageStudioEvidenceState(stateAbsPath),
            readImageGenerationControlState(generationStateAbsPath),
          ]);
          const inspection = await inspectImageStudioProject(projectDirAbs, state?.source_path);
          const maxCalls = generation?.max_calls ?? inspection.manifest?.generation_budget.max_calls ?? null;
          const usage = summarizeImageGenerationBudget(generation, maxCalls ?? 0);
          let creditQuote: Record<string, unknown> | undefined;
          if (
            inspection.manifest
            && maxCalls !== null
            && usage.calls_remaining > 0
          ) {
            try {
              creditQuote = await estimateImageProductionCredits({
                requestId: 'project-status-next-generation',
                referenceCount: inspection.manifest.references?.length || 0,
              }, ctx.signal);
            } catch (err) {
              creditQuote = {
                status: 'unavailable',
                sufficient: false,
                error: (err as Error).message || String(err),
              };
            }
          }
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            inspection,
            generation,
          });
          return jsonResult({
            ok: inspection.ok,
            op,
            current_signature: inspection.signature || null,
            evidence_current: !!state && state.signature === inspection.signature,
            review_verdict: state?.review?.verdict || null,
            generation: {
              ...usage,
              max_calls: maxCalls,
              calls_remaining: maxCalls === null ? null : usage.calls_remaining,
            },
            ...(creditQuote ? {
              credit_quote: creditQuote,
              credit_quote_assumptions: {
                size: 'provider_default',
                reference_count: inspection.manifest?.references?.length || 0,
                note: 'Call generation.quote with exact size/reference_count before dispatch; external provider billing is not estimated in-app.',
              },
            } : {}),
            inspection,
            ...handoff,
          });
        }

        if (op === 'project.inspect') {
          const inputAbs = input.input_path ? resolveAbs(ctx, opts, input.input_path) : undefined;
          if (inputAbs && !isPathAllowed(inputAbs, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside scope: ${inputAbs}`, isError: true } as ToolResult;
          }
          const preliminary = await inspectImageStudioProject(projectDirAbs, inputAbs);
          const inspection = preliminary.route === 'generate' || preliminary.route === 'edit'
            ? await recordRasterEvidence({ projectDirAbs, rasterAbsPath: inputAbs, stateAbsPath })
            : preliminary;
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            inspection,
          });
          return jsonResult({ ok: inspection.ok, op, inspection, ...handoff });
        }

        if (op === 'project.snapshot') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required for project.snapshot', isError: true } as ToolResult;
          const requested = withFormatExtension(resolveAbs(ctx, opts, outputRaw), 'png');
          if (!isPathAllowed(requested, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requested}`, isError: true } as ToolResult;
          }
          const unique = await uniquifyPath(requested, (candidate) => !!opts.hasProducedPath?.(candidate));
          const inspection = await snapshotImageStudioProject({ projectDirAbs, outputAbsPath: unique.finalPath, stateAbsPath });
          if (inspection.ok) await reportWritten(opts, unique.finalPath);
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            inspection,
          });
          return jsonResult({
            ok: inspection.ok,
            op,
            inspection,
            ...(inspection.ok ? { media: versionedChatMediaLocalUrl(unique.finalPath) } : {}),
            ...handoff,
          }, unique.renamed ? renderRenameSignal(requested, unique.finalPath) : '');
        }

        if (op === 'project.submit_design_review') {
          const evidenceRaw = String(input.evidence_path || '').trim();
          if (!evidenceRaw) return { content: 'evidence_path is required for project.submit_design_review', isError: true } as ToolResult;
          const evidenceAbs = resolveAbs(ctx, opts, evidenceRaw);
          if (!isPathAllowed(evidenceAbs, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: evidence_path is outside scope: ${evidenceAbs}`, isError: true } as ToolResult;
          }
          const verdict = String(input.review_verdict || '') as ImageStudioReviewVerdict;
          if (!['passed', 'repair', 'blocked'].includes(verdict)) {
            return { content: 'review_verdict must be passed, repair, or blocked', isError: true } as ToolResult;
          }
          const findings = Array.isArray(input.review_findings)
            ? input.review_findings.filter((item): item is string => typeof item === 'string')
            : [];
          const state = await submitImageStudioDesignReview({
            stateAbsPath,
            evidenceAbsPath: evidenceAbs,
            verdict,
            scope: String(input.review_scope || ''),
            findings,
            qualityScores: input.quality_scores,
          });
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
          });
          return jsonResult({
            ok: true,
            op,
            status: verdict,
            review: state.review,
            next_action: verdict === 'passed' ? 'project.export' : 'repair_then_inspect',
            ...handoff,
          });
        }

        const outputRaw = String(input.output_path || '').trim();
        if (!outputRaw) return { content: 'output_path is required for project.export', isError: true } as ToolResult;
        const format: 'png' | 'jpeg' = input.format === 'jpeg' || /\.jpe?g$/i.test(outputRaw) ? 'jpeg' : 'png';
        const requested = withFormatExtension(resolveAbs(ctx, opts, outputRaw), format);
        if (!isPathAllowed(requested, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requested}`, isError: true } as ToolResult;
        }
        const unique = await uniquifyPath(requested, (candidate) => !!opts.hasProducedPath?.(candidate));
        const exported = await exportImageStudioProject({ stateAbsPath, outputAbsPath: unique.finalPath, format });
        await finalizeProducedFile(unique.finalPath, {
          userId: opts.userId,
          ...(opts.cid ? { cid: opts.cid } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          source: 'image_studio.export_pre_publish',
        });
        await reportWritten(opts, unique.finalPath);
        if (opts.onOutputsPublished) await opts.onOutputsPublished([unique.finalPath]);
        return jsonResult({
          ok: true,
          op,
          ...exported,
          media: versionedChatMediaLocalUrl(unique.finalPath),
        }, unique.renamed ? renderRenameSignal(requested, unique.finalPath) : '');
      } catch (err) {
        const message = (err as Error).message || String(err);
        let handoff: Record<string, unknown> = {};
        try {
          handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
          });
        } catch { /* retain the original failure when recovery inspection is unavailable */ }
        return jsonResult({
          ok: false,
          op,
          error_code: errorCodeFromMessage(message),
          message,
          ...handoff,
        });
      }
    },
  };
}
