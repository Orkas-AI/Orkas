import { appTaskMediaRoute } from '../../features/app_media_route';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  assertImageGenerationRequestId,
  imageGenerationControlStatePath,
  imageStudioGenerationOutputs,
  latestCompletedImageStudioGenerationOutput,
  readImageGenerationControlState,
  summarizeImageGenerationBudget,
} from '../../features/image_production_control';
import { checkImageProductionServices } from '../../features/image_production_services';
import { prepareModelImageAsset } from '../../features/image_assets';
import { registerImageStudioLayeredExport, type ImageStudioNativePngDelivery } from '../../features/image_studio_delivery';
import {
  exportImageStudioProject,
  imageStudioEvidenceIsGeneration,
  inspectImageStudioProject,
  readImageStudioEvidenceState,
  recordRasterEvidence,
  snapshotImageStudioProject,
  submitImageStudioDesignReview,
  type ImageStudioReviewVerdict,
} from '../../features/image_studio';
import { exportImageStudioDocument, imageStudioDocumentPage, inspectImageStudioDocument, readImageStudioDocument } from '../../features/image_studio_document';
import { finalizeProducedFile, producedDocumentFooterText } from '../../features/produced_output_hooks';
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
  | 'project.export';

const OPS = new Set<ImageStudioOp>([
  'project.status',
  'generation.quote',
  'project.inspect',
  'project.snapshot',
  'project.submit_design_review',
  'project.export',
]);

export interface ImageStudioToolOpts {
  userId: string;
  cid?: string;
  turnId?: string;
  agentId?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  imageStudioNativePngDelivery?: ImageStudioNativePngDelivery;
  hasProducedPath?: (absPath: string) => boolean;
}

function allowedRoots(opts: ImageStudioToolOpts): string[] {
  const roots: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try { add(getWorkspacePath(opts.userId, undefined, opts.cid)); } catch { /* unavailable in narrow tests */ }
  if (opts.projectId) {
    try { add(getWorkspacePath(opts.userId, opts.projectId, opts.cid)); } catch { /* unavailable in narrow tests */ }
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
  try { return path.resolve(getWorkspacePath(opts.userId, opts.projectId, opts.cid), value); }
  catch { return path.resolve(value); }
}

function resolveProjectAsset(projectDirAbs: string, raw: unknown): string {
  const value = String(raw || '').trim();
  return path.resolve(path.isAbsolute(value) ? value : path.join(projectDirAbs, value));
}

function stateKey(opts: ImageStudioToolOpts, projectDirAbs: string, pageId?: string): string {
  return crypto.createHash('sha256')
    .update(`${opts.userId}\0${path.resolve(projectDirAbs)}${pageId === undefined ? '' : `\0${pageId}`}`)
    .digest('hex')
    .slice(0, 32);
}

export function imageStudioStatePath(opts: ImageStudioToolOpts, projectDirAbs: string, pageId?: string): string {
  return path.join(userLocalRoot(opts.userId), 'image_studio', 'evidence', `${stateKey(opts, projectDirAbs, pageId)}.json`);
}

// Results are read by a model, not a person: compact JSON and no echo of
// the manifest it wrote itself. Pretty-printing plus the full manifest cost
// 3–8K characters per image iteration with no consumer.
function jsonResult(value: Record<string, unknown>, renameNote = ''): ToolResult {
  return { content: `${JSON.stringify(value)}${renameNote}`, isError: value.ok === false };
}

type ProjectInspection = Awaited<ReturnType<typeof inspectImageStudioProject>>;

/** The inspection minus the manifest body. Every derived fact the model acts
 *  on (route, signature, blockers, budget, reference counts) is already a
 *  sibling field; the manifest itself is the file the model authored. */
function inspectionForModel(inspection: ProjectInspection): Omit<ProjectInspection, 'manifest'> {
  const { manifest: _manifest, ...rest } = inspection;
  return rest;
}

async function jsonResultWithVisualEvidence(
  value: Record<string, unknown>,
  evidence: Array<{ absPath: string; role: string }>,
  renameNote = '',
): Promise<ToolResult> {
  if (value.ok === false) return jsonResult(value, renameNote);
  const uniqueEvidence = evidence.filter((entry, index, list) => (
    list.findIndex((candidate) => path.resolve(candidate.absPath) === path.resolve(entry.absPath)) === index
  ));
  const preparedEvidence = await Promise.all(uniqueEvidence.map(async (entry, index) => {
    const source = await fs.readFile(entry.absPath);
    let prepared = await prepareModelImageAsset(source);
    if (index > 0 && prepared.format === 'svg') {
      const { svgReferencePng } = await import('../../features/image_studio_svg_reference');
      prepared = await prepareModelImageAsset(await svgReferencePng(source));
    }
    const { buf, mediaType, width, height } = prepared;
    if (!mediaType) {
      throw new Error(`E_IMAGE_VISUAL_EVIDENCE_FORMAT: unsupported model evidence format ${prepared.format}.`);
    }
    return { entry, index, buf, mediaType, width, height };
  }));
  const candidate = preparedEvidence[0];
  if (!candidate) throw new Error('E_IMAGE_VISUAL_EVIDENCE_MISSING: no candidate image was provided.');
  const payload = {
    ...value,
    visual_evidence: {
      attached: true,
      analysis_mode: 'quality_review',
      role: 'candidate',
      path: candidate.entry.absPath,
      width: candidate.width,
      height: candidate.height,
      media_type: candidate.mediaType,
      image_count: preparedEvidence.length,
      images: preparedEvidence.map((item) => ({
        order: item.index + 1,
        role: item.entry.role,
        analysis_mode: item.index === 0 ? 'quality_review' : 'understand',
        path: item.entry.absPath,
        width: item.width,
        height: item.height,
        media_type: item.mediaType,
      })),
      policy: 'attached_only_after_deterministic_inspection_passed',
      review_gate: {
        scope: 'candidate_only',
        max_submissions_per_evidence: 1,
        recheck_requires: ['source_signature_changed', 'candidate_pixels_changed'],
        required_checks: [
          'contrast',
          'clipping',
          'overlap',
          'duplicate_text',
          'alignment',
          'placeholder_residue',
        ],
        passing_rule: 'All required candidate visual-context checks must be pass. A fail or uncertain check requires repair or another inspection before the design review can pass.',
      },
    },
  };
  return {
    content: `${JSON.stringify(payload)}${renameNote}`,
    images: preparedEvidence.map((item) => ({
      data: item.buf.toString('base64'),
      mediaType: item.mediaType,
      analysisMode: item.index === 0 ? 'quality_review' : 'understand',
    })),
  };
}

function imageStudioVisualEvidence(
  projectDirAbs: string,
  inspection: Awaited<ReturnType<typeof inspectImageStudioProject>>,
): Array<{ absPath: string; role: string }> {
  if (!inspection.evidence_path) return [];
  const references = (inspection.manifest?.references || []).map((reference) => ({
    absPath: resolveProjectAsset(projectDirAbs, reference.path),
    role: `reference:${reference.id}`,
  }));
  return [
    { absPath: inspection.evidence_path, role: 'candidate' },
    ...references,
  ];
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
  reviewRequired: boolean;
  reviewVerdict: ImageStudioReviewVerdict | null;
}): string {
  if (!input.inspection.ok) return input.inspection.source_kind === 'html'
    ? 'repair_project_then_project.snapshot'
    : 'repair_project_then_project.inspect';
  if (!input.evidenceAvailable || !input.evidenceCurrent) {
    return input.inspection.source_kind === 'html'
      ? 'project.snapshot'
      : 'project.inspect';
  }
  if (input.reviewVerdict === 'passed') return 'project.export';
  if (input.reviewVerdict === 'repair' || input.reviewVerdict === 'blocked') {
    return input.inspection.source_kind === 'html'
      ? 'repair_candidate_then_project.snapshot'
      : 'repair_candidate_then_reinspect';
  }
  if (!input.reviewRequired) return 'project.export';
  return 'project.submit_design_review';
}

/** The authored final binding outranks provider history; only an unbound
 * raster project may recover its prior candidate or latest completed output. */
async function inspectCurrentImageStudioProject(
  projectDirAbs: string,
  state: Awaited<ReturnType<typeof readImageStudioEvidenceState>>,
  generation: Awaited<ReturnType<typeof readImageGenerationControlState>>,
  turnId: string,
  explicitInput?: string,
  pageId?: string,
): Promise<ProjectInspection> {
  const inspection = await inspectImageStudioProject(projectDirAbs, explicitInput, pageId);
  if (explicitInput || !inspection.blockers.some(item => item.code === 'E_RASTER_SOURCE_REQUIRED')) return inspection;
  const fallback = state?.source_path || latestCompletedImageStudioGenerationOutput(generation, turnId);
  return fallback ? inspectImageStudioProject(projectDirAbs, fallback, pageId) : inspection;
}

async function buildImageStudioRecoveryHandoff(input: {
  projectDirAbs: string;
  stateAbsPath: string;
  generationStateAbsPath: string;
  turnId: string;
  pageId?: string;
  inspection?: Awaited<ReturnType<typeof inspectImageStudioProject>>;
  generation?: Awaited<ReturnType<typeof readImageGenerationControlState>>;
}): Promise<Record<string, unknown>> {
  const state = await readImageStudioEvidenceState(input.stateAbsPath);
  const generation = input.generation === undefined
    ? await readImageGenerationControlState(input.generationStateAbsPath)
    : input.generation;
  const inspection = input.inspection
    || await inspectCurrentImageStudioProject(input.projectDirAbs, state, generation, input.turnId, undefined, input.pageId);
  const maxCalls = generation?.max_calls ?? inspection.manifest?.generation_budget.max_calls ?? null;
  const usage = summarizeImageGenerationBudget(generation, maxCalls ?? 0, input.turnId);
  const evidenceAvailable = await existingFile(state?.evidence_path);
  const evidenceCurrent = evidenceAvailable
    && !!state
    && !!inspection.signature
    && state.signature === inspection.signature;
  const reviewRequired = !imageStudioEvidenceIsGeneration(state);
  const reviewCurrent = reviewRequired
    && evidenceCurrent
    && !!state?.review
    && state.review.signature === state.signature
    && path.resolve(state.review.evidence_path) === path.resolve(state.evidence_path);
  const reviewVerdict = reviewCurrent ? state?.review?.verdict || null : null;
  const currentCandidate = state && evidenceAvailable ? {
    status: reviewVerdict === 'passed'
      ? 'approved'
      : evidenceCurrent
        ? reviewRequired ? 'current_unapproved' : 'validated'
        : 'stale_unapproved',
    path: state.evidence_path,
    media: versionedChatMediaLocalUrl(state.evidence_path),
    content_hash: state.image_hash,
    source_signature: state.signature,
    current_signature: inspection.signature || null,
    evidence_current: evidenceCurrent,
    review_current: reviewCurrent,
    is_generation: imageStudioEvidenceIsGeneration(state),
    review_verdict: reviewRequired ? state.review?.verdict || null : null,
    review_scores: reviewRequired ? state.review?.quality_scorecard || null : null,
    review_findings: reviewRequired ? state.review?.findings || [] : [],
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
      is_generation: imageStudioEvidenceIsGeneration(state),
      review_verdict: reviewVerdict,
      generation: {
        ...usage,
        max_calls: maxCalls,
        calls_remaining: maxCalls === null ? null : usage.calls_remaining,
        budget_exhausted: maxCalls === null ? null : usage.calls_remaining === 0,
      },
      next_operation: nextImageStudioRecoveryOperation({
        inspection: inspectionForModel(inspection),
        evidenceCurrent,
        evidenceAvailable,
        reviewRequired,
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

function withFormatExtension(absPath: string, format: 'png' | 'jpeg' | 'psd' | 'pdf'): string {
  const extension = format === 'pdf' ? '.pdf' : format === 'psd' ? '.psd' : format === 'jpeg' ? '.jpg' : '.png';
  const current = path.extname(absPath);
  if ((format === 'jpeg' && /\.jpe?g$/i.test(current)) || (format === 'png' && current.toLowerCase() === '.png')) return absPath;
  return current ? `${absPath.slice(0, -current.length)}${extension}` : `${absPath}${extension}`;
}

async function reportWritten(opts: ImageStudioToolOpts, absPath: string): Promise<void> {
  if (opts.onFileWritten) await opts.onFileWritten(absPath);
}

export function createImageStudioTool(opts: ImageStudioToolOpts): AgentTool {
  const currentTurnId = String(opts.turnId || '').trim();
  return {
    name: 'image_studio',
    description: 'Inspect, review, and export ImageStudio projects; check configured image services and capture local HTML/SVG.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [...OPS],
          description: 'Project QA, export, or generation operation.',
        },
        project_dir: { type: 'string', description: 'Absolute or workspace-relative folder containing image-manifest.json. Paths inside the manifest are relative to this folder.' },
        page_id: { type: 'string', description: 'Version 2 documents only: stable page id for inspect, snapshot, review or export. Omit for whole-document status/inspection or PDF export. Single-page projects omit this.' },
        input_path: { type: 'string', description: 'Absolute or workspace-relative file inside project_dir. For raster inspection, omit to use the project raster binding or current evidence, or pass a raster image. HTML inspection uses the manifest entry. For PSD export, pass the verified PSD candidate.' },
        output_path: { type: 'string', description: 'Absolute or workspace-relative snapshot or export path.' },
        format: { type: 'string', enum: ['png', 'jpeg', 'psd', 'pdf'], description: 'Defaults from output_path, otherwise PNG. PSD preserves its candidate bytes after current native PNG export. PDF prints the manifest HTML entry at canvas size; wrap standalone SVG in local HTML. Photos/effects may stay raster. Scored review is only for non-generation evidence.' },
        evidence_path: { type: 'string', description: 'Required for project.submit_design_review: exact current evidence path returned by project.inspect or project.snapshot.' },
        review_verdict: { type: 'string', enum: ['passed', 'repair', 'blocked'], description: 'For project.submit_design_review; send in the same call as review_scope, review_findings, and complete quality_scores. One submission per exact evidence; retry requires changed source signature and rendered pixels.' },
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
        additional_dimensions: {
          type: 'array',
          maxItems: 8,
          description: 'Optional open-ended task-specific review dimensions beyond mandatory scores. Each needs id, label, reason, visual evidence, and a 0-100 score; all must meet the native pass floor and cannot raise mandatory overall.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
              label: { type: 'string', maxLength: 120 },
              reason: { type: 'string', maxLength: 500 },
              evidence: { type: 'string', maxLength: 1000 },
              score: { type: 'number', minimum: 0, maximum: 100 },
            },
            required: ['id', 'label', 'reason', 'evidence', 'score'],
            additionalProperties: false,
          },
        },
        size: { type: 'string', description: 'generation.quote only: exact provider size that will be passed to generate_image.' },
        reference_count: { type: 'number', description: 'generation.quote only: number of local and URL references that will be passed to generate_image, from 0 to 4.' },
      },
      required: ['op', 'project_dir'],
    },
    async execute(input, ctx) {
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
      const pageId = typeof input.page_id === 'string' ? input.page_id : undefined;
      const stateAbsPath = imageStudioStatePath(opts, projectDirAbs, pageId);
      let document: Awaited<ReturnType<typeof readImageStudioDocument>>;
      const generationStateAbsPath = imageGenerationControlStatePath(opts.userId, projectDirAbs);

      try {
        if (input.page_id !== undefined && (!pageId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(pageId)))
          throw new Error('E_IMAGE_DOCUMENT_PAGE_ID: page_id must be a stable document page identifier.');
        document = await readImageStudioDocument(projectDirAbs);
        if (pageId !== undefined) {
          if (!document) throw new Error('E_IMAGE_DOCUMENT_PAGE_UNEXPECTED: single-page projects omit page_id.');
          imageStudioDocumentPage(document, pageId);
          if (op === 'generation.quote')
            throw new Error('E_IMAGE_DOCUMENT_PAGE_UNEXPECTED: page_id selects project QA and export operations only.');
        }
        if (document && !pageId && (op === 'project.status' || op === 'project.inspect')) {
          const inventory = await inspectImageStudioDocument(projectDirAbs, id => imageStudioStatePath(opts, projectDirAbs, id));
          return jsonResult({ ok: inventory.ok, op, document: inventory });
        }
        if (document && op === 'generation.quote')
          throw new Error('E_IMAGE_DOCUMENT_ROUTE: fixed-page documents use local sources and no generation calls.');
        const wholeDocumentPdf = document && !pageId && op === 'project.export'
          && (input.format === 'pdf' || (!input.format && /\.pdf$/i.test(String(input.output_path || ''))));
        if (document && !pageId && !wholeDocumentPdf)
          throw new Error('E_IMAGE_DOCUMENT_PAGE_REQUIRED: select page_id from project.status for this operation.');
        if (op === 'generation.quote') {
          const evidenceState = await readImageStudioEvidenceState(stateAbsPath);
          const inspection = await inspectImageStudioProject(projectDirAbs, evidenceState?.source_path);
          if (!inspection.manifest) {
            const handoff = await buildImageStudioRecoveryHandoff({
              projectDirAbs,
              stateAbsPath,
              generationStateAbsPath,
              turnId: currentTurnId,
              pageId,
              inspection: inspectionForModel(inspection),
            });
            return jsonResult({ ok: false, op, inspection, ...handoff });
          }
          const generation = await readImageGenerationControlState(
            generationStateAbsPath,
          );
          const maxCalls = generation?.max_calls ?? inspection.manifest.generation_budget.max_calls;
          const usage = summarizeImageGenerationBudget(generation, maxCalls, currentTurnId);
          if (usage.calls_started >= maxCalls) {
            const handoff = await buildImageStudioRecoveryHandoff({
              projectDirAbs,
              stateAbsPath,
              generationStateAbsPath,
              turnId: currentTurnId,
              pageId,
              inspection: inspectionForModel(inspection),
              generation,
            });
            return jsonResult({
              ok: false,
              op,
              error_code: 'E_IMAGE_GENERATION_BUDGET_EXHAUSTED',
              message: 'The planned image-generation calls for the current user turn have been used. Keep the current candidate visible, continue any useful zero-call repair, and then end this turn. Do not request a quota-increase form or raise manifest max_calls; a later direct user message receives a fresh turn allowance.',
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
          const imageProfileId=await appTaskMediaRoute(opts.userId,opts.cid,'image',ctx.signal);
          const quote = await checkImageProductionServices({
            ...(imageProfileId?{profileId:imageProfileId}:{}),
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
            service_availability: quote,
            invariant: 'Provider availability is checked again immediately before dispatch; external provider billing is not estimated in-app.',
          });
        }

        if (op === 'project.status') {
          const [state, generation] = await Promise.all([
            readImageStudioEvidenceState(stateAbsPath),
            readImageGenerationControlState(generationStateAbsPath),
          ]);
          const inspection = await inspectCurrentImageStudioProject(projectDirAbs, state, generation, currentTurnId, undefined, pageId);
          const maxCalls = generation?.max_calls ?? inspection.manifest?.generation_budget.max_calls ?? null;
          const usage = summarizeImageGenerationBudget(generation, maxCalls ?? 0, currentTurnId);
          let serviceAvailability: Record<string, unknown> | undefined;
          if (
            inspection.manifest
            && maxCalls !== null
            && usage.calls_remaining > 0
          ) {
            try {
              const imageProfileId=await appTaskMediaRoute(opts.userId,opts.cid,'image',ctx.signal);
              serviceAvailability = await checkImageProductionServices({
                ...(imageProfileId?{profileId:imageProfileId}:{}),
                requestId: 'project-status-next-generation',
                referenceCount: inspection.manifest.references?.length || 0,
              }, ctx.signal);
            } catch (err) {
              serviceAvailability = {
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
            turnId: currentTurnId,
            pageId,
            inspection: inspectionForModel(inspection),
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
            ...(serviceAvailability ? {
              service_availability: serviceAvailability,
              service_availability_assumptions: {
                size: 'provider_default',
                reference_count: inspection.manifest?.references?.length || 0,
                note: 'Call generation.quote with exact size/reference_count before dispatch; external provider billing is not estimated in-app.',
              },
            } : {}),
            inspection: inspectionForModel(inspection),
            ...handoff,
          });
        }

        if (op === 'project.inspect') {
          const explicitInputAbs = input.input_path ? resolveAbs(ctx, opts, input.input_path) : undefined;
          if (explicitInputAbs && !isPathAllowed(explicitInputAbs, roots)) {
            // Inspection only reads inside the image project, so a file from elsewhere is copied
            // in first, by tools that follow the user's access setting.
            return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside this conversation's files: ${explicitInputAbs}. Copy it into the image project first, then inspect it there.`, isError: true } as ToolResult;
          }
          const generation = await readImageGenerationControlState(generationStateAbsPath);
          const state = await readImageStudioEvidenceState(stateAbsPath);
          const preliminary = await inspectCurrentImageStudioProject(projectDirAbs, state, generation, currentTurnId, explicitInputAbs, pageId);
          const inspection = preliminary.source_kind === 'raster'
            ? await recordRasterEvidence({ projectDirAbs, rasterAbsPath: preliminary.source_path, stateAbsPath, generationOutputs: imageStudioGenerationOutputs(generation) })
            : preliminary;
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            turnId: currentTurnId,
            pageId,
            inspection: inspectionForModel(inspection),
            generation,
          });
          const result = { ok: inspection.ok, op, inspection: inspectionForModel(inspection), ...handoff };
          if (inspection.ok && inspection.evidence_path && inspection.is_generation === false) {
            return await jsonResultWithVisualEvidence(result, imageStudioVisualEvidence(projectDirAbs, inspection));
          }
          return jsonResult(result);
        }

        if (op === 'project.snapshot') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required for project.snapshot', isError: true } as ToolResult;
          const requested = withFormatExtension(resolveAbs(ctx, opts, outputRaw), 'png');
          if (!isPathAllowed(requested, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requested}`, isError: true } as ToolResult;
          }
          const unique = await uniquifyPath(requested, (candidate) => !!opts.hasProducedPath?.(candidate));
          const inspection = await snapshotImageStudioProject({ projectDirAbs, outputAbsPath: unique.finalPath, stateAbsPath, pageId });
          if (inspection.ok) await reportWritten(opts, unique.finalPath);
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            turnId: currentTurnId,
            pageId,
            inspection: inspectionForModel(inspection),
          });
          const result = {
            ok: inspection.ok,
            op,
            inspection: inspectionForModel(inspection),
            ...(inspection.ok ? { media: versionedChatMediaLocalUrl(unique.finalPath) } : {}),
            ...handoff,
          };
          if (inspection.ok && inspection.evidence_path) {
            return await jsonResultWithVisualEvidence(
              result,
              imageStudioVisualEvidence(projectDirAbs, inspection),
              unique.renamed ? renderRenameSignal(requested, unique.finalPath) : '',
            );
          }
          return jsonResult(
            result,
            unique.renamed ? renderRenameSignal(requested, unique.finalPath) : '',
          );
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
            additionalDimensions: input.additional_dimensions,
          });
          const handoff = await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            turnId: currentTurnId,
            pageId,
          });
          return jsonResult({
            ok: true,
            op,
            status: verdict,
            review: state.review,
            next_action: verdict === 'passed' ? 'project.export'
              : state.source_kind === 'html' ? 'repair_then_snapshot' : 'repair_then_inspect',
            ...handoff,
          });
        }

        const outputRaw = String(input.output_path || '').trim();
        if (!outputRaw) return { content: 'output_path is required for project.export', isError: true } as ToolResult;
        const format = input.format === 'pdf' || (!input.format && /\.pdf$/i.test(outputRaw)) ? 'pdf' : input.format === 'psd' || /\.psd$/i.test(outputRaw) ? 'psd' : input.format === 'jpeg' || /\.jpe?g$/i.test(outputRaw) ? 'jpeg' : 'png';
        const requested = withFormatExtension(resolveAbs(ctx, opts, outputRaw), format);
        if (!isPathAllowed(requested, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requested}`, isError: true } as ToolResult;
        }
        // Ownership is deliberately *not* consulted here. `project.export` is the
        // delivery gate: each export is a finished artefact the user has already
        // been shown, not scratch space. The conversation-scoped
        // `hasProducedPath` used by snapshot treats "produced this
        // turn or earlier" as a refinement and overwrites in place, so a revision
        // requested in a *later* turn would silently replace the version already
        // attached to an earlier chat message. `() => false` keeps every revision
        // on disk as `-2 / -3 / ...` and makes uniquify emit `<file-renamed>` so
        // the model can tell the user where the new version landed. Same reasoning
        // as the document export in `office-tools.ts`.
        const unique = await uniquifyPath(requested, () => false);
        const inputAbsPath = input.input_path ? resolveAbs(ctx, opts, input.input_path) : undefined;
        if (format === 'psd' && (!inputAbsPath || !isPathAllowed(inputAbsPath, [projectDirAbs]))) {
          return { content: 'E_IMAGE_PSD_INPUT_REQUIRED: input_path must name a project-local PSD candidate.', isError: true } as ToolResult;
        }
        const finalizeOutput = async (absPath: string) => finalizeProducedFile(absPath, {
          userId: opts.userId,
          ...(opts.cid ? { cid: opts.cid } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          source: 'image_studio.export_pre_publish',
        });
        const footerText = format === 'pdf'
          ? producedDocumentFooterText({ userId: opts.userId, cid: opts.cid, projectId: opts.projectId }) || undefined : undefined;
        const nativePngDelivery = opts.imageStudioNativePngDelivery;
        let verifiedPngVersion: string | undefined;
        const exported = wholeDocumentPdf
          ? await exportImageStudioDocument({ projectDir: projectDirAbs,
            statePath: id => imageStudioStatePath(opts, projectDirAbs, id),
            outputAbsPath: unique.finalPath, scratchDir: path.join(userLocalRoot(opts.userId), 'image_studio', 'temporary'),
            footerText, signal: ctx.signal, finalizeOutput })
          : await exportImageStudioProject({ stateAbsPath, outputAbsPath: unique.finalPath, format, inputAbsPath,
            footerText, signal: ctx.signal, finalizeOutput,
            ...(nativePngDelivery ? { onVerifiedPng: (_file, version) => { verifiedPngVersion = version; } } : {}),
          });
        if (opts.cid && (format === 'png' || format === 'psd')) {
          await registerImageStudioLayeredExport(opts.userId, opts.cid, unique.finalPath);
        }
        await reportWritten(opts, unique.finalPath);
        if (verifiedPngVersion) nativePngDelivery?.record(unique.finalPath, verifiedPngVersion);
        if (opts.onOutputsPublished) await opts.onOutputsPublished([unique.finalPath]);
        return jsonResult({
          ok: true,
          op,
          ...exported,
          ...(pageId ? { page_id: pageId } : {}),
          format,
          ...(['psd', 'pdf'].includes(format) ? {} : { media: versionedChatMediaLocalUrl(unique.finalPath) }),
        }, unique.renamed ? renderRenameSignal(requested, unique.finalPath) : '');
      } catch (err) {
        const message = (err as Error).message || String(err);
        let handoff: Record<string, unknown> = {};
        try {
          handoff = document && !pageId
            ? { document: await inspectImageStudioDocument(projectDirAbs, id => imageStudioStatePath(opts, projectDirAbs, id)) }
            : await buildImageStudioRecoveryHandoff({
            projectDirAbs,
            stateAbsPath,
            generationStateAbsPath,
            turnId: currentTurnId,
            pageId,
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
