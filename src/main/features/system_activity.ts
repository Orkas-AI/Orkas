export type SystemActivitySnapshot = {
  wall_time_ms: number;
  suspended_total_ms: number;
  suspend_count: number;
};

type PowerMonitorLike = {
  on(event: 'suspend' | 'resume', listener: () => void): void;
};

/**
 * Tracks system sleep as a process-lifetime cumulative counter. Consumers take
 * a snapshot at the beginning and end of an operation and subtract the totals,
 * so background work remains elapsed time while actual machine suspension does
 * not inflate active execution duration.
 */
export class SystemActivityTracker {
  private started = false;
  private suspendedAtMs: number | null = null;
  private suspendedTotalMs = 0;
  private suspendCount = 0;

  constructor(
    private readonly monitor: PowerMonitorLike,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.monitor.on('suspend', () => this.onSuspend());
    this.monitor.on('resume', () => this.onResume());
  }

  snapshot(): SystemActivitySnapshot {
    this.start();
    const now = this.now();
    const pending = this.suspendedAtMs == null
      ? 0
      : Math.max(0, now - this.suspendedAtMs);
    return {
      wall_time_ms: Math.max(0, Math.round(now)),
      suspended_total_ms: Math.max(0, Math.round(this.suspendedTotalMs + pending)),
      suspend_count: this.suspendCount,
    };
  }

  private onSuspend(): void {
    if (this.suspendedAtMs != null) return;
    this.suspendedAtMs = this.now();
    this.suspendCount += 1;
  }

  private onResume(): void {
    if (this.suspendedAtMs == null) return;
    const now = this.now();
    this.suspendedTotalMs += Math.max(0, now - this.suspendedAtMs);
    this.suspendedAtMs = null;
  }
}

let trackerPromise: Promise<SystemActivityTracker> | null = null;

export async function getSystemActivitySnapshot(): Promise<SystemActivitySnapshot> {
  if (!trackerPromise) {
    trackerPromise = import('electron').then(({ powerMonitor }) => new SystemActivityTracker(powerMonitor));
  }
  const tracker = await trackerPromise;
  return tracker.snapshot();
}
