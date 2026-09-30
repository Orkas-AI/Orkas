/** Shared Agent execution policy. User-confirmed on 2026-09-08: one 24-hour
 * execution budget and 30 minutes without progress, including CLI Agents.
 * Retries and foreground/background transitions retain the original deadline.
 * Component IO deadlines remain owned by their callers. No persisted state. */
export const AGENT_EXECUTION_MAX_MS = 24 * 60 * 60 * 1000;
export const AGENT_EXECUTION_IDLE_MS = 30 * 60 * 1000;
export type AgentTimeoutKind = 'wall' | 'idle';

export function agentExecutionDeadline(startedAt = Date.now()): number {
  return startedAt + AGENT_EXECUTION_MAX_MS;
}

/** Measure idle time on the supplied clock (CLI hosts exclude OS suspension).
 * Nested user waits pause that same clock, so sleep overlapping an approval is
 * never deducted twice. Absolute execution deadlines remain wall-clock based. */
export class AgentActivityClock {
  private lastActivity: number;
  private waitStarted = 0;
  private waits = 0;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastActivity = now();
  }

  progress(): void { this.lastActivity = this.now(); }
  // Preserve the watchdog's wall-timestamp contract without changing every
  // backend: project only the remaining awake idle duration onto wall time.
  lastEventAt = (): number => Date.now() - (this.waits ? 0 : Math.max(0, this.now() - this.lastActivity));

  pause(): () => void {
    if (this.waits++ === 0) this.waitStarted = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.waits === 0) {
        const now = this.now();
        this.lastActivity = Math.min(now, this.lastActivity + now - this.waitStarted);
      }
    };
  }

  async waitForUser<T>(work: () => Promise<T>): Promise<T> {
    const resume = this.pause();
    try { return await work(); } finally { resume(); }
  }
}
