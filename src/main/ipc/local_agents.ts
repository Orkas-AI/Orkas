/**
 * IPC handlers for local CLI agent discovery.
 *
 * Logical channels exposed to the renderer:
 *   - `localAgents.list`             → all known CLI types with availability + version
 *   - `localAgents.detect`           → single-CLI re-probe (bypasses cache)
 *   - `localAgents.listModels`       → static model catalog for a CLI type
 *   - `localAgents.readToolResult`   → read a spilled CLI tool_result file
 *                                       (renderer click-to-expand)
 *   - `bridge.permission_response`   → renderer answer to a `bridge:permission`
 *                                       push event (orkas-bridge connector-call gate)
 *
 * No `run` channel here — the renderer doesn't spawn CLIs directly;
 * dispatch goes through the existing `groupChat` channel and `bus.ts`
 * routes CLI agents into `features/local_agents/runner.ts` (Step 6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectAll, detectOne, invalidateCache, LOCAL_CLI_TYPES, type LocalCliType, type LocalCliEntry } from '../features/local_agents/registry.js';
import * as bridgePermissions from '../features/local_agents/bridge_permissions.js';
import * as bashPermissions from '../model/core-agent/bash-permissions.js';
import { listModels } from '../features/local_agents/models.js';
import { getActiveUserId } from '../features/users.js';
import { userToolResultsDir } from '../paths.js';
import { createLogger } from '../logger.js';

const log = createLogger('ipc:local_agents');

/** Inline-expand cap. The renderer's <pre> can render a few hundred KB
 *  without freezing, but past that the user wants an editor anyway. We
 *  cap reads here AND tell the renderer via `truncated: true` so it
 *  can suggest opening the file directly. */
const READ_TOOL_RESULT_MAX_BYTES = 256 * 1024;

function isLocalCliType(v: unknown): v is LocalCliType {
  return typeof v === 'string' && (LOCAL_CLI_TYPES as readonly string[]).includes(v);
}

// Set of CLI types we have a working dispatch backend for. Detection
// is independent (registry probes PATH + --version regardless), but
// the create-modal / detail-page selectors shouldn't let users pick a
// CLI we can't actually dispatch through. As of today every detected
// CLI has a backend — left as a guard for future additions where the
// dispatch path lags detection.
const DISPATCHABLE: ReadonlySet<LocalCliType> = new Set<LocalCliType>(
  ['claude', 'codex', 'openclaw', 'opencode', 'hermes'],
);

function maskUnsupported(entries: LocalCliEntry[]): LocalCliEntry[] {
  return entries.map(e => {
    if (DISPATCHABLE.has(e.type)) return e;
    return {
      ...e,
      available: false,
      error: e.error ?? 'version_unknown',
      errorDetail: 'backend not yet implemented in Orkas',
    };
  });
}

export const invokeHandlers = {
  /**
   * List all known CLI types. Default uses the 60s cache; pass
   * `{ force: true }` to invalidate first (settings page refresh button,
   * for instance, would want a fresh probe).
   */
  'localAgents.list': async ({ force = false }: { force?: boolean } = {}) => {
    const entries = await detectAll({ force: !!force });
    return { entries: maskUnsupported(entries) };
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
    return { entry: maskUnsupported([entry])[0] };
  },

  /**
   * Static model catalog for a CLI. Empty array signals the UI to
   * render a free-text input (openclaw / opencode / hermes for now).
   */
  'localAgents.listModels': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    return { models: listModels(type) };
  },

  /**
   * Read a spilled CLI tool_result file. The renderer's click-to-expand
   * UI calls this with the `outputPath` it received on a `tool-event
   * phase:'result'` event.
   *
   * Hard constraints:
   *   - Path MUST resolve under the active uid's
   *     `<uid>/local/tool-results/` directory. Symlink-traversal is
   *     blocked by realpath-comparing against the canonical root, so a
   *     compromised CLI can't trick the renderer into reading
   *     arbitrary files.
   *   - Read is byte-capped (256 KB inline); larger files truncate
   *     and set `truncated: true`. The shell.openPath path for "open
   *     in editor" is a separate IPC, not added in this round.
   *
   * Returns `{ok:true, content, truncated}` or `{ok:false, error}`;
   * never throws across the IPC boundary so a UI bug can't crash the
   * renderer.
   */
  /** Renderer answer to a `bridge:permission` push event. Unknown /
   *  already-timed-out request ids return handled:false (the dialog was
   *  stale); validation is shape-only — the verdict semantics live in
   *  features/local_agents/bridge_permissions.ts. */
  'bridge.permission_response': async (
    payload: { request_id?: unknown; allow?: unknown; always?: unknown },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    if (typeof payload?.allow !== 'boolean') throw new Error('invalid allow flag');
    const handled = bridgePermissions.respond(payload.request_id, payload.allow, payload?.always === true);
    return { handled };
  },

  /** Renderer answer to a `bash:permission` push event (risk_prompt mode).
   *  `decision` ∈ allow_once | allow_run | deny. Unknown / timed-out ids
   *  return handled:false (stale dialog). Verdict semantics live in
   *  model/core-agent/bash-permissions.ts. */
  'bash.permission_response': async (
    payload: { request_id?: unknown; decision?: unknown },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    const d = payload.decision;
    if (d !== 'allow_once' && d !== 'allow_run' && d !== 'deny') throw new Error('invalid decision');
    const handled = bashPermissions.respond(payload.request_id, d);
    return { handled };
  },

  'localAgents.readToolResult': async ({ path: filePath }: { path?: unknown }) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false as const, error: 'invalid path' };
    }
    const uid = (() => {
      try { return getActiveUserId(); }
      catch { return ''; }
    })();
    if (!uid) return { ok: false as const, error: 'no active user' };
    const rootDir = userToolResultsDir(uid);
    // Resolve both sides via realpath when they exist, then compare.
    // The renderer-supplied path may legitimately not exist anymore
    // (sweep ran, tool-result evicted) — handle ENOENT cleanly.
    let resolved: string;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false as const, error: 'file no longer exists' };
      return { ok: false as const, error: `cannot resolve path: ${(err as Error).message}` };
    }
    let rootResolved: string;
    try { rootResolved = fs.realpathSync(rootDir); }
    catch { return { ok: false as const, error: 'tool-results dir not found' }; }
    const rel = path.relative(rootResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      log.warn('readToolResult rejected out-of-scope path', { filePath, uid });
      return { ok: false as const, error: 'path is outside tool-results scope' };
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return { ok: false as const, error: 'not a regular file' };
      const total = stat.size;
      if (total <= READ_TOOL_RESULT_MAX_BYTES) {
        const content = fs.readFileSync(resolved, 'utf8');
        return { ok: true as const, content, truncated: false };
      }
      // Oversized — read head only. Buffer-level slice avoids loading
      // the whole file into memory.
      const fd = fs.openSync(resolved, 'r');
      try {
        const buf = Buffer.alloc(READ_TOOL_RESULT_MAX_BYTES);
        fs.readSync(fd, buf, 0, READ_TOOL_RESULT_MAX_BYTES, 0);
        return { ok: true as const, content: buf.toString('utf8'), truncated: true };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  },
};
