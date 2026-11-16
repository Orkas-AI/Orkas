import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '9.8.7'),
    on: vi.fn(),
    off: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u_model_config';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-model-config-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);

  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function call(channel: string, payload: unknown = {}): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

function profileProviders(res: Record<string, unknown>): string[] {
  return ((res.profiles || []) as Array<{ provider?: string }>).map((p) => String(p.provider || ''));
}

function profileIds(res: Record<string, unknown>): string[] {
  return ((res.profiles || []) as Array<{ id?: string }>).map((p) => String(p.id || ''));
}

function credentialProfileIds(res: Record<string, unknown>): string[] {
  expect(Array.isArray(res.providers)).toBe(true);
  return (res.providers as Array<{ profiles: Array<{ profileId: string }> }>)
    .flatMap(provider => provider.profiles.map(profile => profile.profileId));
}

function profileByProvider(res: Record<string, unknown>, provider: string): Record<string, unknown> | undefined {
  return ((res.profiles || []) as Array<Record<string, unknown>>)
    .find((profile) => profile.provider === provider);
}

function imageProfiles(res: Record<string, unknown>): Array<{ provider?: string; model?: string }> {
  return (res.profiles || []) as Array<{ provider?: string; model?: string }>;
}

function entryProviders(res: Record<string, unknown>): string[] {
  return ((res.entries || []) as Array<{ provider?: string }>).map((entry) => String(entry.provider || ''));
}

describe('ipc › model config auth lists', () => {
it('pins new domestic credentials through protected IPC while preserving saved global credentials', async () => {
    const auth = await import('../../../src/main/features/auth');
    const retained = { id: 'global', provider: 'minimax', model: 'MiniMax-H3', apiKey: 'saved-global-key', label: 'old', createdAt: 1 };
    auth.saveVideoProfiles([retained]);
    expect(await call('videoAuth.add', { provider: 'minimax', model: 'MiniMax-H3', apiKey: 'new-domestic-key', apiSite: 'global' })).toMatchObject({ ok: true });
    expect(auth.loadVideoProfiles()).toEqual(expect.arrayContaining([
      retained, expect.objectContaining({ provider: 'minimax', apiKey: 'new-domestic-key', apiSite: 'cn' }),
    ]));
    const list = await call('videoAuth.list');
    expect(JSON.stringify(list)).not.toContain('new-domestic-key');
    expect((list.providers as any[]).find(p => p.provider === 'minimax')?.docs).toBe('https://platform.minimax.cn/docs/guides/quickstart-preparation');
  });
it('uses an opaque mask for Cloud service-account JSON without returning credential fragments', async () => {
    const auth = await import('../../../src/main/features/auth');
    auth.saveVideoProfiles([{ id: 'cloud', provider: 'google-cloud', model: 'veo-3.1-generate-001', apiKey: '{"private_key":"PRIVATE-FIXTURE-FRAGMENT"}', label: 'cloud', createdAt: 1 }]);
    const list = await call('videoAuth.list');
    expect(profileByProvider(list, 'google-cloud')).toMatchObject({ apiKeyMasked: '********' });
    expect(JSON.stringify(list)).not.toContain('PRIVATE-FIXTURE');
  });
it('round-trips the current Wan tier through protected IPC and keeps regional credentials private', async () => {
    const initial = await call('videoAuth.list');
    // Frozen native capability contract has20 choices; the public API adds one.
    expect(initial.providers).toHaveLength(21);
    const added = await call('videoAuth.add', { provider: 'aliyun', model: 'wan3.0-video-prime', apiKey: 'private-wan-key', workspaceId: 'workspace123', region: 'ap-southeast-1' });
    expect(added.ok).toBe(true);
    const list = await call('videoAuth.list');
    expect(profileByProvider(list, 'aliyun')).toMatchObject({ provider: 'aliyun', model: 'wan3.0-video-prime' });
    expect(JSON.stringify(list)).not.toContain('private-wan-key');
    const auth = await import('../../../src/main/features/auth');
    expect(auth.loadVideoProfiles().find(p => p.provider === 'aliyun')).toMatchObject({ workspaceId: 'workspace123', region: 'ap-southeast-1' });
  });
it('retains a retired Gemini Veo profile visibly unavailable without exposing it for new configuration', async () => {
    const auth = await import('../../../src/main/features/auth');
    auth.saveVideoProfiles([{ id: 'retired', provider: 'google', model: 'veo-3.1-generate-preview', apiKey: 'retired-key', label: 'old', createdAt: 1 }]);
    const list = await call('videoAuth.list');
    expect(profileByProvider(list, 'google')).toMatchObject({ id: 'retired', selectable: false, availability: 'model_unavailable' });
    expect((list.providers as any[]).some(p => p.model === 'veo-3.1-generate-preview')).toBe(false);
  });

  it('persists the selected Anthropic protocol and gateway prefix through settings IPC', async () => {
    const added = await call('auth.addCustomModelEntry', {
      protocol: 'anthropic', baseUrl: 'https://gateway.example.test/proxy/v1/messages',
      model: 'claude-gateway-alias', apiKey: 'synthetic-ipc-protocol',
    });
    expect(added.ok).toBe(true);
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.pickChatEntryGroup())[0]?.customConfig).toMatchObject({
      protocol: 'anthropic', baseUrl: 'https://gateway.example.test/proxy',
    });
  });

  it('selects a custom entry and its catalog model version through one IPC call', async () => {
    const profile = await call('auth.addApiKey', {
      provider: 'openai',
      apiKey: 'sk-composer-version-ipc-test',
      label: 'composer-version',
    });
    const entry = await call('auth.addEntry', {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileId: profile.profileId,
    });

    const selected = await call('auth.selectEntry', {
      entryId: entry.entryId,
      model: 'gpt-5.6-terra',
    });
    expect(selected).toMatchObject({
      ok: true,
      entries: [expect.objectContaining({
        entryId: entry.entryId,
        model: 'gpt-5.6-terra',
        modelName: 'GPT-5.6 Terra',
      })],
    });
  });

  it('keeps the renderer model guard closed without replacing an unreadable credential store', async () => {
    const paths = await import('../../../src/main/paths');
    const storePath = paths.userAuthProfilesFile(TEST_UID);
    const unreadable = 'credential-store-recovery-sentinel';
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, unreadable, 'utf8');

    expect(await call('auth.hasConfiguredModel')).toMatchObject({
      ok: true,
      configured: false,
    });
    expect(fs.readFileSync(storePath, 'utf8')).toBe(unreadable);
  });

  it('persists a newly added user model without managed fallback entries', async () => {
    const added = await call('auth.addApiKeyEntry', {
      provider: 'openai',
      model: 'gpt-5.5',
      apiKey: 'sk-model-test-key',
      label: 'default',
    });
    expect(added.ok).toBe(true);

    expect(entryProviders(await call('auth.listEntries'))).toEqual(['openai']);
  });

  it('rejects an unavailable model without leaving a credential-only partial save', async () => {
    const added = await call('auth.addApiKeyEntry', {
      provider: 'openai',
      apiKey: 'sk-invalid-model-test-key',
      label: 'invalid-model',
      model: 'gpt-not-listed',
    });
    expect(added).toMatchObject({ ok: false, code: 'MODEL_NOT_AVAILABLE' });
    expect(entryProviders(await call('auth.listEntries'))).toEqual([]);
    const providers = await call('auth.listProviders');
    expect(credentialProfileIds(providers)).not.toContain('openai:invalid-model');
  });

  it('adds a custom OpenAI-compatible model through one atomic IPC command', async () => {
    const added = await call('auth.addCustomModelEntry', {
      baseUrl: 'https://gateway.example.test/v1/chat/completions',
      model: 'acme/reasoner-v2',
      apiKey: 'sk-custom-ipc-test-key',
    });
    expect(added).toMatchObject({ ok: true, profileId: 'custom:default' });

    expect(await call('auth.listEntries')).toMatchObject({
      ok: true,
      entries: [
        expect.objectContaining({
          provider: 'custom',
          model: 'acme/reasoner-v2',
          modelName: 'acme/reasoner-v2',
          modelEditable: false,
          profileMasked: 'sk-c…-key',
        }),
      ],
    });
  });

  it('returns a stable error for an invalid custom API key without a partial save', async () => {
    const added = await call('auth.addCustomModelEntry', {
      baseUrl: 'https://gateway.example.test/v1',
      model: 'acme/reasoner-v2',
      apiKey: 'щ-custom-key',
    });
    expect(added).toMatchObject({ ok: false, code: 'CUSTOM_API_KEY_INVALID' });
    expect(entryProviders(await call('auth.listEntries'))).toEqual([]);
    expect(credentialProfileIds(await call('auth.listProviders'))).toEqual([]);
  });

  it('returns unavailable saved models only for the Settings remediation query', async () => {
    const apiKey = await call('auth.addApiKey', {
      provider: 'openai',
      apiKey: 'sk-removed-model-test-key',
      label: 'removed-model',
    });
    const added = await call('auth.addEntry', {
      provider: 'openai',
      model: 'gpt-5.6-terra',
      profileId: apiKey.profileId,
    });
    expect(added.ok).toBe(true);

    const { clientConfig } = await import('../../../src/main/features/client_config');
    clientConfig.applyServerPayload({
      immediate: {
        model_catalog: {
          providers: {
            openai: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
          },
        },
      },
      restart: {},
      config_hash: 'sha256:ipc-model-removal',
    }, '"ipc-model-removal"');

    expect(entryProviders(await call('auth.listEntries'))).toEqual([]);
    const remediation = await call('auth.listEntries', { includeUnavailable: true });
    expect(remediation.entries).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.6-terra',
        modelAvailable: false,
      }),
    ]);
  });

  it('lists and persists the selected Doubao Seedream 5.0 image model', async () => {
    const initial = await call('imageAuth.list');
    expect(initial.modelsByProvider).toBeUndefined();
    expect(initial.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'doubao:doubao-seedream-5-0-flash-260915',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-flash-260915',
        label: 'DouBao · Seedream 5.0 Flash',
      }),
      expect.objectContaining({
        id: 'doubao:doubao-seedream-5-0-pro-260628',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-pro-260628',
        label: 'DouBao · Seedream 5.0 Pro',
      }),
    ]));

    const added = await call('imageAuth.add', {
      provider: 'doubao',
      model: 'doubao-seedream-5-0-pro-260628',
      apiKey: 'doubao-image-test-key',
      label: 'pro',
    });
    expect(added.ok).toBe(true);

    const profiles = imageProfiles(await call('imageAuth.list'));
    expect(profiles[0]).toMatchObject({
      provider: 'doubao',
      model: 'doubao-seedream-5-0-pro-260628',
    });
    expect(profiles.every((profile) => profile.provider === 'doubao')).toBe(true);
  });

  it('saves all six native TTS configurations through IPC, reopens them and isolates another local user', async () => {
    const initial = await call('ttsAuth.list');
    const presets = initial.presets as Array<{ id: string; models?: Array<{ id: string }> }>;
    expect(presets.map(p => p.id)).toEqual(expect.arrayContaining(['doubao', 'minimax', 'aliyun', 'google', 'elevenlabs', 'openai']));
    const variants = [
      ['doubao', '', 'zh_female_vv_uranus_bigtts'],
      ['minimax', 'speech-2.8-hd', 'male-qn-qingse'],
      ['minimax', 'speech-2.8-turbo', 'male-qn-qingse'],
      ['aliyun', 'qwen-audio-3.1-tts-plus', 'longanhuan_v3.1'],
      ['aliyun', 'qwen-audio-3.1-tts-flash', 'longanhuan_v3.1'],
      ['aliyun', 'cosyvoice-v3.5-flash', 'enrolled-voice'],
      ['aliyun', 'cosyvoice-v3.5-plus', 'enrolled-voice'],
      ['google', 'gemini-3.8-flash-tts', 'Kore'],
      ['google', 'gemini-3.8-flash-lite-tts', 'Kore'],
      ['elevenlabs', 'eleven_v4', 'enrolled-voice'],
      ['elevenlabs', 'eleven_v4_turbo', 'enrolled-voice'],
      ['openai', 'gpt-4o-mini-tts', 'alloy'],
    ];
    const ids: string[] = [];
    for (const [provider, model, voice] of variants) {
      const result = await call('ttsAuth.add', { provider, model, voice, apiKey: 'fixture-tts-private-key', workspaceId: 'workspace-123' });
      expect(result.ok, `${provider}/${model}`).toBe(true); ids.push(String(result.id));
    }
    const saved = await call('ttsAuth.list');
    expect(JSON.stringify(saved)).not.toContain('fixture-tts-private-key');
    const ali = (saved.profiles as any[]).find(p => p.provider === 'aliyun');
    expect(ali).toMatchObject({ workspaceId: 'workspace-123', baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com' });
    const auth = await import('../../../src/main/features/auth');
    expect(auth.loadTtsProfiles().filter(p => p.provider === 'google').map(p => p.format)).toEqual(['wav', 'wav']);
    const users = await import('../../../src/main/features/users');
    users.activateUser('different-tts-user');
    expect(auth.loadTtsProfiles()).toEqual([]);
    users.activateUser(TEST_UID);
    expect(auth.loadTtsProfiles()).toHaveLength(variants.length);
    expect((await call('ttsAuth.reorder', { orderedIds: ids })).ok).toBe(true);
    expect(profileIds(await call('ttsAuth.list')).slice(0, ids.length)).toEqual(ids);
    for (const id of ids) expect((await call('ttsAuth.remove', { id })).ok).toBe(true);
    expect(profileProviders(await call('ttsAuth.list'))).toEqual([]);
  });

  it('rejects invalid native speech setup before persisting a route', async () => {
    for (const payload of [
      { provider: 'aliyun', model: 'qwen-audio-3.1-tts-plus', workspaceId: 'bad/host' },
      { provider: 'aliyun', model: 'cosyvoice-v3.5-plus', workspaceId: 'workspace' },
      { provider: 'google', model: 'gemini-chat-model', voice: 'Kore' },
      { provider: 'minimax', model: 'speech-2.8-hd', format: 'aac' },
    ]) expect((await call('ttsAuth.add', { apiKey: 'fixture-key', ...payload })).ok).toBe(false);
    expect(profileProviders(await call('ttsAuth.list'))).toEqual([]);
  });

  it('reopens native PCM/Opus configurations and rejects unsupported Doubao formats without a partial save', async () => {
    for (const provider of ['doubao', 'minimax']) {
      for (const format of ['pcm', 'opus']) {
        const result = await call('ttsAuth.add', { provider, model: provider === 'minimax' ? 'speech-2.8-hd' : '',
          apiKey: 'fixture-key', format });
        expect(result.ok).toBe(true);
      }
    }
    const auth = await import('../../../src/main/features/auth');
    expect(auth.loadTtsProfiles().filter(p => p.provider === 'doubao').map(p => p.format)).toEqual(['opus', 'pcm']);
    expect(auth.loadTtsProfiles().filter(p => p.provider === 'minimax').map(p => p.format)).toEqual(['opus', 'pcm']);
    const before = auth.loadTtsProfiles();
    expect((await call('ttsAuth.add', { provider: 'doubao', apiKey: 'fixture-key', format: 'flac' })).ok).toBe(false);
    expect(auth.loadTtsProfiles()).toEqual(before);
  });

  it('persists Responses selection through protected settings IPC without a hosted model identity', async () => {
    expect((await call('auth.addCustomModelEntry', {
      protocol: 'responses', baseUrl: 'https://gateway.example.test/proxy/v1/responses',
      model: 'public-responses-fixture', apiKey: 'synthetic-responses-ipc',
    })).ok).toBe(true);
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.pickChatEntryGroup())[0]?.customConfig).toMatchObject({
      protocol: 'responses', baseUrl: 'https://gateway.example.test/proxy/v1',
    });
  });

  it('reopens and prioritizes configured DeepSeek search through protected IPC without exposing keys', async () => {
    const initial = await call('searchAuth.list');
    expect((initial.providers as Array<{ id: string }>).map(provider => provider.id))
      .toEqual(['orkas-api', 'tavily', 'deepseek', 'serper', 'brave-search', 'baidu-ai-search', 'metaso']);
    expect(initial.providers).toContainEqual(expect.objectContaining({
      id: 'deepseek', label: 'DeepSeek', docs: 'https://api-docs.deepseek.com/guides/search/',
    }));
    expect(initial.profiles).toEqual([]);
    const key = 'synthetic-deepseek-search-key';
    const added = await call('searchAuth.add', { provider: 'deepseek', apiKey: key, label: 'Research' });
    expect(added.ok).toBe(true);
    expect((await call('searchAuth.add', { provider: 'deepseek', apiKey: key })).id).toBe(added.id);
    const listed = await call('searchAuth.list');
    expect(profileProviders(listed)).toEqual(['deepseek']);
    expect(profileByProvider(listed, 'deepseek')).toMatchObject({ label: 'Research', apiKeyMasked: expect.any(String) });
    expect(JSON.stringify(listed)).not.toContain(key);
    vi.resetModules();
    (await import('../../../src/main/features/users')).activateUser(TEST_UID);
    const searchAuth = await import('../../../src/main/features/search_auth');
    expect(searchAuth.pickActiveSearchProfile()).toMatchObject({ provider: 'deepseek', apiKey: key });
    const peer = await call('searchAuth.add', { provider: 'tavily', apiKey: 'synthetic-tavily-key' });
    expect(peer.ok).toBe(true);
    expect(searchAuth.pickActiveSearchProfile()?.provider).toBe('tavily');
    expect(await call('searchAuth.reorder', { orderedIds: [String(added.id), String(peer.id)] })).toMatchObject({ ok: true });
    expect(searchAuth.pickActiveSearchProfile()?.provider).toBe('deepseek');
    expect(await call('searchAuth.remove', { id: String(added.id) })).toMatchObject({ ok: true });
    expect(searchAuth.pickActiveSearchProfile()?.provider).toBe('tavily');
    expect(await call('searchAuth.remove', { id: String(peer.id) })).toMatchObject({ ok: true });
    expect(profileProviders(await call('searchAuth.list'))).toEqual([]);
  });

  it('exposes every frozen native video choice and the retained public API through protected IPC', async () => {
    const { ORKAS_API_PROVIDER, ORKAS_API_VIDEO_MODEL } = await import('../../../src/main/features/orkas_api');
    const result = await call('videoAuth.list');
    const providers = result.providers as Array<{ provider: string; model: string; label: string }>;
    // Independent frozen source contract:20 native choices, including current
    // Gemini Omni; the older Gemini Veo saved identity remains retired.
    const expected = [
  [
    "doubao",
    "doubao-seedance-2-5-260628",
    "Doubao Seedance 2.5"
  ],
  [
    "doubao",
    "doubao-seedance-2-5-flash",
    "Doubao Seedance 2.5 Flash"
  ],
  [
    "doubao",
    "doubao-seedance-2-0-260128",
    "Doubao Seedance 2.0"
  ],
  [
    "doubao",
    "doubao-seedance-2-0-fast-260128",
    "Doubao Seedance 2.0 Fast"
  ],
  [
    "doubao",
    "doubao-seedance-2-0-mini",
    "Doubao Seedance 2.0 Mini"
  ],
  [
    "minimax",
    "MiniMax-H3",
    "MiniMax H3"
  ],
  [
    "minimax",
    "MiniMax-H3-Highspeed",
    "MiniMax H3 Highspeed"
  ],
  [
    "minimax",
    "MiniMax-H3-Lite",
    "MiniMax H3 Lite"
  ],
  [
    "minimax",
    "MiniMax-H3-Max",
    "MiniMax H3 Max"
  ],
  [
    "vidu",
    "viduq3-pro",
    "Vidu Q3 Pro"
  ],
  [
    "vidu",
    "viduq3-turbo",
    "Vidu Q3 Turbo"
  ],
  [
    "kling",
    "kling-v4-0",
    "Kling 4.0"
  ],
  [
    "kling",
    "kling-v4-0-flash",
    "Kling 4.0 Flash"
  ],
  [
    "google",
    "gemini-omni-1.1-flash",
    "Google Gemini Omni 1.1 Flash"
  ],
  [
    "google-cloud",
    "veo-3.1-generate-001",
    "Google Cloud Veo 3.1"
  ],
  [
    "google-cloud",
    "veo-3.1-fast-generate-001",
    "Google Cloud Veo 3.1 Fast"
  ],
  [
    "google-cloud",
    "veo-3.1-lite-generate-001",
    "Google Cloud Veo 3.1 Lite"
  ],
  [
    "runway",
    "gen4.5",
    "Runway Gen-4.5"
  ],
  [
    "aliyun",
    "wan3.0-video",
    "Alibaba Cloud Wan 3.0"
  ],
  [
    "aliyun",
    "wan3.0-video-prime",
    "Alibaba Cloud Wan 3.0 Prime"
  ]
];
    expect(providers.filter(p => p.provider !== ORKAS_API_PROVIDER)
      .map(p => [p.provider, p.model, p.label]).sort()).toEqual(expected.sort());
    expect(providers.filter(p => p.provider === ORKAS_API_PROVIDER))
      .toEqual([expect.objectContaining({ model: ORKAS_API_VIDEO_MODEL })]);
    expect(new Set(providers.map(p => p.provider))).toEqual(new Set([
      ORKAS_API_PROVIDER, 'doubao', 'minimax', 'vidu', 'kling', 'google', 'google-cloud', 'aliyun', 'runway',
    ]));
  });

  it('keeps unavailable storage slots and remediation rows while protected IPC reorders runnable models', async () => {
    const first = await call('auth.addCustomModelEntry', { model: 'ipc-first',
      baseUrl: 'https://ipc-priority.invalid/v1', apiKey: 'synthetic-first', contextWindow: 32000, maxTokens: 8192 });
    const second = await call('auth.addCustomModelEntry', { model: 'ipc-second', label: 'second',
      baseUrl: 'https://ipc-priority.invalid/v1', apiKey: 'synthetic-second', contextWindow: 32000, maxTokens: 8192 });
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    const paths = await import('../../../src/main/paths');
    const secrets = await import('../../../src/main/util/local-secret-store');
    const file = paths.userAuthProfilesFile(TEST_UID);
    const context = { namespace: 'auth.profiles', ownerId: TEST_UID, recordId: 'auth-profiles.json' };
    const store = JSON.parse(secrets.decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
    const one = store.entries.find((entry: { entryId: string }) => entry.entryId === first.entryId);
    const two = store.entries.find((entry: { entryId: string }) => entry.entryId === second.entryId);
    store.profiles['custom:ipc-small'] = { ...store.profiles[String(first.profileId)], contextWindow: 31999 };
    store.entries = [one, { ...one, entryId: 'small-slot', profileId: 'custom:ipc-small' },
      two, { ...one, entryId: 'missing-slot', profileId: 'custom:ipc-missing' }];
    fs.writeFileSync(file, secrets.encryptLocalSecret(context, JSON.stringify(store)));
    const result = await call('auth.reorderEntries', {
      orderedIds: [second.entryId, 'small-slot', 'missing-slot', first.entryId, second.entryId, 'unknown'],
    });
    const ordered = [second.entryId, 'small-slot', first.entryId, 'missing-slot'];
    expect(result.ok).toBe(true);
    expect((result.entries as Array<{ entryId: string }>).map(entry => entry.entryId)).toEqual(ordered);
    const persisted = JSON.parse(secrets.decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
    expect(persisted.entries.map((entry: { entryId: string }) => entry.entryId)).toEqual(ordered);
    const available = await call('auth.listEntries');
    expect(available.ok).toBe(true);
    expect((available.entries as Array<{ entryId: string }>).map(entry => entry.entryId)).toEqual([second.entryId, first.entryId]);
    expect((result.entries as Array<{ entryId: string; availability: string }>).find(entry => entry.entryId === 'small-slot'))
      .toMatchObject({ availability: 'context_too_small' });
    expect((result.entries as Array<{ entryId: string; availability: string }>).find(entry => entry.entryId === 'missing-slot'))
      .toMatchObject({ availability: 'credential_missing' });
  });

});
