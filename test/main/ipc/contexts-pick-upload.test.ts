import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
}));

vi.mock('../../../src/main/features/kb_vector', () => ({
  findBySha1: vi.fn(() => null),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uContextPickUpload';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-context-pick-upload-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function contextsRoot(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'contexts');
}

async function invoke(channel: string, payload: any): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  expect(call).toBeTruthy();
  const handler = call[1];
  return handler({ sender: {} }, { channel, payload });
}

describe('contexts.pickAndUpload', () => {
  it('rejects dot-prefixed and unsupported files returned by the native picker', async () => {
    const sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    const hidden = path.join(sourceDir, '.orkas-native-deps-verified.json');
    const unsupported = path.join(sourceDir, 'tool.exe');
    const visible = path.join(sourceDir, 'note.md');
    fs.writeFileSync(hidden, '{}', 'utf8');
    fs.writeFileSync(unsupported, 'MZ', 'utf8');
    fs.writeFileSync(visible, '# note', 'utf8');

    const electron = await import('electron') as any;
    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [hidden, unsupported, visible],
    });

    const res = await invoke('contexts.pickAndUpload', {});
    const opts = electron.dialog.showOpenDialog.mock.calls[0]?.[0];
    const defaultPath = String(opts?.defaultPath || '');
    expect(path.isAbsolute(defaultPath)).toBe(true);
    expect([
      path.resolve(tmpDir),
      path.resolve(path.join(tmpDir, '..', 'userWorkSpace')),
    ]).toContain(path.resolve(defaultPath));
    expect(res.ok).toBe(true);
    expect(res.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: false, name: '.orkas-native-deps-verified.json', reason: 'hidden' }),
      expect.objectContaining({ ok: false, name: 'tool.exe', reason: 'ext' }),
      expect.objectContaining({ ok: true, name: 'note.md', path: 'note.md' }),
    ]));
    expect(fs.existsSync(path.join(contextsRoot(), '.orkas-native-deps-verified.json'))).toBe(false);
    expect(fs.existsSync(path.join(contextsRoot(), 'tool.exe'))).toBe(false);
    expect(fs.readFileSync(path.join(contextsRoot(), 'note.md'), 'utf8')).toBe('# note');
  });

  it('does not seed the native picker with a macOS media-library workspace', async () => {
    const prevHome = process.env.HOME;
    const prevGuard = process.env.ORKAS_TCC_GUARD_FORCE;
    try {
      process.env.ORKAS_TCC_GUARD_FORCE = '1';
      const fakeHome = path.join(tmpDir, 'fake-home');
      const pictures = path.join(fakeHome, 'Pictures');
      fs.mkdirSync(pictures, { recursive: true });
      process.env.HOME = fakeHome;

      const userWorkspace = await import('../../../src/main/features/user_workspace');
      const set = userWorkspace.setWorkspacePath(TEST_UID, pictures);
      expect(set.ok).toBe(true);

      const electron = await import('electron') as any;
      electron.dialog.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      const res = await invoke('contexts.pickAndUpload', {});
      const opts = electron.dialog.showOpenDialog.mock.calls[0]?.[0];
      const defaultPath = String(opts?.defaultPath || '');
      expect(res.ok).toBe(true);
      expect(path.resolve(defaultPath)).not.toBe(path.resolve(pictures));
      expect(defaultPath).not.toContain(`${path.sep}Pictures`);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevGuard === undefined) delete process.env.ORKAS_TCC_GUARD_FORCE;
      else process.env.ORKAS_TCC_GUARD_FORCE = prevGuard;
    }
  });
});
