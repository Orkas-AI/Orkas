/**
 * Common contract + helpers for all local CLI backends.
 *
 * `LocalBackend.run` is the single entry point each backend implements:
 * spawn the binary, parse its native output (stream-json or ACP),
 * normalize each event to a `LocalEvent`, and emit them through
 * `onEvent`. The runner sequences spawning, persistence, and the
 * outbound bus message — backends only translate.
 *
 * Two helpers everyone needs:
 *   - `StderrTail` — bounded ring buffer for diagnostic context when a
 *     CLI crashes mid-run; the runner attaches the tail to a failed
 *     `done` event so users see the last 64 KB instead of "exit 3".
 *   - `spawnCli` — uniform spawn options (windowsHide + ignored stdin
 *     close on EPIPE during cancel).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** All event types a backend can emit. The runner persists these to
 *  `events.jsonl` verbatim and forwards them to the renderer through
 *  the existing group-chat stream. */
export type LocalEventType =
  | 'process-info'
  | 'text-delta'
  | 'thinking'
  | 'tool-event'
  | 'stderr-line'
  | 'status'
  | 'log'
  | 'raw-line'
  | 'permission-request'
  | 'idle'
  | 'done';

export interface LocalEvent {
  type: LocalEventType;
  /** Free-form payload — exact keys vary per type. Documented inline at
   *  each emit site; a minimal index:
   *    process-info:       { pid, cwd, cmd, args, sessionId? }
   *    text-delta:         { text }
   *    thinking:           { text }
   *    tool-event:         { tool, callId?, phase: 'use'|'result', input?, output?, outputPath? }
   *    stderr-line:        { line }
   *    status:             { status, usage? }   // usage carried for status:'usage' running counters
   *    log:                { level: 'debug'|'info'|'warn'|'error', message, source? }
   *    raw-line:           { line }             // stdout line we couldn't parse as our protocol
   *    permission-request: { id, tool?, input?, autoDecided: 'allow'|'deny', reason }
   *    idle:               { stalledMs }        // runner-emitted heartbeat on prolonged silence
   *    done:               { status: 'completed'|'failed'|'cancelled'|'timeout'|
   *                                  'missing_cli', error?, durationMs?, sessionId?, usage? }
   */
  [key: string]: unknown;
}

export interface BackendRunOptions {
  binPath: string;
  prompt: string;
  cwd: string;
  model?: string;
  customArgs?: string[];
  /** When set, ask the CLI to resume a prior session by id (claude:
   *  `--resume <id>`). Backends that don't support resume ignore the
   *  field; the runner's session-bookkeeping treats that as "no
   *  optimisation possible — fall back to slice replay". */
  resumeSessionId?: string;
  /** Cancellation; backend wires this to SIGTERM (10s) → SIGKILL. */
  signal: AbortSignal;
  onEvent: (e: LocalEvent) => void;
  /** Wall-clock cap. Backends should arm a timer and emit
   *  `done({status:'timeout'})` when it fires before the CLI exits. */
  timeoutMs: number;
  /** Per-backend idle threshold override (ms). Read by `runner.ts`'s
   *  idle-heartbeat to decide when to emit `{type:'idle'}` events. When
   *  unset the runner uses its own default (90 s; configurable via
   *  ORKAS_LOCAL_AGENT_IDLE_MS). Backends with no streaming (today:
   *  openclaw) should pass a smaller value so users get an early "still
   *  alive" pulse instead of staring at a blank rail for the full run. */
  idleMs?: number;
}

export interface LocalBackend {
  run(opts: BackendRunOptions): Promise<void>;
}

/** Bounded stderr collector. ringBytes overrides the default 64 KB cap. */
export class StderrTail {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap = 64 * 1024) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
    }
    // Single chunk over cap → keep its tail.
    if (this.chunks.length === 1 && this.size > this.cap) {
      const only = this.chunks[0];
      this.chunks[0] = only.slice(only.length - this.cap);
      this.size = this.cap;
    }
  }

  toString(): string {
    return this.chunks.join('');
  }
}

/** Standard spawn options. Returns a child with stdio: pipe/pipe/pipe. */
export function spawnCli(
  binPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawn(binPath, args, {
    cwd,
    env: env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Swallow EPIPE during cancel; the OS will close the pipe when the
  // child dies before we finish writing the prompt.
  child.stdin.on('error', () => { /* noop */ });
  return child;
}

/**
 * Iterate over newline-delimited chunks. Buffers partial lines across
 * `data` events. Each yielded line excludes the terminating `\n` /
 * `\r\n`. Used by stream-json backends; ACP also uses NDJSON so the
 * helper is shared.
 */
export class LineSplitter {
  private buf = '';
  /** Push a chunk; emit each complete line via `onLine`. */
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  }
  /** Flush any trailing line without a newline (e.g. CLI exited early). */
  flush(onLine: (line: string) => void): void {
    if (this.buf.length > 0) {
      onLine(this.buf);
      this.buf = '';
    }
  }
}

/** Normalize a free-form log level string to our 4-tier scale. CLIs
 *  use various conventions (`debug` / `DEBUG` / `verbose` / `warning`
 *  / `err` / numeric); unknown values fold to `info`. Shared by every
 *  backend's `log`-event emit site so the renderer can rely on the
 *  4-value enum. */
export function levelOrInfo(raw: unknown): 'debug' | 'info' | 'warn' | 'error' {
  if (typeof raw !== 'string') return 'info';
  const s = raw.toLowerCase();
  if (s === 'debug' || s === 'trace' || s === 'verbose') return 'debug';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'error' || s === 'err' || s === 'fatal') return 'error';
  return 'info';
}

/**
 * Wire abort + grace-kill behavior. Returns a cleanup function the
 * caller must invoke after the child exits to detach listeners.
 */
export function bindAbort(child: ChildProcessWithoutNullStreams, signal: AbortSignal, graceMs = 10_000): () => void {
  let killTimer: NodeJS.Timeout | null = null;
  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, graceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  };
}
