import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { Mutex, Semaphore, type SemaphoreInterface } from 'async-mutex';
import {
  sessionLock, fileEditLock, globalSlots,
  acquireWithAbort, acquireWithTimeout, acquireSemWithTimeout,
  _keyedLockCountsForTest,
} from '../../../src/main/util/locks';

describe('locks › sessionLock', () => {
  it('handles for the same session id share one exclusion', async () => {
    const a = sessionLock('sess-shared');
    const b = sessionLock('sess-shared');
    const releaseA = await a.acquire();
    expect(b.isLocked()).toBe(true);
    let bHeld = false;
    const bPending = b.acquire().then((release) => { bHeld = true; return release; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bHeld).toBe(false);
    releaseA();
    const releaseB = await bPending;
    expect(bHeld).toBe(true);
    releaseB();
    expect(a.isLocked()).toBe(false);
  });

  it('distinct session ids never contend', async () => {
    const a = sessionLock('sess-1');
    const b = sessionLock('sess-2');
    const releaseA = await a.acquire();
    const releaseB = await b.acquire();
    releaseA();
    releaseB();
  });

  it('returned object is a Mutex (acquire/release contract)', async () => {
    const m = sessionLock('sess-' + Math.random());
    const release = await m.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  it('drops an entry once nobody holds or waits on it, but never while a waiter holds an old handle', async () => {
    // The registries used to keep a Mutex for every session id and every path
    // ever written. Entries must go away when idle — and only then: a waiter
    // that already resolved the entry must keep excluding a newcomer.
    const before = _keyedLockCountsForTest();
    const key = `/tmp/orkas-lock-${Math.random()}`;
    const first = fileEditLock(key);
    const releaseFirst = await first.acquire();
    expect(_keyedLockCountsForTest().files).toBe(before.files + 1);

    const waiter = fileEditLock(key);
    const order: string[] = [];
    const waiting = waiter.runExclusive(async () => { order.push('waiter'); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst();
    // Released, but the waiter is queued: the entry stays and the newcomer
    // still queues behind the waiter instead of getting a fresh mutex.
    expect(_keyedLockCountsForTest().files).toBe(before.files + 1);
    await fileEditLock(key).runExclusive(async () => { order.push('newcomer'); });
    await waiting;
    expect(order).toEqual(['waiter', 'newcomer']);
    expect(_keyedLockCountsForTest().files).toBe(before.files);

    // A session lock evicts the same way after its last release.
    const session = sessionLock('sess-evict');
    const release = await session.acquire();
    expect(_keyedLockCountsForTest().sessions).toBe(before.sessions + 1);
    release();
    expect(_keyedLockCountsForTest().sessions).toBe(before.sessions);
  });
});

describe('locks › globalSlots', () => {
  it('is a Semaphore instance', () => {
    expect(globalSlots).toBeDefined();
    expect(typeof globalSlots.acquire).toBe('function');
  });

  it('has capacity 10 (covers worst-case group_chat fan-out)', async () => {
    // Grab every slot we think should be available, then prove the 11th
    // can't be acquired instantly. Release all to leave state clean.
    const held: Array<() => void> = [];
    try {
      for (let i = 0; i < 10; i += 1) {
        const [, release] = await acquireSemWithTimeout(globalSlots, 500);
        held.push(release);
      }
      await expect(acquireSemWithTimeout(globalSlots, 40)).rejects.toThrow('semaphore acquire timeout');
    } finally {
      held.forEach((r) => r());
    }
  });
});

describe('locks › acquireWithAbort', () => {
  it('does not queue an acquisition when already cancelled', async () => {
    const ac = new AbortController();
    const reason = new Error('cancel before admission');
    ac.abort(reason);
    const acquire = vi.fn();
    await expect(acquireWithAbort(acquire, ac.signal)).rejects.toBe(reason);
    expect(acquire).not.toHaveBeenCalled();
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('settles cancellation while the holder remains active and returns the late lease before live FIFO waiters run', async () => {
    const sem = new Semaphore(1);
    const [, holder] = await sem.acquire();
    const ac = new AbortController();
    const reason = new Error('cancel queued admission');
    const cancelled = acquireWithAbort(async () => (await sem.acquire())[1], ac.signal);
    const rejection = expect(cancelled).rejects.toBe(reason);
    const order: string[] = [];
    const first = sem.runExclusive(() => { order.push('first'); });
    const second = sem.runExclusive(() => { order.push('second'); });
    try {
      ac.abort(reason);
      await rejection;
      expect(sem.getValue()).toBe(0);
      expect(order).toEqual([]);
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    } finally {
      holder();
    }
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(sem.getValue()).toBe(1);
  });

  it('lets the caller clean up a grant that wins the cancellation race without entering work', async () => {
    const ac = new AbortController();
    const release = vi.fn();
    const pending = acquireWithAbort(() => Promise.resolve(release), ac.signal);
    ac.abort();
    const acquired = await pending;
    const work = vi.fn();
    try {
      expect(() => {
        ac.signal.throwIfAborted();
        work();
      }).toThrow();
    } finally {
      acquired();
    }
    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('leaves an admitted lease under its caller ownership when cancellation arrives later', async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    const release = await acquireWithAbort(async () => (await sem.acquire())[1], ac.signal);
    try {
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
      ac.abort();
      expect(sem.getValue()).toBe(0);
    } finally {
      release();
    }
    expect(sem.getValue()).toBe(1);
  });
});

describe('locks › acquireWithTimeout', () => {
  it('resolves to a release function on success', async () => {
    const m = new Mutex();
    const release = await acquireWithTimeout(m, 1000);
    expect(typeof release).toBe('function');
    release();
  });

  it('rejects with timeout error when mutex is held', async () => {
    const m = new Mutex();
    const hold = await m.acquire();
    try {
      await expect(acquireWithTimeout(m, 50)).rejects.toThrow('lock acquire timeout');
    } finally {
      hold();
    }
  });

  it('does not leak mutex if acquire wins after timeout fires', async () => {
    // Hold mutex briefly so the inner acquire wins after the timeout has rejected.
    const m = new Mutex();
    const hold = await m.acquire();
    const pending = acquireWithTimeout(m, 30).catch((err) => err);
    await new Promise((r) => setTimeout(r, 50));
    hold();
    await pending; // resolved with error
    // The lock should be free now (auto-released by the timeout cleanup logic).
    await new Promise((r) => setTimeout(r, 20));
    const r = await acquireWithTimeout(m, 100);
    expect(typeof r).toBe('function');
    r();
  });
});

describe('locks › acquireSemWithTimeout', () => {
  it('resolves to [value, release] on success', async () => {
    const sem = new Semaphore(2);
    const [value, release] = await acquireSemWithTimeout(sem, 1000);
    expect(typeof value).toBe('number');
    expect(typeof release).toBe('function');
    release();
  });

  it('rejects with timeout when all slots held', async () => {
    const sem = new Semaphore(1);
    const [, hold] = await sem.acquire();
    try {
      await expect(acquireSemWithTimeout(sem, 50)).rejects.toThrow('semaphore acquire timeout');
    } finally {
      hold();
    }
  });

  it('does not leak slot if acquire wins after timeout', async () => {
    const sem = new Semaphore(1);
    const [, hold] = await sem.acquire();
    const pending = acquireSemWithTimeout(sem, 30).catch((err) => err);
    await new Promise((r) => setTimeout(r, 50));
    hold();
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    const [, release] = await acquireSemWithTimeout(sem, 100);
    release();
  });
});
