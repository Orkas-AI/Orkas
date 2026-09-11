/**
 * Group-chat facade — IPC layer talks only to this module.
 *
 * Responsibilities:
 *   - Send a user message (router @ + bus enqueue + UI event stream)
 *   - Subscribe to event stream (single async generator IPC handler)
 *   - List members / read plan / mark form submitted
 *   - Abort group + drop on conv delete
 */

import { inspectCodingDirectory } from '../local_agents/project-directory';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  conversationMessageFile,
  conversationMessageReadFile,
} from '../../util/project-layout';
import { readJsonl, rewriteJsonlLine, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { logErrorRef, logErrorSummary, maskId } from '../../util/log-redact';
import { fileEditLock } from '../../util/locks';

import {
  COMMANDER_ID, USER_ID, readMembers, readState, seedReservedActors, purgeGroupDir,
  setCodingProjectDir, setStatus, actorSessionId, setActiveRecipients, type Actor,
} from './state';
import { isPlaceholderTitle } from './conv_title';
import type { CommanderMentionDisplay } from './message-display';
import {
  abort as busAbort, dropConv as busDropConv, enqueue, subscribe, isQuiescent, runtimeSnapshot,
  type GroupEvent,
  cancelConversationTask as busCancelConversationTask,
  sendConversationTaskNow as busSendConversationTaskNow,
  listConversationTasks as busListConversationTasks,
  setConversationTaskAfter as busSetConversationTaskAfter,
  resumeBlockedTask as busResumeBlockedTask,
  reorderConversationTask as busReorderConversationTask,
  reassignConversationTask as busReassignConversationTask,
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
): Promise<{ processing: boolean; processing_since: string | null; in_flight: string[]; active_turns: Array<{ actor: string; turn_id: string; msg_id?: string; steerable: boolean; started_at_ms: number }>; active_recipient?: string; active_recipients?: string[]; active_recipient_revision?: number }> {
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
    const floor = { active_recipient_revision: state.active_recipient_revision || 0,
      ...(state.active_recipient ? { active_recipient: state.active_recipient } : {}) };
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
export { submitCliAsyncInput } from './bus';

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
  commander_mention_display?: CommanderMentionDisplay;
  /** Host-owned delivery decision for the explicit queue "Send now" action.
   * Analytics attribution must never imply this execution control. */
  steerActiveTurn?: boolean;
  /** Cross-group ordering for a multi-mention send (D9 serial default).
   * Renderer composer toggle; absent = serial. See EnqueueParams. */
  multi_dispatch?: 'serial' | 'parallel';
  /** Renderer-generated id for the optimistic user bubble, echoed back on the
   * persisted record so the renderer can claim that exact bubble instead of
   * guessing by sender+timestamp+text. Two sends can legitimately share those
   * three, which is why the guess needed defensive patches. */
  client_msg_id?: string;
  /** User-visible first-message text used only for automatic task titles.
   *  Callers that inject transport routing such as `@Agent` into `text`
   *  should pass the pre-routing text here. An explicitly empty string means
   *  the new task has references but no user-authored body, so its placeholder
   *  title must remain unchanged. */
  title_text?: string;
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
  const {
    userId, cid, text, title_text, model_text, attachments, use_selections, references,
    steerActiveTurn, multi_dispatch, commander_mention_display,
    client_msg_id,
  } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  const hasTitleText = typeof title_text === 'string';
  const titleText = hasTitleText ? title_text.trim() : '';
  await seedReservedActors(userId, cid);
  // Auto-title: the first real user message in a fresh / unnamed
  // conversation overwrites the placeholder title so the sidebar item
  // becomes scannable. Lazy-imported to avoid a chats↔group_chat circular.
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    const titleSeed = hasTitleText ? titleText : text;
    if (titleSeed && conv && !conv.title_manually_set && isPlaceholderTitle(conv.title)) {
      await chats.updateConversation(
        userId,
        cid,
        { title: chats.autoTitle(titleSeed) },
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
      ...(commander_mention_display === 'preserve' || commander_mention_display === 'hide_generated_prefix'
        ? { commander_mention_display } : {}),
      ...(steerActiveTurn === true ? { steerActiveTurn: true } : {}),
      ...(multi_dispatch === 'parallel' || multi_dispatch === 'serial'
        ? { multiDispatch: multi_dispatch }
        : {}),
      ...(typeof client_msg_id === 'string' && client_msg_id.trim()
        ? { client_msg_id: client_msg_id.trim() }
        : {}),
      ...(model_text && model_text.trim() ? { model_text } : {}),
      ...(attachments && attachments.length ? { attachments: [...attachments] } : {}),
      ...(use_selections && use_selections.length ? { use_selections } : {}),
      ...(resolvedReferences.length ? { references: resolvedReferences } : {}),
      ...(steerActiveTurn === true ? { steerActiveTurn: true } : {}),
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
  /** Same contract as `SendInput.client_msg_id`. A retry paints an optimistic
   * bubble exactly like a normal send, so it must echo an identity back or the
   * renderer cannot tell that bubble is this record. */
  client_msg_id?: string;
}

export interface ResolvedFailedTurnRetry {
  mode: FailedTurnRetryMode;
  enqueue: Parameters<typeof enqueue>[0];
  recovery: FailedTurnRecoveryEvidence;
}

export interface FailedTurnRecoveryEvidence {
  active_turn: boolean;
  plan_pending_steps: number;
  plan_completed_steps: number;
  completed_work_count: number;
  succeeded_work_count: number;
  resource_count: number;
  produced_count: number;
  uncertain_operation_count: number;
  /** Bounded tool names only; never arguments, results, paths, or content. */
  uncertain_operations: string[];
}

const RETRY_RESUME_MODEL_TEXT = [
  '<task-retry mode="resume">',
  'Continue the unfinished task from the durable state available to this retry.',
  'Read the authoritative execution plan, completed-work ledger, prior tool results, and history resources before acting.',
  'Do not repeat work already verified as successful. If an external, paid, destructive, or otherwise non-idempotent operation was interrupted with an uncertain outcome, verify its current state before deciding whether to run it again.',
  'Respect every existing confirmation and permission gate. Complete the remaining work or report the smallest blocker that still requires the user.',
  '</task-retry>',
].join('\n');

function _retryProcessToolEvidence(messages: readonly GroupMessage[]): {
  observed: boolean;
  uncertainOperations: string[];
} {
  const pending = new Map<string, string>();
  let observed = false;
  for (const msg of messages) {
    for (const item of msg.process || []) {
      const event = item && typeof item === 'object' && 'event' in item ? item.event : undefined;
      if (!event) continue;
      const data = event.data && typeof event.data === 'object'
        ? event.data as Record<string, unknown>
        : {};
      const inProcessTool = event.stream === 'tool';
      const cliTool = event.stream === 'cli'
        && String(data.type || '').toLowerCase() === 'tool-event';
      if (!inProcessTool && !cliTool) continue;
      const phase = String(data.phase || data.status || '').trim().toLowerCase();
      if (!/^(?:use|start|running|request|call|begin|end|result|complete|completed|success|succeeded|error|failed|abort|aborted|cancel|cancelled)$/.test(phase)) {
        continue;
      }
      observed = true;
      const name = String(data.tool || data.name || data.tool_name || 'unknown_tool')
        .trim()
        .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
        .slice(0, 80) || 'unknown_tool';
      const rawCallId = String(data.call_id || data.callId || data.id || '').trim().slice(0, 128);
      const key = rawCallId
        ? `${event.stream}:id:${rawCallId}`
        : `${event.stream}:name:${name}`;
      if (/^(?:use|start|running|request|call|begin)$/.test(phase)) {
        pending.set(key, name);
      } else {
        pending.delete(key);
      }
    }
  }
  return {
    observed,
    uncertainOperations: Array.from(new Set(pending.values())).slice(0, 20),
  };
}

function _isInterruptedAssistantReply(message: GroupMessage): boolean {
  if (message.system_kind === 'reply_interrupted') return true;
  return (message.process || []).some((item) => {
    const data = item?.type === 'event' && item.event?.data;
    return item?.type === 'event'
      && item.event?.stream === 'runtime'
      && !!data
      && typeof data === 'object'
      && (data as Record<string, unknown>).aborted === true;
  });
}

/** Resolve one failed or interrupted bubble retry without mutating conversation state. The
 * main process owns this decision so the renderer cannot guess from localized
 * text or stale DOM. */
export async function resolveFailedTurnRetry(
  input: RetryFailedTurnInput,
): Promise<{ ok: true; value: ResolvedFailedTurnRetry } | { ok: false; error: string }> {
  const { userId, cid, failedMessageId } = input;
  const visibleText = String(input.visibleText || '').trim();
  const clientMsgId = String(input.client_msg_id || '').trim();
  if (!safeId(cid) || !safeId(failedMessageId)) return { ok: false, error: 'invalid retry target' };
  if (!visibleText) return { ok: false, error: 'empty retry message' };

  const rows = await readJsonl<GroupMessage>(mainJsonlFile(userId, cid), 100_000);
  const failedIndex = rows.findIndex((row) => row.id === failedMessageId && !row.deleted_at);
  if (failedIndex < 0) return { ok: false, error: 'failed message not found' };
  const failed = rows[failedIndex];
  if (!failed.from || failed.from === USER_ID || failed.dispatch) {
    return { ok: false, error: 'retry target is not an assistant reply' };
  }
  const interrupted = _isInterruptedAssistantReply(failed);
  if (!failed.failure_kind && !failed.failure_code && !interrupted) {
    return { ok: false, error: 'retry target is not a failed assistant reply' };
  }

  const linkedSourceMessageId = String(failed.source_message_id || '').trim();
  let sourceIndex = linkedSourceMessageId
    ? rows.slice(0, failedIndex).findIndex((row) =>
        row.id === linkedSourceMessageId
        && !row.deleted_at
        && !!String(row.text || '').trim(),
      )
    : failedIndex - 1;
  // Legacy terminal replies predate source_message_id. Preserve their
  // chronological fallback, but never fall through from an explicit broken
  // link to an unrelated newer request.
  if (!linkedSourceMessageId) {
    while (sourceIndex >= 0) {
      const row = rows[sourceIndex];
      if (!row.deleted_at && !row.dispatch && row.from === USER_ID && String(row.text || '').trim()) break;
      sourceIndex -= 1;
    }
  }
  if (sourceIndex < 0) return { ok: false, error: 'retry source message not found' };
  const source = rows[sourceIndex];

  await seedReservedActors(userId, cid);
  const members = await readMembers(userId, cid);
  let actor: Actor | undefined = members.actors.find((item) => item.id === failed.from);
  let recoveredAgent: Awaited<ReturnType<typeof import('../agents')['getAgent']>> | null = null;
  // Conversation history is the durable proof of who produced the failed
  // reply. Older/synced conversations can retain that canonical JSONL while
  // their derived members.json roster is missing the Agent. If the same Agent
  // is still installed and enabled, recover its identity from the registry;
  // enqueue() will restore membership at its normal recipient boundary before
  // dispatch. A deleted or disabled Agent remains unavailable.
  if (!actor && safeId(failed.from)) {
    try {
      const agents = await import('../agents');
      recoveredAgent = await agents.getAgent(failed.from);
      if (recoveredAgent && recoveredAgent.enabled !== false) {
        actor = {
          kind: 'agent',
          id: recoveredAgent.agent_id,
          name: recoveredAgent.name,
          joined_at: failed.ts || nowIso(),
        };
      }
    } catch (err) {
      log.warn('retry Agent identity recovery failed', { error: logErrorRef(err) });
    }
  }
  if (!actor || actor.kind === 'user' || actor.kind === 'worker') {
    return { ok: false, error: 'retry actor is unavailable' };
  }

  let cliRuntime: string | null = null;
  if (actor.kind === 'agent') {
    try {
      const agent = recoveredAgent || await (await import('../agents')).getAgent(actor.id);
      cliRuntime = agent?.runtime?.kind === 'cli' ? agent.runtime.cli : null;
    } catch (err) {
      log.warn('retry CLI runtime inspection failed', { error: logErrorRef(err) });
    }
  }

  let context: {
    activeTurn?: { id: number };
    completedTurns?: Array<{ id: number }>;
    executionPlan?: {
      updatedTurnId: number;
      objectiveTurnId: number;
      steps?: Array<{ status?: string }>;
    };
    completedWork?: Array<{ turnId: number; tool?: string; status?: string }>;
    resources?: Array<{ sourceTurnId?: number }>;
  } | null = null;
  if (!cliRuntime) {
    try {
      const { getSession } = await import('../../model/core-agent/session-store');
      context = (await getSession(actorSessionId(cid, actor))).getSerializedContextState();
    } catch (err) {
      log.warn('retry context inspection failed', { error: logErrorRef(err) });
    }
  }

  let cliBindingBelongsToAttempt = false;
  if (cliRuntime) {
    try {
      const { localCliResumeStrategy } = await import('../local_agents/registry');
      if (localCliResumeStrategy(cliRuntime) !== 'none') {
        const cliSessions = await import('../local_agents/sessions');
        const binding = await cliSessions.getBinding(userId, cid, actor.id, cliRuntime);
        cliBindingBelongsToAttempt = binding?.sourceMessageId === source.id;
      }
    } catch (err) {
      log.warn('retry CLI binding inspection failed', { error: logErrorRef(err) });
    }
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
  const producedCount = attemptRows.reduce(
    (count, row) => count + (Array.isArray(row.produced) ? row.produced.length : 0),
    0,
  );
  const hasProduced = producedCount > 0;
  const processToolEvidence = _retryProcessToolEvidence(attemptRows);
  const hasToolState = processToolEvidence.observed;
  const attemptCompletedWork = attemptTurnId
    ? (context?.completedWork || []).filter((entry) => entry.turnId === attemptTurnId)
    : [];
  const uncertainLedgerTools = attemptCompletedWork
    .filter((entry) => /^(?:aborted|stalled)$/.test(String(entry.status || '').toLowerCase()))
    .map((entry) => String(entry.tool || 'unknown_tool').trim().slice(0, 80) || 'unknown_tool');
  const uncertainOperations = Array.from(new Set([
    ...processToolEvidence.uncertainOperations,
    ...uncertainLedgerTools,
  ])).slice(0, 20);
  const planSteps = planBelongsToAttempt && Array.isArray(context?.executionPlan?.steps)
    ? context.executionPlan.steps
    : [];
  const recovery: FailedTurnRecoveryEvidence = {
    active_turn: !!activeTurnId,
    plan_pending_steps: planSteps.filter((step) =>
      /^(?:pending|in_progress)$/.test(String(step.status || '').toLowerCase())).length,
    plan_completed_steps: planSteps.filter((step) =>
      String(step.status || '').toLowerCase() === 'completed').length,
    completed_work_count: attemptCompletedWork.length,
    succeeded_work_count: attemptCompletedWork.filter((entry) =>
      String(entry.status || '').toLowerCase() === 'succeeded').length,
    resource_count: attemptTurnId
      ? (context?.resources || []).filter((resource) => resource.sourceTurnId === attemptTurnId).length
      : 0,
    produced_count: producedCount,
    uncertain_operation_count: uncertainOperations.length,
    uncertain_operations: uncertainOperations,
  };
  const hasDurableState = !!activeTurnId
    || planBelongsToAttempt
    || completedWorkBelongsToAttempt
    || resourceBelongsToAttempt
    || cliBindingBelongsToAttempt
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
  log.info('failed-turn retry resolved', {
    mode,
    cli: cliRuntime || undefined,
    has_active_turn: !!activeTurnId,
    has_cli_binding: cliBindingBelongsToAttempt,
    has_produced: hasProduced,
    has_tool_state: hasToolState,
    recovery,
    newer_attempt: newerAttemptExists,
    failed_before_execution: failedBeforeExecution,
    interrupted,
  });
  const originalModelText = String(source.model_text || source.text || '');
  const commanderRetry = source.commander_retry?.source_tool === 'dispatch_to'
    ? source.commander_retry
    : null;
  const commanderGoal = commanderRetry && source.source_message_id
    ? rows.find((row) => (
        row.id === source.source_message_id
        && !row.deleted_at
        && !!String(row.model_text || row.text || '').trim()
      ))
    : undefined;
  const commanderRetryContinuation = commanderRetry && commanderGoal
    ? {
        userGoal: String(commanderGoal.model_text || commanderGoal.text || '').slice(0, 6000),
        agentTask: originalModelText.slice(0, 6000),
        resumeInstruction: String(commanderRetry.resume_instruction || '').slice(0, 6000),
      }
    : undefined;

  return {
    ok: true,
    value: {
      mode,
      recovery,
      enqueue: {
        uid: userId,
        cid,
        fromActorId: USER_ID,
        text: visibleText,
        ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
        model_text: mode === 'resume'
          ? [
              RETRY_RESUME_MODEL_TEXT,
              '<recovery-evidence>',
              JSON.stringify(recovery),
              '</recovery-evidence>',
              'Original user request (quoted for objective continuity):',
              JSON.stringify(originalModelText),
            ].join('\n\n')
          : originalModelText,
        forceTo: [actor.id],
        failedTurnRetryMode: mode,
        retrySourceMessageId: source.id,
        retryUncertainOperationCount: recovery.uncertain_operation_count,
        ...(commanderRetryContinuation ? {
          source_message_id: commanderGoal!.id,
          commanderRetryContinuation,
        } : {}),
        ...(mode === 'resume' ? { resumeActiveTurn: true } : {}),
        ...(source.use_selections?.length ? { use_selections: source.use_selections.slice() } : {}),
        ...(mode === 'restart' && source.attachments?.length ? { attachments: source.attachments.slice() } : {}),
        ...(mode === 'restart' && source.references?.length ? { references: source.references.slice() } : {}),
      },
    },
  };
}

export interface RetryFailedTurnResult {
  ok: boolean;
  mode?: FailedTurnRetryMode;
  msg?: GroupMessage;
  error?: string;
  /** The same failed bubble already has a queued/running retry; nothing was
   * enqueued or persisted. Not an error: the user's intent is already
   * pending on the board. */
  already_pending?: boolean;
}

/** Board statuses that still own a pending execution. The terminal set is
 * `done | stopped | failed | cancelled` (task_board.ts); listing the pending
 * side keeps an unknown future status fail-open (a duplicate retry rather
 * than a bubble that can never be retried). */
const PENDING_RETRY_TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'running', 'waiting_input', 'blocked',
]);
/** failed-message key -> source message id of the retry task that was
 * accepted for it. Memory-only on purpose: a process restart cancels every
 * live board row, so there is never a pending retry to remember across it. */
const _acceptedRetries = new Map<string, string>();
/** Keys whose resolve + enqueue has not returned yet (a double-click lands
 * before the first retry reaches the board). */
const _retriesInFlight = new Set<string>();

function retryDedupeKey(userId: string, cid: string, failedMessageId: string): string {
  return [userId, cid, failedMessageId].join(' ');
}

async function _retryStillPending(userId: string, cid: string, retryMsgId: string): Promise<boolean> {
  try {
    const rows = await busListConversationTasks(userId, cid);
    return rows.some((row) => row.source_msg_id === retryMsgId
      && PENDING_RETRY_TASK_STATUSES.has(row.status));
  } catch (err) {
    log.warn('retry dedupe board lookup failed', { error: logErrorRef(err) });
    return false;
  }
}

/** Test-only: forget accepted/in-flight retry keys between isolated runs. */
export function _resetFailedTurnRetryDedupeForTest(): void {
  _acceptedRetries.clear();
  _retriesInFlight.clear();
}

export async function retryFailedTurn(
  input: RetryFailedTurnInput,
): Promise<RetryFailedTurnResult> {
  // One failed bubble owns at most one pending retry. A second Retry while
  // that retry is still queued/running (or still being resolved) is a no-op
  // at this boundary so a double-click cannot enqueue two tasks, persist two
  // "Retry" user messages, and run two model turns for one prompt.
  const key = retryDedupeKey(input.userId, input.cid, input.failedMessageId);
  if (_retriesInFlight.has(key)) return { ok: true, already_pending: true };
  _retriesInFlight.add(key);
  try {
    const accepted = _acceptedRetries.get(key);
    if (accepted) {
      if (await _retryStillPending(input.userId, input.cid, accepted)) {
        log.info('failed-turn retry already pending', { cid: maskId(input.cid) });
        return { ok: true, already_pending: true };
      }
      _acceptedRetries.delete(key);
    }
    const resolved = await resolveFailedTurnRetry(input);
    if (!resolved.ok) return resolved;
    const msg = await enqueue(resolved.value.enqueue);
    _acceptedRetries.set(key, msg.id);
    return { ok: true, mode: resolved.value.mode, msg };
  } catch (err) {
    log.error('failed-turn retry failed', { error: logErrorRef(err) });
    return { ok: false, error: (err as Error).message || String(err) };
  } finally {
    _retriesInFlight.delete(key);
  }
}

// ── Abort + drop ─────────────────────────────────────────────────────────

export async function abort(userId: string, cid: string): Promise<{ ok: boolean }> {
  await busAbort(userId, cid);
  return { ok: true };
}

export async function dropConv(userId: string, cid: string): Promise<void> {
  await busDropConv(userId, cid);
  // purgeGroupDir removes the whole group dir recursively — tasks.json
  // (the conversation task board snapshot) goes with it.
  await purgeGroupDir(userId, cid);
}

// ── Conversation task board (list + queued/running cancel) ───────────────

export async function listTasks(userId: string, cid: string) {
  if (!safeId(cid)) return { ok: false as const, error: 'invalid cid', tasks: [] };
  const tasks = await busListConversationTasks(userId, cid);
  return { ok: true as const, tasks };
}

export async function cancelTask(userId: string, cid: string, taskId: string) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busCancelConversationTask(userId, cid, taskId);
}

export async function sendTaskNow(userId: string, cid: string, taskId: string) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busSendConversationTaskNow(userId, cid, taskId);
}

export async function setTaskAfter(
  userId: string,
  cid: string,
  taskId: string,
  afterTaskId: string | null,
) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busSetConversationTaskAfter(userId, cid, taskId, afterTaskId);
}

export async function resumeBlockedTask(userId: string, cid: string, taskId: string) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busResumeBlockedTask(userId, cid, taskId);
}

export async function reorderTask(
  userId: string,
  cid: string,
  taskId: string,
  beforeTaskId: string | null,
) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busReorderConversationTask(userId, cid, taskId, beforeTaskId);
}

export async function reassignTask(
  userId: string,
  cid: string,
  taskId: string,
  assigneeId: string,
) {
  if (!safeId(cid) || !taskId || typeof taskId !== 'string' || !assigneeId || typeof assigneeId !== 'string') {
    return { ok: false as const, error: 'invalid arguments' };
  }
  return busReassignConversationTask(userId, cid, taskId, assigneeId);
}

/** D9 UI half: the composer chip's explicit selection sets the floor
 * directly instead of synthesizing a hidden `@name` prefix into the next
 * message. 'commander' resets the floor; an agent id must be a real,
 * enabled agent (deterministic validation — no silent redirects). */
export async function setFloor(userId: string, cid: string, actorId: string | string[]) {
  if (!safeId(cid)) return { ok: false as const, error: 'invalid cid' };
  const ids = [...new Set((Array.isArray(actorId) ? actorId : [actorId])
    .map((id) => String(id || '').trim()))];
  if (!ids.length) ids.push(COMMANDER_ID);
  for (const id of ids) {
    if (id !== COMMANDER_ID) {
      if (!safeId(id)) return { ok: false as const, error: 'invalid actor' };
      try {
        const agentsFeat = await import('../agents');
        const agent = await agentsFeat.getAgent(id);
        if (!agent) return { ok: false as const, error: 'unknown agent' };
      } catch {
        return { ok: false as const, error: 'unknown agent' };
      }
    }
  }
  await seedReservedActors(userId, cid);
  const state = await setActiveRecipients(userId, cid, ids, 'user_selection');
  log.info(`floor set via chip user=${maskId(userId)} cid=${maskId(cid)} recipients=${ids.length}`);
  return { ok: true as const, state };
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

type CodingProjectDirFormUpdate = {
  projectDir: string;
  oldDir: string;
  oldExplicit: boolean;
  oldPending?: string;
};

async function _prepareCodingProjectDirFormUpdate(
  userId: string,
  cid: string,
  target: GroupMessage,
  values: Record<string, unknown>,
): Promise<
  { ok: true; update: CodingProjectDirFormUpdate | null }
  | { ok: false; error: string }
> {
  const projectDirField = target.form?.fields.find((field) => field.id === 'project_dir');
  if (!projectDirField || !target.form) return { ok: true, update: null };

  let agentsFeat: typeof import('../agents');
  let agent: Awaited<ReturnType<typeof import('../agents')['getAgent']>>;
  try {
    agentsFeat = await import('../agents');
    agent = await agentsFeat.getAgent(target.form.agent_id);
  } catch (err) {
    log.warn('form-submit project directory agent lookup failed', { error: logErrorSummary(err) });
    return { ok: false, error: t('errors.dir_not_exists') };
  }
  const cli = agent?.runtime?.kind === 'cli' ? agent.runtime.cli : '';
  if (!agentsFeat.cliIsCodingAgent(cli)) return { ok: true, update: null };

  // Unchanged controls may be omitted from submitted values, so resolve the
  // effective value the same way encodeSubmission does: explicit value first,
  // then the field default. A coding cwd is host state, not model prose; only
  // an absolute path to an existing directory is allowed across this boundary.
  const raw = Object.prototype.hasOwnProperty.call(values || {}, 'project_dir')
    ? values.project_dir
    : projectDirField.default;
  if (typeof raw !== 'string' || !raw.trim() || !path.isAbsolute(raw.trim())) {
    return { ok: false, error: t('errors.dir_not_exists') };
  }
  const projectDir = path.resolve(raw.trim());
  const inspection = inspectCodingDirectory(projectDir);
  if (inspection.kind !== 'available') {
    return { ok: false, error: t(inspection.kind === 'denied' ? 'errors.cli_directory_denied'
      : inspection.kind === 'unavailable' ? 'errors.cli_directory_unavailable'
      : inspection.code === 'ENOTDIR' ? 'errors.path_not_dir' : 'errors.dir_not_exists') };
  }

  try {
    const previous = await readState(userId, cid);
    return {
      ok: true,
      update: {
        projectDir,
        oldDir: previous.coding_project_dir || '',
        oldExplicit: previous.coding_project_dir_explicit === true,
        oldPending: previous.coding_project_dir_pending,
      },
    };
  } catch (err) {
    log.warn('form-submit project directory state lookup failed', { error: logErrorSummary(err) });
    return { ok: false, error: t('errors.dir_not_exists') };
  }
}

/**
 * Mutate the canonical message that owns this form to mark it submitted.
 * Does **not** enqueue a follow-up
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
type FormSubmissionResult = {
  ok: boolean;
  error?: string;
  submission?: { text: string; agent_id: string };
};

async function _buildFormSubmissionResult(
  target: GroupMessage,
  values: Record<string, unknown>,
): Promise<FormSubmissionResult> {
  if (!target.form) return { ok: false, error: 'form not found' };
  const agentId = target.form.agent_id;
  const encoded = encodeSubmission(
    { form_id: target.form.form_id, agent_id: agentId, fields: target.form.fields },
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
      log.warn('form-submit name lookup failed', {
        agent_id: maskId(agentId),
        error: logErrorSummary(err),
      });
    }
  }
  // Newline (not space) between the @-mention and the bullet list so the
  // markdown renderer treats them as a paragraph followed by a list. With a
  // space, the leading `- ` of the first bullet sits inline with the mention
  // and gets parsed as a hyphen in prose, dropping the first field out of
  // the list and leaving subsequent bullets visually orphaned.
  return { ok: true, submission: { text: `${mention}\n${encoded}`, agent_id: agentId } };
}

async function _restoreProjectDirAfterFailedFormCommit(
  userId: string,
  cid: string,
  update: CodingProjectDirFormUpdate | null,
): Promise<void> {
  if (!update) return;
  try {
    await setCodingProjectDir(userId, cid, update.oldDir || update.oldPending || '', {
      explicit: update.oldExplicit, needsConfirmation: !!update.oldPending,
    });
  } catch (err) {
    log.error('form-submit project directory rollback failed', { error: logErrorSummary(err) });
  }
}

export async function markFormSubmittedAndDispatch(
  input: MarkFormSubmittedInput,
): Promise<FormSubmissionResult> {
  const { userId, cid, msgId, formId } = input;
  const values = input.values || {};
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };

  const file = mainJsonlFile(userId, cid);
  // A lost HTTP response or a double click may retry the same form. Serialize
  // the complete host-side commit so exactly one caller mutates state/session
  // and later identical callers receive the same replay payload idempotently.
  return fileEditLock(`${file}.form-submit`).runExclusive(async () => {
    const all = await readJsonl<GroupMessage>(file, 100_000);
    const idx = all.findIndex((m) => m.id === msgId);
    if (idx < 0) return { ok: false, error: 'message not found' };
    const target = all[idx];
    if (!target.form || target.form.form_id !== formId) {
      return { ok: false, error: 'form id mismatch' };
    }

    if (target.form.submitted) {
      const storedValues = target.form.values && typeof target.form.values === 'object'
        ? target.form.values
        : {};
      if (!isDeepStrictEqual(storedValues, values)) {
        return { ok: false, error: 'form already submitted with different values' };
      }
      return _buildFormSubmissionResult(target, storedValues);
    }

    // Validate host-affecting form values before touching state or history.
    // Invalid/stale paths therefore leave the operation retryable.
    const projectDirPreparation = await _prepareCodingProjectDirFormUpdate(
      userId,
      cid,
      target,
      values,
    );
    if (!projectDirPreparation.ok) return projectDirPreparation;

    const agentId = target.form.agent_id;

    // Coding-agent contract: commit the validated cwd before consuming the
    // form. A state write failure therefore has zero transcript/session side
    // effects. If a later transcript rewrite fails, restore the prior cwd and
    // original main record so the same form remains retryable.
    const projectDirUpdate = projectDirPreparation.update;
    if (projectDirUpdate) {
      try {
        await setCodingProjectDir(userId, cid, projectDirUpdate.projectDir, { explicit: true });
      } catch (err) {
        log.warn('form-submit project directory update failed', { error: logErrorSummary(err) });
        return { ok: false, error: t('errors.dir_not_exists') };
      }
    }

    const updated: ChatFormPayload = {
      ...target.form,
      submitted: true,
      values,
      submitted_at: nowIso(),
    };
    try {
      const mainResult = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
        if (!rec || rec.id !== msgId || rec.form?.submitted) return null;
        return { ...rec, form: updated };
      });
      if (mainResult.ok === false) throw new Error(mainResult.error);
    } catch (err) {
      await _restoreProjectDirAfterFailedFormCommit(userId, cid, projectDirUpdate);
      log.warn('form mark failed', { error: logErrorSummary(err) });
      return { ok: false, error: 'form submit failed' };
    }

    if (projectDirUpdate) {
      if (projectDirUpdate.oldDir
          && path.resolve(projectDirUpdate.oldDir) !== projectDirUpdate.projectDir) {
        // Session cleanup is best-effort: cwdFingerprint still guarantees the
        // next dispatch cannot resume a binding from the old directory.
        try {
          const cliSessions = await import('../local_agents/sessions');
          await cliSessions.clearForConversation(userId, cid);
          log.info('coding project directory changed from form; cleared CLI sessions');
        } catch (err) {
          log.warn('coding project directory changed but session cleanup failed', {
            error: logErrorSummary(err),
          });
        }
      } else {
        log.info('coding project directory set explicitly from form');
      }
    }

    log.info('form submitted', {
      user_id: maskId(userId),
      cid: maskId(cid),
      message_id: maskId(msgId),
      agent_id: maskId(agentId),
      field_count: target.form.fields.length,
    });
    // Expert-signals hook (plan §5 mount #4): one form_left_blank signal per
    // field the user didn't touch. Run only after the complete commit, and
    // never again for an idempotent response retry.
    (async () => {
      try {
        const { emitSignal } = await import('../expert_signals');
        const { buildFormLeftBlankSignals } = await import('../expert_signals/extractors/event');
        const signals = buildFormLeftBlankSignals({
          cid, aid: agentId, turn_id: msgId, msg_id: msgId,
          fields: target.form!.fields as any,
          values,
        });
        for (const sig of signals) emitSignal(userId, sig);
      } catch (err) {
        log.warn('expert-signals form_left_blank emit failed', {
          cid: maskId(cid),
          message_id: maskId(msgId),
          error: logErrorSummary(err),
        });
      }
    })();

    return _buildFormSubmissionResult({ ...target, form: updated }, values);
  });
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
    if (req.kind !== 'agent') return;
    const projectsFeat = await import('../projects');
    await projectsFeat.addAgentBinding(userId, projectId, req.id);
    log.info(`auto-bound marketplace agent ${req.id} to project ${projectId} after install`);
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

/** Delete visible messages as versioned tombstones in the canonical log.
 * Persistent model sessions are purged so the next turn is rebuilt from the
 * filtered canonical history rather than retaining deleted context. */
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
