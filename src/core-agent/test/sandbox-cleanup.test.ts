import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree, SandboxExecutor } from "../src/sandbox/executor.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function childFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 1234, exitCode: null as number | null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });

describe("bounded shell cleanup", () => {
  it.runIf(process.platform !== "win32").each(["timeout", "cancel", "output-limit"])(
    "releases owned pipes after incomplete %s cleanup while retaining the warning and captured output",
    async (trigger) => {
      vi.useFakeTimers();
      const child = childFixture();
      vi.mocked(spawn).mockReturnValue(child as any);
      vi.spyOn(process, "kill").mockReturnValue(true);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const abort = new AbortController();
      const execution = new SandboxExecutor({
        workingDir: process.cwd(), timeoutMs: trigger === "timeout" ? 100 : 10_000,
        maxOutputBytes: 4, signal: abort.signal,
      }).execute("fixture");
      child.stdout.emit("data", Buffer.from(trigger === "output-limit" ? "hello" : "ok"));
      child.stderr.emit("data", Buffer.from("err"));
      if (trigger === "cancel") abort.abort();
      if (trigger === "timeout") await vi.advanceTimersByTimeAsync(100);
      child.exitCode = 1; // Root exited; an escaped descendant retains its output pipes.
      await vi.advanceTimersByTimeAsync(5_999);
      expect(child.stdout.destroyed).toBe(false);
      expect(child.stderr.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await execution;
      expect(result).toMatchObject({
        timedOut: trigger === "timeout", outputLimitExceeded: trigger === "output-limit",
      });
      if (trigger === "cancel") expect(result.aborted).toBe(true);
      expect(result.stdout).toContain(trigger === "output-limit" ? "hell" : "ok");
      if (trigger !== "output-limit") expect(result.stderr).toBe("err");
      expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
      expect(warning).toHaveBeenCalledExactlyOnceWith("[sandbox]", "Shell process cleanup was not confirmed", {
        platform: process.platform, phase: "cleanup_deadline",
        root_exit_observed: true, stdout_open: true, stderr_open: true,
      });
      // Closing host pipes later must not turn the incomplete timeout into success.
      child.emit("close", 0);
      expect(result.exitCode).toBeNull();
    },
  );
});

describe("Windows shell cleanup", () => {
  it("attributes termination only after the authorized helper output and successful close", () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const onComplete = vi.fn();
    const onRootTerminated = vi.fn();
    killProcessTree(child as any, "SIGTERM", { platform: "win32", onComplete, onRootTerminated });
    killer.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
    child.exitCode = 4294967295;
    killer.emit("exit", 0);
    // A helper's exit can precede its final pipe data. Do not finish early.
    expect(onComplete).not.toHaveBeenCalled();
    killer.stdout.emit("data", Buffer.from("done:0:1\n"));
    killer.emit("close", 0);
    expect(onRootTerminated).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["natural-exit", "unauthorized", "malformed", "failed-cleanup"])(
    "does not attribute an unproved root termination: %s", (outcome) => {
      const child = childFixture();
      const killer = childFixture();
      vi.mocked(spawn).mockReturnValue(killer as any);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onRootTerminated = vi.fn();
      killProcessTree(child as any, "SIGTERM", { platform: "win32", onRootTerminated });
      if (outcome === "unauthorized") child.exitCode = 7;
      killer.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
      child.exitCode = 7;
      if (outcome === "natural-exit") killer.stdout.emit("data", Buffer.from("done:0:0\n"));
      if (outcome !== "natural-exit") killer.stdout.emit("data", Buffer.from(
        "done:0:1\n" + (outcome === "malformed" ? "unexpected\n" : ""),
      ));
      const code = outcome === "failed-cleanup" ? 1 : 0;
      killer.emit("exit", code);
      killer.emit("close", code);
      expect(onRootTerminated).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(outcome === "failed-cleanup" || outcome === "malformed" ? 1 : 0);
    },
  );

  it.runIf(process.platform === "win32")("retains root termination evidence when command close precedes helper output", async () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValueOnce(child as any).mockReturnValueOnce(killer as any);
    let control!: { stop(): void };
    const done = vi.fn();
    const execution = new SandboxExecutor({ workingDir: process.cwd(), timeoutMs: 10_000 })
      .execute("fixture", { onStart: (next) => { control = next; }, onOutput: () => {} })
      .then((result) => { done(); return result; });
    control.stop();
    killer.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
    child.exitCode = 4294967295;
    child.emit("close", child.exitCode);
    killer.emit("exit", 0);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    killer.stdout.emit("data", Buffer.from("done:0:1\n"));
    killer.emit("close", 0);
    await expect(execution).resolves.toMatchObject({ aborted: true, exitCode: 4294967295,
      rootTerminationConfirmed: true, timedOut: false, outputLimitExceeded: false });
  });

  it("accepts natural exit before the helper acquires a handle without a false fallback warning", () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();
    killProcessTree(child as any, "SIGKILL", { platform: "win32", onComplete });
    child.exitCode = 0;
    killer.emit("exit", 1);
    killer.emit("close", 1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([false, true])("authorizes only the pinned original child (exited while helper starts: %s)", (exited) => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const input = vi.spyOn(killer.stdin, "write");
    killProcessTree(child as any, "SIGKILL", { platform: "win32" });
    if (exited) child.exitCode = 0;
    killer.stdout.emit("data", Buffer.from("accepting\n"));
    input.mockClear();
    killer.stdout.emit("data", Buffer.from("rea"));
    expect(input).not.toHaveBeenCalled();
    killer.stdout.emit("data", Buffer.from("dy:0\r\n"));
    expect(input).toHaveBeenCalledExactlyOnceWith(exited ? "cancel:0\n" : "go:0\n");
    killer.stdout.emit("data", Buffer.from(exited ? "done:0:0\n" : "done:0:1\n"));
    killer.emit("close", 0);
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("does not target a recycled PID after the owned shell has exited", () => {
    const child = childFixture();
    child.exitCode = 1;
    killProcessTree(child as any, "SIGKILL", { platform: "win32" });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds a failed tree command and reports its direct-child-only fallback once", () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();
    killProcessTree(child as any, "SIGTERM", { platform: "win32", onComplete });
    expect(onComplete).not.toHaveBeenCalled();
    killer.emit("error", new Error("private path must not be logged"));
    killer.emit("exit", 1);
    killer.emit("close", 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("[sandbox]", "Shell process tree termination failed", {
      platform: "win32", fallback: "direct_child_only",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private path");
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ windowsHide: true }));
  });

  it.runIf(process.platform === "win32")("waits for tree cleanup after shell close before returning the timeout result", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValueOnce(child as any).mockReturnValueOnce(killer as any);
    const done = vi.fn();
    const execution = new SandboxExecutor({ workingDir: process.cwd(), timeoutMs: 100 })
      .execute("fixture").then((result) => { done(); return result; });
    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 1;
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    killer.emit("exit", 0);
    killer.emit("close", 0);
    await expect(execution).resolves.toMatchObject({ timedOut: true, exitCode: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform === "win32")("reports unconfirmed cleanup without hanging or treating helper success as pipe closure", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValueOnce(child as any).mockReturnValueOnce(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execution = new SandboxExecutor({ workingDir: process.cwd(), timeoutMs: 100 }).execute("fixture");
    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 1; // A surviving descendant still owns an inherited output pipe.
    killer.emit("exit", 0);
    killer.emit("close", 0);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(execution).resolves.toMatchObject({ timedOut: true });
    expect(warning).toHaveBeenCalledWith("[sandbox]", "Shell process cleanup was not confirmed", {
      platform: "win32", phase: "cleanup_deadline",
      root_exit_observed: true, stdout_open: true, stderr_open: true,
    });
    expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
