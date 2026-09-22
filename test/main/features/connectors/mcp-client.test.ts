import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('MCP stdio diagnostic boundary', () => {
  it.each(['stdio', 'streamable-http'])('closes a %s channel that never completes initialization within 30s', (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-connect-'));
    const childPath = path.join(root, 'silent.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const pidPath = path.join(root, 'child.pid');
    fs.writeFileSync(childPath, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdin.resume();`);
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      'const realSetTimeout = global.setTimeout; const deadlines = [];',
      // Scale only the production 30s budget. An incorrect 180s/60s default fails the probe deadline.
      'global.setTimeout = (fn, ms, ...args) => { deadlines.push(ms); return realSetTimeout(fn, ms === 30000 ? 500 : ms, ...args); };',
      '(async () => {',
      "  const server = require('node:http').createServer(() => {});",
      "  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));",
      `  const transport = ${JSON.stringify(kind)} === 'stdio'`,
      `    ? { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } }`,
      "    : { kind: 'streamable-http', url: 'http://127.0.0.1:' + server.address().port + '/mcp' };",
      "  const connection = new McpConnection('fixture', transport);",
      '  try {',
      '    await connection.connect();',
      '    throw new Error("Unexpected connection success");',
      '  } catch (error) {',
      '    process.stdout.write(JSON.stringify({ message: error.message, connected: connection.isConnected, deadlines }));',
      '  } finally { await connection.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root };
      for (const key of ['ORKAS_MCP_CONNECT_TIMEOUT_MS', 'ORKAS_MCP_STDIO_CONNECT_TIMEOUT_MS', 'ORKAS_MCP_HTTP_CONNECT_TIMEOUT_MS']) delete env[key];
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env, encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const outcome = JSON.parse(result.stdout);
      expect(outcome.connected).toBe(false);
      expect(outcome.message).toContain('MCP connect timed out (>30s)');
      expect(outcome.deadlines.slice(0, 2)).toEqual([30_000, 30_000]);
      if (kind === 'stdio') {
        expect(fs.existsSync(pidPath)).toBe(true);
        expect(() => process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 0)).toThrow();
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['quiet', 'progress', 'endless', 'late-progress'])('bounds a %s operation and never replays it after timeout', (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-deadline-'));
    const childPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const eventsPath = path.join(root, 'events.jsonl');
    fs.writeFileSync(childPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { CallToolRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      `const record = event => require('node:fs').appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');`,
      "const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });",
      'server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {',
      "  record('start');",
      '  let count = 0, timer, pulse;',
      '  try {',
      '    await new Promise(resolve => {',
      "      extra.signal.addEventListener('abort', () => { record('cancel'); resolve(); }, { once: true });",
      ...(mode !== 'quiet' ? [
        "      pulse = setInterval(() => { void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: ++count } }).catch(() => {}); }, 80);",
      ] : []),
      ...(mode !== 'endless' ? ["      timer = setTimeout(() => { record('complete'); resolve(); }, 800);"] : []),
      '    });',
      "    return { content: [{ type: 'text', text: 'complete' }] };",
      '  } finally { clearTimeout(timer); clearInterval(pulse); }',
      '});',
      'process.stdin.once("end", () => { void server.close(); });',
      'void server.connect(new StdioServerTransport());',
    ].join('\n'));
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      `const connection = new McpConnection('fixture', { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } });`,
      'const realSetTimeout = global.setTimeout; const deadlines = [];',
      'global.setTimeout = (fn, ms, ...args) => { deadlines.push(ms); return realSetTimeout(fn, ms === 600000 ? 1200 : ms === 60000 ? 300 : ms, ...args); };',
      '(async () => {',
      '  try {',
      '    await connection.connect();',
      '    try {',
      `      const result = await connection.callTool('execute_write', {}${mode === 'late-progress' ? ', { timeoutMs: 300 }' : ''});`,
      "      process.stdout.write(JSON.stringify({ outcome: result.content[0].text, deadlines }));",
      '    } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, deadlines })); }',
      '    await new Promise(resolve => setTimeout(resolve, 150));',
      '  } finally { await connection.close(); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const { deadlines, ...outcome } = JSON.parse(result.stdout);
      expect(outcome).toEqual(['quiet', 'progress'].includes(mode) ? { outcome: 'complete' } : { code: -32001 });
      // Both the startup guard and SDK initialize request use the same default.
      expect(deadlines.slice(0, 2)).toEqual([30_000, 30_000]);
      expect(deadlines).toContain(mode === 'late-progress' ? 300 : 600_000);
      expect(fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(['start', ['quiet', 'progress'].includes(mode) ? 'complete' : 'cancel']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['custom-fixture', 'notion'])('drains private child diagnostics without inheriting them into the parent: %s', (id) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-diagnostics-'));
    const childPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const marker = 'synthetic-private-connector-diagnostic';
    fs.writeFileSync(childPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      "const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });",
      "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] }));",
      // More than a typical pipe buffer: the privacy boundary must drain the stream too.
      `process.stderr.write(${JSON.stringify(marker)}.repeat(4096));`,
      'process.stdin.once("end", () => { void server.close(); });',
      'void server.connect(new StdioServerTransport());',
    ].join('\n'));
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      `const connection = new McpConnection(${JSON.stringify(id)}, { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } });`,
      '(async () => {',
      '  try {',
      '    await connection.connect();',
      '    process.stdout.write(JSON.stringify(await connection.listTools()));',
      '  } finally { await connection.close(); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { name: 'read_fixture', description: '', input_schema: { type: 'object' } },
      ]);
      expect(result.stderr.includes(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
