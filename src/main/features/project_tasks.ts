/**
 * To-do tasks — project backlogs plus account-level global tasks.
 *
 * The third layer of a project's work-state (see
 * Common/docs/plans/project-work-state.md):
 *   - goal + rules   → ORKAS.md  (user-owned, agent read-only)   [projects.ts]
 *   - TASKS (here)   → tasks/<tid>.json  (user + agent, structured, shared)
 *   - decisions/notes→ MEMORY.md (agent freeform)                [memory.ts]
 *
 * Storage: ONE file per task under `<uid>/cloud/projects/<pid>/tasks/<tid>.json`
 * for project tasks or `<uid>/cloud/tasks/<tid>.json` for global tasks.
 * Per-task files — not a single array — so
 * multi-agent / multi-device concurrent edits of DIFFERENT tasks never
 * sync-conflict; listing is a directory scan (directory-is-truth, no aggregate
 * index — mirrors `projects.ts`). Files are plain + human-readable (owner stored
 * as NAME + id) so the user can open, review, and edit anything an agent wrote.
 *
 * Owner reference: `owner_agent` is a display NAME (LLM/user-facing; ids are
 * error-prone for an LLM to write). `owner_agent_id` is the resolved id, kept
 * for a stable link across agent rename. This layer only VALIDATES an
 * already-resolved `owner_agent_id` against the project bindings; the name→id
 * resolution lives with the caller (P0 UI picks from bound agents; the P1
 * `todo_tasks` tool resolves before calling here).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { Mutex } from 'async-mutex';

import * as path from 'node:path';

import {
  projectTasksDir,
  projectTaskFile,
  projectTaskAttachmentsDir,
  userTasksDir,
  userTaskFile,
  userTaskAttachmentsDir,
} from '../paths';
import { nowIso, readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import { ALLOWED_EXTENSIONS } from './chat_attachments';
import * as projects from './projects';

const log = createLogger('project-tasks');

export type TaskStatus = 'todo' | 'progress' | 'review' | 'done';
const STATUSES: readonly TaskStatus[] = ['todo', 'progress', 'review', 'done'];
// Review is unfinished work awaiting confirmation, so it counts as open.
const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['todo', 'progress', 'review']);

export const TASK_TITLE_MAX = 200;
export const TASK_DETAIL_MAX = 2000;
export const TASK_RESULT_REF_MAX = 400;

export interface ProjectTask {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  /** Agent display NAME (user/LLM-facing). */
  owner_agent?: string;
  /** Resolved agent id (stable across rename); validated against bindings. */
  owner_agent_id?: string;
  /** 'user' or an agent display name. */
  created_by: string;
  depends_on?: string[];
  /** Pointer to the delivering conversation cid / artifact / file. */
  result_ref?: string;
  /** First conversation that created/worked the task; immutable once linked. */
  origin_cid?: string;
  /** Filenames under `task_attachments/<id>/`, copied into the conversation the
   *  task starts (manual Run or the auto-advance driver), like the composer's. */
  attachments?: string[];
  created_at: string;
  updated_at: string;
  done_at?: string;
}

export type TaskError =
  | 'project_not_found'
  | 'task_not_found'
  | 'title_empty'
  | 'title_too_long'
  | 'detail_too_long'
  | 'bad_status'
  | 'status_conflict'
  | 'owner_not_bound'
  | 'id_taken'
  | 'delete_failed';

const TASK_ID_RE = /^t_[a-f0-9]{12}$/;
const _createLocks = new Map<string, Mutex>();
const _taskUpdateLocks = new Map<string, Mutex>();

function _tasksDir(uid: string, pid: string): string {
  return pid ? projectTasksDir(uid, pid) : userTasksDir(uid);
}

function _taskFile(uid: string, pid: string, tid: string): string {
  return pid ? projectTaskFile(uid, pid, tid) : userTaskFile(uid, tid);
}

function _taskAttachmentsDir(uid: string, pid: string, tid: string): string {
  return pid ? projectTaskAttachmentsDir(uid, pid, tid) : userTaskAttachmentsDir(uid, tid);
}

async function _scopeExists(uid: string, pid: string): Promise<boolean> {
  return !pid || projects.projectExists(uid, pid);
}

function _scopeLog(pid: string): string {
  return pid ? 'project' : 'global';
}

function genTaskId(): string {
  return 't_' + crypto.randomBytes(6).toString('hex');
}

function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function canonicalOpenTaskTitle(title: string): string {
  let normalized = title.normalize('NFKC').trim();
  const wrappingQuotes: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'],
  ];
  for (const [open, close] of wrappingQuotes) {
    if (normalized.startsWith(open) && normalized.endsWith(close)) {
      normalized = normalized.slice(open.length, -close.length).trim();
      break;
    }
  }
  return normalized.replace(/\s+/g, ' ').toLowerCase();
}

async function withCreateLock<T>(uid: string, pid: string, fn: () => Promise<T>): Promise<T> {
  const key = `${uid}\0${pid}`;
  const lock = _createLocks.get(key) || new Mutex();
  _createLocks.set(key, lock);
  try {
    return await lock.runExclusive(fn);
  } finally {
    if (_createLocks.get(key) === lock && !lock.isLocked()) _createLocks.delete(key);
  }
}

async function withTaskUpdateLock<T>(uid: string, pid: string, tid: string, fn: () => Promise<T>): Promise<T> {
  const key = `${uid}\0${pid}\0${tid}`;
  const lock = _taskUpdateLocks.get(key) || new Mutex();
  _taskUpdateLocks.set(key, lock);
  try {
    return await lock.runExclusive(fn);
  } finally {
    if (_taskUpdateLocks.get(key) === lock && !lock.isLocked()) _taskUpdateLocks.delete(key);
  }
}

/** Coerce a persisted (possibly hand-edited / synced / older-shape) record into
 *  a valid ProjectTask, or null if unusable. Never throws on bad input. */
function _normaliseTask(raw: any): ProjectTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!TASK_ID_RE.test(id)) return null;
  const title = clampStr(raw.title, TASK_TITLE_MAX);
  if (!title) return null;
  // Older names retain their stage; retired blocked/cancelled tasks reopen as
  // todo. Reads preserve the source file; an ordinary edit persists the mapping.
  const storedStatus = raw.status === 'in_progress' ? 'progress'
    : raw.status === 'in_review' ? 'review' : raw.status;
  const status: TaskStatus = STATUSES.includes(storedStatus) ? storedStatus : 'todo';
  const now = nowIso();
  const t: ProjectTask = {
    id,
    title,
    status,
    created_by: typeof raw.created_by === 'string' && raw.created_by ? raw.created_by : 'user',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  };
  const detail = clampStr(raw.detail, TASK_DETAIL_MAX);
  if (detail) t.detail = detail;
  const owner = clampStr(raw.owner_agent, 200);
  if (owner) t.owner_agent = owner;
  if (typeof raw.owner_agent_id === 'string' && raw.owner_agent_id) t.owner_agent_id = raw.owner_agent_id;
  if (Array.isArray(raw.depends_on)) {
    const depCandidates: string[] = raw.depends_on.filter(
      (d: unknown): d is string => typeof d === 'string' && TASK_ID_RE.test(d),
    );
    const deps = [...new Set(depCandidates)];
    if (deps.length) t.depends_on = deps;
  }
  const resultRef = clampStr(raw.result_ref, TASK_RESULT_REF_MAX);
  if (resultRef) t.result_ref = resultRef;
  if (typeof raw.origin_cid === 'string' && raw.origin_cid) t.origin_cid = raw.origin_cid;
  if (Array.isArray(raw.attachments)) {
    const names = [...new Set(
      raw.attachments.map((n: unknown) => _sanitiseAttachmentName(n)).filter((n: string): n is string => !!n),
    )] as string[];
    if (names.length) t.attachments = names;
  }
  if (status === 'done' && typeof raw.done_at === 'string' && raw.done_at) t.done_at = raw.done_at;
  return t;
}

// Attachment names cross OS boundaries via IPC and cloud-synced task JSON. Treat
// both separator styles as directory boundaries, take the basename, and reject
// traversal / dotfiles — host-independent, mirroring auto_tasks._sanitiseFilename.
function _sanitiseAttachmentName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const base = path.posix.basename(name.replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return '';
  return base.length > 200 ? base.slice(0, 200) : base;
}

function _attachmentExtOk(name: string): boolean {
  const i = name.lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i).toLowerCase() : '';
  return ALLOWED_EXTENSIONS.has(ext);
}

async function _readTask(uid: string, pid: string, tid: string): Promise<ProjectTask | null> {
  const f = _taskFile(uid, pid, tid);
  if (!fs.existsSync(f)) return null;
  try {
    return _normaliseTask(await readJson(f));
  } catch (err) {
    log.warn('read task', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), error: logErrorSummary(err) });
    return null;
  }
}

async function _writeTask(uid: string, pid: string, t: ProjectTask): Promise<void> {
  fs.mkdirSync(_tasksDir(uid, pid), { recursive: true });
  await writeJson(_taskFile(uid, pid, t.id), t);
  _notifyDirty(pid);
  _notifyTasksChanged(uid, pid);
}

// Public builds keep project tasks local. The hook remains for test parity.
function _notifyDirty(_pid: string): void {
}

// Local, in-process change notification — index.ts wires it to a renderer
// broadcast so an open project's to-do list refreshes live when a task is
// created/updated/deleted from anywhere (the auto-advance driver, the model's
// todo_tasks tool, another device's sync), not only after a view reload.
export interface TasksChangedEvent { uid: string; pid: string }
type TasksChangedListener = (e: TasksChangedEvent) => void;
const _tasksChangedListeners: TasksChangedListener[] = [];
export function onTasksChanged(cb: TasksChangedListener): void {
  if (typeof cb === 'function') _tasksChangedListeners.push(cb);
}
function _notifyTasksChanged(uid: string, pid: string): void {
  for (const cb of _tasksChangedListeners) {
    try { cb({ uid, pid }); } catch { /* a listener must never break a task write */ }
  }
}

type SyncDeletedNotifier = (relPath: string) => void;
let _syncDeletedNotifierForTest: SyncDeletedNotifier | null = null;

/** Test seam matching the other per-file synced features. */
export function _setSyncDeletedNotifierForTest(fn: SyncDeletedNotifier | null): void {
  _syncDeletedNotifierForTest = fn;
}

function _notifyDeleted(pid: string, tid: string): void {
  const relPath = pid ? `cloud/projects/${pid}/tasks/${tid}.json` : `cloud/tasks/${tid}.json`;
  if (_syncDeletedNotifierForTest) {
    _syncDeletedNotifierForTest(relPath);
  }
}

/** Resolve the owner: an `owner_agent_id`, if given, must be one of the
 *  project's bound agents. Returns the fields to persist, or 'owner_not_bound'. */
async function _resolveOwner(
  uid: string,
  pid: string,
  input: { owner_agent?: string; owner_agent_id?: string },
): Promise<{ owner_agent?: string; owner_agent_id?: string } | 'owner_not_bound'> {
  const id = typeof input.owner_agent_id === 'string' ? input.owner_agent_id.trim() : '';
  const name = clampStr(input.owner_agent, 200);
  if (!id && !name) return {};
  if (!pid) return 'owner_not_bound';
  if (id) {
    const bindings = await projects.getBindings(uid, pid);
    if (!bindings.agents.includes(id)) return 'owner_not_bound';
  }
  const out: { owner_agent?: string; owner_agent_id?: string } = {};
  if (name) out.owner_agent = name;
  if (id) out.owner_agent_id = id;
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────

/** List one scope's tasks (directory scan). Empty pid selects the global scope.
 *  Backlog order = created_at asc. Missing project / tasks dir → []. */
export async function listTasks(uid: string, pid: string): Promise<ProjectTask[]> {
  if (!(await _scopeExists(uid, pid))) return [];
  const dir = _tasksDir(uid, pid);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const tid = e.name.slice(0, -'.json'.length);
    if (TASK_ID_RE.test(tid)) ids.push(tid);
  }
  const tasks = (await Promise.all(ids.map((tid) => _readTask(uid, pid, tid))))
    .filter((t): t is ProjectTask => t !== null);
  // created_at asc, id asc as a tiebreaker so ordering is DETERMINISTIC across
  // reloads (same-ms tasks won't jump around the list on refresh).
  tasks.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id));
  return tasks;
}

/** Read a single task (normalised) or null if missing/malformed. */
export async function getTask(uid: string, pid: string, tid: string): Promise<ProjectTask | null> {
  if (!TASK_ID_RE.test(tid)) return null;
  if (!(await _scopeExists(uid, pid))) return null;
  return _readTask(uid, pid, tid);
}

export interface TaskProgress {
  total: number;
  done: number;
  open: number;
  by_status: Record<TaskStatus, number>;
}

/** Derived progress — never stored (avoids drift). */
export function computeProgress(tasks: readonly ProjectTask[]): TaskProgress {
  const by_status = { todo: 0, progress: 0, review: 0, done: 0 } as Record<TaskStatus, number>;
  for (const t of tasks) by_status[t.status] = (by_status[t.status] || 0) + 1;
  const open = tasks.filter((t) => OPEN_STATUSES.has(t.status)).length;
  return { total: tasks.length, done: by_status.done, open, by_status };
}

/** User/LLM-facing projection. Keeps the full human-readable task record while
 *  excluding the internal stable owner id. Tool-result capping bounds large
 *  backlogs retrieved on demand. */
export interface ProjectTaskView {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  owner_agent?: string;
  depends_on?: string[];
  result_ref?: string;
  origin_cid?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  done_at?: string;
}
export function taskView(t: ProjectTask): ProjectTaskView {
  return {
    id: t.id,
    title: t.title,
    ...(t.detail ? { detail: t.detail } : {}),
    status: t.status,
    ...(t.owner_agent ? { owner_agent: t.owner_agent } : {}),
    ...(t.depends_on?.length ? { depends_on: [...t.depends_on] } : {}),
    ...(t.result_ref ? { result_ref: t.result_ref } : {}),
    ...(t.origin_cid ? { origin_cid: t.origin_cid } : {}),
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.done_at ? { done_at: t.done_at } : {}),
  };
}

export interface CreateTaskInput {
  title: string;
  detail?: string;
  status?: TaskStatus;
  owner_agent?: string;
  owner_agent_id?: string;
  depends_on?: string[];
  origin_cid?: string;
  /** 'user' or an agent display name. */
  created_by?: string;
  /** Caller-supplied id so the editor can upload attachments to a draft task dir
   *  BEFORE the task JSON exists (the renderer pre-allocates it); create then
   *  adopts whatever landed in that dir. Must be a fresh `t_<12hex>`. */
  id?: string;
}

export async function createTask(
  uid: string, pid: string, input: CreateTaskInput,
): Promise<{ ok: true; task: ProjectTask; alreadyExists: boolean } | { ok: false; error: TaskError }> {
  if (!(await _scopeExists(uid, pid))) return { ok: false, error: 'project_not_found' };
  const title = clampStr(input.title, TASK_TITLE_MAX + 1);
  if (!title) return { ok: false, error: 'title_empty' };
  if (title.length > TASK_TITLE_MAX) return { ok: false, error: 'title_too_long' };
  if (input.status && !STATUSES.includes(input.status)) return { ok: false, error: 'bad_status' };
  const detail = clampStr(input.detail, TASK_DETAIL_MAX + 1);
  if (detail && detail.length > TASK_DETAIL_MAX) return { ok: false, error: 'detail_too_long' };
  const owner = await _resolveOwner(uid, pid, input);
  if (owner === 'owner_not_bound') return { ok: false, error: 'owner_not_bound' };
  const dependsOn = Array.isArray(input.depends_on)
    ? [...new Set(input.depends_on.filter((dependency) => TASK_ID_RE.test(dependency)))]
    : [];

  const requestedStatus = input.status || 'todo';
  return withCreateLock(uid, pid, async () => {
    // A caller-supplied id lets the editor stage attachments before the task
    // JSON exists. Validate collisions under the same create lock that owns
    // title de-duplication so concurrent creates cannot steal a draft.
    const suppliedId = typeof input.id === 'string' && TASK_ID_RE.test(input.id) ? input.id : '';
    if (suppliedId && fs.existsSync(_taskFile(uid, pid, suppliedId))) {
      return { ok: false as const, error: 'id_taken' as const };
    }
    if (!suppliedId && OPEN_STATUSES.has(requestedStatus)) {
      const canonicalTitle = canonicalOpenTaskTitle(title);
      const existing = (await listTasks(uid, pid)).find((task) => (
        OPEN_STATUSES.has(task.status)
        && canonicalOpenTaskTitle(task.title) === canonicalTitle
      ));
      if (existing) {
        log.info('reused open task', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(existing.id) });
        return { ok: true, task: existing, alreadyExists: true };
      }
    }

    const id = suppliedId || genTaskId();
    const attachments = suppliedId ? _scanAttachmentsDir(uid, pid, id) : [];
    const now = nowIso();
    const task: ProjectTask = {
      id,
      title,
      status: requestedStatus,
      created_by: clampStr(input.created_by, 200) || 'user',
      created_at: now,
      updated_at: now,
      ...(detail ? { detail } : {}),
      ...owner,
      ...(dependsOn.length ? { depends_on: dependsOn } : {}),
      ...(typeof input.origin_cid === 'string' && input.origin_cid ? { origin_cid: input.origin_cid } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    await _writeTask(uid, pid, task);
    log.info('created', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(task.id), status: task.status });
    return { ok: true, task, alreadyExists: false };
  });
}

export interface UpdateTaskPatch {
  title?: string;
  detail?: string;
  status?: TaskStatus;
  owner_agent?: string;
  owner_agent_id?: string;
  result_ref?: string;
  /** Current task conversation. It is written only when the task has no
   *  association yet; later conversations can update the task but cannot
   *  replace its first associated conversation. Host-only, never exposed as
   *  a model or renderer input field. */
  origin_cid?: string;
}

export async function updateTask(
  uid: string, pid: string, tid: string, patch: UpdateTaskPatch,
  // Host-only optimistic guard: compare and write under the same task lock.
  options: { expectedStatus?: TaskStatus } = {},
): Promise<{ ok: true; task: ProjectTask } | { ok: false; error: TaskError }> {
  if (!TASK_ID_RE.test(tid)) return { ok: false, error: 'task_not_found' };
  return withTaskUpdateLock(uid, pid, tid, async () => {
    if (!(await _scopeExists(uid, pid))) return { ok: false, error: 'project_not_found' };
    const cur = await _readTask(uid, pid, tid);
    if (!cur) return { ok: false, error: 'task_not_found' };
    if (options.expectedStatus !== undefined && cur.status !== options.expectedStatus) {
      return { ok: false, error: 'status_conflict' };
    }

    const next: ProjectTask = { ...cur };
    if (patch.title !== undefined) {
      const title = clampStr(patch.title, TASK_TITLE_MAX + 1);
      if (!title) return { ok: false, error: 'title_empty' };
      if (title.length > TASK_TITLE_MAX) return { ok: false, error: 'title_too_long' };
      next.title = title;
    }
    if (patch.detail !== undefined) {
      const detail = clampStr(patch.detail, TASK_DETAIL_MAX + 1);
      if (detail && detail.length > TASK_DETAIL_MAX) return { ok: false, error: 'detail_too_long' };
      if (detail) next.detail = detail; else delete next.detail;
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) return { ok: false, error: 'bad_status' };
      next.status = patch.status;
      if (patch.status === 'done') next.done_at = nowIso();
      else delete next.done_at;
    }
    if (patch.owner_agent !== undefined || patch.owner_agent_id !== undefined) {
      const owner = await _resolveOwner(uid, pid, patch);
      if (owner === 'owner_not_bound') return { ok: false, error: 'owner_not_bound' };
      delete next.owner_agent; delete next.owner_agent_id;
      if (owner.owner_agent) next.owner_agent = owner.owner_agent;
      if (owner.owner_agent_id) next.owner_agent_id = owner.owner_agent_id;
    }
    if (patch.result_ref !== undefined) {
      const ref = clampStr(patch.result_ref, TASK_RESULT_REF_MAX);
      if (ref) next.result_ref = ref; else delete next.result_ref;
    }
    if (!next.origin_cid && typeof patch.origin_cid === 'string' && patch.origin_cid.trim()) {
      next.origin_cid = patch.origin_cid.trim();
    }
    next.updated_at = nowIso();
    await _writeTask(uid, pid, next);
    log.info('updated', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), status: next.status });
    return { ok: true, task: next };
  });
}

/** Shortcut: mark done + record an optional result pointer. */
export async function completeTask(
  uid: string, pid: string, tid: string, resultRef?: string,
): Promise<{ ok: true; task: ProjectTask } | { ok: false; error: TaskError }> {
  return updateTask(uid, pid, tid, { status: 'done', ...(resultRef ? { result_ref: resultRef } : {}) });
}

/** Human review decision on a task that is awaiting review. `approved` → done,
 *  `changes_requested` → progress. Rejects with `not_in_review` when the task
 *  is not currently `review`. The decider is always the user (single-user
 *  app), so no reviewer/note fields are stored — change-request feedback travels
 *  through the project conversation, Orkas's native feedback channel. */
export async function decideReview(
  uid: string, pid: string, tid: string, decision: 'approved' | 'changes_requested',
): Promise<{ ok: true; task: ProjectTask } | { ok: false; error: TaskError | 'not_in_review' }> {
  if (!(await _scopeExists(uid, pid))) return { ok: false, error: 'project_not_found' };
  const result = await updateTask(uid, pid, tid,
    { status: decision === 'approved' ? 'done' : 'progress' },
    { expectedStatus: 'review' });
  return result.ok === false && result.error === 'status_conflict'
    ? { ok: false, error: 'not_in_review' }
    : result;
}

export async function deleteTask(
  uid: string, pid: string, tid: string,
): Promise<{ ok: true } | { ok: false; error: TaskError }> {
  if (!TASK_ID_RE.test(tid)) return { ok: false, error: 'task_not_found' };
  return withTaskUpdateLock(uid, pid, tid, async () => {
    const f = _taskFile(uid, pid, tid);
    if (!fs.existsSync(f)) return { ok: false, error: 'task_not_found' };
    try { await fsp.unlink(f); }
    catch (err) {
      log.warn('delete task', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), error: logErrorSummary(err) });
      return { ok: false, error: 'delete_failed' };
    }
    // Drop the task's attachments too so its files don't linger in the scope.
    try { fs.rmSync(_taskAttachmentsDir(uid, pid, tid), { recursive: true, force: true }); }
    catch (err) { log.warn('delete task attachments', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), error: logErrorSummary(err) }); }
    _notifyDeleted(pid, tid);
    _notifyDirty(pid);
    _notifyTasksChanged(uid, pid);
    log.info('deleted', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid) });
    return { ok: true };
  });
}

// ── Attachments ─────────────────────────────────────────────────────────────
// Files a task carries into the conversation it starts (manual Run / the driver),
// mirroring auto_tasks. The directory `task_attachments/<tid>/` is the source of
// truth; the task JSON caches the sanitized name list (drives the row indicator
// and the fire-copy) and is re-derived from the dir on every upload/delete so the
// two never drift. The editor uploads to a pre-allocated tid before the task JSON
// exists (a "draft"); create() then adopts whatever is in that dir.

// Reject anything that would blow up local disk on a single write. Per-kind caps
// are re-checked by the composer's manifest builder when the files are read back
// at LLM turn time, so this is only a coarse abuse guard.
export const TASK_ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;

function _scanAttachmentsDir(uid: string, pid: string, tid: string): string[] {
  if (!TASK_ID_RE.test(tid)) return [];
  const dir = _taskAttachmentsDir(uid, pid, tid);
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    const safe = _sanitiseAttachmentName(n);
    if (!safe) continue;
    try { if (!fs.statSync(path.join(dir, safe)).isFile()) continue; }
    catch { continue; }
    out.push(safe);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// Re-derive the task JSON's cached attachment list from the dir (authoritative).
// No-op when the task JSON doesn't exist yet (a draft — create() adopts the dir).
async function _syncAttachmentList(uid: string, pid: string, tid: string): Promise<void> {
  await withTaskUpdateLock(uid, pid, tid, async () => {
    const cur = await _readTask(uid, pid, tid);
    if (!cur) return;
    const names = _scanAttachmentsDir(uid, pid, tid);
    if (names.length) cur.attachments = names; else delete cur.attachments;
    cur.updated_at = nowIso();
    await _writeTask(uid, pid, cur);
  });
}

/** List a task's attachment filenames (directory scan). */
export async function listTaskAttachments(uid: string, pid: string, tid: string): Promise<string[]> {
  if (!(await _scopeExists(uid, pid))) return [];
  return _scanAttachmentsDir(uid, pid, tid);
}

/** Stage one attachment under the task (draft-safe: the task JSON need not exist
 *  yet). Validates the name + type against the composer's whitelist. */
export async function uploadTaskAttachment(
  uid: string, pid: string, tid: string, name: string, buf: Buffer,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (!TASK_ID_RE.test(tid)) return { ok: false, error: 'invalid_task_id' };
  if (!(await _scopeExists(uid, pid))) return { ok: false, error: 'project_not_found' };
  const safe = _sanitiseAttachmentName(name);
  if (!safe) return { ok: false, error: 'invalid_name' };
  if (!_attachmentExtOk(safe)) return { ok: false, error: 'unsupported_type' };
  if (!Buffer.isBuffer(buf) || buf.length > TASK_ATTACHMENT_MAX_BYTES) return { ok: false, error: 'too_large' };
  const dir = _taskAttachmentsDir(uid, pid, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buf);
  } catch (err) {
    log.warn('attachment upload', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), attachment: logPathRef(safe), error: logErrorSummary(err) });
    return { ok: false, error: 'write_failed' };
  }
  await _syncAttachmentList(uid, pid, tid);
  _notifyDirty(pid);
  log.info('attachment uploaded', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), attachment: logPathRef(safe), bytes: buf.length });
  return { ok: true, name: safe };
}

/** Remove one attachment from a task (or its draft dir). */
export async function deleteTaskAttachment(
  uid: string, pid: string, tid: string, name: string,
): Promise<{ ok: boolean }> {
  if (!TASK_ID_RE.test(tid)) return { ok: false };
  const safe = _sanitiseAttachmentName(name);
  if (!safe) return { ok: false };
  const target = path.join(_taskAttachmentsDir(uid, pid, tid), safe);
  try { if (fs.existsSync(target)) fs.unlinkSync(target); }
  catch (err) {
    log.warn('attachment delete', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), attachment: logPathRef(safe), error: logErrorSummary(err) });
    return { ok: false };
  }
  await _syncAttachmentList(uid, pid, tid);
  _notifyDirty(pid);
  return { ok: true };
}

/** Discard a whole draft attachment dir — the editor's "cancel" for a task that
 *  was never saved. Refuses to touch a live task's files (that goes through
 *  deleteTaskAttachment / deleteTask). */
export async function discardTaskAttachmentDraft(uid: string, pid: string, tid: string): Promise<{ ok: boolean }> {
  if (!TASK_ID_RE.test(tid)) return { ok: false };
  if (fs.existsSync(_taskFile(uid, pid, tid))) return { ok: false };
  try { fs.rmSync(_taskAttachmentsDir(uid, pid, tid), { recursive: true, force: true }); }
  catch (err) { log.warn('attachment draft discard', { user: maskId(uid), scope: _scopeLog(pid), tid: maskId(tid), error: logErrorSummary(err) }); return { ok: false }; }
  _notifyDirty(pid);
  return { ok: true };
}
