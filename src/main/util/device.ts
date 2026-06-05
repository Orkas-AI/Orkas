/**
 * Device fingerprint helper — resolves a stable per-machine identifier
 * (MAC address of the first non-internal NIC) + the display hostname.
 *
 * Used by `features/auto_tasks.ts` to bind each task to the machine it
 * was created on: only that machine fires the task, but every device can
 * read / edit the task config (it cloud-syncs through `<uid>/cloud/`).
 *
 * Why not reuse `features/account/token_store.ts::getDeviceId`?
 *   - That returns a random UUID, not the MAC the user asked for.
 *   - The whole `features/account/` module is stripped from OrkasOpen
 *     builds; auto-tasks must work offline-first.
 *
 * Stable for the process lifetime — cached on first read. Network adapter
 * swap mid-session → restart picks up the new MAC (acceptable: rare event,
 * and the task will need to be re-created or its `device_id` rebound by
 * a future migration if we ever ship one).
 */

import * as os from 'node:os';

import { createLogger } from '../logger';

const log = createLogger('device');

export interface DeviceFingerprint {
  /** MAC address of the first non-internal NIC, lowercased, colon-separated.
   *  Empty string if none could be resolved (eg. a sandbox with no NICs). */
  id: string;
  /** `os.hostname()` at process start, never empty (falls back to a generic
   *  string when the OS returns an empty name). */
  name: string;
}

let _cached: DeviceFingerprint | null = null;

export function getCurrentDevice(): DeviceFingerprint {
  if (_cached) return _cached;
  const name = (os.hostname() || '').trim() || `PC (${process.platform})`;
  let mac = '';
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const addr of list) {
        if (addr.internal) continue;
        if (!addr.mac || addr.mac === '00:00:00:00:00:00') continue;
        mac = addr.mac.toLowerCase();
        break;
      }
      if (mac) break;
    }
  } catch (err) {
    log.warn(`os.networkInterfaces failed: ${(err as Error).message}`);
  }
  _cached = { id: mac, name };
  return _cached;
}

/** Test seam — drop the memo so subsequent calls re-resolve. */
export function _resetDeviceCacheForTests(): void { _cached = null; }
