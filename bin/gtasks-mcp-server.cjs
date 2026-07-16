#!/usr/bin/env node
require('./proxy-bootstrap.cjs');
// Google Tasks MCP server (stdio). Wraps `tasks.googleapis.com` v1.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const BASE = 'https://tasks.googleapis.com/tasks/v1';
const MAX_LIST = 100;

const TOOLS = [
  {
    name: 'list_tasklists',
    description: 'List the user\'s task lists. The default tasklist id is "@default".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tasks',
    description:
      'List tasks in a tasklist. Default tasklist is "@default". `showCompleted=false` (default) hides ' +
      'finished tasks; set true to include them.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Tasklist id from `list_tasklists` (default "@default").' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
        showCompleted: { type: 'boolean' },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task in a tasklist.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due: { type: 'string', description: 'RFC3339 timestamp (only the date portion is used by Google).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description:
      'Update an existing task. `completed: true` marks it done (and `status` flips to "completed"). ' +
      'Only fields you pass are touched.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
        taskId: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due: { type: 'string', description: 'RFC3339.' },
        completed: { type: 'boolean' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task',
    description: 'Fetch a single task by id.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'move_task',
    description:
      'Reorder or nest a task. `parent` makes it a subtask of that task id (omit to keep top-level). ' +
      '`previous` places it after that sibling task (omit to put first).',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
        taskId: { type: 'string' },
        parent: { type: 'string', description: 'Parent task id (omit = top-level).' },
        previous: { type: 'string', description: 'Sibling-before task id (omit = first in list).' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'clear_completed',
    description: 'Hide all completed tasks in a tasklist (Google\'s "clear" — marks them hidden, they still exist in the data).',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Default "@default".' },
      },
    },
  },
  {
    name: 'get_tasklist',
    description: 'Fetch metadata for a single tasklist by id.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string', description: 'Tasklist id (use "@default" for the primary one).' },
      },
      required: ['tasklist'],
    },
  },
  {
    name: 'create_tasklist',
    description: 'Create a new tasklist (a separate "list of tasks" — like a folder).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tasklist title.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_tasklist',
    description: 'Rename a tasklist.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['tasklist', 'title'],
    },
  },
  {
    name: 'delete_tasklist',
    description: 'Delete a tasklist along with all its tasks. Irreversible. Can\'t delete the default tasklist.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklist: { type: 'string' },
      },
      required: ['tasklist'],
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
    throw new Error(`Tasks API ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

async function callTool(name, args) {
  if (name === 'list_tasklists') {
    const r = await gFetch('/users/@me/lists');
    return {
      tasklists: (r.items || []).map((l) => ({ id: l.id, title: l.title, updated: l.updated })),
    };
  }
  if (name === 'list_tasks') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const max = Math.min(MAX_LIST, Math.max(1, parseInt(args.maxResults, 10) || 20));
    const showCompleted = args.showCompleted === true;
    const qs = new URLSearchParams({ maxResults: String(max), showCompleted: String(showCompleted) });
    const r = await gFetch(`/lists/${tl}/tasks?${qs}`);
    return {
      tasks: (r.items || []).map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes,
        status: t.status,
        due: t.due,
        completed: t.completed,
        updated: t.updated,
        parent: t.parent,
        position: t.position,
      })),
    };
  }
  if (name === 'create_task') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const body = {
      title,
      ...(args.notes ? { notes: String(args.notes) } : {}),
      ...(args.due ? { due: String(args.due) } : {}),
    };
    const r = await gFetch(`/lists/${tl}/tasks`, { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, title: r.title, status: r.status, due: r.due };
  }
  if (name === 'update_task') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const tid = encodeURIComponent(String(args.taskId || ''));
    if (!tid) throw new Error('taskId is required');
    const body = {};
    if (typeof args.title === 'string') body.title = args.title;
    if (typeof args.notes === 'string') body.notes = args.notes;
    if (typeof args.due === 'string') body.due = args.due;
    if (args.completed === true) body.status = 'completed';
    else if (args.completed === false) body.status = 'needsAction';
    // Google requires PATCH for partial updates (PUT would zero unspecified fields).
    const r = await gFetch(`/lists/${tl}/tasks/${tid}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { id: r.id, title: r.title, status: r.status, due: r.due, completed: r.completed };
  }
  if (name === 'get_task') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const tid = encodeURIComponent(String(args.taskId || ''));
    if (!tid) throw new Error('taskId is required');
    const r = await gFetch(`/lists/${tl}/tasks/${tid}`);
    return r;
  }
  if (name === 'delete_task') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const tid = encodeURIComponent(String(args.taskId || ''));
    if (!tid) throw new Error('taskId is required');
    await gFetch(`/lists/${tl}/tasks/${tid}`, { method: 'DELETE' });
    return { ok: true };
  }
  if (name === 'move_task') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    const tid = encodeURIComponent(String(args.taskId || ''));
    if (!tid) throw new Error('taskId is required');
    const qs = new URLSearchParams();
    if (args.parent) qs.set('parent', String(args.parent));
    if (args.previous) qs.set('previous', String(args.previous));
    const r = await gFetch(`/lists/${tl}/tasks/${tid}/move${qs.toString() ? `?${qs}` : ''}`, { method: 'POST' });
    return { id: r.id, parent: r.parent, position: r.position };
  }
  if (name === 'clear_completed') {
    const tl = encodeURIComponent(args.tasklist || '@default');
    await gFetch(`/lists/${tl}/clear`, { method: 'POST' });
    return { ok: true };
  }
  if (name === 'get_tasklist') {
    const tl = encodeURIComponent(String(args.tasklist || ''));
    if (!tl) throw new Error('tasklist is required');
    const r = await gFetch(`/users/@me/lists/${tl}`);
    return { id: r.id, title: r.title, updated: r.updated };
  }
  if (name === 'create_tasklist') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const r = await gFetch('/users/@me/lists', { method: 'POST', body: JSON.stringify({ title }) });
    return { id: r.id, title: r.title, updated: r.updated };
  }
  if (name === 'update_tasklist') {
    const tl = encodeURIComponent(String(args.tasklist || ''));
    const title = String(args.title || '').trim();
    if (!tl || !title) throw new Error('tasklist and title are both required');
    const r = await gFetch(`/users/@me/lists/${tl}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    return { id: r.id, title: r.title, updated: r.updated };
  }
  if (name === 'delete_tasklist') {
    const tl = encodeURIComponent(String(args.tasklist || ''));
    if (!tl) throw new Error('tasklist is required');
    await gFetch(`/users/@me/lists/${tl}`, { method: 'DELETE' });
    return { ok: true };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  const server = new Server({ name: 'gtasks-rest', version: '0.1.0' }, { capabilities: { tools: {} } });
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
    process.stderr.write(`gtasks-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
