/**
 * Turn-end outcome decider (post-G8b).
 *
 * Historically this file was the bus-driven plan DAG runtime. G8b replaced
 * static plans with the commander-in-the-loop model (`dispatch_to` /
 * `run_worker` + handback — see `bus.ts`), so the DAG engine is gone. What
 * remains is the single decision the bus still needs after every turn:
 *
 *   `onTurnFinished(uid, cid, evt)` → `TurnOutcome`
 *      — decide whether the bus should persist a user-visible bubble or stay
 *        silent (and what that bubble carries). No plan state is touched.
 *
 * The former plan-engine exports (`onPlanSet`, `reconcile`,
 * `reconcileAfterStepTransition`, `recordPersistedStepMessage`, `retryStep`,
 * `skipStep`, `continuePlan`, `failInProgressSteps`) survive only as inert
 * no-ops so the bus / ipc / index callers keep compiling; their cross-layer
 * removal happens in the plan-storage teardown stage.
 */

import { t } from '../../i18n';
import type { ChatFormPayload } from './router';
import type { GroupMessageFailureKind } from './visibility';

// ── Public API ───────────────────────────────────────────────────────────

/** Raw signals collected from a worker turn that just ended. The bus
 * captures these as pure I/O, then hands them to `onTurnFinished` which
 * decides whether to persist a user-visible bubble. */
export interface TurnFinishedEvent {
  actor: { id: string; kind: 'commander' | 'agent' };
  finalText: string;
  errText: string | null;
  aborted: boolean;
  /** Structured source supplied by the model/CLI/host mutation path. */
  failureKind?: GroupMessageFailureKind;
  failureCode?: string;
  /** Form extracted by the bus's post-stream parser (agents only). */
  form?: ChatFormPayload;
  /** Lightweight multi-turn marker extracted from agent final text. */
  planInteraction?: 'open' | 'closed';
  /** Files written via local-exec tools during this turn. */
  produced: string[];
  /** Agents created or updated from `<agent>...</agent>` containers
   * (commander only). One entry per successfully applied container. */
  createdAgents?: Array<{ agent_id: string; name: string; kind: 'created' | 'updated' }>;
  /** Skills created or updated from `<skill>...</skill>` containers
   * (commander only). Same shape as `createdAgents` entries. */
  createdSkills?: Array<{ skill_id: string; name: string; kind: 'created' | 'updated' }>;
  /** Number of non-error, non-final, non-done events the LLM stream emitted.
   * Distinguishes "tool-only turn (final empty is normal)" from "config /
   * auth error (the LLM produced literally nothing)". */
  activityEvents: number;
  /** A successful `hand_off_to` already delivered the answer in the target
   * agent's own bubble. An empty commander tail is therefore intentionally
   * silent, not the generic "tool-only commander turn" that needs a process
   * bubble. */
  terminalDelivery?: boolean;
}

/** Outcome of an `onTurnFinished` call. Tells the bus what to do with the
 * actor's output.
 *
 * `kind: 'persist'` — bus enqueues `text` as a normal group message.
 * `kind: 'silent'` — bus does NOT enqueue anything.
 */
export type TurnOutcome = (
  {
      kind: 'persist';
      text: string;
      form?: ChatFormPayload;
      produced?: string[];
      createdAgents?: Array<{ agent_id: string; name: string; kind: 'created' | 'updated' }>;
      createdSkills?: Array<{ skill_id: string; name: string; kind: 'created' | 'updated' }>;
      failureKind?: GroupMessageFailureKind;
      failureCode?: string;
    }
  | { kind: 'silent' }
);

/**
 * Single owner of "what (if anything) the bus should persist after a turn
 * ends". Returns a `TurnOutcome`; the bus executes it. With the plan DAG gone,
 * every turn is a direct turn — handback wake-ups for `run_worker` are owned
 * by the bus, not here.
 */
export async function onTurnFinished(
  _uid: string,
  _cid: string,
  evt: TurnFinishedEvent,
): Promise<TurnOutcome> {
  return outcomeForDirectTurn(evt);
}

/** Decide persist vs silent for a turn.
 *
 * commander empty-final policy: the user is waiting on commander, so silent is
 * normally forbidden — even a tool-only turn must persist an empty bubble
 * carrying the process rail. The exception is a successful terminal delivery:
 * `hand_off_to` has already put the answer in the target agent's bubble, so a
 * second empty commander bubble would be redundant. Real config / auth errors
 * surface as an errorBubble.
 *
 * agent empty-final → always persist '(no reply)'.
 */
function outcomeForDirectTurn(evt: TurnFinishedEvent): TurnOutcome {
  if (evt.aborted) {
    return abortOutcome(evt);
  }
  // Form / created-agent / produced-files are user-visible side effects that
  // must persist regardless of whether finalText is non-empty. Common case:
  // agent emits ONLY an `agent-input-form` block — bus's form extraction
  // strips it, leaving finalText empty; without this check we'd fall to the
  // "agent empty" branch and replace the form with "(no reply)".
  const hasSideEffect = !!evt.form || (!!evt.createdAgents && evt.createdAgents.length > 0) || (!!evt.createdSkills && evt.createdSkills.length > 0) || (evt.produced && evt.produced.length > 0);
  if ((evt.finalText && evt.finalText.trim()) || hasSideEffect) {
    // When the stream errored mid-turn but partial text / side effects
    // already landed, append the error pill instead of dropping the partial.
    const partial = evt.finalText || '';
    const body = evt.errText
      ? (partial ? `${partial}\n\n${errorBubble(evt.errText, evt.failureKind)}` : errorBubble(evt.errText, evt.failureKind))
      : partial;
    return {
      kind: 'persist',
      text: body,
      ...failureFields(evt, !!evt.errText),
      ...(evt.form ? { form: evt.form } : {}),
      ...(evt.produced.length ? { produced: evt.produced } : {}),
      ...(evt.createdAgents && evt.createdAgents.length ? { createdAgents: evt.createdAgents } : {}),
      ...(evt.createdSkills && evt.createdSkills.length ? { createdSkills: evt.createdSkills } : {}),
    };
  }
  // Empty final, no side effects.
  if (evt.actor.kind === 'commander') {
    if (evt.terminalDelivery) return { kind: 'silent' };
    if (!evt.errText) return { kind: 'persist', text: '', ...failureFields(evt) };
    if (evt.errText === 'empty response' && evt.activityEvents > 0) {
      return { kind: 'persist', text: '', ...failureFields(evt) };
    }
    // Real failure (zero-activity empty, or other err).
    return { kind: 'persist', text: errorBubble(evt.errText, evt.failureKind), ...failureFields(evt, true) };
  }
  // agent empty + no side effects.
  if (evt.errText) return { kind: 'persist', text: errorBubble(evt.errText, evt.failureKind), ...failureFields(evt, true) };
  return { kind: 'persist', text: '(no reply)', ...failureFields(evt) };
}

/** Aborted-turn outcome: salvage partial reply + side effects, NO "(stopped)"
 * suffix (bus appends that once). No salvageable content AND no side effect →
 * silent (renderer cleans the placeholder). */
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

function failureFields(
  evt: TurnFinishedEvent,
  defaultModelFailure = false,
): Pick<Extract<TurnOutcome, { kind: 'persist' }>, 'failureKind' | 'failureCode'> {
  const failureKind = evt.failureKind || (defaultModelFailure ? 'model' : undefined);
  if (!failureKind) return {};
  const failureCode = evt.failureCode
    || (failureKind === 'config' ? 'model_preflight' : failureKind === 'model' ? 'model_stream_error' : undefined);
  return { failureKind, ...(failureCode ? { failureCode } : {}) };
}

function errorBubble(msg: string, failureKind?: GroupMessageFailureKind): string {
  let visible: string;
  if (failureKind === 'dependency') {
    visible = normalizeRunError(msg);
  } else if (failureKind && failureKind !== 'model' && failureKind !== 'config') {
    visible = t('agent.run_failed', { message: normalizeRunError(msg) });
  } else {
    visible = t('model.call_failed', { message: normalizeRunError(msg) });
  }
  return `<span style="color:var(--danger)">${escapeHtmlForBubble(visible)}</span>`;
}

function normalizeRunError(msg: string): string {
  return String(msg || '').replace(/^Error:\s*/i, '').replace(/\s+/g, ' ').trim() || 'unknown error';
}

function escapeHtmlForBubble(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
