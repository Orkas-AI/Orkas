import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type StreamStartFn = (
  event: { sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } },
  req: { requestId: string; channel: string; payload?: unknown },
) => Promise<void>;

let streamStartHandler: StreamStartFn | null = null;

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
    on: (channel: string, fn: StreamStartFn) => {
      if (channel === 'orkas.streamStart') streamStartHandler = fn;
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
  it('relays group bus events before groupChat.send resolves', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent: Array<{ channel: string; payload: any }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    };

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
    const sender = {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    };

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
