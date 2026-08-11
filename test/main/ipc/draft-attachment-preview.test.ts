import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  request: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
let tempRoot: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'draft-preview-user';
let attachments: typeof import('../../../src/main/features/chat_attachments');

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.6.5'),
    on: vi.fn(),
    off: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = handler;
    },
    on: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-draft-preview-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tempRoot;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  attachments = await import('../../../src/main/features/chat_attachments');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterAll(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function call(channel: string, payload: unknown): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('IPC draft attachment preview scope', () => {
  async function uploadAndResolve(cid: string, name: string, body: string): Promise<string> {
    await expect(attachments.uploadAttachment(
      TEST_UID,
      cid,
      name,
      Buffer.from(body),
    )).resolves.toMatchObject({ ok: true });
    const resolved = attachments.resolveAttachmentAbsPath(TEST_UID, cid, name);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.absPath;
  }

  it('stats and reads a completed Commander composer attachment', async () => {
    const absPath = await uploadAndResolve(
      'main_chat',
      'commander-draft.md',
      '# Commander draft\n',
    );

    await expect(call('workspace.statPath', {
      path: absPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: true, text: '# Commander draft\n' });
  });

  it('stats and reads a completed Project composer attachment', async () => {
    const cid = 'projchat-project-preview';
    const absPath = await uploadAndResolve(cid, 'project-draft.md', '# Project draft\n');

    await expect(call('workspace.statPath', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, text: '# Project draft\n' });
  });

  it('preserves preview access for a sent conversation attachment', async () => {
    const cid = 'conversation-preview';
    const absPath = await uploadAndResolve(cid, 'sent-note.md', '# Sent note\n');

    await expect(call('workspace.statPath', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, text: '# Sent note\n' });
  });

  it('rejects cross-draft preview even when both files exist', async () => {
    const commanderPath = await uploadAndResolve('main_chat', 'isolated-main.md', 'main');
    const projectCid = 'projchat-isolated-project';
    const projectPath = await uploadAndResolve(projectCid, 'isolated-project.md', 'project');

    await expect(call('workspace.statPath', {
      path: projectPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    await expect(call('workspace.statPath', {
      path: commanderPath,
      cid: projectCid,
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
  });

  it('rejects a draft path when cid is omitted', async () => {
    const absPath = await uploadAndResolve(
      'main_chat',
      'missing-cid.md',
      'must stay scoped',
    );

    await expect(call('workspace.statPath', {
      path: absPath,
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
  });
});
