import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: loggerMocks.warn, error: vi.fn() }),
}));

// auth.ts has two layers:
//   - pure helpers (maskKey, FEATURED_PROVIDERS, getConfig, saveConfig)
//   - core-agent integration (listProviders, listModels, saveApiKey,
//     removeCredential, testConnection)
// Per test/README, the integration layer is out of scope for unit tests —
// it requires real provider credentials and network reach. We cover only
// the pure helpers + the local config file IO here.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '99999999';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auth-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  loggerMocks.warn.mockReset();
  // auth.ts goes through `getActiveUserId()` for every file path, so we
  // must pin an active uid before any dynamic import of auth-related modules.
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('@earendil-works/pi-ai/oauth');
  vi.doUnmock('#core-agent');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setDeepSeekEnabled(enabled: boolean): Promise<void> {
  const { clientConfig } = await import('../../../src/main/features/client_config');
  clientConfig.applyServerPayload({
    immediate: { 'model.deepseek.enabled': enabled },
    restart: {},
    config_hash: `sha256:deepseek-${enabled ? 'on' : 'off'}`,
  }, `"deepseek-${enabled ? 'on' : 'off'}"`);
}

async function writeExpiredOAuthEntry({
  providerId,
  model,
  uid = TEST_UID,
  expires = Date.now() - 1000,
  access = 'expired-access-token',
  refresh = 'expired-refresh-token',
}: {
  providerId: string;
  model: string;
  uid?: string;
  expires?: number;
  access?: string;
  refresh?: string;
}): Promise<void> {
  const paths = await import('../../../src/main/paths');
  const localSecrets = await import('../../../src/main/util/local-secret-store');
  const file = paths.userAuthProfilesFile(uid);
  const ctx = { namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' };
  const profileId = `${providerId}:default`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, localSecrets.encryptLocalSecret(ctx, JSON.stringify({
    version: 4,
    profiles: {
      [profileId]: {
        type: 'oauth',
        provider: providerId,
        label: 'default',
        access,
        refresh,
        expires,
        createdAt: 1,
        lastUsed: 0,
        accountId: 'acct-test',
      },
    },
    entries: [{
      entryId: `entry-${providerId}`,
      provider: providerId,
      model,
      profileId,
      createdAt: 1,
      lastUsed: 0,
    }],
    searchProfiles: [],
    imageProfiles: [],
    videoProfiles: [],
    ttsProfiles: [],
  })), 'utf8');
}

describe('auth › maskKey', () => {
  it('returns empty for non-string inputs', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey(null)).toBe('');
    expect(a.maskKey(undefined)).toBe('');
    expect(a.maskKey(123)).toBe('');
    expect(a.maskKey({})).toBe('');
    expect(a.maskKey('')).toBe('');
  });

  it('replaces short keys (≤ 8 chars) entirely with stars', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('abc')).toBe('***');
    expect(a.maskKey('12345678')).toBe('********');
  });

  it('keeps first-4 and last-4 chars for normal-length keys', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
    expect(a.maskKey('1234567890abcdef')).toBe('1234…cdef');
  });

  it('trims surrounding whitespace before masking', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('  sk-abcdefghijkl  ')).toBe('sk-a…ijkl');
  });
});

describe('auth › external navigation', () => {
  it('rejects non-http and credential-bearing URLs', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.openExternalUrl('javascript:alert(1)')).toEqual({
      ok: false,
      error: 'url must be a safe external link',
    });
    expect(a.openExternalUrl('https://user:password@example.com/')).toEqual({
      ok: false,
      error: 'url must be a safe external link',
    });
  });
});

describe('auth › FEATURED_PROVIDERS', () => {
  it('lists the curated API-key providers in CATALOG order', async () => {
    const a = await import('../../../src/main/features/auth');
    // API-key documentation follows the catalog while excluding OAuth-only entries.
    expect(a.FEATURED_PROVIDERS).toEqual([
      'orkas-api',
      'deepseek',
      'openai',
      'google',
      'anthropic',
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-cn',
      'doubao',
      'siliconflow',
      'openrouter',
    ]);
    // openai-codex / minimax-portal / minimax-portal-cn are oauthOnly and
    // excluded from the API-key docs list (FEATURED_PROVIDERS). They still
    // appear in CATALOG / VISIBLE_PROVIDERS.
  });
});

describe('auth › Orkas API quick setup', () => {
  it('configures all five public services idempotently with the documented model ids', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKeyEntry('anthropic', 'claude-opus-4-8', 'third-party-key-xxxxxxxx', 'work');

    expect(a.configureAllOrkasApiServices('  orkas-key-first-xxxxxxxx  ')).toEqual({ configured: true });
    a.saveImageProfiles(a.loadImageProfiles().map((profile) => (
      profile.provider === 'orkas-api' ? { ...profile, model: 'old-image-model' } : profile
    )));
    a.saveVideoProfiles(a.loadVideoProfiles().map((profile) => (
      profile.provider === 'orkas-api' ? { ...profile, model: 'old-video-model' } : profile
    )));
    a.saveTtsProfiles(a.loadTtsProfiles().map((profile) => (
      profile.provider === 'orkas-api'
        ? { ...profile, baseUrl: 'https://legacy.example/v1', model: 'old-tts-model' }
        : profile
    )));
    expect(a.configureAllOrkasApiServices('orkas-key-second-xxxxxxxx')).toEqual({ configured: true });

    const entries = (await a.listEntries({ includeUnavailable: true })).entries;
    expect(entries.filter((entry) => entry.provider === 'orkas-api')).toEqual([
      expect.objectContaining({
        model: 'orkas-llm-1.5',
        modelName: 'Orkas-1.5',
        official: true,
        profileLabel: 'Orkas',
        profileMasked: 'orka…xxxx',
        recommended: true,
        includedModels: ['DeepSeek V4.1 Flash', 'GPT-6 Luna', 'Claude-Sonnet-5', 'Gemini-3.8 Flash'],
      }),
      expect.objectContaining({
        model: 'orkas-llm-1.5-pro',
        modelName: 'Orkas-1.5 Pro',
        official: true,
        profileLabel: 'Orkas',
        profileMasked: 'orka…xxxx',
        includedModels: ['GPT-6.1 Sol', 'Claude Opus 5.5', 'Kimi K3'],
      }),
    ]);
    expect((await a.listComposerEntries()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'orkas-api',
          model: 'orkas-llm-1.5',
          modelName: 'Orkas-1.5',
          official: true,
        }),
        expect.objectContaining({
          provider: 'orkas-api',
          model: 'orkas-llm-1.5-pro',
          modelName: 'Orkas-1.5 Pro',
          official: true,
        }),
      ]),
    );
    expect(entries[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });

    expect(a.loadSearchProfiles().filter((profile) => profile.provider === 'orkas-api')).toHaveLength(1);
    expect(a.loadImageProfiles().filter((profile) => profile.provider === 'orkas-api')).toEqual([
      expect.objectContaining({ model: 'orkas-image' }),
    ]);
    expect(a.loadVideoProfiles().filter((profile) => profile.provider === 'orkas-api')).toEqual([
      expect.objectContaining({ model: 'orkas-video' }),
    ]);
    expect(a.loadTtsProfiles().filter((profile) => profile.provider === 'orkas-api')).toEqual([
      expect.objectContaining({
        baseUrl: 'https://orkas.ai/v1',
        model: 'orkas-tts-1',
        voice: 'zh_female_vv_uranus_bigtts',
      }),
    ]);

    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const raw = fs.readFileSync(file, 'utf8');
    expect(localSecrets.isEncryptedSecret(raw)).toBe(true);
    expect(raw).not.toContain('orkas-key-second-xxxxxxxx');
    const persisted = JSON.parse(localSecrets.decryptLocalSecret(
      { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' },
      raw,
      { legacySeeds: [TEST_UID] },
    ));
    const orkasKeys = [
      ...Object.values(persisted.profiles as Record<string, any>)
        .filter((profile: any) => profile.provider === 'orkas-api')
        .map((profile: any) => profile.key),
      ...persisted.searchProfiles.filter((profile: any) => profile.provider === 'orkas-api').map((profile: any) => profile.apiKey),
      ...persisted.imageProfiles.filter((profile: any) => profile.provider === 'orkas-api').map((profile: any) => profile.apiKey),
      ...persisted.videoProfiles.filter((profile: any) => profile.provider === 'orkas-api').map((profile: any) => profile.apiKey),
      ...persisted.ttsProfiles.filter((profile: any) => profile.provider === 'orkas-api').map((profile: any) => profile.apiKey),
    ];
    expect(new Set(orkasKeys)).toEqual(new Set(['orkas-key-second-xxxxxxxx']));
  });

});

describe('auth › multi-profile store (addApiKey / removeCredential / renameProfile)', () => {
  it('addApiKey creates a default-labelled profile for a new provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'sk-first-one-xxxxxxx');
    expect(profileId).toBe('anthropic:default');

    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles).toHaveLength(1);
    expect(anth.profiles[0].label).toBe('default');
    expect(anth.profiles[0].type).toBe('api_key');
    expect(anth.profiles[0].masked).toBe('sk-f…xxxx');
  });

  it('addApiKey generates unique auto-labels when default already exists', async () => {
    const a = await import('../../../src/main/features/auth');
    const r1 = await a.addApiKey('anthropic', 'key-1-xxxxxxxxxxxx');
    const r2 = await a.addApiKey('anthropic', 'key-2-xxxxxxxxxxxx');
    const r3 = await a.addApiKey('anthropic', 'key-3-xxxxxxxxxxxx');
    expect(r1.profileId).toBe('anthropic:default');
    expect(r2.profileId).toBe('anthropic:account2');
    expect(r3.profileId).toBe('anthropic:account3');
  });

  it('concurrent addApiKey for distinct providers persists every profile', async () => {
    // auth-profiles.json is read-modify-written. Today's impl is incidentally
    // safe because both load and save are sync fs calls (no await in the
    // critical section). This test guards against a future refactor to async
    // fs — the moment a real microtask boundary opens between read and write,
    // overlapping calls will silently lose profiles.
    const a = await import('../../../src/main/features/auth');
    const N = 8;
    const providers = Array.from({ length: N }, (_, i) => `prov${i}`);
    await Promise.all(providers.map((p) => a.addApiKey(p, `key-${p}-xxxxxxxx`)));
    const { providers: list } = await a.listProviders();
    const seen = new Set(list.map((p) => p.id));
    for (const p of providers) expect(seen.has(p)).toBe(true);
  });

  it('addApiKey with explicit label sanitises invalid characters', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('openai', 'key-xxxxxxxxxxxx', 'work @home/1');
    expect(profileId).toBe('openai:work--home-1');
  });

  it('stores auth-profiles with the local-secret facade', async () => {
    const a = await import('../../../src/main/features/auth');
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    await a.addApiKey('openai', 'sk-local-secret-xxxxxxxx');
    const raw = fs.readFileSync(paths.userAuthProfilesFile(TEST_UID), 'utf8');
    expect(localSecrets.isEncryptedSecret(raw)).toBe(true);
    expect(raw).not.toContain('sk-local-secret-xxxxxxxx');
  });

  it('migrates legacy crypto-vault auth-profiles on read', async () => {
    const paths = await import('../../../src/main/paths');
    const cryptoVault = await import('../../../src/main/util/crypto-vault');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cryptoVault.encrypt(TEST_UID, JSON.stringify({
      version: 4,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          label: 'default',
          key: 'sk-legacy-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [],
      searchProfiles: [],
      imageProfiles: [],
    })), 'utf8');

    const a = await import('../../../src/main/features/auth');
    const { providers } = await a.listProviders();
    expect(providers.find((p) => p.id === 'openai')?.profiles[0]?.masked).toBe('sk-l…xxxx');
    const raw = fs.readFileSync(file, 'utf8');
    expect(localSecrets.isEncryptedSecret(raw)).toBe(true);
    expect(raw).not.toContain('sk-legacy-xxxxxxxx');
  });

  it('migrates saved entries when their model id is no longer selectable', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, localSecrets.encryptLocalSecret(ctx, JSON.stringify({
      version: 4,
      profiles: {
        'kimi-coding:default': {
          type: 'api_key',
          provider: 'kimi-coding',
          label: 'default',
          key: 'sk-kimi-legacy-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [{
        entryId: 'entry-1',
        provider: 'kimi-coding',
        model: 'k2p6',
        profileId: 'kimi-coding:default',
        createdAt: 1,
        lastUsed: 0,
      }],
      searchProfiles: [],
      imageProfiles: [],
      videoProfiles: [],
    })), 'utf8');

    const a = await import('../../../src/main/features/auth');
    const { entries } = await a.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe('k2p7');

    const rewritten = JSON.parse(localSecrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')));
    expect(rewritten.entries[0].model).toBe('k2p7');
  });

  it('removeCredential drops the profile', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'work');
    const res = await a.removeCredential(profileId);
    expect(res.removed).toBe(true);
    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles).toHaveLength(0);
  });

  it('removeCredential on unknown id returns removed=false', async () => {
    const a = await import('../../../src/main/features/auth');
    const res = await a.removeCredential('anthropic:missing');
    expect(res.removed).toBe(false);
  });

  it('renameProfile changes the label and rewrites the profile id', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'old');
    const res = await a.renameProfile(profileId, 'new-name');
    expect(res.profileId).toBe('anthropic:new-name');
    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles.map((p) => p.label)).toEqual(['new-name']);
  });

  it('renameProfile rejects collisions with an existing label', async () => {
    const a = await import('../../../src/main/features/auth');
    const r1 = await a.addApiKey('anthropic', 'k1-xxxxxxxxxxxx', 'one');
    await a.addApiKey('anthropic', 'k2-xxxxxxxxxxxx', 'two');
    await expect(a.renameProfile(r1.profileId, 'two')).rejects.toThrow();
  });
});

describe('auth › listProviders grouping', () => {
  it('returns providers in catalog order regardless of insertion order', async () => {
    const a = await import('../../../src/main/features/auth');
    // 插入顺序：anthropic → openai。CATALOG 顺序：openai 在 anthropic 之前。
    // listProviders 必须按 CATALOG 排，所以即便先插 anthropic、再插 openai，
    // 也要 openai.indexOf < anthropic.indexOf（CATALOG 排序压过插入顺序）。
    await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    await a.addApiKey('openai', 'k-xxxxxxxxxxxx');
    const { providers } = await a.listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids.indexOf('openai')).toBeLessThan(ids.indexOf('anthropic'));
  });

  it('exposes supportsApiKey / supportsOAuth flags consistent with the catalog', async () => {
    const a = await import('../../../src/main/features/auth');
    const { providers } = await a.listProviders();

    // anthropic — both API-key and OAuth work against the same endpoint.
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.supportsApiKey).toBe(true);
    expect(anth.supportsOAuth).toBe(true);
    expect(anth.oauthProvider).toBe('anthropic');

    // pi-ai 0.99.1 exposes native OpenAI OAuth alongside the Codex endpoint.
    const openai = providers.find((p) => p.id === 'openai')!;
    expect(openai.supportsApiKey).toBe(true);
    expect(openai.supportsOAuth).toBe(true);
    expect(openai.oauthProvider).toBe('openai');
    expect(providers.find((p) => p.id === 'openai-codex')).toMatchObject({
      supportsApiKey: false, supportsOAuth: true, oauthProvider: 'openai-codex',
    });
  });
});

describe('auth › custom model configuration', () => {

  it('retains legacy OpenAI configuration when protocol is absent after restart', async () => {
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secrets.encryptLocalSecret(
      { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' },
      JSON.stringify({ version: 6, profiles: { 'custom:legacy': {
        type: 'api_key', provider: 'custom', label: 'legacy', key: 'synthetic-legacy-key',
        baseUrl: 'https://gateway.example.test/v1', contextWindow: 131072,
        createdAt: 1, lastUsed: 0,
      } }, entries: [{ entryId: 'legacy-entry', provider: 'custom',
        profileId: 'custom:legacy', model: 'legacy-model', lastUsed: 0 }] }),
    ));
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.pickChatEntryGroup())[0]).toMatchObject({
      entryId: 'legacy-entry', model: 'legacy-model', apiKey: 'synthetic-legacy-key',
      customConfig: { protocol: 'openai', baseUrl: 'https://gateway.example.test/v1',
        contextWindow: 131072, maxTokens: 32768 },
    });
  });

  it.each(['https://gateway.example.test/proxy/v1', 'https://gateway.example.test/proxy/v1/responses/'])('saves and reloads an explicit Responses profile from %s', async baseUrl => {
    const auth = await import('../../../src/main/features/auth');
    await auth.addCustomModelEntry({ protocol: 'responses', baseUrl, model: 'custom-responses-alias', apiKey: 'synthetic-responses-key' });
    vi.resetModules();
    const users = await import('../../../src/main/features/users'); users.activateUser(TEST_UID);
    const restarted = await import('../../../src/main/features/auth');
    expect((await restarted.pickChatEntryGroup())[0]?.customConfig).toMatchObject({ protocol: 'responses', baseUrl: 'https://gateway.example.test/proxy/v1' });
  });

  it.each(['https://gateway.example.test/proxy',
    'https://gateway.example.test/proxy/v1/',
    'https://gateway.example.test/proxy/v1/messages/'])('saves an Anthropic SDK base from %s and reloads its protocol', async (baseUrl) => {
    const auth = await import('../../../src/main/features/auth');
    await auth.addCustomModelEntry({ protocol: 'anthropic', baseUrl,
      model: 'claude-gateway-alias', apiKey: 'synthetic-anthropic-key' });
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const restarted = await import('../../../src/main/features/auth');
    expect((await restarted.pickChatEntryGroup())[0]?.customConfig).toMatchObject({
      protocol: 'anthropic', baseUrl: 'https://gateway.example.test/proxy',
    });
  });

  it('does not normalize an already saved versioned gateway prefix a second time', async () => {
    const auth = await import('../../../src/main/features/auth');
    await auth.addCustomModelEntry({ protocol: 'anthropic',
      baseUrl: 'https://gateway.example.test/proxy/v1/v1/messages',
      model: 'claude-gateway-alias', apiKey: 'synthetic-prefix-key' });
    expect((await auth.pickChatEntryGroup())[0]?.customConfig?.baseUrl)
      .toBe('https://gateway.example.test/proxy/v1');
    vi.resetModules();
    const users = await import('../../../src/main/features/users'); users.activateUser(TEST_UID);
    const restarted = await import('../../../src/main/features/auth');
    expect((await restarted.pickChatEntryGroup())[0]?.customConfig?.baseUrl)
      .toBe('https://gateway.example.test/proxy/v1');
  });

  it('persists Anthropic protocol and returns it in the runtime choice', async () => {
    const a = await import('../../../src/main/features/auth');
    const added = await a.addCustomModelEntry({
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example.test',
      model: 'claude-3-7-sonnet',
      apiKey: 'sk-custom-anthropic-xxxxxxxx',
    });
    expect((await a.pickChatEntryGroup()).find((entry) => entry.entryId === added.entryId)).toEqual(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          protocol: 'anthropic',
          baseUrl: 'https://gateway.example.test',
        }),
      }),
    );
  });

  it('atomically stores endpoint metadata and carries it into the runtime choice', async () => {
    const a = await import('../../../src/main/features/auth');
    const added = await a.addCustomModelEntry({
      label: '公司网关',
      baseUrl: 'https://gateway.example.test/v1/',
      model: 'acme/reasoner-v2',
      apiKey: 'sk-custom-runtime-xxxxxxxx',
      contextWindow: 262_144,
      maxTokens: 16_384,
      supportsReasoning: true,
      supportsVision: true,
      reasoningEffort: 'medium',
    });

    expect(added.profileId).toBe('custom:公司网关');
    expect((await a.listEntries()).entries).toEqual([
      expect.objectContaining({
        provider: 'custom',
        providerLabelKey: 'provider.custom.label',
        model: 'acme/reasoner-v2',
        modelEditable: false,
        modelAvailable: true,
        profileMasked: 'sk-c…xxxx',
      }),
    ]);
    expect(await a.pickChatEntryGroup()).toEqual([
      expect.objectContaining({
        entryId: added.entryId,
        provider: 'custom',
        model: 'acme/reasoner-v2',
        apiKey: 'sk-custom-runtime-xxxxxxxx',
        customConfig: {
          protocol: 'openai',
          baseUrl: 'https://gateway.example.test/v1',
          contextWindow: 262_144,
          maxTokens: 16_384,
          supportsReasoning: true,
          supportsVision: true,
          reasoningEffort: 'medium',
        },
      }),
    ]);

    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const persisted = JSON.parse(localSecrets.decryptLocalSecret(
      ctx,
      fs.readFileSync(file, 'utf8'),
      { legacySeeds: [TEST_UID] },
    ));
    expect(persisted.profiles['custom:公司网关']).toMatchObject({
      maxTokens: 16_384,
      supportsReasoning: true,
      supportsVision: true,
      reasoningEffort: 'medium',
    });
    expect(persisted.profiles['custom:公司网关']).not.toHaveProperty('maxTokensSource');

    const custom = (await a.listProviders()).providers.find((provider) => provider.id === 'custom');
    expect(custom).toMatchObject({
      labelKey: 'provider.custom.label',
      supportsApiKey: true,
      supportsOAuth: false,
      customOpenAICompatible: true,
    });
  });

  it('preserves an explicit text-only override for a custom model', async () => {
    const a = await import('../../../src/main/features/auth');
    const added = await a.addCustomModelEntry({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'acme/text-only',
      apiKey: 'sk-custom-text-only-xxxxxxxx',
      supportsVision: false,
    });

    expect(await a.pickChatEntryGroup()).toEqual([
      expect.objectContaining({
        entryId: added.entryId,
        customConfig: expect.objectContaining({ supportsVision: false }),
      }),
    ]);
  });

  it('assigns provider-local labels when the optional label is blank', async () => {
    const a = await import('../../../src/main/features/auth');
    const first = await a.addCustomModelEntry({
      baseUrl: 'https://first.example.test/v1',
      model: 'first-model',
      apiKey: 'sk-custom-first-xxxxxxxx',
    });
    const second = await a.addCustomModelEntry({
      label: '   ',
      baseUrl: 'https://second.example.test/v1',
      model: 'second-model',
      apiKey: 'sk-custom-second-xxxxxxxx',
    });

    expect(first.profileId).toBe('custom:default');
    expect(second.profileId).toBe('custom:account2');
  });

  it('normalizes full chat URLs and rejects impossible limits without a partial credential', async () => {
    const a = await import('../../../src/main/features/auth');
    const base = {
      label: 'full-endpoint',
      model: 'acme/reasoner-v2',
      apiKey: 'sk-custom-invalid-xxxxxxxx',
    };

    await expect(a.addApiKeyEntry(
      'custom',
      base.model,
      base.apiKey,
      'generic-bypass',
    )).rejects.toMatchObject({ code: 'CUSTOM_CONFIG_REQUIRED' });
    const normalized = await a.addCustomModelEntry({
      ...base,
      baseUrl: 'https://gateway.example.test/v1/chat/completions/stream',
    });
    expect((await a.pickChatEntryGroup())[0]).toMatchObject({
      entryId: normalized.entryId,
      customConfig: {
        baseUrl: 'https://gateway.example.test/v1',
        contextWindow: 131_072,
        maxTokens: 32_768,
      },
    });
    await expect(a.addCustomModelEntry({
      ...base,
      label: 'invalid-limits',
      baseUrl: 'https://gateway.example.test/v1',
      contextWindow: 4_096,
      maxTokens: 8_192,
    })).rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });

    expect((await a.listEntries()).entries).toHaveLength(1);
    expect(
      (await a.listProviders()).providers.find((provider) => provider.id === 'custom')?.profiles,
    ).toEqual([
      expect.objectContaining({ profileId: 'custom:full-endpoint' }),
    ]);
  });

  it.each([
    ['contextWindow', [131_072]], ['contextWindow', { value: 131_072 }],
    ['maxTokens', true], ['maxTokens', []], ['maxTokens', [32_768]],
  ])('rejects non-scalar %s sizing without overwriting an existing credential (%#)', async (field, invalid) => {
    const auth = await import('../../../src/main/features/auth');
    const config = { label: 'typed-sizing', model: 'fixture-model',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic',
      contextWindow: 131_072, maxTokens: 32_768 };
    await expect(auth.addCustomModelEntry({ ...config, [field]: invalid } as any))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toHaveLength(0);
    const saved = await auth.addCustomModelEntry(config);
    const before = await auth.pickChatEntryGroup();
    await expect(auth.addCustomModelEntry({ ...config, [field]: invalid } as any))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect(await auth.pickChatEntryGroup()).toEqual(before);
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toHaveLength(1);
    expect((await auth.pickChatEntryGroup())[0]?.entryId).toBe(saved.entryId);
    await auth.addCustomModelEntry({ ...config, contextWindow: '131072', maxTokens: '65536' });
    expect((await auth.pickChatEntryGroup())[0]?.customConfig).toMatchObject({
      contextWindow: 131_072, maxTokens: 65_536,
    });
  });

  it.each([1, 131_072, 16_777_216])('retains a valid output boundary %s without clamping', async maxTokens => {
    const auth = await import('../../../src/main/features/auth');
    await auth.addCustomModelEntry({ label: 'sizing-boundary', model: 'fixture-model',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic', contextWindow: 16_777_216, maxTokens });
    expect((await auth.pickChatEntryGroup())[0]?.customConfig?.maxTokens).toBe(maxTokens);
  });

  it.each([0, -1, 1.5, 16_777_217])('rejects invalid output boundary %s before saving a credential', async maxTokens => {
    const auth = await import('../../../src/main/features/auth');
    await expect(auth.addCustomModelEntry({ label: 'sizing-boundary', model: 'fixture-model',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic', contextWindow: 16_777_216, maxTokens }))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toHaveLength(0);
  });

  it('rejects API keys that cannot be sent in an Authorization header without a partial credential', async () => {
    const a = await import('../../../src/main/features/auth');

    await expect(a.addCustomModelEntry({
      label: 'invalid-header',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'acme/reasoner-v2',
      apiKey: 'щ-custom-key',
    })).rejects.toMatchObject({ code: 'CUSTOM_API_KEY_INVALID' });

    expect((await a.listEntries()).entries).toEqual([]);
    expect(
      (await a.listProviders()).providers.find((provider) => provider.id === 'custom')?.profiles,
    ).toEqual([]);
  });

  it('uses the 32K runtime default without persisting an omitted maxTokens field', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addCustomModelEntry({
      label: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      apiKey: 'local-development-key',
      contextWindow: '',
      maxTokens: '   ',
    });

    expect((await a.pickChatEntryGroup())[0]?.customConfig).toEqual({
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      contextWindow: 131_072,
      maxTokens: 32_768,
    });

    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const persisted = JSON.parse(localSecrets.decryptLocalSecret(
      ctx,
      fs.readFileSync(file, 'utf8'),
      { legacySeeds: [TEST_UID] },
    ));
    expect(persisted.profiles['custom:local']).not.toHaveProperty('maxTokens');
  });

  it('removes the legacy generated 8K custom cap during the v6 profile migration', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, localSecrets.encryptLocalSecret(ctx, JSON.stringify({
      version: 5,
      profiles: {
        'custom:legacy': {
          type: 'api_key',
          provider: 'custom',
          label: 'legacy',
          key: 'sk-legacy-custom-xxxxxxxx',
          baseUrl: 'https://legacy.example.test/v1',
          contextWindow: 131_072,
          maxTokens: 8_192,
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [{
        entryId: 'legacy-entry',
        provider: 'custom',
        model: 'legacy-model',
        profileId: 'custom:legacy',
        createdAt: 1,
        lastUsed: 0,
      }],
    })), 'utf8');

    const a = await import('../../../src/main/features/auth');
    expect((await a.pickChatEntryGroup())[0]?.customConfig?.maxTokens).toBe(32_768);

    const rewritten = JSON.parse(localSecrets.decryptLocalSecret(
      ctx,
      fs.readFileSync(file, 'utf8'),
      { legacySeeds: [TEST_UID] },
    ));
    expect(rewritten.version).toBe(6);
    expect(rewritten.profiles['custom:legacy']).not.toHaveProperty('maxTokens');
  });

  it('keeps same-model custom endpoints as ordered fallbacks instead of rotating them as keys', async () => {
    const a = await import('../../../src/main/features/auth');
    const fallback = await a.addCustomModelEntry({
      label: 'fallback',
      baseUrl: 'https://fallback.example.test/v1',
      model: 'shared-model-id',
      apiKey: 'sk-fallback-xxxxxxxx',
    });
    const primary = await a.addCustomModelEntry({
      label: 'primary',
      baseUrl: 'https://primary.example.test/v1',
      model: 'shared-model-id',
      apiKey: 'sk-primary-xxxxxxxx',
    });

    a.bumpEntryLastUsed(primary.entryId);
    expect((await a.pickChatEntryGroup()).map((choice) => choice.entryId)).toEqual([
      primary.entryId,
      fallback.entryId,
    ]);
  });

  it('does not expose custom credentials or endpoint metadata in connection-test errors', async () => {
    vi.doMock('#core-agent', () => ({}));
    vi.doMock('../../../src/main/model/core-agent/external-providers', () => ({
      createCustomOpenAICompatibleProvider: vi.fn(async (config: {
        apiKey: string;
        baseUrl: string;
      }) => ({
        complete: vi.fn(async () => {
          throw new Error(
            `API key ${config.apiKey} rejected by ${config.baseUrl}`
            + '?signature=provider-secret for admin@example.test at /Users/test/private',
          );
        }),
      })),
    }));
    const a = await import('../../../src/main/features/auth');
    const added = await a.addCustomModelEntry({
      label: 'private-gateway',
      baseUrl: 'https://gateway.internal.example/v1',
      model: 'private-model',
      apiKey: 'opaque-connection-secret-xxxxxxxx',
    });

    const result = await a.testConnection('custom', 'private-model', added.profileId);

    expect(result).toMatchObject({ ok: false, profileId: added.profileId });
    expect(result.error).toContain('rejected');
    expect(result.error).not.toContain('opaque-connection-secret-xxxxxxxx');
    expect(result.error).not.toContain('gateway.internal.example');
    expect(result.error).not.toContain('provider-secret');
    expect(result.error).not.toContain('admin@example.test');
    expect(result.error).not.toContain('/Users/test/private');
  });
});

describe('auth › pickRotationKey', () => {
  it('returns null when no profile is configured', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(await a.pickRotationKey('anthropic')).toBeNull();
  });

  it('picks the profile with oldest lastUsed and bumps it', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('anthropic', 'key-one-xxxxxxxx', 'one');
    await a.addApiKey('anthropic', 'key-two-xxxxxxxx', 'two');

    // First pick: deterministic tie-break by insertion order (both lastUsed=0)
    const first = await a.pickRotationKey('anthropic');
    expect(first).not.toBeNull();
    // Second pick: must be the other profile (its lastUsed is still 0,
    // while the one just used now has a non-zero lastUsed).
    const second = await a.pickRotationKey('anthropic');
    expect(second).not.toBeNull();
    expect(second!.profileId).not.toBe(first!.profileId);

    // Third pick: first is now older again → rotates back.
    const third = await a.pickRotationKey('anthropic');
    expect(third).not.toBeNull();
    expect(third!.profileId).toBe(first!.profileId);
  });
});

describe('auth › entries (priority list)', () => {
  it('listEntries is empty on a fresh store', async () => {
    const a = await import('../../../src/main/features/auth');
    const { entries } = await a.listEntries();
    expect(entries).toEqual([]);
  });

  it('addEntry prepends new entries so the latest is the default', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'one');
    const p2 = await a.addApiKey('openai', 'sk-xxxxxxxxxxxx', 'one');
    const r1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    const r2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5.5',          profileId: p2.profileId });
    expect(r1.entryId).toBeTruthy();
    expect(r2.entryId).not.toBe(r1.entryId);

    const { entries } = await a.listEntries();
    expect(entries.map((e) => `${e.provider}:${e.model}`)).toEqual([
      'openai:gpt-5.6-sol',
      'anthropic:claude-opus-5',
    ]);
  });

  it('addEntry is idempotent for the same (provider, model, profileId)', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const r1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    const r2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    expect(r2.entryId).toBe(r1.entryId);
    const { entries } = await a.listEntries();
    expect(entries).toHaveLength(1);
  });

  it('upgrades removed saved model ids when adding an entry', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('kimi-coding', 'k-xxxxxxxxxxxx');
    await a.addEntry({ provider: 'kimi-coding', model: 'k2p6', profileId: p.profileId });
    const { entries } = await a.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe('k2p7');
  });

  it('addEntry rejects a profileId belonging to a different provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    await expect(
      a.addEntry({ provider: 'openai', model: 'gpt-5.5', profileId: p.profileId }),
    ).rejects.toThrow();
  });

  it('removeEntry drops the tuple', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const r = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    const out = await a.removeEntry(r.entryId);
    expect(out.removed).toBe(true);
    expect((await a.listEntries()).entries).toEqual([]);
  });

  it('removeCredential cascades — entries pointing at the dropped profile go away', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    await a.removeCredential(p.profileId);
    expect((await a.listEntries()).entries).toEqual([]);
  });

  it('reorderEntries permutes the list in the order given', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const q = await a.addApiKey('openai', 'k-xxxxxxxxxxxx');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5.5',          profileId: q.profileId });

    const res = await a.reorderEntries([e2.entryId, e1.entryId]);
    expect(res.entries.map((e) => e.entryId)).toEqual([e2.entryId, e1.entryId]);
  });

  it('pickChatEntry returns null when entries list is empty', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx'); // credential but no entry
    expect(await a.pickChatEntry()).toBeNull();
  });

  it('pickChatEntry keeps the user-selected first credential within the same model group', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'k-one-xxxxxxxx', 'one');
    const p2 = await a.addApiKey('anthropic', 'k-two-xxxxxxxx', 'two');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p2.profileId });

    const first  = await a.pickChatEntry();
    const second = await a.pickChatEntry();
    const third  = await a.pickChatEntry();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect([first!.entryId, second!.entryId, third!.entryId]).toEqual([e2.entryId, e2.entryId, e2.entryId]);
  });

  it('pickChatEntry falls back to the next group when top group has no usable credential', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('openai', 'k-openai-xxxxxxx');
    const p2 = await a.addApiKey('anthropic', 'k-anthropic-xxxx');
    // Priority: anthropic(bad)/openai(good) — we simulate "bad" by deleting
    // the credential after adding the entry (leaves a dangling entry, which
    // should be skipped, not returned).
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p2.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5.5',          profileId: p1.profileId });
    // Remove credential p2 directly via removeCredential; since that cascades,
    // it also drops e1. To simulate a dangling entry without cascade, reach
    // into the json file.
    const pathMod = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const storePath = pathMod.userAuthProfilesFile(TEST_UID);
    const raw = fs.readFileSync(storePath, 'utf-8');
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const store = JSON.parse(localSecrets.decryptLocalSecret(ctx, raw, { legacySeeds: [TEST_UID] }));
    delete store.profiles[p2.profileId];
    fs.writeFileSync(storePath, localSecrets.encryptLocalSecret(ctx, JSON.stringify(store)));

    const pick = await a.pickChatEntry();
    expect(pick).not.toBeNull();
    expect(pick!.entryId).toBe(e2.entryId);
    expect(pick!.provider).toBe('openai');
    // The normal runtime list excludes the dangling entry, while Settings'
    // explicit remediation query retains it so the user can repair/delete it.
    expect((await a.listEntries()).entries.map((e) => e.entryId)).not.toContain(e1.entryId);
    const { entries } = await a.listEntries({ includeUnavailable: true });
    expect(entries.map((e) => e.entryId)).toContain(e1.entryId);
  });

});

describe('auth › pickChatEntryGroup + 冷却联动', () => {
  it('单把 key → group 只有 1 个候选', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-only-xxxxxxxx');
    const e = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });

    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e.entryId);
  });

  it('同 (provider, model) 两把 key → lastUsed 不覆盖用户顺序', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'k-1-xxxxxxxxxxx', 'one');
    const p2 = await a.addApiKey('anthropic', 'k-2-xxxxxxxxxxx', 'two');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p2.profileId });

    // Even a recently used first credential retains the user's priority.
    a.bumpEntryLastUsed(e2.entryId);

    const group = await a.pickChatEntryGroup();
    expect(group.map((c) => c.entryId)).toEqual([e2.entryId, e1.entryId]);
  });

  it('冷却中的 profile 在 pickChatEntryGroup 被跳过', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-cold-xxxxxxx', 'cold');
    const p2 = await a.addApiKey('anthropic', 'k-warm-xxxxxxx', 'warm');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p2.profileId });

    // 冷却 p1 —— 组内候选应该只剩 p2
    cd.markCooldown(p1.profileId, 'auth', 'mocked 401');
    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e2.entryId);

    cd._clearAll();
    // 清冷却后 p1 应该重新进入候选
    const group2 = await a.pickChatEntryGroup();
    expect(group2.map((c) => c.entryId).sort()).toEqual([e1.entryId, e2.entryId].sort());
  });

  it('组内全部冷却 → 回落下一组', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-top-xxxxxxxx');
    const p2 = await a.addApiKey('openai',    'k-fallback-xxx');
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5.5', profileId: p2.profileId });

    cd.markCooldown(p1.profileId, 'auth', 'cold');
    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e2.entryId);

    cd._clearAll();
  });

  it('addApiKey 成功路径自动清冷却', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-old-xxxxxxxx', 'rotate-me');
    cd.markCooldown(p1.profileId, 'auth', 'pretend this 401ed');
    expect(cd.isCooledDown(p1.profileId)).toBe(true);

    // 再次 addApiKey（同 provider + label）更新 key → 应当清冷却
    await a.addApiKey('anthropic', 'k-new-xxxxxxxx', 'rotate-me');
    expect(cd.isCooledDown(p1.profileId)).toBe(false);

    cd._clearAll();
  });

  it('bumpEntryLastUsed 对不存在的 entryId 安全无操作', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(() => a.bumpEntryLastUsed('nonexistent')).not.toThrow();
  });
});

describe('auth › background model cooldown availability', () => {
  it('leaves an unconfigured store to the normal runner gate', async () => {
    const auth = await import('../../../src/main/features/auth');
    expect(auth.allConfiguredModelsCooledDown()).toBe(false);
  });

  it('reports all configured API-key entries cooling down without mutating credentials', async () => {
    const auth = await import('../../../src/main/features/auth');
    const cooldown = await import('../../../src/main/model/core-agent/profile-cooldown');
    const first = await auth.addApiKeyEntry('anthropic', 'claude-opus-4-8', 'fixture-first-key-xxxxxxxx', 'first');
    const second = await auth.addApiKeyEntry('openai', 'gpt-5.5', 'fixture-second-key-xxxxxxxx', 'second');
    cooldown.markCooldown(first.profileId, 'rate_limit', 'fixture 429');
    cooldown.markCooldown(second.profileId, 'auth', 'fixture 401');
    const paths = await import('../../../src/main/paths');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const original = fs.readFileSync(file);
    expect(auth.allConfiguredModelsCooledDown()).toBe(true);
    expect(fs.readFileSync(file)).toEqual(original);
  });

  it('keeps the cycle usable when one API-key entry is not cooling down', async () => {
    const auth = await import('../../../src/main/features/auth');
    const cooldown = await import('../../../src/main/model/core-agent/profile-cooldown');
    const first = await auth.addApiKeyEntry('anthropic', 'claude-opus-4-8', 'fixture-first-key-xxxxxxxx', 'first');
    const second = await auth.addApiKeyEntry('openai', 'gpt-5.5', 'fixture-second-key-xxxxxxxx', 'second');
    cooldown.markCooldown(first.profileId, 'balance', 'fixture 402');
    expect(auth.allConfiguredModelsCooledDown()).toBe(false);
    cooldown.markCooldown(second.profileId, 'permission', 'fixture 403');
    expect(auth.allConfiguredModelsCooledDown()).toBe(true);
    cooldown.clearCooldown(first.profileId);
    expect(auth.allConfiguredModelsCooledDown()).toBe(false);
  });

  it('ignores disabled entries rather than treating them as usable fallback', async () => {
    const auth = await import('../../../src/main/features/auth');
    const cooldown = await import('../../../src/main/model/core-agent/profile-cooldown');
    const allowed = await auth.addApiKeyEntry('anthropic', 'claude-opus-4-8', 'fixture-allowed-key-xxxxxxxx', 'allowed');
    await auth.addApiKeyEntry('deepseek', 'deepseek-v4-flash', 'fixture-disabled-key-xxxxxxxx', 'disabled');
    cooldown.markCooldown(allowed.profileId, 'auth', 'fixture 401');
    await setDeepSeekEnabled(false);
    expect(auth.allConfiguredModelsCooledDown()).toBe(true);
    await setDeepSeekEnabled(true);
    expect(auth.allConfiguredModelsCooledDown()).toBe(false);
  });
});

describe('auth › hasConfiguredModel', () => {
  it('reports not-configured on a fresh store', async () => {
    const a = await import('../../../src/main/features/auth');
    delete process.env.ANTHROPIC_API_KEY;
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
  });

  it('reports configured once an entry is added', async () => {
    const a = await import('../../../src/main/features/auth');
    delete process.env.ANTHROPIC_API_KEY;
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    // Credential alone is not enough — we require an entry in the priority list.
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p.profileId });
    expect(a.hasConfiguredModel()).toEqual({ configured: true });
  });

  it('does not treat a remediation-only entry with a missing credential as runnable', async () => {
    const a = await import('../../../src/main/features/auth');
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const profile = await a.addApiKey('anthropic', 'k-dangling-xxxxxxxx');
    const entry = await a.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const storePath = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const store = JSON.parse(localSecrets.decryptLocalSecret(
      ctx,
      fs.readFileSync(storePath, 'utf8'),
      { legacySeeds: [TEST_UID] },
    ));
    delete store.profiles[profile.profileId];
    fs.writeFileSync(storePath, localSecrets.encryptLocalSecret(ctx, JSON.stringify(store)), 'utf8');

    expect((await a.listEntries()).entries).toEqual([]);
    expect((await a.listEntries({ includeUnavailable: true })).entries).toEqual([
      expect.objectContaining({
        entryId: entry.entryId,
        profileId: profile.profileId,
        profileAvailable: false,
        profileLabel: 'default',
      }),
    ]);
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
    expect(await a.getConfig()).toEqual({ provider: '', model: '' });
    expect(await a.pickChatEntry()).toBeNull();
  });

  it('falls back to the ANTHROPIC_API_KEY env var when set', async () => {
    const a = await import('../../../src/main/features/auth');
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-env-xxxxxxxx';
    try {
      expect(a.hasConfiguredModel()).toEqual({ configured: true });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('auth › listModels', () => {
  it('saves and reopens MiniMax Flash without migrating a hidden M2.7 entry', async () => {
    const auth = await import('../../../src/main/features/auth');
    const key = await auth.addApiKey('minimax-cn', 'fixture-minimax-key');
    const old = await auth.addEntry({ provider: 'minimax-cn', model: 'MiniMax-M2.7', profileId: key.profileId });
    for (const provider of ['minimax-cn', 'minimax-portal', 'minimax-portal-cn']) {
      expect((await auth.listModels(provider)).models.map(m => m.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    }
    const added = await auth.addEntry({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', profileId: key.profileId });
    expect(added.entryId).toEqual(expect.any(String));
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(TEST_UID);
    const reopened = await (await import('../../../src/main/features/auth')).listEntries();
    expect(reopened.entries.find(e => e.entryId === old.entryId)).toMatchObject({ model: 'MiniMax-M2.7', modelAvailable: true });
    expect(reopened.entries.find(e => e.entryId === added.entryId)).toMatchObject({ model: 'MiniMax-M3.1-Flash', modelAvailable: true });
    const selected = await (await import('../../../src/main/features/auth')).selectEntry(old.entryId);
    expect(selected.entries[0]).toMatchObject({ entryId: old.entryId, model: 'MiniMax-M2.7', modelAvailable: true });
  });

  it('honors picker-only retirement in Server catalog metadata without retiring saved entries', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    clientConfig.applyServerPayload({ immediate: { model_catalog: { providers: { 'kimi-coding': [
      { id: 'k3', name: 'Kimi K3' },
      { id: 'k2p7', name: 'Kimi K2.7 Code', hiddenFromPicker: true },
    ] } } }, restart: {}, config_hash: 'sha256:picker-only-retirement' }, '"picker-only-retirement"');
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.listModels('kimi-coding')).models.map(m => m.id)).toEqual(['k3']);
    const key = await auth.addApiKey('kimi-coding', 'fixture-coding-key');
    const saved = await auth.addEntry({ provider: 'kimi-coding', model: 'k2p7', profileId: key.profileId });
    expect((await auth.listEntries()).entries.find(e => e.entryId === saved.entryId)).toMatchObject({ model: 'k2p7', modelAvailable: true });
    expect((await auth.selectEntry(saved.entryId)).entries[0]).toMatchObject({ entryId: saved.entryId, model: 'k2p7', modelAvailable: true });
  });

  it('offers recent native Kimi Coding models without rewriting a hidden legacy selection', async () => {
    // Official Coding IDs and the bundled SDK agree on K3/K3-256K/K2.8.
    // The requester chose picker-only retirement for k2p7, not migration.
    const auth = await import('../../../src/main/features/auth');
    const key = await auth.addApiKey('kimi-coding', 'fixture-coding-key');
    const saved = await auth.addEntry({ provider: 'kimi-coding', model: 'k2p7', profileId: key.profileId });
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const before = JSON.parse(secrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')));
    expect((await auth.listModels('kimi-coding')).models.map(m => ({ id: m.id, name: m.name }))).toEqual([
      { id: 'k3', name: 'Kimi K3' },
      { id: 'k3-256k', name: 'Kimi K3 (256K)' },
      { id: 'kimi-for-coding', name: 'Kimi K2.8 Preview' },
    ]);
    expect((await auth.listEntries()).entries.find(e => e.entryId === saved.entryId)).toMatchObject({ model: 'k2p7', modelAvailable: true });
    const after = JSON.parse(secrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')));
    expect(after.entries).toEqual(before.entries);
    expect(after.profiles).toEqual(before.profiles);
    const added = await auth.addEntry({ provider: 'kimi-coding', model: 'kimi-for-coding', profileId: key.profileId });
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(TEST_UID);
    const reopened = await (await import('../../../src/main/features/auth')).listEntries();
    expect(reopened.entries.find(e => e.entryId === saved.entryId)).toMatchObject({ model: 'k2p7', modelAvailable: true });
    expect(reopened.entries.find(e => e.entryId === added.entryId)).toMatchObject({ model: 'kimi-for-coding', modelName: 'Kimi K2.8 Preview', modelAvailable: true });
    const selected = await (await import('../../../src/main/features/auth')).selectEntry(saved.entryId);
    expect(selected.entries[0]).toMatchObject({ entryId: saved.entryId, model: 'k2p7', modelAvailable: true });
  });


  it('returns the hand-curated list for a known provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const { models } = await a.listModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.name).toBe('string');
    }
  });

  it('returns empty array for unknown providers', async () => {
    const a = await import('../../../src/main/features/auth');
    const { models } = await a.listModels('no-such-provider');
    expect(models).toEqual([]);
  });

  it('returns the synchronized GPT-6 and GPT-5.6 catalog for OpenAI Codex', async () => {
    const a = await import('../../../src/main/features/auth');
    expect((await a.listModels('openai-codex')).models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('exposes and saves only configured models resolvable by this runtime', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const a = await import('../../../src/main/features/auth');
    const exact = { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' };
    const templated = {
      id: 'claude-open-future-999',
      name: 'Claude Future',
      template: 'claude-opus-4-8',
      supportsVision: true,
    };
    const unresolved = { id: 'brand-new-open-999', name: 'Brand New' };
    clientConfig.applyServerPayload({
      immediate: {
        model_catalog: {
          providers: { anthropic: [exact, templated, unresolved] },
        },
      },
      restart: {},
      config_hash: 'sha256:runtime-model-resolution',
    }, '"runtime-model-resolution"');

    expect((await a.listModels('anthropic')).models.map((model) => model.id)).toEqual([
      exact.id,
      templated.id,
    ]);
    await expect(a.addApiKeyEntry(
      'anthropic',
      unresolved.id,
      'sk-unresolved-must-not-save-xxxxxxxx',
    )).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect((await a.listProviders()).providers
      .find((provider) => provider.id === 'anthropic')?.profiles).toEqual([]);

    const added = await a.addApiKeyEntry(
      'anthropic',
      templated.id,
      'sk-templated-model-xxxxxxxx',
    );
    expect((await a.pickChatEntryGroup())[0]).toMatchObject({
      entryId: added.entryId,
      model: templated.id,
    });
  });
});

describe('auth › DeepSeek policy gate', () => {
  it('keeps DeepSeek visible by default without Server config', async () => {
    const a = await import('../../../src/main/features/auth');
    const { providers } = await a.listProviders();
    expect(providers.map((p) => p.id)).toContain('deepseek');
    expect((await a.listModels('deepseek')).models.length).toBeGreaterThan(0);
  });

  it('hides DeepSeek direct and DeepSeek-backed OpenRouter models when Server config disables it', async () => {
    await setDeepSeekEnabled(false);
    const a = await import('../../../src/main/features/auth');

    const { providers } = await a.listProviders();
    expect(providers.map((p) => p.id)).not.toContain('deepseek');
    expect(providers.map((p) => p.id)).toContain('openrouter');
    expect((await a.listModels('deepseek')).models).toEqual([]);
    expect((await a.listModels('openrouter')).models.some((m) => /deepseek/i.test(m.id))).toBe(false);
    await expect(a.addApiKey('deepseek', 'sk-deepseek-disabled')).rejects.toThrow(/DeepSeek is disabled/);
  });

  it('does not use existing DeepSeek entries while disabled', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('deepseek', 'sk-deepseek-existing');
    await a.addEntry({ provider: 'deepseek', model: 'deepseek-v4-flash', profileId: p.profileId });
    expect(a.hasConfiguredModel()).toEqual({ configured: true });

    await setDeepSeekEnabled(false);
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
    expect((await a.listEntries()).entries).toEqual([]);
    expect(a.listApiKeyEntries()).toEqual([]);
    expect(await a.pickChatEntry()).toBeNull();
    expect(await a.pickRotationKey('deepseek')).toBeNull();
    const { providers } = await a.listProviders();
    expect(providers.flatMap((provider) => provider.profiles).some((profile) =>
      profile.provider === 'deepseek' || profile.profileId.startsWith('deepseek:'),
    )).toBe(false);
    await expect(
      a.addEntry({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', profileId: p.profileId }),
    ).rejects.toThrow(/DeepSeek is disabled/);
  });
});

describe('auth › getConfig', () => {
  it('returns empty pair when no profiles exist', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(await a.getConfig()).toEqual({ provider: '', model: '' });
  });

  it('returns entries[0] (provider, model) as the effective default', async () => {
    // getConfig now reads from auth-profiles.json's priority entries list;
    // legacy config.json fallback is removed — auth-profiles is the single
    // source of truth for the default (provider, model) pair.
    const a = await import('../../../src/main/features/auth');
    const profiles = await a.saveApiKey('anthropic', 'sk-test', 'acc1');
    expect(profiles.profileId).toBeTruthy();
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-5', profileId: profiles.profileId });
    expect(await a.getConfig()).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
  });
});

describe('auth › durable shared profile contracts', () => {
  it('keeps a successfully parsed profile available when its migration rewrite fails', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, localSecrets.encryptLocalSecret({
      namespace: 'auth.profiles',
      ownerId: TEST_UID,
      recordId: 'auth-profiles.json',
    }, JSON.stringify({
      version: 4,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          label: 'default',
          key: 'sk-readable-during-migration-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [],
      searchProfiles: [],
      imageProfiles: [],
    })), 'utf8');

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: (from: fs.PathLike, to: fs.PathLike) => {
          if (String(from) === `${file}.tmp` && String(to) === file) {
            throw Object.assign(new Error('migration rename denied'), { code: 'EACCES' });
          }
          return actual.renameSync(from, to);
        },
      };
    });

    const a = await import('../../../src/main/features/auth');
    const { providers } = await a.listProviders();

    expect(providers.find((provider) => provider.id === 'openai')?.profiles)
      .toEqual([expect.objectContaining({ masked: 'sk-r…xxxx' })]);
    expect(localSecrets.isEncryptedSecret(fs.readFileSync(file, 'utf8'))).toBe(true);
  });

  it('recreates a missing credentials directory before the first profile write', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.rmSync(path.dirname(file), { recursive: true, force: true });

    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('openai', 'sk-created-after-missing-dir-xxxxxxxx');

    expect(fs.statSync(path.dirname(file)).isDirectory()).toBe(true);
    expect(localSecrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')))
      .toContain('sk-created-after-missing-dir-xxxxxxxx');
  });

  it('recovers one transient ENOENT while writing the temporary profile file', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    let writeAttempts = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        writeFileSync: (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
          if (String(target) === `${file}.tmp`) {
            writeAttempts += 1;
            if (writeAttempts === 1) {
              actual.rmSync(path.dirname(file), { recursive: true, force: true });
              throw Object.assign(new Error('transient missing profile directory'), { code: 'ENOENT' });
            }
          }
          return actual.writeFileSync(target, data, options);
        },
      };
    });

    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('openai', 'sk-new-after-write-retry-xxxxxxxx');

    expect(writeAttempts).toBe(2);
    expect(localSecrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')))
      .toContain('sk-new-after-write-retry-xxxxxxxx');
  });

  it('recovers one transient ENOENT while atomically publishing auth profiles', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, localSecrets.encryptLocalSecret(ctx, JSON.stringify({
      version: 6,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          label: 'default',
          key: 'sk-existing-must-survive-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [],
      searchProfiles: [],
      imageProfiles: [],
      videoProfiles: [],
      ttsProfiles: [],
      disabledManagedProviders: [],
      disabledManagedModels: [],
    })), 'utf8');

    let publishAttempts = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: (from: fs.PathLike, to: fs.PathLike) => {
          if (String(from) === `${file}.tmp` && String(to) === file) {
            publishAttempts += 1;
            if (publishAttempts === 1) {
              actual.rmSync(from, { force: true });
              throw Object.assign(new Error('transient missing temp file'), { code: 'ENOENT' });
            }
          }
          return actual.renameSync(from, to);
        },
      };
    });

    const a = await import('../../../src/main/features/auth');

    await a.addApiKey('anthropic', 'sk-new-after-retry-xxxxxxxx');

    expect(publishAttempts).toBe(2);
    const saved = localSecrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8'));
    expect(saved).toContain('sk-existing-must-survive-xxxxxxxx');
    expect(saved).toContain('sk-new-after-retry-xxxxxxxx');
  });

  it('rethrows repeated ENOENT without replacing the existing auth profiles', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = localSecrets.encryptLocalSecret(ctx, JSON.stringify({
      version: 6,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          label: 'default',
          key: 'sk-existing-must-remain-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [],
      searchProfiles: [],
      imageProfiles: [],
      videoProfiles: [],
      ttsProfiles: [],
      disabledManagedProviders: [],
      disabledManagedModels: [],
    }));
    fs.writeFileSync(file, original, 'utf8');

    let publishAttempts = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: (from: fs.PathLike, to: fs.PathLike) => {
          if (String(from) === `${file}.tmp` && String(to) === file) {
            publishAttempts += 1;
            actual.rmSync(from, { force: true });
            throw Object.assign(new Error('persistent missing temp file'), { code: 'ENOENT' });
          }
          return actual.renameSync(from, to);
        },
      };
    });

    const a = await import('../../../src/main/features/auth');
    await expect(a.addApiKey('anthropic', 'sk-must-not-persist-xxxxxxxx'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    expect(publishAttempts).toBe(2);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('does not retry a non-ENOENT publish failure or replace existing profiles', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = localSecrets.encryptLocalSecret(ctx, JSON.stringify({
      version: 6,
      profiles: {
        'openai:default': {
          type: 'api_key', provider: 'openai', label: 'default',
          key: 'sk-existing-before-eacces-xxxxxxxx', createdAt: 1, lastUsed: 0,
        },
      },
      entries: [], searchProfiles: [], imageProfiles: [], videoProfiles: [], ttsProfiles: [],
      disabledManagedProviders: [], disabledManagedModels: [],
    }));
    fs.writeFileSync(file, original, 'utf8');
    let publishAttempts = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: (from: fs.PathLike, to: fs.PathLike) => {
          if (String(from) === `${file}.tmp` && String(to) === file) {
            publishAttempts += 1;
            throw Object.assign(new Error('profile publish denied'), { code: 'EACCES' });
          }
          return actual.renameSync(from, to);
        },
      };
    });

    const a = await import('../../../src/main/features/auth');
    await expect(a.addApiKey('anthropic', 'sk-must-not-persist-xxxxxxxx'))
      .rejects.toMatchObject({ code: 'EACCES' });

    expect(publishAttempts).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it.each([
    ['addApiKeyEntry', async (a: typeof import('../../../src/main/features/auth')) => {
      await a.addApiKeyEntry('openai', 'gpt-5.5', 'sk-must-not-overwrite-xxxxxxxx');
    }],
    ['addCustomModelEntry', async (a: typeof import('../../../src/main/features/auth')) => {
      await a.addCustomModelEntry({
        baseUrl: 'https://example.com/v1',
        model: 'private-model',
        apiKey: 'sk-must-not-overwrite-xxxxxxxx',
      });
    }],
    ['reorderEntries', async (a: typeof import('../../../src/main/features/auth')) => {
      await a.reorderEntries([]);
    }],
  ])('refuses %s when the existing credential store is unreadable', async (_name, mutate) => {
    const paths = await import('../../../src/main/paths');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const corrupt = 'credential-store-must-be-preserved';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, corrupt, 'utf8');
    const a = await import('../../../src/main/features/auth');

    await expect(mutate(a)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'failed to load profiles store',
      expect.objectContaining({
        error: expect.objectContaining({
          name: 'SyntaxError',
          message_hash: expect.any(String),
          message_chars: expect.any(Number),
        }),
      }),
    );
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(corrupt);
  });
  it('atomically changes a Composer model version and promotes that entry', async () => {
    const a = await import('../../../src/main/features/auth');
    const openai = await a.addApiKey('openai', 'sk-composer-version-xxxxxxxx', 'versioned');
    const target = await a.addEntry({
      provider: 'openai', model: 'gpt-5.6-sol', profileId: openai.profileId,
    });
    const anthropic = await a.addApiKey('anthropic', 'sk-composer-priority-xxxxxxxx', 'priority');
    const first = await a.addEntry({
      provider: 'anthropic', model: 'claude-opus-5', profileId: anthropic.profileId,
    });

    expect((await a.listEntries()).entries.map((entry) => entry.entryId))
      .toEqual([first.entryId, target.entryId]);
    const selected = await a.selectEntry(target.entryId, 'gpt-5.6-terra');
    expect(selected.entries).toMatchObject([{
      entryId: target.entryId,
      model: 'gpt-5.6-terra',
      modelName: 'GPT-5.6 Terra',
    }, {
      entryId: first.entryId,
    }]);
    expect((await a.listEntries()).entries[0]).toMatchObject({
      entryId: target.entryId,
      model: 'gpt-5.6-terra',
    });
  });

  it('does not partially change or promote an invalid Composer model version', async () => {
    const a = await import('../../../src/main/features/auth');
    const openai = await a.addApiKey('openai', 'sk-composer-invalid-xxxxxxxx', 'versioned');
    const target = await a.addEntry({
      provider: 'openai', model: 'gpt-5.6-sol', profileId: openai.profileId,
    });
    const anthropic = await a.addApiKey('anthropic', 'sk-composer-first-xxxxxxxx', 'priority');
    const first = await a.addEntry({
      provider: 'anthropic', model: 'claude-opus-5', profileId: anthropic.profileId,
    });

    await expect(a.selectEntry(target.entryId, 'gpt-not-listed'))
      .rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect((await a.listEntries()).entries.map((entry) => [entry.entryId, entry.model]))
      .toEqual([
        [first.entryId, 'claude-opus-5'],
        [target.entryId, 'gpt-5.6-sol'],
      ]);
  });

});


describe('auth › user-owned configuration operations', () => {
  it.each(['addApiKeyEntry', 'addEntry', 'updateEntryModel', 'reorderEntries', 'selectEntry', 'selectVersion'].flatMap(operation =>
    ['different-account', 'anonymous', ...(['updateEntryModel', 'reorderEntries', 'selectEntry', 'selectVersion'].includes(operation) ? ['credential-added', 'credential-removed'] : [])].map(destination => [operation, destination]),
  ))('does not publish %s after its metadata wait crosses into %s', async (operation, destination) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    vi.doMock('#core-agent', async importOriginal => {
      entered = true; await gate;
      return importOriginal();
    });
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const other = destination === 'anonymous' ? users.ANONYMOUS_LOCAL_ID : 'auth-owner-b';
    const files = [TEST_UID, other].map(uid => paths.userAuthProfilesFile(uid));
    for (const uid of [TEST_UID, other]) {
      users.activateUser(uid);
      await auth.addApiKey('openai', `synthetic-${uid}-key`, 'owner');
      const file = paths.userAuthProfilesFile(uid);
      const context = { namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' };
      const store = JSON.parse(secrets.decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
      store.entries = ['gpt-5.6-sol', 'gpt-5.6-terra'].map((model, index) => ({
        entryId: `entry-${index}`, provider: 'openai', model, profileId: 'openai:owner', createdAt: 1, lastUsed: 0,
      }));
      fs.writeFileSync(file, secrets.encryptLocalSecret(context, JSON.stringify(store)));
    }
    users.activateUser(TEST_UID);
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    const run = () => {
      if (operation === 'addApiKeyEntry') return auth.addApiKeyEntry('openai', 'gpt-5.6-sol', 'synthetic-new-key', 'new');
      if (operation === 'addEntry') return auth.addEntry({ provider: 'openai', model: 'gpt-6-sol', profileId: 'openai:owner' });
      if (operation === 'updateEntryModel') return auth.updateEntryModel('entry-0', 'gpt-6-sol');
      if (operation === 'reorderEntries') return auth.reorderEntries(['entry-1', 'entry-0']);
      return auth.selectEntry('entry-1', operation === 'selectVersion' ? 'gpt-6-sol' : undefined);
    };
    const pending = run().then(() => 'saved', () => 'rejected');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      if (destination === 'credential-added') await auth.addApiKey('anthropic', 'synthetic-newer-key', 'newer');
      else if (destination === 'credential-removed') await auth.removeCredential('openai:owner');
      else users.activateUser(other);
      const expected = destination.startsWith('credential-') ? files.map(file => fs.readFileSync(file, 'utf8')) : before;
      release();
      const outcome = await pending;
      expect({ outcome, stores: files.map(file => fs.readFileSync(file, 'utf8')) })
        .toEqual({ outcome: 'rejected', stores: expected });
      if (destination === 'credential-removed') return;
      // A fresh explicit operation in the original account remains usable.
      users.activateUser(TEST_UID);
      await run();
      expect(fs.readFileSync(files[1], 'utf8')).toBe(before[1]);
      expect(fs.readFileSync(files[0], 'utf8')).not.toBe(before[0]);
    } finally {
      release(); await pending;
    }
  });
});

describe('auth › OAuth login ownership and cancellation', () => {
  async function prepareLogin() {
    let release!: (credentials: any) => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<any>((resolve, fail) => { release = resolve; reject = fail; });
    let callbacks: any;
    const login = vi.fn((value: any) => { callbacks = value; return gate; });
    const provider = { id: 'anthropic', name: 'Anthropic', login, refreshToken: vi.fn(), getApiKey: (value: any) => value.access };
    const lookup = vi.fn(() => provider);
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({
      getOAuthProvider: lookup, getOAuthProviders: () => [provider], registerOAuthProvider: vi.fn(),
    }));
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const other = 'oauth-login-owner-b';
    for (const uid of [TEST_UID, other]) {
      users.activateUser(uid); await auth.addApiKey('openai', `synthetic-${uid}-key`, 'owner');
    }
    users.activateUser(TEST_UID);
    const files = [TEST_UID, other].map(uid => paths.userAuthProfilesFile(uid));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    const credentials = { access: 'synthetic-login-access', refresh: 'synthetic-login-refresh', expires: Date.now() + 3_600_000 };
    return { auth, users, secrets, other, files, before, credentials, release, reject, login, lookup, provider, get callbacks() { return callbacks; } };
  }

  it.each(['success', 'account-switch', 'cancelled-success', 'cancelled-failure'])('preserves credential stores and terminal ownership for %s', async scenario => {
    const fixture = await prepareLogin();
    const { auth, users, other, files, before, credentials } = fixture;
    const { flowId } = await auth.startOAuth('anthropic', 'login');
    try {
      if (scenario === 'account-switch') users.activateUser(other);
      if (scenario.startsWith('cancelled')) {
        vi.useFakeTimers();
        expect(auth.cancelOAuthFlow(flowId)).toEqual({ ok: true });
        expect(fixture.callbacks.signal.aborted).toBe(true);
      }
      if (scenario === 'cancelled-failure') fixture.reject(new Error('synthetic provider failure'));
      else fixture.release(credentials);
      await new Promise<void>(resolve => queueMicrotask(resolve));
      await new Promise<void>(resolve => queueMicrotask(resolve));
      const status = auth.pollOAuthFlow(flowId).status;
      if (scenario === 'success') {
        expect(status).toMatchObject({ kind: 'done', profileId: 'anthropic:login' });
        const saved = JSON.parse(fixture.secrets.decryptLocalSecret({
          namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json',
        }, fs.readFileSync(files[0], 'utf8')));
        expect(saved.profiles['anthropic:login']).toMatchObject(credentials);
        expect(fs.readFileSync(files[1], 'utf8')).toBe(before[1]);
      } else {
        expect({ stores: files.map(file => fs.readFileSync(file, 'utf8')), kind: status.kind })
          .toEqual({ stores: before, kind: 'error' });
        if (scenario.startsWith('cancelled')) expect(status).toEqual({ kind: 'error', error: 'cancelled' });
      }
    } finally {
      fixture.release(credentials);
      await new Promise<void>(resolve => queueMicrotask(resolve));
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('does not let a different account read, submit to or cancel an existing login', async () => {
    const fixture = await prepareLogin();
    const { auth, users, credentials } = fixture;
    const { flowId } = await auth.startOAuth('anthropic', 'login');
    const answer = fixture.callbacks.onPrompt({ message: 'synthetic owner-only prompt' });
    try {
      users.activateUser(fixture.other);
      const poll = auth.pollOAuthFlow(flowId).status;
      const submit = auth.submitOAuthInput(flowId, 'foreign-input');
      const cancel = auth.cancelOAuthFlow(flowId);
      expect({ kind: poll.kind, submit, cancel, aborted: fixture.callbacks.signal.aborted })
        .toEqual({ kind: 'error', submit: { ok: false }, cancel: { ok: false }, aborted: false });
      expect(JSON.stringify(poll)).not.toContain('synthetic owner-only prompt');
      users.activateUser(TEST_UID);
      expect(auth.submitOAuthInput(flowId, 'owner-input')).toEqual({ ok: true });
      expect(await answer).toBe('owner-input');
      fixture.release(credentials);
      await vi.waitFor(() => expect(auth.pollOAuthFlow(flowId).status.kind).toBe('done'));
    } finally {
      users.activateUser(TEST_UID); vi.useFakeTimers();
      auth.cancelOAuthFlow(flowId); fixture.release(credentials);
      await answer;
      await new Promise<void>(resolve => queueMicrotask(resolve));
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });


  it.each(['http-response', 'exchange-details', 'invalid-json'])('keeps raw %s provider failures out of the OAuth status and diagnostics', async shape => {
    const fixture = await prepareLogin();
    const secret = 'synthetic-oauth-private-marker';
    const body = JSON.stringify({ access_token: secret, email: 'fixture-person@example.test', request_path: '/Users/test/private/login' });
    const detail = `HTTP request failed. status=401; url=https://provider.example.test/token?code=${secret}; body=${body}`;
    // Accepted error formats from the pinned Anthropic OAuth SDK. Its body
    // may contain arbitrary remote data, so exposing a sanitized substring
    // does not establish the authorization-failure UI contract.
    const message = shape === 'http-response' ? detail : shape === 'invalid-json'
      ? `Token exchange returned invalid JSON. url=https://provider.example.test/token; body=${body}; details=SyntaxError`
      : `Token exchange request failed. url=https://provider.example.test/token; redirect_uri=http://localhost:1455/callback?code=${secret}; response_type=authorization_code; details=${detail}`;
    const { flowId } = await fixture.auth.startOAuth('anthropic', 'login');
    try {
      fixture.reject(new Error(message));
      await vi.waitFor(() => expect(fixture.auth.pollOAuthFlow(flowId).status.kind).toBe('error'));
      const status = fixture.auth.pollOAuthFlow(flowId).status as { kind: string; error?: string };
      expect(status.error).toBeFalsy(); // Renderer must use its existing localized failure copy.
      const published = JSON.stringify({ status, warnings: loggerMocks.warn.mock.calls });
      for (const value of [secret, 'fixture-person@example.test', '/Users/test/private/login', 'provider.example.test', body]) {
        expect(published).not.toContain(value);
      }
      expect(fixture.files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(fixture.before);
    } finally {
      vi.useFakeTimers(); fixture.auth.cancelOAuthFlow(flowId); fixture.release(fixture.credentials);
      await Promise.resolve(); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('does not start a provider login when account ownership changes during provider discovery', async () => {
    const fixture = await prepareLogin();
    let entered = false;
    let releaseLookup!: () => void;
    const gate = new Promise<void>(resolve => { releaseLookup = resolve; });
    fixture.lookup.mockImplementation((async () => { entered = true; await gate; return fixture.provider; }) as any);
    const pending = fixture.auth.startOAuth('anthropic', 'login').then(() => 'started', () => 'rejected');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      fixture.users.activateUser(fixture.other);
      releaseLookup(); fixture.release(fixture.credentials);
      const result = await pending;
      await new Promise<void>(resolve => queueMicrotask(resolve));
      expect({ result, calls: fixture.login.mock.calls.length, stores: fixture.files.map(file => fs.readFileSync(file, 'utf8')) })
        .toEqual({ result: 'rejected', calls: 0, stores: fixture.before });
    } finally {
      releaseLookup(); fixture.release(fixture.credentials); await pending;
    }
  });
});


describe('auth › rotating OAuth credential ownership', () => {
  async function fixture() {
    const grants: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
    const refreshToken = vi.fn(() => new Promise<any>((resolve, reject) => grants.push({ resolve, reject })));
    const provider = { id: 'openai-codex', name: 'Controlled OAuth fixture', refreshToken, getApiKey: (value: any) => value.access };
    const lookup = vi.fn(() => provider);
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({
      getOAuthProvider: lookup, getOAuthProviders: () => [provider], registerOAuthProvider: vi.fn(),
    }));
    const auth = await import('../../../src/main/features/auth');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const write = async (access: string, refresh: string, expires = Date.now() - 1000) => {
      await writeExpiredOAuthEntry({
        providerId: provider.id, model: 'gpt-5.6-sol', access, refresh, expires,
      });
      // The legacy v4 fixture is normalized by the real public reader before
      // capturing exact replacement bytes; migration is not a stale-grant write.
      expect(auth.hasConfiguredModel()).toEqual({ configured: true });
    };
    await write('fixture-original-access', 'fixture-original-refresh');
    const read = () => JSON.parse(secrets.decryptLocalSecret({ namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' }, fs.readFileSync(file, 'utf8')));
    const next = (access: string) => ({ access, refresh: access + '-refresh', expires: Date.now() + 3_600_000 });
    return { auth, file, write, read, next, grants, refreshToken, lookup, provider };
  }

  it('coalesces concurrent refreshes for the same credential into one grant', async () => {
    const f = await fixture();
    const first = f.auth.pickRotationKey('openai-codex');
    const second = f.auth.pickRotationKey('openai-codex');
    try {
      await vi.waitFor(() => expect(f.grants.length).toBeGreaterThan(0));
      const credentials = f.next('fixture-rotated');
      for (const grant of f.grants) grant.resolve(credentials);
      const results = await Promise.all([first, second]);
      expect(f.refreshToken).toHaveBeenCalledOnce();
      expect(results.map(result => result?.apiKey)).toEqual([credentials.access, credentials.access]);
      expect(f.read().profiles['openai-codex:default']).toMatchObject(credentials);
    } finally {
      for (const grant of f.grants) grant.resolve(f.next('fixture-cleanup'));
      await Promise.all([first, second]);
    }
  });

  it.each(['reauthorize', 'remove'] as const)('does not let an admitted old grant overwrite %s', async action => {
    const f = await fixture();
    const pending = f.auth.pickRotationKey('openai-codex');
    try {
      await vi.waitFor(() => expect(f.grants).toHaveLength(1));
      if (action === 'remove') await f.auth.removeCredential('openai-codex:default');
      else await f.write('fixture-reauthorized', 'fixture-reauthorized-refresh', Date.now() + 3_600_000);
      const expected = fs.readFileSync(f.file);
      f.grants[0].resolve(f.next('fixture-obsolete-grant'));
      expect(await pending).toBeNull();
      expect(fs.readFileSync(f.file)).toEqual(expected);
    } finally { f.grants[0]?.resolve(f.next('fixture-cleanup')); await pending; }
  });

  it('does not start a grant when provider discovery finds a superseded credential', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.lookup.mockImplementation((async () => { entered = true; await gate; return f.provider; }) as any);
    const pending = f.auth.pickRotationKey('openai-codex');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await f.write('fixture-new-login', 'fixture-new-refresh');
      const expected = fs.readFileSync(f.file);
      // An eager resolution keeps the unfixed path bounded while preserving
      // the independent oracle that it must never invoke refreshToken.
      f.refreshToken.mockResolvedValue(f.next('fixture-obsolete-grant'));
      release();
      expect(await pending).toBeNull();
      expect(f.refreshToken).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.file)).toEqual(expected);
    } finally { release(); await pending; }
  });

  it('keeps a newer credential grant pending after the obsolete grant settles', async () => {
    const f = await fixture();
    const first = f.auth.pickRotationKey('openai-codex');
    let second: ReturnType<typeof f.auth.pickRotationKey> | undefined;
    let third: ReturnType<typeof f.auth.pickRotationKey> | undefined;
    try {
      await vi.waitFor(() => expect(f.grants).toHaveLength(1));
      await f.write('fixture-new-login', 'fixture-new-refresh');
      second = f.auth.pickRotationKey('openai-codex');
      await vi.waitFor(() => expect(f.grants).toHaveLength(2));
      f.grants[0].resolve(f.next('fixture-obsolete-grant'));
      const obsoleteResult = await first;
      third = f.auth.pickRotationKey('openai-codex');
      // Both real calls cross provider lookup microtasks before observation.
      await new Promise<void>(resolve => setImmediate(resolve));
      const credentials = f.next('fixture-current-grant');
      for (const grant of f.grants.slice(1)) grant.resolve(credentials);
      const results = await Promise.all([second, third]);
      expect(obsoleteResult).toBeNull();
      expect(f.refreshToken).toHaveBeenCalledTimes(2);
      expect(results.map(result => result?.apiKey)).toEqual([credentials.access, credentials.access]);
      expect(f.read().profiles['openai-codex:default']).toMatchObject(credentials);
    } finally {
      for (const grant of f.grants) grant.resolve(f.next('fixture-cleanup'));
      await Promise.all([first, second, third]);
    }
  });

  it('keeps failure hints private to the account that attempted refresh', async () => {
    const f = await fixture();
    const pending = f.auth.pickRotationKey('openai-codex');
    await vi.waitFor(() => expect(f.grants).toHaveLength(1));
    f.grants[0].reject(new Error('controlled owner A failure'));
    expect(await pending).toBeNull();
    expect(f.auth.getConfiguredModelOAuthExpiredMessage()).toBeTruthy();
    const users = await import('../../../src/main/features/users');
    users.activateUser('oauth-hint-owner-b');
    await writeExpiredOAuthEntry({ providerId: 'openai-codex', model: 'gpt-5.6-sol', uid: 'oauth-hint-owner-b' });
    expect(f.auth.getConfiguredModelOAuthExpiredMessage()).toBeNull();
  });

  it('keeps the original account failure hint after another account refresh succeeds', async () => {
    const f = await fixture();
    const pending = f.auth.pickRotationKey('openai-codex');
    await vi.waitFor(() => expect(f.grants).toHaveLength(1));
    f.grants[0].reject(new Error('controlled owner A failure'));
    expect(await pending).toBeNull();
    const originalHint = f.auth.getConfiguredModelOAuthExpiredMessage();
    expect(originalHint).toBeTruthy();
    const users = await import('../../../src/main/features/users');
    users.activateUser('oauth-hint-owner-b');
    await writeExpiredOAuthEntry({ providerId: 'openai-codex', model: 'gpt-5.6-sol', uid: 'oauth-hint-owner-b' });
    f.refreshToken.mockResolvedValue(f.next('fixture-owner-b-current'));
    expect(await f.auth.pickRotationKey('openai-codex')).toMatchObject({ apiKey: 'fixture-owner-b-current' });
    expect(f.auth.getConfiguredModelOAuthExpiredMessage()).toBeNull();
    users.activateUser(TEST_UID);
    expect(f.auth.getConfiguredModelOAuthExpiredMessage()).toBe(originalHint);
  });

  it('does not record an obsolete grant as a failure of replacement credentials', async () => {
    // This case owns credential state; use a local metadata-only SDK seam.
    vi.doMock('#core-agent', () => ({
      getPiModel: (provider: string, model: string) => ({ id: model, provider,
        api: 'openai-codex-responses', contextWindow: 131072, maxTokens: 32768,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    }));
    const f = await fixture();
    const pending = f.auth.pickChatEntryGroup();
    try {
      await vi.waitFor(() => expect(f.grants).toHaveLength(1));
      await f.write('fixture-new-login', 'fixture-new-refresh');
      f.refreshToken.mockResolvedValue(f.next('fixture-unexpected-second-grant'));
      f.grants[0].resolve(f.next('fixture-obsolete-grant'));
      expect(await pending).toEqual([]);
      expect(f.refreshToken).toHaveBeenCalledOnce();
      expect(f.read().profiles['openai-codex:default']).toMatchObject({ access: 'fixture-new-login', refresh: 'fixture-new-refresh' });
      expect(f.auth.getConfiguredModelOAuthExpiredMessage()).toBeNull();
    } finally { f.grants[0]?.resolve(f.next('fixture-cleanup')); await pending; }
  });

  it('releases a failed in-flight refresh so an explicit retry can succeed', async () => {
    const f = await fixture();
    const first = f.auth.pickRotationKey('openai-codex');
    await vi.waitFor(() => expect(f.grants).toHaveLength(1));
    const original = fs.readFileSync(f.file);
    f.grants[0].reject(new Error('controlled refresh failure'));
    expect(await first).toBeNull();
    expect(fs.readFileSync(f.file)).toEqual(original);
    const retry = f.auth.pickRotationKey('openai-codex');
    try {
      await vi.waitFor(() => expect(f.grants).toHaveLength(2));
      const credentials = f.next('fixture-retry-success');
      f.grants[1].resolve(credentials);
      expect(await retry).toMatchObject({ apiKey: credentials.access });
      expect(f.refreshToken).toHaveBeenCalledTimes(2);
      expect(f.read().profiles['openai-codex:default']).toMatchObject(credentials);
    } finally { f.grants[1]?.resolve(f.next('fixture-cleanup')); await retry; }
  });
});

describe('auth › interrupted connection and rotation ownership', () => {
  const probes = ['metadata', 'refresh', 'discovery', 'factory', 'stream'].flatMap(stage => ['explicit', 'rotation'].flatMap(mode =>
    ['same-account', 'different-account', 'anonymous'].map(destination => [stage, mode, destination]),
  ));
  probes.push(...['same-account', 'different-account', 'anonymous'].map(destination => ['refresh', 'rotation-key', destination]));
  it.each(probes)('keeps %s %s work within its initiating account after %s', async (stage, mode, destination) => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('#core-agent', async importOriginal => {
      if (stage === 'metadata') { entered = true; await gate; }
      if (stage === 'refresh') return { ...await importOriginal<any>(), createPiProvider: (config: unknown) => { factory(config); return { stream, complete }; } };
      return {};
    });
    const providerId = stage === 'refresh' ? 'openai-codex' : 'custom';
    const modelId = stage === 'refresh' ? 'gpt-5.6-sol' : 'controlled-probe';
    const profileId = `${providerId}:${stage === 'refresh' ? 'default' : 'probe'}`;
    const credentials = { access: 'synthetic-rotated-access', refresh: 'synthetic-rotated-refresh', expires: Date.now() + 3_600_000 };
    const refresh = vi.fn(async () => { entered = true; await gate; return credentials; });
    const oauthProvider = { id: providerId, name: 'Controlled OAuth fixture', login: vi.fn(), refreshToken: refresh, getApiKey: (c: any) => c.access };
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({
      getOAuthProvider: (id: string) => id === providerId ? oauthProvider : undefined,
      getOAuthProviders: () => [oauthProvider], registerOAuthProvider: vi.fn(),
    }));
    const stream = vi.fn(() => (async function* () { if (stage === 'stream') { entered = true; await gate; } yield { type: 'text_delta', text: 'OK' }; })());
    const complete = async () => {
      for await (const _event of stream()) { /* Complete consumes the public provider stream. */ }
      return { content: [{ type: 'text', text: 'OK' }], model: modelId, stopReason: 'end_turn' };
    };
    const factory = vi.fn(async (_config: unknown) => {
      if (stage === 'factory') { entered = true; await gate; }
      return { stream, complete };
    });
    vi.doMock('../../../src/main/model/core-agent/external-providers', async () => {
      if (stage === 'discovery') { entered = true; await gate; }
      return { createCustomOpenAICompatibleProvider: factory };
    });
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const other = destination === 'anonymous' ? users.ANONYMOUS_LOCAL_ID : 'probe-owner-b';
    const read = (uid: string) => JSON.parse(secrets.decryptLocalSecret({ namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' }, fs.readFileSync(paths.userAuthProfilesFile(uid), 'utf8')));
    for (const uid of [TEST_UID, other]) {
      users.activateUser(uid);
      if (stage === 'refresh') await writeExpiredOAuthEntry({ providerId, model: modelId, uid });
      else await auth.addCustomModelEntry({ label: 'probe', baseUrl: 'https://gateway.example.test/v1', model: modelId, apiKey: `synthetic-${uid}-key` });
    }
    users.activateUser(TEST_UID);
    const otherBefore = fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8');
    const pending = mode === 'rotation-key' ? auth.pickRotationKey(providerId)
      : auth.testConnection(providerId, modelId, mode === 'explicit' ? profileId : undefined);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      if (destination !== 'same-account') users.activateUser(other);
      const cooldown = await import('../../../src/main/model/core-agent/profile-cooldown');
      if (stage === 'stream') cooldown.markCooldown(profileId, 'auth', 'fixture newly active account cooldown');
      release();
      const result = await pending;
      if (stage === 'stream') {
        // The already-started probe may finish, but its old result must not
        // clear an independently established cooldown in the new account.
        expect(result).toMatchObject({ ok: true, profileId });
        expect(stream).toHaveBeenCalledTimes(1);
        expect(cooldown.isCooledDown(profileId)).toBe(destination !== 'same-account');
        expect(fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8')).toBe(otherBefore);
      } else if (destination === 'same-account') {
        if (mode === 'rotation-key') expect(result).toMatchObject({ apiKey: credentials.access, profileId });
        else {
          expect(result).toMatchObject({ ok: true, profileId });
          expect(stream).toHaveBeenCalledTimes(1);
          expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: stage === 'refresh' ? credentials.access : `synthetic-${TEST_UID}-key` }));
        }
      } else {
        // No stale key may escape and no provider request may start after a
        // boundary was crossed. The other encrypted store must stay exact.
        expect({ result: mode === 'rotation-key' ? result : (result as any)?.ok,
          streamCalls: stream.mock.calls.length,
          otherBytes: fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8') })
          .toEqual({ result: mode === 'rotation-key' ? null : false, streamCalls: 0, otherBytes: otherBefore });
        if (stage === 'metadata' || stage === 'discovery') expect(factory).not.toHaveBeenCalled();
      }
      if (stage === 'refresh') {
        expect(refresh).toHaveBeenCalledTimes(1);
        // A rotating refresh already admitted still persists to its owner.
        expect(read(TEST_UID).profiles[profileId]).toMatchObject(credentials);
      }
    } finally {
      release(); await pending;
      vi.doUnmock('../../../src/main/model/core-agent/external-providers');
    }
  });
});

describe('auth › chat picker operation ownership', () => {
  it.each(['api_key', 'oauth'] as const)('does not resolve %s credentials after model discovery crosses into another account', async kind => {
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('#core-agent', async original => { entered = true; await gate; return original(); });
    const providerId = kind === 'oauth' ? 'openai-codex' : 'openai';
    const model = 'gpt-5.6-sol';
    const refresh = vi.fn(async () => ({ access: 'synthetic-refreshed-a', refresh: 'synthetic-next-a', expires: Date.now() + 3_600_000 }));
    const oauthProvider = { id: providerId, name: 'Controlled OAuth fixture', refreshToken: refresh, getApiKey: (c: any) => c.access };
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({
      getOAuthProvider: () => oauthProvider, getOAuthProviders: () => [oauthProvider], registerOAuthProvider: vi.fn(),
    }));
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const other = 'chat-picker-owner-b';
    for (const uid of [TEST_UID, other]) {
      users.activateUser(uid);
      if (kind === 'oauth') await writeExpiredOAuthEntry({ providerId, model, uid, access: `synthetic-${uid}-old`, refresh: `synthetic-${uid}-refresh` });
      else {
        const saved = await auth.addApiKey(providerId, `synthetic-${uid}-key`, 'default');
        const file = paths.userAuthProfilesFile(uid);
        const context = { namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' };
        const store = JSON.parse(secrets.decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
        store.entries = [{ entryId: 'entry-picker', provider: providerId, model, profileId: saved.profileId, createdAt: 1, lastUsed: 0 }];
        fs.writeFileSync(file, secrets.encryptLocalSecret(context, JSON.stringify(store)));
      }
    }
    users.activateUser(TEST_UID);
    const otherBefore = fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8');
    const pending = auth.pickChatEntryGroup();
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      users.activateUser(other);
      release();
      const choices = await pending;
      expect({ choices, refreshCalls: refresh.mock.calls.length, otherBytes: fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8') })
        .toEqual({ choices: [], refreshCalls: 0, otherBytes: otherBefore });
      // Returning to the originating account admits a fresh explicit lookup.
      users.activateUser(TEST_UID);
      expect((await auth.pickChatEntryGroup())[0]).toMatchObject({ provider: providerId, apiKey: kind === 'oauth' ? 'synthetic-refreshed-a' : `synthetic-${TEST_UID}-key` });
      if (kind === 'oauth') expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ access: `synthetic-${TEST_UID}-old` }), expect.objectContaining({ aborted: false }));
      expect(fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8')).toBe(otherBefore);
    } finally { release(); await pending; }
  });

  it.each(['success', 'failure'] as const)('settles an admitted OAuth refresh %s without returning a stale choice or changing the new account failure state', async outcome => {
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const other = 'chat-picker-refresh-b';
    const credentials = { access: 'synthetic-refreshed-a', refresh: 'synthetic-next-a', expires: Date.now() + 3_600_000 };
    const refresh = vi.fn(async (old: any) => {
      if (old.access === 'synthetic-b-old') throw new Error('synthetic B refresh failure');
      entered = true; await gate;
      if (outcome === 'failure') throw new Error('synthetic A refresh failure');
      return credentials;
    });
    const provider = { id: 'openai-codex', name: 'Controlled OAuth fixture', refreshToken: refresh, getApiKey: (c: any) => c.access };
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({ getOAuthProvider: () => provider, getOAuthProviders: () => [provider], registerOAuthProvider: vi.fn() }));
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    for (const uid of [TEST_UID, other]) await writeExpiredOAuthEntry({ providerId: provider.id, model: 'gpt-5.6-sol', uid, access: uid === other ? 'synthetic-b-old' : 'synthetic-a-old' });
    users.activateUser(other);
    if (outcome === 'success') expect(await auth.pickRotationKey(provider.id)).toBeNull();
    const otherFailure = auth.getConfiguredModelOAuthExpiredMessage();
    expect(Boolean(otherFailure)).toBe(outcome === 'success');
    const otherBefore = fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8');
    users.activateUser(TEST_UID);
    const pending = auth.pickChatEntryGroup();
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      users.activateUser(other); release();
      expect(await pending).toEqual([]);
      expect(auth.getConfiguredModelOAuthExpiredMessage()).toBe(otherFailure);
      expect(fs.readFileSync(paths.userAuthProfilesFile(other), 'utf8')).toBe(otherBefore);
      const original = JSON.parse(secrets.decryptLocalSecret({ namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' }, fs.readFileSync(paths.userAuthProfilesFile(TEST_UID), 'utf8')));
      expect(original.profiles['openai-codex:default'].access).toBe(outcome === 'success' ? credentials.access : 'synthetic-a-old');
    } finally { release(); await pending; }
  });
});

describe('auth › idle API preload metadata', () => {
  it('returns no target without configured credentials and makes no request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No preload network allowed'));
    try {
      const a = await import('../../../src/main/features/auth');
      expect(await a.getChatPreloadApi()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it.each([
    ['openai', 'openai-completions'], ['anthropic', 'anthropic-messages'],
  ])('uses the saved custom %s protocol without changing the selection', async (protocol, api) => {
    const a = await import('../../../src/main/features/auth');
    await a.addCustomModelEntry({ protocol, baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' });
    const before = await a.getConfig();
    expect(await a.getChatPreloadApi()).toBe(api);
    expect(await a.getConfig()).toEqual(before);
  });
  it('loads the current API metadata without refreshing an expired OAuth credential', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('Preload must not refresh credentials'));
    const provider = { id: 'anthropic', name: 'Controlled OAuth fixture', refreshToken: refresh, getApiKey: (c: any) => c.access };
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({ getOAuthProvider: () => provider, getOAuthProviders: () => [provider], registerOAuthProvider: vi.fn() }));
    await writeExpiredOAuthEntry({ providerId: 'anthropic', model: 'claude-sonnet-5' });
    const a = await import('../../../src/main/features/auth');
    expect(await a.getChatPreloadApi()).toBe('anthropic-messages');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('reads the changed account instead of reusing a previous preload target', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKeyEntry('anthropic', 'claude-sonnet-5', 'fixture-key');
    expect(await a.getChatPreloadApi()).toBe('anthropic-messages');
    (await import('../../../src/main/features/users')).activateUser('preload-other');
    expect(await a.getChatPreloadApi()).toBeNull();
  });
});

describe("auth public configured provider parity",()=>{
it('adds a provider, preserves per-model capability metadata, and fails closed after withdrawal', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const a = await import('../../../src/main/features/auth');
    const configuredCatalog = {
      providers: {
        acme: [
          { id: 'acme-vision', name: 'Acme Vision', supportsVision: true, maxInputImages: 12 },
          { id: 'acme-default', name: 'Acme Default' },
          { id: 'acme-text', name: 'Acme Text', supportsVision: false },
        ],
      },
      openai_compatible_providers: {
        acme: {
          label: 'Acme AI',
          baseUrl: 'https://api.acme.example/v1',
          docsUrl: 'https://docs.acme.example/keys',
        },
      },
    };
    clientConfig.applyServerPayload({
      immediate: { model_catalog: configuredCatalog },
      restart: {},
      config_hash: 'sha256:acme-provider-on',
    }, '"acme-provider-on"');

    const acme = (await a.listProviders()).providers.find((provider) => provider.id === 'acme');
    expect(acme).toMatchObject({
      label: 'Acme AI',
      docsUrl: 'https://docs.acme.example/keys',
      supportsApiKey: true,
      supportsOAuth: false,
      customOpenAICompatible: false,
      profiles: [],
    });
    expect((await a.listModels('acme')).models).toEqual([
      { id: 'acme-vision', name: 'Acme Vision', supportsVision: true, maxInputImages: 12 },
      { id: 'acme-default', name: 'Acme Default' },
      { id: 'acme-text', name: 'Acme Text', supportsVision: false },
    ]);
    await expect(a.addApiKeyEntry(
      'acme',
      'acme-vision',
      'invalid-щ-key',
    )).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
    expect((await a.listSettingsEntries()).entries).toEqual([]);

    const added = await a.addApiKeyEntry(
      'acme',
      'acme-vision',
      'sk-acme-valid-xxxxxxxx',
      'work',
    );
    expect(await a.pickChatEntryGroup()).toEqual([
      expect.objectContaining({
        entryId: added.entryId,
        provider: 'acme',
        model: 'acme-vision',
        apiKey: 'sk-acme-valid-xxxxxxxx',
      }),
    ]);

    clientConfig.applyServerPayload({
      immediate: {
        model_catalog: {
          providers: {},
          openai_compatible_providers: {},
        },
      },
      restart: {},
      config_hash: 'sha256:acme-provider-off',
    }, '"acme-provider-off"');

    expect((await a.listModels('acme')).models).toEqual([]);
    expect(await a.pickChatEntryGroup()).toEqual([]);
    expect((await a.listSettingsEntries()).entries).toEqual([
      expect.objectContaining({
        entryId: added.entryId,
        provider: 'acme',
        model: 'acme-vision',
        selectable: false,
        availability: 'catalog_removed',
      }),
    ]);
    expect(
      (await a.listProviders()).providers.find((provider) => provider.id === 'acme')?.profiles,
    ).toEqual([expect.objectContaining({ profileId: 'acme:work' })]);
  });
});

describe('auth › native 32000-token context minimum', () => {
  it.each(['openai', 'anthropic'])('rejects undersized %s saves and accepts the exact boundary without partial writes', async protocol => {
    const auth = await import('../../../src/main/features/auth');
    const config = { protocol, label: 'capacity-boundary', model: 'capacity-fixture',
      baseUrl: 'https://capacity-fixture.invalid/v1', apiKey: 'synthetic', maxTokens: 8192 };
    await expect(auth.addCustomModelEntry({ ...config, contextWindow: 31999 }))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect((await auth.listSettingsEntries()).entries).toHaveLength(0);
    // The implicit 32768 output allowance cannot fit a 32000 window either.
    await expect(auth.addCustomModelEntry({ ...config, maxTokens: undefined, contextWindow: 32000 }))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect((await auth.listSettingsEntries()).entries).toHaveLength(0);
    const saved = await auth.addCustomModelEntry({ ...config, contextWindow: 32000 });
    expect((await auth.pickChatEntryGroup())[0]).toMatchObject({ entryId: saved.entryId,
      customConfig: { contextWindow: 32000, maxTokens: 8192 } });
    await expect(auth.addCustomModelEntry({ ...config, contextWindow: 31999 }))
      .rejects.toMatchObject({ code: 'CUSTOM_TOKEN_LIMIT_INVALID' });
    expect((await auth.pickChatEntryGroup())[0]?.customConfig?.contextWindow).toBe(32000);
  });

  it('retains legacy small profiles for remediation but never selects or rotates them', async () => {
    const auth = await import('../../../src/main/features/auth');
    const good = await auth.addCustomModelEntry({ label: 'usable', model: 'shared-fixture',
      baseUrl: 'https://capacity-fixture.invalid/v1', apiKey: 'synthetic',
      contextWindow: 32000, maxTokens: 8192 });
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const ctx = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const store = JSON.parse(secrets.decryptLocalSecret(ctx, fs.readFileSync(file, 'utf8')));
    store.profiles['custom:legacy-small'] = { ...store.profiles[good.profileId], label: 'legacy-small', contextWindow: 31999 };
    store.entries.unshift({ ...store.entries[0], entryId: 'legacy-small', profileId: 'custom:legacy-small' });
    store.profiles['custom:legacy-default-output'] = { ...store.profiles[good.profileId], label: 'legacy-default-output', contextWindow: 4096 };
    delete store.profiles['custom:legacy-default-output'].maxTokens;
    store.entries.unshift({ ...store.entries[0], entryId: 'legacy-default-output', profileId: 'custom:legacy-default-output' });
    fs.writeFileSync(file, secrets.encryptLocalSecret(ctx, JSON.stringify(store)));
    const before = fs.readFileSync(file, 'utf8');
    const rows = (await auth.listSettingsEntries()).entries;
    expect(rows.find(row => row.entryId === 'legacy-small')).toMatchObject({
      selectable: false, availability: 'context_too_small', profileAvailable: true,
      availabilityReason: expect.stringContaining('32000'),
    });
    expect(rows.find(row => row.entryId === 'legacy-default-output')).toMatchObject({
      availability: 'context_too_small', profileAvailable: true, availabilityReason: expect.stringContaining('32000') });
    expect(auth.getConfiguredModelContextWindowMessage()).toBeNull();
    expect((await auth.listComposerEntries()).entries.map(row => row.entryId)).toEqual([good.entryId]);
    expect((await auth.listRotationEntries()).entries.map(row => row.entryId)).toEqual([good.entryId]);
    expect((await auth.pickChatEntryGroup()).map(row => row.entryId)).toEqual([good.entryId]);
    await expect(auth.selectEntry('legacy-small')).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE', message: expect.stringContaining('32000') });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    vi.resetModules();
    const users = await import('../../../src/main/features/users'); users.activateUser(TEST_UID);
    const restarted = await import('../../../src/main/features/auth');
    expect((await restarted.pickChatEntryGroup()).map(row => row.entryId)).toEqual([good.entryId]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await restarted.removeEntry(good.entryId);
    expect(await restarted.pickChatEntryGroup()).toEqual([]);
    expect(restarted.getConfiguredModelContextWindowMessage()).toContain('32000');
  });

  it('uses resolved catalog windows to reject a small version switch without changing priorities', async () => {
    const auth = await import('../../../src/main/features/auth');
    const profile = await auth.addApiKey('openai', 'synthetic', 'capacity');
    const good = await auth.addEntry({ provider: 'openai', model: 'gpt-5.6-sol', profileId: profile.profileId });
    const small = await auth.addEntry({ provider: 'openai', model: 'gpt-5.6-terra', profileId: profile.profileId });
    const { clientConfig } = await import('../../../src/main/features/client_config');
    clientConfig.applyServerPayload({ immediate: { model_catalog: { providers: { openai: [
      { id: 'gpt-5.6-sol', name: 'Fixture large', contextWindow: 32000, maxTokens: 8192 },
      { id: 'gpt-5.6-terra', name: 'Fixture small', contextWindow: 31999, maxTokens: 8192 },
    ] } } }, restart: {}, config_hash: 'sha256:context-floor' }, '"context-floor"');
    expect((await auth.listModels('openai')).models.map(row => row.id)).toEqual(['gpt-5.6-sol']);
    expect((await auth.listComposerEntries()).entries.map(row => row.entryId)).toEqual([good.entryId]);
    expect((await auth.listRotationEntries()).entries.map(row => row.entryId)).toEqual([good.entryId]);
    expect((await auth.pickChatEntryGroup()).map(row => row.entryId)).toEqual([good.entryId]);
    expect((await auth.listSettingsEntries()).entries.find(row => row.entryId === small.entryId))
      .toMatchObject({ availability: 'context_too_small', availabilityReason: expect.stringContaining('32000') });
    await expect(auth.selectEntry(small.entryId)).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    await expect(auth.selectEntry(good.entryId, 'gpt-5.6-terra')).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect((await auth.listSettingsEntries()).entries.map(row => [row.entryId, row.model]))
      .toEqual([[small.entryId, 'gpt-5.6-terra'], [good.entryId, 'gpt-5.6-sol']]);
  });

  it('hides undersized external catalog choices before credentials can be saved', async () => {
    await setDeepSeekEnabled(true);
    const { clientConfig } = await import('../../../src/main/features/client_config');
    clientConfig.applyServerPayload({ immediate: { model_catalog: { providers: { deepseek: [
      { id: 'capacity-small', name: 'Small', contextWindow: 31999, maxTokens: 8192 },
      { id: 'capacity-exact', name: 'Exact', contextWindow: 32000, maxTokens: 8192 },
    ] } } }, restart: {}, config_hash: 'sha256:external-floor' }, '"external-floor"');
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.listModels('deepseek')).models.map(row => row.id)).toEqual(['capacity-exact']);
    await expect(auth.addApiKeyEntry('deepseek', 'capacity-small', 'synthetic', 'capacity'))
      .rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect((await auth.listProviders()).providers.find(provider => provider.id === 'deepseek')?.profiles)
      .toHaveLength(0);
  });

  it('defines localized capacity remediation in every registered desktop locale', async () => {
    const root = path.resolve(__dirname, '../../../src/main/locales');
    const { SUPPORTED_LANGS } = await import('../../../src/main/i18n');
    for (const lang of SUPPORTED_LANGS) {
      const message = JSON.parse(fs.readFileSync(path.join(root, `${lang}.json`), 'utf8'))['errors.model_context_too_small'];
      expect(message, lang).toEqual(expect.stringContaining('{minimum}'));
    }
  });

});



function mockOAuthRefreshSuccess(providerId: string, providerName: string): ReturnType<typeof vi.fn> {
  const refreshToken = vi.fn(async () => {
    // Keep the promise pending for one microtask so concurrent callers have
    // to share the same in-flight refresh rather than passing sequentially.
    await Promise.resolve();
    return {
      access: 'renewed-access-token',
      refresh: 'rotated-refresh-token',
      expires: Date.now() + 60 * 60 * 1000,
    };
  });
  vi.doMock('@earendil-works/pi-ai/oauth', () => {
    const registry = new Map<string, any>();
    registry.set(providerId, {
      id: providerId,
      name: providerName,
      usesCallbackServer: true,
      login: vi.fn(),
      refreshToken,
      getApiKey: (credentials: any) => credentials.access,
    });
    return {
      getOAuthProvider: (id: string) => registry.get(id),
      getOAuthProviders: () => Array.from(registry.values()),
      registerOAuthProvider: (provider: any) => {
        registry.set(provider.id, provider);
      },
    };
  });
  return refreshToken;
}

describe('auth public priority and forced OAuth recovery',()=>{
it('exposes a forced OAuth refresh hook and coalesces concurrent refreshes', async () => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    await writeExpiredOAuthEntry({
      providerId: 'openai-codex',
      model: 'gpt-5.5',
      // The local clock says this credential is still valid. The hook models
      // the server-authoritative 401 recovery path.
      expires: Date.now() + 60 * 60 * 1000,
    });

    const a = await import('../../../src/main/features/auth');
    const [choice] = await a.pickChatEntryGroup();
    expect(choice.apiKey).toBe('expired-access-token');
    expect(choice.refreshApiKey).toEqual(expect.any(Function));

    const [first, second] = await Promise.all([
      choice.refreshApiKey!('expired-access-token'),
      choice.refreshApiKey!('expired-access-token'),
    ]);

    expect(first).toBe('renewed-access-token');
    expect(second).toBe('renewed-access-token');
    expect(refreshToken).toHaveBeenCalledTimes(1);

    // A staggered request that captured the same old access token reuses the
    // replacement already on disk instead of rotating the refresh token again.
    await expect(choice.refreshApiKey!('expired-access-token'))
      .resolves.toBe('renewed-access-token');
    expect(refreshToken).toHaveBeenCalledTimes(1);

    const [renewedChoice] = await a.pickChatEntryGroup();
    expect(renewedChoice.apiKey).toBe('renewed-access-token');
  });
it('keeps simultaneous OAuth refreshes bound to their account across an account switch', async () => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    refreshToken.mockImplementation(async (credentials) => {
      await held;
      return {
        access: `${credentials.access}-renewed`, refresh: `${credentials.refresh}-rotated`,
        expires: Date.now() + 3_600_000,
      };
    });
    const secondUid = '88888888';
    for (const uid of [TEST_UID, secondUid]) {
      await writeExpiredOAuthEntry({
        providerId: 'openai-codex', model: 'gpt-5.5', uid, expires: Date.now() + 3_600_000,
        access: `${uid}-access`, refresh: `${uid}-refresh`,
      });
    }
    const auth = await import('../../../src/main/features/auth');
    const users = await import('../../../src/main/features/users');
    const [firstChoice] = await auth.pickChatEntryGroup();
    const first = firstChoice.refreshApiKey!(firstChoice.apiKey);
    let second: Promise<string | undefined> | undefined;
    try {
      await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledTimes(1));
      users.activateUser(secondUid);
      const [secondChoice] = await auth.pickChatEntryGroup();
      second = secondChoice.refreshApiKey!(secondChoice.apiKey);
      await new Promise((resolve) => setImmediate(resolve));
      release();
      expect(await Promise.all([first, second])).toEqual([
        `${TEST_UID}-access-renewed`, `${secondUid}-access-renewed`,
      ]);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      const paths = await import('../../../src/main/paths');
      const secrets = await import('../../../src/main/util/local-secret-store');
      for (const uid of [TEST_UID, secondUid]) {
        const saved = JSON.parse(secrets.decryptLocalSecret({
          namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json',
        }, fs.readFileSync(paths.userAuthProfilesFile(uid), 'utf8')));
        expect(saved.profiles['openai-codex:default']).toMatchObject({
          access: `${uid}-access-renewed`, refresh: `${uid}-refresh-rotated`,
        });
      }
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
it('does not let an old account refresh hook read the newly active account credential', async () => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    await writeExpiredOAuthEntry({
      providerId: 'openai-codex', model: 'gpt-5.5', expires: Date.now() + 3_600_000,
    });
    const auth = await import('../../../src/main/features/auth');
    const [choice] = await auth.pickChatEntryGroup();
    await writeExpiredOAuthEntry({
      providerId: 'openai-codex', model: 'gpt-5.5', uid: '88888888',
      expires: Date.now() + 3_600_000, access: 'second-account-access',
    });
    const users = await import('../../../src/main/features/users');
    users.activateUser('88888888');
    await expect(choice.refreshApiKey!(choice.apiKey)).resolves.toBeUndefined();
    expect(refreshToken).not.toHaveBeenCalled();
  });
it.each(['replaced', 'removed'])('discards a pending OAuth refresh when its credential was %s', async (change) => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    refreshToken.mockImplementation(async () => {
      await held;
      return { access: 'obsolete-access', refresh: 'obsolete-refresh', expires: Date.now() + 3_600_000 };
    });
    await writeExpiredOAuthEntry({
      providerId: 'openai-codex', model: 'gpt-5.5', expires: Date.now() + 3_600_000,
    });
    const auth = await import('../../../src/main/features/auth');
    const [choice] = await auth.pickChatEntryGroup();
    const pending = choice.refreshApiKey!(choice.apiKey);
    try {
      await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledTimes(1));
      if (change === 'removed') {
        await auth.removeCredential(choice.profileId);
      } else {
        await writeExpiredOAuthEntry({
          providerId: 'openai-codex', model: 'gpt-5.5', expires: Date.now() + 3_600_000,
          access: 'reauthorized-access', refresh: 'reauthorized-refresh',
        });
      }
      release();
      await expect(pending).resolves.toBeUndefined();
      const paths = await import('../../../src/main/paths');
      const secrets = await import('../../../src/main/util/local-secret-store');
      const saved = JSON.parse(secrets.decryptLocalSecret({
        namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json',
      }, fs.readFileSync(paths.userAuthProfilesFile(TEST_UID), 'utf8')));
      if (change === 'removed') expect(saved.profiles[choice.profileId]).toBeUndefined();
      else expect(saved.profiles[choice.profileId]).toMatchObject({
        access: 'reauthorized-access', refresh: 'reauthorized-refresh',
      });
    } finally {
      release();
      await Promise.allSettled([pending]);
    }
  });
it('does not coalesce a reauthorized credential with its obsolete pending refresh', async () => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    refreshToken.mockImplementation(async (credentials) => {
      await held;
      return {
        access: `${credentials.access}-renewed`, refresh: `${credentials.refresh}-rotated`,
        expires: Date.now() + 3_600_000,
      };
    });
    await writeExpiredOAuthEntry({
      providerId: 'openai-codex', model: 'gpt-5.5', expires: Date.now() + 3_600_000,
    });
    const auth = await import('../../../src/main/features/auth');
    const [oldChoice] = await auth.pickChatEntryGroup();
    const old = oldChoice.refreshApiKey!(oldChoice.apiKey);
    let current: Promise<string | undefined> | undefined;
    try {
      await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledTimes(1));
      await writeExpiredOAuthEntry({
        providerId: 'openai-codex', model: 'gpt-5.5', expires: Date.now() + 3_600_000,
        access: 'reauthorized-access', refresh: 'reauthorized-refresh',
      });
      const [newChoice] = await auth.pickChatEntryGroup();
      current = newChoice.refreshApiKey!(newChoice.apiKey);
      await new Promise((resolve) => setImmediate(resolve));
      release();
      expect(await Promise.all([old, current])).toEqual([undefined, 'reauthorized-access-renewed']);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      const [saved] = await auth.pickChatEntryGroup();
      expect(saved.apiKey).toBe('reauthorized-access-renewed');
    } finally {
      release();
      await Promise.allSettled([old, ...(current ? [current] : [])]);
    }
  });
it('bounds one coalesced server-rejection refresh and releases later attempts', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const refreshToken = vi.fn((
        _credentials: { access: string; refresh: string; expires: number },
        signal?: AbortSignal,
      ) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      vi.doMock('@earendil-works/pi-ai/oauth', () => {
        const provider = {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          usesCallbackServer: true,
          login: vi.fn(),
          refreshToken,
          getApiKey: (credentials: any) => credentials.access,
        };
        return {
          getOAuthProvider: (id: string) => id === provider.id ? provider : undefined,
          getOAuthProviders: () => [provider],
          registerOAuthProvider: vi.fn(),
        };
      });
      await writeExpiredOAuthEntry({
        providerId: 'openai-codex',
        model: 'gpt-5.5',
        expires: Date.now() + 60 * 60 * 1000,
      });

      const a = await import('../../../src/main/features/auth');
      const [choice] = await a.pickChatEntryGroup();
      const first = choice.refreshApiKey!('expired-access-token');
      const second = choice.refreshApiKey!('expired-access-token');
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'OAUTH_REFRESH_TIMEOUT' });
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'OAUTH_REFRESH_TIMEOUT' });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(observedSignal?.aborted).toBe(false);
      expect(refreshToken).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await Promise.all([firstRejected, secondRejected]);
      expect(observedSignal?.aborted).toBe(true);

      // The timed-out shared promise must leave the profile-level in-flight
      // map so a later user turn can make one fresh recovery attempt.
      const later = choice.refreshApiKey!('expired-access-token');
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      const laterRejected = expect(later).rejects.toMatchObject({ code: 'OAUTH_REFRESH_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(60_000);
      await laterRejected;
    } finally {
      vi.useRealTimers();
    }
  });
it('refreshes an expired OAuth profile once when it backs multiple model entries', async () => {
    const refreshToken = mockOAuthRefreshSuccess('openai-codex', 'OpenAI Codex');
    await writeExpiredOAuthEntry({ providerId: 'openai-codex', model: 'gpt-5.5' });

    const a = await import('../../../src/main/features/auth');
    await a.addEntry({
      provider: 'openai-codex',
      model: 'gpt-5.6-terra',
      profileId: 'openai-codex:default',
    });

    const choices = await a.pickChatEntryGroup();

    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.apiKey)).toEqual([
      'renewed-access-token',
      'renewed-access-token',
    ]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
it('keeps same-model keys in the user order and only moves on when the first is unavailable', async () => {
    const a = await import('../../../src/main/features/auth');
    const fs = await import('node:fs');
    const paths = await import('../../../src/main/paths');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();
    const p1 = await a.addApiKey('anthropic', 'k-1-xxxxxxxxxxx', 'one');
    const p2 = await a.addApiKey('anthropic', 'k-2-xxxxxxxxxxx', 'two');
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p1.profileId });
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: p2.profileId });
    const userOrder = (await a.listEntries()).entries.map((entry) => entry.entryId);
    const file = paths.userAuthProfilesFile(TEST_UID);
    const before = fs.readFileSync(file);

    // Repeated successful picks do not rotate keys or rewrite credentials.
    const first = await a.pickChatEntry();
    const second = await a.pickChatEntry();
    expect(first?.entryId).toBe(userOrder[0]);
    expect(second?.entryId).toBe(userOrder[0]);
    expect((await a.pickChatEntryGroup()).map((choice) => choice.entryId)).toEqual(userOrder);
    expect(fs.readFileSync(file).equals(before)).toBe(true);

    // Only an unavailable first key moves selection to the next one.
    cd.markCooldown(first!.profileId, 'auth', 'mocked 401');
    expect((await a.pickChatEntry())?.entryId).toBe(userOrder[1]);
    cd._clearAll();
  });
});

describe('public availability remediation', () => {
  it('keeps a saved disabled provider visible for deletion without advertising it as selectable', async () => {
    const auth = await import('../../../src/main/features/auth');
    const saved = await auth.addApiKeyEntry('deepseek', 'deepseek-flash', 'synthetic-policy-key');
    await setDeepSeekEnabled(false);
    expect((await auth.listEntries({ includeUnavailable: true })).entries.find(row => row.entryId === saved.entryId))
      .toMatchObject({ selectable: false, availability: 'service_disabled', profileAvailable: true });
    expect((await auth.listComposerEntries()).entries).toEqual([]);
    await auth.removeEntry(saved.entryId);
    expect((await auth.listSettingsEntries()).entries).toEqual([]);
  });
});
