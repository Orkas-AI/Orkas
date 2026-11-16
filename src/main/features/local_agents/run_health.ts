/** Ephemeral read-only facts; never a stall verdict or a recovery trigger. */
import type { LocalEvent } from './backends/base';
import type { LocalCliType } from './registry';

export type RunPhase = 'unknown' | 'running' | 'reasoning' | 'tool_running' | 'waiting_approval' | 'waiting_input';
export interface RunHealth {
  runtime: 'cli' | 'unknown';
  cli: LocalCliType | null;
  phase: RunPhase;
  phase_elapsed_ms: number | null;
  wait_elapsed_ms: number | null;
  /** Real protocol/process activity; synthetic heartbeats never advance it. */
  last_activity_age_ms: number | null;
}
export type RunHealthReader = () => RunHealth | null;
const PROTOCOL_EVENTS = new Set(['thinking', 'text-delta', 'tool-event', 'media-output', 'async-message']);
const unknownHealth = (): RunHealth => ({ runtime: 'unknown', cli: null, phase: 'unknown',
  phase_elapsed_ms: null, wait_elapsed_ms: null, last_activity_age_ms: null });
export const RUN_HEALTH_CAP = 20;

/** Stop after cap+1 entries; neither scan history nor serialize private identity. */
export function boundedRunHealth(readers: Iterable<RunHealthReader | undefined>) {
  const runs: RunHealth[] = [];
  for (const read of readers) {
    if (runs.length === RUN_HEALTH_CAP) return { runs, runs_truncated: true };
    runs.push(read?.() ?? unknownHealth());
  }
  return { runs, runs_truncated: false };
}

export class LocalRunHealth {
  private closed = false;
  private base: RunPhase = 'unknown';
  private phase: RunPhase = 'unknown';
  private since: number | null = null;
  private lastActivity: number | null = null;
  private approval = { count: 0, since: 0 };
  private input = { count: 0, since: 0 };
  constructor(private cli: LocalCliType, private now = Date.now) {}

  private refresh() {
    const phase = this.approval.count ? 'waiting_approval' : this.input.count ? 'waiting_input' : this.base;
    if (phase !== this.phase) { this.phase = phase; this.since = this.now(); }
  }
  activity() {
    if (this.closed) return;
    this.lastActivity = this.now();
    if (this.base === 'unknown') this.base = 'running';
    this.refresh();
  }
  event(event: LocalEvent, activeTools: number) {
    if (this.closed || event.synthetic === true || event.type === 'idle') return;
    // Raw logs, lifecycle markers and host-generated notices do not establish
    // protocol progress. The backend supplies actual process I/O separately.
    if (!PROTOCOL_EVENTS.has(event.type)) return;
    this.lastActivity = this.now();
    this.base = activeTools > 0 || (event.type === 'tool-event' && event.phase === 'use') ? 'tool_running' : event.type === 'thinking' ? 'reasoning' : 'running';
    this.refresh();
  }
  beginWait(phase: 'waiting_approval' | 'waiting_input'): () => void {
    const wait = phase === 'waiting_approval' ? this.approval : this.input;
    if (wait.count++ === 0) wait.since = this.now();
    this.refresh();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      wait.count--;
      this.refresh();
    };
  }
  async wait<T>(phase: 'waiting_approval' | 'waiting_input', action: () => Promise<T>): Promise<T> {
    const end = this.beginWait(phase);
    try { return await action(); } finally { end(); }
  }
  close() { this.closed = true; }
  read: RunHealthReader = () => {
    if (this.closed) return null;
    const now = this.now();
    const wait = this.approval.count ? this.approval : this.input.count ? this.input : null;
    return { runtime: 'cli', cli: this.cli, phase: this.phase,
      phase_elapsed_ms: this.phase === 'unknown' || this.since === null ? null : Math.max(0, now - this.since),
      wait_elapsed_ms: wait ? Math.max(0, now - wait.since) : null,
      last_activity_age_ms: this.lastActivity === null ? null : Math.max(0, now - this.lastActivity) };
  };
}
