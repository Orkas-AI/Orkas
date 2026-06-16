/**
 * IPC handlers for the connectors feature. Renderer reaches these via
 * `window.orkas.invoke('connectors.*', payload)`.
 *
 *   connectors.catalog       → { catalog }
 *   connectors.list          → { instances }
 *   connectors.start_oauth   → { instance }  (Server-bridge OAuth; blocks until deep-link returns)
 *   connectors.add_custom    → { instance }  (user-supplied MCP server; validated form input)
 *   connectors.remove        → { removed }
 *   connectors.refresh       → { tools }
 *   connectors.set_subtools  → { instance }
 *
 * Catalog installs are OAuth-only — no API-key fallback, no BYO client credentials; Server
 * holds every provider's `client_id` / `client_secret`. Custom MCP servers are the separate,
 * explicitly user-authored path: `connectors.add_custom` is the single validated route
 * (features/connectors/custom-transport.ts), the renderer form is the consent surface, and the
 * stored transport lives inside `secrets_enc`. See docs/plans/open-ecosystem-architecture.md §C.
 */
import * as path from 'node:path';

import * as connectors from '../features/connectors';
import type { ConnectorInstance, ConnectorStatus, ToolSchema } from '../features/connectors';
import { isConnectorEnabled, setConnectorEnabled } from '../features/component_enabled';
import { catalogWithAvailability, isConnectorRuntimeEnabled } from '../features/connectors/availability';

/**
 * Renderer-safe view of a connector instance. The hydrated `ConnectorInstance`
 * carries live secrets — `oauth_grant.access_token` / `refresh_token`,
 * `dcr_client.client_secret`, and a `transport` whose env/headers can bake in a
 * `Authorization: Bearer <token>` — none of which the renderer needs. A renderer
 * compromise (XSS in rendered content) must not be able to exfiltrate live
 * provider tokens, so every instance crossing IPC is mapped to this DTO. Only
 * fields the renderer actually reads are exposed (see modules/connectors.js);
 * `oauth_grant` is reduced to its display label.
 */
interface ClientConnectorInstance {
  id: string;
  display_name: string;
  origin?: 'catalog' | 'custom';
  transport:
    | { kind: 'stdio'; summary: string }
    | { kind: 'streamable-http'; summary: string };
  enabled_subtools: string[] | null;
  tools_cache: ToolSchema[];
  tools_cached_at: number;
  status: ConnectorStatus;
  oauth_grant?: { account_label: string };
  created_at: string;
  updated_at: string;
  enabled?: boolean;
}

function _safeTransportSummary(inst: ConnectorInstance): ClientConnectorInstance['transport'] {
  if (inst.transport.kind === 'stdio') {
    const command = path.basename(inst.transport.command || '');
    const argCount = inst.transport.args?.length ?? 0;
    const suffix = argCount === 1 ? '1 arg' : `${argCount} args`;
    return { kind: 'stdio', summary: argCount > 0 ? `${command} (${suffix})` : command };
  }
  try {
    const url = new URL(inst.transport.url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { kind: 'streamable-http', summary: url.origin + url.pathname };
  } catch {
    return { kind: 'streamable-http', summary: '' };
  }
}

/** Strip every secret-bearing field; never spread the raw instance to the renderer. */
function toClientInstance(inst: ConnectorInstance, enabled?: boolean): ClientConnectorInstance {
  const transport = _safeTransportSummary(inst);
  const out: ClientConnectorInstance = {
    id: inst.id,
    display_name: inst.display_name,
    ...(inst.origin ? { origin: inst.origin } : {}),
    transport,
    enabled_subtools: inst.enabled_subtools,
    tools_cache: inst.tools_cache,
    tools_cached_at: inst.tools_cached_at,
    status: inst.status,
    created_at: inst.created_at,
    updated_at: inst.updated_at,
  };
  if (inst.oauth_grant?.account_label) {
    out.oauth_grant = { account_label: inst.oauth_grant.account_label };
  }
  if (typeof enabled === 'boolean') out.enabled = enabled;
  return out;
}

export const _toClientInstanceForTest = toClientInstance;

export const invokeHandlers = {
  'connectors.catalog': async () => ({ catalog: catalogWithAvailability(connectors.CONNECTOR_CATALOG) }),

  'connectors.list': async (_payload: unknown, ctx: { userId: string }) => {
    // Attach the per-user `enabled` flag so the renderer can render the "停用 / 启用" toggle
    // without a second IPC. Defaults to true when the user hasn't toggled it (the file only
    // stores `false` overrides — see features/component_enabled.ts).
    const raw = connectors.listInstances(ctx.userId).filter((inst) => isConnectorRuntimeEnabled(inst.id));
    const instances = raw.map((inst) => toClientInstance(inst, isConnectorEnabled(ctx.userId, inst.id)));
    return { instances };
  },

  'connectors.set_enabled': async (
    payload: { id?: unknown; enabled?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.id !== 'string' || !connectors.isValidInstanceId(payload.id)) throw new Error('invalid id');
    if (typeof payload?.enabled !== 'boolean') throw new Error('invalid enabled flag');
    setConnectorEnabled(ctx.userId, payload.id, payload.enabled);
    return { ok: true, enabled: payload.enabled };
  },

  'connectors.start_oauth': async (payload: { catalog_id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.catalog_id !== 'string') throw new Error('invalid catalog_id');
    const instance = await connectors.connectViaOAuth(ctx.userId, payload.catalog_id);
    return { instance: toClientInstance(instance, isConnectorEnabled(ctx.userId, instance.id)) };
  },

  'connectors.cancel_oauth': async () => {
    const cancelled = connectors.cancelInFlightOAuth();
    return { cancelled };
  },

  /** Renderer answer to a `connectors:install-confirm` push (commander
   *  `add_custom_connector` flow). Shape-only validation; verdict
   *  semantics live in features/connectors/install_confirm.ts. */
  'connectors.install_confirm_response': async (payload: { request_id?: unknown; approved?: unknown }) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    if (typeof payload?.approved !== 'boolean') throw new Error('invalid approved flag');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const installConfirm = require('../features/connectors/install_confirm') as typeof import('../features/connectors/install_confirm');
    return { handled: installConfirm.respond(payload.request_id, payload.approved) };
  },

  'connectors.add_custom': async (
    payload: { display_name?: unknown; transport?: unknown },
    ctx: { userId: string },
  ) => {
    // Validation (shape, https/localhost rule, header/env hygiene) lives in
    // custom-transport.ts — this handler stays logic-free per CLAUDE.md §2.
    const instance = await connectors.addCustomInstance(ctx.userId, {
      display_name: payload?.display_name as string,
      transport: payload?.transport as never,
    });
    return { instance: toClientInstance(instance, isConnectorEnabled(ctx.userId, instance.id)) };
  },

  'connectors.remove': async (payload: { id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.id !== 'string' || !connectors.isValidInstanceId(payload.id)) throw new Error('invalid id');
    const removed = await connectors.removeInstance(ctx.userId, payload.id);
    return { removed };
  },

  'connectors.refresh': async (payload: { id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.id !== 'string' || !connectors.isValidInstanceId(payload.id)) throw new Error('invalid id');
    const tools = await connectors.refreshTools(ctx.userId, payload.id);
    return { tools };
  },

  'connectors.set_subtools': async (
    payload: { id?: unknown; subtools?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.id !== 'string' || !connectors.isValidInstanceId(payload.id)) throw new Error('invalid id');
    let subset: string[] | null;
    if (payload.subtools === null) subset = null;
    else if (Array.isArray(payload.subtools)) {
      subset = payload.subtools.filter((s): s is string => typeof s === 'string');
    } else throw new Error('subtools must be null or string[]');
    const instance = await connectors.setEnabledSubtools(ctx.userId, payload.id, subset);
    if (!instance) throw new Error('instance not found');
    return { instance: toClientInstance(instance, isConnectorEnabled(ctx.userId, instance.id)) };
  },

  'connectors.google_sheets_authorize_files': async (
    payload: { file_ids?: unknown },
    ctx: { userId: string },
  ) => {
    const fileIds = Array.isArray(payload?.file_ids)
      ? payload.file_ids.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
    const picked_file_ids = await connectors.authorizeGoogleSheetsFiles(ctx.userId, fileIds);
    return { picked_file_ids };
  },
};
