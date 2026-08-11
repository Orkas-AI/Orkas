/**
 * PC-side product config center.
 *
 * Server JSON is the authority for overrides. This feature owns local
 * defaults, last-known-good cache, immediate/restart application, and typed
 * views such as the provider model catalog.
 */

import { getActiveUserId, hasActiveUser } from './users';
import { userRemoteConfigFile } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { fetchWithRetry } from '../util/retry';
import { desktopPlatform } from '../system_info';
import { withCommonHeaders } from './api_common';
import { DEFAULT_RETRY_ERROR_POLICY, type RetryErrorPolicyConfig } from '../../core-agent/src/shared/errors';
import { PUBLIC_PROVIDER_MODELS, type ProviderModelEntry } from '../model/public_model_catalog';

export type { RetryErrorPolicyConfig } from '../../core-agent/src/shared/errors';
export type { ProviderModelEntry } from '../model/public_model_catalog';

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

let started = false;
let inFlight: Promise<ConfigRefreshResult> | null = null;
let runtimeApp: ElectronAppLike | null = null;
let runtimePowerMonitor: ElectronPowerMonitorLike | null = null;

export interface ClientConfigStartOptions {
  startupDelayMs?: number;
  forceStartupRefresh?: boolean;
}

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

export type ClientConfigChannel = 'open';

function channel(_app: ElectronAppLike): ClientConfigChannel {
  return 'open';
}

function region(): string {
  return 'global';
}

export function clientConfigPlatform(platform = process.platform): string {
  return desktopPlatform(platform);
}

function apiBase(_app: ElectronAppLike): string {
  return PROD_DEFAULT;
}

function buildUrl(app: ElectronAppLike): string {
  const url = new URL(`${apiBase(app)}/config/client`);
  url.searchParams.set('region', region());
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

function activeConfigOwner(): string | null {
  try {
    return hasActiveUser() ? getActiveUserId() : null;
  } catch {
    return null;
  }
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
    const requestOwner = activeConfigOwner();
    const current = clientConfig.readCache();
    clientConfig.markRefreshAttempt();
    try {
      const { app } = runtimeApp ? { app: runtimeApp } : await loadElectronRuntime();
      const headers: Record<string, string> = withCommonHeaders();
      if (current.etag) headers['If-None-Match'] = current.etag;
      const res = await fetchWithRetry('client-config:refresh', buildUrl(app), { method: 'GET', headers });
      const etag = res.headers.get('etag') || '';
      if (activeConfigOwner() !== requestOwner) {
        log.info('stale client config response ignored after account switch', { reason });
        return { updated: false, skipped: true, stale: true };
      }
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

export function start(opts: ClientConfigStartOptions = {}): void {
  if (started) return;
  started = true;
  const startupDelayMs = Number.isFinite(opts.startupDelayMs) ? Math.max(0, Number(opts.startupDelayMs)) : 0;
  const forceStartupRefresh = opts.forceStartupRefresh !== false;
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
    const runStartupRefresh = (): void => { void refresh('startup', { force: forceStartupRefresh }); };
    if (startupDelayMs > 0) {
      const timer = setTimeout(runStartupRefresh, startupDelayMs);
      timer.unref?.();
    } else {
      setImmediate(runStartupRefresh);
    }
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

export interface AppUpdatePolicyConfig {
  min_version: string;
}

export type QuickStartScenarioId =
  | 'data'
  | 'office'
  | 'ppt'
  | 'creation'
  | 'video'
  | 'image'
  | 'ui_design'
  | 'rnd'
  | 'seo_geo';

export interface QuickStartConfigEntry {
  id: QuickStartScenarioId;
  agent_id: string;
}

export type QuickStartConfigSource = 'pc_default' | 'server_config';

export interface QuickStartConfigState {
  items: QuickStartConfigEntry[];
  source: QuickStartConfigSource;
}

interface ModelCatalogConfig {
  providers: Record<string, ProviderModelEntry[]>;
  imageGeneration: Record<string, ImageGenCapability>;
}

const VALID_IMAGE_APIS = new Set(['openai', 'gemini', 'doubao']);

function cloneRetryErrorPolicyConfig(config: RetryErrorPolicyConfig): RetryErrorPolicyConfig {
  return {
    permanent_statuses: [...config.permanent_statuses],
    permanent_message_patterns: [...config.permanent_message_patterns],
    permanent_code_patterns: [...config.permanent_code_patterns],
  };
}

export const DEFAULT_PROVIDER_MODELS = PUBLIC_PROVIDER_MODELS;

export const DEFAULT_IMAGE_GEN_BY_PROVIDER: Readonly<Record<string, ImageGenCapability>> = {
  openai: { model: 'gpt-image-2', api: 'openai', supportsEdit: true },
  google: { model: 'gemini-3.1-flash-image-preview', api: 'gemini', supportsEdit: true },
  doubao: { model: 'doubao-seedream-4-5-251128', api: 'doubao', supportsEdit: true },
};

/**
 * First-paint fallback for the Commander home page. The Server may replace
 * this ordered list through `commander.quick_start`, but it deliberately does
 * not publish that key yet. Every referenced agent is either bundled with the
 * desktop app or marked `default_install` in the marketplace.
 */
export const DEFAULT_QUICK_START_CONFIG: ReadonlyArray<QuickStartConfigEntry> = [
  { id: 'data', agent_id: '78900d8758bc' },
  { id: 'office', agent_id: 'a19101ba698a' },
  { id: 'ppt', agent_id: '7e91cb9ec9e9' },
  { id: 'creation', agent_id: '173d4235a431' },
  { id: 'image', agent_id: '814b61b027f0' },
  { id: 'video', agent_id: '79df9cc89f5f' },
  { id: 'ui_design', agent_id: 'bcfcb4921dce' },
  { id: 'rnd', agent_id: 'a316881746f9' },
  { id: 'seo_geo', agent_id: 'e064dca9e1bd' },
];

const QUICK_START_SCENARIO_IDS = new Set<QuickStartScenarioId>(
  DEFAULT_QUICK_START_CONFIG.map((entry) => entry.id),
);
let lastInvalidQuickStartConfigHash = '';

function normalizeQuickStartConfig(raw: unknown): QuickStartConfigEntry[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUICK_START_SCENARIO_IDS.size) return null;
  const out: QuickStartConfigEntry[] = [];
  const seen = new Set<QuickStartScenarioId>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() as QuickStartScenarioId : '' as QuickStartScenarioId;
    const agentId = typeof record.agent_id === 'string' ? record.agent_id.trim() : '';
    if (!QUICK_START_SCENARIO_IDS.has(id) || seen.has(id) || !/^[A-Za-z0-9_-]{3,64}$/.test(agentId)) return null;
    seen.add(id);
    out.push({ id, agent_id: agentId });
  }
  return out;
}

function mergeQuickStartConfig(baseRaw: unknown, overrideRaw: unknown): QuickStartConfigEntry[] {
  const base = normalizeQuickStartConfig(baseRaw)
    || DEFAULT_QUICK_START_CONFIG.map((entry) => ({ ...entry }));
  const override = normalizeQuickStartConfig(overrideRaw);
  return (override || base).map((entry) => ({ ...entry }));
}

function emptyModelCatalog(): ModelCatalogConfig {
  return { providers: {}, imageGeneration: {} };
}

function normalizeProviderModels(value: unknown): ProviderModelEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProviderModelEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || id.length > 200 || seenIds.has(id)) return null;
    seenIds.add(id);
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    if (name.length > 200) return null;
    const description = typeof r.description === 'string' ? r.description.trim() : undefined;
    if (r.description !== undefined && (!description || description.length > 500)) return null;
    const recommended = r.recommended === true;
    const template = typeof r.template === 'string' && r.template.trim() ? r.template.trim() : undefined;
    const contextWindow = normalizePositiveInteger(r.contextWindow);
    const maxTokens = normalizePositiveInteger(r.maxTokens);
    const maxInputImages = normalizeNonNegativeInteger(r.maxInputImages);
    const includedModels = normalizeIncludedModels(r.includedModels);
    if (r.includedModels !== undefined && includedModels === null) return null;
    out.push({
      id,
      name,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true } : {}),
      ...(includedModels ? { includedModels } : {}),
      ...(template ? { template } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxInputImages !== undefined ? { maxInputImages } : {}),
    });
  }
  return out.length ? out : null;
}

function normalizeIncludedModels(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const label = item.trim();
    if (!label || label.length > 80) return null;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.length ? out : null;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 0 ? n : undefined;
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
  if (direct) return { google: direct, gmail: direct };
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

function normalizeAppUpdatePolicyConfig(raw: unknown): Partial<AppUpdatePolicyConfig> {
  if (typeof raw === 'string') return { min_version: raw.trim() };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const min = r.min_version ?? r.minimum_version ?? r.minimumVersion ?? r.minVersion;
  return typeof min === 'string' ? { min_version: min.trim() } : {};
}

function mergeAppUpdatePolicyConfig(baseRaw: unknown, overrideRaw: unknown): AppUpdatePolicyConfig {
  const base = normalizeAppUpdatePolicyConfig(baseRaw);
  const override = normalizeAppUpdatePolicyConfig(overrideRaw);
  return {
    min_version: override.min_version ?? base.min_version ?? '',
  };
}

function normalizeStringPatternList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function normalizeStatusList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(n) || n < 100 || n > 599 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeRetryErrorPolicyConfig(raw: unknown): Partial<RetryErrorPolicyConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const permanentStatuses = normalizeStatusList(r.permanent_statuses);
  const permanentMessagePatterns = normalizeStringPatternList(r.permanent_message_patterns);
  const permanentCodePatterns = normalizeStringPatternList(r.permanent_code_patterns);

  return {
    ...(permanentStatuses !== undefined ? { permanent_statuses: permanentStatuses } : {}),
    ...(permanentMessagePatterns !== undefined ? { permanent_message_patterns: permanentMessagePatterns } : {}),
    ...(permanentCodePatterns !== undefined ? { permanent_code_patterns: permanentCodePatterns } : {}),
  };
}

function mergeRetryErrorPolicyConfig(baseRaw: unknown, overrideRaw: unknown): RetryErrorPolicyConfig {
  const base = normalizeRetryErrorPolicyConfig(baseRaw);
  const override = normalizeRetryErrorPolicyConfig(overrideRaw);
  return {
    permanent_statuses: override.permanent_statuses !== undefined
      ? [...override.permanent_statuses]
      : base.permanent_statuses !== undefined
        ? [...base.permanent_statuses]
        : [...DEFAULT_RETRY_ERROR_POLICY.permanent_statuses],
    permanent_message_patterns: override.permanent_message_patterns !== undefined
      ? [...override.permanent_message_patterns]
      : base.permanent_message_patterns !== undefined
        ? [...base.permanent_message_patterns]
        : [...DEFAULT_RETRY_ERROR_POLICY.permanent_message_patterns],
    permanent_code_patterns: override.permanent_code_patterns !== undefined
      ? [...override.permanent_code_patterns]
      : base.permanent_code_patterns !== undefined
        ? [...base.permanent_code_patterns]
        : [...DEFAULT_RETRY_ERROR_POLICY.permanent_code_patterns],
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
  google: 'disabled',
  gmail: 'disabled',
};

clientConfig.registerDefault<GoogleConnectorsConfig>('google_connectors', DEFAULT_GOOGLE_CONNECTORS_CONFIG, {
  effect: 'immediate',
  merge: mergeGoogleConnectorsConfig,
});

clientConfig.registerDefault<boolean>('model.deepseek.enabled', true, {
  effect: 'immediate',
});

clientConfig.registerDefault<AppUpdatePolicyConfig>('app_update', { min_version: '' }, {
  effect: 'immediate',
  merge: mergeAppUpdatePolicyConfig,
});

clientConfig.registerDefault<string>('app_update.min_version', '', {
  effect: 'immediate',
});

clientConfig.registerDefault<QuickStartConfigEntry[]>(
  'commander.quick_start',
  DEFAULT_QUICK_START_CONFIG.map((entry) => ({ ...entry })),
  {
  effect: 'immediate',
  merge: mergeQuickStartConfig,
  },
);

clientConfig.registerDefault<RetryErrorPolicyConfig>(
  'model.retry_error_policy',
  cloneRetryErrorPolicyConfig(DEFAULT_RETRY_ERROR_POLICY),
  {
    effect: 'immediate',
    merge: mergeRetryErrorPolicyConfig,
  },
);

function loadModelCatalog(): ModelCatalogConfig {
  return normalizeModelCatalogConfig(clientConfig.get('model_catalog', DEFAULT_MODEL_CATALOG));
}

export function getConfiguredProviderModels(providerId: string): { models: ProviderModelEntry[] } | null {
  const id = normalizeKey(providerId);
  if (!id) return null;
  const cfg = loadModelCatalog();
  if (!Object.prototype.hasOwnProperty.call(cfg.providers, id)) return null;
  return { models: cfg.providers[id].map((m) => ({ ...m })) };
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

export function getMinimumAppVersion(): string {
  const direct = clientConfig.get<string>('app_update.min_version', '');
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const policy = mergeAppUpdatePolicyConfig(
    { min_version: '' },
    clientConfig.get('app_update', { min_version: '' }),
  );
  return policy.min_version.trim();
}

export function getQuickStartConfig(): QuickStartConfigEntry[] {
  return getQuickStartConfigState().items;
}

export function getQuickStartConfigState(): QuickStartConfigState {
  const raw = clientConfig.getServerValue('commander.quick_start');
  if (raw !== undefined) {
    const serverItems = normalizeQuickStartConfig(raw);
    if (serverItems) {
      lastInvalidQuickStartConfigHash = '';
      return {
        items: serverItems.map((entry) => ({ ...entry })),
        source: 'server_config',
      };
    }
    const cache = clientConfig.readCache();
    const configHash = String(cache.config_hash || 'server-config-without-hash');
    if (lastInvalidQuickStartConfigHash !== configHash) {
      lastInvalidQuickStartConfigHash = configHash;
      log.warn('invalid Commander quick-start config; using open defaults', {
        config_hash: cache.config_hash || '',
      });
    }
  }
  return {
    items: DEFAULT_QUICK_START_CONFIG.map((entry) => ({ ...entry })),
    source: 'pc_default',
  };
}

export function getRetryErrorPolicyConfig(): RetryErrorPolicyConfig {
  const fallback = cloneRetryErrorPolicyConfig(DEFAULT_RETRY_ERROR_POLICY);
  return mergeRetryErrorPolicyConfig(
    DEFAULT_RETRY_ERROR_POLICY,
    clientConfig.get('model.retry_error_policy', fallback),
  );
}
