import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UID = 'u-google-connector-switches';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-google-connectors-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  vi.doUnmock('../../../../src/main/features/connectors/manager');
  vi.doUnmock('../../../../src/main/features/component_enabled');
  vi.doUnmock('../../../../src/main/features/agents');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRemoteConfig(value: unknown): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  const paths = await import('../../../../src/main/paths');
  const storage = await import('../../../../src/main/storage');
  users.activateUser(TEST_UID);
  storage.writeJsonSync(paths.userRemoteConfigFile(TEST_UID), {
    version: 1,
    active: {
      immediate: { google_connectors: value },
      restart: {},
    },
  });
}

function ids(entries: Array<{ id: string }>): string[] {
  return entries.map((entry) => entry.id).sort();
}

function connectedInstance(id: string) {
  return {
    id,
    display_name: id,
    status: { kind: 'connected' as const, since: 1 },
    enabled_subtools: null,
    tools_cache: [{ name: `${id}_tool`, description: '', input_schema: {} }],
  };
}

describe('Google connector remote switches', () => {
  it('defaults both Google switches to enabled', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);

    expect(ids(out)).toEqual(expect.arrayContaining(['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks']));
    expect(availability.connectorAvailabilityForId('gmail')).toBe('enabled');
    expect(availability.connectorAvailabilityForId('github')).toBe('enabled');
  });

  it('hides every Google connector when the overall switch is disabled', async () => {
    await writeRemoteConfig({ google: 'disabled', gmail: 'enabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);

    expect(ids(out)).not.toEqual(expect.arrayContaining(['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks']));
    expect(ids(out)).toContain('github');
    expect(() => availability.assertConnectorRuntimeEnabled('gmail')).toThrow(/connector_unsupported/);
  });

  it('hides every Google connector when the overall switch is visible_disabled', async () => {
    await writeRemoteConfig({ google: 'visible_disabled', gmail: 'enabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);

    expect(ids(out)).not.toEqual(expect.arrayContaining(['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks']));
    expect(availability.connectorAvailabilityForId('gmail')).toBe('hidden');
  });

  it('lets the Gmail switch hide Gmail and Google Workspace while other Google services remain enabled', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);

    expect(ids(out)).not.toContain('gmail');
    expect(ids(out)).not.toContain('google-workspace');
    expect(ids(out)).toEqual(expect.arrayContaining(['gcal', 'gdocs', 'gsheets', 'gtasks']));
  });

  it('lets the Gmail switch show Gmail and Google Workspace as disabled cards', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'visible_disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);

    expect(out.find((entry) => entry.id === 'gmail')).toMatchObject({ availability: 'visible_disabled' });
    expect(out.find((entry) => entry.id === 'google-workspace')).toMatchObject({ availability: 'visible_disabled' });
    expect(out.find((entry) => entry.id === 'gcal')).not.toHaveProperty('availability');
  });

  it('filters disabled Google connectors from model-visible connector tools', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      listInstances: vi.fn(() => [
        connectedInstance('google-workspace'),
        connectedInstance('gmail'),
        connectedInstance('gcal'),
        connectedInstance('notion'),
      ]),
    }));
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
    }));
    vi.doMock('../../../../src/main/features/agents', () => ({
      getAgent: vi.fn(),
    }));

    const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');

    const visible = await toolsAdapter.resolveVisibleConnectors(TEST_UID, undefined);
    expect(visible.map((item) => item.instance.id).sort()).toEqual(['gcal', 'notion']);
  });
});
