import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string; code?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'u_cache_owner';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.6.2'),
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cache-clearable-ipc-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
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
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › clearable cache', () => {
  it('lists and clears only the authenticated account cache through the public IPC contract', async () => {
    const paths = await import('../../../src/main/paths');
    const ownBucket = path.join(paths.userLocalCacheDir(TEST_UID), 'marketplace');
    const otherBucket = path.join(paths.userLocalCacheDir('u_other'), 'marketplace');
    fs.mkdirSync(ownBucket, { recursive: true });
    fs.mkdirSync(otherBucket, { recursive: true });
    fs.writeFileSync(path.join(ownBucket, 'own.bin'), Buffer.alloc(7));
    fs.writeFileSync(path.join(otherBucket, 'other.bin'), Buffer.alloc(11));

    await expect(call('cache.listClearable')).resolves.toMatchObject({
      ok: true,
      list: [{ name: 'marketplace', bytes: 7 }],
    });
    await expect(call('cache.clearAll')).resolves.toEqual({
      ok: true,
      bytes_freed: 7,
    });
    expect(fs.existsSync(ownBucket)).toBe(false);
    expect(fs.readFileSync(path.join(otherBucket, 'other.bin'))).toHaveLength(11);
  });

  it('returns a stable rejection for unsafe bucket names without touching cache data', async () => {
    const paths = await import('../../../src/main/paths');
    const bucket = path.join(paths.userLocalCacheDir(TEST_UID), 'marketplace');
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, 'keep.bin'), 'keep');

    await expect(call('cache.clearBucket', { name: '../marketplace' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid bucket name',
    });
    expect(fs.readFileSync(path.join(bucket, 'keep.bin'), 'utf8')).toBe('keep');
  });

  it('rejects unsafe marketplace ids before a cache read can escape into local config', async () => {
    const paths = await import('../../../src/main/paths');
    const configFile = path.join(paths.userLocalConfigDir(TEST_UID), 'private.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, 'must-not-cross-ipc', 'utf8');

    await expect(call('marketplace.cacheSkillRead', {
      id: '../../../config',
      file: 'private.json',
    })).resolves.toMatchObject({
      ok: false,
      error: 'invalid marketplace id',
    });
    expect(fs.readFileSync(configFile, 'utf8')).toBe('must-not-cross-ipc');
  });

  it('rejects unsafe marketplace ids before uninstall can delete local config', async () => {
    const paths = await import('../../../src/main/paths');
    const configFile = path.join(paths.userLocalConfigDir(TEST_UID), 'private.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, 'keep-after-uninstall', 'utf8');

    await expect(call('marketplace.uninstallSkill', {
      id: '../../config',
    })).resolves.toMatchObject({
      ok: false,
      error: 'invalid marketplace id',
    });
    expect(fs.readFileSync(configFile, 'utf8')).toBe('keep-after-uninstall');
  });
});
