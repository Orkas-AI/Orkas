import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = rendererSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = rendererSource.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < rendererSource.length; i += 1) {
    const ch = rendererSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return rendererSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('conversation history auto-load', () => {
  function forwardHarness() {
    const row: any = { dataset: { cid: 'c1', cursor: '120', state: 'idle' }, parentElement: null };
    const messages: string[] = [];
    const container = { scrollTop: 45, style: { scrollBehavior: 'smooth' }, querySelector: () => row,
      querySelectorAll: () => [], insertBefore() {} };
    row.parentElement = container;
    const context: any = {
      currentCid: 'c1', window: {},
      document: { getElementById: () => container, createDocumentFragment: () => ({}) },
      _historyRequestUrl: () => '/history?limit=10',
      _isConversationMissingResponse: () => false,
      _collapseSupersededInterruptionRecords: (rows: any[]) => rows,
      _mergeNativeSegmentRecords: (rows: any[]) => rows,
      _isVisibleGroupHistoryRecord: (row: any) => !row.dispatch,
      _groupMsgToLegacy: (row: any) => row,
      _setLoadNewerHistory: (_el: any, _cid: string, cursor: number) => { row.dataset.cursor = cursor; row.dataset.state = 'idle'; },
      _setHistoryLatestAction() {}, _markProgrammaticStickyScroll() {},
      _messageSelectionState: null, t: (key: string) => key,
      appendChatMessage: (message: any) => { messages.push(message.id); return null; },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_historyNextCursor') + '\nasync ' + extractFunction('_loadNewerConversationHistory'), context);
    return { context, row, messages, container };
  }

  it('keeps the reading position and offers a retry after a forward-page failure', async () => {
    const { context, row, messages, container } = forwardHarness();
    context.apiFetch = async () => ({ json: async () => ({ ok: false }) });
    await context._loadNewerConversationHistory('c1');
    expect(row.dataset.state).toBe('error');
    expect(row.textContent).toBe('chat.history_retry_newer');
    expect(messages).toEqual([]);
    context.apiFetch = async () => ({ json: async () => ({ ok: true, history: [{ id: 'next' }], following_cursor: null }) });
    await context._loadNewerConversationHistory('c1');
    expect(messages).toEqual(['next']);
    expect(row.dataset.cursor).toBeNull();
    expect(container.scrollTop).toBe(45);
  });

  it('does not replay live messages delivered while a forward page was pending', async () => {
    const { context, messages, container } = forwardHarness();
    let finish!: (response: any) => void;
    const liveRows: any[] = [];
    container.querySelectorAll = () => liveRows;
    context.apiFetch = () => new Promise(resolve => { finish = resolve; });
    const pending = context._loadNewerConversationHistory('c1');
    // The primary send stream has already painted these durable identities.
    liveRows.push({ dataset: { msgId: 'sent' } }, { dataset: { msgId: 'reply' } });
    finish({ json: async () => ({ ok: true, following_cursor: null,
      history: [{ id: 'intervening' }, { id: 'sent' }, { id: 'reply' }] }) });
    await pending;
    expect(messages).toEqual(['intervening']);
    expect(container.scrollTop).toBe(45);
  });

  it('keeps a paused reader on a live reply when missing history is inserted above it', async () => {
    const { context, row, container } = forwardHarness();
    const history = container as any;
    history._stickyUserPaused = true;
    history._stickyEnabled = false;
    history.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
    let insertedHeight = 0;
    const anchor = {
      classList: { contains: () => true }, isConnected: true,
      getBoundingClientRect: () => ({ top: 145 + insertedHeight - history.scrollTop,
        bottom: 945 + insertedHeight - history.scrollTop }),
    };
    row.nextElementSibling = anchor;
    history.insertBefore = () => { insertedHeight = 600; };
    context.apiFetch = async () => ({ json: async () => ({ ok: true,
      history: [{ id: 'intervening' }], following_cursor: null }) });
    const before = anchor.getBoundingClientRect().top;
    await context._loadNewerConversationHistory('c1');
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(history._stickyUserPaused).toBe(true);
    expect(history._stickyEnabled).toBe(false);
    expect(history.style.scrollBehavior).toBe('smooth');
  });

  it('discards a pending forward page after switching tasks', async () => {
    const { context, row, messages } = forwardHarness();
    let finish!: (response: any) => void;
    context.apiFetch = () => new Promise(resolve => { finish = resolve; });
    const pending = context._loadNewerConversationHistory('c1');
    expect(row.dataset.state).toBe('loading');
    context.currentCid = 'c2';
    finish({ json: async () => ({ ok: true, history: [{ id: 'other-task-row' }], following_cursor: null }) });
    await pending;
    expect(messages).toEqual([]);
  });

  it('triggers the older-page request when the user reaches the top threshold', () => {
    const calls: Array<[string, number]> = [];
    const row = { dataset: { state: 'idle', cursor: '120', cid: 'c1' } };
    const container = {
      scrollTop: 32,
      querySelector: () => row,
    };
    const context: any = {
      Number,
      String,
      currentCid: 'c1',
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      _isProgrammaticStickyScroll: () => false,
      _loadOlderConversationHistory: (cid: string, cursor: number) => {
        calls.push([cid, cursor]);
        return Promise.resolve();
      },
      _setEarlierHistoryLoaderState: () => {},
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_historyNextCursor'),
      extractFunction('_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    context._maybeAutoLoadEarlierHistory(container);

    expect(calls).toEqual([['c1', 120]]);
  });

  it('does not auto-load during a programmatic scroll or away from the top', () => {
    let calls = 0;
    const row = { dataset: { state: 'idle', cursor: '120', cid: 'c1' } };
    const context: any = {
      Number,
      String,
      currentCid: 'c1',
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      _isProgrammaticStickyScroll: () => true,
      _loadOlderConversationHistory: () => { calls += 1; },
      _setEarlierHistoryLoaderState: () => {},
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_historyNextCursor'),
      extractFunction('_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    context._maybeAutoLoadEarlierHistory({ scrollTop: 12, querySelector: () => row });
    context._isProgrammaticStickyScroll = () => false;
    context._maybeAutoLoadEarlierHistory({ scrollTop: 80, querySelector: () => row });

    expect(calls).toBe(0);
  });

  it('honors a real wheel gesture during the search jump scroll grace', () => {
    const listeners: Record<string, (event?: any) => void> = {};
    const calls: string[] = [];
    const row = {
      dataset: { cid: 'c1', state: 'idle' },
      getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
    };
    const container = {
      querySelector: (selector: string) => selector === '.chat-history-load-newer' ? row : null,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
      addEventListener: (name: string, listener: (event?: any) => void) => { listeners[name] = listener; },
    };
    const context: any = {
      Number,
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      _isProgrammaticStickyScroll: () => true,
      _maybeAutoLoadEarlierHistory: () => {},
      _loadNewerConversationHistory: (cid: string) => { calls.push(cid); },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_maybeAutoLoadNewerHistory'),
      extractFunction('_bindAutoLoadEarlierHistory'),
    ].join('\n'), context);

    context._bindAutoLoadEarlierHistory(container);
    listeners.scroll();
    expect(calls).toEqual([]);
    listeners.wheel({ deltaY: 100 });
    expect(calls).toEqual(['c1']);
  });

  it('keeps the previous reading anchor after prepending older content', () => {
    const context: any = { Number, Math };
    vm.createContext(context);
    vm.runInContext(extractFunction('_olderHistoryPrependTop'), context);

    expect(context._olderHistoryPrependTop(0, 800, 1280)).toBe(480);
    expect(context._olderHistoryPrependTop(24, 800, 1280)).toBe(504);
    expect(context._olderHistoryPrependTop(0, 800, 760)).toBe(0);
  });

  it('keeps the sentinel first and advances across internal-only raw pages', () => {
    const start = rendererSource.indexOf('async function _loadOlderConversationHistory');
    const end = rendererSource.indexOf('\nfunction _ensureCreateAgentInlineObserver', start);
    const body = rendererSource.slice(start, end);

    expect(body).toContain('while (cursor !== null && page.length === 0)');
    expect(body).toContain('_isVisibleGroupHistoryRecord(gm)');
    expect(body).toContain('container.insertBefore(fragment, row.nextSibling)');
    expect(body).not.toContain('container.insertBefore(fragment, row);');
  });

  it('uses an inline loading view instead of a clickable history button', () => {
    const start = rendererSource.indexOf('function _setLoadEarlierHistory');
    const end = rendererSource.indexOf('\nasync function _loadOlderConversationHistory', start);
    const body = rendererSource.slice(start, end);

    expect(body).toContain("_setEarlierHistoryLoaderState(row, 'idle')");
    expect(body).toContain('container.insertBefore(row, container.firstChild)');
    expect(body).toContain('_bindAutoLoadEarlierHistory(container)');
    expect(body).not.toContain('button.onclick');
    expect(styleSource).toContain('.chat-history-load-earlier.is-loading');
    expect(styleSource).toContain('.chat-history-inline-spinner');
  });
});
