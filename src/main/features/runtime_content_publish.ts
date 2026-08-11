/**
 * Coordinates short runtime-content publication windows with model turns.
 *
 * Expensive staging happens before `withIdleRuntimePublish` is called. The
 * callback should contain only the final directory activation, metadata
 * commit, and cache invalidation. Active turns are never interrupted; the
 * prepared publication runs on the first busy -> idle transition. A turn that
 * arrives during that final window waits for the in-memory barrier to settle.
 */

interface PublishTask<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface UserPublishState {
  activeTurns: number;
  waitingTurns: number;
  publishing: Promise<void> | null;
  queued: Array<PublishTask<unknown>>;
}

const states = new Map<string, UserPublishState>();

function stateFor(uid: string): UserPublishState {
  let state = states.get(uid);
  if (!state) {
    state = { activeTurns: 0, waitingTurns: 0, publishing: null, queued: [] };
    states.set(uid, state);
  }
  return state;
}

function cleanupIfIdle(uid: string, state: UserPublishState): void {
  if (state.activeTurns === 0 && state.waitingTurns === 0 && !state.publishing && state.queued.length === 0) {
    states.delete(uid);
  }
}

function drain(uid: string, state: UserPublishState): void {
  if (state.activeTurns > 0 || state.publishing || state.queued.length === 0) return;
  const task = state.queued.shift()!;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  state.publishing = barrier;

  void (async () => {
    try {
      task.resolve(await task.run());
    } catch (err) {
      task.reject(err);
    } finally {
      if (state.publishing === barrier) state.publishing = null;
      releaseBarrier();
      drain(uid, state);
      cleanupIfIdle(uid, state);
    }
  })();
}

/** Register one complete model turn. The returned release is idempotent. */
export async function enterRuntimeContentTurn(uid: string): Promise<() => void> {
  while (true) {
    const state = stateFor(uid);
    const barrier = state.publishing;
    if (!barrier) {
      state.activeTurns += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.activeTurns = Math.max(0, state.activeTurns - 1);
        drain(uid, state);
        cleanupIfIdle(uid, state);
      };
    }
    state.waitingTurns += 1;
    try {
      await barrier;
    } finally {
      state.waitingTurns = Math.max(0, state.waitingTurns - 1);
      cleanupIfIdle(uid, state);
    }
  }
}

/**
 * Run a prepared publication on the next idle transition. There is no polling:
 * `enterRuntimeContentTurn`/its release own the state transition notification.
 */
export function withIdleRuntimePublish<T>(uid: string, publish: () => Promise<T>): Promise<T> {
  const state = stateFor(uid);
  const promise = new Promise<T>((resolve, reject) => {
    state.queued.push({
      run: publish,
      resolve: resolve as (value: unknown | PromiseLike<unknown>) => void,
      reject,
    });
  });
  drain(uid, state);
  return promise;
}

/** Test-only snapshot. */
export function _runtimeContentPublishState(uid: string): {
  activeTurns: number;
  waitingTurns: number;
  publishing: boolean;
  queued: number;
} {
  const state = states.get(uid);
  return {
    activeTurns: state?.activeTurns || 0,
    waitingTurns: state?.waitingTurns || 0,
    publishing: !!state?.publishing,
    queued: state?.queued.length || 0,
  };
}

/** Test-only reset; callers must not leave running callbacks behind. */
export function _resetRuntimeContentPublishForTests(): void {
  states.clear();
}
