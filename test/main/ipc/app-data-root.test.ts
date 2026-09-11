import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { openPath: mocks.openPath, showItemInFolder: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-data-root-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  mocks.openPath.mockReset().mockResolvedValue('');
  const users = await import('../../../src/main/features/users');
  users.activateUser('data-root-test');
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadOpen() {
  const { ipcMain } = await import('electron');
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const registered = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'orkas.invoke');
  expect(registered).toBeDefined();
  return (payload = {}) => registered![1]({ sender: trustedIpcSender() } as any, { channel: 'app.openDataRoot', payload });
}

describe('Settings data root opening through IPC', () => {
  it('waits for the OS result and opens only the fixed data root', async () => {
    const invokeOpen = await loadOpen();
    const pending = Promise.withResolvers<string>();
    mocks.openPath.mockReturnValueOnce(pending.promise);
    let settled = false;
    const result = invokeOpen({ path: '/unrelated/caller/path' }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith(tmpDir));
    expect(settled).toBe(false);
    pending.resolve('');
    expect(await result).toMatchObject({ ok: true, path: tmpDir });
    expect(mocks.openPath).toHaveBeenCalledTimes(1);
  });

  it.each(['refusal', 'exception'])('reports an OS %s as failure and permits a subsequent successful attempt', async (kind) => {
    const invokeOpen = await loadOpen();
    const nativeError = 'OS failed to open /private/user/data';
    if (kind === 'exception') mocks.openPath.mockRejectedValueOnce(new Error(nativeError));
    else mocks.openPath.mockResolvedValueOnce(nativeError);
    const result = await invokeOpen();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_DATA_ROOT_OPEN');
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('/private/user/data');
    expect(mocks.log.warn).toHaveBeenCalledWith('invoke returned failure', expect.objectContaining({
      channel: 'app.openDataRoot', code: 'E_DATA_ROOT_OPEN',
    }));
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('/private/user/data');
    expect(mocks.log.error).not.toHaveBeenCalled();
    expect(await invokeOpen()).toMatchObject({ ok: true, path: tmpDir });
  });
});
