/**
 * IPC handlers for local CLI agent discovery.
 *
 * Three logical channels exposed to the renderer:
 *   - `localAgents.list`       → all known CLI types with availability + version
 *   - `localAgents.detect`     → single-CLI re-probe (bypasses cache)
 *   - `localAgents.listModels` → static model catalog for a CLI type
 *
 * No `run` channel here — the renderer doesn't spawn CLIs directly;
 * dispatch goes through the existing `groupChat` channel and `bus.ts`
 * routes CLI agents into `features/local_agents/runner.ts` (Step 6).
 */

import { detectAll, detectOne, invalidateCache, LOCAL_CLI_TYPES, type LocalCliType } from '../features/local_agents/registry.js';
import { listModels } from '../features/local_agents/models.js';

function isLocalCliType(v: unknown): v is LocalCliType {
  return typeof v === 'string' && (LOCAL_CLI_TYPES as readonly string[]).includes(v);
}

export const invokeHandlers = {
  /**
   * List all known CLI types. Default uses the 60s cache; pass
   * `{ force: true }` to invalidate first (settings page refresh button,
   * for instance, would want a fresh probe).
   */
  'localAgents.list': async ({ force = false }: { force?: boolean } = {}) => {
    const entries = await detectAll({ force: !!force });
    return { entries };
  },

  /**
   * Re-probe a single CLI without the cache. Used at execute-time by
   * the runner to make sure a recently-uninstalled binary doesn't slip
   * through, and by the create-modal to refresh after the user changes
   * the relevant `ORKAS_<TYPE>_PATH` env var.
   */
  'localAgents.detect': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    invalidateCache();
    const entry = await detectOne(type);
    return { entry };
  },

  /**
   * Static model catalog for a CLI. Empty array signals the UI to
   * render a free-text input (openclaw / opencode / hermes for now).
   */
  'localAgents.listModels': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    return { models: listModels(type) };
  },
};
