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

const sessionLocks = new Map<string, MutexInterface>();

/** Return (creating on demand) the Mutex for a session id. */
export function sessionLock(sessionId: string): MutexInterface {
  let m = sessionLocks.get(sessionId);
  if (!m) {
    m = new Mutex();
    sessionLocks.set(sessionId, m);
  }
  return m;
}

/** Cap concurrent LLM calls across all users. */
export const globalSlots: SemaphoreInterface = new Semaphore(10);

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

