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
export type BootFn = () => Promise<unknown> | void;

interface Task {
  name: string;
  fn: BootFn;
  mode: BootMode;
}

const DEFAULT_DEFER_MS = 3_000;
const SLOW_WARN_MS = 1_500;

const _immediate: Task[] = [];
const _deferred: Task[] = [];
let _immediateRan = false;
let _deferredScheduled = false;

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
    void _runOne({ name, fn, mode }, 'immediate-late');
    return;
  }
  _immediate.push({ name, fn, mode });
}

/** Register a task to run `DEFAULT_DEFER_MS` after the immediate batch.
 *  Mode semantics identical to `registerImmediate`. Tasks registered
 *  AFTER the deferred batch has already fired execute standalone. */
export function registerDeferred(name: string, fn: BootFn, mode: BootMode = 'parallel'): void {
  if (_deferredScheduled && _deferredRan) {
    log.warn(`registerDeferred after batch ran, name=${name} — running standalone`);
    void _runOne({ name, fn, mode }, 'deferred-late');
    return;
  }
  _deferred.push({ name, fn, mode });
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
    setTimeout(() => {
      log.info(`boot deferred phase: tasks=${_deferred.length}`);
      _runBatch(_deferred, 'deferred')
        .catch((err) => log.warn(`deferred batch threw: ${(err as Error).message}`))
        .finally(() => { _deferredRan = true; });
    }, deferMs);
  }
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
  const t0 = Date.now();
  try {
    await Promise.resolve(t.fn());
  } catch (err) {
    log.warn(`task threw phase=${phase} name=${t.name}: ${(err as Error).message}`);
  }
  const ms = Date.now() - t0;
  if (ms > SLOW_WARN_MS) log.warn(`task slow phase=${phase} name=${t.name} ms=${ms}`);
}

/** Test-only — reset internal state so the suite can register & re-run. */
export function _resetForTests(): void {
  _immediate.length = 0;
  _deferred.length = 0;
  _immediateRan = false;
  _deferredScheduled = false;
  _deferredRan = false;
}
