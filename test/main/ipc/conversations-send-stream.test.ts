import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type StreamStartFn = (
  event: { sender: { getURL: () => string; isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } },
  req: { requestId: string; channel: string; payload?: unknown },
) => Promise<void>;
type StreamCancelFn = (
  event: { sender: { getURL: () => string } },
  requestId: unknown,
) => void;

let streamStartHandler: StreamStartFn | null = null;
let streamCancelHandler: StreamCancelFn | null = null;

const groupChatMock = vi.hoisted(() => ({
  subscribers: new Set<(ev: unknown) => void>(),
  quiescent: false,
  releaseSend: null as null | (() => void),
  resolveSendStarted: null as null | (() => void),
  resolveSendFinished: null as null | (() => void),
  sendStarted: Promise.resolve(),
  sendFinished: Promise.resolve(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: StreamStartFn | StreamCancelFn) => {
      if (channel === 'orkas.streamStart') streamStartHandler = fn as StreamStartFn;
      if (channel === 'orkas.streamCancel') streamCancelHandler = fn as StreamCancelFn;
    },
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

vi.mock('../../../src/main/features/group_chat', () => ({
  subscribeBus: vi.fn((_userId: string, _cid: string, cb: (ev: unknown) => void) => {
    groupChatMock.subscribers.add(cb);
    return () => groupChatMock.subscribers.delete(cb);
  }),
  send: vi.fn(async () => {
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return { ok: true };
  }),
  busIsQuiescent: vi.fn(() => groupChatMock.quiescent),
  streamEvents: vi.fn(async function* () {}),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-send-stream-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  streamStartHandler = null;
  streamCancelHandler = null;
  groupChatMock.subscribers.clear();
  groupChatMock.quiescent = false;
  groupChatMock.releaseSend = null;
  groupChatMock.sendStarted = new Promise<void>((resolve) => { groupChatMock.resolveSendStarted = resolve; });
  groupChatMock.sendFinished = new Promise<void>((resolve) => { groupChatMock.resolveSendFinished = resolve; });
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe('ipc › conversations.sendStream', () => {
  it('ignores stream starts from an untrusted sender', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent = vi.fn();
    await streamStartHandler(
      {
        sender: {
          getURL: () => 'https://evil.example/index.html',
          isDestroyed: () => false,
          send: sent,
        },
      },
      {
        requestId: 'untrusted',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    expect(sent).not.toHaveBeenCalled();
    expect(groupChatMock.subscribers.size).toBe(0);
  });

  it('does not let a second sender cancel another sender\'s stream', async () => {
    if (!streamStartHandler || !streamCancelHandler) throw new Error('stream handlers not registered');
    const owner = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const other = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    let settled = false;
    const run = streamStartHandler(
      { sender: owner },
      {
        requestId: 'owned-stream',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    ).finally(() => { settled = true; });
    await groupChatMock.sendStarted;

    streamCancelHandler({ sender: other }, 'owned-stream');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    streamCancelHandler({ sender: owner }, 'owned-stream');
    await run;
    expect(settled).toBe(true);
    groupChatMock.releaseSend?.();
  });

  it('rejects a duplicate request id without replacing the original owner', async () => {
    if (!streamStartHandler || !streamCancelHandler) throw new Error('stream handlers not registered');
    const first = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const duplicateSent = vi.fn();
    const second = trustedIpcSender({ isDestroyed: () => false, send: duplicateSent });
    const original = streamStartHandler(
      { sender: first },
      {
        requestId: 'same-id',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;

    await streamStartHandler(
      { sender: second },
      {
        requestId: 'same-id',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'duplicate' },
      },
    );
    expect(duplicateSent).toHaveBeenNthCalledWith(1, 'stream:same-id', {
      type: 'error',
      text: 'duplicate stream request id',
    });
    expect(duplicateSent).toHaveBeenNthCalledWith(2, 'stream:same-id', { type: 'done' });

    streamCancelHandler({ sender: first }, 'same-id');
    await original;
    groupChatMock.releaseSend?.();
  });

  it('relays group bus events before groupChat.send resolves', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent: Array<{ channel: string; payload: any }> = [];
    const sender = trustedIpcSender({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    });

    const run = streamStartHandler(
      { sender },
      {
        requestId: 'req1',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;

    const liveEvent = {
      type: 'process',
      cid: 'c123abc',
      actor: 'agent1',
      data: { type: 'delta', text: 'live' },
    };
    for (const cb of groupChatMock.subscribers) cb(liveEvent);

    await waitFor(() => sent.some((item) => item.channel === 'stream:req1' && item.payload?.event?.data === liveEvent));
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;

    expect(sent.at(-1)).toEqual({ channel: 'stream:req1', payload: { type: 'done' } });
  });

  it('keeps relaying group bus events after groupChat.send resolves while the bus is still active', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent: Array<{ channel: string; payload: any }> = [];
    const sender = trustedIpcSender({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    });

    const run = streamStartHandler(
      { sender },
      {
        requestId: 'req2',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;
    groupChatMock.quiescent = false;
    groupChatMock.releaseSend?.();
    await groupChatMock.sendFinished;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);

    const liveEvent = {
      type: 'process',
      cid: 'c123abc',
      actor: 'agent1',
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'web_search' } } },
    };
    for (const cb of groupChatMock.subscribers) cb(liveEvent);

    await waitFor(() => sent.some((item) => item.channel === 'stream:req2' && item.payload?.event?.data === liveEvent));
    groupChatMock.quiescent = true;
    for (const cb of groupChatMock.subscribers) cb({ type: 'state_changed', cid: 'c123abc', state: { status: 'idle', in_flight: [] } });
    await run;

    expect(sent.at(-1)).toEqual({ channel: 'stream:req2', payload: { type: 'done' } });
  });
});
