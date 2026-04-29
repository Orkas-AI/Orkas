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
  groupChatDir, groupChatMembersFile, groupChatStateFile,
} from '../../paths';
import { nowIso, readJson, writeJson, safeId } from '../../storage';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.state');

// ── Types ────────────────────────────────────────────────────────────────

export type ActorKind = 'commander' | 'user' | 'agent';

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

export interface StateFile {
  version: 1;
  status: GroupStatus;
  last_active_at: string;
  /** Actor ids currently running their worker loop. */
  in_flight: string[];
}

export const COMMANDER_ID = 'commander';
export const USER_ID = 'user';
export const RESERVED_IDS: ReadonlySet<string> = new Set([COMMANDER_ID, USER_ID]);

// ── session_id builders ──────────────────────────────────────────────────

/** Commander session — one per conversation, shared across all turns. */
export function buildGconvSessionId(uid: string, cid: string): string {
  return `${uid}-gconv-${cid}`;
}

/** Per-agent session — one per (conv, agent), shared across all the agent's
 * turns in that conv. */
export function buildGmemberSessionId(uid: string, cid: string, agentId: string): string {
  return `${uid}-gmember-${cid}-${agentId}`;
}

/** Resolve an actor's session id from its kind/id. The user actor has no
 * session — it's the human. Throws on unknown kind. */
export function actorSessionId(uid: string, cid: string, actor: Actor): string {
  if (actor.kind === 'commander') return buildGconvSessionId(uid, cid);
  if (actor.kind === 'agent') return buildGmemberSessionId(uid, cid, actor.id);
  throw new Error(`actor ${actor.kind}/${actor.id} has no session`);
}

// ── Members IO ───────────────────────────────────────────────────────────

function ensureGroupDir(uid: string, cid: string): string {
  const d = groupChatDir(uid, cid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function readMembers(uid: string, cid: string): Promise<MembersFile> {
  const file = groupChatMembersFile(uid, cid);
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

async function writeMembers(uid: string, cid: string, m: MembersFile): Promise<void> {
  ensureGroupDir(uid, cid);
  await writeJson(groupChatMembersFile(uid, cid), m);
}

/** Idempotent. Returns true if the actor was newly added. */
export async function addMember(uid: string, cid: string, actor: Omit<Actor, 'joined_at'>): Promise<boolean> {
  const members = await readMembers(uid, cid);
  if (members.actors.find((a) => a.id === actor.id)) return false;
  const next: Actor = { ...actor, joined_at: nowIso() };
  members.actors.push(next);
  await writeMembers(uid, cid, members);
  log.info(`member-joined user=${uid} cid=${cid} actor=${actor.id} kind=${actor.kind}${actor.name ? ` name=${actor.name}` : ''}`);
  return true;
}

/** Seed commander + user at conv creation / first activity. Idempotent. */
export async function seedReservedActors(uid: string, cid: string): Promise<void> {
  await addMember(uid, cid, { kind: 'commander', id: COMMANDER_ID, name: 'Commander' });
  await addMember(uid, cid, { kind: 'user', id: USER_ID, name: 'User' });
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

// ── State IO ─────────────────────────────────────────────────────────────

export async function readState(uid: string, cid: string): Promise<StateFile> {
  const file = groupChatStateFile(uid, cid);
  if (!fs.existsSync(file)) {
    return { version: 1, status: 'idle', last_active_at: nowIso(), in_flight: [] };
  }
  try {
    const data: any = await readJson(file);
    if (data && typeof data === 'object') {
      return {
        version: 1,
        status: (data.status as GroupStatus) || 'idle',
        last_active_at: typeof data.last_active_at === 'string' ? data.last_active_at : nowIso(),
        in_flight: Array.isArray(data.in_flight) ? data.in_flight.filter((s: unknown) => typeof s === 'string') : [],
      };
    }
  } catch (err) {
    log.warn(`read state failed user=${uid} cid=${cid}: ${(err as Error).message}`);
  }
  return { version: 1, status: 'idle', last_active_at: nowIso(), in_flight: [] };
}

async function writeStateRaw(uid: string, cid: string, s: StateFile): Promise<void> {
  ensureGroupDir(uid, cid);
  await writeJson(groupChatStateFile(uid, cid), s);
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
    s.status = status;
    s.last_active_at = nowIso();
    if (status !== 'running') s.in_flight = [];
    await writeStateRaw(uid, cid, s);
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
    await writeStateRaw(uid, cid, s);
    return { changed: true, state: s };
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

/** Drop the whole group dir (called from chats.deleteConversation). */
export async function purgeGroupDir(uid: string, cid: string): Promise<void> {
  const dir = groupChatDir(uid, cid);
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`purge group dir failed user=${uid} cid=${cid}: ${(err as Error).message}`);
    }
  }
  // Suppress unused import lint when the function body is the only path consumer.
  void path;
}
