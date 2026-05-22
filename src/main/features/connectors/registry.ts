/**
 * Persistence for the connectors registry.
 *
 * Single-file JSON at `<uid>/cloud/config/connectors.json` (see `paths.ts::userConnectorsConfigFile`).
 * **File body is plaintext JSON**; each instance's sensitive blob (`oauth_grant` + `dcr_client` +
 * `transport`) is packed into a single per-instance `secrets_enc` field encrypted via
 * `util/crypto-vault.ts` (PBKDF2 → AES-256-GCM). Metadata fields (`display_name` / `status` /
 * `tools_cache` / timestamps) stay plaintext so Server-side iOS-clients-facing readers can list
 * connectors without holding the vault key. `transport` sits in the secrets blob even though it
 * isn't a "secret" by name — `applyTemplate` bakes the resolved `access_token` into
 * `transport.env[oauth_env_key]` (stdio) / `transport.headers.Authorization` (streamable-http);
 * leaving it plaintext would defeat the whole encryption. Runtime cost is zero:
 * `manager.ts::_resolveTransport` re-runs `applyTemplate` from the catalog template + fresh
 * `oauth_grant` on every connect, so the persisted transport is purely vestigial. The read path
 * also accepts the legacy whole-file vault format produced by pre-LOCAL_DATA_VERSION=2 builds;
 * the next write naturally upgrades the file in place.
 *
 * **Vault seed = Orkas-account OAuth user_id (when logged in), else local uid**. Same OAuth
 * user_id on every device the user signs into → cross-device decryption after cloud sync.
 * OrkasOpen / not-logged-in falls back to local uid (file then sits in cloud/config/ but the
 * sync engine is inactive without an account, so it stays machine-private de facto). See
 * `_vaultSeed` for the resolution.
 *
 * Sync trigger: each write fires `syncFeature.markDirty('connectors', 'cloud/config/connectors.json')`
 * so user actions (install / disconnect / refresh) push within the debounce window rather than
 * waiting for the 5-min periodic. Like sync itself, gracefully no-ops in builds that strip
 * `features/sync` (OrkasOpen).
 *
 * All writes are serialized via async-mutex so two concurrent IPC calls can't race-overwrite.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';

import { userConnectorsConfigFile } from '../../paths';
import { createLogger } from '../../logger';
import * as cryptoVault from '../../util/crypto-vault';
import type { ConnectorInstance, ConnectorsFile, OAuthGrant, DcrClientCredentials, Transport } from './types';

const log = createLogger('connectors:registry');
const _writeMutex = new Mutex();

const EMPTY: ConnectorsFile = { version: 2, connections: {} };

// On-disk shape: ConnectorInstance with all token-bearing fields collapsed into one
// vault-encrypted `secrets_enc` string. **`transport` is in the blob too** — even though it's
// not a "secret" by name, `applyTemplate` bakes the resolved `access_token` into
// `transport.env[oauth_env_key]` (stdio) / `transport.headers.Authorization` (streamable-http);
// leaving it plaintext on disk would defeat the whole encryption. `manager.ts::_resolveTransport`
// re-runs `applyTemplate` from the catalog template + fresh `oauth_grant` on every connect, so
// the persisted transport is purely vestigial at runtime — sealing it has zero runtime cost.
// Only this module is aware of the disk form.
type InstanceOnDisk = Omit<ConnectorInstance, 'oauth_grant' | 'dcr_client' | 'transport'> & {
  secrets_enc?: string;
  // Kept optional in the disk type so a hydrate failure can still surface a row (with `transport`
  // unset and oauth_grant unset) — manager will mark it `status:error` and the user re-OAuths.
};
interface SecretsBlob { oauth_grant?: OAuthGrant; dcr_client?: DcrClientCredentials; transport?: Transport }

// Vault-seed resolver. OrkasOpen strips `features/account`, so there is no
// cross-device OAuth user_id to fall back to — the seed is always the local uid.
function _vaultSeed(uid: string): string {
  return uid;
}

// features/sync stripped from the OrkasOpen build — `_notifyDirty` is a no-op.
function _notifyDirty(): void {
  /* no-op */
}

// Decrypt with the active seed; fall back to local-uid for files written before the
// 2026-05-15 cloud-sync rekey OR for OrkasOpen / pre-login users who only ever had the
// local-uid encryption path. AES-GCM's auth tag makes wrong-key attempts throw cleanly — no
// plaintext leakage.
function _tryDecrypt(uid: string, payload: string): string | null {
  const primary = _vaultSeed(uid);
  try { return cryptoVault.decrypt(primary, payload); } catch { /* try fallback */ }
  if (primary !== uid) {
    try { return cryptoVault.decrypt(uid, payload); } catch { /* both failed */ }
  }
  return null;
}

function _hydrateSecrets(uid: string, disk: InstanceOnDisk): ConnectorInstance {
  const { secrets_enc, ...rest } = disk;
  // transport is required on ConnectorInstance but absent from the disk shape — it lives in the
  // secrets blob. Cast through; manager.ts handles the no-transport / no-grant case via
  // `_resolveTransport` returning null → status:error.
  const out = { ...rest } as ConnectorInstance;
  if (!secrets_enc) return out;
  const json = _tryDecrypt(uid, secrets_enc);
  if (json === null) {
    log.warn('decrypt secrets_enc failed (both seeds) — instance left without transport/grant', { id: disk.id });
    return out;
  }
  try {
    const blob = JSON.parse(json) as SecretsBlob;
    if (blob.oauth_grant) out.oauth_grant = blob.oauth_grant;
    if (blob.dcr_client) out.dcr_client = blob.dcr_client;
    if (blob.transport) out.transport = blob.transport;
  } catch (err) {
    log.warn('parse secrets_enc payload failed', { id: disk.id, error: (err as Error).message });
  }
  return out;
}

function _dehydrateSecrets(uid: string, inst: ConnectorInstance): InstanceOnDisk {
  const { oauth_grant, dcr_client, transport, ...rest } = inst;
  const onDisk = { ...rest } as InstanceOnDisk;
  if (oauth_grant || dcr_client || transport) {
    const blob: SecretsBlob = {};
    if (oauth_grant) blob.oauth_grant = oauth_grant;
    if (dcr_client) blob.dcr_client = dcr_client;
    if (transport) blob.transport = transport;
    onDisk.secrets_enc = cryptoVault.encrypt(_vaultSeed(uid), JSON.stringify(blob));
  }
  return onDisk;
}

function _readSync(uid: string): ConnectorsFile {
  const file = userConnectorsConfigFile(uid);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('reading connectors.json failed', { error: (err as Error).message });
    }
    return { version: 2, connections: {} };
  }
  if (!raw.trim()) return { version: 2, connections: {} };

  // Legacy whole-file vault format: decrypt once, plaintext JSON already has oauth_grant /
  // dcr_client as plain fields per instance — return as-is. Next write upgrades to per-field.
  if (cryptoVault.isEncryptedPayload(raw)) {
    const json = _tryDecrypt(uid, raw);
    if (json === null) {
      log.warn('decrypt connectors.json (legacy whole-file) failed with both seeds — treating as empty');
      return { version: 2, connections: {} };
    }
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj === 'object' && obj.connections && typeof obj.connections === 'object') {
        return { version: 2, connections: obj.connections as Record<string, ConnectorInstance> };
      }
    } catch (err) {
      log.warn('parse connectors.json (legacy whole-file) failed', { error: (err as Error).message });
    }
    return { version: 2, connections: {} };
  }

  // Current format: plaintext JSON envelope, secrets_enc per instance.
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.connections && typeof obj.connections === 'object') {
      const conns: Record<string, ConnectorInstance> = {};
      for (const [id, disk] of Object.entries(obj.connections as Record<string, InstanceOnDisk>)) {
        conns[id] = _hydrateSecrets(uid, disk);
      }
      return { version: 2, connections: conns };
    }
  } catch (err) {
    log.warn('parse connectors.json failed', { error: (err as Error).message });
  }
  return { version: 2, connections: {} };
}

function _writeSync(uid: string, data: ConnectorsFile): void {
  const file = userConnectorsConfigFile(uid);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const onDisk: Record<string, InstanceOnDisk> = {};
    for (const [id, inst] of Object.entries(data.connections)) {
      onDisk[id] = _dehydrateSecrets(uid, inst);
    }
    const body = JSON.stringify({ version: 2, connections: onDisk }, null, 2);
    fs.writeFileSync(file, body, { mode: 0o600 });
    // Diagnostic verify: read back size + the secrets_enc fingerprints we just wrote so a
    // future "the RT we sent doesn't match server" failure can be traced against actual
    // bytes on disk at write time. `secrets_enc` is the AES-GCM blob; comparing its first
    // 16 chars across log entries reveals whether a subsequent write clobbered this one.
    try {
      const st = fs.statSync(file);
      const fingerprints: Record<string, string> = {};
      for (const [id, disk] of Object.entries(onDisk)) {
        if (disk.secrets_enc) fingerprints[id] = disk.secrets_enc.slice(0, 16);
      }
      log.info('connectors.json write ok', {
        bytes: st.size,
        mtime_ms: st.mtimeMs,
        secrets_enc_prefix: fingerprints,
      });
    } catch (verifyErr) {
      log.warn('write verify (stat) failed', { error: (verifyErr as Error).message });
    }
  } catch (err) {
    log.error('failed to persist connectors.json', { error: (err as Error).message });
    throw err;
  }
}

export function load(uid: string): ConnectorsFile {
  if (!uid) return EMPTY;
  return _readSync(uid);
}

/** Compact RT fingerprint for diagnostic logs across the registry call chain. */
function _rt(grant: ConnectorInstance['oauth_grant']): string {
  const t = grant?.refresh_token;
  if (!t) return 'none';
  return crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
}

export async function upsert(uid: string, inst: ConnectorInstance): Promise<void> {
  await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    const before = cur.connections[inst.id];
    log.info('registry.upsert', {
      id: inst.id,
      rt_before: _rt(before?.oauth_grant),
      rt_after: _rt(inst.oauth_grant),
      had_existing: !!before,
    });
    cur.connections[inst.id] = inst;
    _writeSync(uid, cur);
  });
  _notifyDirty();
}

export async function remove(uid: string, id: string): Promise<boolean> {
  const removed = await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    if (!cur.connections[id]) return false;
    log.info('registry.remove', { id, rt_before: _rt(cur.connections[id].oauth_grant) });
    delete cur.connections[id];
    _writeSync(uid, cur);
    return true;
  });
  if (removed) _notifyDirty();
  return removed;
}

export async function update(
  uid: string,
  id: string,
  patch: (inst: ConnectorInstance) => ConnectorInstance,
): Promise<ConnectorInstance | null> {
  const next = await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    const existing = cur.connections[id];
    if (!existing) return null;
    const updated = patch(existing);
    log.info('registry.update', {
      id,
      rt_before: _rt(existing.oauth_grant),
      rt_after: _rt(updated.oauth_grant),
      rt_changed: existing.oauth_grant?.refresh_token !== updated.oauth_grant?.refresh_token,
    });
    cur.connections[id] = updated;
    _writeSync(uid, cur);
    return updated;
  });
  if (next) _notifyDirty();
  return next;
}

export function isValidInstanceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}
