import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
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
const TEST_UID = 'uHtmlPreviewAssets';

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-html-preview-assets-')));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.restoreAllMocks();
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
    { channel: 'produced.grantHtmlPreviewAssets', payload },
  );
}

async function workspaceSite(): Promise<string> {
  const ws = await import('../../../src/main/features/user_workspace');
  const workspace = path.join(tmpDir, 'workspace');
  const site = path.join(workspace, 'site');
  fs.mkdirSync(site, { recursive: true });
  ws.setWorkspacePath(TEST_UID, workspace);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css">');
  fs.writeFileSync(path.join(site, 'style.css'), 'body{}');
  return site;
}

describe('produced.grantHtmlPreviewAssets', () => {
  it('grants the folder of a page in the user workspace before the viewer loads it', async () => {
    const site = await workspaceSite();
    const attachments = await import('../../../src/main/features/chat_attachments');
    expect(attachments.resolveLocalHtmlPreviewAssetPath(path.join(site, 'style.css')).ok).toBe(false);

    expect(await invoke({ path: path.join(site, 'index.html') })).toEqual({ ok: true });

    expect(attachments.resolveLocalHtmlPreviewAssetPath(path.join(site, 'style.css')))
      .toMatchObject({ ok: true, absPath: path.join(site, 'style.css') });
  });

  it('does not grant a page outside the file-action scope', async () => {
    await workspaceSite();
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(outside, 'secret.json'), '{}');

    const result = await invoke({ path: path.join(outside, 'index.html') });

    expect(result).toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    const attachments = await import('../../../src/main/features/chat_attachments');
    expect(attachments.resolveLocalHtmlPreviewAssetPath(path.join(outside, 'secret.json')))
      .toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('reports a non-HTML target without granting anything', async () => {
    const site = await workspaceSite();

    expect(await invoke({ path: path.join(site, 'style.css') })).toEqual({ ok: false, error: 'bad_input' });
    const attachments = await import('../../../src/main/features/chat_attachments');
    expect(attachments.resolveLocalHtmlPreviewAssetPath(path.join(site, 'style.css')))
      .toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('rejects a missing path argument', async () => {
    expect(await invoke({})).toMatchObject({ ok: false, error: 'missing path' });
  });
});
