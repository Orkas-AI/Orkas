/**
 * MCP client wrapper.
 *
 * Owns the underlying `@modelcontextprotocol/sdk` `Client` for one connector instance. Two
 * transports supported in Phase 0: `stdio` (local subprocess via SDK's StdioClientTransport)
 * and `streamable-http` (remote HTTP). SSE transport is intentionally not implemented — the
 * MCP spec has deprecated it in favor of streamable HTTP.
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
import { createLogger } from '../../logger';

const log = createLogger('connectors:mcp');

interface SdkBundle {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
}

let _sdk: SdkBundle | null = null;

async function _loadSdk(): Promise<SdkBundle> {
  if (_sdk) return _sdk;
  const [clientMod, stdioMod, httpMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  _sdk = {
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
    StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
  };
  return _sdk;
}

const CLIENT_INFO = { name: 'orkas-pc', version: '0.1.0' };

export class McpConnection {
  private _client: import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
  private _connected = false;

  constructor(private readonly id: string, private readonly transport: Transport) {}

  get isConnected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    if (this._connected) return;
    const sdk = await _loadSdk();
    let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
    if (this.transport.kind === 'stdio') {
      const envFull: Record<string, string> = { ...this.transport.env };
      // Custom connectors can legitimately carry secrets in argv (e.g.
      // `--api-key sk-…`); log only the command basename + arg count so a key
      // never lands in the persistent app log.
      log.info('spawning stdio MCP server', {
        id: this.id,
        command: path.basename(this.transport.command),
        argCount: this.transport.args.length,
      });
      transport = new sdk.StdioClientTransport({
        command: this.transport.command,
        args: this.transport.args,
        env: envFull,
        ...(this.transport.cwd ? { cwd: this.transport.cwd } : {}),
      });
    } else {
      const url = new URL(this.transport.url);
      // A custom URL may carry credentials in the query string (`?key=…`); log
      // only origin + pathname, never the query.
      log.info('connecting streamable-http MCP server', { id: this.id, url: url.origin + url.pathname });
      const opts: { requestInit?: { headers?: Record<string, string> } } = {};
      if (this.transport.headers && Object.keys(this.transport.headers).length) {
        opts.requestInit = { headers: this.transport.headers };
      }
      transport = new sdk.StreamableHTTPClientTransport(url, opts);
    }
    const client = new sdk.Client(CLIENT_INFO, {});
    try {
      // First-run `npx -y @modelcontextprotocol/server-github` can download ~10-30 MB; bound
      // the wait so a stuck spawn surfaces as a clear error instead of an indefinite hang.
      // 60s is generous for cold install on a slow link; warm runs finish in < 1s.
      const SPAWN_TIMEOUT_MS = 60_000;
      let to: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        to = setTimeout(() => reject(new Error('MCP connect timed out (>60s); likely npx/network is slow or the server crashed on launch')), SPAWN_TIMEOUT_MS);
      });
      try {
        await Promise.race([client.connect(transport), timeout]);
      } finally {
        if (to) clearTimeout(to);
      }
      this._client = client;
      this._connected = true;
      log.info('MCP connect ok', { id: this.id });
    } catch (err) {
      log.warn('connect failed', { id: this.id, error: (err as Error).message });
      try { await transport.close?.(); } catch { /* swallow */ }
      throw err;
    }
  }

  async listTools(): Promise<ToolSchema[]> {
    if (!this._client || !this._connected) throw new Error('not connected');
    const res = await this._client.listTools();
    return (res.tools || []).map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      input_schema: (t.inputSchema && typeof t.inputSchema === 'object')
        ? t.inputSchema as Record<string, unknown>
        : { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._client || !this._connected) throw new Error('not connected');
    const res = await this._client.callTool({ name, arguments: args });
    return res;
  }

  async close(): Promise<void> {
    if (!this._client) return;
    try {
      await this._client.close();
    } catch (err) {
      log.warn('close failed', { id: this.id, error: (err as Error).message });
    } finally {
      this._client = null;
      this._connected = false;
    }
  }
}
