/**
 * MessageBus — the actor / message-passing core of group chat.
 *
 * One bus instance per process. Per-cid state holds:
 *   - queues       : per-actor FIFO of inbound messages
 *   - workers      : per-actor worker loop handle (idle / running)
 *   - listeners    : IPC stream subscribers for that conversation
 *   - aborters     : per-actor AbortController (running turn)
 *
 * Workers are lazy: `enqueue` calls `ensureWorker(cid, actor)` which spins
 * the worker loop on first use and binds it to the actor's session id.
 *
 * Routing: bus only ever routes based on the resolved `to[]` from
 * `router.resolveRecipients`. Messages with `user` in `to[]` are written
 * to the group jsonl + emitted to listeners but never enqueue-d (the user
 * is the human; UI is the only consumer).
 */

import type { AgentTool } from '#core-agent';

import { createLogger } from '../../logger';
import {
  appendJsonlAtomic, genId12, nowIso, safeId,
} from '../../storage';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  Actor, ActorKind, COMMANDER_ID, USER_ID, RESERVED_IDS,
  actorSessionId, addMember, ensureAgentMember, readMembers, seedReservedActors,
  setStatus, markInFlight, readState, transitionStatus, setCodingProjectDir,
} from './state';
import {
  GroupMessage, appendVisible, readSlice, buildReplayPrefix,
  type MarketplaceInstallRequest,
} from './visibility';
import {
  resolveRecipients, parseMentions, buildMention,
  extractFormFromFinal, computeFormId, ChatFormPayload,
  extractAgentFieldBlocks, extractSkillContainers, decodeSubmission,
} from './router';
import * as skillsFeat from '../skills';
import {
  setPlan, updateStep, readPlan, formatPlanAnnouncement, formatPlanForPrompt,
  PlanSetInput, StepStatus, PlanFile,
} from './plan';
import * as planExecutor from './plan_executor';
import {
  userChatsDir, userSkillsDir, userAgentsDir,
  userMarketplaceSkillsDir, userMarketplaceAgentsDir, projectFilesDir,
} from '../../paths';
import * as agentsFeat from '../agents';
import { isDevEnv } from '../devtools';
import { isAgentEnabled } from '../component_enabled';
import { buildLanguageDirective, descriptionLang, t } from '../../i18n';
import * as marketplaceFeat from '../marketplace';
import { readInstalls } from '../marketplace_installs';
import { createSkillTurnBuffer, onAgentTurnEnd, onUserMessage } from '../expert_signals/turn_hooks';

const log = createLogger('group_chat.bus');

/** Minimal HTML escape for embedding raw error strings inside the
 *  failure-style `<span>` we emit on stream errors. Keeps `<`/`>`/`&`/`"`
 *  out of the renderer's markdown-ish rendering pass without pulling in
 *  a full sanitizer. */
function escapeHtmlForBubble(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a quality-validator rejection as a friendly user warning followed
 *  by a structured JSON fenced block. The fenced block survives into the
 *  LLM's own message history, giving it precise feedback to act on if the
 *  user asks for a fix in the next turn — no separate retry channel needed. */
function _formatValidationFailure(
  failed: { path: string; report: { violations: Array<{ rule: string; level: string; field: string; snippet: string; suggested_fix: string }> } }[],
): string {
  const friendly = '<span style="color:var(--danger)">⚠️ Some skill files failed quality validation and were not written.</span>';
  const machine = JSON.stringify({
    validation_failed: failed.flatMap((f) => f.report.violations
      .filter((v) => v.level === 'EXTREME')
      .map((v) => ({
        path: f.path, rule: v.rule, field: v.field,
        snippet: v.snippet, suggested_fix: v.suggested_fix,
      }))),
  }, null, 2);
  return `${friendly}\n\n\`\`\`json\n${machine}\n\`\`\``;
}

function _formatValidationWarnings(
  warnings: { path: string; report: { violations: Array<{ rule: string; level: string; field: string; snippet: string; suggested_fix: string }> } }[],
): string {
  const friendly = '<span style="color:var(--muted)">ℹ️ Quality validator advisories (the files were written):</span>';
  const items = warnings.flatMap((w) => w.report.violations
    .filter((v) => v.level !== 'EXTREME')
    .map((v) => `  - ${w.path}: **${v.rule}** — ${v.suggested_fix}`));
  return `${friendly}\n${items.join('\n')}`;
}

const MAX_PROCESS_ITEMS_PER_TURN = 300;
const MAX_WORKER_TURNS = 100; // hard ceiling against runaway loops

// ── Listener events (mirror the IPC streamEvents shape) ─────────────────

export type GroupEvent =
  /** A persisted group message. `turn_end: true` ONLY when this message is
   * the actor's own runTurn-end output (the "official" end-of-turn reply).
   * Tool-emitted side-effect messages (e.g. plan_set's plan announcement
   * or plan_executor's commander → agent dispatch) carry `turn_end: false`
   * (or absent). Renderer uses this to decide whether the message should
   * consume the actor's streaming placeholder (turn_end=true) or just
   * append a new bubble alongside (turn_end=false). Without this distinction,
   * a tool-emitted mid-turn message wrongly consumes commander's placeholder
   * and a NEW placeholder gets recreated by post-tool process events, ending
   * up as a stuck "thinking" bubble when commander's turn ends silently. */
  | { type: 'message'; cid: string; msg: GroupMessage; turn_end?: boolean }
  | { type: 'process'; cid: string; actor: string; data: Record<string, unknown> }
  /** A `create_artifact` tool call finished writing its bundle. The final
   * end-of-turn message still carries `msg.artifacts` for persistence; this
   * live event lets the renderer mount the iframe immediately instead of
   * waiting for the whole actor turn to finish. */
  | { type: 'artifact_created'; cid: string; actor: string; artifact: { id: string; title: string; agent_id: string } }
  | { type: 'plan_changed'; cid: string }
  | { type: 'state_changed'; cid: string; state: Awaited<ReturnType<typeof readState>> }
  | { type: 'member_joined'; cid: string; actor: Actor }
  | { type: 'aborted'; cid: string }
  /** Sent when an actor's turn ended without producing a persisted message
   * (executor outcome=silent). Renderer uses this to clear any unfinalized
   * placeholder bubble for that actor. Layered on top of `turn_end` flag —
   * the flag handles "consume only on my own end-of-turn", `turn_silent`
   * handles "I had no end-of-turn message at all". */
  | { type: 'turn_silent'; cid: string; actor: string };

export type GroupListener = (ev: GroupEvent) => void;

// ── Per-cid state ────────────────────────────────────────────────────────

interface QueueItem {
  msgId: string;
  fromActorId: string;
  /** Composed runtime payload — what the worker actually feeds the LLM,
   * including the `<msg from=X>...</msg>` wrapper. Built at enqueue time
   * so the queue is a real FIFO of LLM-ready turns, no last-minute
   * formatting at consume time. */
  llmPayload: string;
  /** Attachment file names declared on the source GroupMessage. The worker
   * builds a `<attachments><file path=... kind=.../></attachments>` block
   * via `buildAttachmentManifest` at consume time and prepends it to the
   * LLM payload so commander / agent can see file paths + kinds and
   * extract values for `inputs_schema` (especially `type=file` fields). */
  attachments?: string[];
  /** Shadow-tap marker: this turn was triggered NOT because the actor was
   * a declared recipient (`to` includes them), but because the bus woke
   * them as an observer (e.g. commander wakes on every agent → user reply
   * so it can advance the plan). If the LLM produces an empty final, the
   * post-turn enqueue is suppressed — otherwise every silent observation
   * would emit a "(no reply)" placeholder bubble and pollute the chat. */
  tap?: boolean;
  /** Plan-executor stamp: the plan step (1-based index) whose dispatch
   * created this turn. When the turn ends, `plan_executor.reconcile` uses
   * this to mark exactly THAT step as done (no actor-id guessing). `-1`
   * marks plan-complete synthesis turns where no individual step terminates. */
  triggered_step?: number;
}

interface WorkerState {
  uid: string;
  cid: string;
  actor: Actor;
  queue: QueueItem[];
  running: boolean;
  /** Pending wake promise — resolved on enqueue to break the await. */
  wake: (() => void) | null;
  abortController: AbortController | null;
  turnsThisActivation: number;
  /** Set by `dropConv` so the worker loop can exit cleanly instead of
   * blocking forever on `wake` after the cid state is gone. */
  terminated: boolean;
  /** Plan announcement text staged by `plan_set` mid-turn; merged into the
   * commander's turn-end message at runTurn end so the thinking process
   * rail and the plan card render in a single bubble (instead of two
   * separate ones, with the placeholder cleaned up by turn_silent). */
  pendingPlanAnnouncement?: string;
  /** Single-agent dispatches staged by `dispatch_to` mid-turn; flushed via
   * `bus.enqueue(forceTo=[X], dispatch:true)` at runTurn end so the recipient
   * worker can't jump the gun — it only wakes after commander's text reply persisted +
   * placeholder cleaned. Same staging pattern as pendingPlanAnnouncement +
   * deferred planExecutor.reconcile, just for direct dispatches. */
  pendingDispatches?: Array<{ to: string; message: string }>;
  /** Marketplace install confirmations requested during a commander turn.
   * The model can stage these via `marketplace_request_install`; the user
   * decides in the renderer before any install side effect happens. */
  pendingMarketplaceRequests?: MarketplaceInstallRequest[];
  /** Last marketplace rows returned to the model in this turn, keyed by
   *  `${kind}:${id}`. `marketplace_request_install` uses this to carry UI
   *  metadata such as agent avatar tokens without relying on the model to
   *  copy every field back. */
  marketplaceSearchResults?: Map<string, Partial<MarketplaceInstallRequest>>;
}

interface CidState {
  uid: string;
  cid: string;
  workers: Map<string, WorkerState>;
  listeners: Set<GroupListener>;
  /** Number of `enqueue()` calls currently in their async body. Each
   * enqueue does multiple awaits between "sender hands off the message"
   * and "recipient worker has the queue item" — during that window all
   * worker queues / running flags can transiently report empty even
   * though work is in flight. `isQuiescent` checks this counter so
   * upstream waiters (IPC stream / waitForQuiescent in tests) don't
   * declare the bus done in the gap. */
  pendingEnqueues: number;
  /** Absolute paths written by any actor in THIS conversation since the
   *  bus was loaded. Feeds the write-tools' uniquify `isMine` predicate
   *  so refining a file across turns overwrites in place — the LLM's
   *  mental model stays in lockstep with disk. Files the user pre-created
   *  are NOT in this set and still get `-N` suffixed, protecting work the
   *  model didn't author. In-memory only; an app restart resets it (a
   *  fresh process can't tell its own prior writes from the user's
   *  anyway). */
  producedPaths: Set<string>;
}

const _cids = new Map<string, CidState>();

function cidKey(uid: string, cid: string): string { return `${uid}:${cid}`; }

function getOrInitCid(uid: string, cid: string): CidState {
  const k = cidKey(uid, cid);
  let s = _cids.get(k);
  if (!s) {
    s = {
      uid, cid,
      workers: new Map(),
      listeners: new Set(),
      pendingEnqueues: 0,
      producedPaths: new Set(),
    };
    _cids.set(k, s);
  }
  return s;
}

export function subscribe(uid: string, cid: string, listener: GroupListener): () => void {
  const s = getOrInitCid(uid, cid);
  s.listeners.add(listener);
  return () => { s.listeners.delete(listener); };
}

function emit(state: CidState, ev: GroupEvent): void {
  for (const l of state.listeners) {
    try { l(ev); } catch (err) { log.warn(`listener threw: ${(err as Error).message}`); }
  }
}

/** True when nobody's running, every actor's queue is empty, AND no
 *  `enqueue()` is mid-flight. The IPC layer's "send-and-wait-for-reply"
 *  wrapper polls this on every state_changed event so it doesn't break
 *  out of the stream during the gaps:
 *   - Microtask gap between worker.runTurn ending and the next recipient
 *     worker's queue.shift+running=true (closed by `running=true` claim
 *     in `runWorkerLoop` before runTurn).
 *   - Async-body gap inside `enqueue()` between sender's runTurn finally
 *     (running=false) and recipient.queue.push (which only happens late
 *     in enqueue, after several awaits for member lookup / file IO).
 *     Closed by the `pendingEnqueues` counter below.
 */
export function isQuiescent(uid: string, cid: string): boolean {
  const s = _cids.get(cidKey(uid, cid));
  if (!s) return true;
  if (s.pendingEnqueues > 0) return false;
  for (const [, w] of s.workers) {
    if (w.running) return false;
    if (w.queue.length > 0) return false;
  }
  return true;
}

export function runtimeSnapshot(uid: string, cid: string): { processing: boolean; inFlight: string[] } {
  const s = _cids.get(cidKey(uid, cid));
  if (!s) return { processing: false, inFlight: [] };
  const inFlight: string[] = [];
  for (const [, w] of s.workers) {
    if (w.running) inFlight.push(w.actor.id);
  }
  return {
    processing: !isQuiescent(uid, cid),
    inFlight,
  };
}

/** Recompute the on-disk `status` field based on actual worker / queue
 *  state. Honors the sticky `aborted` flag — once aborted, ONLY an
 *  explicit USER `enqueue` clears it (so a follow-up worker reply
 *  triggered by the abort itself, like the "(stopped)" message,
 *  doesn't surreptitiously revert status to 'idle'). The whole
 *  read-decide-write is mutex-guarded via `transitionStatus`, so a
 *  concurrent `setStatus('aborted')` (from `bus.abort`) cannot land
 *  between our read and write and get clobbered. */
async function _syncStateStatus(state: CidState, forceRunning = false): Promise<void> {
  const want = (forceRunning || !isQuiescent(state.uid, state.cid)) ? 'running' : 'idle';
  const result = await transitionStatus(state.uid, state.cid, (cur) => {
    if (cur === 'aborted') return null; // sticky — only USER enqueue can clear
    return want;
  });
  if (result.changed) {
    emit(state, { type: 'state_changed', cid: state.cid, state: result.state });
  }
}

// ── Main jsonl helpers ───────────────────────────────────────────────────

function mainJsonlFile(uid: string, cid: string): string {
  return path.join(userChatsDir(uid), `${cid}.jsonl`);
}

async function appendMain(uid: string, cid: string, msg: GroupMessage): Promise<void> {
  const file = mainJsonlFile(uid, cid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await appendJsonlAtomic<GroupMessage>(file, msg);
  // Stamp `updated_at` on this cid's _index.json row so the sidebar can sort
  // by real last-activity time rather than file mtime (which sync clobbers
  // when pulling from another device — see chats.ts::listConversations).
  // Dynamic import to avoid the chats ↔ group_chat circular dep.
  try {
    const chats = await import('../chats');
    await chats.bumpConversationActivity(uid, cid, msg.ts);
  } catch (err) {
    log.warn('bumpConversationActivity failed', { uid, cid, error: (err as Error)?.message });
  }
}

// ── enqueue ──────────────────────────────────────────────────────────────

export interface EnqueueParams {
  uid: string;
  cid: string;
  fromActorId: string;
  text: string;
  attachments?: string[];
  produced?: string[];
  form?: ChatFormPayload;
  created_agents?: Array<{ agent_id: string; name: string; kind?: 'created' | 'updated' }>;
  created_skills?: Array<{ skill_id: string; name: string; kind?: 'created' | 'updated' }>;
  /** Interactive web-app artifacts produced this turn (via `create_artifact`).
   * `agent_id` is the producing actor — the renderer routes a user→artifact
   * interaction result back to it. */
  artifacts?: Array<{ id: string; title: string; agent_id: string }>;
  marketplace_requests?: MarketplaceInstallRequest[];
  plan_announcement?: boolean;
  /** Override resolved recipients (commander emitting plan announcement
   *  uses this to force `to=[user]`). Otherwise router decides. */
  forceTo?: string[];
  /** Plan-executor passes the dispatching step's index here so the recipient
   * worker's QueueItem carries it; when the recipient's turn ends, the
   * executor can mark THAT exact step as done (precise, no actor-id guess). */
  triggered_step?: number;
  /** True when this enqueue IS the actor's own end-of-turn message (called
   * from runTurn after the LLM stream completed). False / absent for any
   * tool-side-effect or plan-executor mid-turn enqueues. Renderer routes
   * the corresponding `message` event differently: `turn_end=true` consumes
   * the actor's streaming placeholder + finalizes; `turn_end=false` only
   * appends a new bubble, leaving the placeholder alive for the rest of
   * the turn. Critical for commander turns that emit multiple messages
   * mid-turn (plan_set's announcement + N dispatches) — without this, the
   * first mid-turn message wrongly consumes the placeholder and post-tool
   * process events recreate a new one that ends up stuck. */
  turn_end?: boolean;
  /** Mark this message as an internal plan-step dispatch (commander →
   * agent, fired by plan_executor). Persists for the agent's slice but the
   * renderer hides it from the user view — the plan announcement already
   * surfaced who's working on what. */
  dispatch?: boolean;
  /** Captured process trail (progress lines + non-assistant tool/lifecycle
   * events) accumulated during the actor's stream. `runTurn` collects these
   * and passes them through on the end-of-turn `persist` enqueue so a
   * history reload can rerender the rail. Stripped from visibility slices
   * before write — agent LLM replays don't need it. */
  process?: GroupMessage['process'];
}

/**
 * Persist a group message + dispatch to recipient queues. Returns the
 * persisted GroupMessage so callers can stitch it into UI events.
 *
 * Side effects:
 *   - Resolves recipients via router (or forceTo).
 *   - Auto-adds agent members for unknown @ tokens that resolve to a
 *     known agent_id.
 *   - Writes to `<cid>.jsonl` + each recipient actor's visibility slice.
 *   - Emits `message` event to listeners.
 *   - Wakes recipient workers (lazy-creates them).
 *   - If sender was an agent, also marks them as in_flight=false (their
 *     turn just ended) — though that's also done by the worker loop.
 */
export async function enqueue(params: EnqueueParams): Promise<GroupMessage> {
  const { uid, cid, fromActorId, text } = params;
  const state = getOrInitCid(uid, cid);
  // Mark in-flight enqueue. `isQuiescent` returns false while >0 so
  // callers waiting for "everything done" don't hit the gap between
  // a sender's running=false and the recipient.queue.push that lives
  // late in this body. Reset in `finally` to cover throws.
  state.pendingEnqueues += 1;
  try {
    return await _enqueueBody(params, state);
  } finally {
    state.pendingEnqueues -= 1;
  }
}

async function _enqueueBody(params: EnqueueParams, state: CidState): Promise<GroupMessage> {
  const { uid, cid, fromActorId, text } = params;

  // Reset the sticky `aborted` flag ONLY when the human (user) sends
  // a fresh message. Worker-emitted enqueues (commander/agent post-turn
  // replies, including the abort-cleanup "(stopped)" message) must NOT clear
  // the abort — otherwise a worker's own post-abort message would silently
  // un-stick the conversation and the next state_changed would flip back
  // to 'idle'/'running'.
  if (params.fromActorId === USER_ID) {
    const cur = await readState(uid, cid);
    if (cur.status === 'aborted') {
      await setStatus(uid, cid, 'idle');
    }
  }

  await seedReservedActors(uid, cid);
  const members = await readMembers(uid, cid);

  // Resolve recipients.
  const fromActor = members.actors.find((a) => a.id === fromActorId);
  const fromKind: ActorKind = fromActor?.kind || (fromActorId === USER_ID ? 'user' : fromActorId === COMMANDER_ID ? 'commander' : 'agent');

  let to: string[] = [];
  let unknown: string[] = [];
  if (params.forceTo && params.forceTo.length) {
    to = params.forceTo.slice();
  } else {
    // Build a global name → id map from the enabled agent registry so the
    // router can resolve `@<human-readable-name>` mentions. Keys are normalized
    // (lowercase + whitespace stripped) to match router's normalization,
    // so display names containing spaces ("Writing Helper") or mixed case
    // resolve correctly against the user's `@WritingHelper` token.
    const agentNameToId = new Map<string, string>();
    // Reserved-actor aliases — let agents/commander write `@指挥官` / `@用户`
    // (Chinese display names) instead of the literal reserved ids. Both
    // English and Chinese forms resolve to the same id. Lowercase keys
    // match router's `_normalizeNameKey`.
    agentNameToId.set('commander', COMMANDER_ID);
    agentNameToId.set('指挥官', COMMANDER_ID);
    agentNameToId.set('user', USER_ID);
    agentNameToId.set('用户', USER_ID);
    // Original-case display names (with internal spaces) — used by
    // `parseMentions` to greedy-match multi-word names. The lookup map
    // above can't be regex-matched against raw text because its keys are
    // already normalized (whitespace stripped). See `agentDisplayNames`
    // doc on `ResolveOpts` in router.ts.
    const agentDisplayNames: string[] = [];
    try {
      const all = await agentsFeat.listAgents();
      for (const a of all) {
        if (a.enabled === false) continue;
        if (a.name) {
          const key = a.name.toLowerCase().replace(/\s+/g, '');
          agentNameToId.set(key, a.agent_id);
          agentDisplayNames.push(a.name);
        }
      }
    } catch (err) {
      log.warn(`build agent name map failed cid=${cid}: ${(err as Error).message}`);
    }
    const r = resolveRecipients({
      fromKind,
      fromId: fromActorId,
      text,
      members: members.actors,
      agentNameToId,
      agentDisplayNames,
      resolveUnknown: (token) => {
        // Last-resort raw-id fallback. We can't sync-await getAgent here,
        // so just pass through; the post-resolve loop below does an async
        // pass for any unknown that's still a literal agent_id.
        if (RESERVED_IDS.has(token) || !safeId(token)) return null;
        return null;
      },
    });
    to = r.to;
    unknown = r.unknown;
  }

  // Synchronous router can't auto-resolve unknowns to agents. Now do an async
  // pass: any unknown token that maps to a real agent → add to recipients.
  for (const token of unknown.slice()) {
    if (!safeId(token)) continue;
    try {
      const ag = await agentsFeat.getAgent(token);
      if (ag && isAgentEnabled(uid, ag.agent_id)) {
        to.push(ag.agent_id);
        unknown = unknown.filter((u) => u !== token);
      }
    } catch (err) {
      log.warn(`agent lookup failed token=${token}: ${(err as Error).message}`);
    }
  }
  to = Array.from(new Set(to));

  // Project scope at dispatch time: if the conversation belongs to a
  // project, drop any recipient agent_id that isn't bound to the project
  // (CLAUDE.md §6 — "if recipient unavailable, hand off to commander").
  // Reserved ids (user / commander) always pass through. After filtering,
  // an empty `to` falls through to the sender-default rule below — for
  // user-initiated text that means "go to commander", which is the
  // explicit hand-off the requirement asks for. Cheap: one project.json
  // + bindings.json read,
  // resolveProjectScope already memoises file existence checks. Skipped
  // when the conv has no project_id (orphan = unrestricted).
  try {
    const { getConversation } = await import('../chats');
    const conv = await getConversation(uid, cid);
    const projectId = (conv as any)?.project_id;
    if (typeof projectId === 'string' && projectId) {
      const projectsFeat = await import('../projects');
      const scope = await projectsFeat.resolveProjectScope(uid, projectId);
      if (scope) {
        const bound = new Set(scope.agents);
        const before = to;
        to = to.filter((id) => RESERVED_IDS.has(id) || bound.has(id));
        if (to.length !== before.length) {
          const dropped = before.filter((id) => !to.includes(id));
          log.info(`dispatch project-scope drop cid=${cid} pid=${projectId} from=${fromActorId} dropped=${dropped.join(',')}`);
        }
      }
    }
  } catch (err) {
    log.warn(`project-scope filter cid=${cid}: ${(err as Error).message}`);
  }

  // Default fallback: if nothing resolved (and no force), use sender-default.
  // Mirror router.ts's rule: user → commander; commander/agent → user.
  if (!to.length) {
    if (fromKind === 'user') to = [COMMANDER_ID];
    else to = [USER_ID];
  }

  // Auto-add any non-reserved recipient that isn't already a member.
  // Two paths converge here: name → id resolved by `agentNameToId` (via
  // resolveRecipients) and unknown id → agent resolved by the async pass
  // above. Both end up with an agent_id in `to` but neither path
  // necessarily added the actor to the roster — the previous logic only
  // added inside the unknown-resolve branch, so a routed name resolved
  // via agentNameToId left `members.json` unchanged and the dispatch
  // loop bailed with "recipient not in roster". Centralizing the
  // membership write here keeps the invariant "anything in `to` for a
  // group dispatch is a roster member" true regardless of resolve path.
  // Map agent_id → display_name for the post-resolve sweep below — we
  // need it both for member registration and for the `@<id>` → `@<name>`
  // text rewrite that follows.
  const idToName = new Map<string, string>();
  for (const recipientId of to) {
    if (RESERVED_IDS.has(recipientId)) continue;
    try {
      const ag = await agentsFeat.getAgent(recipientId);
      if (!ag || !isAgentEnabled(uid, ag.agent_id)) continue;
      if (ag.name) idToName.set(ag.agent_id, ag.name);
      const added = await ensureAgentMember(uid, cid, ag.agent_id, ag.name);
      if (added) {
        const updated = await readMembers(uid, cid);
        const newActor = updated.actors.find((a) => a.id === ag.agent_id);
        if (newActor) emit(state, { type: 'member_joined', cid, actor: newActor });
      }
    } catch (err) {
      log.warn(`auto-add member failed token=${recipientId}: ${(err as Error).message}`);
    }
  }

  // Rewrite raw `@<agent_id>` in the message body to `@<display_name>` so
  // users never see hex strings in the persisted chat. The LLM commander
  // sometimes still reaches for ids despite the prompt — it sees prior
  // turns in its own session jsonl and mimics that pattern; cleaning the
  // output stream is more reliable than keeping the prompt perfectly tuned.
  // Only rewrites whole-token matches (regex word boundary) so embedded
  // ids inside other content don't get touched. `buildMention` preserves
  // whitespace in multi-word display names (see its header).
  let rewrittenText = text;
  for (const [aid, name] of idToName) {
    if (!name || name === aid) continue;
    const safeAid = aid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@${safeAid}\\b`, 'g');
    rewrittenText = rewrittenText.replace(re, buildMention(name));
  }

  // Strip ALL `@user` / `@commander` mentions when they're the routed
  // recipient — not just leading. The addressee lives in `to`; any literal
  // `@<recipient>` in the body is redundant noise. Mid-prose mentions
  // (e.g. "ok @user, about...") are common LLM filler that users find annoying.
  // Why ONLY user/commander and not agents: `@<agent>` from commander is
  // informational (shows observers which agent got dispatched), so we keep
  // those. Agents addressing user/commander gain nothing from the literal.
  // The Chinese aliases (`@指挥官` / `@用户`) get the same treatment so
  // Chinese-form mentions don't slip through.
  const stripTokens = new Set<string>();
  for (const r of to) {
    if (r === USER_ID) {
      stripTokens.add('user');
      stripTokens.add('用户');
    } else if (r === COMMANDER_ID) {
      stripTokens.add('commander');
      stripTokens.add('指挥官');
    }
  }
  if (stripTokens.size) {
    // Strip the `@<token>` itself (preserving any preceding separator), then
    // run a tidy pass to fix the whitespace/punctuation orphans the strip
    // creates. This 2-step keeps prose punctuation around the mention
    // intact: "received @user, about" → "received, about" (comma stays),
    // but "ok @user end" → "ok end" (space-bounded mid-word).
    for (const tok of stripTokens) {
      const safeTok = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `(^|\\s|[,，:：。！？!?])@${safeTok}(?=$|\\s|[,，:：。！？!?])`,
        'g',
      );
      rewrittenText = rewrittenText.replace(re, (_full, prev) => prev);
    }
    // Clean up: orphan whitespace before punctuation, doubled spaces, edges.
    rewrittenText = rewrittenText.replace(/[ \t]+([,，:：。！？!?])/g, '$1');
    rewrittenText = rewrittenText.replace(/[ \t]{2,}/g, ' ');
    rewrittenText = rewrittenText.replace(/\n[ \t]+/g, '\n');
    rewrittenText = rewrittenText.trim();
  }

  const msgId = genId12();
  const ts = nowIso();
  const mentions = parseMentions(rewrittenText);

  const msg: GroupMessage = {
    id: msgId, ts, from: fromActorId, to,
    ...(unknown.length ? { unknown_mentions: unknown } : {}),
    ...(mentions.length ? { mentions } : {}),
    text: rewrittenText,
    ...(params.attachments && params.attachments.length ? { attachments: params.attachments } : {}),
    ...(params.produced && params.produced.length ? { produced: params.produced } : {}),
    ...(params.form ? { form: params.form } : {}),
    ...(params.created_agents && params.created_agents.length ? { created_agents: params.created_agents } : {}),
    ...(params.created_skills && params.created_skills.length ? { created_skills: params.created_skills } : {}),
    ...(params.artifacts && params.artifacts.length ? { artifacts: params.artifacts } : {}),
    ...(params.marketplace_requests && params.marketplace_requests.length
      ? { marketplace_requests: params.marketplace_requests }
      : {}),
    ...(params.plan_announcement ? { plan_announcement: true } : {}),
    ...(params.dispatch ? { dispatch: true } : {}),
    ...(params.process && params.process.length ? { process: params.process } : {}),
  };

  // Persist: main jsonl + each recipient + sender (so sender sees own history
  // when re-loading). Visibility module filters by isVisibleTo so passing
  // the union covers both groups.
  await appendMain(uid, cid, msg);
  // Strip the process trail before writing visibility slices: only the user-
  // facing main jsonl needs it for history reload. Agent workers replay
  // their slice into the LLM session (`buildReplayPrefix`); leaking the
  // process rail there would inflate prompts with noise the LLM doesn't use.
  const sliceMsg: GroupMessage = msg.process ? (() => {
    const { process: _drop, ...rest } = msg;
    return rest as GroupMessage;
  })() : msg;
  const allActorIds = new Set<string>([fromActorId, ...to, ...members.actors.map((a) => a.id)]);
  await appendVisible(uid, cid, sliceMsg, Array.from(allActorIds));

  emit(state, { type: 'message', cid, msg, ...(params.turn_end ? { turn_end: true } : {}) });
  log.info(`enqueue user=${uid} cid=${cid} msg=${msgId} from=${fromActorId} to=${to.join(',')} len=${rewrittenText.length}${params.turn_end ? ' turn_end=1' : ''}${unknown.length ? ` unknown=${unknown.join(',')}` : ''}`);

  // Dispatch to non-user recipients.
  const refreshed = await readMembers(uid, cid);
  for (const recipientId of to) {
    if (recipientId === USER_ID) continue;
    const actor = refreshed.actors.find((a) => a.id === recipientId);
    if (!actor) {
      log.warn(`recipient ${recipientId} not in roster (cid=${cid})`);
      continue;
    }
    if (actor.kind === 'agent' && !isAgentEnabled(uid, actor.id)) {
      log.warn(`agent ${actor.id} disabled — skipping dispatch (cid=${cid})`);
      continue;
    }
    const w = ensureWorker(state, actor);
    w.queue.push({
      msgId,
      fromActorId,
      llmPayload: composeLlmTurnPayload(fromActorId, msg),
      ...(msg.attachments && msg.attachments.length ? { attachments: msg.attachments.slice() } : {}),
      ...(typeof params.triggered_step === 'number' ? { triggered_step: params.triggered_step } : {}),
    });
    const wake = w.wake; w.wake = null;
    wake?.();
  }

  // (No shadow-tap on agent → user replies anymore.) The plan_executor's
  // `reconcile` hook in runTurn already wakes commander deterministically
  // for plan-driven flows — by marking the just-finished step done and
  // dispatching the next step (or `<plan-complete>` synthesis turn) when
  // the DAG demands. Adding a shadow-tap on top was double-firing: it
  // created an extra commander turn whose only output (per prompt) was an
  // empty final (silently dropped), wasting one LLM call per agent reply.
  // For non-plan flows (one-shot @-mention dispatch), commander has no
  // orchestration role at all — letting it stay asleep keeps the chat
  // clean and avoids prompt-driven mistakes (the model second-guessing the
  // agent's form / re-dispatching for "polish").
  // Edge case: an agent explicitly mentions the commander to escalate
  // (e.g. `@commander` / `@指挥官`). That message has
  // commander in `to`, so it goes through the regular dispatch loop above.

  // User-driven reconcile: when user enqueues, plan_executor needs a chance
  // to mark a `user`-assignee step as done and dispatch downstream. This is
  // part of the send transaction, not a background side effect: the IPC
  // send-stream subscribes before calling send(), and it must not return until
  // the immediate plan handoff (user step → next agent / commander) has queued
  // its work. Otherwise the renderer can close the stream between the user
  // echo and the downstream dispatch, which is exactly how form submissions
  // ended up as fake loading bubbles until history polling caught up.
  if (fromActorId === USER_ID) {
    // Phase-0 chokepoint (was lost from commit 76358a8e per
    // `docs/plans/expert-signals-phase0-wiring-gaps.md`): cancels pending
    // silence check + extracts text-class signals (accept / correction /
    // reject / edit) against the cached last agent message. Fire-and-
    // forget; correctionDetected return value is intentionally unused
    // here (runner.ts:665 does its own detectUserCorrection for
    // RunMetrics — acceptable double-judgment for v0).
    onUserMessage({ uid, cid, userMsg: { id: msgId, text: rewrittenText } })
      .catch((err) => log.warn(`onUserMessage threw cid=${cid}: ${(err as Error).message}`));

    await planExecutor.reconcile(uid, cid, {
      finishedActorId: USER_ID,
      finishedMessage: { id: msgId, text: rewrittenText, files: [], failed: false },
    }).catch((err) => log.warn(`plan reconcile (user) threw cid=${cid}: ${(err as Error).message}`));
  }

  return msg;
}

function composeLlmTurnPayload(fromActorId: string, msg: GroupMessage): string {
  // The recipient's LLM sees the inbound message wrapped with sender id +
  // recipient list so it has unambiguous routing context (especially when
  // a stray @ targeted multiple actors).
  const head = `<msg from="${fromActorId}" to="${(msg.to || []).join(',')}">`;
  const tail = '</msg>';
  return `${head}\n${msg.text}\n${tail}`;
}

/** Reverse of `composeLlmTurnPayload`: extract the user-visible text from
 *  a `<msg from=… to=…>\nTEXT\n</msg>` envelope. Returns `null` for any
 *  payload that doesn't match the exact shape (defensive — keeps callers
 *  from treating an unwrapped or differently-encoded payload as raw text). */
function _unwrapLlmTurnPayload(payload: string): string | null {
  const m = /^<msg from="[^"]*" to="[^"]*">\n([\s\S]*)\n<\/msg>$/.exec(payload);
  return m ? m[1] : null;
}

/** True when `text` looks like a CLI slash command (`/foo`, `/my-cmd …`).
 *  Matches a leading `/` followed by an alphanumeric command name on the
 *  first line; trailing args / newlines are fine. Used to bypass the
 *  chat_cli_agent template wrap so the CLI's own slash dispatcher sees
 *  the `/` at position 0 of its user message content. */
function _isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][A-Za-z0-9_-]*(?=\s|$)/.test(text);
}

/** Treat the CLI's reply as "no useful text" when it's empty / whitespace
 *  or the literal "(no content)" sentinel some CLIs (claude code in
 *  particular) emit for slash commands that have no -p-mode effect. The
 *  slash-command success-return path uses this to swap an empty bubble
 *  for a confirmation note. */
function _looksLikeNoOutput(text: string): boolean {
  const t = (text || '').trim();
  return t === '' || /^\(\s*no\s+content\s*\)$/i.test(t);
}

/** Strip a leading `@<recipient>` mention (display name or id form) and
 *  the whitespace separator that follows it. Used by the slash-command
 *  fast-path so `@Claude Code /new` collapses to `/new` before slash
 *  detection — the `@<agent>` token is routing metadata, not part of the
 *  command. Only the very first leading mention is stripped; other
 *  `@<name>` tokens elsewhere in the body stay untouched. */
function _stripLeadingRecipientMention(
  text: string, agentName: string, agentId: string,
): string {
  if (!text) return text;
  for (const tok of [agentName, agentId]) {
    if (!tok) continue;
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^@${esc}(?:\\s+|$)`);
    if (re.test(text)) return text.replace(re, '');
  }
  return text;
}

// ── Worker loop ──────────────────────────────────────────────────────────

function ensureWorker(state: CidState, actor: Actor): WorkerState {
  const existing = state.workers.get(actor.id);
  if (existing) return existing;
  const w: WorkerState = {
    uid: state.uid, cid: state.cid, actor,
    queue: [], running: false, wake: null,
    abortController: null, turnsThisActivation: 0,
    terminated: false,
  };
  state.workers.set(actor.id, w);
  // Spawn loop. No await — runs in background; failures log + retry on next msg.
  void runWorkerLoop(state, w);
  return w;
}

async function runWorkerLoop(state: CidState, w: WorkerState): Promise<void> {
  while (!w.terminated) {
    if (w.queue.length === 0) {
      // Idle until a wake or a kill. `dropConv` flips terminated=true and
      // resolves the wake so we exit cleanly instead of leaking the
      // generator + holding `state` references after conv delete.
      await new Promise<void>((resolve) => { w.wake = resolve; });
      // Reset the per-activation turn counter on each wake so a long-lived
      // conv that hits idle between sends doesn't slowly accumulate toward
      // MAX_WORKER_TURNS — the cap is meant to catch a runaway one-shot
      // burst, not the steady drip of normal usage.
      w.turnsThisActivation = 0;
      if (w.terminated) break;
      continue;
    }
    if (w.turnsThisActivation >= MAX_WORKER_TURNS) {
      log.error(`worker ${w.actor.id} hit MAX_WORKER_TURNS (${MAX_WORKER_TURNS}) cid=${w.cid} — dropping queue + halting`);
      w.queue.length = 0;
      w.turnsThisActivation = 0;
      continue;
    }
    const item = w.queue.shift()!;
    // Claim `running=true` BEFORE the async hop into runTurn AND clear
    // it AFTER runTurn fully returns (including its post-turn enqueue).
    // Why not let runTurn's finally clear it: there's a sync window
    // between the LLM stream's finally (where running=false would land)
    // and the `await enqueue(...)` that fires the next message — during
    // that window pendingEnqueues is also 0 → `isQuiescent` would
    // briefly return true and upstream waiters (IPC handler, tests)
    // would break out before the cascade finished. Owning running here
    // means it spans the WHOLE turn lifecycle.
    w.running = true;
    try {
      await runTurn(state, w, item);
    } catch (err) {
      log.error(`worker turn failed cid=${w.cid} actor=${w.actor.id}: ${(err as Error).message}`);
    } finally {
      w.running = false;
    }
    w.turnsThisActivation += 1;
    // After running flipped back to false, kick a fire-and-forget status
    // reconciliation. The runTurn-internal `_syncStateStatus` saw
    // `w.running=true` and so could only ever decide 'running'; without
    // this post-finally sync, state.json sticks at 'running' even after
    // every worker idles, leaving the IPC drainLoop unable to break and
    // the renderer's scroll-pin bottom padding stuck applied (huge empty
    // gap until refresh).
    //
    // `void` (not `await`): a recipient enqueue triggered by THIS turn
    // may have already fired `w.wake?.()` against `w.wake=null` (since we
    // haven't reached the next `await new Promise(wake)` yet). Awaiting
    // here would extend that race window — the wake fires, `_syncStateStatus`
    // is still pending, and by the time we set `w.wake=resolve` the wake
    // is gone. Fire-and-forget keeps the loop moving so the next iteration
    // either picks up real work or arms the wake correctly.
    void _syncStateStatus(state).catch((err) => {
      log.warn(`post-turn syncStateStatus failed cid=${w.cid} actor=${w.actor.id}: ${(err as Error).message}`);
    });
  }
}

async function runTurn(state: CidState, w: WorkerState, item: QueueItem): Promise<void> {
  const { uid, cid, actor } = w;
  const turnStartedAt = Date.now();

  w.running = true;
  w.abortController = new AbortController();
  await _syncStateStatus(state, /*forceRunning*/ true);
  await markInFlight(uid, cid, actor.id, true);
  emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
  log.info(`turn-start user=${uid} cid=${cid} actor=${actor.id} kind=${actor.kind} fromMsg=${item.msgId} from=${item.fromActorId}`);

  const sessionId = actorSessionId(cid, actor);
  const isCommander = actor.kind === 'commander';
  // Per-conv subdir under the user's root workspace — keeps repeat
  // agent runs writing the same basename grouped together instead of
  // littering the root with `requirements-2.md / -3.md / ...`. Lazy:
  // first call mkdirs + persists `state.json::workspace_dir`. Old convs
  // with no `workspace_dir` field fall back to the root workspace, so
  // there's no migration story.
  const { getConversationWorkspacePath } = await import('./conv_workspace');
  const workingDir = await getConversationWorkspacePath(uid, cid);
  // Project membership is decided at conv create time and frozen, so we
  // can resolve it once per turn and thread it through to every workspace
  // consumer below (CLI cwd fallback, streamChatWithModel, etc.) without
  // re-reading the conv index per tool call.
  let turnProjectId: string | undefined;
  try {
    const { getConversation } = await import('../chats');
    const _conv = await getConversation(uid, cid);
    const _pid = (_conv as any)?.project_id;
    if (typeof _pid === 'string' && _pid) turnProjectId = _pid;
  } catch { /* default scope */ }

  // Project bindings (strict scope of agents/skills visible to the LLM).
  // `null` = orphan conversation OR stale projectId — falls back to legacy
  // global visibility. Resolved once per turn alongside the workspace
  // resolver and threaded into commander prompt + agent skillList. See
  // CLAUDE.md §6: project scope is the outer intersection BEFORE the 4
  // enable-filter sites; do not add a 5th.
  let turnProjectScope: import('../projects').ProjectBindings | null = null;
  if (turnProjectId) {
    try {
      const projectsFeat = await import('../projects');
      turnProjectScope = await projectsFeat.resolveProjectScope(uid, turnProjectId);
    } catch (err) {
      log.warn(`resolve project scope cid=${cid} pid=${turnProjectId}: ${(err as Error).message}`);
    }
  }
  const turnProjectFilesRoot = turnProjectId ? projectFilesDir(uid, turnProjectId) : '';
  const turnProjectFilesSystemBlock = turnProjectId
    ? await buildProjectFilesSystemBlock(uid, cid, turnProjectId)
    : '';

  // First-turn replay: if the persistent session jsonl doesn't exist yet,
  // prepend a `<group-chat-history>` block built from the visibility slice
  // so the agent / commander has context. After the first turn, the
  // session file accumulates and we don't re-replay.
  let messageText = item.llmPayload;
  try {
    const sessionFile = (await import('../../model/core-agent/session-store')).sessionFileFor(sessionId);
    const sessionExists = fs.existsSync(sessionFile) && fs.statSync(sessionFile).size > 0;
    if (!sessionExists) {
      const slice = await readSlice(uid, cid, actor.id);
      const replay = buildReplayPrefix(slice, item.msgId);
      if (replay.prefix) messageText = `${replay.prefix}${item.llmPayload}`;
    }
  } catch (err) {
    log.warn(`replay-prefix build failed cid=${cid} actor=${actor.id}: ${(err as Error).message}`);
  }

  // Attach a `<attachments>` manifest block listing files uploaded on this
  // user turn (text / pdf / docx / image with absolute paths + kinds).
  // Project files are shared conversation context, so they live in the
  // system prompt's runtime injection block instead of being prepended to
  // the user message. Image bytes ride alongside via ChatOptions.images so
  // the vision model sees them on the same user turn — the manifest entry
  // carries `attached="inline"` so the LLM doesn't waste a read_file
  // round-trip re-fetching what it already has.
  let turnImages: Array<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }> = [];
  if (item.attachments && item.attachments.length) {
    try {
      const { buildAttachmentManifest } = await import('../chat_attachments');
      const { manifest, images } = await buildAttachmentManifest(uid, cid, item.attachments);
      if (manifest) messageText = `${manifest}\n${messageText}`;
      if (images.length) turnImages = images;
    } catch (err) {
      log.warn(`attachments manifest build failed cid=${cid} actor=${actor.id}: ${(err as Error).message}`);
    }
  }

  // Build system prompt + extra tools per role.
  let systemPrompt: string;
  let extraTools: AgentTool[] = [];
  let skillList: string[] | undefined;
  // CLI-backed agents fetch the spec but skip systemPrompt / skillList /
  // extraTools — the LLM stream is replaced below by `runCliAgentTurn`.
  // Hoisted here so the branch below can read it without re-fetching.
  let cliAgent: import('../agents').Agent | null = null;
  if (isCommander) {
    systemPrompt = await buildCommanderSystemPrompt(uid, cid, turnProjectScope?.agents ?? null, turnProjectFilesSystemBlock);
    extraTools = await buildCommanderExtraTools(state, w, item.attachments);
    // skillList stays undefined for commander — every skill is globally
    // visible (skills are NOT project-scoped this round; see CLAUDE.md §6).
  } else {
    const agent = await agentsFeat.getAgent(actor.id);
    if (!agent) {
      log.warn(`agent ${actor.id} disappeared mid-turn`);
      // User-visible signal — without this the user's @-dispatch hangs
      // forever with no feedback (in-flight cleared, no bubble surfaces).
      // Spec was unloadable (deleted / corrupt JSON / missing file); the
      // members roster still carries the human-readable name, so we
      // surface that to the user.
      const roster = await readMembers(uid, cid).catch(() => null);
      const member = roster?.actors.find((a) => a.id === actor.id);
      const name = member?.name || actor.id;
      const errBubble = `<span style="color:var(--danger)">${escapeHtmlForBubble(t('chat.agent_load_failed', { name }))}</span>`;
      await enqueue({
        uid, cid,
        fromActorId: actor.id,
        text: errBubble,
        forceTo: [USER_ID],
        turn_end: true,
        ...(typeof item.triggered_step === 'number' ? { triggered_step: item.triggered_step } : {}),
      });
      await markInFlight(uid, cid, actor.id, false);
      emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
      // Note: runWorkerLoop owns w.running — its finally clears the flag
      // when this returns. We DON'T touch it here.
      return;
    }
    if (agentsFeat.isCliAgent(agent)) {
      cliAgent = agent;
      systemPrompt = ''; // unused on CLI path
    } else {
      systemPrompt = await buildAgentInGroupSystemPrompt(uid, agent, workingDir, turnProjectFilesSystemBlock);
      // Pass agent.skill_list verbatim — it carries System A + System B
      // ids the agent owns. Skills are NOT project-scoped this round
      // (see CLAUDE.md §6); the runner's `projectAllowedSkillIds` hook is
      // preserved for future re-enable but bus does not pass it.
      skillList = Array.isArray(agent.skill_list) ? agent.skill_list : undefined;
    }
  }

  // Streaming.
  const { streamChatWithModel } = await import('../../model/client');
  // Per-turn skill-attribution buffer. Records skill_advertised at runner
  // build time (System A via skill-registry, System B via SkillStore) and
  // skill_invoked at each successful `read_file` of a SKILL.md. Drained
  // at turn-end below using the persisted agent msg id as `turn_id`, so
  // downstream signals JOIN cleanly with text/tool_failure/retry on the
  // same turn. Silent turns (no persisted message) drop the buffer — see
  // expert-signals-skill-attribution plan §3.4 + `turn_hooks.ts`.
  const skillBuffer = createSkillTurnBuffer();
  // Per-turn list — feeds the green-chip "files produced" bubble. The
  // conversation-scoped `state.producedPaths` is what uniquify consults
  // for ownership; we keep this Set per turn purely for UI surfacing.
  const turnProduced = new Set<string>();
  const onFileWritten = (absPath: string) => {
    turnProduced.add(absPath);
    state.producedPaths.add(absPath);
  };
  // Refinement-vs-collision signal for write tools' uniquify: any path the
  // model has produced in this conversation (this turn or earlier) is
  // "ours" → overwrite in place. Files the user pre-created remain foreign
  // and still get `-2 / -3 / ...` suffixed via `util/uniquify-path`.
  const hasProducedPath = (absPath: string) => state.producedPaths.has(absPath);
  // Interactive web-app artifacts created via `create_artifact` this turn.
  // Attached to the actor's end-of-turn message so the renderer embeds each
  // one as a sandboxed `<iframe>` (`chat-app://`); `agent_id` = this actor,
  // the routing target for a user→artifact interaction result.
  const turnArtifacts: Array<{ id: string; title: string }> = [];
  const onArtifactCreated = (a: { id: string; title: string }) => {
    turnArtifacts.push(a);
    emit(state, {
      type: 'artifact_created',
      cid,
      actor: actor.id,
      artifact: { id: a.id, title: a.title, agent_id: actor.id },
    });
  };
  let finalText = '';
  // Mirror of every text delta we forwarded to the renderer this turn.
  // Used as the salvage source when the user aborts mid-stream — the
  // event-mapper emits `error` (not `final`) on abort, so without this
  // accumulator the partial reply the user already saw rendering would be
  // discarded and we'd persist a bare "(stopped)" placeholder. Same pattern
  // as `agents.ts::streamSendToAgentEditChat` (skill / agent edit chats).
  let streamingText = '';
  let errText: string | null = null;
  let aborted = false;

  // activityEvents = count of non-error, non-final, non-done events the
  // LLM stream emitted. Used by plan_executor.onTurnFinished to distinguish
  // tool-only turns (final empty is normal) from config / auth bugs (the
  // stream produced literally nothing).
  let activityEvents = 0;
  // Capture the process trail to persist on the end-of-turn message so
  // history reload can rerender the rail (renderer accumulates it live, but
  // without persistence it vanishes on refresh — `_renderPersistedProcess`
  // in conversation.js needs `message.process`). Cap the array so a runaway
  // tool storm can't bloat the jsonl. Skip `delta` (token stream — that's
  // the final text body) and `assistant` events (`_formatEventLine` would
  // drop them anyway). Mirrors the shape used by skills.ts/agents.ts edit
  // chats.
  type ProcessItem =
    | { type: 'progress'; text: string }
    | { type: 'event'; event: { stream: string; data?: unknown } };
  const processItems: ProcessItem[] = [];
  // Commander needs to inspect skill / agent specs before mutating them:
  // `cat .../<id>/SKILL.md` to ground a skill rewrite, `read_file` an
  // agent.json before emitting an `<agent>` edit container. The ROOT
  // values now live inline in the rendered `agents_index` /
  // `## Available skills` blocks (see `skill-registry.renderSkillLines`
  // and `_buildAgentsIndexBlockForTest`); commander reads them straight
  // from the entry block. Path-sandbox blocks anything outside
  // workspace + attachment by default, so we expose these as
  // `readOnlyExtraRoots`: file-tools (read_file / search_files /
  // grep_files / stat_file) can see them, but write-side tools
  // (edit_file / write_file / bash / markdown_to_pdf / generate_image)
  // cannot mutate paths inside. The structured `<agent>` / `<skill>`
  // containers are the only sanctioned mutation channels — any direct
  // edit_file would skip safeId / validateAgentInputs / bilingual
  // description normalisation / cache invalidation / the "view detail"
  // chip, so the sandbox-level lock keeps the LLM honest even if the
  // prompt strays. Builtin first to match the prompt's "locate by
  // source" guidance.
  const skillRoots = [userMarketplaceSkillsDir(uid), userSkillsDir(uid)];
  const agentRoots = [userMarketplaceAgentsDir(uid), userAgentsDir(uid)];
  if (cliAgent) {
    // CLI-backed agent path: spawn the local CLI in the user's workspace
    // and forward its events as `process` events so the same UI rail
    // renders. The output text becomes finalText; failures populate
    // errText so the existing post-stream logic surfaces a ⚠️ bubble.
    //
    // **CLI cwd = root workspace** (NOT the per-conv subdir used by the
    // in-process branch). CLI session stores are cwd-hashed —
    // `claude code` keeps sessions under `~/.claude/projects/<encoded-cwd>/`
    // — so changing cwd between dispatches breaks `--resume <id>` with
    // "No conversation found with session ID …". The per-conv subdir
    // exists to group repeat-run artefacts from the in-process LLM's
    // `write_file` tool; CLI agents have their own product-side
    // conventions and don't need that scoping. Override here:
    const userWorkspace = await import('../user_workspace');
    const wsRoot = userWorkspace.getWorkspacePath(uid, turnProjectId);
    // Coding agents (claude / codex) initialise the per-conversation
    // `coding_project_dir` from the agent detail page's project-dir
    // setting. Missing setting = effective workspace. Once a
    // conversation has a dir, later turns keep using it; the agent can
    // still ask the user to switch through the standard directory form.
    // Non-coding CLIs always use the workspace. We defensively check
    // the directory exists — if it vanished we fall back rather than
    // failing the run.
    let cliWorkingDir = wsRoot;
    if (agentsFeat.cliIsCodingAgent(cliAgent.runtime?.kind === 'cli' ? cliAgent.runtime.cli : '')) {
      const dirInfo = agentsFeat.getCliProjectDirInfoForAgent(uid, cliAgent, turnProjectId);
      cliWorkingDir = dirInfo.effective_path;
      await _initializeCodingProjectDir(uid, cid, dirInfo);
      const st = await import('./state');
      const stateFile = await st.readState(uid, cid);
      const projDir = stateFile.coding_project_dir;
      if (projDir) {
        try {
          if (fs.statSync(projDir).isDirectory()) cliWorkingDir = projDir;
        } catch { /* missing → fall through to wsRoot */ }
      }
    }
    try {
      const slice = await readSlice(uid, cid, actor.id);
      const cliOut = await _runCliAgentTurn({
        uid, cid, actor, agent: cliAgent,
        item, slice, workingDir: cliWorkingDir,
        signal: w.abortController.signal,
        onProcess: data => {
          // Mirror the LLM path: count every event for activity, but
          // persist only `progress` and `event` shapes into processItems
          // — `delta` text streams into the live bubble and is recovered
          // from the final body, not the rail.
          activityEvents += 1;
          if (processItems.length < MAX_PROCESS_ITEMS_PER_TURN) {
            if (data.type === 'progress' && typeof data.text === 'string' && data.text) {
              processItems.push({ type: 'progress', text: data.text });
            } else if (data.type === 'event' && data.event && typeof data.event === 'object') {
              const inner = data.event as { stream?: string; data?: unknown };
              if (inner.stream) processItems.push({ type: 'event', event: { stream: inner.stream, data: inner.data } });
            }
          }
          // For the live wire: `delta` streams into the placeholder
          // bubble (token-by-token); other shapes feed the process
          // rail. Renderer dispatch lives in conversation.js process
          // event handler — see `data.type === 'delta'` branch.
          emit(state, { type: 'process', cid, actor: actor.id, data: data as unknown as Record<string, unknown> });
        },
      });
      finalText = cliOut.text;
      streamingText = cliOut.text;
      if (cliOut.error) errText = cliOut.error;
      if (cliOut.aborted) aborted = true;
    } catch (err) {
      errText = (err as Error).message || String(err);
      log.warn(`cli stream threw cid=${cid} actor=${actor.id}: ${errText}`);
    } finally {
      w.abortController = null;
      await markInFlight(uid, cid, actor.id, false);
      emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
    }
  } else {
  try {
    for await (const ev of streamChatWithModel({
      userId: uid,
      message: messageText,
      sessionId,
      systemPrompt,
      workingDir,
      agentName: 'orkas_chat',
      ...(actor.kind === 'agent' ? { agentId: actor.id } : {}),
      cid,
      ...(turnProjectId ? { projectId: turnProjectId } : {}),
      onFileWritten,
      hasProducedPath,
      onArtifactCreated,
      onSkillAdvertised: (id, sys) => skillBuffer.recordAdvertised(id, sys),
      onSkillInvoked: (id, sys, trig) => skillBuffer.recordInvoked(id, sys, trig),
      cacheRetention: 'short',
      abortSignal: w.abortController.signal,
      readOnlyExtraRoots: [
        ...(turnProjectFilesRoot ? [turnProjectFilesRoot] : []),
        ...skillRoots,
        ...agentRoots,
      ],
      ...(turnImages.length ? { images: turnImages } : {}),
      ...(extraTools.length ? { extraTools } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
      // Skills are NOT project-scoped this round — every conversation sees
      // every skill (gated only by per-user enable + agent.skill_list).
      // The runner's `projectAllowedSkillIds` plumbing is preserved for
      // a future re-enable; bus just doesn't pass it.
    })) {
      // Stream events → process channel.
      if (ev.type === 'final') {
        finalText = ev.text || '';
      } else if (ev.type === 'delta') {
        // Pulled out of the generic branch below so we can mirror the text
        // into `streamingText` for abort-time salvage. The activity++ +
        // process emit are kept identical to the prior behaviour so other
        // event consumers don't see any difference.
        const piece = (ev as { text?: string }).text;
        if (typeof piece === 'string') streamingText += piece;
        activityEvents += 1;
        emit(state, {
          type: 'process', cid, actor: actor.id,
          data: ev as unknown as Record<string, unknown>,
        });
      } else if (ev.type === 'error') {
        // Capture so onTurnFinished can decide between surfacing a ⚠️
        // failure bubble vs treating 'empty response' as a tool-only turn.
        errText = ev.text || 'unknown error';
        aborted = !!(ev as { aborted?: boolean }).aborted;
        log.warn(`stream error cid=${cid} actor=${actor.id}: ${errText}${aborted ? ' (aborted)' : ''}`);
      } else if (ev.type !== 'done') {
        activityEvents += 1;
        if (processItems.length < MAX_PROCESS_ITEMS_PER_TURN) {
          if (ev.type === 'progress') {
            const text = (ev as { text?: string }).text;
            if (text) processItems.push({ type: 'progress', text });
          } else if (ev.type === 'event') {
            const inner = (ev as { event?: { stream?: string; data?: unknown } }).event || {};
            if (inner.stream && inner.stream !== 'assistant') {
              processItems.push({ type: 'event', event: { stream: inner.stream, data: inner.data } });
            }
          }
        }
        emit(state, {
          type: 'process', cid, actor: actor.id,
          data: ev as unknown as Record<string, unknown>,
        });
      }
    }
  } catch (err) {
    errText = (err as Error).message || String(err);
    log.warn(`stream threw cid=${cid} actor=${actor.id}: ${errText}`);
  } finally {
    // Salvage partial reply on abort — the event-mapper emits `error` (no
    // `final`) when the user hits stop, so `finalText` is empty even though
    // `streamingText` holds whatever the renderer was already rendering.
    // Push it into finalText so plan_executor's abort branches can preserve
    // it instead of throwing away visible work as a bare "(stopped)" stub.
    if (!finalText && streamingText) {
      finalText = streamingText;
    }
    w.abortController = null;
    // NOTE: `w.running` is owned by `runWorkerLoop` — it stays `true`
    // through the post-turn enqueue below so `isQuiescent` doesn't
    // briefly report quiescent in the sync window between this finally
    // and the `await enqueue(...)` that fires the next message.
    await markInFlight(uid, cid, actor.id, false);
    // Emit a state_changed so UI roster updates immediately, but don't
    // touch status (status is owned by _syncStateStatus, which runs after
    // the post-turn enqueue below — until then we're still 'running' from
    // the worker's perspective).
    emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
  }
  } // end LLM branch (paired with `if (cliAgent) { ... } else {` above)

  // ── Post-stream parsing (pure data extraction; no decisions) ──────────
  // Form / <agent> container extraction stays in bus because they're pure
  // text → structured-data parsing. Decisions (silent / done / blocked /
  // failed) live in plan_executor.onTurnFinished.
  let workingText = finalText || '';
  let form: ChatFormPayload | undefined;
  const createdAgents: Array<{ agent_id: string; name: string; kind: 'created' | 'updated' }> = [];
  const createdSkills: Array<{ skill_id: string; name: string; kind: 'created' | 'updated' }> = [];

  if (actor.kind === 'agent' && workingText) {
    const r = extractFormFromFinal(workingText, actor.id);
    if (r.form) {
      workingText = r.cleanText;
      const msgId = genId12();
      form = {
        form_id: computeFormId(cid, msgId, r.form.agent_id, r.form.fields),
        agent_id: r.form.agent_id,
        fields: r.form.fields,
        submitted: false,
      };
    }
  } else if (isCommander && workingText) {
    const r = extractAgentFieldBlocks(workingText);
    if (r.blocks.length) {
      workingText = r.cleanText;
      // Apply each `<agent>` block independently. A failed block appends
      // its own warning span to workingText and is omitted from
      // createdAgents — the chip slot only fills when the spec was
      // actually written. Subsequent blocks still attempt their own apply.
      for (const fields of r.blocks) {
        if (!Object.keys(fields).length) continue;
        const editId = fields.agent_id;
        try {
          if (editId) {
            const target = await agentsFeat.getAgent(editId);
            if (!target) {
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Agent edit failed: agent not found (id=${editId}).</span>`;
            } else if (target.source !== 'custom' && !false) {
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Marketplace agents can't be edited from the main chat; fork one in the right-hand detail panel and edit there.</span>`;
            } else if (agentsFeat.isCliAgent(target)) {
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ External agents can only be edited from the right-hand detail panel.</span>`;
            } else {
              // `updateAgentSpec` dispatches: custom → updateCustomAgent,
              // marketplace + dev → agents_dev.updateBuiltinAgentSpec
              // (which writes the local marketplace install dir). The
              // dev-env source guard above is what makes the marketplace
              // branch reachable; the direct `updateCustomAgent` call this
              // replaces would short-circuit to null because the custom
              // agent.json doesn't exist for marketplace ids.
              const updated = await agentsFeat.updateAgentSpec(editId, fields);
              if (updated) {
                createdAgents.push({ agent_id: updated.agent_id, name: updated.name, kind: 'updated' });
              } else {
                workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Agent update failed.</span>`;
              }
            }
          } else {
            const ag = await agentsFeat.createAgentFromBlocks(fields);
            if (ag) {
              createdAgents.push({ agent_id: ag.agent_id, name: ag.name, kind: 'created' });
              // Project-scoped conv: auto-bind the new agent into the project's
              // bindings.json so it's actually reachable from this conversation
              // (commander picker filters by `_pickerBoundAgentIds`; LLM
              // dispatch is gated by the same project scope per CLAUDE.md §5).
              // Without this hop the user creates an agent and immediately
              // can't @-mention it from the same conv — observed bug shape
              // when the project's bindings predate the new agent.
              if (turnProjectId) {
                try {
                  const projectsFeatBind = await import('../projects');
                  await projectsFeatBind.addAgentBinding(uid, turnProjectId, ag.agent_id);
                  log.info(`auto-bound agent ${ag.agent_id} to project ${turnProjectId} after commander creation`);
                } catch (err) {
                  log.warn(`auto-bind agent failed cid=${cid} pid=${turnProjectId} aid=${ag.agent_id}: ${(err as Error).message}`);
                }
              }
            } else {
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Agent creation failed: missing required field(s) (name / workflow).</span>`;
            }
          }
        } catch (err) {
          const verb = editId ? 'edit' : 'create';
          log.error(`${verb}-agent failed cid=${cid}: ${(err as Error).message}`);
          workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Agent ${verb} failed: ${(err as Error).message}</span>`;
        }
      }
    }

    // `<skill>` container — parallel to `<agent>` above. Commander only.
    // The container is independent of `<agent>`; both can co-exist in one
    // turn in principle, though the prompt encourages one-at-a-time. Best-
    // effort: a rejected file path within the container does not abort the
    // remaining writes, mirroring the per-skill edit chat. The localized
    // error string returned by `applySkillContainerFromCommander` already
    // covers built-in / not-found / charset / collision cases — bus only
    // appends the pill.
    const skillR = extractSkillContainers(workingText);
    if (skillR.containers.length) {
      workingText = skillR.cleanText;
      // Apply each `<skill>` container independently. A failed container
      // appends its own warning span and is omitted from createdSkills —
      // the chip slot only fills when the spec was actually written.
      for (const container of skillR.containers) {
        try {
          const result = await skillsFeat.applySkillContainerFromCommander(container);
          if (result.ok && result.skillId && result.name && result.kind) {
            createdSkills.push({ skill_id: result.skillId, name: result.name, kind: result.kind });
            if (result.rejected && result.rejected.length) {
              const list = result.rejected.map((p) => `\`${p}\``).join(', ');
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Some skill files were rejected: ${list}</span>`;
            }
            // Quality validator rejections: surface friendly warning to the
            // user PLUS a structured fenced block so the LLM sees the
            // violations in its own message history on the next turn and
            // can rewrite. The fenced block is opaque to bus — it's just
            // text that survives into history.
            if (result.validation_failed && result.validation_failed.length) {
              workingText = `${workingText}\n\n${_formatValidationFailure(result.validation_failed)}`;
            }
            if (result.validation_warnings && result.validation_warnings.length) {
              workingText = `${workingText}\n\n${_formatValidationWarnings(result.validation_warnings)}`;
            }
            // Project-scoped conv: auto-bind the new skill so the LLM in this
            // conv actually sees it via getSystemPromptBlock allowlist. Same
            // bug shape as the agent auto-bind above — without this the user
            // creates a skill, the file lands on disk, but the LLM in this
            // project conv can never invoke it (allowlist excludes it).
            if (turnProjectId && result.kind === 'created') {
              try {
                const projectsFeatBind = await import('../projects');
                await projectsFeatBind.addSkillBinding(uid, turnProjectId, result.skillId);
                log.info(`auto-bound skill ${result.skillId} to project ${turnProjectId} after commander creation`);
              } catch (err) {
                log.warn(`auto-bind skill failed cid=${cid} pid=${turnProjectId} sid=${result.skillId}: ${(err as Error).message}`);
              }
            }
          } else {
            // Quality-blocked create: result has validation_failed even on
            // ok:false. Display the structured violations so the LLM sees
            // them in history and the user gets the same modal-style info.
            // Plain error (missing-name / collision / etc) shows the
            // localized message only.
            if (result.validation_failed && result.validation_failed.length) {
              workingText = `${workingText}\n\n${_formatValidationFailure(result.validation_failed)}`;
            } else {
              workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ ${result.error || 'Skill operation failed.'}</span>`;
            }
          }
        } catch (err) {
          const verb = container.skillId ? 'edit' : 'create';
          log.error(`${verb}-skill failed cid=${cid}: ${(err as Error).message}`);
          workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ Skill ${verb} failed: ${(err as Error).message}</span>`;
        }
      }
    }
  }

  const produced = Array.from(turnProduced);

  // ── Trigger derivation ───────────────────────────────────────────────
  // Map the raw `triggered_step` (kept for back-compat with the executor
  // pushCommanderTurn path) to the structured TurnTrigger consumed by
  // onTurnFinished.
  const trigger: planExecutor.TurnTrigger =
    item.triggered_step === -1
      ? { kind: 'plan_synth' }
    : typeof item.triggered_step === 'number'
      ? { kind: 'plan_step', step_index: item.triggered_step }
    : { kind: 'user_direct' };

  // ── Single hand-off to plan_executor ─────────────────────────────────
  // Executor decides: state transitions, downstream dispatch, terminal
  // signaling, AND whether bus should persist a user-visible bubble.
  // Bus is now pure I/O: it executes the returned outcome and that's it.
  let outcome: planExecutor.TurnOutcome = { kind: 'silent' };
  try {
    outcome = await planExecutor.onTurnFinished(uid, cid, {
      actor: { id: actor.id, kind: actor.kind === 'commander' ? 'commander' : 'agent' },
      finalText: workingText,
      errText,
      aborted,
      ...(form ? { form } : {}),
      produced,
      ...(createdAgents.length ? { createdAgents } : {}),
      ...(createdSkills.length ? { createdSkills } : {}),
      trigger,
      activityEvents,
    });
  } catch (err) {
    log.warn(`plan_executor.onTurnFinished threw cid=${cid} actor=${actor.id}: ${(err as Error).message}`);
    // Fail-safe: persist the raw final so user sees something rather than
    // a stalled chat.
    outcome = {
      kind: 'persist',
      text: workingText || '(no reply)',
      ...(form ? { form } : {}),
      ...(produced.length ? { produced } : {}),
      ...(createdAgents.length ? { createdAgents } : {}),
      ...(createdSkills.length ? { createdSkills } : {}),
    };
  }

  // Merge a staged plan announcement into commander's end-of-turn message
  // so the thinking rail (placeholder) and the plan card finalize into a
  // single bubble. Promotes a silent commander turn to persist when the
  // only thing the user needs to see IS the plan.
  const pendingPlan = w.pendingPlanAnnouncement;
  w.pendingPlanAnnouncement = undefined;
  if (pendingPlan && actor.kind === 'commander') {
    if (outcome.kind === 'persist') {
      const merged = outcome.text && outcome.text.trim()
        ? `${outcome.text}\n\n${pendingPlan}`
        : pendingPlan;
      outcome = { ...outcome, text: merged };
    } else {
      outcome = { kind: 'persist', text: pendingPlan };
    }
  }

  // Same UX rationale as the plan announcement merge: a commander turn
  // that ONLY emitted dispatch_to(s) leaves an empty bubble below the
  // process rail, which reads as "broken" to the user. Surface a brief
  // summary line so the bubble is informative. Skipped when there's
  // already a body (the LLM wrote prose alongside the dispatch — common
  // for fallback flows), and when the bubble already carries the plan
  // card from the merge above.
  // "Visually empty" — also strips zero-width chars some LLMs emit as the
  // body of a tool-only turn to dodge the framework's "empty response"
  // detection (we've seen U+200B as a single-char body alongside a
  // dispatch_to call). `.trim()` alone wouldn't catch them.
  // U+200B–U+200D (ZWSP / ZWNJ / ZWJ) + U+FEFF (BOM).
  const _isVisuallyEmpty = (s: string | undefined): boolean =>
    !s || !s.replace(/[​-‍﻿]/g, '').trim();
  if (actor.kind === 'commander'
      && w.pendingDispatches && w.pendingDispatches.length
      && outcome.kind === 'persist'
      && _isVisuallyEmpty(outcome.text)) {
    const tags: string[] = [];
    for (const d of w.pendingDispatches) {
      let name = d.to;
      try {
        const ag = await agentsFeat.getAgent(d.to);
        if (ag && (ag as any).name) name = (ag as any).name;
      } catch { /* fall back to raw id */ }
      tags.push(buildMention(name));
    }
    outcome = { ...outcome, text: t('chat.commander_dispatch_only', { agents: tags.join(', ') }) };
  }

  // Marketplace install requests are visible side effects of a commander
  // turn. They are staged by `marketplace_request_install` and attached to
  // the final message so the renderer can show user-confirmation cards. If
  // the model followed the tool instruction and produced no prose, still
  // persist a bubble: the card itself is the thing the user needs to see.
  const turnMarketplaceRequests = actor.kind === 'commander' && w.pendingMarketplaceRequests?.length
    ? w.pendingMarketplaceRequests.slice()
    : [];
  if (actor.kind === 'commander') w.pendingMarketplaceRequests = undefined;
  if (turnMarketplaceRequests.length > 0 && outcome.kind === 'silent') {
    outcome = { kind: 'persist', text: '' };
  }

  // Abort post-processing — single source of truth for both "promote silent
  // to persist when there's still something visible to keep" AND the
  // "(stopped)" suffix.
  //
  // plan_executor's abortOutcome can only see partial text + form / created
  // agent / produced files; it goes silent for anything else. But process
  // info (tool calls, progress lines, retry markers) lives in bus's
  // `processItems`, attached at enqueue time below. Without this promotion,
  // an abort that fired AFTER a few tool calls but BEFORE any text streamed
  // would lose its entire process rail: the renderer's `aborted` event
  // already wiped the streaming placeholder, and going silent means no new
  // bubble is enqueued — process info silently disappears even though the
  // user clearly saw it during streaming. Promoting to persist here lets
  // the enqueue carry `processItems` into the persisted message so reload
  // / history view still surfaces what the actor did before stopping.
  // A `create_artifact` call is a user-visible side effect the plan executor
  // doesn't know about (it never sees the artifact list). If the turn would
  // otherwise be silent — e.g. a commander turn that only produced an
  // artifact — promote it to persist so the embedded iframe surfaces. Same
  // rationale as the abort/process-trail promotion below; the artifact list
  // itself is attached at enqueue time, independent of the executor outcome.
  if (turnArtifacts.length > 0 && outcome.kind === 'silent') {
    outcome = { kind: 'persist', text: '' };
  }

  if (aborted) {
    if (outcome.kind === 'silent' && processItems.length > 0) {
      outcome = { kind: 'persist', text: '' };
    }
    if (outcome.kind === 'persist') {
      const aborted = t('model.aborted');
      const body = outcome.text && outcome.text.trim()
        ? `${outcome.text}\n\n${aborted}` : aborted;
      outcome = { ...outcome, text: body };
    }
  }

  let persistedMsg: GroupMessage | null = null;
  if (outcome.kind === 'persist') {
    persistedMsg = await enqueue({
      uid, cid,
      fromActorId: actor.id,
      text: outcome.text,
      ...(outcome.form ? { form: outcome.form } : {}),
      ...(outcome.produced && outcome.produced.length ? { produced: outcome.produced } : {}),
      ...(outcome.createdAgents && outcome.createdAgents.length ? { created_agents: outcome.createdAgents } : {}),
      ...(outcome.createdSkills && outcome.createdSkills.length
        ? { created_skills: outcome.createdSkills.map((s) => ({ skill_id: s.skill_id, name: s.name })) }
        : {}),
      ...(turnArtifacts.length
        ? { artifacts: turnArtifacts.map((a) => ({ id: a.id, title: a.title, agent_id: actor.id })) }
        : {}),
      ...(turnMarketplaceRequests.length ? { marketplace_requests: turnMarketplaceRequests } : {}),
      ...(pendingPlan && actor.kind === 'commander'
        ? { plan_announcement: true, forceTo: [USER_ID] } : {}),
      ...(processItems.length ? { process: processItems } : {}),
      // Mark this as the actor's official end-of-turn message — renderer
      // consumes the streaming placeholder + finalizes in place. Without
      // this flag, mid-turn tool-emitted messages (plan_executor's
      // dispatch) would also wrongly consume the placeholder.
      turn_end: true,
    });
  } else if (outcome.kind === 'silent') {
    // outcome=silent → bus is NOT going to enqueue a message for this turn.
    // Any placeholder the renderer parked for this actor (e.g. a fresh one
    // created by post-tool process events after the original was consumed
    // by a mid-turn message) needs an explicit signal to clean up; otherwise
    // a "thinking + process info" bubble lingers, vanishing only on
    // page refresh.
    emit(state, { type: 'turn_silent', cid, actor: actor.id });
  }

  // Deferred plan dispatch: if commander wrote a fresh plan via `plan_set`
  // this turn, its first wave of ready steps is dispatched HERE — after
  // commander's own turn fully settled (announcement + final emitted,
  // placeholder finalized or cleaned). This avoids the "agent worker
  // starts while commander is still streaming" overlap that confused the
  // visual order. `reconcile` is idempotent + mutex-serialized, so for
  // turns that didn't touch the plan it's a cheap no-op.
  // Skipped for plan_step / plan_synth turns — those already ran their
  // own reconcileAfterStepTransition inside `onTurnFinished`; a second
  // reconcile here is redundant.
  if (actor.kind === 'commander' && trigger.kind === 'user_direct') {
    try {
      await planExecutor.reconcile(uid, cid);
    } catch (err) {
      log.warn(`deferred reconcile threw cid=${cid}: ${(err as Error).message}`);
    }
  }

  // Flush any `dispatch_to` calls staged during commander's turn. Same
  // anti-jump-the-gun reasoning as the plan reconcile above: recipient workers are
  // only woken after commander's own turn fully settled (text persisted +
  // placeholder cleaned), so the user sees commander's reply before any
  // dispatched agent's reply. See WorkerState.pendingDispatches.
  if (actor.kind === 'commander' && w.pendingDispatches && w.pendingDispatches.length) {
    const pending = w.pendingDispatches;
    w.pendingDispatches = undefined;
    // Inherit the commander turn's user-uploaded attachments so the recipient
    // worker sees the same image / file bytes the commander saw. Without this
    // a worker honestly answers "I can't see the image" because turnImages
    // only fires when `item.attachments` is populated. Plan-step dispatches
    // get the same inheritance via PlanFile.initial_attachments (persisted
    // because steps live across worker turn boundaries); dispatch_to is one-
    // shot so per-turn flush is enough.
    const inheritedAttachments = item.attachments;
    for (const d of pending) {
      try {
        await enqueue({
          uid, cid,
          fromActorId: actor.id,
          text: d.message,
          forceTo: [d.to],
          dispatch: true,
          ...(inheritedAttachments && inheritedAttachments.length
            ? { attachments: inheritedAttachments }
            : {}),
        });
      } catch (err) {
        log.warn(`dispatch_to flush failed cid=${cid} to=${d.to}: ${(err as Error).message}`);
      }
    }
  }

  // Expert-signals: drain skill_advertised / skill_invoked using the
  // persisted msg id as turn_id (per turn_id convention — see
  // PC/CLAUDE.md §4 constraint 9 + expert-signals plan §3.4). Silent
  // turns drop the buffer; CLI agents bypass SkillLoader so the buffer
  // is empty for them and the drain is a no-op.
  if (persistedMsg) {
    skillBuffer.drainAndEmit({
      uid, cid,
      aid: actor.kind === 'commander' ? null : actor.id,
      turn_id: persistedMsg.id,
      msg_ids: [persistedMsg.id],
      errText: errText || undefined,
      aborted,
    });
    // Phase-0 chokepoint (was lost from commit 76358a8e per
    // `docs/plans/expert-signals-phase0-wiring-gaps.md`): caches agent msg
    // for the next user-reply text-signal JOIN, emits tool_failure when
    // errText is set, schedules silence check (cancelled by onUserMessage
    // when the user replies). Sync + self-guarded against errors.
    onAgentTurnEnd({
      uid, cid,
      actorId: actor.id,
      isCommander: actor.kind === 'commander',
      agentMsg: { id: persistedMsg.id, text: persistedMsg.text || '' },
      errText: errText || undefined,
    });
  }

  await _syncStateStatus(state);
  log.info(
    `turn-end user=${uid} cid=${cid} actor=${actor.id} ms=${Date.now() - turnStartedAt}`
    + ` outcome=${outcome.kind}`
    + ` events=${activityEvents}`
    + (form ? ' form=1' : '')
    + (createdAgents.length ? ` created_agents=${createdAgents.map(a => a.agent_id).join(',')}` : '')
    + (createdSkills.length ? ` created_skills=${createdSkills.map(s => s.skill_id).join(',')}` : '')
    + (produced.length ? ` produced=${produced.length}` : '')
    + (item.triggered_step !== undefined ? ` step=${item.triggered_step}` : '')
    + (errText ? ` err=${errText}` : '')
    + (aborted ? ' aborted=1' : ''),
  );
}

// ── System prompts ───────────────────────────────────────────────────────

async function buildCommanderSystemPrompt(
  uid: string,
  cid: string,
  allowedAgentIds?: readonly string[] | null,
  projectFilesBlock = '',
): Promise<string> {
  const { prompts } = await import('../../prompts/loader');
  const path_ = await import('node:path');
  const paths_ = await import('../../paths');
  const plan = await readPlan(uid, cid);
  const allAgentsList = await buildAgentsIndexBlock(uid, allowedAgentIds);
  const { getConversationWorkspacePath } = await import('./conv_workspace');
  const workingDir = await getConversationWorkspacePath(uid, cid);
  const permState = (() => {
    try {
      const s = require('../permissions').getLocalExecState() as { granted: boolean };
      return s.granted ? '**Granted** (free to execute)' : '**Not granted** (the user must enable it under "Settings → Local execution")';
    } catch { return '**Not granted**'; }
  })();
  // Stable sections first (cache-friendly), runtime injection last.
  // chat_shared_rules.md is appended BEFORE the runtime block in
  // chat_commander.md so it stays in the cached prefix.
  // Note: skill / agent ROOT path constants are NOT passed in here anymore —
  // they live inline in the rendered `agents_index` block (built by
  // `buildAgentsIndexBlock`) and the `## Available skills` block (built by
  // `skill-registry.renderSkillLines`), so the LLM sees ROOT values right
  // next to the entries that consume them. Reintroducing $*_dir vars would
  // recreate the cross-section path-constants design that mis-fires under
  // training-prior layouts.
  const main = prompts.load('chat_commander', {
    contexts_dir: path_.resolve(paths_.userContextsDir(uid)),
    agents_index: allAgentsList,
    plan_state: formatPlanForPrompt(plan),
    os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform,
    working_dir: workingDir,
    local_exec_state: permState,
    project_files_block: projectFilesBlock,
  });
  const shared = prompts.load('chat_shared_rules', {});
  return appendLanguageDirective(concatSharedRules(main, shared));
}

async function buildProjectFilesSystemBlock(uid: string, cid: string, projectId: string): Promise<string> {
  try {
    const projectFileFeature = await import('../project_files');
    const manifest = await projectFileFeature.buildProjectFilesManifest(uid, projectId);
    if (!manifest) return '';
    return `### Project files\n\n${manifest}`;
  } catch (err) {
    log.warn(`project files system block failed cid=${cid} pid=${projectId}: ${(err as Error).message}`);
    return '';
  }
}

/** Merge shared_rules into the per-role prompt. The shared block carries
 *  PDF / search / file-output rules that BOTH commander and agent need;
 *  duplicating them in two .md files would drift. We append them right
 *  before the `## Runtime injection` divider so the runtime-variable section
 *  (the only mutable part) stays last for KV cache stability. */
function concatSharedRules(main: string, shared: string): string {
  if (!shared.trim()) return main;
  const marker = '## Runtime injection';
  const idx = main.indexOf(marker);
  if (idx < 0) return `${main}\n\n---\n\n${shared}`;
  return `${main.slice(0, idx)}---\n\n${shared}\n\n${main.slice(idx)}`;
}

/** Append the user-language directive at the very tail. Kept last (after
 *  runtime injection) because it is the most volatile per-user variable;
 *  putting it last keeps the cached prefix stable. */
function appendLanguageDirective(prompt: string): string {
  return `${prompt}\n\n---\n\n${buildLanguageDirective()}`;
}

// Render the agents-index block injected into commander's system prompt.
//
// Format:
//   `\`read_file(<ROOT>/<id>/agent.json)\` — ROOT by Source:\n` +
//   `- custom:  <abs path>\n` +
//   `- marketplace: <abs path>\n` +
//   `Use these ROOT values verbatim. \`id:\` is tool-call input only — prose mentions agents as @<name>.\n\n` +
//   per-entry lines `- @<name> (Source: custom|marketplace, id: <agent_id>) — desc` + optional `\n  inputs_schema: <slim json>`
//
// Why expose id and ROOT inline (changed 2026-05): the prior layout hid
// agent_id (to discourage hex-id leak in user prose) and put paths in a
// separate `## Resource locations` section. That forced commander to run
// `search_files` for the matching agent.json, extract id from the dir
// segment, then `read_file` — two LLM round-trips. The hidden-id design
// also relied on the LLM to navigate path constants between sections.
// Now: id is shown next to its entry (one round-trip read), and the ROOT
// values live right next to the entries so there is nothing to construct.
// Hex-id leak prevention shifts to (a) the explicit "prose uses @<name>"
// hint here, and (b) the existing `@<id>` → `@<name>` rewrite in router.
// Exported (with `_…ForTest` suffix mirroring `_cidStateForTest` below) so
// the agents-index format can be pinned by fixture without spinning up the
// full bus pipeline. Treat as test-only — production callers stay inside
// `buildCommanderSystemPrompt`.
export async function _buildAgentsIndexBlockForTest(uid: string): Promise<string> {
  return buildAgentsIndexBlock(uid);
}

/** Render the agents-index block. When `allowedIds` is provided, only those
 *  agent ids are rendered (project-scoped commander view). `null` /
 *  `undefined` = no filter (legacy global view, used for orphan
 *  conversations). Empty array = render `(no agents)` block — the project
 *  has zero bound agents. Unknown ids in the allowlist are silently
 *  dropped (loader is the source of truth). */
async function buildAgentsIndexBlock(uid: string, allowedIds?: readonly string[] | null): Promise<string> {
  const { getCurrentLang } = await import('../../i18n');
  const { pickDescription } = await import('#core-agent');
  const lang = descriptionLang(getCurrentLang());
  const customRoot = path.resolve(userAgentsDir(uid));
  const marketplaceRoot = path.resolve(userMarketplaceAgentsDir(uid));
  const header = [
    '`read_file(<ROOT>/<id>/agent.json)` — ROOT by Source:',
    `- custom:  ${customRoot}`,
    `- marketplace: ${marketplaceRoot}`,
    'Use these ROOT values verbatim. `id:` is tool-call input only — prose mentions agents as @<name>.',
    '',
  ].join('\n');
  try {
    const allow = (allowedIds === null || allowedIds === undefined) ? null : new Set(allowedIds);
    const list = (await agentsFeat.listAgents())
      .filter((a: any) => a.enabled !== false)
      .filter((a: any) => (allow ? allow.has(a.agent_id) : true));
    if (!list.length) return `${header}(no agents)`;
    const entries = list.map((a: any) => {
      const name = a.name || a.agent_id;
      const description = pickDescription(a, lang);
      const desc = description ? ` — ${description}` : '';
      const head = `- ${buildMention(name)} (Source: ${a.source}, id: ${a.agent_id})${desc}`;
      // Inline a slimmed inputs_schema (id / type / required / default /
      // label / options / min / max / accept) so commander knows what
      // params each agent expects when phrasing its `@<name>` dispatch
      // text. Stripped of UI-only narrative fields (description /
      // placeholder) — those bloat the prompt without helping extraction.
      const inputs = Array.isArray(a.inputs) ? a.inputs : null;
      if (inputs && inputs.length) {
        const slim = inputs.map((f: any) => {
          const { description: _d, placeholder: _p, ...rest } = f;
          return rest;
        });
        return `${head}\n  inputs_schema: ${JSON.stringify(slim)}`;
      }
      return head;
    }).join('\n');
    return `${header}${entries}`;
  } catch { return `${header}(no agents)`; }
}

async function buildAgentInGroupSystemPrompt(
  _uid: string,
  agent: { name?: string; description?: string; workflow?: string; agent_id: string; inputs?: unknown; output_format?: string },
  workingDir: string,
  projectFilesBlock = '',
): Promise<string> {
  const { prompts } = await import('../../prompts/loader');
  // Render the agent's declared inputs schema so the LLM knows when to
  // emit a fenced agent-input-form block. UI-only narrative fields
  // (description, placeholder) are stripped — the model needs id / type
  // / required / default / label / options to extract values, not the
  // multi-line user-facing copy. Empty / absent schema → empty placeholder
  // so the prompt branch "if you have inputs_schema" simply doesn't trigger.
  const rawInputs = Array.isArray(agent.inputs) ? agent.inputs : [];
  const slimmed = rawInputs.map((f: any) => {
    const { description: _d, placeholder: _p, ...rest } = f;
    return rest;
  });
  const inputsSchemaJson = slimmed.length ? JSON.stringify(slimmed) : '';
  // Skill ROOT path constants are NOT passed in here either — the
  // skill-registry render block embeds them inline, see commander
  // counterpart above.
  const main = prompts.load('chat_agent_in_group', {
    name: agent.name || '',
    agent_id: agent.agent_id,
    description: agent.description || '(not provided)',
    workflow: (agent.workflow || '').trim() || '(not provided)',
    inputs_schema: inputsSchemaJson || '(none)',
    working_dir: workingDir,
    output_format_hint: buildOutputFormatHint(agent.output_format),
    project_files_block: projectFilesBlock,
  });
  const shared = prompts.load('chat_shared_rules', {});
  return appendLanguageDirective(concatSharedRules(main, shared));
}

/** Render the agent's `output_format` preference as a one-line worker prompt
 *  hint. Sits in the `## Runtime injection` tail (most-volatile slot per
 *  PC/CLAUDE.md §3 prompt-md cache layout). `'auto'` (legacy) and missing both
 *  produce an empty string — old agents authored before the redesign keep
 *  unconstrained behavior until the user explicitly picks a value. `'artifact'`
 *  is the renamed `'allow_artifacts'`; the old key is accepted as an alias for
 *  on-disk back-compat (specs written by pre-redesign builds). See
 *  `chat_shared_rules.md` "Output formats" for the underlying rule. */
function buildOutputFormatHint(format: string | undefined): string {
  switch (format) {
    case 'markdown_only':
      return '### Output format\nThis agent is configured **markdown-only**: do NOT emit `:::dashboard` blocks or call `create_artifact`. Plain markdown only.';
    case 'dashboard':
      return '### Output format\nThis agent is configured for **dashboard output**: prefer `:::dashboard` for structured snapshots (KPIs, tables, alerts, timelines); do NOT call `create_artifact`.';
    case 'artifact':
    case 'allow_artifacts':
      return '### Output format\nThis agent is configured to **allow artifacts**: prefer `:::dashboard` for structured snapshots; reach for `create_artifact` when interactivity actually matters.';
    case 'auto':
    default:
      return '';
  }
}

// ── Commander tools (plan_set / marketplace / dispatch) ─────────────────

function _toolJson(data: unknown): { content: string } {
  return { content: JSON.stringify(data) };
}

function _toolError(error: string): { content: string; isError: true } {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

function _clampLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _trimText(raw: unknown, max = 2000): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > max ? s.slice(0, max) : s;
}

function _normaliseMarketplaceKind(raw: unknown, allowBoth = false): 'agent' | 'skill' | 'both' | null {
  const v = String(raw || (allowBoth ? 'both' : '')).trim().toLowerCase();
  if (v === 'agent' || v === 'skill') return v;
  if (allowBoth && v === 'both') return 'both';
  return null;
}

function _compactMarketplaceItem(
  kind: 'agent' | 'skill',
  item: marketplaceFeat.MarketplaceAgent | marketplaceFeat.MarketplaceSkill,
  installedIds: Set<string>,
) {
  const installed = installedIds.has(item.id);
  const base = {
    kind,
    id: item.id,
    name: item.name,
    description_zh: item.description_zh || '',
    description_en: item.description_en || '',
    category: item.category || '',
    version: item.version,
    published_at: item.published_at,
    ...(typeof item.updated_at === 'number' ? { updated_at: item.updated_at } : {}),
    create_uid: item.create_uid || '',
    download_count: item.download_count || 0,
    installed,
  };
  if (kind !== 'agent') return base;
  const agent = item as marketplaceFeat.MarketplaceAgent;
  return {
    ...base,
    icon: agent.icon || '',
    color: agent.color || '',
  };
}

function _marketplaceSearchTerms(query: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v.length < 2) return;
    if (out.includes(v)) return;
    out.push(v);
  };
  const commonHanTerms = [
    '学习', '论文', '学术', '阅读', '精读', '研究', '导师', '助教', '助手',
    '教育', '课程', '知识', '写作', '编程', '产品', '设计', '数据', '分析',
    '营销', '法律', '财务', '医学', '心理', '苏格拉底',
  ];
  const hanRuns: string[] = [];
  push(query);
  for (const token of query.split(/[\s,，;；:：|/]+/g)) {
    push(token);
    const runs = token.match(/[㐀-鿿]{2,}/g) || [];
    hanRuns.push(...runs);
    for (const run of runs) {
      for (const term of commonHanTerms) {
        if (run.includes(term)) push(term);
      }
    }
  }
  // Last-resort fallback for unknown Chinese compounds. Keep this after
  // full tokens + common terms so weird cross-boundary bigrams ("文学",
  // "习助") do not crowd out better English/user-supplied terms.
  for (const run of hanRuns) {
    for (let i = 0; i < run.length - 1; i += 1) push(run.slice(i, i + 2));
  }
  return out.slice(0, 12);
}


async function buildCommanderExtraTools(
  state: CidState,
  w: WorkerState,
  // Attachments on the current commander turn's source item — passed through
  // to plan_set so the plan persists them under `initial_attachments`. Worker
  // dispatches in subsequent reconciles read it back from the plan so image /
  // file bytes follow the dispatch chain. Same flow as `dispatch_to` flush,
  // but persisted because plan steps live across worker turn boundaries.
  currentTurnAttachments?: string[],
): Promise<AgentTool[]> {
  const { uid, cid } = w;
  const tools: AgentTool[] = [];
  tools.push({
    name: 'plan_set',
    description: [
      'Record the full execution plan — the bus auto-dispatches per the plan, tracks state, and runs steps in series/parallel; **you do NOT need to @ dispatch anything afterwards**.',
      'Every step must specify `assignee` (user / commander / agent name) and `input` (dispatch text; can reference `{{user_initial_message}}` and `{{step_N.output_summary}}` template variables to pull in context).',
      'Steps default to serial (each waits for the previous to be done); use `wait_for: []` to run a step immediately, `wait_for: [N]` to declare explicit dependencies, and `parallel_group: "g"` to mark multiple steps as a parallel group.',
      'The first call also posts a group announcement so the user sees the rough path; later overwrites just update the file. Step count 1–15.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        initial_message: {
          type: 'string',
          description: 'Optional: the original user message that triggered this plan; stored in the plan for `{{user_initial_message}}` references. Strongly recommended on first plan write — otherwise downstream step input templates cannot pull the user\'s original wording.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'One-line step goal (imperative).' },
              assignee: {
                type: 'string',
                description: 'Executor: agent name / commander (you yourself, typical for synthesis) / user (ask the user a question and wait for the reply).',
              },
              input: {
                type: 'string',
                description: 'Dispatch text (template) sent to the assignee. The bus renders the variables and forwards the result **verbatim** as a message. Variables include `{{user_initial_message}}`, `{{step_1.output_summary}}`, `{{step_2.output_files}}`, etc. This is the actual "dispatch script" of the plan.',
              },
              wait_for: {
                type: 'array',
                items: { type: 'number' },
                description: 'Optional: list of step indices (1-based) this step depends on. Default = [previous step] (linear serial). `[]` = no dependency, run immediately. Multiple deps means wait for all of them to be done.',
              },
              parallel_group: {
                type: 'string',
                description: 'Optional: marks a parallel group. Steps in the same group are dispatched simultaneously (fork). Typical use: "multiple agents analyze the same problem independently".',
              },
              on_failure: {
                type: 'string',
                enum: ['abort_plan', 'continue', 'ask_commander'],
                description: 'Optional failure policy: `abort_plan` stops the whole plan / `continue` skips this step and proceeds / `ask_commander` (default) wakes the commander to decide.',
              },
              notes: { type: 'string', description: 'Optional supplementary notes (does not affect execution).' },
            },
            required: ['title', 'assignee'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    async execute(input) {
      const raw = (input?.steps || []) as Array<{
        title?: string; assignee?: string; input?: string;
        wait_for?: number[]; parallel_group?: string;
        on_failure?: string; notes?: string;
      }>;
      const stepsIn: PlanSetInput = {
        ...(typeof input?.initial_message === 'string' && input.initial_message.trim()
          ? { initial_message: String(input.initial_message) }
          : {}),
        ...(currentTurnAttachments && currentTurnAttachments.length
          ? { initial_attachments: currentTurnAttachments.slice() }
          : {}),
        steps: raw.filter((s) => s && typeof s.title === 'string' && s.title.trim() && typeof s.assignee === 'string' && s.assignee.trim())
          .map((s) => ({
            title: String(s.title),
            assignee: String(s.assignee),
            ...(s.input && typeof s.input === 'string' ? { input: String(s.input) } : {}),
            ...(Array.isArray(s.wait_for) ? { wait_for: s.wait_for.map(Number).filter(Number.isFinite) } : {}),
            ...(s.parallel_group && typeof s.parallel_group === 'string' ? { parallel_group: String(s.parallel_group) } : {}),
            ...(s.on_failure && ['abort_plan', 'continue', 'ask_commander'].includes(s.on_failure)
              ? { on_failure: s.on_failure as any } : {}),
            ...(s.notes ? { notes: String(s.notes) } : {}),
          })),
      };
      if (!stepsIn.steps.length) {
        return { content: JSON.stringify({ ok: false, error: 'empty or invalid steps (each step needs `title` + `assignee`)' }), isError: true };
      }
      const { plan } = await setPlan(uid, cid, stepsIn);
      emit(state, { type: 'plan_changed', cid });
      // Stage the announcement on the worker; runTurn end merges it into
      // commander's turn-end message so thinking rail + plan card share
      // a single bubble. See WorkerState.pendingPlanAnnouncement.
      // Always announce, including on re-plans — a silent re-plan would
      // leave the user with only the process rail (the "user pings
      // commander → must respond" invariant).
      w.pendingPlanAnnouncement = formatPlanAnnouncement(plan);
      // NOTE: dispatch is DEFERRED to runTurn-end (see bus.runTurn for the
      // post-outcome `planExecutor.reconcile` call). Doing it here would
      // mean the agent worker starts running while commander's own LLM
      // stream is still going — visually two placeholders thinking at
      // once + agent's reply potentially landing before commander's final
      // text. Letting commander's turn fully settle first keeps the UX
      // sequential. The plan + announcement are still written/emitted
      // synchronously here, so user immediately sees the plan card; only
      // the agent dispatch waits for commander to wrap up.
      return { content: JSON.stringify({ ok: true, plan: { steps: plan.steps } }) };
    },
  });

  tools.push({
    name: 'marketplace_search',
    description: [
      'Search the official marketplace catalog for agents and skills that are not already installed.',
      'Use this only when the currently installed agents/skills and built-in tools do not adequately cover the user task, and a marketplace resource could materially help.',
      'This tool only searches; it never installs. If you find one best candidate, call marketplace_request_install and then wait for the user decision.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text describing the needed capability. Use the user language when possible.',
        },
        kind: {
          type: 'string',
          enum: ['agent', 'skill', 'both'],
          description: 'Resource kind to search. Default: both.',
        },
        category: {
          type: 'string',
          description: 'Optional marketplace category code.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results per kind (1-20). Default: 5.',
        },
        include_installed: {
          type: 'boolean',
          description: 'Include resources already installed. Default: false.',
        },
        official_only: {
          type: 'boolean',
          description: 'When true, only return platform-authored rows (create_uid == "0"). Default: false.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input) {
      const query = _trimText(input?.query, 300);
      if (!query) return _toolError('`query` is required');
      const kind = _normaliseMarketplaceKind(input?.kind, true) || 'both';
      const category = _trimText(input?.category, 80);
      const limit = _clampLimit(input?.limit, 5, 1, 20);
      const includeInstalled = input?.include_installed === true;
      const officialOnly = input?.official_only === true;
      const size = Math.max(10, Math.min(50, limit * (includeInstalled ? 1 : 3)));
      try {
        const installs = await readInstalls(uid);
        const installedAgentIds = new Set(installs.agents.map((a) => a.id));
        const installedSkillIds = new Set(installs.skills.map((s) => s.id));
        const terms = _marketplaceSearchTerms(query);
        const filterRows = <T extends { id: string; create_uid?: string }>(
          rows: T[],
          installedIds: Set<string>,
        ): T[] => rows
          .filter((row) => includeInstalled || !installedIds.has(row.id))
          .filter((row) => !officialOnly || String(row.create_uid || '') === '0')
          .slice(0, limit);
        const collectRows = async <T extends { id: string }>(
          fetchRows: (term: string) => Promise<{ list: T[]; total: number }>,
        ): Promise<{ rows: T[]; total: number }> => {
          const merged = new Map<string, T>();
          let maxTotal = 0;
          for (const term of terms) {
            const res = await fetchRows(term);
            maxTotal = Math.max(maxTotal, res.total || 0);
            for (const row of res.list || []) {
              if (!merged.has(row.id)) merged.set(row.id, row);
            }
            if (merged.size >= limit * 3) break;
          }
          return { rows: Array.from(merged.values()), total: maxTotal };
        };

        const result: {
          ok: true;
          query: string;
          searched_terms: string[];
          agents?: ReturnType<typeof _compactMarketplaceItem>[];
          skills?: ReturnType<typeof _compactMarketplaceItem>[];
          totals: { agents?: number; skills?: number };
        } = { ok: true, query, searched_terms: terms, totals: {} };

        if (kind === 'agent' || kind === 'both') {
          const res = await collectRows((term) => marketplaceFeat.listMarketplaceAgents({
            q: term,
            ...(category ? { category } : {}),
            size,
          }));
          const rows = filterRows(res.rows || [], installedAgentIds);
          result.agents = rows.map((a) => _compactMarketplaceItem('agent', a, installedAgentIds));
          if (result.agents.length) {
            if (!w.marketplaceSearchResults) w.marketplaceSearchResults = new Map();
            for (const agent of result.agents) {
              const meta = agent as {
                id: string;
                icon?: string;
                color?: string;
                description_zh?: string;
                description_en?: string;
                category?: string;
                create_uid?: string;
              };
              w.marketplaceSearchResults.set(`agent:${agent.id}`, {
                icon: meta.icon || '',
                color: meta.color || '',
                description_zh: meta.description_zh || '',
                description_en: meta.description_en || '',
                category: meta.category || '',
                create_uid: meta.create_uid || '',
              });
            }
          }
          result.totals.agents = res.total || 0;
        }
        if (kind === 'skill' || kind === 'both') {
          const res = await collectRows((term) => marketplaceFeat.listMarketplaceSkills({
            q: term,
            ...(category ? { category } : {}),
            size,
          }));
          const rows = filterRows(res.rows || [], installedSkillIds);
          result.skills = rows.map((s) => _compactMarketplaceItem('skill', s, installedSkillIds));
          if (result.skills.length) {
            if (!w.marketplaceSearchResults) w.marketplaceSearchResults = new Map();
            for (const skill of result.skills) {
              w.marketplaceSearchResults.set(`skill:${skill.id}`, {
                description_zh: skill.description_zh || '',
                description_en: skill.description_en || '',
                category: skill.category || '',
                create_uid: skill.create_uid || '',
              });
            }
          }
          result.totals.skills = res.total || 0;
        }
        return _toolJson(result);
      } catch (err) {
        return _toolError((err as Error).message || 'marketplace search failed');
      }
    },
  });

  tools.push({
    name: 'marketplace_request_install',
    description: [
      'Ask the user to approve installing exactly one marketplace agent or skill found via marketplace_search.',
      'This tool does not install anything. It renders a confirmation card for the user; after calling it, stop and wait for the user decision.',
      'Use it only when the candidate is clearly useful for the current task. Prefer one best candidate over several speculative requests.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['agent', 'skill'] },
        id: { type: 'string', description: 'Marketplace resource id from marketplace_search.' },
        name: { type: 'string', description: 'Human-readable resource name from marketplace_search.' },
        icon: { type: 'string', description: 'For agents only: icon token from marketplace_search.' },
        color: { type: 'string', description: 'For agents only: color token from marketplace_search.' },
        description_zh: { type: 'string', description: 'Chinese description from marketplace_search.' },
        description_en: { type: 'string', description: 'English description from marketplace_search.' },
        category: { type: 'string', description: 'Category code from marketplace_search.' },
        create_uid: { type: 'string', description: 'Author uid from marketplace_search; "0" means official.' },
        version: { type: 'string', description: 'Version from marketplace_search.' },
        published_at: { type: 'number', description: 'Published timestamp from marketplace_search.' },
        updated_at: { type: 'number', description: 'Updated timestamp from marketplace_search; include when present.' },
        reason: {
          type: 'string',
          description: 'Short user-facing reason this resource helps the current task.',
        },
      },
      required: ['kind', 'id', 'name', 'version', 'published_at', 'reason'],
      additionalProperties: false,
    },
    async execute(input) {
      const kind = _normaliseMarketplaceKind(input?.kind, false);
      if (kind !== 'agent' && kind !== 'skill') return _toolError('`kind` must be agent or skill');
      const id = _trimText(input?.id, 128);
      if (!safeId(id)) return _toolError('invalid marketplace id');
      const version = _trimText(input?.version, 80);
      if (!version) return _toolError('`version` is required');
      const publishedAt = Number(input?.published_at);
      if (!Number.isFinite(publishedAt)) return _toolError('`published_at` must be a number');
      const name = _trimText(input?.name, 160) || id;
      const reason = _trimText(input?.reason, 800);
      if (!reason) return _toolError('`reason` is required');
      const searchMeta = w.marketplaceSearchResults?.get(`${kind}:${id}`);
      const rawUpdatedAt = input?.updated_at ?? searchMeta?.updated_at;
      const updatedAt = rawUpdatedAt == null ? NaN : Number(rawUpdatedAt);
      const icon = kind === 'agent'
        ? (_trimText(input?.icon, 64) || _trimText(searchMeta?.icon, 64))
        : '';
      const color = kind === 'agent'
        ? (_trimText(input?.color, 64) || _trimText(searchMeta?.color, 64))
        : '';
      const descriptionZh = _trimText(input?.description_zh, 1200) || _trimText(searchMeta?.description_zh, 1200);
      const descriptionEn = _trimText(input?.description_en, 1200) || _trimText(searchMeta?.description_en, 1200);
      const reqCategory = _trimText(input?.category, 80) || _trimText(searchMeta?.category, 80);
      const createUid = _trimText(input?.create_uid, 80) || _trimText(searchMeta?.create_uid, 80);

      try {
        const installs = await readInstalls(uid);
        const alreadyInstalled = kind === 'agent'
          ? installs.agents.some((a) => a.id === id)
          : installs.skills.some((s) => s.id === id);
        if (alreadyInstalled) {
          return _toolJson({
            ok: true,
            already_installed: true,
            kind,
            id,
            instruction: 'This resource is already installed; use the installed agent or skill directly.',
          });
        }
      } catch (err) {
        log.warn(`marketplace_request_install readInstalls failed cid=${cid}: ${(err as Error).message}`);
      }

      if (!w.pendingMarketplaceRequests) w.pendingMarketplaceRequests = [];
      const existing = w.pendingMarketplaceRequests.find((r) => r.kind === kind && r.id === id);
      if (existing) {
        return _toolJson({
          ok: true,
          request_id: existing.request_id,
          status: 'pending_user_confirmation',
          note: 'A confirmation request for this resource is already staged in this turn. Stop and wait for the user decision.',
        });
      }
      const req: MarketplaceInstallRequest = {
        request_id: genId12(),
        kind,
        id,
        name,
        ...(kind === 'agent' && icon ? { icon } : {}),
        ...(kind === 'agent' && color ? { color } : {}),
        ...(descriptionZh ? { description_zh: descriptionZh } : {}),
        ...(descriptionEn ? { description_en: descriptionEn } : {}),
        ...(reqCategory ? { category: reqCategory } : {}),
        ...(createUid ? { create_uid: createUid } : {}),
        version,
        published_at: publishedAt,
        ...(Number.isFinite(updatedAt) ? { updated_at: updatedAt } : {}),
        reason,
        status: 'pending',
        requested_at: nowIso(),
      };
      w.pendingMarketplaceRequests.push(req);
      return _toolJson({
        ok: true,
        request_id: req.request_id,
        status: 'pending_user_confirmation',
        instruction: 'Stop and wait for the user to install or skip this marketplace resource.',
      });
    },
  });

  tools.push({
    name: 'dispatch_to',
    description: [
      'Dispatch a task to a single agent — the **sole channel** for single-agent dispatch. Multi-agent coordination goes through `plan_set`.',
      'Calling this tool **only records intent**; the recipient agent does not start immediately — it is woken up only after this turn\'s text reply is fully sent and placeholders are cleared (avoiding races).',
      '`to` can be the agent name (recommended, matching the `name` in the "Agents list") or the agent_id; the `commander` / `user` aliases are also accepted.',
      '`message` is the dispatch text to send verbatim to the target agent.',
      '**Note**: `@<X>` written in prose is markdown decoration; the system no longer recognizes it as a dispatch signal — to dispatch, call this tool.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target actor — agent name or agent_id; the aliases `commander` / `user` / 指挥官 / 用户 are also accepted.',
        },
        message: {
          type: 'string',
          description: 'Dispatch text, sent verbatim to the target.',
        },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    async execute(input) {
      const toRaw = String(input?.to || '').trim();
      const message = String(input?.message || '').trim();
      if (!toRaw) {
        return { content: JSON.stringify({ ok: false, error: '`to` is required' }), isError: true };
      }
      if (!message) {
        return { content: JSON.stringify({ ok: false, error: '`message` is required' }), isError: true };
      }
      // Resolve `to` → actor id, mirroring the name-map logic used in enqueue's
      // router pass. Reserved aliases first, then enabled agent display names,
      // then raw agent_id fallback.
      const key = toRaw.toLowerCase().replace(/\s+/g, '');
      let resolvedId: string | null = null;
      if (key === 'commander' || key === '指挥官') resolvedId = COMMANDER_ID;
      else if (key === 'user' || key === '用户') resolvedId = USER_ID;
      else {
        try {
          const all = await agentsFeat.listAgents();
          for (const a of all) {
            if (a.enabled === false) continue;
            if (a.name && a.name.toLowerCase().replace(/\s+/g, '') === key) {
              resolvedId = a.agent_id;
              break;
            }
          }
        } catch (err) {
          log.warn(`dispatch_to listAgents failed cid=${cid}: ${(err as Error).message}`);
        }
        if (!resolvedId && safeId(toRaw)) {
          try {
            const ag = await agentsFeat.getAgent(toRaw);
            if (ag && (ag as any).enabled !== false) resolvedId = toRaw;
          } catch { /* ignore */ }
        }
      }
      if (!resolvedId) {
        return {
          content: JSON.stringify({ ok: false, error: t('errors.unknown_actor', { name: toRaw }) }),
          isError: true,
        };
      }
      if (!w.pendingDispatches) w.pendingDispatches = [];
      w.pendingDispatches.push({ to: resolvedId, message });
      return {
        content: JSON.stringify({
          ok: true,
          dispatched_to: resolvedId,
          when: 'after-turn-end',
          note: 'Dispatch recorded; will be delivered after you finish this turn.',
        }),
      };
    },
  });

  tools.push({
    name: 'plan_update',
    description: 'Update a step\'s status (`in_progress` / `done` / `failed`). Sends no message; only updates the file and notifies the front-end panel.',
    inputSchema: {
      type: 'object',
      properties: {
        step_index: { type: 'number', description: '1-based step index.' },
        status: { type: 'string', enum: ['in_progress', 'done', 'failed'] },
        notes: { type: 'string' },
      },
      required: ['step_index', 'status'],
      additionalProperties: false,
    },
    async execute(input) {
      const idx = Number(input?.step_index);
      const status = String(input?.status) as StepStatus;
      const notes = typeof input?.notes === 'string' ? input.notes : undefined;
      if (!Number.isFinite(idx) || !['in_progress', 'done', 'failed'].includes(status)) {
        return { content: JSON.stringify({ ok: false, error: 'invalid input' }), isError: true };
      }
      // updateStep's 5th arg is a `patch` object, not a bare notes string — wrap.
      const updated = await updateStep(uid, cid, idx, status, notes !== undefined ? { notes } : undefined);
      if (!updated) {
        return { content: JSON.stringify({ ok: false, error: 'step not found or no plan yet' }), isError: true };
      }
      emit(state, { type: 'plan_changed', cid });
      return { content: JSON.stringify({ ok: true, step: updated.steps.find((s) => s.index === idx) }) };
    },
  });

  return tools;
}

// ── Abort ────────────────────────────────────────────────────────────────

export async function abort(uid: string, cid: string): Promise<void> {
  const state = _cids.get(cidKey(uid, cid));
  let cleared = 0;
  let aborted = 0;
  let abortedModelSessions = 0;
  if (state) {
    for (const [, w] of state.workers) {
      cleared += w.queue.length;
      if (w.abortController) aborted += 1;
      w.queue.length = 0;
      w.turnsThisActivation = 0;
      try { w.abortController?.abort(); } catch { /* ignore */ }
    }
  }
  // Belt-and-suspenders abort for model turns. In production traces we saw
  // user stop requests reach this function while the bus worker map no longer
  // exposed the live AbortController (`abortedWorkers=0`), even though the
  // core-agent session kept running. The model client owns a per-session
  // abort registry, so abort all active sessions for this conversation too:
  // `gconv-<cid>` and every `gmember-<cid>-<agent>`.
  try {
    const model = await import('../../model/client');
    const abortByCid = (model as {
      abortActiveSessionsForConversation?: (cid: string) => number;
    }).abortActiveSessionsForConversation;
    if (typeof abortByCid === 'function') abortedModelSessions = abortByCid(cid);
  } catch (err) {
    log.warn(`abort model-session fallback failed cid=${cid}: ${(err as Error).message}`);
  }
  await setStatus(uid, cid, 'aborted');
  if (state) {
    emit(state, { type: 'aborted', cid });
    emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
    // Wait for every aborted worker's runTurn to finish unwinding (stream
    // error → finally → abortOutcome → enqueue). Without this the bus's
    // "(stopped)" + processItems message is still being persisted when
    // abort() resolves; an external observer (renderer Cmd+R, an automation
    // script, a test) that re-reads `<cid>.jsonl` immediately after
    // groupChat.abort returns sees a truncated history and never picks up
    // the abort bubble (no live subscription remains either — IPC stream
    // was cancelled by the same user action that triggered this abort).
    //
    // The pi-provider takes ~1-2s to unwind a mid-stream abort because the
    // current tool turn (e.g. an in-flight web_search HTTP call) has to
    // complete its final read before the stream's reject propagates. We
    // poll `isQuiescent` until that whole chain plus the trailing enqueue
    // settles; the timeout is a safety net only — under healthy conditions
    // the loop exits in well under a second.
    const deadline = Date.now() + 10000;
    while (!isQuiescent(uid, cid) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  log.info(`abort user=${uid} cid=${cid} clearedQueue=${cleared} abortedWorkers=${aborted} abortedModelSessions=${abortedModelSessions}`);
}

// ── Cleanup ──────────────────────────────────────────────────────────────

export function dropConv(uid: string, cid: string): void {
  const k = cidKey(uid, cid);
  const state = _cids.get(k);
  if (!state) return;
  for (const [, w] of state.workers) {
    // Mark terminated so the runWorkerLoop exits its outer while at the
    // next wake, instead of looping forever on a stale `state` reference
    // after we drop it from `_cids`.
    w.terminated = true;
    try { w.abortController?.abort(); } catch { /* ignore */ }
    w.queue.length = 0;
    const wake = w.wake; w.wake = null;
    wake?.();
  }
  state.workers.clear();
  state.listeners.clear();
  _cids.delete(k);
}

export function _cidStateForTest(uid: string, cid: string): CidState | null {
  return _cids.get(cidKey(uid, cid)) || null;
}

// ── Plan-executor wiring ──────────────────────────────────────────────────
//
// Bind the plan_executor's bus hooks ONCE at module load. These hooks let
// the executor enqueue dispatch messages, push synthesis turns directly to
// commander's worker, and resolve agent names — all without the executor
// having to import bus internals (which would be a circular import). Bus is
// the only authority that mutates worker queues; executor speaks through
// these hooks.
//
// Catastrophic-if-broken invariant: bus.ts MUST be loaded exactly once per
// process. If a second copy gets loaded (e.g. CJS + ESM dual load when
// `bootstrap.cjs` requires src/main as CJS but somewhere does `await
// import('./group_chat/bus')` — Node always resolves dynamic `import()` to
// ESM regardless of caller context, producing a SEPARATE module instance
// with its own `_cids`), the second load's bindBusHooks call wins because
// plan_executor's `_hooks` is a module-level singleton. Then `groupChat.send`
// (in module A) routes through `planExecutor.reconcile → _hooks.enqueue`
// which now points at module B's enqueue. Module B has empty `_cids`, so
// it creates a fresh state for the cid — agent workers run in B's state,
// events emit to B's listeners (empty), and the IPC subscriber (registered
// on module A) sees zero. Symptom: "loading 一直显示，中断后才看到 process
// info"; chats sidebar sometimes-shows phantom `processing=true`. Bug fixed
// at the load-path side: see chats.ts `require('./group_chat/bus')` (CJS
// require, hits the same module cache as our static `from './bus'` import
// chain) — never `await import` this file.

planExecutor.bindBusHooks({
  async enqueue(params) {
    await enqueue({
      uid: params.uid,
      cid: params.cid,
      fromActorId: params.fromActorId,
      text: params.text,
      ...(params.forceTo ? { forceTo: params.forceTo } : {}),
      ...(typeof params.triggered_step === 'number' ? { triggered_step: params.triggered_step } : {}),
      ...(params.dispatch ? { dispatch: true } : {}),
      ...(params.attachments && params.attachments.length ? { attachments: params.attachments } : {}),
      ...(params.form ? { form: params.form } : {}),
    });
  },

  async pushCommanderTurn(uid, cid, payload) {
    // Wake commander privately — no chat message persisted; the eventual
    // commander → user reply IS the user-visible output (synthesis bubble).
    const state = getOrInitCid(uid, cid);
    await seedReservedActors(uid, cid);
    const members = await readMembers(uid, cid);
    const commander = members.actors.find((a) => a.id === COMMANDER_ID);
    if (!commander) return;
    const w = ensureWorker(state, commander);
    w.queue.push({
      msgId: genId12(),
      fromActorId: 'plan',
      llmPayload: payload.llmPayload,
      triggered_step: payload.triggered_step,
    });
    const wake = w.wake; w.wake = null;
    wake?.();
  },

  async resolveAgent(uid, nameOrId) {
    try {
      // Try as id first (LLM may have written the literal id).
      if (safeId(nameOrId)) {
        const ag = await agentsFeat.getAgent(nameOrId);
        if (ag && isAgentEnabled(uid, ag.agent_id)) return ag.agent_id;
      }
      // Otherwise scan by display name (case + whitespace insensitive).
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
      const target = norm(nameOrId);
      const list = await agentsFeat.listAgents();
      for (const a of list) {
        if (a.enabled === false) continue;
        if (a.name && norm(a.name) === target) return a.agent_id;
      }
    } catch (err) {
      log.warn(`plan executor resolveAgent threw: ${(err as Error).message}`);
    }
    return null;
  },

  emitPlanChanged(uid, cid) {
    const state = _cids.get(cidKey(uid, cid));
    if (state) emit(state, { type: 'plan_changed', cid });
  },
});

// ── CLI agent turn ────────────────────────────────────────────────────────
//
// CLI-backed agents replace the LLM stream loop in runTurn. We pack the
// dispatched message + any user attachments into a single prompt, spawn
// the configured CLI in the user's workspace, and stream events into the
// same `process` rail the renderer already understands. The final body
// is the CLI's last "result" text — assigned into runTurn's `finalText`
// so plan_executor / post-turn enqueue keep working unchanged.
//
// CLI continuity normally belongs to the CLI itself (`--resume` / thread
// resume), so the host prompt sends only the current task plus lightweight
// runtime context (attachments, cwd-switch protocol).
// Exception: if we have to start a fresh CLI session after this agent already
// has visible history (for example cwd changed and the old cwd-keyed session
// id was cleared), we bridge that prior visible transcript once.

const CLI_PROMPT_MAX_BYTES = 200 * 1024;

/** Initialise the coding-agent project directory for a conversation.
 *
 *  The source is the agent detail page's local project-dir setting:
 *  custom override if present, otherwise the effective workspace for
 *  this conversation/project. This runs only while the conversation has
 *  no `coding_project_dir`; once set, that cwd stays stable for the
 *  conversation until the user explicitly switches it through the
 *  directory form. */
async function _initializeCodingProjectDir(
  uid: string, cid: string, info: agentsFeat.AgentCliProjectDirInfo,
): Promise<void> {
  const cur = await readState(uid, cid);
  if (cur.coding_project_dir) return;
  const target = info.effective_path;
  if (!target) return;
  await setCodingProjectDir(uid, cid, target, { explicit: info.mode === 'custom' && info.exists });
  log.info(`coding project_dir initialised cid=${cid} → ${target}`);
}

/** Build an `<agent-input-form>` block listing the agent's required
 *  inputs that are still unfulfilled, or return `null` when nothing is
 *  missing. Currently the only auto-injected input is `project_dir`
 *  (coding agents only); we read its fulfilment from `state.coding_project_dir`.
 *  Other required inputs the user has authored on the agent flow through
 *  here too — for those we have no per-conv storage yet, so they're
 *  re-asked on every dispatch (matches the "prompt every turn until
 *  collected" behaviour the in-process branch already has). */
async function _maybeBuildCliInputForm(
  uid: string, cid: string, agent: import('../agents').Agent,
): Promise<string | null> {
  const inputs = Array.isArray(agent.inputs) ? agent.inputs : [];
  if (!inputs.length) return null;
  const required = inputs.filter((f) => f.required);
  if (!required.length) return null;

  const state = await readState(uid, cid);
  const projectDir = state.coding_project_dir || '';

  const isFulfilled = (fieldId: string): boolean => {
    if (fieldId === 'project_dir') return !!projectDir;
    return false;
  };

  const missing = required.filter((f) => !isFulfilled(f.id));
  if (!missing.length) return null;

  const body = JSON.stringify({
    agent_id: agent.agent_id,
    fields: missing,
  });
  return `<agent-input-form>\n${body}\n</agent-input-form>`;
}

async function _runCliAgentTurn(opts: {
  uid: string;
  cid: string;
  actor: { id: string; kind: 'agent' | 'commander' | 'user' };
  agent: import('../agents').Agent;
  item: QueueItem;
  slice: GroupMessage[];
  workingDir: string;
  signal: AbortSignal;
  onProcess: (data: Record<string, unknown>) => void;
}): Promise<{ text: string; error?: string; aborted?: boolean }> {
  const runtime = opts.agent.runtime as Extract<NonNullable<import('../agents').AgentRuntime>, { kind: 'cli' }>;

  // Required-input gate: a CLI agent never runs an LLM, so the form-emit
  // logic in `chat_agent_in_group.md` (where in-process agents check their
  // inputs_schema and emit `<agent-input-form>` themselves) doesn't fire.
  // We mirror that here: if any required input is unfulfilled, return a
  // synthetic body containing the form block — runTurn's
  // `extractFormFromFinal` then lifts it into a `form` payload, the
  // renderer shows the picker, and the user's submission re-dispatches
  // through the standard pipeline. Only the `project_dir` input is
  // currently auto-injected, but the gate is generic so future required
  // inputs reuse the same path.
  const formBlock = await _maybeBuildCliInputForm(opts.uid, opts.cid, opts.agent);
  if (formBlock) return { text: formBlock };

  // Look up any prior CLI session bound to this (cid, aid, cli). If
  // present, we ask the CLI to resume it (claude: `--resume <id>`,
  // codex: `thread/resume`). With a valid resume handle, the prompt stays
  // current-turn-only: CLI agents persist their own conversation records,
  // and duplicating host chat history here bloats context and can confuse
  // the CLI's native memory. Without a handle, but with prior visible
  // turns, we bridge that transcript into the fresh CLI session.
  const cliSessions = await import('../local_agents/sessions');
  const resumeSessionId = await cliSessions.getSessionId(
    opts.uid, opts.cid, opts.agent.agent_id, runtime.cli,
  );
  const bridgeHistory = !resumeSessionId && _hasPriorVisibleCliHistory(opts.item, opts.slice);
  const promptText = await _buildCliPrompt(
    opts.uid, opts.cid, opts.agent, opts.item, opts.slice, bridgeHistory,
  );
  // When `_buildCliPrompt` took the slash-command fast-path, promptText is
  // the raw `/cmd …` we forwarded. Remember the command name so the
  // success-return path below can swap CLI's (no content)/empty result
  // for a helpful note instead of leaving an empty bubble — common with
  // session-control slashes like `/new` / `/clear` that no-op in -p mode.
  const slashCommandName = _isSlashCommand(promptText)
    ? (/^(\/[A-Za-z][A-Za-z0-9_-]*)/.exec(promptText)?.[1] ?? null)
    : null;
  const runner = await import('../local_agents/runner');

  let accText = '';
  let resultText = '';
  let aborted = false;
  let backendSessionId: string | undefined;
  // Set when the CLI rejects our `--resume <id>` (e.g. claude code's
  // "No conversation found with session ID …"). Triggers a one-time
  // cleanup of the cliSessions binding so the next dispatch starts
  // fresh instead of replaying the same broken resume forever. Detect
  // by stderr-line pattern because there is no structured signal —
  // each CLI phrases it slightly differently but they all carry the
  // session-id hex.
  let resumeRejected = false;
  const _RESUME_REJECTED_PATTERNS = [
    /No conversation found with session ID/i,
    /session.*(not found|does not exist|expired|invalid)/i,
  ];

  const result = await runner.run({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agent.agent_id,
    cli: runtime.cli as import('../local_agents/registry').LocalCliType,
    model: runtime.model,
    customArgs: runtime.custom_args,
    resumeSessionId: resumeSessionId || undefined,
    prompt: promptText,
    cwd: opts.workingDir,
    signal: opts.signal,
    onEvent: e => {
      // Translate each LocalEvent into the `process` event shape the
      // renderer's group-chat listener expects so output streams live
      // into the placeholder bubble (text-delta) and the process rail
      // (tool-event, stderr, process-info). Without this, the renderer
      // treats every event as an unrecognized shape and only the final
      // text appears at turn-end.
      switch (e.type) {
        case 'text-delta':
          if (typeof (e as any).text === 'string') {
            accText += (e as any).text as string;
            // Slash-command turns: buffer text-delta in `accText` instead
            // of streaming to the bubble. The success-return path below
            // either swaps the body for "已发送命令 …" (CLI returned
            // empty / "(no content)") or hands the accumulated text in
            // one shot as the final msg.text. Streaming would otherwise
            // flash the CLI's "(no content)" before our substitution
            // lands, since renderer commits each delta to the bubble.
            if (!slashCommandName) {
              opts.onProcess({ type: 'delta', text: (e as any).text });
            }
          }
          break;
        case 'thinking':
          if (typeof (e as any).text === 'string') {
            opts.onProcess({ type: 'progress', text: (e as any).text });
          }
          break;
        case 'tool-event':
        case 'process-info':
        case 'status':
          opts.onProcess({ type: 'event', event: { stream: 'cli', data: e as unknown as Record<string, unknown> } });
          break;
        case 'stderr-line':
          if (resumeSessionId && typeof (e as any).line === 'string') {
            const line = (e as any).line as string;
            if (_RESUME_REJECTED_PATTERNS.some((re) => re.test(line))) resumeRejected = true;
          }
          opts.onProcess({ type: 'event', event: { stream: 'cli', data: e as unknown as Record<string, unknown> } });
          break;
        case 'done':
          if (typeof (e as any).output === 'string') resultText = (e as any).output as string;
          if ((e as any).status === 'cancelled') aborted = true;
          if (typeof (e as any).sessionId === 'string') backendSessionId = (e as any).sessionId as string;
          break;
        default:
          opts.onProcess({ type: 'event', event: { stream: 'cli', data: e as unknown as Record<string, unknown> } });
      }
    },
  });

  // Drop the stale resume binding before returning so a user-initiated
  // retry starts a fresh CLI session instead of looping on the same
  // expired id. Done unconditionally on rejection — even if the CLI
  // somehow finished successfully, the resume id we sent is gone, and
  // the binding is at best useless / at worst will fail again.
  if (resumeRejected) {
    log.warn(`cli session expired cid=${opts.cid} agent=${opts.agent.agent_id} cli=${runtime.cli} — clearing resume binding`);
    cliSessions
      .clearForAgent(opts.uid, opts.cid, opts.agent.agent_id)
      .catch(() => { /* logged inside sessions.ts */ });
  }

  if (result.status === 'missing_cli') {
    const msg = t('cli_agent.missing', { name: opts.agent.name || runtime.cli, cli: runtime.cli });
    return { text: '', error: msg, aborted: false };
  }
  if (result.status === 'cancelled') {
    return { text: resultText || accText, aborted: true };
  }
  if (result.status === 'failed' || result.status === 'timeout') {
    const detail = result.error || (result.status === 'timeout' ? 'timeout' : 'failed');
    // When the failure was a stale resume id, hint the user that a
    // simple resend will recover (the binding has been cleared above).
    const hint = resumeRejected ? ' — session expired; retry will start fresh.' : '';
    return { text: resultText || accText, error: detail + hint };
  }
  // Successful turn — persist the (possibly new) session id so the
  // next dispatch can resume. Claude reports its session id every
  // turn; if a `--resume` lands on an expired session, claude
  // silently allocates a new one and reports that as `sessionId` in
  // the system/init record. Either way we save what's freshest. The
  // write is fire-and-forget — failures only affect the next turn's
  // optimisation, not correctness.
  if (backendSessionId) {
    cliSessions
      .setSessionId(opts.uid, opts.cid, opts.agent.agent_id, runtime.cli, backendSessionId)
      .catch(() => { /* logged inside sessions.ts */ });
  }
  const finalText = resultText || accText;
  if (slashCommandName && _looksLikeNoOutput(finalText)) {
    return {
      text: t('cli_agent.slash_no_output', { cmd: slashCommandName }),
    };
  }
  return { text: finalText };
}

async function _buildCliPrompt(
  uid: string,
  cid: string,
  agent: import('../agents').Agent,
  item: QueueItem,
  slice: GroupMessage[],
  bridgeHistory: boolean,
): Promise<string> {
  // Slash-command fast-path: when the user sends `/foo …` to a CLI agent,
  // forward the raw text so the CLI's own slash dispatcher (built-ins +
  // project `.claude/commands/*.md`) sees the leading `/`. Without this,
  // the chat_cli_agent.md frame buries the slash beneath the agent
  // identity + output-protocol + history block, and the CLI parser never
  // fires. Only applies to direct user → CLI dispatch — form submissions
  // and agent-to-agent forwards keep the full frame.
  if (item.fromActorId === USER_ID && !decodeSubmission(item.llmPayload)) {
    const rawUserText = _unwrapLlmTurnPayload(item.llmPayload);
    if (rawUserText) {
      const stripped = _stripLeadingRecipientMention(
        rawUserText, agent.name || '', agent.agent_id,
      );
      if (_isSlashCommand(stripped)) {
        return stripped;
      }
    }
  }

  // Layout = `chat_cli_agent.md` (static frame) + `chat_cli_coding_protocol.md`
  // (coding-only). The static-first / runtime-last split keeps the
  // CLI's prompt cache stable across turns: identity + protocol stay
  // byte-identical, attachments / task body change.
  const { prompts } = await import('../../prompts/loader');
  const { chatAttachmentDir } = await import('../../paths');

  // ── Output protocol — coding agents only ────────────────────────
  // Non-coding CLIs (openclaw / opencode / hermes) get an empty block
  // and never see the project-dir-switching rules — the host doesn't
  // route their cwd through `coding_project_dir` and the form
  // wouldn't fire on their submissions anyway.
  const cli = agent.runtime?.kind === 'cli' ? agent.runtime.cli : '';
  let outputProtocolBlock = '';
  if (agentsFeat.cliIsCodingAgent(cli)) {
    const inputs = Array.isArray(agent.inputs) ? agent.inputs : [];
    const projectDirInput = inputs.find((f: any) => f.id === agentsFeat.PROJECT_DIR_INPUT_ID);
    const projectDirLabel = (projectDirInput && typeof projectDirInput.label === 'string' && projectDirInput.label.trim())
      ? projectDirInput.label
      : 'Project directory';
    outputProtocolBlock = prompts.load('chat_cli_coding_protocol', {
      agent_id: agent.agent_id,
      project_dir_label: projectDirLabel,
    }).trim();
  }

  // ── Attachments — collected across the whole slice + this dispatch
  // De-duplicate by absolute path; preserve oldest-first order.
  const attDir = chatAttachmentDir(uid, cid);
  const allAtts: string[] = [];
  const seenAtts = new Set<string>();
  const collect = (names: string[] | undefined) => {
    if (!Array.isArray(names)) return;
    for (const n of names) {
      const abs = path.join(attDir, n);
      if (!seenAtts.has(abs)) { seenAtts.add(abs); allAtts.push(abs); }
    }
  };
  for (const m of slice) collect(m.attachments);
  collect(item.attachments);
  const attachmentsBlock = allAtts.length
    ? `## Attachments\n${allAtts.map(a => `- ${a}`).join('\n')}`
    : '';
  let projectFilesBlock = '';
  try {
    const { getConversation } = await import('../chats');
    const conv = await getConversation(uid, cid);
    const pid = (conv as any)?.project_id;
    if (typeof pid === 'string' && pid) {
      const projectFileFeature = await import('../project_files');
      projectFilesBlock = await projectFileFeature.buildProjectFilesCliBlock(uid, pid);
    }
  } catch (err) {
    log.warn(`cli project files block failed cid=${cid}: ${(err as Error).message}`);
  }
  const filesBlock = [attachmentsBlock, projectFilesBlock].filter(Boolean).join('\n\n');

  // ── Task body — submission unwrap if the dispatch was a form-submit.
  // When the user confirmed the input form, the dispatched payload is
  // metadata (`<agent-input-submission>` + a values summary) — handing
  // that to a coding CLI gives it nothing actionable. Walk the slice
  // backward to recover the most recent user message that ISN'T
  // another submission and use it as the real task; append the
  // confirmed values as extra context. cwd is already routed via
  // `state.coding_project_dir`, so we strip `project_dir` from the
  // confirmed-parameters block.
  const submission = decodeSubmission(item.llmPayload);
  let taskBody: string;
  if (submission) {
    let originalTask = '';
    for (let i = slice.length - 1; i >= 0; i--) {
      const m = slice[i];
      const txt = (m.text || '').trim();
      if (m.from !== 'user' || !txt) continue;
      if (decodeSubmission(txt)) continue;
      originalTask = txt;
      break;
    }
    const lines: string[] = [originalTask || item.llmPayload];
    const extraValues = Object.entries(submission.values)
      .filter(([k]) => k !== 'project_dir')
      .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    if (extraValues.length) {
      lines.push('', '## Confirmed parameters', ...extraValues);
    }
    taskBody = lines.join('\n');
  } else {
    taskBody = item.llmPayload;
  }

  const render = (conversationBlock: string) => prompts.load('chat_cli_agent', {
    agent_name: agent.name || agent.agent_id,
    agent_description: (agent.description_en || agent.description_zh || '').trim(),
    output_protocol_block: outputProtocolBlock,
    attachments_block: filesBlock,
    conversation_block: conversationBlock,
    task_body: taskBody,
  });

  if (!bridgeHistory) return render('');

  const history = _priorVisibleCliHistory(item, slice);
  if (!history.length) return render('');

  const sliceLines: string[] = [];
  for (const m of history) {
    const to = (m.to || []).join(',') || '-';
    const text = (m.text || '').replace(/\r/g, '').trim();
    if (!text) continue;
    sliceLines.push(`[${m.from} → ${to}] ${text}`);
  }
  if (!sliceLines.length) return render('');

  const baseBytes = Buffer.byteLength(render(''), 'utf8');
  if (baseBytes >= CLI_PROMPT_MAX_BYTES) {
    log.warn(`cli prompt: base exceeds cap; sending minimal prompt cid=${cid} agent=${agent.agent_id}`);
    return render('');
  }
  const sliceBudget = CLI_PROMPT_MAX_BYTES - baseBytes;
  const kept: string[] = [];
  let used = 0;
  for (let i = sliceLines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(sliceLines[i] + '\n', 'utf8');
    if (used + lineBytes > sliceBudget) break;
    kept.unshift(sliceLines[i]);
    used += lineBytes;
  }
  const truncated = kept.length < sliceLines.length;
  if (truncated) {
    log.warn(`cli prompt: trimmed ${sliceLines.length - kept.length}/${sliceLines.length} oldest slice rows cid=${cid} agent=${agent.agent_id}`);
  }
  const conversationBlock = `## Conversation so far${truncated ? ' (truncated)' : ''}\n${kept.join('\n')}`;
  return render(conversationBlock);
}

function _priorVisibleCliHistory(item: QueueItem, slice: GroupMessage[]): GroupMessage[] {
  const idx = slice.findIndex((m) => m.id === item.msgId);
  return idx >= 0 ? slice.slice(0, idx) : slice;
}

function _hasPriorVisibleCliHistory(item: QueueItem, slice: GroupMessage[]): boolean {
  return _priorVisibleCliHistory(item, slice).some((m) => (m.text || '').trim());
}
