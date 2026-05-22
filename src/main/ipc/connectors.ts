/**
 * IPC handlers for the connectors feature. Renderer reaches these via
 * `window.orkas.invoke('connectors.*', payload)`.
 *
 *   connectors.catalog       → { catalog }
 *   connectors.list          → { instances }
 *   connectors.start_oauth   → { instance }  (Server-bridge OAuth; blocks until deep-link returns)
 *   connectors.remove        → { removed }
 *   connectors.refresh       → { tools }
 *   connectors.set_subtools  → { instance }
 *
 * **OAuth is the only install path** — no free-form transport, no API-key entry, no BYO client
 * credentials. Server holds every provider's `client_id` / `client_secret`. PC just kicks off
 * the flow and waits for the deep-link callback.
 */
import * as connectors from '../features/connectors';
import { isConnectorEnabled, setConnectorEnabled } from '../features/component_enabled';

export const invokeHandlers = {
  'connectors.catalog': async () => ({ catalog: connectors.CONNECTOR_CATALOG }),

  'connectors.list': async (_payload: unknown, ctx: { userId: string }) => {
    // Attach the per-user `enabled` flag so the renderer can render the "停用 / 启用" toggle
    // without a second IPC. Defaults to true when the user hasn't toggled it (the file only
    // stores `false` overrides — see features/component_enabled.ts).
    const raw = connectors.listInstances(ctx.userId);
    const instances = raw.map((inst) => ({ ...inst, enabled: isConnectorEnabled(ctx.userId, inst.id) }));
    return { instances };
  },

  'connectors.set_enabled': async (
    payload: { id?: unknown; enabled?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.id !== 'string') throw new Error('invalid id');
    if (typeof payload?.enabled !== 'boolean') throw new Error('invalid enabled flag');
    setConnectorEnabled(ctx.userId, payload.id, payload.enabled);
    return { ok: true, enabled: payload.enabled };
  },

  'connectors.start_oauth': async (payload: { catalog_id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.catalog_id !== 'string') throw new Error('invalid catalog_id');
    const instance = await connectors.connectViaOAuth(ctx.userId, payload.catalog_id);
    return { instance };
  },

  'connectors.cancel_oauth': async () => {
    const cancelled = connectors.cancelInFlightOAuth();
    return { cancelled };
  },

  'connectors.remove': async (payload: { id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.id !== 'string') throw new Error('invalid id');
    const removed = await connectors.removeInstance(ctx.userId, payload.id);
    return { removed };
  },

  'connectors.refresh': async (payload: { id?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.id !== 'string') throw new Error('invalid id');
    const tools = await connectors.refreshTools(ctx.userId, payload.id);
    return { tools };
  },

  'connectors.set_subtools': async (
    payload: { id?: unknown; subtools?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.id !== 'string') throw new Error('invalid id');
    let subset: string[] | null;
    if (payload.subtools === null) subset = null;
    else if (Array.isArray(payload.subtools)) {
      subset = payload.subtools.filter((s): s is string => typeof s === 'string');
    } else throw new Error('subtools must be null or string[]');
    const instance = await connectors.setEnabledSubtools(ctx.userId, payload.id, subset);
    if (!instance) throw new Error('instance not found');
    return { instance };
  },
};
