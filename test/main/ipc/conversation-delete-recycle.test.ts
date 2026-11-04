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
  it.each(['conversation', 'cleanup', 'project'] as const)('deletes and backs up both physical layouts through %s deletion', async action => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(TEST_UID, 'Legacy project');
    if (!created.ok) throw new Error('project setup failed');
    const pid = created.project.project_id;
    const conv = await chats.createConversation(TEST_UID, { title: 'Legacy task', projectId: pid });
    const cid = conv.conversation_id;
    const old = '2020-01-01T00:00:00Z';
    const row = { ...conv, created_at: old, updated_at: old };
    const cloud = path.join(tmpDir, TEST_UID, 'cloud');
    const expected = new Map<string, string>();
    for (const prefix of ['', `projects/${pid}/`]) {
      const files = {
        [`${prefix}chats/${cid}.jsonl`]: JSON.stringify({ role: 'user', content: `recoverable ${prefix || 'legacy'}`, ts: old }) + '\n',
        [`${prefix}chats/${cid}/meta.json`]: JSON.stringify(row),
        [`${prefix}chats/${cid}/state.json`]: JSON.stringify({ status: 'idle', in_flight: [] }),
        [`${prefix}chat_attachments/${cid}/draft.txt`]: 'attachment ' + prefix,
        [`${prefix}chat_artifacts/${cid}/artifact/index.html`]: 'artifact ' + prefix,
        [`${prefix}sessions/gconv-${cid}.jsonl`]: 'commander ' + prefix,
        [`${prefix}sessions/gconv-${cid}.jsonl.context.json`]: '{}',
        [`${prefix}sessions/gmember-${cid}-agent.jsonl.context.json`]: '{}',
        [`${prefix}sessions/gmember-${cid}-agent.tool-results/tail.txt`]: 'retained ' + prefix,
      };
      for (const [rel, body] of Object.entries(files)) {
        const file = path.join(cloud, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
        expected.set(rel, body);
      }
    }
    fs.writeFileSync(path.join(cloud, 'projects', pid, 'chats', '_index.json'), JSON.stringify([row]));
    fs.writeFileSync(path.join(cloud, 'chats', '_index.json'), JSON.stringify([row]));
    chats.invalidateConversationCaches(TEST_UID);
    const control = path.join(cloud, 'chats', 'other-task.jsonl');
    fs.writeFileSync(control, 'unrelated history');
    let result: any;
    if (action === 'cleanup') {
      const preview = await invoke('conversations.cleanup.preview', { expectedUserId: TEST_UID, days: 90 });
      result = await invoke('conversations.cleanup.remove', { expectedUserId: TEST_UID, token: preview.token, cid });
      expect(result).toMatchObject({ ok: true, status: 'deleted' });
    } else {
      result = await invoke(action === 'project' ? 'projects.delete' : 'conversations.delete', action === 'project' ? { projectId: pid } : { cid });
      expect(result).toMatchObject({ ok: true });
    }
    expect([...expected.keys()].filter(rel => fs.existsSync(path.join(cloud, rel))), 'Deleted files must not remain').toEqual([]);
    const globalRows = JSON.parse(fs.readFileSync(path.join(cloud, 'chats', '_index.json'), 'utf8'));
    expect(globalRows.filter((item: any) => item.conversation_id === cid && !item.deleted_at), 'Legacy live catalog copies must not survive').toEqual([]);
    expect(fs.readFileSync(control, 'utf8')).toBe('unrelated history');
    const { batches } = await invoke('recycle.list', {});
    expect(batches).toHaveLength(1);
    const archived = new Set(batches[0].items.map((item: any) => item.path));
    expect([...expected.keys()].filter(rel => !archived.has('cloud/' + rel)), 'Backup must cover every removed file').toEqual([]);
    expect(await invoke('recycle.restore', { id: batches[0].id })).toMatchObject({ ok: true, failed: 0, skipped: 0 });
    for (const [rel, body] of expected) {
      // Restored metadata advances its revision/clock; the content files retain their bytes.
      if (!rel.endsWith('/meta.json')) expect(fs.readFileSync(path.join(cloud, rel), 'utf8')).toBe(body);
    }
    expect(await chats.getConversationMetadata(TEST_UID, cid, pid)).toMatchObject({ title: 'Legacy task', project_id: pid });
  });

  it.each(['conversation', 'project'] as const)('deletes a pre-v4 task indexed only in the global catalog through %s', async action => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const p = await projects.createProject(TEST_UID, 'Legacy-only project');
    if (!p.ok) throw new Error('project setup failed');
    const pid = p.project.project_id;
    const conv = await chats.createConversation(TEST_UID, { title: 'Pre-v4 task', projectId: pid });
    const cid = conv.conversation_id;
    const cloud = path.join(tmpDir, TEST_UID, 'cloud');
    const projectChats = path.join(cloud, 'projects', pid, 'chats');
    const legacyFile = path.join(cloud, 'chats', `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ role: 'user', content: 'recoverable legacy-only history' }) + '\n');
    fs.mkdirSync(path.join(cloud, 'chats', cid), { recursive: true });
    fs.writeFileSync(path.join(cloud, 'chats', cid, 'meta.json'), JSON.stringify(conv));
    fs.writeFileSync(path.join(cloud, 'chats', '_index.json'), JSON.stringify([conv]));
    fs.rmSync(projectChats, { recursive: true, force: true });
    chats.invalidateConversationCaches(TEST_UID);
    (await import('../../../src/main/features/conversation_deletions')).invalidateTaskDeletions(TEST_UID);
    const result = await invoke(action === 'project' ? 'projects.delete' : 'conversations.delete', action === 'project' ? { projectId: pid } : { cid });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.existsSync(path.join(cloud, 'chats', cid))).toBe(false);
    const { batches } = await invoke('recycle.list', {});
    expect(batches).toHaveLength(1);
    expect(await invoke('recycle.restore', { id: batches[0].id })).toMatchObject({ ok: true, failed: 0 });
    expect((await invoke('conversations.get', { cid, projectId: pid })).conversation).toMatchObject({ title: 'Pre-v4 task', project_id: pid });
    expect((await invoke('conversations.history', { cid, projectId: pid })).history[0].content).toBe('recoverable legacy-only history');
  });

  it('deletes and restores a task while an unpublished status write is present', async () => {
    const chats = await import('../../../src/main/features/chats');
    const paths = await import('../../../src/main/paths');
    const recycleBin = await import('../../../src/main/features/recycle_bin');
    const conv = await chats.createConversation(TEST_UID, { title: 'Delete during stop' });
    const cid = conv.conversation_id;
    // A stale Settings page cannot preview or mutate the newly active account.
    for (const action of ['preview', 'page', 'remove']) {
      const result = await invoke(`conversations.cleanup.${action}`, {
        expectedUserId: 'previous-account', days: 90, protectedIds: [], token: 'stale', offset: 0, cid,
      });
      expect(result).toMatchObject({ ok: false, error: 'cleanup_account_changed' });
    }
    expect(await chats.getConversationMetadata(TEST_UID, cid)).not.toBeNull();
    expect(await recycleBin.listRecycleBatches(TEST_UID)).toEqual([]);

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
