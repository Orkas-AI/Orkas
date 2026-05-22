/**
 * Group-chat visibility — per-actor message slices.
 *
 * Bus calls `appendVisible` for every newly-emitted group message. The slice
 * is the agent worker's source of truth: when its session is first created
 * (worker startup or after eviction), `replaySliceIntoSession` reads the
 * jsonl and feeds the entries into the PersistentSession so the LLM picks
 * up where it left off.
 *
 * Visibility rule per actor (also documented in CLAUDE.md §5):
 *   commander → every group message
 *   agent X   → messages where X is in {from, to, mentions} OR
 *               (from == commander && to includes X)
 *   user      → reads `<cid>.jsonl` directly; no slice file
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

import {
  groupChatVisibilityDir, groupChatVisibilityFile,
} from '../../paths';
import { appendJsonlAtomic, readJsonl } from '../../storage';
import { COMMANDER_ID, USER_ID } from './state';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.visibility');

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
  /** Markdown text body. */
  text: string;
  /** Attachment filenames (only meaningful for user messages). */
  attachments?: string[];
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
  reason?: string;
  status: 'pending' | 'installed' | 'skipped' | 'failed';
  requested_at: string;
  resolved_at?: string;
  error?: string;
}

// ── Slice IO ─────────────────────────────────────────────────────────────

function isVisibleTo(actorId: string, msg: GroupMessage): boolean {
  if (actorId === COMMANDER_ID) return true; // sees all
  if (actorId === USER_ID) return true;       // reads main jsonl directly; we don't write a slice
  if (msg.from === actorId) return true;
  if (msg.to.includes(actorId)) return true;
  if (msg.mentions && msg.mentions.includes(actorId)) return true;
  // Commander → @<actor> messages: already covered by msg.to. Belt-and-suspenders.
  if (msg.from === COMMANDER_ID && msg.to.includes(actorId)) return true;
  return false;
}

/** Append the message to every actor's slice that should see it. */
export async function appendVisible(uid: string, cid: string, msg: GroupMessage, actorIds: string[]): Promise<void> {
  fs.mkdirSync(groupChatVisibilityDir(uid, cid), { recursive: true });
  for (const actorId of actorIds) {
    if (actorId === USER_ID) continue; // user reads main jsonl
    if (!isVisibleTo(actorId, msg)) continue;
    const file = groupChatVisibilityFile(uid, cid, actorId);
    try {
      await appendJsonlAtomic<GroupMessage>(file, msg);
    } catch (err) {
      log.warn(`append visible failed user=${uid} cid=${cid} actor=${actorId}: ${(err as Error).message}`);
    }
  }
}

export async function readSlice(uid: string, cid: string, actorId: string, limit = 10_000): Promise<GroupMessage[]> {
  const file = groupChatVisibilityFile(uid, cid, actorId);
  if (!fs.existsSync(file)) return [];
  return readJsonl<GroupMessage>(file, limit);
}

/** Drop an actor's slice file (called when an actor is removed from the
 *  group, or on conv delete via state.purgeGroupDir). */
export async function purgeSlice(uid: string, cid: string, actorId: string): Promise<void> {
  const file = groupChatVisibilityFile(uid, cid, actorId);
  try { await fsp.unlink(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`purge slice failed user=${uid} cid=${cid} actor=${actorId}: ${(err as Error).message}`);
    }
  }
}

/**
 * Build the user-facing prompt prefix that an agent's worker sees on its
 * very first turn. The prefix tells the agent who's in the group, then
 * replays its visible message history as a transcript. Subsequent turns
 * don't get the transcript again — the persistent session has it.
 *
 * We prefer a prompt prefix over poking PersistentSession's internal state
 * because (a) the public ctor only takes a session file path, and we don't
 * own the message format, and (b) it keeps the agent's view human-readable
 * if you cat the session jsonl during debugging.
 */
export interface SliceReplay {
  /** True if this was the agent's first turn (slice had history before the
   *  current message), prompting the bus to inject a full transcript. */
  firstTurn: boolean;
  /** Optional prefix to prepend to the message that triggered this turn.
   *  Empty string if nothing to inject. */
  prefix: string;
}

export function buildReplayPrefix(slice: GroupMessage[], currentMsgId: string): SliceReplay {
  // Drop the triggering message itself (it's about to be sent as the user
  // turn) and anything strictly after it.
  const idx = slice.findIndex((m) => m.id === currentMsgId);
  const history = idx >= 0 ? slice.slice(0, idx) : slice;
  if (history.length === 0) return { firstTurn: true, prefix: '' };

  const lines = ['<group-chat-history>'];
  for (const m of history) {
    const mention = m.to && m.to.length ? ` to=${m.to.join(',')}` : '';
    lines.push(`<msg from=${m.from}${mention} ts=${m.ts}>`);
    lines.push(m.text);
    lines.push('</msg>');
  }
  lines.push('</group-chat-history>');
  return { firstTurn: true, prefix: lines.join('\n') + '\n\n' };
}
