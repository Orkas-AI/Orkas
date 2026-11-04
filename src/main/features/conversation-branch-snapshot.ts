import type { GroupMessage } from './group_chat/visibility';

export interface ConversationBranchSource {
  conversationId: string;
  messages: readonly GroupMessage[];
  /** The caller must supply the whole stable transcript, not a history page. */
  complete: boolean;
  processing: boolean;
}

export interface ConversationBranchSnapshot {
  sourceConversationId: string;
  throughUserMessageId: string;
  messages: Array<{ sourceMessageId: string; ts: string; from: string; text: string }>;
}

export type ConversationBranchSnapshotResult =
  | { ok: true; snapshot: ConversationBranchSnapshot }
  | { ok: false; error: 'invalid_request' | 'source_not_ready' | 'turn_not_found'
    | 'ambiguous_message' | 'unsupported_history' | 'turn_incomplete'
    | 'overlapping_turns' | 'history_too_large' };

// This first stage snapshots visible text only. Unknown contextual payloads
// must be handled deliberately before a future caller can materialize a branch.
const TEXT_MESSAGE_FIELDS = new Set([
  'id', 'ts', 'from', 'to', 'text', 'display_text', 'model_text', 'received_at_ms',
  'unknown_mentions', 'mentions', 'turn_id', 'client_msg_id', 'source_message_id',
  'task_id', 'run_facts', 'dispatch', 'seg', 'display_phase', 'process', '_v',
]);

/** Prepare a bounded text snapshot; does not create a task or replay history.
 * The eventual host caller must resolve account ownership, read the complete
 * canonical transcript and confirm it stayed settled during the read. Source
 * ids are provenance, not ids to reuse in a new conversation. Resource copying,
 * actor/session setup, model-history projection and UI are separate work.
 */
export function buildConversationBranchSnapshot(
  source: ConversationBranchSource,
  throughUserMessageId: string,
  limits: { maxMessages: number; maxTextBytes: number },
): ConversationBranchSnapshotResult {
  if (typeof source.conversationId !== 'string' || !source.conversationId.trim()
      || typeof throughUserMessageId !== 'string' || !throughUserMessageId.trim()
      || !Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 1
      || !Number.isSafeInteger(limits.maxTextBytes) || limits.maxTextBytes < 1) {
    return { ok: false, error: 'invalid_request' };
  }
  if (source.complete !== true || source.processing !== false) {
    return { ok: false, error: 'source_not_ready' };
  }
  const records = source.messages;
  if (records.length > limits.maxMessages) return { ok: false, error: 'history_too_large' };

  const identities = new Set<string>();
  let selected = -1;
  for (let i = 0; i < records.length; i++) {
    const message = records[i];
    if (!message || typeof message.id !== 'string' || !message.id.trim()
        || typeof message.ts !== 'string' || typeof message.from !== 'string' || !message.from
        || typeof message.text !== 'string') {
      return { ok: false, error: 'unsupported_history' };
    }
    if (identities.has(message.id)) return { ok: false, error: 'ambiguous_message' };
    identities.add(message.id);
    if (message.display_phase === 'pending') return { ok: false, error: 'source_not_ready' };
    if (message.id === throughUserMessageId && message.from === 'user' && !message.dispatch) selected = i;
  }
  if (selected < 0) return { ok: false, error: 'turn_not_found' };
  let end = selected + 1;
  while (end < records.length && (records[end].from !== 'user' || records[end].dispatch)) end++;

  const snapshot: ConversationBranchSnapshot = {
    sourceConversationId: source.conversationId, throughUserMessageId, messages: [],
  };
  const prefixIds = new Set<string>();
  let turnIds = new Set<string>();
  let currentUser = '';
  let finalReply = false;
  let textBytes = 0;
  for (let i = 0; i < end; i++) {
    const message = records[i];
    if (message.deleted_at) return { ok: false, error: 'unsupported_history' };
    if (message.from === 'user') {
      currentUser = message.id;
      turnIds = new Set();
    } else if (!currentUser || (message.source_message_id && !turnIds.has(message.source_message_id))) {
      // Concurrent replies may be appended after a newer user request. A
      // chronological prefix is not a complete turn in that case.
      return { ok: false, error: 'overlapping_turns' };
    }
    prefixIds.add(message.id);
    turnIds.add(message.id);
    if (message.dispatch) continue;
    for (const [key, value] of Object.entries(message)) {
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)
          && !TEXT_MESSAGE_FIELDS.has(key)) {
        return { ok: false, error: 'unsupported_history' };
      }
    }
    const text = message.display_text ?? message.text;
    if (typeof text !== 'string') return { ok: false, error: 'unsupported_history' };
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > limits.maxTextBytes) return { ok: false, error: 'history_too_large' };
    snapshot.messages.push({ sourceMessageId: message.id, ts: message.ts, from: message.from, text });
    if (currentUser === throughUserMessageId && message.from !== 'user' && text.trim()
        && (message.display_phase === undefined || message.display_phase === 'final_answer')) finalReply = true;
  }
  for (let i = end; i < records.length; i++) {
    const message = records[i];
    if (message.from !== 'user' && message.source_message_id && prefixIds.has(message.source_message_id)) {
      return { ok: false, error: 'overlapping_turns' };
    }
  }
  if (!finalReply) return { ok: false, error: 'turn_incomplete' };
  return { ok: true, snapshot };
}
