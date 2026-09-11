/**
 * Project driver loop — live runner (Phase-3 slice 2).
 *
 * The decision + storage layer is `project_driver.ts` (pure, unit-tested). This
 * module is the side-effecting half: it fires an advance (create a scoped
 * conversation + send the seed, reusing the single group-chat dispatch path like
 * auto_tasks) and runs the periodic tick that gates the global backlog and every
 * project through the pure `decideAdvance` guardrails.
 *
 * Safety: nothing advances unless its backlog has opted in (driver config
 * enabled), which defaults off. The tick reads each tiny config first and exits
 * early when disabled, so a poll over many projects stays cheap. The
 * advance itself is bounded by decideAdvance (skip-if-running, cooldown, daily
 * cap, actionable-only). One advance = one conversation working ONE task, so the
 * loop's cadence and cost stay under the guardrails, not the model's discretion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { t as translate } from '../i18n';
import { createLogger } from '../logger';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import { projectTaskAttachmentsDir, userTaskAttachmentsDir } from '../paths';
import { chatAttachmentDirForConversation } from '../util/project-layout';
import { getActiveUserId, hasActiveUser } from './users';
import * as chats from './chats';
import * as groupChat from './group_chat';
import { busIsQuiescent } from './group_chat';
import * as projects from './projects';
import * as agents from './agents';
import * as projectTasks from './project_tasks';
import type { ProjectTask } from './project_tasks';
import * as driver from './project_driver';

const log = createLogger('project-driver-runner');

// Poll cadence. Advances are further gated by decideAdvance (cooldown, daily
// cap, skip-if-running), so this only sets how often we CHECK, not how often we
// advance.
const DRIVER_TICK_MS = 60 * 1000;

// Status alone cannot claim an progress retry: its before/after state is
// identical. Share a dispatch guard across manual starts and auto-advance until
// enqueue/rollback finishes; a later explicit retry remains allowed.
const _dispatchingTasks = new Set<string>();

async function _selectGlobalTaskOwner(uid: string, pid: string, task: ProjectTask, cid: string): Promise<boolean> {
  if (pid || !task.owner_agent_id) return true;
  if (getActiveUserId() !== uid) return false;
  try {
    const agent = (await agents.listAgentSummaries()).find((a) => a.agent_id === task.owner_agent_id && a.enabled !== false);
    if (!agent || getActiveUserId() !== uid) return false;
    return (await groupChat.setFloor(uid, cid, agent.agent_id)).ok;
  } catch {
    // Selection precedes the status write. A lookup failure must not roll back
    // a status transition made by another caller while this lookup was pending.
    log.warn('global task owner selection failed');
    return false;
  }
}

async function _prepareRunStatus(
  uid: string, pid: string, tid: string, expected: ProjectTask['status'],
): Promise<boolean> {
  const updated = await projectTasks.updateTask(uid, pid, tid,
    // Review work remains at its current stage until the executor starts work
    // and updates it. The host checks the snapshot without deciding progress.
    expected === 'review' ? {} : { status: 'progress' }, { expectedStatus: expected });
  return updated.ok;
}

async function _restoreUnsentStatus(
  uid: string, pid: string, tid: string, previous: ProjectTask['status'],
): Promise<void> {
  // The host never changed a review task's status, so it owns no rollback of
  // that status. In particular, preserve any newer executor decision.
  if (previous === 'review') return;
  try {
    const restored = await projectTasks.updateTask(uid, pid, tid,
      { status: previous }, { expectedStatus: 'progress' });
    if (restored.ok === false && restored.error !== 'status_conflict' && restored.error !== 'task_not_found') {
      log.warn('run status rollback rejected', { uid: maskId(uid), pid: maskId(pid), tid: maskId(tid), error: logErrorSummary(restored.error) });
    }
  } catch (err) {
    log.warn('run status rollback failed', { uid: maskId(uid), pid: maskId(pid), tid: maskId(tid), error: logErrorSummary(err) });
  }
}

async function _associateTaskConversation(uid: string, pid: string, tid: string, cid: string, messageId?: string): Promise<void> {
  try {
    if (messageId) {
      const { associateBacklogTask } = await import('./group_chat/task_board');
      await associateBacklogTask(uid, cid, pid, tid, { sourceMessageId: messageId });
    }
    const linked = await projectTasks.updateTask(uid, pid, tid, { origin_cid: cid });
    if (!linked.ok) {
      log.error('task conversation association rejected', { uid: maskId(uid), pid: maskId(pid), tid: maskId(tid) });
    }
  } catch (err) {
    // The run was already enqueued successfully, so never report a false start
    // failure or delete its live conversation. The task-change path can still
    // associate this same cid when it writes the next status.
    log.error('task conversation association failed', { uid: maskId(uid), pid: maskId(pid), tid: maskId(tid), error: logErrorSummary(err) });
  }
}

// Seed for one auto-advance, sent to the project COMMANDER (no @mention, so
// default routing reaches it). Task-specific — names the exact task the loop
// just marked progress so the commander advances THAT one, not a re-picked
// todo. The commander orchestrates: dispatch to the owning agent, oversee, judge
// the result, then reconcile the task status. Named Agents may also write status;
// entering through Commander preserves the auto-advance orchestration contract.
// Localized (project language) with the title interpolated; detail appended.
function _advanceSeedText(task: ProjectTask, pid: string): string {
  if (!pid) {
    return _runSeedText(task, '')
      + ' This run was started by auto-advance; after updating the status, stop so the next backlog item can be selected.';
  }
  const key = 'project.driver.advance_seed';
  const fallback = `Auto-advance: advance the project task "${task.title}" now — it is already marked `
    + 'progress. Dispatch it to its owner agent (or the right agent if unassigned), oversee the work, '
    + 'and verify the result. If and only if the work is fully complete and verified, update this exact '
    + 'task to review with todo_tasks. If the work is incomplete, interrupted, or fails, do not '
    + 'change its status; it must remain progress. During this run, never set it to blocked or done. '
    + 'Then stop; the auto-advance loop continues with the next task on its own.';
  const localized = translate(key, { title: task.title });
  let text = localized === key ? fallback : localized;
  if (task.detail) text += `\n\nTask details:\n${task.detail}`;
  return text;
}

/** Copy a task's attachments into the new conversation's chat_attachments dir
 *  BEFORE dispatch, so the run starts with them exactly like a human who attached
 *  files to the first message. Mirrors auto_tasks._copyAttachmentsForFire; the
 *  originals stay under the task so a re-run reuses them. Returns the copied
 *  filenames to hand to groupChat.send (which references files already staged
 *  under the cid). Best-effort per file — a missing/failed copy is skipped. */
function _copyTaskAttachments(uid: string, pid: string, task: ProjectTask, cid: string): string[] {
  const want = Array.isArray(task.attachments) ? task.attachments.filter((n) => typeof n === 'string' && n) : [];
  if (!want.length) return [];
  const srcDir = pid
    ? projectTaskAttachmentsDir(uid, pid, task.id)
    : userTaskAttachmentsDir(uid, task.id);
  if (!fs.existsSync(srcDir)) return [];
  const destDir = chatAttachmentDirForConversation(uid, cid, pid || null);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* ignore */ }
  const copied: string[] = [];
  for (const name of want) {
    if (path.basename(name) !== name) continue; // plain filename only — never a path
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    try { fs.copyFileSync(src, path.join(destDir, name)); copied.push(name); }
    catch (err) { log.warn('attachment copy', { uid: maskId(uid), pid: maskId(pid), task: maskId(task.id), cid: maskId(cid), attachment: logPathRef(name), error: logErrorSummary(err) }); }
  }
  return copied;
}

/** Fire one advance: a fresh project conversation seeded to advance a single
 *  backlog task. Mirrors auto_tasks `_fireTask` (createConversation → send;
 *  roll back the empty conversation on send failure). Returns the new cid so the
 *  caller can lease it; ok:false on any failure. */
export async function advance(uid: string, pid: string, task: ProjectTask): Promise<{ ok: boolean; cid?: string; conversation?: unknown }> {
  const dispatchKey = `${uid}\u0000${pid}\u0000${task.id}`;
  const ownsDispatch = !_dispatchingTasks.has(dispatchKey);
  if (ownsDispatch) _dispatchingTasks.add(dispatchKey);
  let cid = '';
  let conversation: unknown;
  try {
    const conv = await chats.createConversation(uid, {
      kind: 'normal',
      title: task.title,
      ...(pid ? { projectId: pid } : {}),
    });
    cid = conv.conversation_id;
    conversation = conv;
  } catch (err) {
    if (ownsDispatch) _dispatchingTasks.delete(dispatchKey);
    log.error('advance conv-create failed', { uid: maskId(uid), pid: maskId(pid), error: logErrorSummary(err) });
    return { ok: false };
  }
  const rollback = async (): Promise<void> => {
    try { await chats.deleteConversation(uid, cid, pid || null); }
    catch (e) { log.warn('advance rollback failed', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(e) }); }
  };
  if (!ownsDispatch) {
    await rollback();
    return { ok: false };
  }
  try {
    if (!(await _selectGlobalTaskOwner(uid, pid, task, cid))) {
      await rollback();
      return { ok: false };
    }
    if (!(await _prepareRunStatus(uid, pid, task.id, task.status))) {
      log.warn('advance status update rejected', { uid: maskId(uid), pid: maskId(pid), task: maskId(task.id) });
      await rollback();
      return { ok: false };
    }
    const attachments = _copyTaskAttachments(uid, pid, task, cid);
    const res = await groupChat.send({
      userId: uid,
      cid,
      text: task.title,
      title_text: task.title,
      model_text: _advanceSeedText(task, pid),
      ...(attachments.length ? { attachments } : {}),
    });
    if (!res.ok) {
      log.warn('advance send failed', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(res.error || 'unknown') });
      await _restoreUnsentStatus(uid, pid, task.id, task.status);
      await rollback();
      return { ok: false };
    }
    await _associateTaskConversation(uid, pid, task.id, cid, res.msg?.id);
    log.info('advanced', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), task: maskId(task.id) });
    return { ok: true, cid, conversation };
  } catch (err) {
    log.error('advance send threw', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(err) });
    await _restoreUnsentStatus(uid, pid, task.id, task.status);
    await rollback();
    return { ok: false };
  } finally {
    _dispatchingTasks.delete(dispatchKey);
  }
}

/** Seed for a user-triggered single-task run. Project tasks always enter through
 *  the Commander, which dispatches and verifies the work. Named Agents may
 *  also update the bound task status. A global task runs in the default assistant and
 *  uses the synthetic global selector exposed by the unbound todo_tasks tool.
 *  This is private model text; the visible chat bubble remains just the title. */
function _runSeedText(task: ProjectTask, pid: string): string {
  const owner = String(task.owner_agent || '').trim();
  const review = task.status === 'review';
  const target = review ? 'done' : 'review';
  const start = review
    ? 'It is currently review. The user requested processing this task through verified completion. '
      + `When work starts, mark it progress with todo_tasks${pid ? '' : ' using project "__global__"'}. `
    : 'It is being marked progress. ';
  const finish = review
    ? 'During this run, never set it to blocked. Then stop.'
    : 'During this run, never set it to blocked or done. '
      + 'Only a later explicit user instruction or manual action may set it to done. Then stop.';
  let text = pid
    ? `Execute project task ${task.id} now: "${task.title}". ${start}`
      + `Act as the project Commander: ${owner ? `dispatch the work to @${owner}` : 'choose and dispatch the right Agent'}, `
      + 'wait for its result, and verify the deliverable. If and only if the work is fully complete and verified, '
      + `update this exact task to ${target} with todo_tasks. If the work is incomplete, interrupted, or fails, `
      + 'do not change its status; it must remain progress. ' + finish
    : `Execute account-global todo ${task.id} now: "${task.title}". ${start}`
      + 'Complete and verify the work. If and only if it is fully complete and verified, update this exact todo '
      + `to ${target} with todo_tasks using project "__global__". If the work is incomplete, interrupted, or fails, `
      + 'do not change its status; it must remain progress. ' + finish;
  if (task.detail) text += `\n\nTask details:\n${task.detail}`;
  return text;
}

/** User-triggered "run this task now": open a fresh conversation, route project
 *  work through its Commander (which delegates to the assigned owner), or route
 *  a global task to its selected Agent (or the default assistant). Review-stage transitions belong to
 *  the executor; other runnable tasks are marked progress at startup. Mirrors
 *  advance()'s create→send→rollback shape and — like auto_tasks.runTaskNow — is
 *  NOT gated by the driver's cooldown/daily-cap/lease; a manual run is explicit.
 *  The Commander advances the status further via todo_tasks as work finishes. */
export async function runTaskNow(
  uid: string, pid: string, tid: string,
): Promise<{ ok: boolean; cid?: string; conversation?: unknown; error?: string }> {
  const task = await projectTasks.getTask(uid, pid, tid);
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.status !== 'todo' && task.status !== 'progress' && task.status !== 'review') {
    return { ok: false, error: 'not_runnable' };
  }

  const dispatchKey = `${uid}\u0000${pid}\u0000${tid}`;
  const ownsDispatch = !_dispatchingTasks.has(dispatchKey);
  if (ownsDispatch) _dispatchingTasks.add(dispatchKey);
  let cid = '';
  let conversation: unknown;
  try {
    const conv = await chats.createConversation(uid, {
      kind: 'normal',
      title: task.title,
      ...(pid ? { projectId: pid } : {}),
    });
    cid = conv.conversation_id;
    conversation = conv;
  } catch (err) {
    if (ownsDispatch) _dispatchingTasks.delete(dispatchKey);
    log.error('runTaskNow conv-create failed', { uid: maskId(uid), pid: maskId(pid), error: logErrorSummary(err) });
    return { ok: false, error: 'create_failed' };
  }
  const rollback = async (): Promise<void> => {
    try { await chats.deleteConversation(uid, cid, pid || null); }
    catch (e) { log.warn('runTaskNow rollback failed', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(e) }); }
  };
  if (!ownsDispatch) {
    await rollback();
    return { ok: false, error: 'status_update_failed' };
  }
  try {
    if (!(await _selectGlobalTaskOwner(uid, pid, task, cid))) {
      await rollback();
      return { ok: false, error: 'owner_not_bound' };
    }
    if (!(await _prepareRunStatus(uid, pid, tid, task.status))) {
      log.warn('runTaskNow status update rejected', { uid: maskId(uid), pid: maskId(pid), tid: maskId(tid) });
      await rollback();
      return { ok: false, error: 'status_update_failed' };
    }
    const attachments = _copyTaskAttachments(uid, pid, task, cid);
    // Keep the conversation readable: the bubble shows the task itself while
    // the model receives the workflow instruction through the private model_text
    // channel. Do not @-route project work directly to its owner here: only the
    // Commander can verify the result and write the next durable task status.
    const res = await groupChat.send({
      userId: uid,
      cid,
      text: task.title,
      title_text: task.title,
      model_text: _runSeedText(task, pid),
      ...(attachments.length ? { attachments } : {}),
    });
    if (!res.ok) {
      log.warn('runTaskNow send failed', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(res.error || 'unknown') });
      await _restoreUnsentStatus(uid, pid, tid, task.status);
      await rollback();
      return { ok: false, error: res.error || 'send_failed' };
    }
    await _associateTaskConversation(uid, pid, tid, cid, res.msg?.id);
  } catch (err) {
    log.error('runTaskNow send threw', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), error: logErrorSummary(err) });
    await _restoreUnsentStatus(uid, pid, tid, task.status);
    await rollback();
    return { ok: false, error: 'send_failed' };
  } finally {
    _dispatchingTasks.delete(dispatchKey);
  }
  log.info('ran task', { uid: maskId(uid), pid: maskId(pid), cid: maskId(cid), task: maskId(tid) });
  return { ok: true, cid, conversation };
}

// Advance notifications — index.ts wires these to a renderer broadcast so a
// driver-created conversation surfaces in the project's task list live, exactly
// like a human-started run (which the renderer adds locally). Kept an emitter
// here so this side-effecting module stays free of the ipc/window layer.
export interface AdvanceEvent { uid: string; pid: string; cid: string; conversation: unknown }
type AdvanceListener = (e: AdvanceEvent) => void;
const _advanceListeners: AdvanceListener[] = [];
export function onAdvance(cb: AdvanceListener): void {
  if (typeof cb === 'function') _advanceListeners.push(cb);
}
function _emitAdvance(e: AdvanceEvent): void {
  for (const cb of _advanceListeners) {
    try { cb(e); } catch (err) { log.warn('advance listener threw', { error: logErrorSummary(err) }); }
  }
}

/** Injectable seams so the orchestration is unit-testable without spawning a
 *  real run. Production uses the real clock / backlog / bus / fire. */
export interface RunnerDeps {
  now: () => number;
  listTasks: (uid: string, pid: string) => Promise<ProjectTask[]>;
  isQuiescent: (uid: string, cid: string) => boolean;
  advance: (uid: string, pid: string, task: ProjectTask) => Promise<{ ok: boolean; cid?: string; conversation?: unknown }>;
}

const defaultDeps: RunnerDeps = {
  now: () => Date.now(),
  listTasks: (uid, pid) => projectTasks.listTasks(uid, pid),
  isQuiescent: busIsQuiescent,
  advance,
};

/** Evaluate one project and advance it if the guardrails allow. Persists the
 *  next state (lease release / day reset on a skip; incremented count + new
 *  lease on an advance). Returns the outcome for logging / tests. */
// The tick and the `projects.driver.set` immediate advance both call
// advanceProjectIfDue; neither module holds a lock, so two overlapping calls
// read the same lease-free state and can fire the same task twice
// (2026-08-28 review E1-9).
const _advancing = new Set<string>();

export async function advanceProjectIfDue(
  uid: string, pid: string, deps: RunnerDeps = defaultDeps,
): Promise<driver.AdvanceReason | 'advanced'> {
  const inFlightKey = `${uid}\u0000${pid}`;
  if (_advancing.has(inFlightKey)) return 'running';
  _advancing.add(inFlightKey);
  try {
    return await _advanceProjectIfDueLocked(uid, pid, deps);
  } finally {
    _advancing.delete(inFlightKey);
  }
}

async function _advanceProjectIfDueLocked(
  uid: string, pid: string, deps: RunnerDeps,
): Promise<driver.AdvanceReason | 'advanced'> {
  const cfg = await driver.readConfig(uid, pid);
  if (!cfg.enabled) return 'disabled'; // cheapest gate: skip before reading state/backlog
  const state = await driver.readState(uid, pid);
  const tasks = await deps.listTasks(uid, pid);
  // The lease blocks the next advance only while its task is still pending. Once
  // the advanced task has left `todo` (advance() flips it to progress), the
  // advance took effect, so don't keep waiting on the conversation to finish —
  // otherwise one long/stalled run stops the loop from advancing anything else.
  let leaseRunning = false;
  if (state.lease_cid) {
    const convBusy = !deps.isQuiescent(uid, state.lease_cid);
    const leasedTask = state.lease_task_id ? tasks.find((tk) => tk.id === state.lease_task_id) : undefined;
    const leasedTaskPending = state.lease_task_id ? (leasedTask ? leasedTask.status === 'todo' : false) : true;
    leaseRunning = convBusy && leasedTaskPending;
  }
  const now = deps.now();
  const { decision, nextState } = driver.decideAdvance(cfg, state, now, tasks, leaseRunning);
  if (decision.advance) {
    // Read `task` before the await — TS resets the union narrowing across it.
    const task = decision.task;
    const res = await deps.advance(uid, pid, task);
    await driver.writeState(uid, pid, res.ok && res.cid
      ? { ...nextState, lease_cid: res.cid, lease_at: new Date(now).toISOString(), lease_task_id: task.id }
      : nextState);
    if (res.ok && res.cid) {
      _emitAdvance({ uid, pid, cid: res.cid, conversation: res.conversation });
    }
    return 'advanced';
  }
  // decision is the non-advance variant here (the advance variant returned
  // above); cast rather than rely on union narrowing, which this repo's TS does
  // not do across the boolean discriminant.
  const reason = (decision as { reason: driver.AdvanceReason }).reason;
  await driver.writeState(uid, pid, nextState);
  return reason;
}

/** One tick: gate every project through the guardrails. A per-project failure is
 *  isolated so one bad project cannot stall the loop. */
export async function runDriverTick(uid: string): Promise<void> {
  let pids: string[];
  // Readdir only: `listProjects` sweeps every conversation index root for
  // counts nobody here reads, and this runs every minute for a default-off
  // feature (2026-08-28 review E1-3).
  try { pids = ['', ...(await projects.listProjectIds(uid))]; }
  catch (err) { log.warn('driver tick list-projects failed', { uid: maskId(uid), error: logErrorSummary(err) }); return; }
  for (const pid of pids) {
    try { await advanceProjectIfDue(uid, pid); }
    catch (err) { log.warn('driver tick project failed', { uid: maskId(uid), pid: maskId(pid), error: logErrorSummary(err) }); }
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic driver poll. Registered at boot via boot_init, alongside
 *  the auto_tasks scheduler. Idempotent. The timer is unref'd so it never keeps
 *  the process alive. */
export function startDriverScheduler(): void {
  if (_timer) return;
  _timer = setInterval(() => {
    if (!hasActiveUser()) return;
    void runDriverTick(getActiveUserId()).catch((err) => log.warn('driver tick failed', { error: logErrorSummary(err) }));
  }, DRIVER_TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  log.info('driver scheduler started');
}
