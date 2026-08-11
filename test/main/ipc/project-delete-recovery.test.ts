import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  dropChatConversation: vi.fn(),
  invalidateChatDisplayCatalog: vi.fn(),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
const TEST_UID = 'uProjectDeleteRecovery';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-delete-recovery-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  expect(call).toBeTruthy();
  return call[1]({ sender: trustedIpcSender() }, { channel, payload });
}

describe('projects.delete recovery transaction', () => {
  it('restores an already-removed task when a later cascade step fails', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const created = await projects.createProject(TEST_UID, 'Recover interrupted delete');
    if (!created.ok) throw new Error('project setup failed');
    const pid = created.project.project_id;
    const first = await chats.createConversation(TEST_UID, { title: 'First task', projectId: pid });
    const second = await chats.createConversation(TEST_UID, { title: 'Second task', projectId: pid });
    const paths = await import('../../../src/main/paths');
    fs.appendFileSync(paths.projectChatJsonlFile(TEST_UID, pid, first.conversation_id), JSON.stringify({
      role: 'user',
      content: 'content that must survive recovery',
      ts: new Date().toISOString(),
    }) + '\n', 'utf8');

    const originalDelete = chats.deleteConversation;
    let deleteCalls = 0;
    vi.spyOn(chats, 'deleteConversation').mockImplementation(async (...args) => {
      deleteCalls += 1;
      if (deleteCalls === 2) throw new Error('injected second-child failure');
      return originalDelete(...args);
    });

    const result = await invoke('projects.delete', { projectId: pid });

    expect(result).toMatchObject({ ok: false, error: 'cascade_failed' });
    expect(await projects.getProject(TEST_UID, pid)).toEqual(expect.objectContaining({
      project_id: pid,
      name: 'Recover interrupted delete',
    }));
    const restored = await chats.listConversations(TEST_UID);
    expect(restored.filter((row) => row.project_id === pid).map((row) => row.conversation_id).sort())
      .toEqual([first.conversation_id, second.conversation_id].sort());
    expect((await chats.getMessagesPage(
      TEST_UID, first.conversation_id, 10, undefined, pid,
    )).history[0]?.content)
      .toBe('content that must survive recovery');
    expect(await recycleBin.listRecycleBatches(TEST_UID)).toEqual([]);
  });

  it('retains the recovery batch when a restored legacy automation is not visible', async () => {
    const projects = await import('../../../src/main/features/projects');
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const created = await projects.createProject(TEST_UID, 'Verify legacy automation recovery');
    if (!created.ok) throw new Error('project setup failed');
    const pid = created.project.project_id;
    const task = await autoTasks.createTask(TEST_UID, {
      id: 'at_1a2b3c4d',
      content: 'legacy globally stored project automation',
      schedule: { type: 'one_time', at: '2099-08-08T04:20:00.000Z' },
    });
    if (!task.ok) throw new Error('automation setup failed');
    const { findAutoTaskLocation } = await import('../../../src/main/util/project-layout');
    const legacyLocation = findAutoTaskLocation(TEST_UID, task.task.id);
    if (!legacyLocation) throw new Error('legacy automation path missing');
    const config = JSON.parse(fs.readFileSync(legacyLocation.configFile, 'utf8'));
    fs.writeFileSync(legacyLocation.configFile, JSON.stringify({ ...config, project_id: pid }, null, 2));

    const originalDelete = autoTasks.deleteTask;
    vi.spyOn(autoTasks, 'deleteTask').mockImplementation(async (...args) => {
      expect((await originalDelete(...args)).ok).toBe(true);
      return { ok: false };
    });
    const originalList = autoTasks.listTasks;
    let listCalls = 0;
    vi.spyOn(autoTasks, 'listTasks').mockImplementation(async (...args) => {
      listCalls += 1;
      if (listCalls > 1) return [];
      return originalList(...args);
    });

    const result = await invoke('projects.delete', { projectId: pid });

    expect(result).toMatchObject({ ok: false, error: 'cascade_recovery_incomplete' });
    expect(await recycleBin.listRecycleBatches(TEST_UID)).toHaveLength(1);
    expect(fs.existsSync(legacyLocation.configFile)).toBe(true);
  });
});

describe('conversations.deleteAll recovery transaction', () => {
  it('does not report success when only part of the user task list was deleted', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const created = await projects.createProject(TEST_UID, 'Bulk task recovery');
    if (!created.ok) throw new Error('project setup failed');
    const pid = created.project.project_id;
    const projectTask = await chats.createConversation(TEST_UID, { title: 'Project task', projectId: pid });
    const looseTask = await chats.createConversation(TEST_UID, { title: 'Loose task' });
    const originalDelete = chats.deleteConversation;
    vi.spyOn(chats, 'deleteAllConversations').mockImplementation(async (uid) => {
      await originalDelete(uid, projectTask.conversation_id, pid);
      return 1;
    });

    const result = await invoke('conversations.deleteAll', {});

    expect(result).toMatchObject({ ok: false, error: 'cascade_failed' });
    const restoredIds = (await chats.listConversations(TEST_UID))
      .map((row) => row.conversation_id);
    expect(restoredIds).toEqual(expect.arrayContaining([
      projectTask.conversation_id,
      looseTask.conversation_id,
    ]));
    expect(await recycleBin.listRecycleBatches(TEST_UID)).toEqual([]);
  });
});

describe('autoTasks.delete recovery transaction', () => {
  it('restores task configuration and attachments after a partial delete failure', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const created = await autoTasks.createTask(TEST_UID, {
      id: 'at_a1b2c3d4',
      content: 'automation content that must survive',
      schedule: { type: 'one_time', at: '2099-08-08T04:20:00.000Z' },
    });
    if (!created.ok) throw new Error('automation setup failed');
    expect((await autoTasks.uploadAttachment(
      TEST_UID,
      created.task.id,
      'input.txt',
      Buffer.from('attachment that must survive'),
    )).ok).toBe(true);

    const originalDelete = autoTasks.deleteTask;
    vi.spyOn(autoTasks, 'deleteTask').mockImplementation(async (...args) => {
      expect((await originalDelete(...args)).ok).toBe(true);
      return { ok: false };
    });

    const result = await invoke('autoTasks.delete', { taskId: created.task.id });

    expect(result).toMatchObject({ ok: false, error: 'cascade_failed' });
    expect(await autoTasks.getTask(TEST_UID, created.task.id)).toEqual(expect.objectContaining({
      id: created.task.id,
      content: 'automation content that must survive',
    }));
    expect(await autoTasks.listAttachments(TEST_UID, created.task.id)).toEqual(['input.txt']);
    const { findAutoTaskLocation } = await import('../../../src/main/util/project-layout');
    const restoredLocation = findAutoTaskLocation(TEST_UID, created.task.id);
    expect(restoredLocation).not.toBeNull();
    expect(fs.readFileSync(path.join(restoredLocation!.attachmentsDir, 'input.txt'), 'utf8'))
      .toBe('attachment that must survive');
    expect(await recycleBin.listRecycleBatches(TEST_UID)).toEqual([]);
  });
});
