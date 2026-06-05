/**
 * PC-side product config center.
 *
 * Server JSON is the authority for overrides. This feature owns local
 * defaults, last-known-good cache, immediate/restart application, and typed
 * views such as the provider model catalog.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getActiveUserId, hasActiveUser } from './users';
import { userRemoteConfigFile } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { getCurrentDevice } from '../util/device';

export type ClientConfigEffect = 'immediate' | 'restart';

export interface ClientConfigDefinition<T = unknown> {
  defaultValue: T;
  effect?: ClientConfigEffect;
  merge?: (defaultValue: T, serverValue: unknown) => T;
}

export interface ApplyServerConfigResult {
  updated: boolean;
  immediateChanged: boolean;
  restartChanged: boolean;
  config_hash?: string;
}

export type ClientConfigListener<T = unknown> = (value: T | undefined, key: string) => void;
export type ClientConfigAnyListener = (keys: string[], values: Record<string, unknown>) => void;

type ConfigRefreshReason = 'startup' | 'return' | 'manual';
type ConfigRefreshResult = { updated: boolean; notModified?: boolean; skipped?: boolean; error?: string };
type ElectronAppLike = {
  isPackaged: boolean;
  getVersion(): string;
  getAppPath?(): string;
  on(event: 'browser-window-focus' | 'activate', listener: () => void): void;
  off(event: 'browser-window-focus' | 'activate', listener: () => void): void;
};
type ElectronPowerMonitorLike = {
  on(event: 'resume', listener: () => void): void;
  off(event: 'resume', listener: () => void): void;
};

const log = createLogger('client-config');
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PROD_DEFAULT = 'https://orkas.ai/api';
const DEV_DEFAULT = 'http://127.0.0.1:8888/api';

let started = false;
let inFlight: Promise<ConfigRefreshResult> | null = null;
let runtimeApp: ElectronAppLike | null = null;
let runtimePowerMonitor: ElectronPowerMonitorLike | null = null;

export interface RemoteConfigCache {
  version: 1;
  etag?: string;
  config_hash?: string;
  last_request_at_ms?: number;
  active?: {
    immediate?: Record<string, unknown>;
    restart?: Record<string, unknown>;
  };
  pending_restart?: {
    restart?: Record<string, unknown>;
    config_hash?: string;
    present?: boolean;
  };
  fetched_at_ms?: number;
}

function normalizeKey(key: unknown): string {
  return typeof key === 'string' ? key.trim() : '';
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function own(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !sameJson(a[key], b[key]));
}

function emptyCache(): RemoteConfigCache {
  return { version: 1, active: { immediate: {}, restart: {} } };
}

function normalizeRemoteConfigCache(raw: unknown): RemoteConfigCache {
  if (!raw || typeof raw !== 'object') return emptyCache();
  const r = raw as Record<string, unknown>;
  const active = normalizeRecord(r.active);
  const pending = normalizeRecord(r.pending_restart);
  return {
    version: 1,
    ...(typeof r.etag === 'string' && r.etag ? { etag: r.etag } : {}),
    ...(typeof r.config_hash === 'string' && r.config_hash ? { config_hash: r.config_hash } : {}),
    ...(typeof r.last_request_at_ms === 'number' && r.last_request_at_ms > 0 ? { last_request_at_ms: r.last_request_at_ms } : {}),
    active: {
      immediate: normalizeRecord(active.immediate),
      restart: normalizeRecord(active.restart),
    },
    pending_restart: {
      restart: normalizeRecord(pending.restart),
      ...(typeof pending.config_hash === 'string' && pending.config_hash ? { config_hash: pending.config_hash } : {}),
      ...(pending.present === true ? { present: true } : {}),
    },
    ...(typeof r.fetched_at_ms === 'number' && r.fetched_at_ms > 0 ? { fetched_at_ms: r.fetched_at_ms } : {}),
  };
}

function cacheFile(): string | null {
  try {
    if (!hasActiveUser()) return null;
    return userRemoteConfigFile(getActiveUserId());
  } catch {
    return null;
  }
}

function readRemoteConfigCache(): RemoteConfigCache {
  const file = cacheFile();
  if (!file) return emptyCache();
  try {
    return normalizeRemoteConfigCache(readJsonSync(file));
  } catch {
    return emptyCache();
  }
}

function writeRemoteConfigCache(cache: RemoteConfigCache): void {
  const file = cacheFile();
  if (!file) return;
  writeJsonSync(file, normalizeRemoteConfigCache(cache));
}

function promotePendingRestartConfig(): boolean {
  const cache = readRemoteConfigCache();
  const pending = normalizeRecord(cache.pending_restart?.restart);
  if (!cache.pending_restart?.present && !Object.keys(pending).length) return false;
  const next = normalizeRemoteConfigCache({
    ...cache,
    active: {
      immediate: normalizeRecord(cache.active?.immediate),
      restart: pending,
    },
    pending_restart: {},
  });
  writeRemoteConfigCache(next);
  return true;
}

export class ClientConfigManager {
  private readonly definitions = new Map<string, ClientConfigDefinition>();
  private readonly listeners = new Map<string, Set<ClientConfigListener>>();
  private readonly anyListeners = new Set<ClientConfigAnyListener>();

  registerDefault<T>(
    key: string,
    defaultValue: T,
    options: Omit<ClientConfigDefinition<T>, 'defaultValue'> = {},
  ): void {
    const k = normalizeKey(key);
    if (!k) return;
    this.definitions.set(k, {
      defaultValue,
      effect: options.effect || 'immediate',
      ...(options.merge ? { merge: options.merge as ClientConfigDefinition['merge'] } : {}),
    });
  }

  subscribe<T = unknown>(key: string, listener: ClientConfigListener<T>): () => void {
    const k = normalizeKey(key);
    if (!k) return () => {};
    const set = this.listeners.get(k) || new Set<ClientConfigListener>();
    set.add(listener as ClientConfigListener);
    this.listeners.set(k, set);
    return () => {
      set.delete(listener as ClientConfigListener);
      if (!set.size) this.listeners.delete(k);
    };
  }

  subscribeAll(listener: ClientConfigAnyListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  private notifyChanged(keys: string[]): void {
    const normalizedKeys = [...new Set(keys.map(normalizeKey).filter(Boolean))];
    if (!normalizedKeys.length) return;
    const values: Record<string, unknown> = {};
    for (const key of normalizedKeys) {
      values[key] = this.get(key);
      const set = this.listeners.get(key);
      if (!set?.size) continue;
      for (const listener of [...set]) {
        try {
          listener(values[key], key);
        } catch {
          // Config listeners are best-effort; one feature must not break sync.
        }
      }
    }
    for (const listener of [...this.anyListeners]) {
      try {
        listener(normalizedKeys, values);
      } catch {
        // Config listeners are best-effort; one feature must not break sync.
      }
    }
  }

  getDefault<T = unknown>(key: string): T | undefined {
    const definition = this.definitions.get(normalizeKey(key));
    return definition?.defaultValue as T | undefined;
  }

  getServerValue(key: string): unknown {
    const k = normalizeKey(key);
    if (!k) return undefined;
    const cache = readRemoteConfigCache();
    const immediate = normalizeRecord(cache.active?.immediate);
    if (own(immediate, k)) return immediate[k];
    const restart = normalizeRecord(cache.active?.restart);
    if (own(restart, k)) return restart[k];
    return undefined;
  }

  hasServerValue(key: string): boolean {
    const k = normalizeKey(key);
    if (!k) return false;
    const cache = readRemoteConfigCache();
    return own(normalizeRecord(cache.active?.immediate), k) || own(normalizeRecord(cache.active?.restart), k);
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    const k = normalizeKey(key);
    if (!k) return fallback;
    const definition = this.definitions.get(k);
    if (this.hasServerValue(k)) {
      const serverValue = this.getServerValue(k);
      if (definition?.merge) {
        return definition.merge(definition.defaultValue, serverValue) as T;
      }
      return serverValue as T;
    }
    if (definition) return definition.defaultValue as T;
    return fallback;
  }

  readCache(): RemoteConfigCache {
    return readRemoteConfigCache();
  }

  lastRequestAtMs(): number {
    const cache = readRemoteConfigCache();
    return Number(cache.last_request_at_ms) || Number(cache.fetched_at_ms) || 0;
  }

  shouldRefresh(minIntervalMs: number, nowMs = Date.now()): boolean {
    const last = this.lastRequestAtMs();
    return !last || nowMs - last >= minIntervalMs;
  }

  markRefreshAttempt(nowMs = Date.now()): void {
    const cache = readRemoteConfigCache();
    writeRemoteConfigCache({
      ...cache,
      last_request_at_ms: nowMs,
    });
  }

  markNotModified(etag = '', nowMs = Date.now()): void {
    const cache = readRemoteConfigCache();
    writeRemoteConfigCache({
      ...cache,
      ...(etag ? { etag } : {}),
      last_request_at_ms: nowMs,
      fetched_at_ms: nowMs,
    });
  }

  promotePendingRestart(): boolean {
    const before = readRemoteConfigCache();
    const activeRestart = normalizeRecord(before.active?.restart);
    const pendingRestart = normalizeRecord(before.pending_restart?.restart);
    const promoted = promotePendingRestartConfig();
    if (promoted) {
      this.notifyChanged(changedKeys(activeRestart, pendingRestart));
    }
    return promoted;
  }

  applyServerPayload(
    body: Record<string, unknown>,
    etag: string,
    nowMs = Date.now(),
  ): ApplyServerConfigResult {
    const current = readRemoteConfigCache();
    const immediate = normalizeRecord(body.immediate);
    const restart = normalizeRecord(body.restart);
    const configHash = typeof body.config_hash === 'string' ? body.config_hash : '';

    const activeImmediate = normalizeRecord(current.active?.immediate);
    const activeRestart = normalizeRecord(current.active?.restart);
    const pendingRestart = normalizeRecord(current.pending_restart?.restart);
    const immediateChanged = !sameJson(activeImmediate, immediate);
    const immediateChangedKeys = changedKeys(activeImmediate, immediate);
    const hasPendingRestart = current.pending_restart?.present === true || Object.keys(pendingRestart).length > 0;
    const restartMatchesActive = sameJson(activeRestart, restart);
    const restartChanged = restartMatchesActive
      ? hasPendingRestart
      : !sameJson(pendingRestart, restart);

    const next = normalizeRemoteConfigCache({
      ...current,
      etag,
      config_hash: configHash || current.config_hash,
      active: {
        immediate: immediateChanged ? immediate : activeImmediate,
        restart: activeRestart,
      },
      pending_restart: restartChanged
        ? (restartMatchesActive ? {} : { restart, config_hash: configHash, present: true })
        : current.pending_restart,
      last_request_at_ms: nowMs,
      fetched_at_ms: nowMs,
    });

    const updated = immediateChanged
      || restartChanged
      || current.etag !== etag
      || current.config_hash !== configHash;
    writeRemoteConfigCache(next);
    if (updated && immediateChangedKeys.length) this.notifyChanged(immediateChangedKeys);

    return {
      updated,
      immediateChanged,
      restartChanged,
      config_hash: next.config_hash,
    };
  }
}

export const clientConfig = new ClientConfigManager();

export type ClientConfigChannel = 'prod' | 'dev' | 'open';

function normalizeChannel(raw: string | undefined): ClientConfigChannel | null {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'prod' || v === 'dev' || v === 'open') return v;
  return null;
}

function isOpenSourcePackage(app: ElectronAppLike): boolean {
  try {
    const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '';
    if (!appPath) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')) as Record<string, unknown>;
    return String(pkg.license || '').trim().toUpperCase() === 'MIT';
  } catch {
    return false;
  }
}

function channel(app: ElectronAppLike): ClientConfigChannel {
  const envChannel = normalizeChannel(process.env.ORKAS_CLIENT_CHANNEL || process.env.ORKAS_CHANNEL);
  if (envChannel) return envChannel;
  if (isOpenSourcePackage(app)) return 'open';
  return app.isPackaged ? 'prod' : 'dev';
}

function region(): string {
  return (process.env.ORKAS_PROFILE || 'global').trim() || 'global';
}

function apiBase(app: ElectronAppLike): string {
  const env = process.env.ORKAS_ACCOUNT_API_BASE || process.env.ORKAS_API_BASE_URL;
  if (env) return env.replace(/\/+$/, '');
  return app.isPackaged ? PROD_DEFAULT : DEV_DEFAULT;
}

function buildUrl(app: ElectronAppLike): string {
  const url = new URL(`${apiBase(app)}/config/client`);
  const device = getCurrentDevice();
  url.searchParams.set('platform', 'pc');
  url.searchParams.set('version', app.getVersion());
  url.searchParams.set('channel', channel(app));
  url.searchParams.set('region', region());
  url.searchParams.set('os', process.platform);
  url.searchParams.set('arch', process.arch);
  url.searchParams.set('device_id', device.id || device.name);
  return url.toString();
}

function applyPayload(body: Record<string, unknown>, etag: string): boolean {
  const result = clientConfig.applyServerPayload(body, etag);
  if (result.updated) {
    log.info('client config updated', {
      config_hash: result.config_hash,
      immediateChanged: result.immediateChanged,
      restartChanged: result.restartChanged,
    });
  }
  return result.updated;
}

async function loadElectronRuntime(): Promise<{
  app: ElectronAppLike;
  powerMonitor: ElectronPowerMonitorLike;
}> {
  const mod = await import('electron');
  return {
    app: mod.app as unknown as ElectronAppLike,
    powerMonitor: mod.powerMonitor as unknown as ElectronPowerMonitorLike,
  };
}

export async function refresh(
  reason: ConfigRefreshReason = 'manual',
  options: { force?: boolean } = {},
): Promise<ConfigRefreshResult> {
  if (!options.force && !clientConfig.shouldRefresh(REFRESH_INTERVAL_MS)) {
    return { updated: false, skipped: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const current = clientConfig.readCache();
    clientConfig.markRefreshAttempt();
    try {
      const { app } = runtimeApp ? { app: runtimeApp } : await loadElectronRuntime();
      const headers: Record<string, string> = {};
      if (current.etag) headers['If-None-Match'] = current.etag;
      const res = await fetch(buildUrl(app), { method: 'GET', headers });
      const etag = res.headers.get('etag') || '';
      if (res.status === 304) {
        clientConfig.markNotModified(etag || current.etag || '');
        log.debug('client config not modified', { reason });
        return { updated: false, notModified: true };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (body.code !== 0) throw new Error(String(body.msg || body.code || 'client config error'));
      return { updated: applyPayload(body, etag) };
    } catch (err) {
      const error = (err as Error)?.message || String(err);
      log.warn('client config refresh failed', { reason, error });
      return { updated: false, error };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function onReturnToApp(): void {
  void refresh('return');
}

export function start(): void {
  if (started) return;
  started = true;
  void loadElectronRuntime().then(({ app, powerMonitor }) => {
    runtimeApp = app;
    runtimePowerMonitor = powerMonitor;
    try {
      if (clientConfig.promotePendingRestart()) {
        log.info('promoted pending restart config');
      }
    } catch (err) {
      log.warn('promote pending restart config failed', { error: (err as Error).message });
    }
    setImmediate(() => { void refresh('startup'); });
    app.on('browser-window-focus', onReturnToApp);
    app.on('activate', onReturnToApp);
    powerMonitor.on('resume', onReturnToApp);
  }).catch((err) => {
    started = false;
    log.warn('client config start failed', { error: (err as Error).message });
  });
}

export function stop(): void {
  started = false;
  runtimeApp?.off('browser-window-focus', onReturnToApp);
  runtimeApp?.off('activate', onReturnToApp);
  runtimePowerMonitor?.off('resume', onReturnToApp);
  runtimeApp = null;
  runtimePowerMonitor = null;
}

export interface ProviderModelEntry {
  id: string;
  name: string;
}

export interface ImageGenCapability {
  model: string;
  api: 'openai' | 'gemini' | 'doubao';
  supportsEdit: boolean;
}

export interface ImageGenCapabilityOverride {
  model?: string;
  api?: 'openai' | 'gemini' | 'doubao';
  supportsEdit?: boolean;
}

export type ConnectorSwitchState = 'enabled' | 'disabled' | 'visible_disabled';

export interface GoogleConnectorsConfig {
  google: ConnectorSwitchState;
  gmail: ConnectorSwitchState;
}

interface ModelCatalogConfig {
  providers: Record<string, ProviderModelEntry[]>;
  imageGeneration: Record<string, ImageGenCapability>;
}

const VALID_IMAGE_APIS = new Set(['openai', 'gemini', 'doubao']);

export const DEFAULT_PROVIDER_MODELS: Readonly<Record<string, readonly ProviderModelEntry[]>> = {
  anthropic: [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  ],
  'openai-codex': [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
  ],
  openai: [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  ],
  google: [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (preview)' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)' },
  ],
  zai: [
    { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-5', name: 'GLM-5' },
    { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
    { id: 'glm-5v-turbo', name: 'GLM-5V Turbo' },
  ],
  moonshot: [
    { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
  ],
  'kimi-coding': [
    { id: 'k2p6', name: 'Kimi K2.6' },
    { id: 'kimi-for-coding', name: 'Kimi For Coding' },
  ],
  'minimax-cn': [
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
  'minimax-portal': [
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
  'minimax-portal-cn': [
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],
  doubao: [
    { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro' },
    { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao Seed 2.0 Lite' },
  ],
  openrouter: [
    { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
    { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
    { id: 'openai/gpt-5.5-pro', name: 'GPT-5.5 Pro' },
    { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
    { id: 'openai/gpt-5.4-pro', name: 'GPT-5.4 Pro' },
    { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
    { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)' },
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'qwen/qwen3-max', name: 'Qwen3 Max' },
    { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
    { id: 'z-ai/glm-5.1', name: 'GLM-5.1' },
    { id: 'z-ai/glm-5', name: 'GLM-5' },
    { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7' },
    { id: 'xiaomi/mimo-v2.5-pro', name: 'Xiaomi MiMo V2.5 Pro' },
    { id: 'xiaomi/mimo-v2.5', name: 'Xiaomi MiMo V2.5' },
  ],
};

export const DEFAULT_IMAGE_GEN_BY_PROVIDER: Readonly<Record<string, ImageGenCapability>> = {
  openai: { model: 'gpt-image-2', api: 'openai', supportsEdit: true },
  google: { model: 'gemini-3.1-flash-image-preview', api: 'gemini', supportsEdit: true },
  doubao: { model: 'doubao-seedream-4-5-251128', api: 'doubao', supportsEdit: true },
};

function emptyModelCatalog(): ModelCatalogConfig {
  return { providers: {}, imageGeneration: {} };
}

function normalizeProviderModels(value: unknown): ProviderModelEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProviderModelEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    out.push({ id, name });
  }
  return out;
}

function normalizeImageGenCapability(value: unknown): ImageGenCapability | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const api = typeof r.api === 'string' && VALID_IMAGE_APIS.has(r.api)
    ? r.api as ImageGenCapability['api']
    : '';
  if (!model || !api) return null;
  return { model, api, supportsEdit: r.supportsEdit === true };
}

function mergeProviderSection(target: Record<string, ProviderModelEntry[]>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [rawKey, rawModels] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeKey(rawKey);
    if (!key) continue;
    const models = normalizeProviderModels(rawModels);
    if (models) target[key] = models;
  }
}

function mergeImageGenerationSection(target: Record<string, ImageGenCapability>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [rawKey, rawCapability] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeKey(rawKey);
    if (!key) continue;
    const capability = normalizeImageGenCapability(rawCapability);
    if (capability) target[key] = capability;
  }
}

function normalizeModelCatalogConfig(raw: unknown): ModelCatalogConfig {
  const out = emptyModelCatalog();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  mergeProviderSection(out.providers, r.providers ?? r.curated_models);
  mergeImageGenerationSection(out.imageGeneration, r.image_generation ?? r.imageGeneration);
  return out;
}

const CONNECTOR_SWITCH_STATES = new Set<ConnectorSwitchState>(['enabled', 'disabled', 'visible_disabled']);

function normalizeConnectorSwitchState(value: unknown): ConnectorSwitchState | null {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'visible_disabled' || normalized === 'disabled_visible' || normalized === 'show_disabled') {
    return 'visible_disabled';
  }
  return CONNECTOR_SWITCH_STATES.has(normalized as ConnectorSwitchState)
    ? normalized as ConnectorSwitchState
    : null;
}

function normalizeGoogleConnectorsConfig(raw: unknown): Partial<GoogleConnectorsConfig> {
  const direct = normalizeConnectorSwitchState(raw);
  if (direct) return { google: direct };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const google = normalizeConnectorSwitchState(r.google ?? r.all ?? r.enabled);
  const gmail = normalizeConnectorSwitchState(r.gmail);
  return {
    ...(google ? { google } : {}),
    ...(gmail ? { gmail } : {}),
  };
}

function mergeGoogleConnectorsConfig(baseRaw: unknown, overrideRaw: unknown): GoogleConnectorsConfig {
  const base = normalizeGoogleConnectorsConfig(baseRaw);
  const override = normalizeGoogleConnectorsConfig(overrideRaw);
  return {
    google: override.google || base.google || 'enabled',
    gmail: override.gmail || base.gmail || 'enabled',
  };
}

function mergeModelCatalogConfig(baseRaw: unknown, overrideRaw: unknown): ModelCatalogConfig {
  const base = normalizeModelCatalogConfig(baseRaw);
  const override = normalizeModelCatalogConfig(overrideRaw);
  return {
    providers: {
      ...base.providers,
      ...override.providers,
    },
    imageGeneration: {
      ...base.imageGeneration,
      ...override.imageGeneration,
    },
  };
}

const DEFAULT_MODEL_CATALOG = normalizeModelCatalogConfig({
  providers: DEFAULT_PROVIDER_MODELS,
  image_generation: DEFAULT_IMAGE_GEN_BY_PROVIDER,
});

clientConfig.registerDefault<ModelCatalogConfig>('model_catalog', DEFAULT_MODEL_CATALOG, {
  effect: 'immediate',
  merge: mergeModelCatalogConfig,
});

const DEFAULT_GOOGLE_CONNECTORS_CONFIG: GoogleConnectorsConfig = {
  google: 'enabled',
  gmail: 'enabled',
};

clientConfig.registerDefault<GoogleConnectorsConfig>('google_connectors', DEFAULT_GOOGLE_CONNECTORS_CONFIG, {
  effect: 'immediate',
  merge: mergeGoogleConnectorsConfig,
});

clientConfig.registerDefault<boolean>('model.deepseek.enabled', true, {
  effect: 'immediate',
});

function loadModelCatalog(): ModelCatalogConfig {
  return normalizeModelCatalogConfig(clientConfig.get('model_catalog', DEFAULT_MODEL_CATALOG));
}

export function getConfiguredProviderModels(providerId: string): { models: ProviderModelEntry[] } | null {
  const id = normalizeKey(providerId);
  if (!id) return null;
  const cfg = loadModelCatalog();
  if (!Object.prototype.hasOwnProperty.call(cfg.providers, id)) return null;
  return { models: cfg.providers[id].map((m) => ({ id: m.id, name: m.name })) };
}

export function getConfiguredImageGenCapability(providerId: string): ImageGenCapabilityOverride | null {
  const id = normalizeKey(providerId);
  if (!id) return null;
  const cfg = loadModelCatalog();
  const capability = cfg.imageGeneration[id];
  if (!capability) return null;
  return { ...capability };
}

export function getGoogleConnectorsConfig(): GoogleConnectorsConfig {
  return mergeGoogleConnectorsConfig(
    DEFAULT_GOOGLE_CONNECTORS_CONFIG,
    clientConfig.get('google_connectors', DEFAULT_GOOGLE_CONNECTORS_CONFIG),
  );
}

export function isDeepSeekModelConfigEnabled(): boolean {
  return clientConfig.get<boolean>('model.deepseek.enabled', true) !== false;
}
