/**
 * Connector manager — process-level singleton holding live MCP client connections.
 *
 * On boot: read registry, reconnect every instance best-effort (failures land as `status:error`
 * but don't block app startup). On shutdown: close all connections cleanly so stdio
 * subprocesses exit instead of leaking. Tool calls route here from the AgentRunner's tools[]
 * array via `tools-adapter.ts`.
 *
 * Every instance uses OAuth — there is no API-key path. The `connectViaOAuth` entry point runs
 * the full PKCE/browser/code-exchange flow, persists the grant, applies the catalog's transport
 * template (which substitutes the fresh access_token into env / headers), and brings the live
 * MCP connection up. Tokens are lazily refreshed at boot / refresh-tools / reconnect; mid-call
 * expiry surfaces as a tool error and the user re-clicks "刷新工具".
 */
import * as registry from './registry';
import { McpConnection } from './mcp-client';
import { findCatalogEntry } from './catalog';
import { applyTemplate } from './apply-template';
import { startOAuth, refreshIfStale } from './oauth';
import { startMcpDcrOAuth, refreshDcrIfStale } from './oauth-dcr';
import { createLogger } from '../../logger';
import type { CatalogEntry, ConnectorInstance, OAuthGrant, ToolSchema, Transport } from './types';

const log = createLogger('connectors:manager');

const _conns = new Map<string, McpConnection>();
let _bootedFor: string | null = null;

function _now(): number { return Date.now(); }
function _nowIso(): string { return new Date().toISOString(); }

async function _refreshGrantIfStale(uid: string, entry: CatalogEntry, inst: ConnectorInstance): Promise<OAuthGrant> {
  if (!inst.oauth_grant) throw new Error('no oauth_grant');
  if (entry.auth_mode === 'mcp_dcr') {
    if (!inst.dcr_client) throw new Error('DCR instance missing dcr_client credentials');
    return refreshDcrIfStale(inst.dcr_client, inst.oauth_grant);
  }
  // server_bridge default
  return refreshIfStale(uid, entry, inst.oauth_grant);
}

async function _resolveTransport(uid: string, inst: ConnectorInstance): Promise<{ transport: Transport; grant: OAuthGrant } | null> {
  const entry = findCatalogEntry(inst.id);
  if (!entry) {
    log.warn('catalog entry missing for instance', { id: inst.id });
    return null;
  }
  if (!inst.oauth_grant) {
    log.warn('instance has no oauth_grant', { id: inst.id });
    return null;
  }
  let grant: OAuthGrant;
  try {
    grant = await _refreshGrantIfStale(uid, entry, inst);
  } catch (err) {
    log.warn('refresh failed', { id: inst.id, error: (err as Error).message });
    throw err;
  }
  if (grant !== inst.oauth_grant) {
    // Persist rotated tokens before spawning so a crash here doesn't lose a refresh.
    await registry.update(uid, inst.id, (cur) => ({ ...cur, oauth_grant: grant, updated_at: _nowIso() }));
  }
  const transport = applyTemplate(entry, grant);
  return { transport, grant };
}

async function _connectAndCacheTools(uid: string, inst: ConnectorInstance): Promise<ConnectorInstance> {
  let transport: Transport;
  try {
    const resolved = await _resolveTransport(uid, inst);
    if (!resolved) {
      const updated: ConnectorInstance = {
        ...inst,
        status: { kind: 'error', message: 'transport unresolved', at: _now() },
        updated_at: _nowIso(),
      };
      await registry.upsert(uid, updated);
      return updated;
    }
    transport = resolved.transport;
  } catch (err) {
    const updated: ConnectorInstance = {
      ...inst,
      status: { kind: 'error', message: (err as Error).message, at: _now() },
      updated_at: _nowIso(),
    };
    await registry.upsert(uid, updated);
    return updated;
  }
  const conn = new McpConnection(inst.id, transport);
  try {
    await conn.connect();
    const tools = await conn.listTools();
    _conns.set(inst.id, conn);
    const updated: ConnectorInstance = {
      ...inst,
      transport,
      tools_cache: tools,
      tools_cached_at: _now(),
      status: { kind: 'connected', since: _now() },
      updated_at: _nowIso(),
    };
    await registry.upsert(uid, updated);
    return updated;
  } catch (err) {
    log.warn('connect+list failed', { id: inst.id, error: (err as Error).message });
    try { await conn.close(); } catch { /* swallow */ }
    const updated: ConnectorInstance = {
      ...inst,
      status: { kind: 'error', message: (err as Error).message, at: _now() },
      updated_at: _nowIso(),
    };
    await registry.upsert(uid, updated);
    return updated;
  }
}

export async function bootstrap(uid: string): Promise<void> {
  if (!uid || _bootedFor === uid) return;
  _bootedFor = uid;
  const file = registry.load(uid);
  const ids = Object.keys(file.connections);
  if (!ids.length) {
    log.info('no connectors to bootstrap');
    return;
  }
  await Promise.all(ids.map((id) => _connectAndCacheTools(uid, file.connections[id]).catch(() => {})));
  const connected = Array.from(_conns.values()).filter((c) => c.isConnected).length;
  log.info('connectors bootstrap done', { total: ids.length, connected });
}

export function listInstances(uid: string): ConnectorInstance[] {
  if (!uid) return [];
  const file = registry.load(uid);
  return Object.values(file.connections).sort((a, b) =>
    (a.display_name || a.id).localeCompare(b.display_name || b.id, undefined, {
      sensitivity: 'base',
      numeric: true,
    }),
  );
}

export function getInstance(uid: string, id: string): ConnectorInstance | null {
  if (!uid) return null;
  const file = registry.load(uid);
  return file.connections[id] || null;
}

/** Drive the full OAuth flow for a catalog entry and bring the resulting MCP connection up.
 *  This is the **only** public install path — there is no free-form / API-key entry point.
 *  Dispatches to server-bridge or DCR depending on `entry.auth_mode`. */
export async function connectViaOAuth(uid: string, catalogId: string): Promise<ConnectorInstance> {
  if (!uid) throw new Error('uid required');
  const entry = findCatalogEntry(catalogId);
  if (!entry) throw new Error('unknown catalog id');
  if (!entry.transport_template) {
    throw new Error(`'${catalogId}' is not installable yet (${entry.unavailable_reason || 'unavailable'})`);
  }

  log.info('connectViaOAuth: starting OAuth', { catalog_id: catalogId, auth_mode: entry.auth_mode });
  let grant: OAuthGrant;
  let dcrClient: ConnectorInstance['dcr_client'];
  if (entry.auth_mode === 'mcp_dcr') {
    const result = await startMcpDcrOAuth(uid, entry);
    grant = result.grant;
    dcrClient = result.client;
  } else {
    if (!entry.oauth) throw new Error(`'${catalogId}' has no oauth config`);
    grant = await startOAuth(uid, entry);
  }
  log.info('connectViaOAuth: OAuth done; spawning MCP server', { catalog_id: catalogId });
  const transport = applyTemplate(entry, grant);

  // Tear down any prior live connection for the same id before re-using the slot.
  const prior = _conns.get(catalogId);
  if (prior) {
    try { await prior.close(); } catch { /* swallow */ }
    _conns.delete(catalogId);
  }

  const draft: ConnectorInstance = {
    id: entry.id,
    display_name: entry.display_name,
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connecting' },
    oauth_grant: grant,
    ...(dcrClient ? { dcr_client: dcrClient } : {}),
    created_at: _nowIso(),
    updated_at: _nowIso(),
  };
  await registry.upsert(uid, draft);
  return _connectAndCacheTools(uid, draft);
}

export async function removeInstance(uid: string, id: string): Promise<boolean> {
  if (!uid) return false;
  const conn = _conns.get(id);
  if (conn) {
    try { await conn.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  return registry.remove(uid, id);
}

export async function refreshTools(uid: string, id: string): Promise<ToolSchema[]> {
  if (!uid) throw new Error('uid required');
  const inst = getInstance(uid, id);
  if (!inst) throw new Error('instance not found');
  // Force refresh-token check by tearing the live conn down and reconnecting through
  // _connectAndCacheTools (which re-resolves transport with a fresh access_token).
  const prior = _conns.get(id);
  if (prior) {
    try { await prior.close(); } catch { /* swallow */ }
    _conns.delete(id);
  }
  const updated = await _connectAndCacheTools(uid, inst);
  return updated.tools_cache;
}

export async function setEnabledSubtools(
  uid: string,
  id: string,
  subset: string[] | null,
): Promise<ConnectorInstance | null> {
  if (!uid) return null;
  return registry.update(uid, id, (cur) => ({
    ...cur,
    enabled_subtools: subset,
    updated_at: _nowIso(),
  }));
}

export async function callTool(
  uid: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!uid) throw new Error('uid required');
  let conn = _conns.get(id);
  if (!conn || !conn.isConnected) {
    const inst = getInstance(uid, id);
    if (!inst) throw new Error('instance not found');
    const resolved = await _resolveTransport(uid, inst);
    if (!resolved) throw new Error('transport unresolved');
    conn = new McpConnection(id, resolved.transport);
    await conn.connect();
    _conns.set(id, conn);
  }
  return conn.callTool(name, args);
}

export async function shutdownAll(): Promise<void> {
  const all = Array.from(_conns.values());
  _conns.clear();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
  _bootedFor = null;
}
