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

export const invokeHandlers = {
  'connectors.catalog': async () => ({ catalog: connectors.CONNECTOR_CATALOG }),

  'connectors.list': async (_payload: unknown, ctx: { userId: string }) => ({
    instances: connectors.listInstances(ctx.userId),
  }),

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
