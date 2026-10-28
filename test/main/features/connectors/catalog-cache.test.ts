import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateUser } from '../../../../src/main/features/users';
import { userRemoteConfigFile } from '../../../../src/main/paths';
import { ClientConfigManager } from '../../../../src/main/features/client_config';
import { writeJsonSync } from '../../../../src/main/storage';
import * as storage from '../../../../src/main/storage';
import * as registry from '../../../../src/main/features/connectors/registry';
import * as enabled from '../../../../src/main/features/component_enabled';
import { connectorCatalog, findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { resolveVisibleConnectors } from '../../../../src/main/features/connectors/tools-adapter';
import type { ConnectorsFile } from '../../../../src/main/features/connectors/types';

const accounts = ['catalog-cache-a', 'catalog-cache-b'];
const entry = (id: string, name = id) => ({
  id, display_name: name, category: 'productivity', auth_mode: 'composio',
  composio: { toolkit: id, auth_config_id: 'ac_cache_fixture' },
  transport_template: null,
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const uid of accounts) fs.rmSync(path.dirname(userRemoteConfigFile(uid)), { recursive: true, force: true });
});

describe('connector catalog cache', () => {
  it('keeps repeated visibility checks within one full config read while honoring live disconnects and user restrictions', async () => {
    const uid = accounts[0];
    activateUser(uid);
    // Match the multi-megabyte catalog behind the reported send/switch stall, without user data.
    const catalog = Array.from({ length: 133 }, (_, index) => ({
      ...entry(`cache-service-${index}`), icon_svg: `<svg>${'x'.repeat(28_000)}</svg>`,
    }));
    const file = userRemoteConfigFile(uid);
    writeJsonSync(file, { active: { immediate: { 'connectors.catalog': catalog } } });
    const state: ConnectorsFile = {
      version: 2, oauth_hints: {}, _deleted_at: {},
      connections: Object.fromEntries(catalog.slice(0, 10).map(item => [item.id, {
        id: item.id, origin: 'catalog', display_name: item.display_name,
        transport: null, status: { kind: 'connected' }, enabled_subtools: null,
        composio_grant: { connection_id: item.id, connection_token: 'a'.repeat(43), toolkit: item.id },
        tools_cache: [{ name: 'read_items', description: 'Read items', inputSchema: { type: 'object' } }],
        created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
      }])),
    };
    vi.spyOn(registry, 'load').mockImplementation(() => structuredClone(state));
    const restrictions = { version: 1, agents: {}, skills: {}, connectors: {} as Record<string, boolean> };
    vi.spyOn(enabled, 'readEnabledMap').mockImplementation(() => restrictions);
    let configReads = 0;
    const originalRead = storage.readJsonSync;
    const reads = vi.spyOn(storage, 'readJsonSync').mockImplementation((target) => {
      // Retain counts, not hundreds of large return values if the IO regression comes back.
      reads.mockClear();
      if (target === file) configReads++;
      return originalRead(target);
    });
    for (let run = 0; run < 3; run++) {
      const visible = await resolveVisibleConnectors(uid);
      expect(visible).toHaveLength(10);
      expect(visible.every(item => item.tools[0]?.name === 'read_items')).toBe(true);
    }
    // Full-file IO is the synchronous blocking cost; this budget is independent of getter calls.
    expect(configReads).toBeLessThanOrEqual(1);
    state.connections['cache-service-0'].status = { kind: 'disconnected' };
    restrictions.connectors['cache-service-1'] = false;
    state.connections['cache-service-2'].enabled_subtools = [];
    const next = await resolveVisibleConnectors(uid);
    expect(next.map(item => item.instance.id)).not.toContain('cache-service-0');
    expect(next.map(item => item.instance.id)).not.toContain('cache-service-1');
    expect(next.find(item => item.instance.id === 'cache-service-2')?.tools).toEqual([]);
    state.connections = {};
    expect(await resolveVisibleConnectors(uid)).toEqual([]);
  });

  it('refreshes catalog metadata across same-hash updates and account switches without retaining caller mutations', () => {
    const manager = new ClientConfigManager();
    const apply = (name: string) => manager.applyServerPayload({
      config_hash: 'unchanged-hash', immediate: { 'connectors.catalog': [entry('cache-service', name)] }, restart: {},
    }, 'unchanged-etag');
    activateUser(accounts[0]);
    apply('Account A');
    const result = findCatalogEntry('cache-service')!;
    result.display_name = 'Mutated';
    result.composio!.toolkit = 'wrong-toolkit';
    connectorCatalog().find(item => item.id === 'cache-service')!.display_name = 'Also mutated';
    expect(findCatalogEntry('cache-service')).toMatchObject({ display_name: 'Account A', composio: { toolkit: 'cache-service' } });
    apply('Updated A');
    expect(findCatalogEntry('cache-service')?.display_name).toBe('Updated A');
    activateUser(accounts[1]);
    expect(findCatalogEntry('cache-service')).toBeNull();
    apply('Account B');
    expect(findCatalogEntry('cache-service')?.display_name).toBe('Account B');
    activateUser(accounts[0]);
    expect(findCatalogEntry('cache-service')?.display_name).toBe('Updated A');
  });
});
