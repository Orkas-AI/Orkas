import { readToolResultExcerpt } from './tool-result-tools';
import { hasHistoryProcess, historyMessageIndex, historyMessages, historyRecordText, historyToolResultSource } from '../../features/chat-history-records';
import { withRetrievalBudget, RETRIEVAL_OUTPUT_BUDGET_KEY, DEFAULT_INLINE_RESULT_TOKENS, boundedRetrievalText, estimateToolResultTokens } from '../../util/tool-result-cap';
/**
 * Conversation-history tools injected into main-conversation runners.
 *
 * In project conversations, chat history is a first-class continuity source
 * when the current request depends on earlier project work. Library files
 * remain authoritative for durable facts and documents.
 */

import type { AgentTool, ToolContext } from '#core-agent';
import * as fs from 'node:fs';
import { safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import * as chats from '../../features/chats';
import * as search from '../../features/search';

export interface ChatHistoryToolsOpts {
  userId: string;
  isProgrammaticToolCallContext?: (ctx: ToolContext) => boolean;
  currentCid?: string;
  /** Stable id of the message that triggered this run. Current-scope reads
   * stop strictly before it so a tool cannot observe concurrent/future rows. */
  currentMessageId?: string;
  projectId?: string;
  /** Host-authoritative capability boundary. Group Agents and CLI Agents pass
   * only `current`; Commander passes all three scopes. */
  allowedScopes?: readonly ChatHistoryScope[];
}

export type ChatHistoryScope = 'current' | 'project' | 'all';

const MAX_SEARCH_K = 15;
const DEFAULT_SEARCH_K = 6;
const MAX_HITS_PER_CONVERSATION = 2;
const MAX_READ_WINDOW = 10;
const DEFAULT_READ_WINDOW = 3;
const MAX_LATEST_MESSAGES = 30;
const DEFAULT_LATEST_MESSAGES = 10;
const MAX_CURRENT_SEARCH_CANDIDATES = 200;
const SCORE_EPSILON = 0.1;
const LEGACY_CHAT_READ_PAGE_KEYS = ['msg_index', 'window', 'limit', 'before_msg_index'] as const;

type ChatReadPage = {
  msgIndex?: number;
  window?: number;
  limit?: number;
  beforeMsgIndex?: number;
  fromMsgIndex?: number;
};

type ChatReadPageResult =
  | { page: ChatReadPage; error?: never }
  | { page?: never; error: string };

function chatReadPageSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Read only: mode, optional index/count.',
    properties: {
      mode: {
        type: 'string',
        enum: ['latest', 'around', 'before', 'from'],
        description: 'latest: tail; around: centered on index; before: backward; from: continue at index/record_id.',
      },
      index: {
        type: 'integer',
        minimum: 0,
        description: 'Raw index for around/before/from; ignored for latest.',
      },
      count: {
        type: 'integer',
        minimum: 0,
        description: 'Around radius 0-10; latest/before count 1-30; from remaining count. Defaults to 3 or 10.',
      },
    },
    required: ['mode'],
  };
}

/** Parse the provider-visible tagged page while retaining legacy flat fields
 * for resumed conversations. A tagged page and old paging fields cannot be
 * combined because that would restore the ambiguous provider contract. */
function parseChatReadPage(input: Record<string, unknown>): ChatReadPageResult {
  const rawPage = input.page;
  if (rawPage !== undefined) {
    if (LEGACY_CHAT_READ_PAGE_KEYS.some((key) => input[key] != null)) {
      return { error: '`page` cannot be combined with legacy flat paging fields' };
    }
    if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)) {
      return { error: '`page` must be an object with mode, and index when required' };
    }
    const page = rawPage as Record<string, unknown>;
    const mode = page.mode;
    const hasCount = page.count !== undefined;
    if (mode !== 'latest' && mode !== 'around' && mode !== 'before' && mode !== 'from') {
      return { error: '`page.mode` must be "latest", "around", "before", or "from"' };
    }
    if (hasCount && (!Number.isInteger(page.count) || Number(page.count) < 0)) {
      return { error: '`page.count` must be a non-negative integer' };
    }
    const count = hasCount ? Number(page.count) : undefined;
    if (mode === 'latest') return { page: { ...(count !== undefined ? { limit: count } : {}) } };
    if (!Number.isInteger(page.index) || Number(page.index) < 0) {
      return { error: `\`page.index\` must be a non-negative integer for mode "${mode}"` };
    }
    const index = Number(page.index);
    if (mode === 'from') return { page: { fromMsgIndex: index, ...(count !== undefined ? { limit: count } : {}) } };
    return mode === 'around'
      ? { page: { msgIndex: index, ...(count !== undefined ? { window: count } : {}) } }
      : { page: { beforeMsgIndex: index, ...(count !== undefined ? { limit: count } : {}) } };
  }

  if (input.msg_index != null && input.before_msg_index != null) {
    return { error: '`msg_index` and `before_msg_index` cannot be combined' };
  }
  return {
    page: {
      ...(input.msg_index != null ? { msgIndex: Number(input.msg_index) } : {}),
      ...(input.window != null ? { window: Number(input.window) } : {}),
      ...(input.limit != null ? { limit: Number(input.limit) } : {}),
      ...(input.before_msg_index != null ? { beforeMsgIndex: Number(input.before_msg_index) } : {}),
    },
  };
}

function previewOf(text: unknown): string {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function attrOf(text: unknown): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function messageText(msg: chats.MessageRecord): string {
  const m = msg as chats.MessageRecord & { content?: unknown };
  if (typeof m.text === 'string') return m.text;
  if (typeof m.content === 'string') return m.content;
  return '';
}

function messageActor(msg: chats.MessageRecord): string {
  const m = msg as chats.MessageRecord & { role?: string };
  return m.from || m.role || '';
}

function messageTime(msg: chats.MessageRecord): string {
  const m = msg as chats.MessageRecord & { time?: string };
  return m.ts || m.time || '';
}

type IndexedMessage = {
  index: number;
  message: chats.MessageRecord;
};

/** Reuse the current-turn boundary only while its source revision is unchanged.
 * Sync can rewrite/reorder the log even when the triggering id stays stable. */
const MAX_CACHED_BOUNDARIES = 64;
type CurrentBoundary = { index: number; source: string };
const currentBoundaryCache = new Map<string, CurrentBoundary>();

function currentBoundarySource(userId: string, cid: string): string | undefined {
  const file = conversationMessageReadFile(userId, cid);
  try {
    const stat = fs.statSync(file);
    return JSON.stringify([file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function cachedCurrentBoundaryIndex(
  userId: string,
  cid: string,
  currentMessageId: string | undefined,
): Promise<CurrentBoundary | undefined> {
  if (!currentMessageId) return undefined;
  const key = `${userId}\u0000${cid}\u0000${currentMessageId}`;
  const source = currentBoundarySource(userId, cid);
  const cached = currentBoundaryCache.get(key);
  if (cached && cached.source === source) return cached;
  currentBoundaryCache.delete(key);
  if (!source) return undefined;
  const rows = await indexedConversationMessages(userId, cid);
  if (currentBoundarySource(userId, cid) !== source) return undefined;
  const index = currentBoundaryIndex(rows, currentMessageId);
  if (index === undefined) return undefined;
  if (currentBoundaryCache.size >= MAX_CACHED_BOUNDARIES) {
    const oldest = currentBoundaryCache.keys().next().value;
    if (oldest !== undefined) currentBoundaryCache.delete(oldest);
  }
  const boundary = { index, source };
  currentBoundaryCache.set(key, boundary);
  return boundary;
}

export function _resetCurrentBoundaryCacheForTest(): void {
  currentBoundaryCache.clear();
}

async function indexedConversationMessages(
  userId: string,
  cid: string,
): Promise<IndexedMessage[]> {
  const source = await historyMessageIndex(userId, cid);
  return source.entries.map((entry) => ({ index: entry.index, message: entry.metadata }));

}

function allowedScopes(opts: ChatHistoryToolsOpts): readonly ChatHistoryScope[] {
  const configured: readonly ChatHistoryScope[] = opts.allowedScopes !== undefined
    ? opts.allowedScopes
    : ['current', 'project', 'all'];
  // Never advertise a scope that resolveScope must deterministically reject.
  // This also protects future callers that forget to tailor allowedScopes to
  // the active conversation's project binding.
  return opts.projectId
    ? configured
    : configured.filter((scope) => scope !== 'project');
}

function defaultScope(opts: ChatHistoryToolsOpts): ChatHistoryScope {
  const allowed = allowedScopes(opts);
  if (allowed.length === 1) return allowed[0];
  return opts.projectId ? 'project' : 'all';
}

function resolveScope(
  action: 'search' | 'read',
  input: Record<string, unknown>,
  opts: ChatHistoryToolsOpts,
): { scope: ChatHistoryScope } | { error: { content: string; isError: true } } {
  const toolName = `chat_history(${action})`;
  const raw = String(input.scope || '').trim();
  if (raw && raw !== 'current' && raw !== 'project' && raw !== 'all') {
    return {
      error: {
        content: `${toolName}: invalid scope "${raw}"`,
        isError: true,
      },
    };
  }
  const scope = (raw || defaultScope(opts)) as ChatHistoryScope;
  if (!allowedScopes(opts).includes(scope)) {
    return {
      error: {
        content: `${toolName}: scope "${scope}" is not allowed for this agent`,
        isError: true,
      },
    };
  }
  if (scope === 'current' && !opts.currentCid) {
    return {
      error: {
        content: `${toolName}: current scope is unavailable without an active conversation`,
        isError: true,
      },
    };
  }
  if (scope === 'current' && !opts.currentMessageId) {
    return {
      error: {
        content: `${toolName}: current scope is unavailable without a turn boundary`,
        isError: true,
      },
    };
  }
  if (scope === 'project' && !opts.projectId) {
    return {
      error: {
        content: `${toolName}: project scope is unavailable outside a project`,
        isError: true,
      },
    };
  }
  return { scope };
}

function currentBoundaryIndex(
  rows: IndexedMessage[],
  currentMessageId?: string,
): number | undefined {
  if (!currentMessageId) return undefined;
  return rows.find((row) => row.message.id === currentMessageId)?.index;
}

function currentVisibleRows(
  rows: IndexedMessage[],
  currentMessageId?: string,
): IndexedMessage[] {
  const boundary = currentBoundaryIndex(rows, currentMessageId);
  if (currentMessageId && boundary === undefined) return [];
  return rows.filter(({ index, message }) => (
    (boundary === undefined || index < boundary)
    && !message.deleted_at
    && !message.dispatch
    && messageText(message).trim().length > 0
  ));
}

function timeMs(value: unknown): number {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function relationRank(
  hit: search.SearchResult,
  currentCid?: string,
  projectId?: string,
): number {
  const cid = String(hit.cid || '');
  // Cross-conversation continuity is the point of this tool. When the caller
  // explicitly includes the current conversation, keep it below sibling
  // project conversations whose relevance is effectively tied.
  if (currentCid && cid === currentCid) return 1;
  if (projectId && String(hit.project_id || '') === projectId) return 3;
  return 0;
}

export function rankChatHitsForTest(
  hits: search.SearchResult[],
  currentCid?: string,
  projectId?: string,
): search.SearchResult[] {
  return [...hits].sort((a, b) => {
    const scoreDelta = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (Math.abs(scoreDelta) > SCORE_EPSILON) return scoreDelta;

    const relationDelta = relationRank(b, currentCid, projectId)
      - relationRank(a, currentCid, projectId);
    if (relationDelta) return relationDelta;

    return timeMs(b.time) - timeMs(a.time);
  });
}

// The per-conversation cap keeps sibling conversations visible in cross-
// conversation scopes. Inside `current` scope every hit shares one cid, so the
// cap would silently clamp `k` to two rows and force read-pagination rounds.
export function diversifyChatHitsForTest(
  hits: search.SearchResult[],
  k: number,
  perConversationCap: number = MAX_HITS_PER_CONVERSATION,
): search.SearchResult[] {
  const counts = new Map<string, number>();
  const out: search.SearchResult[] = [];
  for (const hit of hits) {
    const cid = String(hit.cid || '');
    const count = counts.get(cid) || 0;
    if (count >= perConversationCap) continue;
    counts.set(cid, count + 1);
    out.push(hit);
    if (out.length >= k) break;
  }
  return out;
}

function createChatSearchTool(opts: ChatHistoryToolsOpts): AgentTool {
  const scopeEnum = [...allowedScopes(opts)];
  const hasCrossConversationScope = scopeEnum.some((scope) => scope !== 'current');
  const hasProjectScope = scopeEnum.includes('project');
  const currentOnly = scopeEnum.length === 1 && scopeEnum[0] === 'current';
  return {
    name: 'chat_history',
    executionMode: 'parallel',
    // Internal executor: only the consolidated factory's description is exposed.
    description: '',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search only: natural language or keywords with a discriminative name, phrase, id, or fact.',
        },
        k: {
          type: 'number',
          description: 'Search only: default 6, max 15; up to two hits/conversation.',
        },
        scope: {
          type: 'string',
          enum: scopeEnum,
          description: hasProjectScope
            ? 'Search scope. current is host-bound to this conversation. Project includes only this project; use all only for explicit cross-project or non-project recall.'
            : (hasCrossConversationScope
              ? 'Search scope. current is host-bound to this conversation; use all only for explicit cross-conversation recall.'
              : 'Search scope. current is host-bound to this conversation.'),
        },
        ...(hasCrossConversationScope
          ? {
              include_current: {
                type: 'boolean',
                description: hasProjectScope
                  ? 'Search: include this conversation; default false.'
                  : 'Search: include this conversation; default true.',
              },
            }
          : {}),
      },
      required: currentOnly ? ['query', 'scope'] : ['query'],
    },
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'chat_history(search): `query` is required', isError: true };
      const k = boundedInt(input.k, DEFAULT_SEARCH_K, 1, MAX_SEARCH_K);
      const scopeResult = resolveScope('search', input, opts);
      if ('error' in scopeResult) return scopeResult.error;
      const { scope } = scopeResult;
      const includeCurrent = typeof input.include_current === 'boolean'
        ? input.include_current
        : !opts.projectId;

      let boundary: CurrentBoundary | undefined;
      if (scope === 'current' || (includeCurrent && opts.currentCid && opts.currentMessageId)) {
        boundary = await cachedCurrentBoundaryIndex(opts.userId, opts.currentCid!, opts.currentMessageId);
        if (scope === 'current' && opts.currentMessageId && !boundary) {
          return { content: `No conversation-history results for "${query}".` };
        }
      }
      const page = await search.searchChatsWithStatus(opts.userId, query, {
        scope: scope === 'current' ? 'all' : scope,
        ...(scope === 'current'
          ? {
              conversationId: opts.currentCid,
              ...(boundary ? { beforeMsgIndex: boundary.index } : {}),
              userVisibleOnly: true,
              limit: MAX_CURRENT_SEARCH_CANDIDATES,
            }
          : {
              ...(opts.projectId ? { projectId: opts.projectId } : {}),
              ...(!includeCurrent && opts.currentCid ? { excludeCid: opts.currentCid } : {}),
            }),
      });
      if (boundary && currentBoundarySource(opts.userId, opts.currentCid!) !== boundary.source) {
        return { content: 'History search incomplete: source changed during search. Retry against the current history.' };
      }
      const hits = diversifyChatHitsForTest(
        rankChatHitsForTest(page.results.filter((hit) => !opts.currentMessageId || hit.cid !== opts.currentCid || (boundary && Number(hit.msg_index) < boundary.index)), opts.currentCid, opts.projectId),
        k,
        scope === 'current' ? Number.POSITIVE_INFINITY : MAX_HITS_PER_CONVERSATION,
      );
      const status = page.indexComplete ? 'index_complete=true'
        : 'index_complete=false: history indexing is incomplete; matches may be missing. Retry search after indexing or read known records directly.';
      if (!hits.length) return { content: page.indexComplete
        ? `${status}\nNo conversation-history results for "${query}".`
        : `${status}\nNo matches in the indexed portion. This does not establish that the records are absent.`
          + (scope === 'current' ? '\nRead recent records: {"action":"read","scope":"current","page":{"mode":"latest"},"include_process":true}' : '') };

      const scopeLabel = scope === 'current'
        ? 'current-conversation '
        : (scope === 'project' ? 'project-context ' : '');
      const lines: string[] = [status, `${hits.length} hit(s) for "${query}" in ${scopeLabel}conversation history:`];
      for (const h of hits) {
        const cid = String(h.cid || '');
        const msgIndex = Number(h.msg_index);
        const title = String(h.conv_title || '');
        const role = String(h.role || '');
        const time = String(h.time || '');
        const score = typeof h.score === 'number' ? h.score.toFixed(3) : '0.000';
        const project = h.project_name ? ` project="${attrOf(h.project_name)}"` : '';
        const current = opts.currentCid && cid === opts.currentCid ? ' current=true' : '';
        const hitProjectId = String(h.project_id || '');
        const relation = current
          ? 'current'
          : (!hitProjectId
            ? 'non_project'
            : (opts.projectId && hitProjectId === opts.projectId ? 'same_project' : 'other_project'));
        lines.push(
          `- cid=${cid} msg=${Number.isFinite(msgIndex) ? msgIndex : '?'}`
          + (h.msg_id ? ` record_id="${attrOf(h.msg_id)}"` : '')
          + (role ? ` role=${role}` : '')
          + (time ? ` time=${time}` : '')
          + ` score=${score}`
          + current
          + ` relation=${relation}`
          + (title ? ` title="${attrOf(title)}"` : '')
          + project,
        );
        lines.push(`    ${previewOf(h.snippet)}`);
        if (h.process_snippet) lines.push(`    process_match: ${previewOf(h.process_snippet)}`);
        const readScope = scope;
        lines.push(`    read: ${JSON.stringify({ action: 'read', scope: readScope,
          ...(readScope !== 'current' ? { cid } : {}),
          ...(h.msg_id ? { record_id: h.msg_id } : { page: { mode: 'around', index: msgIndex, count: 0 } }),
          include_process: h.has_process === true,
        })}`);
      }
      const budget = Number(ctx.state[RETRIEVAL_OUTPUT_BUDGET_KEY] ?? DEFAULT_INLINE_RESULT_TOKENS);
      return { content: boundedRetrievalText(lines.join('\n'), Math.max(0, budget - 30)) + (estimateToolResultTokens(lines.join('\n')) > budget - 30 ? '\n[More matches omitted; narrow the query or read a hit by record_id.]' : '') };
    },
  };
}

function createChatReadTool(opts: ChatHistoryToolsOpts): AgentTool {
  const scopeEnum = [...allowedScopes(opts)];
  const hasCrossConversationScope = scopeEnum.some((scope) => scope !== 'current');
  const hasProjectScope = scopeEnum.includes('project');
  const currentOnly = scopeEnum.length === 1 && scopeEnum[0] === 'current';
  return {
    name: 'chat_history',
    executionMode: 'parallel',
    // Internal executor: only the consolidated factory's description is exposed.
    description: '',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...(!currentOnly
          ? {
              cid: {
                type: 'string',
                description: hasProjectScope
                  ? 'Search cid; required for project/all, ignored for host-bound current.'
                  : 'Search cid; required for all, ignored for host-bound current.',
              },
            }
          : {}),
        page: chatReadPageSchema(),
        record_id: { type: 'string', description: 'Exact message ID from search/read.' },
        turn_id: { type: 'string', description: 'User message ID or execution turn_id.' },
        tool_call_id: { type: 'string', description: 'Select a stored tool call and its input/output.' },
        output_cursor: { type: 'integer', minimum: 0, description: 'Full tool_call_id output: start at 0, continue returned cursor.' },
        include_process: { type: 'boolean', description: 'Execution records: default true with tool_call_id, else false.' },
        cursor: { type: 'integer', minimum: 0, description: 'Partial-read character cursor.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: DEFAULT_INLINE_RESULT_TOKENS, description: 'Page token budget; default 10K.' },
        scope: {
          type: 'string',
          enum: scopeEnum,
          description: hasProjectScope
            ? 'Read scope. current is host-bound to this conversation. Project includes only this project; other projects and non-project tasks require all.'
            : (hasCrossConversationScope
              ? 'Read scope. current is host-bound to this conversation; all is for explicit cross-conversation recall.'
              : 'Read scope. current is host-bound to this conversation.'),
        },
      },
      required: currentOnly ? ['scope'] : [],
    },
    async execute(input, ctx) {
      const pageResult = parseChatReadPage(input);
      if (pageResult.error) {
        return { content: `chat_history(read): ${pageResult.error}`, isError: true };
      }
      const readPage = pageResult.page;
      const scopeResult = resolveScope('read', input, opts);
      if ('error' in scopeResult) return scopeResult.error;
      const { scope } = scopeResult;
      const requestedCid = String(input.cid ?? '').trim();
      const cid = scope === 'current' ? opts.currentCid! : requestedCid;
      if (!safeId(cid)) return { content: 'chat_history(read): valid `cid` is required', isError: true };

      const conv = await chats.getConversation(opts.userId, cid);
      if (!conv) return { content: `chat_history(read): conversation not found — ${cid}`, isError: true };

      const targetProjectId = String(conv.project_id || '');
      if (scope === 'project' && targetProjectId !== opts.projectId) {
        return {
          content: `chat_history(read): conversation is outside this project context — ${cid}; use scope="all" only for explicit cross-project recall`,
          isError: true,
        };
      }

      const historySource = await historyMessageIndex(opts.userId, cid);
      const indexedMessages = historySource.entries.map((entry) => ({ index: entry.index, message: entry.metadata }));
      const available = cid === opts.currentCid && opts.currentMessageId
        ? currentVisibleRows(indexedMessages, opts.currentMessageId)
        : indexedMessages.filter(({ message }) => !message.deleted_at && !message.dispatch);
      if (!available.length) return { content: `chat_history(read): conversation has no messages — ${cid}` };

      let selected: IndexedMessage[];
      let note: string;

      if (input.record_id || input.turn_id || input.tool_call_id || readPage.fromMsgIndex !== undefined) {
        const recordId = String(input.record_id || '');
        const turnId = String(input.turn_id || '');
        const callId = String(input.tool_call_id || '');
        let userTurn = '';
        selected = available.filter(({ message }) => {
          if (message.from === 'user') userTurn = message.id;
          return (!recordId || readPage.fromMsgIndex !== undefined || message.id === recordId)
            && (!turnId || message.turn_id === turnId || message.source_message_id === turnId || userTurn === turnId)
            && (!callId || ((message as any).tool_call_ids as string[] | undefined)?.includes(callId));
        });
        if (readPage.fromMsgIndex !== undefined) {
          const start = selected.findIndex((row) => recordId ? row.message.id === recordId : row.index >= readPage.fromMsgIndex!);
          selected = start >= 0 ? selected.slice(start, start + boundedInt(readPage.limit, DEFAULT_LATEST_MESSAGES, 1, Number.MAX_SAFE_INTEGER)) : [];
        }
        if (!selected.length) return { content: 'chat_history(read): record unavailable in this scope or before the current turn boundary.', isError: true };
        note = 'selected original records';
      } else if (readPage.msgIndex !== undefined) {
        const msgIndex = Math.floor(readPage.msgIndex);
        const hitPosition = available.findIndex((row) => row.index === msgIndex);
        if (!Number.isFinite(msgIndex) || msgIndex < 0 || hitPosition < 0) {
          return {
            content: `chat_history(read): around index ${msgIndex} is out of range for this scope`,
            isError: true,
          };
        }
        const window = boundedInt(readPage.window, DEFAULT_READ_WINDOW, 0, MAX_READ_WINDOW);
        const loPosition = Math.max(0, hitPosition - window);
        const hiPosition = Math.min(available.length - 1, hitPosition + window);
        const loIndex = available[loPosition].index;
        const hiIndex = available[hiPosition].index;
        note = loIndex === hiIndex ? `msg ${msgIndex}` : `msgs ${loIndex}..${hiIndex} (hit=${msgIndex})`;
        selected = available.slice(loPosition, hiPosition + 1);
      } else {
        let pageRows = available;
        let beforeIndex: number | undefined;
        if (readPage.beforeMsgIndex !== undefined) {
          if (scope !== 'current') {
            return {
              content: 'chat_history(read): page mode "before" is available only for scope "current"',
              isError: true,
            };
          }
          beforeIndex = Math.floor(readPage.beforeMsgIndex);
          if (!Number.isFinite(beforeIndex) || beforeIndex < 0) {
            return {
              content: 'chat_history(read): before index must be a non-negative integer',
              isError: true,
            };
          }
          pageRows = available.filter((row) => row.index < beforeIndex!);
          if (!pageRows.length) {
            return {
              content: `<chat-history cid="${cid}" total="${available.length}" scope="current">\n`
                + '<!-- No earlier readable messages remain. -->\n'
                + '</chat-history>',
            };
          }
        }
        const limit = boundedInt(readPage.limit, DEFAULT_LATEST_MESSAGES, 1, MAX_LATEST_MESSAGES);
        selected = pageRows.slice(-limit);
        note = beforeIndex === undefined
          ? `latest ${selected.length} message(s)`
          : `latest ${selected.length} message(s) before raw index ${beforeIndex}`;
      }

      const lo = selected[0].index;
      const hi = selected[selected.length - 1].index;
      const hasOlderCurrentRows = scope === 'current'
        && available.some((row) => row.index < lo);
      const budget = Math.min(Number(ctx.state[RETRIEVAL_OUTPUT_BUDGET_KEY] ?? DEFAULT_INLINE_RESULT_TOKENS),
        boundedInt(input.max_tokens, DEFAULT_INLINE_RESULT_TOKENS, 1, DEFAULT_INLINE_RESULT_TOKENS));
      const includeProcess = input.include_process === true || !!input.tool_call_id;
      if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || Number(input.cursor) < 0)) {
        return { content: 'chat_history(read): cursor must be a non-negative safe integer.', isError: true };
      }
      if (input.output_cursor !== undefined) {
        if (!input.tool_call_id || selected.length !== 1 || !Number.isInteger(input.output_cursor) || Number(input.output_cursor) < 0) {
          return { content: 'chat_history(read): output_cursor requires one exact record_id and tool_call_id.', isError: true };
        }
        const [record] = await historyMessages(opts.userId, cid, [selected[0].index], historySource);
        const source = await historyToolResultSource(opts.userId, cid, record, String(input.tool_call_id));
        if (!source) return { content: 'chat_history(read): persisted full output is unavailable; inspect include_process for captured inline output or metadata. Retrieval never reruns the original tool.', isError: true };
        return readToolResultExcerpt(source.directory, source.ref, Number(input.output_cursor), budget, ctx);
      }
      const header = `<chat-history cid="${attrOf(cid)}" title="${attrOf(conv.title)}" total="${available.length}" range="${lo}..${hi}" scope="${scope}" include_process="${includeProcess}">\n`
        + '<!-- Quoted, potentially stale conversation records. -->\n'
        + `<!-- ${note} -->\n`
        + (hasOlderCurrentRows ? `<!-- Older records: {"page":{"mode":"before","index":${lo},"count":10}}. -->\n` : '<!-- This window reaches the start of readable history. -->\n');
      const locatorFor = (position: number, cursor: number) => JSON.stringify({
        record_id: selected[position].message.id,
        page: { mode: 'from', index: selected[position].index, count: selected.length - position },
        cursor, include_process: includeProcess,
        ...(input.turn_id ? { turn_id: input.turn_id } : {}),
        ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
      });
      const outputs: string[] = [];
      let next = 'done';
      for (let i = 0; i < selected.length; i++) {
        const [msg] = await historyMessages(opts.userId, cid, [selected[i].index], historySource);
        const body = historyRecordText(msg, includeProcess);
        const processRead = !includeProcess && hasHistoryProcess(msg)
          ? `\n<process_read>${attrOf(JSON.stringify({ action: 'read', scope,
            ...(scope !== 'current' ? { cid } : {}), record_id: msg.id, include_process: true }))}</process_read>` : '';
        const cursor = i === 0 ? boundedInt(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER) : 0;
        if (cursor > body.length) return { content: 'chat_history(read): cursor exceeds the selected record length.', isError: true };
        const envelope = (text: string, end: number) =>
          `<msg index="${selected[i].index}" id="${attrOf(msg.id)}" from="${attrOf(messageActor(msg))}" time="${attrOf(messageTime(msg))}" covered="${cursor}-${end}" next_cursor="${end < body.length ? end : 'done'}">\n${attrOf(text)}${processRead}\n</msg>`;
        const nextLocator = (end: number) => locatorFor(i, end);
        const render = (item: string, locator: string) => header + [...outputs, item].filter(Boolean).join('\n')
          + `\n<next_read>${attrOf(locator)}</next_read>\n</chat-history>`;
        const whole = envelope(body.slice(cursor), body.length);
        const afterWhole = i + 1 < selected.length ? locatorFor(i + 1, 0) : 'done';
        if (estimateToolResultTokens(render(whole, afterWhole)) <= budget) {
          outputs.push(whole);
          next = afterWhole;
          continue;
        }
        let low = cursor, high = body.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (estimateToolResultTokens(render(envelope(body.slice(cursor, mid), mid), nextLocator(mid))) <= budget) low = mid;
          else high = mid - 1;
        }
        if (low > cursor && /[\uD800-\uDBFF]/.test(body[low - 1])) low--;
        if (low > cursor) outputs.push(envelope(body.slice(cursor, low), low));
        next = nextLocator(low);
        break;
      }
      const content = header + outputs.join('\n') + `\n<next_read>${attrOf(next)}</next_read>\n</chat-history>`;
      const fits = estimateToolResultTokens(content) <= budget;
      return { content: fits ? content
        : boundedRetrievalText('No history data delivered: insufficient tool-result budget. Retry the same record/cursor.', budget),
        ...(!fits || !outputs.length ? { isError: true as const } : {}) };

    },
  };
}

type ChatHistoryAction = 'search' | 'read';

const CHAT_HISTORY_ACTION_FIELDS: Readonly<Record<ChatHistoryAction, ReadonlySet<string>>> = {
  // `page` was part of the old provider-visible union schema. Retain runtime
  // compatibility for resumed calls, but the action-discriminated schema no
  // longer advertises it for search.
  search: new Set(['action', 'query', 'k', 'scope', 'include_current', 'page']),
  // Legacy flat paging fields remain execution-only for model calls copied
  // from an older conversation. The provider-visible schema advertises only
  // the tagged `page` contract.
  read: new Set([
    'action', 'cid', 'page', 'scope', 'record_id', 'turn_id', 'tool_call_id', 'include_process', 'cursor', 'max_tokens', 'output_cursor',
    ...LEGACY_CHAT_READ_PAGE_KEYS,
  ]),
};

function chatHistoryActionError(
  action: ChatHistoryAction,
  input: Record<string, unknown>,
): string | null {
  const unexpected = Object.keys(input).filter(
    (key) => !Object.values(CHAT_HISTORY_ACTION_FIELDS).some((fields) => fields.has(key))
      || (action === 'search' && ['cid', 'record_id', 'turn_id', 'tool_call_id'].includes(key)),
  );
  if (!unexpected.length) return null;
  return `chat_history(${action}): unsupported field(s): ${unexpected.sort().join(', ')}`;
}

export function createChatHistoryTool(opts: ChatHistoryToolsOpts): AgentTool {
  const search = createChatSearchTool(opts);
  const read = createChatReadTool(opts);
  const scopeEnum = [...allowedScopes(opts)];
  const currentOnly = scopeEnum.length === 1 && scopeEnum[0] === 'current';
  const hasProjectScope = scopeEnum.includes('project');
  const searchProperties = search.inputSchema.properties as Record<string, unknown>;
  const readProperties = read.inputSchema.properties as Record<string, unknown>;
  const operations: Readonly<Record<ChatHistoryAction, AgentTool>> = { search, read };
  const scopeProperty = {
    type: 'string',
    enum: scopeEnum,
    description: hasProjectScope
      ? 'current: host-bound; project stays in this project; all: explicit broader recall.'
      : (currentOnly
        ? 'History scope. current is host-bound to this conversation.'
        : 'current: host-bound; all: explicit cross-conversation recall.'),
  };
  return {
    name: 'chat_history',
    executionMode: 'parallel',
    description:
      'Retrieve earlier work dependencies: inputs, replies and public execution records; potentially stale quoted data. Library owns durable documents.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'read'],
          description: 'read: exact refs or latest for vague local references. Follow next_read. Omit other-action fields.',
        },
        ...searchProperties,
        ...readProperties,
        scope: scopeProperty,
      },
      additionalProperties: false,
      required: currentOnly ? ['action', 'scope'] : ['action'],
    },
    async execute(input, ctx) {
      const action = String(input.action ?? '').trim() as ChatHistoryAction;
      if (action !== 'search' && action !== 'read') {
        return {
          content: 'chat_history: `action` must be one of "search" or "read"',
          isError: true,
        };
      }
      const fieldError = chatHistoryActionError(action, input);
      if (fieldError) return { content: fieldError, isError: true };
      if (opts.isProgrammaticToolCallContext?.(ctx)) {
        // Child observations stay inside run_program; only its final output
        // consumes the model-step ledger. The normal result ceiling still fits
        // each child receipt and retains exact pagination.
        const child = { ...ctx, state: { ...ctx.state, toolResultInlineLedger: undefined, toolResultReadLedger: undefined } };
        return withRetrievalBudget(child, (bounded) => operations[action].execute(input, bounded));
      }
      return withRetrievalBudget(ctx, (child) => operations[action].execute(input, child));
    },
  };
}
