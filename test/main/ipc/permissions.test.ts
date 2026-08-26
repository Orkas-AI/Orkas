import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

// Capture the `orkas.invoke` handler that register() attaches to ipcMain,
// so we can drive it the same way renderer → preload → ipcMain would.
type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

const notificationPermissionMocks = vi.hoisted(() => ({
  getSystemNotificationPermission: vi.fn(async () => ({
    state: 'granted',
    can_open_settings: true,
  })),
  openSystemNotificationSettings: vi.fn(async () => true),
}));

vi.mock('../../../src/main/features/notification_permissions', () => notificationPermissionMocks);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-perm-ipc-'));
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

describe('ipc › permissions.* routes', () => {
  it('rejects calls from any sender other than the renderer entry document', async () => {
    if (!invokeHandler) throw new Error('invoke handler not registered');
    const res = await invokeHandler(
      { sender: { getURL: () => 'https://evil.example/index.html' } },
      { channel: 'permissions.getLocalExec', payload: {} },
    );
    expect(res).toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
  });

  it('rejects malformed envelopes before routing a privileged call', async () => {
    if (!invokeHandler) throw new Error('invoke handler not registered');
    const res = await invokeHandler(
      { sender: trustedIpcSender() },
      { channel: '../permissions.getLocalExec', payload: [] },
    );
    expect(res).toMatchObject({ ok: false, code: 'E_IPC_REQUEST' });
  });

  it('permissions.getLocalExec returns the mode and defaults to all_files_approval', async () => {
    const res = await call('permissions.getLocalExec');
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('all_files_approval');
    expect(res).not.toHaveProperty('granted');
  });

  it('permissions.setLocalExecMode persists a valid mode and is read back', async () => {
    const res = await call('permissions.setLocalExecMode', { mode: 'all_files_approval' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('all_files_approval');

    const after = await call('permissions.getLocalExec');
    expect(after.mode).toBe('all_files_approval');
  });

  it.each(['permissions.grantLocalExec', 'permissions.revokeLocalExec'])(
    'retires the obsolete %s route',
    async (channel) => {
      const res = await call(channel);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/unknown channel/);
    },
  );

  it('permissions.setLocalExecMode rejects an invalid mode', async () => {
    const res = await call('permissions.setLocalExecMode', { mode: 'bogus' });
    expect(res.ok).toBe(false);
  });

  it('persists task-notification preference without waiting for the platform permission probe', async () => {
    notificationPermissionMocks.getSystemNotificationPermission.mockClear();

    const res = await call('prefs.setTaskNotifications', { enabled: false });

    expect(res).toMatchObject({ ok: true, enabled: false });
    expect(notificationPermissionMocks.getSystemNotificationPermission).not.toHaveBeenCalled();
  });

  it('unknown permissions.* channel surfaces the router fallback error', async () => {
    const res = await call('permissions.doesNotExist');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown channel/);
  });
});
