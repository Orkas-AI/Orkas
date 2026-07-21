import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Mutex } from 'async-mutex';

import { userLocalRoot } from '../paths';

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
  turn_id: string;
  approved_at: string;
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

export type VideoProductionControlStateV1 = {
  schema_version: 1;
  revision: number;
  plan_path: string;
  plan_signature: string;
  plan_approval?: VideoProductionControlApproval;
  generation_approval?: VideoProductionGenerationApproval;
  transactions: Record<string, VideoProductionGenerationTransaction>;
  transaction_history: VideoProductionGenerationTransaction[];
  created_at: string;
  updated_at: string;
};

export type VideoProductionPlanIdentity = {
  plan_path: string;
  signature: string;
  plan: Record<string, unknown>;
  generation_intents: VideoProductionGenerationIntent[];
  intent_signature: string;
};

const mutexes = new Map<string, Mutex>();
const RUNTIME_PLAN_KEYS = new Set([
  'status',
  'produced_path',
  'provider_task_id',
  'generated_at',
  'completed_at',
  'error_code',
]);

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

function normalizedApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedApprovalValue);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (RUNTIME_PLAN_KEYS.has(key)) continue;
    normalized[key] = normalizedApprovalValue(value[key]);
  }
  return normalized;
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
    const loaded = parsed as VideoProductionControlStateV1;
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
    next.plan_path = identity.plan_path;
    next.plan_signature = identity.signature;
    next.plan_approval = {
      signature: identity.signature,
      turn_id: input.turnId,
      approved_at: approvedAt,
    };
    if (changed) {
      delete next.generation_approval;
      next.transaction_history = [
        ...next.transaction_history,
        ...Object.values(next.transactions),
      ].slice(-50);
      next.transactions = {};
    }
  });
  return { identity, state };
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
    await updateState(input.statePath, identity.plan_path, (next) => {
      next.plan_signature = identity.signature;
      delete next.plan_approval;
      delete next.generation_approval;
    });
    throw new Error('E_VIDEO_PRODUCTION_GATE_B_STALE: plan.json changed after production plan confirmation');
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
    if (input.ok) {
      transaction.completed_at = transaction.updated_at;
      if (input.outputPath) transaction.output_path = path.resolve(input.outputPath);
      if (input.providerTaskId) transaction.provider_task_id = input.providerTaskId;
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
