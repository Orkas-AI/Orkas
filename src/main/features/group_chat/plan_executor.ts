/**
 * Plan executor — bus-driven DAG runtime.
 *
 * Hooks:
 *   - `onPlanSet(uid, cid)` — called right after `plan_set` writes; fires the
 *     first wave of ready steps.
 *   - `reconcile(uid, cid, ctx)` — called after each turn-end (and after each
 *     enqueue). `ctx.finishedStepIndex` lets us mark the just-completed step
 *     `done` when we know which step the worker was running for; otherwise we
 *     fall back to actor-id matching.
 *
 * Invariants:
 *   - Bus owns `status` transitions of every step (LLM never writes status
 *     after `plan_set`). The legacy `plan_update` tool still works for manual
 *     overrides but is no longer the primary path.
 *   - Dispatch is deterministic: rendered template + assignee resolution +
 *     wait_for evaluation all happen here, not in the LLM.
 *   - If a step has no `input` template, dispatch falls back to the legacy
 *     "let commander @-mention manually" path (we just mark in_progress and
 *     let commander's prompt drive). This preserves backward compat with
 *     plans written by older tool calls.
 */

import { Mutex } from 'async-mutex';
import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { isTransientError } from '../../util/transient-errors';
import { COMMANDER_ID, USER_ID, readMembers } from './state';
import {
  readPlan, updateStep, markPlanCompletedSignaled,
  findReadySteps, isPlanTerminal,
  type PlanFile, type PlanStep, type FailurePolicy,
} from './plan';
import type { ChatFormPayload } from './router';
import { buildMention, decodeSubmission } from './router';
import type { GroupMessage } from './visibility';

/** Per-cid mutex guarding plan-state transitions. Without this, when several
 * agent finishes land close together, their reconcile paths interleave —
 * each reads the plan, finds the same downstream step ready, and dispatches
 * it. Result: one step gets dispatched N times.
 * The lock makes "read plan → mark step in_progress → enqueue" atomic
 * w.r.t. peer reconciles for the same cid. Plain `updateStep` from
 * outside reconcile (e.g. `transitionStepDone` invoked manually) is also
 * naturally serialized through the same lock since the caller goes
 * through `reconcile` / `onTurnFinished`. */
const _planMutexes = new Map<string, Mutex>();
function _planLock(uid: string, cid: string): Mutex {
  const k = `${uid}\x00${cid}`;
  let m = _planMutexes.get(k);
  if (!m) { m = new Mutex(); _planMutexes.set(k, m); }
  return m;
}

const log = createLogger('group_chat.plan_executor');

const COMMANDER_ALIASES = new Set(['commander', '指挥官']);
const USER_ALIASES = new Set(['user', '用户']);

/** Plan-level safety net for transient failures. core-agent's runner already
 *  has its own `maxRetries=3` exponential-backoff retry inside a single
 *  stream call; this kicks in only AFTER that bubbles up — i.e. the network
 *  was down long enough that even the inner retries failed. We then fold
 *  the step back to `pending` so reconcile re-dispatches the whole turn
 *  (fresh stream, fresh provider connection). Capped to avoid infinite
 *  loops when the user is just genuinely offline.
 *
 *  Pattern lives in `util/transient-errors.ts` as a shared classifier
 *  — `features/expert_signals/turn_hooks.ts` is the second consumer
 *  (skill_ineffective skips transient-class errors so we don't blame
 *  skills for network blips). Single source of truth for "is this
 *  a network blip" semantics. */
const MAX_TRANSIENT_RETRIES = 2;

/** Returns true when `reason` matches a transient network-error pattern AND
 *  this step still has plan-level retry budget. Caller should bail out
 *  (return early) — we've already flipped the step back to `pending` so the
 *  next reconcile will redispatch. */
async function maybeRetryTransient(
  uid: string, cid: string, step: PlanStep, reason: string,
): Promise<boolean> {
  if (!reason) return false;
  if (reason === 'aborted by user') return false;
  if (!isTransientError(reason)) return false;
  const attempts = step.transient_attempts ?? 0;
  if (attempts >= MAX_TRANSIENT_RETRIES) return false;
  await updateStep(uid, cid, step.index, 'pending', {
    transient_attempts: attempts + 1,
    failure_reason: '',
    output_msg_id: '',
  });
  log.info(`plan-step transient-retry cid=${cid} step=${step.index} attempts=${attempts + 1}/${MAX_TRANSIENT_RETRIES} reason=${reason}`);
  _hooks!.emitPlanChanged(uid, cid);
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Trigger context attached to a worker QueueItem. Identifies which step (if
 * any) caused this turn to run, so `onTurnFinished` can transition the right
 * step without guessing. */
export type TurnTrigger =
  /** Step dispatched by the executor — agent / user-question / commander-self. */
  | { kind: 'plan_step'; step_index: number }
  /** Plan-complete fallback turn — commander wakes after every step
   * terminated only when the executor decides a wrap-up is still needed.
   * NO step transitions on this turn. */
  | { kind: 'plan_synth' }
  /** Default route from user, or any non-plan dispatch (manual @-mention,
   * etc). Won't drive plan transitions. */
  | { kind: 'user_direct' };

/** Raw signals collected from a worker turn that just ended. The bus
 * captures these as pure I/O, then hands them to `onTurnFinished` which
 * owns ALL subsequent decisions (whether to persist a user-visible bubble,
 * which step transition to apply, what to dispatch next). */
export interface TurnFinishedEvent {
  actor: { id: string; kind: 'commander' | 'agent' };
  finalText: string;
  errText: string | null;
  aborted: boolean;
  /** Form extracted by the bus's post-stream parser (agents only). When
   * present, the step pauses (`blocked`) waiting on user form-fill. */
  form?: ChatFormPayload;
  /** Lightweight multi-turn marker extracted from agent final text. `open`
   * pauses the current plan step; `closed` completes it. Missing keeps the
   * default one-shot behavior. */
  planInteraction?: 'open' | 'closed';
  /** Files written via local-exec tools during this turn. */
  produced: string[];
  /** Agents created or updated from `<agent>...</agent>` containers
   * (commander only). One entry per successfully applied container.
   * `kind: 'created'` is the quick-create flow; `kind: 'updated'` means an
   * existing custom agent was patched. Executor records but doesn't drive
   * on it. */
  createdAgents?: Array<{ agent_id: string; name: string; kind: 'created' | 'updated' }>;
  /** Skills created or updated from `<skill>...</skill>` containers
   * (commander only). One entry per successfully applied container.
   * Same shape as `createdAgents` entries; rendered as separate chips. */
  createdSkills?: Array<{ skill_id: string; name: string; kind: 'created' | 'updated' }>;
  /** What kind of trigger caused this turn. Drives the state transition. */
  trigger: TurnTrigger;
  /** Number of non-error, non-final, non-done events the LLM stream emitted.
   * Distinguishes "tool-only turn (final empty is normal)" from "config /
   * auth error (the LLM produced literally nothing)". */
  activityEvents: number;
}

/** Outcome of an `onTurnFinished` call. Tells the bus what to do with the
 * actor's output. The bus shouldn't make these decisions on its own — it
 * just executes what the executor returns.
 *
 * `kind: 'persist'` — bus enqueues `text` as a normal group message. The
 *   executor has already done the appropriate state transition.
 * `kind: 'silent'` — bus does NOT enqueue anything. Executor decided this
 *   turn produces no user-visible output.
 */
export type TurnOutcome = (
  {
      kind: 'persist';
      text: string;
      form?: ChatFormPayload;
      produced?: string[];
      createdAgents?: Array<{ agent_id: string; name: string; kind: 'created' | 'updated' }>;
      createdSkills?: Array<{ skill_id: string; name: string; kind: 'created' | 'updated' }>;
    }
  | { kind: 'silent' }
) & {
  /** Set when this turn transitioned a plan step. Bus uses it to wait until
   * the final chat message is persisted before dispatching downstream work,
   * so live placeholders cannot jump ahead of the message that produced
   * the transition. */
  planTransition?: { step_index: number };
};

export interface ReconcileCtx {
  /** The step whose dispatch this turn was carrying (passed through the
   *  worker's QueueItem). When set, we mark THAT step done (precise). */
  finishedStepIndex?: number;
  /** Fallback: actor id of the worker that just finished. We try to match
   *  any in_progress step whose assignee resolves to this id (less precise
   *  but covers turns dispatched outside the executor — e.g. legacy
   *  @-mention path or manual overrides). */
  finishedActorId?: string;
  /** Latest message from the finished actor; used to capture output_summary
   *  / output_files / output_msg_id on the just-done step. */
  finishedMessage?: {
    id: string;
    text: string;
    files?: string[];
    /** True if the agent's reply was an error / aborted / explicit failure
     *  signal. Drives `on_failure` policy. */
    failed?: boolean;
    failureReason?: string;
    /** True if the agent's reply included a `form` (agent-input-form
     *  fenced block). The step is then NOT done — it's `blocked` waiting
     *  for the user to fill the form. Downstream dispatch is paused until
     *  the agent's next reply (post-form-submit) arrives without a form. */
    hasForm?: boolean;
  };
}

/** Hooks provided by the bus to the executor — kept as an interface so we
 *  don't pull a circular import. Bus implements + injects on init. */
export interface ExecutorBusHooks {
  /** Persist + emit a normal group message; same signature as `bus.enqueue`
   *  but with one extra optional `triggered_step` knob. `attachments` lets
   *  the executor forward the plan's `initial_attachments` so worker agents
   *  receive the same image / file bytes the originating user turn carried. */
  enqueue(params: {
    uid: string; cid: string;
    fromActorId: string; text: string;
    forceTo?: string[];
    triggered_step?: number;
    dispatch?: boolean;
    attachments?: string[];
    form?: ChatFormPayload;
  }): Promise<void>;
  /** Push a turn directly into commander's worker queue without persisting
   *  a chat message — used for the synthesis / commander-self steps where
   *  the trigger is a private bus signal, not a user-visible message. */
  pushCommanderTurn(uid: string, cid: string, payload: {
    llmPayload: string;
    triggered_step: number;
  }): Promise<void>;
  /** Resolve an agent display name (or id) to the canonical agent_id, or
   *  null if no enabled agent matches. */
  resolveAgent(uid: string, nameOrId: string): Promise<string | null>;
  /** Bridge to bus.emit for plan_changed events. */
  emitPlanChanged(uid: string, cid: string): void;
}

let _hooks: ExecutorBusHooks | null = null;
export function bindBusHooks(hooks: ExecutorBusHooks): void {
  _hooks = hooks;
}

/** Called by `plan_set` tool right after it writes the plan. Fires the first
 *  wave of ready steps. */
export async function onPlanSet(uid: string, cid: string): Promise<void> {
  await reconcile(uid, cid);
}

/**
 * Single owner of "what happens after a turn ends" — replaces the old
 * scattered logic across `bus.runTurn` (silent-commander branches,
 * cleanText construction) and `plan_executor.reconcile` (step transition,
 * downstream dispatch). See § A of the lifecycle refactor plan for the
 * full transition table.
 *
 * Returns a `TurnOutcome` telling the bus what (if anything) to persist
 * as a user-visible message. Bus is reduced to pure I/O — it only
 * captures raw signals, calls this, and acts on the returned outcome.
 *
 * Side effects (state transitions, downstream dispatch) happen inside
 * this function via the bus hooks; the caller doesn't have to coordinate.
 */
export async function onTurnFinished(
  uid: string,
  cid: string,
  evt: TurnFinishedEvent,
): Promise<TurnOutcome> {
  if (!_hooks) return { kind: 'silent' };

  // Synthesis turn doesn't touch plan state — fast path, no lock needed.
  if (evt.trigger.kind === 'plan_synth') {
    return outcomeForSynthTurn(evt);
  }

  // All other paths potentially mutate plan state. Serialize per cid so
  // near-simultaneous agent finishes don't race while marking steps done.
  // Downstream dispatch happens later in bus, after the final message has
  // been persisted.
  return _planLock(uid, cid).runExclusive(async () => {
    if (evt.trigger.kind === 'plan_step') {
      const outcome = await applyPlanStepTurn(uid, cid, evt, evt.trigger.step_index);
      return withPlanTransition(outcome, evt.trigger.step_index);
    }
    // user_direct: includes the form-unblock fallback (an agent post-form
    // reply triggers a plan transition through outcomeForUserDirectTurn).
    return await outcomeForUserDirectTurn(uid, cid, evt);
  });
}

/** Plan-complete synthesis turn → MUST produce a user-visible bubble even
 * if LLM came back empty (user is waiting for the closing summary; falling
 * silent strands the conversation). Errors are surfaced. */
function outcomeForSynthTurn(evt: TurnFinishedEvent): TurnOutcome {
  if (evt.aborted) {
    return abortOutcome(evt);
  }
  if (evt.finalText && evt.finalText.trim()) {
    // Keep the partial reply and append the error pill underneath when
    // the stream errored mid-turn — otherwise the user loses everything
    // the model already produced and only sees the error.
    const body = evt.errText
      ? `${evt.finalText}\n\n${errorBubble(evt.errText)}`
      : evt.finalText;
    return {
      kind: 'persist',
      text: body,
      ...(evt.produced.length ? { produced: evt.produced } : {}),
    };
  }
  if (evt.errText) {
    return { kind: 'persist', text: errorBubble(evt.errText) };
  }
  // Empty final on a synth turn = user gets a placeholder so they at least
  // see "the plan finished but I had nothing more to add".
  return { kind: 'persist', text: '(no reply)' };
}

/** User-direct (or non-plan) turn outcome decision.
 *
 * Side effect: if this is an agent reply AND there's an active plan step
 * whose assignee matches this agent, the step transitions through the normal
 * plan-step completion path and downstream is dispatched. This covers both
 * form-unblock replies (`blocked`) and commander/manual recovery dispatches
 * that do not carry a `triggered_step` stamp (`in_progress`).
 *
 * commander empty-final policy: user_direct means the user is actively
 * waiting on commander, so silent is forbidden — even a tool-only turn
 * (e.g. only called dispatch_to / kb_search without writing a final)
 * must persist an empty bubble carrying the process rail. Otherwise the
 * user sees nothing after their message lands. Real config / auth errors
 * still surface as an errorBubble.
 *
 * agent empty-final → always persist '(no reply)'.
 */
async function outcomeForUserDirectTurn(uid: string, cid: string, evt: TurnFinishedEvent): Promise<TurnOutcome> {
  if (evt.actor.kind === 'agent') {
    const plan = await readPlan(uid, cid);
    if (plan?.steps?.length) {
      const members = await readMembers(uid, cid);
      const active = plan.steps.find((s) =>
        (s.status === 'in_progress' || s.status === 'blocked')
        && assigneeMatches(s.assignee, evt.actor.id, members.actors),
      );
      if (active) {
        const outcome = await applyPlanStepTurn(uid, cid, evt, active.index);
        return withPlanTransition(outcome, active.index);
      }
    }
  }

  if (evt.aborted) {
    return abortOutcome(evt);
  }
  // Form / created-agent / produced-files are user-visible side effects
  // that must persist regardless of whether finalText is non-empty. Common
  // case: agent emits ONLY an `agent-input-form` fenced block — bus's
  // form extraction strips the block, leaving finalText empty. Without
  // checking these signals first we'd fall through to the "agent empty"
  // branch below and replace the actor's form with "(no reply)", losing
  // the form widget entirely (the user-reported bug).
  const hasSideEffect = !!evt.form || (!!evt.createdAgents && evt.createdAgents.length > 0) || (!!evt.createdSkills && evt.createdSkills.length > 0) || (evt.produced && evt.produced.length > 0);
  if ((evt.finalText && evt.finalText.trim()) || hasSideEffect) {
    // When the stream errored mid-turn but partial text / side effects
    // already landed, append the error pill instead of dropping the
    // partial — same intent as outcomeForSynthTurn's branch above.
    const partial = evt.finalText || '';
    const body = evt.errText
      ? (partial ? `${partial}\n\n${errorBubble(evt.errText)}` : errorBubble(evt.errText))
      : partial;
    return {
      kind: 'persist',
      text: body,
      ...(evt.form ? { form: evt.form } : {}),
      ...(evt.produced.length ? { produced: evt.produced } : {}),
      ...(evt.createdAgents && evt.createdAgents.length ? { createdAgents: evt.createdAgents } : {}),
      ...(evt.createdSkills && evt.createdSkills.length ? { createdSkills: evt.createdSkills } : {}),
    };
  }
  // Empty final, no side effects.
  if (evt.actor.kind === 'commander') {
    // User pinged commander → must respond. Empty bubble still carries
    // the process rail (tool calls, dispatch_to progress) attached by bus.
    if (!evt.errText) return { kind: 'persist', text: '' };
    if (evt.errText === 'empty response' && evt.activityEvents > 0) {
      return { kind: 'persist', text: '' };
    }
    // Real failure (zero-activity empty, or other err).
    return { kind: 'persist', text: errorBubble(evt.errText) };
  }
  // agent empty + no side effects.
  if (evt.errText) return { kind: 'persist', text: errorBubble(evt.errText) };
  return { kind: 'persist', text: '(no reply)' };
}

function withPlanTransition(outcome: TurnOutcome, stepIndex: number): TurnOutcome {
  return {
    ...outcome,
    planTransition: { step_index: stepIndex },
  };
}

/** Plan-step turn — apply state transition + return outcome for bus. */
async function applyPlanStepTurn(
  uid: string, cid: string, evt: TurnFinishedEvent, stepIndex: number,
): Promise<TurnOutcome> {
  const plan = await readPlan(uid, cid);
  const step = plan?.steps.find((s) => s.index === stepIndex);
  if (!plan || !step) {
    // Plan vanished mid-turn (rare: user deleted conv). Just persist what we have.
    return outcomeForUserDirectTurn(uid, cid, evt);
  }

  // Aborted: mark step failed + decide whether the bubble is worth showing.
  // Salvage whatever streamed before the user hit stop (evt.finalText holds
  // the partial reply bus accumulated from delta events); if there's nothing
  // to salvage AND no side effect, go silent so the renderer's turn_silent
  // handler can either freeze the process rail as a "thinking trail" bubble
  // or remove the placeholder entirely. Avoids the orphan "(stopped)" bubble
  // for turns that aborted before producing anything visible.
  if (evt.aborted) {
    await transitionStepFailed(uid, cid, step, 'aborted by user', '');
    return abortOutcome(evt);
  }

  // Real error (not the spurious "empty response").
  if (evt.errText && !(evt.errText === 'empty response' && evt.activityEvents > 0)) {
    await transitionStepFailed(uid, cid, step, evt.errText, '');
    // continue policy → persist nothing (sweep silently)
    if ((step.on_failure || 'ask_commander') === 'continue') {
      return { kind: 'silent' };
    }
    return { kind: 'persist', text: errorBubble(evt.errText) };
  }

  // Form pause: agent asked user for input → step blocked, no downstream
  // until user submits.
  if (evt.form) {
    await updateStep(uid, cid, step.index, 'blocked', {
      output_msg_id: '', // bus fills after enqueue; OK to leave empty here
    });
    _hooks!.emitPlanChanged(uid, cid);
    log.info(`plan-step blocked (form awaiting user) cid=${cid} step=${step.index}`);
    return {
      kind: 'persist',
      text: evt.finalText || '',
      form: evt.form,
      ...(evt.produced.length ? { produced: evt.produced } : {}),
    };
  }

  // Natural-language interaction pause: an interactive agent wants to keep
  // talking with the user before the plan step completes. Unlike forms,
  // there is no form payload; the blocked step itself makes the renderer
  // route the next user reply back to this agent.
  if (evt.planInteraction === 'open') {
    await updateStep(uid, cid, step.index, 'blocked', {
      output_msg_id: '',
    });
    _hooks!.emitPlanChanged(uid, cid);
    log.info(`plan-step blocked (agent interaction open) cid=${cid} step=${step.index}`);
    return {
      kind: 'persist',
      text: evt.finalText || '',
      ...(evt.produced.length ? { produced: evt.produced } : {}),
      ...(evt.createdAgents && evt.createdAgents.length ? { createdAgents: evt.createdAgents } : {}),
      ...(evt.createdSkills && evt.createdSkills.length ? { createdSkills: evt.createdSkills } : {}),
    };
  }

  // Spurious-empty tool-only turn (commander finished plan_set, etc.).
  if (
    evt.actor.kind === 'commander'
    && (!evt.finalText || !evt.finalText.trim())
    && evt.errText === 'empty response'
    && evt.activityEvents > 0
  ) {
    // Don't transition the step — commander didn't really "do" the step's
    // work, the tool side-effects did. But practically: step's status was
    // set to in_progress on dispatch and now needs to flip. Mark done with
    // empty summary.
    await transitionStepDone(uid, cid, step, '', evt.produced, '');
    return { kind: 'silent' };
  }

  // Empty final without form / err → silent + don't transition. (Rare;
  // legitimate "thinking but nothing produced" — keeps step in_progress.)
  if (!evt.finalText || !evt.finalText.trim()) {
    if (evt.planInteraction === 'closed') {
      await transitionStepDone(uid, cid, step, '', evt.produced, '');
      return { kind: 'silent' };
    }
    if (evt.actor.kind === 'commander') return { kind: 'silent' };
    // agent empty: persist placeholder, mark done so plan can advance.
    await transitionStepDone(uid, cid, step, '', evt.produced, '');
    return { kind: 'persist', text: '(no reply)' };
  }

  // Normal success.
  await transitionStepDone(uid, cid, step, captureOutput(evt.finalText), evt.produced, '');
  return {
    kind: 'persist',
    text: evt.finalText,
    ...(evt.produced.length ? { produced: evt.produced } : {}),
    ...(evt.createdAgents && evt.createdAgents.length ? { createdAgents: evt.createdAgents } : {}),
    ...(evt.createdSkills && evt.createdSkills.length ? { createdSkills: evt.createdSkills } : {}),
  };
}

async function transitionStepDone(
  uid: string, cid: string, step: PlanStep, summary: string, files: string[], outputMsgId: string,
): Promise<void> {
  await updateStep(uid, cid, step.index, 'done', {
    output_summary: summary,
    output_files: files,
    output_msg_id: outputMsgId,
    transient_attempts: 0,
  });
  _hooks!.emitPlanChanged(uid, cid);
  log.info(`plan-step done cid=${cid} step=${step.index} assignee=${step.assignee}`);
}

async function transitionStepFailed(
  uid: string, cid: string, step: PlanStep, reason: string, outputMsgId: string,
): Promise<void> {
  if (await maybeRetryTransient(uid, cid, step, reason)) return;
  const policy: FailurePolicy = step.on_failure || 'ask_commander';
  if (policy === 'continue') {
    await updateStep(uid, cid, step.index, 'skipped', {
      failure_reason: reason,
      output_msg_id: outputMsgId,
    });
    log.info(`plan-step skipped (continue policy) cid=${cid} step=${step.index} reason=${reason}`);
  } else if (policy === 'abort_plan') {
    await updateStep(uid, cid, step.index, 'failed', {
      failure_reason: reason,
      output_msg_id: outputMsgId,
    });
    const fresh = await readPlan(uid, cid);
    if (fresh) {
      for (const s of fresh.steps) {
        if (s.status === 'pending' || s.status === 'in_progress' || s.status === 'blocked') {
          await updateStep(uid, cid, s.index, 'skipped', {
            failure_reason: `aborted by step ${step.index} failure`,
          });
        }
      }
    }
    log.info(`plan-step failed (abort_plan) cid=${cid} step=${step.index}`);
  } else {
    await updateStep(uid, cid, step.index, 'failed', {
      failure_reason: reason,
      output_msg_id: outputMsgId,
    });
    log.info(`plan-step failed (ask_commander) cid=${cid} step=${step.index}`);
  }
  _hooks!.emitPlanChanged(uid, cid);
}

/** Backfill the persisted chat message id for the step that produced it.
 * `onTurnFinished` runs before bus has enqueued the final message, so the
 * state transition can only write an empty `output_msg_id`. Bus calls this
 * after enqueue returns with the real message id. */
export async function recordPersistedStepMessage(
  uid: string,
  cid: string,
  stepIndex: number,
  msg: { id: string; text?: string; files?: string[] },
): Promise<void> {
  if (!msg.id || !Number.isFinite(stepIndex) || stepIndex <= 0) return;
  await _planLock(uid, cid).runExclusive(async () => {
    const plan = await readPlan(uid, cid);
    const step = plan?.steps.find((s) => s.index === stepIndex);
    if (!step) return;

    const patch: {
      output_summary?: string;
      output_files?: string[];
      output_msg_id?: string;
    } = {};
    if (step.output_msg_id !== msg.id) patch.output_msg_id = msg.id;
    if (!step.output_summary && msg.text) patch.output_summary = captureOutput(msg.text);
    if ((!step.output_files || step.output_files.length === 0) && msg.files?.length) {
      patch.output_files = msg.files;
    }
    if (!Object.keys(patch).length) return;

    await updateStep(uid, cid, step.index, step.status, patch);
    _hooks?.emitPlanChanged(uid, cid);
  });
}

/** Fired after a step transition to dispatch downstream + check terminal.
 *  Exported so user-driven recovery actions (`retryStep` / `skipStep`) can
 *  reuse the exact same dispatch path the bus uses internally. */
export async function reconcileAfterStepTransition(uid: string, cid: string): Promise<void> {
  if (!_hooks) return;
  return _planLock(uid, cid).runExclusive(async () => {
    await reconcileAfterStepTransitionNoLock(uid, cid);
  });
}

async function reconcileAfterStepTransitionNoLock(uid: string, cid: string): Promise<void> {
  const plan = await readPlan(uid, cid);
  if (!plan?.steps?.length) return;
  await dispatchReady(uid, cid, plan);
  const terminalNow = await readPlan(uid, cid);
  await handlePlanTerminal(uid, cid, terminalNow);
}

function errorBubble(msg: string): string {
  return `<span style="color:var(--danger)">${escapeHtmlForBubble(t('model.call_failed', { message: msg }))}</span>`;
}

/** Outcome for an aborted turn. Returns the salvageable content (partial
 * streamed reply + any user-visible side effects), with NO "(stopped)"
 * suffix — bus appends that once, after merging in any staged plan
 * announcement, so the marker always lands at the end regardless of which
 * pieces survived.
 *
 * No salvageable content AND no side effect → silent. The renderer's
 * `turn_silent` handler then either freezes the process rail (tool calls
 * etc.) as a thinking-trail bubble or removes the placeholder entirely.
 * Skipping the persist here is what prevents the orphan "(stopped)" bubble
 * for turns that aborted before producing anything visible.
 */
function abortOutcome(evt: TurnFinishedEvent): TurnOutcome {
  const partial = (evt.finalText || '').trim();
  const hasSideEffect = !!evt.form || (!!evt.createdAgents && evt.createdAgents.length > 0) || (!!evt.createdSkills && evt.createdSkills.length > 0) || (evt.produced && evt.produced.length > 0);
  if (!partial && !hasSideEffect) return { kind: 'silent' };
  return {
    kind: 'persist',
    text: evt.finalText || '',
    ...(evt.form ? { form: evt.form } : {}),
    ...(evt.produced && evt.produced.length ? { produced: evt.produced } : {}),
    ...(evt.createdAgents && evt.createdAgents.length ? { createdAgents: evt.createdAgents } : {}),
    ...(evt.createdSkills && evt.createdSkills.length ? { createdSkills: evt.createdSkills } : {}),
  };
}

function escapeHtmlForBubble(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** User-initiated recovery for a `failed` step. Sets the step back to
 *  `pending`, clears `failure_reason` and resets `transient_attempts`,
 *  then unblocks any downstream steps that were cascade-skipped specifically
 *  because of THIS step's failure (under `abort_plan` policy). Finally calls
 *  the same `reconcileAfterStepTransition` the bus uses internally so
 *  redispatch goes through one path.
 *
 *  IMPORTANT — never enqueues directly. The single dispatch primitive remains
 *  `bus.enqueue`, and we reach it only via `reconcileAfterStepTransition →
 *  dispatchReady → enqueue`. */
export async function retryStep(
  uid: string, cid: string, stepIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!_hooks) return { ok: false, error: 'executor not bound' };
  return _planLock(uid, cid).runExclusive(async () => {
    const plan = await readPlan(uid, cid);
    if (!plan) return { ok: false, error: 'no plan' };
    const step = plan.steps.find((s) => s.index === stepIndex);
    if (!step) return { ok: false, error: 'step not found' };
    if (step.status !== 'failed') {
      // The UI can issue a duplicate retry from stale DOM while the first
      // retry has already re-armed the step (failed -> pending -> dispatch
      // -> in_progress / blocked-on-deps). Treat those mid-recovery states
      // as success so users do not see a false failure after recovery
      // started.
      //
      // `done` is intentionally NOT in this set: by the time a step
      // reaches `done`, the rail has already re-rendered with a hidden
      // retry button (`_isStepActionable` in plan-rail.js returns
      // `failed`-only), so there is no DOM path that produces a retry
      // click on a done step. Accepting it here would also fire a retry
      // expert-signal with the completed turn's output_msg_id, attributing
      // user dissatisfaction to a successful execution — see PC/CLAUDE.md
      // §10 expert-signals turn_id convention.
      if (
        step.status === 'pending'
        || step.status === 'in_progress'
        || step.status === 'blocked'
      ) {
        log.info(`plan-step retry-noop cid=${cid} step=${stepIndex} current=${step.status}`);
        return { ok: true };
      }
      return { ok: false, error: `step is not in failed state (current: ${step.status})` };
    }
    await rearmFailedStepNoLock(uid, cid, stepIndex);
    log.info(`plan-step retry-requested cid=${cid} step=${stepIndex}`);
    _hooks!.emitPlanChanged(uid, cid);
    await reconcileAfterStepTransitionNoLock(uid, cid);
    return { ok: true };
  });
}

async function rearmFailedStepNoLock(uid: string, cid: string, stepIndex: number): Promise<void> {
  await updateStep(uid, cid, stepIndex, 'pending', {
    failure_reason: '',
    output_msg_id: '',
    transient_attempts: 0,
    pending_form_id: '',
  });
  // Unblock cascade-skipped downstream: when step N failed under
  // `abort_plan` policy, applyTermination marked all not-yet-terminal
  // steps `skipped` with reason `aborted by step N failure`. Retrying
  // step N should also re-arm those cascade victims; users explicitly
  // skipped via the rail's old "skip" button keep their reason and are
  // NOT re-armed (their reason is the original failure_reason verbatim).
  const cascadeReason = `aborted by step ${stepIndex} failure`;
  const fresh = await readPlan(uid, cid);
  if (fresh) {
    for (const s of fresh.steps) {
      if (s.status === 'skipped' && s.failure_reason === cascadeReason) {
        await updateStep(uid, cid, s.index, 'pending', {
          failure_reason: '',
        });
      }
    }
  }
}

/** Plan-level continue action used by the unified rail control. The UI no
 * longer targets individual steps; the executor picks the first recoverable
 * failed step and runs the same retry/reconcile path. If an old run left an
 * `in_progress` step behind with no active worker, collapse it to `failed`
 * first so the state shown to users stays simple: failed → continue. */
export async function continuePlan(
  uid: string, cid: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!_hooks) return { ok: false, error: 'executor not bound' };
  return _planLock(uid, cid).runExclusive(async () => {
    let plan = await readPlan(uid, cid);
    if (!plan) return { ok: false, error: 'no plan' };

    for (const step of plan.steps) {
      if (step.status === 'in_progress') {
        await updateStep(uid, cid, step.index, 'failed', {
          failure_reason: 'execution interrupted',
          output_msg_id: '',
        });
      }
    }

    plan = await readPlan(uid, cid);
    if (!plan) return { ok: false, error: 'no plan' };
    const failed = plan.steps.find((s) => s.status === 'failed');
    if (failed) {
      await rearmFailedStepNoLock(uid, cid, failed.index);
      log.info(`plan-continue retrying cid=${cid} step=${failed.index}`);
      _hooks!.emitPlanChanged(uid, cid);
      await reconcileAfterStepTransitionNoLock(uid, cid);
      return { ok: true };
    }

    const ready = findReadySteps(plan);
    if (ready.length) {
      log.info(`plan-continue reconciling ready steps cid=${cid} ready=${ready.map((s) => s.index).join(',')}`);
      await reconcileAfterStepTransitionNoLock(uid, cid);
      return { ok: true };
    }

    return { ok: false, error: 'no failed step to continue' };
  });
}

/** Best-effort cleanup after a user stop or stale-process sweep. */
export async function failInProgressSteps(
  uid: string, cid: string, reason = 'execution interrupted',
): Promise<number> {
  if (!_hooks) return 0;
  return _planLock(uid, cid).runExclusive(async () => {
    const plan = await readPlan(uid, cid);
    if (!plan) return 0;
    let changed = 0;
    for (const step of plan.steps) {
      if (step.status === 'in_progress') {
        await updateStep(uid, cid, step.index, 'failed', {
          failure_reason: reason,
          output_msg_id: '',
        });
        changed += 1;
      }
    }
    if (changed) {
      log.info(`plan marked in_progress failed cid=${cid} count=${changed} reason=${reason}`);
      _hooks!.emitPlanChanged(uid, cid);
    }
    return changed;
  });
}

/** User-initiated skip for a `failed` step. Marks it `skipped` while keeping
 *  `failure_reason` (so the rail can still show why). Downstream that wasn't
 *  in cascade now becomes ready (skipped is treated as terminal in
 *  `findReadySteps`). Cascade-victims of THIS step keep their `skipped`
 *  state — the user opted not to retry, downstream cascade stays. */
export async function skipStep(
  uid: string, cid: string, stepIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!_hooks) return { ok: false, error: 'executor not bound' };
  return _planLock(uid, cid).runExclusive(async () => {
    const plan = await readPlan(uid, cid);
    if (!plan) return { ok: false, error: 'no plan' };
    const step = plan.steps.find((s) => s.index === stepIndex);
    if (!step) return { ok: false, error: 'step not found' };
    if (step.status !== 'failed') {
      return { ok: false, error: `step is not in failed state (current: ${step.status})` };
    }
    await updateStep(uid, cid, stepIndex, 'skipped', {
      transient_attempts: 0,
    });
    log.info(`plan-step skip-requested cid=${cid} step=${stepIndex}`);
    _hooks!.emitPlanChanged(uid, cid);
    await reconcileAfterStepTransitionNoLock(uid, cid);
    return { ok: true };
  });
}

/** Main entry point. Mark the finished step done (if any), then dispatch
 *  one step that's now ready. Re-entrant: dispatching may itself trigger
 *  more reconciles via the enqueue chain; the "find ready + dispatch" loop
 *  is idempotent (a step in `in_progress` won't re-dispatch).
 *
 *  Mutex-serialized per cid — without this, concurrent reconciles can each
 *  see the same downstream step as `pending` and dispatch it multiple times. */
export async function reconcile(uid: string, cid: string, ctx: ReconcileCtx = {}): Promise<void> {
  if (!_hooks) return;
  return _planLock(uid, cid).runExclusive(async () => {
    const plan = await readPlan(uid, cid);
    if (!plan?.steps?.length) return;

    // 1. Mark just-finished step.
    await maybeMarkFinished(uid, cid, plan, ctx);

    // 2. Re-read after potential mutation. Subsequent ready-check uses fresh state.
    const updated = await readPlan(uid, cid);
    if (!updated) return;

    // 3. Find ready + dispatch one step.
    await dispatchReady(uid, cid, updated);

    // 4. If everything is terminal, mark the plan handled. Only fire an
    //    extra commander wrap-up when the finished plan still needs one.
    const terminalNow = await readPlan(uid, cid);
    await handlePlanTerminal(uid, cid, terminalNow);
  });
}

// ── Step-finished marking ────────────────────────────────────────────────

async function maybeMarkFinished(uid: string, cid: string, plan: PlanFile, ctx: ReconcileCtx): Promise<void> {
  // Precise path: turn carried a step index in its QueueItem.
  if (typeof ctx.finishedStepIndex === 'number') {
    const step = plan.steps.find((s) => s.index === ctx.finishedStepIndex);
    // Accept both `in_progress` (initial dispatch) and `blocked` (agent's
    // post-form-submit reply, where the step was paused waiting on user).
    if (!step || (step.status !== 'in_progress' && step.status !== 'blocked')) return;
    await applyTermination(uid, cid, step, ctx);
    return;
  }
  // Fallback: actor-id match. User-form-submit triggers the agent again
  // without a `triggered_step` (the message originates from user, not the
  // executor), so we land here. Match either `in_progress` (legacy / mixed
  // mode) or `blocked` (form-pause waiting on this very agent).
  if (ctx.finishedActorId) {
    const actorId = ctx.finishedActorId;
    const members = await readMembers(uid, cid);
    const match = plan.steps.find((s) =>
      (s.status === 'in_progress' || s.status === 'blocked')
      && assigneeMatches(s.assignee, actorId, members.actors),
    );
    if (!match) return;
    if (actorId === USER_ID && !await acceptsUserStepCompletion(uid, cid, match, ctx)) return;
    await applyTermination(uid, cid, match, ctx);
  }
}

async function acceptsUserStepCompletion(
  _uid: string,
  cid: string,
  step: PlanStep,
  ctx: ReconcileCtx,
): Promise<boolean> {
  // Legacy conversations + plans authored before the stamp existed have no
  // `pending_form_id`. Accept any user reply for those (the original
  // behaviour before user-owned forms were introduced).
  const expectedFormId = step.pending_form_id;
  if (!expectedFormId) return true;

  const text = ctx.finishedMessage?.text || '';
  const submission = decodeSubmission(text);
  if (!submission || submission.agent_id !== USER_ID || submission.form_id !== expectedFormId) {
    log.info(`plan-user-step ignored non-matching user message cid=${cid} step=${step.index} expected_form=${expectedFormId}`);
    return false;
  }
  return true;
}

async function applyTermination(
  uid: string, cid: string, step: PlanStep, ctx: ReconcileCtx,
): Promise<void> {
  const failed = !!ctx.finishedMessage?.failed;
  const hasForm = !!ctx.finishedMessage?.hasForm;
  // Form pause: agent emitted a fenced `agent-input-form` block. The step
  // is NOT done — it's awaiting user fill. Mark `blocked`; do NOT dispatch
  // downstream. When user submits the form, bus enqueues a new agent turn
  // that (per the prompt) does the actual work without re-emitting a form;
  // that turn-end will land here again with `hasForm=false` and we flip
  // the step to `done`, unblocking downstream.
  if (hasForm && !failed) {
    await updateStep(uid, cid, step.index, 'blocked', {
      output_msg_id: ctx.finishedMessage?.id,
    });
    log.info(`plan-step blocked (form awaiting user) cid=${cid} step=${step.index}`);
    _hooks!.emitPlanChanged(uid, cid);
    return;
  }
  if (failed) {
    const reason = ctx.finishedMessage?.failureReason || '(unknown)';
    if (await maybeRetryTransient(uid, cid, step, reason)) return;
    const policy: FailurePolicy = step.on_failure || 'ask_commander';
    if (policy === 'continue') {
      await updateStep(uid, cid, step.index, 'skipped', {
        failure_reason: reason,
        output_msg_id: ctx.finishedMessage?.id,
      });
      log.info(`plan-step skipped (continue policy) cid=${cid} step=${step.index} reason=${reason}`);
    } else if (policy === 'abort_plan') {
      await updateStep(uid, cid, step.index, 'failed', {
        failure_reason: reason,
        output_msg_id: ctx.finishedMessage?.id,
      });
      // Mark all not-yet-terminal steps skipped so the plan doesn't keep firing.
      const fresh = await readPlan(uid, cid);
      if (fresh) {
        for (const s of fresh.steps) {
          if (s.status === 'pending' || s.status === 'in_progress' || s.status === 'blocked') {
            await updateStep(uid, cid, s.index, 'skipped', {
              failure_reason: `aborted by step ${step.index} failure`,
            });
          }
        }
      }
      log.info(`plan-step failed (abort_plan) cid=${cid} step=${step.index}`);
    } else {
      // ask_commander: leave in failed state; commander wakes via shadow tap or next user message.
      await updateStep(uid, cid, step.index, 'failed', {
        failure_reason: reason,
        output_msg_id: ctx.finishedMessage?.id,
      });
      log.info(`plan-step failed (ask_commander) cid=${cid} step=${step.index}`);
    }
  } else {
    await updateStep(uid, cid, step.index, 'done', {
      transient_attempts: 0,
      output_summary: captureOutput(ctx.finishedMessage?.text || ''),
      output_files: ctx.finishedMessage?.files || [],
      output_msg_id: ctx.finishedMessage?.id,
    });
    log.info(`plan-step done cid=${cid} step=${step.index} assignee=${step.assignee}`);
  }
  _hooks!.emitPlanChanged(uid, cid);
}

function captureOutput(text: string): string {
  // First non-empty line, trimmed to ~200 chars. Good enough for downstream
  // {{step_N.output_summary}} substitution; if commander wants more it can
  // reference output_msg_id.
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const firstPara = trimmed.split(/\n{2,}/)[0] || trimmed;
  return firstPara.length > 200 ? firstPara.slice(0, 197) + '...' : firstPara;
}

// ── Ready-step dispatch ──────────────────────────────────────────────────

async function dispatchReady(uid: string, cid: string, plan: PlanFile): Promise<void> {
  const ready = findReadySteps(plan);
  if (!ready.length) return;
  // Parallel step execution is disabled: dispatch only the earliest ready
  // step. If several steps are ready (including legacy plans with
  // `parallel_group` or multiple `wait_for: []` entries), later steps run
  // after the current one finishes and reconciliation runs again.
  const step = ready.slice().sort((a, b) => a.index - b.index)[0];
  // Expert-signals: emit one `agent_dispatched` signal BEFORE
  // wakening — we want the audit record even if the enqueue downstream
  // throws. turn_id is synthesized; see expert-signals plan §4.3.
  // Best-effort.
  try {
    const { emitSignal } = await import('../expert_signals');
    const { buildAgentDispatchedSignal } = await import('../expert_signals/extractors/event');
    const assignees = step.assignee ? [step.assignee] : [];
    emitSignal(uid, buildAgentDispatchedSignal({
      cid,
      turn_id: `${cid}:plan:dispatch:${Date.now()}:0`,
      candidates: assignees.slice(),
      dispatched: assignees.slice(),
      parallel_group: null,
    }));
  } catch (err) {
    log.warn(`agent_dispatched emit failed cid=${cid}: ${(err as Error).message}`);
  }
  await dispatchStep(uid, cid, step, plan);
}

async function dispatchStep(
  uid: string, cid: string, step: PlanStep, plan: PlanFile,
): Promise<void> {
  if (!_hooks) return;
  // Mark in_progress FIRST so a re-entrant reconcile (triggered by the
  // enqueue we're about to do) doesn't double-dispatch.
  await updateStep(uid, cid, step.index, 'in_progress');
  _hooks.emitPlanChanged(uid, cid);

  // No input template → legacy mode: skip auto-dispatch, let commander pick
  // up the in_progress signal in its next turn and dispatch via @-mention.
  if (!step.input || !step.input.trim()) {
    log.info(`plan-step in_progress (legacy, no input template) cid=${cid} step=${step.index} assignee=${step.assignee}`);
    return;
  }

  const rendered = renderTemplate(step.input, plan);
  const assignee = step.assignee.trim();
  // Forward attachments captured at plan-set time so worker agents (and
  // the user, for a `user`-assignee question) receive the same image / file
  // bytes the triggering user turn carried — see PlanFile.initial_attachments.
  const inheritedAttachments = plan.initial_attachments;

  if (USER_ALIASES.has(assignee.toLowerCase())) {
    // Step asks user for input. Commander voice; render goes to user with
    // a user-owned form so the reply can route back to the plan machinery
    // without waking commander as an extra side conversation.
    //
    // Stamp `pending_form_id` on the step BEFORE enqueueing so the user's
    // reply can be matched in O(1) inside the reconcile mutex (see
    // `acceptsUserStepCompletion`) — without this, that gate would have to
    // scan the whole <cid>.jsonl to recover the mapping, with the linear
    // scan happening inside `_planLock`.
    const form = buildUserStepForm(step);
    await updateStep(uid, cid, step.index, 'in_progress', { pending_form_id: form.form_id });
    await _hooks.enqueue({
      uid, cid,
      fromActorId: COMMANDER_ID,
      text: rendered,
      forceTo: [USER_ID],
      triggered_step: step.index,
      ...(inheritedAttachments && inheritedAttachments.length ? { attachments: inheritedAttachments } : {}),
      form,
    });
    return;
  }

  if (COMMANDER_ALIASES.has(assignee.toLowerCase())) {
    // Synthesis / decision step. Wake commander privately — no chat message
    // is persisted; commander's reply (if any) becomes the visible output.
    await _hooks.pushCommanderTurn(uid, cid, {
      llmPayload: composePlanTriggerPayload(rendered, step, plan),
      triggered_step: step.index,
    });
    return;
  }

  // Agent. Resolve name → id; if unresolved, mark step failed and let
  // reconcile handle the policy.
  const agentId = await _hooks.resolveAgent(uid, assignee);
  if (!agentId) {
    await updateStep(uid, cid, step.index, 'failed', {
      failure_reason: `assignee "${assignee}" did not resolve to any enabled agent`,
    });
    _hooks.emitPlanChanged(uid, cid);
    log.warn(`plan-step failed (assignee unresolved) cid=${cid} step=${step.index} assignee=${assignee}`);
    // Keep going: a subsequent reconcile may sweep with on_failure policy.
    return;
  }
  // Dispatch from commander voice with `@<name>` prefix so the agent's
  // visibility slice carries identical wording to a manual commander
  // dispatch (router handles the rest). `dispatch: true` keeps the message
  // off the user view — the plan announcement already covered the user's
  // need to see who's working on what. `triggered_step` ensures the
  // recipient's turn-end marks the right step done.
  const displayName = assigneeDisplayPrefix(assignee);
  await _hooks.enqueue({
    uid, cid,
    fromActorId: COMMANDER_ID,
    text: `${displayName} ${rendered}`,
    forceTo: [agentId],
    triggered_step: step.index,
    dispatch: true,
    ...(inheritedAttachments && inheritedAttachments.length ? { attachments: inheritedAttachments } : {}),
  });
}

function assigneeDisplayPrefix(assignee: string): string {
  // The bus's @<id> → @<name> rewrite handles the case where assignee was an
  // id; here we just ensure the message starts with `@<assignee>` so the
  // user sees who got dispatched. `buildMention` preserves whitespace (see
  // its header).
  return buildMention(assignee.replace(/^@+/, ''));
}

function buildUserStepForm(step: PlanStep): ChatFormPayload {
  const label = step.title.trim() || (step.input || '').trim() || 'response';
  return {
    form_id: crypto.randomBytes(8).toString('hex'),
    agent_id: USER_ID,
    plan_step_index: step.index,
    fields: [{
      id: 'response',
      label,
      type: 'textarea',
      required: true,
      default: '',
    }],
    submitted: false,
  };
}

// ── Plan-complete fallback ────────────────────────────────────────────────

async function handlePlanTerminal(uid: string, cid: string, plan: PlanFile | null): Promise<void> {
  if (!_hooks || !plan?.steps?.length) return;
  if (!isPlanTerminal(plan) || plan.completed_signaled) return;

  await markPlanCompletedSignaled(uid, cid);
  _hooks.emitPlanChanged(uid, cid);

  if (!needsPlanCompleteFallback(plan)) {
    log.info(`plan-complete handled silently cid=${cid} steps=${plan.steps.length}`);
    return;
  }

  await firePlanComplete(uid, cid, plan);
}

function needsPlanCompleteFallback(plan: PlanFile): boolean {
  if (plan.steps.some((s) => s.status === 'failed' || s.status === 'skipped')) return true;
  const last = plan.steps[plan.steps.length - 1];
  if (!last?.output_msg_id && !last?.output_summary && !(last?.output_files && last.output_files.length)) return true;
  return userExplicitlyAskedForWrapUp(plan.initial_message || '');
}

function userExplicitlyAskedForWrapUp(text: string): boolean {
  const src = String(text || '').trim();
  if (!src) return false;
  return /(?:最后|最终|最后由|最终由).{0,12}(?:总结|汇总|收尾|报告)/i.test(src)
    || /(?:总结|汇总|收尾).{0,12}(?:所有|全部|整体|最终|最后|各.{0,4}结果|交付|成果)/i.test(src)
    || /\b(?:final|overall|wrap[-\s]?up|closing)\s+(?:summary|report|synthesis)\b/i.test(src)
    || /\b(?:summari[sz]e|synthesis)\s+(?:everything|all|the\s+results|the\s+deliverables)\b/i.test(src);
}

async function firePlanComplete(uid: string, cid: string, plan: PlanFile): Promise<void> {
  if (!_hooks) return;
  // Wake commander with a compact fallback prompt. This is no longer the
  // normal completion path; regular plans should put any desired synthesis
  // in an explicit commander step.
  const summary = plan.steps.map((s) =>
    `[Step ${s.index} | ${s.title} | ${s.assignee} | ${s.status}]${s.output_summary ? ` ${s.output_summary}` : ''}${s.output_files?.length ? ` files: ${s.output_files.join(', ')}` : ''}`,
  ).join('\n');
  const payload = [
    `<plan-complete>`,
    `Initial user message: ${plan.initial_message ?? '(not captured)'}`,
    ``,
    `Step results:`,
    summary,
    ``,
    `The plan has terminated and still needs a user-facing wrap-up because there was a failure/skipped step, no visible final output, or the user explicitly asked for a final synthesis. Write a concise wrap-up. If any step failed or was skipped, state which step and why.`,
    `</plan-complete>`,
  ].join('\n');
  await _hooks.pushCommanderTurn(uid, cid, {
    llmPayload: payload,
    triggered_step: -1, // synthetic; reconcile won't try to mark a step done
  });
  log.info(`plan-complete fired cid=${cid} steps=${plan.steps.length} done=${plan.steps.filter(s=>s.status==='done').length} failed=${plan.steps.filter(s=>s.status==='failed').length} skipped=${plan.steps.filter(s=>s.status==='skipped').length}`);
}

function composePlanTriggerPayload(rendered: string, step: PlanStep, plan: PlanFile): string {
  // Build a compact context block so commander's session sees exactly what
  // changed since last turn. Avoids leaking full plan JSON; uses the same
  // format as `formatPlanForPrompt` for consistency.
  const lines: string[] = [];
  lines.push(`<plan-step index="${step.index}" title="${step.title}" assignee="${step.assignee}">`);
  lines.push(rendered);
  lines.push(`</plan-step>`);
  return lines.join('\n');
}

// ── Template rendering ───────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}/g;

export function renderTemplate(tpl: string, plan: PlanFile): string {
  return tpl.replace(VAR_RE, (full, name: string) => {
    const v = lookupVar(name, plan);
    return v ?? full;  // unresolved → leave literal so debug is visible
  });
}

function lookupVar(name: string, plan: PlanFile): string | null {
  if (name === 'user_initial_message') return plan.initial_message ?? '';
  // step_N.output_summary | step_N.output_files
  const m = /^step_(\d+)\.(output_summary|output_files|title|assignee|status)$/.exec(name);
  if (m) {
    const idx = parseInt(m[1], 10);
    const field = m[2];
    const step = plan.steps.find((s) => s.index === idx);
    if (!step) return null;
    if (field === 'output_summary') return step.output_summary ?? '';
    if (field === 'output_files') return (step.output_files ?? []).join(', ');
    if (field === 'title') return step.title;
    if (field === 'assignee') return step.assignee;
    if (field === 'status') return step.status;
  }
  return null;
}

// ── Assignee resolution helpers ──────────────────────────────────────────

function assigneeMatches(
  assignee: string,
  actorId: string,
  members: Array<{ id: string; name?: string; kind: string }>,
): boolean {
  const a = assignee.trim().toLowerCase();
  if (USER_ALIASES.has(a)) return actorId === USER_ID;
  if (COMMANDER_ALIASES.has(a)) return actorId === COMMANDER_ID;
  // Direct id match.
  if (assignee.trim() === actorId) return true;
  // Name match against member roster.
  const m = members.find((x) => x.id === actorId);
  if (m?.name) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    if (norm(m.name) === norm(assignee)) return true;
  }
  return false;
}
