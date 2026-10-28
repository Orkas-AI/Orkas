/**
 * To-do driver loop — goal-driven autonomous advancement of a project's or
 * account-global backlog (Phase 3 of the collaboration fabric; see
 * Common/docs/plans/project-collaboration-fabric-from-multica.md).
 *
 * OPT-IN, DEFAULT OFF. When a project turns it on, a periodic check (driven by
 * the existing auto_tasks scheduler tick — no new timer) wakes the project's
 * commander to advance ONE actionable backlog task, then stops. Nothing runs
 * until a project is explicitly enabled, so the blast radius is a single
 * opted-in project bounded by hard guardrails.
 *
 * Two files, split by durability (mirrors the project's other work-state):
 *   - `cloud/projects/<pid>/driver.json`  — opt-in config (synced). Absent = off.
 *   - `local/projects/<pid>/driver-state.json` — execution bookkeeping
 *     (per-device, NEVER synced): last advance time, today's count, and the
 *     in-flight advance conversation lease.
 *
 * This module is the DECISION + storage layer. It never fires anything itself:
 * `decideAdvance` is a pure guardrail evaluator and `nextActionableTask` a pure
 * selector, so the whole gate is unit-testable without spawning a run. The live
 * fire + scheduler wiring lives in the driver runner (Phase-3 slice 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareDueFirst } from './project_tasks';

import {
  projectDriverFile,
  projectDriverStateFile,
  userTodoDriverFile,
  userTodoDriverStateFile,
} from '../paths';
import { readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import { getDeviceId } from './machine_device_id';
import { getCurrentDevice as getDeviceFingerprint } from '../util/device';
import type { ProjectTask } from './project_tasks';

const log = createLogger('project-driver');

// Guardrail constants. Conservative by design — an autonomous loop must fail
// toward doing LESS, not more.
export const DEFAULT_MAX_ADVANCES_PER_DAY = 20;
const MAX_ADVANCES_PER_DAY_CAP = 200;
/** Minimum gap between advances, even when the previous one finished fast — a
 *  floor on cadence so a project cannot burn its daily budget in seconds. */
export const MIN_ADVANCE_INTERVAL_MS = 2 * 60 * 1000;
/** A lease older than this is treated as stuck: release it so one hung advance
 *  cannot freeze the loop forever. Sized above a normal multi-agent advance. */
export const STUCK_LEASE_TTL_MS = 30 * 60 * 1000;

export interface DriverConfig {
  enabled: boolean;
  max_advances_per_day: number;
  /** Stable installation identity; synced with the opt-in, never inferred from the name. */
  device_id?: string;
  device_name?: string;
}

export function getCurrentDevice(): { id: string; name: string } {
  return { id: getDeviceId(), name: getDeviceFingerprint().name };
}

export function runsOnCurrentDevice(cfg: DriverConfig): boolean {
  return cfg.enabled && cfg.device_id === getDeviceId();
}

export interface DriverState {
  /** ISO time of the last advance this device fired. */
  last_advance_at?: string;
  /** Local YYYY-MM-DD the count below belongs to (reset on a new day). */
  advance_date?: string;
  advance_count?: number;
  /** Conversation id of the in-flight advance (the lease); cleared when it goes
   *  quiescent or the lease ages past STUCK_LEASE_TTL_MS. */
  lease_cid?: string;
  lease_at?: string;
  /** Task the lease advanced. Once this task leaves `todo` the advance has
   *  taken effect, so the loop stops waiting on the (possibly long) conversation
   *  and proceeds to the next task — see advanceProjectIfDue. */
  lease_task_id?: string;
}

export type AdvanceReason = 'disabled' | 'other_device' | 'running' | 'cooldown' | 'daily_cap' | 'no_actionable_task';
export type AdvanceDecision =
  | { advance: false; reason: AdvanceReason }
  | { advance: true; task: ProjectTask };

function _clampMaxPerDay(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_ADVANCES_PER_DAY;
  return Math.min(MAX_ADVANCES_PER_DAY_CAP, Math.max(1, v));
}

/** Local calendar date (YYYY-MM-DD) for the daily-cap window. */
function _localDate(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Config (cloud, synced) ──────────────────────────────────────────────────

function _notifyDirty(_pid: string): void {}

function _configFile(uid: string, pid: string): string {
  return pid ? projectDriverFile(uid, pid) : userTodoDriverFile(uid);
}

function _stateFile(uid: string, pid: string): string {
  return pid ? projectDriverStateFile(uid, pid) : userTodoDriverStateFile(uid);
}

export async function readConfig(uid: string, pid: string): Promise<DriverConfig> {
  const f = _configFile(uid, pid);
  if (!fs.existsSync(f)) return { enabled: false, max_advances_per_day: DEFAULT_MAX_ADVANCES_PER_DAY };
  try {
    const raw = await readJson(f) as {
      enabled?: unknown; max_advances_per_day?: unknown; device_id?: unknown; device_name?: unknown;
    };
    const deviceId = typeof raw?.device_id === 'string' ? raw.device_id.trim() : '';
    const deviceName = typeof raw?.device_name === 'string' ? raw.device_name.trim() : '';
    return {
      // Legacy opt-ins have no owner. Keep them paused on every installation
      // until an explicit enable records one; never claim them during a read.
      enabled: raw?.enabled === true && !!deviceId,
      max_advances_per_day: _clampMaxPerDay(raw?.max_advances_per_day),
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(deviceName ? { device_name: deviceName } : {}),
    };
  } catch (err) {
    log.warn(`read config uid=${uid} pid=${pid}: ${(err as Error).message}`);
    return { enabled: false, max_advances_per_day: DEFAULT_MAX_ADVANCES_PER_DAY };
  }
}

export async function writeConfig(
  uid: string, pid: string, patch: Partial<Pick<DriverConfig, 'enabled' | 'max_advances_per_day'>>,
): Promise<DriverConfig> {
  const cur = await readConfig(uid, pid);
  // An explicit enable always belongs to the device performing that action.
  // Cap-only edits preserve the owner; any device may disable the shared opt-in.
  const device = patch.enabled === true ? getCurrentDevice() : null;
  const next: DriverConfig = {
    ...cur,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    max_advances_per_day: patch.max_advances_per_day !== undefined
      ? _clampMaxPerDay(patch.max_advances_per_day)
      : cur.max_advances_per_day,
    ...(device ? { device_id: device.id, device_name: device.name } : {}),
  };
  if (!next.enabled) {
    delete next.device_id;
    delete next.device_name;
  }
  const f = _configFile(uid, pid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await writeJson(f, next);
  _notifyDirty(pid);
  return next;
}

// ── State (local, machine-private, NEVER synced) ────────────────────────────

function _normaliseState(raw: unknown): DriverState {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const s: DriverState = {};
  if (typeof r.last_advance_at === 'string') s.last_advance_at = r.last_advance_at;
  if (typeof r.advance_date === 'string') s.advance_date = r.advance_date;
  if (typeof r.advance_count === 'number' && Number.isFinite(r.advance_count)) s.advance_count = Math.max(0, Math.floor(r.advance_count));
  if (typeof r.lease_cid === 'string' && r.lease_cid) s.lease_cid = r.lease_cid;
  if (typeof r.lease_at === 'string') s.lease_at = r.lease_at;
  if (typeof r.lease_task_id === 'string' && r.lease_task_id) s.lease_task_id = r.lease_task_id;
  return s;
}

export async function readState(uid: string, pid: string): Promise<DriverState> {
  const f = _stateFile(uid, pid);
  if (!fs.existsSync(f)) return {};
  try { return _normaliseState(await readJson(f)); }
  catch (err) {
    log.warn(`read state uid=${uid} pid=${pid}: ${(err as Error).message}`);
    return {};
  }
}

export async function writeState(uid: string, pid: string, s: DriverState): Promise<void> {
  const f = _stateFile(uid, pid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // Never markDirty — local/ is machine-private and must never sync (CLAUDE.md).
  await writeJson(f, s);
}

// ── Pure decision layer (unit-tested; fires nothing) ────────────────────────

/** Select the eligible to-do with the earliest due date, retaining backlog
 * order for equal or absent dates. Missing dependencies cannot deadlock it. */
export function nextActionableTask(tasks: readonly ProjectTask[]): ProjectTask | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const resolved = (depId: string): boolean => {
    const d = byId.get(depId);
    if (!d) return true;
    return d.status === 'done';
  };
  let pick: ProjectTask | null = null;
  for (const t of tasks) {
    if (t.status !== 'todo') continue;
    if (!(t.depends_on || []).every(resolved)) continue;
    if (!pick || compareDueFirst(t, pick) < 0) pick = t;
  }
  return pick;
}

/**
 * Pure guardrail evaluator. Given the config, the current state, the clock, the
 * backlog, and whether the leased advance conversation is still running, decide
 * whether to advance and return the state to persist. Order = cheapest / most
 * decisive gate first: kill switch → in-flight lease → cooldown → daily cap →
 * actionable work. The caller persists `nextState` and, on advance, fills in the
 * new `lease_cid`/`lease_at` after it creates the advance conversation.
 */
export function decideAdvance(
  cfg: DriverConfig,
  state: DriverState,
  nowMs: number,
  tasks: readonly ProjectTask[],
  leaseRunning: boolean,
): { decision: AdvanceDecision; nextState: DriverState } {
  if (!cfg.enabled) return { decision: { advance: false, reason: 'disabled' }, nextState: state };

  let next: DriverState = { ...state };

  // In-flight lease: an advance conversation this device started is still
  // working. Skip until it goes quiescent, or until the lease ages out (a hung
  // advance must not freeze the loop).
  if (next.lease_cid) {
    const leaseMs = next.lease_at ? nowMs - Date.parse(next.lease_at) : NaN;
    const fresh = Number.isFinite(leaseMs) && leaseMs >= 0 && leaseMs < STUCK_LEASE_TTL_MS;
    if (leaseRunning && fresh) {
      return { decision: { advance: false, reason: 'running' }, nextState: next };
    }
    next = { ...next, lease_cid: undefined, lease_at: undefined, lease_task_id: undefined };
  }

  // Cooldown: a floor on cadence independent of how fast the last advance ran.
  if (next.last_advance_at) {
    const sinceMs = nowMs - Date.parse(next.last_advance_at);
    if (Number.isFinite(sinceMs) && sinceMs >= 0 && sinceMs < MIN_ADVANCE_INTERVAL_MS) {
      return { decision: { advance: false, reason: 'cooldown' }, nextState: next };
    }
  }

  // Daily cap (reset on a new local day).
  const today = _localDate(nowMs);
  const count = next.advance_date === today ? (next.advance_count || 0) : 0;
  if (next.advance_date !== today) next = { ...next, advance_date: today, advance_count: 0 };
  if (count >= _clampMaxPerDay(cfg.max_advances_per_day)) {
    return { decision: { advance: false, reason: 'daily_cap' }, nextState: next };
  }

  const task = nextActionableTask(tasks);
  if (!task) return { decision: { advance: false, reason: 'no_actionable_task' }, nextState: next };

  next = {
    ...next,
    last_advance_at: new Date(nowMs).toISOString(),
    advance_date: today,
    advance_count: count + 1,
  };
  return { decision: { advance: true, task }, nextState: next };
}
