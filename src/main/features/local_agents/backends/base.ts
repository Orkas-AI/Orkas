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
import { resolveCliCommand } from '../spawn-command.js';

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
  | 'file-change'
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
   *    file-change:        { paths: string[] }   // files reported by CLI-native diff/tool metadata
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
  /** Hard wall-clock cap — zombie insurance, NOT the hang detector
   *  (that's `idleKillMs`). Backends arm `armKillWatchdog` with both and
   *  emit `done({status:'timeout'})` when either fires before exit. */
  timeoutMs: number;
  /** Kill the CLI when it emits no events for this long (ms). Unset /
   *  0 disables idle-kill — the runner disables it for backends with no
   *  mid-run event stream (openclaw), where silence is normal. */
  idleKillMs?: number;
  /** Activity clock maintained by the runner (ms epoch of the last
   *  non-idle backend event). Read by the idle-kill watchdog; unset
   *  means no activity tracking and idle-kill stays off. */
  lastEventAt?: () => number;
  /** Per-backend idle threshold override (ms). Read by `runner.ts`'s
   *  idle-heartbeat to decide when to emit `{type:'idle'}` events. When
   *  unset the runner uses its own default (90 s; configurable via
   *  ORKAS_LOCAL_AGENT_IDLE_MS). Backends with no streaming (today:
   *  openclaw) should pass a smaller value so users get an early "still
   *  alive" pulse instead of staring at a blank rail for the full run. */
  idleMs?: number;
  /** orkas-bridge injection (plan §D — set by runner.ts when a bridge
   *  host is live for this run). Backends that support adding an MCP
   *  server pass the config through (claude: `--mcp-config`; codex:
   *  `-c mcp_servers.…` overrides); others ignore the field. The env
   *  block must be launch-safe: no bridge token/socket values. */
  bridge?: {
    mcpConfigPath: string;
    /** The raw MCP server entry, for backends that take config values
     *  instead of a config file (codex `-c` overrides). */
    server: { command: string; args: string[]; env: Record<string, string> };
    appendSystemPrompt?: string;
  };
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

/** Standard spawn options. Returns a child with stdio: pipe/pipe/pipe.
 *
 *  `detached` (POSIX only) makes the child a process-group leader so
 *  `killProcessTree` can signal the WHOLE group, not just the CLI itself.
 *  Without it, killing the CLI on abort/timeout leaves its descendants
 *  (tool subprocesses, the orkas-bridge MCP child, a shell's forked last
 *  command) orphaned but still holding the inherited stdout/stderr pipes
 *  — so the run's `close` event never fires until those descendants exit
 *  on their own, making abort/timeout appear to hang. We do NOT `unref`:
 *  the run still awaits the child's lifetime. Windows has no POSIX process
 *  groups, so it stays on the direct-child kill path. */
export function spawnCli(
  binPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const launch = resolveCliCommand(binPath, args);
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
  });
  // Swallow EPIPE during cancel; the OS will close the pipe when the
  // child dies before we finish writing the prompt.
  child.stdin.on('error', () => { /* noop */ });
  return child;
}

/** Send `signal` to the child's whole process group on POSIX (the child
 *  is spawned detached, so its pgid == pid and `-pid` addresses the
 *  group). This reaps grandchildren that inherited the stdio pipes;
 *  signaling only the direct child leaves them orphaned and the run's
 *  `close` hangs for their full lifetime (see `spawnCli`). Falls back to
 *  a direct child kill on Windows or when the group is already gone. */
export function killProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      // ESRCH: the group is already gone — nothing left to signal.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      // Any other error (e.g. the child never became a group leader):
      // fall through to a best-effort direct kill.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
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
 * Activity-aware kill watchdog shared by every backend. Two independent
 * limits, polled on a coarse interval:
 *
 *   - `timeoutMs` — hard wall-clock cap. Zombie insurance; generous by
 *     design. It used to double as the hang detector at 20 min, which
 *     killed healthy long dispatches mid-work (a 20-min claude turn with
 *     80 tool events died at exactly 1200000 ms — run 1dffe7c48d18).
 *   - `idleKillMs` + `lastEventAt` — fires only when the CLI emitted NO
 *     events for the whole window. This is the actual hang detector.
 *     Long quiet tool calls are real (observed ~10 min for a model
 *     download), so callers keep this comfortably above them.
 *
 * On fire: SIGTERM, then SIGKILL after 10 s. The backend's close handler
 * reads `fired()` to map the exit to `done({status:'timeout'})`, and
 * `reason()` for the error text — worded inside the `isTransientError`
 * timeout family so plan-step retry can resume the session.
 */
export function armKillWatchdog(
  child: ChildProcessWithoutNullStreams,
  opts: { timeoutMs: number; idleKillMs?: number; lastEventAt?: () => number },
): { fired: () => 'wall' | 'idle' | null; reason: () => string; disarm: () => void } {
  const startedAt = Date.now();
  const idleKillMs = opts.idleKillMs && opts.idleKillMs > 0 && opts.lastEventAt
    ? opts.idleKillMs
    : 0;
  let firedKind: 'wall' | 'idle' | null = null;
  let firedIdleMs = 0;

  const kill = () => {
    killProcessTree(child, 'SIGTERM');
    const hardKill = setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000);
    if (typeof hardKill.unref === 'function') hardKill.unref();
  };

  // Poll instead of one-shot timers so the idle window slides with
  // activity. Coarse 5 s tick in production; sub-second limits (tests)
  // divide down so they still fire promptly.
  const minLimit = idleKillMs ? Math.min(opts.timeoutMs, idleKillMs) : opts.timeoutMs;
  const tickMs = Math.max(25, Math.min(5_000, Math.floor(minLimit / 4)));
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= opts.timeoutMs) {
      firedKind = 'wall';
    } else if (idleKillMs) {
      const idleFor = now - opts.lastEventAt!();
      if (idleFor >= idleKillMs) {
        firedKind = 'idle';
        firedIdleMs = idleFor;
      }
    }
    if (firedKind) {
      clearInterval(ticker);
      kill();
    }
  }, tickMs);
  if (typeof ticker.unref === 'function') ticker.unref();

  return {
    fired: () => firedKind,
    reason: () => (
      firedKind === 'idle'
        ? `timed out: no activity for ${firedIdleMs}ms (idle cap ${idleKillMs}ms)`
        : `timed out: exceeded ${opts.timeoutMs}ms wall-clock cap`
    ),
    disarm: () => clearInterval(ticker),
  };
}

/**
 * Wire abort + grace-kill behavior. Returns a cleanup function the
 * caller must invoke after the child exits to detach listeners.
 */
export function bindAbort(child: ChildProcessWithoutNullStreams, signal: AbortSignal, graceMs = 10_000): () => void {
  let killTimer: NodeJS.Timeout | null = null;
  const onAbort = () => {
    killProcessTree(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
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
