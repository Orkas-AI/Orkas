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

/** Pause only the idle clock during an authoritative user interaction. Nested
 * waits are counted so one approval cannot resume another outstanding wait. */
export class AgentActivityClock {
  private lastActivity = Date.now();
  private waitStarted = 0;
  private waits = 0;

  progress(): void { this.lastActivity = Date.now(); }
  lastEventAt = (): number => this.waits ? Date.now() : this.lastActivity;

  pause(): () => void {
    if (this.waits++ === 0) this.waitStarted = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.waits === 0) {
        this.lastActivity = Math.min(Date.now(), this.lastActivity + Date.now() - this.waitStarted);
      }
    };
  }

  async waitForUser<T>(work: () => Promise<T>): Promise<T> {
    const resume = this.pause();
    try { return await work(); } finally { resume(); }
  }
}
