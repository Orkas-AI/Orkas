/**
 * Group-chat facade — IPC layer talks only to this module.
 *
 * Responsibilities:
 *   - Send a user message (router @ + bus enqueue + UI event stream)
 *   - Subscribe to event stream (single async generator IPC handler)
 *   - List members / read plan / mark form submitted
 *   - Abort group + drop on conv delete
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  conversationLayout,
  conversationMessageFile,
  conversationMessageReadFile,
} from '../../util/project-layout';
import { readJsonl, rewriteJsonlLine, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { logErrorRef } from '../../util/log-redact';

import {
  COMMANDER_ID, USER_ID, readMembers, readState, seedReservedActors, purgeGroupDir,
  setCodingProjectDir, setStatus, actorSessionId,
} from './state';
import { isPlaceholderTitle } from './conv_title';
import {
  abort as busAbort, dropConv as busDropConv, enqueue, subscribe, isQuiescent, runtimeSnapshot,
  type GroupEvent,
} from './bus';

/** Re-export so the IPC layer can poll the bus's true quiescent state on
 *  every state_changed event — the on-disk state.json briefly shows 'idle'
 *  in the microtask gap between turns; the bus's in-memory queues are the
 *  authoritative source. */
export const busIsQuiescent = isQuiescent;

export async function runtimeStatus(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<{ processing: boolean; processing_since: string | null; in_flight: string[]; active_turns: Array<{ actor: string; turn_id: string; msg_id?: string; started_at_ms: number }>; active_recipient?: string }> {
  if (!safeId(cid)) return { processing: false, processing_since: null, in_flight: [], active_turns: [] };
  try {
    const state = await readState(userId, cid, projectIdHint);
    const runtime = runtimeSnapshot(userId, cid);
    const diskInFlight = Array.isArray(state.in_flight)
      ? state.in_flight.filter(Boolean)
      : [];
    // The conversation floor — included so a renderer reload / recovery poll
    // restores the composer target (the agent the commander handed off to)
    // instead of dropping back to the commander until the next state_changed.
    const floor = state.active_recipient ? { active_recipient: state.active_recipient } : {};
    if ((state.status === 'running' || diskInFlight.length > 0) && !runtime.processing) {
      log.warn(`healing orphan running state user=${userId} cid=${cid} status=${state.status} in_flight=${diskInFlight.join(',')}`);
      await setStatus(userId, cid, 'idle');
      return { processing: false, processing_since: null, in_flight: [], active_turns: [], ...floor };
    }
    const inFlight = Array.from(new Set([
      ...diskInFlight,
      ...runtime.inFlight,
    ].filter(Boolean)));
    const processing = state.status === 'running' || inFlight.length > 0 || runtime.processing;
    return {
      processing,
      processing_since: processing ? (state.last_active_at || null) : null,
      in_flight: inFlight,
      active_turns: runtime.activeTurns,
      ...floor,
    };
  } catch {
    return { processing: false, processing_since: null, in_flight: [], active_turns: [] };
  }
}

/** Re-export so the IPC layer can subscribe to the bus BEFORE calling
 *  send(). enqueue wakes the recipient worker synchronously, which then
 *  starts emitting events on the same microtask cycle as send's return —
 *  if subscribe runs after send, those first events are lost. */
export const subscribeBus = subscribe;

import type { ChatUseSelection, ChatMessageReference, GroupMessage } from './visibility';
import {
  type ChatFormPayload, encodeSubmission, buildMention,
} from './router';
import type { MarketplaceInstallRequest } from './visibility';
import * as marketplace from '../marketplace';

const log = createLogger('group_chat.facade');

function mainJsonlFile(uid: string, cid: string): string {
  return conversationMessageFile(uid, cid);
}

// ── Send (from human) ────────────────────────────────────────────────────

export interface SendInput {
  userId: string;
  cid: string;
  text: string;
  model_text?: string;
  attachments?: string[];
  use_selections?: ChatUseSelection[];
  references?: Array<{ source_cid: string; source_msg_id: string }>;
}

async function _resolveMessageReferences(
  userId: string,
  requested: SendInput['references'],
): Promise<ChatMessageReference[]> {
  const inputs = Array.isArray(requested) ? requested.slice(0, 20) : [];
  if (!inputs.length) return [];
  const chats = await import('../chats');
  const attachmentsFeature = await import('../chat_attachments');
  const rowsByCid = new Map<string, GroupMessage[]>();
  const titleByCid = new Map<string, string>();
  const namesByCid = new Map<string, Map<string, string>>();
  const out: ChatMessageReference[] = [];
  const seen = new Set<string>();
  let remainingChars = 40_000;
  let remainingFiles = 40;

  const loadSource = async (sourceCid: string): Promise<GroupMessage[]> => {
    if (rowsByCid.has(sourceCid)) return rowsByCid.get(sourceCid) || [];
    const conv = await chats.getConversation(userId, sourceCid);
    if (!conv) {
      rowsByCid.set(sourceCid, []);
      return [];
    }
    const rows = await readJsonl<GroupMessage>(conversationMessageReadFile(userId, sourceCid), 100_000);
    rowsByCid.set(sourceCid, rows);
    titleByCid.set(sourceCid, conv.title || sourceCid);
    try {
      const members = await readMembers(userId, sourceCid);
      namesByCid.set(sourceCid, new Map(members.actors.map((actor) => [actor.id, actor.name || actor.id])));
    } catch { namesByCid.set(sourceCid, new Map()); }
    return rows;
  };

  const attachmentNames = (
    stored: ChatMessageReference['attachments'] | undefined,
    source: GroupMessage | undefined,
  ): string[] => {
    const fromSnapshot = Array.isArray(stored)
      ? stored.map((item) => typeof item === 'string' ? item : item?.name)
      : [];
    const fromSource = Array.isArray(source?.attachments) ? source.attachments : [];
    return Array.from(new Set([...fromSnapshot, ...fromSource]
      .filter((name): name is string => typeof name === 'string' && !!name.trim())));
  };

  const pushReference = async (
    ref: ChatMessageReference,
    authoritativeSource?: GroupMessage,
  ): Promise<void> => {
    if (out.length >= 20 || remainingChars <= 0) return;
    const sourceCid = ref.source_cid;
    const sourceMsgId = ref.source_msg_id;
    if (!safeId(sourceCid) || !safeId(sourceMsgId)) return;
    const identity = `${sourceCid}:${sourceMsgId}`;
    if (seen.has(identity)) return;
    seen.add(identity);

    const text = String(ref.text || authoritativeSource?.text || '')
      .slice(0, Math.min(12_000, remainingChars));
    const resolvedAttachments: NonNullable<ChatMessageReference['attachments']> = [];
    for (const name of attachmentNames(ref.attachments, authoritativeSource)) {
      if (remainingFiles <= 0) break;
      const resolved = attachmentsFeature.resolveAttachmentAbsPath(userId, sourceCid, name);
      resolvedAttachments.push({
        name,
        ...(resolved.ok ? { kind: resolved.kind } : {}),
      });
      remainingFiles -= 1;
    }
    const produced = (Array.isArray(ref.produced) ? ref.produced : authoritativeSource?.produced || [])
      .slice(0, Math.max(0, remainingFiles));
    remainingFiles -= produced.length;
    if (!text.trim() && !resolvedAttachments.length && !produced.length) return;
    remainingChars -= text.length;
    const { attachments: _storedAttachments, produced: _storedProduced, ...base } = ref;
    out.push({
      ...base,
      text,
      ...(resolvedAttachments.length ? { attachments: resolvedAttachments } : {}),
      ...(produced.length ? { produced } : {}),
    });
  };

  for (const item of inputs) {
    if (out.length >= 20 || remainingChars <= 0) break;
    const sourceCid = typeof item?.source_cid === 'string' ? item.source_cid : '';
    const sourceMsgId = typeof item?.source_msg_id === 'string' ? item.source_msg_id : '';
    if (!safeId(sourceCid) || !safeId(sourceMsgId)) continue;
    const source = (await loadSource(sourceCid)).find((msg) => msg.id === sourceMsgId);
    if (!source || source.deleted_at || source.dispatch || !source.text?.trim()) continue;
    // The renderer localizes the reserved user/commander labels. Persist only
    // real member display names here so snapshots stay locale-independent.
    const fromName = source.from === USER_ID
      ? ''
      : namesByCid.get(sourceCid)?.get(source.from);
    await pushReference({
      source_cid: sourceCid,
      source_title: titleByCid.get(sourceCid) || sourceCid,
      source_msg_id: sourceMsgId,
      from_actor: source.from,
      ...(fromName ? { from_name: fromName } : {}),
      source_ts: source.ts,
      text: source.text,
    }, source);

    // A referenced message may itself contain a flat reference bundle.
    // Expand that bundle one level into the destination, rehydrate any
    // attachment locators from their original conversations, and dedupe by
    // source cid/message id. Since every newly-written bundle is already
    // flat, one expansion level also prevents cycles and recursive growth.
    for (const nested of source.references || []) {
      if (out.length >= 20 || remainingChars <= 0) break;
      if (!safeId(nested.source_cid) || !safeId(nested.source_msg_id)) continue;
      const nestedSource = (await loadSource(nested.source_cid))
        .find((msg) => msg.id === nested.source_msg_id && !msg.deleted_at && !msg.dispatch);
      await pushReference(nested, nestedSource);
    }
  }
  return out;
}

export async function send(
  input: SendInput,
): Promise<{ ok: boolean; msg?: GroupMessage; error?: string }> {
  const { userId, cid, text, model_text, attachments, use_selections, references } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  await seedReservedActors(userId, cid);
  // Auto-title: the first real user message in a fresh / unnamed
  // conversation overwrites the placeholder title so the sidebar item
  // becomes scannable. Lazy-imported to avoid a chats↔group_chat circular.
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    if (conv && !conv.title_manually_set && isPlaceholderTitle(conv.title)) {
      await chats.updateConversation(
        userId,
        cid,
        { title: chats.autoTitle(text) },
        conv.project_id || null,
      );
    }
  } catch (err) {
    log.warn(`auto-title failed user=${userId} cid=${cid}: ${(err as Error).message}`);
  }
  try {
    const resolvedReferences = await _resolveMessageReferences(userId, references);
    const msg = await enqueue({
      uid: userId, cid,
      fromActorId: USER_ID,
      text,
      ...(model_text && model_text.trim() ? { model_text } : {}),
      ...(attachments && attachments.length ? { attachments: [...attachments] } : {}),
      ...(use_selections && use_selections.length ? { use_selections } : {}),
      ...(resolvedReferences.length ? { references: resolvedReferences } : {}),
    });
    return { ok: true, msg };
  } catch (err) {
    log.error(`send failed user=${userId} cid=${cid}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export type FailedTurnRetryMode = 'resume' | 'restart';

export interface RetryFailedTurnInput {
  userId: string;
  cid: string;
  failedMessageId: string;
  /** Short localized text rendered in the user's bubble (for example,
   * "Continue"). The model receives host-owned text below. */
  visibleText: string;
}

export interface ResolvedFailedTurnRetry {
  mode: FailedTurnRetryMode;
  enqueue: Parameters<typeof enqueue>[0];
}

const RETRY_RESUME_MODEL_TEXT = [
  '<task-retry mode="resume">',
  'Continue the unfinished task from the durable state in this same session.',
  'Read the authoritative execution plan, completed-work ledger, prior tool results, and history resources before acting.',
  'Do not repeat work already verified as successful. If an external, paid, destructive, or otherwise non-idempotent operation was interrupted with an uncertain outcome, verify its current state before deciding whether to run it again.',
  'Respect every existing confirmation and permission gate. Complete the remaining work or report the smallest blocker that still requires the user.',
  '</task-retry>',
].join('\n');

function _processHasCompletedOrStartedTool(msg: GroupMessage): boolean {
  return (msg.process || []).some((item) => {
    const event = item && typeof item === 'object' && 'event' in item ? item.event : undefined;
    if (!event || event.stream !== 'tool') return false;
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {};
    return /^(?:start|running|request|call|begin|end|result)$/.test(String(data.phase || data.status || '').toLowerCase());
  });
}

/** Resolve one failed-bubble retry without mutating conversation state. The
 * main process owns this decision so the renderer cannot guess from localized
 * text or stale DOM. */
export async function resolveFailedTurnRetry(
  input: RetryFailedTurnInput,
): Promise<{ ok: true; value: ResolvedFailedTurnRetry } | { ok: false; error: string }> {
  const { userId, cid, failedMessageId } = input;
  const visibleText = String(input.visibleText || '').trim();
  if (!safeId(cid) || !safeId(failedMessageId)) return { ok: false, error: 'invalid retry target' };
  if (!visibleText) return { ok: false, error: 'empty retry message' };

  const rows = await readJsonl<GroupMessage>(mainJsonlFile(userId, cid), 100_000);
  const failedIndex = rows.findIndex((row) => row.id === failedMessageId && !row.deleted_at);
  if (failedIndex < 0) return { ok: false, error: 'failed message not found' };
  const failed = rows[failedIndex];
  if (!failed.from || failed.from === USER_ID || failed.dispatch) {
    return { ok: false, error: 'retry target is not an assistant reply' };
  }
  if (!failed.failure_kind && !failed.failure_code) {
    return { ok: false, error: 'retry target is not a failed assistant reply' };
  }

  let sourceIndex = failedIndex - 1;
  while (sourceIndex >= 0) {
    const row = rows[sourceIndex];
    if (!row.deleted_at && !row.dispatch && row.from === USER_ID && String(row.text || '').trim()) break;
    sourceIndex -= 1;
  }
  if (sourceIndex < 0) return { ok: false, error: 'retry source message not found' };
  const source = rows[sourceIndex];

  await seedReservedActors(userId, cid);
  const members = await readMembers(userId, cid);
  const actor = members.actors.find((item) => item.id === failed.from);
  if (!actor || actor.kind === 'user' || actor.kind === 'worker') {
    return { ok: false, error: 'retry actor is unavailable' };
  }

  let context: {
    activeTurn?: { id: number };
    completedTurns?: Array<{ id: number }>;
    executionPlan?: { updatedTurnId: number; objectiveTurnId: number };
    completedWork?: Array<{ turnId: number }>;
    resources?: Array<{ sourceTurnId?: number }>;
  } | null = null;
  try {
    const { getSession } = await import('../../model/core-agent/session-store');
    context = (await getSession(actorSessionId(cid, actor))).getSerializedContextState();
  } catch (err) {
    log.warn('retry context inspection failed', { error: logErrorRef(err) });
  }

  const activeTurnId = context?.activeTurn?.id;
  const latestCompletedTurnId = context?.completedTurns?.length
    ? context.completedTurns[context.completedTurns.length - 1]?.id
    : undefined;
  const attemptTurnId = activeTurnId || latestCompletedTurnId;
  const planBelongsToAttempt = !!context?.executionPlan && !!attemptTurnId
    && (
      context.executionPlan.updatedTurnId === attemptTurnId
      || context.executionPlan.objectiveTurnId === attemptTurnId
      || !!activeTurnId
    );
  const completedWorkBelongsToAttempt = !!attemptTurnId
    && (context?.completedWork || []).some((entry) => entry.turnId === attemptTurnId);
  const resourceBelongsToAttempt = !!attemptTurnId
    && (context?.resources || []).some((resource) => resource.sourceTurnId === attemptTurnId);
  const attemptRows = rows.slice(sourceIndex + 1, failedIndex + 1);
  // Actor sessions only expose their latest active/completed turn. If the
  // user or this actor has produced a newer visible turn after the selected
  // failure, that latest session state cannot be proven to belong to the old
  // bubble. Restart the old authoritative request instead of attaching it to
  // unrelated newer work.
  const newerAttemptExists = rows.slice(failedIndex + 1).some((row) =>
    !row.deleted_at
    && !row.dispatch
    && (row.from === USER_ID || row.from === failed.from),
  );
  const hasProduced = attemptRows.some((row) => Array.isArray(row.produced) && row.produced.length > 0);
  const hasToolState = attemptRows.some(_processHasCompletedOrStartedTool);
  const hasDurableState = !!activeTurnId
    || planBelongsToAttempt
    || completedWorkBelongsToAttempt
    || resourceBelongsToAttempt
    || hasProduced
    || hasToolState;
  // Configuration/dependency failures normally happen before the runner
  // starts. A stale plan from an older turn must not turn those into a false
  // resume; concrete state from this attempt still wins if it exists.
  const failedBeforeExecution = /^(?:config|dependency)$/.test(String(failed.failure_kind || ''))
    && !activeTurnId && !hasProduced && !hasToolState;
  const mode: FailedTurnRetryMode = hasDurableState && !failedBeforeExecution && !newerAttemptExists
    ? 'resume'
    : 'restart';
  const originalModelText = String(source.model_text || source.text || '');

  return {
    ok: true,
    value: {
      mode,
      enqueue: {
        uid: userId,
        cid,
        fromActorId: USER_ID,
        text: visibleText,
        model_text: mode === 'resume'
          ? `${RETRY_RESUME_MODEL_TEXT}\n\nOriginal user request (quoted for objective continuity):\n${JSON.stringify(originalModelText)}`
          : originalModelText,
        forceTo: [actor.id],
        ...(mode === 'resume' ? { resumeActiveTurn: true } : {}),
        ...(source.use_selections?.length ? { use_selections: source.use_selections.slice() } : {}),
        ...(mode === 'restart' && source.attachments?.length ? { attachments: source.attachments.slice() } : {}),
        ...(mode === 'restart' && source.references?.length ? { references: source.references.slice() } : {}),
      },
    },
  };
}

export async function retryFailedTurn(
  input: RetryFailedTurnInput,
): Promise<{ ok: boolean; mode?: FailedTurnRetryMode; msg?: GroupMessage; error?: string }> {
  try {
    const resolved = await resolveFailedTurnRetry(input);
    if (!resolved.ok) return resolved;
    const msg = await enqueue(resolved.value.enqueue);
    return { ok: true, mode: resolved.value.mode, msg };
  } catch (err) {
    log.error('failed-turn retry failed', { error: logErrorRef(err) });
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

// ── Abort + drop ─────────────────────────────────────────────────────────

export async function abort(userId: string, cid: string): Promise<{ ok: boolean }> {
  await busAbort(userId, cid);
  return { ok: true };
}

export async function dropConv(userId: string, cid: string): Promise<void> {
  await busDropConv(userId, cid);
  await purgeGroupDir(userId, cid);
}

// ── Members + plan ───────────────────────────────────────────────────────

export async function listMembers(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
) {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid', actors: [] };
  await seedReservedActors(userId, cid, projectIdHint);
  const m = await readMembers(userId, cid, projectIdHint);
  // Enrich agent actors with the current `interactive` flag so the renderer
  // can decide on its own whether to auto-target the input box at this agent
  // when its plan step goes in_progress. Read from the live agent file each
  // call (no caching) — agents.ts maintains its own list cache so the read
  // is cheap, and "interactive follows the agent's current spec" is the
  // contract.
  const agentsFeat = await import('../agents');
  const enriched = await Promise.all(m.actors.map(async (a) => {
    if (a.kind !== 'agent') return a;
    try {
      const ag = await agentsFeat.getAgent(a.id);
      return ag && ag.interactive === true ? { ...a, interactive: true } : a;
    } catch {
      return a;
    }
  }));
  return { ok: true, actors: enriched };
}

// ── Streaming events ─────────────────────────────────────────────────────

export async function* streamEvents(
  userId: string, cid: string, opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<GroupEvent | { type: 'done' }, void, unknown> {
  if (!safeId(cid)) {
    yield { type: 'done' };
    return;
  }

  // Subscribe FIRST — before any await — so events fired during the seed
  // (or any concurrent enqueue / worker activity) get buffered, not lost.
  // The earlier "await seedReservedActors → subscribe" order had a window
  // where the recipient worker could wake on the same microtask cycle as
  // a `groupChat.send(...)` caller and emit state_changed / process events
  // before the listener was attached.
  const buf: GroupEvent[] = [];
  let wake: (() => void) | null = null;
  let cancelled = false;

  const unsub = subscribe(userId, cid, (ev) => {
    buf.push(ev);
    const w = wake; wake = null; w?.();
  });

  const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) cancelled = true;
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Seed reserved actors AFTER subscribing — idempotent if `groupChat.send`
  // already ran it; safe if not (keeps `streamEvents` usable as a
  // standalone subscription channel from `groupChat.events` IPC).
  try { await seedReservedActors(userId, cid); }
  catch (err) { log.warn(`seed actors failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  try {
    while (!cancelled) {
      while (buf.length) {
        yield buf.shift()!;
      }
      if (cancelled) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    try { unsub(); } catch { /* ignore */ }
    if (opts.abortSignal) opts.abortSignal.removeEventListener?.('abort', onAbort);
    yield { type: 'done' };
  }
}

// ── Form submission ──────────────────────────────────────────────────────

export interface MarkFormSubmittedInput {
  userId: string; cid: string; msgId: string;
  formId: string;
  values: Record<string, unknown>;
}

/**
 * Mutate the message that owns this form (main jsonl + the agent's
 * visibility slice) to mark it submitted. Does **not** enqueue a follow-up
 * user→agent message — the renderer is responsible for replaying the
 * encoded submission through the normal send-stream pipeline so the UI
 * gets a user bubble + subscribes to the agent's reply stream. Doing both
 * here would either dispatch silently (no renderer subscription = lost
 * events) or double-enqueue (if renderer also sends).
 *
 * Returns the encoded submission text and the recipient actor id so the
 * renderer can fire the send without re-encoding client-side. Agent-owned
 * forms route back to that agent; user-owned plan forms route to `@user`
 * so the executor can close the user step without waking commander.
 */
export async function markFormSubmittedAndDispatch(
  input: MarkFormSubmittedInput,
): Promise<{ ok: boolean; error?: string; submission?: { text: string; agent_id: string } }> {
  const { userId, cid, msgId, formId, values } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  if (!target.form || target.form.form_id !== formId) return { ok: false, error: 'form id mismatch' };

  const agentId = target.form.agent_id;
  const updated: ChatFormPayload = {
    ...target.form,
    submitted: true,
    values,
    submitted_at: nowIso(),
  };

  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId) return null;
    return { ...rec, form: updated };
  });
  if (r.ok === false) {
    log.warn(`form mark failed user=${userId} cid=${cid} msgId=${msgId}: ${r.error}`);
    return { ok: false, error: r.error };
  }
  log.info(`form-submitted user=${userId} cid=${cid} msgId=${msgId} agent=${agentId} fields=${target.form.fields.length}`);

  // Expert-signals hook (plan §5 mount #4): one form_left_blank signal per
  // field the user didn't touch (kept blank OR kept default). Fire-and-
  // forget; failures never block the form submission.
  (async () => {
    try {
      const { emitSignal } = await import('../expert_signals');
      const { buildFormLeftBlankSignals } = await import('../expert_signals/extractors/event');
      const signals = buildFormLeftBlankSignals({
        cid, aid: agentId, turn_id: msgId, msg_id: msgId,
        fields: target.form.fields as any,
        values: (values || {}) as Record<string, unknown>,
      });
      for (const sig of signals) emitSignal(userId, sig);
    } catch (err) {
      log.warn(`expert-signals form_left_blank emit failed cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
    }
  })();

  // Coding-agent contract: when a `project_dir` field is present in the
  // submitted form for an external claude / codex agent, persist it to
  // conv state so `_runCliAgentTurn` can spawn the CLI inside that
  // directory. Other form values stay only in the message log — the
  // agent extracts them from the encoded submission text.
  try {
    const projDir = values && typeof (values as any).project_dir === 'string'
      ? String((values as any).project_dir).trim()
      : '';
    if (projDir) {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgent(agentId);
      const cli = ag?.runtime?.kind === 'cli' ? ag.runtime.cli : '';
      if (agentsFeat.cliIsCodingAgent(cli)) {
        const prev = await readState(userId, cid);
        const oldDir = prev.coding_project_dir || '';
        await setCodingProjectDir(userId, cid, projDir, { explicit: true });
        if (oldDir && oldDir !== projDir) {
          // cwd is about to change — claude code's sessions are cwd-keyed,
          // so the existing binding would fail with "No conversation
          // found" on resume. Drop it; next dispatch starts a fresh CLI
          // session and bridges the prior visible transcript once so the
          // user-visible conversation continues seamlessly.
          const cliSessions = await import('../local_agents/sessions');
          await cliSessions.clearForConversation(userId, cid);
          log.info(`coding cwd changed (form) user=${userId} cid=${cid} ${oldDir} → ${projDir} — cleared cli sessions`);
        } else {
          log.info(`coding project_dir set (explicit) user=${userId} cid=${cid} agent=${agentId} dir=${projDir}`);
        }
      }
    }
  } catch (err) {
    log.warn(`form-submit project_dir hook failed: ${(err as Error).message}`);
  }

  const sliceFile = conversationLayout(userId, cid).visibilityFile(agentId);
  if (fs.existsSync(sliceFile)) {
    const slice = await readJsonl<GroupMessage>(sliceFile, 100_000);
    const sIdx = slice.findIndex((m) => m.id === msgId);
    if (sIdx >= 0) {
      await rewriteJsonlLine<GroupMessage>(sliceFile, sIdx, (rec) => {
        if (!rec || rec.id !== msgId) return null;
        return { ...rec, form: updated };
      });
    }
  }

  const encoded = encodeSubmission(
    { form_id: formId, agent_id: agentId, fields: target.form.fields },
    values,
  );
  // `buildMention` keeps the display name verbatim (whitespace included);
  // falling back to the id keeps the dispatch working if the agent was
  // renamed/disabled between form emit and submit. User-owned plan forms
  // deliberately keep `@user`: it is stripped from persisted text while
  // routing the replay to the user actor, which lets plan reconciliation
  // consume the answer without starting a commander turn.
  let mention = buildMention(agentId);
  if (agentId !== USER_ID) {
    try {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgent(agentId);
      if (ag && ag.name) mention = buildMention(ag.name);
    } catch (err) {
      log.warn(`form-submit name lookup failed agent=${agentId}: ${(err as Error).message}`);
    }
  }
  // Newline (not space) between the @-mention and the bullet list so the
  // markdown renderer treats them as a paragraph followed by a list. With a
  // space, the leading `- ` of the first bullet sits inline with the mention
  // and gets parsed as a hyphen in prose, dropping the first field out of
  // the list and leaving subsequent bullets visually orphaned.
  return { ok: true, submission: { text: `${mention}\n${encoded}`, agent_id: agentId } };
}

// ── Marketplace install confirmation ────────────────────────────────────

export interface ResolveMarketplaceInstallRequestInput {
  userId: string;
  cid: string;
  msgId: string;
  requestId: string;
  decision: 'install' | 'skip';
}

function _xmlAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _marketplaceResultSummary(req: MarketplaceInstallRequest, status: 'installed' | 'skipped' | 'failed', error?: string): string {
  const name = req.name || req.id;
  const kind = req.kind === 'skill'
    ? t('marketplace_install_result.kind_skill')
    : t('marketplace_install_result.kind_agent');
  if (status === 'installed') {
    return t('marketplace_install_result.installed', { kind, name });
  }
  if (status === 'skipped') {
    return t('marketplace_install_result.skipped', { kind, name });
  }
  return t('marketplace_install_result.failed', { kind, name, error: error || 'unknown error' });
}

function _encodeMarketplaceInstallResult(
  req: MarketplaceInstallRequest,
  status: 'installed' | 'skipped' | 'failed',
  error?: string,
): string {
  const payload = {
    request_id: req.request_id,
    kind: req.kind,
    id: req.id,
    name: req.name,
    version: req.version,
    published_at: req.published_at,
    ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
    status,
    ...(error ? { error } : {}),
  };
  const json = JSON.stringify(payload, null, 2)
    .replace(/<\/marketplace-install-result/gi, '<\\/marketplace-install-result');
  return [
    _marketplaceResultSummary(req, status, error),
    `<marketplace-install-result request_id="${_xmlAttr(req.request_id)}" kind="${_xmlAttr(req.kind)}" id="${_xmlAttr(req.id)}" status="${_xmlAttr(status)}">`,
    json,
    '</marketplace-install-result>',
  ].join('\n');
}

async function _rewriteMarketplaceRequestInFile(
  file: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<void> {
  if (!fs.existsSync(file)) return;
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  const idx = rows.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const reqIdx = rec.marketplace_requests.findIndex((r) => r.request_id === requestId);
    if (reqIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    nextReqs[reqIdx] = { ...nextReqs[reqIdx], ...patch };
    return { ...rec, marketplace_requests: nextReqs };
  });
}

async function _patchMarketplaceRequest(
  userId: string,
  cid: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<{ ok: true; request: MarketplaceInstallRequest; message: GroupMessage } | { ok: false; error: string }> {
  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  const requests = Array.isArray(target.marketplace_requests) ? target.marketplace_requests : [];
  const reqIdx = requests.findIndex((r) => r.request_id === requestId);
  if (reqIdx < 0) return { ok: false, error: 'request not found' };

  let updatedReq: MarketplaceInstallRequest | null = null;
  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const currentIdx = rec.marketplace_requests.findIndex((x) => x.request_id === requestId);
    if (currentIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    updatedReq = { ...nextReqs[currentIdx], ...patch };
    nextReqs[currentIdx] = updatedReq;
    return { ...rec, marketplace_requests: nextReqs };
  });
  if (r.ok === false || !updatedReq) return { ok: false, error: r.ok === false ? r.error : 'request update failed' };

  // Keep the commander's replay slice in sync; other actors do not need the
  // card state for reasoning, and the main jsonl is the renderer source.
  try {
    await _rewriteMarketplaceRequestInFile(
      conversationLayout(userId, cid).visibilityFile(target.from),
      msgId,
      requestId,
      patch,
    );
  } catch (err) {
    log.warn(`marketplace request slice update failed user=${userId} cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
  }
  return { ok: true, request: updatedReq, message: r.record };
}

async function _autoBindInstalledMarketplaceResource(
  userId: string,
  cid: string,
  req: MarketplaceInstallRequest,
): Promise<void> {
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    const projectId = (conv as any)?.project_id;
    if (typeof projectId !== 'string' || !projectId) return;
    const projectsFeat = await import('../projects');
    if (req.kind === 'agent') {
      await projectsFeat.addAgentBinding(userId, projectId, req.id);
    } else {
      await projectsFeat.addSkillBinding(userId, projectId, req.id);
    }
    log.info(`auto-bound marketplace ${req.kind} ${req.id} to project ${projectId} after install`);
  } catch (err) {
    log.warn(`marketplace install auto-bind failed user=${userId} cid=${cid} id=${req.id}: ${(err as Error).message}`);
  }
}

export async function resolveMarketplaceInstallRequest(
  input: ResolveMarketplaceInstallRequestInput,
): Promise<{
  ok: boolean;
  error?: string;
  request?: MarketplaceInstallRequest;
  install_error?: {
    kind?: MarketplaceInstallRequest['kind'];
    id: string;
    name: string;
    reason: string;
  };
  submission?: { text: string; agent_id: string };
}> {
  const { userId, cid, msgId, requestId, decision } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!safeId(msgId) || !safeId(requestId)) return { ok: false, error: 'invalid request' };
  if (decision !== 'install' && decision !== 'skip') return { ok: false, error: 'invalid decision' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const target = all.find((m) => m.id === msgId);
  const req = target?.marketplace_requests?.find((r) => r.request_id === requestId) || null;
  if (!target || !req) return { ok: false, error: 'request not found' };
  if (req.status !== 'pending') return { ok: false, error: 'request already resolved' };
  if (req.kind !== 'agent' && req.kind !== 'skill') return { ok: false, error: 'invalid request kind' };
  if (!safeId(req.id) || !req.version || !Number.isFinite(req.published_at)) {
    return { ok: false, error: 'invalid marketplace request payload' };
  }

  if (decision === 'skip') {
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'skipped',
      resolved_at: nowIso(),
    });
    if (!patched.ok) return patched;
    return {
      ok: true,
      request: patched.request,
      submission: {
        text: _encodeMarketplaceInstallResult(patched.request, 'skipped'),
        agent_id: COMMANDER_ID,
      },
    };
  }

  try {
    if (req.kind === 'agent') {
      await marketplace.installMarketplaceAgent(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    } else {
      await marketplace.installMarketplaceSkill(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    }
    await _autoBindInstalledMarketplaceResource(userId, cid, req);
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'installed',
      resolved_at: nowIso(),
    });
    const request = patched.ok
      ? patched.request
      : { ...req, status: 'installed' as const, resolved_at: nowIso() };
    if (patched.ok === false) {
      log.warn(`marketplace request status update failed after install user=${userId} cid=${cid} msgId=${msgId}: ${patched.error}`);
    }
    return {
      ok: true,
      request,
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'installed'),
        agent_id: COMMANDER_ID,
      },
    };
  } catch (err) {
    const installInfo = marketplace.getMarketplaceInstallErrorInfo(err);
    const failedKind = installInfo.kind || req.kind;
    const failedName = installInfo.name || (failedKind !== req.kind ? installInfo.id : '') || req.name || req.id;
    const failedKindLabel = failedKind === 'skill'
      ? t('marketplace_install_result.kind_skill')
      : t('marketplace_install_result.kind_agent');
    const error = `${failedKindLabel}: ${failedName} - ${installInfo.reason}`;
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'failed',
      resolved_at: nowIso(),
      error,
    });
    const request = patched.ok ? patched.request : { ...req, status: 'failed' as const, resolved_at: nowIso(), error };
    return {
      ok: true,
      request,
      install_error: {
        kind: failedKind,
        id: installInfo.id || '',
        name: failedName,
        reason: installInfo.reason,
      },
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'failed', error),
        agent_id: COMMANDER_ID,
      },
    };
  }
}

// ── Read messages (UI initial load) ──────────────────────────────────────

export async function readMessages(userId: string, cid: string, limit = 500): Promise<GroupMessage[]> {
  if (!safeId(cid)) return [];
  return (await readJsonl<GroupMessage>(conversationMessageReadFile(userId, cid), limit))
    .filter((msg) => !msg.deleted_at);
}

function _deletedMessageRevision(message: GroupMessage, deletedAt: string): GroupMessage {
  return {
    id: message.id,
    ts: message.ts,
    from: message.from,
    to: Array.isArray(message.to) ? message.to : [],
    text: '',
    deleted_at: deletedAt,
    deleted_by_user: true,
    _v: Math.max(0, Number(message._v) || 0) + 1,
  };
}

async function _tombstoneMessagesInFile(file: string, ids: ReadonlySet<string>, deletedAt: string): Promise<number> {
  if (!fs.existsSync(file)) return 0;
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  let changed = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || !ids.has(row.id) || row.deleted_at) continue;
    const rewritten = await rewriteJsonlLine<GroupMessage>(file, index, (current) => {
      if (!current || current.id !== row.id || current.deleted_at) return null;
      return _deletedMessageRevision(current, deletedAt);
    });
    if (rewritten.ok) changed += 1;
  }
  return changed;
}

/** Delete visible messages as versioned tombstones in the main log and all
 * actor slices. Persistent model sessions are purged so the next turn is
 * rebuilt from the filtered slices rather than retaining deleted context. */
export async function deleteMessages(
  userId: string,
  cid: string,
  messageIds: string[],
): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  if (!safeId(cid)) return { ok: false, deleted: [], error: 'invalid cid' };
  const ids = Array.from(new Set((Array.isArray(messageIds) ? messageIds : [])
    .filter((id) => typeof id === 'string' && safeId(id)))).slice(0, 100);
  if (!ids.length) return { ok: false, deleted: [], error: 'no messages selected' };
  const runtime = await runtimeStatus(userId, cid);
  if (runtime.processing) return { ok: false, deleted: [], error: 'conversation is running' };

  const mainFile = conversationMessageReadFile(userId, cid);
  const mainRows = await readJsonl<GroupMessage>(mainFile, 100_000);
  const existing = new Set(mainRows
    .filter((msg) => ids.includes(msg.id) && !msg.deleted_at && !msg.dispatch)
    .map((msg) => msg.id));
  if (!existing.size) return { ok: false, deleted: [], error: 'messages not found' };

  const deletedAt = nowIso();
  await _tombstoneMessagesInFile(mainFile, existing, deletedAt);
  const layout = conversationLayout(userId, cid);
  try {
    const entries = await fsp.readdir(layout.visibilityDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      await _tombstoneMessagesInFile(path.join(layout.visibilityDir, entry.name), existing, deletedAt);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('message delete slice rewrite failed', { userId, cid, error: logErrorRef(err) });
    }
  }

  try {
    const members = await readMembers(userId, cid);
    const sessions = await import('../../model/core-agent/session-store');
    for (const actor of members.actors) {
      if (actor.kind !== 'commander' && actor.kind !== 'agent') continue;
      const sid = actorSessionId(cid, actor);
      sessions.evictSession(sid);
      sessions.deleteSessionFileForUser(userId, sid);
    }
  } catch (err) {
    log.warn('message delete session reset failed', { userId, cid, error: logErrorRef(err) });
  }
  try {
    const cliSessions = await import('../local_agents/sessions');
    await cliSessions.clearForConversation(userId, cid);
  } catch (err) {
    log.warn('message delete cli session reset failed', { userId, cid, error: logErrorRef(err) });
  }

  log.info(`messages-deleted user=${userId} cid=${cid} count=${existing.size}`);
  return { ok: true, deleted: Array.from(existing) };
}
