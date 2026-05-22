/**
 * Conversation-history tools injected into main-conversation runners.
 *
 * These tools are intentionally lower-priority than the knowledge base:
 * chat logs are useful for "what did we discuss before" recall, but KB files
 * remain the authoritative source for durable facts and documents.
 */

import type { AgentTool } from '#core-agent';
import { safeId } from '../../storage';
import * as chats from '../../features/chats';
import * as search from '../../features/search';

export interface ChatHistoryToolsOpts {
  userId: string;
  currentCid?: string;
}

const MAX_SEARCH_K = 15;
const DEFAULT_SEARCH_K = 5;
const MAX_READ_WINDOW = 10;
const DEFAULT_READ_WINDOW = 3;
const MAX_LATEST_MESSAGES = 30;
const DEFAULT_LATEST_MESSAGES = 20;
const SCORE_EPSILON = 0.1;

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

function formatMessage(index: number, msg: chats.MessageRecord): string {
  const actor = messageActor(msg) || 'unknown';
  const time = messageTime(msg);
  const body = messageText(msg).trim();
  return `<msg index="${index}" from="${actor}"${time ? ` time="${time}"` : ''}>\n${body}\n</msg>`;
}

function timeMs(value: unknown): number {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

export function rankChatHitsForTest(hits: search.SearchResult[], currentCid?: string): search.SearchResult[] {
  return [...hits].sort((a, b) => {
    const scoreDelta = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (Math.abs(scoreDelta) > SCORE_EPSILON) return scoreDelta;

    const aCurrent = currentCid && String(a.cid || '') === currentCid ? 1 : 0;
    const bCurrent = currentCid && String(b.cid || '') === currentCid ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;

    return timeMs(b.time) - timeMs(a.time);
  });
}

function createChatSearchTool(opts: ChatHistoryToolsOpts): AgentTool {
  return {
    name: 'chat_search',
    description:
      'Search across the current user\'s conversation history. Use this only after\n'
      + '`kb_search` / `kb_read` when the user asks about prior chats, previous\n'
      + 'decisions, or historical working context that may not have been saved to\n'
      + 'the knowledge base. Chat history is informal and may be stale; treat it as\n'
      + 'supporting context, not as an authoritative source.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query over conversation messages. Natural language or keywords both work.',
        },
        k: {
          type: 'number',
          description: 'Top-k result count. Default 5, max 15.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'chat_search: `query` is required', isError: true };
      const k = boundedInt(input.k, DEFAULT_SEARCH_K, 1, MAX_SEARCH_K);

      const hits = rankChatHitsForTest(await search.searchChats(opts.userId, query), opts.currentCid).slice(0, k);
      if (!hits.length) return { content: `No conversation-history results for "${query}".` };

      const lines: string[] = [`${hits.length} hit(s) for "${query}" in conversation history:`];
      for (const h of hits) {
        const cid = String(h.cid || '');
        const msgIndex = Number(h.msg_index);
        const title = String(h.conv_title || '');
        const role = String(h.role || '');
        const time = String(h.time || '');
        const score = typeof h.score === 'number' ? h.score.toFixed(3) : '0.000';
        const project = h.project_name ? ` project="${attrOf(h.project_name)}"` : '';
        const current = opts.currentCid && cid === opts.currentCid ? ' current=true' : '';
        lines.push(
          `- cid=${cid} msg=${Number.isFinite(msgIndex) ? msgIndex : '?'}`
          + (role ? ` role=${role}` : '')
          + (time ? ` time=${time}` : '')
          + ` score=${score}`
          + current
          + (title ? ` title="${attrOf(title)}"` : '')
          + project,
        );
        lines.push(`    ${previewOf(h.snippet)}`);
      }
      lines.push('Use chat_read({ cid, msg_index, window }) to inspect surrounding messages.');
      return { content: lines.join('\n') };
    },
  };
}

function createChatReadTool(opts: ChatHistoryToolsOpts): AgentTool {
  return {
    name: 'chat_read',
    description:
      'Read messages from one conversation. Pair with `chat_search`: pass a hit\'s\n'
      + '`cid` and `msg_index` to fetch nearby context. If `msg_index` is omitted,\n'
      + 'returns the latest messages from that conversation. Prefer KB tools for\n'
      + 'durable facts; use chat_read for informal prior-chat context.',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: 'Conversation id, usually the `cid` returned by chat_search.',
        },
        msg_index: {
          type: 'number',
          description: 'Zero-based message index returned by chat_search. Omit to read latest messages.',
        },
        window: {
          type: 'number',
          description: 'When msg_index is set, include ±window nearby messages. Default 3, max 10.',
        },
        limit: {
          type: 'number',
          description: 'When msg_index is omitted, latest message count. Default 20, max 30.',
        },
      },
      required: ['cid'],
    },
    async execute(input) {
      const cid = String(input.cid ?? '').trim();
      if (!safeId(cid)) return { content: 'chat_read: valid `cid` is required', isError: true };

      const conv = await chats.getConversation(opts.userId, cid);
      if (!conv) return { content: `chat_read: conversation not found — ${cid}`, isError: true };

      const allMessages = await chats.getMessages(opts.userId, cid, Number.MAX_SAFE_INTEGER);
      if (!allMessages.length) return { content: `chat_read: conversation has no messages — ${cid}` };

      let lo: number;
      let hi: number;
      let note: string;

      if (input.msg_index != null) {
        const msgIndex = Math.floor(Number(input.msg_index));
        if (!Number.isFinite(msgIndex) || msgIndex < 0 || msgIndex >= allMessages.length) {
          return {
            content: `chat_read: msg_index ${msgIndex} out of range; total=${allMessages.length}`,
            isError: true,
          };
        }
        const window = boundedInt(input.window, DEFAULT_READ_WINDOW, 0, MAX_READ_WINDOW);
        lo = Math.max(0, msgIndex - window);
        hi = Math.min(allMessages.length - 1, msgIndex + window);
        note = lo === hi ? `msg ${msgIndex}` : `msgs ${lo}..${hi} (hit=${msgIndex})`;
      } else {
        const limit = boundedInt(input.limit, DEFAULT_LATEST_MESSAGES, 1, MAX_LATEST_MESSAGES);
        lo = Math.max(0, allMessages.length - limit);
        hi = allMessages.length - 1;
        note = `latest ${hi - lo + 1} message(s)`;
      }

      const body = allMessages.slice(lo, hi + 1)
        .map((msg, offset) => formatMessage(lo + offset, msg))
        .join('\n\n');
      return {
        content:
          `<chat-history cid="${cid}" title="${attrOf(conv.title)}" total="${allMessages.length}" range="${lo}..${hi}">\n`
          + `<!-- ${note} -->\n`
          + `${body}\n`
          + '</chat-history>',
      };
    },
  };
}

export function createChatHistoryTools(opts: ChatHistoryToolsOpts): AgentTool[] {
  return [createChatSearchTool(opts), createChatReadTool(opts)];
}
