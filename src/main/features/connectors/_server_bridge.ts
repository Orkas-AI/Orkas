/**
 * Server-bridge stubs for connector OAuth in the open-source build.
 *
 * PC's `features/connectors/oauth*.ts` reaches into `features/account/{server,token_store}` for:
 *   - `accountApiBase()` — the connector Server base URL
 *   - `tokenStore.getDeviceId()` — stable per-machine UUID
 *   - `tokenStore.authHeaders()` — `{user_id, session_id}` for the logged-in PC user
 *
 * `features/account/` is stripped from the public build (no account backend). Connectors still
 * need the first two pieces for their callback/bridge. Server-bridge exchange
 * and refresh accept `channel=open` plus this stable device id; the third piece is always empty
 * because this build never has an Orkas account session. Paid connector routes add the user's
 * separately stored Orkas API Key in their own connector modules.
 *
 * Where each piece comes from:
 *   - `accountApiBase` uses the local dev Server for source runs and the global production
 *     Server for packaged builds. Marketplace routing is independent.
 *   - `getDeviceId()` persists a UUID at `<uid>/local/config/device.json` on first call. Stable
 *     across runs on the same machine; resets if the user wipes the local config dir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { app } from 'electron';

import { userLocalConfigDir } from '../../paths';
import { getActiveUserId } from '../users';
import { apiBase } from '../marketplace';

export function accountApiBase(): string {
  if (app?.isPackaged === false) return 'http://localhost:8888/api';
  return apiBase();
}

const DEVICE_FILE = 'device.json';
let _cachedDeviceId: string | null = null;

function _activeOrFallbackUid(): string {
  try {
    return getActiveUserId();
  } catch {
    return 'anonymous';
  }
}

function _readDeviceId(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw) as { device_id?: unknown };
    if (typeof obj.device_id === 'string' && obj.device_id) return obj.device_id;
  } catch { /* missing / malformed → regenerate */ }
  return null;
}

function _writeDeviceId(file: string, id: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ device_id: id }, null, 2), 'utf8');
}

export const tokenStore = {
  getDeviceId(): string {
    if (_cachedDeviceId) return _cachedDeviceId;
    const file = path.join(userLocalConfigDir(_activeOrFallbackUid()), DEVICE_FILE);
    const existing = _readDeviceId(file);
    if (existing) {
      _cachedDeviceId = existing;
      return existing;
    }
    const fresh = crypto.randomUUID();
    _writeDeviceId(file, fresh);
    _cachedDeviceId = fresh;
    return fresh;
  },

  authHeaders(): Record<string, string> {
    // Never synthesize account headers. Server-bridge routes derive a pseudonymous owner only
    // when the canonical client channel is `open` and the request carries this device id.
    return {};
  },
};
