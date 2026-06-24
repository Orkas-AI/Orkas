#!/usr/bin/env node
/**
 * orkas-bridge — stdio MCP server an external CLI agent (claude code /
 * codex) spawns to reach the Orkas environment (plan §D).
 *
 * Spawned via the per-run MCP config that `features/local_agents/bridge.ts`
 * writes; never started by hand. Everything it can do is brokered:
 *
 *   orkas_list_skills / orkas_read_skill     → bridge socket → main process
 *   orkas_run_skill                          → bridge allow-list → run-skill.cjs
 *   orkas_list_connector_tools /
 *   orkas_call_connector_tool                → bridge socket (permission-gated host-side)
 *   orkas_kb_list / orkas_kb_search /
 *   orkas_kb_read                            → bridge socket
 *
 * Env (injected by bridge.ts into the MCP server config or parent CLI env):
 *   ORKAS_BRIDGE_ENV_FILE — optional 0600 JSON env file containing the
 *                         secret-bearing values below
 *   ORKAS_BRIDGE_SOCKET — unix socket / named pipe back to the Orkas main
 *                         process for this run
 *   ORKAS_BRIDGE_TOKEN  — per-run auth token (dies with the run)
 *   ORKAS_PC_DIR        — PC root for SDK + run-skill resolution
 *   ORKAS_NODE / ORKAS_WORKSPACE_ROOT / ORKAS_UID / ELECTRON_RUN_AS_NODE
 *                       — the standard skill-sandbox set
 *
 * CommonJS + absolute-path requires (the process cwd is the CLI agent's
 * project dir, not PC) — same conventions as run-skill.cjs.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ENV_FILE = process.env.ORKAS_BRIDGE_ENV_FILE;
if (ENV_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('env file must contain a JSON object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    process.stderr.write(`orkas-bridge: failed to read ORKAS_BRIDGE_ENV_FILE: ${(err && err.message) || err}\n`);
    process.exit(64);
  }
}

const PC_DIR = process.env.ORKAS_PC_DIR;
const SOCKET = process.env.ORKAS_BRIDGE_SOCKET;
const TOKEN = process.env.ORKAS_BRIDGE_TOKEN;
if (!PC_DIR || !SOCKET || !TOKEN) {
  process.stderr.write('orkas-bridge: ORKAS_PC_DIR / ORKAS_BRIDGE_SOCKET / ORKAS_BRIDGE_TOKEN env required\n');
  process.exit(64);
}

function req(rel) {
  // eslint-disable-next-line global-require
  return require(path.join(PC_DIR, 'node_modules', rel));
}
const { McpServer } = req('@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
const { StdioServerTransport } = req('@modelcontextprotocol/sdk/dist/cjs/server/stdio.js');
const { z } = req('zod');
const KB_KIND_VALUES = ['text', 'pdf', 'docx', 'spreadsheet', 'presentation', 'image'];

// ── Socket RPC client ────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 60 * 1000;
// Connector calls may sit behind the user-permission dialog host-side —
// give them the dialog timeout plus slack.
const RPC_TIMEOUT_SLOW_MS = 150 * 1000;

let _socket = null;
let _buf = '';
let _nextId = 1;
const _waiters = new Map();

function _connect() {
  if (_socket && !_socket.destroyed) return _socket;
  _socket = net.createConnection(SOCKET);
  _socket.setEncoding('utf8');
  _buf = '';
  _socket.on('data', (chunk) => {
    _buf += chunk;
    let idx;
    while ((idx = _buf.indexOf('\n')) >= 0) {
      const line = _buf.slice(0, idx);
      _buf = _buf.slice(idx + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = _waiters.get(msg.id);
      if (!waiter) continue;
      _waiters.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || 'bridge call failed'));
    }
  });
  const failAll = (why) => {
    for (const [, waiter] of _waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(why));
    }
    _waiters.clear();
  };
  _socket.on('error', (err) => failAll(`bridge socket error: ${err.message}`));
  _socket.on('close', () => failAll('bridge socket closed (Orkas run may have ended)'));
  return _socket;
}

function rpc(method, params, slow = false) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const timer = setTimeout(() => {
      _waiters.delete(id);
      reject(new Error(`bridge call timed out: ${method}`));
    }, slow ? RPC_TIMEOUT_SLOW_MS : RPC_TIMEOUT_MS);
    _waiters.set(id, { resolve, reject, timer });
    try {
      _connect().write(JSON.stringify({ id, token: TOKEN, method, params: params || {} }) + '\n');
    } catch (err) {
      _waiters.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

// ── Local run-skill execution ────────────────────────────────────────────

const RUN_SKILL_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_SKILL_OUTPUT_CAP = 60_000;

function assertSafeScriptBase(scriptBase) {
  if (typeof scriptBase !== 'string' || !scriptBase.trim()) {
    throw new Error('script basename required');
  }
  if (scriptBase.includes('/') || scriptBase.includes('\\') || scriptBase === '.' || scriptBase === '..') {
    throw new Error('script must be a basename, not a path');
  }
}

function runSkillLocally(skillRef, scriptBase, args, skillDir) {
  assertSafeScriptBase(scriptBase);
  return new Promise((resolve) => {
    const node = process.env.ORKAS_NODE || process.execPath;
    const runner = path.join(PC_DIR, 'bin', 'run-skill.cjs');
    const child = spawn(node, [runner, skillRef, scriptBase, '--', ...args], {
      env: { ...process.env, ORKAS_RUN_SKILL_DIR: skillDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let errOut = '';
    const push = (store, chunk) => (store.length < RUN_SKILL_OUTPUT_CAP ? store + chunk : store);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out = push(out, c); });
    child.stderr.on('data', (c) => { errOut = push(errOut, c); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }, RUN_SKILL_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code == null ? 1 : code, stdout: out, stderr: errOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: out, stderr: `${errOut}\nspawn failed: ${err.message}` });
    });
  });
}

// ── MCP server ───────────────────────────────────────────────────────────

function textResult(text) {
  return { content: [{ type: 'text', text: String(text == null ? '' : text) }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${(err && err.message) || String(err)}` }], isError: true };
}

const server = new McpServer({ name: 'orkas', version: '1.0.0' });

server.tool(
  'orkas_list_skills',
  'List the skills available through Orkas bridge (platform, custom, and enabled external packages). Returns id, name, source, and a short description per skill.',
  {},
  async () => {
    try {
      const result = await rpc('skills.list', {});
      return textResult(JSON.stringify(result.skills, null, 2));
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_read_skill',
  'Read the full SKILL.md of one Orkas skill by id or display name. Follow the returned instructions to use the skill.',
  { id: z.string().describe('Skill id or display name from orkas_list_skills') },
  async ({ id }) => {
    try {
      const result = await rpc('skills.read', { id });
      return textResult(result.skill_md);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_run_skill',
  'Run a script that an Orkas skill ships under its scripts/ directory. Equivalent to the skill-runner invocation Orkas agents use. Returns exit code, stdout, and stderr.',
  {
    skill: z.string().describe('Skill id or display name'),
    script: z.string().describe('Script basename without extension'),
    args: z.array(z.string()).optional().describe('Arguments passed to the script'),
  },
  async ({ skill, script, args }) => {
    try {
      const resolved = await rpc('skills.run_info', { id: skill });
      const result = await runSkillLocally(resolved.id || skill, script, args || [], resolved.dir);
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_list_connector_tools',
  'List the user\'s connected Orkas connectors (Slack, Notion, Gmail, custom MCP servers, …) and the tools each exposes. Calls may require the user to approve a permission prompt in Orkas.',
  {},
  async () => {
    try {
      const result = await rpc('connectors.list', {});
      return textResult(JSON.stringify(result.connectors, null, 2));
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_call_connector_tool',
  'Call one tool on a connected Orkas connector. The user is asked for permission in Orkas before the call runs; a denial returns an error you should relay, not retry.',
  {
    connector_id: z.string(),
    tool_name: z.string(),
    args: z.record(z.unknown()).optional(),
  },
  async ({ connector_id, tool_name, args }) => {
    try {
      const result = await rpc('connectors.call', { connector_id, tool_name, args: args || {} }, /* slow */ true);
      return textResult(result.text);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_kb_list',
  'List Library files and indexing status before deciding what to search or read. Returns relative paths, scope, kind, status, chunk count, and size.',
  {
    scope: z.enum(['all', 'project', 'global']).optional().describe('List scope. Default all when a project is active, otherwise global.'),
    dir: z.string().optional().describe('Optional: limit results to relative paths under this directory prefix.'),
    kind: z.enum(KB_KIND_VALUES).optional().describe('Optional: restrict to one file kind.'),
    status: z.enum(['pending', 'processing', 'ready', 'failed']).optional().describe('Optional: restrict to one indexing status.'),
  },
  async (params) => {
    try {
      const result = await rpc('kb.list', params);
      return textResult(result.text);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_kb_search',
  'Semantic search over the user\'s Orkas knowledge base (their curated Library files).',
  {
    query: z.string().describe('Free-text query; natural language works'),
    k: z.number().int().min(1).max(30).optional().describe('Top-k result count, default 8'),
    dir: z.string().optional().describe('Limit to files under this Library-relative subdirectory'),
    path: z.string().optional().describe('Limit to one exact Library-relative file path'),
    kind: z.enum(KB_KIND_VALUES).optional().describe('Optional: restrict to one file kind.'),
    scope: z.enum(['all', 'project', 'global']).optional().describe('Search scope. Default all when a project is active, otherwise global.'),
  },
  async (params) => {
    try {
      const result = await rpc('kb.search', params);
      return textResult(result.text);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'orkas_kb_read',
  'Read source text from a knowledge-base file found via orkas_kb_search.',
  {
    path: z.string().describe('Library-relative file path as returned by orkas_kb_search hits'),
    scope: z.enum(['all', 'project', 'global']).optional().describe('Read scope. Prefer the scope returned by orkas_kb_search.'),
    chunk: z.number().int().min(1).optional().describe('1-based chunk index; omit for the full body'),
    window: z.number().int().min(0).optional().describe('Include ±window neighbour chunks around `chunk`'),
  },
  async (params) => {
    try {
      const result = await rpc('kb.read', params);
      return textResult(result.text);
    } catch (err) { return errorResult(err); }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`orkas-bridge fatal: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
