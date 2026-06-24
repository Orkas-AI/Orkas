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

const fileEditLocks = new Map<string, MutexInterface>();

/** Per-file Mutex (keyed by absolute path) serializing the read-modify-write
 *  inside `edit_file`. Parallel workers run on separate runs but share one
 *  process and filesystem, so two concurrent edits of the SAME file would
 *  otherwise interleave stat→read→write and lose an update; this makes the
 *  freshness check + write atomic per file. Distinct files never contend. */
export function fileEditLock(absPath: string): MutexInterface {
  let m = fileEditLocks.get(absPath);
  if (!m) {
    m = new Mutex();
    fileEditLocks.set(absPath, m);
  }
  return m;
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
 *  re-entrantly — no deadlock. Override with ORKAS_MAX_DISPATCH_CONCURRENCY. */
const _dispatchCap = (() => {
  const n = Number.parseInt(process.env.ORKAS_MAX_DISPATCH_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();
export const dispatchSlots: SemaphoreInterface = new Semaphore(_dispatchCap);

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

