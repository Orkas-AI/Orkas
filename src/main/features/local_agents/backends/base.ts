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
import * as path from 'node:path';
import { buildCliSpawnEnv, resolveCliCommand } from '../spawn-command.js';
import type { LocalCliPermissionPolicy } from '../registry.js';

type KillableChild = Pick<ChildProcessWithoutNullStreams, 'kill' | 'pid'>;
type SpawnFn = typeof spawn;

/** All event types a backend can emit. The runner removes private fields,
 *  persists the normalized event to `events.jsonl`, and forwards that same
 *  normalized shape through the existing group-chat stream. */
export type LocalEventType =
  | 'process-info'
  | 'text-delta'
  | 'async-message'
  | 'thinking'
  | 'tool-event'
  | 'media-output'
  | 'stderr-line'
  | 'status'
  | 'file-change'
  | 'log'
  | 'raw-line'
  | 'permission-request'
  | 'idle'
  | 'done';

/** Tool names whose result carries an image because the agent READ a file,
 *  not because it produced one. CLI file readers hand the file back as an
 *  image block, which is indistinguishable from generated media at the
 *  event layer — without this gate a plain "read that screenshot" bounces
 *  the user's own attachment back into the conversation as
 *  `![generated image]`. */
const FILE_READ_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'readfile',
  'notebookread',
  'view',
]);

/** True when a tool result's media came from reading a file rather than
 *  producing one. Unknown tool names return false so genuinely generated
 *  media is never dropped. */
export function isFileReadToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return FILE_READ_TOOL_NAMES.has(name.trim().toLowerCase());
}

export interface LocalEvent {
  type: LocalEventType;
  /** Free-form payload — exact keys vary per type. Documented inline at
   *  each emit site; a minimal index:
   *    process-info:       { pid, cwd, cmd, args, sessionId? }
   *    text-delta:         { text, phase?: 'commentary'|'final_answer', itemId? }
   *    async-message:      { text, itemId, questions: LocalCliAsyncQuestion[] }
   *    thinking:           { text?, summary? } backend-side;
   *                        { chars, summary?, itemId?, heartbeat?, synthetic? } after the
   *                        runner boundary (summary is bounded; raw reasoning
   *                        text never crosses)
   *    tool-event:         { tool, callId?, phase: 'use'|'result', input?, output?, outputRef?, skill_name?, connector_name? }
   *    media-output:       { source, callId?, items: [{ data?, uri?, mediaType?, name?, localName? }] }
   *                        // private adapter payload; runner materializes or sanitizes it;
   *                        // normalized remote items retain uri and may name a stable background cache target
   *    stderr-line:        { line }
   *    status:             { status, usage? }   // usage carried for status:'usage' running counters
   *    file-change:        { paths: string[], scope?: 'conversation-media', source?: string }
   *                        // CLI-native file metadata, or host-materialized media output
   *    log:                { level: 'debug'|'info'|'warn'|'error', message, source? }
   *    raw-line:           { line }             // stdout line we couldn't parse as our protocol
   *    permission-request: { id, tool?, input?, autoDecided: 'allow'|'deny', reason }
   *    idle:               { stalledMs, waitingOn?: [{ taskId, label }] }
   *                        // runner-emitted heartbeat on prolonged silence. `waitingOn`
   *                        // names the background tasks still open, so a run held by a
   *                        // task that never ends reads as a stated wait instead of a
   *                        // silent spinner.
   *    done:               { status: 'completed'|'failed'|'cancelled'|'timeout'|
   *                                  'missing_cli', error?, durationMs?, sessionId?, usage?,
   *                                  timeoutPhase?: 'foreground'|'background',
   *                                  failureKind?: 'cli_spawn'|'cli_protocol', retrySafe?: boolean }
   */
  [key: string]: unknown;
}

/** Host decision scope. `allow_run` is owned by Orkas and must never be
 * translated into a durable/native CLI-session grant. */
export type LocalCliPermissionDecision = 'allow_once' | 'allow_run' | 'deny';

export interface LocalCliPermissionRequest {
  /** Opaque upstream request id used only for the persisted process rail. */
  id?: string;
  tool?: string;
  description?: string;
  command?: string;
  subject?: string;
}

export interface LocalCliUserInputOption {
  label: string;
  description?: string;
}

export interface LocalCliUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: LocalCliUserInputOption[];
  isOther?: boolean;
  isSecret?: boolean;
  multiSelect?: boolean;
}

/** Non-blocking messages are delivered independently of a turn's final body.
 * Replies use the active-turn ingress, not a tool-request RPC response. */
export interface LocalCliAsyncQuestion {
  title: string;
  options?: string[];
}

export interface LocalCliUserInputRequest {
  id?: string;
  questions: LocalCliUserInputQuestion[];
  isBlocking?: boolean;
  autoResolutionMs?: number;
  /** Aborted when the CLI clears this specific request or its run ends. */
  signal?: AbortSignal;
  /** Send a native decline and wait for request-specific protocol evidence. */
  cancel?: () => Promise<'cancelled' | 'closed' | 'failed' | 'unknown'>;
}

export interface LocalCliUserInputResponse {
  cancelled: boolean;
  answers: Record<string, string[]>;
}

export interface BackendRunOptions {
  binPath: string;
  /** Current-turn user input. Durable agent/project/protocol guidance belongs
   * in `systemPrompt` and must not be appended as another user message. */
  prompt: string;
  /** Low-churn Orkas instructions for adapters with a native instruction
   * channel (Claude `--append-system-prompt`, Codex
   * `developerInstructions`). */
  systemPrompt?: string;
  /** Fresh-session payload used only when a requested native resume is
   * rejected before the turn begins. It contains bounded recovery context
   * plus the current turn, never the old unbounded transcript. */
  resumeFallbackPrompt?: string;
  /** The capability registry says this native session owns the same durable
   * instructions. Session-scoped adapters may omit the instruction override
   * on resume, but must restore it if resume falls back to a fresh session. */
  reuseSessionInstructions?: boolean;
  cwd: string;
  customArgs?: string[];
  /** Per-Agent overrides. Missing values deliberately leave selection to the
   * CLI/account configuration. */
  modelOverride?: string;
  thinkingLevel?: string;
  /** Per-Agent override. Missing/inherit leaves selection to the CLI's own
   * configuration. */
  permissionPolicy?: LocalCliPermissionPolicy;
  /** Host-owned human approval bridge. Missing or broken callers must be
   * treated as a denial by every backend. */
  requestPermission?: (request: LocalCliPermissionRequest) => Promise<LocalCliPermissionDecision>;
  /** Host-owned bridge for native CLI requests that pause for structured user
   * input. Answers stay in memory and are returned only to the requesting
   * process; they are never emitted as LocalEvents or persisted in run logs. */
  requestUserInput?: (request: LocalCliUserInputRequest) => Promise<LocalCliUserInputResponse>;
  /** When set, ask the CLI to resume a prior session by id (claude:
   *  `--resume <id>`). The group-chat caller consults the registry's resume
   *  capability first, so backends without resume support receive no stale
   *  handle and get a visibility-slice history bridge instead. */
  resumeSessionId?: string;
  /** Cancellation; backend wires this to SIGTERM (10s) → SIGKILL. */
  signal: AbortSignal;
  onEvent: (e: LocalEvent) => void;
  /** Publish the exact ingress owned by the currently active native CLI turn.
   * Backends call this with a handle only after their protocol has exposed an
   * addressable running turn, and clear it before/at every terminal boundary.
   * The host removes a durable queue item only when `submit` returns
   * `steered`; every other result is a safe ordinary follow-up. */
  onActiveRunIngress?: (ingress: LocalActiveRunIngress | null) => void;
  /** Register a running background phase so app shutdown can stop and await
   *  the process. This does not end or transfer the host turn: all background
   *  and resumed-foreground events keep flowing through `onEvent`. */
  onBackgroundRun?: (handle: {
    untilProcessExit: Promise<void>;
    /** How many background tasks are running right now. Read at hand-off for
     *  diagnostics. */
    liveTasks: () => number;
    /** End the run: let the CLI settle and write a clean session state, then
     *  reap. The background work does stop. */
    stop: (reason: string) => void;
  }) => void;
  /** Hard wall-clock cap — zombie insurance, NOT the hang detector
   *  (that's `idleKillMs`). Backends arm `armKillWatchdog` with both and
   *  emit `done({status:'timeout'})` when either fires before exit. */
  timeoutMs: number;
  /** Absolute dispatch deadline, shared by retries and background phases. */
  deadlineAt?: number;
  /** Kill the CLI when it emits no real progress for this long (ms).
   *  Unset / 0 explicitly disables idle-kill for diagnostic callers. */
  idleKillMs?: number;
  /** Activity clock maintained by the runner (ms epoch of the last real
   *  backend event). Events explicitly marked `synthetic` do not slide it. Read by the
   *  idle-kill watchdog; unset means no tracking and idle-kill stays off. */
  lastEventAt?: () => number;
  /** Real protocol progress omitted from the public event rail. */
  onActivity?: () => void;
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

/** Host-resolved user input for a running local CLI turn. Text contains the
 * complete rich-message frame (references, attachment paths, selected Skill
 * instructions and Connector routing). Codex can additionally consume
 * verified local images natively; other backends keep using the paths in the
 * text frame and their normal file tools. */
export interface LocalActiveRunInput {
  /** Stable host identity for acknowledgement/idempotency. */
  id: string;
  text: string;
  localImages?: Array<{ path: string; mediaType?: string }>;
}

export type LocalActiveRunIngressResult =
  | { mode: 'steered'; acceptedId?: string }
  | { mode: 'queued_followup'; reason?: string }
  | { mode: 'rejected'; reason: string };

export interface LocalActiveRunIngress {
  submit(input: LocalActiveRunInput): Promise<LocalActiveRunIngressResult>;
}

export interface LocalBackend {
  run(opts: BackendRunOptions): Promise<void>;
}

/** Remove terminal ANSI/OSC control sequences before diagnostics are
 * persisted or rendered. CLI stderr is presentation text, not a terminal;
 * retaining escapes produces visible fragments such as `[31mERROR`. */
export function stripAnsi(s: string): string {
  if (!s) return s;
  // OSC: ESC ] ... BEL or ESC \
  // eslint-disable-next-line no-control-regex
  const withoutOsc = s.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
  // CSI: ESC [ parameters/intermediates final-byte
  // eslint-disable-next-line no-control-regex
  return withoutOsc.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
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
 *  groups, so termination uses `taskkill /t /f` to include descendants. */
export function spawnCli(
  binPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const resolvedCwd = path.resolve(cwd);
  const childEnv = buildCliSpawnEnv(
    binPath,
    env ?? process.env,
    process.platform,
    undefined,
    resolvedCwd,
  );
  const launch = resolveCliCommand(binPath, args, process.platform, childEnv);
  const child = spawn(launch.command, launch.args, {
    cwd: resolvedCwd,
    env: childEnv,
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

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** Send `signal` to the child's whole process group on POSIX (the child
 *  is spawned detached, so its pgid == pid and `-pid` addresses the
 *  group). This reaps grandchildren that inherited the stdio pipes;
 *  signaling only the direct child leaves them orphaned and the run's
 *  `close` hangs for their full lifetime (see `spawnCli`). Windows uses
 *  taskkill's tree mode for the same reason. Both paths fall back to a
 *  direct child kill when the platform mechanism cannot start or fails. */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): void {
  const pid = child.pid;
  const platform = opts.platform ?? process.platform;
  if (pid && platform === 'win32') {
    try {
      const killer = (opts.spawnFn ?? spawn)(
        windowsSystem32Tool('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      const fallback = () => {
        try { child.kill(signal); } catch { /* already gone */ }
      };
      killer.once('error', fallback);
      killer.once('exit', (code) => {
        if (code !== 0) fallback();
      });
      if (typeof killer.unref === 'function') killer.unref();
      return;
    } catch {
      // Fall through to a best-effort direct child kill.
    }
  }
  if (pid && platform !== 'win32') {
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
 * A one-shot CLI's protocol terminal event is authoritative for the UI. Close
 * stdin and signal the whole process tree immediately, while the direct CLI
 * pid still identifies its descendants on Windows. Waiting for the CLI to exit
 * before signaling lets a detached child escape `taskkill /t`; cancelling that
 * delayed signal on `close` caused completed local-Agent runs to leave GUI and
 * test processes behind. The hard-kill fallback remains bounded and does not
 * hold the backend promise (and therefore the conversation loading state) open.
 */
export function reapCliAfterProtocolTerminal(
  child: ChildProcessWithoutNullStreams,
  hardKillGraceMs = 10_000,
): void {
  try { child.stdin.end(); } catch { /* already closed */ }

  killProcessTree(child, 'SIGTERM');
  const hardKill = setTimeout(
    () => killProcessTree(child, 'SIGKILL'),
    Math.max(0, hardKillGraceMs),
  );
  if (typeof hardKill.unref === 'function') hardKill.unref();

  child.once('close', () => {
    clearTimeout(hardKill);
  });
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
    // Only the new chunk can hold the next newline: rescanning the whole
    // buffered partial line per chunk made one long record (a base64 image
    // inside a single stream-json line) cost O(len²) on the main thread
    // (2026-08-28 review D-6).
    let scanFrom = this.buf.length;
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n', scanFrom)) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      scanFrom = 0;
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
  opts: { timeoutMs: number; deadlineAt?: number; idleKillMs?: number; lastEventAt?: () => number },
): { fired: () => 'wall' | 'idle' | null; reason: () => string; disarm: () => void } {
  const startedAt = Date.now();
  const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, startedAt + opts.timeoutMs);
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
    if (now >= deadlineAt) {
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
