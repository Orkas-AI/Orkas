/**
 * A project's goal: what the project is for, how the user will know it is
 * reached, and whether it is. Optional, because not every project has a clear,
 * measurable target: no file means no goal, and everything else in the project
 * works the same without one.
 *
 * Its own file (`goal.json`) rather than a `project.json` field: older clients
 * rewrite project.json with only the fields they know. For the same reason a
 * save keeps fields this version does not know.
 *
 * The user edits it on the project page; Commander saves it through
 * `project_setup` when the user states or agrees to one. This version opens
 * `active` and `achieved` only: pausing means something once auto-advance
 * follows the goal (Common/docs/plans/commander-project-continuity.md §9).
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { projectGoalFile } from '../paths';
import { nowIso, writeJson } from '../storage';
import { prompts } from '../prompts/loader';
import * as projects from './projects';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
import { projectGoalAndRecapEnabled } from '../util/project-feature-flags';

const log = createLogger('project-goal');

/** A goal enters the stable prefix of every project conversation, so it stays
 *  a few sentences; matches the `project_setup` bound. */
export const GOAL_MAX_CHARS = 400;
export const SUCCESS_CRITERIA_MAX = 5;
export const SUCCESS_CRITERION_MAX_CHARS = 200;
export const GOAL_STATUSES = ['active', 'achieved'] as const;
export type ProjectGoalStatus = typeof GOAL_STATUSES[number];

export interface ProjectGoal {
  goal: string;
  success_criteria: string[];
  status: ProjectGoalStatus;
  updated_at: string;
  achieved_at: string | null;
}

export type GoalChangeAction = 'set' | 'edit' | 'achieve' | 'reopen' | 'clear';

export type GoalOrigin = 'ui' | 'agent';
export type GoalError =
  | 'project_not_found'
  | 'goal_invalid'
  | 'goal_too_long'
  | 'goal_not_set'
  | 'criteria_invalid'
  | 'criteria_too_many'
  | 'criterion_too_long'
  | 'status_invalid'
  | 'write_failed';

export interface GoalPatch {
  /** Replaces the goal; empty clears the whole record. */
  goal?: string;
  /** Replaces every criterion; an empty list removes them. */
  success_criteria?: string[];
  status?: string;
}

export type GoalSaveResult =
  | { ok: true; goal: ProjectGoal | null; action: GoalChangeAction | null }
  | { ok: false; error: GoalError };

function _criteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, SUCCESS_CRITERION_MAX_CHARS))
    .filter(Boolean)
    .slice(0, SUCCESS_CRITERIA_MAX);
}

/** Coerce a stored (possibly synced or hand-edited) record; never throws. An
 *  oversized value is clipped like the instructions are, never dropped. */
function _normalise(raw: unknown): ProjectGoal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const goal = typeof record.goal === 'string' ? record.goal.trim().slice(0, GOAL_MAX_CHARS) : '';
  if (!goal) return null;
  const status: ProjectGoalStatus = record.status === 'achieved' ? 'achieved' : 'active';
  return {
    goal,
    success_criteria: _criteria(record.success_criteria),
    status,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : '',
    achieved_at: status === 'achieved' && typeof record.achieved_at === 'string' ? record.achieved_at : null,
  };
}

function _parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function _readRaw(uid: string, pid: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fsp.readFile(projectGoalFile(uid, pid), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('goal unreadable', { pid: maskId(pid), error: logErrorSummary(error) });
    return null;
  }
  const raw = _parse(text);
  if (!raw) log.warn('goal file is not a JSON object', { pid: maskId(pid) });
  return raw;
}

export async function readProjectGoal(uid: string, pid: string): Promise<ProjectGoal | null> {
  return _normalise(await _readRaw(uid, pid));
}

/** Synchronous read for prompt assembly, which reads the instructions the same way. */
export function readProjectGoalSync(uid: string, pid: string): ProjectGoal | null {
  let text: string;
  try {
    text = fs.readFileSync(projectGoalFile(uid, pid), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('goal unreadable', { pid: maskId(pid), error: logErrorSummary(error) });
    return null;
  }
  return _normalise(_parse(text));
}

/**
 * The goal block of the stable prompt prefix (plan appendix A.2), placed right
 * after the project instructions. Commander also gets how to use it; named
 * Agents get the facts only (plan C13). Empty without a goal.
 */
export function formatProjectGoalForSystemPrompt(uid: string, pid: string, opts: { usage: boolean }): string {
  if (!projectGoalAndRecapEnabled()) return '';
  const goal = readProjectGoalSync(uid, pid);
  if (!goal) return '';
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  const facts = prompts.load('project_goal', {
    goal: flat(goal.goal),
    criteria: goal.success_criteria.length
      ? goal.success_criteria.map((criterion, index) => `${index + 1}) ${flat(criterion)}`).join('; ')
      : 'none set',
    status: goal.status,
  }).trim();
  return opts.usage ? `${facts}\n\n${prompts.load('project_goal_usage').trim()}` : facts;
}

// In-process change notification: index.ts relays it to an open project page,
// so a goal Commander saves mid-conversation shows without reopening it.
export interface GoalChangedEvent { uid: string; projectId: string }
type GoalChangedListener = (event: GoalChangedEvent) => void;
const _changedListeners: GoalChangedListener[] = [];
export function onProjectGoalChanged(cb: GoalChangedListener): void {
  if (typeof cb === 'function') _changedListeners.push(cb);
}

const _locks = new Map<string, Promise<void>>();
async function _withLock<T>(uid: string, pid: string, work: () => Promise<T>): Promise<T> {
  const key = `${uid}\0${pid}`;
  const previous = _locks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  _locks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (_locks.get(key) === tail) _locks.delete(key);
  }
}

function _validCriteria(value: unknown): { ok: true; criteria: string[] } | { ok: false; error: GoalError } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return { ok: false, error: 'criteria_invalid' };
  const criteria = (value as string[]).map((item) => item.trim());
  if (criteria.some((item) => !item)) return { ok: false, error: 'criteria_invalid' };
  if (criteria.length > SUCCESS_CRITERIA_MAX) return { ok: false, error: 'criteria_too_many' };
  if (criteria.some((item) => item.length > SUCCESS_CRITERION_MAX_CHARS)) return { ok: false, error: 'criterion_too_long' };
  return { ok: true, criteria };
}

/**
 * Set, edit, achieve, reopen or clear the goal. Omitted fields keep their
 * value; a new goal starts `active`. Saving the same values again writes
 * nothing. Clearing removes the file, so the project reads as having no goal.
 */
export async function saveProjectGoal(
  uid: string, pid: string, patch: GoalPatch, origin: GoalOrigin,
): Promise<GoalSaveResult> {
  const fail = (error: GoalError, criteriaCount = 0): GoalSaveResult => {
    return { ok: false, error };
  };
  return _withLock(uid, pid, async () => {
    const project = await projects.getProject(uid, pid);
    if (!project) return fail('project_not_found');
    if (patch.goal !== undefined && typeof patch.goal !== 'string') return fail('goal_invalid');
    const goalText = typeof patch.goal === 'string' ? patch.goal.trim() : undefined;
    if (goalText !== undefined && goalText.length > GOAL_MAX_CHARS) return fail('goal_too_long');
    let criteria: string[] | undefined;
    if (patch.success_criteria !== undefined) {
      const checked = _validCriteria(patch.success_criteria);
      if (!checked.ok) return fail((checked as { error: GoalError }).error);
      criteria = (checked as { criteria: string[] }).criteria;
    }
    if (patch.status !== undefined && !GOAL_STATUSES.includes(patch.status as ProjectGoalStatus)) {
      return fail('status_invalid', criteria?.length || 0);
    }
    const status = patch.status as ProjectGoalStatus | undefined;

    const raw = await _readRaw(uid, pid);
    const previous = _normalise(raw);
    const file = projectGoalFile(uid, pid);
    if (goalText === '') {
      if (!previous && !fs.existsSync(file)) return { ok: true as const, goal: null, action: null };
      try {
        await fsp.rm(file, { force: true });
      } catch (error) {
        log.warn('goal clear failed', { pid: maskId(pid), error: logErrorSummary(error) });
        return fail('write_failed', previous?.success_criteria.length || 0);
      }
      _notify(uid, pid);
      log.info('goal cleared', { uid: maskId(uid), pid: maskId(pid), origin });
      return { ok: true as const, goal: null, action: 'clear' as const };
    }
    if (!previous && !goalText) return fail('goal_not_set', criteria?.length || 0);
    const nextStatus: ProjectGoalStatus = status ?? previous?.status ?? 'active';
    const now = nowIso();
    const next: ProjectGoal = {
      goal: goalText || previous!.goal,
      success_criteria: criteria ?? previous?.success_criteria ?? [],
      status: nextStatus,
      updated_at: now,
      achieved_at: nextStatus !== 'achieved' ? null
        : previous?.status === 'achieved' && previous.achieved_at ? previous.achieved_at : now,
    };
    if (previous && previous.goal === next.goal && previous.status === next.status
        && previous.achieved_at === next.achieved_at
        && JSON.stringify(previous.success_criteria) === JSON.stringify(next.success_criteria)) {
      return { ok: true as const, goal: previous, action: null };
    }
    const action: GoalChangeAction = !previous ? 'set'
      : previous.status !== next.status ? (next.status === 'achieved' ? 'achieve' : 'reopen')
        : 'edit';
    try {
      // Keep fields a newer version wrote, such as a status this one cannot show.
      await writeJson(file, { ...(raw || {}), ...next, ...(status === undefined && raw && typeof raw.status === 'string'
        && !GOAL_STATUSES.includes(raw.status as ProjectGoalStatus) ? { status: raw.status } : {}) });
    } catch (error) {
      log.warn('goal save failed', { pid: maskId(pid), error: logErrorSummary(error) });
      return fail('write_failed', next.success_criteria.length);
    }
    _notify(uid, pid);
    log.info('goal saved', { uid: maskId(uid), pid: maskId(pid), origin, action, criteria: next.success_criteria.length });
    return { ok: true as const, goal: next, action };
  });
}

function _notify(uid: string, pid: string): void {
  for (const cb of _changedListeners) {
    try { cb({ uid, projectId: pid }); } catch { /* a listener never undoes a saved goal */ }
  }
}
