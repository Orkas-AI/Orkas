import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const state = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), stream: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: state.info, warn: state.warn, debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../src/main/features/search', () => ({ streamSearch: state.stream }));
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, shell: {}, dialog: {} }));
let root: string, previous: string | undefined;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-ipc-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks();
  (await import('../../../src/main/features/users')).activateUser('ipc-search-owner');
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

it('scopes progressive search to the trusted account, cancels its work and bounds routine logging', async () => {
  const electron = await import('electron') as any;
  (await import('../../../src/main/ipc/index')).register();
  const start = electron.ipcMain.on.mock.calls.find(([name]: any[]) => name === 'orkas.streamStart')[1];
  const cancel = electron.ipcMain.on.mock.calls.find(([name]: any[]) => name === 'orkas.streamCancel')[1];
  let signal!: AbortSignal;
  state.stream.mockImplementation(async function* (_uid, _query, _options, abortSignal) {
    signal = abortSignal;
    yield { results: [], pending_kinds: ['chat'], failed_kinds: [] };
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const send = vi.fn();
  const sender = trustedIpcSender({ id: 810, send, isDestroyed: () => false, mainFrame: {} });
  state.info.mockClear();
  await start({ sender: { getURL: () => 'https://foreign.example' } }, { requestId: 'r100-1', channel: 'search.global', payload: {} });
  expect(state.stream).not.toHaveBeenCalled();
  const pending = start({ sender, senderFrame: sender.mainFrame }, { requestId: 'r100-2', channel: 'search.global',
    payload: { query: 'marker', userId: 'another-account', projectId: '../foreign' } });
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  expect(state.stream.mock.calls[0].slice(0, 3)).toEqual(['ipc-search-owner', 'marker', { limit: 30, scope: 'all' }]);
  cancel({ sender }, 'r100-2'); await pending;
  expect(signal.aborted).toBe(true);
  expect(send.mock.calls.at(-1)[1]).toEqual({ type: 'done' });
  expect(state.info.mock.calls.filter(([message]) => /^stream(?:Start|Done|Cancel)/.test(message))).toEqual([]);
});
it('bounds summary selection and strips paths, account overrides and malformed message references', async () => {
  const electron = await import('electron') as any;
  (await import('../../../src/main/ipc/index')).register();
  const start = electron.ipcMain.on.mock.calls.find(([name]: any[]) => name === 'orkas.streamStart')[1];
  state.stream.mockImplementation(async function* () { yield { results: [], pending_kinds: [], failed_kinds: [] }; });
  const sender = trustedIpcSender({ id: 811, send: vi.fn(), isDestroyed: () => false, mainFrame: {} });
  await start({ sender, senderFrame: sender.mainFrame }, { requestId: 'r101-1', channel: 'search.global', payload: {
    query: 'marker', scope: 'chat', userId: 'another-account', chatSnippetRefs: [
      { cid: 'current-chat', msg_index: 0, file: '/private/source', userId: 'another-account' },
      { cid: '../foreign', msg_index: 0 }, { cid: 'current-chat', msg_index: -1 },
      { cid: 'current-chat', msg_index: 1.5 }, null, { cid: 'current-chat', msg_index: '1' },
      ...Array.from({ length: 40 }, (_, index) => ({ cid: 'other-chat', msg_index: index })),
    ],
  } });
  expect(state.stream.mock.calls[0][0]).toBe('ipc-search-owner');
  const refs = state.stream.mock.calls[0][2].chatSnippetRefs;
  expect(refs).toEqual([{ cid: 'current-chat', msg_index: 0 },
    ...Array.from({ length: 26 }, (_, msg_index) => ({ cid: 'other-chat', msg_index }))]);
  expect(JSON.stringify(refs)).not.toContain('/private/source');
});
