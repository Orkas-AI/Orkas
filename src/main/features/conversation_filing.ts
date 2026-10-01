/**
 * Filing a conversation under a project — the one UI-free composition.
 *
 * `renderer/modules/conversation-to-project.js` used to compose
 * `projects.create` + `conversations.move` + `projects.bindings.add` itself, so
 * the member-agent derivation and the step order lived in the renderer and no
 * other caller could reuse them. A model-facing tool needs the same steps with
 * no picker, so the composition lives here and both callers run it.
 *
 * The relocation guard stays where it already is: `moveConversationToProject`
 * refuses while the conversation has a live turn, because the move relocates
 * the message file, sessions, attachments and artifacts that turn is writing.
 * A model turn can therefore never move its own conversation; a caller running
 * inside a turn creates the project here and leaves the move to the host at
 * the next quiescent boundary.
 *
 * Filing creates a fresh local project; existing projects are never retargeted.
 */

import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
import * as agents from './agents';
import * as chats from './chats';
import * as projects from './projects';
import { readMembers } from './group_chat/state';

const log = createLogger('conversation-filing');

/** Bounded so a pathological duplicate set cannot spin on name attempts. */
const MAX_NAME_ATTEMPTS = 9;

export type ConversationFilingError =
  | projects.ProjectError
  | 'already_in_project'
  | 'move_failed';

export interface ConversationFilingResult {
  project: projects.Project;
  /** Absent when the caller deferred the move: the conversation row is only
   *  rewritten once the relocation actually runs. */
  conversation?: chats.Conversation;
  filed: 'moved' | 'deferred';
  /** Member agents bound to the new project. */
  bound: string[];
  /** Member agents the project refused (disabled or unavailable). Never fatal:
   *  losing one binding is not a reason to leave the work unfiled. */
  unbound: string[];
}

export interface FileConversationOptions {
  /** False when the caller runs inside the conversation's own turn. The
   *  project and its bindings are created now; the relocation is the host's. */
  moveNow?: boolean;
  /** Append a numeric suffix instead of failing on `name_dup`. A caller that
   *  can ask the user for another name leaves this off. */
  uniquifyName?: boolean;
  /** Bind exactly these agents instead of every member agent. For a caller
   *  that let someone choose a subset. */
  agentIds?: string[];
}

/**
 * Member agents of this conversation. The durable roster is authoritative and
 * the denormalized index fields cover a conversation whose roster has not been
 * written yet. Commander is a distinct actor kind, so it never appears here.
 */
export async function conversationMemberAgentIds(
  userId: string,
  cid: string,
  conversation?: chats.Conversation | null,
): Promise<string[]> {
  const ids = new Set<string>();
  const conv = conversation ?? await chats.getConversationMetadata(userId, cid);
  for (const id of conv?.agent_ids ?? []) if (id) ids.add(id);
  if (conv?.agent_id) ids.add(conv.agent_id);
  try {
    const members = await readMembers(userId, cid, conv?.project_id ?? null);
    for (const actor of members.actors) {
      if (actor.kind === 'agent' && actor.id) ids.add(actor.id);
    }
  } catch (err) {
    // The roster is an enrichment here; the index fields already name the
    // agents the conversation was started with.
    log.warn(`member roster unreadable uid=${maskId(userId)} cid=${maskId(cid)}`, logErrorSummary(err));
  }
  return [...ids];
}

async function createUniquelyNamedProject(
  userId: string,
  rawName: string,
  uniquify: boolean,
): Promise<{ ok: true; project: projects.Project } | { ok: false; error: projects.ProjectError }> {
  const base = String(rawName ?? '').trim();
  for (let attempt = 1; attempt <= (uniquify ? MAX_NAME_ATTEMPTS : 1); attempt += 1) {
    const name = attempt === 1 ? base : `${base} ${attempt}`;
    const created = await projects.createProject(userId, name);
    // `strictNullChecks` is off, so a boolean discriminant does not narrow;
    // the cast is this repo's idiom for reading a result union's error.
    if (created.ok || (created as { error: projects.ProjectError }).error !== 'name_dup') return created;
  }
  return { ok: false, error: 'name_dup' };
}

/**
 * Create a project for this conversation and file the conversation under it.
 *
 * Step order follows the picker it replaces: relocate first, then bind, so a
 * refused binding never leaves the work in a project the conversation did not
 * reach. A deferred caller inverts only the relocation, not the order of the
 * remaining steps.
 */
export async function fileConversationUnderNewProject(
  userId: string,
  cid: string,
  rawName: string,
  opts: FileConversationOptions = {},
): Promise<{ ok: true; result: ConversationFilingResult } | { ok: false; error: ConversationFilingError }> {
  const key = _pendingKey(userId, cid);
  // Deferred setup has not written project_id yet. Reserve this conversation
  // before the first await so retries and concurrent calls cannot create a
  // second project or replace the destination already promised to the user.
  if (_pendingFilings.has(key) || _filingsInProgress.has(key)) {
    return { ok: false, error: 'already_in_project' };
  }
  _filingsInProgress.add(key);
  try {
    return await _fileConversationUnderNewProject(userId, cid, rawName, opts);
  } finally {
    _filingsInProgress.delete(key);
  }
}

async function _fileConversationUnderNewProject(
  userId: string,
  cid: string,
  rawName: string,
  opts: FileConversationOptions,
): Promise<{ ok: true; result: ConversationFilingResult } | { ok: false; error: ConversationFilingError }> {
  const moveNow = opts.moveNow !== false;
  const existing = await chats.getConversationMetadata(userId, cid);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.project_id) return { ok: false, error: 'already_in_project' };

  const agentIds = opts.agentIds
    ?? await conversationMemberAgentIds(userId, cid, existing);
  const created = await createUniquelyNamedProject(userId, rawName, opts.uniquifyName === true);
  if (!created.ok) return { ok: false, error: (created as { error: projects.ProjectError }).error };
  const project = created.project;

  let conversation: chats.Conversation | undefined;
  if (moveNow) {
    const moved = await chats.moveConversationToProject(userId, cid, project.project_id);
    if (!moved.ok) return { ok: false, error: (moved as { error: ConversationFilingError }).error };
    conversation = moved.conversation;
  } else {
    _pendingFilings.set(_pendingKey(userId, cid), {
      kind: 'file', projectId: project.project_id, projectName: project.name, todosCreated: 0,
    });
  }

  // `addAgentBinding` does not check the agent itself; the picker's IPC handler
  // owns that gate, so repeat it here rather than binding an agent the other
  // caller would have refused.
  const bound: string[] = [];
  const unbound: string[] = [];
  for (const agentId of agentIds) {
    let bindable = false;
    try {
      const agent = await agents.getAgent(agentId);
      bindable = !!agent && agent.enabled !== false;
    } catch { bindable = false; }
    if (!bindable) { unbound.push(agentId); continue; }
    const result = await projects.addAgentBinding(userId, project.project_id, agentId);
    if (result.ok) bound.push(agentId);
    else unbound.push(agentId);
  }

  log.info(`conversation filed uid=${maskId(userId)} cid=${maskId(cid)} pid=${maskId(project.project_id)}`
    + ` filed=${moveNow ? 'moved' : 'deferred'} bound=${bound.length} unbound=${unbound.length}`);
  return {
    ok: true,
    result: { project, conversation, filed: moveNow ? 'moved' : 'deferred', bound, unbound },
  };
}

/**
 * Undo a filing: return the conversation to the unprojected root.
 *
 * The project it came from is left alone. It can hold other conversations, and
 * deleting a project cascades everything inside it, so removing one
 * conversation is never a reason to remove its project.
 */
export async function unfileConversation(
  userId: string,
  cid: string,
  opts: { moveNow?: boolean } = {},
): Promise<chats.ConversationMoveResult> {
  if (opts.moveNow !== false) return chats.moveConversationOutOfProject(userId, cid);
  // Undoing has the same constraint as filing: the relocation refuses while the
  // turn holds the session files open, so it waits for the same boundary.
  const conversation = await chats.getConversationMetadata(userId, cid);
  if (!conversation) return { ok: false, error: 'not_found' };
  if (!conversation.project_id) return { ok: false, error: 'not_in_project' };
  _pendingFilings.set(_pendingKey(userId, cid), { kind: 'unfile' });
  return { ok: true, conversation };
}

// ── Deferred filing ──────────────────────────────────────────────────────
//
// A tool cannot relocate its own conversation: the relocation refuses while a
// turn holds the session files open. The project and its bindings are created
// during the turn and the relocation waits for the conversation to go quiescent,
// which is the same boundary the bus already uses for run-scoped cleanup.
//
// The intent lives in memory because it belongs to one turn. A crash before the
// boundary loses that turn anyway, and leaves the project and its to-dos
// visible; the conversation simply stays where it was.

type PendingRelocation =
  | { kind: 'file'; projectId: string; projectName: string; todosCreated: number }
  | { kind: 'unfile' };

const _pendingFilings = new Map<string, PendingRelocation>();
const _filingsInProgress = new Set<string>();

function _pendingKey(userId: string, cid: string): string {
  return `${userId}\u0000${cid}`;
}

export function hasPendingConversationFiling(userId: string, cid: string): boolean {
  return _pendingFilings.has(_pendingKey(userId, cid));
}

/** Keep the setup receipt, not the requested backlog count. A failure at the
 *  boundary must still tell the user which existing project to choose. */
export function setPendingConversationFilingTodoCount(
  userId: string,
  cid: string,
  projectId: string,
  todosCreated: number,
): void {
  const pending = _pendingFilings.get(_pendingKey(userId, cid));
  if (pending?.kind === 'file' && pending.projectId === projectId
    && Number.isSafeInteger(todosCreated) && todosCreated >= 0) {
    pending.todosCreated = todosCreated;
  }
}

type FiledListener = (event: { userId: string; conversation: chats.Conversation }) => void;
const _filedListeners: FiledListener[] = [];

/** Host-initiated filing has no renderer request to answer, so the sidebar is
 *  told out of band. */
export function onConversationFiled(cb: FiledListener): void {
  if (typeof cb === 'function') _filedListeners.push(cb);
}

type FilingFailedListener = (event: {
  userId: string; cid: string; projectId: string; projectName: string; todosCreated: number;
} | { userId: string; cid: string; kind: 'unfile' }) => void;
const _filingFailedListeners: FilingFailedListener[] = [];

/** Notify the owner once; retry uses the existing picker and project. */
export function onConversationFilingFailed(cb: FilingFailedListener): void {
  if (typeof cb === 'function') _filingFailedListeners.push(cb);
}

/**
 * Complete or drop a deferred filing. Called once per conversation at the
 * quiescent boundary; `discard` is the cancelled run, whose reply the user never
 * received.
 */
export async function drainConversationFiling(
  userId: string,
  cid: string,
  discard = false,
): Promise<void> {
  const key = _pendingKey(userId, cid);
  const pending = _pendingFilings.get(key);
  if (!pending) return;
  _pendingFilings.delete(key);
  if (discard) {
    log.info(`pending relocation discarded uid=${maskId(userId)} cid=${maskId(cid)} kind=${pending.kind}`);
    return;
  }
  let moved: chats.ConversationMoveResult;
  try {
    moved = pending.kind === 'file'
      ? await chats.moveConversationToProject(userId, cid, pending.projectId)
      : await chats.moveConversationOutOfProject(userId, cid);
  } catch (error) {
    log.warn('pending relocation threw', { kind: pending.kind, error: logErrorSummary(error) });
    moved = { ok: false, error: 'move_failed' };
  }
  if (!moved.ok) {
    log.warn(`pending relocation failed uid=${maskId(userId)} cid=${maskId(cid)} kind=${pending.kind}`
      + ` reason=${(moved as { error: string }).error}`);
    for (const cb of _filingFailedListeners) {
      try {
        cb(pending.kind === 'file'
          ? { userId, cid, projectId: pending.projectId, projectName: pending.projectName, todosCreated: pending.todosCreated }
          : { userId, cid, kind: 'unfile' });
      } catch { /* a listener must never break terminal cleanup */ }
    }
    return;
  }
  const conversation = (moved as { conversation: chats.Conversation }).conversation;
  for (const cb of _filedListeners) {
    try { cb({ userId, conversation }); } catch { /* a listener must never break the move */ }
  }
}
