import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureMainLogWorkers } from '../../../helpers/capture-main-log-workers';

// Exercise the real registry -> manager -> McpConnection -> SDK -> loopback
// boundary. Peer receipts and actual effects prove remote execution and no replay.
type Fault = 'none' | 'initialize-auth' | 'initialize-forbidden' | 'initialize-rate-limit' | 'initialize-upstream' | 'initialize-deadline' | 'initialize-timeout' | 'initialize-other-server' | 'legacy-auth' | 'list-auth' | 'call-auth' | 'initialize-reset' | 'list-reset'
  | 'call-business' | 'call-reset-after-effect' | 'call-malformed';
const UID = 'u-custom-mcp-failure';
let fault: Fault;
let requests: string[];
let effects: number;
let authorization: string[];
let server: http.Server;
let endpoint: string;
let root: string;
let previousRoot: string | undefined;
let closeLogs: () => Promise<void>;
let manager: typeof import('../../../../src/main/features/connectors/manager');
let registry: typeof import('../../../../src/main/features/connectors/registry');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-custom-mcp-fault-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  fault = 'none'; requests = []; effects = 0; authorization = [];
  server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      if (fault === 'legacy-auth') { requests.push('sse/get'); res.writeHead(401); res.end('private-peer-response'); }
      else { res.writeHead(405); res.end(); }
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(message.method);
    authorization.push(String(req.headers.authorization || ''));
    const handshakeStatus = ({ 'initialize-auth': 401, 'initialize-forbidden': 403,
      'initialize-rate-limit': 429, 'initialize-upstream': 503,
      'initialize-deadline': 408, 'initialize-timeout': 504, 'initialize-other-server': 599, 'legacy-auth': 405 } as Record<string, number>)[fault];
    if (message.method === 'initialize' && handshakeStatus) {
      res.writeHead(handshakeStatus); res.end('private-peer-response'); return;
    }
    if ((message.method === 'tools/list' && fault === 'list-auth')
      || (message.method === 'tools/call' && fault === 'call-auth')) {
      res.writeHead(401); res.end('private-peer-response'); return;
    }
    if ((message.method === 'initialize' && fault === 'initialize-reset')
      || (message.method === 'tools/list' && fault === 'list-reset')) {
      req.socket.destroy(); return;
    }
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (message.method === 'initialize') result = {
      protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'controlled-fixture', version: '1' },
    };
    else if (message.method === 'tools/list') result = {
      tools: [{ name: 'write_fixture', inputSchema: { type: 'object', properties: {} } }],
    };
    else if (message.method === 'tools/call') {
      if (fault === 'call-business') result = {
        isError: true, content: [{ type: 'text', text: 'Fixture operation rejected' }],
      };
      else {
        effects += 1;
        if (fault === 'call-reset-after-effect') { req.socket.destroy(); return; }
        result = fault === 'call-malformed' ? { content: 'invalid-result-shape' }
          : { content: [{ type: 'text', text: 'Fixture write completed' }] };
      }
    }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const actualFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== new URL(endpoint).origin) throw new Error('Fixture blocks non-peer network');
    return actualFetch(input, init);
  });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  manager = await import('../../../../src/main/features/connectors/manager');
  registry = await import('../../../../src/main/features/connectors/registry');
});

afterEach(async () => {
  try {
    await manager?.shutdownAll();
    await closeLogs?.();
  } finally {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function add() {
  return manager.addCustomInstance(UID, {
    display_name: 'Failure fixture', transport: {
      kind: 'streamable-http', url: endpoint, headers: { Authorization: 'Bearer synthetic-fixture' },
    },
  });
}

describe('custom MCP failures and recovery through a real local peer', () => {
  it('completes a healthy write once and passes the configured authorization', async () => {
    const instance = await add();
    expect(instance.status.kind).toBe('connected');
    expect(instance.tools_cache.map(tool => tool.name)).toEqual(['write_fixture']);
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'Fixture write completed' }],
    });
    expect(effects).toBe(1);
    expect(requests.filter(method => method === 'tools/call')).toHaveLength(1);
    expect(authorization.every(value => value === 'Bearer synthetic-fixture')).toBe(true);
  });

  it.each(['initialize-auth', 'initialize-forbidden', 'initialize-rate-limit', 'initialize-upstream',
    'initialize-deadline', 'initialize-timeout', 'initialize-other-server'] as const)(
    'rejects %s before writing and recovers after the peer is restored', async (mode) => {
    fault = mode;
    const instance = await add();
    expect(instance.status.kind).toBe('error');
    expect(requests).toEqual(['initialize']);
    expect(effects).toBe(0);

    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
    expect(requests).not.toContain('tools/call');

    fault = 'none';
    await manager.refreshTools(UID, instance.id);
    await manager.callTool(UID, instance.id, 'write_fixture', {});
    expect(effects).toBe(1);
  });

  it('retains a legacy SSE authorization error after the handshake selects that transport', async () => {
    fault = 'legacy-auth';
    const instance = await add();
    expect(instance.status.kind).toBe('error');
    expect(requests).toEqual(['initialize', 'sse/get']);
    expect(effects).toBe(0);
    fault = 'none';
    await manager.refreshTools(UID, instance.id);
    await manager.callTool(UID, instance.id, 'write_fixture', {});
    expect(effects).toBe(1);
  });

  it.each(['list-auth', 'call-auth'] as const)('rejects %s without issuing or replaying a write', async mode => {
    const instance = await add();
    if (mode === 'list-auth') await manager.shutdownAll();
    fault = mode; requests = [];
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
    expect(effects).toBe(0);
    expect(requests.filter(method => method === 'tools/call')).toHaveLength(mode === 'call-auth' ? 1 : 0);
    fault = 'none';
    await manager.refreshTools(UID, instance.id);
    await manager.callTool(UID, instance.id, 'write_fixture', {});
    expect(effects).toBe(1);
  });

  it('retains a missing local executable as a failed configuration without calling any tool', async () => {
    const instance = await manager.addCustomInstance(UID, {
      display_name: 'Missing executable', transport: {
        kind: 'stdio', command: path.join(root, 'absent-fixture-command'), args: [], env: {},
      },
    });
    expect(instance.status.kind).toBe('error');
    if (instance.status.kind === 'error') expect(instance.status.message).toContain('ENOENT');
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow('ENOENT');
    expect(effects).toBe(0);
    expect(requests).toEqual([]);
  });

  it.each(['initialize-reset', 'list-reset'] as const)(
    'preserves an established connector on %s, blocks cooldown traffic, and supports explicit recovery', async mode => {
      const instance = await add();
      await manager.shutdownAll();
      requests = [];
      fault = mode;
      await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
      expect(requests.filter(method => method === 'initialize')).toHaveLength(2);
      expect(requests.filter(method => method === 'tools/list')).toHaveLength(mode === 'list-reset' ? 2 : 0);
      expect(requests).not.toContain('tools/call');
      expect(effects).toBe(0);
      expect(registry.load(UID).connections[instance.id]).toMatchObject({
        status: { kind: 'degraded' }, tools_cache: instance.tools_cache,
      });
      const before = [...requests];
      await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
      expect(requests).toEqual(before);
      fault = 'none';
      await manager.refreshTools(UID, instance.id);
      await manager.callTool(UID, instance.id, 'write_fixture', {});
      expect(effects).toBe(1);
      expect(registry.load(UID).connections[instance.id]?.status.kind).toBe('connected');
    },
  );

  it('reports a tool rejection without executing, replaying or breaking the live connection', async () => {
    const instance = await add(); fault = 'call-business';
    const result = await manager.callTool(UID, instance.id, 'write_fixture', {});
    expect(result).toMatchObject({ isError: true });
    expect(effects).toBe(0);
    expect(requests.filter(method => method === 'tools/call')).toHaveLength(1);
    fault = 'none';  const before = requests.filter(method => method === 'initialize').length;
    await manager.callTool(UID, instance.id, 'write_fixture', {});
    expect(effects).toBe(1);
    expect(requests.filter(method => method === 'initialize')).toHaveLength(before);
  });

  it('does not repeat a write when the response connection drops after the peer applied it', async () => {
    const instance = await add(); fault = 'call-reset-after-effect';
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
    expect(effects).toBe(1);
    expect(requests.filter(method => method === 'tools/call')).toHaveLength(1);
    expect(registry.load(UID).connections[instance.id]?.status.kind).toBe('degraded');
    const before = [...requests];
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
    expect(requests).toEqual(before);
    expect(effects).toBe(1);
  });

  it('rejects a malformed tool response without repeating the write', async () => {
    const instance = await add(); fault = 'call-malformed';
    await expect(manager.callTool(UID, instance.id, 'write_fixture', {})).rejects.toThrow();
    expect(effects).toBe(1);
    expect(requests.filter(method => method === 'tools/call')).toHaveLength(1);
  });
});
