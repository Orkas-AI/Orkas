import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadConnectorsRenderer() {
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/connectors.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const context: any = {
    console,
    currentUserId: 'u-cache',
    currentView: 'connectors',
    globalThis: { currentUserId: 'u-cache' },
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      key: (index: number) => Array.from(storage.keys())[index] || null,
      get length() { return storage.size; },
    },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1200,
      innerHeight: 800,
      orkas: {
        invoke: async () => ({ ok: true, catalog: [], instances: [] }),
        onPushEvent: () => {},
      },
    },
    t: (key: string) => key,
    getLang: () => 'zh',
    pickDesc: (entry: any) => entry?.description_zh || entry?.description_en || '',
    formatChatUseLabel: ({ name }: { name: string }) => name,
    sanitizeSvgIconHtml: () => '',
    escapeHtml: (value: unknown) => String(value ?? ''),
  };
  context.window.window = context.window;
  context.window.globalThis = context.globalThis;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'connectors.js' });
  return { context, storage };
}

describe('connectors renderer cache', () => {
  it('does not persist errored connector instances', () => {
    const { context, storage } = loadConnectorsRenderer();

    vm.runInContext(`
      _connectorsState.catalog = [{ id: 'github', display_name: 'GitHub' }];
      _connectorsState.instances = [
        { id: 'github', status: { kind: 'error', message: 'Authorization expired' } },
        { id: 'notion', status: { kind: 'connected', since: 1 } },
      ];
      _persistConnectorsRenderCache();
    `, context);

    const raw = storage.get('orkas.connectors.renderCache.v2.u-cache');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(2);
    expect(parsed.instances).toEqual([{ id: 'notion', status: { kind: 'connected', since: 1 } }]);
  });

  it('drops errored connector instances while hydrating cached state', () => {
    const { context, storage } = loadConnectorsRenderer();
    storage.set('orkas.connectors.renderCache.v2.u-cache', JSON.stringify({
      version: 2,
      updated_at: Date.now(),
      catalog: [{ id: 'github', display_name: 'GitHub' }],
      instances: [
        { id: 'github', status: { kind: 'error', message: 'Authorization expired' } },
        { id: 'notion', status: { kind: 'connected', since: 1 } },
      ],
    }));

    const hydrated = vm.runInContext(`
      _connectorsState.catalog = [];
      _connectorsState.instances = [];
      _hydrateConnectorsRenderCache();
      JSON.stringify(_connectorsState.instances);
    `, context);

    expect(JSON.parse(hydrated)).toEqual([{ id: 'notion', status: { kind: 'connected', since: 1 } }]);
  });

  it('purges stale connector render cache versions', () => {
    const { context, storage } = loadConnectorsRenderer();
    storage.set('orkas.connectors.renderCache.v1.u-cache', JSON.stringify({
      version: 1,
      updated_at: Date.now(),
      instances: [{ id: 'github', status: { kind: 'error', message: 'Authorization expired' } }],
    }));
    storage.set('orkas.connectors.renderCache.v2.u-cache', JSON.stringify({
      version: 2,
      updated_at: Date.now(),
      instances: [{ id: 'notion', status: { kind: 'connected', since: 1 } }],
    }));
    storage.set('some.other.key', 'keep');

    vm.runInContext('_purgeLegacyConnectorsRenderCaches();', context);

    expect(storage.has('orkas.connectors.renderCache.v1.u-cache')).toBe(false);
    expect(storage.has('orkas.connectors.renderCache.v2.u-cache')).toBe(true);
    expect(storage.has('some.other.key')).toBe(true);
  });
});
