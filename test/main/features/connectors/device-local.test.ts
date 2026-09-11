import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const uid = 'same-account';
const cliIds = ['feishu', 'lark', 'wecom', 'dingtalk', 'xero'];

function row(id: string) {
  return {
    id, display_name: id,
    transport: { kind: 'stdio' as const, command: 'node', args: ['adapter.cjs'] },
    enabled_subtools: ['execute_read'], tools_cache: [], tools_cached_at: 0,
    status: { kind: 'connected' as const, since: 100 },
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function device(name: string) {
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, name);
  vi.resetModules();
  return {
    registry: await import('../../../../src/main/features/connectors/registry'),
    enabled: await import('../../../../src/main/features/component_enabled'),
    paths: await import('../../../../src/main/paths'),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-connectors-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('device-local CLI connector lifecycle', () => {
  it('covers every catalog local_cli connector while keeping other transports account-scoped', async () => {
    await device('catalog');
    const { connectorCatalog } = await import('../../../../src/main/features/connectors/catalog');
    const { isDeviceLocalConnector } = await import('../../../../src/main/features/connectors/device-local');
    for (const entry of connectorCatalog()) {
      expect(isDeviceLocalConnector(entry.id)).toBe(entry.auth_mode === 'local_cli');
    }
    expect(isDeviceLocalConnector('custom-local-command')).toBe(false);
    expect(isDeviceLocalConnector('unknown-connector')).toBe(false);
  });
  it.each(cliIds)('%s connect, tool selection, error and disconnect never change cloud data', async (id) => {
    const { registry, paths } = await device('a');
    await registry.upsert(uid, row('github'));
    const cloud = paths.userConnectorsConfigFile(uid);
    const before = fs.readFileSync(cloud, 'utf8');
    await registry.upsert(uid, row(id));
    await registry.update(uid, id, (current) => ({
      ...current, enabled_subtools: [], status: { kind: 'error', message: 'offline', at: 200 },
    }));
    expect(registry.load(uid).connections[id]).toMatchObject({ enabled_subtools: [], status: { kind: 'error' } });
    expect(fs.readFileSync(cloud, 'utf8')).toBe(before);
    expect(await registry.remove(uid, id)).toBe(true);
    expect(registry.load(uid).connections[id]).toBeUndefined();
    expect(fs.readFileSync(cloud, 'utf8')).toBe(before);
  });

  it('keeps per-device toggles and connections independent for the same account', async () => {
    const a = await device('a');
    await a.registry.upsert(uid, row('feishu'));
    a.enabled.setConnectorEnabled(uid, 'feishu', false);
    a.enabled.setConnectorEnabled(uid, 'github', false);
    const cloudToggle = fs.readFileSync(a.paths.userComponentEnabledFile(uid), 'utf8');
    expect(cloudToggle).not.toContain('feishu');

    const b = await device('b');
    writeJson(b.paths.userComponentEnabledFile(uid), JSON.parse(cloudToggle));
    expect(b.registry.load(uid).connections.feishu).toBeUndefined();
    expect(b.enabled.isConnectorEnabled(uid, 'github')).toBe(false);
    expect(b.enabled.isConnectorEnabled(uid, 'feishu')).toBe(true);
    await b.registry.upsert(uid, row('feishu'));
    await b.registry.remove(uid, 'feishu');

    const reopenedA = await device('a');
    expect(reopenedA.registry.load(uid).connections.feishu.status.kind).toBe('connected');
    expect(reopenedA.enabled.isConnectorEnabled(uid, 'feishu')).toBe(false);
  });

  it('adopts only this device’s prior CLI installation and rechecks imported status', async () => {
    const { registry, enabled, paths } = await device('legacy');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const pin = findCatalogEntry('feishu')!.local_cli!;
    const runtime = path.join(paths.userLocalConfigDir(uid), 'connector-cli', 'feishu');
    writeJson(path.join(runtime, '.orkas-cli-integrity.json'), {
      package: `${pin.package_name}@${pin.package_version}`, integrity: pin.package_integrity,
    });
    writeJson(paths.userConnectorsConfigFile(uid), {
      version: 2, connections: { feishu: row('feishu'), wecom: row('wecom'), github: row('github') },
      _deleted_at: { xero: '2026-09-02T00:00:00.000Z' }, oauth_hints: { lark: { reauthorize: true } },
    });
    writeJson(paths.userComponentEnabledFile(uid), {
      version: 1, agents: {}, skills: {}, connectors: { feishu: false, wecom: false },
      _item_updated_at: { connectors: { feishu: 10, wecom: 20 } },
    });
    expect(registry.load(uid).connections).toMatchObject({
      feishu: { status: { kind: 'connecting' }, enabled_subtools: ['execute_read'] }, github: { id: 'github' },
    });
    expect(registry.load(uid).connections.wecom).toBeUndefined();
    expect(enabled.isConnectorEnabled(uid, 'feishu')).toBe(false);
    expect(enabled.isConnectorEnabled(uid, 'wecom')).toBe(true);
    for (const file of [paths.userConnectorsConfigFile(uid), paths.userComponentEnabledFile(uid)]) {
      const cloud = fs.readFileSync(file, 'utf8');
      for (const id of cliIds) expect(cloud).not.toContain(id);
    }
    expect(fs.existsSync(path.join(runtime, '.orkas-cli-integrity.json'))).toBe(true);
    await registry.remove(uid, 'feishu');
    writeJson(paths.userConnectorsConfigFile(uid), { version: 2, connections: { feishu: row('feishu') } });
    expect(registry.load(uid).connections.feishu).toBeUndefined();
  });

  it('recovers an installed CLI even when another upgraded device already removed its cloud row', async () => {
    const { registry, paths } = await device('late-upgrade');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const pin = findCatalogEntry('xero')!.local_cli!;
    writeJson(path.join(paths.userLocalConfigDir(uid), 'connector-cli', 'xero', '.orkas-cli-integrity.json'), {
      package: `${pin.package_name}@${pin.package_version}`, integrity: pin.package_integrity,
    });
    expect(registry.load(uid).connections.xero).toMatchObject({ id: 'xero', status: { kind: 'connecting' } });
  });

  it.each([1, 2])('keeps migration sources intact when local write %s fails and safely retries', async (failedWrite) => {
    const { registry, paths } = await device('interrupted');
    const storage = await import('../../../../src/main/storage');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const pin = findCatalogEntry('feishu')!.local_cli!;
    writeJson(path.join(paths.userLocalConfigDir(uid), 'connector-cli', 'feishu', '.orkas-cli-integrity.json'), {
      package: `${pin.package_name}@${pin.package_version}`, integrity: pin.package_integrity,
    });
    const cloudFile = paths.userConnectorsConfigFile(uid);
    const initial = { version: 2, connections: { feishu: row('feishu'), github: row('github') } };
    writeJson(cloudFile, initial);
    const cloudEnabledFile = paths.userComponentEnabledFile(uid);
    const initialEnabled = { version: 1, connectors: { feishu: false } };
    writeJson(cloudEnabledFile, initialEnabled);
    const realWrite = storage.writeTextAtomicSync;
    let writes = 0;
    const write = vi.spyOn(storage, 'writeTextAtomicSync').mockImplementation((...args) => {
      if (++writes === failedWrite) throw new Error('simulated local disk failure');
      return realWrite(...args);
    });
    expect(() => registry.load(uid)).toThrow('simulated local disk failure');
    expect(JSON.parse(fs.readFileSync(cloudFile, 'utf8'))).toEqual(initial);
    expect(JSON.parse(fs.readFileSync(cloudEnabledFile, 'utf8'))).toEqual(initialEnabled);
    expect(fs.existsSync(paths.userDeviceConnectorsConfigFile(uid))).toBe(failedWrite === 2);
    write.mockRestore();
    expect(registry.load(uid).connections.github).toBeTruthy();
    expect(registry.load(uid).connections.feishu).toMatchObject({ status: { kind: 'connecting' }, enabled_subtools: ['execute_read'] });
    expect(JSON.parse(fs.readFileSync(paths.userDeviceConnectorEnabledFile(uid), 'utf8')).connectors.feishu).toBe(false);
    expect(JSON.parse(fs.readFileSync(cloudFile, 'utf8')).connections.feishu).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(cloudEnabledFile, 'utf8')).connectors.feishu).toBeUndefined();
  });

  it('does not replace unreadable device data with an incoming cloud record', async () => {
    const { registry, paths } = await device('corrupt-local');
    const file = paths.userDeviceConnectorsConfigFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    writeJson(paths.userConnectorsConfigFile(uid), { version: 2, connections: { feishu: row('feishu') } });
    expect(() => registry.load(uid)).toThrow('connector storage could not be read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(JSON.parse(fs.readFileSync(paths.userConnectorsConfigFile(uid), 'utf8')).connections.feishu).toBeTruthy();
  });
});
