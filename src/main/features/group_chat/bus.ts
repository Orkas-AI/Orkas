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
  setStatus, markInFlight, readState, transitionStatus,
} from './state';
import {
  GroupMessage, appendVisible, readSlice, buildReplayPrefix,
} from './visibility';
import {
  resolveRecipients, parseMentions,
  extractFormFromFinal, computeFormId, ChatFormPayload,
  extractAgentFieldBlocks,
} from './router';
import {
  setPlan, updateStep, readPlan, formatPlanAnnouncement, formatPlanForPrompt,
  PlanSetInput, StepStatus, PlanFile,
} from './plan';
import * as planExecutor from './plan_executor';
import { userChatsDir, BUILTIN_SKILLS_DIR, userSkillsDir } from '../../paths';
import * as agentsFeat from '../agents';
import * as userWorkspace from '../user_workspace';
import { isAgentEnabled } from '../component_enabled';

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
   * up as a stuck "思考中" bubble when commander's turn ends silently. */
  | { type: 'message'; cid: string; msg: GroupMessage; turn_end?: boolean }
  | { type: 'process'; cid: string; actor: string; data: Record<string, unknown> }
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
   * would emit a "（无回复）" placeholder bubble and pollute the chat. */
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
   * worker can't抢跑 — it only wakes after commander's text reply persisted +
   * placeholder cleaned. Same staging pattern as pendingPlanAnnouncement +
   * deferred planExecutor.reconcile, just for direct dispatches. */
  pendingDispatches?: Array<{ to: string; message: string }>;
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

/** Recompute the on-disk `status` field based on actual worker / queue
 *  state. Honors the sticky `aborted` flag — once aborted, ONLY an
 *  explicit USER `enqueue` clears it (so a follow-up worker reply
 *  triggered by the abort itself, like the "（已中断）" message,
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
  created_agent?: { agent_id: string; name: string };
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
  // replies, including the abort-cleanup "（已中断）") must NOT clear
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
    // router can resolve `@<人类可读名字>` mentions. Keys are normalized
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
  // ids inside other content don't get touched.
  let rewrittenText = text;
  for (const [aid, name] of idToName) {
    if (!name || name === aid) continue;
    const safeAid = aid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@${safeAid}\\b`, 'g');
    rewrittenText = rewrittenText.replace(re, `@${name.replace(/\s+/g, '')}`);
  }

  // Strip ALL `@user` / `@commander` mentions when they're the routed
  // recipient — not just leading. The addressee lives in `to`; any literal
  // `@<recipient>` in the body is redundant noise. Mid-prose mentions
  // ("好的 @user，关于...") are common LLM filler that users find annoying.
  // Why ONLY user/commander and not agents: `@<agent>` from commander is
  // informational (shows observers which agent got dispatched), so we keep
  // those. Agents addressing user/commander gain nothing from the literal.
  // Aliases (`@指挥官` / `@用户`) get the same treatment so Chinese-form
  // mentions don't slip through.
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
    // intact: "收到 @user，关于" → "收到，关于" (comma stays), but
    // "好 @user 的" → "好 的" (space-bounded mid-word).
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
    ...(params.created_agent ? { created_agent: params.created_agent } : {}),
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
  // Edge case: agent explicitly `@指挥官` to escalate. That message has
  // commander in `to`, so it goes through the regular dispatch loop above.

  // User-driven reconcile: when user enqueues, plan_executor needs a chance
  // to mark a `user`-assignee step as done and dispatch downstream. Worker-
  // driven reconcile already runs in runTurn for agent/commander turns.
  // Fire-and-forget — reconcile is idempotent and shouldn't block enqueue.
  if (fromActorId === USER_ID) {
    void planExecutor.reconcile(uid, cid, {
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

  const sessionId = actorSessionId(uid, cid, actor);
  const isCommander = actor.kind === 'commander';
  const workingDir = userWorkspace.getWorkspacePath(uid);

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

  // Attach a `<attachments>` manifest block listing user-uploaded files
  // (text / pdf / docx with absolute paths + kinds). Commander uses it to
  // route work; agent uses it to extract values for `inputs_schema`
  // (especially `type=file` fields). Without this the LLM only sees the
  // text body and can't know what files the user attached. Image bytes
  // aren't piped through here yet — that needs ChatOptions.images plumbing
  // and lands as a follow-up.
  if (item.attachments && item.attachments.length) {
    try {
      const { buildAttachmentManifest } = await import('../chat_attachments');
      const { manifest } = await buildAttachmentManifest(uid, cid, item.attachments);
      if (manifest) messageText = `${manifest}\n${messageText}`;
    } catch (err) {
      log.warn(`attachments manifest build failed cid=${cid} actor=${actor.id}: ${(err as Error).message}`);
    }
  }

  // Build system prompt + extra tools per role.
  let systemPrompt: string;
  let extraTools: AgentTool[] = [];
  let skillList: string[] | undefined;
  if (isCommander) {
    systemPrompt = await buildCommanderSystemPrompt(uid, cid);
    extraTools = await buildCommanderExtraTools(state, w);
  } else {
    const agent = await agentsFeat.getAgent(actor.id);
    if (!agent) {
      log.warn(`agent ${actor.id} disappeared mid-turn`);
      await markInFlight(uid, cid, actor.id, false);
      // Note: runWorkerLoop owns w.running — its finally clears the flag
      // when this returns. We DON'T touch it here.
      return;
    }
    systemPrompt = await buildAgentInGroupSystemPrompt(uid, agent, workingDir);
    skillList = Array.isArray(agent.skill_list) ? agent.skill_list : undefined;
  }

  // Streaming.
  const { streamChatWithModel } = await import('../../model/client');
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
  let finalText = '';
  // Mirror of every text delta we forwarded to the renderer this turn.
  // Used as the salvage source when the user aborts mid-stream — the
  // event-mapper emits `error` (not `final`) on abort, so without this
  // accumulator the partial reply the user already saw rendering would be
  // discarded and we'd persist a bare "（已中断）" placeholder. Same pattern
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
  // Skill directories are referenced by `$builtin_skills_dir` /
  // `$custom_skills_dir` template vars in the system prompt — commander +
  // agents are explicitly told to `cat .../<id>/SKILL.md` to read the
  // skill body before executing. Path-sandbox blocks anything outside
  // workspace + attachment dir by default, so we have to expose the two
  // skill roots here as `extraRoots` (mirrors the skill-edit chat pattern
  // in features/skills.ts). Builtin first to match the prompt's "按来源
  // 定位" guidance.
  const skillRoots = [BUILTIN_SKILLS_DIR, userSkillsDir(uid)];
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
      onFileWritten,
      hasProducedPath,
      cacheRetention: 'short',
      abortSignal: w.abortController.signal,
      extraRoots: skillRoots,
      ...(extraTools.length ? { extraTools } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
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
    // it instead of throwing away visible work as a bare "（已中断）" stub.
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

  // ── Post-stream parsing (pure data extraction; no decisions) ──────────
  // Form / <agent> container extraction stays in bus because they're pure
  // text → structured-data parsing. Decisions (silent / done / blocked /
  // failed) live in plan_executor.onTurnFinished.
  let workingText = finalText || '';
  let form: ChatFormPayload | undefined;
  let createdAgent: { agent_id: string; name: string } | undefined;

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
    if (Object.keys(r.fields).length) {
      workingText = r.cleanText;
      try {
        const ag = await agentsFeat.createAgentFromBlocks(r.fields);
        if (ag) {
          createdAgent = { agent_id: ag.agent_id, name: ag.name };
        } else {
          // Append failure marker to text — onTurnFinished will surface
          // it as a normal `persist` outcome.
          workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ 智能体创建失败：缺少必要字段（name / workflow）。</span>`;
        }
      } catch (err) {
        log.error(`create-agent failed cid=${cid}: ${(err as Error).message}`);
        workingText = `${workingText}\n\n<span style="color:var(--danger)">⚠️ 智能体创建失败：${(err as Error).message}</span>`;
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
      ...(createdAgent ? { createdAgent } : {}),
      trigger,
      activityEvents,
    });
  } catch (err) {
    log.warn(`plan_executor.onTurnFinished threw cid=${cid} actor=${actor.id}: ${(err as Error).message}`);
    // Fail-safe: persist the raw final so user sees something rather than
    // a stalled chat.
    outcome = {
      kind: 'persist',
      text: workingText || '（无回复）',
      ...(form ? { form } : {}),
      ...(produced.length ? { produced } : {}),
      ...(createdAgent ? { createdAgent } : {}),
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

  // Abort post-processing — single source of truth for both "promote silent
  // to persist when there's still something visible to keep" AND the
  // "（已中断）" suffix.
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
  if (aborted) {
    if (outcome.kind === 'silent' && processItems.length > 0) {
      outcome = { kind: 'persist', text: '' };
    }
    if (outcome.kind === 'persist') {
      const body = outcome.text && outcome.text.trim()
        ? `${outcome.text}\n\n（已中断）` : '（已中断）';
      outcome = { ...outcome, text: body };
    }
  }

  if (outcome.kind === 'persist') {
    await enqueue({
      uid, cid,
      fromActorId: actor.id,
      text: outcome.text,
      ...(outcome.form ? { form: outcome.form } : {}),
      ...(outcome.produced && outcome.produced.length ? { produced: outcome.produced } : {}),
      ...(outcome.createdAgent ? { created_agent: outcome.createdAgent } : {}),
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
    // a "思考中 + 过程信息" bubble lingers, vanishes only on page refresh.
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
  // anti-抢跑 reasoning as the plan reconcile above: recipient workers are
  // only woken after commander's own turn fully settled (text persisted +
  // placeholder cleaned), so the user sees commander's reply before any
  // dispatched agent's reply. See WorkerState.pendingDispatches.
  if (actor.kind === 'commander' && w.pendingDispatches && w.pendingDispatches.length) {
    const pending = w.pendingDispatches;
    w.pendingDispatches = undefined;
    for (const d of pending) {
      try {
        await enqueue({
          uid, cid,
          fromActorId: actor.id,
          text: d.message,
          forceTo: [d.to],
          dispatch: true,
        });
      } catch (err) {
        log.warn(`dispatch_to flush failed cid=${cid} to=${d.to}: ${(err as Error).message}`);
      }
    }
  }

  await _syncStateStatus(state);
  log.info(
    `turn-end user=${uid} cid=${cid} actor=${actor.id} ms=${Date.now() - turnStartedAt}`
    + ` outcome=${outcome.kind}`
    + ` events=${activityEvents}`
    + (form ? ' form=1' : '')
    + (createdAgent ? ` created_agent=${createdAgent.agent_id}` : '')
    + (produced.length ? ` produced=${produced.length}` : '')
    + (item.triggered_step !== undefined ? ` step=${item.triggered_step}` : '')
    + (errText ? ` err=${errText}` : '')
    + (aborted ? ' aborted=1' : ''),
  );
}

// ── System prompts ───────────────────────────────────────────────────────

async function buildCommanderSystemPrompt(uid: string, cid: string): Promise<string> {
  const { prompts } = await import('../../prompts/loader');
  const path_ = await import('node:path');
  const paths_ = await import('../../paths');
  const plan = await readPlan(uid, cid);
  const allAgentsList = await buildAgentsIndexBlock(uid);
  const workingDir = userWorkspace.getWorkspacePath(uid);
  const permState = (() => {
    try {
      const s = require('../permissions').getLocalExecState() as { granted: boolean };
      return s.granted ? '**已授权**（可自由执行）' : '**未授权**（需用户在「设置 → 本机执行」开启）';
    } catch { return '**未授权**'; }
  })();
  // Stable sections first (cache-friendly), runtime injection last.
  // chat_shared_rules.md is appended BEFORE the runtime block in
  // chat_commander.md so it stays in the cached prefix.
  const main = prompts.load('chat_commander', {
    contexts_dir: path_.resolve(paths_.userContextsDir(uid)),
    builtin_agents_dir: path_.resolve(paths_.BUILTIN_AGENTS_DIR),
    custom_agents_dir: path_.resolve(paths_.userAgentsDir(uid)),
    builtin_skills_dir: path_.resolve(paths_.BUILTIN_SKILLS_DIR),
    custom_skills_dir: path_.resolve(paths_.userSkillsDir(uid)),
    agents_index: allAgentsList,
    plan_state: formatPlanForPrompt(plan),
    os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform,
    working_dir: workingDir,
    local_exec_state: permState,
  });
  const shared = prompts.load('chat_shared_rules', {});
  return concatSharedRules(main, shared);
}

/** Merge shared_rules into the per-role prompt. The shared block carries
 *  PDF / search / file-output rules that BOTH commander and agent need;
 *  duplicating them in two .md files would drift. We append them right
 *  before the `## 运行态注入` divider so the runtime-variable section
 *  (the only mutable part) stays last for KV cache stability. */
function concatSharedRules(main: string, shared: string): string {
  if (!shared.trim()) return main;
  const marker = '## 运行态注入';
  const idx = main.indexOf(marker);
  if (idx < 0) return `${main}\n\n---\n\n${shared}`;
  return `${main.slice(0, idx)}---\n\n${shared}\n\n${main.slice(idx)}`;
}

async function buildAgentsIndexBlock(_uid: string): Promise<string> {
  // listAgents() reads from the active uid context (set by activateUser at boot
  // / on user switch); no uid arg needed.
  const { getCurrentLang } = await import('../../i18n');
  const { pickDescription } = await import('#core-agent');
  const lang = getCurrentLang();
  try {
    const list = (await agentsFeat.listAgents()).filter((a: any) => a.enabled !== false);
    if (!list.length) return '（暂无智能体）';
    return list.map((a: any) => {
      const name = a.name || a.agent_id;
      const description = pickDescription(a, lang);
      const desc = description ? ` — ${description}` : '';
      // Lead with `@<name>` so the LLM picks up the calling convention
      // visually; id is hidden — exposing hex strings in prompts trains
      // the LLM to leak them in user-visible text too.
      const head = `- @${name} (来源: ${a.source})${desc}`;
      // Inline a slimmed inputs_schema (id / type / required / default /
      // label / options / min / max / accept) so commander knows what
      // params each agent expects when phrasing its `@<name>` dispatch
      // text. Stripped of UI-only narrative fields (description /
      // placeholder) — those bloat the prompt without helping the LLM
      // extract values.
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
  } catch { return '（暂无智能体）'; }
}

async function buildAgentInGroupSystemPrompt(
  uid: string,
  agent: { name?: string; description?: string; workflow?: string; agent_id: string; inputs?: unknown },
  workingDir: string,
): Promise<string> {
  const { prompts } = await import('../../prompts/loader');
  const path_ = await import('node:path');
  const paths_ = await import('../../paths');
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
  const main = prompts.load('chat_agent_in_group', {
    name: agent.name || '',
    agent_id: agent.agent_id,
    description: agent.description || '(未填写)',
    workflow: (agent.workflow || '').trim() || '(未填写)',
    inputs_schema: inputsSchemaJson || '（无）',
    builtin_skills_dir: path_.resolve(paths_.BUILTIN_SKILLS_DIR),
    custom_skills_dir: path_.resolve(paths_.userSkillsDir(uid)),
    working_dir: workingDir,
  });
  const shared = prompts.load('chat_shared_rules', {});
  return concatSharedRules(main, shared);
}

// ── Commander tools (plan_set / plan_update) ────────────────────────────

async function buildCommanderExtraTools(state: CidState, w: WorkerState): Promise<AgentTool[]> {
  const { uid, cid } = w;
  const tools: AgentTool[] = [];
  tools.push({
    name: 'plan_set',
    description: [
      '落档完整执行计划——bus 会按 plan 自动派活、跟踪状态、串/并行调度，**不需要你后续手动 @ 派**。',
      '每个 step 必须写明 `assignee`（user / commander / 智能体名字）和 `input`（派活文本，可用 `{{user_initial_message}}` 和 `{{step_N.output_summary}}` 模板变量引用上下文）。',
      'step 之间默认串行（每步等上一步 done），用 `wait_for: []` 让该步立即跑、用 `wait_for: [N]` 显式声明依赖、用 `parallel_group: "g"` 把多步标成同组并行。',
      '第一次调用同步在群里发一条公告让用户看到大致路径；后续覆盖只更新文件。step 数 1-15。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        initial_message: {
          type: 'string',
          description: '可选：触发本 plan 的 user 原始消息文本，会被存到 plan 里供 `{{user_initial_message}}` 变量引用。第一次写 plan 时强烈建议填——否则下游 step 的 input 模板拿不到 user 原话',
        },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '一句话步骤目标（祈使语气）' },
              assignee: {
                type: 'string',
                description: '执行者：智能体名字 / commander（自己干，常用于汇总）/ user（向用户提问，等用户回话）',
              },
              input: {
                type: 'string',
                description: '派给 assignee 的派活文本（模板）。bus 会渲染变量后**原样**作为消息发给 assignee。可用 `{{user_initial_message}}`、`{{step_1.output_summary}}`、`{{step_2.output_files}}` 等。这是 plan 真正的"派活脚本"',
              },
              wait_for: {
                type: 'array',
                items: { type: 'number' },
                description: '可选：依赖的 step 编号列表（1-based）。默认 = [上一步]（线性串行）。`[]` 表示无依赖，立即跑。多个依赖表示要等他们都 done。',
              },
              parallel_group: {
                type: 'string',
                description: '可选：标记同一并行组。同组的 step 同时 dispatch（fork）。常用于"多个智能体独立分析同一问题"',
              },
              on_failure: {
                type: 'string',
                enum: ['abort_plan', 'continue', 'ask_commander'],
                description: '可选失败策略：abort_plan 整盘停 / continue 跳过这步继续 / ask_commander（默认）唤醒指挥官决断',
              },
              notes: { type: 'string', description: '可选补充说明（不影响执行）' },
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
    name: 'dispatch_to',
    description: [
      '派活给单个 agent —— 单 agent 派活的**唯一通道**。多 agent 协作走 `plan_set`。',
      '调用本 tool **只是记录**派活意图；recipient agent 不会立即开干，要等你这一回合的文本回复完整发完、placeholder 清理后才被唤醒（避免抢跑）。',
      '`to` 可以是 agent 名字（推荐，跟"智能体列表"里的 name 一致）或 agent_id，commander/user 别名也支持。',
      '`message` 是要原样发给目标 agent 的派活文本。',
      '**注意**：散文里的 `@<X>` 是 markdown 装饰，系统已不识别为派活信号；想派活就调本工具。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '目标 actor —— agent 名字或 agent_id；commander / user / 指挥官 / 用户 也可',
        },
        message: {
          type: 'string',
          description: '派活文本，原样发给目标',
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
          content: JSON.stringify({ ok: false, error: `unknown actor: "${toRaw}" — 名字要跟"智能体列表"里的 name 一致；或检查 agent 是否禁用` }),
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
          note: '已记录派活，等你这一回合发完再投递',
        }),
      };
    },
  });

  tools.push({
    name: 'plan_update',
    description: '更新某一步的状态（in_progress / done / failed）。不会发消息，只更新文件并通知前端面板。',
    inputSchema: {
      type: 'object',
      properties: {
        step_index: { type: 'number', description: '1-based 步骤编号' },
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
      const updated = await updateStep(uid, cid, idx, status, notes);
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
  if (state) {
    for (const [, w] of state.workers) {
      cleared += w.queue.length;
      if (w.abortController) aborted += 1;
      w.queue.length = 0;
      w.turnsThisActivation = 0;
      try { w.abortController?.abort(); } catch { /* ignore */ }
    }
  }
  await setStatus(uid, cid, 'aborted');
  if (state) {
    emit(state, { type: 'aborted', cid });
    emit(state, { type: 'state_changed', cid, state: await readState(uid, cid) });
    // Wait for every aborted worker's runTurn to finish unwinding (stream
    // error → finally → abortOutcome → enqueue). Without this the bus's
    // "（已中断）" + processItems message is still being persisted when
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
  log.info(`abort user=${uid} cid=${cid} clearedQueue=${cleared} abortedWorkers=${aborted}`);
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

/**
 * Watchdog hook — synthesise a system message into commander's worker
 * queue so it gets a turn to self-diagnose when a long-running plan has
 * gone silent. Bypasses `enqueue` (no main jsonl write, no visibility
 * slice, no UI message event) on purpose: the ping is a backend
 * mechanism, not group content. Commander's reply (if any) goes through
 * the normal `enqueue` path inside its `runTurn` post-turn → user sees
 * commander's actual response, never the ping itself.
 *
 * Idempotent / cheap: if the commander worker has anything queued, we
 * skip — no point doubling up. If state already aborted, also skip.
 */
export async function pingCommanderForWatchdog(uid: string, cid: string, reason: string): Promise<boolean> {
  const state = getOrInitCid(uid, cid);
  await seedReservedActors(uid, cid);
  const cur = await readState(uid, cid);
  if (cur.status === 'aborted') return false;
  // Find or seed commander actor in the roster.
  const members = await readMembers(uid, cid);
  const commander = members.actors.find((a) => a.id === COMMANDER_ID);
  if (!commander) return false;
  const w = ensureWorker(state, commander);
  if (w.queue.length > 0 || w.running) return false; // already busy / pending
  const llmPayload = `<msg from="system" to="commander">\n[watchdog] ${reason}\n</msg>`;
  w.queue.push({
    msgId: genId12(),
    fromActorId: 'system',
    llmPayload,
  });
  const wake = w.wake; w.wake = null;
  wake?.();
  log.info(`watchdog ping user=${uid} cid=${cid} reason=${reason}`);
  return true;
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
