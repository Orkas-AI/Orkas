import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** A real loopback MCP peer verifies protocol fallback, credential propagation,
 * and the absence of a second connection on auth/server failures. */
function probe(mode: 'modern' | 'legacy' | 'unauthorized' | 'broken' | 'catalog', status = 405) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-remote-'));
  const probePath = path.join(root, 'probe.cjs');
  fs.writeFileSync(probePath, [
    `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
    `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
    `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
    `const { SSEServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/sse.js'))});`,
    `const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
    "const http = require('node:http');",
    `const mode = ${JSON.stringify(mode)}; const status = ${status};`,
    'const requests = []; let peer;',
    "const server = http.createServer(async (req, res) => {",
    "  requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization || null, accept: req.headers.accept || null });",
    "  if (mode === 'modern') {",
    "    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }",
    "    const chunks = []; for await (const chunk of req) chunks.push(chunk);",
    "    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }",
    "    const result = message.method === 'initialize'",
    "      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'modern-fixture', version: '1.0' } }",
    "      : message.method === 'tools/list' ? { tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] } : null;",
    "    if (!result) { res.writeHead(404); res.end(); return; }",
    "    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;",
    '  }',
    "  if (req.method === 'POST' && req.url === '/sse') { res.writeHead(mode === 'unauthorized' ? 401 : mode === 'broken' ? 500 : status); res.end(); return; }",
    "  if (req.method === 'GET' && req.url === '/sse') {",
    "    peer = new SSEServerTransport('/messages', res);",
    "    const mcp = new Server({ name: 'legacy-fixture', version: '1.0' }, { capabilities: { tools: {} } });",
    "    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] }));",
    '    await mcp.connect(peer); return;',
    '  }',
    "  if (req.method === 'POST' && req.url.startsWith('/messages?sessionId=') && peer) { await peer.handlePostMessage(req, res); return; }",
    '  res.writeHead(404); res.end();',
    '});',
    '(async () => {',
    "  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));",
    "  const conn = new McpConnection(mode === 'catalog' ? 'catalog-fixture' : 'custom-fixture', { kind: 'streamable-http', url: 'http://127.0.0.1:' + server.address().port + '/sse', headers: { Authorization: 'Bearer fixture-token' } });",
    '  let tools, error;',
    '  try { await conn.connect(); tools = await conn.listTools();',
    "    if (mode === 'modern') await new Promise(resolve => { let waited = 0; const check = () => { if (requests.some(r => r.method === 'GET') || waited >= 500) resolve(); else { waited += 10; setTimeout(check, 10); } }; check(); });",
    '  } catch (e) { error = { code: e.code, name: e.name, message: e.message }; }',
    '  finally { await conn.close(); if (peer) await peer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }',
    '  process.stdout.write(JSON.stringify({ tools, error, requests }));',
    '})().catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; });',
  ].join('\n'));
  try {
    const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
      encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as {
      tools?: { name: string }[];
      error?: { code?: number; name: string };
      requests: { method: string; path: string; authorization: string | null; accept: string | null }[];
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('custom MCP remote transport compatibility', () => {
  it('sends both required Accept types and tolerates a 405 on the optional HTTP GET stream', () => {
    const outcome = probe('modern');
    expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
    expect(outcome.tools?.map(tool => tool.name)).toEqual(['read_fixture']);
    expect(outcome.requests.some(req => req.path.startsWith('/messages'))).toBe(false);
    expect(outcome.requests.some(req => req.method === 'GET' && req.path === '/sse')).toBe(true);
    expect(outcome.requests.filter(req => req.method === 'POST').every(req =>
      req.accept?.includes('application/json') && req.accept.includes('text/event-stream'))).toBe(true);
    expect(outcome.requests.every(req => req.authorization === 'Bearer fixture-token')).toBe(true);
  });

  it.each([400, 404, 405])('connects to a legacy SSE-only server after HTTP %i and lists its tools', (status) => {
    const outcome = probe('legacy', status);
    expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
    expect(outcome.tools?.map(tool => tool.name)).toEqual(['read_fixture']);
    expect(outcome.requests.slice(0, 2).map(req => `${req.method} ${req.path}`))
      .toEqual(['POST /sse', 'GET /sse']);
    expect(outcome.requests.slice(2).map(req => `${req.method} ${req.path.split('?')[0]}`))
      .toEqual(['POST /messages', 'POST /messages', 'POST /messages']);
    expect(outcome.requests.every(req => req.authorization === 'Bearer fixture-token')).toBe(true);
  });

  it.each(['unauthorized', 'broken', 'catalog'] as const)('does not misclassify %s as a legacy server', (mode) => {
    const outcome = probe(mode);
    expect(outcome.tools).toBeUndefined();
    expect(outcome.error).toBeDefined();
    expect(outcome.requests.map(req => `${req.method} ${req.path}`)).toEqual(['POST /sse']);
  });
});
