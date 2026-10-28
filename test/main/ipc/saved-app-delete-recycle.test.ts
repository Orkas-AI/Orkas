/** A saved-app delete that fails must leave the app and the recycle bin as they were. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) },
}));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));
// Deletion now verifies publication for every saved app, including legacy local metadata.
vi.mock('../../../src/main/features/account/state', () => ({ isSessionVerified: () => true }));
vi.mock('../../../src/main/features/account/token_store', () => ({
  getSession: () => ({ user_id: 'uSavedAppDeleteRecycle', session_id: 'synthetic' }),
  isCurrentSession: () => true,
}));
vi.mock('../../../src/main/features/account/http', async original => ({
  ...await original<any>(), getJson: async () => ({ok:true,data:{apps:[],quota:{tier:'lite',used:0,limit:3,deadline:0,excess:0}}}),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const UID = 'uSavedAppDeleteRecycle';
let tmpDir: string, previousWorkspace: string | undefined;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-saved-app-delete-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(UID);
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  return call[1]({ sender: trustedIpcSender() }, { channel, payload });
}

it('drops the recycle copy and reports a stable code when deletion fails, then recycles a successful retry once', async () => {
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const saved = await import('../../../src/main/features/saved_apps');
  const recycleBin = await import('../../../src/main/features/recycle_bin');
  const created = await artifacts.createArtifact(UID, 'c1', 'helper', { files: [{ path: 'index.html', content: '<h1>Keep</h1>' }] });
  if (!created.ok) throw new Error(created.error);
  const app = await saved.saveFromArtifact(UID, 'c1', created.artifactId);
  if (!app.ok) throw new Error(app.error);
  const key = crypto.createHash('sha256').update(JSON.stringify(['saved', app.id])).digest('hex');
  const local = path.join(tmpDir, UID, 'local/web_apps', key);
  fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'data.sqlite'), 'records');
  const fsp = await import('node:fs/promises');
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const fault = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
    if (String(target) === local) throw Object.assign(new Error(`EBUSY: resource busy '${local}'`), { code: 'EBUSY' });
    return rm(target, options);
  });
  let failed: any;
  try { failed = await invoke('savedApps.delete', { appId: app.id }); } finally { fault.mockRestore(); }
  expect(failed).toMatchObject({ ok: false, code: 'app_delete_failed', error: 'app_delete_failed' });
  expect(JSON.stringify(failed)).not.toContain(tmpDir);
  expect(await recycleBin.listRecycleBatches(UID)).toEqual([]);
  expect(saved.listSavedApps(UID).map(item => item.id)).toEqual([app.id]);
  expect(await invoke('savedApps.delete', { appId: app.id })).toEqual({ ok: true });
  expect(saved.listSavedApps(UID)).toEqual([]);
  expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
});
