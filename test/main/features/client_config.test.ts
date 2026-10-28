import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  clientConfigPlatform,
  refresh,
  start,
  stop,
} from '../../../src/main/features/client_config';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

async function waitForCondition(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('client_config', () => {
  beforeEach(() => {
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

  it('ships the synchronized public model catalog with compatibility metadata', () => {
    expect(DEFAULT_PROVIDER_MODELS['openai-codex']).toEqual([
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', maxTokens: 128000, maxInputImages: 20 },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maxTokens: 64000, maxInputImages: 20 },
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
