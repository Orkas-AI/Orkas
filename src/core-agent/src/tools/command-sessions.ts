import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { decodeProcessOutput, type SandboxExecutor, type SandboxResult } from "../sandbox/executor.js";
import { discardStreamedToolOutput } from "../sandbox/output-capture.js";
import type { ToolContext, ToolResult, ToolReadContinuation } from "./base.js";
import { isProgrammaticToolCallContext } from "./run-program.js";

const OUTPUT_CHARS = 1_000_000;
const RETENTION_MS = 60 * 60_000;
const sessions = new Map<string, CommandSession>();

type CommandSession = {
  id: string;
  owner: string;
  chunks: string[];
  start: number;
  end: number;
  waiters: Set<() => void>;
  control?: { write(chars: string): void; stop(): void };
  result?: ToolResult;
  completion: Promise<void>;
  delivered: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function managedCommandsEnabled(ctx: ToolContext): boolean {
  return ctx.state.commandSessionEnabled === true && !isProgrammaticToolCallContext(ctx);
}

export function commandSessionWait(value: unknown): number | null {
  if (value === undefined) return 10_000;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30_000
    ? value : null;
}

export function runningCommandSessions(owner: string): number {
  let count = 0;
  for (const session of sessions.values()) if (session.owner === owner && !session.result) count++;
  return count;
}

function owner(ctx: ToolContext): string {
  return typeof ctx.state.processSessionOwner === "string" ? ctx.state.processSessionOwner : "";
}

function release(session: CommandSession): void {
  clearTimeout(session.timer);
  if (!session.delivered) discardStreamedToolOutput(session.result?.streamedOutput);
  sessions.delete(session.id);
}

function notify(session: CommandSession): void {
  for (const wake of [...session.waiters]) wake();
}

function append(session: CommandSession, text: string): void {
  if (!text) return;
  session.chunks.push(text);
  session.end += text.length;
  let excess = Math.max(0, session.end - session.start - OUTPUT_CHARS);
  session.start += excess;
  let discarded = 0;
  while (excess > 0) {
    const chunk = session.chunks[discarded];
    if (chunk.length <= excess) { excess -= chunk.length; discarded++; }
    else { session.chunks[discarded] = chunk.slice(excess); excess = 0; }
  }
  if (discarded) session.chunks = session.chunks.slice(discarded);
  // Keep tiny-write metadata bounded without copying the full 1M-character
  // window for every ordinary 64KiB pipe chunk.
  if (session.chunks.length > 2048) session.chunks = [session.chunks.join("")];
  notify(session);
}

function readOutput(session: CommandSession, cursor: number, maxChars: number): string {
  let skip = cursor - session.start;
  let remaining = maxChars;
  const parts: string[] = [];
  for (const chunk of session.chunks) {
    if (skip >= chunk.length) { skip -= chunk.length; continue; }
    const part = chunk.slice(skip, skip + remaining);
    parts.push(part);
    remaining -= part.length;
    skip = 0;
    if (!remaining) break;
  }
  return parts.join("");
}

async function wait(session: CommandSession, ms: number, ready: () => boolean, signal?: AbortSignal): Promise<void> {
  if (!ms || ready() || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      session.waiters.delete(changed);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const changed = () => { if (ready()) finish(); };
    const timer = setTimeout(finish, ms);
    session.waiters.add(changed);
    signal?.addEventListener("abort", finish, { once: true });
    changed();
  });
}

function readRange(session: CommandSession, input: Record<string, unknown>) {
  const requested = typeof input.cursor === "number" && Number.isFinite(input.cursor)
    ? Math.max(0, Math.trunc(input.cursor)) : session.start;
  const cursor = Math.max(session.start, Math.min(session.end, requested));
  const maxChars = typeof input.max_chars === "number" && input.max_chars > 0
    ? Math.max(1, Math.min(64_000, Math.trunc(input.max_chars))) : 32_000;
  return { requested, cursor, maxChars };
}

/** Pure inspection of the same bounded range the next receipt will deliver. */
export function inspectCommandRead(input: Record<string, unknown>, ctx: ToolContext): ToolReadContinuation | undefined {
  const session = sessions.get(String(input.session_id ?? ""));
  if (!session || session.owner !== owner(ctx)) return undefined;
  const { cursor, maxChars } = readRange(session, input);
  const end = Math.min(session.end, cursor + maxChars);
  return {
    version: JSON.stringify([session.id, cursor, end, !!session.result]),
    waiting: !ctx.signal?.aborted && !session.result && cursor === session.end && (commandSessionWait(input.yield_time_ms) ?? 0) > 0,
  };
}

function receipt(session: CommandSession, input: Record<string, unknown>): ToolResult {
  const { requested, cursor, maxChars } = readRange(session, input);
  const output = readOutput(session, cursor, maxChars);
  const result = session.result;
  const execution = result?.observations?.execution;
  const status = !result ? "running" : execution?.status === "succeeded" ? "exited"
    : execution?.status === "aborted" || execution?.status === "timed_out" ? "stopped" : "error";
  const firstDelivery = !!result && !session.delivered;
  if (result) session.delivered = true;
  return {
    content: JSON.stringify({
      session_id: session.id, status, output, cursor, next_cursor: cursor + output.length,
      output_start: session.start, output_end: session.end,
      truncated_before_cursor: requested < session.start, has_more: cursor + output.length < session.end,
      ...(result && !execution ? { error: result.content } : {}),
      ...(execution ? { exit_code: execution.exitCode, execution_status: execution.status,
        stdout_bytes: execution.stdout.bytes, stderr_bytes: execution.stderr.bytes } : {}),
    }),
    ...(result?.isError ? { isError: true } : {}),
    ...(firstDelivery && result?.observations ? { observations: result.observations } : {}),
    ...(firstDelivery && result?.streamedOutput ? { streamedOutput: result.streamedOutput } : {}),
  };
}

/** One sandbox execution, retained after the first bounded wait. The host's
 * terminal callback runs even when the command exits between tool calls. */
export async function startCommandSession(
  sandbox: SandboxExecutor,
  command: string,
  ctx: ToolContext,
  waitMs: number,
  format: (result: SandboxResult) => Promise<ToolResult>,
): Promise<ToolResult> {
  const session: CommandSession = {
    id: randomUUID(), owner: owner(ctx), chunks: [], start: 0, end: 0,
    waiters: new Set(), completion: Promise.resolve(), delivered: false,
  };
  sessions.set(session.id, session);
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const terminal = ctx.state.commandSessionTerminal as ((result: ToolResult) => Promise<ToolResult>) | undefined;
  session.completion = sandbox.execute(command, {
    onStart: (control) => { session.control = control; },
    onOutput: (bytes, stream, env) => append(session, process.platform === "win32"
      ? decodeProcessOutput(bytes, process.platform, env) : decoders[stream].write(bytes)),
  }).then(async (raw) => {
    append(session, decoders.stdout.end() + decoders.stderr.end());
    let result = await format(raw);
    if (terminal) result = await terminal(result);
    session.result = result;
  }).catch(() => {
    session.control?.stop();
    session.result = { content: "E_PROCESS_RESULT: command result processing failed; do not replay the command.", isError: true };
  }).finally(() => {
    notify(session);
    session.timer = setTimeout(() => release(session), RETENTION_MS);
    session.timer.unref();
    // Bound retained terminal records as well as each output buffer.
    const finished = [...sessions.values()].filter((entry) => entry.result);
    for (const old of finished.slice(0, Math.max(0, finished.length - 32))) release(old);
  });
  await wait(session, waitMs, () => !!session.result, ctx.signal);
  if (session.result) {
    session.delivered = true;
    release(session);
    return session.result;
  }
  return receipt(session, { cursor: 0 });
}

/** Undefined means the id belongs to the legacy session implementation. */
export async function continueCommandSession(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | undefined> {
  const session = sessions.get(String(input.session_id ?? ""));
  if (!session) return undefined;
  if (session.owner !== owner(ctx)) return { content: "E_PROCESS_SESSION_NOT_FOUND: process session not found", isError: true };
  const action = input.action;
  if (action === "read") {
    const ms = commandSessionWait(input.yield_time_ms);
    if (ms === null) return { content: "E_BAD_INPUT: yield_time_ms must be an integer from 0 to 30000", isError: true };
    const cursor = typeof input.cursor === "number" && Number.isFinite(input.cursor)
      ? Math.max(session.start, Math.min(session.end, input.cursor)) : session.start;
    await wait(session, ms, () => !!session.result || session.end > cursor, ctx.signal);
  } else if (action === "write") {
    if (session.result || !session.control) return { content: "E_PROCESS_NOT_RUNNING: process session is not running", isError: true };
    if (typeof input.chars !== "string" || input.chars.length > 64_000) {
      return { content: "E_BAD_INPUT: chars must be a string of at most 64000 characters", isError: true };
    }
    try { session.control.write(input.chars + (input.add_newline === true ? "\n" : "")); }
    catch { return { content: "E_PROCESS_WRITE: process stdin is closed", isError: true }; }
    return { content: JSON.stringify({ session_id: session.id, status: "running", written_chars: input.chars.length }) };
  } else if (action === "stop") {
    if (!session.result) { session.control?.stop(); await session.completion; }
  }
  return receipt(session, input);
}

export async function resetCommandSessionsForTest(): Promise<void> {
  const all = [...sessions.values()];
  for (const session of all) session.control?.stop();
  await Promise.all(all.map((session) => session.completion));
  for (const session of all) release(session);
}
