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
const TEST_UID = 'uConversationDeleteRecycle';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conversation-delete-recycle-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
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

describe('conversations.delete recycle transaction', () => {
  it('deletes and restores a task while an unpublished status write is present', async () => {
    const chats = await import('../../../src/main/features/chats');
    const paths = await import('../../../src/main/paths');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const conv = await chats.createConversation(TEST_UID, { title: 'Delete during stop' });
    const cid = conv.conversation_id;
    const chatFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const groupDir = paths.groupChatDir(TEST_UID, cid);
    const stateFile = path.join(groupDir, 'state.json');
    const atomicTmpFile = `${stateFile}.1234.1786579200000.deadbeef.tmp`;
    const attachmentDir = paths.chatAttachmentDir(TEST_UID, cid);
    const userTmpFile = path.join(attachmentDir, 'operator-notes.tmp');
    const relChat = `cloud/chats/${cid}.jsonl`;
    const relState = `cloud/chats/${cid}/state.json`;
    const relAtomicTmp = `${relState}.1234.1786579200000.deadbeef.tmp`;
    const relUserTmp = `cloud/chat_attachments/${cid}/operator-notes.tmp`;

    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.appendFileSync(chatFile, `${JSON.stringify({
      role: 'user',
      content: 'content that must remain recoverable',
      ts: new Date().toISOString(),
    })}\n`, 'utf8');
    fs.writeFileSync(stateFile, '{"status":"idle"}\n', 'utf8');
    fs.writeFileSync(atomicTmpFile, '{"status":"aborted"}\n', 'utf8');
    fs.writeFileSync(userTmpFile, 'user-owned draft\n', 'utf8');

    const result = await invoke('conversations.delete', { cid });

    expect(result).toEqual({ ok: true, deleted: true });
    expect(await chats.getConversation(TEST_UID, cid)).toBeNull();
    expect(fs.existsSync(chatFile)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
    expect(fs.existsSync(userTmpFile)).toBe(false);
    const [batch] = await recycleBin.listRecycleBatches(TEST_UID);
    expect(batch.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      relChat,
      relState,
      relUserTmp,
    ]));
    expect(batch.items.map((item) => item.path)).not.toContain(relAtomicTmp);

    const restored = await invoke('recycle.restore', { id: batch.id });

    expect(restored).toEqual(expect.objectContaining({
      ok: true,
      restored: 4,
      skipped: 0,
      reactivated: 1,
      failed: 0,
    }));
    expect(restored.failed_paths).toEqual([]);
    expect(restored.restored_paths).toEqual(expect.arrayContaining([
      relChat,
      relState,
      relUserTmp,
    ]));
    const restoredConversation = await invoke('conversations.get', { cid });
    const restoredHistory = await invoke('conversations.history', { cid, limit: 10 });
    expect(restoredConversation).toEqual(expect.objectContaining({
      ok: true,
      conversation: expect.objectContaining({
        conversation_id: cid,
        title: 'Delete during stop',
      }),
    }));
    expect(restoredHistory.history[0]?.content).toBe('content that must remain recoverable');
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('{"status":"idle"}\n');
    expect(fs.readFileSync(userTmpFile, 'utf8')).toBe('user-owned draft\n');
    expect(fs.existsSync(atomicTmpFile)).toBe(false);
  });
});
