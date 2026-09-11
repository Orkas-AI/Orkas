import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => loggerMocks,
  logFromRenderer: vi.fn(),
}));

type StreamStartFn = (
  event: { sender: { getURL: () => string; isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } },
  req: { requestId: string; channel: string; payload?: unknown },
) => Promise<void>;
type StreamCancelFn = (
  event: { sender: { getURL: () => string } },
  requestId: unknown,
) => void;
type InvokeFn = (
  event: { sender: { getURL: () => string } },
  req: { channel: string; payload?: unknown },
) => Promise<Record<string, unknown>>;

let streamStartHandler: StreamStartFn | null = null;
let streamCancelHandler: StreamCancelFn | null = null;
let invokeHandler: InvokeFn | null = null;

const groupChatMock = vi.hoisted(() => ({
  subscribers: new Set<(ev: unknown) => void>(),
  quiescent: false,
  releaseSend: null as null | (() => void),
  resolveSendStarted: null as null | (() => void),
  resolveSendFinished: null as null | (() => void),
  sendStarted: Promise.resolve(),
  sendFinished: Promise.resolve(),
  sendCalls: [] as unknown[],
  retryCalls: [] as unknown[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
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
  send: vi.fn(async (input: unknown) => {
    groupChatMock.sendCalls.push(input);
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return { ok: true };
  }),
  retryFailedTurn: vi.fn(async (input: unknown) => {
    groupChatMock.retryCalls.push(input);
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return { ok: true, mode: 'resume' };
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
  invokeHandler = null;
  groupChatMock.subscribers.clear();
  groupChatMock.quiescent = false;
  groupChatMock.releaseSend = null;
  groupChatMock.sendCalls.length = 0;
  groupChatMock.retryCalls.length = 0;
  loggerMocks.debug.mockReset();
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
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

async function callGroupChatSend(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler(
    { sender: trustedIpcSender() },
    { channel: 'groupChat.send', payload },
  );
}

describe('connector assistance creation boundary', () => {
  it('persists only a validated target and rejects forged setup metadata before creating a conversation', async () => {
    const invokeCreate = (assistance: unknown) => invokeHandler!(
      { sender: trustedIpcSender() }, { channel: 'conversations.create', payload: { title: 'Set up seller', assistance } },
    );
    const created = await invokeCreate({
      kind: 'connector_setup', connector_id: 'xiaohongshu-seller', prompt: 'untrusted instructions', secret: 'private-value',
    });
    expect(created).toMatchObject({ ok: true, conversation: {
      assistance: { kind: 'connector_setup', connector_id: 'xiaohongshu-seller' },
    } });
    expect(JSON.stringify(created)).not.toContain('private-value');
    const chats = await import('../../../src/main/features/chats');
    const before = await chats.listConversations(TEST_UID);
    const rejected = await invokeCreate({ kind: 'connector_setup', connector_id: 'not-a-catalog-entry' });
    expect(rejected.ok).toBe(false);
    expect((await chats.listConversations(TEST_UID)).length).toBe(before.length);
    const ordinary = await invokeCreate(undefined);
    expect(ordinary.ok).toBe(true);
    expect((ordinary.conversation as any).assistance).toBeUndefined();
  });
});

describe('ipc › groupChat.send active-turn control', () => {
  it('preserves smart-retry identity when a repeated click enters the busy-conversation queue', async () => {
    const run = callGroupChatSend({
      cid: 'c123abc',
      content: 'Continue',
      retry_message_id: 'failed-message-1',
    });

    await groupChatMock.sendStarted;
    expect(groupChatMock.retryCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      failedMessageId: 'failed-message-1',
      visibleText: 'Continue',
    }]);
    expect(groupChatMock.sendCalls).toEqual([]);
    groupChatMock.releaseSend?.();
    await expect(run).resolves.toMatchObject({ ok: true, mode: 'resume' });
  });

  it('forwards explicit Send now authorization ', async () => {
    const run = callGroupChatSend({
      cid: 'c123abc',
      content: 'Apply this constraint now',
      steer_active_turn: true,
    });

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'Apply this constraint now',
      steerActiveTurn: true,
    }]);
    groupChatMock.releaseSend?.();
    await expect(run).resolves.toMatchObject({ ok: true });
  });

  it('forwards explicit active-turn authorization ', async () => {
    const run = callGroupChatSend({
      cid: 'c123abc',
      content: 'Apply this constraint now',
      steer_active_turn: true,
    });

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'Apply this constraint now',
      steerActiveTurn: true,
    }]);
    groupChatMock.releaseSend?.();
    await expect(run).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['a missing control', {}],
    ['an explicit false control', { steer_active_turn: false }],
    ['a string lookalike', { steer_active_turn: 'true' }],
  ])('requires an explicit true control for %s', async (_label, control) => {
    const run = callGroupChatSend({
      cid: 'c123abc',
      content: 'Keep this queued',
      ...control,
    });

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'Keep this queued',
    }]);
    groupChatMock.releaseSend?.();
    await expect(run).resolves.toMatchObject({ ok: true });
  });
});

describe('ipc › conversations.sendStream', () => {
  it.each(['preserve', 'hide_generated_prefix', 'invalid'])('forwards validated Commander display provenance %s on both send paths', async (mode) => {
    const content = '@commander first @指挥官 second';
    const payload = { cid: 'c123abc', content, commander_mention_display: mode };
    const expected = mode === 'invalid' ? undefined : mode;
    const invokeRun = callGroupChatSend(payload);
    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls[0].commander_mention_display).toBe(expected);
    expect(groupChatMock.sendCalls[0].text).toBe(content);
    groupChatMock.releaseSend?.();
    await invokeRun;

    if (!streamStartHandler) throw new Error('stream handler not registered');
    groupChatMock.sendStarted = new Promise<void>((resolve) => { groupChatMock.resolveSendStarted = resolve; });
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const streamRun = streamStartHandler({ sender }, {
      requestId: 'commander-display', channel: 'conversations.sendStream', payload,
    });
    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls[1].commander_mention_display).toBe(expected);
    expect(groupChatMock.sendCalls[1].text).toBe(content);
    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await streamRun;
  });

  it('passes the pre-routing title text separately from the routed message', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'title-text',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: '@VideoStudio Draft the launch video',
          title_text: 'Draft the launch video',
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: '@VideoStudio Draft the launch video',
      title_text: 'Draft the launch video',
    }]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('preserves an explicitly empty title body for a reference-only new task', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'reference-only-title',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'Please use these messages as reference.',
          title_text: '',
          references: [{ source_cid: 'source123abc', source_msg_id: 'msg123abc' }],
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'Please use these messages as reference.',
      title_text: '',
      references: [{ source_cid: 'source123abc', source_msg_id: 'msg123abc' }],
    }]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('routes a failed-message retry to the smart retry path instead of a normal send', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'retry-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'Continue',
          retry_message_id: 'failed-message-1',
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.retryCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      failedMessageId: 'failed-message-1',
      visibleText: 'Continue',
    }]);
    expect(groupChatMock.sendCalls).toEqual([]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

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

  it('treats a late cancel from the completed stream owner as idempotent cleanup', async () => {
    if (!streamStartHandler || !streamCancelHandler) throw new Error('stream handlers not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });

    await streamStartHandler(
      { sender },
      {
        requestId: 'already-settled',
        channel: 'groupChat.events',
        payload: { cid: 'c123abc' },
      },
    );
    loggerMocks.warn.mockClear();

    streamCancelHandler({ sender }, 'already-settled');

    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      'streamCancel: already settled',
      { request_id: 'alre...tled' },
    );
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

  // This is the renderer's PRIMARY event source, and the reason is timing: the
  // subscription is established synchronously before `groupChat.send`, so it
  // cannot miss a turn's opening events. The `groupChat.events` observer is
  // asynchronous and tear-down-prone; relying on it alone dropped a whole
  // turn's events when its abort raced a new send, and the persisted reply was
  // never rendered. Duplicate delivery is safe because the renderer addresses
  // rows by render key.
  it('relays bus events and stays open until the bus is quiescent', async () => {
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
    // Subscribed before `send` resolves — that ordering is the whole point.
    expect(groupChatMock.subscribers.size).toBe(1);
    for (const cb of groupChatMock.subscribers) cb(liveEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      sent.some((item) => item.channel === 'stream:req1' && item.payload?.event?.data === liveEvent),
      'a bus event emitted while send is still in flight must reach the renderer',
    ).toBe(true);
    // Still open: a turn that ended here would clear the composer's busy state
    // while the agent is mid-run.
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);
    expect(sent.some((item) => item.payload?.type === 'send_accepted')).toBe(false);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;

    expect(sent.filter((item) => item.payload?.type === 'send_accepted')).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ channel: 'stream:req1', payload: { type: 'done' } });
  });

  it('keeps relaying after groupChat.send resolves while the bus is still active', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      sent.some((item) => item.channel === 'stream:req2' && item.payload?.event?.data === liveEvent),
      'events emitted after send resolves must still reach the renderer',
    ).toBe(true);
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);

    groupChatMock.quiescent = true;
    for (const cb of groupChatMock.subscribers) cb({ type: 'state_changed', cid: 'c123abc', state: { status: 'idle', in_flight: [] } });
    await run;

    expect(sent.at(-1)).toEqual({ channel: 'stream:req2', payload: { type: 'done' } });
  });
});
