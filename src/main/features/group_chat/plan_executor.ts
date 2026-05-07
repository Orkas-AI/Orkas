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

import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { COMMANDER_ID, USER_ID, readMembers } from './state';
import {
  readPlan, updateStep, markPlanCompletedSignaled,
  findReadySteps, isPlanTerminal,
  type PlanFile, type PlanStep, type FailurePolicy,
} from './plan';
import type { ChatFormPayload } from './router';

/** Per-cid mutex guarding plan-state transitions. Without this, when N
 * parallel-group agents finish nearly simultaneously, their reconcile
 * paths interleave — each reads the plan, finds the same downstream step
 * ready, and dispatches it. Result: one step gets dispatched N times.
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
 *  IMPORTANT — never include `aborted` or `cancelled` in this pattern:
 *  user-initiated abort must not be silently retried; the literal string
 *  `'aborted by user'` is also explicitly excluded by the guard. */
const TRANSIENT_ERR_PATTERNS = /\b(terminated|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|EPIPE|network error|Connection closed)\b/i;
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
  if (!TRANSIENT_ERR_PATTERNS.test(reason)) return false;
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
  /** Plan-complete synthesis turn — commander wakes after every step
   * terminated, charged with writing a closing summary to user. NO step
   * transitions on this turn. */
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
  /** Files written via local-exec tools during this turn. */
  produced: string[];
  /** Quick-create agent meta extracted from `<agent>...</agent>` (commander
   * only). When present, executor records but doesn't drive on it. */
  createdAgent?: { agent_id: string; name: string };
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
export type TurnOutcome =
  | { kind: 'persist'; text: string; form?: ChatFormPayload; produced?: string[]; createdAgent?: { agent_id: string; name: string } }
  | { kind: 'silent' };

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
   *  but with one extra optional `triggered_step` knob. */
  enqueue(params: {
    uid: string; cid: string;
    fromActorId: string; text: string;
    forceTo?: string[];
    triggered_step?: number;
    dispatch?: boolean;
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
  // concurrent agent finishes (parallel-group fork) don't double-dispatch
  // the same downstream step. The lock spans the entire transition +
  // reconcile chain so reads and writes within one turn-finished call
  // can't interleave with another.
  return _planLock(uid, cid).runExclusive(async () => {
    if (evt.trigger.kind === 'plan_step') {
      const outcome = await applyPlanStepTurn(uid, cid, evt, evt.trigger.step_index);
      await reconcileAfterStepTransition(uid, cid);
      return outcome;
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
  if (evt.errText) {
    return { kind: 'persist', text: errorBubble(evt.errText) };
  }
  if (evt.finalText && evt.finalText.trim()) {
    return {
      kind: 'persist',
      text: evt.finalText,
      ...(evt.produced.length ? { produced: evt.produced } : {}),
    };
  }
  // Empty final on a synth turn = user gets a placeholder so they at least
  // see "the plan finished but I had nothing more to add".
  return { kind: 'persist', text: '（无回复）' };
}

/** User-direct (or non-plan) turn outcome decision.
 *
 * Side effect: if this is an agent reply AND there's a `blocked` plan step
 * whose assignee matches this agent (typical post-form-submit case), the
 * step transitions to `done` and downstream is dispatched. This bridges
 * the gap between "form pause" (step blocked) and "agent re-runs after
 * user submits" (which arrives here as trigger=user_direct since the user
 * enqueue triggered the agent worker, not the executor).
 *
 * commander empty-final policy: user_direct means the user is actively
 * waiting on commander, so silent is forbidden — even a tool-only turn
 * (e.g. only called dispatch_to / kb_search without writing a final)
 * must persist an empty bubble carrying the process rail. Otherwise the
 * user sees nothing after their message lands. Real config / auth errors
 * still surface as an errorBubble.
 *
 * agent empty-final → always persist '（无回复）'.
 */
async function outcomeForUserDirectTurn(uid: string, cid: string, evt: TurnFinishedEvent): Promise<TurnOutcome> {
  // Form-pause unblock: if this agent has a blocked step, treat THIS turn
  // as that step's terminator. Re-route through applyPlanStepTurn so the
  // exact same transition logic applies (success / form-again / failure).
  if (evt.actor.kind === 'agent') {
    const plan = await readPlan(uid, cid);
    if (plan?.steps?.length) {
      const members = await readMembers(uid, cid);
      const blocked = plan.steps.find((s) =>
        s.status === 'blocked' && assigneeMatches(s.assignee, evt.actor.id, members.actors),
      );
      if (blocked) {
        const outcome = await applyPlanStepTurn(uid, cid, evt, blocked.index);
        await reconcileAfterStepTransition(uid, cid);
        return outcome;
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
  // branch below and replace the actor's form with "（无回复）", losing
  // the form widget entirely (the user-reported bug).
  const hasSideEffect = !!evt.form || !!evt.createdAgent || (evt.produced && evt.produced.length > 0);
  if ((evt.finalText && evt.finalText.trim()) || hasSideEffect) {
    return {
      kind: 'persist',
      text: evt.finalText || '',
      ...(evt.form ? { form: evt.form } : {}),
      ...(evt.produced.length ? { produced: evt.produced } : {}),
      ...(evt.createdAgent ? { createdAgent: evt.createdAgent } : {}),
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
  return { kind: 'persist', text: '（无回复）' };
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
  // or remove the placeholder entirely. Avoids the orphan "（已中断）" bubble
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
    if (evt.actor.kind === 'commander') return { kind: 'silent' };
    // agent empty: persist placeholder, mark done so plan can advance.
    await transitionStepDone(uid, cid, step, '', evt.produced, '');
    return { kind: 'persist', text: '（无回复）' };
  }

  // Normal success.
  await transitionStepDone(uid, cid, step, captureOutput(evt.finalText), evt.produced, '');
  return {
    kind: 'persist',
    text: evt.finalText,
    ...(evt.produced.length ? { produced: evt.produced } : {}),
    ...(evt.createdAgent ? { createdAgent: evt.createdAgent } : {}),
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

/** Fired after a step transition to dispatch downstream + check terminal.
 *  Exported so user-driven recovery actions (`retryStep` / `skipStep`) can
 *  reuse the exact same dispatch path the bus uses internally. */
export async function reconcileAfterStepTransition(uid: string, cid: string): Promise<void> {
  const plan = await readPlan(uid, cid);
  if (!plan?.steps?.length) return;
  await dispatchReady(uid, cid, plan);
  const terminalNow = await readPlan(uid, cid);
  if (terminalNow && isPlanTerminal(terminalNow) && !terminalNow.completed_signaled) {
    await firePlanComplete(uid, cid, terminalNow);
  }
}

function errorBubble(msg: string): string {
  return `<span style="color:var(--danger)">${escapeHtmlForBubble(t('model.call_failed', { message: msg }))}</span>`;
}

/** Outcome for an aborted turn. Returns the salvageable content (partial
 * streamed reply + any user-visible side effects), with NO "（已中断）"
 * suffix — bus appends that once, after merging in any staged plan
 * announcement, so the marker always lands at the end regardless of which
 * pieces survived.
 *
 * No salvageable content AND no side effect → silent. The renderer's
 * `turn_silent` handler then either freezes the process rail (tool calls
 * etc.) as a thinking-trail bubble or removes the placeholder entirely.
 * Skipping the persist here is what prevents the orphan "（已中断）" bubble
 * for turns that aborted before producing anything visible.
 */
function abortOutcome(evt: TurnFinishedEvent): TurnOutcome {
  const partial = (evt.finalText || '').trim();
  const hasSideEffect = !!evt.form || !!evt.createdAgent || (evt.produced && evt.produced.length > 0);
  if (!partial && !hasSideEffect) return { kind: 'silent' };
  return {
    kind: 'persist',
    text: evt.finalText || '',
    ...(evt.form ? { form: evt.form } : {}),
    ...(evt.produced && evt.produced.length ? { produced: evt.produced } : {}),
    ...(evt.createdAgent ? { createdAgent: evt.createdAgent } : {}),
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
      return { ok: false, error: `step is not in failed state (current: ${step.status})` };
    }
    await updateStep(uid, cid, stepIndex, 'pending', {
      failure_reason: '',
      output_msg_id: '',
      transient_attempts: 0,
    });
    // Unblock cascade-skipped downstream: when step N failed under
    // `abort_plan` policy, applyTermination marked all not-yet-terminal
    // steps `skipped` with reason `aborted by step N failure`. Retrying
    // step N should also re-arm those cascade victims; users explicitly
    // skipped via the rail's "skip" button keep their reason and are NOT
    // re-armed (their reason is the original failure_reason verbatim).
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
    log.info(`plan-step retry-requested cid=${cid} step=${stepIndex}`);
    _hooks!.emitPlanChanged(uid, cid);
    await reconcileAfterStepTransition(uid, cid);
    return { ok: true };
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
    await reconcileAfterStepTransition(uid, cid);
    return { ok: true };
  });
}

/** Main entry point. Mark the finished step done (if any), then dispatch
 *  every step that's now ready. Re-entrant: dispatching may itself trigger
 *  more reconciles via the enqueue chain; the "find ready + dispatch" loop
 *  is idempotent (a step in `in_progress` won't re-dispatch).
 *
 *  Mutex-serialized per cid — without this, concurrent reconciles (e.g.
 *  three parallel-group agents finishing at the same time) can each see
 *  the same downstream step as `pending` and dispatch it multiple times. */
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

    // 3. Find ready + dispatch (grouped by parallel_group).
    await dispatchReady(uid, cid, updated);

    // 4. If everything terminal and not yet signaled, fire plan-complete to
    //    commander so it can wrap up for user.
    const terminalNow = await readPlan(uid, cid);
    if (terminalNow && isPlanTerminal(terminalNow) && !terminalNow.completed_signaled) {
      await firePlanComplete(uid, cid, terminalNow);
    }
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
    await applyTermination(uid, cid, match, ctx);
  }
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
  // Group by parallel_group; steps without group dispatch solo. Within a
  // group, all steps fire in this same reconcile pass (one DOM tick).
  const groups = new Map<string, PlanStep[]>();
  for (const s of ready) {
    const k = s.parallel_group || `_solo_${s.index}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  for (const [, steps] of groups) {
    for (const step of steps) {
      await dispatchStep(uid, cid, step, plan);
    }
  }
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

  if (USER_ALIASES.has(assignee.toLowerCase())) {
    // Step asks user for input. Commander voice; render goes to user.
    await _hooks.enqueue({
      uid, cid,
      fromActorId: COMMANDER_ID,
      text: rendered,
      forceTo: [USER_ID],
      triggered_step: step.index,
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
  });
}

function assigneeDisplayPrefix(assignee: string): string {
  // The bus's @<id> → @<name> rewrite handles the case where assignee was an
  // id; here we just ensure the message starts with `@<assignee>` so the
  // user sees who got dispatched.
  const stripped = assignee.replace(/^@+/, '').trim();
  return `@${stripped.replace(/\s+/g, '')}`;
}

// ── Plan-complete signal ─────────────────────────────────────────────────

async function firePlanComplete(uid: string, cid: string, plan: PlanFile): Promise<void> {
  if (!_hooks) return;
  await markPlanCompletedSignaled(uid, cid);
  _hooks.emitPlanChanged(uid, cid);
  // Wake commander with a synthesis prompt that has all step outputs in
  // scope. Commander's prompt knows what to do (write user-facing summary).
  // No persisted chat message — only the eventual commander → user reply
  // shows up to the user.
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
    `All plan steps have terminated. Based on each step's output above, write a wrap-up report for the user: deliverables + key process points + suggested follow-up actions (if any). If any step failed, you must honestly tell the user which step failed and why.`,
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
