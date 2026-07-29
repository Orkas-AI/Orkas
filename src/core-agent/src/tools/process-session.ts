import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildSandboxedShellInvocation,
  buildSandboxEnv,
  decodeProcessOutput,
  killProcessTree,
} from "../sandbox/executor.js";
import {
  defineTool,
  type AgentTool,
  type CommandExecutionObservation,
  type ToolContext,
  type ToolResult,
} from "./base.js";

export type ProcessSessionStatus = "running" | "exited" | "error" | "stopped";

interface ProcessSession {
  id: string;
  owner: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  closed: boolean;
  env: NodeJS.ProcessEnv;
  status: ProcessSessionStatus;
  createdAt: number;
  updatedAt: number;
  output: string;
  outputStart: number;
  outputEnd: number;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  executionObservationReported: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  lifetimeTimer: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

const PROCESS_OUTPUT_BUFFER_CHARS = 1_000_000;
const PROCESS_READ_DEFAULT_CHARS = 32_000;
const PROCESS_READ_MAX_CHARS = 64_000;
const PROCESS_INPUT_MAX_CHARS = 64_000;
const PROCESS_COMMAND_PREVIEW_CHARS = 800;
const PROCESS_DEFAULT_LIFETIME_MS = 6 * 60 * 60 * 1000;
const PROCESS_MIN_LIFETIME_MS = 60_000;
const PROCESS_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PROCESS_EXITED_RETENTION_MS = 60 * 60 * 1000;
const PROCESS_MAX_RUNNING_PER_OWNER = 8;
const PROCESS_INITIAL_ACTIVITY_WAIT_MS = process.platform === "win32" ? 1_500 : 300;

const sessions = new Map<string, ProcessSession>();

function processOwner(ctx: ToolContext): string {
  const owner = ctx.state?.processSessionOwner;
  return typeof owner === "string" ? owner : "";
}

function boundedLifetime(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return PROCESS_DEFAULT_LIFETIME_MS;
  return Math.max(
    PROCESS_MIN_LIFETIME_MS,
    Math.min(PROCESS_MAX_LIFETIME_MS, Math.trunc(numberValue)),
  );
}

function commandPreview(command: string): string {
  return command.length <= PROCESS_COMMAND_PREVIEW_CHARS
    ? command
    : `${command.slice(0, PROCESS_COMMAND_PREVIEW_CHARS)}...`;
}

function appendOutput(
  session: ProcessSession,
  bytes: Buffer | string,
  stream?: "stdout" | "stderr",
): void {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  if (stream === "stdout") session.stdoutBytes += buffer.length;
  if (stream === "stderr") session.stderrBytes += buffer.length;
  const text = decodeProcessOutput(buffer, process.platform, session.env);
  if (!text) return;
  session.output += text;
  session.outputEnd += text.length;
  if (session.output.length > PROCESS_OUTPUT_BUFFER_CHARS) {
    const dropped = session.output.length - PROCESS_OUTPUT_BUFFER_CHARS;
    session.output = session.output.slice(dropped);
    session.outputStart += dropped;
    session.outputTruncated = true;
  }
  session.updatedAt = Date.now();
}

function clearTimers(session: ProcessSession): void {
  clearTimeout(session.lifetimeTimer);
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  if (session.killTimer) clearTimeout(session.killTimer);
}

function scheduleCleanup(session: ProcessSession): void {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (sessions.get(session.id) === session && session.status !== "running") {
      clearTimers(session);
      sessions.delete(session.id);
    }
  }, PROCESS_EXITED_RETENTION_MS);
  if (typeof session.cleanupTimer.unref === "function") session.cleanupTimer.unref();
}

function finishSession(
  session: ProcessSession,
  status: ProcessSessionStatus,
  patch: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    error?: string;
  } = {},
): void {
  if (session.status !== "running") return;
  session.status = status;
  session.updatedAt = Date.now();
  if ("exitCode" in patch) session.exitCode = patch.exitCode;
  if ("signal" in patch) session.signal = patch.signal;
  if (patch.error) session.error = patch.error;
  clearTimeout(session.lifetimeTimer);
  if (session.killTimer) clearTimeout(session.killTimer);
  scheduleCleanup(session);
}

function killSession(session: ProcessSession, signal: NodeJS.Signals = "SIGTERM"): void {
  try { killProcessTree(session.child, signal); } catch { /* best effort */ }
  if (session.killTimer) clearTimeout(session.killTimer);
  session.killTimer = setTimeout(() => {
    try { killProcessTree(session.child, "SIGKILL"); } catch { /* best effort */ }
  }, 5_000);
  if (typeof session.killTimer.unref === "function") session.killTimer.unref();
}

function ownedSession(ctx: ToolContext, sessionId: unknown): ProcessSession | ToolResult {
  const id = String(sessionId ?? "").trim();
  if (!id) return { content: "E_BAD_INPUT: `session_id` is required", isError: true };
  const session = sessions.get(id);
  if (!session || session.owner !== processOwner(ctx)) {
    return { content: "E_PROCESS_SESSION_NOT_FOUND: process session not found", isError: true };
  }
  return session;
}

function isToolResult(value: ProcessSession | ToolResult): value is ToolResult {
  return !("child" in value);
}

function readPayload(
  session: ProcessSession,
  cursorValue: unknown,
  maxCharsValue: unknown,
): Record<string, unknown> {
  const requestedCursor = Number(cursorValue);
  const cursor = Number.isFinite(requestedCursor)
    ? Math.max(0, Math.trunc(requestedCursor))
    : session.outputStart;
  const maxCharsNumber = Number(maxCharsValue);
  const maxChars = Number.isFinite(maxCharsNumber) && maxCharsNumber > 0
    ? Math.max(1, Math.min(PROCESS_READ_MAX_CHARS, Math.trunc(maxCharsNumber)))
    : PROCESS_READ_DEFAULT_CHARS;
  const effectiveCursor = Math.max(session.outputStart, Math.min(cursor, session.outputEnd));
  const relativeStart = effectiveCursor - session.outputStart;
  const output = session.output.slice(relativeStart, relativeStart + maxChars);
  const nextCursor = effectiveCursor + output.length;
  return {
    session_id: session.id,
    command: commandPreview(session.command),
    cwd: session.cwd,
    status: session.status,
    created_at: new Date(session.createdAt).toISOString(),
    updated_at: new Date(session.updatedAt).toISOString(),
    output,
    cursor: effectiveCursor,
    next_cursor: nextCursor,
    output_start: session.outputStart,
    output_end: session.outputEnd,
    truncated_before_cursor: cursor < session.outputStart,
    has_more: nextCursor < session.outputEnd,
    ...(session.status !== "running" ? { exit_code: session.exitCode ?? null } : {}),
    ...(session.signal ? { signal: session.signal } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function resultJson(
  value: unknown,
  isError = false,
  execution?: CommandExecutionObservation,
): ToolResult {
  return {
    content: JSON.stringify(value, null, 2),
    ...(isError ? { isError: true } : {}),
    ...(execution ? { observations: { execution } } : {}),
  };
}

function takeTerminalExecutionObservation(
  session: ProcessSession,
): CommandExecutionObservation | undefined {
  if (session.status === "running" || session.executionObservationReported) return undefined;
  session.executionObservationReported = true;
  const timedOut = session.status === "stopped" && session.signal === "timeout";
  const aborted = session.status === "stopped" && !timedOut;
  const status: CommandExecutionObservation["status"] = timedOut
    ? "timed_out"
    : aborted
      ? "aborted"
      : session.status === "error" && session.exitCode === undefined && !!session.error
        ? "start_failed"
      : session.status === "exited" && session.exitCode === 0
        ? "succeeded"
        : "failed";
  return {
    status,
    exitCode: session.exitCode ?? null,
    durationMs: Math.max(0, session.updatedAt - session.createdAt),
    timedOut,
    outputLimitExceeded: false,
    stdout: {
      bytes: session.stdoutBytes,
      truncated: session.outputTruncated && session.stdoutBytes > 0,
    },
    stderr: {
      bytes: session.stderrBytes,
      truncated: session.outputTruncated && session.stderrBytes > 0,
    },
  };
}

function terminalResultJson(
  session: ProcessSession,
  cursor: unknown,
  maxChars: unknown,
): ToolResult {
  const failed = session.status === "error" || session.signal === "timeout";
  return resultJson(
    readPayload(session, cursor, maxChars),
    failed,
    takeTerminalExecutionObservation(session),
  );
}

function startProcessSession(command: string, ctx: ToolContext, maxLifetimeMs: unknown): ProcessSession | ToolResult {
  const owner = processOwner(ctx);
  const runningForOwner = [...sessions.values()]
    .filter((session) => session.owner === owner && session.status === "running")
    .length;
  if (runningForOwner >= PROCESS_MAX_RUNNING_PER_OWNER) {
    return {
      content:
        `E_PROCESS_SESSION_LIMIT: at most ${PROCESS_MAX_RUNNING_PER_OWNER} running process sessions are allowed`,
      isError: true,
    };
  }

  const cwd = path.resolve(ctx.workingDir ?? ".");
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (error) {
    return {
      content: `E_PROCESS_START: cannot create working directory: ${(error as Error).message}`,
      isError: true,
      observations: {
        execution: {
          status: "start_failed",
          exitCode: null,
          durationMs: 0,
          timedOut: false,
          outputLimitExceeded: false,
          stdout: { bytes: 0, truncated: false },
          stderr: { bytes: Buffer.byteLength((error as Error).message), truncated: false },
        },
      },
    };
  }
  const env = buildSandboxEnv((ctx.state?.sandboxEnv ?? {}) as Record<string, string>);
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
  const allowedDirs = Array.isArray(ctx.state?.sandboxAllowedDirs)
    ? ctx.state.sandboxAllowedDirs.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    : undefined;
  const invocation = buildSandboxedShellInvocation(shell, command, allowedDirs);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    return {
      content: `E_PROCESS_START: ${(error as Error).message}`,
      isError: true,
      observations: {
        execution: {
          status: "start_failed",
          exitCode: null,
          durationMs: 0,
          timedOut: false,
          outputLimitExceeded: false,
          stdout: { bytes: 0, truncated: false },
          stderr: { bytes: Buffer.byteLength((error as Error).message), truncated: false },
        },
      },
    };
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const lifetime = boundedLifetime(maxLifetimeMs);
  const session: ProcessSession = {
    id,
    owner,
    command,
    cwd,
    child,
    closed: false,
    env,
    status: "running",
    createdAt: now,
    updatedAt: now,
    output: "",
    outputStart: 0,
    outputEnd: 0,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    executionObservationReported: false,
    lifetimeTimer: setTimeout(() => {}, lifetime),
  };
  clearTimeout(session.lifetimeTimer);
  session.lifetimeTimer = setTimeout(() => {
    appendOutput(session, `\n[core-agent] Process session timed out after ${lifetime}ms.\n`);
    killSession(session);
    finishSession(session, "stopped", { signal: "timeout" });
  }, lifetime);
  if (typeof session.lifetimeTimer.unref === "function") session.lifetimeTimer.unref();
  sessions.set(id, session);

  child.stdout.on("data", (data: Buffer) => appendOutput(session, data, "stdout"));
  child.stderr.on("data", (data: Buffer) => appendOutput(session, data, "stderr"));
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => {
    appendOutput(session, `\n[core-agent] Process error: ${error.message}\n`);
    finishSession(session, "error", { error: error.message });
  });
  child.on("close", (code, signal) => {
    session.closed = true;
    finishSession(session, code === 0 ? "exited" : "error", {
      exitCode: code,
      signal: signal ?? null,
    });
  });
  return session;
}

async function waitForInitialProcessActivity(session: ProcessSession): Promise<void> {
  // PowerShell startup can exceed 300ms when a Windows test or build host is
  // busy. Keep the start response deterministic for quick commands while
  // preserving the shorter POSIX path for silent long-running processes.
  const deadline = Date.now() + PROCESS_INITIAL_ACTIVITY_WAIT_MS;
  while (session.status === "running" && session.outputEnd === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForProcessClose(session: ProcessSession, maxWaitMs = 500): Promise<void> {
  if (session.closed) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.child.off("close", finish);
      session.updatedAt = Date.now();
      resolve();
    };
    const timer = setTimeout(finish, maxWaitMs);
    session.child.once("close", finish);
  });
}

export const processStartTool: AgentTool = defineTool({
  name: "process_start",
  description:
    "Start a persistent shell process for long builds, test runs, watchers, development servers, or commands that need later stdin. It returns a session_id that remains usable across later Agent runs in the same host scope. Use bash for commands expected to finish in one call; use an interactive-CLI tool when the user must enter secrets or complete OAuth.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to start in the working directory." },
      max_lifetime_ms: {
        type: "number",
        description: "Optional lifetime. Default 6 hours; minimum 1 minute; maximum 24 hours.",
      },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = String(input.command ?? "").trim();
    if (!command) return { content: "E_BAD_INPUT: `command` is required", isError: true };
    const session = startProcessSession(command, ctx, input.max_lifetime_ms);
    if (isToolResult(session)) return session;
    await waitForInitialProcessActivity(session);
    // A short command can emit its final stderr/stdout immediately before the
    // wrapping shell closes. Give that close event a brief chance to arrive so
    // callers receive the terminal exit code rather than a stale `running`.
    if (session.status === "running" && session.outputEnd > 0) {
      await waitForProcessClose(session, 300);
    }
    return session.status === "running"
      ? resultJson(readPayload(session, session.outputStart, PROCESS_READ_DEFAULT_CHARS))
      : terminalResultJson(session, session.outputStart, PROCESS_READ_DEFAULT_CHARS);
  },
});

export const processReadTool: AgentTool = defineTool({
  name: "process_read",
  description:
    "Read new output and current status from a process_start session without blocking. Pass the previous next_cursor to receive only later output. If status is running and output is empty, continue other useful work or read again only after meaningful progress is expected.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session id returned by process_start." },
      cursor: { type: "number", description: "Previous next_cursor. Omit to read from retained output start." },
      max_chars: { type: "number", description: "Maximum output characters, default 32000 and max 64000." },
    },
    required: ["session_id"],
  },
  executionMode: "parallel",
  async execute(input, ctx) {
    const session = ownedSession(ctx, input.session_id);
    if (isToolResult(session)) return session;
    return session.status === "running"
      ? resultJson(readPayload(session, input.cursor, input.max_chars))
      : terminalResultJson(session, input.cursor, input.max_chars);
  },
});

export const processWriteTool: AgentTool = defineTool({
  name: "process_write",
  description:
    "Write known, non-secret characters to a running process_start session. Use for test runners, REPL commands, server controls, or confirmations whose answer is already known. Do not send passwords, tokens, API keys, or OAuth codes through this tool.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session id returned by process_start." },
      chars: { type: "string", description: "Characters to write to stdin." },
      add_newline: { type: "boolean", description: "Append a newline. Default false." },
    },
    required: ["session_id", "chars"],
  },
  async execute(input, ctx) {
    const session = ownedSession(ctx, input.session_id);
    if (isToolResult(session)) return session;
    if (session.status !== "running") {
      return {
        content: `E_PROCESS_NOT_RUNNING: process session is ${session.status}`,
        isError: true,
      };
    }
    const chars = String(input.chars ?? "");
    if (chars.length > PROCESS_INPUT_MAX_CHARS) {
      return {
        content: `E_BAD_INPUT: chars exceeds ${PROCESS_INPUT_MAX_CHARS} characters`,
        isError: true,
      };
    }
    try {
      session.child.stdin.write(input.add_newline === true ? `${chars}\n` : chars, "utf8");
      session.updatedAt = Date.now();
      return resultJson({ session_id: session.id, status: session.status, written_chars: chars.length });
    } catch (error) {
      return { content: `E_PROCESS_WRITE: ${(error as Error).message}`, isError: true };
    }
  },
});

export const processStopTool: AgentTool = defineTool({
  name: "process_stop",
  description:
    "Stop a process_start session and its process tree. Use when the work is complete, a watcher/server is no longer needed, or a command is stuck.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session id returned by process_start." },
    },
    required: ["session_id"],
  },
  async execute(input, ctx) {
    const session = ownedSession(ctx, input.session_id);
    if (isToolResult(session)) return session;
    if (session.status === "running") {
      killSession(session);
      finishSession(session, "stopped", { signal: "agent" });
      await waitForProcessClose(session);
    }
    return terminalResultJson(session, session.outputEnd, PROCESS_READ_DEFAULT_CHARS);
  },
});

export function getProcessSessionTools(): AgentTool[] {
  return [processStartTool, processReadTool, processWriteTool, processStopTool];
}

/** Test-only cleanup; production sessions are retained by their lifecycle. */
export async function _resetProcessSessionsForTest(): Promise<void> {
  const active = [...sessions.values()];
  for (const session of active) {
    if (session.status === "running") {
      try { killProcessTree(session.child, "SIGKILL"); } catch { /* best effort */ }
    }
  }
  await Promise.all(active.map((session) => waitForProcessClose(session, 2_000)));
  for (const session of active) {
    clearTimers(session);
  }
  sessions.clear();
}
