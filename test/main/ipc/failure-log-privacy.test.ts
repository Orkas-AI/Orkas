import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => mocks.log,
  logFromRenderer: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

let workspace: string;
let previousWorkspace: string | undefined;
let invoke: (event: any, request: unknown) => Promise<any>;
let importFiles: (event: any, request: unknown) => Promise<any>;
let startStream: (event: any, request: unknown) => Promise<void>;
const privateText = 'PrivateAgentLabel_private_prompt_fragment';

beforeEach(async () => {
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ipc-log-privacy-'));
  process.env.ORKAS_WORKSPACE_ROOT = workspace;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser('ipc-log-privacy-user');
  const { register } = await import('../../../src/main/ipc/index');
  const { ipcMain } = await import('electron');
  register();
  invoke = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'orkas.invoke')![1];
  importFiles = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'orkas.importLocalFiles')![1];
  startStream = vi.mocked(ipcMain.on).mock.calls.find(([name]) => name === 'orkas.streamStart')![1] as any;
  vi.clearAllMocks();
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  vi.restoreAllMocks();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function expectPrivateFailureSummary(method: 'warn' | 'error', label: string) {
  const call = mocks.log[method].mock.calls.find(([message]) => message === label);
  expect(call).toBeDefined();
  expect(call![1].error).toMatchObject({
    message_chars: expect.any(Number), message_hash: expect.stringMatching(/^[a-f0-9]{12}$/),
  });
  expect(JSON.stringify(Object.values(mocks.log).flatMap(log => log.mock.calls)))
    .not.toContain(privateText);
}

describe('IPC failure log privacy and caller recovery', () => {
  it('reports deliberate history closure as cancellation and keeps unexpected worker failures observable', async () => {
    const chats = await import('../../../src/main/features/chats');
    const client = await import('../../../src/main/features/conversation-history-client');
    vi.spyOn(chats, 'getConversationMetadata').mockResolvedValue({ project_id: null } as any);
    const read = vi.spyOn(chats, 'getConversationTurnPage');
    const event = { sender: trustedIpcSender() };
    const request = { channel: 'conversations.turns', payload: { cid: 'history-close' } };
    read.mockRejectedValueOnce(new client.ConversationHistoryClosedError());
    expect(await invoke(event, request)).toMatchObject({ ok: false, code: 'E_HISTORY_CLOSED' });
    expect(mocks.log.warn).toHaveBeenCalledWith('conversation history request cancelled on close', {
      channel: 'conversations.turns', code: 'E_HISTORY_CLOSED',
    });
    expect(mocks.log.error).not.toHaveBeenCalled();
    // The same prose or even a copied code cannot impersonate owner cancellation.
    read.mockRejectedValueOnce(Object.assign(new Error('Conversation history worker stopped'), { code: 'E_HISTORY_CLOSED' }));
    expect(await invoke(event, request)).toMatchObject({ ok: false });
    expect(mocks.log.error).toHaveBeenCalledWith('invoke conversations.turns failed', expect.any(Object));
    read.mockResolvedValueOnce({ turns: [], total: 0, nextCursor: null, pageSize: 15 });
    expect(await invoke(event, request)).toMatchObject({ ok: true, turns: [], total: 0, next_cursor: null, page_size: 15 });
  });
  it('keeps a duplicate-name reply intact while excluding the name from exception logs', async () => {
    const agents = await import('../../../src/main/features/agents');
    const error = Object.assign(new Error(`agent name "${privateText}" is already in use`), {
      code: 'E_AGENT_NAME_TAKEN',
    });
    vi.spyOn(agents, 'createCustomAgent').mockRejectedValueOnce(error);
    const result = await invoke({ sender: trustedIpcSender() }, {
      channel: 'agents.create', payload: { name: privateText },
    });
    expect(result).toMatchObject({ ok: false, code: 'E_AGENT_NAME_TAKEN', error: error.message });
    expectPrivateFailureSummary('error', 'invoke agents.create failed');
  });

  it('summarizes returned failures without changing their reply or blocking a later success', async () => {
    const failure = { ok: false, code: 'E_SERVER_UNAVAILABLE', error: privateText };
    const auth = await import('../../../src/main/features/auth');
    vi.spyOn(auth, 'getConfig').mockReturnValueOnce(failure as any).mockReturnValueOnce({ ready: true } as any);
    const event = { sender: trustedIpcSender() };
    expect(await invoke(event, { channel: 'auth.getConfig' })).toEqual(failure);
    expectPrivateFailureSummary('warn', 'invoke returned failure');
    expect(await invoke(event, { channel: 'auth.getConfig' })).toEqual({ ok: true, ready: true });
    expect(mocks.log.warn.mock.calls.filter(([message]) => message === 'invoke returned failure')).toHaveLength(1);
  });

  it('keeps a local import failure reply without putting its private text in logs', async () => {
    const users = await import('../../../src/main/features/users');
    vi.spyOn(users, 'getOrCreateSelfUser').mockRejectedValueOnce(new Error(privateText));
    expect(await importFiles({ sender: trustedIpcSender() }, {}))
      .toEqual({ ok: false, code: 'E_UNKNOWN', error: privateText });
    expectPrivateFailureSummary('warn', 'local file import request failed');
  });

  it('finishes a failed stream, preserves its error event and allows the same request id again', async () => {
    const users = await import('../../../src/main/features/users');
    vi.spyOn(users, 'getOrCreateSelfUser').mockRejectedValueOnce(new Error(privateText));
    const sender = Object.assign(trustedIpcSender(), { isDestroyed: () => false, send: vi.fn() });
    const request = { channel: 'agents.chat.sendStream', requestId: 'privacy-stream', payload: { id: 'privacy-agent', content: 'Hello' } };
    await startStream({ sender }, request);
    expect(sender.send.mock.calls).toEqual([
      ['stream:privacy-stream', { type: 'error', text: privateText }],
      ['stream:privacy-stream', { type: 'done' }],
    ]);
    expectPrivateFailureSummary('error', 'stream agents.chat.sendStream failed');
    sender.send.mockClear();
    const agents = await import('../../../src/main/features/agents');
    vi.spyOn(agents, 'streamSendToAgentEditChat').mockImplementationOnce(async function* () {});
    await startStream({ sender }, request);
    expect(sender.send.mock.calls).toEqual([['stream:privacy-stream', { type: 'done' }]]);
  });
  it('preserves global-search stream failure privacy and permits reuse of its settled request id', async () => {
    const users = await import('../../../src/main/features/users');
    vi.spyOn(users, 'getOrCreateSelfUser').mockRejectedValueOnce(new Error(privateText));
    const sender = Object.assign(trustedIpcSender(), { isDestroyed: () => false, send: vi.fn() });
    const request = { channel: 'search.global', requestId: 'privacy-stream', payload: { query: '' } };
    await startStream({ sender }, request);
    expect(sender.send.mock.calls).toEqual([
      ['stream:privacy-stream', { type: 'error', text: privateText }],
      ['stream:privacy-stream', { type: 'done' }],
    ]);
    expectPrivateFailureSummary('error', 'stream search.global failed');
    sender.send.mockClear();
    const search = await import('../../../src/main/features/search');
    vi.spyOn(search, 'streamSearch').mockImplementationOnce(async function* () {});
    await startStream({ sender }, request);
    expect(sender.send.mock.calls).toEqual([['stream:privacy-stream', { type: 'done' }]]);
  });
});
