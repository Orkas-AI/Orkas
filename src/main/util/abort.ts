export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw new Error('operation aborted');
  }
}

export function composeAbortSignal(
  parent: AbortSignal | undefined | null,
  timeoutMs: number,
  timeoutMessage: string,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(timeoutMessage));
      }, timeoutMs)
    : null;

  const onAbort = () => {
    const reason = (parent as (AbortSignal & { reason?: unknown }) | undefined | null)?.reason;
    controller.abort(reason || new Error('operation aborted'));
  };
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parent) parent.removeEventListener?.('abort', onAbort);
    },
  };
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined | null,
  timeoutMessage: string,
): Promise<Response> {
  const composed = composeAbortSignal(parentSignal, timeoutMs, timeoutMessage);
  try {
    return await fetch(input, { ...init, signal: composed.signal });
  } catch (err) {
    if (parentSignal?.aborted) throw new Error('operation aborted');
    if (composed.signal.aborted) throw new Error(timeoutMessage);
    throw err;
  } finally {
    composed.cleanup();
  }
}
