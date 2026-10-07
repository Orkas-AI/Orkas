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
    expect(profileIds(providers)).not.toContain('openai:invalid-model');
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
    expect(profileIds(await call('auth.listProviders'))).toEqual([]);
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
        id: 'doubao:doubao-seedream-5-0-lite-260128',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-lite-260128',
        label: 'DouBao · Seedream 5.0 Lite',
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

});
