import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Capture the `orkas.invoke` handler that register() attaches to ipcMain,
// so we can drive it the same way renderer → preload → ipcMain would.
type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

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
  return invokeHandler({}, { channel, payload });
}

describe('ipc › permissions.* routes', () => {
  it('permissions.getLocalExec defaults to granted on a fresh install', async () => {
    const res = await call('permissions.getLocalExec');
    expect(res.ok).toBe(true);
    expect(res.granted).toBe(true);
  });

  it('permissions.grantLocalExec flips the flag and persists', async () => {
    const res = await call('permissions.grantLocalExec');
    expect(res.ok).toBe(true);
    expect(res.granted).toBe(true);
    expect(typeof res.grantedAt).toBe('string');

    const after = await call('permissions.getLocalExec');
    expect(after.granted).toBe(true);
  });

  it('permissions.revokeLocalExec clears the flag', async () => {
    await call('permissions.grantLocalExec');
    const res = await call('permissions.revokeLocalExec');
    expect(res.ok).toBe(true);
    expect(res.granted).toBe(false);
    expect(typeof res.revokedAt).toBe('string');
  });

  it('permissions.getLocalExec returns the mode and defaults to risk_prompt', async () => {
    const res = await call('permissions.getLocalExec');
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('risk_prompt');
  });

  it('permissions.setLocalExecMode persists a valid mode and is read back', async () => {
    const res = await call('permissions.setLocalExecMode', { mode: 'allow_all' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('allow_all');
    expect(res.granted).toBe(true);

    const after = await call('permissions.getLocalExec');
    expect(after.mode).toBe('allow_all');
  });

  it('permissions.setLocalExecMode rejects an invalid mode', async () => {
    const res = await call('permissions.setLocalExecMode', { mode: 'bogus' });
    expect(res.ok).toBe(false);
  });

  it('unknown permissions.* channel surfaces the router fallback error', async () => {
    // Regression guard: this is the exact symptom that made "授权本机工具"
    // look dead — when a handler is missing, the router returns
    // { ok: false, error: 'unknown channel: ...' } and settings.js's
    // `if (res && res.ok)` silently no-ops. Make sure the three real
    // channels above never hit this path again.
    const res = await call('permissions.doesNotExist');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown channel/);
  });
});
