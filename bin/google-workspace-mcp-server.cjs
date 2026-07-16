#!/usr/bin/env node
require('./proxy-bootstrap.cjs');
// Google Workspace MCP server (stdio). This is the independent one-click connector: one OAuth
// grant with the union of Google Workspace scopes, one connector instance, and one MCP process
// exposing the Gmail / Calendar / Docs / Sheets / Tasks tools together. The five per-service
// connectors use their own adapters and remain separate install/enable/remove states.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const ADAPTERS = [
  { label: 'Gmail', mod: require('./gmail-mcp-server.cjs') },
  { label: 'Calendar', mod: require('./gcal-mcp-server.cjs') },
  { label: 'Docs', mod: require('./gdocs-mcp-server.cjs') },
  { label: 'Sheets', mod: require('./gsheets-mcp-server.cjs') },
  { label: 'Tasks', mod: require('./gtasks-mcp-server.cjs') },
];

const ROUTES = new Map();
const TOOLS = [];

for (const { label, mod } of ADAPTERS) {
  for (const tool of mod.TOOLS || []) {
    if (ROUTES.has(tool.name)) {
      throw new Error(`duplicate Google Workspace tool name: ${tool.name}`);
    }
    ROUTES.set(tool.name, mod.callTool);
    TOOLS.push({
      ...tool,
      description: `[${label}] ${tool.description || ''}`,
    });
  }
}

async function callTool(name, args) {
  const handler = ROUTES.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(name, args || {});
}

async function main() {
  const server = new Server({ name: 'google-workspace-rest', version: '0.1.0' }, { capabilities: { tools: {} } });

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
    process.stderr.write(`google-workspace-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
