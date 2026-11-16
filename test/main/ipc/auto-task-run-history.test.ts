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
const TEST_UID = 'uAutoTaskRunHistory';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auto-run-history-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  (await import('../../../src/main/features/auto_tasks')).stopScheduler();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
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

describe('automation run history', () => {
  it('shows the conversation an automation was created from among its runs, counted once', async () => {
    const chats = await import('../../../src/main/features/chats');
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    const source = await chats.createConversation(TEST_UID, { title: 'Inbox triage' });
    const created = await autoTasks.applyAutoTaskMutation(TEST_UID, {
      action: 'create',
      updates: { content: 'Triage the inbox', schedule: { type: 'daily', hour: 9, minute: 0 }, enabled: false },
    }, { conversationId: source.conversation_id });
    if (!created.ok || !created.taskId) throw new Error(created.error);
    const editor = await autoTasks.createTask(TEST_UID, {
      content: 'Weekly report', schedule: { type: 'weekly', weekday: 1, hour: 9, minute: 0 }, enabled: false,
    });
    if (!editor.ok) throw new Error(editor.error);

    const counts = await invoke('conversations.autoTaskCounts', { task_ids: [created.taskId, editor.task.id] });
    expect(counts.counts).toEqual({ [created.taskId]: 1, [editor.task.id]: 0 });
    const page = await invoke('conversations.list', { mode: 'auto_task', task_id: created.taskId, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.conversations.map((conv: { conversation_id: string }) => conv.conversation_id))
      .toEqual([source.conversation_id]);
    expect((await invoke('conversations.list', { mode: 'auto_task', task_id: editor.task.id, offset: 0 })).total).toBe(0);
  });
});
