/**
 * Boot-phase orchestrator for the main process.
 *
 * Replaces the ad-hoc mix of `setImmediate(...)` / `setTimeout(...)` /
 * `import().then(...)` / async IIFEs scattered through
 * `PC/src/main/index.ts::app.whenReady()`. Modules register their startup
 * work declaratively; this module drives execution + timing + error
 * containment from a single place.
 *
 * Two phases:
 *   - **immediate** — runs at the end of `app.whenReady`. For warmups
 *     and reconciles that don't block first paint but should start ASAP.
 *   - **deferred** — runs `DEFAULT_DEFER_MS` after immediate. For
 *     anything where a few extra seconds of latency is fine (per-task
 *     timer scheduling, periodic loops, marketplace updates).
 *
 * Two modes per task:
 *   - **parallel** (default) — fire-and-forget on the event loop. All
 *     parallel tasks since the last serial barrier run concurrently.
 *   - **serial** — barrier: drains the in-flight parallel batch, then
 *     awaits this task before starting the next one.
 *
 * Deferred work may also declare a resource class and idle preference. Delay
 * only makes the task eligible: admission waits for a quiet interaction
 * window, active conversation work always wins, and tasks sharing disk,
 * process, network, or model resources cannot overlap. Cancellation is
 * cooperative through the AbortSignal passed to each task.
 *
 * Note: "parallel" means non-blocking async on the same event loop, NOT
 * a worker thread. The boot tasks the renderer ships today are all I/O
 * bound (disk scan, network ping, IPC handshake), so event-loop
 * concurrency is sufficient. If a task ever needs CPU parallelism it
 * should opt into `worker_threads` inside its own fn — the runner does
 * not manage threads.
 *
 * Error containment: a task throwing is logged at `warn` (phase + name +
 * reason) and swallowed; the rest of the boot continues. Slow tasks
 * (>SLOW_WARN_MS) emit a `warn` so regressions show up in logs.
 */

import { createLogger } from '../logger';

const log = createLogger('boot');

export type BootMode = 'parallel' | 'serial';
export type BootResourceClass = 'disk' | 'network' | 'process' | 'model';
export type BootFn = (signal?: AbortSignal) => Promise<unknown> | void;

export interface BootTaskOptions {
  /** Tasks sharing a class never overlap, even when different delay cohorts
   * become eligible together. */
  resourceClass?: BootResourceClass;
  /** Prefer an interaction-idle window and never start during active chat work. */
  preferIdle?: boolean;
  /** Recent renderer input window. Defaults to 2 seconds. */
  recentActivityMs?: number;
  /** User activity may postpone work up to this long. Active chat work has no
   * deadline and always wins. Defaults to 2 minutes. */
  maxUserDeferralMs?: number;
  /** Cooperative slice budget. Expiry aborts the signal and logs; task code
   * can stop/yield at its next cancellation point. */
  maxSliceMs?: number;
  /** Admission recheck cadence. Primarily configurable for tests. */
  admissionPollMs?: number;
}

interface Task {
  name: string;
  fn: BootFn;
  mode: BootMode;
  delayMs: number;
  options: BootTaskOptions;
  signal?: AbortSignal;
}

const DEFAULT_DEFER_MS = 3_000;
const SLOW_WARN_MS = 1_500;

const _immediate: Task[] = [];
const _deferred: Task[] = [];
let _immediateRan = false;
let _deferredScheduled = false;
let _deferredStarted = false;
let _deferredBaseTimer: NodeJS.Timeout | null = null;
const _deferredOffsetTimers = new Set<NodeJS.Timeout>();
const _standaloneTimers = new Set<NodeJS.Timeout>();
const _resourceTails = new Map<BootResourceClass, Promise<void>>();
let _lastUserActivityAt = Date.now();
let _isRuntimeBusy: () => boolean = () => false;

export function configureBootAdmission(options: { isRuntimeBusy?: () => boolean } = {}): void {
  _isRuntimeBusy = typeof options.isRuntimeBusy === 'function'
    ? options.isRuntimeBusy : () => false;
}

export function noteBootUserActivity(at = Date.now()): void {
  _lastUserActivityAt = Math.max(_lastUserActivityAt, Number(at) || Date.now());
}

export interface ScheduledBootBackgroundTask {
  cancel(): void;
  promise: Promise<void>;
}

/** Schedule non-registry startup work (account/connectors) through the same
 * admission and resource queues used by deferred boot cohorts. */
export function scheduleBootBackground(
  name: string,
  fn: BootFn,
  delayMs = 0,
  options: BootTaskOptions = {},
): ScheduledBootBackgroundTask {
  let cancelled = false;
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const finish = (): void => {
    if (settled) return;
    settled = true;
    resolvePromise();
  };
  timer = setTimeout(() => {
    if (timer) _standaloneTimers.delete(timer);
    timer = null;
    if (cancelled) { finish(); return; }
    void _runOne({ name, fn, mode: 'serial', delayMs: 0, options, signal: controller.signal }, 'scheduled')
      .finally(finish);
  }, Math.max(0, delayMs));
  timer.unref?.();
  _standaloneTimers.add(timer);
  return {
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      controller.abort(new Error(`background task cancelled: ${name}`));
      if (timer) {
        clearTimeout(timer);
        _standaloneTimers.delete(timer);
        timer = null;
      }
      finish();
    },
    promise,
  };
}

/** Register a task to run as soon as `runBootPhases` is called (typically
 *  the tail of `app.whenReady`). Default mode is `parallel` — pass
 *  `'serial'` to make this task a barrier that waits for all previously-
 *  registered parallel tasks to settle, then runs to completion before
 *  the next task starts. */
export function registerImmediate(name: string, fn: BootFn, mode: BootMode = 'parallel'): void {
  if (_immediateRan) {
    // Late registration after the immediate batch has already fired —
    // execute standalone so the caller doesn't silently never run.
    log.warn(`registerImmediate after batch ran, name=${name} — running standalone`);
    void _runOne({ name, fn, mode, delayMs: 0, options: {} }, 'immediate-late');
    return;
  }
  _immediate.push({ name, fn, mode, delayMs: 0, options: {} });
}

/** Register a task to run `DEFAULT_DEFER_MS` after the immediate batch.
 *  `delayMs` is an additional offset from that base delay, used for work
 *  that should stay outside the first 30 seconds. Mode semantics are
 *  identical to `registerImmediate` within each delay cohort. */
export function registerDeferred(
  name: string,
  fn: BootFn,
  mode: BootMode = 'parallel',
  delayMs = 0,
  options: BootTaskOptions = {},
): void {
  const task = { name, fn, mode, delayMs: Math.max(0, delayMs), options };
  if (_deferredStarted) {
    log.warn(`registerDeferred after batches started, name=${name} — running standalone`);
    if (task.delayMs > 0) {
      const timer = setTimeout(() => {
        _deferredOffsetTimers.delete(timer);
        void _runOne(task, 'deferred-late');
      }, task.delayMs);
      _deferredOffsetTimers.add(timer);
    } else {
      void _runOne(task, 'deferred-late');
    }
    return;
  }
  _deferred.push(task);
}

let _deferredRan = false;

/** Drive the immediate batch, then schedule the deferred batch. Called
 *  once from `index.ts` at the bottom of `app.whenReady().then(...)`.
 *  Resolves AFTER the immediate batch completes; the deferred batch
 *  runs independently `deferMs` later. */
export async function runBootPhases(deferMs: number = DEFAULT_DEFER_MS): Promise<void> {
  if (_immediateRan) return;
  _immediateRan = true;
  log.info(`boot immediate phase: tasks=${_immediate.length}`);
  await _runBatch(_immediate, 'immediate');
  if (!_deferredScheduled) {
    _deferredScheduled = true;
    _deferredBaseTimer = setTimeout(() => {
      _deferredBaseTimer = null;
      log.info(`boot deferred phase: tasks=${_deferred.length}`);
      _runDeferredBatches()
        .catch((err) => log.warn(`deferred batch threw: ${(err as Error).message}`))
        .finally(() => { _deferredRan = true; });
    }, deferMs);
  }
}

async function _runDeferredBatches(): Promise<void> {
  _deferredStarted = true;
  const cohorts = new Map<number, Task[]>();
  for (const task of _deferred) {
    const tasks = cohorts.get(task.delayMs) || [];
    tasks.push(task);
    cohorts.set(task.delayMs, tasks);
  }
  const runs = Array.from(cohorts, ([delayMs, tasks]) => {
    if (delayMs === 0) return _runBatch(tasks, 'deferred');
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        _deferredOffsetTimers.delete(timer);
        _runBatch(tasks, `deferred+${delayMs}ms`)
          .catch((err) => log.warn(`deferred offset batch threw delay=${delayMs}: ${(err as Error).message}`))
          .finally(resolve);
      }, delayMs);
      _deferredOffsetTimers.add(timer);
    });
  });
  await Promise.allSettled(runs);
}

async function _runBatch(tasks: Task[], phase: string): Promise<void> {
  const inFlight: Promise<unknown>[] = [];
  for (const t of tasks) {
    if (t.mode === 'serial') {
      // Barrier: settle any pending parallel work before running this
      // task, then await it.
      if (inFlight.length) {
        await Promise.allSettled(inFlight);
        inFlight.length = 0;
      }
      await _runOne(t, phase);
    } else {
      inFlight.push(_runOne(t, phase));
    }
  }
  if (inFlight.length) await Promise.allSettled(inFlight);
}

async function _runOne(t: Task, phase: string): Promise<void> {
  const resource = t.options.resourceClass;
  if (resource) {
    const previous = _resourceTails.get(resource) || Promise.resolve();
    const run = previous.catch(() => undefined).then(() => _runAdmitted(t, phase));
    const tail = run.then(() => undefined, () => undefined);
    _resourceTails.set(resource, tail);
    try { await run; }
    finally { if (_resourceTails.get(resource) === tail) _resourceTails.delete(resource); }
    return;
  }
  await _runAdmitted(t, phase);
}

async function _runAdmitted(t: Task, phase: string): Promise<void> {
  if (t.signal?.aborted) return;
  if (t.options.preferIdle && !(await _waitForAdmission(t, phase))) return;
  const t0 = Date.now();
  const controller = new AbortController();
  const abortFromTask = (): void => controller.abort(t.signal?.reason);
  t.signal?.addEventListener('abort', abortFromTask, { once: true });
  if (t.signal?.aborted) abortFromTask();
  let sliceTimer: NodeJS.Timeout | null = null;
  if (Number(t.options.maxSliceMs) > 0) {
    sliceTimer = setTimeout(() => {
      controller.abort(new Error(`background slice exceeded: ${t.name}`));
      log.warn(`task slice exceeded phase=${phase} name=${t.name} ms=${t.options.maxSliceMs}`);
    }, Number(t.options.maxSliceMs));
    sliceTimer.unref?.();
  }
  try {
    await Promise.resolve(t.fn(controller.signal));
  } catch (err) {
    log.warn(`task threw phase=${phase} name=${t.name}: ${(err as Error).message}`);
  } finally {
    if (sliceTimer) clearTimeout(sliceTimer);
    t.signal?.removeEventListener('abort', abortFromTask);
  }
  const ms = Date.now() - t0;
  if (ms > SLOW_WARN_MS) log.warn(`task slow phase=${phase} name=${t.name} ms=${ms}`);
}

async function _waitForAdmission(t: Task, phase: string): Promise<boolean> {
  const eligibleAt = Date.now();
  const recentActivityMs = Math.max(0, t.options.recentActivityMs ?? 2_000);
  const maxUserDeferralMs = Math.max(0, t.options.maxUserDeferralMs ?? 120_000);
  const pollMs = Math.max(10, t.options.admissionPollMs ?? 1_000);
  let logged = false;
  while (true) {
    if (t.signal?.aborted) return false;
    let runtimeBusy = false;
    try { runtimeBusy = _isRuntimeBusy(); } catch { runtimeBusy = false; }
    const userRecent = (Date.now() - _lastUserActivityAt) < recentActivityMs;
    const userDeadlineReached = (Date.now() - eligibleAt) >= maxUserDeferralMs;
    if (!runtimeBusy && (!userRecent || userDeadlineReached)) return true;
    if (!logged) {
      logged = true;
      log.info(`task waiting for idle phase=${phase} name=${t.name} runtime_busy=${runtimeBusy} user_recent=${userRecent}`);
    }
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        t.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, pollMs);
      timer.unref?.();
      t.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Test-only — reset internal state so the suite can register & re-run. */
export function _resetForTests(): void {
  if (_deferredBaseTimer) clearTimeout(_deferredBaseTimer);
  _deferredBaseTimer = null;
  for (const timer of _deferredOffsetTimers) clearTimeout(timer);
  _deferredOffsetTimers.clear();
  for (const timer of _standaloneTimers) clearTimeout(timer);
  _standaloneTimers.clear();
  _immediate.length = 0;
  _deferred.length = 0;
  _immediateRan = false;
  _deferredScheduled = false;
  _deferredStarted = false;
  _deferredRan = false;
  _resourceTails.clear();
  _lastUserActivityAt = Date.now();
  _isRuntimeBusy = () => false;
}
