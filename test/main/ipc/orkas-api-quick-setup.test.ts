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
});
