#!/usr/bin/env node
require('./proxy-bootstrap.cjs');
// Google Docs MCP server (stdio). Wraps `docs.googleapis.com` REST API.
// V1: read full document + create empty doc. `update_document` deferred (batchUpdate's request[]
// schema is complex; defer until we see real workflow demand).

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const BASE = 'https://docs.googleapis.com/v1';
const MAX_BODY_BYTES = 16 * 1024;  // Docs body cap (larger than Gmail's 8KB — docs are explicitly user-requested content)

const TOOLS = [
  {
    name: 'get_document',
    description:
      'Fetch a Google Docs document and return its plain-text body (paragraphs flattened, formatting ' +
      'discarded). Truncated to ~16KB; the full structured form is too noisy for LLM consumption — ' +
      'if a workflow needs styles / tables / images by region, file a follow-up to add a structured ' +
      'reader tool.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'The Google Docs document id (the long hash in the URL after /document/d/).',
        },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'create_document',
    description: 'Create a new empty Google Docs document. Returns the new documentId.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the new document.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'append_text',
    description:
      'Append text to the end of a Google Doc — the most common write op. Adds a trailing newline ' +
      'unless your text already ends with one. Plain text only; styles / formatting not applied.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        text: { type: 'string', description: 'Text to append.' },
      },
      required: ['documentId', 'text'],
    },
  },
  {
    name: 'insert_text',
    description:
      'Insert text at a specific 1-based character index. For "add to the end" prefer `append_text`. ' +
      'Indices are tricky in Docs (each paragraph has a structural newline that counts) — try ' +
      '`get_document` first to see the body, then count to the desired position.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        index: { type: 'integer', minimum: 1, description: '1-based character index.' },
        text: { type: 'string' },
      },
      required: ['documentId', 'index', 'text'],
    },
  },
  {
    name: 'replace_text',
    description:
      'Find-and-replace text across the entire document. Returns the count of replacements made. Set ' +
      '`matchCase: true` for case-sensitive matching (default false).',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        find: { type: 'string', description: 'Text to find.' },
        replace: { type: 'string', description: 'Replacement text. Pass empty string to delete.' },
        matchCase: { type: 'boolean' },
      },
      required: ['documentId', 'find', 'replace'],
    },
  },
  {
    name: 'get_document_outline',
    description:
      'Get the heading structure of a document — for "show me what\'s in this doc" without reading ' +
      'the whole body. Returns each heading with its nesting level (1 = top-level, 2 = H2, etc.) and ' +
      'startIndex (usable with `insert_text`).',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
      },
      required: ['documentId'],
    },
  },
];

async function gFetch(pathAndQuery, init) {
  if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN env var not set');
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`Docs API ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// Walk a Docs document body, concatenating every paragraph's textRun content. Skips lists /
// tables / images — for the v1 "let the model read a doc" use case, prose is what matters.
function _flattenBody(body) {
  if (!body || !Array.isArray(body.content)) return '';
  const chunks = [];
  for (const el of body.content) {
    if (el.paragraph?.elements) {
      for (const part of el.paragraph.elements) {
        if (part.textRun?.content) chunks.push(part.textRun.content);
      }
    }
    if (el.table) chunks.push('\n[table omitted]\n');
    // Skip sectionBreak / etc.
  }
  let out = chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;
  if (Buffer.byteLength(out, 'utf8') > MAX_BODY_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, MAX_BODY_BYTES).toString('utf8') + '\n…[truncated]';
    truncated = true;
  }
  return { text: out, truncated };
}

async function callTool(name, args) {
  if (name === 'get_document') {
    const id = encodeURIComponent(String(args.documentId || ''));
    if (!id) throw new Error('documentId is required');
    const doc = await gFetch(`/documents/${id}`);
    const flat = _flattenBody(doc.body);
    return {
      documentId: doc.documentId,
      title: doc.title,
      revisionId: doc.revisionId,
      body: flat.text,
      ...(flat.truncated ? { bodyTruncated: true } : {}),
    };
  }
  if (name === 'create_document') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const r = await gFetch('/documents', { method: 'POST', body: JSON.stringify({ title }) });
    return { documentId: r.documentId, title: r.title };
  }
  if (name === 'append_text') {
    const id = encodeURIComponent(String(args.documentId || ''));
    const text = String(args.text || '');
    if (!id) throw new Error('documentId is required');
    if (!text) throw new Error('text is required');
    // endOfSegmentLocation appends at the very end of the body; Google computes the index itself.
    const r = await gFetch(`/documents/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ insertText: { endOfSegmentLocation: {}, text } }],
      }),
    });
    return { documentId: r.documentId, replies: (r.replies || []).length };
  }
  if (name === 'insert_text') {
    const id = encodeURIComponent(String(args.documentId || ''));
    const index = parseInt(args.index, 10);
    const text = String(args.text || '');
    if (!id) throw new Error('documentId is required');
    if (!(index >= 1)) throw new Error('index must be a positive integer');
    if (!text) throw new Error('text is required');
    const r = await gFetch(`/documents/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ insertText: { location: { index }, text } }],
      }),
    });
    return { documentId: r.documentId, replies: (r.replies || []).length };
  }
  if (name === 'replace_text') {
    const id = encodeURIComponent(String(args.documentId || ''));
    if (!id) throw new Error('documentId is required');
    const find = String(args.find || '');
    if (!find) throw new Error('find is required');
    const replace = String(args.replace ?? '');
    const matchCase = args.matchCase === true;
    const r = await gFetch(`/documents/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          replaceAllText: {
            containsText: { text: find, matchCase },
            replaceText: replace,
          },
        }],
      }),
    });
    const reply = (r.replies && r.replies[0]) || {};
    return { documentId: r.documentId, replacements: reply.replaceAllText?.occurrencesChanged || 0 };
  }
  if (name === 'get_document_outline') {
    const id = encodeURIComponent(String(args.documentId || ''));
    if (!id) throw new Error('documentId is required');
    const doc = await gFetch(`/documents/${id}`);
    const headings = [];
    for (const el of (doc.body?.content || [])) {
      const p = el.paragraph;
      if (!p) continue;
      const style = p.paragraphStyle?.namedStyleType || '';
      // Google's heading types: HEADING_1 .. HEADING_6, TITLE, SUBTITLE
      const m = /^HEADING_(\d)$/.exec(style);
      if (!m && style !== 'TITLE' && style !== 'SUBTITLE') continue;
      const text = (p.elements || []).map((e) => e.textRun?.content || '').join('').replace(/\n+$/, '').trim();
      if (!text) continue;
      headings.push({
        level: m ? parseInt(m[1], 10) : (style === 'TITLE' ? 0 : 1),
        kind: style,
        text,
        startIndex: el.startIndex,
        endIndex: el.endIndex,
      });
    }
    return { documentId: doc.documentId, title: doc.title, headings };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  const server = new Server({ name: 'gdocs-rest', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err && err.message) || String(err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

module.exports = { TOOLS, callTool };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`gdocs-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
