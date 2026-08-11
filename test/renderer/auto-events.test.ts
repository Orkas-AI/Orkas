import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/auto-events.js'),
  'utf8',
);

type StreamRecord = {
  callback: (event: unknown) => void;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error?: unknown) => void;
};

function createHarness() {
  const streamRecords: StreamRecord[] = [];
  const unloadListeners: Array<() => void> = [];
  const monitorEvent = vi.fn();
  const monitorError = vi.fn();
  const loadConversations = vi.fn(async () => {});
  const loadAutoList = vi.fn(async () => {});
  const warn = vi.fn();
  const stream = vi.fn((_name: string, _payload: unknown, callback: (event: unknown) => void) => {
    let resolvePromise!: () => void;
    let rejectPromise!: (error?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const record = {
      callback,
      cancel: vi.fn(),
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    streamRecords.push(record);
    return { promise, cancel: record.cancel };
  });
  const window = {
    currentUserId: 'account-a',
    orkas: { stream },
    Monitor: { event: monitorEvent, error: monitorError },
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'beforeunload') unloadListeners.push(listener);
    }),
  } as Record<string, any>;
  const context = vm.createContext({
    window,
    currentUserId: 'account-a',
    createLogger: () => ({ warn }),
    loadConversations,
    loadAutoList,
    _autoLoadedOnce: true,
    setTimeout,
    clearTimeout,
    Promise,
  });
  vm.runInContext(source, context, { filename: 'auto-events.js' });

  return {
    window,
    stream,
    streamRecords,
    unloadListeners,
    monitorEvent,
    monitorError,
    loadConversations,
    loadAutoList,
    warn,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('automation event subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes user-visible state only for the active account', async () => {
    const harness = createHarness();
    harness.window.startAutoEventsSubscription();
    expect(harness.stream).toHaveBeenCalledWith(
      'autoTasks.events',
      {},
      expect.any(Function),
    );

    harness.streamRecords[0].callback({
      event: {
        type: 'conv_created',
        source: 'scheduled',
        user_id: 'account-b',
        task_id: 'foreign-task',
        cid: 'foreign-conversation',
      },
    });
    harness.streamRecords[0].callback({
      event: {
        type: 'conv_created',
        source: 'scheduled',
        task_id: 'missing-owner',
        cid: 'missing-owner-conversation',
      },
    });
    expect(harness.loadConversations).not.toHaveBeenCalled();
    expect(harness.monitorEvent).not.toHaveBeenCalled();

    harness.streamRecords[0].callback({
      event: {
        type: 'conv_created',
        source: 'scheduled',
        user_id: 'account-a',
        task_id: 'task-a',
        cid: 'conversation-a',
        duration_ms: 42,
      },
    });
    await flushPromises();

    expect(harness.loadConversations).toHaveBeenCalledTimes(1);
    expect(harness.loadAutoList).toHaveBeenCalledWith(true);
    expect(harness.monitorEvent).not.toHaveBeenCalled();
  });

  it('never reports telemetry from the best-effort UI stream', () => {
    const harness = createHarness();
    harness.window.startAutoEventsSubscription();
    harness.streamRecords[0].callback({
      event: {
        type: 'fire_failed',
        source: 'manual',
        user_id: 'account-a',
        task_id: 't'.repeat(200),
        cid: 'c'.repeat(200),
        error_code: 'secret token in an unbounded error string',
        duration_ms: Number.POSITIVE_INFINITY,
      },
    });

    expect(harness.loadAutoList).toHaveBeenCalledWith(true);
    expect(harness.monitorEvent).not.toHaveBeenCalled();
    expect(harness.monitorError).not.toHaveBeenCalled();
  });

  it('reconnects after an unexpected stream end without opening duplicates', async () => {
    const harness = createHarness();
    harness.window.startAutoEventsSubscription();
    harness.window.startAutoEventsSubscription();
    expect(harness.stream).toHaveBeenCalledTimes(1);

    harness.streamRecords[0].reject(new Error('transport ended'));
    await flushPromises();
    expect(harness.stream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.stream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.stream).toHaveBeenCalledTimes(2);
  });

  it('cancels on unload and does not resurrect a stale subscription', async () => {
    const harness = createHarness();
    harness.window.startAutoEventsSubscription();
    expect(harness.unloadListeners).toHaveLength(1);

    harness.unloadListeners[0]();
    expect(harness.streamRecords[0].cancel).toHaveBeenCalledTimes(1);
    harness.streamRecords[0].reject(new Error('cancelled'));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.stream).toHaveBeenCalledTimes(1);
  });
});
