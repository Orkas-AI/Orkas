/**
 * Per-session mutex + global concurrency semaphore for LLM calls.
 *
 * - `sessionLock(id)` serializes messages within one conversation (a session
 *   can't start a new turn while its previous one is still running).
 * - `globalSlots` bounds total concurrent LLM calls across the whole app.
 *   Capacity 10 covers worst-case group_chat fan-out (commander + several
 *   active gmember actors all turning concurrently) without starving
 *   unrelated chats / KB image extraction / reflection runs.
 */

import { Mutex, Semaphore, type MutexInterface, type SemaphoreInterface } from 'async-mutex';

/**
 * Keyed mutex registry whose entries disappear once nobody holds or waits on
 * them. The maps used to grow forever: every session id and, since
 * `uniquify-path` took a per-path lock for every write, every path ever
 * written kept a Mutex alive. Deleting an entry while a waiter still held the
 * old Mutex would break exclusion (the next caller would get a fresh Mutex),
 * so handles resolve the shared entry on every operation and reference-count
 * it: acquire/wait increments, release decrements, and the entry is dropped
 * only at zero with the mutex unlocked.
 */
class KeyedMutexRegistry {
  private readonly entries = new Map<string, { mutex: Mutex; refs: number }>();

  handle(key: string): MutexInterface {
    return new KeyedMutexHandle(this, key);
  }

  size(): number {
    return this.entries.size;
  }

  retain(key: string): { mutex: Mutex; refs: number } {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), refs: 0 };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    return entry;
  }

  release(key: string, entry: { mutex: Mutex; refs: number }): void {
    entry.refs -= 1;
    if (entry.refs <= 0 && !entry.mutex.isLocked() && this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
  }

  peek(key: string): Mutex | undefined {
    return this.entries.get(key)?.mutex;
  }
}

class KeyedMutexHandle implements MutexInterface {
  constructor(private readonly registry: KeyedMutexRegistry, private readonly key: string) {}

  async acquire(priority?: number): Promise<MutexInterface.Releaser> {
    const entry = this.registry.retain(this.key);
    let release: MutexInterface.Releaser;
    try {
      release = await entry.mutex.acquire(priority);
    } catch (err) {
      this.registry.release(this.key, entry);
      throw err;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      this.registry.release(this.key, entry);
    };
  }

  async runExclusive<T>(callback: () => Promise<T> | T, priority?: number): Promise<T> {
    const release = await this.acquire(priority);
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async waitForUnlock(priority?: number): Promise<void> {
    const entry = this.registry.retain(this.key);
    try {
      await entry.mutex.waitForUnlock(priority);
    } finally {
      this.registry.release(this.key, entry);
    }
  }

  isLocked(): boolean {
    return this.registry.peek(this.key)?.isLocked() ?? false;
  }

  release(): void {
    this.registry.peek(this.key)?.release();
  }

  cancel(): void {
    this.registry.peek(this.key)?.cancel();
  }
}

const sessionLocks = new KeyedMutexRegistry();

/** Return the Mutex handle for a session id. */
export function sessionLock(sessionId: string): MutexInterface {
  return sessionLocks.handle(sessionId);
}

const fileEditLocks = new KeyedMutexRegistry();

/** Per-file Mutex (keyed by absolute path) serializing the read-modify-write
 *  inside `edit_file`. Parallel workers run on separate runs but share one
 *  process and filesystem, so two concurrent edits of the SAME file would
 *  otherwise interleave stat→read→write and lose an update; this makes the
 *  freshness check + write atomic per file. Distinct files never contend. */
export function fileEditLock(absPath: string): MutexInterface {
  return fileEditLocks.handle(absPath);
}

/** Live entry counts, for tests that prove the registries do not grow. */
export function _keyedLockCountsForTest(): { sessions: number; files: number } {
  return { sessions: sessionLocks.size(), files: fileEditLocks.size() };
}

/** Cap concurrent LLM calls across all users. */
export const globalSlots: SemaphoreInterface = new Semaphore(10);

/** Cap concurrent in-process nested dispatches (commander → worker/agent
 *  sub-runs, G8d). Nested runs intentionally SKIP `globalSlots` to avoid the
 *  parent-holds / child-waits deadlock (a nested acquire while the parent turn
 *  already holds a slot), so they need their OWN bound: without it a single
 *  commander fan-out of N `run_worker` calls would spawn N concurrent model
 *  calls unbounded by `globalSlots`. Lower than `globalSlots` because each
 *  nested run is itself a full LLM turn. Only the commander dispatches
 *  (workers/agents get no dispatch tools), so this is never acquired
 *  re-entrantly — no deadlock. Override with ORKAS_MAX_DISPATCH_CONCURRENCY.
 *
 *  D10 (conversation-task-board plan): this gate is the ANONYMOUS-worker
 *  gate — renamed from `dispatchSlots`, semantics and default unchanged. It
 *  never governs named task-board executions; those go through the separate
 *  `agentTaskSlots` gate below, and the two never contend. */
const _workerCap = (() => {
  const n = Number.parseInt(process.env.ORKAS_MAX_DISPATCH_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();
export const workerSlots: SemaphoreInterface = new Semaphore(_workerCap);

export type Releaser = MutexInterface.Releaser;

/**
 * Acquire a mutex with a timeout. Resolves to the release function,
 * rejects with an Error on timeout.
 */
export async function acquireWithTimeout(mutex: MutexInterface, timeoutMs: number): Promise<Releaser> {
  let timer: NodeJS.Timeout | undefined;
  const acquirePromise = mutex.acquire();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('lock acquire timeout')), timeoutMs);
  });
  try {
    const release = await Promise.race([acquirePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return release;
  } catch (err) {
    if (timer) clearTimeout(timer);
    acquirePromise.then((release) => release()).catch(() => {});
    throw err;
  }
}

/**
 * Acquire a semaphore slot with a timeout. Resolves to [value, release],
 * rejects with an Error on timeout.
 */
export async function acquireSemWithTimeout(
  sem: SemaphoreInterface,
  timeoutMs: number,
): Promise<[number, SemaphoreInterface.Releaser]> {
  let timer: NodeJS.Timeout | undefined;
  const acquirePromise = sem.acquire();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('semaphore acquire timeout')), timeoutMs);
  });
  try {
    const result = await Promise.race([acquirePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    acquirePromise.then(([, release]) => release()).catch(() => {});
    throw err;
  }
}
