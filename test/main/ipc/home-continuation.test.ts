import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
const TEST_UID = 'uHomeContinuation';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-home-continuation-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.useRealTimers();
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

/** Each write gets its own clock so "most recently updated" is deterministic. */
async function at<T>(iso: string, write: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try {
    return await write();
  } finally {
    vi.useRealTimers();
  }
}

describe('projects.tasks.listOpen', () => {
  it('returns only the earliest open deadline per scope for attention, without copying private task content', async () => {
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const project = await projects.createProject(TEST_UID, 'Attention');
    if (!project.ok) throw new Error('createProject failed');
    const pid = project.project.project_id;
    for (const input of [
      { content: 'Private dated content', due_at: '2026-11-08' },
      { content: 'Earlier private content', due_at: '2026-11-07' },
      { content: 'Already complete', due_at: '2026-11-01', status: 'done' as const },
      { content: 'Undated content' },
    ]) expect((await tasks.createTask(TEST_UID, pid, input)).ok).toBe(true);
    expect((await tasks.createTask(TEST_UID, '', { content: 'Global deadline', due_at: '2026-11-09' })).ok).toBe(true);
    const res = await invoke('projects.tasks.listOpen', { dueSummary: true });
    expect(res.tasks).toEqual([{ project_id: pid, due_at: '2026-11-07' }, { project_id: '', due_at: '2026-11-09' }]);
    expect(JSON.stringify(res)).not.toContain('content');
  });
  it('lists unfinished to-dos across the global scope and every project, newest first', async () => {
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const created = await projects.createProject(TEST_UID, 'Growth');
    if (!created.ok) throw new Error('createProject failed');
    const pid = created.project.project_id;

    const globalTodo = await at('2026-10-01T08:00:00.000Z', () => tasks.createTask(TEST_UID, '', { content: 'Global follow-up' }));
    const projectTodo = await at('2026-10-02T08:00:00.000Z', () => tasks.createTask(TEST_UID, pid, { content: 'Project review', status: 'review' }));
    const finished = await at('2026-10-03T08:00:00.000Z', () => tasks.createTask(TEST_UID, pid, { content: 'Already shipped', status: 'done' }));
    const older = await at('2026-09-30T08:00:00.000Z', () => tasks.createTask(TEST_UID, pid, { content: 'Older project to-do' }));
    for (const result of [globalTodo, projectTodo, finished, older]) expect(result.ok).toBe(true);

    const res = await invoke('projects.tasks.listOpen', { limit: 3 });
    expect(res.ok).toBe(true);
    expect(res.total).toBe(3);
    expect(res.tasks.map((task: any) => [task.project_id, task.project_name, task.status])).toEqual([
      [pid, 'Growth', 'review'],
      ['', '', 'todo'],
      [pid, 'Growth', 'todo'],
    ]);
  });

  it('returns every open to-do for expansion while preserving bounded legacy requests', async () => {
    const tasks = await import('../../../src/main/features/project_tasks');
    for (let i = 0; i < 26; i += 1) {
      const result = await at(`2026-10-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`, () => tasks.createTask(TEST_UID, '', { content: `Item ${i}` }));
      expect(result.ok).toBe(true);
    }
    const res = await invoke('projects.tasks.listOpen', { limit: 3 });
    expect(res.tasks).toHaveLength(3);
    expect(res.total).toBe(26);
    expect(res.tasks[0].updated_at > res.tasks[1].updated_at).toBe(true);
    expect((await invoke('projects.tasks.listOpen', {})).tasks).toHaveLength(3);
    expect((await invoke('projects.tasks.listOpen', { limit: 100, all: 'true' })).tasks).toHaveLength(20);
    const all = await invoke('projects.tasks.listOpen', { all: true });
    expect(all.total).toBe(26);
    expect(all.tasks.map((task: any) => task.content)).toEqual(Array.from({ length: 26 }, (_, i) => `Item ${25 - i}`));
  });

  // The home page repeats this listing on every visit and, while visible, on
  // task events; to-dos only accumulate. Unchanged to-do files must not be
  // re-read, and every way a to-do file changes must show on the next call.
  it('re-reads only changed to-do files and still sees edits, synced copies, rewrites and deletions', async () => {
    const tasks = await import('../../../src/main/features/project_tasks');
    const paths = await import('../../../src/main/paths');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await at(`2026-10-0${i + 1}T08:00:00.000Z`, () => tasks.createTask(TEST_UID, '', {
        content: `Item ${i}`, ...(i === 3 ? { status: 'done' } : {}),
      }));
      if (!result.ok) throw new Error('createTask failed');
      ids.push(result.task.id);
    }
    const file = (i: number) => paths.userTaskFile(TEST_UID, ids[i]);
    const list = async () => invoke('projects.tasks.listOpen', { limit: 20 });
    const open = (res: any) => res.tasks.map((task: any) => task.content).sort();
    const first = await list();
    expect(open(first)).toEqual(['Item 0', 'Item 1', 'Item 2']);

    const realRead = fs.promises.readFile;
    const reads: string[] = [];
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: any[]) => {
      if (/[\\/]t_[^\\/]+\.json$/.test(String(args[0]))) reads.push(String(args[0]));
      return (realRead as any).apply(fs.promises, args);
    });
    syncBuiltinESMExports();
    try {
      expect(await list()).toEqual(first);
      expect(reads).toEqual([]);

      await at('2026-10-05T08:00:00.000Z', () => tasks.updateTask(TEST_UID, '', ids[0], { status: 'done' }));
      reads.length = 0;
      expect(open(await list())).toEqual(['Item 1', 'Item 2']);
      expect(reads).toEqual([file(0)]);

      // A synced copy arrives by rename.
      const synced = { ...JSON.parse(fs.readFileSync(file(1), 'utf8')), status: 'done' };
      fs.writeFileSync(`${file(1)}.sync`, JSON.stringify(synced));
      fs.renameSync(`${file(1)}.sync`, file(1));
      // Conflict resolution rewrites in place, here keeping the same size.
      await new Promise((resolve) => setTimeout(resolve, 5));
      fs.writeFileSync(file(2), fs.readFileSync(file(2), 'utf8').replace('Item 2', 'Item Z'));
      reads.length = 0;
      expect(open(await list())).toEqual(['Item Z']);
      expect(reads.sort()).toEqual([file(1), file(2)].sort());

      fs.rmSync(file(2));
      reads.length = 0;
      expect(await list()).toMatchObject({ tasks: [], total: 0 });
      expect(reads).toEqual([]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('returns an empty list when there is nothing left to do', async () => {
    const res = await invoke('projects.tasks.listOpen', {});
    expect(res).toMatchObject({ ok: true, tasks: [], total: 0 });
  });
});

describe('conversations.getMany', () => {
  it('returns index rows for known conversations and reports the rest as missing', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(TEST_UID, 'Growth');
    if (!created.ok) throw new Error('createProject failed');
    const plain = await chats.createConversation(TEST_UID, { title: 'Weekly summary' });
    const filed = await chats.createConversation(TEST_UID, { title: 'Pricing check', projectId: created.project.project_id });

    const res = await invoke('conversations.getMany', {
      cids: [plain.conversation_id, filed.conversation_id, 'c_missing0001', plain.conversation_id, '../escape', 42],
    });
    expect(res.ok).toBe(true);
    expect(res.conversations).toEqual([
      { conversation_id: plain.conversation_id, title: 'Weekly summary', project_id: '', origin_auto_task_id: '' },
      { conversation_id: filed.conversation_id, title: 'Pricing check', project_id: created.project.project_id, origin_auto_task_id: '' },
    ]);
    expect(res.missing).toEqual(['c_missing0001']);
  });

  it('reads at most 25 ids per call', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c_unknown${String(i).padStart(4, '0')}`);
    const res = await invoke('conversations.getMany', { cids: ids });
    expect(res.missing).toHaveLength(25);
    expect(res.conversations).toEqual([]);
  });
});
