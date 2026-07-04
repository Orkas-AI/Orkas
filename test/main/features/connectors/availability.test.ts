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

describe('connector availability gates', () => {
  const releasedGoogleIds = ['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks', 'gsearch-console'];

  it('keeps released Google connectors visible by default', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(outIds).toContain('github');
    expect(availability.connectorAvailabilityForId('gmail')).toBe('enabled');
    expect(availability.connectorAvailabilityForId('github')).toBe('enabled');
  });

  it('ignores the deprecated google_connectors remote switch for released Google entries', async () => {
    await writeRemoteConfig({ google: 'disabled', gmail: 'visible_disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability(catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(out.find((entry) => entry.id === 'gmail')).not.toHaveProperty('availability');
    expect(availability.connectorAvailabilityForId('gmail')).toBe('enabled');
    expect(() => availability.assertConnectorRuntimeEnabled('gmail')).not.toThrow();
  });

  it('keeps model-visible connector tools independent of the deprecated Google switch', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      restoreComposioConnectionsFromServer: vi.fn(async () => 0),
      refreshStaleToolCaches: vi.fn(async () => 0),
      listInstances: vi.fn(() => [
        connectedInstance('gmail'),
        connectedInstance('gdrive'),
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
    expect(visible.map((item) => item.instance.id).sort()).toEqual(['gdrive', 'gmail', 'notion']);
  });
});
