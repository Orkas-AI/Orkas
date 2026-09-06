import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('MCP stdio diagnostic boundary', () => {
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
      expect(result.stderr).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
