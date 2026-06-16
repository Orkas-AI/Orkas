/**
 * Confirmation gate for commander-driven custom MCP installs (plan §C2
 * entry point 2 — "user pastes an mcp.json fragment, the commander parses
 * and calls the same validated route, install ALWAYS requires a user
 * confirmation dialog; the LLM cannot complete an install alone").
 *
 * The commander's `add_custom_connector` tool validates the transport,
 * then calls `requestInstallConfirm` here. We push `connectors:install-confirm`
 * to the renderer with the EXACT command / url that will be used (the
 * consent surface — for stdio this is the arbitrary-command-execution
 * step), and resolve only when the user answers through the
 * `connectors.install_confirm_response` IPC. No answer within the timeout
 * (or no renderer) ⇒ declined.
 *
 * Mirrors features/local_agents/bridge_permissions.ts; kept separate
 * because connectors and local_agents are different feature domains.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';
import type { Transport } from './types';

const log = createLogger('connector-install-confirm');

const RESPONSE_TIMEOUT_MS = 120 * 1000;

export interface InstallConfirmInfo {
  request_id: string;
  display_name: string;
  /** Human-readable one-liner of what will run / be contacted. */
  summary: string;
  kind: Transport['kind'];
  cid: string;
}

interface Pending {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  cid: string;
}

const _pending = new Map<string, Pending>();

function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) { _broadcastOverride(channel, payload); return true; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch { return false; }
}

let _broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => void) | null): void {
  _broadcastOverride = fn;
}

function _summarize(displayName: string, transport: Transport): string {
  if (transport.kind === 'streamable-http') return `HTTP MCP server: ${transport.url}`;
  return `Local command: ${[transport.command, ...(transport.args || [])].join(' ')}`;
}

export async function requestInstallConfirm(opts: {
  cid: string;
  displayName: string;
  transport: Transport;
}): Promise<boolean> {
  const requestId = crypto.randomBytes(8).toString('hex');
  const info: InstallConfirmInfo = {
    request_id: requestId,
    display_name: opts.displayName,
    summary: _summarize(opts.displayName, opts.transport),
    kind: opts.transport.kind,
    cid: opts.cid,
  };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(requestId);
      log.warn('install confirm timed out → declined', { requestId });
      resolve(false);
    }, RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _pending.set(requestId, { resolve, timer, cid: opts.cid });
    if (!_broadcast('connectors:install-confirm', info)) {
      log.warn('no renderer broadcast — install will decline on timeout', { requestId });
    }
  });
}

/** Renderer answer via `connectors.install_confirm_response`. Unknown ids
 *  (stale dialog after timeout) return false. */
export function respond(requestId: string, approved: boolean): boolean {
  const pending = _pending.get(requestId);
  if (!pending) return false;
  _pending.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(approved);
  return true;
}

export function cancelForCid(cid: string): void {
  for (const [id, pending] of _pending) {
    if (pending.cid !== cid) continue;
    _pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
}
