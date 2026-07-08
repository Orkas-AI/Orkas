/**
 * Auto tasks — sidebar "Automation" tab feature.
 *
 * Each task is a self-contained directory at
 *   `<uid>/cloud/auto_tasks/<task_id>/`
 * holding `config.json` (spec) + `attachments/<filename>` (per-task files
 * pre-staged by the user). Deletion is `rm -rf <task_id>/`; cloud sync
 * ships only the bytes that changed (no global file bottleneck).
 *
 * Fire path: `chats.createConversation({projectId})` → copy attachments
 * into the new conv's `chat_attachments/<cid>/` → `groupChat.send({text,
 * attachments})`. Same single-dispatch bus entry as a manual send (per
 * PC/CLAUDE.md §5).
 *
 * Schedule shapes (Schedule union):
 *   - one_time: { at: ISO datetime }       fires once; after fire enabled=false
 *   - daily:    { hour, minute }
 *   - weekly:   { weekday, hour, minute }
 *   - monthly:  { day, hour, minute }      day=31 → last day of shorter months
 *
 * Scheduler: one in-process `setInterval(TICK_MS)` (30s) started by
 * `startScheduler()` after `activateUser()`. Missed boundaries while the
 * app was closed do NOT back-fire.
 *
 * Fire-time seed text composition (mirrors the commander composer's
 * chip → text chain in `transformWithChatUse` + `applyRecipientPrefix`):
 *   content
 *     wrap with `skills.use_prefix` (if task.skill set)
 *       wrap with `connectors.use_prefix` (if task.connector set)
 *         prepend `@<agent.name> ` (if recipient.kind === 'agent')
 *
 * Content is stored clean (no `@` tokens) — chip refs are the source of
 * truth for routing.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userAutoTasksDir,
  userLocalRoot,
  autoTaskDir,
  autoTaskConfigFile,
  autoTaskAttachmentsDir,
  chatAttachmentDir,
  projectMetaFile,
  projectBindingsFile,
} from '../paths';
import { readJson, writeJson, nowIso, safeId } from '../storage';
import { createLogger } from '../logger';
import { t as translate } from '../i18n';
import { getCurrentDevice } from '../util/device';
import { limitNameDisplayText } from '../util/name-limit';
import { findOuterTagRanges } from '../util/markdown-prose-code';
export { getCurrentDevice };
import { getActiveUserId, hasActiveUser } from './users';
import * as chats from './chats';
import * as groupChat from './group_chat';

const log = createLogger('auto-tasks');

const SCHEMA_VERSION = 2;
const MAX_CONTENT_LEN = 8000;
// Per-user task cap — every tick scans + reads each task's config.json, so a
// runaway count can't be allowed to push a tick past TICK_MS.
const MAX_TASKS_PER_USER = 200;
const AUTO_TASK_CLAIMS_DIR = 'auto_task_claims';

export type ScheduleOneTime = { type: 'one_time'; at: string };
export type ScheduleDaily   = { type: 'daily';   hour: number; minute: number };
export type ScheduleWeekly  = { type: 'weekly';  weekday: number; hour: number; minute: number };
export type ScheduleMonthly = { type: 'monthly'; day: number; hour: number; minute: number };
export type Schedule = ScheduleOneTime | ScheduleDaily | ScheduleWeekly | ScheduleMonthly;

export type TaskRecipient =
  | { kind: 'commander' }
  | { kind: 'agent'; id: string; name: string };

export type TaskSkillRef = { id: string; name: string };
export type TaskConnectorRef = { id: string; name: string };

export interface AutoTask {
  id: string;
  enabled: boolean;
  title?: string;
  content: string;                       // clean text, NO @ tokens
  recipient?: TaskRecipient;
  skill?: TaskSkillRef;
  connector?: TaskConnectorRef;
  project_id?: string;
  schedule: Schedule;
  attachments?: string[];                // file names under <task_dir>/attachments/
  /** Device the task was CREATED on — only this machine fires the schedule.
   *  Every device can still read / edit the config (the file cloud-syncs).
   *  `device_id` is the MAC address of the creator's first non-internal NIC;
   *  `device_name` is the hostname at creation time (display only). Both
   *  immutable after creation — `updateTask` does not accept patches for
   *  these fields. */
  device_id?: string;
  device_name?: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
}

function genTaskId(): string { return 'at_' + crypto.randomBytes(4).toString('hex'); }

/** Renderer-side helper: pre-allocate a task id so attachments can upload
 *  into its dir before the user hits "create". The id is also adopted by
 *  `createTask` when submitted. */
export function allocateDraftTaskId(): string { return genTaskId(); }

// ── Validation ────────────────────────────────────────────────────────────

const _VALID_TASK_ID_RE = /^at_[0-9a-f]{8}$/;
function _isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && _VALID_TASK_ID_RE.test(id);
}

function _isHM(h: unknown, m: unknown): boolean {
  return Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23
    && Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 59;
}

function _isValidSchedule(s: any): s is Schedule {
  if (!s || typeof s !== 'object') return false;
  if (s.type === 'one_time') {
    if (typeof s.at !== 'string' || !s.at) return false;
    const d = new Date(s.at);
    return !Number.isNaN(d.getTime());
  }
  if (s.type === 'daily') return _isHM(s.hour, s.minute);
  if (s.type === 'weekly') {
    return _isHM(s.hour, s.minute)
      && Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6;
  }
  if (s.type === 'monthly') {
    return _isHM(s.hour, s.minute)
      && Number.isInteger(s.day) && s.day >= 1 && s.day <= 31;
  }
  return false;
}

function _isValidRecipient(r: any): r is TaskRecipient {
  if (!r || typeof r !== 'object') return false;
  if (r.kind === 'commander') return true;
  // Agent recipients carry both id (storage / cross-device) and name
  // (the bus router matches `@<name>`, not `@<id>`).
  if (r.kind === 'agent' && typeof r.id === 'string' && r.id
      && typeof r.name === 'string' && r.name) return true;
  return false;
}

function _isValidRef(r: any): r is { id: string; name: string } {
  return !!r && typeof r === 'object'
    && typeof r.id === 'string' && r.id
    && typeof r.name === 'string' && r.name;
}

function _isValidTaskShape(t: any): t is AutoTask {
  if (!t || typeof t !== 'object') return false;
  if (!_isValidTaskId(t.id)) return false;
  if (typeof t.content !== 'string') return false;
  if (typeof t.enabled !== 'boolean') return false;
  if (!_isValidSchedule(t.schedule)) return false;
  if (t.attachments !== undefined) {
    if (!Array.isArray(t.attachments)) return false;
    if (t.attachments.some((n: any) => typeof n !== 'string' || !n)) return false;
  }
  return true;
}

// ── File IO (serialised per uid) ──────────────────────────────────────────

const _tails = new Map<string, Promise<unknown>>();
type SyncDirtyNotifier = (domain: string, relPath: string) => void;
let _syncDirtyNotifierForTest: SyncDirtyNotifier | null = null;

export function _setSyncDirtyNotifierForTest(fn: SyncDirtyNotifier | null): void {
  _syncDirtyNotifierForTest = fn;
}

function _runExclusive<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = _tails.get(uid) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  _tails.set(uid, next);
  return next;
}

async function _readOne(uid: string, taskId: string): Promise<AutoTask | null> {
  const cfg = autoTaskConfigFile(uid, taskId);
  if (!fs.existsSync(cfg)) return null;
  try {
    const raw: any = await readJson(cfg);
    if (!raw || typeof raw !== 'object') return null;
    if (!_isValidTaskShape(raw)) return null;
    return raw;
  } catch (err) {
    log.warn(`read failed uid=${uid} id=${taskId}: ${(err as Error).message}`);
    return null;
  }
}

async function _writeOne(uid: string, task: AutoTask): Promise<void> {
  const dir = autoTaskDir(uid, task.id);
  fs.mkdirSync(dir, { recursive: true });
  await writeJson(autoTaskConfigFile(uid, task.id), task);
  _notifyDirty(`cloud/auto_tasks/${task.id}/config.json`);
}

// Sync engine dirty signal (lazy-require: `features/sync` is stripped from
// the open-source build). Auto tasks live in per-task directories, so a single path hint is
// enough to wake the sync debounce; the engine still scans the whole cloud tree.
function _notifyDirty(relPath: string): void {
  if (_syncDirtyNotifierForTest) {
    _syncDirtyNotifierForTest('auto_tasks', relPath);
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('auto_tasks', relPath);
  } catch { /* features/sync stripped */ }
}

async function _readAll(uid: string): Promise<AutoTask[]> {
  const root = userAutoTasksDir(uid);
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try { entries = fs.readdirSync(root); }
  catch (err) {
    log.warn(`readdir failed uid=${uid}: ${(err as Error).message}`);
    return [];
  }
  const out: AutoTask[] = [];
  for (const name of entries) {
    if (!_isValidTaskId(name)) continue;
    const sub = autoTaskDir(uid, name);
    let st: fs.Stats;
    try { st = fs.statSync(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    const task = await _readOne(uid, name);
    if (task) out.push(task);
  }
  // Newest-first by created_at — a brand-new task lands at the top so the
  // user sees what they just created without scrolling. Stable across
  // ticks because created_at is immutable (unlike last_run_at, which
  // would scramble the list every fire).
  out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return out;
}

// ── Public CRUD ───────────────────────────────────────────────────────────

export type TaskDraft = {
  schedule: Schedule;
  content: string;
  title?: string;
  enabled?: boolean;
  recipient?: TaskRecipient;
  skill?: TaskSkillRef;
  connector?: TaskConnectorRef;
  project_id?: string | null;
  attachments?: string[];
  // Caller-supplied id (renderer pre-allocates so attachments can upload
  // before submit). The pre-allocated id IS also the on-disk dir name.
  id?: string;
};

export type TaskError =
  | 'invalid_schedule'
  | 'invalid_content'
  | 'invalid_recipient'
  | 'invalid_skill'
  | 'invalid_connector'
  | 'invalid_project'
  | 'invalid_id'
  | 'not_found'
  | 'too_many_tasks';

type NormalisedFields = Omit<AutoTask, 'id' | 'created_at' | 'updated_at' | 'last_run_at'>;

function _normaliseDraft(d: TaskDraft): { ok: true; fields: NormalisedFields } | { ok: false; error: TaskError } {
  if (!_isValidSchedule(d.schedule)) return { ok: false, error: 'invalid_schedule' };
  let content = typeof d.content === 'string' ? d.content.trim() : '';
  if (!content) return { ok: false, error: 'invalid_content' };
  if (content.length > MAX_CONTENT_LEN) content = content.slice(0, MAX_CONTENT_LEN);
  let title = typeof d.title === 'string' ? d.title.trim() : '';
  title = limitNameDisplayText(title);
  const enabled = d.enabled === false ? false : true;
  let recipient: TaskRecipient | undefined;
  if (d.recipient !== undefined) {
    if (!_isValidRecipient(d.recipient)) return { ok: false, error: 'invalid_recipient' };
    recipient = d.recipient;
  }
  let skill: TaskSkillRef | undefined;
  if (d.skill !== undefined) {
    if (!_isValidRef(d.skill)) return { ok: false, error: 'invalid_skill' };
    skill = { id: d.skill.id, name: d.skill.name };
  }
  let connector: TaskConnectorRef | undefined;
  if (d.connector !== undefined) {
    if (!_isValidRef(d.connector)) return { ok: false, error: 'invalid_connector' };
    connector = { id: d.connector.id, name: d.connector.name };
  }
  const projectId = typeof d.project_id === 'string' && d.project_id ? d.project_id : undefined;
  if (projectId && !safeId(projectId)) return { ok: false, error: 'invalid_project' };
  const attachments = Array.isArray(d.attachments)
    ? d.attachments.filter((n) => typeof n === 'string' && n.length > 0)
    : undefined;
  return {
    ok: true,
    fields: {
      enabled,
      content,
      schedule: d.schedule,
      ...(title ? { title } : {}),
      ...(recipient ? { recipient } : {}),
      ...(skill ? { skill } : {}),
      ...(connector ? { connector } : {}),
      ...(projectId ? { project_id: projectId } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
    },
  };
}

async function _projectAllowsRecipientAgent(uid: string, fields: NormalisedFields): Promise<boolean> {
  const projectId = fields.project_id;
  const recipient = fields.recipient;
  if (!projectId || !recipient || recipient.kind !== 'agent') return true;
  if (!fs.existsSync(projectMetaFile(uid, projectId))) return true;
  const raw: any = await readJson(projectBindingsFile(uid, projectId));
  const allowed = Array.isArray(raw?.agents)
    ? raw.agents.filter((id: any) => typeof id === 'string' && id)
    : [];
  return allowed.includes(recipient.id);
}

export async function listTasks(uid: string, opts?: { projectId?: string | null }): Promise<AutoTask[]> {
  return _runExclusive(uid, async () => {
    const all = await _readAll(uid);
    if (!opts) return all;
    if (opts.projectId === null) return all.filter((t) => !t.project_id);
    if (typeof opts.projectId === 'string' && opts.projectId) {
      const pid = opts.projectId;
      return all.filter((t) => t.project_id === pid);
    }
    return all;
  });
}

export async function getTask(uid: string, taskId: string): Promise<AutoTask | null> {
  if (!_isValidTaskId(taskId)) return null;
  return _runExclusive(uid, () => _readOne(uid, taskId));
}

export async function createTask(
  uid: string, draft: TaskDraft,
): Promise<{ ok: true; task: AutoTask } | { ok: false; error: TaskError }> {
  const norm = _normaliseDraft(draft);
  if (!norm.ok) return { ok: false, error: (norm as { error: TaskError }).error };
  const desiredId = draft.id !== undefined
    ? (_isValidTaskId(draft.id) ? draft.id : null)
    : genTaskId();
  if (desiredId === null) return { ok: false, error: 'invalid_id' };
  return _runExclusive(uid, async () => {
    const all = await _readAll(uid);
    if (all.length >= MAX_TASKS_PER_USER) {
      log.warn(`task create rejected uid=${uid} reason=too_many_tasks count=${all.length} cap=${MAX_TASKS_PER_USER}`);
      return { ok: false as const, error: 'too_many_tasks' as const };
    }
    if (all.some((t) => t.id === desiredId)) {
      log.warn(`task create id collision uid=${uid} id=${desiredId}`);
      return { ok: false as const, error: 'too_many_tasks' as const };
    }
    if (!await _projectAllowsRecipientAgent(uid, norm.fields)) {
      return { ok: false as const, error: 'invalid_recipient' as const };
    }
    const now = nowIso();
    const device = getCurrentDevice();
    const task: AutoTask = {
      id: desiredId,
      ...norm.fields,
      ...(device.id ? { device_id: device.id } : {}),
      device_name: device.name,
      created_at: now,
      updated_at: now,
    };
    await _writeOne(uid, task);
    log.info(`task created uid=${uid} id=${task.id} type=${task.schedule.type} project=${task.project_id || '-'} attachments=${(task.attachments || []).length} device=${device.name}`);
    _scheduleTask(uid, task);
    return { ok: true as const, task };
  });
}

export async function updateTask(
  uid: string, taskId: string, patch: Partial<TaskDraft>,
): Promise<{ ok: true; task: AutoTask } | { ok: false; error: TaskError }> {
  if (!_isValidTaskId(taskId)) return { ok: false, error: 'invalid_id' };
  return _runExclusive(uid, async () => {
    const cur = await _readOne(uid, taskId);
    if (!cur) return { ok: false as const, error: 'not_found' as const };
    const merged: TaskDraft = {
      schedule: patch.schedule ? patch.schedule : cur.schedule,
      content: typeof patch.content === 'string' ? patch.content : cur.content,
      title: typeof patch.title === 'string' ? patch.title : cur.title,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      recipient: patch.recipient !== undefined ? patch.recipient : cur.recipient,
      // Explicit `null` in the patch clears the field; `undefined` keeps
      // the current value. Mirrors the chip close-button on the renderer.
      skill: patch.skill === null ? undefined : (patch.skill !== undefined ? patch.skill : cur.skill),
      connector: patch.connector === null ? undefined : (patch.connector !== undefined ? patch.connector : cur.connector),
      project_id: patch.project_id === null
        ? undefined
        : (typeof patch.project_id === 'string' ? patch.project_id : cur.project_id),
      attachments: patch.attachments !== undefined ? patch.attachments : cur.attachments,
    };
    const norm = _normaliseDraft(merged);
    if (!norm.ok) return { ok: false as const, error: (norm as { error: TaskError }).error };
    if (!await _projectAllowsRecipientAgent(uid, norm.fields)) {
      return { ok: false as const, error: 'invalid_recipient' as const };
    }
    const next: AutoTask = {
      ...cur,
      ...norm.fields,
      updated_at: nowIso(),
    };
    // Strip optional fields when they normalised away.
    if (!norm.fields.title) delete next.title;
    if (!norm.fields.recipient) delete next.recipient;
    if (!norm.fields.skill) delete next.skill;
    if (!norm.fields.connector) delete next.connector;
    if (!norm.fields.project_id) delete next.project_id;
    if (!norm.fields.attachments) delete next.attachments;
    await _writeOne(uid, next);
    log.info(`task updated uid=${uid} id=${taskId}`);
    _scheduleTask(uid, next);
    return { ok: true as const, task: next };
  });
}

export async function deleteTask(uid: string, taskId: string): Promise<{ ok: boolean }> {
  if (!_isValidTaskId(taskId)) return { ok: false };
  return _runExclusive(uid, async () => {
    const dir = autoTaskDir(uid, taskId);
    if (!fs.existsSync(dir)) return { ok: false };
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      _notifyDirty(`cloud/auto_tasks/${taskId}/config.json`);
      log.info(`task deleted uid=${uid} id=${taskId}`);
      _cancelTimer(taskId);
      return { ok: true };
    } catch (err) {
      log.warn(`task delete failed uid=${uid} id=${taskId}: ${(err as Error).message}`);
      return { ok: false };
    }
  });
}

export async function setTaskEnabled(
  uid: string, taskId: string, enabled: boolean,
): Promise<{ ok: true; task: AutoTask } | { ok: false; error: TaskError }> {
  if (!_isValidTaskId(taskId)) return { ok: false, error: 'invalid_id' };
  return _runExclusive(uid, async () => {
    const cur = await _readOne(uid, taskId);
    if (!cur) return { ok: false as const, error: 'not_found' as const };
    const next: AutoTask = { ...cur, enabled: !!enabled, updated_at: nowIso() };
    await _writeOne(uid, next);
    _scheduleTask(uid, next);
    return { ok: true as const, task: next };
  });
}

// ── Commander `<auto-task>` container ────────────────────────────────────
//
// Mutations requested by the commander use a structural block, parallel to
// `<agent>` / `<skill>`. The model never writes `config.json` directly; it
// emits this container and the bus applies it through the same CRUD functions
// used by the renderer.

const AUTO_TASK_OPEN_TAG = '<auto-task>';
const AUTO_TASK_CLOSE_TAG = '</auto-task>';
const AUTO_TASK_CHILD_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

export type AutoTaskContainerAction = 'create' | 'update' | 'delete' | 'enable' | 'disable';

export interface AutoTaskContainerExtracted {
  action?: AutoTaskContainerAction;
  taskId?: string;
  updates: Partial<TaskDraft>;
}

export interface AutoTaskContainerResult {
  ok: boolean;
  kind?: 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled';
  task?: AutoTask;
  taskId?: string;
  title?: string;
  error?: string;
}

export interface AutoTaskContainerApplyOptions {
  /** Conversation whose current message attachments should be copied into
   *  the task's attachment directory when `<attachments>` is present. */
  sourceAttachmentCid?: string;
}

function _childText(inner: string, tag: string): string | undefined {
  const m = inner.match(AUTO_TASK_CHILD_RE(tag));
  return m ? m[1].trim() : undefined;
}

function _parseJsonChild<T>(inner: string, tag: string): T | undefined {
  const raw = _childText(inner, tag);
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log.warn(`<auto-task><${tag}> JSON parse failed: ${(err as Error).message}`);
    return undefined;
  }
}

function _parseMaybeClearableRef<T>(inner: string, tag: string): T | null | undefined {
  const raw = _childText(inner, tag);
  if (raw === undefined) return undefined;
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log.warn(`<auto-task><${tag}> JSON parse failed: ${(err as Error).message}`);
    return undefined;
  }
}

function _parseAutoTaskAction(raw: string | undefined): AutoTaskContainerAction | undefined {
  const v = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (v === 'create') return 'create';
  if (v === 'update' || v === 'edit') return 'update';
  if (v === 'delete' || v === 'remove') return 'delete';
  if (v === 'enable') return 'enable';
  if (v === 'disable') return 'disable';
  return undefined;
}

function _parseAutoTaskBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function _parseAutoTaskContainer(inner: string): AutoTaskContainerExtracted {
  const updates: Partial<TaskDraft> = {};
  const action = _parseAutoTaskAction(_childText(inner, 'action'));
  const taskId = _childText(inner, 'task_id');
  const title = _childText(inner, 'title');
  const content = _childText(inner, 'content');
  const projectId = _childText(inner, 'project_id');
  const enabled = _parseAutoTaskBool(_childText(inner, 'enabled'));
  const schedule = _parseJsonChild<Schedule>(inner, 'schedule');
  const recipient = _parseJsonChild<TaskRecipient>(inner, 'recipient');
  const skill = _parseMaybeClearableRef<TaskSkillRef>(inner, 'skill');
  const connector = _parseMaybeClearableRef<TaskConnectorRef>(inner, 'connector');
  const attachments = _parseJsonChild<string[]>(inner, 'attachments');

  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;
  if (enabled !== undefined) updates.enabled = enabled;
  if (schedule !== undefined) updates.schedule = schedule;
  if (recipient !== undefined) updates.recipient = recipient;
  if (skill !== undefined) updates.skill = skill as any;
  if (connector !== undefined) updates.connector = connector as any;
  if (projectId !== undefined) updates.project_id = projectId || null;
  if (Array.isArray(attachments)) {
    updates.attachments = attachments
      .map((name) => _sanitiseFilename(String(name || '')))
      .filter((name) => !!name);
  }

  return {
    ...(action ? { action } : {}),
    ...(taskId && _isValidTaskId(taskId) ? { taskId } : {}),
    updates,
  };
}

export function extractAutoTaskContainers(
  text: string,
): { cleanText: string; containers: AutoTaskContainerExtracted[] } {
  if (!text || text.indexOf(AUTO_TASK_OPEN_TAG) < 0) return { cleanText: text, containers: [] };
  const ranges = findOuterTagRanges(text, 'auto-task');
  if (!ranges.length) return { cleanText: text, containers: [] };
  const containers: AutoTaskContainerExtracted[] = [];
  let cleaned = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    cleaned += text.slice(cursor, s);
    const block = text.slice(s, e);
    if (block.startsWith(AUTO_TASK_OPEN_TAG) && block.endsWith(AUTO_TASK_CLOSE_TAG)) {
      const inner = block.slice(AUTO_TASK_OPEN_TAG.length, block.length - AUTO_TASK_CLOSE_TAG.length);
      containers.push(_parseAutoTaskContainer(inner));
    }
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, containers };
}

function _autoTaskResultTitle(task: AutoTask | null | undefined, fallbackId: string): string {
  const title = String(task?.title || '').trim();
  if (title) return title;
  const content = String(task?.content || '').trim();
  if (content) return content.slice(0, 40);
  return fallbackId;
}

export async function applyAutoTaskContainerFromCommander(
  uid: string,
  container: AutoTaskContainerExtracted,
  opts: AutoTaskContainerApplyOptions = {},
): Promise<AutoTaskContainerResult> {
  const action = container.action || (container.taskId ? 'update' : 'create');
  const taskId = container.taskId || '';
  try {
    if (action === 'create') {
      const result = await createTask(uid, container.updates as TaskDraft);
      if (!result.ok) return { ok: false, error: (result as { error: string }).error };
      await _stageContainerAttachments(uid, result.task.id, container, opts);
      return {
        ok: true,
        kind: 'created',
        task: result.task,
        taskId: result.task.id,
        title: _autoTaskResultTitle(result.task, result.task.id),
      };
    }
    if (!taskId) return { ok: false, error: 'task_id_required' };
    if (action === 'delete') {
      const before = await getTask(uid, taskId);
      const result = await deleteTask(uid, taskId);
      if (!result.ok) return { ok: false, error: 'not_found' };
      return {
        ok: true,
        kind: 'deleted',
        taskId,
        title: _autoTaskResultTitle(before, taskId),
      };
    }
    if (action === 'enable' || action === 'disable') {
      const result = await setTaskEnabled(uid, taskId, action === 'enable');
      if (!result.ok) return { ok: false, error: (result as { error: string }).error };
      return {
        ok: true,
        kind: action === 'enable' ? 'enabled' : 'disabled',
        task: result.task,
        taskId,
        title: _autoTaskResultTitle(result.task, taskId),
      };
    }
    if (!Object.keys(container.updates).length) return { ok: false, error: 'empty_update' };
    const result = await updateTask(uid, taskId, container.updates);
    if (!result.ok) return { ok: false, error: (result as { error: string }).error };
    await _stageContainerAttachments(uid, taskId, container, opts);
    return {
      ok: true,
      kind: 'updated',
      task: result.task,
      taskId,
      title: _autoTaskResultTitle(result.task, taskId),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

async function _stageContainerAttachments(
  uid: string,
  taskId: string,
  container: AutoTaskContainerExtracted,
  opts: AutoTaskContainerApplyOptions,
): Promise<void> {
  if (!_isValidTaskId(taskId)) return;
  const names = Array.isArray(container.updates.attachments)
    ? container.updates.attachments.map((name) => _sanitiseFilename(name)).filter((name) => !!name)
    : [];
  if (!names.length || !opts.sourceAttachmentCid) return;
  const srcDir = chatAttachmentDir(uid, opts.sourceAttachmentCid);
  const destDir = autoTaskAttachmentsDir(uid, taskId);
  if (!fs.existsSync(srcDir)) return;
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { return; }
  for (const name of names) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(destDir, name));
      _notifyDirty(`cloud/auto_tasks/${taskId}/attachments/${name}`);
    } catch (err) {
      log.warn(`container attachment stage failed uid=${uid} id=${taskId} name=${name}: ${(err as Error).message}`);
    }
  }
}

async function _markRan(uid: string, taskId: string, atIso: string, alsoDisable: boolean): Promise<void> {
  if (!_isValidTaskId(taskId)) return;
  await _runExclusive(uid, async () => {
    const cur = await _readOne(uid, taskId);
    if (!cur) return;
    const next: AutoTask = {
      ...cur,
      last_run_at: atIso,
      ...(alsoDisable ? { enabled: false } : {}),
    };
    await _writeOne(uid, next);
  });
}

// ── Attachment management ────────────────────────────────────────────────

export async function listAttachments(uid: string, taskId: string): Promise<string[]> {
  if (!_isValidTaskId(taskId)) return [];
  const dir = autoTaskAttachmentsDir(uid, taskId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((n) => {
      if (n.startsWith('.')) return false;
      try { return fs.statSync(path.join(dir, n)).isFile(); }
      catch { return false; }
    });
  } catch {
    return [];
  }
}

export async function uploadAttachment(
  uid: string, taskId: string, name: string, buf: Buffer,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (!_isValidTaskId(taskId)) return { ok: false, error: 'invalid_task_id' };
  const safe = _sanitiseFilename(name);
  if (!safe) return { ok: false, error: 'invalid_name' };
  const dir = autoTaskAttachmentsDir(uid, taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buf);
    _notifyDirty(`cloud/auto_tasks/${taskId}/attachments/${safe}`);
    log.info(`attachment uploaded uid=${uid} id=${taskId} name=${safe} bytes=${buf.length}`);
    return { ok: true, name: safe };
  } catch (err) {
    log.warn(`attachment upload failed uid=${uid} id=${taskId} name=${safe}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteAttachment(uid: string, taskId: string, name: string): Promise<{ ok: boolean }> {
  if (!_isValidTaskId(taskId)) return { ok: false };
  const safe = _sanitiseFilename(name);
  if (!safe) return { ok: false };
  const target = path.join(autoTaskAttachmentsDir(uid, taskId), safe);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    _notifyDirty(`cloud/auto_tasks/${taskId}/attachments/${safe}`);
    return { ok: true };
  } catch (err) {
    log.warn(`attachment delete failed uid=${uid} id=${taskId} name=${safe}: ${(err as Error).message}`);
    return { ok: false };
  }
}

function _sanitiseFilename(name: string): string {
  if (typeof name !== 'string') return '';
  const base = path.basename(name).replace(/[\\/]+/g, '_').trim();
  if (!base || base === '.' || base === '..') return '';
  if (base.startsWith('.')) return '';
  return base.length > 200 ? base.slice(0, 200) : base;
}

// ── Due-time computation ────────────────────────────────────────────────

/** True iff the task should fire at `now` given its last run. */
export function isDue(task: AutoTask, now: Date, lastRun: Date | null): boolean {
  return _dueBoundary(task, now, lastRun) !== null;
}

function _dueBoundary(task: AutoTask, now: Date, lastRun: Date | null): Date | null {
  if (!task.enabled) return null;
  const sched = task.schedule;
  if (sched.type === 'one_time') {
    if (lastRun) return null; // one_time fires at most once
    const at = new Date(sched.at);
    if (Number.isNaN(at.getTime())) return null;
    return now.getTime() >= at.getTime() ? at : null;
  }
  if (sched.type === 'daily') {
    return _crossedTodayBoundary(now, lastRun, sched.hour, sched.minute);
  }
  if (sched.type === 'weekly') {
    if (now.getDay() !== sched.weekday) return null;
    return _crossedTodayBoundary(now, lastRun, sched.hour, sched.minute);
  }
  if (sched.type === 'monthly') {
    const todayDom = now.getDate();
    const lastDom = _lastDayOfMonth(now);
    const targetDom = Math.min(sched.day, lastDom); // day=31 → last day of month
    if (todayDom !== targetDom) return null;
    return _crossedTodayBoundary(now, lastRun, sched.hour, sched.minute);
  }
  return null;
}

function _crossedTodayBoundary(now: Date, lastRun: Date | null, hour: number, minute: number): Date | null {
  const boundary = new Date(now);
  boundary.setHours(hour, minute, 0, 0);
  if (now.getTime() < boundary.getTime()) return null;
  if (!lastRun) return boundary;
  return lastRun.getTime() < boundary.getTime() ? boundary : null;
}

function _lastDayOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function _claimFile(uid: string, taskId: string, boundary: Date): string {
  return path.join(userLocalRoot(uid), AUTO_TASK_CLAIMS_DIR, taskId, `${boundary.getTime()}.json`);
}

function _tryClaimFireBoundary(uid: string, task: AutoTask, boundary: Date, now: Date): boolean {
  const file = _claimFile(uid, task.id, boundary);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      task_id: task.id,
      boundary_at: boundary.toISOString(),
      claimed_at: now.toISOString(),
      pid: process.pid,
      device_id: getCurrentDevice().id || '',
      device_name: getCurrentDevice().name || '',
    }, null, 2), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // If the local claim directory is temporarily unavailable, keep the task
    // available rather than silently dropping the scheduled run. Normal data
    // roots are writable; this branch is defensive for odd filesystem states.
    log.warn(`fire claim unavailable uid=${uid} id=${task.id}: ${(err as Error).message}`);
    return true;
  }
}

function _releaseFireBoundaryClaim(uid: string, task: AutoTask, boundary: Date): void {
  const file = _claimFile(uid, task.id, boundary);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    log.warn(`fire claim release failed uid=${uid} id=${task.id}: ${(err as Error).message}`);
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────

function _formatSeedPrefix(
  key: string,
  vars: Record<string, string>,
  fallback: string,
): string {
  const translated = translate(key, vars);
  return translated === key ? fallback : translated;
}

/** Compose the seed message dispatched on fire. Mirrors the commander
 *  composer's chip → text chain (transformWithChatUse + applyRecipientPrefix). */
function _buildSeedText(task: AutoTask): string {
  let text = (task.content || '').trim();
  if (task.skill && task.skill.name) {
    const name = task.skill.name;
    text = _formatSeedPrefix(
      'skills.use_prefix',
      { skill: name, content: text },
      `Use ${name} skill: ${text}`,
    );
  }
  if (task.connector && task.connector.name) {
    const name = task.connector.name;
    text = _formatSeedPrefix(
      'connectors.use_prefix',
      { connector: name, content: text },
      `Use ${name} connector: ${text}`,
    );
  }
  if (task.recipient && task.recipient.kind === 'agent' && task.recipient.name) {
    text = `@${task.recipient.name} ${text}`;
  }
  return text;
}

export function _buildSeedTextForTest(task: AutoTask): string {
  return _buildSeedText(task);
}

function _buildFireTitle(task: AutoTask): string {
  // No glyph prefix — the renderer reads `conv.origin_auto_task_id` and
  // renders the clock UI icon next to the title (same icon as the sidebar
  // "Automation" tab).
  if (task.title && task.title.trim()) return task.title.trim();
  const firstLine = task.content.split(/\r?\n/)[0] || '';
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
}

async function _fireTask(uid: string, task: AutoTask): Promise<void> {
  const startedAt = Date.now();
  const title = _buildFireTitle(task);
  let cid = '';
  const emitFailure = (errorCode: string): void => {
    _emitFire({
      type: 'fire_failed',
      task_id: task.id,
      ...(cid ? { cid } : {}),
      error_code: errorCode,
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
  };
  try {
    const conv = await chats.createConversation(uid, {
      kind: 'normal',
      title,
      ...(task.project_id ? { projectId: task.project_id } : {}),
      originAutoTaskId: task.id,
    });
    cid = conv.conversation_id;
  } catch (err) {
    log.error(`fire conv-create failed uid=${uid} id=${task.id}: ${(err as Error).message}`);
    emitFailure('conv_create_failed');
    return;
  }
  // Copy attachments into the new conversation's chat_attachments dir
  // BEFORE dispatch. The originals stay under the task's attachments/ so
  // recurring schedules re-use them next fire.
  const attachmentNames = await _copyAttachmentsForFire(uid, task, cid);
  const text = _buildSeedText(task);
  const rollbackEmptyConv = async (reason: string): Promise<void> => {
    try { await chats.deleteConversation(uid, cid); }
    catch (e) { log.warn(`fire rollback failed uid=${uid} id=${task.id} cid=${cid} reason=${reason}: ${(e as Error).message}`); }
  };
  try {
    const res = await groupChat.send({
      userId: uid, cid, text,
      ...(attachmentNames.length ? { attachments: attachmentNames } : {}),
    });
    if (!res.ok) {
      log.warn(`fire send failed uid=${uid} id=${task.id} cid=${cid}: ${res.error || 'unknown'}`);
      await rollbackEmptyConv('send_not_ok');
      emitFailure('send_not_ok');
      return;
    }
    log.info(`fired uid=${uid} id=${task.id} cid=${cid} project=${task.project_id || '-'} attachments=${attachmentNames.length}`);
    _emitFire({
      type: 'conv_created',
      cid,
      task_id: task.id,
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
  } catch (err) {
    log.error(`fire send threw uid=${uid} id=${task.id} cid=${cid}: ${(err as Error).message}`);
    await rollbackEmptyConv('send_threw');
    emitFailure('send_threw');
  }
}

async function _copyAttachmentsForFire(uid: string, task: AutoTask, cid: string): Promise<string[]> {
  const want = Array.isArray(task.attachments) ? task.attachments.filter((n) => typeof n === 'string' && n) : [];
  if (!want.length) return [];
  if (!_isValidTaskId(task.id)) return [];
  const srcDir = autoTaskAttachmentsDir(uid, task.id);
  if (!fs.existsSync(srcDir)) return [];
  const destDir = chatAttachmentDir(uid, cid);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) { /* ignore */ }
  const copied: string[] = [];
  for (const name of want) {
    const safe = _sanitiseFilename(name);
    if (!safe) continue;
    const src = path.join(srcDir, safe);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(destDir, safe));
      copied.push(safe);
    } catch (err) {
      log.warn(`attachment copy failed uid=${uid} id=${task.id} cid=${cid} name=${safe}: ${(err as Error).message}`);
    }
  }
  return copied;
}

// ── Fire pub/sub (renderer-side refresh hook) ───────────────────────────

export type AutoFireEvent =
  | {
      type: 'conv_created';
      cid: string;
      task_id: string;
      duration_ms?: number;
    }
  | {
      type: 'fire_failed';
      task_id: string;
      cid?: string;
      error_code: string;
      duration_ms?: number;
    };

type FireListener = (ev: AutoFireEvent) => void;
const _fireListeners = new Set<FireListener>();

export function subscribeFires(fn: FireListener): () => void {
  _fireListeners.add(fn);
  return () => { _fireListeners.delete(fn); };
}

function _emitFire(ev: AutoFireEvent): void {
  for (const fn of _fireListeners) {
    try { fn(ev); }
    catch (err) { log.warn(`fire listener threw: ${(err as Error).message}`); }
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────
//
// Per-task setTimeout, no polling. Each enabled own-device task gets a
// single timer set for its next due time (capped at MAX_TIMEOUT_MS so
// system sleep/wake self-corrects within an hour). When the timer fires,
// the task is re-read (config may have changed), `isDue` is re-checked
// against the current wall clock, and if due, fired; then a fresh timer
// is registered for the next occurrence. CRUD operations explicitly
// cancel + re-register the affected task's timer so changes apply
// immediately without waiting for any tick.
//
// Sleep/wake: Node `setTimeout` measures elapsed AWAKE time (uv_now)
// rather than wall clock, so a 1h timer registered before sleep would
// fire 1h AFTER resume even though the wall-clock target is in the past.
// The MAX_TIMEOUT_MS cap bounds that drift; on resume we additionally
// listen for `powerMonitor.on('resume', ...)` and reschedule every
// timer so any past-due task fires immediately.

/** Max single-step delay (1h). Lets sleep/wake re-evaluate against wall
 *  clock within an hour even without the powerMonitor hook firing. Node's
 *  int32 setTimeout limit is ~24.85d; this is well below. */
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const _timers = new Map<string, NodeJS.Timeout>();
let _resumeListenerAttached = false;
let _started = false;

function _scheduleBaseline(task: AutoTask): Date | null {
  if (task.last_run_at) {
    const d = new Date(task.last_run_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (task.schedule.type === 'one_time') return null;
  const created = new Date(task.created_at);
  return Number.isNaN(created.getTime()) ? null : created;
}

/** Compute the next moment a task should fire, or null if it never will
 *  again (disabled, one_time already fired, device-mismatch). Recurring
 *  tasks without a prior run use `created_at` as their baseline so a daily
 *  09:00 task created at 20:00 starts tomorrow instead of immediately
 *  back-filling this morning's missed boundary. */
function _nextDueAt(task: AutoTask, now: Date, lastRun: Date | null): Date | null {
  if (!task.enabled) return null;
  const sched = task.schedule;
  if (sched.type === 'one_time') {
    if (lastRun) return null;
    return new Date(sched.at);  // past = "fire ASAP" (setTimeout(<0) clamps to 0)
  }
  if (sched.type === 'daily') return _nextDailyAt(now, lastRun, sched.hour, sched.minute);
  if (sched.type === 'weekly') return _nextWeeklyAt(now, lastRun, sched.weekday, sched.hour, sched.minute);
  if (sched.type === 'monthly') return _nextMonthlyAt(now, lastRun, sched.day, sched.hour, sched.minute);
  return null;
}

function _nextDailyAt(now: Date, lastRun: Date | null, h: number, m: number): Date {
  const today = new Date(now);
  today.setHours(h, m, 0, 0);
  if (now.getTime() >= today.getTime()) {
    if (!lastRun || lastRun.getTime() < today.getTime()) return now; // already due
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  return today;
}

function _nextWeeklyAt(now: Date, lastRun: Date | null, weekday: number, h: number, m: number): Date {
  const today = new Date(now);
  today.setHours(h, m, 0, 0);
  if (now.getDay() === weekday) {
    if (now.getTime() >= today.getTime()) {
      if (!lastRun || lastRun.getTime() < today.getTime()) return now;
      const nextWeek = new Date(today);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek;
    }
    return today;
  }
  // Days to skip ahead — `(weekday - currentDow + 7) % 7` gives 0 for "today"
  // which we just handled; substitute 7 when zero so we always project to
  // the future.
  let daysAhead = (weekday - now.getDay() + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const result = new Date(today);
  result.setDate(result.getDate() + daysAhead);
  return result;
}

function _nextMonthlyAt(now: Date, lastRun: Date | null, day: number, h: number, m: number): Date {
  const todayDom = now.getDate();
  const lastDom = _lastDayOfMonth(now);
  const targetDom = Math.min(day, lastDom);  // day=31 → fall back to last day
  const today = new Date(now);
  today.setDate(targetDom);
  today.setHours(h, m, 0, 0);
  if (todayDom === targetDom) {
    if (now.getTime() >= today.getTime()) {
      if (!lastRun || lastRun.getTime() < today.getTime()) return now;
      return _monthsForwardAt(now, 1, day, h, m);
    }
    return today;
  }
  if (todayDom < targetDom) return today; // this month's target still ahead
  return _monthsForwardAt(now, 1, day, h, m); // past it; next month
}

function _monthsForwardAt(from: Date, monthsForward: number, day: number, h: number, m: number): Date {
  const result = new Date(from.getFullYear(), from.getMonth() + monthsForward, 1, h, m, 0, 0);
  const lastDom = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDom));
  return result;
}

/** Cancel any existing timer for `taskId`. */
function _cancelTimer(taskId: string): void {
  const prev = _timers.get(taskId);
  if (prev) {
    clearTimeout(prev);
    _timers.delete(taskId);
  }
}

/** Register / refresh the timer for a single task. Idempotent: existing
 *  timer is cancelled first. Sync — safe to call inside `_runExclusive`. */
function _scheduleTask(uid: string, task: AutoTask, baselineOverride?: Date | null): void {
  _cancelTimer(task.id);
  if (!task.enabled) return;
  if (task.device_id && task.device_id !== getCurrentDevice().id) return;
  const now = new Date();
  const lastRun = baselineOverride === undefined ? _scheduleBaseline(task) : baselineOverride;
  const nextDue = _nextDueAt(task, now, lastRun);
  if (!nextDue) return;
  const wait = nextDue.getTime() - now.getTime();
  const delay = Math.max(0, Math.min(wait, MAX_TIMEOUT_MS));
  const handle = setTimeout(() => {
    _onTimerFire(uid, task.id).catch((err) => log.warn(`timer fire threw id=${task.id}: ${(err as Error).message}`));
  }, delay);
  if (typeof (handle as any).unref === 'function') (handle as any).unref();
  _timers.set(task.id, handle);
}

/** Fire handler: re-read the task (may have been edited since scheduled),
 *  real-clock due-check, fire if due, then reschedule for the next due. */
async function _onTimerFire(uid: string, taskId: string): Promise<void> {
  _timers.delete(taskId);
  const task = await _readOne(uid, taskId);
  if (!task) return;
  const now = new Date();
  const lastRun = _scheduleBaseline(task);
  const dueBoundary = _dueBoundary(task, now, lastRun);
  let claimedElsewhereBoundary: Date | null = null;
  const canFireHere = task.enabled
    && (!task.device_id || task.device_id === getCurrentDevice().id)
    && dueBoundary !== null;
  if (canFireHere) {
    if (!_tryClaimFireBoundary(uid, task, dueBoundary, now)) {
      claimedElsewhereBoundary = dueBoundary;
      log.info(`fire skipped duplicate uid=${uid} id=${taskId} boundary=${dueBoundary.toISOString()}`);
    } else {
      try {
        // Stamp last_run_at FIRST (and disable on one_time) so a slow fire
        // can't get re-picked by a future re-schedule.
        await _markRan(uid, taskId, now.toISOString(), task.schedule.type === 'one_time');
      } catch (err) {
        _releaseFireBoundaryClaim(uid, task, dueBoundary);
        log.warn(`fire mark failed id=${taskId}: ${(err as Error).message}`);
        const fresh = await _readOne(uid, taskId);
        if (fresh) _scheduleTask(uid, fresh);
        return;
      }
      try {
        await _fireTask(uid, task);
      } catch (err) {
        log.warn(`fire failed id=${taskId}: ${(err as Error).message}`);
      }
    }
  }
  // Re-read for fresh last_run_at / enabled state, then reschedule. This
  // is what makes the cap (MAX_TIMEOUT_MS) self-correcting — if the
  // capped timer fired before the actual due time, no fire happens but a
  // new timer goes in for the remaining gap (or up to another MAX cap).
  const fresh = await _readOne(uid, taskId);
  if (fresh) _scheduleTask(uid, fresh, claimedElsewhereBoundary || undefined);
}

export function _onTimerFireForTest(uid: string, taskId: string): Promise<void> {
  return _onTimerFire(uid, taskId);
}

/** Cancel + re-register every timer. Called on system resume so any
 *  task that became due during sleep fires within ms instead of waiting
 *  out the (capped, but possibly hour-long) pre-sleep timer. */
async function _rescheduleAll(uid: string): Promise<void> {
  // Cancel everything in one pass.
  for (const id of Array.from(_timers.keys())) _cancelTimer(id);
  const tasks = await listTasks(uid);
  for (const t of tasks) _scheduleTask(uid, t);
  log.info(`rescheduler ran timers=${_timers.size}`);
}

export function nextDueAtForTest(task: AutoTask, now: Date): Date | null {
  return _nextDueAt(task, now, _scheduleBaseline(task));
}

/** Public CRUD hook — call after any task mutation lands on disk. */
function _onTaskMutated(uid: string, task: AutoTask | null, taskId?: string): void {
  if (task) _scheduleTask(uid, task);
  else if (taskId) _cancelTimer(taskId);
}

/** Initial bootstrap — list every task and register a timer for each
 *  enabled / own-device one. Called once on startup; deferred via
 *  the deferred boot phase (util/boot_init.ts) so first-paint doesn't pay
 *  the disk scan cost. */
export function startScheduler(): void {
  if (_started) return;
  _started = true;
  // System sleep/wake → rebuild timers on resume so any task that was due
  // during sleep fires immediately on wake (Node's setTimeout uses
  // awake-time, not wall-clock).
  (async () => {
    try {
      const { powerMonitor } = await import('electron');
      if (powerMonitor && !_resumeListenerAttached) {
        _resumeListenerAttached = true;
        powerMonitor.on('resume', () => {
          if (!hasActiveUser()) return;
          _rescheduleAll(getActiveUserId()).catch((err) => log.warn(`resume reschedule failed: ${(err as Error).message}`));
        });
      }
    } catch (_) { /* non-electron host (tests) — no power-monitor hook */ }
  })();
  if (!hasActiveUser()) return;
  const uid = getActiveUserId();
  _rescheduleAll(uid).catch((err) => log.warn(`bootstrap failed uid=${uid}: ${(err as Error).message}`));
}

/** Re-read task configs after sync writes directly into cloud/auto_tasks.
 *  CRUD paths schedule their own task, but the sync engine bypasses those
 *  hooks while materializing files from another device. */
export async function rescheduleAllForActiveUser(): Promise<void> {
  if (!hasActiveUser()) return;
  await _rescheduleAll(getActiveUserId());
}

export function stopScheduler(): void {
  for (const id of Array.from(_timers.keys())) _cancelTimer(id);
  _started = false;
  log.info('scheduler stopped');
}
