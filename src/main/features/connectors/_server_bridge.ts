/**
 * Server-bridge stubs for connector OAuth in the open-source build.
 *
 * PC's `features/connectors/oauth*.ts` reaches into `features/account/{server,token_store}` for:
 *   - `accountApiBase()` — the Orkas global prod Server base URL
 *   - `tokenStore.getDeviceId()` — stable per-machine UUID
 *   - `tokenStore.authHeaders()` — `{user_id, session_id}` for the logged-in user
 *
 * `features/account/` is stripped from the open-source build (no account backend). Connectors still need the
 * first two pieces because the Server bridges every connector OAuth flow regardless of login
 * state (`/connectors/oauth/exchange` accepts a `device_id`-only request, per PC/CLAUDE.md §6.5
 * "open-source connectors" section). The third piece is always empty here because there is no Orkas
 * session in the open-source build, but exposing the same signature keeps the call sites identical.
 *
 * Where each piece comes from:
 *   - `accountApiBase` aliases `features/marketplace.apiBase()` (global prod only — single
 *     source of truth across all Server-bridged features in this build).
 *   - `getDeviceId()` persists a UUID at `<uid>/local/config/device.json` on first call. Stable
 *     across runs on the same machine; resets if the user wipes the local config dir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userLocalConfigDir } from '../../paths';
import { getActiveUserId } from '../users';
import { apiBase } from '../marketplace';

export function accountApiBase(): string {
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
    // The open-source build has no Orkas account session. The Server's `/connectors/oauth/exchange`
    // endpoint accepts device_id-only requests for this build (per PC/CLAUDE.md §6.5).
    return {};
  },
};
