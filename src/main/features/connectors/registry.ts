/**
 * Persistence for the connectors registry.
 *
 * Single-file JSON at `<uid>/cloud/config/connectors.json` (see `paths.ts::userConnectorsConfigFile`).
 * **File body is plaintext JSON**; each instance's sensitive blob (`oauth_grant` + `dcr_client` +
 * `transport`) is packed into a single per-instance `secrets_enc` field encrypted via
 * `util/local-secret-store.ts`. Metadata fields (`display_name` / `status` /
 * `tools_cache` / timestamps) stay plaintext so Server-side iOS-clients-facing readers can list
 * connectors without holding the local secret backend. `transport` sits in the secrets blob even though it
 * isn't a "secret" by name — `applyTemplate` bakes the resolved `access_token` into
 * `transport.env[oauth_env_key]` (stdio) / `transport.headers.Authorization` (streamable-http);
 * leaving it plaintext would defeat the whole encryption. Runtime cost is zero:
 * `manager.ts::_resolveTransport` re-runs `applyTemplate` from the catalog template + fresh
 * `oauth_grant` on every connect, so the persisted transport is purely vestigial. The read path
 * accepts the immediately previous per-instance `crypto-vault` `secrets_enc` format and upgrades
 * it in place.
 *
 * **Secret owner = Orkas-account OAuth user_id (when logged in), else local uid**. Same OAuth
 * user_id on every device the user signs into → cross-device decryption after cloud sync.
 * Open-source / not-logged-in falls back to local uid (file then sits in cloud/config/ but the
 * sync engine is inactive without an account, so it stays machine-private de facto). See
 * `_secretOwner` for the resolution.
 *
 * Sync trigger: each write fires `syncFeature.markDirty('connectors', 'cloud/config/connectors.json')`
 * so user actions (install / disconnect / refresh) push within the debounce window rather than
 * waiting for the 5-min periodic. Like sync itself, gracefully no-ops in builds that strip
 * `features/sync` (open-source build).
 *
 * All writes are serialized via async-mutex so two concurrent IPC calls can't race-overwrite.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';

import { userConnectorsConfigFile } from '../../paths';
import { createLogger } from '../../logger';
import * as localSecrets from '../../util/local-secret-store';
import type { ConnectorInstance, ConnectorsFile, OAuthGrant, DcrClientCredentials, Transport } from './types';

const log = createLogger('connectors:registry');
const _writeMutex = new Mutex();

const EMPTY: ConnectorsFile = { version: 2, connections: {}, oauth_hints: {}, _deleted_at: {} };
const CONNECTOR_SECRET_NAMESPACE = 'connectors.instance';
const SECRETS_UNAVAILABLE_MESSAGE = 'connector_reconnect_required';

// On-disk shape: ConnectorInstance with all token-bearing fields collapsed into one
// locally encrypted `secrets_enc` string. **`transport` is in the blob too** — even though it's
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

const PRESERVED_SECRETS = Symbol('preservedConnectorSecrets');
interface PreservedSecrets {
  ciphertext: string;
  /** Canonical plaintext that produced `ciphertext`. Missing means decryption
   * failed; the blob may only be reused while no replacement secrets exist. */
  plaintext?: string;
}
type ConnectorInstanceWithPreservedSecrets = ConnectorInstance & { [PRESERVED_SECRETS]?: PreservedSecrets };

// Secret-owner resolver. The open-source build stores connector secrets under the local uid.
function _secretOwner(uid: string): string {
  return uid;
}

function _secretContext(uid: string, instanceId: string): localSecrets.LocalSecretContext {
  return {
    namespace: CONNECTOR_SECRET_NAMESPACE,
    ownerId: _secretOwner(uid),
    recordId: instanceId,
  };
}

function _notifyDirty(): void {
  // The open-source build is local-only; cloud sync notification is intentionally absent.
}

function _notifyRendererChanged(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('connectors:changed', { changed: true });
  } catch { /* tests / open-source build may not have the IPC bridge loaded */ }
}

function _notifyChanged(): void {
  _notifyDirty();
  _notifyRendererChanged();
}

function _legacySeeds(uid: string): string[] {
  const primary = _secretOwner(uid);
  return primary === uid ? [uid] : [primary, uid];
}

function _tryDecrypt(uid: string, instanceId: string, payload: string): { json: string; migrated: boolean } | null {
  try {
    const dec = localSecrets.decryptLocalSecretWithMeta(
      _secretContext(uid, instanceId),
      payload,
      { legacySeeds: _legacySeeds(uid) },
    );
    return { json: dec.plaintext, migrated: localSecrets.shouldRewriteLocalSecret(dec.kind) };
  } catch {
    return null;
  }
}

function _hydrateSecrets(uid: string, disk: InstanceOnDisk): { instance: ConnectorInstance; migrated: boolean } {
  const { secrets_enc, ...rest } = disk;
  // transport is required on ConnectorInstance but absent from the disk shape — it lives in the
  // secrets blob. Cast through; manager.ts handles the no-transport / no-grant case via
  // `_resolveTransport` returning null → status:error.
  const out = { ...rest } as ConnectorInstance;
  if (!secrets_enc) return { instance: out, migrated: false };
  const dec = _tryDecrypt(uid, disk.id, secrets_enc);
  if (dec === null) {
    log.warn('decrypt secrets_enc failed (known formats) — instance left without transport/grant', { id: disk.id });
    out.status = { kind: 'error', message: SECRETS_UNAVAILABLE_MESSAGE, at: Date.now() };
    (out as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS] = { ciphertext: secrets_enc };
    return { instance: out, migrated: false };
  }
  try {
    const blob = JSON.parse(dec.json) as SecretsBlob;
    if (blob.oauth_grant) out.oauth_grant = blob.oauth_grant;
    if (blob.dcr_client) out.dcr_client = blob.dcr_client;
    if (blob.transport) out.transport = blob.transport;
    // Metadata-only writes dominate connector startup. Keep the exact sealed
    // value when its plaintext is unchanged so status/tool-cache updates do
    // not repeatedly invoke the local secret backend.
    if (!dec.migrated) {
      (out as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS] = {
        ciphertext: secrets_enc,
        plaintext: dec.json,
      };
    }
  } catch (err) {
    log.warn('parse secrets_enc payload failed', { id: disk.id, error: (err as Error).message });
    out.status = { kind: 'error', message: SECRETS_UNAVAILABLE_MESSAGE, at: Date.now() };
    (out as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS] = { ciphertext: secrets_enc };
    return { instance: out, migrated: false };
  }
  return { instance: out, migrated: dec.migrated };
}

function _dehydrateSecrets(uid: string, inst: ConnectorInstance): InstanceOnDisk {
  const { oauth_grant, dcr_client, transport, ...rest } = inst;
  const onDisk = { ...rest } as InstanceOnDisk;
  if (oauth_grant || dcr_client || transport) {
    const blob: SecretsBlob = {};
    if (oauth_grant) blob.oauth_grant = oauth_grant;
    if (dcr_client) blob.dcr_client = dcr_client;
    if (transport) blob.transport = transport;
    const plaintext = JSON.stringify(blob);
    const preserved = (inst as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS];
    const ciphertext = preserved?.plaintext === plaintext
      ? preserved.ciphertext
      : localSecrets.encryptLocalSecret(_secretContext(uid, inst.id), plaintext);
    onDisk.secrets_enc = ciphertext;
    (inst as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS] = { ciphertext, plaintext };
  } else {
    const preserved = (inst as ConnectorInstanceWithPreservedSecrets)[PRESERVED_SECRETS];
    if (preserved && preserved.plaintext === undefined) onDisk.secrets_enc = preserved.ciphertext;
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
    return { version: 2, connections: {}, oauth_hints: {}, _deleted_at: {} };
  }
  if (!raw.trim()) return { version: 2, connections: {}, oauth_hints: {}, _deleted_at: {} };

  // Current format: plaintext JSON envelope, secrets_enc per instance. The only legacy form
  // migrated here is the immediately previous per-instance crypto-vault payload.
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.connections && typeof obj.connections === 'object') {
      const conns: Record<string, ConnectorInstance> = {};
      let migrated = false;
      for (const [id, disk] of Object.entries(obj.connections as Record<string, InstanceOnDisk>)) {
        const hydrated = _hydrateSecrets(uid, disk);
        conns[id] = hydrated.instance;
        migrated = migrated || hydrated.migrated;
      }
      const oauthHints = obj.oauth_hints && typeof obj.oauth_hints === 'object' ? obj.oauth_hints : {};
      const deletedAt = obj._deleted_at && typeof obj._deleted_at === 'object' ? obj._deleted_at : {};
      const data: ConnectorsFile = { version: 2, connections: conns, oauth_hints: oauthHints, _deleted_at: deletedAt };
      if (migrated) {
        _writeSync(uid, data);
        _notifyChanged();
      }
      return data;
    }
  } catch (err) {
    log.warn('parse connectors.json failed', { error: (err as Error).message });
  }
  return { version: 2, connections: {}, oauth_hints: {}, _deleted_at: {} };
}

function _writeSync(uid: string, data: ConnectorsFile): void {
  const file = userConnectorsConfigFile(uid);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const onDisk: Record<string, InstanceOnDisk> = {};
    for (const [id, inst] of Object.entries(data.connections)) {
      onDisk[id] = _dehydrateSecrets(uid, inst);
    }
    const body = JSON.stringify({
      version: 2,
      connections: onDisk,
      oauth_hints: data.oauth_hints || {},
      _deleted_at: data._deleted_at || {},
    }, null, 2);
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
    if (cur._deleted_at?.[inst.id]) {
      const deleted = { ...(cur._deleted_at || {}) };
      delete deleted[inst.id];
      cur._deleted_at = deleted;
    }
    _writeSync(uid, cur);
  });
  _notifyChanged();
}

export async function remove(uid: string, id: string): Promise<boolean> {
  const removed = await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    if (!cur.connections[id]) return false;
    log.info('registry.remove', { id, rt_before: _rt(cur.connections[id].oauth_grant) });
    delete cur.connections[id];
    if (cur.oauth_hints?.[id]) {
      const hints = { ...(cur.oauth_hints || {}) };
      delete hints[id];
      cur.oauth_hints = hints;
    }
    cur._deleted_at = { ...(cur._deleted_at || {}), [id]: new Date().toISOString() };
    _writeSync(uid, cur);
    return true;
  });
  if (removed) _notifyChanged();
  return removed;
}

export function shouldReauthorize(uid: string, id: string): boolean {
  if (!uid || !id) return false;
  const file = _readSync(uid);
  return !!file.oauth_hints?.[id]?.reauthorize;
}

export async function setReauthorizeHint(uid: string, id: string, enabled: boolean): Promise<void> {
  if (!uid || !id) return;
  await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    const hints = { ...(cur.oauth_hints || {}) };
    if (enabled) hints[id] = { ...(hints[id] || {}), reauthorize: true };
    else delete hints[id];
    cur.oauth_hints = hints;
    _writeSync(uid, cur);
  });
  _notifyChanged();
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
  if (next) _notifyChanged();
  return next;
}

export type ConnectorInstancePatch = (inst: ConnectorInstance) => ConnectorInstance;

/** Apply several per-instance patches under one registry lock and persist the
 *  aggregate file once. Intended for startup probes, where each connection
 *  independently discovers status/tools but none needs an intermediate disk
 *  snapshot. Secret-rotation paths continue to use `update` immediately. */
export async function updateMany(
  uid: string,
  patches: ReadonlyMap<string, readonly ConnectorInstancePatch[]>,
): Promise<Record<string, ConnectorInstance>> {
  const updated = await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    const out: Record<string, ConnectorInstance> = {};
    for (const [id, instancePatches] of patches) {
      const existing = cur.connections[id];
      if (!existing || !instancePatches.length) continue;
      let next = existing;
      for (const patch of instancePatches) next = patch(next);
      log.info('registry.updateMany', {
        id,
        patches: instancePatches.length,
        rt_before: _rt(existing.oauth_grant),
        rt_after: _rt(next.oauth_grant),
      });
      cur.connections[id] = next;
      out[id] = next;
    }
    if (Object.keys(out).length) _writeSync(uid, cur);
    return out;
  });
  if (Object.keys(updated).length) _notifyChanged();
  return updated;
}

export function isValidInstanceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}
