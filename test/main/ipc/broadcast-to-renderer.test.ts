import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => electronMocks.windows,
    getFocusedWindow: () => null,
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
}));

import { broadcastToRenderer } from '../../../src/main/ipc';

beforeEach(() => {
  electronMocks.windows.length = 0;
});

describe('ipc broadcastToRenderer delivery contract', () => {
  it('reports undelivered when no live renderer can show a permission prompt', () => {
    expect(broadcastToRenderer('bash:permission', { request_id: 'req-1' })).toBe(false);
  });

  it('skips destroyed windows and reports success after delivering to a live renderer', () => {
    const destroyedSend = vi.fn();
    const liveSend = vi.fn();
    electronMocks.windows.push(
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
      { isDestroyed: () => false, webContents: { send: liveSend } },
    );

    expect(broadcastToRenderer('bash:permission', { request_id: 'req-2' })).toBe(true);
    expect(destroyedSend).not.toHaveBeenCalled();
    expect(liveSend).toHaveBeenCalledWith('bash:permission', { request_id: 'req-2' });
  });

  it('continues past a broken window and only reports success when another renderer receives it', () => {
    const brokenSend = vi.fn(() => { throw new Error('web contents destroyed'); });
    const liveSend = vi.fn();
    electronMocks.windows.push(
      { isDestroyed: () => false, webContents: { send: brokenSend } },
      { isDestroyed: () => false, webContents: { send: liveSend } },
    );

    expect(broadcastToRenderer('bridge:permission', { request_id: 'req-3' })).toBe(true);
    expect(brokenSend).toHaveBeenCalledOnce();
    expect(liveSend).toHaveBeenCalledWith('bridge:permission', { request_id: 'req-3' });

    electronMocks.windows.splice(1, 1);
    expect(broadcastToRenderer('bridge:permission', { request_id: 'req-4' })).toBe(false);
  });
});
