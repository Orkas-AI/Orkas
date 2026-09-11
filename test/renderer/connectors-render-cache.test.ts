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
  it('renders the credit tag only from explicit display metadata', () => {
    const { context } = loadConnectorsRenderer();

    const explicit = context._connectorCardBadges({ requires_credits: true });
    const disabled = context._connectorCardBadges({
      requires_credits: false,
      usage_metering: {
        provider: 'composio',
        credits_milli_per_call: 250,
      },
    });
    const usageOnly = context._connectorCardBadges({
      usage_metering: {
        provider: 'composio',
        credits_milli_per_call: 250,
      },
    });

    expect(explicit).toContain('<div class="connector-card-badges">');
    expect(explicit).toContain('connector-card-credit-badge is-credit');
    // Metered-but-free entries render no badge wrapper at all, like plain entries.
    expect(disabled).toBe('');
    expect(usageOnly).toBe('');
  });

  it('uses one compact setup label while keeping specific requirements in the tooltip', () => {
    const { context } = loadConnectorsRenderer();

    const ordinary = context._connectorCardBadges({ id: 'ordinary' });
    const providerSetup = context._connectorCardBadges({
      id: 'taobao-tmall-seller',
      connection_setup: { requirement: 'provider_application' },
    });
    const businessQualification = context._connectorCardBadges({
      id: 'douyin-shop-seller',
      requires_credits: true,
      connection_setup: { requirement: 'business_qualification' },
    });

    expect(ordinary).toBe('');
    expect(providerSetup).toContain('provider_application');
    expect(providerSetup).toContain('title="connectors.badge.provider_setup"');
    expect(providerSetup).toContain('>connectors.badge.setup_required</span>');
    expect(businessQualification).toContain('business_qualification');
    expect(businessQualification).toContain('title="connectors.badge.business_qualification"');
    expect(businessQualification).toContain('>connectors.badge.setup_required</span>');
    expect(businessQualification).toContain('connectors.badge.credits_required');
    expect(context._connectorUnconnectedActionLabel({ id: 'ordinary' }))
      .toBe('connectors.action.connect');
    expect(context._connectorUnconnectedActionLabel({
      connection_setup: { requirement: 'provider_application' },
    })).toBe('connectors.action.review_requirements');
  });

  it('keeps the setup badge concise in every renderer locale', () => {
    const { context } = loadConnectorsRenderer();
    for (const [lang, label] of [['zh', '需配置'], ['en', 'Setup required'], ['ja', '要設定'], ['pt', 'Requer configuração']]) {
      const locale = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8'));
      context.t = (key: string) => locale[key] || key;
      for (const requirement of ['provider_application', 'business_qualification']) {
        const html = context._connectorCardBadges({ connection_setup: { requirement } });
        expect(html, `${lang}: ${requirement}`).toContain(`>${label}</span>`);
      }
    }
  });

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

    const raw = storage.get('orkas.connectors.renderCache.v4.u-cache');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(4);
    expect(parsed.instances).toEqual([{ id: 'notion', status: { kind: 'connected', since: 1 } }]);
  });

  it('drops errored connector instances while hydrating cached state', () => {
    const { context, storage } = loadConnectorsRenderer();
    storage.set('orkas.connectors.renderCache.v4.u-cache', JSON.stringify({
      version: 4,
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
      instances: [{ id: 'dingtalk', display_name: '钉钉', status: { kind: 'connected', since: 1 } }],
    }));
    storage.set('orkas.connectors.renderCache.v3.u-cache', JSON.stringify({
      version: 3,
      updated_at: Date.now(),
      instances: [{ id: 'feishu', status: { kind: 'connected', since: 1 } }],
    }));
    expect(vm.runInContext('_hydrateConnectorsRenderCache()', context)).toBe(false);
    storage.set('orkas.connectors.renderCache.v4.u-cache', JSON.stringify({
      version: 4,
      updated_at: Date.now(),
      instances: [{ id: 'notion', status: { kind: 'connected', since: 1 } }],
    }));
    storage.set('some.other.key', 'keep');

    vm.runInContext('_purgeLegacyConnectorsRenderCaches();', context);

    expect(storage.has('orkas.connectors.renderCache.v1.u-cache')).toBe(false);
    expect(storage.has('orkas.connectors.renderCache.v2.u-cache')).toBe(false);
    expect(storage.has('orkas.connectors.renderCache.v3.u-cache')).toBe(false);
    expect(storage.has('orkas.connectors.renderCache.v4.u-cache')).toBe(true);
    expect(storage.has('some.other.key')).toBe(true);
  });
});
