/**
 * Renderer notification channel with a bounded replay buffer.
 *
 * Main-process events that the renderer must see (telemetry rows, task
 * terminal projections, update notices) are emitted while the window may
 * be loading, reloading or gone. Each channel keeps the rows it could not
 * deliver and replays them on the next `flush()` (the window's
 * `did-finish-load`), newest-`maxPending` only.
 *
 * Owner-scoped channels carry account-private rows: a row is dropped at
 * emission unless its owner is the active account, and a buffered row is
 * dropped at flush if the active account has changed in between — a
 * previous account's terminal must never be attached to the next one.
 *
 * Dependencies are injected so the policy can be tested without Electron;
 * `index.ts` wires the real IPC broadcast, renderer readiness and the
 * active-user lookup.
 */

export type RendererChannelDeps = {
  /** True when the renderer accepted the message. */
  broadcast: (channel: string, payload: unknown) => boolean;
  /** True once the window finished loading and has not started reloading. */
  rendererReady: () => boolean;
  /** Active account id, or null when no account is active. */
  activeUserId: () => string | null;
};

export type RendererChannelOptions = {
  /** Rows kept while delivery is impossible; older rows are dropped first. */
  maxPending: number;
  /** Rows belong to an account: dropped at emission and at flush unless that
   *  account is the active one. */
  ownerScoped?: boolean;
  /** Buffer instead of broadcasting until the renderer reports ready. Owner-
   *  scoped channels always do; a global channel opts in. */
  requireRendererReady?: boolean;
};

export type RendererChannel = {
  readonly channel: string;
  /** Deliver now or buffer. `ownerUserId` is required on owner-scoped channels. */
  emit: (payload: unknown, ownerUserId?: string) => void;
  /** Replay buffered rows in order until the renderer refuses one. */
  flush: () => void;
  /** Buffered row count (tests and diagnostics). */
  pending: () => number;
};

type PendingRow = { ownerUserId: string; payload: unknown };

export function createRendererChannel(
  channel: string,
  options: RendererChannelOptions,
  deps: RendererChannelDeps,
): RendererChannel {
  const ownerScoped = options.ownerScoped === true;
  const waitForRenderer = ownerScoped || options.requireRendererReady === true;
  const pending: PendingRow[] = [];

  const emit = (payload: unknown, ownerUserId = ''): void => {
    if (ownerScoped && (!ownerUserId || deps.activeUserId() !== ownerUserId)) return;
    if ((waitForRenderer && !deps.rendererReady()) || !deps.broadcast(channel, payload)) {
      pending.push({ ownerUserId, payload });
      if (pending.length > options.maxPending) pending.shift();
    }
  };

  const flush = (): void => {
    const activeUserId = ownerScoped ? deps.activeUserId() : null;
    if (ownerScoped && !activeUserId) return;
    while (pending.length > 0) {
      const row = pending[0];
      if (ownerScoped && row.ownerUserId !== activeUserId) {
        // Never attach an old account's buffered rows to the new account.
        pending.shift();
        continue;
      }
      if (!deps.broadcast(channel, row.payload)) return;
      pending.shift();
    }
  };

  return { channel, emit, flush, pending: () => pending.length };
}
