import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

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
const TEST_UID = 'uMediaDiagnose';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-diagnose-'));
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

async function invoke(payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  expect(call).toBeTruthy();
  return call[1](
    { sender: trustedIpcSender() },
    { channel: 'media.diagnose', payload },
  );
}

describe('media.diagnose', () => {
  it('distinguishes an available local image without returning its path', async () => {
    const imagePath = path.join(tmpDir, 'image #1%.png');
    fs.writeFileSync(imagePath, Buffer.from('not decoded by this diagnostic'));
    const { chatMediaLocalUrl } = await import('../../../src/main/util/chat-media-url');

    const res = await invoke({ url: chatMediaLocalUrl(imagePath) });

    expect(res).toEqual({ ok: true, diagnosis: 'available', media_kind: 'image' });
    expect(JSON.stringify(res)).not.toContain(imagePath);
  });

  it('returns a stable missing-file reason without exposing the local path', async () => {
    const missingPath = path.join(tmpDir, 'missing #1%.png');
    const { chatMediaLocalUrl } = await import('../../../src/main/util/chat-media-url');

    const res = await invoke({ url: chatMediaLocalUrl(missingPath) });

    expect(res).toEqual({ ok: true, diagnosis: 'not_found' });
    expect(JSON.stringify(res)).not.toContain(missingPath);
  });
});
