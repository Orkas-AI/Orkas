/**
 * Group-chat state — members.json + state.json IO + session id builders.
 *
 * Two small JSON files per conversation, both under
 * `<uid>/cloud/chats/<cid>/`:
 *
 *   members.json — the current actor roster. Commander + user are seeded
 *     when the conv is first sent to; agents auto-join the first time
 *     they're @-mentioned.
 *
 *   state.json — `status` (idle / running / aborted), `last_active_at`,
 *     and `in_flight` (which actor workers are currently running).
 *     Updated by `bus.ts`; UI subscribes via the streamEvents channel.
 *
 * Reserved actor ids: `commander` (the orchestrator) and `user` (the human).
 * Agent actor ids are the agent_id verbatim — collisions with reserved
 * tokens are rejected by `safeId` ∩ "not in RESERVED" elsewhere.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import {
  userChatsDir, projectChatIndexFile, userRunningConversationsFile,
} from '../../paths';
import { conversationLayout, listProjectIds } from '../../util/project-layout';
import {
  genId12, nowIso, readJson, writeJson, safeId,
} from '../../storage';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.state');

// ── Types ────────────────────────────────────────────────────────────────

export type ActorKind = 'commander' | 'user' | 'agent' | 'worker';

export interface Actor {
  kind: ActorKind;
  /** `commander` / `user` for the two reserved roles; agent_id otherwise. */
  id: string;
  /** Display name. Commander/user fall back to localized strings in UI. */
  name?: string;
  joined_at: string;
}

export interface MembersFile {
  version: 1;
  actors: Actor[];
}

export type GroupStatus = 'idle' | 'running' | 'aborted';

export interface RunningConversationEntry {
  conversation_id: string;
  project_id?: string;
}

export interface RunningConversationRegistry {
  version: 1;
  items: RunningConversationEntry[];
}

export interface OrchestrationLedger {
  version: 1;
  id: string;
  kind: 'suspended_orchestration';
  status: 'waiting_for_agent' | 'waiting_for_form' | 'interrupted';
  blocked_on: 'agent_handoff' | 'agent_form';
  source_tool?: 'hand_off_to' | 'dispatch_to' | 'run_worker';
  owner_agent_id: string;
  owner_agent_name?: string;
  form_id?: string;
  user_goal: string;
  handoff_message: string;
  resume_instruction: string;
  created_at: string;
  updated_at: string;
  interrupted_at?: string;
  interrupt_message?: string;
}

export interface StateFile {
  version: 1;
  status: GroupStatus;
  last_active_at: string;
  /** Actor ids currently running their worker loop. */
  in_flight: string[];
  /** Per-conversation workspace subdirectory basename (relative to the
   *  user's root workspace). Lazily filled by `conv_workspace.ts` on the
   *  first write_file in this conversation; **empty / missing → legacy
   *  conversations stay at the root workspace** (no migration). Once set
   *  it is **frozen** — renaming the conv title afterwards does not move
   *  the directory or update this field. See `conv_workspace.ts` for the
   *  slug rules and the placeholder fallback. */
  workspace_dir?: string;
  /** Project directory for coding-agent (claude / codex) dispatches in
   *  this conversation. Initialised on the first coding-agent turn from
   *  that agent's detail-page project-dir setting; missing setting =
   *  effective workspace path. Absolute path. Missing / empty → coding
   *  agents fall back to the conv's workspace root. The field is
   *  per-conversation, NOT per-agent: one project for the whole
   *  conversation across however many coding agents it has. */
  coding_project_dir?: string;
  /** True when the user picked `coding_project_dir` explicitly, either
   *  via the agent detail page's custom project-dir setting at initial
   *  conversation setup, or via the `<agent-input-form>` directory
   *  picker (form-submit hook in `group_chat/index.ts`). Cleared
   *  whenever `coding_project_dir` is cleared. */
  coding_project_dir_explicit?: boolean;
  /** Conversation-scoped absolute roots for file tools. Used by narrow
   *  system-created workflows such as sync-conflict resolution where the
   *  target file lives outside the active workspace. */
  tool_extra_roots?: string[];
  /** The "floor": the actor a no-`@` user message currently routes to.
   *  Absent ⇒ commander (the default orchestrator). Set to an agent id when
   *  the commander hands the conversation off to that agent via `hand_off_to`
   *  (so the user keeps talking to it without re-`@`-ing every message), and
   *  reset to commander when the agent hands back, the user `@commander`s, or
   *  the UI returns control. Server-authoritative + model-decided: it is the
   *  single source of truth for "who the user is talking to", mirrored to the
   *  renderer for free since `state_changed` carries the whole StateFile. */
  active_recipient?: string;
  /** Lightweight suspended-orchestration state. This is deliberately NOT the
   *  old plan DAG: it records only the interactive hand-off that is currently
   *  blocking a larger commander-owned task, plus the instruction needed to
   *  resume after the agent hands back. `active_recipient` answers "who gets
   *  the next no-@ user message"; this answers "what commander task should be
   *  resumed when that interaction completes." */
  orchestration_ledger?: OrchestrationLedger;
  /** System-created sync-conflict resolution metadata. A commander turn may
   *  close only these records, and only by emitting a matching XML result. */
  sync_conflict_resolution?: {
    version: 1;
    conflicts: {
      id: string;
      rel_path: string;
      current_path: string;
    }[];
  };
}

export const COMMANDER_ID = 'commander';
export const USER_ID = 'user';
export const RESERVED_IDS: ReadonlySet<string> = new Set([COMMANDER_ID, USER_ID]);

function _cleanLedgerText(v: unknown, max = 4000): string {
  return String(typeof v === 'string' ? v : '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function _sanitizeOrchestrationLedger(v: unknown): OrchestrationLedger | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const row = v as Record<string, unknown>;
  const owner = typeof row.owner_agent_id === 'string' ? row.owner_agent_id.trim() : '';
  if (!owner || !safeId(owner) || RESERVED_IDS.has(owner)) return undefined;
  const status = row.status === 'interrupted'
    ? 'interrupted'
    : row.status === 'waiting_for_form'
      ? 'waiting_for_form'
      : 'waiting_for_agent';
  const blocked_on = row.blocked_on === 'agent_form' || status === 'waiting_for_form'
    ? 'agent_form'
    : 'agent_handoff';
  const sourceTool = row.source_tool === 'hand_off_to' || row.source_tool === 'dispatch_to' || row.source_tool === 'run_worker'
    ? row.source_tool
    : undefined;
  const formId = typeof row.form_id === 'string' && /^[a-f0-9]{8,64}$/.test(row.form_id)
    ? row.form_id
    : undefined;
  const id = typeof row.id === 'string' && /^[A-Za-z0-9_.-]+$/.test(row.id) ? row.id : genId12();
  const now = nowIso();
  const user_goal = _cleanLedgerText(row.user_goal);
  const handoff_message = _cleanLedgerText(row.handoff_message);
  const resume_instruction = _cleanLedgerText(row.resume_instruction);
  if (!resume_instruction) return undefined;
  return {
    version: 1,
    id,
    kind: 'suspended_orchestration',
    status,
    blocked_on,
    ...(sourceTool ? { source_tool: sourceTool } : {}),
    owner_agent_id: owner,
    ...(formId ? { form_id: formId } : {}),
    ...(typeof row.owner_agent_name === 'string' && row.owner_agent_name.trim()
      ? { owner_agent_name: _cleanLedgerText(row.owner_agent_name, 200) }
      : {}),
    user_goal,
    handoff_message,
    resume_instruction,
    created_at: typeof row.created_at === 'string' && row.created_at ? row.created_at : now,
    updated_at: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : now,
    ...(typeof row.interrupted_at === 'string' && row.interrupted_at ? { interrupted_at: row.interrupted_at } : {}),
    ...(typeof row.interrupt_message === 'string' && row.interrupt_message.trim()
      ? { interrupt_message: _cleanLedgerText(row.interrupt_message) }
      : {}),
  };
}

// ── session_id builders ──────────────────────────────────────────────────
// Format: `<kind>-<tail>` (CLAUDE.md §5). User scoping comes from the path root
// (`<activeUid>/{cloud,local}/sessions/<sid>.jsonl`), not from the session_id.

/** Commander session — one per conversation, shared across all turns. */
export function buildGconvSessionId(cid: string): string {
  return `gconv-${cid}`;
}

/** Per-agent session — one per (conv, agent), shared across all the agent's
 * turns in that conv. */
export function buildGmemberSessionId(cid: string, agentId: string): string {
  return `gmember-${cid}-${agentId}`;
}

/** Ephemeral anonymous-worker session (G8b). One per spun-up worker; throwaway
 * — lands under `local/sessions/` (machine-private, GC'd, never synced) since
 * the worker is one-shot and explicitly purged after it hands its result back
 * to the commander. The `gworker` kind is registered as ephemeral in
 * `session-store.ts`. */
export function buildGworkerSessionId(cid: string, workerId: string): string {
  return `gworker-${cid}-${workerId}`;
}

/** Resolve an actor's session id from its kind/id. The user actor has no
 * session — it's the human. Throws on unknown kind. */
export function actorSessionId(cid: string, actor: Actor): string {
  if (actor.kind === 'commander') return buildGconvSessionId(cid);
  if (actor.kind === 'agent') return buildGmemberSessionId(cid, actor.id);
  if (actor.kind === 'worker') return buildGworkerSessionId(cid, actor.id);
  throw new Error(`actor ${actor.kind}/${actor.id} has no session`);
}

// ── Members IO ───────────────────────────────────────────────────────────

function ensureGroupDir(uid: string, cid: string, projectIdHint?: string | null): string {
  const d = conversationLayout(uid, cid, projectIdHint).groupDir;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function readMembers(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<MembersFile> {
  const file = conversationLayout(uid, cid, projectIdHint).membersFile;
  if (!fs.existsSync(file)) return { version: 1, actors: [] };
  try {
    const data: any = await readJson(file);
    if (data && typeof data === 'object' && Array.isArray(data.actors)) {
      return { version: 1, actors: data.actors as Actor[] };
    }
  } catch (err) {
    log.warn(`read members failed user=${uid} cid=${cid}: ${(err as Error).message}`);
  }
  return { version: 1, actors: [] };
}

async function writeMembers(
  uid: string,
  cid: string,
  m: MembersFile,
  projectIdHint?: string | null,
): Promise<void> {
  ensureGroupDir(uid, cid, projectIdHint);
  await writeJson(conversationLayout(uid, cid, projectIdHint).membersFile, m);
}

/** Idempotent. Returns true if the actor was newly added.
 *
 *  Mutex-guarded against concurrent callers — `groupChat.send` and
 *  `streamEvents` both call `seedReservedActors` on the same microtask
 *  cycle when the user submits the very first message of a new conv, and
 *  without serialisation the two `addMember(commander)` calls race on the
 *  members.json tmp-rename, surfacing as
 *  `ENOENT: ... members.json.tmp -> members.json` and killing the stream.
 *  Reuses `_stateLock` because it's already per-`(uid,cid)` and members
 *  shares the cid scope. */
export async function addMember(
  uid: string,
  cid: string,
  actor: Omit<Actor, 'joined_at'>,
  projectIdHint?: string | null,
): Promise<boolean> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const members = await readMembers(uid, cid, projectIdHint);
    if (members.actors.find((a) => a.id === actor.id)) return false;
    const next: Actor = { ...actor, joined_at: nowIso() };
    members.actors.push(next);
    await writeMembers(uid, cid, members, projectIdHint);
    log.info(`member-joined user=${uid} cid=${cid} actor=${actor.id} kind=${actor.kind}${actor.name ? ` name=${actor.name}` : ''}`);
    return true;
  });
}

/** Seed commander + user at conv creation / first activity. Idempotent. */
export async function seedReservedActors(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<void> {
  await addMember(uid, cid, { kind: 'commander', id: COMMANDER_ID, name: 'Commander' }, projectIdHint);
  await addMember(uid, cid, { kind: 'user', id: USER_ID, name: 'User' }, projectIdHint);
}

export async function findActor(uid: string, cid: string, actorId: string): Promise<Actor | null> {
  const m = await readMembers(uid, cid);
  return m.actors.find((a) => a.id === actorId) || null;
}

export async function isMember(uid: string, cid: string, actorId: string): Promise<boolean> {
  return (await findActor(uid, cid, actorId)) !== null;
}

/** Lazy-add an agent actor; called by router when @<aid> resolves to an
 * unknown-but-valid agent. Returns true if the actor was newly added. */
export async function ensureAgentMember(
  uid: string, cid: string, agentId: string, name?: string,
): Promise<boolean> {
  if (!safeId(agentId) || RESERVED_IDS.has(agentId)) return false;
  return addMember(uid, cid, { kind: 'agent', id: agentId, ...(name ? { name } : {}) });
}

/** Sync an agent's display name into every conversation roster that already
 *  has it as a member. Called by `agents.updateCustomAgent` when the name
 *  changes — without it, the @-router's roster-first lookup keeps resolving
 *  on the snapshot copied at member-join time, so old conversations would
 *  still respond to `@<old-name>`. Returns the number of rosters touched. */
export async function renameAgentInMembers(
  uid: string, agentId: string, newName: string,
): Promise<number> {
  if (!uid || !safeId(agentId) || RESERVED_IDS.has(agentId) || !newName) return 0;
  const indexFiles = [
    path.join(userChatsDir(uid), '_index.json'),
    ...listProjectIds(uid).map((pid) => projectChatIndexFile(uid, pid)),
  ];
  const cids = new Set<string>();
  try {
    for (const indexFile of indexFiles) {
      if (!fs.existsSync(indexFile)) continue;
      const data: any = await readJson(indexFile);
      const items: any[] = Array.isArray(data) ? data
        : (data && Array.isArray(data.items) ? data.items : []);
      for (const item of items) {
        const cid = item && typeof item.conversation_id === 'string' ? item.conversation_id : '';
        if (cid && safeId(cid)) cids.add(cid);
      }
    }
  } catch (err) {
    log.warn(`read conv index failed user=${uid}: ${(err as Error).message}`);
    return 0;
  }
  let touched = 0;
  for (const cid of cids) {
    const file = conversationLayout(uid, cid).membersFile;
    if (!fs.existsSync(file)) continue;
    let m: MembersFile;
    try { m = await readMembers(uid, cid); }
    catch { continue; }
    const actor = m.actors.find((a) => a.id === agentId);
    if (!actor || actor.name === newName) continue;
    actor.name = newName;
    try {
      await writeMembers(uid, cid, m);
      touched += 1;
    } catch (err) {
      log.warn(`write members failed user=${uid} cid=${cid}: ${(err as Error).message}`);
    }
  }
  if (touched > 0) log.info(`renamed agent=${agentId} → "${newName}" in ${touched} conv(s) user=${uid}`);
  return touched;
}

// ── State IO ─────────────────────────────────────────────────────────────

export async function readState(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<StateFile> {
  const file = conversationLayout(uid, cid, projectIdHint).stateFile;
  if (!fs.existsSync(file)) {
    return { version: 1, status: 'idle', last_active_at: nowIso(), in_flight: [] };
  }
  try {
    const data: any = await readJson(file);
    if (data && typeof data === 'object') {
      const orchestrationLedger = _sanitizeOrchestrationLedger(data.orchestration_ledger);
      return {
        version: 1,
        status: (data.status as GroupStatus) || 'idle',
        last_active_at: typeof data.last_active_at === 'string' ? data.last_active_at : nowIso(),
        in_flight: Array.isArray(data.in_flight) ? data.in_flight.filter((s: unknown) => typeof s === 'string') : [],
        ...(typeof data.workspace_dir === 'string' && data.workspace_dir
          ? { workspace_dir: data.workspace_dir }
          : {}),
        ...(typeof data.coding_project_dir === 'string' && data.coding_project_dir
          ? { coding_project_dir: data.coding_project_dir }
          : {}),
        ...(typeof data.coding_project_dir_explicit === 'boolean'
          ? { coding_project_dir_explicit: data.coding_project_dir_explicit }
          : {}),
        ...(Array.isArray(data.tool_extra_roots)
          ? { tool_extra_roots: data.tool_extra_roots.filter((s: unknown) => (
              typeof s === 'string' && path.isAbsolute(s)
            )) }
          : {}),
        ...(typeof data.active_recipient === 'string' && data.active_recipient
          && data.active_recipient !== COMMANDER_ID
          ? { active_recipient: data.active_recipient }
          : {}),
        ...(orchestrationLedger ? { orchestration_ledger: orchestrationLedger } : {}),
        ...(Array.isArray(data.sync_conflict_resolution?.conflicts)
          ? {
              sync_conflict_resolution: {
                version: 1,
                conflicts: data.sync_conflict_resolution.conflicts
                  .map((item: unknown) => {
                    const row = item as Record<string, unknown>;
                    return {
                      id: typeof row?.id === 'string' ? row.id : '',
                      rel_path: typeof row?.rel_path === 'string' ? row.rel_path : '',
                      current_path: typeof row?.current_path === 'string' ? row.current_path : '',
                    };
                  })
                  .filter((item: { id: string; rel_path: string; current_path: string }) => (
                    /^[A-Za-z0-9_.-]+$/.test(item.id)
                    && item.rel_path.startsWith('cloud/')
                    && path.isAbsolute(item.current_path)
                  )),
              },
            }
          : {}),
      };
    }
  } catch (err) {
    log.warn(`read state failed user=${uid} cid=${cid}: ${(err as Error).message}`);
  }
  return { version: 1, status: 'idle', last_active_at: nowIso(), in_flight: [] };
}

async function writeStateRaw(uid: string, cid: string, s: StateFile): Promise<void> {
  ensureGroupDir(uid, cid);
  await writeJson(conversationLayout(uid, cid).stateFile, s);
}

// A compact local journal makes boot crash recovery proportional to the
// number of turns that were running at shutdown instead of total history.
// Per-user serialisation prevents two conversations starting/stopping at the
// same time from losing each other's registry update.
const _runningRegistryMutex = new Map<string, Mutex>();
function _runningRegistryLock(uid: string): Mutex {
  let m = _runningRegistryMutex.get(uid);
  if (!m) { m = new Mutex(); _runningRegistryMutex.set(uid, m); }
  return m;
}

function _sanitizeRunningRegistry(data: unknown): RunningConversationRegistry | null {
  const row = data as Record<string, unknown> | null;
  if (!row || row.version !== 1 || !Array.isArray(row.items)) return null;
  const seen = new Set<string>();
  const items: RunningConversationEntry[] = [];
  for (const raw of row.items) {
    const item = raw as Record<string, unknown> | null;
    const cid = typeof item?.conversation_id === 'string' ? item.conversation_id : '';
    if (!safeId(cid)) return null;
    if (seen.has(cid)) continue;
    seen.add(cid);
    if (item?.project_id !== undefined
      && (typeof item.project_id !== 'string' || !safeId(item.project_id))) return null;
    const pid = typeof item?.project_id === 'string' ? item.project_id : '';
    items.push({ conversation_id: cid, ...(pid ? { project_id: pid } : {}) });
  }
  return { version: 1, items };
}

async function _readRunningRegistry(uid: string): Promise<RunningConversationRegistry | null> {
  try {
    return _sanitizeRunningRegistry(await readJson(userRunningConversationsFile(uid)));
  } catch {
    return null;
  }
}

/** Read the compact boot journal. `valid=false` requests a one-time indexed
 * migration scan for installs upgrading from before the journal existed. */
export async function readRunningConversationRegistry(
  uid: string,
): Promise<{ valid: boolean; items: RunningConversationEntry[] }> {
  return _runningRegistryLock(uid).runExclusive(async () => {
    const registry = await _readRunningRegistry(uid);
    return registry
      ? { valid: true, items: registry.items }
      : { valid: false, items: [] };
  });
}

/** Establish an empty valid journal without overwriting a concurrently
 * created entry. Used after the one-time migration fallback is selected. */
export async function ensureRunningConversationRegistry(uid: string): Promise<void> {
  await _runningRegistryLock(uid).runExclusive(async () => {
    if (await _readRunningRegistry(uid)) return;
    await writeJson(userRunningConversationsFile(uid), { version: 1, items: [] });
  });
}

async function _trackRunningConversation(uid: string, cid: string): Promise<void> {
  await _runningRegistryLock(uid).runExclusive(async () => {
    const registry = await _readRunningRegistry(uid) || { version: 1 as const, items: [] };
    const layout = conversationLayout(uid, cid);
    const next: RunningConversationEntry = {
      conversation_id: cid,
      ...(layout.projectId ? { project_id: layout.projectId } : {}),
    };
    const index = registry.items.findIndex((item) => item.conversation_id === cid);
    if (index >= 0
      && registry.items[index].project_id === next.project_id) return;
    if (index >= 0) registry.items[index] = next;
    else registry.items.push(next);
    await writeJson(userRunningConversationsFile(uid), registry);
  });
}

export async function untrackRunningConversation(uid: string, cid: string): Promise<void> {
  await _runningRegistryLock(uid).runExclusive(async () => {
    const registry = await _readRunningRegistry(uid);
    if (!registry) return;
    const items = registry.items.filter((item) => item.conversation_id !== cid);
    if (items.length === registry.items.length) return;
    await writeJson(userRunningConversationsFile(uid), { version: 1, items });
  });
}

async function _writeStatusTransition(
  uid: string, cid: string, current: GroupStatus, next: GroupStatus, state: StateFile,
): Promise<void> {
  // Register before persisting `running`: a crash can leave an extra journal
  // row (self-healing), but must never leave an untracked running state.
  if (current !== 'running' && next === 'running') {
    await _trackRunningConversation(uid, cid);
  }
  await writeStateRaw(uid, cid, state);
  // Persist non-running state before removing the row for the same reason.
  if (current === 'running' && next !== 'running') {
    await untrackRunningConversation(uid, cid);
  }
}

// Per-cid serialisation lock for state.json read-modify-write. Without
// it, concurrent `setStatus` / `markInFlight` calls (e.g. abort racing
// against a worker's turn-start `_syncStateStatus(forceRunning)`) can
// both read the same baseline, both write, and the slower one's write
// wins — silently overwriting the other's intent. async-mutex serialises
// per-cid and is already in the dep whitelist (used elsewhere for jsonl
// append). Lazy create so we only pay for cids that actually see traffic.
const _stateMutex = new Map<string, Mutex>();
function _stateLock(uid: string, cid: string): Mutex {
  const k = `${uid}:${cid}`;
  let m = _stateMutex.get(k);
  if (!m) { m = new Mutex(); _stateMutex.set(k, m); }
  return m;
}

export async function setStatus(uid: string, cid: string, status: GroupStatus): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const current = s.status;
    s.status = status;
    s.last_active_at = nowIso();
    if (status !== 'running') s.in_flight = [];
    await _writeStatusTransition(uid, cid, current, status, s);
    return s;
  });
}

/** Atomic read-decide-write status transition. The `decide` callback runs
 *  with the lock held and the current status passed in; return the new
 *  status or `null` to leave it unchanged. Callers needing "set X only if
 *  Y" semantics use this so the read + decision can't race a concurrent
 *  writer (e.g. `_syncStateStatus` deciding 'running' vs 'idle' must NOT
 *  override an `abort` that happened in the meantime). */
export async function transitionStatus(
  uid: string, cid: string,
  decide: (cur: GroupStatus) => GroupStatus | null,
): Promise<{ changed: boolean; state: StateFile }> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const cur = s.status;
    const next = decide(cur);
    if (next === null || next === cur) return { changed: false, state: s };
    s.status = next;
    s.last_active_at = nowIso();
    if (next !== 'running') s.in_flight = [];
    await _writeStatusTransition(uid, cid, cur, next, s);
    return { changed: true, state: s };
  });
}

/** Set the conversation floor (`active_recipient`). Pass an agent id to hand the
 *  user off to that agent; pass `commander` / `user` / empty to reset the floor
 *  to the commander (stored as absence). Mutex-guarded like `setStatus` so a
 *  hand-off can't race a concurrent status write. Returns the new state. */
export async function setActiveRecipient(uid: string, cid: string, recipientId: string): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const next = (recipientId && recipientId !== COMMANDER_ID && recipientId !== USER_ID)
      ? recipientId : '';
    if (next) s.active_recipient = next;
    else delete s.active_recipient;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

export async function setOrchestrationLedger(
  uid: string,
  cid: string,
  ledger: Omit<OrchestrationLedger, 'version' | 'id' | 'kind' | 'status' | 'created_at' | 'updated_at'>
    & Partial<Pick<OrchestrationLedger, 'id' | 'status' | 'created_at'>>,
): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const now = nowIso();
    s.orchestration_ledger = {
      version: 1,
      id: ledger.id || genId12(),
      kind: 'suspended_orchestration',
      status: ledger.status || 'waiting_for_agent',
      blocked_on: ledger.blocked_on,
      ...(ledger.source_tool ? { source_tool: ledger.source_tool } : {}),
      owner_agent_id: ledger.owner_agent_id,
      ...(ledger.form_id ? { form_id: ledger.form_id } : {}),
      ...(ledger.owner_agent_name ? { owner_agent_name: ledger.owner_agent_name } : {}),
      user_goal: _cleanLedgerText(ledger.user_goal),
      handoff_message: _cleanLedgerText(ledger.handoff_message),
      resume_instruction: _cleanLedgerText(ledger.resume_instruction),
      created_at: ledger.created_at || now,
      updated_at: now,
    };
    s.last_active_at = now;
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

export async function clearOrchestrationLedger(uid: string, cid: string): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    delete s.orchestration_ledger;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

export async function markOrchestrationInterrupted(
  uid: string,
  cid: string,
  interruptMessage: string,
  ownerAgentId?: string,
): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    if (
      s.orchestration_ledger
      && s.orchestration_ledger.status !== 'interrupted'
      && (!ownerAgentId || s.orchestration_ledger.owner_agent_id === ownerAgentId)
    ) {
      const now = nowIso();
      s.orchestration_ledger = {
        ...s.orchestration_ledger,
        status: 'interrupted',
        interrupt_message: _cleanLedgerText(interruptMessage),
        interrupted_at: now,
        updated_at: now,
      };
      s.last_active_at = now;
      await writeStateRaw(uid, cid, s);
    }
    return s;
  });
}

export async function takeOrchestrationLedgerForAgent(
  uid: string,
  cid: string,
  agentId: string,
): Promise<OrchestrationLedger | null> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const ledger = s.orchestration_ledger;
    if (!ledger || ledger.owner_agent_id !== agentId || ledger.status !== 'waiting_for_agent') return null;
    delete s.orchestration_ledger;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return ledger;
  });
}

export async function takeOrchestrationLedgerForForm(
  uid: string,
  cid: string,
  agentId: string,
  formId: string,
): Promise<OrchestrationLedger | null> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const ledger = s.orchestration_ledger;
    if (
      !ledger
      || ledger.owner_agent_id !== agentId
      || ledger.status !== 'waiting_for_form'
      || (ledger.form_id && ledger.form_id !== formId)
    ) return null;
    delete s.orchestration_ledger;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return ledger;
  });
}

/** Add / remove an actor from the in_flight roster. **Does NOT touch
 *  `status`** — status is owned by `bus.ts::_syncStateStatus` which has
 *  visibility into queue state too. Touching status here would race the
 *  post-turn enqueue: turn ends → markInFlight(false) → status briefly
 *  flips to 'idle' before the next worker picks up its queued item, and
 *  any IPC consumer watching for 'idle' would break out prematurely.
 *
 *  Mutex-guarded against concurrent `setStatus` so the "read s, mutate
 *  in_flight, write s" cycle doesn't lose status changes that landed
 *  while we held a stale `s` snapshot. */
export async function markInFlight(uid: string, cid: string, actorId: string, running: boolean): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const have = s.in_flight.includes(actorId);
    if (running && !have) s.in_flight.push(actorId);
    if (!running && have) s.in_flight = s.in_flight.filter((id) => id !== actorId);
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

// In-memory throttle for `touchActivity`. `last_active_at` otherwise only
// moves at turn boundaries (setStatus / markInFlight), so a single long turn
// — a CLI agent rendering for 14 min, or a model turn grinding through many
// tool calls — leaves it frozen at turn-start. The renderer's stuck-turn
// watchdog (`renderer/modules/state.js`) reads `processing_since` (= this
// field) and declares "service restarted, resend" once it's >12 min stale,
// false-positiving on a turn that's actively streaming. `touchActivity`
// advances it on real activity so the watchdog only fires when the process
// is genuinely dead (no events → no bumps → it ages out correctly).
const _activityBumpAt = new Map<string, number>(); // `${uid}:${cid}` → epoch ms
const ACTIVITY_BUMP_THROTTLE_MS = 30 * 1000;

/** Bump `last_active_at` to now if it's been more than the throttle window
 *  since the last bump for this conversation. Hot-path safe: the throttle
 *  check is synchronous and short-circuits before any lock/IO, so callers
 *  may fire it per streamed event. Only writes while `status === 'running'`
 *  — a bump that lands just after turn-end must not resurrect an idle conv.
 *  Self-contained error handling: a transient state read/write failure
 *  during streaming must never break the turn, so callers fire-and-forget. */
export async function touchActivity(uid: string, cid: string): Promise<void> {
  const k = `${uid}:${cid}`;
  const now = Date.now();
  if (now - (_activityBumpAt.get(k) || 0) < ACTIVITY_BUMP_THROTTLE_MS) return;
  _activityBumpAt.set(k, now);
  try {
    await _stateLock(uid, cid).runExclusive(async () => {
      const s = await readState(uid, cid);
      if (s.status !== 'running') return;
      s.last_active_at = nowIso();
      await writeStateRaw(uid, cid, s);
    });
  } catch (err) {
    log.warn(`touchActivity failed cid=${cid}: ${(err as Error).message}`);
  }
}

/** Atomically lock in the per-conversation workspace subdirectory basename.
 *  No-op if the field is already set (frozen-on-first-write semantics — see
 *  `conv_workspace.ts`). Returns the resulting state. */
export async function setWorkspaceDirOnce(uid: string, cid: string, dir: string): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    if (s.workspace_dir) return s;
    s.workspace_dir = dir;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

/** Set / clear the per-conversation coding-agent project directory.
 *  Pass `''` (or missing) to clear; an absolute path otherwise.
 *  Caller is responsible for absolute-path validation — we only do
 *  string handling here. Returns the resulting state.
 *
 *  `opts.explicit` records whether this value came from a user-chosen
 *  custom directory (agent detail setting or `<agent-input-form>`).
 *  Clearing `dir` also clears the flag so the next initialisation
 *  doesn't accidentally inherit a stale `true`. */
export async function setCodingProjectDir(
  uid: string, cid: string, dir: string,
  opts: { explicit: boolean },
): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const trimmed = String(dir || '').trim();
    if (trimmed) {
      s.coding_project_dir = trimmed;
      if (opts.explicit) s.coding_project_dir_explicit = true;
      else delete s.coding_project_dir_explicit;
    } else {
      delete s.coding_project_dir;
      delete s.coding_project_dir_explicit;
    }
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

export async function setToolExtraRoots(uid: string, cid: string, roots: readonly string[]): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const clean = Array.from(new Set(
      roots
        .map((r) => String(r || '').trim())
        .filter((r) => r && path.isAbsolute(r)),
    ));
    if (clean.length) s.tool_extra_roots = clean;
    else delete s.tool_extra_roots;
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

export async function setSyncConflictResolution(
  uid: string,
  cid: string,
  conflicts: readonly { id: string; rel_path: string; current_path: string }[],
): Promise<StateFile> {
  return _stateLock(uid, cid).runExclusive(async () => {
    const s = await readState(uid, cid);
    const clean = conflicts
      .map((item) => ({
        id: String(item.id || '').trim(),
        rel_path: String(item.rel_path || '').replace(/\\/g, '/'),
        current_path: String(item.current_path || '').trim(),
      }))
      .filter((item) => (
        /^[A-Za-z0-9_.-]+$/.test(item.id)
        && item.rel_path.startsWith('cloud/')
        && path.isAbsolute(item.current_path)
      ));
    if (clean.length) {
      s.sync_conflict_resolution = { version: 1, conflicts: clean };
    } else {
      delete s.sync_conflict_resolution;
    }
    s.last_active_at = nowIso();
    await writeStateRaw(uid, cid, s);
    return s;
  });
}

/** Drop the whole group dir (called from chats.deleteConversation). */
export async function purgeGroupDir(uid: string, cid: string): Promise<void> {
  const dir = conversationLayout(uid, cid).groupDir;
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`purge group dir failed user=${uid} cid=${cid}: ${(err as Error).message}`);
    }
  }
  await untrackRunningConversation(uid, cid);
  // Suppress unused import lint when the function body is the only path consumer.
  void path;
}
