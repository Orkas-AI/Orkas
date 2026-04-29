import { describe, it, expect } from 'vitest';
import { Mutex, Semaphore, type SemaphoreInterface } from 'async-mutex';
import {
  sessionLock, globalSlots,
  acquireWithTimeout, acquireSemWithTimeout,
} from '../../../src/main/util/locks';

describe('locks › sessionLock', () => {
  it('returns the same Mutex instance for the same session id', () => {
    const a = sessionLock('sess-1');
    const b = sessionLock('sess-1');
    expect(a).toBe(b);
  });

  it('returns distinct Mutex instances for different session ids', () => {
    const a = sessionLock('sess-1');
    const b = sessionLock('sess-2');
    expect(a).not.toBe(b);
  });

  it('returned object is a Mutex (acquire/release contract)', async () => {
    const m = sessionLock('sess-' + Math.random());
    const release = await m.acquire();
    expect(typeof release).toBe('function');
    release();
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

