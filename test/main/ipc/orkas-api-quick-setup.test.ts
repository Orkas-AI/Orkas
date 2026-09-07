import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-model-ipc-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser('u_model_config');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function call(channel: string, payload: unknown = {}): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler(
    { sender: trustedIpcSender() },
    { channel, payload },
  );
}

describe('ipc › Orkas API quick setup', () => {
  it('returns the Orkas model to the composer immediately after quick setup', async () => {
    expect(await call('orkasApi.configureAll', {
      apiKey: 'orkas-composer-ipc-key-xxxxxxxx',
    })).toMatchObject({ ok: true, configured: true });

    expect(await call('auth.listComposerEntries')).toMatchObject({
      ok: true,
      entries: [
        expect.objectContaining({
          provider: 'orkas-api',
          model: 'orkas-llm-1.5',
          modelName: 'Orkas-1.5',
          official: true,
          profileLabel: 'Orkas',
          recommended: true,
          profileAvailable: true,
        }),
        expect.objectContaining({
          provider: 'orkas-api',
          model: 'orkas-llm-1.5-pro',
          modelName: 'Orkas-1.5 Pro',
          official: true,
          profileLabel: 'Orkas',
          profileAvailable: true,
        }),
      ],
    });

    expect(await call('imageAuth.list')).toMatchObject({
      ok: true,
      providers: expect.arrayContaining([
        expect.objectContaining({ id: 'orkas-api', label: 'Orkas · Image' }),
      ]),
      profiles: expect.arrayContaining([
        expect.objectContaining({ provider: 'orkas-api', model: 'orkas-image' }),
      ]),
    });
    expect(await call('ttsAuth.list')).toMatchObject({
      ok: true,
      presets: expect.arrayContaining([
        expect.objectContaining({ id: 'orkas-api', label: 'Orkas · Voice' }),
      ]),
      profiles: expect.arrayContaining([
        expect.objectContaining({ provider: 'orkas-api', model: 'orkas-tts-1' }),
      ]),
    });
    expect(await call('searchAuth.list')).toMatchObject({
      ok: true,
      profiles: expect.arrayContaining([expect.objectContaining({ provider: 'orkas-api' })]),
    });
  });

  it('saves, replaces and deletes the shared key offline without exposing it or revoking remote connections', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../../../src/main/features/auth');
    const registry = await import('../../../src/main/features/connectors/registry');
    const { CONNECTOR_CATALOG } = await import('../../../src/main/features/connectors/catalog');
    CONNECTOR_CATALOG.push({ id: 'offline-paid', auth_mode: 'composio' } as any);
    const seedConnection = async () => registry.upsert('u_model_config', {
      id: 'offline-paid', display_name: 'Paid', origin: 'catalog',
      transport: { kind: 'stdio', command: 'node', args: [] },
      enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
      status: { kind: 'connected' }, created_at: '', updated_at: '',
    } as any);

    const firstKey = 'orkas-connector-key-xxxxxxxx';
    const saved = await call('orkasApi.save', { apiKey: firstKey });
    expect(saved).toMatchObject({ ok: true, configured: true });
    expect(JSON.stringify(saved)).not.toContain(firstKey);
    expect(auth.getOrkasApiKey()).toBe(firstKey);
    expect(await call('orkasApi.getStatus')).toMatchObject({
      ok: true, configured: true, keyMasked: saved.keyMasked,
    });

    await seedConnection();
    expect(await call('orkasApi.save', { apiKey: 'replacement-key-xxxxxxxx' }))
      .toMatchObject({ ok: true, configured: true });
    expect(auth.getOrkasApiKey()).toBe('replacement-key-xxxxxxxx');
    expect(registry.load('u_model_config').connections['offline-paid']).toBeUndefined();

    await seedConnection();
    expect(await call('orkasApi.remove')).toMatchObject({ ok: true, removed: true });
    expect(await call('orkasApi.getStatus')).toMatchObject({ ok: true, configured: false });
    expect(registry.load('u_model_config').connections['offline-paid']).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects blank or header-unsafe input locally while preserving the saved key', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(await call('orkasApi.save', { apiKey: 'existing-key-xxxxxxxx' }))
      .toMatchObject({ ok: true, configured: true });
    for (const apiKey of ['', 'unsafe\r\nheader']) {
      expect(await call('orkasApi.save', { apiKey })).toMatchObject({ ok: false });
    }
    const auth = await import('../../../src/main/features/auth');
    expect(auth.getOrkasApiKey()).toBe('existing-key-xxxxxxxx');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
