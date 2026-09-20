import { projectHistoryMediaText, stringifyHistoryMedia } from '../util/history-media';
/** Canonical history metadata and exact records, without renderer spill writes. */
import { conversationMessageReadFile } from '../util/project-layout';
import { getIndexedJsonl, readIndexedJsonlRecords } from '../util/indexed-jsonl';
import type { MessageRecord } from './chats';

function isPublicExecutionEvent(event: any): boolean {
  if (!event || event.stream === 'thinking' || event.stream === 'reasoning') return false;
  const type = String(event.data?.type || '');
  return event.stream === 'tool'
    || (event.stream === 'cli' && type === 'tool-event')
    || ['tool_start', 'tool_end', 'tool_result', 'tool_use', 'tool_progress', 'error', 'done'].includes(type);
}

function metadata(message: MessageRecord & { content?: unknown; role?: string; time?: string }) {
  return { id: message.id, to: message.to, from: message.from || message.role, ts: message.ts || message.time,
    turn_id: message.turn_id, source_message_id: message.source_message_id,
    deleted_at: message.deleted_at, dispatch: message.dispatch,
    // A truthy placeholder preserves visibility filtering without caching bodies.
    tool_call_ids: Array.isArray(message.process) ? message.process.flatMap((item: any) => isPublicExecutionEvent(item?.event) && item.event.data?.id ? [String(item.event.data.id)] : []) : [],
    text: message.text || message.content || (message.process?.length ? '[Execution records]' : '') ? '[Stored record]' : '' } as MessageRecord;
}
export async function historyMessageIndex(userId: string, cid: string) {
  const file = conversationMessageReadFile(userId, cid);
  return getIndexedJsonl(file, metadata);
}
export async function historyMessages(userId: string, cid: string, indexes: readonly number[], source?: Awaited<ReturnType<typeof historyMessageIndex>>): Promise<MessageRecord[]> {
  const file = conversationMessageReadFile(userId, cid);
  const index = source ?? await historyMessageIndex(userId, cid);
  return readIndexedJsonlRecords<MessageRecord>(file, index, indexes.map((i) => index.entries[i]).filter(Boolean));
}

function isPublicProcessItem(item: any): boolean {
  return (item?.type === 'progress' && typeof item.text === 'string')
    || (item?.type === 'event' && isPublicExecutionEvent(item.event));
}

export function hasHistoryProcess(message: { process?: unknown }): boolean {
  return Array.isArray(message.process) && message.process.some(isPublicProcessItem);
}

export function* historyProcessTexts(message: { process?: unknown }, contentOnly = false): Generator<string> {
  if (!Array.isArray(message.process)) return;
  for (let i = 0; i < message.process.length; i++) {
    const item = message.process[i];
    if (isPublicProcessItem(item)) {
      const data = item.event?.data;
      // Snippets match payloads before transport metadata; exact reads retain
      // captured event fields and stable process positions, omitting media bytes.
      const value = item.type === 'progress' ? item.text
        : contentOnly ? data?.output ?? data?.input ?? data?.arguments ?? item.event : item.event;
      yield `[process ${i}] ${typeof value === 'string' ? projectHistoryMediaText(value) : stringifyHistoryMedia(value)}`;
    }
  }
}

/** Explicit process events are archived evidence, never inferred intent. Public
 * tool calls/results and progress only; private model reasoning is excluded. */
export function historyRecordText(message: { text?: unknown; content?: unknown; process?: unknown; attachments?: unknown; references?: unknown; produced?: unknown }, includeProcess = false): string {
  const parts = [projectHistoryMediaText(typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : '')];
  for (const field of ['attachments', 'references', 'produced'] as const) {
    if (Array.isArray(message[field]) && message[field].length) parts.push(`${field}: ${stringifyHistoryMedia(message[field])}`);
  }
  if (includeProcess) for (const text of historyProcessTexts(message)) parts.push(text);
  return parts.filter(Boolean).join('\n');
}

export async function historyMessagesAtFile(file: string, indexes: ReadonlySet<number>): Promise<Map<number, MessageRecord>> {
  const source = await getIndexedJsonl(file, metadata);
  const entries = [...indexes].map((i) => source.entries[i]).filter(Boolean);
  const records = await readIndexedJsonlRecords<MessageRecord>(file, source, entries);
  return new Map(records.map((record, i) => [entries[i].index, record]));
}

/** Resolve a stored spill through the owning account/conversation/actor. Never
 * accept a caller-selected filesystem path, including paths forged in old logs. */
export async function historyToolResultSource(userId: string, cid: string, message: MessageRecord, callId: string): Promise<{ directory: string; ref: string } | undefined> {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const { cloudSessionToolResultsDirFor } = await import('../util/project-layout');
  const { buildGconvSessionId, buildGmemberSessionId } = await import('./group_chat/state');
  const { safeId } = await import('../storage');
  if (!safeId(cid) || !safeId(message.from)) return undefined;
  const entry = message.process?.find((item: any) => item?.event?.stream === 'tool'
    && item.event.data?.id === callId && item.event.data?.phase === 'end') as any;
  const storedPath = entry?.event?.data?.result_path;
  if (typeof storedPath !== 'string') return undefined;
  const name = path.win32.basename(path.posix.basename(storedPath));
  if (!/^[a-zA-Z0-9_-]{1,48}\.(?:[a-f0-9]{16}|[a-f0-9]{64})\.txt$/.test(name)) return undefined;
  const sid = message.from === 'commander' ? buildGconvSessionId(cid) : buildGmemberSessionId(cid, message.from);
  const directory = cloudSessionToolResultsDirFor(userId, sid);
  // Sync may move the original absolute path between devices. Resolve only
  // its opaque basename under the authoritative local conversation directory.
  try {
    const root = await fs.realpath(directory);
    const file = await fs.realpath(path.join(root, name));
    if (path.dirname(file) !== root || !(await fs.stat(file)).isFile()) return undefined;
    return { directory: root, ref: name.slice(0, -4) };
  } catch { return undefined; }
}
