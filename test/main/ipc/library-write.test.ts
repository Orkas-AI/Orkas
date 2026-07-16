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
}));

vi.mock('../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
  embedQuery: async () => new Array(512).fill(0),
  closeEmbedder: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uLibraryWrite';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-write-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const vec = await import('../../../src/main/features/vec_store');
    vec.closeAllVecStores();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(userId = TEST_UID): any {
  return {
    userId,
    user: { user_id: userId, created_at: new Date(0).toISOString() },
    sender: {},
  };
}

describe('library.writeText', () => {
  it('writes archived chat text into the owning project Library when cid is project-scoped', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const { projectFilesDir, userContextsDir } = await import('../../../src/main/paths');
    const { _libraryWriteTextForTest } = await import('../../../src/main/ipc/index');

    const project = await projects.createProject(TEST_UID, 'Project Library');
    if (!project.ok) throw new Error('project precondition failed');
    const projectId = project.project.project_id;
    const conv = await chats.createConversation(TEST_UID, { projectId });

    const res = await _libraryWriteTextForTest({
      cid: conv.conversation_id,
      targetPath: 'notes/message.md',
      content: 'project-scoped message',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('project');
    expect(res.projectId).toBe(projectId);
    const projectFile = path.join(projectFilesDir(TEST_UID, projectId), 'notes', 'message.md');
    expect(fs.readFileSync(projectFile, 'utf8')).toBe('project-scoped message');
    expect(fs.existsSync(path.join(userContextsDir(TEST_UID), 'notes', 'message.md'))).toBe(false);

    await projectLibrary.drain(TEST_UID);
  });

  it('keeps archived chat text in the global Library when no project scope exists', async () => {
    const chats = await import('../../../src/main/features/chats');
    const { userContextsDir } = await import('../../../src/main/paths');
    const { _libraryWriteTextForTest } = await import('../../../src/main/ipc/index');

    const conv = await chats.createConversation(TEST_UID);
    const res = await _libraryWriteTextForTest({
      cid: conv.conversation_id,
      targetPath: 'messages/global.md',
      content: 'global message',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('global');
    expect(fs.readFileSync(path.join(userContextsDir(TEST_UID), 'messages', 'global.md'), 'utf8')).toBe('global message');
  });
});

describe('library.importProduced', () => {
  it('preserves target folders when importing a produced file into a project Library', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const { projectFilesDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const project = await projects.createProject(TEST_UID, 'Produced Import');
    if (!project.ok) throw new Error('project precondition failed');
    const projectId = project.project.project_id;
    const conv = await chats.createConversation(TEST_UID, { projectId });

    const ws = userWorkspace.getWorkspacePath(TEST_UID, projectId);
    fs.mkdirSync(ws, { recursive: true });
    const source = path.join(ws, 'result.txt');
    fs.writeFileSync(source, 'produced body', 'utf8');

    const res = await _libraryImportProducedForTest({
      cid: conv.conversation_id,
      path: source,
      targetPath: 'reports/result.txt',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('project');
    expect(fs.readFileSync(path.join(projectFilesDir(TEST_UID, projectId), 'reports', 'result.txt'), 'utf8')).toBe('produced body');

    await projectLibrary.drain(TEST_UID);
  });

  it('imports a produced video into a project Library but not the global Library', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const { projectFilesDir, userContextsDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const project = await projects.createProject(TEST_UID, 'Produced Video Import');
    if (!project.ok) throw new Error('project precondition failed');
    const projectId = project.project.project_id;
    const projectConversation = await chats.createConversation(TEST_UID, { projectId });
    const projectWorkspace = userWorkspace.getWorkspacePath(TEST_UID, projectId);
    fs.mkdirSync(projectWorkspace, { recursive: true });
    const projectVideo = path.join(projectWorkspace, 'demo.mp4');
    fs.writeFileSync(projectVideo, 'fake video bytes');

    const projectResult = await _libraryImportProducedForTest({
      cid: projectConversation.conversation_id,
      path: projectVideo,
    }, ctx());
    expect(projectResult).toMatchObject({ ok: true, scope: 'project', projectId });
    expect(fs.readFileSync(path.join(projectFilesDir(TEST_UID, projectId), 'demo.mp4'), 'utf8')).toBe('fake video bytes');

    const globalConversation = await chats.createConversation(TEST_UID);
    const globalWorkspace = userWorkspace.getWorkspacePath(TEST_UID);
    fs.mkdirSync(globalWorkspace, { recursive: true });
    const globalVideo = path.join(globalWorkspace, 'global.mp4');
    fs.writeFileSync(globalVideo, 'global video bytes');
    const globalResult = await _libraryImportProducedForTest({
      cid: globalConversation.conversation_id,
      path: globalVideo,
    }, ctx());
    expect(globalResult.ok).toBe(false);
    expect(fs.existsSync(path.join(userContextsDir(TEST_UID), 'global.mp4'))).toBe(false);

    await projectLibrary.drain(TEST_UID);
  });

  it('rejects unsupported produced files before importing into a project Library', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const { projectFilesDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const project = await projects.createProject(TEST_UID, 'Produced Import Filter');
    if (!project.ok) throw new Error('project precondition failed');
    const projectId = project.project.project_id;
    const conv = await chats.createConversation(TEST_UID, { projectId });

    const ws = userWorkspace.getWorkspacePath(TEST_UID, projectId);
    fs.mkdirSync(ws, { recursive: true });
    const source = path.join(ws, 'archive.zip');
    fs.writeFileSync(source, 'zip-ish bytes', 'utf8');

    const res = await _libraryImportProducedForTest({
      cid: conv.conversation_id,
      path: source,
    }, ctx());

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Unsupported file type|不支持的文件类型|未対応/);
    expect(fs.existsSync(path.join(projectFilesDir(TEST_UID, projectId), 'archive.zip'))).toBe(false);
  });
});
