import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { get as httpGet } from "node:http";
import { SandboxExecutor } from "../src/sandbox/executor.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetProcessSessionsForTest,
  getProcessSessionTools,
  processReadTool,
} from "../src/tools/process-session.js";
import { bashTool } from "../src/tools/builtin.js";
import { commandSessionWait } from "../src/tools/command-sessions.js";
import { markProgrammaticToolCallState } from "../src/tools/run-program.js";
import type { ToolContext } from "../src/tools/base.js";

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
let workingDir = "";

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function shellInvoke(executable: string, args: string[]): string {
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(" ");
  return process.platform === "win32" ? `& ${command}` : command;
}

function context(owner: string): ToolContext {
  return { workingDir, state: { processSessionOwner: owner } };
}

function tool(name: string) {
  const found = getProcessSessionTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function json(content: string): Record<string, any> {
  return JSON.parse(content) as Record<string, any>;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessRead(
  owner: string,
  sessionId: string,
  cursor: number,
  predicate: (payload: Record<string, any>) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = performance.now() + timeoutMs;
  let lastPayload: Record<string, any> | null = null;
  while (performance.now() < deadline) {
    const result = await tool("process_session").execute({
      action: "read",
      session_id: sessionId,
      cursor,
    }, context(owner));
    const payload = json(result.content);
    lastPayload = payload;
    if (predicate(payload)) return { result, payload };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process session did not reach the expected state: ${JSON.stringify(lastPayload)}`);
}

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-process-session-"));
});

afterEach(async () => {
  await _resetProcessSessionsForTest();
  await fs.rm(workingDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
});

describe("persistent process sessions", () => {
  it.each(["legacy", "managed"])("keeps a local server alive through startup, readiness checks and explicit shutdown: %s", async mode => {
    const reservation = createTcpServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const fixture = path.join(workingDir, "startup-server.cjs");
    await fs.writeFile(fixture, `console.log('BOOTING');
process.stdin.once('data', () => {
  require('node:http').createServer((_req,res) => res.end('local-service-ready'))
    .listen(${port}, '127.0.0.1', () => console.log('LISTENING'));
});
process.stdin.resume();`);
    const owner = `local-server-${mode}`;
    const ctx = { ...context(owner), state: { processSessionOwner: owner, commandSessionEnabled: mode === "managed" } };
    const command = shellInvoke(TEST_NODE, [fixture]);
    const started = mode === "managed"
      ? await bashTool.execute({ command, yield_time_ms: 0 }, ctx)
      : await tool("process_session").execute({ action: "start", command }, ctx);
    const sessionId = json(started.content).session_id;
    const read = await waitForProcessRead(owner, sessionId, 0, value => value.output.includes("BOOTING"));
    expect(read.payload.status).toBe("running");
    const request = () => new Promise<Record<string, unknown>>(resolve => {
      const req = httpGet({ hostname: "127.0.0.1", port, path: "/", timeout: 1000 }, res => {
        let body = "";
        res.setEncoding("utf8"); res.on("data", data => { body += data; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      req.on("error", error => resolve({ error: (error as NodeJS.ErrnoException).code }));
    });
    expect(await request()).toEqual({ error: "ECONNREFUSED" });
    await tool("process_session").execute({ action: "write", session_id: sessionId, chars: "listen\n" }, ctx);
    await waitForProcessRead(owner, sessionId, 0, value => value.output.includes("LISTENING"));
    expect(await request()).toEqual({ status: 200, body: "local-service-ready" });
    const stops = await Promise.all([0, 1].map(() =>
      tool("process_session").execute({ action: "stop", session_id: sessionId }, ctx)));
    expect(stops.every(result => !result.isError)).toBe(true);
    expect(await request()).toEqual({ error: "ECONNREFUSED" });
  });

  it.each(["legacy", "foreground", "managed", "detached"])("honors the configured Windows shell at actual startup: %s", async mode => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    vi.stubEnv("ORKAS_WINDOWS_SHELL", "cmd.exe");
    vi.stubEnv("SHELL", "fixture-unrelated-shell");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), unref: vi.fn(),
    });
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce((() => {
      setImmediate(() => {
        child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
      });
      return child;
    }) as typeof spawn);
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const ctx = { ...context("configured-shell"), state: { processSessionOwner: "configured-shell", commandSessionEnabled: mode === "managed" } };
      const command = "echo fixture && (echo native)";
      if (mode === "detached") {
        const result = new SandboxExecutor({ workingDir }).executeBackground(command, path.join(workingDir, "detached.log"));
        expect(result.error).toBeUndefined();
      }
      const result = mode === "detached" ? { content: "" } : mode === "legacy"
        ? await tool("process_session").execute({ action: "start", command }, ctx)
        : await bashTool.execute({ command, ...(mode === "managed" ? { yield_time_ms: 1000 } : {}) }, ctx);
      expect(result.isError).toBeFalsy();
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(["cmd.exe", ["/d", "/s", "/c", command]]);
      // The child is stubbed: this certifies startup selection, not native Windows semantics.
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      vi.unstubAllEnvs();
      spawnMock.mockReset();
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      spawnMock.mockImplementation(actual.spawn);
    }
  });

  it("uses the ten-second default for out-of-range waits while preserving polling and valid boundaries", () => {
    for (const value of [undefined, -1, 30001, 60000]) expect(commandSessionWait(value)).toBe(10000);
    for (const value of [0, 1, 10000, 30000]) expect(commandSessionWait(value)).toBe(value);
  });

  it.each(["legacy", "managed"])("advances a read cursor for a positive fractional page size: %s", async (mode) => {
    const ctx = { ...context("reader"), state: { processSessionOwner: "reader", commandSessionEnabled: true } };
    const command = shellInvoke(TEST_NODE, ["-e", "process.stdout.write('hello');process.stdin.resume()"]);
    const started = mode === "managed"
      ? await bashTool.execute({ command, yield_time_ms: 0 }, ctx)
      : await tool("process_session").execute({ action: "start", command }, ctx);
    const session_id = json(started.content).session_id;
    await waitForProcessRead("reader", session_id, 0, (value) => value.output_end >= 5);
    const result = json((await tool("process_session").execute({
      action: "read", session_id, cursor: 0, max_chars: 0.5, yield_time_ms: 0,
    }, ctx)).content);
    expect(result.output).toBe("h");
    expect(result.next_cursor).toBe(1);
    expect(result.has_more).toBe(true);
  });

  it.each(["legacy", "managed"])("inspects only authorized read progress without consuming results: %s", async (mode) => {
    const ctx = { ...context("reader"), state: { processSessionOwner: "reader", commandSessionEnabled: true } };
    const sessionTool = tool("process_session");
    const command = shellInvoke(TEST_NODE, ["-e", "process.stdout.write('hello');process.stdin.on('data',d=>{if(d.toString().includes('exit'))process.exit(0);else process.stdout.write('world')})"]);
    const started = mode === "managed"
      ? await bashTool.execute({ command, yield_time_ms: 0 }, ctx)
      : await sessionTool.execute({ action: "start", command }, ctx);
    const session_id = json(started.content).session_id;
    await waitForProcessRead("reader", session_id, 0, (value) => value.output_end >= 5);
    const fixed = { action: "read", session_id, cursor: 0, max_chars: 5 };
    const inspect = (input = fixed, readCtx = ctx) => sessionTool.inspectReadContinuation!(input, readCtx);
    const original = inspect()!;
    expect(original.waiting).toBe(false);
    expect(inspect({ ...fixed, cursor: 5 })?.waiting).toBe(true);
    expect(sessionTool.inspectReadContinuation!({ ...fixed, cursor: 5, yield_time_ms: 0 }, ctx)?.waiting).toBe(false);
    for (const yield_time_ms of [-1, 60000]) {
      expect(sessionTool.inspectReadContinuation!({ ...fixed, cursor: 5, yield_time_ms }, ctx)?.waiting).toBe(true);
    }
    const legacyRead = processReadTool.inspectReadContinuation!({ session_id, cursor: 5 }, ctx);
    if (mode === "legacy") expect(legacyRead?.waiting).toBe(false);
    else expect(legacyRead).toBeUndefined();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(sessionTool.inspectReadContinuation!({ ...fixed, cursor: 5 }, { ...ctx, signal: cancelled.signal })?.waiting).toBe(false);
    expect(inspect(fixed, { ...ctx, state: { ...ctx.state, processSessionOwner: "foreign" } })).toBeUndefined();
    for (const input of [
      { ...fixed, action: "stop" },
      { ...fixed, cursor: "5" }, { ...fixed, yield_time_ms: 1.5 }, { ...fixed, max_chars: 0.5 },
    ]) expect(sessionTool.inspectReadContinuation!(input, ctx)).toBeUndefined();

    expect(sessionTool.inspectReadContinuation!({ ...fixed, command: "extra" }, ctx)).toEqual(sessionTool.inspectReadContinuation!(fixed, ctx));
    const unusedMarker = path.join(workingDir, "unused-start-command");
    const ignoredStart = shellInvoke(TEST_NODE, ["-e", `require('fs').writeFileSync(${JSON.stringify(unusedMarker)}, 'wrong')`]);
    const actualRead = await sessionTool.execute({ ...fixed, command: ignoredStart, chars: { unused: true }, yield_time_ms: 60000 }, ctx);
    expect(actualRead.isError).toBeFalsy();
    expect(json(actualRead.content).output).toBe("hello");
    await expect(fs.stat(unusedMarker)).rejects.toMatchObject({ code: "ENOENT" });
    const growing = { ...fixed, max_chars: 10 };
    const beforeAppend = inspect(growing)!;
    await sessionTool.execute({ action: "write", session_id, chars: "more", add_newline: true }, ctx);
    await waitForProcessRead("reader", session_id, 5, (value) => value.output_end >= 10);
    expect(inspect()).toEqual(original);
    expect(inspect(growing)?.version).not.toBe(beforeAppend.version);
    expect(inspect({ ...fixed, cursor: 5 })?.waiting).toBe(false);

    await sessionTool.execute({ action: "write", session_id, chars: "exit", add_newline: true }, ctx);
    // Inspection observes exit without delivering (and consuming) its receipt.
    await expect.poll(() => inspect()?.version).not.toBe(original.version);
    const terminalVersion = inspect()!;
    expect(terminalVersion.waiting).toBe(false);
    const terminal = await sessionTool.execute(fixed, ctx);
    expect(json(terminal.content).status).toBe("exited");
    expect(json(terminal.content).output).toBe("hello");
    if (mode === "managed") expect(terminal.observations?.execution?.status).toBe("succeeded");
    expect(inspect()).toEqual(terminalVersion);
    expect((await sessionTool.execute(fixed, ctx)).observations).toBeUndefined();
  });

  it("exposes one lifecycle tool and rejects an unknown action", async () => {
    expect(getProcessSessionTools().map((candidate) => candidate.name)).toEqual(["process_session"]);
    expect(getProcessSessionTools()[0].inputSchema.required).toContain("action");
    const marker = path.join(workingDir, "must-not-run.txt");
    const command = shellInvoke(TEST_NODE, [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    ]);
    const result = await tool("process_session").execute({ action: "unknown", command }, context("owner-a"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("E_BAD_INPUT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a portable schema and ignores startup fields on reads", async () => {
    const processSession = tool("process_session");
    const schema = processSession.inputSchema as any;

    expect(schema.oneOf).toBeUndefined();
    expect(schema.required).toEqual(["action", "session_id"]);
    const rejected = await processSession.execute({
      action: "read",
      session_id: "proc-missing",
      command: "must-not-run",
    }, context("owner-a"));
    expect(rejected).toMatchObject({ isError: true });
    expect(rejected.content).not.toContain("does not accept");
    expect(rejected.content).toMatch(/not found|unknown|not exist/i);
    expect(rejected.content).toContain('ignored_fields: ["command"]');
    expect(rejected.content).not.toContain('must-not-run');
  });

  it("streams cursor-based output across separate Agent tool contexts", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "process.stdout.write('first\\n');process.stdin.once('data',()=>{process.stdout.write('second\\n');process.exit(0)})",
    ]);
    const started = await tool("process_session").execute({ action: "start", command }, context("conversation-a"));
    expect(started.isError).toBeUndefined();
    let firstResult = { result: started, payload: json(started.content) };
    if (!String(firstResult.payload.output).includes("first")) {
      firstResult = await waitForProcessRead(
        "conversation-a",
        firstResult.payload.session_id,
        firstResult.payload.next_cursor,
        (payload) => String(payload.output).includes("first"),
      );
    }
    const first = firstResult.payload;
    expect(first.output).toContain("first");

    const written = await tool("process_session").execute({
      action: "write",
      session_id: first.session_id,
      chars: "continue",
      add_newline: true,
    }, context("conversation-a"));
    expect(written.isError).toBeUndefined();

    const later = await waitForProcessRead(
      "conversation-a",
      first.session_id,
      first.next_cursor,
      (payload) => String(payload.output).includes("second") && payload.status === "exited",
    );
    const second = later.payload;
    expect(second.output).toContain("second");
    expect(second.output).not.toContain("first");
    expect(second.status).toBe("exited");
    expect(later.result.observations?.execution).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
    });
    expect(later.result.observations?.execution?.stdout.bytes).toBeGreaterThan(0);

    const emptyResult = await tool("process_session").execute({
      action: "read",
      session_id: first.session_id,
      cursor: second.next_cursor,
    }, context("conversation-a"));
    const empty = json(emptyResult.content);
    expect(empty.output).toBe("");
    expect(empty.has_more).toBe(false);
    expect(emptyResult.observations?.execution).toBeUndefined();
  });

  it("keeps the legacy direct read export nonblocking", async () => {
    const started = json((await tool("process_session").execute({ action: "start", command: shellInvoke(TEST_NODE, ["-e", "setInterval(()=>{},1000)"]) }, context("owner-a"))).content);
    const result = await processReadTool.execute({ session_id: started.session_id }, context("owner-a"));
    expect(json(result.content).status).toBe("running");
  });

  it("isolates session ids by host owner", async () => {
    const command = shellInvoke(TEST_NODE, ["-e", "setTimeout(()=>process.exit(0),5000)"]);
    const started = json((await tool("process_session").execute({ action: "start", command }, context("owner-a"))).content);
    const denied = await tool("process_session").execute({
      action: "read",
      session_id: started.session_id,
    }, context("owner-b"));
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("E_PROCESS_SESSION_NOT_FOUND");

    const deniedStop = await tool("process_session").execute({
      action: "stop",
      session_id: started.session_id,
    }, context("owner-b"));
    expect(deniedStop.isError).toBe(true);
    expect(deniedStop.content).toContain("E_PROCESS_SESSION_NOT_FOUND");

    const ownerView = json((await tool("process_session").execute({
      action: "read",
      session_id: started.session_id,
      yield_time_ms: 0,
    }, context("owner-a"))).content);
    expect(ownerView.status).toBe("running");
    await tool("process_session").execute({
      action: "stop",
      session_id: started.session_id,
    }, context("owner-a"));
  });

  it("writes stdin and can stop a running process tree", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "console.log(process.pid);process.stdin.once('data',d=>process.stdout.write('echo:'+d.toString()));setInterval(()=>{},1000)",
    ]);
    const started = json((await tool("process_session").execute({ action: "start", command }, context("owner-a"))).content);
    const written = await tool("process_session").execute({
      action: "write",
      session_id: started.session_id,
      chars: "hello",
      add_newline: true,
    }, context("owner-a"));
    expect(written.isError).toBeUndefined();
    await expect.poll(async () => {
      const output = json((await tool("process_session").execute({
        action: "read",
        session_id: started.session_id,
        cursor: 0,
      }, context("owner-a"))).content);
      return output.output;
    }, {
      timeout: 2_000,
      interval: 25,
    }).toContain("echo:hello");

    const output = json((await processReadTool.execute({ session_id: started.session_id }, context("owner-a"))).content).output;
    const pid = Number(output.split("\n")[0]);
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    expect(processIsAlive(pid)).toBe(true);

    const stoppedResult = await tool("process_session").execute({
      action: "stop",
      session_id: started.session_id,
    }, context("owner-a"));
    const stopped = json(stoppedResult.content);
    expect(stopped.status).toBe("stopped");
    expect(stoppedResult.isError).toBeFalsy();
    expect(stoppedResult.observations?.execution).toMatchObject({
      status: "aborted",
      exitCode: null,
      timedOut: false,
    });

    const repeatedResult = await tool("process_session").execute({
      action: "stop",
      session_id: started.session_id,
    }, context("owner-a"));
    expect(repeatedResult.isError).toBeFalsy();
    const repeatedStop = json(repeatedResult.content);
    expect(repeatedStop.status).toBe("stopped");
    await expect.poll(() => processIsAlive(pid), { timeout: 2000 }).toBe(false);
  });

  it.runIf(process.platform !== "win32").each([
    { trigger: "stop", descendant: false },
    { trigger: "timeout", descendant: false },
    { trigger: "stop", descendant: true },
  ])("kills a TERM-resistant producer after $trigger (exiting parent: $descendant)", async ({ trigger, descendant }) => {
    const sessionTool = tool("process_session");
    const ctx = context("stop-owner");
    const pids: number[] = [];
    const ticks = path.join(workingDir, "resistant-ticks");
    // A bounded real producer supplies both an OS liveness oracle and an
    // independent side-effect oracle; cleanup also runs against unfixed code.
    const producer = "process.on('SIGTERM',()=>{});"
      + "require('fs').writeFileSync('producer-pid',String(process.pid));"
      + "setInterval(()=>require('fs').appendFileSync('resistant-ticks','x'),25);"
      + "setTimeout(()=>process.exit(0),20000)";
    const script = descendant
      ? `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(producer)}],{stdio:'ignore'});`
        + "console.log(process.pid);setInterval(()=>{},1000)"
      : producer + ";console.log(process.pid)";
    let expire: (() => void) | undefined;
    const setTimer = globalThis.setTimeout;
    const timerSpy = trigger === "timeout" ? vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      // Fire the real lifetime callback after readiness, without spending a
      // minute testing the already-established minimum lifetime constant.
      if (args[1] === 60_000) expire = () => args[0](...args.slice(2));
      return setTimer(...args);
    }) as typeof setTimeout) : undefined;
    try {
      const started = json((await sessionTool.execute({
        action: "start", command: shellInvoke(TEST_NODE, ["-e", script]), max_lifetime_ms: 60_000,
      }, ctx)).content);
      timerSpy?.mockRestore();
      const ready = await waitForProcessRead("stop-owner", started.session_id, 0, payload => !!payload.output.trim());
      const parentPid = Number(ready.payload.output.trim());
      expect(Number.isInteger(parentPid) && parentPid > 1).toBe(true);
      pids.push(parentPid);
      await expect.poll(() => fs.readFile(path.join(workingDir, "producer-pid"), "utf8")).toMatch(/^\d+$/);
      const producerPid = Number(await fs.readFile(path.join(workingDir, "producer-pid"), "utf8"));
      if (producerPid !== parentPid) pids.push(producerPid);
      await expect.poll(() => fs.readFile(ticks, "utf8")).not.toBe("");
      expect(processIsAlive(producerPid)).toBe(true);

      const sibling = json((await sessionTool.execute({
        action: "start", command: shellInvoke(TEST_NODE, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"]),
      }, context("other-owner"))).content);
      const siblingReady = await waitForProcessRead("other-owner", sibling.session_id, 0, payload => !!payload.output.trim());
      const siblingPid = Number(siblingReady.payload.output.trim());
      pids.push(siblingPid);
      expect(processIsAlive(siblingPid)).toBe(true);
      if (trigger === "timeout") { expect(expire).toBeDefined(); expire!(); }
      const stopped = await sessionTool.execute({ action: "stop", session_id: started.session_id }, ctx);
      expect(json(stopped.content).status).toBe("stopped");
      expect(stopped.observations?.execution?.status).toBe(trigger === "timeout" ? "timed_out" : "aborted");
      const repeated = await sessionTool.execute({ action: "stop", session_id: started.session_id }, ctx);
      expect(repeated.observations).toBeUndefined();
      if (descendant) {
        // The parent and its pipes close before the resistant descendant;
        // that early terminal event must not cancel group escalation.
        await expect.poll(() => processIsAlive(parentPid), { timeout: 2000 }).toBe(false);
        expect(processIsAlive(producerPid)).toBe(true);
      }
      await expect.poll(() => processIsAlive(producerPid), { timeout: 7000, interval: 50 }).toBe(false);
      const stoppedTicks = await fs.readFile(ticks, "utf8");
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await fs.readFile(ticks, "utf8")).toBe(stoppedTicks);
      expect(processIsAlive(siblingPid)).toBe(true);
      expect(json((await sessionTool.execute({ action: "read", session_id: sibling.session_id, yield_time_ms: 0 }, context("other-owner"))).content).status).toBe("running");
    } finally {
      timerSpy?.mockRestore();
      for (const pid of pids) if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 15000);

  it("reports a non-zero terminal command as failed structured execution", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "process.stderr.write('failed\\n');process.exit(7)",
    ]);
    const result = await tool("process_session").execute(
      { action: "start", command },
      context("owner-a"),
    );
    let terminal = { result, payload: json(result.content) };
    if (terminal.payload.status === "running") {
      terminal = await waitForProcessRead(
        "owner-a",
        terminal.payload.session_id,
        terminal.payload.next_cursor,
        (payload) => payload.status !== "running",
      );
    }
    const payload = terminal.payload;
    expect(payload.status).toBe("error");
    expect(payload.exit_code).toBe(7);
    expect(terminal.result.isError).toBe(true);
    expect(terminal.result.observations?.execution).toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    expect(terminal.result.observations?.execution?.stderr.bytes).toBeGreaterThan(0);
  });
});


describe("bash managed continuation", () => {
  function managed(owner = "command-owner", signal?: AbortSignal): ToolContext {
    return { ...context(owner), signal, state: {
      ...context(owner).state, commandSessionEnabled: true, commandSessionSignal: signal,
      toolResultSpoolDir: path.join(workingDir, "spool"),
    } };
  }
  const node = (script: string) => shellInvoke(TEST_NODE, ["-e", script]);
  const read = (session_id: string, cursor = 0, ctx = managed(), yield_time_ms = 2000) =>
    tool("process_session").execute({ action: "read", session_id, cursor, yield_time_ms }, ctx);

  it("finishes a short command in one call with separated stdout, stderr and exit status", async () => {
    const result = await bashTool.execute({ command: node("console.log('out');console.error('err')") }, managed());
    expect(result.content).toContain('<command-result status="succeeded"');
    expect(result.content).toContain("<stdout>\nout");
    expect(result.content).toContain("<stderr>\nerr");
    expect(result.observations?.execution?.exitCode).toBe(0);
    expect(result.content).not.toContain("session_id");
  });

  it("yields once, accepts stdin and resumes in another context without repeating side effects", async () => {
    const command = node("require('fs').appendFileSync('effects','1');process.stdout.write('ready');process.stdin.once('data',d=>{process.stdout.write('reply:'+d);process.exit(0)})");
    const started = await bashTool.execute({ command, yield_time_ms: 0 }, managed());
    const initial = json(started.content);
    expect(initial.status).toBe("running");
    expect(started.observations?.execution).toBeUndefined();
    const ready = json((await read(initial.session_id, initial.next_cursor)).content);
    expect(initial.output + ready.output).toContain("ready");
    expect((await tool("process_session").execute({ action: "write", session_id: initial.session_id, chars: "hello" }, managed())).isError).toBeUndefined();
    const terminal = await waitForProcessRead("command-owner", initial.session_id, ready.next_cursor,
      (value) => value.status === "exited");
    expect(terminal.payload.output).toBe("reply:hello");
    expect(terminal.result.observations?.execution?.status).toBe("succeeded");
    expect(await fs.readFile(path.join(workingDir, "effects"), "utf8")).toBe("1");
    expect((await read(initial.session_id, terminal.payload.next_cursor)).observations).toBeUndefined();
  });

  it("keeps programmatic and non-model callers terminal-returning even with an explicit zero wait", async () => {
    for (const ctx of [context("script"), { ...managed(), state: markProgrammaticToolCallState(managed().state) }]) {
      const result = await bashTool.execute({ command: node("setTimeout(()=>console.log('finished'),50)"), yield_time_ms: 0 }, ctx);
      expect(result.content).toContain('<command-result status="succeeded"');
      expect(result.content).toContain("finished");
    }
  });

  it("reports nonzero exit and stderr after yielding, without confusing command completion with success", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let processing = false;
    const ctx = managed();
    ctx.state.commandSessionTerminal = async (result: any) => { processing = true; await barrier; return result; };
    const initial = json((await bashTool.execute({ command: node("setTimeout(()=>{console.error('failed');process.exit(7)},100)"), yield_time_ms: 0 }, ctx)).content);
    try {
      await expect.poll(() => processing).toBe(true);
      // The OS command has failed, but its host result is not delivered yet.
      const stopping = tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
      release();
      const terminal = await stopping;
      expect(json(terminal.content)).toMatchObject({ status: "error", execution_status: "failed", exit_code: 7 });
      expect(json(terminal.content).output).toContain("failed");
      expect(terminal.isError).toBe(true);
      expect(terminal.observations?.execution).toMatchObject({ status: "failed", exitCode: 7 });
      const repeated = await tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
      expect(repeated.isError).toBe(true);
      expect(repeated.observations).toBeUndefined();
    } finally { release(); }
  });

  it("expires the original total deadline without polling or the legacy one-minute clamp", async () => {
    const initial = json((await bashTool.execute({ command: node("setInterval(()=>{},1000)"), timeoutMs: 100, yield_time_ms: 0 }, managed())).content);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await read(initial.session_id);
    expect(json(result.content).status).toBe("stopped");
    expect(result.isError).toBe(true);
    expect(result.observations?.execution).toMatchObject({ status: "timed_out", timedOut: true });
    const stopped = await tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    expect(stopped.isError).toBe(true);
    expect(json(stopped.content).execution_status).toBe("timed_out");
    expect(stopped.observations).toBeUndefined();
  });

  it.each(["run", "call"])("cancels the original %s after yield but aborting an independent read only ends that wait", async source => {
    const run = new AbortController();
    const ctx = managed("command-owner", run.signal);
    if (source === "run") ctx.signal = undefined;
    else ctx.state.commandSessionSignal = undefined;
    const initial = json((await bashTool.execute({ command: node("setInterval(()=>{},1000)"), yield_time_ms: 0 }, ctx)).content);
    const waiting = new AbortController();
    const resultPromise = read(initial.session_id, 0, managed("command-owner", waiting.signal), 30000);
    waiting.abort();
    expect(json((await resultPromise).content).status).toBe("running");
    run.abort();
    const result = await read(initial.session_id);
    expect(result.isError).toBe(true);
    expect(result.observations?.execution?.status).toBe("aborted");
    const stopped = await tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    expect(stopped.isError).toBe(true);
    expect(json(stopped.content).execution_status).toBe("aborted");
  });

  it.each(["run", "call"])("preserves %s cancellation overlapping an explicit stop before process close", async source => {
    const run = new AbortController();
    const ctx = managed("command-owner", run.signal);
    if (source === "run") ctx.signal = undefined;
    else ctx.state.commandSessionSignal = undefined;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
      pid: process.platform === "win32" ? 1234 : undefined,
      exitCode: null as number | null, signalCode: null,
    });
    vi.mocked(spawn).mockImplementationOnce((() => child) as typeof spawn);
    const killer = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), unref: vi.fn() });
    if (process.platform === "win32") vi.mocked(spawn).mockImplementationOnce((() => killer) as typeof spawn);
    const initial = json((await bashTool.execute({ command: "fixture-running", yield_time_ms: 0 }, ctx)).content);
    const stopping = tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    if (process.platform === "win32") killer.stdout.emit("data", Buffer.from("ready\n"));
    run.abort();
    child.exitCode = process.platform === "win32" ? 4294967295 : null;
    child.stdout.end(); child.stderr.end(); child.emit("close", child.exitCode);
    if (process.platform === "win32") {
      killer.stdout.emit("data", Buffer.from("root-terminated\n"));
      killer.emit("exit", 0); killer.emit("close", 0);
    }
    const stopped = await stopping;
    expect(stopped.isError).toBe(true);
    expect(json(stopped.content)).toMatchObject({ status: "stopped", execution_status: "aborted" });
    expect(stopped.observations?.execution?.status).toBe("aborted");
    // Original cancellation wins even with trusted helper termination evidence.
  });

  it.each([7, 4294967295])("keeps exit %s observed before close erroneous when stop arrives while pipes are still open", async (exitCode) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null as number | null,
    });
    vi.mocked(spawn).mockImplementationOnce((() => child) as typeof spawn);
    const initial = json((await bashTool.execute({ command: "fixture-running", yield_time_ms: 0 }, managed())).content);
    // The exit event can precede close when inherited output pipes stay open.
    child.exitCode = exitCode;
    const stopping = tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    child.stdout.end(); child.stderr.end(); child.emit("close", exitCode);
    const result = await stopping;
    expect(result.isError).toBe(true);
    expect(json(result.content).exit_code).toBe(exitCode);
    expect(result.observations?.execution?.exitCode).toBe(exitCode);
  });

  it("rejects foreign reads, writes and stops while the owner's process stays usable", async () => {
    const initial = json((await bashTool.execute({ command: node("setInterval(()=>{},1000)"), yield_time_ms: 0 }, managed())).content);
    for (const action of ["read", "write", "stop"]) {
      const result = await tool("process_session").execute({ action, session_id: initial.session_id, ...(action === "write" ? { chars: "hello" } : {}) }, managed("foreign"));
      expect(result.content).toContain("E_PROCESS_SESSION_NOT_FOUND");
      expect(result.isError).toBe(true);
    }
    expect((await tool("process_session").execute({ action: "stop", session_id: "missing" }, managed())).isError).toBe(true);
    expect(json((await read(initial.session_id, 0, managed(), 0)).content).status).toBe("running");
    const stopped = await tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    expect(json(stopped.content).status).toBe("stopped");
  });

  it.each(["exit", "stop"])("delivers terminal observations exactly once during concurrent %s receipts and retains full spooled output", async ending => {
    let completions = 0;
    const ctx = managed();
    ctx.state.commandSessionTerminal = async (result: any) => { completions++; return result; };
    const script = "process.stdout.write('A'.repeat(1200000));process.stderr.write('stderr-tail')"
      + (ending === "stop" ? ";setInterval(()=>{},1000)" : "");
    const initial = json((await bashTool.execute({ command: node(script), yield_time_ms: 0 }, ctx)).content);
    if (ending === "stop") {
      await waitForProcessRead("command-owner", initial.session_id, 0, value => value.output_end >= 1200011);
    } else await expect.poll(() => completions).toBe(1);
    const receive = () => ending === "stop"
      ? tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed())
      : read(initial.session_id);
    const results = await Promise.all([receive(), receive()]);
    for (const result of results) {
      expect(result.isError).toBeFalsy();
      expect(json(result.content).execution_status).toBe(ending === "stop" ? "aborted" : "succeeded");
    }
    expect(results.filter((r) => r.observations?.execution)).toHaveLength(1);
    const delivered = results.find((r) => r.streamedOutput)!;
    expect(delivered).toBeDefined();
    const full = await fs.readFile(delivered.streamedOutput!.path, "utf8");
    expect(full).toContain("A".repeat(1200000));
    expect(full).toContain("stderr-tail");
    // Reads request cursor zero; stop has no cursor and returns the retained range.
    expect(json(delivered.content).truncated_before_cursor).toBe(ending === "exit");
    expect(json(delivered.content).output_start).toBe(200011);
    expect(json(delivered.content).output.length).toBe(32000);
    expect(json(delivered.content).next_cursor).toBe(232011);
    expect(completions).toBe(1);
    const repeated = await receive();
    expect(repeated.isError).toBeFalsy();
    expect(repeated.observations).toBeUndefined();
    expect(repeated.streamedOutput).toBeUndefined();
    if (ending === "stop") expect((await read(initial.session_id)).isError).toBe(true);
  });

  // Completed records are capped at 32. A record whose terminal result was
  // already delivered goes first; its full output was handed off once.
  it("evicts delivered records before a terminal result nobody has read", async () => {
    let completions = 0;
    const ctx = managed();
    ctx.state.commandSessionTerminal = async (result: any) => { completions++; return result; };
    const unread = json((await bashTool.execute({ command: node("console.log('unread-result')"), yield_time_ms: 0 }, ctx)).content);
    await expect.poll(() => completions).toBe(1);
    for (let i = 0; i < 32; i++) {
      const started = json((await bashTool.execute({ command: node(`console.log('done-${i}')`), yield_time_ms: 0 }, ctx)).content);
      await waitForProcessRead("command-owner", started.session_id, 0, (value) => value.status === "exited");
    }
    await expect.poll(() => completions).toBe(33);
    const result = await read(unread.session_id);
    expect(json(result.content).status).toBe("exited");
    expect(json(result.content).output).toContain("unread-result");
    expect(result.observations?.execution?.exitCode).toBe(0);
  }, 60_000);

  it.runIf(process.platform !== "win32")("stops a process tree whose child ignores TERM without leaving a producer alive", async () => {
    const initial = json((await bashTool.execute({ command: node("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>require('fs').appendFileSync('ticks','x'),30)"), yield_time_ms: 0 }, managed())).content);
    const ready = await read(initial.session_id);
    expect(initial.output + json(ready.content).output).toContain("ready");
    const stopped = await tool("process_session").execute({ action: "stop", session_id: initial.session_id }, managed());
    expect(json(stopped.content).status).toBe("stopped");
    expect(stopped.isError).toBeFalsy();
    const before = await fs.readFile(path.join(workingDir, "ticks"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await fs.readFile(path.join(workingDir, "ticks"), "utf8")).toBe(before);
  }, 10000);

  it.each([-1, 30001, 60000])("runs a command once with the default wait for out-of-range yield %s", async (yield_time_ms) => {
    const result = await bashTool.execute({
      command: node("require('fs').appendFileSync('effects','1');console.log('finished')"), yield_time_ms,
    }, managed());
    expect(result.isError).toBeFalsy();
    expect(result.observations?.execution).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(result.content).toContain("finished");
    expect(await fs.readFile(path.join(workingDir, "effects"), "utf8")).toBe("1");
  });

  it.each([1.5, "10", null, NaN, Infinity])("rejects malformed yield %s before command side effects", async (yield_time_ms) => {
    const result = await bashTool.execute({ command: node("require('fs').writeFileSync('forbidden','x')"), yield_time_ms }, managed());
    expect(result.isError).toBe(true);
    await expect(fs.stat(path.join(workingDir, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute a pre-cancelled command", async () => {
    const run = new AbortController(); run.abort();
    const result = await bashTool.execute({ command: node("require('fs').writeFileSync('forbidden','x')") }, managed("command-owner", run.signal));
    // The initial wait may return immediately on cancellation. Either receipt
    // must lead to an aborted terminal outcome without a command side effect.
    if (result.content.startsWith("{")) {
      const terminal = await read(json(result.content).session_id);
      expect(terminal.observations?.execution?.status).toBe("aborted");
    } else expect(result.observations?.execution?.status).toBe("aborted");
    await expect(fs.stat(path.join(workingDir, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
