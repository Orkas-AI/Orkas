import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

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
    request?: (path: string, body: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>;
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

describe('Composio stdio proxy adapter', () => {
  it('keeps the Server execution deadline inside the adapter deadline', () => {
    const adapter = loadAdapter();
    expect(adapter.TOOLS_REQUEST_TIMEOUT_MS).toBe(25_000);
    expect(adapter.EXECUTE_REQUEST_TIMEOUT_MS).toBe(100_000);
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
});
