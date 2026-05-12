/**
 * Scheduled agent tasks — periodically fires an agent in a fresh
 * conversation with a pre-filled input. The fire path goes through
 * `chats.createConversation` + `groupChat.send('@<agent> <input>')`,
 * i.e. the same bus entry point a manual run takes (CLAUDE.md §5
 * single-dispatch primitive), so the UI sees an ordinary new conv
 * streaming in.
 *
 * Storage: single per-user JSON at
 *   `<uid>/cloud/config/scheduled_tasks.json`
 * (same dir + cloud-sync policy as preferences.json / component-enabled.json).
 * Scheduling is user-orchestration config that references an agent — it
 * is intentionally NOT per-agent runtime asset (those live under
 * `agents/<aid>/`, see CLAUDE.md §4 #3).
 *
 * Schema (v1):
 *   {
 *     version: 1,
 *     tasks: [{
 *       id: 'st_<8 hex>',
 *       agent_id, enabled, title?,
 *       schedule:
 *         | { type: 'interval', minutes }
 *         | { type: 'daily', hour, minute }
 *         | { type: 'weekly', weekdays: number[], hour, minute },
 *       default_input,
 *       created_at, updated_at, last_run_at?
 *     }]
 *   }
 *
 * Scheduler: one in-process `setInterval(TICK_MS)` (30s) started by
 * `startScheduler()` after `activateUser()`. Each tick: read file → pick
 * due tasks → set `last_run_at` → dispatch in parallel. Fires are
 * **best-effort**: missed boundaries while the app was closed do NOT
 * back-fire (would surprise the user with a burst of conversations on
 * laptop wake).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import { userScheduledTasksFile } from '../paths';
import { readJson, writeJson, nowIso, safeId } from '../storage';
import { createLogger } from '../logger';
import { getActiveUserId, hasActiveUser } from './users';
import { isAgentEnabled } from './component_enabled';
import * as agents from './agents';
import * as chats from './chats';
import * as groupChat from './group_chat';

const log = createLogger('scheduled-tasks');

const SCHEMA_VERSION = 1;
const TICK_MS = 30_000;
const MAX_INTERVAL_MIN = 60 * 24 * 30; // 30 days cap
const MAX_TITLE_LEN = 80;
const MAX_INPUT_LEN = 4000;

export type ScheduleInterval = { type: 'interval'; minutes: number };
export type ScheduleDaily    = { type: 'daily';    hour: number; minute: number };
export type ScheduleWeekly   = { type: 'weekly';   weekdays: number[]; hour: number; minute: number };
export type Schedule = ScheduleInterval | ScheduleDaily | ScheduleWeekly;

export interface ScheduledTask {
  id: string;
  agent_id: string;
  enabled: boolean;
  title?: string;
  schedule: Schedule;
  default_input: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
}

interface FileShape {
  version: number;
  tasks: ScheduledTask[];
}

function emptyFile(): FileShape { return { version: SCHEMA_VERSION, tasks: [] }; }

function genTaskId(): string { return 'st_' + crypto.randomBytes(4).toString('hex'); }

// ── File IO (serialised) ────────────────────────────────────────────────

// Single in-process tail promise per uid serialises read-modify-write
// chains so IPC mutations don't race the scheduler-tick last_run_at
// updates. Sub-features under <uid>/cloud/config/ are small JSON, no
// need for the heavier util/locks abstraction.
const _tails = new Map<string, Promise<unknown>>();
function _runExclusive<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = _tails.get(uid) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  _tails.set(uid, next);
  return next;
}

async function _read(uid: string): Promise<FileShape> {
  const p = userScheduledTasksFile(uid);
  if (!fs.existsSync(p)) return emptyFile();
  try {
    const raw: any = await readJson(p);
    if (!raw || typeof raw !== 'object') return emptyFile();
    const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(_isValidTaskShape) : [];
    return { version: SCHEMA_VERSION, tasks };
  } catch (err) {
    log.warn(`read failed uid=${uid}: ${(err as Error).message}`);
    return emptyFile();
  }
}

async function _write(uid: string, file: FileShape): Promise<void> {
  await writeJson(userScheduledTasksFile(uid), file);
}

function _isValidTaskShape(t: any): t is ScheduledTask {
  if (!t || typeof t !== 'object') return false;
  if (typeof t.id !== 'string' || !t.id) return false;
  if (typeof t.agent_id !== 'string' || !t.agent_id) return false;
  if (typeof t.default_input !== 'string') return false;
  if (typeof t.enabled !== 'boolean') return false;
  if (!_isValidSchedule(t.schedule)) return false;
  return true;
}

function _isValidSchedule(s: any): s is Schedule {
  if (!s || typeof s !== 'object') return false;
  if (s.type === 'interval') {
    return Number.isFinite(s.minutes) && s.minutes >= 1 && s.minutes <= MAX_INTERVAL_MIN;
  }
  if (s.type === 'daily') {
    return _isHM(s.hour, s.minute);
  }
  if (s.type === 'weekly') {
    return _isHM(s.hour, s.minute)
      && Array.isArray(s.weekdays)
      && s.weekdays.length > 0
      && s.weekdays.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6);
  }
  return false;
}

function _isHM(h: unknown, m: unknown): boolean {
  return Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23
    && Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 59;
}

// ── Validation / draft normalisation ────────────────────────────────────

export type TaskDraft = {
  agent_id: string;
  schedule: Schedule;
  default_input?: string;
  title?: string;
  enabled?: boolean;
};

export type TaskError =
  | 'agent_missing'
  | 'invalid_schedule'
  | 'invalid_input'
  | 'not_found';

// Validated common fields ready to be merged into a new or existing task
// (caller owns id / created_at / updated_at).
type NormalisedFields = Omit<ScheduledTask, 'id' | 'created_at' | 'updated_at' | 'last_run_at'>;

function _normaliseDraft(d: TaskDraft): { ok: true; fields: NormalisedFields } | { ok: false; error: TaskError } {
  if (typeof d.agent_id !== 'string' || !d.agent_id) return { ok: false, error: 'agent_missing' };
  if (!_isValidSchedule(d.schedule)) return { ok: false, error: 'invalid_schedule' };
  let input = typeof d.default_input === 'string' ? d.default_input : '';
  if (input.length > MAX_INPUT_LEN) input = input.slice(0, MAX_INPUT_LEN);
  let title = typeof d.title === 'string' ? d.title.trim() : '';
  if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN);
  const enabled = d.enabled === false ? false : true;
  return {
    ok: true,
    fields: {
      agent_id: d.agent_id,
      enabled,
      schedule: d.schedule,
      default_input: input,
      ...(title ? { title } : {}),
    },
  };
}

// ── Public CRUD ─────────────────────────────────────────────────────────

export async function listTasks(uid: string, agentId?: string): Promise<ScheduledTask[]> {
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    return agentId ? f.tasks.filter((t) => t.agent_id === agentId) : f.tasks.slice();
  });
}

export async function getTask(uid: string, taskId: string): Promise<ScheduledTask | null> {
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    return f.tasks.find((t) => t.id === taskId) || null;
  });
}

export async function createTask(
  uid: string, draft: TaskDraft,
): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: TaskError }> {
  const norm = _normaliseDraft(draft);
  if (!norm.ok) return { ok: false, error: (norm as { error: TaskError }).error };
  // Sanity-check: agent must exist (custom or builtin).
  const agent = await agents.getAgent(draft.agent_id).catch(() => null);
  if (!agent) return { ok: false, error: 'agent_missing' };

  const fields = norm.fields;
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    const now = nowIso();
    const task: ScheduledTask = {
      id: genTaskId(),
      ...fields,
      created_at: now,
      updated_at: now,
    };
    f.tasks.push(task);
    await _write(uid, f);
    log.info(`task created uid=${uid} id=${task.id} agent=${task.agent_id} type=${task.schedule.type}`);
    return { ok: true as const, task };
  });
}

export async function updateTask(
  uid: string, taskId: string, patch: Partial<TaskDraft> & { default_input?: string },
): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: TaskError }> {
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    const i = f.tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return { ok: false as const, error: 'not_found' as const };
    const cur = f.tasks[i];
    const merged: TaskDraft = {
      agent_id: typeof patch.agent_id === 'string' && patch.agent_id ? patch.agent_id : cur.agent_id,
      schedule: patch.schedule ? patch.schedule : cur.schedule,
      default_input: typeof patch.default_input === 'string' ? patch.default_input : cur.default_input,
      title: typeof patch.title === 'string' ? patch.title : cur.title,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    };
    const norm = _normaliseDraft(merged);
    if (!norm.ok) return { ok: false as const, error: (norm as { error: TaskError }).error };
    const next: ScheduledTask = {
      ...cur,
      ...norm.fields,
      updated_at: nowIso(),
    };
    // Strip title when it normalised away.
    if (!norm.fields.title) delete next.title;
    f.tasks[i] = next;
    await _write(uid, f);
    log.info(`task updated uid=${uid} id=${taskId}`);
    return { ok: true as const, task: next };
  });
}

export async function deleteTask(uid: string, taskId: string): Promise<{ ok: boolean }> {
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    const before = f.tasks.length;
    f.tasks = f.tasks.filter((t) => t.id !== taskId);
    if (f.tasks.length === before) return { ok: false };
    await _write(uid, f);
    log.info(`task deleted uid=${uid} id=${taskId}`);
    return { ok: true };
  });
}

export async function setTaskEnabled(
  uid: string, taskId: string, enabled: boolean,
): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: TaskError }> {
  return _runExclusive(uid, async () => {
    const f = await _read(uid);
    const i = f.tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return { ok: false as const, error: 'not_found' as const };
    f.tasks[i] = { ...f.tasks[i], enabled: !!enabled, updated_at: nowIso() };
    await _write(uid, f);
    return { ok: true as const, task: f.tasks[i] };
  });
}

/** Internal: mark `last_run_at` for a task (used by the tick on dispatch). */
async function _markRan(uid: string, taskId: string, atIso: string): Promise<void> {
  await _runExclusive(uid, async () => {
    const f = await _read(uid);
    const i = f.tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return;
    f.tasks[i] = { ...f.tasks[i], last_run_at: atIso };
    await _write(uid, f);
  });
}

// ── Due-time computation ────────────────────────────────────────────────

/** True iff the task should fire at `now` given its last run. */
export function isDue(task: ScheduledTask, now: Date, lastRun: Date | null): boolean {
  if (!task.enabled) return false;
  const sched = task.schedule;
  if (sched.type === 'interval') {
    if (!lastRun) return true; // first run after task creation
    const elapsedMs = now.getTime() - lastRun.getTime();
    return elapsedMs >= sched.minutes * 60_000 - 1000; // 1s slop for tick jitter
  }
  if (sched.type === 'daily') {
    return _crossedTodayBoundary(now, lastRun, sched.hour, sched.minute);
  }
  if (sched.type === 'weekly') {
    if (!sched.weekdays.includes(now.getDay())) return false;
    return _crossedTodayBoundary(now, lastRun, sched.hour, sched.minute);
  }
  return false;
}

/** True iff `now` is at-or-after today's HH:MM boundary AND `lastRun` is
 *  before today's boundary (i.e. we haven't already fired today). */
function _crossedTodayBoundary(now: Date, lastRun: Date | null, hour: number, minute: number): boolean {
  const boundary = new Date(now);
  boundary.setHours(hour, minute, 0, 0);
  if (now.getTime() < boundary.getTime()) return false;
  if (!lastRun) return true;
  return lastRun.getTime() < boundary.getTime();
}

// ── Dispatch ────────────────────────────────────────────────────────────

/** Build the seed text sent into the group bus. Matches the manual-run
 *  pattern `@<agent name> <user message>`; an empty default_input yields
 *  the same fallback `useAgent()` uses (just `@<name>`, which is enough
 *  to wake the agent). */
function _buildSeedText(agentName: string, defaultInput: string): string {
  const tag = '@' + agentName;
  const body = (defaultInput || '').trim();
  return body ? `${tag} ${body}` : tag;
}

async function _fireTask(uid: string, task: ScheduledTask): Promise<void> {
  // Resolve agent NAME at fire time — renames must not break scheduled runs.
  const agent = await agents.getAgent(task.agent_id).catch(() => null);
  if (!agent) {
    log.warn(`fire skipped uid=${uid} id=${task.id} reason=agent_missing aid=${task.agent_id}`);
    return;
  }
  if (!isAgentEnabled(uid, task.agent_id)) {
    log.info(`fire skipped uid=${uid} id=${task.id} reason=agent_disabled aid=${task.agent_id}`);
    return;
  }
  const title = (task.title && task.title.trim())
    ? task.title.trim()
    : `⏱ ${agent.name || task.agent_id}`;
  let cid = '';
  try {
    const conv = await chats.createConversation(uid, { kind: 'normal', title });
    cid = conv.conversation_id;
  } catch (err) {
    log.error(`fire conv-create failed uid=${uid} id=${task.id}: ${(err as Error).message}`);
    return;
  }
  const text = _buildSeedText(agent.name || task.agent_id, task.default_input);
  try {
    const res = await groupChat.send({ userId: uid, cid, text });
    if (!res.ok) {
      log.warn(`fire send failed uid=${uid} id=${task.id} cid=${cid}: ${res.error || 'unknown'}`);
      return;
    }
    log.info(`fired uid=${uid} id=${task.id} agent=${task.agent_id} cid=${cid}`);
    // Notify renderer subscribers so the sidebar's conv list refreshes —
    // manual runs do this via the renderer-side useAgent path, but a
    // scheduled fire creates the conv in main and needs an explicit push.
    _emitFire({ type: 'conv_created', cid, task_id: task.id, agent_id: task.agent_id });
  } catch (err) {
    log.error(`fire send threw uid=${uid} id=${task.id} cid=${cid}: ${(err as Error).message}`);
  }
}

// ── Fire pub/sub (renderer-side refresh hook) ───────────────────────────
//
// The renderer's conversation list is mutated locally on manual `useAgent`
// runs (it creates the conv via IPC and patches its in-memory array). A
// scheduled fire creates the conv in main, so the renderer never learns
// about it without a push. One in-process subscriber set; the IPC layer
// exposes a long-lived stream channel that funnels these events out to
// every open window.

export type ScheduledFireEvent = {
  type: 'conv_created';
  cid: string;
  task_id: string;
  agent_id: string;
};

type FireListener = (ev: ScheduledFireEvent) => void;
const _fireListeners = new Set<FireListener>();

/** Subscribe to fire events. Returns an unsub function. */
export function subscribeFires(fn: FireListener): () => void {
  _fireListeners.add(fn);
  return () => { _fireListeners.delete(fn); };
}

function _emitFire(ev: ScheduledFireEvent): void {
  for (const fn of _fireListeners) {
    try { fn(ev); }
    catch (err) { log.warn(`fire listener threw: ${(err as Error).message}`); }
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────

let _timer: NodeJS.Timeout | null = null;

async function _tick(): Promise<void> {
  if (!hasActiveUser()) return;
  const uid = getActiveUserId();
  let tasks: ScheduledTask[];
  try { tasks = await listTasks(uid); }
  catch (err) {
    log.warn(`tick read failed uid=${uid}: ${(err as Error).message}`);
    return;
  }
  if (!tasks.length) return;
  const now = new Date();
  const dueIds: ScheduledTask[] = [];
  for (const t of tasks) {
    const lastRun = t.last_run_at ? new Date(t.last_run_at) : null;
    if (isDue(t, now, lastRun)) dueIds.push(t);
  }
  if (!dueIds.length) return;
  // Mark all due as ran-at-now BEFORE dispatching so a slow fire can't
  // get re-picked on the next tick (the file write is the dedupe gate).
  const stampIso = now.toISOString();
  for (const t of dueIds) {
    try { await _markRan(uid, t.id, stampIso); }
    catch (err) { log.warn(`mark-ran failed id=${t.id}: ${(err as Error).message}`); }
  }
  // Dispatch in parallel. Each fire is independent — one failure doesn't
  // block the others.
  await Promise.allSettled(dueIds.map((t) => _fireTask(uid, t)));
}

export function startScheduler(): void {
  if (_timer) return;
  _timer = setInterval(() => {
    _tick().catch((err) => log.warn(`tick threw: ${(err as Error).message}`));
  }, TICK_MS);
  // node's Timeout has `.unref()` so the scheduler does not keep the
  // event loop alive on shutdown.
  if (typeof (_timer as any).unref === 'function') (_timer as any).unref();
  log.info(`scheduler started tick=${TICK_MS}ms`);
}

export function stopScheduler(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
  log.info('scheduler stopped');
}
