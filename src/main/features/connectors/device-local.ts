/** Storage boundary for catalog connectors whose CLI and authorization belong to one device. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  userConnectorsConfigFile, userComponentEnabledFile, userLocalConfigDir,
  userDeviceConnectorsConfigFile, userDeviceConnectorEnabledFile,
} from '../../paths';
import { writeTextAtomicSync } from '../../storage';
import { CONNECTOR_CATALOG } from './catalog';

const entries = CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'local_cli');
const ids = new Set(entries.map((entry) => entry.id));
type JsonObject = Record<string, any>;
const preparedFiles = new Map<string, string>();

function fingerprint(files: string[]): string {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw new Error('connector storage could not be read');
    }
  }).join('|');
}

export function isDeviceLocalConnector(id: string): boolean {
  return ids.has(id);
}

export function connectorRecordsForScope<T>(records: Record<string, T> | undefined, local: boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(records || {}).filter(([id]) => isDeviceLocalConnector(id) === local));
}

/** Returns the original object when no CLI state is present, preserving no-op sync bytes. */
export function cloudConnectorConfig(relPath: string, value: JsonObject): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let result = value;
  const strip = (key: string) => {
    const bucket = value[key];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return;
    if (!Object.keys(bucket).some(isDeviceLocalConnector)) return;
    result = { ...result, [key]: connectorRecordsForScope(bucket, false) };
  };
  if (relPath === 'cloud/config/connectors.json') {
    for (const key of ['connections', 'oauth_hints', '_deleted_at']) strip(key);
  } else if (relPath === 'cloud/config/component-enabled.json') {
    strip('connectors');
    const clocks = value._item_updated_at?.connectors;
    if (clocks && Object.keys(clocks).some(isDeviceLocalConnector)) {
      result = { ...result, _item_updated_at: {
        ...value._item_updated_at, connectors: connectorRecordsForScope(clocks, false),
      } };
    }
  }
  return result;
}

export function cloudConnectorConfigBytes(relPath: string, body: Buffer): Buffer {
  if (relPath !== 'cloud/config/connectors.json' && relPath !== 'cloud/config/component-enabled.json') return body;
  const value = JSON.parse(body.toString('utf8'));
  const filtered = cloudConnectorConfig(relPath, value);
  return filtered === value ? body : Buffer.from(JSON.stringify(filtered, null, 2));
}

function readObject(file: string, strict = true): JsonObject | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new Error('invalid connector storage');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (!strict) return null;
    // Never overwrite an unreadable local decision or remove its migration source.
    throw new Error('connector storage could not be read');
  }
}

function writeObject(file: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomicSync(file, JSON.stringify(value, null, 2), 'utf8', { mode: 0o600 });
}

/** Preserve prior local installations before removing legacy cloud rows. An install marker
 * proves only local setup, never authorization: imported rows must reconnect and verify.
 * Saving both local files first makes an interrupted cleanup safe to retry. Their existence
 * also prevents later cloud pulls (or a disconnect followed by a restart) from recreating rows.
 */
export function prepareDeviceLocalConnectorStorage(uid: string): void {
  const localFile = userDeviceConnectorsConfigFile(uid);
  const enabledFile = userDeviceConnectorEnabledFile(uid);
  const cloudFile = userConnectorsConfigFile(uid);
  const cloudEnabledFile = userComponentEnabledFile(uid);
  const files = [localFile, enabledFile, cloudFile, cloudEnabledFile];
  if (preparedFiles.get(localFile) === fingerprint(files)) return;
  const cloud = readObject(cloudFile, false);
  const cloudEnabled = readObject(cloudEnabledFile, false);
  let local = readObject(localFile);
  const enabled = readObject(enabledFile);
  if (!local) {
    const connections: JsonObject = {};
    for (const entry of entries) {
      const marker = path.join(userLocalConfigDir(uid), 'connector-cli', entry.id, '.orkas-cli-integrity.json');
      let installed: JsonObject | null;
      try { installed = readObject(marker); } catch { continue; }
      const config = entry.local_cli!;
      if (typeof installed?.package !== 'string' || !installed.package.startsWith(`${config.package_name}@`)
        || typeof installed.integrity !== 'string' || !installed.integrity) continue;
      const old = cloud?.connections?.[entry.id];
      const now = new Date().toISOString();
      connections[entry.id] = {
        id: entry.id, display_name: entry.display_name,
        enabled_subtools: Array.isArray(old?.enabled_subtools) ? old.enabled_subtools : null,
        tools_cache: [], tools_cached_at: 0, status: { kind: 'connecting' },
        created_at: typeof old?.created_at === 'string' ? old.created_at : now, updated_at: now,
      };
    }
    local = { version: 2, connections, oauth_hints: {}, _deleted_at: {} };
    writeObject(localFile, local);
  }
  if (!enabled) {
    const overrides = Object.fromEntries(Object.keys(local.connections || {})
      .filter((id) => isDeviceLocalConnector(id) && cloudEnabled?.connectors?.[id] === false)
      .map((id) => [id, false]));
    writeObject(enabledFile, { version: 1, agents: {}, skills: {}, connectors: overrides, _item_updated_at: {} });
  }
  for (const [file, relPath, value] of [
    [cloudFile, 'cloud/config/connectors.json', cloud],
    [cloudEnabledFile, 'cloud/config/component-enabled.json', cloudEnabled],
  ] as const) {
    if (!value) continue;
    const filtered = cloudConnectorConfig(relPath, value);
    if (filtered !== value) writeObject(file, filtered);
  }
  preparedFiles.set(localFile, fingerprint(files));
}
