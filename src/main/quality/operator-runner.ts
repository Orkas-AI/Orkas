import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { ValidationReport } from './types';
import type { SkillValidationOptions } from './index';

export type PolicyRequest =
  | { kind: 'config' }
  | { kind: 'files'; files: Array<{ relpath: string; content: string }> }
  | { kind: 'agent'; args: { agentJson: unknown; enforceSkillRunner?: boolean } }
  | { kind: 'directory'; dir: string; options?: Omit<SkillValidationOptions, 'operatorRules'> };
export type PolicyResult = { reports: ValidationReport[]; ruleCount: number; error?: never }
  | { error: 'config' | 'scan' | 'timeout' | 'busy' | 'size'; errors?: string[] };
let active = 0;

/** No queue: at most two scans, with a bounded wall-clock deadline including
 * bootstrap. Completion waits for termination before releasing the slot. */
export async function runOperatorPolicy(policy: string, request: PolicyRequest): Promise<PolicyResult> {
  if (active >= 2) return { error: 'busy' };
  if (request.kind === 'files' && request.files.some(file => file.relpath.length > 512)) return { error: 'size' };
  let serialized: string;
  try { serialized = JSON.stringify(request); } catch { return { error: 'scan' }; }
  if (policy.length > 64 * 1024 || serialized.length > 2 * 1024 * 1024
    || (request.kind === 'files' && request.files.length > 512)) return { error: 'size' };
  active++;
  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    worker = new Worker(path.join(__dirname, 'operator-worker.js'), {
      execArgv: [], workerData: { policy, request },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    return await new Promise<PolicyResult>((resolve) => {
      timer = setTimeout(() => resolve({ error: 'timeout' }), 2000);
      worker!.once('message', resolve);
      worker!.once('error', () => resolve({ error: 'scan' }));
      worker!.once('exit', () => resolve({ error: 'scan' }));
    });
  } catch { return { error: 'scan' }; }
  finally {
    clearTimeout(timer);
    try { await worker?.terminate(); } finally { active--; }
  }
}
