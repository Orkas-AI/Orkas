import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
const marker = "'conversations.history': ";
const handlerSource = source.slice(
  source.indexOf(marker) + marker.length,
  source.indexOf("'conversations.turns':"),
).trim().replace(/,$/, '');

function setup() {
  let clock = 0;
  let resolveHistory!: (page: any) => void;
  let resolveRuntime!: (status: any) => void;
  const history = new Promise((resolve) => { resolveHistory = resolve; });
  const runtime = new Promise((resolve) => { resolveRuntime = resolve; });
  const info = vi.fn();
  const context = {
    performance: { now: () => clock },
    safeId: () => true,
    conversationProjectHint: () => null,
    isAgentEnabled: () => true,
    log: { info },
    chats: {
      getConversationMetadata: vi.fn(async () => { clock = 100; return { project_id: null }; }),
      getMessagesPage: vi.fn(() => history),
      getMessagesPageAtIndex: vi.fn(() => history),
      getMessagesPageAtMessageId: vi.fn(async () => null),
    },
    groupChat: { runtimeStatus: vi.fn(() => runtime), displaySnapshot: vi.fn(async () => ({ sequence: 7, turns: [] })) },
  };
  const handler = vm.runInNewContext(`(${handlerSource})`, context);
  return {
    context, handler, info,
    setClock: (value: number) => { clock = value; },
    resolveHistory, resolveRuntime,
  };
}

describe('conversation history latency diagnostics', () => {
  it.each(['history', 'runtime'])('identifies slow %s without logging message content or identity', async (slow) => {
    const s = setup();
    const page = { history: [{ id: 'private-message', text: 'Private reply' }], nextCursor: null };
    const request = s.handler({ cid: 'private-conversation' }, { userId: 'private-user' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.context.chats.getMessagesPage).toHaveBeenCalled();
    expect(s.context.groupChat.runtimeStatus).toHaveBeenCalled();
    s.setClock(300);
    if (slow === 'history') s.resolveRuntime({ processing: false });
    else s.resolveHistory(page);
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.setClock(1600);
    if (slow === 'history') s.resolveHistory(page);
    else s.resolveRuntime({ processing: false });
    const result = await request;
    expect(result.history).toEqual(page.history);
    expect(s.info).toHaveBeenCalledExactlyOnceWith('slow conversation history read', {
      metadata_ms: 100,
      history_ms: slow === 'history' ? 1500 : 200,
      runtime_ms: slow === 'runtime' ? 1500 : 200,
      total_ms: 1600, rows: 1, anchored: false,
    });
    expect(JSON.stringify(s.info.mock.calls)).not.toMatch(/private|Private/);
  });

  it('reads active display only for an explicit view rebuild, after the history read', async () => {
    const s = setup();
    const request = s.handler({ cid: 'c1', live: '1' }, { userId: 'u1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.context.groupChat.displaySnapshot).not.toHaveBeenCalled();
    s.resolveHistory({ history: [], nextCursor: null });
    s.resolveRuntime({ processing: true });
    expect((await request).live_display).toEqual({ sequence: 7, turns: [] });
    expect(s.context.groupChat.displaySnapshot).toHaveBeenCalledExactlyOnceWith('u1', 'c1', null);
  });

  it('keeps fast history reads silent', async () => {
    const s = setup();
    const request = s.handler({ cid: 'c1' }, { userId: 'u1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.setClock(200);
    s.resolveHistory({ history: [], nextCursor: null });
    s.resolveRuntime({ processing: false });
    expect((await request).history).toEqual([]);
    expect(s.info).not.toHaveBeenCalled();
    expect(s.context.groupChat.displaySnapshot).not.toHaveBeenCalled();
  });
});

// A quoted reference knows only the stable id of its original message. The
// renderer asks for the page around that id, which the history worker finds
// and reads in one pass (never a scan on main); the index-based anchor remains
// the search/turn-navigation contract and must not pay for an id scan.
function anchorSetup(found: boolean, indexedId = 'm23') {
  const latest = { history: [{ id: 'latest' }], nextCursor: 40, followingCursor: null };
  const indexed = {
    history: [{ id: indexedId }], historyIndexes: [23], nextCursor: 10, followingCursor: 30, pageStart: 20,
  };
  const quoted = {
    history: [{ id: 'm23' }], historyIndexes: [41], nextCursor: 35, followingCursor: 50, pageStart: 40, messageIndex: 41,
  };
  const context = {
    performance: { now: () => 0 },
    safeId: () => true,
    conversationProjectHint: () => null,
    isAgentEnabled: () => true,
    log: { info: vi.fn() },
    chats: {
      getConversationMetadata: vi.fn(async () => ({ project_id: null })),
      getMessagesPage: vi.fn(async () => latest),
      getMessagesPageAtIndex: vi.fn(async () => indexed),
      getMessagesPageAtMessageId: vi.fn(async () => (found ? quoted : null)),
    },
    groupChat: { runtimeStatus: vi.fn(async () => ({ processing: false })), displaySnapshot: vi.fn() },
  };
  const handler = vm.runInNewContext(`(${handlerSource})`, context);
  return { context, handler, latest, indexed, quoted };
}

describe('conversation history anchored on a quoted message id', () => {
  it('positions the page on the quoted message with one id read when only its id is known', async () => {
    const s = anchorSetup(true);
    const result = await s.handler({ cid: 'c1', around_message_id: 'm23' }, { userId: 'u1' });
    expect(s.context.chats.getMessagesPageAtMessageId).toHaveBeenCalledExactlyOnceWith('u1', 'c1', 'm23', 10, null);
    expect(s.context.chats.getMessagesPageAtIndex).not.toHaveBeenCalled();
    expect(s.context.chats.getMessagesPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      history: s.quoted.history,
      page_start: 40,
      history_indexes: [41],
      next_cursor: 35,
      following_cursor: 50,
    });
  });

  it('falls back to the latest page when the quoted message no longer exists', async () => {
    const s = anchorSetup(false);
    const result = await s.handler({ cid: 'c1', around_message_id: 'gone' }, { userId: 'u1' });
    expect(s.context.chats.getMessagesPageAtIndex).not.toHaveBeenCalled();
    expect(s.context.chats.getMessagesPage).toHaveBeenCalledOnce();
    expect(result.history).toEqual(s.latest.history);
    expect(result).not.toHaveProperty('page_start');
    expect(result).not.toHaveProperty('history_indexes');
  });

  it('keeps an indexed anchor on its direct page read without scanning for the id', async () => {
    const s = anchorSetup(true);
    const result = await s.handler(
      { cid: 'c1', around_index: 23, around_message_id: 'm23' }, { userId: 'u1' },
    );
    expect(s.context.chats.getMessagesPageAtMessageId).not.toHaveBeenCalled();
    expect(s.context.chats.getMessagesPageAtIndex).toHaveBeenCalledExactlyOnceWith('u1', 'c1', 23, 10, null);
    expect(result).toMatchObject({ page_start: 20, history_indexes: [23] });
  });

  // Sync can rewrite or reorder the source after a search index was taken.
  it('repairs a stale indexed anchor with one id read', async () => {
    const s = anchorSetup(true, 'someone-else');
    const result = await s.handler(
      { cid: 'c1', around_index: 23, around_message_id: 'm23' }, { userId: 'u1' },
    );
    expect(s.context.chats.getMessagesPageAtIndex).toHaveBeenCalledExactlyOnceWith('u1', 'c1', 23, 10, null);
    expect(s.context.chats.getMessagesPageAtMessageId).toHaveBeenCalledExactlyOnceWith('u1', 'c1', 'm23', 10, null);
    expect(result).toMatchObject({ history: s.quoted.history, page_start: 40, history_indexes: [41] });
  });
});


// Execute the actual generic invoke boundary. A typed deliberate close is a
// recoverable cancellation; an identical code/message on a crash is not.
describe('history close attribution at the real invoke boundary', () => {
  class Closed extends Error { readonly code = 'E_HISTORY_CLOSED'; }
  function invokeBoundary(reason?: Error) {
    const tree = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let callback = '';
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle'
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'orkas.invoke') callback = node.arguments[1].getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (!callback) throw Error('Missing actual invoke boundary');
    const log = { warn: vi.fn(), error: vi.fn() };
    const invoke = vm.runInNewContext(ts.transpileModule(`(${callback})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, {
      ConversationHistoryClosedError: Closed, log,
      isTrustedIpcSender: () => true, parseInvokeEnvelope: (value: unknown) => value,
      previewWindows: { isPreviewContents: () => false },
      resolveContext: async () => ({ userId: 'local-user' }),
      isPrivateAppConversationPayload: async () => false,
      invokeHandlers: { 'conversations.history': async () => { if (reason) throw reason; return { history: [] }; } },
      normalizeAppError: () => ({ error: 'Operation unavailable', code: 'E_INTERNAL' }),
      logErrorSummary: () => ({ kind: 'controlled' }),
      attachmentAddChannels: new Set(),
      marketplace: { getMarketplaceInstallErrorInfo: () => ({}) },
      logInvokeResultFailure: () => { throw Error('Unexpected result failure path'); },
    });
    const sender = { mainFrame: {} };
    return { log, run: () => invoke({ sender, senderFrame: sender.mainFrame },
      { channel: 'conversations.history', payload: { cid: 'private-conversation' } }) };
  }
  it('keeps typed close as a failed cancellation without misreporting a runtime error', async () => {
    const s = invokeBoundary(new Closed('Deliberate closure'));
    expect(await s.run()).toEqual({ ok: false, code: 'E_HISTORY_CLOSED', error: 'Operation unavailable' });
    expect(s.log.error).not.toHaveBeenCalled();
    expect(s.log.warn).toHaveBeenCalledExactlyOnceWith('conversation history request cancelled on close',
      { channel: 'conversations.history', code: 'E_HISTORY_CLOSED' });
    expect(JSON.stringify(s.log.warn.mock.calls)).not.toContain('private-conversation');
  });
  it.each(['ordinary-crash', 'code-lookalike'])('retains the error severity and failure result for %s', async shape => {
    const error = new Error('Conversation history worker stopped');
    if (shape === 'code-lookalike') Object.assign(error, { code: 'E_HISTORY_CLOSED' });
    const s = invokeBoundary(error);
    expect(await s.run()).toEqual({ ok: false, code: shape === 'code-lookalike' ? 'E_HISTORY_CLOSED' : 'E_INTERNAL', error: 'Operation unavailable' });
    expect(s.log.warn).not.toHaveBeenCalled();
    expect(s.log.error).toHaveBeenCalledOnce();
  });
  it('preserves successful history without cancellation or error diagnostics', async () => {
    const s = invokeBoundary();
    expect(await s.run()).toEqual({ ok: true, history: [] });
    expect(s.log.warn).not.toHaveBeenCalled();
    expect(s.log.error).not.toHaveBeenCalled();
  });
});
