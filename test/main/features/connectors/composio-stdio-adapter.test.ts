import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const requireCjs = createRequire(import.meta.url);

type Adapter = {
  TOOLS_REQUEST_TIMEOUT_MS: number;
  EXECUTE_REQUEST_TIMEOUT_MS: number;
  OrkasProxyResponseError: new (message: string, status: number, code: string) => Error;
  splitComposioToolArguments: (value: Record<string, unknown>) => {
    args: Record<string, unknown>;
    creditContextBody: Record<string, string>;
  };
  callComposioTool: (
    name: string,
    value: Record<string, unknown>,
    request?: (path: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  listComposioTools: (request?: (...args: unknown[]) => Promise<Record<string, unknown>>) => Promise<unknown>;
  normalizeTool: (tool: Record<string, unknown>) => Record<string, unknown> | null;
};

const ORIGINAL_ENV = {
  ORKAS_API_BASE: process.env.ORKAS_API_BASE,
  ORKAS_API_KEY: process.env.ORKAS_API_KEY,
  ORKAS_CLIENT_HEADERS_JSON: process.env.ORKAS_CLIENT_HEADERS_JSON,
  COMPOSIO_CONNECTION_ID: process.env.COMPOSIO_CONNECTION_ID,
  COMPOSIO_CONNECTION_TOKEN: process.env.COMPOSIO_CONNECTION_TOKEN,
  COMPOSIO_CONNECTOR_ID: process.env.COMPOSIO_CONNECTOR_ID,
};

function configureAdapterEnv(): void {
  process.env.ORKAS_API_BASE = 'https://orkas.example/api';
  process.env.ORKAS_API_KEY = 'orkas-user-key';
  process.env.ORKAS_CLIENT_HEADERS_JSON = JSON.stringify({
    'Orkas-Channel': 'open',
    'Orkas-App-Version': '2026.9.7',
    'Accept-Language': 'zh-CN',
    session_id: 'must-not-forward',
  });
  process.env.COMPOSIO_CONNECTION_ID = 'connection-1';
  process.env.COMPOSIO_CONNECTION_TOKEN = 'a'.repeat(43);
  process.env.COMPOSIO_CONNECTOR_ID = 'gmail';
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function loadAdapter(): Adapter {
  const full = path.join(process.cwd(), 'bin', 'composio-mcp-server.cjs');
  delete requireCjs.cache[full];
  return requireCjs(full) as Adapter;
}


// Execute the actual entrypoint registration with only the MCP transport boundary replaced.
// The handler, dispatcher, HTTP request and AbortSignal composition remain real adapter code.
function loadMcpHandlers() {
  type Handler = (request: any, extra: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
  const handlers = new Map<unknown, Handler>();
  const schemas = requireCjs('@modelcontextprotocol/sdk/types.js');
  class ServerBoundary {
    setRequestHandler(schema: unknown, handler: Handler) { handlers.set(schema, handler); }
    async connect() {}
  }
  const entryModule = { exports: {} };
  const entryRequire = Object.assign((name: string) => {
    if (name === './proxy-bootstrap.cjs') return {};
    if (name === '@modelcontextprotocol/sdk/server/index.js') return { Server: ServerBoundary };
    if (name === '@modelcontextprotocol/sdk/server/stdio.js') return { StdioServerTransport: class {} };
    return requireCjs(name);
  }, { main: entryModule });
  runInNewContext(readFileSync(path.join(process.cwd(), 'bin/composio-mcp-server.cjs'), 'utf8'), {
    require: entryRequire, module: entryModule,
    process: { env: process.env, exit: vi.fn() }, console,
    fetch: globalThis.fetch, AbortSignal,
  });
  expect(handlers.has(schemas.CallToolRequestSchema)).toBe(true);
  expect(handlers.has(schemas.ListToolsRequestSchema)).toBe(true);
  return {
    call: handlers.get(schemas.CallToolRequestSchema)!,
    list: handlers.get(schemas.ListToolsRequestSchema)!,
  };
}

describe('Composio stdio proxy adapter', () => {
  it('keeps the Server execution deadline inside the adapter deadline', () => {
    const adapter = loadAdapter();
    expect(adapter.TOOLS_REQUEST_TIMEOUT_MS).toBe(25_000);
    expect(adapter.EXECUTE_REQUEST_TIMEOUT_MS).toBe(590_000);
  });

  it('strips host credit context from third-party tool arguments and promotes bounded metadata', () => {
    configureAdapterEnv();
    const adapter = loadAdapter();
    expect(adapter.splitComposioToolArguments({
      query: 'plan',
      __orkas_credit_context: {
        conversationId: 'conv-1',
        conversationTitle: 'Cross-capability task',
        conversationTitleUpdatedAt: 1234,
        turnId: 'turn-2',
        agentId: 'agent-3',
        agentName: 'Researcher',
      },
    })).toEqual({
      args: { query: 'plan' },
      creditContextBody: {
        orkas_conversation_id: 'conv-1',
        orkas_turn_id: 'turn-2',
      },
    });
  });

  it('preserves standardized MCP safety annotations and drops vendor metadata', () => {
    const adapter = loadAdapter();
    expect(adapter.normalizeTool({
      slug: 'SHOPEE_LIST_ORDERS',
      description: 'List orders',
      input_schema: { type: 'object' },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        vendorSecret: 'drop',
      },
      policy: {
        risk: 'D',
        confirmation: 'destructive',
        max_batch_size: 25,
        sensitive_operation: 'delete',
      },
    })).toEqual({
      name: 'SHOPEE_LIST_ORDERS',
      description: 'List orders',
      inputSchema: { type: 'object' },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        orkas: {
          actionPolicy: {
            risk: 'D',
            confirmation: 'destructive',
            sensitiveOperation: 'delete',
            maxBatchSize: 25,
          },
        },
      },
    });
  });

  it('forwards an approved desktop action directly with only business arguments', async () => {
    configureAdapterEnv();
    const adapter = loadAdapter();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const request = vi.fn(async (requestPath: string, body: Record<string, unknown>) => {
      requests.push({ path: requestPath, body });
      return { result: { ok: true } };
    });

    await expect(adapter.callComposioTool('SHOP_CREATE_REFUND', {
      amount: 12.5,
    }, request)).resolves.toMatchObject({ content: [{ type: 'text' }] });

    expect(requests).toEqual([
      {
        path: '/connectors/composio/execute',
        body: {
          tool_slug: 'SHOP_CREATE_REFUND',
          arguments: { amount: 12.5 },
        },
      },
    ]);
  });

  it('calls the reused connector API with both credentials outside provider arguments', async () => {
    configureAdapterEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      result: { ok: true },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = loadAdapter();

    await adapter.callComposioTool('GMAIL_FETCH_EMAILS', { query: 'inbox' });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer orkas-user-key',
      'X-Orkas-Connection-Token': 'a'.repeat(43),
      'Orkas-Channel': 'open',
      'Orkas-App-Version': '2026.9.7',
    });
    expect(init.headers).not.toHaveProperty('session_id');
    expect(init.headers).not.toHaveProperty('user_id');
    expect(init.headers).not.toHaveProperty('Accept-Language');
    expect(init.body).not.toContain('a'.repeat(43));
    expect(init.body).not.toContain('orkas-user-key');
  });

  it('returns a completed Server failure as an MCP tool error with a stable safe code', async () => {
    configureAdapterEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 1,
      msg: 'Connector action took too long. Please try again',
      error: { code: 'composio_upstream_timeout' },
    }), { status: 504 })));
    const adapter = loadAdapter();

    await expect(adapter.callComposioTool('GMAIL_FETCH_EMAILS', { query: 'inbox' }))
      .resolves.toEqual({
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error_code: 'composio_upstream_timeout',
            message: 'Connector action took too long. Please try again',
          }),
        }],
      });
  });

  it('blocks a legacy connection before any network call and asks to reconnect', async () => {
    configureAdapterEnv();
    delete process.env.COMPOSIO_CONNECTION_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadAdapter().callComposioTool('GMAIL_FETCH_EMAILS', {});
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('connector_reconnect_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still throws when no Server response exists so the transport circuit can react', async () => {
    configureAdapterEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const adapter = loadAdapter();

    await expect(adapter.callComposioTool('GMAIL_FETCH_EMAILS', { query: 'inbox' }))
      .rejects.toThrow('fetch failed');
  });

  it('does not expose an unstructured Server body through the MCP tool error', async () => {
    configureAdapterEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'alice@example.com confidential provider failure',
      { status: 502 },
    )));
    const adapter = loadAdapter();

    const result = await adapter.callComposioTool('GMAIL_FETCH_EMAILS', { query: 'inbox' });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('connector_proxy_failed');
    expect(JSON.stringify(result)).not.toContain('alice@example.com');
    expect(JSON.stringify(result)).not.toContain('confidential provider failure');
  });

  it('forwards caller cancellation through the dispatcher to the one HTTP request', async () => {
    configureAdapterEnv();
    let observed!: AbortSignal;
    const fetchMock = vi.fn((_url, options) => {
      observed = options.signal;
      return new Promise<Response>((_resolve, reject) => {
        observed.addEventListener('abort', () => reject(observed.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = loadAdapter().callComposioTool('GMAIL_SEND_EMAIL', {}, undefined, controller.signal);
    void pending.catch(() => {});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observed.aborted).toBe(false);
    controller.abort();
    expect(observed.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates the actual registered MCP handler cancellation to fetch without replay', async () => {
    configureAdapterEnv();
    let observed!: AbortSignal;
    const fetchMock = vi.fn((_url, options) => {
      observed = options.signal;
      return new Promise<Response>((_resolve, reject) => {
        observed.addEventListener('abort', () => reject(observed.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = loadMcpHandlers().call({ params: { name: 'SHOP_CREATE_REFUND', arguments: { amount: 12.5 } } }, { signal: controller.signal });
    void pending.catch(() => {});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observed.aborted).toBe(false);
    controller.abort();
    expect(observed.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      tool_slug: 'SHOP_CREATE_REFUND', arguments: { amount: 12.5 },
    });
  });

  it.each([
    { error: 'HTTP 403: Request had insufficient authentication scopes.', data: { status_code: 403 } },
    { error: { code: 'NEW_VENDOR_741', message: 'Missing argument folder_id',
      details: [{ field: 'folder_id', required: true }] }, limit: 7, retryable: false, extra: null },
    { error_type: 'ReadTimeout', message: 'Read timed out.' },
    { error: 'Original reason '.repeat(100) },
  ])('delivers original sanitized provider errors to the model without translation or replay', async response => {
    configureAdapterEnv();
    const details = { response, redacted: false, truncated: false, http_status: 200, retry_after: '15' };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: 'Legacy generic failure',
      error: { code: 'composio_upstream_error', details },
    }), { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    const result = await loadAdapter().callComposioTool('ANY_PROVIDER_ACTION', {});
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(details);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { response: {}, redacted: 'false', truncated: false },
    { redacted: false, truncated: false },
    { category: 'permission_denied', recovery: 'review_permissions', message: 'Previous translated detail' },
  ])('retains legacy public copy when the original-response wrapper is invalid', async details => {
    configureAdapterEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1,
      msg: 'Safe legacy failure', error: { code: 'composio_upstream_error', details },
    }), { status: 502 })));
    const result = await loadAdapter().callComposioTool('ANY_PROVIDER_ACTION', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
      error_code: 'composio_upstream_error', message: 'Safe legacy failure',
    });
    expect(result._meta).toBeUndefined();
  });

  it.each([
    { error: 'x'.repeat(300000) },
    { details: Array.from({ length: 1000 }, () => ({ cause: 'original' })) },
  ])('marks oversized original errors incomplete rather than inventing an explanation', async response => {
    configureAdapterEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1,
      error: { code: 'composio_upstream_error', details: {
        response, redacted: true, truncated: false, http_status: 503,
      } },
    }), { status: 502 })));
    const result = await loadAdapter().callComposioTool('ANY_PROVIDER_ACTION', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
      response: '[truncated]', redacted: true, truncated: true, http_status: 503,
    });
  });

  it('keeps original discovery errors in the JSON-RPC error instead of an empty catalog', async () => {
    configureAdapterEnv();
    const details = { response: { error: 'Required scope: gmail.readonly', code: 'INSUFFICIENT_SCOPE' },
      redacted: false, truncated: false, http_status: 403 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1,
      msg: 'Legacy generic failure', error: { code: 'composio_upstream_error', details },
    }), { status: 502 })));
    await expect(loadAdapter().listComposioTools()).rejects.toMatchObject({
      data: details, message: expect.stringContaining('Required scope: gmail.readonly'),
    });
  });

  it('normalizes a successful discovery response and leaves no-response failures to transport recovery', async () => {
    const adapter = loadAdapter();
    await expect(adapter.listComposioTools(async () => ({ tools: [{ slug: 'READ_PROFILE', input_schema: { type: 'object' } }] })))
      .resolves.toMatchObject({ tools: [{ name: 'READ_PROFILE', inputSchema: { type: 'object' } }] });
    const disconnected = new Error('Synthetic transport unavailable');
    await expect(adapter.listComposioTools(async () => { throw disconnected; })).rejects.toBe(disconnected);
  });

  it('preserves public failure facts across the real stdio SDK for discovery and execution', async () => {
    const requests: string[] = [];
    const details = { response: { successful: false, error: 'HTTP 403: Request had insufficient authentication scopes.',
      data: { status_code: 403, required_scope: 'https://www.googleapis.com/auth/gmail.readonly' } },
      redacted: true, truncated: false, http_status: 200 };
    const server = http.createServer((request, response) => {
      requests.push(request.url || '');
      request.resume();
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 1, msg: 'Legacy generic failure', error: {
        code: 'composio_upstream_error', details,
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { Client } = requireCjs('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = requireCjs('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: [path.join(process.cwd(), 'bin/composio-mcp-server.cjs')], stderr: 'pipe',
      env: { ORKAS_API_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}/api`,
        ORKAS_API_KEY: 'fixture-key', COMPOSIO_CONNECTION_TOKEN: 'fixture-token',
        COMPOSIO_CONNECTION_ID: 'fixture-connection', COMPOSIO_CONNECTOR_ID: 'fixture-connector',
        ELECTRON_RUN_AS_NODE: '1' },
    });
    let stderr = '';
    transport.stderr?.on('data', (part: Buffer) => { stderr += part.toString(); });
    const client = new Client({ name: 'contract-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(transport);
      await expect(client.listTools()).rejects.toMatchObject({ data: details,
        message: expect.stringContaining('insufficient authentication scopes') });
      const result = await client.callTool({ name: 'ANY_PROVIDER_ACTION', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(details);
      expect(requests).toEqual(['/api/connectors/composio/tools', '/api/connectors/composio/execute']);
    } finally {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(stderr).toBe('');
  }, 10_000);

  it.each([200, 503])('returns queue expiry through real stdio without replay and allows a later call (HTTP %s)', async status => {
    let executions = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      expect(request.url).toBe('/api/connectors/composio/execute');
      expect(request.headers['orkas-composio-long-call']).toBe('1');
      executions++;
      response.writeHead(executions === 1 ? status : 200, { 'content-type': 'application/json' });
      response.end(' \n' + JSON.stringify(executions === 1
        ? { code: 1, msg: 'Service is busy. Please try again later', error: { code: 'composio_queue_timeout' } }
        : { code: 0, result: { completed: true } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { Client } = requireCjs('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = requireCjs('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: [path.join(process.cwd(), 'bin/composio-mcp-server.cjs')], stderr: 'pipe',
      env: { ORKAS_API_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}/api`,
        ORKAS_API_KEY: 'fixture-key', COMPOSIO_CONNECTION_TOKEN: 'fixture-token',
        COMPOSIO_CONNECTION_ID: 'fixture-connection', COMPOSIO_CONNECTOR_ID: 'fixture-connector',
        ELECTRON_RUN_AS_NODE: '1' },
    });
    let stderr = '';
    transport.stderr?.on('data', (part: Buffer) => { stderr += part.toString(); });
    const client = new Client({ name: 'queue-contract-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const expired = await client.callTool({ name: 'ANY_PROVIDER_ACTION', arguments: {} });
      expect(expired.isError).toBe(true);
      expect(JSON.parse(expired.content[0].text)).toEqual({
        error_code: 'composio_queue_timeout', message: 'Service is busy. Please try again later',
      });
      expect(executions).toBe(1);
      const recovered = await client.callTool({ name: 'ANY_PROVIDER_ACTION', arguments: {} });
      expect(recovered.isError).toBeUndefined();
      expect(JSON.parse(recovered.content[0].text)).toEqual({ completed: true });
      expect(executions).toBe(2);
    } finally {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(stderr).toBe('');
  }, 10_000);

  it.each([0, 1])('accepts whitespace keepalive plus terminal envelope code=%i using the long-call opt-in', async (code) => {
    configureAdapterEnv();
    const terminal = code ? {
      code, error: { code: 'composio_upstream_timeout', message: 'Action timed out' },
    } : { code, result: { ok: true } };
    const fetchMock = vi.fn(async () => new Response(` \n \n${JSON.stringify(terminal)}`, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadMcpHandlers().call({ params: { name: 'GMAIL_FETCH_EMAILS', arguments: { query: 'inbox' } } }, { signal: new AbortController().signal });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'Orkas-Composio-Long-Call': '1',
      Authorization: 'Bearer orkas-user-key',
      'X-Orkas-Connection-Token': 'a'.repeat(43),
    });
    if (code) expect(result).toEqual({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error_code: 'composio_upstream_timeout', message: 'Action timed out' }) }] });
    else expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }] });
  });

  it('keeps tools/list on the ordinary request path without the execution opt-in', async () => {
    configureAdapterEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, tools: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadMcpHandlers().list({}, { signal: new AbortController().signal })).resolves.toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://orkas.example/api/connectors/composio/tools');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Orkas-Composio-Long-Call');
  });
});
