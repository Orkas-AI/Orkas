/** Account-scoped reflection handoff. Foreground work cancels model inference
 * immediately and drains only tool executions that already entered storage.
 * The registry is shared by the CJS host and ESM-loaded host adapters. */
interface ReflectionLease {
  signal: AbortSignal;
  runTool<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}
interface ActiveReflection {
  controller: AbortController;
  tools: Set<Promise<unknown>>;
}
const key = Symbol.for('orkas.reflection-coordination');
const root = globalThis as typeof globalThis & { [key]?: Map<string, ActiveReflection> };
const active = root[key] ??= new Map<string, ActiveReflection>();

function yieldedError(): Error {
  return Object.assign(new Error('Reflection yielded to foreground work'), { code: 'REFLECTION_YIELDED' });
}
export function isReflectionYield(reason: unknown): boolean {
  return (reason as { code?: unknown } | undefined)?.code === 'REFLECTION_YIELDED';
}

export function beginReflection(uid: string, parent?: AbortSignal): ReflectionLease | null {
  if (active.has(uid) || parent?.aborted) return null;
  const entry: ActiveReflection = { controller: new AbortController(), tools: new Set() };
  const abort = () => entry.controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  active.set(uid, entry);
  let closed = false;
  return {
    signal: entry.controller.signal,
    async runTool(execute, signal) {
      const check = () => {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
        if (signal?.aborted) throw signal.reason;
        if (closed) throw new Error('Reflection already closed');
      };
      check();
      const work = Promise.resolve().then(() => { check(); return execute(); });
      entry.tools.add(work);
      try { return await work; }
      finally { entry.tools.delete(work); }
    },
    async close() {
      closed = true;
      parent?.removeEventListener('abort', abort);
      // A timed-out provider may return later; closed leases deny new tools.
      await Promise.allSettled([...entry.tools]);
      if (active.get(uid) === entry) active.delete(uid);
    },
  };
}

/** No Promise and no admission delay when no reflection tool is in flight. */
export function yieldReflectionForTask(uid: string): Promise<void> | undefined {
  const entry = active.get(uid);
  if (!entry) return;
  entry.controller.abort(yieldedError());
  if (entry.tools.size) return Promise.allSettled([...entry.tools]).then(() => undefined);
}
