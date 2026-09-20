import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) =>
  Promise<{ ok: boolean; error?: string; path?: string; code?: string }>;
let invokeHandler: InvokeFn;
let tempRoot: string;
let workspace: string;
let outsideFile: string;
let previousWorkspaceRoot: string | undefined;
const shell = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async () => ''),
  trashItem: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '1.7.1', on: vi.fn(), off: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = handler;
    },
    on: vi.fn(),
  },
  shell,
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true,
  },
}));

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reveal-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tempRoot, 'data');
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser('reveal-user');
  workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workspace);
  const ws = await import('../../../src/main/features/user_workspace');
  ws.setWorkspacePath('reveal-user', workspace);
  outsideFile = path.join(tempRoot, 'outside workspace', '封面 image.png');
  fs.mkdirSync(path.dirname(outsideFile));
  fs.writeFileSync(outsideFile, 'original image');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});
beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  await drainMainRuntimeForTest();
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
function call(channel: string, payload: unknown) {
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}
function reveal(target: unknown) { return call('workspace.revealPath', { path: target }); }
function expectNoShellAction() {
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.trashItem).not.toHaveBeenCalled();
}

describe('user-requested reveal in the OS file manager', () => {
  it('reveals an outside file without requiring a conversation or produced-file record', async () => {
    await expect(reveal(outsideFile)).resolves.toMatchObject({ ok: true, path: outsideFile });
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(outsideFile);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('original image');
  });

  it('opens an outside directory in the file manager', async () => {
    const directory = path.dirname(outsideFile);
    await expect(reveal(directory)).resolves.toMatchObject({ ok: true, path: directory });
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(directory);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('preserves workspace file and workspace root actions', async () => {
    const file = path.join(workspace, 'inside.txt');
    fs.writeFileSync(file, 'inside');
    await expect(reveal(file)).resolves.toMatchObject({ ok: true, path: file });
    await expect(reveal(workspace)).resolves.toMatchObject({ ok: true, path: workspace });
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(workspace);
  });

  it('reveals a linked directory even when its target is outside the workspace', async () => {
    const link = path.join(workspace, 'linked-images');
    fs.symlinkSync(path.dirname(outsideFile), link, 'junction');
    await expect(reveal(link)).resolves.toMatchObject({ ok: true, path: link });
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(link);
  });

  it.each([undefined, null, 123, '', 'package.json', '../escape.png',
    'https://example.com/image.png', 'file:///tmp/image.png', 'javascript:alert(1)',
    'data:text/plain,hello', '/tmp/image\0.png'])('rejects invalid input %j without opening anything', async (target) => {
    const res = await reveal(target);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expectNoShellAction();
  });

  it('reports a removed file and succeeds when it becomes available again', async () => {
    const file = path.join(tempRoot, 'restored.png');
    const missing = await reveal(file);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
    expectNoShellAction();
    fs.writeFileSync(file, 'restored');
    await expect(reveal(file)).resolves.toMatchObject({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
  });

  it('reports an OS folder-open failure and allows retry', async () => {
    shell.openPath.mockResolvedValueOnce('OS folder opening failed');
    const directory = path.dirname(outsideFile);
    const failed = await reveal(directory);
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    await expect(reveal(directory)).resolves.toMatchObject({ ok: true });
  });

  it('does not grant read, write, stat, or delete access after revealing an outside file', async () => {
    await expect(reveal(outsideFile)).resolves.toMatchObject({ ok: true });
    for (const channel of ['workspace.statPath', 'produced.readText', 'produced.writeText', 'workspace.deletePath']) {
      await expect(call(channel, { path: outsideFile, content: 'replacement' }))
        .resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    }
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('original image');
    expect(shell.trashItem).not.toHaveBeenCalled();
  });

  it('continues to reject untrusted renderer requests', async () => {
    await expect(invokeHandler({ sender: { getURL: () => 'https://example.com' } }, {
      channel: 'workspace.revealPath', payload: { path: outsideFile },
    })).resolves.toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
    expectNoShellAction();
  });
});

describe('file actions in the conversation-selected coding workspace', () => {
  it('distinguishes inaccessible files from missing files and recovers on retry', async () => {
    const file = path.join(workspace, 'temporarily-denied.ts');
    fs.writeFileSync(file, 'source retained');
    const stat = fs.statSync;
    const fault = vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      if (String(target) === file) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return (stat as any)(target, ...args);
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    try {
      await expect(call('workspace.statPath', { path: file }))
        .resolves.toMatchObject({ ok: false, error: 'stat_failed' });
    } finally { fault.mockRestore(); syncBuiltinESMExports(); }
    await expect(call('workspace.statPath', { path: file }))
      .resolves.toMatchObject({ ok: true, exists: true });
    fs.unlinkSync(file);
    await expect(call('workspace.statPath', { path: file }))
      .resolves.toMatchObject({ ok: true, exists: false });
  });

  it('does not promote a symlink in an ordinary task folder into a new allowed root', async () => {
    const { createConversation } = await import('../../../src/main/features/chats');
    const { setWorkspaceDirOnce } = await import('../../../src/main/features/group_chat/state');
    const conv = await createConversation('reveal-user', {});
    const linked = path.join(workspace, 'ordinary-task-folder');
    fs.symlinkSync(path.dirname(outsideFile), linked, 'junction');
    await setWorkspaceDirOnce('reveal-user', conv.conversation_id, 'ordinary-task-folder');
    await expect(call('produced.readText', {
      cid: conv.conversation_id, path: path.join(linked, path.basename(outsideFile)),
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('original image');
  });

  it('opens existing source files in a project task even without a produced-file record', async () => {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const directories = await import('../../../src/main/features/local_agents/project-directory');
    const project = await projects.createProject('reveal-user', 'Code references');
    if (!project.ok) throw new Error('project fixture failed');
    const conv = await chats.createConversation('reveal-user', { projectId: project.project.project_id });
    const cid = conv.conversation_id;
    const directory = path.join(tempRoot, 'selected repository');
    fs.mkdirSync(directory);
    const file = path.join(directory, 'runner.ts');
    fs.writeFileSync(file, 'export const ready = true;');
    directories.writeCodingDirectory('reveal-user', cid, directory, true);

    await expect(call('workspace.statPath', { cid, path: file }))
      .resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', { cid, path: file }))
      .resolves.toMatchObject({ ok: true, text: 'export const ready = true;' });

    // A link or caller-supplied cwd cannot establish workspace authority.
    for (const payload of [{ path: file }, { cid: 'another-task', path: file },
      { cid: 'another-task', path: file, coding_project_dir: directory }]) {
      await expect(call('produced.readText', payload)).resolves.toMatchObject({ ok: false });
    }
    const escaped = path.join(directory, 'linked.png');
    fs.symlinkSync(outsideFile, escaped);
    await expect(call('produced.readText', { cid, path: escaped }))
      .resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });

    // Replacing a device selection immediately revokes the former root.
    directories.writeCodingDirectory('reveal-user', cid, workspace, true);
    await expect(call('workspace.statPath', { cid, path: file })).resolves.toMatchObject({ ok: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('export const ready = true;');
    expectNoShellAction();
  });

  it('does not authorize a directory awaiting confirmation on this device', async () => {
    const { writeCodingDirectory } = await import('../../../src/main/features/local_agents/project-directory');
    writeCodingDirectory('reveal-user', 'pending-code-task', path.dirname(outsideFile), true, true);
    for (const channel of ['workspace.statPath', 'produced.readText', 'produced.writeText', 'workspace.deletePath']) {
      await expect(call(channel, { cid: 'pending-code-task', path: outsideFile, content: 'replacement' }))
        .resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    }
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('original image');
    expectNoShellAction();
  });
});
