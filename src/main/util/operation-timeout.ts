export class OperationTimeoutError extends Error {
  readonly code: string;
  readonly timeoutMs: number;
  readonly stage: string;

  constructor(code: string, stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'OperationTimeoutError';
    this.code = code;
    this.timeoutMs = timeoutMs;
    this.stage = stage;
  }
}

export function envTimeoutMs(name: string, fallbackMs: number, minMs = 1_000, maxMs = 30 * 60 * 1000): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.min(maxMs, Math.max(minMs, Math.trunc(value)));
}

/**
 * Bound an operation without pretending the underlying work was cancelled.
 * The original promise is returned to `onLateSettlement`, allowing callers to
 * log eventual recovery or schedule a safe retry once a non-cancellable native
 * operation really has stopped.
 */
export async function withOperationTimeout<T>(
  operation: Promise<T>,
  opts: {
    timeoutMs: number;
    code: string;
    stage: string;
    onLateSettlement?: (operation: Promise<T>) => void;
  },
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new OperationTimeoutError(opts.code, opts.stage, opts.timeoutMs));
    }, opts.timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) opts.onLateSettlement?.(operation);
  }
}

export function operationErrorCode(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : fallback;
}
