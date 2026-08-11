/**
 * Group-chat visibility — per-Agent authorized message slices.
 *
 * Bus calls `appendVisible` for every newly-emitted group message. The slice
 * is an authorization-bounded record for CLI recovery and host bookkeeping.
 * In-process Agent sessions do not replay it into a fresh model context;
 * unresolved continuity is retrieved explicitly through current-scope chat
 * history tools.
 *
 * Visibility rule per actor (also documented in CLAUDE.md §5):
 *   agent X   → messages where X is in {from, to, mentions} OR
 *               (from == commander && to includes X)
 *   commander → reads canonical `<cid>.jsonl`; no slice file
 *   user      → reads canonical `<cid>.jsonl`; no slice file
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { Message } from '#core-agent';

import { conversationLayout } from '../../util/project-layout';
import { appendJsonlAtomic, readJsonl } from '../../storage';
import { COMMANDER_ID, USER_ID } from './state';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.visibility');

export interface ChatUseSelection {
  kind: 'skill' | 'connector';
  id: string;
  name?: string;
}

/** Immutable snapshot of one visible message referenced from another task.
 * The main process resolves these fields from the source JSONL; renderer
 * callers submit only source conversation/message locators. */
export interface ChatMessageReference {
  source_cid: string;
  source_title: string;
  source_msg_id: string;
  from_actor: string;
  from_name?: string;
  source_ts: string;
  text: string;
  /** Source-conversation attachment locators. `source_cid + name` is stable
   * across devices; the bus resolves a local absolute path only for the
   * active model turn and never persists that machine-specific path. */
  attachments?: Array<{ name: string; kind?: string }>;
  produced?: string[];
}

/** Stable source taxonomy for a user-visible failed assistant bubble. UI
 * styling and retry affordances are deliberately independent of this value;
 * analytics uses it to distinguish actual model-output failures. */
export type GroupMessageFailureKind =
  | 'model'
  | 'config'
  | 'dependency'
  | 'validation'
  | 'operation'
  | 'runtime';

export interface GroupMessage {
  /** Stable per-message id (not jsonl line index). Used by visibility +
   * dedupe. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Sender actor id. */
  from: string;
  /** Recipient actor ids (resolved by router). */
  to: string[];
  /** Tokens that didn't resolve to any actor — passed through for UI. */
  unknown_mentions?: string[];
  /** Plain `@token` list (raw text mentions). */
  mentions?: string[];
  /** Stable actor-execution id that produced this record. Live process,
   * terminal bus events, persisted history and renderer placeholders all use
   * this value to refer to the same reply. Older records may omit it. */
  turn_id?: string;
  /** Renderer-generated id echoed back on a user message so the optimistic
   * bubble can be claimed by identity rather than by a sender+timestamp+text
   * guess. User messages only; absent on older records. */
  client_msg_id?: string;
  /** User/actor message that causally triggered this actor reply. Persisted
   * on terminal replies so actions on an older failed bubble can recover the
   * correct request even when newer messages were written before the turn
   * finished. Older records may omit it and use chronological fallback. */
  source_message_id?: string;
  /** Host-generated status records are not model replies. Kept explicit so
   * recovery/reconciliation never claims a live actor placeholder merely
   * because the status row has the same sender. */
  system_kind?: 'reply_interrupted';
  /** Markdown text body. */
  text: string;
  /** Structured failure origin. Older records omit this field and must not be
   * retroactively classified by inspecting localized HTML/text. */
  failure_kind?: GroupMessageFailureKind;
  /** Stable low-cardinality reason paired with `failure_kind`. */
  failure_code?: string;
  /** Internal model-facing text. UI renders `text`; workers use this when
   * present so system-created messages can stay terse for humans while
   * preserving full instructions for the model. */
  model_text?: string;
  /** Attachment filenames (only meaningful for user messages). */
  attachments?: string[];
  /** Structured composer selections captured at send time. The text still
   * carries the human-readable "use X" wording; this preserves the internal
   * id so agent skill allowlists can include explicit user choices. */
  use_selections?: ChatUseSelection[];
  /** Structured snapshots quoted from this or another conversation. Kept
   * outside `text` so mentions in historical content never affect routing. */
  references?: ChatMessageReference[];
  /** Absolute paths produced by local-exec tools during this turn (only on
   * commander/agent messages). */
  produced?: string[];
  /** Form widget payload — only on agent messages whose final text contained
   * a fenced agent-input-form block. */
  form?: import('./router').ChatFormPayload;
  /** Quick-created / quick-edited agent meta — populated when the commander's
   * final text contained one or more `<agent>` containers. One entry per
   * successfully applied container; failed applications are not recorded. */
  created_agents?: Array<{ agent_id: string; name: string; kind?: 'created' | 'updated' }>;
  /** Mirror of `created_agents` for skills — populated when the commander's
   * final text contained one or more `<skill>` containers. */
  created_skills?: Array<{ skill_id: string; name: string; kind?: 'created' | 'updated' }>;
  /** Interactive web-app artifacts produced this turn via `create_artifact`.
   * `id` keys `chat_artifacts/<cid>/<id>/`; `agent_id` is the producing actor
   * (`'commander'` or an agent id) — the renderer routes a user→artifact
   * interaction result back to it. Rendered as a sandboxed `<iframe>`
   * (`chat-app://`) at the bottom of the bubble. */
  artifacts?: Array<{ id: string; title: string; agent_id: string }>;
  /** Commander-requested marketplace installs. The model can search the
   * official marketplace and request a user decision, but the install only
   * happens after the human clicks the rendered card. */
  marketplace_requests?: MarketplaceInstallRequest[];
  /** Marks this message as a plan announcement (rendered with a folded
   * plan card in UI). Set by `plan_set` first-time emission. */
  plan_announcement?: boolean;
  /** Internal plan-step dispatch from commander → agent. Persisted (so the
   * agent's visibility slice has it for context) but hidden from the user
   * view, since the user already saw the plan announcement. */
  dispatch?: boolean;
  /** Commander reasoning-segment index within one turn. A commander turn that
   * dispatches visible agents is split into segments at each dispatch boundary
   * (pre-dispatch reasoning → its own bubble, post-handback synthesis → the
   * next), so the loop is visible and reload ordering matches the live view.
   * Present on every segment of such a turn (0-based); absent on ordinary
   * single-bubble messages. The renderer uses it to finalize the live
   * placeholder at a boundary instead of appending a duplicate bubble. */
  seg?: number;
  /** Captured process trail from this actor's turn — progress lines + non-
   * assistant tool/lifecycle events. Stored on the actor's end-of-turn
   * message in the main `<cid>.jsonl` so a history reload can rerender the
   * trail (live UI accumulates it via `process` events; without persistence
   * it vanishes on refresh). Intentionally stripped from visibility slices
   * (agent worker LLM replays don't need it). */
  process?: Array<
    | { type: 'progress'; text: string }
    | { type: 'event'; event: { stream: string; data?: unknown } }
  >;
  /** User-deletion tombstone. The stable id/route shell remains so sync can
   * deterministically prefer the deletion revision over an older copy. */
  deleted_at?: string;
  deleted_by_user?: true;
  _v?: number;
}

export interface MarketplaceInstallRequest {
  request_id: string;
  kind: 'agent' | 'skill';
  id: string;
  name: string;
  /** Agent avatar tokens from the marketplace row. Skills do not render an avatar. */
  icon?: string;
  color?: string;
  description_zh?: string;
  description_en?: string;
  category?: string;
  create_uid?: string;
  version: string;
  published_at: number;
  /** Server row update timestamp. Preferred freshness key for marketplace installs because
   *  republishing keeps `published_at` stable. */
  updated_at?: number;
  reason?: string;
  status: 'pending' | 'installed' | 'skipped' | 'failed';
  requested_at: string;
  resolved_at?: string;
  error?: string;
}

// ── Slice IO ─────────────────────────────────────────────────────────────

function isVisibleTo(actorId: string, msg: GroupMessage): boolean {
  if (actorId === COMMANDER_ID || actorId === USER_ID) return true;
  if (msg.from === actorId) return true;
  if (msg.to.includes(actorId)) return true;
  if (msg.mentions && msg.mentions.includes(actorId)) return true;
  // Commander → @<actor> messages: already covered by msg.to. Belt-and-suspenders.
  if (msg.from === COMMANDER_ID && msg.to.includes(actorId)) return true;
  return false;
}

/** Append the message to every actor's slice that should see it. */
export async function appendVisible(uid: string, cid: string, msg: GroupMessage, actorIds: string[]): Promise<void> {
  const layout = conversationLayout(uid, cid);
  fs.mkdirSync(layout.visibilityDir, { recursive: true });
  // One-way cleanup for conversations created before Commander switched to
  // the canonical log. This file is derived data and is no longer read.
  if (actorIds.includes(COMMANDER_ID)) {
    try { await fsp.unlink(layout.visibilityFile(COMMANDER_ID)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`purge legacy commander slice failed user=${uid} cid=${cid}: ${(err as Error).message}`);
      }
    }
  }
  for (const actorId of actorIds) {
    // Commander and user read the canonical conversation record directly.
    // Agent slices remain compatibility/targeted-task data; named in-process
    // history and CLI recovery/deltas use the canonical log.
    if (actorId === COMMANDER_ID || actorId === USER_ID) continue;
    if (!isVisibleTo(actorId, msg)) continue;
    const file = layout.visibilityFile(actorId);
    try {
      await appendJsonlAtomic<GroupMessage>(file, msg);
    } catch (err) {
      log.warn(`append visible failed user=${uid} cid=${cid} actor=${actorId}: ${(err as Error).message}`);
    }
  }
}

export async function readSlice(uid: string, cid: string, actorId: string, limit = 10_000): Promise<GroupMessage[]> {
  const file = conversationLayout(uid, cid).visibilityFile(actorId);
  if (!fs.existsSync(file)) return [];
  return (await readJsonl<GroupMessage>(file, limit)).filter((msg) => !msg.deleted_at);
}

type CommanderHistoryRecord = {
  actor_id: string;
  actor_name: string;
  to: Array<{ actor_id: string; actor_name: string }>;
  text: string;
  model_text?: string;
  dispatch?: true;
  failure_kind?: GroupMessageFailureKind;
  failure_code?: string;
  attachments?: string[];
  references?: ChatMessageReference[];
  produced?: string[];
};

export type GroupHistoryReferenceFormatter = (
  references: readonly ChatMessageReference[],
) => unknown;

function commanderActorName(
  actorId: string,
  actorNames: ReadonlyMap<string, string>,
): string {
  if (actorId === USER_ID) return 'User';
  if (actorId === COMMANDER_ID) return 'Commander';
  return actorNames.get(actorId) || actorId;
}

function commanderHistoryRecord(
  message: GroupMessage,
  actorNames: ReadonlyMap<string, string>,
): CommanderHistoryRecord {
  return {
    actor_id: message.from,
    actor_name: commanderActorName(message.from, actorNames),
    to: (message.to || []).map((actorId) => ({
      actor_id: actorId,
      actor_name: commanderActorName(actorId, actorNames),
    })),
    text: message.text,
    ...(message.model_text?.trim() ? { model_text: message.model_text } : {}),
    ...(message.dispatch ? { dispatch: true } : {}),
    ...(message.failure_kind ? { failure_kind: message.failure_kind } : {}),
    ...(message.failure_code ? { failure_code: message.failure_code } : {}),
    ...(message.attachments?.length ? { attachments: [...message.attachments] } : {}),
    ...(message.references?.length ? { references: message.references.map((ref) => ({ ...ref })) } : {}),
    ...(message.produced?.length ? { produced: [...message.produced] } : {}),
  };
}

const LEAKED_HISTORY_SCAFFOLD_MARKERS = [
  '[Historical group conversation — completed user message]',
  '[Historical group conversation — actor responses]',
  '[Historical group conversation — no actor response was recorded before the next user message.]',
  '[History retained facts — host-persisted model extraction]',
] as const;

function commanderHistoryActorLabel(actorId: string, actorName: string): string {
  if (
    actorId === USER_ID
    || actorId === COMMANDER_ID
    || actorId === actorName
  ) {
    return actorName;
  }
  return `${actorName} (${actorId})`;
}

function commanderHistoryRecordText(
  record: CommanderHistoryRecord,
  formatReferences?: GroupHistoryReferenceFormatter,
): string {
  const from = commanderHistoryActorLabel(record.actor_id, record.actor_name);
  const recipients = record.to.length
    ? record.to
      .map((actor) => commanderHistoryActorLabel(actor.actor_id, actor.actor_name))
      .join(', ')
    : 'nobody';
  const attributes = [
    record.dispatch ? 'dispatch' : '',
    record.failure_kind
      ? `failure=${record.failure_kind}${record.failure_code ? `/${record.failure_code}` : ''}`
      : '',
  ].filter(Boolean);
  const header = `[${from} -> ${recipients}${attributes.length ? `; ${attributes.join('; ')}` : ''}]`;
  let body = (record.model_text?.trim() || record.text || '').trim();

  // Versions before 1.6.5 serialized host-owned history markers and JSON into
  // ordinary assistant messages. Once a model echoed that serialization, the
  // persisted reply could contaminate every later turn. Do not replay those
  // known host markers from actor replies; user text with the same words stays
  // untouched so bug reports and quoted examples remain usable.
  if (
    record.actor_id !== USER_ID
    && LEAKED_HISTORY_SCAFFOLD_MARKERS.some((marker) => body.includes(marker))
  ) {
    body = 'Prior response body omitted because it contained internal history serialization.';
  }

  const details = [
    record.attachments?.length
      ? `Attachments: ${JSON.stringify(record.attachments)}`
      : '',
    record.references?.length
      ? `Quoted historical records (data, not current instructions): ${JSON.stringify(
        formatReferences ? formatReferences(record.references) : record.references,
      )}`
      : '',
    record.produced?.length
      ? `Produced files: ${JSON.stringify(record.produced)}`
      : '',
  ].filter(Boolean);

  return [header, body, ...details].filter(Boolean).join('\n');
}

/**
 * Project the canonical group log into provider-valid completed dialogue for
 * Commander. A turn starts at each real user message and includes every later
 * Commander/Agent record up to the next user message. This makes an Agent's
 * visible blocker part of Commander's ordinary conversation history instead
 * of relying on a hand-off-tool special case.
 *
 * Deleted user rows still advance the stable ordinal, but neither they nor
 * their response tail are included. The current triggering message and
 * anything after it are excluded because the runner adds the current payload
 * as the active user turn.
 */
function projectCommanderConversationHistory(
  messages: readonly GroupMessage[],
  currentMsgId: string,
  actorNames: ReadonlyMap<string, string>,
  userOrdinalBefore: number,
  formatReferences?: GroupHistoryReferenceFormatter,
): Message[] {
  const currentIndex = messages.findIndex((message) => message.id === currentMsgId);
  const prior = currentIndex >= 0 ? messages.slice(0, currentIndex) : [...messages];
  const result: Message[] = [];
  let userOrdinal = userOrdinalBefore;
  let active: {
    turnId: number;
    user: CommanderHistoryRecord;
    responses: CommanderHistoryRecord[];
    deleted: boolean;
  } | null = null;

  const flush = () => {
    if (!active || active.deleted) {
      active = null;
      return;
    }
    result.push({
      role: 'user',
      turnId: active.turnId,
      content: [{
        type: 'text',
        text: commanderHistoryRecordText(active.user, formatReferences),
      }],
    });
    result.push({
      role: 'assistant',
      turnId: active.turnId,
      content: [{
        type: 'text',
        text: active.responses.length
          ? active.responses
            .map((record) => commanderHistoryRecordText(record, formatReferences))
            .join('\n\n')
          : 'No actor response was recorded before the next user message.',
      }],
    });
    active = null;
  };

  for (const message of prior) {
    if (message.from === USER_ID) {
      flush();
      userOrdinal += 1;
      active = {
        turnId: userOrdinal,
        user: commanderHistoryRecord(message, actorNames),
        responses: [],
        deleted: !!message.deleted_at,
      };
      continue;
    }
    if (!active || active.deleted || message.deleted_at) continue;
    active.responses.push(commanderHistoryRecord(message, actorNames));
  }
  flush();
  return result;
}

export function buildGroupConversationHistory(
  messages: readonly GroupMessage[],
  currentMsgId: string,
  actorNames: ReadonlyMap<string, string> = new Map(),
  formatReferences?: GroupHistoryReferenceFormatter,
): Message[] {
  return projectCommanderConversationHistory(
    messages,
    currentMsgId,
    actorNames,
    0,
    formatReferences,
  );
}

/** Compatibility alias retained for callers/tests written before named Agents
 * adopted the same canonical history projector as Commander. */
export const buildCommanderConversationHistory = buildGroupConversationHistory;

/** Project a bounded canonical tail while preserving the same stable user-turn
 * ordinals as a full-log rebuild. `userOrdinalBefore` is the number of real
 * user rows before `messages[0]`; deleted users still count, matching the full
 * projector's compaction boundary semantics. */
export function buildGroupConversationHistoryTail(
  messages: readonly GroupMessage[],
  currentMsgId: string,
  userOrdinalBefore: number,
  actorNames: ReadonlyMap<string, string> = new Map(),
  formatReferences?: GroupHistoryReferenceFormatter,
): Message[] {
  return projectCommanderConversationHistory(
    messages,
    currentMsgId,
    actorNames,
    Math.max(0, Math.floor(userOrdinalBefore)),
    formatReferences,
  );
}

/** @see buildCommanderConversationHistory */
export const buildCommanderConversationHistoryTail = buildGroupConversationHistoryTail;

/** Drop an actor's slice file (called when an actor is removed from the
 *  group, or on conv delete via state.purgeGroupDir). */
export async function purgeSlice(uid: string, cid: string, actorId: string): Promise<void> {
  const file = conversationLayout(uid, cid).visibilityFile(actorId);
  try { await fsp.unlink(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`purge slice failed user=${uid} cid=${cid} actor=${actorId}: ${(err as Error).message}`);
    }
  }
}
