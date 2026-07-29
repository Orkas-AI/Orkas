import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalRoot } from '../paths';
import { fileEditLock } from '../util/locks';
import { isPathAllowed } from '../util/path-sandbox';
import { validateImageStudioManifest, type ImageStudioRoute } from './image_studio';

export interface ImageGenerationTransaction {
  transaction_id: string;
  request_id: string;
  status: 'pending' | 'completed' | 'failed';
  /**
   * Missing means counted for compatibility with existing fail-closed state.
   * A definite pre-dispatch failure remains auditable but does not consume a
   * generation slot.
   */
  budget_effect?: 'counted' | 'not_counted';
  planned_output_path: string;
  output_path?: string;
  error_code?: string;
  started_at: string;
  finished_at?: string;
}

export interface ImageGenerationControlState {
  schema_version: 1;
  project_dir: string;
  route: ImageStudioRoute;
  max_calls: number;
  transactions: ImageGenerationTransaction[];
  updated_at: string;
}

export interface ImageGenerationBudgetUsage {
  attempts_recorded: number;
  calls_started: number;
  calls_remaining: number;
  pre_dispatch_failures: number;
  pending: number;
  completed: number;
  failed: number;
}

export function imageGenerationCountsTowardBudget(transaction: ImageGenerationTransaction): boolean {
  return transaction.budget_effect !== 'not_counted';
}

export function summarizeImageGenerationBudget(
  state: ImageGenerationControlState | null,
  maxCalls: number,
): ImageGenerationBudgetUsage {
  const transactions = state?.transactions || [];
  const counted = transactions.filter(imageGenerationCountsTowardBudget);
  return {
    attempts_recorded: transactions.length,
    calls_started: counted.length,
    calls_remaining: Math.max(0, maxCalls - counted.length),
    pre_dispatch_failures: transactions.length - counted.length,
    pending: counted.filter((item) => item.status === 'pending').length,
    completed: counted.filter((item) => item.status === 'completed').length,
    failed: counted.filter((item) => item.status === 'failed').length,
  };
}

export function imageGenerationControlStatePath(userId: string, projectDirAbs: string): string {
  const key = crypto.createHash('sha256')
    .update(`${userId}\0${path.resolve(projectDirAbs)}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(userLocalRoot(userId), 'image_studio', 'generation', `${key}.json`);
}

export async function readImageGenerationControlState(stateAbsPath: string): Promise<ImageGenerationControlState | null> {
  try {
    const value = JSON.parse(await fs.readFile(stateAbsPath, 'utf8')) as ImageGenerationControlState;
    return value?.schema_version === 1 && Array.isArray(value.transactions) ? value : null;
  } catch { return null; }
}

export function assertImageGenerationRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(requestId)) {
    throw new Error('E_IMAGE_GENERATION_REQUEST_ID_INVALID: image_request_id must be 1-80 safe identifier characters.');
  }
}

/**
 * Resolve an already-used request before a network credit quote. Completed
 * outputs may be reused without a new provider call or a fresh balance check;
 * pending/failed ids remain fail-closed exactly as `begin` enforces.
 */
export async function findReusableImageStudioGeneration(
  stateAbsPath: string,
  requestId: string,
): Promise<ImageGenerationTransaction | null> {
  assertImageGenerationRequestId(requestId);
  const state = await readImageGenerationControlState(stateAbsPath);
  const existing = state?.transactions.find((item) => item.request_id === requestId);
  if (!existing) return null;
  if (existing.status === 'completed' && existing.output_path) {
    try {
      if ((await fs.stat(existing.output_path)).isFile()) return existing;
    } catch { /* completed output disappeared; fail closed below */ }
  }
  throw new Error(`E_IMAGE_GENERATION_REQUEST_ALREADY_USED: ${requestId} is ${existing.status}; use its completed output or a new request id within the remaining budget.`);
}

async function writeState(stateAbsPath: string, state: ImageGenerationControlState): Promise<void> {
  await fs.mkdir(path.dirname(stateAbsPath), { recursive: true });
  const tmp = `${stateAbsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, stateAbsPath);
}

async function readBudget(projectDirAbs: string): Promise<{ route: ImageStudioRoute; maxCalls: number }> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(path.join(projectDirAbs, 'image-manifest.json'), 'utf8')); }
  catch { throw new Error('E_IMAGE_GENERATION_MANIFEST_REQUIRED: a valid image-manifest.json is required before generation.'); }
  const validation = validateImageStudioManifest(parsed);
  if (!validation.manifest) {
    throw new Error(`E_IMAGE_GENERATION_MANIFEST_INVALID: ${validation.issues.map((issue) => issue.message).join(' ')}`);
  }
  return {
    route: validation.manifest.route,
    maxCalls: validation.manifest.generation_budget.max_calls,
  };
}

export async function beginImageStudioGeneration(input: {
  stateAbsPath: string;
  projectDirAbs: string;
  requestId: string;
  outputAbsPath: string;
}): Promise<{ status: 'started' | 'reused'; transaction: ImageGenerationTransaction; callCount: number; maxCalls: number }> {
  return fileEditLock(path.resolve(input.stateAbsPath)).runExclusive(async () => {
    const projectDirAbs = path.resolve(input.projectDirAbs);
    assertImageGenerationRequestId(input.requestId);
    if (!isPathAllowed(path.resolve(input.outputAbsPath), [projectDirAbs])) {
      throw new Error('E_IMAGE_GENERATION_OUTPUT_OUTSIDE_PROJECT: ImageStudio generation output must stay inside image_project_path.');
    }
    const budget = await readBudget(projectDirAbs);
    const now = new Date().toISOString();
    const prior = await readImageGenerationControlState(input.stateAbsPath);
    const state: ImageGenerationControlState = prior || {
      schema_version: 1,
      project_dir: projectDirAbs,
      route: budget.route,
      max_calls: budget.maxCalls,
      transactions: [],
      updated_at: now,
    };
    state.project_dir = projectDirAbs;
    state.route = budget.route;
    state.max_calls = budget.maxCalls;
    const usage = summarizeImageGenerationBudget(state, budget.maxCalls);

    const existing = state.transactions.find((item) => item.request_id === input.requestId);
    if (existing) {
      if (existing.status === 'completed' && existing.output_path) {
        try {
          if ((await fs.stat(existing.output_path)).isFile()) {
            return { status: 'reused', transaction: existing, callCount: usage.calls_started, maxCalls: budget.maxCalls };
          }
        } catch { /* completed output disappeared; fail closed below */ }
      }
      throw new Error(`E_IMAGE_GENERATION_REQUEST_ALREADY_USED: ${input.requestId} is ${existing.status}; use its completed output or a new request id within the remaining budget.`);
    }
    if (usage.calls_started >= budget.maxCalls) {
      throw new Error(`E_IMAGE_GENERATION_BUDGET_EXHAUSTED: ${budget.route.toUpperCase()} allows ${budget.maxCalls} image-generation call(s), and ${usage.calls_started} dispatched or uncertain call(s) count toward the budget.`);
    }
    const transaction: ImageGenerationTransaction = {
      transaction_id: crypto.randomUUID(),
      request_id: input.requestId,
      status: 'pending',
      planned_output_path: path.resolve(input.outputAbsPath),
      started_at: now,
    };
    state.transactions.push(transaction);
    state.updated_at = now;
    await writeState(input.stateAbsPath, state);
    return {
      status: 'started',
      transaction,
      callCount: summarizeImageGenerationBudget(state, budget.maxCalls).calls_started,
      maxCalls: budget.maxCalls,
    };
  });
}

export async function finishImageStudioGeneration(input: {
  stateAbsPath: string;
  transactionId: string;
  ok: boolean;
  outputPath?: string;
  errorCode?: string;
  countsTowardBudget?: boolean;
}): Promise<ImageGenerationControlState> {
  return fileEditLock(path.resolve(input.stateAbsPath)).runExclusive(async () => {
    const state = await readImageGenerationControlState(input.stateAbsPath);
    if (!state) throw new Error('E_IMAGE_GENERATION_STATE_MISSING: generation control state is unavailable.');
    const transaction = state.transactions.find((item) => item.transaction_id === input.transactionId);
    if (!transaction) throw new Error('E_IMAGE_GENERATION_TRANSACTION_MISSING: generation transaction is unavailable.');
    if (transaction.status !== 'pending') return state;
    transaction.status = input.ok ? 'completed' : 'failed';
    transaction.finished_at = new Date().toISOString();
    if (input.ok && input.outputPath) transaction.output_path = path.resolve(input.outputPath);
    if (!input.ok && input.errorCode) transaction.error_code = input.errorCode;
    if (!input.ok && input.countsTowardBudget === false) transaction.budget_effect = 'not_counted';
    state.updated_at = transaction.finished_at;
    await writeState(input.stateAbsPath, state);
    return state;
  });
}
