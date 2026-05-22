/**
 * Group-chat plan — commander's executable DAG.
 *
 * The commander emits a complete plan via `plan_set`; bus's `plan_executor`
 * then drives execution deterministically:
 *   - dispatches steps when their `wait_for` predecessors are all done
 *   - groups same-`parallel_group` steps into one fork
 *   - auto-marks a step `done` when its assignee replies
 *   - renders `input` template (with `{{user_initial_message}}` and
 *     `{{step_N.output_summary}}` substitutions) into the dispatch text
 *
 * LLM only writes the plan + its per-agent dispatch templates; bus owns
 * state transitions and dispatch timing. See `plan_executor.ts`.
 *
 * File: `<uid>/cloud/chats/<cid>/plan.json`. JSON (not markdown) because
 * `input` is multi-line + step records are structured; regex parsing of
 * a free-form markdown form was brittle for the new fields.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

import { groupChatDir, groupChatPlanFile } from '../../paths';
import { nowIso } from '../../storage';
import { createLogger } from '../../logger';
import { t } from '../../i18n';

const log = createLogger('group_chat.plan');

export type StepStatus =
  | 'pending'        // not yet dispatched
  | 'in_progress'    // dispatched, awaiting assignee's reply
  | 'done'           // assignee replied successfully
  | 'failed'         // assignee errored / aborted / explicit failure
  | 'skipped'        // upstream `on_failure: continue` swept this past
  | 'blocked';       // assignee asked for human input; plan stalls until user enqueues

export type FailurePolicy =
  | 'abort_plan'      // any failure stops every later pending step
  | 'continue'        // mark this step skipped on failure; downstream still runs (their wait_for treats skipped == done)
  | 'ask_commander';  // (default) wake commander to decide; until it acts the plan stalls

export interface PlanStep {
  /** 1-based, immutable once written. `wait_for` references use this. */
  index: number;
  /** Human-readable; what the user will see in the UI plan panel. */
  title: string;
  /** Required. Resolves to: 'user' / 'commander' / agent name (or id).
   * Empty = invalid. Aliases: the Chinese forms '指挥官' → commander
   * and '用户' → user are also accepted. */
  assignee: string;
  /** Dispatch payload template. Bus renders this and sends it as the message
   * body when this step fires. Variables: `{{user_initial_message}}` and
   * `{{step_N.output_summary}}` / `{{step_N.output_files}}`. */
  input?: string;
  /** Step indices (1-based) that must reach a terminal state (done|skipped)
   * before this step can fire. Default = `[index - 1]` (linear chain), or
   * `[]` for the first step. Steps with explicit empty array fire as soon
   * as the plan is set. */
  wait_for?: number[];
  /** Steps with the same group fire together (fork). They still individually
   * wait on their own `wait_for`. Used for "fan out N agents in parallel". */
  parallel_group?: string;
  /** What to do if this step fails. Default: ask_commander. */
  on_failure?: FailurePolicy;

  /** Execution state — bus-managed; LLM does not write these. */
  status: StepStatus;
  output_summary?: string;
  output_files?: string[];
  output_msg_id?: string;
  failure_reason?: string;
  /** Plan-level safety net: count of times the executor folded a transient
   * failure (undici `terminated`, ECONNRESET, etc.) back to `pending` for
   * an automatic redispatch. Cap = `MAX_TRANSIENT_RETRIES` in plan_executor.
   * Reset to 0 on user-initiated retry / step success. */
  transient_attempts?: number;

  /** Legacy free-form notes (kept for tools that still use it). */
  notes?: string;
}

export interface PlanFile {
  schema_version: 2;
  created_at: string;
  updated_at: string;
  /** Captured first-user-message text that triggered the plan; used for
   * `{{user_initial_message}}` template substitution. Set by `setPlan` when
   * the plan is first written and the bus has the trigger context. */
  initial_message?: string;
  /** True after bus has fired the "all steps terminal" notification, so we
   * don't fire it again on subsequent reconciles for the same plan. */
  completed_signaled?: boolean;
  steps: PlanStep[];
}

// ── Read ─────────────────────────────────────────────────────────────────

export async function readPlan(uid: string, cid: string): Promise<PlanFile | null> {
  const file = groupChatPlanFile(uid, cid);
  if (!fs.existsSync(file)) return null;
  try {
    const text = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(text) as Partial<PlanFile>;
    if (!Array.isArray(parsed.steps)) return null;
    return {
      schema_version: 2,
      created_at: parsed.created_at || nowIso(),
      updated_at: parsed.updated_at || nowIso(),
      initial_message: parsed.initial_message,
      completed_signaled: parsed.completed_signaled,
      steps: parsed.steps.map(normalizeStep),
    };
  } catch (err) {
    log.warn(`read plan failed user=${uid} cid=${cid}: ${(err as Error).message}`);
    return null;
  }
}

function normalizeStep(raw: any, i: number): PlanStep {
  const idx = Number(raw?.index);
  return {
    index: Number.isFinite(idx) && idx > 0 ? idx : i + 1,
    title: String(raw?.title || `Step ${i + 1}`).trim(),
    assignee: String(raw?.assignee || 'commander').trim(),
    ...(typeof raw?.input === 'string' && raw.input.trim() ? { input: String(raw.input) } : {}),
    ...(Array.isArray(raw?.wait_for) ? { wait_for: raw.wait_for.map((n: any) => Number(n)).filter(Number.isFinite) } : {}),
    ...(typeof raw?.parallel_group === 'string' && raw.parallel_group.trim()
      ? { parallel_group: String(raw.parallel_group).trim() }
      : {}),
    ...(['abort_plan', 'continue', 'ask_commander'].includes(raw?.on_failure)
      ? { on_failure: raw.on_failure as FailurePolicy }
      : {}),
    status: ['pending', 'in_progress', 'done', 'failed', 'skipped', 'blocked'].includes(raw?.status)
      ? (raw.status as StepStatus) : 'pending',
    ...(typeof raw?.output_summary === 'string' ? { output_summary: raw.output_summary } : {}),
    ...(Array.isArray(raw?.output_files) ? { output_files: raw.output_files.map(String) } : {}),
    ...(typeof raw?.output_msg_id === 'string' ? { output_msg_id: raw.output_msg_id } : {}),
    ...(typeof raw?.failure_reason === 'string' ? { failure_reason: raw.failure_reason } : {}),
    ...(Number.isFinite(Number(raw?.transient_attempts)) && Number(raw.transient_attempts) > 0
      ? { transient_attempts: Number(raw.transient_attempts) } : {}),
    ...(typeof raw?.notes === 'string' && raw.notes.trim() ? { notes: String(raw.notes) } : {}),
  };
}

// ── Write ────────────────────────────────────────────────────────────────

export interface PlanStepInput {
  title: string;
  assignee: string;
  input?: string;
  wait_for?: number[];
  parallel_group?: string;
  on_failure?: FailurePolicy;
  notes?: string;
}

export interface PlanSetInput {
  steps: PlanStepInput[];
  /** Optional: the user message that triggered planning. Captured for
   * `{{user_initial_message}}` substitution at dispatch time. */
  initial_message?: string;
}

async function writePlanRaw(uid: string, cid: string, plan: PlanFile): Promise<void> {
  fs.mkdirSync(groupChatDir(uid, cid), { recursive: true });
  const file = groupChatPlanFile(uid, cid);
  plan.updated_at = nowIso();
  await fsp.writeFile(file, JSON.stringify(plan, null, 2), 'utf-8');
}

/**
 * Replace the entire plan. Bus always emits an announcement on every
 * `plan_set` call (not just the first) — silent re-plans break the
 * "user pings commander → must respond" invariant.
 */
export async function setPlan(
  uid: string, cid: string, input: PlanSetInput,
): Promise<{ plan: PlanFile }> {
  const file = groupChatPlanFile(uid, cid);
  const existed = fs.existsSync(file);
  let created_at = nowIso();
  let prevInitial: string | undefined;
  if (existed) {
    const cur = await readPlan(uid, cid);
    if (cur?.created_at) created_at = cur.created_at;
    prevInitial = cur?.initial_message;
  }
  const steps: PlanStep[] = input.steps.map((s, i) => ({
    index: i + 1,
    title: (s.title || '').trim() || `Step ${i + 1}`,
    assignee: (s.assignee || 'commander').trim(),
    ...(s.input && s.input.trim() ? { input: s.input } : {}),
    ...(Array.isArray(s.wait_for) ? { wait_for: s.wait_for.filter((n) => Number.isFinite(n)) } : {}),
    ...(s.parallel_group && s.parallel_group.trim() ? { parallel_group: s.parallel_group.trim() } : {}),
    ...(s.on_failure ? { on_failure: s.on_failure } : {}),
    ...(s.notes && s.notes.trim() ? { notes: s.notes.trim() } : {}),
    status: 'pending',
  }));
  const plan: PlanFile = {
    schema_version: 2,
    created_at,
    updated_at: nowIso(),
    initial_message: input.initial_message ?? prevInitial,
    completed_signaled: false,
    steps,
  };
  await writePlanRaw(uid, cid, plan);
  log.info(`plan-set user=${uid} cid=${cid} steps=${steps.length} replan=${existed}`);
  return { plan };
}

export async function updateStep(
  uid: string, cid: string, stepIndex: number, status: StepStatus,
  patch?: { notes?: string; output_summary?: string; output_files?: string[]; output_msg_id?: string; failure_reason?: string; transient_attempts?: number },
): Promise<PlanFile | null> {
  const cur = await readPlan(uid, cid);
  if (!cur) return null;
  const idx = cur.steps.findIndex((s) => s.index === stepIndex);
  if (idx < 0) return null;
  cur.steps[idx].status = status;
  if (patch?.notes !== undefined) {
    if (patch.notes.trim()) cur.steps[idx].notes = patch.notes.trim();
    else delete cur.steps[idx].notes;
  }
  if (patch?.output_summary !== undefined) cur.steps[idx].output_summary = patch.output_summary;
  if (patch?.output_files !== undefined) cur.steps[idx].output_files = patch.output_files;
  if (patch?.output_msg_id !== undefined) cur.steps[idx].output_msg_id = patch.output_msg_id;
  if (patch?.failure_reason !== undefined) {
    if (patch.failure_reason) cur.steps[idx].failure_reason = patch.failure_reason;
    else delete cur.steps[idx].failure_reason;
  }
  if (patch?.transient_attempts !== undefined) {
    if (patch.transient_attempts > 0) cur.steps[idx].transient_attempts = patch.transient_attempts;
    else delete cur.steps[idx].transient_attempts;
  }
  await writePlanRaw(uid, cid, cur);
  log.info(`plan-update user=${uid} cid=${cid} step=${stepIndex} status=${status}`);
  return cur;
}

/** Mark `completed_signaled = true` so bus doesn't fire the "all done"
 *  signal twice for the same plan instance. */
export async function markPlanCompletedSignaled(uid: string, cid: string): Promise<void> {
  const cur = await readPlan(uid, cid);
  if (!cur || cur.completed_signaled) return;
  cur.completed_signaled = true;
  await writePlanRaw(uid, cid, cur);
}

/** Format the plan as a commander-emitted announcement message body. Used
 *  by bus on the first plan_set so the user sees the outline. */
export function formatPlanAnnouncement(plan: PlanFile): string {
  const lines = [t('plan.announcement.heading'), ''];
  for (const s of plan.steps) {
    const who = s.assignee === 'commander' ? t('plan.announcement.assignee_self')
      : s.assignee === 'user' ? t('plan.announcement.assignee_user')
      : `@${s.assignee}`;
    lines.push(`${s.index}. ${s.title}（${who}）`);
  }
  return lines.join('\n');
}

/** Format the plan as a system-prompt block fed back to the commander each
 *  turn so it knows where it is. */
export function formatPlanForPrompt(plan: PlanFile | null): string {
  if (!plan || !plan.steps.length) return '(no active plan)';
  const lines: string[] = [];
  for (const s of plan.steps) {
    const mark = s.status === 'done' ? '✓'
      : s.status === 'in_progress' ? '▶'
      : s.status === 'failed' ? '✗'
      : s.status === 'skipped' ? '⊘'
      : s.status === 'blocked' ? '⏸'
      : '○';
    const who = ` → ${s.assignee}`;
    const out = s.output_summary ? ` — ${s.output_summary.slice(0, 80)}` : '';
    lines.push(`${mark} Step ${s.index}: ${s.title} [${s.status}]${who}${out}`);
  }
  return lines.join('\n');
}

// ── Query helpers (used by plan_executor) ────────────────────────────────

/** Steps that are pending AND all their wait_for predecessors are terminal
 *  (done | skipped). Default wait_for = [previous step] for index > 1. */
export function findReadySteps(plan: PlanFile): PlanStep[] {
  const byIdx = new Map<number, PlanStep>();
  for (const s of plan.steps) byIdx.set(s.index, s);
  const isTerminal = (status: StepStatus) =>
    status === 'done' || status === 'skipped';
  return plan.steps.filter((s) => {
    if (s.status !== 'pending') return false;
    const deps = s.wait_for ?? (s.index > 1 ? [s.index - 1] : []);
    return deps.every((d) => {
      const dep = byIdx.get(d);
      return !dep || isTerminal(dep.status);
    });
  });
}

/** True when every step is in a terminal state (done | failed | skipped).
 *  Steps in `blocked` state mean we're paused on user input → not terminal. */
export function isPlanTerminal(plan: PlanFile): boolean {
  return plan.steps.every((s) =>
    s.status === 'done' || s.status === 'failed' || s.status === 'skipped',
  );
}
