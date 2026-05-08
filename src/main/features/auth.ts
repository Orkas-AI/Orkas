/**
 * Auth — LLM provider credentials + ordered (provider, model, credential)
 * priority list.
 *
 * Data model (v3)
 * ───────────────
 * Two layers of storage, both under `data/config/`:
 *
 *   auth-profiles.json   ← credentials + priority list:
 *     {
 *       version: 4,
 *       profiles: { "<provider>:<label>": { type, ...credential, ...meta } },
 *       entries:  [ { entryId, provider, model, profileId, lastUsed, createdAt } ],
 *       searchProfiles: [ { id, provider, apiKey, label, createdAt, extras? } ],   // v4+
 *       imageProfiles:  [ { id, provider, apiKey, label, createdAt } ]              // v4+
 *     }
 *
 * Forward/backward compat:
 *   - v3 readers see v4 files: `searchProfiles` / `imageProfiles` are
 *     unknown fields and ignored harmlessly.
 *   - v4 readers see v3 files: missing fields default to `[]`.
 *   No destructive migration needed.
 *
 * Entries list = user-controlled priority order.
 *   - First entry is the default model for chat.
 *   - Fallback order follows display order (drag to reorder).
 *   - Multiple entries with the same (provider, model) form an implicit
 *     rotation pool: when picking, pick the oldest-used one in that group
 *     so requests spread across API keys.
 *
 * Pick algorithm (pickChatEntry / pickChatEntryGroup)
 *   1. Walk entries top-to-bottom.
 *   2. Group consecutive entries by (provider, model): the first group hit
 *      is the "primary" model; entries in that group round-robin by
 *      lastUsed (oldest picked first).
 *   3. For each candidate, check credential is usable:
 *        - api_key:  key is present, profile not in cooldown
 *        - oauth:    access token not expired, OR refresh succeeds
 *      If unusable, try the next candidate in the group, then the next
 *      group.
 *   4. Bump lastUsed on the chosen entry.
 *
 * Cooldown (`model/core-agent/profile-cooldown.ts`)
 *   A profile that fails with a key-specific error (401 / 403 / 429 / 402;
 *   see `model/core-agent/auth-error.ts::classifyKeyFailure`) is parked in
 *   an in-memory cooldown map for 10 minutes. `pickChatEntry` /
 *   `pickChatEntryGroup` skip cooled-down profiles; `addApiKey` and
 *   successful `testConnection` clear the cooldown so user intervention
 *   always wins over auto-cooldown.
 *
 * OAuth flow (startOAuth / pollOAuthFlow / submitOAuthInput / cancel)
 *   unchanged from v2; see below.
 */

import * as fs from 'node:fs';
import { shell } from 'electron';

import { userAuthProfilesFile, userLocalConfigDir } from '../paths';
import { getActiveUserId } from './users';
import {
  FEATURED_API_PROVIDERS,
  OAUTH_PROVIDERS,
  OAUTH_ALIAS_FOR,
  VISIBLE_PROVIDERS,
  EXTERNAL_API_PROVIDERS,
  isVisibleProvider,
  curatedModelsFor,
  pickLatestGenerations,
  providerLabel,
  providerDocsUrl,
  providerSubscriptionNote,
  providerRecommended,
  sortProviderIds,
} from '../model/provider_catalog';
import { isCooledDown, clearCooldown } from '../model/core-agent/profile-cooldown';
import { createLogger } from '../logger';
import { t } from '../i18n';

const log = createLogger('auth');

// ── core-agent lazy loader ───────────────────────────────────────────────
type CoreAgentModule = typeof import('#core-agent');
let _caPromise: Promise<CoreAgentModule> | null = null;
function ca(): Promise<CoreAgentModule> {
  if (!_caPromise) {
    _caPromise = (import('#core-agent') as Promise<CoreAgentModule>).catch((e) => {
      _caPromise = null; // allow retry on next call
      throw e;
    });
  }
  return _caPromise;
}

/** Lazy loader for pi-ai's OAuth providers (anthropic, openai-codex, etc.).
 *  On first load we also register our custom providers (MiniMax Portal).
 *  Idempotent — pi-ai's registry is id-keyed. */
type PiOauthModule = typeof import('@mariozechner/pi-ai/oauth');
let _oauthPromise: Promise<PiOauthModule> | null = null;
function piOauth(): Promise<PiOauthModule> {
  if (!_oauthPromise) {
    _oauthPromise = (async () => {
      const mod = await import('@mariozechner/pi-ai/oauth');
      try {
        const { registerMinimaxOAuthProviders } = await import('./oauth-minimax');
        await registerMinimaxOAuthProviders();
      } catch (err) {
        // 失败不 swallow：把信息同时塞进 log + 缓存里的模块对象，让后续
        // listProviders / startOAuth 都能看到"MiniMax 没注册成功"并给出
        // 明确提示，而不是用户点了 OAuth 才撞到 "does not support OAuth"。
        const msg = (err as Error)?.message || String(err);
        log.warn('failed to register custom OAuth providers:', msg);
        _minimaxRegisterError = msg;
      }
      return mod;
    })();
  }
  return _oauthPromise;
}

/** 最近一次 MiniMax 注册失败原因；供 startOAuth 给用户兜底提示。 */
let _minimaxRegisterError: string | null = null;

/**
 * Prime the dynamic-import caches (`ca()` + `piOauth()`) on app boot so the
 * first open of the settings page doesn't eat the 1-2s cold-start latency
 * of loading core-agent + pi-ai's OAuth module. Idempotent; safe to call
 * multiple times. Errors are swallowed — a failure here is recoverable
 * (listProviders has its own fallback path).
 */
export async function warmup(): Promise<void> {
  try { await Promise.all([ca(), piOauth()]); }
  catch (err) { log.debug('warmup skipped:', (err as Error).message); }
}

// ── File paths ───────────────────────────────────────────────────────────
function profilesFile(): string { return userAuthProfilesFile(getActiveUserId()); }
function authDir(): string { return userLocalConfigDir(getActiveUserId()); }

// Legacy compat for tests/callers that expect this shape.
export const FEATURED_PROVIDERS: readonly string[] =
  FEATURED_API_PROVIDERS.map((p) => p.id);

// ── Key masking ──────────────────────────────────────────────────────────
export function maskKey(key: unknown): string {
  if (!key || typeof key !== 'string') return '';
  const k = key.trim();
  if (k.length <= 8) return '*'.repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ── Types ────────────────────────────────────────────────────────────────

interface ApiKeyProfile {
  type: 'api_key';
  provider: string;
  label: string;
  key: string;
  email?: string;
  createdAt: number;
  lastUsed: number;
}
interface OAuthProfile {
  type: 'oauth';
  provider: string;
  label: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  createdAt: number;
  lastUsed: number;
  [extra: string]: unknown;
}
type StoredProfile = ApiKeyProfile | OAuthProfile;

interface Entry {
  entryId: string;
  provider: string;
  model: string;
  profileId: string;
  lastUsed: number;
  createdAt: number;
}

/**
 * Search-tool API key (one row per stored credential, in priority order).
 * Independent from chat `entries` — search providers are addressed by
 * `provider` only (no model concept). The first usable row wins; rest are
 * fallbacks if the primary fails.
 */
export interface SearchProfile {
  id: string;
  provider: string;          // tavily / serper / brave-search / baidu-ai-search / ...
  apiKey: string;
  label: string;
  createdAt: number;
  /** Provider-specific extras (e.g. baidu requires app id alongside key). */
  extras?: Record<string, string>;
}

/**
 * Image-generation API key. Same shape as SearchProfile but lives in its
 * own array — a chat key for openai is NOT auto-reused for images and vice
 * versa, since users may want to bill them separately.
 */
export interface ImageProfile {
  id: string;
  provider: string;          // openai / google / doubao / ...
  apiKey: string;
  label: string;
  createdAt: number;
}

interface ProfilesFile {
  /** v3 = chat profiles only. v4 adds searchProfiles / imageProfiles. */
  version: number;
  profiles: Record<string, StoredProfile>;
  entries: Entry[];
  searchProfiles?: SearchProfile[];
  imageProfiles?: ImageProfile[];
}

const PROFILES_FILE_VERSION = 4;

// ── Profiles store IO ────────────────────────────────────────────────────

function ensureAuthDir(): void {
  const d = authDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadProfiles(): ProfilesFile {
  try {
    const raw = fs.readFileSync(profilesFile(), 'utf-8');
    const data = JSON.parse(raw) as Partial<ProfilesFile>;
    if (data && typeof data === 'object' && data.profiles && typeof data.profiles === 'object') {
      const profiles: Record<string, StoredProfile> = {};
      for (const [id, p] of Object.entries(data.profiles)) {
        const prof = p as any;
        if (!prof || typeof prof !== 'object' || !prof.provider || !prof.type) continue;
        const label = prof.label || id.split(':').slice(1).join(':') || 'default';
        profiles[id] = {
          ...prof,
          label,
          createdAt: typeof prof.createdAt === 'number' ? prof.createdAt : Date.now(),
          lastUsed: typeof prof.lastUsed === 'number' ? prof.lastUsed : 0,
        } as StoredProfile;
      }
      const entries: Entry[] = Array.isArray(data.entries)
        ? data.entries
            .filter((e: any) => e && e.entryId && e.provider && e.model && e.profileId)
            .map((e: any) => ({
              entryId: String(e.entryId),
              provider: String(e.provider),
              model: String(e.model),
              profileId: String(e.profileId),
              lastUsed: typeof e.lastUsed === 'number' ? e.lastUsed : 0,
              createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
            }))
        : [];
      const searchProfiles = parseSearchProfilesArray((data as any).searchProfiles);
      const imageProfiles = parseImageProfilesArray((data as any).imageProfiles);
      return { version: PROFILES_FILE_VERSION, profiles, entries, searchProfiles, imageProfiles };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to load profiles store:', (err as Error).message);
    }
  }
  return { version: PROFILES_FILE_VERSION, profiles: {}, entries: [], searchProfiles: [], imageProfiles: [] };
}

function parseSearchProfilesArray(arr: unknown): SearchProfile[] {
  if (!Array.isArray(arr)) return [];
  const out: SearchProfile[] = [];
  for (const raw of arr) {
    const p = raw as any;
    if (!p || typeof p !== 'object' || !p.id || !p.provider || !p.apiKey) continue;
    out.push({
      id: String(p.id),
      provider: String(p.provider),
      apiKey: String(p.apiKey),
      label: String(p.label || 'default'),
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      extras: p.extras && typeof p.extras === 'object'
        ? Object.fromEntries(Object.entries(p.extras).map(([k, v]) => [String(k), String(v)]))
        : undefined,
    });
  }
  return out;
}

function parseImageProfilesArray(arr: unknown): ImageProfile[] {
  if (!Array.isArray(arr)) return [];
  const out: ImageProfile[] = [];
  for (const raw of arr) {
    const p = raw as any;
    if (!p || typeof p !== 'object' || !p.id || !p.provider || !p.apiKey) continue;
    out.push({
      id: String(p.id),
      provider: String(p.provider),
      apiKey: String(p.apiKey),
      label: String(p.label || 'default'),
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
    });
  }
  return out;
}

// ── Search / Image profiles store IO (low-level) ─────────────────────────
//
// These helpers expose the new top-level fields so feature modules
// (`features/search_auth.ts`, `features/image_auth.ts`) can manage them
// without re-implementing the load/save round-trip. Live in auth.ts so
// the entire `auth-profiles.json` file has a single owner.

export function loadSearchProfiles(): SearchProfile[] {
  return loadProfiles().searchProfiles || [];
}

export function saveSearchProfiles(list: SearchProfile[]): void {
  const store = loadProfiles();
  store.searchProfiles = [...list];
  saveProfiles(store);
}

export function loadImageProfiles(): ImageProfile[] {
  return loadProfiles().imageProfiles || [];
}

export function saveImageProfiles(list: ImageProfile[]): void {
  const store = loadProfiles();
  store.imageProfiles = [...list];
  saveProfiles(store);
}

function saveProfiles(store: ProfilesFile): void {
  ensureAuthDir();
  fs.writeFileSync(profilesFile(), JSON.stringify(store, null, 2), 'utf-8');
}

function makeProfileId(provider: string, label: string): string {
  return `${provider}:${label}`;
}

function autoLabel(store: ProfilesFile, provider: string): string {
  const existing = Object.keys(store.profiles)
    .filter((id) => id.startsWith(provider + ':'))
    .map((id) => id.slice(provider.length + 1));
  if (!existing.includes('default')) return 'default';
  for (let i = 2; i < 100; i++) {
    const candidate = `account${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `account-${Date.now()}`;
}

function sanitizeLabel(input: string): string {
  const clean = String(input || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '-').slice(0, 40);
  return clean || 'default';
}

let _entryCounter = 0;
function nextEntryId(): string {
  _entryCounter = (_entryCounter + 1) % 100000;
  return `e-${Date.now().toString(36)}-${_entryCounter}`;
}

// ── Configured-model probe ───────────────────────────────────────────────

export interface AuthConfig { provider: string; model: string }

/**
 * True when the user has at least one saved (provider, model, credential)
 * entry, OR the dev-only `ANTHROPIC_API_KEY` env-var fallback is set. Any
 * LLM-driven feature should treat `configured === false` as "disabled
 * pending setup" and redirect the user to the settings page.
 */
export function hasConfiguredModel(): { configured: boolean } {
  const store = loadProfiles();
  if (store.entries.length > 0) return { configured: true };
  if (process.env.ANTHROPIC_API_KEY) return { configured: true };
  return { configured: false };
}

export async function getConfig(): Promise<AuthConfig> {
  // Default (provider, model) pair is `entries[0]` — the top of the priority
  // list. Credentials + model selection share one source of truth
  // (auth-profiles.json); there's no longer a fallback config.json.
  const store = loadProfiles();
  const first = store.entries[0];
  if (first) return { provider: first.provider, model: first.model };
  return { provider: '', model: '' };
}

function invalidateCoreAgentRunner(): void {
  try {
    const key = require.resolve('../model/core-agent/runner');
    const mod = require.cache[key];
    if (mod && typeof (mod.exports as any)?.invalidateConfig === 'function') {
      (mod.exports as any).invalidateConfig();
    }
  } catch { /* module not loaded — no-op */ }
}

// ── Provider + credential listing ────────────────────────────────────────

export interface ProfileView {
  profileId: string;
  provider: string;
  label: string;
  type: 'api_key' | 'oauth';
  masked?: string;
  email?: string;
  expired?: boolean;
  createdAt: number;
  lastUsed: number;
}

export interface ProviderEntry {
  id: string;
  label: string;
  featured: boolean;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  /** If OAuth on this provider actually logs in via a different pi-ai
   *  provider (e.g. `openai` → `openai-codex`), this carries the target id
   *  so the renderer can call `startOAuth(oauthProvider)` accordingly. */
  oauthProvider?: string;
  docsUrl?: string;
  /** Per-provider prerequisite note (see `CatalogEntry.subscriptionNote`).
   *  Renderer shows it as a warning-tinted hint on the card + the add-key
   *  form so users can verify they have the right kind of account. */
  subscriptionNote?: string;
  /** Cosmetic hint — renderer appends a "(推荐 / Recommended)" suffix on the
   *  picker label. Source of truth is `CatalogEntry.recommended`. */
  recommended?: boolean;
  profiles: ProfileView[];
}

function profileToView(id: string, p: StoredProfile): ProfileView {
  const base = {
    profileId: id,
    provider: p.provider,
    label: p.label,
    type: p.type,
    email: p.email,
    createdAt: p.createdAt,
    lastUsed: p.lastUsed,
  };
  if (p.type === 'api_key') return { ...base, type: 'api_key', masked: maskKey(p.key) };
  return { ...base, type: 'oauth', expired: Date.now() >= p.expires };
}

/**
 * Provider catalog for the settings dropdown.
 *
 * The visible set is `VISIBLE_PROVIDERS` plus any provider for which the
 * user already has a saved profile (so nothing disappears mid-session).
 * OAuth-only backends like `openai-codex` are hidden and reached via the
 * `oauthProvider` field on their API-key-facing sibling.
 */
export async function listProviders(): Promise<{ providers: ProviderEntry[] }> {
  let mod: CoreAgentModule | null = null;
  try { mod = await ca(); } catch (e) {
    log.warn('core-agent unavailable for listProviders; falling back to static catalog', { error: (e as Error).message });
  }
  // OAuth 能力来源 = pi-ai 运行时注册表。自定义 provider（如 MiniMax
  // Portal）由 `piOauth()` 启动时同步注册完毕；若注册失败会在日志打 warn。
  // `OAUTH_PROVIDERS` 常量只在 pi-ai 整个 oauth 模块加载失败时做兜底，
  // 不做 UNION —— 否则会在 UI 上显示根本无法走通的 OAuth 按钮。
  let oauthIds: Set<string>;
  try {
    const oauth = await piOauth();
    oauthIds = new Set(oauth.getOAuthProviders().map((p: any) => p.id));
  } catch {
    oauthIds = new Set(OAUTH_PROVIDERS.map((p) => p.id));
  }

  const store = loadProfiles();
  const byProvider = new Map<string, ProfileView[]>();
  for (const [id, prof] of Object.entries(store.profiles)) {
    const list = byProvider.get(prof.provider) || [];
    list.push(profileToView(id, prof));
    byProvider.set(prof.provider, list);
  }

  // OAuth 别名合并：把挂在 OAuth 后端下的 profile 折叠到父级 provider 的卡片
  // 上，这样用户在"MiniMax"卡上通过 OAuth 登录后，拿到的 profile 就展示在
  // 同一张卡片里（而不是突然又冒出一张"MiniMax 订阅 (CN)"卡）。
  for (const [parent, alias] of Object.entries(OAUTH_ALIAS_FOR)) {
    const aliasProfiles = byProvider.get(alias);
    if (aliasProfiles && aliasProfiles.length) {
      const merged = (byProvider.get(parent) || []).concat(aliasProfiles);
      byProvider.set(parent, merged);
      byProvider.delete(alias);
    }
  }

  // Visible set: whitelist + providers with saved profiles.
  const visible = new Set<string>(VISIBLE_PROVIDERS);
  for (const pid of byProvider.keys()) visible.add(pid);
  // Hide pi-ai providers that exist only as the OAuth back-end for
  // something in the whitelist (e.g. minimax-portal-cn is reached through
  // minimax-cn), unless the user already has a profile there that wasn't
  // captured by the alias merge above.
  for (const alias of Object.values(OAUTH_ALIAS_FOR)) {
    if (!byProvider.has(alias)) visible.delete(alias);
  }

  const sorted = sortProviderIds([...visible]);
  const featuredIds = new Set(FEATURED_API_PROVIDERS.map((p) => p.id));
  // Provider-is-known-to-pi-ai check so we don't advertise API-key support
  // for an id that pi-ai can't build a client for. When core-agent is
  // unavailable, fall back to the visible set so the catalog still renders.
  // EXTERNAL_API_PROVIDERS are Orkas-side adapters (see `external-providers.ts`)
  // that pi-ai doesn't know about — manually mark them api-capable.
  const apiCapable = mod
    ? new Set<string>([...mod.listPiProviders(), ...EXTERNAL_API_PROVIDERS])
    : new Set<string>([...visible, ...EXTERNAL_API_PROVIDERS]);

  // OAuth-only providers (ChatGPT Codex, Gemini Code Assist, GitHub Copilot,
  // Google Antigravity) can't be authenticated with a raw API key — their
  // endpoints only accept OAuth access tokens. Force the API-key tile off.
  const oauthOnlyIds = new Set(['openai-codex', 'google-gemini-cli', 'google-antigravity', 'github-copilot']);

  const providers: ProviderEntry[] = sorted.map((id) => {
    const directOAuth = oauthIds.has(id);
    const aliasOAuth  = OAUTH_ALIAS_FOR[id];
    const supportsOAuth = directOAuth || (!!aliasOAuth && oauthIds.has(aliasOAuth));
    const supportsApiKey = apiCapable.has(id) && !oauthOnlyIds.has(id);
    return {
      id,
      label: providerLabel(id),
      featured: featuredIds.has(id),
      supportsApiKey,
      supportsOAuth,
      oauthProvider: directOAuth ? id : (supportsOAuth ? aliasOAuth : undefined),
      docsUrl: providerDocsUrl(id),
      subscriptionNote: providerSubscriptionNote(id),
      recommended: providerRecommended(id),
      profiles: (byProvider.get(id) || []).sort((a, b) => a.label.localeCompare(b.label)),
    };
  });

  return { providers };
}

/**
 * Model list for a provider.
 *
 * Source priority:
 *   1. Hand-curated list in `provider_catalog.ts::CURATED_MODELS`
 *      (the sole file to edit when adding/removing models).
 *   2. Fallback: `pickLatestGenerations()` derives the last 2 (major,
 *      minor) version bands from pi-ai's raw list. Only used for
 *      uncurated providers.
 */
export async function listModels(providerId: string): Promise<{ models: { id: string; name: string }[] }> {
  const id = String(providerId || '').trim();
  if (!id) return { models: [] };
  const curated = curatedModelsFor(id);
  if (curated.length) return { models: curated };
  try {
    const mod = await ca();
    const raw = mod.listPiModels(id) || [];
    return { models: pickLatestGenerations(raw as any[], 2) };
  } catch {
    return { models: [] };
  }
}

// ── Credential writes ────────────────────────────────────────────────────

export async function addApiKey(
  providerId: string,
  apiKey: string,
  label?: string,
): Promise<{ profileId: string }> {
  const id = String(providerId || '').trim();
  const key = String(apiKey || '').trim();
  if (!id) throw new Error('provider required');
  if (!key) throw new Error('api key required');

  const store = loadProfiles();
  const chosenLabel = label ? sanitizeLabel(label) : autoLabel(store, id);
  const profileId = makeProfileId(id, chosenLabel);
  const now = Date.now();
  const existing = store.profiles[profileId];
  store.profiles[profileId] = {
    type: 'api_key',
    provider: id,
    label: chosenLabel,
    key,
    email: (existing as ApiKeyProfile | undefined)?.email,
    createdAt: existing?.createdAt ?? now,
    lastUsed: 0,
  };
  saveProfiles(store);
  // User updated the key — their manual intervention overrides any auto
  // cooldown from a past failure. Clear it so the next chat request
  // actually tries this profile again instead of skipping it.
  clearCooldown(profileId);
  invalidateCoreAgentRunner();
  return { profileId };
}

export async function removeCredential(profileId: string): Promise<{ removed: boolean }> {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('profileId required');
  const store = loadProfiles();
  if (!store.profiles[id]) return { removed: false };
  delete store.profiles[id];
  // Cascade: any entry referencing this profile is now dangling; drop those
  // entries too so the priority list doesn't silently skip a hole.
  store.entries = store.entries.filter((e) => e.profileId !== id);
  saveProfiles(store);
  invalidateCoreAgentRunner();
  return { removed: true };
}

export async function renameProfile(
  profileId: string,
  newLabel: string,
): Promise<{ profileId: string }> {
  const id = String(profileId || '').trim();
  const label = sanitizeLabel(newLabel);
  if (!id) throw new Error('profileId required');
  const store = loadProfiles();
  const prof = store.profiles[id];
  if (!prof) throw new Error('profile not found');
  const newId = makeProfileId(prof.provider, label);
  if (newId === id) return { profileId: id };
  if (store.profiles[newId]) throw new Error(`label "${label}" already used for this provider`);
  delete store.profiles[id];
  store.profiles[newId] = { ...prof, label };
  // Update any entries referencing the old profile id.
  store.entries = store.entries.map((e) => e.profileId === id ? { ...e, profileId: newId } : e);
  saveProfiles(store);
  invalidateCoreAgentRunner();
  return { profileId: newId };
}

// ── Entries (priority list) ──────────────────────────────────────────────

export interface EntryView {
  entryId: string;
  provider: string;
  providerLabel: string;
  model: string;
  modelName: string;
  profileId: string;
  profileLabel: string;
  profileType: 'api_key' | 'oauth';
  profileMasked?: string;
  oauthExpired?: boolean;
  createdAt: number;
  lastUsed: number;
}

function entryToView(e: Entry, store: ProfilesFile, modelNameLookup: (p: string, m: string) => string): EntryView {
  const prof = store.profiles[e.profileId];
  const base = {
    entryId: e.entryId,
    provider: e.provider,
    providerLabel: providerLabel(e.provider),
    model: e.model,
    modelName: modelNameLookup(e.provider, e.model),
    profileId: e.profileId,
    profileLabel: prof?.label || e.profileId.split(':').slice(1).join(':') || '(missing)',
    profileType: (prof?.type as 'api_key' | 'oauth') || 'api_key',
    createdAt: e.createdAt,
    lastUsed: e.lastUsed,
  };
  if (prof?.type === 'api_key') return { ...base, profileMasked: maskKey(prof.key) };
  if (prof?.type === 'oauth')  return { ...base, oauthExpired: Date.now() >= prof.expires };
  return base;
}

/** Build a pi-ai-backed (provider, modelId) → name lookup. Cached per call. */
async function buildModelNameLookup(): Promise<(p: string, m: string) => string> {
  let mod: CoreAgentModule | undefined;
  try { mod = await ca(); } catch { /* no pi-ai available */ }
  const cache = new Map<string, Map<string, string>>();
  return (provider: string, modelId: string) => {
    if (!mod) return modelId;
    let byId = cache.get(provider);
    if (!byId) {
      byId = new Map();
      try {
        for (const m of (mod.listPiModels(provider) || []) as any[]) {
          if (m && typeof m.id === 'string') byId.set(m.id, (m.name as string) || m.id);
        }
      } catch { /* fall through */ }
      cache.set(provider, byId);
    }
    return byId.get(modelId) || modelId;
  };
}

export async function listEntries(): Promise<{ entries: EntryView[] }> {
  const store = loadProfiles();
  const lookup = await buildModelNameLookup();
  return { entries: store.entries.map((e) => entryToView(e, store, lookup)) };
}

export async function addEntry({
  provider,
  model,
  profileId,
}: { provider: string; model: string; profileId: string }): Promise<{ entryId: string }> {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  const pid = String(profileId || '').trim();
  if (!p || !m || !pid) throw new Error('provider / model / profileId required');
  const store = loadProfiles();
  if (!store.profiles[pid]) throw new Error('profile not found');
  if (store.profiles[pid].provider !== p) throw new Error('profile does not belong to provider');

  // Deduplicate: if an entry with the same (provider, model, profileId)
  // already exists, don't create a second one. Returning the existing id
  // keeps the UI idempotent under double-click.
  const existing = store.entries.find((e) => e.provider === p && e.model === m && e.profileId === pid);
  if (existing) return { entryId: existing.entryId };

  const entryId = nextEntryId();
  const now = Date.now();
  store.entries.push({
    entryId,
    provider: p,
    model: m,
    profileId: pid,
    lastUsed: 0,
    createdAt: now,
  });
  saveProfiles(store);
  invalidateCoreAgentRunner();
  return { entryId };
}

export async function updateEntryModel(entryId: string, model: string): Promise<{ entryId: string; model: string }> {
  const id = String(entryId || '').trim();
  const m = String(model || '').trim();
  if (!id || !m) throw new Error('entryId and model required');
  const store = loadProfiles();
  const target = store.entries.find((e) => e.entryId === id);
  if (!target) throw new Error('entry not found');
  // Deduplicate: if another entry with the same (provider, model, profileId)
  // already exists, removing the target makes the priority list cleaner.
  const collision = store.entries.find(
    (e) => e.entryId !== id && e.provider === target.provider && e.model === m && e.profileId === target.profileId,
  );
  if (collision) throw new Error('same (provider, model, profile) entry already exists');
  target.model = m;
  saveProfiles(store);
  invalidateCoreAgentRunner();
  return { entryId: id, model: m };
}

export async function removeEntry(entryId: string): Promise<{ removed: boolean }> {
  const id = String(entryId || '').trim();
  if (!id) throw new Error('entryId required');
  const store = loadProfiles();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.entryId !== id);
  if (store.entries.length === before) return { removed: false };
  saveProfiles(store);
  invalidateCoreAgentRunner();
  return { removed: true };
}

export async function reorderEntries(orderedIds: string[]): Promise<{ entries: EntryView[] }> {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const store = loadProfiles();
  const byId = new Map(store.entries.map((e) => [e.entryId, e]));
  const reordered: Entry[] = [];
  for (const id of orderedIds) {
    const e = byId.get(String(id));
    if (e) { reordered.push(e); byId.delete(String(id)); }
  }
  // Anything the caller forgot — append in original order so we never drop.
  for (const e of store.entries) {
    if (byId.has(e.entryId)) reordered.push(e);
  }
  store.entries = reordered;
  saveProfiles(store);
  invalidateCoreAgentRunner();
  const lookup = await buildModelNameLookup();
  return { entries: store.entries.map((e) => entryToView(e, store, lookup)) };
}

// ── OAuth flow orchestration ─────────────────────────────────────────────

interface FlowPrompt { message: string; placeholder?: string; allowEmpty?: boolean }

type FlowStatus =
  | { kind: 'starting' }
  | { kind: 'awaiting_auth'; url: string; instructions?: string; usesCallbackServer?: boolean }
  | { kind: 'awaiting_input'; prompt: FlowPrompt }
  | { kind: 'progress'; message: string }
  | { kind: 'done'; profileId: string }
  | { kind: 'error'; error: string };

interface Flow {
  flowId: string;
  provider: string;
  label: string;
  status: FlowStatus;
  /** Resolves pi-ai's late-stage `onPrompt` (server never received a callback). */
  pendingInputResolver?: (value: string) => void;
  /** Resolves pi-ai's early-stage `onManualCodeInput` race — raced against the
   *  browser-callback server. Lets users either authorize in the browser OR
   *  paste the code, whichever they prefer. */
  manualInputResolver?: (value: string) => void;
  abortController: AbortController;
}

const flows = new Map<string, Flow>();
let _flowCounter = 0;

function nextFlowId(): string {
  _flowCounter = (_flowCounter + 1) % 100000;
  return `oauth-${Date.now().toString(36)}-${_flowCounter}`;
}

/**
 * Try to extract a user-friendly label from OAuth credentials.
 *
 * Precedence (first non-empty wins):
 *   1. Credential `email` field, if provider populates it (local-part only).
 *   2. JWT payload `email` / `https://api.openai.com/profile.email`
 *      (OpenAI Codex tokens carry this).
 *   3. `accountId` prefix (first 8 chars).
 *
 * Returns '' when nothing usable is found; caller falls back to autoLabel().
 */
function deriveOAuthLabel(creds: Record<string, unknown>): string {
  const directEmail = (creds as any).email;
  if (typeof directEmail === 'string' && directEmail.includes('@')) {
    return directEmail.split('@')[0];
  }
  const access = (creds as any).access;
  if (typeof access === 'string') {
    try {
      const parts = access.split('.');
      if (parts.length >= 2) {
        const padded = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
        const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        const profile = payload?.['https://api.openai.com/profile'];
        const email = profile?.email || payload?.email;
        if (typeof email === 'string' && email.includes('@')) {
          return email.split('@')[0];
        }
      }
    } catch { /* token wasn't a readable JWT */ }
  }
  const accountId = (creds as any).accountId;
  if (typeof accountId === 'string' && accountId.length) {
    return accountId.slice(0, 8);
  }
  return '';
}

/**
 * Open a URL in the user's default browser. Uses the platform-native
 * handler (`open` / `start` / `xdg-open`) instead of Electron's BrowserWindow
 * so the OAuth consent page renders in the user's real browser, where they
 * are already logged in and where extensions work.
 */
export function openExternalUrl(url: string): { ok: boolean; error?: string } {
  const target = String(url || '').trim();
  if (!target) return { ok: false, error: 'url required' };
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'url must be http(s)' };
  // Electron 的 shell.openExternal 是跨平台的官方 API：macOS 走 open(1)、
  // Windows 走 ShellExecuteW、Linux 走 xdg-open —— 替代了以前自己拼 shell
  // 命令（Windows cmd 的 `start "" "url"` 引号嵌套在 exec() 下容易崩）。
  shell.openExternal(target).catch((err: unknown) => {
    log.warn('openExternal failed:', (err as Error)?.message || String(err));
  });
  return { ok: true };
}

export async function startOAuth(
  providerId: string,
  label?: string,
): Promise<{ flowId: string; status: FlowStatus }> {
  const id = String(providerId || '').trim();
  if (!id) throw new Error('provider required');
  const oauth = await piOauth();
  const provider = oauth.getOAuthProvider(id as any);
  if (!provider) {
    const hint = _minimaxRegisterError && id.startsWith('minimax-portal')
      ? t('oauth.minimax.register_error_hint', { message: _minimaxRegisterError })
      : '';
    throw new Error(`provider "${id}" does not support OAuth${hint}`);
  }

  const flowId = nextFlowId();
  const chosenLabel = label ? sanitizeLabel(label) : autoLabel(loadProfiles(), id);
  // Device-code style flows (MiniMax) don't bind a local port — the UI must
  // hide its "paste callback URL" input in that case.
  const usesCallbackServer = provider.usesCallbackServer !== false;
  const flow: Flow = {
    flowId,
    provider: id,
    label: chosenLabel,
    status: { kind: 'starting' },
    abortController: new AbortController(),
  };
  flows.set(flowId, flow);

  provider
    .login({
      signal: flow.abortController.signal,
      onAuth: (info) => {
        flow.status = {
          kind: 'awaiting_auth',
          url: info.url,
          instructions: info.instructions,
          usesCallbackServer,
        };
        // Auto-open the user's system default browser. If this fails the
        // renderer still shows the URL + 复制链接 button as a fallback.
        openExternalUrl(info.url);
      },
      onPrompt: async (prompt) => {
        flow.status = {
          kind: 'awaiting_input',
          prompt: {
            message: prompt.message,
            placeholder: prompt.placeholder,
            allowEmpty: prompt.allowEmpty,
          },
        };
        return new Promise<string>((resolve) => {
          flow.pendingInputResolver = (val) => {
            flow.pendingInputResolver = undefined;
            resolve(val);
          };
        });
      },
      // Race the browser-callback server against a manual-paste input. Two
      // benefits:
      //   1. The "paste" text box shows up in the UI alongside the URL,
      //      so users who run into a redirect problem (wrong browser,
      //      corporate proxy, stale port) can still finish by pasting the
      //      redirect URL they see after authorizing.
      //   2. Gives us a cancel handle — resolving this promise on cancel
      //      lets pi-ai drain out of `server.waitForCode()` and reach the
      //      `finally { server.close() }` block, so port 1455 gets freed
      //      instead of leaking.
      onManualCodeInput: () => new Promise<string>((resolve) => {
        flow.manualInputResolver = (val) => {
          flow.manualInputResolver = undefined;
          resolve(val);
        };
      }),
      onProgress: (message) => {
        flow.status = { kind: 'progress', message };
      },
    })
    .then((credentials) => {
      const store = loadProfiles();
      // Prefer a human-identifiable label from the token if the caller
      // didn't supply one — email local-part, then accountId prefix —
      // so multi-account rows don't all read "default".
      const derived = !label ? deriveOAuthLabel(credentials) : '';
      let finalLabel = derived ? sanitizeLabel(derived) : chosenLabel;
      if (store.profiles[makeProfileId(id, finalLabel)]) {
        finalLabel = `${finalLabel}-${Date.now().toString(36).slice(-4)}`;
      }
      const pid = makeProfileId(id, finalLabel);
      const now = Date.now();
      store.profiles[pid] = {
        type: 'oauth',
        provider: id,
        label: finalLabel,
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        createdAt: now,
        lastUsed: 0,
        ...Object.fromEntries(
          Object.entries(credentials).filter(([k]) =>
            !['access', 'refresh', 'expires'].includes(k),
          ),
        ),
      };
      saveProfiles(store);
      invalidateCoreAgentRunner();
      flow.status = { kind: 'done', profileId: pid };
    })
    .catch((err: unknown) => {
      flow.status = { kind: 'error', error: (err as Error)?.message || String(err) };
    });

  return { flowId, status: flow.status };
}

export function pollOAuthFlow(flowId: string): { status: FlowStatus } {
  const flow = flows.get(flowId);
  if (!flow) return { status: { kind: 'error', error: 'unknown flow' } };
  return { status: flow.status };
}

export function submitOAuthInput(flowId: string, value: string): { ok: boolean } {
  const flow = flows.get(flowId);
  if (!flow) return { ok: false };
  const val = String(value ?? '');
  // Prefer the late-stage `onPrompt` resolver if active (bind failed), else
  // feed the early-stage `onManualCodeInput` race (bind succeeded — racing
  // against the browser callback).
  const resolver = flow.pendingInputResolver || flow.manualInputResolver;
  if (!resolver) return { ok: false };
  flow.status = { kind: 'progress', message: t('auth.progress.processing') };
  resolver(val);
  return { ok: true };
}

export function cancelOAuthFlow(flowId: string): { ok: boolean } {
  const flow = flows.get(flowId);
  if (!flow) return { ok: false };
  try { flow.abortController.abort(); } catch { /* noop */ }
  // Resolve both resolvers with empty string so pi-ai's flow drains out,
  // hits its `finally { server.close() }` and releases port 1455. Without
  // this a cancel mid-auth would leave the HTTP server bound and break
  // subsequent OAuth attempts.
  if (flow.pendingInputResolver) {
    try { flow.pendingInputResolver(''); } catch { /* noop */ }
  }
  if (flow.manualInputResolver) {
    try { flow.manualInputResolver(''); } catch { /* noop */ }
  }
  flow.status = { kind: 'error', error: 'cancelled' };
  setTimeout(() => flows.delete(flowId), 5000);
  return { ok: true };
}

// ── Chat entry picker (runner integration) ───────────────────────────────

export interface ChatEntryChoice {
  entryId: string;
  profileId: string;
  provider: string;
  model: string;
  apiKey: string;
}

/**
 * Group consecutive entries by `(provider, model)`. Dropped into a helper
 * so `pickChatEntry` (single winner) and `pickChatEntryGroup` (whole
 * group of candidates for rotation) share exactly the same grouping
 * semantics — including the "first group wins" priority rule.
 */
function groupEntries(entries: Entry[]): Entry[][] {
  const groups: Entry[][] = [];
  let current: Entry[] = [];
  let currentKey = '';
  for (const e of entries) {
    const key = `${e.provider}::${e.model}`;
    if (key !== currentKey) {
      if (current.length) groups.push(current);
      current = [e];
      currentKey = key;
    } else {
      current.push(e);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Resolve the usable `apiKey` for an entry (returns undefined if the
 * profile is gone, the OAuth token expired and refresh fails, etc.).
 */
async function resolveEntryApiKey(store: ProfilesFile, entry: Entry): Promise<string | undefined> {
  const prof = store.profiles[entry.profileId];
  if (!prof) return undefined;
  if (prof.type === 'api_key') return prof.key;
  if (Date.now() < prof.expires) return prof.access;
  try {
    return await refreshOAuthProfile(entry.profileId);
  } catch (err) {
    log.warn(`OAuth refresh failed for ${entry.profileId}:`, (err as Error).message);
    return undefined;
  }
}

// ── Api-key-only entry listing (broader-API features) ───────────────────
//
// Image generation, TTS, embeddings, file management, etc. are HTTP
// endpoints that sit on each provider's broader API surface — NOT the
// chat-completions endpoint that OAuth tokens are scoped to. None of the
// OAuth surfaces we ship (Anthropic Pro/Max, OpenAI Codex, Gemini CLI,
// Antigravity, MiniMax Portal, GitHub Copilot) can reach these endpoints,
// either because the token scope excludes them or because the provider's
// ToS forbids re-use outside the OAuth app's own surface.
//
// Callers that need such an endpoint use this helper to scan only the
// api-key entries, then match the provider against their own capability
// table (e.g. `provider_catalog.IMAGE_GEN_BY_PROVIDER`).

export interface ApiKeyEntryChoice {
  entryId: string;
  profileId: string;
  provider: string;
  /** The user's chat model on this entry — exposed so callers can log
   *  what entry they picked. NOT what the broader-API feature dispatches
   *  to (image gen has its own fixed model id, etc.). */
  model: string;
  apiKey: string;
}

export function listApiKeyEntries(): ApiKeyEntryChoice[] {
  const store = loadProfiles();
  const out: ApiKeyEntryChoice[] = [];
  for (const e of store.entries) {
    const prof = store.profiles[e.profileId];
    if (!prof || prof.type !== 'api_key') continue;
    out.push({
      entryId: e.entryId,
      profileId: e.profileId,
      provider: e.provider,
      model: e.model,
      apiKey: prof.key,
    });
  }
  return out;
}

/**
 * Bump `lastUsed` on a specific entry (re-reads the store to avoid
 * clobbering concurrent writes). Safe no-op if the entry disappeared.
 */
export function bumpEntryLastUsed(entryId: string): void {
  const fresh = loadProfiles();
  const target = fresh.entries.find((e) => e.entryId === entryId);
  if (target) {
    target.lastUsed = Date.now();
    saveProfiles(fresh);
  }
}

/**
 * Return the ordered list of usable entries for the current chat request.
 * Entry order = user-controlled drag order in the settings UI (entries[0]
 * is the primary, the rest are fallbacks). Rotation goes **across** the
 * entire list — not just within a `(provider, model)` group. Primary 401
 * can fall back to a completely different provider+model if that's how
 * the user arranged their list.
 *
 * Within a run of consecutive entries sharing the same `(provider, model)`
 * (often: multiple API keys for the same model), we still pre-order by
 * oldest `lastUsed` first so load spreads fairly — but we flatten the
 * ordered sub-lists back into a single stream so the rotating provider
 * sees one simple sequence.
 *
 * Skips:
 *   - entries whose profile was deleted
 *   - entries whose OAuth expired without a working refresh
 *   - entries in the cooldown map (`profile-cooldown.ts`)
 *
 * Returns `[]` when no entry at all is usable.
 *
 * Does NOT bump `lastUsed` — that's the caller's job (rotating-provider
 * bumps the winning candidate via `onSuccess`).
 */
export async function pickChatEntryGroup(): Promise<ChatEntryChoice[]> {
  const store = loadProfiles();
  if (store.entries.length === 0) return [];

  // Flatten: preserve entries[] order across groups, but within a
  // consecutive same-(provider, model) run, sort oldest lastUsed first.
  const groups = groupEntries(store.entries);
  const ordered: Entry[] = [];
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    for (const e of sorted) ordered.push(e);
  }

  const choices: ChatEntryChoice[] = [];
  for (const entry of ordered) {
    if (isCooledDown(entry.profileId)) {
      log.info(`skipping cooled-down profile ${entry.profileId}`);
      continue;
    }
    const apiKey = await resolveEntryApiKey(store, entry);
    if (!apiKey) continue;
    choices.push({
      entryId: entry.entryId,
      profileId: entry.profileId,
      provider: entry.provider,
      model: entry.model,
      apiKey,
    });
  }
  return choices;
}

/**
 * Pick the next chat entry respecting user priority. Thin wrapper over
 * `pickChatEntryGroup` that returns the top candidate (first group,
 * oldest-lastUsed first) and bumps `lastUsed` immediately. Callers that
 * want rotation (runner.ts's chat path) use `pickChatEntryGroup` directly;
 * callers that only need one key (testConnection with provider-only mode)
 * keep using this.
 *
 * Returns null if no group has a usable candidate.
 */
export async function pickChatEntry(): Promise<ChatEntryChoice | null> {
  const group = await pickChatEntryGroup();
  if (group.length === 0) return null;
  const chosen = group[0];
  bumpEntryLastUsed(chosen.entryId);
  return chosen;
}

/** Retained for one legacy caller (testConnection with a specific provider). */
export async function pickRotationKey(providerId: string): Promise<{
  profileId: string; provider: string; label: string; apiKey: string;
} | null> {
  const id = String(providerId || '').trim();
  if (!id) return null;
  const store = loadProfiles();
  const candidates = Object.entries(store.profiles)
    .filter(([, p]) => p.provider === id)
    .sort(([, a], [, b]) => (a.lastUsed || 0) - (b.lastUsed || 0));
  for (const [pid, prof] of candidates) {
    if (isCooledDown(pid)) {
      log.info(`skipping cooled-down profile ${pid}`);
      continue;
    }
    let apiKey: string | undefined;
    if (prof.type === 'api_key') apiKey = prof.key;
    else if (Date.now() < prof.expires) apiKey = prof.access;
    else apiKey = await refreshOAuthProfile(pid).catch(() => undefined);
    if (!apiKey) continue;
    const fresh = loadProfiles();
    const target = fresh.profiles[pid];
    if (target) { target.lastUsed = Date.now(); saveProfiles(fresh); }
    return { profileId: pid, provider: id, label: prof.label, apiKey };
  }
  return null;
}

async function refreshOAuthProfile(profileId: string): Promise<string | undefined> {
  const store = loadProfiles();
  const prof = store.profiles[profileId];
  if (!prof || prof.type !== 'oauth') return undefined;

  const oauth = await piOauth();
  const provider = oauth.getOAuthProvider(prof.provider);
  if (!provider) return undefined;

  const creds = {
    access: prof.access,
    refresh: prof.refresh,
    expires: prof.expires,
    ...Object.fromEntries(
      Object.entries(prof).filter(([k]) =>
        !['type', 'provider', 'label', 'createdAt', 'lastUsed', 'email', 'access', 'refresh', 'expires'].includes(k),
      ),
    ),
  };
  const newCreds = await provider.refreshToken(creds as any);
  const fresh = loadProfiles();
  const target = fresh.profiles[profileId];
  if (target && target.type === 'oauth') {
    target.access = newCreds.access;
    target.refresh = newCreds.refresh;
    target.expires = newCreds.expires;
    for (const [k, v] of Object.entries(newCreds)) {
      if (!['access', 'refresh', 'expires'].includes(k)) {
        (target as OAuthProfile)[k] = v;
      }
    }
    saveProfiles(fresh);
  }
  return provider.getApiKey(newCreds);
}

// ── Test connection ──────────────────────────────────────────────────────

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  durationMs?: number;
  model?: string;
  profileId?: string;
}

export async function testConnection(
  providerId: string,
  modelId?: string,
  profileId?: string,
): Promise<TestConnectionResult> {
  const mod = await ca();
  const pid = String(providerId || '').trim();
  if (!pid) return { ok: false, error: 'provider required' };

  let chosenProfileId: string | undefined = profileId;
  let apiKey: string | undefined;

  if (chosenProfileId) {
    const store = loadProfiles();
    const prof = store.profiles[chosenProfileId];
    if (!prof || prof.provider !== pid) return { ok: false, error: 'profile not found' };
    if (prof.type === 'api_key') apiKey = prof.key;
    else if (Date.now() < prof.expires) apiKey = prof.access;
    else apiKey = await refreshOAuthProfile(chosenProfileId).catch(() => undefined);
  } else {
    const choice = await pickRotationKey(pid);
    if (choice) { apiKey = choice.apiKey; chosenProfileId = choice.profileId; }
  }

  if (!apiKey) return { ok: false, error: 'no credential stored for this provider', profileId: chosenProfileId };

  // Orkas-side external providers bypass pi-ai's catalog — route directly
  // to their factory so we don't hit the "provider has no models registered"
  // guard below (which relies on pi-ai's listPiModels).
  if (EXTERNAL_API_PROVIDERS.includes(pid)) {
    const modelForTest = String(modelId || '').trim();
    const t0 = Date.now();
    try {
      const ext = await import('../model/core-agent/external-providers');
      let provider;
      let probeModel = modelForTest;
      if (pid === 'moonshot') {
        probeModel = probeModel || 'kimi-k2.5';
        provider = await ext.createMoonshotProvider({ apiKey, modelId: probeModel });
      } else if (pid === 'deepseek') {
        // Default probe = V4 Flash (cheaper than Pro; fine for a 1-token ping).
        probeModel = probeModel || 'deepseek-v4-flash';
        provider = await ext.createDeepSeekProvider({ apiKey, modelId: probeModel });
      } else if (pid === 'doubao') {
        // Default probe = Seed 2.0 Lite (cheaper than Pro).
        probeModel = probeModel || 'doubao-seed-2-0-lite-260215';
        provider = await ext.createDoubaoProvider({ apiKey, modelId: probeModel });
      } else {
        throw new Error(`external provider "${pid}" has no test-connection factory yet`);
      }
      const msg = await provider.complete({
        model: probeModel,
        systemPrompt: 'You are a connectivity probe; reply with a single word.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
      });
      if (chosenProfileId) clearCooldown(chosenProfileId);
      return { ok: true, durationMs: Date.now() - t0, model: msg.model || probeModel, profileId: chosenProfileId };
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      log.warn('testConnection failed (external provider)', {
        provider: pid,
        model: modelForTest,
        durationMs: Date.now() - t0,
        error: errMsg,
      });
      return {
        ok: false,
        error: errMsg,
        durationMs: Date.now() - t0,
        profileId: chosenProfileId,
      };
    }
  }

  // pi-ai's `getModel()` returns undefined (doesn't throw) for unknown model
  // IDs, which trips an NPE inside core-agent's `resolveModel`. Guard here
  // so we surface a clean "model not found" instead of "Cannot read
  // properties of undefined".
  const requestedModel = modelId ? String(modelId).trim() : '';
  let effectiveModel = requestedModel;
  try {
    const knownIds: string[] = ((mod as any).listPiModels(pid) || [])
      .map((m: any) => m && m.id)
      .filter((id: unknown): id is string => typeof id === 'string');
    if (requestedModel && !knownIds.includes(requestedModel)) {
      if (!knownIds.length) {
        return { ok: false, error: `provider "${pid}" has no models registered`, profileId: chosenProfileId };
      }
      effectiveModel = knownIds[0];
    }
  } catch { /* fall through — let pi-ai surface whatever it wants */ }

  const t0 = Date.now();
  try {
    const provider = mod.createPiProvider({
      provider: pid,
      model: effectiveModel || undefined,
      apiKey,
    });
    const msg = await provider.complete({
      model: effectiveModel,
      // ChatGPT Codex's `responses` API rejects requests without
      // `instructions` (= system prompt). Plain providers ignore it.
      systemPrompt: 'You are a connectivity probe; reply with a single word.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: 1,
    });
    if (chosenProfileId) clearCooldown(chosenProfileId);
    return { ok: true, durationMs: Date.now() - t0, model: msg.model || '', profileId: chosenProfileId };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || String(err),
      durationMs: Date.now() - t0,
      profileId: chosenProfileId,
    };
  }
}

// ── Legacy aliases ───────────────────────────────────────────────────────
export const saveApiKey = (providerId: string, apiKey: string, label?: string) =>
  addApiKey(providerId, apiKey, label);
