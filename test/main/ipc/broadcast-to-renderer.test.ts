import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
}));
const captureDeliveredTaskIntervention = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/util/task-intervention-events', () => ({
  captureDeliveredTaskIntervention,
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

const activeUser = vi.hoisted(() => ({ active: true }));
vi.mock('../../../src/main/features/users', () => ({ hasActiveUser: () => activeUser.active, getActiveUserId: () => { if (!activeUser.active) throw Error('No active local user'); return 'broadcast-app-user'; } }));

import { broadcastToRenderer } from '../../../src/main/ipc';
import { appTaskInteractions, clearAppTaskEvents } from '../../../src/main/util/app-task-events';

beforeEach(() => {
  activeUser.active = true;
  electronMocks.windows.length = 0;
  captureDeliveredTaskIntervention.mockClear();
});

describe('ipc broadcastToRenderer delivery contract', () => {
  it('reports undelivered when no live renderer can show a permission prompt', () => {
    expect(broadcastToRenderer('bash:permission', { request_id: 'req-1', cid: 'c1' })).toBe(false);
    expect(captureDeliveredTaskIntervention).not.toHaveBeenCalled();
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
    expect(captureDeliveredTaskIntervention).toHaveBeenCalledOnce();
  });

  it('continues past a broken window and only reports success when another renderer receives it', () => {
    const brokenSend = vi.fn(() => { throw new Error('web contents destroyed'); });
    const liveSend = vi.fn();
    electronMocks.windows.push(
      { isDestroyed: () => false, webContents: { send: brokenSend } },
      { isDestroyed: () => false, webContents: { send: liveSend } },
    );

    expect(broadcastToRenderer('local-agent:permission', { request_id: 'req-3' })).toBe(true);
    expect(brokenSend).toHaveBeenCalledOnce();
    expect(liveSend).toHaveBeenCalledWith('local-agent:permission', { request_id: 'req-3' });

    electronMocks.windows.splice(1, 1);
    expect(broadcastToRenderer('local-agent:permission', { request_id: 'req-4' })).toBe(false);
  });
});


it('keeps an application approval inside its owning task instead of broadcasting it to ordinary windows', () => {
  const cid = `app_${'c'.repeat(64)}_once_${'d'.repeat(32)}`, send = vi.fn();
  electronMocks.windows.push({ isDestroyed: () => false, webContents: { send } });
  try {
    expect(broadcastToRenderer('bash:permission', { cid, request_id: 'app-approval', command: 'controlled operation' })).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(captureDeliveredTaskIntervention).not.toHaveBeenCalled();
    expect(appTaskInteractions('broadcast-app-user', cid)).toEqual([
      { id: 'app-approval', kind: 'bash:permission', payload: { request_id: 'app-approval', command: 'controlled operation' } },
    ]);
    expect(appTaskInteractions('other-user', cid)).toEqual([]);
    expect(broadcastToRenderer('bash:permission', { cid: 'ordinary', request_id: 'ordinary-approval' })).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('bash:permission', { cid: 'ordinary', request_id: 'ordinary-approval' });
  } finally { clearAppTaskEvents('broadcast-app-user', cid); }
});


it('still suppresses a private app prompt before local user activation', () => {
  activeUser.active = false;
  const send = vi.fn(), cid = `app_${'a'.repeat(64)}_once_${'b'.repeat(32)}`;
  electronMocks.windows.push({ isDestroyed: () => false, webContents: { send } });
  try {
    expect(broadcastToRenderer('bash:permission', { request_id: 'private-startup', cid })).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(captureDeliveredTaskIntervention).not.toHaveBeenCalled();
  } finally { clearAppTaskEvents('', cid); }
});
