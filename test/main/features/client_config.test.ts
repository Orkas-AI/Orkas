import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => diagnosticLog }));

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '9.8.7'),
    on: vi.fn(),
    off: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  powerMonitor: electronMock.powerMonitor,
}));

import {
  ClientConfigManager,
  clientConfig,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_QUICK_START_CONFIG,
  getMinimumAppVersion,
  getQuickStartConfig,
  getQuickStartConfigState,
  getRetryErrorPolicyConfig,
  getServerConnectorCatalogConfig,
  clientConfigPlatform,
  refresh,
  start,
  stop,
} from '../../../src/main/features/client_config';

import { DEFAULT_RETRY_ERROR_POLICY } from '../../../src/core-agent/src/shared/errors';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

async function waitForCondition(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('client_config', () => {
  beforeEach(() => {
    diagnosticLog.warn.mockClear();
    electronMock.app.isPackaged = false;
    electronMock.app.getVersion.mockReturnValue('9.8.7');
    (electronMock.app as any).getAppPath = undefined;
    electronMock.app.on.mockClear();
    electronMock.app.off.mockClear();
    electronMock.powerMonitor.on.mockClear();
    electronMock.powerMonitor.off.mockClear();
    delete process.env.ORKAS_API_BASE_URL;
    delete process.env.ORKAS_PROFILE;
    delete process.env.ORKAS_CLIENT_CHANNEL;
    delete process.env.ORKAS_CHANNEL;
  });

  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ORKAS_API_BASE_URL;
    delete process.env.ORKAS_PROFILE;
    delete process.env.ORKAS_CLIENT_CHANNEL;
    delete process.env.ORKAS_CHANNEL;
  });

  it('keeps private configuration rejection details out of logs while preserving failure and later refresh', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfiglogprivacy';
    users.activateUser(uid);
    const privateMessage = 'model_catalog sensitive-provider-config private-configuration';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1, msg: privateMessage })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, immediate: {}, restart: {} }))));
    try {
      expect(await refresh('manual', { force: true })).toMatchObject({ updated: false, error: privateMessage });
      expect(diagnosticLog.warn).toHaveBeenCalledWith('client config refresh failed', expect.objectContaining({
        diagnostic_id: 'D301', reason: 'manual', error: expect.objectContaining({
          error_type: 'Error', message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: privateMessage.length,
        }),
      }));
      expect(JSON.stringify(diagnosticLog.warn.mock.calls)).not.toMatch(/model_catalog|sensitive-provider-config|private-configuration/i);
      expect(await refresh('manual', { force: true })).not.toHaveProperty('error');
    } finally {
      fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true });
    }
  });

  it.each([
    { type: 'SyntaxError', code: 'ENOENT' },
    { type: 'TypeError', code: 'EACCES' },
  ])('preserves $type/$code classification without configuration content', async ({ type, code }) => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigdiagnostic';
    users.activateUser(uid);
    const rejectedBody = new Response('{}');
    vi.spyOn(rejectedBody, 'json').mockRejectedValueOnce(Object.assign(new Error('model_catalog private-configuration'), { name: type, code, status: 503 }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(rejectedBody)
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, immediate: {}, restart: {} }))));
    try {
      expect(await refresh('manual', { force: true })).toMatchObject({ updated: false });
      expect(diagnosticLog.warn).toHaveBeenCalledWith('client config refresh failed', expect.objectContaining({
        diagnostic_id: 'D301', reason: 'manual', error: expect.objectContaining({ error_type: type, error_code: code, status: 503 }),
      }));
      expect(JSON.stringify(diagnosticLog.warn.mock.calls)).not.toMatch(/model_catalog|private-configuration/);
      expect(await refresh('manual', { force: true })).not.toHaveProperty('error');
    } finally { fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true }); }
  });

  it('isolates cached Server values from callers, payload owners, and mutating merge functions', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    users.activateUser('clientconfigisolation');
    const file = paths.userRemoteConfigFile('clientconfigisolation');
    const manager = new ClientConfigManager();
    const value = { nested: { enabled: false } };
    try {
      manager.applyServerPayload({ immediate: { feature: value }, restart: {} }, 'same');
      value.nested.enabled = true;
      (manager.get('feature') as typeof value).nested.enabled = true;
      (manager.getServerValue('feature') as typeof value).nested.enabled = true;
      (manager.readCache().active.immediate.feature as typeof value).nested.enabled = true;
      expect(manager.get('feature')).toEqual({ nested: { enabled: false } });
      manager.registerDefault('feature', value, { merge: (_, raw) => {
        (raw as typeof value).nested.enabled = true;
        return raw as typeof value;
      } });
      expect(manager.get('feature')).toEqual({ nested: { enabled: true } });
      expect(manager.getServerValue('feature')).toEqual({ nested: { enabled: false } });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('observes file replacement, deletion, and recovery after warming the config cache', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    users.activateUser('clientconfigreplacement');
    const file = paths.userRemoteConfigFile('clientconfigreplacement');
    const manager = new ClientConfigManager();
    const body = (value: string) => JSON.stringify({ active: { immediate: { feature: value } } });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body('first'));
      expect(manager.get('feature')).toBe('first');
      const before = fs.statSync(file);
      fs.writeFileSync(`${file}.replacement`, body('other'));
      fs.utimesSync(`${file}.replacement`, before.atime, before.mtime);
      fs.renameSync(`${file}.replacement`, file);
      expect(manager.get('feature')).toBe('other');
      fs.rmSync(file);
      expect(manager.hasServerValue('feature')).toBe(false);
      expect(manager.get('feature', 'default')).toBe('default');
      fs.writeFileSync(file, '{broken');
      expect(manager.get('feature', 'default')).toBe('default');
      fs.writeFileSync(file, body('fixed'));
      expect(manager.get('feature')).toBe('fixed');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('retries a transient config read failure without requiring the file to change', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    users.activateUser('clientconfigreadretry');
    const file = paths.userRemoteConfigFile('clientconfigreadretry');
    const manager = new ClientConfigManager();
    try {
      storage.writeJsonSync(file, { active: { immediate: { feature: 'available' } } });
      vi.spyOn(storage, 'readJsonSync').mockReturnValueOnce({});
      expect(manager.get('feature', 'default')).toBe('default');
      expect(manager.get('feature', 'default')).toBe('available');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('ships nine grouped Commander quick-start defaults including PptMaker', () => {
    expect(DEFAULT_QUICK_START_CONFIG).toHaveLength(9);
    expect(DEFAULT_QUICK_START_CONFIG.map((item) => item.id)).toEqual([
      'data', 'ecommerce', 'ppt', 'office', 'image', 'video', 'ui_design', 'rnd', 'seo_geo',
    ]);
    expect(DEFAULT_QUICK_START_CONFIG.find((item) => item.id === 'ppt')).toEqual({
      id: 'ppt',
      agent_id: '7e91cb9ec9e9',
    });
    expect(DEFAULT_QUICK_START_CONFIG.find((item) => item.id === 'ecommerce')).toEqual({
      id: 'ecommerce',
      agent_id: '5a1d43c2f28a',
    });
    expect(DEFAULT_QUICK_START_CONFIG.find((item) => item.id === 'rnd')).toEqual({
      id: 'rnd',
      agent_id: 'a316881746f9',
    });

    const builtinRoot = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents');
    const builtinIds = new Set(fs.readdirSync(builtinRoot).filter((id) => (
      fs.existsSync(path.join(builtinRoot, id, 'agent.json'))
    )));
    for (const item of DEFAULT_QUICK_START_CONFIG) {
      expect(
        builtinIds.has(item.agent_id),
        `${item.id}:${item.agent_id} must be bundled`,
      ).toBe(true);
    }
  });

  it('uses a valid Server quick-start order and falls back on an invalid payload', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigquickstart';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    const manager = new ClientConfigManager();

    try {
      manager.applyServerPayload({
        immediate: {
          'commander.quick_start': [
            { id: 'creation', agent_id: '173d4235a431' },
            { id: 'image', agent_id: '814b61b027f0' },
          ],
        },
        restart: {},
        config_hash: 'sha256:quick-start-valid',
      }, '"sha256:quick-start-valid"');
      expect(getQuickStartConfig()).toEqual([
        { id: 'creation', agent_id: '173d4235a431' },
        { id: 'image', agent_id: '814b61b027f0' },
      ]);
      expect(getQuickStartConfigState().source).toBe('server_config');

      manager.applyServerPayload({
        immediate: {
          'commander.quick_start': [
            { id: 'creation', agent_id: '' },
          ],
        },
        restart: {},
        config_hash: 'sha256:quick-start-invalid',
      }, '"sha256:quick-start-invalid"');
      expect(getQuickStartConfig()).toEqual(DEFAULT_QUICK_START_CONFIG);
      expect(getQuickStartConfigState().source).toBe('pc_default');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  // Remote-only connector cards must retain translated copy through both catalog
  // protocols. Old or malformed optional translations must keep English fallback usable.
  it.each([
    ['legacy-dcr', 'connectors.dcr_catalog', 'mcp_dcr'],
    ['unified-dcr', 'connectors.catalog', 'mcp_dcr'],
    ['unified-composio', 'connectors.catalog', 'composio'],
  ])('preserves ten-language connector descriptions and legacy fallback for %s', async (scenario, key, authMode) => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = `clientconfiglanguages-${scenario}`;
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    const manager = new ClientConfigManager();
    const base = {
      display_name: 'Remote connector',
      category: 'productivity',
      auth_mode: authMode,
      description_en: 'English fallback',
      description_zh: '中文说明',
      description_ja: '日本語の説明',
      description_pt: 'Descrição em português',
      ...(authMode === 'mcp_dcr'
        ? { transport_template: { kind: 'streamable-http', url: 'https://example.com/mcp' } }
        : { composio: { toolkit: 'remote', auth_config_id: 'ac_remote123' } }),
    };
    try {
      manager.applyServerPayload({
        immediate: {
          [key]: [
            {
              ...base, id: 'translated',
              description_es: '  Descripción en español  ',
              description_fr: '  Description française  ',
              description_ko: '  한국어 설명  ',
              description_de: '  Deutsche Beschreibung  ',
              description_ru: '  Описание на русском  ',
              description_it: '  Descrizione italiana  ',
            },
            { ...base, id: 'legacy' },
            {
              ...base, id: 'malformed',
              description_es: null, description_fr: 123, description_ko: {},
              description_de: [], description_ru: false, description_it: '  ',
            },
          ],
        },
        restart: {},
      }, `"connector-languages-${scenario}"`);
      const entries = getServerConnectorCatalogConfig();
      expect(entries.map((entry) => entry.id)).toEqual(['translated', 'legacy', 'malformed']);
      expect(entries[0]).toMatchObject({
        description_en: 'English fallback', description_zh: '中文说明',
        description_ja: '日本語の説明', description_pt: 'Descrição em português',
        description_es: 'Descripción en español', description_fr: 'Description française',
        description_ko: '한국어 설명', description_de: 'Deutsche Beschreibung',
        description_ru: 'Описание на русском', description_it: 'Descrizione italiana',
      });
      for (const entry of entries.slice(1)) {
        expect(entry).toMatchObject({
          description_en: 'English fallback', description_zh: '中文说明',
          description_ja: '日本語の説明', description_pt: 'Descrição em português',
          description_es: '', description_fr: '', description_ko: '',
          description_de: '', description_ru: '', description_it: '',
        });
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('reads the minimum app version from the canonical app update config', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigappupdate';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      manager.applyServerPayload({
        immediate: {
          app_update: {
            min_version: '1.2.0',
            minimumVersion: '9.9.9',
          },
          'app_update.min_version': '8.8.8',
        },
        restart: {},
        config_hash: 'sha256:app-update-object',
      }, '"sha256:app-update-object"');
      expect(getMinimumAppVersion()).toBe('1.2.0');

      manager.applyServerPayload({
        immediate: {
          app_update: { minimum_version: '1.4.0' },
          'app_update.min_version': '1.3.0',
        },
        restart: {},
        config_hash: 'sha256:app-update-direct',
      }, '"sha256:app-update-direct"');
      expect(getMinimumAppVersion()).toBe('');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('reads retry error policy from immediate Server config', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigretrypolicy';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      manager.applyServerPayload({
        immediate: {
          'model.retry_error_policy': {
            permanent_statuses: [400, '499', 700, 'bad', 499],
            permanent_message_patterns: ['custom_hard_stop', '', 42],
            status_blacklist: [418],
            message_blacklist: ['ignored_hard_stop'],
            transient_message_patterns: {
              connection_dropped: ['ignored because server policy is blacklist-only'],
            },
          },
        },
        restart: {},
        config_hash: 'sha256:retry-policy',
      }, '"sha256:retry-policy"');

      const policy = getRetryErrorPolicyConfig();
      expect(policy.permanent_statuses).toEqual([400, 499]);
      expect(policy.permanent_message_patterns).toEqual(['custom_hard_stop']);
      expect(policy.permanent_code_patterns).toEqual(DEFAULT_RETRY_ERROR_POLICY.permanent_code_patterns);
      expect('transient_message_patterns' in policy).toBe(false);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('returns registered local defaults before any Server config is available', () => {
    const manager = new ClientConfigManager();
    manager.registerDefault('feature.local-default', true);
    expect(manager.get('feature.local-default')).toBe(true);
  });

  it('preserves the wire-format image editing flag through normalization and cache reads', async () => {
    const { clientConfig, getConfiguredImageGenCapability, DEFAULT_IMAGE_GEN_BY_PROVIDER } = await import('../../../src/main/features/client_config');
    const users = await import('../../../src/main/features/users');
    users.activateUser('clientconfigimageparity');
    clientConfig.applyServerPayload({ immediate: { model_catalog: { image_generation: {
      google: { model: 'fixture-image', api: 'gemini', supports_edit: true },
    } } }, restart: {}, config_hash: 'fixture-image-edit' }, 'fixture-image-edit');
    expect(getConfiguredImageGenCapability('google')).toMatchObject({ model: 'fixture-image', supportsEdit: true });
    expect(DEFAULT_IMAGE_GEN_BY_PROVIDER.doubao.model).toBe('doubao-seedream-5-0-flash-260915');
    // The normalized camelCase form is read again through the same catalog path.
    expect(getConfiguredImageGenCapability('google')).toMatchObject({ supportsEdit: true });
  });

  it.each(['image-field', 'section-aliases'] as const)('keeps canonical catalog wire fields through cache and identity changes: %s', async mode => {
    const config = await import('../../../src/main/features/client_config');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = `catalog-wire-${mode}`;
    const previous = users.hasActiveUser() ? users.getActiveUserId() : undefined;
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    const canonical = {
      providers: { 'wire-compatible': [{ id: 'wire-model', name: 'Wire Model' }] },
      openai_compatible_providers: { 'wire-compatible': { label: 'Wire', baseUrl: 'https://wire.example/v1' } },
      image_generation: { 'wire-image': { model: 'wire-image-model', api: 'openai', supports_edit: true } },
    };
    try {
      config.clientConfig.applyServerPayload({ immediate: { model_catalog: canonical }, restart: {}, config_hash: 'wire' }, 'wire');
      expect(config.getConfiguredImageGenCapability('wire-image')).toEqual({ model: 'wire-image-model', api: 'openai', supportsEdit: true });
      expect(config.getConfiguredProviderModels('wire-compatible')?.models).toEqual([{ id: 'wire-model', name: 'Wire Model' }]);
      expect(config.getConfiguredOpenAICompatibleProvider('wire-compatible')).toMatchObject({ id: 'wire-compatible', baseUrl: 'https://wire.example/v1' });
      // Persistence retains the wire object; typed camelCase views are not cache data.
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(saved.active.immediate.model_catalog).toEqual(canonical);
      users.activateUser(`${uid}-other`);
      expect(config.getConfiguredImageGenCapability('wire-image')).toBeNull();
      users.activateUser(uid);
      storage.writeJsonSync(file, saved);
      expect(config.getConfiguredImageGenCapability('wire-image')).toEqual({ model: 'wire-image-model', api: 'openai', supportsEdit: true });
      if (mode === 'image-field') {
        config.clientConfig.applyServerPayload({ immediate: { model_catalog: { image_generation: {
          'field-alias': { model: 'alias-image-model', api: 'openai', supportsEdit: true },
        } } }, restart: {}, config_hash: 'field-alias' }, 'field-alias');
        expect(config.getConfiguredImageGenCapability('field-alias')).toEqual({ model: 'alias-image-model', api: 'openai', supportsEdit: false });
      } else {
        config.clientConfig.applyServerPayload({ immediate: { model_catalog: {
          curated_models: { 'catalog-alias': [{ id: 'alias-model', name: 'Alias Model' }] },
          openAICompatibleProviders: { 'compatible-alias': { label: 'Alias', baseUrl: 'https://alias.example/v1' } },
          imageGeneration: { 'image-alias': { model: 'alias-image-model', api: 'openai', supportsEdit: true } },
        } }, restart: {}, config_hash: 'section-aliases' }, 'section-aliases');
        expect(config.getConfiguredProviderModels('catalog-alias')).toBeNull();
        expect(config.getConfiguredOpenAICompatibleProvider('compatible-alias')).toBeNull();
        expect(config.getConfiguredImageGenCapability('image-alias')).toBeNull();
      }
    } finally {
      if (previous) users.activateUser(previous);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('ships the synchronized public model catalog with compatibility metadata', () => {
    expect(DEFAULT_PROVIDER_MODELS['openai-codex']).toEqual([
      { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', maxTokens: 128000, maxInputImages: 20 },
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', maxTokens: 128000, maxInputImages: 20 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', template: 'gpt-5.5', maxTokens: 64000, maxInputImages: 20 },
    ]);
  });

  it('maps desktop OS names to client config platform buckets', () => {
    expect(clientConfigPlatform('darwin')).toBe('mac');
    expect(clientConfigPlatform('win32')).toBe('windows');
    expect(clientConfigPlatform('linux')).toBe('pc');
  });


  it('lets Server immediate config override registered defaults', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'clientconfigdefaults';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          'feature.local-default': false,
        },
      },
    });

    try {
      const manager = new ClientConfigManager();
      manager.registerDefault('feature.local-default', true);
      expect(manager.get('feature.local-default')).toBe(false);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('keeps restart config pending until promoted', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigrestart';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      const result = manager.applyServerPayload({
        immediate: { 'feature.immediate': 'now' },
        restart: { 'feature.restart': 'later' },
        config_hash: 'sha256:test',
      }, '"sha256:test"');

      expect(result.updated).toBe(true);
      expect(manager.get('feature.immediate')).toBe('now');
      expect(manager.get('feature.restart')).toBeUndefined();
      expect(manager.promotePendingRestart()).toBe(true);
      expect(manager.get('feature.restart')).toBe('later');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('clears stale restart config when Server matches the active value again', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigclearrestart';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      manager.applyServerPayload({
        immediate: {},
        restart: { 'feature.restart': 'later' },
        config_hash: 'sha256:queued',
      }, '"sha256:queued"');

      const result = manager.applyServerPayload({
        immediate: {},
        restart: {},
        config_hash: 'sha256:cleared',
      }, '"sha256:cleared"');

      expect(result.updated).toBe(true);
      expect(manager.promotePendingRestart()).toBe(false);
      expect(manager.get('feature.restart')).toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('notifies listeners for immediate changes', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfiglistener';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      const calls: unknown[] = [];
      const allCalls: unknown[] = [];
      const unsubscribe = manager.subscribe('feature.live', (value) => {
        calls.push(value);
      });
      const unsubscribeAll = manager.subscribeAll((keys, values) => {
        allCalls.push({ keys, values });
      });
      manager.applyServerPayload({
        immediate: { 'feature.live': 'enabled' },
        restart: { 'feature.restart': 'later' },
        config_hash: 'sha256:listener',
      }, '"sha256:listener"');
      unsubscribe();
      unsubscribeAll();

      expect(calls).toEqual(['enabled']);
      expect(allCalls).toEqual([
        { keys: ['feature.live'], values: { 'feature.live': 'enabled' } },
      ]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('uses cache timestamps to enforce refresh intervals', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfiginterval';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);

    try {
      const manager = new ClientConfigManager();
      const now = 10_000_000;
      expect(manager.shouldRefresh(4 * 60 * 60 * 1000, now)).toBe(true);

      manager.markRefreshAttempt(now);
      expect(manager.shouldRefresh(4 * 60 * 60 * 1000, now + 1_000)).toBe(false);
      expect(manager.shouldRefresh(4 * 60 * 60 * 1000, now + 4 * 60 * 60 * 1000)).toBe(true);

      manager.markNotModified('"etag-next"', now + 5_000);
      const cache = manager.readCache();
      expect(cache.etag).toBe('"etag-next"');
      expect(cache.fetched_at_ms).toBe(now + 5_000);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('can delay and throttle startup refresh work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      immediate: {},
      restart: {},
      config_hash: 'sha256:delayed',
    }), {
      headers: { etag: '"sha256:delayed"' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      start({ startupDelayMs: 1_000, forceStartupRefresh: false });
      await waitForCondition(() => electronMock.app.on.mock.calls.length > 0);

      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waitForCondition(() => fetchMock.mock.calls.length === 1);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('refreshes remote config with client context and cached ETag', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'clientconfigrefresh';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      etag: '"old-etag"',
      active: { immediate: { 'feature.old': true }, restart: {} },
      last_request_at_ms: 1,
    });

    const now = 1_234_567;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    process.env.ORKAS_API_BASE_URL = 'https://config.example/api/';
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        code: 0,
        immediate: { 'feature.remote': 'enabled' },
        restart: { 'feature.restart': 'later' },
        config_hash: 'sha256:new',
      }), {
        status: 200,
        headers: { etag: '"new-etag"' },
      });
    });

    try {
      const result = await refresh('manual', { force: true });
      expect(result).toEqual({ updated: true });

      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe('https://orkas.ai/api/config/client');
      expect(url.searchParams.get('region')).toBe('global');
      expect(url.searchParams.has('platform')).toBe(false);
      expect(url.searchParams.has('version')).toBe(false);
      expect(url.searchParams.has('channel')).toBe(false);
      expect(url.searchParams.has('os')).toBe(false);
      expect(url.searchParams.has('arch')).toBe(false);
      expect(url.searchParams.has('device_id')).toBe(false);
      expect(url.searchParams.has('build')).toBe(false);
      expect(requestedInit?.headers).toMatchObject({
        'If-None-Match': '"old-etag"',
        'Orkas-App-Version': '9.8.7',
        'Orkas-Platform': clientConfigPlatform(),
        'Orkas-Arch': process.arch,
        'Orkas-Channel': 'open',
      });
      expect(requestedInit?.headers).not.toHaveProperty('Orkas-Device-Id');

      const manager = new ClientConfigManager();
      expect(manager.get('feature.remote')).toBe('enabled');
      const cache = manager.readCache();
      expect(cache.etag).toBe('"new-etag"');
      expect(cache.config_hash).toBe('sha256:new');
      expect(cache.last_request_at_ms).toBe(now);
      expect(cache.fetched_at_ms).toBe(now);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('uses the open channel when the open-source package marker is present', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigopenchannel';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const appDir = fs.mkdtempSync(path.join(path.dirname(file), 'open-app-'));
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ license: 'MIT' }), 'utf8');
    (electronMock.app as any).getAppPath = vi.fn(() => appDir);

    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        code: 0,
        immediate: {},
        restart: {},
        config_hash: 'sha256:open',
      }), {
        status: 200,
        headers: { etag: '"open-etag"' },
      });
    });

    try {
      await refresh('manual', { force: true });
      expect(new URL(requestedUrl).searchParams.has('channel')).toBe(false);
      expect(requestedInit?.headers).toMatchObject({ 'Orkas-Channel': 'open' });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('skips return refreshes until the four-hour interval has elapsed', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'clientconfigreturninterval';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      etag: '"interval-etag"',
      active: { immediate: {}, restart: {} },
      last_request_at_ms: 10_000,
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      immediate: {},
      restart: {},
      config_hash: 'sha256:interval',
    }), {
      status: 200,
      headers: { etag: '"interval-next"' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000 + FOUR_HOURS_MS - 1);
      expect(await refresh('return')).toEqual({ updated: false, skipped: true });
      expect(fetchMock).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(10_000 + FOUR_HOURS_MS);
      const result = await refresh('return');
      expect(result).toEqual({ updated: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('start registers return-to-app hooks without starting a polling timer', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const clientConfigModule = await import('../../../src/main/features/client_config');
    const uid = 'clientconfigstarthooks';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    const now = 555_000;
    storage.writeJsonSync(file, {
      version: 1,
      active: { immediate: {}, restart: {} },
      last_request_at_ms: now,
      fetched_at_ms: now,
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      immediate: {},
      restart: {},
      config_hash: 'sha256:startup',
    }), {
      status: 200,
      headers: { etag: '"startup-etag"' },
    }));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.stubGlobal('fetch', fetchMock);

    try {
      clientConfigModule.start();
      await waitForCondition(() => fetchMock.mock.calls.length > 0);

      expect(electronMock.app.on).toHaveBeenCalledWith('browser-window-focus', expect.any(Function));
      expect(electronMock.app.on).toHaveBeenCalledWith('activate', expect.any(Function));
      expect(electronMock.powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function));
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const focusHandler = electronMock.app.on.mock.calls
        .find(([event]) => event === 'browser-window-focus')?.[1] as (() => void) | undefined;
      expect(focusHandler).toBeTruthy();
      focusHandler?.();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('keeps cached config on 304 and only refreshes timestamps', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'clientconfignotmodified';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      etag: '"same-etag"',
      config_hash: 'sha256:old',
      active: { immediate: { 'feature.cached': 'keep' }, restart: {} },
      last_request_at_ms: 1,
      fetched_at_ms: 1,
    });

    const now = 9_999_999;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.stubGlobal('fetch', async () => new Response(null, {
      status: 304,
      headers: { etag: '"same-etag"' },
    }));

    try {
      expect(await refresh('manual', { force: true })).toEqual({ updated: false, notModified: true });
      const manager = new ClientConfigManager();
      expect(manager.get('feature.cached')).toBe('keep');
      const cache = manager.readCache();
      expect(cache.etag).toBe('"same-etag"');
      expect(cache.config_hash).toBe('sha256:old');
      expect(cache.last_request_at_ms).toBe(now);
      expect(cache.fetched_at_ms).toBe(now);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});


describe('client config response ownership and deadline', () => {


  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows a fresh refresh after the attempt timestamp could not be persisted', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'clientconfigattemptrecovery';
    users.activateUser(uid);
    const manager = new ClientConfigManager();
    manager.applyServerPayload({ immediate: { 'feature.recovery': 'cached' }, restart: {} }, 'cached-etag');
    const failure = Object.assign(new Error('synthetic config write unavailable'), { code: 'EACCES' });
    const write = vi.spyOn(storage, 'writeJsonSync').mockImplementationOnce(() => { throw failure; });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0, immediate: { 'feature.recovery': 'fresh' }, restart: {}, config_hash: 'recovered-hash',
    }), { headers: { etag: 'recovered-etag' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(refresh('manual', { force: true })).rejects.toBe(failure);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(manager.get('feature.recovery')).toBe('cached');
      write.mockRestore();
      await expect(refresh('manual', { force: true })).resolves.toEqual({ updated: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(manager.get('feature.recovery')).toBe('fresh');
      expect(manager.readCache().etag).toBe('recovered-etag');
    } finally {
      write.mockRestore();
      fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true });
    }
  });

  it.each(['local-profile', 'legacy-anonymous'] as const)('discards a body completed after switching to %s and permits a fresh owner request', async destination => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const oldUid = `clientconfigbodyold-${destination}`;
    const newUid = destination === 'legacy-anonymous' ? users.ANONYMOUS_LOCAL_ID : 'clientconfigbodynew';
    const manager = new ClientConfigManager();
    users.activateUser(newUid);
    manager.applyServerPayload({ immediate: { 'feature.owner': 'keep-new-owner' }, restart: {} }, 'new-owner-etag');
    const newFile = paths.userRemoteConfigFile(newUid);
    const before = fs.readFileSync(newFile);
    users.activateUser(oldUid);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const response = new Response(JSON.stringify({
      code: 0, immediate: { 'feature.owner': 'obsolete-owner' }, restart: {}, config_hash: 'obsolete-owner-hash',
    }), { headers: { etag: 'obsolete-owner-etag' } });
    const read = response.json.bind(response);
    const json = vi.spyOn(response, 'json').mockImplementation(async () => { await gate; return read(); });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    const unsubscribe = clientConfig.subscribeAll(changed);
    let pending: ReturnType<typeof refresh> | undefined;
    try {
      pending = refresh('manual', { force: true });
      await waitForCondition(() => json.mock.calls.length > 0);
      expect(json).toHaveBeenCalledOnce();
      users.activateUser(newUid);
      release();
      const result = await pending;
      expect({ result, newOwnerCacheUnchanged: fs.readFileSync(newFile).equals(before), notifications: changed.mock.calls.length })
        .toEqual({ result: { updated: false, skipped: true, stale: true }, newOwnerCacheUnchanged: true, notifications: 0 });
      users.activateUser(oldUid);
      expect(manager.get('feature.owner')).toBeUndefined();
      users.activateUser(newUid);
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({
        code: 0, immediate: { 'feature.owner': 'fresh-new-owner' }, restart: {}, config_hash: 'fresh-owner-hash',
      }), { headers: { etag: 'fresh-owner-etag' } }));
      await refresh('manual', { force: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(manager.get('feature.owner')).toBe('fresh-new-owner');
      expect(manager.readCache().etag).toBe('fresh-owner-etag');
    } finally {
      release(); await pending; unsubscribe();
      for (const uid of [oldUid, newUid]) fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true });
    }
  });

  it('keeps the cached value after malformed JSON without introducing body-parse retries', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigbodymalformed';
    users.activateUser(uid);
    const manager = new ClientConfigManager();
    manager.applyServerPayload({ immediate: { 'feature.owner': 'keep-cached' }, restart: {} }, 'cached-etag');
    const fetchMock = vi.fn(async () => new Response('{broken'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await refresh('manual', { force: true })).toMatchObject({ updated: false, error: expect.any(String) });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(manager.get('feature.owner')).toBe('keep-cached');
      expect(manager.readCache().etag).toBe('cached-etag');
    } finally {
      fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true });
    }
  });

  it('keeps the request deadline active while a response body stalls and recovers on its bounded retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const uid = 'clientconfigbodydeadline';
    users.activateUser(uid);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let firstSignal: AbortSignal | undefined;
    let bodyAborts = 0;
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_input: unknown, init: RequestInit) => {
        firstSignal = init.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            firstSignal!.addEventListener('abort', () => {
              bodyAborts += 1;
              controller.error(firstSignal!.reason);
            }, { once: true });
          },
        }));
      })
      .mockImplementation(async () => new Response(JSON.stringify({
        code: 0, immediate: { 'feature.deadline': 'recovered' }, restart: {}, config_hash: 'deadline-recovered',
      })));
    vi.stubGlobal('fetch', fetchMock);
    let pending: ReturnType<typeof refresh> | undefined;
    try {
      pending = refresh('manual', { force: true });
      await waitForCondition(() => fetchMock.mock.calls.length > 0);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(bodyAborts).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(bodyAborts).toBe(1);
      expect(firstSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({ updated: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new ClientConfigManager().get('feature.deadline')).toBe('recovered');
    } finally {
      bodyController?.error(new Error('fixture cleanup'));
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      vi.useRealTimers();
      fs.rmSync(path.dirname(paths.userRemoteConfigFile(uid)), { recursive: true, force: true });
    }
  });
});
