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
const TEST_UID = 'uRetainedIpc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-retained-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
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
  return handler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('retained Agent memory and Office preview IPC', () => {
  it('round-trips Agent memory through the registered renderer endpoint', async () => {
    const created = await invoke('agents.create', { name: 'MemoryOwner', workflow: 'Help with notes' });
    const agent_id = created.agent.agent_id;
    expect(await invoke('agents.memory.add', { agent_id, content: 'Use metric units.' }))
      .toMatchObject({ ok: true, entries: ['Use metric units.'] });
    expect(await invoke('agents.memory.update', { agent_id, old_text: 'Use metric units.', content: 'Use SI units.' }))
      .toMatchObject({ ok: true, entries: ['Use SI units.'] });
    expect(await invoke('agents.memory.remove', { agent_id, old_text: 'Use SI units.' }))
      .toMatchObject({ ok: true, entries: [] });
  });

  it.each(['contexts.officeHtml', 'projects.files.officeHtml'])('%s reaches the owned Office renderer', async (channel) => {
    const previews = await import('../../../src/main/util/office-preview');
    const render = vi.spyOn(previews, 'officeFileToPreviewHtml').mockResolvedValue({
      html: '<html>quarterly results</html>', kind: 'spreadsheet', layoutRendered: true,
    });
    const payload: Record<string, string> = {};
    let root = contextsRoot();
    if (channel.startsWith('projects.')) {
      const projects = await import('../../../src/main/features/projects');
      const created = await projects.createProject(TEST_UID, 'Preview owner');
      if (!created.ok) throw new Error('project setup failed');
      payload.projectId = created.project.project_id;
      payload.name = 'results.xlsx';
      const paths = await import('../../../src/main/paths');
      root = paths.projectFilesDir(TEST_UID, payload.projectId);
    } else payload.path = 'results.xlsx';
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'results.xlsx'), 'office fixture bytes');
    expect(await invoke(channel, payload)).toMatchObject({
      ok: true, html: '<html>quarterly results</html>', kind: 'spreadsheet', layoutRendered: true,
    });
    expect(render).toHaveBeenCalledWith('spreadsheet', 'results.xlsx', path.join(root, 'results.xlsx'), expect.any(Buffer));
    render.mockRestore();
  });

  it.each(['common.pickDirectory', 'skills.pickImportDir'])('%s opens in an explicit usable workspace', async (channel) => {
    await invoke(channel, {});
    const electron = await import('electron') as any;
    const opts = electron.dialog.showOpenDialog.mock.calls[0]?.[0];
    expect(typeof opts.defaultPath).toBe('string');
    expect(path.isAbsolute(opts.defaultPath)).toBe(true);
    expect(fs.statSync(opts.defaultPath).isDirectory()).toBe(true);
  });
});

it('reports unsupported legacy video credentials without exposing them as an active provider', async () => {
  const auth = await import('../../../src/main/features/auth');
  auth.saveVideoProfiles([{ id: 'legacy', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'legacy-private-key', label: 'Legacy', createdAt: 1 }]);
  const result = await invoke('videoAuth.list', {});
  expect(result.providers.map((provider: any) => provider.provider)).toEqual(['orkas-api']);
  expect(result.profiles).toEqual([expect.objectContaining({ id: 'legacy', available: false })]);
  expect(result.profiles[0]).not.toHaveProperty('apiKey');
  expect(auth.loadVideoProfiles()[0]?.apiKey).toBe('legacy-private-key');
});
