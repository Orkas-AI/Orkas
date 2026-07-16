#!/usr/bin/env node
require('./proxy-bootstrap.cjs');
// Gmail MCP server (stdio) — wraps the public Gmail REST API behind the MCP tool-use
// protocol. Spawned as a child process by `features/connectors/mcp-client.ts`; OAuth
// access_token is injected through `GOOGLE_ACCESS_TOKEN` env (see `apply-template.ts`).
//
// Why this exists: Google's hosted `gmailmcp.googleapis.com` is in Developer Preview with a
// project-level allowlist that third-party OAuth clients can't get on without enrollment in
// the Workspace Developer Preview Program. The underlying Gmail REST API
// (`gmail.googleapis.com`, GA since 2014) has no such gate, so we wrap it ourselves. The
// catalog entry's transport_template references this script via the `${ORKAS_NODE}` +
// `${ORKAS_PC_DIR}/bin/gmail-mcp-server.cjs` placeholder pair, which `apply-template.ts`
// resolves to Electron's binary path running with `ELECTRON_RUN_AS_NODE=1` so we don't
// require the user to have node on PATH.
//
// Tool surface (5 tools, v1):
//   - search_messages(query, maxResults?)               → list of message ids + snippets + headers
//   - get_message(id, format?)                          → headers + body preview (full = decoded text, 8KB cap)
//   - list_labels()                                     → user's Gmail labels
//   - send_message(to, subject, body, cc?, bcc?, threadId?)  → builds RFC 2822 + base64url-encoded `raw` blob; threadId for replies
//   - modify_message_labels(id, addLabelIds?, removeLabelIds?)  → archive (remove INBOX), mark read (remove UNREAD), star (add STARRED), etc.
//
// TODO (v2): get_attachment(messageId, attachmentId); html body in send_message.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_BYTES = 8 * 1024;  // 8 KB cap on the decoded body text; attachments still show up as metadata-only

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_messages',
    description:
      'Search Gmail messages using Gmail query syntax (e.g. "in:inbox", "from:foo@example.com", ' +
      '"is:unread", "after:2024/01/01", combinations like "in:inbox is:unread"). Returns a list ' +
      'of messages with id, threadId, snippet, and key headers (From, Subject, Date). For full ' +
      'body, call `get_message` with the returned id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query syntax. Required.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10, max 50.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_message',
    description:
      'Fetch a single Gmail message. `format=metadata` (default) returns headers + snippet. ' +
      '`format=full` adds the decoded body text (truncated to 8KB to keep model context manageable). ' +
      'Attachments are listed as metadata only (mime, filename, size, attachmentId) — call a ' +
      'dedicated download tool to fetch attachment bytes (not implemented in v1).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message id (from search_messages).' },
        format: {
          type: 'string',
          enum: ['minimal', 'metadata', 'full'],
          description: 'Default metadata.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_labels',
    description: 'List the user\'s Gmail labels. Useful for resolving label names to ids for filters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_message',
    description:
      'Send an email via the user\'s Gmail. v1 body is plain text only. Pass `threadId` to reply ' +
      'within an existing thread (the thread id is returned by `search_messages` / `get_message`). ' +
      '`to` / `cc` / `bcc` accept either a single email string or an array of strings.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { description: 'Recipient(s). String or array of strings.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body.' },
        cc: { description: 'String or array of strings.' },
        bcc: { description: 'String or array of strings.' },
        threadId: { type: 'string', description: 'Reply within this thread.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'modify_message_labels',
    description:
      'Add and/or remove labels on a message. Common system label ids: `INBOX` (remove to archive), ' +
      '`UNREAD` (remove to mark as read; add to mark unread), `STARRED` (add to star), `SPAM`, `TRASH`, ' +
      '`IMPORTANT`. Use `list_labels` for custom label ids. Returns the updated labelIds.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message id.' },
        addLabelIds: { type: 'array', items: { type: 'string' } },
        removeLabelIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'batch_modify_messages',
    description: 'Add/remove labels on multiple messages in one call (e.g. archive 50 at once). Same label semantics as `modify_message_labels`.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Up to 1000 message ids.' },
        addLabelIds: { type: 'array', items: { type: 'string' } },
        removeLabelIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids'],
    },
  },
  {
    name: 'trash_message',
    description: 'Move a message to Trash. Reversible via `untrash_message` until Gmail empties trash (~30d).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'untrash_message',
    description: 'Restore a trashed message back to its prior labels.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_threads',
    description: 'Search at the thread level (returns thread ids + snippets). Same query syntax as `search_messages`. Use when the user asks about conversations rather than individual messages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10, max 50.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_thread',
    description: 'Fetch a full Gmail thread — every message in the conversation, with their headers + snippets. `format=full` adds decoded body per message (each capped at 8KB).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Thread id (from search/get_message or list_threads).' },
        format: { type: 'string', enum: ['minimal', 'metadata', 'full'], description: 'Default metadata.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_attachment',
    description: 'Download an attachment as base64-encoded data. `messageId` + `attachmentId` come from `get_message` with `format=full`. Returns `{data: base64, size, mimeType}` — caller decodes if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        attachmentId: { type: 'string' },
      },
      required: ['messageId', 'attachmentId'],
    },
  },
  {
    name: 'list_drafts',
    description: 'List drafts in the user\'s Gmail. Returns each draft\'s id + message metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      },
    },
  },
  {
    name: 'get_draft',
    description: 'Fetch a single draft by id. `format=full` decodes the body (8KB cap).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['minimal', 'metadata', 'full'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_draft',
    description: 'Save a new draft without sending. Same fields as `send_message` (to / subject / body / cc / bcc / threadId).',
    inputSchema: {
      type: 'object',
      properties: {
        to: {},
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: {},
        bcc: {},
        threadId: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'update_draft',
    description: 'Replace a draft\'s content. All recipients / subject / body are overwritten (full replace, not patch).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Draft id.' },
        to: {},
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: {},
        bcc: {},
        threadId: { type: 'string' },
      },
      required: ['id', 'to', 'subject', 'body'],
    },
  },
  {
    name: 'send_draft',
    description: 'Send an existing draft. Returns the sent message id + threadId.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'delete_draft',
    description: 'Permanently delete a draft (not the same as trashing a sent message — drafts have no trash).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_label',
    description: 'Create a custom Gmail label. Returns the new label id (use it with `modify_message_labels`).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Label display name. Nested via slashes: "Work/Project A".' },
        messageListVisibility: { type: 'string', enum: ['show', 'hide'] },
        labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_label',
    description: 'Rename or re-configure a custom label.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        messageListVisibility: { type: 'string', enum: ['show', 'hide'] },
        labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_label',
    description: 'Permanently delete a custom label. Messages keep their content; this label is just removed from them.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

// ── RFC 2822 helpers for send_message ─────────────────────────────────

function _normalizeAddrs(v) {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'string').map((x) => x.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

// Per RFC 2047: non-ASCII header values → base64-encoded word `=?utf-8?B?...?=`. ASCII passthrough
// keeps headers readable for English-only sends.
// eslint-disable-next-line no-control-regex
const _ASCII_ONLY = /^[\x00-\x7F]*$/;
function _encodeHeader(s) {
  return _ASCII_ONLY.test(s) ? s : `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function _b64urlEncode(bytes) {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _base64MimeBody(s) {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trimEnd();
}

// Builds the `{raw, threadId?}` body shape used by both `messages.send` and `drafts` endpoints.
// Plain-text v1; HTML body deferred. Centralized so send_message / create_draft / update_draft
// produce identical wire format.
function _buildRawMessage(args) {
  const to = _normalizeAddrs(args.to);
  if (!to.length) throw new Error('to is required (string or array of strings)');
  const cc = _normalizeAddrs(args.cc);
  const bcc = _normalizeAddrs(args.bcc);
  const subject = String(args.subject || '');
  const body = String(args.body || '');
  const headers = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${_encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const rfc2822 = `${headers.join('\r\n')}\r\n\r\n${_base64MimeBody(body)}`;
  return {
    raw: _b64urlEncode(Buffer.from(rfc2822, 'utf8')),
    ...(args.threadId ? { threadId: String(args.threadId) } : {}),
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────

async function gmailFetch(pathAndQuery, init) {
  if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN env var not set');
  const url = `${BASE}${pathAndQuery}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(init?.body && !(init.headers || {})['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Google's error shape: { error: { code, message, status } }. Surface message + status so
    // the model can react (401 → reconnect, 403 → permissions, 429 → backoff).
    let detail = text;
    try { detail = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`Gmail API ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── Body decoder (full format only) ───────────────────────────────────

// Gmail returns message body as a tree of MIME parts. `body.data` is base64url-encoded. We
// prefer text/plain over text/html, walk recursively, concatenate, truncate.
function _b64urlDecode(s) {
  if (!s) return '';
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _extractBody(payload) {
  if (!payload) return { text: '', attachments: [] };
  const attachments = [];
  const textChunks = [];
  const htmlChunks = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    const attachmentId = part.body?.attachmentId;
    if (attachmentId) {
      attachments.push({
        attachmentId,
        filename,
        mimeType: mime,
        size: part.body?.size || 0,
      });
      return;
    }
    if (mime === 'text/plain' && part.body?.data) textChunks.push(_b64urlDecode(part.body.data));
    else if (mime === 'text/html' && part.body?.data) htmlChunks.push(_b64urlDecode(part.body.data));
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(payload);
  // Prefer plain text; fall back to HTML with rough tag strip (best-effort, not a full HTML parser).
  let body = textChunks.join('\n\n');
  if (!body && htmlChunks.length) {
    body = htmlChunks
      .join('\n\n')
      .replace(/<\/?(script|style)[\s\S]*?>/gi, '')  // drop script / style
      .replace(/<[^>]+>/g, '')                       // strip remaining tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n');
  }
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, MAX_BODY_BYTES).toString('utf8') + '\n…[truncated to 8KB]';
    truncated = true;
  }
  return { text: body, attachments, truncated };
}

function _headerMap(headers) {
  const wanted = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'reply-to', 'message-id']);
  const out = {};
  for (const h of headers || []) {
    if (!h?.name) continue;
    const k = h.name.toLowerCase();
    if (wanted.has(k)) out[k] = h.value;
  }
  return out;
}

// ── Tool dispatch ─────────────────────────────────────────────────────

async function callTool(name, args) {
  if (name === 'search_messages') {
    const q = String(args.query || '');
    if (!q) throw new Error('query is required');
    const max = Math.min(50, Math.max(1, parseInt(args.maxResults, 10) || 10));
    const list = await gmailFetch(`/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
    const ids = list.messages || [];
    if (!ids.length) return { messages: [], resultSizeEstimate: list.resultSizeEstimate || 0 };
    // Fetch metadata for each id in parallel. Limit concurrency at 8 to stay under Gmail's
    // per-user-per-second quota (250) with margin.
    const messages = [];
    const queue = [...ids];
    const workers = Math.min(8, queue.length);
    async function pump() {
      while (queue.length) {
        const { id } = queue.shift();
        const m = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
        messages.push({
          id: m.id,
          threadId: m.threadId,
          snippet: m.snippet || '',
          labelIds: m.labelIds || [],
          headers: _headerMap(m.payload?.headers),
        });
      }
    }
    await Promise.all(Array.from({ length: workers }, pump));
    // Preserve search order from the list response (ids array is newest-first).
    const order = new Map(ids.map((x, i) => [x.id, i]));
    messages.sort((a, b) => order.get(a.id) - order.get(b.id));
    return { messages, resultSizeEstimate: list.resultSizeEstimate || messages.length };
  }
  if (name === 'get_message') {
    const id = String(args.id || '');
    if (!id) throw new Error('id is required');
    const format = ['minimal', 'metadata', 'full'].includes(args.format) ? args.format : 'metadata';
    const m = await gmailFetch(`/messages/${id}?format=${format}`);
    const out = {
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet || '',
      labelIds: m.labelIds || [],
      sizeEstimate: m.sizeEstimate,
      historyId: m.historyId,
      internalDate: m.internalDate,
      headers: _headerMap(m.payload?.headers),
    };
    if (format === 'full') {
      const decoded = _extractBody(m.payload);
      out.body = decoded.text;
      out.attachments = decoded.attachments;
      if (decoded.truncated) out.bodyTruncated = true;
    }
    return out;
  }
  if (name === 'list_labels') {
    const r = await gmailFetch('/labels');
    return {
      labels: (r.labels || []).map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        messageListVisibility: l.messageListVisibility,
        labelListVisibility: l.labelListVisibility,
      })),
    };
  }
  if (name === 'send_message') {
    const body = _buildRawMessage(args);
    const r = await gmailFetch('/messages/send', { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, threadId: r.threadId, labelIds: r.labelIds };
  }
  if (name === 'modify_message_labels') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const addLabelIds = Array.isArray(args.addLabelIds) ? args.addLabelIds.filter((x) => typeof x === 'string') : [];
    const removeLabelIds = Array.isArray(args.removeLabelIds) ? args.removeLabelIds.filter((x) => typeof x === 'string') : [];
    if (!addLabelIds.length && !removeLabelIds.length) throw new Error('at least one of addLabelIds / removeLabelIds is required');
    const r = await gmailFetch(`/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds }) });
    return { id: r.id, threadId: r.threadId, labelIds: r.labelIds };
  }
  if (name === 'batch_modify_messages') {
    const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === 'string') : [];
    if (!ids.length) throw new Error('ids is required (non-empty array)');
    const addLabelIds = Array.isArray(args.addLabelIds) ? args.addLabelIds.filter((x) => typeof x === 'string') : [];
    const removeLabelIds = Array.isArray(args.removeLabelIds) ? args.removeLabelIds.filter((x) => typeof x === 'string') : [];
    if (!addLabelIds.length && !removeLabelIds.length) throw new Error('at least one of addLabelIds / removeLabelIds is required');
    // batchModify endpoint returns 204 No Content on success → empty body.
    await gmailFetch('/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids, addLabelIds, removeLabelIds }) });
    return { ok: true, modified: ids.length };
  }
  if (name === 'trash_message') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const r = await gmailFetch(`/messages/${id}/trash`, { method: 'POST' });
    return { id: r.id, labelIds: r.labelIds };
  }
  if (name === 'untrash_message') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const r = await gmailFetch(`/messages/${id}/untrash`, { method: 'POST' });
    return { id: r.id, labelIds: r.labelIds };
  }
  if (name === 'list_threads') {
    const q = String(args.query || '');
    if (!q) throw new Error('query is required');
    const max = Math.min(50, Math.max(1, parseInt(args.maxResults, 10) || 10));
    const r = await gmailFetch(`/threads?q=${encodeURIComponent(q)}&maxResults=${max}`);
    return {
      threads: (r.threads || []).map((t) => ({ id: t.id, snippet: t.snippet, historyId: t.historyId })),
      resultSizeEstimate: r.resultSizeEstimate || (r.threads || []).length,
    };
  }
  if (name === 'get_thread') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const format = ['minimal', 'metadata', 'full'].includes(args.format) ? args.format : 'metadata';
    const r = await gmailFetch(`/threads/${id}?format=${format}`);
    const messages = (r.messages || []).map((m) => {
      const base = {
        id: m.id, snippet: m.snippet, labelIds: m.labelIds || [],
        internalDate: m.internalDate, headers: _headerMap(m.payload?.headers),
      };
      if (format === 'full') {
        const decoded = _extractBody(m.payload);
        base.body = decoded.text;
        base.attachments = decoded.attachments;
        if (decoded.truncated) base.bodyTruncated = true;
      }
      return base;
    });
    return { id: r.id, historyId: r.historyId, messages };
  }
  if (name === 'get_attachment') {
    const mid = encodeURIComponent(String(args.messageId || ''));
    const aid = encodeURIComponent(String(args.attachmentId || ''));
    if (!mid || !aid) throw new Error('messageId and attachmentId are both required');
    const r = await gmailFetch(`/messages/${mid}/attachments/${aid}`);
    // Google's attachment endpoint returns `{size, data: base64url}`. Re-encode to standard base64
    // for downstream consumption (most decoders want standard b64).
    const std = (r.data || '').replace(/-/g, '+').replace(/_/g, '/');
    return { data: std, size: r.size, encoding: 'base64' };
  }
  if (name === 'list_drafts') {
    const max = Math.min(50, Math.max(1, parseInt(args.maxResults, 10) || 20));
    const r = await gmailFetch(`/drafts?maxResults=${max}`);
    return { drafts: (r.drafts || []).map((d) => ({ id: d.id, messageId: d.message?.id, threadId: d.message?.threadId })) };
  }
  if (name === 'get_draft') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const format = ['minimal', 'metadata', 'full'].includes(args.format) ? args.format : 'metadata';
    const r = await gmailFetch(`/drafts/${id}?format=${format}`);
    const m = r.message || {};
    const out = {
      id: r.id, messageId: m.id, threadId: m.threadId,
      snippet: m.snippet, headers: _headerMap(m.payload?.headers),
    };
    if (format === 'full') {
      const decoded = _extractBody(m.payload);
      out.body = decoded.text;
      out.attachments = decoded.attachments;
      if (decoded.truncated) out.bodyTruncated = true;
    }
    return out;
  }
  if (name === 'create_draft') {
    const message = _buildRawMessage(args);
    const r = await gmailFetch('/drafts', { method: 'POST', body: JSON.stringify({ message }) });
    return { id: r.id, messageId: r.message?.id, threadId: r.message?.threadId };
  }
  if (name === 'update_draft') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const message = _buildRawMessage(args);
    const r = await gmailFetch(`/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ message }) });
    return { id: r.id, messageId: r.message?.id, threadId: r.message?.threadId };
  }
  if (name === 'send_draft') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const r = await gmailFetch('/drafts/send', { method: 'POST', body: JSON.stringify({ id: args.id }) });
    return { id: r.id, threadId: r.threadId, labelIds: r.labelIds };
  }
  if (name === 'delete_draft') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    await gmailFetch(`/drafts/${id}`, { method: 'DELETE' });
    return { ok: true };
  }
  if (name === 'create_label') {
    const lbl = String(args.name || '').trim();
    if (!lbl) throw new Error('name is required');
    const body = {
      name: lbl,
      ...(args.messageListVisibility ? { messageListVisibility: args.messageListVisibility } : {}),
      ...(args.labelListVisibility ? { labelListVisibility: args.labelListVisibility } : {}),
    };
    const r = await gmailFetch('/labels', { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, name: r.name, type: r.type };
  }
  if (name === 'update_label') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    const body = {};
    if (typeof args.name === 'string') body.name = args.name;
    if (args.messageListVisibility) body.messageListVisibility = args.messageListVisibility;
    if (args.labelListVisibility) body.labelListVisibility = args.labelListVisibility;
    const r = await gmailFetch(`/labels/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { id: r.id, name: r.name, type: r.type };
  }
  if (name === 'delete_label') {
    const id = encodeURIComponent(String(args.id || ''));
    if (!id) throw new Error('id is required');
    await gmailFetch(`/labels/${id}`, { method: 'DELETE' });
    return { ok: true };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ── MCP server wiring ─────────────────────────────────────────────────

async function main() {
  const server = new Server({ name: 'gmail-rest', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { TOOLS, callTool, _buildRawMessage };

if (require.main === module) {
  main().catch((err) => {
    // Last-resort log to stderr; PC's main process tails this when diagnosing spawn failures.
    process.stderr.write(`gmail-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
