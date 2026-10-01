/**
 * MCP client wrapper.
 *
 * Owns the underlying `@modelcontextprotocol/sdk` `Client` for one connector instance.
 * Local stdio and remote Streamable HTTP use the official SDK transports. Custom remote
 * servers can fall back to the SDK's legacy SSE transport when their endpoint rejects the
 * Streamable HTTP handshake with a transport-shape 4xx response.
 *
 * Why this file is the sole spawn site for MCP child processes: PC/CLAUDE.md §1 calls out
 * `features/local_agents/` as the only spawn entry for coding-CLI dispatches. MCP servers are
 * a different class (tool-providing daemons, not job runners), but the same single-entry
 * discipline applies: the SDK's StdioClientTransport `spawn`s a node/python child here and
 * nowhere else under `features/connectors/`. Any other module that wants to talk to an MCP
 * server goes through `manager.ts`.
 *
 * Lazy SDK import — the SDK's package.json marks `type: module` even though it exposes CJS
 * `require` entries; `await import(...)` keeps the loader path identical regardless of which
 * resolver is active and avoids surprise top-level await issues during tsx transpile.
 */
import * as path from 'node:path';
import type { Transport, ToolSchema } from './types';

type McpToolLike = {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
};

/** Preserve the standardized trust hints that the Host needs for
 * programmatic child-call authorization; discard non-standard metadata. */
export function normalizeMcpToolSchema(tool: McpToolLike): ToolSchema {
  const annotations = tool.annotations && typeof tool.annotations === 'object'
    ? tool.annotations as Record<string, unknown>
    : null;
  const metadata = tool._meta && typeof tool._meta === 'object'
    ? tool._meta as Record<string, unknown>
    : null;
  const orkasMetadata = metadata?.orkas && typeof metadata.orkas === 'object'
    ? metadata.orkas as Record<string, unknown>
    : null;
  const rawPolicy = orkasMetadata?.actionPolicy && typeof orkasMetadata.actionPolicy === 'object'
    ? orkasMetadata.actionPolicy as Record<string, unknown>
    : null;
  const risk = String(rawPolicy?.risk || '') as 'R' | 'W' | 'H' | 'D';
  const confirmation = String(rawPolicy?.confirmation || '') as 'none' | 'preview' | 'fresh' | 'destructive';
  const validPolicy = !!rawPolicy
    && ['R', 'W', 'H', 'D'].includes(risk)
    && ['none', 'preview', 'fresh', 'destructive'].includes(confirmation)
    && Number.isInteger(rawPolicy.maxBatchSize)
    && Number(rawPolicy.maxBatchSize) > 0;
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    input_schema: (tool.inputSchema && typeof tool.inputSchema === 'object')
      ? tool.inputSchema as Record<string, unknown>
      : { type: 'object', properties: {} },
    ...(annotations ? {
      annotations: {
        ...(typeof annotations.title === 'string' ? { title: annotations.title } : {}),
        ...(typeof annotations.readOnlyHint === 'boolean' ? { readOnlyHint: annotations.readOnlyHint } : {}),
        ...(typeof annotations.destructiveHint === 'boolean' ? { destructiveHint: annotations.destructiveHint } : {}),
        ...(typeof annotations.idempotentHint === 'boolean' ? { idempotentHint: annotations.idempotentHint } : {}),
        ...(typeof annotations.openWorldHint === 'boolean' ? { openWorldHint: annotations.openWorldHint } : {}),
      },
    } : {}),
    ...(validPolicy ? {
      orkas_action_policy: {
        risk,
        confirmation,
        ...(typeof rawPolicy?.sensitiveOperation === 'string' && rawPolicy.sensitiveOperation
          ? { sensitive_operation: rawPolicy.sensitiveOperation }
          : {}),
        max_batch_size: Number(rawPolicy?.maxBatchSize),
      },
    } : {}),
  };
}
import { createLogger } from '../../logger';
import { buildChildProxyEnvironment } from '../../util/proxy-dispatcher';
import { logErrorSummary } from '../../util/log-redact';

const log = createLogger('connectors:mcp');

interface SdkBundle {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport;
}

let _sdk: SdkBundle | null = null;

async function _loadSdk(): Promise<SdkBundle> {
  if (_sdk) return _sdk;
  const [clientMod, stdioMod, httpMod, sseMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);
  _sdk = {
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
    StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    SSEClientTransport: sseMod.SSEClientTransport,
  };
  return _sdk;
}

const CLIENT_INFO = { name: 'orkas-pc', version: '0.1.0' };
const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_LIST_TOOLS_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CALL_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

function resolveBoundedTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000) return fallback;
  return Math.min(Math.trunc(n), 10 * 60 * 1000);
}

function resolveMcpConnectTimeoutMs(kind: Transport['kind']): number {
  const specific = kind === 'stdio'
    ? process.env.ORKAS_MCP_STDIO_CONNECT_TIMEOUT_MS
    : process.env.ORKAS_MCP_HTTP_CONNECT_TIMEOUT_MS;
  return resolveBoundedTimeout(specific || process.env.ORKAS_MCP_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS);
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpConnection {
  private _client: import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
  private _connected = false;

  constructor(private readonly id: string, private readonly transport: Transport) {}

  get isConnected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    if (this._connected) return;
    const startedAt = Date.now();
    const sdk = await _loadSdk();
    let activeTransportKind: Transport['kind'] | 'sse' = this.transport.kind;
    let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
    if (this.transport.kind === 'stdio') {
      const proxyEnv = await buildChildProxyEnvironment(this.transport.proxyTargetUrl);
      const envFull: Record<string, string> = { ...this.transport.env, ...proxyEnv };
      // Custom connectors can legitimately carry secrets in argv (e.g.
      // `--api-key sk-…`); log only the command basename + arg count so a key
      // never lands in the persistent app log.
      log.info('spawning stdio MCP server', {
        id: this.id.startsWith('custom-') ? 'custom' : this.id,
        command: this.id.startsWith('custom-') ? 'custom' : path.basename(this.transport.command),
        argCount: this.transport.args.length,
        proxyMode: proxyEnv.ORKAS_PROXY_MODE || 'unmanaged',
      });
      const stdioTransport = new sdk.StdioClientTransport({
        command: this.transport.command,
        args: this.transport.args,
        env: envFull,
        stderr: 'pipe',
        ...(this.transport.cwd ? { cwd: this.transport.cwd } : {}),
      });
      // Provider diagnostics can contain credentials or user data. Drain without
      // retaining them; lifecycle and request errors use the host's structured logs.
      stdioTransport.stderr?.on('data', () => {});
      transport = stdioTransport;
    } else {
      const url = new URL(this.transport.url);
      // Custom URLs may embed credentials in any URL component. The transport
      // class is sufficient for diagnostics; never log the endpoint.
      log.info('connecting streamable-http MCP server', { id: this.id.startsWith('custom-') ? 'custom' : this.id, transport: 'streamable-http' });
      const opts: { requestInit?: { headers?: Record<string, string> } } = {};
      if (this.transport.headers && Object.keys(this.transport.headers).length) {
        opts.requestInit = { headers: this.transport.headers };
      }
      transport = new sdk.StreamableHTTPClientTransport(url, opts);
    }
    let client = new sdk.Client(CLIENT_INFO, {});
    const connectTimeoutMs = resolveMcpConnectTimeoutMs(this.transport.kind);
    let connectDeadline = 0;
    const connectAttempt = async (
      nextClient: typeof client,
      nextTransport: typeof transport,
    ): Promise<void> => {
      if (!connectDeadline) connectDeadline = Date.now() + connectTimeoutMs;
      const remaining = Math.max(1, connectDeadline - Date.now());
      let to: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        const seconds = Math.round(connectTimeoutMs / 1000);
        to = setTimeout(() => reject(new Error(`MCP connect timed out (>${seconds}s); likely npx/network is slow or the server crashed on launch`)), remaining);
      });
      try {
        await Promise.race([nextClient.connect(nextTransport, { timeout: remaining }), timeout]);
      } finally {
        if (to) clearTimeout(to);
      }
    };
    try {
      try {
        await connectAttempt(client, transport);
      } catch (error) {
        const status = (error as { code?: unknown } | null)?.code;
        // A legacy SSE endpoint commonly rejects the initial JSON-RPC POST. A 401/403
        // is authorization, and 5xx/network failures are not evidence of legacy SSE.
        // Catalog entries declare their own protocol and must not silently change it.
        if (this.id.startsWith('custom-') && this.transport.kind === 'streamable-http'
          && (status === 400 || status === 404 || status === 405)) {
          try { await transport.close?.(); } catch { /* preserve the original handshake result */ }
          log.info('retrying custom MCP endpoint with legacy SSE', { id: 'custom' });
          const url = new URL(this.transport.url);
          const headers = this.transport.headers;
          transport = new sdk.SSEClientTransport(url, {
            ...(headers && Object.keys(headers).length ? { requestInit: { headers } } : {}),
          });
          activeTransportKind = 'sse';
          client = new sdk.Client(CLIENT_INFO, {});
          await connectAttempt(client, transport);
        } else {
          throw error;
        }
      }
      this._client = client;
      this._connected = true;
      log.info('MCP connect ok', {
        id: this.id.startsWith('custom-') ? 'custom' : this.id,
        transport: activeTransportKind,
        duration_ms: Date.now() - startedAt,
        timeout_ms: connectTimeoutMs,
      });
    } catch (err) {
      log.warn('connect failed', {
        id: this.id.startsWith('custom-') ? 'custom' : this.id,
        transport: activeTransportKind,
        duration_ms: Date.now() - startedAt,
        error: logErrorSummary(err),
      });
      try { await transport.close?.(); } catch (closeErr) {
        log.warn('transport close after connect failure failed', {
          id: this.id.startsWith('custom-') ? 'custom' : this.id,
          error: logErrorSummary(closeErr),
        });
      }
      throw err;
    }
  }

  async listTools(opts: McpRequestOptions = {}): Promise<ToolSchema[]> {
    if (!this._client || !this._connected) throw new Error('not connected');
    // Collect the complete remote catalog before manager publishes its cache.
    // All pages share one deadline; a server must not extend it with cursors.
    const deadline = Date.now() + (opts.timeoutMs || DEFAULT_LIST_TOOLS_TIMEOUT_MS);
    const tools: ToolSchema[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      opts.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('MCP tools/list discovery timed out');
      const res = await this._client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: remaining,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      for (const tool of res.tools || []) tools.push(normalizeMcpToolSchema(tool));
      cursor = res.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error('MCP tools/list repeated a pagination cursor');
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: McpRequestOptions = {}): Promise<unknown> {
    if (!this._client || !this._connected) throw new Error('not connected');
    const res = await this._client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: opts.timeoutMs || DEFAULT_CALL_TOOL_TIMEOUT_MS,
        // Accept progress notifications without extending the fixed operation deadline.
        onprogress: () => {},
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    return res;
  }

  async close(): Promise<void> {
    if (!this._client) return;
    try {
      await this._client.close();
    } catch (err) {
      log.warn('close failed', { id: this.id.startsWith('custom-') ? 'custom' : this.id, error: logErrorSummary(err) });
    } finally {
      this._client = null;
      this._connected = false;
    }
  }
}
