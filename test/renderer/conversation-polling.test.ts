import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf8');
const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string, functionSource = source): string {
  const asyncMarker = `async function ${name}`;
  const marker = `function ${name}`;
  const asyncStart = functionSource.indexOf(asyncMarker);
  const start = asyncStart >= 0 ? asyncStart : functionSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = functionSource.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < functionSource.length; i += 1) {
    const ch = functionSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return functionSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('conversation polling cancellation', () => {
  it('clears a valid zero-valued timer handle instead of leaving polling active', () => {
    const clearInterval = vi.fn();
    const context: any = {
      pollTimers: new Map([['c0', 0]]),
      clearInterval,
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('stopPolling'), context);

    context.stopPolling('c0');

    expect(clearInterval).toHaveBeenCalledWith(0);
    expect(context.pollTimers.has('c0')).toBe(false);
  });

  it('discards an in-flight history response after the live stream stops polling', async () => {
    const fetchResult = deferred<any>();
    const callbacks = new Map<number, () => Promise<void>>();
    const recovered: unknown[] = [];
    let nextTimer = 0;

    const context: any = {
      Map,
      Date,
      pollTimers: new Map(),
      pollMsgCounts: new Map([['c1', 1]]),
      setInterval(fn: () => Promise<void>) {
        nextTimer += 1;
        callbacks.set(nextTimer, fn);
        return nextTimer;
      },
      clearInterval(id: number) {
        callbacks.delete(id);
      },
      apiFetch: () => fetchResult.promise,
      isGroupConversationBusy: () => false,
      isConvPending: () => false,
      _isPolledAssistantMsg: (m: any) => !!m && m.from !== 'user',
      _isPolledUserMsg: (m: any) => !!m && m.from === 'user',
      _onPolledResponse: (...args: unknown[]) => recovered.push(args),
      t: (key: string) => key,
      window: { ConversationRuntime: {} },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_polledMessageKey'),
      extractFunction('startPolling'),
      extractFunction('stopPolling'),
    ].join('\n'), context);

    context.startPolling('c1');
    const staleTick = callbacks.get(1);
    expect(staleTick).toBeTypeOf('function');
    const pendingTick = staleTick!();

    // This mirrors the normal stream-end cleanup while the polling fetch is
    // still awaiting its history response.
    context.stopPolling('c1');
    fetchResult.resolve({
      json: async () => ({
        ok: true,
        history: [
          { id: 'u1', from: 'user', text: 'question' },
          { id: 'a1', from: 'commander', text: 'answer' },
        ],
        conversation: { processing: false },
      }),
    });
    await pendingTick;

    expect(recovered).toEqual([]);
    expect(context.pollTimers.has('c1')).toBe(false);
  });

  it('does not let an old request act on a newly-started poll for the same conversation', async () => {
    const firstFetch = deferred<any>();
    const callbacks = new Map<number, () => Promise<void>>();
    const recovered: unknown[] = [];
    let nextTimer = 0;
    let fetchCount = 0;

    const context: any = {
      Map,
      Date,
      pollTimers: new Map(),
      pollMsgCounts: new Map([['c1', 1]]),
      setInterval(fn: () => Promise<void>) {
        nextTimer += 1;
        callbacks.set(nextTimer, fn);
        return nextTimer;
      },
      clearInterval(id: number) {
        callbacks.delete(id);
      },
      apiFetch: () => {
        fetchCount += 1;
        return fetchCount === 1 ? firstFetch.promise : Promise.reject(new Error('not used'));
      },
      isGroupConversationBusy: () => false,
      isConvPending: () => false,
      _isPolledAssistantMsg: (m: any) => !!m && m.from !== 'user',
      _isPolledUserMsg: (m: any) => !!m && m.from === 'user',
      _onPolledResponse: (...args: unknown[]) => recovered.push(args),
      t: (key: string) => key,
      window: { ConversationRuntime: {} },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_polledMessageKey'),
      extractFunction('startPolling'),
      extractFunction('stopPolling'),
    ].join('\n'), context);

    context.startPolling('c1');
    const oldTick = callbacks.get(1)!();
    context.stopPolling('c1');
    context.startPolling('c1');
    expect(context.pollTimers.get('c1')).toBe(2);

    firstFetch.resolve({
      json: async () => ({
        ok: true,
        history: [
          { id: 'u1', from: 'user', text: 'question' },
          { id: 'a1', from: 'commander', text: 'answer' },
        ],
        conversation: { processing: false },
      }),
    });
    await oldTick;

    expect(recovered).toEqual([]);
    expect(context.pollTimers.get('c1')).toBe(2);
  });
});

// Polling is a health check, not a renderer. The bus observer
// (`groupChat.events`) is the single event producer for a live turn; when
// polling also rendered, one persisted reply could be painted twice — once by
// the observer and once by the polled recovery pass. This guards both halves:
// it must stay silent while runtime is busy, AND it must still rescue the
// conversation once runtime goes idle (otherwise a lost stream would hang the
// UI forever).
describe('conversation polling stays out of live rendering', () => {
  function runPollContext(responses: Array<Record<string, unknown>>) {
    const callbacks = new Map<number, () => Promise<void>>();
    const recovered: unknown[][] = [];
    const rendererCalls: string[] = [];
    let nextTimer = 0;
    let fetchCount = 0;

    const context: any = {
      Map,
      Date,
      pollTimers: new Map(),
      pollMsgCounts: new Map(),
      setInterval(fn: () => Promise<void>) {
        nextTimer += 1;
        callbacks.set(nextTimer, fn);
        return nextTimer;
      },
      clearInterval(id: number) { callbacks.delete(id); },
      apiFetch: () => {
        const body = responses[Math.min(fetchCount, responses.length - 1)];
        fetchCount += 1;
        return Promise.resolve({ json: async () => body });
      },
      isGroupConversationBusy: () => false,
      isConvPending: () => true,
      _isPolledAssistantMsg: (m: any) => !!m && m.from !== 'user',
      _isPolledUserMsg: (m: any) => !!m && m.from === 'user',
      _onPolledResponse: (...args: unknown[]) => recovered.push(args),
      t: (key: string) => key,
      // Any renderer entry point reachable from polling is a regression.
      window: {
        ConversationRuntime: new Proxy({}, {
          get: (_t, prop) => {
            rendererCalls.push(String(prop));
            return () => { rendererCalls.push(`called:${String(prop)}`); };
          },
        }),
      },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_polledMessageKey'),
      extractFunction('startPolling'),
      extractFunction('stopPolling'),
    ].join('\n'), context);

    return { context, callbacks, recovered, rendererCalls };
  }

  const HISTORY = [
    { id: 'u1', from: 'user', text: 'question' },
    { id: 'a1', from: 'commander', text: 'answer' },
  ];

  it('renders nothing while runtime is busy and still rescues the turn once it goes idle', async () => {
    const { context, callbacks, recovered, rendererCalls } = runPollContext([
      { ok: true, history: HISTORY, conversation: { processing: true } },
      { ok: true, history: HISTORY, conversation: { processing: false } },
    ]);

    context.startPolling('c1');
    const tick = callbacks.get(1)!;

    await tick();
    expect(rendererCalls, 'polling must not reach any renderer entry point').toEqual([]);
    expect(recovered, 'a busy turn is owned by the bus observer').toEqual([]);
    // Leaving the message unseen is what lets the idle pass below rescue it.
    // Marking it seen here would silently swallow the reply if the stream died.
    expect(context.pollMsgCounts.get('c1')).toBeUndefined();

    await tick();
    expect(recovered).toHaveLength(1);
    expect((recovered[0] as any[])[1]).toMatchObject({ id: 'a1' });
    expect(context.pollMsgCounts.get('c1')).toBeTruthy();
    expect(rendererCalls).toEqual([]);
  });
});

describe('conversation polling history reconcile', () => {
  function loadPolledResponse(state?: any, currentCid = 'c1') {
    const historyLoads: unknown[][] = [];
    const queueDrains: string[] = [];
    const context: any = {
      pendingConvs: new Map(state ? [['c1', state]] : []),
      currentCid,
      setGroupConversationBusy: vi.fn(),
      _updateConvSidebarBadge: vi.fn(),
      _updateConvSendUI: vi.fn(),
      loadConversationHistory: (...args: unknown[]) => { historyLoads.push(args); },
      _dispatchNextQueued: (cid: string) => { queueDrains.push(cid); },
      escapeHtml: (value: unknown) => String(value || ''),
      t: (key: string) => key,
      formatTime: () => 'now',
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_onPolledResponse'), context);
    return { context, historyLoads, queueDrains };
  }

  it('preserves an upward reading position when polling mounts the final reply', () => {
    const { context, historyLoads } = loadPolledResponse();

    context._onPolledResponse('c1', { id: 'a1', from: 'commander', text: 'done' });

    expect(historyLoads).toEqual([['c1', { preserveScroll: true }]]);
  });

  it('preserves scroll when a richer persisted final message needs reconciliation', () => {
    const finalEl = {
      style: { display: 'block' },
      textContent: 'visible answer',
    };
    const loadingEl = {
      isConnected: true,
      dataset: { msgId: 'a1' },
      querySelector: (selector: string) => (
        selector === '[data-role="final"]' ? finalEl : null
      ),
    };
    const { context, historyLoads } = loadPolledResponse({ loadingEl });

    context._onPolledResponse('c1', {
      id: 'a2',
      from: 'commander',
      text: 'done',
      form: { title: 'Follow-up' },
    });

    expect(historyLoads).toEqual([['c1', { preserveScroll: true }]]);
  });

  it('drains a background queue after polling repairs a missed terminal state', async () => {
    const { context, historyLoads, queueDrains } = loadPolledResponse(undefined, 'c2');

    await context._onPolledResponse('c1', {
      id: 'a1',
      from: 'commander',
      text: 'background turn finished',
    });

    expect(historyLoads, 'background settlement must not replace the visible transcript').toEqual([]);
    expect(queueDrains).toEqual(['c1']);
  });

  it('re-captures scrolling that happens while the async history request is in flight', () => {
    const start = conversationSource.indexOf('async function loadConversationHistory');
    const end = conversationSource.indexOf('\nfunction _messageRecordHasMountedSidecars', start);
    const body = conversationSource.slice(start, end);
    const responseGuard = body.indexOf('if (cid !== currentCid) return;');
    const lateSnapshot = body.indexOf(
      'if (preserveScroll) scrollSnapshot = _captureHistoryReloadScroll(container);',
    );
    const domReplacement = body.indexOf("container.innerHTML = '';");

    expect(responseGuard).toBeGreaterThanOrEqual(0);
    expect(lateSnapshot).toBeGreaterThan(responseGuard);
    expect(domReplacement).toBeGreaterThan(lateSnapshot);
  });

  it('keeps an explicit upward gesture paused even inside the near-bottom threshold', () => {
    const context: any = {
      Number,
      Math,
      _isNearFollowTarget: () => true,
    };
    vm.createContext(context);
    vm.runInContext(
      extractFunction('_captureHistoryReloadScroll', conversationSource),
      context,
    );

    const snapshot = context._captureHistoryReloadScroll({
      scrollTop: 790,
      scrollHeight: 1200,
      clientHeight: 400,
      _stickyUserPaused: true,
    });

    expect(snapshot.nearBottom).toBe(false);
    expect(snapshot.top).toBe(790);
  });
});
