#!/usr/bin/env node
require('./proxy-bootstrap.cjs');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');

const API_BASE = (process.env.ORKAS_API_BASE || '').replace(/\/+$/, '');
const API_KEY = process.env.ORKAS_API_KEY || '';
const CONNECTION_ID = process.env.COMPOSIO_CONNECTION_ID || '';
const CONNECTION_TOKEN = process.env.COMPOSIO_CONNECTION_TOKEN || '';
const CONNECTOR_ID = process.env.COMPOSIO_CONNECTOR_ID || '';
const TOOLS_REQUEST_TIMEOUT_MS = 25000;
// Leave ten seconds for forwarding the terminal result before the host's 600s deadline.
const EXECUTE_REQUEST_TIMEOUT_MS = 590000;
const CREDIT_CONTEXT_ARG = '__orkas_credit_context';

function withinErrorBudget(value) {
  let nodes = 0;
  let chars = 0;
  function visit(item, depth) {
    if (++nodes > 640 || depth > 16) return false;
    if (typeof item === 'string') chars += item.length;
    if (chars > 40000) return false;
    if (Array.isArray(item)) {
      if (item.length > 640) return false;
      for (const child of item) if (!visit(child, depth + 1)) return false;
    } else if (item && typeof item === 'object') {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        chars += key.length;
        if (chars > 40000 || !visit(item[key], depth + 1)) return false;
      }
    }
    return true;
  }
  return visit(value, 0);
}

// Server owns sensitive-data filtering. Treat its original response as opaque;
// never translate unfamiliar codes, reasons or nested provider fields.
function publicFailureDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'response') || typeof value.redacted !== 'boolean'
      || typeof value.truncated !== 'boolean') return undefined;
  const details = { response: value.response, redacted: value.redacted, truncated: value.truncated,
    ...(Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599
      ? { http_status: value.http_status } : {}),
    ...(typeof value.retry_after === 'string' ? { retry_after: value.retry_after } : {}),
    ...(value.invalid_json === true ? { invalid_json: true } : {}),
    ...(value.private_context_limited === true ? { private_context_limited: true } : {}),
  };
  // Normal Server projections are <=32K text. Keep protocol serialization
  // bounded before serialization, with an explicit marker when incomplete.
  if (!withinErrorBudget(details)) {
    return { response: '[truncated]', redacted: value.redacted, truncated: true,
      ...(details.http_status ? { http_status: details.http_status } : {}) };
  }
  return details;
}

class OrkasProxyResponseError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'OrkasProxyResponseError';
    this.status = Number(status) || 0;
    this.code = String(code || 'connector_proxy_failed');
    this.details = publicFailureDetails(details);
  }
}

function splitComposioToolArguments(value) {
  const args = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const raw = args[CREDIT_CONTEXT_ARG];
  delete args[CREDIT_CONTEXT_ARG];
  const context = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bounded = (input) => String(input || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  const fields = {
    orkas_conversation_id: bounded(context.conversationId || context.conversation_id),
    orkas_turn_id: bounded(context.turnId || context.turn_id),
  };
  return {
    args,
    creditContextBody: Object.fromEntries(Object.entries(fields).filter(([, field]) => field)),
  };
}

function clientHeaders() {
  try {
    const parsed = JSON.parse(process.env.ORKAS_CLIENT_HEADERS_JSON || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, value]) => key.startsWith('Orkas-') && typeof value === 'string'));
  } catch {
    return {};
  }
}

function assertConfigured() {
  if (!API_BASE) throw new Error('ORKAS_API_BASE env var not set');
  if (!API_KEY) throw new Error('ORKAS_API_KEY env var not set');
  if (!CONNECTION_TOKEN) throw new OrkasProxyResponseError('Reconnect this connector to authorize access', 403, 'connector_reconnect_required');
  if (!CONNECTION_ID || !CONNECTOR_ID) throw new Error('Composio connector env vars not set');
}

function boundedMessage(value, fallback) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return text || fallback;
}

function boundedErrorCode(value) {
  const code = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : 'connector_proxy_failed';
}

async function orkasRequest(path, body, timeoutMs, signal) {
  assertConfigured();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...clientHeaders(),
      ...(path === '/connectors/composio/execute' ? { 'Orkas-Composio-Long-Call': '1' } : {}),
      Authorization: `Bearer ${API_KEY}`,
      'X-Orkas-Connection-Token': CONNECTION_TOKEN,
    },
    body: JSON.stringify({
      connection_id: CONNECTION_ID,
      connector_id: CONNECTOR_ID,
      ...(body || {}),
    }),
  });
  const text = await res.text();
  let payload = {};
  let parsedJson = false;
  try {
    payload = text ? JSON.parse(text) : {};
    parsedJson = !!payload && typeof payload === 'object' && !Array.isArray(payload);
    if (!parsedJson) payload = {};
  } catch { payload = {}; }
  if (!res.ok || payload.code !== 0) {
    const err = payload.error && typeof payload.error === 'object' ? payload.error : {};
    const code = boundedErrorCode(parsedJson ? (err.code || err.type) : '');
    const detail = boundedMessage(parsedJson ? (payload.msg || err.message) : '', 'Connector action failed');
    throw new OrkasProxyResponseError(detail, res.status, code, err.details);
  }
  return payload;
}

async function callComposioTool(name, value, request = orkasRequest, signal) {
  const { args, creditContextBody } = splitComposioToolArguments(value);
  try {
    const body = await request('/connectors/composio/execute', {
      tool_slug: name,
      arguments: args,
      ...creditContextBody,
    }, EXECUTE_REQUEST_TIMEOUT_MS, signal);
    return { content: [{ type: 'text', text: JSON.stringify(body.result ?? body, null, 2) }] };
  } catch (err) {
    if (!(err instanceof OrkasProxyResponseError)) throw err;
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify(err.details || { error_code: err.code, message: err.message }),
      }],
    };
  }
}

async function listComposioTools(request = orkasRequest) {
  try {
    const body = await request('/connectors/composio/tools', {}, TOOLS_REQUEST_TIMEOUT_MS);
    return { tools: Array.isArray(body.tools) ? body.tools.map(normalizeTool).filter(Boolean) : [] };
  } catch (err) {
    // tools/list has no operation-level isError envelope. Preserve the same
    // public cause in the SDK's established JSON-RPC diagnostic field instead.
    if (!(err instanceof OrkasProxyResponseError) || !err.details) throw err;
    throw new McpError(ErrorCode.InternalError, JSON.stringify(err.details), err.details);
  }
}

function normalizeTool(tool) {
  const slug = String(tool.slug || tool.name || '').trim();
  if (!slug) return null;
  const hints = tool.annotations && typeof tool.annotations === 'object'
    ? tool.annotations
    : {};
  const policy = tool.policy && typeof tool.policy === 'object' && !Array.isArray(tool.policy)
    ? tool.policy
    : null;
  return {
    name: slug,
    description: String(tool.description || tool.name || slug),
    inputSchema: tool.input_schema && typeof tool.input_schema === 'object'
      ? tool.input_schema
      : { type: 'object', properties: {} },
    ...(Object.keys(hints).length ? {
      annotations: {
        ...(typeof hints.title === 'string' ? { title: hints.title } : {}),
        ...(typeof hints.readOnlyHint === 'boolean' ? { readOnlyHint: hints.readOnlyHint } : {}),
        ...(typeof hints.destructiveHint === 'boolean' ? { destructiveHint: hints.destructiveHint } : {}),
        ...(typeof hints.idempotentHint === 'boolean' ? { idempotentHint: hints.idempotentHint } : {}),
        ...(typeof hints.openWorldHint === 'boolean' ? { openWorldHint: hints.openWorldHint } : {}),
      },
    } : {}),
    ...(policy ? {
      _meta: {
        orkas: {
          actionPolicy: {
            risk: String(policy.risk || ''),
            confirmation: String(policy.confirmation || ''),
            sensitiveOperation: String(policy.sensitive_operation || ''),
            maxBatchSize: Number(policy.max_batch_size || 0),
          },
        },
      },
    } : {}),
  };
}

async function main() {
  const server = new Server(
    { name: `orkas-composio-${CONNECTOR_ID || 'connector'}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => listComposioTools());

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    return callComposioTool(req.params.name, req.params.arguments, orkasRequest, extra.signal);
  });

  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[orkas-composio-mcp] fatal:', err && err.stack || err);
    process.exit(1);
  });
}

module.exports = {
  CREDIT_CONTEXT_ARG,
  TOOLS_REQUEST_TIMEOUT_MS,
  EXECUTE_REQUEST_TIMEOUT_MS,
  OrkasProxyResponseError,
  splitComposioToolArguments,
  callComposioTool,
  listComposioTools,
  normalizeTool,
};
