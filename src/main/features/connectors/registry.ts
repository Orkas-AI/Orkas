/**
 * Persistence for the connectors registry.
 *
 * Single-file JSON at `<uid>/local/config/connectors.json` (see `paths.ts::userConnectorsConfigFile`),
 * encrypted via `crypto-vault.ts` (PBKDF2-derived AES-256-GCM). Plaintext-fallback on read for
 * forward compatibility with files written by an earlier (Phase 0 alpha) version of this module;
 * detected plaintext is parsed and immediately re-written as ciphertext on the next save.
 *
 * Why encrypted on disk: stores OAuth bearer tokens. Even though the crypto is "obfuscation-grade"
 * (key derivable from uid alone), it covers the realistic threat surface — backup tooling, log
 * grep, sync corner cases — see `crypto-vault.ts` header.
 *
 * All writes are serialized via async-mutex so two concurrent IPC calls can't race-overwrite.
 */
import * as fs from 'node:fs';
import { Mutex } from 'async-mutex';

import { userConnectorsConfigFile, userLocalConfigDir } from '../../paths';
import { createLogger } from '../../logger';
import * as cryptoVault from '../../util/crypto-vault';
import type { ConnectorInstance, ConnectorsFile } from './types';

const log = createLogger('connectors:registry');
const _writeMutex = new Mutex();

const EMPTY: ConnectorsFile = { version: 1, connections: {} };

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
    return { version: 1, connections: {} };
  }
  if (!raw.trim()) return { version: 1, connections: {} };
  let json: string;
  try {
    json = cryptoVault.isEncryptedPayload(raw) ? cryptoVault.decrypt(uid, raw) : raw;
  } catch (err) {
    log.warn('decrypt connectors.json failed', { error: (err as Error).message });
    return { version: 1, connections: {} };
  }
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && obj.connections && typeof obj.connections === 'object') {
      return { version: 1, connections: obj.connections as Record<string, ConnectorInstance> };
    }
  } catch (err) {
    log.warn('parse connectors.json failed', { error: (err as Error).message });
  }
  return { version: 1, connections: {} };
}

function _writeSync(uid: string, data: ConnectorsFile): void {
  const file = userConnectorsConfigFile(uid);
  try {
    fs.mkdirSync(userLocalConfigDir(uid), { recursive: true });
    const enc = cryptoVault.encrypt(uid, JSON.stringify(data, null, 2));
    fs.writeFileSync(file, enc, { mode: 0o600 });
  } catch (err) {
    log.error('failed to persist connectors.json', { error: (err as Error).message });
    throw err;
  }
}

export function load(uid: string): ConnectorsFile {
  if (!uid) return EMPTY;
  return _readSync(uid);
}

export async function upsert(uid: string, inst: ConnectorInstance): Promise<void> {
  await _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    cur.connections[inst.id] = inst;
    _writeSync(uid, cur);
  });
}

export async function remove(uid: string, id: string): Promise<boolean> {
  return _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    if (!cur.connections[id]) return false;
    delete cur.connections[id];
    _writeSync(uid, cur);
    return true;
  });
}

export async function update(
  uid: string,
  id: string,
  patch: (inst: ConnectorInstance) => ConnectorInstance,
): Promise<ConnectorInstance | null> {
  return _writeMutex.runExclusive(async () => {
    const cur = _readSync(uid);
    const existing = cur.connections[id];
    if (!existing) return null;
    const next = patch(existing);
    cur.connections[id] = next;
    _writeSync(uid, cur);
    return next;
  });
}

export function isValidInstanceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}
